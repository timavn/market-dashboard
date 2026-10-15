const test = require('node:test');
const assert = require('node:assert/strict');
const { describeAnalystFinding, typedAnalystSignal } = require('./analystFindingPresentation.cjs');

const tradeProvenance = value => ({ field: 'trade', method: 'explicit-field',
  sourceField: 'data.AMZN.trade', sourceText: `AMZN Trade ${value}` });

const finding = (overrides = {}) => ({
  symbol: 'AMZN',
  action: 'signal change',
  event: {
    entityId: 'AMZN', entityType: 'ticker', productKey: 'risk-ranges', productLabel: 'Risk Ranges',
    eventType: 'risk_range', signalValue: 'BEARISH', fieldPath: 'data.AMZN', qualityStatus: 'validated',
    sourceMessageId: 'today', publishedAt: '2026-09-14T00:00:00Z', marketDate: '2026-09-14',
    ...overrides,
  },
  summary: 'Risk Ranges reported signal change for AMZN. Verified holding: 15. Reading this finding does not confirm a trade.',
  state: 'pending verification', marketSession: 'open', holdingsVerifiedAt: '2026-09-14T19:02:36.957411Z',
});
const prior = (overrides = {}) => finding({ signalValue: 'BULLISH', sourceMessageId: 'prior', publishedAt: '2026-09-11T00:00:00Z', marketDate: '2026-09-11', ...overrides });

test('legacy Trade event kinds cannot promote copied Trend, fabricated labels, or source actions to directional Trade', () => {
  for (const eventType of ['trade_signal', 'tracker_trade', 'signal_change']) {
    const base = finding({ eventType, fieldPath: 'data.AMZN.trade', signalValue: 'BULLISH' }).event;
    for (const patch of [
      {}, { excerpt: 'Trade BULLISH' }, { excerpt: 'AMZN: {"trend":"BULLISH"}' },
      { signalProvenance: { ...tradeProvenance('BULLISH'), field: 'trend' } },
      { signalValue: 'SELL', signalProvenance: tradeProvenance('SELL') },
      { signalValue: 'LONG', signalProvenance: tradeProvenance('LONG') },
      { excerpt: 'MSFT Trade is Bullish.' }, { excerpt: 'AMZN could be Bullish on Trade.' },
      { mock: true, signalProvenance: tradeProvenance('BULLISH') },
      { stale: true, signalProvenance: tradeProvenance('BULLISH') },
      { cacheOnly: true, signalProvenance: tradeProvenance('BULLISH') },
    ]) assert.equal(typedAnalystSignal({ ...base, ...patch }), null, JSON.stringify({ eventType, patch }));
  }
  assert.deepEqual(typedAnalystSignal(finding({ signalValue: 'LONG' }).event), { field: 'trend', value: 'BULLISH' });
  const action = { ...finding({ eventType: 'trade_signal', signalValue: 'SELL', action: 'SELL' }), action: 'exit',
    alertContext: { kind: 'source-action', changedAt: '2026-09-14', recordedPosition: { side: 'LONG' } } };
  assert.equal(describeAnalystFinding(action).headline, 'Sell');
});

test('Trade uses independent labeled fields or instrument-bound published prose from any product', () => {
  for (const productKey of ['momo-tracker', 'risk-ranges', 'early-look', 'the-call']) {
    const event = finding({ productKey, eventType: 'trade_signal', signalValue: 'BULLISH', signalProvenance: tradeProvenance('BULLISH') }).event;
    assert.deepEqual(typedAnalystSignal(event), { field: 'trade', value: 'BULLISH' });
    assert.deepEqual(typedAnalystSignal({ ...event, signalProvenance: undefined, sourceText: 'AMZN Trade is Bearish.' }), { field: 'trade', value: 'BEARISH' });
  }
});

test('Current position requires fresh verified holdings rather than the alert’s historical side', () => {
  const now = Date.parse('2026-09-15T01:00:00Z');
  const payload = { ...finding(), holdingsVerified: true, quantity: 10, holdingsVerifiedAt: new Date(now - 30_000).toISOString(),
    alertContext: { recordedPosition: { side: 'SHORT', asOf: '2026-09-01' } } };
  for (const [quantity, label] of [[10, 'Long'], [-10, 'Short'], [0, 'Closed']]) {
    assert.deepEqual(describeAnalystFinding({ ...payload, quantity }, [], now).currentPosition, { label, asOf: payload.holdingsVerifiedAt });
  }
  for (const override of [
    { holdingsVerified: false }, { holdingsVerified: undefined }, { quantity: null }, { quantity: '10' }, { quantity: NaN },
    { holdingsVerifiedAt: 'invalid' }, { holdingsVerifiedAt: new Date(now - 60_001).toISOString() },
    { holdingsVerifiedAt: new Date(now + 30_001).toISOString() },
  ]) assert.deepEqual(describeAnalystFinding({ ...payload, ...override }, [], now).currentPosition, { label: 'Unavailable', asOf: null });
});

