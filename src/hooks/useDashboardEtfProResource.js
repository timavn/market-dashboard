import { useCallback } from 'react';
import { useDashboardResource } from './useDashboardResource';
import { MarketDataService } from '../services/api/marketDataService';
import { REFERENCE_DATA_POLL_MS } from '../constants/dashboardResourceTiming';

export function useDashboardEtfProResource({ surfaceActive, showEtfPro }) {
  const loadEtfProSnapshot = useCallback(
    () => MarketDataService.getHedgeyeEtfPro(),
    [],
  );

  const etfProResource = useDashboardResource('etf-pro', {}, {
    fetcher: loadEtfProSnapshot,
    validate: (value) => (
      value
      && typeof value === 'object'
      && Array.isArray(value.rows)
      && value.mock !== true
      && value.seeded !== true
        ? value
        : null
    ),
    getObservedAt: (value) => value?.meta?.snapshotDate || value?.generatedAt,
    pollIntervalMs: REFERENCE_DATA_POLL_MS,
    active: surfaceActive && showEtfPro,
    refreshOnActivate: false,
  });

  return etfProResource;
}

export default useDashboardEtfProResource;
