'use strict';

const crypto = require('node:crypto');
const { deserializeLedgerItem, persistCaptureEntries, reconcileEvidence, serializeLedgerItem } = require('./predictionMarketPerformanceLedger.cjs');
const { buildReplayReconciliationAudit } = require('./predictionMarketReplayAudit.cjs');

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
    .filter((key) => value[key] !== undefined).map((key) => [key, canonical(value[key])]));
  return value;
}

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function recordsDigest(records) {
  return digest([...records].sort((left, right) => String(left.recordKey).localeCompare(String(right.recordKey))));
}

async function readReplayRecords(store, accountId) {
  if (typeof store.queryAccountPrefix === 'function') {
    return (await Promise.all(['lifecycle#', 'execution#', 'health#capture']
      .map((prefix) => store.queryAccountPrefix(accountId, prefix)))).flat();
  }
  return (await store.queryAccount(accountId)).filter((record) => ['lifecycle', 'execution', 'health'].includes(record.itemType));
}

function verifiedHistory(history, accountId) {
  return history?.status === 'ready' && history.complete === true
    && history.controls?.zeroToCent === true
    && history.validationVersion === 2
    && /^[a-f0-9]{64}$/.test(String(history.sourceFingerprint || ''))
    && Array.isArray(history.sourceManifest) && history.sourceManifest.length > 0
    && history.sourceManifest.every((entry) => /^[a-f0-9]{64}$/.test(String(entry.sha256 || '')))
    && crypto.createHash('sha256').update(JSON.stringify(history.sourceManifest)).digest('hex') === history.sourceFingerprint
    && Array.isArray(history.trades) && history.trades.every((trade) => trade.accountId === accountId);
}

function replayHistoricalEvidence(history, accountId, existingRecords, now) {
  const payload = {
    ok: true, complete: true, coverageComplete: true, account: accountId,
    status: 'historical_import', source: 'ibkr_flex_import',
    snapshotId: history.snapshotId || history.sourceFingerprint, fetchedAt: history.fetchedAt,
  };
  return reconcileEvidence({
    accountId, positions: [], executions: history.trades,
    positionsPayload: payload, executionsPayload: payload, existingRecords,
    now, allowClosureInference: false,
  });
}

// This entry point is strictly read-only and invokes no provider. The caller
// supplies its authorized account allowlist and real store.
async function previewPredictionMarketLedgerReplay({ store, accountIds, readHistory, now = new Date().toISOString(), includeEvidence = false } = {}) {
  if (!store || (typeof store.queryAccountPrefix !== 'function' && typeof store.queryAccount !== 'function')
    || typeof readHistory !== 'function' || !Array.isArray(accountIds) || !accountIds.length
    || accountIds.some((id) => typeof id !== 'string' || !/^U\d+$/.test(id))
    || new Set(accountIds).size !== accountIds.length || !Number.isFinite(Date.parse(now))) {
    throw Object.assign(new Error('An authorized account list, read-only ledger store and historical reader are required.'), {
      code: 'ledger_replay_preview_scope_invalid',
    });
  }
  const accounts = [];
  for (const accountId of accountIds) {
    const history = await readHistory({ accountId, force: true });
    if (!verifiedHistory(history, accountId)) {
      accounts.push({ accountId, status: 'blocked', reason: 'historical_evidence_unverified', historyStatus: history?.status || 'unavailable' });
      continue;
    }
    const existing = await readReplayRecords(store, accountId);
    if (existing.some((record) => record.accountId !== accountId)) {
      throw Object.assign(new Error('Ledger records escaped the requested account scope.'), { code: 'ledger_replay_account_mismatch' });
    }
    const beforeHash = recordsDigest(existing);
    const replay = (records) => replayHistoricalEvidence(history, accountId, records, now);
    const proposed = replay(existing);
    const proposedWrites = proposed.writeEntries || [];
    const writeKeys = proposedWrites.map(({ item }) => `${item?.accountId}\u0000${item?.recordKey}`);
    const duplicateWriteKeys = [...new Set(writeKeys.filter((key, index) => writeKeys.indexOf(key) !== index))];
    const uniqueWrites = duplicateWriteKeys.length === 0 && proposedWrites.every(({ item }) => item?.accountId === accountId && item?.recordKey);
    const projected = new Map(existing.map((record) => [record.recordKey, record]));
    proposedWrites.forEach(({ item }) => projected.set(item.recordKey, deserializeLedgerItem(serializeLedgerItem(item))));
    const repeated = replay([...projected.values()]);
    const repeatedLater = replayHistoricalEvidence(history, accountId, [...projected.values()], new Date(Date.parse(now) + 60_000).toISOString());
    const sameInstant = repeated.status === 'captured' && (repeated.writeEntries || []).length === 0;
    const nextMinute = repeatedLater.status === 'captured' && (repeatedLater.writeEntries || []).length === 0;
    const idempotent = sameInstant && nextMinute;
    const [latestRecords, latestHistory] = await Promise.all([
      readReplayRecords(store, accountId), readHistory({ accountId, force: true }),
    ]);
    const stable = recordsDigest(latestRecords) === beforeHash
      && verifiedHistory(latestHistory, accountId)
      && latestHistory.sourceFingerprint === history.sourceFingerprint;
    const lifecycleCounts = {};
    for (const record of proposed.records || []) {
      if (record.itemType !== 'lifecycle') continue;
      const key = `${record.market || 'unknown'}:${record.status}:${record.reviewReason || 'none'}`;
      lifecycleCounts[key] = (lifecycleCounts[key] || 0) + 1;
    }
    const reconciliation = buildReplayReconciliationAudit({ accountId, records: proposed.records || [], existingRecords: existing, history });
    accounts.push({
      accountId, status: proposed.status === 'captured' && stable && idempotent && uniqueWrites && reconciliation.publicationSafe ? 'ready_for_review' : 'blocked',
      reason: !stable ? 'evidence_changed_during_preview'
        : proposed.status !== 'captured' ? proposed.reason || 'capture_paused'
          : !uniqueWrites ? 'duplicate_or_invalid_write_keys'
            : !idempotent ? 'replay_not_idempotent'
              : !reconciliation.publicationSafe ? 'financial_reconciliation_unproven' : null,
      beforeHash, sourceFingerprint: history.sourceFingerprint, sourceManifest: history.sourceManifest,
      sourceHashes: history.sourceHashes, historyThrough: history.toDate, idempotent,
      idempotency: { sameInstant, nextMinute },
      existingRecordCount: existing.length, executionCount: history.trades.length,
      lifecycleCounts, proposedWriteCount: proposedWrites.length,
      duplicateWriteKeys,
      reconciliation,
      proposedHash: digest(proposedWrites), proposedWrites,
      ...(includeEvidence ? { inputEvidence: { existingRecords: existing, historicalEvidence: history } } : {}),
    });
  }
  const audit = { schemaVersion: 1, mode: 'preview_only', generatedAt: now, accounts };
  return { ...audit, status: accounts.every((account) => account.status === 'ready_for_review') ? 'ready_for_review' : 'blocked', previewHash: digest(audit), published: false };
}

