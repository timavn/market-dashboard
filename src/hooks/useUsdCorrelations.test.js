import { act, renderHook, waitFor } from '@testing-library/react';
import { useUsdCorrelations } from './useUsdCorrelations';

jest.mock('../services/api/usdMarketService', () => ({
  USDMarketService: { getCorrelations: jest.fn() },
}));

const LIVE_RESPONSE = {
  correlations: { SPX: { '15D': 0.1, '30D': 0.2, '90D': 0.3, '120D': 0.4, '180D': 0.5 } },
  rollingStats: { SPX: { high: 0.8, low: -0.7, percentPositive: 60, percentNegative: 40 } },
  timestamp: '2026-07-13T22:00:00.000Z',
  calculationDate: '2026-07-13',
  source: 'Yahoo Finance daily bars',
  sourceStatus: 'current',
};

describe('useUsdCorrelations', () => {
  test('recovers automatically when the API is unavailable during startup', async () => {
    const service = {
      getCorrelations: jest.fn()
        .mockRejectedValueOnce(new Error('Network Error'))
        .mockResolvedValueOnce(LIVE_RESPONSE),
    };
    const retryDelaysMs = [100];
    const { result } = renderHook(() => useUsdCorrelations({
      service,
      retryDelaysMs,
      failurePollMs: 10000,
      successPollMs: 10000,
    }));

    await waitFor(() => expect(result.current.error).toBe('Network Error'));
    await waitFor(() => expect(result.current.correlations).toEqual(LIVE_RESPONSE.correlations));
    expect(service.getCorrelations).toHaveBeenCalledTimes(2);
    expect(result.current.error).toBeNull();
  });

  test('manual retry immediately starts a new request', async () => {
    const service = {
      getCorrelations: jest.fn()
        .mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValueOnce(LIVE_RESPONSE),
    };
    const retryDelaysMs = [10000];
    const { result } = renderHook(() => useUsdCorrelations({
      service,
      retryDelaysMs,
      failurePollMs: 10000,
      successPollMs: 10000,
    }));

    await waitFor(() => expect(result.current.error).toBe('offline'));
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.correlations).toEqual(LIVE_RESPONSE.correlations));
    expect(service.getCorrelations).toHaveBeenCalledTimes(2);
  });

  test('clears verified rows when a scheduled refresh fails', async () => {
    const service = {
      getCorrelations: jest.fn()
        .mockResolvedValueOnce(LIVE_RESPONSE)
        .mockRejectedValueOnce(new Error('provider unavailable')),
    };
    const retryDelaysMs = [10000];
    const { result } = renderHook(() => useUsdCorrelations({
      service,
      retryDelaysMs,
      failurePollMs: 10000,
      successPollMs: 100,
    }));

    await waitFor(() => expect(result.current.correlations).toEqual(LIVE_RESPONSE.correlations));
    await waitFor(() => expect(result.current.error).toBe('provider unavailable'));
    expect(result.current.correlations).toBeNull();
    expect(result.current.rollingStats).toBeNull();
  });

  test('rejects responses that are not explicitly current', async () => {
    const service = {
      getCorrelations: jest.fn().mockResolvedValue({ ...LIVE_RESPONSE, sourceStatus: 'stale' }),
    };
    const retryDelaysMs = [10000];
    const { result } = renderHook(() => useUsdCorrelations({
      service,
      retryDelaysMs,
      failurePollMs: 10000,
      successPollMs: 10000,
    }));

    await waitFor(() => expect(result.current.error).toMatch(/unavailable/i));
    expect(result.current.correlations).toBeNull();
  });
});
