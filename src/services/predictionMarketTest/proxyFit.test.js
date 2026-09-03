const {
  buildProxyFitComparison,
  proxyFitCandidateDates,
} = require('./proxyFit.cjs');

const DAY_MS = 24 * 60 * 60_000;

function weekdayDates(count, end = Date.parse('2026-08-28T20:00:00.000Z')) {
  const dates = [];
  let cursor = end;
  while (dates.length < count) {
    const date = new Date(cursor);
    if (date.getUTCDay() > 0 && date.getUTCDay() < 6) dates.unshift(date.toISOString().slice(0, 10));
    cursor -= DAY_MS;
  }
  return dates;
}

function fixture(count = 130) {
  const dates = weekdayDates(count + 1);
  const proxyPoints = dates.map((date, index) => ({
    timestamp: Date.parse(`${date}T20:00:00.000Z`),
    value: 100 + index + Math.sin(index / 3),
  }));
  const ranges = Object.fromEntries(dates.slice(1).map((date, index) => {
    const proxyPreviousClose = proxyPoints[index].value;
    return [date, {
      date,
      lrr: 80,
      hrr: 120,
      previousClose: proxyPreviousClose / 1.01,
      source: 'hedgeye-risk-ranges-email',
      asOf: date,
    }];
  }));
  return { proxyPoints, underlyingHistory: { status: 'available', source: 'RiskRangeData', ranges } };
}

describe('proxy fit comparison', () => {
  test('builds exact 5/20/60/120-observation basis, z-score, and return-correlation rows', () => {
    const input = fixture();
    const result = buildProxyFitComparison({
      ...input,
      proxyLabel: 'SIZ6',
      underlyingLabel: 'SILVER',
      proxySource: 'ibkr_historical_bars',
    });

    expect(result).toMatchObject({
      status: 'available',
      proxyLabel: 'SIZ6',
      underlyingLabel: 'SILVER',
      currentBasisPct: 1,
      alignedObservations: 130,
    });
    expect(result.rows.map((row) => row.window)).toEqual([5, 20, 60, 120]);
    expect(result.rows.every((row) => row.status === 'available')).toBe(true);
    expect(result.rows[0]).toEqual(expect.objectContaining({
      averageBasisPct: 1,
      deviationZ: 0,
      observations: 5,
    }));
    expect(result.rows[0].returnCorrelation).toEqual(expect.any(Number));
  });

  test('leaves longer windows unavailable instead of fabricating observations', () => {
    const input = fixture(25);
    const result = buildProxyFitComparison({
      ...input,
      proxyLabel: 'CLV6',
      underlyingLabel: 'WTIC',
      proxySource: 'ibkr_historical_bars',
    });

    expect(result.status).toBe('partial');
    expect(result.rows.map((row) => [row.window, row.status])).toEqual([
      [5, 'available'],
      [20, 'available'],
      [60, 'unavailable'],
      [120, 'unavailable'],
    ]);
  });

  test.each([
    ['cached proxy source', 'ibkr_completed_history_checkpoint', {}],
    ['cached underlying history', 'ibkr_historical_bars', { fromCache: true }],
    ['seeded underlying history', 'ibkr_historical_bars', { seeded: true }],
  ])('fails closed for %s', (_label, proxySource, historyFlags) => {
    const input = fixture();
    const result = buildProxyFitComparison({
      proxyPoints: input.proxyPoints,
      underlyingHistory: { ...input.underlyingHistory, ...historyFlags },
      proxyLabel: 'ESU6',
      underlyingLabel: 'SPX',
      proxySource,
    });

    expect(result).toMatchObject({ status: 'unavailable', currentBasisPct: null, alignedObservations: 0 });
    expect(result.rows.every((row) => row.status === 'unavailable')).toBe(true);
  });

  test('requests only recent weekday publication dates', () => {
    const saturday = Date.parse('2026-08-29T20:00:00.000Z');
    const points = Array.from({ length: 170 }, (_, index) => ({
      timestamp: saturday - ((169 - index) * DAY_MS),
      value: 100 + index,
    }));
    const dates = proxyFitCandidateDates(points);

    expect(dates).toHaveLength(121);
    expect(dates.every((date) => {
      const day = new Date(`${date}T12:00:00.000Z`).getUTCDay();
      return day > 0 && day < 6;
    })).toBe(true);
  });
});
