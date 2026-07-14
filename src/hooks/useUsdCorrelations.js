import { useCallback, useEffect, useState } from 'react';
import { USDMarketService } from '../services/api/usdMarketService';
import { REFRESH_INTERVALS } from '../constants/usdMarket';

export const CORRELATION_RETRY_DELAYS_MS = [2000, 5000, 15000, 60000];
export const CORRELATION_FAILURE_POLL_MS = 5 * 60 * 1000;

export const EMPTY_CORRELATION_DATA = Object.freeze({
  correlations: null,
  rollingStats: null,
  correlationsTimestamp: null,
  calculationDate: null,
});

function unavailableMessage(error) {
  return error?.response?.data?.error
    || error?.message
    || 'Current USD correlation data is unavailable';
}

function validateCorrelationResponse(data) {
  if (
    data?.sourceStatus !== 'current'
    || !data?.correlations
    || !data?.rollingStats
    || !data?.timestamp
    || !data?.calculationDate
  ) {
    throw new Error(data?.error || 'Current USD correlation data is unavailable');
  }
  return {
    correlations: data.correlations,
    rollingStats: data.rollingStats,
    correlationsTimestamp: data.timestamp,
    calculationDate: data.calculationDate,
  };
}

export function useUsdCorrelations({
  service = USDMarketService,
  retryDelaysMs = CORRELATION_RETRY_DELAYS_MS,
  failurePollMs = CORRELATION_FAILURE_POLL_MS,
  successPollMs = REFRESH_INTERVALS.CORRELATIONS,
} = {}) {
  const [data, setData] = useState(EMPTY_CORRELATION_DATA);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [retryGeneration, setRetryGeneration] = useState(0);

  const retry = useCallback(() => {
    setRetryGeneration((value) => value + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer = null;
    let failureCount = 0;

    const schedule = (callback, delay) => {
      timer = setTimeout(callback, delay);
    };

    const fetchCorrelations = async () => {
      if (cancelled) return;
      setLoading(true);
      setError(null);
      setData(EMPTY_CORRELATION_DATA);

      try {
        const response = await service.getCorrelations();
        const nextData = validateCorrelationResponse(response);
        if (cancelled) return;
        failureCount = 0;
        setData(nextData);
        setLoading(false);
        schedule(fetchCorrelations, successPollMs);
      } catch (requestError) {
        if (cancelled) return;
        setData(EMPTY_CORRELATION_DATA);
        setError(unavailableMessage(requestError));
        setLoading(false);
        const delay = retryDelaysMs[failureCount] ?? failurePollMs;
        failureCount += 1;
        schedule(fetchCorrelations, delay);
      }
    };

    fetchCorrelations();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [failurePollMs, retryDelaysMs, retryGeneration, service, successPollMs]);

  return { ...data, loading, error, retry };
}

export default useUsdCorrelations;
