const test = require('node:test');
const assert = require('node:assert/strict');
const { collectOperationalAttention } = require('./attentionOperations.cjs');
const { RESEARCH_PRODUCTS, isResearchProductDue, newYorkParts } = require('../../utils/researchProductRegistry.cjs');
const { expectedRiskRangePublication } = require('../../utils/riskRangePublication.cjs');
const { discrepancyText } = require('../../utils/researchSourceQuality.cjs');

const NOW = '2026-09-22T15:00:00Z';
function fixture(now = NOW) {
  const date = newYorkParts(now).date;
  const check = (id, options = {}) => ({ id, label: id, status: 'pass', blocking: true,
    observedAt: now, dependsOn: [], capabilityIds: [], ...options });
  const report = {
    checkedAt: now,
    groups: [{ checks: [
      check('ibkr.sidecar'), check('ibkr.gateway', { dependsOn: ['ibkr.sidecar'] }),
      check('ibkr.accounts', { dependsOn: ['ibkr.gateway'] }),
      check('ibkr.portfolio', { dependsOn: ['ibkr.gateway', 'ibkr.accounts'] }),
      check('gmail.ingestion', { readinessMaxAgeMinutes: 45 }),
      check('research.rta'), check('research.etf-pro'), check('research.risk-ranges'),
    ] }],
    researchProductMatrix: {
      marketDate: date, generatedAt: now, status: 'complete', collectionErrors: [],
      products: RESEARCH_PRODUCTS.map(product => ({
        id: product.id, label: product.label, marketDate: date,
        status: product.id === 'risk-ranges' ? 'indexed' : 'not_due',
        stages: { received: product.id === 'risk-ranges', indexed: product.id === 'risk-ranges' },
        observedAt: now, counts: { failures: 0 },
      })),
    },
  };
  const status = { checkedAt: now, services: [
    { id: 'market-data', status: 'online' },
    { id: 'live-portfolio', status: 'online' },
  ] };
  const ranges = { status: 'current', available: true,
    manifest: { persistedManifestVerified: true, publicationDate: date }, ranges: { SPX: { lrr: 1, hrr: 2 } } };
  const snapshots = Object.fromEntries(RESEARCH_PRODUCTS.map(product => [product.id, {
    snapshotType: product.id, date, data: { content: 'verified publication' }, source: 'gmail-html',
  }]));
  const hedgai = { version: 1, product: 'hedgai-signals', asOf: now, baselineDate: date,
    book: { rows: [{ ticker: 'XLF', instrumentId: 'hedgai:XLF', position: 'Buy', status: 'current', positionSourceIds: ['source'] }] },
    sources: [{ id: 'source', sourceType: 'gmail-email', publicationDate: date,
      publishedAt: `${date}T12:00:00Z`, sourceUrl: 'https://app.hedgeye.com/feed_items/187646' }],
    sourceQuality: { continuity: 'complete', issues: [] } };
  return {
    report, status, ranges, snapshots, hedgai,
    check: id => report.groups[0].checks.find(value => value.id === id),
    product: id => report.researchProductMatrix.products.find(value => value.id === id),
    fetchJson: async path => {
      if (path === '/api/system-readiness') return report;
      if (path === '/api/system-status') return status;
      if (path === '/api/risk-ranges?envelope=1') return ranges;
      if (path.startsWith('/api/hedgeye/snapshot/')) return snapshots[path.split('/').at(-1)];
      if (path.startsWith('/api/research/hedgai?')) return hedgai;
      throw new Error(`Unexpected read ${path}`);
    },
  };
}
const run = (data, now = NOW) => collectOperationalAttention({ fetchJson: data.fetchJson, now: new Date(now) });
const sourceQuality = () => ({ status: 'discrepancy', issues: [{ id: 'rut-original', code: 'invalid_bounds',
  ticker: 'RUT', field: 'riskRange', observed: { lrr: 2834, hrr: 2825, trend: 'BULLISH' },
  disposition: 'withheld_from_structured_data',
  source: { productId: 'early-look', reportDate: '2026-09-22', url: 'https://app.hedgeye.com/feed_items/187503' } }] });

