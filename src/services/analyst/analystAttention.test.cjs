const test = require('node:test');
const assert = require('node:assert/strict');
const { createAttentionWorkflow } = require('./analystAttention.cjs');

function fixture(overrides = {}) {
  let current = new Date('2026-09-22T16:00:00Z');
  const settings = new Map([['pm-attention-v1', { enabled: true }]]);
  const publications = [];
  const subject = createAttentionWorkflow({
    now: () => current,
    call: async (operation, body) => {
      if (operation === 'setting') {
        if (Object.hasOwn(body, 'value')) settings.set(body.key, body.value);
        return { value: settings.get(body.key) };
      }
      assert.equal(operation, 'attention-publish');
      publications.push(body);
      return { count: body.findings.length, cleared: body.reset ? 13 : 0 };
    },
    request: async () => ({ complete: true }),
    collectOperations: async () => ({ findings: [], complete: true }),
    evaluateResearch: () => ({ findings: [], complete: true }),
    loadStanceHistory: async () => ({ from: '2026-06-25', through: '2026-09-22', events: [] }),
    loadSecurities: async () => ({}),
    ...overrides,
  });
  return { subject, publications, settings, advance: () => { current = new Date(current.getTime() + 31_000); } };
}

test('explicit reset publishes atomically and never touches conversations or research', async () => {
  const f = fixture();
  const result = await f.subject.start({ reset: true });
  assert.equal(result.state, 'completed');
  assert.equal(result.cleared, 13);
  assert.equal(f.publications.length, 1);
  assert.deepEqual(f.publications[0].completeKinds, ['operational', 'portfolio', 'opportunity', 'market', 'account']);
});

test('a failed research channel does not prevent an independent operational assessment', async () => {
  const issue = { id: 'gateway', kind: 'operational' };
  const f = fixture({ request: async () => { throw new Error('offline'); }, collectOperations: async () => ({ findings: [issue], complete: true }) });
  await f.subject.start();
  assert.equal(f.publications[0].findings[0], issue);
  assert.equal(f.publications[0].findings[1].id, 'attention:assessment:research');
  assert.deepEqual(f.publications[0].completeKinds, ['operational']);
});

test('unavailable operational evidence cannot resolve old operational conditions', async () => {
  const f = fixture({ collectOperations: async () => { throw new Error('timeout'); } });
  await f.subject.start();
  assert.equal(f.publications[0].findings[0].id, 'attention:assessment:operations');
  assert.ok(!f.publications[0].completeKinds.includes('operational'));
});

test('worker throttles acquisitions and shares concurrent runs', async () => {
  let release;
  const f = fixture({ request: () => new Promise(resolve => { release = resolve; }) });
  const first = f.subject.start();
  assert.equal(f.subject.start(), first);
  await new Promise(resolve => setImmediate(resolve));
  release({ complete: true });
  await first;
  assert.equal(await f.subject.tick(), null);
  f.advance();
  const next = f.subject.tick();
  await new Promise(resolve => setImmediate(resolve));
  release({ complete: true });
  await next;
  assert.equal(f.publications.length, 2);
});

test('read-only partial results cannot imply all checks passed', async () => {
  const f = fixture({ evaluateResearch: () => ({ findings: [], complete: false, completeKinds: ['opportunity'], diagnostics: ['holdings unavailable'] }) });
  const result = await f.subject.start();
  assert.deepEqual(result.completeKinds, ['operational', 'opportunity']);
  assert.deepEqual(result.diagnostics, ['holdings unavailable']);
  assert.equal(f.publications[0].findings[0].id, 'attention:assessment:research');
  assert.deepEqual(f.publications[0].completeAssessments, ['operations']);
});

test('a reset requested during a background run queues one fresh reset', async () => {
  let release;
  const f = fixture({ request: () => new Promise(resolve => { release = resolve; }) });
  const first = f.subject.start();
  const reset = f.subject.start({ reset: true });
  assert.equal(f.subject.start({ reset: true }), reset);
  await new Promise(resolve => setImmediate(resolve));
  release({});
  await first;
  await new Promise(resolve => setImmediate(resolve));
  release({});
  await reset;
  assert.deepEqual(f.publications.map(value => value.reset), [false, true]);
});

