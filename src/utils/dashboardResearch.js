import catalog from '../constants/dashboardResearchCatalog.json';
import tickReferences from '../constants/dashboardTickResearchCatalog.json';
import { todayInNewYork } from './morningTldr';
import { isTradingDateKey, previousTradingDateKey } from './usEquityMarketCalendar.cjs';
import { normalizeDashboardCryptoResearch } from './dashboardCryptoResearch';
import { canonicalTradeResearch } from './canonicalTradeResearch.cjs';
import { normalizePublishedTickResearch } from './publishedTickResearch.cjs';

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const identity = (value) => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').toUpperCase() : '';
const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value || '')
  && Number.isFinite(Date.parse(`${value}T12:00:00Z`))
  && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
const directions = new Set(['BULLISH', 'BEARISH', 'NEUTRAL']);
export const DASHBOARD_RESEARCH_SYMBOLS = catalog.map((entry) => entry.symbol);
const rejectedFlags = [
  'mock', 'isMock', 'seed', 'seeded', 'isSeed', 'isSeeded', 'synthetic', 'inferred',
  'cacheOnly', 'cache_only', 'fromCache', 'stale', 'isStale', 'offline', 'disconnected', 'fallback',
];
const rejectedState = /(?:^|[\s_-])(?:unavailable|unverified|offline|disconnected|stale|expired|mock|seed|seeded|synthetic|inferred|cache|cached|cache-only|fallback|error|failed|portfolio|cost-basis|model)(?:$|[\s_-])/i;
const metadataFields = ['metadata', 'meta', 'provenance', 'quality', 'flags', 'providerStatus'];

// Inspect only the selected source/row. One unavailable product must never
// invalidate independent verified research or the dashboard's quote readings.
function invalidEvidence(record) {
  if (!isRecord(record)) return false;
  return rejectedFlags.some((flag) => record[flag] === true)
    || ['sourceVerified', 'verified', 'success', 'connected', 'available'].some((field) => record[field] === false)
    || ['status', 'sourceStatus', 'freshness', 'availability', 'cacheState', 'cacheStatus', 'source', 'provider']
      .some((field) => rejectedState.test(String(record[field] || '')))
    || metadataFields.some((field) => invalidEvidence(record[field]));
}

const identities = catalog.map((entry) => {
  const names = entry.names || [];
  const aliases = entry.aliases || [];
  return {
    symbol: entry.symbol,
    values: new Set([...aliases, ...names, ...names.flatMap((name) => aliases.map((alias) => `${name} (${alias})`))].map(identity)),
  };
});

/** Exact instrument identity, never ETF/index, spot/future, or reciprocal FX. */
export function dashboardResearchSymbol(key, row = {}) {
  const fields = [key, row.ticker, row.symbol, row.name, row.originalName].map(identity).filter(Boolean);
  if (!fields.length) return null;
  const matches = identities.filter((entry) => fields.every((value) => entry.values.has(value)));
  return matches.length === 1 ? matches[0].symbol : null;
}

// Separately identified published references may accompany an overview quote,
// with their different basis visible. They never become aliases of that quote.
function publishedReference(key, row) {
  const fields = [key, row.ticker, row.symbol, row.name, row.originalName].map(identity).filter(Boolean);
  for (const entry of catalog) {
    for (const reference of entry.publishedReferences || []) {
      const names = reference.names.map(identity);
      const values = new Set([...reference.aliases.map(identity), ...names]);
      if (fields.some((value) => names.includes(value)) && fields.every((value) => values.has(value))) {
        return { symbol: entry.symbol, basisLabel: reference.basisLabel, referenceInstrument: reference.label, referenceOnly: true };
      }
    }
  }
  return null;
}

export function dashboardResearchMarketDate(date = todayInNewYork()) {
  if (!validDate(date)) return null;
  return isTradingDateKey(date) ? date : previousTradingDateKey(date);
}

