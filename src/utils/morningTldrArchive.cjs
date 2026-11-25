const crypto = require('crypto');
const { isMarketDay } = require('./analyticsDailyBrief.cjs');

const TLDR_ARCHIVE_PRODUCT_IDS = [
  'top-3-things',
  'risk-ranges',
  'early-look',
  'the-call',
  'the-macro-show',
  'signal-strength',
];

const DEFAULT_VISIBLE_DAYS = 10;
const DEFAULT_RETENTION_DAYS = 730;
const DEFAULT_LOOKBACK_MARKET_DAYS = 120;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SNAPSHOT_TABLE = 'HedgeyeDailySnapshot';
const DEFAULT_PRODUCT_MANIFEST_TABLE = 'ResearchProductManifestsV1';

const TLDR_PUBLICATION_STATES = Object.freeze({
  AWAITING: 'awaiting',
  PROCESSING: 'processing',
  SAVED: 'saved',
  FAILED: 'failed',
  SAVED_UPDATE_FAILED: 'saved_update_failed',
});

const nyDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const asDate = (value) => (value instanceof Date ? value : new Date(value));

const nyDate = (value = new Date()) => {
  const parsed = asDate(value);
  if (Number.isNaN(parsed.getTime())) return null;
  // en-CA is normally YYYY-MM-DD, but construct from formatToParts so this
  // remains deterministic across the Node ICU builds used by the dashboard.
  const parts = nyDateFormatter.formatToParts(parsed).reduce((result, part) => {
    if (part.type !== 'literal') result[part.type] = part.value;
    return result;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
};

const parseArchiveDate = (value) => {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const [year, month, day] = text.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day, 12));
  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
  ) return null;
  return parsed;
};

const assertArchiveDate = (value) => {
  const parsed = parseArchiveDate(value);
  if (!parsed) {
    const error = new Error('date must be a valid YYYY-MM-DD value');
    error.code = 'INVALID_TLDR_DATE';
    throw error;
  }
  return parsed;
};

const isoDate = (date) => date.toISOString().slice(0, 10);

const previousMarketDate = (date) => {
  let cursor = new Date(date.getTime() - DAY_MS);
  while (!isMarketDay(cursor)) cursor = new Date(cursor.getTime() - DAY_MS);
  return cursor;
};

const marketDateCandidates = (now = new Date(), count = DEFAULT_LOOKBACK_MARKET_DAYS) => {
  const start = parseArchiveDate(nyDate(now));
  if (!start) return [];
  const dates = [];
  let cursor = start;
  const limit = Math.max(0, Number(count) || 0);
  while (dates.length < limit) {
    if (isMarketDay(cursor)) dates.push(isoDate(cursor));
    cursor = new Date(cursor.getTime() - DAY_MS);
  }
  return dates;
};

const ttlIsAvailable = (item, now = Date.now()) => {
  if (!item || item.ttl == null || item.ttl === '') return true;
  const ttl = Number(item.ttl);
  return !Number.isFinite(ttl) || ttl > Math.floor(now / 1000);
};

const unique = (values) => [...new Set(values.filter(Boolean))];

/**
 * Read the small, bounded set of dated TL;DR keys without scanning the table.
 * DynamoDB limits BatchGetItem to 100 keys and 16 MB per request, so chunks
 * are retried when Dynamo returns UnprocessedKeys.
 */
async function batchGetTldrSnapshots(documentClient, dates, {
  tableName = DEFAULT_SNAPSHOT_TABLE,
  snapshotTypes = TLDR_ARCHIVE_PRODUCT_IDS,
  maxAttempts = 4,
} = {}) {
  const keys = unique(dates).flatMap((date) => snapshotTypes.map((snapshotType) => ({ date, snapshotType })));
  const items = [];

  for (let offset = 0; offset < keys.length; offset += 100) {
    let pending = keys.slice(offset, offset + 100);
    let attempt = 0;
    while (pending.length > 0 && attempt < maxAttempts) {
      const result = await documentClient.batchGet({
        RequestItems: {
          [tableName]: {
            Keys: pending,
            ConsistentRead: false,
          },
        },
      }).promise();
      items.push(...(result.Responses?.[tableName] || []));
      pending = result.UnprocessedKeys?.[tableName]?.Keys || [];
      attempt += 1;
    }
    if (pending.length > 0) {
      const error = new Error('DynamoDB did not process all TL;DR archive keys');
      error.code = 'TLDR_ARCHIVE_UNPROCESSED_KEYS';
      throw error;
    }
  }
  return items;
}

