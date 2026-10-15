import { act } from 'react';
import { renderHook } from '@testing-library/react';
import useContractPerformance, { clearContractPerformanceHistory, normalizeContractPerformance, preloadContractPerformanceHistory } from './useContractPerformance';
import { MarketDataService } from '../services/api/marketDataService';
import { currentPayload, historyPayload } from './__fixtures__/contractPerformanceFixtures';

jest.mock('../services/api/marketDataService', () => ({ MarketDataService: {
  getPredictionMarketPerformanceHistory: jest.fn(), getPredictionMarketPerformanceCurrent: jest.fn(),
} }));
const final = { id: 'final', status: 'verified', displayState: 'SETTLED', market: 'gold', pnl: 5, risked: 10, currentValue: 15 };
const open = { id: 'open', status: 'open', displayState: 'OPEN', market: 'sp500', pnl: 2, risked: 4, currentValue: 6 };
const history = (revision = 'v1', rows = [final], account = 'U123') => historyPayload({ rows }, account, revision);
const current = (revision = 'v1', account = 'U123') => currentPayload({ rows: [open] }, account, revision);
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const flush = async () => act(async () => { for (let index = 0; index < 10; index += 1) await Promise.resolve(); });

describe('independent contract history and current resources', () => {
  beforeEach(() => {
    jest.useFakeTimers(); jest.setSystemTime(new Date('2026-09-11T18:00:00Z'));
    clearContractPerformanceHistory(); jest.resetAllMocks();
    MarketDataService.getPredictionMarketPerformanceHistory.mockResolvedValue(history());
    MarketDataService.getPredictionMarketPerformanceCurrent.mockImplementation(() => Promise.resolve(current()));
  });
  afterEach(() => { jest.useRealTimers(); clearContractPerformanceHistory(); });

  test('saved history renders while current hangs, with unknown current P&L rather than zero', async () => {
    MarketDataService.getPredictionMarketPerformanceCurrent.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useContractPerformance({ account: 'U123', active: true })); await flush();
    expect(result.current.data.rows.map((row) => row.id)).toEqual(['final']);
    expect(result.current.data.summary).toMatchObject({ realizedPnl: 5, openPnl: null, pnl: null });
    expect(result.current.status).toBe('partial');
  });
  test('current can render while history is preparing without claiming a zero realized result', async () => {
    MarketDataService.getPredictionMarketPerformanceHistory.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useContractPerformance({ account: 'U123', active: true })); await flush();
    expect(result.current.data.rows.map((row) => row.id)).toEqual(['open']);
    expect(result.current.data.summary).toMatchObject({ realizedPnl: null, openPnl: 2, pnl: null });
  });
  test('current failure removes active rows but retains independently verified history', async () => {
    const { result } = renderHook(() => useContractPerformance({ account: 'U123', active: true })); await flush();
    MarketDataService.getPredictionMarketPerformanceCurrent.mockRejectedValue(new Error('offline'));
    await act(async () => jest.advanceTimersByTime(60_000)); await flush();
    expect(result.current.data.rows.map((row) => row.id)).toEqual(['final']);
    expect(result.current.data.availability.history.observedAt).toBe('2026-09-01T12:00:00Z');
    expect(result.current.data.summary.openPnl).toBeNull();
    expect(MarketDataService.getPredictionMarketPerformanceHistory).toHaveBeenCalledTimes(1);
  });
  test.each([401, 403])('a current HTTP %s revokes account history, including pending historical replies', async (status) => {
    const pending = deferred(); MarketDataService.getPredictionMarketPerformanceHistory.mockReturnValue(pending.promise);
    MarketDataService.getPredictionMarketPerformanceCurrent.mockRejectedValue({ response: { status } });
    const { result } = renderHook(() => useContractPerformance({ account: 'U123', active: true })); await flush();
    await act(async () => pending.resolve(history())); await flush();
    expect(result.current.data).toBeNull(); expect(result.current.status).toBe('unavailable');
    expect(MarketDataService.getPredictionMarketPerformanceHistory).toHaveBeenCalledTimes(1);
  });
  test('expires current at 180 seconds even while hidden and a refresh is unresolved', async () => {
    const { result, rerender } = renderHook(({ active }) => useContractPerformance({ account: 'U123', active }), { initialProps: { active: true } }); await flush();
    MarketDataService.getPredictionMarketPerformanceCurrent.mockReturnValue(new Promise(() => {}));
    await act(async () => jest.advanceTimersByTime(60_000)); await flush();
    rerender({ active: false }); await act(async () => jest.advanceTimersByTime(120_001)); await flush();
    expect(result.current.data.rows.map((row) => row.id)).toEqual(['final']);
    expect(result.current.data.summary.openPnl).toBeNull();
    expect(MarketDataService.getPredictionMarketPerformanceCurrent).toHaveBeenCalledTimes(2);
  });
  test('fresh retained reopen makes no HTTP request until the 60-second current interval is due', async () => {
    const { rerender } = renderHook(({ active }) => useContractPerformance({ account: 'U123', active }), { initialProps: { active: true } }); await flush();
    rerender({ active: false }); await act(async () => jest.advanceTimersByTime(10_000)); rerender({ active: true }); await flush();
    expect(MarketDataService.getPredictionMarketPerformanceCurrent).toHaveBeenCalledTimes(1);
    await act(async () => jest.advanceTimersByTime(50_000)); await flush();
    expect(MarketDataService.getPredictionMarketPerformanceCurrent).toHaveBeenCalledTimes(2);
    expect(MarketDataService.getPredictionMarketPerformanceHistory).toHaveBeenCalledTimes(1);
  });
  test('hiding allows a pending same-account current read to finish, without duplicate reopen requests', async () => {
    const pending = deferred(); MarketDataService.getPredictionMarketPerformanceCurrent.mockReturnValue(pending.promise);
    const { result, rerender } = renderHook(({ active }) => useContractPerformance({ account: 'U123', active }), { initialProps: { active: true } }); await flush();
    const signal = MarketDataService.getPredictionMarketPerformanceCurrent.mock.calls[0][0].signal;
    rerender({ active: false }); expect(signal.aborted).toBe(false);
    rerender({ active: true }); await flush(); expect(MarketDataService.getPredictionMarketPerformanceCurrent).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve(current())); await flush();
    expect(result.current.data.rows.map((row) => row.id)).toEqual(['open', 'final']);
  });
  test('preloading and a true card remount reuse a single account history request', async () => {
    const pending = deferred(); MarketDataService.getPredictionMarketPerformanceHistory.mockReturnValue(pending.promise);
    preloadContractPerformanceHistory('U123');
    const { unmount } = renderHook(() => useContractPerformance({ account: 'U123', active: true })); await flush(); unmount();
    const { result } = renderHook(() => useContractPerformance({ account: 'U123', active: true })); await flush();
    await act(async () => pending.resolve(history())); await flush();
    expect(result.current.data.rows.some((row) => row.id === 'final')).toBe(true);
    expect(MarketDataService.getPredictionMarketPerformanceHistory).toHaveBeenCalledTimes(1);
    expect(window.localStorage.length).toBe(0);
  });
  test('account changes abort old current and cannot flash old history or accept its late result', async () => {
    const pending = deferred(); MarketDataService.getPredictionMarketPerformanceCurrent.mockReturnValueOnce(pending.promise).mockImplementation(({ account }) => Promise.resolve(current('v1', account)));
    MarketDataService.getPredictionMarketPerformanceHistory.mockImplementation(({ account }) => account === 'U123' ? Promise.resolve(history()) : new Promise(() => {}));
    const { result, rerender } = renderHook(({ account }) => useContractPerformance({ account, active: true }), { initialProps: { account: 'U123' } }); await flush();
    const signal = MarketDataService.getPredictionMarketPerformanceCurrent.mock.calls[0][0].signal;
    rerender({ account: 'U456' }); expect(result.current.data).toBeNull(); expect(signal.aborted).toBe(true); await flush();
    await act(async () => pending.resolve(current())); await flush();
    expect(result.current.data.selectedAccount).toBe('U456'); expect(result.current.data.rows.map((row) => row.id)).toEqual(['open']);
  });
  test('a changed revision immediately withdraws old history and replaces it rather than unioning rows', async () => {
    const { result } = renderHook(() => useContractPerformance({ account: 'U123', active: true })); await flush();
    const pending = deferred(); MarketDataService.getPredictionMarketPerformanceHistory.mockReturnValue(pending.promise);
    MarketDataService.getPredictionMarketPerformanceCurrent.mockResolvedValue(current('v2'));
    await act(async () => jest.advanceTimersByTime(60_000)); await flush();
    expect(result.current.data.rows.map((row) => row.id)).toEqual(['open']);
    await act(async () => pending.resolve(history('v2', [{ ...final, id: 'corrected' }]))); await flush();
    expect(result.current.data.rows.map((row) => row.id)).toEqual(['open', 'corrected']);
    expect(result.current.data.projectionRevision).toBe('v2');
  });
  test('a visible current refresh retries initially preparing history', async () => {
    MarketDataService.getPredictionMarketPerformanceHistory.mockRejectedValueOnce({ response: { status: 503, data: { code: 'HISTORY_PREPARING' } } }).mockResolvedValue(history());
    MarketDataService.getPredictionMarketPerformanceCurrent.mockResolvedValueOnce({ ...current(), historyRevision: null });
    const { result } = renderHook(() => useContractPerformance({ account: 'U123', active: true })); await flush();
    await act(async () => jest.advanceTimersByTime(60_000)); await flush();
    expect(result.current.data.rows.some((row) => row.id === 'final')).toBe(true);
  });
  test('a revision learned from detail conflict cannot be undone by an older pending current reply', async () => {
    const pending = deferred(); MarketDataService.getPredictionMarketPerformanceCurrent.mockReturnValueOnce(pending.promise);
    const { result } = renderHook(() => useContractPerformance({ account: 'U123', active: true })); await flush();
    MarketDataService.getPredictionMarketPerformanceHistory.mockResolvedValue(history('v2', [{ ...final, id: 'corrected' }]));
    act(() => result.current.refresh({ revision: 'v2' })); await flush();
    await act(async () => pending.resolve(current('v1'))); await flush();
    expect(result.current.data.projectionRevision).toBe('v2');
    expect(result.current.data.rows.map((row) => row.id)).toEqual(['open', 'corrected']);
    expect(MarketDataService.getPredictionMarketPerformanceHistory).toHaveBeenCalledTimes(2);
  });
  test('sort, venue and text filters are local and keep every recorded market discoverable', async () => {
    MarketDataService.getPredictionMarketPerformanceHistory.mockResolvedValue(history('v1', [{ ...final, venue: 'forecastex', contractLabel: 'Gold 4200' }, { ...final, id: 'silver', market: 'silver', venue: 'kalshi', contractLabel: 'Silver 40' }]));
    const { result, rerender } = renderHook((selection) => useContractPerformance({ account: 'U123', active: true, ...selection }), { initialProps: {} }); await flush();
    rerender({ venue: 'kalshi', search: 'silver 40', sort: 'pnl', direction: 'desc' });
    expect(result.current.data.rows.map((row) => row.id)).toEqual(['silver']);
    expect(result.current.data.markets.map((market) => market.key)).toContain('gold');
    expect(result.current.data.markets.map((market) => market.key)).toContain('silver');
    expect(MarketDataService.getPredictionMarketPerformanceHistory).toHaveBeenCalledTimes(1);
    expect(MarketDataService.getPredictionMarketPerformanceCurrent).toHaveBeenCalledTimes(1);
  });
  test.each(['fromCache', 'cacheOnly', 'stale', 'isMock', 'isSeeded'])('rejects %s current while retaining saved accounting evidence', async (flag) => {
    MarketDataService.getPredictionMarketPerformanceCurrent.mockResolvedValue({ ...current(), [flag]: true });
    const { result } = renderHook(() => useContractPerformance({ account: 'U123', active: true })); await flush();
    expect(result.current.data.rows.map((row) => row.id)).toEqual(['final']); expect(result.current.data.summary.openPnl).toBeNull();
  });
  test.each([{ status: 'unavailable' }, { tracker: { status: 'unavailable' } }])('rejects unavailable current despite contradictory ready metadata: %j', async (unavailable) => {
    MarketDataService.getPredictionMarketPerformanceCurrent.mockResolvedValue({ ...current(), ...unavailable });
    const { result } = renderHook(() => useContractPerformance({ account: 'U123', active: true })); await flush();
    expect(result.current.data.rows.map((row) => row.id)).toEqual(['final']); expect(result.current.data.summary.openPnl).toBeNull();
  });
});

describe('contract performance availability', () => {
  test.each(['fromCache', 'cacheOnly', 'stale', 'isMock', 'isSeeded'])('rejects %s payloads', (flag) => {
    expect(normalizeContractPerformance({ rows: [{ status: 'open', pnl: 100 }], [flag]: true })).toBeNull();
  });
  test('expires current figures independently from verified history', () => {
    const payload = {
      rows: [{ id: 'final', status: 'verified', pnl: 5 }, { id: 'active', status: 'open', pnl: 100 }],
      summary: { realizedPnl: 5, pnl: 105, openPnl: 100 },
      availability: { current: { status: 'ready', observedAt: new Date(Date.now() - 181_000).toISOString() } },
    };
    const result = normalizeContractPerformance(payload);
    expect(result.rows.map((row) => row.id)).toEqual(['final']);
    expect(result.activeRows).toEqual([]);
    expect(result.summary).toMatchObject({ realizedPnl: 5, pnl: null, openPnl: null });
    expect(result.tracker.currentDataComplete).toBe(false);
  });
});
