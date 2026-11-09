const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateResearchAttention } = require('./attentionResearch.cjs');
const { foldStanceEvents } = require('./stanceBook.cjs');
const NOW = new Date('2026-09-22T16:00:00Z');
const url = 'https://app.hedgeye.com/feed_items/12345';
const cite = field => ({ id: `cite_${field}`, sourceUri: url, title: `${field} source`, publicationDate: '2026-09-22' });
const reference = (symbol, side, excerpt) => ({ productId: 'etf-pro', productLabel: 'ETF Pro', marketDate: '2026-09-22', publishedAt: '2026-09-22T12:00:00Z', sourceUrl: url, qualityStatus: 'indexed', matchType: 'direct', kind: 'position_change', value: { side }, excerpt: excerpt || JSON.stringify({ ticker: symbol, side }) });
function context() { return { marketDate: '2026-09-22', holdings: { liveVerified: true, complete: true, researchComplete: true, asOf: NOW.toISOString(), positions: [], currentHoldings: [], ruleHoldings: [] }, research: { scanComplete: true, bySymbol: {} }, documents: { products: [] }, events: [] }; }
function addHolding(ctx, symbol = 'IGV', side = 'LONG') {
  const quantity = side === 'LONG' ? 10 : -10;
  ctx.holdings.positions.push({ symbol, quantity, category: 'other' });
  ctx.holdings.currentHoldings.push({ holding: symbol, quantity, currentHolding: { weightPct: 4, source: 'ibkr', basis: 'absolute_market_value_over_net_liquidation', asOf: NOW.toISOString() } });
  ctx.holdings.ruleHoldings.push({ holding: symbol, quantity, heldSide: side, trade: side === 'LONG' ? 'BEARISH' : 'BULLISH', trend: 'BULLISH', weightPct: 4,
    signalContext: { trade: { status: 'published' }, trend: { status: 'published' } }, sources: { trade: { publishedAt: '2026-09-22T12:00:00Z', citation: cite('trade') }, trend: { publishedAt: '2026-09-22T11:00:00Z', citation: cite('trend') } } });
}
function addIdea(ctx, symbol, side) {
  ctx.research.bySymbol[symbol] = { decision: {}, directReferences: [reference(symbol, side), reference(symbol, side, `${symbol} faces accelerating ${side === 'Long' ? 'earnings growth and improving demand' : 'margin pressure as demand deteriorates'} after the new company outlook.`)] };
}
test('fresh full-book process conflicts are evaluated without a new research event', () => {
  const ctx = context(); addHolding(ctx);
  const result = evaluateResearchAttention(ctx, NOW);
  assert.equal(result.findings.length, 1);
  const finding = result.findings[0];
  assert.equal(finding.action, 'exit'); assert.equal(finding.kind, 'portfolio');
  assert.equal(finding.holdingsVerified, true); assert.equal(finding.quantity, 10);
  assert.match(finding.presentation.rows.find(row => row.label === 'Context').text, /Trade turned Bearish vs Long → exit/);
  assert.equal(finding.presentation.rows.find(row => row.label === 'Order').text, 'Sell 10 shares');
  assert.equal(result.complete, true);
});
test('fresh holdings cannot upgrade an undated or unlinked Trade into a conflict', () => {
  for (const mode of ['unlinked', 'future', 'indication', 'mock']) {
    const ctx = context(); addHolding(ctx);
    const held = ctx.holdings.ruleHoldings[0]; held.trend = 'BULLISH';
    if (mode === 'unlinked') held.sources.trade.citation = {};
    if (mode === 'future') held.sources.trade.publishedAt = '2026-09-23T00:00:00Z';
    if (mode === 'indication') held.signalContext.trade.status = 'indication';
    if (mode === 'mock') held.sources.trade.mock = true;
    assert.equal(evaluateResearchAttention(ctx, NOW).findings.length, 0, mode);
  }
});
test('offline stale cached seeded and mock holdings remove current claims while research survives', () => {
  for (const changes of [{ connected: false }, { stale: true }, { cacheOnly: true }, { fromCache: true }, { seed: true }, { mock: true }, { freshness: 'delayed' }, { asOf: '2026-09-22T15:58:00Z' }, { complete: false }]) {
    const ctx = context(); addHolding(ctx); addIdea(ctx, 'NEW', 'Long');
    Object.assign(ctx.holdings, changes);
    // Delayed is also not valid for current broker holdings.
    const result = evaluateResearchAttention(ctx, NOW);
    assert.equal(result.findings.filter(item => item.kind === 'portfolio').length, 0);
    assert.equal(result.findings.filter(item => item.kind === 'opportunity').length, 1);
    assert.equal(result.findings[0].holdingsVerified, false);
    assert.equal(result.findings[0].presentation.rows.some(row => row.label === 'Current position'), false);
    assert.equal(result.completeKinds.includes('portfolio'), false);
  }
});
test('both Long and Short research ideas require a timely specific thesis and no quote', () => {
  const ctx = context(); addIdea(ctx, 'LONG', 'Long'); addIdea(ctx, 'SHORT', 'Short');
  const result = evaluateResearchAttention(ctx, NOW);
  assert.equal(result.findings.length, 2);
  for (const finding of result.findings) {
    assert.equal(finding.researchOnly, true); assert.ok(finding.presentation.sourceLinks.length);
    assert.equal(finding.presentation.rows.find(row => row.label === 'Current position').text, 'Not held');
    assert.ok(finding.presentation.rows.find(row => row.label === 'Watch'));
  }
});
test('a published tuple, ticker mention, stale report, truncation or partial sale is not a new opportunity', () => {
  const texts = ['NEW', 'Long: NEW, OLD, ETC. New portfolio positions.', 'NEW has Bullish Trade and Bullish Trend.', '…NEW faces accelerating earnings growth and improving demand after the new outlook…', 'NEW was reduced below minimum as demand deteriorates.'];
  for (const excerpt of texts) {
    const ctx = context(); ctx.research.bySymbol.NEW = { decision: { trade: { status: 'available', value: 'BULLISH' }, trend: { status: 'available', value: 'BULLISH' } }, directReferences: [reference('NEW', 'Long', excerpt)] };
    assert.equal(evaluateResearchAttention(ctx, NOW).findings.length, 0, excerpt);
  }
  const ctx = context(); addIdea(ctx, 'NEW', 'Long'); ctx.research.bySymbol.NEW.directReferences.forEach(ref => ref.marketDate = '2026-09-21');
  assert.equal(evaluateResearchAttention(ctx, NOW).findings.length, 0);
});
test('conflicting sourced Trade is shown as counterevidence, never an entry or size', () => {
  const ctx = context(); addIdea(ctx, 'NEW', 'Long');
  ctx.research.bySymbol.NEW.decision.trade = { status: 'available', value: 'BEARISH', sourceId: 'signal-strength' };
  ctx.research.bySymbol.NEW.directReferences.push({ ...reference('NEW', 'Short'), productId: 'signal-strength', kind: 'trade_signal', value: 'BEARISH' });
  const finding = evaluateResearchAttention(ctx, NOW).findings[0];
  assert.match(finding.presentation.rows.find(row => row.label === 'Counterpoint').text, /Trade is Bearish/);
  assert.equal(finding.currentHolding, null); assert.equal(finding.rule, undefined);
});
function sourceEvent(symbol, action = 'SELL') {
  return { entityType: 'security', entityId: symbol, qualityStatus: 'validated', productKey: 'real-time-alert', productLabel: 'Real-Time Alerts', sourceMessageId: 'aabbcc001122', sourceUrl: url,
    marketDate: '2026-09-22', publishedAt: '2026-09-22T12:00:00Z', excerpt: JSON.stringify({ ticker: symbol, action }),
    sourceReport: { sourceMessageId: 'aabbcc001122', publicationDate: '2026-09-22', contentHash: 'same-exact-report', entityId: symbol, title: `Sell Signal ${symbol}`, bodyText: `Portfolio Managers should be selling-SOME of Bullish TRENDs that are green today.\n${symbol} has rallied sharply while its growth outlook deteriorates, creating an opportunity to raise cash.` } };
}
test('source Sell while already Short is silent; Sell some preserves exact body meaning', () => {
  const ctx = context(); ctx.holdings.positions = [{ symbol: 'EWL', quantity: -10 }, { symbol: 'CORN', quantity: 10 }];
  ctx.events = [sourceEvent('EWL'), sourceEvent('CORN')];
  const findings = evaluateResearchAttention(ctx, NOW).findings;
  assert.equal(findings.length, 1); assert.equal(findings[0].symbol, 'CORN');
  assert.equal(findings[0].action, 'trim');
  assert.deepEqual(findings[0].presentation.stance.calls, [{ product: 'Real-Time Alert', action: 'SELL SOME', date: '2026-09-22', bias: 'BULLISH' }]);
  assert.equal(findings[0].presentation.rows.some(row => /no remaining quantity/.test(row.text)), false);
});
test('a Real-Time Alert against a holding stands across dates until it is a month old', () => {
  const ctx = context(); ctx.holdings.positions = [{ symbol: 'CORN', quantity: 10 }];
  const event = sourceEvent('CORN'); event.marketDate = '2026-09-21'; event.publishedAt = '2026-09-21T12:00:00Z'; ctx.events = [event];
  assert.equal(evaluateResearchAttention(ctx, NOW).findings[0].severity, 'action-required');
  // A bare Sell without its report is still a published Sell against the Long.
  ctx.events = [{ ...sourceEvent('CORN'), sourceReport: undefined }];
  assert.equal(evaluateResearchAttention(ctx, NOW).findings[0].action, 'exit');
  Object.assign(event, { marketDate: '2026-08-20', publishedAt: '2026-08-20T12:00:00Z' }); ctx.events = [event];
  assert.equal(evaluateResearchAttention(ctx, NOW).findings.length, 0);
});
test('broad market commentary never becomes an Inbox finding', () => {
  const ctx = context(); ctx.documents.products = [{ product: 'the-call', publicationDate: '2026-09-22', excerpts: [
    { excerpt: 'Gamma flipped positive, improving support and reducing squeeze risk in the published market-structure assessment.', citation: cite('market') },
    { excerpt: 'The yield curve narrowed by two basis points.', citation: cite('curve') },
  ] }];
  const findings = evaluateResearchAttention(ctx, NOW).findings;
  assert.equal(findings.length, 0);
});
test('refresh timestamps, source repetitions and small weight changes do not change material identity', () => {
  const ctx = context(); addHolding(ctx); const initial = evaluateResearchAttention(ctx, NOW).findings[0];
  ctx.holdings.asOf = '2026-09-22T16:00:20Z'; ctx.holdings.currentHoldings[0].currentHolding.weightPct = 4.05;
  ctx.holdings.ruleHoldings[0].sources.trade.publishedAt = '2026-09-22T15:00:00Z';
  const repeated = evaluateResearchAttention(ctx, new Date('2026-09-22T16:00:20Z')).findings[0];
  assert.equal(repeated.id, initial.id); assert.equal(repeated.fingerprint, initial.fingerprint);
});
test('a known applicable source instruction keeps its condition across dates without backfill noise', () => {
  const ctx = context(); ctx.holdings.positions = [{ symbol: 'CORN', quantity: 10 }]; ctx.events = [sourceEvent('CORN')];
  const first = evaluateResearchAttention(ctx, NOW).findings[0]; assert.ok(first);
  const next = new Date('2026-09-23T16:00:00Z'); ctx.marketDate = '2026-09-23'; ctx.holdings.asOf = next.toISOString();
  // A standing stance needs no carried-forward finding to apply the next day.
  const retained = evaluateResearchAttention(ctx, next).findings[0];
  assert.equal(retained.id, first.id); assert.equal(retained.fingerprint, first.fingerprint); assert.equal(retained.publicationTime, first.publicationTime);
});
test('a partial Sell with only generic coaching still reduces the held Long, without inventing a case', () => {
  const ctx = context(); ctx.holdings.positions = [{ symbol: 'CORN', quantity: 10 }];
  const event = sourceEvent('CORN'); event.sourceReport.bodyText = 'Portfolio Managers should be selling-SOME of Bullish TRENDs that are green today.';
  ctx.events = [event];
  const [finding] = evaluateResearchAttention(ctx, NOW).findings;
  assert.equal(finding.action, 'trim'); assert.equal(finding.severity, 'action-required');
  assert.equal(finding.presentation.rows.some(row => row.label === 'Context'), false);
});
test('account deficits require fresh independent balance; healthy spare capacity is silent', () => {
  const ctx = context(); ctx.account = { verified: true, historyVerified: true, asOf: NOW.toISOString(), issues: ['Maintenance margin deficit: $123.00.', 'Cash-floor and reserve requirements leave no buffered capacity for additional longs.'] };
  let result = evaluateResearchAttention(ctx, NOW);
  assert.equal(result.findings.length, 1); assert.equal(result.findings[0].kind, 'account');
  assert.equal(result.findings[0].requiresFreshBalance, true); assert.equal(result.completeKinds.includes('account'), true);
  ctx.account.asOf = '2026-09-22T15:58:00Z';
  result = evaluateResearchAttention(ctx, NOW); assert.equal(result.findings.length, 0); assert.equal(result.completeKinds.includes('account'), false);
});
test('unavailable history never establishes resolution of a historic accounting discrepancy', () => {
  const ctx = context(); ctx.account = { verified: true, historyVerified: false, asOf: NOW.toISOString(), issues: [] };
  assert.equal(evaluateResearchAttention(ctx, NOW).completeKinds.includes('account'), false);
  ctx.account.verified = false; ctx.account.historyVerified = true; ctx.account.issues = ['Interest discrepancy (2026-09-21): actual $1.00 was outside the $2.00–$3.00 forecast range.'];
  const finding = evaluateResearchAttention(ctx, NOW).findings[0];
  assert.equal(finding.researchOnly, true); assert.equal(finding.requiresFreshBalance, undefined);
});
test('serialized document sections and neighbouring security catalysts cannot create an idea', () => {
  const ctx = context();
  ctx.research.bySymbol.BUXX = { directReferences: [reference('BUXX', 'Long')] };
  ctx.documents.products = [{ product: 'etf-pro', publicationDate: '2026-09-22', documents: [{ documentId: 'doc', sourceUri: url }], excerpts: [{
    citation: { ...cite('doc'), documentId: 'doc' }, excerpt: 'XLU faces deteriorating rates and tightening liquidity.\\n\\n Longs: BUXX, CLOX.\\n The current book.'
  }] }];
  assert.equal(evaluateResearchAttention(ctx, NOW).findings.length, 0);
  ctx.research.bySymbol.PBD = { directReferences: [reference('PBD', 'Short'), reference('PBD', 'Short', 'PBD (Clean Energy) faces higher rates and tightening subsidy math, and JETS (Global Airlines) has oil-cost exposure.')] };
  const idea = evaluateResearchAttention(ctx, NOW).findings[0];
  assert.equal(idea.symbol, 'PBD');
  assert.doesNotMatch(idea.presentation.rows.find(row => row.label === 'Watch').text, /oil/);
  assert.doesNotMatch(idea.presentation.rows.find(row => row.label === 'Context').text, /JETS/);
});

