const test = require('node:test');
const assert = require('node:assert/strict');
const { buildAnalystInbox } = require('./analystInboxAlerts.cjs');

function finding(id, date, value, overrides = {}) {
  const { event = {}, payload = {}, ...row } = overrides;
  return {
    id, symbol: 'AMZN', action: 'signal change', unread: 1,
    payload: {
      quantity: 15, holdingsVerified: true, holdingsVerifiedAt: '2026-09-14T19:00:00Z',
      citation: { title: 'Risk Ranges', publicationDate: date, sourceUri: `https://app.hedgeye.com/feed_items/${id}` },
      ...payload,
      event: {
        entityId: 'AMZN', entityType: 'ticker', productKey: 'risk-ranges', productLabel: 'Risk Ranges',
        eventType: 'risk_range', fieldPath: 'data.AMZN', signalValue: value,
        qualityStatus: 'validated', publishedAt: `${date}T00:00:00Z`, marketDate: date,
        sourceMessageId: id, sourceUrl: `https://app.hedgeye.com/feed_items/${id}`,
        ...event,
      },
    },
    ...row,
  };
}
const prior = (overrides = {}) => finding('prior', '2026-09-08', 'BULLISH', overrides);
const flip = (overrides = {}) => finding('flip', '2026-09-09', 'BEARISH', overrides);
const confirmation = (overrides = {}) => finding('confirmation', '2026-09-14', 'BEARISH', overrides);

const attentionFinding = (id, overrides = {}) => ({
  id, unread: 1, payload: { attentionVersion: 1, state: 'open', kind: 'operational', priority: 0,
    publicationTime: '2026-09-22T15:30:00Z', fingerprint: `${id}-revision`,
    presentation: { subject: 'IB Gateway', date: '2026-09-22', rows: [{ label: 'Issue', text: 'Portfolio cannot refresh.' }] },
    ...overrides },
});

test('attention projection retires legacy publications and shows only open concerns in priority/date order', () => {
  const rows = [prior(), flip(), attentionFinding('watch', { kind: 'market', priority: 2 }),
    attentionFinding('old-incident', { publicationTime: '2026-09-21T15:30:00Z' }),
    attentionFinding('incident'), attentionFinding('resolved', { state: 'resolved' }),
    attentionFinding('unavailable', { state: 'unavailable' })];
  const output = buildAnalystInbox({ attentionVersion: 1, findings: rows });
  assert.deepEqual(output.findings.map(row => row.id), ['incident', 'old-incident', 'watch']);
  assert.equal(output.unread, 3);
  assert.deepEqual(buildAnalystInbox({ attentionVersion: 1, findings: [prior(), flip()] }).findings, []);
});

test('attention accepts top-level findings and preserves acknowledged active conditions without reopening', () => {
  const nested = attentionFinding('acknowledged');
  const topLevel = { id: nested.id, unread: 0, ...nested.payload };
  const result = buildAnalystInbox({ attentionVersion: 1, findings: [topLevel] });
  assert.equal(result.findings[0], topLevel);
  assert.equal(result.unread, 0);
  assert.equal(buildAnalystInbox({ findings: [prior(), flip(), nested] }).findings.length, 2);
});

test('saved review source exclusions and archive gaps never appear or count as unread', () => {
  const warnings = ['Monthly Inflation Nowcast', 'Bitcoin Tracker', 'IBKR account exposure', 'Risk Ranges', 'Portfolio research archive']
    .map((label, index) => attentionFinding(`excluded-${index}`, { managedBy: 'review-sources',
      diagnosisStage: index === 4 ? 'archive-partial' : 'recovered',
      presentation: { subject: label, rows: [{ label: 'Problem', text: `${label} was excluded from this saved review.` }] } }));
  const original = structuredClone(warnings);
  for (const attentionVersion of [undefined, 1]) {
    const input = { ...(attentionVersion ? { attentionVersion } : {}), findings: warnings, unread: warnings.length };
    assert.deepEqual(buildAnalystInbox(input).findings, []);
    assert.equal(buildAnalystInbox(input).unread, 0);
    // A reload may return a top-level record instead of the database envelope.
    const restored = warnings.map(row => ({ id: row.id, unread: row.unread, ...row.payload }));
    assert.equal(buildAnalystInbox({ ...input, findings: restored }).unread, 0);
  }
  assert.deepEqual(warnings, original);
});

