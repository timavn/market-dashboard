import React, { useState, useEffect } from 'react';
import { Card, Text, Badge, Flex } from '@tremor/react';
import PopoverSelect from '../common/PopoverSelect';
import { LineChart, Line, ResponsiveContainer, YAxis, XAxis } from 'recharts';
import { CorrelationHelpers, USDMarketService } from '../../services/api/usdMarketService';

// Currency index mapping (same as USDProxies)
const CURRENCY_INDEXES = {
  'USDEUR': { ticker: 'FXE', name: 'Euro' },
  'USDJPY': { ticker: 'FXY', name: 'Japanese Yen' },
  'USDCHF': { ticker: 'FXF', name: 'Swiss Franc' },
  'USDGBP': { ticker: 'FXB', name: 'British Pound' },
  'USDCAD': { ticker: 'FXC', name: 'Canadian Dollar' },
  'USDCNY': { ticker: 'FXCH', name: 'Chinese Yuan' },
  'USDAUD': { ticker: 'FXA', name: 'Australian Dollar' },
};

// Calculate period changes from historical data
const calculatePeriodChanges = (data) => {
  if (!data || data.length < 2) {
    return { '1D': null, '5D': null, '1M': null, '3M': null, '6M': null, '1Y': null };
  }

  const latestClose = parseFloat(data[data.length - 1]?.close);
  const periods = {
    '1D': 1,
    '5D': 5,
    '1M': 30,
    '3M': 90,
    '6M': 180,
    '1Y': 365
  };

  const changes = {};
  Object.entries(periods).forEach(([label, days]) => {
    const targetIndex = Math.max(0, data.length - days - 1);
    if (targetIndex >= 0 && data[targetIndex]) {
      const pastClose = parseFloat(data[targetIndex].close);
      if (pastClose && latestClose) {
        changes[label] = ((latestClose - pastClose) / pastClose) * 100;
      } else {
        changes[label] = null;
      }
    } else {
      changes[label] = null;
    }
  });

  return changes;
};

// Period changes display component
const PeriodChangesRow = ({ data }) => {
  const changes = calculatePeriodChanges(data);
  const periods = ['1D', '5D', '1M', '3M', '6M', '1Y'];

  return (
    <div className="flex justify-between mt-2 pt-2 border-t border-gray-200 dark:border-gray-600">
      {periods.map((period) => {
        const value = changes[period];
        const isPositive = value !== null && value >= 0;
        const displayValue = value !== null ? `${value >= 0 ? '+' : ''}${value.toFixed(1)}%` : '--';
        
        return (
          <div key={period} className="text-center">
            <Text className="text-[9px] text-gray-400 dark:text-gray-500">{period}</Text>
            <Text className={`text-[10px] font-medium ${value === null ? 'text-gray-400' : isPositive ? 'text-emerald-500' : 'text-red-500'}`}>
              {displayValue}
            </Text>
          </div>
        );
      })}
    </div>
  );
};