test('one evaluation segments repeated exact report text once while preserving each security and document citation', t => {
  const segment = Intl.Segmenter.prototype.segment;
  const segmented = [];
  t.mock.method(Intl.Segmenter.prototype, 'segment', function (value) {
    segmented.push(value);
    return segment.call(this, value);
  });
  const ctx = context();
  const lines = [
    'AAA faces accelerating earnings growth and improving demand after the new company outlook.',
    'BBB faces deteriorating earnings growth and weaker demand after the new company outlook.',
    'Gamma flipped positive, improving support and reducing squeeze risk in the published market-structure assessment.',
  ];
  const otherUrl = 'https://app.hedgeye.com/feed_items/67890';
  const documentCitation = (id, sourceUri) => ({ ...cite(id), documentId: id, sourceUri });
  ctx.documents.products = [{ product: 'etf-pro', publicationDate: '2026-09-22',
    documents: [{ documentId: 'aaa', sourceUri: url }, { documentId: 'bbb', sourceUri: otherUrl }],
    excerpts: [
      { excerpt: lines.join('\n'), citation: documentCitation('aaa', url) },
      { excerpt: lines.join('\n'), citation: documentCitation('bbb', otherUrl) },
    ] }];
  for (const [symbol, side, sourceUrl] of [['AAA', 'Long', url], ['BBB', 'Short', otherUrl], ['CCC', 'Long', 'https://app.hedgeye.com/feed_items/unmatched']]) {
    const ref = { ...reference(symbol, side), sourceUrl };
    ctx.research.bySymbol[symbol] = { directReferences: [ref, { ...ref, kind: 'position_mention' }] };
  }
  const result = evaluateResearchAttention(ctx, NOW);
  assert.deepEqual(segmented, lines, 'opportunity peers share the same exact-text parse');
  assert.deepEqual(result.findings.map(item => [item.symbol, item.action]), [
    ['AAA', 'long research idea'], ['BBB', 'short research idea'],
  ]);
  for (const [symbol, index, sourceUrl] of [['AAA', 0, url], ['BBB', 1, otherUrl]]) {
    const finding = result.findings.find(item => item.symbol === symbol);
    assert.equal(finding.presentation.rows.find(row => row.label === 'Context').text, lines[index]);
    assert.deepEqual(finding.presentation.sourceLinks[0].citation, documentCitation(symbol.toLowerCase(), sourceUrl));
  }

  segmented.length = 0;
  assert.deepEqual(evaluateResearchAttention(ctx, NOW), result, 'a later scan retains identical findings and evidence');
  assert.deepEqual(segmented, lines, 'the memo is recreated for each evaluation');

  const revised = 'AAA faces deteriorating earnings growth and weaker demand after the new company outlook.';
  ctx.documents.products[0].excerpts[0].excerpt = [revised, ...lines.slice(1)].join('\n');
  const refreshed = evaluateResearchAttention(ctx, NOW).findings.find(item => item.symbol === 'AAA');
  assert.equal(refreshed.presentation.rows.find(row => row.label === 'Context').text, revised);
  assert.notEqual(refreshed.fingerprint, result.findings[0].fingerprint, 'changed exact source text becomes new material evidence');
});

