const {
  CORRELATION_WINDOWS,
  REQUIRED_ROLLING_OBSERVATIONS,
  alignPriceLevels,
  buildRollingStats,
  buildUsdCorrelationSnapshot,
  completedDailyBarCutoff,
  correlationForExactWindow,
  normalizeHistory,
  pearsonCorrelation,
} = require('./usdCorrelations.cjs');
const usdGoldFixture = require('./__fixtures__/usdGoldCorrelation-2026-08-14.json');

function historiesFromLevels(baseLevels, metricTransforms = {}) {
  const symbols = ['DXY', 'SPX', 'NDX', 'WTI', 'BRENT', 'CRB', 'GOLD', 'BTC'];
  const histories = {};
  for (const symbol of symbols) {
    const transform = metricTransforms[symbol] || ((value) => value);
    histories[symbol] = baseLevels.map((value, index) => ({
      date: new Date(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10),
      close: transform(value, index),
    }));
  }
  return histories;
}

const variedLevels = Array.from({ length: 500 }, (_, index) => (
  100 + index * 0.01 + Math.sin(index / 7) * 2 + Math.cos(index / 13)
));

const fixtureDxyHistory = usdGoldFixture.rows.map(([date, close]) => ({ date, close }));
const fixtureGoldHistory = usdGoldFixture.rows.map(([date, , close]) => ({ date, close }));

