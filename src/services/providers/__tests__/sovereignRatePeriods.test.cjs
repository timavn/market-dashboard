const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { percentageChange, latestObservationChange } = require('../observationChange.cjs');
const { withQuoteObservation } = require('../normalize/quoteContract.cjs');
const { buildQuoteMetadata, buildPeriodReturnsMetadata, toQuoteInstrument } = require('../multiRegionQuoteIntegrity.cjs');

const server = fs.readFileSync(path.resolve(__dirname, '../../../../server.js'), 'utf8');
const DAY_MS = 86_400_000;
const close = (date, value) => ({ t: Date.parse(`${date}T00:00:00Z`), close: value });
const monthly = [
  close('2025-08-01', 2), close('2026-01-01', 2.5), close('2026-02-01', 2.6),
  close('2026-05-01', 2.8), close('2026-07-01', 3), close('2026-08-01', 3.18),
];
const daily = [
  close('2025-09-24', 2), close('2026-01-02', 2.5), close('2026-03-24', 2.6),
  close('2026-06-24', 2.8), close('2026-08-24', 3), close('2026-09-09', 3.1),
  close('2026-09-23', 3.2), close('2026-09-24', 3.3),
];
const official = {
  source: 'bundesbank', seriesId: 'OFFICIAL_10Y', symbol: 'BUND10Y',
  sourceUrl: 'https://www.bundesbank.de/series', sourceInstrument: 'Published 10Y government yield',
  observationFrequency: 'daily', dataType: 'historical',
  receivedAt: '2026-09-25T00:00:00Z', closes: daily,
};

