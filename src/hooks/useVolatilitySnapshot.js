import { useCallback, useEffect, useMemo, useState } from 'react';
import { getMinTimestamp } from '../utils/timeUtils';
import VOLATILITY_FRESHNESS from '../constants/volatilityFreshness.json';
import {
  isCurrentVolatilityRow,
  isDisplayableVolatilityRow,
  isHistoricalVolatilityRow,
  isRefreshDelayedVolatilityRow,
  retainVolatilitySnapshot,
  sanitizeVolatilitySnapshot,
} from '../utils/volatilitySnapshotRows';
import { useDashboardResource } from './useDashboardResource';

export const VOLATILITY_POLL_INTERVAL_MS = 60 * 1000;
export const VOLATILITY_LIVE_MAX_AGE_MS = Number(VOLATILITY_FRESHNESS.maxAgeMs);
export const VOLATILITY_REFERENCE_STORAGE_KEY = 'market-dashboard.reference.volatility.v1';

export const VOLATILITY_SERIES = Object.freeze([
  Object.freeze({ name: 'VIX', symbol: 'VIX', rowStyle: 'green' }),
  Object.freeze({ name: 'VVIX', symbol: 'VVIX', rowStyle: 'green' }),
  Object.freeze({ name: 'RVX', symbol: 'RVX', rowStyle: 'yellow' }),
  Object.freeze({ name: 'NazVol', symbol: 'VXN', rowStyle: 'yellow' }),
  Object.freeze({ name: 'VXEEM', symbol: 'VXEEM', rowStyle: 'yellow' }),
  Object.freeze({ name: 'GVZ', symbol: 'GVZ', rowStyle: 'blue' }),
  Object.freeze({ name: 'OVX', symbol: 'OVX', rowStyle: 'blue' }),
  Object.freeze({ name: 'BITVX', symbol: 'BITVX', rowStyle: 'blue' }),
  Object.freeze({ name: 'MOVE', symbol: 'MOVE', rowStyle: 'blue' }),
]);

export const EMPTY_VOLATILITY_SNAPSHOT_STATE = Object.freeze({
  snapshot: null,
  lastUpdated: null,
  sources: Object.freeze([]),
});

const timestampForRow = (row) => row?.asOf || row?.timestamp || row?.lastUpdated || null;

