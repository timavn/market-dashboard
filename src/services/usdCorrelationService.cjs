const {
  REQUIRED_SYMBOLS,
  UsdCorrelationDataError,
  buildUsdCorrelationSnapshot,
} = require('../utils/usdCorrelations.cjs');

const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000;

function createUsdCorrelationService({
  fetchHistory,
  now = () => new Date(),
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  maxStaleDays = 5,
} = {}) {
  if (typeof fetchHistory !== 'function') {
    throw new TypeError('fetchHistory is required');
  }

  let cache = null;
  let inFlight = null;

  async function fetchSnapshot() {
    const requestTime = now();
    const historyEntries = await Promise.all(REQUIRED_SYMBOLS.map(async (symbol) => {
      try {
        return [symbol, await fetchHistory(symbol)];
      } catch (error) {
        throw new UsdCorrelationDataError(
          `Failed to fetch current daily history for ${symbol}: ${error.message}`,
          'USD_CORRELATION_PROVIDER_UNAVAILABLE',
        );
      }
    }));
    const snapshot = buildUsdCorrelationSnapshot(Object.fromEntries(historyEntries), {
      now: requestTime,
      maxStaleDays,
    });
    cache = { snapshot, storedAt: requestTime.getTime() };
    return snapshot;
  }

  function getSnapshot() {
    const currentTime = now();
    if (cache && currentTime.getTime() - cache.storedAt < cacheTtlMs) {
      return Promise.resolve(cache.snapshot);
    }
    if (inFlight) return inFlight;

    inFlight = fetchSnapshot().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  function clearCache() {
    cache = null;
  }

  return { clearCache, getSnapshot };
}

module.exports = {
  DEFAULT_CACHE_TTL_MS,
  createUsdCorrelationService,
};
