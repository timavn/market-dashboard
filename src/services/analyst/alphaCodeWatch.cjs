// The morning's Alpha Code lines, watched through the session. Each product
// prints a Trade and a Trend level per market; a price above a line reads that
// duration Bullish and below it Bearish. Hedgeye confirms a broken line only the
// next morning, so a cross is inferred here from the printed level and a live price.
const UNIVERSE = require('../../constants/predictionMarketUniverse.json');
const { PROXY_TICKERS } = require('../predictionMorningResearch.cjs');

const WATCH_VERSION = 1;
// A cross counts once the price clears the line by a tenth of a percent, so a
// price sitting on the line does not flip it back and forth.
const BAND = 0.001;
const DURATIONS = ['trade', 'trend'];
// Breaks kept per line: enough for a line crossed back and forth in one session.
const KEPT_BREAKS = 6;
const finite = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/**
 * The lines a market day's setup board prints: each market's own Alpha Code, and
 * the codes ETF proxies carry in their own units, keyed by the symbol quoted for them.
 */
function alphaCodeLines(board) {
  const products = new Map((board?.research?.products || []).map(product => [product.key, product]));
  const markets = new Map(UNIVERSE.markets.map(market => [market.id, market]));
  const lines = [];
  const add = (symbol, label, market, code, readings = {}) => {
    const product = products.get(code.product) || {};
    for (const duration of DURATIONS) {
      const level = finite(code[duration]);
      if (level === null || level <= 0) continue;
      lines.push({ id: `${symbol}|${duration}`, symbol, label, market, duration, level, approximate: Boolean(code.approximate),
        product: code.product || null, productLabel: code.productLabel || null, publishedAt: product.publishedAt || null,
        messageId: product.messageId || null, excerpt: code.excerpt || null, marketDate: board.marketDate || null,
        reading: readings[duration] || null });
    }
  };
  // The market's own published Trade and Trend, as published: a board that already
  // reads a broken line Neutral keeps the call it replaced.
  const readingsOf = row => Object.fromEntries(DURATIONS.map(duration => {
    const published = row.alphaBreaks?.[duration]?.published
      || (duration === 'trade' ? row.trade && { value: row.trade.direction, date: row.trade.date, source: row.trade.source } : row.trend && { value: row.trend, date: row.range?.date || row.rangeDate || null, source: 'Risk Ranges' });
    return [duration, published?.value ? published : null];
  }));
  const rows = [...(board?.rows || []), ...(board?.usd ? [{ ...board.usd, id: 'usd' }] : [])];
  for (const row of rows) {
    const research = row.research;
    if (!research) continue;
    const market = row.id === 'usd' ? { label: 'USD', price: { symbol: UNIVERSE.usd.symbol } } : markets.get(row.id);
    // Gold, silver and copper are quoted from futures, not the spot their codes are printed in,
    // and Treasury yields have no intraday quote here; their codes are not watched.
    if (market && research.alphaCode && market.price?.symbol && market.price.fit !== 'proxy' && !/^ust\d+y$/.test(row.id)) {
      add(market.price.symbol, market.label || row.id, row.id, research.alphaCode, readingsOf(row));
    }
    // An ETF printed with its own code is watched on its own quote, highest-priority product first.
    const seen = new Set();
    for (const finding of research.findings || []) {
      const ticker = finding.ticker || finding.instrument;
      if (finding.kind !== 'alphaCode' || finding.fit !== 'proxy' || !PROXY_TICKERS.includes(ticker) || seen.has(ticker)) continue;
      seen.add(ticker);
      add(ticker, ticker, row.id, finding);
    }
  }
  return lines;
}

const EXPECTED = { BULLISH: 'above', BEARISH: 'below' };
// A date-only publication counts from the start of its day.
const readingTime = reading => (typeof reading?.at === 'number' ? reading.at
  : Date.parse(reading?.at || (reading?.date ? `${String(reading.date).slice(0, 10)}T00:00:00Z` : '')) || -Infinity);

