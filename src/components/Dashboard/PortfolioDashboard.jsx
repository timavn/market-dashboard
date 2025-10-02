import React, { useState, useEffect } from 'react';
import { useMarketData, useVIXData } from '../../hooks/useMarketData';

const PortfolioDashboard = () => {
  const [activeTab, setActiveTab] = useState('M');
  const [portfolioData, setPortfolioData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Market data hooks
  const { data: marketData, loading: marketLoading } = useMarketData(['SPY', 'QQQ', 'AAPL', 'TSLA', 'NVDA']);
  const { vixData, loading: vixLoading } = useVIXData();

  // Fetch portfolio data
  useEffect(() => {
    const fetchPortfolioData = async () => {
      try {
        setLoading(true);
        const response = await fetch('http://localhost:3001/api/portfolio');
        if (!response.ok) throw new Error('Failed to fetch portfolio data');
        const data = await response.json();
        setPortfolioData(data);
        setError(null);
      } catch (err) {
        console.error('Error fetching portfolio data:', err);
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };

    fetchPortfolioData();
    
    // Refresh data every 30 seconds
    const interval = setInterval(fetchPortfolioData, 30000);
    return () => clearInterval(interval);
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
    <div className="min-h-screen p-4 font-mono" style={{backgroundColor: '#F5F5DC', color: '#000080'}}>
      <div className="grid grid-cols-12 gap-3 h-screen">
        
        {/* Left Sidebar */}
        <div className="col-span-2 space-y-3">
          {/* Navigation Tabs */}
          <div className="border shadow-md" style={{backgroundColor: '#F5F5DC', borderColor: '#D3D3D3'}}>
            <div className="flex">
              <button 
                className="px-4 py-2 text-sm font-bold border-r"
                style={{
                  borderRightColor: '#D3D3D3',
                  backgroundColor: activeTab === 'M' ? '#4682B4' : 'transparent',
                  color: activeTab === 'M' ? '#F5F5DC' : '#000080'
                }}
                onClick={() => setActiveTab('M')}
              >
                M
              </button>
              <button 
                className="px-4 py-2 text-sm font-bold"
                style={{
                  backgroundColor: activeTab === 'Q' ? '#4682B4' : 'transparent',
                  color: activeTab === 'Q' ? '#F5F5DC' : '#000080'
                }}
                onClick={() => setActiveTab('Q')}
              >
                Q
              </button>
            </div>
          </div>

          {/* US QUAD */}
          <div className="border shadow-md p-3" style={{backgroundColor: '#F5F5DC', borderColor: '#D3D3D3'}}>
            <h3 className="text-sm font-bold mb-2" style={{color: '#4682B4'}}>US QUAD</h3>
            <p className="text-xs" style={{color: '#000080'}}>Entire QUAD</p>
          </div>

          {/* QSG B/C and Constituent charts */}
          <div className="border shadow-md p-3" style={{backgroundColor: '#F5F5DC', borderColor: '#D3D3D3'}}>
            <h3 className="text-sm font-bold mb-2" style={{color: '#4682B4'}}>QSG B/C and Constituent charts</h3>
          </div>

          {/* Current position */}
          <div className="border shadow-md p-3" style={{backgroundColor: '#F5F5DC', borderColor: '#D3D3D3'}}>
            <h3 className="text-sm font-bold mb-2" style={{color: '#4682B4'}}>Current position</h3>
            <p className="text-xs mb-2" style={{color: '#000080'}}>Auto trade supporting</p>
            
            <h4 className="text-xs font-bold mb-1" style={{color: '#4682B4'}}>Last closed position report</h4>
            <div className="text-xs space-y-1" style={{color: '#000080'}}>
              <p>Latest sentiment report</p>
              <p>Most trending data report</p>
              <p>Current sentiment report</p>
              <p>Latest trending report INVBYQ</p>
            </div>
          </div>
        </div>

        {/* Center Panel - Global Quad Matrix */}
        <div className="col-span-7 space-y-3">
          {/* Header */}
          <div className="border shadow-md p-4" style={{backgroundColor: '#F5F5DC', borderColor: '#D3D3D3'}}>
            <h2 className="text-lg font-bold mb-1" style={{color: '#4682B4'}}>Global Quad Matrix</h2>
            <p className="text-sm" style={{color: '#000080'}}>This will be broken down in initial</p>
          </div>

          {/* Options charts and data header */}
          <div className="border p-2" style={{backgroundColor: '#E6E6E6', borderColor: '#D3D3D3', color: '#000080'}}>
            <h3 className="text-sm font-bold">Options charts and data</h3>
          </div>

          {/* Quad Matrix Grid */}
          <div className="grid grid-cols-2 gap-3 flex-1">
            {/* Quad 1 */}
            <div className="border shadow-md p-4" style={{backgroundColor: '#F5F5DC', borderColor: '#D3D3D3'}}>
              <h4 className="text-sm font-bold mb-2" style={{color: '#4682B4'}}>Quad 1 Asset Allocations</h4>
              <p className="text-xs" style={{color: '#000080'}}>This has largest bond fund equal bond fund to the larger trend in initial yield base, while most trend fund equal bond to equal bond fund trend in the same asset</p>
            </div>

            {/* Quad 2 */}
            <div className="border shadow-md p-4" style={{backgroundColor: '#F5F5DC', borderColor: '#D3D3D3'}}>
              <h4 className="text-sm font-bold mb-2" style={{color: '#4682B4'}}>Quad 2 Asset Allocations</h4>
              <p className="text-xs" style={{color: '#000080'}}>Current Quad 2</p>
            </div>

            {/* Quad 3 */}
            <div className="border shadow-md p-4" style={{backgroundColor: '#F5F5DC', borderColor: '#D3D3D3'}}>
              <h4 className="text-sm font-bold mb-2" style={{color: '#4682B4'}}>Quad 3 Asset Allocations</h4>
              <p className="text-xs" style={{color: '#000080'}}>Asset Quad 3 trend quad 1 housing continue equal 1 equal fund three timed fixed base trend fund to equal fund three asset fund</p>
            </div>

            {/* Quad 4 */}
            <div className="border shadow-md p-4" style={{backgroundColor: '#F5F5DC', borderColor: '#D3D3D3'}}>
              <h4 className="text-sm font-bold mb-2" style={{color: '#4682B4'}}>Quad 4 Asset Allocations</h4>
              <p className="text-xs" style={{color: '#000080'}}>This has largest bond in equal bond fund to larger trend in with this same sentiment</p>
            </div>
          </div>

          {/* Options Data Table */}
          <div className="border shadow-md" style={{backgroundColor: '#F5F5DC', borderColor: '#D3D3D3'}}>
            <div className="border-b p-2" style={{backgroundColor: '#E6E6E6', borderBottomColor: '#D3D3D3', color: '#000080'}}>
              <h3 className="text-sm font-bold">Options charts and data</h3>
              <p className="text-xs">Data will be broken from an initial</p>
            </div>
            
            <div className="p-4">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b" style={{borderBottomColor: '#D3D3D3'}}>
                    <th className="text-left py-2" style={{color: '#4682B4'}}>Symbol</th>
                    <th className="text-left py-2" style={{color: '#4682B4'}}>Strike</th>
                    <th className="text-left py-2" style={{color: '#4682B4'}}>Exp</th>
                    <th className="text-left py-2" style={{color: '#4682B4'}}>Type</th>
                    <th className="text-left py-2" style={{color: '#4682B4'}}>Bid</th>
                    <th className="text-left py-2" style={{color: '#4682B4'}}>Ask</th>
                    <th className="text-left py-2" style={{color: '#4682B4'}}>Vol</th>
                    <th className="text-left py-2" style={{color: '#4682B4'}}>OI</th>
                  </tr>
                </thead>
                <tbody style={{color: '#000080'}}>
                  {marketData && Object.keys(marketData).length > 0 ? (
                    Object.values(marketData).slice(0, 5).map((stock, index) => (
                      <tr key={index} className="border-b" style={{borderBottomColor: '#E6E6E6'}}>
                        <td className="py-1">{stock.symbol}</td>
                        <td className="py-1">{stock.price}</td>
                        <td className="py-1">12/20</td>
                        <td className="py-1">{index % 2 === 0 ? 'C' : 'P'}</td>
                        <td className="py-1">{stock.bid || 'N/A'}</td>
                        <td className="py-1">{stock.ask || 'N/A'}</td>
                        <td className="py-1">{stock.volume?.toLocaleString() || 'N/A'}</td>
                        <td className="py-1">{Math.floor(Math.random() * 20000) + 1000}</td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan="8" className="py-4 text-center text-gray-500">
                        Loading market data...
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
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
                    <span style={{color: '#000080'}}>0%</span>
                  </div>
                  <div className="flex justify-between">
                    <span style={{color: '#000080'}}>Net Long</span>
                    <span style={{color: '#000080'}}>0%</span>
                  </div>
                  <div className="flex justify-between">
                    <span style={{color: '#000080'}}>Net Short</span>
                    <span style={{color: '#000080'}}>0%</span>
                  </div>
                  <div className="flex justify-between">
                    <span style={{color: '#000080'}}>Net Exposure</span>
                    <span style={{color: '#000080'}}>0%</span>
                  </div>
                </div>
              </div>

              {/* Risk Metrics */}
              <div className="border-t pt-3" style={{borderTopColor: '#D3D3D3'}}>
                <h4 className="text-sm font-bold mb-2" style={{color: '#4682B4'}}>Risk Metrics</h4>
                <div className="space-y-1 text-xs">
                  <div className="flex justify-between">
                    <span style={{color: '#000080'}}>Sharpe Ratio</span>
                    <span style={{color: '#000080'}}>0.00</span>
                  </div>
                  <div className="flex justify-between">
                    <span style={{color: '#000080'}}>Sortino Ratio</span>
                    <span style={{color: '#000080'}}>0.00</span>
                  </div>
                  <div className="flex justify-between">
                    <span style={{color: '#000080'}}>VaR (1d, 95%)</span>
                    <span style={{color: '#000080'}}>$0</span>
                  </div>
                  <div className="flex justify-between">
                    <span style={{color: '#000080'}}>Max Drawdown</span>
                    <span style={{color: '#000080'}}>0.00%</span>
                  </div>
                  <div className="flex justify-between">
                    <span style={{color: '#000080'}}>Volatility (Ann.)</span>
                    <span style={{color: '#000080'}}>0.00%</span>
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
                    <span style={{color: '#000080'}}>0%</span>
                  </div>
                  <div className="flex justify-between">
                    <span style={{color: '#000080'}}>Europe</span>
                    <span style={{color: '#000080'}}>0%</span>
                  </div>
                  <div className="flex justify-between">
                    <span style={{color: '#000080'}}>Asia Pacific</span>
                    <span style={{color: '#000080'}}>0%</span>
                  </div>
                  <div className="flex justify-between">
                    <span style={{color: '#000080'}}>Emerging Markets</span>
                    <span style={{color: '#000080'}}>0%</span>
                  </div>
                </div>
              </div>

              {/* Concentration Risk */}
              <div className="border-t pt-3" style={{borderTopColor: '#D3D3D3'}}>
                <h4 className="text-sm font-bold mb-2" style={{color: '#4682B4'}}>Concentration Risk</h4>
                <div className="space-y-1 text-xs">
                  <div className="flex justify-between">
                    <span style={{color: '#000080'}}>Top 10 Holdings</span>
                    <span style={{color: '#000080'}}>0%</span>
                  </div>
                  <div className="flex justify-between">
                    <span style={{color: '#000080'}}>Largest Position</span>
                    <span style={{color: '#000080'}}>0%</span>
                  </div>
                  <div className="flex justify-between">
                    <span style={{color: '#000080'}}>HHI Index</span>
                    <span style={{color: '#000080'}}>0.000</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Bottom Panels */}
        <div className="col-span-6">
          <div className="border shadow-md h-32" style={{backgroundColor: '#F5F5DC', borderColor: '#D3D3D3'}}>
            <div className="border-b p-2" style={{backgroundColor: '#E6E6E6', borderBottomColor: '#D3D3D3', color: '#000080'}}>
              <h3 className="text-sm font-bold">Volatility Panel</h3>
            </div>
            <div className="p-3">
              {vixData ? (
                <div>
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-sm font-bold" style={{color: '#4682B4'}}>VIX</span>
                    <span className="text-lg font-bold" style={{color: '#000080'}}>{vixData.current}</span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span style={{color: '#000080'}}>Change: {vixData.change}</span>
                    <span style={{color: vixData.changePercent >= 0 ? '#22c55e' : '#ef4444'}}>
                      {vixData.changePercent}%
                    </span>
                  </div>
                </div>
              ) : (
                <div>
                  <p className="text-xs" style={{color: '#000080'}}>Loading VIX data...</p>
                  <p className="text-xs" style={{color: '#000080'}}>Will have a drop down menu where you can select what volatility index you want. Default is VIX.</p>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="col-span-6">
          <div className="border shadow-md h-32" style={{backgroundColor: '#F5F5DC', borderColor: '#D3D3D3'}}>
            <div className="border-b p-2" style={{backgroundColor: '#E6E6E6', borderBottomColor: '#D3D3D3', color: '#000080'}}>
              <h3 className="text-sm font-bold">Volume Panel</h3>
            </div>
            <div className="p-3">
              <p className="text-xs" style={{color: '#000080'}}>Volume Analysis</p>
              <p className="text-xs" style={{color: '#000080'}}>This will have a vertical list of one for volume calculations by expert insights. The overview used with SPY, QQQ, IWM commodities and major commodities equal major exposure USA by Brasil, UK, key expressed indicators by global export countries exports]</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default PortfolioDashboard;