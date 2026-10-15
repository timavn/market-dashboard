'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Worker } = require('node:worker_threads');
const { createSecurityIntelligenceWorkerService } = require('./securityIntelligenceWorkerService.cjs');
const { buildSecurityIntelligence, manifestChecksumForArtifacts } = require('../utils/securityIntelligence.cjs');
const { buildSecurityIntelligenceV2 } = require('../utils/securityIntelligenceV2.cjs');

const NOW = new Date('2026-10-06T18:00:00Z');
const DAY = '2026-10-06';

function input(version = 2, extra = {}) {
  return { version, symbols: ['SPX', 'RUT', 'BTC'], marketDate: DAY, now: NOW,
    historyDays: 5, entityEvents: [], productManifests: [], snapshotsByType: {},
    loadErrors: { entityEvents: 'unavailable' }, publishedTradeReadings: [], ...extra };
}

function result(version = 2, extra = {}) {
  return { schemaVersion: version, generatedAt: NOW.toISOString(), requestedSymbols: [], bySymbol: {}, ...extra };
}

class FakeWorker extends EventEmitter {
  constructor() { super(); this.messages = []; this.terminateCalls = 0; this.unrefCalls = 0; }
  postMessage(message) { this.messages.push(structuredClone(message)); }
  ref() {}
  unref() { this.unrefCalls += 1; }
  terminate() { this.terminateCalls += 1; return Promise.resolve(0); }
  ready() { this.emit('message', { type: 'ready' }); }
  reply(index = 0, value = result(this.messages[index]?.input?.version)) {
    this.emit('message', { type: 'result', id: this.messages[index].id, value });
  }
}

function harness(extra = {}) {
  const workers = [];
  const starts = [];
  const diagnostics = [];
  let clock = NOW.getTime();
  const service = createSecurityIntelligenceWorkerService({
    workerFactory: (filename, options) => { const worker = new FakeWorker(); workers.push(worker); starts.push({ filename, options }); return worker; },
    now: () => clock, onDiagnostic: value => diagnostics.push(value), ...extra,
  });
  return { service, workers, starts, diagnostics, setClock: value => { clock = value; } };
}

test('one persistent worker serializes dispatch and captures request parameters without copying queued research', async () => {
  const h = harness();
  const args = input();
  const first = h.service.build(args);
  const queued = input(1, { entityEvents: [{ sourceEventId: 'captured-source' }] });
  const second = h.service.build(queued);
  args.symbols.push('MUTATED');
  queued.marketDate = '2099-12-31';
  queued.symbols.push('MUTATED');
  queued.entityEvents = [{ sourceEventId: 'replacement-source' }];
  const worker = h.workers[0];
  assert.equal(h.workers.length, 1);
  assert.equal(worker.messages.length, 0);
  worker.ready();
  assert.equal(worker.messages.length, 1);
  assert.deepEqual(worker.messages[0].input.symbols, ['SPX', 'RUT', 'BTC']);
  // A response for an undispatched request cannot complete the queued work.
  worker.emit('message', { type: 'result', id: 2, value: result(1) });
  assert.equal(worker.messages.length, 1);
  worker.reply(0, result(2, { marker: 'first' }));
  assert.equal(worker.messages.length, 2);
  assert.equal(worker.messages[1].input.marketDate, DAY);
  assert.deepEqual(worker.messages[1].input.symbols, ['SPX', 'RUT', 'BTC']);
  assert.equal(worker.messages[1].input.entityEvents[0].sourceEventId, 'captured-source');
  worker.reply(1, result(1, { marker: 'second' }));
  assert.equal((await first).marker, 'first');
  assert.equal((await second).marker, 'second');
  const third = h.service.build(input());
  assert.equal(worker.messages.length, 3);
  worker.reply(2);
  await third;
  assert.match(h.starts[0].filename, /securityIntelligenceWorker\.cjs$/);
  assert.deepEqual(h.starts[0].options.execArgv, []);
  assert.equal(h.starts[0].options.resourceLimits.maxOldGenerationSizeMb, 512);
  assert.ok(worker.unrefCalls >= 3);
  await h.service.close();
  assert.equal(worker.terminateCalls, 1);
});