test('research delivery and retired Hermes worker messages stay out through reloads without hiding the Analyst', () => {
  const keys = ['gmail.ingestion', 'research-verification', 'hermes.quant-analyst', 'hermes.quant-developer', 'hermes.security', 'hermes.status', 'dashboard.hermes-bridge'];
  const old = keys.map(key => attentionFinding(`attention:operations:${key}`));
  const analyst = attentionFinding('attention:operations:analyst.runtime');
  const source = attentionFinding('publication-discrepancy', { sourceDiscrepancy: true, sourceQuality: { issues: [{ code: 'invalid_bounds' }] } });
  const original = structuredClone(old);
  for (const attentionVersion of [undefined, 1]) {
    const input = { attentionVersion, findings: [...old, analyst, source], unread: 99 };
    const output = buildAnalystInbox(input);
    assert.deepEqual(output.findings.map(row => row.id), [analyst.id, source.id]);
    assert.equal(output.unread, 2);
    const restored = input.findings.map(row => ({ id: row.id, unread: row.unread, ...row.payload }));
    assert.equal(buildAnalystInbox({ ...input, findings: restored }).unread, 2);
  }
  assert.deepEqual(old, original);
});

test('publication discrepancies survive source-warning suppression with original acknowledgment and evidence', () => {
  const warning = attentionFinding('excluded', { managedBy: 'review-sources' });
  const issue = { code: 'REVERSED_RISK_RANGE', message: 'Published lower bound exceeds the upper bound.' };
  const discrepancy = attentionFinding('discrepancy', { managedBy: 'review-sources', sourceDiscrepancy: true,
    sourceQuality: { issues: [issue] } });
  const acknowledged = { ...discrepancy, id: 'acknowledged', unread: 0, acknowledged_at: '2026-09-22T16:00:00Z' };
  const emptyIssues = attentionFinding('unsubstantiated', { managedBy: 'review-sources', sourceDiscrepancy: true, sourceQuality: { issues: [] } });
  const operational = attentionFinding('gateway');
  const result = buildAnalystInbox({ attentionVersion: 1, findings: [warning, discrepancy, acknowledged, emptyIssues, operational] });
  assert.deepEqual(result.findings.map(row => row.id), ['acknowledged', 'discrepancy', 'gateway']);
  assert.equal(result.unread, 2);
  assert.equal(result.findings[0], acknowledged);
  assert.equal(result.findings[1], discrepancy);
  assert.equal(result.findings[1].payload.sourceQuality.issues[0], issue);
});

test('legacy actions on the opposite held side and resolved concerns are not PM attention', () => {
  const sellIntoShort = flip({ action: 'exit', payload: { quantity: -15 } });
  const coverIntoLong = flip({ action: 'cover', payload: { quantity: 15 } });
  assert.equal(buildAnalystInbox({ findings: [sellIntoShort] }).findings.length, 0);
  assert.equal(buildAnalystInbox({ findings: [coverIntoLong] }).findings.length, 0);
  assert.equal(buildAnalystInbox({ findings: [flip({ action: 'exit', state: 'resolved' })] }).findings.length, 0);
});

test('server projection hides stale current portfolio and balance claims but retains historical accounting and research', () => {
  const now = '2026-09-22T15:30:00Z';
  const portfolio = attentionFinding('portfolio', { kind: 'portfolio', holdingsVerified: true, holdingsVerifiedAt: now, quantity: 15 });
  const account = attentionFinding('account', { kind: 'account', requiresFreshBalance: true, balanceVerified: true, balanceVerifiedAt: now });
  const history = attentionFinding('history', { kind: 'account', researchOnly: true });
  const idea = attentionFinding('idea', { kind: 'opportunity' });
  const input = { attentionVersion: 1, findings: [portfolio, account, history, idea] };
  assert.equal(buildAnalystInbox(input, now).findings.length, 4);
  assert.deepEqual(buildAnalystInbox(input, '2026-09-22T15:31:01Z').findings.map(row => row.id).sort(), ['history', 'idea']);
  for (const flags of [{ stale: true }, { mock: true }, { seeded: true }, { cacheOnly: true }, { from_cache: true }, { providerConnected: false }]) {
    const rows = [portfolio, account].map(row => ({ ...row, payload: { ...row.payload, ...flags } }));
    assert.equal(buildAnalystInbox({ attentionVersion: 1, findings: rows }, now).findings.length, 0, JSON.stringify(flags));
  }
  for (const value of [null, 'invalid', '2026-09-22T15:31:00Z']) {
    const rows = [portfolio, account].map(row => ({ ...row, payload: { ...row.payload, holdingsVerifiedAt: value, balanceVerifiedAt: value } }));
    assert.equal(buildAnalystInbox({ attentionVersion: 1, findings: rows }, now).findings.length, 0);
  }
});

