import { act, renderHook } from '@testing-library/react';
import { usePortfolioMarketContext } from './usePortfolioMarketContext';
import { MarketDataService } from '../services/api/marketDataService';
import { startVisibilityAwarePolling } from '../utils/visibilityAwarePolling';
import { expectedSizingSession } from '../utils/volatilitySizingBand.cjs';

jest.mock('react-dom/test-utils', () => ({
  ...jest.requireActual('react-dom/test-utils'),
  act: jest.requireActual('react').act,
}));

jest.mock('../services/api/marketDataService', () => ({
  MarketDataService: {
    getSecurityRiskMetrics: jest.fn(),
    getVolatilitySnapshot: jest.fn(),
    getUsdCorrelations: jest.fn(),
  },
}));

jest.mock('../utils/visibilityAwarePolling', () => ({
  startVisibilityAwarePolling: jest.fn(),
}));

const NOW = Date.parse('2026-09-10T18:00:00.000Z');
const props = (overrides = {}) => ({
  active: true,
  symbolsKey: 'GLD',
  holdings: [{ symbol: 'GLD', securityType: 'STK' }],
  refreshKey: 0,
  ...overrides,
});
const pending = () => {
  let resolve;
  let reject;
  const promise = new Promise((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
};
// Source-attributed completed-history fixtures stay inside tests. No executable
// positions or prices are used to manufacture these independent risk estimates.
const riskRow = (symbol, { now = NOW, annualizationFactor = 252 } = {}) => {
  const asOf = expectedSizingSession(now, annualizationFactor);
  return {
    symbol, historicalOnly: true, executable: false, source: 'Yahoo Finance chart API', asOf,
    provenance: {
      provider: 'Yahoo Finance', dataset: 'chart', interval: '1d', adjustedCloseRequired: true,
      security: { requestedSymbol: symbol, fetchedAt: new Date(now).toISOString() },
    },
    beta: { status: 'available', value: 0.42, benchmark: 'SPY', asOf },
    atr14: { status: 'available', value: 4.5, asOf },
    zScore20: { status: 'available', value: 1.25, asOf },
    realizedVolatility: {
      status: 'available', rv63: 0.18, rv252: 0.15, sizingVol: 0.18,
      annualizationFactor, observationCount: 500, asOf, limitedHistory: false,
    },
  };
};
const riskPayload = (symbols = ['GLD'], options = {}) => ({
  status: 'available', historicalOnly: true, executable: false,
  generatedAt: new Date(options.now ?? NOW).toISOString(),
  rows: Object.fromEntries(symbols.map((symbol) => [symbol, riskRow(symbol, options)])),
});
const flush = async () => { await act(async () => { await Promise.resolve(); }); };
const latestPoll = () => startVisibilityAwarePolling.mock.calls.at(-1)[0];
const riskCalls = () => MarketDataService.getSecurityRiskMetrics.mock.calls;

beforeEach(() => {
  jest.useFakeTimers({ now: NOW });
  MarketDataService.getSecurityRiskMetrics.mockReset().mockImplementation((symbols) => Promise.resolve(riskPayload(symbols)));
  MarketDataService.getVolatilitySnapshot.mockReset().mockResolvedValue({});
  MarketDataService.getUsdCorrelations.mockReset().mockResolvedValue({});
  startVisibilityAwarePolling.mockReset().mockImplementation(() => jest.fn());
});

afterEach(() => {
  jest.useRealTimers();
});

test('does not request sources while inactive and reports empty active universes without provider requests', () => {
  const { result, rerender } = renderHook(usePortfolioMarketContext, { initialProps: props({ active: false }) });
  expect(result.current.marketContextState.status).toBe('idle');
  expect(startVisibilityAwarePolling).not.toHaveBeenCalled();
  rerender(props({ symbolsKey: '', holdings: [] }));
  expect(result.current.marketContextState).toEqual({
    status: 'empty', riskMetrics: null, volatility: null, usdCorrelations: null, errors: {},
    sourceStatus: { riskMetrics: 'empty', volatility: 'empty', usdCorrelations: 'empty' },
  });
  expect(riskCalls()).toHaveLength(0);
  expect(MarketDataService.getVolatilitySnapshot).not.toHaveBeenCalled();
  expect(MarketDataService.getUsdCorrelations).not.toHaveBeenCalled();
});

test('loads volatility and USD independently while historical metrics are still pending', async () => {
  const risk = pending();
  const volatility = pending();
  const usd = pending();
  MarketDataService.getSecurityRiskMetrics.mockReturnValue(risk.promise);
  MarketDataService.getVolatilitySnapshot.mockReturnValue(volatility.promise);
  MarketDataService.getUsdCorrelations.mockReturnValue(usd.promise);
  const { result } = renderHook(usePortfolioMarketContext, { initialProps: props() });
  expect(riskCalls()).toHaveLength(1);
  expect(MarketDataService.getVolatilitySnapshot).toHaveBeenCalledTimes(1);
  expect(MarketDataService.getUsdCorrelations).toHaveBeenCalledTimes(1);
  const volatilityData = { GVZ: { availability: 'available', freshness: 'current', lastPx: 18.25, asOf: new Date(NOW).toISOString() } };
  await act(async () => volatility.resolve(volatilityData));
  expect(result.current.marketContextState.volatility).toBe(volatilityData);
  expect(result.current.marketContextState.sourceStatus).toEqual({ riskMetrics: 'loading', volatility: 'ready', usdCorrelations: 'loading' });
  const usdData = { sourceStatus: 'current', calculationDate: '2026-09-10', correlations: { GOLD: { '30D': -0.72 } } };
  await act(async () => usd.resolve(usdData));
  expect(result.current.marketContextState.usdCorrelations).toBe(usdData);
  expect(result.current.getPositionSizeReference('GLD')).toMatchObject({ available: false, loading: true });
  await act(async () => risk.resolve(riskPayload()));
  expect(result.current.marketContextState.status).toBe('ready');
  expect(result.current.getPositionSizeReference(' gld ')).toMatchObject({
    available: true, value: '2.2–6.7%', loading: false,
    verification: { symbol: 'GLD', metric: 'Position size' },
    beta: { value: 0.42 },
  });
});

test('requests 17 symbols in sequential batches of eight, eight, and one while painting each successful batch', async () => {
  const symbols = Array.from({ length: 17 }, (_, index) => `SYM${String(index + 1).padStart(2, '0')}`);
  const batches = [pending(), pending(), pending()];
  batches.forEach((batch) => MarketDataService.getSecurityRiskMetrics.mockReturnValueOnce(batch.promise));
  const { result } = renderHook(usePortfolioMarketContext, { initialProps: props({
    symbolsKey: symbols.join(','), holdings: symbols.map((symbol) => ({ symbol, securityType: 'STK' })),
  }) });
  expect(riskCalls()).toHaveLength(1);
  expect(riskCalls()[0]).toEqual([symbols.slice(0, 8), { assetTypes: Object.fromEntries(symbols.slice(0, 8).map((symbol) => [symbol, 'equity'])) }]);
  await act(async () => batches[0].resolve(riskPayload(symbols.slice(0, 8))));
  expect(riskCalls()).toHaveLength(2);
  expect(riskCalls()[1][0]).toEqual(symbols.slice(8, 16));
  expect(result.current.marketContextState.sourceStatus.riskMetrics).toBe('partial');
  expect(Object.keys(result.current.marketContextState.riskMetrics.rows)).toHaveLength(8);
  expect(result.current.getPositionSizeReference(symbols[0]).available).toBe(true);
  await act(async () => batches[1].resolve(riskPayload(symbols.slice(8, 16))));
  expect(riskCalls()).toHaveLength(3);
  expect(riskCalls()[2][0]).toEqual(symbols.slice(16));
  expect(Object.keys(result.current.marketContextState.riskMetrics.rows)).toHaveLength(16);
  await act(async () => batches[2].resolve(riskPayload(symbols.slice(16))));
  expect(result.current.marketContextState.status).toBe('ready');
  expect(Object.keys(result.current.marketContextState.riskMetrics.rows)).toEqual(symbols);
  expect(MarketDataService.getVolatilitySnapshot).toHaveBeenCalledTimes(1);
  expect(MarketDataService.getUsdCorrelations).toHaveBeenCalledTimes(1);
});

test('keeps successful historical rows after a later batch fails but rejects sizing while the risk source has an error', async () => {
  const symbols = ['GLD', 'IAK', 'IBIT', 'NEM', 'OIH', 'QQQ', 'SPY', 'TLT', 'XLF'];
  const failure = pending();
  MarketDataService.getSecurityRiskMetrics
    .mockResolvedValueOnce(riskPayload(symbols.slice(0, 8)))
    .mockReturnValueOnce(failure.promise);
  const { result } = renderHook(usePortfolioMarketContext, { initialProps: props({
    symbolsKey: symbols.join(','), holdings: symbols.map((symbol) => ({ symbol, securityType: 'STK' })),
  }) });
  await flush();
  expect(result.current.getPositionSizeReference('GLD').available).toBe(true);
  await act(async () => failure.reject(new Error('Last batch unavailable')));
  expect(result.current.marketContextState).toMatchObject({
    status: 'partial', sourceStatus: { riskMetrics: 'partial' }, errors: { riskMetrics: 'Last batch unavailable' },
  });
  expect(result.current.marketContextState.riskMetrics.rows.GLD.beta.value).toBe(0.42);
  expect(result.current.getPositionSizeReference('GLD')).toMatchObject({ available: false, band: null, value: null, reason: 'The volatility provider is unavailable.' });
  expect(result.current.marketContextState.riskMetrics.rows).not.toHaveProperty('XLF');
});

test('retains verified historical metrics through a failed refresh without preserving sizing or failed auxiliary sources', async () => {
  const { result } = renderHook(usePortfolioMarketContext, { initialProps: props() });
  await flush();
  const accepted = result.current.marketContextState.riskMetrics;
  MarketDataService.getSecurityRiskMetrics.mockRejectedValueOnce(new Error('Risk refresh failed'));
  MarketDataService.getVolatilitySnapshot.mockRejectedValueOnce(new Error('Volatility offline'));
  MarketDataService.getUsdCorrelations.mockRejectedValueOnce(new Error('USD offline'));
  await act(async () => latestPoll().poll());
  expect(result.current.marketContextState.riskMetrics).toBe(accepted);
  expect(result.current.marketContextState.volatility).toBeNull();
  expect(result.current.marketContextState.usdCorrelations).toBeNull();
  expect(result.current.marketContextState.sourceStatus).toEqual({ riskMetrics: 'error', volatility: 'error', usdCorrelations: 'error' });
  expect(result.current.getPositionSizeReference('GLD')).toMatchObject({ available: false, beta: { value: 0.42 } });
});

test('does not let an auxiliary-source failure suppress independently verified sizing', async () => {
  MarketDataService.getVolatilitySnapshot.mockRejectedValue(new Error('Volatility index unavailable'));
  MarketDataService.getUsdCorrelations.mockRejectedValue(new Error('USD correlation unavailable'));
  const { result } = renderHook(usePortfolioMarketContext, { initialProps: props() });
  await flush();
  expect(result.current.marketContextState.status).toBe('partial');
  expect(result.current.marketContextState.sourceStatus.riskMetrics).toBe('ready');
  expect(result.current.marketContextState.errors).not.toHaveProperty('riskMetrics');
  expect(result.current.getPositionSizeReference('GLD').available).toBe(true);
});

test.each(['stale', 'cacheOnly', 'mock', 'seeded', 'disconnected'])('the real validator rejects a %s risk row even when the envelope is non-executable', async (flag) => {
  const payload = riskPayload();
  payload.rows.GLD[flag] = true;
  MarketDataService.getSecurityRiskMetrics.mockResolvedValue(payload);
  const { result } = renderHook(usePortfolioMarketContext, { initialProps: props() });
  await flush();
  expect(result.current.getPositionSizeReference('GLD')).toMatchObject({ available: false, band: null, value: null, reason: 'Verified volatility inputs are unavailable.' });
});

test('rejects a stale outer source contract instead of accepting its risk rows', async () => {
  MarketDataService.getSecurityRiskMetrics.mockResolvedValue({ ...riskPayload(), _cache: { stale: true } });
  const { result } = renderHook(usePortfolioMarketContext, { initialProps: props() });
  await flush();
  expect(result.current.marketContextState.riskMetrics).toBeNull();
  expect(result.current.marketContextState.errors.riskMetrics).toBe('Historical security metrics failed the non-executable source contract.');
  expect(result.current.getPositionSizeReference('GLD').available).toBe(false);
});

test('uses native crypto identity rather than exposure labels and does not refetch for equivalent holding objects', async () => {
  const holdings = [
    { symbol: 'BTC', securityType: 'STK' },
    { symbol: 'BTC-USD' },
    { symbol: 'ETH', secType: 'CRYPTO' },
    { symbol: 'IBIT', securityType: 'ETF', assetClass: 'Cryptocurrency' },
  ];
  const initial = props({ symbolsKey: 'BTC,BTC-USD,ETH,IBIT', holdings });
  const { rerender } = renderHook(usePortfolioMarketContext, { initialProps: initial });
  await flush();
  expect(riskCalls()[0]).toEqual([['BTC', 'BTC-USD', 'ETH', 'IBIT'], { assetTypes: {
    BTC: 'equity', 'BTC-USD': 'crypto', ETH: 'crypto', IBIT: 'equity',
  } }]);
  rerender({ ...initial, holdings: holdings.map((holding) => ({ ...holding })) });
  expect(riskCalls()).toHaveLength(1);
});

test('ignores an obsolete symbol-scope response and does not start its remaining batches', async () => {
  const oldBatch = pending();
  MarketDataService.getSecurityRiskMetrics.mockReturnValueOnce(oldBatch.promise).mockResolvedValueOnce(riskPayload(['NEM']));
  const oldSymbols = ['GLD', 'IAK', 'IBIT', 'OIH', 'QQQ', 'SPY', 'TLT', 'XLE', 'XLF'];
  const { result, rerender } = renderHook(usePortfolioMarketContext, { initialProps: props({
    symbolsKey: oldSymbols.join(','), holdings: oldSymbols.map((symbol) => ({ symbol, securityType: 'STK' })),
  }) });
  const firstStop = startVisibilityAwarePolling.mock.results[0].value;
  rerender(props({ symbolsKey: 'NEM', holdings: [{ symbol: 'NEM', securityType: 'STK' }] }));
  await flush();
  const accepted = result.current.marketContextState.riskMetrics;
  expect(accepted.rows.NEM).toBeDefined();
  expect(firstStop).toHaveBeenCalledTimes(1);
  await act(async () => oldBatch.resolve(riskPayload(oldSymbols.slice(0, 8))));
  expect(result.current.marketContextState.riskMetrics).toBe(accepted);
  expect(accepted.rows).not.toHaveProperty('GLD');
  expect(riskCalls()).toHaveLength(2);
});

test('resumes the remaining five-minute cadence and discards an unmounted batch continuation', async () => {
  const { result, rerender, unmount } = renderHook(usePortfolioMarketContext, { initialProps: props() });
  await flush();
  const accepted = result.current.marketContextState.riskMetrics;
  jest.setSystemTime(NOW + 60_000);
  rerender(props({ active: false }));
  expect(startVisibilityAwarePolling.mock.results[0].value).toHaveBeenCalledTimes(1);
  jest.setSystemTime(NOW + 120_000);
  rerender(props());
  expect(riskCalls()).toHaveLength(1);
  expect(latestPoll()).toMatchObject({ intervalMs: 300_000, initialDelayMs: 180_000 });
  expect(result.current.marketContextState.riskMetrics).toBe(accepted);
  const refresh = pending();
  MarketDataService.getSecurityRiskMetrics.mockReturnValueOnce(refresh.promise);
  let request;
  act(() => { request = latestPoll().poll(); });
  unmount();
  expect(startVisibilityAwarePolling.mock.results[1].value).toHaveBeenCalledTimes(1);
  await act(async () => { refresh.resolve(riskPayload()); await request; });
  expect(riskCalls()).toHaveLength(2);
});

test('returns existing rows and suppresses priority requests during initial bulk loading', async () => {
  const bulk = pending();
  MarketDataService.getSecurityRiskMetrics.mockReturnValueOnce(bulk.promise);
  const { result } = renderHook(usePortfolioMarketContext, { initialProps: props() });
  await expect(result.current.loadPriorityRiskMetrics('GLD')).resolves.toBeNull();
  await expect(result.current.loadPriorityRiskMetrics('NEM')).resolves.toBeNull();
  expect(riskCalls()).toHaveLength(1);
  await act(async () => bulk.resolve(riskPayload()));
  const row = result.current.marketContextState.riskMetrics.rows.GLD;
  await expect(result.current.loadPriorityRiskMetrics(' gld ')).resolves.toBe(row);
  await expect(result.current.loadPriorityRiskMetrics('')).resolves.toBeNull();
  expect(riskCalls()).toHaveLength(1);
});

test('shares one priority promise for a missing symbol and merges only its verified historical result', async () => {
  MarketDataService.getSecurityRiskMetrics.mockResolvedValueOnce(riskPayload([]));
  const { result } = renderHook(usePortfolioMarketContext, { initialProps: props() });
  await flush();
  const priority = pending();
  MarketDataService.getSecurityRiskMetrics.mockReturnValueOnce(priority.promise);
  let first;
  let second;
  act(() => {
    first = result.current.loadPriorityRiskMetrics(' gld ');
    second = result.current.loadPriorityRiskMetrics('GLD');
  });
  expect(second).toBe(first);
  expect(riskCalls()).toHaveLength(2);
  expect(riskCalls()[1]).toEqual([['GLD'], { assetTypes: { GLD: 'equity' } }]);
  const payload = riskPayload();
  let returned;
  await act(async () => { priority.resolve(payload); returned = await first; });
  expect(returned).toBe(payload.rows.GLD);
  expect(result.current.getPositionSizeReference('GLD').available).toBe(true);
  expect(result.current.marketContextState.errors).not.toHaveProperty('riskMetrics');
});

test('keeps a priority failure unavailable and allows a later explicit retry', async () => {
  MarketDataService.getSecurityRiskMetrics.mockResolvedValueOnce(riskPayload([]));
  const { result } = renderHook(usePortfolioMarketContext, { initialProps: props() });
  await flush();
  MarketDataService.getSecurityRiskMetrics.mockResolvedValueOnce({ ...riskPayload(), executable: true });
  let failed;
  await act(async () => { failed = await result.current.loadPriorityRiskMetrics('GLD'); });
  expect(failed).toBeNull();
  expect(result.current.marketContextState.errors.riskMetrics).toBe('Verified historical risk metrics are unavailable for this holding.');
  expect(result.current.getPositionSizeReference('GLD').available).toBe(false);
  await act(async () => result.current.loadPriorityRiskMetrics('GLD'));
  expect(riskCalls()).toHaveLength(3);
  expect(result.current.getPositionSizeReference('GLD').available).toBe(true);
});

test('revalidates at call time after response expiry without needing a new payload or render', async () => {
  const { result } = renderHook(usePortfolioMarketContext, { initialProps: props() });
  await flush();
  const getReference = result.current.getPositionSizeReference;
  expect(getReference('GLD').available).toBe(true);
  jest.setSystemTime(NOW + 600_001);
  expect(getReference('GLD')).toMatchObject({ available: false, band: null, value: null, reason: 'Current, sourced adjusted daily history is required.' });
  expect(riskCalls()).toHaveLength(1);
});

test('rejects sizing for any unsupported duplicate instrument even when a valid stock row exists', async () => {
  const initial = props();
  const { result, rerender } = renderHook(usePortfolioMarketContext, { initialProps: initial });
  await flush();
  expect(result.current.getPositionSizeReference('GLD').available).toBe(true);
  rerender({ ...initial, holdings: [...initial.holdings, { symbol: 'gld', contract: { secType: 'OPT' } }] });
  expect(result.current.getPositionSizeReference('GLD')).toMatchObject({
    available: false, band: null, value: null, reason: 'This instrument requires contract-specific risk sizing.',
  });
  expect(riskCalls()).toHaveLength(1);
});

describe('bulk request generation ownership', () => {
  test.each(['resolve', 'reject'])('an obsolete second batch cannot release its refreshed replacement when it settles by %s', async (outcome) => {
    const symbols = ['GLD', 'IAK', 'IBIT', 'NEM', 'OIH', 'QQQ', 'SPY', 'TLT', 'XLF'];
    const firstSymbols = symbols.slice(0, 8);
    const oldSecond = pending();
    const currentSecond = pending();
    const currentFirstPayload = riskPayload(firstSymbols);
    currentFirstPayload.rows.GLD.beta = { ...currentFirstPayload.rows.GLD.beta, value: 0.77 };
    MarketDataService.getSecurityRiskMetrics
      .mockResolvedValueOnce(riskPayload(firstSymbols))
      .mockReturnValueOnce(oldSecond.promise)
      .mockResolvedValueOnce(currentFirstPayload)
      .mockReturnValueOnce(currentSecond.promise);
    const initial = props({
      symbolsKey: symbols.join(','), holdings: symbols.map((symbol) => ({ symbol, securityType: 'STK' })),
    });
    const { result, rerender } = renderHook(usePortfolioMarketContext, { initialProps: initial });
    await flush();
    expect(riskCalls().map(([batch]) => batch)).toEqual([firstSymbols, ['XLF']]);
    rerender({ ...initial, refreshKey: 1 });
    await flush();
    expect(riskCalls().map(([batch]) => batch)).toEqual([firstSymbols, ['XLF'], firstSymbols, ['XLF']]);
    const currentState = result.current.marketContextState;
    expect(currentState).toMatchObject({
      status: 'partial', sourceStatus: { riskMetrics: 'partial' }, errors: {},
      riskMetrics: { rows: { GLD: { beta: { value: 0.77 } } } },
    });
    expect(currentState.riskMetrics.rows).not.toHaveProperty('XLF');
    await expect(result.current.loadPriorityRiskMetrics('XLF')).resolves.toBeNull();
    expect(riskCalls()).toHaveLength(4);

    await act(async () => {
      if (outcome === 'resolve') {
        const obsoletePayload = riskPayload(['XLF']);
        obsoletePayload.rows.XLF.beta = { ...obsoletePayload.rows.XLF.beta, value: 9.99 };
        oldSecond.resolve(obsoletePayload);
      } else {
        oldSecond.reject(new Error('Obsolete batch failed'));
      }
    });
    expect(result.current.marketContextState).toBe(currentState);
    let priorityResult;
    await act(async () => { priorityResult = await result.current.loadPriorityRiskMetrics(' xlf '); });
    expect(riskCalls()).toHaveLength(4);
    expect(priorityResult).toBeNull();
    expect(result.current.marketContextState).toBe(currentState);

    const currentSecondPayload = riskPayload(['XLF']);
    currentSecondPayload.rows.XLF.beta = { ...currentSecondPayload.rows.XLF.beta, value: 0.63 };
    await act(async () => currentSecond.resolve(currentSecondPayload));
    expect(result.current.marketContextState).toMatchObject({
      status: 'ready', sourceStatus: { riskMetrics: 'ready' }, errors: {},
      riskMetrics: { rows: { GLD: { beta: { value: 0.77 } }, XLF: { beta: { value: 0.63 } } } },
    });
    expect(result.current.getPositionSizeReference('XLF').available).toBe(true);
    await expect(result.current.loadPriorityRiskMetrics('XLF')).resolves.toBe(currentSecondPayload.rows.XLF);
    expect(riskCalls()).toHaveLength(4);
  });

  test('releases an obsolete batch marker for a symbol not claimed by the new scope without altering the new scope', async () => {
    const oldSymbols = ['GLD', 'IAK', 'IBIT', 'OIH', 'QQQ', 'SPY', 'TLT', 'XLE', 'XLF'];
    const oldSecond = pending();
    MarketDataService.getSecurityRiskMetrics
      .mockResolvedValueOnce(riskPayload(oldSymbols.slice(0, 8)))
      .mockReturnValueOnce(oldSecond.promise)
      .mockResolvedValueOnce(riskPayload(['NEM']));
    const { result, rerender } = renderHook(usePortfolioMarketContext, { initialProps: props({
      symbolsKey: oldSymbols.join(','), holdings: oldSymbols.map((symbol) => ({ symbol, securityType: 'STK' })),
    }) });
    await flush();
    rerender(props({ symbolsKey: 'NEM', holdings: [{ symbol: 'NEM', securityType: 'STK' }] }));
    await flush();
    const accepted = result.current.marketContextState;
    expect(accepted).toMatchObject({ status: 'ready', errors: {}, riskMetrics: { rows: { NEM: { symbol: 'NEM' } } } });
    expect(accepted.riskMetrics.rows).not.toHaveProperty('XLF');
    await act(async () => oldSecond.reject(new Error('Obsolete scope failed')));
    expect(result.current.marketContextState).toBe(accepted);
    const priorityPayload = riskPayload(['XLF']);
    MarketDataService.getSecurityRiskMetrics.mockResolvedValueOnce(priorityPayload);
    let priorityResult;
    await act(async () => { priorityResult = await result.current.loadPriorityRiskMetrics('XLF'); });
    expect(priorityResult).toBe(priorityPayload.rows.XLF);
    expect(riskCalls().map(([batch]) => batch)).toEqual([oldSymbols.slice(0, 8), ['XLF'], ['NEM'], ['XLF']]);
    expect(result.current.marketContextState.errors).toEqual({});
    expect(result.current.marketContextState.riskMetrics.rows.NEM).toBe(accepted.riskMetrics.rows.NEM);
  });
});
