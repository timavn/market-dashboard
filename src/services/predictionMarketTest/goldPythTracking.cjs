'use strict';

const GOLD_SERIES_TICKER = 'KXGOLDD';
const GOLD_RESOLVER_SYMBOL = 'Metal.Index.GOLD/USD';
const GOLD_PROXY_SYMBOL = 'XAUUSD';
const GOLD_GUARD_BAND_USD = 10;
const GOLD_TRACKING_WINDOW = 20;
const GOLD_TRACKING_MINIMUM = 5;
const GOLD_EXACT_URL = 'https://app.pyth.com/explore/Metal.Index.GOLD%2FUSD?returnUrl=%2Fexplore%3Fstate%3Dstable';
const HOUR_MS = 60 * 60 * 1000;
const MONTH_CODES = Object.freeze(['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']);

function finiteNumber(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function percentile(values, probability) {
  const rows = (Array.isArray(values) ? values : [])
    .map(finiteNumber)
    .filter((value) => value != null)
    .sort((left, right) => left - right);
  if (!rows.length) return null;
  if (rows.length === 1) return rows[0];
  const position = (rows.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return rows[lower];
  const weight = position - lower;
  return rows[lower] + ((rows[upper] - rows[lower]) * weight);
}

function selectedGoldEventTicker(selected) {
  const event = selected?.contracts?.event
    || selected?.book?.event
    || selected?.catalog?.event
    || selected?.event
    || null;
  const ticker = String(
    event?.ticker
      || event?.event_ticker
      || event?.generationId
      || selected?.generationId
      || '',
  ).trim().toUpperCase();
  return ticker.startsWith(`${GOLD_SERIES_TICKER}-`) ? ticker : null;
}

function eventTickerMatchesObservation(eventTicker, observationAt) {
  if (!/^KXGOLDD-\d{2}[A-Z]{3}\d{2}17$/.test(eventTicker)) return false;
  const timestamp = Date.parse(observationAt || '');
  if (!Number.isFinite(timestamp)) return false;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: '2-digit',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const monthCode = MONTH_CODES[Number(values.month) - 1];
  return Boolean(monthCode)
    && values.hour === '17'
    && values.minute === '00'
    && eventTicker === `KXGOLDD-${values.year}${monthCode}${values.day}17`;
}

function finalizedGoldEvent(event) {
  const eventTicker = String(event?.event_ticker || event?.ticker || '').trim().toUpperCase();
  const seriesTicker = String(event?.series_ticker || event?.seriesTicker || '').trim().toUpperCase();
  const markets = Array.isArray(event?.markets) ? event.markets : [];
  if (seriesTicker !== GOLD_SERIES_TICKER
    || !eventTicker.startsWith(`${GOLD_SERIES_TICKER}-`)
    || !markets.length) return null;

  const finalized = markets.filter((market) => {
    const status = String(market?.status || '').toLowerCase();
    const result = String(market?.result || '').toUpperCase();
    const rules = `${market?.rules_primary || ''} ${market?.rules_secondary || ''}`;
    return ['finalized', 'settled'].includes(status)
      && ['YES', 'NO'].includes(result)
      && /gold/i.test(rules)
      && /1-minute\s+candlestick/i.test(rules)
      && finiteNumber(market?.expiration_value) != null;
  });
  if (!finalized.length) return null;
  const settlementValues = [...new Set(finalized.map((market) => finiteNumber(market.expiration_value)))];
  if (settlementValues.length !== 1 || !(settlementValues[0] > 0)) return null;
  const closeTimes = [...new Set(finalized
    .map((market) => market?.close_time || market?.closeTime)
    .filter(Boolean)
    .map((value) => {
      const timestamp = Date.parse(value);
      return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
    })
    .filter(Boolean))];
  if (closeTimes.length !== 1) return null;
  if (!eventTickerMatchesObservation(eventTicker, closeTimes[0])) return null;
  const settlementTimes = finalized
    .map((market) => market?.settlement_ts || market?.settled_time || market?.settledTime)
    .filter(Boolean)
    .map((value) => Date.parse(value))
    .filter(Number.isFinite)
    .sort((left, right) => right - left);
  if (!settlementTimes.length) return null;
  return {
    eventTicker,
    seriesTicker,
    observationAt: closeTimes[0],
    finalizedAt: new Date(settlementTimes[0]).toISOString(),
    value: settlementValues[0],
    source: 'kalshi_finalized_expiration_value',
  };
}

function normalizeFinalizedGoldEvents(payload) {
  return (Array.isArray(payload?.events) ? payload.events : [])
    .map(finalizedGoldEvent)
    .filter(Boolean)
    .sort((left, right) => Date.parse(left.observationAt) - Date.parse(right.observationAt))
    .slice(-GOLD_TRACKING_WINDOW);
}

function proxyCloseForObservation(points, observationAt) {
  const observationMs = Date.parse(observationAt || '');
  if (!Number.isFinite(observationMs)) return null;
  const point = (Array.isArray(points) ? points : [])
    .map((candidate) => ({
      timestamp: Number(candidate?.timestamp),
      value: finiteNumber(candidate?.value),
    }))
    .filter((candidate) => (
      Number.isFinite(candidate.timestamp)
      && candidate.value != null
      && candidate.value > 0
      && candidate.timestamp < observationMs
      && candidate.timestamp >= observationMs - (HOUR_MS + (5 * 60 * 1000))
    ))
    .sort((left, right) => left.timestamp - right.timestamp)
    .at(-1);
  return point ? {
    value: point.value,
    asOf: new Date(point.timestamp).toISOString(),
  } : null;
}

function emptyGoldPythTracking(reason, extras = {}) {
  return {
    status: 'unavailable',
    source: 'kalshi_finalized_expiration_value',
    resolverSymbol: GOLD_RESOLVER_SYMBOL,
    proxySymbol: GOLD_PROXY_SYMBOL,
    sampleSize: 0,
    meanSignedErrorUsd: null,
    meanAbsoluteErrorUsd: null,
    medianAbsoluteErrorUsd: null,
    p90AbsoluteErrorUsd: null,
    maxAbsoluteErrorUsd: null,
    guardBandUsd: GOLD_GUARD_BAND_USD,
    settlements: [],
    latestFinal: null,
    currentEventFinal: null,
    exactUrl: GOLD_EXACT_URL,
    entitlement: 'api_entitlement_required',
    methodology: 'Kalshi finalized Pyth value minus the verified IBKR XAUUSD hourly bar ending at 5:00 PM ET.',
    asOf: null,
    reason,
    ...extras,
  };
}

function buildGoldPythTracking({ payload, proxyPoints, selectedEventTicker = null } = {}) {
  const finals = normalizeFinalizedGoldEvents(payload);
  const latestFinal = finals.at(-1) || null;
  const settlements = finals.map((final) => ({
    status: 'available',
    availability: 'official_final',
    final: true,
    eventTicker: final.eventTicker,
    observationAt: final.observationAt,
    finalizedAt: final.finalizedAt,
    value: final.value,
    source: final.source,
  }));
  const observations = finals.map((final) => {
    const proxy = proxyCloseForObservation(proxyPoints, final.observationAt);
    if (!proxy) return null;
    const signedErrorUsd = final.value - proxy.value;
    return {
      eventTicker: final.eventTicker,
      observationAt: final.observationAt,
      finalizedAt: final.finalizedAt,
      exactValue: final.value,
      proxyValue: proxy.value,
      proxyAsOf: proxy.asOf,
      signedErrorUsd,
      absoluteErrorUsd: Math.abs(signedErrorUsd),
    };
  }).filter(Boolean).slice(-GOLD_TRACKING_WINDOW);
  const sampleSize = observations.length;
  const exactLatest = latestFinal ? {
    eventTicker: latestFinal.eventTicker,
    value: latestFinal.value,
    observationAt: latestFinal.observationAt,
    finalizedAt: latestFinal.finalizedAt,
    source: latestFinal.source,
  } : null;
  const currentEventFinal = exactLatest
    && String(selectedEventTicker || '').toUpperCase() === exactLatest.eventTicker
    ? exactLatest
    : null;
  if (sampleSize < GOLD_TRACKING_MINIMUM) {
    return emptyGoldPythTracking(
      sampleSize
        ? `Only ${sampleSize} verified XAUUSD/Pyth matches are available; ${GOLD_TRACKING_MINIMUM} are required.`
        : latestFinal
          ? 'Official Kalshi Gold finals are available, but matching verified XAUUSD closes are unavailable.'
          : 'No verified finalized KXGOLDD observations are available.',
      {
        status: latestFinal || sampleSize ? 'partial' : 'unavailable',
        sampleSize,
        settlements,
        latestFinal: exactLatest,
        currentEventFinal,
        asOf: latestFinal?.finalizedAt || null,
      },
    );
  }
  const signed = observations.map((observation) => observation.signedErrorUsd);
  const absolute = observations.map((observation) => observation.absoluteErrorUsd);
  const mean = (values) => values.reduce((total, value) => total + value, 0) / values.length;
  return {
    ...emptyGoldPythTracking(null),
    status: 'available',
    sampleSize,
    meanSignedErrorUsd: mean(signed),
    meanAbsoluteErrorUsd: mean(absolute),
    medianAbsoluteErrorUsd: percentile(absolute, 0.5),
    p90AbsoluteErrorUsd: percentile(absolute, 0.9),
    maxAbsoluteErrorUsd: Math.max(...absolute),
    settlements,
    latestFinal: exactLatest,
    currentEventFinal,
    asOf: latestFinal?.finalizedAt || null,
    reason: null,
  };
}

module.exports = {
  GOLD_EXACT_URL,
  GOLD_GUARD_BAND_USD,
  GOLD_RESOLVER_SYMBOL,
  GOLD_SERIES_TICKER,
  GOLD_TRACKING_MINIMUM,
  GOLD_TRACKING_WINDOW,
  buildGoldPythTracking,
  emptyGoldPythTracking,
  finalizedGoldEvent,
  normalizeFinalizedGoldEvents,
  proxyCloseForObservation,
  selectedGoldEventTicker,
};
