import React, { useEffect, useMemo, useRef } from 'react';
import StatusDot from '../common/StatusDot';
import useVolatilitySnapshot, {
  getVolatilitySnapshotMetadata,
  VOLATILITY_SERIES,
} from '../../hooks/useVolatilitySnapshot';
import { getBucketForSeries, VOL_RANGES } from '../../utils/volatilityRegimes';
import './VolatilityTable.css';

// All 7 series in one table — VVIX under VIX; MOVE from RATES
const ALL_SERIES = VOLATILITY_SERIES;

const formatRangeMath = (range, index) => {
  if (range.max == null) return `${range.min}+`;
  if (index === 0) return `<${range.max}`;
  return `${range.min}–${range.max}`;
};

const HEAT_CAP_PCT = 15;

const pctHeatProps = (pctNum) => {
  if (!Number.isFinite(pctNum)) {
    return { className: 'region-mw-heat--na', style: {} };
  }
  const sign = pctNum >= 0 ? 'pos' : 'neg';
  const intensity = Math.min(Math.abs(pctNum) / HEAT_CAP_PCT, 1);
  return {
    className: `region-mw-heat--${sign}`,
    style: { '--heat': intensity },
  };
};

const formatPeriodPct = (value) => {
  if (value == null || value === '') return '—';
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  return `${num >= 0 ? '+' : ''}${num.toFixed(2)}`;
};

const isHistoricalMoveRow = (seriesName, row) => (
  seriesName === 'MOVE'
  && row?.availability === 'historical'
  && row?.freshness === 'historical'
  && row?.quoteMode === 'end-of-day'
  && row?.lastPx != null
  && Number.isFinite(Number(row.lastPx))
);

const formatAsOfDate = (value) => {
  if (!value) return 'UNKNOWN';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'UNKNOWN';
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'America/New_York',
  }).toUpperCase();
};

