import React, { useState, useEffect, useMemo, useRef } from 'react';
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
import { getVolatilityMetrics } from '../../constants/securityCategoryMapping';
import { METRIC_DEFINITIONS } from '../../constants/metricDefinitions';
import MetricDefinitionPopover from '../common/MetricDefinitionPopover';

// Day label component with hover tooltip
const DayLabelWithTooltip = ({ label, date, isLast = false }) => {
  const [showTooltip, setShowTooltip] = useState(false);
  
  return (
    <div
      style={{
        width: isLast ? '32px' : '28px',
        textAlign: 'center',
        fontSize: '8px',
        color: '#6b7280',
        backgroundColor: '#f3f4f6',
        borderRadius: '2px',
        padding: '2px 2px',
        position: 'relative'
      }}
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
    >
      {label}
      {showTooltip && (
        <div
          style={{
            position: 'absolute',
            bottom: '100%',
            left: '50%',
            transform: 'translateX(-50%)',
            backgroundColor: '#1f2937',
            color: '#fff',
            padding: '4px 8px',
            borderRadius: '4px',
            fontSize: '10px',
            whiteSpace: 'nowrap',
            zIndex: 1000,
            marginBottom: '4px',
            pointerEvents: 'none'
          }}
        >
          {date}
        </div>
      )}
    </div>
  );
};

// Security name component with truncation and hover tooltip
const TruncatedSecurityName = ({ name, maxLength = 20 }) => {
  const [showTooltip, setShowTooltip] = useState(false);
  const isTruncated = name && name.length > maxLength;
  const displayName = isTruncated ? `${name.substring(0, maxLength)}...` : name;
  
  return (
    <div
      style={{
        position: 'relative',
        maxWidth: '160px',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap'
      }}
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
    >
      {displayName}
      {showTooltip && (
        <div
          style={{
            position: 'absolute',
            bottom: '100%',
            left: '0',
            backgroundColor: '#1f2937',
            color: '#fff',
            padding: '4px 8px',
            borderRadius: '4px',
            fontSize: '10px',
            whiteSpace: 'nowrap',
            zIndex: 1000,
            marginBottom: '4px',
            pointerEvents: 'none'
          }}
        >
          {name}
        </div>
      )}
    </div>
  );
};

