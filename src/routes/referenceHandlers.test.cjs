'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  createLeveragedProductOverlapHandler,
  createExchangeVolumeHandler,
  createMarketEventsHandler,
} = require('./referenceHandlers.cjs');

function response() {
  return {
    statusCode: 200,
    body: null,
    calls: [],
    headers: {},
    setHeader(key, value) { this.calls.push(['setHeader', key, value]); this.headers[key] = value; return this; },
    set(key, value) { this.calls.push(['set', key, value]); this.headers[key] = value; return this; },
    status(code) { this.calls.push(['status', code]); this.statusCode = code; return this; },
    json(body) { this.calls.push(['json', body]); this.body = body; return this; },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
}

test('overlap normalizes only the requested symbols, sets strict no-cache before reading, and returns the original payload', async () => {
  const payload = Object.freeze({ available: true, status: 'available', weightedOverlapPct: 12.34, asOf: '2026-09-10', fromCache: false, sources: [] });
  const res = response();
  const calls = [];
  const service = { async getOverlap(options) {
    assert.equal(this, service);
    assert.deepEqual(res.calls, [['setHeader', 'Cache-Control', 'no-store, no-cache, must-revalidate']]);
    calls.push(options);
    return payload;
  } };
  const handler = createLeveragedProductOverlapHandler({ leveragedProductOverlapService: service });
  const result = await handler({ query: { base: ' iak ', reference: ' xlf ', fromCache: 'true', refresh: '0' } }, res);
  assert.deepEqual(calls, [{ baseSymbol: 'IAK', referenceSymbol: 'XLF' }]);
  assert.equal(result, res);
  assert.equal(res.body, payload);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.calls.map(call => call[0]), ['setHeader', 'json']);
});

for (const query of [{}, { base: 'IAK' }, { base: '  ', reference: 'XLF' }, { base: 'IAK', reference: 0 }]) {
  test(`overlap rejects missing/falsy symbols before service use: ${JSON.stringify(query)}`, async () => {
    let calls = 0;
    const handler = createLeveragedProductOverlapHandler({ leveragedProductOverlapService: { async getOverlap() { calls += 1; } } });
    const res = response();
    await handler({ query }, res);
    assert.equal(calls, 0);
    assert.equal(res.statusCode, 400);
    assert.equal(res.headers['Cache-Control'], 'no-store, no-cache, must-revalidate');
    assert.deepEqual(res.body, {
      available: false,
      status: 'unavailable',
      weightedOverlapPct: null,
      fromCache: false,
      reason: 'Both base and reference symbols are required.',
    });
  });
}