test('source actions share exact report segmentation within the scan without sharing security selection', t => {
  const segment = Intl.Segmenter.prototype.segment;
  const segmented = [];
  t.mock.method(Intl.Segmenter.prototype, 'segment', function (value) {
    segmented.push(value);
    return segment.call(this, value);
  });
  const ctx = context();
  ctx.holdings.positions = [{ symbol: 'AAA', quantity: 10 }, { symbol: 'BBB', quantity: 10 }];
  const lines = [
    'Portfolio Managers should be selling-SOME of Bullish TRENDs that are green today.',
    'AAA has rallied sharply while its growth outlook deteriorates, creating an opportunity to raise cash.',
    'BBB has rallied sharply while its earnings outlook deteriorates, creating an opportunity to raise cash.',
  ];
  ctx.events = ['AAA', 'BBB'].map(symbol => {
    const event = { ...sourceEvent(symbol), productKey: 'investing-ideas', productLabel: 'Investing Ideas' };
    event.sourceReport = { ...event.sourceReport, entityId: undefined, title: 'Sell Signal AAA and BBB', bodyText: lines.join('\n') };
    return event;
  });
  const findings = evaluateResearchAttention(ctx, NOW).findings;
  assert.deepEqual(segmented, lines);
  assert.deepEqual(findings.map(item => [item.symbol, item.action]), [['AAA', 'sell-some'], ['BBB', 'sell-some']]);
  assert.ok(findings[0].presentation.rows.find(row => row.label === 'Context').text.startsWith(lines[1]));
  assert.ok(findings[1].presentation.rows.find(row => row.label === 'Context').text.startsWith(lines[2]));
});
function changeEvent(symbol, action, side, overrides = {}) {
  return { entityType: 'security', entityId: symbol, qualityStatus: 'validated', productKey: 'investing-ideas', productLabel: 'Investing Ideas', eventType: 'position_action',
    action, positionSide: side, sourceMessageId: `msg${symbol}0001`, sourceUrl: url, marketDate: '2026-09-22', publishedAt: '2026-09-22T12:00:00Z',
    excerpt: `3 Changes: Remove ${symbol}`, value: { lrr: 336, hrr: 375 }, ...overrides };
}
test('a typed removal of a held side is action-required without report prose', () => {
  const ctx = context(); ctx.holdings.positions = [{ symbol: 'SNOW', quantity: 10 }, { symbol: 'WING', quantity: -5 }, { symbol: 'DELL', quantity: -3 }];
  ctx.events = [changeEvent('SNOW', 'REMOVE', 'LONG'), changeEvent('WING', 'REMOVE', 'SHORT'), changeEvent('DELL', 'REMOVE', 'LONG')];
  const findings = evaluateResearchAttention(ctx, NOW).findings;
  // DELL is held Short; removing it from the Long list does not oppose the book.
  assert.deepEqual(findings.map(item => item.symbol).sort(), ['SNOW', 'WING']);
  for (const finding of findings) {
    assert.equal(finding.severity, 'action-required'); assert.equal(finding.priority, 0); assert.equal(finding.kind, 'portfolio');
    assert.equal(finding.presentation.rows.find(row => row.label === 'Published range').text, '336–375');
  }
  assert.match(findings.find(item => item.symbol === 'WING').presentation.rows.find(row => row.label === 'Action').text, /removed WING \(Short\) → exit Short/);
});
test('a removal without a stated side still flags the held position', () => {
  const ctx = context(); ctx.holdings.positions = [{ symbol: 'SNOW', quantity: -10 }];
  ctx.events = [changeEvent('SNOW', 'REMOVE', undefined)];
  const [finding] = evaluateResearchAttention(ctx, NOW).findings;
  assert.equal(finding.severity, 'action-required');
  assert.match(finding.presentation.rows.find(row => row.label === 'Action').text, /side unstated/);
});
test('ETF Pro and Real-Time Alert openings on the opposite side oppose the holding; aligned adds are silent', () => {
  const ctx = context(); ctx.holdings.positions = [{ symbol: 'XLE', quantity: 10 }, { symbol: 'XLU', quantity: 10 }, { symbol: 'TSLA', quantity: -4 }];
  ctx.events = [changeEvent('XLE', 'ADD', 'SHORT', { productKey: 'etf-pro', productLabel: 'ETF Pro' }), changeEvent('XLU', 'ADD', 'LONG', { productKey: 'etf-pro', productLabel: 'ETF Pro' }),
    changeEvent('TSLA', 'BUY', undefined, { productKey: 'real-time-alert', productLabel: 'Real-Time Alert' })];
  const findings = evaluateResearchAttention(ctx, NOW).findings;
  assert.deepEqual(findings.map(item => item.symbol).sort(), ['TSLA', 'XLE']);
  const stance = symbol => findings.find(item => item.symbol === symbol).presentation.stance;
  assert.deepEqual(stance('XLE').calls, [{ product: 'ETF Pro', action: 'SHORT', date: '2026-09-22', bias: 'BEARISH' }]);
  assert.deepEqual(stance('XLE').order, { verb: 'SELL', quantity: 10, note: 'to close long' });
  assert.deepEqual(stance('TSLA').calls, [{ product: 'Real-Time Alert', action: 'LONG', date: '2026-09-22', bias: 'BULLISH' }]);
  assert.deepEqual(stance('TSLA').order, { verb: 'BUY', quantity: 4, note: 'to close short' });
});
test('a Go-Anywhere removal of a held Long is an exit alert; its aligned add is silent', () => {
  const ctx = context(); ctx.holdings.positions = [{ symbol: 'XLK', quantity: 20 }, { symbol: 'HGER', quantity: 30 }];
  const goAnywhere = { productKey: 'go-anywhere', productLabel: 'Go-Anywhere Portfolio', entityType: 'ticker', eventType: 'position_change' };
  ctx.events = [changeEvent('XLK', 'REMOVE', 'LONG', goAnywhere), changeEvent('HGER', 'ADD', 'LONG', goAnywhere)];
  const findings = evaluateResearchAttention(ctx, NOW).findings;
  assert.deepEqual(findings.map(item => [item.symbol, item.severity]), [['XLK', 'action-required']]);
  assert.equal(findings[0].presentation.rows.find(row => row.label === 'Action').text, 'Go-Anywhere Portfolio removed XLK (Long) → exit Long');
});
test('Signal Strength removals apply to held longs only', () => {
  const ctx = context(); ctx.holdings.positions = [{ symbol: 'NVDA', quantity: 10 }, { symbol: 'AMD', quantity: -10 }];
  const removal = symbol => changeEvent(symbol, undefined, undefined, { productKey: 'signal-strength', productLabel: 'Signal Strength', eventType: 'signal_strength_removed', excerpt: symbol });
  ctx.events = [removal('NVDA'), removal('AMD')];
  assert.deepEqual(evaluateResearchAttention(ctx, NOW).findings.map(item => item.symbol), ['NVDA']);
});
test('a Signal Strength Shorts addition opposes a held long; its removal exits a held short', () => {
  const ctx = context(); ctx.holdings.positions = [{ symbol: 'JPM', quantity: 10 }, { symbol: 'SMCI', quantity: -5 }, { symbol: 'DECK', quantity: -5 }, { symbol: 'ZG', quantity: 5 }];
  const shorts = (symbol, eventType) => changeEvent(symbol, undefined, undefined, { productKey: 'signal-strength', productLabel: 'Signal Strength', eventType, excerpt: symbol });
  ctx.events = [shorts('JPM', 'signal_strength_short_added'), shorts('SMCI', 'signal_strength_short_added'),
    shorts('DECK', 'signal_strength_short_removed'), shorts('ZG', 'signal_strength_short_removed')];
  const findings = evaluateResearchAttention(ctx, NOW).findings;
  assert.deepEqual(findings.map(item => [item.symbol, item.severity]).sort(), [['DECK', 'action-required'], ['JPM', 'action-required']]);
  assert.deepEqual(findings.find(item => item.symbol === 'JPM').presentation.stance.calls, [{ product: 'Signal Strength Shorts', action: 'SHORT', date: '2026-09-22', bias: 'BEARISH' }]);
  assert.deepEqual(findings.find(item => item.symbol === 'DECK').presentation.stance.calls, [{ product: 'Signal Strength Shorts', action: 'REMOVE', date: '2026-09-22', bias: 'NEUTRAL' }]);
});
// The central security record (/api/security-universe identity) as the scan passes it in.
const identityRecord = displayName => ({ identity: { status: 'available', displayName: { status: 'available', value: displayName, source: 'Yahoo Finance instrument metadata', asOf: '2026-09-22T12:00:00Z', reason: null } } });
test('stance cards name every security from the security record, including ETF Pro, alert and removed tickers', () => {
  const ctx = context();
  ctx.holdings.positions = ['DRAM', 'LULU', 'COST', 'GS', 'ASTS'].map(symbol => ({ symbol, quantity: 10 }));
  const etf = { productKey: 'etf-pro', productLabel: 'ETF Pro' };
  ctx.events = [changeEvent('DRAM', 'REMOVE', 'LONG', etf),
    changeEvent('LULU', undefined, undefined, { productKey: 'signal-strength', productLabel: 'Signal Strength', eventType: 'signal_strength_removed', excerpt: 'LULU' }),
    changeEvent('COST', 'ADD', 'SHORT', etf), changeEvent('GS', 'ADD', 'SHORT', etf),
    changeEvent('ASTS', 'SELL', undefined, { productKey: 'real-time-alert', productLabel: 'Real-Time Alert' })];
  ctx.securities = { DRAM: identityRecord('Roundhill Memory ETF'), LULU: identityRecord('lululemon athletica inc.'),
    COST: identityRecord('Costco Wholesale Corporation'), GS: identityRecord('The Goldman Sachs Group, Inc.'), ASTS: identityRecord('AST SpaceMobile, Inc.') };
  const names = Object.fromEntries(evaluateResearchAttention(ctx, NOW).findings.filter(item => item.presentation.stance)
    .map(item => [item.symbol, item.presentation.stance.name]));
  assert.deepEqual(names, { DRAM: 'Roundhill Memory ETF', LULU: 'lululemon athletica inc.', COST: 'Costco Wholesale Corporation',
    GS: 'The Goldman Sachs Group, Inc.', ASTS: 'AST SpaceMobile, Inc.' });
});
test('a roster name stands in only while the security record has no identity', () => {
  const ctx = context();
  ctx.holdings.positions = [{ symbol: 'JPM', quantity: 10 }, { symbol: 'EFX', quantity: 10 }];
  const roster = symbol => changeEvent(symbol, undefined, undefined, { productKey: 'signal-strength', productLabel: 'Signal Strength', entityType: 'ticker',
    eventType: 'signal_strength_short_membership', fieldPath: 'data.shorts.stocks[0]', excerpt: JSON.stringify({ ticker: symbol, side: 'short', name: `${symbol} roster name`, entryDate: '2026-09-22' }) });
  ctx.events = [roster('JPM'), roster('EFX')];
  ctx.securities = { JPM: identityRecord('JPMorgan Chase & Co.'), EFX: { identity: { status: 'unavailable', displayName: { status: 'unavailable', value: null, reason: 'identity-directory-unavailable' } } } };
  const names = Object.fromEntries(evaluateResearchAttention(ctx, NOW).findings.map(item => [item.symbol, item.presentation.stance?.name]));
  assert.deepEqual(names, { JPM: 'JPMorgan Chase & Co.', EFX: 'EFX roster name' });
});
test('a later re-add from the same product supersedes its removal', () => {
  const ctx = context(); ctx.holdings.positions = [{ symbol: 'SNOW', quantity: 10 }];
  ctx.events = [changeEvent('SNOW', 'REMOVE', 'LONG'), changeEvent('SNOW', 'ADD', 'LONG', { publishedAt: '2026-09-22T14:00:00Z' })];
  assert.equal(evaluateResearchAttention(ctx, NOW).findings.length, 0);
});
test('Trade and Trend breaks are action-required; sizing breaches are not', () => {
  const ctx = context(); addHolding(ctx);
  const [finding] = evaluateResearchAttention(ctx, NOW).findings;
  assert.equal(finding.severity, 'action-required');
  // Aligned signals with weight above MAX are a sizing review, not a contrary source.
  const sizing = context(); addHolding(sizing);
  Object.assign(sizing.holdings.ruleHoldings[0], { trade: 'BULLISH', trend: 'BULLISH', weightPct: 40 });
  sizing.holdings.currentHoldings[0].currentHolding.weightPct = 40;
  for (const item of evaluateResearchAttention(sizing, NOW).findings) assert.equal(item.severity, undefined);
});
test('unverified holdings never raise an Alert; today’s exits and removals wait in one notice', () => {
  const ctx = context(); ctx.holdings.liveVerified = false;
  ctx.events = [changeEvent('SNOW', 'REMOVE', 'LONG'), changeEvent('WING', 'REMOVE', 'SHORT'), changeEvent('XLE', 'ADD', 'SHORT', { productKey: 'etf-pro' })];
  const findings = evaluateResearchAttention(ctx, NOW).findings;
  assert.equal(findings.some(item => item.severity === 'action-required'), false);
  assert.equal(findings.length, 1);
  const [notice] = findings;
  assert.equal(notice.kind, 'operational'); assert.equal(notice.assessmentChannel, 'research');
  assert.deepEqual(notice.pendingHoldingsCheck, { marketDate: '2026-09-22', symbols: ['SNOW', 'WING'], checked: [] });
  assert.equal(notice.presentation.rows.find(item => item.label === 'Pending').text, 'SNOW, WING');
  assert.doesNotMatch(JSON.stringify(notice.presentation.rows), /confirm/i);
  ctx.holdings.liveVerified = true;
  assert.equal(evaluateResearchAttention(ctx, NOW).findings.some(item => item.kind === 'operational'), false);
});
test('a checked removal is not raised again when holdings drop out later the same day', () => {
  const ctx = context(); ctx.holdings.liveVerified = false;
  ctx.events = [changeEvent('SNOW', 'REMOVE', 'LONG')];
  const [notice] = evaluateResearchAttention(ctx, NOW).findings;
  // A verified scan resolved the notice; Gateway then flaps.
  ctx.previousAttention = [{ ...notice, state: 'resolved' }];
  assert.deepEqual(evaluateResearchAttention(ctx, NOW).findings, []);
  // Only a new removal is pending, and the checked one is carried forward.
  ctx.events.push(changeEvent('WING', 'REMOVE', 'SHORT'));
  const [next] = evaluateResearchAttention(ctx, NOW).findings;
  assert.deepEqual(next.pendingHoldingsCheck, { marketDate: '2026-09-22', symbols: ['WING'], checked: ['SNOW'] });
  assert.equal(next.severity, undefined);
  // Notices saved before the check was recorded were resolved by a verified scan.
  ctx.previousAttention = [{ ...notice, pendingHoldingsCheck: undefined, state: 'resolved' }];
  assert.deepEqual(evaluateResearchAttention(ctx, NOW).findings, []);
});
test('once holdings verify, a pending removal alerts only for a position actually held, even on a later date', () => {
  const ctx = context(); ctx.holdings.liveVerified = false;
  ctx.events = [changeEvent('SNOW', 'REMOVE', 'LONG', { productKey: 'etf-pro', productLabel: 'ETF Pro' }), changeEvent('WING', 'REMOVE', 'SHORT'), changeEvent('DELL', 'REMOVE', 'LONG')];
  const [notice] = evaluateResearchAttention(ctx, NOW).findings;
  // Holdings return on the next market date: SNOW is held Long, DELL is held Short, WING is not held.
  const later = new Date('2026-09-23T16:00:00Z');
  Object.assign(ctx, { marketDate: '2026-09-23', previousAttention: [{ ...notice, state: 'open' }] });
  Object.assign(ctx.holdings, { liveVerified: true, asOf: later.toISOString(), positions: [{ symbol: 'SNOW', quantity: 12 }, { symbol: 'DELL', quantity: -3 }] });
  const findings = evaluateResearchAttention(ctx, later).findings;
  assert.deepEqual(findings.map(item => item.symbol), ['SNOW']);
  const [alert] = findings;
  assert.equal(alert.severity, 'action-required'); assert.equal(alert.kind, 'portfolio');
  assert.equal(alert.holdingsVerified, true); assert.equal(alert.quantity, 12);
  const rows = Object.fromEntries(alert.presentation.rows.map(item => [item.label, item.text]));
  assert.equal(rows['Current position'], 'Long');
  assert.equal(rows['ETF Pro'], 'REMOVE Sep 22 · NEUTRAL');
  assert.deepEqual(alert.presentation.stance.target, { side: null, quantity: 0, weightPct: 0 });
  assert.deepEqual(alert.presentation.sourceLinks.map(link => link.label), ['ETF Pro']);
  // The ETF Pro removal is a standing stance; an Investing Ideas removal still needs the pending notice.
  ctx.previousAttention = [];
  assert.deepEqual(evaluateResearchAttention(ctx, later).findings.map(item => item.symbol), ['SNOW']);
});
test('a Trend-break sizing alert states the security\'s own MIN, MAX, ATR, stop and trim', () => {
  const ctx = context(); addHolding(ctx, 'XLK');
  const metric = (value, observations) => ({ value, observations, status: 'available', source: 'Yahoo Finance chart API', asOf: '2026-09-21' });
  ctx.holdings.currentHoldings[0].currentHolding.weightPct = 4.25;
  // ATR 3.70 on 185 is 2% of price: 4% stop distance → MIN roundUp(3.125) = 3.25%, MAX 6.25%, stop 185 − 2 × 3.70 = 177.60.
  Object.assign(ctx.holdings.ruleHoldings[0], { trade: null, trend: 'NEUTRAL', weightPct: 4.25,
    sizingInputs: { beta: metric(1.767428, 252), atr14: metric(3.7, 14), referencePrice: metric(185, 1) } });
  const [finding] = evaluateResearchAttention(ctx, NOW).findings;
  const rows = Object.fromEntries(finding.presentation.rows.map(item => [item.label, item.text]));
  assert.equal(finding.state === 'open' && finding.rule.rule, 'TREND_BREAK');
  assert.equal(rows['Process limits'], 'MIN 3.25% / MAX 6.25%');
  assert.equal(rows.ATR, '2.00% of price');
  // 4.25% × 4% stop distance = 0.17% of NLV.
  assert.equal(rows.Stop, '177.60 · 2 × ATR from last close · 0.17% of NLV at this weight');
  for (const removed of ['Beta', 'Sizing basis', 'ATR cap']) assert.equal(rows[removed], undefined);
  assert.equal(rows.Action, 'Reduce to MIN 3.25%');
  assert.equal(rows.Trim, '1.00 pts (4.25% → 3.25%)');
  assert.ok(finding.presentation.rows.find(item => item.label === 'Trim').requiresFreshHoldings);
  // 10 shares at 4.25% → 3.25% keeps 7.65 shares.
  assert.equal(rows.Order, 'Sell 2.35 shares');
  assert.ok(finding.presentation.rows.find(item => item.label === 'Order').requiresFreshHoldings);
  assert.deepEqual(finding.presentation.rows.slice(-4), [['Tick', 'N/A'], ['Trade', 'N/A'], ['Trend', 'Neutral'], ['Tail', 'N/A']].map(([label, text]) => ({ label, text })));
});
test('a quiet security notes the ATR floor, and an ATR too large to size exits', () => {
  const metric = (value, observations) => ({ value, observations, status: 'available', source: 'Yahoo Finance chart API', asOf: '2026-09-21' });
  const quiet = context(); addHolding(quiet, 'XLU');
  quiet.holdings.currentHoldings[0].currentHolding.weightPct = 6;
  // ATR 1.85 on 185 is 1% of price, below the 1.25% floor: MIN 5%, MAX 10%; the stop keeps the measured ATR (185 − 3.70).
  Object.assign(quiet.holdings.ruleHoldings[0], { trade: null, trend: 'NEUTRAL', weightPct: 6,
    sizingInputs: { atr14: metric(1.85, 14), referencePrice: metric(185, 1) } });
  const quietRows = Object.fromEntries(evaluateResearchAttention(quiet, NOW).findings[0].presentation.rows.map(item => [item.label, item.text]));
  assert.equal(quietRows['Process limits'], 'MIN 5.00% / MAX 10.00%');
  assert.equal(quietRows.ATR, '1.00% of price (1.25% floor sets the band)');
  assert.equal(quietRows.Stop, '181.30 · 2 × ATR from last close · 0.12% of NLV at this weight');
  assert.equal(quietRows.Action, 'Reduce to MIN 5.00%');
  const wild = context(); addHolding(wild, 'WILD');
  // ATR 111 on 185 is 60% of price: MIN rounds up to 0.25% while MAX rounds down to 0, so the position cannot be sized.
  Object.assign(wild.holdings.ruleHoldings[0], { trade: 'BULLISH', trend: 'BULLISH',
    sizingInputs: { atr14: metric(111, 14), referencePrice: metric(185, 1) } });
  const [finding] = evaluateResearchAttention(wild, NOW).findings;
  const rows = Object.fromEntries(finding.presentation.rows.map(item => [item.label, item.text]));
  assert.equal(finding.state === 'open' && finding.rule.rule, 'RISK_CAP');
  assert.equal(finding.action, 'exit');
  assert.equal(rows['Process limits'], 'MIN 0.25% / MAX 0.00%');
  assert.equal(rows.ATR, '60.00% of price');
  assert.equal(rows.Stop, undefined);
  assert.equal(rows.Context, 'Too volatile to size → exit.');
  assert.equal(rows.Order, 'Sell 10 shares');
  assert.deepEqual(finding.presentation.sourceLinks.map(link => link.label), ['Trade source', 'Trend source', 'atr14 evidence', 'referencePrice evidence']);
});
test('a published Tick fills the Tick line; a stale or future one stays N/A', () => {
  for (const [tick, expected] of [[{ value: 'BEARISH', status: 'published', publishedAt: '2026-09-22T13:00:00Z' }, 'Bearish'],
    [{ value: 'BULLISH', status: 'historical', publishedAt: '2026-09-22T13:00:00Z' }, 'N/A'],
    [{ value: 'BULLISH', status: 'published', publishedAt: '2026-09-23T13:00:00Z' }, 'N/A']]) {
    const ctx = context(); addHolding(ctx); ctx.holdings.ruleHoldings[0].tick = tick;
    const [finding] = evaluateResearchAttention(ctx, NOW).findings;
    assert.equal(finding.presentation.rows.find(item => item.label === 'Tick').text, expected);
    assert.equal(finding.presentation.rows.find(item => item.label === 'Trade').text, 'Bearish');
  }
});
// RTA / ETF Pro list membership stands in for an unstated Trade and Trend.
const durations = finding => Object.fromEntries(finding.presentation.rows.filter(item => ['Tick', 'Trade', 'Trend', 'Tail'].includes(item.label))
  .map(item => [item.label, item.basis ? `${item.text} (${item.basis})` : item.text]));