test('SJM’s exact report instruction qualifies the headline Sell as Sell some without a bearish reversal', () => {
  const report = { sourceMessageId: 'sjm-source', publicationDate: '2026-09-14', contentHash: 'verified-report-content',
    title: 'Real-Time Alert: Sell-SOME Signals (Raising More Cash): SJM -KM',
    bodyText: 'SELL SIGNAL SJM $121.95\nPortfolio Managers should be selling-SOME of Bullish TRENDs that are green today...\nCoaching Notes: I sold 4 Macro positions.',
  };
  const payload = { ...finding(), symbol: 'SJM', action: 'exit', quantity: 10, holdingsVerified: true,
    holdingsVerifiedAt: '2026-09-15T01:00:00Z',
    alertContext: { kind: 'source-action', changedAt: '2026-09-14', recordedPosition: { side: 'LONG' } },
    event: { ...finding().event, entityId: 'SJM', eventType: 'position_change', sourceMessageId: 'sjm-source', action: 'SELL',
      excerpt: JSON.stringify({ ticker: 'SJM', action: 'SELL', signalPhrase: 'SELL SIGNAL SJM' }), sourceReport: report },
  };
  const result = describeAnalystFinding(payload, [], Date.parse('2026-09-15T01:00:30Z'));
  assert.equal(result.currentPosition.label, 'Long');
  assert.equal(result.headline, 'Sell some');
  assert.equal(result.updateLabel, 'Action');
  assert.equal(result.sourceSummary, 'Portfolio Managers should be selling-SOME of Bullish TRENDs that are green today');
  assert.equal(result.detail, 'Trend remains bullish.');
  assert.doesNotMatch(result.headline + result.detail, /goes against|sell signal update|bearish|exit/i);
  assert.equal(payload.event.action, 'SELL', 'preserve the original parsed headline');
  for (const override of [
    { sourceMessageId: 'different-report' }, { publicationDate: '2026-09-11' }, { contentHash: '' },
    { entityId: 'OTHER' }, { sourceContentSha256: 'different-revision' },
    { title: 'SELL SIGNAL SJM', bodyText: 'We sold some yesterday. Another report says selling-SOME.' },
    { title: 'Do not sell some', bodyText: 'Portfolio Managers should not be selling-SOME today.' },
  ]) {
    const excluded = describeAnalystFinding({ ...payload, event: { ...payload.event, sourceReport: { ...report, ...override } } });
    assert.equal(excluded.headline, 'Sell');
    assert.equal(excluded.sourceSummary, '');
  }
  const bodyOnly = describeAnalystFinding({ ...payload, event: { ...payload.event, sourceReport: { ...report, title: 'SELL SIGNAL SJM' } } });
  assert.equal(bodyOnly.headline, 'Sell some');
  const fullExit = describeAnalystFinding({ ...payload, event: { ...payload.event, action: 'EXIT', excerpt: undefined } });
  assert.equal(fullExit.headline, 'Exit the position', 'a generic coaching instruction cannot override an explicit full exit');
});

function reportFinding(symbol, reportChanges = {}, eventChanges = {}) {
  return { ...finding(), symbol, action: 'cover',
    alertContext: { kind: 'source-action', changedAt: '2026-09-14', recordedPosition: { side: 'SHORT' } },
    event: { ...finding().event, entityId: symbol, productKey: 'real-time-alert', eventType: 'position_change',
      sourceMessageId: 'exact-report', contentSha256: 'source-revision', action: 'COVER-SOME',
      sourceReport: { entityId: symbol, sourceMessageId: 'exact-report', publicationDate: '2026-09-14',
        contentHash: 'indexed-report', sourceContentSha256: 'source-revision',
        title: `Cover-SOME Signal: ${symbol}`, ...reportChanges }, ...eventChanges },
  };
}

test('one attention scan segments exact shared report text once without sharing subject relevance', t => {
  const body = 'AMZN remains Bearish on Trend while MSFT has turned Bullish. MSFT benefits from improving demand because earnings growth has accelerated.';
  const first = reportFinding('AMZN', { title: 'Exact shared report', bodyText: body });
  const second = reportFinding('MSFT', { title: 'Exact shared report', bodyText: body });
  const revised = reportFinding('AMZN', { title: 'Exact shared report', bodyText: 'AMZN remains Bullish on Trend because earnings growth has improved.' });
  const now = Date.parse('2026-09-15T01:00:30Z');
  const expected = [first, second, revised].map(value => describeAnalystFinding(value, [], now));
  let segments = 0;
  const original = Intl.Segmenter.prototype.segment;
  t.mock.method(Intl.Segmenter.prototype, 'segment', function (line) { segments += 1; return original.call(this, line); });
  const memo = new Map();
  assert.deepEqual(describeAnalystFinding(first, [], now, memo), expected[0]);
  assert.deepEqual(describeAnalystFinding(second, [], now, memo), expected[1]);
  assert.equal(segments, 1);
  assert.deepEqual(describeAnalystFinding(revised, [], now, memo), expected[2]);
  assert.equal(segments, 2, 'a revised body is separately segmented');
  assert.deepEqual(describeAnalystFinding(first, [], now, new Map()), expected[0]);
  assert.equal(segments, 3, 'a later scan never reuses retained report text');
});

test('Context keeps relevant cross-ticker observations from the exact report’s summary, bullets, and notes', () => {
  const cases = [
    ['WING', 'Coaching Notes:\n\nWhile SPY has bounced "off the lows" today, nothing about its Bearish TRADE Setup/Signal has changed'],
    ['HIMS', 'Summary:\nWith our Healthcare (XLV) and Software (IGV) Sector Styles green today, we\'re getting a squeeze in a "healthcare" name like HIMS...'],
    ['CAT', 'Coaching Notes:\n• Immediate-term TRADE Signal Resistance for SPX = 7662'],
    ['SAIA', 'Notes:\n1. I haven\'t sent you any Buy Signals because SPY broke immediate-term TRADE Signal Support alongside the Russell (IWM)'],
  ];
  for (const [symbol, bodyText] of cases) {
    const content = describeAnalystFinding(reportFinding(symbol, { bodyText }));
    assert.equal(content.sourceContext.length, 1, symbol);
    assert.doesNotMatch(content.sourceContext[0], /^The report says:|^[“”]|[“”]$/);
    assert.doesNotMatch(content.sourceContext[0], /Coaching Notes:|Summary:|Notes:|•|1\./);
    assert.match(content.sourceContext[0], symbol === 'HIMS' ? /Healthcare \(XLV\).*Software \(IGV\).*HIMS/ : /SP[XY]/);
    assert.equal(content.currentPosition.label, 'Unavailable', 'a source observation does not establish current holdings');
    assert.equal(content.headline, 'Close part of the short position', 'related ticker prose does not replace the action');
  }
});