test('range discrepancy copy distinguishes equal bounds and does not call ordered values reversed', () => {
  const issue = sourceQuality().issues[0];
  issue.observed.lrr = issue.observed.hrr;
  assert.match(discrepancyText([issue]), /lower 2,825 equals upper 2,825/);
  issue.observed.lrr = 2800;
  issue.message = 'A related published field needs verification.';
  assert.doesNotMatch(discrepancyText([issue]), /exceeds|equals/);
  assert.match(discrepancyText([issue]), /related published field/);
});

test('explicit report date survives synthetic midnight UTC and original message link is not repeated', async () => {
  const data = fixture();
  const quality = sourceQuality();
  Object.assign(quality.issues[0].source, { publishedAt: '2026-09-22T00:00:00+00:00', reportDate: '2026-09-22', messageId: '1a0c8dfa392f7cc3' });
  Object.assign(data.product('early-look'), { status: 'indexed', stages: { received: true, indexed: true },
    publicationDate: '2026-09-22', sourceIds: ['1a0c8dfa392f7cc3'], sourceQuality: quality });
  const finding = (await run(data)).findings[0];
  assert.equal(finding.sourceReportDate, '2026-09-22');
  assert.equal(finding.presentation.date, '2026-09-22');
  assert.equal(finding.citation.publicationDate, '2026-09-22');
  assert.equal(finding.presentation.sourceLinks.filter(link => link.label === 'Early Look').length, 1);
  assert.equal(finding.presentation.sourceLinks[1].citation.sourceUri, 'https://app.hedgeye.com/feed_items/187503');
});

test('successful partial import surfaces the exact source discrepancy while keeping unaffected research available', async () => {
  const data = fixture();
  Object.assign(data.product('early-look'), { status: 'indexed', stages: { received: true, indexed: true }, sourceQuality: sourceQuality() });
  data.snapshots['early-look'].sourceQuality = sourceQuality();
  const result = await run(data);
  assert.equal(result.complete, true);
  assert.equal(result.findings.length, 1);
  const finding = result.findings[0];
  assert.equal(finding.sourceDiscrepancy, true);
  assert.deepEqual(finding.sourceQuality.issues[0].observed, { lrr: 2834, hrr: 2825, trend: 'BULLISH' });
  assert.match(JSON.stringify(finding.presentation.rows), /published lower 2,834 exceeds upper 2,825/);
  assert.match(JSON.stringify(finding.presentation.rows), /the rest is usable/);
  assert.doesNotMatch(JSON.stringify(finding.presentation.rows), /report was rejected|could not be.*loaded|corrected/);
  assert.equal(finding.presentation.sourceLinks[1].citation.sourceUri, 'https://app.hedgeye.com/feed_items/187503');
  assert.equal((await run(data)).findings[0].fingerprint, finding.fingerprint);
});

test('source discrepancies can be verified directly by the consumer and never asserted from stale or seeded readbacks', async () => {
  for (const flags of [{}, { stale: true }, { mock: true }, { seeded: true }, { cacheOnly: true }]) {
    const data = fixture();
    Object.assign(data.product('early-look'), { status: 'indexed', stages: { received: true, indexed: true } });
    Object.assign(data.snapshots['early-look'], flags, { sourceQuality: sourceQuality() });
    const finding = (await run(data)).findings[0];
    assert.equal(finding.sourceDiscrepancy === true, Object.keys(flags).length === 0);
  }
});

test('healthy complete checks and a verified empty-book consumer produce no incident', async () => {
  const data = fixture();
  data.check('ibkr.portfolio').provenance = { positionCount: 0 };
  const result = await run(data);
  assert.equal(result.complete, true);
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.diagnostics.coverage.uncheckedProducts, []);
});

