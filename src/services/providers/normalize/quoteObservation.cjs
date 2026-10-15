const configuredMaxAge = Number(process.env.IBKR_QUOTE_STALE_SEC || 60) * 1000;
const MAX_AGE_MS = Number.isFinite(configuredMaxAge) && configuredMaxAge > 0 ? configuredMaxAge : 60000;
const MAX_FUTURE_SKEW_MS = 5000;
const REJECTED = /(?:stale|frozen|offline|disconnected|mock|seed|synthetic|inferred|fallback|cache[_ -]?(?:only|disconnected)|close_only_reference)/i;

function strictQuoteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value !== value.trim() || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

// A cache can reuse an observation but cannot renew its market timestamp.
// Delayed observations remain explicitly delayed; this does not authorize sizing.
function ibkrObservationFailure(quote, { now = Date.now(), maxAgeMs = MAX_AGE_MS } = {}) {
  if (!quote || typeof quote !== 'object') return 'quote_unavailable';
  const observed = Date.parse(String(quote.timestamp || ''));
  if (!Number.isFinite(observed)) return 'missing_timestamp';
  const age = now - observed;
  if (age < -MAX_FUTURE_SKEW_MS || age > maxAgeMs) return 'stale_quote';
  const type = String(quote.dataType || '').toLowerCase();
  if (!['live', 'delayed'].includes(type)) return type.includes('frozen') ? 'frozen_quote' : 'unverified_data_type';
  const entitlement = String(quote.entitlementStatus || '').toLowerCase();
  if (!['live', 'delayed', 'tick_by_tick'].includes(entitlement)) return 'entitlement_unavailable';
  if (['mock', 'isMock', 'seeded', 'isSeed', 'synthetic', 'fallback', 'cacheOnly', 'cachedOnly', 'from_cache_only'].some((key) => quote[key] === true)
    || REJECTED.test([quote.warning, quote.provenance, quote.sourceStatus, quote.cacheStatus, quote.priceState].filter(Boolean).join(' '))) {
    return 'unverified_observation';
  }
  if (['bid', 'ask', 'last', 'price', 'close', 'previousClose', 'mark', 'mid'].some(key => quote[key] != null && strictQuoteNumber(quote[key]) === null)) return 'invalid_numeric_value';
  const positive = (value) => strictQuoteNumber(value) !== null && strictQuoteNumber(value) > 0;
  const bid = positive(quote.bid), ask = positive(quote.ask);
  if (bid && ask && Number(quote.bid) > Number(quote.ask)) return 'crossed_book';
  if (!(positive(quote.last ?? quote.price) || (bid && ask))) return 'invalid_mark';
  return null;
}

module.exports = { strictQuoteNumber, ibkrObservationFailure, MAX_AGE_MS, MAX_FUTURE_SKEW_MS };
