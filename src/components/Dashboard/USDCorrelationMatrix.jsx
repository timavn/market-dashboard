import React, { useMemo } from 'react';
import { Share2, TrendingUp } from 'lucide-react';
import StatusDot from '../common/StatusDot';
import { getSourceFreshness } from '../../utils/timeUtils';
import { formatVolatilityRange, getBucketForSeries, VOL_RANGES } from '../../utils/volatilityRegimes';
import { USD_METRICS, CORRELATION_PERIODS, REFRESH_INTERVALS } from '../../constants/usdMarket';
import { USD_CORRELATION_HEATMAP_THRESHOLDS } from '../../constants/usdCorrelationPresentation';
import { CorrelationHelpers } from '../../services/api/usdMarketService';
import VolatilityMetricRow, { isFiniteMetricNumber } from './VolatilityMetricRow';
import {
  isAttributedFxVolatility,
  isCurrentFxVolatility,
  isDisplayableFxVolatility,
  isHistoricalFxVolatility,
  isRetainedFxVolatility,
} from '../../utils/fxVolatilityReference';
import './MultiRegionMarketOverview.css';
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
  if (magnitude <= USD_CORRELATION_HEATMAP_THRESHOLDS.neutralMagnitudeMax) {
    return { className: 'usd-corr-heat--neutral', style: {} };
  }

  const direction = displayedValue > 0 ? 'pos' : 'neg';
  const strength = magnitude >= USD_CORRELATION_HEATMAP_THRESHOLDS.strongMagnitudeMin
    ? 'strong'
    : 'light';
  return { className: `usd-corr-heat--${direction}-${strength}`, style: {} };
};

const isCompleteCorrelationMetric = (metricCorrelations, metricRollingStats) => (
  CORRELATION_PERIODS.every(({ key }) => isFiniteMetricNumber(metricCorrelations?.[key]))
  && ['high', 'low', 'percentPositive', 'percentNegative']
    .every((key) => isFiniteMetricNumber(metricRollingStats?.[key]))
);

const formatFxvlAsOfDate = (value) => toDateValue(value)?.toLocaleDateString('en-US', {
  month: 'short',
  day: 'numeric',
  timeZone: 'America/New_York',
}).toUpperCase() || 'UNKNOWN';

export const getFxVolatilityRowProps = (snapshot) => {
  const historical = isHistoricalFxVolatility(snapshot);
  const refreshDelayed = isRetainedFxVolatility(snapshot);
  const available = isDisplayableFxVolatility(snapshot);
  const asOfLabel = historical ? formatFxvlAsOfDate(snapshot.asOf) : null;
  const realized = String(snapshot?.measure || '').toLowerCase() === 'realized'
    || /^yahoo(?:\b|[-_])/i.test(String(snapshot?.source || ''));
  const symbol = realized ? 'G5RV' : 'FXVL';
  const bucket = available ? getBucketForSeries(symbol, snapshot.lastPx) : null;
  const regime = bucket ? VOL_RANGES[symbol]?.ranges.find((range) => range.color === bucket) : null;

  return {
    row: snapshot,
    symbol,
    available,
    historical,
    refreshDelayed,
    bucket,
    regimeLabel: regime?.label,
    regimeRange: formatVolatilityRange(regime),
    ariaLabel: available
      ? refreshDelayed
        ? `${symbol} last verified volatility; refresh delayed`
        : historical
        ? realized
          ? `${symbol} G5 FX 1M realized vol as of ${asOfLabel}`
          : `FXVL closing volatility as of ${asOfLabel}`
        : realized ? `${symbol} G5 FX 1M realized vol` : 'FXVL current volatility'
      : `${symbol} volatility data unavailable`,
  };
};

