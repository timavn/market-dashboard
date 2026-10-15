import { useCallback, useEffect, useState } from 'react';
import { useDashboardResource } from '../../../hooks/useDashboardResource';
import { MarketDataService } from '../../../services/api/marketDataService';
import { startVisibilityAwarePolling } from '../../../utils/visibilityAwarePolling';
import { normalizeMomoTrackerSnapshot, normalizeVerifiedMomoTrackerSpots, newYorkDateKey } from './momoTrackerContext';
import { supplementalMomoRows } from './sp500ContributorsContext';

const MOMO_TRACKER_POLL_MS = 15 * 60_000;
const MOMO_SPOT_POLL_MS = 15_000;

export function useMomoTrackerReference({ active, normalizedMarketId, chartRange, contributors = null }) {
  const [momoTrackerSpots, setMomoTrackerSpots] = useState({});

  const loadMomoTracker = useCallback(
    () => MarketDataService.getHedgeyeSnapshot('momo-tracker'),
    [],
  );
  const momoTrackerResource = useDashboardResource('momo-tracker', {}, {
    fetcher: loadMomoTracker,
    validate: (payload) => {
      const normalized = normalizeMomoTrackerSnapshot(payload || {});
      if (normalized.status === 'available') return normalized;
      throw new Error(normalized.reason || 'No verified current MOMO publication is available.');
    },
    getObservedAt: (value) => value.publicationDate,
    pollIntervalMs: MOMO_TRACKER_POLL_MS,
    active: active && normalizedMarketId === 'sp500' && chartRange === '1d',
    refreshOnActivate: true,
  });
  const contributorPublication = normalizeMomoTrackerSnapshot(contributors?.momoSnapshot || {});
  const momoTrackerSnapshot = contributorPublication.status === 'available'
    ? contributorPublication : momoTrackerResource.data;
  const momoTrackerState = momoTrackerSnapshot
    ? contributorPublication.status === 'available' || !momoTrackerResource.error ? 'available' : 'refresh-delayed'
    : momoTrackerResource.initialLoading ? 'loading' : 'unavailable';

  const currentPublication = ['available', 'refresh-delayed'].includes(momoTrackerState)
    && momoTrackerSnapshot?.status === 'available'
    && momoTrackerSnapshot.publicationDate === newYorkDateKey();
  const contributorRows = contributors?.rows || [];
  const supplementalRows = supplementalMomoRows([
    ...(contributors?.supplementalRows || []),
    ...(currentPublication ? momoTrackerSnapshot.rows : []),
  ], contributorRows);
  const contributorTickerKey = [...contributorRows, ...supplementalRows].map((row) => row.ticker).join(',');
  useEffect(() => {
    const tickers = contributorTickerKey ? contributorTickerKey.split(',') : [];
    const enabled = active
      && normalizedMarketId === 'sp500'
      && chartRange === '1d';
    if (!enabled || !tickers.length) return undefined;

    let disposed = false;
    const loadMomoSpots = async () => {
      try {
        const [quotes, providerStatus] = await Promise.all([
          MarketDataService.getQuotes(tickers),
          MarketDataService.getProviderStatus(),
        ]);
        const normalized = normalizeVerifiedMomoTrackerSpots(
          tickers,
          quotes,
          providerStatus,
          Date.now(),
        );
        if (!disposed) setMomoTrackerSpots(normalized);
      } catch (error) {
        if (disposed || error?.code === 'ERR_CANCELED' || error?.name === 'CanceledError') return;
        setMomoTrackerSpots({});
      }
    };

    if (!document.hidden) void loadMomoSpots();
    const stop = startVisibilityAwarePolling({ poll: loadMomoSpots, intervalMs: MOMO_SPOT_POLL_MS });
    return () => {
      disposed = true;
      stop();
    };
  }, [active, chartRange, contributorTickerKey, normalizedMarketId]);

  return { snapshot: momoTrackerSnapshot, state: momoTrackerState, spots: momoTrackerSpots };
}

export default useMomoTrackerReference;
