import { useState, useEffect, useCallback, useMemo } from 'react';
import { MarketDataService } from '../services/api/marketDataService';
import { SECURITY_INTELLIGENCE_V2_ENABLED } from './useSecurityIntelligence';
import {
  enrichSecurity,
  resolveSecuritiesListEntry,
  buildTradingDays,
  getTradingDayKeys,
} from '../utils/enrichSecurity';
import {
  getCanonicalProduct,
  getCanonicalRiskRange,
  isCanonicalSecurityIntelligence,
} from '../utils/securityIntelligenceV2';

export function useEnrichedSecurity(symbol) {
  const [security, setSecurity] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const tradingDays = useMemo(() => buildTradingDays(), []);
  const tradingDayKeys = useMemo(() => getTradingDayKeys(tradingDays), [tradingDays]);

  const listEntry = useMemo(
    () => (symbol ? resolveSecuritiesListEntry(symbol) : null),
    [symbol],
  );

  const load = useCallback(async () => {
    if (!symbol || !listEntry) {
      setSecurity(null);
      setLoading(false);
      setError(null);
      return;
    }

    const ticker = listEntry.ticker;
    setLoading(true);
    setError(null);
    if (SECURITY_INTELLIGENCE_V2_ENABLED) setSecurity(null);

    try {
      const canonicalRequest = SECURITY_INTELLIGENCE_V2_ENABLED
        ? MarketDataService.getSecurityIntelligenceV2({
          symbols: [ticker],
          historyDays: 5,
        })
        : Promise.resolve(null);
      const [quotes, historyResult, riskHistory, canonical] = await Promise.all([
        MarketDataService.getQuotes([ticker]).catch(() => ({})),
        MarketDataService.getHistoricalData(ticker, 30).catch(() => null),
        MarketDataService.getRiskRangeHistory(ticker, 30).catch(() => []),
        canonicalRequest,
      ]);

      const tickerUpper = ticker.toUpperCase();
      const quote =
        quotes?.[tickerUpper] || quotes?.[ticker] || quotes?.[ticker.toUpperCase()] || null;

      const history =
        historyResult?.data && Array.isArray(historyResult.data)
          ? historyResult.data
          : Array.isArray(historyResult)
            ? historyResult
            : [];

      const riskItems = Array.isArray(riskHistory) ? riskHistory : [];
      const canonicalSecurity = isCanonicalSecurityIntelligence(canonical)
        ? canonical.bySymbol?.[tickerUpper]
        : null;
      const canonicalRange = getCanonicalRiskRange(canonicalSecurity, { primaryOnly: true });
      if (canonicalRange) {
        const existingIndex = riskItems.findIndex((item) => item?.date === canonicalRange.date);
        const currentRiskItem = {
          ...(existingIndex >= 0 ? riskItems[existingIndex] : {}),
          date: canonicalRange.date,
          lrr: canonicalRange.lrr,
          hrr: canonicalRange.hrr,
          trend: canonicalRange.trend,
          timestamp: canonicalRange.timestamp,
        };
        if (existingIndex >= 0) riskItems[existingIndex] = currentRiskItem;
        else riskItems.push(currentRiskItem);
      }

      const enriched = enrichSecurity(listEntry, {
        quote,
        history,
        riskHistoryItems: riskItems,
        tradingDayKeys,
      });

      setSecurity({
        ...enriched,
        securityIntelligence: canonicalSecurity,
        securityIntelligenceHealth: canonicalSecurity?.health || null,
        securityIntelligenceStatus: getCanonicalProduct(canonicalSecurity, 'risk-ranges')?.status || null,
      });
    } catch (err) {
      console.error(`[useEnrichedSecurity] ${ticker}:`, err);
      setError(err.message || 'Failed to load security metrics');
      setSecurity(null);
    } finally {
      setLoading(false);
    }
  }, [symbol, listEntry, tradingDayKeys]);

  useEffect(() => {
    load();
  }, [load]);

  return {
    security,
    loading,
    error,
    refresh: load,
    tradingDays,
    listEntry,
    hasListEntry: Boolean(listEntry),
  };
}

export default useEnrichedSecurity;
