const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { buildHedgaiResearch, loadReviewedBaseline } = require('./hedgaiResearch.cjs');
const { computeResearchEventVerificationHash } = require('../utils/researchEventLedger.cjs');
const baseline = loadReviewedBaseline();
const NOW = '2026-09-28T20:00:00Z';
const row = (result, ticker) => result.book.rows.find(item => item.ticker === ticker);
const project = options => buildHedgaiResearch({ baseline, events: [], asOf: NOW, ...options });
const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
const digest = value => crypto.createHash('sha256').update(JSON.stringify(sorted(value))).digest('hex');
const resign = event => ({ ...event, verificationHash: computeResearchEventVerificationHash(event) });

function sourceReparseFixture() {
  const originals = publication('2026-09-29', [], { complete: false }).map(event => resign({ ...event,
    contentHash: 'a'.repeat(64), payload: { ...event.payload,
      sourceMessageId: event.sourceMessageId, sourceArtifact: event.sourceArtifact,
      sourceQuality: { status: 'discrepancy', issues: [{ code: 'HEDGAI_EMPTY_ACTION_CATEGORY', sourceText: 'Shorts Added:' }] },
    } }));
  const manifest = originals[0];
  const publicationPayload = { ...manifest.payload, complete: true, actionCount: 1, publicationTimeBasis: 'visible-publication-time', sourceQuality: { status: 'clear', issues: [] } };
  const action = { publicationId: manifest.payload.publicationId, publicationDate: '2026-09-29', publishedAt: manifest.eventTime,
    sourceUrl: manifest.payload.sourceUrl, instrumentId: 'hedgai:GLD', ticker: 'GLD', sourceLabel: 'Gold',
    action: 'open-long', sourceCategory: 'Buys Added', sourceText: 'Buys Added: Gold' };
  const repair = resign({ productKey: 'hedgai-signals', eventKey: 'repair-event', eventType: 'HEDGAI_SOURCE_REPARSE',
    eventTime: manifest.eventTime, capturedAt: '2026-09-29T16:00:00Z', sourceMessageId: 'reparse-message',
    sourceKind: 'verified-source-reparse', sequence: 0, sourceEventCount: 1, immutable: true,
    eventHash: 'b'.repeat(64), verificationHashVersion: 'research-event-content-v1',
    sourceArtifact: manifest.sourceArtifact, contentHash: manifest.contentHash,
    parserVersion: 'research-event-ledger-v2:hedgai-source-reparse-v1',
    payload: { method: 'canonical-parser-content-hash', parserVersion: 'hedgai-email-v2', originalMessageId: manifest.sourceMessageId,
      originalEvents: originals.map(event => ({ eventKey: event.eventKey, verificationHash: event.verificationHash })),
      sourceArtifact: manifest.sourceArtifact, sourceContentHash: manifest.contentHash,
      publication: publicationPayload, actions: [action], reaffirmations: [] } });
  return { originals, repair };
}

function publication(date = '2026-09-28', actions = [], { id = date === '2026-09-28' ? 'hedgai:187742' : `hedgai:${date}`, messageId = id, complete = true } = {}) {
  const publishedAt = `${date}T12:43:00Z`;
  const shared = { publicationId: id, publishedAt, publicationDate: date, sourceUrl: `https://app.hedgeye.com/feed_items/${id.split(':')[1]}` };
  const payloads = [['HEDGAI_PUBLICATION', { ...shared, complete, headline: 'HedgAI Signals', actionCount: actions.filter(action => !action.action.startsWith('maintain-')).length }],
    ...actions.map(action => [action.action.startsWith('maintain-') ? 'HEDGAI_REAFFIRMATION' : 'HEDGAI_ACTION', { ...shared, ...action, instrumentId: `hedgai:${action.ticker}`, sourceText: action.sourceText || `${action.action} ${action.ticker}` }])];
  return payloads.map(([eventType, payload], sequence) => {
    const event = { productKey: 'hedgai-signals', eventKey: `${publishedAt}#${messageId}#${sequence}`, eventTime: publishedAt,
      sourceMessageId: messageId, sequence, sourceEventCount: payloads.length, sourceArtifact: 'hedgai/source.html', eventType, payload,
      parserVersion: 'research-event-ledger-v2', immutable: true, eventHash: crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
      verificationHashVersion: 'research-event-content-v1' };
    return { ...event, verificationHash: computeResearchEventVerificationHash(event) };
  });
}

function aliasIncompletePublication(date, actions, headings, { id, publishedAt } = {}) {
  return publication(date, actions, { id, complete: false }).map(event => {
    const revised = { ...event, eventTime: publishedAt, eventKey: `${publishedAt}#${event.sourceMessageId}#${event.sequence}`,
      payload: { ...event.payload, publishedAt } };
    if (event.eventType === 'HEDGAI_PUBLICATION') revised.payload.sourceQuality = { status: 'discrepancy', issues: headings.map(([category, sourceLabel]) => ({
      code: 'HEDGAI_INSTRUMENT_UNMAPPED', id: digest(`${category}: ${sourceLabel}`), sourceLabel,
      sourceText: `${category}: ${sourceLabel}`, message: `${category}: ${sourceLabel}`, field: 'hedgai', affectedFields: ['hedgai'],
    })) };
    return resign(revised);
  });
}

