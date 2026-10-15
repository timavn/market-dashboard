'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { Worker } = require('node:worker_threads');
const { zipSync, strToU8 } = require('fflate');
const readNodeWorkbook = require('read-excel-file/node');
const readUniversalWorkbook = require('read-excel-file/universal');
const { createWorkbookReaderWorkerService, closeWorkbookReaders } = require('./workbookReaderWorkerService.cjs');
const { loadGdpNowHistory, parseGdpNowArchives } = require('./predictionMarketTest/gdpHistoryService.cjs');
const { createLeveragedProductOverlapService, HOLDINGS_SOURCES } = require('./leveragedProductOverlapService.cjs');

const escapeXml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const excelDay = value => (value.getTime() - Date.UTC(1899, 11, 30)) / 86_400_000;

// Test-only OpenXML publications; no network requests or provider fixtures enter
// production. Real ZIP/XML bytes exercise the unchanged installed parsers.
function workbook(sheets) {
  const files = {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/></Types>',
    'xl/workbook.xml': `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((sheet, index) => `<sheet name="${escapeXml(sheet.sheet)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('')}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((sheet, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join('')}<Relationship Id="styles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    'xl/styles.xml': '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>',
  };
  for (const [index, sheet] of sheets.entries()) {
    files[`xl/worksheets/sheet${index + 1}.xml`] = `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheet.data.map((row, rowIndex) => `<row r="${rowIndex + 1}">${row.map((cell, columnIndex) => {
      if (cell == null) return '';
      const ref = `${String.fromCharCode(65 + columnIndex)}${rowIndex + 1}`;
      if (cell instanceof Date) return `<c r="${ref}" s="1"><v>${excelDay(cell)}</v></c>`;
      if (typeof cell === 'number') return `<c r="${ref}"><v>${cell}</v></c>`;
      if (typeof cell === 'boolean') return `<c r="${ref}" t="b"><v>${Number(cell)}</v></c>`;
      return `<c r="${ref}" t="inlineStr"><is><t>${escapeXml(cell)}</t></is></c>`;
    }).join('')}</row>`).join('')}</sheetData></worksheet>`;
  }
  return Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([name, value]) => [name, strToU8(value)]))));
}

const fixture = () => workbook([
  { sheet: 'Published readings', data: [['Ticker', 'Value', 'Observed', 'Verified'], ['A&B', 1.125, new Date('2026-10-06T00:00:00Z'), true], ['RUT', -4.2, null, false]] },
  { sheet: 'Second sheet', data: [['Original source', 99]] },
]);

class FakeWorker extends EventEmitter {
  constructor() { super(); this.messages = []; this.terminateCalls = 0; this.unrefCalls = 0; }
  postMessage(message) { this.messages.push(structuredClone(message)); }
  ref() {}
  unref() { this.unrefCalls += 1; }
  terminate() { this.terminateCalls += 1; return Promise.resolve(0); }
  ready() { this.emit('message', { type: 'ready' }); }
  reply(index = 0, value = [['parsed']]) { this.emit('message', { type: 'result', id: this.messages[index].id, value }); }
}

function harness(options = {}) {
  const workers = [];
  const diagnostics = [];
  let clock = 0;
  const service = createWorkbookReaderWorkerService({ workerFactory: () => {
    const worker = new FakeWorker(); workers.push(worker); return worker;
  }, now: () => clock, onDiagnostic: value => diagnostics.push(value), ...options });
  return { service, workers, diagnostics, setClock: value => { clock = value; } };
}

test('actual persistent worker preserves both parser outputs, sheet options, dates, and original byte hashes', async () => {
  let starts = 0;
  const service = createWorkbookReaderWorkerService({ workerFactory: (filename, options) => {
    starts += 1; return new Worker(filename, options);
  } });
  const bytes = fixture();
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  const framed = Buffer.concat([Buffer.from('prefix'), bytes, Buffer.from('suffix')]);
  const input = framed.subarray(6, 6 + bytes.length);
  try {
    for (const parser of ['node', 'universal']) {
      const direct = parser === 'node' ? readNodeWorkbook : readUniversalWorkbook;
      for (const options of [undefined, { sheet: 'Published readings' }, { sheet: 2 }]) {
        const exactBytes = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        const expected = await direct(parser === 'node' ? bytes : exactBytes, options);
        const actual = await service.read(input, options, parser);
        assert.deepEqual(actual, expected);
        if (!options) assert.ok(actual[0].data[1][2] instanceof Date);
      }
    }
    assert.equal(starts, 1);
    assert.equal(input.length, bytes.length);
    assert.equal(crypto.createHash('sha256').update(input).digest('hex'), hash);
  } finally { await service.close(); }
});

