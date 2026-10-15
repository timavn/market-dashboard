const crypto = require('crypto');
const {
  normalizeCountryCode,
} = require('../constants/exposureLabGeography.cjs');

const DEFAULT_TABLE_NAME = 'ExposureLabSecurityMasterV1';
const DEFAULT_INDEX_NAME = 'recordType-sortKey-index';
const CURRENT_RECORD_TYPE = 'SECURITY_CURRENT';
const AUDIT_RECORD_TYPE = 'SECURITY_AUDIT';
const IDENTITY_STATUSES = new Set(['unverified', 'verified', 'rejected']);
const GEOGRAPHY_BASES = new Set([
  'country_of_risk',
  'single_country_mandate',
  'holdings_lookthrough',
]);
const INSTRUMENT_TYPES = new Set([
  'STK',
  'ETF',
  'FUND',
  'IND',
  'FUT',
  'FX',
  'CRYPTO',
  'CASH',
  'OTHER',
]);

function reviewError(message, code = 'INVALID_SECURITY_REVIEW', status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function normalizeTicker(value) {
  const ticker = String(value || '').trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9.^=/_-]{0,31}$/.test(ticker)) {
    throw reviewError('Ticker must be a supported canonical security token.');
  }
  return ticker;
}

function normalizeRequiredText(value, field, { min = 2, max = 240 } = {}) {
  const text = String(value || '').trim();
  if (text.length < min || text.length > max) {
    throw reviewError(`${field} must contain ${min}-${max} characters.`);
  }
  return text;
}

function normalizeProviderSymbols(value) {
  if (value == null) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw reviewError('providerSymbols must be an object.');
  }
  return Object.fromEntries(Object.entries(value).map(([provider, symbol]) => {
    const providerKey = String(provider || '').trim().toLowerCase();
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(providerKey)) {
      throw reviewError('Provider keys must be short lowercase identifiers.');
    }
    return [providerKey, normalizeTicker(symbol)];
  }));
}