const MetricIcon = ({ symbol }) => {
  switch (symbol) {
    case 'FXVL':
      return (
        <span className="usd-metric-badge usd-metric-badge-fxvl" aria-hidden="true">
          FX
        </span>
      );
    case 'BRENT':
      return (
        <svg
          className="usd-metric-oil"
          viewBox="0 0 24 24"
          aria-hidden="true"
          focusable="false"
        >
          <path
            d="M12 2.8C12 2.8 5.8 10.2 5.8 15.2a6.2 6.2 0 0 0 12.4 0C18.2 10.2 12 2.8 12 2.8Z"
            fill="#111827"
          />
          <path
            d="M9.2 13.4c.4-2.2 1.6-4.4 2.8-6.2 1.1 1.7 2.2 3.8 2.6 5.8-.7.3-1.7.5-2.6.5-.9 0-1.9-.2-2.8-.1Z"
            fill="rgba(255,255,255,0.14)"
          />
        </svg>
      );
    case 'CRB':
      return (
        <svg
          className="usd-metric-commodity"
          viewBox="0 0 24 24"
          aria-hidden="true"
          focusable="false"
        >
          {/* Wheat / grain sheaf — commodity basket proxy */}
          <path
            d="M12 21V9.5"
            fill="none"
            stroke="#6B4F1D"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
          <path
            d="M12 11.2c-2.1-1.1-3.4-2.8-3.6-4.8 2.1.4 3.6 1.8 3.6 4.8Z"
            fill="#C4A35A"
            stroke="#8A6A2A"
            strokeWidth="0.8"
            strokeLinejoin="round"
          />
          <path
            d="M12 11.2c2.1-1.1 3.4-2.8 3.6-4.8-2.1.4-3.6 1.8-3.6 4.8Z"
            fill="#D4B56A"
            stroke="#8A6A2A"
            strokeWidth="0.8"
            strokeLinejoin="round"
          />
          <path
            d="M12 14.2c-2.3-.8-3.9-2.3-4.4-4.2 2.3.1 4 1.5 4.4 4.2Z"
            fill="#B8944A"
            stroke="#8A6A2A"
            strokeWidth="0.8"
            strokeLinejoin="round"
          />
          <path
            d="M12 14.2c2.3-.8 3.9-2.3 4.4-4.2-2.3.1-4 1.5-4.4 4.2Z"
            fill="#C9A65A"
            stroke="#8A6A2A"
            strokeWidth="0.8"
            strokeLinejoin="round"
          />
          <path
            d="M12 17c-2.4-.5-4.2-1.8-4.9-3.6 2.4-.2 4.3 1.1 4.9 3.6Z"
            fill="#A9843F"
            stroke="#8A6A2A"
            strokeWidth="0.8"
            strokeLinejoin="round"
          />
          <path
            d="M12 17c2.4-.5 4.2-1.8 4.9-3.6-2.4-.2-4.3 1.1-4.9 3.6Z"
            fill="#B8944A"
            stroke="#8A6A2A"
            strokeWidth="0.8"
            strokeLinejoin="round"
          />
        </svg>
      );
    case 'GOLD':
      return (
        <svg
          className="usd-metric-goldbar"
          viewBox="0 0 24 24"
          aria-hidden="true"
          focusable="false"
        >
          {/* Stacked gold bullion bars */}
          <rect x="5" y="14.5" width="14" height="4.2" rx="0.6" fill="#B45309" />
          <rect x="5.3" y="14.5" width="13.4" height="1.5" rx="0.4" fill="#FDE68A" />
          <rect x="5.3" y="16" width="13.4" height="2.2" rx="0.3" fill="#EAB308" />
          <rect x="6.2" y="10.4" width="11.6" height="4.2" rx="0.6" fill="#B45309" />
          <rect x="6.5" y="10.4" width="11" height="1.5" rx="0.4" fill="#FDE68A" />
          <rect x="6.5" y="11.9" width="11" height="2.2" rx="0.3" fill="#F4B400" />
          <rect x="7.4" y="6.3" width="9.2" height="4.2" rx="0.6" fill="#92400E" />
          <rect x="7.7" y="6.3" width="8.6" height="1.5" rx="0.4" fill="#FEF3C7" />
          <rect x="7.7" y="7.8" width="8.6" height="2.2" rx="0.3" fill="#F59E0B" />
        </svg>
      );
    case 'BTC':
      return (
        <span className="usd-metric-btc" aria-hidden="true">
          <span className="usd-metric-btc-symbol">₿</span>
        </span>
      );
    default:
      return <TrendingUp className="usd-metric-trend" size={20} strokeWidth={2.25} aria-hidden="true" />;
  }
};

