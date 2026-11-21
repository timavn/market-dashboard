import catalog from '../constants/dashboardResearchCatalog.json';
import tickReferences from '../constants/dashboardTickResearchCatalog.json';
import hedgaiInstruments from '../../infra/lambdas/gmail_ingestor/hedgai_instruments.json';
import { normalizePublishedTickResearch, selectPublishedTickResearch } from './publishedTickResearch.cjs';
import backdrop from '../constants/marketBackdropCatalog.json';
import { CURRENCY_PAIRS } from '../constants/usdMarket';
import {
  dashboardResearchMarketDate,
  dashboardResearchSymbol,
  normalizeDashboardEarlyLook,
  normalizeDashboardResearch,
  normalizeDashboardRiskRanges,
  mergeDashboardResearchReadings,
  normalizeDashboardNarrativeEnvelope,
  normalizeDashboardTickResearch,
} from './dashboardResearch';

const DATE = '2026-09-25';
const sourceUrl = 'https://app.hedgeye.com/feed_items/187646';
const options = { date: DATE };
const row = (overrides = {}) => ({
  trend: 'BULLISH', lrr: 99.98, hrr: 101.65, date: DATE,
  provenance: 'primary', source: 'hedgeye-risk-ranges-email', ...overrides,
});
const envelope = (ranges = { DXY: row({ originalName: 'U.S. Dollar Index' }) }, overrides = {}) => ({
  schemaVersion: 1, available: true, status: 'current', ranges,
  manifest: { publicationDate: DATE, expectedDate: DATE, persistedManifestVerified: true, persistedCompletionState: 'complete' },
  ...overrides,
});
const earlyLook = (data = { 'U.S. Dollar Index (USD)': row({ originalName: 'U.S. Dollar Index (USD)' }) }, overrides = {}) => ({
  source: 'gmail-html', date: DATE, snapshotType: 'early-look', reportType: 'early-look',
  article: { feedUrl: sourceUrl }, htmlSource: `hedgeye-email/messages/${DATE}/early-look/source.html`, data, ...overrides,
});
const primary = (payload) => normalizeDashboardRiskRanges(payload, options);
const supplemental = (payload) => normalizeDashboardEarlyLook(payload, options);

test('catalog covers the entire asset, dollar and volatility roster without alias collisions', () => {
  const symbols = new Set(catalog.map((entry) => entry.symbol));
  const expected = [
    ...backdrop.flatMap((group) => group.rows.map((entry) => entry.symbol)),
    ...CURRENCY_PAIRS.map((entry) => entry.pair),
    'USD', 'VIX', 'VVIX', 'RVX', 'VXN', 'VXEEM', 'GVZ', 'OVX', 'BITVX', 'MOVE', 'G5RV',
  ];
  expect(expected.filter((symbol) => !symbols.has(symbol))).toEqual([]);
  catalog.forEach((entry) => entry.aliases.forEach((alias) => {
    expect(dashboardResearchSymbol(alias)).toBe(entry.symbol);
  }));
});

test.each(['BULLISH', 'BEARISH', 'NEUTRAL'])('keeps published %s and full range precision with dated evidence', (trend) => {
  const reading = primary(envelope({ DXY: row({ trend }) })).USD;
  expect(reading).toMatchObject({ trend, lrr: 99.98, hrr: 101.65, date: DATE, verified: true, source: 'Risk Ranges' });
  expect(reading.trendEvidence).toEqual(reading.rangeEvidence);
  expect(reading.rangeEvidence).toEqual({ date: DATE, source: 'Risk Ranges', sourceType: 'primary', sourceTicker: 'DXY', sourceUrl: `/api/hedgeye/screenshot/${DATE}/content?type=risk-ranges` });
});