function normalizeSourceDate(value) {
  const sourceAsOf = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(sourceAsOf)) {
    throw reviewError('geography.sourceAsOf must be a YYYY-MM-DD date.');
  }
  const parsed = new Date(`${sourceAsOf}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== sourceAsOf) {
    throw reviewError('geography.sourceAsOf must be a valid calendar date.');
  }
  return sourceAsOf;
}

function normalizeSourceUrl(value) {
  const sourceUrl = String(value || '').trim();
  if (!sourceUrl) return null;
  if (sourceUrl.length > 500) throw reviewError('geography.sourceUrl must be 500 characters or fewer.');
  let parsed;
  try {
    parsed = new URL(sourceUrl);
  } catch (_error) {
    throw reviewError('geography.sourceUrl must be a valid HTTP(S) URL.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw reviewError('geography.sourceUrl must be a valid HTTP(S) URL.');
  }
  return parsed.toString();
}

function normalizeGeography(value, instrumentType) {
  if (value == null || value === '') return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw reviewError('geography must be an object or null.');
  }
  if (!['STK', 'ETF', 'FUND'].includes(instrumentType)) {
    throw reviewError('Geography reviews are supported only for STK, ETF, and FUND instruments.');
  }

  const basis = String(value.basis || '').trim().toLowerCase();
  if (!GEOGRAPHY_BASES.has(basis)) {
    throw reviewError('geography.basis is not supported.');
  }
  if (instrumentType === 'STK' && basis !== 'country_of_risk') {
    throw reviewError('STK geography must use country_of_risk.');
  }
  if (['ETF', 'FUND'].includes(instrumentType) && basis === 'country_of_risk') {
    throw reviewError('ETF and FUND geography must use single_country_mandate or holdings_lookthrough.');
  }

  if (!Array.isArray(value.allocations) || value.allocations.length === 0) {
    throw reviewError('geography.allocations must contain at least one country weight.');
  }
  if (value.allocations.length > 64) {
    throw reviewError('geography.allocations supports at most 64 country weights.');
  }
  const seen = new Set();
  const allocations = value.allocations.map((allocation) => {
    const countryCode = normalizeCountryCode(allocation?.countryCode);
    const weightPct = Number(allocation?.weightPct);
    if (!countryCode) throw reviewError('Each geography allocation requires a supported ISO alpha-2 countryCode.');
    if (seen.has(countryCode)) throw reviewError(`Duplicate geography allocation for ${countryCode}.`);
    if (!Number.isFinite(weightPct) || weightPct <= 0 || weightPct > 100) {
      throw reviewError('Each geography weightPct must be greater than 0 and no more than 100.');
    }
    seen.add(countryCode);
    return {
      countryCode,
      weightPct: Math.round(weightPct * 10000) / 10000,
    };
  }).sort((left, right) => left.countryCode.localeCompare(right.countryCode));
  const totalWeight = allocations.reduce((sum, allocation) => sum + allocation.weightPct, 0);
  if (Math.abs(totalWeight - 100) > 0.01) {
    throw reviewError('geography allocation weights must total 100%.');
  }
  if (
    ['country_of_risk', 'single_country_mandate'].includes(basis)
    && (allocations.length !== 1 || Math.abs(allocations[0].weightPct - 100) > 0.01)
  ) {
    throw reviewError(`${basis} requires exactly one country at 100%.`);
  }

  return {
    basis,
    allocations,
    sourceName: normalizeRequiredText(value.sourceName, 'geography.sourceName', { min: 2, max: 160 }),
    sourceAsOf: normalizeSourceDate(value.sourceAsOf),
    sourceUrl: normalizeSourceUrl(value.sourceUrl),
  };
}

function publicGeography(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.allocations)) return null;
  return {
    basis: value.basis || null,
    allocations: value.allocations.map((allocation) => ({
      countryCode: allocation.countryCode,
      weightPct: Number(allocation.weightPct),
    })),
    sourceName: value.sourceName || null,
    sourceAsOf: value.sourceAsOf || null,
    sourceUrl: value.sourceUrl || null,
  };
}

function normalizeSecurityReview(ticker, input = {}) {
  const sourceTicker = normalizeTicker(ticker);
  const identityStatus = String(input.identityStatus || 'unverified').trim().toLowerCase();
  if (!IDENTITY_STATUSES.has(identityStatus)) {
    throw reviewError('identityStatus must be unverified, verified, or rejected.');
  }
  const instrumentType = String(input.instrumentType || '').trim().toUpperCase();
  if (identityStatus === 'verified' && !INSTRUMENT_TYPES.has(instrumentType)) {
    throw reviewError('A supported instrumentType is required for verified identity.');
  }
  const canonicalSymbol = input.canonicalSymbol == null || input.canonicalSymbol === ''
    ? null
    : normalizeTicker(input.canonicalSymbol);
  if (identityStatus === 'verified' && !canonicalSymbol) {
    throw reviewError('canonicalSymbol is required for verified identity.');
  }

  let analysisEligible = input.analysisEligible === true;
  let hedgeEligible = input.hedgeEligible === true;
  if (identityStatus !== 'verified') {
    analysisEligible = false;
    hedgeEligible = false;
  }
  if (hedgeEligible && !analysisEligible) {
    throw reviewError('hedgeEligible requires analysisEligible.');
  }

  const expectedVersion = Number(input.expectedVersion ?? 0);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
    throw reviewError('expectedVersion must be a non-negative integer.');
  }

  return {
    ticker: sourceTicker,
    canonicalSymbol: identityStatus === 'verified' ? canonicalSymbol : null,
    displayName: String(input.displayName || '').trim().slice(0, 160) || null,
    identityStatus,
    reviewStatus: identityStatus === 'unverified' ? 'unreviewed' : 'reviewed',
    instrumentType: identityStatus === 'verified' ? instrumentType : null,
    providerSymbols: identityStatus === 'verified'
      ? normalizeProviderSymbols(input.providerSymbols)
      : {},
    geography: identityStatus === 'verified'
      ? normalizeGeography(input.geography, instrumentType)
      : null,
    analysisEligible,
    hedgeEligible,
    reviewedBy: normalizeRequiredText(input.reviewedBy, 'reviewedBy', { min: 2, max: 80 }),
    reviewReason: normalizeRequiredText(input.reviewReason, 'reviewReason', { min: 3, max: 500 }),
    expectedVersion,
  };
}

function publicReview(item) {
  if (!item || typeof item !== 'object') return null;
  return {
    ticker: item.ticker,
    canonicalSymbol: item.canonicalSymbol || null,
    displayName: item.displayName || null,
    identityStatus: item.identityStatus || 'unverified',
    reviewStatus: item.reviewStatus || 'unreviewed',
    instrumentType: item.instrumentType || null,
    providerSymbols: item.providerSymbols || {},
    geography: publicGeography(item.geography),
    analysisEligible: item.analysisEligible === true,
    hedgeEligible: item.hedgeEligible === true,
    reviewedBy: item.reviewedBy || null,
    reviewReason: item.reviewReason || null,
    version: Number.isInteger(Number(item.version)) ? Number(item.version) : 0,
    updatedAt: item.updatedAt || null,
  };
}

function mergeSecurityMasterReviews(universe, reviews = []) {
  const reviewMap = new Map(
    (Array.isArray(reviews) ? reviews : [])
      .map(publicReview)
      .filter(Boolean)
      .map((review) => [review.ticker, review]),
  );
  const rows = (Array.isArray(universe?.rows) ? universe.rows : []).map((row) => {
    const review = reviewMap.get(row.ticker);
    if (!review) return row;
    const reviewedName = review.identityStatus === 'verified' && review.displayName
      ? review.displayName
      : null;
    return {
      ...row,
      ...review,
      ...(reviewedName ? {
        name: reviewedName,
        nameSource: 'Exposure Lab security master',
        nameVerified: true,
      } : {}),
      review,
    };
  });
  return {
    ...universe,
    rows,
    meta: {
      ...(universe?.meta || {}),
      reviewedCount: rows.filter((row) => row.reviewStatus === 'reviewed').length,
      analysisEligibleCount: rows.filter((row) => row.analysisEligible === true).length,
      hedgeEligibleCount: rows.filter((row) => row.hedgeEligible === true).length,
    },
  };
}

function createExposureLabSecurityMaster({
  documentClient,
  tableName = DEFAULT_TABLE_NAME,
  indexName = DEFAULT_INDEX_NAME,
  now = () => new Date().toISOString(),
  eventId = () => crypto.randomUUID(),
} = {}) {
  if (!documentClient) throw new Error('documentClient is required');

  async function listCurrentReviews() {
    const rows = [];
    let exclusiveStartKey;
    do {
      const response = await documentClient.query({
        TableName: tableName,
        IndexName: indexName,
        KeyConditionExpression: '#recordType = :recordType',
        ExpressionAttributeNames: { '#recordType': 'recordType' },
        ExpressionAttributeValues: { ':recordType': CURRENT_RECORD_TYPE },
        ScanIndexForward: true,
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }).promise();
      rows.push(...(response.Items || []));
      exclusiveStartKey = response.LastEvaluatedKey;
    } while (exclusiveStartKey);
    return rows.map(publicReview).filter(Boolean).sort((a, b) => a.ticker.localeCompare(b.ticker));
  }

  async function getCurrentReview(ticker) {
    const normalizedTicker = normalizeTicker(ticker);
    const response = await documentClient.get({
      TableName: tableName,
      Key: { ticker: normalizedTicker, recordKey: 'CURRENT' },
      ConsistentRead: true,
    }).promise();
    return publicReview(response.Item);
  }

  async function listAuditEvents(ticker, { limit = 100 } = {}) {
    const normalizedTicker = normalizeTicker(ticker);
    const response = await documentClient.query({
      TableName: tableName,
      KeyConditionExpression: '#ticker = :ticker AND begins_with(#recordKey, :auditPrefix)',
      ExpressionAttributeNames: {
        '#ticker': 'ticker',
        '#recordKey': 'recordKey',
      },
      ExpressionAttributeValues: {
        ':ticker': normalizedTicker,
        ':auditPrefix': 'AUDIT#',
      },
      ScanIndexForward: false,
      Limit: Math.max(1, Math.min(500, Number(limit) || 100)),
    }).promise();
    return (response.Items || []).map((item) => ({
      eventId: item.eventId || null,
      eventType: item.eventType || null,
      ticker: item.ticker,
      previous: item.previous || null,
      next: item.next || null,
      reviewedBy: item.reviewedBy || null,
      reviewReason: item.reviewReason || null,
      version: Number(item.version) || null,
      updatedAt: item.updatedAt || null,
    }));
  }

  async function writeReview(ticker, input) {
    const review = normalizeSecurityReview(ticker, input);
    const previous = await getCurrentReview(review.ticker);
    const currentVersion = previous?.version || 0;
    if (review.expectedVersion !== currentVersion) {
      throw reviewError(
        `Security review changed from version ${review.expectedVersion} to ${currentVersion}. Reload before saving.`,
        'SECURITY_REVIEW_VERSION_CONFLICT',
        409,
      );
    }
    const timestamp = now();
    const nextVersion = currentVersion + 1;
    const auditId = eventId();
    const currentItem = {
      ticker: review.ticker,
      recordKey: 'CURRENT',
      recordType: CURRENT_RECORD_TYPE,
      sortKey: review.ticker,
      canonicalSymbol: review.canonicalSymbol,
      displayName: review.displayName,
      identityStatus: review.identityStatus,
      reviewStatus: review.reviewStatus,
      instrumentType: review.instrumentType,
      providerSymbols: review.providerSymbols,
      geography: review.geography,
      analysisEligible: review.analysisEligible,
      hedgeEligible: review.hedgeEligible,
      reviewedBy: review.reviewedBy,
      reviewReason: review.reviewReason,
      version: nextVersion,
      updatedAt: timestamp,
    };
    const auditItem = {
      ticker: review.ticker,
      recordKey: `AUDIT#${timestamp}#${auditId}`,
      recordType: AUDIT_RECORD_TYPE,
      sortKey: `${timestamp}#${review.ticker}#${auditId}`,
      eventId: auditId,
      eventType: 'SECURITY_REVIEW_UPDATED',
      previous,
      next: publicReview(currentItem),
      reviewedBy: review.reviewedBy,
      reviewReason: review.reviewReason,
      version: nextVersion,
      updatedAt: timestamp,
    };
    const currentCondition = currentVersion === 0
      ? 'attribute_not_exists(#recordKey)'
      : '#version = :expectedVersion';
    const currentExpressionNames = currentVersion === 0
      ? { '#recordKey': 'recordKey' }
      : { '#version': 'version' };
    const currentExpressionValues = currentVersion === 0
      ? undefined
      : { ':expectedVersion': currentVersion };

    try {
      await documentClient.transactWrite({
        TransactItems: [
          {
            Put: {
              TableName: tableName,
              Item: auditItem,
              ConditionExpression: 'attribute_not_exists(#recordKey)',
              ExpressionAttributeNames: { '#recordKey': 'recordKey' },
            },
          },
          {
            Put: {
              TableName: tableName,
              Item: currentItem,
              ConditionExpression: currentCondition,
              ExpressionAttributeNames: currentExpressionNames,
              ...(currentExpressionValues
                ? { ExpressionAttributeValues: currentExpressionValues }
                : {}),
            },
          },
        ],
      }).promise();
    } catch (error) {
      if (['ConditionalCheckFailedException', 'TransactionCanceledException'].includes(error?.code)) {
        throw reviewError(
          'Security review was modified concurrently. Reload before saving.',
          'SECURITY_REVIEW_VERSION_CONFLICT',
          409,
        );
      }
      throw error;
    }
    return publicReview(currentItem);
  }

  return {
    tableName,
    indexName,
    listCurrentReviews,
    listAuditEvents,
    getCurrentReview,
    writeReview,
  };
}

module.exports = {
  AUDIT_RECORD_TYPE,
  CURRENT_RECORD_TYPE,
  DEFAULT_INDEX_NAME,
  DEFAULT_TABLE_NAME,
  IDENTITY_STATUSES,
  INSTRUMENT_TYPES,
  GEOGRAPHY_BASES,
  createExposureLabSecurityMaster,
  mergeSecurityMasterReviews,
  normalizeGeography,
  normalizeSecurityReview,
  normalizeTicker,
  publicReview,
};
