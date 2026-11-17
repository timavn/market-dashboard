const UNIVERSE = require('../constants/predictionMarketUniverse.json');
const { VOL_RANGES } = require('../utils/volatilityRegimes.js');

// Sizes a board setup as a share of the Kalshi account and picks the event's lines for it.
// Size: a setup starts at basePct; the dollar, Tick, volume and Z-score each add (Tick can also subtract) their weight.
// Lines: in the setup's direction, priced at 50¢ or less, no farther than 1.5 expected moves and never past the far
// end of the Risk Range. A line's price is its distance: 31¢ is half an expected move away, 16¢ one, 7¢ one and a half.
// Nothing here places orders.

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

const SIGN = { LONG: 1, SHORT: -1 };
const BIAS = { BULLISH: 1, BEARISH: -1 };

/** The dashboard's own regime band for a volatility gauge (Low, Moderate, High); a gauge without bands has none. */
function volBand(volatility) {
  const level = finite(volatility?.value);
  if (level === null) return null;
  return (VOL_RANGES[volatility?.regimeKey]?.ranges || []).find((range) => level >= range.min && (range.max == null || level < range.max))?.label || null;
}

/**
 * Size of a setup in % of the Kalshi account: basePct, plus the dollar (when its Trend supports the side through the
 * 30D correlation, scaled by the correlation's strength), Tick (adds when it agrees, subtracts when it opposes),
 * volume (a supports or confirms signal) and Z-score (stretched against the side). An input with no reading adds nothing.
 */