const statusProjection = (fields) => ({
  ProjectionExpression: fields.map((_, index) => `#f${index}`).join(', '),
  ExpressionAttributeNames: Object.fromEntries(fields.map((field, index) => [`#f${index}`, field])),
});

/**
 * Read only the six exact-date snapshot metadata rows and their six product
 * manifests. Raw source identifiers are used solely to derive a revision and
 * are never returned to callers.
 */
async function batchGetTldrStatusMetadata(documentClient, date, {
  snapshotTableName = DEFAULT_SNAPSHOT_TABLE,
  manifestTableName = DEFAULT_PRODUCT_MANIFEST_TABLE,
  maxAttempts = 4,
} = {}) {
  assertArchiveDate(date);
  const tableRequests = {
    [snapshotTableName]: {
      Keys: TLDR_ARCHIVE_PRODUCT_IDS.map((snapshotType) => ({ date, snapshotType })),
      ConsistentRead: true,
      ...statusProjection([
        'date',
        'snapshotType',
        'scrapedAt',
        'publishedAt',
        'receivedAt',
        'createdAt',
        'updatedAt',
        'ttl',
        'htmlSource',
        'pdfS3Key',
        'pdfSource',
        'screenshotS3Key',
        'sourceEventId',
        'gmailMessageId',
        'contentSha256',
        'sourceProduct',
      ]),
    },
    [manifestTableName]: {
      Keys: TLDR_ARCHIVE_PRODUCT_IDS.map((productKey) => ({ marketDate: date, productKey })),
      ConsistentRead: true,
      ...statusProjection([
        'marketDate',
        'productKey',
        'state',
        'updatedAt',
        'manifestChecksum',
        'receivedCount',
        'parsedCount',
        'validatedCount',
        'indexedCount',
        'failedCount',
      ]),
    },
  };
  const responses = {
    [snapshotTableName]: [],
    [manifestTableName]: [],
  };
  let pending = tableRequests;
  let attempt = 0;

  while (Object.keys(pending).length > 0 && attempt < maxAttempts) {
    const result = await documentClient.batchGet({ RequestItems: pending }).promise();
    Object.entries(result.Responses || {}).forEach(([tableName, items]) => {
      if (responses[tableName]) responses[tableName].push(...items);
    });
    const unprocessed = result.UnprocessedKeys || {};
    pending = Object.fromEntries(Object.entries(unprocessed)
      .filter(([, request]) => request?.Keys?.length)
      .map(([tableName, request]) => [tableName, {
        ...tableRequests[tableName],
        Keys: request.Keys,
      }]));
    attempt += 1;
  }

  if (Object.keys(pending).length > 0) {
    const error = new Error('DynamoDB did not process all TL;DR status keys');
    error.code = 'TLDR_STATUS_UNPROCESSED_KEYS';
    throw error;
  }

  return {
    snapshots: responses[snapshotTableName],
    manifests: responses[manifestTableName],
  };
}

const normalizedManifestState = (manifest) => {
  if (!manifest) return null;
  if (Number(manifest.failedCount || 0) > 0) return 'failed';
  const state = String(manifest.state || '').trim().toLowerCase();
  if (state === 'failed') return 'failed';
  if (['received', 'parsed', 'validated', 'indexed'].includes(state)) return state;
  for (const stage of ['indexed', 'validated', 'parsed', 'received']) {
    if (Number(manifest[`${stage}Count`] || 0) > 0) return stage;
  }
  return null;
};

const publicationState = (snapshot, manifest) => {
  const manifestState = normalizedManifestState(manifest);
  if (snapshot) {
    return manifestState === 'failed'
      ? TLDR_PUBLICATION_STATES.SAVED_UPDATE_FAILED
      : TLDR_PUBLICATION_STATES.SAVED;
  }
  if (manifestState === 'failed' || manifestState === 'indexed') {
    return TLDR_PUBLICATION_STATES.FAILED;
  }
  if (manifestState) return TLDR_PUBLICATION_STATES.PROCESSING;
  return TLDR_PUBLICATION_STATES.AWAITING;
};

const sourceRevisionIdentity = (snapshot) => ({
  snapshotType: snapshot.snapshotType,
  scrapedAt: snapshot.scrapedAt || null,
  publishedAt: snapshot.publishedAt || null,
  receivedAt: snapshot.receivedAt || null,
  createdAt: snapshot.createdAt || null,
  updatedAt: snapshot.updatedAt || null,
  htmlSource: snapshot.htmlSource || null,
  pdfS3Key: snapshot.pdfS3Key || null,
  pdfSource: snapshot.pdfSource || null,
  screenshotS3Key: snapshot.screenshotS3Key || null,
  sourceEventId: snapshot.sourceEventId || null,
  gmailMessageId: snapshot.gmailMessageId || null,
  contentSha256: snapshot.contentSha256 || null,
  sourceProduct: snapshot.sourceProduct || null,
});

