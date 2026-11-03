'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { isExplicitTradeProvenance, isStatedReading } = require('../utils/publishedResearchSignals.cjs');
const { STATEMENT_KINDS } = require('./publishedTradeArchive.cjs');
const WORKER_PATH = path.join(__dirname, 'publishedTradeArchiveWorker.cjs');

function publishedSource(reading) {
  if (!/^[A-Z][A-Z0-9./=^_-]{0,30}$/.test(reading.sourceTicker || reading.ticker || '')
    || !['validated', 'indexed'].includes(reading.qualityStatus)
    || !/^\d{4}-\d{2}-\d{2}$/.test(reading.date || '')
    || !/^https:\/\/app\.hedgeye\.com\/feed_items\/\d+\/?$/.test(reading.sourceUrl || '')
    || typeof reading.sourceProduct !== 'string' || !reading.sourceProduct
    || ['mock', 'seed', 'seeded', 'inferred', 'synthetic', 'stale', 'cacheOnly', 'offline', 'disconnected'].some(flag => reading[flag] === true)) return false;
  const parsed = new Date(`${reading.date}T12:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === reading.date;
}
function validReadings(readings) {
  return Array.isArray(readings) && readings.length <= 100_000 && readings.every(reading => reading
    && ['BULLISH', 'BEARISH', 'NEUTRAL'].includes(reading.value)
    && isExplicitTradeProvenance(reading.signalProvenance) && publishedSource(reading));
}
// Reference Trade, stated Trend and Alpha Codes are each re-read from their own clause.
function validStatements(statements) {
  return statements && typeof statements === 'object' && STATEMENT_KINDS.every(kind => Array.isArray(statements[kind])
    && statements[kind].length <= 100_000 && statements[kind].every(reading => reading && publishedSource(reading) && isStatedReading(reading)));
}

/** Keep AWS deserialization, source extraction and disk IO off the API thread. */
function createPublishedTradeArchiveWorkerService({
  workerFactory = (filename, options) => new Worker(filename, options),
  workerTimeoutMs = 180_000, restartBackoffMs = 5_000, now = Date.now,
  region = process.env.AWS_REGION || 'us-west-1', indexName = process.env.HEDGEYE_SNAPSHOT_INDEX || 'snapshotType-date-meta-index',
  tableName = 'HedgeyeDailySnapshot', referencePath, ttlMs = 5 * 60_000,
  onDiagnostic = diagnostic => console.warn('[published-trade]', JSON.stringify(diagnostic)),
} = {}) {
  let state = null;
  let nextId = 0;
  let retryAt = 0;
  let disposed = false;
  let readings = [];
  let statements = Object.fromEntries(STATEMENT_KINDS.map(kind => [kind, []]));
  let hasResult = false;
  let refreshedAt = null;
  const requests = new Map();
  const inFlight = new Map();

  const retained = date => readings.filter(reading => reading.date <= date);
  function settle(request, value) {
    if (!requests.has(request.id)) return;
    clearTimeout(request.timeout);
    requests.delete(request.id);
    inFlight.delete(request.waitForRefresh);
    request.resolve(value);
    if (!requests.size) state?.worker.unref?.();
  }
  function stop(target) {
    if (!target) return;
    target.worker.removeListener('message', target.onMessage);
    target.worker.removeListener('exit', target.onExit);
    try { Promise.resolve(target.worker.terminate()).catch(() => {}); } catch { /* Already exited. */ }
  }
  function fail(target, code) {
    if (target && target !== state) return;
    const previous = state;
    state = null;
    retryAt = Number(now()) + restartBackoffMs;
    try { onDiagnostic?.({ stage: 'worker', code }); } catch { /* Diagnostics cannot block reads. */ }
    stop(previous);
    for (const request of [...requests.values()]) settle(request, readings);
  }
  function dispatch() {
    if (!state?.ready) return;
    for (const request of requests.values()) {
      if (request.sent) continue;
      request.sent = true;
      try { state.worker.postMessage({ type: 'load', id: request.id, waitForRefresh: request.waitForRefresh }); }
      catch { fail(state, 'WORKER_REQUEST_FAILED'); return; }
    }
  }
  function start() {
    if (state || disposed) return;
    let target;
    try {
      const worker = workerFactory(WORKER_PATH, {
        workerData: { region, indexName, tableName, referencePath, ttlMs },
        execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 512, stackSizeMb: 4 },
      });
      target = { worker, ready: false };
      state = target;
      target.onMessage = message => {
        if (state !== target || disposed) return;
        if (message?.type === 'ready') { target.ready = true; dispatch(); return; }
        const request = requests.get(message?.id);
        if (!request) return;
        // A reply without statements carries Trade only.
        const replied = message.statements ?? Object.fromEntries(STATEMENT_KINDS.map(kind => [kind, []]));
        if (message.type !== 'readings' || !validReadings(message.readings) || !validStatements(replied)) {
          fail(target, message.type === 'failure' ? 'ARCHIVE_READ_FAILED' : 'WORKER_RESPONSE_INVALID');
          return;
        }
        readings = message.readings;
        statements = replied;
        hasResult = true;
        refreshedAt = Number.isFinite(message.verifiedAt) ? new Date(message.verifiedAt).toISOString() : null;
        settle(request, readings);
      };
      target.onExit = () => fail(target, 'WORKER_EXIT');
      worker.on('message', target.onMessage);
      worker.on('error', () => fail(target, 'WORKER_ERROR'));
      worker.on('exit', target.onExit);
      worker.unref?.();
    } catch { fail(target || null, 'WORKER_START_FAILED'); }
  }
  function requestLoad(waitForRefresh) {
    if (inFlight.has(waitForRefresh)) return inFlight.get(waitForRefresh);
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    const request = { id: ++nextId, waitForRefresh, resolve, sent: false };
    request.timeout = setTimeout(() => fail(state, 'WORKER_TIMEOUT'), workerTimeoutMs);
    requests.set(request.id, request);
    inFlight.set(waitForRefresh, promise);
    start();
    if (requests.has(request.id) && state) { state.worker.ref?.(); dispatch(); }
    return promise;
  }
  async function load({ date = '9999-12-31', waitForRefresh = false } = {}) {
    if (disposed || Number(now()) < retryAt) return retained(date);
    const pending = requestLoad(waitForRefresh);
    if (!waitForRefresh && hasResult) return retained(date);
    return (await pending).filter(reading => reading.date <= date);
  }
  function dispose() {
    disposed = true;
    const previous = state;
    state = null;
    stop(previous);
    for (const request of [...requests.values()]) settle(request, readings);
  }
  // When the archive last read every snapshot type successfully, so a reader can
  // tell current readings from ones retained through failed reads or a backoff.
  const status = () => ({ refreshedAt, retrying: Number(now()) < retryAt });
  /** Reference Trade, stated Trend and Alpha Codes from the same archive read as load(). */
  async function loadStatements({ date = '9999-12-31', waitForRefresh = false } = {}) {
    await load({ date, waitForRefresh });
    return Object.fromEntries(STATEMENT_KINDS.map(kind => [kind, statements[kind].filter(reading => reading.date <= date)]));
  }
  return { load, loadStatements, status, dispose };
}

module.exports = { createPublishedTradeArchiveWorkerService, validReadings, validStatements };
