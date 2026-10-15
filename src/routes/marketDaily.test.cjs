const test = require('node:test');
const assert = require('node:assert/strict');
const { createMarketDailyHandler } = require('./marketDaily.cjs');

const response = () => ({ headers: {}, code: null, body: null,
  set(key, value) { this.headers[key] = value; return this; },
  status(code) { this.code = code; return this; },
  json(body) { this.body = body; return this; },
});

test('serves the current snapshot with no HTTP caching', async () => {
  const snapshot = { status: 'available', coverage: { observed: 503, total: 503 } };
  const res = response();
  await createMarketDailyHandler({ service: { getSnapshot: () => snapshot } })({}, res);
  assert.equal(res.code, 200);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.equal(res.body, snapshot);
});

test('returns quiet unavailable output while first provider collection runs', async () => {
  const snapshot = { status: 'unavailable', loading: true };
  const res = response();
  await createMarketDailyHandler({ service: { getSnapshot: () => snapshot } })({}, res);
  assert.equal(res.code, 200);
  assert.deepEqual(res.body, snapshot);
});

test('never exposes raw provider failures', async () => {
  const res = response();
  await createMarketDailyHandler({ service: { getSnapshot: () => { throw new Error('Private provider diagnostic'); } } })({}, res);
  assert.equal(res.code, 200);
  assert.deepEqual(res.body, { status: 'unavailable', loading: false });
});
