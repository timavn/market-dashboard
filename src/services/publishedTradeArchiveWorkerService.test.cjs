'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Worker } = require('node:worker_threads');
const { createPublishedTradeArchiveWorkerService, validReadings, validStatements } = require('./publishedTradeArchiveWorkerService.cjs');
const reading = (fields = {}) => ({ ticker: 'CRB', sourceTicker: 'CRB', value: 'BULLISH', field: 'trade',
  sourceProduct: 'early-look', sourceLabel: 'Early Look', date: '2026-08-18', publishedAt: null,
  sourceUrl: 'https://app.hedgeye.com/feed_items/186089', qualityStatus: 'validated',
  signalProvenance: { field: 'trade', sourceField: 'article.bodyText', method: 'explicit-statement', sourceText: 'CRB is BULLISH TRADE.' },
  ...fields });

class FakeWorker extends EventEmitter {
  messages = [];
  terminateCalls = 0;
  refs = 0;
  postMessage(message) { this.messages.push(message); }
  terminate() { this.terminateCalls++; return Promise.resolve(0); }
  ref() { this.refs++; }
  unref() { this.refs--; }
  ready() { this.emit('message', { type: 'ready' }); }
  respond(readings, request = this.messages.at(-1)) { this.emit('message', { type: 'readings', id: request.id, readings }); }
}
function harness(t, options = {}) {
  const workers = [];
  const starts = [];
  const diagnostics = [];
  const service = createPublishedTradeArchiveWorkerService({
    workerFactory(filename, workerOptions) { const worker = new FakeWorker(); workers.push(worker); starts.push({ filename, options: workerOptions }); return worker; },
    onDiagnostic: value => diagnostics.push(value), ...options,
  });
  t.after(() => service.dispose());
  return { service, workers, starts, diagnostics };
}

test('shares one persistent worker and one cold request, preserving publication dates and evidence', async (t) => {
  const { service, workers, starts } = harness(t, { region: 'us-west-1', indexName: 'test-index', referencePath: '/tmp/research.json' });
  const first = service.load({ date: '2026-09-26' });
  const earlier = service.load({ date: '2026-08-01' });
  assert.equal(workers.length, 1);
  assert.equal(workers[0].messages.length, 0);
  workers[0].ready();
  assert.deepEqual(workers[0].messages, [{ type: 'load', id: 1, waitForRefresh: false }]);
  workers[0].respond([reading()]);
  assert.deepEqual(await first, [reading()]);
  assert.deepEqual(await earlier, []);
  assert.match(starts[0].filename, /publishedTradeArchiveWorker\.cjs$/);
  assert.equal(starts[0].options.workerData.indexName, 'test-index');
  assert.equal(starts[0].options.workerData.referencePath, '/tmp/research.json');
  assert.deepEqual(starts[0].options.execArgv, []);
  assert.equal(workers[0].terminateCalls, 0);
  const next = service.load({ waitForRefresh: true });
  assert.equal(workers.length, 1);
  workers[0].respond([reading()]);
  assert.deepEqual(await next, [reading()]);
});

test('serves retained dated evidence during a refresh and replaces it only on a validated response', async (t) => {
  const { service, workers } = harness(t);
  const first = service.load();
  workers[0].ready(); workers[0].respond([reading()]); await first;
  assert.deepEqual(await service.load(), [reading()]);
  assert.deepEqual(await service.load(), [reading()]);
  assert.equal(workers[0].messages.length, 2, 'Background requests are deduplicated.');
  const changed = reading({ value: 'BEARISH', date: '2026-09-25', sourceUrl: 'https://app.hedgeye.com/feed_items/187500',
    signalProvenance: { ...reading().signalProvenance, sourceText: 'CRB is BEARISH TRADE.' } });
  workers[0].respond([changed]);
  assert.deepEqual(await service.load(), [changed]);
  workers[0].respond([]);
  assert.deepEqual(await service.load(), [], 'An explicit validated revocation is respected.');
  workers[0].respond([]);
});

for (const failure of ['error', 'exit', 'invalid']) {
  test(`${failure} retains verified publications, protects diagnostics and backs off before restarting`, async (t) => {
    let now = 1000;
    const { service, workers, diagnostics } = harness(t, { now: () => now });
    const first = service.load();
    workers[0].ready(); workers[0].respond([reading()]); await first;
    const pending = service.load({ waitForRefresh: true });
    if (failure === 'error') workers[0].emit('error', new Error('PRIVATE_SOURCE_CONTENT'));
    if (failure === 'exit') workers[0].emit('exit', 1);
    if (failure === 'invalid') workers[0].respond([reading({ mock: true })]);
    assert.deepEqual(await pending, [reading()]);
    assert.deepEqual(await service.load(), [reading()]);
    assert.equal(workers.length, 1);
    assert.equal(workers[0].terminateCalls, 1);
    assert.equal(JSON.stringify(diagnostics).includes('PRIVATE_SOURCE_CONTENT'), false);
    workers[0].emit('error', new Error('Late shutdown error'));
    now = 7000;
    const restarted = service.load({ waitForRefresh: true });
    assert.equal(workers.length, 2);
    workers[1].ready(); workers[1].respond([reading()]);
    assert.deepEqual(await restarted, [reading()]);
  });
}

test('times out a silent cold worker, releases requests and safely ignores its late response', async (t) => {
  const { service, workers, diagnostics } = harness(t, { workerTimeoutMs: 15 });
  const pending = service.load();
  assert.deepEqual(await pending, []);
  assert.equal(workers[0].terminateCalls, 1);
  workers[0].emit('message', { type: 'readings', id: 1, readings: [reading()] });
  assert.deepEqual(await service.load(), []);
  assert.deepEqual(diagnostics, [{ stage: 'worker', code: 'WORKER_TIMEOUT' }]);
});