test('missing risk edition waits for 08:15 ET and observes weekends, holidays and DST', async () => {
  for (const [now, expected] of [
    ['2026-09-22T12:14:59Z', false], ['2026-09-22T12:15:00Z', true],
    ['2026-11-02T13:14:59Z', false], ['2026-11-02T13:15:00Z', true],
    ['2026-09-26T15:00:00Z', false], ['2026-09-07T15:00:00Z', false],
  ]) {
    const data = fixture(now);
    Object.assign(data.product('risk-ranges'), { status: 'missing', stages: {}, errorCode: 'RESEARCH_PRODUCT_DUE_MISSING' });
    const result = await run(data, now);
    assert.equal(result.findings.some(row => row.symbol === 'Risk Ranges'), expected, now);
    assert.equal(isResearchProductDue('risk-ranges', { now: new Date(now) }), expected, now);
    assert.equal(expectedRiskRangePublication(now).afterDeadline, expected, now);
  }
});

test('yesterday cannot satisfy today; weekly and event-driven products are not morning obligations', async () => {
  const data = fixture();
  Object.assign(data.product('risk-ranges'), { status: 'failed', publicationDate: '2026-09-21', stages: {}, errorCode: 'RISK_RANGE_PUBLICATION_MISSING' });
  Object.assign(data.product('cftc-positioning'), { status: 'missing', stages: {} });
  Object.assign(data.product('the-call'), { status: 'missing', stages: {} });
  const result = await run(data);
  assert.equal(result.findings.length, 1);
  assert.match(result.findings[0].presentation.rows[0].text, /missing for 2026-09-22/);
});

test('Gmail delivery failures remain diagnostics without generic inbox warnings', async () => {
  const data = fixture();
  Object.assign(data.check('gmail.ingestion'), { status: 'fail', blocking: false, errorCode: 'GMAIL_AUTH_REQUIRED', impact: 'Research updates are unavailable.' });
  Object.assign(data.product('risk-ranges'), { status: 'missing', stages: {}, errorCode: 'RESEARCH_PRODUCT_DUE_MISSING' });
  const result = await run(data);
  assert.equal(result.findings.length, 0);
  assert.deepEqual(result.diagnostics.suppressedServiceChecks, [{ id: 'gmail.ingestion', status: 'fail', errorCode: 'GMAIL_AUTH_REQUIRED' }]);
});

test('coverage collection failure and stale evidence cannot manufacture multiple missing reports', async () => {
  for (const change of [
    { collectionErrors: ['AWS access denied'] },
    { generatedAt: '2026-09-22T13:00:00Z' },
    { mock: true }, { seeded: true }, { from_cache: true },
  ]) {
    const data = fixture();
    Object.assign(data.report.researchProductMatrix, change);
    const result = await run(data);
    assert.equal(result.complete, false);
    assert.equal(result.findings.length, 0);
  }
});

test('received explicit processing failure alerts before scheduled deadline', async () => {
  const now = '2026-09-22T11:00:00Z';
  const data = fixture(now);
  Object.assign(data.product('risk-ranges'), { status: 'failed', stages: { received: true }, errorCode: 'PARSER_FAILED', counts: { failures: 1 } });
  const result = await run(data, now);
  assert.equal(result.findings.length, 1);
  assert.match(result.findings[0].presentation.rows[0].text, /failed to load/);
});

test('an unregistered publication stays in Systems and never reaches the Inbox', async () => {
  const data = fixture();
  data.report.researchProductMatrix.products.push({
    id: 'unsupported:unknown', label: 'unknown', cadence: 'unsupported', due: true, status: 'failed',
    marketDate: '2026-09-22', observedAt: NOW, stages: { received: true, parsed: false, validated: false, indexed: false },
    counts: { manifests: 1, failures: 1 }, errorCode: 'RESEARCH_PRODUCT_UNSUPPORTED',
    detail: 'Received product "unknown" is not registered and cannot be parsed or indexed safely.', sourceIds: [],
  });
  const result = await run(data);
  assert.deepEqual(result.findings, []);
  assert.equal(result.complete, true);
  assert.deepEqual(result.diagnostics.unregisteredPublications.map(row => row.id), ['unsupported:unknown']);
});