const etfPro = { productKey: 'etf-pro', productLabel: 'ETF Pro' };
test('a current Long listing reads bullish Trade and Trend, inferred; Tick and Tail stay N/A', () => {
  const ctx = context(); ctx.holdings.positions = [{ symbol: 'XLU', quantity: -10 }];
  ctx.events = [changeEvent('XLU', 'ADD', 'LONG', etfPro)];
  const [finding] = evaluateResearchAttention(ctx, NOW).findings;
  assert.deepEqual(durations(finding), { Tick: 'N/A', Trade: 'Bullish (inferred)', Trend: 'Bullish (inferred)', Tail: 'N/A' });
  assert.equal(finding.presentation.rows.find(item => item.label === 'Trade').note, 'Inferred from list membership (ETF Pro LONG Sep 22); not stated by the source');
});
test('a current Short listing reads bearish Trade and Trend, inferred', () => {
  const ctx = context(); ctx.holdings.positions = [{ symbol: 'TSLA', quantity: 4 }];
  ctx.events = [changeEvent('TSLA', 'SHORT', undefined, { productKey: 'real-time-alert', productLabel: 'Real-Time Alert' })];
  const [finding] = evaluateResearchAttention(ctx, NOW).findings;
  assert.deepEqual(durations(finding), { Tick: 'N/A', Trade: 'Bearish (inferred)', Trend: 'Bearish (inferred)', Tail: 'N/A' });
});
test('a removal clears the inferred Trade and Trend instead of carrying the listing over', () => {
  const ctx = context(); ctx.holdings.positions = [{ symbol: 'HYP', quantity: 150 }];
  ctx.events = [changeEvent('HYP', 'ADD', 'LONG', { ...etfPro, marketDate: '2026-09-21', publishedAt: '2026-09-21T12:00:00Z' }), changeEvent('HYP', 'REMOVE', 'LONG', etfPro)];
  const [finding] = evaluateResearchAttention(ctx, NOW).findings;
  assert.deepEqual(durations(finding), { Tick: 'N/A', Trade: 'N/A (removed)', Trend: 'N/A (removed)', Tail: 'N/A' });
  assert.equal(finding.presentation.rows.find(item => item.label === 'Trend').note, 'ETF Pro REMOVE Sep 22: Trade and/or Trend broke; which is not stated');
});
test('each scan reads the latest list state: removal, then a flip to Short', () => {
  const ctx = context(); ctx.holdings.positions = [{ symbol: 'XLE', quantity: 10 }];
  const day = (date, action, side) => changeEvent('XLE', action, side, { ...etfPro, marketDate: date, publishedAt: `${date}T12:00:00Z`, sourceMessageId: `msgXLE${date}${side}` });
  const removed = foldStanceEvents(null, [day('2026-09-20', 'ADD', 'LONG'), day('2026-09-21', 'REMOVE', 'LONG')], NOW).book;
  const [before] = evaluateResearchAttention({ ...ctx, stanceBook: removed }, NOW).findings;
  assert.equal(durations(before).Trade, 'N/A (removed)');
  const [after] = evaluateResearchAttention({ ...ctx, stanceBook: removed, events: [day('2026-09-22', 'ADD', 'SHORT')] }, NOW).findings;
  assert.equal(after.id, before.id);
  assert.deepEqual([durations(after).Trade, durations(after).Trend], ['Bearish (inferred)', 'Bearish (inferred)']);
});
test('a newer explicit reading overrides the listing; an older one loses to it', () => {
  const ctx = context(); ctx.holdings.positions = [{ symbol: 'XLU', quantity: -10 }];
  ctx.events = [changeEvent('XLU', 'ADD', 'LONG', etfPro)];
  // Listed Long at 12:00; Trade restated Bearish at 15:00, Trend last stated at 11:00.
  ctx.holdings.ruleHoldings.push({ holding: 'XLU', quantity: -10, heldSide: 'SHORT', trade: 'BEARISH', trend: 'BEARISH', weightPct: 4,
    signalContext: { trade: { status: 'published' }, trend: { status: 'published' } },
    sources: { trade: { publishedAt: '2026-09-22T15:00:00Z', citation: cite('trade') }, trend: { publishedAt: '2026-09-22T11:00:00Z', citation: cite('trend') } } });
  const finding = evaluateResearchAttention(ctx, NOW).findings.find(item => item.symbol === 'XLU' && item.presentation.stance);
  assert.deepEqual([durations(finding).Trade, durations(finding).Trend], ['Bearish', 'Bullish (inferred)']);
});