test('verified Sep 29 and 30 retained headings reconcile through the catalog without rewriting source events', () => {
  const events = [
    ...aliasIncompletePublication('2026-09-29', [
      { ticker: 'TSLA', action: 'open-long' }, { ticker: 'IBIT', action: 'open-long' }, { ticker: 'PFIX', action: 'close-long' },
    ], [['Shorts Added', 'Staples XLP'], ['Shorts Added', 'Euro To US Dollar'], ['Buys Closed', 'Russell'],
      ['Shorts Closed', 'Technology XLK'], ['Shorts Closed', 'Soybean']], { id: 'hedgai:187796', publishedAt: '2026-09-29T09:45:00+00:00' }),
    ...aliasIncompletePublication('2026-09-30', [
      { ticker: 'GOOGL', action: 'open-long' }, { ticker: 'PALL', action: 'open-short' },
      { ticker: 'SPY', action: 'close-long' }, { ticker: 'TSLA', action: 'close-long' },
      { ticker: 'NVDA', action: 'close-short' }, { ticker: 'USO', action: 'close-short' },
    ], [['Buys Added', 'USD To Yen'], ['Buys Closed', 'Energy XLE'], ['Buys Closed', 'Lithium LIT']],
    { id: 'hedgai:187863', publishedAt: '2026-09-30T12:33:00+00:00' }),
  ];
  const original = JSON.stringify(events);
  const result = project({ events, asOf: '2026-09-30T20:00:00Z' });
  assert.equal(result.sourceQuality.continuity, 'complete');
  assert.equal(result.changes.length, 17);
  for (const [ticker, position] of Object.entries({ SPY: 'Wait', QQQ: 'Short', GLD: 'Wait', SLV: 'Wait', XLP: 'Short', ULE: 'Short',
    IWM: 'Wait', XLK: 'Wait', SOYB: 'Wait', YCS: 'Buy', XLE: 'Wait', LIT: 'Wait' })) {
    assert.equal(row(result, ticker).position, position, ticker);
    assert.equal(row(result, ticker).status, 'current', ticker);
  }
  const resolved = result.sourceQuality.issues.filter(issue => issue.code === 'HEDGAI_INSTRUMENT_UNMAPPED');
  assert.equal(resolved.length, 8);
  assert.ok(resolved.every(issue => issue.resolved && issue.blocking === false && issue.resolution.type === 'catalog-alias'));
  const yen = result.changes.find(change => change.ticker === 'YCS');
  assert.equal(yen.sourceText, 'Buys Added: USD To Yen');
  assert.equal(yen.publishedAt, '2026-09-30T12:33:00+00:00');
  assert.deepEqual(yen.sourceIds, ['hedgai:187863']);
  assert.equal(result.sources.find(source => source.id === 'hedgai:187796').reconciliation.recoveredActionCount, 5);
  assert.equal(result.sources.find(source => source.id === 'hedgai:187863').reconciliation.recoveredActionCount, 3);
  assert.equal(JSON.stringify(events), original);
});

test('alias reconciliation leaves unknown headings, source-label mismatch and conflicting actions blocked', () => {
  const variants = [
    { headings: [['Buys Added', 'USD To Yen'], ['Shorts Added', 'Unknown instrument']], expectedCode: 'HEDGAI_INSTRUMENT_UNMAPPED' },
    { headings: [['Buys Added', 'USD To Yen']], actions: [{ ticker: 'YCS', action: 'open-short' }], expectedCode: 'simultaneous-opposite-opens' },
    { headings: [['Buys Added', 'USD To Yen']], mismatch: true, expectedCode: 'HEDGAI_INSTRUMENT_UNMAPPED' },
    { headings: [['Buys Added', 'USD To Yen']], missingCategory: true, expectedCode: 'HEDGAI_ACTION_CATEGORIES_INCOMPLETE' },
  ];
  for (const variant of variants) {
    let events = aliasIncompletePublication('2026-09-29', variant.actions || [], variant.headings,
      { id: 'hedgai:187796', publishedAt: '2026-09-29T09:45:00+00:00' });
    if (variant.mismatch) events[0].payload.sourceQuality.issues[0].sourceText = 'Shorts Added: Euro To US Dollar';
    if (variant.missingCategory) events[0].payload.sourceQuality.issues.push({ code: 'HEDGAI_ACTION_CATEGORIES_INCOMPLETE', sourceText: 'Missing categories: shorts closed' });
    events = events.map(resign);
    const result = project({ events, asOf: '2026-09-29T20:00:00Z' });
    assert.notEqual(result.sourceQuality.continuity, 'complete');
    assert.ok(result.sourceQuality.issues.some(issue => issue.code === variant.expectedCode && issue.blocking));
    assert.equal(row(result, 'YCS').status, 'last-known');
    if (variant.actions || variant.mismatch) assert.equal(row(result, 'YCS').position, 'Wait');
  }
});

