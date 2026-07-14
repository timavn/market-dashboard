const fs = require('fs');
const path = require('path');

const TABLE = process.env.FINANCIAL_PREDICTION_EVENTS_TABLE || 'FinancialPredictionEvents';
const META_ID = 'INGEST_META#global';
const LOCAL_CACHE_PATH = path.join(__dirname, 'mock', '.local-ingest-cache.json');

const memoryCache = new Map();
let dynamodb;

function getDynamo() {
  if (!dynamodb) {
    const DynamoDB = require('aws-sdk/clients/dynamodb');
    dynamodb = new DynamoDB.DocumentClient({
      region: process.env.AWS_REGION || 'us-west-1',
    });
  }
  return dynamodb;
}

function cacheKey(provider) {
  return `pm_ingest_${provider}`;
}

function getMemory(key) {
  const entry = memoryCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt && Date.now() > entry.expiresAt) return null;
  return entry.data;
}

function setMemory(key, data, ttlSec) {
  memoryCache.set(key, {
    data,
    expiresAt: ttlSec ? Date.now() + ttlSec * 1000 : null,
  });
}

async function loadEventsFromDynamo() {
  try {
    const result = await getDynamo()
      .scan({
        TableName: TABLE,
        FilterExpression: 'attribute_exists(#payload) AND NOT begins_with(eventId, :meta)',
        ExpressionAttributeNames: { '#payload': 'payload' },
        ExpressionAttributeValues: { ':meta': 'INGEST_META' },
      })
      .promise();
    return (result.Items || []).map((item) => item.payload);
  } catch (err) {
    console.warn('[PM Ingest] DynamoDB load failed:', err.message);
    return null;
  }
}

async function saveEventsToDynamo(events) {
  const db = getDynamo();
  const now = new Date().toISOString();
  const batchSize = 25;

  for (let i = 0; i < events.length; i += batchSize) {
    const chunk = events.slice(i, i + batchSize);
    const requests = chunk.map((event) => ({
      PutRequest: {
        Item: {
          eventId: `${event.venue}#${event.api_raw_id}`,
          updatedAt: event.updated_at || now,
          venue: event.venue,
          status: event.status,
          comparisonGroupId: event.comparison_group_id,
          event_date: event.event_date,
          payload: event,
        },
      },
    }));
    await db
      .batchWrite({ RequestItems: { [TABLE]: requests } })
      .promise();
  }

  await db
    .put({
      TableName: TABLE,
      Item: {
        eventId: META_ID,
        updatedAt: now,
        payload: { lastIngestAt: now, eventCount: events.length },
      },
    })
    .promise();
}

function loadLocalFileCache() {
  try {
    if (fs.existsSync(LOCAL_CACHE_PATH)) {
      return JSON.parse(fs.readFileSync(LOCAL_CACHE_PATH, 'utf8'));
    }
  } catch (err) {
    console.warn('[PM Ingest] local cache read failed:', err.message);
  }
  return null;
}

function saveLocalFileCache(data) {
  try {
    const dir = path.dirname(LOCAL_CACHE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(LOCAL_CACHE_PATH, JSON.stringify(data, null, 2));
  } catch (err) {
    console.warn('[PM Ingest] local cache write failed:', err.message);
  }
}

async function getCachedEvents() {
  const mem = getMemory('aggregated_events');
  if (mem) return mem;

  const dynamo = await loadEventsFromDynamo();
  if (dynamo && dynamo.length) {
    setMemory('aggregated_events', dynamo, Number(process.env.PM_EVENTS_CACHE_TTL_SEC) || 300);
    return dynamo;
  }

  const local = loadLocalFileCache();
  if (local?.events) return local.events;

  return null;
}

async function setCachedEvents(events, meta = {}) {
  setMemory('aggregated_events', events, Number(process.env.PM_EVENTS_CACHE_TTL_SEC) || 300);
  saveLocalFileCache({ events, meta, savedAt: new Date().toISOString() });

  if (process.env.AWS_ACCESS_KEY_ID || process.env.AWS_PROFILE) {
    try {
      await saveEventsToDynamo(events);
    } catch (err) {
      console.error('[PM Ingest] DynamoDB save failed:', err.message);
    }
  }
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

function getIbkrStaleEvents() {
  const stale = getMemory('ibkr_events_stale') || loadLocalFileCache()?.ibkrEvents;
  return stale || [];
}

function setIbkrStaleEvents(events) {
  setMemory('ibkr_events_stale', events, Number(process.env.PM_IBKR_STALE_TTL_SEC) || 900);
  const local = loadLocalFileCache() || {};
  local.ibkrEvents = events;
  local.ibkrSavedAt = new Date().toISOString();
  saveLocalFileCache(local);
}

module.exports = {
  getCachedEvents,
  setCachedEvents,
  getProviderStatus,
  setProviderStatus,
  getIbkrStaleEvents,
  setIbkrStaleEvents,
  setMemory,
  getMemory,
  cacheKey,
  loadEventsFromDynamo,
  saveEventsToDynamo,
};
