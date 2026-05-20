import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  AreaChart,
  Area,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine
} from 'recharts';
import { MarketDataService } from '../../services/api/marketDataService';
import StatusDot from '../common/StatusDot';
import { getMinTimestamp, getSourceFreshness, SOURCE_POLL_INTERVALS } from '../../utils/timeUtils';
import './MarketChartCard.css';
import LoadingIndicator from '../common/LoadingIndicator';

// Time range options (keep in sync with /api/chart-data validRanges)
const TIME_RANGES = [
  { key: '1d', label: '1D' },
  { key: '5d', label: '5D' },
  { key: '1mo', label: '1M' },
  { key: '3mo', label: '3M' },
  { key: '6mo', label: '6M' },
  { key: '1y', label: '1Y' },
  { key: '2y', label: '2Y' }
];

const MW_LINE_STROKE = '#2563eb';
const MW_PREV_CLOSE_STROKE = '#dc2626';

// Client-side chart data cache with TTL
const CACHE_TTL = {
  '1d': 30 * 1000,
  '5d': 60 * 1000,
  '1mo': 5 * 60 * 1000,
  '3mo': 5 * 60 * 1000,
  '6mo': 10 * 60 * 1000,
  '1y': 10 * 60 * 1000,
  '2y': 15 * 60 * 1000
};

const chartDataCache = new Map();

const getCachedData = (symbol, range) => {
  const key = `${symbol}:${range}`;
  const cached = chartDataCache.get(key);
  if (!cached) return null;

  const ttl = CACHE_TTL[range] || 60 * 1000;
  if (Date.now() - cached.timestamp > ttl) {
    chartDataCache.delete(key);
    return null;
  }
  return cached.data;
};

const setCachedData = (symbol, range, data) => {
  const key = `${symbol}:${range}`;
  chartDataCache.set(key, {
    data,
    timestamp: Date.now()
  });
};

/** Prefetch a single symbol (default 1D only — avoids load spikes). */
export const prefetchChartData = async (symbol) => {
  const range = '1d';
  if (!getCachedData(symbol, range)) {
    try {
      const data = await MarketDataService.getChartData(symbol, range);
      if (data && !data.error) {
        setCachedData(symbol, range, data);
      }
    } catch (err) {
      // Silently fail — user fetch will retry
    }
  }
};