test('an ordinary import gets processing grace while a stalled import becomes an incident', async () => {
  const data = fixture();
  Object.assign(data.product('the-call'), { status: 'received', stages: { received: true } });
  assert.equal((await run(data)).findings.length, 0);
  data.product('the-call').observedAt = '2026-09-22T14:40:00Z';
  assert.match((await run(data)).findings[0].presentation.rows[0].text, /import stalled/);
});

test('indexed publication with an unavailable individual consumer cannot be hidden by its sibling', async () => {
  const data = fixture();
  Object.assign(data.product('etf-pro'), { status: 'indexed', stages: { received: true, indexed: true } });
  Object.assign(data.check('research.etf-pro'), { status: 'fail', errorCode: 'ETF_PRO_BOOK_UNAVAILABLE' });
  const result = await run(data);
  assert.equal(result.findings.length, 1);
  assert.match(result.findings[0].presentation.rows[0].text, /dashboard view cannot serve/);
  assert.equal(result.findings[0].symbol, 'ETF Pro');
});

test('range consumer must independently serve the verified edition and manifest', async () => {
  for (const change of [
    { available: false }, { stale: true }, { mock: true }, { seeded: true }, { from_cache: true },
    { status: 'current', source: 'mock' }, { status: 'current', source: 'seed:publication' },
    { manifest: { publicationDate: '2026-09-21', persistedManifestVerified: true } },
    { manifest: { publicationDate: '2026-09-22', persistedManifestVerified: false } },
  ]) {
    const data = fixture();
    Object.assign(data.ranges, change);
    const result = await run(data);
    assert.equal(result.complete, false);
    assert.equal(result.findings.length, 1);
    assert.match(result.findings[0].presentation.rows[0].text, /response could not be verified/);
  }
});

test('Gateway failure groups holdings, account and dependent failures', async () => {
  const data = fixture();
  for (const id of ['ibkr.gateway', 'ibkr.accounts', 'ibkr.portfolio']) Object.assign(data.check(id), {
    status: 'fail', errorCode: id === 'ibkr.gateway' ? 'IBKR_GATEWAY_NOT_AUTHENTICATED' : 'IBKR_PORTFOLIO_UNAVAILABLE', impact: 'No portfolio data.',
  });
  data.report.groups[0].checks.push({ id: 'ibkr.quotes', status: 'fail', dependsOn: ['ibkr.gateway'], capabilityIds: [], impact: 'Quotes unavailable' });
  const result = await run(data);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].symbol, 'IB Gateway');
  assert.match(result.findings[0].presentation.rows[1].text, /Holdings and balances frozen/);
});

test('an unresponsive Gateway names the Gateway restart, not a dashboard repair', async () => {
  const data = fixture();
  for (const id of ['ibkr.gateway', 'ibkr.accounts', 'ibkr.portfolio']) Object.assign(data.check(id), {
    status: 'fail', errorCode: id === 'ibkr.gateway' ? 'IBKR_GATEWAY_API_UNRESPONSIVE' : 'IBKR_PORTFOLIO_UNAVAILABLE', impact: 'No portfolio data.',
  });
  const result = await run(data);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].symbol, 'IB Gateway');
  const rows = result.findings[0].presentation.rows.map(row => row.text);
  assert.ok(rows.some(text => /IB Gateway unresponsive/.test(text)));
  assert.ok(rows.some(text => /Still unresponsive after 10 min → quit and reopen IB Gateway, sign in\./.test(text)));
  assert.ok(!rows.some(text => /in Systems/.test(text)));
});

