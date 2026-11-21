import { act, renderHook } from '@testing-library/react';
import useDashboardResearch, { DASHBOARD_RESEARCH_REFRESH_MS } from './useDashboardResearch';
import { MarketDataService } from '../services/api/marketDataService';

jest.mock('react-dom/test-utils', () => ({
  ...jest.requireActual('react-dom/test-utils'),
  act: jest.requireActual('react').act,
}));
jest.mock('../services/api/marketDataService', () => ({
  MarketDataService: { getRiskRanges: jest.fn(), getHedgeyeSnapshot: jest.fn(), getDashboardNarrativeResearch: jest.fn(), getSecurityIntelligenceV2: jest.fn(), getHedgaiResearch: jest.fn() },
}));

const DATE = '2026-09-25';
const NOW = `${DATE}T16:00:00Z`;
const riskRanges = (date = DATE, trend = 'BULLISH') => ({
  schemaVersion: 1, status: 'current', available: true,
  manifest: { publicationDate: date, expectedDate: date, persistedManifestVerified: true, persistedCompletionState: 'complete' },
  ranges: { SPX: { date, source: 'hedgeye-risk-ranges-email', provenance: 'primary', trend, lrr: 7546, hrr: 7797 } },
});
const earlyLook = () => ({
  source: 'gmail-html', date: DATE, snapshotType: 'early-look', reportType: 'early-look',
  article: { feedUrl: 'https://app.hedgeye.com/feed_items/187646' },
  htmlSource: `hedgeye-email/messages/${DATE}/early-look/source.html`,
  data: { 'U.S. Dollar Index (USD)': { trend: 'BULLISH', lrr: 99.98, hrr: 101.65 } },
});
const cryptoResearch = (cryptos = {
  ETH: { trend: 'BULLISH', buyTrade: 2525, sellTrade: 2862 },
  SOL: { trend: 'NEUTRAL', buyTrade: 106, sellTrade: 125 },
  XRP: { trend: 'BEARISH', buyTrade: 1.4, sellTrade: 1.7 },
}, overrides = {}) => ({
  source: 'gmail-html', date: DATE, snapshotType: 'bitcoin-trend-tracker', reportType: 'crypto-quant',
  article: { feedUrl: 'https://app.hedgeye.com/feed_items/187643' },
  htmlSource: `hedgeye-email/messages/${DATE}/crypto-quant/source.html`,
  data: { cryptos }, ...overrides,
});
const emptyNarrative = () => ({ schemaVersion: 1, verified: true, source: 'early-look-archive', readings: {} });
const flush = async () => { await act(async () => { await Promise.resolve(); }); };
const advance = async (time) => { await act(async () => { jest.advanceTimersByTime(time); }); };
const setHidden = (hidden) => Object.defineProperty(document, 'hidden', { configurable: true, value: hidden });
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
  MarketDataService.getRiskRanges.mockReset().mockResolvedValue(riskRanges());
  MarketDataService.getHedgeyeSnapshot.mockReset().mockImplementation(async (product) => product === 'early-look' ? earlyLook() : null);
  MarketDataService.getDashboardNarrativeResearch.mockReset().mockResolvedValue(emptyNarrative());
  MarketDataService.getSecurityIntelligenceV2.mockReset().mockResolvedValue({ schemaVersion: 2, bySymbol: {} });
  MarketDataService.getHedgaiResearch.mockReset().mockResolvedValue(null);
});
afterEach(() => { jest.useRealTimers(); delete document.hidden; });

