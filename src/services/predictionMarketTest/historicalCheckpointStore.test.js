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
});
