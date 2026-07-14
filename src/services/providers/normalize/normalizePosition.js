/**
 * @param {object} raw - IBKR sidecar position row
 * @param {object} [marketQuote] - optional normalized quote for market value
 */
function normalizeIbkrPosition(raw, marketQuote = null) {
  const conid = raw.conId ?? raw.conid ?? null;
  const accountId = raw.account || '';
  const quantity = Number(raw.position) || 0;
  const avgCost = Number(raw.avgCost) || 0;
  const isPredictionMarket = isPredictionMarketContract(raw);
  const mark = marketQuote?.mark ?? null;
  const rawMarketValue =
    raw.marketValue != null && Number.isFinite(Number(raw.marketValue))
      ? Number(raw.marketValue)
      : null;
  const derivedMark =
    mark != null
      ? mark
      : rawMarketValue != null && quantity !== 0
        ? Math.abs(rawMarketValue / quantity)
        : null;
  const marketValue =
    rawMarketValue != null
      ? rawMarketValue
      : derivedMark != null
        ? quantity * derivedMark
        : null;
  const costBasis = quantity * avgCost;
  const gainLoss =
    raw.unrealizedPnL != null && Number.isFinite(Number(raw.unrealizedPnL))
      ? Number(raw.unrealizedPnL)
      : marketValue != null
        ? marketValue - costBasis
        : null;
  const warning =
    marketQuote?.warning ||
    (quantity !== 0 && marketValue == null && !isPredictionMarket ? 'missing_market_value' : null);

  return {
    positionId: conid ? `${accountId}#${conid}` : `${accountId}#${raw.symbol}`,
    symbol: raw.symbol,
    conid,
    accountId,
    description: raw.localSymbol || raw.symbol,
    quantity,
    avgCost,
    price: derivedMark,
    marketValue,
    costBasis,
    gainLoss,
    gainLossPercent:
      costBasis !== 0 && gainLoss != null
        ? (gainLoss / Math.abs(costBasis)) * 100
        : null,
    unrealizedPnL: raw.unrealizedPnL != null ? Number(raw.unrealizedPnL) : null,
    realizedPnL: raw.realizedPnL != null ? Number(raw.realizedPnL) : null,
    currency: raw.currency || 'USD',
    secType: raw.secType || 'STK',
    exchange: raw.exchange || null,
    assetType: raw.secType || 'STK',
    assetClass: isPredictionMarket ? 'Prediction Markets' : mapSecTypeToAssetClass(raw.secType),
    isPredictionMarket,
    positionSource: 'ibkr_api',
    priceSource: marketQuote?.source || (rawMarketValue != null ? 'ibkr_portfolio' : null),
    lastUpdated: marketQuote?.timestamp || raw.updated_at || raw.fetched_at || null,
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

  return (
    secType === 'EVENT' ||
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
    lastUpdated: null,
    warning: null,
  };
}

module.exports = {
  normalizeIbkrPosition,
  normalizeUploadedHolding,
  mapSecTypeToAssetClass,
  isPredictionMarketContract,
};