test('loads seven shared sources once, polls while visible, and disposes the poller', async () => {
  const { result, unmount } = renderHook(() => useDashboardResearch({ riskRangeRefreshMs: 0 }));
  await flush();
  expect(MarketDataService.getRiskRanges).toHaveBeenCalledWith(null, { envelope: true });
  expect(MarketDataService.getHedgeyeSnapshot).toHaveBeenCalledWith('early-look', DATE, { throwOnError: true });
  expect(MarketDataService.getHedgeyeSnapshot).toHaveBeenCalledWith('bitcoin-trend-tracker', null, { throwOnError: true });
  expect(MarketDataService.getHedgeyeSnapshot).toHaveBeenCalledWith('crypto-quant', null, { throwOnError: true });
  expect(MarketDataService.getHedgeyeSnapshot).toHaveBeenCalledTimes(3);
  expect(MarketDataService.getDashboardNarrativeResearch).toHaveBeenCalledTimes(1);
  expect(MarketDataService.getHedgaiResearch).toHaveBeenCalledWith({ asOf: new Date(NOW).toISOString() });
  expect(result.current).toMatchObject({ status: 'available', loading: false, readings: { SPX: { trend: 'BULLISH' }, USD: { lrr: 99.98 } } });
  await visibility(true);
  await advance(DASHBOARD_RESEARCH_REFRESH_MS * 2);
  expect(MarketDataService.getRiskRanges).toHaveBeenCalledTimes(1);
  expect(MarketDataService.getHedgeyeSnapshot).toHaveBeenCalledTimes(3);
  expect(MarketDataService.getDashboardNarrativeResearch).toHaveBeenCalledTimes(1);
  await visibility(false);
  expect(MarketDataService.getRiskRanges).toHaveBeenCalledTimes(2);
  expect(MarketDataService.getHedgeyeSnapshot).toHaveBeenCalledTimes(6);
  expect(MarketDataService.getDashboardNarrativeResearch).toHaveBeenCalledTimes(2);
  unmount();
  await advance(DASHBOARD_RESEARCH_REFRESH_MS);
  expect(MarketDataService.getRiskRanges).toHaveBeenCalledTimes(2);
  expect(MarketDataService.getHedgeyeSnapshot).toHaveBeenCalledTimes(6);
  expect(MarketDataService.getDashboardNarrativeResearch).toHaveBeenCalledTimes(2);
});

test('exposes the independently published ETH, SOL and XRP research alongside the daily sources', async () => {
  MarketDataService.getHedgeyeSnapshot.mockImplementation(async (product) => {
    if (product === 'early-look') return earlyLook();
    if (product === 'bitcoin-trend-tracker') return cryptoResearch();
    return null;
  });
  const { result } = renderHook(() => useDashboardResearch({ riskRangeRefreshMs: 0 }));
  await flush();
  expect(result.current).toMatchObject({
    status: 'available', loading: false, readings: {
      SPX: { trend: 'BULLISH' }, USD: { lrr: 99.98 },
      ETH: { trend: 'BULLISH', lrr: 2525, hrr: 2862, source: 'Crypto Quant', date: DATE },
      SOL: { trend: 'NEUTRAL', lrr: 106, hrr: 125 },
      XRP: { trend: 'BEARISH', lrr: 1.4, hrr: 1.7 },
    },
  });
  expect(result.current.readings.ETH.rangeEvidence.sourceUrl).toBe('https://app.hedgeye.com/feed_items/187643');
});

test('retains the latest crypto publication with its original date through later days and transport failures', async () => {
  MarketDataService.getHedgeyeSnapshot.mockImplementation(async (product) => {
    if (product === 'early-look') return earlyLook();
    if (product === 'bitcoin-trend-tracker') return cryptoResearch();
    return null;
  });
  const { result } = renderHook(() => useDashboardResearch({ riskRangeRefreshMs: 0 }));
  await flush();
  const original = result.current.readings.ETH;
  const error = new Error('Transport unavailable');
  jest.setSystemTime(new Date('2026-09-28T16:00:00Z'));
  MarketDataService.getRiskRanges.mockRejectedValue(error);
  MarketDataService.getHedgeyeSnapshot.mockRejectedValue(error);
  MarketDataService.getDashboardNarrativeResearch.mockRejectedValue(error);
  await advance(DASHBOARD_RESEARCH_REFRESH_MS);
  expect(result.current).toMatchObject({ status: 'available', loading: false, error });
  expect(result.current.readings.ETH).toEqual(original);
  expect(result.current.readings.SOL.date).toBe(DATE);
  expect(result.current.readings.XRP.date).toBe(DATE);
  expect(result.current.readings.SPX).toBeUndefined();
  expect(result.current.readings.USD).toBeUndefined();
});

test('an explicitly invalid crypto source revokes its own research without removing independent sources', async () => {
  const quant = cryptoResearch({ BTC: { trend: 'BULLISH', buyTrade: 79664, sellTrade: 89001 } }, { snapshotType: 'crypto-quant' });
  const sources = { 'early-look': earlyLook(), 'bitcoin-trend-tracker': cryptoResearch(), 'crypto-quant': quant };
  MarketDataService.getHedgeyeSnapshot.mockImplementation(async (product) => sources[product]);
  const { result } = renderHook(() => useDashboardResearch({ riskRangeRefreshMs: 0 }));
  await flush();
  expect(result.current.readings.ETH.verified).toBe(true);
  const original = result.current.readings;
  sources['bitcoin-trend-tracker'] = { ...cryptoResearch(), stale: true };
  await advance(DASHBOARD_RESEARCH_REFRESH_MS);
  expect(result.current.readings.ETH).toBeUndefined();
  expect(result.current.readings.SOL).toBeUndefined();
  expect(result.current.readings.XRP).toBeUndefined();
  expect(result.current.readings.BTC).toEqual(original.BTC);
  expect(result.current.readings.SPX).toEqual(original.SPX);
  expect(result.current.readings.USD).toEqual(original.USD);
});

