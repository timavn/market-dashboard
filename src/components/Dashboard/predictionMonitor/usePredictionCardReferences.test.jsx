import { act } from 'react';
import { renderHook } from '@testing-library/react';
import useMomoTrackerReference from './useMomoTrackerReference';
import useGoldCorrelationReference from './useGoldCorrelationReference';
import useCpiBenchmarkReference from './useCpiBenchmarkReference';
import { currentMomoSpot } from './momoTrackerContext';
import { MarketDataService } from '../../../services/api/marketDataService';
import predictionMarketsIngestService from '../../../services/api/predictionMarketsIngestService';
import { getSessionResourceCount, resetSessionResourceStore } from '../../../utils/sessionResourceStore';

jest.mock('react-dom/test-utils', () => ({
  ...jest.requireActual('react-dom/test-utils'),
  act: jest.requireActual('react').act,
}));
jest.mock('../../../services/api/marketDataService', () => ({
  MarketDataService: {
    getHedgeyeSnapshot: jest.fn(),
    getQuotes: jest.fn(),
    getProviderStatus: jest.fn(),
    getGoldCorrelations: jest.fn(),
  },
}));
jest.mock('../../../services/api/predictionMarketsIngestService', () => ({
  __esModule: true,
  default: { getCpiBenchmarks: jest.fn() },
}));

// Real resource hooks, registry, session store, polling and domain validators.
// Only provider calls are mocked; fixtures cannot enter a runtime code path.
const NOW = Date.parse('2026-09-10T18:00:00.000Z');
const RELEASE = '2026-09-11T12:30:00.000Z';
const TICKERS = ['MSFT', 'AAPL', 'AMZN', 'META', 'GOOGL', 'NFLX', 'TSLA', 'NVDA', 'SNDK'];
const momoProps = { active: true, normalizedMarketId: 'sp500', chartRange: '1d' };
const goldProps = { active: true, normalizedMarketId: 'gold', chartRange: '1d', clockMs: NOW };
const cpiProps = { active: true, normalizedMarketId: 'cpi', forecastComparison: { reportMonth: '2026-08', releaseAt: RELEASE } };
const originalHidden = Object.getOwnPropertyDescriptor(document, 'hidden');
const previousRetention = process.env.REACT_APP_DASHBOARD_SESSION_RETENTION;
let hidden = false;

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};
const flush = async () => { await act(async () => { await Promise.resolve(); }); };
const advance = async (ms) => { await act(async () => { jest.advanceTimersByTime(ms); }); };
const visibility = async (nextHidden) => {
  hidden = nextHidden;
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
};
const publication = (overrides = {}) => ({
  snapshotType: 'momo-tracker', date: '2026-09-10',
  publishedAt: new Date(NOW - 60_000).toISOString(),
  data: Object.fromEntries(TICKERS.map((ticker, index) => [ticker, {
    buyTrade: 100 + index, sellTrade: 120 + index,
    upside: 5, downside: -5, trend: 'BULLISH', rangeStatus: 'available', index,
  }])),
  ...overrides,
});
const quotes = (overrides = {}) => Object.fromEntries(TICKERS.map((symbol, index) => [symbol, {
  symbol, last: 110 + index, source: 'ibkr', dataType: 'live',
  timestamp: new Date(Date.now()).toISOString(), entitlementStatus: 'entitled',
  ...overrides,
}]));
const gold = (overrides = {}) => ({
  status: 'partial', method: 'pearson_completed_daily_changes',
  horizons: ['15D', '30D', '90D', '120D', '180D'],
  timestamp: new Date(Date.now()).toISOString(),
  basis: { status: 'available', symbol: 'XAUUSD', role: 'proxy', source: 'IBKR completed daily midpoint bars', asOf: '2026-09-09' },
  rows: [{
    key: 'DXY', status: 'available', source: 'Yahoo Finance completed daily closes',
    transform: 'price_return', asOf: '2026-09-09', observations: 180,
    latest: { value: 98.4, unit: 'index', asOf: '2026-09-09' },
    values: { '15D': -0.7, '30D': -0.6, '90D': -0.5, '120D': -0.4, '180D': -0.3 },
  }],
  ...overrides,
});
const benchmark = (period = '2026-08', releaseAt = RELEASE, overrides = {}) => ({
  period, metric: 'headline-cpi-yoy', unit: 'percent', fetchedAt: new Date(Date.now()).toISOString(),
  sources: [{ id: 'street', status: 'available', kind: 'consensus', point: '3.04', period, releaseAt, source: 'Trading Economics' }],
  ...overrides,
});

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
  process.env.REACT_APP_DASHBOARD_SESSION_RETENTION = 'true';
  hidden = false;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  resetSessionResourceStore();
  window.sessionStorage.clear();
  jest.resetAllMocks();
  MarketDataService.getHedgeyeSnapshot.mockImplementation(async () => publication());
  MarketDataService.getQuotes.mockImplementation(async () => quotes());
  MarketDataService.getProviderStatus.mockResolvedValue({ ibkr: { connected: true } });
  MarketDataService.getGoldCorrelations.mockImplementation(async () => gold());
  predictionMarketsIngestService.getCpiBenchmarks.mockImplementation(async (month) => benchmark(month));
});

