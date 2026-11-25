const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createResearchPiece } = require('./research.cjs');

const NOW = Date.parse('2026-10-31T15:00:00Z');
const descriptor = (value, extra = {}) => ({ status: 'available', value, sourceId: 'risk-ranges', sourceLabel: 'Risk Ranges',
  sourceDate: '2026-10-30', publishedAt: '2026-10-30T11:31:46+00:00', reason: null, ...extra });
const missing = reason => ({ status: 'unavailable', value: null, sourceId: null, sourceLabel: null, sourceDate: null, publishedAt: null, reason });
const range = (lrr, hrr) => descriptor({ lrr, hrr }, { lrr, hrr, trend: 'BULLISH', decisionEligible: true });
const reference = (matchedText, lrr, hrr, extra = {}) => ({ productId: 'risk-ranges', kind: 'primary_risk_range', marketDate: '2026-10-30',
  matchType: 'direct_alias', matchedText, value: { lrr, hrr, trend: 'BULLISH' }, decisionEligible: true, ...extra });
const entry = (riskRange, references, extra = {}) => ({ decision: {
  trade: missing('no-verified-published-trade-signal'), trend: descriptor('BULLISH'), riskRange,
  signalStrength: missing('no-explicit-signal-strength-event'), ...extra,
}, directReferences: references });
const intelligence = bySymbol => async () => ({ schemaVersion: 2, marketDate: '2026-10-30', bySymbol });
// Trade as a publication states it: explicit evidence, its feed item and its own instrument.
const publishedTrade = (ticker, value, extra = {}) => ({ status: 'available', value, sourceId: 'early-look', sourceLabel: 'Early Look',
  sourceDate: '2026-10-30', publishedAt: '2026-10-30T11:27:00.000Z', sourceUrl: 'https://app.hedgeye.com/feed_items/189000',
  sourceTicker: ticker, ticker, qualityStatus: 'indexed', reason: null,
  signalProvenance: { field: 'trade', sourceField: 'article.bodyText', method: 'explicit-statement', sourceText: `${ticker} is ${value} TRADE` }, ...extra });
const freshArchive = () => ({ refreshedAt: '2026-10-31T14:58:00Z' });

test('a range routed through a research alias is a labelled proxy; the same instrument is direct', async () => {
  const piece = createResearchPiece({ now: () => NOW, tradeArchiveStatus: freshArchive, loadSecurityIntelligence: intelligence({
    SPY: entry(range(7612, 7779), [reference('SPX', 7612, 7779), reference('SPX', 7612, 7779, { kind: 'risk_range', matchType: 'direct' }),
      reference('SPX', 7612, 7779, { productId: 'early-look', decisionEligible: false })]),
    BTC: entry(range(76366, 81319), [reference('BITCOIN', 76366, 81319)]),
    AAPL: entry(range(339, 353), [reference('AAPL', 339, 353, { matchType: 'direct' })]),
    XLV: entry(range(178, 186), [reference('XLV', 178, 186), reference('HEALTH CARE', 178, 186, { kind: 'risk_range' })]),
  }) });
  const research = await piece.loadMany(['SPY', 'BTC', 'AAPL', 'XLV']);
  assert.deepEqual(research.get('SPY').riskRange.value, { lrr: 7612, hrr: 7779 });
  assert.deepEqual([research.get('SPY').riskRange.sourceInstrument, research.get('SPY').riskRange.match], ['SPX', 'proxy']);
  assert.equal(research.get('SPY').trend.match, 'proxy', 'a Trend from the same publication carries the same instrument');
  assert.equal(research.get('SPY').riskRange.asOf, '2026-10-30');
  assert.deepEqual([research.get('BTC').riskRange.sourceInstrument, research.get('BTC').riskRange.match], ['BITCOIN', 'direct']);
  assert.equal(research.get('AAPL').riskRange.match, 'direct');
  // Two instruments behind one range cannot be attributed.
  assert.deepEqual([research.get('XLV').riskRange.sourceInstrument, research.get('XLV').riskRange.match], [null, 'unverified']);
});

