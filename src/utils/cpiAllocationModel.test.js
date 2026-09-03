import {
  buildCpiAllocationModel,
  buildCpiCalibratedProbabilityCurve,
  calculateKalshiTakerFee,
} from './cpiAllocationModel';

const NOW = Date.parse('2026-08-09T20:32:30.000Z');

const MODEL = {
  metric: 'Headline CPI YoY',
  forecastMonth: 'July 2026',
  scenarios: [
    { key: 'downside', label: 'Downside', value: 3.37 },
    { key: 'base', label: 'Base Case', value: 3.48 },
    { key: 'upside', label: 'Upside', value: 3.59 },
  ],
};

const HISTORICAL = [
  ['2025-07', 2.49, 2.60, 2.72, 2.7],
  ['2025-08', 2.71, 2.83, 2.94, 2.9],
  ['2025-09', 2.99, 3.10, 3.21, 3.0],
  ['2025-11', 2.93, 3.04, 3.15, 2.7],
  ['2025-12', 2.45, 2.56, 2.67, 2.7],
  ['2026-01', 2.39, 2.50, 2.61, 2.4],
  ['2026-02', 2.33, 2.44, 2.55, 2.4],
  ['2026-03', 3.20, 3.31, 3.42, 3.3],
  ['2026-04', 3.51, 3.62, 3.73, 3.8],
  ['2026-05', 4.13, 4.24, 4.35, 4.2],
  ['2026-06', 3.72, 3.83, 3.94, 3.5],
];

const HISTORY = {
  entries: HISTORICAL.map(([monthId, lower, base, upper]) => ({
    monthId,
    status: 'final-pre-release',
    scenarios: {
      lower: { raw: lower, rounded: Number(lower.toFixed(1)) },
      base: { raw: base, rounded: Number(base.toFixed(1)) },
      upper: { raw: upper, rounded: Number(upper.toFixed(1)) },
    },
  })),
};

const FINALS = HISTORICAL.map(([id, , , , value]) => ({ id, value }));

function makeRows(overrides = {}) {
  const asks = [0.94, 0.76, 0.55, 0.34, 0.17, 0.08, 0.03];
  return asks.map((yesAsk, index) => {
    const threshold = Number((3.2 + index / 10).toFixed(1));
    const yesBid = Math.max(0.01, yesAsk - 0.02);
    return {
      id: `kalshi-${threshold}`,
      venue: 'Kalshi',
      threshold,
      yesPrice: yesAsk,
      noPrice: Math.min(0.99, 1 - yesBid),
      payoutMultiplier: 1,
      missingContract: false,
      event: {
        venue: 'Kalshi',
        source_api: 'kalshi_trade_api_v2',
        status: 'open',
        contract_title: `Above ${threshold}%`,
        yes_bid: yesBid,
        yes_ask: yesAsk,
        no_ask: Math.min(0.99, 1 - yesBid),
        yes_bid_size: 10000,
        yes_ask_size: 10000,
        quote_retrieved_at: new Date(NOW - 30000).toISOString(),
        data_quality_flags: [],
        ...overrides,
      },
    };
  });
}

describe('CPI calibrated probability curve', () => {
  test('builds a monotonic continuous curve at strict rounded settlement boundaries', () => {
    const curve = buildCpiCalibratedProbabilityCurve({
      model: MODEL,
      history: HISTORY,
      finals: FINALS,
      rows: makeRows(),
    });

    expect(curve.status).toBe('ready');
    expect(curve.observations).toBe(11);
    expect(curve.probabilities).toHaveLength(7);
    expect(curve.probabilities[2].boundary).toBeCloseTo(3.45);
    curve.probabilities.forEach((entry) => {
      expect(entry.fairProbability).toBeGreaterThan(0);
      expect(entry.fairProbability).toBeLessThan(1);
    });
    expect(curve.probabilities.every((entry, index, entries) => (
      index === 0 || entry.fairProbability <= entries[index - 1].fairProbability
    ))).toBe(true);
    expect(curve.probabilities.some((entry) => (
      ![0, 1 / 3, 2 / 3, 1].some((value) => Math.abs(value - entry.fairProbability) < 0.0001)
    ))).toBe(true);
  });

  test('fails closed when resolved history or direct two-sided books are insufficient', () => {
    expect(buildCpiCalibratedProbabilityCurve({
      model: MODEL,
      history: { entries: HISTORY.entries.slice(0, 7) },
      finals: FINALS,
      rows: makeRows(),
    })).toEqual(expect.objectContaining({
      status: 'unavailable',
      reason: 'insufficient_calibration_history',
      probabilities: [],
    }));

    expect(buildCpiCalibratedProbabilityCurve({
      model: MODEL,
      history: HISTORY,
      finals: FINALS,
      rows: makeRows().slice(0, 2),
    })).toEqual(expect.objectContaining({
      status: 'unavailable',
      reason: 'insufficient_live_market_curve',
      probabilities: [],
    }));
  });
});