test('same-report Sell-SOME instruction projects a trim while preserving source identity and acknowledgment', () => {
  const row = finding('sjm', '2026-09-14', null, { symbol: 'SJM', action: 'exit', unread: 0,
    acknowledged_at: '2026-09-14T16:00:00Z', event: { entityId: 'SJM', productKey: 'real-time-alerts',
      eventType: 'position_change', fieldPath: 'data.alert', action: 'SELL',
      excerpt: JSON.stringify({ ticker: 'SJM', action: 'SELL', headline: 'SELL SIGNAL SJM' }),
      sourceReport: { sourceMessageId: 'sjm', publicationDate: '2026-09-14', contentHash: 'same-verified-report',
        title: 'Real-Time Alert: Sell-SOME Signals: SJM', bodyText: 'Portfolio Managers should be selling-SOME of Bullish TRENDs that are green today...' },
    },
  });
  const before = JSON.stringify(row);
  const result = buildAnalystInbox({ findings: [row] }, '2026-09-14T21:00:00Z');
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].id, 'sjm');
  assert.equal(result.findings[0].action, 'trim');
  assert.equal(result.findings[0].payload.event.action, 'SELL');
  assert.equal(result.unread, 0);
  assert.equal(result.findings[0].acknowledged_at, row.acknowledged_at);
  assert.equal(JSON.stringify(row), before);
});

test('baselines and unchanged daily signals do not create alerts or unread counts', () => {
  assert.deepEqual(buildAnalystInbox({ findings: [prior()], unread: 27 }), { findings: [], unread: 0 });
  assert.deepEqual(buildAnalystInbox({ findings: [prior(), flip({ event: { signalValue: 'BULLISH' } })] }).findings, []);
  assert.deepEqual(buildAnalystInbox({ findings: [prior(), prior()] }).findings, []);
  assert.deepEqual(buildAnalystInbox(null), { findings: [], unread: 0 });
});

test('an actual change carries dated comparable provenance and latest confirmation separately', () => {
  const original = { status: 'ready', unread: 99, findings: [prior(), flip(), confirmation()] };
  const saved = JSON.stringify(original);
  const output = buildAnalystInbox(original, '2026-09-14T21:00:00Z');
  assert.equal(output.status, 'ready');
  assert.equal(output.unread, 1);
  assert.equal(output.findings.length, 1);
  const row = output.findings[0];
  assert.equal(row.id, 'flip');
  assert.equal(row.payload.event.signalValue, 'BEARISH');
  assert.deepEqual(row.payload.event.previousEvent, prior().payload.event);
  assert.equal(row.payload.citation.sourceUri, flip().payload.citation.sourceUri);
  assert.deepEqual(row.payload.alertContext, {
    kind: 'signal-transition', changedAt: '2026-09-09T00:00:00Z', previousAt: '2026-09-08T00:00:00Z',
    lastConfirmedAt: '2026-09-14T00:00:00Z', previousCitation: prior().payload.citation,
    latestCitation: confirmation().payload.citation, latestEvent: confirmation().payload.event,
    recordedPosition: { side: 'LONG', asOf: '2026-09-14T19:00:00Z' },
  });
  assert.equal(JSON.stringify(original), saved, 'projection must not mutate persisted evidence');
});

