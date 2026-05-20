import { useState, useEffect, useCallback, useMemo } from 'react';
import { MarketDataService } from '../services/api/marketDataService';
import {
  enrichSecurity,
  resolveSecuritiesListEntry,
  buildTradingDays,
  getTradingDayKeys,
} from '../utils/enrichSecurity';

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

    try {
      const [quotes, historyResult, riskHistory] = await Promise.all([
        MarketDataService.getQuotes([ticker]).catch(() => ({})),
        MarketDataService.getHistoricalData(ticker, 30).catch(() => null),
        MarketDataService.getRiskRangeHistory(ticker, 30).catch(() => []),
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

      const enriched = enrichSecurity(listEntry, {
        quote,
        history,
        riskHistoryItems: riskItems,
        tradingDayKeys,
      });

      setSecurity(enriched);
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
