'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const { DynamoDB } = require('../aws/clients.cjs');
const { capturePortfolioRefreshResearch } = require('./portfolioRefreshResearch.cjs');

// Match the API's provider environment. Credentials stay inside the worker.
const dynamodb = new DynamoDB.DocumentClient({ region: workerData.region || process.env.AWS_REGION || 'us-west-1' });
parentPort.on('message', async message => {
  if (message?.type !== 'capture' || !Number.isSafeInteger(message.id) || message.id < 1) return;
  try {
    const value = await capturePortfolioRefreshResearch({ ...message.input, dynamodb });
    parentPort.postMessage({ type: 'result', id: message.id, value });
  } catch {
    parentPort.postMessage({ type: 'failure', id: message.id });
  }
});
parentPort.on('close', () => dynamodb.client.destroy());
parentPort.postMessage({ type: 'ready' });
