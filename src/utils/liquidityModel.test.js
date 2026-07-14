const {
  annualizedRate,
  alignNoLookahead,
  buildGlobalModel,
  buildUsModel,
  deriveSubtract,
  toMonthly,
} = require('./liquidityModel.cjs');

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
