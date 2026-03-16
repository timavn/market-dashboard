import React, { useState, useEffect, useRef } from 'react';
import { MarketDataService } from '../../services/api/marketDataService';
import {
  calculateVolumeMetrics,
  getVolumeCardHeaderDate
} from '../../utils/volumeCardUtils';
import { getSourceFreshness, SOURCE_POLL_INTERVALS } from '../../utils/timeUtils';

export { calculateVolumeMetrics, getVolumeCardHeaderDate };

const MarketVolumeTable = ({ onLastUpdatedChange, onSourcesChange }) => {
  const onLastUpdatedRef = useRef(onLastUpdatedChange);
  const onSourcesRef = useRef(onSourcesChange);
  onLastUpdatedRef.current = onLastUpdatedChange;
  onSourcesRef.current = onSourcesChange;

  const [loading, setLoading] = useState(true);
  const [metrics, setMetrics] = useState({
    date: '',
    totalMarket: {
      priorDay: null,
      avg1M: null,
      avg3M: null,
      avg1Y: null,
      pctPriorDay: null,
      pct1M: null,
      pct3M: null,
      pct1Y: null
    },
    exchange: {
      priorDay: null,
      avg1M: null,
      avg3M: null,
      avg1Y: null,
      pctPriorDay: null,
      pct1M: null,
      pct3M: null,
      pct1Y: null
    }
  });

  useEffect(() => {
    const fetchData = async () => {
      try {
        const daysToFetch = 365; // Need 1 year of data
        let totalMarketSeries = [];
        let totalExchangeSeries = [];
        let asOf = null;

        try {
          const response = await MarketDataService.getMarketShareVolume(daysToFetch);
          totalMarketSeries = Array.isArray(response.totalMarket) ? [...response.totalMarket] : [];
          totalExchangeSeries = Array.isArray(response.totalExchange) ? [...response.totalExchange] : [];
          asOf = response.asOf || null;
        } catch (apiErr) {
          console.warn('Market-share volume API failed, using historical fallback:', apiErr?.message);
        }

        // Fallback: if either series has fewer than 2 points, build from historical (VTI, SPY, QQQ, IWM)
        const needFallback =
          totalMarketSeries.length < 2 || totalExchangeSeries.length < 2;
        if (needFallback) {
          try {
            const [vtiRes, spyRes, qqqRes, iwmRes] = await Promise.all([
              MarketDataService.getHistoricalData('VTI', daysToFetch),
              MarketDataService.getHistoricalData('SPY', daysToFetch),
              MarketDataService.getHistoricalData('QQQ', daysToFetch),
              MarketDataService.getHistoricalData('IWM', daysToFetch)
            ]);
            const vtiData = Array.isArray(vtiRes?.data) ? vtiRes.data : [];
            const spyData = Array.isArray(spyRes?.data) ? spyRes.data : [];
            const qqqData = Array.isArray(qqqRes?.data) ? qqqRes.data : [];
            const iwmData = Array.isArray(iwmRes?.data) ? iwmRes.data : [];

            if (vtiData.length >= 2) {
              totalMarketSeries = vtiData
                .filter((d) => d.volume != null)
                .map((d) => ({ date: d.date, volume: Number(d.volume) }));
              totalMarketSeries.sort((a, b) => new Date(b.date) - new Date(a.date));
              if (totalMarketSeries.length > 0 && !asOf) asOf = totalMarketSeries[0].date;
            }
            const spyMap = new Map(spyData.filter((d) => d.volume != null).map((d) => [d.date, Number(d.volume)]));
            const qqqMap = new Map(qqqData.filter((d) => d.volume != null).map((d) => [d.date, Number(d.volume)]));
            const iwmMap = new Map(iwmData.filter((d) => d.volume != null).map((d) => [d.date, Number(d.volume)]));
            totalExchangeSeries = totalMarketSeries
              .filter((row) => {
                const sv = spyMap.get(row.date);
                const qv = qqqMap.get(row.date);
                const iv = iwmMap.get(row.date);
                return sv != null && qv != null && iv != null;
              })
              .map((row) => ({
                date: row.date,
                volume: spyMap.get(row.date) + qqqMap.get(row.date) + iwmMap.get(row.date)
              }));
          } catch (fallbackErr) {
            console.error('Historical fallback for volume failed:', fallbackErr);
          }
        }

        const hasMarket = totalMarketSeries.length > 0;
        const hasExchange = totalExchangeSeries.length > 0;
        if (!hasMarket && !hasExchange) {
          setLoading(false);
          return;
        }

        if (hasMarket) totalMarketSeries.sort((a, b) => new Date(b.date) - new Date(a.date));
        if (hasExchange) totalExchangeSeries.sort((a, b) => new Date(b.date) - new Date(a.date));

        const responseForDate = { asOf, totalMarket: totalMarketSeries, totalExchange: totalExchangeSeries };
        const formattedDate = getVolumeCardHeaderDate(responseForDate);

        const totalMarketVolumes = totalMarketSeries.map((d) => d.volume || 0);
        const totalExchangeVolumes = totalExchangeSeries.map((d) => d.volume || 0);

        const nullMetrics = {
          priorDay: null,
          avg1M: null,
          avg3M: null,
          avg1Y: null,
          pctPriorDay: null,
          pct1M: null,
          pct3M: null,
          pct1Y: null
        };
        const totalMarketMetrics =
          totalMarketVolumes.length >= 2 ? calculateVolumeMetrics(totalMarketVolumes) : nullMetrics;
        const exchangeMetrics =
          totalExchangeVolumes.length >= 2 ? calculateVolumeMetrics(totalExchangeVolumes) : nullMetrics;

        setMetrics({
          date: formattedDate,
          totalMarket: totalMarketMetrics,
          exchange: exchangeMetrics
        });

        const now = new Date().toISOString();
        const effectiveTimestamp = asOf || now;
        if (onLastUpdatedRef.current) {
          onLastUpdatedRef.current(effectiveTimestamp);
        }
        if (onSourcesRef.current) {
          const interval = SOURCE_POLL_INTERVALS.volumeData || 60000;
          const sources = [];
          if (hasMarket) {
            sources.push({
              id: 'totalMarket',
              label: 'Total Market Volume (VTI)',
              updatedAt: effectiveTimestamp,
              status: getSourceFreshness(effectiveTimestamp, interval)
            });
          }
          if (hasExchange) {
            sources.push({
              id: 'totalExchange',
              label: 'Exchange Volume (SPY+QQQ+IWM)',
              updatedAt: effectiveTimestamp,
              status: getSourceFreshness(effectiveTimestamp, interval)
            });
          }
          onSourcesRef.current(sources);
        }

        setLoading(false);
      } catch (error) {
        console.error('Failed to fetch volume data', error);
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

  const getPctClass = (val) => {
    if (val == null || Number.isNaN(val)) return 'volume-value';
    if (val > 0) return 'volume-value positive';
    if (val < 0) return 'volume-value negative';
    return 'volume-value';
  };

  return (
    <div className="market-volume-table">
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

      <div className="volume-footnotes">
        <p>
          *Total Market Volume = Total US exchange volume plus OTC and OTCBB trading volume for all
          security types. Calculated by Bloomberg.
        </p>
        <p>
          **Total Exchange Volume = Tape A+B+C volume = total US exchange volume.
        </p>
      </div>
    </div>
  );
};

export default MarketVolumeTable;

