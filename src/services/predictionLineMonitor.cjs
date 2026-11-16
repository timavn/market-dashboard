const UNIVERSE = require('../constants/predictionMarketUniverse.json');
const { calibrate, fee, kalshiAccountValue, kalshiLine, priceLines, fitLadder, SIZING } = require('./predictionSizing.cjs');

// Kalshi line monitor: every rule is an ordered list of conditions, first match wins.
//   Shade    (per market)     Long (green) / Short (red) / none: Trade and Trend agree and price is in the matching
//                              third of the Risk Range (user-specified 2026-11-13).
//   Lines    (per line)       Strong / Good / Watch / Pass by edge for the shaded side at the price our bet size
//                              actually fills at (walking the order book); Illiquid when the book cannot take the bet.
//   Held     (per owned line) Closed / Contradicts / Through line / Edge gone / Unshaded / Closing / Hold.
//   Book     (whole account)  At risk, max payout, exposure by section and the book's flags.
// Read-only: nothing here sizes or places an order.

const MONITOR = UNIVERSE.lineMonitor;
const finite = (value) => (value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value));
const seriesOf = (ticker) => String(ticker || '').split('-')[0];
const eventOf = (ticker) => String(ticker || '').split('-').slice(0, 2).join('-');
const LADDER_KEEP = 60;
const LONG_STRIKES = new Set(['greater', 'greater_or_equal']);
const SHORT_STRIKES = new Set(['less', 'less_or_equal']);
const STATE_RANK = { CLOSED: -1, CONTRADICTS: 0, THROUGH_LINE: 1, EDGE_GONE: 2, SETUP_LAPSED: 3, CLOSING: 4, HOLD: 5 };
const STATE_TONE = { CLOSED: 'blue', CONTRADICTS: 'red', THROUGH_LINE: 'yellow', EDGE_GONE: 'yellow', SETUP_LAPSED: 'yellow', CLOSING: 'blue', HOLD: 'none' };

/** Board market id for a Kalshi ticker: its own series, or a series the catalog maps to it (weeklies). */
function marketIdForTicker(ticker, markets = UNIVERSE.markets) {
  const series = seriesOf(ticker);
  const match = markets.find((market) => [].concat(market.kalshi.series, market.kalshi.heldSeries || []).includes(series));
  return match ? match.id : null;
}

function strength(edge, config = MONITOR) {
  const points = edge * 100;
  if (points >= config.edgeTiers.strong) return 'STRONG';
  if (points >= config.edgeTiers.good) return 'GOOD';
  if (points >= config.edgeTiers.watch) return 'WATCH';
  return 'PASS';
}

const word = (value) => `${value[0]}${value.slice(1).toLowerCase()}`;

/**
 * The row's shading. Short (light red): Trade and Trend both Bearish and price in the top third of the Risk Range.
 * Long (light green): both Bullish and price in the bottom third. Anything else, including price outside the range,
 * is unshaded, with the first input that kept it so.
 */
function shadeOf(row, rule = UNIVERSE.setupRule) {
  const position = finite(row.position);
  if (position === null) return { side: null, reason: 'No range position' };
  if (position < 0 || position > 1) return { side: null, reason: position < 0 ? 'Below range' : 'Above range' };
  const trend = row.trend || null;
  const trade = row.trade?.direction || null;
  if (!trend || trend === 'NEUTRAL') return { side: null, reason: trend ? 'Trend Neutral' : 'No Trend' };
  if (trade !== trend) return { side: null, reason: trade ? `Trade ${word(trade)}, Trend ${word(trend)}` : 'No Trade' };
  if (trend === 'BULLISH') return position <= rule.bottomThird ? { side: 'LONG' } : { side: null, reason: 'Price not in the bottom third' };
  return position >= rule.topThird ? { side: 'SHORT' } : { side: null, reason: 'Price not in the top third' };
}

/** Direction a held line bets on the underlying, from its strike type and side. */
function heldDirection(strikeType, side) {
  if (LONG_STRIKES.has(strikeType)) return side === 'YES' ? 'LONG' : 'SHORT';
  if (SHORT_STRIKES.has(strikeType)) return side === 'YES' ? 'SHORT' : 'LONG';
  return null;
}

