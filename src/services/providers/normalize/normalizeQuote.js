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
  const bid = raw.bid != null ? Number(raw.bid) : null;
  const ask = raw.ask != null ? Number(raw.ask) : null;
  const last = raw.last != null ? Number(raw.last) : raw.price != null ? Number(raw.price) : null;
  const close =
    raw.close != null
      ? Number(raw.close)
      : raw.previousClose != null
        ? Number(raw.previousClose)
        : null;

  const mid = computeMid(bid, ask);
  const mark = computeMark({ mid, last, close });
  const timestamp = raw.timestamp || raw.fetched_at || new Date().toISOString();
  const stale = source === 'ibkr' && isStaleTimestamp(timestamp);
  const warnings = [...(opts.warnings || [])];
  if (stale) warnings.push('stale_quote');
  if (!isValidPositiveNumber(mark) && source === 'ibkr') {
    warnings.push('invalid_mark');
  }
  if (raw.dataType === 'delayed' || raw.dataType === 'delayed_frozen') {
    warnings.push('delayed_data');
  }

  return {
    symbol,
    providerSymbol: raw.providerSymbol || raw.localSymbol || symbol,
    conid: raw.conId ?? raw.conid ?? null,
    source,
    timestamp,
    bid: isValidPositiveNumber(bid) ? bid : null,
    ask: isValidPositiveNumber(ask) ? ask : null,
    last: isValidPositiveNumber(last) ? last : null,
    close: isValidPositiveNumber(close) ? close : null,
    mark,
    mid,
    currency: raw.currency || 'USD',
    exchange: raw.exchange || null,
    dataType: raw.dataType || (source === 'yahoo' ? 'delayed' : 'unknown'),
    entitlementStatus: raw.entitlementStatus || null,
    warning: warnings.length ? warnings.join('; ') : null,
    valid: isValidPositiveNumber(mark) && !stale,
  };
}

/**
 * Normalize Yahoo legacy fetch shape from server fetchYahooQuote.
 */
function normalizeYahooLegacy(yahooResult, symbol) {
  if (!yahooResult || !yahooResult.price) {
    return normalizeQuote({}, 'yahoo', { symbol, warnings: ['missing_yahoo_price'] });
  }
  const price = parseFloat(yahooResult.price);
  const previousClose = parseFloat(yahooResult.previousClose || yahooResult.price);
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
    },
    'ibkr',
  );
}

module.exports = { normalizeQuote, normalizeYahooLegacy, normalizeIbkrRaw };
