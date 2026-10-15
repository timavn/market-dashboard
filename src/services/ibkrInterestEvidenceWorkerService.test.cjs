'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { EventEmitter } = require('node:events');
const { createIbkrInterestEvidenceWorkerService } = require('./ibkrInterestEvidenceWorkerService.cjs');
const { createIbkrInterestValidationService, getConfig } = require('./ibkrInterestValidationService.cjs');
const { createInterestValidationStore, contentHash } = require('./ibkrInterestValidationStore.cjs');
const { readPrivateInterestLedger } = require('../../scripts/export_ibkr_interest_ledger.cjs');

const NOW = '2026-10-06T21:00:00.000Z';
class FakeWorker extends EventEmitter {
  messages = [];
  postMessage(message) { this.messages.push(message); }
  ref() {}
  unref() {}
  terminate() { this.terminated = true; return Promise.resolve(); }
  complete(extra = {}) {
    const request = this.messages.at(-1);
    this.emit('message', { type: 'result', id: request.id, operation: request.operation,
      now: request.input.now, value: { flexStatus: {}, summary: null, storedLatestObservation: null }, ...extra });
  }
}
function fakeFixture(t, options = {}) {
  const workers = [];
  const service = createIbkrInterestEvidenceWorkerService({ env: {}, ...options,
    workerFactory: () => { const worker = new FakeWorker(); workers.push(worker); return worker; } });
  t.after(() => service.close());
  return { service, workers };
}
function evidenceFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'interest-evidence-worker-'));
  t.after(() => fs.rmSync(directory, { force: true, recursive: true }));
  const env = { IBKR_INTEREST_VALIDATION_ENABLED: 'true', IBKR_FLEX_EXPECTED_ACCOUNT_ID: 'U1',
    IBKR_INTEREST_VALIDATION_DATA_DIR: directory, IBKR_FLEX_INTEREST_ENABLED: 'true',
    IBKR_FLEX_INTEREST_TOKEN: 'fixture-only', IBKR_FLEX_INTEREST_QUERY_ID: 'fixture-only' };
  const config = getConfig(env);
  const dataDir = path.join(directory, 'accounts', config.accountFingerprint);
  const store = createInterestValidationStore({ dataDir });
  const reportHash = 'a'.repeat(64);
  const revisionId = `2026-10-01_2026-10-05_${reportHash}`;
  const snapshot = { source: 'ibkr_flex_interest_web_service', reportHash,
    expectedAccountFingerprint: config.accountFingerprint, expectedAccountMasked: config.accountMasked,
    fromDate: '2026-10-01', toDate: '2026-10-05', fetchedAt: NOW, revisionId,
    tierDetails: [{ currency: 'USD', interestType: 'Debit Interest', valueDate: '2026-10-05',
      totalPrincipal: -10000, rate: 3.6, totalInterest: -1 }],
    accruals: [], cashTransactions: [], cashReports: [], borrowFeeDetails: [],
    derived: { dailyDebitActuals: [{ date: '2026-10-05', debitAmount: 1, totalInterest: -1, rowCount: 1 }], monthlyPaid: [] } };
  snapshot.revisionHash = contentHash(snapshot);
  const flexDir = path.join(dataDir, 'flex');
  fs.mkdirSync(path.join(flexDir, 'revisions'), { mode: 0o700, recursive: true });
  const revisionPath = path.join(flexDir, 'revisions', `${revisionId}.json`);
  fs.writeFileSync(revisionPath, JSON.stringify(snapshot), { mode: 0o400 });
  fs.writeFileSync(path.join(flexDir, 'latest.json'), JSON.stringify(snapshot), { mode: 0o600 });
  store.writeSummary({ source: 'ibkr_interest_validation', accountFingerprint: config.accountFingerprint,
    available: true, status: 'learning', mtd: {}, guard: {} });
  store.appendRecord('observations', { verified: true, sessionDate: '2026-10-06',
    observedAt: NOW, liveAccruedCash: -3, source: 'ibkr_live_portfolio_balance' });
  return { env, dataDir, store, revisionPath };
}

test('serial worker bounds active and queued fresh reads, and closes without late output', async t => {
  const { service, workers } = fakeFixture(t, { maxQueued: 1 });
  const first = service.readStatus({ now: NOW });
  const second = service.readStatus({ now: NOW });
  await assert.rejects(service.readStatus({ now: NOW }), { code: 'interest_evidence_worker_busy' });
  workers[0].emit('message', { type: 'ready' });
  assert.equal(workers[0].messages.length, 1);
  workers[0].complete(); await first;
  assert.equal(workers[0].messages.length, 2);
  const rejected = assert.rejects(second, { code: 'interest_evidence_worker_closed' });
  await service.close(); await rejected;
  workers[0].complete();
  await assert.rejects(service.readStatus(), { code: 'interest_evidence_worker_closed' });
});

