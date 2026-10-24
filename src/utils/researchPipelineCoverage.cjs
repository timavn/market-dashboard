const crypto = require('crypto');
const { formatMarketDate } = require('./marketDateFormat.cjs');
const { sourceQualityIssues } = require('./researchSourceQuality.cjs');
const {
  RESEARCH_PRODUCTS,
  REQUIRED_STAGES,
  getResearchProduct,
  isResearchProductDue,
  latestResearchMarketDate,
} = require('./researchProductRegistry.cjs');

const PIPELINE_STATUS = Object.freeze({
  NOT_DUE: 'not_due',
  MISSING: 'missing',
  RECEIVED: 'received',
  PARSED: 'parsed',
  VALIDATED: 'validated',
  INDEXED: 'indexed',
  FAILED: 'failed',
});

const PIPELINE_STATUS_LABELS = Object.freeze({
  [PIPELINE_STATUS.NOT_DUE]: 'Not due',
  [PIPELINE_STATUS.MISSING]: 'Missing',
  [PIPELINE_STATUS.RECEIVED]: 'Received',
  [PIPELINE_STATUS.PARSED]: 'Parsed',
  [PIPELINE_STATUS.VALIDATED]: 'Validated',
  [PIPELINE_STATUS.INDEXED]: 'Indexed',
  [PIPELINE_STATUS.FAILED]: 'Failed',
});

const STAGE_RANK = Object.freeze({
  received: 1,
  parsed: 2,
  validated: 3,
  indexed: 4,
});

const FAILED_LEDGER_STATUSES = new Set([
  'AUTH_REQUIRED',
  'ERROR',
  'FAILED',
  'PARTIAL_ERROR',
  'TEXTRACT_ERROR',
]);

const RECEIVED_LEDGER_STATUSES = new Set([
  'CLAIMED',
  'DUPLICATE',
  'IN_PROGRESS',
  'STORED',
  'TEXTRACT_DISPATCHED',
  'TEXTRACT_PENDING',
]);

const SUCCESSFUL_MATERIALIZATION_STATUSES = new Set([
  'EVENT_LEDGERED',
  'INDEXED',
  'MATERIALIZED',
  'PARSED',
  'VALIDATED',
]);

function isoDate(value, timeZone = 'America/New_York') {
  if (!value) return null;
  const literal = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(literal)) return literal;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return formatMarketDate(date, timeZone);
}

function observedTime(item) {
  return item?.indexedAt
    || item?.validatedAt
    || item?.parsedAt
    || item?.materializedAt
    || item?.updatedAt
    || item?.scrapedAt
    || item?.receivedAt
    || item?.createdAt
    || item?.eventTime
    || null;
}

function itemMarketDate(item) {
  return item?.marketDate
    || item?.snapshotDate
    || item?.publicationDate
    || item?.date
    || isoDate(item?.receivedAt || item?.createdAt || item?.updatedAt);
}

function rawProductKey(item) {
  return item?.productKey
    || item?.productId
    || item?.snapshotType
    || item?.reportType
    || item?.sourceProduct
    || null;
}

function isSyntheticLedgerItem(item) {
  const messageId = String(item?.messageId || '');
  return messageId.startsWith('runtime#gmail#') || messageId.startsWith('CONTENT#');
}

function isArtifactLedgerItem(item) {
  return Boolean(item && !isSyntheticLedgerItem(item) && (
    item.filename
    || item.s3Key
    || item.attachmentId
    || rawProductKey(item)
  ));
}

function isNonEmptyObject(value) {
  return Boolean(value && typeof value === 'object' && (
    Array.isArray(value) ? value.length > 0 : Object.keys(value).length > 0
  ));
}

function explicitCount(item) {
  const candidates = [
    item?.indexedCount,
    item?.entityEventCount,
    item?.validatedCount,
    item?.parsedCount,
    item?.researchEventCount,
    item?.itemCount,
    item?.changeCount,
    item?.stockCount,
    item?.rankingCount,
    item?.riskRangeCount,
    item?.metricsCount,
  ];
  const value = candidates.find((candidate) => Number.isFinite(Number(candidate)));
  if (value !== undefined) return Number(value);
  if (Array.isArray(item?.data)) return item.data.length;
  if (isNonEmptyObject(item?.data)) return Object.keys(item.data).length;
  return null;
}

