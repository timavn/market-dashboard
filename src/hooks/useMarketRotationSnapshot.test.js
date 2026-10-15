import { act, renderHook, waitFor } from '@testing-library/react';
import catalog from '../constants/marketRotationCatalog.json';
import useMarketRotationSnapshot, {
  MARKET_ROTATION_POLL_INTERVAL_MS,
  MARKET_ROTATION_REQUEST_TIMEOUT_MS,
  MARKET_ROTATION_STORAGE_KEY,
  validateMarketRotationPair,
  validateMarketRotationQuote,
  validateMarketRotationSnapshot,
} from './useMarketRotationSnapshot';

const NOW = Date.parse('2026-09-24T15:00:00Z');
const iso = (time) => new Date(time).toISOString();
const definitions = [...catalog.themes, ...catalog.instruments];
const quote = (ticker, changePercent = 1, overrides = {}) => ({
  ...definitions.find((row) => row.ticker === ticker),
  changePercent,
  source: 'Yahoo Finance', sourceUrl: `https://finance.yahoo.com/quote/${ticker}`,
  asOf: iso(NOW - 60_000), expiresAt: iso(NOW + 10 * 60_000),
  status: 'delayed', marketDate: '2026-09-24', proxy: true,
  ...overrides,
});
const pair = (index = 0, overrides = {}) => {
  const definition = catalog.factors[index];
  return {
    id: definition.id, label: definition.label,
    left: quote(definition.left, 1.25), right: quote(definition.right, 0.5), spreadPp: 0.75,
    asOf: iso(NOW - 60_000), expiresAt: iso(NOW + 10 * 60_000),
    source: 'Yahoo Finance', status: 'delayed', marketDate: '2026-09-24', proxy: true,
    ...overrides,
  };
};
const fixture = () => ({
  status: 'available', loading: false, source: 'Yahoo Finance', proxy: true,
  asOf: iso(NOW - 60_000), expiresAt: iso(NOW + 10 * 60_000),
  themes: {
    software: quote('IGV', 1.1), semiconductors: quote('SMH', -0.6),
    leader: quote('URA', 2.2), laggard: quote('TAN', -1.5),
    coverage: { verified: catalog.themes.length, total: catalog.themes.length, comparable: true, expiresAt: iso(NOW + 10 * 60_000) },
  },
  factors: catalog.factors.map((_, index) => pair(index)),
});
const response = (value, ok = true) => ({ ok, json: async () => value });
const rankedFixture = () => {
  const value = fixture();
  const anchors = [value.themes.software, value.themes.semiconductors, value.themes.leader, value.themes.laggard];
  value.themes.ranked = catalog.themes.map((definition) => anchors.find((row) => row.id === definition.id)
    || quote(definition.ticker, 0.2)).sort((left, right) => right.changePercent - left.changePercent
      || left.ticker.localeCompare(right.ticker));
  return value;
};

