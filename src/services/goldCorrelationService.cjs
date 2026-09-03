const {
  GOLD_CORRELATION_ROWS,
  GoldCorrelationDataError,
  buildGoldCorrelationSnapshot,
} = require('../utils/goldCorrelations.cjs');

const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000;

function createGoldCorrelationService({
  fetchBasisHistory,
  fetchComparatorHistory,
  verifyBasisAvailability = null,
  now = () => new Date(),
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  maxStaleDays = 5,
} = {}) {
  if (typeof fetchBasisHistory !== 'function') {
    throw new TypeError('fetchBasisHistory is required');
  }
  if (typeof fetchComparatorHistory !== 'function') {
    throw new TypeError('fetchComparatorHistory is required');
  }

  let cache = null;
  let inFlight = null;

  async function requireBasisAvailability() {
    if (typeof verifyBasisAvailability !== 'function') return;
    let available;
    try {
      available = await verifyBasisAvailability();
    } catch (error) {
      throw new GoldCorrelationDataError(
        'IBKR is temporarily unresponsive; the XAUUSD correlation basis could not be reverified.',
        'GOLD_CORRELATION_BASIS_UNRESPONSIVE',
      );
    }
    const state = available === true
      || available?.connected === true
      || String(available?.status || '').toLowerCase() === 'connected'
      ? 'connected'
      : available === false
        || ['disconnected', 'offline', 'not_connected'].includes(String(available?.status || '').toLowerCase())
        ? 'disconnected'
        : 'indeterminate';
    if (state === 'disconnected') {
      cache = null;
      throw new GoldCorrelationDataError(
        'IBKR is disconnected; the XAUUSD correlation basis is unavailable.',
        'GOLD_CORRELATION_BASIS_DISCONNECTED',
      );
    }
    if (state === 'indeterminate') {
      throw new GoldCorrelationDataError(
        'IBKR is temporarily unresponsive; the XAUUSD correlation basis could not be reverified.',
        'GOLD_CORRELATION_BASIS_UNRESPONSIVE',
      );
    }
  }

  async function fetchSnapshot() {
    const requestTime = now();
    const basisHistory = await fetchBasisHistory();
    const comparatorEntries = await Promise.all(GOLD_CORRELATION_ROWS.map(async (definition) => {
      try {
        const history = await fetchComparatorHistory(definition);
        return [definition.key, history, null];
      } catch (error) {
        return [
          definition.key,
          null,
          `Current ${definition.label} history is unavailable: ${String(error?.message || error)}`,
        ];
      }
    }));
    const comparatorHistories = Object.fromEntries(comparatorEntries.map(([key, history]) => [key, history]));
    const comparatorErrors = Object.fromEntries(
      comparatorEntries.filter(([, , error]) => error).map(([key, , error]) => [key, error]),
    );
    const snapshot = buildGoldCorrelationSnapshot({
      basisHistory,
      comparatorHistories,
      comparatorErrors,
    }, {
      now: requestTime,
      maxStaleDays,
    });
    if (snapshot.status === 'available' || snapshot.status === 'partial') {
      cache = { snapshot, storedAt: requestTime.getTime() };
    } else {
      cache = null;
    }
    return snapshot;
  }

  async function getSnapshot() {
    await requireBasisAvailability();
    const requestTime = now();
    if (cache && requestTime.getTime() - cache.storedAt < cacheTtlMs) {
      return cache.snapshot;
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
  createGoldCorrelationService,
};
