import React, { useMemo } from 'react';
import { Share2 } from 'lucide-react';
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

const corrHeatProps = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return { className: 'region-mw-heat--na', style: {} };
  // Classify the same two-decimal value the user sees in the matrix.
  const displayedValue = Number(numeric.toFixed(2));
  const magnitude = Math.abs(displayedValue);
  if (magnitude <= 0.5) return { className: 'usd-corr-heat--neutral', style: {} };

  const direction = displayedValue > 0 ? 'pos' : 'neg';
  const strength = magnitude >= 0.75 ? 'strong' : 'light';
  return { className: `usd-corr-heat--${direction}-${strength}`, style: {} };
};

const isCompleteCorrelationMetric = (metricCorrelations, metricRollingStats) => (
  CORRELATION_PERIODS.every((period) => Number.isFinite(Number(metricCorrelations?.[`${period}D`])))
  && ['high', 'low', 'percentPositive', 'percentNegative']
    .every((key) => Number.isFinite(Number(metricRollingStats?.[key])))
);

const MetricIcon = ({ symbol }) => {
  switch (symbol) {
    case 'FXVL':
      return (
        <span className="usd-metric-badge usd-metric-badge-fxvl" aria-hidden="true">
          FX
        </span>
      );
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

const USDCorrelationMatrix = (props) => {
  const {
    state,
    variant = 'default',
  } = props;
  const resolvedState = state !== undefined ? (state || {}) : props;
  const {
    correlations,
    rollingStats,
    correlationsTimestamp,
    calculationDate,
    loading = false,
    error = null,
  } = resolvedState;
  const onRetry = resolvedState.onRetry || resolvedState.retry || props.onRetry;
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
    <div
      className={`usd-correlation-panel usd-correlation-panel--${variant} region-chart-panel--mw`}
      data-testid="usd-correlation-panel"
      data-variant={variant}
    >
      <div className="region-chart-header region-chart-header--mw usd-correlation-header--mw">
        <div className="region-header-left">
          <span className="card-header-icon card-header-icon--blue">
            <Share2 size={16} strokeWidth={2} />
          </span>
          <span className="region-label region-label--lg">USD Correlations</span>
        </div>
        <div className="usd-correlation-header-note">
          <span className="usd-correlation-header-note-item">*Days = Trading Days</span>
          <span className="usd-correlation-header-note-sep" aria-hidden="true">•</span>
          <span className="usd-correlation-header-note-item">52-Wk Rolling</span>
          <span className="usd-correlation-header-note-sep" aria-hidden="true">•</span>
          <span className="usd-correlation-header-note-item">30D Correlation</span>
          {variant !== 'radar' ? (
            <StatusDot
              updatedAt={effectiveUpdatedAt}
              status={statusState}
              size={8}
              label="USD Correlations"
              emoji={statusEmoji}
              sources={statusSources}
            />
          ) : null}
        </div>
      </div>

      <div className="region-mw-body usd-corr-body">
        <div className="region-mw-table-wrap usd-corr-table-wrap">
          {loading ? (
            <div className="usd-correlation-state loading">Loading correlation data...</div>
          ) : null}
          {!loading && error ? (
            <div className="usd-correlation-state error" role="alert">
              <span>Error loading correlation data: {error}</span>
              {onRetry ? (
                <button type="button" className="usd-correlation-retry" onClick={onRetry}>
                  Retry
                </button>
              ) : null}
            </div>
          ) : null}
          {!loading && !error && !hasData ? (
            <div className="usd-correlation-state">No correlation data available</div>
          ) : null}

          {!loading && !error && hasData ? (
            <table className="region-mw-quotes-table usd-corr-table">
              <thead>
                <tr>
                  <th className="region-mw-th region-mw-th-name usd-corr-th-metric" scope="col">
                    METRIC
                  </th>
                  {CORRELATION_PERIODS.map((period) => (
                    <th key={period} className="region-mw-th region-mw-th-num region-mw-th-metric" scope="col">
                      {period}D
                    </th>
                  ))}
                  <th className="region-mw-th region-mw-th-num region-mw-th-metric usd-corr-sep-left" scope="col">
                    HIGH
                  </th>
                  <th className="region-mw-th region-mw-th-num region-mw-th-metric" scope="col">
                    LOW
                  </th>
                  <th
                    className="region-mw-th region-mw-th-num region-mw-th-metric usd-corr-sep-left"
                    scope="col"
                  >
                    % TIME POS
                  </th>
                  <th className="region-mw-th region-mw-th-num region-mw-th-metric" scope="col">
                    % TIME NEG
                  </th>
                </tr>
              </thead>
              <tbody>
                {USD_METRICS.map((metric) => {
                  const metricCorrelations = correlations[metric.symbol] || {};
                  const metricRollingStats = rollingStats[metric.symbol] || {};
                  const metricAvailable = isCompleteCorrelationMetric(
                    metricCorrelations,
                    metricRollingStats,
                  );
                  return (
                    <tr
                      key={metric.symbol}
                      className={`region-mw-tr${metricAvailable ? '' : ' usd-corr-row--unavailable'}`}
                      aria-label={metricAvailable ? undefined : `${metric.symbol} correlation data unavailable`}
                      title={metricAvailable ? undefined : `${metric.name} requires current provider history`}
                    >
                      <td className="region-mw-td region-mw-td-name usd-corr-td-metric">
                        <span className="usd-metric-icon" aria-hidden="true">
                          <MetricIcon symbol={metric.symbol} />
                        </span>
                        <span className="usd-corr-metric-symbol">{metric.symbol}</span>
                        <span className="usd-corr-metric-name">{metric.name}</span>
                        {!metricAvailable ? <span className="usd-corr-metric-status">NO DATA</span> : null}
                      </td>
                      {CORRELATION_PERIODS.map((period) => {
                        const correlation = metricCorrelations[`${period}D`];
                        const displayValue = metricAvailable
                          ? CorrelationHelpers.formatCorrelation(correlation)
                          : '--';
                        const heat = metricAvailable
                          ? corrHeatProps(correlation)
                          : { className: 'region-mw-heat--na', style: {} };
                        return (
                          <td
                            key={period}
                            className={`region-mw-td region-mw-td-num region-mw-td-heat ${heat.className} usd-corr-td-center`}
                            style={heat.style}
                          >
                            {displayValue}
                          </td>
                        );
                      })}
                      <td className="region-mw-td region-mw-td-num usd-corr-td-center usd-corr-sep-left">
                        {metricAvailable ? formatNumeric(metricRollingStats.high, 2) : '--'}
                      </td>
                      <td className="region-mw-td region-mw-td-num usd-corr-td-center">
                        {metricAvailable ? formatNumeric(metricRollingStats.low, 2) : '--'}
                      </td>
                      <td className="region-mw-td region-mw-td-num usd-corr-td-center usd-corr-sep-left">
                        {metricAvailable ? formatPercentValue(metricRollingStats.percentPositive) : '--'}
                      </td>
                      <td className="region-mw-td region-mw-td-num usd-corr-td-center">
                        {metricAvailable ? formatPercentValue(metricRollingStats.percentNegative) : '--'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : null}
        </div>
      </div>
    </div>
  );
};

export { isCompleteCorrelationMetric };
export { corrHeatProps };
export default USDCorrelationMatrix;