function publicationError(code, message) {
  return Object.assign(new Error(message), { code });
}

// Deliberately not exposed by the CLI: publication requires an independently
// reviewed private audit and the current application's authorized account list.
// Conditional ledger versions and per-lifecycle audit publication are handled
// by the established persistCaptureEntries implementation, not a bulk overwrite.
async function publishReviewedPredictionMarketLedgerReplay({
  preview, reviewedPreviewHash, authorizedAccountIds, store, readHistory,
  onBeforeAccountWrite, onAfterAccountWrite,
} = {}) {
  const audit = preview && {
    schemaVersion: preview.schemaVersion, mode: preview.mode,
    generatedAt: preview.generatedAt, accounts: preview.accounts,
  };
  if (!audit || preview.schemaVersion !== 1 || preview.mode !== 'preview_only'
    || preview.status !== 'ready_for_review' || preview.published !== false
    || !/^[a-f0-9]{64}$/.test(String(reviewedPreviewHash || ''))
    || preview.previewHash !== reviewedPreviewHash || digest(audit) !== reviewedPreviewHash
    || !Array.isArray(preview.accounts) || !preview.accounts.length
    || !Array.isArray(authorizedAccountIds) || !authorizedAccountIds.length
    || preview.accounts.some((row) => row.status !== 'ready_for_review' || row.idempotent !== true
      || row.reconciliation?.publicationSafe !== true
      || !authorizedAccountIds.includes(row.accountId)
      || !Array.isArray(row.proposedWrites) || row.proposedWriteCount !== row.proposedWrites.length
      || row.proposedHash !== digest(row.proposedWrites)
      || new Set(row.proposedWrites.map(({ item }) => item?.recordKey)).size !== row.proposedWrites.length
      || row.proposedWrites.some((entry) => entry?.item?.accountId !== row.accountId
        || !entry.item.recordKey
        || (entry.createOnly !== true && !Number.isFinite(entry.expectedVersion))))
    || new Set(preview.accounts.map((row) => row.accountId)).size !== preview.accounts.length) {
    throw publicationError('ledger_replay_review_invalid', 'A matching reviewed audit and current authorized account scope are required.');
  }
  if (typeof store?.acquireLease !== 'function' || typeof store?.transactSave !== 'function'
    || typeof store?.get !== 'function' || typeof readHistory !== 'function') {
    throw publicationError('ledger_replay_publication_store_invalid', 'Publication requires the conditional ledger store and historical validator.');
  }
  const publicationKey = `replay_publication#${reviewedPreviewHash}`;
  const prior = await Promise.all(preview.accounts.map((row) => store.get(row.accountId, publicationKey)));
  const isPriorPublication = (marker, row) => marker?.accountId === row.accountId
    && marker.itemType === 'replay_publication' && marker.reviewedPreviewHash === reviewedPreviewHash
    && marker.beforeHash === row.beforeHash && marker.sourceFingerprint === row.sourceFingerprint
    && marker.proposedHash === row.proposedHash;
  if (prior.every((marker, index) => isPriorPublication(marker, preview.accounts[index]))) {
    return { status: 'already_published', published: true, reviewedPreviewHash, writeCount: 0 };
  }
  if (prior.some(Boolean)) {
    throw publicationError('ledger_replay_partial_publication', 'An earlier publication exists for part of this audit; inspect it before retrying.');
  }
  const ownerId = `reviewed-replay-${crypto.randomUUID()}`;
  for (const row of preview.accounts) {
    if (!await store.acquireLease(row.accountId, ownerId, { leaseMs: 120_000 })) {
      throw publicationError('ledger_replay_lease_unavailable', 'Another account reconciliation owns the ledger; publication was not started.');
    }
  }
  // New lifecycle IDs are UUIDs. Preserve the exact independently reviewed
  // identifiers instead of generating different IDs from the same fills. The
  // full artifact digest is checked above; real reconciliation must accept the
  // proposed state as a fixed point against freshly revalidated source bytes.
  for (const row of preview.accounts) {
    const freshHistory = await readHistory({ accountId: row.accountId, force: true });
    const records = await readReplayRecords(store, row.accountId);
    if (!verifiedHistory(freshHistory, row.accountId) || freshHistory.sourceFingerprint !== row.sourceFingerprint
      || recordsDigest(records) !== row.beforeHash) {
      throw publicationError('ledger_replay_evidence_changed', 'The ledger or source bytes changed; review a new preview.');
    }
    const projected = new Map(records.map((record) => [record.recordKey, record]));
    for (const entry of row.proposedWrites) {
      const previous = projected.get(entry.item.recordKey);
      if ((entry.createOnly === true && previous)
        || (entry.createOnly !== true && Number(previous?.version) !== entry.expectedVersion)) {
        throw publicationError('ledger_replay_evidence_changed', 'A reviewed conditional entry no longer matches the ledger.');
      }
      projected.set(entry.item.recordKey, deserializeLedgerItem(serializeLedgerItem(entry.item)));
    }
    const repeated = replayHistoricalEvidence(freshHistory, row.accountId, [...projected.values()], preview.generatedAt);
    const repeatedLater = replayHistoricalEvidence(freshHistory, row.accountId, [...projected.values()], new Date(Date.parse(preview.generatedAt) + 60_000).toISOString());
    if (repeated.status !== 'captured' || (repeated.writeEntries || []).length > 0
      || repeatedLater.status !== 'captured' || (repeatedLater.writeEntries || []).length > 0) {
      throw publicationError('ledger_replay_not_idempotent', 'The reviewed replay is no longer idempotent; review a new preview.');
    }
    const financialAudit = buildReplayReconciliationAudit({ accountId: row.accountId,
      records: [...projected.values()], existingRecords: records, history: freshHistory });
    if (!financialAudit.publicationSafe) {
      throw publicationError('ledger_replay_financial_unproven', 'A new or monetarily changed result lacks matching broker controls.');
    }
  }
  let writeCount = 0;
  for (const row of preview.accounts) {
    if (!await store.acquireLease(row.accountId, ownerId, { leaseMs: 120_000 })) {
      throw publicationError('ledger_replay_lease_unavailable', 'The account capture lease changed before publication.');
    }
    const freshHistory = await readHistory({ accountId: row.accountId, force: true });
    const records = await readReplayRecords(store, row.accountId);
    if (!verifiedHistory(freshHistory, row.accountId) || freshHistory.sourceFingerprint !== row.sourceFingerprint
      || recordsDigest(records) !== row.beforeHash) {
      throw publicationError('ledger_replay_evidence_changed', 'Evidence changed immediately before publication; review a new preview.');
    }
    if (typeof onBeforeAccountWrite === 'function') await onBeforeAccountWrite({ accountId: row.accountId, reviewedPreviewHash });
    const marker = {
      accountId: row.accountId, recordKey: publicationKey, itemType: 'replay_publication',
      reviewedPreviewHash, beforeHash: row.beforeHash, sourceFingerprint: row.sourceFingerprint,
      sourceManifest: row.sourceManifest, proposedHash: row.proposedHash,
      proposedWriteCount: row.proposedWriteCount, createdAt: new Date().toISOString(),
    };
    // This marker is last: oversized captures publish it only after every
    // conditional lifecycle group succeeds. Original reports are never changed.
    await persistCaptureEntries(store, [...row.proposedWrites, { item: marker, createOnly: true }]);
    writeCount += row.proposedWriteCount;
    if (typeof onAfterAccountWrite === 'function') await onAfterAccountWrite({ accountId: row.accountId, reviewedPreviewHash });
  }
  return { status: 'published', published: true, reviewedPreviewHash, writeCount };
}

module.exports = { previewPredictionMarketLedgerReplay, publishReviewedPredictionMarketLedgerReplay };
