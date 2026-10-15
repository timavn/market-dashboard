'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Worker } = require('node:worker_threads');
const { createHedgaiResearchWorkerService } = require('./hedgaiResearchWorkerService.cjs');
const { createHedgaiResearchLoader } = require('../routes/hedgaiResearch.cjs');
const { loadReviewedBaseline, buildHedgaiResearch } = require('./hedgaiResearch.cjs');

const INPUT = { asOf: '2026-10-06T21:00:00Z', forceRefresh: true, refreshAfter: 123 };
const result = input => ({ version: 1, product: 'hedgai-signals', asOf: new Date(input.asOf).toISOString(),
  book: { rows: [] }, sources: [], changes: [], reaffirmations: [], unresolvedActions: [],
  marketMatches: [], marketReadings: {}, sourceQuality: { continuity: 'unknown' } });
class FakeWorker extends EventEmitter {
  messages = [];
  postMessage(message) { this.messages.push(message); }
  ref() {}
  unref() {}
  terminate() { this.terminated = true; return Promise.resolve(); }
  complete(extra = {}) {
    const message = this.messages.at(-1);
    this.emit('message', { type: 'result', id: message.id, value: { ...result(message.input), ...extra } });
  }
}
function fixture(t, options = {}) {
  const workers = [];
  const settings = [];
  const service = createHedgaiResearchWorkerService({ ...options, workerFactory: (_filename, workerOptions) => {
    const worker = new FakeWorker(); workers.push(worker); settings.push(workerOptions); return worker;
  } });
  t.after(() => service.close());
  return { service, workers, settings };
}

test('one worker receives only exact capture parameters and region/table settings', async t => {
  const { service, workers, settings } = fixture(t, { region: 'us-west-1', tableName: 'exact-ledger' });
  await assert.rejects(service.loadResearch({ asOf: 'invalid' }), { statusCode: 400 });
  assert.equal(workers.length, 0);
  const input = { ...INPUT };
  const pending = service.loadResearch(input);
  input.asOf = '2027-01-01T00:00:00Z';
  workers[0].emit('message', { type: 'ready' });
  assert.deepEqual(settings[0].workerData, { region: 'us-west-1', tableName: 'exact-ledger' });
  assert.deepEqual(workers[0].messages[0].input, INPUT);
  workers[0].complete();
  assert.deepEqual(await pending, result(INPUT));
});

test('bounded serial queue does not duplicate captures or promote unavailable research', async t => {
  const { service, workers } = fixture(t, { maxQueued: 1 });
  const first = service.loadResearch(INPUT);
  const second = service.loadResearch({ ...INPUT, asOf: '2026-10-06T21:01:00Z' });
  await assert.rejects(service.loadResearch(INPUT), { code: 'HEDGAI_WORKER_BUSY' });
  workers[0].emit('message', { type: 'ready' });
  assert.equal(workers[0].messages.length, 1);
  workers[0].complete({ sourceQuality: { continuity: 'gap', issues: [{ code: 'research-read-unavailable' }] } });
  assert.equal((await first).sourceQuality.continuity, 'gap');
  assert.equal(workers[0].messages.length, 2);
  workers[0].complete(); await second;
});

test('foreign cutoff or malformed response terminates the worker and fails pending captures closed', async t => {
  for (const extra of [{ asOf: '2026-10-07T21:00:00Z' }, { product: 'different' }, { marketReadings: null }]) {
    const { service, workers } = fixture(t);
    const pending = service.loadResearch(INPUT);
    workers[0].emit('message', { type: 'ready' }); workers[0].complete(extra);
    await assert.rejects(pending, { code: 'HEDGAI_WORKER_RESPONSE_INVALID' });
    assert.equal(workers[0].terminated, true);
  }
});

test('worker timeout or crash rejects active and queued captures without rebuilding on the parent', async t => {
  for (const crash of [true, false]) {
    const { service, workers } = fixture(t, { workerTimeoutMs: 20 });
    const pending = Promise.allSettled([service.loadResearch(INPUT), service.loadResearch(INPUT)]);
    workers[0].emit('message', { type: 'ready' });
    if (crash) workers[0].emit('error', new Error('failed'));
    const values = await pending;
    assert.ok(values.every(value => value.status === 'rejected'
      && value.reason.code === (crash ? 'HEDGAI_WORKER_ERROR' : 'HEDGAI_WORKER_TIMEOUT')));
    workers[0].complete();
    await assert.rejects(service.loadResearch(INPUT), { code: 'HEDGAI_WORKER_UNAVAILABLE' });
  }
});

test('shutdown prevents late output and future captures', async t => {
  const { service, workers } = fixture(t);
  const pending = Promise.allSettled([service.loadResearch(INPUT), service.loadResearch(INPUT)]);
  await service.close();
  assert.ok((await pending).every(value => value.reason.code === 'HEDGAI_WORKER_CLOSED'));
  workers[0].emit('message', { type: 'ready' });
  await assert.rejects(service.loadResearch(INPUT), { code: 'HEDGAI_WORKER_CLOSED' });
  assert.equal(workers.length, 1);
});

test('worker preserves the complete verified book/cutoff/mappings while parent timers remain responsive', async t => {
  const events = require('../../data/research/hedgai/2026-09-28-email-events.json');
  const original = createHedgaiResearchLoader({ loadEvents: async () => ({ items: events }),
    loadBaseline: loadReviewedBaseline, buildProjection: buildHedgaiResearch });
  const expected = await original(INPUT);
  const awsPath = path.join(__dirname, 'aws/clients.cjs');
  const service = createHedgaiResearchWorkerService({ workerTimeoutMs: 5000,
    workerFactory: (workerPath, options) => new Worker(`
      const { workerData } = require('node:worker_threads');
      class DocumentClient {
        constructor() { this.client = {destroy(){}}; }
        query() { return {promise: async () => {
          const start = Date.now(); while (Date.now() - start < 180) {}
          return {Items: workerData.events};
        }}; }
      }
      require.cache[workerData.awsPath] = {exports:{DynamoDB:{DocumentClient}}};
      require(workerData.workerPath);
    `, { eval: true, workerData: { ...options.workerData, awsPath, workerPath, events } }) });
  t.after(() => service.close());
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 10);
  t.after(() => clearInterval(timer));
  const actual = await service.loadResearch(INPUT);
  assert.deepEqual(actual, expected);
  assert.ok(ticks >= 5, `Only ${ticks} parent timer callbacks ran during worker capture`);
});
