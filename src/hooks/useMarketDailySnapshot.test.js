import { act, renderHook, waitFor } from '@testing-library/react';
import useMarketDailySnapshot, { MARKET_DAILY_STORAGE_KEY, validateMarketDailySnapshot } from './useMarketDailySnapshot';

const NOW = Date.parse('2026-09-22T17:30:00Z');
const fixture = () => ({
  status: 'available', asOf: new Date(NOW - 60_000).toISOString(),
  expiresAt: new Date(NOW + 60_000).toISOString(), marketDate: '2026-09-22',
  source: 'Yahoo Finance / State Street', sourceUrl: 'https://finance.yahoo.com/',
  universe: { count: 503, asOf: '2026-09-21' }, coverage: { quotes: 503, total: 503 },
  leadership: {}, outliers: {},
  breadth: { advancing: 300, declining: 200, unchanged: 3, medianReturn: 0.4 }, winners: [], losers: [],
});
const response = value => ({ ok: true, json: async () => value });

describe('daily summary retained evidence', () => {
  let originalFetch;
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
    originalFetch = global.fetch;
    window.sessionStorage.clear();
    jest.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  });
  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  test('keeps expired verified observations and rejects contaminated incoming snapshots', () => {
    const value = fixture();
    expect(validateMarketDailySnapshot(value, NOW)).toMatchObject(value);
    for (const flag of ['stale', 'isStale', 'mock', 'isMock', 'seeded', 'synthetic', 'fromCache', 'cacheOnly', 'offline', 'disconnected']) {
      expect(validateMarketDailySnapshot({ ...value, [flag]: true }, NOW)).toBeNull();
    }
    expect(validateMarketDailySnapshot({ ...value, winners: [{ connected: false }] }, NOW)).toMatchObject({ winners: [null], breadth: value.breadth });
    expect(validateMarketDailySnapshot({ ...value, expiresAt: new Date(NOW).toISOString() }, NOW)).toMatchObject({
      retained: true, asOf: value.asOf, breadth: value.breadth,
    });
    expect(validateMarketDailySnapshot({ ...value, asOf: new Date(NOW + 60_000).toISOString() }, NOW)).toBeNull();
    expect(validateMarketDailySnapshot({ ...value, sourceUrl: null }, NOW)).toBeNull();
  });

  test('does not fetch when disabled', () => {
    global.fetch = jest.fn();
    const { unmount } = renderHook(() => useMarketDailySnapshot({ enabled: false }));
    expect(global.fetch).not.toHaveBeenCalled();
    unmount();
  });

  test.each(['network', 'http', 'offline', 'stale', 'cacheOnly', 'seeded', 'mock'])('retains prior readings after %s failure without refreshing their timestamp', async failure => {
    const value = fixture();
    global.fetch = jest.fn().mockResolvedValueOnce(response(value));
    if (failure === 'network') global.fetch.mockRejectedValueOnce(new Error('Offline'));
    else if (failure === 'http') global.fetch.mockResolvedValueOnce({ ok: false });
    else global.fetch.mockResolvedValueOnce(response({ ...value, [failure]: true }));
    const { result, unmount } = renderHook(() => useMarketDailySnapshot());
    await waitFor(() => expect(result.current.snapshot?.breadth.advancing).toBe(300));
    await act(async () => window.dispatchEvent(new Event('online')));
    expect(result.current.snapshot).toMatchObject({ retained: true, asOf: value.asOf, breadth: value.breadth });
    expect(result.current.loading).toBe(false);
    unmount();
  });

  test('expiry and a reload preserve observations without an age deletion deadline', async () => {
    const value = { ...fixture(), expiresAt: new Date(NOW + 1_000).toISOString() };
    global.fetch = jest.fn().mockResolvedValueOnce(response(value)).mockRejectedValue(new Error('Offline'));
    const { result: firstResult, unmount: unmountFirst } = renderHook(() => useMarketDailySnapshot());
    await waitFor(() => expect(firstResult.current.snapshot?.breadth.advancing).toBe(300));
    act(() => jest.advanceTimersByTime(1_001));
    expect(firstResult.current.snapshot).toMatchObject({ retained: true, asOf: value.asOf, breadth: value.breadth });
    unmountFirst();
    jest.setSystemTime(NOW + 400 * 86_400_000);
    const { result: restoredResult, unmount: unmountRestored } = renderHook(() => useMarketDailySnapshot());
    await waitFor(() => expect(restoredResult.current.loading).toBe(false));
    expect(restoredResult.current.snapshot).toMatchObject({ retained: true, asOf: value.asOf, breadth: value.breadth });
    expect(JSON.parse(window.sessionStorage.getItem(MARKET_DAILY_STORAGE_KEY))).toMatchObject({ asOf: value.asOf });
    unmountRestored();
  });

  test('partial refresh persists merged metric groups and only newer verified observations replace them', async () => {
    const first = fixture();
    const next = { ...first, asOf: new Date(NOW).toISOString(), breadth: { advancing: null, above50Pct: 64 }, coverage: { quotes: 400, total: 503, history50: 400 }, status: 'partial' };
    global.fetch = jest.fn().mockResolvedValueOnce(response(first)).mockResolvedValueOnce(response(next));
    const { result, unmount } = renderHook(() => useMarketDailySnapshot());
    await waitFor(() => expect(result.current.snapshot?.breadth.advancing).toBe(300));
    await act(async () => window.dispatchEvent(new Event('online')));
    expect(result.current.snapshot.breadth).toMatchObject({ advancing: 300, above50Pct: 64 });
    expect(JSON.parse(window.sessionStorage.getItem(MARKET_DAILY_STORAGE_KEY)).breadth).toMatchObject({ advancing: 300, above50Pct: 64 });
    unmount();
  });

  test('times out even when transport ignores abort, retaining the prior reading', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce(response(fixture())).mockImplementationOnce(() => new Promise(() => {}));
    const { result, unmount } = renderHook(() => useMarketDailySnapshot());
    await waitFor(() => expect(result.current.snapshot).not.toBeNull());
    await act(async () => window.dispatchEvent(new Event('online')));
    await act(async () => jest.advanceTimersByTime(35_000));
    expect(global.fetch.mock.calls[1][1].signal.aborted).toBe(true);
    expect(result.current.snapshot).toMatchObject({ retained: true, asOf: fixture().asOf });
    expect(result.current.loading).toBe(false);
    unmount();
  });
});
