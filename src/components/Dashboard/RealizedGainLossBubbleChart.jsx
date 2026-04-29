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
} from 'recharts';
import { filterLotsBySearch } from '../../utils/realizedGainLossUtils';

function closedDateToUtcNoonMs(isoDate) {
  if (!isoDate || typeof isoDate !== 'string') return NaN;
  const [y, m, d] = isoDate.split('-').map(Number);
  if (!y || !m || !d) return NaN;
  return Date.UTC(y, m - 1, d, 12, 0, 0);
}

const RealizedGainLossBubbleChart = ({ lots = [], searchQuery = '', loading = false, error = null, isDark = false }) => {
  const [showChart, setShowChart] = useState(true);

  const filteredLots = useMemo(
    () => filterLotsBySearch(lots, searchQuery),
    [lots, searchQuery]
  );

  const chartData = useMemo(() => {
    const rows = filteredLots
      .map((lot) => {
        const x = closedDateToUtcNoonMs(lot.closedDate);
        const y = Number(lot.gainLossPercent);
        const gainLossDollar = Number(lot.gainLossDollar) || 0;
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        return {
          ...lot,
          x,
          y,
          gainLossDollar,
          gainLossPercent: y,
        };
      })
      .filter(Boolean);

    const absValues = rows.map((r) => Math.abs(r.gainLossDollar));
    const maxAbs = absValues.length ? Math.max(...absValues, 1) : 1;

    return rows.map((r) => ({
      ...r,
      maxAbsDollar: maxAbs,
    }));
  }, [filteredLots]);

  const yDomain = useMemo(() => {
    if (!chartData.length) return [-100, 200];
    const ys = chartData.map((d) => d.y);
    let lo = Math.min(...ys);
    let hi = Math.max(...ys);
    const pad = Math.max((hi - lo) * 0.12, 5);
    lo -= pad;
    hi += pad;
    lo = Math.min(lo, -5);
    hi = Math.max(hi, 5);
    return [lo, hi];
  }, [chartData]);

  const xDomain = useMemo(() => {
    if (!chartData.length) return [0, 1];
    const xs = chartData.map((d) => d.x);
    const min = Math.min(...xs);
    const max = Math.max(...xs);
    const span = max - min || 86400000;
    const pad = span * 0.04;
    return [min - pad, max + pad];
  }, [chartData]);

  const gridStroke = isDark ? '#374151' : '#e5e7eb';
  const axisStroke = isDark ? '#9ca3af' : '#6b7280';
  const tickFill = isDark ? '#d1d5db' : '#4b5563';

  const renderBubble = (props) => {
    const { cx, cy, payload } = props;
    if (cx == null || cy == null || !payload) return null;
    const maxAbs = payload.maxAbsDollar || 1;
    const abs = Math.abs(payload.gainLossDollar || 0);
    const r = maxAbs > 0 ? 5 + (abs / maxAbs) * 20 : 8;
    const gain = payload.gainLossDollar || 0;
    const fill = gain >= 0 ? 'rgba(34, 197, 94, 0.5)' : 'rgba(239, 68, 68, 0.5)';
    const stroke = gain >= 0 ? '#16a34a' : '#dc2626';
    return <circle cx={cx} cy={cy} r={r} fill={fill} stroke={stroke} strokeWidth={1.5} />;
  };

  const formatXTick = (ts) => {
    if (!Number.isFinite(ts)) return '';
    const d = new Date(ts);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  const recordCount = filteredLots.length;

  return (
    <div
      className="realized-gl-chart-card rounded-lg border border-[#d6d0c3] dark:border-gray-600 overflow-hidden mb-3"
      style={{ backgroundColor: isDark ? '#1f2937' : '#fcfaf5' }}
    >
      <div
        className="flex flex-wrap items-start justify-between gap-2 px-3 py-2 border-b border-[#d6d0c3] dark:border-gray-600"
        style={{ backgroundColor: isDark ? '#111827' : '#f3f0e6' }}
      >
        <div>
          <h2 className="text-base font-bold text-gray-900 dark:text-white m-0 leading-tight">
            Realized Gain/Loss Details
          </h2>
          <p className="text-xs text-gray-600 dark:text-gray-400 m-0 mt-0.5">
            {loading ? 'Loading…' : `Chart based on ${recordCount} record${recordCount === 1 ? '' : 's'}.`}
          </p>
        </div>
        <label className="flex items-center gap-2 cursor-pointer select-none text-xs text-gray-700 dark:text-gray-300 shrink-0">
          <span>Show chart</span>
          <button
            type="button"
            role="switch"
            aria-checked={showChart}
            aria-label={showChart ? 'Hide chart' : 'Show chart'}
            onClick={() => setShowChart((v) => !v)}
            className={`relative w-10 h-5 rounded-full transition-colors ${showChart ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'}`}
          >
            <span
              className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${showChart ? 'translate-x-5' : ''}`}
            />
          </button>
        </label>
      </div>

      {error && (
        <div className="px-3 py-2 text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30">
          {error}
        </div>
      )}

      {!loading && !error && lots.length === 0 && (
        <div className="px-3 py-6 text-sm text-gray-600 dark:text-gray-400 text-center">
          No realized gain/loss lots for YTD. Upload Schwab <strong>Realized Gain/Loss – Lot Details</strong> CSV so
          it can be ingested into the system.
        </div>
      )}

      {!loading && !error && lots.length > 0 && recordCount === 0 && (
        <div className="px-3 py-6 text-sm text-gray-600 dark:text-gray-400 text-center">
          No lots match your search. Clear or adjust the search to see bubbles.
        </div>
      )}

      {showChart && !loading && !error && recordCount > 0 && (
        <div className="realized-gl-chart-wrap w-full px-1 pb-2 pt-1">
          <ResponsiveContainer width="100%" height={320}>
            <ScatterChart margin={{ top: 12, right: 16, left: 4, bottom: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} />
              <XAxis
                type="number"
                dataKey="x"
                domain={xDomain}
                tickFormatter={formatXTick}
                stroke={axisStroke}
                tick={{ fill: tickFill, fontSize: 10 }}
                height={36}
              />
              <YAxis
                type="number"
                dataKey="y"
                domain={yDomain}
                tickFormatter={(v) => `${v}%`}
                width={44}
                stroke={axisStroke}
                tick={{ fill: tickFill, fontSize: 10 }}
                label={{
                  value: '%',
                  angle: -90,
                  position: 'insideLeft',
                  fill: tickFill,
                  fontSize: 11,
                }}
              />
              <ReferenceLine y={0} stroke={isDark ? '#6b7280' : '#374151'} strokeWidth={1.5} />
              <Tooltip
                cursor={{ strokeDasharray: '3 3' }}
                content={({ active, payload: items }) => {
                  if (!active || !items || !items.length) return null;
                  const p = items[0].payload;
                  const dollars = p.gainLossDollar != null ? Number(p.gainLossDollar).toFixed(2) : '—';
                  const pct = p.gainLossPercent != null ? Number(p.gainLossPercent).toFixed(2) : '—';
                  return (
                    <div
                      className="rounded-md px-2 py-1.5 shadow-md text-xs"
                      style={{
                        backgroundColor: isDark ? '#1f2937' : '#fff',
                        border: `1px solid ${isDark ? '#4b5563' : '#d6d0c3'}`,
                      }}
                    >
                      <div className="font-semibold text-gray-900 dark:text-white">
                        {p.symbol}
                        {p.name ? ` — ${p.name}` : ''}
                      </div>
                      <div className="text-gray-600 dark:text-gray-300">Closed: {p.closedDate}</div>
                      <div className="text-gray-600 dark:text-gray-300">Gain/Loss: ${dollars}</div>
                      <div className="text-gray-600 dark:text-gray-300">Gain/Loss: {pct}%</div>
                      {p.term ? <div className="text-gray-500 dark:text-gray-400">Term: {p.term}</div> : null}
                    </div>
                  );
                }}
              />
              <Scatter name="Lots" data={chartData} shape={renderBubble} isAnimationActive={false} />
            </ScatterChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
};

export default RealizedGainLossBubbleChart;
