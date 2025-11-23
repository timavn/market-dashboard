import React, { useState, useEffect, useRef } from 'react';
import { Card, Text, Flex, Badge } from '@tremor/react';
import PopoverSelect from '../common/PopoverSelect';
import { ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
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

const VolumePanel = () => {
  const [selectedAssetClass, setSelectedAssetClass] = useState('equity');
  const [selectedTicker, setSelectedTicker] = useState('SPY');
  const [productName, setProductName] = useState('');
  const [selectedDateRange, setSelectedDateRange] = useState('1M');
  const [chartData, setChartData] = useState([]);
  const [loading, setLoading] = useState(false);
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
    weekOverWeek: { percent: 0.00, bps: 0 },
    monthOverMonth: { percent: 0.00, bps: 0 },
    threeMonthOverMonth: { percent: 0.00, bps: 0 },
    sixMonthOverMonth: { percent: 0.00, bps: 0 },
    yearOverYear: { percent: 0.00, bps: 0 },
    si: 0.00, // Short Interest
    hhhl: '--', // Higher High / Higher Low
    lhll: '--', // Lower High / Lower Low
    vol: 0.00, // Volatility indicator value
    volTicker: 'VIX', // Volatility ticker name
    zScore: 0.00 // Z-score
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

  // Fetch data when ticker or date range changes
  useEffect(() => {
    const fetchData = async () => {
      if (!selectedTicker) return;
      
      setLoading(true);
      try {
        // Map date range to days
        const dateRangeMap = {
          '1D': 1,
          '5D': 5,
          '1W': 7,
          '1M': 30,
          '3M': 90,
          '6M': 180,
          '1Y': 365
        };
        const days = dateRangeMap[selectedDateRange] || 30;

        // Fetch volume and price data
        // TODO: Replace with actual API call when ready
        const volumeData = await MarketDataService.getVolumeData([selectedTicker]);
        
        // Generate mock chart data for now
        const mockData = generateMockChartData(days);
        setChartData(mockData);

        // Calculate metrics from data
        calculateMetrics(mockData);
      } catch (error) {
        console.error('Error fetching volume data:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [selectedTicker, selectedDateRange]);

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
        price: parseFloat(basePrice.toFixed(2)),
        volume: parseFloat(normalizedVolume.toFixed(2)) // Normalized volume to overlay on price axis
      });
    }
    
    return data;
  };

  // Calculate metrics from chart data
  const calculateMetrics = (data) => {
    if (!data || data.length === 0) return;

    const latest = data[data.length - 1];
    const previous = data.length > 1 ? data[data.length - 2] : latest;
    const weekAgo = data.length >= 7 ? data[Math.max(0, data.length - 7)] : latest;
    const monthAgo = data.length >= 30 ? data[Math.max(0, data.length - 30)] : latest;
    const threeMonthAgo = data.length >= 90 ? data[Math.max(0, data.length - 90)] : latest;
    const sixMonthAgo = data.length >= 180 ? data[Math.max(0, data.length - 180)] : latest;
    const yearAgo = data.length >= 365 ? data[Math.max(0, data.length - 365)] : latest;

    const current = latest.price;
    const closing = previous.price;

    // Calculate percentage changes
    const calculateChange = (current, previous) => {
      if (!previous || previous === 0) return { percent: 0.00, bps: 0 };
      const percent = ((current - previous) / previous) * 100;
      const bps = percent * 100;
      return { percent: parseFloat(percent.toFixed(2)), bps: Math.round(bps) };
    };

    const dayOverDay = calculateChange(current, closing);
    const weekOverWeek = calculateChange(current, weekAgo.price);
    const monthOverMonth = calculateChange(current, monthAgo.price);
    const threeMonthOverMonth = calculateChange(current, threeMonthAgo.price);
    const sixMonthOverMonth = calculateChange(current, sixMonthAgo.price);
    const yearOverYear = calculateChange(current, yearAgo.price);

    setMetrics(prev => ({
      ...prev,
      closing: parseFloat(closing.toFixed(2)),
      current: parseFloat(current.toFixed(2)),
      lrr: 0.00, // Placeholder - lower risk range
      trr: 0.00, // Placeholder - higher risk range
      dayOverDay,
      weekOverWeek,
      monthOverMonth,
      threeMonthOverMonth,
      sixMonthOverMonth,
      yearOverYear
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
    const sign = percent >= 0 ? '+' : '';
    return `${sign}${percent.toFixed(2)}%`;
  };

  const getChangeColor = (percent) => {
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

      {/* Time Period Metrics Above Chart */}
      <Flex className="flex-wrap gap-2 mb-1 text-xs dark:text-white">
        <div className="flex items-center gap-1">
          <Text className="font-semibold dark:text-white">D/D:</Text>
          <Badge 
            color={getChangeColor(metrics.dayOverDay.percent)} 
            size="xs"
          >
            {formatMetricValue(metrics.current, metrics.dayOverDay.percent, metrics.dayOverDay.bps)}
          </Badge>
        </div>
        <div className="flex items-center gap-1">
          <Text className="font-semibold dark:text-white">W/W:</Text>
          <Badge 
            color={getChangeColor(metrics.weekOverWeek.percent)} 
            size="xs"
          >
            {formatMetricValue(metrics.current, metrics.weekOverWeek.percent, metrics.weekOverWeek.bps)}
          </Badge>
        </div>
        <div className="flex items-center gap-1">
          <Text className="font-semibold dark:text-white">M/M:</Text>
          <Badge 
            color={getChangeColor(metrics.monthOverMonth.percent)} 
            size="xs"
          >
            {formatMetricValue(metrics.current, metrics.monthOverMonth.percent, metrics.monthOverMonth.bps)}
          </Badge>
        </div>
        <div className="flex items-center gap-1">
          <Text className="font-semibold dark:text-white">3M:</Text>
          <Badge 
            color={getChangeColor(metrics.threeMonthOverMonth.percent)} 
            size="xs"
          >
            {formatMetricValue(metrics.current, metrics.threeMonthOverMonth.percent, metrics.threeMonthOverMonth.bps)}
          </Badge>
        </div>
        <div className="flex items-center gap-1">
          <Text className="font-semibold dark:text-white">6M:</Text>
          <Badge 
            color={getChangeColor(metrics.sixMonthOverMonth.percent)} 
            size="xs"
          >
            {formatMetricValue(metrics.current, metrics.sixMonthOverMonth.percent, metrics.sixMonthOverMonth.bps)}
          </Badge>
        </div>
        <div className="flex items-center gap-1">
          <Text className="font-semibold dark:text-white">Y/Y:</Text>
          <Badge 
            color={getChangeColor(metrics.yearOverYear.percent)} 
            size="xs"
          >
            {formatMetricValue(metrics.current, metrics.yearOverYear.percent, metrics.yearOverYear.bps)}
          </Badge>
        </div>
      </Flex>

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
                angle={-45}
                textAnchor="end"
                height={60}
                padding={{ bottom: 10 }}
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
          <Text className="dark:text-gray-300">{metrics.lrr.toFixed(2)}</Text>
        </div>
        <div className="flex items-center gap-1">
          <Text className="font-semibold dark:text-white">TRR:</Text>
          <Text className="dark:text-gray-300">{metrics.trr.toFixed(2)}</Text>
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
      </Flex>
    </Card>
  );
};

export default VolumePanel;