test('repeated publication cannot reopen an acknowledged transition or replace its identity', () => {
  const acknowledged = flip({ unread: 0, acknowledged_at: '2026-09-09T14:00:00Z' });
  const latest = confirmation({ payload: { quantity: 12, holdingsVerifiedAt: '2026-09-14T20:00:00Z' } });
  const output = buildAnalystInbox({ findings: [latest, acknowledged, prior()] });
  assert.equal(output.unread, 0);
  assert.equal(output.findings[0].id, 'flip');
  assert.equal(output.findings[0].acknowledged_at, acknowledged.acknowledged_at);
  assert.equal(output.findings[0].payload.quantity, 12);
  assert.equal(output.findings[0].payload.holdingsVerifiedAt, '2026-09-14T20:00:00Z');
  const duplicate = flip({ id: 'duplicate', unread: 1 });
  assert.equal(buildAnalystInbox({ findings: [duplicate, latest, acknowledged, prior()] }).findings[0].id, 'flip');
});
test('inbox forwards the latest current holding weight and clears it after an unavailable refresh', () => {
  const currentHolding = { weightPct: 1.75, source: 'ibkr', asOf: '2026-09-14T20:00:00Z', basis: 'absolute_market_value_over_net_liquidation' };
  const change = flip({ payload: { currentHolding: { ...currentHolding, weightPct: 3 } } });
  const latest = confirmation({ payload: { currentHolding, holdingsVerifiedAt: currentHolding.asOf } });
  assert.deepEqual(buildAnalystInbox({ findings: [prior(), change, latest] }).findings[0].payload.currentHolding, currentHolding);
  const offline = { ...latest, payload: { ...latest.payload, holdingsVerified: false, currentHolding: null } };
  assert.equal(buildAnalystInbox({ findings: [prior(), change, offline] }).findings[0].payload.currentHolding, null);
});

test('only the latest reversal survives and result order is independent of ingestion order', () => {
  const reversal = finding('reversal', '2026-09-15', 'BULLISH');
  const rows = [reversal, confirmation(), prior(), flip()];
  const output = buildAnalystInbox({ findings: rows });
  assert.equal(output.findings.length, 1);
  assert.equal(output.findings[0].id, 'reversal');
  assert.equal(output.findings[0].payload.event.previousEvent.sourceMessageId, 'confirmation');
  assert.equal(output.findings[0].payload.alertContext.previousAt, '2026-09-14T00:00:00Z');
  assert.deepEqual(buildAnalystInbox({ findings: rows.toReversed() }), output);
});

test('unknown or conflicting publications break continuity instead of inventing a change', () => {
  for (const event of [
    { qualityStatus: 'unvalidated' }, { signalValue: 'UNAVAILABLE' },
    { sourceMessageId: undefined }, { publishedAt: 'invalid' }, { publishedAt: undefined },
    { publishedAt: '2026-02-30T00:00:00Z' },
  ]) {
    const unknown = flip({ event });
    assert.equal(buildAnalystInbox({ findings: [prior(), unknown, confirmation()] }).findings.length, 0, JSON.stringify(event));
  }
  const conflicting = flip({ id: 'conflict', event: { signalValue: 'NEUTRAL', sourceMessageId: 'conflict' } });
  assert.equal(buildAnalystInbox({ findings: [prior(), flip(), conflicting, confirmation()] }).findings.length, 0);
  assert.equal(buildAnalystInbox({ findings: [prior(), flip(), confirmation({ event: { qualityStatus: 'failed' } })] }).findings.length, 0);
  const recovered = finding('recovered', '2026-09-15', 'BULLISH');
  const output = buildAnalystInbox({ findings: [prior(), flip(), conflicting, confirmation(), recovered] });
  assert.equal(output.findings[0].id, 'recovered');
  assert.equal(output.findings[0].payload.event.previousEvent.sourceMessageId, 'confirmation');
});

test('comparisons stay within the same security, product, publisher, field path, and typed signal', () => {
  for (const overrides of [
    { symbol: 'MSFT' }, { event: { entityId: 'MSFT' } },
    { event: { productKey: 'momo-tracker' } }, { event: { fieldPath: 'data.AMZN.trade' } },
    { event: { eventType: 'trade_signal' } }, { event: { sourceUrl: 'https://another-publisher.example/flip' } },
    { event: { providerKey: 'another-publisher' } }, { event: { fieldPath: undefined } },
  ]) {
    assert.equal(buildAnalystInbox({ findings: [prior(), flip(overrides)] }).findings.length, 0, JSON.stringify(overrides));
  }
  const mapped = prior({ symbol: 'IBIT', event: { entityId: 'IBIT', fieldPath: 'data.BTC' } });
  const direct = flip({ symbol: 'BTC', event: { entityId: 'BTC', fieldPath: 'data.BTC' } });
  assert.equal(buildAnalystInbox({ findings: [mapped, direct] }).findings.length, 0);
});