describe('USD correlation calculations', () => {
  test('computes yield and copper comparisons from completed, date-aligned history', () => {
    const histories = historiesFromLevels(variedLevels);
    histories.UST10Y = histories.DXY.map(({ date, close }) => ({ date, close: close / 25 }));
    histories.COPPER = histories.DXY.map(({ date, close }) => ({ date, close: (300 - close) / 30 }));
    const snapshot = buildUsdCorrelationSnapshot(histories, {
      now: new Date('2026-05-16T22:00:00Z'), cutoffDate: '2026-05-16',
    });
    expect(snapshot.correlations.UST10Y).toEqual(expect.objectContaining({ '15D': 1, '180D': 1 }));
    expect(snapshot.correlations.COPPER).toEqual(expect.objectContaining({ '15D': -1, '180D': -1 }));
    expect(snapshot.rollingStats.UST10Y.percentPositive).toBe(100);
    expect(snapshot.rollingStats.COPPER.percentNegative).toBe(100);
  });

  test.each(['SILVER', 'UST10Y', 'COPPER', 'ETH'])('omits missing, older, and insufficient %s history', (symbol) => {
    const histories = historiesFromLevels(variedLevels);
    const options = { now: new Date('2026-05-16T22:00:00Z'), cutoffDate: '2026-05-16' };
    for (const history of [undefined, histories.DXY.slice(0, -10), histories.DXY.slice(-100)]) {
      const snapshot = buildUsdCorrelationSnapshot({ ...histories, [symbol]: history }, options);
      expect(snapshot.correlations[symbol]).toBeUndefined();
      expect(snapshot.rollingStats[symbol]).toBeUndefined();
      expect(snapshot.correlations.SPX).toBeDefined();
    }
  });

  test('computes DXY changes from exact sessions and ETH correlations and realized volatility from its own closes', () => {
    const histories = historiesFromLevels(variedLevels);
    histories.ETH = histories.DXY.map(({ date, close }) => ({ date, close: 300 - close }));
    const snapshot = buildUsdCorrelationSnapshot(histories, {
      now: new Date('2026-05-17T12:00:00Z'), cutoffDate: '2026-05-16',
    });
    const last = histories.DXY.at(-1).close;
    expect(snapshot.assetContext.dxy.changePercent).toBeCloseTo((last / histories.DXY.at(-2).close - 1) * 100, 4);
    expect(snapshot.assetContext.dxy.fifteenDayChangePercent).toBeCloseTo((last / histories.DXY.at(-16).close - 1) * 100, 4);
    expect(snapshot.assetContext.dxy.thirtyDayChangePercent).toBeCloseTo((last / histories.DXY.at(-31).close - 1) * 100, 4);
    expect(snapshot.correlations.ETH).toMatchObject({ '15D': -1, '30D': -1 });
    expect(snapshot.assetContext.ethereumRealizedVolatility).toMatchObject({
      status: 'historical', availability: 'historical', window: 21, annualized: true,
      annualizationFactor: 365, asOf: snapshot.calculationDate, decisionEligible: false,
      source: 'Yahoo Finance completed ETH-USD daily bars',
    });
    expect(snapshot.assetContext.ethereumRealizedVolatility.value).toBeGreaterThan(0);
  });

  test('does not treat the still-open ETH UTC daily candle as a completed observation', () => {
    const histories = historiesFromLevels(variedLevels);
    histories.ETH = histories.DXY;
    const snapshot = buildUsdCorrelationSnapshot(histories, {
      now: new Date('2026-05-15T22:00:00Z'), cutoffDate: '2026-05-15',
    });
    expect(snapshot.calculationDate).toBe('2026-05-15');
    expect(snapshot.correlations.ETH).toBeUndefined();
    expect(snapshot.assetContext.ethereumRealizedVolatility).toBeUndefined();
    expect(snapshot.correlations.BTC).toBeDefined();
  });

  test('does not let an unusable optional ETH series block the shared dollar snapshot', () => {
    const histories = historiesFromLevels(variedLevels);
    histories.ETH = histories.DXY.map(({ date }) => ({ date, close: 2000 }));
    const snapshot = buildUsdCorrelationSnapshot(histories, {
      now: new Date('2026-05-17T12:00:00Z'), cutoffDate: '2026-05-16',
    });
    expect(snapshot.correlations.ETH).toBeUndefined();
    expect(snapshot.assetContext.ethereumRealizedVolatility).toBeUndefined();
    expect(snapshot.correlations.BTC).toBeDefined();
  });

  test('calculates every exact window with perfect positive and negative series', () => {
    const positive = historiesFromLevels(variedLevels);
    const negative = historiesFromLevels(variedLevels, {
      SPX: (value) => 300 - value,
    });
    const options = { now: new Date('2026-05-16T22:00:00Z'), cutoffDate: '2026-05-16' };

    const positiveSnapshot = buildUsdCorrelationSnapshot(positive, options);
    const negativeSnapshot = buildUsdCorrelationSnapshot(negative, options);

    for (const { key } of CORRELATION_WINDOWS) {
      expect(positiveSnapshot.correlations.SPX[key]).toBe(1);
      expect(negativeSnapshot.correlations.SPX[key]).toBe(-1);
    }
    expect(positiveSnapshot.correlations.SPX).toEqual(expect.objectContaining({
      '90D': 1,
      '120D': 1,
      '180D': 1,
    }));
    expect(positiveSnapshot.rollingStats.SPX).toEqual({
      high: 1,
      low: 1,
      percentPositive: 100,
      percentNegative: 0,
    });
  });

  test('aligns closing levels by date and drops unmatched BTC weekend observations', () => {
    const base = normalizeHistory([
      { date: '2026-01-01', close: 100 },
      { date: '2026-01-02', close: 101 },
      { date: '2026-01-05', close: 102 },
    ]);
    const metric = normalizeHistory([
      { date: '2026-01-01', close: 50 },
      { date: '2026-01-02', close: 51 },
      { date: '2026-01-03', close: 52 },
      { date: '2026-01-04', close: 53 },
      { date: '2026-01-05', close: 54 },
    ]);

    expect(alignPriceLevels(base, metric)).toEqual([
      { date: '2026-01-01', base: 100, metric: 50 },
      { date: '2026-01-02', base: 101, metric: 51 },
      { date: '2026-01-05', base: 102, metric: 54 },
    ]);
  });

  test('matches the frozen August 14 Hedgeye Gold/USD 90-session benchmark', () => {
    const aligned = alignPriceLevels(fixtureDxyHistory, fixtureGoldHistory);
    const correlation = correlationForExactWindow(aligned, 90);

    expect(aligned).toHaveLength(90);
    expect(aligned.at(-1).date).toBe(usdGoldFixture.asOf);
    expect(correlation).toBeCloseTo(usdGoldFixture.expected90D, 3);
    expect(correlation.toFixed(2)).toBe('-0.93');
  });

  test('adds the DXY close, Silver correlation/RV, and aligned completed-session Brent–WTI spread', () => {
    const histories = historiesFromLevels(variedLevels, {
      WTI: (value) => value,
      BRENT: (value) => value + 5,
    });
    histories.SILVER = variedLevels.map((value, index) => ({
      date: new Date(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10),
      close: value * (1 + Math.sin(index / 5) * 0.015),
    }));

    const snapshot = buildUsdCorrelationSnapshot(histories, {
      now: new Date('2026-05-16T22:00:00Z'),
      cutoffDate: '2026-05-16',
    });

    expect(snapshot.correlations.SILVER['30D']).toEqual(expect.any(Number));
    expect(snapshot.assetContext.dxy).toMatchObject({
      status: 'historical', availability: 'historical',
      value: expect.any(Number), previousClose: expect.any(Number),
      changePercent: expect.any(Number), asOf: snapshot.calculationDate,
      decisionEligible: false,
      source: 'Yahoo Finance completed DXY daily bars',
    });
    expect(snapshot.assetContext.silverRealizedVolatility).toMatchObject({
      status: 'historical', availability: 'historical', window: 21,
      annualized: true, decisionEligible: false,
      source: 'Yahoo Finance completed Silver futures daily bars',
    });
    expect(snapshot.assetContext.silverRealizedVolatility.value).toBeGreaterThan(0);
    expect(snapshot.assetContext.brentWtiSpread).toMatchObject({
      status: 'historical', availability: 'historical', value: 5,
      decisionEligible: false,
      source: 'Yahoo Finance aligned completed Brent and WTI futures daily bars',
    });
  });

  test('does not fabricate Silver outputs when optional completed history is missing', () => {
    const snapshot = buildUsdCorrelationSnapshot(historiesFromLevels(variedLevels), {
      now: new Date('2026-05-16T22:00:00Z'),
      cutoffDate: '2026-05-16',
    });

    expect(snapshot.correlations.SILVER).toBeUndefined();
    expect(snapshot.assetContext.dxy).toBeDefined();
    expect(snapshot.assetContext.silverRealizedVolatility).toBeUndefined();
    expect(snapshot.assetContext.brentWtiSpread).toBeDefined();
  });

  test('uses price levels rather than one-day returns for trending correlation', () => {
    const aligned = alignPriceLevels(fixtureDxyHistory, fixtureGoldHistory);
    const levelCorrelation = correlationForExactWindow(aligned, 90);
    const returnPairs = aligned.slice(1).map((row, index) => ({
      base: Math.log(row.base / aligned[index].base),
      metric: Math.log(row.metric / aligned[index].metric),
    }));
    const returnCorrelation = pearsonCorrelation(returnPairs);

    expect(levelCorrelation).toBeCloseTo(-0.925, 3);
    expect(returnCorrelation).toBeCloseTo(-0.523, 3);
    expect(Math.abs(levelCorrelation - returnCorrelation)).toBeGreaterThan(0.35);
  });

  test('reports rolling level-correlation statistics from the latest 252 windows', () => {
    const aligned = Array.from({ length: REQUIRED_ROLLING_OBSERVATIONS + 20 }, (_, index) => ({
      date: new Date(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10),
      base: 100 + index * 0.04 + Math.sin(index / 8),
      metric: 200 - index * 0.06 + Math.cos(index / 11) * 1.5,
    }));
    const rolling = [];
    for (let end = 30; end <= aligned.length; end += 1) {
      rolling.push(pearsonCorrelation(aligned.slice(end - 30, end)));
    }
    const latest = rolling.slice(-252);
    const positiveCount = latest.filter((value) => value >= 0).length;
    const round = (value, digits = 3) => Number(value.toFixed(digits));

    expect(buildRollingStats(aligned)).toEqual({
      high: round(Math.max(...latest)),
      low: round(Math.min(...latest)),
      percentPositive: round((positiveCount / latest.length) * 100, 1),
      percentNegative: round(((latest.length - positiveCount) / latest.length) * 100, 1),
    });
  });

  test('requires the full requested window and rejects insufficient rolling history', () => {
    const pairs = Array.from({ length: 14 }, (_, index) => ({
      date: `2026-01-${String(index + 1).padStart(2, '0')}`,
      base: index / 100,
      metric: index / 200,
    }));
    expect(correlationForExactWindow(pairs, 15)).toBeNull();

    const shortHistories = historiesFromLevels(variedLevels.slice(0, REQUIRED_ROLLING_OBSERVATIONS - 1));
    expect(() => buildUsdCorrelationSnapshot(shortHistories, {
      now: new Date('2026-07-13T18:00:00Z'),
      cutoffDate: '2026-07-13',
      maxStaleDays: 999,
    })).toThrow(/aligned closing levels/);
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
    const histories = historiesFromLevels(variedLevels.slice(0, 300));
    expect(() => buildUsdCorrelationSnapshot(histories, {
      now: new Date('2026-07-13T18:00:00Z'),
      cutoffDate: '2026-07-13',
    })).toThrow(/stale/);
  });
});