test('the enabled switch is read once and re-read only after a write or its cache window', async () => {
  let current = new Date('2026-09-22T16:00:00Z');
  const settings = new Map([['pm-attention-v1', { enabled: false }]]);
  const reads = [];
  const subject = createAttentionWorkflow({
    now: () => current,
    call: async (operation, body) => {
      if (operation === 'setting') {
        if (Object.hasOwn(body, 'value')) settings.set(body.key, body.value);
        else if (body.key === 'pm-attention-v1') reads.push(body.key);
        return { value: settings.get(body.key) };
      }
      settings.set('pm-attention-v1', { enabled: true });
      return { count: body.findings.length, cleared: 0 };
    },
    request: async () => ({ complete: true }),
    collectOperations: async () => ({ findings: [], complete: true }),
    evaluateResearch: () => ({ findings: [], complete: true }),
  });
  assert.deepEqual(await Promise.all([subject.enabled(), subject.enabled()]), [false, false]);
  assert.equal(await subject.tick(), null);
  assert.equal(reads.length, 1, 'concurrent and repeated checks share one read');
  await subject.start();
  assert.equal(await subject.enabled(), true, 'publishing attention invalidates the cached switch');
  assert.equal(reads.length, 2);
  current = new Date(current.getTime() + 59_000);
  await subject.enabled();
  assert.equal(reads.length, 2);
  current = new Date(current.getTime() + 2_000);
  await subject.enabled();
  assert.equal(reads.length, 3, 'an external write is observed after the cache window');
});

test('a failed switch read is not cached', async () => {
  let fail = true;
  const f = fixture({ call: async (operation, body) => {
    if (fail) { fail = false; throw new Error('Sidecar unavailable'); }
    return { value: operation === 'setting' && body.key === 'pm-attention-v1' ? { enabled: true } : null };
  } });
  await assert.rejects(f.subject.enabled(), /Sidecar unavailable/);
  assert.equal(await f.subject.enabled(), true);
});

test('an acquiring review defers at most two scan cycles before the scan runs', async () => {
  const f = fixture();
  await f.subject.start();
  assert.equal(f.publications.length, 1);
  for (const cycle of [1, 2]) {
    f.advance();
    assert.equal(await f.subject.tick([], { defer: true }), null, `cycle ${cycle} deferred`);
    assert.equal(await f.subject.tick([], { defer: true }), null, 'a deferral consumes the whole cycle');
  }
  assert.equal(f.publications.length, 1);
  f.advance();
  await f.subject.tick([], { defer: true });
  assert.equal(f.publications.length, 2, 'the third consecutive cycle runs despite the review');
  f.advance();
  assert.equal(await f.subject.tick([], { defer: true }), null, 'a completed scan restarts the deferral budget');
  f.advance();
  await f.subject.tick();
  assert.equal(f.publications.length, 3);
});

test('the stance book folds the journal, backfills its history once, and saves only on change', async () => {
  const removal = { entityId: 'GIII', entityType: 'ticker', productKey: 'signal-strength', eventType: 'signal_strength_short_removed', fieldPath: 'data.shorts.removed[0]',
    excerpt: 'GIII', marketDate: '2026-09-01', publishedAt: '2026-09-01T00:00:00+00:00', qualityStatus: 'validated', sourceUrl: 'https://app.hedgeye.com/feed_items/1' };
  let loads = 0;
  let seen;
  const f = fixture({
    loadStanceHistory: async () => { loads += 1; return { from: '2026-06-25', through: '2026-09-22', events: [removal] }; },
    evaluateResearch: context => { seen = context.stanceBook; return { findings: [], complete: true }; },
  });
  let writes = 0;
  const call = f.settings.set.bind(f.settings);
  f.settings.set = (key, value) => { if (key === 'stance-book-v1') writes += 1; return call(key, value); };
  await f.subject.start();
  assert.equal(seen.tickers.GIII['signal-strength:short'].stance, 'EXIT_SHORT');
  assert.equal(seen.backfill.from, '2026-06-25');
  f.advance();
  await f.subject.start();
  assert.equal(loads, 1); assert.equal(writes, 1);
});

