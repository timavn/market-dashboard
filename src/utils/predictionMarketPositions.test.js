const {
  aggregatePositionSnapshotStatus,
  classifyPredictionMarketPosition,
  hasVerifiedAccountCoverage,
  verifyLivePositionSnapshot,
} = require('./predictionMarketPositions.cjs');

const NOW = Date.parse('2026-07-21T18:00:00.000Z');

describe('prediction market position integrity', () => {
  test.each([
    ['KXCPIYOY-26JUN-T4.2_YES', 'cpi', 'cpi'],
    ['KXINXU-26JUL21H1600-T7450_YES', 'spx', 'spx'],
    ['KXINX-26JUL21-B7450_NO', 'spx', 'spx'],
    ['KXWTI-26JUL2114-T84.49_YES', 'wti', 'daily'],
    ['KXWTIW-26JUL2414-B84.50_YES', 'wti', 'weekly'],
    ['KXWTIMIN-26JUL-T84_YES', 'wti', 'unsupported'],
    ['KXFEDDECISION-26JUL_YES', 'other', 'other'],
  ])('classifies %s without hiding unsupported contracts', (symbol, family, product) => {
    expect(classifyPredictionMarketPosition({ symbol })).toMatchObject({
      marketFamily: family,
      marketProduct: product,
    });
  });

  test('accepts a fresh direct IBKR positions snapshot', () => {
    expect(verifyLivePositionSnapshot({
      ok: true,
      source: 'ibkr_positions',
      fetched_at: '2026-07-21T17:59:50.000Z',
      positions: [],
    }, { now: NOW })).toMatchObject({ live: true, source: 'ibkr_positions' });
  });

  test('accepts stream cache only when the same request completed a live sync', () => {
    expect(verifyLivePositionSnapshot({
      ok: true,
      source: 'stream_cache',
      fetched_at: '2026-07-21T17:59:50.000Z',
      sync: { ok: true, status: 'synced' },
    }, { now: NOW }).live).toBe(true);
    expect(verifyLivePositionSnapshot({
      ok: true,
      source: 'stream_cache',
      fetched_at: '2026-07-21T17:59:50.000Z',
      sync: { ok: false, message: 'sync failed' },
    }, { now: NOW })).toMatchObject({ live: false, reason: 'sync failed' });
  });

  test('rejects cache-only, unknown, failed, and stale snapshots', () => {
    expect(verifyLivePositionSnapshot({
      ok: true,
      source: 'ibkr_sidecar_cache',
      fetched_at: '2026-07-21T17:59:50.000Z',
    }, { now: NOW }).live).toBe(false);
    expect(verifyLivePositionSnapshot({
      ok: false,
      source: 'ibkr_positions',
      fetched_at: '2026-07-21T17:59:50.000Z',
    }, { now: NOW }).live).toBe(false);
    expect(verifyLivePositionSnapshot({
      ok: true,
      source: 'ibkr_positions',
      fetched_at: '2026-07-21T17:55:00.000Z',
    }, { now: NOW }).live).toBe(false);
  });

  test('distinguishes live, partial, and unavailable account coverage', () => {
    expect(aggregatePositionSnapshotStatus([{ status: 'live' }])).toBe('live');
    expect(aggregatePositionSnapshotStatus([{ status: 'live' }, { status: 'unavailable' }])).toBe('partial');
    expect(aggregatePositionSnapshotStatus([{ status: 'unavailable' }])).toBe('unavailable');
    expect(aggregatePositionSnapshotStatus([])).toBe('unavailable');
  });

  test('requires explicit success before treating an account list as complete coverage', () => {
    expect(hasVerifiedAccountCoverage({ ok: true, accounts: [] })).toBe(true);
    expect(hasVerifiedAccountCoverage({ account_discovery_ok: true, accounts: ['U1'] })).toBe(true);

    expect(hasVerifiedAccountCoverage({ ok: false, accounts: [] })).toBe(false);
    expect(hasVerifiedAccountCoverage({ connected: true, status: 'connected', accounts: [] })).toBe(false);
    expect(hasVerifiedAccountCoverage({ account_discovery_ok: false, accounts: ['U1'] })).toBe(false);
  });
});
