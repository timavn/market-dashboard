import { useCallback, useEffect, useRef } from 'react';
import { USDMarketService } from '../services/api/usdMarketService';
import { REFRESH_INTERVALS } from '../constants/usdMarket';
import { useDashboardResource } from './useDashboardResource';

export const CORRELATION_RETRY_DELAYS_MS = [2000, 5000, 15000, 60000];
export const CORRELATION_FAILURE_POLL_MS = 5 * 60 * 1000;
export const CORRELATION_REFERENCE_STORAGE_KEY = 'market-dashboard.reference.usd-correlations.v1';

export const EMPTY_CORRELATION_DATA = Object.freeze({
  correlations: null,
  rollingStats: null,
  correlationsTimestamp: null,
  calculationDate: null,
  fxvlSnapshot: null,
});

function validateCorrelationResponse(data) {
  if (
    data?.sourceStatus !== 'current'
    || !data?.correlations
    || !data?.rollingStats
    || !data?.timestamp
    || !data?.calculationDate
  ) {
    throw new Error(data?.error || 'Current USD correlation data is unavailable');
  }
  return {
    correlations: data.correlations,
    rollingStats: data.rollingStats,
    correlationsTimestamp: data.timestamp,
    calculationDate: data.calculationDate,
    fxvlSnapshot: data.fxvlSnapshot || null,
  };
}

export function useUsdCorrelations({
  service = USDMarketService,
  retryDelaysMs = CORRELATION_RETRY_DELAYS_MS,
  failurePollMs = CORRELATION_FAILURE_POLL_MS,
  successPollMs = REFRESH_INTERVALS.CORRELATIONS,
} = {}) {
  const timerRef = useRef(null);
  const failureCountRef = useRef(0);
  const mountedRef = useRef(false);

  const resource = useDashboardResource('usd-correlations', {}, {
    fetcher: () => service.getCorrelations(),
    validate: validateCorrelationResponse,
    getObservedAt: (data) => data.correlationsTimestamp || data.calculationDate,
    enabled: false,
    core: true,
  });

  const { refresh } = resource;

  const runAndSchedule = useCallback(async () => {
    if (!mountedRef.current) return;
    const committed = await refresh();
    if (!mountedRef.current) return;
    const succeeded = Boolean(committed);
    const delay = succeeded
      ? successPollMs
      : retryDelaysMs[failureCountRef.current] ?? failurePollMs;
    failureCountRef.current = succeeded ? 0 : failureCountRef.current + 1;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(runAndSchedule, delay);
  }, [failurePollMs, refresh, retryDelaysMs, successPollMs]);

  useEffect(() => {
    mountedRef.current = true;
    runAndSchedule();
    return () => {
      mountedRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
    };
  }, [runAndSchedule]);

  const retry = useCallback(() => {
    failureCountRef.current = 0;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    refresh();
  }, [refresh]);

  const data = resource.data || EMPTY_CORRELATION_DATA;
  return {
    ...data,
    loading: resource.initialLoading && !resource.data,
    refreshing: resource.refreshing,
    availability: resource.availability,
    observedAt: resource.observedAt,
    hydratedFromStorage: resource.hydratedFromStorage,
    persistedAt: resource.persistedAt,
    error: resource.error?.message || null,
    retry,
  };
}

export default useUsdCorrelations;
