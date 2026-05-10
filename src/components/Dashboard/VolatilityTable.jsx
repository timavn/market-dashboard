import React, { useState, useEffect, useRef } from 'react';
import { Activity } from 'lucide-react';
import StatusDot from '../common/StatusDot';
import { getMinTimestamp, getSourceFreshness, SOURCE_POLL_INTERVALS } from '../../utils/timeUtils';
import './VolatilityTable.css';

// Volatility ranges from The Process (bookContent.js) - VIX explicit; others use similar framework.
// Ranges are contiguous half-open intervals: [min, max). The upper bucket (max == null) extends to +∞.
const VOL_RANGES = {
  VIX: {
    name: 'VIX (S&P 500 Implied Vol)',
    source: 'The Process',
    ranges: [
      { min: 0,  max: 19,   label: 'Investable',   color: 'green',  desc: 'Buy dips, normal risk' },
      { min: 19, max: 29,   label: 'Chop bucket',  color: 'yellow', desc: 'Trade ranges, be aggressive on longs' },
      { min: 29, max: null, label: 'Uninvestable', color: 'red',    desc: 'Defensive, preserve capital' }
    ]
  },
  RVX: {
    name: 'RVX (Russell 2000 Implied Vol)',
    source: 'Similar framework to VIX',
    ranges: [
      { min: 0,  max: 24,   label: 'Investable',   color: 'green',  desc: 'Typically ~1.2x VIX' },
      { min: 24, max: 36,   label: 'Chop bucket',  color: 'yellow', desc: 'Trade ranges' },
      { min: 36, max: null, label: 'Uninvestable', color: 'red',    desc: 'Defensive' }
    ]
  },
  NazVol: {
    name: 'NazVol / VXN (Nasdaq Implied Vol)',
    source: 'Similar framework to VIX',
    ranges: [
      { min: 0,  max: 24,   label: 'Investable',   color: 'green',  desc: 'Typically ~1.2x VIX' },
      { min: 24, max: 36,   label: 'Chop bucket',  color: 'yellow', desc: 'Trade ranges' },
      { min: 36, max: null, label: 'Uninvestable', color: 'red',    desc: 'Defensive' }
    ]
  },
  GVZ: {
    name: 'GVZ (Gold Implied Vol)',
    source: 'The Process (Gold vol uses Chop Bucket framework)',
    ranges: [
      { min: 0,  max: 24,   label: 'Investable',   color: 'green',  desc: 'Low vol regime' },
      { min: 24, max: 36,   label: 'Chop bucket',  color: 'yellow', desc: 'Trade ranges' },
      { min: 36, max: null, label: 'Uninvestable', color: 'red',    desc: 'Defensive' }
    ]
  },
  OVX: {
    name: 'OVX (Oil Implied Vol)',
    source: 'Similar framework',
    ranges: [
      { min: 0,  max: 40,   label: 'Investable',   color: 'green',  desc: 'Lower vol regime' },
      { min: 40, max: 55,   label: 'Chop bucket',  color: 'yellow', desc: 'Trade ranges' },
      { min: 55, max: null, label: 'Uninvestable', color: 'red',    desc: 'Defensive' }
    ]
  },
  MOVE: {
    name: 'MOVE (Bond Market Implied Vol)',
    source: 'Different scale - Treasury options',
    ranges: [
      { min: 0,   max: 100,  label: 'Investable',   color: 'green',  desc: 'Lower vol regime' },
      { min: 100, max: 120,  label: 'Chop bucket',  color: 'yellow', desc: 'Trade ranges' },
      { min: 120, max: null, label: 'Uninvestable', color: 'red',    desc: 'Defensive' }
    ]
  },
  VVIX: {
    name: 'VVIX (VIX of VIX – Vol of Vol)',
    source: 'CBOE – similar framework to VIX',
    ranges: [
      { min: 0,   max: 95,   label: 'Investable',   color: 'green',  desc: 'Lower vol-of-vol' },
      { min: 95,  max: 115,  label: 'Chop bucket',  color: 'yellow', desc: 'Elevated vol-of-vol' },
      { min: 115, max: null, label: 'Uninvestable', color: 'red',    desc: 'Defensive' }
    ]
  }
};

// All 7 series in one table — VVIX under VIX; MOVE from RATES
const ALL_SERIES = [
  { name: 'VIX',    symbol: 'VIX',  rowStyle: 'green'  },
  { name: 'VVIX',   symbol: 'VVIX', rowStyle: 'green'  },
  { name: 'RVX',    symbol: 'RVX', rowStyle: 'yellow' },
  { name: 'NazVol', symbol: 'VXN',  rowStyle: 'yellow' },
  { name: 'GVZ',    symbol: 'GVZ',  rowStyle: 'blue'   },
  { name: 'OVX',    symbol: 'OVX',  rowStyle: 'blue'   },
  { name: 'MOVE',   symbol: 'MOVE', rowStyle: 'blue'   },
];

