import React, { useCallback, useState, useEffect, useLayoutEffect, useRef } from 'react';
import { MarketDataService } from '../../services/api/marketDataService';
import { useDashboardResource } from '../../hooks/useDashboardResource';
import {
  calculateVolumeMetrics,
  getVolumeCardHeaderDate
} from '../../utils/volumeCardUtils';
import { getMarketDayFreshness } from '../../utils/timeUtils';
import { useSurfaceActivity } from '../common/PersistentSurface';
import './MarketVolumeTable.css';

export { calculateVolumeMetrics, getVolumeCardHeaderDate };

const EMPTY_VOLUME_METRICS = {
  priorDay: null,
  avg1M: null,
  avg3M: null,
  avg1Y: null,
  pctPriorDay: null,
  pct1M: null,
  pct3M: null,
  pct1Y: null
};

const HEAT_CAP_PCT = 50;
const MARKET_VOLUME_REFRESH_MS = 15 * 60 * 1000;

const getVolumeSourceTimestamp = (response) => {
  const metadata = response?.meta || {};
  return metadata.uploadDate
    || metadata.slideDate
    || metadata.fetchedAt
    || metadata.generatedAt
    || metadata.asOfTradingDate
    || response?.asOf
    || response?.totalMarket?.[0]?.date
    || response?.totalExchange?.[0]?.date
    || null;
};

const pctHeatProps = (val) => {
  if (val == null || Number.isNaN(val)) return { className: 'region-mw-heat--na', style: {} };
  const numeric = Number(val);
  if (!Number.isFinite(numeric)) return { className: 'region-mw-heat--na', style: {} };
  const sign = numeric >= 0 ? 'pos' : 'neg';
  const intensity = Math.min(Math.abs(numeric) / HEAT_CAP_PCT, 1);
  return { className: `region-mw-heat--${sign}`, style: { '--heat': intensity } };
};

