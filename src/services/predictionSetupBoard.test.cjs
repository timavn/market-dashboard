const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSetupBoard, createSetupBoardLoader, evaluateSetup, selectEvents } = require('./predictionSetupBoard.cjs');

const rule = { bottomThird: 0.3333, topThird: 0.6667 };
const tick = (direction) => ({ direction });

test('long requires Bullish Trend and Tick in the bottom third of the range', () => {
  assert.equal(evaluateSetup({ trend: 'BULLISH', tick: tick('BULLISH'), position: 0.2 }, rule).side, 'LONG');
  assert.equal(evaluateSetup({ trend: 'BULLISH', tick: tick('BULLISH'), position: 0.5 }, rule).side, null);
  assert.equal(evaluateSetup({ trend: 'BULLISH', tick: tick('NEUTRAL'), position: 0.2 }, rule).side, null);
  assert.equal(evaluateSetup({ trend: 'BULLISH', tick: null, position: 0.2 }, rule).side, null);
});

test('short requires Bearish Trend and Tick in the top third of the range', () => {
  assert.equal(evaluateSetup({ trend: 'BEARISH', tick: tick('BEARISH'), position: 0.9 }, rule).side, 'SHORT');
  assert.equal(evaluateSetup({ trend: 'BEARISH', tick: tick('BEARISH'), position: 0.4 }, rule).side, null);
});

test('Trade blocks only when it is published and points the other way', () => {
  const long = { trend: 'BULLISH', tick: tick('BULLISH'), position: 0.1 };
  assert.equal(evaluateSetup({ ...long, trade: null }, rule).side, 'LONG');
  assert.equal(evaluateSetup({ ...long, trade: { direction: 'BULLISH' } }, rule).side, 'LONG');
  assert.deepEqual(evaluateSetup({ ...long, trade: { direction: 'BEARISH' } }, rule), { side: null, reason: 'Blocked by Trade' });
});

test('prices outside the range never qualify', () => {
  assert.deepEqual(evaluateSetup({ trend: 'BULLISH', tick: tick('BULLISH'), position: -0.1 }, rule),
    { side: null, reason: 'Below range' });
  assert.deepEqual(evaluateSetup({ trend: 'BEARISH', tick: tick('BEARISH'), position: 1.2 }, rule),
    { side: null, reason: 'Above range' });
});

test('selects the 5pm crypto event and the 4pm index close event', () => {
  const btc = selectEvents({ id: 'bitcoin', kalshi: { series: 'KXBTCD' } }, { KXBTCD: [
    { event_ticker: 'KXBTCD-26OCT1617' }, { event_ticker: 'KXBTCD-26OCT1014' }, { event_ticker: 'KXBTCD-26OCT1017' },
  ] });
  assert.equal(btc[0].eventTicker, 'KXBTCD-26OCT1017');
  const spx = selectEvents({ id: 'sp500', kalshi: { series: 'KXINXU' } }, { KXINXU: [
    { event_ticker: 'KXINXU-26OCT12H1000' }, { event_ticker: 'KXINXU-26OCT12H1600' },
  ] });
  assert.equal(spx[0].eventTicker, 'KXINXU-26OCT12H1600');
  const wti = selectEvents({ id: 'wti', kalshi: { series: 'KXWTI' } }, { KXWTI: [
    { event_ticker: 'KXWTI-26NOV03' }, { event_ticker: 'KXWTI-26OCT1414' }, { event_ticker: 'KXWTI-26OCT1314' },
  ] });
  assert.equal(wti[0].eventTicker, 'KXWTI-26OCT1314');
  const brent = selectEvents({ id: 'brent', kalshi: { series: 'KXBRENTD' } }, { KXBRENTD: [
    { event_ticker: 'KXBRENTD-26OCT2117' }, { event_ticker: 'KXBRENTD-26OCT2014' }, { event_ticker: 'KXBRENTD-26OCT2017' },
  ] });
  assert.equal(brent[0].eventTicker, 'KXBRENTD-26OCT2017');
});

