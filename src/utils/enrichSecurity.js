import { SECURITIES_LIST } from '../constants/securitiesList';
import { getVolatilityMetrics } from '../constants/securityCategoryMapping';
import { getFormattedQuadRanking } from './quadRankingUtils';
import {
  mapAssetClassToFactor,
  getBenchmark,
  getGicsSector,
  calculateZScore,
  calculateATR,
  calculatePriceChanges,
} from './securitiesUniverseUtils';

export const TRADING_DAY_LABELS = ['t-9', 't-8', 't-7', 't-6', 't-5', 't-4', 't-3', 't-2', 't-1', 't'];

/** Format a Date as local YYYY-MM-DD (matches DynamoDB risk-range dates). */
export function toDateKey(d) {
  if (!d) return null;
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Build the 10 visible trading-day columns (t-9 .. t), anchored on latest business day. */
export function buildTradingDays(count = 10) {
  const days = [];
  const currentDate = new Date();
  while (days.length < count) {
    const dayOfWeek = currentDate.getDay();
    if (dayOfWeek !== 0 && dayOfWeek !== 6) {
      days.unshift(new Date(currentDate));
    }
    currentDate.setDate(currentDate.getDate() - 1);
  }
  return days;
}

export function getTradingDayKeys(tradingDays = buildTradingDays()) {
  return tradingDays.map(toDateKey);
}

/** Case-insensitive lookup in SECURITIES_LIST. */
export function resolveSecuritiesListEntry(symbol) {
  if (!symbol) return null;
  const upper = String(symbol).toUpperCase();
  return (
    SECURITIES_LIST.find(
      s => s.ticker === symbol || s.ticker.toUpperCase() === upper,
    ) || null
  );
}

/**
 * Enrich a base security record with live quotes, history, and risk-range alignment.
 * @param {object} security - Entry from SECURITIES_LIST
 * @param {{ quote?: object, history?: array, riskHistoryItems?: array, tradingDayKeys?: string[] }} sources
 */
export function enrichSecurity(security, sources = {}) {
  const { quote, history = [], riskHistoryItems = [], tradingDayKeys = getTradingDayKeys() } =
    sources;

  const tickerUpper = security.ticker.toUpperCase();
  const currentPrice = quote?.price ?? quote?.close ?? null;
  const priceTimestamp = quote?.timestamp ?? null;

  const priceValues = Array.isArray(history)
    ? history.map(item => parseFloat(item.close || item.price || 0)).filter(p => p > 0)
    : [];

  const zScore =
    currentPrice && priceValues.length >= 20
      ? calculateZScore(currentPrice, priceValues, 20)
      : null;

  const priceChanges =
    currentPrice && history.length > 0 && Array.isArray(history)
      ? calculatePriceChanges(currentPrice, history)
      : { '1D': null, '1W': null, '1M': null };

  const factorExposure = mapAssetClassToFactor(
    security.assetClass,
    security.ticker,
    security.name,
  );
  const sector = getGicsSector(security.ticker);
  const benchmark = getBenchmark(security.assetClass, security.ticker);
  const quadRanking = getFormattedQuadRanking(security.ticker);

  const byDate = new Map();
  for (const it of riskHistoryItems) {
    if (it && it.date) byDate.set(it.date, it);
  }
  const aligned = tradingDayKeys.map(key => byDate.get(key) || null);

  let riskData = null;
  for (let i = aligned.length - 1; i >= 0; i--) {
    if (aligned[i]) {
      riskData = aligned[i];
      break;
    }
  }

  const rrPrices = aligned.map(item => (item && item.close ? item.close : null));
  if (rrPrices[rrPrices.length - 1] === null && currentPrice) {
    rrPrices[rrPrices.length - 1] = currentPrice;
  }

  const securityRiskRangeHistory = {
    hrr: aligned.map(item => (item ? item.hrr : null)),
    lrr: aligned.map(item => (item ? item.lrr : null)),
    prices: rrPrices,
    dates: aligned.map(item => (item ? item.date : null)),
    ath: 0,
    current: riskData || null,
  };

  const volMetrics = getVolatilityMetrics(security.ticker);
  const atrResult = calculateATR(history);

  return {
    ...security,
    price: currentPrice,
    priceTimestamp,
    factorExposure,
    sector,
    benchmark,
    zScore,
    priceChanges,
    priceHistory: history,
    beta: '--',
    quadRanking,
    signal: riskData?.trend || '--',
    riskRangeHistory: securityRiskRangeHistory,
    volatilityMetrics: volMetrics,
    atr: atrResult?.atr ?? null,
    atrPercent: atrResult?.atrPercent ?? null,
  };
}

/** Enrich all securities (bulk universe panel). */
export function enrichSecuritiesList(
  securities,
  { prices = {}, priceHistory = {}, riskRanges = {}, tradingDayKeys = getTradingDayKeys() } = {},
) {
  return securities.map(security => {
    const tickerUpper = security.ticker.toUpperCase();
    const quote =
      prices[tickerUpper] || prices[security.ticker] || prices[security.ticker.toUpperCase()];
    const history = priceHistory[security.ticker] || [];
    const historyItems =
      riskRanges[security.ticker] || riskRanges[security.ticker.toUpperCase()] || [];

    return enrichSecurity(security, {
      quote,
      history,
      riskHistoryItems: historyItems,
      tradingDayKeys,
    });
  });
}