const MiniSparkline = ({ data, isPositive }) => {
  if (!data || data.length === 0) {
    return (
      <div className="h-[120px] flex items-center justify-center text-gray-400 text-xs">
        No data
      </div>
    );
  }

  // Format date for display (MM/DD)
  const formatDate = (dateStr) => {
    const date = new Date(dateStr);
    return `${date.getMonth() + 1}/${date.getDate()}`;
  };

  const chartData = data.map(item => ({
    value: parseFloat(item.close),
    date: item.date
  }));

  // Get min/max values for Y-axis labels
  const values = chartData.map(d => d.value);
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  
  // Format price for display (smart precision based on value)
  const formatPrice = (val) => {
    if (val >= 100) return val.toFixed(1);
    if (val >= 1) return val.toFixed(2);
    return val.toFixed(4);
  };

  return (
    <ResponsiveContainer width="100%" height={120}>
      <LineChart data={chartData} margin={{ top: 5, right: 5, left: 20, bottom: 5 }}>
        <XAxis 
          dataKey="date" 
          tickFormatter={formatDate}
          tick={{ fontSize: 9, fill: '#9CA3AF' }}
          axisLine={{ stroke: '#D1D5DB' }}
          tickLine={false}
          ticks={[chartData[0]?.date, chartData[chartData.length - 1]?.date]}
        />
        <YAxis 
          domain={['dataMin', 'dataMax']} 
          orientation="left"
          tick={{ fontSize: 9, fill: '#9CA3AF' }}
          axisLine={{ stroke: '#D1D5DB' }}
          tickLine={false}
          tickFormatter={formatPrice}
          ticks={[minValue, maxValue]}
          width={38}
        />
        <Line
          type="monotone"
          dataKey="value"
          stroke={isPositive ? '#10B981' : '#EF4444'}
          strokeWidth={1.5}
          dot={false}
          activeDot={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
};

/**
 * FX Two-Column Mixed List Layout
 * 
 * Displays spot rates on the left and ETFs on the right in a clean two-column format.
 * Best for quick scanning with clear separation of spot vs ETF data.
 */

const FXLayoutsShowcase = ({ dxy, currencyPairs, indexData, loading, error }) => {
  const [historicalData, setHistoricalData] = useState({});
  const [indexHistoricalData, setIndexHistoricalData] = useState({});
  const [timeframes, setTimeframes] = useState({});
  const [fullYearData, setFullYearData] = useState({}); // Store 365-day data for period calculations

  // Initialize timeframes for each currency pair and index
  useEffect(() => {
    if (currencyPairs && Array.isArray(currencyPairs)) {
      const initialTimeframes = {};
      // Add DXY and UUP
      initialTimeframes['DXY'] = '30';
      initialTimeframes['UUP'] = '30';
      currencyPairs.forEach(pair => {
        initialTimeframes[pair.pair] = '30'; // Default to 30 days
        // Also initialize timeframe for the corresponding index
        const index = CURRENCY_INDEXES[pair.pair];
        if (index) {
          initialTimeframes[index.ticker] = '30';
        }
      });
      setTimeframes(initialTimeframes);
    }
  }, [currencyPairs]);

  // Initial fetch of historical data - runs ONCE when currencyPairs arrives
  // Uses default timeframe '30' (30 days) for all symbols to ensure data availability
  // Individual chart updates happen via handleTimeframeChange
  useEffect(() => {
    const fetchInitialData = async () => {
      if (!currencyPairs || !Array.isArray(currencyPairs)) {
        console.log('FXLayoutsShowcase: Waiting for currencyPairs...');
        return;
      }

      console.log('FXLayoutsShowcase: Starting initial fetch for', currencyPairs.length, 'pairs');
      const defaultTimeframe = 30; // 30 days default to ensure we get data

      // Fetch DXY data
      const dxyPromise = (async () => {
        try {
          console.log('FXLayoutsShowcase: Fetching DXY historical data...');
          const data = await USDMarketService.getHistoricalData('DXY', defaultTimeframe);
          console.log('FXLayoutsShowcase: DXY data received:', data?.data?.length || 0, 'points');
          return { pair: 'DXY', data: data.data || [] };
        } catch (err) {
          console.error('FXLayoutsShowcase: Error fetching DXY historical data:', err);
          return { pair: 'DXY', data: [] };
        }
      })();

      // Fetch currency pairs data
      const pairPromises = currencyPairs.map(async (pair) => {
        try {
          const data = await USDMarketService.getHistoricalData(pair.pair, defaultTimeframe);
          return { pair: pair.pair, data: data.data || [] };
        } catch (err) {
          console.error(`Error fetching historical data for ${pair.pair}:`, err);
          return { pair: pair.pair, data: [] };
        }
      });

      // Fetch UUP data
      const uupPromise = (async () => {
        try {
          const data = await USDMarketService.getHistoricalData('UUP', defaultTimeframe);
          return { ticker: 'UUP', data: data.data || [] };
        } catch (err) {
          return { ticker: 'UUP', data: [] };
        }
      })();

      // Fetch index ETF data
      const indexPromises = Object.keys(CURRENCY_INDEXES).map(async (pairKey) => {
        const index = CURRENCY_INDEXES[pairKey];
        if (index) {
          try {
            const data = await USDMarketService.getHistoricalData(index.ticker, defaultTimeframe);
            return { ticker: index.ticker, data: data.data || [] };
          } catch (err) {
            return { ticker: index.ticker, data: [] };
          }
        }
        return null;
      }).filter(Boolean);

      const allPromises = [dxyPromise, ...pairPromises, uupPromise, ...indexPromises];
      const results = await Promise.all(allPromises);
      
      const dataMap = {};
      const indexDataMap = {};
      results.forEach(result => {
        if (result) {
          if (result.pair) {
            dataMap[result.pair] = result.data;
          } else if (result.ticker) {
            indexDataMap[result.ticker] = result.data;
          }
        }
      });
      
      setHistoricalData(dataMap);
      setIndexHistoricalData(indexDataMap);
    };

    fetchInitialData();
  }, [currencyPairs]);

  // Fetch full year data for period change calculations (separate from chart data)
  useEffect(() => {
    const fetchFullYearData = async () => {
      // Ensure currencyPairs is an array before proceeding
      if (!currencyPairs || !Array.isArray(currencyPairs)) {
        console.log('FXLayoutsShowcase: Waiting for valid currencyPairs array...');
        return;
      }

      const fullYearDataMap = {};

      // Fetch 365 days for DXY
      const dxyPromise = (async () => {
        try {
          const data = await USDMarketService.getHistoricalData('DXY', 365);
          return { key: 'DXY', data: data.data || [] };
        } catch (err) {
          return { key: 'DXY', data: [] };
        }
      })();

      // Fetch 365 days for each currency pair
      const pairPromises = currencyPairs.map(async (pair) => {
        try {
          const data = await USDMarketService.getHistoricalData(pair.pair, 365);
          return { key: pair.pair, data: data.data || [] };
        } catch (err) {
          return { key: pair.pair, data: [] };
        }
      });

      // Fetch 365 days for UUP
      const uupPromise = (async () => {
        try {
          const data = await USDMarketService.getHistoricalData('UUP', 365);
          return { key: 'UUP', data: data.data || [] };
        } catch (err) {
          return { key: 'UUP', data: [] };
        }
      })();

      // Fetch 365 days for each index
      const indexPromises = Object.keys(CURRENCY_INDEXES).map(async (pairKey) => {
        const index = CURRENCY_INDEXES[pairKey];
        if (index) {
          try {
            const data = await USDMarketService.getHistoricalData(index.ticker, 365);
            return { key: index.ticker, data: data.data || [] };
          } catch (err) {
            return { key: index.ticker, data: [] };
          }
        }
        return null;
      }).filter(Boolean);

      const results = await Promise.all([dxyPromise, ...pairPromises, uupPromise, ...indexPromises]);
      results.forEach(result => {
        if (result) {
          fullYearDataMap[result.key] = result.data;
        }
      });
      
      setFullYearData(fullYearDataMap);
    };

    fetchFullYearData();
  }, [currencyPairs]);

  // Fetch data for a single symbol when timeframe changes
  // Each chart updates independently - only fetches data for the changed symbol
  const handleTimeframeChange = async (key, newTimeframe) => {
    // Update the timeframe state
    setTimeframes(prev => ({
      ...prev,
      [key]: newTimeframe
    }));

    // Fetch data only for the changed symbol
    try {
      const data = await USDMarketService.getHistoricalData(key, parseInt(newTimeframe));
      
      // Check if this is an ETF/index (stored in indexHistoricalData) or a currency pair (stored in historicalData)
      const isIndex = key === 'UUP' || Object.values(CURRENCY_INDEXES).some(idx => idx.ticker === key);
      
      if (isIndex) {
        setIndexHistoricalData(prev => ({
          ...prev,
          [key]: data.data || []
        }));
      } else {
        // DXY and currency pairs go here
        setHistoricalData(prev => ({
          ...prev,
          [key]: data.data || []
        }));
      }
    } catch (err) {
      console.error(`Error fetching historical data for ${key}:`, err);
    }
  };

  // Handle loading and error states
  if (loading) {
    return (
      <Card className="dark:bg-gray-800 rounded-lg">
        <Text className="text-sm dark:text-white">Loading currency data...</Text>
      </Card>
    );
  }

  if (error || !currencyPairs || !Array.isArray(currencyPairs) || currencyPairs.length === 0) {
    return (
      <Card className="dark:bg-gray-800 rounded-lg">
        <Text className="text-sm font-bold mb-2 dark:text-white">USD Proxies</Text>
        <Text className="text-xs text-gray-600 dark:text-gray-400">
          {error ? `Error: ${error}` : 'No currency pairs data available.'}
        </Text>
      </Card>
    );
  }

  // Mock index data if not provided
  const mockIndexData = indexData || {
    'UUP': { value: 28.21, change: 0.77, changePercent: 2.81 },
    'GLD': { value: 368.12, change: 2.45, changePercent: 0.67 },
    'FXE': { value: 106.37, change: 0.74, changePercent: 0.70 },
    'FXY': { value: 59.66, change: 0.32, changePercent: 0.53 },
    'FXF': { value: 109.96, change: 0.81, changePercent: 0.74 },
    'FXB': { value: 126.44, change: -0.87, changePercent: -0.69 },
    'FXC': { value: 135.50, change: 0.89, changePercent: 0.66 },
    'FXCH': { value: 95.20, change: -0.33, changePercent: -0.35 },
    'FXA': { value: 142.30, change: 0.95, changePercent: 0.67 },
  };

  const timeframeOptions = [
    { value: '1', label: '1D' },
    { value: '30', label: '1M' },
    { value: '90', label: '3M' },
    { value: '180', label: '6M' },
    { value: '365', label: '1Y' },
  ];

  return (
    <Card className="dark:bg-gray-800 rounded-lg">
      <div className="grid grid-cols-2 gap-6">
        {/* Left: Spot Rates */}
        <div>
          <Text className="text-xs font-semibold mb-2 text-gray-600 dark:text-gray-400 uppercase tracking-wider">Spot Rates</Text>
          <div className="space-y-2">
            {/* DXY Card */}
            {dxy && (
              <Card className="p-3 dark:bg-gray-700 rounded-lg">
                <Flex justifyContent="between" alignItems="center" className="mb-2">
                  <div>
                    <Text className="text-xs font-semibold dark:text-white">DXY</Text>
                    <Text className="text-xs text-gray-500 dark:text-gray-400">{parseFloat(dxy.value || 0).toFixed(2)}</Text>
                  </div>
                  <PopoverSelect
                    value={timeframes['DXY'] || '1'}
                    options={timeframeOptions}
                    onChange={(value) => handleTimeframeChange('DXY', value)}
                    buttonClassName="max-w-[60px] min-w-[50px]"
                  />
                </Flex>
                <div className="mb-2 h-[120px]">
                  <MiniSparkline data={historicalData['DXY'] || []} isPositive={parseFloat(dxy.change || 0) >= 0} />
                </div>
                <PeriodChangesRow data={fullYearData['DXY'] || []} />
              </Card>
            )}
            {currencyPairs.map((pair) => {
              const isPositive = parseFloat(pair.change) >= 0;
              const pairData = historicalData[pair.pair] || [];
              const pairFullYearData = fullYearData[pair.pair] || [];
              return (
                <Card key={pair.pair} className="p-3 dark:bg-gray-700 rounded-lg">
                  <Flex justifyContent="between" alignItems="center" className="mb-2">
                    <div>
                      <Text className="text-xs font-semibold dark:text-white">{pair.name}</Text>
                      <Text className="text-xs text-gray-500 dark:text-gray-400">{pair.rate}</Text>
                    </div>
                    <PopoverSelect
                      value={timeframes[pair.pair] || '1'}
                      options={timeframeOptions}
                      onChange={(value) => handleTimeframeChange(pair.pair, value)}
                      buttonClassName="max-w-[60px] min-w-[50px]"
                    />
                  </Flex>
                  <div className="mb-2 h-[120px]">
                    <MiniSparkline data={pairData} isPositive={isPositive} />
                  </div>
                  <PeriodChangesRow data={pairFullYearData} />
                </Card>
              );
            })}
          </div>
        </div>
        {/* Right: ETFs */}
        <div>
          <Text className="text-xs font-semibold mb-2 text-gray-600 dark:text-gray-400 uppercase tracking-wider">ETFs</Text>
          <div className="space-y-2">
            {/* UUP Card */}
            {mockIndexData['UUP'] && (
              <Card className="p-3 dark:bg-gray-700 rounded-lg">
                <Flex justifyContent="between" alignItems="center" className="mb-2">
                  <div>
                    <Text className="text-xs font-semibold dark:text-white">UUP</Text>
                    <Text className="text-xs text-gray-500 dark:text-gray-400">{mockIndexData['UUP'].value.toFixed(2)}</Text>
                  </div>
                  <PopoverSelect
                    value={timeframes['UUP'] || '1'}
                    options={timeframeOptions}
                    onChange={(value) => handleTimeframeChange('UUP', value)}
                    buttonClassName="max-w-[60px] min-w-[50px]"
                  />
                </Flex>
                <div className="mb-2 h-[120px]">
                  <MiniSparkline data={indexHistoricalData['UUP'] || []} isPositive={mockIndexData['UUP'].changePercent >= 0} />
                </div>
                <PeriodChangesRow data={fullYearData['UUP'] || []} />
              </Card>
            )}
            {currencyPairs.map((pair) => {
              const index = CURRENCY_INDEXES[pair.pair];
              const indexInfo = index ? mockIndexData[index.ticker] : null;
              if (!index || !indexInfo) return null;
              const isPositive = indexInfo.changePercent >= 0;
              const indexDataHistorical = index ? (indexHistoricalData[index.ticker] || []) : [];
              const indexFullYearData = index ? (fullYearData[index.ticker] || []) : [];
              return (
                <Card key={index.ticker} className="p-3 dark:bg-gray-700 rounded-lg">
                  <Flex justifyContent="between" alignItems="center" className="mb-2">
                    <div>
                      <Text className="text-xs font-semibold dark:text-white">{index.ticker}</Text>
                      <Text className="text-xs text-gray-500 dark:text-gray-400">{indexInfo.value.toFixed(2)}</Text>
                    </div>
                    <PopoverSelect
                      value={timeframes[index.ticker] || '1'}
                      options={timeframeOptions}
                      onChange={(value) => handleTimeframeChange(index.ticker, value)}
                      buttonClassName="max-w-[60px] min-w-[50px]"
                    />
                  </Flex>
                  <div className="mb-2 h-[120px]">
                    <MiniSparkline data={indexDataHistorical} isPositive={isPositive} />
                  </div>
                  <PeriodChangesRow data={indexFullYearData} />
                </Card>
              );
            })}
          </div>
        </div>
      </div>
    </Card>
  );
};

export default FXLayoutsShowcase;