test('Brent sits under Oil beside WTI with its own Risk Range, price, Tick proxy and USD correlation', () => {
  const board = buildSetupBoard({
    riskRanges: { ranges: { BRENT: { lrr: 104, hrr: 114, trend: 'BULLISH', date: '2026-10-20' } } },
    quotes: { 'BZ=F': { price: 106.27 } },
    usdCorrelations: { calculationDate: '2026-10-19', correlations: { BRENT: { '15D': 0.146, '30D': 0.115, '60D': 0.489, '90D': 0.111 } } },
  });
  const oil = board.rows.filter((row) => row.group === 'oil');
  assert.deepEqual(oil.map((row) => row.id), ['wti', 'brent']);
  const brent = oil[1];
  assert.equal(brent.label, 'Brent');
  assert.deepEqual([brent.range.low, brent.range.high, brent.trend, brent.price.value], [104, 114, 'BULLISH', 106.27]);
  assert.equal(brent.usdCorrelation.key, 'BRENT');
});

test('builds rows from Hedgeye research, quotes and Kalshi events', () => {
  const board = buildSetupBoard({
    riskRanges: { manifest: { publicationDate: '2026-10-09' }, ranges: {
      BITCOIN: { lrr: 81450, hrr: 87366, trend: 'BULLISH', date: '2026-10-09' },
      UST2Y: { lrr: 4.73, hrr: 4.96, trend: 'BULLISH', date: '2026-10-09' },
      COMPQ: { lrr: 26804, hrr: 27777, trend: 'BULLISH', date: '2026-10-09' },
    } },
    cryptoQuant: { date: '2026-10-09', data: { cryptos: { ETH: { buyTrade: 2406, sellTrade: 2825, trend: 'BULLISH' } } } },
    hedgai: { book: { rows: [
      { ticker: 'IBIT', position: 'Buy', publicationDate: '2026-09-29' },
      { ticker: 'SHY', position: 'Buy', publicationDate: '2026-09-28' },
    ] } },
    nowcast: { data: { forecasts: [{ reportMonth: '2026-09', scenarios: { lower: 3.63, base: 3.74, upper: 3.85 } }] } },
    quotes: { 'BTC-USD': { price: 82627 }, 'ETH-USD': { price: 2490 }, UST2Y: { price: 4.75 }, '^NDX': { price: 30883 }, '^IXIC': { price: 27366 } },
    eventsBySeries: { KXCPIYOY: [{ event_ticker: 'KXCPIYOY-26NOV' }, { event_ticker: 'KXCPIYOY-26SEP' }] },
    marketDate: '2026-10-09',
  });
  const row = (id) => board.rows.find((item) => item.id === id);
  assert.equal(row('bitcoin').setup.side, 'LONG');
  assert.equal(Math.round(row('bitcoin').position * 100), 20);
  assert.equal(row('ethereum').range.product, 'crypto-quant');
  assert.equal(row('ethereum').tick, null);
  assert.equal(row('ethereum').setup.side, null);
  // SHY is a Treasury price ETF: its Buy means yields down.
  assert.equal(row('ust2y').tick.direction, 'BEARISH');
  assert.equal(row('ust2y').setup.side, null);
  // The Composite range is positioned with the Composite price, never NDX.
  assert.equal(row('nasdaq100').rangePrice.symbol, '^IXIC');
  assert.equal(Math.round(row('nasdaq100').position * 100), 58);
  assert.equal(row('cpi').events[0].eventTicker, 'KXCPIYOY-26SEP');
  assert.deepEqual([row('cpi').forecast.lower, row('cpi').forecast.base, row('cpi').forecast.upper], [3.63, 3.74, 3.85]);
  assert.equal(board.rows.some((item) => item.id === 'ust5y'), false);
});

