import { useCallback, useEffect, useMemo, useState } from 'react';
import { getMinTimestamp } from '../utils/timeUtils';

export const VOLATILITY_POLL_INTERVAL_MS = 60 * 1000;

export const VOLATILITY_SERIES = Object.freeze([
  Object.freeze({ name: 'VIX', symbol: 'VIX', rowStyle: 'green' }),
  Object.freeze({ name: 'VVIX', symbol: 'VVIX', rowStyle: 'green' }),
  Object.freeze({ name: 'RVX', symbol: 'RVX', rowStyle: 'yellow' }),
  Object.freeze({ name: 'NazVol', symbol: 'VXN', rowStyle: 'yellow' }),
  Object.freeze({ name: 'GVZ', symbol: 'GVZ', rowStyle: 'blue' }),
  Object.freeze({ name: 'OVX', symbol: 'OVX', rowStyle: 'blue' }),
  Object.freeze({ name: 'MOVE', symbol: 'MOVE', rowStyle: 'blue' }),
]);

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
    const historical = row?.availability === 'historical'
      && row?.freshness === 'historical'
      && row?.quoteMode === 'end-of-day';
    const provider = row?.sourceLabel || row?.source || 'Unknown provider';
    const quoteMode = row?.quoteMode || 'provider value';

    return {
      id: name,
      label: `${symbol} — ${provider}`,
      updatedAt: updatedAt || null,
      status: historical
        ? 'historical'
        : available
        ? (row?.quoteMode === 'delayed' ? 'delayed' : 'current')
        : row?.freshness === 'stale'
          ? 'stale'
          : 'defective',
      detail: updatedAt
        ? `${quoteMode} · as of ${new Date(updatedAt).toLocaleString()}`
        : `${quoteMode} · unavailable`,
    };
  });

  return { lastUpdated, sources };
}

const unavailableMessage = (error) => (
  error?.message || 'Current volatility data is unavailable'
);

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
  const [snapshot, setSnapshot] = useState(null);
  const [loading, setLoading] = useState(Boolean(enabled));
  const [error, setError] = useState(null);
  const [retryGeneration, setRetryGeneration] = useState(0);

  const retry = useCallback(() => {
    setRetryGeneration((value) => value + 1);
  }, []);

  useEffect(() => {
    if (!enabled) {
      setSnapshot(null);
      setLoading(false);
      setError(null);
      return undefined;
    }

    let cancelled = false;
    let timer = null;

    const scheduleNext = () => {
      timer = setTimeout(fetchSnapshot, pollIntervalMs);
    };

    const fetchSnapshot = async () => {
      if (cancelled) return;
      setLoading(true);
      setError(null);

      try {
        const request = fetcher || (typeof fetch === 'function' ? fetch : null);
        if (typeof request !== 'function') {
          throw new Error('Volatility snapshot fetch is unavailable');
        }
        const response = await request(`${backendUrl}/api/volatility-snapshot`);
        const nextSnapshot = await response.json();
        if (!response.ok && nextSnapshot?.status !== 'unavailable') {
          throw new Error(
            nextSnapshot?.error || `Volatility snapshot request failed (${response.status})`,
          );
        }
        if (cancelled) return;
        setSnapshot(nextSnapshot && typeof nextSnapshot === 'object' ? nextSnapshot : null);
        setError(null);
      } catch (requestError) {
        if (cancelled) return;
        // Never retain the previous snapshot after a failed refresh.
        setSnapshot(null);
        setError(unavailableMessage(requestError));
      } finally {
        if (!cancelled) {
          setLoading(false);
          scheduleNext();
        }
      }
    };

    fetchSnapshot();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [backendUrl, enabled, fetcher, pollIntervalMs, retryGeneration]);

  const metadata = useMemo(
    () => getVolatilitySnapshotMetadata(snapshot),
    [snapshot],
  );

  return {
    snapshot,
    loading,
    error,
    retry,
    lastUpdated: metadata.lastUpdated,
    sources: metadata.sources,
  };
}

export default useVolatilitySnapshot;
