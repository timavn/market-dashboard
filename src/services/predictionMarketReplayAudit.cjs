'use strict';

const { deserializeLedgerItem, forecastExThresholdIdentity, ibkrFlexSettlementPayout,
  normalizeExecution, normalizeMarket, normalizePerformanceRow, serializeLedgerItem } = require('./predictionMarketPerformanceLedger.cjs');

const COMPONENT_STATUSES = new Set(['paired_offset_component', 'broker_settlement_posting', 'broker_execution_representation', 'historical_snapshot_superseded']);
const FIELDS = ['risked', 'paid', 'pnl', 'fees'];
const money = (micros) => micros == null ? null : micros / 1_000_000;
const micros = (value) => value == null || typeof value === 'boolean' || !Number.isFinite(Number(value)) ? null : Math.round(Number(value) * 1_000_000);
const increment = (counts, key) => { counts[key] = (counts[key] || 0) + 1; };
const total = (rows, field) => rows.every((row) => Number.isSafeInteger(row[field]))
  ? rows.reduce((sum, row) => sum + row[field], 0) : null;
const publicAmounts = (amounts) => Object.fromEntries(FIELDS.map((field) => [field, money(amounts[field])]));
const sumAmounts = (rows) => Object.fromEntries(FIELDS.map((field) => [field, total(rows, field)]));
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
    .filter((key) => value[key] !== undefined).map((key) => [key, canonical(value[key])]));
  return value;
}
const samePersistedRecord = (left, right) => JSON.stringify(canonical(serializeLedgerItem(left)))
  === JSON.stringify(canonical(serializeLedgerItem(right)));
const comparisonTotals = (ledgerRows, brokerRows) => {
  const ledger = sumAmounts(ledgerRows);
  const broker = sumAmounts(brokerRows);
  return { ledger: publicAmounts(ledger), broker: publicAmounts(broker),
    ledgerMinusBroker: publicAmounts(Object.fromEntries(FIELDS.map((field) => [field,
      ledger[field] == null || broker[field] == null ? null : ledger[field] - broker[field],
    ]))) };
};

function scopeFor(record) {
  const native = forecastExThresholdIdentity(record);
  if (native) return { key: `native:${native.eventContract}`, native, market: native.market };
  const conId = Number(record.conId);
  return {
    key: Number.isInteger(conId) && conId > 0 ? `conId:${conId}` : null,
    native: null,
    market: normalizeMarket(record.market, [record.symbol, record.localSymbol, record.description, record.contractLabel].filter(Boolean).join(' ')),
  };
}

function ledgerAmounts(record, row) {
  const entryFees = micros(record.fees);
  const exitFees = micros(record.exitFees ?? 0);
  return {
    risked: micros(row.risked), paid: micros(row.paid), pnl: micros(row.pnl),
    fees: entryFees == null || exitFees == null ? null : entryFees + exitFees,
  };
}