test.each([
  ['SPX', 'S&P 500', 'SPX'], ['COMPQ', 'NASDAQ Composite', 'IXIC'],
  ['NIKK', 'Nikkei 225 Index', 'N225'], ['WTIC', 'Light Crude Oil Continuous Contract', 'CL'],
  ['BRENT', 'Brent Crude Oil Continuous Contract', 'BZ'], ['NATGAS', 'Natural Gas Continuous Contract', 'NG'],
  ['BITCOIN', 'Bitcoin Spot Price', 'BTC'], ['USD/YEN', 'U.S. Dollar to Japanese Yen', 'USDJPY'],
  ['VIX', 'Volatility Index', 'VIX'],
])('maps exact %s identity to %s without changing values', (ticker, originalName, symbol) => {
  expect(primary(envelope({ [ticker]: row({ originalName }) }))[symbol]).toMatchObject({ lrr: 99.98, hrr: 101.65 });
  expect(supplemental(earlyLook({ [`${originalName} (${ticker})`]: row() }))[symbol]).toMatchObject({ trend: 'BULLISH' });
});

test.each([
  ['GC', { originalName: 'Gold Spot Price' }], ['SPY', { originalName: 'S&P 500' }],
  ['SPX', { ticker: 'SPY' }], ['USD', { originalName: 'U.S. Dollar Index ETF' }],
  ['USD', { symbol: 'UUP' }], ['QQQ', { originalName: 'NASDAQ Composite' }],
  ['HYG', { originalName: 'High Yield' }], ['CAD/USD', {}], ['UST10Y', { originalName: '10-Year Treasury Futures' }],
])('never assigns conflicting, proxy, spot/future, or reverse-only identity %s %p', (ticker, fields) => {
  expect(dashboardResearchSymbol(ticker, fields)).toBeNull();
  expect(primary(envelope({ [ticker]: row(fields) }))).toEqual({});
});

test('keeps EUR/USD in its original units and never creates USD/EUR', () => {
  const readings = primary(envelope({ 'EUR/USD': row({ lrr: 1.134, hrr: 1.152, originalName: 'Euro to U.S. Dollar' }) }));
  expect(readings.EURUSD).toMatchObject({ lrr: 1.134, hrr: 1.152, trend: 'BULLISH' });
  expect(readings.USDEUR).toBeUndefined();
});

test.each([
  { mock: true }, { seeded: true }, { seed: true }, { cacheOnly: true }, { fromCache: true },
  { stale: true }, { sourceVerified: false }, { verified: false }, { success: false },
  { connected: false }, { status: 'offline' }, { sourceStatus: 'failed' }, { freshness: 'stale' },
  { availability: 'unavailable' }, { cacheState: 'cache_only' }, { cacheStatus: 'stale' },
  { source: 'portfolio' }, { provider: 'model' }, { inferred: true }, { fallback: true },
])('rejects invalid evidence at publication, metadata, and row scope %p', (flags) => {
  expect(primary(envelope(undefined, flags))).toEqual({});
  expect(primary(envelope(undefined, { meta: flags }))).toEqual({});
  expect(primary(envelope({ DXY: row(flags) }))).toEqual({});
  expect(supplemental(earlyLook(undefined, flags))).toEqual({});
  expect(supplemental(earlyLook(undefined, { provenance: flags }))).toEqual({});
  expect(supplemental(earlyLook({ USD: row(flags) }))).toEqual({});
});

test.each([
  null, {}, { DXY: row() }, envelope(undefined, { available: false }),
  envelope(undefined, { status: 'pending' }), envelope(undefined, { status: 'stale' }),
  envelope(undefined, { manifest: { publicationDate: DATE, expectedDate: DATE } }),
  envelope(undefined, { manifest: { publicationDate: DATE, expectedDate: DATE, persistedManifestVerified: true, persistedCompletionState: 'incomplete' } }),
  envelope(undefined, { manifest: { publicationDate: DATE, expectedDate: '2026-09-24', persistedManifestVerified: true, persistedCompletionState: 'complete' } }),
  envelope({ DXY: row({ provenance: 'supplemental' }) }), envelope({ DXY: row({ source: 'early-look' }) }),
  envelope({ DXY: row({ decisionEligible: false }) }), envelope({ DXY: row({ date: '2026-09-24' }) }),
])('requires a current complete manifest and primary row %#', (payload) => {
  expect(primary(payload)).toEqual({});
});

