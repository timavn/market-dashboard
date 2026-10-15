'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Worker } = require('node:worker_threads');
const { createMarketDailyWorkerService } = require('./marketDailyWorkerService.cjs');

const NOW = Date.parse('2026-09-22T17:00:00Z');
const snapshot = () => ({
  status: 'available', asOf: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 1_200_000).toISOString(),
  source: 'State Street / Yahoo Finance', sourceUrl: 'https://www.ssga.com/',
  universe: { count: 503 }, coverage: { quotes: 503, total: 503 },
  breadth: { advancing: 300, declining: 203 }, winners: [], losers: [], leadership: {}, outliers: {},
});

class FakeWorker extends EventEmitter {
  constructor() { super(); this.messages = []; this.terminateCalls = 0; this.unrefCalls = 0; }
  postMessage(message) { this.messages.push(message); }
  ref() {}
  unref() { this.unrefCalls += 1; }
  terminate() { this.terminateCalls += 1; return Promise.resolve(0); }
  reply(value) { this.emit('message', { type: 'snapshot', id: this.messages.at(-1)?.id, snapshot: value }); }
}

function harness(options = {}) {
  let clock = NOW;
  const workers = [];
  const starts = [];
  const diagnostics = [];
  const service = createMarketDailyWorkerService({
    workerFactory: (filename, workerOptions) => {
      const worker = new FakeWorker();
      workers.push(worker);
      starts.push({ filename, options: workerOptions });
      return worker;
    },
    now: () => clock, referencePath: null, onDiagnostic: value => diagnostics.push(value), ...options,
  });
  return { service, workers, starts, diagnostics, setClock: value => { clock = value; } };
}

test('coalesces calls, waits for ready, and keeps the same worker after each response', async () => {
  const h = harness();
  const first = h.service.getSnapshot();
  assert.equal(h.service.getSnapshot(), first);
  assert.equal(h.workers.length, 1);
  const worker = h.workers[0];
  assert.equal(worker.messages.length, 0);
  worker.emit('message', { type: 'ready' });
  assert.equal(worker.messages.length, 1);
  worker.reply({ status: 'unavailable', loading: true });
  assert.deepEqual(await first, { status: 'unavailable', loading: true });
  const second = h.service.getSnapshot();
  const observed = snapshot();
  worker.reply(observed);
  assert.equal((await second).asOf, observed.asOf);
  assert.equal(h.workers.length, 1);
  assert.equal(worker.terminateCalls, 0);
  assert.ok(worker.unrefCalls >= 3);
  assert.match(h.starts[0].filename, /marketDailyWorker\.cjs$/);
  assert.equal(h.starts[0].options.resourceLimits.maxOldGenerationSizeMb, 256);
  assert.deepEqual(h.starts[0].options.execArgv, []);
  h.service.dispose();
  assert.equal(worker.terminateCalls, 1);
});

test('a later unavailable response retains the preceding verified informational reading', async () => {
  const h = harness();
  const first = h.service.getSnapshot();
  h.workers[0].emit('message', { type: 'ready' });
  h.workers[0].reply(snapshot());
  await first;
  const next = h.service.getSnapshot();
  h.workers[0].reply({ status: 'unavailable', loading: false, winners: [{ ticker: 'UNVERIFIED' }] });
  const retained = await next;
  assert.equal(retained.retained, true);
  assert.equal(retained.asOf, snapshot().asOf);
  assert.deepEqual(retained.winners, []);
  assert.equal(retained.breadth.advancing, 300);
  h.service.dispose();
});

for (const event of ['error', 'exit', 'invalid']) {
  test(`${event} terminates the worker, backs off, and permits a fresh worker afterward`, async () => {
    const h = harness();
    const first = h.service.getSnapshot();
    const worker = h.workers[0];
    worker.emit('message', { type: 'ready' });
    if (event === 'error') worker.emit('error', new Error('Private provider detail'));
    else if (event === 'exit') worker.emit('exit', 1);
    else worker.reply({ status: 'available', winners: [] });
    assert.deepEqual(await first, { status: 'unavailable', loading: false });
    assert.equal(worker.terminateCalls, 1);
    assert.deepEqual(await h.service.getSnapshot(), { status: 'unavailable', loading: false });
    assert.equal(h.workers.length, 1);
    h.setClock(NOW + 30_000);
    const retry = h.service.getSnapshot();
    h.workers[1].emit('message', { type: 'ready' });
    h.workers[1].reply(snapshot());
    assert.equal((await retry).status, 'available');
    assert.equal(JSON.stringify(h.diagnostics).includes('Private provider detail'), false);
    h.service.dispose();
  });
}

test('a silent worker times out without retained values and ignores late replies', async () => {
  const h = harness({ workerTimeoutMs: 10 });
  const pending = h.service.getSnapshot();
  assert.equal((await pending).status, 'unavailable');
  assert.equal(h.workers[0].terminateCalls, 1);
  h.workers[0].emit('message', { type: 'snapshot', id: 1, snapshot: snapshot() });
  h.workers[0].emit('error', new Error('Late native error'));
  assert.equal((await h.service.getSnapshot()).status, 'unavailable');
  assert.equal(h.diagnostics[0].code, 'WORKER_TIMEOUT');
  h.service.dispose();
});