test('attaches each market group volatility gauge with its Hedgeye range when published', () => {
  const board = buildSetupBoard({
    riskRanges: { ranges: { VIX: { lrr: 14.58, hrr: 16.71, trend: 'BEARISH', date: '2026-10-09' } } },
    volatility: { VIX: { lastPx: 15.34, dayChangePct: 3.37, fifteenDayChangePct: 6.83, monthChangePct: -11.23,
      availability: 'available', asOf: '2026-10-12T13:53:16.000Z' },
      GVZ: { lastPx: 22.93, availability: 'unavailable' }, MOVE: { lastPx: 98.47, availability: 'available' },
      VXSLV: { lastPx: 36.33, dayChangePct: -3.74, availability: 'historical', asOf: '2026-10-09T20:00:01.000Z' } },
  });
  const row = (id) => board.rows.find((item) => item.id === id);
  assert.deepEqual(row('sp500').volatility, { symbol: 'VIX', label: 'Cboe Volatility Index', value: 15.34, changePct: 3.37,
    d15: 6.83, m1: -11.23, asOf: '2026-10-12T13:53:16.000Z', regimeKey: 'VIX', low: 14.58, high: 16.71, trend: 'BEARISH', rangeDate: '2026-10-09' });
  assert.equal(row('silver').volatility.value, 36.33);
  // An unavailable gauge holds its row with no value; its last price is never retained.
  assert.deepEqual(row('gold').volatility, { symbol: 'GVZ', label: 'Cboe Gold ETF Volatility', value: null, regimeKey: 'GVZ', unavailable: true });
  assert.equal(row('ust10y').volatility.symbol, 'MOVE');
  assert.equal(row('copper').volatility, null);
  // A last-verified display reading (MOVE while its refresh is delayed) keeps its value and its own date.
  const delayed = buildSetupBoard({ volatility: { MOVE: { lastPx: 101.103, dayChangePct: -1.35, fifteenDayChangePct: -3.32,
    monthChangePct: 25.24, availability: 'reference', freshness: 'refresh-delayed', asOf: '2026-10-16T20:17:30.000Z' } } });
  assert.deepEqual(delayed.rows.find((item) => item.id === 'ust10y').volatility, { symbol: 'MOVE', label: 'ICE BofA MOVE Index',
    value: 101.103, changePct: -1.35, d15: -3.32, m1: 25.24, asOf: '2026-10-16T20:17:30.000Z', regimeKey: 'MOVE' });
  assert.deepEqual(board.sections.map((section) => section.label), ['Metals', 'Crypto', 'Oil', 'Indices', 'Rates', 'CPI']);
});

test('a price from a different instrument than its range is withheld, never positioned', () => {
  const board = buildSetupBoard({
    riskRanges: { ranges: { SILVER: { lrr: 58, hrr: 62, trend: 'BEARISH' }, BITCOIN: { lrr: 80816, hrr: 87011, trend: 'BULLISH' } } },
    hedgai: { book: { rows: [{ ticker: 'SLV', position: 'Short', publicationDate: '2026-10-08' }] } },
    // IBKR resolves bare SI/BTC to unrelated stocks; the catalog requests explicit symbols.
    quotes: { 'SI=F': { price: 18.02 }, 'BTC-USD': { price: 82638 } },
  });
  const silver = board.rows.find((row) => row.id === 'silver');
  assert.equal(silver.price, null);
  assert.equal(silver.position, null);
  assert.deepEqual(silver.priceRejected, { symbol: 'SI=F', value: 18.02 });
  assert.equal(silver.setup.side, null);
  assert.equal(Math.round(board.rows.find((row) => row.id === 'bitcoin').position * 100), 29);
});

test('adds the US Dollar Index and each market USD correlation for the section drivers', () => {
  const board = buildSetupBoard({
    riskRanges: { ranges: { DXY: { lrr: 101.4, hrr: 102.58, trend: 'BULLISH', date: '2026-10-12' } } },
    quotes: { 'DX-Y.NYB': { price: '102.47', changePercent: '0.25', observedAt: '2026-10-12T14:59:28.000Z' } },
    usdCorrelations: { calculationDate: '2026-10-09', correlations: { GOLD: { '15D': -0.839, '30D': -0.9, '60D': -0.81, '90D': -0.764 } } },
    usdPeriods: { fifteenDayChangePct: 1.99, monthChangePct: 3.15 },
    hedgai: { book: { rows: [{ ticker: 'UUP', position: 'Buy', publicationDate: '2026-10-06' }] } },
  });
  assert.deepEqual(board.usd, { label: 'US Dollar Index', value: 102.47, changePct: 0.25, d15: 1.99, m1: 3.15, asOf: '2026-10-12T14:59:28.000Z',
    trend: 'BULLISH', low: 101.4, high: 102.58, rangeDate: '2026-10-12', trade: null,
    tick: { position: 'Buy', ticker: 'UUP', inverse: false, fit: 'proxy', direction: 'BULLISH', date: '2026-10-06', status: null } });
  const gold = board.rows.find((row) => row.id === 'gold');
  assert.deepEqual(gold.usdCorrelation, { key: 'GOLD', d15: -0.839, d30: -0.9, d60: -0.81, d90: -0.764, calculationDate: '2026-10-09' });
  assert.equal(board.rows.find((row) => row.id === 'ust2y').usdCorrelation, null);
});

