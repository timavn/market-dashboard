import React, { useState, useEffect, useMemo } from 'react';
import { Card, Metric, Text, Grid, Badge, Flex } from '@tremor/react';
import PopoverSelect from '../common/PopoverSelect';
import { LineChart, Line, ResponsiveContainer, XAxis, YAxis } from 'recharts';
import { CorrelationHelpers, USDMarketService } from '../../services/api/usdMarketService';

// Currency index mapping
const CURRENCY_INDEXES = {
  'USDEUR': { ticker: 'FXE', name: 'Euro' },
  'USDJPY': { ticker: 'FXY', name: 'Japanese Yen' },
  'USDCHF': { ticker: 'FXF', name: 'Swiss Franc' },
  'USDGBP': { ticker: 'FXB', name: 'British Pound' },
  'USDCAD': { ticker: 'FXC', name: 'Canadian Dollar' },
  'USDCNY': { ticker: 'FXCH', name: 'Chinese Yuan' },
  'USDAUD': { ticker: 'FXA', name: 'Australian Dollar' },
  'USD': { ticker: 'UUP', name: 'U.S. Dollar' },
  'GOLD': { ticker: 'GLD', name: 'Gold' }
};

const USDProxies = ({ dxy, currencyPairs, loading, error }) => {
  const [historicalData, setHistoricalData] = useState({});
  const [fullHistoryData, setFullHistoryData] = useState({}); // Store all history
  const [indexData, setIndexData] = useState({});
  const [timeframes, setTimeframes] = useState({});
  
  // Initialize timeframes for each currency pair and index
  useEffect(() => {
    if (currencyPairs) {
      const initialTimeframes = {};
      currencyPairs.forEach(pair => {
        initialTimeframes[pair.pair] = '30'; // Default to 30 days
        // Also initialize timeframe for the corresponding index
        const index = CURRENCY_INDEXES[pair.pair];
        if (index) {
          initialTimeframes[index.ticker] = '30';
        }
      });
      // Add UUP and GLD
      initialTimeframes['UUP'] = '30';
      initialTimeframes['GLD'] = '30';
      setTimeframes(initialTimeframes);
    }
  }, [currencyPairs]);

  // Generate mock index data
  useEffect(() => {
    if (currencyPairs) {
      const mockIndexData = {};
      
      // Generate data for UUP (USD index)
      mockIndexData['UUP'] = {
        value: 28.21,
        change: 0.77,
        changePercent: 2.81,
        timestamp: new Date().toISOString()
      };
      
      // Generate data for GLD (Gold)
      mockIndexData['GLD'] = {
        value: 368.12,
        change: 2.45,
        changePercent: 0.67,
        timestamp: new Date().toISOString()
      };
      
      // Generate data for each currency index
      currencyPairs.forEach(pair => {
        const index = CURRENCY_INDEXES[pair.pair];
        if (index) {
          // Generate mock index values based on the pair
          const baseValue = index.ticker === 'FXE' ? 106.37 :
                           index.ticker === 'FXY' ? 59.66 :
                           index.ticker === 'FXF' ? 109.96 :
                           index.ticker === 'FXB' ? 126.44 :
                           index.ticker === 'FXC' ? 135.50 :
                           index.ticker === 'FXCH' ? 95.20 :
                           index.ticker === 'FXA' ? 142.30 : 100;
          
          const changePercent = (Math.random() - 0.5) * 2;
          const change = baseValue * (changePercent / 100);
          
          mockIndexData[index.ticker] = {
            value: baseValue,
            change: change,
            changePercent: changePercent,
            timestamp: new Date().toISOString()
          };
        }
      });
      
      setIndexData(mockIndexData);
    }
  }, [currencyPairs]);

  // Fetch historical data only once (on load)
  useEffect(() => {
    const fetchHistoricalData = async () => {
      if (!currencyPairs) return;

      // Always fetch max required history (365 days)
      const maxTimeframe = 365;

      const promises = currencyPairs.map(async (pair) => {
        try {
          const data = await USDMarketService.getHistoricalData(pair.pair, maxTimeframe);
          // Ensure date parsing for consistent filtering
          const processedData = (data.data || []).map(d => ({
            ...d,
            dateObj: new Date(d.date)
          }));
          return { pair: pair.pair, data: processedData };
        } catch (err) {
          console.error(`Error fetching historical data for ${pair.pair}:`, err);
          return { pair: pair.pair, data: [] };
        }
      });

      // Also fetch index historical data
      const indexPromises = Object.keys(CURRENCY_INDEXES).map(async (pairKey) => {
        const index = CURRENCY_INDEXES[pairKey];
        if (index) {
          try {
            const data = await USDMarketService.getHistoricalData(index.ticker, maxTimeframe);
            const processedData = (data.data || []).map(d => ({
                ...d,
                dateObj: new Date(d.date)
            }));
            return { ticker: index.ticker, data: processedData };
          } catch (err) {
            // Return empty data for now (will use mock data)
            return { ticker: index.ticker, data: [] };
          }
        }
        return null;
      }).filter(Boolean);

      const allPromises = [...promises, ...indexPromises];
      const results = await Promise.all(allPromises);
      const dataMap = {};
      results.forEach(result => {
        if (result) {
          dataMap[result.pair || result.ticker] = result.data;
        }
      });
      setFullHistoryData(dataMap);
    };

    fetchHistoricalData();
  }, [currencyPairs]);

  // Memoize filtered historical data to avoid recalculating on every render
  const filteredHistoricalData = useMemo(() => {
    const filteredDataMap = {};
    
    Object.keys(fullHistoryData).forEach(key => {
        const timeframeDays = parseInt(timeframes[key] || '30');
        const fullData = fullHistoryData[key] || [];
        
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - timeframeDays);
        
        filteredDataMap[key] = fullData.filter(item => item.dateObj >= cutoffDate);
    });
    
    return filteredDataMap;
  }, [fullHistoryData, timeframes]);

  // Update historicalData state when memoized data changes
  useEffect(() => {
    setHistoricalData(filteredHistoricalData);
  }, [filteredHistoricalData]);

  const handleTimeframeChange = (pair, newTimeframe) => {
    setTimeframes(prev => ({
      ...prev,
      [pair]: newTimeframe
    }));
  };

  const MiniSparkline = ({ data, isPositive }) => {
    if (!data || data.length === 0) {
      return (
        <div className="h-[88px] flex items-center justify-center text-gray-400 text-xs">
          No data
        </div>
      );
    }

    const chartData = data.map(item => ({
      value: parseFloat(item.close)
    }));

    return (
      <ResponsiveContainer width="100%" height={88}>
        <LineChart data={chartData} margin={{ top: 5, right: 5, left: 5, bottom: 5 }}>
          <XAxis 
            dataKey="date"
            axisLine={{ stroke: '#D1D5DB' }}
            tick={false}
            tickLine={false}
          />
          <YAxis 
            domain={['dataMin', 'dataMax']}
            axisLine={{ stroke: '#D1D5DB' }}
            tick={false}
            tickLine={false}
            width={1}
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

  if (loading) {
    return (
      <Card>
        <div className="text-center py-8">
          <div className="animate-spin rounded-full h-8 w-8 border-2 border-blue-500 border-t-transparent mx-auto mb-2"></div>
          <Text>Loading USD data...</Text>
        </div>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className="bg-red-50 border-red-200 rounded-lg">
        <Text className="text-red-600">Error loading USD data: {error}</Text>
      </Card>
    );
  }

  // Render currency pair card with its index
  const renderCurrencyCard = (pair) => {
    const isPositive = parseFloat(pair.change) >= 0;
    const pairData = historicalData[pair.pair] || [];
    const index = CURRENCY_INDEXES[pair.pair];
    const indexInfo = index ? indexData[index.ticker] : null;
    const indexDataHistorical = index ? (historicalData[index.ticker] || []) : [];
    const indexIsPositive = indexInfo ? parseFloat(indexInfo.changePercent) >= 0 : false;
    
    return (
      <Card key={pair.pair} className="dark:bg-gray-700 rounded-lg">
        <Flex justifyContent="between" alignItems="center" className="mb-2">
          <Text className="text-xs font-semibold truncate mr-1 dark:text-white">{pair.name}</Text>
          <PopoverSelect
            value={timeframes[pair.pair] || '30'}
            options={[
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
        <Text className="text-base font-bold mb-1 dark:text-white">{pair.rate}</Text>
        <div className="mb-1 h-[70px]">
          <MiniSparkline data={pairData} isPositive={isPositive} />
        </div>
        <Badge 
          color={CorrelationHelpers.getChangeColor(pair.change) === 'positive' ? 'emerald' : 'red'}
          size="xs"
        >
          {CorrelationHelpers.formatChangePercent(pair.changePercent)}
        </Badge>
        
        {/* Index Display */}
        {index && indexInfo && (
          <div className="mt-2 pt-2 border-t dark:border-gray-600">
            <Flex justifyContent="between" alignItems="center" className="mb-1">
              <Text className="text-xs font-semibold dark:text-gray-300">{index.ticker}</Text>
              <PopoverSelect
                value={timeframes[index.ticker] || '30'}
                options={[
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
            <Text className="text-sm font-bold mb-1 dark:text-white">{indexInfo.value.toFixed(2)}</Text>
            <div className="mb-1 h-12">
              <MiniSparkline data={indexDataHistorical} isPositive={indexIsPositive} />
            </div>
            <Badge 
              color={indexIsPositive ? 'emerald' : 'red'}
              size="xs"
            >
              {indexInfo.changePercent >= 0 ? '+' : ''}{indexInfo.changePercent.toFixed(2)}%
            </Badge>
          </div>
        )}
      </Card>
    );
  };

  return (
    <Card className="dark:bg-gray-800 rounded-lg">
      <Grid numItems={1} numItemsSm={1} numItemsLg={12} className="gap-4">
        {/* DXY and UUP Highlight */}
        <div className="col-span-12 lg:col-span-4">
          <Grid numItems={1} className="gap-4">
            {/* DXY Card */}
            <Card className="bg-blue-50 dark:bg-blue-900/20 rounded-lg">
              <Text className="text-sm font-semibold mb-2 dark:text-white">DXY</Text>
              <Metric className="dark:text-white">
                {dxy?.value ? dxy.value.toFixed(2) : '--'}
              </Metric>
              <div className="mt-2">
                <Badge 
                  color={CorrelationHelpers.getChangeColor(dxy?.change) === 'positive' ? 'emerald' : 'red'}
                >
                  {CorrelationHelpers.formatChange(dxy?.change)} ({CorrelationHelpers.formatChangePercent(dxy?.changePercent)})
                </Badge>
              </div>
            </Card>
            
            {/* UUP Card */}
            {indexData['UUP'] && (
              <Card className="bg-blue-50 dark:bg-blue-900/20 rounded-lg">
                <Text className="text-sm font-semibold mb-2 dark:text-white">UUP (USD Index)</Text>
                <Metric className="dark:text-white">
                  {indexData['UUP'].value.toFixed(2)}
                </Metric>
                <div className="mt-2">
                  <Badge 
                    color={indexData['UUP'].changePercent >= 0 ? 'emerald' : 'red'}
                  >
                    {indexData['UUP'].changePercent >= 0 ? '+' : ''}{indexData['UUP'].change.toFixed(2)} ({indexData['UUP'].changePercent >= 0 ? '+' : ''}{indexData['UUP'].changePercent.toFixed(2)}%)
                  </Badge>
                </div>
              </Card>
            )}
            
            {/* GLD Card */}
            {indexData['GLD'] && (
              <Card className="bg-amber-50 dark:bg-amber-900/20 rounded-lg">
                <Text className="text-sm font-semibold mb-2 dark:text-white">GLD (Gold)</Text>
                <Metric className="dark:text-white">
                  {indexData['GLD'].value.toFixed(2)}
                </Metric>
                <div className="mt-2">
                  <Badge 
                    color={indexData['GLD'].changePercent >= 0 ? 'emerald' : 'red'}
                  >
                    {indexData['GLD'].changePercent >= 0 ? '+' : ''}{indexData['GLD'].change.toFixed(2)} ({indexData['GLD'].changePercent >= 0 ? '+' : ''}{indexData['GLD'].changePercent.toFixed(2)}%)
                  </Badge>
                </div>
              </Card>
            )}
          </Grid>
        </div>

        {/* Currency Pairs Grid with Indexes */}
        <div className="col-span-12 lg:col-span-8">
          <Grid numItems={2} numItemsSm={3} className="gap-4">
            {currencyPairs?.map((pair) => renderCurrencyCard(pair))}
          </Grid>
        </div>
      </Grid>

      {/* Last Updated */}
      {(dxy?.timestamp || currencyPairs?.[0]?.timestamp) && (
        <Text className="text-xs text-gray-500 mt-4">
          Last updated: {new Date(dxy?.timestamp || currencyPairs[0]?.timestamp).toLocaleTimeString()}
        </Text>
      )}
    </Card>
  );
};

export default USDProxies;