// Accounting-only audit. No values from this module are quote/execution inputs.
// The broker tape is already account-scoped and deduplicated by the shared Flex
// validator. A trade is never allocated across competing economic lifecycles.
function buildReplayReconciliationAudit({ accountId, records = [], existingRecords = [], history } = {}) {
  // Runtime corrections can retain old *Micros fields alongside new decimal
  // values. Audit the exact serializer's final monetary values, never decode
  // those stale fields directly from an un-serialized proposal.
  const lifecycles = records.filter((record) => record.itemType === 'lifecycle' && record.accountId === accountId)
    .map((record) => deserializeLedgerItem(serializeLedgerItem(record)));
  const priorByKey = new Map(existingRecords.filter((record) => record.accountId === accountId)
    .map((record) => [record.recordKey, deserializeLedgerItem(serializeLedgerItem(record))]));
  const sourceTrades = (history?.trades || []).filter((trade) => trade.accountId === accountId);
  const sourceById = new Map();
  let duplicateSourceExecutionCount = 0;
  for (const trade of sourceTrades) {
    if (sourceById.has(trade.execId)) duplicateSourceExecutionCount += 1;
    else sourceById.set(trade.execId, trade);
  }
  const groups = new Map();
  const groupFor = (scope) => {
    if (!scope.key) return null;
    if (!groups.has(scope.key)) groups.set(scope.key, { ...scope, trades: [], lifecycles: [], published: [] });
    return groups.get(scope.key);
  };
  for (const trade of sourceById.values()) groupFor(scopeFor(trade))?.trades.push(trade);
  for (const record of lifecycles) {
    const group = groupFor(scopeFor(record));
    if (!group) continue;
    group.lifecycles.push(record);
    if (normalizePerformanceRow(record)) group.published.push(record);
  }
  const byMarket = new Map();
  const marketFor = (market) => {
    if (!byMarket.has(market)) byMarket.set(market, {
      market, publishableCount: 0, classifications: {}, withheldReasons: {}, results: [],
      sourceExecutionCount: 0, sourceNetCashMicros: 0, sourceFeesMicros: 0,
      sourceFinancialsComplete: true, ledger: [], checkedLedger: [], checkedBroker: [],
    });
    return byMarket.get(market);
  };
  for (const trade of sourceById.values()) {
    const output = marketFor(scopeFor(trade).market);
    output.sourceExecutionCount += 1;
    if (![trade.netCashMicros, trade.commissionMicros, trade.taxMicros].every(Number.isSafeInteger)) output.sourceFinancialsComplete = false;
    else {
      output.sourceNetCashMicros += trade.netCashMicros;
      output.sourceFeesMicros += trade.commissionMicros + trade.taxMicros;
    }
  }
  for (const record of [...lifecycles].sort((left, right) => String(left.recordKey).localeCompare(String(right.recordKey)))) {
    const scope = scopeFor(record);
    const output = marketFor(scope.market);
    increment(output.classifications, record.status || 'unknown');
    const row = normalizePerformanceRow(record);
    if (!row) {
      if (!COMPONENT_STATUSES.has(record.status)) increment(output.withheldReasons, record.reviewReason || record.status || 'unavailable');
      continue;
    }
    output.publishableCount += 1;
    const ledger = ledgerAmounts(record, row);
    output.ledger.push(ledger);
    const group = groups.get(scope.key);
    const trades = group?.trades || [];
    const reasons = [];
    if (history?.complete !== true || history?.controls?.zeroToCent !== true || duplicateSourceExecutionCount) reasons.push('source_validation_unproven');
    if (!trades.length) reasons.push('broker_execution_scope_missing');
    if (group?.published.length !== 1) reasons.push('broker_scope_shared_by_multiple_results');
    if (group?.lifecycles.some((candidate) => candidate.recordKey !== record.recordKey
      && !COMPONENT_STATUSES.has(candidate.status) && !normalizePerformanceRow(candidate)
      && Number(candidate.entryQuantity || 0) > 0
      && candidate.pairedToLifecycleRecordKey !== record.recordKey)) reasons.push('competing_unresolved_economic_lifecycle');
    const quantities = new Map();
    for (const trade of trades) {
      const direction = String(trade.direction || trade.side || '').toUpperCase();
      const quantity = Number(trade.quantity ?? trade.shares);
      if (!['BUY', 'SELL'].includes(direction) || !Number.isFinite(quantity)) { reasons.push('broker_quantity_missing'); continue; }
      quantities.set(trade.conId, (quantities.get(trade.conId) || 0) + quantity * (direction === 'BUY' ? 1 : -1));
    }
    if ([...quantities.values()].some((value) => Math.abs(value) > 1e-7)) reasons.push('broker_scope_not_flat');
    if (trades.some((trade) => ![trade.netCashMicros, trade.commissionMicros, trade.taxMicros].every(Number.isSafeInteger))) reasons.push('broker_financial_fields_missing');
    const heldSide = scope.native?.contractSide;
    if (scope.native && !['YES', 'NO'].includes(heldSide)) reasons.push('native_held_side_unverified');
    const entries = trades.filter((trade) => String(trade.direction || trade.side).toUpperCase() === 'BUY'
      && (!scope.native || forecastExThresholdIdentity(trade)?.contractSide === heldSide));
    if (!entries.length) reasons.push('original_entry_evidence_missing');
    const entryQuantity = entries.reduce((sum, trade) => sum + Number(trade.quantity ?? trade.shares), 0);
    if (Math.abs(entryQuantity - Number(record.entryQuantity || 0)) > 1e-7) reasons.push('original_entry_quantity_mismatch');
    const entryIds = new Set(entries.map((trade) => trade.execId));
    const broker = reasons.length ? null : {
      risked: -entries.reduce((sum, trade) => sum + trade.netCashMicros, 0),
      paid: trades.filter((trade) => !entryIds.has(trade.execId)).reduce((sum, trade) => sum + trade.netCashMicros, 0),
      pnl: trades.reduce((sum, trade) => sum + trade.netCashMicros, 0),
      fees: trades.reduce((sum, trade) => sum + trade.commissionMicros + trade.taxMicros, 0),
    };
    const differences = broker && Object.fromEntries(FIELDS.map((field) => [field,
      ledger[field] == null ? null : ledger[field] - broker[field],
    ]));
    const mismatches = differences ? FIELDS.filter((field) => differences[field] == null || Math.round(differences[field] / 10_000) !== 0) : [];
    const brokerExitFees = broker ? trades.filter((trade) => !entryIds.has(trade.execId))
      .reduce((sum, trade) => sum + trade.commissionMicros + trade.taxMicros, 0) : null;
    const zeroCents = (value) => value != null && Math.round(value / 10_000) === 0;
    const bridged = broker && !scope.native && brokerExitFees > 0 && micros(record.exitFees ?? 0) === 0
      && zeroCents(differences.risked - brokerExitFees) && zeroCents(differences.paid - brokerExitFees)
      && zeroCents(differences.pnl) && zeroCents(differences.fees);
    const feeAllocationBridge = bridged ? {
      method: 'legacy_total_fees_in_risked_and_gross_exit_proceeds',
      reportedExitFees: money(brokerExitFees),
      appliedRiskedAndPaidShift: money(brokerExitFees),
      ledgerMinusBridgedBroker: { risked: money(differences.risked - brokerExitFees),
        paid: money(differences.paid - brokerExitFees), pnl: money(differences.pnl), fees: money(differences.fees) },
    } : null;
    if (mismatches.length && !bridged) reasons.push(`ledger_broker_difference:${mismatches.join(',')}`);
    if (broker) { output.checkedLedger.push(ledger); output.checkedBroker.push(broker); }
    const sourceRoles = {};
    trades.forEach((trade) => {
      const settlement = ibkrFlexSettlementPayout(normalizeExecution(trade, accountId) || {});
      const role = entryIds.has(trade.execId) ? 'original_entry'
        : settlement != null ? 'broker_settlement_posting'
          : scope.native && String(trade.direction || trade.side).toUpperCase() === 'BUY' ? 'opposite_side_purchase'
            : 'conversion_or_exit_cashflow';
      increment(sourceRoles, role);
    });
    const previous = priorByKey.get(record.recordKey);
    const previousRow = normalizePerformanceRow(previous);
    const priorAmounts = previousRow && ledgerAmounts(previous, previousRow);
    const amountsUnchanged = previousRow?.performanceComplete !== false && previous?.feesComplete !== false
      && priorAmounts && FIELDS.every((field) => Number.isSafeInteger(priorAmounts[field]) && priorAmounts[field] === ledger[field]);
    // Retention is not permission to silently change the contract, dates,
    // settlement provenance, or execution membership at the same dollar value.
    const unchanged = amountsUnchanged && samePersistedRecord(previous, record);
    const resultStatus = !broker ? 'unproven' : bridged ? 'reconciled_with_fee_allocation' : mismatches.length ? 'difference' : 'reconciled';
    const sourceReconciled = ['reconciled', 'reconciled_with_fee_allocation'].includes(resultStatus);
    output.results.push({
      recordKey: record.recordKey, contractLabel: record.contractLabel, scope: scope.key,
      status: resultStatus,
      monetaryChange: unchanged ? 'unchanged_verified_result' : previousRow ? 'changed_verified_result' : 'new_result',
      accountingRecordUnchanged: Boolean(unchanged),
      publicationBlocked: !sourceReconciled && !unchanged,
      reasons: [...new Set(reasons)], ledger: publicAmounts(ledger),
      feeAllocationBridge,
      broker: broker ? publicAmounts(broker) : null,
      ledgerMinusBroker: differences ? publicAmounts(differences) : null,
      evidence: {
        brokerExecutionCount: trades.length, originalEntryCount: entries.length,
        originalEntryQuantity: Number.isFinite(entryQuantity) ? entryQuantity : null,
        sourceExecutionIds: trades.map((trade) => trade.execId).sort(),
        sourceRoles,
        cashflowMethod: scope.native ? 'original_side_buy_cost_and_remaining_event_net_cash' : 'buy_cost_and_sell_net_cash',
        brokerFeeMethod: 'reported_commission_plus_tax', ledgerFeeSource: record.feeEvidence?.source || record.verification || null,
        componentClassifications: Object.fromEntries([...COMPONENT_STATUSES].map((status) => [status,
          group?.lifecycles.filter((candidate) => candidate.status === status).length || 0,
        ])),
        existingSettlement: previousRow ? {
          previouslyVerified: true, unchangedMonetaryAmounts: Boolean(amountsUnchanged),
          unchangedAccountingRecord: Boolean(unchanged),
          verification: previous.verification || null, source: previous.settlementEvidence?.source || null,
          sourceHash: previous.settlementEvidence?.sourceHash || null,
          observedAt: previous.settlementEvidence?.observedAt || null,
          settlementDate: previousRow.settlementDate || null,
          payoutPerContract: previousRow.payoutPerContract ?? null,
        } : null,
      },
    });
  }
  const markets = [...byMarket.values()].sort((left, right) => left.market.localeCompare(right.market)).map((market) => {
    return {
      market: market.market, publishableCount: market.publishableCount,
      publishableTotals: publicAmounts(sumAmounts(market.ledger)),
      classifications: market.classifications, withheldReasons: market.withheldReasons,
      brokerScope: { executionCount: market.sourceExecutionCount,
        netCash: market.sourceFinancialsComplete ? money(market.sourceNetCashMicros) : null,
        fees: market.sourceFinancialsComplete ? money(market.sourceFeesMicros) : null,
        includesWithheldAndUnresolved: true,
      },
      checkedResultCount: market.checkedLedger.length,
      checkedTotals: comparisonTotals(market.checkedLedger, market.checkedBroker),
      results: market.results,
    };
  });
  const results = markets.flatMap((market) => market.results);
  const withheldReasons = {};
  markets.forEach((market) => Object.entries(market.withheldReasons).forEach(([reason, count]) => {
    withheldReasons[reason] = (withheldReasons[reason] || 0) + count;
  }));
  return {
    schemaVersion: 1, accountId,
    status: results.length && results.every((result) => ['reconciled', 'reconciled_with_fee_allocation'].includes(result.status)) ? 'reconciled' : 'unproven',
    publicationSafe: results.every((result) => !result.publicationBlocked),
    blockedResultKeys: results.filter((result) => result.publicationBlocked).map((result) => result.recordKey),
    sourceAccountControl: history?.controls?.accounts?.find((row) => row.accountId === accountId) || null,
    sourceZeroToCent: history?.controls?.zeroToCent === true,
    duplicateSourceExecutionCount,
    withheldReasons,
    resultCounts: { reconciled: results.filter((row) => row.status === 'reconciled').length,
      reconciledWithFeeAllocation: results.filter((row) => row.status === 'reconciled_with_fee_allocation').length,
      difference: results.filter((row) => row.status === 'difference').length,
      unproven: results.filter((row) => row.status === 'unproven').length },
    publishableTotals: publicAmounts(sumAmounts([...byMarket.values()].flatMap((market) => market.ledger))),
    checkedResultCount: [...byMarket.values()].reduce((sum, market) => sum + market.checkedLedger.length, 0),
    checkedTotals: comparisonTotals([...byMarket.values()].flatMap((market) => market.checkedLedger),
      [...byMarket.values()].flatMap((market) => market.checkedBroker)),
    markets,
  };
}

module.exports = { buildReplayReconciliationAudit };