test.each([
  null, earlyLook(undefined, { date: '2026-09-24' }), earlyLook(undefined, { htmlSource: null }),
  earlyLook(undefined, { htmlSource: 'hedgeye-email/messages/2026-09-24/early-look/source.html' }),
  earlyLook(undefined, { snapshotType: 'risk-ranges' }),
  earlyLook(undefined, { snapshotType: null, reportType: null }),
  earlyLook(undefined, { article: { feedUrl: 'https://app.hedgeye.com.evil.invalid/feed_items/1' } }),
  earlyLook(undefined, { article: { feedUrl: 'http://app.hedgeye.com/feed_items/1' } }),
  earlyLook(undefined, { article: { feedUrl: 'https://user@app.hedgeye.com/feed_items/1' } }),
])('requires exact Early Look HTML/date/publisher evidence %#', (payload) => {
  expect(supplemental(payload)).toEqual({});
});

test('ambiguous duplicate aliases are unavailable without hiding independent rows', () => {
  expect(primary(envelope({ DXY: row(), USD: row({ trend: 'BEARISH' }), VIX: row() }))).toEqual({ VIX: expect.any(Object) });
});

test.each([{ lrr: null }, { hrr: Infinity }, { lrr: '99.98' }, { lrr: 102, hrr: 100 }])('retains verified Trend when only its range is invalid %p', (fields) => {
  expect(primary(envelope({ USD: row(fields) })).USD).toMatchObject({ trend: 'BULLISH', lrr: null, hrr: null, rangeEvidence: null });
});

test.each(['UNKNOWN', null, ''])('retains verified range without inventing a neutral trend for %p', (trend) => {
  expect(primary(envelope({ USD: row({ trend }) })).USD).toMatchObject({ trend: null, trendEvidence: null, lrr: 99.98, hrr: 101.65 });
});

test('quality findings withhold only the disputed fields', () => {
  const rangeIssue = { sourceQuality: { issues: [{ ticker: 'USD', field: 'riskRange' }] } };
  expect(primary(envelope(undefined, rangeIssue)).USD).toMatchObject({ trend: 'BULLISH', lrr: null, hrr: null });
  expect(primary(envelope({ USD: row({ sourceQuality: { issues: [{ field: 'trend' }] } }) })).USD).toMatchObject({ trend: null, lrr: 99.98, hrr: 101.65 });
});

test('primary fields win and supplemental fields carry their own provenance', () => {
  const readings = normalizeDashboardResearch({
    riskRanges: envelope({ USD: row({ trend: null }), VIX: row({ lrr: 14.21, hrr: 17.84, trend: 'BEARISH' }) }),
    earlyLook: earlyLook({ USD: row({ trend: 'NEUTRAL', lrr: 90, hrr: 110 }), VIX: row({ trend: 'BULLISH' }) }),
  }, options);
  expect(readings.USD).toMatchObject({ trend: 'NEUTRAL', lrr: 99.98, hrr: 101.65, source: 'Early Look · Risk Ranges' });
  expect(readings.USD.trendEvidence).toMatchObject({ source: 'Early Look', sourceUrl });
  expect(readings.USD.rangeEvidence).toMatchObject({ source: 'Risk Ranges' });
  expect(readings.VIX).toMatchObject({ trend: 'BEARISH', lrr: 14.21, hrr: 17.84, source: 'Risk Ranges' });
});

test('a failed primary source does not hide independently verified Early Look', () => {
  expect(normalizeDashboardResearch({ riskRanges: envelope(undefined, { status: 'failed' }), earlyLook: earlyLook() }, options).USD)
    .toMatchObject({ source: 'Early Look', verified: true });
});

test('closed market dates accept the current verified last-session publication but weekdays reject an old date', () => {
  expect(dashboardResearchMarketDate('2026-09-26')).toBe(DATE);
  expect(dashboardResearchMarketDate('2026-09-07')).toBe('2026-09-04');
  expect(dashboardResearchMarketDate('2026-02-30')).toBeNull();
  expect(normalizeDashboardRiskRanges(envelope(), { date: '2026-09-26' }).USD).toMatchObject({ date: DATE });
  expect(normalizeDashboardRiskRanges(envelope(), { date: '2026-09-28' })).toEqual({});
});


