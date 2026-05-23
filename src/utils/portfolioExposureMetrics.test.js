import {
  computePortfolioExposure,
  formatExposurePct,
} from './portfolioExposureMetrics';

describe('computePortfolioExposure', () => {
  it('computes macro long/short exposure from holdings and NLV', () => {
    const result = computePortfolioExposure({
      holdings: [
        { symbol: 'SPY', quantity: 100, marketValue: 60000 },
        { symbol: 'QQQ', quantity: -50, marketValue: -25000 },
      ],
      accountSummary: { netLiquidation: 100000, totalCashValue: 35000 },
    });

    expect(result.longPct).toBeCloseTo(60, 0);
    expect(result.shortPct).toBeCloseTo(25, 0);
    expect(result.grossPct).toBeCloseTo(85, 0);
    expect(result.netPct).toBeCloseTo(35, 0);
    expect(result.cashPct).toBeCloseTo(35, 0);
  });

  it('returns hasData false when NLV unavailable', () => {
    const result = computePortfolioExposure({ holdings: [], accountSummary: null });
    expect(result.hasData).toBe(false);
  });

  it('shows NLV and cash pct with zero holdings when account summary exists', () => {
    const result = computePortfolioExposure({
      holdings: [],
      accountSummary: { netLiquidation: 197478.25, totalCashValue: 30852.65 },
    });

    expect(result.hasData).toBe(true);
    expect(result.nlv).toBeCloseTo(197478.25, 0);
    expect(result.grossPct).toBe(0);
    expect(result.netPct).toBe(0);
    expect(result.longPct).toBe(0);
    expect(result.shortPct).toBe(0);
    expect(result.cashPct).toBeCloseTo(15.6, 0);
  });
});

describe('formatExposurePct', () => {
  it('formats signed net exposure', () => {
    expect(formatExposurePct(12, { signed: true })).toBe('+12%');
    expect(formatExposurePct(-8, { signed: true })).toBe('-8%');
  });
});
