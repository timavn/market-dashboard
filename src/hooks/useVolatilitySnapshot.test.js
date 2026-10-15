import { act, renderHook, waitFor } from '@testing-library/react';
import {
  getVolatilitySnapshotMetadata,
  useVolatilitySnapshot,
  VOLATILITY_REFERENCE_STORAGE_KEY,
} from './useVolatilitySnapshot';
import { resetSessionResourceStore } from '../utils/sessionResourceStore';

const CURRENT_SNAPSHOT = {
  status: 'partial',
  lastUpdated: '2026-07-13T22:00:00.000Z',
  VIX: {
    lastPx: 17.16,
    dayChangePct: 14.17,
    availability: 'available',
    freshness: 'current',
    source: 'cboe',
    sourceLabel: 'Cboe Global Indices',
    quoteMode: 'delayed',
    asOf: '2026-07-13T22:00:00.000Z',
  },
};

const HISTORICAL_MOVE = {
  lastPx: 92.4,
  availability: 'historical',
  freshness: 'historical',
  source: 'yahoo',
  sourceLabel: 'Yahoo Finance',
  quoteMode: 'end-of-day',
  asOf: '2026-07-10T20:30:00.000Z',
};

const jsonResponse = (body, ok = true, status = 200) => ({
  ok,
  status,
  json: jest.fn().mockResolvedValue(body),
});

