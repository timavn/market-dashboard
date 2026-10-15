import { act } from 'react';
import { renderHook } from '@testing-library/react';
import useSp500ContributorsReference from './useSp500ContributorsReference';
import { MarketDataService } from '../../../services/api/marketDataService';

jest.mock('react-dom/test-utils', () => ({
  ...jest.requireActual('react-dom/test-utils'), act: jest.requireActual('react').act,
}));
jest.mock('../../../services/api/marketDataService', () => ({ MarketDataService: { getSp500Contributors: jest.fn() } }));
const NOW = Date.parse('2026-09-14T21:00:00Z');
const props = { active: true, normalizedMarketId: 'sp500', chartRange: '1d' };
const originalHidden = Object.getOwnPropertyDescriptor(document, 'hidden');
let hidden = false;
const snapshot = () => ({
  status: 'available', asOf: '2026-09-11', fetchedAt: new Date(Date.now()).toISOString(),
  source: 'State Street / S&P Dow Jones Indices', sourceUrl: 'https://www.ssga.com/spy',
  rows: ['NVDA', 'AAPL', 'GOOGL', 'MSFT', 'AMZN', 'META', 'AVGO', 'TSLA', 'BRK.B', 'LLY']
    .map((ticker, index) => ({ ticker, weightPct: 10 - index })),
});
const flush = () => act(async () => { await Promise.resolve(); });
beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
  jest.resetAllMocks();
  hidden = false;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  MarketDataService.getSp500Contributors.mockImplementation(async () => snapshot());
});
afterEach(() => {
  jest.useRealTimers();
  if (originalHidden) Object.defineProperty(document, 'hidden', originalHidden);
  else delete document.hidden;
});

test('loads only active SP500 1D and refreshes every five minutes independently of research', async () => {
  const { result, rerender, unmount } = renderHook(useSp500ContributorsReference, { initialProps: { ...props, active: false } });
  expect(result.current).toBeNull();
  expect(MarketDataService.getSp500Contributors).not.toHaveBeenCalled();
  rerender({ ...props, chartRange: '5d' });
  expect(MarketDataService.getSp500Contributors).not.toHaveBeenCalled();
  rerender(props);
  await flush();
  expect(result.current.rows).toHaveLength(10);
  await act(async () => { jest.advanceTimersByTime(300_000); });
  expect(MarketDataService.getSp500Contributors).toHaveBeenCalledTimes(2);
  unmount();
  await act(async () => { jest.advanceTimersByTime(300_000); });
  expect(MarketDataService.getSp500Contributors).toHaveBeenCalledTimes(2);
});

test('clears prior snapshot after failed refresh and ignores a late request after unmount', async () => {
  const { result, unmount } = renderHook(useSp500ContributorsReference, { initialProps: props });
  await flush();
  expect(result.current.rows).toHaveLength(10);
  MarketDataService.getSp500Contributors.mockRejectedValueOnce(new Error('offline'));
  await act(async () => { jest.advanceTimersByTime(300_000); });
  expect(result.current).toBeNull();
  let resolve;
  MarketDataService.getSp500Contributors.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  await act(async () => { jest.advanceTimersByTime(15_000); });
  expect(result.current).toMatchObject({ status: 'loading', rows: [] });
  const pendingResult = result.current;
  unmount();
  await act(async () => { resolve(snapshot()); });
  expect(result.current).toBe(pendingResult);
});

test('recovers from a cold request failure after fifteen seconds and stops retrying after success', async () => {
  MarketDataService.getSp500Contributors.mockRejectedValueOnce(new Error('request timed out'));
  const { result, unmount } = renderHook(useSp500ContributorsReference, { initialProps: props });
  expect(result.current).toMatchObject({ status: 'loading', rows: [] });
  await flush();
  expect(result.current).toBeNull();
  await act(async () => { jest.advanceTimersByTime(14_999); });
  expect(MarketDataService.getSp500Contributors).toHaveBeenCalledTimes(1);
  await act(async () => { jest.advanceTimersByTime(1); });
  expect(result.current.rows).toHaveLength(10);
  expect(MarketDataService.getSp500Contributors).toHaveBeenCalledTimes(2);
  await act(async () => { jest.advanceTimersByTime(30_000); });
  expect(MarketDataService.getSp500Contributors).toHaveBeenCalledTimes(2);
  unmount();
});

