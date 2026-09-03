import {
  DASHBOARD_CARD_DEFINITIONS,
  getDashboardDataStatus,
  getDashboardSystemStatus,
  createUnknownDashboardCardStatuses,
  mergeDashboardCardStatuses,
  normalizeDashboardCardStatuses,
} from './dashboardStatus';

describe('dashboard card status registry', () => {
  test('defines the eight main cards in display order', () => {
    expect(DASHBOARD_CARD_DEFINITIONS.map(({ id }) => id)).toEqual([
      'volatility',
      'usd',
      'market-backdrop',
      'cftc-positioning',
      'market-situation',
      'global-quads',
      'dollar-liquidity',
      'volume',
    ]);
  });

  test('keeps every card present while accepting isolated updates', () => {
    const initial = createUnknownDashboardCardStatuses();
    const next = mergeDashboardCardStatuses(initial, {
      id: 'volume',
      status: 'delayed',
      statusLabel: 'PROVISIONAL',
      detail: 'AS OF JUL 10',
      diagnostics: [{ label: 'Sources', value: '2' }],
      issues: ['Dataset is preliminary.'],
    });

    expect(Object.keys(next)).toHaveLength(8);
    expect(next.volume).toEqual(expect.objectContaining({
      status: 'delayed',
      statusLabel: 'PROVISIONAL',
      detail: 'AS OF JUL 10',
      diagnostics: [{ label: 'Sources', value: '2' }],
      issues: ['Dataset is preliminary.'],
    }));
    expect(next.usd.status).toBe('loading');
  });

  test('preserves the registry reference for freshly allocated equivalent diagnostics and issues', () => {
    const initial = mergeDashboardCardStatuses(createUnknownDashboardCardStatuses(), {
      id: 'volume',
      status: 'delayed',
      diagnostics: [{ label: 'Sources', value: 2 }],
      issues: [' Dataset is preliminary. '],
    });

    const equivalent = mergeDashboardCardStatuses(initial, {
      id: 'volume',
      status: 'delayed',
      diagnostics: [{ label: 'Sources', value: '2' }],
      issues: ['Dataset is preliminary.'],
    });

    expect(equivalent).toBe(initial);
    expect(equivalent.volume.diagnostics).toEqual([{ label: 'Sources', value: '2' }]);
    expect(equivalent.volume.issues).toEqual(['Dataset is preliminary.']);
  });

  test('normalizes unknown card input to an explicit unavailable state', () => {
    const normalized = normalizeDashboardCardStatuses({
      usd: { status: 'not-a-real-status' },
    });

    expect(normalized.usd.status).toBe('unavailable');
    expect(normalized.volume.status).toBe('unavailable');
  });

  test('maps data freshness states to the SYS status vocabulary', () => {
    expect(getDashboardSystemStatus('live')).toBe('online');
    expect(getDashboardSystemStatus('mixed')).toBe('attention');
    expect(getDashboardSystemStatus('historical')).toBe('closed');
    expect(getDashboardSystemStatus('closed')).toBe('closed');
    expect(getDashboardSystemStatus('unavailable')).toBe('error');
    expect(getDashboardSystemStatus('loading')).toBe('unknown');
    expect(getDashboardDataStatus('live')).toBe('live');
    expect(getDashboardDataStatus('mixed')).toBe('mixed');
    expect(getDashboardDataStatus('historical')).toBe('closed');
    expect(getDashboardDataStatus('unavailable')).toBe('unavailable');
    expect(getDashboardDataStatus('loading')).toBe('loading');
  });

  test('turns recent mixed or delayed references into Closed only during a closed session', () => {
    const sourceDate = '2026-07-31T20:00:00.000Z';
    const now = new Date('2026-08-02T18:00:00.000Z').getTime();

    expect(getDashboardSystemStatus('mixed', {
      marketSession: 'closed',
      sourceDate,
      now,
    })).toBe('closed');
    expect(getDashboardSystemStatus('mixed', {
      marketSession: 'closed',
      sourceDate,
      issues: ['One source is missing.'],
    })).toBe('attention');
    expect(getDashboardSystemStatus('delayed', {
      marketSession: 'open',
      sourceDate,
    })).toBe('attention');
    expect(getDashboardSystemStatus('manual')).toBe('closed');
  });
});