function manifestStage(item) {
  const value = String(
    item?.stage
      || item?.pipelineStage
      || item?.processingStage
      || item?.completionState
      || item?.state
      || item?.status
      || '',
  ).trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (value === 'complete' || value === 'success' || value === 'succeeded') return 'indexed';
  if (value.includes('index')) return 'indexed';
  if (value.includes('valid')) return 'validated';
  if (value.includes('pars') || value.includes('material')) return 'parsed';
  if (value.includes('receiv') || value.includes('stor')) return 'received';
  return null;
}

function manifestFailed(item) {
  const value = String(
    item?.status || item?.state || item?.completionState || '',
  ).trim().toUpperCase();
  return FAILED_LEDGER_STATUSES.has(value)
    || item?.error
    || item?.lastError
    || item?.errorCode
    || Number(item?.failedCount || 0) > 0
    || (Array.isArray(item?.errors) && item.errors.length > 0)
    || (Array.isArray(item?.artifacts) && item.artifacts.some((artifact) => (
      String(artifact?.stage || '').toLowerCase() === 'failed' || artifact?.error
    )));
}

function manifestFailureDetail(item) {
  return item?.error
    || item?.lastError
    || (Array.isArray(item?.errors) ? item.errors[0] : null)
    || (Array.isArray(item?.artifacts)
      ? item.artifacts.find((artifact) => artifact?.error)?.error
      : null)
    || null;
}

function coverageHash(value) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex');
}

function newest(items) {
  return [...items].sort((left, right) => (
    String(observedTime(right) || '').localeCompare(String(observedTime(left) || ''))
  ))[0] || null;
}

