'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCurrencyPairsHandler } = require('./currencyPairsHandler.cjs');

function response() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    calls: [],
    set(key, value) { this.calls.push(['set', key, value]); this.headers[key] = value; return this; },
    status(code) { this.calls.push(['status', code]); this.statusCode = code; return this; },
    json(body) { this.calls.push(['json', body]); this.body = body; return this; },
  };
}

function assertUnavailable(res) {
  assert.equal(res.statusCode, 503);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.deepEqual(res.body, {
    status: 'unavailable',
    currencyPairs: [],
    reason: 'verified_currency_pair_provider_unavailable',
  });
  assert.deepEqual(res.calls.map(([method]) => method), ['set', 'status', 'json']);
}

test('currency pairs uses the exact unavailable contract instead of fabricated prices or a fresh timestamp', () => {
  const res = response();
  const returned = createCurrencyPairsHandler()({}, res);
  assert.equal(returned, res);
  assertUnavailable(res);
});

for (const query of [
  { provider: 'live', connected: 'true', rate: '149.23', timestamp: '2026-09-11T15:00:00Z' },
  { provider: 'offline', stale: 'true', fromCache: 'true', refresh: '0' },
  { mock: 'true', seed: 'true', fallback: 'true' },
]) {
  test(`currency pairs cannot opt into client-supplied quote evidence: ${JSON.stringify(query)}`, () => {
    const res = response();
    createCurrencyPairsHandler()({ query }, res);
    assertUnavailable(res);
  });
}

test('currency pairs returns a fresh empty payload per request without retaining mutable previous rows', () => {
  const handler = createCurrencyPairsHandler();
  const first = response();
  handler({}, first);
  first.body.currencyPairs.push({ pair: 'USDJPY', rate: 'test-only injection' });
  first.body.status = 'live';
  const second = response();
  handler({}, second);
  assertUnavailable(second);
  assert.notEqual(first.body, second.body);
  assert.notEqual(first.body.currencyPairs, second.body.currencyPairs);
});