const alphaLine = (symbol, label, duration, level, side, breaks = [], extra = {}) => ({ id: `${symbol}|${duration}`, symbol, label, market: 'wti', duration, level,
  product: 'early-look', productLabel: 'Early Look', marketDate: '2026-09-22', messageId: '1a18c949d0c80bdd', excerpt: `${label} Alpha Code`, side, breaks,
  since: breaks.at(-1)?.at || '2026-09-22T10:00:00Z', reading: null, ...extra });
const alphaWatch = (...lines) => ({ version: 1, marketDate: '2026-09-22', lines: Object.fromEntries(lines.map(line => [line.id, line])) });
const bullish = { value: 'BULLISH', date: '2026-09-01', source: 'The Call' };
test('a broken Alpha Code line is a notification naming the line and the price, and its call reads Neutral until reclaimed', () => {
  const ctx = context();
  ctx.alphaCodeWatch = alphaWatch(alphaLine('CL=F', 'WTI', 'trade', 97, 'below', [{ from: 'above', to: 'below', price: 96.85, at: '2026-09-22T14:40:00Z' }], { reading: bullish }),
    alphaLine('CL=F', 'WTI', 'trend', 91, 'above', [], { reading: bullish }));
  const card = evaluateResearchAttention(ctx, NOW).findings.find(item => item.action.includes('line'));
  assert.equal(card.kind, 'market');
  assert.equal(card.severity, undefined);
  assert.equal(card.presentation.subject, 'WTI');
  assert.deepEqual(card.presentation.rows.map(item => [item.label, item.text]), [
    ['Trade line', 'Broke 97 at 96.85 (07:40 PDT) → Trade neutral'], ['Tick', 'N/A'], ['Trade', 'Neutral'], ['Trend', 'Bullish'], ['Tail', 'N/A']]);
  assert.equal(card.presentation.rows[2].basis, 'inferred');
  assert.match(card.presentation.rows[2].note, /below the Early Look Trade line 97 since 07:40 PDT: the Bullish Trade reads Neutral until the price is back on its side; inferred/);
  assert.deepEqual(card.presentation.sourceLinks.map(link => [link.label, link.citation.title, link.citation.sourceMessageId, link.citation.clipTicker]),
    [['Early Look Alpha Code', 'Early Look: WTI Alpha Code', '1a18c949d0c80bdd', 'WTI']]);
  // A reclaim lists the break before it, each at its own time, and restores the published call.
  const trade = ctx.alphaCodeWatch.lines['CL=F|trade'];
  trade.breaks.push({ from: 'below', to: 'above', price: 97.17, at: '2026-09-22T14:56:32Z' });
  Object.assign(trade, { side: 'above', since: '2026-09-22T14:56:32Z' });
  const reclaimed = evaluateResearchAttention(ctx, NOW).findings.find(item => item.action.includes('line')).presentation.rows;
  assert.deepEqual([reclaimed[0].text, reclaimed[2].text], ['Reclaimed 97 at 97.17 (07:56 PDT) → Trade bullish\nBroke 97 at 96.85 (07:40 PDT)', 'Bullish']);
  // With no published call a cross implies no direction: Neutral.
  Object.assign(trade, { side: 'below', since: '2026-09-22T15:10:00Z', reading: null });
  assert.match(evaluateResearchAttention(ctx, NOW).findings.find(item => item.action.includes('line')).presentation.rows[0].text, /^[^\n]* → Trade neutral\n/);
  // An unbroken watch raises nothing.
  ctx.alphaCodeWatch = alphaWatch(alphaLine('CL=F', 'WTI', 'trade', 97, 'above'));
  assert.equal(evaluateResearchAttention(ctx, NOW).findings.some(item => item.action.includes('line')), false);
});