function evidenceForProduct({
  product,
  marketDate,
  now,
  ledgerItems,
  snapshotItems,
  eventItems,
  manifestItems,
  riskRange,
  collectionErrors,
}) {
  const productIds = new Set(product.snapshotTypes || [product.id]);
  const matchesProduct = (item) => {
    const resolved = getResearchProduct(rawProductKey(item));
    return resolved?.id === product.id || productIds.has(String(rawProductKey(item) || '').toLowerCase());
  };
  const forDate = (item) => itemMarketDate(item) === marketDate;
  const artifacts = ledgerItems.filter((item) => isArtifactLedgerItem(item) && matchesProduct(item) && forDate(item));
  const snapshots = snapshotItems.filter((item) => matchesProduct(item) && forDate(item));
  const events = eventItems.filter((item) => matchesProduct(item) && forDate(item));
  const manifests = manifestItems.filter((item) => matchesProduct(item) && forDate(item));
  const latestManifest = newest(manifests);
  const latestArtifact = newest(artifacts);
  const latestSnapshot = newest(snapshots);
  const latestEvent = newest(events);

  const artifactFailures = artifacts.filter((item) => (
    FAILED_LEDGER_STATUSES.has(String(item?.status || '').toUpperCase())
    || String(item?.materializationStatus || '').toUpperCase() === 'ERROR'
    || item?.parseError
  ));
  const manifestFailures = manifests.filter(manifestFailed);
  const due = isResearchProductDue(product, { now, marketDate });
  const uniqueArtifactIds = new Set(artifacts.map((item) => (
    item?.contentSha256
      || item?.s3Key
      || `${item?.messageId || 'message'}#${item?.attachmentId || 'attachment'}`
  )));
  const manifestReceivedCount = Number(latestManifest?.receivedCount);
  const manifestIndexedCount = Number(latestManifest?.indexedCount);
  const manifestEntityEventCount = Number(latestManifest?.entityEventCount);
  const manifestEntityEventsVisible = Number.isFinite(manifestEntityEventCount)
    && manifestEntityEventCount >= 0
    && events.length >= manifestEntityEventCount;
  const manifestCoversReceivedArtifacts = latestManifest
    && Number.isFinite(manifestReceivedCount)
    && Number.isFinite(manifestIndexedCount)
    && manifestReceivedCount > 0
    && manifestIndexedCount === manifestReceivedCount
    && manifestReceivedCount >= uniqueArtifactIds.size
    && manifestEntityEventsVisible;
  const manifestCompletenessMismatch = latestManifest
    && STAGE_RANK[manifestStage(latestManifest)] >= STAGE_RANK.indexed
    && !manifestCoversReceivedArtifacts;
  const received = artifacts.some((item) => (
    RECEIVED_LEDGER_STATUSES.has(String(item?.status || '').toUpperCase())
    || item?.s3Key
    || item?.contentSha256
  )) || manifests.some((item) => STAGE_RANK[manifestStage(item)] >= STAGE_RANK.received);
  const parsed = snapshots.length > 0
    || artifacts.some((item) => (
      item?.snapshotType
      && itemMarketDate(item) === marketDate
      && (
        item?.researchParserVersion
        || SUCCESSFUL_MATERIALIZATION_STATUSES.has(String(item?.materializationStatus || '').toUpperCase())
      )
    ))
    || manifests.some((item) => STAGE_RANK[manifestStage(item)] >= STAGE_RANK.parsed);
  const validated = snapshots.some((item) => {
    const validationStatus = String(
      item?.validationStatus
        || item?.dataQuality?.status
        || '',
    ).trim().toLowerCase();
    return ['ok', 'pass', 'passed', 'success', 'validated'].includes(validationStatus)
      && (
        isNonEmptyObject(item?.data)
        || Number(explicitCount(item)) > 0
        || item?.available === true
        || item?.dataQuality?.allowsEmpty === true
      );
  })
    || manifests.some((item) => STAGE_RANK[manifestStage(item)] >= STAGE_RANK.validated);
  const manifestIndexed = STAGE_RANK[manifestStage(latestManifest)] >= STAGE_RANK.indexed
    && manifestCoversReceivedArtifacts;
  const indexed = Boolean(manifestIndexed);

  const riskManifestReasons = Array.isArray(riskRange?.diagnostics?.manifestReasons)
    ? riskRange.diagnostics.manifestReasons
    : [];
  const riskRangeCurrent = product.id === 'risk-ranges'
    && riskRange?.status === 'success'
    && riskRange?.available === true
    && riskRange?.lastRun === marketDate
    && riskManifestReasons.length === 0;
  const riskRangeFailed = product.id === 'risk-ranges'
    && ['error', 'failed', 'stale'].includes(String(riskRange?.status || '').toLowerCase());
  // A generic research-product manifest proves that an artifact was processed,
  // but it cannot make Risk Ranges decision-grade. Only the independently
  // verified current primary publication gate may complete that product.
  const indexedStage = product.id === 'risk-ranges' ? riskRangeCurrent : indexed;
  const validatedStage = validated || indexedStage;
  const parsedStage = parsed || validatedStage;
  const receivedStage = received || parsedStage;
  const stages = {
    received: receivedStage,
    parsed: parsedStage,
    validated: validatedStage,
    indexed: indexedStage,
  };

  let status = PIPELINE_STATUS.NOT_DUE;
  let errorCode = null;
  let detail = `${product.label} has no publication due for ${marketDate}.`;
  const evidenceUnavailable = collectionErrors.length > 0;
  if (evidenceUnavailable) {
    status = PIPELINE_STATUS.FAILED;
    errorCode = 'RESEARCH_PIPELINE_EVIDENCE_UNAVAILABLE';
    detail = `Pipeline evidence could not be verified: ${collectionErrors.join(' ')}`;
  } else if (artifactFailures.length > 0 || manifestFailures.length > 0 || riskRangeFailed) {
    status = PIPELINE_STATUS.FAILED;
    errorCode = artifactFailures[0]?.errorCode
      || manifestFailures[0]?.errorCode
      || riskRange?.errorCode
      || 'RESEARCH_PRODUCT_PROCESSING_FAILED';
    detail = artifactFailures[0]?.parseError
      || artifactFailures[0]?.error
      || manifestFailureDetail(manifestFailures[0])
      || riskRange?.error
      || `${product.label} has a failed publication artifact.`;
  } else if (manifestCompletenessMismatch) {
    status = PIPELINE_STATUS.FAILED;
    errorCode = 'RESEARCH_PRODUCT_ARTIFACT_COUNT_MISMATCH';
    detail = `${product.label} manifest does not prove that every received artifact and entity event was indexed.`;
  } else if (stages.indexed) {
    status = PIPELINE_STATUS.INDEXED;
    detail = `${product.label} completed receipt, parsing, validation, and entity indexing.`;
  } else if (stages.validated) {
    status = PIPELINE_STATUS.VALIDATED;
    detail = `${product.label} validated successfully but entity indexing is not verified.`;
  } else if (stages.parsed) {
    status = PIPELINE_STATUS.PARSED;
    detail = `${product.label} parsed successfully but validation is not verified.`;
  } else if (stages.received) {
    status = PIPELINE_STATUS.RECEIVED;
    detail = `${product.label} was received but parsing is not verified.`;
  } else if (due) {
    status = PIPELINE_STATUS.MISSING;
    errorCode = 'RESEARCH_PRODUCT_DUE_MISSING';
    detail = `${product.label} is due for ${marketDate}, but no artifact was received.`;
  }

  const evidenceItems = [
    latestManifest,
    latestEvent,
    latestSnapshot,
    latestArtifact,
  ].filter(Boolean);
  const latestEvidence = newest(evidenceItems);
  const sourceIds = [...new Set(evidenceItems.flatMap((item) => [
    item?.sourceArtifact,
    item?.s3Key,
    item?.sourceMessageId,
    item?.messageId,
    ...(Array.isArray(item?.artifacts) ? item.artifacts.flatMap((artifact) => [
      artifact?.sourceKey,
      artifact?.sourceMessageId,
    ]) : []),
  ]).filter(Boolean).map(String))];
  const counts = {
    artifacts: Math.max(
      artifacts.length,
      Number.isFinite(manifestReceivedCount) ? manifestReceivedCount : 0,
    ),
    snapshots: snapshots.length,
    events: events.length,
    manifests: manifests.length,
    failures: artifactFailures.length
      + manifestFailures.length
      + (riskRangeFailed ? 1 : 0)
      + (manifestCompletenessMismatch ? 1 : 0),
  };
  const qualityIssues = sourceQualityIssues(artifacts, snapshots, manifests);
  const sourceQuality = qualityIssues.length ? { status: 'discrepancy', issues: qualityIssues } : null;

  return {
    id: product.id,
    label: product.label,
    cadence: product.cadence,
    due,
    status,
    statusLabel: PIPELINE_STATUS_LABELS[status],
    marketDate,
    observedAt: observedTime(latestEvidence) || riskRange?.scrapedAt || riskRange?.lastRun || null,
    publicationDate: itemMarketDate(latestEvidence) || riskRange?.lastRun || null,
    stages,
    counts,
    requiredStages: [...(product.requiredStages || REQUIRED_STAGES)],
    errorCode,
    detail,
    sourceIds,
    ...(sourceQuality ? { sourceQuality } : {}),
    evidenceHash: coverageHash({
      productId: product.id,
      marketDate,
      stages,
      counts,
      sourceIds,
      ...(sourceQuality ? { sourceQuality } : {}),
    }),
  };
}

