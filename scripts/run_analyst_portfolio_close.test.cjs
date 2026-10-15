const test = require('node:test');
const assert = require('node:assert/strict');
const { runAnalystPortfolioClose } = require('./run_analyst_portfolio_close.cjs');

const NOW = Date.parse('2026-09-18T20:30:30Z');
const base = { date: '2026-09-18', scheduledTime: '16:30', timeZone: 'America/New_York' };
const response = (body, cache = 'no-store') => ({ ok: true, headers: new Headers({ 'cache-control': cache }), json: async () => body });

test('a manual-only review policy skips the closing schedule without a capture POST', async () => {
  const calls = [];
  const skipped = { ...base, reviewKind: 'portfolio-review', status: 'skipped', reason: 'user_initiated_only' };
  const result = await runAnalystPortfolioClose({ now: () => NOW, fetchImpl: async (_url, options) => {
    calls.push(options.method);
    return response(skipped);
  }, sleep: async () => assert.fail('Skipped captures do not poll') });
  assert.deepEqual(result, skipped);
  assert.deepEqual(calls, ['GET']);
});

test('checks the due state, triggers once, then verifies a current closing capture', async () => {
  const calls = [];
  const result = await runAnalystPortfolioClose({ now: () => NOW, sleep: async () => {}, fetchImpl: async (_url, options) => {
    calls.push(options.method);
    assert.equal(options.cache, 'no-store');
    return response({ ...base, status: ['pending', 'running', 'ready'][calls.length - 1], capturedAt: '2026-09-18T20:30:00Z' });
  } });
  assert.equal(result.status, 'ready');
  assert.deepEqual(calls, ['GET', 'POST', 'GET']);
});

test('a normal-day early check is read-only and silent; holidays never contact the API', async () => {
  const result = await runAnalystPortfolioClose({ now: () => Date.parse('2026-09-18T17:30:00Z'), fetchImpl: async (_url, options) => {
    assert.equal(options.method, 'GET');
    return response({ ...base, status: 'scheduled' });
  } });
  assert.equal(result.status, 'scheduled');
  for (const date of ['2026-09-19', '2026-12-25']) {
    const skipped = await runAnalystPortfolioClose({ now: () => Date.parse(`${date}T21:30:00Z`), fetchImpl: async () => assert.fail('No request expected') });
    assert.equal(skipped.status, 'skipped');
  }
});

test('early-close and winter captures use Eastern wall time', async () => {
  for (const [date, scheduledTime, capturedAt] of [
    ['2026-11-27', '13:30', '2026-11-27T18:30:00Z'],
    ['2026-12-01', '16:30', '2026-12-01T21:30:00Z'],
  ]) {
    const result = await runAnalystPortfolioClose({ now: () => Date.parse(capturedAt) + 1000,
      fetchImpl: async () => response({ ...base, date, scheduledTime, status: 'ready', capturedAt }) });
    assert.equal(result.status, 'ready');
  }
});

test('prior-day, intraday, future and fallback holdings never verify a closing capture', async () => {
  for (const extra of [
    { capturedAt: '2026-09-17T20:30:00Z' }, { capturedAt: '2026-09-18T16:06:00Z' },
    { capturedAt: '2026-09-18T21:30:00Z' }, { capturedAt: '2026-09-18T20:30:00Z', fallback: true },
    { capturedAt: '2026-09-18T20:30:00Z', verifiedAtCapture: false },
  ]) {
    const result = await runAnalystPortfolioClose({ now: () => NOW,
      fetchImpl: async () => response({ ...base, status: 'ready', ...extra }) });
    assert.equal(result.reason, 'capture_not_verified');
  }
});

test('an uncertain POST is followed without duplicate capture requests', async () => {
  const calls = [];
  const result = await runAnalystPortfolioClose({ now: () => NOW, sleep: async () => {}, fetchImpl: async (_url, options) => {
    calls.push(options.method);
    if (calls.length === 2) throw new Error('Temporary timeout');
    return response({ ...base, status: calls.length === 1 ? 'pending' : 'ready', capturedAt: '2026-09-18T20:30:00Z' });
  } });
  assert.equal(result.status, 'ready');
  assert.deepEqual(calls, ['GET', 'POST', 'GET']);
});

test('unverified responses, unavailable sources and transport failures remain failures', async () => {
  for (const [extra, cache, expected] of [
    [{ status: 'pending', date: '2026-09-17' }, 'no-store', 'failed'],
    [{ status: 'pending' }, 'max-age=600', 'failed'],
    [{ status: 'blocked', reason: 'holdings_unavailable' }, 'no-store', 'blocked'],
    [{ status: 'failed', reason: 'capture_failed' }, 'no-store', 'failed'],
  ]) {
    const result = await runAnalystPortfolioClose({ now: () => NOW, fetchImpl: async () => response({ ...base, ...extra }, cache) });
    assert.equal(result.status, expected);
  }
  const result = await runAnalystPortfolioClose({ now: () => NOW, sleep: async () => {}, fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(result.reason, 'capture_endpoint_unavailable');
});

test('a later hourly run retries a failed or blocked capture once its throttle has elapsed', async () => {
  for (const [first, retryAt, expectedCalls] of [
    [{ status: 'failed', reason: 'review_failed' }, '2026-09-18T20:30:00Z', ['GET', 'POST', 'GET']],
    [{ status: 'blocked', reason: 'current_holdings_unavailable' }, undefined, ['GET', 'POST', 'GET']],
    [{ status: 'failed', reason: 'review_failed' }, '2026-09-18T21:00:00Z', ['GET']],
  ]) {
    const calls = [];
    const result = await runAnalystPortfolioClose({ now: () => NOW, sleep: async () => {}, fetchImpl: async (_url, options) => {
      calls.push(options.method);
      if (calls.length === 1) return response({ ...base, ...first, ...(retryAt ? { retryAt } : {}) });
      return response({ ...base, status: calls.length === 2 ? 'running' : 'ready', capturedAt: '2026-09-18T20:30:00Z' });
    } });
    assert.deepEqual(calls, expectedCalls);
    assert.equal(result.status, expectedCalls.length > 1 ? 'ready' : 'failed');
  }
});

test('does not POST before the scheduled time or wait beyond the bounded deadline', async () => {
  const early = await runAnalystPortfolioClose({ now: () => NOW - 60_000,
    fetchImpl: async (_url, options) => { assert.equal(options.method, 'GET'); return response({ ...base, status: 'pending' }); } });
  assert.equal(early.reason, 'capture_not_due');
  let clock = NOW;
  const timeout = await runAnalystPortfolioClose({ now: () => clock, timeoutMs: 2, sleep: async () => { clock += 2; },
    fetchImpl: async () => response({ ...base, status: 'running' }) });
  assert.equal(timeout.reason, 'capture_timeout');
});
