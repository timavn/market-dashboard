const test = require('node:test');
const assert = require('node:assert/strict');
const { allocateLines, fitLadder, invPhi, kalshiAccountValue, kalshiLine, phi, scoreConviction } = require('./predictionSizing.cjs');

// A ladder priced off a normal curve: centre 4000, one-sigma 40, lines every 20, 2¢ wide.
const ladder = ({ centre = 4000, sigma = 40, step = 20, half = 0.01 } = {}) => Array.from({ length: 13 }, (_, index) => {
  const strike = centre + (index - 6) * step;
  const above = 1 - phi((strike - centre) / sigma);
  return { ticker: `T${strike}`, strike, yesBid: above - half, yesAsk: above + half, noBid: 1 - above - half, noAsk: 1 - above + half };
});

const fullShort = { side: 'SHORT', tick: { direction: 'BEARISH' }, zScore: { value: 2.4 },
  usdCorrelation: { d30: -0.8 }, usd: { trend: 'BULLISH' }, volatility: { regimeKey: 'GVZ', value: 28, w1: 2 },
  volume: { signal: { tone: 'confirms' } } };
const points = (sized) => Object.fromEntries(sized.components.map((item) => [item.key, item.points]));

test('normal curve and its inverse agree', () => {
  for (const p of [0.01, 0.2, 0.5, 0.84, 0.99]) assert.ok(Math.abs(phi(invPhi(p)) - p) < 1e-6);
});

test('a setup starts at 3% and every input in its favor takes it to the 5.5% ceiling', () => {
  assert.equal(scoreConviction({ side: 'LONG' }).pct, 3);
  const sized = scoreConviction(fullShort);
  assert.equal(sized.pct, 5.5);
  assert.deepEqual(points(sized), { usd: 1, tick: 0.5, volume: 0.5, zScore: 0.5 });
  assert.equal(scoreConviction({ side: null }), null);
});

test('Tick adds half a point when it agrees, nothing when Neutral, and takes half a point off when it opposes', () => {
  const tick = (direction) => scoreConviction({ side: 'LONG', tick: direction ? { direction } : null });
  assert.equal(tick('BULLISH').pct, 3.5);
  assert.equal(tick('NEUTRAL').pct, 3);
  assert.equal(tick('BEARISH').pct, 2.5);
  assert.equal(tick(null).pct, 3);
  assert.equal(tick(null).components.find((item) => item.key === 'tick').missing, true);
});

test('the dollar adds only when its Trend supports the side, scaled by the 30D correlation up to 0.5', () => {
  const usd = (correlation, trend) => points(scoreConviction({ side: 'SHORT', usdCorrelation: { d30: correlation }, usd: { trend } })).usd;
  assert.equal(usd(-0.8, 'BULLISH'), 1);
  assert.equal(usd(-0.5, 'BULLISH'), 1);
  assert.equal(usd(-0.25, 'BULLISH'), 0.5);
  assert.equal(usd(-0.8, 'BEARISH'), 0);
  assert.equal(usd(0.8, 'BULLISH'), 0);
  assert.equal(usd(-0.8, 'NEUTRAL'), 0);
});

test('volume adds on a supports or confirms signal and Z-score by how far price is stretched against the side', () => {
  const volume = (tone) => points(scoreConviction({ side: 'SHORT', volume: { signal: { tone } } })).volume;
  assert.deepEqual([volume('supports'), volume('confirms'), volume('warns'), volume(null)], [0.5, 0.5, 0, 0]);
  const z = (side, value) => points(scoreConviction({ side, zScore: { value } })).zScore;
  assert.deepEqual([z('SHORT', 2), z('SHORT', 1), z('SHORT', -1), z('LONG', -3), z('LONG', 1)], [0.5, 0.25, 0, 0.5, 0]);
  // Dollar +1, Tick +0.5, Z-score +0.25 round to the nearest half point.
  assert.equal(scoreConviction({ ...fullShort, volume: null, zScore: { value: 1 } }).pct, 5);
});

