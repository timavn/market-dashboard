const test = require('node:test');
const assert = require('node:assert/strict');
const { foldStanceEvents, scanHoldings, stancesFromEvent, loadStanceLedger } = require('./stanceBook.cjs');
const { evaluateResearchAttention } = require('./attentionResearch.cjs');

const NOW = new Date('2026-10-27T14:45:00Z');
const feed = id => `https://app.hedgeye.com/feed_items/${id}`;
// Rows as the research ledger stores them (ResearchEntityEventsV1).
function ledger(entityId, productKey, eventType, fieldPath, excerpt, marketDate, extra = {}) {
  return { entityId, entityType: 'ticker', productKey, eventType, fieldPath, excerpt, marketDate, publishedAt: `${marketDate}T00:00:00+00:00`,
    qualityStatus: 'validated', matchType: 'structured_membership', sourceUrl: feed(`${productKey}-${marketDate}`), sourceMessageId: `msg-${productKey}-${marketDate}`, ...extra };
}
const listed = (ticker, side, marketDate, entryDate, index = 0) => ledger(ticker, 'signal-strength', side === 'short' ? 'signal_strength_short_membership' : 'signal_strength_membership',
  side === 'short' ? `data.shorts.stocks[${index}]` : `data.stocks[${index}]`, JSON.stringify({ ticker, side, entryDate, bestIdeaRank: 'Bench' }), marketDate);
const alert = (ticker, action, headline, marketDate) => ledger(ticker, 'real-time-alert', 'position_change', 'data.alert',
  JSON.stringify({ action, headline, ticker, name: ticker, analyst: 'KM' }), marketDate);

// The research that sat against the book on 2026-10-27 before any red Alert.
const OCTOBER = [
  listed('BRBR', 'short', '2026-10-21', '2026-07-14', 3), listed('GIII', 'short', '2026-10-21', '2026-08-04', 4), listed('LCID', 'short', '2026-10-21', '2026-05-02', 5),
  ledger('BRBR', 'signal-strength', 'signal_strength_short_removed', 'data.shorts.removed[0]', 'BRBR', '2026-10-22'),
  listed('GIII', 'short', '2026-10-22', '2026-08-04', 27), listed('LCID', 'short', '2026-10-22', '2026-05-02', 5),
  ledger('GIII', 'signal-strength', 'signal_strength_short_removed', 'data.shorts.removed[1]', 'GIII', '2026-10-23'),
  listed('LCID', 'short', '2026-10-23', '2026-05-02', 5),
  ledger('EFX', 'signal-strength', 'signal_strength_added', 'data.added[0]', 'EFX', '2026-10-26'),
  listed('EFX', 'long', '2026-10-26', '2026-10-26', 0), listed('LCID', 'short', '2026-10-26', '2026-05-02', 5),
  alert('MPC', 'SELL-SOME', 'Real-Time Alert: Sell-SOME Signal (Jonesy 100%): MPC -KM', '2026-10-26'),
  ledger('MPC', 'real-time-alert', 'position_change', 'article.headline', 'SELL SIGNAL MPC', '2026-10-26'),
  ledger('LCID', 'real-time-alert', 'position_change', 'data.alert.headline', 'BUY SIGNAL - COVERING SHORT LCID', '2026-10-26'),
  // The web headline drops SOME; the alert body keeps it ("Cover-SOME (booking SOME = process)").
  ledger('KM', 'real-time-alert', 'position_change', 'article.bodyText', '…10/26/2026 10:38 AM EDT BUY SIGNAL - COVERING SHORT LCID $3.44 We\'ll book-SOME on red on this one too, …', '2026-10-26'),
  // Field fragments index the wrong "ticker"; none of them is a stance.
  ledger('COVERING', 'real-time-alert', 'position_change', 'data.alert.headline', 'BUY SIGNAL - COVERING SHORT LCID', '2026-10-26'),
  ledger('SOME', 'real-time-alert', 'position_change', 'data.alert.signalPhrase', 'Sell-SOME', '2026-10-26'),
  ledger('KM', 'real-time-alert', 'position_change', 'data.alert.headline', 'Real-Time Alert: Sell-SOME Signal (Jonesy 100%): MPC -KM', '2026-10-26'),
];
const BOOK = [{ symbol: 'EFX', quantity: -13.75 }, { symbol: 'GIII', quantity: -147.0313 }, { symbol: 'BRBR', quantity: -350 },
  { symbol: 'LCID', quantity: -650 }, { symbol: 'MPC', quantity: 7.5 }, { symbol: 'OKTA', quantity: 20 }];