const formatXAxis = (timestamp, range) => {
  const date = new Date(timestamp);

  switch (range) {
    case '1d':
      return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
    case '5d':
      return date.toLocaleDateString('en-US', { weekday: 'short', hour: 'numeric', hour12: true });
    case '1mo':
      return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    case '3mo':
    case '6mo':
      return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    case '1y':
    case '2y':
      return date.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
    default:
      return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
};

const CustomTooltip = ({ active, payload, range }) => {
  if (!active || !payload || payload.length === 0) return null;

  const data = payload[0].payload;
  const date = new Date(data.timestamp);

  let dateStr;
  if (range === '1d') {
    dateStr = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  } else {
    dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  return (
    <div className="chart-tooltip">
      <div className="tooltip-date">{dateStr}</div>
      <div className="tooltip-price">{parseFloat(data.close).toFixed(2)}</div>
      {data.volume && (
        <div className="tooltip-volume">Vol: {(data.volume / 1000000).toFixed(2)}M</div>
      )}
    </div>
  );
};

const MarketChartCard = ({
  symbol,
  name,
  initialData = null,
  onClose,
  isOpen: marketIsOpen = false,
  hideStatus = false,
  /** Embedded in region panel: tighter layout, optional MW line chart */
  compact = false,
  verticalTimeRanges = false,
  hideOhlc = false,
  lineChart = false,
  hideHeaderSummary = false,
  chartHeight = null
}) => {
  const [range, setRange] = useState('1d');
  const [chartData, setChartData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [availableRanges, setAvailableRanges] = useState(TIME_RANGES.map((r) => r.key));

  const fetchChartData = useCallback(async () => {
    if (!symbol) return;

    const cached = getCachedData(symbol, range);
    if (cached) {
      setChartData(cached);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const data = await MarketDataService.getChartData(symbol, range);

      if (data.error && data.availableRanges) {
        setAvailableRanges(data.availableRanges);
        if (!data.availableRanges.includes(range)) {
          setRange(data.availableRanges[0]);
          return;
        }
      }

      if (data && !data.error) {
        setCachedData(symbol, range, data);
      }

      setChartData(data);
    } catch (err) {
      console.error(`Error fetching chart data for ${symbol}:`, err);
      setError('Failed to load chart data');
    } finally {
      setLoading(false);
    }
  }, [symbol, range]);

  useEffect(() => {
    fetchChartData();
  }, [fetchChartData]);

  const isPositive = useMemo(() => {
    if (chartData?.current?.change != null && chartData.current.change !== '') {
      return parseFloat(chartData.current.change) >= 0;
    }
    if (initialData?.change != null && initialData.change !== '') {
      const n = parseFloat(String(initialData.change).replace(/[^0-9.-]/g, ''));
      return Number.isFinite(n) ? n >= 0 : true;
    }
    return true;
  }, [chartData, initialData]);

  const gradientColor = isPositive ? '#16a34a' : '#dc2626';
  const gradientId = `chartGradient-${symbol}-${isPositive ? 'up' : 'down'}`;

  const yDomain = useMemo(() => {
    if (!chartData?.chartData || chartData.chartData.length === 0) {
      return ['auto', 'auto'];
    }

    const prices = chartData.chartData.map((d) => d.close).filter((p) => p != null);
    if (prices.length === 0) return ['auto', 'auto'];

    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const padding = (max - min) * 0.1;

    return [min - padding, max + padding];
  }, [chartData]);

  const previousClose = useMemo(() => {
    if (!chartData?.current?.previousClose) return null;
    return parseFloat(chartData.current.previousClose);
  }, [chartData]);

  const currentPrice = chartData?.current?.price || initialData?.price || '--';
  const currentChange = chartData?.current?.change || initialData?.change || '--';
  const currentChangePercent = chartData?.current?.changePercent || initialData?.changePercent || '--';

  const chartUpdatedAt = useMemo(() => {
    if (chartData?.meta?.lastUpdated) {
      return chartData.meta.lastUpdated;
    }
    if (chartData?.chartData && chartData.chartData.length > 0) {
      const lastPoint = chartData.chartData[chartData.chartData.length - 1];
      return lastPoint.timestamp;
    }
    return null;
  }, [chartData]);

  const quoteUpdatedAt = useMemo(() => {
    return chartData?.current?.timestamp || null;
  }, [chartData]);

  const sources = useMemo(() => {
    const result = [];
    if (chartUpdatedAt) {
      result.push({
        id: 'chart',
        label: 'Chart data',
        updatedAt: chartUpdatedAt,
        status: getSourceFreshness(chartUpdatedAt, SOURCE_POLL_INTERVALS.chartData)
      });
    }
    if (quoteUpdatedAt) {
      result.push({
        id: 'quote',
        label: 'Current quote',
        updatedAt: quoteUpdatedAt,
        status: getSourceFreshness(quoteUpdatedAt, SOURCE_POLL_INTERVALS.multiRegionQuotes)
      });
    }
    return result;
  }, [chartUpdatedAt, quoteUpdatedAt]);

  const lastUpdated = useMemo(() => {
    if (sources.length === 0) return null;
    return getMinTimestamp(sources.map((s) => s.updatedAt));
  }, [sources]);

  const resolvedChartHeight = chartHeight ?? (compact ? 160 : 120);

  const rangeButtons = TIME_RANGES.map(({ key, label }) => {
    const isDisabled = !availableRanges.includes(key);
    return (
      <button
        key={key}
        type="button"
        className={`chart-tab ${range === key ? 'active' : ''} ${isDisabled ? 'disabled' : ''}`}
        onClick={() => !isDisabled && setRange(key)}
        disabled={isDisabled}
        title={isDisabled ? 'Data not available for this time range' : `Show ${label} data`}
      >
        {label}
      </button>
    );
  });

  const chartMargins = compact
    ? { top: 4, right: 4, left: 0, bottom: 4 }
    : { top: 5, right: 5, left: 5, bottom: 5 };

  const showPrevCloseLine = previousClose != null && Number.isFinite(previousClose) && range === '1d';

  const chartInner =
    loading ? (
      <LoadingIndicator label="Loading chart…" size="md" centered className="chart-loading" />
    ) : error ? (
      <div className="chart-error">{error}</div>
    ) : chartData?.chartData && chartData.chartData.length > 0 ? (
      <ResponsiveContainer width="100%" height={resolvedChartHeight}>
        {lineChart ? (
          <LineChart data={chartData.chartData} margin={chartMargins}>
            <XAxis
              dataKey="timestamp"
              tickFormatter={(ts) => formatXAxis(ts, range)}
              tick={{ fontSize: 9, fill: '#6b7280' }}
              axisLine={{ stroke: '#e5e7eb' }}
              tickLine={false}
              interval="preserveStartEnd"
              minTickGap={40}
            />
            <YAxis
              orientation="right"
              domain={yDomain}
              tick={{ fontSize: 9, fill: '#6b7280' }}
              axisLine={false}
              tickLine={false}
              tickFormatter={(value) => value.toFixed(2)}
              width={44}
            />
            {showPrevCloseLine && (
              <ReferenceLine
                y={previousClose}
                stroke={MW_PREV_CLOSE_STROKE}
                strokeWidth={1}
              />
            )}
            <Tooltip content={<CustomTooltip range={range} />} />
            <Line
              type="monotone"
              dataKey="close"
              stroke={MW_LINE_STROKE}
              strokeWidth={1.5}
              dot={false}
              activeDot={{ r: 3, fill: MW_LINE_STROKE }}
            />
          </LineChart>
        ) : (
          <AreaChart data={chartData.chartData} margin={chartMargins}>
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={gradientColor} stopOpacity={0.3} />
                <stop offset="100%" stopColor={gradientColor} stopOpacity={0.05} />
              </linearGradient>
            </defs>

            <XAxis
              dataKey="timestamp"
              tickFormatter={(ts) => formatXAxis(ts, range)}
              tick={{ fontSize: 9, fill: '#6b7280' }}
              axisLine={{ stroke: '#e5e7eb' }}
              tickLine={false}
              interval="preserveStartEnd"
              minTickGap={40}
            />

            <YAxis
              domain={yDomain}
              tick={{ fontSize: 9, fill: '#6b7280' }}
              axisLine={false}
              tickLine={false}
              tickFormatter={(value) => value.toFixed(2)}
              width={45}
            />

            {showPrevCloseLine && (
              <ReferenceLine
                y={previousClose}
                stroke="#9ca3af"
                strokeDasharray="3 3"
                strokeWidth={1}
              />
            )}

            <Tooltip content={<CustomTooltip range={range} />} />

            <Area
              type="monotone"
              dataKey="close"
              stroke={gradientColor}
              strokeWidth={1.5}
              fill={`url(#${gradientId})`}
              dot={false}
              activeDot={{ r: 3, fill: gradientColor }}
            />
          </AreaChart>
        )}
      </ResponsiveContainer>
    ) : (
      <div className="chart-no-data">No data available</div>
    );

  return (
    <div
      className={[
        'market-chart-card',
        isPositive ? 'positive' : 'negative',
        compact ? 'market-chart-card--compact' : '',
        verticalTimeRanges ? 'market-chart-card--vertical-ranges' : '',
        lineChart ? 'market-chart-card--line' : ''
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {!hideHeaderSummary && (
        <>
          <div className="chart-header">
            <div className="chart-header-left">
              {!hideStatus && lastUpdated && (
                <StatusDot
                  updatedAt={lastUpdated}
                  status={marketIsOpen ? 'active' : 'inactive'}
                  size={10}
                  className="mr-1"
                  label={name || symbol}
                  emoji={marketIsOpen ? '🟢' : '🔴'}
                  sources={sources}
                />
              )}
              <span className="chart-symbol">{name || symbol}</span>
            </div>
            <div className="chart-header-right">
              <span className="chart-price">{currentPrice}</span>
              {onClose && (
                <button type="button" className="chart-close-btn" onClick={onClose} title="Close">
                  ✕
                </button>
              )}
            </div>
          </div>

          <div className={`chart-change ${isPositive ? 'positive' : 'negative'}`}>
            <span className="change-arrow">{isPositive ? '▲' : '▼'}</span>
            <span className="change-value">{currentChange}</span>
            <span className="change-percent">({currentChangePercent}%)</span>
            <span className="change-period">today</span>
          </div>
        </>
      )}

      {!verticalTimeRanges && <div className="chart-tabs">{rangeButtons}</div>}

      <div className="market-chart-card-main">
        <div className="chart-container">{chartInner}</div>
        {verticalTimeRanges && <div className="chart-tabs chart-tabs--vertical">{rangeButtons}</div>}
      </div>

      {!hideOhlc && chartData?.ohlc && (
        <div className="chart-ohlc">
          <div className="ohlc-item">
            <span className="ohlc-label">Open</span>
            <span className="ohlc-value">{chartData.ohlc.open || '--'}</span>
          </div>
          <div className="ohlc-item">
            <span className="ohlc-label">High</span>
            <span className="ohlc-value">{chartData.ohlc.high || '--'}</span>
          </div>
          <div className="ohlc-item">
            <span className="ohlc-label">Low</span>
            <span className="ohlc-value">{chartData.ohlc.low || '--'}</span>
          </div>
          <div className="ohlc-item">
            <span className="ohlc-label">Prev close</span>
            <span className="ohlc-value">{chartData.current?.previousClose || '--'}</span>
          </div>
        </div>
      )}
    </div>
  );
};

export default MarketChartCard;
