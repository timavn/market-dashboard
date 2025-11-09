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
  const [showPortfolioMetrics, setShowPortfolioMetrics] = useState(false);
  const [volatilityExpanded, setVolatilityExpanded] = useState(false);
  const [securitiesExpanded, setSecuritiesExpanded] = useState(false);
  const [securitiesFullWidth, setSecuritiesFullWidth] = useState(false);

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

  // Calculate bottom padding based on panel heights
  const COLLAPSED_HEIGHT = 40; // Matches ResizableBottomPanels collapsed height
  const EXPANDED_HEIGHT = 500; // 25% taller than 400px
  const volatilityHeight = volatilityExpanded ? EXPANDED_HEIGHT : COLLAPSED_HEIGHT;
  const securitiesHeight = securitiesExpanded ? EXPANDED_HEIGHT : COLLAPSED_HEIGHT;
  const maxPanelHeight = Math.max(volatilityHeight, securitiesHeight);

  // Portfolio Metrics Content Component
  const PortfolioMetricsContent = () => (
    <Card className="dark:bg-gray-800" style={{ height: '100%', overflowY: 'auto', border: 'none', boxShadow: 'none', backgroundColor: 'transparent' }}>
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
          
          {/* Position Sizing Legend */}
          <div className="text-xs text-gray-500 dark:text-gray-400 space-y-1 pt-2 border-t dark:border-gray-700">
            <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
              <div>
                <div className="text-gray-600 dark:text-gray-500 font-medium mb-0.5">Long:</div>
                <div>FX : 4-12%</div>
                <div>Fixed Income : 4-10%</div>
                <div>Equities : 2-6%</div>
                <div>Commodities : 2-4%</div>
                <div>Crypto : 2-4%</div>
              </div>
              <div>
                <div className="text-gray-600 dark:text-gray-500 font-medium mb-0.5">Short:</div>
                <div>FX : 2-6%</div>
                <div>Fixed Income : 2-5%</div>
                <div>Equities : 1-3%</div>
                <div>Commodities : 1-2%</div>
                <div>Crypto : 1-2%</div>
              </div>
            </div>
            <div className="pt-1 border-t dark:border-gray-700 mt-1">
              <div className="text-gray-600 dark:text-gray-500 font-medium mb-0.5">Basis Points:</div>
              <div className="grid grid-cols-4 gap-x-2">
                <div>25 bps: ${Math.floor(displayData.summary.totalValue * 0.0025).toLocaleString()}</div>
                <div>50 bps: ${Math.floor(displayData.summary.totalValue * 0.005).toLocaleString()}</div>
                <div>100 bps: ${Math.floor(displayData.summary.totalValue * 0.01).toLocaleString()}</div>
                <div>500 bps: ${Math.floor(displayData.summary.totalValue * 0.05).toLocaleString()}</div>
              </div>
            </div>
          </div>
          
          <div className="flex items-center justify-between p-3 bg-green-50 dark:bg-green-900/20 rounded-lg border border-green-200 dark:border-green-800">
            <Text className="text-sm dark:text-white">P&L MTD</Text>
            <Badge color={parseFloat(displayData.summary.totalDayChange) >= 0 ? 'emerald' : 'rose'}>
              {displayData.summary.totalDayChange >= 0 ? '+' : ''}${displayData.summary.totalDayChange.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ({parseFloat(displayData.summary.totalDayChangePercent).toFixed(2)}%)
            </Badge>
          </div>
          <div className="flex items-center justify-between p-3 bg-green-50 dark:bg-green-900/20 rounded-lg border border-green-200 dark:border-green-800">
            <Text className="text-xs dark:text-white">P&L YTD</Text>
            <Badge color={parseFloat(displayData.summary.totalGainLoss) >= 0 ? 'emerald' : 'rose'}>
              {displayData.summary.totalGainLoss >= 0 ? '+' : ''}${displayData.summary.totalGainLoss.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ({parseFloat(displayData.summary.totalGainLossPercent).toFixed(2)}%)
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
              <Text className="text-xs font-semibold dark:text-white">{parseFloat(displayData.exposureMetrics.grossExposure || 0).toFixed(2)}%</Text>
            </div>
            <div className="flex justify-between items-center p-2 bg-green-50 dark:bg-green-900/20 rounded border border-green-200 dark:border-green-800">
              <Text className="text-xs dark:text-white">Net Long</Text>
              <Badge color="emerald" size="xs">
                {parseFloat(displayData.exposureMetrics.netLongExposure || 0).toFixed(2)}%
              </Badge>
            </div>
            <div className="flex justify-between items-center p-2 bg-red-50 dark:bg-red-900/20 rounded border border-red-200 dark:border-red-800">
              <Text className="text-xs dark:text-white">Net Short</Text>
              <Badge color="red" size="xs">
                {parseFloat(displayData.exposureMetrics.netShortExposure || 0).toFixed(2)}%
              </Badge>
            </div>
            <div className="flex justify-between items-center p-2 bg-gray-50 dark:bg-gray-700 rounded">
              <Text className="text-xs dark:text-white">Net Exposure</Text>
              <Text className="text-xs font-semibold dark:text-white">{parseFloat(displayData.exposureMetrics.netExposure || 0).toFixed(2)}%</Text>
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
                  <Text className="text-xs font-semibold dark:text-white">{parseFloat(percentage || 0).toFixed(2)}%</Text>
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
              <Text className="text-xs font-semibold dark:text-white">{parseFloat(displayData.factorExposures.geographic.northAmerica || 0).toFixed(2)}%</Text>
            </div>
            <div className="flex justify-between items-center p-2 bg-gray-50 dark:bg-gray-700 rounded">
              <Text className="text-xs dark:text-white">Europe</Text>
              <Text className="text-xs font-semibold dark:text-white">{parseFloat(displayData.factorExposures.geographic.europe || 0).toFixed(2)}%</Text>
            </div>
            <div className="flex justify-between items-center p-2 bg-gray-50 dark:bg-gray-700 rounded">
              <Text className="text-xs dark:text-white">Asia Pacific</Text>
              <Text className="text-xs font-semibold dark:text-white">{parseFloat(displayData.factorExposures.geographic.asiaPacific || 0).toFixed(2)}%</Text>
            </div>
            <div className="flex justify-between items-center p-2 bg-gray-50 dark:bg-gray-700 rounded">
              <Text className="text-xs dark:text-white">Emerging Markets</Text>
              <Text className="text-xs font-semibold dark:text-white">{parseFloat(displayData.factorExposures.geographic.emergingMarkets || 0).toFixed(2)}%</Text>
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
              <Text className="text-xs font-semibold dark:text-white">{parseFloat(displayData.concentrationMetrics.top10HoldingsPercent || 0).toFixed(2)}%</Text>
            </div>
            <div className="flex justify-between items-center p-2 bg-gray-50 dark:bg-gray-700 rounded">
              <Text className="text-xs dark:text-white">Largest Position</Text>
              <Text className="text-xs font-semibold dark:text-white">{parseFloat(displayData.concentrationMetrics.largestPositionPercent || 0).toFixed(2)}%</Text>
            </div>
            <div className="flex justify-between items-center p-2 bg-gray-50 dark:bg-gray-700 rounded">
              <Text className="text-xs dark:text-white">HHI Index</Text>
              <Text className="text-xs font-semibold dark:text-white">{displayData.concentrationMetrics.hhiIndex || '0.000'}</Text>
            </div>
          </div>
        </div>
      )}
    </Card>
  );

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
    <div 
      className="min-h-screen p-4 bg-gray-50 dark:bg-gray-900" 
      style={{ 
        paddingBottom: `${maxPanelHeight + 20}px`, // Panel height + extra padding
        paddingRight: showPortfolioMetrics ? '0px' : '40px', // No padding when open to extend content closer, matches collapsed width
        transition: 'padding-right 0.3s ease-in-out, padding-bottom 0.3s ease-in-out',
      }}
    >
      <Grid numItems={12} className="gap-4">
        
        {/* Left Sidebar - Securities List */}
        <div 
          className={showPortfolioMetrics ? 'col-span-12 md:col-span-2' : 'col-span-12 md:col-span-3'}
          style={{
            zIndex: showPortfolioMetrics ? 100 : 'auto', // Lower z-index when Portfolio Metrics overlays
          }}
        >
          <SecuritiesList />
        </div>

        {/* Center Panel - USD Macro Dashboard */}
        <div className={showPortfolioMetrics ? 'col-span-12 md:col-span-7' : 'col-span-12 md:col-span-9'}>
          <USDMacroDashboard />
        </div>

        {/* Right Sidebar - Portfolio Metrics (removed from grid, now in vertical bar) */}
      </Grid>

      {/* Vertical Portfolio Bar - Always Visible */}
      <div
        style={{
          position: 'fixed',
          top: 0,
          right: 0, // Always anchored to right
          width: showPortfolioMetrics 
            ? 'calc((100vw - 16px) * (2/12) + 16px + 128px)' // Securities width (col-span-2) + gap + Portfolio Metrics content (reduced by another 20%)
            : '40px', // Matches collapsed height of bottom tabs
          height: '100vh',
          zIndex: showPortfolioMetrics ? 1100 : 1000, // Higher z-index when open to overlay Securities
          backgroundColor: '#f9fafb', // Solid opaque background
          borderLeft: showPortfolioMetrics ? '1px solid #e5e7eb' : 'none', // Left border when overlaying Securities
          borderRight: '1px solid #e5e7eb', // Always right border
          boxShadow: showPortfolioMetrics 
            ? '-2px 0 8px rgba(0, 0, 0, 0.1), 2px 0 8px rgba(0, 0, 0, 0.1)' 
            : '-2px 0 8px rgba(0, 0, 0, 0.1)',
          transition: 'width 0.3s ease-in-out',
          display: 'flex',
          flexDirection: 'column',
        }}
        className="dark:bg-gray-900 dark:border-gray-700"
      >
        {/* Top Section - Night Mode Toggle */}
        <div
          style={{
            padding: '12px',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            borderBottom: '1px solid #e5e7eb',
            minHeight: '80px',
          }}
          className="dark:border-gray-700"
        >
          {/* Night Mode Toggle */}
          <Button
            onClick={toggleTheme}
            variant="secondary"
            size="sm"
            className="shadow-sm w-full"
            style={{ minWidth: '32px', height: '32px', padding: '0' }}
          >
            {theme === 'dark' ? '☀️' : '🌙'}
          </Button>
        </div>

        {/* Collapsed "Portfolio" Text - Vertical and Centered */}
        {!showPortfolioMetrics && (
          <div
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              padding: '0 16px',
            }}
            onClick={() => setShowPortfolioMetrics(true)}
          >
            <Title
              style={{
                writingMode: 'vertical-rl',
                textOrientation: 'mixed',
                fontSize: '18px',
                fontWeight: 700,
                color: '#374151',
                margin: 0,
                userSelect: 'none',
              }}
              className="dark:text-gray-300"
            >
              Portfolio
            </Title>
          </div>
        )}

        {/* Expanded Content Area */}
        {showPortfolioMetrics && (
          <>
            {/* Header with Centered Title (Clickable to Collapse) */}
            <div
              style={{
                padding: '12px 16px',
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'center',
                borderBottom: '1px solid #e5e7eb',
                cursor: 'pointer',
              }}
              className="dark:border-gray-700"
              onClick={() => setShowPortfolioMetrics(false)}
            >
              <Title 
                className="dark:text-white" 
                style={{ 
                  fontSize: '18px', 
                  fontWeight: 700,
                  color: '#374151',
                  margin: 0,
                  userSelect: 'none',
                }}
              >
                Portfolio Metrics
              </Title>
            </div>

            {/* Scrollable Content */}
            <div
              style={{
                flex: 1,
                overflowY: 'auto',
                padding: '16px',
              }}
            >
              <PortfolioMetricsContent />
            </div>
          </>
        )}
      </div>

      {/* Resizable Bottom Panels */}
      <ResizableBottomPanels 
        volatilityExpanded={volatilityExpanded}
        securitiesExpanded={securitiesExpanded}
        onVolatilityToggle={setVolatilityExpanded}
        onSecuritiesToggle={setSecuritiesExpanded}
        securitiesFullWidth={securitiesFullWidth}
        onSecuritiesFullWidthToggle={(fullWidth) => {
          setSecuritiesFullWidth(fullWidth);
          if (fullWidth) {
            setSecuritiesExpanded(true);
          }
        }}
      />
    </div>
  );
};

export default PortfolioDashboard;
