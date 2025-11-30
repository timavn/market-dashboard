import React, { useState, useEffect } from 'react';
import { Card, Text, Badge, Flex } from '@tremor/react';
import PopoverSelect from '../common/PopoverSelect';
import { LineChart, Line, ResponsiveContainer } from 'recharts';
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

  // Initialize timeframes for each currency pair and index
  useEffect(() => {
    if (currencyPairs) {
      const initialTimeframes = {};
      currencyPairs.forEach(pair => {
        initialTimeframes[pair.pair] = '1'; // Default to 1 day (1D)
        // Also initialize timeframe for the corresponding index
        const index = CURRENCY_INDEXES[pair.pair];
        if (index) {
          initialTimeframes[index.ticker] = '1';
        }
      });
      setTimeframes(initialTimeframes);
    }
  }, [currencyPairs]);

  // Fetch historical data when timeframes change
  useEffect(() => {
    const fetchHistoricalData = async () => {
      if (!currencyPairs) return;

      const promises = currencyPairs.map(async (pair) => {
        const timeframe = parseInt(timeframes[pair.pair] || 1);
        try {
          const data = await USDMarketService.getHistoricalData(pair.pair, timeframe);
          return { pair: pair.pair, data: data.data || [] };
        } catch (err) {
          console.error(`Error fetching historical data for ${pair.pair}:`, err);
          return { pair: pair.pair, data: [] };
        }
      });

      // Also fetch index historical data
      const indexPromises = Object.keys(CURRENCY_INDEXES).map(async (pairKey) => {
        const index = CURRENCY_INDEXES[pairKey];
        if (index) {
          const timeframe = parseInt(timeframes[index.ticker] || 1);
          try {
            const data = await USDMarketService.getHistoricalData(index.ticker, timeframe);
            return { ticker: index.ticker, data: data.data || [] };
          } catch (err) {
            return { ticker: index.ticker, data: [] };
          }
        }
        return null;
      }).filter(Boolean);

      const allPromises = [...promises, ...indexPromises];
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

    fetchHistoricalData();
  }, [currencyPairs, timeframes]);

  const handleTimeframeChange = (key, newTimeframe) => {
    setTimeframes(prev => ({
      ...prev,
      [key]: newTimeframe
    }));
  };

  const MiniSparkline = ({ data, isPositive }) => {
    if (!data || data.length === 0) {
      return (
        <div className="h-16 flex items-center justify-center text-gray-400 text-xs">
          No data
        </div>
      );
    }

    const chartData = data.map(item => ({
      value: parseFloat(item.close)
    }));

    return (
      <ResponsiveContainer width="100%" height={64}>
        <LineChart data={chartData}>
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

  // Handle loading and error states
  if (loading) {
    return (
      <Card className="dark:bg-gray-800">
        <Text className="text-sm dark:text-white">Loading currency data...</Text>
      </Card>
    );
  }

  if (error || !currencyPairs || currencyPairs.length === 0) {
    return (
      <Card className="dark:bg-gray-800">
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

  return (
    <Card className="dark:bg-gray-800">
      <div className="grid grid-cols-2 gap-6">
        {/* Left: Spot Rates */}
        <div>
          <Text className="text-xs font-semibold mb-2 text-gray-600 dark:text-gray-400 uppercase tracking-wider">Spot Rates</Text>
          <div className="space-y-2">
            {currencyPairs.map((pair) => {
              const isPositive = parseFloat(pair.change) >= 0;
              const pairData = historicalData[pair.pair] || [];
              return (
                <Card key={pair.pair} className="p-3 dark:bg-gray-700">
                  <Flex justifyContent="between" alignItems="center" className="mb-2">
                    <div>
                      <Text className="text-xs font-semibold dark:text-white">{pair.name}</Text>
                      <Text className="text-xs text-gray-500 dark:text-gray-400">{pair.rate}</Text>
                    </div>
                    <PopoverSelect
                      value={timeframes[pair.pair] || '1'}
                      options={[
                        { value: '1', label: '1D' },
                        { value: '7', label: '1W' },
                        { value: '30', label: '1M' },
                        { value: '90', label: '3M' },
                        { value: '180', label: '6M' },
                        { value: '365', label: '1Y' },
                      ]}
                      onChange={(value) => handleTimeframeChange(pair.pair, value)}
                      buttonClassName="max-w-[60px] min-w-[50px]"
                    />
                  </Flex>
                  <div className="mb-2 h-16">
                    <MiniSparkline data={pairData} isPositive={isPositive} />
                  </div>
                  <Badge color={isPositive ? 'emerald' : 'red'} size="xs">
                    {CorrelationHelpers.formatChangePercent(pair.changePercent)}
                  </Badge>
                </Card>
              );
            })}
          </div>
        </div>
        {/* Right: ETFs */}
        <div>
          <Text className="text-xs font-semibold mb-2 text-gray-600 dark:text-gray-400 uppercase tracking-wider">ETFs</Text>
          <div className="space-y-2">
            {currencyPairs.map((pair) => {
              const index = CURRENCY_INDEXES[pair.pair];
              const indexInfo = index ? mockIndexData[index.ticker] : null;
              if (!index || !indexInfo) return null;
              const isPositive = indexInfo.changePercent >= 0;
              const indexDataHistorical = index ? (indexHistoricalData[index.ticker] || []) : [];
              return (
                <Card key={index.ticker} className="p-3 dark:bg-gray-700">
                  <Flex justifyContent="between" alignItems="center" className="mb-2">
                    <div>
                      <Text className="text-xs font-semibold dark:text-white">{index.ticker}</Text>
                      <Text className="text-xs text-gray-500 dark:text-gray-400">{indexInfo.value.toFixed(2)}</Text>
                    </div>
                    <PopoverSelect
                      value={timeframes[index.ticker] || '1'}
                      options={[
                        { value: '1', label: '1D' },
                        { value: '7', label: '1W' },
                        { value: '30', label: '1M' },
                        { value: '90', label: '3M' },
                        { value: '180', label: '6M' },
                        { value: '365', label: '1Y' },
                      ]}
                      onChange={(value) => handleTimeframeChange(index.ticker, value)}
                      buttonClassName="max-w-[60px] min-w-[50px]"
                    />
                  </Flex>
                  <div className="mb-2 h-16">
                    <MiniSparkline data={indexDataHistorical} isPositive={isPositive} />
                  </div>
                  <Badge color={isPositive ? 'emerald' : 'red'} size="xs">
                    {indexInfo.changePercent >= 0 ? '+' : ''}{indexInfo.changePercent.toFixed(2)}%
                  </Badge>
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