test('CPI lists every nowcast month from the current Kalshi release, with N/A when Kalshi has not listed it', () => {
  const board = buildSetupBoard({
    nowcast: { data: { forecasts: [
      { reportMonth: '2026-08', scenarios: { lower: 3.5, base: 3.6, upper: 3.7 } },
      { reportMonth: '2026-09', scenarios: { lower: 3.63, base: 3.74, upper: 3.85 } },
      { reportMonth: '2026-10', scenarios: { lower: 3.69, base: 3.8, upper: 3.91 } },
    ] } },
    eventsBySeries: { KXCPIYOY: [{ event_ticker: 'KXCPIYOY-26SEP' }, { event_ticker: 'KXCPIYOY-26NOV' }] },
  });
  const cpi = board.rows.find((row) => row.id === 'cpi');
  assert.deepEqual(cpi.forecasts.map((row) => [row.reportMonth, row.base, row.eventTicker]),
    [['2026-09', 3.74, 'KXCPIYOY-26SEP'], ['2026-10', 3.8, null]]);
});

test('CPI shows the newest nowcast month before Kalshi lists it, and drops months BLS already released', () => {
  const board = buildSetupBoard({
    asOf: '2026-10-15T13:00:00Z',
    nowcast: { publishedAt: '2026-10-14T13:29:20+00:00', data: { forecasts: [
      { reportMonth: '2026-09', releaseAt: '2026-10-14T12:30:00Z', scenarios: { lower: 3.6, base: 3.7, upper: 3.8 } },
      { reportMonth: '2026-10', releaseAt: '2026-11-10T13:30:00Z', publishedAt: '2026-10-14T13:29:16+00:00',
        scenarios: { lower: '3.69', base: '3.8', upper: '3.91' } },
    ] } },
    eventsBySeries: { KXCPIYOY: [{ event_ticker: 'KXCPIYOY-26NOV' }, { event_ticker: 'KXCPIYOY-26DEC' }] },
  });
  const cpi = board.rows.find((row) => row.id === 'cpi');
  assert.deepEqual(cpi.forecasts.map((row) => [row.reportMonth, row.available, row.base, row.eventTicker]),
    [['2026-10', true, 3.8, null], ['2026-11', false, undefined, 'KXCPIYOY-26NOV']]);
  assert.equal(cpi.forecasts[0].publishedAt, '2026-10-14T13:29:16+00:00');
});

test('Risk Ranges and Crypto Quant sources carry the email send time, not the midnight placeholder', () => {
  const board = buildSetupBoard({
    riskRanges: { publishedAt: '2026-10-15T11:37:00.000Z', manifest: { publicationDate: '2026-10-15' } },
    cryptoQuant: { date: '2026-10-15', publishedAt: '2026-10-15T00:00:00+00:00',
      article: { bodyText: 'HEDGEYE … 10/15/2026 07:40 AM EDT …' } },
  });
  assert.equal(board.sources.riskRanges, '2026-10-15T11:37:00.000Z');
  assert.equal(board.sources.cryptoQuant, '2026-10-15T11:40:00.000Z');
  const { emailPublishedAt } = require('./predictionSetupBoard.cjs');
  assert.equal(emailPublishedAt({ article: { bodyText: '1/15/2026 07:37 AM ET' } }), '2026-01-15T12:37:00.000Z');
  assert.equal(emailPublishedAt({ publishedAt: '2026-10-15T00:00:00+00:00' }), null);
  // Without an email time the board keeps the publication date rather than inventing one.
  assert.equal(buildSetupBoard({ cryptoQuant: { date: '2026-10-15' } }).sources.cryptoQuant, '2026-10-15');
});

test('silver volatility comes from Cboe VXSLV alongside the dashboard volatility snapshot', () => {
  assert.deepEqual(require('./predictionSetupBoard.cjs').extraCboeSeries(), [{ name: 'VXSLV', symbol: 'VXSLV' }]);
  const board = buildSetupBoard({ volatility: { VXSLV: { lastPx: 37.33, dayChangePct: 1.63, fifteenDayChangePct: -4.2,
    monthChangePct: -9.1, availability: 'available', asOf: '2026-10-13T20:00:01.000Z' } } });
  const silver = board.rows.find((row) => row.id === 'silver');
  assert.equal(silver.volatility.value, 37.33);
  assert.equal(silver.volatility.d15, -4.2);
});