test('tampered retained headings cannot be recovered through catalog aliases', () => {
  const events = aliasIncompletePublication('2026-09-29', [], [['Buys Added', 'USD To Yen']],
    { id: 'hedgai:187796', publishedAt: '2026-09-29T09:45:00+00:00' });
  events[0].payload.sourceQuality.issues[0].sourceLabel = 'Euro To US Dollar';
  const result = project({ events, asOf: '2026-09-29T20:00:00Z' });
  assert.equal(row(result, 'YCS').position, 'Wait');
  assert.equal(row(result, 'ULE').position, 'Wait');
  assert.equal(result.changes.length, 0);
  assert.equal(result.sourceQuality.continuity, 'gap');
});

test('complete source-bound parsing repairs restore all 47 Tick readings without rewriting original events', () => {
  const { originals, repair } = sourceReparseFixture();
  const captured = JSON.stringify({ originals, repair });
  const result = project({ events: [...originals, repair, repair], asOf: '2026-09-29T20:00:00Z' });
  assert.equal(result.sourceQuality.continuity, 'complete');
  assert.equal(result.book.rows.filter(item => item.status === 'current').length, 47);
  assert.equal(row(result, 'GLD').position, 'Buy');
  assert.equal(result.changes[0].sourceText, 'Buys Added: Gold');
  const resolved = result.sourceQuality.issues.find(issue => issue.code === 'HEDGAI_EMPTY_ACTION_CATEGORY');
  assert.equal(resolved.blocking, false);
  assert.equal(resolved.resolution.type, 'verified-source-reparse');
  assert.equal(resolved.resolution.sourceContentHash, originals[0].contentHash);
  assert.equal(JSON.stringify({ originals, repair }), captured);
});

test('source repair binding is independent of DynamoDB object property order while preserving original sequence', () => {
  const { originals, repair } = sourceReparseFixture();
  const reordered = { ...repair, payload: { ...repair.payload,
    originalEvents: repair.payload.originalEvents.map(event => ({ verificationHash: event.verificationHash, eventKey: event.eventKey })) } };
  assert.equal(computeResearchEventVerificationHash(reordered), repair.verificationHash);
  const result = project({ events: [...originals, reordered], asOf: '2026-09-29T20:00:00Z' });
  assert.equal(result.sourceQuality.continuity, 'complete');
  assert.equal(result.book.rows.filter(item => item.status === 'current').length, 47);
  assert.equal(row(result, 'GLD').position, 'Buy');
  assert.ok(!result.sourceQuality.issues.some(issue => issue.code === 'source-reparse-invalid'));
});

test('source repairs reject altered evidence, source binding, identity, fake inputs and incomplete originals', () => {
  const variants = [
    ({ repair }) => { repair.payload.actions[0].action = 'open-short'; },
    ({ repair }) => { repair.payload.sourceContentHash = 'c'.repeat(64); },
    ({ repair }) => { repair.payload.originalEvents[0].verificationHash = 'c'.repeat(64); },
    ({ repair }) => { repair.payload.publication.publicationId = 'hedgai:changed'; },
    ({ repair }) => { repair.payload.publication.sourceUrl = 'https://app.hedgeye.com/feed_items/changed'; },
    ({ repair }) => { repair.payload.publication.publishedAt = '2026-09-29T13:00:00Z'; },
    ({ repair }) => { repair.payload.publication.complete = false; },
    ({ repair }) => { repair.source = 'mock'; },
    ({ repair }) => { repair.seeded = true; },
    ({ repair }) => { repair.sourceType = 'fixture'; },
    ({ originals }) => { originals[0].sourceEventCount = 2; },
    ({ originals }) => { originals[0].payload.complete = true; },
  ];
  for (const mutate of variants) {
    const fixture = sourceReparseFixture();
    mutate(fixture);
    // A new signed repair still cannot evade its binding to the original group.
    if (fixture.repair.payload.actions[0].action !== 'open-short') fixture.repair = resign(fixture.repair);
    const result = project({ events: [...fixture.originals, fixture.repair], asOf: '2026-09-29T20:00:00Z' });
    assert.equal(row(result, 'GLD').position, 'Wait');
    assert.equal(row(result, 'GLD').status, 'last-known');
    assert.ok(result.sourceQuality.issues.some(issue => issue.code === 'source-reparse-invalid' && issue.blocking));
  }
});

test('conflicting or future parsing repairs cannot conceal the unresolved original publication', () => {
  const { originals, repair } = sourceReparseFixture();
  const conflicting = resign({ ...repair, eventKey: 'second-repair', payload: { ...repair.payload, actions: [] } });
  const future = { ...repair, capturedAt: '2026-09-30T20:00:00Z' };
  for (const repairs of [[repair, conflicting], [future]]) {
    const result = project({ events: [...originals, ...repairs], asOf: '2026-09-29T20:00:00Z' });
    assert.equal(row(result, 'GLD').position, 'Wait');
    assert.equal(row(result, 'GLD').status, 'last-known');
    assert.notEqual(result.sourceQuality.continuity, 'complete');
  }
});

