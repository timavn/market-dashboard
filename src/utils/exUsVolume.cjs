const { EX_US_VOLUME_PROXY } = require('../constants/volumeMarkets.cjs');
const {
  EXCHANGE_VOLUME_WINDOWS,
  MAX_VERIFICATION_AGE_MS,
  calculateExchangeVolumeMetrics,
  emptyVolumeMetrics,
  expectedVolumeTradingDate,
  hasUnverifiedVolumeFlags,
} = require('./exchangeVolume.cjs');
const { previousTradingDateKey } = require('./usEquityMarketCalendar.cjs');

const EX_US_VOLUME_METHODOLOGY = 'ibkr-acwx-volume-v1';
const EX_US_VOLUME_SOURCE_TYPE = 'ibkr-etf-volume';
const EX_US_VOLUME_SOURCE = Object.freeze({
  id: EX_US_VOLUME_PROXY.id,
  label: `${EX_US_VOLUME_PROXY.symbol} · IBKR`,
  provider: 'IBKR',
  dataset: 'Regular-hours daily ETF trade volume',
  symbol: EX_US_VOLUME_PROXY.symbol,
  issuerUrl: EX_US_VOLUME_PROXY.issuerUrl,
  description: EX_US_VOLUME_PROXY.description,
});

function requiredExUsVolumeDates(targetDate) {
  if (!targetDate) return [];
  const dates = [targetDate];
  while (dates.length <= EXCHANGE_VOLUME_WINDOWS.avg1Y) {
    const previous = previousTradingDateKey(dates[dates.length - 1]);
    if (!previous) return [];
    dates.push(previous);
  }
  return dates;
}

function hasUnverifiedExUsVolumeFlags(value) {
  if (hasUnverifiedVolumeFlags(value)) return true;
  if (!value || typeof value !== 'object') return false;
  if (value.error != null && value.error !== '' && value.error !== false) return true;
  if (['delayed', 'frozen', 'cachedOnly', 'cacheHit'].some(key => value[key] === true || value[key] === 'true')) return true;
  return ['warning', 'error', 'provenance', 'sourceStatus', 'cacheState', 'dataType', 'quoteMode', 'status'].some(key => (
    typeof value[key] === 'string'
    && /delayed|frozen|stale|cache|mock|seed|fallback|offline|disconnected|synthetic|inferred|derived/i.test(value[key])
  ));
}

function isVerifiedExUsVolumeContract(contract) {
  return Boolean(contract && !hasUnverifiedExUsVolumeFlags(contract)
    && Number.isInteger(contract.conId) && contract.conId > 0
    && contract.symbol === EX_US_VOLUME_PROXY.symbol
    && contract.secType === EX_US_VOLUME_PROXY.instrument.secType
    && contract.exchange === EX_US_VOLUME_PROXY.instrument.exchange
    && contract.currency === EX_US_VOLUME_PROXY.instrument.currency
    && contract.provider === 'ibkr');
}

function hasFreshExUsVolumeFetch(fetchedAt, now) {
  const timestamp = Date.parse(fetchedAt);
  const age = new Date(now).getTime() - timestamp;
  return Number.isFinite(timestamp) && age >= -60000 && age <= MAX_VERIFICATION_AGE_MS;
}

function exUsVolumeMetadata(targetDate, fetchedAt, status, extra = {}) {
  return {
    status,
    verified: status === 'current',
    provider: 'IBKR',
    providerConnected: status === 'current',
    sourceType: EX_US_VOLUME_SOURCE_TYPE,
    methodologyVersion: EX_US_VOLUME_METHODOLOGY,
    asOfTradingDate: status === 'current' ? targetDate : null,
    expectedTradingDate: targetDate,
    fetchedAt,
    comparisonWindows: EXCHANGE_VOLUME_WINDOWS,
    sourceBreakdown: [EX_US_VOLUME_SOURCE],
    useRth: true,
    interval: '1d',
    ...extra,
  };
}

function unavailableExUsVolume(targetDate, now = new Date(), errorCode = 'EX_US_VOLUME_UNAVAILABLE') {
  return {
    asOf: null,
    totalMarket: [],
    totalExchange: [],
    metrics: { exchange: emptyVolumeMetrics() },
    meta: exUsVolumeMetadata(targetDate, new Date(now).toISOString(), 'unavailable', { errorCode, contract: null }),
  };
}

function isVerifiedExUsVolumeResponse(response, now = new Date()) {
  const meta = response?.meta;
  const expectedDate = expectedVolumeTradingDate(now);
  if (!expectedDate || !meta || hasUnverifiedExUsVolumeFlags(response) || hasUnverifiedExUsVolumeFlags(meta)) return false;
  if (meta.status !== 'current' || meta.verified !== true || meta.provider !== 'IBKR'
    || meta.providerConnected !== true || meta.sourceType !== EX_US_VOLUME_SOURCE_TYPE
    || meta.methodologyVersion !== EX_US_VOLUME_METHODOLOGY
    || response.asOf !== expectedDate || meta.asOfTradingDate !== expectedDate
    || meta.expectedTradingDate !== expectedDate || meta.useRth !== true || meta.interval !== '1d'
    || !hasFreshExUsVolumeFetch(meta.fetchedAt, now) || !isVerifiedExUsVolumeContract(meta.contract)) return false;
  if (!Object.entries(EXCHANGE_VOLUME_WINDOWS).every(([key, count]) => meta.comparisonWindows?.[key] === count)) return false;
  if (!Array.isArray(meta.sourceBreakdown) || !meta.sourceBreakdown.some(source => (
    source.id === EX_US_VOLUME_SOURCE.id && source.provider === 'IBKR'
    && source.symbol === EX_US_VOLUME_PROXY.symbol && source.dataset === EX_US_VOLUME_SOURCE.dataset
    && !hasUnverifiedExUsVolumeFlags(source)
  ))) return false;
  const dates = requiredExUsVolumeDates(expectedDate);
  if (!Array.isArray(response.totalExchange) || response.totalExchange.length !== dates.length
    || response.totalExchange.some((row, index) => !row || row.date !== dates[index]
      || hasUnverifiedExUsVolumeFlags(row)
      || (row.volume !== null && !(typeof row.volume === 'number' && Number.isFinite(row.volume) && row.volume > 0)))) return false;
  const metrics = response.metrics?.exchange;
  if (!metrics || hasUnverifiedExUsVolumeFlags(metrics)) return false;
  const calculated = calculateExchangeVolumeMetrics(response.totalExchange.map(row => row.volume));
  return Number.isFinite(calculated.pctPriorDay)
    && Object.entries(calculated).every(([key, value]) => metrics[key] === value);
}

module.exports = {
  EX_US_VOLUME_METHODOLOGY,
  EX_US_VOLUME_SOURCE_TYPE,
  EX_US_VOLUME_SOURCE,
  requiredExUsVolumeDates,
  hasUnverifiedExUsVolumeFlags,
  isVerifiedExUsVolumeContract,
  hasFreshExUsVolumeFetch,
  exUsVolumeMetadata,
  unavailableExUsVolume,
  isVerifiedExUsVolumeResponse,
};