function verified(positions, stanceBook) {
  return { marketDate: '2026-10-27', events: [], stanceBook, research: { scanComplete: true, bySymbol: {} }, documents: { products: [] },
    holdings: { liveVerified: true, complete: true, researchComplete: true, asOf: new Date(NOW.getTime() - 5000).toISOString(), positions, currentHoldings: [], ruleHoldings: [] } };
}

test('the first verified read after Gateway connects raises every standing contradiction at once', () => {
  // The journal has long since dropped the Oct 22–26 events; only the book remembers them.
  const { book } = foldStanceEvents(undefined, OCTOBER, NOW);
  const findings = evaluateResearchAttention(verified(BOOK, book), NOW).findings.filter(item => item.severity === 'action-required');
  const stance = symbol => findings.find(item => item.symbol === symbol).presentation.stance;
  const call = (product, action, date, bias) => ({ product, action, date, bias });
  assert.deepEqual(Object.fromEntries(findings.map(item => [item.symbol, item.action])), { EFX: 'exit', GIII: 'exit', BRBR: 'exit', LCID: 'trim', MPC: 'trim' });
  assert.deepEqual(stance('EFX').calls, [call('Signal Strength', 'LONG', '2026-10-26', 'BULLISH')]);
  assert.deepEqual(stance('GIII').calls, [call('Signal Strength Shorts', 'REMOVE', '2026-10-23', 'NEUTRAL')]);
  assert.deepEqual(stance('BRBR').calls, [call('Signal Strength Shorts', 'REMOVE', '2026-10-22', 'NEUTRAL')]);
  // Booking SOME of a short keeps it short: both calls stay bearish, newest first.
  assert.deepEqual(stance('LCID').calls, [call('Real-Time Alert', 'COVER SOME', '2026-10-26', 'BEARISH'), call('Signal Strength Shorts', 'SHORT', '2026-05-02', 'BEARISH')]);
  assert.deepEqual(stance('LCID').order, { verb: 'BUY', quantity: null, note: 'some · stays short' });
  assert.deepEqual(stance('MPC').calls, [call('Real-Time Alert', 'SELL SOME', '2026-10-26', 'BULLISH')]);
  assert.deepEqual(stance('EFX').order, { verb: 'BUY', quantity: 13.75, note: 'to close short' });
  assert.deepEqual(stance('EFX').target, { side: null, quantity: 0, weightPct: 0 });
  // No sizing band was captured for MPC, so the trim names no size and keeps the side.
  assert.deepEqual([stance('MPC').target, stance('MPC').order], [{ side: 'LONG', quantity: null, weightPct: null }, { verb: 'SELL', quantity: null, note: 'some · stays long' }]);
});

test('a sizing review on the same holding never hides its contradiction', () => {
  const { book } = foldStanceEvents(undefined, OCTOBER, NOW);
  const ctx = verified([{ symbol: 'BRBR', quantity: -350 }], book);
  ctx.holdings.currentHoldings.push({ holding: 'BRBR', quantity: -350, currentHolding: { weightPct: 40, source: 'ibkr', basis: 'absolute_market_value_over_net_liquidation', asOf: ctx.holdings.asOf } });
  ctx.holdings.ruleHoldings.push({ holding: 'BRBR', quantity: -350, heldSide: 'SHORT', trade: 'BEARISH', trend: 'BEARISH', weightPct: 40,
    signalContext: { trade: { status: 'published' }, trend: { status: 'published' } },
    // ATR 3.70 on 185 sets MAX 6.25%; a 40% weight is a sizing review.
    sizingInputs: { atr14: { value: 3.7, observations: 14, status: 'available', source: 'Yahoo Finance chart API', asOf: '2026-10-26' },
      referencePrice: { value: 185, observations: 1, status: 'available', source: 'Yahoo Finance chart API', asOf: '2026-10-26' } },
    sources: { trade: { publishedAt: '2026-10-27T12:00:00Z', citation: { id: 'cite_trade', sourceUri: feed('rr') } }, trend: { publishedAt: '2026-10-27T12:00:00Z', citation: { id: 'cite_trend', sourceUri: feed('rr') } } } });
  const findings = evaluateResearchAttention(ctx, NOW).findings.filter(item => item.symbol === 'BRBR');
  assert.equal(findings.length, 2);
  assert.deepEqual(findings.map(item => [item.rule?.rule ?? 'stance', item.severity ?? null]).sort(), [['ABOVE_MAX', null], ['stance', 'action-required']]);
});