test('High or expanding volatility opens the far lines and never changes the size', () => {
  const vol = (volatility) => scoreConviction({ side: 'SHORT', volatility });
  assert.deepEqual([vol({ regimeKey: 'GVZ', value: 28, w1: 2 }).wide, vol({ regimeKey: 'GVZ', value: 28, w1: 12 }).wide,
    vol({ regimeKey: 'GVZ', value: 40, w1: 0 }).wide, vol(null).wide], [false, true, true, false]);
  assert.equal(vol({ regimeKey: 'GVZ', value: 40, w1: 12 }).pct, 3);
  assert.equal(vol({ regimeKey: 'GVZ', value: 40, w1: 0 }).volBand, 'High');
});

test('the ladder fit recovers the centre and one-sigma move', () => {
  const fit = fitLadder(ladder());
  assert.ok(Math.abs(fit.centre - 4000) < 0.5);
  assert.ok(Math.abs(fit.sigma - 40) < 0.5);
  assert.equal(fitLadder(ladder().slice(0, 2)), null);
});

const strikes = (split) => split.lines.map((line) => line.strike);

test('a long splits evenly across the YES lines half to one expected move above the price', () => {
  // Centre 4000, one move 40, lines every 20: 4020 is half a move out (about 31¢), 4040 one move (about 16¢).
  const split = allocateLines({ side: 'LONG', pct: 4, lines: ladder() });
  assert.deepEqual(strikes(split), [4020, 4040]);
  assert.ok(split.lines.every((line) => line.buy === 'YES' && line.zone === 'target' && line.pct === 2 && line.ask <= 0.5));
  assert.ok(Math.abs(split.lines[0].ask - 0.3185) < 0.002 && Math.abs(split.lines[1].ask - 0.1687) < 0.002);
  assert.ok(Math.abs(split.lines[1].moves - 1) < 0.01 && Math.abs(split.lines[1].fromCentrePct - 1) < 0.01);
  assert.equal(split.unspentPct, 0);
  assert.ok(Math.abs(split.avgAsk - (split.lines[0].ask + split.lines[1].ask) / 2) < 1e-9);
});

test('a short buys NO below the price, at the NO side\'s own ask', () => {
  const split = allocateLines({ side: 'SHORT', pct: 4, lines: ladder() });
  assert.deepEqual(strikes(split), [3960, 3980]);
  assert.ok(split.lines.every((line) => line.buy === 'NO' && line.ask <= 0.5));
  // A line with no NO quote is skipped, never priced from the YES side.
  const lines = ladder().map((line) => (line.strike === 3980 ? { ...line, noAsk: null } : line));
  assert.deepEqual(strikes(allocateLines({ side: 'SHORT', pct: 4, lines })), [3960]);
});

test('lines past one expected move join only when volatility is High or expanding, and never past one and a half', () => {
  assert.deepEqual(strikes(allocateLines({ side: 'LONG', pct: 4, lines: ladder(), wide: true })), [4020, 4040, 4060]);
  // 4080 is two moves out: never bought.
  assert.ok(strikes(allocateLines({ side: 'LONG', pct: 4, lines: ladder({ half: 0.005 }), wide: true })).every((strike) => strike <= 4060));
});

test('no line is bought past the far end of the Risk Range, scaled to the ladder\'s own centre', () => {
  assert.deepEqual(strikes(allocateLines({ side: 'LONG', pct: 4, lines: ladder(), range: { low: 3980, high: 4030, price: 4000 } })), [4020]);
  assert.deepEqual(strikes(allocateLines({ side: 'SHORT', pct: 4, lines: ladder(), range: { low: 3970, high: 4100, price: 4000 } })), [3980]);
  // The range is in futures terms 1% above the spot ladder: its 4070 top is 4030 on the ladder.
  const split = allocateLines({ side: 'LONG', pct: 4, lines: ladder(), range: { low: 4020, high: 4070, price: 4040 } });
  assert.deepEqual(strikes(split), [4020]);
  assert.ok(Math.abs(split.rangeLimit - 4030) < 1);
});

