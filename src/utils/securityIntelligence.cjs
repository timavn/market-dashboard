const crypto = require('crypto');
const { isMarketDay } = require('./analyticsDailyBrief.cjs');
const {
  CONTROLLED_EXPOSURE_TYPES,
  ENTITY_CATALOG,
  RESEARCH_PRODUCTS,
  RESEARCH_PRODUCT_BY_ID,
  getControlledExposure,
  getResearchProduct,
  getSecurityExposureTags,
  isResearchProductDue,
  isStructuredOnlyTicker,
  latestResearchMarketDate,
} = require('./researchProductRegistry.cjs');
const {
  isCanonicalResearchBias,
  normalizeResearchBias,
} = require('./researchBias.cjs');

const { extractPublishedTradeSignals, publishedTradeFromEvent, selectLatestPublishedTrade,
  isExplicitTradeProvenance, sameSignalInstrument } = require('./publishedResearchSignals.cjs');

const RESPONSE_SCHEMA_VERSION = 1;
const MAX_SYMBOLS = 200;
const MAX_HISTORY_DAYS = 5;
const ENTITY_EVENTS_INDEX = 'marketDate-index';
const PRODUCT_STAGE_ORDER = ['not_due', 'missing', 'received', 'parsed', 'validated', 'indexed', 'failed'];
const VALID_PRODUCT_STATES = new Set(PRODUCT_STAGE_ORDER);
const CONTROLLED_EXPOSURE_TYPE_SET = new Set(CONTROLLED_EXPOSURE_TYPES);
const STRUCTURED_TICKER_EVENT_KINDS = new Set([
  'primary_risk_range',
  'historical_risk_range',
  'risk_range',
  'supplemental_risk_range',
  'tracker_trade',
  'trade_signal',
  'trend_signal',
  'signal_strength_added',
  'signal_strength_removed',
  'signal_strength_listed',
  'signal_strength_membership',
  'signal_strength_short_added',
  'signal_strength_short_removed',
  'signal_strength_short_membership',
  'portfolio_rank',
  'portfolio_solutions_rank',
  'portfolio_solutions_mover',
  'position_mention',
  'position_reference',
  'position_change',
  'real_time_alert',
  'etf_pro_change',
  'investing_idea_position',
]);
// Each Signal Strength product's event kinds, and the value each kind reads as.
// Before Shorts became its own product (2026-10-29) its events were recorded
// under the long product, so a short kind is read from either product; the
// kinds alone keep the two books apart.
const SIGNAL_STRENGTH_SOURCE_PRODUCTS = Object.freeze({
  'signal-strength': ['signal-strength'],
  'signal-strength-shorts': ['signal-strength-shorts', 'signal-strength'],
});
const SIGNAL_STRENGTH_KINDS = Object.freeze({
  'signal-strength': {
    signal_strength_added: 'ADDED',
    signal_strength_removed: 'REMOVED',
    signal_strength_listed: null,
    signal_strength_membership: null,
  },
  'signal-strength-shorts': {
    signal_strength_short_added: 'ADDED',
    signal_strength_short_removed: 'REMOVED',
    signal_strength_short_membership: null,
  },
});
const BOILERPLATE_PATTERN = /\b(click here|unsubscribe|manage (?:your )?preferences|view (?:this )?email in (?:your )?browser)\b/i;

const ALIAS_TO_CANONICAL = (() => {
  const result = {};
  Object.entries(ENTITY_CATALOG.tickerAliases || {}).forEach(([canonical, aliases]) => {
    result[String(canonical).toUpperCase()] = String(canonical).toUpperCase();
    (aliases || []).forEach((alias) => {
      result[String(alias).trim().toUpperCase()] = String(canonical).toUpperCase();
    });
  });
  return Object.freeze(result);
})();

function normalizeSymbol(value) {
  const symbol = String(value || '').trim().toUpperCase();
  if (!symbol || symbol.length > 80) return null;
  return /^[A-Z0-9][A-Z0-9./=^_-]*$/.test(symbol) ? symbol : null;
}

function canonicalizeSymbol(value) {
  const normalized = normalizeSymbol(value);
  return normalized ? (ALIAS_TO_CANONICAL[normalized] || normalized) : null;
}

function normalizeRequestedSymbols(values) {
  const source = Array.isArray(values) ? values : String(values || '').split(',');
  const normalized = source.map(normalizeSymbol).filter(Boolean);
  return [...new Set(normalized)].slice(0, MAX_SYMBOLS);
}

function parseIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return null;
  const date = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) return null;
  return date;
}

function isValidMarketDate(value) {
  return Boolean(parseIsoDate(value));
}

function previousMarketDates(marketDate, count) {
  const parsed = parseIsoDate(marketDate);
  if (!parsed) return [];
  const dates = [];
  const cursor = new Date(parsed);
  while (dates.length < Math.max(0, Math.min(MAX_HISTORY_DAYS, Number(count) || 0))) {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
    if (isMarketDay(cursor)) dates.push(cursor.toISOString().slice(0, 10));
  }
  return dates;
}

function marketDateSequence(marketDate, historyDays = MAX_HISTORY_DAYS) {
  return [marketDate, ...previousMarketDates(marketDate, historyDays)];
}

function defaultResearchMarketDate(now = new Date()) {
  return latestResearchMarketDate(now);
}

function errorLabel(error) {
  return error?.code || error?.name || error?.message || String(error || 'unknown-error');
}

async function queryAllPages(dynamodb, params) {
  const items = [];
  let exclusiveStartKey;
  do {
    const result = await dynamodb.query({
      ...params,
      ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
    }).promise();
    items.push(...(result.Items || []));
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return items;
}

async function loadEntityEvents(dynamodb, dates, {
  tableName,
  indexName = ENTITY_EVENTS_INDEX,
} = {}) {
  const rows = await Promise.all(dates.map((marketDate) => queryAllPages(dynamodb, {
    TableName: tableName,
    IndexName: indexName,
    KeyConditionExpression: '#marketDate = :marketDate',
    ExpressionAttributeNames: { '#marketDate': 'marketDate' },
    ExpressionAttributeValues: { ':marketDate': marketDate },
  })));
  return rows.flat();
}

async function loadProductManifests(dynamodb, dates, { tableName } = {}) {
  const rows = await Promise.all(dates.map((marketDate) => queryAllPages(dynamodb, {
    TableName: tableName,
    KeyConditionExpression: '#marketDate = :marketDate',
    ExpressionAttributeNames: { '#marketDate': 'marketDate' },
    ExpressionAttributeValues: { ':marketDate': marketDate },
  })));
  return rows.flat();
}

async function batchGetSnapshots(dynamodb, dates, {
  tableName = 'HedgeyeDailySnapshot',
  snapshotTypes = RESEARCH_PRODUCTS.flatMap((product) => product.snapshotTypes),
} = {}) {
  const uniqueTypes = [...new Set(snapshotTypes.filter(Boolean))];
  const keys = dates.flatMap((date) => uniqueTypes.map((snapshotType) => ({ date, snapshotType })));
  const allItems = [];

  for (let offset = 0; offset < keys.length; offset += 100) {
    let pending = keys.slice(offset, offset + 100);
    let attempts = 0;
    while (pending.length > 0 && attempts < 4) {
      const result = await dynamodb.batchGet({
        RequestItems: {
          [tableName]: {
            Keys: pending,
            ConsistentRead: false,
          },
        },
      }).promise();
      allItems.push(...(result.Responses?.[tableName] || []));
      pending = result.UnprocessedKeys?.[tableName]?.Keys || [];
      attempts += 1;
    }
    if (pending.length > 0) {
      const error = new Error(`DynamoDB left ${pending.length} snapshot keys unprocessed`);
      error.code = 'UnprocessedKeys';
      throw error;
    }
  }
  return allItems;
}

async function loadSecurityIntelligenceInputs({
  dynamodb,
  marketDate,
  historyDays = MAX_HISTORY_DAYS,
  now = new Date(),
  riskRangeLoader,
  entityEventsTable = 'ResearchEntityEventsV1',
  productManifestTable = 'ResearchProductManifestsV1',
  entityEventsIndex = ENTITY_EVENTS_INDEX,
  snapshotTable = 'HedgeyeDailySnapshot',
} = {}) {
  const dates = marketDateSequence(marketDate, historyDays);
  const loadErrors = {};
  const tasks = {
    snapshots: batchGetSnapshots(dynamodb, dates, { tableName: snapshotTable }),
    entityEvents: loadEntityEvents(dynamodb, dates, {
      tableName: entityEventsTable,
      indexName: entityEventsIndex,
    }),
    productManifests: loadProductManifests(dynamodb, dates, { tableName: productManifestTable }),
    riskRangeEnvelope: typeof riskRangeLoader === 'function'
      ? Promise.resolve().then(() => riskRangeLoader({ now }))
      : Promise.resolve(null),
  };

  const entries = await Promise.all(Object.entries(tasks).map(async ([key, promise]) => {
    try {
      return [key, await promise];
    } catch (error) {
      loadErrors[key] = errorLabel(error);
      return [key, key === 'riskRangeEnvelope' ? null : []];
    }
  }));

  return {
    ...Object.fromEntries(entries),
    dates,
    loadErrors,
  };
}

function asArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const normalized = typeof value === 'string' ? value.replace(/,/g, '').trim() : value;
  const result = Number(normalized);
  return Number.isFinite(result) ? result : null;
}

function normalizeBias(value) {
  return normalizeResearchBias(value);
}

function productIdForSnapshot(snapshot) {
  const raw = String(snapshot?.snapshotType || '').trim().toLowerCase();
  return raw ? (getResearchProduct(raw)?.id || raw) : null;
}

function productIdForEvent(event) {
  const raw = String(event?.productId || event?.productKey || '').trim().toLowerCase();
  return raw ? (getResearchProduct(raw)?.id || raw) : null;
}

function manifestProductId(manifest) {
  const raw = String(
    manifest?.productKey || manifest?.productId || manifest?.snapshotType || manifest?.reportType || '',
  ).trim().toLowerCase();
  return raw ? (getResearchProduct(raw)?.id || raw) : null;
}

