const { test } = require('node:test');
const assert = require('node:assert/strict');
const { researchStatements, claimedValues, sentences } = require('./researchStatements.cjs');

const read = (text) => researchStatements(text).map((item) => `${item.kind === 'reference' ? 'ref:' : ''}${item.ticker}.${item.field}=${
  item.value || [item.levels.trade, item.levels.trend, item.levels.raw].join('/')}`).sort();

// Statements published in Hedgeye products, 2026-08 to 2026-11.
test('reads the signals each publication states, bound to the instrument the clause opens with', () => {
  const cases = [
    ['UST 2yr Yield down -11 basis points last week to Signal Bearish TRADE, but Bullish TREND', ['UST2Y.trade=BEARISH', 'UST2Y.trend=BULLISH']],
    ['UST 30yr Yield down -3 basis points last week and already signaling Bearish TRADE and TREND', ['UST30Y.trade=BEARISH', 'UST30Y.trend=BEARISH']],
    ['US Dollar Index was up +0.1% on the week and remains Bullish on both our TRADE and TREND durations', ['USD.trade=BULLISH', 'USD.trend=BULLISH']],
    ['EUR/USD was down another -0.4% on the week and remains Bearish TRADE and TREND', ['EURUSD.trade=BEARISH', 'EURUSD.trend=BEARISH']],
    ['Gold remains Bearish TRADE and TREND, so we’ll see when we get The Signal to go bullish in #Quad4', ['ref:GOLD.trade=BEARISH', 'ref:GOLD.trend=BEARISH']],
    ['RATES – Bond Yields down; UST 10yr Yield is Bearish TRADE, Neutral TREND (with TREND = 4.91%) after its Risk Range signaled',
      ['UST10Y.alphaCode=/4.91/', 'UST10Y.trade=BEARISH', 'UST10Y.trend=NEUTRAL']],
    ['QQQ – fortunately, we’re not long what the crowd is – QQQ was already signaling Bearish TRADE (so was SPY on Friday)', ['QQQ.trade=BEARISH']],
    ['SPY and QQQ flipped back to Bullish TRADE', ['QQQ.trade=BULLISH', 'SPY.trade=BULLISH']],
    ['Primo Brands (PRMB) and Grocery Outlet (GO) both moved to bullish trade and trend', ['GO.trade=BULLISH', 'GO.trend=BULLISH', 'PRMB.trade=BULLISH', 'PRMB.trend=BULLISH']],
    ['Oil (WTI) was +5.4% last week moving back to Bullish TRADE, Neutral TREND', ['CL.trade=BULLISH', 'CL.trend=NEUTRAL']],
    ['Copper was described as bullish trend but bearish trade', ['ref:COPPER.trade=BEARISH', 'ref:COPPER.trend=BULLISH']],
    ['US Dollar Index down at fresh 3-month lows of $98.77 and signaling lower-lows within its Bearish TREND', ['USD.trend=BEARISH']],
    ['Bitcoin had held trend support around $79,000, but remained bearish on the trade horizon, with lower highs and only marginally bullish trend support.', ['BTC.trade=BEARISH']],
  ];
  for (const [text, expected] of cases) assert.deepEqual(read(text), expected, text);
});

test('the printed instrument wins: an ETF code after an index or commodity name is the ETF', () => {
  assert.deepEqual(read('Russell 2000 (IWM) remains Bearish TRADE and TREND'), ['IWM.trade=BEARISH', 'IWM.trend=BEARISH']);
  assert.deepEqual(read('NASDAQ (QQQ) continues to signal Bearish TREND'), ['QQQ.trend=BEARISH']);
  assert.deepEqual(read('Gold (GLD) is bullish TRADE'), ['GLD.trade=BULLISH']);
  assert.deepEqual(read('Natural Gas (UNG) is a relatively new Bullish TREND Breakout'), ['UNG.trend=BULLISH']);
  // A code the catalog names the same instrument keeps the name's identity.
  assert.deepEqual(read('Gold Spot Price (GOLD) remains Bearish TRADE'), ['ref:GOLD.trade=BEARISH']);
  assert.deepEqual(read('Teucrium Corn Fund (CORN) is bullish TRADE'), ['CORN.trade=BULLISH']);
  // Bare "Oil" is WTI unless the sentence is about Brent.
  assert.deepEqual(read('Oil’s back to signaling Bullish TRADE and TREND'), ['CL.trade=BULLISH', 'CL.trend=BULLISH']);
  assert.deepEqual(read('Oil confirming its Bullish TRADE and TREND with higher 3-month highs signaling for Brent up at $119/barrel'), []);
  for (const text of ['S&P 500 futures are bullish TRADE.', 'Russell 1000 is bullish TRADE.', 'Bitcoin dominance is bullish TRADE.',
    'BTC Dominance is bullish TRADE.', 'Gold Miners remain Bearish TRADE.', 'Euro area PMIs remain bearish TREND.',
    'MOMO Tracker | High Beta Momo=-14.5% W/W, 5/8=BEARISH TREND', 'GOLD - BACK TO BULLISH TREND, BUT POSITION SIZE REMAINS SMALL']) {
    assert.deepEqual(read(text), [], text);
  }
});