test('Context prioritizes the explicit holding relationship and avoids repeating the same ticker’s commentary', () => {
  const relationship = "If you're looking to hedge Long META and/or his mucho Software Stock gains today, he'd go with CHTR";
  const content = describeAnalystFinding(reportFinding('CHTR', { bodyText: [
    'What a pivot by the Signaling Process back to long of META for Freedbird!',
    'META remains Bullish on Trend.',
    'Coaching Notes:', relationship,
    'Separately, TSLA remains Bearish on Trend.',
    'I sold 4 Macro positions, so I have raised a lot of cash.',
    'WHEN US Equity Beta is Bearish TRADE, you get paid to have A) patience and B) hedges',
    'AFTER going to 2 Long, 6 Shorts in RTA (on Friday), I\'ve only had signals to cover-SOME on red...',
    'The watchlist today is MSFT, AMZN, NFLX and NVDA.',
    'TRADE = 3 weeks or less',
    'Please visit https://app.hedgeye.com/feed_items/12345',
  ].join('\n\n') }));
  assert.deepEqual(content.sourceContext, [relationship]);
});

test('Context uses structured source sections when supplied and deduplicates their body copies', () => {
  const summary = 'AMZN remains Bearish on Trend while MSFT has turned Bullish.';
  const bullet = 'With SPY breaking Trade support, the short position remains a hedge against market weakness.';
  const payload = reportFinding('AMZN', { summary, bulletPoints: [bullet, 'NVDA, QQQ and META are on the watchlist.'],
    bodyText: `${summary}\n\n${bullet}` });
  const before = JSON.stringify(payload);
  assert.deepEqual(describeAnalystFinding(payload).sourceContext, [
    summary, bullet,
  ]);
  assert.equal(JSON.stringify(payload), before);
});

test('Context recognizes verified subject symbols and explicit dollar tickers despite ordinary-word ambiguity', () => {
  for (const symbol of ['R', 'NOW']) {
    const sentence = `${symbol} remains Bearish on Trend while $A is outperforming.`;
    assert.deepEqual(describeAnalystFinding(reportFinding(symbol, { bodyText: sentence })).sourceContext,
      [sentence]);
  }
});

test('Context excludes unverified, mismatched, unrelated, and duplicate source details', () => {
  const bodyText = 'AMZN remains Bearish on Trend while MSFT has turned Bullish.';
  for (const reportChanges of [
    { sourceMessageId: 'another-message' }, { publicationDate: '2026-09-11' },
    { sourceContentSha256: 'another-revision' }, { contentHash: '' }, { entityId: 'MSFT' },
  ]) assert.equal(describeAnalystFinding(reportFinding('AMZN', { bodyText, ...reportChanges })).sourceContext, undefined);
  assert.equal(describeAnalystFinding(reportFinding('AMZN', { bodyText }, { qualityStatus: 'failed' })).sourceContext, undefined);
  const unrelated = reportFinding('AMZN', {
    bodyText: 'Here are some coaching notes for today.\nI sold 4 Macro positions.\nMSFT, SPY, QQQ, XLV and IGV.\nSeparately, NVDA remains bullish on Trend.',
  });
  unrelated.event.excerpt = JSON.stringify({ ticker: 'AMZN', action: 'COVER-SOME', context: bodyText });
  assert.equal(describeAnalystFinding(unrelated).sourceContext, undefined, 'unverified structured context cannot replace the exact report');
  const instruction = 'Portfolio Managers should be selling-SOME of Bullish TRENDs that are green today';
  const partialSale = reportFinding('SJM', { bodyText: `${instruction}.`, title: 'Sell-SOME Signal: SJM' }, { action: 'SELL' });
  assert.equal(describeAnalystFinding(partialSale).sourceSummary, instruction);
  assert.equal(describeAnalystFinding(partialSale).sourceContext, undefined, 'the source instruction must not be duplicated in Context');
});

function transition({ previous = 'NEUTRAL', value = 'BEARISH', side = 'LONG', eventType = 'risk_range', proxy = false } = {}) {
  const { buildAnalystInbox } = require('./analystInboxAlerts.cjs');
  const rows = [['before', '2026-09-09', previous], ['change', '2026-09-10', value], ['latest', '2026-09-14', value]].map(([id, date, signalValue]) => {
    const symbol = proxy ? 'IWM' : 'AMZN';
    const payload = finding({ entityId: symbol, eventType, signalValue, sourceMessageId: id,
      ...(['trade_signal', 'tracker_trade'].includes(eventType) ? { signalProvenance: tradeProvenance(signalValue) } : {}),
      fieldPath: `data.${proxy ? 'RUT' : symbol}`, publishedAt: `${date}T00:00:00Z`, marketDate: date,
      sourceUrl: `https://app.hedgeye.com/feed_items/${id}`,
      ...(proxy ? { matchedText: 'RUT', matchType: 'structured_membership', excerpt: 'RUT: {"originalName":"Russell 2000"}' } : {}),
    });
    return { id, symbol, action: 'signal change', unread: 1, payload: { ...payload, symbol,
      quantity: side === 'SHORT' ? -15 : 15, holdingsVerified: Boolean(side), holdingsVerifiedAt: '2026-09-14T19:00:00Z',
      citation: { sourceUri: payload.event.sourceUrl, publicationDate: date },
    } };
  });
  return buildAnalystInbox({ findings: rows }, '2026-09-14T21:00:00Z').findings[0];
}

