import React, { useMemo, useState } from 'react';
import {
  ResponsiveContainer,
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ComposedChart,
  Bar,
  Line,
  ReferenceArea,
  Cell
} from 'recharts';
import { filterLotsBySearch, computeKPIs, aggregateDailyPnL } from '../../utils/realizedGainLossUtils';

function closedDateToUtcNoonMs(isoDate) {
  if (!isoDate || typeof isoDate !== 'string') return NaN;
  const [y, m, d] = isoDate.split('-').map(Number);
  if (!y || !m || !d) return NaN;
  return Date.UTC(y, m - 1, d, 12, 0, 0);
}

const formatMoney = (v) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v || 0);
const formatPct = (v) => new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v || 0) + '%';
const formatCompactYTick = (v) => {
  return new Intl.NumberFormat('en-US', {
    notation: 'compact',
    compactDisplay: 'short',
    maximumFractionDigits: 1,
  }).format(v);
};

const RealizedKPICell = ({ title, value, valueClass }) => (
  <div className="flex justify-between items-center py-2.5 px-4 group">
    <div className="text-xs font-bold text-gray-800 dark:text-gray-200">
      {title}
    </div>
    <div className={`text-xs font-bold font-mono tracking-wide ${valueClass || 'text-gray-900 dark:text-white'}`}>
      {value}
    </div>
  </div>
);

