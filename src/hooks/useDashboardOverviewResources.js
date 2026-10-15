import { useCallback, useEffect, useState } from 'react';
import { useDashboardResource } from './useDashboardResource';
import { MarketDataService } from '../services/api/marketDataService';
import { MARKET_QUOTES_MAX_AGE_MS, MARKET_PERIOD_RETURNS_POLL_MS } from '../constants/dashboardResourceTiming';
import { MARKET_QUOTE_FUTURE_TOLERANCE_MS, marketPayloadObservedAt, validateMarketQuotePayload, validatePeriodReturnPayload } from '../utils/marketQuoteFreshness';

const scheduleBackgroundTask = (callback, timeout = 1) => {
  if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(callback, { timeout: Math.max(timeout, 1000) });
    return () => window.cancelIdleCallback?.(id);
  }
  const setTimer = typeof window !== 'undefined' ? window.setTimeout : setTimeout;
  const clearTimer = typeof window !== 'undefined' ? window.clearTimeout : clearTimeout;
  const id = setTimer(callback, timeout);
  return () => clearTimer(id);
};

export function useDashboardOverviewResources({ surfaceActive }) {
  const [periodHydrationEnabled, setPeriodHydrationEnabled] = useState(false);

  const loadCurrentMarketQuotes = useCallback(
    () => MarketDataService.getMultiRegionQuotes(null, true, false),
    [],
  );

  const loadMarketPeriodReturns = useCallback(
    () => MarketDataService.getMultiRegionQuotes(null, false, true),
    [],
  );

  const currentMarketResource = useDashboardResource('market-quotes', {}, {
    fetcher: loadCurrentMarketQuotes,
    validate: validateMarketQuotePayload,
    getObservedAt: marketPayloadObservedAt,
    maxAgeMs: MARKET_QUOTES_MAX_AGE_MS,
    futureToleranceMs: MARKET_QUOTE_FUTURE_TOLERANCE_MS,
    pollIntervalMs: 30_000,
    active: true,
    pollWhenHidden: true,
    pollWhenDocumentHidden: false,
    // The overview keeps dated readings; its row markers disclose failed refreshes.
    core: true,
    expiredCode: 'MARKET_QUOTES_EXPIRED',
    expiredMessage: 'The last verified market quote observations expired.',
  });

  const periodReturnsResource = useDashboardResource('market-period-returns', {}, {
    fetcher: loadMarketPeriodReturns,
    validate: validatePeriodReturnPayload,
    getObservedAt: (payload) => marketPayloadObservedAt(payload, { periodOnly: true }),
    pollIntervalMs: MARKET_PERIOD_RETURNS_POLL_MS,
    enabled: periodHydrationEnabled,
    active: surfaceActive,
    refreshOnActivate: false,
    pollWhenHidden: false,
    core: true,
  });

  useEffect(() => {
    const cancelBackgroundHydration = scheduleBackgroundTask(
      () => setPeriodHydrationEnabled(true),
      1500,
    );
    return () => cancelBackgroundHydration?.();
  }, []);

  return { currentMarketResource, periodReturnsResource };
}

export default useDashboardOverviewResources;