test('construction errors and disposal resolve requests without leaking errors or leaving a worker alive', async (t) => {
  const failed = harness(t, { workerFactory: () => { throw new Error('PRIVATE_CREDENTIAL_ERROR'); } });
  assert.deepEqual(await failed.service.load(), []);
  assert.deepEqual(failed.diagnostics, [{ stage: 'worker', code: 'WORKER_START_FAILED' }]);
  const { service, workers } = harness(t);
  const pending = service.load();
  service.dispose();
  assert.deepEqual(await pending, []);
  assert.equal(workers[0].terminateCalls, 1);
  assert.deepEqual(await service.load(), []);
});

test('rejects fabricated, unproven and invalid-date publications at the worker boundary', () => {
  assert.equal(validReadings([reading()]), true);
  for (const fields of [{ signalProvenance: null }, { sourceUrl: 'https://example.com/source' },
    { date: '2026-02-30' }, { qualityStatus: 'unknown' }, { sourceProduct: null },
    { mock: true }, { seeded: true }, { stale: true }, { cacheOnly: true }, { offline: true },
    { signalProvenance: { ...reading().signalProvenance, field: 'trend' } }]) {
    assert.equal(validReadings([reading(fields)]), false, JSON.stringify(fields));
  }
});

test('CPU-bound archive work runs in a native worker while the API event loop remains responsive', { timeout: 4000 }, async (t) => {
  let signalBusy;
  const busy = new Promise(resolve => { signalBusy = resolve; });
  const { service } = harness(t, { workerTimeoutMs: 3000, workerFactory: () => {
    // Test-only fixture; production always executes the fixed archive worker.
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      parentPort.on('message', message => {
        parentPort.postMessage({ type: 'busy' });
        const until = Date.now() + 300;
        while (Date.now() < until) { JSON.parse('{"source":"original publication"}'); }
        parentPort.postMessage({ type: 'readings', id: message.id, readings: [workerData] });
      });
      parentPort.postMessage({ type: 'ready' });
    `, { eval: true, workerData: reading() });
    worker.on('message', message => { if (message.type === 'busy') signalBusy(); });
    return worker;
  } });
  let completed = false;
  const pending = service.load().then(result => { completed = true; return result; });
  await busy;
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(completed, false, 'The API loop handles timers while the archive is still computing.');
  assert.deepEqual(await pending, [reading()]);
});

test('status reports when the archive last read every source, not when the worker last replied', async (t) => {
  const { service, workers } = harness(t);
  assert.deepEqual(service.status(), { refreshedAt: null, retrying: false });
  const first = service.load();
  workers[0].ready();
  workers[0].emit('message', { type: 'readings', id: workers[0].messages.at(-1).id, readings: [reading()] });
  await first;
  assert.equal(service.status().refreshedAt, null, 'a reply without a verified read is not current');
  const second = service.load({ waitForRefresh: true });
  workers[0].emit('message', { type: 'readings', id: workers[0].messages.at(-1).id, readings: [reading()], verifiedAt: Date.parse('2026-10-31T14:58:00Z') });
  await second;
  assert.equal(service.status().refreshedAt, '2026-10-31T14:58:00.000Z');
});

test('serves the reference Trade, stated Trend and Alpha Codes of the same reply, re-checked from their clauses', async (t) => {
  const { service, workers } = harness(t);
  const source = { sourceProduct: 'early-look', date: '2026-11-02', sourceUrl: 'https://app.hedgeye.com/feed_items/189309', qualityStatus: 'validated' };
  const trend = { ...source, ticker: 'UST2Y', sourceTicker: 'UST2Y', field: 'trend', value: 'BULLISH',
    sourceText: 'UST 2yr Yield down -11 basis points last week to Signal Bearish TRADE, but Bullish TREND',
    signalProvenance: { field: 'trend', sourceField: 'article.bodyText', method: 'explicit-statement',
      sourceText: 'UST 2yr Yield down -11 basis points last week to Signal Bearish TRADE, but Bullish TREND' } };
  const alpha = { ...source, ticker: 'CL', sourceTicker: 'CL', field: 'alphaCode', sourceText: 'Oil’s (WTI) Alpha Code = 9791 (TRADE = $97, TREND = $91)',
    levels: { raw: '9791', trade: 97, trend: 91, unit: '$', basis: 'printed-levels' } };
  const unread = { ...source, statement: 'Alpha Code for KOSPI runs 6265' };
  const statements = { references: [], trends: [trend], alphaCodes: [alpha], flipLines: [], unreadAlphaCodes: [unread] };
  assert.equal(validStatements(statements), true);
  assert.equal(validStatements({ ...statements, trends: [{ ...trend, value: 'BEARISH' }] }), false, 'the clause says Bullish TREND');
  assert.equal(validStatements({ ...statements, alphaCodes: [{ ...alpha, mock: true }] }), false);
  const pending = service.loadStatements({ date: '2026-11-02' });
  workers[0].ready();
  workers[0].emit('message', { type: 'readings', id: workers[0].messages.at(-1).id, readings: [], statements });
  assert.deepEqual(await pending, statements);
  assert.deepEqual(await service.loadStatements({ date: '2026-11-01' }), { references: [], trends: [], alphaCodes: [], flipLines: [], unreadAlphaCodes: [] });
});
