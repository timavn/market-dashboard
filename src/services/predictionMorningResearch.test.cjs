const test = require('node:test');
const assert = require('node:assert/strict');
const { PROXY_TICKERS, buildMorningResearch, extractFromText, positionFindings, structuredFindings } = require('./predictionMorningResearch.cjs');

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
  // Brent is its own market, never WTI; KOSPI and NVDA are not the S&P; an ETF needs its own price to check.
  assert.deepEqual(codes('Brent, meanwhile, is still Bullish TRADE and TREND with an Alpha Code = 99/93 ($99 = TRADE, $93 = TREND)'),
    [{ market: 'brent', instrument: null, trade: 99, trend: 93 }]);
  assert.deepEqual(kinds('Brent Oil is still Bullish TRADE and TREND', 'signal').map(({ market }) => market), ['brent']);
  // Natural Gas is its own market, never Oil's.
  assert.deepEqual(kinds('Oil is Bearish TREND while Natural Gas is still Bullish TRADE and TREND', 'signal').map(({ market }) => market).sort(),
    ['natgas', 'wti']);
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
  assert.deepEqual(macro.map(({ market, side, instrument, inverse }) => ({ market, side, instrument, inverse })), [
    { market: 'usd', side: 'Long', instrument: null, inverse: false },
    { market: 'bitcoin', side: 'Long', instrument: null, inverse: false },
    { market: 'nasdaq100', side: 'Long', instrument: 'QQQ', inverse: false },
    // A short pound against the dollar is a dollar position that moves opposite to the dollar.
    { market: 'usd', side: 'Short', instrument: 'GBP/USD', inverse: true },
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

test('published data carries the line or list the product printed it in as its source', () => {
  const [usd] = positionFindings({ data: { longs: ['U.S. Dollar (USD)'], rawLongsText: 'U.S. Dollar (USD), Software (IGV),' } }, 'the-macro-show');
  assert.equal(usd.sourceText, 'Longs: U.S. Dollar (USD), Software (IGV)');
  const [alert] = positionFindings({ data: { alerts: [{ action: 'BUY', ticker: 'UUP',
    headline: 'Real-Time Alert: Macro Buy Signal (USD, Rates, QQQ): US Dollar (UUP) -KM' }] } }, 'real-time-alert');
  assert.equal(alert.sourceText, 'Real-Time Alert: Macro Buy Signal (USD, Rates, QQQ): US Dollar (UUP) -KM');
  const [gold] = structuredFindings({ data: { 'GOLD SPOT PRICE (GOLD)': { lrr: 4090, hrr: 4216, trend: 'BEARISH', originalName: 'Gold Spot Price (GOLD)' } },
    article: { bodyText: 'Our Levels\nGold Spot Price (GOLD) 4090-4216 (bearish)\nBest of luck' } }, 'early-look');
  assert.equal(gold.sourceText, 'Our Levels: Gold Spot Price (GOLD) 4090-4216 (bearish)');
  const [copper] = structuredFindings({ trendChanges: [{ ticker: 'COPPER', oldTrend: 'NEUTRAL', newTrend: 'BULLISH' }],
    article: { bodyText: 'TREND CHANGE: \n\n COPPER changed from Neutral to Bullish \n\n TSLA changed from Neutral to Bearish' } },
  'risk-ranges', { riskRangeTickers: { COPPER: 'copper' } });
  assert.equal(copper.sourceText, 'Trend change: COPPER changed from Neutral to Bullish');
  // Without the email text, the change reads from its own data.
  const [bare] = structuredFindings({ trendChanges: [{ ticker: 'COPPER', oldTrend: 'NEUTRAL', newTrend: 'BULLISH' }] },
    'risk-ranges', { riskRangeTickers: { COPPER: 'copper' } });
  assert.equal(bare.sourceText, 'Trend change: COPPER changed from Neutral to Bullish');
});

test('summarises each market with the highest-priority Alpha Code and the price against it', () => {
  const article = (bodyText) => ({ date: '2026-10-16', article: { bodyText } });
  const research = buildMorningResearch({
    marketDate: '2026-10-16', references, prices: { ust10y: 5.08, bitcoin: 81300 },
    snapshots: {
      'top-3-things': { ...article('RATES – UST 10yr Alpha Code = 5.10/4.76\nRATES – TREND for the UST 10yr Yield is 4.76%'), gmailMessageId: '1a18ccb24523e419' },
      'the-macro-show': article('The ten-year yield’s trade/trend reference levels were 5.10%/4.76% .\nBitcoin held approximately $83,000 as trade support and $78,000 as trend support.'),
      'early-look': { date: '2026-10-15', article: { bodyText: 'UST 10yr Alpha Code = 5.20/4.80' } },
    },
  });
  assert.equal(research.products.find((item) => item.key === 'early-look').status, 'missing');
  // Each product read names its email, for the Source to show; one from another day names none.
  assert.equal(research.products.find((item) => item.key === 'top-3-things').messageId, '1a18ccb24523e419');
  assert.equal(research.products.find((item) => item.key === 'the-macro-show').messageId, null);
  assert.equal(research.products.find((item) => item.key === 'early-look').messageId, null);
  const ust10y = research.markets.ust10y;
  assert.deepEqual({ trade: ust10y.alphaCode.trade, trend: ust10y.alphaCode.trend, product: ust10y.alphaCode.productLabel,
    confirmedBy: ust10y.alphaCode.confirmedBy, priceVsTrade: ust10y.alphaCode.priceVsTrade, priceVsTrend: ust10y.alphaCode.priceVsTrend },
  { trade: 5.1, trend: 4.76, product: 'Top 3 Things', confirmedBy: ['The Macro Show'], priceVsTrade: 'below', priceVsTrend: 'above' });
  // A single level its own product's code already prints is not repeated.
  assert.equal(ust10y.findings.some((item) => item.kind === 'trendLevel'), false);
  assert.equal(research.markets.bitcoin.alphaCode.approximate, true);
  assert.equal(research.markets.bitcoin.alphaCode.priceVsTrade, 'below');
});

test('every statement naming a market is a mention, with the part of it about that market as context', () => {
  const text = [
    'USD – All the while, USD (UUP) is giving us another Buying Opportunity; neither our Fed Front-Runner (UST 2yr Signal) nor Oil Signal have changed this week – both are Bullish TRADE and TREND',
    'Immediate-term @Hedgeye Risk Ranges : SP500 = 7701-7850; UST 10yr Yield = 5.06-5.36%',
    'BULLISH: U.S. Dollar (USD), Software (IGV), Invesco QQQ Trust (QQQ), Microsoft (MSFT), Bitcoin (BTC).',
    'He also confirmed shorting British pounds against the dollar . (2:11) (16:06)',
    'Gold Spot Price (GOLD) 4090-4216 (bearish)',
  ].join('\n');
  const findings = extractFromText(text, { product: 'top-3-things', references });
  const context = (market, kind) => findings.filter((item) => item.market === market && (!kind || item.kind === kind)).map((item) => item.context);
  // USD states no level or direction here, so it is a mention; the heading "USD –" is dropped.
  assert.deepEqual(context('usd', 'mention'), ['All the while, USD (UUP) is giving us another Buying Opportunity', 'BULLISH: U.S. Dollar (USD)',
    'He also confirmed shorting British pounds against the dollar.']);
  // An unnamed clause continues the markets before it.
  assert.deepEqual(context('ust2y'), ['Neither our Fed Front-Runner (UST 2yr Signal) nor Oil Signal have changed this week – both are Bullish TRADE and TREND']);
  assert.deepEqual(context('ust10y'), ['Immediate-term @Hedgeye Risk Ranges: UST 10yr Yield = 5.06-5.36%']);
  assert.deepEqual(context('bitcoin'), ['BULLISH: Bitcoin (BTC)']);
  // The levels table is read as data, not as a mention.
  assert.deepEqual(context('gold'), []);
  assert.equal(findings.find((item) => item.market === 'usd').excerpt.startsWith('USD – All the while'), true);
});

test('Market Structure carries its chart levels, and its note as the signals source', () => {
  const findings = structuredFindings({ article: { bodyText: 'Market makers remain broadly neutral ahead of today’s options expiration.\n\nThat said, …' },
    data: { signals: [{ label: 'SPX Gamma Exposure', value: 'Neutral', tone: 'neutral' }], chartMetrics: {
      spxProbableVolatilityGamma: { label: 'SPX Probable Volatility / Gamma By Strike', source: 'Intrinio/Tier1Alpha.com', chartDate: '2026-10-15',
        zeroGamma: 7736, lowerPvBand: 7660, upperPvBand: 7886, strikesInPlay: [7700, 7750] },
      spxGammaVolatilityThrottle: { label: 'SPX Gamma Volatility Throttle', source: 'Tier1Alpha.com', chartDate: '2026-10-15',
        gammaThrottle: 0.64, tenDayRealizedVolatility: 9.63 } } } }, 'market-structure');
  const [signals, levels] = findings;
  assert.equal(signals.sourceText, 'Market makers remain broadly neutral ahead of today’s options expiration.');
  assert.deepEqual({ ...levels, sourceText: undefined }, { market: 'sp500', product: 'market-structure', kind: 'structureLevels', zeroGamma: 7736,
    lowerPvBand: 7660, upperPvBand: 7886, strikesInPlay: [7700, 7750], gammaThrottle: 0.64, realizedVolatility: 9.63, fit: 'exact',
    instrument: null, instrumentLabel: null, sourceText: undefined });
  assert.equal(levels.sourceText, 'Read from the SPX Probable Volatility / Gamma By Strike (Intrinio/Tier1Alpha.com, chart 2026-10-15) and '
    + 'SPX Gamma Volatility Throttle (Tier1Alpha.com, chart 2026-10-15) charts');
});

test('the dollar is the currency: a bare "dollar" is not, and currency pairs are dollar instruments', () => {
  const findings = extractFromText([
    'CRYPTO QUANT | ₿TC (+0.7%), MSTR=BULLISH, ETH/CRCL=NEUTRAL, "The Always-On Dollar", Project Shutdowns ↑',
    'He is going to consider merging Tesla with SpaceX, trillion dollar caps.',
    'Bitcoin quoted as BTC/USD keeps its own market.',
    'EUR/USD is Bearish TRADE and TREND.',
    'USD/JPY = Bullish TREND',
    'A stronger dollar weighs on Gold.',
  ].join('\n'), { product: 'top-3-things', references });
  const usd = findings.filter((item) => item.market === 'usd');
  // Neither "The Always-On Dollar", "trillion dollar caps" nor BTC/USD is the dollar.
  assert.deepEqual(usd.map(({ kind, instrumentLabel, context }) => ({ kind, instrumentLabel, context })), [
    { kind: 'signal', instrumentLabel: 'EUR/USD', context: 'EUR/USD is Bearish TRADE and TREND.' },
    { kind: 'signal', instrumentLabel: 'USD/JPY', context: 'USD/JPY = Bullish TREND' },
    { kind: 'mention', instrumentLabel: null, context: 'A stronger dollar weighs on Gold.' },
  ]);
  // Pairs are never quoted; only ETFs are.
  assert.equal(PROXY_TICKERS.includes('UUP'), true);
  assert.equal(PROXY_TICKERS.some((ticker) => ticker.includes('/') || ticker.endsWith('USD')), false);
  // EUR/USD moves opposite to the dollar, so its bearish call is a bullish dollar call.
  assert.deepEqual([usd[0].trade, usd[0].trend], ['Bullish', 'Bullish']);
  assert.deepEqual([usd[1].trade, usd[1].trend], [null, 'Bullish']);
});

test('a long statement is shown in full and keeps the clauses between mentions', () => {
  const long = 'With plenty of AI Bubble Stocks and their Factor Exposures imploding, the mainline of US Equity Vol has, once again, '
    + 'survived a potential trip to what we call The Chop Bucket (VIX > 19) and still has a wicked wide Risk Range Signal = 14.32-19.95, '
    + 'so trade it and remember what happens to dealer Gamma if SPX breaks out of its range to the downside, because that is where the fun starts';
  const [spx] = extractFromText(long, { product: 'top-3-things', references }).filter((item) => item.market === 'sp500');
  assert.equal(spx.excerpt, long);
  assert.equal(spx.context.endsWith('because that is where the fun starts'), true);
  const [qqq] = extractFromText('QQQ – Selling the bounce in QQQ; we keep buying the dips in Healthcare; QQQ TRADE Momentum Resistance Signal = 737',
    { product: 'top-3-things', references }).filter((item) => item.market === 'nasdaq100');
  assert.equal(qqq.context.includes('…'), false);
  assert.equal(qqq.context.includes('we keep buying the dips in Healthcare'), true);
});