function load(overrides = {}) {
  const names = [
    'findCloseAtOrBefore', 'findClosestClose', 'computePeriodBpsFromCloses',
    'computePeriodPercentsFromCloses', 'symbolIsYahooRateProxy', 'computePeriodReturnsForSymbol',
    'getPeriodReturnsCached', 'fetchIntlBondQuote', 'buildQuoteRow',
  ];
  const context = {
    Date, console, DAY_MS, ONE_YEAR_REFERENCE_MAX_GAP_MS: 7 * DAY_MS,
    percentageChange, latestObservationChange, buildQuoteMetadata, buildPeriodReturnsMetadata,
    toQuoteInstrument, INTL_BOND_FRED_FALLBACK: { BUND10Y: 'IRLTLT01DEM156N' },
    STOOQ_BOND_SYMBOLS: {},
    getTickerMapping: () => ({ source: 'fred', ticker: 'IRLTLT01DEM156N' }),
    fetchOfficialSovereignSeries: async () => official,
    fetchFredDailyClosesSeries: async () => monthly,
    fetchTradingEconomicsBondSnapshot: async () => new Map(),
    fetchFredQuote: async () => ({ price: '3.18', change: '0.18', changePercent: '6', timestamp: '2026-08-01T00:00:00Z' }),
    periodReturnsCache: new Map(), PERIOD_RETURNS_CACHE_KEY_VERSION: '9', PERIOD_RETURNS_CACHE_TTL: 900_000,
    instrumentCacheKey: (value) => typeof value === 'string' ? value : value.symbol,
    isQuoteUsableNow: () => true,
    rateValueToBps: (value) => value == null ? null : Math.round(Number(value) * 1000) / 10,
    ...overrides,
  };
  const functions = names.map((name) => server.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`))[0]);
  vm.runInNewContext(functions.join('\n'), context);
  return context;
}

test('monthly references retain their levels and genuine month horizons without inventing submonthly returns', async () => {
  const context = load();
  const periods = await context.computePeriodReturnsForSymbol('BUND10Y', null, { source: 'fred' });
  assert.equal(periods.asOf, '2026-08-01T00:00:00.000Z');
  assert.equal(periods.observationFrequency, 'monthly');
  assert.equal(periods.periodReturnsSource, 'fred');
  assert.equal(periods.periodSourceSeriesId, 'IRLTLT01DEM156N');
  for (const period of ['day', 'week', 'fifteenDay']) {
    assert.equal(periods[`${period}ChangeBps`], null);
    assert.equal(periods[`${period}ChangePct`], null);
    assert.equal(periods.backdropPercentageReturns[`${period}ChangePct`], null);
  }
  assert.equal(periods.monthChangePct, 6);
  assert.equal(periods.monthChangeBps, 18);
  assert.equal(periods.threeMonthChangePct, 13.57);
  assert.equal(periods.oneYearChangePct, 59);
  assert.equal(periods.latestObservationChange.interval, 'monthly');
});

test('daily rate horizons require an observation near the requested date and reject missing values', () => {
  const context = load();
  const periods = context.computePeriodBpsFromCloses(daily, { observationFrequency: 'daily' });
  assert.equal(periods.dayChangeBps, 10);
  assert.equal(periods.fifteenDayChangeBps, 20);
  assert.equal(periods.backdropPercentageReturns.fifteenDayChangePct, 6.45);
  const sparse = context.computePeriodBpsFromCloses([
    close('2026-07-01', 3), close('2026-07-17', null), close('2026-08-01', 3.18),
  ]);
  assert.equal(sparse.fifteenDayChangeBps, null);
  assert.equal(sparse.backdropPercentageReturns.fifteenDayChangePct, null);
  assert.equal(sparse.monthChangeBps, 18);
});

test('calendar month horizons clamp month-end and leap-day dates without overflowing into the following month', () => {
  const context = load();
  const march = context.computePeriodBpsFromCloses([
    close('2026-02-27', 3), close('2026-03-03', 3.5), close('2026-03-31', 4),
  ]);
  assert.equal(march.monthChangeBps, 100);
  const leap = context.computePeriodBpsFromCloses([
    close('2023-02-28', 3), close('2023-03-01', 3.5), close('2024-02-29', 4),
  ]);
  assert.equal(leap.oneYearChangeBps, 100);
  const sixMonths = context.computePeriodBpsFromCloses([
    close('2026-02-27', 3), close('2026-03-03', 3.5), close('2026-08-31', 4),
  ]);
  assert.equal(sixMonths.sixMonthChangeBps, 100);
});

test('incomplete yearly history cannot pass its first later observation off as a YTD baseline', () => {
  const context = load();
  const complete = context.computePeriodBpsFromCloses([
    close('2026-01-02', 3), close('2026-03-31', 4),
  ]);
  assert.equal(complete.ytdChangeBps, 100);
  for (const observationFrequency of ['daily', 'monthly']) {
    const incomplete = context.computePeriodBpsFromCloses([
      close('2026-02-01', 3), close('2026-03-31', 4),
    ], { observationFrequency });
    assert.equal(incomplete.ytdChangeBps, null);
    assert.equal(incomplete.backdropPercentageReturns.ytdChangePct, null);
  }
});

test('official quote and history use the same daily benchmark with precise source metadata', async () => {
  const context = load({ fetchFredDailyClosesSeries: async () => { throw new Error('Unexpected FRED history'); } });
  const quote = await context.fetchIntlBondQuote('BUND10Y');
  assert.equal(quote.price, '3.3');
  assert.equal(quote.observationFrequency, 'daily');
  assert.equal(quote.sourceSeriesId, official.seriesId);
  assert.equal(quote.sourceInstrument, official.sourceInstrument);
  assert.equal(quote.timestamp, '2026-09-24T00:00:00.000Z');
  const periods = await context.computePeriodReturnsForSymbol('BUND10Y', null, quote);
  assert.equal(periods.asOf, quote.timestamp);
  assert.equal(periods.observationFrequency, 'daily');
  assert.equal(periods.periodReturnsSource, quote.source);
  assert.equal(periods.periodSourceSeriesId, quote.sourceSeriesId);
  assert.equal(periods.fifteenDayChangeBps, 20);
  const normalized = withQuoteObservation({ ...quote, symbol: 'BUND10Y' }, { receivedAt: official.receivedAt, now: Date.parse(official.receivedAt) });
  assert.equal(normalized.observation.valid, true);
  assert.equal(normalized.observationFrequency, 'daily');
  assert.equal(normalized.sourceSeriesId, official.seriesId);
  context.getQuote = async () => normalized;
  const row = await context.buildQuoteRow({ symbol: 'BUND10Y', name: 'Germany 10Y', intl: true, changeUnit: 'bps' }, { includeSparklines: false, wantPeriodReturns: true });
  assert.equal(row.price, '3.3');
  assert.equal(row.dayChangeBps, 10);
  assert.equal(row.periodObservationFrequency, 'daily');
  assert.equal(row.periodReturnsSource, official.source);
  assert.equal(row.periodSourceSeriesId, official.seriesId);
});

test('a missing or different official benchmark cannot borrow monthly FRED returns', async () => {
  for (const source of ['bundesbank', 'trading_economics']) {
    const context = load({
      fetchOfficialSovereignSeries: async () => null,
      fetchFredDailyClosesSeries: async () => { throw new Error('Mixed benchmark'); },
    });
    assert.equal(await context.computePeriodReturnsForSymbol('BUND10Y', null, { source, sourceSeriesId: 'OTHER' }), null);
  }
  const context = load();
  assert.equal(await context.computePeriodReturnsForSymbol('BUND10Y', null, { source: 'bundesbank', sourceSeriesId: 'OTHER' }), null);
});

test('newer official history cannot change a cached quote endpoint or inherit older cached returns', async () => {
  const context = load();
  const firstQuote = await context.fetchIntlBondQuote('BUND10Y');
  const firstPeriods = await context.getPeriodReturnsCached('BUND10Y', null, firstQuote);
  context.fetchOfficialSovereignSeries = async () => ({
    ...official, closes: [...daily, close('2026-09-25', 3.4)],
  });
  const capturedPeriods = await context.computePeriodReturnsForSymbol('BUND10Y', null, firstQuote);
  assert.equal(capturedPeriods.asOf, firstQuote.timestamp);
  assert.equal(capturedPeriods.monthChangeBps, firstPeriods.monthChangeBps);
  const newerQuote = await context.fetchIntlBondQuote('BUND10Y');
  const newerPeriods = await context.getPeriodReturnsCached('BUND10Y', null, newerQuote);
  assert.equal(newerPeriods.asOf, '2026-09-25T00:00:00.000Z');
  assert.equal(newerPeriods.monthChangeBps, 40);
  assert.equal(await context.computePeriodReturnsForSymbol('BUND10Y', null, { ...firstQuote, price: '3.31' }), null);
});

test('fallback stays explicitly monthly, and changing quote sources cannot reuse its period cache', async () => {
  const context = load({ fetchOfficialSovereignSeries: async () => null });
  const monthlyQuote = await context.fetchIntlBondQuote('BUND10Y');
  assert.equal(monthlyQuote.observationFrequency, 'monthly');
  assert.equal(monthlyQuote.sourceSeriesId, 'IRLTLT01DEM156N');
  assert.equal(monthlyQuote.timestamp, '2026-08-01T00:00:00Z');
  const monthlyPeriods = await context.getPeriodReturnsCached('BUND10Y', null, monthlyQuote);
  assert.equal(monthlyPeriods.fifteenDayChangeBps, null);
  context.fetchOfficialSovereignSeries = async () => official;
  const dailyQuote = await context.fetchIntlBondQuote('BUND10Y');
  const dailyPeriods = await context.getPeriodReturnsCached('BUND10Y', null, dailyQuote);
  assert.equal(dailyPeriods.observationFrequency, 'daily');
  assert.equal(dailyPeriods.fifteenDayChangeBps, 20);
});