describe('CPI portfolio allocator', () => {
  test('uses the published Kalshi taker-fee rounding formula', () => {
    expect(calculateKalshiTakerFee(1, 0.5)).toBe(0.02);
    expect(calculateKalshiTakerFee(100, 0.2)).toBe(1.12);
    expect(calculateKalshiTakerFee(0, 0.2)).toBe(0);
  });

  test('deploys a one-percent budget across unique strikes within depth and risk caps', () => {
    const result = buildCpiAllocationModel({
      model: MODEL,
      history: HISTORY,
      finals: FINALS,
      rows: makeRows(),
      portfolioEquity: 100000,
      riskPct: 1,
      now: NOW,
      settings: {
        maxRiskPerBet: 300,
        maxOpenRisk: 10000,
        maxCorrelatedExposure: 3000,
        maxPmRiskPct: 0.05,
      },
    });

    expect(result.status).toBe('ready');
    expect(result.requestedBudget).toBeCloseTo(1000);
    expect(result.effectiveBudget).toBeCloseTo(1000);
    expect(result.allocations).toHaveLength(7);
    expect(new Set(result.allocations.map((row) => row.threshold)).size).toBe(7);
    expect(result.deployedBudget).toBeLessThanOrEqual(1000);
    expect(result.deployedBudget).toBeGreaterThan(990);
    expect(result.allocations.filter((row) => row.contracts > 0).length).toBeGreaterThan(1);
    result.allocations.forEach((row) => {
      expect(['YES', 'NO']).toContain(row.side);
      expect(row.allocation).toBeLessThanOrEqual(300.01);
      expect(row.contracts).toBeLessThanOrEqual(row.depthCap);
    });
    expect(result.settlementStates.reduce((sum, state) => sum + state.probability, 0)).toBeCloseTo(1);
  });

  test('counts current positions against the correlated guardrail and combined payoff', () => {
    const result = buildCpiAllocationModel({
      model: MODEL,
      history: HISTORY,
      finals: FINALS,
      rows: makeRows(),
      openPositions: [{
        id: 'held-34',
        title: 'Above 3.4 YES',
        contractSide: 'YES',
        quantity: 1000,
        avgPrice: 0.6,
      }],
      portfolioEquity: 100000,
      riskPct: 1,
      now: NOW,
      settings: {
        maxRiskPerBet: 500,
        maxOpenRisk: 10000,
        maxCorrelatedExposure: 900,
        maxPmRiskPct: 0.05,
      },
    });

    expect(result.status).toBe('ready');
    expect(result.metrics.currentWorstLoss).toBeCloseTo(600);
    expect(result.effectiveBudget).toBeCloseTo(300);
    expect(result.settlementStates.some((state) => state.currentPnl !== 0)).toBe(true);
    expect(result.settlementStates.some((state) => state.combinedPnl !== state.proposedPnl)).toBe(true);
  });

  test.each([
    ['stale quote', { quote_retrieved_at: new Date(NOW - 180000).toISOString() }],
    ['portfolio seed', { data_quality_flags: ['portfolio_seed'] }],
    ['portfolio-derived row', { data_quality_flags: ['portfolio_derived'] }],
    ['cached row', { data_quality_flags: ['cached'] }],
    ['portfolio source', { source_api: 'IBKR_PORTFOLIO' }],
    ['mock row', { data_quality_flags: ['mock'] }],
    ['missing depth', { yes_bid_size: null, yes_ask_size: null }],
  ])('never allocates from %s input', (_label, eventOverride) => {
    const result = buildCpiAllocationModel({
      model: MODEL,
      history: HISTORY,
      finals: FINALS,
      rows: makeRows(eventOverride),
      portfolioEquity: 100000,
      riskPct: 1,
      now: NOW,
    });

    expect(result).toEqual(expect.objectContaining({
      status: 'unavailable',
      reason: 'no_live_executable_depth',
      allocations: [],
      deployedBudget: 0,
    }));
  });

  test('fails closed for one-sided rows with no executable native asks', () => {
    const rows = makeRows().map((row) => ({
      ...row,
      yesPrice: null,
      noPrice: null,
      event: { ...row.event, yes_ask: null, no_ask: null },
    }));
    const result = buildCpiAllocationModel({
      model: MODEL,
      history: HISTORY,
      finals: FINALS,
      rows,
      portfolioEquity: 100000,
      riskPct: 1,
      now: NOW,
    });

    expect(result.status).toBe('unavailable');
    expect(['insufficient_live_market_curve', 'no_live_executable_depth']).toContain(result.reason);
    expect(result.allocations).toEqual([]);
  });

  test('fails closed when the market-data provider is not verified live', () => {
    const result = buildCpiAllocationModel({
      model: MODEL,
      history: HISTORY,
      finals: FINALS,
      rows: makeRows(),
      portfolioEquity: 100000,
      riskPct: 1,
      providerReady: false,
      now: NOW,
    });

    expect(result).toMatchObject({
      status: 'unavailable',
      reason: 'live_provider_unavailable',
      allocations: [],
    });
  });
});