test('a key rewritten at ingest or a range far from the close is a proxy, whatever the key says', async () => {
  const piece = createResearchPiece({ now: () => NOW, tradeArchiveStatus: freshArchive,
    loadReferencePrices: async () => new Map([['GLD', 371.2], ['AAPL', 348], ['QQQX', 25], ['BTC', 78000], ['SPY', 681]]),
    loadSecurityIntelligence: intelligence({
      GLD: entry(range(3923, 4125), [reference('GLD', 3923, 4125, { matchType: 'direct' })]),
      AAPL: entry(range(339, 353), [reference('AAPL', 339, 353, { matchType: 'direct' })]),
      QQQX: entry(range(500, 520), [reference('QQQX', 500, 520, { matchType: 'direct' })]),
      BTC: entry(range(76366, 81319), [reference('BITCOIN', 76366, 81319)]),
      SPY: entry(range(7612, 7779), [reference('SPX', 7612, 7779)]),
    }) });
  const research = await piece.loadMany(['GLD', 'AAPL', 'QQQX', 'BTC', 'SPY']);
  assert.deepEqual([research.get('SPY').riskRange.match, research.get('SPY').riskRange.scaleCheck], ['proxy', 'range-scale-differs-from-price']);
  assert.equal(research.get('GLD').riskRange.scaleCheck, 'range-scale-differs-from-price');
  assert.deepEqual([research.get('GLD').riskRange.sourceInstrument, research.get('GLD').riskRange.match], ['GOLD', 'proxy']);
  assert.deepEqual([research.get('AAPL').riskRange.match, research.get('AAPL').riskRange.scaleCheck], ['direct', 'consistent']);
  assert.deepEqual([research.get('QQQX').riskRange.match, research.get('QQQX').riskRange.scaleCheck], ['proxy', 'range-scale-differs-from-price']);
  assert.deepEqual([research.get('BTC').riskRange.match, research.get('BTC').riskRange.scaleCheck], ['direct', 'consistent']);
  // Without a verified close the key decides, and says it was not checked.
  const unchecked = await createResearchPiece({ now: () => NOW, tradeArchiveStatus: freshArchive, loadReferencePrices: async () => { throw new Error('offline'); },
    loadSecurityIntelligence: intelligence({ AAPL: entry(range(339, 353), [reference('AAPL', 339, 353)]) }) }).loadMany(['AAPL']);
  assert.deepEqual([unchecked.get('AAPL').riskRange.match, unchecked.get('AAPL').riskRange.scaleCheck], ['direct', 'not-checked']);
});

test('unpublished readings keep their reason, Tail says it has no source, and a missing symbol is unavailable', async () => {
  const piece = createResearchPiece({ now: () => NOW, tradeArchiveStatus: freshArchive, loadSecurityIntelligence: intelligence({
    COST: entry(missing('symbol-not-in-verified-primary-publication'), [], { trend: missing('symbol-not-in-verified-primary-publication') }),
  }) });
  const research = await piece.loadMany(['COST', 'ZZZZ']);
  const cost = research.get('COST');
  assert.equal(cost.status, 'unavailable');
  assert.equal(cost.riskRange.reason, 'symbol-not-in-verified-primary-publication');
  assert.equal(cost.tail.reason, 'no-published-tail-source');
  assert.equal(cost.trade.reason, 'no-verified-published-trade-signal');
  assert.equal(research.get('ZZZZ').trend.reason, 'symbol-not-in-security-intelligence');
});

test('a trade archive that has not refreshed recently marks Trade partial instead of current', async () => {
  const bySymbol = { NVDA: entry(range(170, 190), [reference('NVDA', 170, 190)], { trade: publishedTrade('NVDA', 'BULLISH') }) };
  for (const archive of [() => null, () => ({ refreshedAt: null }), () => ({ refreshedAt: '2026-10-31T14:00:00Z' })]) {
    const research = await createResearchPiece({ now: () => NOW, tradeArchiveStatus: archive, loadSecurityIntelligence: intelligence(bySymbol) }).loadMany(['NVDA']);
    assert.deepEqual([research.get('NVDA').trade.status, research.get('NVDA').trade.reason], ['partial', 'published-trade-archive-unavailable']);
  }
  const current = await createResearchPiece({ now: () => NOW, tradeArchiveStatus: freshArchive, loadSecurityIntelligence: intelligence(bySymbol) }).loadMany(['NVDA']);
  assert.deepEqual([current.get('NVDA').trade.status, current.get('NVDA').trade.value], ['available', 'BULLISH']);
});

test('flagged or malformed research is rejected', async () => {
  const flagged = await createResearchPiece({ now: () => NOW, tradeArchiveStatus: freshArchive, loadSecurityIntelligence: intelligence({
    MOCK: entry({ ...range(1, 2), mock: true }, [reference('MOCK', 1, 2)]),
    SEED: { ...entry(range(1, 2), []), seeded: true },
  }) }).loadMany(['MOCK', 'SEED']);
  assert.equal(flagged.get('MOCK').riskRange.reason, 'research-reading-unverified');
  assert.equal(flagged.get('SEED').status, 'unavailable');
  for (const response of [null, { schemaVersion: 1, bySymbol: {} }, { schemaVersion: 2, bySymbol: {}, stale: true }]) {
    await assert.rejects(createResearchPiece({ loadSecurityIntelligence: async () => response }).loadMany(['SPY']));
  }
});