test('PM alert distinguishes the changed report from later confirmation and links both sides', () => {
  const row = transition();
  const content = describeAnalystFinding(row);
  assert.equal(content.headline, 'Trend: Neutral → Bearish');
  assert.equal(content.changeSummary, 'First reported Sep 10, after Neutral on Sep 9. Confirmed Bearish Sep 14.');
  assert.equal(content.sourceLabel, 'Hedgeye Risk Ranges');
  assert.equal(content.publicationDate, '2026-09-10T00:00:00Z');
  assert.equal(content.detail, 'Trend has weakened further for your long position. If Trade is Bullish, both Neutral and Bearish Trend call for your minimum size.');
  assert.deepEqual(content.headlineParts, [
    { text: 'Trend: ', tone: 'neutral' }, { text: 'Neutral', tone: 'neutral' },
    { text: ' → ', tone: 'neutral' }, { text: 'Bearish', tone: 'negative' },
  ]);
  assert.equal(content.updateLabel, 'Trend');
  assert.deepEqual(content.updateParts, [
    { text: 'Neutral', tone: 'neutral' }, { text: ' → ', tone: 'neutral' }, { text: 'Bearish', tone: 'negative' },
  ]);
  assert.deepEqual(content.sourceLinks.map(link => [link.label, link.citation.sourceUri]), [
    ['Sep 9 source', 'https://app.hedgeye.com/feed_items/before'],
    ['Sep 10 source', 'https://app.hedgeye.com/feed_items/change'],
    ['Sep 14 source', 'https://app.hedgeye.com/feed_items/latest'],
  ]);
  assert.doesNotMatch(content.detail, /sell|exit|target|\d+%/i);
});

test('PM relevance respects long versus short, conditional sizing, and unknown holdings', () => {
  assert.match(describeAnalystFinding(transition({ previous: 'BULLISH', value: 'NEUTRAL' })).detail, /long position lost Trend support\. If Trade is Bullish, your process calls for your minimum size/);
  assert.match(describeAnalystFinding(transition({ side: 'SHORT' })).detail, /Trend now supports your short position.*depends on Bearish Trade/);
  assert.match(describeAnalystFinding(transition({ side: 'SHORT', previous: 'BEARISH', value: 'NEUTRAL' })).detail, /short position lost Trend support\. If Trade is Bearish/);
  assert.match(describeAnalystFinding(transition({ previous: 'BULLISH', eventType: 'trade_signal' })).detail, /Trade now opposes your long position.*confirmed loss of Trade support.*exit rule/);
  assert.match(describeAnalystFinding(transition({ previous: 'BULLISH', value: 'NEUTRAL', eventType: 'trade_signal' })).detail, /Trade no longer supports your long position/);
  assert.equal(describeAnalystFinding(transition({ side: null })).detail, '');
});

test('an index signal is explicitly a proxy and cannot establish the held ETF’s own signal', () => {
  const content = describeAnalystFinding(transition({ side: 'SHORT', proxy: true }));
  assert.equal(content.headline, 'RUT Trend: Neutral → Bearish');
  assert.equal(content.updateLabel, 'RUT Trend');
  assert.equal(content.updateParts.map(part => part.text).join(''), 'Neutral → Bearish');
  assert.deepEqual(content.proxyAttribution, { sourceSymbol: 'RUT', sourceName: 'Russell 2000', holdingSymbol: 'IWM' });
  assert.equal(content.detail, 'RUT now supports your short position. This is an index proxy; check IWM’s own Trade signal before changing size.');
  assert.doesNotMatch(content.detail, /MAX|MIN|IWM.*(?:turned|is) Bearish/);
  assert.match(describeAnalystFinding(transition({ side: 'SHORT', proxy: true, previous: 'BULLISH', value: 'NEUTRAL' })).detail, /RUT has moved less strongly against your short position/);
});

test('proxy names come only from a structured source row for the reported instrument', () => {
  const row = transition({ proxy: true });
  for (const excerpt of ['NDX: {"originalName":"Nasdaq 100"}', '{"ticker":"SPX","originalName":"S&P 500"}', 'Russell 2000 is bullish', 'RUT: not JSON']) {
    const result = describeAnalystFinding({ ...row, payload: { ...row.payload, event: { ...row.payload.event, excerpt } } });
    assert.deepEqual(result.proxyAttribution, { sourceSymbol: 'RUT', sourceName: null, holdingSymbol: 'IWM' });
    assert.equal(result.headline, 'RUT Trend: Neutral → Bearish');
  }
  const named = describeAnalystFinding({ ...row, payload: { ...row.payload,
    event: { ...row.payload.event, excerpt: '{"ticker":"RUT","originalName":"Russell 2000"}' },
  } });
  assert.equal(named.proxyAttribution.sourceName, 'Russell 2000');
  assert.equal(describeAnalystFinding(transition()).proxyAttribution, undefined);
  const invalid = describeAnalystFinding({ ...row, payload: { ...row.payload, event: { ...row.payload.event, qualityStatus: 'failed' } } });
  assert.equal(invalid.proxyAttribution, undefined);
});

test('projected transitions use their own prior evidence rather than a different publisher’s newer alert', () => {
  const row = transition();
  const unrelated = finding({ sourceUrl: 'https://other-publisher.example/report', signalValue: 'BULLISH', publishedAt: '2026-09-09T12:00:00Z' });
  assert.equal(describeAnalystFinding(row, [unrelated]).headline, 'Trend: Neutral → Bearish');
});

