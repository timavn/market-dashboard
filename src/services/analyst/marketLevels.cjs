// Every level the Analyst watches besides the setup board's own lines: the Alpha
// Codes each product prints for any ticker, the SPX gamma flip line, the day's PV
// bands and the VIX bucket lines, plus what the Market Structure tiles changed to
// and which levels could not be read. It only decides what is printed and current;
// alphaCodeWatch.cjs folds prices into the lines and attentionResearch.cjs words them.
const hermesRules = require('../../constants/hermesRules.json');
const { PRODUCTS } = require('../predictionMorningResearch.cjs');
const { buildPublicMarketStructureSnapshot, verifiedMarketStructureChartMetrics } = require('../../utils/marketStructureReport.cjs');

// A code is watched for this many market days after it was last printed, and a
// ticker with no code in that long reads as a new one when one is printed.
const CODE_WINDOW_SESSIONS = 5;
// A printed level this far from the live price is another unit or a misread.
const MAX_LEVEL_GAP = 0.25;
const FLIP_MAX_GAP = 0.1;
// The PV bands are a daily range: today's edition or the previous session's.
const PV_BAND_SESSIONS = 1;
// VIX moves whole tenths on noise; a bucket line needs a clearer cross than a price line.
const VIX_BAND = 0.01;
const PRIORITY = Object.fromEntries(PRODUCTS.map((product, index) => [product.key, index]));
const rank = product => PRIORITY[product] ?? PRODUCTS.length;

// The symbol each coded market is quoted under; a listed ticker is its own.
const QUOTE_SYMBOLS = { SPX: '^GSPC', NDX: '^NDX', CL: 'CL=F', BZ: 'BZ=F', BTC: 'BTC-USD', ETH: 'ETH-USD', USD: 'DX-Y.NYB', DXY: 'DX-Y.NYB', KOSPI: '^KS11' };
const LABELS = { '^GSPC': 'SPX', '^NDX': 'NDX', 'CL=F': 'WTI', 'BZ=F': 'Brent', 'BTC-USD': 'BTC', 'ETH-USD': 'ETH', 'DX-Y.NYB': 'USD', '^KS11': 'KOSPI', UST10Y: 'UST 10Y', UST2Y: 'UST 2Y' };
// Lines that notify whether or not anything is held.
const MARKET_SYMBOLS = new Set(Object.keys(LABELS));
// Printed in spot, quoted here only as futures: the two differ by more than a line's band.
const SPOT_ONLY = /^(?:GOLD|SILVER|COPPER|PLATINUM|PALLADIUM)$/;

const finite = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const day = value => String(value || '').slice(0, 10);
const utc = date => Date.parse(`${day(date)}T12:00:00Z`);
/** Weekdays from one date to a later one: Friday to Monday is one session. */
function sessionsBetween(earlier, later) {
  let from = utc(earlier);
  const to = utc(later);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) return 0;
  let sessions = 0;
  while (from < to) {
    from += 86_400_000;
    if (![0, 6].includes(new Date(from).getUTCDay())) sessions += 1;
  }
  return sessions;
}
const near = (level, price, gap) => price === null || Math.abs(level / price - 1) <= gap;
// A run-together code with no printed expansion ("77037639"), split in equal halves, TRADE
// first, at the scale the live price supports. Without a price it cannot be checked.
function splitRun(raw, price) {
  const digits = String(raw || '').replace(/[$,%\s]/g, '');
  if (!/^\d+$/.test(digits) || digits.length % 2 || price === null) return null;
  const halves = [digits.slice(0, digits.length / 2), digits.slice(digits.length / 2)].map(Number);
  const scale = [1, 1e3].find(candidate => halves.every(value => near(value * candidate, price, MAX_LEVEL_GAP)));
  return scale ? { trade: halves[0] * scale, trend: halves[1] * scale } : null;
}
const messageIdOf = item => (/^[a-f0-9]{16}$/i.test(String(item.sourceEventId || '')) ? item.sourceEventId : null);
const symbolFor = ticker => QUOTE_SYMBOLS[ticker] || ticker;

