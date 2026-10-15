'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateMomoRoster, runMomoRosterCheck } = require('./check_momo_roster.cjs');

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

function snapshot(extras = ['MU', 'SNOW']) {
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

const check = value => validateMomoRoster(value, { nowMs: NOW });

test('validates a complete report and changes additions with the publication without a fixed roster', () => {
  assert.deepEqual(check(snapshot()), {
    status: 'ready', date: DATE, top10Tickers: BASE, momoAdditionalTickers: ['MU', 'SNOW'],
  });
  const changed = snapshot(['ORCL', 'SNDK']);
  assert.deepEqual(check(changed).momoAdditionalTickers, ['ORCL', 'SNDK']);
  changed.rows[9].ticker = 'MU';
  changed.rows[9].marketCap.sourceUrl = 'https://www.nasdaq.com/market-activity/stocks/mu';
  assert.equal(check(changed).status, 'ready');
});

test('requires every current report addition and rejects leftovers or wrong cap order', () => {
  const missing = snapshot();
  missing.supplementalRows.pop();
  assert.equal(check(missing).reason, 'momo_additions_mismatch');
  const leftover = snapshot(['ORCL', 'SNDK']);
  leftover.supplementalRows = snapshot().supplementalRows;
  assert.equal(check(leftover).reason, 'momo_additions_mismatch');
  const unordered = snapshot();
  unordered.supplementalRows.reverse();
  assert.equal(check(unordered).reason, 'momo_additions_unverified');
});

test('deduplicates company aliases in report and refuses duplicate or excluded base classes', () => {
  const alias = snapshot();
  alias.momoSnapshot.data.GOOG = alias.momoSnapshot.data.GOOGL;
  delete alias.momoSnapshot.data.GOOGL;
  assert.equal(check(alias).status, 'ready');
  alias.rows[2].ticker = 'GOOG';
  assert.equal(check(alias).reason, 'top10_unverified');
  const duplicate = snapshot();
  duplicate.rows[9].ticker = 'GOOGL';
  assert.equal(check(duplicate).reason, 'top10_unverified');
  const actualReportClass = snapshot(['FOX', 'FOXA', 'SNOW']);
  actualReportClass.supplementalRows.splice(1, 1);
  assert.deepEqual(check(actualReportClass).momoAdditionalTickers, ['FOX', 'SNOW']);
  const coveredClass = snapshot();
  coveredClass.momoSnapshot.data['BRK.A'] = {
    ...coveredClass.momoSnapshot.data.SNOW, index: 8,
  };
  coveredClass.momoSnapshot.meta.stockCount = 9;
  assert.deepEqual(check(coveredClass).momoAdditionalTickers, ['MU', 'SNOW']);
});

test('rejects stale, offline, cache-only, seeded, mocked and unprovenanced cap evidence', () => {
  for (const mutation of [
    { stale: true }, { offline: true }, { connected: false }, { cacheOnly: true },
    { seeded: true }, { mock: true }, { scope: 'share-class' }, { timestampKind: 'observed' },
    { fetchedAt: '2026-09-16T13:00:00Z' }, { sourceUrl: 'https://nasdaq.com.invalid.test/quote' },
  ]) {
    for (const section of ['rows', 'supplementalRows']) {
      const value = snapshot();
      Object.assign(value[section][0].marketCap, mutation);
      assert.equal(check(value).status, 'unavailable', `${section}: ${JSON.stringify(mutation)}`);
    }
  }
  const partial = snapshot();
  partial.supplementalRows[0].marketCap = null;
  assert.equal(check(partial).status, 'unavailable');
});

test('requires current verified membership and ten descending market-cap rows', () => {
  const cases = [
    value => { value.rows.pop(); },
    value => { value.rows.reverse(); },
    value => { value.membershipAsOf = '2026-09-11'; },
    value => { value.ranking = 'float-adjusted-market-cap'; },
    value => { value.offline = true; },
  ];
  for (const mutate of cases) {
    const value = snapshot();
    mutate(value);
    assert.equal(check(value).reason, 'top10_unverified');
  }
});

test('distinguishes pending publication from unavailable, incomplete and old reports', () => {
  const value = snapshot();
  delete value.momoSnapshot;
  value.momoPublicationDate = null;
  value.momoStatus = 'pending';
  value.supplementalRows = [];
  assert.equal(check(value).status, 'pending');
  value.momoStatus = 'unavailable';
  assert.equal(check(value).status, 'unavailable');
  delete value.momoStatus;
  assert.equal(check(value).status, 'unavailable');
  const incomplete = snapshot();
  delete incomplete.momoSnapshot.data.SNOW;
  assert.equal(check(incomplete).reason, 'momo_report_unverified');
  const stale = snapshot();
  stale.momoSnapshot.date = '2026-09-15';
  assert.equal(check(stale).status, 'unavailable');
});

test('skips weekends and market holidays without making a request', async () => {
  for (const day of ['2026-09-19', '2026-09-07']) {
    const output = await runMomoRosterCheck({
      now: () => Date.parse(`${day}T14:00:00Z`),
      fetchImpl: () => { throw new Error('Must not fetch on closed days'); },
    });
    assert.equal(output.status, 'skipped');
    assert.equal(output.reason, 'non_trading_day');
  }
});

test('fetches the dashboard afresh and outputs only roster/status data', async () => {
  const output = await runMomoRosterCheck({ now: () => NOW, fetchImpl: async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:3001/api/market/sp500-contributors');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.headers['Cache-Control'], 'no-cache');
    return { ok: true, headers: new Headers({ 'Cache-Control': 'no-store' }), json: async () => snapshot() };
  } });
  assert.equal(output.status, 'ready');
  assert.deepEqual(Object.keys(output), ['status', 'date', 'top10Tickers', 'momoAdditionalTickers']);
});

test('bounds stalled fetch/body reads and handles offline/cacheable responses', async () => {
  for (const fetchImpl of [
    async () => new Promise(() => {}),
    async () => ({ ok: true, headers: new Headers({ 'Cache-Control': 'no-store' }), json: () => new Promise(() => {}) }),
  ]) {
    const output = await runMomoRosterCheck({ now: () => NOW, fetchImpl, timeoutMs: 10 });
    assert.equal(output.reason, 'request_timeout');
  }
  const offline = await runMomoRosterCheck({ now: () => NOW, fetchImpl: async () => { throw new Error('private details'); } });
  assert.equal(offline.reason, 'endpoint_unavailable');
  const cacheable = await runMomoRosterCheck({ now: () => NOW, fetchImpl: async () => ({ ok: true, headers: new Headers() }) });
  assert.equal(cacheable.reason, 'response_not_fresh');
});