function filterSourceQualityRevisions(records, manifests, { snapshots = false } = {}) {
  const manifestBySource = new Map(asArray(manifests).map((manifest) => [
    `${manifest?.marketDate}\u0000${manifestProductId(manifest)}`,
    manifest,
  ]));
  return asArray(records).filter((record) => {
    const productId = snapshots ? productIdForSnapshot(record) : productIdForEvent(record);
    const date = snapshots ? record?.date : record?.marketDate;
    const manifest = manifestBySource.get(`${date}\u0000${productId}`);
    const artifacts = asArray(manifest?.artifacts);
    const revision = String(record?.sourceQualityRevision || record?.sourceQuality?.revision || '');
    const revisedArtifacts = artifacts.filter((artifact) => artifact?.sourceQuality?.revision);
    // Original immutable events remain in the ledger for audit. A revised
    // projection becomes current only when the exact source artifact selects
    // that revision; do not count both attempts as published evidence.
    if (!revision && !revisedArtifacts.length) return true;
    const hash = String(record?.contentSha256 || record?.contentHash || record?.sourceEventId || '');
    const messageId = String(record?.sourceMessageId || record?.gmailMessageId || '');
    const sourceKey = String(record?.htmlSource || record?.pdfS3Key || record?.sourceArtifact || '');
    const hashMatches = hash ? artifacts.filter((artifact) => (
      [artifact?.contentSha256, artifact?.artifactId].includes(hash)
    )) : [];
    const keyMatches = sourceKey ? artifacts.filter((artifact) => artifact?.sourceKey === sourceKey) : [];
    const matched = hashMatches.length ? hashMatches : keyMatches.length ? keyMatches : (
      record?.contentSha256 ? [] : artifacts.filter((artifact) => (
        messageId && artifact?.sourceMessageId === messageId
      ))
    );
    if (matched.length !== 1) return false;
    return revision === String(matched[0]?.sourceQuality?.revision || '');
  });
}

function manifestHasFailure(manifest) {
  return Boolean(
    manifest?.error ||
    manifest?.lastError ||
    asArray(manifest?.errors).length ||
    finiteNumber(manifest?.failedCount) > 0 ||
    asArray(manifest?.artifacts).some((artifact) => (
      artifact?.error || String(artifact?.stage || '').toLowerCase() === 'failed'
    )) ||
    String(manifest?.status || manifest?.state || '').toLowerCase() === 'failed' ||
    String(manifest?.completionState || '').toLowerCase() === 'failed',
  );
}

function normalizeManifestStatus(manifest, { snapshotObserved = false } = {}) {
  if (manifestHasFailure(manifest)) return 'failed';
  const direct = [
    manifest?.status,
    manifest?.state,
    manifest?.stage,
    manifest?.processingStage,
  ].map((value) => String(value || '').trim().toLowerCase()).find((value) => (
    VALID_PRODUCT_STATES.has(value) && !['not_due', 'missing', 'failed'].includes(value)
  ));
  if (direct) return direct;

  const stages = manifest?.stages || manifest?.stageStatus || manifest?.processingStages || {};
  for (const stage of ['indexed', 'validated', 'parsed', 'received']) {
    const stageValue = stages?.[stage];
    if (
      stageValue === true ||
      ['complete', 'completed', 'success', 'succeeded', stage].includes(String(stageValue || '').toLowerCase()) ||
      manifest?.[`${stage}At`] ||
      finiteNumber(manifest?.[`${stage}Count`]) > 0
    ) {
      return stage;
    }
  }
  if (String(manifest?.completionState || '').toLowerCase() === 'complete') return 'indexed';
  if (manifest) return 'received';
  return snapshotObserved ? 'parsed' : null;
}