describe('useVolatilitySnapshot', () => {
  beforeEach(() => {
    resetSessionResourceStore();
    window.sessionStorage?.clear();
    jest.spyOn(Date, 'now').mockReturnValue(new Date('2026-07-13T22:01:00.000Z').getTime());
  });
  afterEach(() => {
    resetSessionResourceStore();
    window.sessionStorage?.clear();
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  test('returns a verified snapshot and its delayed-source metadata', async () => {
    const fetcher = jest.fn().mockResolvedValue(jsonResponse(CURRENT_SNAPSHOT));
    const { result } = renderHook(() => useVolatilitySnapshot({
      fetcher,
      backendUrl: 'http://dashboard.test',
      pollIntervalMs: 10000,
    }));

    await waitFor(() => expect(result.current.snapshot).toEqual(CURRENT_SNAPSHOT));
    expect(fetcher).toHaveBeenCalledWith('http://dashboard.test/api/volatility-snapshot');
    expect(result.current.lastUpdated).toBe('2026-07-13T22:00:00.000Z');
    expect(result.current.sources.find(({ id }) => id === 'VIX')).toMatchObject({
      status: 'delayed',
      updatedAt: '2026-07-13T22:00:00.000Z',
    });
  });

  test('accepts a verified Cboe-delayed snapshot during the normal provider delay window', async () => {
    Date.now.mockReturnValue(new Date('2026-07-13T22:16:00.000Z').getTime());
    const fetcher = jest.fn().mockResolvedValue(jsonResponse({
      ...CURRENT_SNAPSHOT,
      marketSession: 'open',
    }));
    const { result } = renderHook(() => useVolatilitySnapshot({
      fetcher,
      backendUrl: 'http://dashboard.test',
      pollIntervalMs: 0,
    }));

    await waitFor(() => expect(result.current.snapshot).toEqual(expect.objectContaining({
      lastUpdated: '2026-07-13T22:00:00.000Z',
    })));
    expect(result.current.error).toBeNull();
  });

  test('accepts a verified completed-session snapshot after the market closes', async () => {
    Date.now.mockReturnValue(new Date('2026-07-14T02:01:00.000Z').getTime());
    const afterHoursSnapshot = {
      ...CURRENT_SNAPSHOT,
      generatedAt: '2026-07-14T02:00:00.000Z',
      marketSession: 'closed',
      lastUpdated: '2026-07-13T20:00:00.000Z',
      VIX: {
        ...CURRENT_SNAPSHOT.VIX,
        asOf: '2026-07-13T20:00:00.000Z',
      },
    };
    const fetcher = jest.fn().mockResolvedValue(jsonResponse(afterHoursSnapshot));
    const { result } = renderHook(() => useVolatilitySnapshot({
      fetcher,
      backendUrl: 'http://dashboard.test',
      pollIntervalMs: 0,
    }));

    await waitFor(() => expect(result.current.snapshot).toEqual(afterHoursSnapshot));
    expect(result.current.error).toBeNull();
  });

  test('keeps an aged observation as a delayed reference during an active market session', async () => {
    Date.now.mockReturnValue(new Date('2026-07-13T22:31:00.001Z').getTime());
    const agedOpenSnapshot = {
      ...CURRENT_SNAPSHOT,
      generatedAt: '2026-07-13T22:30:00.000Z',
      marketSession: 'open',
      lastUpdated: '2026-07-13T22:00:00.000Z',
    };
    const fetcher = jest.fn().mockResolvedValue(jsonResponse(agedOpenSnapshot));
    const { result } = renderHook(() => useVolatilitySnapshot({
      fetcher,
      backendUrl: 'http://dashboard.test',
      pollIntervalMs: 0,
    }));

    await waitFor(() => expect(result.current.snapshot?.VIX).toMatchObject({
      lastPx: 17.16, availability: 'reference', asOf: CURRENT_SNAPSHOT.VIX.asOf, executable: false,
    }));
    expect(result.current.error).toBeNull();
  });

  test('keeps verified historical MOVE available when no Cboe row is current', async () => {
    const fetcher = jest.fn().mockResolvedValue(jsonResponse({
      status: 'partial',
      generatedAt: '2026-07-13T22:01:00.000Z',
      lastUpdated: '2026-07-13T20:30:00.000Z',
      MOVE: HISTORICAL_MOVE,
    }));
    const { result } = renderHook(() => useVolatilitySnapshot({
      fetcher,
      backendUrl: 'http://dashboard.test',
      pollIntervalMs: 0,
    }));

    await waitFor(() => expect(result.current.snapshot?.MOVE).toEqual(HISTORICAL_MOVE));
    expect(result.current.error).toBeNull();
    expect(result.current.sources.find(({ id }) => id === 'MOVE')).toMatchObject({
      status: 'historical',
      updatedAt: HISTORICAL_MOVE.asOf,
    });
  });

  test.each([
    ['stale', { freshness: 'stale' }],
    ['offline', { providerStatus: 'offline' }],
    ['cache-only', { cacheOnly: true }],
    ['seed', { source: 'seed' }],
    ['mock', { source: 'mock' }],
    ['missing observation', { asOf: null }],
    ['missing provider', { source: null }],
    ['missing price', { lastPx: null }],
  ])('withholds %s Cboe rows without discarding independently verified MOVE', async (_label, overrides) => {
    const fetcher = jest.fn().mockResolvedValue(jsonResponse({
      ...CURRENT_SNAPSHOT,
      marketSession: 'open',
      generatedAt: '2026-07-13T22:01:00.000Z',
      VIX: { ...CURRENT_SNAPSHOT.VIX, ...overrides },
      MOVE: HISTORICAL_MOVE,
    }));
    const { result } = renderHook(() => useVolatilitySnapshot({ fetcher, pollIntervalMs: 0 }));

    await waitFor(() => expect(result.current.snapshot?.MOVE).toEqual(HISTORICAL_MOVE));
    expect(result.current.snapshot.VIX).toMatchObject({ availability: 'unavailable', lastPx: null });
    expect(result.current.error).toBeNull();
  });

  test('uses current rows independently of an older top-level timestamp', async () => {
    const fetcher = jest.fn().mockResolvedValue(jsonResponse({
      ...CURRENT_SNAPSHOT,
      marketSession: 'open',
      generatedAt: '2026-07-13T22:01:00.000Z',
      lastUpdated: HISTORICAL_MOVE.asOf,
      VVIX: { ...CURRENT_SNAPSHOT.VIX, asOf: '2026-07-13T20:30:00.000Z' },
      MOVE: HISTORICAL_MOVE,
    }));
    const { result } = renderHook(() => useVolatilitySnapshot({ fetcher, pollIntervalMs: 0 }));

    await waitFor(() => expect(result.current.snapshot?.VIX).toEqual(CURRENT_SNAPSHOT.VIX));
    expect(result.current.snapshot.VVIX).toMatchObject({ availability: 'reference', lastPx: 17.16 });
    expect(result.current.snapshot.MOVE).toEqual(HISTORICAL_MOVE);
    expect(result.current.error).toBeNull();
  });

  test('marks only the older row delayed between polls while preserving every observation', async () => {
    Date.now.mockRestore();
    jest.useFakeTimers({ now: new Date('2026-07-13T22:01:00.000Z') });
    const olderVix = { ...CURRENT_SNAPSHOT.VIX, asOf: '2026-07-13T21:31:00.999Z' };
    const fresherVvix = { ...CURRENT_SNAPSHOT.VIX, lastPx: 95 };
    const fetcher = jest.fn().mockResolvedValue(jsonResponse({
      ...CURRENT_SNAPSHOT,
      marketSession: 'open',
      generatedAt: '2026-07-13T22:01:00.000Z',
      VIX: olderVix,
      VVIX: fresherVvix,
      MOVE: HISTORICAL_MOVE,
    }));
    const { result } = renderHook(() => useVolatilitySnapshot({ fetcher, pollIntervalMs: 60_000 }));

    await waitFor(() => expect(result.current.snapshot?.VIX).toEqual(olderVix));
    act(() => { jest.advanceTimersByTime(1000); });

    expect(result.current.snapshot.VIX).toMatchObject({ availability: 'reference', freshness: 'refresh-delayed', lastPx: 17.16, asOf: olderVix.asOf });
    expect(result.current.snapshot.VVIX).toEqual(fresherVvix);
    expect(result.current.snapshot.MOVE).toEqual(HISTORICAL_MOVE);
    expect(result.current.sources.find(({ id }) => id === 'VIX').status).toBe('stale');
    expect(result.current.error).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test('keeps historical MOVE independently of the response heartbeat age', async () => {
    const fetcher = jest.fn().mockResolvedValue(jsonResponse({
      generatedAt: '2026-07-13T20:30:00.000Z',
      MOVE: HISTORICAL_MOVE,
    }));
    const { result } = renderHook(() => useVolatilitySnapshot({ fetcher, pollIntervalMs: 0 }));

    await waitFor(() => expect(result.current.snapshot?.MOVE).toEqual(HISTORICAL_MOVE));
    expect(result.current.error).toBeNull();
  });

  test('uses the original observation for historical-only snapshots without a heartbeat', async () => {
    const fetcher = jest.fn().mockResolvedValue(jsonResponse({
      lastUpdated: CURRENT_SNAPSHOT.lastUpdated,
      MOVE: HISTORICAL_MOVE,
    }));
    const { result } = renderHook(() => useVolatilitySnapshot({ fetcher, pollIntervalMs: 0 }));

    await waitFor(() => expect(result.current.snapshot?.MOVE).toEqual(HISTORICAL_MOVE));
    expect(result.current.error).toBeNull();
  });

  test('accepts a verified refresh-delayed Cboe reference', async () => {
    const retainedSnapshot = {
      status: 'partial',
      generatedAt: '2026-07-13T22:01:00.000Z',
      marketSession: 'closed',
      lastUpdated: '2026-07-13T22:00:00.000Z',
      NazVol: {
        ...CURRENT_SNAPSHOT.VIX,
        lastPx: 21.51,
        availability: 'reference',
        freshness: 'refresh-delayed',
        refreshDelayed: true,
        lastVerifiedAt: '2026-07-13T22:00:00.000Z',
        retainedUntil: '2026-07-13T22:30:00.000Z',
      },
    };
    const fetcher = jest.fn().mockResolvedValue(jsonResponse(retainedSnapshot));
    const { result } = renderHook(() => useVolatilitySnapshot({
      fetcher,
      backendUrl: 'http://dashboard.test',
      pollIntervalMs: 0,
    }));

    await waitFor(() => expect(result.current.snapshot?.NazVol?.availability).toBe('reference'));
    expect(result.current.snapshot.NazVol.lastPx).toBeGreaterThan(0);
    expect(result.current.error).toBeNull();
  });

  test('keeps a verified reference after its former retention deadline', async () => {
    const fetcher = jest.fn().mockResolvedValue(jsonResponse({
      status: 'partial',
      generatedAt: '2026-07-13T22:01:00.000Z',
      NazVol: {
        ...CURRENT_SNAPSHOT.VIX,
        availability: 'reference',
        freshness: 'refresh-delayed',
        refreshDelayed: true,
        lastVerifiedAt: '2026-07-13T21:20:00.000Z',
        retainedUntil: '2026-07-13T21:50:00.000Z',
      },
    }));
    const { result } = renderHook(() => useVolatilitySnapshot({
      fetcher,
      backendUrl: 'http://dashboard.test',
      pollIntervalMs: 0,
    }));

    await waitFor(() => expect(result.current.snapshot?.NazVol?.availability).toBe('reference'));
    expect(result.current.snapshot.NazVol.lastPx).toBeGreaterThan(0);
    expect(result.current.error).toBeNull();
  });

  test('keeps the prior snapshot marked delayed when a scheduled refresh fails', async () => {
    const fetcher = jest.fn()
      .mockResolvedValueOnce(jsonResponse(CURRENT_SNAPSHOT))
      .mockRejectedValueOnce(new Error('provider offline'));
    const { result } = renderHook(() => useVolatilitySnapshot({
      fetcher,
      pollIntervalMs: 100,
    }));

    await waitFor(() => expect(result.current.snapshot).toEqual(CURRENT_SNAPSHOT), { interval: 5 });
    await waitFor(() => expect(result.current.error).toBe('provider offline'));
    expect(result.current.snapshot.VIX).toMatchObject({
      lastPx: 17.16, dayChangePct: 14.17, asOf: CURRENT_SNAPSHOT.VIX.asOf,
      availability: 'reference', freshness: 'refresh-delayed', executable: false,
    });
  });

  test('performs no requests when disabled for a controlled consumer', () => {
    const fetcher = jest.fn();
    const { result } = renderHook(() => useVolatilitySnapshot({ enabled: false, fetcher }));

    expect(fetcher).not.toHaveBeenCalled();
    expect(result.current).toMatchObject({
      snapshot: null,
      loading: false,
      error: null,
    });
    act(() => { result.current.retry(); });
    expect(fetcher).not.toHaveBeenCalled();
  });

  test('merges partial responses and preserves all verified rows across a reload during an outage', async () => {
    const first = { ...CURRENT_SNAPSHOT, VVIX: { ...CURRENT_SNAPSHOT.VIX, lastPx: 95 } };
    const fetcher = jest.fn().mockResolvedValueOnce(jsonResponse(first))
      .mockResolvedValueOnce(jsonResponse({
        ...CURRENT_SNAPSHOT,
        VIX: { ...CURRENT_SNAPSHOT.VIX, lastPx: 18, asOf: '2026-07-13T22:01:00.000Z' },
        VVIX: { availability: 'unavailable', freshness: 'stale', lastPx: null },
      }));
    const view = renderHook(() => useVolatilitySnapshot({ fetcher, pollIntervalMs: 0 }));
    await waitFor(() => expect(view.result.current.snapshot?.VVIX?.lastPx).toBe(95));
    await act(async () => { await view.result.current.retry(); });
    expect(view.result.current.snapshot.VIX.lastPx).toBe(18);
    expect(view.result.current.snapshot.VVIX).toMatchObject({
      lastPx: 95, asOf: first.VVIX.asOf, availability: 'reference', executable: false,
    });
    const stored = JSON.parse(window.sessionStorage.getItem(VOLATILITY_REFERENCE_STORAGE_KEY));
    expect(stored.data.VVIX.lastPx).toBe(95);
    view.unmount();
    resetSessionResourceStore();
    Date.now.mockReturnValue(Date.parse('2027-01-01T12:00:00.000Z'));
    const offline = jest.fn().mockRejectedValue(new Error('provider offline'));
    const { result: restoredResult } = renderHook(() => useVolatilitySnapshot({ fetcher: offline, pollIntervalMs: 0 }));
    expect(restoredResult.current.snapshot.VVIX).toMatchObject({ lastPx: 95, asOf: first.VVIX.asOf, availability: 'reference' });
    await waitFor(() => expect(restoredResult.current.error).toBe('provider offline'));
    expect(restoredResult.current.snapshot.VIX).toMatchObject({ lastPx: 18, availability: 'reference' });
  });

  test.each([
    { status: 'offline' }, { cacheOnly: true }, { stale: true }, { mock: true }, { seeded: true },
    { _cache: { hit: true, stale: true } }, { meta: { cacheStatus: 'stale' } },
  ])('retains the previous verified observation when a whole response is rejected: %j', async (flags) => {
    const fetcher = jest.fn().mockResolvedValueOnce(jsonResponse(CURRENT_SNAPSHOT))
      .mockResolvedValueOnce(jsonResponse({ ...CURRENT_SNAPSHOT, ...flags,
        VIX: { ...CURRENT_SNAPSHOT.VIX, lastPx: 999 } }));
    const { result } = renderHook(() => useVolatilitySnapshot({ fetcher, pollIntervalMs: 0 }));
    await waitFor(() => expect(result.current.snapshot?.VIX?.lastPx).toBe(17.16));
    await act(async () => { await result.current.retry(); });
    expect(result.current.snapshot.VIX).toMatchObject({ lastPx: 17.16, availability: 'reference', asOf: CURRENT_SNAPSHOT.VIX.asOf });
  });

  test('keeps the delayed marker throughout a pending retry until a new verified response arrives', async () => {
    let finishRetry;
    const fetcher = jest.fn().mockResolvedValueOnce(jsonResponse(CURRENT_SNAPSHOT))
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementationOnce(() => new Promise((resolve) => { finishRetry = resolve; }));
    const { result } = renderHook(() => useVolatilitySnapshot({ fetcher, pollIntervalMs: 0 }));
    await waitFor(() => expect(result.current.snapshot?.VIX?.lastPx).toBe(17.16));
    await act(async () => { await result.current.retry(); });
    expect(result.current.snapshot.VIX.availability).toBe('reference');
    act(() => { result.current.retry(); });
    await waitFor(() => expect(finishRetry).toEqual(expect.any(Function)));
    expect(result.current.snapshot.VIX.availability).toBe('reference');
    await act(async () => { finishRetry(jsonResponse(CURRENT_SNAPSHOT)); });
    expect(result.current.snapshot.VIX.availability).toBe('available');
  });

  test('a malformed timestamp in one row cannot take down valid rows', async () => {
    const fetcher = jest.fn().mockResolvedValue(jsonResponse({ ...CURRENT_SNAPSHOT,
      VVIX: { ...CURRENT_SNAPSHOT.VIX, asOf: 'invalid-date' } }));
    const { result } = renderHook(() => useVolatilitySnapshot({ fetcher, pollIntervalMs: 0 }));
    await waitFor(() => expect(result.current.snapshot?.VIX?.lastPx).toBe(17.16));
    expect(result.current.snapshot.VVIX.lastPx).toBeNull();
    expect(result.current.sources.find(({ id }) => id === 'VVIX').detail).toContain('time unavailable');
  });

  test('derives the oldest row timestamp when the snapshot has no top-level as-of', () => {
    const metadata = getVolatilitySnapshotMetadata({
      VIX: { ...CURRENT_SNAPSHOT.VIX, asOf: '2026-07-13T22:00:00.000Z' },
      OVX: { ...CURRENT_SNAPSHOT.VIX, asOf: '2026-07-13T21:45:00.000Z' },
    });

    expect(metadata.lastUpdated.toISOString()).toBe('2026-07-13T21:45:00.000Z');
  });

  test('reports validated EOD MOVE as historical source data', () => {
    const metadata = getVolatilitySnapshotMetadata({
      lastUpdated: '2026-07-14T15:30:00.000Z',
      MOVE: {
        lastPx: 92.4,
        availability: 'historical',
        freshness: 'historical',
        source: 'yahoo',
        sourceLabel: 'Yahoo Finance',
        quoteMode: 'end-of-day',
        asOf: '2026-07-13T20:30:00.000Z',
      },
    });

    expect(metadata.lastUpdated).toBe('2026-07-14T15:30:00.000Z');
    expect(metadata.sources.find(({ id }) => id === 'MOVE')).toMatchObject({
      status: 'historical',
      updatedAt: '2026-07-13T20:30:00.000Z',
      detail: expect.stringContaining('end-of-day · as of'),
    });
  });

});
