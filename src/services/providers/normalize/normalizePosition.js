/**
 * @param {object} raw - IBKR sidecar position row
 * @param {object} [marketQuote] - validated broker-native live/reference mark
 */
function normalizeIbkrPosition(raw, marketQuote = null) {
  const conid = raw.conId ?? raw.conid ?? null;
  const accountId = raw.account || '';
  const quantityValue = raw.position == null || raw.position === '' ? null : Number(raw.position);
  const avgCostValue = raw.avgCost == null || raw.avgCost === '' ? null : Number(raw.avgCost);
  const quantity = Number.isFinite(quantityValue) ? quantityValue : null;
  const avgCost = Number.isFinite(avgCostValue) ? avgCostValue : null;
  const isPredictionMarket = isPredictionMarketContract(raw);
  const marketQuoteValue =
    marketQuote?.mark == null || marketQuote?.mark === ''
      ? null
      : Number(marketQuote.mark);
  const mark = Number.isFinite(marketQuoteValue) ? marketQuoteValue : null;
  const rawMarketValue =
    raw.marketValue != null && Number.isFinite(Number(raw.marketValue))
      ? Number(raw.marketValue)
      : null;
  const derivedMark =
    mark != null
      ? mark
      : rawMarketValue != null && quantity != null && quantity !== 0
        ? Math.abs(rawMarketValue / quantity)
        : null;
  const marketValue =
    rawMarketValue != null
      ? rawMarketValue
      : derivedMark != null
        ? quantity != null ? quantity * derivedMark : null
        : null;
  const costBasis = quantity != null && avgCost != null ? quantity * avgCost : null;
  const gainLoss =
    raw.unrealizedPnL != null && Number.isFinite(Number(raw.unrealizedPnL))
      ? Number(raw.unrealizedPnL)
      : marketValue != null && costBasis != null
        ? marketValue - costBasis
        : null;
  const priceState =
    derivedMark == null
      ? 'unavailable'
      : marketQuote?.priceState || 'unavailable';
  const priceSource =
    marketQuote?.priceSource
    || marketQuote?.source
    || (rawMarketValue != null ? 'ibkr_portfolio' : null);
  const priceObservedAt =
    marketQuote?.priceObservedAt
    || marketQuote?.timestamp
    || raw.mark_observed_at
    || raw.updated_at
    || raw.fetched_at
    || null;
  const referenceCloseValue =
    marketQuote?.referenceClose == null || marketQuote?.referenceClose === ''
      ? null
      : Number(marketQuote.referenceClose);
  const previousCloseValue =
    marketQuote?.previousClose == null || marketQuote?.previousClose === ''
      ? null
      : Number(marketQuote.previousClose);
  const referenceClose =
    Number.isFinite(referenceCloseValue) ? referenceCloseValue : null;
  const previousClose =
    Number.isFinite(previousCloseValue) ? previousCloseValue : null;
  let dayPriceChange = null;
  let dayChangeState = null;
  let dayChangeSessionDate = null;
  if (priceState === 'live' && derivedMark != null && referenceClose != null) {
    dayPriceChange = derivedMark - referenceClose;
    dayChangeState = 'live_vs_reference_close';
    dayChangeSessionDate = marketQuote?.referenceCloseSessionDate || null;
  } else if (
    priceState === 'historical_close'
    && referenceClose != null
    && previousClose != null
  ) {
    dayPriceChange = referenceClose - previousClose;
    dayChangeState = 'historical_session';
    dayChangeSessionDate = marketQuote?.referenceCloseSessionDate || null;
  }
  const dayGainLoss =
    dayPriceChange != null && quantity != null
      ? quantity * dayPriceChange
      : null;
  const comparisonClose =
    priceState === 'live' ? referenceClose : previousClose;
  const dayChangePercent =
    dayGainLoss != null
    && quantity != null
    && quantity !== 0
    && comparisonClose != null
    && comparisonClose !== 0
      ? (dayGainLoss / Math.abs(quantity * comparisonClose)) * 100
      : null;
  const warning =
    marketQuote?.warning ||
    (quantity != null && quantity !== 0 && marketValue == null && !isPredictionMarket ? 'missing_market_value' : null);
  const markPending = marketQuote?.warming === true;
  const markWarmState =
    markPending
      ? 'warming'
      : marketQuote?.failure
        ? 'degraded'
        : derivedMark != null
          ? 'complete'
          : 'unavailable';

  return {
    positionId: conid ? `${accountId}#${conid}` : `${accountId}#${raw.symbol}`,
    symbol: raw.symbol,
    conid,
    accountId,
    description: raw.localSymbol || raw.symbol,
    quantity,
    avgCost,
    price: derivedMark,
    priceState,
    marketValueState: priceState,
    markPending,
    markWarmState,
    priceSource,
    priceObservedAt,
    priceSessionDate:
      priceState === 'historical_close'
        ? marketQuote?.priceSessionDate || null
        : null,
    marketValue,
    costBasis,
    gainLoss,
    gainLossPercent:
      costBasis != null && costBasis !== 0 && gainLoss != null
        ? (gainLoss / Math.abs(costBasis)) * 100
        : null,
    unrealizedPnL: raw.unrealizedPnL != null ? Number(raw.unrealizedPnL) : null,
    realizedPnL: raw.realizedPnL != null ? Number(raw.realizedPnL) : null,
    referenceClose,
    referenceCloseSource:
      referenceClose != null ? marketQuote?.referenceCloseSource || null : null,
    referenceCloseSessionDate:
      referenceClose != null ? marketQuote?.referenceCloseSessionDate || null : null,
    referenceCloseObservedAt:
      referenceClose != null ? marketQuote?.referenceCloseObservedAt || null : null,
    referenceCloseCacheState:
      referenceClose != null ? marketQuote?.referenceCloseCacheState || null : null,
    previousClose,
    previousCloseSessionDate:
      previousClose != null ? marketQuote?.previousCloseSessionDate || null : null,
    dayPriceChange,
    dayChange: dayGainLoss,
    dayGainLoss,
    dayChangePercent,
    dayChangeState,
    dayChangeSessionDate,
    currency: raw.currency || 'USD',
    secType: raw.secType || 'STK',
    exchange: raw.exchange || null,
    assetType: raw.secType || 'STK',
    assetClass: isPredictionMarket ? 'Prediction Markets' : mapSecTypeToAssetClass(raw.secType),
    isPredictionMarket,
    positionSource: 'ibkr_api',
    lastUpdated: priceObservedAt,
    markFailure: marketQuote?.failure || null,
    warning,
  };
}

