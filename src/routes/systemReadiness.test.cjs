const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { once } = require('node:events');
const { createSystemReadinessRoutes } = require('./systemReadiness.cjs');
const { createLocalTrustMiddleware } = require('../services/security/localTrust.cjs');

async function fixture(context, overrides = {}) {
  const calls = [];
  let invalidations = 0;
  const app = express();
  app.use(createLocalTrustMiddleware());
  app.use(express.json());
  app.use('/api/system-readiness', createSystemReadinessRoutes({
    readinessService: { collect: async (...args) => { calls.push(['collect', ...args]); return { ready: true, status: 'ready' }; } },
    repairService: { run: async (...args) => { calls.push(['repair', ...args]); return { accepted: true }; } },
    invalidateResearchProjections: () => { invalidations += 1; },
    logger: { error() {} },
    now: () => Date.parse('2026-09-04T21:00:00Z'),
    ...overrides,
  }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  context.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}/api/system-readiness`;
  return { calls, invalidations: () => invalidations, request: (suffix = '', options = {}) => fetch(url + suffix, options) };
}
test('readiness route preserves path, no-store, and bounded public collection', async context => {
  const { request, calls } = await fixture(context);
  const result = await request('?refresh=1');
  assert.equal(result.status, 200); assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await result.json(), { ready: true, status: 'ready', durationMs: 0 });
  assert.deepEqual(calls, [['collect']]);
});
test('collector failure returns a blocked result instead of retained success', async context => {
  const { request } = await fixture(context, { readinessService: { collect: async () => { throw new Error('unavailable'); } } });
  const result = await request(); const payload = await result.json();
  assert.equal(result.status, 500); assert.equal(payload.ready, false); assert.equal(payload.status, 'blocked');
  assert.equal(payload.detail, 'unavailable'); assert.equal(result.headers.get('cache-control'), 'no-store');
});
test('repair header is required and service authorization errors retain their status', async context => {
  let calls = 0;
  const { request } = await fixture(context, { repairService: { run: async () => { calls += 1; throw Object.assign(new Error('disabled'), { statusCode: 403, code: 'REPAIR_NOT_ELIGIBLE' }); } } });
  const missing = await request('/actions/retry-gmail-poll', { method: 'POST' });
  assert.equal(missing.status, 400); assert.equal(calls, 0);
  const denied = await request('/actions/retry-gmail-poll', { method: 'POST', headers: { 'X-Readiness-Repair': '1' } });
  assert.equal(denied.status, 403); assert.deepEqual(await denied.json(), { accepted: false, code: 'REPAIR_NOT_ELIGIBLE', error: 'disabled' });
});
test('accepted repairs use socket identity and invalidate only the rebuild projection', async context => {
  const { request, calls, invalidations } = await fixture(context);
  const result = await request('/actions/rebuild-research-projections', { method: 'POST', headers: { 'X-Readiness-Repair': '1', 'X-Forwarded-For': '203.0.113.1', 'Content-Type': 'application/json' }, body: JSON.stringify({ command: 'untrusted command' }) });
  assert.equal(result.status, 202);
  assert.deepEqual(calls, [['repair', 'rebuild-research-projections', { remoteAddress: '127.0.0.1' }]]);
  assert.equal(invalidations(), 1);
});
test('the global local trust boundary still blocks cross-origin operational requests', async context => {
  const { request, calls } = await fixture(context);
  const result = await request('/actions/retry-gmail-poll', { method: 'POST', headers: { Origin: 'https://attacker.example', 'X-Readiness-Repair': '1' } });
  assert.equal(result.status, 403); assert.deepEqual(calls, []);
});
test('live checks bypass the cached collection and only allowlisted ids resolve', async context => {
  const liveCalls = [];
  const activity = { id: 'analyst.activity', status: 'pass', observedAt: '2026-09-04T21:00:00.000Z' };
  const { request, calls } = await fixture(context, { readinessService: {
    collect: async () => { throw new Error('the cached collection must not run'); },
    collectLiveCheck: async (checkId) => { liveCalls.push(checkId); return checkId === 'analyst.activity' ? activity : null; },
  } });
  const result = await request('/checks/analyst.activity');
  assert.equal(result.status, 200); assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await result.json(), activity);
  const unknown = await request('/checks/dashboard.ui');
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).code, 'READINESS_LIVE_CHECK_UNKNOWN');
  assert.deepEqual(liveCalls, ['analyst.activity', 'dashboard.ui']); assert.deepEqual(calls, []);
  const failing = await fixture(context, { readinessService: { collectLiveCheck: async () => { throw new Error('boom'); } } });
  const failed = await failing.request('/checks/analyst.activity');
  assert.equal(failed.status, 500); assert.equal((await failed.json()).code, 'READINESS_LIVE_CHECK_FAILED');
  const legacy = await fixture(context, { readinessService: { collect: async () => ({}) } });
  assert.equal((await legacy.request('/checks/analyst.activity')).status, 404);
});
