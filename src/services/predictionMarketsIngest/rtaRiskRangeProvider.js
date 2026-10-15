const crypto = require('crypto');
const { DynamoDB } = require('../aws/clients.cjs');
const { S3 } = require('../aws/clients.cjs');
const { createAsyncTtlCache } = require('../../utils/serverResponseCache.cjs');
const { scanAllPages } = require('../../utils/dynamoScanAllPages.cjs');
const { HEDGEYE_BUCKET } = require('../../utils/hedgeyeMedia.cjs');
const {
  isExplicitRealTimeAlertItem,
  stripHtmlToText,
} = require('../../utils/rtaLedgerMaterialization.cjs');
const { materializeRtaResearchEvents } = require('../../utils/researchEventLedger.cjs');
const {
  DEFAULT_MAX_AGE_MS,
  dateKeyInNewYork,
  parseSpxRefreshedRiskRange,
  selectCurrentSpxRefreshedRiskRange,
} = require('../../utils/spxRefreshedRiskRange.cjs');

const RESEARCH_EVENT_LEDGER_TABLE = process.env.RESEARCH_EVENT_LEDGER_TABLE || 'ResearchEventLedgerV2';
const HERMES_EMAIL_LEDGER_TABLE = process.env.HERMES_LEDGER_TABLE || 'HermesEmailIngestLedger';
const RTA_CACHE_TTL_MS = Number(process.env.PM_RTA_RANGE_CACHE_TTL_MS || 60 * 1000);
const RTA_MAX_AGE_MS = Number(process.env.PM_RTA_RANGE_MAX_AGE_MS || DEFAULT_MAX_AGE_MS);

const AWS_REGION = process.env.AWS_REGION || 'us-west-1';
const defaultDynamodb = new DynamoDB.DocumentClient({ region: AWS_REGION });
const defaultS3 = new S3({ region: AWS_REGION });
const cache = createAsyncTtlCache({
  ttlMs: Number.isFinite(RTA_CACHE_TTL_MS) && RTA_CACHE_TTL_MS > 0 ? RTA_CACHE_TTL_MS : 60 * 1000,
  maxEntries: 1,
});
const artifactCache = createAsyncTtlCache({
  ttlMs: 24 * 60 * 60 * 1000,
  maxEntries: 100,
});

function itemTime(item = {}) {
  return item.eventTime || item.receivedAt || item.createdAt || item.updatedAt || null;
}

function isRtaArtifactCandidate(item = {}) {
  const subject = String(item.subject || '');
  if (!/real[- ]time alert/i.test(subject) || !item.s3Key) return false;
  if (item.status === 'STORED') return true;
  // The current refreshed-SPX message was saved immutably but its old report
  // classifier sent it through the Risk Range parser, which failed before the
  // RTA projection was written. Its content hash and S3 artifact still provide
  // a verifiable source for this narrow recovery path.
  return item.status === 'ERROR' && /^[a-f0-9]{64}$/i.test(String(item.contentSha256 || ''));
}

function getArtifactVersion(item = {}) {
  return item.dataVersion || item.contentHash || item.s3VersionId || item.versionId ||
    item.etag || item.updatedAt || item.createdAt || item.receivedAt || 'unversioned';
}

