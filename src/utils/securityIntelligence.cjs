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
  latestResearchMarketDate,
} = require('./researchProductRegistry.cjs');

const RESPONSE_SCHEMA_VERSION = 1;
const MAX_SYMBOLS = 200;
const MAX_HISTORY_DAYS = 5;
const ENTITY_EVENTS_INDEX = 'marketDate-index';
const PRODUCT_STAGE_ORDER = ['not_due', 'missing', 'received', 'parsed', 'validated', 'indexed', 'failed'];
const VALID_PRODUCT_STATES = new Set(PRODUCT_STAGE_ORDER);
const TRADE_PRODUCT_IDS = new Set(
  RESEARCH_PRODUCTS
    .filter((product) => product.authorities.trade === true)
    .map((product) => product.id),
);
const CONTROLLED_EXPOSURE_TYPE_SET = new Set(CONTROLLED_EXPOSURE_TYPES);
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
  const normalized = String(value || '').trim().toUpperCase();
  if (['BULLISH', 'BULL', 'LONG', 'BUY', 'POSITIVE'].includes(normalized)) return 'BULLISH';
  if (['BEARISH', 'BEAR', 'SHORT', 'SELL', 'NEGATIVE'].includes(normalized)) return 'BEARISH';
  if (['NEUTRAL', 'HOLD'].includes(normalized)) return 'NEUTRAL';
  return null;
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
  return makeReference({
    marketDate: event.marketDate,
    productId,
    productLabel: event.productLabel,
    kind: event.eventType || event.kind || 'mention',
    direction: event.direction || event.action || event.side || null,
    excerpt: event.excerpt || event.summary || event.description || event.headline || null,
    preserveExcerpt: true,
    matchType,
    exposureId: exposure?.id || null,
    exposureType: exposure?.type || null,
    exposureLabel: exposure?.label || null,
    publishedAt: event.publishedAt || event.eventTime || null,
    sourceUrl: publicEventSourceUrl(event, productId),
    // The daily manifest is the authority for pipeline quality. A row-level
    // "validated" marker cannot upgrade a missing or failed manifest.
    qualityStatus: qualityStatus || event.qualityStatus || 'received',
    sourceEventId: event.sourceEventId || event.eventId || event.eventKey || null,
    value: event.value ?? event.signalValue ?? event.payload?.value,
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
  qualityStatus,
  decisionEligible,
  value,
}) {
  return matchSymbols(ticker, requestedSymbols).map((symbol) => ({
    symbol,
    reference: makeReference({
      marketDate: snapshot.date,
      productId,
      kind,
      direction,
      excerpt,
      matchType: normalizeSymbol(extractTicker(ticker)) === normalizeSymbol(symbol)
        ? 'direct'
        : 'direct_alias',
      publishedAt: snapshot.publishedAt || snapshot.scrapedAt || null,
      sourceUrl: sourceUrlForSnapshot(snapshot),
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

function findTrackerSlot(data, symbol) {
  for (const container of trackerContainers(data)) {
    for (const [key, value] of Object.entries(container)) {
      if (
        value &&
        typeof value === 'object' &&
        symbolMatches(extractTicker(value) || key, symbol)
      ) {
        return value;
      }
    }
  }
  return null;
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

function narrativeReferences(snapshot, requestedSymbols, qualityStatus) {
  const productId = productIdForSnapshot(snapshot);
  const texts = [
    ...collectNarrativeTexts(snapshot.article, 'article'),
    ...collectNarrativeTexts(snapshot.data, 'data'),
  ].map(cleanExcerpt).filter(Boolean);
  const result = [];

  texts.forEach((excerpt) => {
    requestedSymbols.forEach((symbol) => {
      const candidates = [...candidatesForSymbol(symbol)];
      const matched = candidates.find((candidate) => tokenPattern(candidate)?.test(excerpt));
      if (matched) {
        result.push({
          symbol,
          reference: makeReference({
            marketDate: snapshot.date,
            productId,
            kind: 'summary_mention',
            excerpt,
            matchType: normalizeSymbol(matched) === normalizeSymbol(symbol) ? 'direct' : 'direct_alias',
            publishedAt: snapshot.publishedAt || snapshot.scrapedAt || null,
            sourceUrl: sourceUrlForSnapshot(snapshot),
            qualityStatus,
          }),
        });
      }

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
} = {}) {
  const productId = productIdForSnapshot(snapshot);
  const data = snapshot?.data || {};
  const result = [];
  const push = (entries) => result.push(...entries);

  if (productId === 'early-look' || (productId === 'risk-ranges' && includeUnverifiedRiskRanges)) {
    riskRangeEntries(data).forEach((range) => {
      push(structuredEntryReference({
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

  if (TRADE_PRODUCT_IDS.has(productId)) {
    requestedSymbols.forEach((symbol) => {
      const slot = findTrackerSlot(data, symbol);
      const trade = normalizeBias(slot?.trade || slot?.tradeBias || slot?.signal || slot?.trend);
      if (!slot || !trade) return;
      const buyTrade = finiteNumber(slot.buyTrade);
      const sellTrade = finiteNumber(slot.sellTrade);
      result.push({
        symbol,
        reference: makeReference({
          marketDate: snapshot.date,
          productId,
          kind: 'tracker_trade',
          direction: trade,
          excerpt: [
            `Trade ${trade}`,
            buyTrade !== null ? `Buy Trade ${buyTrade}` : null,
            sellTrade !== null ? `Sell Trade ${sellTrade}` : null,
          ].filter(Boolean).join('; '),
          matchType: 'direct',
          publishedAt: snapshot.publishedAt || snapshot.scrapedAt || null,
          sourceUrl: sourceUrlForSnapshot(snapshot),
          qualityStatus,
          value: trade,
        }),
      });
    });
  }

  if (productId === 'signal-strength') {
    [
      ['added', 'signal_strength_added', 'ADDED'],
      ['removed', 'signal_strength_removed', 'REMOVED'],
    ].forEach(([field, kind, direction]) => {
      asArray(data[field]).forEach((entry) => {
        const ticker = extractTicker(entry);
        if (!ticker) return;
        push(structuredEntryReference({
          snapshot,
          productId,
          kind,
          direction,
          excerpt: `${ticker} ${direction.toLowerCase()} ${direction === 'ADDED' ? 'to' : 'from'} Signal Strength`,
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
      push(structuredEntryReference({
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
        push(structuredEntryReference({
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
        push(structuredEntryReference({
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
      push(structuredEntryReference({
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
      push(structuredEntryReference({
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

  push(narrativeReferences(snapshot, requestedSymbols, qualityStatus));
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
      : 'no-verified-published-tracker-signal'),
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
        TRADE_PRODUCT_IDS.has(reference.productId) &&
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

  const uniqueTrackerValues = [...new Set(latestTrackerCandidates.map((candidate) => candidate.value))];
  if (trackerPublicationConflict || uniqueTrackerValues.length > 1) {
    decision.trade = {
      ...unavailableDecision('conflicting-published-tracker-signals'),
      status: 'conflict',
    };
  } else if (latestTrackerCandidates.length > 0) {
    const selected = latestTrackerCandidates.sort((a, b) => (
      String(b.publishedAt || '').localeCompare(String(a.publishedAt || ''))
    ))[0];
    decision.trade = { status: 'available', ...selected, reason: null };
  }

  const signalReferences = references.filter((reference) => (
    researchProjectionVerified &&
    reference.productId === 'signal-strength' &&
    reference.marketDate === marketDate &&
    productsById[reference.productId] === 'indexed' &&
    reference.qualityStatus === 'indexed' &&
    ['direct', 'direct_alias'].includes(reference.matchType) &&
    [
      'signal_strength_added',
      'signal_strength_removed',
      'signal_strength_listed',
      'signal_strength_membership',
    ].includes(reference.kind)
  ));
  const signalValueForReference = (reference) => (
    reference.kind === 'signal_strength_added'
      ? 'ADDED'
      : reference.kind === 'signal_strength_removed'
        ? 'REMOVED'
        : reference.value || 'LISTED'
  );
  if (signalReferences.length > 0) {
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
      decision.signalStrength = {
        ...unavailableDecision('conflicting-signal-strength-events'),
        status: 'conflict',
      };
      return decision;
    }
    const signalReference = latestSignalReferences[0];
    decision.signalStrength = {
      status: 'available',
      value: signalValues[0],
      sourceId: signalReference.productId,
      sourceLabel: signalReference.productLabel,
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

  const tradeCandidates = [];
  let tradeConflict = false;
  TRADE_PRODUCT_IDS.forEach((productId) => {
    const publication = latestVerifiedByProduct[productId];
    if (!publication) return;
    const references = referencesForDate(publication.marketDate)
      .filter((reference) => (
        reference.productId === productId
        && verifiedQuality.has(reference.qualityStatus)
        && ['trade_signal', 'tracker_trade'].includes(reference.kind)
        && ['direct', 'direct_alias'].includes(reference.matchType)
      ));
    if (references.length === 0) return;
    const newestTimestamp = latestReference(references)?.publishedAt || null;
    const latest = newestTimestamp
      ? references.filter((reference) => reference.publishedAt === newestTimestamp)
      : references;
    const values = [...new Set(latest.map((reference) => normalizeBias(reference.value)).filter(Boolean))];
    if (values.length > 1) {
      tradeConflict = true;
      return;
    }
    if (values.length === 1) {
      const selected = latestReference(latest);
      tradeCandidates.push(historicalDecision(selected, values[0]));
    }
  });
  const tradeValues = [...new Set(tradeCandidates.map((candidate) => candidate.value))];
  if (tradeConflict || tradeValues.length > 1) {
    result.trade = {
      ...unavailableDecision('conflicting-last-verified-tracker-signals'),
      status: 'conflict',
      referenceOnly: true,
      executable: false,
      currentDecisionEligible: false,
    };
  } else if (tradeCandidates.length > 0) {
    result.trade = latestReference(tradeCandidates);
  }

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
      const trend = normalizeBias(rangeReference.value.trend || rangeReference.direction);
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

  const signalReferences = dates.flatMap(referencesForDate)
    .filter((reference) => (
      reference.productId === 'signal-strength'
      && verifiedQuality.has(reference.qualityStatus)
      && ['direct', 'direct_alias'].includes(reference.matchType)
      && [
        'signal_strength_added',
        'signal_strength_removed',
        'signal_strength_listed',
        'signal_strength_membership',
      ].includes(reference.kind)
    ));
  if (signalReferences.length > 0) {
    const selected = latestReference(signalReferences);
    const selectedTimestamp = selected?.publishedAt || selected?.marketDate;
    const contemporaneous = signalReferences.filter((reference) => (
      (reference.publishedAt || reference.marketDate) === selectedTimestamp
    ));
    const values = [...new Set(contemporaneous.map((reference) => (
      reference.kind === 'signal_strength_added'
        ? 'ADDED'
        : reference.kind === 'signal_strength_removed'
          ? 'REMOVED'
          : reference.value || 'LISTED'
    )))];
    result.signalStrength = values.length > 1
      ? {
        ...unavailableDecision('conflicting-last-verified-signal-strength-events'),
        status: 'conflict',
        referenceOnly: true,
        executable: false,
        currentDecisionEligible: false,
      }
      : historicalDecision(selected, values[0], { changeOnly: true });
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
  loadErrors = {},
} = {}) {
  const requestedSymbols = normalizeRequestedSymbols(symbols);
  const normalizedHistoryDays = Math.max(0, Math.min(MAX_HISTORY_DAYS, Number(historyDays) || 0));
  const dates = marketDateSequence(marketDate, normalizedHistoryDays);
  const dateSet = new Set(dates);
  const filteredSnapshots = asArray(snapshots).filter((item) => dateSet.has(item?.date));
  const filteredEvents = asArray(entityEvents).filter((item) => dateSet.has(item?.marketDate));
  const filteredManifests = asArray(productManifests).filter((item) => dateSet.has(item?.marketDate));
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
        publishedAt: value.timestamp || riskRangeEnvelope.manifest.latestUpdatedAt || null,
        sourceUrl: `/api/hedgeye/screenshot/${encodeURIComponent(marketDate)}/content?type=risk-ranges`,
        qualityStatus: 'indexed',
        decisionEligible: true,
        value: { lrr: value.lrr, hrr: value.hrr, trend: normalizeBias(value.trend) },
      }));
    });
  }

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
  MAX_HISTORY_DAYS,
  MAX_SYMBOLS,
  RESPONSE_SCHEMA_VERSION,
  batchGetSnapshots,
  buildSecurityIntelligence,
  canonicalizeSymbol,
  defaultResearchMarketDate,
  extractSnapshotReferences,
  isValidMarketDate,
  loadEntityEvents,
  loadProductManifests,
  loadSecurityIntelligenceInputs,
  manifestChecksumForArtifacts,
  marketDateSequence,
  normalizeRequestedSymbols,
  previousMarketDates,
};