test('worker failure and backoff retain a verified observation without changing its timestamp', async () => {
  const h = harness({ workerTimeoutMs: 10 });
  const first = h.service.getSnapshot();
  h.workers[0].emit('message', { type: 'ready' });
  h.workers[0].reply(snapshot());
  await first;
  const expiredAt = NOW + 1_200_000;
  h.setClock(expiredAt);
  const failed = await h.service.getSnapshot();
  assert.equal(failed.retained, true);
  assert.equal(failed.breadth.advancing, 300);
  assert.equal(failed.asOf, snapshot().asOf);
  assert.equal((await h.service.getSnapshot()).asOf, snapshot().asOf);
  assert.equal(h.workers.length, 1);
  h.service.dispose();
});

test('out-of-order response identifiers cannot satisfy a newer request', async () => {
  const h = harness();
  const first = h.service.getSnapshot();
  h.workers[0].emit('message', { type: 'ready' });
  h.workers[0].reply({ status: 'unavailable', loading: true });
  await first;
  const second = h.service.getSnapshot();
  h.workers[0].emit('message', { type: 'snapshot', id: 1, snapshot: snapshot() });
  assert.equal(h.service.getSnapshot(), second);
  h.workers[0].reply({ status: 'unavailable', loading: false });
  assert.equal((await second).status, 'unavailable');
  h.service.dispose();
});

test('rejects malformed, mock, seeded, stale and cache-only worker readings', async () => {
  const cases = [
    value => { value.asOf = null; },
    value => { value.losers = null; },
    ...['mock', 'seeded', 'stale', 'cacheOnly', 'offline'].map(flag => value => { value.breadth[flag] = true; }),
  ];
  for (const mutate of cases) {
    const h = harness();
    const pending = h.service.getSnapshot();
    h.workers[0].emit('message', { type: 'ready' });
    const value = snapshot();
    mutate(value);
    h.workers[0].reply(value);
    assert.equal((await pending).status, 'unavailable');
    assert.equal(h.workers[0].terminateCalls, 1);
    h.service.dispose();
  }
});

test('filters diagnostics to safe collection counters and never puts them in snapshots', async () => {
  const h = harness();
  const pending = h.service.getSnapshot();
  h.workers[0].emit('message', { type: 'diagnostic', diagnostic: {
    stage: 'collection', code: 'SNAPSHOT_COMPLETE', dailyCount: 503, elapsedMs: 12000,
    privateResponse: 'secret', ticker: 'AAPL', sourceUrl: 'private-url',
  } });
  h.workers[0].emit('message', { type: 'ready' });
  h.workers[0].reply({ status: 'unavailable', loading: false });
  assert.deepEqual(await pending, { status: 'unavailable', loading: false });
  assert.deepEqual(h.diagnostics, [{ stage: 'collection', code: 'SNAPSHOT_COMPLETE', elapsedMs: 12000, dailyCount: 503 }]);
  h.service.dispose();
});

test('construction, disposal, and diagnostic exceptions cannot leave callers pending', async () => {
  const h = harness({ workerFactory: () => { throw new Error('Cannot construct worker'); }, onDiagnostic: () => { throw new Error('Cannot log'); } });
  assert.equal((await h.service.getSnapshot()).status, 'unavailable');
  h.service.dispose();
  const running = harness();
  const pending = running.service.getSnapshot();
  running.service.dispose();
  assert.equal((await pending).status, 'unavailable');
  assert.equal((await running.service.getSnapshot()).status, 'unavailable');
});

test('a real persistent worker progresses collection while the API event loop is busy', async () => {
  let ready;
  let exited;
  const started = new Promise(resolve => { ready = resolve; });
  const terminated = new Promise(resolve => { exited = resolve; });
  const service = createMarketDailyWorkerService({
    now: () => NOW,
    referencePath: null,
    workerTimeoutMs: 2_000,
    onDiagnostic: diagnostic => { if (diagnostic.code === 'COLLECTION_STARTED') ready(); },
    workerFactory: () => {
      // This fixture lives only in a test worker. Production uses the fixed
      // worker file, real transports, and the verified market-data parsers.
      const worker = new Worker(`
        const { parentPort, workerData } = require('node:worker_threads');
        let current = { status: 'unavailable', loading: true };
        parentPort.on('message', message => parentPort.postMessage({ type: 'snapshot', id: message.id, snapshot: current }));
        parentPort.postMessage({ type: 'ready' });
        parentPort.postMessage({ type: 'diagnostic', diagnostic: { stage: 'collection', code: 'COLLECTION_STARTED' } });
        setTimeout(() => { current = { ...workerData.snapshot, workerCompletedAt: Date.now() }; }, 75);
      `, { eval: true, workerData: { snapshot: snapshot() } });
      worker.once('exit', exited);
      return worker;
    },
  });
  const initial = service.getSnapshot();
  await started;
  await initial;
  const blockedAt = Date.now();
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  const resumedAt = Date.now();
  const current = await service.getSnapshot();
  assert.equal(current.status, 'available');
  assert.ok(current.workerCompletedAt > blockedAt && current.workerCompletedAt < resumedAt);
  service.dispose();
  await terminated;
});