test('reviewed archive contains the complete 47-row baseline and separate side performance', () => {
  const result = project();
  assert.equal(result.book.rows.length, 47);
  assert.equal(result.sources.length, 8);
  assert.deepEqual(result.book.rows.reduce((counts, item) => ({ ...counts, [item.position]: (counts[item.position] || 0) + 1 }), {}), { Short: 10, Wait: 25, Buy: 12 });
  assert.deepEqual(result.book.rows.filter(item => item.activeDirection).map(item => item.ticker), ['XLE', 'SLX', 'UJB', 'SPY', 'IWM', 'XLY']);
  assert.equal(row(result, 'QQQ').bullEligible, true);
  assert.equal(row(result, 'QQQ').bearEligible, false);
  assert.equal(row(result, 'QQQ').activeDirection, null);
  assert.equal(row(result, 'SPY').activeDirection, 'Bullish');
  assert.equal(row(result, 'GLD').bullEligible, true);
  assert.equal(row(result, 'GLD').activeDirection, null);
  assert.equal(row(result, 'IBIT').bullEligible, false);
  assert.equal(row(result, 'URA').modelThreshold, .6);
  assert.equal(row(result, 'URA').bullEligible, false);
  assert.equal(result.marketMatches.find(match => match.marketId === 'nasdaq100').instrumentId, 'hedgai:QQQ');
  assert.ok(result.marketMatches.every(match => match.matchType === 'proxy'));
});

test('all five Sep 28 actions remain visible without double applying the post-update baseline', () => {
  const events = publication('2026-09-28', [
    { ticker: 'PFIX', action: 'open-long' }, { ticker: 'UUP', action: 'open-short' },
    { ticker: 'PALL', action: 'close-long' }, { ticker: 'UST', action: 'close-long' },
    { ticker: 'PPLT', action: 'close-short' }, { ticker: 'META', action: 'maintain-long' },
  ]);
  const original = JSON.stringify({ baseline, events });
  const result = project({ events: [...events, ...events] });
  assert.equal(result.changes.length, 5);
  assert.equal(result.reaffirmations.length, 1);
  assert.ok(result.changes.every(change => change.alreadyIncludedInBaseline));
  assert.equal(result.changes.find(change => change.ticker === 'PALL').eligible, true);
  assert.equal(result.changes.find(change => change.ticker === 'PPLT').eligible, true);
  assert.equal(result.changes.find(change => change.ticker === 'PFIX').eligible, false);
  assert.equal(row(result, 'PFIX').initiatedAt, '2026-09-28');
  assert.equal(row(result, 'META').initiatedAt, '2026-09-14');
  assert.equal(row(result, 'PALL').position, 'Wait');
  assert.equal(row(result, 'PPLT').position, 'Wait');
  assert.equal(row(result, 'UST').position, 'Wait');
  assert.equal(result.sourceQuality.continuity, 'complete');
  assert.equal(JSON.stringify({ baseline, events }), original);
});

test('subsequent closes remove only the named side; a close never creates an opposite signal', () => {
  const events = publication('2026-09-29', [{ ticker: 'SPY', action: 'close-long' }, { ticker: 'SLX', action: 'close-short' }, { ticker: 'GLD', action: 'open-long' }]);
  const result = project({ events, asOf: '2026-09-29T17:00:00Z' });
  assert.equal(row(result, 'SPY').position, 'Wait');
  assert.equal(row(result, 'SPY').activeDirection, null);
  assert.equal(row(result, 'SLX').position, 'Wait');
  assert.equal(row(result, 'GLD').activeDirection, 'Bullish');
  assert.equal(row(result, 'GLD').initiatedAt, '2026-09-29');
  assert.equal(row(result, 'GLD').metricsDate, '2026-09-28');
  assert.deepEqual(row(result, 'GLD').metrics, baseline.rows.find(item => item.ticker === 'GLD').metrics);
});

test('complete zero-action publication verifies continuity without synthesizing changes', () => {
  const result = project({ events: publication('2026-09-29'), asOf: '2026-09-29T17:00:00Z' });
  assert.equal(result.sourceQuality.continuity, 'complete');
  assert.equal(result.changes.length, 0);
  assert.equal(row(result, 'SPY').initiatedAt, '2026-09-11');
});

test('a contradictory publisher headline preserves its exact aggregate and all independent Tick positions', () => {
  const events = publication('2026-09-29').map(event => resign({ ...event, payload: { ...event.payload,
    headline: 'HedgAI Signals | 5 Longs and 7 Shorts; +0.97% DoD' } }));
  const result = project({ events, asOf: '2026-09-29T17:00:00Z' });
  const discrepancy = result.sourceQuality.issues.find(issue => issue.code === 'HEDGAI_PUBLISHED_BOOK_COUNT_DISCREPANCY');
  assert.deepEqual([discrepancy.publishedLongCount, discrepancy.publishedShortCount], [5, 7]);
  assert.deepEqual([discrepancy.projectedLongCount, discrepancy.projectedShortCount], [12, 10]);
  assert.equal(discrepancy.sourceText, 'HedgAI Signals | 5 Longs and 7 Shorts; +0.97% DoD');
  assert.deepEqual(discrepancy.sourceIds, ['hedgai:2026-09-29']);
  assert.equal(discrepancy.publicationDate, '2026-09-29');
  assert.equal(discrepancy.source.productId, 'hedgai-signals');
  assert.deepEqual(discrepancy.observed, { published: { long: 5, short: 7 }, reconstructed: { long: 12, short: 10 } });
  assert.equal(discrepancy.disposition, 'aggregate_unreconciled');
  assert.equal(discrepancy.blocking, false);
  assert.equal(result.sourceQuality.continuity, 'complete');
  assert.equal(result.book.rows.filter(item => item.status === 'current').length, 47);
  assert.equal(row(result, 'SPY').position, 'Buy');
  assert.equal(result.changes.length, 0);
});

