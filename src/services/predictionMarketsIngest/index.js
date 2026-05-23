const mockData = require('./mock/aggregatedEvents.mock.json');
const { enrichEvent } = require('./enrich/enrichEvent');
const { isFinancialMacroEvent } = require('./filter/isFinancialMacroEvent');
const { assignComparisonGroup } = require('./group/assignComparisonGroup');
const { mergeCrossVenueEvents } = require('./merge/mergeCrossVenueEvents');
const { sortAggregatedEvents } = require('./sortEvents');
const {
  getCachedEvents,
  setCachedEvents,
  getProviderStatus,
  setProviderStatus,
} = require('./cache');

const { fetchKalshiEvents } = require('./providers/kalshiProvider');
const { fetchIBKREvents, checkGatewayHealth } = require('./providers/ibkrProvider');
const { fetchForecastExEvents } = require('./providers/forecastExProvider');
const { fetchCMEEvents } = require('./providers/cmeProvider');
const { fetchReferenceMarketData } = require('./providers/referenceProvider');

function dedupeByVenueId(events) {
  const map = new Map();
  for (const e of events) {
    const key = `${e.venue}#${e.api_raw_id}`;
    const existing = map.get(key);
    if (!existing || (e.updated_at || '') > (existing.updated_at || '')) {
      map.set(key, e);
    }
  }
  return [...map.values()];
}

function logProviderError(provider, reason) {
  if (reason.status === 'rejected') {
    console.error(`[PM Ingest] Provider ${provider} failed:`, reason.reason?.message || reason.reason);
  }
}

/**
 * @param {object} [options]
 * @param {boolean} [options.refreshKalshi]
 * @param {boolean} [options.refreshIbkr]
 * @param {boolean} [options.useMock]
 * @param {number|null} [options.fairProbability]
 */
async function getAggregatedFinancialPredictionEvents(options = {}) {
  const useMock = options.useMock || process.env.PM_USE_MOCK === 'true';
  if (useMock) {
    let events = mockData.events.map((e) => enrichEvent(e));
    events = assignComparisonGroup(events);
    events = mergeCrossVenueEvents(events);
    return {
      events: sortAggregatedEvents(events),
      reference: mockData.reference || {},
      providers: mockData.providers,
      fetched_at: new Date().toISOString(),
    };
  }

  const ibkrEnabled =
    options.ibkrEnabled !== false && process.env.IBKR_INGEST_ENABLED !== 'false';
  const refreshKalshi = options.refreshKalshi === true;
  let refreshIbkr = options.refreshIbkr === true && ibkrEnabled;

  if (!refreshIbkr && refreshKalshi && ibkrEnabled) {
    const health = await checkGatewayHealth();
    if (health.ok) refreshIbkr = true;
  }

  const cached = (await getCachedEvents()) || [];
  const IBKR_VENUES = new Set(['ForecastEx', 'CME', 'IBKR']);

  const [kalshiResult, ibkrResult, referenceResult] = await Promise.allSettled([
    refreshKalshi ? fetchKalshiEvents(options) : Promise.resolve(null),
    refreshIbkr ? fetchIBKREvents(options) : Promise.resolve(null),
    fetchReferenceMarketData(options),
  ]);

  if (kalshiResult.status === 'rejected') logProviderError('kalshi', kalshiResult);
  if (ibkrResult.status === 'rejected') logProviderError('ibkr', ibkrResult);
  if (referenceResult.status === 'rejected') logProviderError('reference', referenceResult);

  const kalshiEvents =
    kalshiResult.status === 'fulfilled' && kalshiResult.value ? kalshiResult.value : [];
  const ibkrEvents =
    ibkrResult.status === 'fulfilled' && ibkrResult.value ? ibkrResult.value : [];
  const reference =
    referenceResult.status === 'fulfilled' ? referenceResult.value : {};

  let merged;
  if (kalshiEvents.length || ibkrEvents.length) {
    const keepFromCache = cached.filter((e) => {
      if (kalshiEvents.length && e.venue === 'Kalshi') return false;
      if (ibkrEvents.length && IBKR_VENUES.has(e.venue)) return false;
      return true;
    });
    merged = [...keepFromCache, ...kalshiEvents, ...ibkrEvents];
  } else {
    merged = cached.length ? cached : [];
  }

  merged = merged.filter(isFinancialMacroEvent);
  merged = dedupeByVenueId(merged);
  merged = assignComparisonGroup(merged);
  merged = mergeCrossVenueEvents(merged);
  merged = merged.map((e) =>
    enrichEvent(e, {
      fairProbability: options.fairProbability,
      staleMs: ibkrEnabled ? undefined : Number(process.env.PM_EVENTS_CACHE_TTL_SEC) * 1000,
    })
  );
  merged = sortAggregatedEvents(merged);

  if (kalshiEvents.length || ibkrEvents.length) {
    await setCachedEvents(merged, { providers: getProviderStatus() });
  }

  const providers = getProviderStatus();
  if (!kalshiEvents.length && !process.env.KALSHI_API_KEY_ID) {
    providers.kalshi = {
      status: 'error',
      message: 'Kalshi credentials not configured — showing cache/mock',
      last_success_at: providers.kalshi?.last_success_at,
    };
  }

  return {
    events: merged,
    reference,
    providers,
    fetched_at: new Date().toISOString(),
  };
}

module.exports = {
  getAggregatedFinancialPredictionEvents,
  fetchKalshiEvents,
  fetchIBKREvents,
  fetchForecastExEvents,
  fetchCMEEvents,
  fetchReferenceMarketData,
  normalizeEvent: require('./normalize/normalizeEvent').normalizeEvent,
  isFinancialMacroEvent,
  assignComparisonGroup,
  mergeCrossVenueEvents,
  enrichEvent,
};
