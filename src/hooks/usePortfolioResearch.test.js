import { act, renderHook } from '@testing-library/react';
import { usePortfolioResearch } from './usePortfolioResearch';
import { MarketDataService } from '../services/api/marketDataService';
import { startVisibilityAwarePolling } from '../utils/visibilityAwarePolling';
import { RESEARCH_REFRESH_INTERVAL_MS } from '../constants/portfolioResearch';

jest.mock('react-dom/test-utils', () => ({
  ...jest.requireActual('react-dom/test-utils'),
  act: jest.requireActual('react').act,
}));

jest.mock('../services/api/marketDataService', () => ({
  MarketDataService: {
    getSecurityIntelligence: jest.fn(),
    getSecurityIntelligenceV2: jest.fn(),
  },
}));

let mockV2Enabled = false;
jest.mock('./useSecurityIntelligence', () => ({
  get SECURITY_INTELLIGENCE_V2_ENABLED() { return mockV2Enabled; },
}));

jest.mock('../utils/visibilityAwarePolling', () => ({
  startVisibilityAwarePolling: jest.fn(),
}));

const NOW = Date.parse('2026-09-10T18:00:00.000Z');
const props = (overrides = {}) => ({
  active: true,
  symbolsKey: 'GLD',
  expandedRowCount: 0,
  refreshKey: 0,
  ...overrides,
});
const pending = () => {
  let resolve;
  let reject;
  const promise = new Promise((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
};
// Dated research-only fixtures. They never supply positions or executable quotes.
const envelope = ({ symbol = 'GLD', date = '2026-09-10', schema = 1, mapKey = 'bySymbol', label = 'current', history } = {}) => ({
  schemaVersion: schema,
  marketDate: date,
  generatedAt: `${date}T18:00:00.000Z`,
  historicalOnly: true,
  executable: false,
  [mapKey]: {
    [symbol]: {
      symbol,
      decision: { trade: { status: 'available', value: label } },
      ...(history ? { history } : {}),
    },
  },
});
const historyRows = (note) => [{ marketDate: '2026-09-09', directReferences: [{ excerpt: note }] }];
const researchCalls = () => MarketDataService.getSecurityIntelligence.mock.calls.map(([request]) => request);
const historyCalls = () => researchCalls().filter((request) => request.historyDays === 5);
const flush = async () => { await act(async () => { await Promise.resolve(); }); };
const latestPoll = () => startVisibilityAwarePolling.mock.calls.at(-1)[0];

beforeEach(() => {
  jest.useFakeTimers({ now: NOW });
  mockV2Enabled = false;
  MarketDataService.getSecurityIntelligence.mockReset().mockResolvedValue(envelope());
  MarketDataService.getSecurityIntelligenceV2.mockReset().mockResolvedValue(envelope({ schema: 2 }));
  startVisibilityAwarePolling.mockReset().mockImplementation(() => jest.fn());
});

afterEach(() => {
  jest.useRealTimers();
});

test('stays idle without requests or polling while initially inactive', () => {
  const { result } = renderHook(usePortfolioResearch, { initialProps: props({ active: false, expandedRowCount: 1 }) });
  expect(result.current.researchState).toEqual({
    status: 'idle', data: null, error: null, symbolsKey: null, historyStatus: 'idle', historyError: null,
  });
  expect(result.current.researchMarketDate).toBeNull();
  expect(researchCalls()).toEqual([]);
  expect(startVisibilityAwarePolling).not.toHaveBeenCalled();
});

test('reports an empty symbol scope without requesting current or history data', () => {
  const { result, unmount } = renderHook(usePortfolioResearch, { initialProps: props({ symbolsKey: '', expandedRowCount: 2 }) });
  expect(result.current.researchState).toEqual({
    status: 'empty', data: null, error: null, symbolsKey: '', historyStatus: 'empty', historyError: null,
  });
  expect(researchCalls()).toEqual([]);
  expect(latestPoll()).toMatchObject({ intervalMs: RESEARCH_REFRESH_INTERVAL_MS, initialDelayMs: RESEARCH_REFRESH_INTERVAL_MS });
  const stop = startVisibilityAwarePolling.mock.results[0].value;
  unmount();
  expect(stop).toHaveBeenCalledTimes(1);
});

test('waits for accepted current research and an expanded row before lazy history', async () => {
  const current = pending();
  const history = pending();
  MarketDataService.getSecurityIntelligence.mockImplementation(({ historyDays }) => historyDays ? history.promise : current.promise);
  const { result, rerender } = renderHook(usePortfolioResearch, { initialProps: props({ symbolsKey: 'GLD,NEM' }) });
  expect(researchCalls()).toHaveLength(1);
  expect(researchCalls()[0]).toMatchObject({ symbols: ['GLD', 'NEM'], historyDays: 0 });
  expect(result.current.researchState.status).toBe('loading');
  rerender(props({ symbolsKey: 'GLD,NEM', expandedRowCount: 2 }));
  expect(historyCalls()).toEqual([]);
  await act(async () => current.resolve(envelope()));
  expect(result.current.researchState.status).toBe('ready');
  expect(result.current.researchState.historyStatus).toBe('loading');
  expect(result.current.researchMarketDate).toBe('2026-09-10');
  expect(historyCalls()).toHaveLength(1);
  expect(historyCalls()[0]).toMatchObject({ symbols: ['GLD', 'NEM'], historyDays: 5 });
  await act(async () => history.resolve(envelope({ label: 'older current must not win', history: historyRows('history only') })));
  expect(result.current.researchState.historyStatus).toBe('ready');
  expect(result.current.researchState.data.bySymbol.GLD.decision.trade.value).toBe('current');
  expect(result.current.researchState.data.bySymbol.GLD.history).toEqual(historyRows('history only'));
  rerender(props({ symbolsKey: 'GLD,NEM', expandedRowCount: 0 }));
  rerender(props({ symbolsKey: 'GLD,NEM', expandedRowCount: 1 }));
  expect(historyCalls()).toHaveLength(1);
});

test.each([false, true])('uses the selected V2 feature flag (%s) for both current and history requests', async (enabled) => {
  mockV2Enabled = enabled;
  const selected = enabled ? MarketDataService.getSecurityIntelligenceV2 : MarketDataService.getSecurityIntelligence;
  const unused = enabled ? MarketDataService.getSecurityIntelligence : MarketDataService.getSecurityIntelligenceV2;
  selected.mockImplementation(({ historyDays }) => Promise.resolve({
    status: 'ok',
    data: envelope({ schema: enabled ? 2 : 1, history: historyDays ? historyRows('wrapped history') : undefined }),
  }));
  const { result } = renderHook(usePortfolioResearch, { initialProps: props({ expandedRowCount: 1 }) });
  await flush();
  expect(selected.mock.calls.map(([request]) => request.historyDays)).toEqual([0, 5]);
  expect(unused).not.toHaveBeenCalled();
  expect(result.current.researchMarketDate).toBe('2026-09-10');
  expect(result.current.researchState.historyStatus).toBe('ready');
  expect(result.current.researchState.data.data.bySymbol.GLD.history).toEqual(historyRows('wrapped history'));
});

test('aborts a previous symbol scope and ignores its late current response', async () => {
  const oldCurrent = pending();
  const nextCurrent = pending();
  MarketDataService.getSecurityIntelligence
    .mockReturnValueOnce(oldCurrent.promise)
    .mockReturnValueOnce(nextCurrent.promise);
  const { result, rerender, unmount } = renderHook(usePortfolioResearch, { initialProps: props() });
  const oldSignal = researchCalls()[0].signal;
  const oldStop = startVisibilityAwarePolling.mock.results[0].value;
  rerender(props({ symbolsKey: 'NEM' }));
  expect(oldSignal.aborted).toBe(true);
  expect(oldStop).toHaveBeenCalledTimes(1);
  expect(result.current.researchState).toMatchObject({ status: 'loading', data: null, symbolsKey: 'NEM' });
  await act(async () => oldCurrent.resolve(envelope({ label: 'superseded' })));
  expect(result.current.researchState).toMatchObject({ status: 'loading', data: null, symbolsKey: 'NEM' });
  await act(async () => nextCurrent.resolve(envelope({ symbol: 'NEM', date: '2026-09-11', label: 'accepted' })));
  expect(result.current.researchMarketDate).toBe('2026-09-11');
  expect(result.current.researchState.data.bySymbol).not.toHaveProperty('GLD');
  expect(result.current.researchState.data.bySymbol.NEM.decision.trade.value).toBe('accepted');
  const nextSignal = researchCalls()[1].signal;
  unmount();
  expect(nextSignal.aborted).toBe(true);
  expect(startVisibilityAwarePolling.mock.results[1].value).toHaveBeenCalledTimes(1);
});

test('retains dated same-scope research through a failed refresh but never across a failed new scope', async () => {
  const original = envelope();
  MarketDataService.getSecurityIntelligence.mockResolvedValueOnce(original);
  const { result, rerender } = renderHook(usePortfolioResearch, { initialProps: props() });
  await flush();
  const refresh = pending();
  MarketDataService.getSecurityIntelligence.mockReturnValueOnce(refresh.promise);
  let refreshPromise;
  act(() => { refreshPromise = latestPoll().poll(); });
  expect(result.current.researchState).toMatchObject({ status: 'loading', data: original, error: null });
  await act(async () => { refresh.reject(new Error('Research provider unavailable')); await refreshPromise; });
  expect(result.current.researchState).toMatchObject({ status: 'error', data: original, error: 'Research provider unavailable', symbolsKey: 'GLD' });
  expect(result.current.researchMarketDate).toBe('2026-09-10');
  MarketDataService.getSecurityIntelligence.mockRejectedValueOnce(new Error('New scope unavailable'));
  rerender(props({ symbolsKey: 'NEM' }));
  await flush();
  expect(result.current.researchState).toMatchObject({ status: 'error', data: null, error: 'New scope unavailable', symbolsKey: 'NEM' });
});

test('resumes the remaining polling delay without an activation request and aborts on unmount', async () => {
  const { result, rerender, unmount } = renderHook(usePortfolioResearch, { initialProps: props() });
  await flush();
  const accepted = result.current.researchState.data;
  const firstSignal = researchCalls()[0].signal;
  jest.setSystemTime(NOW + 60_000);
  rerender(props({ active: false }));
  expect(firstSignal.aborted).toBe(true);
  expect(startVisibilityAwarePolling.mock.results[0].value).toHaveBeenCalledTimes(1);
  jest.setSystemTime(NOW + 120_000);
  rerender(props());
  expect(researchCalls()).toHaveLength(1);
  expect(result.current.researchState.data).toBe(accepted);
  expect(latestPoll()).toMatchObject({ intervalMs: 300_000, initialDelayMs: 180_000 });
  const pendingRefresh = pending();
  MarketDataService.getSecurityIntelligence.mockReturnValueOnce(pendingRefresh.promise);
  let request;
  act(() => { request = latestPoll().poll(); });
  const resumedSignal = researchCalls()[1].signal;
  unmount();
  expect(resumedSignal.aborted).toBe(true);
  expect(startVisibilityAwarePolling.mock.results[1].value).toHaveBeenCalledTimes(1);
  await act(async () => { pendingRefresh.resolve(envelope({ label: 'too late' })); await request; });
});

test('synchronously invalidates pending history before the refresh key starts replacement current', async () => {
  const oldHistory = pending();
  const nextCurrent = pending();
  const nextHistory = pending();
  let refreshing = false;
  MarketDataService.getSecurityIntelligence.mockImplementation(({ historyDays }) => refreshing
    ? historyDays ? nextHistory.promise : nextCurrent.promise
    : historyDays ? oldHistory.promise : Promise.resolve(envelope()));
  const { result, rerender } = renderHook(usePortfolioResearch, { initialProps: props({ expandedRowCount: 1 }) });
  await flush();
  expect(historyCalls()).toHaveLength(1);
  const oldHistorySignal = historyCalls()[0].signal;
  act(() => result.current.invalidateHistory());
  expect(oldHistorySignal.aborted).toBe(false);
  await act(async () => oldHistory.resolve(envelope({ history: historyRows('already invalidated') })));
  expect(result.current.researchState.data.bySymbol.GLD).not.toHaveProperty('history');
  refreshing = true;
  rerender(props({ expandedRowCount: 1, refreshKey: 1 }));
  expect(oldHistorySignal.aborted).toBe(true);
  expect(historyCalls()).toHaveLength(1);
  await act(async () => nextCurrent.resolve(envelope({ label: 'replacement current' })));
  expect(historyCalls()).toHaveLength(2);
  await act(async () => nextHistory.resolve(envelope({ label: 'must not replace', history: historyRows('replacement history') })));
  expect(result.current.researchState.data.bySymbol.GLD.decision.trade.value).toBe('replacement current');
  expect(result.current.researchState.data.bySymbol.GLD.history).toEqual(historyRows('replacement history'));
});

test.each([
  ['market date', { date: '2026-09-11' }],
  ['schema', { schema: 2 }],
  ['symbol map', { mapKey: 'securities' }],
])('rejects history with a different %s without changing current data or its observation date', async (_label, change) => {
  const history = pending();
  MarketDataService.getSecurityIntelligence.mockImplementation(({ historyDays }) => historyDays ? history.promise : Promise.resolve(envelope()));
  const { result } = renderHook(usePortfolioResearch, { initialProps: props({ expandedRowCount: 1 }) });
  await flush();
  const current = result.current.researchState.data;
  await act(async () => history.resolve(envelope({ ...change, history: historyRows('wrong scope') })));
  expect(result.current.researchState).toMatchObject({ status: 'ready', historyStatus: 'error', historyError: 'Historical research is unavailable for the current market date.' });
  expect(result.current.researchState.data).toBe(current);
  expect(result.current.researchMarketDate).toBe('2026-09-10');
});

test('loads a replacement history window after same-symbol polling changes the current market date', async () => {
  let date = '2026-09-10';
  const nextHistory = pending();
  MarketDataService.getSecurityIntelligence.mockImplementation(({ historyDays }) => historyDays && date === '2026-09-11'
    ? nextHistory.promise
    : Promise.resolve(envelope({ date, history: historyDays ? historyRows('old window') : undefined })));
  const { result } = renderHook(usePortfolioResearch, { initialProps: props({ expandedRowCount: 1 }) });
  await flush();
  expect(result.current.researchState.data.bySymbol.GLD.history).toEqual(historyRows('old window'));
  date = '2026-09-11';
  await act(async () => latestPoll().poll());
  expect(result.current.researchMarketDate).toBe(date);
  expect(historyCalls()).toHaveLength(2);
  expect(result.current.researchState.historyStatus).toBe('loading');
  expect(result.current.researchState.data.bySymbol.GLD).not.toHaveProperty('history');
  await act(async () => nextHistory.resolve(envelope({ date, history: historyRows('new window') })));
  expect(result.current.researchState.historyStatus).toBe('ready');
  expect(result.current.researchState.data.bySymbol.GLD.history).toEqual(historyRows('new window'));
});

test('keeps accepted same-session history separate from a failed manual history refresh', async () => {
  let refreshing = false;
  MarketDataService.getSecurityIntelligence.mockImplementation(({ historyDays }) => historyDays && refreshing
    ? Promise.reject(new Error('History provider unavailable'))
    : Promise.resolve(envelope({ label: refreshing ? 'fresh current' : 'current', history: historyDays ? historyRows('retained history') : undefined })));
  const { result, rerender } = renderHook(usePortfolioResearch, { initialProps: props({ expandedRowCount: 1 }) });
  await flush();
  refreshing = true;
  act(() => result.current.invalidateHistory());
  rerender(props({ expandedRowCount: 1, refreshKey: 1 }));
  await flush();
  expect(result.current.researchState).toMatchObject({ status: 'ready', historyStatus: 'error', historyError: 'History provider unavailable' });
  expect(result.current.researchState.data.bySymbol.GLD.decision.trade.value).toBe('fresh current');
  expect(result.current.researchState.data.bySymbol.GLD.history).toEqual(historyRows('retained history'));
  expect(historyCalls()).toHaveLength(2);
});

describe('pending-history retry lifecycle', () => {
  const suspendAndResume = (rerender, transition) => {
    rerender(props(transition === 'hide/resume'
      ? { expandedRowCount: 1, active: false }
      : { expandedRowCount: 0 }));
    rerender(props({ expandedRowCount: 1 }));
  };

  test('keeps one pending request when the expanded-row count changes from one to two and back', async () => {
    const history = pending();
    MarketDataService.getSecurityIntelligence.mockImplementation(({ historyDays }) => historyDays ? history.promise : Promise.resolve(envelope()));
    const { result, rerender } = renderHook(usePortfolioResearch, { initialProps: props({ expandedRowCount: 1 }) });
    await flush();
    const signal = historyCalls()[0].signal;
    rerender(props({ expandedRowCount: 2 }));
    expect(signal.aborted).toBe(false);
    rerender(props({ expandedRowCount: 1 }));
    expect(signal.aborted).toBe(false);
    expect(historyCalls()).toHaveLength(1);
    await act(async () => history.resolve(envelope({ history: historyRows('same request accepted') })));
    expect(result.current.researchState.historyStatus).toBe('ready');
    expect(result.current.researchState.data.bySymbol.GLD.history).toEqual(historyRows('same request accepted'));
    expect(researchCalls()).toHaveLength(2);
  });

  test.each(['hide/resume', 'collapse/reopen'])(
    'retries canceled pending history exactly once after %s without refetching current research',
    async (transition) => {
      const oldHistory = pending();
      const replacement = pending();
      MarketDataService.getSecurityIntelligence
        .mockResolvedValueOnce(envelope())
        .mockReturnValueOnce(oldHistory.promise)
        .mockReturnValueOnce(replacement.promise);
      const { result, rerender } = renderHook(usePortfolioResearch, { initialProps: props({ expandedRowCount: 1 }) });
      await flush();
      const oldSignal = historyCalls()[0].signal;
      jest.setSystemTime(NOW + 60_000);
      suspendAndResume(rerender, transition);
      expect(oldSignal.aborted).toBe(true);
      expect(historyCalls()).toHaveLength(2);
      expect(historyCalls()[1].signal.aborted).toBe(false);
      expect(researchCalls().filter((request) => request.historyDays === 0)).toHaveLength(1);
      rerender(props({ expandedRowCount: 2 }));
      rerender(props({ expandedRowCount: 1 }));
      expect(historyCalls()).toHaveLength(2);
      expect(historyCalls()[1].signal.aborted).toBe(false);
      await act(async () => replacement.resolve(envelope({ history: historyRows('retried history') })));
      expect(result.current.researchState.historyStatus).toBe('ready');
      expect(result.current.researchState.data.bySymbol.GLD.history).toEqual(historyRows('retried history'));
      await act(async () => oldHistory.resolve(envelope({ history: historyRows('canceled response') })));
      expect(result.current.researchState.data.bySymbol.GLD.history).toEqual(historyRows('retried history'));
      expect(historyCalls()).toHaveLength(2);
    },
  );

  test.each([
    ['populated', historyRows('accepted history')],
    ['empty', []],
  ])('does not retry accepted %s history after hiding or collapsing', async (_label, history) => {
    MarketDataService.getSecurityIntelligence.mockImplementation(({ historyDays }) => Promise.resolve(envelope({ history: historyDays ? history : undefined })));
    const { result, rerender } = renderHook(usePortfolioResearch, { initialProps: props({ expandedRowCount: 1 }) });
    await flush();
    expect(result.current.researchState.historyStatus).toBe('ready');
    expect(result.current.researchState.data.bySymbol.GLD.history).toEqual(history);
    suspendAndResume(rerender, 'hide/resume');
    suspendAndResume(rerender, 'collapse/reopen');
    await flush();
    expect(result.current.researchState.historyStatus).toBe('ready');
    expect(result.current.researchState.data.bySymbol.GLD.history).toEqual(history);
    expect(historyCalls()).toHaveLength(1);
    expect(researchCalls()).toHaveLength(2);
  });

  test.each(['resolve', 'reject'])(
    'ignores an aborted request that later %s while its replacement is still pending',
    async (outcome) => {
      const oldHistory = pending();
      const replacement = pending();
      MarketDataService.getSecurityIntelligence
        .mockResolvedValueOnce(envelope())
        .mockReturnValueOnce(oldHistory.promise)
        .mockReturnValueOnce(replacement.promise);
      const { result, rerender } = renderHook(usePortfolioResearch, { initialProps: props({ expandedRowCount: 1 }) });
      await flush();
      suspendAndResume(rerender, 'collapse/reopen');
      expect(historyCalls()).toHaveLength(2);
      const replacementSignal = historyCalls()[1].signal;
      await act(async () => {
        if (outcome === 'resolve') oldHistory.resolve(envelope({ history: historyRows('obsolete history') }));
        else oldHistory.reject(new Error('Obsolete rejection'));
      });
      expect(replacementSignal.aborted).toBe(false);
      expect(result.current.researchState.historyStatus).toBe('loading');
      expect(result.current.researchState.historyError).toBeNull();
      expect(result.current.researchState.data.bySymbol.GLD).not.toHaveProperty('history');
      expect(historyCalls()).toHaveLength(2);
      await act(async () => replacement.resolve(envelope({ history: historyRows('new history') })));
      expect(result.current.researchState.historyStatus).toBe('ready');
      expect(result.current.researchState.data.bySymbol.GLD.history).toEqual(historyRows('new history'));
      suspendAndResume(rerender, 'hide/resume');
      expect(historyCalls()).toHaveLength(2);
      expect(researchCalls().filter((request) => request.historyDays === 0)).toHaveLength(1);
    },
  );

  test.each(['provider failure', 'scope mismatch'])('does not automatically loop after a history %s', async (outcome) => {
    const history = pending();
    MarketDataService.getSecurityIntelligence.mockImplementation(({ historyDays }) => historyDays ? history.promise : Promise.resolve(envelope()));
    const { result, rerender } = renderHook(usePortfolioResearch, { initialProps: props({ expandedRowCount: 1 }) });
    await flush();
    await act(async () => {
      if (outcome === 'provider failure') history.reject(new Error('History unavailable'));
      else history.resolve(envelope({ date: '2026-09-11', history: historyRows('wrong date') }));
    });
    expect(result.current.researchState.historyStatus).toBe('error');
    expect(result.current.researchState.historyError).toBe(outcome === 'provider failure'
      ? 'History unavailable'
      : 'Historical research is unavailable for the current market date.');
    await flush();
    rerender(props({ expandedRowCount: 2 }));
    rerender(props({ expandedRowCount: 1 }));
    await flush();
    expect(historyCalls()).toHaveLength(1);
    expect(result.current.researchState.data.bySymbol.GLD).not.toHaveProperty('history');
    expect(result.current.researchMarketDate).toBe('2026-09-10');
  });
});
