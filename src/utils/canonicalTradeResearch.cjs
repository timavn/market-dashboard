const { isExplicitTradeProvenance, sameSignalInstrument } = require('./publishedResearchSignals.cjs');
const DIRECTIONS = new Set(['BULLISH', 'BEARISH', 'NEUTRAL']);
const UNSAFE_FLAGS = ['mock', 'isMock', 'seed', 'isSeed', 'seeded', 'isSeeded', 'synthetic', 'inferred', 'cacheOnly', 'cache_only', 'cachedOnly', 'stale', 'isStale', 'offline', 'disconnected', 'refreshFailed'];

const dateKey = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return null;
  const parsed = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : null;
};
const unsafe = (value) => value && typeof value === 'object' && (
  UNSAFE_FLAGS.some((flag) => value[flag] === true)
  || value.verified === false || value.sourceVerified === false || value.connected === false || Boolean(value.refreshIssue)
  || /(?:^|[\s_-])(?:mock|seeded?|synthetic|inferred|unverified|cache[-_ ]?only|offline|disconnected|stale|failed|error)(?:$|[\s_-])/i
    .test([value.source, value.provenance, value.freshness, value.cacheState, value.status, value.qualityStatus, value.providerStatus].filter((field) => typeof field === 'string').join(' '))
  || ['metadata', 'meta', 'quality', 'flags', 'providerStatus'].some((key) => unsafe(value[key]))
);
function sourceUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'app.hedgeye.com' && !url.username && !url.password
      && !url.port && /^\/feed_items\/\d+\/?$/.test(url.pathname);
  } catch { return false; }
}

/** Project canonical, independently evidenced Trade without changing its date. */
function canonicalTradeResearch(payload, ticker, { date = payload?.marketDate, sameSession = false } = {}) {
  const symbol = String(ticker || '').trim().toUpperCase();
  const empty = {
    status: 'unavailable', direction: null, raw: null, ticker: symbol,
    date: null, source: null, sourceUrl: null, asOf: null, expiresAt: null,
    reason: `A verified published ${symbol} Trade signal is unavailable.`,
  };
  if (payload?.schemaVersion !== 2 || unsafe(payload) || !dateKey(date)) return empty;
  const aliases = Object.entries(payload.bySymbol || {}).filter(([key]) => sameSignalInstrument(key, symbol));
  const security = payload.bySymbol?.[symbol] || (aliases.length === 1 ? aliases[0][1] : null);
  if (!security || unsafe(security)) return empty;
  const current = security.decision?.trade;
  const retained = security.lastVerifiedDecision?.trade;
  if (current?.status === 'conflict' || retained?.status === 'conflict') return empty;
  const evidence = [current, retained].filter((field) => field
    && ['available', 'historical'].includes(field.status) && !unsafe(field)
    && DIRECTIONS.has(field.value) && field.sourceId && sourceUrl(field.sourceUrl)
    && dateKey(field.sourceDate) && field.sourceDate <= date
    && sameSignalInstrument(field.sourceTicker || field.ticker, symbol)
    && isExplicitTradeProvenance(field.signalProvenance))
    .sort((left, right) => String(right.publishedAt || right.sourceDate).localeCompare(String(left.publishedAt || left.sourceDate)))[0];
  if (!evidence) return empty;
  if (sameSession && evidence.sourceDate !== date) return {
    ...empty, date: evidence.sourceDate,
    reason: `A same-session published ${symbol} Trade signal is unavailable.`,
  };
  // Legacy daily snapshots use UTC midnight when only a publication date is
  // known. Do not convert that placeholder into the prior local market date.
  const publishedAt = /T00:00:00(?:\.000)?(?:Z|\+00:00)$/.test(String(evidence.publishedAt || ''))
    ? null : evidence.publishedAt || null;
  return {
    status: 'available', direction: evidence.value, raw: evidence.value,
    ticker: evidence.sourceTicker || evidence.ticker,
    date: evidence.sourceDate, source: evidence.sourceId, sourceLabel: evidence.sourceLabel,
    sourceUrl: evidence.sourceUrl, sourceDate: evidence.sourceDate,
    sourcePublishedAt: publishedAt, sourceEventId: evidence.sourceEventId || null,
    asOf: publishedAt || evidence.sourceDate, expiresAt: null,
    signalProvenance: evidence.signalProvenance,
    retainedPublication: evidence.sourceDate !== date,
    contextOnly: true, decisionEligible: false, executable: false, reason: null,
  };
}

module.exports = { canonicalTradeResearch };