test('source Sell and Cover-SOME retain their meaning in attributed plain English', () => {
  const payload = { ...finding(), action: 'exit',
    alertContext: { kind: 'source-action', changedAt: '2026-09-08T00:00:00Z', recordedPosition: { side: 'SHORT' } },
    event: { ...finding().event, eventType: 'position_change', sourceUrl: 'https://app.hedgeye.com/feed_items/source',
      productLabel: 'Real-Time Alerts', excerpt: JSON.stringify({ ticker: 'AMZN', action: 'SELL', signalPhrase: 'Van Sciver Sell', context: 'SPY breaking TRADE' }),
    },
  };
  const sell = describeAnalystFinding(payload);
  assert.equal(sell.headline, 'Sell');
  assert.equal(sell.detail, '');
  assert.equal(sell.sourceLabel, 'Hedgeye Real-Time Alerts');
  assert.deepEqual(sell.headlineParts, [{ text: 'Sell', tone: 'negative' }]);
  assert.equal(sell.updateLabel, 'Action');
  assert.deepEqual(sell.updateParts, [{ text: 'Sell', tone: 'negative' }]);
  assert.doesNotMatch(sell.headline, /Hedgeye|:/);
  assert.equal(sell.publicationDate, '2026-09-08T00:00:00Z');
  assert.doesNotMatch(sell.headline + sell.detail, /exit|cover|AMZN.*Trade/i);
  const cover = describeAnalystFinding({ ...payload, action: 'cover', event: { ...payload.event,
    excerpt: JSON.stringify({ ticker: 'AMZN', action: 'COVER', signalPhrase: 'Cover-SOME', context: 'my first move on red is to...' }),
  } });
  assert.equal(cover.headline, 'Close part of the short position');
  assert.equal(cover.updateLabel, 'Action');
  assert.deepEqual(cover.updateParts, [{ text: 'Close part of the short position', tone: 'neutral' }]);
  assert.equal(cover.detail, '');
  assert.equal(cover.tone, 'neutral');
  assert.doesNotMatch(cover.detail, /\ball\b|exit|first move/);
});

test('source-action Context omits repeated position reductions while retaining meaningful exceptions', () => {
  for (const [action, side] of [
    ['SELL', 'LONG'], ['SELL-SOME', 'LONG'], ['COVER', 'SHORT'], ['COVER-SOME', 'SHORT'],
    ['TRIM', 'LONG'], ['TRIM', 'SHORT'], ['EXIT', 'LONG'], ['EXIT', 'SHORT'],
  ]) {
    const payload = reportFinding('WING', {}, { action });
    payload.alertContext.recordedPosition.side = side;
    assert.equal(describeAnalystFinding(payload).detail, '', `${action} ${side}`);
  }
  for (const [action, side, expected] of [
    ['SELL-SOME', 'SHORT', 'Sell instruction applies to long positions.'],
    ['COVER', 'LONG', 'Cover instruction applies to short positions.'],
    ['COVER-SOME', 'LONG', 'Cover instruction applies to short positions.'],
    ['ROSTER-REMOVAL', 'LONG', 'Removed from the source roster.'],
  ]) {
    const payload = reportFinding('WING', {}, { action });
    payload.alertContext.recordedPosition.side = side;
    assert.equal(describeAnalystFinding(payload).detail, expected, `${action} ${side}`);
  }
  const context = 'While SPY has bounced "off the lows" today, nothing about its Bearish TRADE Setup/Signal has changed';
  const payload = reportFinding('WING', { bodyText: `Coaching Notes:\n${context}` });
  const content = describeAnalystFinding(payload);
  assert.equal(content.detail, '');
  assert.deepEqual(content.sourceContext, [context], 'keep useful report context directly, with its original wording and quotes');
});

test('another ticker’s structured action cannot replace the subject’s action', () => {
  const payload = { ...finding(), action: 'cover', alertContext: { kind: 'source-action', changedAt: '2026-09-08', recordedPosition: { side: 'SHORT' } },
    event: { ...finding().event, action: 'COVER', excerpt: JSON.stringify({ ticker: 'CAT', action: 'SELL', signalPhrase: 'Van Sciver Sell' }) },
  };
  assert.equal(describeAnalystFinding(payload).headline, 'Close the short position');
});

test('Sell-SOME preserves the partial-sale meaning and omits execution filler', () => {
  const payload = { ...finding(), action: 'exit',
    alertContext: { kind: 'source-action', changedAt: '2026-09-09', recordedPosition: { side: 'LONG' } },
    event: { ...finding().event, action: 'SELL-SOME', excerpt: JSON.stringify({ ticker: 'AMZN', action: 'SELL-SOME', signalPhrase: 'Sell-SOME', context: 'execute across your portfolio' }) },
  };
  const content = describeAnalystFinding(payload);
  assert.equal(content.headline, 'Sell some');
  assert.equal(content.detail, '');
  assert.doesNotMatch(content.detail, /exit|execute/);
  assert.equal(describeAnalystFinding({ ...payload, action: 'trim', event: { ...payload.event, excerpt: 'Real-Time Alert: Sell-SOME' } }).headline, 'Sell some');
});

test('a dated adverse Trade report takes priority over conditional Trend sizing for the same holding', () => {
  const trend = transition();
  const trade = transition({ previous: 'BULLISH', value: 'NEUTRAL', eventType: 'trade_signal' });
  trade.payload.event.productLabel = 'MOMO Tracker';
  trade.payload.alertContext.latestEvent = { ...trade.payload.event, publishedAt: '2026-09-09T00:00:00Z' };
  trade.payload.alertContext.latestCitation = { sourceUri: 'https://app.hedgeye.com/feed_items/trade', publicationDate: '2026-09-09' };
  const content = describeAnalystFinding(trend, [trend, trade]);
  assert.equal(content.detail, 'Trend has weakened further for your long position. Hedgeye MOMO Tracker reported Neutral Trade on Sep 9. Your Trade rule takes priority over Trend sizing.');
  assert.equal(content.sourceLinks.at(-1).label, 'Sep 9 Trade source');
  assert.equal(content.sourceLinks.at(-1).citation.sourceUri, 'https://app.hedgeye.com/feed_items/trade');
  assert.doesNotMatch(content.detail, /If Trade is Bullish|both.*minimum size/);
  const otherTicker = { ...trade, symbol: 'MSFT' };
  assert.match(describeAnalystFinding(trend, [otherTicker]).detail, /If Trade is Bullish/);
  const newer = { ...trade, payload: { ...trade.payload, alertContext: { ...trade.payload.alertContext,
    latestEvent: { ...trade.payload.alertContext.latestEvent, signalValue: 'BULLISH', publishedAt: '2026-09-14T00:00:00Z' },
  } } };
  assert.match(describeAnalystFinding(trend, [trade, newer]).detail, /If Trade is Bullish/);
});

