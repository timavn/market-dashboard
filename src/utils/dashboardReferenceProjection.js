import { isExplicitlySafeResearchComparison } from "./researchComparisonContract";

const appendUniqueWarning = (warnings, warning) => (
  [...new Set([...(Array.isArray(warnings) ? warnings : []), warning].filter(Boolean))]
);

const getReferenceDataQuality = (snapshot) => (
  snapshot?.dataQuality || snapshot?.meta?.dataQuality || null
);

const prepareReferenceComparisonSnapshot = (snapshot, {
  requireAvailable = false,
  staleWarning,
} = {}) => {
  if (!snapshot || typeof snapshot !== 'object') {
    return {
      available: false,
      comparisonAvailable: false,
      dataQuality: { status: 'error', warnings: ['Reference response was unavailable.'] },
    };
  }

  const cacheIsStale = snapshot?._cache?.stale === true;
  const quality = getReferenceDataQuality(snapshot);
  const qualityStatus = quality?.status;
  const available = requireAvailable ? snapshot?.available === true : snapshot?.available !== false;
  const comparisonAvailable = available
    && !cacheIsStale
    && qualityStatus === 'ok'
    && isExplicitlySafeResearchComparison(snapshot);
  const prepared = {
    ...snapshot,
    _cache: snapshot?._cache,
    comparisonAvailable,
  };

  if (cacheIsStale) {
    prepared.dataQuality = {
      ...(quality || {}),
      status: qualityStatus && qualityStatus !== 'ok' ? qualityStatus : 'warning',
      warnings: appendUniqueWarning(quality?.warnings, staleWarning),
    };
  }

  return prepared;
};

const markReferenceRefreshFailed = (current, {
  warning,
  error,
  emptyState,
} = {}) => {
  const previous = current && typeof current === 'object' ? current : emptyState;
  const quality = getReferenceDataQuality(previous);
  return {
    ...(previous || {}),
    _cache: previous?._cache,
    available: false,
    comparisonAvailable: false,
    dataQuality: {
      ...(quality || {}),
      status: 'error',
      warnings: appendUniqueWarning(quality?.warnings, warning),
    },
    refreshError: error || warning,
  };
};

export { prepareReferenceComparisonSnapshot, markReferenceRefreshFailed };