/** Each open position on one line, in dollars and contracts. */
function heldPositions(positions) {
  return (positions?.market_positions || []).map((item) => {
    const count = finite(item.position_fp ?? item.position);
    if (!count) return null;
    return { ticker: item.ticker, event: eventOf(item.ticker), side: count > 0 ? 'YES' : 'NO', contracts: Math.abs(count),
      cost: finite(item.market_exposure_dollars) ?? 0, fees: finite(item.fees_paid_dollars) ?? 0 };
  }).filter(Boolean);
}

/**
 * State of one held line, first match wins. `row` is its board market (null when the catalog does not map it);
 * `market` is the line's live Kalshi market.
 */
function heldState(held, row, market, { now = new Date(), config = MONITOR, closed = false } = {}) {
  const quote = market ? kalshiLine(market) : null;
  const strikeType = market?.strike_type || null;
  const direction = heldDirection(strikeType, held.side);
  // A held line reads the raw book: a $1 ask (no offer) or a 0 bid is a bound, and a line that is all but
  // decided must still show as through the line.
  const raw = (field) => {
    const dollars = finite(market?.[`${field}_dollars`]) ?? (finite(market?.[field]) === null ? null : finite(market[field]) / 100);
    return dollars !== null && dollars >= 0 && dollars <= 1 ? dollars : null;
  };
  const yesBid = raw('yes_bid');
  const yesAsk = raw('yes_ask');
  const mid = yesBid !== null && yesAsk !== null && yesAsk >= yesBid && yesAsk > 0 ? (yesBid + yesAsk) / 2 : null;
  const sideMid = mid === null ? null : held.side === 'YES' ? mid : 1 - mid;
  const bid = raw(held.side === 'YES' ? 'yes_bid' : 'no_bid');
  const ours = mid === null ? null : held.side === 'YES' ? calibrate(mid) : 1 - calibrate(mid);
  const closeTime = market?.close_time || null;
  const hoursLeft = closeTime ? (Date.parse(closeTime) - now.getTime()) / 3_600_000 : null;
  const setupSide = row?.setup?.side || null;
  const base = { ...held, marketId: row?.id || null, market: row?.label || null, strike: quote?.strike ?? null, strikeType,
    subtitle: market?.yes_sub_title || null, direction, bid, kalshiOdds: sideMid, ourOdds: ours,
    exitEdge: ours !== null && bid !== null ? ours - bid : null, closeTime };
  const result = (state, why) => ({ ...base, state, tone: STATE_TONE[state], why });
  const pct = (value) => `${Math.round(value * 100)}%`;
  // Its event was read and the line is no longer open: trading is over, it only waits to settle.
  if (closed) return result('CLOSED', 'Closed; awaiting settlement');
  if (setupSide && direction && setupSide !== direction) {
    return result('CONTRADICTS', `Shaded ${setupSide === 'LONG' ? 'long' : 'short'}; line is held ${held.side === 'YES' ? 'Yes' : 'No'}`);
  }
  if (sideMid !== null && sideMid < 0.5) return result('THROUGH_LINE', `Kalshi has the held side at ${pct(sideMid)}`);
  if (ours !== null && bid !== null && ours < bid) return result('EDGE_GONE', `Our odds ${pct(ours)} vs ${Math.round(bid * 100)}¢ bid`);
  // CPI carries no setup rule, so it never lapses.
  if (row && 'setup' in row && !setupSide) return result('SETUP_LAPSED', row.setup?.reason || 'Unshaded');
  if (hoursLeft !== null && hoursLeft >= 0 && hoursLeft <= config.closingHours) {
    return result('CLOSING', `Closes in ${hoursLeft < 1 ? `${Math.max(1, Math.round(hoursLeft * 60))} min` : `${hoursLeft.toFixed(1)} h`}`);
  }
  return result('HOLD', null);
}

const worst = (lines) => lines.reduce((low, line) => (!low || STATE_RANK[line.state] < STATE_RANK[low.state] ? line : low), null);

