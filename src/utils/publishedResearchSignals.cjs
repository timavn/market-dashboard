const instrumentCatalog = require('../constants/dashboardResearchCatalog.json');
const { researchStatements, unreadAlphaCodes, claimedValues, FORBIDDEN } = require('./researchStatements.cjs');
const { publicationTime } = require('./researchPublicationTime.cjs');

const record = (value) => value && typeof value === 'object' && !Array.isArray(value);
const bias = (value) => /^(BULLISH|BEARISH|NEUTRAL)$/i.test(String(value || '').trim())
  ? String(value).trim().toUpperCase() : null;
const symbol = (value) => String(value || '').trim().toUpperCase();
const reject = (value) => record(value) && (
  ['mock', 'isMock', 'seed', 'seeded', 'isSeeded', 'synthetic', 'inferred',
    'cacheOnly', 'cache_only', 'fromCache', 'stale', 'isStale', 'offline', 'disconnected', 'fallback'].some((key) => value[key] === true)
  || value.verified === false || value.sourceVerified === false
  || ['qualityStatus', 'status', 'sourceStatus', 'freshness', 'cacheState', 'cacheStatus', 'source', 'provider']
    .some((field) => /(?:^|[\s_-])(?:mock|seeded|synthetic|inferred|unverified|offline|disconnected|stale|cache|cached|error|failed)(?:$|[\s_-])/i.test(String(value[field] || '')))
  || ['metadata', 'meta', 'provenance', 'quality', 'sourceQuality', 'flags', 'providerStatus'].some((field) => reject(value[field]))
);

// This catalog's aliases identify the same instrument. Research exposure aliases
// intentionally group SPX/SPY, GOLD/GLD, etc. and cannot identify a Trade signal.
const exactAliases = new Map();
instrumentCatalog.forEach((entry) => (entry.aliases || []).forEach((alias) => exactAliases.set(symbol(alias), entry.symbol)));
function sameSignalInstrument(left, right) {
  const a = symbol(left), b = symbol(right);
  return Boolean(a && b && (a === b || (exactAliases.get(a) && exactAliases.get(a) === exactAliases.get(b))));
}

function isExplicitTradeProvenance(value) {
  return Boolean(record(value) && value.field === 'trade'
    && ['explicit-field', 'explicit-statement'].includes(value.method)
    && typeof value.sourceField === 'string' && value.sourceField.trim()
    && typeof value.sourceText === 'string' && value.sourceText.trim()
    && (value.method !== 'explicit-field' || /(?:^|\.)(?:trade|tradeSignal|tradeBias)$/i.test(value.sourceField))
    && (value.method !== 'explicit-statement' || (!FORBIDDEN.test(value.sourceText)
      && claimedValues(value.sourceText, 'trade').length > 0)));
}

function metadata(snapshot) {
  return {
    sourceProduct: snapshot.snapshotType || snapshot.productId || snapshot.productKey || null,
    sourceLabel: snapshot.productLabel || snapshot.sourceLabel || null,
    sourceUrl: snapshot.article?.feedUrl || snapshot.sourceUrl || null,
    date: snapshot.date || snapshot.marketDate || null,
    publishedAt: publicationTime(snapshot),
    sourceEventId: snapshot.sourceEventId || snapshot.gmailMessageId || snapshot.sourceMessageId || null,
  };
}

