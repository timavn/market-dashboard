const {
  loadPerformance, loadPerformanceExecutions, normalizeMarket, performanceSummaryKeys, serializeLedgerItem,
  reconstructForecastExEconomicRecords,
} = require('./predictionMarketPerformanceLedger.cjs');
const { summarizeTrackedRows } = require('./predictionMarketPerformanceMarks.cjs');
const { verifiedHistoricalRow, digest } = require('./contractPnlHistoryStore.cjs');

function venueFor(row) {
  const identity = `${row.exchange || ''} ${row.contractKey || ''} ${row.eventTicker || ''} ${row.contractLabel || ''}`.toUpperCase();
  if (/FORECAST|\b(?:FES|COMCO|METLG|METLS|CPIY|CFBTC|CFETH)[_-]/.test(identity)) return 'forecastex';
  return /KALSHI|\bKX[A-Z0-9]+[-_]/.test(identity) ? 'kalshi' : 'unknown';
}

function historicalExecutionRevision(rows, records) {
  const ids = new Set(rows.map((row) => row.id));
  const lifecycles = records.filter((record) => record.itemType === 'lifecycle'
    && (ids.has(record.lifecycleId) || ids.has(record.recordKey)));
  const keys = new Set(lifecycles.map((record) => record.recordKey));
  const executionIds = new Set(lifecycles.flatMap((record) => [
    ...(record.executionIds || []),
    ...(record.economicTransactions?.entries || []).flatMap((entry) => (entry.rawLegs || []).map((leg) => leg.execId)),
    ...(record.economicTransactions?.cashOuts || []).flatMap((entry) => (entry.rawLegs || []).map((leg) => leg.execId)),
  ]));
  return digest(records.filter((record) => record.itemType === 'execution'
    && (keys.has(record.lifecycleRecordKey) || executionIds.has(record.execId)))
    .sort((left, right) => String(left.recordKey).localeCompare(String(right.recordKey)))
    .map(serializeLedgerItem));
}

function historyDraft(accountId, performance, history = {}) {
  const disputed = new Set((history.conflicts || []).flatMap((conflict) => [conflict.existing?.conId, conflict.incoming?.conId])
    .filter((value) => value != null).map(Number));
  const rows = (performance.rows || []).filter(verifiedHistoricalRow)
    .filter((row) => !disputed.has(Number(row.conId)))
    .map((row) => ({
      ...row, accountId, historicalOnly: true, venue: venueFor(row),
      market: normalizeMarket(row.market, `${row.contractLabel || ''} ${row.contractKey || ''}`),
    })).sort((left, right) => String(left.id).localeCompare(String(right.id)));
  const sourceGapCount = Number(performance.tracker?.sourceGapCount || 0);
  const quarantinedEvidenceCount = Number(performance.tracker?.quarantinedEvidenceCount || 0);
  const complete = history.complete === true && !sourceGapCount && !quarantinedEvidenceCount;
  const coverage = {
    status: complete ? 'ready' : 'incomplete', source: 'authoritative_ledger', complete,
    fromDate: history.fromDate || null, throughDate: history.toDate || null,
    verifiedRecordCount: rows.length,
    sourceSnapshotId: history.snapshotId || null,
    sourceObservedAt: history.fetchedAt || null,
    sourceStatus: history.status || 'unavailable',
    accountingRevision: performance.tracker?.historicalAccountingRevision || null,
    conflictCount: history.conflicts?.length || 0, sourceGapCount, quarantinedEvidenceCount,
  };
  return { rows, coverage, fingerprint: digest({ rows, coverage }) };
}

