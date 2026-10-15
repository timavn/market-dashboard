'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');

const WORKER_PATH = path.join(__dirname, 'ibkrInterestEvidenceWorker.cjs');
const unavailable = (code, status = 503) => Object.assign(
  new Error('Verified IBKR interest evidence is unavailable.'), { code, status },
);

function createIbkrInterestEvidenceWorkerService({ env = process.env,
  workerFactory = (filename, options) => new Worker(filename, options),
  workerTimeoutMs = 30_000, maxQueued = 2, restartBackoffMs = 1000, now = Date.now } = {}) {
  // Pass only this reader's configuration; unrelated provider credentials and
  // process environment never enter its protocol or diagnostics.
  const readerEnv = Object.fromEntries(Object.entries(env).filter(([key]) => (
    key.startsWith('IBKR_INTEREST_') || key.startsWith('IBKR_FLEX_') || key === 'IBKR_ACCOUNT_ID'
  )));
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
    try { state.worker.postMessage({ type: 'read', id: request.id,
      operation: request.operation, input: request.input }); }
    catch { fail(state, 'interest_evidence_worker_request_failed'); }
  }
  function validResponse(request, message) {
    if (message.operation !== request.operation || message.now !== request.input.now
      || !message.value || typeof message.value !== 'object' || Array.isArray(message.value)) return false;
    const value = message.value;
    if (request.operation === 'status') return value.flexStatus && typeof value.flexStatus === 'object'
      && Object.hasOwn(value, 'summary') && Object.hasOwn(value, 'storedLatestObservation');
    if (request.operation === 'history') return value.source === 'ibkr_interest_validation'
      && value.generatedAt === request.input.now
      && ['observations', 'predictions', 'actuals', 'misses'].every(key => Array.isArray(value[key]));
    return value.source === 'ibkr_verified_interest_ledger' && value.accountMatched === true
      && value.accountId === request.input.accountId && value.generatedAt === request.input.now
      && value.fromCache === false
      && ['ledger', 'observations', 'forecasts', 'postings', 'formulaAudit'].every(key => Array.isArray(value[key]));
  }
  function start() {
    if (state || closed) return;
    let target;
    try {
      const worker = workerFactory(WORKER_PATH, { execArgv: [], workerData: { env: readerEnv },
        resourceLimits: { maxOldGenerationSizeMb: 256, stackSizeMb: 4 } });
      target = { worker, ready: false, activeId: null };
      state = target;
      target.onMessage = message => {
        if (state !== target || closed) return;
        if (message?.type === 'ready') { target.ready = true; dispatch(); return; }
        const request = requests.get(message?.id);
        if (!request || request.id !== target.activeId) return;
        if (message.type === 'failure') {
          const code = /^[a-zA-Z0-9_-]+$/.test(message.code) ? message.code : 'interest_evidence_read_failed';
          settle(request, unavailable(code, [403, 503].includes(message.status) ? message.status : 503));
          return;
        }
        if (message.type !== 'result' || !validResponse(request, message)) {
          fail(target, 'interest_evidence_worker_response_invalid'); return;
        }
        settle(request, null, message.value);
      };
      target.onExit = () => fail(target, 'interest_evidence_worker_exit');
      worker.on('message', target.onMessage);
      worker.on('exit', target.onExit);
      worker.on('error', () => fail(target, 'interest_evidence_worker_error'));
      worker.unref?.();
    } catch { fail(target || null, 'interest_evidence_worker_start_failed'); }
  }
  function read(operation, options = {}) {
    const input = { now: options.now || new Date(Number(now())).toISOString() };
    if (typeof input.now !== 'string' || !Number.isFinite(Date.parse(input.now))) {
      return Promise.reject(unavailable('interest_evidence_invalid_time', 400));
    }
    input.now = new Date(input.now).toISOString();
    if (operation === 'status') input.account = options.account;
    if (operation === 'history') input.limit = options.limit;
    if (operation === 'ledger') {
      input.accountId = String(options.accountId || '').trim();
      if (!input.accountId || input.accountId.length > 128) {
        return Promise.reject(unavailable('interest_ledger_account_required', 400));
      }
    }
    if (closed) return Promise.reject(unavailable('interest_evidence_worker_closed'));
    if (Number(now()) < retryAt) return Promise.reject(unavailable('interest_evidence_worker_unavailable'));
    if (requests.size >= capacity) return Promise.reject(unavailable('interest_evidence_worker_busy'));
    let resolve; let reject;
    const promise = new Promise((done, failed) => { resolve = done; reject = failed; });
    const request = { id: ++nextId, operation, input, resolve, reject, sent: false };
    request.timeout = setTimeout(() => fail(state, 'interest_evidence_worker_timeout'), workerTimeoutMs);
    requests.set(request.id, request);
    start();
    if (requests.has(request.id) && state) { state.worker.ref?.(); dispatch(); }
    return promise;
  }
  async function close() {
    closed = true;
    const previous = state;
    state = null;
    for (const request of [...requests.values()]) settle(request, unavailable('interest_evidence_worker_closed'));
    await stop(previous);
  }
  return { readStatus: options => read('status', options), readHistory: options => read('history', options),
    readLedger: options => read('ledger', options), close };
}

module.exports = { createIbkrInterestEvidenceWorkerService };
