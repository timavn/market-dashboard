const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHistoricalCheckpointStore } = require('./historicalCheckpointStore.cjs');

const NOW = Date.parse('2026-08-29T20:00:00.000Z');
const THROUGH = '2026-08-28';
const CONTRACT = Object.freeze({
  provider: 'ibkr', symbol: 'SI', ibkrSymbol: 'SI', displaySymbol: 'SIZ26', localSymbol: 'SIZ26',
  conId: 4242, secType: 'FUT', exchange: 'COMEX', currency: 'USD', multiplier: '5000',
  lastTradeDateOrContractMonth: '20261229', tradingClass: 'SI',
});

function completedBars() {
  return ['2026-08-26', '2026-08-27', '2026-08-28'].flatMap((date, index) => [
    { date: `${date} 09:30:00`, open: 60 + index, high: 61 + index, low: 59 + index, close: 60.5 + index, volume: 100 },
    { date: `${date} 15:55:00`, open: 60.5 + index, high: 62 + index, low: 60 + index, close: 61 + index, volume: 120 },
  ]);
}

describe('verified historical checkpoint store', () => {
  let stateDirectory;

  beforeEach(() => {
    stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-checkpoint-test-'));
  });

  afterEach(() => {
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  });

  test('atomically persists an owner-only selected identity and completed history', () => {
    const store = createHistoricalCheckpointStore({ stateDirectory, now: () => NOW, logger: { warn: jest.fn() } });
    expect(store.saveSelection('silver', CONTRACT, 'initial_three_session_median_volume')).toBe(true);
    expect(store.saveHistory({
      marketId: 'silver', contract: CONTRACT, interval: '1h', bars: completedBars(),
      sourceTimestamp: new Date(NOW - 1_000).toISOString(), completedThroughDate: THROUGH, provenance: 'ibkr',
    })).toBe(true);
    expect(store.loadSelection('silver')).toMatchObject({ conId: 4242, localSymbol: 'SIZ26' });
    expect(store.loadHistory({ marketId: 'silver', contract: CONTRACT, interval: '1h', completedThroughDate: THROUGH })).toMatchObject({
      source: 'ibkr_completed_history_checkpoint',
      restoredFromCheckpoint: true,
      executable: false,
      contract: { conId: 4242 },
    });
    expect(fs.statSync(store.filePath).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(stateDirectory).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  test('rejects wrong conId, forbidden provenance, future bars, and missing completed coverage', () => {
    const store = createHistoricalCheckpointStore({ stateDirectory, now: () => NOW, logger: { warn: jest.fn() } });
    expect(store.saveHistory({
      marketId: 'silver', contract: CONTRACT, interval: '1h', bars: completedBars(),
      sourceTimestamp: new Date(NOW - 1_000).toISOString(), completedThroughDate: THROUGH, provenance: 'cached-disconnected',
    })).toBe(false);
    expect(store.saveHistory({
      marketId: 'silver', contract: CONTRACT, interval: '1h',
      bars: [{ date: NOW + 60_000, close: 70 }, { date: NOW + 120_000, close: 71 }],
      sourceTimestamp: new Date(NOW).toISOString(), completedThroughDate: THROUGH, provenance: 'ibkr',
    })).toBe(false);
    expect(store.saveHistory({
      marketId: 'silver', contract: CONTRACT, interval: '1h', bars: completedBars().slice(0, 4),
      sourceTimestamp: new Date(NOW).toISOString(), completedThroughDate: THROUGH, provenance: 'ibkr',
    })).toBe(false);
    expect(store.saveHistory({
      marketId: 'silver', contract: CONTRACT, interval: '1h', bars: completedBars(),
      sourceTimestamp: new Date(NOW).toISOString(), completedThroughDate: THROUGH, provenance: 'ibkr',
    })).toBe(true);
    expect(store.loadHistory({
      marketId: 'silver', contract: { ...CONTRACT, conId: 9999 }, interval: '1h', completedThroughDate: THROUGH,
    })).toBeNull();
  });

  test('fails closed on a corrupt checkpoint without deleting it', () => {
    const logger = { warn: jest.fn() };
    const store = createHistoricalCheckpointStore({ stateDirectory, now: () => NOW, logger });
    fs.writeFileSync(store.filePath, '{not-json', { mode: 0o600 });
    const reloaded = createHistoricalCheckpointStore({ stateDirectory, now: () => NOW, logger });
    expect(reloaded.loadSelection('silver')).toBeNull();
    expect(fs.readFileSync(store.filePath, 'utf8')).toBe('{not-json');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/Ignoring invalid directional checkpoint/));
  });

  describe('exact stored history contract resolution', () => {
    const ES_NOW = Date.parse('2026-09-14T23:30:00.000Z');
    const ES_THROUGH = '2026-09-14';
    const esContract = {
      provider: 'ibkr', symbol: 'ES', ibkrSymbol: 'ES', displaySymbol: 'ESU6', localSymbol: 'ESU6',
      conId: 649180671, secType: 'FUT', exchange: 'CME', currency: 'USD', multiplier: '50',
      lastTradeDateOrContractMonth: '20260918', tradingClass: 'ES',
    };
    const requested = {
      provider: 'ibkr', symbol: 'ES', ibkrSymbol: 'ES', displaySymbol: 'ESU26',
      secType: 'FUT', exchange: 'CME', currency: 'USD', multiplier: '50',
      lastTradeDateOrContractMonth: '202609', tradingClass: 'ES',
    };
    const request = { marketId: 'sp500', contract: requested, interval: '1h', completedThroughDate: ES_THROUGH };
    const bars = [
      { date: '2026-09-14T14:00:00.000Z', open: 6500, high: 6510, low: 6490, close: 6505, volume: 100 },
      { date: '2026-09-14T20:00:00.000Z', open: 6505, high: 6515, low: 6500, close: 6510, volume: 120 },
    ];

    function savedStore() {
      const store = createHistoricalCheckpointStore({ stateDirectory, now: () => ES_NOW, logger: { warn: jest.fn() } });
      expect(store.saveHistory({ ...request, contract: esContract, bars, sourceTimestamp: new Date(ES_NOW - 1_000).toISOString() })).toBe(true);
      return store;
    }

    function mutateEntry(store, update) {
      const state = JSON.parse(fs.readFileSync(store.filePath, 'utf8'));
      update(state.histories['sp500:649180671:1h'], state);
      fs.writeFileSync(store.filePath, JSON.stringify(state));
      return createHistoricalCheckpointStore({ stateDirectory, now: () => ES_NOW, logger: { warn: jest.fn() } });
    }

    test('resolves current broker-qualified identity read-only and loads completed history without claiming a live quote', () => {
      const store = savedStore();
      const before = fs.readFileSync(store.filePath, 'utf8');
      expect(store.loadHistory(request)).toBeNull();
      const identity = store.resolveHistoryContract(request);
      expect(identity).toEqual(esContract);
      expect(identity).not.toHaveProperty('price');
      expect(identity).not.toHaveProperty('status');
      expect(identity).not.toHaveProperty('bars');
      const history = store.loadHistory({ ...request, contract: identity });
      expect(history).toMatchObject({ executable: false, restoredFromCheckpoint: true, asOf: new Date(ES_NOW - 1_000).toISOString(), bars });
      expect(fs.readFileSync(store.filePath, 'utf8')).toBe(before);
      // Quote connectivity is independently owned by the caller; historical identity is not live data.
      const reopened = createHistoricalCheckpointStore({ stateDirectory, now: () => ES_NOW });
      expect(reopened.resolveHistoryContract(request)).toEqual(identity);
    });

    test.each([
      ['delivery month', { lastTradeDateOrContractMonth: '202612' }],
      ['decade-ambiguous local-symbol year', { lastTradeDateOrContractMonth: '203609' }],
      ['missing month', { lastTradeDateOrContractMonth: undefined }],
      ['conflicting month', { contractMonth: '202612' }],
      ['wrong root', { symbol: 'MES' }],
      ['conflicting root', { ibkrSymbol: 'MES' }],
      ['exchange', { exchange: 'NYMEX' }],
      ['currency', { currency: 'EUR' }],
      ['trading class', { tradingClass: 'MES' }],
      ['multiplier', { multiplier: '5' }],
      ['provider', { provider: 'yahoo' }],
      ['security type', { secType: 'STK' }],
      ['conId', { conId: 999 }],
      ['local symbol', { localSymbol: 'ESZ6' }],
      ['inferred identity', { inferred: true }],
    ])('rejects requested %s mismatch', (_label, changes) => {
      expect(savedStore().resolveHistoryContract({ ...request, contract: { ...requested, ...changes } })).toBeNull();
    });

    test.each(['exchange', 'currency', 'tradingClass', 'multiplier', 'localSymbol', 'provider', 'secType'])('does not invent missing stored %s', (field) => {
      const store = mutateEntry(savedStore(), (entry) => { delete entry.contract[field]; });
      expect(store.resolveHistoryContract(request)).toBeNull();
    });

    test.each(['20260911', '202609', '2026091', '20260230', 'invalid', ''])('rejects expired or malformed stored expiry %s', (expiry) => {
      const store = mutateEntry(savedStore(), (entry) => { entry.contract.lastTradeDateOrContractMonth = expiry; });
      expect(store.resolveHistoryContract(request)).toBeNull();
    });

    test.each([
      ['missing provenance', (entry) => { delete entry.provenance; }],
      ['unverified provenance', (entry) => { entry.provenance = 'ibkr'; }],
      ['offline cache', (entry) => { entry.provenance = 'cached-disconnected'; }],
      ['mock provenance', (entry) => { entry.provenance = 'mock'; }],
      ['seed provenance', (entry) => { entry.provenance = 'seed'; }],
      ['inferred identity', (entry) => { entry.contract.inferred = true; }],
      ['mock identity provenance', (entry) => { entry.contract.provenance = 'mock'; }],
      ['offline identity provenance', (entry) => { entry.contract.provenance = 'cached-disconnected'; }],
      ['inferred history', (entry) => { entry.inferred = true; }],
      ['cache-only history', (entry) => { entry.cacheOnly = true; }],
      ['cost-basis history', (entry) => { entry.costBasisDerived = true; }],
      ['wrong provider', (entry) => { entry.provider = 'yahoo'; }],
      ['wrong market', (entry) => { entry.marketId = 'silver'; }],
      ['wrong schema', (entry) => { entry.schemaVersion = 2; }],
      ['bad timestamp', (entry) => { entry.sourceTimestamp = 'invalid'; }],
      ['future timestamp', (entry) => { entry.sourceTimestamp = new Date(ES_NOW + 60_000).toISOString(); }],
      ['timestamp predating observations', (entry) => { entry.sourceTimestamp = '2026-09-13T23:00:00Z'; }],
      ['missing history', (entry) => { entry.bars = []; }],
      ['wrong local delivery', (entry) => { entry.contract.localSymbol = 'ESZ6'; }],
      ['conflicting stored month', (entry) => { entry.contract.contractMonth = '202612'; }],
    ])('rejects %s in a saved checkpoint', (_label, update) => {
      expect(mutateEntry(savedStore(), update).resolveHistoryContract(request)).toBeNull();
    });

    test('rejects multiple broker conIds matching the exact request rather than picking one', () => {
      const store = savedStore();
      expect(store.saveHistory({ ...request, contract: { ...esContract, conId: 649180672 }, bars, sourceTimestamp: new Date(ES_NOW).toISOString() })).toBe(true);
      expect(store.resolveHistoryContract(request)).toBeNull();
      expect(store.resolveHistoryContract({ ...request, contract: { ...requested, conId: esContract.conId } })).toEqual(esContract);
    });

    test('does not reuse a different interval or completed market date', () => {
      const store = savedStore();
      expect(store.resolveHistoryContract({ ...request, interval: '5m' })).toBeNull();
      expect(store.resolveHistoryContract({ ...request, completedThroughDate: '2026-09-11' })).toBeNull();
    });

    test('uses the local symbol delivery month when energy last trade occurs in the preceding month', () => {
      const store = createHistoricalCheckpointStore({ stateDirectory, now: () => NOW });
      const contract = { ...CONTRACT, symbol: 'CL', ibkrSymbol: 'CL', localSymbol: 'CLU26', displaySymbol: 'CLU26', exchange: 'NYMEX', tradingClass: 'CL', multiplier: '1000', lastTradeDateOrContractMonth: '20260831' };
      expect(store.saveHistory({ marketId: 'wti', contract, interval: '1h', bars: completedBars(), sourceTimestamp: new Date(NOW).toISOString(), completedThroughDate: THROUGH })).toBe(true);
      const requestedContract = { ...contract, conId: undefined, lastTradeDateOrContractMonth: '202609' };
      expect(store.resolveHistoryContract({ marketId: 'wti', contract: requestedContract, interval: '1h', completedThroughDate: THROUGH })).toEqual(contract);
    });

    test('accepts corroborated one-digit delivery years when energy expiry occurs in the prior year', () => {
      const store = createHistoricalCheckpointStore({ stateDirectory, now: () => NOW });
      const contract = { ...CONTRACT, symbol: 'CL', ibkrSymbol: 'CL', localSymbol: 'CLF7', displaySymbol: 'CLF7', exchange: 'NYMEX', tradingClass: 'CL', multiplier: '1000', lastTradeDateOrContractMonth: '20261221' };
      expect(store.saveHistory({ marketId: 'wti', contract, interval: '1h', bars: completedBars(), sourceTimestamp: new Date(NOW).toISOString(), completedThroughDate: THROUGH })).toBe(true);
      const requestedContract = { ...contract, conId: undefined, lastTradeDateOrContractMonth: '202701' };
      expect(store.resolveHistoryContract({ marketId: 'wti', contract: requestedContract, interval: '1h', completedThroughDate: THROUGH })).toEqual(contract);
    });
  });
});
