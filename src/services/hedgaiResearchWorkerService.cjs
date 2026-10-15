'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');
const WORKER_PATH = path.join(__dirname, 'hedgaiResearchWorker.cjs');
const unavailable = code => Object.assign(new Error('HedgAI research unavailable.'), { code, statusCode: 503 });

function createHedgaiResearchWorkerService({ region = process.env.AWS_REGION || 'us-west-1',
  tableName = process.env.RESEARCH_EVENT_LEDGER_TABLE || 'ResearchEventLedgerV2',
  workerFactory = (filename, options) => new Worker(filename, options),
  workerTimeoutMs = 30_000, maxQueued = 2, restartBackoffMs = 1000, now = Date.now } = {}) {
  const requests = new Map();
  const capacity = Math.max(1, Math.min(4, Math.floor(Number(maxQueued) || 0) + 1));
  let state = null;
  let nextId = 0;
  let retryAt = 0;
  let closed = false;
  let lastLedger = null;

  function stop(target) {
    if (!target) return Promise.resolve();
    target.worker.removeListener('message', target.onMessage);
    target.worker.removeListener('exit', target.onExit);
    target.worker.unref?.();
    try { return Promise.resolve(target.worker.terminate()).catch(() => {}); }
    catch { return Promise.resolve(); }
  }
  function settle(request, error, value) {
    if (!requests.delete(request.id)) return;
    clearTimeout(request.timeout);
    if (error) request.reject(error); else request.resolve(value);
    if (state?.activeId === request.id) state.activeId = null;
    if (!requests.size) state?.worker.unref?.(); else dispatch();
  }
  function fail(target, code) {
    if (target && target !== state) return;
    const previous = state;
    state = null;
    retryAt = Number(now()) + restartBackoffMs;
    void stop(previous);
    for (const request of [...requests.values()]) settle(request, unavailable(code));
  }
  function dispatch() {
    if (!state?.ready || state.activeId != null) return;
    const request = [...requests.values()].find(value => !value.sent);
    if (!request) return;
    state.activeId = request.id;
    request.sent = true;
    try { state.worker.postMessage({ type: 'capture', id: request.id, input: request.input }); }
    catch { fail(state, 'HEDGAI_WORKER_REQUEST_FAILED'); }
  }
  function start() {
    if (state || closed) return;
    let target;
    try {
      const worker = workerFactory(WORKER_PATH, { execArgv: [], workerData: { region, tableName },
        resourceLimits: { maxOldGenerationSizeMb: 512, stackSizeMb: 4 } });
      target = { worker, ready: false, activeId: null };
      state = target;
      target.onMessage = message => {
        if (state !== target || closed) return;
        if (message?.type === 'ready') { target.ready = true; dispatch(); return; }
        const request = requests.get(message?.id);
        if (!request || request.id !== target.activeId) return;
        if (message.type === 'failure') { settle(request, unavailable('HEDGAI_CAPTURE_FAILED')); return; }
        const value = message.value;
        if (message.type !== 'result' || value?.version !== 1 || value.product !== 'hedgai-signals'
          || value.asOf !== new Date(request.input.asOf).toISOString()
          || !Array.isArray(value.book?.rows) || !Array.isArray(value.sources)
          || !Array.isArray(value.changes) || !Array.isArray(value.reaffirmations)
          || !Array.isArray(value.unresolvedActions) || !Array.isArray(value.marketMatches)
          || !value.sourceQuality || typeof value.sourceQuality !== 'object' || Array.isArray(value.sourceQuality)
          || !value.marketReadings || typeof value.marketReadings !== 'object' || Array.isArray(value.marketReadings)) {
          fail(target, 'HEDGAI_WORKER_RESPONSE_INVALID'); return;
        }
        const diagnostic = message.diagnostic;
        if (diagnostic?.stage === 'ledger' && Number.isSafeInteger(diagnostic.itemCount) && diagnostic.itemCount >= 0
          && Number.isSafeInteger(diagnostic.pages) && diagnostic.pages >= 0
          && ['hit', 'miss', 'stale', 'superseded'].includes(diagnostic.cacheStatus)) {
          lastLedger = { itemCount: diagnostic.itemCount, pages: diagnostic.pages, cacheStatus: diagnostic.cacheStatus };
        }
        settle(request, null, value);
      };
      target.onExit = () => fail(target, 'HEDGAI_WORKER_EXIT');
      worker.on('message', target.onMessage);
      worker.on('exit', target.onExit);
      worker.on('error', () => fail(target, 'HEDGAI_WORKER_ERROR'));
      worker.unref?.();
    } catch { fail(target || null, 'HEDGAI_WORKER_START_FAILED'); }
  }
  function loadResearch({ asOf = new Date(Number(now())).toISOString(), forceRefresh = false, refreshAfter } = {}) {
    if (typeof asOf !== 'string' || !Number.isFinite(Date.parse(asOf))) {
      return Promise.reject(Object.assign(new Error('A valid research capture time is required.'), { statusCode: 400 }));
    }
    if (closed) return Promise.reject(unavailable('HEDGAI_WORKER_CLOSED'));
    if (Number(now()) < retryAt) return Promise.reject(unavailable('HEDGAI_WORKER_UNAVAILABLE'));
    if (requests.size >= capacity) return Promise.reject(unavailable('HEDGAI_WORKER_BUSY'));
    let resolve; let reject;
    const promise = new Promise((done, failed) => { resolve = done; reject = failed; });
    const request = { id: ++nextId, input: { asOf, forceRefresh, refreshAfter }, resolve, reject, sent: false };
    request.timeout = setTimeout(() => fail(state, 'HEDGAI_WORKER_TIMEOUT'), workerTimeoutMs);
    requests.set(request.id, request);
    start();
    if (requests.has(request.id) && state) { state.worker.ref?.(); dispatch(); }
    return promise;
  }
  async function close() {
    closed = true;
    const previous = state;
    state = null;
    for (const request of [...requests.values()]) settle(request, unavailable('HEDGAI_WORKER_CLOSED'));
    await stop(previous);
  }
  return { loadResearch, close, getHealth: () => ({ active: state?.activeId != null,
    pending: requests.size, ledger: lastLedger ? { ...lastLedger } : null }) };
}

module.exports = { createHedgaiResearchWorkerService };