function historyPayload(accountId, draft) {
  const { rows, coverage } = draft;
  const summaryFor = (selected) => {
    const result = summarizeTrackedRows(selected);
    return {
      ...result, complete: coverage.complete && result.complete,
      realizedScope: coverage.complete ? 'complete_history' : 'verified_records',
      realizedCount: selected.length,
      realizedPnl: selected.length ? result.pnl : (coverage.complete ? 0 : null),
      openCount: null, awaitingCount: null, openPnl: null, awaitingPnl: null,
      // History is usable independently; mixed current totals are composed by
      // the consumer only after it has a fresh current capture.
    };
  };
  const keys = [...new Set([...performanceSummaryKeys(), ...rows.map((row) => row.market)])];
  return {
    scope: 'account', selectedAccount: accountId, selectedVenue: 'all', rows, activeRows: [], review: [],
    summary: summaryFor(rows),
    summaries: Object.fromEntries(keys.map((key) => [key, summaryFor(key === 'all' ? rows : rows.filter((row) => row.market === key))])),
    availability: {
      history: { ...coverage, observedAt: new Date().toISOString() },
      current: { status: 'unavailable', complete: false, observedAt: null },
    },
    tracker: {
      status: 'history_only', currentDataComplete: false,
      sourceGapCount: coverage.sourceGapCount, quarantinedEvidenceCount: coverage.quarantinedEvidenceCount,
      historyMessage: coverage.complete ? null : 'Some history is not yet verified. Totals cover verified records only.',
    },
    consolidation: { historyComplete: coverage.complete, currentComplete: false, complete: false },
  };
}

