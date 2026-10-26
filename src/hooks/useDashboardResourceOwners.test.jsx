import { act, renderHook } from '@testing-library/react';
import { useDashboardPortfolio } from './useDashboardPortfolio';
import { useDashboardOverviewResources } from './useDashboardOverviewResources';
import { useDashboardEtfProResource } from './useDashboardEtfProResource';
import { useDashboardChangelog } from './useDashboardChangelog';
import { MarketDataService } from '../services/api/marketDataService';
import { resetSessionResourceStore } from '../utils/sessionResourceStore';
import { IBKR_SELECTED_ACCOUNT_KEY } from '../constants/ibkrAccountStorage';

jest.mock('react-dom/test-utils', () => ({
  ...jest.requireActual('react-dom/test-utils'),
  act: jest.requireActual('react').act,
}));
jest.mock('../services/api/marketDataService', () => ({ MarketDataService: {
  getPortfolio: jest.fn(), getProviderStatus: jest.fn(), getMultiRegionQuotes: jest.fn(),
  getHedgeyeEtfPro: jest.fn(), getHedgeyeChangelog: jest.fn(),
} }));

const NOW = Date.parse('2026-09-11T17:00:00.000Z');
const observedAt = new Date(NOW).toISOString();
const originalHidden = Object.getOwnPropertyDescriptor(document, 'hidden');
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const portfolio = accountId => ({
  accountId, holdings: [], dataSource: 'ibkr_api', liveSessionVerified: true,
  fromCache: false, fetchedAt: observedAt, socketVerifiedAt: observedAt,
});
const quotes = () => ({ us: [{ symbol: 'SPX', price: 6500, source: 'ibkr', dataType: 'live', availability: 'current', quoteAsOf: observedAt }] });
const periods = () => ({ us: [{ symbol: 'SPX', monthChangePct: 2.4, periodReturnsAsOf: observedAt, periodReturnsStatus: 'historical' }] });
const status = () => ({ ibkr: { connected: true, status: 'connected', accounts: ['A', 'B'] } });
const flush = async () => { await act(async () => { await Promise.resolve(); }); };

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
  jest.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  resetSessionResourceStore();
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
  MarketDataService.getPortfolio.mockImplementation(({ account }) => Promise.resolve(portfolio(account)));
  MarketDataService.getProviderStatus.mockResolvedValue(status());
  MarketDataService.getMultiRegionQuotes.mockImplementation((_scope, current) => Promise.resolve(current ? quotes() : periods()));
});
afterEach(() => {
  resetSessionResourceStore();
  jest.useRealTimers();
  if (originalHidden) Object.defineProperty(document, 'hidden', originalHidden);
  else delete document.hidden;
});

