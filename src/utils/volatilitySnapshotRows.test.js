import {
  isDisplayableVolatilityRow,
  isRefreshDelayedVolatilityRow,
  sanitizeExpiredVolatilityReferences,
  sanitizeVolatilitySnapshot,
  reconcileVolatilitySnapshot,
} from './volatilitySnapshotRows';

const NOW = new Date('2026-07-13T20:45:00.000Z').getTime();

const retainedRow = (overrides = {}) => ({
  source: 'cboe',
  lastPx: 21.51,
  day1Ago: 20.72,
  availability: 'reference',
  freshness: 'refresh-delayed',
  refreshDelayed: true,
  lastVerifiedAt: '2026-07-13T20:44:00.000Z',
  retainedUntil: '2026-07-13T21:14:00.000Z',
  asOf: '2026-07-13T20:15:00.000Z',
  ...overrides,
});

describe('volatility snapshot row states', () => {
  test.each([
    null,
    { availability: 'unavailable', lastPx: null },
    { ...retainedRow(), mock: true },
    { ...retainedRow(), source: 'seed' },
    { ...retainedRow(), cacheOnly: true },
    { ...retainedRow(), providerStatus: 'offline' },
    { ...retainedRow(), lastPx: 99, asOf: '2026-07-12T20:15:00.000Z' },
  ])('does not let a missing, rejected or older row overwrite a verified observation: %j', (incoming) => {
    const previous = retainedRow({ dayChangePct: 2.5 });
    const next = reconcileVolatilitySnapshot({
      currentData: { VIX: previous }, incomingData: { VIX: incoming }, nowMs: NOW,
    });
    expect(next.VIX).toMatchObject({ lastPx: 21.51, dayChangePct: 2.5, asOf: previous.asOf, executable: false });
  });

  test('accepts a newer verified reading and keeps history omitted from the same observation', () => {
    const previous = retainedRow({ dayChangePct: 2.5 });
    const newest = { ...previous, lastPx: 22, asOf: '2026-07-13T20:40:00.000Z' };
    const advanced = reconcileVolatilitySnapshot({ currentData: { VIX: previous }, incomingData: { VIX: newest }, nowMs: NOW });
    expect(advanced.VIX.lastPx).toBe(22);
    const partial = reconcileVolatilitySnapshot({ currentData: advanced, incomingData: { VIX: { ...newest, dayChangePct: null } }, nowMs: NOW });
    expect(partial.VIX.dayChangePct).toBe(2.5);
    expect(partial.VIX.asOf).toBe(newest.asOf);
  });

  test('allows a still-fresh retained row only as an explicit display reference', () => {
    const row = retainedRow();

    expect(isRefreshDelayedVolatilityRow(row, NOW)).toBe(true);
    expect(isDisplayableVolatilityRow('NazVol', row, NOW)).toBe(true);
  });

  test('keeps verified reference values beyond their former expiry', () => {
    const snapshot = { NazVol: retainedRow() };
    const sanitized = sanitizeExpiredVolatilityReferences(
      snapshot,
      new Date('2026-07-13T21:14:00.001Z').getTime(),
    );

    expect(sanitized.NazVol).toEqual(snapshot.NazVol);
    expect(isDisplayableVolatilityRow('NazVol', sanitized.NazVol, NOW)).toBe(true);
  });

  test('does not relabel stale or malformed rows as refresh-delayed references', () => {
    expect(isRefreshDelayedVolatilityRow(retainedRow({ freshness: 'stale' }), NOW)).toBe(false);
    expect(isRefreshDelayedVolatilityRow(retainedRow({ source: null }), NOW)).toBe(false);
    expect(isRefreshDelayedVolatilityRow(retainedRow({ asOf: null }), NOW)).toBe(false);
  });

  test('sanitizes each provider row independently without mutating source evidence', () => {
    const snapshot = {
      marketSession: 'open',
      VIX: { lastPx: 18, source: 'cboe', asOf: '2026-07-13T18:00:00.000Z', availability: 'available', freshness: 'current' },
      VVIX: { lastPx: 95, source: 'cboe', asOf: '2026-07-13T20:30:00.000Z', availability: 'available', freshness: 'current' },
      MOVE: { lastPx: 92.4, source: 'yahoo', asOf: '2026-07-10T20:15:00.000Z', availability: 'historical', freshness: 'historical', quoteMode: 'end-of-day' },
    };
    const sanitized = sanitizeVolatilitySnapshot(snapshot, NOW);

    expect(sanitized.VIX).toMatchObject({ lastPx: 18, availability: 'reference', freshness: 'refresh-delayed', executable: false });
    expect(sanitized.VVIX).toBe(snapshot.VVIX);
    expect(sanitized.MOVE).toBe(snapshot.MOVE);
    expect(snapshot.VIX.lastPx).toBe(18);
  });

  test.each([
    { source: 'mock' }, { source: 'seed' }, { source: 'cache_only' },
    { source: '' }, { providerStatus: 'offline' }, { stale: true },
    { cacheOnly: true }, { asOf: null }, { lastPx: null },
    { mock: true }, { fromCache: true }, { connected: false },
    { status: 'offline' }, { _cache: { hit: true } }, { meta: { cacheStatus: 'stale' } },
  ])('rejects unsupported historical observations: %j', (overrides) => {
    const row = {
      lastPx: 92.4, source: 'yahoo', asOf: '2026-07-10T20:15:00.000Z',
      availability: 'historical', freshness: 'historical', quoteMode: 'end-of-day',
      ...overrides,
    };
    expect(isDisplayableVolatilityRow('MOVE', row, NOW)).toBe(false);
    expect(sanitizeVolatilitySnapshot({ MOVE: row }, NOW).MOVE.lastPx).toBeNull();
  });
});