test('missing, incomplete, tampered and mock publications retain dated context without fresh contribution', () => {
  const original = publication('2026-09-29', [{ ticker: 'SPY', action: 'close-long' }]);
  const tampered = JSON.parse(JSON.stringify(original)); tampered[1].payload.action = 'open-short';
  const mock = original.map(event => ({ ...event, source: 'mock' }));
  for (const events of [[], original.slice(0, 1), tampered, mock]) {
    const result = project({ events, asOf: '2026-09-29T17:00:00Z' });
    assert.equal(result.book.rows.length, 47);
    assert.equal(row(result, 'SPY').position, 'Buy');
    assert.equal(row(result, 'SPY').lastKnownDirection, 'Bullish');
    assert.equal(row(result, 'SPY').activeDirection, null);
    assert.equal(row(result, 'SPY').status, 'last-known');
    assert.notEqual(result.sourceQuality.continuity, 'complete');
  }
});

test('delivery failure suppresses fresh contribution even with retained verified events', () => {
  const result = project({ availability: 'unavailable', events: publication() });
  assert.equal(result.book.rows.length, 47);
  assert.equal(row(result, 'SPY').activeDirection, null);
  assert.equal(row(result, 'SPY').bullEligible, true);
  assert.equal(row(result, 'SPY').lastConfirmedAt, baseline.publishedAt);
});

test('later publication cannot conceal an unverified intervening weekday', () => {
  const result = project({ events: publication('2026-09-30'), asOf: '2026-09-30T17:00:00Z' });
  assert.equal(row(result, 'SPY').activeDirection, null);
  assert.deepEqual(result.sourceQuality.issues.find(issue => issue.code === 'publication-continuity-unverified').dates, ['2026-09-29']);
});

test('a saved capture excludes future publications and a future baseline', () => {
  const future = publication('2026-09-29', [{ ticker: 'SPY', action: 'close-long' }]);
  assert.equal(row(project({ events: future }), 'SPY').position, 'Buy');
  assert.equal(project({ asOf: '2026-09-28T12:00:00Z' }).book.rows.length, 0);
});

test('review hash prevents a changed or seed-labelled baseline entering the projection', () => {
  const altered = JSON.parse(JSON.stringify(baseline)); altered.rows[0].metrics.short.battingAverage = .99;
  assert.throws(() => project({ baseline: altered }), /review/);
  assert.throws(() => project({ baseline: { ...baseline, source: 'seeded' } }), /review/);
});

test('unknown instruments preserve the publication with a continuity issue', () => {
  const result = project({ events: publication('2026-09-29', [{ ticker: 'UNKNOWN', action: 'open-long' }]), asOf: '2026-09-29T17:00:00Z' });
  assert.equal(result.book.rows.length, 47);
  assert.ok(result.sources.some(source => source.publicationId === 'hedgai:2026-09-29'));
  assert.ok(result.sourceQuality.issues.some(issue => issue.code === 'instrument-unmapped'));
  assert.equal(row(result, 'SPY').activeDirection, null);
});

test('before the publication check window a dated prior reading stays usable without an invented missing incident', () => {
  const result = project({ asOf: '2026-09-29T12:00:00Z' });
  assert.equal(result.sourceQuality.continuity, 'complete');
  assert.equal(result.sourceQuality.publicationStatus, 'not-due');
  assert.equal(row(result, 'SPY').activeDirection, 'Bullish');
  assert.equal(row(result, 'SPY').lastConfirmedAt, baseline.publishedAt);
});

test('the shared exchange calendar excludes Thanksgiving and weekends from expected deliveries', () => {
  const candidate = JSON.parse(JSON.stringify(baseline));
  candidate.baselineDate = '2026-11-25'; candidate.metricsDate = '2026-11-25'; candidate.publishedAt = '2026-11-25T13:43:00Z';
  for (const asOf of ['2026-11-26T20:00:00Z', '2026-11-27T13:00:00Z']) {
    const result = project({ baseline: candidate, asOf });
    assert.equal(result.sourceQuality.continuity, 'complete');
    assert.equal(row(result, 'SPY').activeDirection, 'Bullish');
  }
  candidate.baselineDate = '2026-11-27'; candidate.metricsDate = '2026-11-27'; candidate.publishedAt = '2026-11-27T13:43:00Z';
  assert.equal(project({ baseline: candidate, asOf: '2026-11-29T20:00:00Z' }).sourceQuality.continuity, 'complete');
});

test('heading order cannot turn a valid same-publication Short-to-Buy flip into a conflict', () => {
  const events = publication('2026-09-29', [{ ticker: 'QQQ', action: 'open-long' }, { ticker: 'QQQ', action: 'close-short' }]);
  const result = project({ events, asOf: '2026-09-29T17:00:00Z' });
  assert.equal(row(result, 'QQQ').position, 'Buy');
  assert.equal(row(result, 'QQQ').initiatedAt, '2026-09-29');
  assert.equal(row(result, 'QQQ').activeDirection, 'Bullish');
  assert.ok(!result.sourceQuality.issues.some(issue => issue.code === 'close-side-conflict'));
});

