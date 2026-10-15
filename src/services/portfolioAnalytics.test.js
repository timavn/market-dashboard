import { PortfolioAnalytics } from './portfolioAnalytics';

const holdings = [{ symbol: 'SPY', marketValue: 800, gainLossPercent: 17 },
  { symbol: 'TLT', marketValue: -200, gainLossPercent: -3 }];

test('legacy analytics preserve actual position size without inventing risk, liquidity or factor evidence', () => {
  const metrics = PortfolioAnalytics.calculatePortfolioMetrics(holdings, { summary: {
    totalValue: 1000, totalCostBasis: 900, totalGainLoss: 100, totalGainLossPercent: 11.11,
  } });
  expect(metrics).toMatchObject({
    totalValue: 1000, totalGainLoss: 100, positionCount: 2,
    grossExposure: '100.0', netExposure: '60.0', largestPositionPercent: '80.0',
    volatility: null, sharpeRatio: null, sortinoRatio: null, var95: null, maxDrawdown: null,
    marketCap: { largeCap: null, midCap: null, smallCap: null },
    geographic: { northAmerica: null, europe: null, asiaPacific: null, emergingMarkets: null },
    sensitivities: { ratesBPV: null, fxBeta: null, equityBeta: null, commodityBeta: null },
    liquidity: { buckets: { 'Liquid (<1 day)': null, 'Moderate (1-5 days)': null, 'Illiquid (>5 days)': null },
      topRiskContributors: [{ ticker: 'SPY', contribution: 80, daysToExit: null,
        contributionBasis: 'absolute-position-value-percent-of-account' },
      { ticker: 'TLT', contribution: 20, daysToExit: null,
        contributionBasis: 'absolute-position-value-percent-of-account' }] },
  });
  expect(metrics.scenarios).toHaveLength(5);
  expect(metrics.scenarios.map(({ impact }) => impact)).toEqual([null, null, null, null, null]);
  expect(Object.values(metrics.longShortFactors)).toEqual(Array(7).fill({ long: null, short: null, status: 'unavailable' }));
  expect(PortfolioAnalytics.calculateMaxDrawdown(holdings)).toBeNull();
});

test.each([0, null, undefined, NaN])('missing account value %s does not become zero or infinite exposure', (totalValue) => {
  expect(PortfolioAnalytics.calculateExposureMetrics(holdings, totalValue).grossExposure).toBeNull();
  expect(PortfolioAnalytics.calculateConcentrationMetrics(holdings, totalValue).largestPositionPercent).toBeNull();
  expect(PortfolioAnalytics.calculateLiquidityMetrics(holdings, totalValue).topRiskContributors[0].contribution).toBeNull();
});