/**
 * The asks for buying one side, cheapest first, as [price, contracts]. Buying YES takes resting NO bids
 * (ask = 1 − bid) and buying NO takes resting YES bids. Reads Kalshi's `orderbook_fp` (dollar prices) or the
 * older `orderbook` (cents).
 */
function askLevels(book, side) {
  const bids = book?.[side === 'YES' ? 'no_dollars' : 'yes_dollars']
    ?? (book?.[side === 'YES' ? 'no' : 'yes'] || []).map(([cents, count]) => [cents / 100, count]);
  return (bids || []).map(([price, count]) => [Math.round((1 - Number(price)) * 10000) / 10000, Number(count)])
    .filter(([price, count]) => price > 0 && price < 1 && count > 0).sort((left, right) => left[0] - right[0]);
}

/**
 * Spend `dollars` through the asks, cheapest first: contracts bought, the average price paid, the average fee per
 * contract, the cheapest and dearest prices touched, and whether the whole amount filled.
 */
function bookFill(levels, dollars, sizingConfig = SIZING) {
  let left = dollars;
  let contracts = 0;
  let fees = 0;
  let worst = null;
  for (const [price, count] of levels) {
    if (left <= 1e-9) break;
    const take = Math.min(count, left / price);
    contracts += take;
    fees += take * fee(price, sizingConfig);
    left -= take * price;
    worst = price;
  }
  const spent = dollars - Math.max(0, left);
  return { dollars: spent, contracts, avg: contracts ? spent / contracts : null, fee: contracts ? fees / contracts : null,
    best: levels[0]?.[0] ?? null, worst, complete: left <= 0.005 };
}

/**
 * One side of a line as we would buy it. With an order book and a bet size: the bet walked through the book, its
 * average price as the ask and our edge at that price (our odds − average − average fee); illiquid when the book cannot
 * take the whole bet. Without one: the top ask, the dollars resting there and our edge at it; illiquid with no ask or
 * under minDepthDollars at the ask (an unknown size is not held against it).
 */
function sideBook(line, side, ours, { config = MONITOR, sizingConfig = SIZING, book = null, bet = null } = {}) {
  if (book && bet > 0) {
    const levels = askLevels(book, side);
    const depth = levels.reduce((total, [price, count]) => total + price * count, 0);
    const fill = bookFill(levels, bet, sizingConfig);
    if (!fill.contracts) return { ask: null, depth, edge: null, illiquid: true, fill };
    return { ask: fill.avg, depth, edge: ours === null ? null : ours - fill.avg - fill.fee, fill,
      ...(fill.complete ? {} : { illiquid: true }) };
  }
  const ask = side === 'YES' ? line.yesAsk : line.noAsk;
  const size = side === 'YES' ? line.yesAskSize : line.noAskSize;
  if (ask === null) return { ask: null, depth: null, edge: null, illiquid: true };
  const depth = size === null ? null : size * ask;
  return { ask, depth, edge: ours === null ? null : ours - ask - fee(ask, sizingConfig),
    ...(depth !== null && depth < config.minDepthDollars ? { illiquid: true } : {}) };
}

/**
 * Lines whose order books are worth reading: the quoted ones nearest even odds (between 3% and 97%), up to `count`.
 * Far lines are near-certain or long shots and are left on their top-of-book quote.
 */
function bookCandidates(markets, count = MONITOR.bookLines) {
  if (!Array.isArray(markets)) return [];
  return quotedLines(markets).map((line) => ({ line, mid: line.yesBid !== null && line.yesAsk !== null ? (line.yesBid + line.yesAsk) / 2 : null }))
    .filter(({ mid }) => mid !== null && mid >= 0.03 && mid <= 0.97)
    .sort((left, right) => Math.abs(left.mid - 0.5) - Math.abs(right.mid - 0.5)).slice(0, count).map(({ line }) => line.ticker);
}

/** A market's bet in dollars: its sized % of the Kalshi account, or the sizing's base % when it is not sized. */
function betDollars(row, account, sizing = UNIVERSE.sizing) {
  if (!(account > 0)) return null;
  const pct = row?.sizing?.pct > 0 ? row.sizing.pct : sizing.basePct;
  return Math.round(account * pct) / 100;
}