// Value-based bucket from VOL_RANGES (green/yellow/red). Returns null for missing/invalid value or unknown series.
// Ranges are half-open [min, max); the upper bucket (max == null) extends to +∞, so every numeric value
// lands in exactly one bucket and shared boundaries belong to the higher tier.
const getBucketForSeries = (seriesName, value) => {
  if (value == null || value === '' || Number.isNaN(Number(value))) return null;
  const config = VOL_RANGES[seriesName];
  if (!config?.ranges?.length) return null;
  const v = parseFloat(value);
  for (let i = 0; i < config.ranges.length; i++) {
    const r = config.ranges[i];
    const inRange = v >= r.min && (r.max == null || v < r.max);
    if (inRange) return r.color;
  }
  return null;
};

const POLL_INTERVAL_MS = 60000; // 1 minute during market hours

// Helper to calculate rate-of-change metrics (bps + percent) between two levels
const calculateRocChange = (current, prior) => {
  if (
    current == null ||
    prior == null ||
    Number.isNaN(Number(current)) ||
    Number.isNaN(Number(prior)) ||
    Number(prior) === 0
  ) {
    return { percent: null, bps: null };
  }

  const curr = Number(current);
  const prev = Number(prior);
  const pct = ((curr - prev) / prev) * 100;
  const bps = pct * 100;

  return {
    percent: parseFloat(pct.toFixed(1)),
    bps: Math.round(bps)
  };
};

const formatRocBps = (bps) => {
  if (bps == null) return '--';
  return `${bps}`;
};

const formatRocPercent = (percent) => {
  if (percent == null) return '--';
  const sign = percent > 0 ? '+' : '';
  return `${sign}${percent.toFixed(1)}`;
};