/**
 * The line a published Trade or Trend reading has lost: the price crossed to the
 * other side of its Alpha Code line after the reading and has not come back. That
 * duration then reads Neutral until the price is back on the reading's side.
 * reading: { value: 'BULLISH' | 'BEARISH' | ..., at?, date? }. Returns the line or null.
 */
function brokenAlphaCodeLine(watch, symbol, duration, reading) {
  const expected = EXPECTED[reading?.value];
  if (!expected) return null;
  const line = Object.values(watch?.lines || {}).find(item => item.symbol === symbol && item.duration === duration);
  if (!line?.side || line.side === expected) return null;
  return Date.parse(line.since) > readingTime(reading) ? line : null;
}

/** What a watched line makes its duration read now: the published call while it holds, Neutral once broken. */
function alphaCodeVerdict(line, reading = line?.reading) {
  if (EXPECTED[reading?.value]) return brokenAlphaCodeLine({ lines: { [line.id]: line } }, line.symbol, line.duration, reading) ? 'NEUTRAL' : reading.value;
  // Without a published direction a cross has nothing to break, and implies no direction of its own.
  return line?.breaks?.length ? 'NEUTRAL' : null;
}

const sideOf = (price, level, band = BAND) => (price > level * (1 + band) ? 'above' : price < level * (1 - band) ? 'below' : null);

/**
 * Fold a market day's lines and prices into the stored watch.
 * prices: { [symbol]: { price, asOf } }. Returns { watch, changed }.
 */
function foldAlphaCodeWatch(stored, { marketDate = null, lines = [], prices = {}, regime = null, now = new Date() } = {}) {
  const at = now.toISOString();
  const previous = stored?.version === WATCH_VERSION ? stored : null;
  const watched = {};
  if (previous && previous.marketDate === marketDate) Object.assign(watched, previous.lines);
  // On a new market day a line no newer research replaces is watched one more
  // session, so a code printed only on some mornings is not dropped overnight.
  else if (previous) {
    for (const [id, line] of Object.entries(previous.lines || {})) if (line.marketDate === previous.marketDate && line.retain !== false) watched[id] = line;
  }
  for (const line of lines) {
    const kept = watched[line.id];
    // The same printed level keeps its side; a new edition's breaks start over.
    watched[line.id] = kept && kept.level === line.level
      ? { ...line, side: kept.side, since: kept.since, price: kept.price, priceAt: kept.priceAt,
        breaks: kept.marketDate === line.marketDate ? kept.breaks : [] }
      : { ...line, side: null, since: null, price: null, priceAt: null, breaks: [] };
  }
  for (const line of Object.values(watched)) {
    const quote = prices[line.symbol];
    const price = finite(quote?.price);
    if (price === null) continue;
    line.price = price;
    line.priceAt = quote.asOf || at;
    const side = sideOf(price, line.level, line.band);
    if (!side || side === line.side) continue;
    // The first clear reading sets which side of the line the session starts on.
    if (line.side) line.breaks = [...(line.breaks || []), { from: line.side, to: side, price, at: line.priceAt }].slice(-KEPT_BREAKS);
    line.side = side;
    line.since = line.priceAt;
  }
  const watch = { version: WATCH_VERSION, marketDate, updatedAt: at, lines: watched, ...(regime ? { regime } : {}) };
  const material = value => JSON.stringify([value?.regime || null, Object.values(value?.lines || {}).map(line => [line.id, line.level, line.marketDate, line.side, line.breaks, line.reading || null, line.printedDate || null, line.change || null, line.isNew || false])]);
  return { watch, changed: !previous || previous.marketDate !== marketDate || material(previous) !== material(watch) };
}

module.exports = { BAND, alphaCodeLines, alphaCodeVerdict, brokenAlphaCodeLine, foldAlphaCodeWatch };