test('an unreachable sidecar waits for the supervisor before asking for a dashboard restart', async () => {
  for (const errorCode of ['IBKR_SIDECAR_UNREACHABLE', 'IBKR_SIDECAR_DUPLICATES']) {
    const data = fixture();
    Object.assign(data.check('ibkr.sidecar'), { status: 'fail', errorCode, impact: 'No portfolio data.' });
    const result = await run(data);
    const rows = result.findings.flatMap(finding => finding.presentation.rows.map(row => row.text));
    assert.ok(rows.some(text => /Still down after 10 min → restart the dashboard in Systems\./.test(text)), errorCode);
    assert.ok(!rows.some(text => /Restore the brokerage service/.test(text)), errorCode);
  }
  // A sidecar that is up but on the wrong runtime is still a repair in Systems.
  const data = fixture();
  data.report.groups[0].checks.push({ id: 'ibkr.runtime', label: 'ibkr.runtime', status: 'fail', blocking: true,
    errorCode: 'RUNTIME_PROVENANCE_MISSING', observedAt: NOW, dependsOn: [], capabilityIds: [], impact: 'No portfolio data.' });
  const result = await run(data);
  const rows = result.findings.flatMap(finding => finding.presentation.rows.map(row => row.text));
  assert.ok(rows.some(text => /Restore the brokerage service in Systems\./.test(text)));
});

test('connection recovery alone and partial accounts do not establish portfolio recovery', async () => {
  const data = fixture();
  Object.assign(data.check('ibkr.accounts'), { status: 'warn', errorCode: 'IBKR_PARTIAL_ACCOUNT_COVERAGE', impact: 'Incomplete portfolio' });
  Object.assign(data.check('ibkr.portfolio'), { status: 'fail', errorCode: 'IBKR_LIVE_ACCOUNTS_UNVERIFIED', impact: 'Incomplete portfolio' });
  const result = await run(data);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].symbol, 'Portfolio updates');
  assert.match(result.findings[0].presentation.rows[0].text, /Not all accounts connected/);
});

test('a new lightweight Gateway disconnect overrides a healthy cached deep probe', async () => {
  const data = fixture();
  Object.assign(data.status.services[1], { status: 'offline', details: [{ id: 'gateway-session', status: 'offline' }] });
  const result = await run(data);
  assert.equal(result.findings[0].symbol, 'IB Gateway');
});

test('failed or stale monitors issue a verification concern without asserting Gateway is down', async () => {
  for (const failed of ['throw', 'stale']) {
    const data = fixture();
    if (failed === 'stale') data.report.checkedAt = '2026-09-21T15:00:00Z';
    else {
      const fetch = data.fetchJson;
      data.fetchJson = path => path === '/api/system-readiness' ? Promise.reject(new Error('timeout')) : fetch(path);
    }
    const result = await run(data);
    assert.equal(result.complete, false);
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].symbol, 'Dashboard monitoring');
    assert.doesNotMatch(JSON.stringify(result.findings), /Gateway is disconnected/);
  }
});

test('last-close and verified delayed quote status are not market outages', async () => {
  for (const market of [
    { status: 'closed' },
    { status: 'attention', reason: 'Live IBKR quotes are available; some instruments use delayed Yahoo data.' },
  ]) {
    const data = fixture();
    Object.assign(data.status.services[0], market);
    assert.equal((await run(data)).findings.length, 0);
  }
});

test('identical refreshes preserve identity and material fingerprint', async () => {
  const data = fixture();
  Object.assign(data.product('risk-ranges'), { status: 'missing', stages: {}, errorCode: 'RESEARCH_PRODUCT_DUE_MISSING' });
  const first = (await run(data)).findings[0];
  const later = '2026-09-22T15:01:00Z';
  data.report.checkedAt = later;
  data.report.researchProductMatrix.generatedAt = later;
  data.status.checkedAt = later;
  const second = (await run(data, later)).findings[0];
  assert.equal(first.id, second.id);
  assert.equal(first.fingerprint, second.fingerprint);
  data.product('risk-ranges').status = 'failed';
  data.product('risk-ranges').stages = { received: true };
  data.product('risk-ranges').errorCode = 'PARSER_FAILED';
  const third = (await run(data, later)).findings[0];
  assert.equal(first.id, third.id);
  assert.notEqual(first.fingerprint, third.fingerprint);
});