// Published 2026-11-10 to 2026-11-13; each was once read as the direction it names.
test('a signal named as missing, required, wanted or almost there states no direction', () => {
  for (const text of [
    'Gold had failed to establish the conditions he requires for a bottom: a higher low in its risk range and a bullish TRADE signal.',
    'WTI remained unable to regain bullish trade and trend, reinforcing Keith’s patience in building bond exposure.',
    'The two-year yield signal returned to bullish trade and trend about two weeks ago, ahead of CPI.',
    'Gold has no bullish TRADE signal.', 'Gold still has no confirmed Bearish TREND.', 'Gold lacks a bullish TRADE signal.',
    'Copper is without a bullish TREND signal.', 'Gold has yet to signal bullish TRADE.', 'Silver is far from bullish TREND.',
    'Gold requires a bullish TRADE signal first.', 'Copper is struggling to hold bullish TREND.', 'SPX is trying to get back to bullish TRADE.',
    'Keith wants Gold bullish TRADE first.', 'Gold is neither bullish TRADE.', 'Gold is almost bullish TRADE and TREND.',
  ]) assert.deepEqual(read(text), [], text);
  // The stated half of a sentence survives its unstated half; words after the claim do not void it.
  assert.deepEqual(read('ONON is signal-strength long, with the stock back to bullish trade and almost bullish trend; the approach is to build'), ['ONON.trade=BULLISH']);
  assert.deepEqual(read('Copper remained bullish on trade and trend, without announcing a copper purchase.'), ['ref:COPPER.trade=BULLISH', 'ref:COPPER.trend=BULLISH']);
  assert.deepEqual(read('Bitcoin’s Alpha Code was roughly 83 / 79 , leaving it bearish trade and barely bullish trend .').filter((item) => /trade|trend/.test(item) && !/\//.test(item)),
    ['BTC.trade=BEARISH', 'BTC.trend=BULLISH']);
});

test('conditional, negated, approaching, attributed, past and superseded statements state no signal', () => {
  for (const text of [
    'If SPY is Bearish TRADE and TREND', 'SPX is not BULLISH TRADE.', 'SPX may be BULLISH TRADE.', 'SPX was previously BULLISH TRADE.',
    'Gold isn’t bullish TRADE.', 'He stressed that the VIX can be Bullish TREND without yet entering the Chop volatility regime.',
    'Copper corrected -2.0% last week and is breaking bad towards Neutral TREND this morning', 'SPY is approaching Bearish TREND.',
    'WHEN US Equity Beta (SPY) Signal is bearish TRADE, I’m a seller of SOME Long Exposure on green too',
    'SPX, according to JPMorgan, is bullish TRADE.', 'Gold back to Bullish TRADE?',
    'SPX is BULLISH TRADE versus BEARISH TRADE last month.', 'SPX was Bullish TRADE last week.', 'SPY also signaled bearish trade on Friday, which is why he sold',
    'Gold was bullish TRADE two weeks ago.', 'Natural Gas moved from bearish TREND to neutral after establishing a higher low',
    'SPY lost its bullish TRADE signal.', 'NVDA’s bullish TRADE signal was invalidated.',
    'Gold was up last week after breaking down to Bearish TRADE and TREND, but is back to Bullish TRADE today',
    'Gold positioning has changed materially: Hedgeye reduced the position when Gold entered bearish trend, then rebuilt it',
    'Gold is bearish TRADE - unless it holds $2,400.', 'If the Fed cuts again - Gold is bullish TRADE and TREND.',
    'Bitcoin and Ethereum sold off on an article, cryptocurrencies remain bullish trend', 'Gold is medium-term TRADE Bearish, with its trend line now in play',
    'Copper continues to trade bearish into the close.', 'Gold remains our favorite bullish trade.', 'SPX is a bullish trade idea.',
    'The US Dollar was down -0.87% continuing its bearish trend', 'Oil, Inflation and the Fed He remained long oil, citing bullish trade and trend',
    'Japanese Yen up another +0.4% to $153.51 vs. USD remains Bullish TRADE and TREND',
    'Amazon.com (AMZN) and Microsoft (MSFT) both flipped to bullish trade-and-trend last week (buy dips)',
    'Gold and Silver: Gold bullish TRADE, Silver bullish TREND.', 'SPY and QQQ are bullish TRADE and bearish TREND respectively.',
  ]) assert.deepEqual(read(text), [], text);
  // A later qualified claim ends the statement without voiding the earlier one.
  assert.deepEqual(read('Gold remains Bearish TRADE and near a possible Bearish TREND confirmation.'), ['ref:GOLD.trade=BEARISH']);
  assert.deepEqual(read('Solana and Ethereum were exited, with Ethereum specifically described as bearish trade and trend'), ['ETH.trade=BEARISH', 'ETH.trend=BEARISH']);
});

test('Alpha Codes keep only levels the publication prints, TRADE first', () => {
  const levels = (text) => researchStatements(text).filter((item) => item.field === 'alphaCode').map((item) => [item.ticker, item.levels]);
  assert.deepEqual(levels('Oil’s (WTI) Alpha Code = 9791 (TRADE = $97, TREND = $91)'), [['CL', { raw: '9791', trade: 97, trend: 91, unit: '$', basis: 'printed-levels' }]]);
  assert.deepEqual(levels('Gold’s Alpha Code was 4355 / 4204'), [['GOLD', { raw: '4355 / 4204', trade: 4355, trend: 4204, unit: null, basis: 'trade-then-trend-code' }]]);
  assert.deepEqual(levels('Bitcoin has an Alpha Code of 81/75 (81k = TRADE, 75k = TREND)'), [['BTC', { raw: '81/75', trade: 81000, trend: 75000, unit: null, basis: 'printed-levels' }]]);
  assert.deepEqual(levels('NVIDIA (NVDA) has an alpha code of 222 on the trade and 211 on the trend'), [['NVDA', { raw: null, trade: 222, trend: 211, unit: null, basis: 'printed-levels' }]]);
  assert.deepEqual(levels('QQQ TRADE Momentum Resistance Signal = 737 and TREND Support has moved to 721'), [['QQQ', { raw: null, trade: 737, trend: 721, unit: null, basis: 'printed-levels' }]]);
  assert.deepEqual(levels('Oil is reflating (again) this morning with an Alpha Code = 8183'), [['CL', { raw: '8183', trade: null, trend: null, unit: null, basis: null }]]);
  // A price location, a past break, a quoted price and an inconsistent code are not levels.
  for (const text of ['UST 2yr Yield back up to bullish TRADE and TREND at 4.75% ahead of today’s Fed meeting',
    'UST 2yr Yield was down -8 basis points on the week after breaking immediate-term TRADE of 4.25%',
    'NVDA continues to trade at $180, near its highs.', 'NVDA shares trade at 30x earnings.',
    'Oil’s Alpha Code = 9791 (TRADE = $95, TREND = $91)', 'Gold Alpha Code = 9791 and Silver TREND = $30.']) {
    assert.deepEqual(levels(text), [], text);
  }
});

test('sentences hold across abbreviations and hard wraps; the claim patterns match the stored text', () => {
  assert.deepEqual(sentences('Netflix (NFLX) and Warner Bros. Discovery (WBD) are both now on bullish trend. Next one.').length, 2);
  assert.deepEqual(read('Gold is bullish TRADE\nif it holds $2,400.'), []);
  // A line ending in "vs." continues, so the Dollar is not the subject of the Yen's statement.
  assert.deepEqual(read('Japanese Yen up another +0.4% to $153.51 vs.\nUSD remains Bullish TRADE and TREND'), []);
  assert.deepEqual(claimedValues('Bearish TRADE, but Bullish TREND', 'trade'), ['BEARISH']);
  assert.deepEqual(claimedValues('SPY TREND Bullish TRADE Bearish', 'trade'), ['BEARISH']);
});

// Second adversarial review.
test('claims with their own second predicate, paired directions and later reversals state nothing they do not say', () => {
  for (const text of ['QQQ is Bearish TRADE and TREND remains Bullish', 'Bitcoin is Bearish TREND and TRADE overbought',
    'SPY TRADE/TREND = Bullish/Bearish', 'SPY is Bullish/Bearish TRADE/TREND', 'SPY is bullish TREND for Gold',
    'oil was the first major topic because WTI briefly moved back to bullish trend, then flipped back to bearish trend during the show',
    'Copper moved back into Bullish TREND, although only marginally, and McCullough said the signal still needs to hold.',
    'Bitcoin’s dominance is bullish TRADE', 'Oil & Gas stocks are bullish TREND', 'BTC=F is bullish TRADE', 'SPY and QQQ are bullish TRADE, except QQQ']) {
    assert.deepEqual(read(text), [], text);
  }
  // A later claim about another market ends the statement and leaves the first one standing.
  assert.deepEqual(read('The U.S. Dollar Index had broken into bearish TRADE and TREND conditions, while the yen had broken into bullish TRADE and TREND.'),
    ['USD.trade=BEARISH', 'USD.trend=BEARISH']);
  assert.deepEqual(read('EUR/USD remains Bearish TREND while European Bond Yields, across The Curve, remain Bullish TREND'), ['EURUSD.trend=BEARISH']);
  assert.deepEqual(read('SPY and QQQ were bearish on trade, but Keith said neither had yet signaled lower highs on trend.'), ['QQQ.trade=BEARISH', 'SPY.trade=BEARISH']);
  assert.deepEqual(read('DOW is bullish TRADE'), ['DOW.trade=BULLISH'], 'an all-caps word is the ticker, not the Dow');
});

test('Alpha Code levels share one scale, and a changed or ranged code is not current', () => {
  const levels = (text) => researchStatements(text).filter((item) => item.field === 'alphaCode').map((item) => [item.levels.trade, item.levels.trend]);
  assert.deepEqual(levels('Bitcoin’s Alpha Code was given as 64/68 : approximately $64,000 TRADE and $68,000 TREND'), [[64000, 68000]]);
  assert.deepEqual(levels('Bitcoin has an Alpha Code of 81/75 (81k = TRADE)'), [[81000, 75000]]);
  assert.deepEqual(levels('Silver’s Alpha Code = 6564 (TRADE $65, TREND $64)'), [[65, 64]]);
  assert.deepEqual(levels('SPY has TRADE and TREND support at 680 and 650'), [[680, 650]]);
  assert.deepEqual(levels('Oil’s Hedgeye AI Alpha Code for WTI = 8082 (TRADE = 80, TREND = 82)'), [[80, 82]]);
  for (const text of ['Oil’s Alpha Code = 9791 (TRADE = $95)', 'Oil’s Alpha Code was 80/82 and is now 83/86',
    'UST 10yr Yield is Bullish on both TRADE and TREND at 4.12%', 'Bitcoin TRADE = 3wks',
    'TSLA remains a buy-the-dips setup above its 370 to 375 TRADE']) {
    assert.deepEqual(levels(text), [], text);
  }
});

test('Alpha Codes named after the phrase, after a dash, or in a roster are read, and the flip line is its own statement', () => {
  const codes = (text) => researchStatements(text).filter((item) => item.field === 'alphaCode').map((item) => [item.ticker, item.levels.raw, item.levels.trade, item.levels.trend]);
  assert.deepEqual(codes('Alpha Code for KOSPI = 6265/7051'), [['KOSPI', '6265/7051', 6265, 7051]]);
  assert.deepEqual(codes('Bitcoin’s Alpha Code was roughly 83 / 79'), [['BTC', '83 / 79', 83, 79]]);
  assert.deepEqual(codes('The Alpha Code for WTI is now 9792 (TRADE = 97, TREND = 92) and, after breaking immediate-term TRADE Signal Support Brent’s TREND Signal Level of $99 is finally in play.'), [['CL', '9792', 97, 92]]);
  assert.deepEqual(codes('SPX – Alpha Code = 77037639 (TRADE number is 1 st , TREND 2 nd ) and if you don’t think The Machine reads numbers that way, think again'), [['SPX', '77037639', null, null]]);
  assert.deepEqual(codes('the Alpha Codes are:\n\nTSLA 370375\n\nSPCX 153143\n\nTSLA = 356-390'), [['TSLA', '370375', null, null], ['SPCX', '153143', null, null]]);
  // A roster row outside a roster is not a code; a changed code is still not current.
  assert.deepEqual(codes('TSLA 370375'), []);
  assert.deepEqual(codes('Oil’s Alpha Code was 80/82 and is now 83/86'), []);
  const flips = (text) => researchStatements(text).filter((item) => item.field === 'flipLine').map((item) => [item.ticker, item.levels.level, item.approximate]);
  assert.deepEqual(flips('Remember what happens to dealer Gamma if SPX breaks out (or fails) at the Tier1 Alpha Gamma Flip Line = 7726.'), [['SPX', 7726, false]]);
  assert.deepEqual(flips('Watch the SPX gamma flip line at 7,726'), [['SPX', 7726, false]]);
  assert.deepEqual(flips('Negative gamma, an S&P 500 gamma flip level near 7,713, and one-month volatility were highlighted'), [['SPX', 7713, true]]);
  for (const text of ['The SPX gamma flip line was 7,700 last week.', 'The NDX gamma flip line is 27000.', 'People are starting to flip this trade at 7000.', 'Our flip line of 7000 stands.']) {
    assert.deepEqual(flips(text), [], text);
  }
});

// Statements the reader skipped until 2026-11-23, each as stored; the board kept older Trade directions.
test('reads a position aside, a lead-in, a while-clause, the curve named after the claim, and a level break', () => {
  const cases = [
    ['Brent Oil (we’re long BNO) continues to signal Bullish TRADE and TREND', ['BZ.trade=BULLISH', 'BZ.trend=BULLISH']],
    ['Obviously, our UST 2yr Yield Signal was already Bullish TRADE - what changed yesterday was the Long End.', ['UST2Y.trade=BULLISH']],
    ['UST 10yr Yield’s Fractal Dimension ( Risk Range™ Signal ) continues to signal lower-highs and Bearish TRADE', ['UST10Y.trade=BEARISH']],
    ['Treasury yields remain bullish on both trade and trend signals across the 2-year, 10-year, and 30-year maturities.',
      ['UST10Y.trade=BULLISH', 'UST10Y.trend=BULLISH', 'UST2Y.trade=BULLISH', 'UST2Y.trend=BULLISH', 'UST30Y.trade=BULLISH', 'UST30Y.trend=BULLISH']],
    ['(8:30-9:22) • Hedgeye is also long Consumer Staples, Utilities and Health Care , giving it four long S&P sectors while the S&P itself is bearish trade and trend.',
      ['SPX.trade=BEARISH', 'SPX.trend=BEARISH']],
    ['He cited the 10-year Treasury yield breaking below Hedgeye’s 5.07% trade signal.', ['UST10Y.trade=BEARISH']],
    ['QQQ remains bearish TRADE while bullish TREND', ['QQQ.trade=BEARISH', 'QQQ.trend=BULLISH']],
  ];
  for (const [text, expected] of cases) assert.deepEqual(read(text).filter((item) => !/alphaCode/.test(item)), expected, text);
  assert.deepEqual(read('UST 10yr is back above TRADE Signal Level of 5.10%'), ['UST10Y.alphaCode=5.1//', 'UST10Y.trade=BULLISH']);
  // The quoted source is the printed span, and it restates the claim on its own.
  const [brent] = researchStatements('Brent Oil (we’re long BNO) continues to signal Bullish TRADE and TREND');
  assert.equal(brent.sourceText, 'Brent Oil (we’re long BNO) continues to signal Bullish TRADE and TREND');
  assert.deepEqual(claimedValues('the 10-year Treasury yield breaking below Hedgeye’s 5.07% trade signal', 'trade'), ['BEARISH']);
});

test('a level break without a side, a past or conditional break, and an untracked maturity state nothing', () => {
  for (const text of [
    'The 10-year yield fell 23 bps last week and broke its immediate-term trade level around 5.06% ; a move below roughly 4.94% would break trend.',
    'If the 10-year subsequently breaks back below trade, Keith said he will become much more aggressive buying bonds.',
    'The 10-year yield has not broken below its trade level',
    'The S&P 500 broke below its trade level yesterday',
    'Treasury yields remain bullish on both trade and trend signals across the 2-year, 20-year, and 30-year maturities.',
    'The last inflation report on 9/11 brought the S&P and Nasdaq to Neutral trend.',
    'The two-year yield signal returned to bullish trade and trend about two weeks ago, ahead of CPI.',
  ]) assert.deepEqual(read(text), [], text);
  assert.deepEqual(read('Gold is bearish trade, while the S&P would need to close above its trade level'), ['ref:GOLD.trade=BEARISH']);
});