test('bounded queue rejects excess work immediately and admits requests when capacity is released', async () => {
  const h = harness({ maxQueued: 1 });
  const first = h.service.build(input());
  const second = h.service.build(input());
  await assert.rejects(h.service.build(input()), { code: 'SECURITY_INTELLIGENCE_WORKER_BUSY' });
  assert.equal(h.workers[0].messages.length, 0);
  h.workers[0].ready();
  assert.equal(h.workers[0].messages.length, 1);
  h.workers[0].reply(0);
  await first;
  const third = h.service.build(input());
  h.workers[0].reply(1);
  h.workers[0].reply(2);
  await Promise.all([second, third]);
  await h.service.close();
});

for (const event of ['error', 'exit', 'invalid']) {
  test(`${event} fails closed, rejects all waiting requests and restarts only after backoff`, async () => {
    const h = harness();
    const pending = Promise.allSettled([h.service.build(input()), h.service.build(input(1))]);
    const worker = h.workers[0];
    worker.ready();
    if (event === 'error') worker.emit('error', new Error('Private publication detail'));
    else if (event === 'exit') worker.emit('exit', 1);
    else worker.reply(0, result(1));
    const failed = await pending;
    assert.ok(failed.every(row => row.status === 'rejected'));
    assert.ok(failed.every(row => row.reason.statusCode === 503));
    assert.equal(worker.terminateCalls, 1);
    assert.equal(JSON.stringify(h.diagnostics).includes('Private publication detail'), false);
    await assert.rejects(h.service.build(input()), { code: 'SECURITY_INTELLIGENCE_WORKER_UNAVAILABLE' });
    h.setClock(NOW.getTime() + 1_000);
    const retry = h.service.build(input());
    assert.equal(h.workers.length, 2);
    h.workers[1].ready();
    h.workers[1].reply();
    await retry;
    worker.emit('error', new Error('Late native error'));
    await h.service.close();
  });
}

test('deadline includes worker startup and queue time; late messages cannot restore results', async () => {
  const h = harness({ workerTimeoutMs: 15 });
  const pending = Promise.allSettled([h.service.build(input()), h.service.build(input())]);
  const failed = await pending;
  assert.ok(failed.every(row => row.reason.code === 'SECURITY_INTELLIGENCE_WORKER_TIMEOUT'));
  h.workers[0].ready();
  h.workers[0].emit('message', { type: 'result', id: 1, value: result() });
  await assert.rejects(h.service.build(input()), { code: 'SECURITY_INTELLIGENCE_WORKER_UNAVAILABLE' });
  await h.service.close();
});

test('projection failure rejects only its request without returning an older result or breaking siblings', async () => {
  const h = harness();
  const first = h.service.build(input());
  h.workers[0].ready();
  h.workers[0].reply();
  await first;
  const pending = Promise.allSettled([h.service.build(input()), h.service.build(input())]);
  h.workers[0].emit('message', { type: 'failure', id: h.workers[0].messages[1].id, code: 'private-source-error' });
  h.workers[0].reply(2);
  const [failed, successful] = await pending;
  assert.equal(failed.reason.code, 'SECURITY_INTELLIGENCE_BUILD_FAILED');
  assert.equal(successful.status, 'fulfilled');
  assert.equal(h.workers[0].terminateCalls, 0);
  await h.service.close();
});

test('invalid inputs, construction and clone failures, and close leave no pending request or blocking fallback', async () => {
  const bad = harness();
  for (const args of [null, [], input(3)]) await assert.rejects(bad.service.build(args), { code: 'SECURITY_INTELLIGENCE_INPUT_INVALID' });
  assert.equal(bad.workers.length, 0);
  await bad.service.close();
  const startFailure = harness({ workerFactory: () => { throw new Error('Private runtime failure'); }, onDiagnostic: () => { throw new Error('Logging failed'); } });
  await assert.rejects(startFailure.service.build(input()), { code: 'SECURITY_INTELLIGENCE_WORKER_START_FAILED' });
  await startFailure.service.close();
  const cloneFailure = harness();
  const failedClone = assert.rejects(cloneFailure.service.build(input(2, { cannotClone: () => {} })), { code: 'SECURITY_INTELLIGENCE_WORKER_REQUEST_FAILED' });
  cloneFailure.workers[0].ready();
  await failedClone;
  await cloneFailure.service.close();
  const closing = harness();
  const pending = Promise.allSettled([closing.service.build(input()), closing.service.build(input())]);
  const closed = closing.service.close();
  assert.equal(closing.service.close(), closed);
  await closed;
  assert.ok((await pending).every(row => row.reason.code === 'SECURITY_INTELLIGENCE_WORKER_CLOSED'));
  await assert.rejects(closing.service.build(input()), { code: 'SECURITY_INTELLIGENCE_WORKER_CLOSED' });
});