test('retains each verified current publication during transport errors and revokes explicit invalid evidence', async () => {
  const { result } = renderHook(() => useDashboardResearch({ riskRangeRefreshMs: 0 }));
  await flush();
  const error = new Error('Provider disconnected');
  const original = result.current.readings;
  MarketDataService.getRiskRanges.mockRejectedValueOnce(error);
  MarketDataService.getHedgeyeSnapshot.mockRejectedValueOnce(error);
  await advance(DASHBOARD_RESEARCH_REFRESH_MS);
  expect(result.current).toMatchObject({ status: 'available', error, readings: original });
  MarketDataService.getRiskRanges.mockResolvedValueOnce({ ...riskRanges(), stale: true });
  MarketDataService.getHedgeyeSnapshot.mockRejectedValueOnce(error);
  await advance(DASHBOARD_RESEARCH_REFRESH_MS);
  expect(result.current.readings.SPX).toBeUndefined();
  expect(result.current.readings.USD).toEqual(original.USD);
  MarketDataService.getRiskRanges.mockRejectedValueOnce(error);
  MarketDataService.getHedgeyeSnapshot.mockResolvedValueOnce(null);
  await advance(DASHBOARD_RESEARCH_REFRESH_MS);
  expect(result.current).toEqual({ status: 'unavailable', loading: false, error, readings: {} });
});

test('transport failures before the first verified publication cannot produce retained research', async () => {
  MarketDataService.getRiskRanges.mockRejectedValueOnce(new Error('offline'));
  MarketDataService.getHedgeyeSnapshot.mockRejectedValueOnce(new Error('offline'));
  const { result } = renderHook(() => useDashboardResearch({ riskRangeRefreshMs: 0 }));
  await flush();
  expect(result.current).toMatchObject({ status: 'unavailable', readings: {} });
});

test('does no work until the tab becomes visible', async () => {
  setHidden(true);
  const { result } = renderHook(() => useDashboardResearch({ riskRangeRefreshMs: 0 }));
  await flush();
  expect(MarketDataService.getRiskRanges).not.toHaveBeenCalled();
  expect(result.current.readings).toEqual({});
  await visibility(false);
  expect(result.current.readings.USD.verified).toBe(true);
});

test('clears yesterday at the new session date while the replacement request is pending', async () => {
  jest.setSystemTime(new Date('2026-09-24T23:59:00-04:00'));
  MarketDataService.getRiskRanges.mockResolvedValueOnce(riskRanges('2026-09-24'));
  MarketDataService.getHedgeyeSnapshot.mockResolvedValue(null);
  const { result } = renderHook(() => useDashboardResearch({ riskRangeRefreshMs: 0 }));
  await flush();
  expect(result.current.readings.SPX.date).toBe('2026-09-24');
  const next = pending();
  MarketDataService.getRiskRanges.mockReturnValueOnce(next.promise);
  await advance(DASHBOARD_RESEARCH_REFRESH_MS);
  expect(result.current).toMatchObject({ readings: {}, loading: true });
  expect(MarketDataService.getHedgeyeSnapshot).toHaveBeenNthCalledWith(4, 'early-look', DATE, { throwOnError: true });
  await act(async () => { next.resolve(riskRanges()); });
  expect(result.current.readings.SPX.date).toBe(DATE);
});

test('ignores a response crossing midnight and an older request completing last', async () => {
  jest.setSystemTime(new Date('2026-09-24T23:59:00-04:00'));
  const crossing = pending();
  MarketDataService.getRiskRanges.mockReturnValueOnce(crossing.promise);
  const { result } = renderHook(() => useDashboardResearch({ riskRangeRefreshMs: 0 }));
  await flush();
  jest.setSystemTime(new Date('2026-09-25T00:00:00-04:00'));
  await act(async () => { crossing.resolve(riskRanges('2026-09-24')); });
  expect(result.current.readings).toEqual({});
  const older = pending();
  MarketDataService.getRiskRanges.mockReturnValueOnce(older.promise).mockResolvedValueOnce(riskRanges(DATE, 'BEARISH'));
  await advance(DASHBOARD_RESEARCH_REFRESH_MS);
  await visibility(true);
  await visibility(false);
  expect(result.current.readings.SPX.trend).toBe('BEARISH');
  await act(async () => { older.resolve(riskRanges()); });
  expect(result.current.readings.SPX.trend).toBe('BEARISH');
});

