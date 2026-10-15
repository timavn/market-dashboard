'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createVixHandler,
  createVolatilityHandler,
  createVolatilitySnapshotHandler,
} = require('./volatilityHandlers.cjs');

function response() {
  return {
    statusCode: 200, headers: {}, body: undefined, statusCalls: [],
    set(key, value) { this.headers[key] = value; return this; },
    status(code) { this.statusCode = code; this.statusCalls.push(code); return this; },
    json(body) { this.body = body; return this; },
  };
}

test('legacy VIX calls only its injected fetcher at request time and forwards the verified envelope unchanged', async (t) => {
  const envelope = Object.freeze({
    status: 'available', current: 18.2, change: -0.3, source: 'ibkr', dataType: 'live',
    observedAt: '2026-09-11T17:00:00Z', expiresAt: '2026-09-11T17:01:00Z',
    observation: Object.freeze({ provider: 'ibkr', connected: true }),
  });
  const fetchVIXData = t.mock.fn(async () => envelope);
  const handler = createVixHandler({ fetchVIXData });
  assert.equal(fetchVIXData.mock.callCount(), 0);
  const res = response();
  assert.equal(await handler({ query: { symbol: 'untrusted', refresh: 'true' } }, res), undefined);
  assert.deepEqual(fetchVIXData.mock.calls[0].arguments, []);
  assert.equal(res.body, envelope);
  assert.deepEqual(res.statusCalls, []);
  assert.deepEqual(res.headers, {});
});

test('legacy VIX preserves unavailable envelopes and the existing fixed 500 error response', async (t) => {
  const unavailable = Object.freeze({ status: 'unavailable', current: null, source: null, observation: null });
  const error = new Error('Provider disconnected.');
  const log = t.mock.method(console, 'error', () => {});
  let fail = false;
  const handler = createVixHandler({ fetchVIXData: async () => {
    if (fail) throw error;
    return unavailable;
  } });
  const first = response();
  await handler({}, first);
  assert.equal(first.statusCode, 200);
  assert.equal(first.body, unavailable);
  fail = true;
  const second = response();
  await handler({}, second);
  assert.equal(second.statusCode, 500);
  assert.deepEqual(second.body, { error: 'Failed to fetch VIX data' });
  assert.deepEqual(log.mock.calls[0].arguments, ['Error in VIX endpoint:', error]);
  assert.equal(second.body.current, undefined);
});

test('ticker volatility preserves case normalization, exact Yahoo symbols, request isolation, and body identity', async (t) => {
  const envelope = Object.freeze({ status: 'available', current: 18.2, observedAt: '2026-09-11T17:00:00Z' });
  const fetchVolatilityData = t.mock.fn(async () => envelope);
  const handler = createVolatilityHandler({ fetchVolatilityData });
  for (const [ticker, symbol] of [['VIX', '^VIX'], ['VvIx', '^VVIX'], ['rvx', '^RVX']]) {
    const res = response();
    await handler({ params: { ticker }, query: { symbol: '^OTHER', force: true } }, res);
    assert.deepEqual(fetchVolatilityData.mock.calls.at(-1).arguments, [symbol]);
    assert.equal(res.body, envelope);
    assert.deepEqual(res.statusCalls, []);
    assert.deepEqual(res.headers, {});
  }
});

test('unknown volatility tickers return the original 400 message before any provider call', async (t) => {
  const fetchVolatilityData = t.mock.fn();
  const handler = createVolatilityHandler({ fetchVolatilityData });
  for (const ticker of ['MOVE', ' VIX ', '', undefined]) {
    const res = response();
    assert.equal(await handler({ params: { ticker } }, res), res);
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body, { error: `Unknown volatility ticker: ${ticker}. Use vix, vvix, or rvx.` });
  }
  assert.equal(fetchVolatilityData.mock.callCount(), 0);
});

test('ticker fetch failures retain normalized diagnostics and a fixed 500 response without earlier values', async (t) => {
  const error = new Error('Internal quote error.');
  const log = t.mock.method(console, 'error', () => {});
  const handler = createVolatilityHandler({ fetchVolatilityData: async () => { throw error; } });
  const res = response();
  await handler({ params: { ticker: 'VvIx' } }, res);
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { error: 'Failed to fetch VVIX data' });
  assert.deepEqual(log.mock.calls[0].arguments, ['Error in volatility endpoint (vvix):', error]);
});

test('consolidated volatility maps only unavailable to 503 and leaves provider/source/close metadata unchanged', async (t) => {
  for (const [status, code] of [['ok', 200], ['partial', 200], ['unavailable', 503]]) {
    const envelope = Object.freeze({
      status, marketSession: 'closed', generatedAt: '2026-09-11T22:00:00Z', lastUpdated: null,
      VIX: Object.freeze({ availability: 'unavailable', current: null, freshness: 'stale', source: 'cboe' }),
      MOVE: Object.freeze({ availability: 'historical', current: 85.2, asOf: '2026-09-10', quoteMode: 'delayed' }),
    });
    const fetchSnapshot = t.mock.fn(async () => envelope);
    const service = { fetchSnapshot };
    const handler = createVolatilitySnapshotHandler({ volatilitySnapshotService: service });
    assert.equal(fetchSnapshot.mock.callCount(), 0);
    const res = response();
    assert.equal(await handler({ query: { stale: 'true' } }, res), res);
    assert.deepEqual(fetchSnapshot.mock.calls[0].arguments, []);
    assert.equal(fetchSnapshot.mock.calls[0].this, service);
    assert.equal(res.statusCode, code);
    assert.equal(res.body, envelope);
    assert.deepEqual(res.headers, {});
  }
});

test('unexpected snapshot failure returns the exact empty 503 envelope with current generation time', async (t) => {
  const log = t.mock.method(console, 'error', () => {});
  const error = new Error('Provider secrets must not appear here.');
  const start = Date.now();
  const handler = createVolatilitySnapshotHandler({ volatilitySnapshotService: { fetchSnapshot: async () => { throw error; } } });
  const res = response();
  assert.equal(await handler({}, res), res);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(Object.keys(res.body), ['status', 'generatedAt', 'lastUpdated', 'error']);
  assert.equal(res.body.status, 'unavailable');
  assert.equal(res.body.lastUpdated, null);
  assert.equal(res.body.error, 'Volatility providers are unavailable');
  assert.equal(new Date(res.body.generatedAt).toISOString(), res.body.generatedAt);
  assert.ok(Date.parse(res.body.generatedAt) >= start && Date.parse(res.body.generatedAt) <= Date.now());
  assert.deepEqual(log.mock.calls[0].arguments, ['[volatility-snapshot] unexpected snapshot failure:', error]);
});