describe('dashboard portfolio resource owner', () => {
  it('discovers an account once, preserves the initial overview/portfolio settled gate, and deduplicates provider requests', async () => {
    const health = deferred();
    const positions = deferred();
    const market = deferred();
    MarketDataService.getProviderStatus.mockReturnValue(health.promise);
    MarketDataService.getPortfolio.mockReturnValue(positions.promise);
    MarketDataService.getMultiRegionQuotes.mockReturnValue(market.promise);
    const { result, unmount } = renderHook(() => {
      const account = useDashboardPortfolio({ surfaceActive: true });
      const overview = useDashboardOverviewResources({ surfaceActive: true });
      const multiRegionLoading = Boolean(overview.currentMarketResource.initialLoading && !overview.currentMarketResource.data);
      return { ...account, settled: !multiRegionLoading && (!account.selectedAccount || !account.portfolioLoading) };
    });
    await flush();
    expect(MarketDataService.getPortfolio).not.toHaveBeenCalled();
    expect(MarketDataService.getProviderStatus).toHaveBeenCalledTimes(1);
    expect(MarketDataService.getMultiRegionQuotes).toHaveBeenCalledTimes(1);
    expect(result.current.settled).toBe(false);
    let manual;
    act(() => { manual = result.current.refreshProviderStatus(); });
    expect(MarketDataService.getProviderStatus).toHaveBeenCalledTimes(1);
    await act(async () => { health.resolve(status()); await manual; });
    expect(result.current.selectedAccount).toBe('A');
    expect(localStorage.getItem(IBKR_SELECTED_ACCOUNT_KEY)).toBe('A');
    expect(MarketDataService.getPortfolio).toHaveBeenCalledTimes(1);
    await act(async () => { market.resolve(quotes()); });
    expect(result.current.settled).toBe(false);
    await act(async () => { positions.resolve(portfolio('A')); });
    expect(result.current.settled).toBe(true);
    unmount();
  });

  it('invalidates the old account immediately and ignores late old-account and provider discovery responses', async () => {
    localStorage.setItem(IBKR_SELECTED_ACCOUNT_KEY, 'A');
    const oldRead = deferred();
    const newRead = deferred();
    const health = deferred();
    MarketDataService.getProviderStatus.mockReturnValue(health.promise);
    MarketDataService.getPortfolio.mockImplementation(({ account }) => account === 'A' ? oldRead.promise : newRead.promise);
    const { result, unmount } = renderHook(() => useDashboardPortfolio({ surfaceActive: true }));
    await flush();
    await act(async () => { await result.current.handleAccountChange('B'); });
    expect(result.current.selectedAccount).toBe('B');
    expect(result.current.portfolioData).toBeNull();
    expect(localStorage.getItem(IBKR_SELECTED_ACCOUNT_KEY)).toBe('B');
    await act(async () => { oldRead.resolve(portfolio('A')); health.resolve(status()); });
    expect(result.current.selectedAccount).toBe('B');
    expect(result.current.portfolioData).toBeNull();
    expect(MarketDataService.getPortfolio.mock.calls.map(([options]) => options.account)).toEqual(['A', 'B']);
    await act(async () => { newRead.resolve(portfolio('B')); });
    expect(result.current.portfolioData.accountId).toBe('B');
    await act(async () => { await result.current.fetchPortfolio('A'); });
    expect(MarketDataService.getPortfolio).toHaveBeenCalledTimes(2);
    unmount();
  });

  it('keeps portfolio ownership independent of surface activity and fails closed on a bad refresh', async () => {
    localStorage.setItem(IBKR_SELECTED_ACCOUNT_KEY, 'A');
    const { result, rerender, unmount } = renderHook(({ active }) => useDashboardPortfolio({ surfaceActive: active }), { initialProps: { active: false } });
    await flush();
    expect(result.current.portfolioData.accountId).toBe('A');
    expect(MarketDataService.getProviderStatus).not.toHaveBeenCalled();
    rerender({ active: true });
    await flush();
    expect(MarketDataService.getProviderStatus).toHaveBeenCalledTimes(1);
    expect(MarketDataService.getPortfolio).toHaveBeenCalledTimes(1);
    for (const bad of [{ dataSource: 'ibkr_offline' }, { fromCache: true }, { seeded: true }, { mock: true }, { _cache: { stale: true } }]) {
      MarketDataService.getPortfolio.mockResolvedValueOnce({ ...portfolio('A'), ...bad });
      await act(async () => { await result.current.fetchPortfolio('A'); });
      expect(result.current.portfolioData).toBeNull();
    }
    unmount();
  });

  it('retains only provider-health display on timeout and suspends provider requests while document-hidden', async () => {
    localStorage.setItem(IBKR_SELECTED_ACCOUNT_KEY, 'A');
    const { result, unmount } = renderHook(() => useDashboardPortfolio({ surfaceActive: true }));
    await flush();
    MarketDataService.getProviderStatus.mockReturnValue(new Promise(() => {}));
    let request;
    act(() => { request = result.current.refreshProviderStatus(); });
    await act(async () => { jest.advanceTimersByTime(3500); await request; });
    expect(result.current.providerStatus).toMatchObject({ statusRefreshDelayed: true, ibkr: { connected: true } });
    expect(result.current.ibkrConnection).toMatchObject({ statusRefreshDelayed: true, connected: true });
    expect(result.current.portfolioData.accountId).toBe('A');
    let hidden = true;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    await act(async () => { jest.advanceTimersByTime(20_000); });
    expect(MarketDataService.getProviderStatus).toHaveBeenCalledTimes(2);
    MarketDataService.getProviderStatus.mockResolvedValue(status());
    hidden = false;
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(MarketDataService.getProviderStatus).toHaveBeenCalledTimes(3);
    unmount();
  });
});

