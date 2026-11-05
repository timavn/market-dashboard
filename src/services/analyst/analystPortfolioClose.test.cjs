const test = require('node:test');
const assert = require('node:assert/strict');
const { createPortfolioCloseReview } = require('./analystPortfolioClose.cjs');

function fixture({ date = '2026-09-17T20:30:00Z', recordStartedAt, startFails = false } = {}) {
  let observed = new Date(date);
  let starts = 0;
  let requestFails = false;
  let run;
  const settings = new Map();
  const operations = [];
  const startBodies = [];
  const workspace = {
    initialize: async () => {},
    call: async (operation, args) => {
      operations.push(operation);
      assert.equal(operation, 'setting');
      if ('value' in args) settings.set(args.key, args.value);
      return { value: settings.get(args.key) };
    },
  };
  const request = async (path, options = {}) => {
    if (path === '/internal/reviews' && options.method === 'POST') {
      starts += 1;
      startBodies.push(options.body);
      if (startFails) throw new Error('Unavailable upstream');
      // A run without a workspace owner is filed under the review shell id.
      run = { runId: `run-${starts}`, conversationId: 'review:portfolio-review', reviewKind: options.body.reviewKind,
        state: 'running', createdAt: recordStartedAt || observed.toISOString() };
      return { ok: true, ...run };
    }
    assert.equal(path, `/internal/reviews/${run.runId}`);
    if (requestFails) throw new Error('Sidecar unavailable');
    return { run };
  };
  const make = () => createPortfolioCloseReview({ workspace, request, now: () => new Date(observed) });
  const complete = (outcome = 'partial') => {
    Object.assign(run, { state: 'succeeded', outcome, completedAt: observed.toISOString(),
      reportMarkdown: '# Portfolio Review\n\nVerified holdings captured after the session close.',
      dependencies: { portfolio: { status: 'ready', asOf: observed.toISOString(), detail: { liveVerified: true, providerStatus: 'available' } } } });
  };
  return { service: make(), make, get run() { return run; }, settings, complete, operations, startBodies,
    starts: () => starts, advance: milliseconds => { observed = new Date(observed.getTime() + milliseconds); },
    setRequestFails: value => { requestFails = value; } };
}

test('starts at 16:30 ET, forces fresh acquisition, and deduplicates concurrent and repeated calls', async () => {
  const f = fixture();
  assert.equal((await f.service.status()).status, 'pending');
  const results = await Promise.all([f.service.start(), f.service.start()]);
  assert.ok(results.every(result => result.status === 'running'));
  assert.equal(f.starts(), 1);
  assert.equal((await f.service.start()).status, 'running');
  f.complete();
  const result = await f.service.start();
  assert.equal(result.status, 'ready');
  assert.equal(result.scheduledTime, '16:30');
  assert.equal(result.timeZone, 'America/New_York');
  assert.equal(result.asOf, '2026-09-17T20:30:00.000Z');
  assert.equal(result.capturedAt, result.asOf);
  assert.equal(f.starts(), 1);
  assert.equal((await f.make().start()).status, 'ready');
  assert.equal(f.starts(), 1);
  assert.ok(f.settings.has('hermes-portfolio-close:2026-09-17'));
});

test('before the close-plus-30-minute window and after the next pre-market open no review is acquired', async () => {
  for (const date of ['2026-09-17T19:59:00Z', '2026-09-17T20:00:00Z', '2026-09-17T20:29:59Z', '2026-09-18T08:00:00Z']) {
    const f = fixture({ date });
    assert.equal((await f.service.start()).status, 'scheduled');
    assert.equal(f.starts(), 0);
  }
});

test('holdings are frozen until the next 4:00am ET open, so a missed close is captured over a weekend or holiday', async () => {
  for (const [date, session] of [
    ['2026-09-19T20:30:00Z', '2026-09-18'], ['2026-09-07T20:30:00Z', '2026-09-04'], ['2026-09-21T07:59:00Z', '2026-09-18'],
  ]) {
    const f = fixture({ date });
    const result = await f.service.start();
    assert.equal(result.status, 'running');
    assert.equal(result.date, session);
    assert.equal(f.starts(), 1);
    f.complete();
    assert.equal((await f.service.status()).status, 'ready');
    assert.ok(f.settings.has(`hermes-portfolio-close:${session}`));
  }
});

