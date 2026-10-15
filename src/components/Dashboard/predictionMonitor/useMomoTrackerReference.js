import { useCallback, useEffect, useState } from 'react';
import { useDashboardResource } from '../../../hooks/useDashboardResource';
import { MarketDataService } from '../../../services/api/marketDataService';
import { startVisibilityAwarePolling } from '../../../utils/visibilityAwarePolling';
import { isExplicitLiveInvalidation } from '../../../utils/sessionResourceStore';
import { MOMO_EXCLUDED_TICKERS } from '../../../constants/momoTrackerCatalog.cjs';
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
  // Poll only the displayed roster: GOOGL represents Alphabet, so GOOG is never quoted.
  const contributorRows = (contributors?.rows || [])
    .filter((row) => !MOMO_EXCLUDED_TICKERS.includes(row.ticker));
  const contributorSupplementalRows = supplementalMomoRows(contributors?.supplementalRows || [], contributorRows);
  const publicationRows = currentPublication
    ? supplementalMomoRows(momoTrackerSnapshot.rows, [...contributorRows, ...contributorSupplementalRows])
    : [];
  const rosterTickerKey = [...contributorRows, ...contributorSupplementalRows].map((row) => row.ticker).join(',');
  const publicationTickerKey = publicationRows.map((row) => row.ticker).join(',');
  const publicationDate = currentPublication ? momoTrackerSnapshot.publicationDate : null;
  useEffect(() => {
    const clearSpots = () => setMomoTrackerSpots((current) => (Object.keys(current).length ? {} : current));
    const rosterTickers = rosterTickerKey ? rosterTickerKey.split(',') : [];
    const publicationTickers = publicationTickerKey ? publicationTickerKey.split(',') : [];
    const enabled = active
      && normalizedMarketId === 'sp500'
      && chartRange === '1d';
    if (!enabled || (!rosterTickers.length && !publicationTickers.length)) {
      clearSpots();
      return undefined;
    }

    let disposed = false;
    const loadMomoSpots = async () => {
      // Publication additions belong to their New York publication day; once it
      // rolls over, stop quoting them and drop their same-day spots.
      const tickers = [
        ...rosterTickers,
        ...(publicationDate === newYorkDateKey() ? publicationTickers : []),
      ];
      if (!tickers.length) {
        clearSpots();
        return;
      }
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
        // An explicit provider invalidation (offline, disconnected, stale, cache)
        // clears every spot. A plain transport failure says nothing new: keep the
        // original observations, which currentMomoSpot expires by their own age.
        if (isExplicitLiveInvalidation(error)) setMomoTrackerSpots({});
      }
    };

    if (!document.hidden) void loadMomoSpots();
    const stop = startVisibilityAwarePolling({ poll: loadMomoSpots, intervalMs: MOMO_SPOT_POLL_MS });
    return () => {
      disposed = true;
      stop();
    };
  }, [active, chartRange, normalizedMarketId, publicationDate, publicationTickerKey, rosterTickerKey]);

  return { snapshot: momoTrackerSnapshot, state: momoTrackerState, spots: momoTrackerSpots };
}

export default useMomoTrackerReference;
