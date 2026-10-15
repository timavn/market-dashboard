import { act, renderHook } from '@testing-library/react';
import useUsdIndexBias, {
  isUsdIndexRow, normalizeUsdIndexBias, USD_INDEX_BIAS_REFRESH_MS,
} from './useUsdIndexBias';
import { MarketDataService } from '../services/api/marketDataService';

jest.mock('react-dom/test-utils', () => ({
  ...jest.requireActual('react-dom/test-utils'),
  act: jest.requireActual('react').act,
}));
jest.mock('../services/api/marketDataService', () => ({
  MarketDataService: { getHedgeyeSnapshot: jest.fn() },
}));

const DATE = '2026-09-18';
const NOW = '2026-09-18T16:00:00Z';
const KEY = 'U.S. DOLLAR INDEX (USD)';
const sourceUrl = 'https://app.hedgeye.com/feed_items/187366';
const snapshot = ({ date = DATE, trend = 'BULLISH', key = KEY, row = {}, ...overrides } = {}) => ({
  snapshotType: 'early-look',
  reportType: 'early-look',
  source: 'gmail-html',
  date,
  publishedAt: `${date}T00:00:00+00:00`,
  htmlSource: `hedgeye-email/messages/${date}/early-look/verified-message-body.html`,
  article: { feedUrl: sourceUrl },
  data: { [key]: { originalName: 'U.S. Dollar Index (USD)', trend, lrr: 99.53, hrr: 100.81, ...row } },
  ...overrides,
});
const normalize = (payload) => normalizeUsdIndexBias(payload, { date: DATE });
const flush = async () => { await act(async () => { await Promise.resolve(); }); };
const advance = async (time) => { await act(async () => { jest.advanceTimersByTime(time); }); };
const setHidden = (hidden) => {
  Object.defineProperty(document, 'hidden', { configurable: true, value: hidden });
};
const visibility = async (hidden) => {
  setHidden(hidden);
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
};
const pending = () => {
  let resolve;
  const promise = new Promise((accept) => { resolve = accept; });
  return { promise, resolve };
};

beforeEach(() => {
  jest.useFakeTimers({ now: new Date(NOW) });
  setHidden(false);
  MarketDataService.getHedgeyeSnapshot.mockReset().mockResolvedValue(snapshot());
});
afterEach(() => {
  jest.useRealTimers();
  delete document.hidden;
});

test.each(['BULLISH', 'BEARISH', 'NEUTRAL'])('normalizes the explicit %s source trend with its date and ranges', (trend) => {
  expect(normalize(snapshot({ trend }))).toEqual({
    trend, date: DATE, lrr: 99.53, hrr: 100.81,
    sourceUrl, source: 'Early Look', verified: true,
  });
});

test.each(['USD', 'DXY', 'USD Index', 'U.S. Dollar Index', 'US Dollar Index (DXY)'])('accepts the exact index identity %s', (key) => {
  expect(normalize(snapshot({ key }))?.trend).toBe('BULLISH');
  expect(isUsdIndexRow({ ticker: key })).toBe(true);
});

test.each([
  { ticker: 'UUP', name: 'US Dollar Index' },
  { ticker: 'UDN', name: 'US Dollar Index' },
  { symbol: 'EURUSD' },
  { name: 'USD Index ETF' },
  { ticker: 'USD', originalName: 'U.S. Dollar (UUP)' },
])('does not assign the index bias to a proxy or conflicting identity %p', (row) => {
  expect(isUsdIndexRow(row)).toBe(false);
});

test.each([
  null,
  snapshot({ date: '2026-09-17' }),
  snapshot({ date: '2026-09-19' }),
  snapshot({ source: 'mock' }),
  snapshot({ source: 'portfolio' }),
  snapshot({ snapshotType: 'risk-ranges' }),
  snapshot({ reportType: 'risk-ranges' }),
  snapshot({ snapshotType: undefined, reportType: undefined }),
  snapshot({ htmlSource: null }),
  snapshot({ htmlSource: 'hedgeye-email/messages/2026-09-17/early-look/source.html' }),
  snapshot({ article: { feedUrl: 'https://example.com/feed_items/187366' } }),
  snapshot({ article: { feedUrl: 'https://app.hedgeye.com.evil.invalid/feed_items/187366' } }),
  snapshot({ article: { feedUrl: 'http://app.hedgeye.com/feed_items/187366' } }),
  snapshot({ key: 'UUP' }),
  snapshot({ data: {} }),
  snapshot({ row: { trend: 'UNKNOWN' } }),
  snapshot({ row: { trend: null } }),
  snapshot({ row: { lrr: 102, hrr: 100 } }),
  snapshot({ row: { lrr: '99.53' } }),
  snapshot({ row: { hrr: Infinity } }),
  snapshot({ row: { date: '2026-09-17' } }),
  snapshot({ row: { asOf: '2026-09-17T13:00:00Z' } }),
  snapshot({ row: { source: 'mock' } }),
  snapshot({ row: { source: 'seed' } }),
])('omits incomplete, mismatched or unverified source evidence %#', (payload) => {
  expect(normalize(payload)).toBeNull();
});

