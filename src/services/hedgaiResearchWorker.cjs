'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const { DynamoDB } = require('./aws/clients.cjs');
const { createHedgaiLedgerLoader } = require('./hedgaiResearchLedger.cjs');
const { loadReviewedBaseline, buildHedgaiResearch } = require('./hedgaiResearch.cjs');
const { createHedgaiResearchLoader } = require('../routes/hedgaiResearch.cjs');

// The sanitized API environment is inherited, including its AWS profile.
// Provider collections and screenshot verification remain in this worker.
const dynamodb = new DynamoDB.DocumentClient({ region: workerData.region });
let lastLedger = null;
const loadResearch = createHedgaiResearchLoader({
  loadEvents: createHedgaiLedgerLoader({ dynamodb, tableName: workerData.tableName,
    onDiagnostic: value => { lastLedger = value; } }),
  loadBaseline: loadReviewedBaseline,
  buildProjection: buildHedgaiResearch,
});

parentPort.on('message', async message => {
  if (message?.type !== 'capture' || !Number.isSafeInteger(message.id) || message.id < 1) return;
  try {
    lastLedger = null;
    const value = await loadResearch(message.input);
    parentPort.postMessage({ type: 'result', id: message.id, value,
      diagnostic: lastLedger });
  } catch {
    parentPort.postMessage({ type: 'failure', id: message.id });
  }
});
parentPort.on('close', () => dynamodb.client.destroy());
parentPort.postMessage({ type: 'ready' });
