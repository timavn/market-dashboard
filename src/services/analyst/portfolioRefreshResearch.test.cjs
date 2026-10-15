const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const vm = require('node:vm');
const { capturePortfolioRefreshResearch, validatePortfolioRefreshRequest } = require('./portfolioRefreshResearch.cjs');

const REQUEST = { symbols: ['TLT', 'SPY'], marketDate: '2026-09-30', asOf: '2026-09-30T21:00:00Z' };
function snapshot(type, date, data, extra = {}) {
  return { snapshotType: type, date, data, article: { feedUrl: 'https://app.hedgeye.com/feed_items/123' },
    htmlSource: `hedgeye-email/messages/${date}/${type}/123.html`, ...extra };
}
function paged(pages) {
  const calls = [];
  return { calls, scan(params) {
    calls.push(params);
    const page = pages[calls.length - 1];
    return { promise: async () => { if (page instanceof Error) throw page; return page; } };
  } };
}
const capture = (db, extra = {}) => capturePortfolioRefreshResearch({ dynamodb: db, ...REQUEST, ...extra });
const actions = (result, symbol = 'TLT') => result.bySymbol[symbol].references.filter(ref => /change|alert/.test(ref.kind));
const coverage = (result, id) => result.coverage.products.find(product => product.id === id);

function captureWithLegacyExtractor({ cryptoOverride = null } = {}) {
  const filename = require.resolve('./portfolioRefreshResearch.cjs');
  const nativeRequire = createRequire(filename);
  const intelligence = nativeRequire('../../utils/securityIntelligence.cjs');
  const scope = { module: { exports: {} }, require: name => {
    if (name === 'node:crypto' && cryptoOverride) return cryptoOverride;
    if (name === '../../utils/securityIntelligence.cjs') return {
      ...intelligence, prepareStructuredReferenceMatchers: () => null,
      extractSnapshotReferences: (source, symbols, status, options = {}) => (
        intelligence.extractSnapshotReferences(source, symbols, status, {
          includeUnverifiedRiskRanges: options.includeUnverifiedRiskRanges,
        })
      ),
    };
    return nativeRequire(name);
  }, setTimeout, clearTimeout };
  // Exercise the same complete capture, disabling only its optional prepared
  // matching/skipped work. Compare JSON because this fixture has its own realm.
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), scope, { filename });
  return scope.module.exports.capturePortfolioRefreshResearch;
}