test('queued bytes and options are captured exactly; dispatch is serial and original buffers remain attached', async () => {
  const h = harness();
  const original = new Uint8Array([1, 2, 3, 4]).buffer;
  const options = { sheet: 'Captured' };
  const first = h.service.read(original, options);
  const second = h.service.read(Buffer.from([5, 6]), { sheet: 2 }, 'universal');
  new Uint8Array(original).fill(9);
  options.sheet = 'Changed';
  const worker = h.workers[0];
  worker.ready();
  assert.equal(worker.messages.length, 1);
  assert.deepEqual([...new Uint8Array(worker.messages[0].buffer)], [1, 2, 3, 4]);
  assert.equal(worker.messages[0].options.sheet, 'Captured');
  assert.equal(original.byteLength, 4);
  worker.emit('message', { type: 'result', id: 2, value: [['unsent']] });
  assert.equal(worker.messages.length, 1);
  worker.reply(0);
  assert.equal(worker.messages.length, 2);
  assert.equal(worker.messages[1].parser, 'universal');
  worker.reply(1);
  await Promise.all([first, second]);
  assert.equal(h.workers.length, 1);
  await h.service.close();
});

test('queue and acquired-byte bounds reject excess work and release capacity after settlement', async () => {
  const h = harness({ maxQueued: 1, maxPendingBytes: 4 });
  const first = h.service.read(Buffer.alloc(2));
  const second = h.service.read(Buffer.alloc(2));
  await assert.rejects(h.service.read(Buffer.alloc(0)), { code: 'WORKBOOK_WORKER_BUSY' });
  h.workers[0].ready(); h.workers[0].reply(); await first;
  await assert.rejects(h.service.read(Buffer.alloc(3)), { code: 'WORKBOOK_WORKER_BUSY' });
  const third = h.service.read(Buffer.alloc(2));
  h.workers[0].reply(1); h.workers[0].reply(2);
  await Promise.all([second, third]);
  await h.service.close();
});

test('parser failure retains its exact error and rejects only that request without returning earlier cells', async () => {
  const h = harness();
  const pending = Promise.allSettled([h.service.read(Buffer.alloc(1)), h.service.read(Buffer.alloc(1))]);
  h.workers[0].ready();
  h.workers[0].emit('message', { type: 'failure', id: 1, error: { name: 'TypeError', message: 'Invalid published workbook', code: 'INVALID_XLSX' } });
  h.workers[0].reply(1, [['next source']]);
  const [failed, successful] = await pending;
  assert.equal(failed.reason.name, 'TypeError');
  assert.equal(failed.reason.message, 'Invalid published workbook');
  assert.equal(failed.reason.code, 'INVALID_XLSX');
  assert.deepEqual(successful.value, [['next source']]);
  assert.equal(h.workers[0].terminateCalls, 0);
  await h.service.close();
});

for (const event of ['error', 'exit', 'invalid']) {
  test(`${event} rejects all pending work, emits no source content and restarts after backoff`, async () => {
    const h = harness();
    const pending = Promise.allSettled([h.service.read(Buffer.alloc(1)), h.service.read(Buffer.alloc(1))]);
    const worker = h.workers[0]; worker.ready();
    if (event === 'error') worker.emit('error', new Error('Private source contents'));
    else if (event === 'exit') worker.emit('exit', 1);
    else worker.reply(0, null);
    const failed = await pending;
    assert.ok(failed.every(value => value.status === 'rejected' && value.reason.statusCode === 503));
    assert.equal(worker.terminateCalls, 1);
    assert.equal(JSON.stringify(h.diagnostics).includes('Private source contents'), false);
    await assert.rejects(h.service.read(Buffer.alloc(1)), { code: 'WORKBOOK_WORKER_UNAVAILABLE' });
    h.setClock(1000);
    const retry = h.service.read(Buffer.alloc(1));
    h.workers[1].ready(); h.workers[1].reply(); await retry;
    worker.emit('error', new Error('Late native failure'));
    await h.service.close();
  });
}

test('deadline includes startup and waiting time; shutdown rejects pending work and prevents late restoration', async () => {
  const timed = harness({ workerTimeoutMs: 15 });
  const failed = await Promise.allSettled([timed.service.read(Buffer.alloc(1)), timed.service.read(Buffer.alloc(1))]);
  assert.ok(failed.every(value => value.reason.code === 'WORKBOOK_WORKER_TIMEOUT'));
  timed.workers[0].ready(); timed.workers[0].emit('message', { type: 'result', id: 1, value: [['late']] });
  await timed.service.close();
  const h = harness();
  const pending = Promise.allSettled([h.service.read(Buffer.alloc(1)), h.service.read(Buffer.alloc(1))]);
  const closing = h.service.close();
  assert.equal(h.service.close(), closing);
  await closing;
  assert.ok((await pending).every(value => value.reason.code === 'WORKBOOK_WORKER_CLOSED'));
  await assert.rejects(h.service.read(Buffer.alloc(1)), { code: 'WORKBOOK_WORKER_CLOSED' });
});

