/**
 * @param {object} raw - IBKR sidecar position row
 * @param {object} [marketQuote] - optional normalized quote for market value
 */
function normalizeIbkrPosition(raw, marketQuote = null) {
  const conid = raw.conId ?? raw.conid ?? null;
  const accountId = raw.account || '';
  const quantity = Number(raw.position) || 0;
  const avgCost = Number(raw.avgCost) || 0;
  const mark = marketQuote?.mark ?? null;
  const marketValue =
    raw.marketValue != null
      ? Number(raw.marketValue)
      : mark != null
        ? quantity * mark
        : null;

  return {
    positionId: conid ? `${accountId}#${conid}` : `${accountId}#${raw.symbol}`,
    symbol: raw.symbol,
    conid,
    accountId,
    description: raw.localSymbol || raw.symbol,
    quantity,
    avgCost,
    price: mark,
    marketValue,
    costBasis: quantity * avgCost,
    gainLoss: marketValue != null ? marketValue - quantity * avgCost : null,
    gainLossPercent:
      avgCost > 0 && marketValue != null
        ? ((marketValue - quantity * avgCost) / (quantity * avgCost)) * 100
        : null,
    unrealizedPnL: raw.unrealizedPnL != null ? Number(raw.unrealizedPnL) : null,
    realizedPnL: raw.realizedPnL != null ? Number(raw.realizedPnL) : null,
    currency: raw.currency || 'USD',
    secType: raw.secType || 'STK',
    exchange: raw.exchange || null,
    assetType: raw.secType || 'STK',
    assetClass: mapSecTypeToAssetClass(raw.secType),
    positionSource: 'ibkr_api',
    priceSource: marketQuote?.source || null,
    lastUpdated: marketQuote?.timestamp || raw.fetched_at || null,
    warning: marketQuote?.warning || null,
  };
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

module.exports = { normalizeIbkrPosition, normalizeUploadedHolding, mapSecTypeToAssetClass };