test('a held security’s own line breaking against the position is red', () => {
  const ctx = context();
  addHolding(ctx, 'USO', 'LONG');
  ctx.holdings.ruleHoldings[0].trade = 'BULLISH';
  ctx.alphaCodeWatch = alphaWatch(alphaLine('USO', 'USO', 'trade', 88, 'below', [{ from: 'above', to: 'below', price: 87.5, at: '2026-09-22T14:40:00Z' }]));
  const card = evaluateResearchAttention(ctx, NOW).findings.find(item => item.action.includes('line'));
  assert.equal(card.kind, 'portfolio');
  assert.equal(card.severity, 'action-required');
  assert.deepEqual(card.presentation.rows.map(item => [item.label, item.text]).slice(0, 4), [
    ['Current position', 'Long'], ['Position size', '4.00%'], ['Trade line', 'Broke 88 at 87.5 (07:40 PDT) → Trade neutral'], ['Context', 'USO broke Trade 88 at 87.5 vs Long → exit.']]);
});

test('a published reading whose line the price crossed after it reads Neutral on the security’s other cards', () => {
  const ctx = context();
  addHolding(ctx, 'USO', 'LONG');
  // Published Bearish Trade at 12:00 opposes the Long; USO then crosses above its Trade line at 14:40.
  ctx.alphaCodeWatch = alphaWatch(alphaLine('USO', 'USO', 'trade', 88, 'above', [{ from: 'below', to: 'above', price: 88.4, at: '2026-09-22T14:40:00Z' }]));
  const tradeOf = () => evaluateResearchAttention(ctx, NOW).findings.find(item => item.state === 'open' && item.action === 'exit')
    .presentation.rows.find(item => item.label === 'Trade');
  assert.deepEqual([tradeOf().text, tradeOf().basis], ['Neutral', 'inferred']);
  // A cross older than the published reading leaves the reading.
  ctx.alphaCodeWatch.lines['USO|trade'].since = '2026-09-22T11:00:00Z';
  assert.equal(tradeOf().text, 'Bearish');
  // A price on the reading's own side confirms it.
  Object.assign(ctx.alphaCodeWatch.lines['USO|trade'], { side: 'below', since: '2026-09-22T14:40:00Z' });
  assert.deepEqual([tradeOf().text, tradeOf().basis], ['Bearish', undefined]);
});