const quotedLines = (markets) => markets.map((market) => ({ ...kalshiLine(market), subtitle: market.yes_sub_title || null }))
  .filter((line) => line.strike !== null && (LONG_STRIKES.has(line.strikeType) || !line.strikeType));

/** The line Kalshi prices at even odds: strike interpolated where YES crosses 50%. */
function kalshiCentre(lines) {
  const quoted = lines.filter((line) => line.kalshiOdds !== null && line.kalshiOdds !== undefined)
    .sort((left, right) => left.strike - right.strike);
  for (let index = 1; index < quoted.length; index += 1) {
    const [low, high] = [quoted[index - 1], quoted[index]];
    if (low.kalshiOdds >= 0.5 && high.kalshiOdds <= 0.5 && low.kalshiOdds !== high.kalshiOdds) {
      return low.strike + ((high.strike - low.strike) * (low.kalshiOdds - 0.5)) / (low.kalshiOdds - high.kalshiOdds);
    }
  }
  return null;
}

const bestOf = (line, side, book) => ({ ticker: line.ticker, strike: line.strike, subtitle: line.subtitle || null, side,
  ask: book.ask, edge: book.edge, depth: book.depth });

/**
 * The setup's lines in its selected event, graded by edge on the setup's side (Short buys NO, Long buys YES), with the
 * other side shown beside it. A setup side with under minDepthDollars at its ask grades Illiquid, whatever its edge.
 * `seen` remembers when each line first read Strong, so one that turned Strong within newStrongMinutes and is not held
 * is marked new.
 */
function gradeLines(row, markets, { held = [], seen = new Map(), now = new Date(), config = MONITOR, sizingConfig = SIZING,
  books = null, bet = null } = {}) {
  const side = row.setup?.side;
  if (!side || !Array.isArray(markets)) return null;
  const quoted = quotedLines(markets);
  const byTicker = new Map(quoted.map((line) => [line.ticker, line]));
  const ladder = fitLadder(quoted, sizingConfig);
  // The sizing block's tilt and widening, when the setup is sized, so its tickets and these lines agree. Every two-sided
  // line is priced here; depth, not spread, decides whether it can be taken.
  const priced = priceLines({ side, lines: quoted, tilt: row.sizing?.tilt || 0, widen: row.sizing?.widen || 1, ladder },
    { ...sizingConfig, maxSpread: 1 });
  const heldBy = new Map(held.map((line) => [line.ticker, line]));
  const buy = side === 'LONG' ? 'YES' : 'NO';
  const lines = priced.map((line) => {
    const quote = byTicker.get(line.ticker);
    const ourYes = buy === 'YES' ? line.ourOdds : 1 - line.ourOdds;
    const book = books?.get(line.ticker) || null;
    const options = { config, sizingConfig, book, bet: book ? bet : null };
    const yes = sideBook(quote, 'YES', ourYes, options);
    const no = sideBook(quote, 'NO', 1 - ourYes, options);
    const taken = buy === 'YES' ? yes : no;
    // With a book read, the grade is the edge at the price the whole bet fills at.
    const edge = book ? taken.edge : line.edge;
    const grade = taken.illiquid || edge === null ? 'ILLIQUID' : strength(edge, config);
    const own = heldBy.get(line.ticker);
    if (grade === 'STRONG') { if (!seen.has(line.ticker)) seen.set(line.ticker, now.getTime()); } else seen.delete(line.ticker);
    const isNew = grade === 'STRONG' && !own && now.getTime() - seen.get(line.ticker) <= config.newStrongMinutes * 60_000;
    return { ticker: line.ticker, strike: line.strike, subtitle: quote.subtitle, buy, ask: book ? taken.ask : line.ask,
      kalshiOdds: line.kalshiOdds, ourOdds: line.ourOdds, edge, yes, no, ...(book ? { checked: true } : {}), kalshiYes: buy === 'YES' ? line.kalshiOdds : 1 - line.kalshiOdds, ourYes,
      sigmas: line.sigmas ?? null, strength: grade, ...(isNew ? { isNew: true } : {}),
      ...(own ? { held: { side: own.side, contracts: own.contracts } } : {}) };
  }).sort((left, right) => (right.edge ?? -1) - (left.edge ?? -1));
  const count = (grade) => lines.filter((line) => line.strength === grade).length;
  const closeTime = markets.map((market) => market.close_time).filter(Boolean).sort()[0] || null;
  const takeable = lines.filter((line) => line.strength !== 'ILLIQUID');
  const top = takeable[0];
  return { side, buy, lines, illiquid: count('ILLIQUID'), closeTime, minDepth: config.minDepthDollars, bet: books?.size ? bet : null,
    total: lines.length, fillable: takeable.length,
    bestLine: top ? { ...bestOf(top, buy, buy === 'YES' ? top.yes : top.no), strength: top.strength, ...(top.isNew ? { isNew: true } : {}) } : null,
    counts: { STRONG: count('STRONG'), GOOD: count('GOOD'), WATCH: count('WATCH'), PASS: count('PASS'), ILLIQUID: count('ILLIQUID') },
    best: takeable.length ? takeable[0].edge : null };
}