test('when no target line qualifies the whole position goes on the cheapest nearer line', () => {
  // The range ends just past the price: only the 46¢ line next to the centre is left.
  const split = allocateLines({ side: 'LONG', pct: 5, lines: ladder({ step: 5 }), range: { low: 3900, high: 4008, price: 4000 } });
  assert.deepEqual(strikes(split), [4005]);
  assert.deepEqual([split.lines[0].zone, split.lines[0].pct], ['near', 5]);
  assert.ok(split.lines[0].ask > 0.4 && split.lines[0].ask <= 0.5);
  // Nothing at 50¢ or less inside the range: no ticket.
  const none = allocateLines({ side: 'LONG', pct: 5, lines: ladder(), range: { low: 3900, high: 3999, price: 3990 } });
  assert.deepEqual([none.lines.length, none.unspentPct, none.reason], [0, 5, 'No line at 50¢ or less within reach']);
});

test('wide or one-sided lines are not priced', () => {
  assert.equal(allocateLines({ side: 'SHORT', pct: 4, lines: ladder({ half: 0.04 }) }).reason, 'No liquid line');
});

test('with an account balance, stakes are whole contracts and what a line cannot take at its ask moves on', () => {
  const open = allocateLines({ side: 'LONG', pct: 4, lines: ladder(), bankroll: 6000 });
  assert.deepEqual(strikes(open), [4020, 4040]);
  assert.ok(open.lines.every((line) => Number.isInteger(line.contracts) && line.dollars <= 120 && line.dollars > 119));
  assert.ok(Math.abs(open.lines[0].win - (open.lines[0].contracts - open.lines[0].dollars)) < 1e-9);
  // 100 contracts rest at each ask: the three target lines take about $75 between them and the 41¢ line the next $42.
  const thin = allocateLines({ side: 'LONG', pct: 4, lines: ladder({ step: 10 }).map((line) => ({ ...line, yesAskSize: 100, noAskSize: 5 })), bankroll: 6000 });
  assert.deepEqual(strikes(thin), [4010, 4020, 4030, 4040]);
  assert.ok(thin.lines.every((line) => line.contracts === 100 && line.capped));
  assert.equal(thin.lines[0].zone, 'near');
  assert.ok(thin.unspentPct > 2 && Math.abs(thin.spentPct + thin.unspentPct - 4) < 1e-9);
  // A short reads the size resting on the YES bid it sells into.
  const short = allocateLines({ side: 'SHORT', pct: 4, lines: ladder().map((line) => ({ ...line, yesAskSize: 100, noAskSize: 5 })), bankroll: 6000 });
  assert.ok(short.lines.every((line) => line.contracts === 5));
});

test('more than four lines in the zone are thinned to four, evenly spaced', () => {
  const fine = allocateLines({ side: 'LONG', pct: 4, lines: ladder({ step: 10 }), wide: true });
  assert.equal(fine.lines.length, 4);
  assert.ok(fine.lines.every((line) => line.pct === 1));
});

test('Kalshi quotes are read in dollars from either field form and never derived across sides', () => {
  assert.deepEqual(kalshiLine({ ticker: 'A', floor_strike: 4000, strike_type: 'greater', yes_bid_dollars: '0.4100', yes_ask_dollars: '0.4300',
    no_bid_dollars: '0.5700', no_ask_dollars: '0.5900', yes_ask_size_fp: '600.00', yes_bid_size_fp: '671.00' }),
  { ticker: 'A', strike: 4000, strikeType: 'greater', yesBid: 0.41, yesAsk: 0.43, noBid: 0.57, noAsk: 0.59,
    yesAskSize: 600, noAskSize: 671, result: null });
  const cents = kalshiLine({ ticker: 'B', floor_strike: 4000, yes_bid: 41, yes_ask: 43, no_bid: 0, no_ask: 100 });
  assert.equal(cents.yesAsk, 0.43);
  assert.equal(cents.noAsk, null);
  assert.equal(cents.noBid, null);
});

test('the account is cash plus open positions', () => {
  assert.equal(kalshiAccountValue({ balance_dollars: '5200.50', portfolio_value: 80000 }), 6000.5);
  assert.equal(kalshiAccountValue({ balance: 520050 }), 5200.5);
  assert.equal(kalshiAccountValue(null), null);
});
