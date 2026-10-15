const instrumentCatalog = require('../constants/dashboardResearchCatalog.json');
const narrativeCatalog = require('../constants/dashboardNarrativeResearchCatalog.json');

const record = (value) => value && typeof value === 'object' && !Array.isArray(value);
const bias = (value) => /^(BULLISH|BEARISH|NEUTRAL)$/i.test(String(value || '').trim())
  ? String(value).trim().toUpperCase() : null;
const symbol = (value) => String(value || '').trim().toUpperCase();
const escape = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const forbidden = /\b(?:if|unless|could|would|should|may|might|will|expect(?:s|ed)?|forecast|assuming|scenario|previously|formerly|historically|prior|not|never|no longer|used to)\b|[?"“”]/i;
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
    && (value.method !== 'explicit-statement' || (!forbidden.test(value.sourceText)
      && /\b(?:BULLISH|BEARISH|NEUTRAL) (?:on )?TRADE\b|\bTRADE(?: signal)?(?:(?: is| remains|:)\s*|\s+)(?:BULLISH|BEARISH|NEUTRAL)\b/i.test(value.sourceText))));
}

function metadata(snapshot) {
  return {
    sourceProduct: snapshot.snapshotType || snapshot.productId || snapshot.productKey || null,
    sourceLabel: snapshot.productLabel || snapshot.sourceLabel || null,
    sourceUrl: snapshot.article?.feedUrl || snapshot.sourceUrl || null,
    date: snapshot.date || snapshot.marketDate || null,
    publishedAt: snapshot.publishedAt || null,
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

function subjectDefinitions() {
  const entries = instrumentCatalog.flatMap((entry) => [
    ...(entry.aliases || []).map((name) => ({ ticker: entry.symbol, pattern: escape(name) })),
    ...(entry.names || []).map((name) => ({ ticker: entry.symbol, pattern: escape(name) })),
  ]);
  narrativeCatalog.forEach((entry) => entries.push({
    ticker: entry.sourceTicker, pattern: entry.subjectPattern,
    prefix: entry.performancePrefixPattern,
    statement: entry.currentStatementPattern,
    sourceInstrument: entry.sourceInstrument,
    ...(entry.basisLabel ? { basisLabel: entry.basisLabel, basisRelationship: entry.basisRelationship } : {}),
  }));
  return entries.sort((a, b) => b.pattern.length - a.pattern.length);
}
const stateVerb = '(?:(?:is|remains|stays|turned|turns|flipped|flips)(?: now| back)?(?: to)?(?: signaling)? |(?:is )?back to signaling |[:=]\\s*)';

function compileSubject(entry) {
  const prefix = `^${entry.pattern}(?:\\s*[:=]\\s*|\\s+)${entry.prefix || ''}`;
  return { ...entry,
    directionalFirst: new RegExp(`${prefix}(?:${entry.statement || stateVerb})?(BULLISH|BEARISH|NEUTRAL) (?:on )?TRADE\\b`, 'i'),
    fieldFirst: new RegExp(`${prefix}(?:${stateVerb})?TRADE(?: signal)?(?:(?: is| remains|:)\\s*|\\s+)(BULLISH|BEARISH|NEUTRAL)\\b`, 'i'),
  };
}
const subjects = subjectDefinitions().map(compileSubject);
const ambiguousCommoditySubjects = new Set([
  ...narrativeCatalog.filter((entry) => entry.basisLabel).map((entry) => symbol(entry.sourceTicker)),
  ...instrumentCatalog.flatMap((entry) => (entry.publishedReferences || []).flatMap((reference) =>
    (reference.names || []).map((name) => symbol(name.split(/\s+/)[0]))
      .filter((name) => (reference.aliases || []).includes(name)))),
]);
const nonSecurities = new Set(['TRADE', 'TREND', 'BUY', 'SELL', 'THIS', 'THAT', 'THESE', 'THOSE', 'THE',
  'OUR', 'WE', 'I', 'IT', 'ITS', 'AND', 'FOR', 'NEW', 'US', 'USA', 'ETF', 'FED', 'TODAY', 'NOW',
  'EQUITIES', 'SOFTWARE', 'COMMODITIES', 'MARKET', 'MARKETS', 'LONG', 'SHORT', 'BULLISH', 'BEARISH', 'NEUTRAL']);

/** Conservative, subject-bound published statements, never a proximity match. */
function tradeStatements(text, meta = {}, fieldPath = 'article.bodyText') {
  const result = [];
  if (!/\bTRADE\b/i.test(String(text || '')) || !/\b(?:BULLISH|BEARISH|NEUTRAL)\b/i.test(String(text || ''))) return result;
  String(text || '').split(/\r?\n|(?<=[.!?])\s+/).forEach((raw) => {
    const line = raw.trim().replace(/^[•*-]\s+/, '').replace(/\s+/g, ' ');
    if (!line || line.length > 900 || !/\bTRADE\b/i.test(line)
      || !/\b(?:BULLISH|BEARISH|NEUTRAL)\b/i.test(line) || forbidden.test(line)) return;
    const claims = [...line.matchAll(/\b(BULLISH|BEARISH|NEUTRAL) (?:on )?TRADE\b|\bTRADE(?: signal)?(?:(?: is| remains|:)\s*|\s+)(BULLISH|BEARISH|NEUTRAL)\b/gi)]
      .map((match) => (match[1] || match[2]).toUpperCase());
    if (new Set(claims).size > 1 || /\bTRADE\b.*\b(?:versus|last month|last year|last week)\b/i.test(line)) return;
    const token = /^\$?([A-Z][A-Z0-9./=^_-]{0,15})(?=\s|:)/.exec(line)?.[1];
    const candidates = [...subjects, ...(token && !nonSecurities.has(token) && !ambiguousCommoditySubjects.has(token)
      ? [compileSubject({ ticker: token, pattern: `\\$?${escape(token)}` })] : [])];
    candidates.forEach((entry) => {
      const match = entry.directionalFirst.exec(line) || entry.fieldFirst.exec(line);
      if (!match) return;
      result.push(reading(meta, entry.ticker, match[1].toUpperCase(), fieldPath, line, 'explicit-statement', {
        ...(entry.sourceInstrument ? { sourceInstrument: entry.sourceInstrument } : {}),
        ...(entry.basisLabel ? { basisLabel: entry.basisLabel, basisRelationship: entry.basisRelationship,
          instrumentKey: `reference:${entry.ticker}`, referenceOnly: true } : {}),
      }));
    });
  });
  return [...new Map(result.map((item) => [`${item.ticker}:${item.value}:${item.sourceText}`, item])).values()];
}

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
  ['bodyText', 'summary', 'headline'].forEach((field) => {
    result.push(...tradeStatements(snapshot.article?.[field], meta, `article.${field}`));
  });
  const valid = result.filter((item) => !item.basisLabel && !(snapshot.sourceQuality?.issues || []).some((issue) =>
    sameSignalInstrument(issue.ticker, item.sourceTicker)
    && [issue.field, ...(issue.affectedFields || [])].some((field) => ['trade', 'tradeSignal', 'tradeBias', 'narrative'].includes(field))));
  return [...new Map(valid.map((item) => [`${item.ticker}:${item.value}:${item.fieldPath}:${item.sourceText}`, item])).values()];
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
  return tradeStatements(item.signalProvenance.sourceText).some((statement) => !statement.basisLabel
    && sameSignalInstrument(statement.sourceTicker, item.sourceTicker || item.ticker));
}

function selectLatestPublishedTrade(readings, { ticker, asOf = '9999-12-31' } = {}) {
  const rows = (readings || []).filter((item) => isExplicitTradeProvenance(item?.signalProvenance)
    && bias(item.value) && sameSignalInstrument(item.sourceTicker || item.ticker, ticker)
    && isExactPublishedTradeReading(item)
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

module.exports = { extractPublishedTradeSignals, publishedTradeFromEvent, selectLatestPublishedTrade,
  tradeStatements, isExplicitTradeProvenance, sameSignalInstrument, isVerifiedPublicationSnapshot, isExactPublishedTradeReading };