/**
 * A market's ladder with no setup: every quoted line with both sides (ask, dollars at the ask, our edge) and the
 * side with the better edge marked. A line whose better side has under minDepthDollars at its ask is illiquid.
 * Nothing is graded or marked bettable.
 */
function ladderLines(markets, { config = MONITOR, sizingConfig = SIZING, books = null, bet = null } = {}) {
  if (!Array.isArray(markets)) return null;
  const quoted = quotedLines(markets);
  const ladder = fitLadder(quoted, sizingConfig);
  const lines = quoted.map((line) => {
    const mid = line.yesBid !== null && line.yesAsk !== null ? (line.yesBid + line.yesAsk) / 2 : null;
    const ourYes = mid === null ? null : calibrate(mid);
    const book = books?.get(line.ticker) || null;
    const options = { config, sizingConfig, book, bet: book ? bet : null };
    const yes = sideBook(line, 'YES', ourYes, options);
    const no = sideBook(line, 'NO', ourYes === null ? null : 1 - ourYes, options);
    const sides = [['YES', yes], ['NO', no]].filter(([, book]) => book.edge !== null);
    const better = sides.length ? sides.reduce((top, item) => (item[1].edge > top[1].edge ? item : top))[0] : null;
    const taken = better === 'YES' ? yes : better === 'NO' ? no : null;
    return { ticker: line.ticker, strike: line.strike, subtitle: line.subtitle, yes, no, better,
      kalshiOdds: mid, ourOdds: ourYes, sigmas: ladder ? (line.strike - ladder.centre) / ladder.sigma : null,
      ...(book ? { checked: true } : {}), ...(!taken || taken.illiquid ? { illiquid: true } : {}) };
  });
  // With books read, only a line checked against the bet can be the best one.
  const checkedOnly = Boolean(books?.size && bet);
  const bestLine = lines.filter((line) => !line.illiquid && line.better && (!checkedOnly || line.checked))
    .map((line) => ({ line, side: line.better, book: line.better === 'YES' ? line.yes : line.no }))
    .reduce((top, item) => (!top || item.book.edge > top.book.edge ? item : top), null);
  // Long ladders (Nasdaq lists hundreds) keep the lines nearest even odds; unquoted lines go last.
  const distance = (line) => (line.kalshiOdds === null ? 2 : Math.abs(line.kalshiOdds - 0.5));
  const kept = [...lines].sort((left, right) => distance(left) - distance(right)).slice(0, LADDER_KEEP)
    .sort((left, right) => left.strike - right.strike);
  const closeTime = markets.map((market) => market.close_time).filter(Boolean).sort()[0] || null;
  return { side: null, lines: kept, total: lines.length, illiquid: kept.filter((line) => line.illiquid).length, closeTime,
    minDepth: config.minDepthDollars, bet: checkedOnly ? bet : null,
    fillable: lines.filter((line) => !line.illiquid && (!checkedOnly || line.checked)).length, centre: kalshiCentre(lines),
    best: bestLine ? bestOf(bestLine.line, bestLine.side, bestLine.book) : null };
}

/**
 * One market's block: its shading, the summary row (price against Kalshi's centre, best line, fillable lines, close),
 * graded lines when shaded or the ungraded ladder otherwise, and the lines held in it.
 */