test('uses Friday publication date on weekends and keeps that source date', async () => {
  jest.setSystemTime(new Date('2026-09-26T16:00:00Z'));
  const { result } = renderHook(() => useDashboardResearch({ riskRangeRefreshMs: 0 }));
  await flush();
  expect(MarketDataService.getHedgeyeSnapshot).toHaveBeenCalledWith('early-look', DATE, { throwOnError: true });
  expect(result.current.readings.USD.date).toBe(DATE);
});

test('does not retain the previous publication through an outage on the next market date', async () => {
  const { result } = renderHook(() => useDashboardResearch({ riskRangeRefreshMs: 0 }));
  await flush();
  jest.setSystemTime(new Date('2026-09-28T16:00:00Z'));
  MarketDataService.getRiskRanges.mockRejectedValueOnce(new Error('offline'));
  MarketDataService.getHedgeyeSnapshot.mockRejectedValueOnce(new Error('offline'));
  await advance(DASHBOARD_RESEARCH_REFRESH_MS);
  expect(result.current).toMatchObject({ status: 'unavailable', readings: {} });
});

test('shares Trade for all overview securities and retains its original evidence through a transport failure', async () => {
  const sourceText = 'VIX is BEARISH TRADE.';
  const intelligence = { schemaVersion: 2, marketDate: DATE, bySymbol: { VIX: { lastVerifiedDecision: { trade: {
    status: 'historical', value: 'BEARISH', sourceId: 'early-look', sourceLabel: 'Early Look',
    sourceTicker: 'VIX', sourceDate: '2026-09-18', sourceUrl: 'https://app.hedgeye.com/feed_items/187000',
    signalProvenance: { field: 'trade', method: 'explicit-statement', sourceField: 'article.bodyText', sourceText },
  } } } } };
  MarketDataService.getSecurityIntelligenceV2.mockResolvedValueOnce(intelligence);
  const { result } = renderHook(() => useDashboardResearch({ riskRangeRefreshMs: 0 }));
  await flush();
  expect(MarketDataService.getSecurityIntelligenceV2).toHaveBeenCalledWith({
    symbols: expect.arrayContaining(['SPX', 'USD', 'VIX', 'BTC', 'ETH']), date: DATE, historyDays: 5,
  });
  const original = result.current.readings.VIX;
  expect(original).toMatchObject({ trade: 'BEARISH', date: '2026-09-18' });
  MarketDataService.getSecurityIntelligenceV2.mockRejectedValueOnce(new Error('offline'));
  await advance(DASHBOARD_RESEARCH_REFRESH_MS);
  expect(result.current.readings.VIX).toEqual(original);
  MarketDataService.getSecurityIntelligenceV2.mockResolvedValueOnce({ schemaVersion: 2, bySymbol: {} });
  await advance(DASHBOARD_RESEARCH_REFRESH_MS);
  expect(result.current.readings.VIX).toBeUndefined();
});

test('shows independently ready research while the first Trade archive request is pending', async () => {
  const archive = pending();
  MarketDataService.getSecurityIntelligenceV2.mockReturnValueOnce(archive.promise);
  const { result } = renderHook(() => useDashboardResearch({ riskRangeRefreshMs: 0 }));
  await flush();
  expect(result.current.readings.SPX.trend).toBe('BULLISH');
  expect(result.current.readings.USD.lrr).toBe(99.98);
  await act(async () => { archive.resolve({ schemaVersion: 2, bySymbol: {} }); });
  expect(result.current.loading).toBe(false);
});

const hedgai = () => ({
  version: 1, product: 'hedgai-signals', asOf: NOW, baselineDate: DATE, metricsDate: DATE, threshold: 0.6,
  sourceQuality: { continuity: 'complete', issues: [] },
  book: { rows: [{ ticker: 'UUP', instrumentId: 'hedgai:UUP', sourceLabel: 'US Dollar',
    position: 'Short', activeDirection: 'Bearish', status: 'current', metricsDate: DATE,
    metrics: { short: { battingAverage: 0.7, signals: 20 } },
    positionSourceIds: ['position'], metricsSourceIds: ['metrics'] }] },
  sources: ['position', 'metrics'].map((id) => ({ id, sourceType: 'reviewed-screenshot',
    sourceUrl: 'https://app.hedgeye.com/feed_items/187646', publicationDate: DATE, publishedAt: `${DATE}T12:43:00Z` })),
});

