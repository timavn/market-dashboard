const {
  CORRELATION_WINDOWS,
  REQUIRED_ROLLING_RETURNS,
  alignReturns,
  buildReturnsByDate,
  buildUsdCorrelationSnapshot,
  completedDailyBarCutoff,
  correlationForExactWindow,
  normalizeHistory,
} = require('./usdCorrelations.cjs');

function historiesFromReturns(baseReturns, metricTransforms = {}) {
  const symbols = ['DXY', 'SPX', 'BRENT', 'CRB', 'GOLD', 'BTC'];
  const histories = {};
  for (const symbol of symbols) {
    let close = symbol === 'DXY' ? 100 : 50;
    const rows = [{ date: '2025-01-01', close }];
    const transform = metricTransforms[symbol] || ((value) => value);
    baseReturns.forEach((value, index) => {
      close *= Math.exp(transform(value, index));
      const date = new Date(Date.UTC(2025, 0, index + 2)).toISOString().slice(0, 10);
      rows.push({ date, close });
    });
    histories[symbol] = rows;
  }
  return histories;
}

const variedReturns = Array.from({ length: 500 }, (_, index) => (
  Math.sin(index / 7) * 0.008 + Math.cos(index / 13) * 0.004 + ((index % 5) - 2) * 0.0007
));

describe('USD correlation calculations', () => {
  test('calculates every exact window with perfect positive and negative series', () => {
    const positive = historiesFromReturns(variedReturns);
    const negative = historiesFromReturns(variedReturns, {
      SPX: (value) => -value,
    });
    const options = { now: new Date('2026-05-16T22:00:00Z'), cutoffDate: '2026-05-16' };

    const positiveSnapshot = buildUsdCorrelationSnapshot(positive, options);
    const negativeSnapshot = buildUsdCorrelationSnapshot(negative, options);

    for (const window of CORRELATION_WINDOWS) {
      expect(positiveSnapshot.correlations.SPX[`${window}D`]).toBe(1);
      expect(negativeSnapshot.correlations.SPX[`${window}D`]).toBe(-1);
    }
    expect(positiveSnapshot.rollingStats.SPX).toEqual({
      high: 1,
      low: 1,
      percentPositive: 100,
      percentNegative: 0,
    });
  });

  test('aligns returns by date and ignores unmatched weekend-style rows', () => {
    const base = buildReturnsByDate(normalizeHistory([
      { date: '2026-01-01', close: 100 },
      { date: '2026-01-02', close: 101 },
      { date: '2026-01-05', close: 102 },
    ]));
    const metric = buildReturnsByDate(normalizeHistory([
      { date: '2026-01-01', close: 50 },
      { date: '2026-01-02', close: 51 },
      { date: '2026-01-03', close: 52 },
      { date: '2026-01-04', close: 53 },
      { date: '2026-01-05', close: 54 },
    ]));

    expect(alignReturns(base, metric).map((row) => row.date)).toEqual(['2026-01-02', '2026-01-05']);
  });

  test('requires the full requested window and rejects insufficient rolling history', () => {
    const pairs = Array.from({ length: 14 }, (_, index) => ({
      date: `2026-01-${String(index + 1).padStart(2, '0')}`,
      base: index / 100,
      metric: index / 200,
    }));
    expect(correlationForExactWindow(pairs, 15)).toBeNull();

    const shortHistories = historiesFromReturns(variedReturns.slice(0, REQUIRED_ROLLING_RETURNS - 1));
    expect(() => buildUsdCorrelationSnapshot(shortHistories, {
      now: new Date('2026-07-13T18:00:00Z'),
      cutoffDate: '2026-07-13',
      maxStaleDays: 999,
    })).toThrow(/aligned returns/);
  });

  test('filters invalid values and excludes the current in-progress daily bar', () => {
    expect(completedDailyBarCutoff(new Date('2026-07-13T15:00:00Z'))).toBe('2026-07-12');
    expect(completedDailyBarCutoff(new Date('2026-07-13T22:00:00Z'))).toBe('2026-07-13');
    expect(normalizeHistory([
      { date: '2026-07-11', close: 100 },
      { date: '2026-07-12', close: null },
      { date: '2026-07-12', close: -1 },
      { date: '2026-07-13', close: 101 },
      { date: 'invalid', close: 102 },
    ], '2026-07-12')).toEqual([{ date: '2026-07-11', close: 100 }]);
  });

  test('rejects stale source bars', () => {
    const histories = historiesFromReturns(variedReturns.slice(0, 300));
    expect(() => buildUsdCorrelationSnapshot(histories, {
      now: new Date('2026-07-13T18:00:00Z'),
      cutoffDate: '2026-07-13',
    })).toThrow(/stale/);
  });
});
