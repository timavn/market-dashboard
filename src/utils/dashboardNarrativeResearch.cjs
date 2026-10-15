const catalog = require('../constants/dashboardNarrativeResearchCatalog.json');

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value || '')
  && Number.isFinite(Date.parse(`${value}T12:00:00Z`))
  && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
const today = () => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());
const rejectedFlags = [
  'mock', 'isMock', 'seed', 'seeded', 'isSeed', 'isSeeded', 'synthetic', 'inferred',
  'cacheOnly', 'cache_only', 'fromCache', 'stale', 'isStale', 'offline', 'disconnected', 'fallback',
];
const rejectedState = /(?:^|[\s_-])(?:unavailable|unverified|offline|disconnected|stale|expired|mock|seed|seeded|synthetic|inferred|cache|cached|fallback|error|failed|portfolio|cost-basis|model)(?:$|[\s_-])/i;
const metadataFields = ['metadata', 'meta', 'provenance', 'quality', 'sourceQuality', 'flags', 'providerStatus'];
const rejectedLanguage = /\b(?:if|unless|could|would|should|may|might|will|expect(?:s|ed)?|forecast|assuming|scenario|previously|formerly|historically|old|prior|not|never|no longer|used to|last year|ETF|fund|Teucrium)\b|["“”‘’?]|\(CORN\)/i;
const patterns = catalog.map((entry) => ({
  ...entry,
  pattern: new RegExp(`^${entry.subjectPattern} ${entry.performancePrefixPattern}${entry.currentStatementPattern}(BULLISH|BEARISH|NEUTRAL) (?:TRADE (?:and|&) )?TREND\\b`, 'i'),
}));

function invalidEvidence(record) {
  if (!isRecord(record)) return false;
  return rejectedFlags.some((flag) => record[flag] === true)
    || ['sourceVerified', 'verified', 'success', 'connected', 'available'].some((field) => record[field] === false)
    || ['status', 'sourceStatus', 'freshness', 'availability', 'cacheState', 'cacheStatus', 'source', 'provider']
      .some((field) => rejectedState.test(String(record[field] || '')))
    || metadataFields.some((field) => invalidEvidence(record[field]));
}

function verifiedSource(snapshot, date) {
  if (!isRecord(snapshot) || invalidEvidence(snapshot) || !validDate(snapshot.date)
    || snapshot.date > date || snapshot.source !== 'gmail-html'
    || snapshot.snapshotType !== 'early-look'
    || (snapshot.reportType != null && snapshot.reportType !== 'early-look')
    || !isRecord(snapshot.article) || invalidEvidence(snapshot.article)
    || typeof snapshot.article.bodyText !== 'string') return null;
  const prefix = `hedgeye-email/messages/${snapshot.date}/early-look/`;
  if (typeof snapshot.htmlSource !== 'string' || !snapshot.htmlSource.startsWith(prefix)
    || !/^[^/]+\.html$/.test(snapshot.htmlSource.slice(prefix.length))) return null;
  try {
    const url = new URL(snapshot.article.feedUrl);
    if (url.protocol !== 'https:' || url.hostname !== 'app.hedgeye.com' || url.username
      || url.password || url.port || !/^\/feed_items\/\d+\/?$/.test(url.pathname)) return null;
    return url.href;
  } catch { return null; }
}

function statements(snapshot, sourceUrl) {
  const candidates = {};
  const paragraphs = snapshot.article.bodyText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  paragraphs.forEach((raw, index) => {
    const evidenceText = raw.trim().replace(/^[•*-]\s+/, '').replace(/\s+/g, ' ');
    if (!evidenceText || evidenceText.length > 600 || rejectedLanguage.test(evidenceText)) return;
    if (index > 0 && /\b(?:quoted?|wrote|previous|earlier|old|historical)\b.*:\s*$/i.test(paragraphs[index - 1])) return;
    patterns.forEach((entry) => {
      const match = entry.pattern.exec(evidenceText);
      if (!match) return;
      // A second directional claim in the paragraph is ambiguous; never pick
      // one out of a transition or a comparison with an old signal.
      if ([...evidenceText.matchAll(/\b(?:BULLISH|BEARISH|NEUTRAL)\b/gi)].length !== 1) return;
      const issues = Array.isArray(snapshot.sourceQuality?.issues) ? snapshot.sourceQuality.issues : [];
      if (issues.some((issue) => [entry.symbol, entry.sourceTicker].includes(String(issue.ticker || '').toUpperCase())
        && [issue.field, ...(issue.affectedFields || [])].some((field) => ['trend', 'narrative'].includes(field)))) return;
      const evidence = {
        date: snapshot.date, source: 'Early Look', sourceType: 'narrative', sourceUrl,
        sourceTicker: entry.sourceTicker, sourceInstrument: entry.sourceInstrument, evidenceText,
        referenceOnly: true,
        ...(entry.basisLabel ? { basisLabel: entry.basisLabel, basisRelationship: entry.basisRelationship } : {}),
      };
      const reading = {
        ...evidence, verified: true, trend: match[1].toUpperCase(), lrr: null, hrr: null,
        trendEvidence: evidence, rangeEvidence: null,
      };
      (candidates[entry.symbol] ||= []).push(reading);
    });
  });
  return Object.fromEntries(Object.entries(candidates).filter(([, rows]) => new Set(rows.map((row) => row.trend)).size === 1)
    .map(([symbol, rows]) => [symbol, rows[0]]));
}

/** Dated published statements only. An omitted asset is not a signal change. */
function normalizeDashboardNarrativeResearch(snapshots, { date = today() } = {}) {
  if (!Array.isArray(snapshots) || !validDate(date)) return {};
  const bySymbol = {};
  snapshots.forEach((snapshot) => {
    const sourceUrl = verifiedSource(snapshot, date);
    if (!sourceUrl) return;
    Object.entries(statements(snapshot, sourceUrl)).forEach(([symbol, reading]) => {
      const rows = bySymbol[symbol] ||= [];
      rows.push(reading);
    });
  });
  return Object.fromEntries(Object.entries(bySymbol).flatMap(([symbol, rows]) => {
    const latestDate = rows.map((row) => row.date).sort().at(-1);
    const latest = rows.filter((row) => row.date === latestDate);
    if (new Set(latest.map((row) => row.trend)).size !== 1) return [];
    return [[symbol, latest[0]]];
  }));
}

module.exports = { normalizeDashboardNarrativeResearch };
