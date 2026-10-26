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
    'getPeriodReturnsCached', 'fetchIntlBondQuote', 'buildQuoteRow', 'withLiveTreasuryClose',
  ];
  const context = {
    Date, console, DAY_MS, ONE_YEAR_REFERENCE_MAX_GAP_MS: 7 * DAY_MS,
    percentageChange, latestObservationChange, buildQuoteMetadata, buildPeriodReturnsMetadata,
    toQuoteInstrument, INTL_BOND_FRED_FALLBACK: { BUND10Y: 'IRLTLT01DEM156N' },
    STOOQ_BOND_SYMBOLS: {},
    getTickerMapping: () => ({ source: 'fred', ticker: 'IRLTLT01DEM156N' }),
    fetchCnbcTreasuryQuote: async () => null,
    fetchCnbcTreasuryDailyCloses: async () => null,
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

test('without a daily source the quote and its periods are unavailable instead of a monthly average', async () => {
  const context = load({
    fetchOfficialSovereignSeries: async () => null,
    fetchFredQuote: async () => { throw new Error('Unexpected monthly quote'); },
    fetchFredDailyClosesSeries: async () => { throw new Error('Unexpected monthly history'); },
  });
  assert.equal(await context.fetchIntlBondQuote('BUND10Y'), null);
  assert.equal(await context.computePeriodReturnsForSymbol('BUND10Y', null, { source: 'fred' }), null);
  assert.equal(await context.computePeriodReturnsForSymbol('BUND10Y', null, null), null);
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

const cnbcQuote = {
  price: '3.400', change: '0.100', changePercent: '3.03', timestamp: '2026-09-25T09:10:00.000Z',
  sessionDate: '2026-09-25', source: 'cnbc', sourceSeriesId: 'DE10Y-DE',
  sourceInstrument: 'Germany 10 Year Bond (Germany)', observationFrequency: 'intraday', dataType: 'delayed',
};

test('the CNBC benchmark leads, and its periods come from the same CNBC daily closes plus the live reading', async () => {
  const context = load({
    fetchCnbcTreasuryQuote: async () => cnbcQuote,
    fetchCnbcTreasuryDailyCloses: async () => daily,
    fetchOfficialSovereignSeries: async () => { throw new Error('Official history is the fallback only'); },
  });
  const quote = await context.fetchIntlBondQuote('BUND10Y');
  assert.equal(quote, cnbcQuote);
  const periods = await context.computePeriodReturnsForSymbol('BUND10Y', null, quote);
  assert.equal(periods.observationFrequency, 'daily');
  assert.equal(periods.periodReturnsSource, 'cnbc');
  assert.equal(periods.periodSourceSeriesId, 'DE10Y-DE');
  assert.equal(periods.asOf, '2026-09-25T00:00:00.000Z');
  assert.equal(periods.dayChangeBps, 10);
  context.fetchCnbcTreasuryDailyCloses = async () => null;
  assert.equal(await context.computePeriodReturnsForSymbol('BUND10Y', null, quote), null);
});

test('when CNBC is down the official daily history answers, and source changes cannot reuse a period cache', async () => {
  const context = load({ fetchCnbcTreasuryQuote: async () => cnbcQuote, fetchCnbcTreasuryDailyCloses: async () => daily });
  const cnbcPeriods = await context.getPeriodReturnsCached('BUND10Y', null, await context.fetchIntlBondQuote('BUND10Y'));
  assert.equal(cnbcPeriods.periodReturnsSource, 'cnbc');
  context.fetchCnbcTreasuryQuote = async () => null;
  const officialQuote = await context.fetchIntlBondQuote('BUND10Y');
  assert.equal(officialQuote.source, 'bundesbank');
  assert.equal(officialQuote.observationFrequency, 'daily');
  const officialPeriods = await context.getPeriodReturnsCached('BUND10Y', null, officialQuote);
  assert.equal(officialPeriods.periodReturnsSource, 'bundesbank');
  assert.equal(officialPeriods.fifteenDayChangeBps, 20);
});
