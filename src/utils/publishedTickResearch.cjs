const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const identity = (value) => typeof value === 'string' ? value.trim().toUpperCase() : '';
const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value || '')
  && Number.isFinite(Date.parse(`${value}T12:00:00Z`))
  && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
const marketDate = (value) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date(value));
const rejectedFlags = [
  'mock', 'isMock', 'seed', 'seeded', 'isSeed', 'isSeeded', 'synthetic', 'inferred',
  'cacheOnly', 'cache_only', 'fromCache', 'stale', 'isStale', 'offline', 'disconnected', 'fallback',
];
const rejectedState = /(?:^|[\s_-])(?:unavailable|unverified|offline|disconnected|stale|expired|mock|seed|seeded|synthetic|inferred|cache|cached|cache-only|fallback|error|failed|portfolio|cost-basis|model)(?:$|[\s_-])/i;
function invalidEvidence(record) {
  if (!isRecord(record)) return false;
  return rejectedFlags.some((flag) => record[flag] === true)
    || ['sourceVerified', 'verified', 'success', 'connected', 'available'].some((field) => record[field] === false)
    || ['status', 'sourceStatus', 'freshness', 'availability', 'cacheState', 'cacheStatus', 'source', 'provider']
      .some((field) => rejectedState.test(String(record[field] || '')))
    || ['metadata', 'meta', 'provenance', 'quality', 'flags', 'providerStatus'].some((field) => invalidEvidence(record[field]));
}
function verifiedSourceUrl(value) {
  if (/^\/api\/research\/hedgai\/source\/hedgai-image-[a-f0-9]{64}$/.test(value || '')) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'app.hedgeye.com'
      && !url.username && !url.password && !url.port && /^\/feed_items\/\d+\/?$/.test(url.pathname);
  } catch { return false; }
}

/** Every verified source-listed position is Tick, independently of its strategy
 * statistics. This projection owns exact published tickers only; ETF references
 * are attached separately by consumers using their structured mapping catalog. */
function normalizePublishedTickResearch(payload, {
  date = marketDate(new Date()), asOf = `${date}T23:59:59.999Z`,
} = {}) {
  const cutoff = Date.parse(asOf);
  const captured = Date.parse(payload?.asOf);
  if (payload?.version !== 1 || payload.product !== 'hedgai-signals' || invalidEvidence(payload)
    || payload.fixture === true || invalidEvidence(payload.book) || invalidEvidence(payload.sourceQuality)
    || !validDate(date) || !validDate(payload.baselineDate) || payload.baselineDate > date
    || !Number.isFinite(cutoff) || !Number.isFinite(captured) || captured > cutoff
    || !Array.isArray(payload.book?.rows) || !Array.isArray(payload.sources)
    || marketDate(captured) !== date) return {};
  const sources = new Map(payload.sources.filter((source) => (
    isRecord(source) && !invalidEvidence(source) && source.fixture !== true
    && !rejectedState.test(String(source.sourceType || '')) && source.id
    && source.publicationTimeVerified !== false && validDate(source.publicationDate)
    && source.publicationDate <= date && Number.isFinite(Date.parse(source.publishedAt))
    && Date.parse(source.publishedAt) <= captured && verifiedSourceUrl(source.sourceUrl)
  )).map((source) => [source.id, source]));
  const issues = Array.isArray(payload.sourceQuality?.issues) ? payload.sourceQuality.issues : [];
  const blocking = issues.filter((issue) => issue?.blocking === true);
  if (payload.sourceQuality?.continuity !== 'complete' && !blocking.length) return {};
  const ids = new Set(payload.book.rows.map((row) => row?.instrumentId));
  const grouped = new Map();
  payload.book.rows.forEach((row) => {
    if (!isRecord(row) || !/^[A-Z][A-Z0-9./=^_-]{0,15}$/.test(row.ticker || '')) return;
    grouped.set(row.ticker, [...(grouped.get(row.ticker) || []), row]);
  });
  const readings = {};
  grouped.forEach((rows, ticker) => {
    if (rows.length !== 1) return;
    const row = rows[0];
    const tick = { Buy: 'BULLISH', Short: 'BEARISH', Wait: 'NEUTRAL' }[row.position];
    const metricsDate = row.metricsDate || payload.metricsDate;
    if (invalidEvidence(row) || row.fixture === true || row.status !== 'current' || !tick
      || row.instrumentId !== `hedgai:${ticker}`
      || (row.activeDirection != null && identity(row.activeDirection) !== tick)
      || blocking.some((issue) => !issue.instrumentId || !ids.has(issue.instrumentId) || issue.instrumentId === row.instrumentId)) return;
    const positionIds = Array.isArray(row.positionSourceIds) ? row.positionSourceIds : [];
    const metricIds = Array.isArray(row.metricsSourceIds) ? row.metricsSourceIds : [];
    const positionSources = positionIds.map((id) => sources.get(id)).filter(Boolean);
    const metricSources = metricIds.map((id) => sources.get(id)).filter(Boolean);
    if (!positionSources.length || positionSources.length !== positionIds.length) return;
    const hasMetrics = validDate(metricsDate) && metricsDate <= date && !invalidEvidence(row.metrics)
      && !Object.values(row.metrics || {}).some(invalidEvidence)
      && metricSources.length > 0 && metricSources.length === metricIds.length
      && metricSources.some((source) => source.publicationDate === metricsDate);
    const source = [...positionSources].sort((left, right) => Date.parse(right.publishedAt) - Date.parse(left.publishedAt))[0];
    const actions = [...(Array.isArray(payload.changes) ? payload.changes : []),
      ...(Array.isArray(payload.reaffirmations) ? payload.reaffirmations : [])]
      .filter((action) => action?.instrumentId === row.instrumentId && action.sourceIds?.includes(source.id));
    const evidence = {
      source: 'HedgAI Signals', date: source.publicationDate, sourceUrl: source.sourceUrl,
      sourceType: 'published-tick', sourceTicker: ticker, instrumentId: row.instrumentId,
      sourceLabel: row.sourceLabel || ticker, sourceInstrument: row.sourceLabel || ticker,
      publishedAt: source.publishedAt, asOf: payload.asOf,
      evidenceText: actions.map((action) => action.sourceText).filter(Boolean).join(' · ')
        || source.excerpt || `${row.sourceLabel || ticker}: ${row.position}`,
      position: row.position, initiatedAt: row.initiatedAt, lastConfirmedAt: row.lastConfirmedAt,
      metricsDate: hasMetrics ? metricsDate : null, metrics: hasMetrics ? row.metrics : null,
      threshold: payload.threshold, positionSources, metricSources: hasMetrics ? metricSources : [],
      modelThreshold: row.modelThreshold, zScores: row.zScores, zScoreOrder: row.zScoreOrder,
      sourceGroup: row.group,
      sourceQuality: payload.sourceQuality, matchType: 'exact',
      contextOnly: true, decisionEligible: false, executable: false,
    };
    readings[ticker] = {
      ...evidence, verified: true, tick, tickEvidence: evidence,
      trend: null, trendEvidence: null, lrr: null, hrr: null, rangeEvidence: null,
    };
  });
  return readings;
}

function selectPublishedTickResearch(payload, ticker, options) {
  return normalizePublishedTickResearch(payload, options)[identity(ticker)] || null;
}

module.exports = { normalizePublishedTickResearch, selectPublishedTickResearch };