test('overlap passes unavailable issuer results through at the existing successful HTTP status without guessing a percentage', async () => {
  const payload = Object.freeze({ available: false, status: 'unavailable', weightedOverlapPct: null, fromCache: false, reason: 'Published holdings are out of date.' });
  const handler = createLeveragedProductOverlapHandler({ leveragedProductOverlapService: { async getOverlap() { return payload; } } });
  const res = response();
  await handler({ query: { base: 'IAK', reference: 'XLF' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, payload);
  assert.equal(res.body.weightedOverlapPct, null);
});

test('overlap creates no handler-level cache or in-flight sharing between independent fresh requests', async () => {
  const requests = [deferred(), deferred()];
  let calls = 0;
  const handler = createLeveragedProductOverlapHandler({ leveragedProductOverlapService: {
    getOverlap() { return requests[calls++].promise; },
  } });
  const first = response();
  const second = response();
  const firstWork = handler({ query: { base: 'IAK', reference: 'XLF' } }, first);
  const secondWork = handler({ query: { base: 'IAK', reference: 'XLF' } }, second);
  assert.equal(calls, 2);
  assert.equal(first.body, null);
  assert.equal(second.body, null);
  const newer = Object.freeze({ available: true, asOf: '2026-09-11', weightedOverlapPct: 14 });
  requests[1].resolve(newer);
  await secondWork;
  const older = Object.freeze({ available: true, asOf: '2026-09-10', weightedOverlapPct: 13 });
  requests[0].resolve(older);
  await firstWork;
  assert.equal(first.body, older);
  assert.equal(second.body, newer);
});

for (const days of [undefined, '365', ['30', '60']]) {
  test(`exchange volume preserves the provider days argument without adding route cache/options: ${JSON.stringify(days)}`, async () => {
    const payload = Object.freeze({ totalMarket: [], totalExchange: [], meta: { status: 'current', fetchedAt: '2026-09-11T15:00:00Z', asOfTradingDate: '2026-09-10' } });
    const res = response();
    const calls = [];
    const service = { async fetchSnapshot(options) {
      assert.equal(this, service);
      assert.deepEqual(res.calls, [['set', 'Cache-Control', 'no-store']]);
      calls.push(options);
      return payload;
    } };
    const result = await createExchangeVolumeHandler({ exchangeVolumeService: service })({ query: { days, refresh: '1' } }, res);
    assert.deepEqual(calls, [{ days }]);
    assert.equal(calls[0].days, days);
    assert.equal(result, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, payload);
    assert.deepEqual(res.calls.map(call => call[0]), ['set', 'status', 'json']);
  });
}

for (const status of ['unavailable', 'stale', 'offline', 'CURRENT', undefined]) {
  test(`exchange volume uses 503 unless the provider meta status is exactly current: ${status}`, async () => {
    const payload = Object.freeze({ totalMarket: [], totalExchange: [], meta: { status, errorCode: 'CBOE_VOLUME_UNAVAILABLE' } });
    const res = response();
    await createExchangeVolumeHandler({ exchangeVolumeService: { async fetchSnapshot() { return payload; } } })({ query: {} }, res);
    assert.equal(res.statusCode, 503);
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assert.equal(res.body, payload);
    assert.deepEqual(res.body.totalMarket, []);
  });
}

test('exchange volume serves verified ex-US data when the US provider fails', async () => {
  const payload = {
    asOf: null,
    totalExchange: [],
    meta: { status: 'unavailable' },
    exUs: { asOf: '2026-09-10', meta: { status: 'current' } },
  };
  const res = response();
  await createExchangeVolumeHandler({ exchangeVolumeService: { async fetchSnapshot() { return payload; } } })({ query: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.equal(res.body, payload);
});

test('calendar returns a verified empty week unchanged and delegates bounded caching to its service', async () => {
  const payload = Object.freeze({ status: 'verified', events: [], fetchedAt: '2026-09-11T15:00:00Z', sourceUpdatedAt: '2026-09-11T14:00:00Z', coverage: { from: '2026-09-06', to: '2026-09-12' } });
  const calls = [];
  const service = { async getEvents(...args) { assert.equal(this, service); calls.push(args); return payload; } };
  const handler = createMarketEventsHandler({ marketEventsService: service });
  for (const query of [{ refresh: '1' }, { fromCache: 'true' }]) {
    const res = response();
    const result = await handler({ query }, res);
    assert.equal(result, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, payload);
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assert.deepEqual(res.calls.map(call => call[0]), ['set', 'json']);
  }
  assert.deepEqual(calls, [[], []]);
});

test('calendar passes the next-week selector through without changing provider availability', async () => {
  const payload = Object.freeze({
    status: 'unavailable',
    events: [],
    code: 'NEXT_WEEK_EXPORT_UNAVAILABLE',
    coverage: { from: '2026-09-13', to: '2026-09-19' },
  });
  const calls = [];
  const service = { async getEvents(...args) { calls.push(args); return payload; } };
  const res = response();

  await createMarketEventsHandler({ marketEventsService: service })({ query: { week: 'next' } }, res);

  assert.deepEqual(calls, [[{ week: 'next' }]]);
  assert.equal(res.statusCode, 503);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.equal(res.body, payload);
});

for (const week of ['previous', '', ['this', 'next'], { week: 'next' }]) {
  test(`calendar rejects an invalid week selector without requesting provider data: ${JSON.stringify(week)}`, async () => {
    let requested = false;
    const service = { async getEvents() { requested = true; } };
    const res = response();

    await createMarketEventsHandler({ marketEventsService: service })({ query: { week } }, res);

    assert.equal(requested, false);
    assert.equal(res.statusCode, 400);
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assert.deepEqual(res.body, {
      status: 'unavailable',
      code: 'INVALID_WEEK',
      reason: 'Choose this week or next week.',
      events: [],
    });
  });
}

for (const status of ['unavailable', 'stale', 'verified-cache', undefined]) {
  test(`calendar preserves unavailable details and 503 for a non-verified status: ${status}`, async () => {
    const payload = Object.freeze({ status, events: [], code: 'PROVIDER_RATE_LIMITED', retryAt: '2026-09-11T15:05:00Z', reason: 'Calendar unavailable' });
    const res = response();
    await createMarketEventsHandler({ marketEventsService: { async getEvents() { return payload; } } })({}, res);
    assert.equal(res.statusCode, 503);
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assert.equal(res.body, payload);
    assert.deepEqual(res.calls.map(call => call[0]), ['set', 'status', 'json']);
  });
}

for (const [name, build, request, header] of [
  ['overlap', (reject) => createLeveragedProductOverlapHandler({ leveragedProductOverlapService: { getOverlap: reject } }), { query: { base: 'IAK', reference: 'XLF' } }, 'no-store, no-cache, must-revalidate'],
  ['exchange volume', (reject) => createExchangeVolumeHandler({ exchangeVolumeService: { fetchSnapshot: reject } }), { query: {} }, 'no-store'],
  ['calendar', (reject) => createMarketEventsHandler({ marketEventsService: { getEvents: reject } }), {}, 'no-store'],
]) {
  test(`${name} preserves unexpected service rejection without fabricating an error body or retained success`, async () => {
    const failure = Object.assign(new Error('Unexpected provider failure'), { code: 'PROVIDER_FAILURE' });
    const res = response();
    await assert.rejects(build(async () => { throw failure; })(request, res), error => error === failure);
    assert.equal(res.headers['Cache-Control'], header);
    assert.equal(res.body, null);
    assert.equal(res.calls.filter(call => ['status', 'json'].includes(call[0])).length, 0);
  });
}
