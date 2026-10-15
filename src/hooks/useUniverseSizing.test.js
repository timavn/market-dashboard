import { act, renderHook, waitFor } from '@testing-library/react';
import useUniverseSizing from './useUniverseSizing';
import { MarketDataService } from '../services/api/marketDataService';

jest.mock('../constants/securitiesList', () => ({ SECURITIES_LIST: [{ ticker: 'AMZN' }, { ticker: 'IGV' }] }));
jest.mock('../services/api/marketDataService', () => ({ MarketDataService: { getExposureLabUniverse: jest.fn(), getSecurityRiskMetrics: jest.fn() } }));
const now = Date.parse('2026-09-07T22:00:00Z');
const source = 'Yahoo Finance chart API';
const metric = (value, observations) => ({ value, observations, asOf: '2026-09-04', source, status: 'available' });
const payload = symbols => ({ status: 'available', source, historicalOnly: true, executable: false, rows: Object.fromEntries(symbols.map(symbol => [symbol, {
  symbol, asOf: '2026-09-04', status: 'available', source, historicalOnly: true, executable: false, instrumentType: 'ETF',
  beta: metric(1.2, 252), atr14: metric(1, 14), referencePrice: metric(100, 1),
  provenance: { provider: 'Yahoo Finance', dataset: 'chart', interval: '1d', adjustedCloseRequired: true,
    security: { requestedSymbol: symbol, fetchedAt: new Date(now).toISOString() }, benchmark: { symbol: 'SPY', fetchedAt: new Date(now).toISOString() } },
}])) });

beforeEach(() => { jest.spyOn(Date, 'now').mockReturnValue(now); jest.clearAllMocks(); });
afterEach(() => jest.restoreAllMocks());

test('calculates the full named universe in bounded batches, beyond the configured securities', async () => {
  MarketDataService.getExposureLabUniverse.mockResolvedValue({ status: 'available', historicalOnly: true, executable: false,
    rows: [...Array.from({ length: 47 }, (_, i) => ({ ticker: `SYM${i}`, discoveryState: 'structured', nameVerified: true })), { ticker: 'PROSE', discoveryState: 'candidate' }] });
  let active = 0; let peak = 0;
  MarketDataService.getSecurityRiskMetrics.mockImplementation(async symbols => {
    active += 1; peak = Math.max(peak, active);
    expect(symbols.length).toBeLessThanOrEqual(6);
    await Promise.resolve(); active -= 1; return payload(symbols);
  });
  const { result } = renderHook(() => useUniverseSizing(true));
  await waitFor(() => expect(result.current.completed).toBe(49));
  expect(result.current.loading).toBe(false);
  expect(peak).toBeLessThanOrEqual(4);
  expect(MarketDataService.getSecurityRiskMetrics).toHaveBeenCalledWith(expect.any(Array), { forceRefresh: false, sizingOnly: true });
  expect(Object.values(result.current.bySymbol).every(row => row.available && row.maxWeight === 5)).toBe(true);
  expect(result.current.bySymbol.PROSE).toBeUndefined();
});

test('recalculation clears failed results instead of retaining old limits', async () => {
  MarketDataService.getExposureLabUniverse.mockResolvedValue({ status: 'available', historicalOnly: true, executable: false, rows: [] });
  MarketDataService.getSecurityRiskMetrics.mockImplementation(async symbols => payload(symbols));
  const { result } = renderHook(() => useUniverseSizing(true));
  await waitFor(() => expect(result.current.bySymbol.AMZN?.maxWeight).toBe(5));
  MarketDataService.getSecurityRiskMetrics.mockRejectedValue(new Error('history unavailable'));
  act(() => result.current.refresh());
  await waitFor(() => expect(result.current.bySymbol.AMZN?.available).toBe(false));
  expect(result.current.bySymbol.AMZN.maxWeight).toBeNull();
  expect(result.current.completed).toBe(2);
});

test('closing the surface cancels queued batches', async () => {
  MarketDataService.getExposureLabUniverse.mockResolvedValue({ status: 'available', historicalOnly: true, executable: false,
    rows: Array.from({ length: 50 }, (_, i) => ({ ticker: `SYM${i}`, discoveryState: 'structured', nameVerified: true })) });
  const pending = [];
  MarketDataService.getSecurityRiskMetrics.mockImplementation(symbols => new Promise(resolve => pending.push(() => resolve(payload(symbols)))));
  const { unmount } = renderHook(() => useUniverseSizing(true));
  await waitFor(() => expect(pending).toHaveLength(4));
  unmount();
  await act(async () => { pending.forEach(resolve => resolve()); });
  expect(MarketDataService.getSecurityRiskMetrics).toHaveBeenCalledTimes(4);
});

test('reopening revalidates recent completed history without repeating the whole download', async () => {
  MarketDataService.getExposureLabUniverse.mockResolvedValue({ status: 'available', historicalOnly: true, executable: false, rows: [] });
  MarketDataService.getSecurityRiskMetrics.mockImplementation(async symbols => payload(symbols));
  const { result, rerender } = renderHook(({ active }) => useUniverseSizing(active), { initialProps: { active: true } });
  await waitFor(() => expect(result.current.completed).toBe(2));
  rerender({ active: false }); rerender({ active: true });
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.bySymbol.AMZN.maxWeight).toBe(5);
  expect(MarketDataService.getSecurityRiskMetrics).toHaveBeenCalledTimes(1);
  Date.now.mockReturnValue(now + 3600001);
  rerender({ active: false }); rerender({ active: true });
  await waitFor(() => expect(MarketDataService.getSecurityRiskMetrics).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.bySymbol.AMZN.maxWeight).toBeNull();
});
