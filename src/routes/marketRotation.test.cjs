const test = require('node:test');
const assert = require('node:assert/strict');
const { createMarketRotationHandler } = require('./marketRotation.cjs');

const response = () => ({ headers: {}, code: null, body: null,
  set(key, value) { this.headers[key] = value; return this; },
  status(code) { this.code = code; return this; },
  json(body) { this.body = body; return this; },
});

test('serves the independent rotation snapshot without HTTP caching', async () => {
  const snapshot = { status: 'partial', themes: { software: { ticker: 'IGV' } }, factors: [] };
  const res = response();
  await createMarketRotationHandler({ service: { getSnapshot: async () => snapshot } })({}, res);
  assert.equal(res.code, 200);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.equal(res.body, snapshot);
});

test('failed collection returns empty stable slots without exposing provider failures', async () => {
  const res = response();
  await createMarketRotationHandler({ service: { getSnapshot: async () => { throw new Error('Private provider error'); } } })({}, res);
  assert.equal(res.code, 200);
  assert.equal(res.body.status, 'unavailable');
  assert.equal(res.body.themes.software, null);
  assert.equal(res.body.themes.leader, null);
  assert.equal(res.body.factors.length, 4);
  assert.ok(res.body.factors.every(row => row.spreadPp === null));
  assert.ok(!JSON.stringify(res.body).includes('Private'));
});