test('folding is idempotent and order-independent', () => {
  const once = foldStanceEvents(undefined, OCTOBER, NOW).book;
  assert.equal(foldStanceEvents(once, OCTOBER, NOW).changed, false);
  const reversed = foldStanceEvents(undefined, [...OCTOBER].reverse(), NOW).book;
  assert.deepEqual(reversed.tickers, once.tickers);
});

test('a restated alert keeps its explicit SOME; field fragments never become tickers', () => {
  const { book } = foldStanceEvents(undefined, OCTOBER, NOW);
  assert.equal(book.tickers.MPC['real-time-alert'].action, 'SELL-SOME');
  for (const fragment of ['COVERING', 'SOME', 'KM']) assert.equal(book.tickers[fragment], undefined);
});

test('a later re-add supersedes a removal, and later support from another product supersedes an older call', () => {
  const readd = [...OCTOBER, listed('GIII', 'short', '2026-10-27', '2026-10-27', 0)];
  const now = new Date('2026-10-27T20:00:00Z');
  const rows = scanHoldings(foldStanceEvents(undefined, readd, now).book, [{ symbol: 'GIII', quantity: -10 }]);
  assert.deepEqual(rows[0].opposing, []);
  // MPC: an ETF Pro Long add after the Sell-SOME supports the Long again.
  const supported = [...OCTOBER, ledger('MPC', 'etf-pro', 'position_change', 'data.changes[0]', 'ADD LONG', '2026-10-27')];
  assert.deepEqual(scanHoldings(foldStanceEvents(undefined, supported, now).book, [{ symbol: 'MPC', quantity: 7.5 }])[0].opposing, []);
});

test('a listing that drops off the latest roster without a removal is no longer a stance', () => {
  // LCID is missing from the Oct 27 Shorts edition, which lists other names.
  const events = [...OCTOBER, listed('ZZZ', 'short', '2026-10-27', '2026-09-01', 0)];
  const [row] = scanHoldings(foldStanceEvents(undefined, events, new Date('2026-10-27T20:00:00Z')).book, [{ symbol: 'LCID', quantity: -650 }]);
  assert.deepEqual(row.supporting, []);
  assert.deepEqual(row.opposing.map(item => item.slot), ['real-time-alert']);
});

test('ETF Pro changes are typed by side; a held Long is not touched by a Short-book removal', () => {
  const events = [ledger('IBIT', 'etf-pro', 'position_change', 'data.changes[2]', 'REMOVE LONG', '2026-10-27'),
    ledger('GDX', 'etf-pro', 'position_change', 'data.changes[0]', 'ADD SHORT', '2026-10-27'),
    ledger('XLU', 'etf-pro', 'position_change', 'data.changes[1]', 'REMOVE SHORT', '2026-10-27'),
    // Roster echoes of the same change carry no action.
    ledger('IBIT', 'etf-pro', 'position_change', 'data.removedLongs[0]', 'IBIT', '2026-10-27')];
  const rows = scanHoldings(foldStanceEvents(undefined, events, NOW).book, [{ symbol: 'IBIT', quantity: 5 }, { symbol: 'GDX', quantity: 5 }, { symbol: 'XLU', quantity: 5 }]);
  assert.deepEqual(Object.fromEntries(rows.map(row => [row.symbol, row.opposing.map(item => item.stance)])), { IBIT: ['EXIT_LONG'], GDX: ['SHORT'], XLU: [] });
});

