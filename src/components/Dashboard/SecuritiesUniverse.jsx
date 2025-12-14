import React, { useState, useEffect, useMemo } from 'react';
import { Card, Title, Text, Badge } from '@tremor/react';
import { SECURITIES_LIST, ASSET_CLASS_NAMES } from '../../constants/securitiesList';
import { MarketDataService } from '../../services/api/marketDataService';
import {
  mapAssetClassToFactor,
  getBenchmark,
  calculateZScore,
  calculatePriceChanges,
  formatPriceChange,
  getPriceChangeColor,
  filterSecurities,
  formatZScore,
  getZScoreColor
} from '../../utils/securitiesUniverseUtils';
import { getFormattedQuadRanking } from '../../utils/quadRankingUtils';

const SecuritiesUniverse = () => {
  const [searchQuery, setSearchQuery] = useState('');
  const [prices, setPrices] = useState({});
  const [priceHistory, setPriceHistory] = useState({});
  const [loading, setLoading] = useState(true);
  const [sortConfig, setSortConfig] = useState({ key: null, direction: 'asc' });
  const [activeFilters, setActiveFilters] = useState({
    assetClasses: [],
    factorExposures: [],
    biases: []
  });

  // Fetch prices for all securities (non-blocking - show table even if prices fail)
  useEffect(() => {
    const fetchPrices = async () => {
      try {
        // Set loading to false immediately so table shows, then load prices in background
        setLoading(false);
        
        const tickers = SECURITIES_LIST.map(s => s.ticker);
        
        // Fetch quotes in smaller batches to avoid rate limiting
        const batchSize = 20; // Smaller batches
        const allQuotes = {};
        
        for (let i = 0; i < tickers.length; i += batchSize) {
          const batch = tickers.slice(i, i + batchSize);
          try {
            const quotes = await MarketDataService.getQuotes(batch);
            if (quotes && typeof quotes === 'object') {
              Object.assign(allQuotes, quotes);
            }
            // Small delay between batches
            if (i + batchSize < tickers.length) {
              await new Promise(resolve => setTimeout(resolve, 100));
            }
          } catch (error) {
            console.error(`Error fetching batch ${i}-${i + batchSize}:`, error);
            // Continue with other batches even if one fails
          }
        }
        
        setPrices(allQuotes);
        console.log(`Loaded prices for ${Object.keys(allQuotes).length} securities`);
      } catch (error) {
        console.error('Error fetching prices:', error);
        // Don't block UI - prices will show as '--' if unavailable
      }
    };

    fetchPrices();
  }, []);

  // Fetch price history for Z-score calculation (for a sample, can be enhanced to fetch all)
  useEffect(() => {
    const fetchPriceHistory = async () => {
      try {
        // Fetch history for first 30 securities as a sample (can be enhanced to fetch all)
        const sampleTickers = SECURITIES_LIST.slice(0, 30).map(s => s.ticker);
        const historyData = {};
        
        // Fetch in parallel with delay to avoid rate limiting
        const fetchWithDelay = async (ticker, delay) => {
          await new Promise(resolve => setTimeout(resolve, delay));
          try {
            const history = await MarketDataService.getHistoricalData(ticker, 60);
            if (history && history.data && Array.isArray(history.data)) {
              historyData[ticker] = history.data;
            }
          } catch (error) {
            // Silently fail for individual securities
            console.debug(`No history for ${ticker}`);
          }
        };

        // Fetch with staggered delays
        const promises = sampleTickers.map((ticker, index) => 
          fetchWithDelay(ticker, index * 100)
        );
        
        await Promise.all(promises);
        setPriceHistory(historyData);
      } catch (error) {
        console.error('Error fetching price history:', error);
      }
    };

    if (!loading) {
      fetchPriceHistory();
    }
  }, [loading]);

  // Combine securities with price data and calculated metrics
  const enrichedSecurities = useMemo(() => {
    return SECURITIES_LIST.map(security => {
      // Try multiple case variations for ticker lookup
      const tickerUpper = security.ticker.toUpperCase();
      const quote = prices[tickerUpper] || prices[security.ticker] || prices[security.ticker.toUpperCase()];
      const currentPrice = quote?.price || quote?.close || null;
      const history = priceHistory[security.ticker] || [];
      
      // Calculate Z-score from price history
      // History is array of {date, close} objects from API
      const priceValues = Array.isArray(history) 
        ? history.map(item => parseFloat(item.close || item.price || 0)).filter(p => p > 0)
        : [];
      
      const zScore = currentPrice && priceValues.length >= 20 
        ? calculateZScore(currentPrice, priceValues, 20)
        : null;

      // Calculate price changes from historical data
      // History should be array of {date, close} objects
      const priceChanges = currentPrice && history.length > 0 && Array.isArray(history)
        ? calculatePriceChanges(currentPrice, history)
        : { '1D': null, '1W': null, '1M': null };

      // Map factor exposure
      const factorExposure = mapAssetClassToFactor(security.assetClass, security.ticker, security.name);

      // Get benchmark
      const benchmark = getBenchmark(security.assetClass, security.ticker);

      // Get Quad ranking
      const quadRanking = getFormattedQuadRanking(security.ticker);

      return {
        ...security,
        price: currentPrice,
        factorExposure,
        benchmark,
        zScore,
        priceChanges,
        beta: '--', // Placeholder
        quadRanking
      };
    });
  }, [prices, priceHistory]);

  // Filter securities based on search query and active filters
  const filteredSecurities = useMemo(() => {
    let filtered = enrichedSecurities;

    // Apply search query filter
    if (searchQuery) {
      filtered = filterSecurities(filtered, searchQuery);
    }

    // Apply asset class filters
    if (activeFilters.assetClasses.length > 0) {
      filtered = filtered.filter(security => {
        const assetClassName = ASSET_CLASS_NAMES[security.assetClass] || security.assetClass;
        return activeFilters.assetClasses.includes(assetClassName);
      });
    }

    // Apply factor exposure filters
    if (activeFilters.factorExposures.length > 0) {
      filtered = filtered.filter(security => 
        activeFilters.factorExposures.includes(security.factorExposure)
      );
    }

    // Apply bias filters
    if (activeFilters.biases.length > 0) {
      filtered = filtered.filter(security => 
        activeFilters.biases.includes(security.bias)
      );
    }

    return filtered;
  }, [enrichedSecurities, searchQuery, activeFilters]);

  // Sort securities
  const sortedSecurities = useMemo(() => {
    if (!sortConfig.key) {
      return filteredSecurities;
    }

    const sorted = [...filteredSecurities].sort((a, b) => {
      let aValue = a[sortConfig.key];
      let bValue = b[sortConfig.key];

      // Handle nested values
      if (sortConfig.key === 'priceChanges') {
        aValue = a.priceChanges?.['1D'] || 0;
        bValue = b.priceChanges?.['1D'] || 0;
      }

      // Handle Quad ranking sorting (sort by first number in format "3/4/2/1")
      if (sortConfig.key === 'quadRanking') {
        const aFirst = a.quadRanking && a.quadRanking !== '--' ? parseInt(a.quadRanking.split('/')[0]) : 999;
        const bFirst = b.quadRanking && b.quadRanking !== '--' ? parseInt(b.quadRanking.split('/')[0]) : 999;
        aValue = aFirst;
        bValue = bFirst;
      }

      // Handle null/undefined
      if (aValue === null || aValue === undefined) aValue = '';
      if (bValue === null || bValue === undefined) bValue = '';

      // Convert to comparable types
      if (typeof aValue === 'string') {
        aValue = aValue.toLowerCase();
        bValue = bValue.toLowerCase();
      }

      if (aValue < bValue) {
        return sortConfig.direction === 'asc' ? -1 : 1;
      }
      if (aValue > bValue) {
        return sortConfig.direction === 'asc' ? 1 : -1;
      }
      return 0;
    });

    return sorted;
  }, [filteredSecurities, sortConfig]);

  // Handle column sort
  const handleSort = (key) => {
    setSortConfig(prev => ({
      key,
      direction: prev.key === key && prev.direction === 'asc' ? 'desc' : 'asc'
    }));
  };

  // Handle filter tag clicks
  const toggleFilter = (category, value) => {
    setActiveFilters(prev => {
      const currentFilters = prev[category] || [];
      const isActive = currentFilters.includes(value);
      
      return {
        ...prev,
        [category]: isActive
          ? currentFilters.filter(f => f !== value)
          : [...currentFilters, value]
      };
    });
  };

  // Clear all filters
  const clearAllFilters = () => {
    setActiveFilters({
      assetClasses: [],
      factorExposures: [],
      biases: []
    });
    setSearchQuery('');
  };

  // Format price
  const formatPrice = (price, ticker) => {
    if (price === null || price === undefined) return '--';
    const num = parseFloat(price);
    if (isNaN(num)) return '--';
    
    // Treasury yields show as percentage
    if (ticker?.startsWith('UST')) {
      return `${num.toFixed(2)}%`;
    }
    
    return num.toFixed(2);
  };

  // Get signal color for T/T/T dots
  const getSignalColor = (signal) => {
    if (signal === 'BULLISH') return '#10b981'; // Green
    if (signal === 'BEARISH') return '#ef4444'; // Red
    return '#000000'; // Black for neutral
  };

  // Get Quad color based on Quad number
  const getQuadColor = (quadNum) => {
    switch (quadNum) {
      case 1:
        return '#10b981'; // Darker green (Quad 1)
      case 2:
        return '#34d399'; // Lighter green (Quad 2)
      case 3:
        return '#f59e0b'; // Orange/Gold (Quad 3)
      case 4:
        return '#ef4444'; // Red (Quad 4)
      default:
        return '#6b7280'; // Gray for unknown
    }
  };

  // Get T/T/T signals (using bias for all three for now, can be enhanced with actual signal data)
  const getTTTSignals = (security) => {
    // For now, use bias for all three signals
    // Can be enhanced later to fetch actual trade/trend/tail signals
    return {
      trade: security.bias || 'NEUTRAL',
      trend: security.bias || 'NEUTRAL',
      tail: security.bias || 'NEUTRAL'
    };
  };

  return (
    <div style={{ padding: '16px', overflowY: 'auto', height: '100%' }}>
      <Title className="text-lg mb-4 dark:text-white">Securities Universe</Title>

      {/* Search Bar */}
      <Card className="mb-4 dark:bg-gray-800">
        <input
          type="text"
          placeholder="Search by ticker, name, asset class, factor exposure, benchmark..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          style={{ fontSize: '14px' }}
        />
        <Text className="text-sm text-gray-500 dark:text-gray-400 mt-2">
          {searchQuery || Object.values(activeFilters).some(arr => arr.length > 0)
            ? `Showing ${filteredSecurities.length} of ${SECURITIES_LIST.length} securities`
            : `${SECURITIES_LIST.length} securities total`}
        </Text>
      </Card>

      {/* Filter Tags */}
      <Card className="mb-4 dark:bg-gray-800">
        <div className="space-y-3">
          {/* Asset Class Filters */}
          <div>
            <Text className="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-2 block">
              Asset Class
            </Text>
            <div className="flex flex-wrap gap-2">
              {Object.values(ASSET_CLASS_NAMES).map(assetClass => {
                const isActive = activeFilters.assetClasses.includes(assetClass);
                return (
                  <button
                    key={assetClass}
                    onClick={() => toggleFilter('assetClasses', assetClass)}
                    className={`px-3 py-1 text-xs font-medium rounded-full transition-colors ${
                      isActive
                        ? 'bg-blue-500 text-white dark:bg-blue-600'
                        : 'bg-gray-200 text-gray-700 hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600'
                    }`}
                  >
                    {assetClass}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Factor Exposure Filters */}
          <div>
            <Text className="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-2 block">
              Factor Exposure
            </Text>
            <div className="flex flex-wrap gap-2">
              {['Growth', 'Value', 'Quality', 'Momentum', 'Low Volatility'].map(factor => {
                const isActive = activeFilters.factorExposures.includes(factor);
                return (
                  <button
                    key={factor}
                    onClick={() => toggleFilter('factorExposures', factor)}
                    className={`px-3 py-1 text-xs font-medium rounded-full transition-colors ${
                      isActive
                        ? 'bg-purple-500 text-white dark:bg-purple-600'
                        : 'bg-gray-200 text-gray-700 hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600'
                    }`}
                  >
                    {factor}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Bias Filters */}
          <div>
            <Text className="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-2 block">
              Bias
            </Text>
            <div className="flex flex-wrap gap-2">
              {['BULLISH', 'BEARISH', 'NEUTRAL'].map(bias => {
                const isActive = activeFilters.biases.includes(bias);
                const getBiasColor = (bias) => {
                  if (bias === 'BULLISH') return isActive ? '#10b981' : '#d1fae5';
                  if (bias === 'BEARISH') return isActive ? '#ef4444' : '#fee2e2';
                  return isActive ? '#6b7280' : '#f3f4f6';
                };
                const getTextColor = (bias) => {
                  if (isActive) return '#ffffff';
                  if (bias === 'BULLISH') return '#065f46';
                  if (bias === 'BEARISH') return '#991b1b';
                  return '#374151';
                };
                return (
                  <button
                    key={bias}
                    onClick={() => toggleFilter('biases', bias)}
                    style={{
                      backgroundColor: getBiasColor(bias),
                      color: getTextColor(bias),
                      padding: '4px 12px',
                      fontSize: '12px',
                      fontWeight: 500,
                      borderRadius: '9999px',
                      transition: 'all 0.2s',
                      border: 'none',
                      cursor: 'pointer'
                    }}
                    className={!isActive ? 'hover:opacity-80 dark:hover:opacity-70' : ''}
                  >
                    {bias}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Clear Filters Button */}
          {(searchQuery || Object.values(activeFilters).some(arr => arr.length > 0)) && (
            <div className="pt-2 border-t dark:border-gray-700">
              <button
                onClick={clearAllFilters}
                className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
              >
                Clear all filters
              </button>
            </div>
          )}
        </div>
      </Card>

      {/* Data Table */}
      <Card className="dark:bg-gray-800">
        <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
              <thead>
                <tr style={{ borderBottom: '2px solid #e5e7eb' }} className="dark:border-gray-700">
                  <th
                    style={{ padding: '12px 8px', textAlign: 'left', fontWeight: 600, cursor: 'pointer' }}
                    className="dark:text-white hover:bg-gray-100 dark:hover:bg-gray-700"
                    onClick={() => handleSort('ticker')}
                  >
                    Ticker {sortConfig.key === 'ticker' && (sortConfig.direction === 'asc' ? '↑' : '↓')}
                  </th>
                  <th
                    style={{ padding: '12px 8px', textAlign: 'left', fontWeight: 600, cursor: 'pointer' }}
                    className="dark:text-white hover:bg-gray-100 dark:hover:bg-gray-700"
                    onClick={() => handleSort('name')}
                  >
                    Name {sortConfig.key === 'name' && (sortConfig.direction === 'asc' ? '↑' : '↓')}
                  </th>
                  <th
                    style={{ padding: '12px 8px', textAlign: 'right', fontWeight: 600, cursor: 'pointer' }}
                    className="dark:text-white hover:bg-gray-100 dark:hover:bg-gray-700"
                    onClick={() => handleSort('price')}
                  >
                    Price {sortConfig.key === 'price' && (sortConfig.direction === 'asc' ? '↑' : '↓')}
                  </th>
                  <th
                    style={{ padding: '12px 8px', textAlign: 'left', fontWeight: 600, cursor: 'pointer' }}
                    className="dark:text-white hover:bg-gray-100 dark:hover:bg-gray-700"
                    onClick={() => handleSort('assetClass')}
                  >
                    Asset Class {sortConfig.key === 'assetClass' && (sortConfig.direction === 'asc' ? '↑' : '↓')}
                  </th>
                  <th
                    style={{ padding: '12px 8px', textAlign: 'left', fontWeight: 600, cursor: 'pointer' }}
                    className="dark:text-white hover:bg-gray-100 dark:hover:bg-gray-700"
                    onClick={() => handleSort('factorExposure')}
                  >
                    Factor Exposure {sortConfig.key === 'factorExposure' && (sortConfig.direction === 'asc' ? '↑' : '↓')}
                  </th>
                  <th
                    style={{ padding: '12px 8px', textAlign: 'right', fontWeight: 600, cursor: 'pointer' }}
                    className="dark:text-white hover:bg-gray-100 dark:hover:bg-gray-700"
                    onClick={() => handleSort('zScore')}
                  >
                    Z-Score {sortConfig.key === 'zScore' && (sortConfig.direction === 'asc' ? '↑' : '↓')}
                  </th>
                  <th
                    style={{ padding: '12px 8px', textAlign: 'center', fontWeight: 600, cursor: 'pointer' }}
                    className="dark:text-white hover:bg-gray-100 dark:hover:bg-gray-700"
                    onClick={() => handleSort('beta')}
                  >
                    Beta {sortConfig.key === 'beta' && (sortConfig.direction === 'asc' ? '↑' : '↓')}
                  </th>
                  <th
                    style={{ padding: '12px 8px', textAlign: 'left', fontWeight: 600, cursor: 'pointer' }}
                    className="dark:text-white hover:bg-gray-100 dark:hover:bg-gray-700"
                    onClick={() => handleSort('benchmark')}
                  >
                    Benchmark {sortConfig.key === 'benchmark' && (sortConfig.direction === 'asc' ? '↑' : '↓')}
                  </th>
                  <th
                    style={{ padding: '12px 8px', textAlign: 'center', fontWeight: 600, cursor: 'pointer' }}
                    className="dark:text-white hover:bg-gray-100 dark:hover:bg-gray-700"
                    onClick={() => handleSort('bias')}
                  >
                    T/T/T {sortConfig.key === 'bias' && (sortConfig.direction === 'asc' ? '↑' : '↓')}
                  </th>
                  <th
                    style={{ padding: '12px 8px', textAlign: 'center', fontWeight: 600, cursor: 'pointer' }}
                    className="dark:text-white hover:bg-gray-100 dark:hover:bg-gray-700"
                    onClick={() => handleSort('quadRanking')}
                  >
                    Quad {sortConfig.key === 'quadRanking' && (sortConfig.direction === 'asc' ? '↑' : '↓')}
                  </th>
                  <th
                    style={{ padding: '12px 8px', textAlign: 'right', fontWeight: 600 }}
                    className="dark:text-white"
                  >
                    Price Change
                  </th>
                </tr>
              </thead>
              <tbody>
                {sortedSecurities.length === 0 ? (
                  <tr>
                    <td colSpan="11" style={{ padding: '40px', textAlign: 'center' }} className="dark:text-gray-400">
                      {searchQuery 
                        ? `No securities found matching "${searchQuery}"`
                        : 'No securities available'}
                    </td>
                  </tr>
                ) : (
                  sortedSecurities.map((security, index) => {
                  const priceChange1D = security.priceChanges?.['1D'];
                  const priceChange1W = security.priceChanges?.['1W'];
                  const priceChange1M = security.priceChanges?.['1M'];

                  return (
                    <tr
                      key={security.ticker}
                      style={{
                        borderBottom: '1px solid #e5e7eb',
                        backgroundColor: index % 2 === 0 ? 'transparent' : '#f9fafb'
                      }}
                      className="dark:border-gray-700 dark:bg-gray-800"
                    >
                      <td style={{ padding: '10px 8px', fontWeight: '600' }} className="dark:text-white">
                        {security.ticker}
                      </td>
                      <td style={{ padding: '10px 8px' }} className="dark:text-gray-300">
                        {security.name}
                      </td>
                      <td style={{ padding: '10px 8px', textAlign: 'right' }} className="dark:text-white">
                        {formatPrice(security.price, security.ticker)}
                      </td>
                      <td style={{ padding: '10px 8px' }} className="dark:text-gray-300">
                        {ASSET_CLASS_NAMES[security.assetClass] || security.assetClass}
                      </td>
                      <td style={{ padding: '10px 8px' }} className="dark:text-gray-300">
                        {security.factorExposure}
                      </td>
                      <td style={{ padding: '10px 8px', textAlign: 'right' }} className="dark:text-white">
                        <Badge color={getZScoreColor(security.zScore)} size="sm">
                          {formatZScore(security.zScore)}
                        </Badge>
                      </td>
                      <td style={{ padding: '10px 8px', textAlign: 'center' }} className="dark:text-gray-300">
                        {security.beta}
                      </td>
                      <td style={{ padding: '10px 8px' }} className="dark:text-gray-300">
                        {security.benchmark}
                      </td>
                      <td style={{ padding: '10px 8px', textAlign: 'center' }}>
                        {(() => {
                          const signals = getTTTSignals(security);
                          return (
                            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }}>
                              <div style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '1px' }} className="dark:text-white">
                                T/T/T
                              </div>
                              <div style={{ display: 'flex', gap: '4px', justifyContent: 'center' }}>
                                <div
                                  style={{
                                    width: '8px',
                                    height: '8px',
                                    borderRadius: '50%',
                                    backgroundColor: getSignalColor(signals.trade)
                                  }}
                                  title={`Trade: ${signals.trade}`}
                                />
                                <div
                                  style={{
                                    width: '8px',
                                    height: '8px',
                                    borderRadius: '50%',
                                    backgroundColor: getSignalColor(signals.trend)
                                  }}
                                  title={`Trend: ${signals.trend}`}
                                />
                                <div
                                  style={{
                                    width: '8px',
                                    height: '8px',
                                    borderRadius: '50%',
                                    backgroundColor: getSignalColor(signals.tail)
                                  }}
                                  title={`Tail: ${signals.tail}`}
                                />
                              </div>
                            </div>
                          );
                        })()}
                      </td>
                      <td style={{ padding: '10px 8px', textAlign: 'center' }}>
                        {security.quadRanking && security.quadRanking !== '--' ? (
                          <div style={{ display: 'flex', gap: '2px', justifyContent: 'center', alignItems: 'center' }}>
                            {security.quadRanking.split('/').map((quadNum, index, array) => {
                              const num = parseInt(quadNum);
                              return (
                                <React.Fragment key={index}>
                                  <span
                                    style={{
                                      color: getQuadColor(num),
                                      fontWeight: 600,
                                      fontSize: '13px'
                                    }}
                                  >
                                    {quadNum}
                                  </span>
                                  {index < array.length - 1 && (
                                    <span style={{ color: '#6b7280', fontSize: '13px' }}>/</span>
                                  )}
                                </React.Fragment>
                              );
                            })}
                          </div>
                        ) : (
                          <span className="dark:text-gray-400">--</span>
                        )}
                      </td>
                      <td style={{ padding: '10px 8px', textAlign: 'right' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', fontSize: '11px' }}>
                          <span 
                            style={{ 
                              color: getPriceChangeColor(priceChange1D) === 'emerald' ? '#10b981' : 
                                     getPriceChangeColor(priceChange1D) === 'red' ? '#ef4444' : '#6b7280'
                            }}
                            className="dark:text-gray-300"
                          >
                            1D: {formatPriceChange(priceChange1D)}
                          </span>
                          <span 
                            style={{ 
                              color: getPriceChangeColor(priceChange1W) === 'emerald' ? '#10b981' : 
                                     getPriceChangeColor(priceChange1W) === 'red' ? '#ef4444' : '#6b7280'
                            }}
                            className="dark:text-gray-300"
                          >
                            1W: {formatPriceChange(priceChange1W)}
                          </span>
                          <span 
                            style={{ 
                              color: getPriceChangeColor(priceChange1M) === 'emerald' ? '#10b981' : 
                                     getPriceChangeColor(priceChange1M) === 'red' ? '#ef4444' : '#6b7280'
                            }}
                            className="dark:text-gray-300"
                          >
                            1M: {formatPriceChange(priceChange1M)}
                          </span>
                        </div>
                      </td>
                    </tr>
                  );
                })
                )}
              </tbody>
            </table>
          </div>
      </Card>
    </div>
  );
};

export default SecuritiesUniverse;