test.each([
  ['GLD', 'Gold Spot Price', 'GC'], ['GOLD', 'Gold Spot Price', 'GC'],
  ['COPPER', 'Copper Spot Price', 'HG'], ['SILVER', 'Silver Spot Price', 'SI'],
])('shows %s only as an explicitly labeled spot reference, never a futures alias', (ticker, originalName, symbol) => {
  expect(dashboardResearchSymbol(ticker, { originalName })).toBeNull();
  const reading = primary(envelope({ [ticker]: row({ originalName }) }))[symbol];
  expect(reading).toMatchObject({ verified: true, basisLabel: 'spot', referenceOnly: true });
  expect(reading.rangeEvidence).toMatchObject({ basisLabel: 'spot', sourceTicker: ticker, date: DATE });
});

test('does not mistake GLD ETF or an unattributed alias for Gold spot', () => {
  expect(primary(envelope({ GLD: row() }))).toEqual({});
  expect(primary(envelope({ GLD: row({ originalName: 'SPDR Gold Shares' }) }))).toEqual({});
  expect(primary(envelope({ GLD: row({ originalName: 'Gold Spot Price', sourceQuality: { issues: [{ field: 'riskRange' }] } }) })).GC.lrr).toBeNull();
});

test('merges independent published fields by date while preserving their own sources and basis', () => {
  const oldRange = primary(envelope({ GLD: row({ originalName: 'Gold Spot Price' }) })).GC;
  const newer = { ...oldRange, lrr: null, hrr: null, rangeEvidence: null, trend: 'BEARISH',
    trendEvidence: { source: 'Early Look', date: '2026-09-28', sourceUrl } };
  const merged = mergeDashboardResearchReadings({ GC: oldRange }, { GC: newer }).GC;
  expect(merged).toMatchObject({ trend: 'BEARISH', lrr: 99.98, basisLabel: 'spot', date: '2026-09-28' });
  expect(merged.rangeEvidence.date).toBe(DATE);
  expect(merged.trendEvidence.date).toBe('2026-09-28');
});

test('retains dated verified narrative Trend without allowing numeric thresholds to become ranges', () => {
  const date = '2026-09-14';
  const evidence = { source: 'Early Look', sourceType: 'narrative', date, sourceUrl };
  const reading = { ...evidence, verified: true, trend: 'BULLISH', lrr: 362, hrr: 365,
    evidenceText: 'Corn remains Bullish TREND.', trendEvidence: evidence };
  const payload = { schemaVersion: 1, verified: true, source: 'early-look-archive', readings: { ZC: reading } };
  expect(normalizeDashboardNarrativeEnvelope(payload, options).ZC).toMatchObject({ date, trend: 'BULLISH', lrr: null, hrr: null });
  expect(normalizeDashboardNarrativeEnvelope({ ...payload, readings: { ZC: { ...reading, sourceUrl: 'https://example.com' } } }, options)).toEqual({});
  expect(normalizeDashboardNarrativeEnvelope({ ...payload, mock: true }, options)).toEqual({});
});


test('latest published crypto fields survive omission from a later report and retain original dates', () => {
  const publication = (date, cryptos) => ({
    date, source: 'gmail-html', snapshotType: 'bitcoin-trend-tracker', reportType: 'crypto-quant',
    htmlSource: `hedgeye-email/messages/${date}/crypto-quant/source.html`,
    article: { feedUrl: sourceUrl }, data: { cryptos },
  });
  const older = publication('2026-09-24', { ETH: { trend: 'BULLISH', buyTrade: 2525, sellTrade: 2862 }, SOL: { trend: 'BULLISH', buyTrade: 106, sellTrade: 125 } });
  const latest = publication(DATE, { ETH: { trend: 'NEUTRAL', buyTrade: 2500, sellTrade: 2900 } });
  const narrative = { schemaVersion: 1, verified: true, source: 'early-look-archive', readings: {}, cryptoPublications: [older, latest] };
  const readings = normalizeDashboardResearch({ narrative, cryptoTracker: latest }, options);
  expect(readings.ETH).toMatchObject({ trend: 'NEUTRAL', date: DATE, lrr: 2500 });
  expect(readings.SOL).toMatchObject({ trend: 'BULLISH', date: '2026-09-24', lrr: 106, hrr: 125 });
});

