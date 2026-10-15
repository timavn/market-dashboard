const { previousTradingDateKey } = require('./usEquityMarketCalendar.cjs');

const EXCHANGE_VOLUME_METHODOLOGY = 'cboe-consolidated-exchange-volume-v2';
const EXCHANGE_VOLUME_WINDOWS = Object.freeze({ priorDay: 1, avg1M: 21, avg3M: 60, avg1Y: 250 });
const EXCHANGE_VOLUME_SOURCE = Object.freeze({
  id: 'cboeConsolidatedVolume',
  label: 'Cboe',
  provider: 'Cboe',
  dataset: 'Historical Market Volume',
  description: 'Tape A+B+C share volume, including FINRA-reported trades in listed stocks.',
});
const EXCHANGE_VOLUME_SOURCE_TYPE = 'cboe-consolidated-volume';
const MAX_VERIFICATION_AGE_MS = 20 * 60 * 1000;

function emptyVolumeMetrics() {
  return {
    priorDay: null, avg1M: null, avg3M: null, avg1Y: null,
    pctPriorDay: null, pct1M: null, pct3M: null, pct1Y: null,
  };
}

function expectedVolumeTradingDate(now = new Date()) {
  const date = new Date(now);
  if (!Number.isFinite(date.getTime())) return null;
  const easternDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
  // This is a morning-style daily report, including after today's close.
  // Today's annual-file rows may still be incomplete and are never used.
  return previousTradingDateKey(easternDate);
}

const positiveVolume = value => typeof value === 'number' && Number.isFinite(value) && value > 0;

function calculateExchangeVolumeMetrics(volumeHistory) {
  const metrics = emptyVolumeMetrics();
  if (!Array.isArray(volumeHistory) || volumeHistory.length < 2 || !positiveVolume(volumeHistory[0])) return metrics;
  const current = volumeHistory[0];
  metrics.priorDay = current;
  const percent = baseline => positiveVolume(baseline) ? ((current / baseline) - 1) * 100 : null;
  metrics.pctPriorDay = percent(volumeHistory[1]);
  for (const [averageKey, percentageKey] of [['avg1M', 'pct1M'], ['avg3M', 'pct3M'], ['avg1Y', 'pct1Y']]) {
    const count = EXCHANGE_VOLUME_WINDOWS[averageKey];
    const values = volumeHistory.slice(1, count + 1);
    if (values.length !== count || !values.every(positiveVolume)) continue;
    metrics[averageKey] = values.reduce((sum, value) => sum + value, 0) / count;
    metrics[percentageKey] = percent(metrics[averageKey]);
  }
  return metrics;
}

function hasUnverifiedVolumeFlags(value) {
  if (!value || typeof value !== 'object') return false;
  for (const key of ['stale', 'isStale', 'cacheOnly', 'cache_only', 'fromCache', 'cached', 'seed', 'seeded', 'isSeed', 'isSeeded', 'mock', 'isMock', 'synthetic', 'inferred', 'fallback', 'testOnly', 'offline']) {
    if (value[key] === true || value[key] === 'true') return true;
  }
  if (value.connected === false || value.providerConnected === false || value.verified === false) return true;
  if (value._cache?.hit === true || value._cache?.stale === true) return true;
  return ['status', 'source', 'sourceType', 'providerStatus', 'storage', 'cacheStatus'].some(key => (
    typeof value[key] === 'string'
    && /(?:unavailable|offline|error|failed|stale|cache|seed|mock|synthetic|inferred|fallback|provisional|disconnected)/i.test(value[key])
  ));
}

function isVerifiedExchangeVolumeResponse(response, now = new Date()) {
  const meta = response?.meta;
  const metrics = response?.metrics?.exchange;
  const expectedDate = expectedVolumeTradingDate(now);
  if (!meta || !metrics || !expectedDate || hasUnverifiedVolumeFlags(response) || hasUnverifiedVolumeFlags(meta)) return false;
  if (meta.status !== 'current' || meta.verified !== true || meta.provider !== 'Cboe'
    || meta.sourceType !== EXCHANGE_VOLUME_SOURCE_TYPE || meta.methodologyVersion !== EXCHANGE_VOLUME_METHODOLOGY
    || response.asOf !== expectedDate || meta.asOfTradingDate !== expectedDate || meta.expectedTradingDate !== expectedDate) return false;
  const verifiedAt = Date.parse(meta.fetchedAt);
  const age = new Date(now).getTime() - verifiedAt;
  if (!Number.isFinite(verifiedAt) || age < -60000 || age > MAX_VERIFICATION_AGE_MS) return false;
  if (!Object.entries(EXCHANGE_VOLUME_WINDOWS).every(([key, count]) => meta.comparisonWindows?.[key] === count)) return false;
  if (!Array.isArray(meta.sourceBreakdown) || !meta.sourceBreakdown.some(source => (
    source.id === EXCHANGE_VOLUME_SOURCE.id && source.provider === 'Cboe'
    && source.dataset === EXCHANGE_VOLUME_SOURCE.dataset && !hasUnverifiedVolumeFlags(source)
  ))) return false;
  if (!Array.isArray(response.totalExchange) || response.totalExchange[0]?.date !== expectedDate
    || !positiveVolume(response.totalExchange[0]?.volume)
    || response.totalExchange.some(row => hasUnverifiedVolumeFlags(row))
    || hasUnverifiedVolumeFlags(metrics)) return false;
  const percentages = ['pctPriorDay', 'pct1M', 'pct3M', 'pct1Y'];
  return positiveVolume(metrics.priorDay)
    && percentages.every(key => metrics[key] === null || (typeof metrics[key] === 'number' && Number.isFinite(metrics[key])))
    && percentages.some(key => Number.isFinite(metrics[key]));
}

module.exports = {
  EXCHANGE_VOLUME_METHODOLOGY,
  EXCHANGE_VOLUME_WINDOWS,
  EXCHANGE_VOLUME_SOURCE,
  EXCHANGE_VOLUME_SOURCE_TYPE,
  MAX_VERIFICATION_AGE_MS,
  emptyVolumeMetrics,
  expectedVolumeTradingDate,
  calculateExchangeVolumeMetrics,
  hasUnverifiedVolumeFlags,
  isVerifiedExchangeVolumeResponse,
};
