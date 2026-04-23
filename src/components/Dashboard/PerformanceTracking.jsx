import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Card, Title, Text, Select, SelectItem } from '@tremor/react';
import {
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  ZAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  Cell
} from 'recharts';
import PerformanceService from '../../services/api/performanceService';
import { useTheme } from '../../context/ThemeContext';
import SecurityDetailModal from './SecurityDetailModal';
import './PerformanceTracking.css';

const formatCurrency = (value) => {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0
  }).format(value);
};

const formatPercent = (value) => {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
};

const formatShortDate = (ts) => {
  if (ts == null) return '';
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

const RealizedTooltip = ({ active, payload }) => {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div
      className="rounded-md border border-[#d6d0c3] dark:border-gray-600 bg-[#fcfaf5] dark:bg-gray-800 px-2 py-1.5 text-xs shadow-md max-w-xs"
    >
      <div className="font-semibold text-gray-900 dark:text-white">
        {p.symbol}
        {p.name ? <span className="font-normal text-gray-600 dark:text-gray-400"> — {p.name}</span> : null}
      </div>
      <div className="text-gray-700 dark:text-gray-300 mt-0.5">Closed: {p.closedDate}</div>
      <div className="text-gray-700 dark:text-gray-300">P&amp;L: {formatCurrency(p.gainLossDollar)} ({formatPercent(p.gainLossPercent)})</div>
      <div className="text-gray-600 dark:text-gray-400">Proceeds: {formatCurrency(p.proceeds)} · Qty: {p.quantity}</div>
    </div>
  );
};

