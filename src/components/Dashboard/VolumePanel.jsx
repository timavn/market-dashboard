import React, { useState, useEffect, useRef } from 'react';
import { Card, Text, Flex, Badge } from '@tremor/react';
import PopoverSelect from '../common/PopoverSelect';
import { ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ReferenceLine } from 'recharts';
import { SECURITIES_LIST, ASSET_CLASS_NAMES } from '../../constants/securitiesList';
import { MarketDataService } from '../../services/api/marketDataService';

// Map tickers to their volatility indicators
const getVolatilityTicker = (ticker) => {
  const tickerUpper = ticker.toUpperCase();
  
  // Equity indices and SP500-related → VIX
  if (tickerUpper === 'SPY' || tickerUpper === 'SPX' || tickerUpper === 'QQQ' || 
      tickerUpper === 'IWM' || tickerUpper === 'DIA' || tickerUpper.startsWith('XL')) {
    return 'VIX';
  }
  
  // Treasuries → MOVE
  if (tickerUpper.startsWith('UST') || tickerUpper === 'TLT' || tickerUpper === 'IEF' || 
      tickerUpper === 'SHY' || tickerUpper === 'TBT') {
    return 'MOVE';
  }
  
  // Gold → GVZ
  if (tickerUpper === 'GLD' || tickerUpper === 'GOLD' || tickerUpper === 'GC=F') {
    return 'GVZ';
  }
  
  // Euro → EVZ
  if (tickerUpper === 'EUR/USD' || tickerUpper === 'FXE' || tickerUpper === 'EUFX') {
    return 'EVZ';
  }
  
  // Russian Market → RVX
  if (tickerUpper === 'RSX' || tickerUpper === 'ERUS') {
    return 'RVX';
  }
  
  // Treasury Volatility → TYVIX
  if (tickerUpper === 'TYVIX') {
    return 'TYVIX';
  }
  
  // Default to VIX for equities, MOVE for fixed income
  const security = SECURITIES_LIST.find(s => s.ticker === tickerUpper);
  if (security) {
    if (security.assetClass === 'fixedIncome') {
      return 'MOVE';
    }
    if (security.assetClass === 'equity') {
      return 'VIX';
    }
  }
  
  return 'VIX'; // Default fallback
};

// Chart indicator configuration - extensible for future indicators
const CHART_INDICATORS = {
  showRiskRanges: true,
  showMovingAverages: false, // Future: SMA, EMA
  showSupportResistance: false, // Future: Support/Resistance levels
  showTrendLines: false, // Future: Trend line overlays
};

