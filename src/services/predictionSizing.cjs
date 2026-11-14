const UNIVERSE = require('../constants/predictionMarketUniverse.json');
const CALIBRATION = require('../constants/kalshiCalibrationCurve.json');
const { VOL_RANGES } = require('../utils/volatilityRegimes.js');

// Sizes a board setup as a share of the Kalshi account and splits it across the event's lines.
// Size: a setup starts at basePct and each input earns part of its weight. Split: every line's
// calibrated Kalshi odds are shifted toward the setup, and lines share the position by their
// Kelly weight on the edge that shift leaves after the ask and the fee. Nothing here places orders.

const SIZING = UNIVERSE.sizing;
const clamp = (value, low = 0, high = 1) => Math.min(high, Math.max(low, value));
const finite = (value) => (value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value));

/** Standard normal CDF (Abramowitz–Stegun 7.1.26 on erf). */
function phi(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t
    * Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

/** Inverse standard normal CDF (Acklam). */
function invPhi(p) {
  if (!(p > 0 && p < 1)) return p <= 0 ? -Infinity : Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const tail = (q) => (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
    / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  if (p < 0.02425) return tail(Math.sqrt(-2 * Math.log(p)));
  if (p > 1 - 0.02425) return -tail(Math.sqrt(-2 * Math.log(1 - p)));
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
    / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

const CURVE = [[0, 0], ...CALIBRATION.map((bucket) => [bucket.avgMid, bucket.paid]), [1, 1]];

/** How often a Kalshi YES mid has actually paid: the backtest's calibration curve, interpolated. */
function calibrate(mid) {
  const x = clamp(mid);
  const upper = CURVE.findIndex(([at]) => at >= x);
  if (upper <= 0) return CURVE[0][1];
  const [x0, y0] = CURVE[upper - 1];
  const [x1, y1] = CURVE[upper];
  return y0 + (y1 - y0) * ((x - x0) / (x1 - x0));
}

const SIGN = { LONG: 1, SHORT: -1 };
const BIAS = { BULLISH: 1, BEARISH: -1 };

/**
 * Size of a setup in % of the Kalshi account. Each input scores 0–1 of its weight; an input with no
 * reading scores half and is marked missing. Trade is the exception: an unpublished Trade earns nothing.
 */
function scoreConviction({ side, position, trade, zScore, usdCorrelation, usd, volatility, volume } = {}, config = SIZING,
  rule = UNIVERSE.setupRule) {
  const sign = SIGN[side];
  if (!sign) return null;
  const weights = config.weights;
  const component = (key, label, score, detail) => {
    const missing = score === null;
    const value = missing ? 0.5 : clamp(score);
    return { key, label, weight: weights[key], score: value, points: weights[key] * value, lost: weights[key] * (1 - value),
      ...(missing ? { missing: true } : {}), ...(detail ? { detail } : {}) };
  };
  const place = finite(position);
  const range = place === null ? null
    : sign > 0 ? (rule.bottomThird - place) / rule.bottomThird : (place - rule.topThird) / (1 - rule.topThird);
  const z = finite(zScore?.value);
  const correlation = finite(usdCorrelation?.[config.usdCorrelationWindow]);
  const usdBias = BIAS[usd?.trend] || 0;
  let usdScore = null;
  if (correlation !== null && usd?.trend) {
    const strength = clamp((Math.abs(correlation) - config.usdCorrelationFloor) / (config.usdCorrelationFull - config.usdCorrelationFloor));
    usdScore = 0.5 + 0.5 * Math.sign(sign * correlation * usdBias) * strength;
  }
  const week = finite(volatility?.w1);
  const level = finite(volatility?.value);
  // The dashboard's own regime band for the gauge (Low, Moderate, High); a gauge without bands has none.
  const band = level === null ? null : (VOL_RANGES[volatility?.regimeKey]?.ranges || [])
    .find((range) => level >= range.min && (range.max == null || level < range.max))?.label || null;
  const expanding = week !== null && week > config.volExpansionPct;
  const volScore = level === null || (week === null && !band) ? null : (expanding || band === 'High' ? 0 : 1);
  const tone = volume?.signal?.tone;
  const components = [
    component('range', 'Range', range, place === null ? null : `${Math.round(place * 100)}% of range`),
    component('trade', 'Trade', BIAS[trade?.direction] === sign ? 1 : 0, trade?.direction ? null : 'no published Trade'),
    component('zScore', 'Z-score', z === null ? null : (sign > 0 ? -z : z) / config.zScoreFull, z === null ? null : `${z.toFixed(1)} sd`),
    component('usd', 'Dollar', usdScore, correlation === null ? null : `${correlation.toFixed(2)} corr, dollar ${String(usd?.trend || 'n/a').toLowerCase()}`),
    component('volatility', 'Volatility', volScore, volScore === null ? null : [band, week === null ? null : `${week >= 0 ? '+' : ''}${week.toFixed(0)}% 1W`].filter(Boolean).join(', ')),
    component('volume', 'Volume', tone === 'supports' || tone === 'confirms' ? 1 : tone === 'warns' ? 0 : volume?.signal ? 0.5 : null, tone || null),
  ];
  const raw = config.basePct + components.reduce((sum, item) => sum + item.points, 0);
  const pct = clamp(Math.round(raw / config.roundPct) * config.roundPct, config.basePct, config.maxPct);
  return { side, pct, maxPct: config.maxPct, basePct: config.basePct, components, expanding };
}

const strikeOf = (line) => finite(line.strike ?? line.floor_strike ?? line.floor ?? line.cap_strike ?? line.cap);
const liquid = (line, maxSpread) => line.yesBid >= 0.01 && line.yesAsk <= 0.99 && line.yesAsk > line.yesBid
  && line.yesAsk - line.yesBid <= maxSpread + 1e-9;

/** Kalshi's own centre and one-sigma move to settlement: least squares of K = m + s·Φ⁻¹(1 − P) over liquid lines. */
function fitLadder(lines, config = SIZING) {
  const points = (lines || []).filter((line) => liquid(line, config.maxSpread) && strikeOf(line) !== null)
    .map((line) => ({ strike: strikeOf(line), above: (line.yesBid + line.yesAsk) / 2 }))
    .filter((point) => point.above >= 0.05 && point.above <= 0.95)
    .map((point) => ({ strike: point.strike, q: invPhi(1 - point.above) }));
  if (points.length < 3) return null;
  const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const meanQ = mean(points.map((point) => point.q));
  const meanK = mean(points.map((point) => point.strike));
  const spread = points.reduce((sum, point) => sum + (point.q - meanQ) ** 2, 0);
  if (spread < 1e-9) return null;
  const sigma = points.reduce((sum, point) => sum + (point.q - meanQ) * (point.strike - meanK), 0) / spread;
  return sigma > 0 ? { centre: meanK - sigma * meanQ, sigma, points: points.length } : null;
}

const fee = (price, config) => config.feeRate * price * (1 - price);

/**
 * Every liquid line priced for one side: a Short buys NO and a Long buys YES at that side's own ask. Our odds are the
 * ladder's calibrated odds, shifted toward the side by `tilt` sigma and widened by `widen`; edge is ours − ask − fee.
 */
function priceLines({ side, lines, tilt = 0, widen = 1, ladder } = {}, config = SIZING) {
  const sign = SIGN[side];
  if (!sign) return [];
  if (ladder === undefined) ladder = fitLadder(lines, config);
  return (lines || []).filter((line) => liquid(line, config.maxSpread) && strikeOf(line) !== null).map((line) => {
    const ask = finite(sign > 0 ? line.yesAsk : line.noAsk);
    if (ask === null || !(ask > 0 && ask < 1)) return null;
    const market = calibrate((line.yesBid + line.yesAsk) / 2);
    const above = 1 - phi((invPhi(1 - market) - sign * tilt) / widen);
    const ours = sign > 0 ? above : 1 - above;
    const cost = ask + fee(ask, config);
    const edge = ours - cost;
    const strike = strikeOf(line);
    return { ticker: line.ticker || null, strike, buy: sign > 0 ? 'YES' : 'NO', ask, fee: fee(ask, config),
      kalshiOdds: sign > 0 ? market : 1 - market, ourOdds: ours, edge, kelly: edge / (1 - ask),
      askSize: finite(line.askSize ?? (sign > 0 ? line.yesAskSize : line.noAskSize)),
      ...(ladder ? { fromCentrePct: ((strike - ladder.centre) / ladder.centre) * 100, sigmas: (strike - ladder.centre) / ladder.sigma } : {}) };
  }).filter(Boolean).sort((left, right) => left.strike - right.strike);
}

/**
 * Split a position of `pct` across the event's lines. A Short buys NO and a Long buys YES, each at its own
 * quoted ask. Lines share the position by Kelly weight on a positive edge; a share under minLinePct is
 * dropped and a stake above the size showing at the ask is cut to it, the remainder staying unspent.
 */
function allocateLines({ side, pct, lines, expanding = false, bankroll = null } = {}, config = SIZING) {
  const sign = SIGN[side];
  if (!sign || !(pct > 0)) return null;
  const ladder = fitLadder(lines, config);
  const tilt = config.tiltSigma * clamp((pct - config.basePct) / (config.maxPct - config.basePct));
  const widen = expanding ? config.widenOnExpansion : 1;
  const priced = priceLines({ side, lines, tilt, widen, ladder }, config);
  // An edge smaller than the quote's own noise is not one: without this the largest Kelly stakes land on 99¢ lines.
  let funded = priced.filter((line) => line.edge >= config.minEdge);
  // Drop the smallest share until every funded line is worth placing.
  for (;;) {
    const total = funded.reduce((sum, line) => sum + line.kelly, 0);
    const smallest = funded.reduce((low, line) => (!low || line.kelly < low.kelly ? line : low), null);
    if (!smallest || funded.length === 1 || pct * (smallest.kelly / total) >= config.minLinePct) break;
    funded = funded.filter((line) => line !== smallest);
  }
  const total = funded.reduce((sum, line) => sum + line.kelly, 0);
  const tickets = funded.map((line) => {
    let share = pct * (line.kelly / total);
    let capped = false;
    let contracts = null;
    let dollars = null;
    if (bankroll > 0) {
      const perContract = line.ask + line.fee;
      contracts = Math.floor(((share / 100) * bankroll) / perContract);
      if (line.askSize !== null && contracts > line.askSize) { contracts = Math.floor(line.askSize); capped = true; }
      dollars = contracts * perContract;
      share = (dollars / bankroll) * 100;
    }
    return { ...line, pct: share, ...(bankroll > 0 ? { contracts, dollars } : {}), ...(capped ? { capped: true } : {}) };
  // A line the book cuts below a placeable share is left out, like one that was too small to begin with.
  }).filter((line) => line.contracts !== 0 && !(line.capped && line.pct < config.minLinePct));
  const spent = tickets.reduce((sum, line) => sum + line.pct, 0);
  return { side, pct, tilt, widen, ladder, quoted: priced.length, lines: tickets, spentPct: spent, unspentPct: Math.max(0, pct - spent),
    ...(tickets.length ? {} : { reason: priced.length ? 'No line with edge' : 'No liquid line' }) };
}

/** Quote fields of a Kalshi market in dollars; a side with no quote stays null and is never derived from the other. */
function kalshiLine(market) {
  const price = (field) => {
    const dollars = finite(market?.[`${field}_dollars`]);
    if (dollars !== null) return dollars;
    const cents = finite(market?.[field]);
    return cents === null ? null : cents / 100;
  };
  const quote = (field) => { const value = price(field); return value > 0 && value < 1 ? value : null; };
  return { ticker: market?.ticker || null, strike: finite(market?.floor_strike ?? market?.cap_strike), strikeType: market?.strike_type || null,
    yesBid: quote('yes_bid'), yesAsk: quote('yes_ask'), noBid: quote('no_bid'), noAsk: quote('no_ask'),
    // Contracts resting at each ask. A NO ask is the other side of a resting YES bid, so it carries that bid's size.
    yesAskSize: finite(market?.yes_ask_size_fp), noAskSize: finite(market?.yes_bid_size_fp),
    result: market?.result || null };
}

/** Cash plus the value of open positions, in dollars. */
function kalshiAccountValue(balance) {
  const cash = finite(balance?.balance_dollars) ?? (finite(balance?.balance) === null ? null : finite(balance.balance) / 100);
  if (cash === null) return null;
  return cash + (finite(balance?.portfolio_value) || 0) / 100;
}

const sizedMarket = (id, config = SIZING) => config.status === 'active' && config.markets.includes(id);

module.exports = { allocateLines, fee, liquid, priceLines, calibrate, fitLadder, invPhi, kalshiAccountValue, kalshiLine, phi, scoreConviction, sizedMarket, SIZING };
