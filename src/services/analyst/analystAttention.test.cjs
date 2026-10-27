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
