import React, { useState, useEffect } from 'react';
import { useVIXData } from '../../hooks/useMarketData';
import { MarketDataService } from '../../services/api/marketDataService';
import CSVUpload from '../CSVUpload';
import USDMacroDashboard from './USDMacroDashboard';
import SecuritiesList from './SecuritiesList';
import VolatilityPanel from './VolatilityPanel';
import VolumePanel from './VolumePanel';
import './PortfolioDashboard.css';

const PortfolioDashboard = () => {
  const [activeTab, setActiveTab] = useState('M');
  const [portfolioData, setPortfolioData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Market data hooks
  const { vixData } = useVIXData();

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
      <div className="min-h-screen p-4 font-mono flex items-center justify-center" style={{backgroundColor: '#F5F5DC', color: '#000080'}}>
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
          <p>Loading market data...</p>
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="min-h-screen p-4 font-mono flex items-center justify-center" style={{backgroundColor: '#F5F5DC', color: '#000080'}}>
        <div className="text-center">
          <p className="text-red-600 mb-4">Error loading data: {error}</p>
          <button 
            onClick={() => window.location.reload()} 
            className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="portfolio-dashboard-container min-h-screen p-4 font-mono" style={{backgroundColor: '#F5F5DC', color: '#000080'}}>
      <div className="portfolio-content grid grid-cols-12 gap-3">
        
        {/* Left Sidebar - Securities List */}
        <div className="col-span-2">
          <SecuritiesList />
        </div>

        {/* Center Panel - USD Macro Dashboard */}
        <div className="col-span-7 space-y-3">
          <USDMacroDashboard />
          
          {/* Add some content to make the page scrollable */}
          <div className="space-y-3">
            <div className="border shadow-md p-4" style={{backgroundColor: '#F5F5DC', borderColor: '#D3D3D3', minHeight: '400px'}}>
              <h3 className="text-sm font-bold mb-2" style={{color: '#4682B4'}}>Additional Content</h3>
              <p className="text-xs" style={{color: '#000080'}}>This content is here to make the page scrollable so you can test the sticky bottom panels.</p>
            </div>
            <div className="border shadow-md p-4" style={{backgroundColor: '#F5F5DC', borderColor: '#D3D3D3', minHeight: '400px'}}>
              <h3 className="text-sm font-bold mb-2" style={{color: '#4682B4'}}>More Content</h3>
              <p className="text-xs" style={{color: '#000080'}}>Scroll down to see the Volatility and Volume panels stick to the bottom.</p>
            </div>
            <div className="border shadow-md p-4" style={{backgroundColor: '#F5F5DC', borderColor: '#D3D3D3', minHeight: '400px'}}>
              <h3 className="text-sm font-bold mb-2" style={{color: '#4682B4'}}>Even More Content</h3>
              <p className="text-xs" style={{color: '#000080'}}>The panels should remain visible at the bottom of the screen as you scroll.</p>
            </div>
          </div>
        </div>

        {/* Right Sidebar - Portfolio Metrics */}
        <div className="col-span-3 space-y-3">

          {/* Portfolio Metrics */}
          <div className="border shadow-md" style={{backgroundColor: '#F5F5DC', borderColor: '#D3D3D3'}}>
            <div className="border-b p-2" style={{backgroundColor: '#E6E6E6', borderBottomColor: '#D3D3D3', color: '#000080'}}>
              <h3 className="text-sm font-bold">PORTFOLIO METRICS</h3>
              <p className="text-xs">Updated: {displayData.lastUpdated}</p>
            </div>
            
            {/* CSV Upload Section */}
            <div className="p-3 border-b" style={{borderBottomColor: '#D3D3D3'}}>
              <CSVUpload 
                onUploadSuccess={(result) => {
                  console.log('CSV uploaded successfully:', result);
                }}
                onUploadError={(error) => {
                  console.error('CSV upload failed:', error);
                }}
              />
            </div>
            
            <div className="p-3 space-y-3">
              {/* Total Portfolio */}
              <div>
                <h4 className="text-sm font-bold mb-2" style={{color: '#4682B4'}}>Total Portfolio</h4>
                <div className="space-y-1 text-xs">
                  <div className="flex justify-between">
                    <span style={{color: '#000080'}}>Total Value</span>
                    <span className="font-bold" style={{color: '#4682B4'}}>
                      ${displayData.summary.totalValue.toLocaleString()}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span style={{color: '#000080'}}>P&L MTD</span>
                    <span className="text-green-600 font-bold">
                      +${displayData.summary.totalDayChange.toLocaleString()} ({displayData.summary.totalDayChangePercent}%)
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span style={{color: '#000080'}}>P&L YTD</span>
                    <span className="text-green-600 font-bold">
                      +${displayData.summary.totalGainLoss.toLocaleString()} ({displayData.summary.totalGainLossPercent}%)
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span style={{color: '#000080'}}>Positions</span>
                    <span style={{color: '#000080'}}>{displayData.summary.positionCount}</span>
                  </div>
                </div>
              </div>

              {/* Net Exposure */}
              <div className="border-t pt-3" style={{borderTopColor: '#D3D3D3'}}>
                <h4 className="text-sm font-bold mb-2" style={{color: '#4682B4'}}>Net Exposure</h4>
                <div className="space-y-1 text-xs">
                  <div className="flex justify-between">
                    <span style={{color: '#000080'}}>Gross Exposure</span>
                    <span style={{color: '#000080'}}>{displayData.exposureMetrics?.grossExposure || '0'}%</span>
                  </div>
                  <div className="flex justify-between">
                    <span style={{color: '#000080'}}>Net Long</span>
                    <span style={{color: '#000080'}}>{displayData.exposureMetrics?.netLongExposure || '0'}%</span>
                  </div>
                  <div className="flex justify-between">
                    <span style={{color: '#000080'}}>Net Short</span>
                    <span style={{color: '#000080'}}>{displayData.exposureMetrics?.netShortExposure || '0'}%</span>
                  </div>
                  <div className="flex justify-between">
                    <span style={{color: '#000080'}}>Net Exposure</span>
                    <span style={{color: '#000080'}}>{displayData.exposureMetrics?.netExposure || '0'}%</span>
                  </div>
                </div>
              </div>

              {/* Risk Metrics */}
              <div className="border-t pt-3" style={{borderTopColor: '#D3D3D3'}}>
                <h4 className="text-sm font-bold mb-2" style={{color: '#4682B4'}}>Risk Metrics</h4>
                <div className="space-y-1 text-xs">
                  <div className="flex justify-between">
                    <span style={{color: '#000080'}}>Sharpe Ratio</span>
                    <span style={{color: '#000080'}}>{displayData.riskMetrics?.sharpeRatio || '0.00'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span style={{color: '#000080'}}>Sortino Ratio</span>
                    <span style={{color: '#000080'}}>{displayData.riskMetrics?.sortinoRatio || '0.00'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span style={{color: '#000080'}}>VaR (1d, 95%)</span>
                    <span style={{color: '#000080'}}>${displayData.riskMetrics?.var95 || '0'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span style={{color: '#000080'}}>Max Drawdown</span>
                    <span style={{color: '#000080'}}>{displayData.riskMetrics?.maxDrawdown || '0.00'}%</span>
                  </div>
                  <div className="flex justify-between">
                    <span style={{color: '#000080'}}>Volatility (Ann.)</span>
                    <span style={{color: '#000080'}}>{displayData.riskMetrics?.volatility || '0.00'}%</span>
                  </div>
                </div>
              </div>

              {/* Asset Class Allocation */}
              <div className="border-t pt-3" style={{borderTopColor: '#D3D3D3'}}>
                <h4 className="text-sm font-bold mb-2" style={{color: '#4682B4'}}>Asset Class Allocation</h4>
                <div className="space-y-2">
                  {Object.entries(displayData.assetAllocation).length === 0 && (
                    <p className="text-xs" style={{color: '#000080'}}>No data</p>
                  )}
                  {Object.entries(displayData.assetAllocation).map(([type, percentage]) => (
                    <div key={type} className="flex justify-between items-center">
                      <span className="text-xs" style={{color: '#000080'}}>{type}</span>
                      <div className="flex items-center gap-2">
                        <div className="w-16 rounded h-2" style={{backgroundColor: '#E6E6E6'}}>
                          <div className="h-2 rounded" style={{backgroundColor: '#4682B4', width: `${Math.min(parseFloat(percentage), 100)}%`}}></div>
                        </div>
                        <span className="text-xs" style={{color: '#000080'}}>{percentage}%</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Top Holdings */}
              <div className="border-t pt-3" style={{borderTopColor: '#D3D3D3'}}>
                <h4 className="text-sm font-bold mb-2" style={{color: '#4682B4'}}>Top Holdings</h4>
                <div className="space-y-1 text-xs">
                  {displayData.topHoldings.length === 0 && (
                    <p className="text-xs" style={{color: '#000080'}}>No holdings</p>
                  )}
                  {displayData.topHoldings.map((holding) => (
                    <div key={holding.symbol} className="flex justify-between">
                      <span style={{color: '#000080'}}>{holding.symbol}</span>
                      <span style={{color: '#000080'}}>
                        {portfolioData ? `${holding.marketValue.toLocaleString()}` : `${holding.accountPercent}%`}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Geographic Exposure */}
              <div className="border-t pt-3" style={{borderTopColor: '#D3D3D3'}}>
                <h4 className="text-sm font-bold mb-2" style={{color: '#4682B4'}}>Geographic Exposure</h4>
                <div className="space-y-1 text-xs">
                  <div className="flex justify-between">
                    <span style={{color: '#000080'}}>North America</span>
                    <span style={{color: '#000080'}}>{displayData.factorExposures?.geographic?.northAmerica || '0'}%</span>
                  </div>
                  <div className="flex justify-between">
                    <span style={{color: '#000080'}}>Europe</span>
                    <span style={{color: '#000080'}}>{displayData.factorExposures?.geographic?.europe || '0'}%</span>
                  </div>
                  <div className="flex justify-between">
                    <span style={{color: '#000080'}}>Asia Pacific</span>
                    <span style={{color: '#000080'}}>{displayData.factorExposures?.geographic?.asiaPacific || '0'}%</span>
                  </div>
                  <div className="flex justify-between">
                    <span style={{color: '#000080'}}>Emerging Markets</span>
                    <span style={{color: '#000080'}}>{displayData.factorExposures?.geographic?.emergingMarkets || '0'}%</span>
                  </div>
                </div>
              </div>

              {/* Concentration Risk */}
              <div className="border-t pt-3" style={{borderTopColor: '#D3D3D3'}}>
                <h4 className="text-sm font-bold mb-2" style={{color: '#4682B4'}}>Concentration Risk</h4>
                <div className="space-y-1 text-xs">
                  <div className="flex justify-between">
                    <span style={{color: '#000080'}}>Top 10 Holdings</span>
                    <span style={{color: '#000080'}}>{displayData.concentrationMetrics?.top10HoldingsPercent || '0'}%</span>
                  </div>
                  <div className="flex justify-between">
                    <span style={{color: '#000080'}}>Largest Position</span>
                    <span style={{color: '#000080'}}>{displayData.concentrationMetrics?.largestPositionPercent || '0'}%</span>
                  </div>
                  <div className="flex justify-between">
                    <span style={{color: '#000080'}}>HHI Index</span>
                    <span style={{color: '#000080'}}>{displayData.concentrationMetrics?.hhiIndex || '0.000'}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

      </div>

      {/* Fixed Bottom Panels */}
      <div className="sticky-panels-container">
        <div className="sticky-panel">
          <VolatilityPanel />
        </div>
        <div className="sticky-panel">
          <VolumePanel />
        </div>
      </div>
    </div>
  );
};

export default PortfolioDashboard;