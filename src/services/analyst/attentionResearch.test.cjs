const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateResearchAttention } = require('./attentionResearch.cjs');
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
  assert.match(finding.presentation.rows.find(row => row.label === 'Context').text, /Trade priority/);
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
  assert.match(findings[0].presentation.rows.find(row => row.label === 'Action').text, /^Sell some/);
  assert.match(findings[0].presentation.rows.find(row => row.label === 'Context').text, /growth outlook deteriorates/);
  assert.equal(findings[0].presentation.rows.some(row => /no remaining quantity/.test(row.text)), false);
});
test('old source instructions and generic unlinked SELL headlines do not refill the inbox', () => {
  const ctx = context(); ctx.holdings.positions = [{ symbol: 'CORN', quantity: 10 }];
  const event = sourceEvent('CORN'); event.marketDate = '2026-09-21'; event.publishedAt = '2026-09-21T12:00:00Z'; ctx.events = [event];
  assert.equal(evaluateResearchAttention(ctx, NOW).findings.length, 0);
  ctx.events = [{ ...sourceEvent('CORN'), sourceReport: undefined }];
  assert.equal(evaluateResearchAttention(ctx, NOW).findings.length, 0);
});
test('source-backed broad market changes need a meaningful implication', () => {
  const ctx = context(); ctx.documents.products = [{ product: 'the-call', publicationDate: '2026-09-22', excerpts: [
    { excerpt: 'Gamma flipped positive, improving support and reducing squeeze risk in the published market-structure assessment.', citation: cite('market') },
    { excerpt: 'The yield curve narrowed by two basis points.', citation: cite('curve') },
  ] }];
  const findings = evaluateResearchAttention(ctx, NOW).findings;
  assert.equal(findings.length, 1); assert.equal(findings[0].symbol, 'Market structure'); assert.equal(findings[0].holdingsVerified, undefined);
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
  assert.equal(evaluateResearchAttention(ctx, next).findings.length, 0);
  ctx.previousAttention = [first];
  const retained = evaluateResearchAttention(ctx, next).findings[0];
  assert.equal(retained.id, first.id); assert.equal(retained.fingerprint, first.fingerprint); assert.equal(retained.publicationTime, first.publicationTime);
});
test('generic partial source instruction with no useful case is silent', () => {
  const ctx = context(); ctx.holdings.positions = [{ symbol: 'CORN', quantity: 10 }];
  const event = sourceEvent('CORN'); event.sourceReport.bodyText = 'Portfolio Managers should be selling-SOME of Bullish TRENDs that are green today.';
  ctx.events = [event]; assert.equal(evaluateResearchAttention(ctx, NOW).findings.length, 0);
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
  assert.deepEqual(segmented, lines, 'opportunity peers and the market pass share the same exact-text parse');
  assert.deepEqual(result.findings.map(item => [item.symbol, item.action]), [
    ['AAA', 'long research idea'], ['BBB', 'short research idea'], ['Market structure', 'market watch'],
  ]);
  for (const [symbol, index, sourceUrl] of [['AAA', 0, url], ['BBB', 1, otherUrl]]) {
    const finding = result.findings.find(item => item.symbol === symbol);
    assert.equal(finding.presentation.rows.find(row => row.label === 'Context').text, lines[index]);
    assert.deepEqual(finding.presentation.sourceLinks[0].citation, documentCitation(symbol.toLowerCase(), sourceUrl));
  }
  assert.equal(result.findings.find(item => item.symbol === 'Market structure').presentation.sourceLinks[0].citation.sourceUri, url);

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
    const event = sourceEvent(symbol);
    event.sourceReport = { ...event.sourceReport, entityId: undefined, title: 'Sell Signal AAA and BBB', bodyText: lines.join('\n') };
    return event;
  });
  const findings = evaluateResearchAttention(ctx, NOW).findings;
  assert.deepEqual(segmented, lines);
  assert.deepEqual(findings.map(item => [item.symbol, item.action]), [['AAA', 'sell-some'], ['BBB', 'sell-some']]);
  assert.ok(findings[0].presentation.rows.find(row => row.label === 'Context').text.startsWith(lines[1]));
  assert.ok(findings[1].presentation.rows.find(row => row.label === 'Context').text.startsWith(lines[2]));
});
