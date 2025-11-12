import React, { useState, useRef, useEffect } from 'react';
import { Card, Text, Title } from '@tremor/react';
import { SECURITIES_LIST } from '../../constants/securitiesList';
import { MarketDataService } from '../../services/api/marketDataService';
import './SecuritiesList.css';

const SecuritiesList = () => {
  const securities = SECURITIES_LIST;
  const [showLegend, setShowLegend] = useState(false);
  const [showDotLegend, setShowDotLegend] = useState(false);
  const [prices, setPrices] = useState({}); // { ticker: { price, timestamp } }
  const [loading, setLoading] = useState(true);
  const [updateTrigger, setUpdateTrigger] = useState(0); // Trigger for real-time color updates
  const legendRef = useRef(null);
  const dotLegendRef = useRef(null);
  const rowRefs = useRef({});
  const pricesRef = useRef({}); // Ref to track current prices for stale closure prevention

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
    // Handle undefined/null cases
    if (price === undefined || price === null) {
      return '--';
    }
    
    // Handle both old format (string) and new format (object with price property)
    let priceValue;
    if (typeof price === 'object' && price !== null) {
      // New format: { price: "...", timestamp: "..." }
      priceValue = price.price;
    } else if (typeof price === 'string') {
      // Old format: just a string
      priceValue = price;
    } else {
      return '--';
    }
    
    // Check if priceValue is valid
    if (!priceValue || priceValue === 'N/A' || priceValue === '--') {
      return '--';
    }
    
    const priceNum = parseFloat(priceValue);
    if (isNaN(priceNum)) {
      return '--';
    }
    
    // Treasury yields show as percentage
    if (ticker.startsWith('UST')) {
      return `${priceNum.toFixed(2)}%`;
    }
    
    // For other assets, show as number without $ symbol
    return `${priceNum.toFixed(2)}`;
  };

  // Check if timestamp is more than 1 market day old
  // Market days are weekdays, and we consider >26 hours as more than 1 market day
  // (accounts for market close ~4 PM ET to next day open ~9:30 AM ET)
  const isMoreThanOneMarketDayOld = (timestamp) => {
    if (!timestamp) return false;
    
    const now = Date.now();
    const timestampMs = typeof timestamp === 'string' ? new Date(timestamp).getTime() : timestamp;
    const elapsedMs = now - timestampMs;
    const elapsedHours = elapsedMs / (1000 * 60 * 60);
    
    // More than 26 hours old (accounts for market close to next day open)
    return elapsedHours > 26;
  };

  // Calculate update status based on timestamp
  const getUpdateStatus = (timestamp, lrrTimestamp = null, hrrTimestamp = null) => {
    // Priority 1: Check if LRR or HRR are more than 1 market day old (blue)
    if (lrrTimestamp && isMoreThanOneMarketDayOld(lrrTimestamp)) {
      return { status: 'lrr-stale', color: '#3B82F6' }; // Blue
    }
    if (hrrTimestamp && isMoreThanOneMarketDayOld(hrrTimestamp)) {
      return { status: 'hrr-stale', color: '#3B82F6' }; // Blue
    }
    
    // Priority 2: Check price update status
    if (!timestamp) {
      return { status: 'stale', color: '#EF4444' }; // Red for no timestamp
    }
    
    const now = Date.now();
    const timestampMs = typeof timestamp === 'string' ? new Date(timestamp).getTime() : timestamp;
    const elapsedMs = now - timestampMs;
    const elapsedSeconds = elapsedMs / 1000;
    const elapsedMinutes = elapsedSeconds / 60;
    
    if (elapsedMinutes < 1) {
      return { status: 'fresh', color: '#10B981' }; // Green
    } else if (elapsedMinutes < 5) {
      return { status: 'recent', color: '#F59E0B' }; // Orange
    } else {
      return { status: 'stale', color: '#EF4444' }; // Red
    }
  };

  // Calculate odds (upside and downside percentages)
  const calculateOdds = (spotPrice, lrr, hrr) => {
    // Handle missing or invalid spot price
    if (!spotPrice || spotPrice === '--' || spotPrice === 'N/A') {
      return { upside: null, downside: null };
    }
    
    // Extract numeric value from price data
    let spotValue;
    if (typeof spotPrice === 'object' && spotPrice !== null) {
      spotValue = parseFloat(spotPrice.price);
    } else if (typeof spotPrice === 'string') {
      spotValue = parseFloat(spotPrice);
    } else {
      spotValue = parseFloat(spotPrice);
    }
    
    if (isNaN(spotValue) || spotValue <= 0) {
      return { upside: null, downside: null };
    }
    
    // Calculate upside from HRR
    let upside = null;
    if (hrr && hrr !== '--' && hrr !== 'N/A') {
      const hrrValue = parseFloat(hrr);
      if (!isNaN(hrrValue) && hrrValue > 0) {
        upside = ((hrrValue - spotValue) / spotValue) * 100;
      }
    }
    
    // Calculate downside from LRR
    let downside = null;
    if (lrr && lrr !== '--' && lrr !== 'N/A') {
      const lrrValue = parseFloat(lrr);
      if (!isNaN(lrrValue) && lrrValue > 0) {
        downside = ((spotValue - lrrValue) / spotValue) * 100;
      }
    }
    
    return { upside, downside };
  };

  // Poll for prices every 8 seconds
  useEffect(() => {
    console.log('[SecuritiesList] Setting up polling interval');
    let pollCount = 0;
    
    // Fetch prices function
    const fetchPricesData = async () => {
      pollCount++;
      const pollId = `poll-${pollCount}`;
      console.log(`[SecuritiesList] [${pollId}] Starting fetchPricesData (poll #${pollCount})`);
      
      try {
        const tickers = securities.map(s => s.ticker);
        console.log(`[SecuritiesList] [${pollId}] Fetching prices for ${tickers.length} securities:`, tickers.slice(0, 5), '...');
        
        const quotes = await MarketDataService.getQuotes(tickers);
        console.log(`[SecuritiesList] [${pollId}] API Response received:`, {
          quoteCount: Object.keys(quotes).length,
          sampleQuote: quotes[Object.keys(quotes)[0]],
          allKeys: Object.keys(quotes).slice(0, 10)
        });
        
        // Handle empty response
        if (!quotes || Object.keys(quotes).length === 0) {
          console.warn(`[SecuritiesList] [${pollId}] Empty quotes response! Keeping existing data.`);
          // Keep existing data, just update loading state
          setLoading(false);
          return;
        }
        
        const priceMap = {};
        let successCount = 0;
        let failCount = 0;
        const currentTime = Date.now();
        
        tickers.forEach(ticker => {
          const quote = quotes[ticker.toUpperCase()];
          if (quote && quote.price) {
            // Store both price and timestamp
            const timestamp = quote.timestamp || new Date().toISOString();
            priceMap[ticker] = {
              price: quote.price,
              timestamp: timestamp
            };
            successCount++;
            if (pollCount === 1 || successCount <= 3) { // Log first poll or first 3 successes
              console.log(`[SecuritiesList] [${pollId}] Updated ${ticker}: price=${quote.price}, timestamp=${timestamp}`);
            }
          } else {
            // For failed quotes, keep existing data if available, or set to null
            // Use ref to avoid stale closure issues
            const existingData = pricesRef.current[ticker];
            if (existingData && existingData.price && existingData.price !== '--') {
              // Keep existing data but mark as potentially stale
              priceMap[ticker] = existingData;
              console.log(`[SecuritiesList] [${pollId}] Keeping existing data for ${ticker}:`, existingData);
            } else {
              priceMap[ticker] = { price: '--', timestamp: null };
            }
            failCount++;
            if (failCount <= 5) { // Log first 5 failures
              console.warn(`[SecuritiesList] [${pollId}] No price for ${ticker}:`, quote);
            }
          }
        });
        
        console.log(`[SecuritiesList] [${pollId}] Price fetch complete: ${successCount} success, ${failCount} failed`);
        console.log(`[SecuritiesList] [${pollId}] Timestamps captured for ${successCount} securities`);
        console.log(`[SecuritiesList] [${pollId}] Updating state with ${Object.keys(priceMap).length} price entries`);
        
        setPrices(priceMap);
        pricesRef.current = priceMap; // Update ref
        setLoading(false);
        // Trigger update for dot colors
        setUpdateTrigger(prev => prev + 1);
        
        console.log(`[SecuritiesList] [${pollId}] State update complete`);
      } catch (error) {
        console.error(`[SecuritiesList] [${pollId}] Error fetching prices:`, error);
        console.error(`[SecuritiesList] [${pollId}] Error details:`, {
          message: error.message,
          stack: error.stack?.split('\n').slice(0, 3),
          response: error.response?.data,
          status: error.response?.status,
          config: {
            url: error.config?.url,
            method: error.config?.method
          }
        });
        
        // On error, keep existing data if available
        if (Object.keys(pricesRef.current).length > 0) {
          console.log(`[SecuritiesList] [${pollId}] Error occurred, keeping existing ${Object.keys(pricesRef.current).length} price entries`);
        } else {
          console.warn(`[SecuritiesList] [${pollId}] Error occurred and no existing data available`);
        }
        
        setLoading(false);
      }
    };
    
    // Initial fetch
    console.log('[SecuritiesList] Performing initial fetch');
    fetchPricesData();
    
    // Set up polling interval (8 seconds)
    console.log('[SecuritiesList] Setting up 8-second polling interval');
    const interval = setInterval(() => {
      console.log('[SecuritiesList] Polling interval triggered');
      fetchPricesData();
    }, 8000);
    
    return () => {
      console.log('[SecuritiesList] Cleaning up polling interval');
      clearInterval(interval);
    };
  }, [securities]);

  // Real-time color updates for dots (every 10 seconds to update as data ages)
  useEffect(() => {
    const colorUpdateInterval = setInterval(() => {
      setUpdateTrigger(prev => prev + 1);
    }, 10000); // Update every 10 seconds
    
    return () => clearInterval(colorUpdateInterval);
  }, []);

  // Close popover when clicking outside
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (legendRef.current && !legendRef.current.contains(e.target)) {
        setShowLegend(false);
      }
      if (dotLegendRef.current && !dotLegendRef.current.contains(e.target)) {
        setShowDotLegend(false);
      }
    };
    if (showLegend || showDotLegend) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showLegend, showDotLegend]);

  return (
    <Card className="relative securities-card dark:bg-gray-800" style={{ overflow: 'visible' }}>
      <div 
        className="relative" 
        ref={legendRef}
        onMouseEnter={() => setShowLegend(true)}
        onMouseLeave={() => setShowLegend(false)}
      >
        <Title 
          className="cursor-pointer hover:opacity-70 inline-block"
          onClick={() => setShowLegend(!showLegend)}
        >
          Signal Strength
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
      
      <div className="securities-table-wrapper">
        {/* Header Row */}
        <div className="securities-header-row">
          <div 
            className="header-dot relative"
            ref={dotLegendRef}
            onMouseEnter={() => setShowDotLegend(true)}
            onMouseLeave={() => setShowDotLegend(false)}
          >
            <span className="cursor-pointer hover:opacity-70">U</span>
            {/* Dot Status Legend Popover */}
            {showDotLegend && (
              <div 
                className="absolute z-50 mt-2 p-3 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg min-w-[200px]"
                style={{ left: 0, top: '100%' }}
              >
                <Text className="text-xs font-semibold mb-2 block dark:text-white">Update Status</Text>
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <div 
                      className="w-4 h-4 rounded-full"
                      style={{ backgroundColor: '#10B981' }}
                    />
                    <Text className="text-xs dark:text-gray-300">Fresh (&lt; 1 min)</Text>
                  </div>
                  <div className="flex items-center gap-2">
                    <div 
                      className="w-4 h-4 rounded-full"
                      style={{ backgroundColor: '#F59E0B' }}
                    />
                    <Text className="text-xs dark:text-gray-300">Recent (1-5 min)</Text>
                  </div>
                  <div className="flex items-center gap-2">
                    <div 
                      className="w-4 h-4 rounded-full"
                      style={{ backgroundColor: '#EF4444' }}
                    />
                    <Text className="text-xs dark:text-gray-300">Stale (&gt; 5 min)</Text>
                  </div>
                  <div className="flex items-center gap-2">
                    <div 
                      className="w-4 h-4 rounded-full"
                      style={{ backgroundColor: '#3B82F6' }}
                    />
                    <Text className="text-xs dark:text-gray-300">LRR/HRR &gt; 1 market day old</Text>
                  </div>
                </div>
              </div>
            )}
          </div>
          <div className="header-ticker">Ticker</div>
          <div className="header-price">Spot Price</div>
          <div className="header-lrr">LRR</div>
          <div className="header-hrr">HRR</div>
          <div className="header-odds">Odds</div>
        </div>
        
        {/* Data Rows */}
        <div className="securities-data-container">
          {securities.map((security, index) => (
            <div 
              key={security.ticker}
              className={`securities-data-row ${getAssetClassBgColor(security.assetClass)} ${index === securities.length - 1 ? 'last-row' : ''}`}
            >
              <div className="data-dot-cell">
                {(() => {
                  const priceData = prices[security.ticker];
                  const timestamp = priceData?.timestamp || null;
                  // TODO: Get actual LRR/HRR timestamps when available
                  // For now, check if security object has these properties
                  const lrrTimestamp = security.lrrTimestamp || null;
                  const hrrTimestamp = security.hrrTimestamp || null;
                  const status = getUpdateStatus(timestamp, lrrTimestamp, hrrTimestamp);
                  // Use updateTrigger to force re-render for real-time updates
                  const _ = updateTrigger;
                  
                  let tooltipText = '';
                  if (status.status === 'lrr-stale' || status.status === 'hrr-stale') {
                    tooltipText = `LRR/HRR are more than 1 market day old`;
                    if (lrrTimestamp) {
                      tooltipText += ` (LRR: ${new Date(lrrTimestamp).toLocaleString()})`;
                    }
                    if (hrrTimestamp) {
                      tooltipText += ` (HRR: ${new Date(hrrTimestamp).toLocaleString()})`;
                    }
                  } else {
                    tooltipText = `Last updated: ${timestamp ? new Date(timestamp).toLocaleTimeString() : 'Never'} (${status.status})`;
                  }
                  
                  return (
                    <span 
                      className="ticker-dot" 
                      style={{ backgroundColor: status.color }}
                      title={tooltipText}
                    ></span>
                  );
                })()}
              </div>
              <div className="data-ticker-cell">
                <span className="data-ticker">{security.ticker}</span>
              </div>
              <div className="data-price-cell">
                <span className="data-price">
                  {(() => {
                    const priceData = prices[security.ticker];
                    // Show '...' only when loading AND no data exists
                    if (loading && priceData === undefined) {
                      return '...';
                    }
                    // If we have data (even if loading is true), show it
                    if (priceData !== undefined && priceData !== null) {
                      return formatPrice(security.ticker, priceData, security.assetClass);
                    }
                    // No data and not loading, show '--'
                    return '--';
                  })()}
                </span>
              </div>
              <div className="data-lrr-cell">
                <span className="data-lrr">--</span>
              </div>
              <div className="data-hrr-cell">
                <span className="data-hrr">--</span>
              </div>
              <div className="data-odds-cell">
                {(() => {
                  const priceData = prices[security.ticker];
                  const spotPrice = priceData?.price || priceData;
                  const lrr = '--'; // TODO: Get actual LRR value when available
                  const hrr = '--'; // TODO: Get actual HRR value when available
                  const odds = calculateOdds(spotPrice, lrr, hrr);
                  
                  if (odds.upside === null && odds.downside === null) {
                    return <span className="data-odds">--</span>;
                  }
                  
                  const upsideStr = odds.upside !== null ? `${odds.upside.toFixed(1)}%` : '--';
                  const downsideStr = odds.downside !== null ? `~${odds.downside.toFixed(1)}%` : '--';
                  
                  return (
                    <span className="data-odds">
                      {odds.upside !== null && (
                        <span className="odds-upside">{upsideStr}</span>
                      )}
                      {odds.upside !== null && odds.downside !== null && ' / '}
                      {odds.downside !== null && (
                        <span className="odds-downside">{downsideStr}</span>
                      )}
                      {odds.upside === null && odds.downside === null && '--'}
                    </span>
                  );
                })()}
              </div>
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
};

export default SecuritiesList;