const PerformanceTracking = () => {
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedPeriod, setSelectedPeriod] = useState('ytd');
  const [searchQuery, setSearchQuery] = useState('');
  const [data, setData] = useState({ lots: [], count: 0, startDate: '', endDate: '' });
  const [selectedSecurity, setSelectedSecurity] = useState(null);
  const [isModalOpen, setIsModalOpen] = useState(false);

  const fetchLots = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await PerformanceService.getRealizedGainLoss(selectedPeriod, '');
      setData({
        lots: res.lots || [],
        count: 0,
        startDate: res.startDate,
        endDate: res.endDate
      });
    } catch (err) {
      console.error(err);
      setError(err.response?.data?.error || err.message || 'Failed to load realized gain/loss');
      setData({ lots: [], count: 0, startDate: '', endDate: '' });
    } finally {
      setLoading(false);
    }
  }, [selectedPeriod]);

  useEffect(() => {
    fetchLots();
  }, [fetchLots]);

  const filteredLots = useMemo(() => {
    const q = searchQuery.trim().toUpperCase();
    const raw = data.lots || [];
    if (!q) return raw;
    return raw.filter((l) => (l.symbol || '').toUpperCase().includes(q));
  }, [data.lots, searchQuery]);

  const chartData = useMemo(() => {
    return (filteredLots || []).map((l) => ({
      x: new Date(`${l.closedDate}T12:00:00`).getTime(),
      y: l.gainLossPercent,
      z: Math.max(Math.abs(l.proceeds) || 0, 1),
      ...l
    }));
  }, [filteredLots]);

  const yDomain = useMemo(() => {
    if (!chartData.length) return [-100, 100];
    const ys = chartData.map((d) => d.y);
    const lo = Math.min(...ys, 0);
    const hi = Math.max(...ys, 0);
    const pad = Math.max((hi - lo) * 0.1, 5);
    return [lo - pad, hi + pad];
  }, [chartData]);

  const onScatterClick = (e) => {
    if (e && e.symbol) {
      setSelectedSecurity(e.symbol);
      setIsModalOpen(true);
    }
  };

  const gridStroke = isDark ? '#374151' : '#d6d0c3';
  const axisColor = isDark ? '#9ca3af' : '#6b7280';

  return (
    <div
      className="performance-tracking-wrap p-2 space-y-2"
      style={{ backgroundColor: isDark ? '#111827' : '#f8f6ef' }}
    >
      <div className="flex flex-col items-center mb-1">
        <div style={{ width: '100%', maxWidth: '400px' }}>
          <input
            type="text"
            placeholder="Filter by ticker (e.g. AAPL, GLD)…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full px-3 py-1.5 border border-[#d6d0c3] dark:border-gray-600 rounded-lg bg-[#fcfaf5] dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-[#c9c3b6]"
            style={{ fontSize: '14px' }}
          />
        </div>
        <Text className="text-sm text-gray-500 dark:text-gray-400 font-medium mt-1">
          {`Showing ${chartData.length} of ${(data.lots || []).length} lot${(data.lots || []).length === 1 ? '' : 's'}`}
          {data.startDate && data.endDate
            ? ` · ${data.startDate} to ${data.endDate}`
            : ''}
        </Text>
      </div>

      <div className="flex justify-between items-center flex-wrap gap-2 px-1">
        <Title className="text-base m-0">Realized Gain/Loss Details</Title>
        <Select
          value={selectedPeriod}
          onValueChange={setSelectedPeriod}
          className="w-40 scale-90 origin-right"
        >
          <SelectItem value="all">All time</SelectItem>
          <SelectItem value="ytd">YTD</SelectItem>
          <SelectItem value="1y">1 year</SelectItem>
          <SelectItem value="90d">90 days</SelectItem>
          <SelectItem value="30d">30 days</SelectItem>
        </Select>
      </div>

      {error && (
        <Card
          className="rounded-lg p-3"
          style={{ backgroundColor: '#fcfaf5', border: '1px solid #d6d0c3' }}
        >
          <Text className="text-red-600 dark:text-red-400">{error}</Text>
          <Text className="text-xs text-gray-600 dark:text-gray-400 mt-2">
            Upload a Schwab Realized Gain/Loss – Lot Details CSV via S3 (e.g. scripts/upload_realized_gain_loss.py)
            and ensure the RealizedGainLoss DynamoDB table exists. Lambda must run the updated csv_processor.
          </Text>
        </Card>
      )}

      {loading && !error && (
        <Card
          className="rounded-lg p-3 performance-chart-card"
          style={{ backgroundColor: isDark ? '#1f2937' : '#fcfaf5', border: '1px solid #d6d0c3' }}
        >
          <Text>Loading realized gain/loss…</Text>
        </Card>
      )}

      {!loading && !error && (data.lots || []).length === 0 && (
        <Card
          className="rounded-lg p-3"
          style={{ backgroundColor: isDark ? '#1f2937' : '#fcfaf5', border: '1px solid #d6d0c3' }}
        >
          <Text className="text-gray-600 dark:text-gray-400">
            No realized lot data in this range. Export Lot Details from Schwab (Realized gain/loss) and upload to S3.
          </Text>
        </Card>
      )}

      {!loading && !error && (data.lots || []).length > 0 && chartData.length === 0 && (
        <Card
          className="rounded-lg p-3"
          style={{ backgroundColor: isDark ? '#1f2937' : '#fcfaf5', border: '1px solid #d6d0c3' }}
        >
          <Text className="text-gray-600 dark:text-gray-400">
            No lots match that ticker. Clear the search to see all lots in the selected period.
          </Text>
        </Card>
      )}

      {!loading && !error && chartData.length > 0 && (
        <Card
          className="rounded-lg p-2 performance-chart-card"
          style={{ backgroundColor: isDark ? '#1f2937' : '#fcfaf5', border: '1px solid #d6d0c3' }}
        >
          <div className="performance-chart-container">
            <ResponsiveContainer width="100%" height="100%" minHeight={360}>
              <ScatterChart margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} />
                <XAxis
                  type="number"
                  dataKey="x"
                  domain={['dataMin', 'dataMax']}
                  tickFormatter={formatShortDate}
                  stroke={axisColor}
                  fontSize={11}
                />
                <YAxis
                  type="number"
                  dataKey="y"
                  domain={yDomain}
                  tickFormatter={(v) => `${v.toFixed(0)}%`}
                  stroke={axisColor}
                  fontSize={11}
                  width={48}
                />
                <ZAxis
                  dataKey="z"
                  range={[12, 180]}
                  domain={['dataMin', 'dataMax']}
                />
                <ReferenceLine y={0} stroke={isDark ? '#6b7280' : '#9ca3af'} strokeWidth={1} />
                <Tooltip content={<RealizedTooltip />} cursor={{ strokeDasharray: '3 3' }} />
                <Scatter
                  name="Lots"
                  data={chartData}
                  onClick={onScatterClick}
                >
                  {chartData.map((entry) => (
                    <Cell
                      key={entry.lotId}
                      fill={entry.gainLossDollar >= 0
                        ? 'rgba(22, 163, 74, 0.55)'
                        : 'rgba(220, 38, 38, 0.55)'}
                      stroke={entry.gainLossDollar >= 0 ? '#166534' : '#991b1b'}
                      strokeWidth={1}
                    />
                  ))}
                </Scatter>
              </ScatterChart>
            </ResponsiveContainer>
          </div>
          <Text className="text-xs text-gray-500 dark:text-gray-400 mt-1 px-1">
            Each bubble is a closed lot (Schwab export). Click a bubble to open security details. Y = gain/loss %;
            size reflects proceeds.
          </Text>
        </Card>
      )}

      <SecurityDetailModal
        ticker={selectedSecurity}
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
      />
    </div>
  );
};

export default PerformanceTracking;