test('acting on a partial call clears it; a new call raises it again', () => {
  const { book } = foldStanceEvents(undefined, OCTOBER, NOW);
  const [first] = evaluateResearchAttention(verified([{ symbol: 'MPC', quantity: 7.5 }], book), NOW).findings;
  assert.deepEqual(first.stanceBaseline, { date: '2026-10-26', quantity: 7.5 });
  const trimmed = verified([{ symbol: 'MPC', quantity: 4 }], book);
  trimmed.previousAttention = [{ ...first, state: 'open' }];
  assert.deepEqual(evaluateResearchAttention(trimmed, NOW).findings, []);
  const next = new Date('2026-10-28T15:00:00Z');
  const later = foldStanceEvents(book, [alert('MPC', 'SELL-SOME', 'Real-Time Alert: Sell-SOME Signal (again): MPC -KM', '2026-10-28')], next).book;
  const again = verified([{ symbol: 'MPC', quantity: 4 }], later);
  again.holdings.asOf = new Date(next.getTime() - 5000).toISOString();
  again.previousAttention = trimmed.previousAttention;
  assert.equal(evaluateResearchAttention(again, next).findings[0].action, 'trim');
});

test('a partial call expires after a week, a full alert after a month and a removal after a quarter', () => {
  const old = [alert('MPC', 'SELL', 'Real-Time Alert: Sell Signal (x): MPC -KM', '2026-09-20'),
    alert('VLO', 'SELL-SOME', 'Real-Time Alert: Sell-SOME Signal (x): VLO -KM', '2026-10-19'),
    ledger('GIII', 'signal-strength', 'signal_strength_short_removed', 'data.shorts.removed[0]', 'GIII', '2026-07-20')];
  assert.deepEqual(foldStanceEvents(undefined, old, NOW).book.tickers, {});
  const recent = [alert('MPC', 'SELL', 'Real-Time Alert: Sell Signal (x): MPC -KM', '2026-09-28'), alert('VLO', 'SELL-SOME', 'Real-Time Alert: Sell-SOME Signal (x): VLO -KM', '2026-10-21')];
  assert.deepEqual(Object.keys(foldStanceEvents(undefined, recent, NOW).book.tickers).sort(), ['MPC', 'VLO']);
});

test('untrusted, future and unrelated-product rows are not stances', () => {
  const base = ledger('EFX', 'signal-strength', 'signal_strength_added', 'data.added[0]', 'EFX', '2026-10-26');
  for (const event of [{ ...base, mock: true }, { ...base, qualityStatus: 'pending' }, { ...base, publishedAt: '2026-10-28T00:00:00Z' },
    { ...base, productKey: 'the-call' }, { ...base, excerpt: 'EFX was discussed', fieldPath: 'article.bodyText' }]) {
    assert.deepEqual(stancesFromEvent(event, NOW), []);
  }
});