test('complete69-symbol captures preserve every legacy direct reference, action, publication and fingerprint', async () => {
  const symbols = ['SPY', 'SPX', 'QQQ', 'TLT', 'DDOG', 'GLD', 'USO', 'UUP', 'AM', 'PM', 'BRK.B',
    ...Array.from({ length: 58 }, (_, index) => `TEST${index}`)];
  const earlier = { ticker: 'TLT', action: 'COVER-SOME', side: 'Short', sourceMessageId: 'earlier',
    signalPhrase: 'Cover-SOME TLT', eventTime: '2026-09-30T18:00:00Z' };
  const latest = { ticker: 'TLT', action: 'SELL-SOME', side: 'Long', sourceMessageId: 'latest',
    signalPhrase: 'Sell-SOME TLT', eventTime: '2026-09-30T19:00:00Z' };
  const sources = [
    snapshot('the-macro-show', '2026-09-30', { notes: ['DDOG and GLD appeared beside USO and UUP.', 'TEST2 and TEST57; NOTSPY and TEST570 differ.'] },
      { article: { feedUrl: 'https://app.hedgeye.com/feed_items/101', bodyText: 'SPX and BRK.B led growth and technology. Gold and the US dollar held. 08:00 AM and 12:29 PM EDT.' } }),
    snapshot('risk-ranges', '2026-09-30', { SPY: { ticker: 'SPY', lrr: 590, hrr: 610, trend: 'Bullish', trade: 'Bearish' },
      AM: { ticker: 'AM', lrr: 17, hrr: 19, trend: 'Neutral' }, PM: { ticker: 'PM', lrr: 180, hrr: 200, trend: 'Bullish' } }),
    snapshot('real-time-alert', '2026-09-30', { alerts: [latest, earlier] },
      { gmailMessageId: 'latest', article: { feedUrl: 'https://app.hedgeye.com/feed_items/102', bodyText: 'Original latest source body mentions TLT and SPX.', publishedAt: '2026-09-30T19:00:00Z' } }),
    snapshot('etf-pro', '2026-09-29', { checkpointAvailable: true, rows: [{ ticker: 'BRK.B', side: 'Long' }],
      changes: [{ ticker: 'BRK.B', action: 'REMOVE', side: 'Long' }, { ticker: 'QQQ', action: 'ADD', side: 'Short' }] }),
    snapshot('bitcoin-trend-tracker', '2026-09-28', { stocks: { QQQ: { ticker: 'QQQ', trend: 'Bearish', buyTrade: 450, sellTrade: 500 } }, summary: 'QQQ and SPX are mentioned directly.' }, { reportType: 'crypto-quant' }),
    snapshot('signal-strength', '2026-09-27', { added: ['AM', 'PM', 'QQQ'], removed: ['TLT'] },
      { article: { feedUrl: 'https://app.hedgeye.com/feed_items/103', bodyText: 'Published at 08:00 AM and 12:29 PM EDT.' } }),
    snapshot('investing-ideas', '2026-09-26', { positions: [{ ticker: 'TLT', side: 'Long' }, { ticker: 'AM', side: 'Short' }] }, { positionCount: 2 }),
    snapshot('the-call', '2026-09-25', { longs: ['SPX'], shorts: ['GLD'], summary: 'SPX growth and GLD gold positions.' }, { seeded: true }),
  ];
  const pages = [{ Items: sources.slice(0, 4), LastEvaluatedKey: { date: '2026-09-26', snapshotType: 'investing-ideas' } }, { Items: sources.slice(4) }];
  const params = { ...REQUEST, symbols };
  const legacy = await captureWithLegacyExtractor()({ ...params, dynamodb: paged(pages) });
  const optimized = await capture(paged(pages), { symbols });
  assert.equal(symbols.length, 69);
  assert.deepEqual(JSON.parse(JSON.stringify(optimized)), JSON.parse(JSON.stringify(legacy)));
  assert.ok(Object.values(optimized.bySymbol).reduce((count, row) => count + row.references.length, 0) > 20);
  assert.ok(optimized.bySymbol.SPY.references.some(row => row.matchedText === 'SPX' && row.matchType === 'direct_alias'));
  assert.equal(optimized.bySymbol.PM.references.some(row => row.kind === 'summary_mention'), false);
  const capturedActions = actions(optimized);
  assert.equal(capturedActions.find(row => row.sourceMessageId === 'earlier').sourceEvidence.bodyText, null);
  assert.equal(capturedActions.find(row => row.sourceMessageId === 'latest').sourceEvidence.bodyText, 'Original latest source body mentions TLT and SPX.');
  assert.deepEqual(capturedActions.map(row => row.eventTime), [earlier.eventTime, latest.eventTime]);
});

test('narrative matching stays constant when a publication contains many separately captured actions', async () => {
  const NativeRegExp = RegExp;
  const nativeTest = NativeRegExp.prototype.test;
  let compiled = 0;
  let tested = 0;
  function CountedRegExp(pattern, flags) {
    if (String(pattern).startsWith('(^|[^A-Z0-9])')) compiled += 1;
    return new NativeRegExp(pattern, flags);
  }
  CountedRegExp.prototype = NativeRegExp.prototype;
  Object.setPrototypeOf(CountedRegExp, NativeRegExp);
  global.RegExp = CountedRegExp;
  NativeRegExp.prototype.test = function (value) {
    if (this.source.startsWith('(^|[^A-Z0-9])')) tested += 1;
    return nativeTest.call(this, value);
  };
  try {
    const symbols = ['SPY', 'SPX', 'TLT', 'GLD', 'DDOG', 'AM', 'PM',
      ...Array.from({ length: 62 }, (_, index) => `TEST${index}`)];
    const source = count => snapshot('real-time-alert', '2026-09-30', { alerts: Array.from({ length: count }, (_, index) => ({
      ticker: 'TLT', action: 'SELL-SOME', side: 'Long', signalPhrase: 'Sell some TLT',
      eventTime: `2026-09-30T18:00:${String(index).padStart(2, '0')}Z`,
    })) }, { article: { feedUrl: 'https://app.hedgeye.com/feed_items/123', bodyText: 'TLT and SPX were discussed alongside growth and gold.' } });
    await capture(paged([{ Items: [source(0)] }]), { symbols });
    const first = { compiled, tested };
    compiled = 0; tested = 0;
    const many = await capture(paged([{ Items: [source(50)] }]), { symbols });
    assert.deepEqual({ compiled, tested }, first);
    assert.equal(actions(many).length, 50);
    assert.ok(first.compiled > 60 && first.tested > 60);
  } finally {
    global.RegExp = NativeRegExp;
    NativeRegExp.prototype.test = nativeTest;
  }
});

