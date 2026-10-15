const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createCompletedSessionVolatilityHandler } = require('./completedSessionVolatility.cjs');
const { previousTradingDateKey } = require('../utils/usEquityMarketCalendar.cjs');
const { buildRealizedVolatilitySnapshot } = require('../utils/realizedVolatility.cjs');

const now = new Date('2026-10-07T01:30:00Z');
function history(overrides = {}) {
  const dates = [];
  let date = '2026-10-06';
  for (let i = 0; i < 260; i += 1) { dates.unshift(date); date = previousTradingDateKey(date); }
  return { yahooSymbol: '^GSPC', instrumentType: 'INDEX', fetchedAt: '2026-10-07T01:18:00Z',
    cacheStatus: 'hit', cacheAgeSeconds: 72,
    bars: dates.map((date, i) => ({ date, adjustedClose: 5000 * Math.exp(i * 0.001 + Math.sin(i) * 0.003), close: 9999 })),
    ...overrides };
}
async function run(loadHistory, query = {}) {
  const headers = {};
  let payload;
  const response = { set: (name, value) => { headers[name] = value; }, json: value => { payload = value; } };
  await createCompletedSessionVolatilityHandler({ loadHistory, now: () => now })({ query }, response);
  return { payload, headers };
}

test('requests only exact SPX one-year history and returns the identical verified 21/63-session calculations', async () => {
  const calls = [];
  const input = history();
  const { payload, headers } = await run(async (symbol, options) => { calls.push({ symbol, options }); return input; });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].symbol, 'SPX');
  assert.equal(Number(calls[0].options.period2) - Number(calls[0].options.period1), 366 * 86400);
  assert.equal(headers['Cache-Control'], 'no-store');
  const full = buildRealizedVolatilitySnapshot(input.bars, { includeSeries: false });
  assert.equal(payload.rows.SPX.realizedVolatility.rv21, full.rv21);
  assert.equal(payload.rows.SPX.realizedVolatility.rv63, full.rv63);
  assert.equal(payload.rows.SPX.realizedVolatility.observationCount, 63);
  assert.deepEqual(payload.completedSession, { status: 'current', expectedAsOf: '2026-10-06', observedAsOf: '2026-10-06' });
  assert.equal(payload.rows.SPX.provenance.security.fetchedAt, input.fetchedAt);
  assert.equal(payload.rows.SPX.provenance.security.cacheStatus, 'hit');
  assert.equal(payload.historicalOnly, true);
  assert.equal(payload.executable, false);
  assert.ok(JSON.stringify(payload).length < 1500);
});

test('force refresh passes through without requesting any ETF or unrelated metric', async () => {
  let call;
  await run(async (symbol, options) => { call = { symbol, options }; return history(); }, { forceRefresh: '1' });
  assert.equal(call.options.forceRefresh, true);
  assert.equal(call.symbol, 'SPX');
});

test('missing current close, missing adjusted observations and gaps cannot become current volatility', async () => {
  const input = history();
  for (const bars of [input.bars.slice(0, -1), input.bars.map(row => ({ date: row.date, close: row.close })),
    input.bars.filter((_, index) => index !== input.bars.length - 10), input.bars.slice(-63)]) {
    const { payload } = await run(async () => history({ bars }));
    assert.equal(payload.status, 'unavailable');
    assert.equal(payload.rows.SPX.realizedVolatility.rv21, null);
    assert.equal(payload.rows.SPX.realizedVolatility.rv63, null);
  }
});

test('unfinished next-session rows never move the verified completed date or calculations', async () => {
  const input = history();
  const { payload } = await run(async () => history({ bars: [...input.bars, { date: '2026-10-07', adjustedClose: 12345 }] }));
  assert.equal(payload.completedSession.observedAsOf, '2026-10-06');
  assert.equal(payload.rows.SPX.realizedVolatility.rv63, buildRealizedVolatilitySnapshot(input.bars, { includeSeries: false }).rv63);
});

test('foreign instruments and unverifiable provenance are unavailable', async () => {
  for (const override of [{ yahooSymbol: 'SPY' }, { instrumentType: 'ETF' }, { fetchedAt: null }]) {
    assert.equal((await run(async () => history(override))).payload.status, 'unavailable');
  }
});

test('offline, stale, cache-only, seed and mock inputs never supply a research value', async () => {
  for (const flag of ['offline', 'stale', 'cacheOnly', 'seed', 'seeded', 'mock']) {
    assert.equal((await run(async () => history({ [flag]: true }))).payload.status, 'unavailable');
  }
});

test('failed refresh does not use a prior successful calculation', async () => {
  let fail = false;
  const loadHistory = async () => { if (fail) throw new Error('provider failed'); return history(); };
  assert.equal((await run(loadHistory)).payload.status, 'available');
  fail = true;
  assert.equal((await run(loadHistory)).payload.status, 'unavailable');
});