function unknownProductRows({
  marketDate,
  ledgerItems,
  snapshotItems,
  eventItems,
  manifestItems,
}) {
  const unknownItems = [
    ...ledgerItems.filter(isArtifactLedgerItem).map((item) => ({ item, kind: 'artifact' })),
    ...snapshotItems.map((item) => ({ item, kind: 'snapshot' })),
    ...eventItems.map((item) => ({ item, kind: 'event' })),
    // A manifest whose artifacts were all recovered under registered products
    // keeps only an audit trail; nothing unsupported remains for that date.
    ...manifestItems.filter((item) => !Array.isArray(item?.artifacts) || item.artifacts.length > 0)
      .map((item) => ({ item, kind: 'manifest' })),
  ].filter(({ item }) => (
    itemMarketDate(item) === marketDate
    && rawProductKey(item)
    && !getResearchProduct(rawProductKey(item))
  ));
  const byKey = new Map();
  unknownItems.forEach((record) => {
    const key = String(rawProductKey(record.item)).trim().toLowerCase();
    const existing = byKey.get(key) || [];
    existing.push(record);
    byKey.set(key, existing);
  });
  return [...byKey.entries()].sort(([left], [right]) => left.localeCompare(right))
    .map(([key, records]) => {
      const items = records.map((record) => record.item);
      const latest = newest(items);
      return {
        id: `unsupported:${key}`,
        label: String(rawProductKey(latest) || key),
        cadence: 'unsupported',
        due: true,
        status: PIPELINE_STATUS.FAILED,
        statusLabel: PIPELINE_STATUS_LABELS[PIPELINE_STATUS.FAILED],
        marketDate,
        observedAt: observedTime(latest),
        publicationDate: itemMarketDate(latest),
        stages: {
          received: true,
          parsed: false,
          validated: false,
          indexed: false,
        },
        counts: {
          artifacts: records.filter((record) => record.kind === 'artifact').length,
          snapshots: records.filter((record) => record.kind === 'snapshot').length,
          events: records.filter((record) => record.kind === 'event').length,
          manifests: records.filter((record) => record.kind === 'manifest').length,
          failures: items.length,
        },
        requiredStages: [...REQUIRED_STAGES],
        errorCode: 'RESEARCH_PRODUCT_UNSUPPORTED',
        detail: `Received product "${rawProductKey(latest)}" is not registered and cannot be parsed or indexed safely.`,
        sourceIds: [...new Set(items.flatMap((item) => [
          item?.s3Key,
          item?.sourceMessageId,
          item?.messageId,
        ]).filter(Boolean).map(String))],
        evidenceHash: coverageHash({ key, marketDate, count: items.length }),
      };
    });
}