const tradeSignal = (overrides = {}) => ({
  status: 'historical', value: 'BEARISH', sourceId: 'early-look', sourceLabel: 'Early Look',
  sourceDate: '2026-09-18', sourceUrl, sourceTicker: 'SPX',
  signalProvenance: { field: 'trade', method: 'explicit-statement', sourceField: 'article.bodyText', sourceText: 'SPX is BEARISH TRADE.' },
  ...overrides,
});
const tradeIntelligence = (trade = tradeSignal(), symbol = 'SPX') => ({
  schemaVersion: 2, marketDate: DATE, bySymbol: { [symbol]: { lastVerifiedDecision: { trade } } },
});

test('merges dated Trade separately from newer Trend and range without changing either source', () => {
  const readings = normalizeDashboardResearch({ riskRanges: envelope({ SPX: row() }), intelligence: tradeIntelligence() }, options);
  expect(readings.SPX).toMatchObject({ trade: 'BEARISH', trend: 'BULLISH', lrr: 99.98, hrr: 101.65 });
  expect(readings.SPX.tradeEvidence).toMatchObject({ date: '2026-09-18', sourceUrl, sourceTicker: 'SPX' });
  expect(readings.SPX.trendEvidence.date).toBe(DATE);
});

test.each(['USD', 'VIX', 'ETH', 'SMH'])('distributes independent Trade to applicable %s rows without needing a quote or Trend', (symbol) => {
  const readings = normalizeDashboardResearch({ intelligence: tradeIntelligence(tradeSignal({ sourceTicker: symbol }), symbol) }, options);
  expect(readings[symbol]).toMatchObject({ trade: 'BEARISH', trend: null, lrr: null, verified: true });
});

test.each([
  { sourceTicker: 'SPY' }, { sourceTicker: null }, { status: 'conflict' }, { sourceDate: '2026-09-28' },
  { signalProvenance: null }, { signalProvenance: { field: 'trend', method: 'explicit-field', sourceText: 'Trend Bullish' } },
  { sourceUrl: 'https://example.com/incorrect' }, { mock: true }, { seeded: true }, { stale: true },
  { cacheOnly: true }, { offline: true }, { metadata: { inferred: true } },
])('rejects invalid, inferred or mismatched Trade while retaining independent Trend: %p', (changes) => {
  const readings = normalizeDashboardResearch({ riskRanges: envelope({ SPX: row() }), intelligence: tradeIntelligence(tradeSignal(changes)) }, options);
  expect(readings.SPX.trade).toBeUndefined();
  expect(readings.SPX.trend).toBe('BULLISH');
});

test('a newer conflicting Trade does not fall back to an older publication', () => {
  const intelligence = tradeIntelligence();
  intelligence.bySymbol.SPX.decision = { trade: { status: 'conflict' } };
  expect(normalizeDashboardResearch({ intelligence }, options)).toEqual({});
});

test('retains verified archived Trade when current research coverage is unavailable', () => {
  const intelligence = { ...tradeIntelligence(), status: 'unavailable', loadErrors: { snapshots: 'offline' } };
  expect(normalizeDashboardResearch({ intelligence }, options).SPX).toMatchObject({ trade: 'BEARISH', date: '2026-09-18' });
  expect(normalizeDashboardResearch({ intelligence: { ...intelligence, mock: true } }, options)).toEqual({});
});

const tickSource = (id, overrides = {}) => ({
  id, sourceType: 'reviewed-screenshot', sourceUrl, publicationDate: DATE,
  publishedAt: `${DATE}T12:43:00Z`, ...overrides,
});
const tickRow = (overrides = {}) => ({
  ticker: 'XLF', instrumentId: 'hedgai:XLF', sourceLabel: 'Financials $XLF',
  position: 'Buy', activeDirection: 'Bullish', status: 'current',
  publicationDate: DATE, lastConfirmedAt: `${DATE}T12:43:00Z`, initiatedAt: '2026-09-21',
  metricsDate: DATE, metrics: { buy: { battingAverage: 0.7, signals: 20 } },
  positionSourceIds: ['position'], metricsSourceIds: ['metrics'], ...overrides,
});
const tickProjection = (rows = [tickRow()], overrides = {}) => ({
  version: 1, product: 'hedgai-signals', asOf: `${DATE}T16:00:00Z`,
  baselineDate: DATE, metricsDate: DATE, threshold: 0.6, book: { rows },
  sources: [tickSource('position'), tickSource('metrics')],
  sourceQuality: { continuity: 'complete', issues: [] }, ...overrides,
});