test('failed artifact proves Early Look receipt even when the success stage was never written', async () => {
  const data = fixture();
  Object.assign(data.product('early-look'), { status: 'failed', stages: {}, counts: { artifacts: 1, failures: 1 },
    errorCode: 'RESEARCH_PRODUCT_PROCESSING_FAILED', sourceIds: ['1a0c8dfa392f7cc3'],
    detail: 'Invalid risk range for RUSSELL 2000 (RUT): lrr=2834.0, hrr=2825.0' });
  Object.assign(data.check('gmail.ingestion'), { status: 'warn', blocking: false, impact: 'Some imports failed', errorCode: 'GMAIL_QUARANTINED_ARTIFACTS_PENDING' });
  const result = await run(data);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].symbol, 'Early Look');
  assert.equal(result.findings[0].incidentKey, 'research-product:early-look:2026-09-22');
  assert.match(JSON.stringify(result.findings[0].presentation), /conflicting lower and upper bounds/);
  assert.equal(result.findings[0].presentation.sourceLinks[1].citation.sourceUri, 'gmail://message/1a0c8dfa392f7cc3');
});

test('every registry snapshot consumer is compared to the observed publication without requiring an open window', async () => {
  const data = fixture();
  const snapshots = RESEARCH_PRODUCTS.filter(product => product.dashboardConsumer.kind === 'snapshot');
  for (const product of snapshots) Object.assign(data.product(product.id), { status: 'indexed', stages: { received: true, indexed: true } });
  const healthy = await run(data);
  assert.equal(healthy.findings.length, 0);
  assert.equal(healthy.diagnostics.coverage.snapshotConsumers.length, snapshots.length);
  data.snapshots['momo-tracker'].date = '2026-09-21';
  const behind = await run(data);
  assert.equal(behind.findings.length, 1);
  assert.equal(behind.findings[0].symbol, 'MOMO Tracker');
  assert.match(behind.findings[0].presentation.rows[0].text, /shows 2026-09-21, not 2026-09-22/);
});

const hedgaiCountIssue = (date = '2026-10-06') => ({
  id: 'original-counts', code: 'HEDGAI_PUBLISHED_BOOK_COUNT_DISCREPANCY', blocking: false,
  field: 'positionCounts', disposition: 'aggregate_unreconciled',
  source: { productId: 'hedgai-signals', reportDate: date, publishedAt: `${date}T12:49:00Z`,
    url: 'https://app.hedgeye.com/feed_items/187966' },
  observed: { published: { long: 5, short: 7 }, reconstructed: { long: 8, short: 7 } },
  sourceText: 'HedgAI Signals | 5 Longs and 7 Shorts',
});

test('HedgAI count discrepancy is a durable sourced incident independent of review or matrix availability', async () => {
  const now = '2026-10-06T16:00:00Z';
  const data = fixture(now);
  const issue = hedgaiCountIssue();
  data.hedgai.book.rows = Array.from({ length: 47 }, (_, index) => ({ ticker: `T${index}`, instrumentId: `hedgai:T${index}`,
    position: 'Buy', status: 'current', positionSourceIds: ['source'] }));
  data.hedgai.sourceQuality.issues = [issue, { code: 'HEDGAI_EMPTY_ACTION_CATEGORY', resolved: true, blocking: false }];
  data.report.researchProductMatrix.collectionErrors = ['unrelated provider unavailable'];
  const before = JSON.stringify(data.hedgai);
  const result = await run(data, now);
  const item = result.findings.find(row => row.symbol === 'HedgAI Signals');
  assert.equal(item.incidentKey, 'research-product:hedgai-signals:2026-10-06');
  assert.equal(item.sourceDiscrepancy, true);
  assert.equal(item.sourceReportDate, '2026-10-06');
  assert.equal(item.publicationTime, new Date(issue.source.publishedAt).toISOString());
  assert.deepEqual(item.sourceQuality.issues, [issue]);
  assert.match(item.presentation.rows[0].text, /Headline 5L\/7S ≠ recorded 8L\/7S/);
  assert.match(item.presentation.rows[1].text, /Parsing recovered/);
  assert.match(item.presentation.rows[2].text, /full-book PDF/);
  assert.match(item.presentation.rows[3].text, /47 readings usable; totals unreconciled/);
  assert.equal(item.presentation.sourceLinks.at(-1).citation.sourceUri, issue.source.url);
  assert.equal(item.presentation.sourceLinks.at(-1).citation.publicationDate, '2026-10-06');
  assert.equal(JSON.stringify(data.hedgai), before);
  data.hedgai.asOf = '2026-10-06T16:00:30Z';
  const again = (await run(data, '2026-10-06T16:00:30Z')).findings.find(row => row.symbol === 'HedgAI Signals');
  assert.equal(again.id, item.id);
  assert.equal(again.fingerprint, item.fingerprint);
});

