const { ibkrObservationFailure, MAX_AGE_MS } = require('./normalize/quoteObservation.cjs');
const marketBackdropCatalog = require('../../constants/marketBackdropCatalog.json');
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

const DISPLAYABLE_QUOTE_SOURCES = new Set([
  'ibkr',
  'yahoo',
  'fred',
  'stooq',
  'derived',
  'trading_economics',
  'bundesbank',
  'japan_mof',
  'bank_of_england',
]);

const IBKR_MAX_QUOTE_AGE_MS = MAX_AGE_MS;
const YAHOO_MAX_QUOTE_AGE_MS = 4 * 24 * 60 * 60 * 1000;
const YAHOO_CRYPTO_MAX_QUOTE_AGE_MS = 2 * 60 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const CRYPTO_SYMBOLS = new Set(marketBackdropCatalog
  .flatMap((group) => group.rows)
  .filter((row) => row.provider?.secType === 'CRYPTO')
  .flatMap((row) => [row.symbol, row.provider.yahooSymbol].filter(Boolean)));

function toQuoteInstrument(index) {
  if (!index || typeof index !== 'object') return index;
  const hasExplicitDescriptor = Boolean(
    index.provider
      || index.secType
      || index.exchange
      || index.currency
      || index.conId
      || index.conid
      || index.ibkrSymbol
      || index.yahooSymbol
  );
  if (!hasExplicitDescriptor) return index.symbol;
  const provider = String(index.provider || '').trim().toLowerCase();
  const providerSymbol = index.providerSymbol || undefined;
  const ibkrSymbol = index.ibkrSymbol
    || (provider === 'ibkr' ? providerSymbol : undefined);
  const yahooSymbol = index.yahooSymbol
    || (provider === 'yahoo' ? providerSymbol : undefined);
  return {
    symbol: index.symbol,
    secType: index.secType,
    exchange: index.exchange,
    currency: index.currency,
    conId: index.conId ?? index.conid,
    provider: index.provider,
    providerSymbol,
    ibkrSymbol,
    yahooSymbol,
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
  if (
    source === 'ibkr'
    && (
      dataType === 'frozen'
      || dataType === 'delayed_frozen'
      || /(?:stale_quote|close_only_reference|frozen_quote|cache[_ -]?disconnected|provider[_ -]?offline)/i.test(warning)
    )
  ) {
    return 'unavailable';
  }
  if (source === 'ibkr' && ibkrObservationFailure(quote, { now })) return 'unavailable';
  if (
    source === 'yahoo' &&
    ageMs > (CRYPTO_SYMBOLS.has(String(quote.symbol || '').toUpperCase())
      ? YAHOO_CRYPTO_MAX_QUOTE_AGE_MS
      : YAHOO_MAX_QUOTE_AGE_MS)
  ) return 'unavailable';
  if (
    source === 'yahoo'
    || source === 'trading_economics'
    || dataType === 'delayed'
    || dataType === 'delayed_frozen'
  ) {
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

/**
 * Return true only for rows that can be rendered as a verified observation in
 * the multi-region API. Missing and explicitly rejected rows stay represented
 * by the fixed client roster, but are omitted from the transport arrays.
 */
function isDisplayableQuoteRow(row) {
  if (!row || !hasFinitePrice(row)) return false;
  if (!['current', 'delayed', 'historical'].includes(String(row.availability || '').toLowerCase())) {
    return false;
  }
  const timestamp = row.timestamp || row.quoteAsOf;
  if (!Number.isFinite(Date.parse(String(timestamp || '')))) return false;
  const source = String(row.source || row.provider || '').toLowerCase();
  if (!DISPLAYABLE_QUOTE_SOURCES.has(source)) return false;
  const warning = String(row.warning || '');
  const providerWarningOnly = source === 'yahoo'
    && (
      /^ibkr\s*:/i.test(warning)
      || warning.split(';').map((part) => part.trim()).filter(Boolean).every((part) => (
        /^(?:ibkr_unavailable|yahoo_fallback|delayed_data)$/i.test(part)
      ))
    );
  if (
    /(?:offline|disconnected|cache|mock|seed|synthetic|fallback|inferred|stale|not[_ -]?entitled|unentitled)/i.test(
      [row.error, row.freshness, row.sourceStatus, warning].filter(Boolean).join(' ')
    )
    && !providerWarningOnly
  ) return false;

  // Derived curve rows have no upstream provider of their own. Their legs are
  // verified before the server marks the derived row historical.
  if (
    String(row.source || '').toLowerCase() === 'derived'
    && String(row.dataType || '').toLowerCase() === 'derived'
  ) {
    return row.availability === 'historical';
  }

  return classifyQuoteAvailability({
    symbol: row.symbol,
    price: row.price,
    source: row.source || row.provider,
    dataType: row.dataType,
    timestamp,
    warning: row.warning,
    entitlementStatus: row.entitlementStatus,
  }) !== 'unavailable';
}

module.exports = {
  IBKR_MAX_QUOTE_AGE_MS,
  YAHOO_CRYPTO_MAX_QUOTE_AGE_MS,
  YAHOO_MAX_QUOTE_AGE_MS,
  toQuoteInstrument,
  classifyQuoteAvailability,
  buildQuoteMetadata,
  buildPeriodReturnsMetadata,
  isDisplayableQuoteRow,
};
