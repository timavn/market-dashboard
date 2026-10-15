'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');

// Integrity checking is read-only but touches every archived source. Keep its
// file I/O and hashing away from the busy live-quote event loop. Concurrent
// callers share only an in-progress verification, never a cached result.
function createSnapshotReader({ directory } = {}) {
  let pending = null;
  return {
    latest() {
      if (pending) return pending;
      pending = new Promise((resolve, reject) => {
        const worker = new Worker(path.join(__dirname, 'readWorker.cjs'), { workerData: { directory } });
        const timeout = setTimeout(() => {
          worker.terminate();
          reject(new Error('Historical verification timed out.'));
        }, 30000);
        worker.once('message', edition => { clearTimeout(timeout); resolve(edition); });
        worker.once('error', () => { clearTimeout(timeout); reject(new Error('Historical verification failed.')); });
        worker.once('exit', code => {
          clearTimeout(timeout);
          if (code !== 0) reject(new Error('Historical verification failed.'));
        });
      }).finally(() => { pending = null; });
      return pending;
    },
  };
}

module.exports = { createSnapshotReader };