const SecuritiesPanel = ({ selectedTicker: propSelectedTicker }) => {
  const [selectedAssetClass, setSelectedAssetClass] = useState('equity');
  const [selectedTicker, setSelectedTicker] = useState('SPY');
  const [productName, setProductName] = useState('');
  const [selectedDateRange, setSelectedDateRange] = useState('1M');
  const [fullHistory, setFullHistory] = useState([]); // Store complete history
  const [chartData, setChartData] = useState([]); // Data currently displayed in chart
  const [loading, setLoading] = useState(false);
  const [riskRanges, setRiskRanges] = useState({ lrr: null, hrr: null });
  const [searchQuery, setSearchQuery] = useState('');
  const [showSearchResults, setShowSearchResults] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const searchInputRef = useRef(null);
  const searchResultsRef = useRef(null);
  const [metrics, setMetrics] = useState({
    closing: 0.00,
    current: 0.00,
    lrr: 0.00,
    trr: 0.00,
    dayOverDay: { percent: 0.00, bps: 0 },
    fiveDayChange: { percent: null, bps: null },
    weekOverWeek: { percent: 0.00, bps: 0 },
    monthOverMonth: { percent: 0.00, bps: 0 },
    threeMonthOverMonth: { percent: 0.00, bps: 0 },
    sixMonthOverMonth: { percent: 0.00, bps: 0 },
    qtdChange: { percent: null, bps: null },
    ytdChange: { percent: null, bps: null },
    yearOverYear: { percent: 0.00, bps: 0 },
    fiftyTwoWeekHigh: null,
    fiftyTwoWeekLow: null,
    vsFiftyTwoWeekHigh: { percent: null, bps: null },
    vsFiftyTwoWeekLow: { percent: null, bps: null },
    si: 0.00, // Short Interest
    hhhl: '--', // Higher High / Higher Low
    lhll: '--', // Lower High / Lower Low
    vol: 0.00, // Volatility indicator value
    volTicker: 'VIX', // Volatility ticker name
    zScore: 0.00, // Z-score
    beta: '--' // Beta (placeholder)
  });

  // Get available tickers for selected asset class
  const getAvailableTickers = () => {
    return SECURITIES_LIST.filter(security => security.assetClass === selectedAssetClass);
  };

  // Filter securities based on search query - searches entire universe regardless of asset class
  const filteredSecurities = React.useMemo(() => {
    if (!searchQuery.trim()) {
      return [];
    }
    const query = searchQuery.toLowerCase().trim();
    // Search across ALL securities in the universe, not filtered by selectedAssetClass
    return SECURITIES_LIST.filter(security => 
      security.ticker.toLowerCase().includes(query) ||
      security.name.toLowerCase().includes(query)
    ).slice(0, 15); // Increased to 15 results to show more options
  }, [searchQuery]);

  // Update ticker and asset class when prop changes
  useEffect(() => {
    if (propSelectedTicker) {
      const security = SECURITIES_LIST.find(s => s.ticker.toUpperCase() === propSelectedTicker.toUpperCase());
      if (security) {
        setSelectedTicker(security.ticker); // Use exact ticker from SECURITIES_LIST
        setSelectedAssetClass(security.assetClass);
      }
    }
  }, [propSelectedTicker]);

  // Update product name when ticker changes
  useEffect(() => {
    const security = SECURITIES_LIST.find(s => s.ticker === selectedTicker);
    if (security) {
      setProductName(security.name);
      // Update search query to show current selection
      setSearchQuery(`${security.ticker} - ${security.name}`);
    }
  }, [selectedTicker]);

  // Handle security selection from search
  const handleSecuritySelect = (security) => {
    setSelectedTicker(security.ticker);
    setSelectedAssetClass(security.assetClass);
    setSearchQuery(`${security.ticker} - ${security.name}`);
    setShowSearchResults(false);
    setHighlightedIndex(-1);
    searchInputRef.current?.blur();
  };

  // Filter tickers when asset class changes
  useEffect(() => {
    const availableTickers = getAvailableTickers();
    if (availableTickers.length > 0) {
      // If current ticker is not in new asset class, select first available
      if (!availableTickers.find(t => t.ticker === selectedTicker)) {
        setSelectedTicker(availableTickers[0].ticker);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAssetClass]);

  // Fetch volatility data
  useEffect(() => {
    const fetchVolatility = async () => {
      if (!selectedTicker) return;
      
      const volTicker = getVolatilityTicker(selectedTicker);
      try {
        const quotes = await MarketDataService.getQuotes([volTicker]);
        const volQuote = quotes[volTicker.toUpperCase()];
        if (volQuote && volQuote.price) {
          setMetrics(prev => ({
            ...prev,
            vol: parseFloat(volQuote.price),
            volTicker: volTicker
          }));
        } else {
          setMetrics(prev => ({
            ...prev,
            vol: 0.00,
            volTicker: volTicker
          }));
        }
      } catch (error) {
        console.error('Error fetching volatility data:', error);
        setMetrics(prev => ({
          ...prev,
          vol: 0.00,
          volTicker: volTicker
        }));
      }
    };

    fetchVolatility();
  }, [selectedTicker]);

  // Fetch risk ranges when ticker changes
  useEffect(() => {
    const fetchRiskRanges = async () => {
      if (!selectedTicker) return;
      
      try {
        const riskData = await MarketDataService.getRiskRanges([selectedTicker]);
        const tickerUpper = selectedTicker.toUpperCase();
        const tickerRiskData = riskData[tickerUpper];
        
        if (tickerRiskData) {
          // Handle treasury yields which are percentages
          const isTreasury = selectedTicker.startsWith('UST');
          let lrr = tickerRiskData.lrr ? parseFloat(tickerRiskData.lrr) : null;
          let hrr = tickerRiskData.hrr ? parseFloat(tickerRiskData.hrr) : null;
          
          // For treasury yields, they're already in percentage format, no conversion needed
          setRiskRanges({
            lrr: lrr,
            hrr: hrr
          });
        } else {
          setRiskRanges({ lrr: null, hrr: null });
        }
      } catch (error) {
        console.error('Error fetching risk ranges:', error);
        setRiskRanges({ lrr: null, hrr: null });
      }
    };

    fetchRiskRanges();
  }, [selectedTicker]);

  // Fetch data when ticker changes (ONLY when ticker changes)
  useEffect(() => {
    const fetchData = async () => {
      if (!selectedTicker) return;
      
      setLoading(true);
      try {
        // Always fetch 365 days of data for complete metrics calculation (Y/Y needs full year)
        // The selected timeframe will only affect chart display, not data fetching
        const daysToFetch = 365;
        
        console.log(`[SecuritiesPanel] Fetching ${daysToFetch} days of historical data for ${selectedTicker}`);
        
        // Fetch historical price data
        const historicalResponse = await MarketDataService.getHistoricalData(selectedTicker, daysToFetch);
        const historicalData = historicalResponse.data || [];
        
        console.log(`[SecuritiesPanel] Received ${historicalData.length} data points for ${selectedTicker}`);
        
        if (historicalData.length > 0) {
          console.log(`[SecuritiesPanel] Sample data point:`, historicalData[0]);
          console.log(`[SecuritiesPanel] Price range in data:`, {
            min: Math.min(...historicalData.map(d => d.close || d.price || 0)),
            max: Math.max(...historicalData.map(d => d.close || d.price || 0)),
            first: historicalData[0]?.close || historicalData[0]?.price,
            last: historicalData[historicalData.length - 1]?.close || historicalData[historicalData.length - 1]?.price
          });
          
          // Transform API response to chart data format
          const transformedData = historicalData.map((item, index) => {
            // Handle date format - DynamoDB returns YYYY-MM-DD format
            let dateStr = item.date;
            let dateObj;
            
            if (typeof dateStr === 'string') {
              // Parse YYYY-MM-DD format
              if (dateStr.match(/^\d{4}-\d{2}-\d{2}$/)) {
                dateObj = new Date(dateStr + 'T00:00:00');
              } else if (dateStr.includes('T')) {
                dateObj = new Date(dateStr);
              } else {
                dateObj = new Date(dateStr);
              }
              
              // Base date string for logic, formatted display will depend on dateRange
              dateStr = dateObj.toISOString();
            } else {
              dateStr = 'Unknown';
            }
            
            const price = item.close || item.price || 0;
            if (price === 0 || isNaN(price)) {
              console.warn(`[SecuritiesPanel] Invalid price data for ${selectedTicker} on ${item.date}:`, item);
            }
            
            return {
              date: dateStr, // Use standard format for now
              dateObj: dateObj || new Date(item.date),
              price: parseFloat(price),
              volume: item.volume || 0,
            };
          });
          
          setFullHistory(transformedData);
          calculateMetrics(transformedData, riskRanges); // Calculate metrics on full history
        } else {
          console.warn(`[SecuritiesPanel] No historical data available for ${selectedTicker}, using mock data`);
          // Fallback to mock data if no historical data available
          const mockData = generateMockChartData(365);
          // Add dateObj for compatibility
          const processedMockData = mockData.map(d => ({
            ...d,
            dateObj: d.dateValue || new Date(d.date)
          }));
          setFullHistory(processedMockData);
          calculateMetrics(processedMockData, riskRanges);
        }
      } catch (error) {
        console.error(`[SecuritiesPanel] Error fetching historical data for ${selectedTicker}:`, error);
        // Fallback to mock data on error
        const mockData = generateMockChartData(365);
        const processedMockData = mockData.map(d => ({
            ...d,
            dateObj: d.dateValue || new Date(d.date)
        }));
        setFullHistory(processedMockData);
        calculateMetrics(processedMockData, riskRanges);
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [selectedTicker]); // Only run when ticker changes, not date range

  // Filter chart data when date range or full history changes (local filtering)
  useEffect(() => {
    if (!fullHistory || fullHistory.length === 0) return;

    // Add risk ranges to data points for chart display
    const dataWithRiskRanges = fullHistory.map(item => {
        // Format date based on selected range
        const isIntradayView = selectedDateRange === '1D';
        let displayDate;
        
        if (isIntradayView) {
             // For 1D, show time (will need intraday data in future)
             // For now, just show the date since we only have daily data
             displayDate = item.dateObj.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
        } else {
             displayDate = item.dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        }

        return {
            ...item,
            date: displayDate, // Update display date
            dateValue: item.dateObj,
            lrr: riskRanges.lrr,
            hrr: riskRanges.hrr
        };
    });

    const dateRangeMap = {
        '1D': 1,
        '5D': 5,
        '1W': 7,
        '1M': 30,
        '3M': 90,
        '6M': 180,
        '1Y': 365
    };
    const displayDays = dateRangeMap[selectedDateRange] || 30;
    const isIntradayView = selectedDateRange === '1D';
    
    let filteredData;
    if (isIntradayView) {
        // For 1D, show only the most recent day's data
        // Since we only have daily data, show the last 1-2 days
        filteredData = dataWithRiskRanges.slice(-2); // Show last 2 days for 1D (will be improved with intraday data)
        console.log(`[SecuritiesPanel] 1D view: showing last ${filteredData.length} data points`);
    } else {
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - displayDays);
        
        filteredData = dataWithRiskRanges.filter(item => {
            return item.dateObj >= cutoffDate;
        });
    }
    
    console.log(`[SecuritiesPanel] Filtered to ${filteredData.length} data points for ${selectedDateRange} display`);
    setChartData(filteredData);
    
    // Re-calculate metrics if risk ranges changed (since metrics depends on risk ranges)
    // Note: Usually metrics calculated on full history, but risk ranges are part of state
    calculateMetrics(fullHistory.map(item => ({...item, dateValue: item.dateObj})), riskRanges);

  }, [selectedDateRange, fullHistory, riskRanges]);

  // Generate mock chart data
  const generateMockChartData = (days) => {
    const data = [];
    let basePrice = 450;
    let baseVolume = 50000000;
    
    // Find max volume for normalization
    const volumes = [];
    for (let i = days; i >= 0; i--) {
      const volumeVariation = 0.7 + Math.random() * 0.6;
      volumes.push(baseVolume * volumeVariation);
    }
    const maxVolume = Math.max(...volumes);
    
    // Normalize volume to 0-100 range to overlay on price scale (which is ~400-500)
    // Then scale to match price range visually
    const priceRange = 100; // Approximate price range
    const volumeScaleFactor = priceRange / maxVolume;
    
    for (let i = days; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      
      // Simulate price movement
      const priceChange = (Math.random() - 0.5) * 2;
      basePrice += priceChange;
      
      // Simulate volume variation
      const volumeVariation = 0.7 + Math.random() * 0.6;
      const rawVolume = baseVolume * volumeVariation;
      const normalizedVolume = rawVolume * volumeScaleFactor;
      
      data.push({
        date: date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        dateValue: date, // Keep original date for filtering
        price: parseFloat(basePrice.toFixed(2)),
        volume: parseFloat(normalizedVolume.toFixed(2)), // Normalized volume to overlay on price axis
        lrr: riskRanges.lrr,
        hrr: riskRanges.hrr
      });
    }
    
    return data;
  };

  // Calculate metrics from chart data
  const calculateMetrics = (data, riskRangesData = riskRanges) => {
    if (!data || data.length === 0) {
      console.warn('[SecuritiesPanel] No data available for metrics calculation');
      return;
    }

    // Ensure data is sorted by date (most recent last)
    const sortedData = [...data].sort((a, b) => {
      const dateA = a.dateValue || a.dateObj || new Date(a.date);
      const dateB = b.dateValue || b.dateObj || new Date(b.date);
      return dateA - dateB;
    });

    const latest = sortedData[sortedData.length - 1];
    const previous = sortedData.length > 1 ? sortedData[sortedData.length - 2] : latest;
    
    // Calculate indices for different time periods
    const current = latest.price;
    const closing = previous.price;

    // Helper to find data point N days ago
    const findDataPointDaysAgo = (days) => {
      if (sortedData.length < days + 1) {
        return null; // Not enough data
      }
      const targetIndex = Math.max(0, sortedData.length - 1 - days);
      return sortedData[targetIndex];
    };

    // Calculate percentage changes with null handling
    const calculateChange = (current, previous) => {
      if (!previous || previous === 0 || !current || current === 0) {
        return { percent: null, bps: null };
      }
      const percent = ((current - previous) / previous) * 100;
      const bps = percent * 100;
      return { percent: parseFloat(percent.toFixed(2)), bps: Math.round(bps) };
    };

    // Get data points for different periods
    const fiveDaysAgo = findDataPointDaysAgo(5);
    const weekAgo = findDataPointDaysAgo(7);
    const monthAgo = findDataPointDaysAgo(30);
    const threeMonthAgo = findDataPointDaysAgo(90);
    const sixMonthAgo = findDataPointDaysAgo(180);
    const yearAgo = findDataPointDaysAgo(365);

    // Calculate quarter start date
    const now = new Date();
    const currentQuarter = Math.floor(now.getMonth() / 3);
    const quarterStart = new Date(now.getFullYear(), currentQuarter * 3, 1);
    quarterStart.setHours(0, 0, 0, 0);
    
    // Find data point closest to quarter start
    const qtdDataPoint = sortedData.find(item => {
      const itemDate = item.dateValue || item.dateObj || new Date(item.date);
      return itemDate >= quarterStart;
    }) || sortedData[0]; // Fallback to first available data point

    // Calculate year start date (January 1st)
    const yearStart = new Date(now.getFullYear(), 0, 1);
    yearStart.setHours(0, 0, 0, 0);
    
    // Find data point closest to year start
    const ytdDataPoint = sortedData.find(item => {
      const itemDate = item.dateValue || item.dateObj || new Date(item.date);
      return itemDate >= yearStart;
    }) || sortedData[0]; // Fallback to first available data point

    // Calculate 52-week high and low from all data
    const prices = sortedData.map(item => item.price).filter(p => p > 0);
    const fiftyTwoWeekHigh = prices.length > 0 ? Math.max(...prices) : null;
    const fiftyTwoWeekLow = prices.length > 0 ? Math.min(...prices) : null;

    // Calculate vs. 52-week high/low percentages
    const vsFiftyTwoWeekHigh = fiftyTwoWeekHigh && current ? calculateChange(current, fiftyTwoWeekHigh) : { percent: null, bps: null };
    const vsFiftyTwoWeekLow = fiftyTwoWeekLow && current ? calculateChange(current, fiftyTwoWeekLow) : { percent: null, bps: null };

    // Calculate changes (returns null if insufficient data)
    const dayOverDay = calculateChange(current, closing);
    const fiveDayChange = fiveDaysAgo ? calculateChange(current, fiveDaysAgo.price) : { percent: null, bps: null };
    const weekOverWeek = weekAgo ? calculateChange(current, weekAgo.price) : { percent: null, bps: null };
    const monthOverMonth = monthAgo ? calculateChange(current, monthAgo.price) : { percent: null, bps: null };
    const threeMonthOverMonth = threeMonthAgo ? calculateChange(current, threeMonthAgo.price) : { percent: null, bps: null };
    const sixMonthOverMonth = sixMonthAgo ? calculateChange(current, sixMonthAgo.price) : { percent: null, bps: null };
    const qtdChange = qtdDataPoint ? calculateChange(current, qtdDataPoint.price) : { percent: null, bps: null };
    const ytdChange = ytdDataPoint ? calculateChange(current, ytdDataPoint.price) : { percent: null, bps: null };
    const yearOverYear = yearAgo ? calculateChange(current, yearAgo.price) : { percent: null, bps: null };

    // Calculate Z-Score (20-day, 60-day, 252-day)
    const calculateZScore = (currentPrice, prices, period = 20) => {
      if (!prices || prices.length < period) return null;
      
      const recentPrices = prices.slice(-period);
      const mean = recentPrices.reduce((a, b) => a + b, 0) / recentPrices.length;
      const variance = recentPrices.reduce((sum, price) => {
        return sum + Math.pow(price - mean, 2);
      }, 0) / recentPrices.length;
      const stdDev = Math.sqrt(variance);
      
      if (stdDev === 0) return 0;
      return (currentPrice - mean) / stdDev;
    };

    const allPrices = sortedData.map(item => item.price).filter(p => p > 0);
    const zScore20 = calculateZScore(current, allPrices, 20);
    const zScore60 = calculateZScore(current, allPrices, 60);
    const zScore252 = calculateZScore(current, allPrices, 252);
    // Use 20-day Z-score as default (most responsive)
    const zScore = zScore20 !== null ? zScore20 : (zScore60 !== null ? zScore60 : zScore252);

    // Enhanced diagnostic logging
    const firstDate = sortedData[0]?.dateValue || sortedData[0]?.dateObj || sortedData[0]?.date;
    const lastDate = sortedData[sortedData.length - 1]?.dateValue || sortedData[sortedData.length - 1]?.dateObj || sortedData[sortedData.length - 1]?.date;
    const daysBetween = firstDate && lastDate ? Math.floor((new Date(lastDate) - new Date(firstDate)) / (1000 * 60 * 60 * 24)) : 0;
    
    console.log(`[SecuritiesPanel] Metrics calculated:`, {
      dataPoints: sortedData.length,
      dateRange: {
        first: firstDate,
        last: lastDate,
        daysBetween
      },
      dataAvailability: {
        requiredFor3M: 91,
        requiredFor6M: 181,
        requiredFor1Yr: 366,
        has3M: sortedData.length >= 91,
        has6M: sortedData.length >= 181,
        has1Yr: sortedData.length >= 366,
        actualCount: sortedData.length
      },
      current,
      closing,
      weekAgo: weekAgo?.price || 'N/A',
      monthAgo: monthAgo?.price || 'N/A',
      threeMonthAgo: threeMonthAgo?.price || 'N/A',
      sixMonthAgo: sixMonthAgo?.price || 'N/A',
      yearAgo: yearAgo?.price || 'N/A',
      zScore: {
        zScore20: zScore20?.toFixed(2) || 'N/A',
        zScore60: zScore60?.toFixed(2) || 'N/A',
        zScore252: zScore252?.toFixed(2) || 'N/A',
        using: zScore?.toFixed(2) || 'N/A'
      }
    });

    setMetrics(prev => ({
      ...prev,
      closing: parseFloat(closing.toFixed(2)),
      current: parseFloat(current.toFixed(2)),
      lrr: riskRangesData.lrr || 0.00,
      trr: riskRangesData.hrr || 0.00, // TRR is HRR (higher risk range)
      dayOverDay,
      fiveDayChange,
      weekOverWeek,
      monthOverMonth,
      threeMonthOverMonth,
      sixMonthOverMonth,
      qtdChange,
      ytdChange,
      yearOverYear,
      fiftyTwoWeekHigh,
      fiftyTwoWeekLow,
      vsFiftyTwoWeekHigh,
      vsFiftyTwoWeekLow,
      vsFiftyTwoWeekLow,
      zScore: zScore !== null ? parseFloat(zScore.toFixed(2)) : 0.00
    }));
  };

  const assetClassOptions = ['fixedIncome', 'equity', 'currency', 'commodity', 'crypto'];
  const availableTickers = getAvailableTickers();
  const dateRangeOptions = [
    { value: '1D', label: '1D' },
    { value: '5D', label: '5D' },
    { value: '1W', label: '1W' },
    { value: '1M', label: '1M' },
    { value: '3M', label: '3M' },
    { value: '6M', label: '6M' },
    { value: '1Y', label: '1Y' }
  ];

  const formatMetricValue = (value, percent, bps) => {
    if (percent === null || percent === undefined) {
      return '--';
    }
    const sign = percent >= 0 ? '+' : '';
    return `${sign}${percent.toFixed(2)}%`;
  };

  const getChangeColor = (percent) => {
    if (percent === null || percent === undefined) {
      return 'gray';
    }
    return percent >= 0 ? 'emerald' : 'rose';
  };

  return (
    <Card className="p-2 dark:bg-gray-800" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Top Controls Row */}
      <div className="flex justify-between items-center mb-4">
        <div className="flex items-center gap-2">
          {/* Asset Class Selector (popover) */}
          <PopoverSelect
            value={selectedAssetClass}
            options={assetClassOptions.map(a => ({ value: a, label: ASSET_CLASS_NAMES[a] }))}
            onChange={setSelectedAssetClass}
          />

          {/* Ticker Selector (popover) */}
          <PopoverSelect
            value={selectedTicker}
            options={availableTickers.map(t => ({ value: t.ticker, label: t.name }))}
            onChange={setSelectedTicker}
          />

          {/* Securities Search Box */}
          <div className="relative" style={{ width: '200px' }}>
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              placeholder="Search securities..."
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setShowSearchResults(true);
                setHighlightedIndex(-1);
              }}
              onFocus={() => {
                if (searchQuery.trim()) {
                  setShowSearchResults(true);
                }
              }}
              onBlur={() => {
                // Delay hiding to allow click on results
                setTimeout(() => {
                  setShowSearchResults(false);
                  setHighlightedIndex(-1);
                }, 200);
              }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setHighlightedIndex(prev => 
                    prev < filteredSecurities.length - 1 ? prev + 1 : prev
                  );
                  setShowSearchResults(true);
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setHighlightedIndex(prev => prev > 0 ? prev - 1 : -1);
                } else if (e.key === 'Enter' && highlightedIndex >= 0) {
                  e.preventDefault();
                  const selected = filteredSecurities[highlightedIndex];
                  if (selected) {
                    handleSecuritySelect(selected);
                  }
                } else if (e.key === 'Escape') {
                  setShowSearchResults(false);
                  setSearchQuery('');
                  searchInputRef.current?.blur();
                }
              }}
              className="px-3 py-2 text-sm border border-gray-300 rounded-none bg-white dark:bg-gray-700 dark:border-gray-600 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-0 w-full"
            />
            {showSearchResults && filteredSecurities.length > 0 && (
              <div
                ref={searchResultsRef}
                className="absolute z-50 w-full mt-1 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 shadow-lg max-h-60 overflow-y-auto"
                style={{ top: '100%' }}
              >
                {filteredSecurities.map((security, index) => (
                  <div
                    key={security.ticker}
                    onClick={() => handleSecuritySelect(security)}
                    className={`px-3 py-2 cursor-pointer text-sm ${
                      index === highlightedIndex
                        ? 'bg-blue-100 dark:bg-blue-900/30'
                        : 'hover:bg-gray-100 dark:hover:bg-gray-700'
                    }`}
                    onMouseEnter={() => setHighlightedIndex(index)}
                  >
                    <div className="flex items-center justify-between">
                      <div className="font-semibold dark:text-white">{security.ticker}</div>
                      <div className="text-xs text-gray-500 dark:text-gray-500 ml-2">
                        {ASSET_CLASS_NAMES[security.assetClass] || security.assetClass}
                      </div>
                    </div>
                    <div className="text-xs text-gray-600 dark:text-gray-400 truncate">
                      {security.name}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
        {/* Date Range Selector (popover) moved to right side (top-right) */}
        <div>
          <PopoverSelect
            value={selectedDateRange}
            options={dateRangeOptions}
            onChange={setSelectedDateRange}
            buttonClassName="w-20 justify-center"
          />
        </div>
      </div>

      {/* Performance Metrics Table */}
      <div className="mb-4 overflow-x-auto">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b border-gray-300 dark:border-gray-600">
              <th className="px-2 py-1 text-left font-semibold dark:text-white">1D % Chg</th>
              <th className="px-2 py-1 text-left font-semibold dark:text-white">5D % Chg</th>
              <th className="px-2 py-1 text-left font-semibold dark:text-white">1M % Chg</th>
              <th className="px-2 py-1 text-left font-semibold dark:text-white">3M % Chg</th>
              <th className="px-2 py-1 text-left font-semibold dark:text-white">6M % Chg</th>
              <th className="px-2 py-1 text-left font-semibold dark:text-white">QTD % Chg</th>
              <th className="px-2 py-1 text-left font-semibold dark:text-white">YTD % Chg</th>
              <th className="px-2 py-1 text-left font-semibold dark:text-white">1Yr % Chg</th>
              <th className="px-2 py-1 text-left font-semibold dark:text-white">vs. 52-Wk High</th>
              <th className="px-2 py-1 text-left font-semibold dark:text-white">vs. 52-Wk Low</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              {/* 1D % Chg */}
              <td className={`px-2 py-1 text-left font-medium ${
                metrics.dayOverDay.percent === null || metrics.dayOverDay.percent === 0
                  ? 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300'
                  : metrics.dayOverDay.percent > 0
                  ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300'
                  : 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300'
              }`}>
                {formatMetricValue(metrics.current, metrics.dayOverDay.percent, metrics.dayOverDay.bps)}
              </td>
              {/* 5D % Chg */}
              <td className={`px-2 py-1 text-left font-medium ${
                metrics.fiveDayChange.percent === null || metrics.fiveDayChange.percent === 0
                  ? 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300'
                  : metrics.fiveDayChange.percent > 0
                  ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300'
                  : 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300'
              }`}>
                {formatMetricValue(metrics.current, metrics.fiveDayChange.percent, metrics.fiveDayChange.bps)}
              </td>
              {/* 1M % Chg */}
              <td className={`px-2 py-1 text-center font-medium ${
                metrics.monthOverMonth.percent === null || metrics.monthOverMonth.percent === 0
                  ? 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300'
                  : metrics.monthOverMonth.percent > 0
                  ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300'
                  : 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300'
              }`}>
                {formatMetricValue(metrics.current, metrics.monthOverMonth.percent, metrics.monthOverMonth.bps)}
              </td>
              {/* 3M % Chg */}
              <td className={`px-2 py-1 text-center font-medium ${
                metrics.threeMonthOverMonth.percent === null || metrics.threeMonthOverMonth.percent === 0
                  ? 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300'
                  : metrics.threeMonthOverMonth.percent > 0
                  ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300'
                  : 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300'
              }`}>
                {formatMetricValue(metrics.current, metrics.threeMonthOverMonth.percent, metrics.threeMonthOverMonth.bps)}
              </td>
              {/* 6M % Chg */}
              <td className={`px-2 py-1 text-center font-medium ${
                metrics.sixMonthOverMonth.percent === null || metrics.sixMonthOverMonth.percent === 0
                  ? 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300'
                  : metrics.sixMonthOverMonth.percent > 0
                  ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300'
                  : 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300'
              }`}>
                {formatMetricValue(metrics.current, metrics.sixMonthOverMonth.percent, metrics.sixMonthOverMonth.bps)}
              </td>
              {/* QTD % Chg */}
              <td className={`px-2 py-1 text-center font-medium ${
                metrics.qtdChange.percent === null || metrics.qtdChange.percent === 0
                  ? 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300'
                  : metrics.qtdChange.percent > 0
                  ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300'
                  : 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300'
              }`}>
                {formatMetricValue(metrics.current, metrics.qtdChange.percent, metrics.qtdChange.bps)}
              </td>
              {/* YTD % Chg */}
              <td className={`px-2 py-1 text-center font-medium ${
                metrics.ytdChange.percent === null || metrics.ytdChange.percent === 0
                  ? 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300'
                  : metrics.ytdChange.percent > 0
                  ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300'
                  : 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300'
              }`}>
                {formatMetricValue(metrics.current, metrics.ytdChange.percent, metrics.ytdChange.bps)}
              </td>
              {/* 1Yr % Chg */}
              <td className={`px-2 py-1 text-center font-medium ${
                metrics.yearOverYear.percent === null || metrics.yearOverYear.percent === 0
                  ? 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300'
                  : metrics.yearOverYear.percent > 0
                  ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300'
                  : 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300'
              }`}>
                {formatMetricValue(metrics.current, metrics.yearOverYear.percent, metrics.yearOverYear.bps)}
              </td>
              {/* vs. 52-Wk High */}
              <td className={`px-2 py-1 text-center font-medium ${
                metrics.vsFiftyTwoWeekHigh.percent === null || metrics.vsFiftyTwoWeekHigh.percent === 0
                  ? 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300'
                  : metrics.vsFiftyTwoWeekHigh.percent > 0
                  ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300'
                  : 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300'
              }`}>
                {formatMetricValue(metrics.current, metrics.vsFiftyTwoWeekHigh.percent, metrics.vsFiftyTwoWeekHigh.bps)}
              </td>
              {/* vs. 52-Wk Low */}
              <td className={`px-2 py-1 text-center font-medium ${
                metrics.vsFiftyTwoWeekLow.percent === null || metrics.vsFiftyTwoWeekLow.percent === 0
                  ? 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300'
                  : metrics.vsFiftyTwoWeekLow.percent > 0
                  ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300'
                  : 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300'
              }`}>
                {formatMetricValue(metrics.current, metrics.vsFiftyTwoWeekLow.percent, metrics.vsFiftyTwoWeekLow.bps)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Chart Area */}
      <div className="flex-1 dark:text-white" style={{ minHeight: 0 }}>
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <div className="animate-spin rounded-full h-8 w-8 border-2 border-blue-500 border-t-transparent"></div>
            <Text className="ml-3 dark:text-gray-300">Loading chart data...</Text>
          </div>
        ) : chartData.length > 0 ? (
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis 
                dataKey="date" 
                tick={{ fontSize: 10 }}
                angle={selectedDateRange === '1D' ? 0 : -45}
                textAnchor={selectedDateRange === '1D' ? 'middle' : 'end'}
                height={selectedDateRange === '1D' ? 40 : 60}
                padding={{ bottom: 10 }}
                interval={selectedDateRange === '1D' ? 0 : 'preserveStartEnd'}
              />
              <YAxis 
                tick={{ fontSize: 10 }}
                label={{ value: 'Price', angle: -90, position: 'insideLeft' }}
              />
              <Tooltip 
                contentStyle={{ 
                  backgroundColor: 'white',
                  border: '1px solid #e5e7eb',
                  borderRadius: '4px',
                  fontSize: '12px'
                }}
                labelStyle={{ color: '#374151' }}
              />
              {/* Risk Range Overlays - Conditionally rendered based on configuration */}
              {CHART_INDICATORS.showRiskRanges && riskRanges.lrr !== null && (
                <ReferenceLine 
                  y={riskRanges.lrr} 
                  stroke="#ef4444" 
                  strokeDasharray="5 5"
                  strokeWidth={2}
                  label={{ 
                    value: `LRR: ${riskRanges.lrr.toFixed(2)}`, 
                    position: "insideTopLeft", 
                    fill: "#ef4444", 
                    fontSize: 11,
                    fontWeight: 600
                  }}
                />
              )}
              {CHART_INDICATORS.showRiskRanges && riskRanges.hrr !== null && (
                <ReferenceLine 
                  y={riskRanges.hrr} 
                  stroke="#10b981" 
                  strokeDasharray="5 5"
                  strokeWidth={2}
                  label={{ 
                    value: `HRR: ${riskRanges.hrr.toFixed(2)}`, 
                    position: "insideTopRight", 
                    fill: "#10b981", 
                    fontSize: 11,
                    fontWeight: 600
                  }}
                />
              )}
              {/* Future: Add more indicators here based on CHART_INDICATORS config */}
              {/* Example: Moving averages, support/resistance, trend lines */}
              <Bar 
                dataKey="volume" 
                fill="#3b82f6" 
                opacity={0.6}
                name="Volume"
              />
              <Line 
                type="monotone" 
                dataKey="price" 
                stroke="#10b981" 
                strokeWidth={2}
                dot={false}
                name="Price"
              />
            </ComposedChart>
          </ResponsiveContainer>
        ) : (
          <div className="flex items-center justify-center h-full">
            <Text className="text-gray-500 dark:text-gray-400">No chart data available</Text>
          </div>
        )}
      </div>

      {/* Bottom Metrics Bar */}
      <Flex className="flex-wrap gap-2 text-xs dark:text-white">
        <div className="flex items-center gap-1">
          <Text className="font-semibold dark:text-white">Closing:</Text>
          <Text className="dark:text-gray-300">{metrics.closing.toFixed(2)}</Text>
        </div>
        <div className="flex items-center gap-1">
          <Text className="font-semibold dark:text-white">Current:</Text>
          <Text className="dark:text-gray-300">{metrics.current.toFixed(2)}</Text>
        </div>
        <div className="flex items-center gap-1">
          <Text className="font-semibold dark:text-white">LRR:</Text>
          <Text className="dark:text-gray-300">
            {metrics.lrr && metrics.lrr > 0 ? metrics.lrr.toFixed(2) : '--'}
          </Text>
        </div>
        <div className="flex items-center gap-1">
          <Text className="font-semibold dark:text-white">TRR:</Text>
          <Text className="dark:text-gray-300">
            {metrics.trr && metrics.trr > 0 ? metrics.trr.toFixed(2) : '--'}
          </Text>
        </div>
        <div className="flex items-center gap-1">
          <Text className="font-semibold dark:text-white">SI:</Text>
          <Text className="dark:text-gray-300">{typeof metrics.si === 'number' ? metrics.si.toFixed(2) : metrics.si}</Text>
        </div>
        <div className="flex items-center gap-1">
          <Text className="font-semibold dark:text-white">HH/HL:</Text>
          <Text className="dark:text-gray-300">{metrics.hhhl}</Text>
        </div>
        <div className="flex items-center gap-1">
          <Text className="font-semibold dark:text-white">LH/LL:</Text>
          <Text className="dark:text-gray-300">{metrics.lhll}</Text>
        </div>
        <div className="flex items-center gap-1">
          <Text className="font-semibold dark:text-white">Vol={metrics.volTicker}:</Text>
          <Text className="dark:text-gray-300">
            {typeof metrics.vol === 'number' ? metrics.vol.toFixed(2) : '--'}
          </Text>
        </div>
        <div className="flex items-center gap-1">
          <Text className="font-semibold dark:text-white">Z-Score:</Text>
          <Text className="dark:text-gray-300">{typeof metrics.zScore === 'number' ? metrics.zScore.toFixed(2) : metrics.zScore}</Text>
        </div>
        <div className="flex items-center gap-1">
          <Text className="font-semibold dark:text-white">Beta:</Text>
          <Text className="dark:text-gray-300">{typeof metrics.beta === 'number' ? metrics.beta.toFixed(2) : metrics.beta}</Text>
        </div>
      </Flex>
    </Card>
  );
};

export default SecuritiesPanel;