test('saved findings identify the actual current signal without administrative or boilerplate copy', () => {
  const row = { payload: finding() };
  const original = JSON.stringify(row);
  assert.deepEqual(describeAnalystFinding(row), {
    currentPosition: { label: 'Unavailable', asOf: null },
    currentHolding: null, positionAction: 'Unavailable',
    headline: 'Trend: Bearish', detail: '', sourceLabel: 'Risk Ranges', publicationDate: '2026-09-14', tone: 'negative',
    headlineParts: [{ text: 'Trend: ', tone: 'neutral' }, { text: 'Bearish', tone: 'negative' }],
    updateLabel: 'Trend', updateParts: [{ text: 'Bearish', tone: 'negative' }],
  });
  assert.equal(JSON.stringify(row), original);
  assert.equal(describeAnalystFinding(finding({ eventType: 'trade_signal', signalValue: 'BULLISH', signalProvenance: tradeProvenance('BULLISH') })).headline, 'Trade: Bullish');
  assert.equal(describeAnalystFinding(finding({ signalValue: { trend: 'NEUTRAL', lrr: 100, hrr: 110 } })).headline, 'Trend: Neutral');
  assert.equal(describeAnalystFinding(finding({ signalValue: '', excerpt: 'A bullish signal changed to bearish.' })).headline, 'Signal details unavailable');
});

test('only the nearest earlier comparable publication establishes a signal transition', () => {
  assert.equal(describeAnalystFinding({ payload: finding() }, [{ payload: prior() }]).headline, 'Trend: Bullish → Bearish');
  assert.equal(describeAnalystFinding(finding(), [prior(), prior({ signalValue: 'BEARISH', publishedAt: '2026-09-12T00:00:00Z' })]).headline, 'Trend: Bearish');
  assert.equal(describeAnalystFinding(finding({ previousEvent: prior().event })).headline, 'Trend: Bullish → Bearish');
  for (const patch of [
    { entityId: 'MSFT' }, { productKey: 'early-look' }, { fieldPath: 'data.AMZN.trade' },
    { eventType: 'trade_signal' }, { qualityStatus: 'failed' }, { qualityStatus: 'unvalidated' },
    { publishedAt: undefined }, { publishedAt: 'invalid' }, { publishedAt: '2026-09-14T00:00:00Z' },
    { publishedAt: '2026-09-15T00:00:00Z' }, { sourceMessageId: undefined },
  ]) {
    assert.equal(describeAnalystFinding(finding(), [prior(patch)]).headline, 'Trend: Bearish', JSON.stringify(patch));
  }
  assert.equal(describeAnalystFinding(finding({ publishedAt: undefined }), [prior()]).headline, 'Trend: Bearish');
  assert.equal(describeAnalystFinding(finding(), [prior(), prior({ signalValue: 'NEUTRAL' })]).headline, 'Trend: Bearish');
});

test('unvalidated content cannot create an asserted signal or a guessed transition', () => {
  assert.equal(describeAnalystFinding(finding({ qualityStatus: 'failed' }), [prior()]).headline, 'Signal details unavailable');
  assert.equal(describeAnalystFinding(finding({ previousSignalValue: 'BULLISH' })).headline, 'Trend: Bearish');
  assert.equal(describeAnalystFinding(finding({ signalValue: undefined, value: undefined, direction: 'negative' })).headline, 'Signal details unavailable');
});

test('category values retain signal colors without repeating Trend or Trade labels', () => {
  for (const [eventType, updateLabel] of [['risk_range', 'Trend'], ['trade_signal', 'Trade']]) {
    const current = describeAnalystFinding(finding({ eventType, signalValue: eventType === 'trade_signal' ? 'BULLISH' : 'LONG',
      ...(eventType === 'trade_signal' ? { signalProvenance: tradeProvenance('BULLISH') } : {}) }));
    assert.equal(current.updateLabel, updateLabel);
    assert.deepEqual(current.updateParts, [{ text: 'Bullish', tone: 'positive' }]);
    const changed = describeAnalystFinding(transition({ eventType, previous: 'BULLISH', value: 'NEUTRAL' }));
    assert.equal(changed.updateLabel, updateLabel);
    assert.deepEqual(changed.updateParts, [
      { text: 'Bullish', tone: 'positive' }, { text: ' → ', tone: 'neutral' }, { text: 'Neutral', tone: 'neutral' },
    ]);
  }
});

test('unavailable category values preserve the existing copy without asserting a typed signal', () => {
  for (const event of [{ qualityStatus: 'failed' }, { qualityStatus: 'unvalidated' }, { signalValue: '' }]) {
    const result = describeAnalystFinding(finding(event));
    assert.equal(result.updateLabel, 'Signal');
    assert.deepEqual(result.updateParts, [{ text: 'Signal details unavailable', tone: 'neutral' }]);
  }
  const result = describeAnalystFinding({ ...finding({ qualityStatus: 'failed' }), action: 'exit', alertContext: { kind: 'source-action' } });
  assert.equal(result.updateLabel, 'Signal');
  assert.deepEqual(result.updateParts, [{ text: 'Source action details unavailable', tone: 'neutral' }]);
});

