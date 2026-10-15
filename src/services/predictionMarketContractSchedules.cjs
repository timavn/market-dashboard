const crypto = require('node:crypto');
const { forecastExThresholdIdentity } = require('./predictionMarketPerformanceLedger.cjs');
const { exactKalshiMarketTicker } = require('./predictionMarketPerformanceMarks.cjs');

const KALSHI_MARKET_URL = 'https://external-api.kalshi.com/trade-api/v2/markets';

function iso(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function finite(value) {
  if (value == null || String(value).trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseKalshiMarketSchedule(payload, { ticker, observedAt = new Date().toISOString() } = {}) {
  const expectedTicker = String(ticker || '').trim().toUpperCase();
  const market = payload?.market;
  const actualTicker = String(market?.ticker || '').trim().toUpperCase();
  const observation = iso(observedAt);
  const lastTradeAt = iso(market?.close_time);
  const expectedResolutionAt = iso(market?.expected_expiration_time);
  const venueStatus = String(market?.status || '').trim().toLowerCase();
  const final = ['finalized', 'settled'].includes(venueStatus);
  const finalizedAt = final ? iso(market?.settlement_ts || market?.settled_time) : null;
  const payoutAt = finalizedAt;
  // Expected expiration is schedule metadata. The venue's settlement timestamp
  // is the actual finalization event; keeping them separate prevents a normal
  // expected -> finalized transition from looking like conflicting evidence.
  const resolutionAt = finalizedAt;
  const outcome = final ? String(market?.result || '').trim().toUpperCase() : null;
  if (!expectedTicker || actualTicker !== expectedTicker || !observation || !lastTradeAt || !expectedResolutionAt
    || Date.parse(lastTradeAt) > Date.parse(final ? resolutionAt : expectedResolutionAt)
    || (final && (!payoutAt || !['YES', 'NO'].includes(outcome)))) {
    const error = new Error('Kalshi returned an invalid or conflicting exact market schedule.');
    error.code = 'KALSHI_SCHEDULE_INVALID';
    throw error;
  }
  const settlementSymbol = String(market?.custom_strike?.front_month_contract || '').trim() || null;
  const settlementValue = finite(market?.expiration_value);
  const sourceUrl = `${KALSHI_MARKET_URL}/${encodeURIComponent(expectedTicker)}`;
  return {
    ok: true,
    venue: 'Kalshi',
    source: 'kalshi_exact_market',
    eventTicker: expectedTicker,
    lastTradeAt,
    resolutionAt,
    expectedResolutionAt,
    finalizedAt,
    payoutAt,
    settlementSymbol,
    venueStatus,
    outcome: ['YES', 'NO'].includes(outcome) ? outcome : null,
    settlementValue,
    sourceUrl,
    observedAt: observation,
    sourceHash: crypto.createHash('sha256').update(JSON.stringify(market)).digest('hex'),
  };
}

function buildPredictionMarketScheduleProvider({
  loadOfficialForecastExContractSchedule,
  kalshiFetch,
  now = () => new Date(),
} = {}) {
  return async function loadContractSchedule(record = {}) {
    const forecastEx = forecastExThresholdIdentity(record);
    if (forecastEx
      && ['COMCO', 'METLG', 'FES'].includes(forecastEx.productCode)
      && typeof loadOfficialForecastExContractSchedule === 'function') {
      return loadOfficialForecastExContractSchedule({
        productCode: forecastEx.productCode,
        eventContract: forecastEx.eventContract,
      });
    }
    const ticker = exactKalshiMarketTicker(record);
    if (!ticker || typeof kalshiFetch !== 'function') return null;
    const payload = await kalshiFetch(`/markets/${encodeURIComponent(ticker)}`);
    return parseKalshiMarketSchedule(payload, { ticker, observedAt: now().toISOString() });
  };
}

module.exports = {
  KALSHI_MARKET_URL,
  buildPredictionMarketScheduleProvider,
  parseKalshiMarketSchedule,
};
