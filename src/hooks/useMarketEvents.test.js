import { act, renderHook, waitFor } from '@testing-library/react';
import fetchMarketEvents from '../services/api/marketEventsService';
import { resetSessionResourceStore } from '../utils/sessionResourceStore';
import {
  MARKET_EVENTS_MAX_AGE_MS,
  useMarketEvents,
  validateMarketEventsSnapshot,
} from './useMarketEvents';

jest.mock('../services/api/marketEventsService', () => ({
  __esModule: true,
  default: jest.fn(),
}));

const NOW = Date.parse('2026-08-10T16:00:00.000Z');

function marketEvent(overrides = {}) {
  return {
    id: 'ff-15b47580b8cb192679405daf',
    name: 'CPI y/y',
    category: 'inflation',
    country: 'United States',
    countryCode: 'US',
    currency: 'USD',
    startAt: '2026-08-12T12:30:00.000Z',
    importance: 3,
    forecast: '2.8%',
    previous: '2.7%',
    actual: null,
    unit: null,
    source: 'Forex Factory',
    sourceUrl: 'https://www.forexfactory.com/calendar/rss',
    lastUpdatedAt: '2026-08-10T15:30:00.000Z',
    provider: 'Forex Factory',
    verification: 'provider-export',
    ...overrides,
  };
}

function verifiedSnapshot(overrides = {}) {
  return {
    status: 'verified',
    provider: 'Forex Factory',
    providerMode: 'weekly-export',
    timezone: 'America/New_York',
    coverage: { from: '2026-08-09', to: '2026-08-15' },
    fetchedAt: '2026-08-10T16:00:00.000Z',
    sourceUpdatedAt: '2026-08-10T15:30:00.000Z',
    sourceUrl: 'https://www.forexfactory.com/calendar/rss',
    code: null,
    reason: null,
    events: [marketEvent()],
    ...overrides,
  };
}

describe('useMarketEvents', () => {
  beforeEach(() => {
    resetSessionResourceStore();
    window.sessionStorage.clear();
    fetchMarketEvents.mockReset();
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
  });

  afterEach(() => {
    resetSessionResourceStore();
    window.sessionStorage.clear();
    jest.restoreAllMocks();
  });

  test('shares one request and one persisted verified snapshot across consumers', async () => {
    fetchMarketEvents.mockResolvedValue(verifiedSnapshot());
    const storageWrite = jest.spyOn(Storage.prototype, 'setItem');
    const { result } = renderHook(() => ({
      first: useMarketEvents(),
      second: useMarketEvents(),
    }));

    await waitFor(() => expect(result.current.first.availability).toBe('live'));
    expect(fetchMarketEvents).toHaveBeenCalledTimes(1);
    expect(result.current.second.data).toEqual(result.current.first.data);
    expect(storageWrite).toHaveBeenCalledWith(
      'market-dashboard.reference.market-events.v1',
      expect.any(String),
    );
  });

  test('keeps the shared informational rows visible after a refresh failure', async () => {
    fetchMarketEvents
      .mockResolvedValueOnce(verifiedSnapshot())
      .mockRejectedValueOnce(Object.assign(new Error('Provider offline'), {
        code: 'PROVIDER_UNAVAILABLE',
        liveInvalidation: true,
      }));
    const { result } = renderHook(() => useMarketEvents());
    await waitFor(() => expect(result.current.data?.events).toHaveLength(1));

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current).toMatchObject({
      data: expect.objectContaining({ events: expect.any(Array) }),
      availability: 'refresh-delayed',
    });
    expect(result.current.data.events).toHaveLength(1);
    expect(result.current.error).toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });

  test('expires a browser snapshot after seventy minutes', async () => {
    fetchMarketEvents.mockResolvedValue(verifiedSnapshot({
      fetchedAt: new Date(NOW - MARKET_EVENTS_MAX_AGE_MS - 1).toISOString(),
      sourceUpdatedAt: new Date(NOW - MARKET_EVENTS_MAX_AGE_MS - (30 * 60 * 1000)).toISOString(),
    }));
    const { result } = renderHook(() => useMarketEvents());

    await waitFor(() => expect(result.current.availability).toBe('unavailable'));
    expect(result.current.data).toBeNull();
    expect(result.current.error).toMatchObject({ code: 'LIVE_RESOURCE_STALE' });
  });

  test.each([
    ['wrong provider', { provider: 'Trading Economics' }],
    ['wrong provider mode', { providerMode: 'range-api' }],
    ['stale source at fetch time', { sourceUpdatedAt: '2026-08-10T13:59:59.000Z' }],
    ['wrong provider week', { coverage: { from: '2026-08-16', to: '2026-08-22' } }],
    ['out-of-coverage event', { events: [marketEvent({ startAt: '2026-08-16T04:01:00.000Z' })] }],
    ['unverified event', { events: [marketEvent({ verification: 'provider' })] }],
  ])('rejects a %s snapshot', (_label, overrides) => {
    expect(() => validateMarketEventsSnapshot(verifiedSnapshot(overrides))).toThrow();
  });
});
