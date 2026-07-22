const { releaseKeyForEvent } = require('./cpiRelease');
const { getCatalogStorageConfig } = require('./catalogSchema');

const { tableName: TABLE } = getCatalogStorageConfig();
const META_CONTRACT_KEY = '__META__';
const CONTROL_RELEASE_KEY = '__CONTROL__';
const CURRENT_CPI_CONTRACT_KEY = 'CPI#CURRENT';
let dynamodb;

// Catalog persistence is deliberately contract metadata only. Live books,
// trades, implied probabilities, model outputs, volume, freshness, and data
// quality belong to the in-memory provider response and must never be revived
// from DynamoDB as if they were live.
const CONTRACT_METADATA_FIELDS = Object.freeze([
  'api_raw_id',
  'api_raw_symbol',
  'category',
  'catalog_source',
  'catalog_validated_at',
  'close_time',
  'comparison_group_id',
  'conid',
  'conId',
  'contract_title',
  'currency',
  'description',
  'event_date',
  'event_ticker',
  'event_title',
  'exchange',
  'expiration_time',
  'lastTradeDateOrContractMonth',
  'localSymbol',
  'max_payout_per_contract',
  'multiplier',
  'native_side',
  'question',
  'quote_side',
  'releaseCode',
  'reportMonthId',
  'right',
  'secType',
  'series',
  'settlement_source',
  'settlement_terms',
  'strike',
  'symbol',
  'tradable_in_ibkr',
  'tradingClass',
  'underlying',
  'venue',
]);

function getDynamo() {
  if (!dynamodb) {
    const DynamoDB = require('aws-sdk/clients/dynamodb');
    dynamodb = new DynamoDB.DocumentClient({
      region: process.env.AWS_REGION || 'us-west-1',
    });
  }
  return dynamodb;
}

function contractMetadata(event = {}, releaseKey) {
  const metadata = { releaseKey };
  for (const field of CONTRACT_METADATA_FIELDS) {
    if (
      event[field] !== undefined
      && event[field] !== null
      && (typeof event[field] !== 'number' || Number.isFinite(event[field]))
    ) {
      metadata[field] = event[field];
    }
  }
  return metadata;
}

function eventCatalogItem(event, now = new Date().toISOString()) {
  const releaseKey = releaseKeyForEvent(event);
  const venue = String(event?.venue || '').trim();
  const nativeId = String(event?.api_raw_id || event?.conid || event?.conId || '').trim();
  if (!releaseKey || !venue || !nativeId) {
    throw new Error('Prediction catalog items require releaseKey, venue, and a native contract ID.');
  }
  return {
    releaseKey,
    contractKey: `${venue}#${nativeId}`,
    updatedAt: now,
    itemType: 'contract',
    venue,
    ...(event.comparison_group_id != null
      ? { comparisonGroupId: event.comparison_group_id }
      : {}),
    ...(event.event_date != null ? { event_date: event.event_date } : {}),
    metadata: contractMetadata(event, releaseKey),
  };
}

