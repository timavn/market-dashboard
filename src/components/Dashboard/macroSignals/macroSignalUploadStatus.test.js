import {
  buildMacroUploadSources,
  deriveMacroUploadAggregateStatus,
  mapFreshnessToSourceStatus,
} from './macroSignalUploadStatus';

describe('macroSignalUploadStatus', () => {
  test('mapFreshnessToSourceStatus maps hedgeye statuses', () => {
    expect(mapFreshnessToSourceStatus('fresh')).toBe('current');
    expect(mapFreshnessToSourceStatus('stale')).toBe('stale');
    expect(mapFreshnessToSourceStatus('missing')).toBe('defective');
    expect(mapFreshnessToSourceStatus('error')).toBe('defective');
  });

  test('buildMacroUploadSources includes Hedgeye signal products', () => {
    const sources = buildMacroUploadSources({
      'risk-ranges': { status: 'fresh', itemCount: 35, date: '2026-05-20' },
      'inflation-nowcast': { status: 'fresh', itemCount: 3, date: '2026-06-15' },
      'bitcoin-trend-tracker': { status: 'stale', itemCount: 4, date: '2026-05-19' },
      'momo-tracker': { status: 'missing', itemCount: 0 },
    });

    expect(sources).toHaveLength(4);
    expect(sources[0]).toMatchObject({
      id: 'risk-ranges',
      label: 'Risk Ranges',
      detail: '35 items · Fresh',
      status: 'current',
    });
    expect(sources[1]).toMatchObject({
      id: 'inflation-nowcast',
      label: 'Inflation Nowcast',
      detail: '3 items · Fresh',
      status: 'current',
    });
    expect(sources[2].status).toBe('stale');
    expect(sources[3].status).toBe('defective');
  });

  test('deriveMacroUploadAggregateStatus uses worst status', () => {
    expect(
      deriveMacroUploadAggregateStatus([
        { status: 'current' },
        { status: 'current' },
      ]),
    ).toBe('active');
    expect(
      deriveMacroUploadAggregateStatus([
        { status: 'current' },
        { status: 'stale' },
      ]),
    ).toBe('stale');
    expect(
      deriveMacroUploadAggregateStatus([
        { status: 'stale' },
        { status: 'defective' },
      ]),
    ).toBe('inactive');
  });
});