afterEach(() => {
  resetSessionResourceStore();
  window.sessionStorage.clear();
  jest.useRealTimers();
  if (originalHidden) Object.defineProperty(document, 'hidden', originalHidden);
  else delete document.hidden;
  if (previousRetention === undefined) delete process.env.REACT_APP_DASHBOARD_SESSION_RETENTION;
  else process.env.REACT_APP_DASHBOARD_SESSION_RETENTION = previousRetention;
});

describe('MOMO reference lifecycle', () => {
  test('polls displayed contributors without GOOG independently of a missing MOMO report and clears failed live refreshes', async () => {
    MarketDataService.getHedgeyeSnapshot.mockResolvedValue({ status: 'unavailable' });
    const contributorTickers = ['NVDA', 'AAPL', 'MSFT', 'AMZN', 'GOOGL', 'AVGO', 'GOOG', 'META', 'MU', 'TSLA'];
    const contributors = { status: 'available', rows: contributorTickers.map((ticker) => ({ ticker })) };
    const { result } = renderHook(useMomoTrackerReference, { initialProps: { ...momoProps, contributors } });
    await flush();
    // MOMO additions come only from a current publication; none is fixed in code.
    expect(MarketDataService.getQuotes).toHaveBeenCalledWith(contributorTickers.filter((ticker) => ticker !== 'GOOG'));
    expect(result.current.snapshot).toBeNull();
    expect(result.current.spots.MSFT.status).toBe('live');
    MarketDataService.getQuotes.mockRejectedValueOnce(new Error('offline'));
    await advance(15_000);
    expect(result.current.spots).toEqual({});
  });

  test('loads SNOW research and independently polls each current MOMO addition once alongside the top ten', async () => {
    const published = publication();
    published.data.SNOW = published.data.SNDK;
    delete published.data.SNDK;
    MarketDataService.getHedgeyeSnapshot.mockResolvedValue(published);
    MarketDataService.getQuotes.mockImplementation(async () => ({
      ...quotes(), SNOW: { ...quotes().MSFT, symbol: 'SNOW', last: 326.5 },
    }));
    const contributors = { status: 'available', rows: [{ ticker: 'MSFT' }, { ticker: 'GOOG' }] };
    // Every current-publication company outside the displayed roster is a MOMO
    // addition (GOOGL represents Alphabet once GOOG is excluded).
    const additions = ['AAPL', 'AMZN', 'META', 'GOOGL', 'NFLX', 'TSLA', 'NVDA', 'SNOW'];
    const { result, rerender } = renderHook(useMomoTrackerReference, { initialProps: { ...momoProps, contributors } });
    await flush();
    expect(result.current.snapshot.rows.find((row) => row.ticker === 'SNOW')).toMatchObject({ trend: 'BULLISH' });
    expect(MarketDataService.getQuotes).toHaveBeenLastCalledWith(['MSFT', ...additions]);
    expect(result.current.spots.SNOW).toMatchObject({ status: 'live', price: 326.5 });
    rerender({ ...momoProps, contributors: { ...contributors, rows: [...contributors.rows, { ticker: 'SNOW' }] } });
    await advance(15_000);
    expect(MarketDataService.getQuotes).toHaveBeenLastCalledWith(['MSFT', 'SNOW', ...additions.filter((ticker) => ticker !== 'SNOW')]);
    MarketDataService.getQuotes.mockRejectedValueOnce(new Error('offline'));
    await advance(15_000);
    expect(result.current.spots).toEqual({});
    expect(result.current.snapshot.rows.find((row) => row.ticker === 'SNOW')).toMatchObject({ trend: 'BULLISH' });
  });

  test('omits GOOG from fallback MOMO quote requests while retaining direct GOOGL data', async () => {
    const published = publication();
    published.data.GOOG = { ...published.data.GOOGL, buyTrade: 300, sellTrade: 350, index: TICKERS.length };
    published.meta = { stockCount: TICKERS.length + 1 };
    MarketDataService.getHedgeyeSnapshot.mockResolvedValue(published);
    MarketDataService.getQuotes.mockResolvedValue({
      ...quotes(), GOOG: { ...quotes().GOOGL, symbol: 'GOOG', last: 342 },
    });
    const { result } = renderHook(useMomoTrackerReference, { initialProps: momoProps });
    await flush();
    expect(MarketDataService.getQuotes).toHaveBeenCalledWith(TICKERS);
    expect(result.current.spots.GOOG).toBeUndefined();
    expect(result.current.spots.GOOGL).toMatchObject({ ticker: 'GOOGL', status: 'live', price: 114 });
    expect(result.current.snapshot.rows.find((row) => row.ticker === 'GOOGL'))
      .toMatchObject({ buyTrade: 104, sellTrade: 124 });
  });

  test('subscribes once and loads only an active SP500 one-day card, with independent 15-second spot polling', async () => {
    const pending = deferred();
    MarketDataService.getHedgeyeSnapshot.mockReturnValue(pending.promise);
    const { result, rerender, unmount } = renderHook(useMomoTrackerReference, { initialProps: { ...momoProps, active: false } });
    expect(result.current).toMatchObject({ snapshot: null, state: 'unavailable', spots: {} });
    expect(MarketDataService.getHedgeyeSnapshot).not.toHaveBeenCalled();
    rerender({ ...momoProps, normalizedMarketId: 'gold' });
    rerender({ ...momoProps, chartRange: '5d' });
    expect(MarketDataService.getHedgeyeSnapshot).not.toHaveBeenCalled();
    rerender(momoProps);
    expect(result.current.state).toBe('loading');
    expect(MarketDataService.getHedgeyeSnapshot).toHaveBeenCalledTimes(1);
    expect(MarketDataService.getHedgeyeSnapshot).toHaveBeenCalledWith('momo-tracker');
    await act(async () => { pending.resolve(publication()); });
    expect(result.current.state).toBe('available');
    expect(result.current.snapshot.publicationDate).toBe('2026-09-10');
    expect(result.current.spots.MSFT).toMatchObject({ status: 'live', price: 110, asOf: new Date(NOW).toISOString() });
    expect(MarketDataService.getQuotes).toHaveBeenCalledWith(TICKERS);
    expect(getSessionResourceCount()).toBe(1);
    rerender({ ...momoProps });
    await advance(14_999);
    expect(MarketDataService.getQuotes).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(MarketDataService.getQuotes).toHaveBeenCalledTimes(2);
    expect(MarketDataService.getHedgeyeSnapshot).toHaveBeenCalledTimes(1);
    unmount();
    await advance(30_000);
    expect(MarketDataService.getQuotes).toHaveBeenCalledTimes(2);
  });

  test.each([
    ['old publication', { date: '2026-09-09' }],
    ['failed publication refresh', { refreshFailed: true }],
    ['mock', { mock: true }],
    ['seed', { seeded: true }],
    ['cache-only', { cacheOnly: true }],
    ['offline', { offline: true }],
  ])('rejects %s publications before starting any spot requests', async (_label, overrides) => {
    MarketDataService.getHedgeyeSnapshot.mockResolvedValue(publication(overrides));
    const { result } = renderHook(useMomoTrackerReference, { initialProps: momoProps });
    await flush();
    expect(result.current).toMatchObject({ state: 'unavailable', snapshot: null, spots: {} });
    expect(MarketDataService.getQuotes).not.toHaveBeenCalled();
    expect(MarketDataService.getProviderStatus).not.toHaveBeenCalled();
  });

  test('retains original observations on transport error but rejects failed-refresh quotes and disconnected providers', async () => {
    const { result } = renderHook(useMomoTrackerReference, { initialProps: momoProps });
    await flush();
    const observed = result.current.spots;
    MarketDataService.getQuotes.mockRejectedValueOnce(new Error('Transport failed'));
    await advance(15_000);
    expect(result.current.spots).toBe(observed);
    expect(currentMomoSpot(observed.MSFT, NOW + 60_001)).toBeNull();
    MarketDataService.getQuotes.mockResolvedValueOnce(quotes({ refreshFailed: true }));
    await advance(15_000);
    expect(result.current.spots.MSFT).toEqual({ ticker: 'MSFT', status: 'unavailable', price: null, asOf: null, source: null });
    MarketDataService.getProviderStatus.mockResolvedValueOnce({ ibkr: { connected: false } });
    await advance(15_000);
    expect(result.current.spots.MSFT.status).toBe('unavailable');
    await advance(15_000);
    expect(result.current.spots.MSFT.status).toBe('live');
  });

  test.each(['resolve', 'reject'])('ignores an old spot %s after range cleanup and resumed replacement', async (outcome) => {
    const old = deferred();
    const replacement = deferred();
    const publicationRefresh = deferred();
    MarketDataService.getQuotes.mockReturnValueOnce(old.promise).mockReturnValueOnce(replacement.promise);
    MarketDataService.getHedgeyeSnapshot.mockResolvedValueOnce(publication()).mockReturnValue(publicationRefresh.promise);
    const { result, rerender, unmount } = renderHook(useMomoTrackerReference, { initialProps: momoProps });
    await flush();
    expect(MarketDataService.getQuotes).toHaveBeenCalledTimes(1);
    rerender({ ...momoProps, chartRange: '5d' });
    await advance(30_000);
    expect(MarketDataService.getQuotes).toHaveBeenCalledTimes(1);
    rerender(momoProps);
    expect(MarketDataService.getQuotes).toHaveBeenCalledTimes(2);
    await act(async () => { replacement.resolve(quotes({ last: 222 })); });
    const accepted = result.current.spots;
    expect(accepted.MSFT.price).toBe(222);
    await act(async () => {
      if (outcome === 'resolve') old.resolve(quotes({ last: 111 }));
      else old.reject(new Error('Old transport failure'));
    });
    expect(result.current.spots).toBe(accepted);
    unmount();
    await advance(30_000);
    expect(MarketDataService.getQuotes).toHaveBeenCalledTimes(2);
  });

  test('clears same-day spots when the New York publication day rolls over without requesting old tickers', async () => {
    const { result } = renderHook(useMomoTrackerReference, { initialProps: momoProps });
    await flush();
    expect(result.current.spots.MSFT.status).toBe('live');
    jest.setSystemTime(Date.parse('2026-09-11T04:00:00.000Z'));
    await advance(15_000);
    expect(result.current.spots).toEqual({});
    expect(MarketDataService.getQuotes).toHaveBeenCalledTimes(1);
    expect(result.current.snapshot.publicationDate).toBe('2026-09-10');
  });

  test('defers hidden first load and resumes once, then stops work on deactivation', async () => {
    hidden = true;
    const { result, rerender } = renderHook(useMomoTrackerReference, { initialProps: momoProps });
    await advance(30_000);
    expect(MarketDataService.getHedgeyeSnapshot).not.toHaveBeenCalled();
    await visibility(false);
    expect(MarketDataService.getHedgeyeSnapshot).toHaveBeenCalledTimes(1);
    expect(result.current.spots.MSFT.status).toBe('live');
    await visibility(false);
    expect(MarketDataService.getQuotes).toHaveBeenCalledTimes(1);
    rerender({ ...momoProps, active: false });
    await advance(30_000);
    expect(MarketDataService.getQuotes).toHaveBeenCalledTimes(1);
  });
});