function normalizeRow(row, evidence, issues = []) {
  if (!isRecord(row) || invalidEvidence(row) || row.decisionEligible === false
    || (row.date != null && row.date !== evidence.date)
    || (row.asOf != null && (typeof row.asOf !== 'string' || row.asOf.slice(0, 10) !== evidence.date))) return null;
  const affectedFields = new Set(issues.flatMap((issue) => [issue.field, ...(issue.affectedFields || [])]));
  const trend = !affectedFields.has('trend') && directions.has(identity(row.trend)) ? identity(row.trend) : null;
  const validRange = !['riskRange', 'lrr', 'hrr'].some((field) => affectedFields.has(field))
    && typeof row.lrr === 'number' && Number.isFinite(row.lrr)
    && typeof row.hrr === 'number' && Number.isFinite(row.hrr) && row.lrr < row.hrr;
  if (!trend && !validRange) return null;
  return {
    ...evidence,
    trend,
    lrr: validRange ? row.lrr : null,
    hrr: validRange ? row.hrr : null,
    verified: true,
    trendEvidence: trend ? evidence : null,
    rangeEvidence: validRange ? evidence : null,
  };
}

function normalizeRows(rows, evidence, acceptRow = () => true, sourceIssues = []) {
  const matches = new Map();
  Object.entries(rows).forEach(([key, row]) => {
    if (!isRecord(row)) return;
    const reference = publishedReference(key, row);
    const symbol = dashboardResearchSymbol(key, row) || reference?.symbol;
    if (!symbol) return;
    const entries = matches.get(symbol) || [];
    const issues = [
      ...(Array.isArray(sourceIssues) ? sourceIssues : []).filter((issue) => identity(issue.ticker) === identity(key) || dashboardResearchSymbol(issue.ticker) === symbol),
      ...(Array.isArray(row.sourceQuality?.issues) ? row.sourceQuality.issues : []),
    ];
    entries.push(acceptRow(row) ? normalizeRow(row, { ...evidence, ...reference, sourceTicker: key }, issues) : null);
    matches.set(symbol, entries);
  });
  // Conflicting aliases are ambiguous, even when one row looks valid.
  return Object.fromEntries([...matches].filter(([, rowsForSymbol]) => rowsForSymbol.length === 1 && rowsForSymbol[0])
    .map(([symbol, rowsForSymbol]) => [symbol, rowsForSymbol[0]]));
}

export function normalizeDashboardRiskRanges(payload, { date = todayInNewYork() } = {}) {
  const manifest = payload?.manifest;
  const publicationDate = manifest?.publicationDate;
  if (!isRecord(payload) || invalidEvidence(payload) || !isRecord(manifest) || invalidEvidence(manifest)
    || payload.schemaVersion !== 1 || payload.available !== true || payload.status !== 'current'
    || manifest.persistedManifestVerified !== true || manifest.persistedCompletionState !== 'complete'
    || !validDate(publicationDate) || publicationDate !== manifest.expectedDate
    || publicationDate !== dashboardResearchMarketDate(date) || !isRecord(payload.ranges)
    || invalidEvidence(payload.ranges)) return {};

  return normalizeRows(payload.ranges, {
    date: publicationDate,
    source: 'Risk Ranges',
    sourceUrl: `/api/hedgeye/screenshot/${publicationDate}/content?type=risk-ranges`,
    sourceType: 'primary',
  }, (row) => row.provenance === 'primary'
    && ['hedgeye-risk-ranges-email', 'hedgeye-risk-range-email'].includes(row.source), payload.sourceQuality?.issues);
}

function earlyLookUrl(payload) {
  try {
    const url = new URL(payload.article?.feedUrl);
    return url.protocol === 'https:' && url.hostname === 'app.hedgeye.com'
      && !url.username && !url.password && !url.port && /^\/feed_items\/\d+\/?$/.test(url.pathname)
      ? url.href : null;
  } catch {
    return null;
  }
}

