const {
  computeVolatilityPositionSizing,
  sizeEqualRisk,
  sizeRiskBudget,
} = require('./volatilityPositionSizing.cjs');

describe('volatilityPositionSizing', () => {
  const live = (position) => ({ ...position, liveMarkVerified: true });
  const liveOptions = (options) => ({ ...options, livePortfolioVerified: true });

  test('equal-risk weights inverse to sizing vol and normalize to allocation', () => {
    const rows = sizeEqualRisk(
      [
        live({ symbol: 'AAA', sizingVol: 0.20, currentPositionDollars: 10000 }),
        live({ symbol: 'BBB', sizingVol: 0.40, currentPositionDollars: 5000 }),
      ],
      liveOptions({ portfolioValue: 100000, totalAllocationPct: 50 }),
    );
    expect(rows[0].suggestedWeightPct).toBeCloseTo(100 / 3, 5); // 2/3 of 50%
    expect(rows[1].suggestedWeightPct).toBeCloseTo(50 / 3, 5); // 1/3 of 50%
    expect(rows[0].suggestedDollars).toBeCloseTo(33333.333, 1);
    expect(rows[1].suggestedDollars).toBeCloseTo(16666.667, 1);
    expect(rows[0].referenceOnly).toBe(true);
    expect(rows[0].executable).toBe(false);
    expect(rows[0].differenceDollars).toBeCloseTo(23333.333, 1);
  });

  test('equal-risk applies max weight cap and redistributes', () => {
    const rows = sizeEqualRisk(
      [
        live({ symbol: 'LOW', sizingVol: 0.10 }),
        live({ symbol: 'HIGH', sizingVol: 0.50 }),
      ],
      liveOptions({
        portfolioValue: 100000,
        totalAllocationPct: 100,
        maxWeightPct: 60,
      }),
    );
    expect(rows[0].suggestedWeightPct).toBeLessThanOrEqual(60 + 1e-9);
    expect(rows[0].suggestedWeightPct + rows[1].suggestedWeightPct)
      .toBeCloseTo(100, 5);
  });

  test('equal-risk applies max dollar notional cap', () => {
    const rows = sizeEqualRisk(
      [
        live({ symbol: 'A', sizingVol: 0.20 }),
        live({ symbol: 'B', sizingVol: 0.20 }),
      ],
      liveOptions({
        portfolioValue: 100000,
        totalAllocationPct: 100,
        maxDollarNotional: 30000,
      }),
    );
    rows.forEach((row) => {
      expect(row.suggestedDollars).toBeLessThanOrEqual(30000 + 1e-6);
    });
  });

  test('risk-budget notional is NLV * budget / sizingVol', () => {
    const rows = sizeRiskBudget(
      [live({ symbol: 'XYZ', sizingVol: 0.25, currentPositionDollars: 8000 })],
      liveOptions({ portfolioValue: 200000, riskBudgetPct: 1 }),
    );
    // 200000 * 0.01 / 0.25 = 8000
    expect(rows[0].suggestedDollars).toBeCloseTo(8000, 5);
    expect(rows[0].suggestedWeightPct).toBeCloseTo(4, 5);
    expect(rows[0].differenceDollars).toBeCloseTo(0, 5);
  });

  test('risk-budget respects dollar and weight caps', () => {
    const rows = sizeRiskBudget(
      [live({ symbol: 'HOT', sizingVol: 0.05 })],
      liveOptions({
        portfolioValue: 100000,
        riskBudgetPct: 2,
        maxDollarNotional: 10000,
        maxWeightPct: 8,
      }),
    );
    // uncapped would be 100000*0.02/0.05 = 40000 → capped by dollar then weight
    expect(rows[0].suggestedDollars).toBeLessThanOrEqual(10000 + 1e-6);
    expect(rows[0].suggestedWeightPct).toBeLessThanOrEqual(8 + 1e-9);
  });

  test('missing sizing vol yields unavailable zero suggestion', () => {
    const rows = computeVolatilityPositionSizing(
      [
        live({ symbol: 'OK', sizingVol: 0.3 }),
        live({ symbol: 'MISS', sizingVol: null }),
      ],
      liveOptions({ mode: 'equal-risk', portfolioValue: 50000, totalAllocationPct: 40 }),
    );
    expect(rows.find((r) => r.symbol === 'MISS').suggestedDollars).toBeNull();
    expect(rows.find((r) => r.symbol === 'MISS').available).toBe(false);
    expect(rows.find((r) => r.symbol === 'OK').suggestedWeightPct).toBeCloseTo(40, 5);
  });

  test('computeVolatilityPositionSizing routes modes', () => {
    const equal = computeVolatilityPositionSizing(
      [live({ symbol: 'A', sizingVol: 0.2 })],
      liveOptions({ mode: 'equal-risk', portfolioValue: 10000, totalAllocationPct: 10 }),
    );
    const budget = computeVolatilityPositionSizing(
      [live({ symbol: 'A', sizingVol: 0.2 })],
      liveOptions({ mode: 'risk-budget', portfolioValue: 10000, riskBudgetPct: 1 }),
    );
    expect(equal[0].mode).toBe('equal-risk');
    expect(budget[0].mode).toBe('risk-budget');
  });

  test.each(['equal-risk', 'risk-budget'])(
    'keeps %s suggestions null without verified live portfolio and row marks',
    (mode) => {
      const options = {
        mode,
        portfolioValue: 100000,
        totalAllocationPct: 50,
        riskBudgetPct: 1,
      };
      const missingPortfolioProof = computeVolatilityPositionSizing(
        [live({ symbol: 'NO_NAV', sizingVol: 0.2, currentPositionDollars: 10000 })],
        options,
      )[0];
      const missingMarkProof = computeVolatilityPositionSizing(
        [{ symbol: 'NO_MARK', sizingVol: 0.2, currentPositionDollars: 10000 }],
        liveOptions(options),
      )[0];

      [missingPortfolioProof, missingMarkProof].forEach((row) => {
        expect(row.available).toBe(false);
        expect(row.suggestedWeight).toBeNull();
        expect(row.suggestedWeightPct).toBeNull();
        expect(row.suggestedDollars).toBeNull();
        expect(row.currentPositionDollars).toBeNull();
        expect(row.executable).toBe(false);
      });
    },
  );
});