test('a failed Friday capture retried on Saturday becomes Monday\'s verified baseline', async () => {
  const f = fixture({ date: '2026-10-16T20:30:00Z' });
  await f.service.start();
  Object.assign(f.run, { state: 'failed' });
  assert.equal((await f.service.status()).reason, 'review_failed');
  f.advance(17 * 60 * 60_000);
  const retried = await f.service.start();
  assert.equal(retried.date, '2026-10-16');
  assert.equal(f.starts(), 2);
  f.complete();
  f.advance(2 * 24 * 60 * 60_000);
  const baseline = await f.make().baseline();
  assert.equal(baseline.sessionDate, '2026-10-16');
  assert.equal(baseline.status, 'ready');
  assert.equal(baseline.capturedAt, '2026-10-17T13:30:00.000Z');
});

test('early-close sessions capture at 13:30 ET and normal winter sessions at 16:30 ET', async () => {
  const early = fixture({ date: '2026-11-27T18:29:59Z' });
  assert.equal((await early.service.start()).reason, 'before_capture_time');
  early.advance(1000);
  assert.equal((await early.service.start()).status, 'running');
  early.complete();
  assert.equal((await early.service.status()).scheduledTime, '13:30');
  assert.equal((await early.service.status()).status, 'ready');
  const winter = fixture({ date: '2026-12-01T21:30:00Z' });
  await winter.service.start(); winter.complete();
  assert.equal((await winter.service.status()).status, 'ready');
});

test('the close capture is a headless run that never creates, reopens or reads an Analyst conversation', async () => {
  const f = fixture(); await f.service.start(); f.complete();
  assert.equal((await f.service.status()).status, 'ready');
  assert.deepEqual(f.startBodies, [{ reviewKind: 'portfolio-review', requestId: 'portfolio-close:2026-09-17:2026-09-17T20:30:00.000Z' }]);
  assert.ok(f.operations.every(operation => operation === 'setting'));
  const saved = f.settings.get('hermes-portfolio-close:2026-09-17');
  assert.equal(saved.runId, 'run-1');
  assert.equal(saved.conversationId, undefined);
  // A narrative-free run is still a verified baseline; no report publication is awaited.
  f.run.reportMarkdown = '';
  assert.equal((await f.service.status()).status, 'ready');
});

test('historical fallback never satisfies the close capture and retries at most once every 10 minutes', async () => {
  const f = fixture(); await f.service.start(); f.complete();
  f.run.dependencies.portfolio = { status: 'failed', asOf: '2026-09-17T20:30:01Z', detail: { liveVerified: false, providerStatus: 'unavailable' } };
  f.run.dependencies.portfolioReference = { status: 'ready', asOf: '2026-09-17T16:06:33Z', detail: { verifiedAtCapture: true } };
  assert.equal((await f.service.status()).reason, 'historical_holdings_only');
  const blocked = await f.service.start();
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.retryAt, '2026-09-17T20:40:00.000Z');
  f.advance(300_000);
  await f.make().start();
  assert.equal(f.starts(), 1);
  f.advance(299_999);
  await f.make().start();
  assert.equal(f.starts(), 1);
  f.advance(1);
  assert.equal((await f.make().start()).status, 'running');
  assert.equal(f.starts(), 2);
  // A retry needs its own request identity; the store dedupes repeated requests.
  assert.notEqual(f.startBodies[0].requestId, f.startBodies[1].requestId);
  f.complete();
  assert.equal((await f.service.status()).status, 'ready');
});

test('failed starts and an active old daily run are throttled without adopting pre-close holdings', async () => {
  for (const options of [{ startFails: true }, { recordStartedAt: '2026-09-17T16:06:32Z' }]) {
    const f = fixture(options);
    assert.equal((await f.service.start()).status, 'failed');
    await f.service.start();
    assert.equal(f.starts(), 1);
    f.advance(1_800_000);
    await f.make().start();
    assert.equal(f.starts(), 2);
  }
});

test('wrong identity and blocked outcomes do not acknowledge a successful capture', async () => {
  for (const update of [{ reviewKind: 'prediction-markets-review' }, { outcome: 'blocked' }]) {
    const f = fixture(); await f.service.start(); f.complete(); Object.assign(f.run, update);
    assert.equal((await f.service.status()).status, 'blocked');
  }
});

test('failed and interrupted runs can retry after the same persistent throttle', async () => {
  for (const state of ['failed', 'cancelled', 'interrupted']) {
    const f = fixture(); await f.service.start(); f.run.state = state;
    assert.equal((await f.service.start()).status, 'failed');
    assert.equal(f.starts(), 1);
    f.advance(1_800_000);
    assert.equal((await f.service.start()).status, 'running');
    assert.equal(f.starts(), 2);
  }
});