const RealizedGainLossDashboard = ({ lots = [], searchQuery = '', loading = false, error = null, isDark = false }) => {
  const [view, setView] = useState('overview'); // 'overview' | 'explore'
  const [metric, setMetric] = useState('dollar'); // 'dollar' | 'percent'
  const [glFilter, setGlFilter] = useState('ALL'); // 'ALL' | 'GAIN' | 'LOSS'
  
  const [dateRange, setDateRange] = useState('ALL');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');

  const filteredLots = useMemo(
    () => filterLotsBySearch(lots, searchQuery),
    [lots, searchQuery]
  );

  const dateFilteredLots = useMemo(() => {
    let result = filteredLots;

    // Date range filter
    if (!(dateRange === 'ALL' && !customStart && !customEnd)) {
      let minTime = -Infinity;
      let maxTime = Infinity;
      const now = Date.now();
      const dayMs = 24 * 60 * 60 * 1000;

      if (dateRange === 'CUSTOM') {
        minTime = customStart ? closedDateToUtcNoonMs(customStart) : -Infinity;
        maxTime = customEnd ? closedDateToUtcNoonMs(customEnd) + dayMs - 1 : Infinity;
      } else if (dateRange !== 'ALL') {
        maxTime = now;
        if (dateRange === '1D') minTime = now - dayMs;
        else if (dateRange === '5D') minTime = now - 5 * dayMs;
        else if (dateRange === '15D') minTime = now - 15 * dayMs;
        else if (dateRange === '30D') minTime = now - 30 * dayMs;
        else if (dateRange === '60D') minTime = now - 60 * dayMs;
        else if (dateRange === '90D') minTime = now - 90 * dayMs;
        else if (dateRange === '180D') minTime = now - 180 * dayMs;
        else if (dateRange === '1Y') minTime = now - 365 * dayMs;
        else if (dateRange === '3Y') minTime = now - 3 * 365 * dayMs;
        else if (dateRange === '5Y') minTime = now - 5 * 365 * dayMs;
      }

      result = result.filter((lot) => {
        const t = closedDateToUtcNoonMs(lot.closedDate);
        if (!Number.isFinite(t)) return false;
        return t >= minTime && t <= maxTime;
      });
    }

    // G/L filter
    if (glFilter === 'GAIN') {
      result = result.filter(lot => (Number(lot.gainLossDollar) || 0) > 0);
    } else if (glFilter === 'LOSS') {
      result = result.filter(lot => (Number(lot.gainLossDollar) || 0) < 0);
    }

    return result;
  }, [filteredLots, dateRange, customStart, customEnd, glFilter]);

  const kpis = useMemo(() => computeKPIs(dateFilteredLots), [dateFilteredLots]);
  const overviewData = useMemo(() => aggregateDailyPnL(dateFilteredLots), [dateFilteredLots]);

  // Scatter chart data
  const scatterData = useMemo(() => {
    const rows = dateFilteredLots
      .map((lot) => {
        const x = closedDateToUtcNoonMs(lot.closedDate);
        const gainLossDollar = Number(lot.gainLossDollar) || 0;
        const gainLossPercent = Number(lot.gainLossPercent) || 0;
        const y = metric === 'dollar' ? gainLossDollar : gainLossPercent;
        
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        return {
          ...lot,
          x,
          y,
          gainLossDollar,
          gainLossPercent,
        };
      })
      .filter(Boolean);

    const absValues = rows.map((r) => Math.abs(r.gainLossDollar));
    const maxAbs = absValues.length ? Math.max(...absValues, 1) : 1;

    return rows.map((r) => ({ ...r, maxAbsDollar: maxAbs }));
  }, [dateFilteredLots, metric]);

  const yDomainScatter = useMemo(() => {
    if (!scatterData.length) return [-100, 100];
    const ys = scatterData.map((d) => d.y);
    let lo = Math.min(...ys);
    let hi = Math.max(...ys);
    const pad = Math.max((hi - lo) * 0.12, 5);
    return [lo - pad, hi + pad];
  }, [scatterData]);

  const xDomainScatter = useMemo(() => {
    if (!scatterData.length) return [0, 1];
    const xs = scatterData.map((d) => d.x);
    const min = Math.min(...xs);
    const max = Math.max(...xs);
    const span = max - min || 86400000;
    const pad = span * 0.04;
    return [min - pad, max + pad];
  }, [scatterData]);

  // Styles
  const gridStroke = isDark ? '#374151' : '#e5e7eb';
  const axisStroke = isDark ? '#9ca3af' : '#6b7280';
  const tickFill = isDark ? '#d1d5db' : '#4b5563';

  const renderBubble = (props) => {
    const { cx, cy, payload } = props;
    if (cx == null || cy == null || !payload) return null;
    const maxAbs = payload.maxAbsDollar || 1;
    const abs = Math.abs(payload.gainLossDollar || 0);
    // Base size smaller, highlight outliers
    const isOutlier = abs > maxAbs * 0.8;
    const r = maxAbs > 0 ? 3 + (abs / maxAbs) * 12 : 5;
    const gain = payload.gainLossDollar || 0;
    
    const fill = gain >= 0 ? 'rgba(34, 197, 94, 0.4)' : 'rgba(239, 68, 68, 0.4)';
    const stroke = gain >= 0 ? '#059669' : '#dc2626';
    const strokeWidth = isOutlier ? 2 : 1;
    
    return <circle cx={cx} cy={cy} r={r} fill={fill} stroke={stroke} strokeWidth={strokeWidth} />;
  };

  const formatXTick = (ts) => {
    if (!Number.isFinite(ts)) return '';
    const d = new Date(ts);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  const RANGES = ['ALL', '1D', '5D', '15D', '30D', '60D', '90D', '180D', '1Y', '3Y', '5Y', 'CUSTOM'];

  // Top Movers
  const topMovers = useMemo(() => {
    return [...dateFilteredLots]
      .sort((a, b) => Math.abs(Number(b.gainLossDollar) || 0) - Math.abs(Number(a.gainLossDollar) || 0))
      .slice(0, 15);
  }, [dateFilteredLots]);

  if (loading) return <div className="p-4 text-center text-gray-500">Loading Realized Gain/Loss data...</div>;
  if (error) return <div className="p-4 text-center text-red-500 bg-red-50 rounded-lg">{error}</div>;

  return (
    <div className="flex flex-col gap-3 mb-4">

      <div
        className="realized-gl-chart-card rounded-lg border border-[#e5e7eb] dark:border-gray-600 overflow-hidden"
        style={{ backgroundColor: isDark ? '#1f2937' : '#ffffff' }}
      >
        {/* Header & Controls */}
        <div
          className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 px-3 py-2 border-b border-[#e5e7eb] dark:border-gray-600"
          style={{ backgroundColor: isDark ? '#111827' : '#f9fafb' }}
        >
          <div>
            <h2 className="text-base font-bold text-gray-900 dark:text-white m-0 leading-tight">
              Realized Gain/Loss Analysis
            </h2>
          </div>
          
          <div className="flex items-center gap-2">
            <div className="flex rounded-md shadow-sm" role="group">
              <button
                onClick={() => setView('overview')}
                className={`px-3 py-1 text-xs font-medium rounded-l-lg border ${
                  view === 'overview'
                    ? 'bg-blue-600 text-white border-blue-600'
                    : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50 dark:bg-gray-800 dark:text-gray-300 dark:border-gray-600 dark:hover:bg-gray-700'
                }`}
              >
                Overview
              </button>
              <button
                onClick={() => setView('explore')}
                className={`px-3 py-1 text-xs font-medium rounded-r-lg border-t border-b border-r ${
                  view === 'explore'
                    ? 'bg-blue-600 text-white border-blue-600'
                    : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50 dark:bg-gray-800 dark:text-gray-300 dark:border-gray-600 dark:hover:bg-gray-700'
                }`}
              >
                Explore Trades
              </button>
            </div>
          </div>
        </div>

        {/* Filters */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 px-3 py-2 border-b border-[#e5e7eb] dark:border-gray-600">
          <div className="flex items-center flex-wrap gap-1">
            {RANGES.map(range => (
              <button
                key={range}
                onClick={() => setDateRange(range)}
                className={`px-2 py-1 text-xs font-medium rounded-md transition-colors ${
                  dateRange === range
                    ? 'bg-blue-600 text-white shadow-sm'
                    : 'text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 bg-transparent'
                }`}
              >
                {range}
              </button>
            ))}
            {dateRange === 'CUSTOM' && (
              <div className="flex items-center gap-1 ml-2 bg-white dark:bg-gray-800 px-2 py-1 rounded-md border border-gray-200 dark:border-gray-700">
                <input
                  type="date"
                  value={customStart}
                  onChange={e => setCustomStart(e.target.value)}
                  className="bg-transparent text-xs text-gray-700 dark:text-gray-300 outline-none"
                />
                <span className="text-gray-400 text-xs">to</span>
                <input
                  type="date"
                  value={customEnd}
                  onChange={e => setCustomEnd(e.target.value)}
                  className="bg-transparent text-xs text-gray-700 dark:text-gray-300 outline-none"
                />
              </div>
            )}
          </div>
          
          <div className="flex items-center gap-3">
            {view === 'explore' && (
              <div className="flex items-center gap-1 text-xs">
                <span className="text-gray-500 dark:text-gray-400">Metric:</span>
                <select
                  value={metric}
                  onChange={(e) => setMetric(e.target.value)}
                  className="bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded px-1.5 py-0.5 text-gray-700 dark:text-gray-300 outline-none"
                >
                  <option value="dollar">Dollar ($)</option>
                  <option value="percent">Percent (%)</option>
                </select>
              </div>
            )}
            
            <div className="flex items-center gap-1 text-xs">
              <span className="text-gray-500 dark:text-gray-400">Filter:</span>
              <select
                value={glFilter}
                onChange={(e) => setGlFilter(e.target.value)}
                className="bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded px-1.5 py-0.5 text-gray-700 dark:text-gray-300 outline-none"
              >
                <option value="ALL">All Trades</option>
                <option value="GAIN">Gains Only</option>
                <option value="LOSS">Losses Only</option>
              </select>
            </div>
          </div>
        </div>

        {/* Charts */}
        <div className="w-full px-1 pb-2 pt-4">
          {dateFilteredLots.length === 0 ? (
            <div className="px-3 py-10 text-sm text-gray-600 dark:text-gray-400 text-center">
              No realized gain/loss lots match your filters.
            </div>
          ) : (
            <>
              {view === 'overview' && (
                <ResponsiveContainer width="100%" height={320}>
                  <ComposedChart data={overviewData} margin={{ top: 10, right: 20, left: 20, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} vertical={false} />
                    <XAxis 
                      dataKey="date" 
                      tickFormatter={(v) => {
                        const d = new Date(v + 'T12:00:00Z');
                        return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                      }}
                      stroke={axisStroke} 
                      tick={{ fill: tickFill, fontSize: 10 }}
                    />
                    <YAxis 
                      yAxisId="left"
                      tickFormatter={(v) => formatCompactYTick(v)}
                      stroke={axisStroke} 
                      tick={{ fill: tickFill, fontSize: 10 }}
                      width={60}
                    />
                    <YAxis 
                      yAxisId="right" 
                      orientation="right" 
                      tickFormatter={(v) => formatCompactYTick(v)}
                      stroke={axisStroke} 
                      tick={{ fill: tickFill, fontSize: 10 }}
                      width={60}
                    />
                    <Tooltip
                      content={({ active, payload, label }) => {
                        if (!active || !payload || !payload.length) return null;
                        return (
                          <div className="rounded-md px-3 py-2 shadow-md text-xs bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700">
                            <div className="font-semibold text-gray-900 dark:text-white mb-1">{label}</div>
                            {payload.map(p => (
                              <div key={p.dataKey} className="flex items-center justify-between gap-4 mt-1">
                                <div className="flex items-center gap-1.5">
                                  <span style={{ color: p.color }}>●</span>
                                  <span className="text-gray-600 dark:text-gray-300">{p.name}:</span>
                                </div>
                                <span className={`font-medium ${Number(p.value) >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                                  {formatMoney(p.value)}
                                </span>
                              </div>
                            ))}
                          </div>
                        );
                      }}
                    />
                    <ReferenceLine yAxisId="left" y={0} stroke={isDark ? '#4b5563' : '#9ca3af'} strokeWidth={1.5} />
                    <Bar yAxisId="left" dataKey="dailyPnL" name="Daily P/L">
                      {overviewData.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={entry.dailyPnL >= 0 ? '#059669' : '#dc2626'} />
                      ))}
                    </Bar>
                    <Line yAxisId="right" type="monotone" dataKey="cumulativePnL" name="Cumulative P/L" stroke="#3b82f6" strokeWidth={2} dot={false} />
                  </ComposedChart>
                </ResponsiveContainer>
              )}

              {view === 'explore' && (
                <ResponsiveContainer width="100%" height={320}>
                  <ScatterChart margin={{ top: 12, right: 16, left: 4, bottom: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} />
                    <XAxis
                      type="number"
                      dataKey="x"
                      domain={xDomainScatter}
                      tickFormatter={formatXTick}
                      stroke={axisStroke}
                      tick={{ fill: tickFill, fontSize: 10 }}
                      height={36}
                    />
                    <YAxis
                      type="number"
                      dataKey="y"
                      domain={yDomainScatter}
                      tickFormatter={(v) => metric === 'percent' ? `${formatCompactYTick(v)}%` : formatCompactYTick(v)}
                      width={65}
                      stroke={axisStroke}
                      tick={{ fill: tickFill, fontSize: 10 }}
                      label={{
                        value: metric === 'percent' ? '%' : '$',
                        angle: -90,
                        position: 'insideLeft',
                        fill: tickFill,
                        fontSize: 11,
                      }}
                    />
                    <ReferenceArea y1={0} y2={yDomainScatter[1]} fill="rgba(34, 197, 94, 0.05)" />
                    <ReferenceArea y1={yDomainScatter[0]} y2={0} fill="rgba(239, 68, 68, 0.05)" />
                    <ReferenceLine y={0} stroke={isDark ? '#6b7280' : '#374151'} strokeWidth={1.5} />
                    <Tooltip
                      cursor={{ strokeDasharray: '3 3' }}
                      content={({ active, payload: items }) => {
                        if (!active || !items || !items.length) return null;
                        const p = items[0].payload;
                        return (
                          <div className="rounded-md px-3 py-2 shadow-md text-xs bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 min-w-[200px]">
                            <div className="font-semibold text-gray-900 dark:text-white border-b border-gray-200 dark:border-gray-700 pb-1 mb-1">
                              {p.symbol} {p.name ? `— ${p.name}` : ''}
                            </div>
                            <div className="grid grid-cols-2 gap-x-3 gap-y-1 mt-1">
                              <span className="text-gray-500">Sold:</span>
                              <span className="text-gray-900 dark:text-gray-100 text-right">{p.closedDate}</span>
                              <span className="text-gray-500">Bought:</span>
                              <span className="text-gray-900 dark:text-gray-100 text-right">{p.openedDate || '—'}</span>
                              <span className="text-gray-500">Quantity:</span>
                              <span className="text-gray-900 dark:text-gray-100 text-right">{p.quantity}</span>
                              <span className="text-gray-500">Cost:</span>
                              <span className="text-gray-900 dark:text-gray-100 text-right">{formatMoney(p.costBasis)}</span>
                              <span className="text-gray-500">Proceeds:</span>
                              <span className="text-gray-900 dark:text-gray-100 text-right">{formatMoney(p.proceeds)}</span>
                              
                              <span className="text-gray-500 font-medium mt-1">P/L ($):</span>
                              <span className={`font-bold text-right mt-1 ${p.gainLossDollar >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                                {formatMoney(p.gainLossDollar)}
                              </span>
                              
                              <span className="text-gray-500 font-medium">P/L (%):</span>
                              <span className={`font-bold text-right ${p.gainLossPercent >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                                {formatPct(p.gainLossPercent)}
                              </span>
                            </div>
                          </div>
                        );
                      }}
                    />
                    <Scatter name="Lots" data={scatterData} shape={renderBubble} isAnimationActive={false} />
                  </ScatterChart>
                </ResponsiveContainer>
              )}
            </>
          )}
        </div>
      </div>

      {/* Biggest Movers Table */}
      {topMovers.length > 0 && (
        <div className="bg-white dark:bg-[#1f2937] border border-[#e5e7eb] dark:border-gray-600 rounded-lg overflow-hidden">
          <div className="px-3 py-2 border-b border-[#e5e7eb] dark:border-gray-600 bg-[#f9fafb] dark:bg-gray-800">
            <h3 className="text-sm font-bold text-gray-900 dark:text-white m-0">Biggest Movers</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left">
              <thead className="bg-gray-50 dark:bg-gray-800 text-gray-500 dark:text-gray-400 uppercase border-b border-gray-200 dark:border-gray-700">
                <tr>
                  <th className="px-3 py-2">Date</th>
                  <th className="px-3 py-2">Symbol</th>
                  <th className="px-3 py-2 text-right">Qty</th>
                  <th className="px-3 py-2 text-right">Cost</th>
                  <th className="px-3 py-2 text-right">Proceeds</th>
                  <th className="px-3 py-2 text-right">P/L ($)</th>
                  <th className="px-3 py-2 text-right">P/L (%)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700/50">
                {topMovers.map((lot, idx) => {
                  const gl = Number(lot.gainLossDollar) || 0;
                  const isGain = gl >= 0;
                  return (
                    <tr key={`${lot.symbol}-${idx}`} className="hover:bg-gray-50 dark:hover:bg-gray-800">
                      <td className="px-3 py-1.5 text-gray-600 dark:text-gray-300">{lot.closedDate}</td>
                      <td className="px-3 py-1.5 font-medium text-gray-900 dark:text-white">{lot.symbol}</td>
                      <td className="px-3 py-1.5 text-right text-gray-600 dark:text-gray-300">{lot.quantity}</td>
                      <td className="px-3 py-1.5 text-right text-gray-600 dark:text-gray-300">{formatMoney(lot.costBasis)}</td>
                      <td className="px-3 py-1.5 text-right text-gray-600 dark:text-gray-300">{formatMoney(lot.proceeds)}</td>
                      <td className={`px-3 py-1.5 text-right font-medium ${isGain ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                        {formatMoney(gl)}
                      </td>
                      <td className={`px-3 py-1.5 text-right font-medium ${isGain ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                        {formatPct(lot.gainLossPercent)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};

export default RealizedGainLossDashboard;
