const crypto = require('node:crypto');
const { zonedTimeToUtc } = require('date-fns-tz');
const { CONTRACT_REGISTRY } = require('./predictionMarketTest/registry.cjs');
const { isOfficialFesTermsUrl, parseFesResolverIdentity } = require('./forecastExFesIdentity.cjs');

const FORECASTEX_CONTRACTS_URL = 'https://www.forecastex.com/api/contracts';
const FORECASTEX_CENTRAL_TIME_ZONE = 'America/Chicago';
const FORECASTEX_SCHEDULE_TIMEOUT_MS = 12_000;
const MAX_FORECASTEX_SCHEDULE_BYTES = 12 * 1024 * 1024;
const SUPPORTED_PRODUCTS = Object.freeze({
  COMCO: 'wti',
  METLG: 'gold',
  FES: 'sp500',
});

function sourceError(message, code) {
  return Object.assign(new Error(message), { code });
}

function validCalendarDate(year, month, day) {
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return date.getUTCFullYear() === Number(year)
    && date.getUTCMonth() === Number(month) - 1
    && date.getUTCDate() === Number(day);
}

function parseEventContract(value) {
  const raw = String(value || '').trim().toUpperCase();
  const match = raw.match(/^(COMCO|METLG|FES)_(\d{2})(\d{2})(\d{2})_(-?\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const [, productCode, month, day, year, strikeText] = match;
  const fullYear = 2000 + Number(year);
  if (!validCalendarDate(fullYear, month, day)) return null;
  const strike = Number(strikeText);
  if (!Number.isFinite(strike)) return null;
  return {
    eventContract: raw,
    productCode,
    market: SUPPORTED_PRODUCTS[productCode],
    eventDate: `${fullYear}-${month}-${day}`,
    strike,
  };
}

function centralTimestamp(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/^(20\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)$/);
  if (!match || !validCalendarDate(match[1], match[2], match[3])) return null;
  const parsed = zonedTimeToUtc(raw.replace('T', ' '), FORECASTEX_CENTRAL_TIME_ZONE);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function resolverSymbolFor(identity, row = null) {
  if (identity.productCode === 'FES') {
    return parseFesResolverIdentity(row?.question, {
      eventDate: identity.eventDate,
      strike: identity.strike,
    }).resolverSymbol;
  }
  const registered = CONTRACT_REGISTRY.find((product) => (
    product.id === identity.market
    && product.resolutionDate === identity.eventDate
    && product.venues?.some((venue) => venue.venue === 'ForecastEx' && venue.productCode === identity.productCode)
  ));
  return registered?.resolver?.contractSymbol || null;
}

function nestedContractRows(payload) {
  if (Number(payload?.statusCode) !== 200 || !payload?.body || typeof payload.body.data !== 'string') {
    throw sourceError('ForecastEx contract schedule response schema changed.', 'FORECASTEX_SCHEDULE_SCHEMA_INVALID');
  }
  let rows;
  try {
    rows = JSON.parse(payload.body.data);
  } catch (_error) {
    throw sourceError('ForecastEx contract schedule data was not valid nested JSON.', 'FORECASTEX_SCHEDULE_SCHEMA_INVALID');
  }
  if (!Array.isArray(rows)) {
    throw sourceError('ForecastEx contract schedule data was not an array.', 'FORECASTEX_SCHEDULE_SCHEMA_INVALID');
  }
  return rows;
}

function parseOfficialForecastExContractSchedule(payload, {
  productCode,
  eventContract,
  observedAt = new Date().toISOString(),
  sourceUrl = FORECASTEX_CONTRACTS_URL,
  sourceHash = null,
} = {}) {
  const identity = parseEventContract(eventContract);
  if (!identity || identity.productCode !== String(productCode || '').trim().toUpperCase()) {
    throw sourceError('An exact supported ForecastEx contract identity is required.', 'FORECASTEX_SCHEDULE_IDENTITY_INVALID');
  }
  const observedTimestamp = Date.parse(observedAt);
  if (!Number.isFinite(observedTimestamp)) {
    throw sourceError('ForecastEx schedule observation time was invalid.', 'FORECASTEX_SCHEDULE_SCHEMA_INVALID');
  }
  const source = new URL(sourceUrl);
  if (!/(^|\.)forecastex\.com$/i.test(source.hostname)) {
    throw sourceError('ForecastEx schedule source was not authoritative.', 'FORECASTEX_SCHEDULE_SOURCE_UNVERIFIED');
  }
  const matches = nestedContractRows(payload).filter((row) => String(row?.contract_id || '').trim().toUpperCase() === identity.eventContract);
  if (matches.length !== 1) {
    throw sourceError('ForecastEx did not return exactly one requested contract schedule.', 'FORECASTEX_SCHEDULE_IDENTITY_INVALID');
  }
  const row = matches[0];
  if (String(row.product_id || '').trim().toUpperCase() !== identity.productCode) {
    throw sourceError('ForecastEx returned a schedule for a different product.', 'FORECASTEX_SCHEDULE_IDENTITY_INVALID');
  }
  const lastTradeAt = centralTimestamp(row.last_trade_date);
  const resolutionAt = centralTimestamp(row.expiration_date);
  const payoutAt = centralTimestamp(row.payout_date);
  let fesResolver = null;
  if (identity.productCode === 'FES') {
    try {
      fesResolver = parseFesResolverIdentity(row.question, {
        eventDate: identity.eventDate,
        strike: identity.strike,
      });
    } catch (error) {
      throw sourceError(error.message, error.code || 'FORECASTEX_SCHEDULE_IDENTITY_INVALID');
    }
  }
  const exactFesSchedule = identity.productCode !== 'FES' || (
    isOfficialFesTermsUrl(row.exchange_spec_url)
    &&
    String(row.last_trade_date).endsWith('T15:00:00')
    && String(row.expiration_date).slice(0, 10) > identity.eventDate
  );
  if (!lastTradeAt || !resolutionAt || !payoutAt
    || Date.parse(lastTradeAt) >= Date.parse(resolutionAt)
    || Date.parse(resolutionAt) > Date.parse(payoutAt)
    || String(row.last_trade_date).slice(0, 10) !== identity.eventDate
    || !/\b(?:above|exceed)\b/i.test(String(row.question || ''))
    || !exactFesSchedule) {
    throw sourceError('ForecastEx returned an invalid or conflicting contract schedule.', 'FORECASTEX_SCHEDULE_SCHEMA_INVALID');
  }
  return {
    ok: true,
    venue: 'ForecastEx',
    source: 'forecastex_official_contract_api',
    productCode: identity.productCode,
    market: identity.market,
    eventTicker: identity.eventContract,
    eventDate: identity.eventDate,
    strike: identity.strike,
    lastTradeAt,
    resolutionAt,
    payoutAt,
    settlementSymbol: resolverSymbolFor(identity, row),
    resolverContractMonth: fesResolver?.underlyingContractMonth || null,
    resolverMonthLabel: fesResolver?.resolverMonthLabel || null,
    sourceUrl: source.toString(),
    observedAt: new Date(observedTimestamp).toISOString(),
    sourceHash,
    rulesUrl: row.exchange_spec_url || null,
  };
}

async function loadOfficialForecastExContractSchedule({
  productCode,
  eventContract,
  fetchImpl = global.fetch,
  now = () => new Date(),
  baseUrl = FORECASTEX_CONTRACTS_URL,
} = {}) {
  const identity = parseEventContract(eventContract);
  if (!identity || identity.productCode !== String(productCode || '').trim().toUpperCase()) {
    throw sourceError('An exact supported ForecastEx contract identity is required.', 'FORECASTEX_SCHEDULE_IDENTITY_INVALID');
  }
  if (typeof fetchImpl !== 'function') {
    throw sourceError('No HTTP client is available for ForecastEx schedules.', 'FORECASTEX_SCHEDULE_FETCH_UNAVAILABLE');
  }
  const url = new URL(baseUrl);
  if (!/(^|\.)forecastex\.com$/i.test(url.hostname)) {
    throw sourceError('ForecastEx schedule source was not authoritative.', 'FORECASTEX_SCHEDULE_SOURCE_UNVERIFIED');
  }
  url.searchParams.set('page', '1');
  url.searchParams.set('pageSize', '1000');
  url.searchParams.set('productId', identity.productCode);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FORECASTEX_SCHEDULE_TIMEOUT_MS);
  let response;
  try {
    response = await fetchImpl(url.toString(), {
      method: 'GET',
      headers: { accept: 'application/json' },
      cache: 'no-store',
      signal: controller.signal,
    });
  } catch (error) {
    throw sourceError(
      'The official ForecastEx contract schedule is unavailable.',
      error?.name === 'AbortError' ? 'FORECASTEX_SCHEDULE_FETCH_TIMEOUT' : 'FORECASTEX_SCHEDULE_FETCH_UNAVAILABLE',
    );
  } finally {
    clearTimeout(timer);
  }
  if (!response?.ok) {
    throw sourceError('The official ForecastEx contract schedule returned an error.', 'FORECASTEX_SCHEDULE_FETCH_UNAVAILABLE');
  }
  const responseUrl = new URL(response.url || url.toString());
  if (!/(^|\.)forecastex\.com$/i.test(responseUrl.hostname)) {
    throw sourceError('ForecastEx schedule request redirected outside ForecastEx.', 'FORECASTEX_SCHEDULE_SOURCE_UNVERIFIED');
  }
  const contentType = response.headers?.get?.('content-type');
  if (contentType && !/application\/json/i.test(contentType)) {
    throw sourceError('ForecastEx schedule response was not JSON.', 'FORECASTEX_SCHEDULE_SOURCE_UNVERIFIED');
  }
  const raw = await response.text();
  if (!raw || Buffer.byteLength(raw, 'utf8') > MAX_FORECASTEX_SCHEDULE_BYTES) {
    throw sourceError('ForecastEx schedule response was empty or oversized.', 'FORECASTEX_SCHEDULE_SCHEMA_INVALID');
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (_error) {
    throw sourceError('ForecastEx schedule response was invalid JSON.', 'FORECASTEX_SCHEDULE_SCHEMA_INVALID');
  }
  return parseOfficialForecastExContractSchedule(payload, {
    productCode: identity.productCode,
    eventContract: identity.eventContract,
    observedAt: now().toISOString(),
    sourceUrl: responseUrl.toString(),
    sourceHash: crypto.createHash('sha256').update(raw).digest('hex'),
  });
}

module.exports = {
  FORECASTEX_CENTRAL_TIME_ZONE,
  FORECASTEX_CONTRACTS_URL,
  FORECASTEX_SCHEDULE_TIMEOUT_MS,
  MAX_FORECASTEX_SCHEDULE_BYTES,
  centralTimestamp,
  loadOfficialForecastExContractSchedule,
  parseEventContract,
  parseOfficialForecastExContractSchedule,
};
