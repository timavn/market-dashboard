const test = require('node:test');
const assert = require('node:assert/strict');
const { buildMorningResearch, extractFromText, positionFindings, structuredFindings } = require('./predictionMorningResearch.cjs');

const references = { gold: 4190, silver: 57.5, copper: 6.6, wti: 92, bitcoin: 81300, ethereum: 2430, sp500: 7700, nasdaq100: 29500,
  compq: 26400, ust2y: 4.8, ust10y: 5.08, ust30y: 5.42, usd: 101.7, QQQ: 718, SPY: 770 };
const codes = (text, refs = references) => extractFromText(text, { product: 'top-3-things', references: refs })
  .filter((item) => item.kind === 'alphaCode')
  .map(({ market, instrument, trade, trend }) => ({ market, instrument, trade, trend }));
const kinds = (text, kind) => extractFromText(text, { product: 'the-macro-show', references }).filter((item) => item.kind === kind);

test('reads Alpha Codes printed as A/B, with yields and thousands separators', () => {
  assert.deepEqual(codes('RATES – Curve flattening again; UST 10yr Alpha Code = 5.10/4.76'),
    [{ market: 'ust10y', instrument: null, trade: 5.1, trend: 4.76 }]);
  assert.deepEqual(codes('He clarified the S&P Alpha Code is 7,695 / 7,501 , meaning bearish trade / bullish trend.'),
    [{ market: 'sp500', instrument: null, trade: 7695, trend: 7501 }]);
});

test('splits run-together codes and expands shorthand against the live price', () => {
  assert.deepEqual(codes('OIL – Breakout in motion with WTI’s Alpha Code = 9188 (TRADE $91, TREND $88)'),
    [{ market: 'wti', instrument: null, trade: 91, trend: 88 }]);
  assert.deepEqual(codes('For Gold, the Alpha Code this morning = 41804120 so TRADE is the one to watch.'),
    [{ market: 'gold', instrument: null, trade: 4180, trend: 4120 }]);
  assert.deepEqual(codes('Bitcoin has an Alpha Code of 83/78 (83k = TRADE, 78k = TREND), so I bought more.'),
    [{ market: 'bitcoin', instrument: null, trade: 83000, trend: 78000 }]);
});

test('pairs TRADE and TREND levels stated in prose, including the next sentence', () => {
  assert.deepEqual(codes('Bitcoin stayed a small long with bearish trade but bullish trend . He named approximately $83,000 as trade support and $78,000 as trend support.'),
    [{ market: 'bitcoin', instrument: null, trade: 83000, trend: 78000 }]);
  assert.deepEqual(codes('The ten-year yield’s trade/trend reference levels were 5.10%/4.76% .'),
    [{ market: 'ust10y', instrument: null, trade: 5.1, trend: 4.76 }]);
  assert.deepEqual(codes('Gold’s immediate TRADE level cited was 4,210, with TREND at 4,120.'),
    [{ market: 'gold', instrument: null, trade: 4210, trend: 4120 }]);
  assert.deepEqual(codes('oil put TRADE and TREND at $90 on both fronts, a rare alignment.'),
    [{ market: 'wti', instrument: null, trade: 90, trend: 90 }]);
  assert.deepEqual(codes('WTI signaled lower-highs and a TRADE breakdown below $92.\nAlpha Code = 92/88 so WTI needs $88 to hold.'),
    [{ market: 'wti', instrument: null, trade: 92, trend: 88 }]);
});

test('reads a roster of codes after "TRADE first, then TREND"', () => {
  const text = 'The Code = TRADE first, then TREND so here are the big ones: SPX = 7751/7601\nQQQ = 721/705\nUST 10yr = 5.10/4.76\nUST 2yr = 4.85/4.40';
  assert.deepEqual(codes(text), [
    { market: 'sp500', instrument: null, trade: 7751, trend: 7601 },
    { market: 'nasdaq100', instrument: 'QQQ', trade: 721, trend: 705 },
    { market: 'ust10y', instrument: null, trade: 5.1, trend: 4.76 },
    { market: 'ust2y', instrument: null, trade: 4.85, trend: 4.4 },
  ]);
});

test('never credits another instrument’s code to a tracked market', () => {
  // Brent is not WTI; KOSPI and NVDA are not the S&P; an ETF needs its own price to check.
  assert.deepEqual(codes('Brent, meanwhile, is still Bullish TRADE and TREND with an Alpha Code = 99/93 ($99 = TRADE, $93 = TREND)'), []);
  assert.deepEqual(codes('Dr. KOSPI failed its TRADE (Alpha Code for KOSPI = 68/71)'), []);
  assert.deepEqual(codes('NVDA lifted SPY’s +0.7% return, breaking out to Bullish TRADE and TREND with an Alpha Code = 217208'), []);
  assert.deepEqual(codes('Alpha Code for QQQ = 720705 (TRADE = 720, TREND = 705)', { ...references, QQQ: undefined }), []);
  // Levels that no scale places near the market's price are not its levels.
  assert.deepEqual(codes('Silver’s Alpha Code = 1218'), []);
});

