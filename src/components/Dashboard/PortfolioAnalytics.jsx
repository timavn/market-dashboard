import React from 'react';
import { Card, Title, Text, Badge } from '@tremor/react';

const PortfolioAnalytics = ({ portfolioData }) => {
  if (!portfolioData || !portfolioData.summary) {
    return (
      <Card className="dark:bg-gray-800">
        <Title className="mb-2 dark:text-white">Portfolio Analytics</Title>
        <Text className="text-xs text-gray-500 dark:text-gray-400">
          No portfolio data available
        </Text>
      </Card>
    );
  }

  // Use pre-calculated metrics from portfolioData if available, otherwise calculate
  const analytics = portfolioData.riskMetrics ? {
    volatility: portfolioData.riskMetrics.volatility,
    sharpeRatio: portfolioData.riskMetrics.sharpeRatio,
    sortinoRatio: portfolioData.riskMetrics.sortinoRatio,
    var95: portfolioData.riskMetrics.var95,
    maxDrawdown: portfolioData.riskMetrics.maxDrawdown,
    grossExposure: portfolioData.exposureMetrics?.grossExposure,
    netLongExposure: portfolioData.exposureMetrics?.netLongExposure,
    netShortExposure: portfolioData.exposureMetrics?.netShortExposure,
    netExposure: portfolioData.exposureMetrics?.netExposure,
    top10HoldingsPercent: portfolioData.concentrationMetrics?.top10HoldingsPercent,
    largestPositionPercent: portfolioData.concentrationMetrics?.largestPositionPercent,
    hhiIndex: portfolioData.concentrationMetrics?.hhiIndex,
    largeCap: portfolioData.factorExposures?.marketCap?.largeCap,
    midCap: portfolioData.factorExposures?.marketCap?.midCap,
    smallCap: portfolioData.factorExposures?.marketCap?.smallCap,
    technology: portfolioData.factorExposures?.sectors?.technology,
    healthcare: portfolioData.factorExposures?.sectors?.healthcare,
    financials: portfolioData.factorExposures?.sectors?.financials,
    energy: portfolioData.factorExposures?.sectors?.energy,
    consumer: portfolioData.factorExposures?.sectors?.consumer,
    northAmerica: portfolioData.factorExposures?.geographic?.northAmerica,
    europe: portfolioData.factorExposures?.geographic?.europe,
    asiaPacific: portfolioData.factorExposures?.geographic?.asiaPacific,
    emergingMarkets: portfolioData.factorExposures?.geographic?.emergingMarkets,
  } : {};

  return (
    <Card className="dark:bg-gray-800">
      <Title className="mb-2 dark:text-white">Portfolio Analytics</Title>
      <Text className="text-xs text-gray-500 dark:text-gray-400 mb-4">
        Updated: {portfolioData.lastUpdated || 'N/A'}
      </Text>

      {/* Risk Metrics */}
      {analytics.riskMetrics && (
        <div className="mb-6">
          <Title className="text-sm mb-3 dark:text-white">Risk Metrics</Title>
          <div className="space-y-2">
            <div className="flex justify-between items-center p-2 bg-gray-50 dark:bg-gray-700 rounded">
              <Text className="text-xs dark:text-white">Volatility (Ann.)</Text>
              <Text className="text-xs font-semibold dark:text-white">{analytics.volatility || '0.00'}%</Text>
            </div>
            <div className="flex justify-between items-center p-2 bg-gray-50 dark:bg-gray-700 rounded">
              <Text className="text-xs dark:text-white">Sharpe Ratio</Text>
              <Text className="text-xs font-semibold dark:text-white">{analytics.sharpeRatio || '0.00'}</Text>
            </div>
            <div className="flex justify-between items-center p-2 bg-gray-50 dark:bg-gray-700 rounded">
              <Text className="text-xs dark:text-white">Sortino Ratio</Text>
              <Text className="text-xs font-semibold dark:text-white">{analytics.sortinoRatio || '0.00'}</Text>
            </div>
            <div className="flex justify-between items-center p-2 bg-red-50 dark:bg-red-900/20 rounded border border-red-200 dark:border-red-800">
              <Text className="text-xs dark:text-white">VaR (1d, 95%)</Text>
              <Badge color="red" size="xs">${analytics.var95 || '0'}</Badge>
            </div>
            <div className="flex justify-between items-center p-2 bg-amber-50 dark:bg-amber-900/20 rounded border border-amber-200 dark:border-amber-800">
              <Text className="text-xs dark:text-white">Max Drawdown</Text>
              <Badge color="amber" size="xs">{analytics.maxDrawdown || '0.00'}%</Badge>
            </div>
          </div>
        </div>
      )}

      {/* Exposure Metrics */}
      {analytics.exposureMetrics && (
        <div className="mb-6 pt-6 border-t dark:border-gray-700">
          <Title className="text-sm mb-3 dark:text-white">Exposure Metrics</Title>
          <div className="space-y-2">
            <div className="flex justify-between items-center p-2 bg-gray-50 dark:bg-gray-700 rounded">
              <Text className="text-xs dark:text-white">Gross Exposure</Text>
              <Text className="text-xs font-semibold dark:text-white">{analytics.grossExposure || '0.0'}%</Text>
            </div>
            <div className="flex justify-between items-center p-2 bg-green-50 dark:bg-green-900/20 rounded border border-green-200 dark:border-green-800">
              <Text className="text-xs dark:text-white">Net Long Exposure</Text>
              <Badge color="emerald" size="xs">
                {analytics.netLongExposure || '0.0'}%
              </Badge>
            </div>
            <div className="flex justify-between items-center p-2 bg-red-50 dark:bg-red-900/20 rounded border border-red-200 dark:border-red-800">
              <Text className="text-xs dark:text-white">Net Short Exposure</Text>
              <Badge color="red" size="xs">
                {analytics.netShortExposure || '0.0'}%
              </Badge>
            </div>
            <div className="flex justify-between items-center p-2 bg-gray-50 dark:bg-gray-700 rounded">
              <Text className="text-xs dark:text-white">Net Exposure</Text>
              <Text className="text-xs font-semibold dark:text-white">{analytics.netExposure || '0.0'}%</Text>
            </div>
          </div>
        </div>
      )}

      {/* Concentration Metrics */}
      {analytics.concentrationMetrics && (
        <div className="mb-6 pt-6 border-t dark:border-gray-700">
          <Title className="text-sm mb-3 dark:text-white">Concentration Metrics</Title>
          <div className="space-y-2">
            <div className="flex justify-between items-center p-2 bg-gray-50 dark:bg-gray-700 rounded">
              <Text className="text-xs dark:text-white">Top 10 Holdings</Text>
              <Text className="text-xs font-semibold dark:text-white">{parseFloat(analytics.top10HoldingsPercent || 0).toFixed(2)}%</Text>
            </div>
            <div className="flex justify-between items-center p-2 bg-gray-50 dark:bg-gray-700 rounded">
              <Text className="text-xs dark:text-white">Largest Position</Text>
              <Text className="text-xs font-semibold dark:text-white">{parseFloat(analytics.largestPositionPercent || 0).toFixed(2)}%</Text>
            </div>
            <div className="flex justify-between items-center p-2 bg-gray-50 dark:bg-gray-700 rounded">
              <Text className="text-xs dark:text-white">HHI Index</Text>
              <Text className="text-xs font-semibold dark:text-white">{analytics.hhiIndex || '0.000'}</Text>
            </div>
          </div>
        </div>
      )}

      {/* Factor Exposures - Market Cap */}
      {(analytics.largeCap || analytics.midCap || analytics.smallCap) && (
        <div className="mb-6 pt-6 border-t dark:border-gray-700">
          <Title className="text-sm mb-3 dark:text-white">Market Cap Exposure</Title>
          <div className="space-y-2">
            <div className="flex justify-between items-center p-2 bg-gray-50 dark:bg-gray-700 rounded">
              <Text className="text-xs dark:text-white">Large Cap</Text>
              <Text className="text-xs font-semibold dark:text-white">{parseFloat(analytics.largeCap || 0).toFixed(1)}%</Text>
            </div>
            <div className="flex justify-between items-center p-2 bg-gray-50 dark:bg-gray-700 rounded">
              <Text className="text-xs dark:text-white">Mid Cap</Text>
              <Text className="text-xs font-semibold dark:text-white">{parseFloat(analytics.midCap || 0).toFixed(1)}%</Text>
            </div>
            <div className="flex justify-between items-center p-2 bg-gray-50 dark:bg-gray-700 rounded">
              <Text className="text-xs dark:text-white">Small Cap</Text>
              <Text className="text-xs font-semibold dark:text-white">{parseFloat(analytics.smallCap || 0).toFixed(1)}%</Text>
            </div>
          </div>
        </div>
      )}

      {/* Factor Exposures - Sectors */}
      {(analytics.technology || analytics.healthcare || analytics.financials || analytics.energy || analytics.consumer) && (
        <div className="mb-6 pt-6 border-t dark:border-gray-700">
          <Title className="text-sm mb-3 dark:text-white">Sector Exposure</Title>
          <div className="space-y-2">
            {analytics.technology && (
              <div className="flex justify-between items-center p-2 bg-gray-50 dark:bg-gray-700 rounded">
                <Text className="text-xs dark:text-white">Technology</Text>
                <Text className="text-xs font-semibold dark:text-white">{parseFloat(analytics.technology || 0).toFixed(1)}%</Text>
              </div>
            )}
            {analytics.healthcare && (
              <div className="flex justify-between items-center p-2 bg-gray-50 dark:bg-gray-700 rounded">
                <Text className="text-xs dark:text-white">Healthcare</Text>
                <Text className="text-xs font-semibold dark:text-white">{parseFloat(analytics.healthcare || 0).toFixed(1)}%</Text>
              </div>
            )}
            {analytics.financials && (
              <div className="flex justify-between items-center p-2 bg-gray-50 dark:bg-gray-700 rounded">
                <Text className="text-xs dark:text-white">Financials</Text>
                <Text className="text-xs font-semibold dark:text-white">{parseFloat(analytics.financials || 0).toFixed(1)}%</Text>
              </div>
            )}
            {analytics.energy && (
              <div className="flex justify-between items-center p-2 bg-gray-50 dark:bg-gray-700 rounded">
                <Text className="text-xs dark:text-white">Energy</Text>
                <Text className="text-xs font-semibold dark:text-white">{parseFloat(analytics.energy || 0).toFixed(1)}%</Text>
              </div>
            )}
            {analytics.consumer && (
              <div className="flex justify-between items-center p-2 bg-gray-50 dark:bg-gray-700 rounded">
                <Text className="text-xs dark:text-white">Consumer</Text>
                <Text className="text-xs font-semibold dark:text-white">{parseFloat(analytics.consumer || 0).toFixed(1)}%</Text>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Factor Exposures - Geographic */}
      {(analytics.northAmerica || analytics.europe || analytics.asiaPacific || analytics.emergingMarkets) && (
        <div className="mb-6 pt-6 border-t dark:border-gray-700">
          <Title className="text-sm mb-3 dark:text-white">Geographic Exposure</Title>
          <div className="space-y-2">
            <div className="flex justify-between items-center p-2 bg-gray-50 dark:bg-gray-700 rounded">
              <Text className="text-xs dark:text-white">North America</Text>
              <Text className="text-xs font-semibold dark:text-white">{parseFloat(analytics.northAmerica || 0).toFixed(1)}%</Text>
            </div>
            <div className="flex justify-between items-center p-2 bg-gray-50 dark:bg-gray-700 rounded">
              <Text className="text-xs dark:text-white">Europe</Text>
              <Text className="text-xs font-semibold dark:text-white">{parseFloat(analytics.europe || 0).toFixed(1)}%</Text>
            </div>
            <div className="flex justify-between items-center p-2 bg-gray-50 dark:bg-gray-700 rounded">
              <Text className="text-xs dark:text-white">Asia Pacific</Text>
              <Text className="text-xs font-semibold dark:text-white">{parseFloat(analytics.asiaPacific || 0).toFixed(1)}%</Text>
            </div>
            <div className="flex justify-between items-center p-2 bg-gray-50 dark:bg-gray-700 rounded">
              <Text className="text-xs dark:text-white">Emerging Markets</Text>
              <Text className="text-xs font-semibold dark:text-white">{parseFloat(analytics.emergingMarkets || 0).toFixed(1)}%</Text>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
};

export default PortfolioAnalytics;

