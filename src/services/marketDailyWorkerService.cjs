'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { validateMarketDailyReference, mergeMarketDailyReference, retainMarketDailyReference } = require('../utils/marketDailyReference.cjs');
const { createMarketDailyReferenceStore } = require('./marketDailyReferenceStore.cjs');

const WORKER_PATH = path.join(__dirname, 'marketDailyWorker.cjs');
const unavailable = (loading = false) => ({ status: 'unavailable', loading });

function flagged(value, visited = new WeakSet()) {
  if (!value || typeof value !== 'object' || visited.has(value)) return false;
  visited.add(value);
  const invalidFlags = ['mock', 'isMock', 'seed', 'seeded', 'isSeed', 'stale', 'isStale', 'cacheOnly', 'isCacheOnly',
    'fromCache', 'refreshFailed', 'offline', 'disconnected', 'synthetic', 'fallback', 'isFallback', 'modelOnly', 'portfolioDerived', 'inferred'];
  if (invalidFlags.some(key => value[key] === true) || value.connected === false || value.available === false) return true;
  if (['source', 'provenance', 'freshness', 'warning', 'status'].some(key => typeof value[key] === 'string'
    && /^(mock|seeded|stale|cache.only|offline|disconnected|synthetic|fallback|model.only|inferred|error)$/i.test(value[key]))) return true;
  return Object.values(value).some(item => item && typeof item === 'object' && flagged(item, visited));
}

function validSnapshot(value, nowMs) {
  if (!value || typeof value !== 'object' || flagged(value)) return false;
  if (value.status === 'unavailable') return typeof value.loading === 'boolean';
  if (!validateMarketDailyReference(value, nowMs)
    || !Number.isInteger(value.universe?.count) || value.universe.count < 500 || value.universe.count > 550
    || !Number.isInteger(value.coverage?.quotes) || value.coverage.quotes < 0 || value.coverage.quotes > value.universe.count
    || value.coverage.total !== value.universe.count) return false;
  for (const key of ['breadth', 'leadership', 'outliers']) if (!value[key] || typeof value[key] !== 'object' || Array.isArray(value[key])) return false;
  for (const key of ['winners', 'losers']) {
    if (!Array.isArray(value[key]) || value[key].length > 3 || value[key].some(row => !row
      || !/^[A-Z][A-Z0-9.-]{0,9}$/.test(row.ticker || '') || typeof row.name !== 'string'
      || !Number.isFinite(row.changePercent) || !Number.isFinite(Date.parse(row.asOf)))) return false;
  }
  return true;
}

function safeDiagnostic(value) {
  if (!value || !/^[a-z-]+$/.test(value.stage || '') || !/^[A-Z0-9_]+$/.test(value.code || '')) return null;
  const output = { stage: value.stage, code: value.code };
  for (const key of ['elapsedMs', 'requestFailures', 'membershipPublications', 'memberCount', 'dailyCount', 'intradayCount', 'sectorCount', 'mappedSectorCount']) {
    if (Number.isFinite(value[key]) && value[key] >= 0) output[key] = value[key];
  }
  return output;
}