test('the ledger history reads only the stance products, one projected query per date', async () => {
  const calls = [];
  const dynamodb = { query: params => ({ promise: async () => { calls.push(params); return { Items: [{ entityId: 'EFX' }] }; } }) };
  const history = await loadStanceLedger(dynamodb, { days: 3, now: NOW });
  assert.deepEqual([history.from, history.through, history.events.length], ['2026-10-25', '2026-10-27', 3]);
  assert.deepEqual(calls.map(call => call.ExpressionAttributeValues[':date']).sort(), ['2026-10-25', '2026-10-26', '2026-10-27']);
  assert.deepEqual(Object.entries(calls[0].ExpressionAttributeValues).filter(([key]) => key.startsWith(':p')).map(([, value]) => value), ['signal-strength', 'etf-pro', 'real-time-alert']);
  assert.match(calls[0].KeyConditionExpression, /^#f\d+ = :date$/);
  assert.equal(calls[0].ExpressionAttributeNames[calls[0].KeyConditionExpression.split(' ')[0]], 'marketDate');
});

test('a trim targets the security’s own MIN and never crosses to the other side', () => {
  const { book } = foldStanceEvents(undefined, OCTOBER, NOW);
  const ctx = verified([{ symbol: 'MPC', quantity: 7.5 }], book);
  const asOf = ctx.holdings.asOf;
  ctx.holdings.currentHoldings.push({ holding: 'MPC', quantity: 7.5, currentHolding: { weightPct: 4.25, source: 'ibkr', basis: 'absolute_market_value_over_net_liquidation', asOf } });
  const metric = value => ({ value, observations: 14, status: 'available', source: 'Yahoo Finance chart API', asOf: '2026-10-26' });
  // ATR 3.70 on 185 sets MIN 3.25% (see the sizing tests): 7.5 at 4.25% trims to 5.74.
  ctx.holdings.ruleHoldings.push({ holding: 'MPC', quantity: 7.5, heldSide: 'LONG', trade: 'BULLISH', trend: 'BULLISH', weightPct: 4.25,
    signalContext: { trade: { status: 'published' }, trend: { status: 'published' } },
    sources: { trade: { publishedAt: '2026-10-27T12:00:00Z', citation: { id: 'cite_trade', sourceUri: feed('rr') } }, trend: { publishedAt: '2026-10-27T12:00:00Z', citation: { id: 'cite_trend', sourceUri: feed('rr') } } },
    sizingInputs: { atr14: metric(3.7), referencePrice: metric(185) } });
  const stance = evaluateResearchAttention(ctx, NOW).findings.find(item => item.presentation.stance).presentation.stance;
  assert.equal(stance.verdict, 'trim');
  assert.deepEqual(stance.current, { side: 'LONG', quantity: 7.5, weightPct: 4.25 });
  assert.deepEqual(stance.target, { side: 'LONG', quantity: 5.74, weightPct: 3.25 });
  assert.deepEqual(stance.order, { verb: 'SELL', quantity: 1.76, upTo: true, note: 'stays long' });
});

test('a full cover or sell leaves the product with no view; SOME anywhere in the alert keeps the side', () => {
  const full = [ledger('XYZ', 'real-time-alert', 'position_change', 'data.alert.headline', 'BUY SIGNAL - COVERING SHORT XYZ', '2026-10-26')];
  const [row] = scanHoldings(foldStanceEvents(undefined, full, NOW).book, [{ symbol: 'XYZ', quantity: -10 }]);
  assert.deepEqual(row.opposing.map(item => [item.stance, item.action]), [['EXIT_SHORT', 'COVER']]);
  const ctx = verified([{ symbol: 'XYZ', quantity: -10 }], foldStanceEvents(undefined, full, NOW).book);
  assert.deepEqual(evaluateResearchAttention(ctx, NOW).findings[0].presentation.stance.calls, [{ product: 'Real-Time Alert', action: 'COVER', date: '2026-10-26', bias: 'NEUTRAL' }]);
  // The body row arrives in a later fold and still makes the stored alert partial.
  const later = foldStanceEvents(foldStanceEvents(undefined, full, NOW).book,
    [ledger('SOME', 'real-time-alert', 'position_change', 'article.bodyText', 'COVERING SHORT XYZ — book-SOME here', '2026-10-26')], NOW).book;
  assert.deepEqual([later.tickers.XYZ['real-time-alert'].action, later.tickers.XYZ['real-time-alert'].stance], ['COVER-SOME', 'REDUCE_SHORT']);
  // The email subject on the captured report says SOME too.
  const subject = { ...full[0], sourceReport: { sourceMessageId: full[0].sourceMessageId, title: 'Real-Time Alert: Cover-SOME (booking SOME = process): XYZ -KM', bodyText: '' } };
  assert.equal(foldStanceEvents(undefined, [subject], NOW).book.tickers.XYZ['real-time-alert'].action, 'COVER-SOME');
});

test('a book from an older version is rebuilt rather than read', () => {
  const { book, changed } = foldStanceEvents({ version: 1, rosters: {}, tickers: { LCID: { 'real-time-alert': { stance: 'EXIT_SHORT' } } } }, [], NOW);
  assert.deepEqual([book.version, book.backfill, book.tickers, changed], [2, null, {}, false]);
});

test('a SOME that names another ticker does not make this alert partial', () => {
  const ewl = [ledger('EWL', 'real-time-alert', 'position_change', 'data.alert.headline', 'SELL SIGNAL EWL', '2026-10-26'),
    ledger('SOME', 'real-time-alert', 'position_change', 'article.bodyText', '…the move is to cover-SOME EWA and replace the short exposure…', '2026-10-26')];
  assert.equal(foldStanceEvents(undefined, ewl, NOW).book.tickers.EWL['real-time-alert'].action, 'SELL');
  for (const said of ['No one ever went broke booking SOME gains', 'we should sell-SOME into strength', 'sell-SOME EWL here']) {
    const own = [ewl[0], { ...ewl[1], excerpt: said }];
    assert.equal(foldStanceEvents(undefined, own, NOW).book.tickers.EWL['real-time-alert'].action, 'SELL-SOME', said);
  }
});
