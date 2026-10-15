'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const { createMarketDailyService } = require('./marketDailyService.cjs');

// This persistent worker owns provider callbacks, workbook parsing and bounded
// historical observations independently of the busy dashboard event loop.
const service = createMarketDailyService({
  ...workerData,
  onDiagnostic: diagnostic => parentPort.postMessage({ type: 'diagnostic', diagnostic }),
});

parentPort.on('message', message => {
  if (message?.type === 'dispose') {
    service.dispose();
    parentPort.close();
    return;
  }
  if (message?.type !== 'snapshot' || !Number.isSafeInteger(message.id) || message.id < 1) return;
  let snapshot;
  try { snapshot = service.getSnapshot(); } catch { snapshot = { status: 'unavailable', loading: false }; }
  parentPort.postMessage({ type: 'snapshot', id: message.id, snapshot });
});
parentPort.on('close', () => service.dispose());
process.on('exit', () => service.dispose());
parentPort.postMessage({ type: 'ready' });
