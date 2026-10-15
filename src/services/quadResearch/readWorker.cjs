'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const { createSnapshotStore } = require('./snapshot.cjs');

createSnapshotStore({ directory: workerData.directory, synchronousReads: true }).latest()
  .then(edition => { parentPort.postMessage(edition); parentPort.close(); })
  .catch(() => parentPort.postMessage({ schemaVersion: 1, source: 'independent-quad-research',
    historicalOnly: true, available: false, cells: [], reason: 'Verified historical research edition unavailable.' }));
