const { extractPublishedTradeSignals, publishedTradeFromEvent, selectLatestPublishedTrade,
  isVerifiedPublicationSnapshot, sameSignalInstrument, tradeStatements } = require('./publishedResearchSignals.cjs');
const { buildSecurityIntelligenceV2 } = require('./securityIntelligenceV2.cjs');

const snapshot = (bodyText, extra = {}) => ({
  date: '2026-09-18', snapshotType: 'early-look', source: 'gmail-html',
  publishedAt: '2026-09-18T11:30:00Z',
  htmlSource: 'hedgeye-email/messages/2026-09-18/early-look/original.html',
  article: { bodyText, feedUrl: 'https://app.hedgeye.com/feed_items/187000' }, ...extra,
});

// sourceText is the clause span from the instrument through the claim.
test.each([
  ['SPX is BULLISH TRADE and TREND.', 'SPX', 'BULLISH', 'SPX is BULLISH TRADE and TREND'],
  ['CRB Commodities Index is back to signaling BEARISH TRADE and TREND.', 'CRB', 'BEARISH', 'CRB Commodities Index is back to signaling BEARISH TRADE and TREND'],
  ['NVDA Trade: BULLISH', 'NVDA', 'BULLISH', 'NVDA Trade: BULLISH'],
  ['EUR/USD is BEARISH TRADE.', 'EURUSD', 'BEARISH', 'EUR/USD is BEARISH TRADE'],
  ['AAPL Trade BULLISH in the morning publication.', 'AAPL', 'BULLISH', 'AAPL Trade BULLISH'],
  ['SPX is BULLISH TRADE, BEARISH TREND.', 'SPX', 'BULLISH', 'SPX is BULLISH TRADE, BEARISH TREND'],
  ['UST 2yr Yield down -11 basis points last week to Signal Bearish TRADE, but Bullish TREND', 'UST2Y', 'BEARISH',
    'UST 2yr Yield down -11 basis points last week to Signal Bearish TRADE, but Bullish TREND'],
  ['US Dollar Index was up +0.1% on the week and remains Bullish on both our TRADE and TREND durations', 'USD', 'BULLISH',
    'US Dollar Index was up +0.1% on the week and remains Bullish on both our TRADE and TREND'],
  ['RATES – Bond Yields down; UST 10yr Yield is Bearish TRADE, Neutral TREND (with TREND = 4.91%) after its Risk Range signaled', 'UST10Y', 'BEARISH',
    'UST 10yr Yield is Bearish TRADE, Neutral TREND'],
  ['QQQ – fortunately, we’re not long what the crowd is – QQQ was already signaling Bearish TRADE (so was SPY on Friday)', 'QQQ', 'BEARISH',
    'QQQ was already signaling Bearish TRADE'],
])('extracts an independent named Trade statement: %s', (text, ticker, value, span) => {
  expect(extractPublishedTradeSignals(snapshot(text))).toEqual(expect.arrayContaining([
    expect.objectContaining({ ticker, value, sourceText: span,
      signalProvenance: expect.objectContaining({ field: 'trade', method: 'explicit-statement', sourceText: span }) }),
  ]));
});