test('dated direct source actions remain source alerts and use the newest action per source field', () => {
  for (const action of ['exit', 'trim', 'cover', 'roster removal']) {
    const output = buildAnalystInbox({ findings: [flip({ action, payload: { quantity: action === 'cover' ? -15 : 15 } })] });
    assert.equal(output.findings[0].action, action);
    assert.equal(output.findings[0].payload.alertContext.kind, 'source-action');
    assert.equal(output.findings[0].payload.alertContext.previousAt, null);
  }
  const earlier = prior({ action: 'trim' });
  const later = flip({ action: 'exit', unread: 0 });
  assert.deepEqual(buildAnalystInbox({ findings: [later, earlier] }).findings.map(row => row.id), ['flip']);
  assert.equal(buildAnalystInbox({ findings: [later, earlier] }).unread, 0);
  for (const event of [{ qualityStatus: 'failed' }, { publishedAt: undefined }, { sourceMessageId: undefined }]) {
    assert.equal(buildAnalystInbox({ findings: [flip({ action: 'exit', event })] }).findings.length, 0);
  }
  assert.equal(buildAnalystInbox({ findings: [flip({ action: 'exit' }), flip({ action: 'cover', id: 'conflict' })] }).findings.length, 0);
});

test('multiple independent alerts sort by the evidenced change date and ignore processing times', () => {
  const msftBefore = finding('msft-before', '2026-09-10', 'BULLISH', { symbol: 'MSFT', event: { entityId: 'MSFT', fieldPath: 'data.MSFT' } });
  const msftAfter = finding('msft-after', '2026-09-11', 'NEUTRAL', { symbol: 'MSFT', event: { entityId: 'MSFT', fieldPath: 'data.MSFT' } });
  const output = buildAnalystInbox({ findings: [prior(), flip({ created_at: '2027-01-01T00:00:00Z' }), confirmation(), msftBefore, msftAfter] });
  assert.deepEqual(output.findings.map(row => row.id), ['msft-after', 'flip']);
  assert.equal(output.unread, 2);
});

test('recorded position context survives refresh failure without pretending to be a current holding', () => {
  const recorded = flip({ payload: { quantity: -15, holdingsVerifiedAt: '2026-09-13T15:00:00Z' } });
  const unavailable = confirmation({ payload: { quantity: null, holdingsVerified: false, holdingsVerifiedAt: null } });
  const baseline = prior({ payload: { quantity: -15, holdingsVerifiedAt: '2026-09-12T15:00:00Z' } });
  const output = buildAnalystInbox({ findings: [baseline, recorded, unavailable] }, '2026-09-14T21:00:00Z');
  assert.deepEqual(output.findings[0].payload.alertContext.recordedPosition, { side: 'SHORT', asOf: '2026-09-13T15:00:00Z' });
  assert.equal(output.findings[0].payload.quantity, null);
  assert.equal(output.findings[0].payload.holdingsVerified, false);
});

test('an evidenced closed position suppresses alerts; future or invalid holdings cannot establish relevance', () => {
  const now = '2026-09-14T21:00:00Z';
  const closed = confirmation({ payload: { quantity: 0, holdingsVerifiedAt: '2026-09-14T20:00:00Z' } });
  assert.equal(buildAnalystInbox({ findings: [prior(), flip(), closed] }, now).findings.length, 0);
  assert.equal(buildAnalystInbox({ findings: [prior({ action: 'trim' }), flip({ action: 'exit' }), { ...closed, action: 'exit' }] }, now).findings.length, 0);
  const unverifiedBaseline = prior({ payload: { holdingsVerified: false } });
  for (const payload of [
    { holdingsVerified: false }, { holdingsVerifiedAt: '2026-09-15T00:00:00Z' },
    { holdingsVerifiedAt: 'invalid' }, { quantity: NaN }, { quantity: '15' },
  ]) {
    const output = buildAnalystInbox({ findings: [unverifiedBaseline, flip({ payload })] }, now);
    assert.equal(output.findings[0].payload.alertContext.recordedPosition, null, JSON.stringify(payload));
  }
});

