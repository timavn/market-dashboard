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
  assert.match(finding.presentation.rows.find(row => row.label === 'Context').text, /Trade turned Bearish vs Long → exit/);
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
  assert.match(findings.find(item => item.symbol === 'XLE').presentation.rows.find(row => row.label === 'Action').text, /ETF Pro went Short vs your Long → review/);
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
test('unverified holdings turn today’s exits and removals into one urgent holdings check', () => {
  const ctx = context(); ctx.holdings.liveVerified = false;
  ctx.events = [changeEvent('SNOW', 'REMOVE', 'LONG'), changeEvent('WING', 'REMOVE', 'SHORT'), changeEvent('XLE', 'ADD', 'SHORT', { productKey: 'etf-pro' })];
  const urgent = evaluateResearchAttention(ctx, NOW).findings.filter(item => item.severity === 'action-required');
  assert.equal(urgent.length, 1);
  assert.equal(urgent[0].kind, 'operational'); assert.equal(urgent[0].assessmentChannel, 'research');
  assert.match(urgent[0].presentation.rows[0].text, /SNOW, WING/);
  ctx.holdings.liveVerified = true;
  assert.equal(evaluateResearchAttention(ctx, NOW).findings.some(item => item.kind === 'operational'), false);
});
test('a Trend-break sizing alert states the security\'s own MIN, MAX, basis and trim', () => {
  const ctx = context(); addHolding(ctx, 'XLK');
  const metric = (value, observations) => ({ value, observations, status: 'available', source: 'Yahoo Finance chart API', asOf: '2026-09-21' });
  ctx.holdings.currentHoldings[0].currentHolding.weightPct = 1.97;
  Object.assign(ctx.holdings.ruleHoldings[0], { trade: null, trend: 'NEUTRAL', weightPct: 1.97,
    sizingInputs: { beta: metric(1.767428, 252), atr14: metric(3.742858, 14), referencePrice: metric(185.44, 1) } });
  const [finding] = evaluateResearchAttention(ctx, NOW).findings;
  const rows = Object.fromEntries(finding.presentation.rows.map(item => [item.label, item.text]));
  assert.equal(finding.state === 'open' && finding.rule.rule, 'TREND_BREAK');
  assert.match(rows['Process limits'], /^MIN 1\.50% · MAX 3\.00% · beta 1\.77 · ATR cap \d+\.\d{2}%$/);
  assert.equal(rows.Action, 'Reduce to MIN 1.50%');
  assert.equal(rows.Trim, '0.47 pts (1.97% → 1.50%)');
  assert.ok(finding.presentation.rows.find(item => item.label === 'Trim').requiresFreshHoldings);
  assert.deepEqual(finding.presentation.rows.slice(-4), [['Tick', 'N/A'], ['Trade', 'N/A'], ['Trend', 'Neutral'], ['Tail', 'N/A']].map(([label, text]) => ({ label, text })));
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
