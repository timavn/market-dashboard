import { act, renderHook, waitFor } from '@testing-library/react';
import {
  getVolatilitySnapshotMetadata,
  retainHistoricalVolatilityRows,
  useVolatilitySnapshot,
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

  test('still expires an aged snapshot during an active market session', async () => {
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

    await waitFor(() => expect(result.current.error).toBe(
      'Verified live data is outside its freshness window.',
    ));
    expect(result.current.snapshot).toBeNull();
  });

  test('fails with a typed provider-unavailable error when no Cboe row is current', async () => {
    const fetcher = jest.fn().mockResolvedValue(jsonResponse({
      status: 'partial',
      generatedAt: '2026-07-13T22:01:00.000Z',
      lastUpdated: '2026-07-13T20:30:00.000Z',
      MOVE: {
        lastPx: 92.4,
        availability: 'historical',
        freshness: 'historical',
        source: 'yahoo',
        sourceLabel: 'Yahoo Finance',
        quoteMode: 'end-of-day',
        asOf: '2026-07-11T20:30:00.000Z',
      },
    }));
    const { result } = renderHook(() => useVolatilitySnapshot({
      fetcher,
      backendUrl: 'http://dashboard.test',
      pollIntervalMs: 0,
    }));

    await waitFor(() => expect(result.current.error).toBe(
      'No verified current volatility rows are available; retrying automatically.',
    ));
    expect(result.current.snapshot).toBeNull();
  });

  test('accepts a still-fresh refresh-delayed Cboe reference without blanking the row', async () => {
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

    await waitFor(() => expect(result.current.snapshot?.NazVol?.lastPx).toBe(21.51));
    expect(result.current.sources.find(({ id }) => id === 'NazVol')).toMatchObject({
      status: 'stale',
      stateLabel: 'Refresh delayed',
      detail: expect.stringContaining('last verified'),
    });
  });

  test('rejects a refresh-delayed reference after its retention window expires', async () => {
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

    await waitFor(() => expect(result.current.error).toBe(
      'No verified current volatility rows are available; retrying automatically.',
    ));
    expect(result.current.snapshot).toBeNull();
  });

  test('keeps the prior snapshot visible when a scheduled refresh fails', async () => {
    const fetcher = jest.fn()
      .mockResolvedValueOnce(jsonResponse(CURRENT_SNAPSHOT))
      .mockRejectedValueOnce(new Error('provider offline'));
    const { result } = renderHook(() => useVolatilitySnapshot({
      fetcher,
      pollIntervalMs: 100,
    }));

    await waitFor(() => expect(result.current.snapshot).toEqual(CURRENT_SNAPSHOT), { interval: 5 });
    await waitFor(() => expect(result.current.error).toBe('provider offline'));
    expect(result.current.snapshot).toEqual(CURRENT_SNAPSHOT);
    expect(result.current.sources.find(({ id }) => id === 'VIX')).toEqual(
      expect.objectContaining({ status: 'delayed' }),
    );
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
    act(() => result.current.retry());
    expect(fetcher).not.toHaveBeenCalled();
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

  test('retains only explicitly dated end-of-day rows after a refresh failure', () => {
    const historicalMove = {
      lastPx: 92.4,
      availability: 'historical',
      freshness: 'historical',
      source: 'yahoo',
      sourceLabel: 'Yahoo Finance',
      quoteMode: 'end-of-day',
      asOf: '2026-07-13T20:30:00.000Z',
    };

    expect(retainHistoricalVolatilityRows({
      ...CURRENT_SNAPSHOT,
      MOVE: historicalMove,
    })).toEqual({
      status: 'reference-only',
      lastUpdated: '2026-07-13T20:30:00.000Z',
      MOVE: historicalMove,
    });
  });
});