async function buildMorningTldrStatus(documentClient, date, {
  now = new Date(),
  snapshotTableName = DEFAULT_SNAPSHOT_TABLE,
  manifestTableName = DEFAULT_PRODUCT_MANIFEST_TABLE,
} = {}) {
  assertArchiveDate(date);
  const nowDate = asDate(now);
  const nowMs = Number.isNaN(nowDate.getTime()) ? Date.now() : nowDate.getTime();
  const { snapshots: rawSnapshots, manifests } = await batchGetTldrStatusMetadata(
    documentClient,
    date,
    { snapshotTableName, manifestTableName },
  );
  const snapshots = rawSnapshots
    .filter((snapshot) => snapshot?.date === date)
    .filter((snapshot) => TLDR_ARCHIVE_PRODUCT_IDS.includes(snapshot?.snapshotType))
    .filter((snapshot) => ttlIsAvailable(snapshot, nowMs));
  const snapshotByProduct = new Map(snapshots.map((snapshot) => [snapshot.snapshotType, snapshot]));
  const manifestByProduct = new Map(manifests
    .filter((manifest) => manifest?.marketDate === date)
    .filter((manifest) => TLDR_ARCHIVE_PRODUCT_IDS.includes(manifest?.productKey))
    .map((manifest) => [manifest.productKey, manifest]));
  const products = Object.fromEntries(TLDR_ARCHIVE_PRODUCT_IDS.map((productId) => {
    const snapshot = snapshotByProduct.get(productId) || null;
    const manifest = manifestByProduct.get(productId) || null;
    const state = publicationState(snapshot, manifest);
    return [productId, {
      state,
      observedAt: snapshotEventTime(snapshot) || manifest?.updatedAt || null,
    }];
  }));
  const revisionInput = TLDR_ARCHIVE_PRODUCT_IDS.map((productId) => {
    const snapshot = snapshotByProduct.get(productId);
    return snapshot ? sourceRevisionIdentity(snapshot) : { snapshotType: productId, unavailable: true };
  });

  return {
    schemaVersion: 1,
    date,
    generatedAt: new Date(nowMs).toISOString(),
    contentRevision: crypto.createHash('sha256')
      .update(JSON.stringify(revisionInput))
      .digest('hex'),
    products,
  };
}

const snapshotEventTime = (snapshot) => (
  snapshot?.publishedAt
  || snapshot?.scrapedAt
  || snapshot?.receivedAt
  || snapshot?.createdAt
  || snapshot?.updatedAt
  || null
);

const safeSnapshot = (item) => {
  if (!item || !item.date || !item.snapshotType) return null;
  return {
    date: item.date,
    snapshotType: item.snapshotType,
    scrapedAt: item.scrapedAt,
    publishedAt: item.publishedAt,
    data: item.data,
    trendChanges: item.trendChanges,
    outbucket: item.outbucket,
    meta: {
      riskRangeCount: item.riskRangeCount,
      stockCount: item.stockCount,
      cryptoCount: item.cryptoCount,
      rankingCount: item.rankingCount,
      itemCount: item.itemCount,
      signalCount: item.signalCount,
      chartCount: item.chartCount,
    },
    article: item.article,
    htmlSource: item.htmlSource,
    // The publication's email, so a citation from it can open the original (user-asked 2026-11-18).
    gmailMessageId: item.gmailMessageId || item.sourceMessageId,
    reportType: item.reportType,
    warnings: item.warnings,
    sourceProduct: item.sourceProduct,
    sourcePriority: item.sourcePriority,
    pdfSource: item.pdfSource,
    screenshotS3Key: item.screenshotS3Key,
  };
};

const byProductAndDate = (items) => {
  const index = new Map();
  items.forEach((item) => {
    if (!item?.snapshotType || !item?.date) return;
    const key = `${item.date}:${item.snapshotType}`;
    const existing = index.get(key);
    // The table key normally guarantees one item, but a deterministic latest
    // event choice keeps this safe if a test double or migration returns dupes.
    if (!existing || new Date(snapshotEventTime(item) || 0).getTime() > new Date(snapshotEventTime(existing) || 0).getTime()) {
      index.set(key, item);
    }
  });
  return index;
};