test('status outages remain retryable without a five-second acquisition loop', async () => {
  const f = fixture(); await f.service.start(); f.setRequestFails(true);
  assert.equal((await f.service.start()).reason, 'review_status_unavailable');
  assert.equal(f.starts(), 1);
  f.advance(1_800_000); f.setRequestFails(false); f.run.state = 'failed';
  assert.equal((await f.service.start()).status, 'running');
  assert.equal(f.starts(), 2);
});

test('same-day relabeling cannot turn an old, future, or temporally inconsistent capture into the close book', async () => {
  for (const change of [
    run => { run.dependencies.portfolio.asOf = '2026-09-17T16:06:33Z'; },
    run => { run.dependencies.portfolio.asOf = '2026-09-16T20:30:00Z'; },
    run => { run.dependencies.portfolio.asOf = '2026-09-17T20:31:00Z'; },
    run => { run.dependencies.portfolio.asOf = 'invalid'; },
    run => { run.createdAt = '2026-09-17T20:29:59Z'; },
    run => { run.completedAt = '2026-09-16T20:30:00Z'; },
    run => { run.completedAt = '2026-09-17T20:31:00Z'; },
  ]) {
    const f = fixture(); await f.service.start(); f.complete(); change(f.run);
    assert.equal((await f.service.status()).reason, 'capture_time_unverified');
  }
});

test('liveVerified alone never overrides explicit stale, cached, disconnected or fabricated evidence', async () => {
  const variants = [
    { liveVerified: false }, { connected: false }, { available: false },
    ...['stale', 'isStale', 'cacheOnly', 'cached', 'fromCache', 'from_cache', 'mock', 'isMock', 'seed', 'seeded', 'inferred', 'synthetic', 'fallback', 'historicalOnly', 'offline', 'disconnected', 'delayed', 'frozen'].map(flag => ({ [flag]: true })),
    ...['stale', 'offline', 'disconnected', 'cache-only', 'mock', 'seeded', 'historical', 'unavailable'].map(status => ({ providerStatus: status })),
  ];
  for (const variant of variants) {
    const f = fixture(); await f.service.start(); f.complete(); Object.assign(f.run.dependencies.portfolio.detail, variant);
    assert.equal((await f.service.status()).reason, 'current_holdings_unavailable');
  }
  const f = fixture(); await f.service.start(); f.complete(); f.run.dependencies.portfolio.mock = true;
  assert.equal((await f.service.status()).status, 'blocked');
});

test('a partial review with an independently live-verified partial holdings dependency may complete', async () => {
  const f = fixture(); await f.service.start(); f.complete('partial');
  f.run.dependencies.portfolio.status = 'partial';
  f.run.dependencies.portfolio.detail.providerStatus = 'partial';
  assert.equal((await f.service.status()).status, 'ready');
});

test('baseline reports the previous exchange session: Friday on a Monday, skipping holidays', async () => {
  const captured = { '2026-10-09': '2026-10-09T20:30:05Z', '2026-09-04': '2026-09-04T20:30:05Z' };
  for (const [today, sessionDate] of [['2026-10-12T15:00:00Z', '2026-10-09'], ['2026-09-08T15:00:00Z', '2026-09-04']]) {
    const settings = new Map([[`hermes-portfolio-close:${sessionDate}`, { runId: 'close-run', startedAt: captured[sessionDate] }]]);
    const workspace = { initialize: async () => {}, call: async (_operation, args) => ({ value: settings.get(args.key) }) };
    const request = async path => {
      assert.equal(path, '/internal/reviews/close-run');
      return { run: { runId: 'close-run', reviewKind: 'portfolio-review', state: 'succeeded', outcome: 'partial',
        createdAt: captured[sessionDate], completedAt: captured[sessionDate],
        dependencies: { portfolio: { status: 'ready', asOf: captured[sessionDate], detail: { liveVerified: true } } } } };
    };
    const result = await createPortfolioCloseReview({ workspace, request, now: () => new Date(today) }).baseline();
    assert.equal(result.sessionDate, sessionDate);
    assert.equal(result.date, sessionDate);
    assert.equal(result.status, 'ready');
    assert.equal(result.capturedAt, captured[sessionDate]);
  }
});

test('a session without a saved close capture reports a missing baseline', async () => {
  const workspace = { initialize: async () => {}, call: async () => ({ value: undefined }) };
  const request = async () => assert.fail('No capture means no run lookup');
  const result = await createPortfolioCloseReview({ workspace, request, now: () => new Date('2026-10-14T19:00:00Z') }).baseline();
  assert.equal(result.sessionDate, '2026-10-13');
  assert.equal(result.status, 'pending');
  assert.equal(result.reason, 'not_started');
});
