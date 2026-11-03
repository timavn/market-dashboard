'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { RESEARCH_PRODUCTS } = require('../utils/researchProductRegistry.cjs');
const { extractPublishedStatements, isVerifiedPublicationSnapshot, isExplicitTradeProvenance, isStatedReading,
  isExactPublishedTradeReading, publishedTradeFromEvent } = require('../utils/publishedResearchSignals.cjs');

const DEFAULT_PATH = path.join(process.cwd(), 'data', 'research', 'published-trade-v1.json');
const sourceFields = [
  'date', 'snapshotType', 'source', 'htmlSource', 'pdfSource', 'pdfS3Key', 'data',
  'article.feedUrl', 'article.bodyText', 'article.summary', 'article.headline', 'article.teaser', 'article.keyTakeaways',
  'publishedAt', 'sourceUrl', 'sourceEventId', 'gmailMessageId', 'sourceMessageId',
  'sourceQuality', 'metadata', 'meta', 'quality', 'flags', 'provenance', 'providerStatus',
  'verified', 'sourceVerified', 'status', 'sourceStatus', 'freshness', 'availability', 'provider',
  'mock', 'isMock', 'seed', 'isSeed', 'seeded', 'isSeeded', 'synthetic', 'inferred',
  'stale', 'isStale', 'cacheOnly', 'cache_only', 'fromCache', 'cacheState', 'cacheStatus',
  'offline', 'disconnected', 'fallback', 'connected', 'success', 'available',
];
const sourceAttributeNames = {};
const sourceProjection = sourceFields.map((field) => field.split('.').map((part) => {
  const name = `#field_${part}`;
  sourceAttributeNames[name] = part;
  return name;
}).join('.')).join(', ');

/** Compact publication evidence, independent of the five-day UI history window:
 * the day's repository of what each publication states. Security Trade lives in
 * `readings`; Trade for published references (Gold spot), stated TREND and
 * Alpha Code levels sit beside it, each re-derivable from its own clause.
 * New omissions and failed requests cannot erase a previously published signal.
 * A reread of the same source replaces its projection, including a revocation. */