test('the exact immutable publication hash is shared by manifest, roster and every captured reference', async () => {
  const crypto = require('node:crypto');
  let sourceHashes = 0;
  const cryptoOverride = { ...crypto, createHash(...args) {
    const hash = crypto.createHash(...args);
    const update = hash.update;
    hash.update = function (value, ...rest) {
      if (String(value).includes('"sourceRevision":"fingerprint-count-source"')) sourceHashes += 1;
      return update.call(this, value, ...rest);
    };
    return hash;
  } };
  const source = snapshot('investing-ideas', '2026-09-30', { positions: [{ ticker: 'TLT', side: 'Long' }] },
    { positionCount: 1, sourceRevision: 'fingerprint-count-source' });
  const result = await captureWithLegacyExtractor({ cryptoOverride })({ ...REQUEST, dynamodb: paged([{ Items: [source] }]) });
  assert.equal(sourceHashes, 1);
  assert.equal(result.publications.length, 1);
  assert.ok(result.bySymbol.TLT.references.length > 0);
  assert.ok(result.bySymbol.TLT.references.every(row => row.sourceContentHash === result.publications[0].contentHash));
  const expected = await capture(paged([{ Items: [source] }]));
  assert.deepEqual(JSON.parse(JSON.stringify(result)), JSON.parse(JSON.stringify(expected)));
});

test('scans every source page and keeps old explicit removals until a later source re-add', async () => {
  const removed = { ticker: 'TLT', action: 'REMOVE', side: 'Long', etf: 'Treasuries' };
  const added = { ticker: 'TLT', action: 'ADD', side: 'Long', etf: 'Treasuries' };
  const db = paged([
    { Items: [snapshot('etf-pro', '2026-06-02', { changes: [removed] })], LastEvaluatedKey: { date: '2026-06-02', snapshotType: 'etf-pro' } },
    { Items: [snapshot('etf-pro', '2026-09-29', { changes: [{ ticker: 'QQQ', action: 'ADD', side: 'Long' }] })], LastEvaluatedKey: { date: '2026-09-29', snapshotType: 'etf-pro' } },
    { Items: [snapshot('etf-pro', '2026-09-30', { changes: [added] })] },
  ]);
  const result = await capture(db);
  assert.equal(result.scanComplete, true);
  assert.equal(result.scope, 'available-source-archive');
  assert.equal(result.manifest.pages, 3);
  assert.equal(result.manifest.documentCount, 3);
  assert.equal(result.manifest.earliestDate, '2026-06-02');
  assert.deepEqual(actions(result).map(ref => [ref.marketDate, ref.value]), [['2026-06-02', removed], ['2026-09-30', added]]);
  assert.equal(coverage(result, 'etf-pro').status, 'checked');
  assert.equal(actions(result)[0].excerpt, 'REMOVE TLT — Long — Treasuries');
  assert.ok(actions(result).every(ref => ref.referenceOnly && !ref.executable && !ref.decisionEligible));
  assert.ok(db.calls.every(params => !params.FilterExpression && params.ConsistentRead));
  assert.deepEqual(db.calls[1].ExclusiveStartKey, { date: '2026-06-02', snapshotType: 'etf-pro' });
});

