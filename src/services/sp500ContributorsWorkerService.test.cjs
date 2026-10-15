'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Worker } = require('node:worker_threads');
const { createSp500ContributorsWorkerService } = require('./sp500ContributorsWorkerService.cjs');

const snapshot = () => ({
  status: 'available', asOf: '2026-09-14', fetchedAt: '2026-09-14T23:00:00Z',
  source: 'State Street / S&P Dow Jones Indices', sourceUrl: 'https://www.ssga.com/',
  ranking: 'company-market-cap',
  rows: ['NVDA', 'AAPL', 'GOOGL', 'MSFT', 'AMZN', 'META', 'AVGO', 'TSLA', 'BRK.B', 'LLY']
    .map((ticker, index) => ({ ticker, rank: index + 1, weightPct: index >= 8 ? null : 10 - index, marketCap: { value: (10 - index) * 1e12, scope: 'company' }, quote: null })),
});

class FakeWorker extends EventEmitter {
  constructor() {
    super();
    this.terminateCalls = 0;
  }
  terminate() {
    this.terminateCalls += 1;
    return Promise.resolve(0);
  }
}

function harness(options = {}) {
  const workers = [];
  const starts = [];
  const diagnostics = [];
  const service = createSp500ContributorsWorkerService({
    workerFactory: (filename, workerOptions) => {
      const worker = new FakeWorker();
      starts.push({ filename, options: workerOptions });
      workers.push(worker);
      return worker;
    },
    onDiagnostic: value => diagnostics.push(value),
    ...options,
  });
  return { service, workers, starts, diagnostics };
}

test('concurrent requests share one worker and return the original verified source observation', async () => {
  const { service, workers, starts } = harness();
  const first = service.getSnapshot();
  assert.equal(service.getSnapshot(), first);
  assert.equal(workers.length, 1);
  assert.match(starts[0].filename, /sp500ContributorsWorker\.cjs$/);
  assert.deepEqual(starts[0].options.workerData, { sourceTimeoutMs: 8000, sourceOverallTimeoutMs: 26000, momoSnapshot: null });
  assert.deepEqual(starts[0].options.execArgv, []);
  const observed = snapshot();
  workers[0].emit('message', { type: 'snapshot', snapshot: observed });
  assert.equal(await first, observed);
  assert.equal(workers[0].terminateCalls, 1);
  assert.equal(workers[0].listenerCount('message'), 0);
  assert.equal(workers[0].listenerCount('exit'), 0);
});

test('each completed request is followed by a fresh worker and never returns the previous snapshot on failure', async () => {
  const { service, workers } = harness();
  const first = service.getSnapshot();
  workers[0].emit('message', { type: 'snapshot', snapshot: snapshot() });
  assert.equal((await first).status, 'available');
  const second = service.getSnapshot();
  assert.equal(workers.length, 2);
  workers[1].emit('message', { type: 'snapshot', snapshot: { status: 'unavailable', rows: [] } });
  assert.deepEqual(await second, { status: 'unavailable', rows: [] });
  assert.equal(workers[1].terminateCalls, 1);
});

test('provider unavailability terminates the worker and forwards only safe diagnostic fields', async () => {
  const { service, workers, diagnostics } = harness();
  const pending = service.getSnapshot();
  workers[0].emit('message', { type: 'diagnostic', diagnostic: {
    stage: 'index:body', code: 'SOURCE_TIMEOUT', elapsedMs: 8001, privateBody: 'do not log', asOf: '2026-09-14',
  } });
  workers[0].emit('message', { type: 'diagnostic', diagnostic: { stage: 'index:body', code: 'SOURCE_TIMEOUT' } });
  workers[0].emit('message', { type: 'snapshot', snapshot: { status: 'unavailable', rows: [] } });
  assert.equal((await pending).status, 'unavailable');
  assert.equal(workers[0].terminateCalls, 1);
  assert.deepEqual(diagnostics, [{ status: 'unavailable', stage: 'index:body', code: 'SOURCE_TIMEOUT', elapsedMs: 8001, asOf: '2026-09-14' }]);
});

for (const failure of ['error', 'exit', 'invalid']) {
  test(`${failure} worker failure cleans up and permits a fresh successful retry`, async () => {
    const { service, workers, diagnostics } = harness();
    const failed = service.getSnapshot();
    if (failure === 'error') workers[0].emit('error', new Error('PRIVATE_ERROR_TEXT'));
    else if (failure === 'exit') workers[0].emit('exit', 1);
    else workers[0].emit('message', { type: 'snapshot', snapshot: { status: 'available', rows: [] } });
    assert.deepEqual((await failed).rows, []);
    assert.equal(workers[0].terminateCalls, 1);
    assert.equal(JSON.stringify(diagnostics).includes('PRIVATE_ERROR_TEXT'), false);
    const next = service.getSnapshot();
    workers[1].emit('message', { type: 'snapshot', snapshot: snapshot() });
    assert.equal((await next).status, 'available');
    assert.equal(workers[1].terminateCalls, 1);
  });
}