test('unsupported input/options and worker start or dispatch failure fail closed without a blocking parser fallback', async () => {
  const h = harness();
  for (const [input, options, parser] of [['file.xlsx'], [Buffer.alloc(1), { schema: { type: () => {} } }], [Buffer.alloc(1), undefined, 'other']]) {
    await assert.rejects(h.service.read(input, options, parser), { code: 'WORKBOOK_INPUT_INVALID' });
  }
  assert.equal(h.workers.length, 0); await h.service.close();
  const startFailure = harness({ workerFactory: () => { throw new Error('Start failed'); } });
  await assert.rejects(startFailure.service.read(Buffer.alloc(1)), { code: 'WORKBOOK_WORKER_START_FAILED' });
  await startFailure.service.close();
  const dispatchFailure = harness();
  const failed = assert.rejects(dispatchFailure.service.read(Buffer.alloc(1)), { code: 'WORKBOOK_WORKER_REQUEST_FAILED' });
  dispatchFailure.workers[0].postMessage = () => { throw new Error('Dispatch failed'); };
  dispatchFailure.workers[0].ready(); await failed; await dispatchFailure.service.close();
});

test('a real large XLSX parse permits a main-loop heartbeat while parsing is in progress', async () => {
  let signalStarted;
  const started = new Promise(resolve => { signalStarted = resolve; });
  const service = createWorkbookReaderWorkerService({ workerFactory: (filename, options) => {
    const worker = new Worker(filename, options);
    worker.on('message', message => { if (message?.type === 'started') signalStarted(); });
    return worker;
  } });
  const bytes = workbook([{ sheet: 'Large source', data: Array.from({ length: 10000 }, (_, index) => [index, 'Exact source field', index / 10, true, 'Independent reading']) }]);
  let finished = false;
  const pending = service.read(bytes).finally(() => { finished = true; });
  try {
    await started;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(finished, false, 'the HTTP event loop runs before XLSX parsing completes');
    const result = await pending;
    assert.equal(result[0].data.length, 10000);
    assert.deepEqual(result[0].data[9999], [9999, 'Exact source field', 999.9, true, 'Independent reading']);
  } finally { await service.close(); }
});

test('GDP and leveraged default readers consume exact bytes while preserving dates, provenance, and failure invalidation', async () => {
  const verifiedAt = '2026-10-06T18:00:00Z';
  const sourceUrl = 'https://www.atlantafed.org/GDPTrackingModelDataAndForecasts.xlsx';
  const bytes = workbook([{ sheet: 'TrackingArchives', data: [
    ['Forecast Date', 'Quarter being forecasted', 'GDP Nowcast'],
    [new Date('2026-07-28'), new Date('2026-06-30'), 1.53997],
  ] }]);
  const originalHash = crypto.createHash('sha256').update(bytes).digest('hex');
  const holdingsBytes = workbook([{ sheet: 'Holdings', data: [
    ['Holdings:', 'As of 06-Oct-2026'], ['Name', 'Ticker', 'Weight'],
    ['Alpha', 'A', 30], ['Charlie', 'C', 70],
  ] }]);
  const csv = 'Fund Holdings as of,"Oct 06, 2026"\nTicker,Name,Type,Sector,Asset Class,Market Value,Weight (%)\nA,Alpha,EQUITY,Financials,Equity,60,60\nB,Beta,EQUITY,Financials,Equity,40,40';
  let failWorkbook = false;
  const fetched = [];
  const service = createLeveragedProductOverlapService({ now: () => new Date(verifiedAt), fetchImpl: async url => {
    fetched.push(url);
    return url === HOLDINGS_SOURCES.IAK.url ? { ok: true, text: async () => csv }
      : { ok: true, arrayBuffer: async () => failWorkbook ? new ArrayBuffer(1) : holdingsBytes.buffer.slice(holdingsBytes.byteOffset, holdingsBytes.byteOffset + holdingsBytes.length) };
  } });
  try {
    const records = await loadGdpNowHistory({ html: `<a href="${sourceUrl}">Archive</a>`, verifiedAt, minQuarter: '2025-Q2', fetchBinary: async url => {
      assert.equal(url, sourceUrl); return bytes;
    } });
    assert.deepEqual(records, parseGdpNowArchives(await readNodeWorkbook(bytes), { sourceUrl, verifiedAt, evidenceSha256: originalHash }, '2025-Q2'));
    assert.equal(records[0].publishedAt, '2026-07-28');
    assert.equal(records[0].evidenceSha256, originalHash);
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), originalHash);
    const overlap = await service.getOverlap({ baseSymbol: 'IAK', referenceSymbol: 'XLF' });
    assert.equal(overlap.available, true); assert.equal(overlap.weightedOverlapPct, 30);
    assert.deepEqual(overlap.sources.map(value => value.url), [HOLDINGS_SOURCES.IAK.url, HOLDINGS_SOURCES.XLF.url]);
    failWorkbook = true;
    const failed = await service.getOverlap({ baseSymbol: 'IAK', referenceSymbol: 'XLF' });
    assert.equal(failed.available, false); assert.equal(failed.weightedOverlapPct, null); assert.equal(failed.fromCache, false);
    assert.equal(fetched.length, 4);
  } finally { await closeWorkbookReaders(); }
});
