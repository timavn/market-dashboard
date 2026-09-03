import { useCallback, useEffect, useMemo, useState } from 'react';
import { getMinTimestamp } from '../utils/timeUtils';
import VOLATILITY_FRESHNESS from '../constants/volatilityFreshness.json';
import {
  isRefreshDelayedVolatilityRow,
  sanitizeExpiredVolatilityReferences,
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
  Object.freeze({ name: 'GVZ', symbol: 'GVZ', rowStyle: 'blue' }),
  Object.freeze({ name: 'OVX', symbol: 'OVX', rowStyle: 'blue' }),
  Object.freeze({ name: 'BITVX', symbol: 'BITVX', rowStyle: 'blue' }),
  Object.freeze({ name: 'MOVE', symbol: 'MOVE', rowStyle: 'blue' }),
]);

const CBOE_VOLATILITY_SERIES = VOLATILITY_SERIES.filter(({ name }) => name !== 'MOVE');

export const EMPTY_VOLATILITY_SNAPSHOT_STATE = Object.freeze({
  snapshot: null,
  lastUpdated: null,
  sources: Object.freeze([]),
});

const timestampForRow = (row) => row?.lastUpdated || row?.timestamp || row?.asOf || null;

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
    const available = row?.availability === 'available' && row?.freshness === 'current';
    const refreshDelayed = isRefreshDelayedVolatilityRow(row);
    const historical = row?.availability === 'historical'
      && row?.freshness === 'historical'
      && row?.quoteMode === 'end-of-day';
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
        ? `${quoteMode} · refresh delayed · last verified ${new Date(row.lastVerifiedAt).toLocaleString()}`
        : updatedAt
        ? `${quoteMode} · as of ${new Date(updatedAt).toLocaleString()}`
        : `${quoteMode} · unavailable`,
    };
  });

  return { lastUpdated, sources };
}

const unavailableMessage = (error) => (
  error?.message || 'Current volatility data is unavailable'
);

const providerUnavailableError = (message = 'No verified current volatility rows are available; retrying automatically.') => (
  Object.assign(new Error(message), {
    code: 'VOLATILITY_PROVIDER_UNAVAILABLE',
    retryable: true,
  })
);

const hasDisplayableCboeRows = (snapshot) => CBOE_VOLATILITY_SERIES.some(({ name }) => {
  const row = snapshot?.[name];
  return (
    row?.availability === 'available' && row?.freshness === 'current'
  ) || isRefreshDelayedVolatilityRow(row);
});

const getLiveVolatilityObservedAt = (snapshot) => {
  const topLevel = snapshot?.lastUpdated || snapshot?.timestamp || snapshot?.asOf || null;
  const currentRows = VOLATILITY_SERIES
    .map(({ name }) => snapshot?.[name])
    .filter((row) => row?.availability === 'available' && row?.freshness === 'current')
    .map(timestampForRow)
    .map((value) => Date.parse(String(value || '')))
    .filter(Number.isFinite);
  const retainedRows = VOLATILITY_SERIES
    .map(({ name }) => snapshot?.[name])
    .filter((row) => isRefreshDelayedVolatilityRow(row))
    .map((row) => Date.parse(String(row.lastVerifiedAt || '')))
    .filter(Number.isFinite);

  // After the cash session closes, the backend intentionally marks the most
  // recent completed trading session as current. Use the fetch timestamp as
  // the client freshness heartbeat in that state, while preserving each
  // provider row's asOf timestamp for display/provenance. This keeps a
  // verified close visible after hours without allowing a prior-day or
  // provider-unavailable snapshot through.
  if (
    snapshot?.marketSession === 'closed'
    && currentRows.length > 0
    && snapshot?.generatedAt
  ) {
    return snapshot.generatedAt;
  }

  if (currentRows.length === 0 && retainedRows.length > 0) {
    return new Date(Math.min(...retainedRows)).toISOString();
  }
  if (topLevel) return topLevel;
  return currentRows.length ? new Date(Math.min(...currentRows)).toISOString() : null;
};

export function retainHistoricalVolatilityRows(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const retained = {};
  VOLATILITY_SERIES.forEach(({ name }) => {
    const row = snapshot[name];
    const historical = row?.availability === 'historical'
      && row?.freshness === 'historical'
      && row?.quoteMode === 'end-of-day'
      && timestampForRow(row);
    if (historical) retained[name] = row;
  });
  if (Object.keys(retained).length === 0) return null;
  const { lastUpdated } = getVolatilitySnapshotMetadata(retained);
  return {
    status: 'reference-only',
    lastUpdated: lastUpdated instanceof Date ? lastUpdated.toISOString() : lastUpdated,
    ...retained,
  };
}

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
  const [historicalReference, setHistoricalReference] = useState(null);
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
    const nextSnapshot = sanitizeExpiredVolatilityReferences(rawSnapshot);
    if (!hasDisplayableCboeRows(nextSnapshot)) {
      throw providerUnavailableError();
    }
    return nextSnapshot;
  }, [backendUrl, fetcher]);
  const validateSnapshot = useCallback((nextSnapshot) => (
    nextSnapshot && typeof nextSnapshot === 'object'
      ? sanitizeExpiredVolatilityReferences(nextSnapshot)
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
    // The volatility map is a reference card, not an order/sizing source.
    // Keep its last verified, still-fresh rows visible if polling fails.
    core: true,
    expiredCode: 'VOLATILITY_SNAPSHOT_EXPIRED',
    expiredMessage: 'The last verified volatility snapshot expired.',
  });

  useEffect(() => {
    if (!enabled || !resource.data) return;
    const retained = retainHistoricalVolatilityRows(resource.data);
    if (retained) setHistoricalReference(retained);
  }, [enabled, resource.data]);

  const snapshot = enabled ? resource.data || historicalReference : null;
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
