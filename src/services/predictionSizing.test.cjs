const test = require('node:test');
const assert = require('node:assert/strict');
const { allocateLines, calibrate, fitLadder, invPhi, kalshiAccountValue, kalshiLine, phi, scoreConviction, SIZING } = require('./predictionSizing.cjs');

// A ladder priced off a normal curve: centre 4000, one-sigma 40, lines every 20, 2¢ wide.
const ladder = ({ centre = 4000, sigma = 40, step = 20, half = 0.01 } = {}) => Array.from({ length: 13 }, (_, index) => {
  const strike = centre + (index - 6) * step;
  const above = 1 - phi((strike - centre) / sigma);
  return { ticker: `T${strike}`, strike, yesBid: above - half, yesAsk: above + half, noBid: 1 - above - half, noAsk: 1 - above + half };
});

const fullShort = { side: 'SHORT', position: 1, trade: { direction: 'BEARISH' }, zScore: { value: 2.4 },
  usdCorrelation: { d30: -0.8 }, usd: { trend: 'BULLISH' }, volatility: { regimeKey: 'GVZ', value: 28, w1: 2 },
  volume: { signal: { tone: 'confirms' } } };

test('normal curve and its inverse agree', () => {
  for (const p of [0.01, 0.2, 0.5, 0.84, 0.99]) assert.ok(Math.abs(phi(invPhi(p)) - p) < 1e-6);
});

test('a setup with every input in its favor is sized at the cap', () => {
  const sized = scoreConviction(fullShort);
  assert.equal(sized.pct, 10);
  assert.ok(sized.components.every((item) => item.lost === 0));
});

test('the bare setup at the third boundary is sized at the base', () => {
  const sized = scoreConviction({ side: 'LONG', position: 0.3333, zScore: { value: 0.5 }, usdCorrelation: { d30: 0.9 },
    usd: { trend: 'BEARISH' }, volatility: { regimeKey: 'GVZ', value: 40, w1: 0 }, volume: { signal: { tone: 'warns' } } });
  assert.equal(sized.pct, 4);
});

test('gold short with the dollar and Z-score partly off lands at 8%', () => {
  // Top of the range, Trade agrees, vol and volume fine; dollar uncorrelated (half) and price only 1 sd stretched (half).
  const sized = scoreConviction({ ...fullShort, position: 0.95, zScore: { value: 1 }, usdCorrelation: { d30: -0.3 } });
  assert.equal(sized.pct, 8.5);
  const lost = Object.fromEntries(sized.components.filter((item) => item.lost > 0).map((item) => [item.key, Number(item.lost.toFixed(2))]));
  assert.deepEqual(lost, { range: 0.3, zScore: 0.5, usd: 0.5 });
  assert.equal(scoreConviction({ ...fullShort, position: 0.9, zScore: { value: 1 }, usdCorrelation: { d30: -0.3 }, trade: null }).pct, 7.5);
});

test('missing inputs score half and are named; an unpublished Trade earns nothing', () => {
  const sized = scoreConviction({ side: 'SHORT', position: 1 });
  const byKey = Object.fromEntries(sized.components.map((item) => [item.key, item]));
  assert.equal(byKey.trade.score, 0);
  assert.equal(byKey.trade.missing, undefined);
  for (const key of ['zScore', 'usd', 'volatility', 'volume']) assert.equal(byKey[key].missing, true);
  assert.equal(sized.pct, 4 + 2 + 0.5 + 0.5 + 0.25 + 0.25);
  assert.equal(scoreConviction({ side: null }), null);
});

test('the dollar counts for a side only through its correlation', () => {
  const usd = (correlation, trend) => scoreConviction({ side: 'SHORT', position: 1, usdCorrelation: { d30: correlation }, usd: { trend } })
    .components.find((item) => item.key === 'usd').score;
  assert.equal(usd(-0.8, 'BULLISH'), 1);
  assert.equal(usd(-0.8, 'BEARISH'), 0);
  assert.equal(usd(0.8, 'BULLISH'), 0);
  assert.equal(usd(-0.4, 'BULLISH'), 0.5);
  assert.equal(usd(-0.8, 'NEUTRAL'), 0.5);
});

test('expanding or High volatility earns nothing', () => {
  const vol = (volatility) => scoreConviction({ side: 'SHORT', position: 1, volatility }).components.find((item) => item.key === 'volatility');
  assert.equal(vol({ regimeKey: 'GVZ', value: 28, w1: 12 }).score, 0);
  assert.equal(vol({ regimeKey: 'GVZ', value: 40, w1: 0 }).score, 0);
  assert.equal(vol({ regimeKey: 'GVZ', value: 28, w1: 0 }).score, 1);
  assert.equal(scoreConviction({ side: 'SHORT', position: 1, volatility: { regimeKey: 'GVZ', value: 28, w1: 12 } }).expanding, true);
});