const STATEMENT_KINDS = ['references', 'trends', 'alphaCodes'];
function createPublishedTradeArchive({ querySnapshotsByType, referencePath = DEFAULT_PATH,
  products = RESEARCH_PRODUCTS, now = Date.now, ttlMs = 5 * 60 * 1000 } = {}) {
  let publications = {};
  let refreshedAt = null;
  // The last refresh in which every snapshot query succeeded; a partly failed
  // refresh keeps serving verified publications but is not a current read.
  let verifiedAt = null;
  let pending = null;
  const definitions = new Map(products.flatMap((product) => product.snapshotTypes.map((type) => [type, product])));
  const publicationKey = (source) => `${source.snapshotType}:${source.date}:${source.article?.feedUrl || source.sourceUrl}`;
  const fromSource = (item, reading) => reading.sourceProduct === definitions.get(item.source.snapshotType).id
    && reading.date === item.source.date && reading.sourceUrl === item.source.article.feedUrl;
  const validPublication = (item) => isVerifiedPublicationSnapshot(item?.source)
    && definitions.has(item.source.snapshotType) && Array.isArray(item.readings)
    && item.readings.every((reading) => isExplicitTradeProvenance(reading?.signalProvenance)
      && publishedTradeFromEvent(reading) && fromSource(item, reading)
      && (reading.signalProvenance.method !== 'explicit-statement' || isExactPublishedTradeReading(reading))
      && ['BULLISH', 'BEARISH', 'NEUTRAL'].includes(reading.value))
    && [item.readings, ...STATEMENT_KINDS.map((kind) => item[kind] || [])].some((list) => list.length);
  // Statements are kept one by one: a statement its own sentence no longer
  // states is dropped without discarding the publication's other readings.
  const withStatedStatements = (item) => item?.source && definitions.has(item.source.snapshotType) ? { ...item,
    ...Object.fromEntries(STATEMENT_KINDS.map((kind) => [kind, (Array.isArray(item[kind]) ? item[kind] : [])
      .filter((reading) => isStatedReading(reading) && fromSource(item, reading))])) } : item;
  if (referencePath) {
    try {
      const stored = JSON.parse(fs.readFileSync(referencePath, 'utf8'));
      if (stored.schemaVersion === 1) publications = Object.fromEntries(Object.values(stored.publications || {})
        .map(withStatedStatements).filter(validPublication).map((item) => [publicationKey(item.source), item]));
    } catch { /* No verified archived publication yet. */ }
  }
  const persist = () => {
    if (!referencePath) return;
    try {
      fs.mkdirSync(path.dirname(referencePath), { recursive: true, mode: 0o700 });
      const temporary = `${referencePath}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, publications }), { mode: 0o600 });
      fs.renameSync(temporary, referencePath);
    } catch { /* Keep the verified in-process evidence when disk is unavailable. */ }
  };
  const refresh = async () => {
    const results = await Promise.allSettled([...definitions.keys()].map(async (type) => ({
      type, snapshots: await querySnapshotsByType(type, { limit: 60,
        snapshotProjectionExpression: sourceProjection,
        snapshotAttributeNames: sourceAttributeNames,
      }),
    })));
    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      const { type, snapshots } = result.value;
      const product = definitions.get(type);
      for (const snapshot of Array.isArray(snapshots) ? snapshots : []) {
        // Archive extraction can cover months of long reports. Let quotes,
        // health checks, and UI requests run between individual publications.
        await new Promise((resolve) => setImmediate(resolve));
        if (!snapshot || snapshot.snapshotType !== type || !/^\d{4}-\d{2}-\d{2}$/.test(snapshot.date || '')) continue;
        if (!isVerifiedPublicationSnapshot(snapshot)) continue;
        const key = publicationKey(snapshot);
        // An explicit replacement of this exact publication supersedes its
        // previous extraction. A missing different publication does not.
        delete publications[key];
        const stamp = (reading) => ({ ...reading, sourceProduct: product.id, sourceLabel: product.label, qualityStatus: 'validated' });
        const statements = extractPublishedStatements(snapshot);
        const item = { readings: statements.trade.map(stamp),
          ...Object.fromEntries(STATEMENT_KINDS.map((kind) => [kind, statements[kind].map(stamp)])) };
        if (![item.readings, ...STATEMENT_KINDS.map((kind) => item[kind])].some((list) => list.length)) continue;
        item.source = {
          date: snapshot.date, snapshotType: type, source: snapshot.source,
          htmlSource: snapshot.htmlSource, pdfSource: snapshot.pdfSource, pdfS3Key: snapshot.pdfS3Key,
          article: { feedUrl: snapshot.article?.feedUrl || snapshot.sourceUrl },
        };
        const stated = withStatedStatements(item);
        if (validPublication(stated)) publications[key] = stated;
      }
    }
    refreshedAt = Number(now());
    if (results.every((result) => result.status === 'fulfilled')) verifiedAt = refreshedAt;
    persist();
  };
  return {
    status: () => ({ verifiedAt }),
    async load({ date = '9999-12-31', waitForRefresh = false } = {}) {
      if (refreshedAt === null || Number(now()) - refreshedAt >= ttlMs) {
        if (!pending) pending = refresh().finally(() => { pending = null; });
        // A restart need not wait for an archive backfill to display a dated
        // publication whose original source proof is already on disk.
        if (!waitForRefresh && Object.values(publications).some((item) => item.source.date <= date)) {
          void pending.catch(() => {});
        } else await pending;
      }
      return Object.values(publications).flatMap((item) => item.readings).filter((reading) => reading.date <= date);
    },
    /** Reference Trade, stated Trend and Alpha Codes as of the last load. */
    statements({ date = '9999-12-31' } = {}) {
      return Object.fromEntries(STATEMENT_KINDS.map((kind) => [kind, Object.values(publications)
        .flatMap((item) => item[kind] || []).filter((reading) => reading.date <= date)]));
    },
  };
}

module.exports = { createPublishedTradeArchive, DEFAULT_PATH, STATEMENT_KINDS };