test('legacy source actions describe reports rather than new order instructions', () => {
  for (const [action, headline] of [['exit', 'Exit reported'], ['trim', 'Position reduction reported'], ['cover', 'Short closure reported'], ['roster removal', 'Removed from source roster']]) {
    assert.equal(describeAnalystFinding({ ...finding(), action }).headline, headline);
    assert.equal(describeAnalystFinding({ ...finding(), action }).tone, 'neutral');
    assert.equal(describeAnalystFinding({ ...finding(), action }).updateLabel, 'Action');
    assert.deepEqual(describeAnalystFinding({ ...finding(), action }).updateParts, [{ text: headline, tone: 'neutral' }]);
  }
});

test('Cheer Sell is a reported sell signal, without guessing a new action or repeating headline chatter', () => {
  const payload = { ...finding(), symbol: 'WING', action: 'exit',
    alertContext: { kind: 'source-action', changedAt: '2026-09-11', recordedPosition: { side: 'SHORT' } },
    event: { ...finding().event, entityId: 'WING', eventType: 'position_change', action: 'SELL', productLabel: 'Real-Time Alerts',
      sourceUrl: 'https://app.hedgeye.com/feed_items/187091',
      excerpt: JSON.stringify({ ticker: 'WING', action: 'SELL', signalFamily: 'Cheer', signalPhrase: 'Cheer Sell',
        context: 'who knows, who cares?', headline: 'Real-Time Alert: Cheer Sell Signal (who knows, who cares?): Wingstop (WING) -KM' }),
    },
  };
  const result = describeAnalystFinding(payload);
  assert.equal(result.headline, 'Sell');
  assert.equal(result.detail, '');
  assert.equal(result.tone, 'negative');
  assert.deepEqual(result.headlineParts, [{ text: 'Sell', tone: 'negative' }]);
  assert.doesNotMatch(JSON.stringify(result), /Cheer|who knows|source context|new sell|earlier sell|follow-up|exit/i);
  assert.match(payload.event.excerpt, /who knows, who cares/);
});

test('source action details need validated typed evidence and never borrow another ticker’s phrase', () => {
  const payload = { ...finding(), action: 'exit',
    alertContext: { kind: 'source-action', changedAt: '2026-09-11', recordedPosition: { side: 'LONG' } },
    event: { ...finding().event, eventType: 'position_change', action: 'SELL',
      excerpt: JSON.stringify({ ticker: 'OTHER', action: 'COVER', signalPhrase: 'Cover-SOME' }),
    },
  };
  assert.equal(describeAnalystFinding(payload).headline, 'Sell');
  for (const qualityStatus of ['failed', 'unvalidated', undefined]) {
    const result = describeAnalystFinding({ ...payload, event: { ...payload.event, qualityStatus } });
    assert.equal(result.headline, 'Source action details unavailable');
    assert.equal(result.detail, '');
    assert.equal(result.tone, 'neutral');
  }
  const missing = describeAnalystFinding({ ...payload, event: { ...payload.event, action: undefined } });
  assert.equal(missing.headline, 'Source action details unavailable');
  assert.equal(missing.detail, '');
});

test('Sell is not changed into Exit and a partial cover is not changed into a full cover', () => {
  const payload = { ...finding(), action: 'exit',
    alertContext: { kind: 'source-action', changedAt: '2026-09-11', recordedPosition: { side: 'LONG' } },
    event: { ...finding().event, eventType: 'position_change', action: 'SELL' },
  };
  assert.equal(describeAnalystFinding(payload).headline, 'Sell');
  assert.equal(describeAnalystFinding({ ...payload, event: { ...payload.event, action: 'EXIT' } }).headline, 'Exit the position');
  for (const [action, headline] of [['COVER', 'Close the short position'], ['COVER-SOME', 'Close part of the short position']]) {
    const result = describeAnalystFinding({ ...payload, action: 'cover', event: { ...payload.event, action } });
    assert.equal(result.headline, headline);
    assert.equal(result.detail, 'Cover instruction applies to short positions.');
    assert.equal(result.tone, 'neutral');
  }
});

test('semantic signal colors describe the source assessment, regardless of the held side', () => {
  for (const side of ['LONG', 'SHORT']) {
    for (const [previous, value, tone] of [['NEUTRAL', 'BEARISH', 'negative'], ['BEARISH', 'BULLISH', 'positive'], ['BULLISH', 'NEUTRAL', 'neutral']]) {
      const result = describeAnalystFinding(transition({ side, previous, value }));
      assert.equal(result.tone, tone);
      assert.equal(result.headlineParts.at(-1).tone, tone);
      assert.equal(result.headlineParts.map(part => part.text).join(''), result.headline);
    }
  }
});

test('further adverse Trade changes do not claim a new loss of support', () => {
  for (const [side, value, rule] of [['LONG', 'BEARISH', 'exit'], ['SHORT', 'BULLISH', 'cover']]) {
    const result = describeAnalystFinding(transition({ side, value, previous: 'NEUTRAL', eventType: 'trade_signal' }));
    assert.match(result.detail, /Trade has weakened further/);
    assert.match(result.detail, new RegExp(`Your ${rule} rule is tied to the confirmed loss of Trade support`));
    assert.match(result.detail, /already absent in the earlier report/);
    assert.doesNotMatch(result.detail, /now opposes|triggers/);
  }
});