test('shares published Tick and its USD proxy while leaving Trend independent and revokes Tick on a failed refresh', async () => {
  MarketDataService.getHedgaiResearch.mockResolvedValueOnce(hedgai());
  const { result } = renderHook(() => useDashboardResearch({ riskRangeRefreshMs: 0 }));
  await flush();
  expect(result.current.readings.UUP).toMatchObject({ tick: 'BEARISH', tickEvidence: { sourceTicker: 'UUP', date: DATE } });
  expect(result.current.readings.USD.trend).toBe('BULLISH');
  expect(result.current.readings.USD).toMatchObject({ tick: 'BEARISH', tickEvidence: { sourceTicker: 'UUP', matchType: 'proxy' } });
  const refresh = pending();
  MarketDataService.getHedgaiResearch.mockReturnValueOnce(refresh.promise);
  await advance(DASHBOARD_RESEARCH_REFRESH_MS);
  expect(result.current.readings.UUP.tick).toBe('BEARISH');
  await act(async () => { refresh.resolve(hedgai()); });
  const error = new Error('Tick delivery unavailable');
  MarketDataService.getHedgaiResearch.mockRejectedValueOnce(error);
  await advance(DASHBOARD_RESEARCH_REFRESH_MS);
  expect(result.current.readings.UUP).toBeUndefined();
  expect(result.current.readings.USD.trend).toBe('BULLISH');
  expect(result.current.readings.USD.tick).toBeUndefined();
  expect(result.current.error).toBe(error);
});

test.each([null, { ...hedgai(), mock: true }, { ...hedgai(), sourceQuality: { continuity: 'unknown', issues: [] } }])(
  'an unavailable Tick source keeps independently ready overview research: %p', async (value) => {
    MarketDataService.getHedgaiResearch.mockResolvedValueOnce(value);
    const { result } = renderHook(() => useDashboardResearch({ riskRangeRefreshMs: 0 }));
    await flush();
    expect(result.current.readings.UUP).toBeUndefined();
    expect(result.current.readings.USD.trend).toBe('BULLISH');
    expect(result.current.readings.SPX.trend).toBe('BULLISH');
  },
);

test('renders independently ready research while optional Tick projection is pending', async () => {
  const tick = pending();
  MarketDataService.getHedgaiResearch.mockReturnValueOnce(tick.promise);
  const { result } = renderHook(() => useDashboardResearch({ riskRangeRefreshMs: 0 }));
  await flush();
  expect(result.current.readings.SPX.trend).toBe('BULLISH');
  expect(result.current.readings.USD.lrr).toBe(99.98);
  await act(async () => { tick.resolve(hedgai()); });
  expect(result.current.loading).toBe(false);
  expect(result.current.readings.UUP.tick).toBe('BEARISH');
});

test('re-reads Risk Ranges alone every minute and shows a Real-Time Alert revision without the other sources', async () => {
  const { result } = renderHook(() => useDashboardResearch({ riskRangeRefreshMs: 60_000 }));
  await flush();
  expect(result.current.readings.SPX).toBeDefined();
  const first = MarketDataService.getRiskRanges.mock.results[0].value;
  const current = await first;
  const revised = { ...current, manifest: { ...current.manifest, dataVersion: 'risk-range-envelope-v2:revised' },
    ranges: { ...current.ranges, SPX: { ...current.ranges.SPX, lrr: 6899, hrr: 7367,
      revision: { lrr: 6899, hrr: 7367, eventTime: '2026-09-25T19:22:00+00:00', sourceMessageId: '1a1fa6a6a05e2a56' } } } };
  MarketDataService.getRiskRanges.mockResolvedValueOnce(revised);
  await advance(60_000);
  expect(MarketDataService.getRiskRanges).toHaveBeenCalledTimes(2);
  expect(MarketDataService.getHedgeyeSnapshot).toHaveBeenCalledTimes(3);
  expect(result.current.readings.SPX).toMatchObject({ lrr: 6899, hrr: 7367 });
  expect(result.current.readings.SPX.rangeEvidence).toMatchObject({ source: 'Real-Time Alert' });
});