describe('market rotation evidence', () => {
  test('accepts complete verified themes and factor instruments without fabricated ids', () => {
    const value = fixture();
    expect(value.factors[0].left.id).toBeUndefined();
    expect(validateMarketRotationSnapshot(value, NOW)).toEqual({ ...value, themes: { ...value.themes, ranked: [] } });
    expect(validateMarketRotationQuote(value.factors[0].left, NOW)).toEqual(value.factors[0].left);
  });

  test('accepts the exact complete ranked theme roster and retains its observation evidence', () => {
    const value = rankedFixture();
    const verified = validateMarketRotationSnapshot(value, NOW);
    expect(verified).toEqual(value);
    expect(verified.themes.ranked).toHaveLength(catalog.themes.length);
    expect(verified.themes.ranked[0]).toEqual(verified.themes.leader);
    expect(verified.themes.ranked.at(-1)).toEqual(verified.themes.laggard);
  });

  test.each([
    { stale: true }, { expiresAt: iso(NOW) }, { cacheOnly: true }, { cached: true },
    { mock: true }, { seeded: true }, { offline: true }, { refreshFailed: true },
    { meta: { cacheOnly: true } }, { source: '' }, { sourceUrl: null },
    { marketDate: '2026-09-23' }, { status: 'last-close' }, { asOf: iso(NOW - 22 * 60_000) },
  ])('withholds ranked themes when one roster observation is unusable: %p', (patch) => {
    const value = rankedFixture();
    value.themes.ranked = value.themes.ranked.map((row) => row.id === 'retail' ? { ...row, ...patch } : row);
    const verified = validateMarketRotationSnapshot(value, NOW);
    expect(verified.themes.ranked).toEqual([]);
    expect(verified.themes.leader).toBeNull();
    expect(verified.themes.laggard).toBeNull();
    expect(verified.themes.software).toEqual(value.themes.software);
    expect(verified.factors[0].spreadPp).toBe(0.75);
  });

  test('withholds partial, duplicate, incorrectly ordered and contradictory theme rankings', () => {
    const variants = [
      (value) => { value.themes.ranked.pop(); },
      (value) => { value.themes.ranked[3] = value.themes.ranked[2]; },
      (value) => { value.themes.ranked[3] = quote('IWF'); },
      (value) => { value.themes.ranked.reverse(); },
      (value) => { [value.themes.ranked[3], value.themes.ranked[4]] = [value.themes.ranked[4], value.themes.ranked[3]]; },
      (value) => { value.themes.ranked[0] = { ...value.themes.ranked[0], changePercent: 2.3 }; },
      (value) => { value.themes.ranked[1] = { ...value.themes.ranked[1], asOf: iso(NOW - 2 * 60_000) }; },
      (value) => { value.themes.coverage.verified = 9; },
      (value) => { value.themes.coverage.comparable = false; },
    ];
    for (const mutate of variants) {
      const value = rankedFixture();
      mutate(value);
      const verified = validateMarketRotationSnapshot(value, NOW);
      expect(verified.themes.ranked).toEqual([]);
      expect(verified.themes.leader).toBeNull();
      expect(verified.themes.laggard).toBeNull();
      expect(verified.themes.software.changePercent).toBe(1.1);
      expect(verified.factors[0].spreadPp).toBe(0.75);
    }
  });

  test.each([
    { stale: true }, { isStale: true }, { mock: true }, { isMock: true }, { seed: true },
    { seeded: true }, { synthetic: true }, { inferred: true }, { fromCache: true },
    { cacheOnly: true }, { offline: true }, { disconnected: true }, { connected: false },
    { _cache: { hit: true } }, { meta: { cacheOnly: true } }, { freshness: 'stale' },
  ])('rejects provider contamination at the affected evidence boundary: %p', (flags) => {
    const value = fixture();
    expect(validateMarketRotationSnapshot({ ...value, ...flags }, NOW)).toBeNull();
    value.themes.software = { ...value.themes.software, ...flags };
    value.factors[0].left = { ...value.factors[0].left, ...flags };
    const verified = validateMarketRotationSnapshot(value, NOW);
    expect(verified.themes.software).toBeNull();
    expect(verified.themes.semiconductors).toEqual(value.themes.semiconductors);
    expect(verified.factors[0]).toMatchObject({ left: null, spreadPp: null, status: 'unavailable' });
    expect(verified.factors[1].spreadPp).toBe(0.75);
  });

  test('keeps independent slots when one factor is unavailable or absent', () => {
    const value = fixture();
    value.factors[0] = pair(0, { left: null, spreadPp: null, status: 'unavailable', asOf: null, expiresAt: null });
    value.factors.pop();
    const verified = validateMarketRotationSnapshot(value, NOW);
    expect(verified.status).toBe('partial');
    expect(verified.themes.software.changePercent).toBe(1.1);
    expect(verified.factors).toHaveLength(catalog.factors.length);
    expect(verified.factors[0]).toMatchObject({ left: null, right: value.factors[0].right, spreadPp: null });
    expect(verified.factors[1].spreadPp).toBe(0.75);
    expect(verified.factors[3]).toMatchObject({ left: null, right: null, spreadPp: null, status: 'unavailable' });
  });

  test('requires full comparable coverage before displaying theme ranks', () => {
    for (const coverage of [
      { verified: 9, total: 10, comparable: true },
      { verified: 10, total: 10, comparable: false },
      { verified: 9, total: 9, comparable: true },
    ]) {
      const value = fixture();
      value.themes.coverage = coverage;
      const verified = validateMarketRotationSnapshot(value, NOW);
      expect(verified.themes).toMatchObject({ software: value.themes.software, leader: null, laggard: null });
    }
  });

  test('permits the daily theme freshness window while preserving the stricter factor comparison window', () => {
    const value = fixture();
    value.themes.leader.asOf = iso(NOW - 7 * 60_000);
    expect(validateMarketRotationSnapshot(value, NOW).themes.leader).toEqual(value.themes.leader);
    value.factors[0].left.asOf = iso(NOW - 7 * 60_000);
    expect(validateMarketRotationSnapshot(value, NOW).factors[0].spreadPp).toBeNull();
  });

  test('rejects mismatched dates, sessions, leg identities, and unsupported spreads', () => {
    const variants = [
      { right: quote('IWD', 0.5, { marketDate: '2026-09-23' }) },
      { right: quote('IWD', 0.5, { status: 'last-close' }) },
      { right: quote('SPY', 0.5) },
      { right: quote('IWD', 0.5, { asOf: iso(NOW - 6 * 60_000 - 1) }) },
      { spreadPp: 0.8 }, { spreadPp: null }, { spreadPp: '' },
      { asOf: iso(NOW) },
    ];
    for (const overrides of variants) {
      expect(validateMarketRotationPair(pair(0, overrides), NOW)).toMatchObject({ spreadPp: null, status: 'unavailable' });
    }
    expect(validateMarketRotationPair(pair(0, { left: quote('IWF', 0.5), spreadPp: 0 }), NOW).spreadPp).toBe(0);
  });

  test.each(['left', 'right'])('withholds a wrong-identity %s factor leg while retaining the correct independent quote', (side) => {
    const value = pair(0, { [side]: quote('SPY', 0.5) });
    const other = side === 'left' ? 'right' : 'left';
    const verified = validateMarketRotationPair(value, NOW);
    expect(verified).toMatchObject({ [side]: null, [other]: value[other], spreadPp: null, status: 'unavailable' });
  });

  test('requires row numbers, timestamps, source links, and catalog identity without coercing null to zero', () => {
    const invalid = [
      { changePercent: null }, { changePercent: '' }, { changePercent: NaN },
      { changePercent: '1.1' }, { source: '' }, { sourceUrl: null },
      { sourceUrl: 'https://' }, { issuerUrl: '' }, { proxy: false },
      { ticker: 'UNKNOWN' }, { id: 'biotech' },
      { asOf: iso(NOW + 5_001) }, { expiresAt: iso(NOW) }, { marketDate: '2026-02-30' },
    ];
    for (const overrides of invalid) {
      expect(validateMarketRotationQuote(quote('IGV', 1, overrides), NOW)).toBeNull();
    }
    expect(validateMarketRotationQuote(quote('IGV', 0), NOW).changePercent).toBe(0);
    expect(validateMarketRotationSnapshot({ ...fixture(), expiresAt: iso(NOW) }, NOW)).toBeNull();
  });

  test('keeps a legitimate zero spread and rejects an invented zero for a missing leg', () => {
    const value = fixture();
    value.factors[0] = pair(0, { left: quote('IWF', 0.5), spreadPp: 0 });
    expect(validateMarketRotationSnapshot(value, NOW).factors[0].spreadPp).toBe(0);
    value.factors[0].right = null;
    expect(validateMarketRotationSnapshot(value, NOW).factors[0].spreadPp).toBeNull();
  });
});

