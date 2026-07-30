function cacheFailure(cacheResult, {
  errorCode = 'AUTHORITATIVE_CACHE_STALE',
  source = 'authoritative research source',
} = {}) {
  if (cacheResult?.status !== 'stale') return null;
  const error = new Error(
    `${source} refresh failed; a stale cached value cannot be used for active comparison.`,
  );
  error.code = errorCode;
  error.cause = cacheResult.error;
  return error;
}

function requireAuthoritativeCacheValue(cacheResult, options = {}) {
  const error = cacheFailure(cacheResult, options);
  if (error) throw error;
  return cacheResult?.value;
}

function failClosedHealthFromCache(cacheResult, {
  errorCode = 'GMAIL_HEARTBEAT_CACHE_STALE',
  source = 'scheduled Gmail ingestion health',
} = {}) {
  const error = cacheFailure(cacheResult, { errorCode, source });
  if (!error) return cacheResult?.value;
  const prior = cacheResult?.value && typeof cacheResult.value === 'object'
    ? cacheResult.value
    : {};
  return {
    ...prior,
    status: 'unhealthy',
    healthy: false,
    verified: false,
    errorCode,
    reason: error.message,
    source: prior.source || 'service-heartbeat-table',
    cacheStatus: 'stale',
  };
}

module.exports = {
  cacheFailure,
  failClosedHealthFromCache,
  requireAuthoritativeCacheValue,
};