test('simultaneous opposite opens preserve the starting row and withhold only that instrument', () => {
  const events = publication('2026-09-29', [{ ticker: 'QQQ', action: 'open-long' }, { ticker: 'QQQ', action: 'open-short' }]);
  const result = project({ events, asOf: '2026-09-29T17:00:00Z' });
  assert.equal(row(result, 'QQQ').position, 'Short');
  assert.equal(row(result, 'QQQ').initiatedAt, '2026-09-21');
  assert.equal(row(result, 'QQQ').activeDirection, null);
  assert.equal(row(result, 'SPY').activeDirection, 'Bullish');
  assert.ok(result.sourceQuality.issues.some(issue => issue.code === 'simultaneous-opposite-opens'));
});

test('same-time contradictory publications have deterministic evidence but no invented chronology', () => {
  const first = publication('2026-09-29', [{ ticker: 'SPY', action: 'close-long' }], { id: 'hedgai:a' });
  const second = publication('2026-09-29', [{ ticker: 'SPY', action: 'open-short' }], { id: 'hedgai:b' });
  const result = project({ events: [...second, ...first], asOf: '2026-09-29T17:00:00Z' });
  const reordered = project({ events: [...first, ...second], asOf: '2026-09-29T17:00:00Z' });
  assert.deepEqual(result, reordered);
  assert.equal(row(result, 'SPY').position, 'Buy');
  assert.equal(row(result, 'SPY').activeDirection, null);
  assert.equal(row(result, 'XLE').activeDirection, 'Bullish');
});

function metricsPublication() {
  const events = publication('2026-09-29');
  const metrics = { combined: { battingAverage: .70, winLoss: 1.2, signals: 48 }, buy: { battingAverage: .81, winLoss: 2.7, signals: 21 }, short: { battingAverage: .61, winLoss: 1.1, signals: 27 } };
  const payload = { ...events[0].payload, instrumentId: 'hedgai:QQQ', metricsDate: '2026-09-29', metrics,
    provenance: { reviewed: true, sourceType: 'reviewed-screenshot', method: 'visual-source-comparison', reviewedAt: '2026-09-29T13:00:00Z', metricsHash: digest(metrics) },
    sources: [{ ...baseline.sources[4], id: 'new-reviewed-metrics', publicationDate: '2026-09-29' }] };
  const event = { ...events[0], eventType: 'HEDGAI_METRICS', eventKey: 'metrics#1', sequence: 1, sourceEventCount: 2, payload };
  return [resign({ ...events[0], sourceEventCount: 2 }), resign(event)];
}

test('source action reparsing preserves independently reviewed metrics from the original publication group', () => {
  const fixture = sourceReparseFixture();
  const manifest = resign({ ...fixture.originals[0], sourceEventCount: 2 });
  const metrics = resign({ ...manifest, eventType: 'HEDGAI_METRICS', eventKey: 'original-reviewed-metrics', sequence: 1,
    payload: metricsPublication()[1].payload });
  const originals = [manifest, metrics];
  const repair = resign({ ...fixture.repair, payload: { ...fixture.repair.payload,
    originalEvents: originals.map(event => ({ eventKey: event.eventKey, verificationHash: event.verificationHash })) } });
  const result = project({ events: [...originals, repair], asOf: '2026-09-29T20:00:00Z' });
  assert.equal(result.sourceQuality.continuity, 'complete');
  assert.equal(row(result, 'GLD').position, 'Buy');
  assert.equal(row(result, 'QQQ').metrics.short.battingAverage, .61);
  assert.equal(row(result, 'QQQ').metricsDate, '2026-09-29');
  assert.ok(result.sources.some(source => source.id === 'new-reviewed-metrics'));
  const wrongSequence = resign({ ...repair, payload: { ...repair.payload,
    originalEvents: [...repair.payload.originalEvents].reverse() } });
  const rejected = project({ events: [...originals, wrongSequence], asOf: '2026-09-29T20:00:00Z' });
  assert.equal(row(rejected, 'GLD').position, 'Wait');
  assert.ok(rejected.sourceQuality.issues.some(issue => issue.code === 'source-reparse-invalid' && issue.blocking));
});

test('later complete reviewed metrics replace only statistics and remain frozen in older captures', () => {
  const events = metricsPublication();
  const result = project({ events, asOf: '2026-09-29T17:00:00Z' });
  assert.equal(row(result, 'QQQ').metrics.short.battingAverage, .61);
  assert.equal(row(result, 'QQQ').activeDirection, 'Bearish');
  assert.equal(row(result, 'QQQ').initiatedAt, '2026-09-21');
  assert.equal(row(result, 'QQQ').metricsDate, '2026-09-29');
  assert.equal(row(result, 'SPY').metricsDate, '2026-09-28');
  assert.equal(row(project({ events }), 'QQQ').metrics.short.battingAverage, .48);
});