test('skips historical and hypothetical levels', () => {
  assert.deepEqual(codes('Last week the Gold Alpha Code was 4300/4200.'), []);
  assert.deepEqual(codes('Hypothetically, a WTI Alpha Code of 95/90 would change that.'), []);
});

test('keeps single TRADE or TREND levels, prose Risk Ranges and stated directions', () => {
  const singles = extractFromText('RATES – UST 2yr holding TRADE/TREND Signal Supports (TREND all the way down at 4.40%)',
    { product: 'top-3-things', references });
  assert.deepEqual(singles.map(({ kind, market, level }) => ({ kind, market, level })), [{ kind: 'trendLevel', market: 'ust2y', level: 4.4 }]);
  const ranges = kinds('Gold’s Risk Range™ Signal = 4100-4220 this morning', 'riskRange');
  assert.deepEqual(ranges.map(({ market, low, high }) => ({ market, low, high })), [{ market: 'gold', low: 4100, high: 4220 }]);
  const signals = kinds('US Dollar Index = Bullish TRADE and TREND\nBitcoin remained long with bearish trade but bullish trend .', 'signal');
  assert.deepEqual(signals.map(({ market, trade, trend }) => ({ market, trade, trend })),
    [{ market: 'usd', trade: 'Bullish', trend: 'Bullish' }, { market: 'bitcoin', trade: 'Bearish', trend: 'Bullish' }]);
  const both = kinds('USD is a Buy; neither the UST 2yr Signal nor the Oil Signal changed – both are Bullish TRADE and TREND', 'signal');
  assert.deepEqual(both.map(({ market }) => market).sort(), ['ust2y', 'wti']);
});

test('maps published positions and structured product data to markets', () => {
  const macro = positionFindings({ data: { longs: ['U.S. Dollar (USD)', 'Bitcoin (BTC)', 'Invesco QQQ Trust (QQQ)', 'Japan (JPXN)'],
    shorts: ['British Pound versus U.S. Dollar (GBP/USD)'] } }, 'the-macro-show');
  assert.deepEqual(macro.map(({ market, side, instrument }) => ({ market, side, instrument })), [
    { market: 'usd', side: 'Long', instrument: null },
    { market: 'bitcoin', side: 'Long', instrument: null },
    { market: 'nasdaq100', side: 'Long', instrument: 'QQQ' },
  ]);
  const early = structuredFindings({ data: { 'GOLD SPOT PRICE (GOLD)': { lrr: 4090, hrr: 4216, trend: 'BEARISH' },
    'NASDAQ COMPOSITE (COMPQ)': { lrr: 26514, hrr: 27621, trend: 'BULLISH' }, HYG: { lrr: 79, hrr: 80 } } }, 'early-look');
  assert.deepEqual(early.map(({ market, instrument, low, trend }) => ({ market, instrument, low, trend })), [
    { market: 'gold', instrument: null, low: 4090, trend: 'Bearish' },
    { market: 'nasdaq100', instrument: 'COMPQ', low: 26514, trend: 'Bullish' },
  ]);
  const changes = structuredFindings({ trendChanges: [{ ticker: 'COPPER', oldTrend: 'NEUTRAL', newTrend: 'BULLISH' }, { ticker: 'TSLA' }] },
    'risk-ranges', { riskRangeTickers: { COPPER: 'copper' } });
  assert.deepEqual(changes.map(({ market, from, to }) => ({ market, from, to })), [{ market: 'copper', from: 'Neutral', to: 'Bullish' }]);
});

test('summarises each market with the highest-priority Alpha Code and the price against it', () => {
  const article = (bodyText) => ({ date: '2026-10-16', article: { bodyText } });
  const research = buildMorningResearch({
    marketDate: '2026-10-16', references, prices: { ust10y: 5.08, bitcoin: 81300 },
    snapshots: {
      'top-3-things': article('RATES – UST 10yr Alpha Code = 5.10/4.76\nRATES – TREND for the UST 10yr Yield is 4.76%'),
      'the-macro-show': article('The ten-year yield’s trade/trend reference levels were 5.10%/4.76% .\nBitcoin held approximately $83,000 as trade support and $78,000 as trend support.'),
      'early-look': { date: '2026-10-15', article: { bodyText: 'UST 10yr Alpha Code = 5.20/4.80' } },
    },
  });
  assert.equal(research.products.find((item) => item.key === 'early-look').status, 'missing');
  const ust10y = research.markets.ust10y;
  assert.deepEqual({ trade: ust10y.alphaCode.trade, trend: ust10y.alphaCode.trend, product: ust10y.alphaCode.productLabel,
    confirmedBy: ust10y.alphaCode.confirmedBy, priceVsTrade: ust10y.alphaCode.priceVsTrade, priceVsTrend: ust10y.alphaCode.priceVsTrend },
  { trade: 5.1, trend: 4.76, product: 'Top 3 Things', confirmedBy: ['The Macro Show'], priceVsTrade: 'below', priceVsTrend: 'above' });
  // A single level its own product's code already prints is not repeated.
  assert.equal(ust10y.findings.some((item) => item.kind === 'trendLevel'), false);
  assert.equal(research.markets.bitcoin.alphaCode.approximate, true);
  assert.equal(research.markets.bitcoin.alphaCode.priceVsTrade, 'below');
});