describe('useMarketRotationSnapshot', () => {
  let originalFetch;
  let visibility;
  beforeEach(() => {
    window.localStorage.clear();
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
    originalFetch = global.fetch;
    visibility = jest.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  });
  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  test('requests fresh observations with an abort signal and performs no requests when disabled', async () => {
    global.fetch = jest.fn().mockResolvedValue(response(fixture()));
    const { result, rerender, unmount } = renderHook(({ enabled }) => useMarketRotationSnapshot({ enabled }), {
      initialProps: { enabled: false },
    });
    expect(global.fetch).not.toHaveBeenCalled();
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.snapshot?.status).toBe('available'));
    expect(global.fetch).toHaveBeenCalledWith('/api/market/rotation-snapshot', {
      cache: 'no-store', signal: expect.any(AbortSignal),
    });
    rerender({ enabled: false });
    expect(result.current.snapshot).toBeNull();
    expect(result.current.loading).toBe(false);
    unmount();
  });

  test.each(['network', 'http', 'invalid'])('retains prior readings after a %s failure', async (failure) => {
    const fetcher = jest.fn().mockResolvedValueOnce(response(fixture()));
    if (failure === 'network') fetcher.mockRejectedValueOnce(new Error('Offline'));
    if (failure === 'http') fetcher.mockResolvedValueOnce(response({}, false));
    if (failure === 'invalid') fetcher.mockResolvedValueOnce(response({ ...fixture(), cacheOnly: true }));
    global.fetch = fetcher;
    const { result, unmount } = renderHook(() => useMarketRotationSnapshot());
    await waitFor(() => expect(result.current.snapshot).not.toBeNull());
    await act(async () => { window.dispatchEvent(new Event('online')); });
    expect(result.current.snapshot).toMatchObject({ retained: true, asOf: iso(NOW - 60_000),
      themes: { software: { changePercent: 1.1, retained: true } } });
    expect(result.current.loading).toBe(false);
    unmount();
  });

  test('retains the snapshot while a refresh is silent and does not manufacture new timestamps', async () => {
    global.fetch = jest.fn().mockResolvedValue(response({ ...fixture(), expiresAt: iso(NOW + 1_000) }));
    const { result, unmount } = renderHook(() => useMarketRotationSnapshot());
    await waitFor(() => expect(result.current.snapshot?.asOf).toBe(iso(NOW - 60_000)));
    act(() => jest.advanceTimersByTime(1_001));
    expect(result.current.snapshot).toMatchObject({ retained: true, asOf: iso(NOW - 60_000) });
    unmount();
  });

  test('retains an expired individual factor leg without clearing unrelated verified themes', async () => {
    const value = fixture();
    value.factors[0].left.expiresAt = iso(NOW + 1_000);
    global.fetch = jest.fn().mockResolvedValue(response(value));
    const { result, unmount } = renderHook(() => useMarketRotationSnapshot());
    await waitFor(() => expect(result.current.snapshot?.factors[0].spreadPp).toBe(0.75));
    act(() => jest.advanceTimersByTime(1_001));
    expect(result.current.snapshot.factors[0]).toMatchObject({ left: { retained: true }, spreadPp: 0.75, status: 'delayed', retained: true });
    expect(result.current.snapshot.themes.software.changePercent).toBe(1.1);
    expect(result.current.snapshot.factors[1].spreadPp).toBe(0.75);
    unmount();
  });

  test('retains expired complete-roster rankings while keeping fresh fixed themes and factors', async () => {
    const value = fixture();
    value.themes.coverage.expiresAt = iso(NOW + 1_000);
    global.fetch = jest.fn().mockResolvedValue(response(value));
    const { result, unmount } = renderHook(() => useMarketRotationSnapshot());
    await waitFor(() => expect(result.current.snapshot?.themes.leader?.ticker).toBe('URA'));
    act(() => jest.advanceTimersByTime(1_001));
    expect(result.current.snapshot.themes).toMatchObject({ leader: { ticker: 'URA', retained: true }, laggard: { ticker: 'TAN', retained: true } });
    expect(result.current.snapshot.themes.software.changePercent).toBe(1.1);
    expect(result.current.snapshot.factors[0].spreadPp).toBe(0.75);
    expect(result.current.snapshot.status).toBe('available');
    const snapshotAfterExpiry = result.current.snapshot;
    act(() => jest.advanceTimersByTime(10_000));
    expect(result.current.snapshot).toBe(snapshotAfterExpiry);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    unmount();
  });

  test('retains rankings when an expanded-only observation expires before the coverage timestamp', async () => {
    const value = rankedFixture();
    value.themes.ranked = value.themes.ranked.map((row) => row.id === 'retail'
      ? { ...row, expiresAt: iso(NOW + 1_000) } : row);
    global.fetch = jest.fn().mockResolvedValue(response(value));
    const { result, unmount } = renderHook(() => useMarketRotationSnapshot());
    await waitFor(() => expect(result.current.snapshot?.themes.ranked).toHaveLength(catalog.themes.length));
    expect(result.current.snapshot.themes.coverage.expiresAt).toBe(iso(NOW + 1_000));
    act(() => jest.advanceTimersByTime(1_001));
    expect(result.current.snapshot.themes.ranked).toHaveLength(catalog.themes.length);
    expect(result.current.snapshot.themes.leader).toMatchObject({ ticker: 'URA', retained: true });
    expect(result.current.snapshot.themes.software.changePercent).toBe(1.1);
    expect(result.current.snapshot.factors[0].spreadPp).toBe(0.75);
    const afterExpiry = result.current.snapshot;
    act(() => jest.advanceTimersByTime(10_000));
    expect(result.current.snapshot).toBe(afterExpiry);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    unmount();
  });

  test('times out and retains readings even when the pending transport ignores abort', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce(response(fixture()))
      .mockImplementationOnce(() => new Promise(() => {}));
    const { result, unmount } = renderHook(() => useMarketRotationSnapshot());
    await waitFor(() => expect(result.current.snapshot).not.toBeNull());
    await act(async () => { window.dispatchEvent(new Event('online')); });
    const signal = global.fetch.mock.calls[1][1].signal;
    await act(async () => { jest.advanceTimersByTime(MARKET_ROTATION_REQUEST_TIMEOUT_MS); });
    expect(signal.aborted).toBe(true);
    expect(result.current.snapshot).toMatchObject({ retained: true, asOf: iso(NOW - 60_000) });
    expect(result.current.loading).toBe(false);
    unmount();
  });

  test('keeps complete comparisons through partial refreshes without recombining their old and new legs', async () => {
    const first = rankedFixture();
    const next = fixture();
    next.themes.software = quote('IGV', 9, { asOf: iso(NOW) });
    next.themes.leader = null;
    next.themes.laggard = null;
    next.themes.coverage.verified = 9;
    next.themes.coverage.comparable = false;
    next.factors[0].left = quote('IWF', 9, { asOf: iso(NOW) });
    next.factors[0].right = null;
    next.factors[0].spreadPp = null;
    next.factors[0].status = 'unavailable';
    global.fetch = jest.fn().mockResolvedValueOnce(response(first)).mockResolvedValueOnce(response(next));
    const { result, unmount } = renderHook(() => useMarketRotationSnapshot());
    await waitFor(() => expect(result.current.snapshot?.themes.ranked).toHaveLength(catalog.themes.length));
    await act(async () => { window.dispatchEvent(new Event('online')); });
    expect(result.current.snapshot.themes.software).toMatchObject({ changePercent: 9, asOf: iso(NOW) });
    expect(result.current.snapshot.themes.ranked.find(row => row.id === 'software')).toMatchObject({ changePercent: 1.1, retained: true });
    expect(result.current.snapshot.themes.leader).toMatchObject({ ticker: 'URA', retained: true });
    expect(result.current.snapshot.factors[0]).toMatchObject({ spreadPp: 0.75, retained: true,
      left: { changePercent: 1.25, asOf: iso(NOW - 60_000) }, right: { changePercent: 0.5 } });
    const stored = JSON.parse(window.localStorage.getItem(MARKET_ROTATION_STORAGE_KEY));
    expect(stored.snapshot.themes.software.changePercent).toBe(9);
    expect(stored.snapshot.factors[0].spreadPp).toBe(0.75);
    unmount();
    jest.setSystemTime(NOW + 90 * 24 * 60 * 60_000);
    global.fetch = jest.fn().mockRejectedValue(new Error('Offline'));
    const { result: restoredResult, unmount: unmountRestored } = renderHook(() => useMarketRotationSnapshot());
    expect(restoredResult.current.snapshot.themes.software.changePercent).toBe(9);
    expect(restoredResult.current.snapshot.themes.ranked).toHaveLength(catalog.themes.length);
    expect(restoredResult.current.snapshot.factors[0].spreadPp).toBe(0.75);
    expect(restoredResult.current.snapshot.themes.software.asOf).toBe(iso(NOW));
    await waitFor(() => expect(restoredResult.current.loading).toBe(false));
    unmountRestored();
  });

  test('restores the last verified readings after reload and API failure without age-based deletion', async () => {
    global.fetch = jest.fn().mockResolvedValue(response(rankedFixture()));
    const { result: initialResult, unmount: unmountInitial } = renderHook(() => useMarketRotationSnapshot());
    await waitFor(() => expect(initialResult.current.snapshot?.status).toBe('available'));
    const original = initialResult.current.snapshot;
    unmountInitial();
    jest.setSystemTime(NOW + 90 * 24 * 60 * 60_000);
    global.fetch = jest.fn().mockRejectedValue(new Error('Offline'));
    const { result: restoredResult, unmount: unmountRestored } = renderHook(() => useMarketRotationSnapshot());
    expect(restoredResult.current.snapshot).toMatchObject({ retained: true, asOf: original.asOf,
      themes: { software: { changePercent: 1.1, marketDate: '2026-09-24', retained: true } } });
    expect(restoredResult.current.snapshot.themes.ranked).toHaveLength(catalog.themes.length);
    await waitFor(() => expect(restoredResult.current.loading).toBe(false));
    expect(restoredResult.current.snapshot.factors[0].spreadPp).toBe(0.75);
    unmountRestored();
  });

  test.each([{ mock: true }, { seeded: true }, { inferred: true }, { cacheOnly: true },
    { offline: true }, { stale: true }, { refreshFailed: true }])('rejects flagged evidence even when saved as retained: %p', async (patch) => {
    window.localStorage.setItem(MARKET_ROTATION_STORAGE_KEY, JSON.stringify({ schemaVersion: 1,
      snapshot: { ...rankedFixture(), ...patch, retained: true, verifiedAt: iso(NOW) } }));
    global.fetch = jest.fn().mockRejectedValue(new Error('Offline'));
    const { result, unmount } = renderHook(() => useMarketRotationSnapshot());
    expect(result.current.snapshot).toBeNull();
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.snapshot).toBeNull();
    unmount();
  });

  test('does not promote saved unverified data or let an older verified response overwrite newer readings', async () => {
    window.localStorage.setItem(MARKET_ROTATION_STORAGE_KEY, JSON.stringify({ schemaVersion: 1, snapshot: rankedFixture() }));
    global.fetch = jest.fn().mockResolvedValueOnce(response(fixture()));
    const { result, unmount } = renderHook(() => useMarketRotationSnapshot());
    expect(result.current.snapshot).toBeNull();
    await waitFor(() => expect(result.current.snapshot?.status).toBe('available'));
    const older = JSON.parse(JSON.stringify(fixture()).replaceAll(iso(NOW - 60_000), iso(NOW - 120_000)));
    older.themes.software.changePercent = 7;
    older.factors[0].left.changePercent = 9;
    older.factors[0].spreadPp = 8.5;
    global.fetch.mockResolvedValueOnce(response(older));
    await act(async () => { window.dispatchEvent(new Event('online')); });
    expect(result.current.snapshot.themes.software).toMatchObject({ changePercent: 1.1, asOf: iso(NOW - 60_000), retained: true });
    expect(result.current.snapshot.factors[0]).toMatchObject({ spreadPp: 0.75, asOf: iso(NOW - 60_000), retained: true });
    unmount();
  });

  test('an identical provider observation after reload keeps retained markers and original verification times', async () => {
    const original = rankedFixture();
    global.fetch = jest.fn().mockResolvedValue(response(original));
    const { result: initialResult, unmount: unmountInitial } = renderHook(() => useMarketRotationSnapshot());
    await waitFor(() => expect(initialResult.current.snapshot?.status).toBe('available'));
    const accepted = initialResult.current.snapshot;
    unmountInitial();
    jest.setSystemTime(NOW + 2 * 60_000);
    const { result, unmount } = renderHook(() => useMarketRotationSnapshot());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.snapshot.retained).toBe(true);
    expect(result.current.snapshot.themes.software).toMatchObject({ retained: true,
      asOf: accepted.themes.software.asOf, verifiedAt: accepted.themes.software.verifiedAt });
    expect(result.current.snapshot.themes.coverage).toMatchObject({ retained: true,
      verifiedAt: accepted.themes.coverage.verifiedAt });
    expect(result.current.snapshot.themes.ranked).toEqual(accepted.themes.ranked.map(row => ({ ...row, retained: true })));
    expect(result.current.snapshot.factors[0]).toMatchObject({ retained: true,
      asOf: accepted.factors[0].asOf, verifiedAt: accepted.factors[0].verifiedAt,
      left: { retained: true, verifiedAt: accepted.factors[0].left.verifiedAt },
      right: { retained: true, verifiedAt: accepted.factors[0].right.verifiedAt } });
    const saved = JSON.parse(window.localStorage.getItem(MARKET_ROTATION_STORAGE_KEY)).snapshot;
    expect(saved.themes.software.verifiedAt).toBe(accepted.themes.software.verifiedAt);
    expect(saved.factors[0].retained).toBe(true);
    unmount();
  });

  test('a newer complete verified response replaces retained groups and clears their retained marker', async () => {
    const old = rankedFixture();
    global.fetch = jest.fn().mockResolvedValueOnce(response(old)).mockRejectedValueOnce(new Error('Offline'));
    const { result, unmount } = renderHook(() => useMarketRotationSnapshot());
    await waitFor(() => expect(result.current.snapshot?.status).toBe('available'));
    await act(async () => { window.dispatchEvent(new Event('online')); });
    expect(result.current.snapshot.retained).toBe(true);
    const newer = JSON.parse(JSON.stringify(rankedFixture()).replaceAll(iso(NOW - 60_000), iso(NOW)));
    newer.themes.software.changePercent = 1.3;
    newer.themes.ranked = newer.themes.ranked.map(row => row.id === 'software' ? newer.themes.software : row);
    global.fetch.mockResolvedValueOnce(response(newer));
    await act(async () => { window.dispatchEvent(new Event('online')); });
    expect(result.current.snapshot.retained).toBe(false);
    expect(result.current.snapshot.themes.software.changePercent).toBe(1.3);
    expect(result.current.snapshot.themes.ranked.every(row => row.retained !== true)).toBe(true);
    unmount();
  });

  test('waits while hidden, resumes when visible, polls once per interval, and cleans up', async () => {
    visibility.mockReturnValue('hidden');
    global.fetch = jest.fn().mockResolvedValue(response(fixture()));
    const { result, unmount } = renderHook(() => useMarketRotationSnapshot());
    expect(global.fetch).not.toHaveBeenCalled();
    act(() => jest.advanceTimersByTime(MARKET_ROTATION_POLL_INTERVAL_MS));
    expect(global.fetch).not.toHaveBeenCalled();
    visibility.mockReturnValue('visible');
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(result.current.snapshot).not.toBeNull();
    expect(global.fetch).toHaveBeenCalledTimes(1);
    await act(async () => { jest.advanceTimersByTime(MARKET_ROTATION_POLL_INTERVAL_MS); });
    expect(global.fetch).toHaveBeenCalledTimes(2);
    const signal = global.fetch.mock.calls[1][1].signal;
    unmount();
    expect(signal.aborted).toBe(true);
    act(() => {
      window.dispatchEvent(new Event('online'));
      document.dispatchEvent(new Event('visibilitychange'));
      jest.advanceTimersByTime(MARKET_ROTATION_POLL_INTERVAL_MS);
    });
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
});
