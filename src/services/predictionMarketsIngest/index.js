const { enrichEvent } = require('./enrich/enrichEvent');
const { isFinancialMacroEvent } = require('./filter/isFinancialMacroEvent');
const { assignComparisonGroup } = require('./group/assignComparisonGroup');
const { mergeCrossVenueEvents } = require('./merge/mergeCrossVenueEvents');
const { sortAggregatedEvents } = require('./sortEvents');
const {
  persistCatalogEvents,
  getProviderStatus,
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
 * @param {number|null} [options.fairProbability]
 */
async function getAggregatedFinancialPredictionEvents(options = {}) {
  const ibkrEnabled =
    options.ibkrEnabled !== false && process.env.IBKR_INGEST_ENABLED !== 'false';
  const refreshKalshi = options.refreshKalshi === true;
  let refreshIbkr = options.refreshIbkr === true && ibkrEnabled;

  if (!refreshIbkr && refreshKalshi && ibkrEnabled) {
    const health = await checkGatewayHealth();
    if (health.ok) refreshIbkr = true;
  }

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

  // Active trading routes are live-only. A failed provider produces no rows;
  // persisted catalog data is metadata, never a quote fallback.
  let providerEvents = [...kalshiEvents, ...ibkrEvents];

  providerEvents = providerEvents.filter(isFinancialMacroEvent);
  providerEvents = dedupeByVenueId(providerEvents);
  providerEvents = assignComparisonGroup(providerEvents);
  let merged = mergeCrossVenueEvents(providerEvents);
  merged = merged.map((e) =>
    enrichEvent(e, {
      fairProbability: options.fairProbability,
      staleMs: undefined,
    })
  );
  merged = sortAggregatedEvents(merged);

  if (kalshiEvents.length || ibkrEvents.length) {
    // Preserve one metadata record per venue-native contract. Canonical merged
    // rows are a display concern and must not collapse catalog identities.
    await persistCatalogEvents(providerEvents, { source: 'live-provider-refresh' });
  }

  const providers = getProviderStatus();
  if (!kalshiEvents.length && !process.env.KALSHI_API_KEY_ID) {
    providers.kalshi = {
      status: 'error',
      message: 'Kalshi live data is unavailable.',
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
