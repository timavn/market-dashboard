import { useCallback } from 'react';
import { MarketDataService } from '../services/api/marketDataService';
import { useDashboardResource } from './useDashboardResource';

export const MARKET_STRUCTURE_REFRESH_MS = 15 * 60 * 1000;
export const MARKET_STRUCTURE_REFERENCE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
export const MARKET_STRUCTURE_REFERENCE_STORAGE_KEY =
  'market-dashboard.reference.market-situation.v2';

export const validateMarketStructureReport = (payload, { expectedDate = null } = {}) => {
  if (!payload || typeof payload !== 'object' || payload.snapshotType !== 'market-structure') {
    throw Object.assign(new Error('No Market Structure research snapshot was returned.'), {
      code: 'MARKET_STRUCTURE_REPORT_MISSING',
    });
  }

  if (expectedDate && payload.date !== expectedDate) {
    throw Object.assign(
      new Error(`The Market Structure report does not match ${expectedDate}.`),
      { code: 'MARKET_STRUCTURE_REPORT_DATE_MISMATCH' },
    );
  }

  if (['market-structure-v2', 'market-structure-v3', 'market-structure-v4'].includes(payload.schemaVersion)) {
    const charts = Array.isArray(payload.data?.charts) ? payload.data.charts : [];
    const blocks = Array.isArray(payload.data?.blocks) ? payload.data.blocks : [];
    const hasNarrative = blocks.some((block) => (
      ['heading', 'callout', 'paragraph', 'byline'].includes(block?.type)
      && String(block?.text || '').trim()
    ));
    if (payload.contentComplete !== true || charts.length === 0 || !hasNarrative) {
      throw Object.assign(new Error('The Market Structure report is incomplete.'), {
        code: 'MARKET_STRUCTURE_REPORT_INCOMPLETE',
      });
    }
  }
  return payload;
};

export function useMarketStructureReport({ active = true, date = null } = {}) {
  const requestedDate = date ? String(date).trim() : null;

  const fetchReport = useCallback(async () => {
    const payload = await MarketDataService.getHedgeyeSnapshot(
      'market-structure',
      requestedDate,
    );
    if (!payload) {
      throw Object.assign(
        new Error(requestedDate
          ? `No Market Structure report was published for ${requestedDate}.`
          : 'No Market Structure report has been published.'),
        { code: 'MARKET_STRUCTURE_REPORT_MISSING' },
      );
    }
    return payload;
  }, [requestedDate]);

  const validateReport = useCallback(
    (payload) => validateMarketStructureReport(payload, { expectedDate: requestedDate }),
    [requestedDate],
  );

  const resource = useDashboardResource('market-situation', { requestedDate }, {
    fetcher: fetchReport,
    validate: validateReport,
    getObservedAt: (payload) => payload.date || payload.publishedAt || null,
    pollIntervalMs: MARKET_STRUCTURE_REFRESH_MS,
    active,
    refreshOnActivate: false,
    persistReferenceSnapshot: requestedDate
      ? null
      : undefined,
  });

  return {
    ...resource,
    loading: resource.initialLoading && !resource.data,
    errorMessage: resource.error?.message || null,
  };
}

export default useMarketStructureReport;
