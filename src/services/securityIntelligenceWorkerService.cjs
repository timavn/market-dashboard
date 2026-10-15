'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');

const WORKER_PATH = path.join(__dirname, 'securityIntelligenceWorker.cjs');

function unavailable(code) {
  return Object.assign(new Error('Security research projection is unavailable.'), {
    code, statusCode: 503, retryable: true,
  });
}

/** One persistent serial worker; one active projection and four queued by default.
 * Large acquired provider collections are borrowed unchanged until settlement.
 * Queueing retains their existing references instead of copying the complete
 * cached research corpus into the worker for every waiting request.
 */
function createSecurityIntelligenceWorkerService({
  workerFactory = (filename, options) => new Worker(filename, options),
  workerTimeoutMs = 30_000,
  maxQueued = 4,
  restartBackoffMs = 1_000,
  now = Date.now,
  onDiagnostic = diagnostic => console.warn('[security-intelligence]', JSON.stringify(diagnostic)),
} = {}) {
  let state = null;
  let nextId = 0;
  let retryAt = 0;
  let closed = false;
  let closing = null;
  const requests = new Map();
  const capacity = Math.max(1, Math.min(32, Math.floor(Number(maxQueued) || 0) + 1));

  function settle(request, error, value) {
    if (!requests.delete(request.id)) return;
    clearTimeout(request.timeout);
    if (error) request.reject(error);
    else request.resolve(value);
    if (state?.activeId === request.id) state.activeId = null;
    if (!requests.size) state?.worker.unref?.();
    else dispatch();
  }

  function stop(target) {
    if (!target) return Promise.resolve();
    target.worker.removeListener('message', target.onMessage);
    target.worker.removeListener('exit', target.onExit);
    // A guarded error listener remains for any late native worker error.
    target.worker.unref?.();
    try { return Promise.resolve(target.worker.terminate()).catch(() => {}); }
    catch { return Promise.resolve(); }
  }

  function fail(target, code) {
    if (target && target !== state) return;
    const previous = state;
    state = null;
    retryAt = Number(now()) + restartBackoffMs;
    try { onDiagnostic?.({ stage: 'worker', code }); } catch { /* Diagnostics cannot block requests. */ }
    void stop(previous);
    for (const request of [...requests.values()]) settle(request, unavailable(code));
  }

  function dispatch() {
    if (!state?.ready || state.activeId != null) return;
    const request = [...requests.values()].find(value => !value.sent);
    if (!request) return;
    state.activeId = request.id;
    request.sent = true;
    try {
      // Structured cloning happens once, only for the active projection. The
      // provider collections retain their own source dates and provenance.
      state.worker.postMessage({ type: 'build', id: request.id, input: request.input });
      request.input = null;
    } catch { fail(state, 'SECURITY_INTELLIGENCE_WORKER_REQUEST_FAILED'); }
  }

  function start() {
    if (state || closed) return;
    let target;
    try {
      const worker = workerFactory(WORKER_PATH, {
        execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 512, stackSizeMb: 4 },
      });
      target = { worker, ready: false, activeId: null };
      state = target;
      target.onMessage = message => {
        if (state !== target || closed) return;
        if (message?.type === 'ready') { target.ready = true; dispatch(); return; }
        const request = requests.get(message?.id);
        if (!request || request.id !== target.activeId) return;
        if (message?.type === 'failure') {
          settle(request, unavailable('SECURITY_INTELLIGENCE_BUILD_FAILED'));
          return;
        }
        const value = message?.value;
        if (!target.ready || message?.type !== 'result' || !value || typeof value !== 'object' || Array.isArray(value)
          || value.schemaVersion !== request.version || !Array.isArray(value.requestedSymbols)
          || !value.bySymbol || typeof value.bySymbol !== 'object' || Array.isArray(value.bySymbol)
          || typeof value.generatedAt !== 'string' || !Number.isFinite(Date.parse(value.generatedAt))) {
          fail(target, 'SECURITY_INTELLIGENCE_RESPONSE_INVALID');
          return;
        }
        settle(request, null, value);
      };
      target.onExit = () => fail(target, 'SECURITY_INTELLIGENCE_WORKER_EXIT');
      worker.on('message', target.onMessage);
      worker.on('error', () => fail(target, 'SECURITY_INTELLIGENCE_WORKER_ERROR'));
      worker.on('exit', target.onExit);
      worker.unref?.();
    } catch { fail(target || null, 'SECURITY_INTELLIGENCE_WORKER_START_FAILED'); }
  }

  function build(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || ![1, 2].includes(input.version)) {
      return Promise.reject(unavailable('SECURITY_INTELLIGENCE_INPUT_INVALID'));
    }
    if (closed) return Promise.reject(unavailable('SECURITY_INTELLIGENCE_WORKER_CLOSED'));
    if (Number(now()) < retryAt) return Promise.reject(unavailable('SECURITY_INTELLIGENCE_WORKER_UNAVAILABLE'));
    if (requests.size >= capacity) return Promise.reject(unavailable('SECURITY_INTELLIGENCE_WORKER_BUSY'));
    let resolve;
    let reject;
    const promise = new Promise((done, failed) => { resolve = done; reject = failed; });
    const capturedInput = { ...input,
      ...(Array.isArray(input.symbols) ? { symbols: [...input.symbols] } : {}),
      ...(input.now instanceof Date ? { now: new Date(input.now) } : {}),
    };
    const request = { id: ++nextId, version: input.version, input: capturedInput,
      sent: false, resolve, reject, timeout: null };
    request.timeout = setTimeout(() => fail(state, 'SECURITY_INTELLIGENCE_WORKER_TIMEOUT'), workerTimeoutMs);
    requests.set(request.id, request);
    start();
    if (requests.has(request.id) && state) {
      state.worker.ref?.();
      dispatch();
    }
    return promise;
  }

  function close() {
    if (closing) return closing;
    closed = true;
    const previous = state;
    state = null;
    for (const request of [...requests.values()]) settle(request, unavailable('SECURITY_INTELLIGENCE_WORKER_CLOSED'));
    closing = stop(previous);
    return closing;
  }

  return { build, close };
}

module.exports = { createSecurityIntelligenceWorkerService };
