import React, { useState, useRef, useEffect } from 'react';
import { Card, Table, TableHead, TableRow, TableHeaderCell, TableBody, TableCell, Text, Title } from '@tremor/react';
import { SECURITIES_LIST } from '../../constants/securitiesList';
import { MarketDataService } from '../../services/api/marketDataService';
import './SecuritiesList.css';

const SecuritiesList = () => {
  const securities = SECURITIES_LIST;
  const [showLegend, setShowLegend] = useState(false);
  const [prices, setPrices] = useState({});
  const [loading, setLoading] = useState(true);
  const legendRef = useRef(null);
  const rowRefs = useRef({});

  // Asset class color mapping - using more vibrant, distinct colors
  const getAssetClassColor = (assetClass) => {
    const colors = {
      fixedIncome: 'blue',      // Blue for bonds/fixed income
      equity: 'emerald',         // Green for stocks
      currency: 'violet',        // Purple/violet for currencies
      commodity: 'orange',       // Orange for commodities
      crypto: 'yellow'           // Yellow for crypto
    };
    return colors[assetClass] || 'gray';
  };

  // Get background color for row highlighting
  const getAssetClassBgColor = (assetClass) => {
    const bgColors = {
      fixedIncome: 'bg-blue-50 dark:bg-blue-900/20',
      equity: 'bg-emerald-50 dark:bg-emerald-900/20',
      currency: 'bg-violet-50 dark:bg-violet-900/20',
      commodity: 'bg-orange-50 dark:bg-orange-900/20',
      crypto: 'bg-yellow-50 dark:bg-yellow-900/20'
    };
    return bgColors[assetClass] || 'bg-gray-50 dark:bg-gray-900/20';
  };

  const getAssetClassName = (assetClass) => {
    const names = {
      fixedIncome: 'Fixed Income',
      equity: 'Equity',
      currency: 'Currency',
      commodity: 'Commodity',
      crypto: 'Crypto'
    };
    return names[assetClass] || assetClass;
  };

  // Format price based on asset type
  const formatPrice = (ticker, price, assetClass) => {
    if (!price || price === 'N/A' || price === '--') {
      return '--';
    }
    
    const priceNum = parseFloat(price);
    if (isNaN(priceNum)) {
      return '--';
    }
    
    // Treasury yields show as percentage
    if (ticker.startsWith('UST')) {
      return `${priceNum.toFixed(2)}%`;
    }
    
    // For other assets, show as currency
    return `$${priceNum.toFixed(2)}`;
  };

  // Poll for prices every 8 seconds
  useEffect(() => {
    // Fetch prices function
    const fetchPricesData = async () => {
      try {
        const tickers = securities.map(s => s.ticker);
        console.log('[SecuritiesList] Fetching prices for', tickers.length, 'securities');
        
        const quotes = await MarketDataService.getQuotes(tickers);
        console.log('[SecuritiesList] Received quotes:', Object.keys(quotes).length, 'quotes');
        console.log('[SecuritiesList] Sample quote:', quotes[Object.keys(quotes)[0]]);
        
        const priceMap = {};
        let successCount = 0;
        let failCount = 0;
        
        tickers.forEach(ticker => {
          const quote = quotes[ticker.toUpperCase()];
          if (quote && quote.price) {
            priceMap[ticker] = quote.price;
            successCount++;
          } else {
            priceMap[ticker] = '--';
            failCount++;
            if (failCount <= 5) { // Log first 5 failures
              console.warn(`[SecuritiesList] No price for ${ticker}:`, quote);
            }
          }
        });
        
        console.log(`[SecuritiesList] Price fetch complete: ${successCount} success, ${failCount} failed`);
        setPrices(priceMap);
        setLoading(false);
      } catch (error) {
        console.error('[SecuritiesList] Error fetching prices:', error);
        console.error('[SecuritiesList] Error details:', {
          message: error.message,
          response: error.response?.data,
          status: error.response?.status
        });
        setLoading(false);
      }
    };
    
    // Initial fetch
    fetchPricesData();
    
    // Set up polling interval (8 seconds)
    const interval = setInterval(() => {
      fetchPricesData();
    }, 8000);
    
    return () => clearInterval(interval);
  }, [securities]);

  // Close popover when clicking outside
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (legendRef.current && !legendRef.current.contains(e.target)) {
        setShowLegend(false);
      }
    };
    if (showLegend) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showLegend]);

  return (
    <Card className="relative securities-card" style={{ overflow: 'visible' }}>
      <div 
        className="mb-3 relative" 
        ref={legendRef}
        onMouseEnter={() => setShowLegend(true)}
        onMouseLeave={() => setShowLegend(false)}
      >
        <Title 
          className="cursor-pointer hover:opacity-70 inline-block"
          onClick={() => setShowLegend(!showLegend)}
        >
          Securities
        </Title>
        
        {/* Asset Class Legend Popover */}
        {showLegend && (
          <div 
            className="absolute z-50 mt-2 p-3 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg min-w-[200px]"
          >
            <Text className="text-xs font-semibold mb-2 block dark:text-white">Asset Classes</Text>
            <div className="flex flex-col gap-2">
              {['fixedIncome', 'equity', 'currency', 'commodity', 'crypto'].map((assetClass) => {
                const colorMap = {
                  fixedIncome: '#3B82F6',  // Blue
                  equity: '#10B981',        // Green
                  currency: '#8B5CF6',     // Violet
                  commodity: '#F97316',    // Orange
                  crypto: '#EAB308'        // Yellow
                };
                return (
                  <div key={assetClass} className="flex items-center gap-2">
                    <div 
                      className="w-4 h-4 rounded-sm"
                      style={{ backgroundColor: colorMap[assetClass] || '#6B7280' }}
                    />
                    <Text className="text-xs dark:text-gray-300">{getAssetClassName(assetClass)}</Text>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
      
      <div className="securities-table-wrapper" style={{ overflow: 'visible' }}>
        <Table>
          <TableHead>
            <TableRow>
              <TableHeaderCell style={{ 
                padding: '4px 12px', 
                textAlign: 'left',
                justifyContent: 'flex-start',
                display: 'flex',
                alignItems: 'center'
              }}>Ticker</TableHeaderCell>
              <TableHeaderCell style={{ 
                padding: '4px 12px', 
                textAlign: 'right',
                justifyContent: 'flex-end',
                display: 'flex',
                alignItems: 'center'
              }}>Spot Price</TableHeaderCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {securities.map((security) => (
              <TableRow 
                key={security.ticker}
                className={`${getAssetClassBgColor(security.assetClass)} hover:opacity-80 cursor-pointer security-row-with-dot`}
              >
                <TableCell style={{ 
                  padding: '4px 12px', 
                  textAlign: 'left', 
                  position: 'relative',
                  justifyContent: 'flex-start',
                  display: 'flex',
                  alignItems: 'center'
                }}>
                  <Text className="font-semibold text-sm" style={{ textAlign: 'left', width: '100%' }}>{security.ticker}</Text>
                </TableCell>
                <TableCell style={{ 
                  padding: '4px 12px', 
                  textAlign: 'right', 
                  position: 'relative',
                  justifyContent: 'flex-end',
                  display: 'flex',
                  alignItems: 'center'
                }}>
                  <Text className="font-semibold text-sm" style={{ textAlign: 'right', width: '100%' }}>
                    {loading && prices[security.ticker] === undefined ? '...' : formatPrice(security.ticker, prices[security.ticker], security.assetClass)}
                  </Text>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </Card>
  );
};

export default SecuritiesList;
