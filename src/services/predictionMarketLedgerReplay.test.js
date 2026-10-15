const crypto = require('node:crypto');
const { previewPredictionMarketLedgerReplay, publishReviewedPredictionMarketLedgerReplay } = require('./predictionMarketLedgerReplay.cjs');

const now = '2026-09-11T18:00:00.000Z';
const accountId = 'U123';
const sourceManifest = [{ name: '2026-09-10.json', sha256: 'a'.repeat(64), reportHash: 'b'.repeat(64) }];
const sourceFingerprint = crypto.createHash('sha256').update(JSON.stringify(sourceManifest)).digest('hex');
function history(overrides = {}) {
  return {
    status: 'ready', complete: true, controls: { zeroToCent: true }, validationVersion: 2,
    sourceManifest, sourceFingerprint, sourceHashes: [sourceManifest[0].sha256],
    snapshotId: 'flex-verified-fixture', fetchedAt: '2026-09-11T04:00:00.000Z', toDate: '2026-09-10',
    trades: [{
      accountId, execId: 'flex-opening', conId: 9001,
      symbol: 'KXWTI-26AUG13-T81.49-YES', localSymbol: 'KXWTI-26AUG13-T81.49-YES',
      exchange: 'KALSHI', secType: 'OPT', expiration: '20260813', strike: 81.49,
      contractSide: 'YES', side: 'BUY', quantity: 10, price: 0.25, commission: 0.1,
      executionTime: '2026-08-12T15:00:00.000Z', source: 'ibkr_flex_import',
      netCash: -2.6, netCashMicros: -2600000, brokerIdentifierStatus: 'reported', rawFingerprint: 'c'.repeat(64),
    }],
    ...overrides,
  };
}

function store(records = []) {
  return {
    queryAccountPrefix: jest.fn(async (_account, prefix) => records.filter((record) => record.recordKey.startsWith(prefix))),
    put: jest.fn(() => { throw new Error('No publication authorized'); }),
    transactSave: jest.fn(() => { throw new Error('No publication authorized'); }),
  };
}

