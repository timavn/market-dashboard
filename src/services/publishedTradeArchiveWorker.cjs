'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const { DynamoDB } = require('./aws/clients.cjs');
const { createPublishedTradeArchive } = require('./publishedTradeArchive.cjs');
const { createPublishedTradeSnapshotReader } = require('./publishedTradeSnapshotReader.cjs');

// Inherit the server's already-sanitized AWS environment/profile. Credentials
// never cross the worker message channel or appear in diagnostics.
const dynamodb = new DynamoDB.DocumentClient({ region: workerData.region || process.env.AWS_REGION || 'us-west-1' });
const querySnapshotsByType = createPublishedTradeSnapshotReader({
  dynamodb, indexName: workerData.indexName || process.env.HEDGEYE_SNAPSHOT_INDEX || 'snapshotType-date-meta-index',
  tableName: workerData.tableName || 'HedgeyeDailySnapshot', concurrency: 2,
});
const archive = createPublishedTradeArchive({
  querySnapshotsByType, referencePath: workerData.referencePath, ttlMs: workerData.ttlMs,
});
const fields = ['ticker', 'sourceTicker', 'value', 'field', 'fieldPath', 'sourceText', 'sourceProduct',
  'sourceLabel', 'sourceUrl', 'date', 'publishedAt', 'sourceEventId', 'signalProvenance', 'qualityStatus',
  'sourceInstrument', 'basisLabel', 'basisRelationship', 'instrumentKey', 'referenceOnly', 'levels', 'statement'];
const pick = reading => Object.fromEntries(fields.filter(field => reading[field] !== undefined).map(field => [field, reading[field]]));
let closed = false;
parentPort.on('message', async message => {
  if (message?.type === 'dispose') {
    closed = true;
    dynamodb.client.destroy();
    parentPort.close();
    return;
  }
  if (message?.type !== 'load' || !Number.isSafeInteger(message.id) || message.id < 1) return;
  try {
    const readings = await archive.load({ waitForRefresh: message.waitForRefresh === true });
    const statements = archive.statements();
    if (!closed) parentPort.postMessage({ type: 'readings', id: message.id, verifiedAt: archive.status().verifiedAt,
      readings: readings.map(pick),
      statements: Object.fromEntries(Object.entries(statements).map(([kind, list]) => [kind, list.map(pick)])),
    });
  } catch {
    if (!closed) parentPort.postMessage({ type: 'failure', id: message.id, code: 'ARCHIVE_READ_FAILED' });
  }
});
parentPort.on('close', () => { closed = true; dynamodb.client.destroy(); });
parentPort.postMessage({ type: 'ready' });
