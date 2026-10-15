const test = require('node:test');
const assert = require('node:assert/strict');
const { runAnalystMorningReview } = require('./run_analyst_morning_review.cjs');

const NOW = Date.parse('2026-09-16T13:30:00Z');
const base = { date: '2026-09-16', reviewKind: 'prediction-markets-review', runId: 'run-1', conversationId: 'daily-1' };
const response = (body, cache = 'no-store') => ({ ok: true, headers: new Headers({ 'cache-control': cache }), json: async () => body });

test('triggers once and follows the exact Analyst run to a partial report', async () => {
  const calls = [];
  const result = await runAnalystMorningReview({ now: () => NOW, sleep: async () => {}, fetchImpl: async (_url, options) => {
    calls.push(options.method);
    assert.equal(options.cache, 'no-store');
    return response({ ...base, status: calls.length === 1 ? 'running' : 'ready', outcome: 'partial' });
  } });
  assert.equal(result.status, 'ready'); assert.equal(result.outcome, 'partial');
  assert.deepEqual(calls, ['POST', 'GET']);
});

test('refuses cacheable, previous-day, mismatched, failed and blocked responses', async () => {
  for (const [body, cache, expected] of [
    [{ ...base, status: 'ready', outcome: 'ready' }, 'max-age=600', 'unavailable'],
    [{ ...base, date: '2026-09-15', status: 'ready', outcome: 'ready' }, 'no-store', 'unavailable'],
    [{ ...base, status: 'failed' }, 'no-store', 'failed'],
    [{ ...base, status: 'blocked' }, 'no-store', 'blocked'],
  ]) {
    const result = await runAnalystMorningReview({ now: () => NOW, fetchImpl: async () => response(body, cache) });
    assert.equal(result.status, expected);
  }
  let calls = 0;
  const mismatch = await runAnalystMorningReview({ now: () => NOW, sleep: async () => {}, fetchImpl: async () => {
    calls += 1;
    return response({ ...base, runId: calls === 1 ? 'run-1' : 'another', status: 'running' });
  } });
  assert.equal(mismatch.reason, 'review_identity_unverified');
});

test('offline and bounded wait failures remain visible', async () => {
  const offline = await runAnalystMorningReview({ now: () => NOW, sleep: async () => {}, fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(offline.status, 'unavailable');
  let clock = NOW;
  const timeout = await runAnalystMorningReview({ now: () => clock, timeoutMs: 2, sleep: async () => { clock += 2; },
    fetchImpl: async () => response({ ...base, status: 'running' }) });
  assert.equal(timeout.reason, 'review_timeout');
});

test('a temporary polling outage retries the same run without starting another report', async () => {
  const calls = [];
  const result = await runAnalystMorningReview({ now: () => NOW, sleep: async () => {}, fetchImpl: async (_url, options) => {
    calls.push(options.method);
    if (calls.length === 2) throw new Error('temporary timeout');
    return response({ ...base, status: calls.length === 1 ? 'running' : 'ready', outcome: 'partial' });
  } });
  assert.equal(result.status, 'ready');
  assert.deepEqual(calls, ['POST', 'GET', 'GET']);
});

test('does not contact the dashboard on a non-trading day', async () => {
  const result = await runAnalystMorningReview({ now: () => Date.parse('2026-09-19T13:30:00Z'), fetchImpl: async () => assert.fail('No request expected') });
  assert.equal(result.status, 'skipped');
});

test('accepts the manual-review policy without a generated chat or polling', async () => {
  let calls = 0;
  const skipped = { date: base.date, reviewKind: base.reviewKind, status: 'skipped', reason: 'user_initiated_only' };
  const result = await runAnalystMorningReview({ now: () => NOW, fetchImpl: async () => {
    calls += 1;
    return response(skipped);
  }, sleep: async () => assert.fail('Skipped schedules do not poll') });
  assert.deepEqual(result, skipped);
  assert.equal(calls, 1);
});
