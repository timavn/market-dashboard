const { buildReplayReconciliationAudit } = require('./predictionMarketReplayAudit.cjs');

const accountId = 'U123';
const identity = { accountId, conId: 100, symbol: 'FES', localSymbol: 'FES_082126_7700_YES',
  secType: 'EVENT_FORECASTX', exchange: 'FORECASTX', expiration: '2026-08-24', strike: 7700, contractSide: 'YES' };
const trade = (id, direction, quantity, cash, commission = 0, extra = {}) => ({
  ...identity, execId: id, direction, quantity, executionTime: '2026-08-21T19:00:00Z',
  netCashMicros: Math.round(cash * 1_000_000), commissionMicros: Math.round(commission * 1_000_000), taxMicros: 0, ...extra,
});
const lifecycle = (extra = {}) => ({ ...identity, itemType: 'lifecycle', recordKey: 'lifecycle#100#1',
  status: 'verified', market: 'sp500', entryQuantity: 10, netQuantity: 0,
  entryCost: 2.6, risked: 2.6, paid: 10, fees: 0.1, exitFees: 0,
  performanceComplete: true, resolvedDate: '2026-08-24', ...extra });
const history = (trades) => ({ complete: true, controls: { zeroToCent: true, accounts: [{ accountId, difference: 0 }] }, trades });
const baseTrades = () => [trade('buy', 'BUY', 10, -2.6, 0.1), trade('expiry', 'SELL', 10, 10)];
const audit = (records = [lifecycle()], trades = baseTrades()) => buildReplayReconciliationAudit({ accountId, records, history: history(trades) });

test('reconciles one uniquely attributable closed native contract using broker cash and reported fees', () => {
  const result = audit();
  expect(result).toMatchObject({ status: 'reconciled', resultCounts: { reconciled: 1, difference: 0, unproven: 0 },
    publishableTotals: { risked: 2.6, paid: 10, pnl: 7.4, fees: 0.1 } });
  expect(result.markets[0].results[0]).toMatchObject({ status: 'reconciled', reasons: [],
    broker: { risked: 2.6, paid: 10, pnl: 7.4, fees: 0.1 },
    ledgerMinusBroker: { risked: 0, paid: 0, pnl: 0, fees: 0 } });
});

test('keeps original entry cost separate from opposite purchases, conversion credit and settlement postings', () => {
  const no = { conId: 101, localSymbol: 'FES_082126_7700_NO', contractSide: 'NO' };
  const trades = [trade('entry', 'BUY', 10, -4.1, 0.1), trade('offset', 'BUY', 4, -1.24, 0.04, no),
    trade('yes-conversion', 'SELL', 4, 2), trade('no-conversion', 'SELL', 4, 2, 0, no), trade('posting', 'SELL', 6, 0)];
  const rows = [lifecycle({ entryCost: 4.1, risked: 4.1, paid: 2.76, fees: 0.1, exitFees: 0.04 }),
    lifecycle({ ...no, recordKey: 'lifecycle#101#1', status: 'paired_offset_component', entryQuantity: 4 }),
    lifecycle({ recordKey: 'lifecycle#100#posting', status: 'broker_settlement_posting', entryQuantity: 0 })];
  const result = audit(rows, trades);
  expect(result).toMatchObject({ status: 'reconciled', publishableTotals: { risked: 4.1, paid: 2.76, pnl: -1.34, fees: 0.14 } });
  expect(result.markets[0]).toMatchObject({ publishableCount: 1, withheldReasons: {}, classifications: {
    verified: 1, paired_offset_component: 1, broker_settlement_posting: 1,
  } });
});

test('reports exact financial differences without adjusting any ledger amount', () => {
  const result = audit([lifecycle({ entryCost: 3, paid: 9, fees: 0.2 })]);
  expect(result.status).toBe('unproven');
  expect(result.markets[0].results[0]).toMatchObject({ status: 'difference',
    ledgerMinusBroker: { risked: 0.4, paid: -1, pnl: -1.4, fees: 0.1 } });
  expect(result.publishableTotals).toEqual({ risked: 3, paid: 9, pnl: 6, fees: 0.2 });
});

test('audits the serialized proposed amounts instead of stale inherited money-micros fields', () => {
  const result = audit([lifecycle({ riskedMicros: 999000000, entryCostMicros: 999000000,
    paidMicros: 123000000, pnlMicros: -876000000, feesMicros: 5000000 })]);
  expect(result).toMatchObject({ status: 'reconciled', publishableTotals: { risked: 2.6, paid: 10, pnl: 7.4, fees: 0.1 } });
});

test('bridges the explicit generic all-fees-in-basis and gross-proceeds convention without erasing raw differences', () => {
  const generic = { symbol: 'KXCPI', localSymbol: 'KXCPI-26AUG-3.3-YES', exchange: 'KALSHI', secType: 'OPT', market: 'cpi', strike: 3.3 };
  const rows = [lifecycle({ ...generic, entryCost: 2.7, paid: 10, fees: 0.2 })];
  const trades = [trade('buy', 'BUY', 10, -2.6, 0.1, generic), trade('sell', 'SELL', 10, 9.9, 0.1, generic)];
  const result = audit(rows, trades);
  expect(result).toMatchObject({ status: 'reconciled', publicationSafe: true, resultCounts: { reconciledWithFeeAllocation: 1 } });
  expect(result.markets[0].results[0]).toMatchObject({ status: 'reconciled_with_fee_allocation',
    ledgerMinusBroker: { risked: 0.1, paid: 0.1, pnl: 0, fees: 0 },
    feeAllocationBridge: { reportedExitFees: 0.1, appliedRiskedAndPaidShift: 0.1,
      ledgerMinusBridgedBroker: { risked: 0, paid: 0, pnl: 0, fees: 0 } } });
  const wrong = audit([lifecycle({ ...generic, entryCost: 2.8, paid: 10.1, fees: 0.2 })], trades);
  expect(wrong).toMatchObject({ publicationSafe: false, resultCounts: { difference: 1 } });
});