test('projects published Tick with original position, metrics and publication evidence', () => {
  const payload = tickProjection();
  const before = JSON.stringify(payload);
  const reading = normalizeDashboardTickResearch(payload, options).XLF;
  expect(reading).toMatchObject({ verified: true, tick: 'BULLISH', trend: null, lrr: null });
  expect(reading.tickEvidence).toMatchObject({ source: 'HedgAI Signals', sourceTicker: 'XLF',
    date: DATE, sourceUrl, publishedAt: `${DATE}T12:43:00Z`, asOf: `${DATE}T16:00:00Z`,
    evidenceText: 'Financials $XLF: Buy', metricsDate: DATE, matchType: 'exact',
    contextOnly: true, decisionEligible: false, executable: false });
  expect(reading.tickEvidence.positionSources).toEqual([payload.sources[0]]);
  expect(reading.tickEvidence.metricSources).toEqual([payload.sources[1]]);
  expect(JSON.stringify(payload)).toBe(before);
});

test('projects the complete HedgAI security roster without limiting it to front-dashboard instruments', () => {
  const rows = hedgaiInstruments.instruments.map((instrument, index) => tickRow({
    ...instrument, position: ['Buy', 'Short', 'Wait'][index % 3], activeDirection: null,
  }));
  const payload = tickProjection(rows);
  const direct = normalizePublishedTickResearch(payload, options);
  const readings = normalizeDashboardTickResearch(payload, options);
  expect(Object.keys(direct)).toHaveLength(hedgaiInstruments.instruments.length);
  rows.forEach(({ ticker, instrumentId, position }) => {
    expect(direct[ticker]).toMatchObject({ verified: true,
      tick: { Buy: 'BULLISH', Short: 'BEARISH', Wait: 'NEUTRAL' }[position],
      tickEvidence: { matchType: 'exact', sourceTicker: ticker, sourceLabel: hedgaiInstruments.instruments.find((instrument) => instrument.ticker === ticker).sourceLabel,
        instrumentId, position, date: DATE,
        sourceUrl, contextOnly: true, decisionEligible: false, executable: false } });
    expect(readings[ticker].tickEvidence.matchType).toBe('exact');
    expect(selectPublishedTickResearch(payload, ticker.toLowerCase(), options)).toEqual(direct[ticker]);
  });
  expect(readings.AAPL.tickEvidence.sourceTicker).toBe('AAPL');
  expect(readings.SPY.tickEvidence.matchType).toBe('exact');
  expect(readings.SPX.tickEvidence).toMatchObject({ matchType: 'proxy', sourceTicker: 'SPY' });
  expect(readings.GLD.tickEvidence.matchType).toBe('exact');
  expect(readings.GC.tickEvidence).toMatchObject({ matchType: 'proxy', sourceTicker: 'GLD' });
  expect(selectPublishedTickResearch(payload, 'SPX', options)).toBeNull();
  expect(readings.UST10Y.tickEvidence).toMatchObject({ sourceTicker: 'UST', sourceLabel: 'UST 10yr Yield', matchType: 'proxy' });
  expect(readings.USDJPY.tickEvidence).toMatchObject({ sourceTicker: 'YCS', sourceLabel: 'US Dollar To Yen Cross', matchType: 'proxy' });
  ['USDEUR', 'USDGBP', 'USDCAD', 'CSI300'].forEach((ticker) => expect(readings[ticker]).toBeUndefined());
});

test('scans every structured HedgAI reference while preserving the original ETF identity', () => {
  const rows = tickReferences.map(({ sourceTicker: ticker }) => tickRow({ ticker, instrumentId: `hedgai:${ticker}` }));
  const readings = normalizeDashboardTickResearch(tickProjection(rows), options);
  tickReferences.forEach(({ symbol, sourceTicker, instrumentId }) => {
    expect(readings[symbol]).toMatchObject({ tick: 'BULLISH', trend: null, lrr: null, hrr: null,
      tickEvidence: { matchType: 'proxy', sourceTicker, instrumentId, referenceInstrument: sourceTicker,
        contextOnly: true, decisionEligible: false, executable: false } });
  });
  expect(readings.QQQ.tickEvidence.matchType).toBe('exact');
  expect(readings.UUP.tickEvidence.matchType).toBe('exact');
  ['USDEUR', 'USDGBP', 'USDCAD', 'CSI300'].forEach((ticker) => expect(readings[ticker]).toBeUndefined());
});