test('attaches the market date’s Hedgeye research to each market and the US Dollar', () => {
  const article = (bodyText) => ({ date: '2026-10-16', article: { bodyText } });
  const board = buildSetupBoard({
    riskRanges: { ranges: { UST10Y: { lrr: 5.06, hrr: 5.36, trend: 'BULLISH' }, DXY: { lrr: 101.3, hrr: 102.71, trend: 'BULLISH' } } },
    quotes: { UST10Y: { price: 5.08 }, 'DX-Y.NYB': { price: 101.75 }, 'BTC-USD': { price: 81300 }, QQQ: { price: 718 } },
    cryptoQuant: { date: '2026-10-15', data: { cryptos: { BTC: { buyTrade: 80000, sellTrade: 84000, trend: 'BULLISH' } } } },
    morningSnapshots: {
      'top-3-things': article('RATES – UST 10yr Alpha Code = 5.10/4.76\nUSD – US Dollar Index = Bullish TRADE and TREND'),
      'the-macro-show': article('Bitcoin held approximately $83,000 as trade support and $78,000 as trend support.\nAlpha Code for QQQ = 721/705'),
    },
    marketDate: '2026-10-16',
  });
  const row = (id) => board.rows.find((item) => item.id === id);
  assert.deepEqual({ ...row('ust10y').research.alphaCode, excerpt: undefined, publishedAt: undefined }, {
    trade: 5.1, trend: 4.76, unit: '%', approximate: false, explicit: true, product: 'top-3-things', productLabel: 'Top 3 Things',
    confirmedBy: [], publishedAt: undefined, priceVsTrade: 'below', priceVsTrend: 'above', excerpt: undefined, conflicts: [] });
  assert.equal(row('bitcoin').research.alphaCode.trade, 83000);
  // QQQ's code is checked against QQQ's own price and kept as a labelled proxy, never as NDX.
  assert.equal(row('nasdaq100').research.alphaCode, undefined);
  assert.equal(row('nasdaq100').research.findings[0].instrument, 'QQQ');
  assert.deepEqual(row('gold').research, { findings: [] });
  assert.equal(board.usd.research.findings[0].trade, 'Bullish');
  // Yesterday's Crypto Quant is not this morning's product.
  assert.equal(board.research.products.find((item) => item.key === 'crypto-quant').status, 'missing');
  assert.equal(board.research.products.find((item) => item.key === 'top-3-things').status, 'read');
});

test('boards built without the morning products keep their original shape', () => {
  const board = buildSetupBoard({ marketDate: '2026-10-16' });
  assert.equal('research' in board, false);
  assert.equal(board.rows.some((row) => 'research' in row), false);
});

test('the loader reads the market date’s products and reports them as their own source', async () => {
  const requested = [];
  const empty = () => Promise.resolve(null);
  const load = createSetupBoardLoader({
    loadRiskRanges: empty, loadCryptoQuant: empty, loadHedgai: empty, loadSecurityIntelligence: empty, loadNowcast: empty,
    loadQuotes: (symbols) => { requested.push(...symbols); return Promise.resolve({}); },
    loadVolatility: empty, loadUsdCorrelations: empty, loadKalshiEvents: () => Promise.resolve([]),
    loadMorningProducts: ({ marketDate, products }) => {
      requested.push(`${marketDate}:${products.join(',')}`);
      return Promise.resolve({ 'top-3-things': { date: marketDate, article: { bodyText: 'UST 10yr Alpha Code = 5.10/4.76' } } });
    },
    marketDateFor: () => '2026-10-16',
  });
  const board = await load({ now: new Date('2026-10-16T15:00:00Z') });
  assert.ok(requested.includes('2026-10-16:top-3-things,early-look,the-macro-show,the-call,real-time-alert,etf-pro,market-structure,risk-ranges'));
  // ETF prices are requested so proxy levels can be checked.
  assert.ok(requested.includes('QQQ') && requested.includes('GLD'));
  assert.equal(board.sourceStatus.morningResearch, 'ready');
  assert.equal(board.rows.find((row) => row.id === 'ust10y').research.findings[0].kind, 'alphaCode');
});

test('a morning product with no printed send time shows when the dashboard read it', () => {
  const board = buildSetupBoard({ marketDate: '2026-10-16', morningSnapshots: {
    'market-structure': { date: '2026-10-16', publishedAt: '2026-10-16T00:00:00+00:00', scrapedAt: '2026-10-16T10:30:29+00:00',
      data: { signals: [{ label: 'SPX Gamma Exposure', value: 'Neutral', tone: 'neutral' }] } } } });
  assert.equal(board.research.products.find((item) => item.key === 'market-structure').publishedAt, '2026-10-16T10:30:29+00:00');
});

const publications = (ticker, days) => days.map(([date, lrr, hrr]) => ({ date, ranges: { [ticker]: { lrr, hrr } } }));

