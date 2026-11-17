const test = require('node:test');
const assert = require('node:assert/strict');
const { alphaCodeBreaks, buildSetupBoard, createSetupBoardLoader, evaluateSetup, selectEvents } = require('./predictionSetupBoard.cjs');

const rule = { bottomThird: 0.3333, topThird: 0.6667 };
const tick = (direction) => ({ direction });

const trade = (direction) => ({ direction });

test('long requires a Bullish Trend and Trade in the bottom third of the range', () => {
  assert.equal(evaluateSetup({ trend: 'BULLISH', trade: trade('BULLISH'), position: 0.2 }, rule).side, 'LONG');
  assert.equal(evaluateSetup({ trend: 'BULLISH', trade: trade('BULLISH'), position: 0.5 }, rule).side, null);
  assert.equal(evaluateSetup({ trend: 'BULLISH', trade: trade('NEUTRAL'), position: 0.2 }, rule).side, null);
  assert.equal(evaluateSetup({ trend: 'BULLISH', trade: trade('BEARISH'), position: 0.2 }, rule).side, null);
  // No published Trade, no setup.
  assert.equal(evaluateSetup({ trend: 'BULLISH', trade: null, position: 0.2 }, rule).side, null);
});

test('short requires a Bearish Trend and Trade in the top third of the range', () => {
  assert.equal(evaluateSetup({ trend: 'BEARISH', trade: trade('BEARISH'), position: 0.9 }, rule).side, 'SHORT');
  assert.equal(evaluateSetup({ trend: 'BEARISH', trade: trade('BEARISH'), position: 0.4 }, rule).side, null);
});

test('Tick is not part of the setup: it only adjusts the size', () => {
  const long = { trend: 'BULLISH', trade: trade('BULLISH'), position: 0.1 };
  assert.equal(evaluateSetup({ ...long, tick: tick('BEARISH') }, rule).side, 'LONG');
  assert.equal(evaluateSetup({ ...long, tick: null }, rule).side, 'LONG');
});