test('returns independent exact actions within a merged day, preserving partial scope and source identity', async () => {
  const old = { ticker: 'TLT', action: 'COVER-SOME', side: 'short', scope: 'partial', signalPhrase: 'Cover-SOME TLT',
    sourceMessageId: 'earlier', eventTime: '2026-09-30T13:00:00Z' };
  const latest = { ticker: 'TLT', action: 'SELL', side: 'short', signalPhrase: 'SELL Signal (shorting) TLT',
    sourceMessageId: 'latest', eventTime: '2026-09-30T14:00:00Z' };
  const result = await capture(paged([{ Items: [snapshot('real-time-alert', '2026-09-30', { alerts: [latest, old] },
    { gmailMessageId: 'latest', article: { feedUrl: 'https://app.hedgeye.com/feed_items/123', bodyText: 'Newest source body.' } })] }]));
  assert.deepEqual(actions(result).map(ref => ref.value), [old, latest]);
  assert.equal(actions(result)[0].sourceUrl, 'gmail://message/earlier');
  assert.equal(actions(result)[0].publishedAt, null);
  assert.equal(actions(result)[0].eventTime, old.eventTime);
  assert.equal(actions(result)[0].sourceEvidence.bodyText, null);
  assert.equal(actions(result)[1].sourceEvidence.bodyText, 'Newest source body.');
  assert.equal(result.diagnostics.some(row => row.code === 'ambiguous-source-action'), false);
});

test('checks Investing Ideas actions and complete rosters separately from ETF Pro', async () => {
  const positionChange = { ticker: 'TLT', action: 'REMOVE', side: 'long', signalPhrase: 'Remove TLT' };
  const result = await capture(paged([{ Items: [
    snapshot('investing-ideas', '2026-07-01', { positions: [{ ticker: 'TLT', side: 'Long' }] }, { positionCount: 1 }),
    snapshot('investing-ideas', '2026-08-01', { alerts: [positionChange], checkpointAvailable: false }),
    snapshot('etf-pro', '2026-08-01', { changes: [{ ticker: 'TLT', action: 'ADD', side: 'Long' }] }),
  ] }]));
  assert.equal(result.publications.length, 1);
  assert.deepEqual(result.publications[0].positions, [{ ticker: 'TLT', side: 'LONG' }]);
  assert.deepEqual(actions(result).map(ref => ref.productId).sort(), ['etf-pro', 'investing-ideas']);
  assert.equal(actions(result).find(ref => ref.productId === 'investing-ideas').kind, 'position_change');
  assert.deepEqual(actions(result).find(ref => ref.productId === 'investing-ideas').value, positionChange);
});

test('uses the actual ETF checkpoint rather than its later replayed materialized roster', async () => {
  const checkpoint = { eventTime: '2026-09-30T13:00:00Z', sourceMessageId: 'book', rows: [{ ticker: 'TLT', side: 'Long' }] };
  const result = await capture(paged([{ Items: [snapshot('etf-pro', '2026-09-30', {
    checkpointAvailable: true, checkpointEvents: [checkpoint], rows: [{ ticker: 'SPY', side: 'Long', sourceAction: 'ADD' }],
    changes: [{ ticker: 'TLT', side: 'Long', action: 'REMOVE', eventTime: '2026-09-30T14:00:00Z' }],
  })] }]));
  assert.equal(result.publications.length, 1);
  assert.deepEqual(result.publications[0].positions, [{ ticker: 'TLT', side: 'LONG' }]);
  assert.equal(result.publications[0].eventTime, checkpoint.eventTime);
  assert.equal(result.publications[0].sourceUrl, 'gmail://message/book');
  assert.equal(actions(result)[0].value.action, 'REMOVE');
});

