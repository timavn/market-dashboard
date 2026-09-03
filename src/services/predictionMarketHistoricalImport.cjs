const crypto = require('node:crypto');

const {
  createSnapshotLifecycle,
  hasSupportedContractIdentity,
} = require('./predictionMarketPerformanceLedger.cjs');

const HISTORICAL_IMPORT_SOURCE = 'ibkr_historical_position_snapshot';
const IMPORT_PREFIX = 'import#';
const EPSILON = 1e-8;

function importError(message, code) {
  return Object.assign(new Error(message), { code });
}

function text(value) {
  return String(value == null ? '' : value).trim();
}

function finite(value) {
  if (value == null || (typeof value === 'string' && value.trim() === '')) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function validIso(value) {
  const parsed = Date.parse(text(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function validSha256(value) {
  const normalized = text(value).toLowerCase();
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : null;
}

function canonicalDigest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function importRecordKey(importId) {
  const normalized = text(importId);
  if (!/^[a-z0-9][a-z0-9._-]{2,120}$/i.test(normalized)) {
    throw importError('Historical import id was invalid.', 'HISTORICAL_IMPORT_ID_INVALID');
  }
  return `${IMPORT_PREFIX}${normalized}`;
}

function sourceIndex(bundle = {}) {
  const sources = Array.isArray(bundle.sources) ? bundle.sources : [];
  const output = new Map();
  sources.forEach((source) => {
    const id = text(source?.id);
    const observedAt = validIso(source?.observedAt);
    const sha256 = validSha256(source?.sha256);
    const sourceType = text(source?.source);
    if (!id || output.has(id) || !observedAt || !sha256 || !sourceType) {
      throw importError('Historical import source evidence was invalid or duplicated.', 'HISTORICAL_IMPORT_SOURCE_INVALID');
    }
    output.set(id, {
      id,
      source: sourceType,
      observedAt,
      sha256,
      artifact: text(source.artifact) || null,
      sourceUrl: text(source.sourceUrl) || null,
    });
  });
  if (!output.size) throw importError('Historical import contained no source evidence.', 'HISTORICAL_IMPORT_SOURCE_REQUIRED');
  return output;
}

function normalizePosition(position = {}, accountId, sources) {
  const conId = finite(position.conId ?? position.conid);
  const quantity = finite(position.quantity ?? position.position);
  const symbol = text(position.symbol);
  const description = text(position.description || position.localSymbol);
  const source = sources.get(text(position.sourceId));
  const basisSource = sources.get(text(position.basisSourceId || position.sourceId));
  const identitySource = sources.get(text(position.identitySourceId || position.sourceId));
  const expiration = text(position.expiration);
  if (!Number.isInteger(conId) || conId <= 0 || quantity == null || quantity <= 0
    || !symbol || !description || !source || !basisSource || !identitySource || !/^20\d{6}$/.test(expiration)) {
    throw importError('Historical IBKR position evidence was incomplete.', 'HISTORICAL_IMPORT_POSITION_INVALID');
  }
  const positionAccount = text(position.accountId || position.account);
  if (positionAccount && positionAccount !== accountId) {
    throw importError('Historical IBKR position account did not match its import scope.', 'HISTORICAL_IMPORT_ACCOUNT_MISMATCH');
  }

  const avgCost = finite(position.avgCost ?? position.averageCost);
  const costBasis = finite(position.costBasis);
  if ((avgCost == null) !== (costBasis == null) || (avgCost != null && (avgCost < 0 || costBasis < 0))) {
    throw importError('Historical IBKR cost-basis evidence was incomplete.', 'HISTORICAL_IMPORT_BASIS_INVALID');
  }
  if (avgCost != null) {
    const expectedBasis = avgCost * quantity;
    const tolerance = Math.max(0.000001, Math.abs(costBasis) * 0.00000001);
    if (Math.abs(expectedBasis - costBasis) > tolerance) {
      throw importError('Historical IBKR average cost and cost basis conflicted.', 'HISTORICAL_IMPORT_BASIS_CONFLICT');
    }
  }

  const knownCostBasis = finite(position.knownCostBasis);
  const knownBasisQuantity = finite(position.knownBasisQuantity);
  if ((knownCostBasis == null) !== (knownBasisQuantity == null)
    || (knownCostBasis != null && (knownCostBasis < 0 || knownBasisQuantity <= 0 || knownBasisQuantity > quantity + EPSILON))) {
    throw importError('Partial historical cost-basis evidence was invalid.', 'HISTORICAL_IMPORT_PARTIAL_BASIS_INVALID');
  }

  return {
    accountId,
    conId,
    symbol,
    localSymbol: text(position.localSymbol) || null,
    description,
    quantity,
    position: quantity,
    avgCost,
    costBasis,
    knownCostBasis,
    knownBasisQuantity,
    expiration,
    secType: text(position.secType) || 'OPT',
    tradingClass: text(position.tradingClass) || null,
    exchange: text(position.exchange) || null,
    source,
    basisSource,
    identitySource,
  };
}

function validateHistoricalImportBundle(bundle = {}) {
  if (Number(bundle.schemaVersion) !== 1) {
    throw importError('Historical import schema version was unsupported.', 'HISTORICAL_IMPORT_SCHEMA_INVALID');
  }
  const importId = text(bundle.importId);
  importRecordKey(importId);
  const sources = sourceIndex(bundle);
  const accounts = Array.isArray(bundle.accounts) ? bundle.accounts : [];
  if (!accounts.length) throw importError('Historical import contained no account evidence.', 'HISTORICAL_IMPORT_ACCOUNT_REQUIRED');
  const seenAccounts = new Set();
  const normalizedAccounts = accounts.map((account) => {
    const accountId = text(account?.accountId);
    if (!/^U\d+$/.test(accountId) || seenAccounts.has(accountId)) {
      throw importError('Historical import account scope was invalid or duplicated.', 'HISTORICAL_IMPORT_ACCOUNT_INVALID');
    }
    seenAccounts.add(accountId);
    const positions = (Array.isArray(account.positions) ? account.positions : [])
      .map((position) => normalizePosition(position, accountId, sources));
    if (!positions.length || new Set(positions.map((position) => position.conId)).size !== positions.length) {
      throw importError('Historical import positions were empty or duplicated.', 'HISTORICAL_IMPORT_POSITION_DUPLICATE');
    }
    return { accountId, positions };
  });
  return {
    importId,
    recordKey: importRecordKey(importId),
    sourceHash: canonicalDigest(bundle),
    sources: [...sources.values()],
    accounts: normalizedAccounts,
  };
}

function createHistoricalSnapshotLifecycle({
  accountId,
  position,
  importId,
  sequence = 1,
  importedAt = new Date().toISOString(),
} = {}) {
  const now = validIso(importedAt);
  if (!now) throw importError('Historical import observation time was invalid.', 'HISTORICAL_IMPORT_TIME_INVALID');
  const lifecycle = createSnapshotLifecycle({
    accountId,
    position: {
      ...position,
      accountId,
      position: position.quantity,
    },
    sequence,
    now,
  });
  const exactCostBasis = finite(position.costBasis);
  const basisComplete = exactCostBasis != null;
  const identitySupported = hasSupportedContractIdentity(lifecycle);
  lifecycle.status = identitySupported ? 'awaiting_resolution' : 'review';
  lifecycle.verification = HISTORICAL_IMPORT_SOURCE;
  lifecycle.reviewReason = identitySupported ? null : 'unsupported_contract_identity';
  lifecycle.openedAt = position.source.observedAt;
  lifecycle.expiration = position.expiration;
  lifecycle.netQuantity = position.quantity;
  lifecycle.entryQuantity = position.quantity;
  lifecycle.entryPrincipal = basisComplete ? exactCostBasis : null;
  lifecycle.fees = null;
  lifecycle.feesComplete = false;
  lifecycle.costBasisComplete = basisComplete;
  lifecycle.performanceComplete = basisComplete;
  lifecycle.risked = basisComplete ? exactCostBasis : null;
  lifecycle.paid = 0;
  lifecycle.pnl = null;
  lifecycle.roi = null;
  lifecycle.lastPositionQuantity = position.quantity;
  lifecycle.lastPositionObservedAt = position.source.observedAt;
  lifecycle.historicalImportId = importId;
  lifecycle.brokerCostBasis = basisComplete ? exactCostBasis : null;
  lifecycle.costBasisSource = basisComplete ? 'ibkr_reported_position_cost_basis' : null;
  lifecycle.basisBreakdownAvailable = false;
  lifecycle.positionSnapshotEvidence = {
    source: position.source.source,
    observedAt: position.source.observedAt,
    sourceHash: position.source.sha256,
    sourceArtifact: position.source.artifact,
    quantity: position.quantity,
    conId: position.conId,
    description: position.description,
  };
  lifecycle.contractIdentityEvidence = {
    source: position.identitySource.source,
    observedAt: position.identitySource.observedAt,
    sourceHash: position.identitySource.sha256,
    sourceArtifact: position.identitySource.artifact,
    sourceUrl: position.identitySource.sourceUrl,
    expiration: position.expiration,
  };
  lifecycle.costBasisEvidence = basisComplete ? {
    source: position.basisSource.source,
    observedAt: position.basisSource.observedAt,
    sourceHash: position.basisSource.sha256,
    sourceArtifact: position.basisSource.artifact,
    averageCost: position.avgCost,
    costBasis: exactCostBasis,
  } : null;
  lifecycle.partialCostBasisEvidence = position.knownCostBasis == null ? null : {
    source: position.basisSource.source,
    observedAt: position.basisSource.observedAt,
    sourceHash: position.basisSource.sha256,
    sourceArtifact: position.basisSource.artifact,
    knownQuantity: position.knownBasisQuantity,
    totalQuantity: position.quantity,
    knownCostBasis: position.knownCostBasis,
    complete: false,
  };
  lifecycle.updatedAt = now;
  lifecycle.createdAt = now;
  return lifecycle;
}

function sameImportedContract(record = {}, position = {}) {
  return record.itemType === 'lifecycle'
    && Number(record.conId) === Number(position.conId)
    && String(record.expiration || '') === String(position.expiration || '')
    && Math.abs(Number(record.entryQuantity || 0) - Number(position.quantity || 0)) <= EPSILON;
}

async function applyHistoricalImportBundle({ store, bundle, now = new Date().toISOString() } = {}) {
  if (!store?.queryAccount || !store?.transactSave) {
    throw importError('Historical import requires the persistent ledger store.', 'HISTORICAL_IMPORT_STORE_REQUIRED');
  }
  const importedAt = validIso(now);
  if (!importedAt) throw importError('Historical import time was invalid.', 'HISTORICAL_IMPORT_TIME_INVALID');
  const validated = validateHistoricalImportBundle(bundle);
  const results = {};
  for (const account of validated.accounts) {
    const scopedReadsAvailable = typeof store.queryAccountPrefix === 'function' && typeof store.get === 'function';
    const [existing, marker] = await (scopedReadsAvailable
      ? Promise.all([
        store.queryAccountPrefix(account.accountId, 'lifecycle#'),
        store.get(account.accountId, validated.recordKey),
      ])
      : store.queryAccount(account.accountId).then((records) => [
        records,
        records.find((record) => record.recordKey === validated.recordKey && record.itemType === 'import') || null,
      ]));
    if (marker) {
      if (marker.sourceHash !== validated.sourceHash) {
        throw importError('A historical import id already exists with different evidence.', 'HISTORICAL_IMPORT_CONFLICT');
      }
      results[account.accountId] = { status: 'already_imported', count: Number(marker.lifecycleCount || 0) };
      continue;
    }

    const entries = [];
    const recordKeys = [];
    for (const position of account.positions) {
      const existingContract = existing.find((record) => sameImportedContract(record, position));
      if (existingContract) {
        if (existingContract.historicalImportId !== validated.importId) {
          throw importError('Historical import conflicts with an existing lifecycle.', 'HISTORICAL_IMPORT_LIFECYCLE_CONFLICT');
        }
        recordKeys.push(existingContract.recordKey);
        continue;
      }
      const sequence = existing.filter((record) => (
        record.itemType === 'lifecycle' && Number(record.conId) === position.conId
      )).length + entries.filter(({ item }) => Number(item.conId) === position.conId).length + 1;
      const lifecycle = createHistoricalSnapshotLifecycle({
        accountId: account.accountId,
        position,
        importId: validated.importId,
        sequence,
        importedAt,
      });
      entries.push({ item: lifecycle, createOnly: true });
      recordKeys.push(lifecycle.recordKey);
    }
    const importRecord = {
      accountId: account.accountId,
      recordKey: validated.recordKey,
      itemType: 'import',
      importId: validated.importId,
      source: HISTORICAL_IMPORT_SOURCE,
      sourceHash: validated.sourceHash,
      sourceEvidence: validated.sources,
      lifecycleCount: recordKeys.length,
      lifecycleRecordKeys: recordKeys,
      createdAt: importedAt,
      updatedAt: importedAt,
    };
    entries.push({ item: importRecord, createOnly: true });
    try {
      await store.transactSave(entries);
    } catch (error) {
      if (!['ConditionalCheckFailedException', 'TransactionCanceledException'].includes(error?.code)) throw error;
      const concurrent = scopedReadsAvailable
        ? await store.get(account.accountId, validated.recordKey)
        : (await store.queryAccount(account.accountId))
          .find((record) => record.recordKey === validated.recordKey && record.itemType === 'import');
      if (!concurrent || concurrent.sourceHash !== validated.sourceHash) throw error;
      results[account.accountId] = { status: 'already_imported', count: Number(concurrent.lifecycleCount || 0) };
      continue;
    }
    results[account.accountId] = { status: 'imported', count: recordKeys.length };
  }
  return { status: 'complete', importId: validated.importId, sourceHash: validated.sourceHash, accounts: results };
}

module.exports = {
  HISTORICAL_IMPORT_SOURCE,
  applyHistoricalImportBundle,
  canonicalDigest,
  createHistoricalSnapshotLifecycle,
  importRecordKey,
  validateHistoricalImportBundle,
};