test('a resolved parser note is not a new HedgAI discrepancy and the real published-book consumer is checked', async () => {
  const data = fixture();
  data.hedgai.sourceQuality.issues = [{ code: 'HEDGAI_INSTRUMENT_UNMAPPED', resolved: true, blocking: false }];
  const result = await run(data);
  assert.equal(result.findings.length, 0);
  assert.deepEqual(result.diagnostics.coverage.publishedBookConsumers.map(row => [row.product, row.available]), [['hedgai-signals', true]]);
  assert.equal(RESEARCH_PRODUCTS.find(product => product.id === 'hedgai-signals').dashboardConsumer.kind, 'published-book');
});

test('a failed or unsafe book check cannot claim a recovered count discrepancy', async () => {
  for (const flags of [{ mock: true }, { seeded: true }, { fixture: true }, { stale: true }, { cacheOnly: true }, { offline: true }, { disconnected: true },
    { sourceQuality: { continuity: 'unknown', issues: [hedgaiCountIssue()] } }]) {
    const data = fixture();
    Object.assign(data.hedgai, flags);
    const result = await run(data);
    assert.equal(result.findings.length, 0);
    assert.equal(result.complete, false);
  }
  const data = fixture();
  const fetchJson = data.fetchJson;
  data.fetchJson = path => path.startsWith('/api/research/hedgai?') ? Promise.reject(new Error('offline')) : fetchJson(path);
  const result = await run(data);
  assert.equal(result.findings.length, 0);
  assert.equal(result.complete, false);
});

test('snapshot revision and empty data do not pass because another product or same-day source worked', async () => {
  const data = fixture();
  Object.assign(data.product('the-call'), { status: 'indexed', sourceIds: ['research/current.html'], stages: { received: true, indexed: true } });
  data.snapshots['the-call'].htmlSource = 'research/old.html';
  assert.equal((await run(data)).findings.length, 1);
  data.snapshots['the-call'].htmlSource = 'research/current.html';
  assert.equal((await run(data)).findings.length, 0);
  data.snapshots['the-call'].data = {};
  assert.equal((await run(data)).findings.length, 1);
});

test('retired Hermes worker and bridge checks never generate inbox messages', async () => {
  const data = fixture();
  data.report.groups[0].checks.push(...['hermes.quant-analyst', 'hermes.quant-developer', 'hermes.security', 'hermes.status', 'dashboard.hermes-bridge'].map(id => ({
    id, label: id, status: 'fail', blocking: true, dependsOn: [], capabilityIds: [], errorCode: 'HERMES_SCHEDULE_STALE',
  })));
  const result = await run(data);
  assert.equal(result.findings.length, 0);
  assert.equal(result.diagnostics.suppressedServiceChecks.length, 5);
  // The single active Analyst still has a genuine availability check.
  data.report.groups[0].checks.push({ id: 'analyst.runtime', label: 'The Analyst', status: 'fail', blocking: true, dependsOn: [], capabilityIds: [] });
  const active = await run(data);
  assert.equal(active.findings.length, 1);
  assert.equal(active.findings[0].symbol, 'Analyst monitoring');
});