const SecuritiesUniverse = () => {
  const [searchQuery, setSearchQuery] = useState('');
  const [prices, setPrices] = useState({});
  const [priceHistory, setPriceHistory] = useState({});
  const [loading, setLoading] = useState(true);
  const [sortConfig, setSortConfig] = useState([]); // Array of { key, direction } objects
  const [activeFilters, setActiveFilters] = useState({
    assetClasses: [],
    factorExposures: [],
    biases: []
  });
  const [selectedQuad, setSelectedQuad] = useState(null);
  const [shortsMode, setShortsMode] = useState(false); // false = longs (best quads), true = shorts (worst quads)
  const [openPopover, setOpenPopover] = useState(null); // { metricKey, position: { top, left } }
  const hoverTimeoutRef = useRef(null);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (hoverTimeoutRef.current) {
        clearTimeout(hoverTimeoutRef.current);
      }
    };
  }, []);

  // Risk Range History - 10 day history for each security
  // Format: { ticker: { hrr: [t-9, t-8, t-7, t-6, t-5, t-4, t-3, t-2, t-1, today], lrr: [...], ath: number } }
  const riskRangeHistory = useMemo(() => {
    const defaultHistory = { hrr: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], lrr: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], ath: 0 };
    const history = {};
    
    // Initialize all securities with default 0 values
    SECURITIES_LIST.forEach(security => {
      history[security.ticker] = { ...defaultHistory };
    });
    
    // Test data for BKLN to verify color coding
    // HRR: varied pattern to show green (up), red (down), blue (new ATH)
    // LRR: varied pattern to show higher low (green) and lower low (red)
    // ATH: 6.5 (so HRR value of 7 should be blue)
    history['BKLN'] = {
      hrr: [4, 5, 4, 5, 6, 7, 6, 5, 6, 5],
      lrr: [1, 2, 1, 2, 3, 2, 3, 2, 3, 2],
      ath: 6.5
    };
    
    return history;
  }, []);

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
      const priceTimestamp = quote?.timestamp || null;
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

      // Get risk range history for this security
      const securityRiskRangeHistory = riskRangeHistory[security.ticker] || { hrr: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], lrr: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] };

      // Get volatility metrics for this security
      const volMetrics = getVolatilityMetrics(security.ticker);

      return {
        ...security,
        price: currentPrice,
        priceTimestamp,
        factorExposure,
        benchmark,
        zScore,
        priceChanges,
        priceHistory: history, // Store price history for Risk Range display
        beta: '--', // Placeholder
        quadRanking,
        signal: 0,
        riskRangeHistory: securityRiskRangeHistory,
        volatilityMetrics: volMetrics
      };
    });
  }, [prices, priceHistory, riskRangeHistory]);

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

    // Apply Quad filter
    if (selectedQuad !== null) {
      filtered = filtered.filter(security => {
        if (!security.quadRanking || security.quadRanking === '--') return false;
        const quads = security.quadRanking.split('/').map(q => parseInt(q));
        if (shortsMode) {
          // Shorts mode: Check if selected Quad is in worst positions (3rd or 4th)
          return quads[2] === selectedQuad || quads[3] === selectedQuad;
        } else {
          // Longs mode: Check if selected Quad is in best positions (1st or 2nd)
          return quads[0] === selectedQuad || quads[1] === selectedQuad;
        }
      });
    }

    return filtered;
  }, [enrichedSecurities, searchQuery, activeFilters, selectedQuad, shortsMode]);

  // Sort securities (supports multiple column sorting)
  const sortedSecurities = useMemo(() => {
    if (sortConfig.length === 0) {
      return filteredSecurities;
    }

    const sorted = [...filteredSecurities].sort((a, b) => {
      // Apply each sort in order
      for (const sort of sortConfig) {
        let aValue = a[sort.key];
        let bValue = b[sort.key];

        // Handle nested values
        if (sort.key === 'priceChanges') {
          aValue = a.priceChanges?.['1D'] || 0;
          bValue = b.priceChanges?.['1D'] || 0;
        }

        // Handle Quad ranking sorting (sort by first number in format "3/4/2/1")
        if (sort.key === 'quadRanking') {
          const aFirst = a.quadRanking && a.quadRanking !== '--' ? parseInt(a.quadRanking.split('/')[0]) : 999;
          const bFirst = b.quadRanking && b.quadRanking !== '--' ? parseInt(b.quadRanking.split('/')[0]) : 999;
          aValue = aFirst;
          bValue = bFirst;
        }

        // Handle T/T/T sorting (sort by bias: BULLISH > NEUTRAL > BEARISH)
        if (sort.key === 'bias') {
          const biasOrder = { 'BULLISH': 3, 'NEUTRAL': 2, 'BEARISH': 1 };
          aValue = biasOrder[a.bias] || 0;
          bValue = biasOrder[b.bias] || 0;
        }

        // Handle null/undefined
        if (aValue === null || aValue === undefined) aValue = '';
        if (bValue === null || bValue === undefined) bValue = '';

        // Convert to comparable types
        if (typeof aValue === 'string') {
          aValue = aValue.toLowerCase();
          bValue = bValue.toLowerCase();
        }

        // Compare values
        if (aValue < bValue) {
          const result = sort.direction === 'asc' ? -1 : 1;
          if (result !== 0) return result;
        } else if (aValue > bValue) {
          const result = sort.direction === 'asc' ? 1 : -1;
          if (result !== 0) return result;
        }
        // If equal, continue to next sort criteria
      }
      return 0;
    });

    return sorted;
  }, [filteredSecurities, sortConfig]);

  // Handle column sort (toggle on/off, supports multiple columns)
  const handleSort = (key) => {
    setSortConfig(prev => {
      const existingIndex = prev.findIndex(s => s.key === key);
      
      if (existingIndex >= 0) {
        // Column is already sorted - toggle direction or remove
        const existing = prev[existingIndex];
        if (existing.direction === 'asc') {
          // Change to desc
          const updated = [...prev];
          updated[existingIndex] = { ...existing, direction: 'desc' };
          return updated;
        } else {
          // Remove from sort
          return prev.filter((_, index) => index !== existingIndex);
        }
      } else {
        // Add new sort (ascending by default)
        return [...prev, { key, direction: 'asc' }];
      }
    });
  };

  // Get sort info for a column
  const getSortInfo = (key) => {
    const sortIndex = sortConfig.findIndex(s => s.key === key);
    if (sortIndex < 0) return null;
    return {
      direction: sortConfig[sortIndex].direction,
      order: sortIndex + 1 // 1-based order
    };
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
    setSelectedQuad(null);
    setShortsMode(false);
    setSearchQuery('');
  };

  // Handle metric definition popover on hover
  const handleMetricHover = (e, metricKey) => {
    // Clear any pending close timeout
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = null;
    }

    const definition = METRIC_DEFINITIONS[metricKey];
    if (!definition) return;

    // Get the th element for positioning
    const thElement = e.currentTarget.closest('th') || e.currentTarget;
    const rect = thElement.getBoundingClientRect();
    const position = {
      top: rect.bottom + 8,
      left: rect.left
    };

    setOpenPopover({ metricKey, position, definition });
  };

  const handleMetricHoverEnd = () => {
    // Add small delay to allow moving to popover
    hoverTimeoutRef.current = setTimeout(() => {
      setOpenPopover(null);
    }, 100);
  };

  const closePopover = () => {
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = null;
    }
    setOpenPopover(null);
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

  // Format date for tooltip
  const formatPriceDate = (timestamp) => {
    if (!timestamp) return null;
    try {
      const date = new Date(timestamp);
      if (isNaN(date.getTime())) return null;
      return date.toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'short',
        day: 'numeric'
      });
    } catch {
      return null;
    }
  };

  // Get signal color for T/T/T dots
  const getSignalColor = (signal) => {
    if (signal === 'BULLISH') return '#10b981'; // Green
    if (signal === 'BEARISH') return '#ef4444'; // Red
    return '#000000'; // Black for neutral
  };

  // Get color for IVOL Prem % (Red = expensive/high, Green = cheap/discount)
  const getIvolPremColor = (value) => {
    if (value === null || value === undefined) return '#6b7280'; // Gray
    if (value > 5) return '#ef4444'; // Red - expensive
    if (value < -2) return '#10b981'; // Green - cheap
    return '#f59e0b'; // Yellow - neutral
  };

  // Get color for TTM Z-Score (Green < -0.5, Yellow -0.5 to 0.5, Red > 0.5)
  const getTTMZScoreColor = (value) => {
    if (value === null || value === undefined) return '#6b7280'; // Gray
    if (value < -0.5) return '#10b981'; // Green - low volatility
    if (value > 0.5) return '#ef4444'; // Red - high volatility
    return '#f59e0b'; // Yellow - neutral
  };

  // Get color for IOVR Percentile (Green < 30, Yellow 30-70, Red > 70)
  const getIOVRPercentileColor = (value) => {
    if (value === null || value === undefined) return '#6b7280'; // Gray
    if (value < 30) return '#10b981'; // Green - low
    if (value > 70) return '#ef4444'; // Red - high
    return '#f59e0b'; // Yellow - neutral
  };

  // Format volatility metric for display
  const formatVolatilityMetric = (value, isPercentage = false) => {
    if (value === null || value === undefined) return '--';
    if (isPercentage) return `${value}`;
    return value >= 0 ? `+${value.toFixed(1)}` : value.toFixed(1);
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

  // Get color for risk range value based on comparison with previous day
  // For HRR: higher than previous = green (higher high), lower = red (lower high)
  //          if higher high exceeds ATH = blue (new all-time high)
  // For LRR: higher than previous = green (higher low), lower = red (lower low)
  const getRiskRangeColor = (currentValue, previousValue, isFirstDay, ath = null, isHRR = false) => {
    if (isFirstDay || previousValue === null || previousValue === undefined) {
      return '#6b7280'; // Gray for first day (no comparison)
    }
    if (currentValue === 0 && previousValue === 0) {
      return '#6b7280'; // Gray for placeholder zeros
    }
    if (currentValue > previousValue) {
      // Check if this is an HRR that exceeds ATH (new all-time high)
      if (isHRR && ath && ath > 0 && currentValue > ath) {
        return '#3b82f6'; // Blue - new all-time high
      }
      return '#10b981'; // Green - higher high or higher low
    } else if (currentValue < previousValue) {
      return '#ef4444'; // Red - lower high or lower low
    }
    return '#6b7280'; // Gray for equal values
  };

  // Calculate trading days (skip weekends) going back from today
  const getTradingDays = () => {
    const tradingDays = [];
    const today = new Date();
    let currentDate = new Date(today);
    
    // We need 10 trading days (t-9, t-8, t-7, t-6, t-5, t-4, t-3, t-2, t-1, t)
    while (tradingDays.length < 10) {
      const dayOfWeek = currentDate.getDay();
      // Skip Saturday (6) and Sunday (0)
      if (dayOfWeek !== 0 && dayOfWeek !== 6) {
        tradingDays.unshift(new Date(currentDate)); // Add to beginning
      }
      currentDate.setDate(currentDate.getDate() - 1);
    }
    
    return tradingDays;
  };

  const tradingDays = getTradingDays();
  const dayLabels = ['t-9', 't-8', 't-7', 't-6', 't-5', 't-4', 't-3', 't-2', 't-1', 't'];

  // Format date for tooltip
  const formatTradingDate = (date) => {
    return date.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
  };

  // Render the Risk Range mini-table for a security
  const renderRiskRangeCell = (riskRangeHistory, priceHistory = []) => {
    const { hrr, lrr, ath } = riskRangeHistory;
    const lastIndex = dayLabels.length - 1;
    
    // Extract last 10 trading days of closing prices
    // Price history is sorted by date (oldest first), so we need the last 10 items
    const closingPrices = [];
    if (Array.isArray(priceHistory) && priceHistory.length > 0) {
      // Get last 10 items from price history
      const last10 = priceHistory.slice(-10);
      // Pad to 10 items if we have fewer than 10
      for (let i = 0; i < 10; i++) {
        if (i < last10.length) {
          const price = parseFloat(last10[i]?.close || last10[i]?.price || 0);
          closingPrices.push(price > 0 ? price : null);
        } else {
          closingPrices.push(null);
        }
      }
    } else {
      // No price history, fill with nulls
      closingPrices.push(...Array(10).fill(null));
    }
    
    // Helper to format price
    const formatClosingPrice = (price) => {
      if (price === null || price === undefined || price === 0) return '--';
      return price.toFixed(2);
    };
    
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', fontSize: '9px' }}>
        {/* ATH Row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <span style={{ width: '36px', color: '#6b7280', fontWeight: 500, fontSize: '9px' }}>ATH</span>
          <span style={{ fontWeight: 600, color: '#3b82f6', fontSize: '9px' }}>
            {ath > 0 ? ath.toFixed(2) : '--'}
          </span>
        </div>
        {/* Day Labels Row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <span style={{ width: '36px' }}></span>
          <div style={{ display: 'flex', gap: '4px' }}>
            {dayLabels.map((label, index) => (
              <DayLabelWithTooltip
                key={`label-${index}`}
                label={label}
                date={formatTradingDate(tradingDays[index])}
                isLast={index === lastIndex}
              />
            ))}
          </div>
        </div>
        {/* HRR Row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <span style={{ width: '36px', color: '#6b7280', fontWeight: 500, fontSize: '9px' }}>HRR</span>
          <div style={{ display: 'flex', gap: '4px' }}>
            {hrr.map((value, index) => (
              <span
                key={`hrr-${index}`}
                style={{
                  width: index === lastIndex ? '32px' : '28px',
                  textAlign: 'center',
                  fontWeight: 600,
                  fontSize: '9px',
                  color: getRiskRangeColor(value, index > 0 ? hrr[index - 1] : null, index === 0, ath, true)
                }}
                title={`${value}${ath && value > ath ? ' (New ATH!)' : ''}`}
              >
                {value}
              </span>
            ))}
          </div>
        </div>
        {/* Closing Prices Row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <span style={{ width: '36px', color: '#6b7280', fontWeight: 500, fontSize: '9px' }}>Price</span>
          <div style={{ display: 'flex', gap: '4px' }}>
            {closingPrices.map((price, index) => (
              <span
                key={`price-${index}`}
                style={{
                  width: index === lastIndex ? '32px' : '28px',
                  textAlign: 'center',
                  fontWeight: 600,
                  color: price !== null ? '#374151' : '#9ca3af',
                  fontSize: '9px'
                }}
              >
                {formatClosingPrice(price)}
              </span>
            ))}
          </div>
        </div>
        {/* LRR Row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <span style={{ width: '36px', color: '#6b7280', fontWeight: 500, fontSize: '9px' }}>LRR</span>
          <div style={{ display: 'flex', gap: '4px' }}>
            {lrr.map((value, index) => (
              <span
                key={`lrr-${index}`}
                style={{
                  width: index === lastIndex ? '32px' : '28px',
                  textAlign: 'center',
                  fontWeight: 600,
                  fontSize: '9px',
                  color: getRiskRangeColor(value, index > 0 ? lrr[index - 1] : null, index === 0)
                }}
              >
                {value}
              </span>
            ))}
          </div>
        </div>
      </div>
    );
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
          {searchQuery || Object.values(activeFilters).some(arr => arr.length > 0) || selectedQuad !== null
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
              {['Currency/FX', 'Fixed Income', 'Equity', 'Commodity', 'Cryptocurrency'].map(assetClass => {
                const isActive = activeFilters.assetClasses.includes(assetClass);
                // Map display names to asset class keys for color lookup
                const assetClassKey = Object.keys(ASSET_CLASS_NAMES).find(
                  key => ASSET_CLASS_NAMES[key] === assetClass
                );
                // Color mapping matching signal strength card
                const colorMap = {
                  fixedIncome: { active: '#3B82F6', inactive: '#DBEAFE', text: '#1E40AF' },  // Blue
                  equity: { active: '#10B981', inactive: '#D1FAE5', text: '#065F46' },        // Green
                  currency: { active: '#8B5CF6', inactive: '#E9D5FF', text: '#6B21A8' },     // Violet
                  commodity: { active: '#F97316', inactive: '#FED7AA', text: '#9A3412' },    // Orange
                  crypto: { active: '#EAB308', inactive: '#FDE68A', text: '#854D0E' }         // Yellow
                };
                const colors = colorMap[assetClassKey] || { active: '#6B7280', inactive: '#F3F4F6', text: '#374151' };
                const backgroundColor = isActive ? colors.active : colors.inactive;
                const textColor = isActive ? '#ffffff' : colors.text;
                return (
                  <button
                    key={assetClass}
                    onClick={() => toggleFilter('assetClasses', assetClass)}
                    style={{
                      backgroundColor,
                      color: textColor,
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

          {/* Quad Filter */}
          <div>
            <div className="flex items-center gap-2 mb-2">
              <Text className="text-xs font-semibold text-gray-600 dark:text-gray-400">
                Quad Filter
              </Text>
              {selectedQuad !== null && (
                <button
                  onClick={() => setShortsMode(!shortsMode)}
                  style={{
                    backgroundColor: shortsMode ? '#ef4444' : '#10b981',
                    color: '#ffffff',
                    padding: '4px 12px',
                    fontSize: '11px',
                    fontWeight: 500,
                    borderRadius: '9999px',
                    transition: 'all 0.2s',
                    border: 'none',
                    cursor: 'pointer'
                  }}
                  className="hover:opacity-80"
                  title={shortsMode ? 'Switch to longs mode (best quads)' : 'Switch to shorts mode (worst quads)'}
                >
                  {shortsMode ? 'Shorts' : 'Longs'}
                </button>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {[1, 2, 3, 4].map(quadNum => {
                const isActive = selectedQuad === quadNum;
                const getQuadButtonColor = (quadNum, isActive) => {
                  const colors = {
                    1: isActive ? '#10b981' : '#d1fae5', // Darker green
                    2: isActive ? '#34d399' : '#a7f3d0', // Lighter green
                    3: isActive ? '#f59e0b' : '#fde68a', // Orange/Gold
                    4: isActive ? '#ef4444' : '#fee2e2'  // Red
                  };
                  return colors[quadNum] || '#f3f4f6';
                };
                const getQuadTextColor = (quadNum, isActive) => {
                  if (isActive) return '#ffffff';
                  const textColors = {
                    1: '#065f46', // Dark green
                    2: '#047857', // Medium green
                    3: '#92400e', // Dark orange
                    4: '#991b1b'  // Dark red
                  };
                  return textColors[quadNum] || '#374151';
                };
                return (
                  <button
                    key={quadNum}
                    onClick={() => setSelectedQuad(isActive ? null : quadNum)}
                    style={{
                      backgroundColor: getQuadButtonColor(quadNum, isActive),
                      color: getQuadTextColor(quadNum, isActive),
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
                    Quad {quadNum}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Clear Filters Button */}
          {(searchQuery || Object.values(activeFilters).some(arr => arr.length > 0) || selectedQuad !== null) && (
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
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '8px' }}>
              <thead>
                <tr style={{ borderBottom: '2px solid #e5e7eb' }} className="dark:border-gray-700">
                  <th
                    style={{ padding: '6px 5px', textAlign: 'left', fontWeight: 600, cursor: 'pointer', fontSize: '9px' }}
                    className="dark:text-white hover:bg-gray-100 dark:hover:bg-gray-700"
                    onClick={() => handleSort('ticker')}
                  >
                    Ticker {(() => {
                      const sortInfo = getSortInfo('ticker');
                      return sortInfo ? ` ${sortInfo.order}${sortInfo.direction === 'asc' ? '↑' : '↓'}` : '';
                    })()}
                  </th>
                  <th
                    style={{ padding: '6px 5px', textAlign: 'left', fontWeight: 600, cursor: 'pointer', fontSize: '9px' }}
                    className="dark:text-white hover:bg-gray-100 dark:hover:bg-gray-700"
                    onClick={() => handleSort('name')}
                  >
                    Name {(() => {
                      const sortInfo = getSortInfo('name');
                      return sortInfo ? ` ${sortInfo.order}${sortInfo.direction === 'asc' ? '↑' : '↓'}` : '';
                    })()}
                  </th>
                  <th
                    data-metric-key="riskRange"
                    style={{ padding: '6px 5px', textAlign: 'center', fontWeight: 600, fontSize: '9px', cursor: 'default', position: 'relative' }}
                    className="dark:text-white"
                    onMouseEnter={(e) => handleMetricHover(e, 'riskRange')}
                    onMouseLeave={handleMetricHoverEnd}
                  >
                    Risk Range
                  </th>
                  <th
                    style={{ padding: '6px 5px', textAlign: 'left', fontWeight: 600, cursor: 'pointer', fontSize: '9px' }}
                    className="dark:text-white hover:bg-gray-100 dark:hover:bg-gray-700"
                    onClick={() => handleSort('price')}
                  >
                    Spot price {(() => {
                      const sortInfo = getSortInfo('price');
                      return sortInfo ? ` ${sortInfo.order}${sortInfo.direction === 'asc' ? '↑' : '↓'}` : '';
                    })()}
                  </th>
                  <th
                    style={{ padding: '6px 5px', textAlign: 'left', fontWeight: 600, cursor: 'pointer', fontSize: '9px' }}
                    className="dark:text-white hover:bg-gray-100 dark:hover:bg-gray-700"
                    onClick={() => handleSort('assetClass')}
                  >
                    Asset Class {(() => {
                      const sortInfo = getSortInfo('assetClass');
                      return sortInfo ? ` ${sortInfo.order}${sortInfo.direction === 'asc' ? '↑' : '↓'}` : '';
                    })()}
                  </th>
                  <th
                    style={{ padding: '6px 5px', textAlign: 'left', fontWeight: 600, cursor: 'pointer', fontSize: '9px' }}
                    className="dark:text-white hover:bg-gray-100 dark:hover:bg-gray-700"
                    onClick={() => handleSort('factorExposure')}
                  >
                    Factor Exposure {(() => {
                      const sortInfo = getSortInfo('factorExposure');
                      return sortInfo ? ` ${sortInfo.order}${sortInfo.direction === 'asc' ? '↑' : '↓'}` : '';
                    })()}
                  </th>
                  <th
                    data-metric-key="ivolPrem"
                    style={{ padding: '6px 5px', textAlign: 'center', fontWeight: 600, fontSize: '9px', cursor: 'default', position: 'relative' }}
                    className="dark:text-white"
                    onMouseEnter={(e) => handleMetricHover(e, 'ivolPrem')}
                    onMouseLeave={handleMetricHoverEnd}
                  >
                    IVOL Prem %
                  </th>
                  <th
                    data-metric-key="ttmZScore"
                    style={{ padding: '6px 5px', textAlign: 'center', fontWeight: 600, fontSize: '9px', cursor: 'default', position: 'relative' }}
                    className="dark:text-white"
                    onMouseEnter={(e) => handleMetricHover(e, 'ttmZScore')}
                    onMouseLeave={handleMetricHoverEnd}
                  >
                    TTM Z-Score
                  </th>
                  <th
                    data-metric-key="iovrPercentile"
                    style={{ padding: '6px 5px', textAlign: 'center', fontWeight: 600, fontSize: '9px', cursor: 'default', position: 'relative' }}
                    className="dark:text-white"
                    onMouseEnter={(e) => handleMetricHover(e, 'iovrPercentile')}
                    onMouseLeave={handleMetricHoverEnd}
                  >
                    IOVR %ile
                  </th>
                  <th
                    data-metric-key="zScore"
                    style={{ padding: '6px 5px', textAlign: 'right', fontWeight: 600, cursor: 'pointer', fontSize: '9px', position: 'relative' }}
                    className="dark:text-white hover:bg-gray-100 dark:hover:bg-gray-700"
                    onClick={() => handleSort('zScore')}
                    onMouseEnter={(e) => handleMetricHover(e, 'zScore')}
                    onMouseLeave={handleMetricHoverEnd}
                  >
                    Z-Score {(() => {
                      const sortInfo = getSortInfo('zScore');
                      return sortInfo ? ` ${sortInfo.order}${sortInfo.direction === 'asc' ? '↑' : '↓'}` : '';
                    })()}
                  </th>
                  <th
                    data-metric-key="beta"
                    style={{ padding: '6px 5px', textAlign: 'center', fontWeight: 600, cursor: 'pointer', fontSize: '9px', position: 'relative' }}
                    className="dark:text-white hover:bg-gray-100 dark:hover:bg-gray-700"
                    onClick={() => handleSort('beta')}
                    onMouseEnter={(e) => handleMetricHover(e, 'beta')}
                    onMouseLeave={handleMetricHoverEnd}
                  >
                    Beta {(() => {
                      const sortInfo = getSortInfo('beta');
                      return sortInfo ? ` ${sortInfo.order}${sortInfo.direction === 'asc' ? '↑' : '↓'}` : '';
                    })()}
                  </th>
                  <th
                    style={{ padding: '6px 5px', textAlign: 'left', fontWeight: 600, cursor: 'pointer', fontSize: '9px' }}
                    className="dark:text-white hover:bg-gray-100 dark:hover:bg-gray-700"
                    onClick={() => handleSort('benchmark')}
                  >
                    Benchmark {(() => {
                      const sortInfo = getSortInfo('benchmark');
                      return sortInfo ? ` ${sortInfo.order}${sortInfo.direction === 'asc' ? '↑' : '↓'}` : '';
                    })()}
                  </th>
                  <th
                    data-metric-key="ttt"
                    style={{ padding: '6px 5px', textAlign: 'center', fontWeight: 600, cursor: 'pointer', fontSize: '9px', position: 'relative' }}
                    className="dark:text-white hover:bg-gray-100 dark:hover:bg-gray-700"
                    onClick={() => handleSort('bias')}
                    onMouseEnter={(e) => handleMetricHover(e, 'ttt')}
                    onMouseLeave={handleMetricHoverEnd}
                  >
                    T/T/T {(() => {
                      const sortInfo = getSortInfo('bias');
                      return sortInfo ? ` ${sortInfo.order}${sortInfo.direction === 'asc' ? '↑' : '↓'}` : '';
                    })()}
                  </th>
                  <th
                    data-metric-key="quadRanking"
                    style={{ padding: '6px 5px', textAlign: 'center', fontWeight: 600, cursor: 'pointer', fontSize: '9px', position: 'relative' }}
                    className="dark:text-white hover:bg-gray-100 dark:hover:bg-gray-700"
                    onClick={() => handleSort('quadRanking')}
                    onMouseEnter={(e) => handleMetricHover(e, 'quadRanking')}
                    onMouseLeave={handleMetricHoverEnd}
                  >
                    Quad {(() => {
                      const sortInfo = getSortInfo('quadRanking');
                      return sortInfo ? ` ${sortInfo.order}${sortInfo.direction === 'asc' ? '↑' : '↓'}` : '';
                    })()}
                  </th>
                  <th
                    style={{ padding: '6px 5px', textAlign: 'right', fontWeight: 600, fontSize: '9px' }}
                    className="dark:text-white"
                  >
                    Price Change
                  </th>
                  <th
                    style={{ padding: '6px 5px', textAlign: 'center', fontWeight: 600, fontSize: '9px' }}
                    className="dark:text-white"
                  >
                    Signal
                  </th>
                </tr>
              </thead>
              <tbody>
                {sortedSecurities.length === 0 ? (
                  <tr>
                    <td colSpan="16" style={{ padding: '40px', textAlign: 'center' }} className="dark:text-gray-400">
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
                  const volMetrics = security.volatilityMetrics;

                  return (
                    <tr
                      key={security.ticker}
                      style={{
                        borderBottom: '1px solid #e5e7eb',
                        backgroundColor: index % 2 === 0 ? 'transparent' : '#f9fafb'
                      }}
                      className="dark:border-gray-700 dark:bg-gray-800"
                    >
                      <td style={{ padding: '5px 4px', fontWeight: '600' }} className="dark:text-white">
                        {security.ticker}
                      </td>
                      <td style={{ padding: '5px 4px' }} className="dark:text-gray-300">
                        <TruncatedSecurityName name={security.name} maxLength={18} />
                      </td>
                      <td style={{ padding: '5px 4px', textAlign: 'center' }} className="dark:text-gray-300">
                        {renderRiskRangeCell(security.riskRangeHistory, security.priceHistory)}
                      </td>
                      <td
                        style={{ padding: '5px 4px', textAlign: 'left', cursor: security.priceTimestamp ? 'help' : 'default' }}
                        className="dark:text-white"
                        title={formatPriceDate(security.priceTimestamp) ? `Last updated: ${formatPriceDate(security.priceTimestamp)}` : undefined}
                      >
                        {formatPrice(security.price, security.ticker)}
                      </td>
                      <td style={{ padding: '5px 4px' }} className="dark:text-gray-300">
                        {ASSET_CLASS_NAMES[security.assetClass] || security.assetClass}
                      </td>
                      <td style={{ padding: '5px 4px' }} className="dark:text-gray-300">
                        {security.factorExposure}
                      </td>
                      <td
                        style={{
                          padding: '5px 4px',
                          textAlign: 'center',
                          color: volMetrics ? getIvolPremColor(volMetrics.ivolPrem) : '#6b7280',
                          fontWeight: 600
                        }}
                        className="dark:text-white"
                      >
                        {volMetrics ? formatVolatilityMetric(volMetrics.ivolPrem) : '--'}
                      </td>
                      <td
                        style={{
                          padding: '5px 4px',
                          textAlign: 'center',
                          color: volMetrics ? getTTMZScoreColor(volMetrics.ttmZScore) : '#6b7280',
                          fontWeight: 600
                        }}
                        className="dark:text-white"
                      >
                        {volMetrics ? formatVolatilityMetric(volMetrics.ttmZScore) : '--'}
                      </td>
                      <td
                        style={{
                          padding: '5px 4px',
                          textAlign: 'center',
                          color: volMetrics ? getIOVRPercentileColor(volMetrics.iovrPercentile) : '#6b7280',
                          fontWeight: 600
                        }}
                        className="dark:text-white"
                      >
                        {volMetrics ? formatVolatilityMetric(volMetrics.iovrPercentile, true) : '--'}
                      </td>
                      <td style={{ padding: '5px 4px', textAlign: 'right' }} className="dark:text-white">
                        <Badge color={getZScoreColor(security.zScore)} size="xs" style={{ fontSize: '7px', padding: '1px 5px', lineHeight: '1.2' }}>
                          {formatZScore(security.zScore)}
                        </Badge>
                      </td>
                      <td style={{ padding: '5px 4px', textAlign: 'center' }} className="dark:text-gray-300">
                        {security.beta}
                      </td>
                      <td style={{ padding: '5px 4px' }} className="dark:text-gray-300">
                        {security.benchmark}
                      </td>
                      <td style={{ padding: '5px 4px', textAlign: 'center' }}>
                        {(() => {
                          const signals = getTTTSignals(security);
                          return (
                            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }}>
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
                      <td style={{ padding: '5px 4px', textAlign: 'center' }}>
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
                                      fontSize: '8px'
                                    }}
                                  >
                                    {quadNum}
                                  </span>
                                  {index < array.length - 1 && (
                                    <span style={{ color: '#6b7280', fontSize: '8px' }}>/</span>
                                  )}
                                </React.Fragment>
                              );
                            })}
                          </div>
                        ) : (
                          <span className="dark:text-gray-400">--</span>
                        )}
                      </td>
                      <td style={{ padding: '5px 4px', textAlign: 'right' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', fontSize: '7px' }}>
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
                      <td style={{ padding: '5px 4px', textAlign: 'center', fontWeight: 600 }} className="dark:text-white">
                        {security.signal}
                      </td>
                    </tr>
                  );
                })
                )}
              </tbody>
            </table>
          </div>
      </Card>

      {/* Metric Definition Popover */}
      {openPopover && (
        <MetricDefinitionPopover
          metricKey={openPopover.metricKey}
          definition={openPopover.definition}
          position={openPopover.position}
          onClose={closePopover}
          onMouseEnter={() => {
            if (hoverTimeoutRef.current) {
              clearTimeout(hoverTimeoutRef.current);
              hoverTimeoutRef.current = null;
            }
          }}
        />
      )}
    </div>
  );
};

export default SecuritiesUniverse;

