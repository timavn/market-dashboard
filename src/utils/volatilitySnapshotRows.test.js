import {
  isDisplayableVolatilityRow,
  isRefreshDelayedVolatilityRow,
  sanitizeExpiredVolatilityReferences,
} from './volatilitySnapshotRows';

const NOW = new Date('2026-07-13T20:45:00.000Z').getTime();

const retainedRow = (overrides = {}) => ({
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
  test('allows a still-fresh retained row only as an explicit display reference', () => {
    const row = retainedRow();

    expect(isRefreshDelayedVolatilityRow(row, NOW)).toBe(true);
    expect(isDisplayableVolatilityRow('NazVol', row, NOW)).toBe(true);
  });

  test('expires and clears retained numeric fields locally', () => {
    const snapshot = { NazVol: retainedRow() };
    const sanitized = sanitizeExpiredVolatilityReferences(
      snapshot,
      new Date('2026-07-13T21:14:00.001Z').getTime(),
    );

    expect(sanitized.NazVol).toMatchObject({
      availability: 'unavailable',
      freshness: 'stale',
      refreshDelayed: false,
      error: 'reference_expired',
      lastPx: null,
      day1Ago: null,
    });
    expect(isDisplayableVolatilityRow('NazVol', sanitized.NazVol, NOW)).toBe(false);
  });

  test('does not relabel stale or malformed rows as refresh-delayed references', () => {
    expect(isRefreshDelayedVolatilityRow(retainedRow({ freshness: 'stale' }), NOW)).toBe(false);
    expect(isRefreshDelayedVolatilityRow(retainedRow({ retainedUntil: null }), NOW)).toBe(false);
  });
});