test('preserves independent explicit Trend and Trade while withholding only disputed bounds', async () => {
  const invalid = { ticker: 'SPY', trend: 'Bearish', trade: 'Bullish', lrr: 610, hrr: 590 };
  const source = snapshot('risk-ranges', '2026-09-30', { SPY: invalid, TLT: { ticker: 'TLT', trend: 'Bullish', lrr: 85, hrr: 95 } });
  const result = await capture(paged([{ Items: [source] }]));
  const spy = result.bySymbol.SPY.references;
  assert.equal(spy.some(ref => /risk_range/.test(ref.kind)), false);
  assert.deepEqual(spy.find(ref => ref.kind === 'trend_signal').value, { trend: 'BEARISH' });
  assert.equal(spy.find(ref => ref.kind === 'trade_signal').value, 'BULLISH');
  assert.deepEqual(result.diagnostics.find(row => row.code === 'invalid-range-fields').observed, { lrr: 610, hrr: 590 });
  assert.deepEqual(result.bySymbol.TLT.references.find(ref => /risk_range/.test(ref.kind)).value, { lrr: 85, hrr: 95, trend: 'BULLISH' });
  assert.deepEqual(source.data.SPY, invalid);
});

test('never uses equal, boolean or missing range bounds as a valid range', async () => {
  for (const [low, high] of [[90, 90], [true, 90], [null, 90]]) {
    const result = await capture(paged([{ Items: [snapshot('risk-ranges', '2026-09-30', {
      TLT: { ticker: 'TLT', trend: 'Neutral', lrr: low, hrr: high },
    })] }]));
    assert.equal(result.bySymbol.TLT.references.some(ref => /risk_range/.test(ref.kind)), false);
    assert.equal(result.bySymbol.TLT.references.find(ref => ref.kind === 'trend_signal').direction, 'NEUTRAL');
  }
});

test('future, mock, seed, cache-only and failed source rows remain diagnostics, never portfolio facts', async () => {
  const rejected = [
    snapshot('etf-pro', '2026-10-01', { changes: [{ ticker: 'TLT', action: 'REMOVE', side: 'Long' }] }),
    ...[{ mock: true }, { seeded: true }, { cacheOnly: true }, { metadata: { status: 'mock-feed' } }, { status: 'failed' }]
      .map((flags, index) => snapshot('etf-pro', `2026-09-${String(20 + index).padStart(2, '0')}`,
        { changes: [{ ticker: 'TLT', action: 'REMOVE', side: 'Long' }] }, flags)),
  ];
  const result = await capture(paged([{ Items: rejected }]));
  assert.equal(result.scanComplete, true);
  assert.equal(result.manifest.documentCount, 0);
  assert.deepEqual(actions(result), []);
  assert.equal(coverage(result, 'etf-pro').status, 'partial');
  assert.ok(result.diagnostics.some(row => row.code === 'future-publication'));
  assert.equal(result.diagnostics.filter(row => row.code === 'unverified-source').length, 5);
});

test('rejects only unverified structured rows and makes their product coverage partial', async () => {
  const result = await capture(paged([{ Items: [snapshot('real-time-alert', '2026-09-30', { alerts: [
    { ticker: 'TLT', action: 'SELL', signalPhrase: 'SELL TLT', cache_only: true },
    { ticker: 'SPY', action: 'SELL-SOME', signalPhrase: 'SELL-SOME SPY', scope: 'partial' },
  ] })] }]));
  assert.equal(actions(result).length, 0);
  assert.equal(actions(result, 'SPY').length, 1);
  assert.equal(coverage(result, 'real-time-alert').status, 'partial');
  assert.equal(result.bySymbol.SPY.checkedProducts.includes('real-time-alert'), false);
  assert.equal(result.diagnostics.find(row => row.code === 'unverified-source-field').observed.cache_only, true);
});

test('Crypto Quant retains its explicit product identity and shares only the published tracker field schema', async () => {
  const source = snapshot('bitcoin-trend-tracker', '2026-08-12', {
    stocks: { TLT: { ticker: 'TLT', trend: 'Bearish', buyTrade: 85, sellTrade: 95 } },
  }, { reportType: 'crypto-quant' });
  const result = await capture(paged([{ Items: [source] }]));
  const trend = result.bySymbol.TLT.references.find(ref => ref.kind === 'trend_signal');
  assert.equal(trend.productId, 'crypto-quant');
  assert.equal(trend.direction, 'BEARISH');
  assert.equal(coverage(result, 'crypto-quant').documentCount, 1);
  assert.equal(coverage(result, 'bitcoin-trend-tracker').documentCount, 0);
  assert.equal(result.bySymbol.TLT.references.some(ref => ref.kind === 'trade_signal'), false);
});