describe('Gold correlation reference lifecycle', () => {
  test('uses the short retry after invalid data and an hourly cadence after verified partial history', async () => {
    MarketDataService.getGoldCorrelations.mockResolvedValueOnce(gold({ mock: true }));
    const { result, rerender } = renderHook(useGoldCorrelationReference, { initialProps: { ...goldProps, active: false } });
    rerender({ ...goldProps, normalizedMarketId: 'sp500' });
    rerender({ ...goldProps, chartRange: '5d' });
    expect(MarketDataService.getGoldCorrelations).not.toHaveBeenCalled();
    rerender(goldProps);
    expect(result.current.state).toBe('loading');
    await flush();
    expect(result.current.state).toBe('unavailable');
    expect(result.current.usable).toBe(false);
    await advance(9_999);
    expect(MarketDataService.getGoldCorrelations).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(MarketDataService.getGoldCorrelations).toHaveBeenCalledTimes(2);
    rerender({ ...goldProps, clockMs: Date.now() });
    expect(result.current.state).toBe('partial');
    expect(result.current.usable).toBe(true);
    expect(result.current.snapshot.rows[0].values['30D']).toBe(-0.6);
    // Interval reconfiguration preserves the store's previous completed-check
    // anchor, so the next hourly check lands one hour after the first failure.
    await advance(60 * 60_000 - 10_000 - 1);
    expect(MarketDataService.getGoldCorrelations).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(MarketDataService.getGoldCorrelations).toHaveBeenCalledTimes(3);
  });

  test('does not activation-refetch accepted history and leaves local clock expiry to the exact usability gate', async () => {
    const { result, rerender, unmount } = renderHook(useGoldCorrelationReference, { initialProps: goldProps });
    await flush();
    const accepted = result.current.snapshot;
    rerender({ ...goldProps, active: false });
    await advance(10_000);
    rerender(goldProps);
    expect(MarketDataService.getGoldCorrelations).toHaveBeenCalledTimes(1);
    expect(result.current.snapshot).toBe(accepted);
    rerender({ ...goldProps, clockMs: NOW + 75 * 60_000 });
    expect(result.current.usable).toBe(true);
    rerender({ ...goldProps, clockMs: NOW + 75 * 60_000 + 1 });
    expect(result.current.usable).toBe(false);
    expect(result.current.snapshot).toBe(accepted);
    expect(result.current.state).toBe('partial');
    unmount();
    await advance(60 * 60_000);
    expect(MarketDataService.getGoldCorrelations).toHaveBeenCalledTimes(1);
  });

  test('retains dated history and provider reason on refresh failure without inventing a new observation', async () => {
    const { result, rerender } = renderHook(useGoldCorrelationReference, { initialProps: goldProps });
    await flush();
    const accepted = result.current.snapshot;
    rerender({ ...goldProps, active: false });
    const failure = Object.assign(new Error('Transport failed'), { response: { data: { reason: 'Historical endpoint unavailable' } } });
    MarketDataService.getGoldCorrelations.mockRejectedValue(failure);
    await act(async () => { await result.current.resource.refresh(); });
    expect(result.current.snapshot).toBe(accepted);
    expect(result.current.snapshot.timestamp).toBe(new Date(NOW).toISOString());
    expect(result.current.state).toBe('refresh-delayed');
    expect(result.current.reason).toBe('Historical endpoint unavailable');
    expect(MarketDataService.getGoldCorrelations).toHaveBeenCalledTimes(2);
    await flush();
    expect(MarketDataService.getGoldCorrelations).toHaveBeenCalledTimes(2);
  });

  test('preserves the existing active interval-change recovery while its replacement request is pending', async () => {
    const { result } = renderHook(useGoldCorrelationReference, { initialProps: goldProps });
    await flush();
    const accepted = result.current.snapshot;
    const failing = deferred();
    const recovery = deferred();
    MarketDataService.getGoldCorrelations.mockReturnValueOnce(failing.promise).mockReturnValueOnce(recovery.promise);
    act(() => { void result.current.resource.refresh(); });
    await act(async () => { failing.reject(new Error('Historical endpoint unavailable')); });
    expect(MarketDataService.getGoldCorrelations).toHaveBeenCalledTimes(2);
    expect(result.current.state).toBe('refresh-delayed');
    await advance(10_000);
    // The short-interval request clears its error while retaining dated data.
    // Keep recovery deferred so the exact in-flight state is characterized.
    expect(MarketDataService.getGoldCorrelations).toHaveBeenCalledTimes(3);
    expect(result.current.snapshot).toBe(accepted);
    expect(result.current.resource.refreshing).toBe(true);
    expect(result.current.state).toBe('partial');
    await act(async () => { recovery.resolve(gold()); });
    expect(result.current.resource.refreshing).toBe(false);
    expect(result.current.reason).toBeNull();
    expect(MarketDataService.getGoldCorrelations).toHaveBeenCalledTimes(3);
  });

  test('keeps one registry request and one in-flight promise across concurrent readers', async () => {
    const pending = deferred();
    MarketDataService.getGoldCorrelations.mockReturnValue(pending.promise);
    const { result: firstResult, unmount: unmountFirst } = renderHook(useGoldCorrelationReference, { initialProps: goldProps });
    const { result: secondResult, unmount: unmountSecond } = renderHook(useGoldCorrelationReference, { initialProps: goldProps });
    expect(MarketDataService.getGoldCorrelations).toHaveBeenCalledTimes(1);
    expect(getSessionResourceCount()).toBe(1);
    expect(firstResult.current.resource.refresh()).toBe(secondResult.current.resource.refresh());
    unmountFirst();
    await act(async () => { pending.resolve(gold()); });
    expect(secondResult.current.state).toBe('partial');
    unmountSecond();
    await advance(60 * 60_000);
    expect(MarketDataService.getGoldCorrelations).toHaveBeenCalledTimes(1);
  });
});

