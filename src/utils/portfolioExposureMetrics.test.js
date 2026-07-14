import {
  computePortfolioExposure,
  computeMarginMetrics,
  computeDailyPnLPercent,
  formatExposurePct,
  formatSignedCurrency,
  isUsEquitySessionActive,
  resolvePortfolioHeaderSnapshot,
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

describe('computeMarginMetrics', () => {
  it('computes margin cushion from excess liquidity and NLV', () => {
    const result = computeMarginMetrics({
      netLiquidation: 196187,
      excessLiquidity: 72450,
      availableFunds: 88910,
      initialMargin: 107560,
    });

    expect(result.hasData).toBe(true);
    expect(result.marginCushionPct).toBeCloseTo(36.9, 0);
    expect(result.healthLabel).toBe('Healthy');
    expect(result.excessLiquidity).toBe(72450);
  });

  it('falls back to maintenance margin when excess liquidity missing', () => {
    const result = computeMarginMetrics({
      netLiquidation: 100000,
      maintenanceMargin: 60000,
    });

    expect(result.marginCushionPct).toBeCloseTo(40, 0);
  });
});

describe('computeDailyPnLPercent', () => {
  it('computes daily P&L percent vs prior close', () => {
    expect(computeDailyPnLPercent(2480, 196187)).toBeCloseTo(1.28, 1);
  });
});

describe('isUsEquitySessionActive', () => {
  it('returns false after the close', () => {
    expect(isUsEquitySessionActive(new Date('2026-06-09T01:30:00.000Z'))).toBe(false);
  });

  it('returns true during regular market hours', () => {
    expect(isUsEquitySessionActive(new Date('2026-06-09T15:00:00.000Z'))).toBe(true);
  });
});

describe('resolvePortfolioHeaderSnapshot', () => {
  it('uses live daily P&L when available', () => {
    const result = resolvePortfolioHeaderSnapshot({
      nlv: 196187,
      dailyPnL: 2480,
      sessionActive: true,
      cachedCloseSnapshot: { netLiquidation: 190000, dailyPct: 0.5 },
    });

    expect(result.displayNlv).toBe(196187);
    expect(result.displayDailyPct).toBeCloseTo(1.28, 1);
    expect(result.snapshotToCache).toBeNull();
  });

  it('falls back to cached close when the market is closed and live P&L is missing', () => {
    const result = resolvePortfolioHeaderSnapshot({
      nlv: 196500,
      dailyPnL: null,
      sessionActive: false,
      cachedCloseSnapshot: { netLiquidation: 196187, dailyPct: 1.28 },
    });

    expect(result.displayNlv).toBe(196187);
    expect(result.displayDailyPct).toBe(1.28);
  });

  it('ignores buggy cached zero close values when live P&L is missing after hours', () => {
    const result = resolvePortfolioHeaderSnapshot({
      nlv: 196500,
      dailyPnL: null,
      sessionActive: false,
      cachedCloseSnapshot: { netLiquidation: 196187, dailyPct: 0 },
    });

    expect(result.displayNlv).toBe(196500);
    expect(result.displayDailyPct).toBeNull();
    expect(result.snapshotToCache).toBeNull();
  });

  it('captures the close snapshot when a valid P&L is available after hours', () => {
    const result = resolvePortfolioHeaderSnapshot({
      nlv: 196187,
      dailyPnL: 2480,
      sessionActive: false,
      cachedCloseSnapshot: null,
    });

    expect(result.snapshotToCache?.netLiquidation).toBe(196187);
    expect(result.snapshotToCache?.dailyPct).toBeCloseTo(1.28, 1);
  });
});

describe('formatSignedCurrency', () => {
  it('prefixes positive values with plus', () => {
    expect(formatSignedCurrency(2480)).toBe('+$2,480');
  });
});