test('held securities are named from the security record and the scored stance book keeps the source-enriched SOME', async () => {
  const sell = { entityId: 'MPC', entityType: 'ticker', productKey: 'real-time-alert', eventType: 'position_change', fieldPath: 'data.alert',
    excerpt: JSON.stringify({ ticker: 'MPC', action: 'SELL', headline: 'SELL SIGNAL MPC' }), marketDate: '2026-09-22', publishedAt: '2026-09-22T14:00:00+00:00',
    qualityStatus: 'validated', sourceUrl: 'https://app.hedgeye.com/feed_items/9', sourceMessageId: 'msg-mpc' };
  const enriched = { ...sell, sourceReport: { sourceMessageId: 'msg-mpc', title: 'Real-Time Alert: Sell-SOME Signal: Marathon Petroleum (MPC) -KM', bodyText: '' } };
  const positions = [{ symbol: 'MPC', quantity: 10 }, { symbol: 'BRK B', quantity: 2 }, { symbol: 'KXFED-26', quantity: 3, category: 'event_contract' },
    { symbol: 'IGV', quantity: 0 }, { symbol: 'AAPL 261218C00200000', quantity: 1 }];
  let requested;
  let seen;
  const f = fixture({
    request: async () => ({ complete: true, holdings: { positions }, events: [enriched] }),
    loadSecurities: async symbols => { requested = symbols; return { MPC: { identity: { status: 'available' } } }; },
    evaluateResearch: context => { seen = context; return { findings: [], complete: true }; },
  });
  await f.subject.start();
  assert.deepEqual(requested, ['MPC', 'BRK.B']);
  assert.deepEqual(Object.keys(seen.securities), ['MPC']);
  const scored = f.subject.scoredStanceBook();
  assert.equal(scored.scoredAt, '2026-09-22T16:00:00.000Z');
  assert.equal(scored.book.tickers.MPC['real-time-alert'].action, 'SELL-SOME');
  assert.equal(seen.stanceBook, scored.book, 'the evaluation scores the same book the record reads');
});

test('a failed security record read leaves the scan running without names', async () => {
  let seen;
  const f = fixture({
    request: async () => ({ complete: true, holdings: { positions: [{ symbol: 'DRAM', quantity: 5 }] } }),
    loadSecurities: async () => { throw new Error('record offline'); },
    evaluateResearch: context => { seen = context; return { findings: [], complete: true }; },
  });
  const status = await f.subject.start();
  assert.equal(status.state, 'completed');
  assert.deepEqual(seen.securities, {});
});

test('the default record read asks for identity only, in batches the route accepts, with a short timeout', async () => {
  const reads = [];
  const positions = Array.from({ length: 62 }, (_, index) => ({ symbol: `T${index}`, quantity: 1 }));
  let seen;
  const f = fixture({
    loadSecurities: undefined,
    fetchJson: async (path, options) => {
      reads.push({ path, options });
      if (path.startsWith('/api/security-universe')) {
        const symbols = decodeURIComponent(path.split('symbols=')[1]).split(',');
        if (symbols.includes('T60')) throw new Error('timeout');
        return { rows: Object.fromEntries(symbols.map(symbol => [symbol, { symbol }])) };
      }
      return {};
    },
    request: async () => ({ complete: true, holdings: { positions } }),
    evaluateResearch: context => { seen = context; return { findings: [], complete: true }; },
  });
  await f.subject.start();
  const recordReads = reads.filter(read => read.path.startsWith('/api/security-universe'));
  assert.equal(recordReads.length, 2);
  assert.ok(recordReads.every(read => read.path.includes('fields=identity') && read.options.timeoutMs === 8000));
  assert.equal(decodeURIComponent(recordReads[0].path.split('symbols=')[1]).split(',').length, 50);
  assert.equal(Object.keys(seen.securities).length, 50, 'a failed batch leaves only its own tickers unnamed');
});

test('holdings freshness is judged when the context arrives, and an unreadable book is not published as current', async () => {
  let seenAt;
  const f = fixture({
    request: async () => ({ complete: true, holdings: { positions: [{ symbol: 'XLE', quantity: 5 }] } }),
    loadSecurities: async () => { f.advance(); return {}; },
    evaluateResearch: (context, at) => { seenAt = at; return { findings: [], complete: true }; },
  });
  const started = new Date('2026-09-22T16:00:00Z');
  await f.subject.start();
  assert.equal(seenAt.toISOString(), started.toISOString(), 'the name read does not age the holdings book');

  const failing = fixture({ request: async () => ({ complete: true, holdings: { positions: [] } }) });
  const read = failing.settings.get.bind(failing.settings);
  failing.settings.get = key => { if (key === 'stance-book-v1') throw new Error('workspace offline'); return read(key); };
  await failing.subject.start();
  assert.deepEqual([failing.subject.scoredStanceBook().book, failing.subject.scoredStanceBook().reason], [null, 'stance-book-unreadable']);
});