test('an exact published instrument takes priority over a separately identified proxy', () => {
  const rows = [tickRow({ ticker: 'SPY', instrumentId: 'hedgai:SPY' }),
    tickRow({ ticker: 'SPX', instrumentId: 'hedgai:SPX', position: 'Wait', activeDirection: null })];
  expect(normalizeDashboardTickResearch(tickProjection(rows), options).SPX)
    .toMatchObject({ tick: 'NEUTRAL', tickEvidence: { sourceTicker: 'SPX', matchType: 'exact', position: 'Wait' } });
});

test('ambiguous exact overview aliases cannot promote a direct row or its proxy', () => {
  const rows = [tickRow({ ticker: 'SPY', instrumentId: 'hedgai:SPY' }),
    tickRow({ ticker: 'SPX', instrumentId: 'hedgai:SPX' }),
    tickRow({ ticker: '^GSPC', instrumentId: 'hedgai:^GSPC', position: 'Short', activeDirection: null })];
  expect(normalizeDashboardTickResearch(tickProjection(rows), options).SPX).toBeUndefined();
  expect(normalizeDashboardTickResearch(tickProjection(rows), options).SPY.tickEvidence.matchType).toBe('exact');
});

test.each([
  { position: 'Buy', activeDirection: null, metrics: { buy: { battingAverage: 0.59, signals: 20 } } },
  { position: 'Buy', activeDirection: null, metrics: { buy: { battingAverage: 0.7, signals: 0 } } },
  { position: 'Buy', activeDirection: null, metricsSourceIds: [] },
  { position: 'Buy', activeDirection: null, metricsDate: '2026-09-28' },
  { position: 'Wait', activeDirection: null },
  { position: 'Short', activeDirection: null },
])('Tick shows the published position independently of historical strategy qualification: %p', (overrides) => {
  const reading = normalizeDashboardTickResearch(tickProjection([tickRow(overrides)]), options).XLF;
  expect(reading.tick).toBe({ Buy: 'BULLISH', Short: 'BEARISH', Wait: 'NEUTRAL' }[overrides.position]);
  expect(reading.tickEvidence.position).toBe(overrides.position);
});

test.each([
  null, {}, tickProjection([], { availability: 'unavailable' }),
  tickProjection(undefined, { asOf: '2026-09-24T16:00:00Z' }),
  tickProjection(undefined, { asOf: '2026-09-28T16:00:00Z' }),
  tickProjection(undefined, { sourceQuality: { continuity: 'unknown', issues: [] } }),
  tickProjection(undefined, { sourceQuality: { continuity: 'gap', issues: [{ blocking: true }] } }),
  tickProjection(undefined, { sources: [] }),
])('withholds missing, unavailable or unchecked Tick without affecting independent Trend: %#', (hedgai) => {
  expect(normalizeDashboardTickResearch(hedgai, options)).toEqual({});
  expect(normalizeDashboardResearch({ riskRanges: envelope({ XLF: row() }), hedgai }, options).XLF)
    .toMatchObject({ trend: 'BULLISH', lrr: 99.98 });
});

test.each([
  { position: 'Unknown', activeDirection: null }, { status: 'last-known' },
  { activeDirection: 'Bearish' }, { instrumentId: 'hedgai:SPY' }, { positionSourceIds: [] },
])('does not promote unknown, unconfirmed or mismatched Tick into a current arrow: %p', (overrides) => {
  expect(normalizeDashboardTickResearch(tickProjection([tickRow(overrides)]), options)).toEqual({});
});

test.each([{ mock: true }, { seeded: true }, { stale: true }, { cacheOnly: true }, { offline: true },
  { disconnected: true }, { inferred: true }, { fixture: true }])('rejects unsafe Tick at capture, row and position-source scope: %p', (flags) => {
  expect(normalizeDashboardTickResearch(tickProjection(undefined, flags), options)).toEqual({});
  expect(normalizeDashboardTickResearch(tickProjection([tickRow(flags)]), options)).toEqual({});
  expect(normalizeDashboardTickResearch(tickProjection(undefined, { sources: [tickSource('position', flags), tickSource('metrics')] }), options)).toEqual({});
});