async function loadCatalogMetadataByRelease(releaseKey) {
  if (!releaseKey) return null;
  const items = [];
  let exclusiveStartKey;
  do {
    const result = await getDynamo().query({
      TableName: TABLE,
      KeyConditionExpression: '#releaseKey = :releaseKey',
      ExpressionAttributeNames: { '#releaseKey': 'releaseKey' },
      ExpressionAttributeValues: { ':releaseKey': releaseKey },
      ConsistentRead: true,
      ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
    }).promise();
    items.push(...(result.Items || []));
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return items
    .filter((item) => item.contractKey !== META_CONTRACT_KEY && item.itemType !== 'meta')
    .map((item) => item.metadata)
    .filter(Boolean);
}

function venueFromCatalogKey(item = {}) {
  if (item.venue) return String(item.venue);
  const separator = String(item.contractKey || '').indexOf('#');
  return separator > 0 ? String(item.contractKey).slice(0, separator) : null;
}

async function loadCurrentCpiCatalogPointer(db = getDynamo()) {
  const result = await db.query({
    TableName: TABLE,
    KeyConditionExpression: '#releaseKey = :releaseKey',
    ExpressionAttributeNames: { '#releaseKey': 'releaseKey' },
    ExpressionAttributeValues: { ':releaseKey': CONTROL_RELEASE_KEY },
    ConsistentRead: true,
  }).promise();
  return (result.Items || []).find((item) => item.contractKey === CURRENT_CPI_CONTRACT_KEY) || null;
}

async function loadOperationalCatalogByRelease(releaseKey, {
  venues = null,
  requireCurrent = true,
} = {}) {
  if (!releaseKey) {
    const error = new Error('An exact releaseKey is required to load the operational prediction catalog.');
    error.code = 'CATALOG_RELEASE_REQUIRED';
    throw error;
  }
  const db = getDynamo();
  const [items, pointer] = await Promise.all([
    loadReleaseCatalogKeys(db, releaseKey),
    requireCurrent ? loadCurrentCpiCatalogPointer(db) : Promise.resolve(null),
  ]);
  const meta = items.find((item) => item.contractKey === META_CONTRACT_KEY);
  if (
    !meta
    || meta.itemType !== 'meta'
    || meta.metadata?.schemaVersion !== 2
    || meta.metadata?.atomicReplacement !== true
    || meta.metadata?.promotionState !== 'active'
  ) {
    const error = new Error(`Release ${releaseKey} has not been atomically promoted in ${TABLE}.`);
    error.code = 'CATALOG_NOT_PROMOTED';
    throw error;
  }
  if (requireCurrent && pointer?.metadata?.currentReleaseKey !== releaseKey) {
    const error = new Error(`Release ${releaseKey} is not the active CPI catalog generation.`);
    error.code = 'CATALOG_RELEASE_NOT_CURRENT';
    throw error;
  }
  const allowedVenues = venues?.length
    ? new Set(venues.map((venue) => String(venue).toUpperCase()))
    : null;
  return items
    .filter((item) => item.contractKey !== META_CONTRACT_KEY && item.itemType !== 'meta')
    .filter((item) => !allowedVenues || allowedVenues.has(String(venueFromCatalogKey(item) || '').toUpperCase()))
    .map((item) => item.metadata)
    .filter(Boolean);
}

async function loadReleaseCatalogKeys(db, releaseKey) {
  const keys = [];
  let exclusiveStartKey;
  do {
    const result = await db.query({
      TableName: TABLE,
      KeyConditionExpression: '#releaseKey = :releaseKey',
      ExpressionAttributeNames: { '#releaseKey': 'releaseKey' },
      ExpressionAttributeValues: { ':releaseKey': releaseKey },
      ProjectionExpression: 'releaseKey, contractKey, updatedAt, itemType, venue, metadata',
      ConsistentRead: true,
      ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
    }).promise();
    keys.push(...(result.Items || []));
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return keys;
}

async function saveEventsToDynamo(events, meta = {}) {
  const db = getDynamo();
  const now = new Date().toISOString();
  const releaseEvents = (events || []).filter((event) => releaseKeyForEvent(event));
  const itemsByRelease = new Map();
  for (const event of releaseEvents) {
    const item = eventCatalogItem(event, now);
    if (!itemsByRelease.has(item.releaseKey)) itemsByRelease.set(item.releaseKey, new Map());
    itemsByRelease.get(item.releaseKey).set(item.contractKey, item);
  }
  if (itemsByRelease.size === 0) return { releases: [], contracts: 0, retired: 0 };

  if (meta.releaseKey && [...itemsByRelease.keys()].some((key) => key !== meta.releaseKey)) {
    const error = new Error('Catalog promotion contained a contract from the wrong release.');
    error.code = 'CATALOG_RELEASE_MISMATCH';
    throw error;
  }
  if (meta.promoteCurrent === true && itemsByRelease.size !== 1) {
    const error = new Error('Current CPI catalog promotion must contain exactly one release.');
    error.code = 'CATALOG_PROMOTION_AMBIGUOUS';
    throw error;
  }

  const transactItems = [];
  let retired = 0;
  let activeContracts = 0;
  for (const [releaseKey, itemMap] of itemsByRelease) {
    const existingKeys = await loadReleaseCatalogKeys(db, releaseKey);
    const existingMeta = existingKeys.find((key) => key.contractKey === META_CONTRACT_KEY);
    const desiredKeys = new Set(itemMap.keys());
    const requestedVenues = meta.venues?.length
      ? new Set(meta.venues.map((venue) => String(venue).toUpperCase()))
      : new Set([...itemMap.values()].map((item) => String(item.venue).toUpperCase()));
    const replaceVenues = meta.replaceVenues === true;
    if (requestedVenues.size === 0) {
      const error = new Error('A successful catalog replacement must name at least one venue.');
      error.code = 'CATALOG_VENUE_REQUIRED';
      throw error;
    }
    for (const item of itemMap.values()) {
      if (!requestedVenues.has(String(item.venue).toUpperCase())) {
        const error = new Error(`Catalog contract ${item.contractKey} is outside the replacement venue scope.`);
        error.code = 'CATALOG_VENUE_SCOPE_MISMATCH';
        throw error;
      }
    }
    for (const item of itemMap.values()) {
      transactItems.push({ Put: { TableName: TABLE, Item: item } });
    }
    for (const key of existingKeys) {
      const keyVenue = String(venueFromCatalogKey(key) || '').toUpperCase();
      if (
        !replaceVenues
        ||
        key.contractKey === META_CONTRACT_KEY
        || desiredKeys.has(key.contractKey)
        || !requestedVenues.has(keyVenue)
      ) continue;
      transactItems.push({
        Delete: {
          TableName: TABLE,
          Key: { releaseKey, contractKey: key.contractKey },
        },
      });
      retired += 1;
    }
    const retainedKeys = existingKeys.filter((key) => (
      key.contractKey !== META_CONTRACT_KEY
      && (
        !replaceVenues
        || !requestedVenues.has(String(venueFromCatalogKey(key) || '').toUpperCase())
      )
    ));
    const activeKeys = new Set([
      ...retainedKeys.map((key) => key.contractKey),
      ...itemMap.keys(),
    ]);
    activeContracts += activeKeys.size;
    transactItems.push({
      Put: {
        TableName: TABLE,
        Item: {
          releaseKey,
          contractKey: META_CONTRACT_KEY,
          updatedAt: now,
          itemType: 'meta',
          metadata: {
            lastIngestAt: now,
            eventCount: activeKeys.size,
            retiredCount: existingKeys.filter((key) => (
              replaceVenues
              &&
              key.contractKey !== META_CONTRACT_KEY
              && requestedVenues.has(String(venueFromCatalogKey(key) || '').toUpperCase())
              && !desiredKeys.has(key.contractKey)
            )).length,
            releaseKey,
            schemaVersion: 2,
            atomicReplacement: true,
            promotionState: 'active',
            replacementMode: replaceVenues ? 'venue_snapshot' : 'upsert_only',
            ...(replaceVenues
              ? { replacedVenues: [...requestedVenues].sort() }
              : { upsertedVenues: [...requestedVenues].sort() }),
            ...(meta.source ? { source: meta.source } : {}),
          },
        },
        ConditionExpression: existingMeta?.updatedAt
          ? '#updatedAt = :previousUpdatedAt'
          : 'attribute_not_exists(#updatedAt)',
        ExpressionAttributeNames: { '#updatedAt': 'updatedAt' },
        ...(existingMeta?.updatedAt
          ? { ExpressionAttributeValues: { ':previousUpdatedAt': existingMeta.updatedAt } }
          : {}),
      },
    });
  }

  if (meta.promoteCurrent === true) {
    const currentReleaseKey = [...itemsByRelease.keys()][0];
    const existingPointer = await loadCurrentCpiCatalogPointer(db);
    transactItems.push({
      Put: {
        TableName: TABLE,
        Item: {
          releaseKey: CONTROL_RELEASE_KEY,
          contractKey: CURRENT_CPI_CONTRACT_KEY,
          updatedAt: now,
          itemType: 'control',
          metadata: {
            schemaVersion: 2,
            currentReleaseKey,
            promotedAt: now,
            promotionState: 'active',
            ...(meta.source ? { source: meta.source } : {}),
          },
        },
        ConditionExpression: existingPointer?.updatedAt
          ? '#updatedAt = :previousUpdatedAt'
          : 'attribute_not_exists(#updatedAt)',
        ExpressionAttributeNames: { '#updatedAt': 'updatedAt' },
        ...(existingPointer?.updatedAt
          ? { ExpressionAttributeValues: { ':previousUpdatedAt': existingPointer.updatedAt } }
          : {}),
      },
    });
  }

  if (transactItems.length > 100) {
    const error = new Error(`Atomic catalog replacement requires ${transactItems.length} operations; DynamoDB supports at most 100.`);
    error.code = 'CATALOG_ATOMIC_WRITE_LIMIT';
    throw error;
  }

  await db.transactWrite({
    TransactItems: transactItems,
    ClientRequestToken: `pm-catalog-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
  }).promise();

  return {
    releases: [...itemsByRelease.keys()],
    contracts: [...itemsByRelease.values()].reduce((sum, itemMap) => sum + itemMap.size, 0),
    activeContracts,
    retired,
    atomic: true,
    promotedCurrent: meta.promoteCurrent === true,
  };
}

async function persistCatalogEvents(events, meta = {}) {
  return saveEventsToDynamo(events, meta);
}

const providerStatusMemory = {
  kalshi: { status: 'unknown', last_success_at: null, message: null },
  ibkr: { status: 'unknown', last_success_at: null, message: null },
  forecastex: { status: 'unknown', last_success_at: null, message: null },
  cme: { status: 'unknown', last_success_at: null, message: null },
  reference: { status: 'unknown', last_success_at: null, message: null },
};

function getProviderStatus() {
  return { ...providerStatusMemory };
}

function setProviderStatus(provider, update) {
  providerStatusMemory[provider] = {
    ...providerStatusMemory[provider],
    ...update,
  };
}

module.exports = {
  persistCatalogEvents,
  getProviderStatus,
  setProviderStatus,
  eventCatalogItem,
  loadCatalogMetadataByRelease,
  loadOperationalCatalogByRelease,
  loadCurrentCpiCatalogPointer,
  saveEventsToDynamo,
  contractMetadata,
  CONTROL_RELEASE_KEY,
  CURRENT_CPI_CONTRACT_KEY,
  META_CONTRACT_KEY,
  _setDynamoForTests: (client) => { dynamodb = client; },
};