function createContractPnlHistoryService({ store, historyStore, readHistoricalExecutions, getExpectedAccounts, getKnownAccounts, logger = console }) {
  let knownAllowed = [];
  let explicitAuthoritySeen = false;
  const pending = new Map();
  const generations = new Map();
  const evidenceSnapshots = new Map();
  const writesInProgress = new Set();
  const invalidateBuild = (accountId) => generations.set(accountId, (generations.get(accountId) || 0) + 1);
  const ids = (values) => [...new Set((Array.isArray(values) ? values : []).map((value) => String(value?.accountId || value || '').trim()).filter(Boolean))];

  async function authorize(accountId) {
    if (!accountId) throw Object.assign(new Error('An exact IBKR account is required.'), { statusCode: 400, code: 'ACCOUNT_REQUIRED' });
    // Configuration is local and authoritative. Neither Gateway discovery nor
    // filesystem/report/database enumeration belongs on a historical read.
    const expected = typeof getExpectedAccounts === 'function' ? ids(await getExpectedAccounts()) : [];
    if (expected.length) explicitAuthoritySeen = true;
    const allowed = expected.length ? expected : explicitAuthoritySeen ? [] : knownAllowed;
    if (explicitAuthoritySeen && !expected.length) throw Object.assign(new Error('The requested account is not managed by this dashboard.'), { statusCode: 403, code: 'ACCOUNT_NOT_MANAGED' });
    if (!allowed.length) throw Object.assign(new Error('Account authorization is unavailable.'), { statusCode: 503, code: 'ACCOUNT_AUTHORIZATION_UNAVAILABLE' });
    if (!allowed.includes(accountId)) throw Object.assign(new Error('The requested account is not managed by this dashboard.'), { statusCode: 403, code: 'ACCOUNT_NOT_MANAGED' });
    return accountId;
  }

  function publish(accountId, suppliedPerformance = null, accountingEvidence = null) {
    if (Array.isArray(accountingEvidence)) evidenceSnapshots.set(accountId, accountingEvidence);
    if (pending.has(accountId)) return pending.get(accountId).then(() => publish(accountId));
    const generation = generations.get(accountId) || 0;
    const task = (async () => {
      await authorize(accountId);
      if (writesInProgress.has(accountId)) return null;
      const [performance, history] = await Promise.all([
        suppliedPerformance || loadPerformance({ store, accountId }),
        typeof readHistoricalExecutions === 'function' ? readHistoricalExecutions(accountId) : { status: 'unconfigured', complete: false },
      ]);
      const previous = historyStore.get(accountId);
      const accountingRevision = evidenceSnapshots.has(accountId)
        ? historicalExecutionRevision((performance.rows || []).filter(verifiedHistoricalRow), evidenceSnapshots.get(accountId))
        : previous?.payload.availability.history.accountingRevision || null;
      const draft = historyDraft(accountId, {
        ...performance, tracker: { ...performance.tracker, historicalAccountingRevision: accountingRevision },
      }, history);
      if (previous?.fingerprint === draft.fingerprint) return previous;
      const executionDetails = {};
      if (draft.rows.length) {
        // Snapshot the evidence once per changed generation. The old detail
        // endpoint replayed the full account on every row expansion.
        // The account partition also holds large, unrelated prospective research
        // series. Snapshot accounting prefixes only, never scan that partition.
        const records = typeof store.queryAccountPrefix === 'function'
          ? (await Promise.all(['lifecycle#', 'execution#']
            .map((prefix) => store.queryAccountPrefix(accountId, prefix)))).flat()
          : await store.queryAccount(accountId);
        const accountingRecords = records.filter((row) => ['lifecycle', 'execution'].includes(row.itemType));
        const snapshotStore = {
          queryAccount: async () => accountingRecords,
          queryAccountPrefix: async (_account, prefix) => accountingRecords.filter((row) => String(row.recordKey || '').startsWith(prefix)),
          get: async (_account, key) => accountingRecords.find((row) => row.recordKey === key) || null,
        };
        const prepared = { accountId, records: accountingRecords, replay: reconstructForecastExEconomicRecords({
          lifecycleRecords: accountingRecords.filter((row) => row.itemType === 'lifecycle'),
          executionRecords: accountingRecords.filter((row) => row.itemType === 'execution'),
        }) };
        for (const row of draft.rows) {
          const detail = await loadPerformanceExecutions({ store: snapshotStore, accountId, id: row.id, prepared });
          if (detail) {
            const target = accountingRecords.find((record) => record.recordKey === detail.recordKey);
            // Full immutable revision snapshots remain in the authoritative
            // ledger/legacy API, not copied thousands of times into this index.
            executionDetails[row.id] = { ...detail, ledgerReference: {
              recordKey: detail.recordKey, version: target?.version || null,
            } };
          }
        }
      }
      // Check authority again: an account may have been removed during a slow
      // build. Only a complete new generation is exposed to readers.
      await authorize(accountId);
      if (writesInProgress.has(accountId) || (generations.get(accountId) || 0) !== generation) return null;
      return historyStore.publish(accountId, { fingerprint: draft.fingerprint, payload: historyPayload(accountId, draft), executionDetails });
    })().finally(() => pending.delete(accountId));
    pending.set(accountId, task);
    return task;
  }

  async function warm({ rebuild = true } = {}) {
    const expected = typeof getExpectedAccounts === 'function' ? ids(await getExpectedAccounts()) : [];
    if (expected.length) { knownAllowed = expected; explicitAuthoritySeen = true; }
    else {
      const [known, registered] = await Promise.allSettled([
        typeof getKnownAccounts === 'function' ? getKnownAccounts() : [],
        store.listRegisteredManagedAccounts?.() || [],
      ]);
      knownAllowed = ids([...(known.status === 'fulfilled' ? known.value : []), ...(registered.status === 'fulfilled' ? registered.value : [])]);
    }
    // Load private persisted projections before any background source reads.
    knownAllowed.forEach((accountId) => historyStore.get(accountId));
    if (!rebuild) return knownAllowed.map((accountId) => historyStore.get(accountId));
    return Promise.allSettled(knownAllowed.map(async (accountId) => {
      try { return await publish(accountId); }
      catch (error) { logger.warn?.(`[Prediction P&L] historical projection update paused: ${error.message}`); return null; }
    }));
  }

  return {
    authorize, publish, warm, get: historyStore.get, details: historyStore.details,
    invalidateBuild,
    beginWrite: (accountId) => { writesInProgress.add(accountId); invalidateBuild(accountId); },
    endWrite: (accountId) => { writesInProgress.delete(accountId); invalidateBuild(accountId); },
  };
}

module.exports = { createContractPnlHistoryService, historicalExecutionRevision, historyDraft, historyPayload, venueFor };
