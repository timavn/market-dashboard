'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const { createSp500ContributorsService } = require('./sp500ContributorsService.cjs');

// Each worker owns one fresh provider request. It keeps source callbacks and
// workbook parsing independent of the dashboard's busy Express event loop.
const service = createSp500ContributorsService({
  timeoutMs: workerData.sourceTimeoutMs,
  overallTimeoutMs: workerData.sourceOverallTimeoutMs,
  onDiagnostic: diagnostic => parentPort.postMessage({ type: 'diagnostic', diagnostic }),
});

service.getSnapshot({ momoSnapshot: workerData.momoSnapshot }).then(snapshot => {
  parentPort.postMessage({ type: 'snapshot', snapshot });
}).catch(() => {
  parentPort.postMessage({ type: 'snapshot', snapshot: { status: 'unavailable', rows: [] } });
}).finally(() => parentPort.close());
