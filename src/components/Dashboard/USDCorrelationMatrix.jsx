import React, { useMemo } from 'react';
import StatusDot from '../common/StatusDot';
import { getSourceFreshness } from '../../utils/timeUtils';
import { USD_METRICS, CORRELATION_PERIODS, REFRESH_INTERVALS } from '../../constants/usdMarket';
import { CorrelationHelpers } from '../../services/api/usdMarketService';
import './USDCorrelationMatrix.css';

const toDateValue = (value) => {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const formatNumeric = (value, digits = 3) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric.toFixed(digits) : '--';
};

const formatPercentValue = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '--';
  const scaled = Math.abs(numeric) <= 1 ? numeric * 100 : numeric;
  return `${Math.round(scaled)}%`;
};

const MetricIcon = ({ symbol }) => {
  switch (symbol) {
    case 'CRB':
      return (
        <span className="usd-metric-badge usd-metric-badge-crb" aria-hidden="true">
          CRB
        </span>
      );
    case 'GOLD':
      return (
        <svg
          className="usd-metric-goldbar"
          viewBox="0 0 24 24"
          aria-hidden="true"
          focusable="false"
        >
          <defs>
            <linearGradient id="goldBarGradient" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#FDE68A" />
              <stop offset="55%" stopColor="#F4B400" />
              <stop offset="100%" stopColor="#B45309" />
            </linearGradient>
          </defs>
          <path
            d="M5 9.5 8.5 6h9L19 9.5v7L15.5 20h-9L5 16.5Z"
            fill="url(#goldBarGradient)"
            stroke="#8A5A00"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
          <path
            d="M8.5 6 12 9.5h7"
            fill="none"
            stroke="rgba(255,255,255,0.65)"
            strokeWidth="1"
            strokeLinejoin="round"
          />
          <path
            d="M12 9.5v7"
            fill="none"
            stroke="rgba(120,72,0,0.35)"
            strokeWidth="1"
          />
        </svg>
      );
    case 'BTC':
      return (
        <span className="usd-metric-btc" aria-hidden="true">
          <span className="usd-metric-btc-symbol">₿</span>
        </span>
      );
    default:
      return <span aria-hidden="true">{symbol === 'BRENT' ? '💧' : '📈'}</span>;
  }
};

/** Positive / negative / neutral by correlation value (font-only styling) */
const getSignClass = (value) => {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return 'usd-neutral';
  }
  const numeric = Number(value);
  if (numeric >= 0.5) return 'usd-positive';
  if (numeric <= -0.5) return 'usd-negative';
  return 'usd-neutral';
};

const getHeatClass = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 'usd-heat-neutral';
  if (numeric >= 0.75) return 'usd-heat-positive-strong';
  if (numeric >= 0.5) return 'usd-heat-positive-medium';
  if (numeric <= -0.75) return 'usd-heat-negative-strong';
  if (numeric <= -0.5) return 'usd-heat-negative-medium';
  return 'usd-heat-neutral';
};