describe('dashboard overview and support owners', () => {
  it('defers period hydration until activated and retains verified overview data without advancing observation time', async () => {
    const { result, rerender, unmount } = renderHook(({ active }) => useDashboardOverviewResources({ surfaceActive: active }), { initialProps: { active: false } });
    await flush();
    expect(result.current.currentMarketResource.availability).toBe('live');
    expect(MarketDataService.getMultiRegionQuotes.mock.calls).toEqual([[null, true, false]]);
    await act(async () => { jest.advanceTimersByTime(1500); });
    expect(MarketDataService.getMultiRegionQuotes).toHaveBeenCalledTimes(1);
    rerender({ active: true });
    await flush();
    expect(MarketDataService.getMultiRegionQuotes.mock.calls).toEqual([[null, true, false], [null, false, true]]);
    const original = result.current.currentMarketResource.data;
    const timestamp = result.current.currentMarketResource.observedAt;
    MarketDataService.getMultiRegionQuotes.mockRejectedValueOnce(new Error('Provider offline'));
    await act(async () => { await result.current.currentMarketResource.refresh(); });
    expect(result.current.currentMarketResource.data).toBe(original);
    expect(result.current.currentMarketResource.observedAt).toBe(timestamp);
    expect(result.current.currentMarketResource.availability).toBe('refresh-delayed');
    unmount();
  });

  it('activates ETF Pro once, keeps dated rows after refresh failure, and does not refresh solely on reopen', async () => {
    const snapshot = { rows: [{ symbol: 'SPY' }], meta: { snapshotDate: observedAt } };
    MarketDataService.getHedgeyeEtfPro.mockResolvedValue(snapshot);
    const { result, rerender, unmount } = renderHook(({ visible }) => useDashboardEtfProResource({ surfaceActive: true, showEtfPro: visible }), { initialProps: { visible: false } });
    await flush();
    expect(MarketDataService.getHedgeyeEtfPro).not.toHaveBeenCalled();
    rerender({ visible: true });
    await flush();
    expect(result.current.data).toBe(snapshot);
    rerender({ visible: false });
    rerender({ visible: true });
    await flush();
    expect(MarketDataService.getHedgeyeEtfPro).toHaveBeenCalledTimes(1);
    MarketDataService.getHedgeyeEtfPro.mockRejectedValueOnce(new Error('network failed'));
    await act(async () => { await result.current.refresh(); });
    expect(result.current.data).toBe(snapshot);
    expect(result.current.availability).toBe('refresh-delayed');
    unmount();
  });

  it('deduplicates shared changelog consumers and retains the completed-refresh cooldown on panel switches', async () => {
    const request = deferred();
    MarketDataService.getHedgeyeChangelog.mockReturnValue(request.promise);
    const { result, rerender, unmount } = renderHook(props => useDashboardChangelog(props), { initialProps: { surfaceActive: true, showMorningTldr: true, showSignalStrength: false } });
    await flush();
    let manual;
    act(() => { manual = result.current.fetchHedgeyeChangelog(); });
    expect(MarketDataService.getHedgeyeChangelog).toHaveBeenCalledTimes(1);
    await act(async () => { request.resolve({ rows: [], _cache: { stale: true, ageSeconds: 125 } }); await manual; });
    expect(result.current.hedgeyeChangelogError).toBe('Showing a stale cached changelog response (2 minutes old).');
    expect(result.current.hedgeyeChangelogLoading).toBe(false);
    rerender({ surfaceActive: true, showMorningTldr: false, showSignalStrength: true });
    await act(async () => { jest.advanceTimersByTime(299_999); });
    expect(MarketDataService.getHedgeyeChangelog).toHaveBeenCalledTimes(1);
    await act(async () => { jest.advanceTimersByTime(1); });
    expect(MarketDataService.getHedgeyeChangelog).toHaveBeenCalledTimes(2);
    unmount();
  });
});
