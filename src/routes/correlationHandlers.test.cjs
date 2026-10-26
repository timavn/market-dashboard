'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createUsdCorrelationHandler } = require('./correlationHandlers.cjs');

function response() {
  return {
    statusCode: 200, headers: {}, body: undefined, statusCalls: [], events: [],
    set(key, value) { this.headers[key] = value; this.events.push(['set', key, value]); return this; },
    status(code) { this.statusCode = code; this.statusCalls.push(code); return this; },
    json(body) { this.body = body; this.events.push(['json', body]); return this; },
  };
}

test('USD correlation forwards its existing service envelope and measured completion log without request options', async (t) => {
  const times = [1000, 1035];
  t.mock.method(Date, 'now', () => times.shift());
  const log = t.mock.method(console, 'log', () => {});
  const envelope = Object.freeze({
    correlations: Object.freeze({ SPX: Object.freeze({ '30D': -0.8 }) }),
    rollingStats: Object.freeze({}), sourceStatus: 'current', source: 'Yahoo Finance daily bars',
    calculationDate: '2026-09-10', timestamp: '2026-09-11T17:00:00Z',
  });
  const getSnapshot = t.mock.fn(async () => envelope);
  const service = { getSnapshot };
  const handler = createUsdCorrelationHandler({ usdCorrelationService: service });
  assert.equal(getSnapshot.mock.callCount(), 0);
  const res = response();
  assert.equal(await handler({ query: { force: 'true', symbol: 'untrusted' } }, res), undefined);
  assert.deepEqual(getSnapshot.mock.calls[0].arguments, []);
  assert.equal(getSnapshot.mock.calls[0].this, service);
  assert.equal(res.body, envelope);
  assert.deepEqual(res.statusCalls, []);
  assert.deepEqual(res.headers, {});
  assert.deepEqual(log.mock.calls[0].arguments, ['[API] /api/usd/correlations completed in 35ms (2026-09-10)']);
});

test('USD correlation errors preserve current null fields, provider source, original message/code, and timing', async (t) => {
  const times = [2000, 2080];
  t.mock.method(Date, 'now', () => times.shift());
  const log = t.mock.method(console, 'error', () => {});
  const error = Object.assign(new Error('Current daily history is stale.'), { code: 'USD_CORRELATION_DATA_STALE' });
  const handler = createUsdCorrelationHandler({ usdCorrelationService: { getSnapshot: async () => { throw error; } } });
  const res = response();
  await handler({}, res);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, {
    correlations: null, rollingStats: null, timestamp: null, calculationDate: null,
    source: 'Yahoo Finance daily bars', sourceStatus: 'unavailable',
    error: error.message, code: error.code,
  });
  assert.deepEqual(res.headers, {});
  assert.deepEqual(log.mock.calls[0].arguments, ['[API] Error in /api/usd/correlations after 80ms:', error]);
});

test('USD correlation uses the existing fallback diagnostics and does not retain a prior successful response', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  let fail = false;
  const envelope = Object.freeze({ sourceStatus: 'current', calculationDate: '2026-09-10', correlations: Object.freeze({ SPX: 0.4 }) });
  const handler = createUsdCorrelationHandler({ usdCorrelationService: { getSnapshot: async () => {
    if (fail) throw { message: '', code: '' };
    return envelope;
  } } });
  const first = response();
  await handler({}, first);
  assert.equal(first.body, envelope);
  fail = true;
  const next = response();
  await handler({}, next);
  assert.equal(next.statusCode, 503);
  assert.equal(next.body.correlations, null);
  assert.equal(next.body.error, 'Current USD correlation data is unavailable');
  assert.equal(next.body.code, 'USD_CORRELATION_DATA_UNAVAILABLE');
});