const MarketVolumeTable = ({
  onLastUpdatedChange,
  onSourcesChange,
  onHeaderNoteChange,
  onMetadataChange,
}) => {
  const surfaceActive = useSurfaceActivity();
  const onLastUpdatedRef = useRef(onLastUpdatedChange);
  const onSourcesRef = useRef(onSourcesChange);
  const onHeaderNoteRef = useRef(onHeaderNoteChange);
  const onMetadataRef = useRef(onMetadataChange);
  onLastUpdatedRef.current = onLastUpdatedChange;
  onSourcesRef.current = onSourcesChange;
  onHeaderNoteRef.current = onHeaderNoteChange;
  onMetadataRef.current = onMetadataChange;

  const [loading, setLoading] = useState(true);
  const [metrics, setMetrics] = useState({
    date: '',
    totalMarket: EMPTY_VOLUME_METRICS,
    exchange: EMPTY_VOLUME_METRICS
  });
  const [datasetMeta, setDatasetMeta] = useState({
    methodologyVersion: null,
    sourceBreakdown: [],
    status: 'missing',
    asOfTradingDate: null,
    fetchedAt: null,
    calibration: null,
    footnotes: []
  });
  const [errorMessage, setErrorMessage] = useState('');
  const fetchVolume = useCallback(
    () => MarketDataService.getMarketShareVolume(365),
    [],
  );
  const volumeResource = useDashboardResource('market-volume', {}, {
    fetcher: fetchVolume,
    validate: (response) => (
      response && typeof response === 'object' ? response : null
    ),
    getObservedAt: getVolumeSourceTimestamp,
    pollIntervalMs: MARKET_VOLUME_REFRESH_MS,
    active: surfaceActive,
    // The preview and full detail share this key. Opening the detail should
    // consume the existing dated snapshot, not trigger a second request.
    refreshOnActivate: false,
  });

  useLayoutEffect(() => {
    const applyData = () => {
      const response = volumeResource.data;
      if (!response) return;
      try {
        const totalMarketSeries = Array.isArray(response.totalMarket) ? [...response.totalMarket] : [];
        const totalExchangeSeries = Array.isArray(response.totalExchange)
          ? [...response.totalExchange]
          : [];
        const slideMetrics = response.metrics || null;
        const responseMeta = response.meta || {};
        const asOf = response.asOf || responseMeta.asOfTradingDate || null;
        const effectiveTimestamp =
          responseMeta.uploadDate ||
          responseMeta.slideDate ||
          responseMeta.fetchedAt ||
          responseMeta.generatedAt ||
          asOf ||
          totalMarketSeries[0]?.date ||
          totalExchangeSeries[0]?.date ||
          null;
        const sourceBreakdown = Array.isArray(responseMeta.sourceBreakdown)
          ? responseMeta.sourceBreakdown
          : [];

        const nextDatasetMeta = {
          methodologyVersion: responseMeta.methodologyVersion || null,
          sourceBreakdown,
          status: responseMeta.status || 'missing',
          asOfTradingDate: responseMeta.asOfTradingDate || asOf || null,
          fetchedAt: responseMeta.fetchedAt || null,
          calibration: responseMeta.calibration || null,
          footnotes: Array.isArray(responseMeta.footnotes) ? responseMeta.footnotes : []
        };
        setDatasetMeta(nextDatasetMeta);
        if (onMetadataRef.current) {
          onMetadataRef.current(nextDatasetMeta);
        }
        if (!volumeResource.error) setErrorMessage('');

        if (slideMetrics?.totalMarket && slideMetrics?.exchange) {
          const nextMetrics = {
            date: getVolumeCardHeaderDate({
              asOf,
              totalMarket: totalMarketSeries,
              totalExchange: totalExchangeSeries
            }),
            totalMarket: slideMetrics.totalMarket,
            exchange: slideMetrics.exchange
          };
          setMetrics(nextMetrics);

          if (onHeaderNoteRef.current) {
            onHeaderNoteRef.current(nextMetrics.date || '');
          }

          if (onLastUpdatedRef.current) {
            onLastUpdatedRef.current(effectiveTimestamp);
          }
          if (onSourcesRef.current) {
            onSourcesRef.current([
              {
                id: 'hedgeyeVolumeSlide',
                label: 'Hedgeye Volume Slide',
                updatedAt: effectiveTimestamp,
                status: getMarketDayFreshness(effectiveTimestamp)
              }
            ]);
          }

          setLoading(false);
          return;
        }

        const hasMarket = totalMarketSeries.length > 0;
        const hasExchange = totalExchangeSeries.length > 0;
        const hasEnoughHistory = totalMarketSeries.length >= 2 && totalExchangeSeries.length >= 2;
        if (!hasEnoughHistory) {
          const unavailableSources = sourceBreakdown.length > 0
            ? sourceBreakdown.map((source) => ({
                id: source.id,
                label: source.label,
                updatedAt: effectiveTimestamp,
                status: 'defective'
              }))
            : [
                {
                  id: 'marketStructureDaily',
                  label: 'Market Structure Daily',
                  updatedAt: effectiveTimestamp,
                  status: 'defective'
                }
              ];

          if (onLastUpdatedRef.current) {
            onLastUpdatedRef.current(effectiveTimestamp);
          }
          if (onSourcesRef.current) {
            onSourcesRef.current(unavailableSources);
          }

          setMetrics({
            date: getVolumeCardHeaderDate(response),
            totalMarket: EMPTY_VOLUME_METRICS,
            exchange: EMPTY_VOLUME_METRICS
          });
          setErrorMessage(
            responseMeta.status === 'stale'
              ? 'Market structure data is stale and waiting for the latest completed trading-day record.'
              : 'Market structure data is not available yet for this card.'
          );
          setLoading(false);
          return;
        }

        if (hasMarket) totalMarketSeries.sort((a, b) => new Date(b.date) - new Date(a.date));
        if (hasExchange) totalExchangeSeries.sort((a, b) => new Date(b.date) - new Date(a.date));

        const responseForDate = {
          asOf,
          totalMarket: totalMarketSeries,
          totalExchange: totalExchangeSeries
        };
        const formattedDate = getVolumeCardHeaderDate(responseForDate);

        const totalMarketVolumes = totalMarketSeries.map((d) => d.volume || 0);
        const totalExchangeVolumes = totalExchangeSeries.map((d) => d.volume || 0);

        const totalMarketMetrics =
          totalMarketVolumes.length >= 2
            ? calculateVolumeMetrics(totalMarketVolumes)
            : EMPTY_VOLUME_METRICS;
        const exchangeMetrics =
          totalExchangeVolumes.length >= 2
            ? calculateVolumeMetrics(totalExchangeVolumes)
            : EMPTY_VOLUME_METRICS;

        setMetrics({
          date: formattedDate,
          totalMarket: totalMarketMetrics,
          exchange: exchangeMetrics
        });

        if (onHeaderNoteRef.current) {
          onHeaderNoteRef.current(formattedDate || '');
        }

        if (onLastUpdatedRef.current) {
          onLastUpdatedRef.current(effectiveTimestamp);
        }
        if (onSourcesRef.current) {
          const sources =
            sourceBreakdown.length > 0
              ? sourceBreakdown.map((source) => ({
                  id: source.id,
                  label: source.label,
                  updatedAt: effectiveTimestamp,
                  status: getMarketDayFreshness(effectiveTimestamp)
                }))
              : [];

          if (hasMarket && sources.length === 0) {
            sources.push({
              id: 'totalMarketVolume',
              label: 'Total Market Volume',
              updatedAt: effectiveTimestamp,
              status: getMarketDayFreshness(effectiveTimestamp)
            });
          }
          if (hasExchange && sources.length < 2) {
            sources.push({
              id: 'totalExchangeVolume',
              label: 'Total Exchange Volume',
              updatedAt: effectiveTimestamp,
              status: getMarketDayFreshness(effectiveTimestamp)
            });
          }
          onSourcesRef.current(sources);
        }

        setLoading(false);
      } catch (error) {
        console.error('Failed to process volume data', error);
        setErrorMessage('The market structure dataset could not be processed.');
        setLoading(false);
      }
    };

    applyData();
  }, [volumeResource.data, volumeResource.error]);

  useEffect(() => {
    if (volumeResource.initialLoading) return;
    setLoading(false);
    if (!volumeResource.error) return;
    setErrorMessage(volumeResource.data
      ? 'Refresh delayed. Showing the last dated market structure snapshot.'
      : 'Failed to load the market structure dataset for this card.');
    if (!volumeResource.data && onSourcesRef.current) {
      onSourcesRef.current([{
        id: 'marketStructureDaily',
        label: 'Market Structure Daily',
        updatedAt: null,
        status: 'defective',
      }]);
    }
  }, [volumeResource.data, volumeResource.error, volumeResource.initialLoading]);

  const formatPct = (val) => {
    if (val === null || Number.isNaN(val)) return '--';
    const num = Math.round(val);
    return `${num}%`;
  };

  if (loading) {
    return (
      <div className="text-xs text-center p-4 dark:text-gray-400">
        Loading Volume...
      </div>
    );
  }

  const totalMarketFootnote =
    datasetMeta.footnotes[0] ||
    datasetMeta.sourceBreakdown.find((source) =>
      source.id === 'totalMarketVolume' || source.id === 'hedgeyeVolumeSlide'
    )?.description ||
    'Total Market Volume = consolidated U.S. market share volume from the market-structure dataset.';
  const totalExchangeFootnote =
    datasetMeta.footnotes[1] ||
    datasetMeta.sourceBreakdown.find((source) => source.id === 'totalExchangeVolume')
      ?.description ||
    (datasetMeta.methodologyVersion === 'hedgeye-volume-slide-direct-v1'
      ? 'Tape A+B+C volume = total US exchange volume.'
      : 'Total Exchange Volume = listed U.S. exchange share volume from the market-structure dataset.');
  const calibrationNote =
    datasetMeta.status === 'provisional'
      ? 'Methodology calibration is still in progress against the Hedgeye benchmark history.'
      : null;

  const getPctClass = (val) => {
    if (val == null || Number.isNaN(val)) return 'volume-value';
    if (val > 0) return 'volume-value positive';
    if (val < 0) return 'volume-value negative';
    return 'volume-value';
  };

  return (
    <div className="market-volume-table market-volume-table--mw">
      {errorMessage ? <div className="volume-error-state">{errorMessage}</div> : null}

      <div className="region-mw-body">
        <div className="region-mw-table-wrap">
          <table className="region-mw-quotes-table volume-mw-table">
            <thead>
              <tr>
                <th className="region-mw-th region-mw-th-trend" aria-hidden="true" />
                <th className="region-mw-th region-mw-th-name" scope="col">
                  METRIC
                </th>
                <th className="region-mw-th region-mw-th-num region-mw-th-metric" scope="col">
                  PRIOR DAY
                </th>
                <th className="region-mw-th region-mw-th-num region-mw-th-metric" scope="col">
                  1M AVG
                </th>
                <th className="region-mw-th region-mw-th-num region-mw-th-metric" scope="col">
                  3M AVG
                </th>
                <th className="region-mw-th region-mw-th-num region-mw-th-metric" scope="col">
                  1Y AVG
                </th>
              </tr>
            </thead>
            <tbody>
              {[
                { key: 'totalMarket', label: 'Total Market Volume*', values: metrics.totalMarket },
                { key: 'exchange', label: 'Total Exchange Volume**', values: metrics.exchange }
              ].map((row) => {
                const a = row.values;
                const cols = [
                  { v: a.pctPriorDay },
                  { v: a.pct1M },
                  { v: a.pct3M },
                  { v: a.pct1Y }
                ];
                const trendValue = cols.find((c) => c.v != null && !Number.isNaN(c.v))?.v;
                const isPos = trendValue == null ? null : trendValue >= 0;
                return (
                  <tr key={row.key} className="region-mw-tr">
                    <td className="region-mw-td region-mw-td-trend" aria-hidden="true">
                      {isPos != null ? (
                        <span className={isPos ? 'mw-trend-up' : 'mw-trend-down'}>{isPos ? '▲' : '▼'}</span>
                      ) : null}
                    </td>
                    <td className="region-mw-td region-mw-td-name">{row.label}</td>
                    {cols.map((c, idx) => {
                      const heat = pctHeatProps(c.v);
                      const pctClass = getPctClass(c.v);
                      const toneClass = pctClass.includes('positive')
                        ? 'positive'
                        : pctClass.includes('negative')
                        ? 'negative'
                        : '';
                      return (
                        <td
                          key={idx}
                          className={`region-mw-td region-mw-td-num region-mw-td-heat ${heat.className} ${toneClass}`}
                          style={heat.style}
                        >
                          {formatPct(c.v)}
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

      <div className="volume-footnotes">
        <p>*{totalMarketFootnote}</p>
        <p>**{totalExchangeFootnote}</p>
        {calibrationNote ? <p className="volume-footnote-status">{calibrationNote}</p> : null}
      </div>
    </div>
  );
};

export default MarketVolumeTable;