test('recognizes an archived original PDF as source provenance without requiring a Gmail HTML artifact', async () => {
  const source = { snapshotType: 'bitcoin-trend-tracker', date: '2026-08-12', source: 'textract',
    pdfSource: 'hedgeye-pdfs/2026-08-12/bitcoin-tracker-2026-08-12-123400.pdf',
    data: { stocks: { TLT: { ticker: 'TLT', trend: 'Bearish' } } } };
  const result = await capture(paged([{ Items: [source] }]));
  assert.equal(result.manifest.documentCount, 1);
  assert.equal(result.bySymbol.TLT.references.find(ref => ref.kind === 'trend_signal').direction, 'BEARISH');
  assert.equal(result.diagnostics.some(row => row.code === 'source-provenance-missing'), false);
});

test('operational and unregistered rows cannot fabricate product failures, while genuine missing provenance remains partial', async () => {
  const result = await capture(paged([{ Items: [
    { snapshotType: 'global-quads', date: 'LATEST', data: { groups: {} } },
    { snapshotType: 'global-quads-health', date: 'LATEST', status: 'error' },
    { snapshotType: 'global-quads-history', date: 'a'.repeat(64), candidate: { groups: {} } },
    snapshot('unregistered-publication', '2026-09-30', { headline: 'Source publication' }),
    { snapshotType: 'momo-tracker', date: '2026-09-30', data: { TLT: { trend: 'Bearish' } } },
  ] }]));
  assert.equal(result.scanComplete, true);
  assert.equal(result.coverage.products.some(product => product.id.startsWith('global-quads')), false);
  assert.equal(result.coverage.products.some(product => product.id === 'unregistered-publication'), false);
  assert.equal(result.diagnostics.filter(row => row.code === 'non-publication-source-row').length, 3);
  assert.equal(result.diagnostics.filter(row => row.code === 'unregistered-source-product').length, 1);
  assert.equal(coverage(result, 'momo-tracker').status, 'partial');
  assert.deepEqual(coverage(result, 'momo-tracker').reasons, ['source-provenance-missing']);
  assert.equal(result.manifest.nonPublicationRows, 4);
});

test('malformed action fields do not discard independent reports and remain source diagnostics', async () => {
  const malformed = { ticker: 'TLT', action: 'REMOVE', side: 'Long' };
  const result = await capture(paged([{ Items: [snapshot('etf-pro', '2026-09-30', { changes: malformed }),
    snapshot('early-look', '2026-09-30', { SPY: { ticker: 'SPY', trend: 'Bullish', lrr: 590, hrr: 610 } })] }]));
  assert.equal(result.scanComplete, true);
  assert.equal(coverage(result, 'etf-pro').status, 'partial');
  assert.equal(coverage(result, 'early-look').status, 'checked');
  assert.deepEqual(result.diagnostics.find(row => row.code === 'source-action-rows-invalid').observed, malformed);
  assert.equal(result.bySymbol.SPY.references.find(ref => /risk_range/.test(ref.kind)).direction, 'BULLISH');
});

test('an unavailable later page preserves gathered source evidence and declares partial coverage', async () => {
  const result = await capture(paged([
    { Items: [snapshot('etf-pro', '2026-06-02', { changes: [{ ticker: 'TLT', action: 'REMOVE', side: 'Long' }] })], LastEvaluatedKey: { key: 'next' } },
    new Error('Offline'),
  ]));
  assert.equal(result.scanComplete, false);
  assert.equal(actions(result).length, 1);
  assert.deepEqual(result.coverage.reasons, ['archive-page-unavailable']);
  assert.ok(result.coverage.products.every(product => product.status === 'partial'));
  assert.deepEqual(result.bySymbol.TLT.checkedProducts, []);
});