test('retries an unavailable provider response without retaining the prior verified snapshot', async () => {
  const { result, unmount } = renderHook(useSp500ContributorsReference, { initialProps: props });
  await flush();
  expect(result.current.rows).toHaveLength(10);
  MarketDataService.getSp500Contributors.mockResolvedValueOnce({ status: 'unavailable', rows: [] });
  await act(async () => { jest.advanceTimersByTime(300_000); });
  expect(result.current).toBeNull();
  await act(async () => { jest.advanceTimersByTime(15_000); });
  expect(result.current.rows).toHaveLength(10);
  expect(MarketDataService.getSp500Contributors).toHaveBeenCalledTimes(3);
  unmount();
});

test('pauses retries while hidden and makes one immediate recovery request when visible again', async () => {
  MarketDataService.getSp500Contributors.mockRejectedValueOnce(new Error('offline'));
  const { result, unmount } = renderHook(useSp500ContributorsReference, { initialProps: props });
  await flush();
  hidden = true;
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
  await act(async () => { jest.advanceTimersByTime(60_000); });
  expect(result.current).toBeNull();
  expect(MarketDataService.getSp500Contributors).toHaveBeenCalledTimes(1);
  hidden = false;
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
  expect(result.current.rows).toHaveLength(10);
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
  await act(async () => { jest.advanceTimersByTime(15_000); });
  expect(MarketDataService.getSp500Contributors).toHaveBeenCalledTimes(2);
  unmount();
});

test('allows only one pending request and cancels a scheduled recovery when unmounted', async () => {
  let reject;
  MarketDataService.getSp500Contributors.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  const { result, unmount } = renderHook(useSp500ContributorsReference, { initialProps: props });
  await act(async () => { jest.advanceTimersByTime(300_000); });
  expect(MarketDataService.getSp500Contributors).toHaveBeenCalledTimes(1);
  await act(async () => { reject(new Error('offline')); });
  expect(result.current).toBeNull();
  unmount();
  await act(async () => { jest.advanceTimersByTime(300_000); });
  expect(MarketDataService.getSp500Contributors).toHaveBeenCalledTimes(1);
});

test('keeps an independently valid reference when inactive, pauses polling, and removes it when its evidence expires', async () => {
  const { result, rerender, unmount } = renderHook(useSp500ContributorsReference, { initialProps: props });
  await flush();
  const original = result.current;
  rerender({ ...props, active: false });
  expect(result.current).toEqual(original);
  await act(async () => { jest.advanceTimersByTime(300_000); });
  rerender({ ...props, active: false });
  expect(result.current.rows).toHaveLength(10);
  expect(result.current.fetchedAt).toBe(original.fetchedAt);
  expect(MarketDataService.getSp500Contributors).toHaveBeenCalledTimes(1);
  await act(async () => { jest.advanceTimersByTime(15 * 60_000 + 1); });
  rerender({ ...props, active: false });
  expect(result.current).toBeNull();
  expect(MarketDataService.getSp500Contributors).toHaveBeenCalledTimes(1);
  rerender(props);
  await flush();
  expect(result.current.rows).toHaveLength(10);
  expect(result.current.fetchedAt).not.toBe(original.fetchedAt);
  expect(MarketDataService.getSp500Contributors).toHaveBeenCalledTimes(2);
  unmount();
});

