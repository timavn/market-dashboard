const test = require('node:test');
const assert = require('node:assert/strict');
const { projectMomoRosterContext } = require('./momoRosterContext.cjs');
const { createSp500ContributorsHandler } = require('../../routes/sp500Contributors.cjs');

const NOW = Date.parse('2026-09-16T14:00:00Z');
const DATE = '2026-09-16';
const BASE = ['NVDA', 'AAPL', 'GOOGL', 'MSFT', 'AMZN', 'META', 'AVGO', 'TSLA', 'BRK.B', 'LLY'];

function row(ticker, cap, rank) {
  return { ticker, ...(rank ? { rank } : {}), weightPct: null, quote: null, marketCap: {
    status: 'available', value: cap, currency: 'USD', source: 'Nasdaq',
    sourceUrl: `https://www.nasdaq.com/market-activity/stocks/${ticker.toLowerCase()}`,
    scope: 'company', timestampKind: 'retrieved', fetchedAt: new Date(NOW).toISOString(),
  } };
}

function snapshot(extras = ['NFLX', 'SNOW']) {
  const reportTickers = ['NVDA', 'AAPL', 'GOOGL', 'MSFT', 'AMZN', 'META', ...extras];
  return {
    status: 'available', ranking: 'company-market-cap', rankingSource: 'Nasdaq',
    rankingSourceUrl: 'https://api.nasdaq.com/api/screener/stocks',
    source: 'State Street / S&P Dow Jones Indices', sourceUrl: 'https://www.ssga.com/spy',
    membershipAsOf: '2026-09-15', membershipSourceUrl: 'https://www.ssga.com/holdings.xlsx',
    asOf: '2026-09-15', fetchedAt: new Date(NOW).toISOString(),
    rows: BASE.map((ticker, index) => row(ticker, (20 - index) * 1e11, index + 1)),
    supplementalRows: extras.map((ticker, index) => row(ticker, (8 - index) * 1e10)),
    momoStatus: 'available', momoPublicationDate: DATE,
    momoSnapshot: {
      snapshotType: 'momo-tracker', date: DATE, contentComplete: true,
      meta: { stockCount: reportTickers.length },
      data: Object.fromEntries(reportTickers.map((ticker, index) => [ticker, {
        index, rangeStatus: 'available', buyTrade: 100, sellTrade: 120,
        upside: 5, downside: -5, trend: 'BULLISH',
      }])),
    },
  };
}

const project = value => projectMomoRosterContext(value, { nowMs: NOW });

test('projects the current complete roster with provenance and no quote or report values', () => {
  const value = snapshot();
  value.rows[0].quote = { status: 'live', price: 999.99 };
  const context = project(value);
  assert.equal(context.status, 'available');
  assert.equal(context.liveVerified, false);
  assert.equal(context.date, DATE);
  assert.deepEqual(context.data.topTenTickers, BASE);
  assert.deepEqual(context.data.momoAdditionalTickers, ['NFLX', 'SNOW']);
  assert.deepEqual(context.data.tickerOrder, [...BASE, 'NFLX', 'SNOW']);
  assert.equal(context.data.momoPublicationDate, DATE);
  assert.equal(context.data.sources.membership.asOf, '2026-09-15');
  assert.equal(context.data.sources.ranking.provider, 'Nasdaq');
  assert.equal(context.data.sources.momo.provider, 'Hedgeye');
  assert.doesNotMatch(JSON.stringify(context), /marketCap|999.99|buyTrade|sellTrade|BULLISH|momoSnapshot|quote/);
  assert.ok(JSON.stringify(context).length < 2500);
});

test('missing current report preserves separately verified top ten and signals pending', () => {
  const value = snapshot();
  Object.assign(value, { momoStatus: 'pending', momoPublicationDate: null, supplementalRows: [] });
  delete value.momoSnapshot;
  const context = project(value);
  assert.equal(context.status, 'partial');
  assert.equal(context.data.momoStatus, 'pending');
  assert.equal(context.data.momoPublicationDate, null);
  assert.deepEqual(context.data.momoAdditionalTickers, []);
});

test('reuses full exact-publication validation for omitted additions, stock count and company aliases', () => {
  for (const mutate of [
    value => value.supplementalRows.pop(),
    value => { value.momoSnapshot.meta.stockCount = 9; },
    value => { value.supplementalRows[0].marketCap.stale = true; },
    value => { value.momoSnapshot.date = '2026-09-15'; },
    value => { value.momoSnapshot.data.NVDA.mock = true; },
  ]) {
    const value = snapshot(); mutate(value);
    const context = project(value);
    assert.equal(context.status, 'partial');
    assert.equal(context.data.momoStatus, 'unavailable');
    assert.deepEqual(context.data.momoAdditionalTickers, []);
    assert.deepEqual(context.data.topTenTickers, BASE);
  }
  const duplicate = snapshot(['FOX', 'FOXA', 'SNOW']);
  assert.equal(project(duplicate).data.momoStatus, 'unavailable');
  duplicate.supplementalRows.splice(1, 1);
  assert.deepEqual(project(duplicate).data.momoAdditionalTickers, ['FOX', 'SNOW']);
});

test('stale membership, old observations, duplicate base classes and unavailable sources expose no roster', () => {
  for (const mutate of [
    value => { value.membershipAsOf = '2026-09-11'; },
    value => { value.fetchedAt = '2026-09-16T12:00:00Z'; },
    value => { value.rows[9].ticker = 'GOOG'; },
    value => { value.cacheOnly = true; },
    value => { value.rows[0].marketCap = null; },
  ]) {
    const value = snapshot(); mutate(value);
    const context = project(value);
    assert.equal(context.status, 'unavailable');
    assert.equal(context.data, null);
  }
});

test('Analyst query returns bounded verified context while regular endpoint retains its full contract', async () => {
  const value = snapshot();
  let calls = 0;
  const handler = createSp500ContributorsHandler({
    service: { getSnapshot: async () => { calls += 1; return value; } }, now: () => NOW,
  });
  const response = () => ({ code: 200, headers: {}, set(key, val) { this.headers[key] = val; return this; },
    status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } });
  const regular = response(); await handler({}, regular);
  assert.equal(regular.body, value);
  const analyst = response(); await handler({ query: { context: 'analyst' } }, analyst);
  assert.equal(analyst.headers['Cache-Control'], 'no-store');
  assert.equal(analyst.body.schemaVersion, 'MomoRosterContextV1');
  assert.deepEqual(analyst.body.data.tickerOrder, [...BASE, 'NFLX', 'SNOW']);
  assert.equal(analyst.body.rows, undefined);
  assert.equal(calls, 2);
});