const withinRetention = (item, now, retentionDays) => {
  const current = parseArchiveDate(nyDate(now));
  const dated = parseArchiveDate(item?.date);
  if (!current || !dated) return false;
  const ageDays = Math.floor((current.getTime() - dated.getTime()) / DAY_MS);
  return ageDays >= 0 && ageDays <= retentionDays;
};

const activeItems = (items, now = Date.now(), retentionDays = DEFAULT_RETENTION_DAYS) => items
  .filter((item) => TLDR_ARCHIVE_PRODUCT_IDS.includes(item?.snapshotType))
  .filter((item) => parseArchiveDate(item?.date) && isMarketDay(parseArchiveDate(item.date)))
  .filter((item) => withinRetention(item, now, retentionDays))
  .filter((item) => ttlIsAvailable(item, now));

const findPreviousItems = (index, currentDate) => Object.fromEntries(TLDR_ARCHIVE_PRODUCT_IDS.map((snapshotType) => {
  const previous = [...index.values()]
    .filter((item) => item.snapshotType === snapshotType && item.date < currentDate)
    .sort((left, right) => right.date.localeCompare(left.date))[0];
  return [snapshotType, safeSnapshot(previous)];
}));

const dateMetadata = (items, visibleDays) => {
  const byDate = new Map();
  items.forEach((item) => {
    if (!byDate.has(item.date)) byDate.set(item.date, new Set());
    byDate.get(item.date).add(item.snapshotType);
  });
  return [...byDate.entries()]
    .sort(([left], [right]) => right.localeCompare(left))
    .slice(0, visibleDays)
    .map(([date, types]) => ({
      date,
      availableProducts: TLDR_ARCHIVE_PRODUCT_IDS.filter((id) => types.has(id)),
      missingProducts: TLDR_ARCHIVE_PRODUCT_IDS.filter((id) => !types.has(id)),
    }));
};

async function buildMorningTldrArchive(documentClient, {
  now = new Date(),
  visibleDays = DEFAULT_VISIBLE_DAYS,
  retentionDays = DEFAULT_RETENTION_DAYS,
  lookbackMarketDays = DEFAULT_LOOKBACK_MARKET_DAYS,
} = {}) {
  const dates = marketDateCandidates(now, Math.max(lookbackMarketDays, visibleDays * 3));
  const items = activeItems(
    await batchGetTldrSnapshots(documentClient, dates),
    now.getTime ? now.getTime() : Date.now(),
    retentionDays,
  );
  const datesForUi = dateMetadata(items, visibleDays);
  return {
    dates: datesForUi,
    visibleDays,
    retentionDays,
    timezone: 'America/New_York',
    generatedAt: new Date().toISOString(),
    latestDate: datesForUi[0]?.date || null,
  };
}

async function buildMorningTldrDay(documentClient, date, {
  now = new Date(),
  lookbackMarketDays = DEFAULT_LOOKBACK_MARKET_DAYS,
  retentionDays = DEFAULT_RETENTION_DAYS,
} = {}) {
  assertArchiveDate(date);
  const candidates = marketDateCandidates(now, lookbackMarketDays);
  if (!candidates.includes(date)) candidates.unshift(date);
  const items = activeItems(
    await batchGetTldrSnapshots(documentClient, candidates),
    now.getTime ? now.getTime() : Date.now(),
    retentionDays,
  );
  const index = byProductAndDate(items);
  const snapshots = Object.fromEntries(TLDR_ARCHIVE_PRODUCT_IDS.map((snapshotType) => [snapshotType, safeSnapshot(index.get(`${date}:${snapshotType}`))]));
  const availableProducts = TLDR_ARCHIVE_PRODUCT_IDS.filter((id) => snapshots[id]);
  if (availableProducts.length === 0) return null;
  return {
    date,
    snapshots,
    previousSnapshots: findPreviousItems(index, date),
    availableProducts,
    missingProducts: TLDR_ARCHIVE_PRODUCT_IDS.filter((id) => !snapshots[id]),
    historical: date !== nyDate(now),
    generatedAt: new Date().toISOString(),
    timezone: 'America/New_York',
  };
}

module.exports = {
  TLDR_ARCHIVE_PRODUCT_IDS,
  DEFAULT_VISIBLE_DAYS,
  DEFAULT_RETENTION_DAYS,
  marketDateCandidates,
  parseArchiveDate,
  assertArchiveDate,
  ttlIsAvailable,
  batchGetTldrSnapshots,
  batchGetTldrStatusMetadata,
  safeSnapshot,
  buildMorningTldrArchive,
  buildMorningTldrDay,
  buildMorningTldrStatus,
  TLDR_PUBLICATION_STATES,
};