const formatObservation = (value) => Number.isFinite(Date.parse(String(value || '')))
  ? new Intl.DateTimeFormat('en-US', {
  month: 'short', day: 'numeric', year: 'numeric',
  ...(/^\d{4}-\d{2}-\d{2}$/.test(String(value))
    ? { timeZone: 'UTC' }
    : { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short' }),
  }).format(new Date(value)) : 'time unavailable';

export function getVolatilitySnapshotMetadata(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    return {
      lastUpdated: null,
      sources: [],
    };
  }

  const topLevelTimestamp = snapshot.lastUpdated || snapshot.timestamp || snapshot.asOf || null;
  const seriesTimestamps = VOLATILITY_SERIES
    .map(({ name }) => timestampForRow(snapshot[name]))
    .filter(Boolean);
  const lastUpdated = topLevelTimestamp || getMinTimestamp(seriesTimestamps) || null;

  const sources = VOLATILITY_SERIES.map(({ name, symbol }) => {
    const row = snapshot[name];
    const updatedAt = timestampForRow(row) || topLevelTimestamp;
    const available = isCurrentVolatilityRow(row);
    const refreshDelayed = isRefreshDelayedVolatilityRow(row);
    const historical = isHistoricalVolatilityRow(name, row);
    const provider = row?.sourceLabel || row?.source || 'Unknown provider';
    const quoteMode = row?.quoteMode || 'provider value';

    return {
      id: name,
      label: `${symbol} — ${provider}`,
      updatedAt: updatedAt || null,
      status: refreshDelayed
        ? 'stale'
        : historical
        ? 'historical'
        : available
        ? (row?.quoteMode === 'delayed' ? 'delayed' : 'current')
        : row?.freshness === 'stale'
          ? 'stale'
          : 'defective',
      stateLabel: refreshDelayed ? 'Refresh delayed' : undefined,
      detail: refreshDelayed
        ? `${quoteMode} · refresh delayed · last verified ${formatObservation(row.asOf)}`
        : updatedAt
        ? `${quoteMode} · as of ${formatObservation(updatedAt)}`
        : `${quoteMode} · unavailable`,
    };
  });

  return { lastUpdated, sources };
}

const unavailableMessage = (error) => (
  error?.message || 'Current volatility data is unavailable'
);

const providerUnavailableError = (message = 'No verified volatility rows are available; retrying automatically.') => (
  Object.assign(new Error(message), {
    code: 'VOLATILITY_PROVIDER_UNAVAILABLE',
    retryable: true,
  })
);

const hasDisplayableRows = (snapshot) => VOLATILITY_SERIES.some(({ name }) => {
  const row = snapshot?.[name];
  return isDisplayableVolatilityRow(name, row);
});

const getLiveVolatilityObservedAt = (snapshot) => {
  const currentRows = VOLATILITY_SERIES
    .filter(({ name }) => isDisplayableVolatilityRow(name, snapshot?.[name]))
    .map(({ name }) => snapshot[name])
    .map(timestampForRow)
    .map((value) => Date.parse(String(value || '')))
    .filter(Number.isFinite);
  return currentRows.length ? new Date(Math.max(...currentRows)).toISOString() : null;
};

/**
 * Owns the single polling loop for a volatility snapshot consumer.
 * Passing `enabled: false` is the controlled-component escape hatch and performs no requests.
 */
export function useVolatilitySnapshot({
  enabled = true,
  fetcher,
  backendUrl = process.env.REACT_APP_BACKEND_URL || 'http://localhost:3001',
  pollIntervalMs = VOLATILITY_POLL_INTERVAL_MS,
} = {}) {
  const loadSnapshot = useCallback(async () => {
    const request = fetcher || (typeof fetch === 'function' ? fetch : null);
    if (typeof request !== 'function') {
      throw new Error('Volatility snapshot fetch is unavailable');
    }
    const response = await request(`${backendUrl}/api/volatility-snapshot`);
    const rawSnapshot = await response.json();
    if (!response.ok) {
      throw providerUnavailableError(
        rawSnapshot?.error
          || 'Volatility providers are unavailable; retrying automatically.',
      );
    }
    const nextSnapshot = sanitizeVolatilitySnapshot(rawSnapshot);
    if (!hasDisplayableRows(nextSnapshot)) {
      throw providerUnavailableError();
    }
    return nextSnapshot;
  }, [backendUrl, fetcher]);
  const validateSnapshot = useCallback((nextSnapshot) => (
    nextSnapshot && typeof nextSnapshot === 'object'
      ? sanitizeVolatilitySnapshot(nextSnapshot)
      : null
  ), []);
  const resource = useDashboardResource('volatility', { backendUrl }, {
    fetcher: loadSnapshot,
    validate: validateSnapshot,
    getObservedAt: getLiveVolatilityObservedAt,
    maxAgeMs: VOLATILITY_LIVE_MAX_AGE_MS,
    pollIntervalMs,
    enabled,
    active: enabled,
    retainOnRefreshFailure: true,
    retainAfterExpiry: true,
    core: true,
    expiredCode: 'VOLATILITY_SNAPSHOT_EXPIRED',
    expiredMessage: 'The last verified volatility snapshot expired.',
  });

  const [rowCheckedAt, setRowCheckedAt] = useState(Date.now);
  const snapshot = useMemo(() => {
    if (!enabled) return null;
    const nowMs = Math.max(rowCheckedAt, Date.now());
    return resource.error || resource.hydratedFromStorage
      || ['refresh-delayed', 'delayed-reference', 'persisted-reference'].includes(resource.availability)
      ? retainVolatilitySnapshot(resource.data, nowMs)
      : sanitizeVolatilitySnapshot(resource.data, nowMs);
  }, [enabled, resource.data, resource.error, resource.hydratedFromStorage, resource.availability, rowCheckedAt]);
  useEffect(() => {
    if (!snapshot || snapshot.marketSession === 'closed') return undefined;
    const expirations = VOLATILITY_SERIES
      .map(({ name }) => snapshot[name])
      .filter(isCurrentVolatilityRow)
      .map((row) => Date.parse(row.asOf) + VOLATILITY_LIVE_MAX_AGE_MS + 1)
      .filter(Number.isFinite);
    if (expirations.length === 0) return undefined;
    const timer = setTimeout(
      () => setRowCheckedAt(Date.now()),
      Math.max(0, Math.min(...expirations) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [snapshot]);
  const loading = enabled ? resource.initialLoading && !snapshot : false;
  const refreshing = enabled ? resource.refreshing : false;
  const error = enabled && resource.error ? unavailableMessage(resource.error) : null;
  const refreshResource = resource.refresh;
  const retry = useCallback(() => (
    enabled ? refreshResource() : Promise.resolve(null)
  ), [enabled, refreshResource]);

  const metadata = useMemo(
    () => getVolatilitySnapshotMetadata(snapshot),
    [snapshot],
  );

  return {
    snapshot,
    loading,
    refreshing,
    error,
    retry,
    lastUpdated: metadata.lastUpdated,
    sources: metadata.sources,
    availability: resource.availability,
    hydratedFromStorage: resource.hydratedFromStorage,
    persistedAt: resource.persistedAt,
  };
}

export default useVolatilitySnapshot;