const cross = (from, to, price) => ({ from, to, price, at: '2026-09-22T14:40:00Z' });
const printed = (symbol, label, duration, level, extra) => alphaLine(symbol, label, duration, level, 'above', [], { printedDate: '2026-09-22', ...extra });
const signals = ctx => evaluateResearchAttention(ctx, NOW).findings.flatMap(item => item.presentation.rows.filter(row => row.label === 'Signal').map(row => row.text));

test('a new Alpha Code and a moved level each notify in one line', () => {
  const ctx = context();
  ctx.alphaCodeWatch = alphaWatch(printed('^KS11', 'KOSPI', 'trade', 6265, { isNew: true, scope: 'market' }), printed('^KS11', 'KOSPI', 'trend', 7051, { isNew: true, scope: 'market' }));
  assert.deepEqual(signals(ctx), ['KOSPI Alpha Code 6,265/7,051 → watching Trade 6,265, Trend 7,051.']);
  ctx.alphaCodeWatch = alphaWatch(printed('CL=F', 'WTI', 'trade', 97, { scope: 'market' }), printed('CL=F', 'WTI', 'trend', 92, { scope: 'market', change: { from: 91, to: 92 } }));
  assert.deepEqual(signals(ctx), ['WTI Alpha Code 97/91 → 97/92: Trend line 91 → 92.']);
  // A single printed level has no code to quote and keeps its unit.
  ctx.alphaCodeWatch = alphaWatch(printed('UST10Y', 'UST 10Y', 'trend', 4.91, { scope: 'market', unit: '%', change: { from: 4.85, to: 4.91 } }));
  assert.deepEqual(signals(ctx), ['UST 10Y Alpha Code: Trend line 4.85% → 4.91%.']);
});

test('an unheld single stock is watched silently; held, it notifies', () => {
  const ctx = context();
  ctx.alphaCodeWatch = alphaWatch(alphaLine('NVDA', 'NVDA', 'trade', 221, 'below', [cross('above', 'below', 219)], { printedDate: '2026-09-22', isNew: true, scope: 'security' }));
  assert.deepEqual(evaluateResearchAttention(ctx, NOW).findings.filter(item => item.symbol === 'NVDA'), []);
  addHolding(ctx, 'NVDA', 'LONG');
  const cards = evaluateResearchAttention(ctx, NOW).findings.filter(item => item.symbol === 'NVDA' && /line|alpha code/.test(item.action));
  assert.deepEqual(cards.map(card => card.severity).sort(), ['action-required', undefined].sort());
});

test('a one-for-one fund makes a market line break red, with the side reversed for yields', () => {
  const ctx = context();
  addHolding(ctx, 'EWY', 'LONG');
  ctx.alphaCodeWatch = alphaWatch(alphaLine('^KS11', 'KOSPI', 'trade', 6265, 'below', [cross('above', 'below', 6200)], { printedDate: '2026-09-22', scope: 'market' }));
  let card = evaluateResearchAttention(ctx, NOW).findings.find(item => item.action.includes('line'));
  assert.equal(card.severity, 'action-required');
  assert.deepEqual(card.presentation.rows.filter(row => ['Held via', 'Context'].includes(row.label)).map(row => row.text), ['EWY', 'KOSPI broke Trade 6,265 at 6,200 vs Long EWY → exit.']);
  const rates = context();
  addHolding(rates, 'ZROZ', 'LONG');
  rates.alphaCodeWatch = alphaWatch(alphaLine('UST10Y', 'UST 10Y', 'trend', 4.91, 'above', [cross('below', 'above', 4.95)], { printedDate: '2026-09-22', scope: 'market', unit: '%' }));
  card = evaluateResearchAttention(rates, NOW).findings.find(item => item.action.includes('line'));
  assert.equal(card.severity, 'action-required');
  assert.equal(card.presentation.rows.find(row => row.label === 'Context').text, 'UST 10Y broke Trend 4.91% at 4.95% vs Long ZROZ → reduce to MIN.');
  // Yields falling is the Long's side: no red.
  rates.alphaCodeWatch = alphaWatch(alphaLine('UST10Y', 'UST 10Y', 'trend', 4.91, 'below', [cross('above', 'below', 4.85)], { printedDate: '2026-09-22', scope: 'market', unit: '%' }));
  assert.equal(evaluateResearchAttention(rates, NOW).findings.find(item => item.action.includes('line')).severity, undefined);
});