test('actual worker exactly matches both existing projections, including conflicting research and dated Trade', async () => {
  const service = createSecurityIntelligenceWorkerService();
  try {
    const artifacts = [{ artifactId: 'exact-source', stage: 'indexed', eventCount: 1,
      parserVersion: 'security-intelligence-v2', contentSha256: 'source-hash',
      sourceQuality: { revision: 'quality-1', status: 'discrepancy' } }];
    const params = input(2, {
      scope: 'universe', limit: 200, cursor: '0', loadErrors: {},
      productManifests: [{ marketDate: DAY, productKey: 'early-look', schemaVersion: 1,
        state: 'indexed', parserVersion: 'security-intelligence-v2', artifactCount: 1,
        receivedCount: 1, parsedCount: 1, validatedCount: 1, indexedCount: 1,
        entityEventCount: 1, manifestChecksum: manifestChecksumForArtifacts(artifacts), artifacts }],
      entityEvents: [{ marketDate: DAY, productKey: 'early-look', entityKey: 'ticker#RUT',
        entityType: 'ticker', entityId: 'RUT', eventType: 'supplemental_risk_range',
        contentSha256: 'source-hash', sourceEventId: 'source-hash', matchType: 'structured_membership',
        sourceQualityRevision: 'quality-1', excerpt: 'RUT: {"lrr":2834,"hrr":2825,"trend":"BULLISH"}',
        publishedAt: `${DAY}T13:00:00Z`, signalValue: 'BULLISH' }],
      publishedTradeReadings: [{ ticker: 'BTC', sourceTicker: 'BTC', value: 'BULLISH',
        date: '2026-10-05', publishedAt: '2026-10-05T13:00:00Z', sourceProduct: 'bitcoin-trend-tracker',
        sourceUrl: 'https://app.hedgeye.com/feed_items/123', qualityStatus: 'indexed',
        signalProvenance: { field: 'trade', method: 'explicit-field', sourceField: 'data.BTC.trade', sourceText: 'BTC: Trade BULLISH' } }],
    });
    for (const version of [1, 2]) {
      const { version: ignored, ...pureInput } = params;
      const expected = (version === 1 ? buildSecurityIntelligence : buildSecurityIntelligenceV2)(pureInput);
      const actual = await service.build({ ...params, version });
      assert.deepEqual(actual, expected);
      assert.equal(actual.generatedAt, NOW.toISOString());
      assert.equal(actual.marketDate, DAY);
    }
    for (const flag of ['offline', 'stale', 'cacheOnly', 'mock', 'seeded']) {
      const params = input(2, { loadErrors: { entityEvents: flag, productManifests: flag } });
      const { version: ignored, ...pureInput } = params;
      assert.deepEqual(await service.build(params), buildSecurityIntelligenceV2(pureInput));
    }
  } finally { await service.close(); }
});

test('a CPU-bound actual worker permits a main-loop heartbeat before its work finishes', async () => {
  let signalStarted;
  const started = new Promise(resolve => { signalStarted = resolve; });
  const service = createSecurityIntelligenceWorkerService({
    onDiagnostic: () => {},
    workerFactory: () => {
      const worker = new Worker(`
        const { parentPort } = require('node:worker_threads');
        parentPort.postMessage({ type: 'ready' });
        parentPort.on('message', message => {
          parentPort.postMessage({ type: 'ready', started: true });
          const deadline = Date.now() + 10000;
          while (Date.now() < deadline) {}
          parentPort.postMessage({ type: 'result', id: message.id, value: {
            schemaVersion: 2, generatedAt: new Date().toISOString(), requestedSymbols: [], bySymbol: {},
          } });
        });
      `, { eval: true });
      worker.on('message', message => { if (message.started === true) signalStarted(); });
      return worker;
    },
  });
  let settled = false;
  let startupDeadline;
  const pending = service.build(input()).then(value => { settled = true; return value; }, error => { settled = true; return error; });
  try {
    await Promise.race([started, new Promise((resolve, reject) => {
      startupDeadline = setTimeout(() => reject(new Error('Worker did not begin its CPU-bound job')), 5_000);
    })]);
    clearTimeout(startupDeadline);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false, 'Main-loop heartbeat must run while the worker is still busy');
    await service.close();
    assert.equal((await pending).code, 'SECURITY_INTELLIGENCE_WORKER_CLOSED');
  } finally {
    clearTimeout(startupDeadline);
    await service.close();
  }
});