test('crash, timeout and foreign operation fail closed without a synchronous fallback', async t => {
  for (const failure of ['error', 'timeout', 'foreign']) {
    const { service, workers } = fakeFixture(t, { workerTimeoutMs: 25 });
    const pending = Promise.allSettled([service.readStatus({ now: NOW }), service.readStatus({ now: NOW })]);
    workers[0].emit('message', { type: 'ready' });
    if (failure === 'error') workers[0].emit('error', new Error('private error text'));
    if (failure === 'foreign') workers[0].complete({ operation: 'ledger' });
    const expected = failure === 'foreign' ? 'response_invalid' : failure === 'error' ? 'error' : 'timeout';
    assert.ok((await pending).every(result => result.status === 'rejected'
      && result.reason.code === `interest_evidence_worker_${expected}`));
    assert.equal(workers[0].terminated, true);
  }
});

test('fresh worker outputs equal original full status/history/ledger and see appended evidence', async t => {
  const { env, store } = evidenceFixture(t);
  const original = createIbkrInterestValidationService({ env, now: () => new Date(NOW) });
  t.after(() => original.closeEvidenceReader());
  assert.deepEqual(await original.getStatusAsync({ account: 'U1' }), original.getStatus({ account: 'U1' }));
  assert.deepEqual(await original.historyAsync(), original.history());
  assert.deepEqual(await original.readLedgerAsync({ accountId: 'U1' }),
    readPrivateInterestLedger({ env, accountId: 'U1', now: new Date(NOW) }));
  store.appendRecord('observations', { verified: true, sessionDate: '2026-10-06',
    observedAt: '2026-10-06T21:00:01.000Z', liveAccruedCash: -4 });
  assert.equal((await original.historyAsync()).observations.length, 2);
  assert.deepEqual(await original.getStatusAsync({ account: 'U2' }), original.getStatus({ account: 'U2' }));
  await assert.rejects(original.readLedgerAsync({ accountId: 'U2' }),
    { code: 'interest_ledger_account_mismatch', status: 403 });
});

test('every read revalidates journal hashes and never reuses an earlier verified ledger', async t => {
  const { env, dataDir } = evidenceFixture(t);
  const original = createIbkrInterestValidationService({ env, now: () => new Date(NOW) });
  t.after(() => original.closeEvidenceReader());
  assert.equal((await original.readLedgerAsync({ accountId: 'U1' })).available, true);
  const recordPath = path.join(dataDir, 'records', 'observations.jsonl');
  const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
  record.liveAccruedCash = 999;
  fs.writeFileSync(recordPath, `${JSON.stringify(record)}\n`);
  await assert.rejects(original.readLedgerAsync({ accountId: 'U1' }), { code: 'interest_store_integrity_error' });
  await assert.rejects(original.historyAsync(), { code: 'interest_store_integrity_error' });
  const status = await original.getStatusAsync();
  assert.equal(status.mtd.liveNetAccruedStatus, 'unavailable');
  assert.equal(status.error.code, 'interest_store_integrity_error');
});

test('fresh reads revoke a tampered captured Flex revision rather than retaining its prior result', async t => {
  const { env, revisionPath } = evidenceFixture(t);
  const original = createIbkrInterestValidationService({ env, now: () => new Date(NOW) });
  t.after(() => original.closeEvidenceReader());
  assert.equal((await original.getStatusAsync()).flex.status, 'ready');
  assert.equal((await original.readLedgerAsync({ accountId: 'U1' })).available, true);
  const revision = JSON.parse(fs.readFileSync(revisionPath, 'utf8'));
  revision.tierDetails[0].totalPrincipal = -99999;
  fs.chmodSync(revisionPath, 0o600);
  fs.writeFileSync(revisionPath, JSON.stringify(revision));
  const status = await original.getStatusAsync();
  assert.equal(status.flex.status, 'storage_error');
  assert.equal(status.available, false);
  await assert.rejects(original.readLedgerAsync({ accountId: 'U1' }), { code: 'flex_interest_integrity_error' });
});

test('slow exact filesystem validation stays off the HTTP thread while preserving complete ledger output', async t => {
  const { env } = evidenceFixture(t);
  const expected = readPrivateInterestLedger({ env, accountId: 'U1', now: new Date(NOW) });
  const service = createIbkrInterestEvidenceWorkerService({ env, workerTimeoutMs: 5000,
    workerFactory: (workerPath, options) => new Worker(`
      const fs = require('node:fs');
      const { workerData } = require('node:worker_threads');
      const original = fs.readFileSync;
      fs.readFileSync = function(file, ...args) {
        if (String(file).endsWith('observations.jsonl')) {
          const start = Date.now(); while (Date.now() - start < 180) {}
        }
        return original.call(this, file, ...args);
      };
      require(workerData.workerPath);
    `, { eval: true, workerData: { ...options.workerData, workerPath } }) });
  t.after(() => service.close());
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 10);
  t.after(() => clearInterval(timer));
  assert.deepEqual(await service.readLedger({ accountId: 'U1', now: NOW }), expected);
  assert.ok(ticks >= 5, `Only ${ticks} parent callbacks ran during the exact filesystem read`);
});