test('Trade is the current or latest dated publication, and stated Trend and Alpha Codes come from the archive for the exact instrument', async () => {
  const retained = publishedTrade('USD', 'BULLISH', { status: 'historical', sourceDate: '2026-10-16', publishedAt: '2026-10-16T11:27:00.000Z',
    signalProvenance: { field: 'trade', sourceField: 'article.bodyText', method: 'explicit-statement',
      sourceText: 'US Dollar Index was up +0.1% on the week and remains Bullish on both our TRADE and TREND' } });
  const archived = (fields) => ({ sourceProduct: 'early-look', sourceLabel: 'Early Look', date: '2026-11-02', publishedAt: '2026-11-02T12:27:00.000Z',
    sourceUrl: 'https://app.hedgeye.com/feed_items/189309', ...fields });
  const statements = {
    references: [],
    trends: [archived({ sourceTicker: 'UST2Y', value: 'BULLISH', sourceText: 'UST 2yr Yield … to Signal Bearish TRADE, but Bullish TREND' }),
      archived({ sourceTicker: 'GOLD', value: 'BEARISH', referenceOnly: true, sourceText: 'Gold remains Bearish TRADE and TREND' })],
    alphaCodes: [archived({ sourceTicker: 'CL', levels: { raw: '9791', trade: 97, trend: 91, unit: '$', basis: 'printed-levels' },
      sourceText: 'Oil’s (WTI) Alpha Code = 9791 (TRADE = $97, TREND = $91)' })],
  };
  const bySymbol = {
    USD: { ...entry(missing('symbol-not-in-verified-primary-publication'), []), lastVerifiedDecision: { trade: retained } },
    UST2Y: entry(missing('symbol-not-in-verified-primary-publication'), []),
    WTIC: entry(missing('symbol-not-in-verified-primary-publication'), []),
    GOLD: entry(missing('symbol-not-in-verified-primary-publication'), []),
  };
  const piece = createResearchPiece({ now: () => NOW, tradeArchiveStatus: freshArchive, loadSecurityIntelligence: intelligence(bySymbol),
    loadPublishedStatements: async () => statements });
  const research = await piece.loadMany(['USD', 'UST2Y', 'WTIC', 'GOLD']);
  assert.deepEqual([research.get('USD').trade.value, research.get('USD').trade.asOf, research.get('USD').trade.retained, research.get('USD').trade.source],
    ['BULLISH', '2026-10-16', true, 'Early Look']);
  // A Trade without explicit published evidence is not shown, as on the board.
  const unproven = await createResearchPiece({ now: () => NOW, tradeArchiveStatus: freshArchive, loadPublishedStatements: async () => statements,
    loadSecurityIntelligence: intelligence({ USD: entry(missing('x'), [], { trade: { ...retained, status: 'available', signalProvenance: null } }) }) }).loadMany(['USD']);
  assert.equal(unproven.get('USD').trade.status, 'unavailable');
  assert.deepEqual([research.get('UST2Y').statedTrend.value, research.get('UST2Y').statedTrend.source], ['BULLISH', 'Early Look']);
  assert.deepEqual(research.get('WTIC').alphaCode.value, { raw: '9791', trade: 97, trend: 91, unit: '$', basis: 'printed-levels' }, 'WTIC is the catalog alias of CL');
  assert.equal(research.get('GOLD').statedTrend.reason, 'no-stated-trend', 'gold spot is not GOLD the security');
  const stale = await createResearchPiece({ now: () => NOW, tradeArchiveStatus: () => ({ refreshedAt: '2026-10-31T14:00:00Z' }),
    loadSecurityIntelligence: intelligence(bySymbol), loadPublishedStatements: async () => statements }).loadMany(['UST2Y']);
  assert.equal(stale.get('UST2Y').statedTrend.reason, 'published-research-archive-unavailable');
});

test('the record states where the price stands against a watched security\u2019s own lines', async () => {
  const bySymbol = { NVDA: { decision: {} } };
  const watch = { updatedAt: '2026-11-04T15:00:00Z', lines: { 'NVDA|trade': { duration: 'trade', level: 221, side: 'below', since: '2026-11-04T14:40:00Z', printedDate: '2026-11-03', breaks: [{}] } } };
  const piece = createResearchPiece({ now: () => NOW, tradeArchiveStatus: freshArchive, loadSecurityIntelligence: intelligence(bySymbol), loadAlphaCodeWatch: async () => watch });
  const lines = (await piece.loadMany(['NVDA'])).get('NVDA').alphaCodeLines;
  assert.deepEqual(lines.value, { trade: { level: 221, side: 'below', since: '2026-11-04T14:40:00Z', printedDate: '2026-11-03', breaks: 1 } });
  assert.equal(lines.status, 'available');
  const none = await createResearchPiece({ now: () => NOW, tradeArchiveStatus: freshArchive, loadSecurityIntelligence: intelligence(bySymbol) }).loadMany(['NVDA']);
  assert.equal(none.get('NVDA').alphaCodeLines.reason, 'no-watched-alpha-code');
});