function summarizeRows(products) {
  return products.reduce((summary, product) => {
    summary.total += 1;
    summary[product.status] += 1;
    if (product.due) summary.due += 1;
    if (product.due && product.status !== PIPELINE_STATUS.INDEXED) summary.incompleteDue += 1;
    return summary;
  }, {
    total: 0,
    due: 0,
    incompleteDue: 0,
    not_due: 0,
    missing: 0,
    received: 0,
    parsed: 0,
    validated: 0,
    indexed: 0,
    failed: 0,
  });
}

function buildResearchPipelineCoverage({
  now = new Date(),
  marketDate = null,
  products = RESEARCH_PRODUCTS,
  ledgerItems = [],
  snapshotItems = [],
  eventItems = [],
  manifestItems = [],
  riskRange = null,
  collectionErrors = [],
} = {}) {
  const effectiveMarketDate = marketDate || latestResearchMarketDate(now);
  const normalizedErrors = collectionErrors.filter(Boolean).map(String);
  const configuredRows = products.map((product) => evidenceForProduct({
    product,
    marketDate: effectiveMarketDate,
    now,
    ledgerItems,
    snapshotItems,
    eventItems,
    manifestItems,
    riskRange,
    collectionErrors: normalizedErrors,
  }));
  const unknownRows = normalizedErrors.length === 0
    ? unknownProductRows({
      marketDate: effectiveMarketDate,
      ledgerItems,
      snapshotItems,
      eventItems,
      manifestItems,
    })
    : [];
  const rows = [...configuredRows, ...unknownRows];
  const summary = summarizeRows(rows);
  const explicitFailures = rows.some((product) => (
    product.status === PIPELINE_STATUS.FAILED
    || product.status === PIPELINE_STATUS.MISSING
  ));
  const incomplete = rows.some((product) => (
    product.status === PIPELINE_STATUS.RECEIVED
    || product.status === PIPELINE_STATUS.PARSED
    || product.status === PIPELINE_STATUS.VALIDATED
  ));
  const status = explicitFailures || normalizedErrors.length > 0
    ? 'failed'
    : (incomplete ? 'degraded' : 'complete');

  return {
    schemaVersion: 1,
    marketDate: effectiveMarketDate,
    generatedAt: (now instanceof Date ? now : new Date(now)).toISOString(),
    status,
    summary,
    products: rows,
    collectionErrors: normalizedErrors,
  };
}

async function scanAllPages(dynamodb, params) {
  if (!dynamodb || typeof dynamodb.scan !== 'function') {
    throw new Error('DynamoDB scan access is not configured.');
  }
  const items = [];
  let ExclusiveStartKey;
  do {
    const result = await dynamodb.scan({
      ...params,
      ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}),
    }).promise();
    items.push(...(Array.isArray(result?.Items) ? result.Items : []));
    ExclusiveStartKey = result?.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

