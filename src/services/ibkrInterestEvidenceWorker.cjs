'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const { createIbkrInterestValidationService } = require('./ibkrInterestValidationService.cjs');
const { readPrivateInterestLedger } = require('../../scripts/export_ibkr_interest_ledger.cjs');

let captureTime = new Date();
const service = createIbkrInterestValidationService({
  env: workerData.env,
  now: () => captureTime,
});

// These are fresh local evidence reads only. This worker never starts the
// scheduler, fetches a broker/Flex report, or appends a journal record.
parentPort.on('message', message => {
  if (message?.type !== 'read' || !Number.isSafeInteger(message.id) || message.id < 1) return;
  try {
    captureTime = new Date(message.input.now);
    let value;
    if (message.operation === 'status') value = service.readStatusEvidence(message.input);
    else if (message.operation === 'history') value = service.history(message.input);
    else if (message.operation === 'ledger') value = readPrivateInterestLedger({
      env: workerData.env, accountId: message.input.accountId, now: captureTime,
    });
    else throw Object.assign(new Error('Unsupported evidence read.'), { code: 'interest_evidence_invalid_operation' });
    parentPort.postMessage({ type: 'result', id: message.id,
      operation: message.operation, now: message.input.now, value });
  } catch (error) {
    const code = String(error?.code || 'interest_evidence_read_failed').replace(/[^a-zA-Z0-9_-]/g, '_');
    parentPort.postMessage({ type: 'failure', id: message.id, code,
      status: Number.isInteger(error?.status) ? error.status : 503 });
  }
});
parentPort.postMessage({ type: 'ready' });
