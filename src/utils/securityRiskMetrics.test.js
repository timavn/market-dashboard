const {
  BETA_WINDOW_RETURNS,
  MIN_BETA_RETURNS,
  REASONS,
  Z_SCORE_PERIOD,
  buildSecurityRiskMetrics,
  calculateAlignedBeta,
  calculateAtr14,
  calculatePriceZScore20,
  calculatePriorAllTimePrices,
  calculatePriceStructureRun,
  createUnavailableSecurityRiskMetrics,
  parseYahooChartBars,
} = require('./securityRiskMetrics.cjs');

function dateForIndex(index) {
  return new Date(Date.UTC(2024, 0, index + 1)).toISOString().slice(0, 10);
}

function historiesFromReturns(benchmarkReturns, betaByIndex = () => 1) {
  let benchmarkClose = 100;
  let securityClose = 50;
  const benchmarkBars = [{
    date: dateForIndex(0),
    close: benchmarkClose,
    high: benchmarkClose + 1,
    low: benchmarkClose - 1,
    adjustedClose: benchmarkClose,
    adjustedHigh: benchmarkClose + 1,
    adjustedLow: benchmarkClose - 1,
  }];
  const securityBars = [{
    date: dateForIndex(0),
    close: securityClose,
    high: securityClose + 1,
    low: securityClose - 1,
    adjustedClose: securityClose,
    adjustedHigh: securityClose + 1,
    adjustedLow: securityClose - 1,
  }];

  benchmarkReturns.forEach((benchmarkReturn, index) => {
    benchmarkClose *= 1 + benchmarkReturn;
    securityClose *= 1 + (benchmarkReturn * betaByIndex(index));
    benchmarkBars.push({
      date: dateForIndex(index + 1),
      close: benchmarkClose,
      high: benchmarkClose + 1,
      low: benchmarkClose - 1,
      adjustedClose: benchmarkClose,
      adjustedHigh: benchmarkClose + 1,
      adjustedLow: benchmarkClose - 1,
    });
    securityBars.push({
      date: dateForIndex(index + 1),
      close: securityClose,
      high: securityClose + 1,
      low: securityClose - 1,
      adjustedClose: securityClose,
      adjustedHigh: securityClose + 1,
      adjustedLow: securityClose - 1,
    });
  });

  return { benchmarkBars, securityBars };
}

const variedReturns = Array.from({ length: 420 }, (_, index) => (
  Math.sin(index / 9) * 0.008 + Math.cos(index / 17) * 0.004 + ((index % 7) - 3) * 0.0004
));

