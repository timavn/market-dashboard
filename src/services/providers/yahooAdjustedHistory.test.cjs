const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fetchYahooAdjustedHistoryData } = require('./yahooAdjustedHistory.cjs');

const payload = (overrides = {}) => ({ chart: { result: [{
  meta: { dataGranularity: '1d', currency: 'USD', instrumentType: 'ETF', symbol: 'SPY' },
  timestamp: [1704205800, 1704292200],
  indicators: { quote: [{ close: [100, 101] }], adjclose: [{ adjclose: [99, 101] }] },
  events: { dividends: { 1704292200: { date: 1704292200, amount: 1 } } },
  ...overrides,
}] } });

test('shared transport requests explicit daily adjusted history and retains raw actions', async () => {
  const raw = payload();
  let call;
  const result = await fetchYahooAdjustedHistoryData({ symbol: 'SPY', period2: '1704400000',
    httpClient: { get: async (url, options) => { call = { url, options }; return { data: raw }; } },
  });
  assert.equal(call.options.params.period1, '-2208988800');
  assert.equal(call.options.params.includeAdjustedClose, 'true');
  assert.equal(call.options.params.events, 'div,splits');
  assert.equal(call.options.params.interval, '1d');
  assert.deepEqual(result.bars.map(bar => bar.adjustedClose), [99, 101]);
  assert.deepEqual(result.rawResponse, raw);
  assert.equal(result.events.dividends[1704292200].amount, 1);
  assert.match(result.sourceUrl, /period2=1704400000/);
});

test('raw close, coarsened or rejected history cannot stand in for adjusted observations', async () => {
  for (const raw of [
    payload({ indicators: { quote: [{ close: [100, 101] }] } }),
    payload({ meta: { dataGranularity: '1mo' } }),
    { chart: { error: { code: 'Forbidden', description: 'private provider detail' } } },
  ]) {
    await assert.rejects(fetchYahooAdjustedHistoryData({ symbol: 'SPY', httpClient: { get: async () => ({ data: raw }) } }));
  }
});

test('unfinished session is excluded, while valid completed historical observations remain', async () => {
  const raw = payload({ meta: { dataGranularity: '1d', currentTradingPeriod: {
    regular: { start: 1704292200, end: 1704315600 },
  } } });
  const result = await fetchYahooAdjustedHistoryData({ symbol: 'SPY', now: 1704292300000,
    httpClient: { get: async () => ({ data: raw }) },
  });
  assert.equal(result.bars.length, 1);
  assert.equal(result.bars[0].adjustedClose, 99);
});