describe('stored-source ledger replay preview', () => {
  test('uses real reconciliation against stored records, proves repeat idempotency and never publishes', async () => {
    const ledger = store();
    const source = history();
    const unchanged = JSON.stringify(source);
    const readHistory = jest.fn(async () => source);
    const preview = await previewPredictionMarketLedgerReplay({ store: ledger, accountIds: [accountId], readHistory, now });
    expect(preview).toMatchObject({ mode: 'preview_only', published: false, status: 'ready_for_review' });
    expect(preview.accounts[0]).toMatchObject({
      status: 'ready_for_review', idempotent: true, existingRecordCount: 0, executionCount: 1,
      sourceFingerprint, sourceManifest,
    });
    expect(preview.accounts[0].proposedWriteCount).toBeGreaterThan(0);
    expect(preview.accounts[0].proposedWrites).toEqual(expect.arrayContaining([
      expect.objectContaining({ item: expect.objectContaining({ itemType: 'execution', execId: 'flex-opening' }) }),
    ]));
    expect(readHistory).toHaveBeenCalledTimes(2);
    expect(readHistory).toHaveBeenNthCalledWith(1, { accountId, force: true });
    expect(ledger.queryAccountPrefix).toHaveBeenCalledTimes(6);
    expect(ledger.put).not.toHaveBeenCalled();
    expect(ledger.transactSave).not.toHaveBeenCalled();
    expect(JSON.stringify(source)).toBe(unchanged);
  });

  test.each([
    ['incomplete', { complete: false }],
    ['source conflict', { status: 'conflict' }],
    ['unbalanced accounting', { controls: { zeroToCent: false } }],
    ['old validator', { validationVersion: 1 }],
    ['missing source bytes', { sourceManifest: [] }],
    ['forged fingerprint', { sourceFingerprint: 'd'.repeat(64) }],
    ['another account', { trades: [{ accountId: 'U456' }] }],
  ])('blocks %s before querying the ledger', async (_name, overrides) => {
    const ledger = store();
    const result = await previewPredictionMarketLedgerReplay({
      store: ledger, accountIds: [accountId], readHistory: async () => history(overrides), now,
    });
    expect(result).toMatchObject({ status: 'blocked', published: false, accounts: [
      expect.objectContaining({ reason: 'historical_evidence_unverified' }),
    ] });
    expect(ledger.queryAccountPrefix).not.toHaveBeenCalled();
  });

  test('blocks a changed actual ledger during the preview', async () => {
    const ledger = store();
    ledger.queryAccountPrefix.mockImplementation(async (_account, prefix) => (
      ledger.queryAccountPrefix.mock.calls.length > 3 && prefix === 'health#capture'
        ? [{ accountId, itemType: 'health', recordKey: 'health#capture', version: 2 }] : []
    ));
    const result = await previewPredictionMarketLedgerReplay({ store: ledger, accountIds: [accountId], readHistory: async () => history(), now });
    expect(result.accounts[0]).toMatchObject({ status: 'blocked', reason: 'evidence_changed_during_preview' });
    expect(ledger.transactSave).not.toHaveBeenCalled();
  });

  test('blocks changed source bytes after reconciliation', async () => {
    const changedManifest = [{ ...sourceManifest[0], sha256: 'd'.repeat(64) }];
    const changed = history({ sourceManifest: changedManifest,
      sourceFingerprint: crypto.createHash('sha256').update(JSON.stringify(changedManifest)).digest('hex') });
    const readHistory = jest.fn().mockResolvedValueOnce(history()).mockResolvedValueOnce(changed);
    const result = await previewPredictionMarketLedgerReplay({ store: store(), accountIds: [accountId], readHistory, now });
    expect(result.accounts[0]).toMatchObject({ status: 'blocked', reason: 'evidence_changed_during_preview' });
  });

  test('a fixed-point replay with duplicate conditional target keys is still blocked', async () => {
    jest.doMock('./predictionMarketPerformanceLedger.cjs', () => {
      const actual = jest.requireActual('./predictionMarketPerformanceLedger.cjs');
      return { ...actual, reconcileEvidence: (args) => {
        const result = actual.reconcileEvidence(args);
        return result.writeEntries?.length ? { ...result, writeEntries: [...result.writeEntries, result.writeEntries[0]] } : result;
      } };
    });
    try {
      let previewWithDuplicate;
      jest.isolateModules(() => { previewWithDuplicate = require('./predictionMarketLedgerReplay.cjs').previewPredictionMarketLedgerReplay; });
      const result = await previewWithDuplicate({ store: store(), accountIds: [accountId], readHistory: async () => history(), now });
      expect(result.accounts[0]).toMatchObject({ status: 'blocked', reason: 'duplicate_or_invalid_write_keys', idempotent: true });
      expect(result.accounts[0].duplicateWriteKeys).toHaveLength(1);
    } finally { jest.dontMock('./predictionMarketPerformanceLedger.cjs'); }
  });

  test('refuses cross-account ledger records and invalid account scopes', async () => {
    const ledger = store([{ accountId: 'U456', itemType: 'execution', recordKey: 'execution#foreign' }]);
    await expect(previewPredictionMarketLedgerReplay({ store: ledger, accountIds: [accountId], readHistory: async () => history(), now }))
      .rejects.toMatchObject({ code: 'ledger_replay_account_mismatch' });
    await expect(previewPredictionMarketLedgerReplay({ store: ledger, accountIds: [], readHistory: async () => history(), now }))
      .rejects.toMatchObject({ code: 'ledger_replay_preview_scope_invalid' });
  });

  async function publicationFixture() {
    const records = new Map();
    const ledger = {
      queryAccountPrefix: jest.fn(async (_account, prefix) => [...records.values()].filter((record) => record.recordKey.startsWith(prefix))),
      get: jest.fn(async (_account, key) => records.get(key) || null),
      acquireLease: jest.fn(async () => true),
      transactSave: jest.fn(async (entries) => {
        entries.forEach(({ item, createOnly, expectedVersion }) => {
          if (createOnly) expect(records.has(item.recordKey)).toBe(false);
          else expect(records.get(item.recordKey)?.version).toBe(expectedVersion);
        });
        entries.forEach(({ item }) => records.set(item.recordKey, item));
        return entries.map(({ item }) => item);
      }),
    };
    const readHistory = jest.fn(async () => history());
    const preview = await previewPredictionMarketLedgerReplay({ store: ledger, accountIds: [accountId], readHistory, now });
    const publish = (overrides = {}) => publishReviewedPredictionMarketLedgerReplay({
      preview, reviewedPreviewHash: preview.previewHash, authorizedAccountIds: [accountId],
      store: ledger, readHistory, ...overrides,
    });
    return { records, ledger, readHistory, preview, publish };
  }

  test('publishes only a matching review through conditional capture entries and an immutable audit marker', async () => {
    const fixture = await publicationFixture();
    const before = jest.fn();
    const after = jest.fn();
    expect(await fixture.publish({ onBeforeAccountWrite: before, onAfterAccountWrite: after }))
      .toMatchObject({ status: 'published', published: true, writeCount: fixture.preview.accounts[0].proposedWriteCount });
    const marker = fixture.records.get(`replay_publication#${fixture.preview.previewHash}`);
    expect(marker).toMatchObject({
      accountId, itemType: 'replay_publication', reviewedPreviewHash: fixture.preview.previewHash,
      sourceFingerprint, beforeHash: fixture.preview.accounts[0].beforeHash,
    });
    expect(before).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1);
    const writeCalls = fixture.ledger.transactSave.mock.calls.length;
    expect(await fixture.publish()).toMatchObject({ status: 'already_published', writeCount: 0 });
    expect(fixture.ledger.transactSave).toHaveBeenCalledTimes(writeCalls);
  });

  test.each(['wrong review hash', 'removed authorization', 'tampered proposed writes'])('blocks %s before a lease or write', async (scenario) => {
    const fixture = await publicationFixture();
    const overrides = scenario === 'wrong review hash' ? { reviewedPreviewHash: 'f'.repeat(64) }
      : scenario === 'removed authorization' ? { authorizedAccountIds: ['U999'] }
        : { preview: { ...fixture.preview, accounts: [{ ...fixture.preview.accounts[0], proposedWrites: [] }] } };
    await expect(fixture.publish(overrides)).rejects.toMatchObject({ code: 'ledger_replay_review_invalid' });
    expect(fixture.ledger.acquireLease).not.toHaveBeenCalled();
    expect(fixture.ledger.transactSave).not.toHaveBeenCalled();
  });

  test('blocks publication when the account capture lease is owned elsewhere', async () => {
    const fixture = await publicationFixture();
    fixture.ledger.acquireLease.mockResolvedValue(false);
    await expect(fixture.publish()).rejects.toMatchObject({ code: 'ledger_replay_lease_unavailable' });
    expect(fixture.ledger.transactSave).not.toHaveBeenCalled();
  });

  test.each(['ledger', 'source'])('blocks changed %s evidence after review', async (which) => {
    const fixture = await publicationFixture();
    if (which === 'ledger') fixture.records.set('health#capture', { accountId, itemType: 'health', recordKey: 'health#capture', version: 1 });
    else fixture.readHistory.mockResolvedValue(history({ complete: false }));
    await expect(fixture.publish()).rejects.toMatchObject({ code: 'ledger_replay_evidence_changed' });
    expect(fixture.ledger.transactSave).not.toHaveBeenCalled();
  });

  test('a conditional write failure never publishes the completion marker', async () => {
    const fixture = await publicationFixture();
    fixture.ledger.transactSave.mockRejectedValue(Object.assign(new Error('Concurrent change'), { code: 'TransactionCanceledException' }));
    await expect(fixture.publish()).rejects.toMatchObject({ code: 'TransactionCanceledException' });
    expect(fixture.records.has(`replay_publication#${fixture.preview.previewHash}`)).toBe(false);
  });
});