describe('CPI benchmark reference lifecycle', () => {
  test('requires CPI activation and exact month plus release identity before starting the same resource', async () => {
    const { result, rerender } = renderHook(useCpiBenchmarkReference, { initialProps: { ...cpiProps, active: false } });
    rerender({ ...cpiProps, normalizedMarketId: 'gold' });
    rerender({ ...cpiProps, forecastComparison: { reportMonth: '2026-08' } });
    expect(predictionMarketsIngestService.getCpiBenchmarks).not.toHaveBeenCalled();
    rerender(cpiProps);
    expect(result.current.initialLoading).toBe(true);
    await flush();
    expect(predictionMarketsIngestService.getCpiBenchmarks).toHaveBeenCalledTimes(1);
    expect(predictionMarketsIngestService.getCpiBenchmarks).toHaveBeenCalledWith('2026-08');
    expect(result.current.data).toMatchObject({ period: '2026-08', releaseAt: RELEASE, fetchedAt: new Date(NOW).toISOString() });
    expect(result.current.data.sources[0]).toMatchObject({ status: 'available', point: 3.04 });
    rerender({ ...cpiProps, forecastComparison: { ...cpiProps.forecastComparison } });
    expect(predictionMarketsIngestService.getCpiBenchmarks).toHaveBeenCalledTimes(1);
    await advance(15 * 60_000);
    expect(predictionMarketsIngestService.getCpiBenchmarks).toHaveBeenCalledTimes(2);
  });

  test.each(['resolve', 'reject'])('does not let an old-month %s commit across a changed scope', async (outcome) => {
    const old = deferred();
    const replacement = deferred();
    predictionMarketsIngestService.getCpiBenchmarks.mockReturnValueOnce(old.promise).mockReturnValueOnce(replacement.promise);
    const { result, rerender } = renderHook(useCpiBenchmarkReference, { initialProps: cpiProps });
    const nextRelease = '2026-10-13T12:30:00.000Z';
    rerender({ ...cpiProps, forecastComparison: { reportMonth: '2026-09', releaseAt: nextRelease } });
    expect(result.current.data).toBeNull();
    expect(result.current.initialLoading).toBe(true);
    await act(async () => {
      if (outcome === 'resolve') old.resolve(benchmark());
      else old.reject(new Error('Old month failed'));
    });
    expect(result.current.data).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.initialLoading).toBe(true);
    await act(async () => { replacement.resolve(benchmark('2026-09', nextRelease)); });
    expect(result.current.data).toMatchObject({ period: '2026-09', releaseAt: nextRelease });
    expect(predictionMarketsIngestService.getCpiBenchmarks).toHaveBeenCalledTimes(2);
  });

  test('invalidates accepted data when only the same-month release timestamp changes', async () => {
    const { result, rerender } = renderHook(useCpiBenchmarkReference, { initialProps: cpiProps });
    await flush();
    const pending = deferred();
    predictionMarketsIngestService.getCpiBenchmarks.mockReturnValueOnce(pending.promise);
    const nextRelease = '2026-09-11T13:30:00.000Z';
    rerender({ ...cpiProps, forecastComparison: { reportMonth: '2026-08', releaseAt: nextRelease } });
    expect(result.current.data).toBeNull();
    await act(async () => { pending.resolve(benchmark('2026-08', nextRelease)); });
    expect(result.current.data.releaseAt).toBe(nextRelease);
    expect(predictionMarketsIngestService.getCpiBenchmarks).toHaveBeenCalledTimes(2);
  });

  test('uses the real acceptance boundary for aged envelopes and unsafe individual source provenance', async () => {
    predictionMarketsIngestService.getCpiBenchmarks.mockResolvedValueOnce(benchmark('2026-08', RELEASE, {
      fetchedAt: new Date(NOW - 30 * 60_000 - 1).toISOString(),
    }));
    const { result } = renderHook(useCpiBenchmarkReference, { initialProps: cpiProps });
    await flush();
    expect(result.current.data).toBeNull();
    expect(result.current.error.message).toMatch(/not freshly checked/);
    const unsafe = benchmark();
    unsafe.sources[0].source = 'cache-only';
    predictionMarketsIngestService.getCpiBenchmarks.mockResolvedValueOnce(unsafe);
    await act(async () => { await result.current.refresh(); });
    expect(result.current.data.sources[0]).toMatchObject({ status: 'pending', point: null, source: null, asOf: null });
  });

  test('characterizes existing reference-store retention after failed refresh without resetting the checked time', async () => {
    const { result, rerender } = renderHook(useCpiBenchmarkReference, { initialProps: cpiProps });
    await flush();
    const accepted = result.current.data;
    rerender({ ...cpiProps, active: false });
    await advance(30 * 60_000 + 1);
    // The existing reference-kind store does not schedule live-style expiry,
    // and retains dated data on failure despite retainOnRefreshFailure:false.
    // Preserved here, not silently changed during the structural extraction.
    expect(result.current.data).toBe(accepted);
    const pending = deferred();
    predictionMarketsIngestService.getCpiBenchmarks.mockReturnValueOnce(pending.promise);
    let first;
    let second;
    act(() => { first = result.current.refresh(); second = result.current.refresh(); });
    expect(first).toBe(second);
    expect(result.current.refreshing).toBe(true);
    await act(async () => { pending.reject(new Error('Benchmark transport failed')); });
    expect(result.current.data).toBe(accepted);
    expect(result.current.data.fetchedAt).toBe(new Date(NOW).toISOString());
    expect(result.current.availability).toBe('refresh-delayed');
    expect(predictionMarketsIngestService.getCpiBenchmarks).toHaveBeenCalledTimes(2);
  });

  test('pauses hidden polling, resumes once per visibility transition and stops on unmount', async () => {
    hidden = true;
    const { result, unmount } = renderHook(useCpiBenchmarkReference, { initialProps: cpiProps });
    await advance(15 * 60_000);
    expect(predictionMarketsIngestService.getCpiBenchmarks).not.toHaveBeenCalled();
    await visibility(false);
    expect(result.current.data.period).toBe('2026-08');
    expect(predictionMarketsIngestService.getCpiBenchmarks).toHaveBeenCalledTimes(1);
    await visibility(true);
    await advance(15 * 60_000);
    expect(predictionMarketsIngestService.getCpiBenchmarks).toHaveBeenCalledTimes(1);
    await visibility(false);
    await visibility(false);
    expect(predictionMarketsIngestService.getCpiBenchmarks).toHaveBeenCalledTimes(2);
    unmount();
    await advance(15 * 60_000);
    expect(predictionMarketsIngestService.getCpiBenchmarks).toHaveBeenCalledTimes(2);
  });
});