const inboxNow = Date.parse('2026-09-15T21:00:00Z');
const inboxAsOf = new Date(inboxNow - 10_000).toISOString();
const verifiedHolding = { weightPct: 0.934, source: 'ibkr', asOf: inboxAsOf, basis: 'absolute_market_value_over_net_liquidation' };
function sizingFinding(action = 'COVER-SOME', quantity = -25) {
  return { ...reportFinding('WING', {}, { action, sourceReport: undefined }), quantity, holdingsVerified: true,
    holdingsVerifiedAt: inboxAsOf, currentHolding: { ...verifiedHolding } };
}

test('current portfolio percentage uses verified current weight, absolute size, and sensible precision', () => {
  for (const [weightPct, label] of [[0.934, '0.93%'], [2, '2%'], [0.004, '<0.01%'], [0, '0%']]) {
    const payload = sizingFinding();
    const result = describeAnalystFinding({ ...payload, currentHolding: { ...verifiedHolding, weightPct } }, [], inboxNow);
    assert.equal(result.currentHolding.label, label);
    assert.equal(result.currentPosition.label, 'Short');
    assert.equal(result.currentHolding.asOf, inboxAsOf);
  }
  for (const patch of [
    { source: undefined }, { source: 'model' }, { basis: 'cost_basis' }, { weightPct: -1 },
    { weightPct: NaN }, { weightPct: '2.5' }, { weightPct: null }, { asOf: 'invalid' },
    { asOf: new Date(inboxNow - 60_001).toISOString() }, { asOf: new Date(inboxNow + 30_001).toISOString() },
  ]) assert.equal(describeAnalystFinding({ ...sizingFinding(), currentHolding: { ...verifiedHolding, ...patch } }, [], inboxNow).currentHolding, null);
  for (const patch of [{ holdingsVerified: false }, { quantity: null }, { holdingsVerifiedAt: 'invalid' }, { currentHolding: null }]) {
    assert.equal(describeAnalystFinding({ ...sizingFinding(), ...patch }, [], inboxNow).currentHolding, null);
  }
  assert.equal(describeAnalystFinding(sizingFinding(), [], inboxNow + 60_000).currentHolding, null);
});

test('size action normalizes source instructions against the current side and preserves partial versus full reports', () => {
  for (const [action, quantity, label, report] of [
    ['COVER-SOME', -25, 'Reduce position size', 'Close part of the short position'],
    ['COVER', -25, 'Reduce position size', 'Close the short position'],
    ['SELL-SOME', 25, 'Reduce position size', 'Sell some'],
    ['SELL', 25, 'Reduce position size', 'Sell'],
    ['EXIT', 25, 'Reduce position size', 'Exit the position'],
    ['TRIM', -25, 'Reduce position size', 'Reduce the position'],
    ['SELL', -25, 'Neutral — no change', 'Sell'],
    ['COVER-SOME', 25, 'Neutral — no change', 'Close part of the short position'],
    ['ROSTER-REMOVAL', 25, 'Neutral — no change', 'Removed from the source roster'],
  ]) {
    const result = describeAnalystFinding(sizingFinding(action, quantity), [], inboxNow);
    assert.equal(result.positionAction, label, action);
    assert.equal(result.headline, report, action);
    assert.equal(result.inboxReport, undefined, 'a separate Report row does not repeat the action');
  }
  for (const [action, quantity] of [['ADD', 25], ['INCREASE', -25], ['BUY', 25], ['SELL-SHORT', -25]]) {
    assert.equal(describeAnalystFinding(sizingFinding(action, quantity), [], inboxNow).positionAction, 'Increase position size');
  }
  const historicalSide = sizingFinding('COVER-SOME', 25);
  historicalSide.alertContext.recordedPosition.side = 'SHORT';
  assert.equal(describeAnalystFinding(historicalSide, [], inboxNow).positionAction, 'Neutral — no change');
  for (const patch of [{ holdingsVerified: false }, { quantity: 0 }, { holdingsVerifiedAt: 'invalid' }, { event: { qualityStatus: 'failed' } }]) {
    assert.equal(describeAnalystFinding({ ...sizingFinding(), ...patch }, [], inboxNow).positionAction, 'Unavailable');
  }
});

test('signal size actions require a matching current rule, never infer an increase or size a proxy', () => {
  const payload = { ...transition({ side: 'LONG', previous: 'BULLISH', value: 'BEARISH' }).payload,
    quantity: 25, holdingsVerified: true, holdingsVerifiedAt: inboxAsOf, currentHolding: { ...verifiedHolding, weightPct: 3 },
    rule: { holding: 'AMZN', heldSide: 'LONG', status: 'conflict', action: 'REDUCE', targetWeight: 1, trend: 'BEARISH' } };
  assert.equal(describeAnalystFinding(payload, [], inboxNow).positionAction, 'Reduce position size');
  assert.equal(describeAnalystFinding({ ...payload, rule: { ...payload.rule, action: 'EXIT', targetWeight: 0 } }, [], inboxNow).positionAction, 'Reduce position size');
  assert.equal(describeAnalystFinding({ ...payload, rule: { ...payload.rule, status: 'aligned' } }, [], inboxNow).positionAction, 'Neutral — no change');
  for (const patch of [
    { rule: null }, { rule: { ...payload.rule, heldSide: 'SHORT' } }, { rule: { ...payload.rule, holding: 'MSFT' } },
    { rule: { ...payload.rule, status: 'verification' } }, { rule: { ...payload.rule, trend: 'BULLISH' } },
    { rule: { ...payload.rule, targetWeight: 4 } }, { rule: { ...payload.rule, action: 'INCREASE' } },
    { currentHolding: null }, { holdingsVerified: false },
    { event: { ...payload.event, matchType: 'structured_membership', matchedText: 'SPX' } },
  ]) assert.equal(describeAnalystFinding({ ...payload, ...patch }, [], inboxNow).positionAction, 'Unavailable', JSON.stringify(patch));
});
