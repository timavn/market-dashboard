import { act, renderHook, waitFor } from '@testing-library/react';
import fetchMarketEvents from '../services/api/marketEventsService';
import { resetSessionResourceStore } from '../utils/sessionResourceStore';
import {
  MARKET_EVENTS_MAX_AGE_MS,
  currentMarketEventWeek,
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

function nextWeekSnapshot(overrides = {}) {
  return verifiedSnapshot({
    coverage: { from: '2026-08-16', to: '2026-08-22' },
    events: [marketEvent({ startAt: '2026-08-19T12:30:00.000Z' })],
    ...overrides,
  });
}

function tradingEconomicsSnapshot(overrides = {}) {
  return nextWeekSnapshot({
    provider: 'Trading Economics',
    providerMode: 'calendar-page',
    sourceUrl: 'https://tradingeconomics.com/calendar',
    sourceUpdatedAt: null,
    sourceObservedAt: '2026-08-10T15:59:59.000Z',
    events: [marketEvent({
      id: 'te-123456', name: 'Retail Sales MoM', startAt: '2026-08-19T12:30:00.000Z',
      provider: 'Trading Economics', source: 'Trading Economics', verification: 'provider-calendar',
      sourceUrl: 'https://tradingeconomics.com/united-states/retail-sales',
      lastUpdatedAt: null, observedAt: '2026-08-10T15:59:59.000Z',
    })],
    ...overrides,
  });
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

  test('loads next week only when selected and keeps each week in its own shared cache', async () => {
    fetchMarketEvents.mockImplementation((options) => Promise.resolve(
      options?.week === 'next' ? nextWeekSnapshot() : verifiedSnapshot(),
    ));
    const { result, rerender } = renderHook(({ nextActive }) => ({
      current: useMarketEvents(),
      next: useMarketEvents({ week: 'next', active: nextActive }),
      otherNext: useMarketEvents({ week: 'next', active: nextActive }),
    }), { initialProps: { nextActive: false } });

    await waitFor(() => expect(result.current.current.availability).toBe('live'));
    expect(fetchMarketEvents).toHaveBeenCalledTimes(1);
    expect(result.current.next.data).toBeNull();

    rerender({ nextActive: true });
    await waitFor(() => expect(result.current.next.availability).toBe('live'));
    expect(fetchMarketEvents).toHaveBeenCalledTimes(2);
    expect(fetchMarketEvents).toHaveBeenLastCalledWith({ week: 'next' });
    expect(result.current.next.data).toEqual(result.current.otherNext.data);
    expect(result.current.current.data.coverage.from).toBe('2026-08-09');
    expect(result.current.next.data.coverage.from).toBe('2026-08-16');
    expect(JSON.parse(window.sessionStorage.getItem('market-dashboard.reference.market-events.v1'))
      .data.coverage.from).toBe('2026-08-09');
    expect(JSON.parse(window.sessionStorage.getItem('market-dashboard.reference.market-events.next-week.v1'))
      .data.coverage.from).toBe('2026-08-16');
  });

  test('cannot display an in-flight current-week result after switching to next week', async () => {
    let resolveCurrent;
    fetchMarketEvents.mockImplementation((options) => (
      options?.week === 'next'
        ? Promise.resolve(nextWeekSnapshot())
        : new Promise((resolve) => { resolveCurrent = resolve; })
    ));
    const { result, rerender } = renderHook(({ week }) => useMarketEvents({ week }), {
      initialProps: { week: 'this' },
    });

    rerender({ week: 'next' });
    await waitFor(() => expect(result.current.data?.coverage.from).toBe('2026-08-16'));
    await act(async () => resolveCurrent(verifiedSnapshot()));
    expect(result.current.data.coverage.from).toBe('2026-08-16');

    rerender({ week: 'this' });
    expect(result.current.data.coverage.from).toBe('2026-08-09');
    expect(fetchMarketEvents).toHaveBeenCalledTimes(2);
  });

  test.each([
    ['provider offline', { status: 'unavailable' }],
    ['stale source', { sourceUpdatedAt: '2026-08-10T13:59:59.000Z' }],
    ['cache-only', { cacheOnly: true }],
    ['nested cache-only', { _cache: { status: 'cache-only' } }],
    ['seeded', { seeded: true }],
    ['mock', { mock: true }],
  ])('does not load %s next-week evidence', async (_label, overrides) => {
    fetchMarketEvents.mockResolvedValue(nextWeekSnapshot(overrides));
    const { result } = renderHook(() => useMarketEvents({ week: 'next' }));

    await waitFor(() => expect(result.current.availability).toBe('unavailable'));
    expect(result.current.data).toBeNull();
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

  test('validates each snapshot against the selected week', () => {
    expect(validateMarketEventsSnapshot(nextWeekSnapshot(), { week: 'next' }).coverage)
      .toEqual({ from: '2026-08-16', to: '2026-08-22' });
    expect(() => validateMarketEventsSnapshot(nextWeekSnapshot())).toThrow();
    expect(() => validateMarketEventsSnapshot(verifiedSnapshot(), { week: 'next' })).toThrow();
    expect(() => validateMarketEventsSnapshot(nextWeekSnapshot(), {
      week: 'next', currentTime: Date.parse('2026-08-16T04:00:00.000Z'),
    })).toThrow();
  });

  test('loads independently observed Trading Economics next-week evidence', async () => {
    fetchMarketEvents.mockResolvedValue(tradingEconomicsSnapshot());
    const { result } = renderHook(() => useMarketEvents({ week: 'next' }));
    await waitFor(() => expect(result.current.availability).toBe('live'));
    expect(result.current.data).toMatchObject({
      provider: 'Trading Economics', sourceUpdatedAt: null,
      sourceObservedAt: '2026-08-10T15:59:59.000Z',
    });
    expect(result.current.data.events[0]).toMatchObject({ id: 'te-123456', lastUpdatedAt: null });
    expect(() => validateMarketEventsSnapshot(tradingEconomicsSnapshot())).toThrow();
  });

  test.each([
    ['offline', { connected: false }],
    ['stale', { stale: true }],
    ['cache-only', { cacheOnly: true }],
    ['seed', { seeded: true }],
    ['mock', { mock: true }],
    ['missing observation', { sourceObservedAt: null }],
    ['invented update time', { sourceUpdatedAt: '2026-08-10T15:59:59.000Z' }],
    ['stale observation', { sourceObservedAt: '2026-08-10T13:59:59.000Z' }],
    ['future observation', { sourceObservedAt: '2026-08-10T16:02:01.000Z' }],
    ['future fetch', { fetchedAt: '2026-08-10T16:03:00.000Z' }],
    ['future source beyond current-time tolerance', {
      fetchedAt: '2026-08-10T16:01:00.000Z', sourceObservedAt: '2026-08-10T16:02:30.000Z',
    }],
    ['wrong mode', { providerMode: 'weekly-export' }],
    ['wrong source', { sourceUrl: 'https://www.forexfactory.com/calendar/rss' }],
    ['current-week coverage', { coverage: { from: '2026-08-09', to: '2026-08-15' } }],
  ])('rejects %s Trading Economics snapshot evidence', (_label, overrides) => {
    expect(() => validateMarketEventsSnapshot(tradingEconomicsSnapshot(overrides), { week: 'next' })).toThrow();
  });

  test.each([
    ['wrong id', { id: 'ff-123456' }],
    ['wrong provider', { provider: 'Forex Factory' }],
    ['wrong verification', { verification: 'provider-export' }],
    ['wrong source', { sourceUrl: 'https://unverified.example/retail-sales' }],
    ['missing observation', { observedAt: null }],
    ['different observation', { observedAt: '2026-08-10T15:30:00.000Z' }],
    ['unverified update', { lastUpdatedAt: '2026-08-10T15:59:59.000Z' }],
    ['out-of-coverage event', { startAt: '2026-08-12T12:30:00.000Z' }],
    ['offline', { connected: false }],
    ['stale', { stale: true }],
    ['cache-only', { cacheOnly: true }],
    ['seed', { seeded: true }],
    ['mock', { mock: true }],
  ])('rejects %s Trading Economics event rows', (_label, overrides) => {
    const snapshot = tradingEconomicsSnapshot();
    snapshot.events[0] = { ...snapshot.events[0], ...overrides };
    expect(() => validateMarketEventsSnapshot(snapshot, { week: 'next' })).toThrow();
  });

  test('uses Eastern calendar weeks across Sunday and year boundaries', () => {
    expect(currentMarketEventWeek('2026-12-27T04:59:59.000Z', 'next'))
      .toEqual({ from: '2026-12-27', to: '2027-01-02' });
    expect(currentMarketEventWeek('2026-12-27T05:00:00.000Z', 'next'))
      .toEqual({ from: '2027-01-03', to: '2027-01-09' });
  });
});
