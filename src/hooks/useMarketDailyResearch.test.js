import { act, renderHook, waitFor } from '@testing-library/react';
import { MarketDataService } from '../services/api/marketDataService';
import useMarketDailyResearch from './useMarketDailyResearch';

jest.mock('../services/api/marketDataService', () => ({
  MarketDataService: { getSecurityIntelligenceV2: jest.fn() },
}));
jest.mock('../utils/marketDailyResearch', () => ({
  ...jest.requireActual('../utils/marketDailyResearch'),
  projectMarketDailyResearch: (response) => response.items,
}));

const settings = { enabled: true, marketDate: '2026-09-24', tickers: ['IGV', 'SMH'] };
const deferred = () => {
  let resolve;
  const promise = new Promise((finish) => { resolve = finish; });
  return { resolve, promise };
};
beforeEach(() => MarketDataService.getSecurityIntelligenceV2.mockReset());

test('loads only the exact date and requested tickers, with no history acquisition', async () => {
  const items = [{ ticker: 'IGV', direction: 'BULLISH' }];
  MarketDataService.getSecurityIntelligenceV2.mockResolvedValue({ items });
  const { result } = renderHook(() => useMarketDailyResearch(settings));
  await waitFor(() => expect(result.current).toEqual({ items, loading: false }));
  expect(MarketDataService.getSecurityIntelligenceV2).toHaveBeenCalledWith({
    date: '2026-09-24', symbols: ['IGV', 'SMH'], historyDays: 0, signal: expect.any(AbortSignal),
  });
});

test.each([
  { ...settings, enabled: false },
  { ...settings, marketDate: undefined },
  { ...settings, marketDate: '2026-02-30' },
  { ...settings, tickers: [] },
])('does not request evidence for a disabled or unscoped card: %j', (props) => {
  const { result } = renderHook(() => useMarketDailyResearch(props));
  expect(result.current).toEqual({ items: [], loading: false });
  expect(MarketDataService.getSecurityIntelligenceV2).not.toHaveBeenCalled();
});

test('clears the prior card immediately and ignores its late response after switching tickers', async () => {
  const first = deferred();
  const second = deferred();
  MarketDataService.getSecurityIntelligenceV2.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const { result, rerender } = renderHook((props) => useMarketDailyResearch(props), { initialProps: settings });
  const firstSignal = MarketDataService.getSecurityIntelligenceV2.mock.calls[0][0].signal;
  rerender({ ...settings, tickers: ['TAN'] });
  expect(firstSignal.aborted).toBe(true);
  expect(result.current).toEqual({ items: [], loading: true });
  await act(async () => second.resolve({ items: [{ ticker: 'TAN' }] }));
  await act(async () => first.resolve({ items: [{ ticker: 'IGV' }] }));
  expect(result.current).toEqual({ items: [{ ticker: 'TAN' }], loading: false });
});

test('date changes clear prior evidence and failed replacement stays empty', async () => {
  MarketDataService.getSecurityIntelligenceV2.mockResolvedValueOnce({ items: [{ ticker: 'IGV' }] })
    .mockRejectedValueOnce(new Error('offline'));
  const { result, rerender } = renderHook((props) => useMarketDailyResearch(props), { initialProps: settings });
  await waitFor(() => expect(result.current.items).toHaveLength(1));
  rerender({ ...settings, marketDate: '2026-09-25' });
  expect(result.current.items).toEqual([]);
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.items).toEqual([]);
});

test('reopening reloads evidence while equivalent ticker arrays do not refetch', async () => {
  MarketDataService.getSecurityIntelligenceV2.mockResolvedValue({ items: [] });
  const { result, rerender } = renderHook((props) => useMarketDailyResearch(props), { initialProps: settings });
  await waitFor(() => expect(result.current.loading).toBe(false));
  rerender({ ...settings, tickers: ['SMH', 'IGV', 'IGV'] });
  expect(MarketDataService.getSecurityIntelligenceV2).toHaveBeenCalledTimes(1);
  rerender({ ...settings, enabled: false });
  expect(result.current).toEqual({ items: [], loading: false });
  rerender(settings);
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(MarketDataService.getSecurityIntelligenceV2).toHaveBeenCalledTimes(2);
});