test.each([
  'SPX is BULLISH TREND.', 'SPX BUY TRADE 7546 SELL TRADE 7797.',
  'If SPX turns BULLISH TRADE we would add.', 'SPX was previously BULLISH TRADE.',
  'SPX is not BULLISH TRADE.', 'SPX may be BULLISH TRADE.',
  'AAPL was mentioned positively in tracker commentary.',
  'THIS is BULLISH TRADE.', 'SPX is BULLISH TRADE versus BEARISH TRADE last month.',
  // Another market named before the claim, a past qualifier after it, a noun phrase.
  'Japanese Yen up another +0.4% to $153.51 vs. USD remains Bullish TRADE and TREND',
  'SPX was Bullish TRADE last week.', 'SPX is a bullish trade idea.',
  'Gold Miners remain Bearish TRADE.', 'If SPY is Bearish TRADE and TREND',
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
  // Each reading is extracted from its own text: a value edited apart from its sentence no longer verifies.
  const on = (text, publishedAt) => ({ ...extractPublishedTradeSignals(snapshot(text, { date: '2026-09-25',
    htmlSource: 'hedgeye-email/messages/2026-09-25/early-look/original.html' }))[0], publishedAt });
  const later = on('SPX is BEARISH TRADE.', null);
  expect(selectLatestPublishedTrade([first], { ticker: 'SPX', asOf: '2026-09-26' })).toMatchObject({ date: '2026-09-18', value: 'BULLISH' });
  expect(selectLatestPublishedTrade([first, later], { ticker: 'SPX' })).toMatchObject({ value: 'BEARISH' });
  expect(selectLatestPublishedTrade([first, { ...later, value: 'BULLISH' }], { ticker: 'SPX' })).toMatchObject({ date: '2026-09-18' });
  expect(selectLatestPublishedTrade([later, on('SPX is BULLISH TRADE.', '2026-09-25T14:00:00Z')], { ticker: 'SPX' })).toMatchObject({ status: 'conflict', value: null });
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

test('one publication yields security Trade, spot references, stated Trend and Alpha Codes, each re-derivable from its own text', () => {
  const { extractPublishedStatements, isStatedReading } = require('./publishedResearchSignals.cjs');
  const source = snapshot([
    '11/02/2026 07:27 AM EST',
    'UST 2yr Yield down -11 basis points last week to Signal Bearish TRADE, but Bullish TREND',
    'Gold remains Bearish TRADE and TREND, so we’ll see when we get The Signal to go bullish in #Quad4',
    'Oil’s (WTI) Alpha Code = 9791 (TRADE = $97, TREND = $91)',
  ].join('\n'), { date: '2026-11-02', htmlSource: 'hedgeye-email/messages/2026-11-02/early-look/original.html', publishedAt: '2026-11-02T00:00:00+00:00' });
  const statements = extractPublishedStatements(source);
  expect(statements.trade).toEqual([expect.objectContaining({ ticker: 'UST2Y', value: 'BEARISH',
    // The printed send time replaces the midnight placeholder, so same-day publications order by time.
    publishedAt: '2026-11-02T12:27:00.000Z' })]);
  expect(statements.references).toEqual([expect.objectContaining({ sourceTicker: 'GOLD', value: 'BEARISH',
    instrumentKey: 'reference:GOLD', basisLabel: 'spot', referenceOnly: true })]);
  expect(statements.trends.map((item) => `${item.sourceTicker}:${item.value}`).sort()).toEqual(['GOLD:BEARISH', 'UST2Y:BULLISH']);
  expect(statements.alphaCodes).toEqual([expect.objectContaining({ sourceTicker: 'CL',
    levels: { raw: '9791', trade: 97, trend: 91, unit: '$', basis: 'printed-levels' } })]);
  [...statements.references, ...statements.trends, ...statements.alphaCodes].forEach((item) => expect(isStatedReading(item)).toBe(true));
  // A spot reference never answers for the GOLD security, and an edited reading no longer verifies.
  expect(selectLatestPublishedTrade(statements.references, { ticker: 'GOLD' })).toBeNull();
  expect(isStatedReading({ ...statements.trends[0], value: 'BEARISH', sourceText: statements.trends[0].sourceText.replace('Bullish TREND', 'Bearish TREND') })).toBe(false);
  expect(isStatedReading({ ...statements.alphaCodes[0], levels: { ...statements.alphaCodes[0].levels, trade: 98 } })).toBe(false);
});

test('a later same-day publication supersedes an earlier one once both carry send times', () => {
  const early = extractPublishedTradeSignals(snapshot('10/30/2026 07:27 AM EDT\nUST 10yr Yield is Bullish TRADE', { date: '2026-10-30',
    htmlSource: 'hedgeye-email/messages/2026-10-30/early-look/a.html' }))[0];
  const later = extractPublishedTradeSignals(snapshot('10/30/2026 08:30 AM EDT\nUST 10yr Yield is Bearish TRADE, Neutral TREND', { date: '2026-10-30',
    snapshotType: 'top-3-things', htmlSource: 'hedgeye-email/messages/2026-10-30/top-3-things/a.html' }))[0];
  expect(selectLatestPublishedTrade([early, later], { ticker: 'UST10Y' })).toMatchObject({ status: 'available', value: 'BEARISH', sourceProduct: 'top-3-things' });
});
