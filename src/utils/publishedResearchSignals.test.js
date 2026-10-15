const { extractPublishedTradeSignals, publishedTradeFromEvent, selectLatestPublishedTrade,
  isVerifiedPublicationSnapshot, sameSignalInstrument, tradeStatements } = require('./publishedResearchSignals.cjs');
const { buildSecurityIntelligenceV2 } = require('./securityIntelligenceV2.cjs');

const snapshot = (bodyText, extra = {}) => ({
  date: '2026-09-18', snapshotType: 'early-look', source: 'gmail-html',
  publishedAt: '2026-09-18T11:30:00Z',
  htmlSource: 'hedgeye-email/messages/2026-09-18/early-look/original.html',
  article: { bodyText, feedUrl: 'https://app.hedgeye.com/feed_items/187000' }, ...extra,
});

test.each([
  ['SPX is BULLISH TRADE and TREND.', 'SPX', 'BULLISH'],
  ['CRB Commodities Index is back to signaling BEARISH TRADE and TREND.', 'CRB', 'BEARISH'],
  ['NVDA Trade: BULLISH', 'NVDA', 'BULLISH'],
  ['EUR/USD is BEARISH TRADE.', 'EUR/USD', 'BEARISH'],
  ['AAPL Trade BULLISH in the morning publication.', 'AAPL', 'BULLISH'],
  ['SPX is BULLISH TRADE, BEARISH TREND.', 'SPX', 'BULLISH'],
])('extracts an independent named Trade statement: %s', (text, ticker, value) => {
  expect(extractPublishedTradeSignals(snapshot(text))).toEqual(expect.arrayContaining([
    expect.objectContaining({ ticker, value, sourceText: text,
      signalProvenance: expect.objectContaining({ field: 'trade', method: 'explicit-statement' }) }),
  ]));
});

test.each([
  'SPX is BULLISH TREND.', 'SPX BUY TRADE 7546 SELL TRADE 7797.',
  'If SPX turns BULLISH TRADE we would add.', 'SPX was previously BULLISH TRADE.',
  'SPX is not BULLISH TRADE.', 'SPX may be BULLISH TRADE.',
  'AAPL was mentioned positively in tracker commentary.',
  'THIS is BULLISH TRADE.', 'SPX is BULLISH TRADE versus BEARISH TRADE last month.',
])('does not invent Trade from other evidence: %s', (text) => {
  expect(extractPublishedTradeSignals(snapshot(text))).toEqual([]);
});

test('rejects the legacy tracker Trend-to-Trade copy and its synthesized event', () => {
  const legacy = snapshot('', { snapshotType: 'momo-tracker', htmlSource: 'hedgeye-email/messages/2026-09-18/momo-tracker/original.html',
    data: { AAPL: { trend: 'BULLISH', trade: 'BULLISH', buyTrade: 210, sellTrade: 225 } } });
  expect(extractPublishedTradeSignals(legacy)).toEqual([]);
  expect(publishedTradeFromEvent({ productKey: 'momo-tracker', entityId: 'AAPL', eventType: 'trade_signal',
    signalValue: 'BULLISH', excerpt: 'AAPL: {"trend":"BULLISH","buyTrade":210,"sellTrade":225}' })).toBeNull();
  expect(publishedTradeFromEvent({ productKey: 'bitcoin-trend-tracker', entityId: 'BTC', eventType: 'trade_signal',
    signalValue: 'BULLISH', excerpt: 'Trade BULLISH; Buy Trade 100; Sell Trade 110' })).toBeNull();
});

test('accepts a genuinely independent Trade field while preserving a different Trend', () => {
  const source = snapshot('', { data: { MSFT: { trade: 'BEARISH', trend: 'BULLISH' } } });
  expect(extractPublishedTradeSignals(source)[0]).toMatchObject({ ticker: 'MSFT', value: 'BEARISH',
    signalProvenance: { field: 'trade', method: 'explicit-field', sourceField: 'data.MSFT.trade' } });
});

test('a rejected range does not hide independent Trade; an affected Trade field stays withheld', () => {
  const source = snapshot('SPX is BULLISH TRADE and TREND.', {
    sourceQuality: { status: 'discrepancy', issues: [{ ticker: 'SPX', affectedFields: ['lrr', 'hrr'] }] },
  });
  expect(extractPublishedTradeSignals(source)).toHaveLength(1);
  source.sourceQuality.issues[0].affectedFields = ['trade'];
  expect(extractPublishedTradeSignals(source)).toEqual([]);
});

