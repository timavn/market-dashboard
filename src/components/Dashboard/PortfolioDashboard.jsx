import React, { useState, useEffect } from 'react';
import { Card, Metric, Text, Grid, Title, Button, Badge } from '@tremor/react';
import { MarketDataService } from '../../services/api/marketDataService';
import { useTheme } from '../../context/ThemeContext';
import CSVUpload from '../CSVUpload';
import USDMacroDashboard from './USDMacroDashboard';
import SecuritiesList from './SecuritiesList';
import ResizableBottomPanels from './ResizableBottomPanels';

const PortfolioDashboard = () => {
  const { theme, toggleTheme } = useTheme();
  const [portfolioData, setPortfolioData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Fetch portfolio data
  const fetchPortfolio = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await MarketDataService.getPortfolio();
      setPortfolioData(data);
    } catch (e) {
      setError(e.message || 'Failed to load portfolio');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let isMounted = true;
    fetchPortfolio();
    
    // Listen for portfolio refresh events (after CSV upload)
    const handlePortfolioRefresh = () => {
      if (isMounted) {
        console.log('Refreshing portfolio data after CSV upload...');
        fetchPortfolio();
      }
    };
    
    window.addEventListener('portfolioRefresh', handlePortfolioRefresh);
    
    return () => { 
      isMounted = false;
      window.removeEventListener('portfolioRefresh', handlePortfolioRefresh);
    };
  }, []);

  // Default zeroed data - will be replaced with Schwab portfolio data
  const defaultData = {
    summary: {
      totalValue: 0,
      totalDayChange: 0,
      totalDayChangePercent: '0.00',
      totalGainLoss: 0,
      totalGainLossPercent: '0.00',
      positionCount: 0
    },
    assetAllocation: {},
    topHoldings: [],
    lastUpdated: 'Schwab Integration Pending'
  };

  const displayData = portfolioData || defaultData;

  // Loading state
  if (loading) {
    return (
      <div className="min-h-screen p-4 flex items-center justify-center bg-gray-50 dark:bg-gray-900">
        <Card className="text-center max-w-md">
          <div className="animate-spin rounded-full h-16 w-16 border-4 border-blue-500 border-t-transparent mx-auto mb-4"></div>
          <Text className="dark:text-gray-300">Loading market data...</Text>
        </Card>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="min-h-screen p-4 flex items-center justify-center bg-gray-50 dark:bg-gray-900">
        <Card className="text-center max-w-md">
          <Title className="text-red-600 dark:text-red-400 mb-4">Error loading data</Title>
          <Text className="mb-4 dark:text-gray-300">{error}</Text>
          <Button onClick={() => window.location.reload()} color="red">
            Retry
          </Button>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen p-4 bg-gray-50 dark:bg-gray-900" style={{ paddingBottom: '220px' }}>
      {/* Theme Toggle Button - Top Right */}
      <div className="fixed top-4 right-4 z-50">
        <Button
          onClick={toggleTheme}
          variant="secondary"
          size="sm"
          className="shadow-lg"
        >
          {theme === 'dark' ? '☀️' : '🌙'}
        </Button>
      </div>

      <Grid numItems={12} className="gap-4">
        
        {/* Left Sidebar - Securities List */}
        <div className="col-span-12 md:col-span-2">
          <SecuritiesList />
        </div>

        {/* Center Panel - USD Macro Dashboard */}
        <div className="col-span-12 md:col-span-8 space-y-4">
          <USDMacroDashboard />
        </div>

        {/* Right Sidebar - Portfolio Metrics */}
        <div className="col-span-12 md:col-span-2 space-y-4">
          <Card className="dark:bg-gray-800">
            <Title className="mb-2 dark:text-white">Portfolio Metrics</Title>
            <Text className="text-xs text-gray-500 dark:text-gray-400 mb-4">
              Updated: {displayData.lastUpdated}
            </Text>
            
            {/* CSV Upload Section */}
            <div className="mb-6 pb-6 border-b">
              <CSVUpload 
                onUploadSuccess={(result) => {
                  console.log('CSV uploaded successfully:', result);
                }}
                onUploadError={(error) => {
                  console.error('CSV upload failed:', error);
                }}
              />
            </div>
            
            {/* Total Portfolio */}
            <div className="mb-6">
              <Title className="text-sm mb-3 dark:text-white">Total Portfolio</Title>
              <div className="space-y-3">
                <Metric className="dark:text-white">
                  ${displayData.summary.totalValue.toLocaleString()}
                </Metric>
                <div className="flex items-center justify-between p-3 bg-green-50 dark:bg-green-900/20 rounded-lg border border-green-200 dark:border-green-800">
                  <Text className="text-sm dark:text-white">P&L MTD</Text>
                  <Badge color="emerald">
                    +${displayData.summary.totalDayChange.toLocaleString()} ({displayData.summary.totalDayChangePercent}%)
                  </Badge>
                </div>
                <div className="flex items-center justify-between p-3 bg-green-50 dark:bg-green-900/20 rounded-lg border border-green-200 dark:border-green-800">
                  <Text className="text-sm dark:text-white">P&L YTD</Text>
                  <Badge color="emerald">
                    +${displayData.summary.totalGainLoss.toLocaleString()} ({displayData.summary.totalGainLossPercent}%)
                  </Badge>
                </div>
                <div className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-700 rounded-lg">
                  <Text className="text-sm dark:text-white">Positions</Text>
                  <Text className="font-semibold dark:text-white">{displayData.summary.positionCount}</Text>
                </div>
              </div>
            </div>

            {/* Net Exposure */}
            {displayData.exposureMetrics && (
              <div className="mb-6 pt-6 border-t dark:border-gray-700">
                <Title className="text-sm mb-3 dark:text-white">Net Exposure</Title>
                <div className="space-y-2">
                  <div className="flex justify-between items-center p-2 bg-gray-50 dark:bg-gray-700 rounded">
                    <Text className="text-xs dark:text-white">Gross Exposure</Text>
                    <Text className="text-xs font-semibold dark:text-white">{displayData.exposureMetrics.grossExposure || '0'}%</Text>
                  </div>
                  <div className="flex justify-between items-center p-2 bg-green-50 dark:bg-green-900/20 rounded border border-green-200 dark:border-green-800">
                    <Text className="text-xs dark:text-white">Net Long</Text>
                    <Badge color="emerald" size="xs">
                      {displayData.exposureMetrics.netLongExposure || '0'}%
                    </Badge>
                  </div>
                  <div className="flex justify-between items-center p-2 bg-red-50 dark:bg-red-900/20 rounded border border-red-200 dark:border-red-800">
                    <Text className="text-xs dark:text-white">Net Short</Text>
                    <Badge color="red" size="xs">
                      {displayData.exposureMetrics.netShortExposure || '0'}%
                    </Badge>
                  </div>
                  <div className="flex justify-between items-center p-2 bg-gray-50 dark:bg-gray-700 rounded">
                    <Text className="text-xs dark:text-white">Net Exposure</Text>
                    <Text className="text-xs font-semibold dark:text-white">{displayData.exposureMetrics.netExposure || '0'}%</Text>
                  </div>
                </div>
              </div>
            )}

            {/* Risk Metrics */}
            {displayData.riskMetrics && (
              <div className="mb-6 pt-6 border-t dark:border-gray-700">
                <Title className="text-sm mb-3 dark:text-white">Risk Metrics</Title>
                <div className="space-y-2">
                  <div className="flex justify-between items-center p-2 bg-gray-50 dark:bg-gray-700 rounded">
                    <Text className="text-xs dark:text-white">Sharpe Ratio</Text>
                    <Text className="text-xs font-semibold dark:text-white">{displayData.riskMetrics.sharpeRatio || '0.00'}</Text>
                  </div>
                  <div className="flex justify-between items-center p-2 bg-gray-50 dark:bg-gray-700 rounded">
                    <Text className="text-xs dark:text-white">Sortino Ratio</Text>
                    <Text className="text-xs font-semibold dark:text-white">{displayData.riskMetrics.sortinoRatio || '0.00'}</Text>
                  </div>
                  <div className="flex justify-between items-center p-2 bg-red-50 dark:bg-red-900/20 rounded border border-red-200 dark:border-red-800">
                    <Text className="text-xs dark:text-white">VaR (1d, 95%)</Text>
                    <Badge color="red" size="xs">${displayData.riskMetrics.var95 || '0'}</Badge>
                  </div>
                  <div className="flex justify-between items-center p-2 bg-amber-50 dark:bg-amber-900/20 rounded border border-amber-200 dark:border-amber-800">
                    <Text className="text-xs dark:text-white">Max Drawdown</Text>
                    <Badge color="amber" size="xs">{displayData.riskMetrics.maxDrawdown || '0.00'}%</Badge>
                  </div>
                  <div className="flex justify-between items-center p-2 bg-gray-50 dark:bg-gray-700 rounded">
                    <Text className="text-xs dark:text-white">Volatility (Ann.)</Text>
                    <Text className="text-xs font-semibold dark:text-white">{displayData.riskMetrics.volatility || '0.00'}%</Text>
                  </div>
                </div>
              </div>
            )}

            {/* Asset Class Allocation */}
            {Object.keys(displayData.assetAllocation).length > 0 && (
              <div className="mb-6 pt-6 border-t dark:border-gray-700">
                <Title className="text-sm mb-3 dark:text-white">Asset Class Allocation</Title>
                <div className="space-y-2">
                  {Object.entries(displayData.assetAllocation).map(([type, percentage]) => (
                    <div key={type} className="space-y-1">
                      <div className="flex justify-between items-center">
                        <Text className="text-xs dark:text-white">{type}</Text>
                        <Text className="text-xs font-semibold dark:text-white">{percentage}%</Text>
                      </div>
                      <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
                        <div 
                          className="bg-blue-600 h-2 rounded-full" 
                          style={{ width: `${Math.min(parseFloat(percentage), 100)}%` }}
                        ></div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Top Holdings */}
            {displayData.topHoldings && displayData.topHoldings.length > 0 && (
              <div className="mb-6 pt-6 border-t dark:border-gray-700">
                <Title className="text-sm mb-3 dark:text-white">Top Holdings</Title>
                <div className="space-y-2">
                  {displayData.topHoldings.map((holding) => (
                    <div key={holding.symbol} className="flex justify-between items-center p-2 bg-gray-50 dark:bg-gray-700 rounded">
                      <Text className="text-xs font-semibold dark:text-white">{holding.symbol}</Text>
                      <Text className="text-xs dark:text-white">
                        {portfolioData ? `$${holding.marketValue?.toLocaleString() || '0'}` : `${holding.accountPercent}%`}
                      </Text>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Geographic Exposure */}
            {displayData.factorExposures?.geographic && (
              <div className="mb-6 pt-6 border-t dark:border-gray-700">
                <Title className="text-sm mb-3 dark:text-white">Geographic Exposure</Title>
                <div className="space-y-2">
                  <div className="flex justify-between items-center p-2 bg-gray-50 dark:bg-gray-700 rounded">
                    <Text className="text-xs dark:text-white">North America</Text>
                    <Text className="text-xs font-semibold dark:text-white">{displayData.factorExposures.geographic.northAmerica || '0'}%</Text>
                  </div>
                  <div className="flex justify-between items-center p-2 bg-gray-50 dark:bg-gray-700 rounded">
                    <Text className="text-xs dark:text-white">Europe</Text>
                    <Text className="text-xs font-semibold dark:text-white">{displayData.factorExposures.geographic.europe || '0'}%</Text>
                  </div>
                  <div className="flex justify-between items-center p-2 bg-gray-50 dark:bg-gray-700 rounded">
                    <Text className="text-xs dark:text-white">Asia Pacific</Text>
                    <Text className="text-xs font-semibold dark:text-white">{displayData.factorExposures.geographic.asiaPacific || '0'}%</Text>
                  </div>
                  <div className="flex justify-between items-center p-2 bg-gray-50 dark:bg-gray-700 rounded">
                    <Text className="text-xs dark:text-white">Emerging Markets</Text>
                    <Text className="text-xs font-semibold dark:text-white">{displayData.factorExposures.geographic.emergingMarkets || '0'}%</Text>
                  </div>
                </div>
              </div>
            )}

            {/* Concentration Risk */}
            {displayData.concentrationMetrics && (
              <div className="pt-6 border-t dark:border-gray-700">
                <Title className="text-sm mb-3 dark:text-white">Concentration Risk</Title>
                <div className="space-y-2">
                  <div className="flex justify-between items-center p-2 bg-gray-50 dark:bg-gray-700 rounded">
                    <Text className="text-xs dark:text-white">Top 10 Holdings</Text>
                    <Text className="text-xs font-semibold dark:text-white">{displayData.concentrationMetrics.top10HoldingsPercent || '0'}%</Text>
                  </div>
                  <div className="flex justify-between items-center p-2 bg-gray-50 dark:bg-gray-700 rounded">
                    <Text className="text-xs dark:text-white">Largest Position</Text>
                    <Text className="text-xs font-semibold dark:text-white">{displayData.concentrationMetrics.largestPositionPercent || '0'}%</Text>
                  </div>
                  <div className="flex justify-between items-center p-2 bg-gray-50 dark:bg-gray-700 rounded">
                    <Text className="text-xs dark:text-white">HHI Index</Text>
                    <Text className="text-xs font-semibold dark:text-white">{displayData.concentrationMetrics.hhiIndex || '0.000'}</Text>
                  </div>
                </div>
              </div>
            )}
          </Card>
        </div>
      </Grid>

      {/* Resizable Bottom Panels */}
      <ResizableBottomPanels />
    </div>
  );
};

export default PortfolioDashboard;
