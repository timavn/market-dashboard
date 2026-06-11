import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MarketDataService } from '../services/api/marketDataService';

const { buildCorrelationRequestSignature } = require('../utils/portfolioCorrelationConcentration');

export const PORTFOLIO_CORRELATION_WINDOWS = [30, 90, 180];
export const PORTFOLIO_CORRELATION_PRIMARY_WINDOW = 90;

function buildCorrelationPayloadHoldings(holdings = []) {
  return (Array.isArray(holdings) ? holdings : []).map((holding) => ({
    symbol: holding.symbol,
    description: holding.description || holding.name,
    marketValue: holding.marketValue,
    quantity: holding.quantity,
    assetClass: holding.assetClass,
    assetType: holding.assetType,
    secType: holding.secType || holding.securityType,
  }));
}

export function usePortfolioCorrelationConcentration({
  holdings = [],
  totalValue = null,
  enabled = true,
  windows = PORTFOLIO_CORRELATION_WINDOWS,
  primaryWindow = PORTFOLIO_CORRELATION_PRIMARY_WINDOW,
} = {}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const requestSeqRef = useRef(0);
  const forceRefreshRef = useRef(false);

  const payloadHoldings = useMemo(() => (
    buildCorrelationPayloadHoldings(holdings)
  ), [holdings]);

  const requestSignature = useMemo(() => {
    if (!enabled) return '';
    return buildCorrelationRequestSignature(payloadHoldings, totalValue);
  }, [enabled, payloadHoldings, totalValue]);

  const hasInput = Boolean(enabled && requestSignature);
  const payloadRef = useRef({ holdings: [], totalValue: 0 });
  payloadRef.current = {
    holdings: payloadHoldings,
    totalValue,
  };

  const refresh = useCallback(() => {
    if (!hasInput || loading) return;
    forceRefreshRef.current = true;
    setRefreshNonce((current) => current + 1);
  }, [hasInput, loading]);

  useEffect(() => {
    if (!hasInput) {
      setData(null);
      setError(null);
      setLoading(false);
      return undefined;
    }

    const controller = new AbortController();
    const requestSeq = requestSeqRef.current + 1;
    requestSeqRef.current = requestSeq;
    const forceRefresh = forceRefreshRef.current;
    forceRefreshRef.current = false;

    const request = async () => {
      setLoading(true);
      setError(null);
      try {
        const payload = payloadRef.current;
        const result = await MarketDataService.getPortfolioCorrelationConcentration({
          holdings: payload.holdings,
          totalValue: payload.totalValue,
          windows,
          primaryWindow,
          signal: controller.signal,
          forceRefresh,
        });
        if (requestSeqRef.current === requestSeq) {
          setData(result);
        }
      } catch (requestError) {
        if (requestError?.code === 'ERR_CANCELED' || requestError?.name === 'CanceledError') {
          return;
        }
        if (requestSeqRef.current === requestSeq) {
          setError(requestError.message || 'Failed to calculate correlation concentration');
        }
      } finally {
        if (requestSeqRef.current === requestSeq) {
          setLoading(false);
        }
      }
    };

    request();

    return () => {
      controller.abort();
    };
  }, [hasInput, primaryWindow, refreshNonce, requestSignature, windows]);

  return {
    data,
    loading,
    error,
    hasInput,
    refresh,
    requestSignature,
  };
}
