import { useCallback } from 'react';
import { useSessionResource } from '../../../hooks/useSessionResource';
import predictionMarketsIngestService from '../../../services/api/predictionMarketsIngestService';
import { normalizeCpiBenchmarkPanelData, CPI_BENCHMARK_MAX_AGE_MS } from './cpiForecastContext';

const CPI_BENCHMARK_POLL_MS = 15 * 60_000;

export function useCpiBenchmarkReference({ active, normalizedMarketId, forecastComparison }) {
  const cpiBenchmarkMonth = normalizedMarketId === 'cpi'
    ? forecastComparison?.reportMonth || null
    : null;
  const cpiBenchmarkReleaseAt = normalizedMarketId === 'cpi'
    ? forecastComparison?.releaseAt || null
    : null;
  const loadCpiBenchmarkPanel = useCallback(() => {
    if (!cpiBenchmarkMonth) {
      throw new Error('An exact CPI report month is required for benchmark data.');
    }
    return predictionMarketsIngestService.getCpiBenchmarks(cpiBenchmarkMonth);
  }, [cpiBenchmarkMonth]);
  const validateCpiBenchmarkPanel = useCallback((payload) => {
    const normalized = normalizeCpiBenchmarkPanelData(
      payload,
      cpiBenchmarkMonth,
      cpiBenchmarkReleaseAt,
      Date.now(),
    );
    if (normalized) return normalized;
    throw new Error('CPI benchmark data did not match the current release or was not freshly checked.');
  }, [cpiBenchmarkMonth, cpiBenchmarkReleaseAt]);
  const cpiBenchmarkObservedAt = useCallback((value) => value?.fetchedAt || null, []);
  const cpiBenchmarkResource = useSessionResource({
    resourceKey: 'cpi-release-benchmarks',
    scopeKey: `${cpiBenchmarkMonth || 'none'}|${cpiBenchmarkReleaseAt || 'none'}`,
    kind: 'reference',
    fetcher: loadCpiBenchmarkPanel,
    validate: validateCpiBenchmarkPanel,
    getObservedAt: cpiBenchmarkObservedAt,
    maxAgeMs: CPI_BENCHMARK_MAX_AGE_MS,
    pollIntervalMs: CPI_BENCHMARK_POLL_MS,
    enabled: Boolean(cpiBenchmarkMonth && cpiBenchmarkReleaseAt),
    active: active && normalizedMarketId === 'cpi',
    refreshOnActivate: true,
    invalidateOnScopeChange: true,
    retainOnRefreshFailure: false,
    displayRole: 'reference',
    expiredCode: 'CPI_BENCHMARKS_EXPIRED',
    expiredMessage: 'The exact-month CPI benchmark check expired.',
  });

  return cpiBenchmarkResource;
}

export default useCpiBenchmarkReference;
