const bundle = require('../../data/prediction-market-performance/historical-cpi-2026.json');
const {
  applyHistoricalImportBundle,
  createHistoricalSnapshotLifecycle,
  validateHistoricalImportBundle,
} = require('./predictionMarketHistoricalImport.cjs');

class MemoryStore {
  constructor() {
    this.records = new Map();
  }

  key(record) {
    return `${record.accountId}\u0000${record.recordKey}`;
  }

  async queryAccount(accountId) {
    return [...this.records.values()]
      .filter((record) => record.accountId === accountId)
      .map((record) => JSON.parse(JSON.stringify(record)));
  }

  async transactSave(entries) {
    entries.forEach(({ item, createOnly }) => {
      if (createOnly && this.records.has(this.key(item))) {
        throw Object.assign(new Error('conditional create failed'), { code: 'TransactionCanceledException' });
      }
    });
    entries.forEach(({ item }) => this.records.set(this.key(item), JSON.parse(JSON.stringify(item))));
    return entries.map(({ item }) => item);
  }
}

describe('prediction-market historical position imports', () => {
  test('validates the retained June and July IBKR evidence bundle', () => {
    const validated = validateHistoricalImportBundle(bundle);
    expect(validated.importId).toBe('cpi-history-2026-june-july-v1');
    expect(validated.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(validated.accounts).toEqual(expect.arrayContaining([
      expect.objectContaining({ accountId: 'U25779973', positions: expect.any(Array) }),
      expect.objectContaining({ accountId: 'U25465536', positions: expect.any(Array) }),
    ]));
    expect(validated.accounts.find((account) => account.accountId === 'U25779973').positions).toHaveLength(10);
  });

  test('keeps exact broker cost basis separate from incomplete historical basis', () => {
    const validated = validateHistoricalImportBundle(bundle);
    const positions = validated.accounts.find((account) => account.accountId === 'U25779973').positions;
    const complete = createHistoricalSnapshotLifecycle({
      accountId: 'U25779973',
      position: positions.find((position) => position.description === 'KXCPIYOY-26JUL-T3.3_YES'),
      importId: validated.importId,
      importedAt: '2026-08-15T04:30:00Z',
    });
    const incomplete = createHistoricalSnapshotLifecycle({
      accountId: 'U25779973',
      position: positions.find((position) => position.description === 'KXCPIYOY-26JUN-T3.8_YES'),
      importId: validated.importId,
      sequence: 2,
      importedAt: '2026-08-15T04:30:00Z',
    });

    expect(complete).toMatchObject({
      status: 'awaiting_resolution',
      market: 'cpi',
      contractSide: 'YES',
      strike: 3.3,
      risked: 7344.829675930499,
      costBasisComplete: true,
      feesComplete: false,
      verification: 'ibkr_historical_position_snapshot',
    });
    expect(incomplete).toMatchObject({
      status: 'awaiting_resolution',
      market: 'cpi',
      contractSide: 'YES',
      strike: 3.8,
      costBasisComplete: false,
      performanceComplete: false,
      partialCostBasisEvidence: {
        knownQuantity: 2500,
        totalQuantity: 3000,
        knownCostBasis: 1525,
        complete: false,
      },
    });
    expect(incomplete.risked).toBeNull();
  });

  test('imports each account atomically and is idempotent by evidence hash', async () => {
    const store = new MemoryStore();
    const first = await applyHistoricalImportBundle({
      store,
      bundle,
      now: '2026-08-15T04:30:00Z',
    });
    const second = await applyHistoricalImportBundle({
      store,
      bundle,
      now: '2026-08-15T04:31:00Z',
    });

    expect(first.accounts).toMatchObject({
      U25779973: { status: 'imported', count: 10 },
      U25465536: { status: 'imported', count: 1 },
    });
    expect(second.accounts).toMatchObject({
      U25779973: { status: 'already_imported', count: 10 },
      U25465536: { status: 'already_imported', count: 1 },
    });
    expect((await store.queryAccount('U25779973')).filter((record) => record.itemType === 'lifecycle')).toHaveLength(10);
  });

  test('rejects inferred or conflicting cost basis', () => {
    const conflicting = JSON.parse(JSON.stringify(bundle));
    const row = conflicting.accounts[0].positions.find((position) => position.costBasis != null);
    row.costBasis += 1;
    expect(() => validateHistoricalImportBundle(conflicting)).toThrow(/cost basis conflicted/i);
  });
});