test('counts consecutive higher lows and lower highs of the Risk Range, ending today', () => {
  const board = buildSetupBoard({
    riskRanges: { ranges: { WTIC: { lrr: 94.33, hrr: 102.97, trend: 'BULLISH', date: '2026-10-21' } } },
    quotes: { 'CL=F': { price: 97.51 } },
    riskRangeHistory: publications('WTIC', [['2026-10-14', 88.94, 97.34], ['2026-10-15', 89.11, 97.18],
      ['2026-10-16', 89.44, 99.97], ['2026-10-19', 93.64, 104.21], ['2026-10-20', 94.09, 103.17]]),
    allTimeHighs: { 'CL=F': { value: 147.27, date: '2008-07-11', symbol: 'CL=F' } },
  });
  const { structure } = board.rows.find((row) => row.id === 'wti');
  assert.equal(board.structureSessions, 10);
  assert.equal(structure.sessions, 5);
  assert.deepEqual(structure.low, { steps: '+++++', direction: 1, run: 5 });
  assert.deepEqual(structure.high, { steps: '-++--', direction: -1, run: 2 });
  assert.deepEqual(structure.allTimeHigh, { value: 147.27, date: '2008-07-11', symbol: 'CL=F', rangeTopAbove: false });
});

test('an unchanged range neither adds to nor ends a run, and history stops at ten sessions', () => {
  const weekdays = ['09-25', '09-28', '09-29', '09-30', '10-01', '10-02', '10-05', '10-06', '10-07', '10-08', '10-09',
    '10-12', '10-13', '10-14'];
  const days = weekdays.map((day, index) => [`2026-${day}`, 100 + index, 110 + index]);
  days[12] = ['2026-10-13', 111, 121];
  // A Saturday publication would break both runs if it were counted.
  days.push(['2026-10-10', 90, 200]);
  const board = buildSetupBoard({
    riskRanges: { ranges: { BRENT: { lrr: 114, hrr: 123, trend: 'BULLISH', date: '2026-10-15' } } },
    riskRangeHistory: publications('BRENT', days),
  });
  const { structure } = board.rows.find((row) => row.id === 'brent');
  // The ten weekday publications before today (Oct 1–14) plus today's range give ten comparisons.
  assert.equal(structure.sessions, 10);
  assert.equal(structure.since, '2026-10-01');
  assert.equal(structure.high.steps, '+++++++=+=');
  assert.equal(structure.high.run, 8);
  assert.equal(structure.low.steps, '+++++++=++');
  assert.equal(structure.low.run, 9);
});

test('the range top above the instrument all-time high is flagged; Ethereum reads Crypto Quant history', () => {
  const board = buildSetupBoard({
    riskRanges: { ranges: { SPX: { lrr: 7616, hrr: 7850, trend: 'BULLISH', date: '2026-10-21' } } },
    cryptoQuant: { date: '2026-10-21', data: { cryptos: { ETH: { buyTrade: 2345, sellTrade: 2516, trend: 'NEUTRAL' } } } },
    riskRangeHistory: publications('SPX', [['2026-10-20', 7613, 7859]]),
    // A weekend snapshot is never a session.
    cryptoQuantHistory: [{ date: '2026-10-18', data: { cryptos: { ETH: { buyTrade: 2000, sellTrade: 3000 } } } },
      { date: '2026-10-20', data: { cryptos: { ETH: { buyTrade: 2350, sellTrade: 2500 } } } },
      { date: '2026-10-21', data: { cryptos: { ETH: { buyTrade: 2345, sellTrade: 2516 } } } }],
    allTimeHighs: { '^GSPC': { value: 7844.52, date: '2026-10-06' } },
  });
  const spx = board.rows.find((row) => row.id === 'sp500').structure;
  assert.equal(spx.allTimeHigh.rangeTopAbove, true);
  assert.deepEqual([spx.low.steps, spx.high.steps], ['+', '-']);
  const eth = board.rows.find((row) => row.id === 'ethereum').structure;
  assert.deepEqual([eth.sessions, eth.low.steps, eth.high.steps, eth.allTimeHigh], [1, '-', '+', null]);
});

test('boards built without range history keep their original shape', () => {
  const board = buildSetupBoard({ riskRanges: { ranges: { SPX: { lrr: 7616, hrr: 7850, date: '2026-10-21' } } } });
  assert.equal('structureSessions' in board, false);
  assert.equal(board.rows.some((row) => 'structure' in row), false);
});