const USDCorrelationMatrix = ({
  correlations,
  rollingStats,
  correlationsTimestamp,
  calculationDate,
  loading,
  error
}) => {
  const hasData = Boolean(correlations && rollingStats);

  const calculationDateTime = useMemo(() => {
    if (!calculationDate) return null;
    return toDateValue(`${calculationDate}T00:00:00Z`);
  }, [calculationDate]);

  const effectiveUpdatedAt = useMemo(() => {
    const timestampDate = toDateValue(correlationsTimestamp);
    return timestampDate || calculationDateTime;
  }, [correlationsTimestamp, calculationDateTime]);

  const freshness = useMemo(
    () =>
      effectiveUpdatedAt
        ? getSourceFreshness(effectiveUpdatedAt, REFRESH_INTERVALS.CORRELATIONS, 1.25, 2.5)
        : 'defective',
    [effectiveUpdatedAt]
  );

  const statusState = useMemo(() => {
    if (error || (!loading && !hasData)) return 'inactive';
    if (loading) return 'stale';
    if (freshness === 'current') return 'active';
    if (freshness === 'stale') return 'stale';
    return 'inactive';
  }, [error, loading, hasData, freshness]);

  const statusEmoji = statusState === 'active' ? '🟢' : statusState === 'stale' ? '🟡' : '🔴';

  const statusSources = useMemo(() => {
    const sources = [];
    if (effectiveUpdatedAt) {
      sources.push({
        id: 'correlations-snapshot',
        label: 'Correlation Snapshot',
        updatedAt: effectiveUpdatedAt,
        status: freshness
      });
    }
    if (calculationDateTime) {
      sources.push({
        id: 'calculation-date',
        label: `Calculation Date (${calculationDate || 'N/A'})`,
        updatedAt: calculationDateTime,
        status: freshness
      });
    }
    return sources;
  }, [effectiveUpdatedAt, freshness, calculationDateTime, calculationDate]);

  return (
    <div className="usd-correlation-panel">
      <div className="usd-correlation-header">
        <div className="usd-correlation-header-main">
          <StatusDot
            updatedAt={effectiveUpdatedAt}
            status={statusState}
            size={10}
            className="mr-1"
            label="USD Correlations"
            emoji={statusEmoji}
            sources={statusSources}
          />
          <span className="region-label">Key USD Correlations</span>
        </div>
      </div>
      <div className="usd-correlation-subheader">
        <span className="usd-correlation-days-note">*Days = Trading Days</span>
        <span className="usd-correlation-rolling-title">52-Wk Rolling 30D Correlation</span>
      </div>

      <div className="usd-correlation-table-wrap">
        {loading ? (
          <div className="usd-correlation-state loading">Loading correlation data...</div>
        ) : null}
        {!loading && error ? (
          <div className="usd-correlation-state error">Error loading correlation data: {error}</div>
        ) : null}
        {!loading && !error && !hasData ? (
          <div className="usd-correlation-state">No correlation data available</div>
        ) : null}

        {!loading && !error && hasData ? (
          <div className="usd-correlation-grid">
            <div className="usd-correlation-header-row">
              <div className="usd-correlation-th usd-correlation-th-metric">METRIC</div>
              {CORRELATION_PERIODS.map((period) => (
                <div key={period} className="usd-correlation-th">
                  {period}D
                </div>
              ))}
              <div className="usd-correlation-th usd-correlation-th-rolling-start usd-correlation-right-header">High</div>
              <div className="usd-correlation-th usd-correlation-right-header">Low</div>
              <div className="usd-correlation-th usd-correlation-right-header usd-correlation-right-stats-start">% Time Pos</div>
              <div className="usd-correlation-th usd-correlation-right-header">% Time Neg</div>
            </div>
            {USD_METRICS.map((metric) => {
              const metricCorrelations = correlations[metric.symbol] || {};
              const metricRollingStats = rollingStats[metric.symbol] || {};
              return (
                <div key={metric.symbol} className="usd-correlation-row">
                  <div className="usd-correlation-td usd-correlation-td-metric">
                    <span className="usd-metric-icon" aria-hidden="true">
                      <MetricIcon symbol={metric.symbol} />
                    </span>
                    <span>{metric.name}</span>
                  </div>
                  {CORRELATION_PERIODS.map((period) => {
                    const correlation = metricCorrelations[`${period}D`];
                    const displayValue = CorrelationHelpers.formatCorrelation(correlation);
                    const signClass = getSignClass(correlation);
                    return (
                      <div
                        key={period}
                        className={`usd-correlation-td usd-correlation-cell ${signClass} ${getHeatClass(correlation)}`}
                      >
                        <span className="usd-cell-pill">{displayValue}</span>
                      </div>
                    );
                  })}
                  <div className="usd-correlation-td usd-correlation-cell usd-correlation-rolling-start usd-correlation-right-value">
                    <span className="usd-cell-pill">
                      {formatNumeric(metricRollingStats.high, 2)}
                    </span>
                  </div>
                  <div className="usd-correlation-td usd-correlation-cell usd-correlation-right-value">
                    <span className="usd-cell-pill">
                      {formatNumeric(metricRollingStats.low, 2)}
                    </span>
                  </div>
                  <div className="usd-correlation-td usd-correlation-cell usd-correlation-right-value usd-correlation-right-stats-start">
                    <span className="usd-cell-pill">
                      {formatPercentValue(metricRollingStats.percentPositive)}
                    </span>
                  </div>
                  <div className="usd-correlation-td usd-correlation-cell usd-correlation-right-value">
                    <span className="usd-cell-pill">
                      {formatPercentValue(metricRollingStats.percentNegative)}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
};

export default USDCorrelationMatrix;