const VolatilityTable = ({
  snapshot: controlledSnapshot,
  loading: controlledLoading,
  error: controlledError,
  onRetry: controlledOnRetry,
  variant = 'default',
  onIndicatorHelp,
  onLastUpdatedChange,
  onSourcesChange,
}) => {
  const isControlled = controlledSnapshot !== undefined;
  const localState = useVolatilitySnapshot({ enabled: !isControlled });
  const snapshot = isControlled ? controlledSnapshot : localState.snapshot;
  const data = snapshot || {};
  const loading = isControlled ? Boolean(controlledLoading) : localState.loading;
  const error = isControlled ? controlledError : localState.error;
  const onRetry = isControlled ? controlledOnRetry : localState.retry;
  const metadata = useMemo(
    () => getVolatilitySnapshotMetadata(snapshot),
    [snapshot],
  );

  useEffect(() => {
    onLastUpdatedChange?.(metadata.lastUpdated);
  }, [metadata.lastUpdated, onLastUpdatedChange]);

  useEffect(() => {
    onSourcesChange?.(metadata.sources);
  }, [metadata.sources, onSourcesChange]);

  const formatValue = (v) => (v != null && Number.isFinite(Number(v)) ? Number(v).toFixed(2) : 'N/A');

  const isSeriesCompletelyMissing = (seriesName, rowData) => {
    if (!rowData) return true;
    if (isHistoricalMoveRow(seriesName, rowData)) return false;
    return (
      rowData.availability !== 'available' ||
      rowData.freshness !== 'current' ||
      rowData.lastPx == null ||
      !Number.isFinite(Number(rowData.lastPx))
    );
  };

  if (loading) {
    return (
      <div className="volatility-table-loading">Loading volatility data...</div>
    );
  }

  if (error) {
    return (
      <div className="volatility-table-loading volatility-table-error" role="alert">
        <span>Volatility data unavailable: {error}</span>
        {onRetry ? (
          <button type="button" className="volatility-table-retry" onClick={onRetry}>
            Retry
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div
      className={`volatility-table volatility-table--mw volatility-table--${variant}`}
      data-testid="volatility-table"
      data-variant={variant}
    >
      <div className="region-mw-body">
        <div className="region-mw-table-wrap">
          <table className="region-mw-quotes-table volatility-mw-table">
            <thead>
              <tr>
                <th className="region-mw-th region-mw-th-name" scope="col">
                  SERIES
                </th>
                <th className="region-mw-th region-mw-th-num region-mw-th-metric" scope="col">
                  SPOT
                </th>
                <th className="region-mw-th region-mw-th-num region-mw-th-metric" scope="col">
                  1D AGO
                </th>
                <th className="region-mw-th region-mw-th-num region-mw-th-metric" scope="col">
                  1W AGO
                </th>
                <th className="region-mw-th region-mw-th-num region-mw-th-metric" scope="col">
                  4W AGO
                </th>
                <th className="region-mw-th region-mw-th-num region-mw-th-metric vol-mw-sep-left" scope="col">
                  DAY (%)
                </th>
                <th className="region-mw-th region-mw-th-num region-mw-th-metric" scope="col">
                  WEEKLY (%)
                </th>
                <th
                  className="region-mw-th region-mw-th-num region-mw-th-metric"
                  scope="col"
                  title="Approx. 21 trading sessions (~1 month rolling)."
                >
                  MONTHLY (%)
                </th>
                <th className="region-mw-th region-mw-th-num region-mw-th-metric" scope="col">
                  3M (%)
                </th>
                <th className="region-mw-th region-mw-th-num region-mw-th-metric" scope="col">
                  6M (%)
                </th>
                <th className="region-mw-th region-mw-th-num region-mw-th-metric" scope="col">
                  YTD (%)
                </th>
              </tr>
            </thead>
            <tbody>
              {ALL_SERIES.map((s) => {
                const row = data[s.name] || {};
                const historicalMove = isHistoricalMoveRow(s.name, row);
                const seriesMissing = isSeriesCompletelyMissing(s.name, row);
                const missingLabel =
                  s.name === 'RVX'
                    ? 'RVX data is currently unavailable or unreliable from the upstream provider. The dashboard intentionally avoids showing stale or synthetic values.'
                    : 'Data is currently unavailable from the upstream provider.';
                const cellCommonProps = seriesMissing
                  ? {
                      title: missingLabel,
                      'aria-label': `${s.name} volatility data unavailable`,
                    }
                  : historicalMove
                    ? {
                        title: `End-of-day MOVE value as of ${new Date(row.asOf).toLocaleString()}`,
                      }
                  : {};

                const bucketSpot = getBucketForSeries(s.name, row?.lastPx);
                const bucket1d = getBucketForSeries(s.name, row?.day1Ago);
                const bucket1w = getBucketForSeries(s.name, row?.week1Ago);
                const bucket4w = getBucketForSeries(s.name, row?.week4Ago);

                const periodCells = [
                  { key: 'day', value: row?.dayChangePct, sep: true },
                  { key: 'week', value: row?.weekChangePct },
                  { key: 'month', value: row?.monthChangePct },
                  { key: 'threeMonth', value: row?.threeMonthChangePct },
                  { key: 'sixMonth', value: row?.sixMonthChangePct },
                  { key: 'ytd', value: row?.ytdChangePct },
                ];

                const bucketClass = (bucket) => (bucket ? `vol-mw-bucket vol-mw-bucket-${bucket}` : '');
                const regimeRanges = [...(VOL_RANGES[s.name]?.ranges || [])].reverse();

                return (
                  <tr key={s.name} className="region-mw-tr">
                    <td className="region-mw-td region-mw-td-name vol-mw-td-metric">
                      <div className="vol-mw-series-cell-content">
                        <div className="vol-mw-series-identity">
                          <span className="vol-mw-metric-icon">
                            <button
                              type="button"
                              className="vol-ranges-help-btn"
                              onClick={() => onIndicatorHelp?.(s.name)}
                              title={`View ${s.name} ranges`}
                              aria-label={`View ${s.name} ranges`}
                            >
                              ?
                            </button>
                          </span>
                          <span className="vol-mw-series-symbol">{s.symbol}</span>
                          {historicalMove ? <span className="vol-mw-eod-badge">EOD</span> : null}
                        </div>
                        <div
                          className={`vol-mw-regime-stack${seriesMissing ? ' vol-mw-regime-stack--unavailable' : ''}`}
                          aria-label={
                            seriesMissing
                              ? `${s.name} volatility regime unavailable`
                              : `${s.name} ${historicalMove ? 'end-of-day' : 'current'} volatility regime: ${bucketSpot}`
                          }
                        >
                          {regimeRanges.map((range) => {
                            const originalIndex = VOL_RANGES[s.name].ranges.indexOf(range);
                            const isActive = !seriesMissing && bucketSpot === range.color;
                            return (
                              <span
                                key={range.color}
                                className={`vol-mw-regime-block vol-mw-regime-block--${range.color}${isActive ? ' is-active' : ''}`}
                                data-regime={range.color}
                                data-active={isActive ? 'true' : 'false'}
                                aria-hidden="true"
                              >
                                {formatRangeMath(range, originalIndex)}
                              </span>
                            );
                          })}
                        </div>
                      </div>
                    </td>

                    <td
                      className={`region-mw-td region-mw-td-num ${seriesMissing ? 'region-mw-heat--na' : bucketClass(bucketSpot)}`}
                      {...cellCommonProps}
                    >
                      {seriesMissing ? 'N/A' : historicalMove ? (
                        <span className="vol-mw-eod-value">
                          <strong>{formatValue(row.lastPx)}</strong>
                          <small>EOD · AS OF {formatAsOfDate(row.asOf)}</small>
                        </span>
                      ) : formatValue(row.lastPx)}
                    </td>
                    <td
                      className={`region-mw-td region-mw-td-num ${seriesMissing ? 'region-mw-heat--na' : bucketClass(bucket1d)}`}
                      {...cellCommonProps}
                    >
                      {seriesMissing ? 'N/A' : formatValue(row.day1Ago)}
                    </td>
                    <td
                      className={`region-mw-td region-mw-td-num ${seriesMissing ? 'region-mw-heat--na' : bucketClass(bucket1w)}`}
                      {...cellCommonProps}
                    >
                      {seriesMissing ? 'N/A' : formatValue(row.week1Ago)}
                    </td>
                    <td
                      className={`region-mw-td region-mw-td-num ${seriesMissing ? 'region-mw-heat--na' : bucketClass(bucket4w)}`}
                      {...cellCommonProps}
                    >
                      {seriesMissing ? 'N/A' : formatValue(row.week4Ago)}
                    </td>

                    {periodCells.map((cell) => {
                      const num = cell.value == null || cell.value === '' ? NaN : Number(cell.value);
                      const heat = seriesMissing ? { className: 'region-mw-heat--na', style: {} } : pctHeatProps(num);
                      return (
                        <td
                          key={cell.key}
                          className={`region-mw-td region-mw-td-num region-mw-td-heat ${cell.sep ? 'vol-mw-sep-left ' : ''}${heat.className}`}
                          style={heat.style}
                          {...cellCommonProps}
                        >
                          {seriesMissing ? 'N/A' : formatPeriodPct(cell.value)}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

const VolRangesPopover = ({ indicatorKey, onClose }) => {
  const ref = useRef(null);
  const info = indicatorKey ? VOL_RANGES[indicatorKey] : null;

  useEffect(() => {
    if (!indicatorKey) return;
    const handleClickOutside = (e) => {
      if (ref.current && !ref.current.contains(e.target) && !e.target.closest('.vol-ranges-help-btn')) {
        onClose();
      }
    };
    const handleEscape = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [indicatorKey, onClose]);

  if (!indicatorKey || !info) return null;

  return (
    <div className="vol-ranges-popover-backdrop" onClick={onClose}>
      <div ref={ref} className="vol-ranges-popover" onClick={(e) => e.stopPropagation()}>
        <div className="vol-ranges-popover-header">
          <span className="vol-ranges-popover-title">{info.name}</span>
          <button type="button" className="vol-ranges-popover-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="vol-ranges-popover-body">
          <div className="vol-ranges-indicator-source">Source: {info.source}</div>
          <div className="vol-ranges-ranges">
            {info.ranges.map((r, i) => {
              const math = formatRangeMath(r, i);
              return (
                <div key={i} className={`vol-ranges-range vol-ranges-range-${r.color}`}>
                  <span className="vol-ranges-range-label">{r.label}:</span>
                  <span className="vol-ranges-range-math">{math}</span>
                  <span className="vol-ranges-range-desc">— {r.desc}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};

const VolatilityTableWithTabs = ({
  statusIndicator,
  snapshot,
  loading,
  error,
  onRetry,
  variant = 'default',
}) => {
  const [openIndicator, setOpenIndicator] = React.useState(null);
  const [lastUpdated, setLastUpdated] = React.useState(null);
  const [volSources, setVolSources] = React.useState([]);
  const status = statusIndicator || { emoji: '🟢', title: 'Active' };

  const derivedStatus =
    status.emoji === '🟢'
      ? 'active'
      : status.emoji === '🔵'
      ? 'stale'
      : 'inactive';

  return (
    <div
      className={`volatility-tabs volatility-tabs--${variant}`}
      data-testid="volatility-table-shell"
      data-variant={variant}
    >
      <div className="region-chart-header region-chart-header--mw">
        <div className="region-header-left">
          <span className="card-header-icon card-header-icon--blue">
            <img
              src="/assets/volatility-card.jpg"
              alt=""
              className="currency-header-portrait"
            />
          </span>
          <span className="region-label region-label--lg">Volatility</span>
        </div>
        <div className="region-header-status">
          {variant !== 'radar' ? (
            <StatusDot
              updatedAt={lastUpdated}
              status={volSources.length > 0 ? undefined : derivedStatus}
              size={8}
              label="Volatility data"
              emoji={status.emoji}
              sources={volSources}
            />
          ) : null}
        </div>
      </div>
      <VolRangesPopover indicatorKey={openIndicator} onClose={() => setOpenIndicator(null)} />
      <VolatilityTable
        snapshot={snapshot}
        loading={loading}
        error={error}
        onRetry={onRetry}
        variant={variant}
        onIndicatorHelp={setOpenIndicator}
        onLastUpdatedChange={setLastUpdated}
        onSourcesChange={setVolSources}
      />
    </div>
  );
};

export default VolatilityTable;
export { VOL_RANGES, VolatilityTableWithTabs, getBucketForSeries };