test('the loader asks for publications before the board’s own and the all-time high of each range instrument', async () => {
  const calls = {};
  const empty = () => Promise.resolve(null);
  const load = createSetupBoardLoader({
    loadRiskRanges: () => Promise.resolve({ manifest: { publicationDate: '2026-10-21' },
      ranges: { DXY: { lrr: 101.45, hrr: 102.59, date: '2026-10-21' } } }),
    loadCryptoQuant: empty, loadHedgai: empty, loadSecurityIntelligence: empty, loadNowcast: empty,
    loadQuotes: () => Promise.resolve({}), loadVolatility: empty, loadUsdCorrelations: empty,
    loadKalshiEvents: () => Promise.resolve([]),
    loadRiskRangeHistory: (args) => { calls.history = args; return Promise.resolve(publications('DXY', [['2026-10-20', 101.43, 102.64]])); },
    loadCryptoQuantHistory: () => Promise.reject(new Error('down')),
    loadAllTimeHighs: (symbols) => { calls.symbols = symbols; return Promise.resolve({}); },
    marketDateFor: () => '2026-10-21',
  });
  const board = await load({ now: new Date('2026-10-21T20:00:00Z') });
  assert.equal(calls.history.before, '2026-10-21');
  assert.equal(calls.history.sessions, 10);
  assert.ok(calls.symbols.includes('^IXIC') && calls.symbols.includes('DX-Y.NYB') && !calls.symbols.includes('^NDX'));
  assert.deepEqual([board.usd.structure.low.steps, board.usd.structure.high.steps], ['+', '-']);
  assert.equal(board.sourceStatus.cryptoQuantHistory, 'failed');
  assert.equal(board.rows.find((row) => row.id === 'ethereum').structure, null);
});

test('an earlier research date reads only that day’s products, its own Crypto Quant, and the current ranges and prices', async () => {
  const calls = { skipped: [] };
  const skipped = (name) => () => { calls.skipped.push(name); return Promise.resolve(null); };
  const load = createSetupBoardLoader({
    loadRiskRanges: () => Promise.resolve({ ranges: { DXY: { lrr: 101.45, hrr: 102.59, date: '2026-10-23' } } }),
    loadCryptoQuant: () => Promise.resolve({ date: '2026-10-23' }), loadQuotes: () => Promise.resolve({}),
    loadHedgai: skipped('hedgai'), loadSecurityIntelligence: skipped('securityIntelligence'), loadNowcast: skipped('nowcast'),
    loadVolatility: skipped('volatility'), loadUsdCorrelations: skipped('usdCorrelations'), loadKalshiEvents: skipped('kalshi'),
    loadVolumeHistory: skipped('volume'), loadRiskRangeHistory: skipped('rangeHistory'),
    loadMorningProducts: (args) => { calls.morning = args; return Promise.resolve({}); },
    marketDateFor: () => '2026-10-23',
  });
  const board = await load({ now: new Date('2026-10-23T20:00:00Z'), researchDate: '2026-10-21' });
  assert.equal(calls.morning.marketDate, '2026-10-21');
  assert.ok(calls.morning.products.includes('crypto-quant'));
  assert.deepEqual(calls.skipped, []);
  assert.equal(board.research.marketDate, '2026-10-21');
  // Without a stored Crypto Quant for that day, today's is not read as that day's.
  assert.equal(board.research.products.find((product) => product.key === 'crypto-quant').status, 'missing');
});

// Weekday sessions back from a date, oldest first, each with a volume and close.
const sessions = (last, volumes) => {
  const dates = [];
  for (const day = new Date(`${last}T12:00:00Z`); dates.length < volumes.length; day.setUTCDate(day.getUTCDate() - 1)) {
    if (day.getUTCDay() % 6 !== 0) dates.unshift(day.toISOString().slice(0, 10));
  }
  return dates.map((date, index) => ({ date, volume: volumes[index], rawClose: 100 + index }));
};

