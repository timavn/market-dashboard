import { useCallback, useEffect, useState } from 'react';
import { useDashboardResource } from '../../../hooks/useDashboardResource';
import { MarketDataService } from '../../../services/api/marketDataService';
import { normalizeGoldCorrelationSnapshot, isGoldCorrelationSnapshotUsable } from './goldCorrelationContext';

const GOLD_CORRELATION_POLL_MS = 60 * 60_000;
const GOLD_CORRELATION_RETRY_POLL_MS = 10_000;

export function useGoldCorrelationReference({ active, normalizedMarketId, chartRange, clockMs }) {
  const loadGoldCorrelations = useCallback(
    () => MarketDataService.getGoldCorrelations(),
    [],
  );
  const [goldCorrelationPollIntervalMs, setGoldCorrelationPollIntervalMs] = useState(
    GOLD_CORRELATION_RETRY_POLL_MS,
  );
  const goldCorrelationResource = useDashboardResource('gold-correlations', {}, {
    fetcher: loadGoldCorrelations,
    validate: (payload) => {
      const normalized = normalizeGoldCorrelationSnapshot(payload || {}, Date.now());
      if (['available', 'partial'].includes(normalized.status)) return normalized;
      throw new Error(normalized.reason || 'Verified Gold correlation data is unavailable.');
    },
    getObservedAt: (value) => value?.basis?.asOf || value?.asOf,
    pollIntervalMs: goldCorrelationPollIntervalMs,
    active: active && normalizedMarketId === 'gold' && chartRange === '1d',
    refreshOnActivate: false,
  });
  const goldCorrelationSnapshot = goldCorrelationResource.data;
  const goldCorrelationState = goldCorrelationSnapshot
    ? goldCorrelationResource.error ? 'refresh-delayed' : goldCorrelationSnapshot.status
    : goldCorrelationResource.initialLoading ? 'loading' : 'unavailable';
  const goldCorrelationReason = goldCorrelationResource.error?.response?.data?.reason
    || goldCorrelationResource.error?.message
    || goldCorrelationSnapshot?.reason
    || null;

  useEffect(() => {
    const verified = ['available', 'partial'].includes(goldCorrelationSnapshot?.status)
      && !goldCorrelationResource.error;
    const nextInterval = verified
      ? GOLD_CORRELATION_POLL_MS
      : GOLD_CORRELATION_RETRY_POLL_MS;
    setGoldCorrelationPollIntervalMs((currentInterval) => (
      currentInterval === nextInterval ? currentInterval : nextInterval
    ));
  }, [goldCorrelationResource.error, goldCorrelationSnapshot?.status]);

  const goldCorrelationUsable = normalizedMarketId === 'gold'
    && isGoldCorrelationSnapshotUsable(goldCorrelationSnapshot, clockMs);

  return {
    snapshot: goldCorrelationSnapshot,
    state: goldCorrelationState,
    reason: goldCorrelationReason,
    resource: goldCorrelationResource,
    usable: goldCorrelationUsable,
  };
}

export default useGoldCorrelationReference;