const USDCorrelationMatrix = (props) => {
  const {
    state,
    variant = 'default',
    correlationStatus = null,
    currencyPanel = null,
    showFxVolatility = true,
  } = props;
  const resolvedState = state !== undefined ? (state || {}) : props;
  const {
    correlations,
    rollingStats,
    correlationsTimestamp,
    calculationDate,
    fxvlSnapshot = null,
    loading = false,
    refreshing = false,
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
    if (!hasData) return loading ? 'stale' : 'inactive';
    if (freshness === 'current') return 'active';
    if (freshness === 'stale') return 'stale';
    return 'inactive';
  }, [loading, hasData, freshness]);

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

  const tableMetrics = variant === 'radar'
    ? USD_METRICS.filter(({ symbol }) => symbol !== 'FXVL')
    : USD_METRICS;

  return (
    <div
      className={`usd-correlation-panel usd-correlation-panel--${variant} region-chart-panel--mw`}
      data-testid="usd-correlation-panel"
      data-variant={variant}
    >
      {variant !== 'radar' ? (
        <div className="region-chart-header region-chart-header--mw usd-correlation-header--mw">
          <div className="region-header-left">
            <span className="card-header-icon card-header-icon--blue">
              <Share2 size={16} strokeWidth={2} />
            </span>
            <span className="region-label region-label--lg">USD Correlations</span>
          </div>
          <StatusDot
            updatedAt={effectiveUpdatedAt}
            status={statusState}
            size={8}
            label="USD Correlations"
            emoji={statusEmoji}
            sources={statusSources}
          />
        </div>
      ) : null}

      {variant === 'radar' && showFxVolatility ? (
        <section className="usd-card-section usd-card-section--fxvl" aria-label="FX Volatility">
          <VolatilityMetricRow
            {...getFxVolatilityRowProps(fxvlSnapshot)}
            className="usd-corr-fxvl-summary"
          />
        </section>
      ) : null}


      {variant === 'radar' ? currencyPanel : null}

      <section className="usd-card-correlations" aria-label="Dollar correlations">
        {variant === 'radar' ? (
          <header className="usd-card-section__header usd-card-correlations__header">
            <h3>USD Correlations</h3>
            {correlationStatus ? (
              <div className="usd-card-correlations__status">{correlationStatus}</div>
            ) : null}
          </header>
        ) : null}

        <div className="region-mw-body usd-corr-body">
          <div className="region-mw-table-wrap usd-corr-table-wrap">
            {loading && !hasData ? (
              <div className="usd-correlation-state loading">Loading correlation data...</div>
            ) : null}
            {!hasData && !loading && error ? (
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

            {hasData ? (
              <>
                {refreshing && !error ? (
                  <div className="usd-correlation-state refresh-delayed" role="status">
                    Refreshing verified correlation data; the dated snapshot remains visible.
                  </div>
                ) : null}
                {error ? (
                  <div className="usd-correlation-state refresh-delayed" role="status">
                    <span>Refresh delayed. Showing the dated correlation snapshot.</span>
                    {onRetry ? (
                      <button type="button" className="usd-correlation-retry" onClick={onRetry}>
                        Retry
                      </button>
                    ) : null}
                  </div>
                ) : null}
                <table className="region-mw-quotes-table usd-corr-table" aria-label="USD correlations">
                <thead>
                  <tr>
                    <th className="region-mw-th region-mw-th-name usd-corr-th-metric" scope="col">
                      METRIC
                    </th>
                    {CORRELATION_PERIODS.map(({ key, label }) => (
                      <th key={key} className="region-mw-th region-mw-th-num region-mw-th-metric" scope="col">
                        {label}
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
                  {tableMetrics.map((metric) => {
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
                          <span className="usd-corr-metric-symbol" title={metric.name}>{metric.symbol}</span>
                          <span className="usd-corr-metric-name">{metric.name}</span>
                          {!metricAvailable ? <span className="usd-corr-metric-status">NO DATA</span> : null}
                        </td>
                        {CORRELATION_PERIODS.map(({ key }) => {
                          const correlation = metricCorrelations[key];
                          const displayValue = metricAvailable
                            ? CorrelationHelpers.formatCorrelation(correlation)
                            : '--';
                          const heat = metricAvailable
                            ? corrHeatProps(correlation)
                            : { className: 'region-mw-heat--na', style: {} };
                          return (
                            <td
                              key={key}
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
              </>
            ) : null}
          </div>
        </div>
      </section>
    </div>
  );
};

export {
  isAttributedFxVolatility as isAttributedFxvlSnapshot,
  isCompleteCorrelationMetric,
  isCurrentFxVolatility as isCurrentFxvlSnapshot,
  isDisplayableFxVolatility as isDisplayableFxvlSnapshot,
  isHistoricalFxVolatility as isHistoricalFxvlSnapshot,
};
export { corrHeatProps };
export default USDCorrelationMatrix;