function sourceActionAlias(id, fieldPath, overrides = {}) {
  const { event = {}, ...row } = overrides;
  return finding(id, '2026-09-08', null, {
    action: 'cover', ...row,
    payload: { quantity: ['exit', 'trim', 'roster removal'].includes(row.action) ? 15 : -15, ...row.payload },
    event: {
      productKey: 'real-time-alert', productLabel: 'Real-Time Alerts', eventType: 'position_change', fieldPath,
      sourceMessageId: 'same-message', contentSha256: 'same-content-revision',
      excerpt: 'Cover-SOME Signal: AMZN', sourceUrl: 'https://app.hedgeye.com/feed_items/same-article',
      ...event,
    },
  });
}

test('source actions require an evidenced recorded position', () => {
  const now = '2026-09-14T21:00:00Z';
  for (const payload of [
    { holdingsVerified: false }, { quantity: null }, { quantity: 0 },
    { holdingsVerifiedAt: 'invalid' }, { holdingsVerifiedAt: '2026-09-15T00:00:00Z' },
  ]) {
    assert.equal(buildAnalystInbox({ findings: [sourceActionAlias('action', 'data.alert', { payload })] }, now).findings.length, 0);
  }
});

test('one publication action produces one alert across headline, structured, and email-body field aliases', () => {
  const headline = sourceActionAlias('headline', 'data.alert.headline');
  const structured = sourceActionAlias('structured', 'data.alerts[0]', {
    event: { excerpt: JSON.stringify({ action: 'COVER', headline: 'Cover-SOME Signal: AMZN', signalPhrase: 'Cover-SOME' }) },
  });
  const email = sourceActionAlias('email', 'data.alert.action', {
    unread: 0, acknowledged_at: '2026-09-14T20:00:00Z',
    event: { eventType: 'position_action', action: 'COVER', sourceUrl: 'saved-email/messages/same-message.html' },
    payload: { citation: { title: 'Real-Time Alert', sourceUri: 'saved-email/messages/same-message.html' } },
  });
  const rows = [headline, structured, email];
  const output = buildAnalystInbox({ findings: rows }, '2026-09-14T21:00:00Z');
  assert.equal(output.findings.length, 1);
  assert.equal(output.unread, 0);
  const alert = output.findings[0];
  assert.equal(alert.id, 'email', 'acknowledged identity survives the richer parser alias');
  assert.equal(alert.acknowledged_at, email.acknowledged_at);
  assert.equal(alert.payload.event.excerpt, structured.payload.event.excerpt);
  assert.equal(alert.payload.event.action, 'COVER');
  assert.match(alert.payload.citation.sourceUri, /^https:\/\//);
  assert.deepEqual(buildAnalystInbox({ findings: rows.toReversed() }, '2026-09-14T21:00:00Z'), output);
});

test('source action deduplication preserves distinct publishers, revisions, messages, headlines, and entities', () => {
  const first = sourceActionAlias('first', 'data.alert');
  for (const event of [
    { sourceUrl: 'https://other-publisher.example/article' }, { contentSha256: 'different-revision' },
    { sourceMessageId: 'different-message' }, { excerpt: 'Cover-ALL Signal: AMZN' },
    { entityId: 'MSFT' }, { productKey: 'another-product' }, { providerKey: 'another-publisher' },
    { contentSha256: undefined },
  ]) {
    const second = sourceActionAlias('second', 'data.alerts[0]', { event });
    assert.equal(buildAnalystInbox({ findings: [first, second] }, '2026-09-14T21:00:00Z').findings.length, 2, JSON.stringify(event));
  }
  const otherPublisher = sourceActionAlias('other', 'data.alerts[0]', { event: { sourceUrl: 'https://other-publisher.example/article' } });
  const ambiguousEmail = sourceActionAlias('email', 'data.alert.action', { event: { sourceUrl: 'saved-email/message.html' } });
  assert.equal(buildAnalystInbox({ findings: [first, otherPublisher, ambiguousEmail] }, '2026-09-14T21:00:00Z').findings.length, 3);
});

test('deduplicating source-action imports preserves independently evidenced signal transitions', () => {
  const output = buildAnalystInbox({ findings: [prior(), flip(), confirmation(),
    sourceActionAlias('a', 'data.alert'), sourceActionAlias('b', 'data.alerts[0]'),
  ] }, '2026-09-14T21:00:00Z');
  assert.equal(output.findings.length, 2);
  assert.equal(output.findings[0].id, 'flip');
  assert.equal(output.findings[0].payload.event.previousEvent.signalValue, 'BULLISH');
  assert.equal(output.findings[1].action, 'cover');
  assert.equal(output.unread, 2);
});

test('latest verified position applies across source-action aliases during partial refreshes', () => {
  const oldShort = sourceActionAlias('short', 'data.alert', { payload: { quantity: -15, holdingsVerifiedAt: '2026-09-14T19:00:00Z' } });
  const closed = sourceActionAlias('closed', 'data.alerts[0]', { payload: { quantity: 0, holdingsVerifiedAt: '2026-09-14T20:00:00Z' } });
  assert.equal(buildAnalystInbox({ findings: [oldShort, closed] }, '2026-09-14T21:00:00Z').findings.length, 0);
  const unavailable = sourceActionAlias('unavailable', 'data.alert.action', { unread: 0,
    payload: { quantity: null, holdingsVerified: false, holdingsVerifiedAt: null } });
  const result = buildAnalystInbox({ findings: [oldShort, unavailable] }, '2026-09-14T21:00:00Z');
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].id, 'unavailable');
  assert.equal(result.unread, 0);
  assert.deepEqual(result.findings[0].payload.alertContext.recordedPosition, { side: 'SHORT', asOf: '2026-09-14T19:00:00Z' });
});