test('unreviewed, partial or misbound new metrics preserve all independent email actions and original statistics', () => {
  for (const mode of ['missing-review', 'wrong-hash', 'partial']) {
    const events = metricsPublication();
    if (mode === 'missing-review') delete events[1].payload.provenance;
    if (mode === 'wrong-hash') events[1].payload.provenance.metricsHash = '0'.repeat(64);
    if (mode === 'partial') delete events[1].payload.metrics.short;
    events[1] = resign(events[1]);
    const result = project({ events, asOf: '2026-09-29T17:00:00Z' });
    assert.equal(row(result, 'QQQ').metrics.short.battingAverage, .48);
    assert.equal(row(result, 'SPY').activeDirection, 'Bullish');
    assert.ok(result.sourceQuality.issues.some(issue => issue.code === 'metrics-review-required'));
  }
});

test('a later complete reviewed checkpoint reconciles continuity while retaining archived source links', () => {
  const candidate = JSON.parse(JSON.stringify(baseline));
  candidate.baselineDate = '2026-09-30'; candidate.metricsDate = '2026-09-30'; candidate.publishedAt = '2026-09-30T12:43:00Z';
  candidate.sources = candidate.sources.map(source => ({ ...source, id: `new-${source.id}` }));
  candidate.rows = candidate.rows.map(item => ({ ...item, sourceIds: item.sourceIds.map(id => `new-${id}`),
    positionSourceIds: item.positionSourceIds.map(id => `new-${id}`), metricsSourceIds: item.metricsSourceIds.map(id => `new-${id}`) }));
  candidate.provenance.rowsHash = digest(candidate.rows);
  const event = resign({ ...publication('2026-09-30')[0], eventType: 'HEDGAI_BASELINE', sourceKind: 'reviewed-screenshot-baseline', payload: candidate });
  const result = project({ events: [event], asOf: '2026-09-30T17:00:00Z' });
  assert.equal(result.baselineDate, '2026-09-30');
  assert.equal(result.sourceQuality.continuity, 'complete');
  assert.equal(result.sources.length, 16);
  assert.equal(project({ events: [event] }).baselineDate, '2026-09-28');
});

test('an intact signed publication with one unparsed action still advances its independent valid action', () => {
  const events = publication('2026-09-29', [{ ticker: 'GLD', action: 'open-long' }], { complete: false });
  events[0].payload.sourceQuality = { issues: [{ code: 'unmapped-instrument', message: 'A separately published source label has no verified instrument mapping.', sourceText: 'Unmapped source action' }] };
  events[0] = resign(events[0]);
  const result = project({ events, asOf: '2026-09-29T17:00:00Z' });
  assert.equal(result.changes.length, 1);
  assert.equal(row(result, 'GLD').position, 'Buy');
  assert.equal(row(result, 'GLD').initiatedAt, '2026-09-29');
  assert.equal(row(result, 'GLD').activeDirection, null);
  assert.equal(row(result, 'GLD').metricsDate, '2026-09-28');
  assert.ok(result.sourceQuality.issues.some(issue => issue.code === 'unmapped-instrument'));
});

function duplicateActualDelivery({ reverseActions = false, changeAction = false } = {}) {
  const real = require('../../data/research/hedgai/2026-09-28-email-events.json');
  let duplicate = JSON.parse(JSON.stringify(real));
  if (reverseActions) duplicate = [duplicate[0], ...duplicate.slice(1).reverse()];
  duplicate = duplicate.map((event, sequence) => {
    event.sourceMessageId = 'late-duplicate-gmail-id';
    event.sourceArtifact = 'hedgeye/gmail/duplicate-delivery.html';
    event.capturedAt = '2026-09-28T21:00:00Z';
    event.eventKey = `${event.eventTime}#late-duplicate-gmail-id#${String(sequence).padStart(4, '0')}`;
    event.sequence = sequence;
    if (event.payload.sourceMessageId) event.payload.sourceMessageId = event.sourceMessageId;
    if (event.payload.sourceArtifact) event.payload.sourceArtifact = event.sourceArtifact;
    if (changeAction && event.eventType === 'HEDGAI_ACTION' && event.payload.instrumentId === 'hedgai:PFIX') event.payload.action = 'open-short';
    return resign(event);
  });
  return { real, duplicate };
}

test('a late second Gmail delivery of the same actual publication preserves six contributions and both source artifacts', () => {
  for (const reverseActions of [false, true]) {
    const { real, duplicate } = duplicateActualDelivery({ reverseActions });
    const result = project({ events: [...real, ...duplicate], asOf: '2026-09-28T22:00:00Z' });
    assert.equal(result.changes.length, 5);
    assert.equal(result.reaffirmations.length, 1);
    assert.equal(result.book.rows.filter(item => item.activeDirection).length, 6);
    assert.equal(result.sourceQuality.continuity, 'complete');
    const source = result.sources.find(item => item.id === 'hedgai:187742');
    assert.equal(source.deliveries.length, 2);
    assert.equal(source.deliveries[1].sourceMessageId, 'late-duplicate-gmail-id');
    assert.equal(source.deliveries[1].artifactPath, 'hedgeye/gmail/duplicate-delivery.html');
    assert.equal(row(result, 'PFIX').initiatedAt, '2026-09-28');
  }
});

