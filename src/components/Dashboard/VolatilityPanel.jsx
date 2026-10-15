import React, { useState, useCallback, useMemo } from 'react';
import { Text, Badge, Flex } from '@tremor/react';
import PopoverSelect from '../common/PopoverSelect';
import { LineChart, Line, Bar, ComposedChart, Legend, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { MarketDataService } from '../../services/api/marketDataService';
import LoadingIndicator from '../common/LoadingIndicator';
import { useSessionResource } from '../../hooks/useSessionResource';
import { useSurfaceActivity } from '../common/PersistentSurface';
import { verifiedHistoricalRecords } from '../../utils/legacyMarketDisplay';

const HISTORY_SYMBOLS = { VIX: '^VIX', VVIX: '^VVIX', RVX: '^RVX', GVZ: '^GVZ', MOVE: '^MOVE', REALIZED_VOL: '^GSPC' };
const TIMEFRAME_DAYS = { '1D': 1, '1W': 7, '1M': 30, '3M': 90, '6M': 180, '1Y': 365 };
const EMPTY_SERIES = [];
const validateHistory = (records) => Array.isArray(records) && records.length > 0 ? records : null;
const historyDate = (records) => records?.at(-1)?.date;

export function calculateVolatilityMetrics(data, volTicker) {
  const current = data.at(-1)?.value ?? null;
  const previous = data.at(-2)?.value ?? null;
  const latestDate = Date.parse(data.at(-1)?.date || '');
  const change = (prior) => ({ percent: current != null && prior != null && prior > 0
    ? ((current - prior) / prior) * 100 : null });
  const period = (days) => {
    const cutoff = latestDate - days * 86400000;
    const prior = [...data].reverse().find((row) => Date.parse(row.date) <= cutoff);
    return change(prior?.value);
  };
  return { current, closing: previous, vol: current, volTicker,
    lrr: null, trr: null, si: null, hhhl: '—', lhll: '—',
    dayOverDay: change(previous), weekOverWeek: period(7), monthOverMonth: period(30),
    threeMonthOverMonth: period(90), sixMonthOverMonth: period(180), yearOverYear: period(365) };
}

  // Calculate realized volatility
export const calculateRealizedVolatility = (historicalData) => {
    if (!historicalData || historicalData.length < 22) return [];

    // Sort by date ascending if needed
    const sortedData = [...historicalData].sort((a, b) => new Date(a.date) - new Date(b.date));
    
    // Calculate daily returns
    const returns = [];
    for (let i = 1; i < sortedData.length; i++) {
      const currentPrice = sortedData[i].close;
      const prevPrice = sortedData[i - 1].close;
      const dailyReturn = Math.log(currentPrice / prevPrice);
      returns.push({
        date: sortedData[i].date,
        return: dailyReturn,
        percentChange: ((currentPrice - prevPrice) / prevPrice) * 100
      });
    }

    // Calculate rolling volatility
    const result = [];
    const TRADING_DAYS = 252;
    
    for (let i = 0; i < returns.length; i++) {
      const currentReturns = returns.slice(0, i + 1);
      
      // Need at least 21 days for 1M vol
      if (currentReturns.length >= 21) {
        // 1-Month Volatility (21 trading days)
        const window1M = currentReturns.slice(-21).map(r => r.return);
        const mean1M = window1M.reduce((a, b) => a + b, 0) / window1M.length;
        const variance1M = window1M.reduce((a, b) => a + Math.pow(b - mean1M, 2), 0) / (window1M.length - 1);
        const vol1M = Math.sqrt(variance1M) * Math.sqrt(TRADING_DAYS) * 100;

        let vol3M = null;
        if (currentReturns.length >= 63) {
          // 3-Month Volatility (63 trading days)
          const window3M = currentReturns.slice(-63).map(r => r.return);
          const mean3M = window3M.reduce((a, b) => a + b, 0) / window3M.length;
          const variance3M = window3M.reduce((a, b) => a + Math.pow(b - mean3M, 2), 0) / (window3M.length - 1);
          vol3M = Math.sqrt(variance3M) * Math.sqrt(TRADING_DAYS) * 100;
        }

        result.push({
          date: returns[i].date,
          value: parseFloat(vol1M.toFixed(2)), // Add value field for compatibility with metrics calculation
          vol1M: parseFloat(vol1M.toFixed(2)),
          vol3M: vol3M != null ? parseFloat(vol3M.toFixed(2)) : null,
          dailyChange: parseFloat(returns[i].percentChange.toFixed(2))
        });
      }
    }

    return result;
  };


const VolatilityPanel = () => {
  const [selectedVolatility, setSelectedVolatility] = useState('VIX');
  const [selectedTimeframe, setSelectedTimeframe] = useState('1M');
  const active = useSurfaceActivity();
  const symbol = HISTORY_SYMBOLS[selectedVolatility];
  const fetcher = useCallback(async () => {
    if (!symbol) throw new Error('Verified history is not configured for this index.');
    const payload = await MarketDataService.getHistoricalData(symbol, 400);
    const records = verifiedHistoricalRecords(payload, symbol);
    if (!records.length) throw new Error('Verified historical observations unavailable.');
    return records;
  }, [symbol]);
  const resource = useSessionResource({ resourceKey: `legacy-volatility-history:${selectedVolatility}`,
    kind: 'reference', displayRole: 'reference', fetcher, validate: validateHistory,
    getObservedAt: historyDate, active, pollIntervalMs: 900000 });
  const history = resource.error ? EMPTY_SERIES : resource.data || EMPTY_SERIES;
  const loading = resource.initialLoading;
  const fullSeries = useMemo(() => selectedVolatility === 'REALIZED_VOL'
    ? calculateRealizedVolatility(history) : history.map((row) => ({ date: row.date, value: row.close })),
  [history, selectedVolatility]);
  const chartData = useMemo(() => {
    const cutoff = Date.now() - TIMEFRAME_DAYS[selectedTimeframe] * 86400000;
    return fullSeries.filter((row) => Date.parse(row.date) >= cutoff);
  }, [fullSeries, selectedTimeframe]);
  const metrics = useMemo(() => calculateVolatilityMetrics(fullSeries,
    selectedVolatility === 'REALIZED_VOL' ? '1M Realized' : selectedVolatility), [fullSeries, selectedVolatility]);
  const asOf = fullSeries.at(-1)?.date;
  const formatMetricValue = (_value, percent) => percent == null ? '—' : `${percent >= 0 ? '+' : ''}${percent.toFixed(2)}%`;
  const getChangeColor = (percent) => percent == null ? 'gray' : percent >= 0 ? 'emerald' : 'rose';
  const getVolatilityColor = (value) => value == null ? '#6b7280' : value <= 19 ? '#059669' : value <= 29 ? '#f59e0b' : '#dc2626';

  const volatilityOptions = [
    { value: 'VIX', label: 'VIX' },
    { value: 'VVIX', label: 'VVIX' },
    { value: 'MOVE', label: 'MOVE' },
    { value: 'GVZ', label: 'GVZ' },
    { value: 'EVZ', label: 'EVZ' },
    { value: 'RVX', label: 'RVX' },
    { value: 'TYVIX', label: 'TYVIX' },
    { value: 'REALIZED_VOL', label: 'Realized Vol (1M vs 3M)' }
  ];

  const timeframeOptions = [
    { value: '1D', label: '1D' },
    { value: '1W', label: '1W' },
    { value: '1M', label: '1M' },
    { value: '3M', label: '3M' },
    { value: '6M', label: '6M' },
    { value: '1Y', label: '1Y' }
  ];

  return (
    <div className="p-3 h-full" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Top Controls Row */}
      <Flex className="mb-2 gap-2" justifyContent="between" alignItems="center">
        <div className="flex items-center gap-2">
          <PopoverSelect ariaLabel="Volatility index" value={selectedVolatility}
            options={volatilityOptions} onChange={setSelectedVolatility} />
        </div>
        {/* Timeframe Popover moved to right side (top-right) */}
        <div>
          <PopoverSelect
            ariaLabel="Volatility timeframe"
            value={selectedTimeframe}
            options={timeframeOptions}
            onChange={setSelectedTimeframe}
            buttonClassName="w-20 justify-center"
          />
        </div>
      </Flex>

      <Text className="mb-2 text-xs text-gray-500" role="status">
        {asOf ? `Historical reference · As of ${new Date(asOf).toLocaleDateString()}` : 'Verified historical observations unavailable'}
      </Text>
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
          <LoadingIndicator label="Loading chart data..." size="lg" centered className="h-full w-full" />
        ) : chartData.length > 0 ? (
          <ResponsiveContainer width="100%" height="100%">
            {selectedVolatility === 'REALIZED_VOL' ? (
              <ComposedChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" vertical={false} />
                <XAxis 
                  dataKey="date" 
                  tick={{ fontSize: 10 }}
                  angle={-45}
                  textAnchor="end"
                  height={60}
                  padding={{ bottom: 10 }}
                />
                <YAxis 
                  yAxisId="left"
                  tick={{ fontSize: 10 }}
                  label={{ value: 'Realized Volatility', angle: -90, position: 'insideLeft', fontSize: 10 }}
                  domain={['auto', 'auto']}
                />
                <YAxis 
                  yAxisId="right"
                  orientation="right"
                  tick={{ fontSize: 10 }}
                  label={{ value: 'Daily % Change', angle: 90, position: 'insideRight', fontSize: 10 }}
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
                <Legend wrapperStyle={{ fontSize: '10px' }} />
                <Bar 
                  yAxisId="right"
                  dataKey="dailyChange" 
                  name="SPX Daily % Change" 
                  fill="#d1d5db" 
                  opacity={0.5}
                />
                <Line 
                  yAxisId="left"
                  type="monotone" 
                  dataKey="vol1M" 
                  stroke="#3b82f6" 
                  strokeWidth={2}
                  dot={false}
                  name="1-Month Realized"
                />
                <Line 
                  yAxisId="left"
                  type="monotone" 
                  dataKey="vol3M" 
                  stroke="#f97316" 
                  strokeWidth={2}
                  dot={false}
                  name="3-Month Realized"
                />
              </ComposedChart>
            ) : (
              <LineChart data={chartData}>
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
                  label={{ value: selectedVolatility, angle: -90, position: 'insideLeft' }}
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
                <Line 
                  type="monotone" 
                  dataKey="value" 
                  stroke={getVolatilityColor(metrics.current)}
                  strokeWidth={2}
                  dot={false}
                  name={selectedVolatility}
                />
              </LineChart>
            )}
          </ResponsiveContainer>
        ) : (
          <div className="flex items-center justify-center h-full">
            <Text className="text-gray-500 dark:text-gray-400">No verified chart data available</Text>
          </div>
        )}
      </div>

      {/* Bottom Metrics Bar */}
      <Flex className="flex-wrap gap-2 text-xs dark:text-white">
        <div className="flex items-center gap-1">
          <Text className="font-semibold dark:text-white">Closing:</Text>
          <Text className="dark:text-gray-300">{metrics.closing?.toFixed(2) ?? '—'}</Text>
        </div>
        <div className="flex items-center gap-1">
          <Text className="font-semibold dark:text-white">Latest:</Text>
          <Text className="dark:text-gray-300">{metrics.current?.toFixed(2) ?? '—'}</Text>
        </div>
        <div className="flex items-center gap-1">
          <Text className="font-semibold dark:text-white">LRR:</Text>
          <Text className="dark:text-gray-300">{metrics.lrr?.toFixed(2) ?? '—'}</Text>
        </div>
        <div className="flex items-center gap-1">
          <Text className="font-semibold dark:text-white">HRR:</Text>
          <Text className="dark:text-gray-300">{metrics.trr?.toFixed(2) ?? '—'}</Text>
        </div>
        <div className="flex items-center gap-1">
          <Text className="font-semibold dark:text-white">SI:</Text>
          <Text className="dark:text-gray-300">{metrics.si?.toFixed(2) ?? '—'}</Text>
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
            {metrics.vol?.toFixed(2) ?? '—'}
          </Text>
        </div>
      </Flex>
    </div>
  );
};

export default VolatilityPanel;
