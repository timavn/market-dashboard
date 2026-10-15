const test = require('node:test');
const assert = require('node:assert/strict');
const { createContractPnlHistoryStore } = require('./contractPnlHistoryStore.cjs');
const { createContractPnlHistoryService, historyDraft, historyPayload } = require('./contractPnlHistoryService.cjs');
const { loadPerformanceExecutions, reconstructForecastExEconomicRecords } = require('./predictionMarketPerformanceLedger.cjs');

const final = { id: 'gold', conId: 1, status: 'verified', displayState: 'CLOSED',
  verification: 'ibkr_flex_settlement', risked: 4, paid: 5, pnl: 1,
  currentValue: 5, market: 'gold', performanceComplete: true };
const performance = { rows: [final], tracker: {} };
const coverage = { status: 'ready', complete: true, snapshotId: 'report-one', fromDate: '2026-01-01', toDate: '2026-09-10' };

test('coverage preserves independent settled records but excludes exact disputed contracts and unknown zero totals', () => {
  const partial = historyDraft('U123', performance, { ...coverage, complete: false, status: 'coverage_gap' });
  assert.equal(partial.rows.length, 1);
  assert.equal(historyPayload('U123', partial).summary.realizedPnl, 1);
  const disputed = historyDraft('U123', performance, {
    ...coverage, complete: false, conflicts: [{ existing: { conId: 1 }, incoming: { conId: 1 } }],
  });
  assert.equal(disputed.rows.length, 0);
  assert.equal(historyPayload('U123', disputed).summary.realizedPnl, null);
  assert.equal(historyPayload('U123', historyDraft('U123', { rows: [] }, coverage)).summary.realizedPnl, 0);
});

test('health-only ticks preserve history revision and original publication time; new accounting replaces it', async () => {
  let reads = 0;
  const store = { queryAccount: async () => { reads += 1; return []; } };
  const historyStore = createContractPnlHistoryStore({ dataDir: null });
  const service = createContractPnlHistoryService({ store, historyStore,
    getExpectedAccounts: () => ['U123'], readHistoricalExecutions: () => coverage });
  const first = await service.publish('U123', performance);
  const unchanged = await service.publish('U123', { ...performance, tracker: { health: 'capture_paused', updatedAt: new Date().toISOString() } });
  assert.equal(unchanged, first); assert.equal(reads, 1);
  const corrected = await service.publish('U123', { ...performance, rows: [{ ...final, paid: 6, currentValue: 6, pnl: 2 }] });
  assert.notEqual(first.projectionRevision, corrected.projectionRevision);
  assert.equal(corrected.payload.rows.length, 1); assert.equal(corrected.payload.summary.realizedPnl, 2);
});

test('account authorization remains local and revocation during a build prevents publication', async () => {
  let allowed = ['U123']; let finish;
  const read = new Promise((resolve) => { finish = resolve; });
  const historyStore = createContractPnlHistoryStore({ dataDir: null });
  const service = createContractPnlHistoryService({ store: { queryAccount: async () => [] }, historyStore,
    getExpectedAccounts: () => allowed, readHistoricalExecutions: () => read });
  const pending = service.publish('U123', performance);
  await new Promise((resolve) => setImmediate(resolve));
  allowed = []; finish(coverage);
  await assert.rejects(pending, { code: 'ACCOUNT_NOT_MANAGED' });
  assert.equal(historyStore.get('U123'), null);
});

test('a ledger write occurring during a build prevents an obsolete historical generation from publishing', async () => {
  let finish;
  const read = new Promise((resolve) => { finish = resolve; });
  const historyStore = createContractPnlHistoryStore({ dataDir: null });
  const service = createContractPnlHistoryService({ store: { queryAccount: async () => [] }, historyStore,
    getExpectedAccounts: () => ['U123'], readHistoricalExecutions: () => read });
  const pending = service.publish('U123', performance);
  service.invalidateBuild('U123'); finish(coverage);
  assert.equal(await pending, null);
  assert.equal(historyStore.get('U123'), null);
});