test('a duplicate delivery with a genuinely changed action remains a semantic conflict', () => {
  const { real, duplicate } = duplicateActualDelivery({ changeAction: true });
  const result = project({ events: [...real, ...duplicate], asOf: '2026-09-28T22:00:00Z' });
  assert.ok(result.sourceQuality.issues.some(issue => issue.code === 'publication-conflict'));
  assert.equal(result.book.rows.filter(item => item.activeDirection).length, 0);
  assert.equal(result.sources.find(item => item.id === 'hedgai:187742').deliveries.length, 2);
});

test('a late email missing its publication date retains unresolved evidence without receipt-dated book changes', () => {
  const events = publication('2026-09-29', [{ ticker: 'GLD', action: 'open-long' }], { id: 'hedgai:undated' });
  events[0].payload.publicationTimeBasis = 'email-received-at';
  events[0].payload.sourceQuality = { issues: [{ code: 'HEDGAI_PUBLICATION_TIME_MISSING', message: 'Visible publication time unavailable' }] };
  events[0] = resign(events[0]);
  const result = project({ events, asOf: '2026-09-29T17:00:00Z' });
  assert.equal(row(result, 'GLD').position, 'Wait');
  assert.equal(row(result, 'GLD').initiatedAt, null);
  assert.equal(row(result, 'GLD').lastConfirmedAt, baseline.publishedAt);
  assert.equal(result.changes.length, 0);
  assert.equal(result.unresolvedActions.length, 1);
  assert.equal(result.unresolvedActions[0].publishedAt, null);
  assert.equal(result.unresolvedActions[0].publicationDate, null);
  assert.equal(result.unresolvedActions[0].receivedAt, '2026-09-29T12:43:00Z');
  assert.equal(result.unresolvedActions[0].applied, false);
  assert.equal(result.unresolvedActions[0].unresolvedDate, true);
  assert.equal(result.sources.find(item => item.id === 'hedgai:undated').publicationTimeVerified, false);
  assert.equal(result.sourceQuality.coverageThrough, '2026-09-28');
});

test('an invalid timestamp cannot reorder a later verified publication, while unresolved continuity remains explicit', () => {
  const unknown = publication('2026-09-30', [{ ticker: 'GLD', action: 'open-short' }], { id: 'hedgai:invalid-time' });
  unknown[0].payload.publicationTimeBasis = 'email-received-at';
  unknown[0].payload.sourceQuality = { issues: [{ code: 'HEDGAI_PUBLICATION_TIME_INVALID', message: '99/99/2026 08:43 AM EDT' }] };
  unknown[0] = resign(unknown[0]);
  const valid = publication('2026-09-29', [{ ticker: 'GLD', action: 'open-long' }]);
  const result = project({ events: [...unknown, ...valid], asOf: '2026-09-30T17:00:00Z' });
  assert.equal(row(result, 'GLD').position, 'Buy');
  assert.equal(row(result, 'GLD').initiatedAt, '2026-09-29');
  assert.equal(row(result, 'GLD').lastConfirmedAt, '2026-09-29T12:43:00Z');
  assert.equal(row(result, 'GLD').activeDirection, null);
  assert.equal(result.changes.length, 1);
  assert.equal(result.changes[0].publicationDate, '2026-09-29');
  assert.equal(result.unresolvedActions.length, 1);
  assert.equal(result.sourceQuality.coverageThrough, '2026-09-29');
  assert.ok(result.sourceQuality.issues.some(issue => issue.code === 'HEDGAI_PUBLICATION_TIME_INVALID'));
});

test('a missed edition holds back only rows no later publication restated', () => {
  // 2026-09-29 is never delivered; 2026-09-30 opens GLD short and reaffirms nothing else.
  const later = publication('2026-09-30', [{ ticker: 'GLD', action: 'open-short', sourceText: 'Shorts Added: Gold' }]);
  const result = project({ events: later, asOf: '2026-09-30T20:00:00Z' });
  const gap = result.sourceQuality.issues.find(issue => issue.code === 'publication-continuity-unverified');
  assert.deepEqual(gap.dates, ['2026-09-29']);
  assert.notEqual(result.sourceQuality.continuity, 'complete');
  assert.equal(row(result, 'GLD').status, 'current');
  assert.equal(row(result, 'GLD').position, 'Short');
  assert.equal(row(result, 'SLV').status, 'last-known');
  assert.equal(row(result, 'SPY').status, 'last-known');
});

test('September 29–November 3 headings resolve to their book instruments', () => {
  const labels = { BNO: 'Brent Oil', FXB: 'Pound To US Dollar', XLB: 'Materials XLB', YCS: 'US Dollar To Yen',
    UNG: 'Natural Gas', XLU: 'Utilities XLU', XLY: 'Consumer Disc. XLY' };
  const catalog = require('../../infra/lambdas/gmail_ingestor/hedgai_instruments.json').instruments;
  const norm = value => String(value).trim().replace(/\s+/g, ' ').toLowerCase();
  for (const [ticker, label] of Object.entries(labels)) {
    const matches = catalog.filter(item => [item.sourceLabel, item.ticker, ...(item.aliases || [])].some(value => norm(value) === norm(label)));
    assert.deepEqual(matches.map(item => item.ticker), [ticker], label);
  }
});
