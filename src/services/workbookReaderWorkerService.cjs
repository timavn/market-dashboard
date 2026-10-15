'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');

const WORKER_PATH = path.join(__dirname, 'workbookReaderWorker.cjs');

function unavailable(code) {
  return Object.assign(new Error('Workbook parsing is unavailable.'), { code, statusCode: 503, retryable: true });
}

/** One parser runs at a time. Waiting requests retain bounded, owned byte copies
 * so later caller mutation cannot change the workbook bound to its source hash.
 * Defaults parse acquired bytes only; injected readers remain caller-owned.
 */
function createWorkbookReaderWorkerService({
  workerFactory = (filename, options) => new Worker(filename, options),
  workerTimeoutMs = 30_000,
  maxQueued = 16,
  maxPendingBytes = 64 * 1024 * 1024,
  restartBackoffMs = 1_000,
  now = Date.now,
  onDiagnostic = diagnostic => console.warn('[workbook-reader]', JSON.stringify(diagnostic)),
} = {}) {
  const requests = new Map();
  const capacity = Math.max(1, Math.min(32, Math.floor(Number(maxQueued) || 0) + 1));
  let state = null;
  let nextId = 0;
  let pendingBytes = 0;
  let retryAt = 0;
  let closed = false;
  let closing = null;

  function settle(request, error, value) {
    if (!requests.delete(request.id)) return;
    clearTimeout(request.timeout);
    pendingBytes -= request.byteLength;
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
    // Retain the guarded listener for native errors emitted during termination.
    target.worker.unref?.();
    try { return Promise.resolve(target.worker.terminate()).catch(() => {}); }
    catch { return Promise.resolve(); }
  }

  function fail(target, code) {
    if (target && target !== state) return;
    const previous = state;
    state = null;
    retryAt = Number(now()) + restartBackoffMs;
    try { onDiagnostic?.({ stage: 'worker', code }); } catch { /* Logging cannot block settlement. */ }
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
      state.worker.postMessage({ type: 'read', id: request.id, parser: request.parser,
        buffer: request.buffer, options: request.options }, [request.buffer]);
      request.buffer = null;
      request.options = null;
    } catch { fail(state, 'WORKBOOK_WORKER_REQUEST_FAILED'); }
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
        if (message?.type === 'started') return;
        if (message?.type === 'failure' && typeof message.error?.message === 'string') {
          const error = new Error(message.error.message);
          error.name = typeof message.error.name === 'string' ? message.error.name : 'Error';
          if (typeof message.error.code === 'string') error.code = message.error.code;
          settle(request, error);
        } else if (message?.type === 'result' && message.value != null && typeof message.value === 'object') {
          settle(request, null, message.value);
        } else fail(target, 'WORKBOOK_WORKER_RESPONSE_INVALID');
      };
      target.onExit = () => fail(target, 'WORKBOOK_WORKER_EXIT');
      worker.on('message', target.onMessage);
      worker.on('error', () => fail(target, 'WORKBOOK_WORKER_ERROR'));
      worker.on('exit', target.onExit);
      worker.unref?.();
    } catch { fail(target || null, 'WORKBOOK_WORKER_START_FAILED'); }
  }

  function read(input, options, parser = 'node') {
    if (closed) return Promise.reject(unavailable('WORKBOOK_WORKER_CLOSED'));
    if (Number(now()) < retryAt) return Promise.reject(unavailable('WORKBOOK_WORKER_UNAVAILABLE'));
    if (!['node', 'universal'].includes(parser) || !(input instanceof ArrayBuffer || ArrayBuffer.isView(input))) {
      return Promise.reject(unavailable('WORKBOOK_INPUT_INVALID'));
    }
    const byteLength = input.byteLength;
    if (requests.size >= capacity || pendingBytes + byteLength > maxPendingBytes) {
      return Promise.reject(unavailable('WORKBOOK_WORKER_BUSY'));
    }
    let buffer;
    let capturedOptions;
    try {
      const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array(input.buffer, input.byteOffset, byteLength);
      buffer = new Uint8Array(bytes).buffer;
      capturedOptions = structuredClone(options);
    } catch { return Promise.reject(unavailable('WORKBOOK_INPUT_INVALID')); }
    let resolve;
    let reject;
    const promise = new Promise((done, failed) => { resolve = done; reject = failed; });
    const request = { id: ++nextId, parser, buffer, options: capturedOptions, byteLength,
      sent: false, resolve, reject, timeout: null };
    request.timeout = setTimeout(() => fail(state, 'WORKBOOK_WORKER_TIMEOUT'), workerTimeoutMs);
    pendingBytes += byteLength;
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
    for (const request of [...requests.values()]) settle(request, unavailable('WORKBOOK_WORKER_CLOSED'));
    closing = stop(previous);
    return closing;
  }

  return { read, close };
}

let shared;
function sharedReader() {
  if (!shared) shared = createWorkbookReaderWorkerService();
  return shared;
}
const readWorkbookOffThread = (input, options) => sharedReader().read(input, options, 'node');
const readWorkbookUniversalOffThread = (input, options) => sharedReader().read(input, options, 'universal');
const closeWorkbookReaders = () => sharedReader().close();

module.exports = { createWorkbookReaderWorkerService, readWorkbookOffThread,
  readWorkbookUniversalOffThread, closeWorkbookReaders };
