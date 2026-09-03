const {
  OPTIONAL_SYMBOLS,
  REQUIRED_SYMBOLS,
  UsdCorrelationDataError,
  buildUsdCorrelationSnapshot,
} = require('../utils/usdCorrelations.cjs');

const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000;

function createUsdCorrelationService({
  fetchHistory,
  fetchFxvlSnapshot = null,
  now = () => new Date(),
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  maxStaleDays = 5,
  logger = console,
} = {}) {
  if (typeof fetchHistory !== 'function') {
    throw new TypeError('fetchHistory is required');
  }

  let cache = null;
  let inFlight = null;

  async function loadFxvlSnapshot() {
    if (typeof fetchFxvlSnapshot !== 'function') return null;
    try {
      const snapshot = await fetchFxvlSnapshot();
      return snapshot && typeof snapshot === 'object' ? snapshot : null;
    } catch (error) {
      logger.warn?.(`[usd-correlations] FXVL snapshot unavailable: ${error.message}`);
      return null;
    }
  }

  async function fetchSnapshot() {
    const requestTime = now();
    const [requiredHistoryEntries, optionalHistoryEntries, fxvlSnapshot] = await Promise.all([
      Promise.all(REQUIRED_SYMBOLS.map(async (symbol) => {
        try {
          return [symbol, await fetchHistory(symbol)];
        } catch (error) {
          throw new UsdCorrelationDataError(
            `Failed to fetch current daily history for ${symbol}: ${error.message}`,
            'USD_CORRELATION_PROVIDER_UNAVAILABLE',
          );
        }
      })),
      Promise.all(OPTIONAL_SYMBOLS.map(async (symbol) => {
        try {
          return [symbol, await fetchHistory(symbol)];
        } catch (error) {
          logger.warn?.(`[usd-correlations] optional ${symbol} history unavailable: ${error.message}`);
          return [symbol, null];
        }
      })),
      loadFxvlSnapshot(),
    ]);
    const snapshot = buildUsdCorrelationSnapshot(Object.fromEntries([
      ...requiredHistoryEntries,
      ...optionalHistoryEntries,
    ]), {
      now: requestTime,
      maxStaleDays,
    });
    const withFxvl = {
      ...snapshot,
      fxvlSnapshot: fxvlSnapshot || null,
    };
    cache = { snapshot: withFxvl, storedAt: requestTime.getTime() };
    return withFxvl;
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