function manifestChecksumForArtifacts(artifacts) {
  const canonical = asArray(artifacts)
    .map((artifact) => ({
      artifactId: artifact?.artifactId ?? null,
      contentSha256: artifact?.contentSha256 ?? null,
      eventCount: finiteNumber(artifact?.eventCount) ?? 0,
      parserVersion: artifact?.parserVersion ?? null,
      stage: artifact?.stage ?? null,
    }))
    .sort((a, b) => String(a.artifactId || '').localeCompare(String(b.artifactId || '')));
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function indexedManifestVerificationError(manifest, visibleEventCount, normalizedStatus) {
  if (normalizedStatus !== 'indexed') return null;
  if (!manifest || finiteNumber(manifest.schemaVersion) !== RESPONSE_SCHEMA_VERSION) {
    return 'manifest-schema-version-invalid';
  }
  if (!String(manifest.parserVersion || '').trim()) return 'manifest-parser-version-missing';

  const counts = ['received', 'parsed', 'validated', 'indexed']
    .map((stage) => finiteNumber(manifest?.[`${stage}Count`]));
  if (counts.some((count) => count === null)) return 'manifest-stage-counts-missing';
  const [receivedCount] = counts;
  if (
    receivedCount <= 0 ||
    counts.some((count) => !Number.isInteger(count) || count !== receivedCount)
  ) {
    return 'manifest-stage-count-mismatch';
  }

  const artifacts = asArray(manifest?.artifacts);
  if (
    artifacts.length !== receivedCount ||
    artifacts.some((artifact) => !String(artifact?.artifactId || '').trim()) ||
    new Set(artifacts.map((artifact) => String(artifact.artifactId))).size !== artifacts.length
  ) {
    return 'manifest-artifact-count-mismatch';
  }
  if (artifacts.some((artifact) => (
    String(artifact?.stage || '').toLowerCase() !== 'indexed' ||
    !String(artifact?.parserVersion || '').trim()
  ))) {
    return 'manifest-artifact-stage-mismatch';
  }
  const manifestChecksum = String(manifest?.manifestChecksum || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(manifestChecksum)) return 'manifest-checksum-missing';
  if (manifestChecksum !== manifestChecksumForArtifacts(artifacts)) {
    return 'manifest-checksum-mismatch';
  }
  const expectedEvents = finiteNumber(manifest?.entityEventCount);
  if (expectedEvents === null || !Number.isInteger(expectedEvents) || expectedEvents < 0) {
    return 'manifest-event-count-missing';
  }
  const artifactEventCount = artifacts.reduce(
    (sum, artifact) => sum + (finiteNumber(artifact?.eventCount) ?? 0),
    0,
  );
  if (artifactEventCount !== expectedEvents) return 'manifest-artifact-event-count-mismatch';
  if (visibleEventCount !== expectedEvents) {
    return 'manifest-event-count-mismatch';
  }
  return null;
}

function resolveEvidenceStatus({
  manifest,
  snapshotObserved = false,
  visibleEventCount = 0,
}) {
  let status = normalizeManifestStatus(manifest, { snapshotObserved });
  let verificationError = indexedManifestVerificationError(
    manifest,
    visibleEventCount,
    status,
  );
  if (verificationError) status = 'failed';
  if (!manifest && visibleEventCount > 0) {
    status = snapshotObserved ? 'parsed' : 'received';
    verificationError = 'manifest-missing-for-observed-product';
  }
  return { status, verificationError };
}

function productCoverage({
  marketDate,
  now,
  snapshots,
  entityEvents,
  manifests,
  riskRangeEnvelope,
}) {
  const currentSnapshots = snapshots.filter((item) => item?.date === marketDate);
  const currentEvents = entityEvents.filter((item) => item?.marketDate === marketDate);
  const currentManifests = manifests.filter((item) => item?.marketDate === marketDate);
  const manifestByProduct = new Map();
  currentManifests.forEach((manifest) => {
    const productId = manifestProductId(manifest);
    if (productId) manifestByProduct.set(productId, manifest);
  });

  const latestPublicationTimestamp = ({ manifest, productSnapshots, productEvents }) => {
    const candidates = [
      manifest?.publishedAt,
      manifest?.latestPublishedAt,
      manifest?.sourcePublishedAt,
      ...asArray(manifest?.artifacts).flatMap((artifact) => [
        artifact?.publishedAt,
        artifact?.sourcePublishedAt,
      ]),
      ...productSnapshots.flatMap((snapshot) => [
        snapshot?.publishedAt,
        snapshot?.scrapedAt,
      ]),
      ...productEvents.flatMap((event) => [
        event?.publishedAt,
        event?.eventTime,
      ]),
    ].filter((value) => {
      if (!value) return false;
      const parsed = new Date(value);
      return !Number.isNaN(parsed.getTime());
    });
    return candidates
      .map((value) => new Date(value).toISOString())
      .sort()
      .pop() || null;
  };

  const rows = RESEARCH_PRODUCTS.map((product) => {
    const productSnapshots = currentSnapshots.filter((snapshot) => productIdForSnapshot(snapshot) === product.id);
    const productEvents = currentEvents.filter((event) => productIdForEvent(event) === product.id);
    const manifest = manifestByProduct.get(product.id) || null;
    const observed = Boolean(manifest || productSnapshots.length || productEvents.length);
    const due = isResearchProductDue(product, { now, marketDate });
    const evidence = resolveEvidenceStatus({
      manifest,
      snapshotObserved: productSnapshots.length > 0,
      visibleEventCount: productEvents.length,
    });
    let { status, verificationError } = evidence;

    const primaryRiskRangeVerified = (
      product.id === 'risk-ranges' &&
      product.authorities.trend === true &&
      product.authorities.riskRange === true &&
      riskRangeEnvelope?.status === 'current' &&
      riskRangeEnvelope?.available === true &&
      riskRangeEnvelope?.manifest?.publicationDate === marketDate &&
      riskRangeEnvelope?.manifest?.persistedManifestVerified === true
    );
    if (primaryRiskRangeVerified) {
      status = 'indexed';
      verificationError = null;
    } else if (product.id === 'risk-ranges' && status === 'indexed') {
      // The generic product manifest proves that a candidate artifact completed
      // the common pipeline, but only the independently verified primary
      // publication manifest may complete decision-grade Risk Ranges.
      status = 'validated';
      verificationError = 'primary-risk-range-manifest-unverified';
    }
    if (!status) status = due ? 'missing' : 'not_due';

    return {
      id: product.id,
      label: product.label,
      status,
      marketDate,
      cadence: product.cadence,
      due,
      observed,
      publishedAt: latestPublicationTimestamp({
        manifest,
        productSnapshots,
        productEvents,
      }),
      snapshotCount: productSnapshots.length,
      eventCount: productEvents.length,
      artifactCount: manifest
        ? finiteNumber(manifest?.artifactCount) ??
          finiteNumber(manifest?.receivedCount) ??
          asArray(manifest?.artifacts).length
        : productSnapshots.length + productEvents.length,
      parsedCount: finiteNumber(manifest?.parsedCount),
      validatedCount: finiteNumber(manifest?.validatedCount),
      indexedCount: finiteNumber(manifest?.indexedCount) ?? (
        status === 'indexed' ? productEvents.length : null
      ),
      error: manifest?.error ||
        manifest?.lastError ||
        asArray(manifest?.errors)[0] ||
        asArray(manifest?.artifacts).find((artifact) => artifact?.error)?.error ||
        verificationError ||
        null,
    };
  });

  const unsupportedIds = new Set([
    ...currentManifests.map(manifestProductId),
    ...currentSnapshots.map(productIdForSnapshot),
    ...currentEvents.map(productIdForEvent),
  ].filter((id) => id && !RESEARCH_PRODUCT_BY_ID[id]));
  unsupportedIds.forEach((id) => {
    const manifest = currentManifests.find((item) => manifestProductId(item) === id) || null;
    const snapshotCount = currentSnapshots.filter((snapshot) => productIdForSnapshot(snapshot) === id).length;
    const eventCount = currentEvents.filter((event) => productIdForEvent(event) === id).length;
    const productSnapshots = currentSnapshots.filter((snapshot) => productIdForSnapshot(snapshot) === id);
    const productEvents = currentEvents.filter((event) => productIdForEvent(event) === id);
    rows.push({
      id,
      label: manifest?.productLabel || id,
      status: 'failed',
      marketDate,
      cadence: 'unsupported',
      due: false,
      observed: true,
      publishedAt: latestPublicationTimestamp({
        manifest,
        productSnapshots,
        productEvents,
      }),
      snapshotCount,
      eventCount,
      artifactCount: manifest
        ? finiteNumber(manifest?.artifactCount) ??
          finiteNumber(manifest?.receivedCount) ??
          asArray(manifest?.artifacts).length
        : snapshotCount + eventCount,
      parsedCount: finiteNumber(manifest?.parsedCount),
      validatedCount: finiteNumber(manifest?.validatedCount),
      indexedCount: finiteNumber(manifest?.indexedCount),
      error: manifest?.error || manifest?.lastError || 'unsupported-product',
    });
  });

  return rows;
}

function statusByProduct(products) {
  return Object.fromEntries(products.map((product) => [product.id, product.status]));
}

function candidatesForSymbol(symbol) {
  const canonical = canonicalizeSymbol(symbol);
  const aliases = ENTITY_CATALOG.tickerAliases?.[canonical] || [];
  return new Set([symbol, canonical, ...aliases].map((value) => String(value || '').trim().toUpperCase()));
}

function securityExposuresForSymbol(symbol) {
  const normalized = normalizeSymbol(symbol);
  const canonical = canonicalizeSymbol(symbol);
  const tags = [
    ...getSecurityExposureTags(normalized),
    ...getSecurityExposureTags(canonical),
  ];
  return [
    ...new Map(tags.map((tag) => [`${tag.type}\u0000${tag.id}`, tag])).values(),
  ];
}

function publicExposureTag(tag) {
  return {
    id: tag.id,
    type: tag.type,
    label: tag.label,
  };
}

function exposureTagsMatch(left, right) {
  return Boolean(
    left &&
    right &&
    left.id === right.id &&
    left.type === right.type,
  );
}

function extractTicker(value) {
  if (value && typeof value === 'object') {
    return normalizeSymbol(value.ticker || value.symbol || value.security || value.asset);
  }
  const text = String(value || '').trim();
  const parenthetical = [...text.matchAll(/\(([A-Z0-9./=^_-]{1,20})\)/g)].at(-1);
  if (parenthetical) return normalizeSymbol(parenthetical[1]);
  return normalizeSymbol(text);
}

function symbolMatches(candidate, symbol) {
  const normalizedCandidate = normalizeSymbol(candidate);
  return Boolean(
    normalizedCandidate &&
    canonicalizeSymbol(normalizedCandidate) === canonicalizeSymbol(symbol),
  );
}

function matchSymbols(candidate, requestedSymbols) {
  const ticker = extractTicker(candidate);
  return ticker
    ? requestedSymbols.filter((symbol) => symbolMatches(ticker, symbol))
    : [];
}

function structuredTickerEventIsEligible(event, symbol) {
  const canonical = canonicalizeSymbol(symbol);
  if (!isStructuredOnlyTicker(canonical)) return true;
  const matchType = String(event?.matchType || '').trim().toLowerCase();
  const kind = String(event?.eventType || event?.kind || '').trim().toLowerCase();
  return matchType === 'structured_membership' && STRUCTURED_TICKER_EVENT_KINDS.has(kind);
}

function sourceUrlForSnapshot(snapshot) {
  if (snapshot?.article?.feedUrl) return snapshot.article.feedUrl;
  if (snapshot?.sourceUrl) return snapshot.sourceUrl;
  if (!(snapshot?.date && snapshot?.snapshotType)) return null;
  return `/api/hedgeye/screenshot/${encodeURIComponent(snapshot.date)}/content?type=${encodeURIComponent(snapshot.snapshotType)}`;
}

function publicEventSourceUrl(event, productId) {
  const sourceUrl = String(event?.sourceUrl || event?.artifactUrl || '').trim();
  if (/^https?:\/\//i.test(sourceUrl) || sourceUrl.startsWith('/')) return sourceUrl;
  if (!(event?.marketDate && productId)) return null;
  return `/api/hedgeye/screenshot/${encodeURIComponent(event.marketDate)}/content?type=${encodeURIComponent(productId)}`;
}

function cleanExcerpt(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const withoutBoilerplate = text
    .replace(new RegExp(BOILERPLATE_PATTERN.source, 'ig'), '')
    .replace(/[\s|:;,.()[\]{}<>/_-]+/g, '');
  if (BOILERPLATE_PATTERN.test(text) && withoutBoilerplate.length < 24) return null;
  return text.length > 600 ? `${text.slice(0, 597)}...` : text;
}

function exactEventExcerpt(value) {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text.trim() ? text : null;
}

function referenceId(reference) {
  return crypto.createHash('sha256').update(JSON.stringify([
    reference.marketDate,
    reference.productId,
    reference.kind,
    reference.direction,
    reference.excerpt,
    reference.matchType,
    reference.exposure,
    reference.exposureType,
    reference.sourceEventId,
  ])).digest('hex').slice(0, 24);
}

function makeReference(input) {
  const product = getResearchProduct(input.productId);
  const reference = {
    marketDate: input.marketDate,
    productId: input.productId,
    productLabel: input.productLabel || product?.label || input.productId,
    kind: input.kind || 'mention',
    direction: input.direction ? String(input.direction).toUpperCase() : null,
    excerpt: input.preserveExcerpt
      ? exactEventExcerpt(input.excerpt)
      : cleanExcerpt(input.excerpt),
    matchType: input.matchType || 'direct',
    exposure: input.exposureId || input.exposure || null,
    exposureId: input.exposureId || input.exposure || null,
    exposureType: input.exposureType || null,
    exposureLabel: input.exposureLabel || null,
    publishedAt: input.publishedAt || null,
    sourceUrl: input.sourceUrl || null,
    qualityStatus: input.qualityStatus || 'parsed',
    sourceEventId: input.sourceEventId || null,
  };
  if (input.value !== undefined) reference.value = input.value;
  ['signalProvenance', 'sourceTicker', 'fieldPath', 'sourceText'].forEach((field) => {
    if (input[field] != null) reference[field] = input[field];
  });
  // Optional source-match metadata is additive and lets the UI highlight
  // the exact security mention without changing any decision fields.
  if (input.matchedText) reference.matchedText = String(input.matchedText);
  if (input.decisionEligible !== undefined) {
    reference.decisionEligible = Boolean(input.decisionEligible);
  }
  if (!reference.excerpt) return null;
  return { id: referenceId(reference), ...reference };
}

function addReference(target, reference) {
  if (!reference || target.some((item) => item.id === reference.id)) return;
  target.push(reference);
}

function eventEntity(event) {
  const key = String(event?.entityKey || '');
  const separator = key.indexOf('#');
  if (separator > 0) {
    const kind = key.slice(0, separator).toLowerCase();
    const rawValue = key.slice(separator + 1);
    if (kind === 'ticker') return { kind: 'ticker', value: rawValue };
    if (CONTROLLED_EXPOSURE_TYPE_SET.has(kind)) {
      const exposure = getControlledExposure(
        rawValue,
        event?.exposureType || kind,
        {
          legacyFactor: kind === 'factor' && !event?.exposureType,
        },
      );
      return exposure
        ? { kind: 'exposure', exposure }
        : { kind: null, value: null };
    }
    return {
      kind,
      value: rawValue,
    };
  }
  const symbol = normalizeSymbol(event?.ticker || event?.symbol);
  if (symbol) return { kind: 'ticker', value: symbol };
  const exposureType = String(event?.exposureType || (event?.factor ? 'factor' : ''))
    .trim()
    .toLowerCase();
  const exposure = getControlledExposure(
    event?.exposureId || event?.exposure || event?.factor,
    exposureType || null,
    { legacyFactor: !event?.exposureType },
  );
  if (exposure) return { kind: 'exposure', exposure };
  return { kind: null, value: null };
}

function referenceFromEvent(event, matchType, exposure, qualityStatus) {
  const productId = productIdForEvent(event);
  const entity = eventEntity(event);
  const trade = publishedTradeFromEvent(event);
  const originalKind = event.eventType || event.kind || 'mention';
  return makeReference({
    marketDate: event.marketDate,
    productId,
    productLabel: event.productLabel,
    kind: trade ? 'trade_signal' : ['trade_signal', 'tracker_trade'].includes(originalKind) ? 'mention' : originalKind,
    direction: event.direction || event.action || event.side || null,
    excerpt: event.excerpt || event.summary || event.description || event.headline || null,
    preserveExcerpt: true,
    matchType,
    exposureId: exposure?.id || null,
    exposureType: exposure?.type || null,
    exposureLabel: exposure?.label || null,
    publishedAt: event.publishedAt || event.eventTime || null,
    sourceUrl: publicEventSourceUrl(event, productId),
    matchedText: event.matchedText
      || exposure?.label
      || (entity.kind === 'ticker' ? entity.value : null),
    // The daily manifest is the authority for pipeline quality. A row-level
    // "validated" marker cannot upgrade a missing or failed manifest.
    qualityStatus: qualityStatus || event.qualityStatus || 'received',
    sourceEventId: event.sourceEventId || event.eventId || event.eventKey || null,
    value: trade?.value ?? event.value ?? event.signalValue ?? event.payload?.value,
    signalProvenance: trade?.signalProvenance,
    sourceTicker: trade?.sourceTicker || event.sourceTicker || (entity.kind === 'ticker' ? entity.value : null),
    fieldPath: trade?.fieldPath || event.fieldPath,
    sourceText: trade?.sourceText || event.sourceText,
    decisionEligible: event.decisionEligible,
  });
}

function structuredEntryReference({
  snapshot,
  productId,
  kind,
  direction,
  excerpt,
  ticker,
  requestedSymbols,
  matchRequestedSymbols,
  qualityStatus,
  decisionEligible,
  value,
}) {
  const sourceTicker = extractTicker(ticker);
  const matches = matchRequestedSymbols ? matchRequestedSymbols(sourceTicker) : matchSymbols(ticker, requestedSymbols);
  return matches.map((symbol) => ({
    symbol,
    reference: makeReference({
      marketDate: snapshot.date,
      productId,
      kind,
      direction,
      excerpt,
      matchType: normalizeSymbol(sourceTicker) === normalizeSymbol(symbol)
        ? 'direct'
        : 'direct_alias',
      publishedAt: snapshot.publishedAt || snapshot.scrapedAt || null,
      sourceUrl: sourceUrlForSnapshot(snapshot),
      matchedText: sourceTicker || null,
      qualityStatus,
      decisionEligible,
      value,
    }),
  }));
}

function riskRangeEntries(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
  return Object.entries(data).map(([key, value]) => {
    if (!value || typeof value !== 'object') return null;
    const ticker = extractTicker(value) || extractTicker(value.originalName) || extractTicker(key);
    const lrr = finiteNumber(value.lrr ?? value.low ?? value.riskRangeLow);
    const hrr = finiteNumber(value.hrr ?? value.high ?? value.riskRangeHigh);
    if (!ticker || lrr === null || hrr === null || lrr > hrr) return null;
    return { ticker, lrr, hrr, trend: normalizeBias(value.trend), raw: value };
  }).filter(Boolean);
}

function trackerContainers(data) {
  if (!data || typeof data !== 'object') return [];
  return [data, data.stocks, data.cryptos, data.securities, data.data]
    .filter((container) => container && typeof container === 'object' && !Array.isArray(container));
}

function collectNarrativeTexts(value, key = '', depth = 0) {
  if (depth > 5 || value == null) return [];
  if (typeof value === 'string') {
    return /(headline|teaser|summary|note|takeaway|section|commentary|transcript|body|text)/i.test(key)
      ? [value]
      : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectNarrativeTexts(entry, key, depth + 1));
  }
  if (typeof value === 'object') {
    return Object.entries(value).flatMap(([childKey, child]) => (
      collectNarrativeTexts(child, childKey, depth + 1)
    ));
  }
  return [];
}

function tokenPattern(token) {
  const escaped = String(token || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return escaped ? new RegExp(`(^|[^A-Z0-9])${escaped}([^A-Z0-9]|$)`, 'i') : null;
}

function prepareNarrativeReferenceMatchers(requestedSymbols) {
  const symbols = Object.freeze([...requestedSymbols]);
  const matchers = symbols.map((symbol) => {
    const structuredOnly = isStructuredOnlyTicker(canonicalizeSymbol(symbol));
    const candidates = structuredOnly ? [] : [...candidatesForSymbol(symbol)].map((token) => (
      Object.freeze({ token, pattern: tokenPattern(token) })
    ));
    return Object.freeze({ structuredOnly, candidates: Object.freeze(candidates) });
  });
  // Retain formatting machinery for this exact request, never publications,
  // holdings, or matches from another capture.
  return Object.freeze({ symbols, matchers: Object.freeze(matchers) });
}

function prepareStructuredReferenceMatchers(requestedSymbols) {
  const symbols = Object.freeze([...requestedSymbols]);
  const canonicalSymbols = new Map();
  const tradeSymbols = new Map();
  const empty = Object.freeze([]);
  symbols.forEach((symbol) => {
    const canonical = canonicalizeSymbol(symbol);
    if (!canonical) return;
    if (!canonicalSymbols.has(canonical)) canonicalSymbols.set(canonical, []);
    canonicalSymbols.get(canonical).push(symbol);
  });
  canonicalSymbols.forEach(Object.freeze);
  return Object.freeze({
    symbols,
    matchStructuredTicker(ticker) {
      return canonicalSymbols.get(canonicalizeSymbol(ticker)) || empty;
    },
    matchTradeTicker(ticker) {
      const key = String(ticker || '').trim().toUpperCase();
      if (!tradeSymbols.has(key)) {
        // Published Trade aliases identify an exact instrument. Keep their
        // matcher separate from the broader research exposure aliases above.
        tradeSymbols.set(key, Object.freeze(symbols.filter(symbol => sameSignalInstrument(key, symbol))));
      }
      return tradeSymbols.get(key);
    },
  });
}

function narrativeReferences(snapshot, requestedSymbols, qualityStatus, {
  skipExposureMentions = false,
  preparedNarrativeMatchers = null,
} = {}) {
  const productId = productIdForSnapshot(snapshot);
  const texts = [
    ...collectNarrativeTexts(snapshot.article, 'article'),
    ...collectNarrativeTexts(snapshot.data, 'data'),
  ].map(cleanExcerpt).filter(Boolean);
  const result = [];
  const prepared = preparedNarrativeMatchers?.symbols?.length === requestedSymbols.length
    && preparedNarrativeMatchers.symbols.every((symbol, index) => symbol === requestedSymbols[index])
    ? preparedNarrativeMatchers.matchers : null;

  texts.forEach((excerpt) => {
    requestedSymbols.forEach((symbol, index) => {
      // AM and PM are valid securities, but unstructured newsletter text
      // cannot distinguish them from meridiem tokens. Their evidence must
      // originate from a typed ticker-bearing field.
      const matcher = prepared?.[index];
      if (matcher ? matcher.structuredOnly : isStructuredOnlyTicker(canonicalizeSymbol(symbol))) return;
      const matched = matcher
        ? matcher.candidates.find((candidate) => candidate.pattern?.test(excerpt))?.token
        : [...candidatesForSymbol(symbol)].find((candidate) => tokenPattern(candidate)?.test(excerpt));
      if (matched) {
        result.push({
          symbol,
          reference: makeReference({
            marketDate: snapshot.date,
            productId,
            kind: 'summary_mention',
            excerpt,
            matchedText: matched,
            matchType: normalizeSymbol(matched) === normalizeSymbol(symbol) ? 'direct' : 'direct_alias',
            publishedAt: snapshot.publishedAt || snapshot.scrapedAt || null,
            sourceUrl: sourceUrlForSnapshot(snapshot),
            qualityStatus,
          }),
        });
      }

      if (skipExposureMentions === true) return;
      const exposures = securityExposuresForSymbol(symbol);
      exposures.forEach((exposure) => {
        const aliases = exposure.aliases || [exposure.id];
        if (aliases.some((alias) => tokenPattern(alias)?.test(excerpt))) {
          result.push({
            symbol,
            reference: makeReference({
              marketDate: snapshot.date,
              productId,
            kind: `${exposure.type}_mention`,
            excerpt,
            matchedText: aliases.find((alias) => tokenPattern(alias)?.test(excerpt)) || exposure.label,
            matchType: 'inferred_exposure',
              exposureId: exposure.id,
              exposureType: exposure.type,
              exposureLabel: exposure.label,
              publishedAt: snapshot.publishedAt || snapshot.scrapedAt || null,
              sourceUrl: sourceUrlForSnapshot(snapshot),
              qualityStatus,
              decisionEligible: false,
            }),
          });
        }
      });
    });
  });
  return result;
}

function extractSnapshotReferences(snapshot, requestedSymbols, qualityStatus, {
  includeUnverifiedRiskRanges = false,
  skipExposureMentions = false,
  skipNarrativeMentions = false,
  preparedNarrativeMatchers = null,
  preparedStructuredMatchers = null,
} = {}) {
  const productId = productIdForSnapshot(snapshot);
  const data = snapshot?.data || {};
  const result = [];
  const push = (entries) => result.push(...entries);
  const prepared = preparedStructuredMatchers?.symbols?.length === requestedSymbols.length
    && preparedStructuredMatchers.symbols.every((symbol, index) => symbol === requestedSymbols[index])
    ? preparedStructuredMatchers : null;
  const structuredEntry = input => structuredEntryReference({
    ...input, matchRequestedSymbols: prepared?.matchStructuredTicker,
  });

  if (productId === 'early-look' || (productId === 'risk-ranges' && includeUnverifiedRiskRanges)) {
    riskRangeEntries(data).forEach((range) => {
      push(structuredEntry({
        snapshot,
        productId,
        kind: productId === 'early-look' ? 'supplemental_risk_range' : 'historical_risk_range',
        direction: range.trend,
        excerpt: `LRR ${range.lrr} – HRR ${range.hrr}${range.trend ? `; Trend ${range.trend}` : ''}`,
        ticker: range.ticker,
        requestedSymbols,
        qualityStatus,
        decisionEligible: false,
        value: { lrr: range.lrr, hrr: range.hrr, trend: range.trend },
      }));
    });
  }

  if (productId === 'investing-ideas') {
    const positions = asArray(data.positions).length
      ? asArray(data.positions)
      : [
        ...asArray(data.longs).map((ticker) => ({ ticker, side: 'Long' })),
        ...asArray(data.shorts).map((ticker) => ({ ticker, side: 'Short' })),
      ];
    positions.forEach((position) => {
      const ticker = extractTicker(position);
      if (!ticker) return;
      const rawSide = String(position?.side || position?.position || '').toUpperCase();
      const side = rawSide === 'SHORT' ? 'SHORT' : rawSide === 'LONG' ? 'LONG' : null;
      if (!side) return;
      const bias = side === 'LONG' ? 'BULLISH' : 'BEARISH';
      const lrr = finiteNumber(position?.lrr);
      const hrr = finiteNumber(position?.hrr);
      const prevClose = finiteNumber(position?.prevClose);
      push(structuredEntry({
        snapshot,
        productId,
        kind: 'investing_idea_position',
        direction: bias,
        excerpt: [
          `${ticker} ${side}`,
          prevClose !== null ? `Prev Close ${prevClose}` : null,
          lrr !== null && hrr !== null ? `LRR ${lrr} – HRR ${hrr}` : null,
        ].filter(Boolean).join('; '),
        ticker,
        requestedSymbols,
        qualityStatus,
        decisionEligible: false,
        value: {
          side,
          bias,
          prevClose,
          lrr,
          hrr,
        },
      }));
    });
  }

  extractPublishedTradeSignals(snapshot, {
    sourceVerified: ['indexed', 'validated'].includes(qualityStatus),
  }).forEach((trade) => {
    const matchedSymbols = prepared
      ? prepared.matchTradeTicker(trade.sourceTicker)
      : requestedSymbols.filter((symbol) => sameSignalInstrument(trade.sourceTicker, symbol));
    matchedSymbols.forEach((symbol) => {
      result.push({ symbol, reference: makeReference({
        marketDate: snapshot.date, productId, kind: 'trade_signal', direction: trade.value,
        excerpt: trade.sourceText, preserveExcerpt: true,
        matchType: trade.sourceTicker === symbol ? 'direct' : 'direct_alias',
        matchedText: trade.sourceTicker, sourceTicker: trade.sourceTicker,
        publishedAt: trade.publishedAt, sourceUrl: trade.sourceUrl || sourceUrlForSnapshot(snapshot),
        qualityStatus, value: trade.value, signalProvenance: trade.signalProvenance,
        sourceText: trade.sourceText, fieldPath: trade.fieldPath,
      }) });
    });
  });

  if (['momo-tracker', 'bitcoin-trend-tracker'].includes(productId)) {
    trackerContainers(data).forEach((container) => Object.entries(container).forEach(([key, slot]) => {
      const trend = normalizeBias(slot?.trend);
      const ticker = extractTicker(slot) || key;
      if (!trend) return;
      push(structuredEntry({ snapshot, productId, kind: 'trend_signal', direction: trend,
        excerpt: `${ticker}: Trend ${trend}`, ticker, requestedSymbols, qualityStatus,
        decisionEligible: false, value: { trend, lrr: finiteNumber(slot.lrr ?? slot.buyTrade), hrr: finiteNumber(slot.hrr ?? slot.sellTrade) },
      }));
    }));
  }

  if (productId === 'signal-strength' || productId === 'signal-strength-shorts') {
    const prefix = productId === 'signal-strength-shorts' ? 'signal_strength_short' : 'signal_strength';
    const label = productId === 'signal-strength-shorts' ? 'Signal Strength Shorts' : 'Signal Strength';
    [
      ['added', `${prefix}_added`, 'ADDED'],
      ['removed', `${prefix}_removed`, 'REMOVED'],
    ].forEach(([field, kind, direction]) => {
      asArray(data[field]).forEach((entry) => {
        const ticker = extractTicker(entry);
        if (!ticker) return;
        push(structuredEntry({
          snapshot,
          productId,
          kind,
          direction,
          excerpt: `${ticker} ${direction.toLowerCase()} ${direction === 'ADDED' ? 'to' : 'from'} ${label}`,
          ticker,
          requestedSymbols,
          qualityStatus,
          value: direction,
        }));
      });
    });
  }

  if (productId === 'portfolio-solutions') {
    asArray(data.rankings).forEach((entry) => {
      const ticker = extractTicker(entry);
      if (!ticker) return;
      const rank = finiteNumber(entry.rank);
      push(structuredEntry({
        snapshot,
        productId,
        kind: 'portfolio_solutions_rank',
        excerpt: [
          `${ticker}${rank !== null ? ` ranked #${rank}` : ' is ranked'}`,
          entry.positionSizing ? `Sizing ${entry.positionSizing}` : null,
          entry.weekAgo ? `Weekly ${entry.weekAgo}` : null,
        ].filter(Boolean).join('; '),
        ticker,
        requestedSymbols,
        qualityStatus,
        value: rank,
      }));
    });
    Object.entries(data.topMovers || {}).forEach(([period, entries]) => {
      asArray(entries).forEach((entry) => {
        const ticker = extractTicker(entry);
        if (!ticker) return;
        push(structuredEntry({
          snapshot,
          productId,
          kind: 'portfolio_solutions_mover',
          direction: finiteNumber(entry.change) > 0 ? 'UP' : finiteNumber(entry.change) < 0 ? 'DOWN' : null,
          excerpt: `${ticker} ${period} rank change ${entry.change}`,
          ticker,
          requestedSymbols,
          qualityStatus,
          value: finiteNumber(entry.change),
        }));
      });
    });
  }

  if (productId === 'the-call' || productId === 'the-macro-show') {
    [
      ['longs', 'LONG'],
      ['shorts', 'SHORT'],
      ['neutrals', 'NEUTRAL'],
    ].forEach(([field, direction]) => {
      asArray(data[field]).forEach((entry) => {
        const ticker = extractTicker(entry);
        if (!ticker) return;
        push(structuredEntry({
          snapshot,
          productId,
          kind: 'position_mention',
          direction,
          excerpt: `${String(entry).trim()} — ${direction}`,
          ticker,
          requestedSymbols,
          qualityStatus,
          value: direction,
        }));
      });
    });
  }

  if (productId === 'real-time-alert') {
    const alerts = asArray(data.alerts).length ? asArray(data.alerts) : asArray(data.alert ? [data.alert] : []);
    alerts.forEach((alert) => {
      const ticker = extractTicker(alert);
      if (!ticker) return;
      push(structuredEntry({
        snapshot,
        productId,
        kind: 'real_time_alert',
        direction: alert.action || alert.side,
        excerpt: alert.signalPhrase || alert.headline || `${alert.action || 'Alert'} ${ticker}`,
        ticker,
        requestedSymbols,
        qualityStatus,
        value: alert.action || alert.side || null,
      }));
    });
  }

  if (productId === 'etf-pro') {
    const changes = asArray(data.changes).length
      ? asArray(data.changes)
      : [
        ...asArray(data.added).map((ticker) => ({ ticker, action: 'ADD' })),
        ...asArray(data.removed).map((ticker) => ({ ticker, action: 'REMOVE' })),
      ];
    changes.forEach((change) => {
      const ticker = extractTicker(change);
      if (!ticker) return;
      push(structuredEntry({
        snapshot,
        productId,
        kind: 'etf_pro_change',
        direction: change.action || change.side || change.call,
        excerpt: [
          `${change.action || 'UPDATE'} ${ticker}`,
          change.side || change.call,
          change.etf,
        ].filter(Boolean).join(' — '),
        ticker,
        requestedSymbols,
        qualityStatus,
        value: change.action || null,
      }));
    });
  }

  if (skipNarrativeMentions !== true) {
    push(narrativeReferences(snapshot, requestedSymbols, qualityStatus, {
      skipExposureMentions, preparedNarrativeMatchers,
    }));
  }
  return result.filter((item) => item.reference);
}

function findRiskRange(ranges, symbol) {
  if (!ranges || typeof ranges !== 'object') return null;
  const candidates = candidatesForSymbol(symbol);
  for (const [key, value] of Object.entries(ranges)) {
    if ([...candidates].some((candidate) => symbolMatches(key, candidate))) {
      const lrr = finiteNumber(value?.lrr);
      const hrr = finiteNumber(value?.hrr);
      if (lrr !== null && hrr !== null && lrr <= hrr) {
        return { key, value: { ...value, lrr, hrr } };
      }
    }
  }
  return null;
}

function unavailableDecision(reason) {
  return {
    status: 'unavailable',
    value: null,
    sourceId: null,
    sourceLabel: null,
    sourceDate: null,
    publishedAt: null,
    reason,
  };
}

function decisionInputs({
  symbol,
  marketDate,
  references,
  productsById,
  riskRangeEnvelope,
  loadErrors,
}) {
  const decision = {
    trade: unavailableDecision(loadErrors.snapshots || loadErrors.productManifests
      ? 'research-source-unavailable'
      : 'no-verified-published-trade-signal'),
    trend: unavailableDecision(loadErrors.riskRangeEnvelope
      ? 'risk-range-source-unavailable'
      : 'no-manifest-verified-primary-risk-range'),
    riskRange: {
      ...unavailableDecision(loadErrors.riskRangeEnvelope
        ? 'risk-range-source-unavailable'
        : 'no-manifest-verified-primary-risk-range'),
      lrr: null,
      hrr: null,
      trend: null,
      decisionEligible: false,
    },
    signalStrength: unavailableDecision('no-explicit-signal-strength-event'),
    signalStrengthShorts: unavailableDecision('no-explicit-signal-strength-shorts-event'),
  };

  const riskTrusted = (
    riskRangeEnvelope?.status === 'current' &&
    riskRangeEnvelope?.available === true &&
    riskRangeEnvelope?.manifest?.publicationDate === marketDate &&
    riskRangeEnvelope?.manifest?.persistedManifestVerified === true
  );
  if (riskTrusted) {
    const selected = findRiskRange(riskRangeEnvelope.ranges, symbol);
    if (selected) {
      const value = selected.value;
      decision.riskRange = {
        status: 'available',
        value: { lrr: value.lrr, hrr: value.hrr },
        lrr: value.lrr,
        hrr: value.hrr,
        trend: normalizeBias(value.trend),
        sourceId: 'risk-ranges',
        sourceLabel: RESEARCH_PRODUCT_BY_ID['risk-ranges'].label,
        sourceDate: marketDate,
        publishedAt: value.timestamp || riskRangeEnvelope.manifest.latestUpdatedAt || null,
        decisionEligible: true,
        reason: null,
      };
      const trend = normalizeBias(value.trend);
      if (trend) {
        decision.trend = {
          status: 'available',
          value: trend,
          sourceId: 'risk-ranges',
          sourceLabel: RESEARCH_PRODUCT_BY_ID['risk-ranges'].label,
          sourceDate: marketDate,
          publishedAt: value.timestamp || riskRangeEnvelope.manifest.latestUpdatedAt || null,
          reason: null,
        };
      }
    } else {
      decision.riskRange.reason = 'symbol-not-in-verified-primary-publication';
      decision.trend.reason = 'symbol-not-in-verified-primary-publication';
    }
  }

  const trackerCandidates = [];
  const researchProjectionVerified = !loadErrors.entityEvents && !loadErrors.productManifests;
  if (researchProjectionVerified) {
    references
      .filter((reference) => (
        isExplicitTradeProvenance(reference.signalProvenance) &&
        sameSignalInstrument(reference.sourceTicker, symbol) &&
        reference.marketDate === marketDate &&
        productsById[reference.productId] === 'indexed' &&
        ['trade_signal', 'tracker_trade'].includes(reference.kind) &&
        ['direct', 'direct_alias'].includes(reference.matchType)
      ))
      .forEach((reference) => {
        // A positive/negative narrative direction is not a published tracker
        // signal. Decision-grade TRADE requires the explicit structured value.
        const value = normalizeBias(reference.value);
        if (!value) return;
        trackerCandidates.push({
          value,
          sourceId: reference.productId,
          sourceLabel: reference.productLabel,
          sourceDate: reference.marketDate,
          publishedAt: reference.publishedAt,
          sourceUrl: reference.sourceUrl, sourceTicker: reference.sourceTicker, ticker: reference.sourceTicker,
          fieldPath: reference.fieldPath, sourceText: reference.sourceText, signalProvenance: reference.signalProvenance,
          qualityStatus: reference.qualityStatus, matchType: reference.matchType,
        });
      });
  }

  const latestTrackerCandidates = [];
  let trackerPublicationConflict = false;
  const candidatesByProduct = new Map();
  trackerCandidates.forEach((candidate) => {
    const rows = candidatesByProduct.get(candidate.sourceId) || [];
    rows.push(candidate);
    candidatesByProduct.set(candidate.sourceId, rows);
  });
  candidatesByProduct.forEach((candidates) => {
    const timestamps = candidates.map((candidate) => Date.parse(candidate.publishedAt || ''));
    const allDated = timestamps.every(Number.isFinite);
    const latestTimestamp = allDated ? Math.max(...timestamps) : null;
    const latest = allDated
      ? candidates.filter((candidate) => Date.parse(candidate.publishedAt) === latestTimestamp)
      : candidates;
    const productValues = [...new Set(latest.map((candidate) => candidate.value))];
    if (productValues.length > 1) {
      trackerPublicationConflict = true;
      return;
    }
    if (latest.length > 0) {
      latestTrackerCandidates.push(latest.sort((a, b) => (
        String(b.publishedAt || '').localeCompare(String(a.publishedAt || ''))
      ))[0]);
    }
  });

  // Across products, a later publication that day supersedes an earlier one
  // when every send time is known; otherwise any disagreement is a conflict.
  const sentAt = (candidate) => (/T00:00:00(?:\.000)?(?:Z|\+00:00)$/.test(String(candidate.publishedAt || ''))
    ? NaN : Date.parse(candidate.publishedAt || ''));
  const timed = latestTrackerCandidates.length > 0 && latestTrackerCandidates.every((candidate) => Number.isFinite(sentAt(candidate)));
  const latestSent = timed ? Math.max(...latestTrackerCandidates.map(sentAt)) : null;
  const deciding = timed ? latestTrackerCandidates.filter((candidate) => sentAt(candidate) === latestSent) : latestTrackerCandidates;
  const uniqueTrackerValues = [...new Set(deciding.map((candidate) => candidate.value))];
  if (trackerPublicationConflict || uniqueTrackerValues.length > 1) {
    decision.trade = {
      ...unavailableDecision('conflicting-published-trade-signals'),
      status: 'conflict',
    };
  } else if (deciding.length > 0) {
    const selected = deciding.sort((a, b) => (
      String(b.publishedAt || '').localeCompare(String(a.publishedAt || ''))
    ))[0];
    decision.trade = { status: 'available', ...selected, reason: null };
  }

  for (const [productId, field] of [['signal-strength', 'signalStrength'], ['signal-strength-shorts', 'signalStrengthShorts']]) {
    const kinds = SIGNAL_STRENGTH_KINDS[productId];
    const signalReferences = references.filter((reference) => (
      researchProjectionVerified &&
      SIGNAL_STRENGTH_SOURCE_PRODUCTS[productId].includes(reference.productId) &&
      reference.marketDate === marketDate &&
      productsById[reference.productId] === 'indexed' &&
      reference.qualityStatus === 'indexed' &&
      ['direct', 'direct_alias'].includes(reference.matchType) &&
      Object.hasOwn(kinds, reference.kind)
    ));
    if (signalReferences.length === 0) continue;
    const signalValueForReference = (reference) => kinds[reference.kind] || reference.value || 'LISTED';
    const signalTimestamps = signalReferences.map((reference) => Date.parse(reference.publishedAt || ''));
    const allDated = signalTimestamps.every(Number.isFinite);
    const latestSignalTimestamp = allDated ? Math.max(...signalTimestamps) : null;
    const latestSignalReferences = allDated
      ? signalReferences.filter((reference) => (
        Date.parse(reference.publishedAt) === latestSignalTimestamp
      ))
      : signalReferences;
    const signalValues = [
      ...new Set(latestSignalReferences.map(signalValueForReference)),
    ];
    if (signalValues.length > 1) {
      decision[field] = {
        ...unavailableDecision(`conflicting-${productId}-events`),
        status: 'conflict',
      };
      continue;
    }
    const signalReference = latestSignalReferences[0];
    decision[field] = {
      status: 'available',
      value: signalValues[0],
      sourceId: productId,
      sourceLabel: RESEARCH_PRODUCT_BY_ID[productId]?.label || signalReference.productLabel,
      sourceDate: signalReference.marketDate,
      publishedAt: signalReference.publishedAt,
      reason: null,
    };
  }
  return decision;
}

function historicalDecision(reference, value, extra = {}) {
  return {
    status: 'historical',
    value,
    sourceId: reference.productId,
    sourceLabel: reference.productLabel,
    sourceDate: reference.marketDate,
    publishedAt: reference.publishedAt || null,
    qualityStatus: reference.qualityStatus,
    sourceUrl: reference.sourceUrl, sourceTicker: reference.sourceTicker, ticker: reference.sourceTicker,
    fieldPath: reference.fieldPath, sourceText: reference.sourceText, signalProvenance: reference.signalProvenance,
    matchType: reference.matchType,
    referenceOnly: true,
    executable: false,
    currentDecisionEligible: false,
    reason: null,
    ...extra,
  };
}

function latestReference(references) {
  return [...references].sort((left, right) => (
    String(right.publishedAt || right.marketDate || right.sourceDate || '').localeCompare(
      String(left.publishedAt || left.marketDate || left.sourceDate || ''),
    )
  ))[0] || null;
}

function buildLastVerifiedDecision({
  symbol,
  bucketsForSymbol,
  dates,
  latestVerifiedByProduct,
}) {
  const result = {};
  const verifiedQuality = new Set(['indexed', 'validated']);
  const referencesForDate = (date) => [
    ...asArray(bucketsForSymbol?.[date]?.direct),
    ...asArray(bucketsForSymbol?.[date]?.inferred),
  ];

  const tradeReferences = dates.flatMap(referencesForDate).filter((reference) => (
    verifiedQuality.has(reference.qualityStatus) && isExplicitTradeProvenance(reference.signalProvenance)
    && sameSignalInstrument(reference.sourceTicker, symbol)
    && ['direct', 'direct_alias'].includes(reference.matchType)
  ));
  const retained = selectLatestPublishedTrade(tradeReferences.map((reference) => ({
    ...reference, date: reference.marketDate, ticker: reference.sourceTicker,
  })), { ticker: symbol });
  if (retained?.status === 'conflict') {
    result.trade = { ...unavailableDecision('conflicting-published-trade-signals'), status: 'conflict',
      referenceOnly: true, executable: false, currentDecisionEligible: false };
  } else if (retained) result.trade = historicalDecision(retained, retained.value);

  const riskPublication = latestVerifiedByProduct['risk-ranges'];
  if (riskPublication) {
    const rangeReference = latestReference(
      referencesForDate(riskPublication.marketDate)
        .filter((reference) => (
          reference.productId === 'risk-ranges'
          && verifiedQuality.has(reference.qualityStatus)
          && ['primary_risk_range', 'historical_risk_range'].includes(reference.kind)
          && ['direct', 'direct_alias'].includes(reference.matchType)
          && finiteNumber(reference.value?.lrr) !== null
          && finiteNumber(reference.value?.hrr) !== null
          && finiteNumber(reference.value?.lrr) <= finiteNumber(reference.value?.hrr)
        )),
    );
    if (rangeReference) {
      const lrr = finiteNumber(rangeReference.value.lrr);
      const hrr = finiteNumber(rangeReference.value.hrr);
      const trend = normalizeBias(rangeReference.value.trend)
        || (isCanonicalResearchBias(rangeReference.direction)
          ? normalizeBias(rangeReference.direction)
          : null);
      result.riskRange = historicalDecision(
        rangeReference,
        { lrr, hrr },
        {
          lrr,
          hrr,
          trend,
          publicationDecisionEligible: true,
          decisionEligible: false,
        },
      );
      if (trend) {
        result.trend = historicalDecision(rangeReference, trend, {
          publicationDecisionEligible: true,
        });
      }
    }
  }

  for (const [productId, field] of [['signal-strength', 'signalStrength'], ['signal-strength-shorts', 'signalStrengthShorts']]) {
    const kinds = SIGNAL_STRENGTH_KINDS[productId];
    const signalReferences = dates.flatMap(referencesForDate)
      .filter((reference) => (
        SIGNAL_STRENGTH_SOURCE_PRODUCTS[productId].includes(reference.productId)
        && verifiedQuality.has(reference.qualityStatus)
        && ['direct', 'direct_alias'].includes(reference.matchType)
        && Object.hasOwn(kinds, reference.kind)
      ));
    if (signalReferences.length === 0) continue;
    const selected = latestReference(signalReferences);
    const selectedTimestamp = selected?.publishedAt || selected?.marketDate;
    const contemporaneous = signalReferences.filter((reference) => (
      (reference.publishedAt || reference.marketDate) === selectedTimestamp
    ));
    const values = [...new Set(contemporaneous.map((reference) => kinds[reference.kind] || reference.value || 'LISTED'))];
    result[field] = values.length > 1
      ? {
        ...unavailableDecision(`conflicting-last-verified-${productId}-events`),
        status: 'conflict',
        referenceOnly: true,
        executable: false,
        currentDecisionEligible: false,
      }
      : historicalDecision(selected, values[0], {
        changeOnly: true,
        sourceId: productId,
        sourceLabel: RESEARCH_PRODUCT_BY_ID[productId]?.label || selected.productLabel,
      });
  }

  return result;
}

function supplementalRangeForSymbol(symbol, marketDate, snapshots, productsById) {
  if (RESEARCH_PRODUCT_BY_ID['early-look']?.authorities.supplementalRiskRange !== true) return null;
  const snapshot = snapshots
    .filter((item) => (
      item?.date === marketDate && productIdForSnapshot(item) === 'early-look'
    ))
    .sort((a, b) => (
      String(b.publishedAt || b.scrapedAt || '').localeCompare(
        String(a.publishedAt || a.scrapedAt || ''),
      )
    ))
    .find((item) => riskRangeEntries(item.data).some((range) => symbolMatches(range.ticker, symbol)));
  if (!snapshot) return null;
  const range = riskRangeEntries(snapshot.data).find((item) => symbolMatches(item.ticker, symbol));
  if (!range) return null;
  const pipelineStatus = productsById['early-look'] || 'parsed';
  return {
    status: pipelineStatus === 'indexed' ? 'available' : 'unavailable',
    pipelineStatus,
    lrr: range.lrr,
    hrr: range.hrr,
    trend: range.trend,
    sourceId: 'early-look',
    sourceLabel: RESEARCH_PRODUCT_BY_ID['early-look'].label,
    sourceDate: marketDate,
    publishedAt: snapshot.publishedAt || snapshot.scrapedAt || null,
    decisionEligible: false,
  };
}

function sortReferences(references) {
  return references.sort((a, b) => (
    String(b.publishedAt || b.marketDate || '').localeCompare(String(a.publishedAt || a.marketDate || '')) ||
    String(a.productLabel).localeCompare(String(b.productLabel)) ||
    String(a.id).localeCompare(String(b.id))
  ));
}

function coverageState({ products, loadErrors, totalCurrentReferences }) {
  const errors = Object.entries(loadErrors || {});
  const hasAnyLoader = ['snapshots', 'entityEvents', 'productManifests']
    .some((key) => !loadErrors?.[key]);
  if (!hasAnyLoader && errors.length > 0) return 'unavailable';

  const incomplete = products.some((product) => (
    product.status === 'failed' ||
    product.status === 'missing' ||
    (product.observed && product.status !== 'indexed')
  ));
  if (errors.length > 0 || incomplete) return 'partial';
  return totalCurrentReferences > 0 ? 'complete' : 'no_references';
}

function buildSecurityIntelligence({
  symbols,
  marketDate,
  historyDays = MAX_HISTORY_DAYS,
  now = new Date(),
  snapshots = [],
  entityEvents = [],
  productManifests = [],
  riskRangeEnvelope = null,
  publishedTradeReadings = [],
  loadErrors = {},
} = {}) {
  const requestedSymbols = normalizeRequestedSymbols(symbols);
  const normalizedHistoryDays = Math.max(0, Math.min(MAX_HISTORY_DAYS, Number(historyDays) || 0));
  const dates = marketDateSequence(marketDate, normalizedHistoryDays);
  const dateSet = new Set(dates);
  const filteredManifests = asArray(productManifests).filter((item) => dateSet.has(item?.marketDate));
  const filteredSnapshots = filterSourceQualityRevisions(
    asArray(snapshots).filter((item) => dateSet.has(item?.date)),
    filteredManifests,
    { snapshots: true },
  );
  const filteredEvents = filterSourceQualityRevisions(
    asArray(entityEvents).filter((item) => dateSet.has(item?.marketDate)),
    filteredManifests,
  );
  const products = productCoverage({
    marketDate,
    now,
    snapshots: filteredSnapshots,
    entityEvents: filteredEvents,
    manifests: filteredManifests,
    riskRangeEnvelope,
  });
  const productsById = statusByProduct(products);
  const evidenceKeys = new Set();
  const manifestsByEvidenceKey = new Map();
  const snapshotCountsByEvidenceKey = new Map();
  const eventCountsByEvidenceKey = new Map();
  const evidenceKey = (date, productId) => `${date}\u0000${productId}`;

  filteredManifests.forEach((manifest) => {
    const productId = manifestProductId(manifest);
    if (!productId) return;
    const key = evidenceKey(manifest.marketDate, productId);
    evidenceKeys.add(key);
    manifestsByEvidenceKey.set(key, manifest);
  });
  filteredSnapshots.forEach((snapshot) => {
    const productId = productIdForSnapshot(snapshot);
    if (!productId) return;
    const key = evidenceKey(snapshot.date, productId);
    evidenceKeys.add(key);
    snapshotCountsByEvidenceKey.set(key, (snapshotCountsByEvidenceKey.get(key) || 0) + 1);
  });
  filteredEvents.forEach((event) => {
    const productId = productIdForEvent(event);
    if (!productId) return;
    const key = evidenceKey(event.marketDate, productId);
    evidenceKeys.add(key);
    eventCountsByEvidenceKey.set(key, (eventCountsByEvidenceKey.get(key) || 0) + 1);
  });

  const evidenceStatusByKey = new Map();
  evidenceKeys.forEach((key) => {
    const separator = key.indexOf('\u0000');
    const productId = key.slice(separator + 1);
    if (!RESEARCH_PRODUCT_BY_ID[productId]) {
      evidenceStatusByKey.set(key, 'failed');
      return;
    }
    const evidence = resolveEvidenceStatus({
      manifest: manifestsByEvidenceKey.get(key) || null,
      snapshotObserved: (snapshotCountsByEvidenceKey.get(key) || 0) > 0,
      visibleEventCount: eventCountsByEvidenceKey.get(key) || 0,
    });
    evidenceStatusByKey.set(key, evidence.status || 'received');
  });
  const evidenceQualityStatus = (date, productId) => {
    if (date === marketDate && productsById[productId]) return productsById[productId];
    return evidenceStatusByKey.get(evidenceKey(date, productId)) || 'received';
  };
  const latestVerifiedByProduct = {};
  RESEARCH_PRODUCTS.forEach((product) => {
    const verifiedDate = dates.find((date) => (
      ['indexed', 'validated'].includes(evidenceQualityStatus(date, product.id))
    ));
    if (!verifiedDate) return;
    const manifest = manifestsByEvidenceKey.get(evidenceKey(verifiedDate, product.id)) || null;
    latestVerifiedByProduct[product.id] = {
      id: product.id,
      label: product.label,
      marketDate: verifiedDate,
      status: evidenceQualityStatus(verifiedDate, product.id),
      publishedAt:
        manifest?.publishedAt
        || manifest?.latestPublishedAt
        || manifest?.indexedAt
        || manifest?.validatedAt
        || null,
      referenceOnly: verifiedDate !== marketDate,
      executable: false,
    };
  });

  const buckets = Object.fromEntries(requestedSymbols.map((symbol) => [
    symbol,
    Object.fromEntries(dates.map((date) => [date, { direct: [], inferred: [] }])),
  ]));

  filteredEvents.forEach((event) => {
    const entity = eventEntity(event);
    const productId = productIdForEvent(event);
    const qualityStatus = evidenceQualityStatus(event.marketDate, productId);
    if (entity.kind === 'ticker') {
      if (!structuredTickerEventIsEligible(event, entity.value)) return;
      requestedSymbols
        .filter((symbol) => symbolMatches(entity.value, symbol))
        .forEach((symbol) => {
          const matchType = normalizeSymbol(entity.value) === normalizeSymbol(symbol)
            ? 'direct'
            : 'direct_alias';
          addReference(
            buckets[symbol][event.marketDate].direct,
            referenceFromEvent(event, matchType, null, qualityStatus),
          );
        });
    } else if (entity.kind === 'exposure') {
      requestedSymbols
        .filter((symbol) => securityExposuresForSymbol(symbol).some((exposure) => (
          exposureTagsMatch(exposure, entity.exposure)
        )))
        .forEach((symbol) => {
          addReference(
            buckets[symbol][event.marketDate].inferred,
            referenceFromEvent(
              event,
              'inferred_exposure',
              entity.exposure,
              qualityStatus,
            ),
          );
        });
    }
  });

  filteredSnapshots.forEach((snapshot) => {
    const productId = productIdForSnapshot(snapshot);
    const qualityStatus = evidenceQualityStatus(snapshot.date, productId);
    const includeUnverifiedRiskRanges = snapshot.date !== marketDate;
    extractSnapshotReferences(snapshot, requestedSymbols, qualityStatus, {
      includeUnverifiedRiskRanges,
    }).forEach(({ symbol, reference }) => {
      const target = reference.matchType === 'inferred_exposure'
        ? buckets[symbol][snapshot.date].inferred
        : buckets[symbol][snapshot.date].direct;
      addReference(target, reference);
    });
  });

  const trustedRisk = (
    riskRangeEnvelope?.status === 'current' &&
    riskRangeEnvelope?.available === true &&
    riskRangeEnvelope?.manifest?.publicationDate === marketDate &&
    riskRangeEnvelope?.manifest?.persistedManifestVerified === true
  );
  if (trustedRisk) {
    requestedSymbols.forEach((symbol) => {
      const selected = findRiskRange(riskRangeEnvelope.ranges, symbol);
      if (!selected) return;
      const value = selected.value;
      addReference(buckets[symbol][marketDate].direct, makeReference({
        marketDate,
        productId: 'risk-ranges',
        kind: 'primary_risk_range',
        direction: normalizeBias(value.trend),
        excerpt: `LRR ${value.lrr} – HRR ${value.hrr}${value.trend ? `; Trend ${normalizeBias(value.trend) || value.trend}` : ''}`,
        matchType: normalizeSymbol(selected.key) === normalizeSymbol(symbol) ? 'direct' : 'direct_alias',
        matchedText: selected.key || symbol,
        publishedAt: value.timestamp || riskRangeEnvelope.manifest.latestUpdatedAt || null,
        sourceUrl: `/api/hedgeye/screenshot/${encodeURIComponent(marketDate)}/content?type=risk-ranges`,
        qualityStatus: 'indexed',
        decisionEligible: true,
        value: { lrr: value.lrr, hrr: value.hrr, trend: normalizeBias(value.trend) },
      }));
    });
  }

  // Each artifact in a day's product manifest names the email it came from; a reference keyed by that artifact
  // carries the email id, so its Source can open the original email (user-asked 2026-11-18).
  // A reference without its artifact falls back to the day's product, but only when that day has a single email.
  const messageIdByArtifact = new Map();
  const messageIdsByProductDay = new Map();
  filteredManifests.forEach((manifest) => asArray(manifest?.artifacts).forEach((artifact) => {
    const messageId = String(artifact?.sourceMessageId || '');
    if (!/^[0-9a-f]{12,32}$/i.test(messageId) || String(artifact?.stage || '') !== 'indexed') return;
    [artifact?.artifactId, artifact?.contentSha256].filter(Boolean).forEach((key) => messageIdByArtifact.set(String(key), messageId));
    const day = `${manifest?.marketDate}\u0000${manifestProductId(manifest)}`;
    messageIdsByProductDay.set(day, new Set([...(messageIdsByProductDay.get(day) || []), messageId]));
  }));
  // A stored publication names both its web report and its email, so an exact report link identifies the email too.
  const messageIdByFeedUrl = new Map();
  filteredSnapshots.forEach((snapshot) => {
    const messageId = String(snapshot?.gmailMessageId || snapshot?.sourceMessageId || '');
    const feedUrl = String(snapshot?.article?.feedUrl || '');
    if (/^[0-9a-f]{12,32}$/i.test(messageId) && /^https:\/\/app\.hedgeye\.com\/feed_items\/\d+$/.test(feedUrl)) messageIdByFeedUrl.set(feedUrl, messageId);
  });
  dates.forEach((date) => requestedSymbols.forEach((symbol) => ['direct', 'inferred'].forEach((kind) => {
    buckets[symbol][date][kind].forEach((reference) => {
      if (reference.sourceMessageId) return;
      const byArtifact = (reference.sourceEventId ? messageIdByArtifact.get(String(reference.sourceEventId)) : null)
        || messageIdByFeedUrl.get(String(reference.sourceUrl || '').replace(/\/$/, ''));
      const sameDay = messageIdsByProductDay.get(`${reference.marketDate}\u0000${reference.productId}`);
      const messageId = byArtifact || (sameDay?.size === 1 ? [...sameDay][0] : null);
      if (messageId) reference.sourceMessageId = messageId;
    });
  })));

  let totalCurrentReferences = 0;
  const bySymbol = {};
  requestedSymbols.forEach((symbol) => {
    const directReferences = sortReferences(buckets[symbol][marketDate].direct);
    const inferredReferences = sortReferences(buckets[symbol][marketDate].inferred);
    totalCurrentReferences += directReferences.length + inferredReferences.length;
    const references = [...directReferences, ...inferredReferences];
    const history = dates.slice(1).map((date) => ({
      marketDate: date,
      directReferences: sortReferences(buckets[symbol][date].direct),
      inferredReferences: sortReferences(buckets[symbol][date].inferred),
    }));
    bySymbol[symbol] = {
      symbol,
      canonicalSymbol: canonicalizeSymbol(symbol),
      state: 'no_references',
      decision: decisionInputs({
        symbol,
        marketDate,
        references,
        productsById,
        riskRangeEnvelope,
        loadErrors,
      }),
      lastVerifiedDecision: buildLastVerifiedDecision({
        symbol,
        bucketsForSymbol: buckets[symbol],
        dates,
        latestVerifiedByProduct,
      }),
      supplementalRange: supplementalRangeForSymbol(
        symbol,
        marketDate,
        filteredSnapshots,
        productsById,
      ),
      exposures: securityExposuresForSymbol(symbol).map(publicExposureTag),
      directReferences,
      inferredReferences,
      history,
      coverage: { state: 'no_references', reasons: [] },
    };
    const allTrade = [
      ...asArray(publishedTradeReadings),
      ...dates.flatMap((date) => buckets[symbol][date].direct)
        .filter((reference) => ['indexed', 'validated'].includes(reference.qualityStatus))
        .map((reference) => ({ ...reference, date: reference.marketDate,
          sourceProduct: reference.productId, sourceLabel: reference.productLabel })),
    ].filter((reading) => ['indexed', 'validated'].includes(reading.qualityStatus)
      && isExplicitTradeProvenance(reading.signalProvenance));
    const retained = selectLatestPublishedTrade(allTrade, { ticker: symbol, asOf: marketDate });
    if (retained) {
      const value = retained.status === 'conflict' ? {
        ...unavailableDecision('conflicting-published-trade-signals'), status: 'conflict',
      } : {
        status: 'historical', value: retained.value, sourceId: retained.sourceProduct || retained.productId,
        sourceLabel: retained.sourceLabel || retained.productLabel || getResearchProduct(retained.sourceProduct)?.label,
        sourceDate: retained.date, publishedAt: retained.publishedAt, sourceUrl: retained.sourceUrl,
        sourceTicker: retained.sourceTicker, ticker: retained.sourceTicker,
        fieldPath: retained.fieldPath, sourceText: retained.sourceText,
        signalProvenance: retained.signalProvenance, qualityStatus: retained.qualityStatus,
        matchType: retained.sourceTicker === symbol ? 'direct' : 'direct_alias', reason: null,
      };
      bySymbol[symbol].lastVerifiedDecision.trade = { ...value, referenceOnly: true,
        executable: false, currentDecisionEligible: false };
      if (retained.date === marketDate && retained.status === 'conflict') {
        bySymbol[symbol].decision.trade = { ...value };
      } else if (retained.date === marketDate && retained.qualityStatus === 'indexed'
        && !loadErrors.entityEvents && !loadErrors.productManifests) {
        bySymbol[symbol].decision.trade = { ...value, status: 'available' };
      }
    }
  });

  const state = coverageState({ products, loadErrors, totalCurrentReferences });
  const reasons = [
    ...Object.entries(loadErrors).map(([source, error]) => `${source}:${error}`),
    ...products
      .filter((product) => (
        product.status === 'failed' ||
        product.status === 'missing' ||
        (product.observed && product.status !== 'indexed')
      ))
      .map((product) => `${product.id}:${product.status}`),
  ];
  Object.values(bySymbol).forEach((security) => {
    const hasReferences = security.directReferences.length + security.inferredReferences.length > 0;
    security.state = state === 'complete' && !hasReferences ? 'no_references' : state;
    security.coverage = {
      state: security.state,
      reasons: [...reasons],
    };
  });

  const productCounts = Object.fromEntries(PRODUCT_STAGE_ORDER.map((status) => [
    status,
    products.filter((product) => product.status === status).length,
  ]));
  return {
    schemaVersion: RESPONSE_SCHEMA_VERSION,
    marketDate,
    generatedAt: new Date(now).toISOString(),
    historyDays: normalizedHistoryDays,
    requestedSymbols,
    coverage: {
      state,
      productCounts,
      reasons,
    },
    products,
    latestVerifiedByProduct,
    bySymbol,
  };
}

module.exports = {
  normalizeResearchBias,
  MAX_HISTORY_DAYS,
  MAX_SYMBOLS,
  RESPONSE_SCHEMA_VERSION,
  batchGetSnapshots,
  buildSecurityIntelligence,
  canonicalizeSymbol,
  defaultResearchMarketDate,
  extractSnapshotReferences,
  filterSourceQualityRevisions,
  isValidMarketDate,
  loadEntityEvents,
  loadProductManifests,
  loadSecurityIntelligenceInputs,
  manifestChecksumForArtifacts,
  marketDateSequence,
  normalizeRequestedSymbols,
  prepareNarrativeReferenceMatchers,
  prepareStructuredReferenceMatchers,
  previousMarketDates,
};