test.each([{ mock: true }, { seeded: true }, { cacheOnly: true }, { offline: true }, { stale: true },
  { sourceQuality: { sourceVerified: false } }, { date: '2026-99-01' },
  { htmlSource: 'hedgeye-email/messages/2026-09-17/early-look/original.html' },
])('rejects unverified source evidence %j', (extra) => {
  expect(isVerifiedPublicationSnapshot(snapshot('SPX is BULLISH TRADE.', extra))).toBe(false);
  expect(extractPublishedTradeSignals(snapshot('SPX is BULLISH TRADE.', extra))).toEqual([]);
});

test('selects the last explicit statement through later omissions and conflicts only comparable times', () => {
  const first = extractPublishedTradeSignals(snapshot('SPX is BULLISH TRADE.'))[0];
  const later = { ...first, date: '2026-09-25', publishedAt: null, value: 'BEARISH' };
  expect(selectLatestPublishedTrade([first], { ticker: 'SPX', asOf: '2026-09-26' })).toMatchObject({ date: '2026-09-18', value: 'BULLISH' });
  expect(selectLatestPublishedTrade([first, later], { ticker: 'SPX' })).toMatchObject({ value: 'BEARISH' });
  expect(selectLatestPublishedTrade([later, { ...later, publishedAt: '2026-09-25T14:00:00Z', value: 'BULLISH' }], { ticker: 'SPX' })).toMatchObject({ status: 'conflict', value: null });
  expect(sameSignalInstrument('SPX', 'SPY')).toBe(false);
  expect(sameSignalInstrument('GOLD', 'GC')).toBe(false);
});

test('canonical universe retains archived-only Trade for the actual instrument beyond bounded history', () => {
  const trade = { ...extractPublishedTradeSignals(snapshot('SPX is BULLISH TRADE.'))[0], qualityStatus: 'validated' };
  const response = buildSecurityIntelligenceV2({ scope: 'universe', marketDate: '2026-09-26', historyDays: 0,
    now: new Date('2026-09-26T16:00:00Z'), publishedTradeReadings: [trade] });
  expect(response.requestedSymbols).toContain('SPX');
  expect(response.bySymbol.SPX.lastVerifiedDecision.trade).toMatchObject({ value: 'BULLISH', sourceDate: '2026-09-18',
    sourceTicker: 'SPX', sourceUrl: trade.sourceUrl, qualityStatus: 'validated', referenceOnly: true });
  expect(response.bySymbol.SPY).toBeUndefined();
  expect(response.bySymbol.SPX.decision.trade.value).toBeNull();
});

test.each(['Corn remains BULLISH TRADE and TREND.', 'CORN is BULLISH TRADE.'])('commodity prose cannot become CORN ETF Trade: %s', (text) => {
  const reference = tradeStatements(text)[0];
  expect(reference).toMatchObject({ sourceTicker: 'CORN', sourceInstrument: 'Corn (underlying commodity)',
    instrumentKey: 'reference:CORN', basisLabel: 'underlying', referenceOnly: true });
  expect(extractPublishedTradeSignals(snapshot(text))).toEqual([]);
  const archived = { ...reference, date: '2026-09-18', qualityStatus: 'validated' };
  expect(selectLatestPublishedTrade([archived], { ticker: 'CORN' })).toBeNull();
  expect(publishedTradeFromEvent({ entityId: 'CORN', signalValue: 'BULLISH',
    signalProvenance: reference.signalProvenance })).toBeNull();
  const response = buildSecurityIntelligenceV2({ scope: 'universe', marketDate: '2026-09-26', historyDays: 0,
    now: new Date('2026-09-26T16:00:00Z'), publishedTradeReadings: [archived] });
  expect(response.requestedSymbols).not.toContain('CORN');
});

test.each(['GOLD', 'COPPER', 'SILVER'])('ambiguous commodity token %s cannot identify a security Trade', (ticker) => {
  expect(extractPublishedTradeSignals(snapshot(`${ticker} is BULLISH TRADE.`))).toEqual([]);
});

test('an independently published structured CORN ETF Trade field remains valid', () => {
  const [trade] = extractPublishedTradeSignals(snapshot('', {
    data: { CORN: { name: 'Teucrium Corn Fund', trade: 'BEARISH' } },
  }));
  expect(selectLatestPublishedTrade([trade], { ticker: 'CORN' })).toMatchObject({ value: 'BEARISH', sourceTicker: 'CORN' });
});