test('watchdog terminates a silent worker, releases inFlight, and ignores a late result', async () => {
  const { service, workers, diagnostics } = harness({ workerTimeoutMs: 15 });
  const pending = service.getSnapshot();
  assert.equal(service.getSnapshot(), pending);
  assert.equal((await pending).status, 'unavailable');
  assert.equal(workers[0].terminateCalls, 1);
  assert.equal(diagnostics[0].code, 'WORKER_TIMEOUT');
  workers[0].emit('message', { type: 'snapshot', snapshot: snapshot() });
  workers[0].emit('error', new Error('Late shutdown error'));
  const next = service.getSnapshot();
  workers[1].emit('message', { type: 'snapshot', snapshot: snapshot() });
  assert.equal((await next).status, 'available');
  assert.equal(workers.length, 2);
});

test('worker construction failure returns unavailable and later construction is retried', async () => {
  let attempts = 0;
  const worker = new FakeWorker();
  const { service } = harness({ workerFactory: () => {
    attempts += 1;
    if (attempts === 1) throw new Error('Cannot start worker');
    return worker;
  } });
  assert.equal((await service.getSnapshot()).status, 'unavailable');
  const next = service.getSnapshot();
  worker.emit('message', { type: 'snapshot', snapshot: snapshot() });
  assert.equal((await next).status, 'available');
  assert.equal(attempts, 2);
});

test('termination and diagnostic failures do not leave the request pending', async () => {
  const { service, workers } = harness({ onDiagnostic: () => { throw new Error('Logger failed'); } });
  const pending = service.getSnapshot();
  workers[0].terminate = () => Promise.reject(new Error('Already gone'));
  workers[0].emit('error', new Error('Worker failed'));
  assert.equal((await pending).status, 'unavailable');
});

test('a real worker completes source work while the calling event loop is blocked, then terminates', async () => {
  let ready;
  let exited;
  let nativeWorker;
  const workerReady = new Promise(resolve => { ready = resolve; });
  const workerExited = new Promise(resolve => { exited = resolve; });
  const service = createSp500ContributorsWorkerService({
    workerTimeoutMs: 2000,
    onDiagnostic: diagnostic => { if (diagnostic.code === 'READY') ready(); },
    workerFactory: () => {
      // The fixture and eval script exist only in this test. Production always
      // runs the fixed worker file against its verified provider service.
      nativeWorker = new Worker(`
        const { parentPort, workerData } = require('node:worker_threads');
        parentPort.postMessage({ type: 'diagnostic', diagnostic: { stage: 'worker', code: 'READY' } });
        setTimeout(() => parentPort.postMessage({ type: 'snapshot', snapshot: {
          ...workerData.snapshot, workerCompletedAt: Date.now()
        } }), 100);
      `, { eval: true, workerData: { snapshot: snapshot() } });
      nativeWorker.once('exit', exited);
      return nativeWorker;
    },
  });
  const pending = service.getSnapshot();
  await workerReady;
  const blockedAt = Date.now();
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
  const resumedAt = Date.now();
  const result = await pending;
  assert.equal(result.status, 'available');
  assert.ok(result.workerCompletedAt > blockedAt && result.workerCompletedAt < resumedAt,
    'Worker work should finish during the main-thread pause.');
  await workerExited;
  assert.equal(nativeWorker.threadId, -1);
});


test('passes current MOMO evidence into worker and separates overlapping publication revisions', async () => {
  const { service, starts, workers } = harness();
  const publication = { snapshotType: 'momo-tracker', date: '2026-09-14', data: { SNOW: {} } };
  const earlier = service.getSnapshot();
  const current = service.getSnapshot({ momoSnapshot: publication });
  assert.notEqual(earlier, current);
  assert.equal(starts[1].options.workerData.momoSnapshot, publication);
  assert.equal(service.getSnapshot({ momoSnapshot: publication }), current);
  workers[0].emit('message', { type: 'snapshot', snapshot: snapshot() });
  workers[1].emit('message', { type: 'snapshot', snapshot: snapshot() });
  await Promise.all([earlier, current]);
});

test('rejects incomplete or incorrectly ordered company ranks from workers', async () => {
  for (const mutate of [
    value => { value.rows[0].marketCap = null; },
    value => { value.rows.reverse(); },
    value => { value.rows[0].ticker = 'GOOG'; },
    value => { value.ranking = 'index-weight'; },
  ]) {
    const { service, workers } = harness();
    const pending = service.getSnapshot();
    const value = snapshot();
    mutate(value);
    workers[0].emit('message', { type: 'snapshot', snapshot: value });
    assert.equal((await pending).status, 'unavailable');
  }
});