async function queryResearchEventItems(dynamodb = defaultDynamodb) {
  const items = [];
  let exclusiveStartKey;
  do {
    const result = await dynamodb.query({
      TableName: RESEARCH_EVENT_LEDGER_TABLE,
      KeyConditionExpression: '#productKey = :productKey',
      ExpressionAttributeNames: { '#productKey': 'productKey' },
      ExpressionAttributeValues: { ':productKey': 'real-time-alert' },
      ScanIndexForward: true,
      ConsistentRead: true,
      ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
    }).promise();
    items.push(...(result.Items || []));
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return items;
}

async function scanHermesLedgerItems(dynamodb = defaultDynamodb) {
  return scanAllPages(dynamodb, { TableName: HERMES_EMAIL_LEDGER_TABLE });
}

async function getArtifactText(item, s3 = defaultS3) {
  if (!item?.s3Key) return '';
  const bucket = item.s3Bucket || HEDGEYE_BUCKET;
  const version = getArtifactVersion(item);
  const cacheKey = JSON.stringify([bucket, item.s3Key, version]);
  const result = await artifactCache.get(cacheKey, async () => {
    const params = { Bucket: bucket, Key: item.s3Key };
    if (item.s3VersionId) params.VersionId = item.s3VersionId;
    const response = await s3.getObject(params).promise();
    return response.Body?.toString('utf8') || '';
  });
  if (result.status === 'stale') {
    throw result.error || new Error('The stored RTA artifact cache is stale.');
  }
  return result.value || '';
}

function candidateFromAlert(alert = {}, source = 'research-event-ledger-v2') {
  const range = parseSpxRefreshedRiskRange({
    payload: alert,
    refreshedRiskRange: alert.refreshedRiskRange,
    headline: alert.headline,
    signalPhrase: alert.signalPhrase,
  });
  if (!range) return null;
  return {
    ...range,
    eventTime: alert.eventTime || null,
    asOf: alert.eventTime || null,
    source,
    sourceMessageId: alert.sourceMessageId || null,
    sourceEventKey: alert.sourceEventKey || null,
    subject: alert.headline || null,
  };
}

async function candidatesFromCanonicalEvents(items = []) {
  const materialized = materializeRtaResearchEvents(items);
  return materialized.snapshots.flatMap((snapshot) => (
    (snapshot.data?.alerts || [])
      .map((alert) => candidateFromAlert(alert, 'research-event-ledger-v2'))
      .filter(Boolean)
  ));
}

async function candidatesFromHermesItems(items = [], {
  getArtifactText: readArtifact = getArtifactText,
  now = Date.now(),
} = {}) {
  const candidates = [];
  const today = dateKeyInNewYork(now);
  for (const item of (Array.isArray(items) ? items : []).filter((candidate) => (
    isExplicitRealTimeAlertItem(candidate) || isRtaArtifactCandidate(candidate)
  ))) {
    const receivedAt = itemTime(item);
    if (today && dateKeyInNewYork(receivedAt) !== today) continue;
    // The body is only needed for current-day alerts. This keeps the periodic
    // overview refresh from downloading the full historical RTA archive.
    let body = '';
    try {
      body = await readArtifact(item);
    } catch {
      continue;
    }
    const expectedHash = String(item.contentSha256 || '').trim().toLowerCase();
    if (item.status === 'ERROR' && expectedHash) {
      const actualHash = crypto.createHash('sha256').update(body, 'utf8').digest('hex');
      if (actualHash !== expectedHash) continue;
    }
    const text = stripHtmlToText(body);
    const range = parseSpxRefreshedRiskRange({
      subject: item.subject,
      text,
      html: body,
    });
    if (!range) continue;
    candidates.push({
      ...range,
      eventTime: receivedAt,
      asOf: receivedAt,
      source: 'hermes-email-ledger-s3',
      sourceMessageId: item.messageId || item.gmailMessageId || null,
      subject: item.subject || null,
    });
  }
  return candidates;
}

function unavailable(reason, extra = {}) {
  return {
    status: 'unavailable',
    source: 'Hedgeye Real-Time Alert',
    reason,
    ...extra,
  };
}

async function loadLatestSpxRtaRiskRange({
  now = Date.now(),
  getResearchEventItems = null,
  getHermesLedgerItems = null,
  getArtifactText: readArtifact = null,
  dynamodb = defaultDynamodb,
  s3 = defaultS3,
  maxAgeMs = RTA_MAX_AGE_MS,
} = {}) {
  const canonicalLoader = getResearchEventItems || (() => queryResearchEventItems(dynamodb));
  const legacyLoader = getHermesLedgerItems || (() => scanHermesLedgerItems(dynamodb));
  const artifactLoader = readArtifact || ((item) => getArtifactText(item, s3));
  const [canonicalResult, legacyResult] = await Promise.allSettled([
    canonicalLoader(),
    legacyLoader(),
  ]);

  const candidates = [];
  const errors = [];
  if (canonicalResult.status === 'fulfilled') {
    candidates.push(...await candidatesFromCanonicalEvents(canonicalResult.value));
  } else {
    errors.push(`ResearchEventLedgerV2: ${canonicalResult.reason?.message || canonicalResult.reason || 'unavailable'}`);
  }
  if (legacyResult.status === 'fulfilled') {
    candidates.push(...await candidatesFromHermesItems(legacyResult.value, {
      getArtifactText: artifactLoader,
      now,
    }));
  } else {
    errors.push(`HermesEmailIngestLedger: ${legacyResult.reason?.message || legacyResult.reason || 'unavailable'}`);
  }

  const selected = selectCurrentSpxRefreshedRiskRange(candidates, { now, maxAgeMs });
  if (!selected) {
    const detail = errors.length > 0 ? ` ${errors.join(' ')}` : '';
    return unavailable(
      `No verified current-day SPX refreshed Risk Range was found in the Real-Time Alert feed.${detail}`,
      {
        checkedAt: new Date(now).toISOString(),
        candidateCount: candidates.length,
      },
    );
  }
  return {
    status: 'available',
    kind: 'underlying',
    label: 'SPX refreshed Risk Range',
    source: 'Hedgeye Real-Time Alert',
    sourceKind: selected.source,
    low: selected.low,
    high: selected.high,
    asOf: selected.asOf,
    sourceMessageId: selected.sourceMessageId || null,
    subject: selected.subject || null,
    candidateCount: candidates.length,
    checkedAt: new Date(now).toISOString(),
  };
}

async function getLatestSpxRtaRiskRange(options = {}) {
  const hasCustomLoader = Boolean(
    options.getResearchEventItems ||
    options.getHermesLedgerItems ||
    options.getArtifactText ||
    options.dynamodb ||
    options.s3,
  );
  if (hasCustomLoader) return loadLatestSpxRtaRiskRange(options);

  const now = options.now || Date.now();
  const cached = await cache.get('latest-spx', () => loadLatestSpxRtaRiskRange(options));
  if (cached.status === 'stale') {
    return unavailable('Verified Real-Time Alert range refresh is unavailable.', {
      checkedAt: new Date(now).toISOString(),
      reasonCode: 'rta-range-cache-stale',
    });
  }
  return cached.value;
}

module.exports = {
  candidatesFromCanonicalEvents,
  candidatesFromHermesItems,
  getArtifactText,
  getLatestSpxRtaRiskRange,
  loadLatestSpxRtaRiskRange,
  queryResearchEventItems,
  scanHermesLedgerItems,
};
