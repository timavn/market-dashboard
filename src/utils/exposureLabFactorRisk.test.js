const {
  buildFactorNeutralizationScenarios,
  buildPortfolioFactorRiskSnapshot,
  classifySampleQuality,
  regressSecurityReturns,
} = require('./exposureLabFactorRisk.cjs');

function barsFromReturns(returns, start = '2025-01-01') {
  let price = 100;
  const startTime = new Date(`${start}T00:00:00.000Z`).getTime();
  const bars = [{ date: start, adjustedClose: price, close: price }];
  returns.forEach((value, index) => {
    price *= 1 + value;
    const date = new Date(startTime + (index + 1) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    bars.push({ date, adjustedClose: price, close: price });
  });
  return bars;
}

function deterministicReturns(length, phase = 0) {
  return Array.from({ length }, (_, index) => (
    Math.sin((index + phase) / 7) * 0.006 + Math.cos((index + phase) / 19) * 0.003
  ));
}

describe('exposureLabFactorRisk', () => {
  const factorDefinitions = [
    { id: 'market', label: 'Market', family: 'Market', longSymbol: 'SPY' },
    { id: 'value', label: 'Value', family: 'Style', longSymbol: 'IWD', shortSymbol: 'IWF' },
  ];
  const market = deterministicReturns(190, 0);
  const growth = deterministicReturns(190, 11).map((value) => value * 0.8);
  const valueLong = deterministicReturns(190, 23).map((value) => value * 0.7);
  const valueSpread = valueLong.map((value, index) => value - growth[index]);
  const alpha = market.map((value, index) => 0.8 * value + 0.5 * valueSpread[index]);
  const beta = market.map((value) => -0.4 * value);
  const histories = {
    SPY: barsFromReturns(market),
    IWD: barsFromReturns(valueLong),
    IWF: barsFromReturns(growth),
    AAA: barsFromReturns(alpha),
    BBB: barsFromReturns(beta),
  };

  test.each([
    [29, null, 'insufficient', false, 30],
    [30, 30, 'early', false, 60],
    [59, 30, 'early', false, 60],
    [60, 60, 'building', false, 90],
    [90, 90, 'moderate', false, 120],
    [120, 120, 'seasoned', true, null],
  ])('classifies %i aligned returns into the progressive sample tier', (
    observations,
    tier,
    state,
    complete,
    nextTier,
  ) => {
    expect(classifySampleQuality(observations)).toEqual(expect.objectContaining({
      observations,
      tier,
      state,
      complete,
      nextTier,
    }));
  });

  test('estimates multivariate adjusted-return loadings with dated provenance', () => {
    const factorRows = market.map((value, index) => ({
      date: histories.SPY[index + 1].date,
      values: [value, valueSpread[index]],
    }));
    const model = regressSecurityReturns({
      securityBars: histories.AAA,
      factorRows,
      factors: factorDefinitions,
      sessions: 180,
      minObservations: 126,
      ridgeLambda: 0.01,
    });
    expect(model.status).toBe('available');
    expect(model.observations).toBe(180);
    expect(model.loadings.market.value).toBeGreaterThan(0.6);
    expect(model.loadings.value.value).toBeGreaterThan(0.3);
    expect(model.rSquared).toBeGreaterThan(0.9);
    expect(model.methodology.returnBasis).toContain('adjusted-close');
  });

  test('aggregates signed long/short contributions and reconciles modeled variance', () => {
    const snapshot = buildPortfolioFactorRiskSnapshot({
      holdings: [
        { symbol: 'AAA', marketValue: 500_000, quantity: 100, description: 'Alpha' },
        { symbol: 'BBB', marketValue: -250_000, quantity: -50, description: 'Beta short' },
      ],
      totalValue: 1_000_000,
      histories,
      factorDefinitions,
      regressionSessions: 180,
      minObservations: 126,
      covarianceWindow: 90,
    });
    expect(snapshot.status).toBe('available');
    expect(snapshot.historicalOnly).toBe(true);
    expect(snapshot.executable).toBe(false);
    expect(snapshot.portfolio.netExposurePct).toBe(25);
    expect(snapshot.portfolio.grossExposurePct).toBe(75);
    expect(snapshot.factors.find((factor) => factor.id === 'market').netExposure).toBeGreaterThan(0);
    expect(snapshot.portfolio.totalVariance).toBeCloseTo(
      snapshot.portfolio.factorVariance + snapshot.portfolio.residualVariance,
      8,
    );
    expect(snapshot.correlations['90'].market.market.value).toBe(1);
    expect(snapshot.coverage.modeledPositionCount).toBe(2);
  });

  test('models a 73-return security as a preliminary 60-return tier', () => {
    const snapshot = buildPortfolioFactorRiskSnapshot({
      holdings: [
        { symbol: 'SUJA', marketValue: -25_000, quantity: -500, description: 'Short-history security' },
      ],
      totalValue: 1_000_000,
      histories: {
        ...histories,
        SUJA: barsFromReturns(alpha.slice(0, 73)),
      },
      factorDefinitions,
      covarianceWindow: 90,
    });
    const position = snapshot.positions.find((row) => row.symbol === 'SUJA');

    expect(snapshot.status).toBe('partial');
    expect(position.modelStatus).toBe('available');
    expect(position.observations).toBe(73);
    expect(position.sampleQuality).toEqual(expect.objectContaining({
      tier: 60,
      state: 'building',
      preliminary: true,
      complete: false,
      nextTier: 90,
      observationsToNextTier: 17,
    }));
    expect(position.loadings.market.value).not.toBeNull();
    expect(snapshot.coverage).toEqual(expect.objectContaining({
      modeledPositionCount: 1,
      preliminaryPositionCount: 1,
      seasonedPositionCount: 0,
      unmodeledGrossNavPct: 0,
    }));
  });

  test('fails closed when NAV or factor history is unavailable', () => {
    expect(buildPortfolioFactorRiskSnapshot({ totalValue: null }).reason).toBe('net_liquidation_unavailable');
    const snapshot = buildPortfolioFactorRiskSnapshot({
      holdings: [{ symbol: 'AAA', marketValue: 100 }],
      totalValue: 100,
      histories: {},
      factorDefinitions,
    });
    expect(snapshot.status).toBe('unavailable');
    expect(snapshot.positions).toEqual([]);
  });

  test('sizes research-only factor-neutral pairs only with live marks and reviewed proxies', () => {
    const riskSnapshot = {
      status: 'available',
      factors: [{
        id: 'value',
        label: 'Value',
        family: 'Style',
        formula: 'IWD - IWF',
        netExposurePct: 4,
        contributionToTotalRiskPct: 20,
      }],
    };
    const reviews = ['IWD', 'IWF'].map((ticker) => ({
      ticker,
      canonicalSymbol: ticker,
      identityStatus: 'verified',
      analysisEligible: true,
      hedgeEligible: true,
    }));
    const preview = buildFactorNeutralizationScenarios({
      riskSnapshot,
      totalValue: 1_000_000,
      factorDefinitions: [{
        id: 'value', label: 'Value', family: 'Style', longSymbol: 'IWD', shortSymbol: 'IWF',
      }],
      securityReviews: reviews,
      portfolioMode: 'live',
    });
    expect(preview.available).toBe(true);
    expect(preview.executable).toBe(false);
    expect(preview.orderSubmitted).toBe(false);
    expect(preview.rows[0].requiredFactorChangePct).toBe(-4);
    expect(preview.rows[0].legs).toEqual([
      expect.objectContaining({ symbol: 'IWD', action: 'SELL', notional: 40_000 }),
      expect.objectContaining({ symbol: 'IWF', action: 'BUY', notional: 40_000 }),
    ]);

    const preliminaryBlocked = buildFactorNeutralizationScenarios({
      riskSnapshot: {
        ...riskSnapshot,
        positions: [{
          symbol: 'SUJA',
          modelStatus: 'available',
          sampleQuality: { complete: false, preliminary: true },
        }],
      },
      totalValue: 1_000_000,
      factorDefinitions: [{
        id: 'value', label: 'Value', family: 'Style', longSymbol: 'IWD', shortSymbol: 'IWF',
      }],
      securityReviews: reviews,
      portfolioMode: 'live',
    });
    expect(preliminaryBlocked.available).toBe(false);
    expect(preliminaryBlocked.blockers).toContain('preliminary_security_models');
    expect(preliminaryBlocked.rows[0].legs.every((leg) => leg.notional == null)).toBe(true);

    const blocked = buildFactorNeutralizationScenarios({
      riskSnapshot,
      totalValue: 1_000_000,
      factorDefinitions: [{
        id: 'value', label: 'Value', family: 'Style', longSymbol: 'IWD', shortSymbol: 'IWF',
      }],
      securityReviews: reviews,
      portfolioMode: 'reference',
    });
    expect(blocked.available).toBe(false);
    expect(blocked.rows[0].legs.every((leg) => leg.notional == null)).toBe(true);
    expect(blocked.blockers).toContain('live_marks_unavailable');
  });
});
