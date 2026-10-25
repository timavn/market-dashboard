const {
  annualizedRate,
  alignNoLookahead,
  buildGlobalModel,
  buildNetLiquidityModel,
  buildUsModel,
  deriveSubtract,
  toMonthly,
} = require('./liquidityModel.cjs');
const {
  GLOBAL_LIQUIDITY_RATIO_PRESSURE_WEIGHTS,
  GLOBAL_LIQUIDITY_REGIME_THRESHOLDS,
  GLOBAL_LIQUIDITY_SCORE_BREAKPOINTS,
  GLOBAL_LIQUIDITY_WEIGHTS,
  US_LIQUIDITY_ACCELERATION_TOLERANCE,
  US_LIQUIDITY_GREEN_STACK_TO_GDP,
} = require('../constants/liquidityModelMetadata.cjs');

const monthlySeries = (start, values) => {
  const startDate = new Date(`${start}T00:00:00Z`);
  return values.map((value, index) => {
    const date = new Date(startDate);
    date.setUTCMonth(date.getUTCMonth() + index);
    return {
      date: date.toISOString().slice(0, 10),
      value,
    };
  });
};

describe('liquidity model math', () => {
  test('publishes immutable methodology metadata used by the operator guide', () => {
    expect(GLOBAL_LIQUIDITY_WEIGHTS).toEqual({
      m2_growth_1m: 0.10,
      m2_growth_3m: 0.25,
      m2_growth_6m: 0.25,
      growth_gap: 0.25,
      m2_to_gdp_pressure: 0.15,
    });
    expect(GLOBAL_LIQUIDITY_RATIO_PRESSURE_WEIGHTS).toEqual({
      level: 0.50,
      trend3m: 0.25,
      trend6m: 0.25,
    });
    expect(GLOBAL_LIQUIDITY_REGIME_THRESHOLDS).toEqual({
      supportiveBelow: 30,
      neutralCautionBelow: 60,
      yellowRiskBelow: 80,
    });
    expect(GLOBAL_LIQUIDITY_SCORE_BREAKPOINTS.growth).toEqual([
      [-0.05, 100], [0, 65], [0.05, 35], [0.10, 10], [0.15, 0],
    ]);
    expect(US_LIQUIDITY_ACCELERATION_TOLERANCE).toBe(0.0025);
    expect(US_LIQUIDITY_GREEN_STACK_TO_GDP).toBe(1.05);
    expect(Object.isFrozen(GLOBAL_LIQUIDITY_WEIGHTS)).toBe(true);
    expect(Object.isFrozen(GLOBAL_LIQUIDITY_SCORE_BREAKPOINTS.growth)).toBe(true);
  });

  test('one-month positive growth annualizes', () => {
    expect(annualizedRate(100.5, 100, 1)).toBeCloseTo((1.005 ** 12) - 1);
  });

  test('three-month window annualizes', () => {
    expect(annualizedRate(103, 100, 3)).toBeCloseTo((1.03 ** 4) - 1);
  });

  test('monthly average groups daily FX observations', () => {
    const monthly = toMonthly([
      { date: '2024-01-02', value: 1 },
      { date: '2024-01-17', value: 2 },
      { date: '2024-02-01', value: 3 },
    ], 'average');

    expect(monthly[0]).toEqual({ date: '2024-01-01', value: 1.5 });
    expect(monthly[1]).toEqual({ date: '2024-02-01', value: 3 });
  });

  test('GDP no-lookahead alignment waits for release month', () => {
    const aligned = alignNoLookahead([
      { date: '2024-01-01', value: 100 },
      { date: '2024-04-01', value: 104 },
    ], 'last', 1, new Date('2024-06-15T00:00:00Z'));

    const byDate = Object.fromEntries(aligned.map((point) => [point.date, point.value]));
    expect(byDate['2024-01-01']).toBeUndefined();
    expect(byDate['2024-02-01']).toBe(100);
    expect(byDate['2024-04-01']).toBe(100);
    expect(byDate['2024-05-01']).toBe(104);
  });
});

