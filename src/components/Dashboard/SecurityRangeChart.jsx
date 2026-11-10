import React, { useEffect, useState } from 'react';
import { CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { MarketDataService } from '../../services/api/marketDataService';

const POSITIVE = 'var(--dashboard-positive, #059669)';
const NEGATIVE = 'var(--dashboard-negative, #dc2626)';
const INK = 'var(--analyst-ink, #172033)';
const shortDate = value => new Date(`${value}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** Closes against the published range in force each session, wide and short for an expanded row. */
export default function SecurityRangeChart({ symbol }) {
  const [rows, setRows] = useState(null);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    Promise.resolve().then(() => MarketDataService.getRiskRangeChart(symbol, { signal: controller.signal }))
      .then(payload => { if (active) setRows(Array.isArray(payload?.rows) ? payload.rows : []); })
      .catch(() => { if (active) setRows([]); });
    return () => { active = false; controller.abort(); };
  }, [symbol]);
  if (!rows?.some(row => row.low !== null)) return null;
  return <div className="security-range-chart" aria-label={`${symbol} price against its Risk Range`}>
    <ResponsiveContainer width="100%" height="100%">
      <ComposedChart data={rows} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke="var(--analyst-border, #c9d1db)" strokeOpacity={0.5} />
        <XAxis dataKey="date" tickFormatter={shortDate} minTickGap={48} tick={{ fontSize: 10 }} />
        <YAxis domain={['auto', 'auto']} width={38} tick={{ fontSize: 10 }} tickCount={4} />
        <Tooltip labelFormatter={shortDate} formatter={value => (typeof value === 'number' ? value.toFixed(2) : value)} />
        <Line type="stepAfter" dataKey="high" name="Range high" stroke={POSITIVE} strokeDasharray="3 3" strokeWidth={1} dot={false} connectNulls isAnimationActive={false} />
        <Line type="stepAfter" dataKey="low" name="Range low" stroke={NEGATIVE} strokeDasharray="3 3" strokeWidth={1} dot={false} connectNulls isAnimationActive={false} />
        <Line type="monotone" dataKey="close" name="Close" stroke={INK} strokeWidth={1.5} dot={false} isAnimationActive={false} />
      </ComposedChart>
    </ResponsiveContainer>
  </div>;
}
