const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSp500ContributorsHandler } = require('./sp500Contributors.cjs');

const response = () => ({
  headers: {}, code: 200, body: null,
  set(key, value) { this.headers[key] = value; return this; },
  status(code) { this.code = code; return this; },
  json(body) { this.body = body; return this; },
});

test('serves verified contributor data with no HTTP caching', async () => {
  const snapshot = { status: 'available', rows: [{ ticker: 'NVDA', weightPct: 8 }] };
  const res = response();
  await createSp500ContributorsHandler({ service: { getSnapshot: async () => snapshot } })({}, res);
  assert.equal(res.code, 200);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.equal(res.body, snapshot);
});

test('returns unavailable on rejected index fetch and hides raw provider errors', async () => {
  const res = response();
  await createSp500ContributorsHandler({ service: { getSnapshot: async () => { throw new Error('private provider diagnostics'); } } })({}, res);
  assert.equal(res.code, 503);
  assert.deepEqual(res.body, { status: 'unavailable', rows: [] });
});

test('preserves empty fail-closed service response and non-success status', async () => {
  const snapshot = { status: 'unavailable', rows: [] };
  const res = response();
  await createSp500ContributorsHandler({ service: { getSnapshot: async () => snapshot } })({}, res);
  assert.equal(res.code, 503);
  assert.equal(res.body, snapshot);
});

test('loads the current publication on each request and passes additions/removals to the service', async () => {
  const publications = [
    { date: '2026-09-16', data: { NFLX: {}, SNOW: {} } },
    { date: '2026-09-17', data: { ORCL: {} } },
  ];
  const received = [];
  const handler = createSp500ContributorsHandler({
    loadMomoSnapshot: async () => publications.shift(),
    service: { getSnapshot: async (input) => { received.push(input.momoSnapshot); return { status: 'available', rows: [] }; } },
  });
  await handler({}, response());
  await handler({}, response());
  assert.deepEqual(received.map(item => Object.keys(item.data)), [['NFLX', 'SNOW'], ['ORCL']]);
});

test('failed publication reads do not reuse earlier additions or suppress independent company data', async () => {
  const received = [];
  const res = response();
  await createSp500ContributorsHandler({
    loadMomoSnapshot: async () => { throw new Error('private research failure'); },
    service: { getSnapshot: async (input) => { received.push(input); return { status: 'available', rows: [], supplementalRows: [] }; } },
  })({}, res);
  assert.deepEqual(received, [{ momoSnapshot: null }]);
  assert.equal(res.code, 200);
  assert.deepEqual(res.body.supplementalRows, []);
  assert.equal(res.body.momoStatus, 'unavailable');
});

test('a stalled publication read is bounded and supplies no unverified additions', async () => {
  const res = response();
  await createSp500ContributorsHandler({
    publicationTimeoutMs: 5,
    loadMomoSnapshot: () => new Promise(() => {}),
    service: { getSnapshot: async ({ momoSnapshot }) => ({ status: 'available', rows: [], momoSnapshot }) },
  })({}, res);
  assert.equal(res.code, 200);
  assert.equal(res.body.momoSnapshot, null);
  assert.equal(res.body.momoStatus, 'unavailable');
});