async function queryEntityEventsForDate(dynamodb, tableName, marketDate) {
  if (!dynamodb || typeof dynamodb.query !== 'function') {
    throw new Error('DynamoDB entity-event query access is not configured.');
  }
  const items = [];
  let ExclusiveStartKey;
  do {
    const result = await dynamodb.query({
      TableName: tableName,
      IndexName: 'marketDate-index',
      KeyConditionExpression: '#marketDate = :marketDate',
      ExpressionAttributeNames: { '#marketDate': 'marketDate' },
      ExpressionAttributeValues: { ':marketDate': marketDate },
      ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}),
    }).promise();
    items.push(...(Array.isArray(result?.Items) ? result.Items : []));
    ExclusiveStartKey = result?.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

async function querySnapshotsForDate(dynamodb, tableName, marketDate) {
  if (!dynamodb || typeof dynamodb.query !== 'function') {
    throw new Error('DynamoDB snapshot query access is not configured.');
  }
  const items = [];
  let ExclusiveStartKey;
  do {
    const result = await dynamodb.query({
      TableName: tableName,
      KeyConditionExpression: '#date = :marketDate',
      ExpressionAttributeNames: { '#date': 'date' },
      ExpressionAttributeValues: { ':marketDate': marketDate },
      ConsistentRead: true,
      ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}),
    }).promise();
    items.push(...(Array.isArray(result?.Items) ? result.Items : []));
    ExclusiveStartKey = result?.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

async function queryProductManifestsForDate(dynamodb, tableName, marketDate) {
  if (!dynamodb || typeof dynamodb.query !== 'function') {
    throw new Error('DynamoDB product-manifest query access is not configured.');
  }
  const items = [];
  let ExclusiveStartKey;
  do {
    const result = await dynamodb.query({
      TableName: tableName,
      KeyConditionExpression: '#marketDate = :marketDate',
      ExpressionAttributeNames: { '#marketDate': 'marketDate' },
      ExpressionAttributeValues: { ':marketDate': marketDate },
      ConsistentRead: true,
      ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}),
    }).promise();
    items.push(...(Array.isArray(result?.Items) ? result.Items : []));
    ExclusiveStartKey = result?.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

function collectionError(label, result) {
  if (result.status === 'fulfilled') return null;
  const error = result.reason;
  const code = error?.code || error?.name || 'QUERY_FAILED';
  return `${label} (${code}): ${error?.message || String(error)}`;
}

async function collectResearchPipelineCoverage({
  dynamodb,
  now = new Date(),
  marketDate = null,
  riskRange = null,
  tables = {},
} = {}) {
  const effectiveMarketDate = marketDate || latestResearchMarketDate(now);
  const tableNames = {
    ledger: tables.ledger || 'HermesEmailIngestLedger',
    snapshots: tables.snapshots || 'HedgeyeDailySnapshot',
    events: tables.events || 'ResearchEntityEventsV1',
    manifests: tables.manifests || 'ResearchProductManifestsV1',
  };
  // The Gmail ledger is keyed by message ID and has no market-date index. A
  // table scan would be unbounded and would broaden the local API IAM policy.
  // Daily product manifests retain source artifact IDs and stage evidence, so
  // readiness uses those plus date-keyed snapshots/events instead.
  const [snapshotResult, eventResult, manifestResult] = await Promise.allSettled([
    querySnapshotsForDate(dynamodb, tableNames.snapshots, effectiveMarketDate),
    queryEntityEventsForDate(dynamodb, tableNames.events, effectiveMarketDate),
    queryProductManifestsForDate(dynamodb, tableNames.manifests, effectiveMarketDate),
  ]);
  const errors = [
    collectionError(tableNames.snapshots, snapshotResult),
    collectionError(tableNames.events, eventResult),
    collectionError(tableNames.manifests, manifestResult),
  ].filter(Boolean);

  return buildResearchPipelineCoverage({
    now,
    marketDate: effectiveMarketDate,
    ledgerItems: [],
    snapshotItems: snapshotResult.status === 'fulfilled' ? snapshotResult.value : [],
    eventItems: eventResult.status === 'fulfilled' ? eventResult.value : [],
    manifestItems: manifestResult.status === 'fulfilled' ? manifestResult.value : [],
    riskRange,
    collectionErrors: errors,
  });
}

module.exports = {
  PIPELINE_STATUS,
  PIPELINE_STATUS_LABELS,
  buildResearchPipelineCoverage,
  collectResearchPipelineCoverage,
  itemMarketDate,
  scanAllPages,
};