test('changed history snapshots accounting prefixes once and never scans unrelated account research', async () => {
  const prefixes = [];
  const service = createContractPnlHistoryService({
    historyStore: createContractPnlHistoryStore({ dataDir: null }),
    getExpectedAccounts: () => ['U123'], readHistoricalExecutions: () => coverage,
    store: {
      queryAccount: async () => { throw new Error('Unrelated account partition scan'); },
      queryAccountPrefix: async (_account, prefix) => { prefixes.push(prefix); return []; },
    },
  });
  const first = await service.publish('U123', performance);
  assert.equal(first.payload.rows.length, 1);
  assert.deepEqual(prefixes.sort(), ['execution#', 'lifecycle#']);
  assert.equal(await service.publish('U123', performance), first);
  assert.equal(prefixes.length, 2);
});

test('settled execution-only corrections change detail revisions but current captures do not', async () => {
  const service = createContractPnlHistoryService({
    historyStore: createContractPnlHistoryStore({ dataDir: null }),
    getExpectedAccounts: () => ['U123'], readHistoricalExecutions: () => coverage,
    store: { queryAccount: async () => [] },
  });
  const lifecycle = { itemType: 'lifecycle', recordKey: 'lifecycle#gold', lifecycleId: 'gold', executionIds: ['entry'] };
  const execution = { itemType: 'execution', recordKey: 'execution#entry', execId: 'entry', lifecycleRecordKey: lifecycle.recordKey,
    source: 'ibkr_flex_import', feeEvidenceFingerprint: 'original-report', version: 1 };
  const evidence = [lifecycle, execution];
  const first = await service.publish('U123', performance, evidence);
  const currentChanged = await service.publish('U123', performance, [...evidence,
    { itemType: 'health', recordKey: 'health#capture', updatedAt: 'new-health-tick' },
    { itemType: 'execution', recordKey: 'execution#today', execId: 'today', lifecycleRecordKey: 'lifecycle#open', version: 2 },
  ]);
  assert.equal(currentChanged, first);
  const corrected = await service.publish('U123', performance, [lifecycle, { ...execution, feeEvidenceFingerprint: 'verified-enrichment', version: 2 }]);
  assert.notEqual(corrected.projectionRevision, first.projectionRevision);
  assert.equal(corrected.payload.summary.realizedPnl, first.payload.summary.realizedPnl);
  assert.equal(await service.publish('U123', performance), corrected);
});

test('a warm-up starting inside a write cannot publish a partially committed history', async () => {
  let reads = 0;
  const historyStore = createContractPnlHistoryStore({ dataDir: null });
  const service = createContractPnlHistoryService({ historyStore,
    store: { queryAccount: async () => [] }, getExpectedAccounts: () => ['U123'],
    readHistoricalExecutions: () => { reads += 1; return coverage; },
  });
  const first = await service.publish('U123', performance);
  service.beginWrite('U123');
  assert.equal(await service.publish('U123', { rows: [], tracker: {} }), null);
  assert.equal(reads, 1);
  assert.equal(historyStore.get('U123'), first);
  service.endWrite('U123');
  const corrected = await service.publish('U123', { rows: [], tracker: {} });
  assert.notEqual(corrected.projectionRevision, first.projectionRevision);
  assert.equal(corrected.payload.rows.length, 0);
});

test('one prepared execution index preserves legacy detail output and cannot cross account scope', async () => {
  const records = [{ accountId: 'U123', itemType: 'lifecycle', recordKey: 'lifecycle#1#1', lifecycleId: 'final',
    market: 'wti', exchange: 'KALSHI', contractLabel: 'WTI 80 YES', status: 'verified',
    verification: 'verified_settlement', entryQuantity: 10, entryCost: 5, paid: 10, executionIds: [],
  }];
  const store = { queryAccountPrefix: async (_account, prefix) => records.filter((row) => row.recordKey.startsWith(prefix)) };
  const original = await loadPerformanceExecutions({ store, accountId: 'U123', id: 'final' });
  const prepared = { accountId: 'U123', records, replay: reconstructForecastExEconomicRecords({ lifecycleRecords: records, executionRecords: [] }) };
  assert.deepEqual(await loadPerformanceExecutions({ store, accountId: 'U123', id: 'final', prepared }), original);
  await assert.rejects(loadPerformanceExecutions({ store, accountId: 'U456', id: 'final', prepared }), /another account/);
});