function isPredictionMarketContract(raw = {}) {
  const text = [
    raw.symbol,
    raw.localSymbol,
    raw.description,
    raw.tradingClass,
    raw.contractMonth,
  ]
    .filter(Boolean)
    .join(' ')
    .toUpperCase();
  const secType = String(raw.secType || '').toUpperCase();
  const exchange = String(raw.exchange || raw.primaryExchange || '').toUpperCase();

  return (
    secType === 'EVENT' ||
    exchange === 'FORECASTX' ||
    /\bKX[A-Z0-9]+\b/.test(text) ||
    /\bCPIY\b/.test(text) ||
    /(?:^|[-_ ])(?:YES|NO)(?:$|[-_ ])/.test(text)
  );
}

function mapSecTypeToAssetClass(secType) {
  const t = (secType || '').toUpperCase();
  if (t === 'STK') return 'Equities';
  if (t === 'CASH') return 'Cash';
  if (t === 'BOND' || t === 'BILL') return 'Fixed Income';
  if (t === 'OPT' || t === 'FOP' || t === 'FUT') return 'Derivatives';
  return 'Other';
}

/**
 * Uploaded statement holding from DynamoDB.
 */
function normalizeUploadedHolding(holding, snapshotId) {
  return {
    positionId: `${snapshotId}#${holding.symbol}`,
    symbol: holding.symbol,
    conid: holding.conid || null,
    accountId: null,
    description: holding.description || '',
    quantity: holding.quantity || 0,
    avgCost: holding.costBasis && holding.quantity ? holding.costBasis / holding.quantity : 0,
    price: holding.price || 0,
    priceState: 'unavailable',
    marketValueState: 'unavailable',
    markPending: false,
    markWarmState: 'unavailable',
    priceObservedAt: null,
    priceSessionDate: null,
    marketValue: holding.marketValue || 0,
    costBasis: holding.costBasis || 0,
    gainLoss: holding.gainLoss || 0,
    gainLossPercent: holding.gainLossPercent || 0,
    currency: 'USD',
    secType: holding.assetType || 'STK',
    exchange: null,
    assetType: holding.assetType || '',
    assetClass: holding.assetClass || 'Other',
    positionSource: 'uploaded_statement',
    priceSource: 'uploaded_statement',
    referenceClose: null,
    referenceCloseSource: null,
    referenceCloseSessionDate: null,
    referenceCloseObservedAt: null,
    referenceCloseCacheState: null,
    previousClose: null,
    previousCloseSessionDate: null,
    dayPriceChange: null,
    dayChange: null,
    dayGainLoss: null,
    dayChangePercent: null,
    dayChangeState: null,
    dayChangeSessionDate: null,
    lastUpdated: null,
    markFailure: null,
    warning: null,
  };
}

module.exports = {
  normalizeIbkrPosition,
  normalizeUploadedHolding,
  mapSecTypeToAssetClass,
  isPredictionMarketContract,
};
