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
