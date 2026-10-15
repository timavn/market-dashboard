import {
  getSessionResource,
  getSessionResourceCount,
  resetSessionResourceStore,
} from './sessionResourceStore';

describe('sessionResourceStore', () => {
  beforeEach(() => {
    jest.useRealTimers();
    resetSessionResourceStore();
    window.sessionStorage?.clear();
  });

  afterEach(() => {
    resetSessionResourceStore();
    window.sessionStorage?.clear();
    jest.useRealTimers();
  });

  test('hydrates an informational snapshot synchronously across a store reset', async () => {
    const observedAt = new Date().toISOString();
    const storageKey = 'dashboard.reference.quotes.v1';
    window.sessionStorage.setItem(storageKey, JSON.stringify({
      schemaVersion: 1,
      resourceKey: 'dashboard-quotes',
      scopeKey: 'SPY',
      observedAt,
      persistedAt: new Date().toISOString(),
      data: { observedAt, value: 10 },
    }));
    let resolveRequest;
    const entry = getSessionResource('dashboard-quotes::SPY', {
      kind: 'live',
      maxAgeMs: 60_000,
      displayRole: 'informational',
      persistReferenceSnapshot: { key: storageKey, ttlMs: 60_000 },
      fetcher: () => new Promise((resolve) => { resolveRequest = resolve; }),
      getObservedAt: (data) => data.observedAt,
    });

    expect(entry.getSnapshot()).toMatchObject({
      data: { value: 10 },
      availability: 'persisted-reference',
      initialLoading: false,
      hydratedFromStorage: true,
    });

    const refresh = entry.refresh();
    await Promise.resolve();
    expect(entry.getSnapshot()).toMatchObject({
      data: { value: 10 },
      refreshing: true,
      hydratedFromStorage: true,
    });

    resolveRequest({ observedAt: new Date().toISOString(), value: 11 });
    await refresh;
    expect(entry.getSnapshot()).toMatchObject({
      data: { value: 11 },
      availability: 'live',
      hydratedFromStorage: false,
    });
    expect(JSON.parse(window.sessionStorage.getItem(storageKey)).data.value).toBe(11);
  });

  test('rejects malformed and expired persisted snapshots before hydration', () => {
    const storageKey = 'dashboard.reference.invalid.v1';
    window.sessionStorage.setItem(storageKey, '{not-json');
    const first = getSessionResource('dashboard-reference::invalid', {
      kind: 'reference',
      displayRole: 'informational',
      persistReferenceSnapshot: { key: storageKey, ttlMs: 60_000 },
      getObservedAt: (data) => data.date,
    });
    expect(first.getSnapshot().data).toBeNull();
    expect(window.sessionStorage.getItem(storageKey)).toBeNull();

    const expiredKey = 'dashboard.reference.expired.v1';
    window.sessionStorage.setItem(expiredKey, JSON.stringify({
      schemaVersion: 1,
      resourceKey: 'dashboard-reference',
      scopeKey: 'expired',
      observedAt: '2026-08-05T00:00:00.000Z',
      persistedAt: '2026-08-05T00:00:00.000Z',
      data: { date: '2026-08-05' },
    }));
    const second = getSessionResource('dashboard-reference::expired', {
      kind: 'reference',
      displayRole: 'informational',
      persistReferenceSnapshot: { key: expiredKey, ttlMs: 60_000 },
      getObservedAt: (data) => data.date,
    });
    expect(second.getSnapshot().data).toBeNull();
    expect(window.sessionStorage.getItem(expiredKey)).toBeNull();
  });

  test('continues with verified in-memory data when sessionStorage write fails', async () => {
    const setItem = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage quota exceeded');
    });
    const entry = getSessionResource('dashboard-reference::storage-failure', {
      kind: 'reference',
      displayRole: 'informational',
      persistReferenceSnapshot: { key: 'dashboard.reference.failure.v1', ttlMs: 60_000 },
      fetcher: jest.fn().mockResolvedValue({ date: '2026-08-06', value: 10 }),
      getObservedAt: (data) => data.date,
    });

    await entry.refresh();
    expect(entry.getSnapshot()).toMatchObject({
      data: { value: 10 },
      availability: 'reference',
    });
    setItem.mockRestore();
  });

  test('resumes a paused poller from its remaining interval', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-31T12:00:00.000Z'));
    const fetcher = jest.fn().mockImplementation(() => Promise.resolve({
      date: new Date().toISOString(),
      value: fetcher.mock.calls.length,
    }));
    const entry = getSessionResource('dashboard-reference::resumed-poll', {
      kind: 'reference',
      displayRole: 'informational',
      fetcher,
      getObservedAt: (data) => data.date,
    });

    await entry.refresh();
    const stopFirstPoller = entry.addPoller('first', 60_000);
    jest.advanceTimersByTime(30_000);
    stopFirstPoller();
    jest.advanceTimersByTime(10_000);

    const stopSecondPoller = entry.addPoller('second', 60_000);
    jest.advanceTimersByTime(19_999);
    await Promise.resolve();
    expect(fetcher).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(1);
    await Promise.resolve();
    expect(fetcher).toHaveBeenCalledTimes(2);
    stopSecondPoller();
  });

  test('does not allow executable resources to opt into persisted snapshots', () => {
    expect(() => getSessionResource('portfolio::U1', {
      kind: 'live',
      persistReferenceSnapshot: { key: 'dashboard.reference.portfolio.v1', ttlMs: 60_000 },
    })).toThrow('Persisted snapshots are restricted to informational resources');
  });

  test('retains a hydrated informational snapshot during an explicit provider disconnect', async () => {
    const observedAt = new Date().toISOString();
    const storageKey = 'dashboard.reference.live-disconnect.v1';
    window.sessionStorage.setItem(storageKey, JSON.stringify({
      schemaVersion: 1,
      resourceKey: 'dashboard-quotes',
      scopeKey: 'disconnect',
      observedAt,
      persistedAt: new Date().toISOString(),
      data: { observedAt, value: 10 },
    }));
    const entry = getSessionResource('dashboard-quotes::disconnect', {
      kind: 'live',
      maxAgeMs: 60_000,
      displayRole: 'informational',
      persistReferenceSnapshot: { key: storageKey, ttlMs: 60_000 },
      retainOnRefreshFailure: true,
      fetcher: jest.fn().mockRejectedValue(
        Object.assign(new Error('IBKR gateway offline'), { code: 'GATEWAY_OFFLINE' }),
      ),
      getObservedAt: (data) => data.observedAt,
    });

    await entry.refresh();
    expect(entry.getSnapshot()).toMatchObject({
      data: { value: 10 },
      availability: 'refresh-delayed',
      error: expect.objectContaining({ code: 'GATEWAY_OFFLINE' }),
    });
  });

  test('deduplicates overlapping reads and commits one verified snapshot', async () => {
    let resolveRequest;
    const fetcher = jest.fn(() => new Promise((resolve) => { resolveRequest = resolve; }));
    const entry = getSessionResource('portfolio::U1', {
      kind: 'live',
      maxAgeMs: 45_000,
      fetcher,
      getObservedAt: (data) => data.observedAt,
    });

    const first = entry.refresh();
    const second = entry.refresh();
    expect(first).toBe(second);
    await Promise.resolve();
    expect(fetcher).toHaveBeenCalledTimes(1);

    resolveRequest({ observedAt: new Date().toISOString(), value: 42 });
    await first;

    expect(entry.getSnapshot()).toMatchObject({
      data: expect.objectContaining({ value: 42 }),
      availability: 'live',
      initialLoading: false,
      refreshing: false,
    });
  });

  test.each([
    ['ERR_NETWORK', 'Network Error'],
    ['ERR_BAD_RESPONSE', 'Request failed with status code 500'],
    ['ETIMEDOUT', 'Portfolio refresh timed out after 60000ms'],
  ])('clears executable data on %s even inside its freshness window', async (code, message) => {
    const observedAt = new Date().toISOString();
    let fail = false;
    const entry = getSessionResource('portfolio::U1', {
      kind: 'live',
      resourceClass: 'executable-live',
      accountScoped: true,
      retainOnRefreshFailure: false,
      maxAgeMs: 300_000,
      fetcher: async () => {
        if (fail) throw Object.assign(new Error(message), { code });
        return { observedAt, value: 10 };
      },
      getObservedAt: (data) => data.observedAt,
    });
    await entry.refresh();
    expect(entry.getSnapshot().availability).toBe('live');
    fail = true;
    await entry.refresh();
    expect(entry.getSnapshot()).toMatchObject({
      data: null,
      availability: 'unavailable',
      phase: 'unavailable',
      error: expect.objectContaining({ code }),
    });
    fail = false;
    await entry.refresh();
    expect(entry.getSnapshot()).toMatchObject({ data: { value: 10 }, availability: 'live' });
  });

  test('invalidates live data immediately for an explicit disconnect', async () => {
    const fetcher = jest.fn()
      .mockResolvedValueOnce({ observedAt: new Date().toISOString(), value: 10 })
      .mockRejectedValueOnce(Object.assign(new Error('IBKR gateway offline'), { code: 'GATEWAY_OFFLINE' }));
    const entry = getSessionResource('quotes::QQQ', {
      kind: 'live',
      maxAgeMs: 60_000,
      fetcher,
      getObservedAt: (data) => data.observedAt,
    });

    await entry.refresh();
    await entry.refresh();

    expect(entry.getSnapshot()).toMatchObject({
      data: null,
      availability: 'unavailable',
      error: expect.objectContaining({ code: 'GATEWAY_OFFLINE' }),
    });
  });

  test('removes a persisted informational live snapshot when invalidated', async () => {
    const storageKey = 'dashboard.reference.live-invalidation.v1';
    const fetcher = jest.fn()
      .mockResolvedValueOnce({ observedAt: new Date().toISOString(), value: 10 })
      .mockRejectedValueOnce(
        Object.assign(new Error('IBKR gateway offline'), { code: 'GATEWAY_OFFLINE' }),
      );
    const entry = getSessionResource('dashboard-quotes::persisted-invalidation', {
      kind: 'live',
      maxAgeMs: 60_000,
      displayRole: 'informational',
      persistReferenceSnapshot: { key: storageKey, ttlMs: 60_000 },
      fetcher,
      getObservedAt: (data) => data.observedAt,
    });

    await entry.refresh();
    expect(window.sessionStorage.getItem(storageKey)).not.toBeNull();

    await entry.refresh();
    expect(entry.getSnapshot()).toMatchObject({
      data: null,
      availability: 'unavailable',
      error: expect.objectContaining({ code: 'GATEWAY_OFFLINE' }),
    });
    expect(window.sessionStorage.getItem(storageKey)).toBeNull();
  });

  test('retains a fresh dashboard snapshot when opted in to refresh-failure retention', async () => {
    const fetcher = jest.fn()
      .mockResolvedValueOnce({ observedAt: new Date().toISOString(), value: 10 })
      .mockRejectedValueOnce(new Error('request timed out'));
    const entry = getSessionResource('dashboard-quotes::SPY', {
      kind: 'live',
      maxAgeMs: 60_000,
      displayRole: 'informational',
      retainOnRefreshFailure: true,
      fetcher,
      getObservedAt: (data) => data.observedAt,
    });

    await entry.refresh();
    await entry.refresh();

    expect(entry.getSnapshot()).toMatchObject({
      data: expect.objectContaining({ value: 10 }),
      availability: 'refresh-delayed',
      refreshing: false,
      error: expect.objectContaining({ message: 'request timed out' }),
    });
  });

  test('keeps a dashboard snapshot mounted while its refresh is in flight', async () => {
    let resolveRequest;
    const observedAt = new Date().toISOString();
    const fetcher = jest.fn()
      .mockResolvedValueOnce({ observedAt, value: 10 })
      .mockImplementationOnce(() => new Promise((resolve) => { resolveRequest = resolve; }));
    const entry = getSessionResource('dashboard-quotes::in-flight', {
      kind: 'live',
      maxAgeMs: 60_000,
      displayRole: 'informational',
      retainOnRefreshFailure: true,
      fetcher,
      getObservedAt: (data) => data.observedAt,
    });

    await entry.refresh();
    const refresh = entry.refresh();
    await Promise.resolve();

    expect(entry.getSnapshot()).toMatchObject({
      data: expect.objectContaining({ value: 10 }),
      availability: 'live',
      initialLoading: false,
      refreshing: true,
      error: null,
    });

    resolveRequest({ observedAt: new Date().toISOString(), value: 11 });
    await refresh;

    expect(entry.getSnapshot()).toMatchObject({
      data: expect.objectContaining({ value: 11 }),
      availability: 'live',
      refreshing: false,
    });
  });

  test.each([
    [{ fromCache: true }, 'LIVE_RESOURCE_CACHE_EVIDENCE'],
    [{ _cache: { status: 'hit' } }, 'LIVE_RESOURCE_CACHE_EVIDENCE'],
    [{ meta: { synthetic: true } }, 'LIVE_RESOURCE_SYNTHETIC_EVIDENCE'],
    [{ source: 'mock_fallback' }, 'LIVE_RESOURCE_FORBIDDEN_EVIDENCE'],
  ])('rejects forbidden live evidence centrally (%o)', async (evidence, code) => {
    const entry = getSessionResource(`quotes::forbidden-${code}-${JSON.stringify(evidence)}`, {
      kind: 'live',
      maxAgeMs: 60_000,
      fetcher: jest.fn().mockResolvedValue({
        observedAt: new Date().toISOString(),
        value: 10,
        ...evidence,
      }),
      getObservedAt: (data) => data.observedAt,
    });

    await entry.refresh();

    expect(entry.getSnapshot()).toMatchObject({
      data: null,
      availability: 'unavailable',
      error: expect.objectContaining({ code }),
    });
  });

  test('rejects a live response belonging to a different configured scope', async () => {
    const entry = getSessionResource('balance::expected-account', {
      kind: 'live',
      maxAgeMs: 60_000,
      expectedScope: 'U1',
      getScope: (data) => data.accountId,
      fetcher: jest.fn().mockResolvedValue({
        observedAt: new Date().toISOString(),
        accountId: 'U2',
        value: 10,
      }),
      getObservedAt: (data) => data.observedAt,
    });

    await entry.refresh();

    expect(entry.getSnapshot()).toMatchObject({
      data: null,
      availability: 'unavailable',
      error: expect.objectContaining({ code: 'LIVE_RESOURCE_SCOPE_MISMATCH' }),
    });
  });

  test('keeps a dated reference snapshot after refresh failure', async () => {
    const fetcher = jest.fn()
      .mockResolvedValueOnce({ date: '2026-08-05', rows: ['SPY'] })
      .mockRejectedValueOnce(new Error('reference endpoint timed out'));
    const entry = getSessionResource('reference::cftc', {
      kind: 'reference',
      fetcher,
      getObservedAt: (data) => data.date,
    });

    await entry.refresh();
    await entry.refresh();

    expect(entry.getSnapshot()).toMatchObject({
      data: { date: '2026-08-05', rows: ['SPY'] },
      availability: 'refresh-delayed',
      error: expect.objectContaining({ message: 'reference endpoint timed out' }),
    });
  });

  test('ignores a late response after invalidation', async () => {
    let resolveRequest;
    const entry = getSessionResource('portfolio::U2', {
      kind: 'live',
      maxAgeMs: 45_000,
      fetcher: () => new Promise((resolve) => { resolveRequest = resolve; }),
      getObservedAt: (data) => data.observedAt,
    });
    const request = entry.refresh();
    await Promise.resolve();
    entry.invalidate(Object.assign(new Error('Account changed'), { code: 'ACCOUNT_MISMATCH' }));
    resolveRequest({ observedAt: new Date().toISOString(), value: 100 });
    await request;

    expect(entry.getSnapshot()).toMatchObject({ data: null, availability: 'unavailable' });
  });

  test('expires live data at its authoritative freshness boundary', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-06T20:00:00.000Z'));
    const entry = getSessionResource('balance::U1', {
      kind: 'live',
      maxAgeMs: 1_000,
      fetcher: jest.fn().mockResolvedValue({
        observedAt: '2026-08-06T20:00:00.000Z',
        value: 100,
      }),
      getObservedAt: (data) => data.observedAt,
    });
    await entry.refresh();

    jest.advanceTimersByTime(1_001);

    expect(entry.getSnapshot()).toMatchObject({
      data: null,
      availability: 'unavailable',
      error: expect.objectContaining({ code: 'LIVE_RESOURCE_EXPIRED' }),
    });
  });

  test('accepts configured clock skew and rejects larger future timestamps with diagnostics', async () => {
    jest.useFakeTimers();
    const now = new Date('2026-08-17T23:59:00.000Z');
    jest.setSystemTime(now);
    const futureToleranceMs = 5 * 60 * 1000;
    const acceptedObservedAt = new Date(now.getTime() + futureToleranceMs).toISOString();
    const rejectedObservedAt = new Date(now.getTime() + futureToleranceMs + 1).toISOString();
    const accepted = getSessionResource('quotes::future-accepted', {
      kind: 'live',
      maxAgeMs: 60_000,
      futureToleranceMs,
      fetcher: jest.fn().mockResolvedValue({ observedAt: acceptedObservedAt, value: 10 }),
      getObservedAt: (data) => data.observedAt,
    });
    const rejected = getSessionResource('quotes::future-rejected', {
      kind: 'live',
      maxAgeMs: 60_000,
      futureToleranceMs,
      fetcher: jest.fn().mockResolvedValue({ observedAt: rejectedObservedAt, value: 11 }),
      getObservedAt: (data) => data.observedAt,
    });

    await accepted.refresh();
    await rejected.refresh();

    expect(accepted.getSnapshot()).toMatchObject({
      availability: 'live',
      data: { value: 10 },
      observedAt: acceptedObservedAt,
    });
    expect(rejected.getSnapshot()).toMatchObject({
      data: null,
      availability: 'unavailable',
      error: expect.objectContaining({
        code: 'LIVE_RESOURCE_FUTURE_TIMESTAMP',
        observedAt: rejectedObservedAt,
        ageMs: -(futureToleranceMs + 1),
        futureByMs: futureToleranceMs + 1,
        maxAgeMs: 60_000,
        futureToleranceMs,
        thresholdMs: futureToleranceMs,
        liveInvalidation: true,
      }),
    });
  });

  test('rejects an aged live response with its observed time and freshness threshold', async () => {
    jest.useFakeTimers();
    const now = new Date('2026-08-18T00:00:00.000Z');
    jest.setSystemTime(now);
    const observedAt = new Date(now.getTime() - 60_001).toISOString();
    const entry = getSessionResource('quotes::stale-diagnostics', {
      kind: 'live',
      maxAgeMs: 60_000,
      fetcher: jest.fn().mockResolvedValue({ observedAt, value: 10 }),
      getObservedAt: (data) => data.observedAt,
    });

    await entry.refresh();

    expect(entry.getSnapshot()).toMatchObject({
      data: null,
      availability: 'unavailable',
      error: expect.objectContaining({
        code: 'LIVE_RESOURCE_STALE',
        observedAt,
        ageMs: 60_001,
        maxAgeMs: 60_000,
        futureToleranceMs: 5_000,
        thresholdMs: 60_000,
        liveInvalidation: true,
      }),
    });
  });

  test('evicts an unused non-core resource', async () => {
    jest.useFakeTimers();
    const entry = getSessionResource('reference::temporary', {
      kind: 'reference',
      evictAfterMs: 100,
      fetcher: jest.fn().mockResolvedValue({ date: '2026-08-05' }),
    });
    const unsubscribe = entry.subscribe(() => {});
    unsubscribe();
    jest.advanceTimersByTime(101);
    expect(getSessionResourceCount()).toBe(0);
  });

  test('clears every session resource on a full store reset', () => {
    getSessionResource('reference::one', { kind: 'reference' });
    getSessionResource('reference::two', { kind: 'reference' });
    expect(getSessionResourceCount()).toBe(2);

    resetSessionResourceStore();

    expect(getSessionResourceCount()).toBe(0);
  });

  test('demotes expired informational live data to a retained reference', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-31T18:00:00.000Z'));
    const entry = getSessionResource('dashboard-quotes::retained-expiry', {
      kind: 'live',
      resourceClass: 'informational-live',
      displayRole: 'informational',
      retainOnRefreshFailure: true,
      retainAfterExpiry: true,
      maxAgeMs: 1_000,
      fetcher: jest.fn().mockResolvedValue({
        observedAt: '2026-08-31T18:00:00.000Z',
        value: 100,
      }),
      getObservedAt: (data) => data.observedAt,
    });

    await entry.refresh();
    jest.advanceTimersByTime(1_001);

    expect(entry.getSnapshot()).toMatchObject({
      data: { value: 100 },
      availability: 'delayed-reference',
      phase: 'delayed-reference',
      error: expect.objectContaining({ code: 'LIVE_RESOURCE_EXPIRED' }),
    });
  });

  test('hydrates only a mixed resource reference projection and fails live data closed', async () => {
    const storageKey = 'dashboard.reference.mixed-monitor.v1';
    const observedAt = new Date().toISOString();
    const project = (data) => ({
      marketId: data.marketId,
      observedAt: data.observedAt,
      chart: data.chart,
      referenceOnly: true,
      executionAvailable: false,
    });
    const validateReference = (data) => (
      data?.referenceOnly === true
      && data?.executionAvailable === false
      && !data?.book
        ? data
        : null
    );
    const first = getSessionResource('prediction-monitor::sp500', {
      kind: 'live',
      resourceClass: 'mixed',
      displayRole: 'mixed',
      maxAgeMs: 60_000,
      persistReferenceSnapshot: { key: storageKey, ttlMs: 60_000 },
      referenceProjection: project,
      validateReference,
      fetcher: jest.fn().mockResolvedValue({
        marketId: 'sp500',
        observedAt,
        chart: { points: [1, 2] },
        book: { yesBid: 0.55 },
      }),
      getObservedAt: (data) => data.observedAt,
    });

    await first.refresh();
    expect(first.getSnapshot().data.book.yesBid).toBe(0.55);
    expect(first.getSnapshot().referenceData).toEqual(expect.objectContaining({
      referenceOnly: true,
      executionAvailable: false,
    }));
    expect(JSON.parse(window.sessionStorage.getItem(storageKey)).data.book).toBeUndefined();

    resetSessionResourceStore();
    const second = getSessionResource('prediction-monitor::sp500', {
      kind: 'live',
      resourceClass: 'mixed',
      displayRole: 'mixed',
      maxAgeMs: 60_000,
      persistReferenceSnapshot: { key: storageKey, ttlMs: 60_000 },
      referenceProjection: project,
      validateReference,
      fetcher: jest.fn().mockRejectedValue(
        Object.assign(new Error('provider offline'), { code: 'PROVIDER_OFFLINE' }),
      ),
      getObservedAt: (data) => data.observedAt,
    });

    expect(second.getSnapshot()).toMatchObject({
      data: null,
      referenceData: { referenceOnly: true, executionAvailable: false },
      phase: 'delayed-reference',
      hydratedFromStorage: true,
    });
    await second.refresh();
    expect(second.getSnapshot()).toMatchObject({
      data: null,
      referenceData: { referenceOnly: true, executionAvailable: false },
      availability: 'delayed-reference',
      error: expect.objectContaining({ code: 'PROVIDER_OFFLINE' }),
    });
  });

  test.each(['ERR_NETWORK', 'ERR_BAD_RESPONSE', 'ETIMEDOUT'])(
    'drops mixed live books after %s and retains only validated dated context', async (code) => {
      const observedAt = new Date().toISOString();
      const verified = { observedAt, chart: { points: [1, 2] }, book: { yesBid: 0.55 } };
      const fetcher = jest.fn().mockResolvedValueOnce(verified)
        .mockRejectedValueOnce(Object.assign(new Error('verification failed'), { code }));
      const entry = getSessionResource('mixed-live-failure', {
        kind: 'live', resourceClass: 'mixed', displayRole: 'mixed', maxAgeMs: 60_000,
        fetcher, getObservedAt: (data) => data.observedAt,
        referenceProjection: (data) => ({ observedAt: data.observedAt, chart: data.chart, referenceOnly: true }),
        validateReference: (data) => data.referenceOnly === true && !data.book ? data : null,
      });
      await entry.refresh();
      expect(entry.getSnapshot().data.book).toEqual({ yesBid: 0.55 });
      await entry.refresh();
      expect(entry.getSnapshot()).toMatchObject({
        data: null,
        referenceData: { observedAt, chart: verified.chart, referenceOnly: true },
        availability: 'delayed-reference',
        error: expect.objectContaining({ code }),
      });
      expect(entry.getSnapshot().referenceData.book).toBeUndefined();
    },
  );

  test('reconciles a refreshing response before one atomic validated commit', async () => {
    const observedAt = new Date().toISOString();
    const populated = {
      schemaVersion: 1,
      observedAt,
      chart: { status: 'available', points: [1, 2, 3] },
    };
    const refreshing = {
      schemaVersion: 1,
      observedAt,
      chart: { status: 'refreshing', points: [] },
    };
    const replacement = {
      schemaVersion: 1,
      observedAt,
      chart: { status: 'available', points: [4, 5, 6, 7] },
    };
    const fetcher = jest.fn()
      .mockResolvedValueOnce(populated)
      .mockResolvedValueOnce(refreshing)
      .mockResolvedValueOnce(replacement);
    const reconcileIncoming = jest.fn(({
      currentData,
      currentReferenceData,
      incomingData,
    }) => incomingData.chart.status === 'refreshing'
      ? { ...incomingData, chart: currentData?.chart || currentReferenceData?.chart }
      : incomingData);
    const validate = (value) => (
      value?.schemaVersion === 1 && Array.isArray(value?.chart?.points) ? value : null
    );
    const entry = getSessionResource('reconciled-chart::gold', {
      kind: 'live',
      resourceClass: 'informational-live',
      displayRole: 'informational',
      maxAgeMs: 60_000,
      fetcher,
      validate,
      reconcileIncoming,
      getObservedAt: (data) => data.observedAt,
    });

    await entry.refresh();
    await entry.refresh();
    expect(entry.getSnapshot()).toMatchObject({
      data: { chart: { status: 'available', points: [1, 2, 3] } },
      availability: 'live',
      refreshing: false,
    });
    expect(reconcileIncoming).toHaveBeenLastCalledWith(expect.objectContaining({
      currentData: populated,
      currentReferenceData: null,
      incomingData: refreshing,
      raw: refreshing,
      nowMs: expect.any(Number),
    }));

    await entry.refresh();
    expect(entry.getSnapshot().data.chart.points).toEqual([4, 5, 6, 7]);
  });

  test('revalidates reconciled output and keeps the last verified informational value on failure', async () => {
    const observedAt = new Date().toISOString();
    const fetcher = jest.fn().mockResolvedValue({
      schemaVersion: 1,
      observedAt,
      chart: { status: 'available', points: [1, 2] },
    });
    const entry = getSessionResource('reconciled-chart::invalid', {
      kind: 'live',
      resourceClass: 'informational-live',
      displayRole: 'informational',
      retainOnRefreshFailure: true,
      maxAgeMs: 60_000,
      fetcher,
      validate: (value) => (
        value?.schemaVersion === 1 && Array.isArray(value?.chart?.points) ? value : null
      ),
      reconcileIncoming: ({ currentData, incomingData }) => (
        currentData ? { ...incomingData, chart: null } : incomingData
      ),
      getObservedAt: (data) => data.observedAt,
    });

    await entry.refresh();
    await entry.refresh();
    expect(entry.getSnapshot()).toMatchObject({
      data: { chart: { points: [1, 2] } },
      availability: 'refresh-delayed',
      error: expect.objectContaining({ code: 'RESOURCE_DATA_MISSING' }),
    });
  });

  test('rejects storage and stale retention for account-scoped resources', () => {
    expect(() => getSessionResource('account-reference::U1', {
      kind: 'reference',
      resourceClass: 'dated-reference',
      displayRole: 'informational',
      accountScoped: true,
      persistReferenceSnapshot: {
        key: 'dashboard.reference.account.v1',
        ttlMs: 60_000,
      },
    })).toThrow('Account-scoped resources cannot be stored');

    expect(() => getSessionResource('account-live::U1', {
      kind: 'live',
      resourceClass: 'executable-live',
      accountScoped: true,
      retainOnRefreshFailure: true,
    })).toThrow('Executable resources cannot retain stale data');
  });
});