describe('US dollar liquidity stack', () => {
  test('derives institutional MMF and excludes total MMF from final stack', async () => {
    const flat = monthlySeries('2024-01-01', Array(15).fill(1));
    const loadSeriesOverride = (source) => {
      if (source.seriesId === 'DPSACBW027SBOG') return flat.map((point) => ({ ...point, value: 1000 }));
      if (source.seriesId === 'RMFSL') return flat.map((point) => ({ ...point, value: 200 }));
      if (source.seriesId === 'MMMFFAQ027S') return flat.map((point) => ({ ...point, value: 700000 }));
      if (source.seriesId === 'WCURCIR') return flat.map((point) => ({ ...point, value: 100000 }));
      if (source.seriesId === 'GDP') return flat.map((point) => ({ ...point, value: 2000 }));
      return [];
    };

    const model = await buildUsModel({
      loadSeriesOverride,
      now: new Date('2025-03-15T00:00:00Z'),
      startDate: '2024-01-01',
    });

    expect(model.status).toBe('ok');
    expect(model.latest.dollarLiquidityStack).toBe(1800);
    expect(model.components.find((component) => component.code === 'institutional_mmf').value).toBe(500);
    expect(model.components.find((component) => component.code === 'total_mmf')).toBeUndefined();
  });

  test('negative derived institutional MMF raises', () => {
    expect(() => deriveSubtract(
      { code: 'institutional_mmf', derived: { allowNegative: false } },
      [{ date: '2024-01-01', value: 700 }],
      [{ date: '2024-01-01', value: 800 }]
    )).toThrow('produced negative values');
  });
});

describe('global liquidity input integrity', () => {
  test('missing manual global CSV returns partial without fabricated latest data', async () => {
    const flat = monthlySeries('2024-01-01', Array(15).fill(100));
    const loadSeriesOverride = (source) => {
      if (source.kind === 'csv') {
        throw new Error(`Missing CSV source: ${source.path}`);
      }
      if (source.kind === 'constant') return flat.map((point) => ({ ...point, value: source.value }));
      return flat;
    };

    const model = await buildGlobalModel({
      loadSeriesOverride,
      now: new Date('2025-03-15T00:00:00Z'),
      startDate: '2024-01-01',
    });

    expect(model.status).toBe('partial');
    expect(model.latest).toBeNull();
    expect(model.history).toEqual([]);
    expect(model.missingInputs).toEqual(expect.arrayContaining([
      'Eurozone nominal GDP',
      'UK broad money',
      'China nominal GDP',
    ]));
  });
});

describe('Fed net liquidity model', () => {
  // 60 Wednesdays ending 2026-10-21; Fed assets grow $10B a week in millions.
  const wednesdays = Array.from({ length: 60 }, (_, index) => (
    new Date(Date.parse('2026-10-21T00:00:00Z') - (59 - index) * 7 * 86400000).toISOString().slice(0, 10)
  ));
  const weekly = (valueAt) => wednesdays.map((date, index) => ({ date, value: valueAt(index) }));
  const series = {
    WALCL: weekly((index) => 6_000_000 + index * 10_000),
    WTREGEN: weekly(() => 800_000),
    // Daily reverse repo posted the day before each Wednesday, in billions.
    RRPONTSYD: wednesdays.map((date) => ({
      date: new Date(Date.parse(`${date}T00:00:00Z`) - 86400000).toISOString().slice(0, 10),
      value: 100,
    })),
  };
  const loadSeriesOverride = async (source) => series[source.seriesId];

  test('nets the Fed balance sheet against the TGA and reverse repo in billions', async () => {
    const model = await buildNetLiquidityModel({ loadSeriesOverride, now: new Date('2026-10-23T12:00:00Z') });

    expect(model.status).toBe('ok');
    expect(model.latest).toMatchObject({
      date: '2026-10-21',
      fedBalanceSheet: 6590,
      treasuryGeneralAccount: 800,
      reverseRepo: 100,
      netLiquidity: 5690,
      regime: 'expanding',
    });
    expect(model.latest.changes['4w']).toMatchObject({ change: 40, direction: 'expanding' });
    expect(model.latest.changes['52w'].change).toBeCloseTo(520);
    expect(model.history).toHaveLength(60);
  });

  test('marks contraction when the TGA drains liquidity on both windows', async () => {
    const draining = { ...series, WTREGEN: weekly((index) => 800_000 + index * 25_000) };
    const model = await buildNetLiquidityModel({
      loadSeriesOverride: async (source) => draining[source.seriesId],
      now: new Date('2026-10-23T12:00:00Z'),
    });

    expect(model.latest.changes['13w'].direction).toBe('contracting');
    expect(model.latest.regime).toBe('contracting');
  });

  test('flags stale weekly data and reports missing inputs instead of estimating', async () => {
    const stale = await buildNetLiquidityModel({ loadSeriesOverride, now: new Date('2026-11-20T12:00:00Z') });
    expect(stale.status).toBe('stale');

    const missing = await buildNetLiquidityModel({
      loadSeriesOverride: async (source) => (source.seriesId === 'RRPONTSYD' ? [] : series[source.seriesId]),
      now: new Date('2026-10-23T12:00:00Z'),
    });
    expect(missing).toMatchObject({ status: 'unavailable', latest: null, missingInputs: ['Overnight reverse repo'] });
  });
});