export function normalizeDashboardEarlyLook(payload, { date = todayInNewYork() } = {}) {
  const reportDate = dashboardResearchMarketDate(date);
  if (!reportDate || !isRecord(payload) || invalidEvidence(payload)
    || payload.source !== 'gmail-html' || payload.date !== reportDate) return {};
  const reportTypes = [payload.snapshotType, payload.reportType].filter((value) => value != null);
  if (!reportTypes.length || reportTypes.some((value) => value !== 'early-look')) return {};
  const sourceUrl = earlyLookUrl(payload);
  const htmlPrefix = `hedgeye-email/messages/${reportDate}/early-look/`;
  if (!sourceUrl || typeof payload.htmlSource !== 'string' || !payload.htmlSource.startsWith(htmlPrefix)
    || !/^[^/]+\.html$/.test(payload.htmlSource.slice(htmlPrefix.length))
    || !isRecord(payload.data) || invalidEvidence(payload.data)) return {};

  return normalizeRows(payload.data, { date: reportDate, source: 'Early Look', sourceUrl, sourceType: 'supplemental' }, undefined, payload.sourceQuality?.issues);
}

/** The server verifies the full archived article; preserve its dated evidence. */
export function normalizeDashboardNarrativeEnvelope(payload, { date = todayInNewYork() } = {}) {
  if (payload?.schemaVersion !== 1 || payload?.verified !== true || payload?.source !== 'early-look-archive'
    || !isRecord(payload.readings) || invalidEvidence(payload)) return {};
  return Object.fromEntries(Object.entries(payload.readings).filter(([symbol, reading]) => (
    catalog.some((entry) => entry.symbol === symbol)
    && reading?.verified === true && reading.source === 'Early Look' && reading.sourceType === 'narrative'
    && !invalidEvidence(reading) && validDate(reading.date) && reading.date <= date
    && directions.has(reading.trend) && typeof reading.evidenceText === 'string' && reading.evidenceText.trim()
    && earlyLookUrl({ article: { feedUrl: reading.sourceUrl } })
    && reading.trendEvidence?.sourceUrl === reading.sourceUrl && reading.trendEvidence?.date === reading.date
  )).map(([symbol, reading]) => [symbol, { ...reading, lrr: null, hrr: null, rangeEvidence: null }]));
}

/** The canonical projection owns source classification; preserve each Trade's
 * independent evidence and exact instrument identity in the overview. */
export function normalizeDashboardTradeResearch(payload, { date = todayInNewYork() } = {}) {
  if (payload?.schemaVersion !== 2 || !isRecord(payload.bySymbol)) return {};
  const readings = {};
  Object.entries(payload.bySymbol).forEach(([key, security]) => {
    const symbol = dashboardResearchSymbol(key);
    if (!symbol || !isRecord(security)) return;
    const signal = canonicalTradeResearch(payload, key, { date });
    if (signal.status !== 'available' || !signal.sourceLabel) return;
    const sourceTicker = signal.ticker;
    if (!sourceTicker || dashboardResearchSymbol(sourceTicker) !== symbol) return;
    const evidence = {
      date: signal.sourceDate, source: signal.sourceLabel, sourceUrl: signal.sourceUrl,
      sourceType: 'published-trade', sourceTicker, publishedAt: signal.sourcePublishedAt,
      evidenceText: signal.signalProvenance.sourceText,
      signalProvenance: signal.signalProvenance,
    };
    readings[symbol] = {
      ...evidence, verified: true, trade: signal.direction, tradeEvidence: evidence,
      trend: null, trendEvidence: null, lrr: null, hrr: null, rangeEvidence: null,
    };
  });
  return readings;
}

/** Tick is the independently published HedgAI position, including explicit Wait.
 * Historical batting averages qualify a strategy, not the publisher's reading.
 * Structured ETF references remain identified proxy context, never aliases. */
