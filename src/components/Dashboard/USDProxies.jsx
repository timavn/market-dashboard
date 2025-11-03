import React, { useState, useEffect } from 'react';
import { Card, Metric, Text, Grid, Badge, Flex } from '@tremor/react';
import PopoverSelect from '../common/PopoverSelect';
import { LineChart, Line, ResponsiveContainer } from 'recharts';
import { CorrelationHelpers, USDMarketService } from '../../services/api/usdMarketService';

const USDProxies = ({ dxy, currencyPairs, loading, error }) => {
  const [historicalData, setHistoricalData] = useState({});
  const [timeframes, setTimeframes] = useState({});

  // Initialize timeframes for each currency pair
  useEffect(() => {
    if (currencyPairs) {
      const initialTimeframes = {};
      currencyPairs.forEach(pair => {
        initialTimeframes[pair.pair] = '30'; // Default to 30 days
      });
      setTimeframes(initialTimeframes);
    }
  }, [currencyPairs]);

  // Fetch historical data when timeframes change
  useEffect(() => {
    const fetchHistoricalData = async () => {
      if (!currencyPairs) return;

      const promises = currencyPairs.map(async (pair) => {
        const timeframe = parseInt(timeframes[pair.pair] || 30);
        try {
          const data = await USDMarketService.getHistoricalData(pair.pair, timeframe);
          return { pair: pair.pair, data: data.data || [] };
        } catch (err) {
          console.error(`Error fetching historical data for ${pair.pair}:`, err);
          return { pair: pair.pair, data: [] };
        }
      });

      const results = await Promise.all(promises);
      const dataMap = {};
      results.forEach(result => {
        dataMap[result.pair] = result.data;
      });
      setHistoricalData(dataMap);
    };

    fetchHistoricalData();
  }, [currencyPairs, timeframes]);

  const handleTimeframeChange = (pair, newTimeframe) => {
    setTimeframes(prev => ({
      ...prev,
      [pair]: newTimeframe
    }));
  };

  const MiniSparkline = ({ data, isPositive }) => {
    if (!data || data.length === 0) {
      return (
        <div className="h-20 flex items-center justify-center text-gray-400 text-xs">
          No data
        </div>
      );
    }

    const chartData = data.map(item => ({
      value: parseFloat(item.close)
    }));

    return (
      <ResponsiveContainer width="100%" height={80}>
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
      <Card className="bg-red-50 border-red-200">
        <Text className="text-red-600">Error loading USD data: {error}</Text>
      </Card>
    );
  }

  return (
    <Card>
      <Grid numItems={1} numItemsSm={1} numItemsLg={12} className="gap-4">
        {/* DXY Highlight */}
        <div className="col-span-12 lg:col-span-4">
          <Card className="bg-blue-50">
            <Text className="text-sm font-semibold mb-2">DXY</Text>
            <Metric>
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
        </div>

        {/* Currency Pairs Grid */}
        <div className="col-span-12 lg:col-span-8">
          <Grid numItems={2} numItemsSm={3} className="gap-4">
            {currencyPairs?.map((pair) => {
              const isPositive = parseFloat(pair.change) >= 0;
              const pairData = historicalData[pair.pair] || [];
              
              return (
                <Card key={pair.pair}>
                  <Flex justifyContent="between" alignItems="center" className="mb-2">
                    <Text className="text-xs font-semibold truncate mr-1">{pair.name}</Text>
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
                  <Text className="text-base font-bold mb-1">{pair.rate}</Text>
                  <div className="mb-1 h-16">
                    <MiniSparkline data={pairData} isPositive={isPositive} />
                  </div>
                  <Badge 
                    color={CorrelationHelpers.getChangeColor(pair.change) === 'positive' ? 'emerald' : 'red'}
                    size="xs"
                  >
                    {CorrelationHelpers.formatChangePercent(pair.changePercent)}
                  </Badge>
                </Card>
              );
            })}
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