test('the ladder fit recovers the centre and one-sigma move', () => {
  const fit = fitLadder(ladder());
  assert.ok(Math.abs(fit.centre - 4000) < 0.5);
  assert.ok(Math.abs(fit.sigma - 40) < 0.5);
  assert.equal(fitLadder(ladder().slice(0, 2)), null);
});

test('the calibration curve lifts favorites and cuts long shots', () => {
  assert.ok(calibrate(0.9) > 0.9);
  assert.ok(calibrate(0.1) < 0.1);
  assert.equal(calibrate(0), 0);
  assert.equal(calibrate(1), 1);
});

test('a short buys NO at its own ask, only on lines with edge, and never more than the position', () => {
  const split = allocateLines({ side: 'SHORT', pct: 10, lines: ladder() });
  assert.ok(split.lines.length > 0);
  assert.ok(split.lines.every((line) => line.buy === 'NO' && line.edge > 0 && line.pct >= SIZING.minLinePct));
  assert.ok(Math.abs(split.spentPct - 10) < 1e-9);
  assert.equal(split.unspentPct, 0);
  const atCentre = split.lines.find((line) => line.strike === 4000);
  assert.ok(Math.abs(atCentre.ask - 0.51) < 1e-6);
  assert.ok(Math.abs(atCentre.sigmas) < 0.02);
  // The tilt moves our odds of settling below the centre line above Kalshi's.
  assert.ok(atCentre.ourOdds > atCentre.kalshiOdds + 0.05);
});

test('a long buys YES and a line with no quote on that side is skipped', () => {
  const lines = ladder().map((line) => (line.strike === 4000 ? { ...line, yesAsk: line.yesAsk, noAsk: null } : line));
  const long = allocateLines({ side: 'LONG', pct: 8, lines });
  assert.ok(long.lines.every((line) => line.buy === 'YES'));
  const short = allocateLines({ side: 'SHORT', pct: 8, lines });
  assert.equal(short.lines.some((line) => line.strike === 4000), false);
});

test('wide or one-sided lines are not priced', () => {
  const wide = ladder({ half: 0.04 });
  assert.equal(allocateLines({ side: 'SHORT', pct: 8, lines: wide }).reason, 'No liquid line');
});

test('with an account balance, stakes become whole contracts capped by the size at the ask', () => {
  const lines = ladder().map((line) => ({ ...line, askSize: 40 }));
  const split = allocateLines({ side: 'SHORT', pct: 10, lines, bankroll: 6000 });
  assert.ok(split.lines.length > 0 && split.lines.every((line) => Number.isInteger(line.contracts) && line.contracts <= 40 && line.capped));
  assert.ok(split.unspentPct > 0);
  const open = allocateLines({ side: 'SHORT', pct: 10, lines: ladder(), bankroll: 6000 });
  assert.ok(open.spentPct <= 10 && open.spentPct > 9.5);
  assert.ok(Math.abs(open.lines.reduce((sum, line) => sum + line.dollars, 0) - (open.spentPct / 100) * 6000) < 1e-6);
});

test('a base-size position has no tilt and a vol expansion widens the curve', () => {
  assert.equal(allocateLines({ side: 'SHORT', pct: 4, lines: ladder() }).tilt, 0);
  assert.equal(allocateLines({ side: 'SHORT', pct: 10, lines: ladder() }).tilt, SIZING.tiltSigma);
  assert.equal(allocateLines({ side: 'SHORT', pct: 10, lines: ladder(), expanding: true }).widen, SIZING.widenOnExpansion);
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

test('a short is capped by the size resting on the YES bid it sells into', () => {
  const lines = ladder().map((line) => ({ ...line, yesAskSize: 1000, noAskSize: 3 }));
  // Three contracts are under a quarter-percent of the account, so those lines drop out and the money stays unspent.
  const thin = allocateLines({ side: 'SHORT', pct: 10, lines, bankroll: 6000 });
  assert.deepEqual([thin.lines.length, thin.unspentPct, thin.reason], [0, 10, 'No line with edge']);
  const fifty = allocateLines({ side: 'SHORT', pct: 10, lines: lines.map((line) => ({ ...line, noAskSize: 50 })), bankroll: 6000 });
  assert.ok(fifty.lines.length > 0 && fifty.lines.every((line) => line.contracts <= 50 && line.pct >= SIZING.minLinePct));
  assert.ok(allocateLines({ side: 'LONG', pct: 10, lines, bankroll: 6000 }).lines.some((line) => line.contracts > 3));
});

test('the account is cash plus open positions', () => {
  assert.equal(kalshiAccountValue({ balance_dollars: '5200.50', portfolio_value: 80000 }), 6000.5);
  assert.equal(kalshiAccountValue({ balance: 520050 }), 5200.5);
  assert.equal(kalshiAccountValue(null), null);
});