export function normalizeDashboardTickResearch(payload, { date = todayInNewYork(), asOf = `${date}T23:59:59.999Z` } = {}) {
  // Keep the full source roster available to security tables and detail views.
  // The overview's smaller instrument catalog only controls its exact aliases
  // and the separately identified ETF references attached below.
  const readings = normalizePublishedTickResearch(payload, { date, asOf });
  if (!Object.keys(readings).length) return {};
  const grouped = new Map();
  payload.book.rows.forEach((row) => {
    const symbol = dashboardResearchSymbol(row?.ticker);
    const matches = [
      ...(symbol ? [{ symbol, matchType: 'exact' }] : []),
      ...tickReferences.filter((reference) => reference.instrumentId === row?.instrumentId
        && reference.sourceTicker === row?.ticker),
    ];
    matches.forEach((match) => grouped.set(match.symbol, [...(grouped.get(match.symbol) || []), { row, match }]));
  });
  grouped.forEach((matches, symbol) => {
    const exact = matches.filter(({ match }) => match.matchType === 'exact');
    const candidates = exact.length ? exact : matches;
    if (candidates.length !== 1) { delete readings[symbol]; return; }
    const { row, match } = candidates[0];
    const direct = readings[row.ticker];
    if (!direct) return;
    const evidence = {
      ...direct.tickEvidence, matchType: match.matchType,
      referenceInstrument: match.matchType === 'proxy' ? row.ticker : undefined,
      basisLabel: match.basisLabel,
      basisRelationship: match.basisRelationship,
    };
    readings[symbol] = {
      ...direct, ...evidence, tickEvidence: evidence,
    };
  });
  return readings;
}

/** Newer independently published fields win; source order breaks same-day ties. */
export function mergeDashboardResearchReadings(...sources) {
  const readings = {};
  sources.forEach((source) => Object.entries(source).forEach(([symbol, incoming]) => {
    const current = readings[symbol];
    if (!current) { readings[symbol] = incoming; return; }
    const trendRow = incoming.trendEvidence && (!current.trendEvidence || incoming.trendEvidence.date > current.trendEvidence.date)
      ? incoming : current;
    const rangeRow = incoming.rangeEvidence && (!current.rangeEvidence || incoming.rangeEvidence.date > current.rangeEvidence.date)
      ? incoming : current;
    const tradeRow = incoming.tradeEvidence && (!current.tradeEvidence || incoming.tradeEvidence.date > current.tradeEvidence.date)
      ? incoming : current;
    const tickRow = incoming.tickEvidence && (!current.tickEvidence || incoming.tickEvidence.date > current.tickEvidence.date
      || (incoming.tickEvidence.date === current.tickEvidence.date
        && Date.parse(incoming.tickEvidence.publishedAt) > Date.parse(current.tickEvidence.publishedAt)))
      ? incoming : current;
    const tickEvidence = tickRow.tickEvidence;
    const tradeEvidence = tradeRow.tradeEvidence;
    const trendEvidence = trendRow.trendEvidence;
    const rangeEvidence = rangeRow.rangeEvidence;
    readings[symbol] = {
      ...current,
      tick: tickRow.tick,
      tickEvidence,
      trade: tradeRow.trade,
      tradeEvidence,
      trend: trendRow.trend,
      lrr: rangeRow.lrr,
      hrr: rangeRow.hrr,
      trendEvidence,
      rangeEvidence,
      date: [tickEvidence?.date, tradeEvidence?.date, trendEvidence?.date, rangeEvidence?.date].filter(Boolean).sort().at(-1),
      basisLabel: rangeEvidence?.basisLabel || null,
      source: [...new Set([tickEvidence?.source, tradeEvidence?.source, trendEvidence?.source, rangeEvidence?.source].filter(Boolean))].join(' · '),
    };
  }));
  return readings;
}

export function normalizeDashboardResearch({ riskRanges, earlyLook, cryptoTracker, cryptoQuant, narrative, intelligence, hedgai } = {}, options = {}) {
  const archivedCrypto = narrative?.schemaVersion === 1 && narrative?.verified === true
    && narrative?.source === 'early-look-archive' && !invalidEvidence(narrative)
    && Array.isArray(narrative.cryptoPublications) ? narrative.cryptoPublications : [];
  return mergeDashboardResearchReadings(
    normalizeDashboardRiskRanges(riskRanges, options),
    normalizeDashboardEarlyLook(earlyLook, options),
    normalizeDashboardCryptoResearch(cryptoQuant, options),
    normalizeDashboardCryptoResearch(cryptoTracker, options),
    ...archivedCrypto.map((publication) => normalizeDashboardCryptoResearch(publication, options)),
    normalizeDashboardNarrativeEnvelope(narrative, options),
    normalizeDashboardTradeResearch(intelligence, options),
    normalizeDashboardTickResearch(hedgai, options),
  );
}