test('preserves an unchanged verified official settlement while separately disclosing the not-yet-flat broker tape', () => {
  const record = lifecycle({ paid: 0, verification: 'verified_settlement', settlementEvidence: {
    source: 'forecastex_official_prices', sourceHash: 'a'.repeat(64), payoutPerContract: 0,
    observedAt: '2026-08-24T22:00:00Z', settlementDate: '2026-08-24',
  } });
  const result = buildReplayReconciliationAudit({ accountId, records: [record], existingRecords: [record],
    history: history([baseTrades()[0]]) });
  expect(result).toMatchObject({ status: 'unproven', publicationSafe: true });
  expect(result.markets[0].results[0]).toMatchObject({ status: 'unproven', monetaryChange: 'unchanged_verified_result', publicationBlocked: false,
    reasons: ['broker_scope_not_flat'], evidence: { existingSettlement: { previouslyVerified: true,
      unchangedMonetaryAmounts: true, source: 'forecastex_official_prices', payoutPerContract: 0 } } });
  const changed = buildReplayReconciliationAudit({ accountId, records: [{ ...record, entryCost: 3 }], existingRecords: [record],
    history: history([baseTrades()[0]]) });
  expect(changed.publicationSafe).toBe(false);
});

test.each([
  ['contract identity', { localSymbol: 'FES_082126_7750_YES' }],
  ['settlement evidence', { settlementEvidence: { source: 'unverified', payoutPerContract: 0 } }],
  ['execution membership', { executionIds: ['different-execution'] }],
  ['resolution date', { resolvedDate: '2026-08-25' }],
])('unchanged dollars do not authorize changed %s without source reconciliation', (_name, change) => {
  const previous = lifecycle({ paid: 0, verification: 'verified_settlement', settlementEvidence: {
    source: 'forecastex_official_prices', sourceHash: 'a'.repeat(64), payoutPerContract: 0,
  } });
  const result = buildReplayReconciliationAudit({ accountId, records: [{ ...previous, ...change }], existingRecords: [previous],
    history: history([baseTrades()[0]]) });
  expect(result.publicationSafe).toBe(false);
  expect(result.markets.flatMap((market) => market.results)[0]).toMatchObject({ accountingRecordUnchanged: false, publicationBlocked: true });
});

test('never splits a shared broker event across multiple publishable lifecycles', () => {
  const result = audit([lifecycle(), lifecycle({ recordKey: 'lifecycle#100#2' })]);
  expect(result.resultCounts.unproven).toBe(2);
  expect(result.markets[0].results.every((row) => row.reasons.includes('broker_scope_shared_by_multiple_results'))).toBe(true);
  expect(result.markets[0].checkedResultCount).toBe(0);
});

test.each([
  ['missing cash', () => [trade('buy', 'BUY', 10, -2.6, 0.1), trade('sell', 'SELL', 10, 10, 0, { netCashMicros: null })], 'broker_financial_fields_missing'],
  ['not flat', () => [trade('buy', 'BUY', 10, -2.6, 0.1)], 'broker_scope_not_flat'],
  ['duplicated source id', () => [...baseTrades(), baseTrades()[0]], 'source_validation_unproven'],
  ['changed entry size', () => [trade('buy', 'BUY', 11, -2.6, 0.1), trade('sell', 'SELL', 11, 10)], 'original_entry_quantity_mismatch'],
])('labels %s as unproven without manufacturing a comparison', (_name, trades, reason) => {
  const row = audit(undefined, trades()).markets[0].results[0];
  expect(row).toMatchObject({ status: 'unproven', broker: null, ledgerMinusBroker: null });
  expect(row.reasons).toContain(reason);
});

test('retains withheld reasons and component counts separately from financial evidence', () => {
  const result = audit([lifecycle(), lifecycle({ recordKey: 'lifecycle#review', status: 'review', entryQuantity: 0,
    reviewReason: 'unmatched_or_cross_zero_close' })]);
  expect(result.markets[0]).toMatchObject({ publishableCount: 1, withheldReasons: { unmatched_or_cross_zero_close: 1 } });
  expect(result.markets[0].results[0].status).toBe('reconciled');
});

test('excludes foreign accounts and does not mutate frozen source inputs', () => {
  const records = [lifecycle(), lifecycle({ accountId: 'U999', recordKey: 'foreign' })].map(Object.freeze);
  const trades = [...baseTrades(), trade('foreign', 'BUY', 100, -100, 0, { accountId: 'U999' })].map(Object.freeze);
  Object.freeze(records); Object.freeze(trades);
  expect(audit(records, trades)).toMatchObject({ status: 'reconciled', publishableTotals: { risked: 2.6, paid: 10, pnl: 7.4, fees: 0.1 } });
});
