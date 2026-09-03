import { act, renderHook, waitFor } from '@testing-library/react';
import { CORRELATION_REFERENCE_STORAGE_KEY, useUsdCorrelations } from './useUsdCorrelations';
import { resetSessionResourceStore } from '../utils/sessionResourceStore';

jest.mock('../services/api/usdMarketService', () => ({
  USDMarketService: { getCorrelations: jest.fn() },
}));

const LIVE_RESPONSE = {
  correlations: {
    SPX: {
      '5D': 0.05,
      '15D': 0.1,
      '30D': 0.2,
      '1M': 0.25,
      '3M': 0.3,
      '6M': 0.4,
      '90D': 0.3,
      '120D': 0.4,
      '180D': 0.5,
    },
  },
  rollingStats: { SPX: { high: 0.8, low: -0.7, percentPositive: 60, percentNegative: 40 } },
  timestamp: '2026-07-13T22:00:00.000Z',
  calculationDate: '2026-07-13',
  source: 'Yahoo Finance daily bars',
  sourceStatus: 'current',
};

const FXVL_SNAPSHOT = {
  lastPx: 5.75,
  day1Ago: 6.29,
  day15Ago: 6.1,
  week1Ago: 6.47,
  week4Ago: 7.12,
  month3Ago: 5.61,
  month6Ago: 6.8,
  priorYearClose: 6.56,
  dayChangePct: -8.59,
  fifteenDayChangePct: -5.74,
  monthChangePct: -19.24,
  threeMonthChangePct: 2.42,
  sixMonthChangePct: -15.44,
  ytdChangePct: -12.31,
  availability: 'available',
  freshness: 'current',
  quoteMode: 'delayed',
  source: 'cme',
  asOf: '2026-07-14T19:59:46.000Z',
};

describe('useUsdCorrelations', () => {
  beforeEach(() => {
    resetSessionResourceStore();
    window.sessionStorage?.clear();
  });

  afterEach(() => {
    resetSessionResourceStore();
    window.sessionStorage?.clear();
  });

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

  test('hydrates the normalized correlation view from the raw persisted provider payload', async () => {
    window.sessionStorage.setItem(CORRELATION_REFERENCE_STORAGE_KEY, JSON.stringify({
      schemaVersion: 1,
      resourceKey: 'usd-correlations',
      scopeKey: 'dashboard',
      observedAt: LIVE_RESPONSE.timestamp,
      persistedAt: new Date().toISOString(),
      data: LIVE_RESPONSE,
    }));
    let resolveRequest;
    const service = {
      getCorrelations: jest.fn(() => new Promise((resolve) => { resolveRequest = resolve; })),
    };
    const { result, unmount } = renderHook(() => useUsdCorrelations({
      service,
      retryDelaysMs: [10000],
      failurePollMs: 10000,
      successPollMs: 10000,
    }));

    expect(result.current.correlations).toEqual(LIVE_RESPONSE.correlations);
    expect(result.current.rollingStats).toEqual(LIVE_RESPONSE.rollingStats);
    expect(result.current.refreshing).toBe(true);

    await waitFor(() => expect(service.getCorrelations).toHaveBeenCalled());
    resolveRequest(LIVE_RESPONSE);
    await waitFor(() => expect(result.current.error).toBeNull());
    unmount();
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

  test('preserves an optional verified FXVL snapshot from the API contract', async () => {
    const service = {
      getCorrelations: jest.fn().mockResolvedValue({
        ...LIVE_RESPONSE,
        fxvlSnapshot: FXVL_SNAPSHOT,
      }),
    };
    const retryDelaysMs = [10000];
    const { result } = renderHook(() => useUsdCorrelations({
      service,
      retryDelaysMs,
      failurePollMs: 10000,
      successPollMs: 10000,
    }));

    await waitFor(() => expect(result.current.fxvlSnapshot).toEqual(FXVL_SNAPSHOT));
  });

  test('retains the dated snapshot when a scheduled refresh fails', async () => {
    const service = {
      getCorrelations: jest.fn()
        .mockResolvedValueOnce({ ...LIVE_RESPONSE, fxvlSnapshot: FXVL_SNAPSHOT })
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
    expect(result.current.correlations).toEqual(LIVE_RESPONSE.correlations);
    expect(result.current.rollingStats).toEqual(LIVE_RESPONSE.rollingStats);
    expect(result.current.fxvlSnapshot).toEqual(FXVL_SNAPSHOT);
    expect(result.current.availability).toBe('refresh-delayed');
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
