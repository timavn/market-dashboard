const UNAVAILABLE_QUOTE_SOURCES = new Set([
  'cache',
  'mock',
  'seed',
  'synthetic',
  'portfolio',
]);

const UNAVAILABLE_DATA_TYPES = new Set([
  'cache_only',
  'mock',
  'seed',
  'synthetic',
  'stale',
]);

const IBKR_MAX_QUOTE_AGE_MS = 2 * 60 * 1000;
const YAHOO_MAX_QUOTE_AGE_MS = 4 * 24 * 60 * 60 * 1000;
const YAHOO_CRYPTO_MAX_QUOTE_AGE_MS = 2 * 60 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const CRYPTO_SYMBOLS = new Set(['BTC', 'ETH', 'BNB', 'ADA', 'SOL', 'XRP']);

function toQuoteInstrument(index) {
  if (!index || typeof index !== 'object') return index;
  const hasExplicitDescriptor = Boolean(
    index.provider || index.secType || index.exchange || index.currency || index.conId || index.conid
  );
  if (!hasExplicitDescriptor) return index.symbol;
  return {
    symbol: index.symbol,
    secType: index.secType,
    exchange: index.exchange,
    currency: index.currency,
    conId: index.conId ?? index.conid,
    provider: index.provider,
    providerSymbol: index.providerSymbol || index.yahooSymbol,
  };
}

function hasFinitePrice(quote) {
  if (quote?.price == null || quote.price === '') return false;
  return Number.isFinite(Number(quote.price));
}

function isDeniedEntitlement(status) {
  return /(?:denied|not[_ -]?entitled|unavailable|disabled|offline)/i.test(String(status || ''));
}

/**
 * API availability enum:
 * - current: verified current provider quote (normally connected IBKR)
 * - delayed: valid provider-reported delayed quote (normally Yahoo)
 * - historical: dated non-intraday observation (FRED/Stooq)
 * - unavailable: absent, stale, cache-disconnected, synthetic, or unentitled
 */
function classifyQuoteAvailability(quote, { now = Date.now() } = {}) {
  if (!hasFinitePrice(quote)) return 'unavailable';
  const quoteTime = quote?.timestamp instanceof Date
    ? quote.timestamp.getTime()
    : Date.parse(String(quote?.timestamp || ''));
  if (!Number.isFinite(quoteTime)) return 'unavailable';

  const source = String(quote.source || '').toLowerCase();
  const dataType = String(quote.dataType || '').toLowerCase();
  const warning = String(quote.warning || '');
  const ageMs = Number(now) - quoteTime;

  if (ageMs < -MAX_FUTURE_SKEW_MS) return 'unavailable';

  if (UNAVAILABLE_QUOTE_SOURCES.has(source) || UNAVAILABLE_DATA_TYPES.has(dataType)) {
    return 'unavailable';
  }
  if (isDeniedEntitlement(quote.entitlementStatus)) return 'unavailable';
  if (source === 'ibkr' && /(?:stale_quote|cache[_ -]?disconnected|provider[_ -]?offline)/i.test(warning)) {
    return 'unavailable';
  }
  if (source === 'ibkr' && ageMs > IBKR_MAX_QUOTE_AGE_MS) return 'unavailable';
  if (
    source === 'yahoo' &&
    ageMs > (CRYPTO_SYMBOLS.has(String(quote.symbol || '').toUpperCase())
      ? YAHOO_CRYPTO_MAX_QUOTE_AGE_MS
      : YAHOO_MAX_QUOTE_AGE_MS)
  ) return 'unavailable';
  if (source === 'yahoo' || dataType === 'delayed' || dataType === 'delayed_frozen') {
    return 'delayed';
  }
  if (source === 'fred' || source === 'stooq' || dataType === 'historical') {
    return 'historical';
  }
  if (source === 'ibkr') return 'current';
  return 'unavailable';
}

function buildQuoteMetadata(quote) {
  const availability = classifyQuoteAvailability(quote);
  const usable = availability !== 'unavailable';
  const quoteAsOf = usable && quote?.timestamp
    ? new Date(quote.timestamp).toISOString()
    : null;
  return {
    availability,
    source: quote?.source || null,
    dataType: quote?.dataType || null,
    quoteAsOf,
    warning: quote?.warning || (availability === 'unavailable' ? 'quote_unavailable' : null),
    entitlementStatus: quote?.entitlementStatus || null,
    usable,
  };
}

function buildPeriodReturnsMetadata(periods) {
  const periodReturnsAsOf = periods?.asOf || null;
  const hasValues = periods && Object.entries(periods).some(
    ([key, value]) => key.endsWith('ChangePct') && Number.isFinite(value)
  );
  return {
    periodReturnsAsOf,
    periodReturnsStatus: hasValues && periodReturnsAsOf ? 'historical' : 'unavailable',
  };
}

module.exports = {
  IBKR_MAX_QUOTE_AGE_MS,
  YAHOO_CRYPTO_MAX_QUOTE_AGE_MS,
  YAHOO_MAX_QUOTE_AGE_MS,
  toQuoteInstrument,
  classifyQuoteAvailability,
  buildQuoteMetadata,
  buildPeriodReturnsMetadata,
};
