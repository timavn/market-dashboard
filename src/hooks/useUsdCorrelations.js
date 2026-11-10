import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { USDMarketService } from '../services/api/usdMarketService';
import { REFRESH_INTERVALS } from '../constants/usdMarket';
import { useDashboardResource } from './useDashboardResource';
import {
  isDisplayableFxVolatility,
  reconcileFxVolatility,
  retainFxVolatility,
} from '../utils/fxVolatilityReference';
import { readReferenceSnapshot, writeReferenceSnapshot } from '../utils/referenceSnapshotStorage';

export const CORRELATION_RETRY_DELAYS_MS = [2000, 5000, 15000, 60000];
export const CORRELATION_FAILURE_POLL_MS = 5 * 60 * 1000;
export const CORRELATION_REFERENCE_STORAGE_KEY = 'market-dashboard.reference.usd-correlations.v1';
export const FX_VOLATILITY_REFERENCE_STORAGE_KEY = 'market-dashboard.reference.fx-volatility.v1';
const FX_REFERENCE_CONFIG = Object.freeze({
  key: FX_VOLATILITY_REFERENCE_STORAGE_KEY,
  ttlMs: Number.MAX_SAFE_INTEGER,
});
const FX_REFERENCE_IDENTITY = Object.freeze({
  config: FX_REFERENCE_CONFIG,
  resourceKey: 'fx-volatility',
  scopeKey: 'dashboard',
  resourceClass: 'dated-reference',
});

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
    || ['mock', 'isMock', 'seeded', 'synthetic', 'inferred', 'cacheOnly', 'fromCache', 'stale', 'isStale']
      .some((key) => data?.[key] === true || data?.meta?.[key] === true)
    || data?._cache?.hit === true || data?._cache?.stale === true
    || data?.connected === false
    || !data?.correlations
    || !data?.rollingStats
    || !data?.timestamp
    || !data?.calculationDate
  ) {
    throw new Error(data?.error || 'Current USD correlation data is unavailable');
  }
  return {
    // Keep validation idempotent for reconciled and persisted snapshots.
    sourceStatus: data.sourceStatus,
    timestamp: data.timestamp,
    correlations: data.correlations,
    rollingStats: data.rollingStats,
    correlationsTimestamp: data.timestamp,
    calculationDate: data.calculationDate,
    fxvlSnapshot: isDisplayableFxVolatility(data.fxvlSnapshot) ? data.fxvlSnapshot : null,
  };
}

const reconcileCorrelationResponse = ({ currentData, incomingData, nowMs }) => ({
  ...incomingData,
  fxvlSnapshot: reconcileFxVolatility(currentData?.fxvlSnapshot, incomingData.fxvlSnapshot, nowMs),
});

export function useUsdCorrelations({
  service = USDMarketService,
  retryDelaysMs = CORRELATION_RETRY_DELAYS_MS,
  failurePollMs = CORRELATION_FAILURE_POLL_MS,
  successPollMs = REFRESH_INTERVALS.CORRELATIONS,
} = {}) {
  const timerRef = useRef(null);
  const failureCountRef = useRef(0);
  const mountedRef = useRef(false);
  const [fxReference, setFxReference] = useState(() => (
    retainFxVolatility(readReferenceSnapshot(FX_REFERENCE_IDENTITY)?.data)
  ));

  const resource = useDashboardResource('usd-correlations', {}, {
    fetcher: () => service.getCorrelations(),
    validate: validateCorrelationResponse,
    reconcileIncoming: reconcileCorrelationResponse,
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
  const reconciledFx = useMemo(() => (
    reconcileFxVolatility(fxReference, data.fxvlSnapshot)
  ), [data.fxvlSnapshot, fxReference]);
  const storedFxRef = useRef(null);
  useEffect(() => {
    if (!reconciledFx) return;
    // Restoring omitted history builds a new object each render. Storing an
    // object with the same content again would trigger the next render, and so
    // on without end; store a reading only when its content has changed.
    const content = JSON.stringify(reconciledFx);
    if (storedFxRef.current === content) return;
    storedFxRef.current = content;
    setFxReference(reconciledFx);
    writeReferenceSnapshot({
      ...FX_REFERENCE_IDENTITY,
      observedAt: reconciledFx.asOf,
      data: retainFxVolatility(reconciledFx),
    });
  }, [reconciledFx]);
  const fxvlSnapshot = resource.hydratedFromStorage || resource.error
    || ['persisted-reference', 'refresh-delayed', 'delayed-reference'].includes(resource.availability)
    ? retainFxVolatility(reconciledFx) : reconciledFx;
  return {
    ...data,
    fxvlSnapshot,
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
