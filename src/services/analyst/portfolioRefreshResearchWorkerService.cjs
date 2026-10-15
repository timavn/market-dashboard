'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { validatePortfolioRefreshRequest } = require('./portfolioRefreshResearch.cjs');
const WORKER_PATH = path.join(__dirname, 'portfolioRefreshResearchWorker.cjs');
const unavailable = code => Object.assign(new Error('Portfolio research archive unavailable.'), { code, statusCode: 503 });

// Full archive scanning and extraction run away from the HTTP callback loop.
// One active scan and two bounded queued requests carry only capture identity.
function createPortfolioRefreshResearchWorkerService({ workerFactory = (filename, options) => new Worker(filename, options),
  workerTimeoutMs = 38_000, maxQueued = 2, restartBackoffMs = 1000, now = Date.now } = {}) {
  const requests = new Map();
  const capacity = Math.max(1, Math.min(4, Math.floor(Number(maxQueued) || 0) + 1));
  let state = null;
  let nextId = 0;
  let retryAt = 0;
  let closed = false;

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
    catch { fail(state, 'PORTFOLIO_ARCHIVE_REQUEST_FAILED'); }
  }
  function start() {
    if (state || closed) return;
    let target;
    try {
      const worker = workerFactory(WORKER_PATH, { execArgv: [],
        workerData: { region: process.env.AWS_REGION || 'us-west-1' },
        resourceLimits: { maxOldGenerationSizeMb: 512, stackSizeMb: 4 } });
      target = { worker, ready: false, activeId: null };
      state = target;
      target.onMessage = message => {
        if (state !== target || closed) return;
        if (message?.type === 'ready') { target.ready = true; dispatch(); return; }
        const request = requests.get(message?.id);
        if (!request || request.id !== target.activeId) return;
        if (message.type === 'failure') { settle(request, unavailable('PORTFOLIO_ARCHIVE_CAPTURE_FAILED')); return; }
        const value = message.value;
        const input = request.input;
        if (message.type !== 'result' || value?.schemaVersion !== 1 || value.asOf !== input.asOf
          || value.marketDate !== input.marketDate || value.referenceOnly !== true || value.executable !== false
          || !Array.isArray(value.requestedSymbols) || JSON.stringify(value.requestedSymbols) !== JSON.stringify(input.symbols)
          || !value.bySymbol || typeof value.bySymbol !== 'object' || Array.isArray(value.bySymbol)
          || JSON.stringify(Object.keys(value.bySymbol).sort()) !== JSON.stringify(input.symbols)
          || !Array.isArray(value.publications) || !Array.isArray(value.diagnostics) || !value.coverage || !value.manifest
          || typeof value.scanComplete !== 'boolean') {
          fail(target, 'PORTFOLIO_ARCHIVE_RESPONSE_INVALID'); return;
        }
        settle(request, null, value);
      };
      target.onExit = () => fail(target, 'PORTFOLIO_ARCHIVE_WORKER_EXIT');
      worker.on('message', target.onMessage);
      worker.on('exit', target.onExit);
      worker.on('error', () => fail(target, 'PORTFOLIO_ARCHIVE_WORKER_ERROR'));
      worker.unref?.();
    } catch { fail(target || null, 'PORTFOLIO_ARCHIVE_WORKER_START_FAILED'); }
  }
  function capture(params) {
    let input;
    try { input = validatePortfolioRefreshRequest(params); }
    catch (error) { return Promise.reject(error); }
    if (closed) return Promise.reject(unavailable('PORTFOLIO_ARCHIVE_WORKER_CLOSED'));
    if (Number(now()) < retryAt) return Promise.reject(unavailable('PORTFOLIO_ARCHIVE_WORKER_UNAVAILABLE'));
    if (requests.size >= capacity) return Promise.reject(unavailable('PORTFOLIO_ARCHIVE_WORKER_BUSY'));
    let resolve; let reject;
    const promise = new Promise((done, failed) => { resolve = done; reject = failed; });
    const request = { id: ++nextId, input, resolve, reject, sent: false };
    request.timeout = setTimeout(() => fail(state, 'PORTFOLIO_ARCHIVE_WORKER_TIMEOUT'), workerTimeoutMs);
    requests.set(request.id, request);
    start();
    if (requests.has(request.id) && state) { state.worker.ref?.(); dispatch(); }
    return promise;
  }
  async function close() {
    closed = true;
    const previous = state;
    state = null;
    for (const request of [...requests.values()]) settle(request, unavailable('PORTFOLIO_ARCHIVE_WORKER_CLOSED'));
    await stop(previous);
  }
  return { capture, close };
}

module.exports = { createPortfolioRefreshResearchWorkerService };