test('expires inactive live quotes independently of the still-valid constituent roster', async () => {
  const intraday = Date.parse('2026-09-14T18:00:00Z');
  jest.setSystemTime(intraday);
  const data = snapshot();
  data.rows[0].quote = {
    status: 'live', price: 205, changePercent: 1.2,
    asOf: new Date(intraday).toISOString(), marketDate: '2026-09-14',
    source: 'Nasdaq', sourceUrl: 'https://www.nasdaq.com/market-activity/stocks/nvda',
  };
  MarketDataService.getSp500Contributors.mockResolvedValueOnce(data);
  const { result, rerender, unmount } = renderHook(useSp500ContributorsReference, { initialProps: props });
  await flush();
  expect(result.current.rows[0].quote.price).toBe(205);
  rerender({ ...props, active: false });
  await act(async () => { jest.advanceTimersByTime(60_001); });
  rerender({ ...props, active: false });
  expect(result.current.rows).toHaveLength(10);
  expect(result.current.rows[0].quote).toBeNull();
  expect(result.current.fetchedAt).toBe(data.fetchedAt);
  expect(MarketDataService.getSp500Contributors).toHaveBeenCalledTimes(1);
  unmount();
});

test('clears every failed refresh and recovers automatically across repeated failure cycles', async () => {
  const { result, unmount } = renderHook(useSp500ContributorsReference, { initialProps: props });
  await flush();
  const originalFetchedAt = result.current.fetchedAt;
  MarketDataService.getSp500Contributors
    .mockRejectedValueOnce(new Error('temporary provider outage'))
    .mockResolvedValueOnce({ status: 'unavailable', rows: [] });
  await act(async () => { jest.advanceTimersByTime(300_000); });
  expect(result.current).toBeNull();
  await act(async () => { jest.advanceTimersByTime(15_000); });
  expect(result.current).toBeNull();
  await act(async () => { jest.advanceTimersByTime(15_000); });
  expect(result.current.rows).toHaveLength(10);
  expect(result.current.fetchedAt).not.toBe(originalFetchedAt);
  MarketDataService.getSp500Contributors.mockRejectedValueOnce(new Error('second temporary outage'));
  await act(async () => { jest.advanceTimersByTime(270_000); });
  expect(result.current).toBeNull();
  await act(async () => { jest.advanceTimersByTime(15_000); });
  expect(result.current.rows).toHaveLength(10);
  expect(MarketDataService.getSp500Contributors).toHaveBeenCalledTimes(6);
  unmount();
});

test('reports pending initial and retry requests while keeping valid data through a background refresh', async () => {
  let completeInitial;
  MarketDataService.getSp500Contributors.mockImplementationOnce(() => new Promise((resolve) => { completeInitial = resolve; }));
  const { result, unmount } = renderHook(useSp500ContributorsReference, { initialProps: props });
  expect(result.current).toEqual({ status: 'loading', rows: [] });
  await act(async () => { completeInitial(snapshot()); });
  expect(result.current.status).toBe('available');
  const fetchedAt = result.current.fetchedAt;
  let failRefresh;
  MarketDataService.getSp500Contributors.mockImplementationOnce(() => new Promise((_resolve, reject) => { failRefresh = reject; }));
  await act(async () => { jest.advanceTimersByTime(300_000); });
  expect(result.current.status).toBe('available');
  expect(result.current.fetchedAt).toBe(fetchedAt);
  await act(async () => { failRefresh(new Error('temporary failure')); });
  expect(result.current).toBeNull();
  let completeRetry;
  MarketDataService.getSp500Contributors.mockImplementationOnce(() => new Promise((resolve) => { completeRetry = resolve; }));
  await act(async () => { jest.advanceTimersByTime(15_000); });
  expect(result.current).toEqual({ status: 'loading', rows: [] });
  await act(async () => { completeRetry(snapshot()); });
  expect(result.current.status).toBe('available');
  expect(result.current.rows).toHaveLength(10);
  unmount();
});