test('an incomplete monitor cannot resolve a previously reported portfolio failure', async () => {
  const data = fixture();
  data.report.groups[0].checks = data.report.groups[0].checks.filter(check => check.id !== 'ibkr.portfolio');
  const result = await run(data);
  assert.equal(result.complete, false);
  assert.deepEqual(result.completeKinds, []);
  assert.equal(result.findings[0].symbol, 'Dashboard monitoring');
});

test('new verified position status supersedes a cached disconnection without declaring full-account recovery', async () => {
  const data = fixture();
  Object.assign(data.check('ibkr.gateway'), { status: 'fail', errorCode: 'IBKR_GATEWAY_NOT_AUTHENTICATED', impact: 'No portfolio data.' });
  data.status.checkedAt = '2026-09-22T15:01:00Z';
  data.status.services[1].details = ['ibkr-sidecar', 'gateway-session', 'managed-account', 'fresh-session']
    .map(id => ({ id, status: 'online' }));
  const result = await run(data, '2026-09-22T15:01:00Z');
  assert.equal(result.complete, false);
  assert.equal(result.findings.length, 1);
  assert.match(result.findings[0].presentation.rows[0].text, /full recovery unverified/);
  assert.doesNotMatch(JSON.stringify(result.findings), /Gateway is disconnected/);
  data.status.services[1].details.pop();
  const socketOnly = await run(data, '2026-09-22T15:01:00Z');
  assert.equal(socketOnly.findings[0].symbol, 'IB Gateway');
  assert.equal(socketOnly.findings[0].fingerprint, result.findings[0].fingerprint,
    'Recovery checks alone must not notify an acknowledged unchanged incident again');
});

test('new successful UI and Analyst readbacks supersede cached startup failures', async () => {
  const data = fixture();
  data.report.groups[0].checks.push(...['dashboard.ui', 'analyst.runtime'].map(id => ({
    id, status: 'fail', blocking: true, impact: 'Service unavailable', dependsOn: [], capabilityIds: [],
  })));
  data.status.checkedAt = '2026-09-22T15:01:00Z';
  data.status.services.push(
    { id: 'dashboard', details: [{ id: 'react-ui', status: 'online' }] },
    { id: 'ai', details: [{ id: 'analyst-runtime', status: 'online' }] },
  );
  assert.deepEqual((await run(data, '2026-09-22T15:01:00Z')).findings, []);
});

test('deep collection completion cannot overrule a fresh successful UI probe or create timeout oscillation', async () => {
  const data = fixture();
  data.report.groups[0].checks.push({
    id: 'dashboard.ui', label: 'Dashboard UI', status: 'fail', blocking: true,
    impact: 'The dashboard cannot be opened in the browser.', dependsOn: [], capabilityIds: [],
    errorCode: 'DASHBOARD_UI_UNREACHABLE',
  });
  data.report.checkedAt = '2026-09-22T15:01:05Z';
  data.status.checkedAt = '2026-09-22T15:01:00Z';
  const dashboard = { id: 'dashboard', details: [{ id: 'react-ui', status: 'online' }] };
  data.status.services.push(dashboard);
  for (const status of ['online', 'unknown', 'online', 'unknown']) {
    dashboard.details[0].status = status;
    const result = await run(data, '2026-09-22T15:01:05Z');
    assert.deepEqual(result.findings, [], `${status} must not become a claimed page outage`);
    if (status === 'unknown') assert.equal(result.complete, false);
  }
  dashboard.details[0].status = 'offline';
  const outage = await run(data, '2026-09-22T15:01:05Z');
  assert.equal(outage.findings.length, 1);
  assert.match(outage.findings[0].presentation.rows[0].text, /Dashboard page down/);
  assert.doesNotMatch(JSON.stringify(outage.findings), /cannot be opened/);
});
