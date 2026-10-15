const { validateQuoteObservation } = require('./quoteContract.cjs');

/**
 * Map canonical quote to legacy API shape used by dashboard components.
 * @param {import('./normalizeQuote').normalizeQuote extends Function ? ReturnType<import('./normalizeQuote').normalizeQuote> : object} canonical
 */
function toLegacyQuote(canonical) {
  if (!canonical || !canonical.valid || (canonical.observation && !validateQuoteObservation(canonical).valid)) {
    return null;
  }
  const mark = canonical.mark;
  const close = canonical.close;
  const change = close != null && mark != null ? mark - close : null;
  const changePercent = close > 0 && change != null ? (change / close) * 100 : null;
  const priceText = (value) => value == null ? null
    : canonical.secType === 'CRYPTO' ? String(value) : value.toFixed(2);

  return {
    symbol: canonical.symbol,
    price: priceText(mark),
    change: priceText(change),
    changePercent: changePercent == null ? null : changePercent.toFixed(2),
    previousClose: priceText(close),
    connectionGeneration: canonical.connectionGeneration,
    accountId: canonical.accountId,
    providerSymbol: canonical.providerSymbol,
    providerRootSymbol: canonical.providerRootSymbol,
    lastTradeDateOrContractMonth: canonical.lastTradeDateOrContractMonth,
    tradingClass: canonical.tradingClass,
    multiplier: canonical.multiplier,
    secType: canonical.secType,
    observedAt: canonical.observedAt,
    receivedAt: canonical.receivedAt,
    expiresAt: canonical.expiresAt,
    observation: canonical.observation,
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
