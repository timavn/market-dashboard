const {
  isVerifiedPredictionMarketAth,
  retainVerifiedAthWhilePending,
  synchronizeVerifiedAthAcrossChartRanges,
} = require('./predictionMarketAth.cjs');

function verifiedAth(overrides = {}) {
  return {
    status: 'available',
    source: 'ibkr_historical_record',
    asOf: '2026-08-19T16:00:00.000Z',
    value: 7_816.7,
    date: '2026-08-13',
    baseline: {
      value: 7_816.7,
      date: '2026-08-13',
      throughDate: '2026-08-19',
      source: 'ibkr',
      dataset: 'historical_record',
      coverageComplete: true,
      coverageStart: '1927-12-30',
      coverageEnd: '2026-08-19',
    },
    markers: [],
    reason: null,
    ...overrides,
  };
}

describe('prediction-market ATH continuity', () => {
  test('recognizes only independently verified complete record references', () => {
    expect(isVerifiedPredictionMarketAth(verifiedAth())).toBe(true);
    expect(isVerifiedPredictionMarketAth(verifiedAth({
      source: 'coinbase_exchange_historical_record',
      baseline: { ...verifiedAth().baseline, source: 'coinbase_exchange' },
    }))).toBe(true);
    expect(isVerifiedPredictionMarketAth(verifiedAth({ source: 'ibkr_chart_cache' }))).toBe(false);
    expect(isVerifiedPredictionMarketAth(verifiedAth({ stale: true }))).toBe(false);
    expect(isVerifiedPredictionMarketAth(verifiedAth({
      baseline: { ...verifiedAth().baseline, coverageComplete: false },
    }))).toBe(false);
  });

  test('retains a verified ATH while only the next historical-record request is pending', () => {
    const previous = { status: 'available', source: 'ibkr_historical_bars', ath: verifiedAth() };
    const next = {
      status: 'available',
      source: 'ibkr_historical_bars',
      points: [{ timestamp: 1, value: 7_700 }, { timestamp: 2, value: 7_701 }],
      ath: { status: 'loading', source: null, baseline: null, markers: [], reason: 'Checking ATH.' },
    };

    expect(retainVerifiedAthWhilePending(previous, next)).toMatchObject({
      ath: {
        status: 'available',
        value: 7_816.7,
        refreshPending: true,
        refreshRetained: true,
      },
    });
  });

  test('copies one verified ATH to every existing chart range', () => {
    const canonical = verifiedAth();
    const chart = {
      status: 'available',
      ath: { status: 'loading' },
      variants: {
        '1d': { range: '1d', ath: { status: 'loading' } },
        '5d': { range: '5d', ath: canonical },
        '10d': { range: '10d', ath: { status: 'loading' } },
      },
    };

    const synchronized = synchronizeVerifiedAthAcrossChartRanges(chart);
    expect(synchronized.ath).toBe(canonical);
    expect(Object.values(synchronized.variants).every((variant) => variant.ath === canonical)).toBe(true);
  });

  test('does not overwrite an explicit ATH failure while synchronizing pending ranges', () => {
    const failure = { status: 'unavailable', reason: 'Historical record request failed.' };
    const synchronized = synchronizeVerifiedAthAcrossChartRanges({
      status: 'available',
      ath: verifiedAth(),
      variants: {
        '1d': { range: '1d', ath: { status: 'loading' } },
        '5d': { range: '5d', ath: failure },
        '10d': { range: '10d' },
      },
    });

    expect(synchronized.variants['1d'].ath).toMatchObject({ status: 'available', value: 7_816.7 });
    expect(synchronized.variants['5d'].ath).toBe(failure);
    expect(synchronized.variants['10d'].ath).toMatchObject({ status: 'available', value: 7_816.7 });
  });

  test('preserves already synchronized ranges and their historical points without cloning', () => {
    const canonical = verifiedAth();
    const points = Object.freeze([{ timestamp: 1, value: 7_700 }, { timestamp: 2, value: 7_701 }]);
    const variants = Object.freeze(Object.fromEntries(['1d', '5d', '10d'].map(range => [
      range, Object.freeze({ range, points, ath: canonical }),
    ])));
    const chart = Object.freeze({ status: 'available', source: 'ibkr_historical_bars', points, ath: canonical, variants });

    expect(synchronizeVerifiedAthAcrossChartRanges(chart)).toBe(chart);
    const pending = { ...chart, ath: { status: 'loading' } };
    const synchronized = synchronizeVerifiedAthAcrossChartRanges(pending);
    expect(synchronized).not.toBe(pending);
    expect(synchronized.variants).toBe(variants);
    expect(synchronized.points).toBe(points);
    expect(synchronized.ath).toBe(canonical);
  });

  test('validates a shared complete marker record once, then validates fresh mutations on the next call', () => {
    const canonical = verifiedAth();
    const markers = Array.from({ length: 100 }, (_, index) => ({ date: '2026-08-13', value: 7_000 + index }));
    let markerReads = 0;
    Object.defineProperty(canonical, 'markers', { get: () => { markerReads += 1; return markers; } });
    const chart = { ath: canonical, variants: Object.fromEntries(['1d', '5d', '10d'].map(range => [range, { ath: canonical }])) };

    expect(synchronizeVerifiedAthAcrossChartRanges(chart)).toBe(chart);
    expect(markerReads).toBe(2);
    markers[markers.length - 1].value = 8_000;
    const pending = { ...chart, ath: { status: 'pending' } };
    expect(synchronizeVerifiedAthAcrossChartRanges(pending)).toBe(pending);
    expect(markerReads).toBe(4);
    markers[markers.length - 1].value = 7_099;
    canonical.baseline.coverageComplete = false;
    expect(synchronizeVerifiedAthAcrossChartRanges(pending)).toBe(pending);
  });

  test('keeps highest-value, latest-observed selection and stable ties across distinct records', () => {
    const root = verifiedAth({ asOf: '2026-08-19T16:00:00Z' });
    const older = verifiedAth({ asOf: '2026-08-19T15:00:00Z' });
    const newer = verifiedAth({ asOf: '2026-08-19T17:00:00Z' });
    const higher = verifiedAth({ value: 7_900, asOf: '2026-08-19T14:00:00Z' });
    const chart = { ath: root, variants: { '1d': { ath: older }, '5d': { ath: newer }, '10d': { ath: higher } } };

    expect(synchronizeVerifiedAthAcrossChartRanges(chart).ath).toBe(higher);
    delete chart.variants['10d'];
    expect(synchronizeVerifiedAthAcrossChartRanges(chart).ath).toBe(newer);
    newer.asOf = root.asOf;
    expect(synchronizeVerifiedAthAcrossChartRanges(chart).ath).toBe(root);
  });

  test.each([
    { fromCache: true }, { cachedOnly: true }, { seeded: true }, { stale: true },
    { refreshFailed: true }, { source: 'ibkr_disconnected' }, { warning: 'Offline' },
  ])('keeps a rejected range unchanged while repairing a pending verified range: %p', provenance => {
    const canonical = verifiedAth();
    const rejected = { ...provenance, ath: { status: 'pending' } };
    const good = { ath: canonical };
    const synchronized = synchronizeVerifiedAthAcrossChartRanges({ ath: canonical,
      variants: { '1d': good, '5d': rejected, '10d': { ath: { status: 'pending' } } } });

    expect(synchronized.variants['1d']).toBe(good);
    expect(synchronized.variants['5d']).toBe(rejected);
    expect(synchronized.variants['10d'].ath).toBe(canonical);
  });

  test.each([
    ['an explicit unavailable result', {
      status: 'available', source: 'ibkr_historical_bars',
      ath: { status: 'unavailable', reason: 'Historical record request failed.' },
    }],
    ['a disconnected chart', {
      status: 'available', source: 'ibkr_historical_bars', reason: 'IBKR disconnected.',
      ath: { status: 'loading' },
    }],
  ])('fails closed for %s', (_label, next) => {
    const previous = { status: 'available', source: 'ibkr_historical_bars', ath: verifiedAth() };
    expect(retainVerifiedAthWhilePending(previous, next)).toBe(next);
  });
});
