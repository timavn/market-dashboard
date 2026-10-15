const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSetupBoard, evaluateSetup, selectEvents } = require('./predictionSetupBoard.cjs');

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

test('silver volatility comes from Cboe VXSLV alongside the dashboard volatility snapshot', () => {
  assert.deepEqual(require('./predictionSetupBoard.cjs').extraCboeSeries(), [{ name: 'VXSLV', symbol: 'VXSLV' }]);
  const board = buildSetupBoard({ volatility: { VXSLV: { lastPx: 37.33, dayChangePct: 1.63, fifteenDayChangePct: -4.2,
    monthChangePct: -9.1, availability: 'available', asOf: '2026-10-13T20:00:01.000Z' } } });
  const silver = board.rows.find((row) => row.id === 'silver');
  assert.equal(silver.volatility.value, 37.33);
  assert.equal(silver.volatility.d15, -4.2);
});