function marketMonitor(row, { lines = null, ladder = null, held = [], quotedAt = null } = {}) {
  const side = row.setup?.side || null;
  const strongOrGood = lines?.counts ? lines.counts.STRONG + lines.counts.GOOD : 0;
  const top = worst(held);
  const group = UNIVERSE.markets.find((market) => market.id === row.id)?.group || null;
  // The market's own price, the one Kalshi settles on (Nasdaq-100, not the Composite its range is read against).
  const price = finite(row.price?.value);
  const shown = lines || ladder;
  return { id: row.id, market: row.label, event: row.events?.[0]?.eventTicker || null,
    shade: side, ...(row.setup?.reason && !side ? { shadeReason: row.setup.reason } : {}),
    summary: { price, centre: ladder?.centre ?? null, position: finite(row.position), unit: group === 'rates' || group === 'inflation' ? '%' : null,
      best: lines ? lines.bestLine : ladder?.best ?? null, fillable: ladder?.fillable ?? lines?.fillable ?? null,
      total: ladder?.total ?? lines?.total ?? null, closeTime: shown?.closeTime || null },
    ...(shown ? { lines: shown } : {}), held, ...(top && top.state !== 'HOLD' ? { worst: { state: top.state, tone: top.tone } } : {}),
    open: Boolean(side && strongOrGood > 0), quotedAt };
}

/**
 * The whole Kalshi account: what is at risk, where, and the book-level flags. `held` are graded held lines and
 * `monitors` the market blocks (for bettable lines). Caps stay unflagged until the catalog sets them.
 */
