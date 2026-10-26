const registry = require('../../../infra/lambdas/gmail_ingestor/research_products.json');

// Coverage is refreshed by the existing change feed every minute. A saved
// coverage snapshot cannot establish that today's ingestion is still healthy.
const FEED_MAX_AGE_MS = 120_000;
const INVALID_STATES = new Set(['offline', 'disconnected', 'failed', 'error', 'unavailable', 'stale', 'cache-only', 'cached', 'mock', 'seed', 'seeded', 'synthetic', 'fixture']);
const INVALID_FLAGS = ['offline', 'disconnected', 'failed', 'stale', 'isStale', 'cacheOnly', 'cache_only', 'mock', 'isMock', 'seed', 'seeded', 'isSeed', 'synthetic', 'isSynthetic'];
// The parser files each Crypto Quant email as the Bitcoin Tracker it carries.
// Crypto Quant reads that evidence; the library lists the email once.
const PUBLISHED_AS = { 'crypto-quant': 'bitcoin-trend-tracker' };
const LIBRARY_LABELS = { 'bitcoin-trend-tracker': 'Crypto Quant · Bitcoin Tracker' };
const text = value => typeof value === 'string' && value.trim() ? value.trim() : null;
const timestamp = (value, now) => {
  const time = typeof value === 'string' && value.includes('T') ? Date.parse(value) : NaN;
  return Number.isFinite(time) && time <= now.getTime() + 30_000 ? value : null;
};

function invalidEvidence(row) {
  if (!row || typeof row !== 'object') return false;
  if (INVALID_FLAGS.some(key => row[key] === true) || row.connected === false || row.error) return true;
  if (['status', 'providerStatus', 'freshness', 'mode', 'sourceType'].some(key => INVALID_STATES.has(String(row[key] || '').toLowerCase().replaceAll('_', '-')))) return true;
  if (['sourceUri', 'source_uri'].some(key => /^(mock|seed|fixture|synthetic):/i.test(String(row[key] || '')))) return true;
  if (Array.isArray(row.sourceIds) && row.sourceIds.some(value => /^(mock|seed|fixture|synthetic):/i.test(String(value)))) return true;
  let storedMetadata = null;
  if (row.metadata_json) {
    try { storedMetadata = JSON.parse(row.metadata_json); } catch { return true; }
  }
  return [row.metadata, row.provenance, typeof row.freshness === 'object' && row.freshness, storedMetadata].some(value => value && invalidEvidence(value));
}

function automatedSourceReadiness(evidence = {}, now = new Date()) {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: registry.marketTimeZone || 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const products = Array.isArray(evidence.products) ? evidence.products : [];
  const indexed = Array.isArray(evidence.indexed) ? evidence.indexed : [];
  const feedTime = timestamp(evidence.feedGeneratedAt, now);
  const feedReady = feedTime && now.getTime() - Date.parse(feedTime) <= FEED_MAX_AGE_MS
    && !invalidEvidence(evidence) && !evidence.feedError && !(evidence.errors || []).length;

  return registry.products.map(product => {
    const sourceId = PUBLISHED_AS[product.id] || product.id;
    const row = products.find(item => (item.product || item.id) === sourceId);
    const publicationDate = text(row?.latestPublicationDate || row?.publicationDate)?.slice(0, 10) || null;
    const publicationIndexes = indexed.filter(item => item.product === sourceId && item.publication_date === publicationDate);
    if (invalidEvidence(evidence) || invalidEvidence(row) || (publicationIndexes.length && publicationIndexes.every(invalidEvidence))) {
      return {
        id: product.id, label: product.label, publicationDate: null, observedAt: null, indexedAt: null,
        updatedAt: null, usableForDay: false, status: 'unavailable', reason: 'Source unavailable',
        sourceUri: null, sourceIds: [], evidenceHash: null,
      };
    }
    const observedAt = timestamp(row?.observedAt, now);
    const local = publicationIndexes.filter(item => !invalidEvidence(item)
      && text(item.document_id) && text(item.content_hash) && text(item.source_uri) && timestamp(item.indexed_at, now));
    const currentLocal = local.filter(item => observedAt && Date.parse(item.indexed_at) >= Date.parse(observedAt));
    const latestLocal = currentLocal.sort((a, b) => Date.parse(b.indexed_at) - Date.parse(a.indexed_at))[0];
    const indexedAt = latestLocal?.indexed_at || null;
    const sourceIds = [...new Set([...(Array.isArray(row?.sourceIds) ? row.sourceIds : []), row?.sourceUri, latestLocal?.source_uri].map(text).filter(Boolean))];
    const sourceUri = text(latestLocal?.source_uri || row?.sourceUri) || sourceIds[0] || null;
    const evidenceHash = text(row?.evidenceHash);
    const complete = row?.status === 'indexed' && (product.requiredStages || registry.stages).every(stage => row?.stages?.[stage] === true);
    // Coverage dates every product to the market day, including one whose
    // email has not arrived. Nothing received is an absent publication, not a
    // pipeline failure.
    const notReceived = feedReady && (!row || publicationDate !== date || row.stages?.received !== true);
    const reason = !feedReady ? 'Source status unavailable'
      : notReceived ? 'No publication received today'
        : !observedAt || !evidenceHash || !sourceIds.length ? 'Source evidence unavailable'
            : !complete ? 'Processing incomplete'
              : !latestLocal ? 'Indexing incomplete' : null;
    return {
      id: product.id, label: product.label, publicationDate, observedAt, indexedAt,
      updatedAt: indexedAt || observedAt, usableForDay: reason === null,
      status: reason === null ? 'ready' : notReceived ? 'not_received' : 'unavailable', reason,
      sourceUri, sourceIds, evidenceHash,
    };
  });
}

function sourceLibraryRows(rows) {
  return rows.filter(row => !PUBLISHED_AS[row.id])
    .map(row => (LIBRARY_LABELS[row.id] ? { ...row, label: LIBRARY_LABELS[row.id] } : row));
}

module.exports = { automatedSourceReadiness, sourceLibraryRows, FEED_MAX_AGE_MS };
