import React from 'react';
import {
  TrendingUp,
  BarChart2,
  Link as LinkIcon,
  Activity,
  Target,
  TrendingDown,
  Scale,
  ShieldAlert
} from 'lucide-react';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine
} from 'recharts';
import {
  PERFORMANCE_DEFINITIONS,
  formatPerformanceValue,
} from '../../utils/portfolioPerformanceUtils';

const formatMoney = (v) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v || 0);

const BetaIcon = () => (
  <span className="font-serif italic text-lg" style={{ lineHeight: 1 }}>β</span>
);

const getMetricIcon = (key) => {
  switch (key) {
    case 'annualizedReturn': return <TrendingUp size={18} />;
    case 'sharpeRatio': return <BarChart2 size={18} />;
    case 'sp500Correlation': return <LinkIcon size={18} />;
    case 'standardDeviation': return <Activity size={18} />;
    case 'sortinoRatio': return <Target size={18} />;
    case 'sp500Beta': return <BetaIcon />;
    case 'maxDrawdown': return <TrendingDown size={18} className="text-red-500" />;
    case 'gainToPainRatio': return <Scale size={18} />;
    case 'downsideDeviation': return <ShieldAlert size={18} />;
    default: return <Activity size={18} />;
  }
};

const SummaryCard = ({ metricKey }) => {
  const definition = PERFORMANCE_DEFINITIONS[metricKey];
  const metric = { value: null, format: 'percent' };
  if (!definition || !metric) return null;

  const valStr = formatPerformanceValue(metric.value, metric.format);
  const isNegative = metric.value < 0;

  return (
    <div className="flex items-center gap-4 bg-white dark:bg-gray-800 p-3 rounded-lg border border-[#e5e7eb] dark:border-gray-700 shadow-sm relative group cursor-help transition-all">
      <div className="flex-shrink-0 w-10 h-10 rounded-full bg-white dark:bg-gray-700 border border-[#e5e7eb] dark:border-gray-600 flex items-center justify-center text-gray-600 dark:text-gray-300">
        {getMetricIcon(metricKey)}
      </div>
      <div className="flex flex-col">
        <span className="text-[11px] text-gray-500 dark:text-gray-400 font-medium mb-0.5">
          {definition.label}
        </span>
        <span className={`text-xl font-bold font-serif ${isNegative ? 'text-red-600 dark:text-red-400' : 'text-gray-900 dark:text-white'}`}>
          {valStr}
        </span>
      </div>

      {/* Tooltip on hover */}
      <div className="absolute z-10 w-48 p-2 text-xs font-normal text-white bg-gray-900 rounded-lg shadow-lg opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200 bottom-full left-1/2 transform -translate-x-1/2 -translate-y-2 pointer-events-none">
        {definition.definition}
        <div className="absolute top-full left-1/2 transform -translate-x-1/2 mt-0 border-4 border-transparent border-t-gray-900"></div>
      </div>
    </div>
  );
};

const RealizedOutcomeCard = ({ label, value, valueClass }) => (
  <div className="flex-1 flex flex-col items-center justify-center bg-white dark:bg-gray-800 py-4 px-2 rounded-lg border border-[#e5e7eb] dark:border-gray-700 shadow-sm">
    <span className="text-[11px] text-gray-500 dark:text-gray-400 font-medium mb-1 text-center">
      {label}
    </span>
    <span className={`text-lg font-bold font-serif ${valueClass || 'text-gray-900 dark:text-white'}`}>
      {value}
    </span>
  </div>
);