test.each([
  { mock: true }, { seeded: true }, { seed: true }, { cacheOnly: true },
  { stale: true }, { sourceVerified: false }, { verified: false },
  { success: false }, { connected: false }, { status: 'offline' },
  { sourceStatus: 'failed' }, { freshness: 'stale' }, { availability: 'unavailable' },
  { cacheState: 'cache_only' }, { cacheStatus: 'stale' },
])('rejects invalid source flags at snapshot, metadata and row levels %p', (flags) => {
  expect(normalize(snapshot(flags))).toBeNull();
  expect(normalize(snapshot({ meta: flags }))).toBeNull();
  expect(normalize(snapshot({ row: flags }))).toBeNull();
});

test('rejects duplicate index rows instead of choosing conflicting aliases', () => {
  const payload = snapshot();
  payload.data.DXY = { ...payload.data[KEY], trend: 'BEARISH' };
  expect(normalize(payload)).toBeNull();
});

test('fetches the current New York date, polls while visible and clears failed refreshes', async () => {
  const { result, unmount } = renderHook(useUsdIndexBias);
  await flush();
  expect(MarketDataService.getHedgeyeSnapshot).toHaveBeenCalledWith('early-look', DATE);
  expect(result.current).toMatchObject({ status: 'available', loading: false, bias: { trend: 'BULLISH' } });

  await visibility(true);
  await advance(USD_INDEX_BIAS_REFRESH_MS * 2);
  expect(MarketDataService.getHedgeyeSnapshot).toHaveBeenCalledTimes(1);
  const error = new Error('Provider disconnected');
  MarketDataService.getHedgeyeSnapshot.mockRejectedValueOnce(error);
  await visibility(false);
  expect(result.current).toEqual({ bias: null, status: 'unavailable', loading: false, error });

  MarketDataService.getHedgeyeSnapshot.mockResolvedValueOnce(snapshot({ trend: 'BEARISH' }));
  await advance(USD_INDEX_BIAS_REFRESH_MS);
  expect(result.current.bias?.trend).toBe('BEARISH');
  MarketDataService.getHedgeyeSnapshot.mockResolvedValueOnce(null);
  await advance(USD_INDEX_BIAS_REFRESH_MS);
  expect(result.current).toEqual({ bias: null, status: 'unavailable', loading: false, error: null });
  unmount();
  const calls = MarketDataService.getHedgeyeSnapshot.mock.calls.length;
  await advance(USD_INDEX_BIAS_REFRESH_MS);
  expect(MarketDataService.getHedgeyeSnapshot).toHaveBeenCalledTimes(calls);
});

test('waits for visibility before fetching when mounted in a hidden tab', async () => {
  setHidden(true);
  const { result } = renderHook(useUsdIndexBias);
  await flush();
  expect(MarketDataService.getHedgeyeSnapshot).not.toHaveBeenCalled();
  expect(result.current.bias).toBeNull();
  await visibility(false);
  expect(result.current.bias?.verified).toBe(true);
});

test('requests the new New York date after midnight and clears yesterday while waiting', async () => {
  jest.setSystemTime(new Date('2026-09-19T03:59:00Z'));
  const { result } = renderHook(useUsdIndexBias);
  await flush();
  expect(result.current.bias?.date).toBe(DATE);
  const next = pending();
  MarketDataService.getHedgeyeSnapshot.mockReturnValueOnce(next.promise);
  await advance(USD_INDEX_BIAS_REFRESH_MS);
  expect(MarketDataService.getHedgeyeSnapshot).toHaveBeenLastCalledWith('early-look', '2026-09-19');
  expect(result.current).toMatchObject({ bias: null, loading: true });
  await act(async () => { next.resolve(snapshot()); });
  expect(result.current).toMatchObject({ bias: null, status: 'unavailable' });
});

test('does not accept a request crossing midnight or an older response arriving last', async () => {
  jest.setSystemTime(new Date('2026-09-19T03:59:00Z'));
  const beforeMidnight = pending();
  MarketDataService.getHedgeyeSnapshot.mockReturnValueOnce(beforeMidnight.promise);
  const { result } = renderHook(useUsdIndexBias);
  await flush();
  jest.setSystemTime(new Date('2026-09-19T04:00:00Z'));
  await act(async () => { beforeMidnight.resolve(snapshot()); });
  expect(result.current.bias).toBeNull();

  const older = pending();
  const latest = snapshot({ date: '2026-09-19', trend: 'BEARISH' });
  MarketDataService.getHedgeyeSnapshot.mockReturnValueOnce(older.promise).mockResolvedValueOnce(latest);
  await advance(USD_INDEX_BIAS_REFRESH_MS);
  await visibility(true);
  await visibility(false);
  expect(result.current.bias?.trend).toBe('BEARISH');
  await act(async () => { older.resolve(snapshot({ date: '2026-09-19' })); });
  expect(result.current.bias?.trend).toBe('BEARISH');
});