test('a line printed days ago still notifies but cannot demand an exit', () => {
  const ctx = context();
  addHolding(ctx, 'USO', 'LONG');
  ctx.alphaCodeWatch = alphaWatch(alphaLine('USO', 'USO', 'trade', 88, 'below', [cross('above', 'below', 87.5)], { printedDate: '2026-09-15' }));
  const card = evaluateResearchAttention(ctx, NOW).findings.find(item => item.action.includes('line'));
  assert.equal(card.severity, undefined);
  assert.equal(card.kind, 'market');
});

test('the flip line notifies when printed, changed and crossed in either direction', () => {
  const ctx = context();
  const flip = (extra, side = 'above', breaks = []) => ({ id: '^GSPC|flip', symbol: '^GSPC', label: 'SPX', duration: 'flip', level: 7713, marketDate: '2026-09-22', printedDate: '2026-09-22', product: 'top-3-things', productLabel: 'Top 3 Things', scope: 'market', side, breaks, ...extra });
  ctx.alphaCodeWatch = alphaWatch(flip({ change: { from: 7726, to: 7713 } }));
  assert.deepEqual(signals(ctx), ['SPX flip line 7,726 → 7,713.']);
  ctx.alphaCodeWatch = alphaWatch(flip({ isNew: true }));
  assert.deepEqual(signals(ctx), ['SPX flip line 7,713.']);
  ctx.alphaCodeWatch = alphaWatch(flip({}, 'below', [cross('above', 'below', 7700)]));
  assert.deepEqual(signals(ctx), ['SPX below flip line 7,713 → short gamma: respect breakouts, widen stops.']);
  ctx.alphaCodeWatch = alphaWatch(flip({}, 'above', [cross('above', 'below', 7700), { ...cross('below', 'above', 7725), at: '2026-09-22T15:40:00Z' }]));
  assert.deepEqual(signals(ctx), ['SPX above flip line 7,713 → long gamma: fade first touches.']);
  assert.equal(evaluateResearchAttention(ctx, NOW).findings[0].kind, 'market');
});

test('a PV band cross reads the gamma regime', () => {
  const ctx = context();
  const band = (duration, level, breaks) => ({ id: `^GSPC|${duration}`, symbol: '^GSPC', label: 'SPX', duration, level, marketDate: '2026-09-22', printedDate: '2026-09-22', product: 'market-structure', productLabel: 'Market Structure', side: breaks.at(-1).to, breaks });
  ctx.alphaCodeWatch = { ...alphaWatch(band('pvLower', 7549, [cross('above', 'below', 7540)])), regime: { date: '2026-09-01', tiles: { spxGammaExposure: 'Negative' }, changes: [] } };
  assert.deepEqual(signals(ctx), ['SPX through lower PV band 7,549 in short gamma → respect the break.']);
  ctx.alphaCodeWatch = { ...alphaWatch(band('pvUpper', 7850, [cross('below', 'above', 7860)])), regime: { date: '2026-09-01', tiles: { spxGammaExposure: 'Positive' }, changes: [] } };
  assert.deepEqual(signals(ctx), ['SPX through upper PV band 7,850 in long gamma → fade the first touch.']);
  ctx.alphaCodeWatch = alphaWatch(band('pvLower', 7549, [cross('below', 'above', 7560)]));
  assert.deepEqual(signals(ctx), ['SPX back inside lower PV band 7,549.']);
});

test('a VIX bucket cross names the bucket it entered, in either direction', () => {
  const ctx = context();
  const vix = (level, breaks) => ({ id: `^VIX|${level}`, symbol: '^VIX', label: 'VIX', duration: 'vix', level, marketDate: '2026-09-22', side: breaks.at(-1).to, breaks,
    above: { name: level === 19 ? 'Chop' : 'F Bucket', posture: level === 19 ? 'trade ranges / reduce conviction' : 'defensive / preserve capital' }, below: { name: level === 19 ? 'Investable' : 'Chop', posture: level === 19 ? 'buy dips / normal risk' : 'trade ranges / reduce conviction' } });
  ctx.alphaCodeWatch = alphaWatch(vix(19, [cross('below', 'above', 19.4)]));
  assert.deepEqual(signals(ctx), ['VIX above 19 → Chop: trade ranges, reduce conviction.']);
  ctx.alphaCodeWatch = alphaWatch(vix(29, [cross('above', 'below', 28.5)]));
  assert.deepEqual(signals(ctx), ['VIX below 29 → Chop: trade ranges, reduce conviction.']);
  // The latest cross across both lines is the card.
  ctx.alphaCodeWatch = alphaWatch(vix(19, [{ ...cross('below', 'above', 19.4), at: '2026-09-22T13:00:00Z' }]), vix(29, [cross('below', 'above', 29.5)]));
  assert.deepEqual(signals(ctx), ['VIX above 29 → F Bucket: defensive, preserve capital.']);
});

const regimeWatch = (regime) => ({ ...alphaWatch(), marketDate: '2026-09-22', regime: { date: '2026-09-22', tiles: {}, changes: [], ...regime } });
test('each Market Structure tile change is one line with the process action', () => {
  const ctx = context();
  ctx.alphaCodeWatch = regimeWatch({ tiles: { spxGammaExposure: 'Negative' }, gammaThrottle: -3.07, changes: [
    { id: 'spxGammaExposure', from: 'Neutral', to: 'Negative' }, { id: 'systematicFlowRisk', from: 'Bullish', to: 'Bearish' }, { id: 'pvBandRiskReward', from: 'Neutral', to: 'Long' }] });
  assert.deepEqual(signals(ctx).sort(), ['PV band risk/reward Neutral → Long.', 'SPX gamma Neutral → Negative → wider ranges; respect breakouts.', 'Systematic flow Bullish → Bearish → expect selling on breakdowns.'].sort());
  const gamma = evaluateResearchAttention(ctx, NOW).findings.find(item => item.action === 'spx gamma change');
  assert.equal(gamma.presentation.rows.find(row => row.label === 'Gamma throttle').text, '-3.07');
  assert.equal(gamma.kind, 'market');
  // A tile change two sessions old has passed.
  ctx.alphaCodeWatch = { ...ctx.alphaCodeWatch, regime: { ...ctx.alphaCodeWatch.regime, date: '2026-09-18' } };
  assert.deepEqual(signals(ctx), []);
});

test('Risk Off against a net long book is red and stands until the tile turns back; otherwise it is blue', () => {
  const ctx = context();
  addHolding(ctx, 'EFX', 'LONG');
  const off = { tiles: { strategicAllocation: 'Risk Off' }, changes: [{ id: 'strategicAllocation', from: 'Risk On', to: 'Risk Off' }], riskOff: { since: '2026-09-22', from: 'Risk On' } };
  ctx.alphaCodeWatch = regimeWatch(off);
  const card = () => evaluateResearchAttention(ctx, NOW).findings.find(item => item.action === 'strategic allocation change');
  assert.deepEqual([card().severity, card().kind, card().presentation.rows[0].text], ['action-required', 'portfolio', 'Strategic Allocation Risk On → Risk Off → cut gross.']);
  // Days later, with no tile change that day, it is still up.
  ctx.alphaCodeWatch = { ...ctx.alphaCodeWatch, regime: { ...ctx.alphaCodeWatch.regime, date: '2026-09-10', changes: [] } };
  assert.equal(card().severity, 'action-required');
  // A net short or empty book is told, not ordered.
  const flat = context();
  flat.alphaCodeWatch = regimeWatch(off);
  assert.equal(evaluateResearchAttention(flat, NOW).findings.find(item => item.action === 'strategic allocation change').severity, undefined);
  ctx.alphaCodeWatch = regimeWatch({ tiles: { strategicAllocation: 'Risk On' }, changes: [{ id: 'strategicAllocation', from: 'Risk Off', to: 'Risk On' }], riskOff: null });
  assert.deepEqual([card().severity, card().presentation.rows[0].text], [undefined, 'Strategic Allocation Risk Off → Risk On → tighter stops.']);
});