function kalshiBook({ balance, positions, held, monitors, config = MONITOR, now = new Date() }) {
  const account = kalshiAccountValue(balance);
  const cash = finite(balance?.balance_dollars) ?? (finite(balance?.balance) === null ? null : finite(balance.balance) / 100);
  const atRisk = held.reduce((sum, line) => sum + line.cost, 0);
  const share = (value) => (account ? (value / account) * 100 : null);
  const groupOf = (line) => UNIVERSE.markets.find((market) => market.id === line.marketId)?.group || 'other';
  const sections = UNIVERSE.sections.map((section) => ({ id: section.id, label: section.label })).concat({ id: 'other', label: 'Other' });
  const bySection = sections.map((section) => {
    const lines = held.filter((line) => groupOf(line) === section.id);
    const yes = lines.filter((line) => line.side === 'YES').reduce((sum, line) => sum + line.cost, 0);
    const no = lines.filter((line) => line.side === 'NO').reduce((sum, line) => sum + line.cost, 0);
    const top = worst(lines);
    const markets = [...new Set(lines.map((line) => line.market || seriesOf(line.ticker)))];
    const directions = [...new Set(lines.map((line) => line.direction).filter(Boolean))];
    return { id: section.id, label: section.label, atRisk: yes + no, pct: share(yes + no), yes, no, lines: lines.length, markets,
      direction: directions.length === 1 ? directions[0] : directions.length ? 'MIXED' : null,
      state: top ? top.state : null, flagged: lines.filter((line) => line.tone === 'red' || line.tone === 'yellow').length };
  }).filter((section) => section.lines > 0 || section.id !== 'other');
  const flags = [];
  for (const [market, lines] of groupBy(held.filter((line) => line.state === 'CONTRADICTS'), (line) => line.market)) {
    flags.push({ tone: 'red', text: `${market}: ${lines[0].why}; ${lines.length} line${lines.length === 1 ? '' : 's'} ($${Math.round(sum(lines, 'cost')).toLocaleString('en-US')}).` });
  }
  if (config.bookCapPct !== null && account && share(atRisk) > config.bookCapPct) {
    flags.push({ tone: 'yellow', text: `At risk ${share(atRisk).toFixed(1)}% of the account, over the ${config.bookCapPct}% book cap.` });
  }
  if (config.sectionCapPct !== null) {
    for (const section of bySection) {
      if (section.pct !== null && section.pct > config.sectionCapPct) {
        flags.push({ tone: 'yellow', text: `${section.label} at ${section.pct.toFixed(1)}% of the account, over the ${config.sectionCapPct}% section cap.` });
      }
    }
  }
  if (atRisk > 0) {
    const byDay = groupBy(held.filter((line) => line.closeTime), (line) => line.closeTime.slice(0, 10));
    for (const [day, lines] of byDay) {
      const dayRisk = sum(lines, 'cost');
      if ((dayRisk / atRisk) * 100 > config.expirySharePct) {
        const label = new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
        flags.push({ tone: 'yellow', text: `${label} closes hold ${Math.round((dayRisk / atRisk) * 100)}% of risk ($${Math.round(dayRisk).toLocaleString('en-US')}).` });
      }
    }
  }
  for (const section of bySection) {
    const markets = [...new Set(held.filter((line) => groupOf(line) === section.id && line.marketId).map((line) => line.market))];
    if (markets.length >= 2 && (section.direction === 'LONG' || section.direction === 'SHORT')) {
      flags.push({ tone: 'yellow', text: `Stacked: ${markets.length === 2 ? markets.join(' and ') : `${markets.slice(0, -1).join(', ')} and ${markets.at(-1)}`} ${markets.length === 2 ? 'both' : 'all'} ${section.direction === 'LONG' ? 'long' : 'short'}.` });
    }
  }
  const fresh = monitors.flatMap((monitor) => (monitor.lines?.lines || []).filter((line) => line.isNew).map((line) => ({ monitor, line })));
  for (const { monitor, line } of fresh) {
    flags.push({ tone: 'yellow', text: `${monitor.market} ${lineLabel(line.strike)} is a new Strong line.` });
  }
  const bettable = monitors.flatMap((monitor) => (monitor.lines?.lines || [])
    .filter((line) => (line.strength === 'STRONG' || line.strength === 'GOOD') && !line.held));
  const ledger = bookLedger(held, { sections, groupOf, share });
  const valued = ledger.filter((position) => position.value !== null);
  const closeDays = [...groupBy(held.filter((line) => line.closeTime), (line) => line.closeTime.slice(0, 10))]
    .map(([day, lines]) => ({ day, cost: sum(lines, 'cost') })).sort((left, right) => right.cost - left.cost);
  return {
    asOf: now.toISOString(), account, cash, atRisk, atRiskPct: share(atRisk),
    maxPayout: held.reduce((total, line) => total + line.contracts, 0),
    openLines: held.length, events: new Set(held.map((line) => line.event)).size,
    flagged: { red: held.filter((line) => line.tone === 'red').length, yellow: held.filter((line) => line.tone === 'yellow').length },
    bettable: bettable.length,
    realized: (positions?.event_positions || []).reduce((total, item) => total + (finite(item.realized_pnl_dollars) || 0), 0),
    sections: bySection, flags, positions: ledger,
    // Value now: each held line's contracts at its current bid. Lines with no bid (closed, awaiting settlement) are left out.
    value: valued.length ? sum(valued, 'value') : null, pnl: valued.length ? valued.reduce((total, position) => total + position.pnl, 0) : null,
    unvalued: ledger.length - valued.length,
    topClose: atRisk > 0 && closeDays.length ? { day: closeDays[0].day, pct: (closeDays[0].cost / atRisk) * 100 } : null,
    caps: { sectionPct: config.sectionCapPct, bookPct: config.bookCapPct },
    unmapped: held.filter((line) => !line.marketId),
  };
}

/**
 * The positions ledger: one row per market and side, in section order. Value now is contracts × the held side's bid;
 * a row with any line lacking a bid has no value or P&L. State is the row's worst held state.
 */