const PortfolioPerformanceDashboard = ({ isDark = false, realizedKPIs, observedAt = null, loading = false, error = null }) => {
  const summaryLayout = [
    ['annualizedReturn', 'sharpeRatio', 'sp500Correlation'],
    ['standardDeviation', 'sortinoRatio', 'sp500Beta'],
    ['maxDrawdown', 'gainToPainRatio', 'downsideDeviation']
  ];

  // Realized trades alone do not establish total portfolio returns, risk, or
  // benchmark statistics. Keep those capabilities explicitly unavailable until
  // verified account-equity history is connected.
  const trendData = [];
  const monthlyReturns = [{ year: 'unavailable', returns: Array(12).fill(null), total: null }];
  const checkedDate = observedAt && Number.isFinite(Date.parse(observedAt))
    ? new Date(observedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : null;

  return (
    <div className="flex flex-col bg-[#fdfaf4] dark:bg-gray-900 p-6 font-sans min-h-screen text-gray-900 dark:text-white">
      {/* Top Header */}
      <div className="flex justify-between items-baseline mb-4">
        <h1 className="text-3xl font-serif font-bold text-gray-900 dark:text-white m-0 tracking-tight">Performance</h1>
        <div className="text-[10px] text-gray-500 dark:text-gray-400 uppercase tracking-widest font-medium">
          {checkedDate ? `Realized history checked ${checkedDate}` : 'Verified performance history unavailable'}
        </div>
      </div>

      <p role="status">{loading ? 'Loading verified realized history…' : error || 'Portfolio returns and risk metrics require verified account-equity history.'}</p>

      <div className="border border-[#e5e7eb] dark:border-gray-700 rounded-xl p-5 bg-white dark:bg-gray-800/50 shadow-sm flex flex-col gap-6">

        {/* Performance Summary */}
        <div>
          <h2 className="text-[11px] font-bold tracking-widest text-gray-600 dark:text-gray-400 uppercase mb-3">Performance Summary</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {summaryLayout.map((row) =>
              row.map((key) => (
                <SummaryCard key={key} metricKey={key} isDark={isDark} />
              ))
            )}
          </div>
        </div>

        {/* Middle Row: Monthly Returns & Trend */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          {/* Monthly Returns */}
          <div>
            <h2 className="text-[11px] font-bold tracking-widest text-gray-600 dark:text-gray-400 uppercase mb-3">Monthly Returns</h2>
            <div className="bg-white dark:bg-gray-800 rounded-lg border border-[#e5e7eb] dark:border-gray-700 shadow-sm overflow-hidden h-[180px]">
              <table className="w-full text-center border-collapse h-full">
                <thead>
                  <tr className="border-b border-[#e5e7eb] dark:border-gray-700 bg-white dark:bg-gray-800/80">
                    {['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'].map(m => (
                      <th key={m} className="py-3 px-1 text-[10px] font-medium text-gray-500 dark:text-gray-400 border-r border-[#e5e7eb] dark:border-gray-700 last:border-r-0 w-[7.69%]">
                        {m}
                      </th>
                    ))}
                    <th className="py-3 px-2 text-[10px] font-bold text-red-700 dark:text-red-400 bg-white dark:bg-gray-800 w-[7.69%]">
                      TOTAL
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {monthlyReturns.map((row) => (
                    <tr key={row.year} className="bg-white dark:bg-gray-800 h-full">
                      {row.returns.map((val, i) => (
                        <td key={i} className="py-4 px-1 border-r border-[#e5e7eb] dark:border-gray-700 last:border-r-0 align-top pt-6">
                          <span className={`text-[11px] font-bold ${val > 0 ? 'text-green-600 dark:text-green-400' : val < 0 ? 'text-red-600 dark:text-red-400' : 'text-gray-400 dark:text-gray-500'}`}>
                            {val !== null ? `${val}%` : '–'}
                          </span>
                        </td>
                      ))}
                      <td className="py-4 px-2 align-top pt-6 border-l border-[#e5e7eb] dark:border-gray-700 bg-[#fdfaf4] dark:bg-gray-800/50">
                        <span className="text-[11px] font-bold text-gray-900 dark:text-white">
                          {row.total == null ? '—' : `${row.total}%`}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Performance Trend */}
          <div>
            <h2 className="text-[11px] font-bold tracking-widest text-gray-600 dark:text-gray-400 uppercase mb-3 flex justify-between items-center">
              <span>Performance Trend</span>
              <div className="bg-white dark:bg-gray-800 px-3 py-1 rounded-md border border-[#e5e7eb] dark:border-gray-700 flex flex-col items-center shadow-sm">
                <span className="text-[8px] text-gray-400 uppercase tracking-widest leading-none mb-1">YTD Total</span>
                <span className="text-[13px] font-bold font-serif leading-none">—</span>
              </div>
            </h2>
            <div className="bg-white dark:bg-gray-800 rounded-lg border border-[#e5e7eb] dark:border-gray-700 shadow-sm p-4 h-[180px]">
              <p>Verified account-equity history unavailable.</p>
              {trendData.length > 0 && <ResponsiveContainer width="100%" height="100%">
                <LineChart data={trendData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={isDark ? '#374151' : '#e5dfce'} />
                  <XAxis
                    dataKey="month"
                    axisLine={{ stroke: isDark ? '#4b5563' : '#d1d5db' }}
                    tickLine={false}
                    tick={{ fontSize: 10, fill: isDark ? '#9ca3af' : '#6b7280' }}
                    dy={10}
                  />
                  <YAxis
                    axisLine={false}
                    tickLine={false}
                    tickFormatter={(v) => `${v}%`}
                    tick={{ fontSize: 10, fill: isDark ? '#9ca3af' : '#6b7280' }}
                    domain={[-20, 30]}
                    ticks={[-20, -10, 0, 10, 20, 30]}
                  />
                  <ReferenceLine y={0} stroke={isDark ? '#6b7280' : '#9ca3af'} strokeWidth={1} />
                  <Tooltip
                    formatter={(value) => [`${value}%`, 'Return']}
                    contentStyle={{ borderRadius: '8px', fontSize: '12px', border: 'none', boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1)' }}
                  />
                  <Line
                    type="linear"
                    dataKey="value"
                    stroke="#cda875"
                    strokeWidth={2}
                    dot={{ r: 3, fill: '#ffffff', stroke: '#cda875', strokeWidth: 2 }}
                    activeDot={{ r: 5, fill: '#cda875' }}
                  />
                </LineChart>
              </ResponsiveContainer>}
            </div>
          </div>
        </div>

        {/* Realized Trade Outcomes */}
        <div>
          <h2 className="text-[11px] font-bold tracking-widest text-gray-600 dark:text-gray-400 uppercase mb-3">Realized Trade Outcomes (YTD)</h2>
          <div className="flex gap-3">
            <RealizedOutcomeCard
              label="Net Realized P/L"
              value={realizedKPIs ? formatMoney(realizedKPIs.netRealized) : '—'}
              valueClass={realizedKPIs ? (realizedKPIs.netRealized >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400') : 'text-red-600'}
            />
            <RealizedOutcomeCard
              label="Total Gains"
              value={realizedKPIs ? formatMoney(realizedKPIs.totalGains) : '—'}
              valueClass="text-green-600 dark:text-green-400"
            />
            <RealizedOutcomeCard
              label="Total Losses"
              value={realizedKPIs ? formatMoney(realizedKPIs.totalLosses) : '—'}
              valueClass="text-red-600 dark:text-red-400"
            />
            <RealizedOutcomeCard
              label="Win Rate"
              value={realizedKPIs ? `${realizedKPIs.winRate.toFixed(1)}%` : '—'}
            />
            <RealizedOutcomeCard
              label="Profit Factor"
              value={realizedKPIs ? (realizedKPIs.profitFactor === Infinity ? '∞' : realizedKPIs.profitFactor.toFixed(2)) : '—'}
            />
          </div>
        </div>

      </div>
    </div>
  );
};

export default PortfolioPerformanceDashboard;
