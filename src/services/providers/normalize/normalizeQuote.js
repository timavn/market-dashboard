const { strictQuoteNumber, ibkrObservationFailure } = require('./quoteObservation.cjs');
const {
  isValidPositiveNumber,
  isStaleTimestamp,
  computeMid,
  computeMark,
} = require('./quoteValidity');

/**
 * @param {object} raw
 * @param {'ibkr'|'yahoo'|'cache'|'manual'} source
 * @param {object} [opts]
 */
function normalizeQuote(raw, source, opts = {}) {
  const symbol = (raw.symbol || opts.symbol || '').toUpperCase();
  const bid = raw.bid != null ? strictQuoteNumber(raw.bid) : null;
  const ask = raw.ask != null ? strictQuoteNumber(raw.ask) : null;
  const last = raw.last != null ? strictQuoteNumber(raw.last) : raw.price != null ? strictQuoteNumber(raw.price) : null;
  const close =
    raw.close != null
      ? strictQuoteNumber(raw.close)
      : raw.previousClose != null
        ? strictQuoteNumber(raw.previousClose)
        : null;

  const mid = computeMid(bid, ask);
  const mark = computeMark({ mid, last, close });
  // A sidecar fetch time proves only when we asked for a quote, not when IBKR
  // observed the price. Never promote that receipt time into market evidence.
  const timestamp = raw.timestamp || (source === 'ibkr' ? null : raw.fetched_at || null);
  const hasValidTimestamp = Boolean(timestamp) && Number.isFinite(new Date(timestamp).getTime());
  const stale = source === 'ibkr' && hasValidTimestamp && isStaleTimestamp(timestamp);
  const dataType = raw.dataType || (source === 'yahoo' ? 'delayed' : 'unknown');
  const normalizedDataType = String(dataType).toLowerCase();
  const closeOnlyReference = source === 'ibkr'
    && !isValidPositiveNumber(mid)
    && !isValidPositiveNumber(last)
    && isValidPositiveNumber(close);
  const frozen = source === 'ibkr'
    && (normalizedDataType === 'frozen' || normalizedDataType === 'delayed_frozen');
  const entitlementStatus = raw.entitlementStatus || null;
  const entitlementDenied = source === 'ibkr'
    && /(?:denied|not[_ -]?entitled|unavailable|disabled|offline)/i.test(String(entitlementStatus || ''));
  const observationFailure = source === 'ibkr' ? ibkrObservationFailure(raw) : null;
  const warnings = [...(opts.warnings || [])];
  if (observationFailure) warnings.push(observationFailure);
  if (closeOnlyReference) warnings.push('close_only_reference');
  if (frozen) warnings.push('frozen_quote');
  if (entitlementDenied) warnings.push('entitlement_unavailable');
  if (!hasValidTimestamp) warnings.push('missing_timestamp');
  if (stale) warnings.push('stale_quote');
  if (!isValidPositiveNumber(mark) && source === 'ibkr') {
    warnings.push('invalid_mark');
  }
  if (normalizedDataType === 'delayed' || normalizedDataType === 'delayed_frozen') {
    warnings.push('delayed_data');
  }

  return {
    symbol,
    providerSymbol: raw.providerSymbol || raw.localSymbol || symbol,
    providerRootSymbol: raw.symbol || symbol,
    lastTradeDateOrContractMonth: raw.lastTradeDateOrContractMonth || null,
    tradingClass: raw.tradingClass || null,
    multiplier: raw.multiplier || null,
    conid: raw.conId ?? raw.conid ?? null,
    secType: raw.secType || null,
    source,
    timestamp,
    bid: isValidPositiveNumber(bid) ? bid : null,
    ask: isValidPositiveNumber(ask) ? ask : null,
    last: isValidPositiveNumber(last) ? last : null,
    close: isValidPositiveNumber(close) ? close : null,
    mark,
    mid,
    currency: raw.currency || (source === 'ibkr' ? null : 'USD'),
    exchange: raw.exchange || null,
    dataType,
    entitlementStatus,
    warning: warnings.length ? warnings.join('; ') : null,
    valid: isValidPositiveNumber(mark)
      && hasValidTimestamp
      && !stale
      && !closeOnlyReference
      && !frozen
      && !entitlementDenied
      && !observationFailure,
  };
}

/**
 * Normalize Yahoo legacy fetch shape from server fetchYahooQuote.
 */
function normalizeYahooLegacy(yahooResult, symbol) {
  if (!yahooResult || !yahooResult.price) {
    return normalizeQuote({}, 'yahoo', { symbol, warnings: ['missing_yahoo_price'] });
  }
  const price = strictQuoteNumber(yahooResult.price);
  const previousClose = strictQuoteNumber(yahooResult.previousClose ?? yahooResult.price);
  return normalizeQuote(
    {
      symbol,
      last: price,
      close: previousClose,
      timestamp: yahooResult.timestamp,
      dataType: 'delayed',
    },
    'yahoo',
  );
}

/**
 * Normalize raw IBKR sidecar tick.
 */
function normalizeIbkrRaw(ibkrTick) {
  return normalizeQuote(
    {
      ...ibkrTick,
      symbol: ibkrTick.symbol,
      conId: ibkrTick.conId,
      bid: ibkrTick.bid,
      ask: ibkrTick.ask,
      last: ibkrTick.last,
      close: ibkrTick.close,
      currency: ibkrTick.currency,
      exchange: ibkrTick.exchange,
      dataType: ibkrTick.dataType,
      timestamp: ibkrTick.timestamp,
      entitlementStatus: ibkrTick.entitlementStatus,
      providerSymbol: ibkrTick.providerSymbol || ibkrTick.localSymbol,
    },
    'ibkr',
  );
}

module.exports = { normalizeQuote, normalizeYahooLegacy, normalizeIbkrRaw };
