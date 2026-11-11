import { act, renderHook, waitFor } from '@testing-library/react';
import { CORRELATION_REFERENCE_STORAGE_KEY, FX_VOLATILITY_REFERENCE_STORAGE_KEY, useUsdCorrelations } from './useUsdCorrelations';
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
const STABLE_RETRY_DELAYS_MS = [10000];

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
      retryDelaysMs: STABLE_RETRY_DELAYS_MS,
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
    expect(result.current.fxvlSnapshot).toMatchObject({
      ...FXVL_SNAPSHOT,
      availability: 'reference',
      freshness: 'refresh-delayed',
      quoteMode: 'last-verified-reference',
      lastVerifiedAt: FXVL_SNAPSHOT.asOf,
      displayOnly: true,
      executable: false,
    });
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

  test('keeps delayed FX metadata while a retry after failure is still pending', async () => {
    const service = { getCorrelations: jest.fn()
      .mockResolvedValueOnce({ ...LIVE_RESPONSE, fxvlSnapshot: FXVL_SNAPSHOT })
      .mockRejectedValueOnce(new Error('provider unavailable'))
      .mockImplementationOnce(() => new Promise(() => {})) };
    const { result } = renderHook(() => useUsdCorrelations({
      service, retryDelaysMs: STABLE_RETRY_DELAYS_MS, failurePollMs: 10000, successPollMs: 10000,
    }));
    await waitFor(() => expect(result.current.fxvlSnapshot).toEqual(FXVL_SNAPSHOT));
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.error).toBe('provider unavailable'));
    act(() => result.current.retry());
    expect(result.current.error).toBeNull();
    expect(result.current.refreshing).toBe(true);
    expect(result.current.fxvlSnapshot).toMatchObject({
      lastPx: 5.75, asOf: FXVL_SNAPSHOT.asOf, lastVerifiedAt: FXVL_SNAPSHOT.asOf,
      availability: 'reference', freshness: 'refresh-delayed',
      displayOnly: true, executable: false,
    });
  });

  test.each([
    [{}, true],
    [{ asOf: '2026-07-15T20:00:00.000Z' }, false],
    [{ source: 'yahoo' }, false],
    [{ lastPx: 6.25 }, false],
  ])('restores omitted history only for the same FX observation: %j', async (overrides, keepsHistory) => {
    const partial = { ...FXVL_SNAPSHOT, month6Ago: null, sixMonthChangePct: null, ...overrides };
    const service = { getCorrelations: jest.fn()
      .mockResolvedValueOnce({ ...LIVE_RESPONSE, fxvlSnapshot: FXVL_SNAPSHOT })
      .mockResolvedValueOnce({ ...LIVE_RESPONSE, calculationDate: '2026-07-15', fxvlSnapshot: partial }) };
    const { result } = renderHook(() => useUsdCorrelations({
      service, retryDelaysMs: STABLE_RETRY_DELAYS_MS, failurePollMs: 10000, successPollMs: 10000,
    }));
    await waitFor(() => expect(result.current.fxvlSnapshot).toEqual(FXVL_SNAPSHOT));
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.calculationDate).toBe('2026-07-15'));
    expect(result.current.fxvlSnapshot.lastPx).toBe(partial.lastPx);
    expect(result.current.fxvlSnapshot.month6Ago).toBe(keepsHistory ? FXVL_SNAPSHOT.month6Ago : null);
    expect(result.current.fxvlSnapshot.sixMonthChangePct)
      .toBe(keepsHistory ? FXVL_SNAPSHOT.sixMonthChangePct : null);
  });

  test('history restored from the stored FX reference settles instead of re-rendering forever', async () => {
    // A first session stores the complete reading under the FX reference key.
    const full = { getCorrelations: jest.fn().mockResolvedValue({ ...LIVE_RESPONSE, fxvlSnapshot: FXVL_SNAPSHOT }) };
    const view = renderHook(() => useUsdCorrelations({
      service: full, retryDelaysMs: STABLE_RETRY_DELAYS_MS, failurePollMs: 10000, successPollMs: 10000,
    }));
    await waitFor(() => expect(view.result.current.fxvlSnapshot).toEqual(FXVL_SNAPSHOT));
    view.unmount();
    expect(window.sessionStorage.getItem(FX_VOLATILITY_REFERENCE_STORAGE_KEY)).not.toBeNull();

    // After a reload the correlation snapshot is gone but the FX reference
    // remains, and the server repeats the same observation without history.
    resetSessionResourceStore();
    window.sessionStorage.removeItem(CORRELATION_REFERENCE_STORAGE_KEY);
    const partial = { ...FXVL_SNAPSHOT, month6Ago: null, sixMonthChangePct: null };
    const service = { getCorrelations: jest.fn().mockResolvedValue({ ...LIVE_RESPONSE, fxvlSnapshot: partial }) };
    let hookCalls = 0;
    const { result } = renderHook(() => {
      hookCalls += 1;
      return useUsdCorrelations({
        service, retryDelaysMs: STABLE_RETRY_DELAYS_MS, failurePollMs: 10000, successPollMs: 10000,
      });
    });
    await waitFor(() => expect(result.current.correlations).toEqual(LIVE_RESPONSE.correlations));
    await waitFor(() => expect(result.current.fxvlSnapshot?.month6Ago).toBe(FXVL_SNAPSHOT.month6Ago));
    const settledAt = hookCalls;
    await new Promise((resolve) => { setTimeout(resolve, 200); });

    // Restoring the history must not store a new object on every render.
    expect(hookCalls - settledAt).toBeLessThan(5);
    expect(result.current.fxvlSnapshot.sixMonthChangePct).toBe(FXVL_SNAPSHOT.sixMonthChangePct);
  });

  test('retains FX volatility through partial refreshes, a later reload and provider failure, then accepts recovery', async () => {
    const service = { getCorrelations: jest.fn()
      .mockResolvedValueOnce({ ...LIVE_RESPONSE, fxvlSnapshot: FXVL_SNAPSHOT })
      .mockResolvedValueOnce({ ...LIVE_RESPONSE, fxvlSnapshot: null }) };
    const options = { service, retryDelaysMs: STABLE_RETRY_DELAYS_MS, failurePollMs: 10000, successPollMs: 10000 };
    const { result: firstResult, unmount } = renderHook(() => useUsdCorrelations(options));
    await waitFor(() => expect(firstResult.current.fxvlSnapshot?.lastPx).toBe(5.75));
    act(() => firstResult.current.retry());
    await waitFor(() => expect(firstResult.current.fxvlSnapshot?.availability).toBe('reference'));
    expect(firstResult.current.fxvlSnapshot.asOf).toBe(FXVL_SNAPSHOT.asOf);
    const saved = JSON.parse(window.sessionStorage.getItem(FX_VOLATILITY_REFERENCE_STORAGE_KEY));
    saved.persistedAt = '2020-01-01T00:00:00.000Z';
    window.sessionStorage.setItem(FX_VOLATILITY_REFERENCE_STORAGE_KEY, JSON.stringify(saved));
    unmount();
    resetSessionResourceStore();
    window.sessionStorage.removeItem(CORRELATION_REFERENCE_STORAGE_KEY);

    const recovered = { ...FXVL_SNAPSHOT, lastPx: 6.25, asOf: '2026-07-15T20:00:00.000Z' };
    service.getCorrelations.mockRejectedValueOnce(new Error('provider offline'))
      .mockResolvedValueOnce({ ...LIVE_RESPONSE, fxvlSnapshot: recovered });
    const { result: restoredResult } = renderHook(() => useUsdCorrelations(options));
    expect(restoredResult.current.fxvlSnapshot).toMatchObject({
      lastPx: 5.75, asOf: FXVL_SNAPSHOT.asOf, lastVerifiedAt: FXVL_SNAPSHOT.asOf,
      availability: 'reference', displayOnly: true, executable: false,
    });
    await waitFor(() => expect(restoredResult.current.error).toBe('provider offline'));
    expect(restoredResult.current.fxvlSnapshot.lastPx).toBe(5.75);
    act(() => restoredResult.current.retry());
    await waitFor(() => expect(restoredResult.current.fxvlSnapshot).toEqual(recovered));
  });

  test.each([
    { cacheOnly: true }, { fromCache: true }, { seeded: true }, { mock: true },
    { connected: false }, { stale: true }, { providerStatus: 'offline' },
    { freshness: 'stale' }, { asOf: null }, { source: 'mock' },
  ])('rejects unverified FX observations without overwriting its last verified row: %j', async (invalid) => {
    const service = { getCorrelations: jest.fn()
      .mockResolvedValueOnce({ ...LIVE_RESPONSE, fxvlSnapshot: { ...FXVL_SNAPSHOT, ...invalid } })
      .mockResolvedValueOnce({ ...LIVE_RESPONSE, fxvlSnapshot: FXVL_SNAPSHOT })
      .mockResolvedValueOnce({ ...LIVE_RESPONSE, fxvlSnapshot: { ...FXVL_SNAPSHOT, lastPx: 999, ...invalid } }) };
    const { result } = renderHook(() => useUsdCorrelations({
      service, retryDelaysMs: STABLE_RETRY_DELAYS_MS, failurePollMs: 10000, successPollMs: 10000,
    }));
    await waitFor(() => expect(result.current.correlations).toEqual(LIVE_RESPONSE.correlations));
    expect(result.current.fxvlSnapshot).toBeNull();
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.fxvlSnapshot?.lastPx).toBe(5.75));
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.fxvlSnapshot?.availability).toBe('reference'));
    expect(result.current.fxvlSnapshot.lastPx).toBe(5.75);
  });

  test.each([
    { sourceStatus: 'stale' }, { cacheOnly: true }, { fromCache: true }, { mock: true },
    { seeded: true }, { connected: false }, { _cache: { hit: true } },
  ])('does not let rejected correlation envelopes replace verified FX readings: %j', async (invalid) => {
    const service = { getCorrelations: jest.fn()
      .mockResolvedValueOnce({ ...LIVE_RESPONSE, fxvlSnapshot: FXVL_SNAPSHOT })
      .mockResolvedValueOnce({
        ...LIVE_RESPONSE, ...invalid,
        fxvlSnapshot: { ...FXVL_SNAPSHOT, lastPx: 999, asOf: '2026-07-15T20:00:00.000Z' },
      }) };
    const { result } = renderHook(() => useUsdCorrelations({
      service, retryDelaysMs: STABLE_RETRY_DELAYS_MS, failurePollMs: 10000, successPollMs: 10000,
    }));
    await waitFor(() => expect(result.current.fxvlSnapshot?.lastPx).toBe(5.75));
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.fxvlSnapshot).toMatchObject({
      lastPx: 5.75, asOf: FXVL_SNAPSHOT.asOf, lastVerifiedAt: FXVL_SNAPSHOT.asOf,
      availability: 'reference', displayOnly: true, executable: false,
    });
  });

  test('ignores an older optional FX observation while accepting refreshed correlations', async () => {
    const service = { getCorrelations: jest.fn()
      .mockResolvedValueOnce({ ...LIVE_RESPONSE, fxvlSnapshot: FXVL_SNAPSHOT })
      .mockResolvedValueOnce({
        ...LIVE_RESPONSE, calculationDate: '2026-07-15',
        fxvlSnapshot: { ...FXVL_SNAPSHOT, lastPx: 999, asOf: '2026-07-13T20:00:00.000Z' },
      }) };
    const { result } = renderHook(() => useUsdCorrelations({
      service, retryDelaysMs: STABLE_RETRY_DELAYS_MS, failurePollMs: 10000, successPollMs: 10000,
    }));
    await waitFor(() => expect(result.current.fxvlSnapshot?.lastPx).toBe(5.75));
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.calculationDate).toBe('2026-07-15'));
    expect(result.current.fxvlSnapshot).toMatchObject({ lastPx: 5.75, asOf: FXVL_SNAPSHOT.asOf });
  });
});
