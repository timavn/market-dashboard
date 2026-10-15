'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { Worker } = require('node:worker_threads');
const { createPortfolioRefreshResearchWorkerService } = require('./portfolioRefreshResearchWorkerService.cjs');
const INPUT = { symbols: ['TLT', 'SPY'], marketDate: '2026-10-06', asOf: '2026-10-06T21:00:00Z' };
const result = input => ({ schemaVersion: 1, ...input, requestedSymbols: input.symbols,
  bySymbol: Object.fromEntries(input.symbols.map(symbol => [symbol, { references: [] }])),
  referenceOnly: true, executable: false, publications: [], diagnostics: [], coverage: { products: [] },
  manifest: { pages: 1 }, scanComplete: false });
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
  const service = createPortfolioRefreshResearchWorkerService({ ...options, workerFactory: () => {
    const worker = new FakeWorker(); workers.push(worker); return worker;
  } });
  t.after(() => service.close());
  return { service, workers };
}

test('invalid requests never start a provider worker; capture identity is copied and normalized', async t => {
  const { service, workers } = fixture(t);
  await assert.rejects(service.capture({ ...INPUT, symbols: null }), { statusCode: 400 });
  assert.equal(workers.length, 0);
  const input = { ...INPUT, symbols: ['tlt', 'SPY'] };
  const pending = service.capture(input);
  input.symbols[0] = 'QQQ';
  workers[0].emit('message', { type: 'ready' });
  assert.deepEqual(workers[0].messages[0].input.symbols, ['SPY', 'TLT']);
  workers[0].complete();
  assert.deepEqual((await pending).requestedSymbols, ['SPY', 'TLT']);
});

test('only one scan is active and queue capacity fails quietly without replaying jobs', async t => {
  const { service, workers } = fixture(t, { maxQueued: 1 });
  const first = service.capture(INPUT); const second = service.capture(INPUT);
  await assert.rejects(service.capture(INPUT), { code: 'PORTFOLIO_ARCHIVE_WORKER_BUSY' });
  workers[0].emit('message', { type: 'ready' });
  assert.equal(workers[0].messages.length, 1);
  workers[0].complete(); await first;
  assert.equal(workers[0].messages.length, 2);
  workers[0].complete(); await second;
});

test('a captured partial archive remains partial without inventing completeness', async t => {
  const { service, workers } = fixture(t);
  const pending = service.capture(INPUT); workers[0].emit('message', { type: 'ready' });
  workers[0].complete({ coverage: { products: [{ id: 'etf-pro', status: 'partial' }], reasons: ['archive-page-unavailable'] } });
  const value = await pending;
  assert.equal(value.scanComplete, false);
  assert.deepEqual(value.coverage.reasons, ['archive-page-unavailable']);
});

test('wrong dates, symbols or executable responses invalidate the worker', async t => {
  for (const extra of [{ asOf: '2026-10-07T21:00:00Z' }, { bySymbol: { SPY: {} } }, { executable: true }]) {
    const { service, workers } = fixture(t);
    const pending = service.capture(INPUT); workers[0].emit('message', { type: 'ready' }); workers[0].complete(extra);
    await assert.rejects(pending, { code: 'PORTFOLIO_ARCHIVE_RESPONSE_INVALID' });
    assert.equal(workers[0].terminated, true);
  }
});

test('timeout settles active and waiting work; late replies cannot revive a capture', async t => {
  const { service, workers } = fixture(t, { workerTimeoutMs: 15 });
  const results = Promise.allSettled([service.capture(INPUT), service.capture(INPUT)]);
  workers[0].emit('message', { type: 'ready' });
  const values = await results;
  assert.ok(values.every(value => value.status === 'rejected' && value.reason.code === 'PORTFOLIO_ARCHIVE_WORKER_TIMEOUT'));
  workers[0].complete();
  await assert.rejects(service.capture(INPUT), { code: 'PORTFOLIO_ARCHIVE_WORKER_UNAVAILABLE' });
});

test('shutdown rejects queued captures and prevents another worker', async t => {
  const { service, workers } = fixture(t);
  const results = Promise.allSettled([service.capture(INPUT), service.capture(INPUT)]);
  await service.close();
  assert.ok((await results).every(value => value.reason.code === 'PORTFOLIO_ARCHIVE_WORKER_CLOSED'));
  await assert.rejects(service.capture(INPUT), { code: 'PORTFOLIO_ARCHIVE_WORKER_CLOSED' });
  assert.equal(workers.length, 1);
});

test('archive CPU work leaves HTTP timers responsive in the parent', async t => {
  const service = createPortfolioRefreshResearchWorkerService({ workerTimeoutMs: 5000,
    workerFactory: () => new Worker(`
      const {parentPort}=require('node:worker_threads');
      parentPort.on('message',message=>{
        const start=Date.now(); while(Date.now()-start<200){}
        const input=message.input;
        parentPort.postMessage({type:'result',id:message.id,value:{schemaVersion:1,...input,
          requestedSymbols:input.symbols,bySymbol:Object.fromEntries(input.symbols.map(symbol=>[symbol,{references:[]} ])),
          referenceOnly:true,executable:false,publications:[],diagnostics:[],coverage:{products:[]},manifest:{pages:1},scanComplete:true}});
      }); parentPort.postMessage({type:'ready'});`, { eval: true }) });
  t.after(() => service.close());
  let timers = 0;
  const timer = setInterval(() => { timers += 1; }, 10);
  t.after(() => clearInterval(timer));
  assert.equal((await service.capture(INPUT)).scanComplete, true);
  assert.ok(timers >= 5, `Only ${timers} parent timer callbacks ran while archive was busy`);
});
