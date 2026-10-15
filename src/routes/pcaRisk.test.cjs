const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createPcaRiskRouter } = require('./pcaRisk.cjs');

async function serverFor(t, service) {
  const app = express();
  app.use(express.json());
  app.use('/api/risk/pca', createPcaRiskRouter({ service }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}/api/risk/pca`;
}

test('routes remain account scoped and historical-only without creating orders', async t => {
  const requests = [];
  const url = await serverFor(t, {
    snapshot: async input => { requests.push(input); return { status: 'partial', snapshot: { id: 'test' } }; },
    refresh: async input => { requests.push(input); return { pending: true }; },
    compare: async input => { requests.push(input); return { executable: false, snapshotId: input.snapshotId }; },
    config: async () => ({ window: 126 }), saveConfig: async (_account, config) => config,
  });
  const response = await fetch(`${url}/snapshot?account=U1&window=252`);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-data-use'), 'historical-research-only');
  assert.equal((await response.json()).status, 'partial');
  assert.deepEqual(requests[0], { account: 'U1', window: '252', id: undefined });
  const refresh = await fetch(`${url}/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: 'U1', window: 126 }) });
  assert.equal(refresh.status, 202);
  assert.equal((await refresh.json()).pending, true);
  const comparison = await fetch(`${url}/compare`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: 'U1', snapshotId: 'frozen', changes: [{ symbol: 'SPY', deltaWeight: -0.02 }] }) });
  assert.equal((await comparison.json()).executable, false);
  assert.equal(requests[2].changes[0].deltaWeight, -0.02);
  assert.equal((await fetch(`${url}/orders`, { method: 'POST' })).status, 404);
});

test('unexpected vendor failures never expose provider responses or private paths', async t => {
  const url = await serverFor(t, { snapshot: async () => { throw new Error('private-account-and-path'); } });
  const response = await fetch(`${url}/snapshot`);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { status: 'unavailable', historicalOnly: true, executable: false, error: 'PCA data is unavailable.' });
});

test('post-close capture restriction exposes a stable reason while saved reads remain available', async t => {
  const url = await serverFor(t, {
    snapshot: async () => ({ status: 'available', snapshot: { id: 'saved' } }),
    refresh: async () => { throw Object.assign(new Error('Build after 17:30 New York on a trading day.'), { status: 422, code: 'post_close_required' }); },
  });
  const response = await fetch(`${url}/refresh`, { method: 'POST' });
  assert.equal(response.status, 422);
  assert.equal((await response.json()).code, 'post_close_required');
  assert.equal((await (await fetch(`${url}/snapshot`)).json()).snapshot.id, 'saved');
});
