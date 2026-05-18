import { GROUP_TO_ASSET_CLASS } from './constants';

export function isLongTrend(trend) {
  return ['BULLISH', 'LONG'].includes(trend);
}

export function isShortTrend(trend) {
  return ['BEARISH', 'SHORT'].includes(trend);
}

function normalizeTrendToken(raw) {
  if (!raw) return null;
  const u = String(raw).toUpperCase().trim();
  if (u === 'BULL' || u === 'BULLISH' || u === 'LONG') return 'BULLISH';
  if (u === 'BEAR' || u === 'BEARISH' || u === 'SHORT') return 'BEARISH';
  if (u === 'NEUTRAL') return 'NEUTRAL';
  return null;
}

function riskToUiTrend(raw) {
  const t = normalizeTrendToken(raw);
  if (t === 'BULLISH') return 'bull';
  if (t === 'BEARISH') return 'bear';
  return null;
}

function trackerToTrade(raw) {
  const t = normalizeTrendToken(raw);
  if (t === 'BULLISH') return 'Buy';
  if (t === 'BEARISH') return 'Sell';
  return null;
}

export function normalizeTail(raw) {
  if (!raw) return null;
  const u = String(raw).toUpperCase().trim();
  if (u === 'LONG' || u === 'BULL' || u === 'BULLISH') return 'Long';
  if (u === 'SHORT' || u === 'BEAR' || u === 'BEARISH') return 'Short';
  if (u === 'NEUTRAL') return 'Neutral';
  return null;
}

export function mapNormalizedRowToMacroSignal(row) {
  const assetClass = GROUP_TO_ASSET_CLASS[row.group] || 'EQ';
  const side = isLongTrend(row.trend) ? 'long' : isShortTrend(row.trend) ? 'short' : null;

  let trade = trackerToTrade(row.trackerTrend);
  if (!trade && side === 'long') trade = 'Buy';
  if (!trade && side === 'short') trade = 'Sell';

  let trend = riskToUiTrend(row.riskTrend);
  if (!trend) trend = riskToUiTrend(row.trackerTrend);
  if (!trend && side === 'long') trend = 'bull';
  if (!trend && side === 'short') trend = 'bear';

  const tailRaw = normalizeTail(row.macroSide || row.callSide);

  const forecastLow =
    row.lrr != null && Number.isFinite(Number(row.lrr))
      ? Number(row.lrr)
      : row.buyTrade != null && Number.isFinite(Number(row.buyTrade))
        ? Number(row.buyTrade)
        : null;
  const forecastHigh =
    row.hrr != null && Number.isFinite(Number(row.hrr))
      ? Number(row.hrr)
      : row.sellTrade != null && Number.isFinite(Number(row.sellTrade))
        ? Number(row.sellTrade)
        : null;
  const spotPrice = row.price != null && Number.isFinite(Number(row.price)) ? Number(row.price) : null;

  return {
    id: String(row.symbol || '').toLowerCase(),
    ticker: row.symbol,
    name: row.label || row.symbol,
    assetClass,
    side,
    trade,
    trend,
    tail: tailRaw,
    forecastLow,
    forecastHigh,
    spotPrice,
    score: Number(row.score) || 0,
    canonical: row,
  };
}

export function mapNormalizedRows(rows) {
  return rows.map(mapNormalizedRowToMacroSignal);
}
