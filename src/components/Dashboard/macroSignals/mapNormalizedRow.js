import { GROUP_TO_ASSET_CLASS } from './constants';
import {
  resolveReferencePrice,
  computeRiskRangePercents,
} from '../../../utils/riskRangePercents';

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
  const trendForSide = row.riskTrend;
  const side = isLongTrend(trendForSide) ? 'long' : isShortTrend(trendForSide) ? 'short' : null;

  // Trade and Trend are independent published inputs. Missing tracker or
  // risk-range directions remain missing and are never copied from one another.
  const trade = trackerToTrade(row.trackerTrend);
  const trend = riskToUiTrend(row.riskTrend);

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
  const spot = row.price != null && Number.isFinite(Number(row.price)) ? Number(row.price) : null;
  const prevClose =
    row.prevClose != null && Number.isFinite(Number(row.prevClose))
      ? Number(row.prevClose)
      : null;

  const referencePrice = resolveReferencePrice({
    spot,
    previousClose: prevClose,
    source: row.quoteSource,
  });

  const percents =
    referencePrice != null && forecastLow != null && forecastHigh != null
      ? computeRiskRangePercents(referencePrice, forecastLow, forecastHigh)
      : null;

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
    spotPrice: referencePrice,
    referencePrice,
    upsidePct: percents?.upsidePct ?? null,
    downsidePct: percents?.downsidePct ?? null,
    score: Number(row.score) || 0,
    canonical: row,
  };
}

export function mapNormalizedRows(rows) {
  return rows.map(mapNormalizedRowToMacroSignal);
}