function createMarketDailyWorkerService({
  workerFactory = (filename, options) => new Worker(filename, options),
  workerTimeoutMs = 30_000,
  restartBackoffMs = 30_000,
  now = Date.now,
  sourceOptions = {},
  referencePath,
  onDiagnostic = diagnostic => console.info('[market-daily]', JSON.stringify(diagnostic)),
} = {}) {
  let state = null;
  let pending = null;
  let nextId = 0;
  let retryAt = 0;
  let disposed = false;
  const referenceStore = createMarketDailyReferenceStore({ referencePath, now });
  let reference = referenceStore.read();

  function retained(loading = false) {
    reference = retainMarketDailyReference(reference, Number(now()));
    return reference ? { ...reference, loading } : unavailable(loading);
  }

  function report(value) {
    const diagnostic = safeDiagnostic(value);
    if (diagnostic) try { onDiagnostic?.(diagnostic); } catch { /* Logging must not affect availability. */ }
  }

  function finish(snapshot) {
    if (!pending) return;
    const completed = pending;
    pending = null;
    clearTimeout(completed.timeout);
    state?.worker.unref?.();
    completed.resolve(snapshot);
  }

  function stopWorker(target) {
    if (!target) return;
    target.worker.removeListener('message', target.onMessage);
    target.worker.removeListener('exit', target.onExit);
    // Preserve the guarded error listener until a late native error is harmless.
    try { Promise.resolve(target.worker.terminate()).catch(() => {}); } catch { /* Already exited. */ }
  }

  function fail(target, code) {
    if (target && target !== state) return;
    const failed = state;
    state = null;
    retryAt = Number(now()) + restartBackoffMs;
    report({ stage: 'worker', code });
    stopWorker(failed);
    finish(retained());
  }

  function dispatch() {
    if (!pending || !state?.ready || pending.sent) return;
    pending.sent = true;
    try { state.worker.postMessage({ type: 'snapshot', id: pending.id }); }
    catch { fail(state, 'WORKER_REQUEST_FAILED'); }
  }

  function startWorker() {
    if (state || disposed) return;
    let target;
    try {
      const worker = workerFactory(WORKER_PATH, {
        workerData: {
          concurrency: sourceOptions.concurrency ?? 8,
          refreshMs: sourceOptions.refreshMs ?? 300_000,
          membershipRefreshMs: sourceOptions.membershipRefreshMs ?? 1_800_000,
          requestTimeoutMs: sourceOptions.requestTimeoutMs ?? 8_000,
          overallTimeoutMs: sourceOptions.overallTimeoutMs ?? 180_000,
          referencePath,
        },
        execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 256, stackSizeMb: 4 },
      });
      target = { worker, ready: false };
      state = target;
      target.onMessage = message => {
        if (state !== target || disposed) return;
        if (message?.type === 'diagnostic') { report(message.diagnostic); return; }
        if (message?.type === 'ready') { target.ready = true; dispatch(); return; }
        if (message?.type !== 'snapshot') { fail(target, 'WORKER_RESPONSE_INVALID'); return; }
        if (!pending || message.id !== pending.id) return;
        if (!validSnapshot(message.snapshot, Number(now()))) { fail(target, 'WORKER_RESPONSE_INVALID'); return; }
        if (message.snapshot.status === 'unavailable') { finish(retained(message.snapshot.loading)); return; }
        reference = mergeMarketDailyReference(reference, message.snapshot, Number(now()));
        // The collecting service owns disk writes. A delayed message here must
        // not overwrite a newer completed collection persisted by the worker.
        finish({ ...reference, loading: message.snapshot.loading === true });
      };
      target.onExit = () => fail(target, 'WORKER_EXIT');
      worker.on('message', target.onMessage);
      worker.on('error', () => fail(target, 'WORKER_ERROR'));
      worker.on('exit', target.onExit);
      // Idle background collection must not prevent the server process exiting.
      worker.unref?.();
    } catch {
      fail(target || null, 'WORKER_START_FAILED');
    }
  }

  function getSnapshot() {
    if (pending) return pending.promise;
    if (disposed) return Promise.resolve(unavailable());
    if (Number(now()) < retryAt) return Promise.resolve(retained());
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    pending = { promise, resolve, id: ++nextId, sent: false, timeout: null };
    pending.timeout = setTimeout(() => fail(state, 'WORKER_TIMEOUT'), workerTimeoutMs);
    startWorker();
    if (pending && state) {
      state.worker.ref?.();
      dispatch();
    }
    return promise;
  }

  function dispose() {
    disposed = true;
    const previous = state;
    state = null;
    stopWorker(previous);
    finish(unavailable());
  }

  return { getSnapshot, dispose };
}

module.exports = { createMarketDailyWorkerService };