test('empty complete scan and incomplete empty scan have distinct coverage', async () => {
  const complete = await capture(paged([{ Items: [] }]));
  const incomplete = await capture(paged([new Error('Offline')]));
  assert.equal(complete.scanComplete, true);
  assert.ok(complete.coverage.products.every(product => product.status === 'no_publications'));
  assert.equal(complete.manifest.earliestDate, null);
  assert.equal(incomplete.scanComplete, false);
  assert.ok(incomplete.coverage.products.every(product => product.status === 'partial'));
});

test('pagination loops, page limits and hanging scans yield explicit partial results', async () => {
  const loop = await capture(paged([
    { Items: [], LastEvaluatedKey: { key: 'repeat' } }, { Items: [], LastEvaluatedKey: { key: 'repeat' } },
  ]));
  assert.deepEqual(loop.coverage.reasons, ['archive-pagination-loop']);
  const limit = await capture(paged([{ Items: [], LastEvaluatedKey: { key: 'next' } }]), { maxPages: 1 });
  assert.deepEqual(limit.coverage.reasons, ['archive-page-limit']);
  let aborted = false;
  const deadline = await capture({ scan: () => ({ promise: () => new Promise(() => {}), abort: () => { aborted = true; } }) }, { deadlineMs: 10 });
  assert.equal(aborted, true);
  assert.deepEqual(deadline.coverage.reasons, ['archive-scan-deadline']);
});

test('duplicates collapse, independent products remain distinct, and conflicting snapshots are diagnosed', async () => {
  const etf = snapshot('etf-pro', '2026-06-02', { changes: [{ ticker: 'TLT', action: 'REMOVE', side: 'Long' }] });
  const idea = snapshot('investing-ideas', '2026-06-02', { alerts: [{ ticker: 'TLT', action: 'REMOVE', side: 'long' }] });
  const result = await capture(paged([{ Items: [etf, idea, etf] }]));
  assert.equal(result.manifest.documentCount, 2);
  assert.equal(actions(result).length, 2);
  const conflicting = await capture(paged([{ Items: [etf, { ...etf, data: { changes: [{ ticker: 'TLT', action: 'ADD', side: 'Long' }] } }] }]));
  assert.equal(actions(conflicting).length, 0);
  assert.equal(coverage(conflicting, 'etf-pro').status, 'partial');
  assert.ok(conflicting.diagnostics.some(row => row.code === 'ambiguous-source-revision'));
});

test('manifest hash is stable across scan order and changes with captured publication content', async () => {
  const first = snapshot('etf-pro', '2026-06-02', { changes: [{ ticker: 'TLT', action: 'REMOVE', side: 'Long' }] });
  const second = snapshot('early-look', '2026-09-30', { SPY: { ticker: 'SPY', trend: 'Bullish', lrr: 590, hrr: 610 } });
  const forward = await capture(paged([{ Items: [first, second] }]));
  const reversed = await capture(paged([{ Items: [second, first] }]));
  const changed = await capture(paged([{ Items: [first, { ...second, data: { SPY: { ticker: 'SPY', trend: 'Bearish', lrr: 590, hrr: 610 } } }] }]));
  assert.equal(forward.manifest.hash, reversed.manifest.hash);
  assert.notEqual(forward.manifest.hash, changed.manifest.hash);
});

test('validates capture scope and retains every symbol from books exceeding the generic API cap', async () => {
  assert.throws(() => validatePortfolioRefreshRequest({ ...REQUEST, symbols: undefined }), { statusCode: 400 });
  assert.throws(() => validatePortfolioRefreshRequest({ ...REQUEST, symbols: [''] }), { statusCode: 400 });
  assert.throws(() => validatePortfolioRefreshRequest({ ...REQUEST, marketDate: '2026-10-01' }), { statusCode: 400 });
  assert.throws(() => validatePortfolioRefreshRequest({ ...REQUEST, asOf: '2026-09-30T14:00:00' }), { statusCode: 400 });
  const symbols = Array.from({ length: 250 }, (_, index) => `TEST${index}`);
  const result = await capture(paged([{ Items: [] }]), { symbols });
  assert.equal(result.requestedSymbols.length, 250);
  assert.equal(Object.keys(result.bySymbol).length, 250);
});