describe('security historical risk metrics', () => {
  test('calculates aligned beta from the 252 most recent adjusted-close returns', () => {
    const { benchmarkBars, securityBars } = historiesFromReturns(
      variedReturns,
      (index) => (index < variedReturns.length - BETA_WINDOW_RETURNS ? -3 : 2),
    );

    const beta = calculateAlignedBeta(securityBars, benchmarkBars);

    expect(beta).toMatchObject({
      status: 'available',
      value: 2,
      benchmark: 'SPY',
      observations: BETA_WINDOW_RETURNS,
      windowSessions: BETA_WINDOW_RETURNS,
      minObservations: MIN_BETA_RETURNS,
      source: 'Yahoo Finance chart API',
    });
    expect(beta.calculation.covarianceSum).toEqual(expect.any(Number));
    expect(beta.calculation.benchmarkVarianceSum).toEqual(expect.any(Number));
    expect(
      beta.calculation.covarianceSum / beta.calculation.benchmarkVarianceSum
    ).toBeCloseTo(beta.value, 6);
    expect(beta.asOf).toBe(securityBars[securityBars.length - 1].date);
  });

  test('requires 126 aligned returns and never substitutes raw close for adjusted close', () => {
    const insufficient = historiesFromReturns(variedReturns.slice(0, MIN_BETA_RETURNS - 1));
    expect(calculateAlignedBeta(insufficient.securityBars, insufficient.benchmarkBars)).toMatchObject({
      status: 'unavailable',
      value: null,
      observations: MIN_BETA_RETURNS - 1,
      reason: REASONS.INSUFFICIENT_ALIGNED_RETURNS,
    });

    const sufficient = historiesFromReturns(variedReturns.slice(0, MIN_BETA_RETURNS));
    expect(calculateAlignedBeta(sufficient.securityBars, sufficient.benchmarkBars)).toMatchObject({
      status: 'available',
      observations: MIN_BETA_RETURNS,
    });

    const rawCloseOnly = sufficient.securityBars.map(({ date, adjustedClose }) => ({
      date,
      close: adjustedClose,
    }));
    expect(calculateAlignedBeta(rawCloseOnly, sufficient.benchmarkBars)).toMatchObject({
      status: 'unavailable',
      value: null,
      observations: 0,
    });
  });

  test('calculates both returns across the same adjacent common dates', () => {
    const security = [
      { date: '2026-01-01', adjustedClose: 100 },
      { date: '2026-01-02', adjustedClose: 102 },
      { date: '2026-01-03', adjustedClose: 103 },
      { date: '2026-01-05', adjustedClose: 106 },
    ];
    const benchmark = [
      { date: '2026-01-01', adjustedClose: 50 },
      { date: '2026-01-02', adjustedClose: 51 },
      { date: '2026-01-05', adjustedClose: 53 },
    ];

    const beta = calculateAlignedBeta(security, benchmark, {
      minObservations: 2,
      windowSessions: 2,
    });

    expect(beta.status).toBe('available');
    expect(beta.observations).toBe(2);
    expect(beta.asOf).toBe('2026-01-05');
    expect(beta.value).toBe(1);
    expect(beta.returnBasis).toBe('adjusted-close simple daily returns over adjacent common dates');
  });

  test('calculates ATR14 as the simple mean of the latest 14 full true ranges', () => {
    const bars = Array.from({ length: 15 }, (_, index) => ({
      date: `2026-01-${String(index + 1).padStart(2, '0')}`,
      adjustedClose: 100,
      adjustedHigh: index === 0 ? 101 : 102,
      adjustedLow: index === 0 ? 99 : 99,
    }));

    expect(calculateAtr14(bars)).toEqual(expect.objectContaining({
      status: 'available',
      value: 3,
      observations: 14,
      asOf: '2026-01-15',
      periodSessions: 14,
      source: 'Yahoo Finance chart API',
    }));

    expect(calculateAtr14(bars.slice(0, -1))).toMatchObject({
      status: 'unavailable',
      value: null,
      observations: 13,
      reason: REASONS.INSUFFICIENT_TRUE_RANGES,
    });
  });

  test('calculates price Z-score with population standard deviation over the latest 20 adjusted closes', () => {
    const bars = [
      { date: '2025-12-31', adjustedClose: 10000 },
      ...Array.from({ length: Z_SCORE_PERIOD }, (_, index) => ({
        date: `2026-01-${String(index + 1).padStart(2, '0')}`,
        adjustedClose: index + 1,
      })),
      { date: '2026-01-21', close: 99999 },
    ];

    expect(calculatePriceZScore20(bars)).toEqual({
      status: 'available',
      value: 1.647509,
      source: 'Yahoo Finance chart API',
      asOf: '2026-01-20',
      observations: Z_SCORE_PERIOD,
      reason: null,
      periodSessions: Z_SCORE_PERIOD,
      priceBasis: 'completed adjusted daily close',
    });
  });

  test('fails price Z-score closed for insufficient adjusted closes or zero population variance', () => {
    expect(calculatePriceZScore20(Array.from({ length: Z_SCORE_PERIOD - 1 }, (_, index) => ({
      date: `2026-01-${String(index + 1).padStart(2, '0')}`,
      adjustedClose: index + 1,
    })))).toMatchObject({
      status: 'unavailable',
      value: null,
      asOf: '2026-01-19',
      observations: Z_SCORE_PERIOD - 1,
      periodSessions: Z_SCORE_PERIOD,
      reason: REASONS.INSUFFICIENT_PRICE_HISTORY,
    });

    expect(calculatePriceZScore20(Array.from({ length: Z_SCORE_PERIOD }, (_, index) => ({
      date: `2026-01-${String(index + 1).padStart(2, '0')}`,
      adjustedClose: 100,
    })))).toMatchObject({
      status: 'unavailable',
      value: null,
      asOf: '2026-01-20',
      observations: Z_SCORE_PERIOD,
      periodSessions: Z_SCORE_PERIOD,
      reason: REASONS.ZERO_PRICE_STANDARD_DEVIATION,
    });
  });

  test('calculates prior traded-price records strictly before the comparison date', () => {
    const records = calculatePriorAllTimePrices([
      {
        date: '2026-01-01', close: 90, high: 100, low: 80,
        adjustedClose: 45, adjustedHigh: 50, adjustedLow: 40,
      },
      {
        date: '2026-01-02', close: 95, high: 105, low: 85,
        adjustedClose: 47.5, adjustedHigh: 52.5, adjustedLow: 42.5,
      },
      {
        date: '2026-01-03', close: 100, high: 120, low: 70,
        adjustedClose: 100, adjustedHigh: 120, adjustedLow: 70,
      },
    ], { beforeDate: '2026-01-03' });

    expect(records).toEqual(expect.objectContaining({
      status: 'available',
      priorAllTimeHigh: 105,
      priorAllTimeLow: 80,
      observations: 2,
      asOf: '2026-01-02',
      comparisonBarAsOf: '2026-01-03',
      historyRule: 'strictly before comparison date',
      priceBasis: 'provider daily high and low (not dividend-adjusted)',
      splitHandling: 'provider OHLC as returned; no local split inference or back-adjustment',
    }));
  });

  test('preserves zero and negative traded prices in prior record history', () => {
    const records = calculatePriorAllTimePrices([
      { date: '2020-04-20', close: -20, high: 0, low: -40, adjustedClose: -20 },
      { date: '2020-04-21', close: -5, high: 5, low: -25, adjustedClose: -5 },
    ], { beforeDate: '2020-04-22' });

    expect(records).toMatchObject({
      status: 'available',
      priorAllTimeHigh: 5,
      priorAllTimeLow: -40,
      observations: 2,
    });
  });

  test('accumulates higher highs, adds the strict ATH bonus, and resets before a bearish run', () => {
    const result = calculatePriceStructureRun([
      { date: '2026-07-08', high: 105, low: 90 },
      { date: '2026-07-09', high: 99, low: 90 },
      { date: '2026-07-10', high: 100, low: 90 },
      { date: '2026-07-13', high: 101, low: 90 },
      { date: '2026-07-14', high: 106, low: 90 },
      { date: '2026-07-15', high: 104, low: 90 },
      { date: '2026-07-16', high: 103, low: 90 },
    ], { timelineLimit: 20 });

    const byDate = Object.fromEntries(result.timeline.map((row) => [row.date, row]));

    expect(result).toMatchObject({
      status: 'available',
      asOf: '2026-07-16',
      observations: 7,
      score: -1,
      highLeg: {
        score: -1,
        event: 'LH',
        eventCredit: -1,
        appliedCredit: -1,
        reversal: false,
      },
      lowLeg: { score: 0, event: 'EL' },
      records: { allTimeHigh: 106, allTimeHighDate: '2026-07-14' },
    });
    expect(byDate['2026-07-13']).toMatchObject({
      highEvent: 'HH', highEventCredit: 1, highAppliedCredit: 1, highLegScore: 1,
    });
    expect(byDate['2026-07-14']).toMatchObject({
      highEvent: 'HH + ATH', highEventCredit: 2, highAppliedCredit: 2, highLegScore: 3,
    });
    expect(byDate['2026-07-15']).toMatchObject({
      highEvent: 'LH', highEventCredit: -1, highAppliedCredit: 0, highReversal: true, highLegScore: 0,
    });
    expect(byDate['2026-07-16']).toMatchObject({
      highEvent: 'LH', highEventCredit: -1, highAppliedCredit: -1, highReversal: false, highLegScore: -1,
    });
  });

  test('applies the symmetric ATL bonus and resets before a bullish higher-low run', () => {
    const result = calculatePriceStructureRun([
      { date: '2026-07-08', high: 100, low: 90 },
      { date: '2026-07-09', high: 100, low: 96 },
      { date: '2026-07-10', high: 100, low: 95 },
      { date: '2026-07-13', high: 100, low: 94 },
      { date: '2026-07-14', high: 100, low: 89 },
      { date: '2026-07-15', high: 100, low: 91 },
      { date: '2026-07-16', high: 100, low: 92 },
    ], { timelineLimit: 20 });

    const byDate = Object.fromEntries(result.timeline.map((row) => [row.date, row]));

    expect(byDate['2026-07-13']).toMatchObject({
      lowEvent: 'LL', lowEventCredit: -1, lowAppliedCredit: -1, lowLegScore: -1,
    });
    expect(byDate['2026-07-14']).toMatchObject({
      lowEvent: 'LL + ATL', lowEventCredit: -2, lowAppliedCredit: -2, lowLegScore: -3,
    });
    expect(byDate['2026-07-15']).toMatchObject({
      lowEvent: 'HL', lowEventCredit: 1, lowAppliedCredit: 0, lowReversal: true, lowLegScore: 0,
    });
    expect(byDate['2026-07-16']).toMatchObject({
      lowEvent: 'HL', lowEventCredit: 1, lowAppliedCredit: 1, lowReversal: false, lowLegScore: 1,
    });
    expect(result).toMatchObject({
      status: 'available',
      score: 1,
      highLeg: { score: 0, event: 'EH' },
      lowLeg: { score: 1 },
      records: { allTimeLow: 89, allTimeLowDate: '2026-07-14' },
    });
  });

  test('holds both leg scores and directions when a daily high or low is equal', () => {
    const result = calculatePriceStructureRun([
      { date: '2026-07-13', high: 100, low: 90 },
      { date: '2026-07-14', high: 101, low: 91 },
      { date: '2026-07-15', high: 101, low: 91 },
      { date: '2026-07-16', high: 102, low: 92 },
    ], { timelineLimit: 20 });

    expect(result.timeline[1]).toMatchObject({
      date: '2026-07-15',
      highEvent: 'EH',
      lowEvent: 'EL',
      highEventCredit: 0,
      lowEventCredit: 0,
      highAppliedCredit: 0,
      lowAppliedCredit: 0,
      highReversal: false,
      lowReversal: false,
      highLegScore: 2,
      lowLegScore: 1,
      score: 3,
    });
    expect(result.timeline[2]).toMatchObject({
      date: '2026-07-16',
      highEvent: 'HH + ATH',
      lowEvent: 'HL',
      highLegScore: 4,
      lowLegScore: 2,
      score: 6,
    });
  });

  test('tracks high and low legs independently when their directions diverge', () => {
    const result = calculatePriceStructureRun([
      { date: '2026-07-13', high: 105, low: 90 },
      { date: '2026-07-14', high: 100, low: 91 },
      { date: '2026-07-15', high: 101, low: 92 },
      { date: '2026-07-16', high: 102, low: 91 },
    ], { timelineLimit: 20 });

    expect(result.timeline).toEqual(expect.arrayContaining([
      expect.objectContaining({
        date: '2026-07-14', highLegScore: -1, lowLegScore: 1, score: 0,
      }),
      expect.objectContaining({
        date: '2026-07-15',
        highReversal: true,
        highLegScore: 0,
        lowReversal: false,
        lowLegScore: 2,
        score: 2,
      }),
      expect.objectContaining({
        date: '2026-07-16',
        highReversal: false,
        highLegScore: 1,
        lowReversal: true,
        lowLegScore: 0,
        score: 1,
      }),
    ]));
    expect(result).toMatchObject({
      score: 1,
      highLeg: { score: 1, event: 'HH' },
      lowLeg: { score: 0, event: 'LL', reversal: true },
    });
  });

  test('fails closed when any completed daily bar lacks a high or low', () => {
    expect(calculatePriceStructureRun([
      { date: '2026-07-15', high: 100, low: 90 },
      { date: '2026-07-16', high: 101 },
    ])).toEqual(expect.objectContaining({
      status: 'unavailable',
      reason: REASONS.INSUFFICIENT_PRICE_HISTORY,
      asOf: '2026-07-16',
      observations: 2,
      score: null,
      highLeg: null,
      lowLeg: null,
      timeline: [],
    }));
  });

  test('parses Yahoo adjusted close and adjusts high/low on the same bar', () => {
    const bars = parseYahooChartBars({
      timestamp: [Date.UTC(2026, 0, 2) / 1000],
      indicators: {
        quote: [{ close: [100], high: [110], low: [90] }],
        adjclose: [{ adjclose: [50] }],
      },
    });

    expect(bars).toEqual([{
      date: '2026-01-02',
      timestamp: '2026-01-02T00:00:00.000Z',
      rawClose: 100,
      rawHigh: 110,
      rawLow: 90,
      adjustedClose: 50,
      adjustedHigh: 55,
      adjustedLow: 45,
    }]);

    expect(parseYahooChartBars({
      timestamp: [Date.UTC(2026, 0, 2) / 1000],
      indicators: { quote: [{ close: [100], high: [110], low: [90] }] },
    })[0]).toMatchObject({
      rawClose: 100,
      rawHigh: 110,
      rawLow: 90,
      adjustedClose: null,
      adjustedHigh: null,
      adjustedLow: null,
    });
  });

  test('drops Yahoo current-session daily bars before the regular session closes', () => {
    const first = Date.UTC(2026, 6, 16, 13, 30) / 1000;
    const current = Date.UTC(2026, 6, 17, 13, 30) / 1000;
    const bars = parseYahooChartBars({
      meta: {
        currentTradingPeriod: {
          regular: { start: current, end: current + (6.5 * 60 * 60) },
        },
      },
      timestamp: [first, current],
      indicators: {
        quote: [{ close: [100, 101], high: [102, 103], low: [99, 100] }],
        adjclose: [{ adjclose: [100, 101] }],
      },
    }, { now: (current + 60) * 1000 });

    expect(bars).toHaveLength(1);
    expect(bars[0].date).toBe('2026-07-16');
  });

  test('builds explicit provenance and permanently marks historical metrics non-executable', () => {
    const { benchmarkBars, securityBars } = historiesFromReturns(variedReturns.slice(0, 260), () => 1.5);
    const row = buildSecurityRiskMetrics({
      symbol: 'aapl',
      securityBars,
      benchmarkBars,
      provenance: { provider: 'Yahoo Finance', range: 'max', interval: '1d' },
    });

    expect(row).toMatchObject({
      symbol: 'AAPL',
      status: 'available',
      source: 'Yahoo Finance chart API',
      observations: 261,
      historicalOnly: true,
      executable: false,
      provenance: { provider: 'Yahoo Finance', range: 'max', interval: '1d' },
      beta: { status: 'available', observations: 252 },
      atr14: { status: 'available', observations: 14 },
      zScore20: {
        status: 'available',
        observations: Z_SCORE_PERIOD,
        periodSessions: Z_SCORE_PERIOD,
        priceBasis: 'completed adjusted daily close',
      },
      records: { status: 'available', observations: 261 },
      realizedVolatility: {
        status: 'available',
        limitedHistory: false,
      },
    });
    expect(row.realizedVolatility.sizingVol).toBeGreaterThan(0);
    expect(row.realizedVolatility.rv63).toBeGreaterThan(0);
    expect(row.realizedVolatility.rv252).toBeGreaterThan(0);
  });

  test('unavailable rows contain no inferred metric values', () => {
    const row = createUnavailableSecurityRiskMetrics({
      symbol: 'bad',
      reason: REASONS.HISTORY_UNAVAILABLE,
    });

    expect(row).toMatchObject({
      symbol: 'BAD',
      status: 'unavailable',
      historicalOnly: true,
      executable: false,
      beta: { status: 'unavailable', value: null, observations: 0 },
      atr14: { status: 'unavailable', value: null, observations: 0 },
      zScore20: {
        status: 'unavailable',
        value: null,
        observations: 0,
        periodSessions: Z_SCORE_PERIOD,
        priceBasis: 'completed adjusted daily close',
      },
      records: {
        status: 'unavailable',
        priorAllTimeHigh: null,
        priorAllTimeLow: null,
        observations: 0,
      },
      realizedVolatility: {
        status: 'unavailable',
        sizingVol: null,
        rv63: null,
        rv252: null,
      },
    });
  });

  test('crypto assetType annualizes realized vol with 365 factor', () => {
    const { securityBars, benchmarkBars } = historiesFromReturns(
      variedReturns.slice(0, 120),
      () => 1.1,
    );
    const equity = buildSecurityRiskMetrics({
      symbol: 'IBIT',
      securityBars,
      benchmarkBars,
      assetType: 'equity',
    });
    const crypto = buildSecurityRiskMetrics({
      symbol: 'IBIT',
      securityBars,
      benchmarkBars,
      assetType: 'crypto',
    });
    expect(crypto.realizedVolatility.annualizationFactor).toBe(365);
    expect(equity.realizedVolatility.annualizationFactor).toBe(252);
    expect(crypto.realizedVolatility.sizingVol)
      .toBeGreaterThan(equity.realizedVolatility.sizingVol);
  });
});
