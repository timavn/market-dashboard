import { useCallback, useEffect, useRef, useState } from 'react';
import { MarketDataService } from '../services/api/marketDataService';
import { startVisibilityAwarePolling } from '../utils/visibilityAwarePolling';
import { REFERENCE_DATA_POLL_MS } from '../constants/dashboardResourceTiming';

export function useDashboardChangelog({ surfaceActive, showMorningTldr, showSignalStrength }) {
  const [hedgeyeChangelog, setHedgeyeChangelog] = useState(null);

  const [hedgeyeChangelogLoading, setHedgeyeChangelogLoading] = useState(true);

  const [hedgeyeChangelogError, setHedgeyeChangelogError] = useState(null);

  const changelogInFlightRef = useRef(null);

  const changelogRefreshCompletedAtRef = useRef(0);

  const fetchHedgeyeChangelog = useCallback(async (silent = false) => {
    if (changelogInFlightRef.current) return changelogInFlightRef.current;
    const request = (async () => {
      try {
        if (!silent) {
          setHedgeyeChangelogLoading(true);
        }
        setHedgeyeChangelogError(null);
        const data = await MarketDataService.getHedgeyeChangelog();
        setHedgeyeChangelog(data);
        changelogRefreshCompletedAtRef.current = Date.now();
        const cacheAgeSeconds = Number(data?._cache?.ageSeconds);
        if (data?._cache?.stale) {
          const ageLabel = Number.isFinite(cacheAgeSeconds)
            ? ` (${Math.max(1, Math.round(cacheAgeSeconds / 60))} minutes old)`
            : '';
          setHedgeyeChangelogError(`Showing a stale cached changelog response${ageLabel}.`);
        }
        return data;
      } catch (e) {
        console.error('Failed to load Hedgeye changelog:', e);
        setHedgeyeChangelogError(e.message || 'Failed to load latest updates');
        setHedgeyeChangelog((current) => current || {});
        return null;
      } finally {
        setHedgeyeChangelogLoading(false);
      }
    })().finally(() => {
      if (changelogInFlightRef.current === request) changelogInFlightRef.current = null;
    });
    changelogInFlightRef.current = request;
    return request;
  }, []);

  useEffect(() => {
    if (!surfaceActive || (!showMorningTldr && !showSignalStrength)) return undefined;
    const poll = () => fetchHedgeyeChangelog(true);
    const elapsedMs = Date.now() - changelogRefreshCompletedAtRef.current;
    const initialDelayMs = changelogRefreshCompletedAtRef.current > 0
      ? Math.max(0, REFERENCE_DATA_POLL_MS - elapsedMs)
      : 0;
    if (initialDelayMs <= 0 && (typeof document === 'undefined' || !document.hidden)) poll();
    return startVisibilityAwarePolling({
      intervalMs: REFERENCE_DATA_POLL_MS,
      poll,
      initialDelayMs: initialDelayMs <= 0 ? REFERENCE_DATA_POLL_MS : initialDelayMs,
    });
  }, [fetchHedgeyeChangelog, showMorningTldr, showSignalStrength, surfaceActive]);

  return { hedgeyeChangelog, hedgeyeChangelogLoading, hedgeyeChangelogError, fetchHedgeyeChangelog };
}

export default useDashboardChangelog;