test('fills a missing range only from an ETF Pro edition of the same session, never over a daily one', async () => {
  const loadSecurityIntelligence = async () => ({ schemaVersion: 2, marketDate: '2026-10-30', bySymbol: {
    DRAM: entry(missing('symbol-not-in-verified-primary-publication'), []), AAPL: entry(range(90, 110), [reference('AAPL', 90, 110)]) } });
  const piece = (asOf) => createResearchPiece({ now: () => NOW, loadSecurityIntelligence, loadReferencePrices: async () => new Map([['DRAM', 41], ['AAPL', 100]]),
    loadWeeklyRanges: async () => new Map([['DRAM', { lrr: 35.12, hrr: 46.65, asOf }], ['AAPL', { lrr: 1, hrr: 2, asOf }]]) });
  const rows = await piece('2026-10-30').loadMany(['DRAM', 'AAPL']);
  const dram = rows.get('DRAM').riskRange;
  assert.deepEqual([dram.status, dram.value, dram.source, dram.cadence, dram.match, dram.asOf], ['available', { lrr: 35.12, hrr: 46.65 }, 'ETF Pro', 'weekly', 'direct', '2026-10-30']);
  assert.deepEqual(rows.get('AAPL').riskRange.value, { lrr: 90, hrr: 110 });
  assert.equal((await piece('2026-10-29').loadMany(['DRAM'])).get('DRAM').riskRange.status, 'unavailable');
});

test('a daily range from an earlier session is no range', async () => {
  const piece = createResearchPiece({ now: () => NOW, tradeArchiveStatus: freshArchive, loadSecurityIntelligence: async () => ({ schemaVersion: 2, marketDate: '2026-11-02',
    bySymbol: { AAPL: entry(range(339, 353), [reference('AAPL', 339, 353, { matchType: 'direct' })]) } }) });
  const field = (await piece.loadMany(['AAPL'])).get('AAPL').riskRange;
  assert.deepEqual([field.status, field.reason, field.asOf], ['unavailable', 'range-not-from-current-session', '2026-10-30']);
});

test('a same-day secondary range is matched by its own rows and labelled with its product', async () => {
  const secondary = (sourceId, sourceLabel, lrr, hrr, extra = {}) => ({ status: 'available', value: { lrr, hrr }, lrr, hrr, trend: null, sourceId, sourceLabel,
    sourceDate: '2026-10-30', publishedAt: '2026-10-30T00:00:00+00:00', decisionEligible: false, secondary: true, corroboratedBy: [], reason: null, ...extra });
  const row = (productId, matchedText, lrr, hrr) => reference(matchedText, lrr, hrr, { productId, kind: 'investing_idea_position', matchType: 'direct', decisionEligible: false });
  const piece = createResearchPiece({ now: () => NOW, tradeArchiveStatus: freshArchive, loadReferencePrices: async () => new Map([['COST', 1080]]),
    loadSecurityIntelligence: intelligence({
      COST: entry(secondary('investing-ideas', 'Investing Ideas', 1022, 1136), [row('investing-ideas', 'COST', 1022, 1136)]),
      IWM: entry(secondary('early-look', 'Early Look', 2717, 2846, { corroboratedBy: ['investing-ideas'] }),
        [row('early-look', 'RUT', 2717, 2846), row('early-look', 'RUSSELL 2000 (RUT)', 2717, 2846)]),
      MARA: entry({ status: 'conflict', value: null, sourceId: null, sourceDate: '2026-10-30', reason: 'conflicting-same-day-risk-ranges',
        conflictingRanges: [{ sourceId: 'investing-ideas', lrr: 5.67, hrr: 7.98 }, { sourceId: 'bitcoin-trend-tracker', lrr: 5.67, hrr: 7.78 }] }, []),
    }) });
  const research = await piece.loadMany(['COST', 'IWM', 'MARA']);
  assert.deepEqual([research.get('COST').riskRange.status, research.get('COST').riskRange.match, research.get('COST').riskRange.source, research.get('COST').riskRange.secondary],
    ['available', 'direct', 'Investing Ideas', true]);
  assert.deepEqual(research.get('COST').riskRange.value, { lrr: 1022, hrr: 1136 });
  // The table's long label and its ticker are one printed instrument, still another index's range.
  assert.deepEqual([research.get('IWM').riskRange.sourceInstrument, research.get('IWM').riskRange.match], ['RUT', 'proxy']);
  assert.deepEqual(research.get('IWM').riskRange.corroboratedBy, ['investing-ideas']);
  assert.deepEqual([research.get('MARA').riskRange.status, research.get('MARA').riskRange.reason], ['unavailable', 'conflicting-same-day-risk-ranges']);
  assert.equal(research.get('MARA').riskRange.conflictingRanges.length, 2);
});