test('typed partial-sale source semantics dedupe SELL-SOME aliases despite inconsistent parser labels', () => {
  const headline = 'Sell-SOME Signal: AMZN';
  const structured = sourceActionAlias('misclassified-exit', 'data.alerts[0]', { action: 'exit', event: {
    excerpt: JSON.stringify({ ticker: 'AMZN', action: 'SELL-SOME', headline, signalPhrase: 'Sell-SOME' }),
  } });
  const typed = sourceActionAlias('typed-trim', 'data.alert.action', { action: 'trim', unread: 0,
    event: { action: 'SELL-SOME', excerpt: headline, sourceUrl: 'saved-email/same-message.html' },
  });
  const scalar = sourceActionAlias('scalar-exit', 'data.alert.headline', { action: 'exit', event: { excerpt: headline } });
  const output = buildAnalystInbox({ findings: [structured, typed, scalar] }, '2026-09-14T21:00:00Z');
  assert.equal(output.findings.length, 1);
  assert.equal(output.findings[0].id, 'typed-trim');
  assert.equal(output.unread, 0);
  assert.equal(output.findings[0].action, 'trim');
  assert.equal(output.findings[0].payload.action, 'trim');
  assert.equal(output.findings[0].payload.event.action, 'SELL-SOME');
  assert.equal(output.findings[0].payload.event.excerpt, structured.payload.event.excerpt);
  assert.match(output.findings[0].payload.citation.sourceUri, /^https:\/\//);
  assert.equal(buildAnalystInbox({ findings: [structured] }, '2026-09-14T21:00:00Z').findings[0].action, 'trim');
  assert.equal(buildAnalystInbox({ findings: [scalar, structured] }, '2026-09-14T21:00:00Z').findings.length, 1);
  assert.deepEqual(buildAnalystInbox({ findings: [scalar, typed, structured] }, '2026-09-14T21:00:00Z'), output);

  const unrelated = sourceActionAlias('unrelated', 'data.alert', { action: 'exit', event: {
    excerpt: JSON.stringify({ ticker: 'MSFT', action: 'SELL-SOME', headline }),
  } });
  assert.equal(buildAnalystInbox({ findings: [unrelated] }, '2026-09-14T21:00:00Z').findings[0].action, 'exit', 'another entity’s JSON must not relabel the action');
});

test('ambiguous source actions cannot relabel a scalar headline alias', () => {
  const headline = 'Source action: AMZN';
  const partial = sourceActionAlias('partial', 'data.alert', { action: 'trim', event: { action: 'SELL-SOME', excerpt: headline } });
  const full = sourceActionAlias('full', 'data.alerts[0]', { action: 'exit', event: { action: 'SELL-ALL', excerpt: headline } });
  const unknown = sourceActionAlias('unknown', 'data.alert.headline', { action: 'exit', event: { excerpt: headline } });
  const output = buildAnalystInbox({ findings: [partial, full, unknown] }, '2026-09-14T21:00:00Z');
  assert.deepEqual(output.findings.map(row => row.id), ['full', 'partial']);
  assert.deepEqual(output.findings.map(row => row.action), ['exit', 'trim']);
});

test('a report’s partial-sale instruction also qualifies its generic SELL scalar aliases without changing identity', () => {
  const headline = 'SELL SIGNAL AMZN';
  const report = { title: 'Real-Time Alert: Sell-SOME Signals: AMZN',
    sourceMessageId: 'same-message', publicationDate: '2026-09-08', contentHash: 'verified-report',
    bodyText: 'Portfolio Managers should be selling-SOME of Bullish TRENDs that are green today...' };
  const original = sourceActionAlias('0-original', 'data.alert.headline', { action: 'exit', unread: 0,
    acknowledged_at: '2026-09-08T20:00:00Z', event: { excerpt: headline } });
  const structured = sourceActionAlias('structured', 'data.alert', { action: 'exit', event: {
    sourceReport: report, excerpt: JSON.stringify({ ticker: 'AMZN', action: 'SELL', headline }),
  } });
  const scalar = sourceActionAlias('scalar', 'data.alert.action', { action: 'exit', event: {
    action: 'SELL', excerpt: headline, sourceUrl: 's3://research/same-message-body.html',
  } });
  const result = buildAnalystInbox({ findings: [structured, scalar, original] }, '2026-09-14T21:00:00Z');
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].id, '0-original');
  assert.equal(result.findings[0].action, 'trim');
  assert.equal(result.findings[0].payload.event.sourceReport.bodyText, report.bodyText);
  assert.equal(result.unread, 0);
  assert.equal(result.findings[0].acknowledged_at, original.acknowledged_at);
  const full = { ...scalar, id: 'explicit-full', payload: { ...scalar.payload, event: { ...scalar.payload.event, action: 'SELL-ALL' } } };
  const distinct = buildAnalystInbox({ findings: [structured, full] }, '2026-09-14T21:00:00Z');
  assert.equal(distinct.findings.length, 2, 'an explicit full sale is not overridden by a partial-sale instruction');
  assert.deepEqual(new Set(distinct.findings.map(row => row.action)), new Set(['trim', 'exit']));
});