function isVerifiedPublicationSnapshot(snapshot) {
  if (!record(snapshot) || reject(snapshot) || !/^\d{4}-\d{2}-\d{2}$/.test(snapshot.date || '')) return false;
  const date = new Date(`${snapshot.date}T12:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== snapshot.date) return false;
  const artifact = snapshot.htmlSource || snapshot.pdfSource || snapshot.pdfS3Key;
  if (typeof artifact !== 'string' || !artifact.trim()) return false;
  const types = [snapshot.snapshotType, snapshot.reportType, snapshot.sourceProduct].filter(Boolean);
  if (types.includes('bitcoin-trend-tracker')) types.push('crypto-quant');
  if (snapshot.htmlSource) {
    if (!types.some((type) => {
      const prefix = `hedgeye-email/messages/${snapshot.date}/${type}/`;
      return artifact.startsWith(prefix) && /^[^/]+\.html$/.test(artifact.slice(prefix.length));
    })) return false;
  } else if (!artifact.startsWith(`hedgeye-pdfs/${snapshot.date}/`) || !/\.pdf$/i.test(artifact)) return false;
  if (reject(snapshot.article)) return false;
  try {
    const url = new URL(snapshot.article?.feedUrl || snapshot.sourceUrl);
    return url.protocol === 'https:' && url.hostname === 'app.hedgeye.com'
      && !url.username && !url.password && !url.port && /^\/feed_items\/\d+\/?$/.test(url.pathname);
  } catch { return false; }
}

function reading(meta, ticker, value, fieldPath, sourceText, method, extra = {}) {
  return {
    ...meta, ticker: symbol(ticker), sourceTicker: symbol(ticker), value, field: 'trade', fieldPath, sourceText,
    signalProvenance: { field: 'trade', sourceField: fieldPath, method, sourceText }, ...extra,
  };
}

function explicitRow(row, ticker, fieldPath, meta) {
  if (!record(row) || !ticker || reject(row)) return [];
  const result = [];
  ['trade', 'tradeSignal', 'tradeBias'].forEach((field) => {
    if ((row.withheldFields || []).includes(field)) return;
    const value = bias(record(row[field]) ? row[field].value : row[field]);
    if (!value) return;
    const provenance = row[field]?.signalProvenance || row.signalProvenance;
    // Old tracker materializations copied Trend into trade. Only provenance
    // from an independently labeled Trade field can rehabilitate those rows.
    if (['momo-tracker', 'bitcoin-trend-tracker', 'crypto-quant'].includes(meta.sourceProduct)
      && !isExplicitTradeProvenance(provenance)) return;
    const sourceText = provenance?.sourceText || `${ticker}: ${field} ${value}`;
    result.push(reading(meta, ticker, value, provenance?.sourceField || `${fieldPath}.${field}`,
      sourceText, 'explicit-field'));
  });
  return result;
}

// A statement about a spot commodity or other published reference keeps that
// identity apart from any security sharing its code (Gold spot is not GOLD the
// stock, Corn the commodity is not the CORN ETF).
function identityFields(item) {
  if (item.kind === 'reference') {
    return { sourceInstrument: item.sourceInstrument, basisLabel: item.basisLabel, basisRelationship: item.basisRelationship,
      instrumentKey: `reference:${item.ticker}`, referenceOnly: true };
  }
  return item.sourceInstrument ? { sourceInstrument: item.sourceInstrument } : {};
}

/** Every subject-bound TRADE statement in a text, by the shared research grammar. */
// Each reading keeps the whole sentence it was read from, so it can be read
// again with the conditions and neighbouring clauses its span leaves out.
function tradeStatements(text, meta = {}, fieldPath = 'article.bodyText') {
  return researchStatements(text).filter((item) => item.field === 'trade').map((item) => reading(
    meta, item.ticker, item.value, fieldPath, item.sourceText, 'explicit-statement', { ...identityFields(item), statement: item.statement }));
}

/** Stated TREND directions and Alpha Code levels, with the clause that states each. */
function statementReadings(text, meta = {}, fieldPath = 'article.bodyText') {
  return researchStatements(text).filter((item) => item.field !== 'trade').map((item) => ({
    ...meta, ticker: symbol(item.ticker), sourceTicker: symbol(item.ticker), field: item.field, fieldPath,
    sourceText: item.sourceText, statement: item.statement,
    ...(item.field === 'trend' ? { value: item.value,
      signalProvenance: { field: 'trend', sourceField: fieldPath, method: 'explicit-statement', sourceText: item.sourceText } }
      : { levels: item.levels }),
    ...identityFields(item),
  }));
}

// The prose a publication carries. Top 3 Things repeats its items in the
// body; a statement read from both is kept once. A monthly review ("ETF Pro
// Plus: August Update") retells last month in the past tense and quotes old
// ranges, so its prose states no current signal.
const MONTHLY_REVIEW = /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+Update\b/i;
function proseFields(snapshot) {
  const article = record(snapshot.article) ? snapshot.article : {};
  if (MONTHLY_REVIEW.test(article.headline || '')) return [];
  const fields = ['bodyText', 'summary', 'headline', 'teaser'].map((field) => [`article.${field}`, article[field]]);
  (Array.isArray(article.keyTakeaways) ? article.keyTakeaways : [])
    .forEach((text, index) => fields.push([`article.keyTakeaways[${index}]`, text]));
  (Array.isArray(snapshot.data?.items) ? snapshot.data.items : [])
    .forEach((item, index) => fields.push([`data.items[${index}].body`, item?.body]));
  return fields.filter(([, text]) => typeof text === 'string' && text.trim());
}
const statementKey = (item) => `${item.field}:${item.sourceTicker}:${item.instrumentKey || ''}:${item.value || JSON.stringify(item.levels)}:${item.sourceText}`;
const once = (items) => [...new Map(items.map((item) => [statementKey(item), item])).values()];

function extractPublishedTradeSignals(snapshot, { sourceVerified = false } = {}) {
  if (!record(snapshot) || reject(snapshot)) return [];
  if (!sourceVerified && !isVerifiedPublicationSnapshot(snapshot)) return [];
  const meta = metadata(snapshot), result = [];
  const walk = (value, path, key = '') => {
    if (Array.isArray(value)) return value.forEach((row, index) => walk(row, `${path}[${index}]`));
    if (!record(value) || reject(value)) return;
    const ticker = value.sourceTicker || value.ticker || value.symbol || value.asset
      || (/^[A-Z][A-Z0-9./=^_-]{0,15}$/.test(key) ? key : null);
    result.push(...explicitRow(value, ticker, path, meta));
    Object.entries(value).forEach(([childKey, child]) => {
      if (!['signalProvenance', 'sourceQuality', 'metadata'].includes(childKey)) walk(child, `${path}.${childKey}`, childKey);
    });
  };
  walk(snapshot.data, 'data');
  const structured = [...new Map(result.map((item) => [`${item.ticker}:${item.value}:${item.fieldPath}:${item.sourceText}`, item])).values()];
  const stated = once(proseFields(snapshot).flatMap(([field, text]) => tradeStatements(text, meta, field)));
  return withoutQualityIssues(snapshot, [...structured, ...stated].filter((item) => !item.basisLabel), TRADE_FIELDS);
}

const TRADE_FIELDS = ['trade', 'tradeSignal', 'tradeBias', 'narrative'];
function withoutQualityIssues(snapshot, items, fields) {
  return items.filter((item) => !(snapshot.sourceQuality?.issues || []).some((issue) =>
    sameSignalInstrument(issue.ticker, item.sourceTicker)
    && [issue.field, ...(issue.affectedFields || [])].some((field) => fields.includes(field))));
}

/**
 * The day's published statements in one verified publication: security Trade
 * (as extractPublishedTradeSignals), Trade for published references such as
 * Gold spot, stated TREND directions, and Alpha Code levels.
 */
function extractPublishedStatements(snapshot, { sourceVerified = false } = {}) {
  const empty = { trade: [], references: [], trends: [], alphaCodes: [], flipLines: [], unreadAlphaCodes: [] };
  if (!record(snapshot) || reject(snapshot)) return empty;
  if (!sourceVerified && !isVerifiedPublicationSnapshot(snapshot)) return empty;
  const meta = metadata(snapshot);
  const prose = proseFields(snapshot);
  const references = once(prose.flatMap(([field, text]) => tradeStatements(text, meta, field)))
    .filter((item) => item.referenceOnly === true);
  const others = once(prose.flatMap(([field, text]) => statementReadings(text, meta, field)));
  return {
    trade: extractPublishedTradeSignals(snapshot, { sourceVerified: true }),
    references: withoutQualityIssues(snapshot, references, TRADE_FIELDS),
    trends: withoutQualityIssues(snapshot, others.filter((item) => item.field === 'trend'), ['trend', 'narrative']),
    alphaCodes: withoutQualityIssues(snapshot, others.filter((item) => item.field === 'alphaCode'), ['lrr', 'hrr', 'narrative']),
    flipLines: withoutQualityIssues(snapshot, others.filter((item) => item.field === 'flipLine'), ['narrative']),
    // Sentences printing a code the grammar could not read: a Systems gap, never a signal.
    unreadAlphaCodes: [...new Set(prose.flatMap(([, text]) => unreadAlphaCodes(text)))].map((statement) => ({ ...meta, statement })),
  };
}

const sameLevels = (left, right) => ['raw', 'trade', 'trend', 'unit'].every((key) => (left?.[key] ?? null) === (right?.[key] ?? null));
/** The stored reading is what its sentence (or, for older readings, its span) still states. */
function restates(item) {
  const fromStatement = typeof item.statement === 'string' && item.statement.trim();
  return researchStatements(fromStatement ? item.statement : item.sourceText).some((statement) => statement.field === item.field
    && symbol(statement.ticker) === symbol(item.sourceTicker)
    && (statement.kind === 'reference') === (item.referenceOnly === true)
    && (!fromStatement || statement.sourceText === item.sourceText)
    && (['alphaCode', 'flipLine'].includes(item.field) ? sameLevels(statement.levels, item.levels) : statement.value === item.value));
}
// Archive replies re-check the same readings on every load; remember the verdicts.
const statedVerdicts = new Map();
/** A stored Trend, reference Trade or Alpha Code reading its own source text still states. */
function isStatedReading(item) {
  if (!record(item) || reject(item) || typeof item.sourceText !== 'string' || !item.sourceText.trim()) return false;
  if (item.field === 'trend' && (item.signalProvenance?.field !== 'trend' || item.signalProvenance?.method !== 'explicit-statement'
    || item.signalProvenance.sourceText !== item.sourceText || FORBIDDEN.test(item.sourceText))) return false;
  if (item.field === 'trade' && (!isExplicitTradeProvenance(item.signalProvenance) || item.referenceOnly !== true)) return false;
  // A reference reading is keyed by its own instrument.
  if ((item.referenceOnly === true) !== (item.instrumentKey === `reference:${symbol(item.sourceTicker)}`)) return false;
  const key = JSON.stringify([item.field, item.sourceTicker, item.referenceOnly === true, item.value ?? null, item.levels ?? null, item.sourceText, item.statement ?? null]);
  if (!statedVerdicts.has(key)) {
    if (statedVerdicts.size >= 20_000) statedVerdicts.delete(statedVerdicts.keys().next().value);
    statedVerdicts.set(key, restates(item));
  }
  return statedVerdicts.get(key);
}

function publishedTradeFromEvent(event) {
  if (!record(event) || reject(event)) return null;
  const ticker = event.sourceTicker || event.ticker || event.entityId || String(event.entityKey || '').replace(/^ticker#/, '') || event.matchedText;
  const value = bias(record(event.value) ? event.value.trade : event.value ?? event.signalValue);
  if (value && isExplicitTradeProvenance(event.signalProvenance)) {
    if (event.signalProvenance.method === 'explicit-statement') {
      const statements = tradeStatements(event.signalProvenance.sourceText, metadata(event), event.signalProvenance.sourceField)
        .filter((item) => !item.basisLabel && item.value === value && sameSignalInstrument(item.sourceTicker, ticker));
      return statements[0] || null;
    }
    return reading(metadata(event), ticker, value, event.signalProvenance.sourceField,
      event.signalProvenance.sourceText, event.signalProvenance.method);
  }
  // Legacy event kinds were assigned by product, and even fabricated their
  // "Trade BULLISH" excerpt from a Trend field. Require original prose with
  // an explicit instrument subject; an event type is never evidence.
  const candidates = tradeStatements(event.sourceText || event.excerpt, metadata(event), event.fieldPath || 'excerpt')
    .filter((item) => !item.basisLabel && sameSignalInstrument(item.ticker, ticker));
  return new Set(candidates.map((item) => item.value)).size === 1 ? candidates[0] : null;
}

function isExactPublishedTradeReading(item) {
  if (!isExplicitTradeProvenance(item?.signalProvenance) || item.basisLabel || item.basisRelationship
    || String(item.instrumentKey || '').startsWith('reference:')) return false;
  if (item.signalProvenance.method === 'explicit-field') return true;
  // Recheck old cached statement readings too: a commodity word that also
  // happens to be an ETF ticker does not identify that ETF's published signal.
  if (typeof item.statement === 'string' && item.statement.trim()) {
    return tradeStatements(item.statement).some((statement) => !statement.basisLabel && statement.value === item.value
      && statement.sourceText === item.signalProvenance.sourceText && sameSignalInstrument(statement.sourceTicker, item.sourceTicker || item.ticker));
  }
  return tradeStatements(item.signalProvenance.sourceText).some((statement) => !statement.basisLabel
    && sameSignalInstrument(statement.sourceTicker, item.sourceTicker || item.ticker));
}

/** The latest dated Trade for an exact instrument, or with `reference` for a
 * published reference such as Gold spot (never a security sharing its code). */
function selectLatestPublishedTrade(readings, { ticker, asOf = '9999-12-31', reference = false } = {}) {
  const rows = (readings || []).filter((item) => isExplicitTradeProvenance(item?.signalProvenance)
    && bias(item.value) && (reference
      ? item.instrumentKey === `reference:${symbol(ticker)}` && isStatedReading(item)
      : sameSignalInstrument(item.sourceTicker || item.ticker, ticker) && isExactPublishedTradeReading(item))
    && /^\d{4}-\d{2}-\d{2}$/.test(item.date || item.sourceDate || '')
    && (item.date || item.sourceDate) <= String(asOf).slice(0, 10));
  if (!rows.length) return null;
  const latestDate = rows.map((item) => item.date || item.sourceDate).sort().at(-1);
  const dated = rows.filter((item) => (item.date || item.sourceDate) === latestDate);
  const stamp = (item) => item.publishedAt && !/T00:00:00(?:\.000)?(?:Z|\+00:00)$/.test(item.publishedAt)
    ? Date.parse(item.publishedAt) : NaN;
  const timed = dated.every((item) => Number.isFinite(stamp(item)));
  const latest = timed ? Math.max(...dated.map(stamp)) : null;
  const selected = timed ? dated.filter((item) => stamp(item) === latest) : dated;
  if (new Set(selected.map((item) => item.value)).size > 1) return { ...selected[0], status: 'conflict', value: null, ticker, evidence: selected };
  return { ...selected[0], status: 'available' };
}

module.exports = { extractPublishedTradeSignals, extractPublishedStatements, isStatedReading, publishedTradeFromEvent,
  selectLatestPublishedTrade, tradeStatements, isExplicitTradeProvenance, sameSignalInstrument, isVerifiedPublicationSnapshot,
  isExactPublishedTradeReading };
