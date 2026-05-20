/**
 * Map canonical quote to legacy API shape used by dashboard components.
 * @param {import('./normalizeQuote').normalizeQuote extends Function ? ReturnType<import('./normalizeQuote').normalizeQuote> : object} canonical
 */
function toLegacyQuote(canonical) {
  if (!canonical || !canonical.valid) {
    return null;
  }
  const mark = canonical.mark;
  const close = canonical.close ?? mark;
  const change = close != null && mark != null ? mark - close : 0;
  const changePercent = close > 0 ? (change / close) * 100 : 0;

  return {
    symbol: canonical.symbol,
    price: mark.toFixed(2),
    change: change.toFixed(2),
    changePercent: changePercent.toFixed(2),
    previousClose: close != null ? close.toFixed(2) : mark.toFixed(2),
    timestamp: canonical.timestamp,
    source: canonical.source,
    mark: canonical.mark,
    mid: canonical.mid,
    conid: canonical.conid,
    dataType: canonical.dataType,
    warning: canonical.warning,
    bid: canonical.bid,
    ask: canonical.ask,
    last: canonical.last,
    currency: canonical.currency,
    exchange: canonical.exchange,
    entitlementStatus: canonical.entitlementStatus,
  };
}

module.exports = { toLegacyQuote };
