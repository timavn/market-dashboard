import { act, renderHook, waitFor } from '@testing-library/react';
import {
  getVolatilitySnapshotMetadata,
  useVolatilitySnapshot,
} from './useVolatilitySnapshot';

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

  test('clears the prior snapshot when a scheduled refresh fails', async () => {
    const fetcher = jest.fn()
      .mockResolvedValueOnce(jsonResponse(CURRENT_SNAPSHOT))
      .mockRejectedValueOnce(new Error('provider offline'));
    const { result } = renderHook(() => useVolatilitySnapshot({
      fetcher,
      pollIntervalMs: 100,
    }));

    await waitFor(() => expect(result.current.snapshot).toEqual(CURRENT_SNAPSHOT), { interval: 5 });
    await waitFor(() => expect(result.current.error).toBe('provider offline'));
    expect(result.current.snapshot).toBeNull();
    expect(result.current.sources).toEqual([]);
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
});