test('volume compares the latest completed session with the prior one and its 15-, 30- and 90-calendar-day averages', () => {
  // 70 sessions at 100, then the 21 before the latest at 200 (the last 30 calendar days), then the latest at 150.
  const bars = sessions('2026-10-21', [...Array(70).fill(100), ...Array(21).fill(200), 150]);
  // A session still trading (no close yet) is not the latest.
  bars.push({ date: '2026-10-22', volume: 10, rawClose: null });
  const board = buildSetupBoard({ volumeHistory: { IBIT: bars, SPY: [] },
    riskRanges: { ranges: { BITCOIN: { lrr: 80000, hrr: 84000, trend: 'BULLISH', date: '2026-10-21' } } } });
  const { volume } = board.rows.find((row) => row.id === 'bitcoin');
  assert.deepEqual(board.volumeWindows, { d15: 15, d30: 30, d90: 90 });
  assert.equal(volume.symbol, 'IBIT');
  assert.equal(volume.date, '2026-10-21');
  assert.equal(Math.round(volume.d1), -25);
  assert.equal(Math.round(volume.d15), -25);
  assert.equal(Math.round(volume.d30), -25);
  // 90 calendar days reach back 64 sessions: 21 at 200 and 43 at 100.
  assert.equal(Math.round(volume.d90), Math.round((150 / ((21 * 200 + 43 * 100) / 64) - 1) * 100));
  // Up day in a Bullish Trend on lighter volume: DV, neither supporting nor warning.
  assert.deepEqual(volume.signal, { move: 'DV', tone: null, direction: 'up' });
  assert.equal(board.rows.find((row) => row.id === 'sp500').volume, null);
});

test('a move against the Trend on decelerating volume supports adding; on accelerating volume it warns', () => {
  const down = (volumes) => sessions('2026-10-21', volumes).map((bar, index, all) => ({ ...bar, rawClose: 200 - index - (index === all.length - 1 ? 5 : 0) }));
  const board = buildSetupBoard({
    riskRanges: { ranges: { WTIC: { lrr: 94, hrr: 103, trend: 'BULLISH', date: '2026-10-21' },
      SILVER: { lrr: 53, hrr: 58, trend: 'BEARISH', date: '2026-10-21' } } },
    volumeHistory: { USO: down([...Array(30).fill(100), 140]), SLV: sessions('2026-10-21', [...Array(30).fill(100), 60]) },
  });
  assert.deepEqual(board.rows.find((row) => row.id === 'wti').volume.signal, { move: 'AV', tone: 'warns', direction: 'down' });
  assert.deepEqual(board.rows.find((row) => row.id === 'silver').volume.signal, { move: 'DV', tone: 'supports', direction: 'up' });
});

test('the loader asks for each market ETF and the Dollar’s UUP volume; boards without it keep their shape', async () => {
  let requested = null;
  const empty = () => Promise.resolve(null);
  const load = createSetupBoardLoader({
    loadRiskRanges: empty, loadCryptoQuant: empty, loadHedgai: empty, loadSecurityIntelligence: empty, loadNowcast: empty,
    loadQuotes: () => Promise.resolve({}), loadVolatility: empty, loadUsdCorrelations: empty, loadKalshiEvents: () => Promise.resolve([]),
    loadVolumeHistory: (symbols) => { requested = symbols; return Promise.reject(new Error('down')); },
    marketDateFor: () => '2026-10-21',
  });
  const board = await load({ now: new Date('2026-10-21T20:00:00Z') });
  assert.deepEqual(requested, ['GLD', 'SLV', 'CPER', 'USO', 'BNO', 'IBIT', 'ETHA', 'SPY', 'QQQ', 'SHY', 'IEF', 'TLT', 'UUP']);
  assert.equal(board.sourceStatus.volumeHistory, 'failed');
  assert.equal(board.rows.find((row) => row.id === 'gold').volume, null);
  assert.equal('volume' in buildSetupBoard({}).rows[0], false);
});

test('a bond ETF falling is its yield rising, so in a Bullish yield Trend it is not a pullback', () => {
  const falling = sessions('2026-10-21', [...Array(30).fill(100), 60]).map((bar, index) => ({ ...bar, rawClose: 200 - index }));
  const board = buildSetupBoard({
    riskRanges: { ranges: { UST2Y: { lrr: 4.71, hrr: 4.87, trend: 'BULLISH', date: '2026-10-21' },
      UST30Y: { lrr: 5.36, hrr: 5.67, trend: 'BEARISH', date: '2026-10-21' } } },
    volumeHistory: { SHY: falling, TLT: falling },
  });
  assert.deepEqual(board.rows.find((row) => row.id === 'ust2y').volume.signal, { move: 'DV', tone: null, direction: 'up' });
  assert.deepEqual(board.rows.find((row) => row.id === 'ust30y').volume.signal, { move: 'DV', tone: 'supports', direction: 'up' });
  assert.equal(board.rows.find((row) => row.id === 'ust2y').volume.inverse, true);
});