function bookLedger(held, { sections, groupOf, share }) {
  const order = new Map(sections.map((section, index) => [section.id, index]));
  const label = new Map(sections.map((section) => [section.id, section.label]));
  return [...groupBy(held, (line) => `${line.marketId || seriesOf(line.ticker)}|${line.side}`).values()].map((lines) => {
    const first = lines[0];
    const section = groupOf(first);
    const values = lines.map((line) => (line.bid === null || line.bid === undefined ? null : line.bid * line.contracts));
    const value = values.includes(null) ? null : values.reduce((total, item) => total + item, 0);
    const cost = sum(lines, 'cost');
    const top = worst(lines);
    const closes = lines.map((line) => line.closeTime).filter(Boolean).sort();
    return { marketId: first.marketId, market: first.market || seriesOf(first.ticker), section, sectionLabel: label.get(section) || 'Other',
      side: first.side, direction: first.direction,
      lines: [...lines].sort((left, right) => (left.strike ?? 0) - (right.strike ?? 0)).map((line) => ({ ticker: line.ticker,
        strike: line.strike, strikeType: line.strikeType, subtitle: line.subtitle, contracts: line.contracts, cost: line.cost, bid: line.bid,
        value: values[lines.indexOf(line)], state: line.state })),
      cost, pct: share(cost), value, pnl: value === null ? null : value - cost, maxPayout: sum(lines, 'contracts'),
      closeTime: closes[0] || null, state: top.state, tone: top.tone, why: top.why };
  }).sort((left, right) => (order.get(left.section) ?? 99) - (order.get(right.section) ?? 99) || right.cost - left.cost);
}

const sum = (items, key) => items.reduce((total, item) => total + (item[key] || 0), 0);
function groupBy(items, keyOf) {
  const groups = new Map();
  for (const item of items) groups.set(keyOf(item), [...(groups.get(keyOf(item)) || []), item]);
  return groups;
}
const lineLabel = (strike) => `Above ${Number(strike).toLocaleString('en-US', { maximumFractionDigits: 4 })}`;

/**
 * Attach the monitor to a finished board. `marketsByEvent` holds the live Kalshi markets of every event read
 * (setups' selected events and held events). Rows gain `kalshiLines`; the board gains `kalshiBook`.
 */
function applyLineMonitor(board, { balance, positions, marketsByEvent, seen, now = new Date(), orderbooks = null }) {
  const account = kalshiAccountValue(balance);
  const rows = board.rows || [];
  // The monitor reads every row through its shading, not the board's setup rule (which sizing keeps using).
  const shadedRows = new Map(rows.map((row) => [row.id, 'setup' in row ? { ...row, setup: shadeOf(row) } : row]));
  const rowById = shadedRows;
  const marketByTicker = new Map([...marketsByEvent.values()].flat().filter(Boolean).map((market) => [market.ticker, market]));
  const held = heldPositions(positions).map((line) => {
    const row = rowById.get(marketIdForTicker(line.ticker)) || null;
    const market = marketByTicker.get(line.ticker) || null;
    const closed = !market && Array.isArray(marketsByEvent.get(line.event));
    return heldState(line, row, market, { now, closed });
  }).sort((left, right) => STATE_RANK[left.state] - STATE_RANK[right.state]);
  const monitors = [];
  for (const row of rows) {
    const shaded = shadedRows.get(row.id);
    const own = held.filter((line) => line.marketId === row.id);
    const event = row.events?.[0]?.eventTicker;
    const markets = event ? marketsByEvent.get(event) : null;
    // A setup grades its lines for its side; any other market still shows its ladder.
    // Each line is checked against the market's bet: what that many dollars buys through the order book.
    const bet = orderbooks?.size ? betDollars(row, account) : null;
    const ladder = ladderLines(markets, { books: orderbooks, bet });
    // A shaded row grades its lines for its side; any other row shows its ladder.
    const lines = shaded.setup?.side ? gradeLines(shaded, markets, { held: own, seen, now, books: orderbooks, bet }) : null;
    if (!lines && !ladder && !own.length && !('setup' in row)) continue;
    row.kalshiLines = marketMonitor(shaded, { lines, ladder, held: own, quotedAt: now.toISOString() });
    monitors.push(row.kalshiLines);
  }
  // Without a positions read the lines still grade; the book needs the account's positions.
  if (positions) board.kalshiBook = kalshiBook({ balance, positions, held, monitors, now });
  return board;
}

module.exports = { applyLineMonitor, askLevels, betDollars, bookCandidates, bookFill, eventOf, gradeLines, kalshiCentre, ladderLines, shadeOf, sideBook, heldDirection, heldPositions, heldState, kalshiBook,
  marketIdForTicker, marketMonitor, strength, MONITOR };
