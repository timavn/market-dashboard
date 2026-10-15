import { act, renderHook } from '@testing-library/react';
import useHedgaiTickResearch, { HEDGAI_TICK_REFRESH_MS } from './useHedgaiTickResearch';
import { MarketDataService } from '../services/api/marketDataService';

jest.mock('react-dom/test-utils', () => ({
  ...jest.requireActual('react-dom/test-utils'), act: jest.requireActual('react').act,
}));
jest.mock('../services/api/marketDataService', () => ({ MarketDataService: { getHedgaiResearch: jest.fn() } }));
const DATE = '2026-09-25';
const NOW = `${DATE}T16:00:00Z`;
const payload = (overrides = {}) => ({
  version: 1, product: 'hedgai-signals', asOf: NOW, baselineDate: DATE,
  sourceQuality: { continuity: 'complete', issues: [] },
  book: { rows: ['AAPL', 'SPY'].map((ticker) => ({
    ticker, instrumentId: `hedgai:${ticker}`, position: 'Buy', status: 'current',
    positionSourceIds: ['source'], metricsSourceIds: [],
  })) },
  sources: [{ id: 'source', sourceType: 'gmail-email', publicationDate: DATE,
    publishedAt: `${DATE}T12:43:00Z`, sourceUrl: 'https://app.hedgeye.com/feed_items/187646' }],
  ...overrides,
});
const flush = async () => { await act(async () => { await Promise.resolve(); }); };
const advance = async () => { await act(async () => { jest.advanceTimersByTime(HEDGAI_TICK_REFRESH_MS); }); };
const pending = () => {
  let resolve;
  const promise = new Promise((accept) => { resolve = accept; });
  return { promise, resolve };
};
beforeEach(() => {
  jest.useFakeTimers({ now: new Date(NOW) });
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  MarketDataService.getHedgaiResearch.mockReset().mockResolvedValue(payload());
});
afterEach(() => { jest.useRealTimers(); delete document.hidden; });

test('loads only HedgAI and shares direct securities and explicitly mapped ETF references', async () => {
  const { result, unmount } = renderHook(() => useHedgaiTickResearch());
  await flush();
  expect(MarketDataService.getHedgaiResearch).toHaveBeenCalledWith({ asOf: new Date(NOW).toISOString() });
  expect(result.current).toMatchObject({ status: 'available', loading: false,
    readings: { AAPL: { tick: 'BULLISH', tickEvidence: { sourceTicker: 'AAPL', matchType: 'exact' } },
      SPY: { tickEvidence: { matchType: 'exact' } }, SPX: { tickEvidence: { sourceTicker: 'SPY', matchType: 'proxy' } } } });
  unmount();
  await advance();
  expect(MarketDataService.getHedgaiResearch).toHaveBeenCalledTimes(1);
});

test('checks current research during refresh and clears Tick immediately after a failed check', async () => {
  const { result } = renderHook(() => useHedgaiTickResearch());
  await flush();
  const next = pending();
  MarketDataService.getHedgaiResearch.mockReturnValueOnce(next.promise);
  await advance();
  expect(result.current).toMatchObject({ loading: true, readings: { AAPL: { tick: 'BULLISH' } } });
  await act(async () => { next.resolve(payload()); });
  const error = new Error('offline');
  MarketDataService.getHedgaiResearch.mockRejectedValueOnce(error);
  await advance();
  expect(result.current).toEqual({ readings: {}, loading: false, status: 'unavailable', error });
});

test.each([{ mock: true }, { seeded: true }, { stale: true }, { cacheOnly: true },
  { disconnected: true }, { availability: 'unavailable' },
  { sourceQuality: { continuity: 'unknown', issues: [] } }])('withholds unsafe or unchecked Tick: %p', async (flags) => {
  MarketDataService.getHedgaiResearch.mockResolvedValueOnce(payload(flags));
  const { result } = renderHook(() => useHedgaiTickResearch());
  await flush();
  expect(result.current).toMatchObject({ readings: {}, loading: false, status: 'unavailable' });
});

test('inactive surfaces stop polling and ignore an old completion after reactivation', async () => {
  const first = pending();
  MarketDataService.getHedgaiResearch.mockReturnValueOnce(first.promise);
  const { result, rerender } = renderHook(({ active }) => useHedgaiTickResearch({ active }), { initialProps: { active: true } });
  await flush();
  rerender({ active: false });
  await advance();
  expect(result.current).toMatchObject({ readings: {}, loading: false });
  expect(MarketDataService.getHedgaiResearch).toHaveBeenCalledTimes(1);
  rerender({ active: true });
  await flush();
  expect(result.current.readings.AAPL.tick).toBe('BULLISH');
  await act(async () => { first.resolve(payload({ availability: 'unavailable' })); });
  expect(result.current.readings.AAPL.tick).toBe('BULLISH');
});

test('withdraws a previous-day check when the next date refresh starts', async () => {
  const { result } = renderHook(() => useHedgaiTickResearch());
  await flush();
  const next = pending();
  MarketDataService.getHedgaiResearch.mockReturnValueOnce(next.promise);
  jest.setSystemTime(new Date('2026-09-26T03:59:00Z'));
  await advance();
  expect(result.current.readings).toEqual({});
  await act(async () => { next.resolve(payload()); });
  expect(result.current).toMatchObject({ readings: {}, loading: false, status: 'unavailable' });
});

test('ignores a response crossing the market date', async () => {
  jest.setSystemTime(new Date('2026-09-26T03:59:00Z'));
  const next = pending();
  MarketDataService.getHedgaiResearch.mockReturnValueOnce(next.promise);
  const { result } = renderHook(() => useHedgaiTickResearch());
  await flush();
  jest.setSystemTime(new Date('2026-09-26T04:00:00Z'));
  await act(async () => { next.resolve(payload()); });
  expect(result.current).toMatchObject({ readings: {}, loading: false, status: 'unavailable' });
});