function scoreConviction({ side, tick, zScore, usdCorrelation, usd, volatility, volume } = {}, config = SIZING) {
  const sign = SIGN[side];
  if (!sign) return null;
  const weights = config.weights;
  const component = (key, label, share, detail) => ({ key, label, weight: weights[key], points: share === null ? 0 : weights[key] * clamp(share, -1, 1),
    ...(share === null ? { missing: true } : {}), ...(detail ? { detail } : {}) });
  const correlation = finite(usdCorrelation?.[config.usdCorrelationWindow]);
  const usdBias = BIAS[usd?.trend] || 0;
  const usdShare = correlation === null || !usd?.trend ? null
    : sign * correlation * usdBias > 0 ? clamp(Math.abs(correlation) / config.usdCorrelationFull) : 0;
  const tickBias = BIAS[tick?.direction];
  const z = finite(zScore?.value);
  const tone = volume?.signal?.tone;
  const week = finite(volatility?.w1);
  const band = volBand(volatility);
  const expanding = week !== null && week > config.volExpansionPct;
  const components = [
    component('usd', 'Dollar', usdShare, correlation === null ? null : `${correlation.toFixed(2)} corr, dollar ${String(usd?.trend || 'n/a').toLowerCase()}`),
    component('tick', 'Tick', tick?.direction ? (tickBias ? tickBias * sign : 0) : null, tick?.direction ? String(tick.direction).toLowerCase() : null),
    component('volume', 'Volume', volume?.signal ? (tone === 'supports' || tone === 'confirms' ? 1 : 0) : null, volume?.signal ? tone || 'no signal' : null),
    component('zScore', 'Z-score', z === null ? null : clamp((sign > 0 ? -z : z) / config.zScoreFull), z === null ? null : `${z.toFixed(1)} sd`),
  ];
  const raw = config.basePct + components.reduce((sum, item) => sum + item.points, 0);
  const pct = clamp(Math.round(raw / config.roundPct) * config.roundPct, config.minPct, config.maxPct);
  // High or expanding volatility opens the far lines (1 to 1.5 expected moves).
  return { side, pct, maxPct: config.maxPct, basePct: config.basePct, components, expanding, volBand: band, wide: expanding || band === 'High' };
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
 * The lines a position of `pct` goes on. A Long buys YES above the price and a Short buys NO below it, each at its own
 * quoted ask of maxAsk or less, within maxMoves expected moves and inside the Risk Range. The position is split evenly
 * across the target lines (targetFrom to targetTo moves, about 31¢ to 16¢), joined by the far lines when `wide`.
 * What they cannot take at the ask moves to the nearer, dearer lines, cheapest first; the rest stays unspent.
 */
function allocateLines({ side, pct, lines, wide = false, bankroll = null, range = null } = {}, config = SIZING) {
  const sign = SIGN[side];
  if (!sign || !(pct > 0)) return null;
  const rules = config.lines;
  const ladder = fitLadder(lines, config);
  // The range is published for the board's price; scale its far end to the ladder's own centre (futures against spot).
  const scale = ladder && range?.price > 0 ? ladder.centre / range.price : 1;
  const farEnd = finite(sign > 0 ? range?.high : range?.low);
  const limit = farEnd === null ? null : farEnd * scale;
  const quoted = (lines || []).filter((line) => liquid(line, config.maxSpread) && strikeOf(line) !== null);
  const priced = quoted.map((line) => {
    const ask = finite(sign > 0 ? line.yesAsk : line.noAsk);
    if (ask === null || !(ask > 0 && ask <= rules.maxAsk + 1e-9)) return null;
    const yes = (line.yesBid + line.yesAsk) / 2;
    // Distance past the price in expected moves, read from the line's own odds of paying.
    const moves = invPhi(1 - (sign > 0 ? yes : 1 - yes));
    const strike = strikeOf(line);
    if (!(moves > 0) || moves > rules.maxMoves + 1e-9) return null;
    const beyondRange = limit !== null && (sign > 0 ? strike > limit : strike < limit);
    if (beyondRange) return null;
    const cost = ask + fee(ask, config);
    return { ticker: line.ticker || null, strike, buy: sign > 0 ? 'YES' : 'NO', ask, fee: fee(ask, config), moves,
      zone: moves < rules.targetFrom ? 'near' : moves <= rules.targetTo ? 'target' : 'far',
      askSize: finite(line.askSize ?? (sign > 0 ? line.yesAskSize : line.noAskSize)), cost,
      ...(ladder ? { fromCentrePct: ((strike - ladder.centre) / ladder.centre) * 100 } : {}) };
  }).filter(Boolean).sort((left, right) => right.moves - left.moves);
  let chosen = priced.filter((line) => line.zone === 'target' || (wide && line.zone === 'far'));
  if (chosen.length > rules.maxLines) {
    chosen = Array.from({ length: rules.maxLines }, (_, index) => chosen[Math.round((index * (chosen.length - 1)) / (rules.maxLines - 1))]);
  }
  // Nearer lines take what is left, cheapest first. A far line is never a fallback: it needs high or expanding volatility.
  const fallback = priced.filter((line) => line.zone === 'near');
  const stakes = new Map();
  const add = (line, share) => stakes.set(line, (stakes.get(line) || 0) + share);
  let left = pct;
  if (!(bankroll > 0)) {
    // Without an account balance the size at the ask cannot be weighed: the position is split evenly, in shares only.
    const takers = chosen.length ? chosen : fallback.slice(0, 1);
    for (const line of takers) add(line, pct / takers.length);
    if (takers.length) left = 0;
  } else {
    const room = (line) => (line.askSize === null ? Infinity : (Math.floor(line.askSize) * line.cost / bankroll) * 100) - (stakes.get(line) || 0);
    let open = chosen.filter((line) => room(line) > 1e-9);
    while (left > 1e-9 && open.length) {
      const each = left / open.length;
      for (const line of open) { const take = Math.min(each, room(line)); add(line, take); left -= take; }
      open = open.filter((line) => room(line) > 1e-9);
    }
    for (const line of fallback) {
      if (left <= 1e-9) break;
      const take = Math.min(left, room(line));
      if (take > 1e-9) { add(line, take); left -= take; }
    }
  }
  const tickets = [...stakes].map(([line, share]) => {
    const { cost, ...rest } = line;
    if (!(bankroll > 0)) return { ...rest, pct: share };
    const contracts = Math.floor(((share / 100) * bankroll) / cost + 1e-9);
    const dollars = contracts * cost;
    return { ...rest, pct: (dollars / bankroll) * 100, contracts, dollars, win: contracts - dollars,
      ...(line.askSize !== null && contracts >= Math.floor(line.askSize) ? { capped: true } : {}) };
  }).filter((line) => line.contracts !== 0).sort((left, right) => left.strike - right.strike);
  const spent = tickets.reduce((sum, line) => sum + line.pct, 0);
  // `reach` names every line the rules allow (50¢ or less, within maxMoves, inside the range), bought or not.
  return { side, pct, wide, ladder, quoted: quoted.length, reach: priced.map((line) => line.ticker).filter(Boolean), lines: tickets, spentPct: spent, unspentPct: Math.max(0, pct - spent),
    ...(spent > 0 ? { avgAsk: tickets.reduce((sum, line) => sum + line.ask * line.pct, 0) / spent } : {}),
    ...(limit === null ? {} : { rangeLimit: limit }),
    ...(tickets.length ? {} : { reason: !quoted.length ? 'No liquid line' : priced.length ? 'No size at the ask' : 'No line at 50¢ or less within reach' }) };
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

module.exports = { allocateLines, fee, liquid, fitLadder, invPhi, kalshiAccountValue, kalshiLine, phi, scoreConviction, sizedMarket, volBand, SIZING };