const VolatilityTable = ({ onIndicatorHelp, onLastUpdatedChange, onSourcesChange }) => {
  const [data, setData] = useState({});
  const [loading, setLoading] = useState(true);

  const fetchVolatilityData = async () => {
    try {
      const backendUrl = process.env.REACT_APP_BACKEND_URL || 'http://localhost:3001';
      const response = await fetch(`${backendUrl}/api/volatility-snapshot`);
      const snapshot = await response.json();
      setData(snapshot);

      const topLevelTimestamp =
        snapshot?.lastUpdated ||
        snapshot?.timestamp ||
        snapshot?.asOf;

      const seriesTimestamps = ALL_SERIES.map((s) => {
        const row = snapshot[s.name];
        return row?.lastUpdated || row?.timestamp || row?.asOf;
      }).filter(Boolean);

      if (onLastUpdatedChange) {
        if (topLevelTimestamp) {
          onLastUpdatedChange(topLevelTimestamp);
        } else {
          const minTs = getMinTimestamp(seriesTimestamps);
          if (minTs) {
            onLastUpdatedChange(minTs);
          }
        }
      }

      if (onSourcesChange) {
        const interval = SOURCE_POLL_INTERVALS.volatilitySnapshot || 60000;
        const sources = ALL_SERIES
          .map((s) => {
            const row = snapshot[s.name];
            const ts = row?.lastUpdated || row?.timestamp || row?.asOf || topLevelTimestamp;
            if (!ts) return null;
            return {
              id: s.name,
              label: s.name,
              updatedAt: ts,
              status: getSourceFreshness(ts, interval)
            };
          })
          .filter(Boolean);
        onSourcesChange(sources);
      }
    } catch (err) {
      console.error('Error fetching volatility data:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setLoading(true);
    fetchVolatilityData();
    const interval = setInterval(fetchVolatilityData, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);

  const formatValue = (v) => (v != null ? Number(v).toFixed(2) : '--');

  const isSeriesCompletelyMissing = (rowData) => {
    if (!rowData) return true;
    const keys = ['lastPx', 'day1Ago', 'week1Ago', 'week4Ago'];
    return !keys.some((key) => rowData[key] != null && !Number.isNaN(Number(rowData[key])));
  };

  const getValueForColumn = (rowData, colIndex) => {
    const keys = ['lastPx', 'day1Ago', 'week1Ago', 'week4Ago'];
    return rowData?.[keys[colIndex]];
  };

  if (loading) {
    return (
      <div className="volatility-table-loading">Loading volatility data...</div>
    );
  }

  return (
    <div className="volatility-table volatility-table--mw">
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
                  DOD (BPS)
                </th>
                <th className="region-mw-th region-mw-th-num region-mw-th-metric" scope="col">
                  DOD (%)
                </th>
                <th className="region-mw-th region-mw-th-num region-mw-th-metric vol-mw-sep-left" scope="col">
                  VOV (BPS)
                </th>
                <th className="region-mw-th region-mw-th-num region-mw-th-metric" scope="col">
                  VOV (%)
                </th>
                <th className="region-mw-th region-mw-th-num region-mw-th-metric vol-mw-sep-left" scope="col">
                  MOM (BPS)
                </th>
                <th className="region-mw-th region-mw-th-num region-mw-th-metric" scope="col">
                  MOM (%)
                </th>
              </tr>
            </thead>
            <tbody>
              {ALL_SERIES.map((s) => {
                const row = data[s.name] || {};
                const seriesMissing = isSeriesCompletelyMissing(row);
                const missingLabel =
                  s.name === 'RVX'
                    ? 'RVX data is currently unavailable or unreliable from the upstream provider. The dashboard intentionally avoids showing stale or synthetic values.'
                    : 'Data is currently unavailable from the upstream provider.';
                const cellCommonProps = seriesMissing
                  ? {
                      title: missingLabel,
                      'aria-label': `${s.name} volatility data unavailable`,
                    }
                  : {};

                const bucketSpot = getBucketForSeries(s.name, row?.lastPx);
                const bucket1d = getBucketForSeries(s.name, row?.day1Ago);
                const bucket1w = getBucketForSeries(s.name, row?.week1Ago);
                const bucket4w = getBucketForSeries(s.name, row?.week4Ago);

                const dod = calculateRocChange(row?.lastPx, row?.day1Ago);
                const vov = calculateRocChange(row?.lastPx, row?.week1Ago);
                const mom = calculateRocChange(row?.lastPx, row?.week4Ago);

                const rocTone = (p) => (p == null ? '' : p > 0 ? 'positive' : p < 0 ? 'negative' : '');

                const bucketClass = (bucket) => (bucket ? `vol-mw-bucket vol-mw-bucket-${bucket}` : '');

                return (
                  <tr key={s.name} className="region-mw-tr">
                    <td className="region-mw-td region-mw-td-name vol-mw-td-metric">
                      <span className="vol-mw-metric-icon" aria-hidden="true">
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
                    </td>

                    <td
                      className={`region-mw-td region-mw-td-num ${seriesMissing ? 'region-mw-heat--na' : bucketClass(bucketSpot)}`}
                      {...cellCommonProps}
                    >
                      {seriesMissing ? 'N/A' : formatValue(row.lastPx)}
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

                    <td
                      className={`region-mw-td region-mw-td-num vol-mw-sep-left ${seriesMissing ? 'region-mw-heat--na' : rocTone(dod.percent)}`}
                      {...cellCommonProps}
                    >
                      {seriesMissing ? 'N/A' : formatRocBps(dod.bps)}
                    </td>
                    <td
                      className={`region-mw-td region-mw-td-num ${seriesMissing ? 'region-mw-heat--na' : rocTone(dod.percent)}`}
                      {...cellCommonProps}
                    >
                      {seriesMissing ? 'N/A' : formatRocPercent(dod.percent)}
                    </td>

                    <td
                      className={`region-mw-td region-mw-td-num vol-mw-sep-left ${seriesMissing ? 'region-mw-heat--na' : rocTone(vov.percent)}`}
                      {...cellCommonProps}
                    >
                      {seriesMissing ? 'N/A' : formatRocBps(vov.bps)}
                    </td>
                    <td
                      className={`region-mw-td region-mw-td-num ${seriesMissing ? 'region-mw-heat--na' : rocTone(vov.percent)}`}
                      {...cellCommonProps}
                    >
                      {seriesMissing ? 'N/A' : formatRocPercent(vov.percent)}
                    </td>

                    <td
                      className={`region-mw-td region-mw-td-num vol-mw-sep-left ${seriesMissing ? 'region-mw-heat--na' : rocTone(mom.percent)}`}
                      {...cellCommonProps}
                    >
                      {seriesMissing ? 'N/A' : formatRocBps(mom.bps)}
                    </td>
                    <td
                      className={`region-mw-td region-mw-td-num ${seriesMissing ? 'region-mw-heat--na' : rocTone(mom.percent)}`}
                      {...cellCommonProps}
                    >
                      {seriesMissing ? 'N/A' : formatRocPercent(mom.percent)}
                    </td>
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
              const isFirst = i === 0;
              const math =
                r.max == null
                  ? `${r.min}+`
                  : isFirst
                  ? `<${r.max}`
                  : `${r.min}–${r.max}`;
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

const VolatilityTableWithTabs = ({ statusIndicator }) => {
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
    <div className="volatility-tabs">
      <div className="region-chart-header region-chart-header--mw volatility-header-with-tabs">
        <div className="region-header-left">
          <span className="card-header-icon card-header-icon--blue">
            <Activity size={16} strokeWidth={2} />
          </span>
          <span className="region-label region-label--lg">Volatility</span>
        </div>
        <div className="volatility-tab-buttons-inline">
          <button type="button" className="volatility-tab-btn active" aria-pressed="true">BPS</button>
          <button type="button" className="volatility-tab-btn" aria-pressed="false">%</button>
        </div>
        <StatusDot
          updatedAt={lastUpdated}
          status={derivedStatus}
          size={8}
          label="Volatility data"
          emoji={status.emoji}
          sources={volSources}
        />
      </div>
      <VolRangesPopover indicatorKey={openIndicator} onClose={() => setOpenIndicator(null)} />
      <VolatilityTable
        onIndicatorHelp={setOpenIndicator}
        onLastUpdatedChange={setLastUpdated}
        onSourcesChange={setVolSources}
      />
    </div>
  );
};

export default VolatilityTable;
export { VolatilityTableWithTabs };