test('an ambiguous or disputed Tick row does not remove independently verified Tick rows', () => {
  const uup = tickRow({ ticker: 'UUP', instrumentId: 'hedgai:UUP', position: 'Short', activeDirection: 'Bearish',
    metrics: { short: { battingAverage: 0.7, signals: 20 } } });
  expect(Object.keys(normalizeDashboardTickResearch(tickProjection([tickRow(), tickRow(), uup]), options))).toEqual(['UUP', 'USD']);
  const sourceQuality = { continuity: 'unknown', issues: [{ blocking: true, instrumentId: 'hedgai:XLF' }] };
  expect(Object.keys(normalizeDashboardTickResearch(tickProjection([tickRow(), uup], { sourceQuality }), options))).toEqual(['UUP', 'USD']);
});

test('a rejected or missing newer position source cannot inherit an active Tick from older evidence', () => {
  const rows = [tickRow({ positionSourceIds: ['position', 'latest'] })];
  const sources = [tickSource('position'), tickSource('metrics'), tickSource('latest', { stale: true })];
  expect(normalizeDashboardTickResearch(tickProjection(rows, { sources }), options)).toEqual({});
  expect(normalizeDashboardTickResearch(tickProjection(rows), options)).toEqual({});
  const missingMetric = tickProjection([tickRow({ metricsSourceIds: ['metrics', 'missing'] })]);
  expect(normalizeDashboardTickResearch(missingMetric, options).XLF).toMatchObject({ tick: 'BULLISH', tickEvidence: { metrics: null, metricSources: [] } });
});

test('merges Tick separately without changing independently published Trade, Trend or Risk Range', () => {
  const readings = normalizeDashboardResearch({ riskRanges: envelope({ XLF: row() }),
    intelligence: tradeIntelligence(tradeSignal({ sourceTicker: 'XLF' }), 'XLF'), hedgai: tickProjection() }, options);
  expect(readings.XLF).toMatchObject({ tick: 'BULLISH', trade: 'BEARISH', trend: 'BULLISH', lrr: 99.98, hrr: 101.65 });
  expect(readings.XLF.tradeEvidence.date).toBe('2026-09-18');
  expect(readings.XLF.tickEvidence.source).toBe('HedgAI Signals');
  expect(readings.XLF.trendEvidence.source).toBe('Risk Ranges');
  expect(readings.XLF.rangeEvidence.date).toBe(DATE);
});

test('a newer intraday Tick replaces an older same-date publication independently of source order', () => {
  const first = normalizeDashboardTickResearch(tickProjection(), options).XLF;
  const later = { ...first, tick: 'BEARISH', tickEvidence: { ...first.tickEvidence, publishedAt: `${DATE}T15:00:00Z` } };
  expect(mergeDashboardResearchReadings({ XLF: later }, { XLF: first }).XLF.tick).toBe('BEARISH');
  expect(mergeDashboardResearchReadings({ XLF: first }, { XLF: later }).XLF.tickEvidence.publishedAt).toBe(`${DATE}T15:00:00Z`);
});

test('a Real-Time Alert revision shows the refreshed range and credits that alert, keeping the sheet as the Trend source', () => {
  const reading = primary(envelope({ SPX: row({ lrr: 6899, hrr: 7367, trend: 'BEARISH', originalName: 'S&P 500',
    published: { lrr: 7106, hrr: 7518 },
    revision: { lrr: 6899, hrr: 7367, eventTime: '2026-09-25T19:22:00+00:00', sourceMessageId: '1a1fa6a6a05e2a56', source: 'real-time-alert' } }) })).SPX;
  expect(reading).toMatchObject({ lrr: 6899, hrr: 7367, trend: 'BEARISH' });
  expect(reading.rangeEvidence).toMatchObject({ source: 'Real-Time Alert', sourceType: 'revision', sourceUrl: 'gmail://message/1a1fa6a6a05e2a56',
    sourceMessageId: '1a1fa6a6a05e2a56', publishedAt: '2026-09-25T19:22:00+00:00', published: { lrr: 7106, hrr: 7518 } });
  expect(reading.trendEvidence).toMatchObject({ source: 'Risk Ranges', sourceType: 'primary' });
});