/** Each printed code resolved to levels, skipping what cannot be priced; misses are the coverage gaps. */
function printedLevels(alphaCodes, prices) {
  const entries = [];
  const unwatched = new Map();
  for (const item of alphaCodes || []) {
    const symbol = symbolFor(item.ticker);
    const price = finite(prices[symbol]);
    const label = LABELS[symbol] || item.ticker;
    if (item.referenceOnly === true || SPOT_ONLY.test(item.ticker)) { unwatched.set(symbol, { symbol, label, date: item.date, levels: item.levels, reason: 'no-spot-quote' }); continue; }
    const split = item.levels?.trade == null && item.levels?.trend == null ? splitRun(item.levels?.raw, price) : null;
    const levels = { trade: finite(item.levels?.trade) ?? split?.trade ?? null, trend: finite(item.levels?.trend) ?? split?.trend ?? null };
    for (const duration of ['trade', 'trend']) {
      if (levels[duration] === null) continue;
      if (!near(levels[duration], price, MAX_LEVEL_GAP)) { unwatched.set(symbol, { symbol, label, date: item.date, levels: item.levels, reason: 'no-matching-quote', duration, level: levels[duration] }); continue; }
      entries.push({ symbol, label, duration, level: levels[duration], split: Boolean(split), date: item.date, product: item.sourceProduct || null, productLabel: item.sourceLabel || null,
        publishedAt: item.publishedAt || null, messageId: messageIdOf(item), excerpt: item.sourceText || null, raw: item.levels?.raw || null, unit: item.levels?.unit || null });
    }
  }
  return { entries, unwatched };
}
// One level per market, duration and date: the highest-priority product's, a printed level over a split code.
const better = (left, right) => (rank(left.product) - rank(right.product)) || (Number(left.split) - Number(right.split));
function perDate(entries) {
  const byKey = new Map();
  for (const entry of entries) {
    const key = `${entry.symbol}|${entry.duration}|${entry.date}`;
    const held = byKey.get(key);
    if (!held || better(entry, held) < 0) byKey.set(key, entry);
  }
  return [...byKey.values()].sort((left, right) => (left.date < right.date ? 1 : -1));
}
// What a line's print changes: nothing, a new code, or a moved level. A level older than
// the window is no baseline, so the first code after a gap is new rather than changed.
function annotate(line, history) {
  const earlier = history.filter(entry => entry.symbol === line.symbol && entry.date < line.printedDate
    && sessionsBetween(entry.date, line.printedDate) <= CODE_WINDOW_SESSIONS);
  const previous = earlier.find(entry => entry.duration === line.duration);
  return { ...line, isNew: earlier.length === 0, change: previous && previous.level !== line.level ? { from: previous.level, to: line.level, fromDate: previous.date, fromRaw: previous.raw || null } : null };
}
function codeLines({ boardLines = [], entries, marketDate }) {
  const dated = perDate(entries);
  const lines = new Map();
  for (const entry of dated) {
    const id = `${entry.symbol}|${entry.duration}`;
    if (lines.has(id) || entry.date > marketDate || sessionsBetween(entry.date, marketDate) >= CODE_WINDOW_SESSIONS) continue;
    lines.set(id, { id, symbol: entry.symbol, label: entry.label, market: null, duration: entry.duration, level: entry.level, approximate: false, product: entry.product, productLabel: entry.productLabel,
      publishedAt: entry.publishedAt, messageId: entry.messageId, excerpt: entry.excerpt, marketDate, reading: null, printedDate: entry.date, raw: entry.raw, unit: entry.unit,
      scope: MARKET_SYMBOLS.has(entry.symbol) ? 'market' : 'security', retain: false });
  }
  // The setup board reads the day's research first-hand and carries the published call.
  for (const line of boardLines) lines.set(line.id, { ...lines.get(line.id), ...line, printedDate: marketDate, scope: 'market', retain: true });
  return [...lines.values()].map(line => annotate(line, dated));
}
// The Market Structure editions, newest first, with the chart levels that passed verification.
function editionsOf(snapshots) {
  return (snapshots || []).filter(snapshot => snapshot?.date).map(snapshot => ({ snapshot, metrics: verifiedMarketStructureChartMetrics(snapshot) }))
    .sort((left, right) => (left.snapshot.date < right.snapshot.date ? 1 : -1));
}
// The newest dated flip line from either source, the chart first when both print that day.
function flipLine({ statements, editions, marketDate, price }) {
  const candidates = [
    ...editions.map(({ snapshot, metrics }) => ({ level: finite(metrics.spxProbableVolatilityGamma?.zeroGamma), date: metrics.spxProbableVolatilityGamma?.chartDate, chart: true, product: 'market-structure', productLabel: 'Market Structure', excerpt: `Zero gamma ${metrics.spxProbableVolatilityGamma?.zeroGamma}`, publishedAt: snapshot.publishedAt || null, messageId: null })),
    ...(statements?.flipLines || []).map(item => ({ level: finite(item.levels?.level), date: item.date, chart: false, product: item.sourceProduct || null, productLabel: item.sourceLabel || null, excerpt: item.sourceText || null, publishedAt: item.publishedAt || null, messageId: messageIdOf(item) })),
  ].filter(item => item.level !== null && item.date && item.date <= marketDate && near(item.level, price, FLIP_MAX_GAP))
    .sort((left, right) => (left.date === right.date ? Number(right.chart) - Number(left.chart) || rank(left.product) - rank(right.product) : left.date < right.date ? 1 : -1));
  const current = candidates[0];
  if (!current || sessionsBetween(current.date, marketDate) >= CODE_WINDOW_SESSIONS) return null;
  const previous = candidates.find(item => item.date < current.date && sessionsBetween(item.date, current.date) <= CODE_WINDOW_SESSIONS);
  return { id: '^GSPC|flip', symbol: '^GSPC', label: 'SPX', market: 'spx', duration: 'flip', level: current.level, product: current.product, productLabel: current.productLabel,
    publishedAt: current.publishedAt, messageId: current.messageId, excerpt: current.excerpt, marketDate, reading: null, printedDate: current.date, scope: 'market', retain: false,
    isNew: !previous, change: previous && previous.level !== current.level ? { from: previous.level, to: current.level, fromDate: previous.date } : null };
}
function pvBandLines({ editions, marketDate }) {
  const edition = editions.find(({ metrics }) => finite(metrics.spxProbableVolatilityGamma?.upperPvBand) !== null || finite(metrics.spxProbableVolatilityGamma?.lowerPvBand) !== null);
  const map = edition?.metrics.spxProbableVolatilityGamma;
  if (!map || sessionsBetween(map.chartDate, marketDate) > PV_BAND_SESSIONS) return [];
  return [['pvUpper', map.upperPvBand], ['pvLower', map.lowerPvBand]].filter(([, level]) => finite(level) !== null).map(([duration, level]) => ({
    id: `^GSPC|${duration}`, symbol: '^GSPC', label: 'SPX', market: 'spx', duration, level, product: 'market-structure', productLabel: 'Market Structure',
    publishedAt: edition.snapshot.publishedAt || null, messageId: null, excerpt: `PV band ${level}`, marketDate, reading: null, printedDate: map.chartDate, scope: 'market', retain: false }));
}
const BUCKET_NAMES = { investable: 'Investable', chop: 'Chop', fBucket: 'F Bucket' };
function vixLines({ marketDate, buckets = hermesRules.volatility.vixBuckets }) {
  return buckets.slice(1).map((bucket, index) => ({ id: `^VIX|${bucket.min}`, symbol: '^VIX', label: 'VIX', market: 'vix', duration: 'vix', level: bucket.min, band: VIX_BAND, marketDate, reading: null,
    product: 'process-rules', productLabel: 'VIX buckets', publishedAt: null, messageId: null, excerpt: null, scope: 'market', retain: false, printedDate: marketDate,
    above: { name: BUCKET_NAMES[bucket.key] || bucket.label, posture: bucket.posture }, below: { name: BUCKET_NAMES[buckets[index].key] || buckets[index].label, posture: buckets[index].posture } }));
}
/** What the newest Market Structure edition changed from the last edition printing each tile. */
function marketRegime(editions, spxPrice = null) {
  const signals = editions.filter(({ snapshot }) => Array.isArray(snapshot.data?.signals) && snapshot.data.signals.length).map(({ snapshot, metrics }) => ({ snapshot, metrics, tiles: new Map(snapshot.data.signals.map(tile => [tile.id, tile])) }));
  const latest = signals[0];
  if (!latest) return null;
  const changes = [...latest.tiles.values()].flatMap(tile => {
    const prior = signals.slice(1).find(edition => edition.tiles.has(tile.id));
    const before = prior?.tiles.get(tile.id);
    return before && before.value !== tile.value ? [{ id: tile.id, label: tile.label, from: before.value, to: tile.value, fromDate: prior.snapshot.date }] : [];
  });
  const throttle = latest.metrics.spxGammaVolatilityThrottle;
  return { date: latest.snapshot.date, publishedAt: latest.snapshot.publishedAt || null, chartUrl: buildPublicMarketStructureSnapshot(latest.snapshot)?.data?.signalMatrixImageUrl || null, tiles: Object.fromEntries([...latest.tiles.values()].map(tile => [tile.id, tile.value])), changes,
    gammaThrottle: finite(throttle?.gammaThrottle), throttleHistory: throttleHistory(editions, latest.snapshot.date), realizedVolatility: finite(throttle?.tenDayRealizedVolatility), spxPrice: finite(spxPrice), riskOff: riskOffSince(signals) };
}
// Every earlier throttle reading, oldest date included, to say how unusual the newest one is.
function throttleHistory(editions, latestDate) {
  const prior = editions.filter(({ snapshot }) => snapshot.date !== latestDate)
    .flatMap(({ snapshot, metrics }) => (finite(metrics.spxGammaVolatilityThrottle?.gammaThrottle) === null ? [] : [{ value: metrics.spxGammaVolatilityThrottle.gammaThrottle, date: snapshot.date }]));
  return prior.length ? { values: prior.map(item => item.value), since: prior.at(-1).date } : null;
}
// When the current Risk Off began, so the call stands until the tile turns back.
function riskOffSince(signals) {
  const value = edition => edition.tiles.get('strategicAllocation')?.value;
  if (value(signals[0]) !== 'Risk Off') return null;
  for (const [index, edition] of signals.entries()) {
    const earlier = signals.slice(index + 1).find(candidate => value(candidate));
    if (earlier && value(earlier) !== 'Risk Off') return { since: edition.snapshot.date, from: value(earlier) };
  }
  // Risk Off for longer than the editions read: still standing, dated to the oldest one.
  return { since: signals.at(-1).snapshot.date, from: 'Risk On' };
}
const formatLevel = (level, unit) => `${level.toLocaleString('en-US', { maximumFractionDigits: 2 })}${unit === '%' ? '%' : ''}`;
function coverageGaps({ editions, statements, unwatched, marketDate }) {
  const gaps = [];
  const edition = editions[0];
  if (edition && sessionsBetween(edition.snapshot.date, marketDate) <= 1 && finite(edition.metrics.spxProbableVolatilityGamma?.zeroGamma) === null) {
    gaps.push({ id: 'gamma-map', text: 'No readable gamma map in the latest Market Structure — flip line from prose only.' });
  }
  for (const item of statements?.unreadAlphaCodes || []) {
    if (sessionsBetween(item.date, marketDate) <= 1) gaps.push({ id: `unread:${item.sourceProduct}:${item.statement}`, text: `${item.sourceLabel || item.sourceProduct}: Alpha Code unparsed — "${String(item.statement).slice(0, 120).replace(/;/g, ',')}".` });
  }
  for (const item of unwatched.values()) {
    if (sessionsBetween(item.date, marketDate) >= CODE_WINDOW_SESSIONS) continue;
    if (item.reason === 'no-spot-quote') gaps.push({ id: `quote:${item.symbol}`, text: `${item.label} Alpha Code unwatched — no live spot quote.` });
    else gaps.push({ id: `quote:${item.symbol}:${item.duration}`, text: `${item.label} ${item.duration === 'trade' ? 'Trade' : 'Trend'} line ${formatLevel(item.level, item.levels?.unit)} unwatched — quote does not match the printed level.` });
  }
  return [...new Map(gaps.map(gap => [gap.id, gap])).values()];
}
/**
 * Everything the watch folds next. prices: { [symbol]: number } for the symbols levelSymbols names.
 */
function buildLevelWatch({ marketDate, boardLines = [], statements = null, marketStructure = [], prices = {} }) {
  const { entries, unwatched } = printedLevels(statements?.alphaCodes, prices);
  const editions = editionsOf(marketStructure);
  const lines = [...codeLines({ boardLines, entries, marketDate })];
  const flip = flipLine({ statements, editions, marketDate, price: finite(prices['^GSPC']) });
  if (flip) lines.push(flip);
  lines.push(...pvBandLines({ editions, marketDate }), ...vixLines({ marketDate }));
  return { lines, regime: marketRegime(editions, prices['^GSPC']), coverage: coverageGaps({ editions, statements, unwatched, marketDate }) };
}
/** Every symbol a level-watch build needs a price for before it can check printed levels. */
function levelSymbols(statements) {
  return [...new Set([...(statements?.alphaCodes || []).map(item => symbolFor(item.ticker)), '^GSPC', '^VIX'])];
}

module.exports = { CODE_WINDOW_SESSIONS, buildLevelWatch, levelSymbols, marketRegime, sessionsBetween };
