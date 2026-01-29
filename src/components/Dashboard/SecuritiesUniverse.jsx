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
import {
  AlignLeft,
  FileText,
  Activity,
  BarChart3,
  AreaChart,
  SlidersHorizontal,
  Percent,
  // Sigma, // Lucide doesn't have Sigma in all versions, using FunctionSquare as fallback if needed or custom path
  FunctionSquare,
  LineChart,
  Type,
  LayoutGrid,
  DollarSign,
  ArrowUp,
  ArrowDown,
  TrendingUp
} from 'lucide-react';

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
  const [riskRanges, setRiskRanges] = useState({});

  // Fetch Risk Ranges
  useEffect(() => {
    const fetchRiskRanges = async () => {
      try {
        // Fetch full history from bulk endpoint
        const historyData = await MarketDataService.getAllRiskRangeHistory();
        if (historyData) {
          setRiskRanges(historyData); // Stores { ticker: [history array] }
        }
      } catch (error) {
        console.error('Error fetching risk ranges:', error);
      }
    };
    fetchRiskRanges();
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
        // Fetch history for all securities
        const allTickers = SECURITIES_LIST.map(s => s.ticker);
        const historyData = {};

        // Fetch in parallel with delay to avoid rate limiting
        const fetchWithDelay = async (ticker, delay) => {
          await new Promise(resolve => setTimeout(resolve, delay));
          try {
            // We only need last 10-15 days, fetching 20 to be safe
            const history = await MarketDataService.getHistoricalData(ticker, 20);
            if (history && history.data && Array.isArray(history.data)) {
              historyData[ticker] = history.data;
            }
          } catch (error) {
            // Silently fail for individual securities
            console.debug(`No history for ${ticker}`);
          }
        };

        // Fetch in batches of 10 to act as a rolling window
        const batchSize = 10;
        for (let i = 0; i < allTickers.length; i += batchSize) {
          const batch = allTickers.slice(i, i + batchSize);
          const promises = batch.map((ticker, index) =>
            fetchWithDelay(ticker, index * 50) // 50ms stagger within batch
          );

          await Promise.all(promises);

          // Update state incrementally so results stream in
          setPriceHistory(prev => ({ ...prev, ...historyData }));

          // Wait a bit between batches
          await new Promise(resolve => setTimeout(resolve, 200));
        }
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

      // Get risk range for this security
      // riskRanges is now { ticker: [ { date, lrr, hrr, trend... } ] }
      const historyItems = riskRanges[security.ticker] || riskRanges[security.ticker.toUpperCase()] || [];
      const riskData = historyItems.length > 0 ? historyItems[historyItems.length - 1] : null;

      // Map history to arrays for sparkline
      // Limit to last 10 days to match the table headers (t-9 to t)
      let recentHistory = historyItems.slice(-10);

      // If we have fewer than 10 items, we need to pad with placeholder/zeros 
      // so that the latest data aligns with the rightmost 't' column
      if (recentHistory.length < 10) {
        const paddingCount = 10 - recentHistory.length;
        // Use 0 for hrr/lrr so they render as '--' in getRiskRangeColor/renderRiskRangeCell (logic handles value > 0)
        const padding = Array(paddingCount).fill({ hrr: 0, lrr: 0, date: null });
        recentHistory = [...padding, ...recentHistory];
      }

      const securityRiskRangeHistory = {
        hrr: recentHistory.map(item => item.hrr),
        lrr: recentHistory.map(item => item.lrr),
        // Use the proper close price from the risk range data itself
        prices: recentHistory.map(item => item.close || 0),
        dates: recentHistory.map(item => item.date),
        ath: 0,
        current: riskData || null
      };

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
        signal: riskData?.trend || '--', // Use Trend from risk ranges if available
        riskRangeHistory: securityRiskRangeHistory,
        volatilityMetrics: volMetrics
      };
    });
  }, [prices, priceHistory, riskRanges]);

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

        // Handle Risk Range sorting (sort by presence of data)
        if (sort.key === 'riskRangeHistory') {
          // Sort values: 1 for has data, 0 for no data
          aValue = (a.riskRangeHistory && a.riskRangeHistory.current) ? 1 : 0;
          bValue = (b.riskRangeHistory && b.riskRangeHistory.current) ? 1 : 0;
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

  // Handle metric definition popover on button click
  const handleMetricDefinitionClick = (e, metricKey) => {
    e.stopPropagation(); // Prevent sorting when clicking definition button

    const definition = METRIC_DEFINITIONS[metricKey];
    if (!definition) return;

    // If popover is already open for this metric, close it
    if (openPopover?.metricKey === metricKey) {
      setOpenPopover(null);
    } else {
      setOpenPopover({ metricKey, definition });
    }
  };

  const closePopover = () => {
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
  const renderRiskRangeCell = (riskRangeHistory) => {
    const { hrr, lrr, ath, prices } = riskRangeHistory;
    const lastIndex = dayLabels.length - 1;

    // Use prices directly from risk history object
    // If prices array is missing or empty, fill with nulls
    const closingPrices = Array.isArray(prices) && prices.length > 0
      ? prices.map(p => p > 0 ? parseFloat(p) : null)
      : Array(10).fill(null);

    // Helper to format price
    const formatClosingPrice = (price) => {
      if (price === null || price === undefined || price === 0) return '--';
      // If 4 digits or more on left side (>= 1000), no decimals
      if (Math.abs(price) >= 1000) return price.toFixed(0);
      return price.toFixed(2);
    };

    // Helper to format HRR/LRR
    const formatRangeValue = (value) => {
      if (value === null || value === undefined || value === 0) return '--';
      // If 4 digits or more on left side (>= 1000), no decimals
      if (Math.abs(value) >= 1000) return value.toFixed(0);
      return value.toFixed(2);
    };

    const cellWidth = '42px'; // Increased from 28px
    const lastCellWidth = '46px'; // Increased from 32px
    const cellStyle = (index, color = '#6b7280') => ({
      width: index === lastIndex ? lastCellWidth : cellWidth,
      textAlign: 'center',
      fontSize: '9px',
      borderRight: index < lastIndex ? '1px solid #e5e7eb' : 'none', // Vertical divider
      padding: '0 2px',
      color: color,
      fontWeight: 600,
      backgroundColor: index === lastIndex ? '#eff6ff' : 'transparent', // Highlight 't' column
      borderRadius: index === lastIndex ? '4px' : '0'
    });

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '9px' }}>
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
          <div style={{ display: 'flex' }}> {/* Removed gap to make dividers continuous */}
            {dayLabels.map((label, index) => (
              <div
                key={`label-${index}`}
                style={{
                  width: index === lastIndex ? lastCellWidth : cellWidth,
                  textAlign: 'center',
                  borderRight: index < lastIndex ? '1px solid transparent' : 'none', // Placeholder for alignment
                  padding: '0 2px'
                }}
              >
                <div
                  style={{
                    width: '100%',
                    position: 'relative',
                    backgroundColor: index === lastIndex ? '#eff6ff' : '#f3f4f6', // Highlight 't' label
                    fontWeight: index === lastIndex ? 'bold' : 'normal',
                    color: index === lastIndex ? '#1e40af' : '#6b7280'
                  }}
                  title={formatTradingDate(tradingDays[index])}
                >
                  {label}
                </div>
              </div>
            ))}
          </div>
        </div>
        {/* HRR Row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <span style={{ width: '36px', color: '#6b7280', fontWeight: 500, fontSize: '9px' }}>HRR</span>
          <div style={{ display: 'flex' }}>
            {hrr.map((value, index) => (
              <span
                key={`hrr-${index}`}
                style={cellStyle(index, getRiskRangeColor(value, index > 0 ? hrr[index - 1] : null, index === 0, ath, true))}
                title={`${value}${ath && value > ath ? ' (New ATH!)' : ''}`}
              >
                {formatRangeValue(value)}
              </span>
            ))}
          </div>
        </div>
        {/* Closing Prices Row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <span style={{ width: '36px', color: '#6b7280', fontWeight: 500, fontSize: '9px' }}>Price</span>
          <div style={{ display: 'flex' }}>
            {closingPrices.map((price, index) => (
              <span
                key={`price-${index}`}
                style={{
                  ...cellStyle(index, price !== null ? '#374151' : '#9ca3af'),
                  fontWeight: 600
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
          <div style={{ display: 'flex' }}>
            {lrr.map((value, index) => (
              <span
                key={`lrr-${index}`}
                style={cellStyle(index, getRiskRangeColor(value, index > 0 ? lrr[index - 1] : null, index === 0))}
              >
                {formatRangeValue(value)}
              </span>
            ))}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div style={{ padding: '16px', overflowY: 'auto', height: '100%' }}>
      {/* Search Bar */}
      <div style={{ margin: '0 auto', width: '400px', marginBottom: '8px' }}>
        <input
          type="text"
          placeholder="Search by ticker, name, asset class, factor exposure, benchmark..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          style={{ fontSize: '14px' }}
        />
      </div>

      {/* Filter Summary & Clear */}
      <div className="flex flex-col items-center gap-1 mb-8">
        <Text className="text-sm text-gray-500 dark:text-gray-400 font-medium">
          {`Showing ${filteredSecurities.length} of ${SECURITIES_LIST.length} securities`}
        </Text>
        <button
          onClick={clearAllFilters}
          className="text-xs text-blue-600 hover:text-blue-800 underline decoration-blue-300 underline-offset-2"
        >
          Clear all filters
        </button>
      </div>

      {/* Filter Tags */}
      {/* New Filter Menu Design */}
      <div className="mb-8 pl-2 space-y-6">
        {/* Helper for Filter Row */}
        {[
          {
            title: 'ASSET CLASS',
            icon: (
              <svg width="48" height="48" viewBox="0 0 24 24" className="text-blue-500" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <path d="M12 2 L12 12 L22 12" />
              </svg>
            ),
            options: ['CURRENCY/FX', 'FIXED INCOME', 'EQUITY', 'COMMODITY', 'CRYPTOCURRENCY'],
            activeValues: activeFilters.assetClasses.map(a => a.toUpperCase()),
            onSelect: (val) => {
              // Map back to original casing if needed, or update logic to be case-insensitive
              // The original list was Title Case. We need to match it.
              const originalMap = {
                'CURRENCY/FX': 'Currency/FX',
                'FIXED INCOME': 'Fixed Income',
                'EQUITY': 'Equity',
                'COMMODITY': 'Commodity',
                'CRYPTOCURRENCY': 'Cryptocurrency'
              };
              toggleFilter('assetClasses', originalMap[val]);
            }
          },
          {
            title: 'FACTOR EXPOSURE',
            icon: <SlidersHorizontal size={48} strokeWidth={1.5} className="text-blue-500" />,
            options: ['GROWTH', 'VALUE', 'QUALITY', 'MOMENTUM', 'LOW VOLATILITY'],
            activeValues: activeFilters.factorExposures.map(f => f.toUpperCase()),
            onSelect: (val) => {
              const originalMap = {
                'GROWTH': 'Growth',
                'VALUE': 'Value',
                'QUALITY': 'Quality',
                'MOMENTUM': 'Momentum',
                'LOW VOLATILITY': 'Low Volatility'
              };
              toggleFilter('factorExposures', originalMap[val]);
            }
          },
          {
            title: 'BIAS',
            icon: (
              <svg width="48" height="48" viewBox="0 0 24 24" className="text-blue-500" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M7 4H5c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h2" />
                <line x1="12" y1="4" x2="12" y2="20" />
                <path d="M17 4h2c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2h-2" />
              </svg>
            ),
            options: ['BULLISH', 'BEARISH', 'NEUTRAL'],
            activeValues: activeFilters.biases, // These are already uppercase in state
            onSelect: (val) => {
              toggleFilter('biases', val);
            }
          },
          {
            title: 'QUAD FILTER',
            icon: <LayoutGrid size={48} strokeWidth={1.5} className="text-blue-500" />,
            options: ['QUAD 1', 'QUAD 2', 'QUAD 3', 'QUAD 4'],
            activeValues: selectedQuad ? [`QUAD ${selectedQuad}`] : [],
            onSelect: (val) => {
              const num = parseInt(val.split(' ')[1]);
              setSelectedQuad(selectedQuad === num ? null : num);
            }
          }
        ].map((section, idx) => (
          <div key={idx} className="flex items-start gap-4">
            {/* Icon Column */}
            <div className="pt-1 w-12 flex justify-center">
              {section.icon}
            </div>
            {/* Controls Column */}
            <div className="flex flex-col gap-1 w-full">
              <span className="text-xs font-semibold text-black uppercase tracking-wide">
                {section.title}
              </span>
              <div className="flex w-max">
                {section.options.map((opt, i) => {
                  const isActive = section.activeValues.includes(opt);
                  const isFirst = i === 0;
                  const isLast = i === section.options.length - 1;

                  return (
                    <button
                      key={opt}
                      onClick={() => section.onSelect(opt)}
                      style={{
                        border: '1px solid #3b82f6', // Blue-500
                        padding: '6px 16px',
                        fontSize: '11px',
                        fontWeight: 600,
                        backgroundColor: isActive ? '#dbeafe' : '#ffffff', // blue-100 : white
                        color: isActive ? '#1e3a8a' : '#1e293b', // blue-900 : slate-800
                        borderRightWidth: isLast ? '1px' : '0', // Collapse borders
                        borderRadius: isFirst ? '4px 0 0 4px' : isLast ? '0 4px 4px 0' : '0',
                        cursor: 'pointer',
                        minWidth: '80px',
                        transition: 'background-color 0.1s'
                      }}
                      className="hover:bg-slate-50 relative"
                    >
                      {opt}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        ))}


      </div>

      {/* Data Table */}
      <Card className="dark:bg-gray-800">
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '8px' }}>
            <thead className="bg-white text-slate-800">
              <tr style={{ borderBottom: '1px solid #3b82f6' }}>
                {[
                  { key: 'ticker', label: 'Ticker', icon: <div style={{ height: '24px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '14px', fontWeight: 600 }} className="text-blue-500">ABC</div>, align: 'left', width: '60px' },
                  { key: 'name', label: 'Name', icon: <AlignLeft size={24} className="text-blue-500" />, align: 'left', width: '100px' },
                  {
                    key: 'assetClass', label: 'Asset Class', icon: (
                      <svg width="24" height="24" viewBox="0 0 24 24" className="text-blue-500" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="10" />
                        <path d="M12 2 L12 12 L22 12" />
                      </svg>
                    ), align: 'left', width: '70px'
                  },
                  { key: 'factorExposure', label: 'Factor Exposure', icon: <SlidersHorizontal size={24} className="text-blue-500" />, align: 'left', width: '80px' },
                  {
                    key: 'bias', label: 'Bias', icon: (
                      <svg width="24" height="24" viewBox="0 0 24 24" className="text-blue-500" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M7 4H5c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h2" />
                        <line x1="12" y1="4" x2="12" y2="20" />
                        <path d="M17 4h2c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2h-2" />
                      </svg>
                    ), align: 'center', infoParams: 'trend', width: '80px'
                  },
                  { key: 'riskRangeHistory', label: 'Risk Range', icon: <div style={{ height: '24px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '20px', fontWeight: 600 }} className="text-blue-500">RR</div>, align: 'center', infoParams: 'riskRange', width: '400px' },
                  { key: 'ivolPrem', label: 'IVOL Prem', icon: <Percent size={24} className="text-blue-500" />, align: 'center', infoParams: 'ivolPrem', width: '65px' },
                  { key: 'ttmZScore', label: 'TTM Z-Score', icon: <div style={{ height: '24px', width: '24px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '20px', fontWeight: 600 }} className="text-blue-500">Z</div>, align: 'center', infoParams: 'ttmZScore', width: '55px' },
                  { key: 'ivolZScore', label: 'IVOL High', icon: <Percent size={24} className="text-blue-500" />, align: 'center', infoParams: 'ivolZScore', width: '60px' },
                  { key: 'zScore', label: 'Z-Score', icon: <div style={{ height: '24px', width: '24px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '20px', fontWeight: 600 }} className="text-blue-500">Z</div>, align: 'center', infoParams: 'zScore', width: '50px' },
                  { key: 'beta', label: 'Beta', icon: <div style={{ height: '24px', width: '24px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '20px', fontWeight: 600 }} className="text-blue-500">β</div>, align: 'center', infoParams: 'beta', width: '40px' },

                  { key: 'quadRanking', label: 'Quad', icon: <LayoutGrid size={24} className="text-blue-500" />, align: 'center', infoParams: 'quad', width: '50px' },
                  { key: 'priceChanges', label: 'Price Change', icon: <DollarSign size={24} className="text-blue-500" />, align: 'right', width: '80px' },
                  { key: 'signal', label: 'Sig', icon: <Activity size={24} className="text-blue-500" />, align: 'center', width: '50px' }
                ].map((col, index, arr) => (
                  <th
                    key={col.key}
                    style={{
                      padding: '6px 8px',
                      textAlign: col.align,
                      verticalAlign: 'top',
                      background: '#ffffff',
                      color: '#1e293b',
                      borderRight: index === arr.length - 1 ? 'none' : '1px solid #3b82f6',
                      borderBottom: '1px solid #3b82f6',
                      width: col.width,
                      minWidth: col.width,
                      maxWidth: col.width
                    }}
                    className="group hover:bg-slate-50 transition-colors"
                    onClick={() => handleSort(col.key)}
                  >
                    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: '45px' }}>
                      {/* Top Row: Label + Icon */}
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flex: 1, width: '100%', cursor: 'pointer' }}>
                        {/* Label Area - Fixed Height for 2 lines */}
                        <div style={{
                          height: '18px',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          marginBottom: '2px',
                          width: '100%',
                          textAlign: 'center'
                        }}>
                          <span
                            onClick={(e) => {
                              if (col.infoParams) {
                                e.stopPropagation();
                                handleMetricDefinitionClick(e, col.infoParams);
                              }
                            }}
                            style={{
                              fontSize: '9px',
                              color: '#000000',
                              textTransform: 'uppercase',
                              letterSpacing: '0.05em',
                              lineHeight: '1.2',
                              cursor: col.infoParams ? 'pointer' : 'default',
                              borderBottom: col.infoParams ? '1px dotted #94a3b8' : 'none' // Subtle indicator
                            }}
                            className={col.infoParams ? "hover:text-blue-600 transition-colors" : ""}
                          >
                            {col.label}
                          </span>
                        </div>
                        <div style={{
                          display: 'flex',
                          flexDirection: 'column', // Stack Icon and Arrows
                          justifyContent: 'center',
                          alignItems: 'center',
                          flex: 1,
                          paddingBottom: '2px',
                          cursor: 'pointer'
                        }}
                        >
                          {/* Restored Main Icon */}
                          <div style={{ color: '#1e40af', marginBottom: '2px' }}>
                            {col.icon}
                          </div>

                          {/* Sort Arrows Container - Fixed Height to prevent shift */}
                          <div style={{ height: '14px', minHeight: '14px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                            {(() => {
                              const sortInfo = getSortInfo(col.key);
                              if (sortInfo) {
                                // Sorted State: Number + Single Arrow (Bold)
                                return (
                                  <div style={{ display: 'flex', alignItems: 'center', gap: '2px', color: '#2563eb', fontWeight: 700, fontSize: '10px', lineHeight: 1 }}>
                                    <span>{sortInfo.order}</span>
                                    {sortInfo.direction === 'asc' ? <ArrowUp size={12} strokeWidth={3} /> : <ArrowDown size={12} strokeWidth={3} />}
                                  </div>
                                );
                              }
                              // Unsorted State: Small Gray Up/Down Arrows
                              return (
                                <div style={{ display: 'flex', alignItems: 'center', gap: '3px', color: '#cbd5e1' }}>
                                  <ArrowUp size={10} strokeWidth={2.5} />
                                  <ArrowDown size={10} strokeWidth={2.5} />
                                </div>
                              );
                            })()
                            }
                          </div>
                        </div>
                      </div>

                      {/* Bottom Row: Controls (Sort + Info) - ALWAYS Rendered for uniformity */}
                      <div style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        paddingTop: '2px', // Reduced
                        fontSize: '10px',
                        color: '#64748b',
                        height: '14px', // Reduced height
                        width: '100%'
                      }}>
                        {col.key !== 'signal' && (
                          <>
                            {/* Sort Indicator Moved to Center - Keeping slot empty for alignment if needed, or just removing visual */}
                            <div style={{ minWidth: '20px' }}></div>

                            {/* Menu/Info (Right) - Empty now as Info button is removed */}
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                  </th>
                ))}
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
                      <td style={{ padding: '5px 4px' }} className="dark:text-gray-300">
                        {ASSET_CLASS_NAMES[security.assetClass] || security.assetClass}
                      </td>
                      <td style={{ padding: '5px 4px' }} className="dark:text-gray-300">
                        {security.factorExposure}
                      </td>
                      <td style={{ padding: '5px 4px', textAlign: 'center', fontWeight: 600 }} className="dark:text-gray-300">
                        <span style={{
                          color: security.bias === 'BULLISH' ? '#10b981' :
                            security.bias === 'BEARISH' ? '#ef4444' : '#6b7280'
                        }}>
                          {security.bias}
                        </span>
                      </td>
                      <td style={{ padding: '5px 4px', textAlign: 'center' }} className="dark:text-gray-300">
                        {renderRiskRangeCell(security.riskRangeHistory, security.priceHistory)}
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
                        {(() => {
                          const zScoreColors = getZScoreColor(security.zScore);
                          return (
                            <span
                              style={{
                                display: 'inline-block',
                                fontSize: '7px',
                                padding: '2px 6px',
                                lineHeight: '1.2',
                                borderRadius: '4px',
                                backgroundColor: zScoreColors.bgColor,
                                color: zScoreColors.color,
                                border: `1px solid ${zScoreColors.borderColor}`,
                                fontWeight: 600
                              }}
                            >
                              {formatZScore(security.zScore)}
                            </span>
                          );
                        })()}
                      </td>
                      <td style={{ padding: '5px 4px', textAlign: 'center' }} className="dark:text-gray-300">
                        {security.beta}
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
      </Card >

      {/* Metric Definition Popover */}
      {
        openPopover && (
          <MetricDefinitionPopover
            metricKey={openPopover.metricKey}
            definition={openPopover.definition}
            onClose={closePopover}
          />
        )
      }
    </div >
  );
};

export default SecuritiesUniverse;

