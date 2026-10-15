import React, { useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import { MarketDataService } from '../../services/api/marketDataService';
import { useDashboardResource } from '../../hooks/useDashboardResource';
import {
  calculateVolumeMetrics,
  getVolumeCardHeaderDate,
  getVerifiedVolumeMarkets,
} from '../../utils/volumeCardUtils';
import {
  emptyVolumeMetrics,
  EXCHANGE_VOLUME_WINDOWS,
  EXCHANGE_VOLUME_SOURCE,
} from '../../utils/exchangeVolume.cjs';
import { EX_US_VOLUME_PROXY } from '../../constants/volumeMarkets.cjs';
import { useSurfaceActivity } from '../common/PersistentSurface';
import './MarketVolumeTable.css';

export { calculateVolumeMetrics, getVolumeCardHeaderDate };

const HEAT_CAP_PCT = 50;
const MARKET_VOLUME_REFRESH_MS = 15 * 60 * 1000;
const EMPTY_VOLUME_METRICS = emptyVolumeMetrics();
const getVolumeSourceTimestamp = (response) => {
  const { us, exUs } = getVerifiedVolumeMarkets(response);
  return us?.asOf || exUs?.asOf || null;
};
const validateVolumeResponse = (response) => getVolumeSourceTimestamp(response) ? response : null;
const VOLUME_COLUMNS = [
  { label: 'PRIOR DAY', key: 'pctPriorDay' },
  { label: '1M AVG', key: 'pct1M' },
  { label: '3M AVG', key: 'pct3M' },
  { label: '1Y AVG', key: 'pct1Y' },
];

const pctHeatProps = (value) => {
  if (!Number.isFinite(value) || value === 0) {
    return { className: 'region-mw-heat--na', style: {} };
  }
  const sign = value > 0 ? 'pos' : 'neg';
  const intensity = Math.min(Math.abs(value) / HEAT_CAP_PCT, 1);
  return { className: `region-mw-heat--${sign}`, style: { '--heat': intensity } };
};

const MarketVolumeTable = ({
  onLastUpdatedChange,
  onSourcesChange,
  onHeaderNoteChange,
  onMetadataChange,
  showDetails = false,
  showAsOf = true,
}) => {
  const surfaceActive = useSurfaceActivity();
  const callbacksRef = useRef({});
  callbacksRef.current = {
    onLastUpdatedChange, onSourcesChange, onHeaderNoteChange, onMetadataChange,
  };
  const fetchVolume = useCallback(
    () => MarketDataService.getMarketShareVolume(365),
    [],
  );
  const volumeResource = useDashboardResource('market-volume', {}, {
    fetcher: fetchVolume,
    validate: validateVolumeResponse,
    getObservedAt: getVolumeSourceTimestamp,
    pollIntervalMs: MARKET_VOLUME_REFRESH_MS,
    active: surfaceActive,
    // The preview and full detail share this key and the same verified response.
    refreshOnActivate: false,
  });
  const loading = Boolean(volumeResource.initialLoading || (
    !volumeResource.data && !volumeResource.error && volumeResource.availability === 'idle'
  ));
  const { us, exUs } = getVerifiedVolumeMarkets(
    !volumeResource.error && !volumeResource.hydratedFromStorage ? volumeResource.data : null,
  );
  const rows = useMemo(() => [
    { id: 'us', label: 'US', source: EXCHANGE_VOLUME_SOURCE, response: us },
    { id: EX_US_VOLUME_PROXY.id, label: EX_US_VOLUME_PROXY.label, source: {
      id: EX_US_VOLUME_PROXY.id, label: `IBKR · ${EX_US_VOLUME_PROXY.symbol}`,
    }, response: exUs },
  ], [us, exUs]);
  const availableCount = rows.filter((row) => row.response).length;
  const available = availableCount > 0;
  const asOf = us?.asOf || exUs?.asOf || null;
  const date = getVolumeCardHeaderDate({ asOf });

  useLayoutEffect(() => {
    const callbacks = callbacksRef.current;
    const metadata = {
      status: loading ? 'loading' : availableCount === rows.length ? 'current' : available ? 'partial' : 'unavailable',
      verified: available,
      asOfTradingDate: asOf,
      sourceBreakdown: rows.flatMap((row) => row.response?.meta.sourceBreakdown || []),
    };
    callbacks.onMetadataChange?.(metadata);
    callbacks.onHeaderNoteChange?.(date);
    callbacks.onLastUpdatedChange?.(asOf);
    callbacks.onSourcesChange?.(loading ? [] : rows.map((row) => ({
      id: row.source.id,
      label: row.source.label,
      updatedAt: row.response?.asOf || null,
      status: row.response ? 'current' : 'defective',
    })));
  }, [rows, loading, date, asOf, available, availableCount]);

  if (loading) {
    return <div className="text-xs text-center p-4 text-gray-500">Loading Volume...</div>;
  }

  return (
    <div className="market-volume-table market-volume-table--mw">
      {showAsOf || !available ? (
        <div className="text-xs text-gray-500 px-2 py-1">
          {asOf ? <>AS OF <time dateTime={asOf}>{date}</time></> : 'UNAVAILABLE'}
        </div>
      ) : null}
      <div className="region-mw-body">
        <div className="region-mw-table-wrap">
          <table className="region-mw-quotes-table volume-mw-table" aria-label="Exchange volume comparisons">
            <thead>
              <tr>
                <th className="region-mw-th region-mw-th-trend" aria-hidden="true" />
                <th className="region-mw-th region-mw-th-name" scope="col">METRIC</th>
                {VOLUME_COLUMNS.map(({ label }) => (
                  <th key={label} className="region-mw-th region-mw-th-num region-mw-th-metric" scope="col">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const metrics = row.response?.metrics.exchange || EMPTY_VOLUME_METRICS;
                const trendValue = metrics.pctPriorDay;
                const hasDirection = Number.isFinite(trendValue) && trendValue !== 0;
                return (
                  <tr key={row.id} className="region-mw-tr" aria-label={`${row.label} volume${row.response ? '' : ' unavailable'}`}>
                    <td className="region-mw-td region-mw-td-trend" aria-hidden="true">
                      {hasDirection ? (
                        <span className={trendValue > 0 ? 'mw-trend-up' : 'mw-trend-down'}>
                          {trendValue > 0 ? '▲' : '▼'}
                        </span>
                      ) : null}
                    </td>
                    <td className="region-mw-td region-mw-td-name">{row.label}</td>
                    {VOLUME_COLUMNS.map(({ label, key }) => {
                      const value = metrics[key];
                      const heat = pctHeatProps(value);
                      const tone = Number.isFinite(value) && value !== 0
                        ? value > 0 ? 'positive' : 'negative'
                        : '';
                      return (
                        <td
                          key={label}
                          className={`region-mw-td region-mw-td-num region-mw-td-heat ${heat.className} ${tone}`}
                          style={heat.style}
                        >
                          {Number.isFinite(value) ? `${Math.round(value)}%` : '—'}
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
      {showDetails ? (
        <div className="volume-footnotes">
          <p><strong>US:</strong> {EXCHANGE_VOLUME_SOURCE.label} consolidated Tape A+B+C share volume, including FINRA-reported trades in listed stocks.</p>
          <p>
            <strong>ex-US:</strong> {EX_US_VOLUME_PROXY.symbol} regular-session ETF volume from IBKR. The{' '}
            <a href={EX_US_VOLUME_PROXY.issuerUrl} target="_blank" rel="noreferrer">{EX_US_VOLUME_PROXY.name}</a>{' '}
            covers {EX_US_VOLUME_PROXY.coverage}{' '}
            This is trading in the U.S.-listed fund, not total overseas-exchange volume; it also forms part of the US total.
            IBKR filters out some trade types, so this series can differ from consolidated ETF volume.
          </p>
          <p>
            Previous New York trading date versus the prior session and the preceding{' '}
            {EXCHANGE_VOLUME_WINDOWS.avg1M}, {EXCHANGE_VOLUME_WINDOWS.avg3M} and{' '}
            {EXCHANGE_VOLUME_WINDOWS.avg1Y} trading-session averages, excluding the displayed session.
          </p>
          <p>Each row is compared with its own history. Positive means more activity; negative means less. Read alongside price and Trade/Trend, not as a standalone bullish or bearish signal. Dashes mean verified data is unavailable.</p>
        </div>
      ) : null}
    </div>
  );
};

export default MarketVolumeTable;