test('prices outside the range never qualify', () => {
  assert.deepEqual(evaluateSetup({ trend: 'BULLISH', trade: trade('BULLISH'), position: -0.1 }, rule),
    { side: null, reason: 'Below range' });
  assert.deepEqual(evaluateSetup({ trend: 'BEARISH', trade: trade('BEARISH'), position: 1.2 }, rule),
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
  // Bullish Trend and Tick at the low end of the range, but no published Trade: no setup.
  assert.equal(row('bitcoin').setup.side, null);
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

test('a product with nothing yet today carries its newest edition received, for Sources only', async () => {
  const empty = () => Promise.resolve(null);
  const asked = [];
  const options = {
    loadRiskRanges: empty, loadCryptoQuant: empty, loadHedgai: empty, loadSecurityIntelligence: empty, loadNowcast: empty,
    loadQuotes: () => Promise.resolve({}), loadVolatility: empty, loadUsdCorrelations: empty, loadKalshiEvents: () => Promise.resolve([]),
    loadMorningProducts: ({ marketDate }) => Promise.resolve({ 'top-3-things': { date: marketDate, article: { bodyText: '' } } }),
    loadLatestEditions: ({ products }) => {
      asked.push(...products);
      return Promise.resolve({ 'the-macro-show': { date: '2026-11-09', article: { bodyText: '11/09/2026 10:25 AM EST\nGold UST 10yr Alpha Code = 5.10/4.76' } },
        'early-look': { date: '2026-11-10', article: { bodyText: '11/10/2026 07:00 AM EST' } } });
    },
    marketDateFor: () => '2026-11-10',
  };
  const board = await createSetupBoardLoader(options)({ now: new Date('2026-11-10T13:00:00Z') });
  const product = (key) => board.research.products.find((item) => item.key === key);
  assert.equal(asked.includes('top-3-things'), false);
  assert.equal(product('the-macro-show').status, 'missing');
  assert.equal(product('the-macro-show').latestEdition, '2026-11-09T15:25:00.000Z');
  // Its text is not read as today's research.
  assert.deepEqual(board.rows.find((row) => row.id === 'ust10y').research.findings, []);
  // An edition dated today that arrived after the morning read waits for the next read.
  assert.equal('latestEdition' in product('early-look'), false);
  // An earlier day's board is left as it was.
  const earlier = await createSetupBoardLoader(options)({ now: new Date('2026-11-10T13:00:00Z'), researchDate: '2026-11-06' });
  assert.equal(earlier.research.products.some((item) => 'latestEdition' in item), false);
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
  assert.deepEqual(volume.signal, { move: 'DV', tone: null, direction: 'up', side: 'with' });
  assert.equal(board.rows.find((row) => row.id === 'sp500').volume, null);
});

test('against the Trend, decelerating volume supports adding and accelerating volume warns; with it, accelerating confirms', () => {
  const down = (volumes) => sessions('2026-10-21', volumes).map((bar, index, all) => ({ ...bar, rawClose: 200 - index - (index === all.length - 1 ? 5 : 0) }));
  const board = buildSetupBoard({
    riskRanges: { ranges: { WTIC: { lrr: 94, hrr: 103, trend: 'BULLISH', date: '2026-10-21' },
      SILVER: { lrr: 53, hrr: 58, trend: 'BEARISH', date: '2026-10-21' }, GLD: { lrr: 380, hrr: 400, trend: 'BULLISH', date: '2026-10-21' },
      COPPER: { lrr: 5, hrr: 5.5, trend: 'BEARISH', date: '2026-10-21' }, BRENT: { lrr: 60, hrr: 70, date: '2026-10-21' } } },
    volumeHistory: { USO: down([...Array(30).fill(100), 140]), SLV: sessions('2026-10-21', [...Array(30).fill(100), 60]),
      GLD: sessions('2026-10-21', [...Array(30).fill(100), 140]), CPER: down([...Array(30).fill(100), 140]),
      BNO: sessions('2026-10-21', [...Array(30).fill(100), 140]) },
  });
  const signal = (id) => board.rows.find((row) => row.id === id).volume.signal;
  assert.deepEqual(signal('wti'), { move: 'AV', tone: 'warns', direction: 'down', side: 'against' });
  assert.deepEqual(signal('silver'), { move: 'DV', tone: 'supports', direction: 'up', side: 'against' });
  assert.deepEqual(signal('gold'), { move: 'AV', tone: 'confirms', direction: 'up', side: 'with' });
  assert.deepEqual(signal('copper'), { move: 'AV', tone: 'confirms', direction: 'down', side: 'with' });
  // Without a Trend there is no side to read the volume for.
  assert.deepEqual(signal('brent'), { move: 'AV', tone: null, direction: 'up', side: null });
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
  assert.deepEqual(board.rows.find((row) => row.id === 'ust2y').volume.signal, { move: 'DV', tone: null, direction: 'up', side: 'with' });
  assert.deepEqual(board.rows.find((row) => row.id === 'ust30y').volume.signal, { move: 'DV', tone: 'supports', direction: 'up', side: 'against' });
  assert.equal(board.rows.find((row) => row.id === 'ust2y').volume.inverse, true);
});

// Twenty weekday closes before Oct 26: 100 and 102 alternating (mean 101, sample SD ~1.026).
const twentyCloses = () => Array.from({ length: 30 }, (_, index) => new Date(Date.UTC(2026, 8, 20 + index)))
  .filter((day) => day.getUTCDay() % 6 !== 0).map((day) => day.toISOString().slice(0, 10))
  .filter((date) => date < '2026-10-26').slice(-20).map((date, index) => ({ date, close: index % 2 ? 102 : 100 }));

test('each market and the Dollar carry a Z-score against the 20 daily closes before the quote’s day', () => {
  const history = twentyCloses();
  const board = buildSetupBoard({
    quotes: { 'GC=F': { price: '104', timestamp: '2026-10-26T14:00:00Z' }, 'DX-Y.NYB': { price: '101', observedAt: '2026-10-26T14:00:00Z' } },
    // A bar on the quote's own day is its unfinished session, never part of the window.
    priceHistory: { 'GC=F': [...history, { date: '2026-10-26', close: 500 }], 'DX-Y.NYB': history },
  });
  const gold = board.rows.find((row) => row.id === 'gold').zScore;
  assert.equal(gold.sessions, 20);
  assert.equal(gold.through, history.at(-1).date);
  assert.ok(Math.abs(gold.value - 3 / Math.sqrt(20 / 19)) < 1e-9);
  assert.equal(board.usd.zScore.value, 0);
  // Fewer than 20 closes, or no price, reads unavailable rather than a short-window score.
  assert.equal(board.rows.find((row) => row.id === 'silver').zScore, null);
  assert.equal('zScore' in buildSetupBoard({}).rows[0], false);
});

test('CPI carries the survey consensus for each month, null until it is published', () => {
  const board = buildSetupBoard({
    asOf: '2026-10-15T13:00:00Z',
    nowcast: { data: { forecasts: [
      { reportMonth: '2026-10', releaseAt: '2026-11-10T13:30:00Z', scenarios: { lower: 3.69, base: 3.8, upper: 3.91 } },
      { reportMonth: '2026-11', releaseAt: '2026-12-10T13:30:00Z', scenarios: { lower: 3.7, base: 3.85, upper: 4 } },
    ] } },
    cpiConsensus: { observedAt: '2026-10-15T12:00:00.000Z', releases: [{ reportMonth: '2026-10', consensus: 3.7 }] },
  });
  const cpi = board.rows.find((row) => row.id === 'cpi');
  assert.deepEqual(cpi.forecasts.map((row) => [row.reportMonth, row.consensus]), [['2026-10', 3.7], ['2026-11', null]]);
  assert.equal(board.sources.cpiConsensus, '2026-10-15T12:00:00.000Z');
  const saved = buildSetupBoard({ nowcast: { data: { forecasts: [{ reportMonth: '2026-10', scenarios: { lower: 3.69, base: 3.8, upper: 3.91 } }] } } });
  assert.equal('consensus' in saved.rows.find((row) => row.id === 'cpi').forecasts[0], false);
});

test('the loader asks for each market’s own price history and the CPI consensus; failures read unavailable', async () => {
  let requested = null;
  const empty = () => Promise.resolve(null);
  const load = createSetupBoardLoader({
    loadRiskRanges: empty, loadCryptoQuant: empty, loadHedgai: empty, loadSecurityIntelligence: empty, loadNowcast: empty,
    loadQuotes: () => Promise.resolve({}), loadVolatility: empty, loadUsdCorrelations: empty, loadKalshiEvents: () => Promise.resolve([]),
    loadPriceHistory: (symbols) => { requested = symbols; return Promise.reject(new Error('down')); },
    loadCpiConsensus: () => Promise.reject(new Error('down')),
    marketDateFor: () => '2026-10-21',
  });
  const board = await load({ now: new Date('2026-10-21T20:00:00Z') });
  assert.deepEqual(requested, ['GC=F', 'SI=F', 'HG=F', 'CL=F', 'BZ=F', 'BTC-USD', 'ETH-USD', '^GSPC', '^NDX', 'UST2Y', 'UST10Y', 'UST30Y', 'DX-Y.NYB']);
  assert.equal(board.sourceStatus.priceHistory, 'failed');
  assert.equal(board.sourceStatus.cpiConsensus, 'failed');
  assert.equal(board.rows.find((row) => row.id === 'gold').zScore, null);
});

test('Trade comes from what the morning products state: yields from the shared projection, metals from their spot reference', () => {
  const { extractPublishedStatements } = require('../utils/publishedResearchSignals.cjs');
  const { buildSecurityIntelligenceV2 } = require('../utils/securityIntelligenceV2.cjs');
  const earlyLook = {
    date: '2026-11-02', snapshotType: 'early-look', source: 'gmail-html', publishedAt: '2026-11-02T00:00:00+00:00',
    htmlSource: 'hedgeye-email/messages/2026-11-02/early-look/original.html',
    article: { feedUrl: 'https://app.hedgeye.com/feed_items/189309', bodyText: [
      '11/02/2026 07:27 AM EST',
      'Gold remains Bearish TRADE and TREND, so we’ll see when we get The Signal to go bullish in #Quad4',
      'UST 2yr Yield down -11 basis points last week to Signal Bearish TRADE, but Bullish TREND',
      'UST 30yr Yield down -3 basis points last week and already signaling Bearish TRADE and TREND',
    ].join('\n') },
  };
  const statements = extractPublishedStatements(earlyLook);
  const stamp = (reading) => ({ ...reading, sourceProduct: 'early-look', sourceLabel: 'Early Look', qualityStatus: 'validated' });
  const securityIntelligence = buildSecurityIntelligenceV2({ symbols: ['UST2Y', 'UST30Y', 'GLD', 'GOLD'], marketDate: '2026-11-02', historyDays: 0,
    now: new Date('2026-11-02T16:00:00Z'), publishedTradeReadings: statements.trade.map(stamp) });
  const board = buildSetupBoard({ securityIntelligence, marketDate: '2026-11-02',
    publishedStatements: { references: statements.references.map(stamp), trends: [], alphaCodes: [] } });
  const trade = (id) => board.rows.find((row) => row.id === id).trade;
  assert.deepEqual([trade('ust2y').direction, trade('ust2y').date, trade('ust2y').source], ['BEARISH', '2026-11-02', 'Early Look']);
  assert.equal(trade('ust30y').direction, 'BEARISH');
  assert.equal(trade('ust10y'), null, 'nothing published for the 10-year');
  assert.deepEqual([trade('gold').direction, trade('gold').ticker, trade('gold').reference], ['BEARISH', 'GOLD', true]);
  // Each Trade keeps its edition's send time (07:27 AM EST), so Sources can show it.
  assert.equal(trade('gold').publishedAt, '2026-11-02T12:27:00.000Z');
  assert.equal(trade('ust2y').publishedAt, '2026-11-02T12:27:00.000Z');
  // Gold spot never becomes the Trade of GOLD (the listed company) or the GLD ETF.
  assert.equal(securityIntelligence.bySymbol.GOLD?.lastVerifiedDecision?.trade?.value ?? null, null);
  assert.equal(securityIntelligence.bySymbol.GLD?.lastVerifiedDecision?.trade?.value ?? null, null);
  assert.equal(trade('silver'), null);
});

test('a published Trade or Trend whose Alpha Code line the price crossed since reads Neutral, keeping the call it replaced', () => {
  const line = (duration, level, side, since) => ({ id: `CL=F|${duration}`, symbol: 'CL=F', duration, level, side, since, price: 95.57,
    priceAt: '2026-11-03T14:45:00Z', product: 'top-3-things', productLabel: 'Top 3 Things', breaks: [] });
  const watch = { lines: { 'CL=F|trade': line('trade', 97, 'below', '2026-11-02T16:22:35Z'), 'CL=F|trend': line('trend', 91, 'above', '2026-11-02T13:57:43Z') } };
  const trade = { direction: 'BULLISH', ticker: 'WTIC', date: '2026-10-21', source: 'The Call', sourceUrl: 'https://app.hedgeye.com/feed_items/188678' };
  const broken = alphaCodeBreaks(watch, 'CL=F', { trade, trend: 'BULLISH', trendDate: '2026-11-03' });
  assert.deepEqual([broken.trade.direction, broken.trade.date, broken.trade.source, broken.trend], ['NEUTRAL', '2026-11-02', 'Alpha Code 97', 'BULLISH']);
  assert.deepEqual(broken.alphaBreaks.trade, { level: 97, side: 'below', since: '2026-11-02T16:22:35Z', price: 95.57, priceAt: '2026-11-03T14:45:00Z',
    product: 'top-3-things', productLabel: 'Top 3 Things', published: { value: 'BULLISH', date: '2026-10-21', source: 'The Call' } });
  // The break is dated by the crossing; the replaced call keeps its send time.
  const timed = alphaCodeBreaks(watch, 'CL=F', { trade: { ...trade, publishedAt: '2026-10-21T12:25:00.000Z' }, trend: 'BULLISH', trendDate: '2026-11-03' });
  assert.equal(timed.trade.publishedAt, null);
  assert.equal(timed.alphaBreaks.trade.published.publishedAt, '2026-10-21T12:25:00.000Z');
  // No watch, or a price on the call's side, leaves the call.
  assert.deepEqual(alphaCodeBreaks(null, 'CL=F', { trade, trend: 'BULLISH' }), { trade, trend: 'BULLISH' });
  assert.equal(alphaCodeBreaks({ lines: { 'CL=F|trade': { ...watch.lines['CL=F|trade'], side: 'above' } } }, 'CL=F', { trade }).trade, trade);

  // On the board a broken Trend reads Neutral.
  const board = (alphaCodeWatch) => buildSetupBoard({ alphaCodeWatch, quotes: { 'CL=F': { price: 90.2 } },
    riskRanges: { ranges: { WTIC: { lrr: 89.5, hrr: 104, trend: 'BULLISH', date: '2026-11-03' } } } }).rows.find((row) => row.id === 'wti');
  const crossed = { lines: { 'CL=F|trend': line('trend', 91, 'below', '2026-11-03T15:00:00Z') } };
  assert.equal(board(null).trend, 'BULLISH');
  const wti = board(crossed);
  assert.equal(wti.trend, 'NEUTRAL');
  assert.deepEqual(wti.alphaBreaks.trend.published, { value: 'BULLISH', date: '2026-11-03', source: 'Risk Ranges' });
});

const goldShort = {
  riskRanges: { ranges: { GLD: { lrr: 3900, hrr: 4000, trend: 'BEARISH', date: '2026-11-10' },
    DXY: { lrr: 99, hrr: 101, trend: 'BULLISH', date: '2026-11-10' } } },
  quotes: { 'GC=F': { price: 3995 }, 'DX-Y.NYB': { price: 100 } },
  hedgai: { book: { rows: [{ ticker: 'GLD', position: 'Short', publicationDate: '2026-11-10' }] } },
  usdCorrelations: { calculationDate: '2026-11-09', correlations: { GOLD: { '30D': -0.8 } } },
  volatility: { GVZ: { availability: 'available', lastPx: 28, weekChangePct: 2 } },
  marketDate: '2026-11-11',
};
// Gold's published spot Trade, as the morning products state it.
const goldTrade = (() => {
  const { extractPublishedStatements } = require('../utils/publishedResearchSignals.cjs');
  const statements = extractPublishedStatements({ date: '2026-11-10', snapshotType: 'early-look', source: 'gmail-html',
    publishedAt: '2026-11-10T00:00:00+00:00', htmlSource: 'hedgeye-email/messages/2026-11-10/early-look/original.html',
    article: { feedUrl: 'https://app.hedgeye.com/feed_items/1', bodyText: '11/10/2026 07:27 AM EST\nGold remains Bearish TRADE and TREND' } });
  return { references: statements.references.map((reading) => ({ ...reading, sourceProduct: 'early-look', sourceLabel: 'Early Look',
    qualityStatus: 'validated' })), trends: [], alphaCodes: [] };
})();
goldShort.publishedStatements = goldTrade;

test('a setup in a ladder market is sized; other rows are not', () => {
  const board = buildSetupBoard(goldShort);
  const gold = board.rows.find((row) => row.id === 'gold');
  assert.equal(gold.setup.side, 'SHORT');
  assert.equal(gold.trade.direction, 'BEARISH');
  // Base 3 + dollar 1 (−0.8 correlation, dollar Bullish) + Tick 0.5 (Bearish); volume and Z-score have no reading.
  assert.equal(gold.sizing.pct, 4.5);
  assert.deepEqual(gold.sizing.components.filter((item) => item.missing).map((item) => item.key), ['volume', 'zScore']);
  assert.equal(board.rows.find((row) => row.id === 'silver').sizing, undefined);
  assert.deepEqual([board.sizing.basePct, board.sizing.maxPct], [3, 5.5]);
  // Without the published Trade there is no setup, whatever Tick says.
  assert.equal(buildSetupBoard({ ...goldShort, publishedStatements: undefined }).rows.find((row) => row.id === 'gold').setup.side, null);
});

test('the loader splits a sized setup across its Kalshi lines and the account', async () => {
  const empty = () => Promise.resolve(null);
  const asked = [];
  const quote = (strike, yes) => ({ ticker: `KXGOLDD-26NOV1117-T${strike}`, floor_strike: strike, strike_type: 'greater',
    yes_bid_dollars: String(yes - 0.01), yes_ask_dollars: String(yes + 0.01), no_bid_dollars: String(1 - yes - 0.01),
    no_ask_dollars: String(1 - yes + 0.01), yes_ask_size_fp: '500.00', yes_bid_size_fp: '500.00' });
  const options = {
    loadRiskRanges: () => Promise.resolve(goldShort.riskRanges), loadCryptoQuant: empty, loadHedgai: () => Promise.resolve(goldShort.hedgai),
    loadSecurityIntelligence: empty, loadNowcast: empty, loadQuotes: () => Promise.resolve(goldShort.quotes),
    loadVolatility: () => Promise.resolve(goldShort.volatility), loadUsdCorrelations: () => Promise.resolve(goldShort.usdCorrelations),
    loadPublishedStatements: () => Promise.resolve(goldTrade),
    loadKalshiEvents: (series) => Promise.resolve(series === 'KXGOLDD' ? [{ event_ticker: 'KXGOLDD-26NOV1117' }]
      : series === 'KXGOLDW' ? [{ event_ticker: 'KXGOLDW-26NOV1317' }] : []),
    loadKalshiMarkets: (event) => { asked.push(event); return Promise.resolve([quote(3960, 0.84), quote(3980, 0.69), quote(4000, 0.5),
      quote(4020, 0.31), quote(4040, 0.16)]); },
    loadKalshiBalance: () => Promise.resolve({ balance_dollars: '5000.00', portfolio_value: 100000 }),
    marketDateFor: () => '2026-11-11',
  };
  const board = await createSetupBoardLoader(options)({ now: new Date('2026-11-11T16:00:00Z') });
  const { sizing } = board.rows.find((row) => row.id === 'gold');
  // The setup's daily and weekly events are each read once.
  assert.deepEqual(asked.sort(), ['KXGOLDD-26NOV1117', 'KXGOLDW-26NOV1317']);
  assert.equal(sizing.event, 'KXGOLDD-26NOV1117');
  assert.equal(sizing.account.value, 6000);
  // Short from 4,000 with the range low at 3,900 (3,905 on the ladder): NO on the 17¢ line one move below the price takes
  // the 500 contracts at its ask, and the nearer 32¢ line takes what it can of the rest.
  assert.deepEqual(sizing.lines.map((line) => [line.strike, line.buy, line.zone, line.contracts]),
    [[3960, 'NO', 'target', 500], [3980, 'NO', 'near', 500]]);
  assert.ok(sizing.lines.every((line) => line.capped && line.ask <= 0.5));
  assert.ok(sizing.spentPct < sizing.pct && Math.abs(sizing.spentPct + sizing.unspentPct - sizing.pct) < 1e-9);
  assert.ok(Math.abs(sizing.ladder.centre - 4000) < 2);
  assert.ok(Math.abs(sizing.rangeLimit - 3905) < 3);
  // The weekly event gets its own ticket for the same position.
  assert.equal(sizing.weekly.event, 'KXGOLDW-26NOV1317');
  assert.equal(sizing.weekly.lines.length, 2);
  assert.equal(board.sourceStatus.kalshiLines, 'ready');
  // A failed line read keeps the size and says so; no balance leaves shares of the account only.
  const failed = await createSetupBoardLoader({ ...options, loadKalshiMarkets: () => Promise.reject(new Error('down')) })({ now: new Date('2026-11-11T16:00:00Z') });
  assert.equal(failed.rows.find((row) => row.id === 'gold').sizing.reason, 'Kalshi lines unavailable');
  assert.equal(failed.sourceStatus.kalshiLines, 'failed');
  const noAccount = await createSetupBoardLoader({ ...options, loadKalshiBalance: () => Promise.reject(new Error('no keys')) })({ now: new Date('2026-11-11T16:00:00Z') });
  const lines = noAccount.rows.find((row) => row.id === 'gold').sizing;
  assert.equal(lines.account, null);
  assert.ok(lines.lines.every((line) => line.contracts === undefined && line.pct > 0));
});

test('the loader adds every market\'s Kalshi lines, checks held lines and adds the Kalshi book, reading each event once', async () => {
  const empty = () => Promise.resolve(null);
  const asked = [];
  const quote = (event, strike, yes) => ({ ticker: `${event}-T${strike}`, floor_strike: strike, strike_type: 'greater',
    close_time: '2026-11-11T22:00:00Z', yes_bid_dollars: String(yes - 0.01), yes_ask_dollars: String(yes + 0.01),
    no_bid_dollars: String(1 - yes - 0.01), no_ask_dollars: String(1 - yes + 0.01) });
  const ladderFor = (event) => [quote(event, 3960, 0.84), quote(event, 3980, 0.69), quote(event, 4000, 0.5), quote(event, 4020, 0.31),
    quote(event, 4040, 0.16)];
  const options = {
    loadRiskRanges: () => Promise.resolve(goldShort.riskRanges), loadCryptoQuant: empty, loadHedgai: () => Promise.resolve(goldShort.hedgai),
    loadSecurityIntelligence: empty, loadNowcast: empty, loadQuotes: () => Promise.resolve(goldShort.quotes),
    loadVolatility: () => Promise.resolve(goldShort.volatility), loadUsdCorrelations: () => Promise.resolve(goldShort.usdCorrelations),
    loadKalshiEvents: (series) => Promise.resolve(series === 'KXGOLDD' ? [{ event_ticker: 'KXGOLDD-26NOV1117' }] : []),
    loadKalshiMarkets: (event) => { asked.push(event); return Promise.resolve(ladderFor(event)); },
    loadKalshiBalance: () => Promise.resolve({ balance_dollars: '5000.00', portfolio_value: 100000 }),
    loadKalshiPositions: () => Promise.resolve({ market_positions: [
      { ticker: 'KXGOLDD-26NOV1117-T4020', position_fp: '-100', market_exposure_dollars: '70' },
      { ticker: 'KXGOLDW-26NOV1317-T4000', position_fp: '50', market_exposure_dollars: '25' }], event_positions: [] }),
    marketDateFor: () => '2026-11-11',
  };
  const board = await createSetupBoardLoader(options)({ now: new Date('2026-11-11T16:00:00Z') });
  assert.deepEqual(asked.sort(), ['KXGOLDD-26NOV1117', 'KXGOLDW-26NOV1317']);
  const gold = board.rows.find((row) => row.id === 'gold').kalshiLines;
  // No Trade is published, so there is no setup: the row is unshaded and shows its ladder.
  assert.equal(board.rows.find((row) => row.id === 'gold').setup.side, null);
  assert.equal(gold.shade, null);
  assert.equal(gold.shadeReason, 'No Trade');
  assert.equal(gold.lines.side, null);
  assert.equal(gold.lines.lines.length, 5);
  assert.ok(Math.abs(gold.summary.centre - 4000) < 1);
  // Held lines from the daily and the weekly event both land on Gold.
  assert.deepEqual(gold.held.map((line) => line.ticker).sort(), ['KXGOLDD-26NOV1117-T4020', 'KXGOLDW-26NOV1317-T4000']);
  // The row is unshaded, so the held weekly line reads Unshaded.
  assert.equal(gold.held.find((line) => line.ticker === 'KXGOLDW-26NOV1317-T4000').state, 'SETUP_LAPSED');
  assert.equal(board.kalshiBook.atRisk, 95);
  assert.equal(board.kalshiBook.account, 6000);
  assert.equal(board.sourceStatus.kalshiPositions, 'ready');
  // Without positions the board keeps its graded lines but carries no book.
  const noPositions = await createSetupBoardLoader({ ...options, loadKalshiPositions: () => Promise.reject(new Error('down')) })(
    { now: new Date('2026-11-11T16:00:00Z') });
  assert.equal(noPositions.kalshiBook, undefined);
  assert.ok(noPositions.rows.find((row) => row.id === 'gold').kalshiLines.lines.lines.length > 0);
  assert.equal(noPositions.sourceStatus.kalshiPositions, 'failed');
});

test('the loader reads order books for lines near even odds and prices each market\'s bet through them', async () => {
  const empty = () => Promise.resolve(null);
  const quote = (event, strike, yes) => ({ ticker: `${event}-T${strike}`, floor_strike: strike, strike_type: 'greater',
    close_time: '2026-11-11T22:00:00Z', yes_bid_dollars: String(yes - 0.01), yes_ask_dollars: String(yes + 0.01),
    no_bid_dollars: String(1 - yes - 0.01), no_ask_dollars: String(1 - yes + 0.01) });
  const read = [];
  const options = {
    loadRiskRanges: () => Promise.resolve(goldShort.riskRanges), loadCryptoQuant: empty, loadHedgai: () => Promise.resolve(goldShort.hedgai),
    loadSecurityIntelligence: empty, loadNowcast: empty, loadQuotes: () => Promise.resolve(goldShort.quotes),
    loadVolatility: () => Promise.resolve(goldShort.volatility), loadUsdCorrelations: () => Promise.resolve(goldShort.usdCorrelations),
    loadPublishedStatements: () => Promise.resolve(goldTrade),
    loadKalshiEvents: (series) => Promise.resolve(series === 'KXGOLDD' ? [{ event_ticker: 'KXGOLDD-26NOV1117' }] : []),
    loadKalshiMarkets: (event) => Promise.resolve([quote(event, 3960, 0.84), quote(event, 3980, 0.69), quote(event, 4000, 0.5),
      quote(event, 4020, 0.31), quote(event, 4040, 0.16), quote(event, 4300, 0.01)]),
    loadKalshiBalance: () => Promise.resolve({ balance_dollars: '6000.00', portfolio_value: 0 }),
    loadKalshiPositions: () => Promise.resolve({ market_positions: [], event_positions: [] }),
    loadKalshiOrderbook: (ticker) => { read.push(ticker); return Promise.resolve({ yes_dollars: [['0.30', '10000']], no_dollars: [['0.30', '10000']] }); },
    marketDateFor: () => '2026-11-11',
  };
  const load = createSetupBoardLoader(options);
  const board = await load({ now: new Date('2026-11-11T16:00:00Z') });
  // The 1¢ line is outside 3–97% and is never read.
  assert.deepEqual(read.map((ticker) => ticker.split('-T')[1]).sort(), ['3960', '3980', '4000', '4020', '4040']);
  const row = board.rows.find((item) => item.id === 'gold');
  const lines = row.kalshiLines.lines;
  // Gold is sized by the board, so its bet is its sized % of the $6,000 account.
  assert.equal(lines.bet, Math.round(6000 * row.sizing.pct) / 100);
  assert.ok(lines.lines.filter((line) => line.checked).length === 5);
  assert.equal(board.sourceStatus.kalshiOrderbooks, 'ready');
  // Within the cache window nothing is read again.
  await load({ now: new Date('2026-11-11T16:00:20Z') });
  assert.equal(read.length, 5);
  await load({ now: new Date('2026-11-11T16:01:00Z') });
  assert.equal(read.length, 10);
  // Books that cannot be read leave the lines on their top-of-book quotes.
  const failed = await createSetupBoardLoader({ ...options, loadKalshiOrderbook: () => Promise.reject(new Error('429')) })(
    { now: new Date('2026-11-11T16:00:00Z') });
  assert.equal(failed.sourceStatus.kalshiOrderbooks, 'failed');
  assert.equal(failed.rows.find((item) => item.id === 'gold').kalshiLines.lines.bet, null);
});