test('action-required findings sort first, count separately, and survive stale holdings', () => {
  const now = new Date('2026-10-16T16:30:00Z');
  const base = (id, extra) => ({ id, state: 'open', unread: 1, payload: { attentionVersion: 1, state: 'open', kind: 'portfolio', priority: 0, symbol: id,
    holdingsVerified: true, holdingsVerifiedAt: '2026-10-16T16:29:50Z', quantity: 10, publicationTime: '2026-10-16T16:23:00Z',
    presentation: { subject: id, rows: [{ label: 'Action', text: 'Review' }] }, ...extra } });
  const inbox = buildAnalystInbox({ attentionVersion: 1, findings: [
    base('ORDINARY', { publicationTime: '2026-10-16T16:29:00Z' }),
    base('SNOW', { severity: 'action-required' }),
    base('WING', { severity: 'action-required', holdingsVerifiedAt: '2026-10-16T15:00:00Z' }),
    base('STALE', { holdingsVerifiedAt: '2026-10-16T15:00:00Z' }),
    { ...base('KEPT', { severity: 'action-required' }), unread: 0 },
  ] }, now);
  assert.deepEqual(inbox.findings.map(finding => finding.id), ['SNOW', 'WING', 'ORDINARY', 'KEPT']);
  assert.equal(inbox.actionRequired, 2);
  assert.equal(inbox.unread, 3);
  assert.equal(inbox.findings.find(finding => finding.id === 'WING').holdingsStale, true);
  assert.equal(inbox.findings.find(finding => finding.id === 'SNOW').holdingsStale, undefined);
});
