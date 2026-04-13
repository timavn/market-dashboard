import React, { useState, useEffect, useRef } from 'react';
import { MarketDataService } from '../../services/api/marketDataService';
import {
  calculateVolumeMetrics,
  getVolumeCardHeaderDate
} from '../../utils/volumeCardUtils';
import { getMarketDayFreshness } from '../../utils/timeUtils';

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

const MarketVolumeTable = ({ onLastUpdatedChange, onSourcesChange }) => {
  const onLastUpdatedRef = useRef(onLastUpdatedChange);
  const onSourcesRef = useRef(onSourcesChange);
  onLastUpdatedRef.current = onLastUpdatedChange;
  onSourcesRef.current = onSourcesChange;

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

  useEffect(() => {
    const fetchData = async () => {
      try {
        const daysToFetch = 365; // Need 1 year of data
        const response = await MarketDataService.getMarketShareVolume(daysToFetch);
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
          new Date().toISOString();
        const sourceBreakdown = Array.isArray(responseMeta.sourceBreakdown)
          ? responseMeta.sourceBreakdown
          : [];

        setDatasetMeta({
          methodologyVersion: responseMeta.methodologyVersion || null,
          sourceBreakdown,
          status: responseMeta.status || 'missing',
          asOfTradingDate: responseMeta.asOfTradingDate || asOf || null,
          fetchedAt: responseMeta.fetchedAt || null,
          calibration: responseMeta.calibration || null,
          footnotes: Array.isArray(responseMeta.footnotes) ? responseMeta.footnotes : []
        });
        setErrorMessage('');

        if (slideMetrics?.totalMarket && slideMetrics?.exchange) {
          setMetrics({
            date: getVolumeCardHeaderDate({
              asOf,
              totalMarket: totalMarketSeries,
              totalExchange: totalExchangeSeries
            }),
            totalMarket: slideMetrics.totalMarket,
            exchange: slideMetrics.exchange
          });

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
        console.error('Failed to fetch volume data', error);
        setErrorMessage('Failed to load the market structure dataset for this card.');
        setMetrics({
          date: '',
          totalMarket: EMPTY_VOLUME_METRICS,
          exchange: EMPTY_VOLUME_METRICS
        });
        setDatasetMeta((current) => ({
          ...current,
          status: 'missing'
        }));
        if (onSourcesRef.current) {
          onSourcesRef.current([
            {
              id: 'marketStructureDaily',
              label: 'Market Structure Daily',
              updatedAt: new Date().toISOString(),
              status: 'defective'
            }
          ]);
        }
        setLoading(false);
      }
    };

    fetchData();
  }, []);

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
    <div className="market-volume-table">
      {errorMessage ? (
        <div className="volume-error-state">
          {errorMessage}
        </div>
      ) : (
        <>
          <div className="volume-ribbon">
            <div className="volume-ribbon-left">Index/Security</div>
            <div className="volume-ribbon-right">
              <span className="volume-ribbon-label">Volume:</span>
              <span className="volume-ribbon-date">{metrics.date} vs.</span>
            </div>
          </div>

          <div className="volume-columns">
            <div className="volume-col volume-col-name" />
            <div className="volume-col">Prior Day</div>
            <div className="volume-col">1M Ave</div>
            <div className="volume-col">3M Ave</div>
            <div className="volume-col">1Y Ave</div>
          </div>

          <div className="volume-row">
            <div className="volume-name">Total Market Volume*</div>
            <div className={getPctClass(metrics.totalMarket.pctPriorDay)}>
              {formatPct(metrics.totalMarket.pctPriorDay)}
            </div>
            <div className={getPctClass(metrics.totalMarket.pct1M)}>
              {formatPct(metrics.totalMarket.pct1M)}
            </div>
            <div className={getPctClass(metrics.totalMarket.pct3M)}>
              {formatPct(metrics.totalMarket.pct3M)}
            </div>
            <div className={getPctClass(metrics.totalMarket.pct1Y)}>
              {formatPct(metrics.totalMarket.pct1Y)}
            </div>
          </div>

          <div className="volume-row volume-row-last">
            <div className="volume-name">Total Exchange Volume**</div>
            <div className={getPctClass(metrics.exchange.pctPriorDay)}>
              {formatPct(metrics.exchange.pctPriorDay)}
            </div>
            <div className={getPctClass(metrics.exchange.pct1M)}>
              {formatPct(metrics.exchange.pct1M)}
            </div>
            <div className={getPctClass(metrics.exchange.pct3M)}>
              {formatPct(metrics.exchange.pct3M)}
            </div>
            <div className={getPctClass(metrics.exchange.pct1Y)}>
              {formatPct(metrics.exchange.pct1Y)}
            </div>
          </div>
        </>
      )}

      <div className="volume-footnotes">
        <p>
          *{totalMarketFootnote}
        </p>
        <p>
          **{totalExchangeFootnote}
        </p>
        {calibrationNote ? <p className="volume-footnote-status">{calibrationNote}</p> : null}
      </div>
    </div>
  );
};

export default MarketVolumeTable;
