const test = require('node:test');
const assert = require('node:assert/strict');
const { createSourceDiagnostics, THROTTLE_MS } = require('./analystSourceDiagnostics.cjs');

const NOW = '2026-09-22T18:00:00.000Z';
const DAY = '2026-09-22';
const source = (changes = {}) => ({ id: 'early-look', label: 'Early Look', status: 'missing', observedAt: null, ...changes });
const capture = (changes = {}) => ({ basis: 'review', state: 'succeeded', conversationId: 'conversation-1', runId: 'run-1',
  capturedAt: '2026-09-22T17:50:00.000Z', checkedAt: NOW, items: [source()], ...changes });
function setup() {
  let clock = new Date(NOW);
  const settings = new Map(); const saved = new Map(); const writes = []; const paths = [];
  const report = { checkedAt: NOW, researchProductMatrix: { generatedAt: NOW, collectionErrors: [], marketDate: DAY,
    products: [{ id: 'early-look', marketDate: DAY, status: 'failed', stages: { received: false }, counts: { artifacts: 1, failures: 1 },
      errorCode: 'RESEARCH_PRODUCT_PROCESSING_FAILED', detail: 'Research parse/materialization failed: Invalid risk range for RUSSELL 2000 (RUT): lrr=2834.0, hrr=2825.0' }] } };
  const snapshot = { date: DAY, snapshotType: 'early-look', source: 'hedgeye', data: { article: 'Verified published commentary' } };
  const balance = { available: true, status: 'live', source: 'ibkr_live_session', fromCache: false,
    observedAt: NOW, socketVerifiedAt: NOW, accountValuesObservedAt: NOW, freshness: { status: 'fresh' } };
  const status = { checkedAt: NOW, services: [{ id: 'live-portfolio', status: 'online', details: [{ id: 'gateway-session', status: 'online' }] }] };
  const fetchJson = async path => {
    paths.push(path);
    if (path === '/api/system-readiness') return report;
    if (path === '/api/portfolio/balance') return balance;
    if (path === '/api/system-status') return status;
    if (path === `/api/hedgeye/snapshot/early-look?date=${DAY}`) return snapshot;
    throw new Error(`Unexpected read ${path}`);
  };
  const call = async (operation, body = {}) => {
    if (operation === 'setting') {
      if (Object.hasOwn(body, 'value')) settings.set(body.key, structuredClone(body.value));
      return { value: settings.get(body.key) };
    }
    if (operation === 'findings') return { findings: [...saved.values()] };
    assert.equal(operation, 'finding');
    writes.push(structuredClone(body.finding));
    const old = saved.get(body.finding.id);
    const material = old?.payload.fingerprint !== body.finding.fingerprint;
    saved.set(body.finding.id, { id: body.finding.id, payload: structuredClone(body.finding), unread: material ? 1 : old.unread,
      acknowledged_at: old?.acknowledged_at || null });
    return { material };
  };
  const service = (options = {}) => createSourceDiagnostics({ call, fetchJson, now: () => new Date(clock), ...options });
  return { service, report, product: report.researchProductMatrix.products[0], snapshot, balance, status, saved, writes, paths,
    setTime: value => { clock = new Date(value); report.checkedAt = clock.toISOString(); report.researchProductMatrix.generatedAt = clock.toISOString(); } };
}
const text = finding => finding.presentation.rows.map(row => `${row.label}: ${row.text}`).join('\n');

test('source exclusions remain in Sources without generating or rewriting Inbox findings', async () => {
  const cases = [
    { id: 'inflation-nowcast', label: 'Monthly Inflation Nowcast' },
    { id: 'bitcoin-trend-tracker', label: 'Bitcoin Tracker' },
    { id: 'risk-ranges', label: 'Risk Ranges' },
    { id: 'portfolioBalance', label: 'IBKR account exposure', requiresIbGateway: true },
    { id: 'portfolioPca', label: 'PCA model' },
    { id: 'portfolio', label: 'IBKR holdings', requiresIbGateway: true },
    { id: 'portfolioOpenOrders', label: 'IBKR open orders', requiresIbGateway: true },
    { id: 'prediction:cpi:forecastex', label: 'CPI · ForecastEx', requiresIbGateway: true },
    { id: 'marketSituation', label: 'Market data' },
  ];
  for (const item of cases) {
    for (const status of ['missing', 'unavailable']) {
      const f = setup();
      const sources = capture({ items: [source({ ...item, status })] });
      const original = structuredClone(sources);
      assert.deepEqual((await f.service().inspect(sources)).findings, [], `${item.label}: ${status}`);
      assert.deepEqual(f.writes, []);
      assert.deepEqual(sources, original);
    }
  }
});

test('partial archive coverage gaps stay in Sources through repeated inspections', async () => {
  const f = setup();
  const sources = capture({ items: [source({ id: 'portfolioRefreshResearch', label: 'Portfolio research archive', status: 'partial', observedAt: NOW,
    detail: '54 source publications; complete available archive scan; 2 products with archived gaps',
    diagnostic: { code: 'PORTFOLIO_REFRESH_ARCHIVE_PARTIAL' }, archiveCoverage: { count: 2,
      products: [{ id: 'etf-pro', label: 'ETF Pro', status: 'partial', reasons: ['source-uri-unavailable'] }],
      reasons: ['source-uri-unavailable', 'unverified-source-field'] } })] });
  const original = structuredClone(sources);
  assert.deepEqual((await f.service().inspect(sources)).findings, []);
  assert.deepEqual(await f.service().inspect(sources), { skipped: 'throttled' });
  f.setTime(new Date(Date.parse(NOW) + THROTTLE_MS + 1));
  assert.deepEqual((await f.service().inspect(sources)).findings, []);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.paths, []);
  assert.deepEqual(sources, original);
});

test('missing, failed and recovered research without a publication discrepancy produces no Inbox warning', async () => {
  for (const changes of [
    { status: 'missing', stages: { received: false }, counts: { artifacts: 0, failures: 0 }, errorCode: 'RESEARCH_PRODUCT_DUE_MISSING', detail: 'No publication received.' },
    { status: 'failed', detail: 'Publication import timed out.' },
    { status: 'indexed', stages: { received: true, indexed: true }, counts: { artifacts: 1, failures: 0 }, detail: 'Indexing verified.' },
  ]) {
    const f = setup(); Object.assign(f.product, changes);
    const sources = capture(); const original = structuredClone(sources);
    assert.deepEqual((await f.service().inspect(sources)).findings, []);
    assert.deepEqual(f.writes, []);
    assert.deepEqual(sources, original);
  }
});

test('research readback must have the captured date, matching product and verified content before adding a discrepancy', async () => {
  for (const change of [{ date: '2026-09-21' }, { snapshotType: 'the-call' }, { data: {} }, { contentComplete: false }, { error: 'failure' },
    { stale: true }, { fromCache: true }, { mock: true }, { seeded: true }, { cacheOnly: true }]) {
    const f = setup(); Object.assign(f.product, { status: 'indexed', stages: { indexed: true }, detail: 'Publication indexed.' });
    Object.assign(f.snapshot, { sourceQuality: discrepancy(), ...change });
    assert.deepEqual((await f.service().inspect(capture())).findings, [], JSON.stringify(change));
    assert.deepEqual(f.writes, []);
  }
  const f = setup(); Object.assign(f.product, { status: 'indexed', stages: { indexed: true }, detail: 'Publication indexed.' });
  f.snapshot.sourceQuality = discrepancy();
  const finding = (await f.service().inspect(capture())).findings[0];
  assert.equal(finding.sourceDiscrepancy, true);
  assert.equal(finding.diagnosisStage, 'source-discrepancy');
  assert.match(text(finding), /published lower 2,834 exceeds upper 2,825/);
});

test('stale, disconnected, cache-only, mock and seeded readiness evidence cannot invent a source discrepancy', async () => {
  for (const change of [{ stale: true }, { mock: true }, { seeded: true }, { fromCache: true }, { cacheOnly: true }, { connected: false },
    { checkedAt: '2026-09-22T17:53:00Z' }]) {
    const f = setup(); Object.assign(f.report, change);
    assert.deepEqual((await f.service().inspect(capture())).findings, [], JSON.stringify(change));
    assert.deepEqual(f.writes, []);
  }
});

test('research matrix must be fresh and concern the captured New York market day', async () => {
  for (const change of [{ generatedAt: '2026-09-22T17:53:59Z' }, { collectionErrors: ['missing evidence'] }]) {
    const f = setup(); Object.assign(f.report.researchProductMatrix, change);
    assert.deepEqual((await f.service().inspect(capture())).findings, []);
    assert.deepEqual(f.writes, []);
  }
  const f = setup(); f.product.marketDate = '2026-09-23';
  assert.deepEqual((await f.service().inspect(capture())).findings, []);
  const g = setup(); const finding = (await g.service().inspect(capture({ capturedAt: '2026-09-23T01:00:00Z' }))).findings[0];
  assert.equal(finding.incidentKey, 'research-product:early-look:2026-09-22');
});

test('broker outages, failed balance evidence and successful recovery never become review-source Inbox warnings', async () => {
  for (const id of ['balance', 'portfolioBalance', 'portfolio', 'portfolioOpenOrders', 'prediction:cpi:forecastex']) {
    for (const online of [true, false]) {
      const f = setup(); f.status.services[0].details[0].status = online ? 'online' : 'offline';
      Object.assign(f.balance, online ? {} : { available: false, status: 'unavailable', source: 'unavailable', errorCode: 'GATEWAY_UNAVAILABLE' });
      const sources = capture({ items: [source({ id, label: 'IBKR source', requiresIbGateway: true, status: 'unavailable', diagnostic: { code: 'BALANCE_ACCOUNT_REQUIRED' } })] });
      const original = structuredClone(sources);
      assert.deepEqual((await f.service().inspect(sources)).findings, []);
      assert.deepEqual(f.writes, []);
      assert.deepEqual(sources, original);
    }
  }
  for (const changes of [{ stale: true }, { offline: true }, { mock: true }, { seeded: true }, { cacheOnly: true }, { fromCache: true },
    { source: 'ibkr_cache' }, { socketVerifiedAt: '2026-09-22T17:58:00Z' }, { freshness: { status: 'stale' } }]) {
    const f = setup(); Object.assign(f.balance, changes);
    assert.deepEqual((await f.service().inspect(capture({ items: [source({ id: 'portfolioBalance', requiresIbGateway: true })] }))).findings, []);
    assert.deepEqual(f.writes, []);
  }
});

test('structured provider HTTP failures remain in Sources without generating an Inbox incident', async () => {
  const originalFetch = global.fetch; const f = setup();
  global.fetch = async url => ({ ok: !url.endsWith('/balance'), json: async () => url.endsWith('/balance')
    ? { available: false, status: 'unavailable', source: 'unavailable', fromCache: false, observedAt: NOW, errorCode: 'GATEWAY_UNAVAILABLE' }
    : { checkedAt: null } });
  const sources = capture({ items: [source({ id: 'balance', label: 'IBKR balances', requiresIbGateway: true, status: 'unavailable' })] });
  const original = structuredClone(sources);
  try {
    assert.deepEqual((await f.service({ fetchJson: null }).inspect(sources)).findings, []);
    assert.deepEqual(f.writes, []);
    assert.deepEqual(sources, original);
  } finally { global.fetch = originalFetch; }
});

test('captured archive failures and inconclusive checks do not generate generic Inbox warnings', async () => {
  for (const diagnostic of ['RESEARCH_ARCHIVE_TIMEOUT', 'RESEARCH_ARCHIVE_UNAVAILABLE', 'RESEARCH_ARCHIVE_INVALID_RESPONSE', 'RESEARCH_ARCHIVE_DATE_MISMATCH']) {
    for (const recovered of [true, false]) {
      const f = setup();
      Object.assign(f.product, recovered
        ? { status: 'indexed', stages: { indexed: true }, detail: 'Indexed.' }
        : { status: 'missing', errorCode: 'RESEARCH_PRODUCT_DUE_MISSING', stages: { received: false }, counts: { artifacts: 0, failures: 0 }, detail: 'No publication received.' });
      const sources = capture({ items: [source({ status: 'unavailable', diagnostic: { code: diagnostic, message: 'SECRET or fabricated claim' } })] });
      const original = structuredClone(sources);
      assert.deepEqual((await f.service().inspect(sources)).findings, []);
      assert.deepEqual(f.writes, []);
      assert.deepEqual(sources, original);
    }
  }
  const f = setup();
  assert.deepEqual((await f.service({ fetchJson: async () => { throw new Error('Provider unavailable'); } }).inspect(capture())).findings, []);
  assert.deepEqual(f.writes, []);
});

test('older generic incidents are neither reused nor rewritten by new source checks', async () => {
  const f = setup(); const first = (await f.service().inspect(capture())).findings[0];
  const saved = f.saved.get(first.id);
  delete saved.payload.sourceDiscrepancy; delete saved.payload.sourceQuality;
  saved.payload.presentation.rows[0].text = 'Early Look was excluded from this saved review.';
  saved.unread = 0; saved.acknowledged_at = NOW;
  const original = structuredClone(saved);
  f.product.detail = 'Publication import timed out.';
  f.setTime(new Date(Date.parse(NOW) + THROTTLE_MS + 1));
  f.writes.length = 0;
  const newer = capture({ runId: 'run-2', capturedAt: '2026-09-22T18:03:00Z' });
  assert.deepEqual((await f.service().inspect(newer)).findings, []);
  f.report.checkedAt = null;
  assert.deepEqual((await f.service().inspect(capture({ ...newer, items: [source({ status: 'ready', observedAt: NOW })] }))).findings, []);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(saved, original);
});

test('received artifact failures explain the reversed range despite received false, with Systems evidence', async () => {
  const f = setup(); const sources = capture(); const original = structuredClone(sources);
  const result = await f.service().inspect(sources); const finding = result.findings[0];
  assert.deepEqual(sources, original);
  assert.equal(finding.managedBy, 'review-sources'); assert.equal(finding.kind, 'operational'); assert.equal(finding.attentionVersion, 1);
  assert.equal(finding.incidentKey, 'research-product:early-look:2026-09-22');
  assert.deepEqual(finding.presentation.rows.map(row => row.label), ['Problem', 'Cause', 'Solution', 'Status']);
  assert.match(text(finding), /received publication.*reversed RUT range \(2,834–2,825\)/);
  assert.match(text(finding), /Import the full publication, retain its original values/);
  assert.match(text(finding), /withhold only disputed fields from calculations/);
  assert.equal(finding.sourceDiscrepancy, true);
  assert.doesNotMatch(text(finding), /not received|no received|lrr=|RESEARCH_PRODUCT_PROCESSING_FAILED/);
  assert.match(finding.citation.excerpt, /lrr=2834.0, hrr=2825.0/);
  assert.equal(finding.citation.sourceUri, '/api/system-readiness');
});

test('pre-run, running, and checking sources never produce incidents', async () => {
  for (const changes of [{ basis: 'readiness' }, { state: 'running' }, { state: 'pending' }, { runId: null }, { items: [source({ status: 'checking' })] }]) {
    const f = setup(); await f.service().inspect(capture(changes)); assert.equal(f.writes.length, 0); assert.equal(f.paths.length, 0);
  }
  for (const state of ['succeeded', 'failed', 'cancelled']) {
    const f = setup(); assert.equal((await f.service().inspect(capture({ state }))).findings.length, 1);
  }
});

test('single flight and durable throttling suppress duplicate inspections through service recreation', async () => {
  const f = setup(); const service = f.service(); const sources = capture();
  const a = service.inspect(sources); const b = service.inspect(sources); assert.equal(a, b); await Promise.all([a, b]);
  assert.equal(f.writes.length, 1);
  assert.deepEqual(await f.service().inspect(sources), { skipped: 'throttled' }); assert.equal(f.paths.length, 1);
});

test('unchanged diagnosis preserves first publication, fingerprint and acknowledgment across newer runs', async () => {
  const f = setup(); const first = (await f.service().inspect(capture())).findings[0];
  f.saved.get(first.id).acknowledged_at = NOW; f.saved.get(first.id).unread = 0;
  f.setTime(new Date(Date.parse(NOW) + THROTTLE_MS + 1));
  const repeated = (await f.service().inspect(capture({ runId: 'run-2', capturedAt: '2026-09-22T18:03:00Z' }))).findings[0];
  assert.equal(repeated.id, first.id); assert.equal(repeated.fingerprint, first.fingerprint); assert.equal(repeated.publicationTime, first.publicationTime);
  assert.equal(f.saved.get(first.id).acknowledged_at, NOW); assert.equal(f.saved.get(first.id).unread, 0);
});

test('an inconclusive recheck preserves an acknowledged verified cause and does not reopen it', async () => {
  const f = setup(); const first = (await f.service().inspect(capture())).findings[0];
  f.saved.get(first.id).acknowledged_at = NOW; f.saved.get(first.id).unread = 0;
  f.setTime(new Date(Date.parse(NOW) + THROTTLE_MS + 1)); f.report.checkedAt = null;
  const repeated = (await f.service().inspect(capture())).findings[0];
  assert.deepEqual(repeated.presentation, first.presentation); assert.equal(repeated.fingerprint, first.fingerprint);
  assert.equal(repeated.publicationTime, first.publicationTime); assert.equal(repeated.currentVerification, 'unavailable');
  assert.equal(f.saved.get(first.id).unread, 0); assert.equal(f.saved.get(first.id).acknowledged_at, NOW);
});

const discrepancy = () => ({ status: 'discrepancy', issues: [{ id: 'rut-range-original', code: 'invalid_bounds',
  ticker: 'RUT', field: 'riskRange', observed: { lrr: 2834, hrr: 2825, trend: 'BULLISH' },
  disposition: 'withheld_from_structured_data',
  source: { productId: 'early-look', reportDate: DAY, messageId: '1a0c8dfa392f7cc3', url: 'https://app.hedgeye.com/feed_items/187503' } }] });

test('imported source discrepancies retain usable research and exact published evidence without declaring source correction', async () => {
  const f = setup();
  Object.assign(f.product, { status: 'indexed', stages: { indexed: true }, sourceQuality: discrepancy(), detail: 'Publication indexed.' });
  f.snapshot.sourceQuality = discrepancy();
  const finding = (await f.service().inspect(capture())).findings[0];
  assert.equal(finding.diagnosisStage, 'source-discrepancy');
  assert.equal(finding.sourceDiscrepancy, true);
  assert.deepEqual(finding.sourceQuality.issues[0].observed, { lrr: 2834, hrr: 2825, trend: 'BULLISH' });
  assert.match(text(finding), /published lower 2,834 exceeds upper 2,825/);
  assert.match(text(finding), /publication and unaffected research are available/);
  assert.match(text(finding), /only disputed fields are withheld from calculations/);
  assert.match(text(finding), /source discrepancy remains open/);
  assert.doesNotMatch(text(finding), /excluded|saved review|Refresh this review/);
  assert.doesNotMatch(text(finding), /processing.*repair|recovered publication|corrected/);
  assert.equal(finding.presentation.sourceLinks[1].citation.sourceUri, 'https://app.hedgeye.com/feed_items/187503');
});

test('a newer ready review does not resolve or discard the original source discrepancy', async () => {
  const f = setup();
  Object.assign(f.product, { status: 'indexed', stages: { indexed: true }, sourceQuality: discrepancy(), detail: 'Publication indexed.' });
  const first = (await f.service().inspect(capture())).findings[0];
  f.snapshot.sourceQuality = { status: 'clear', issues: [] };
  f.product.sourceQuality = { status: 'clear', issues: [] };
  const ready = source({ status: 'ready', observedAt: NOW });
  const second = (await f.service().inspect(capture({ runId: 'run-2', capturedAt: NOW, items: [ready] }))).findings[0];
  assert.equal(second.id, first.id); assert.equal(second.state, 'open');
  assert.equal(second.sourceQuality.issues.length, 1);
  assert.match(text(second), /source discrepancy remains open/);
  assert.doesNotMatch(text(second), /saved review still excludes|No further action|Resolved/);
});

test('rechecking the same available discrepancy does not reopen an acknowledged issue', async () => {
  const f = setup();
  Object.assign(f.product, { status: 'indexed', stages: { indexed: true }, sourceQuality: discrepancy(), detail: 'Publication indexed.' });
  const first = (await f.service().inspect(capture())).findings[0];
  f.saved.get(first.id).unread = 0; f.saved.get(first.id).acknowledged_at = NOW;
  f.setTime(new Date(Date.parse(NOW) + THROTTLE_MS + 1));
  const repeated = (await f.service().inspect(capture())).findings[0];
  assert.equal(repeated.fingerprint, first.fingerprint);
  assert.equal(f.saved.get(first.id).unread, 0);
});

test('removing legacy exclusion copy does not reopen an acknowledged publication discrepancy', async () => {
  const f = setup();
  Object.assign(f.product, { status: 'indexed', stages: { indexed: true }, sourceQuality: discrepancy(), detail: 'Publication indexed.' });
  f.snapshot.sourceQuality = discrepancy();
  const first = (await f.service().inspect(capture())).findings[0];
  const saved = f.saved.get(first.id);
  saved.payload.presentation.rows[0].text = 'Early Look was excluded from this saved review.';
  saved.payload.presentation.rows.find(row => row.label === 'Status').text = 'This saved review still excludes the publication.';
  saved.payload.fingerprint = 'legacy-publication-discrepancy';
  saved.unread = 0; saved.acknowledged_at = NOW;
  f.setTime(new Date(Date.parse(NOW) + THROTTLE_MS + 1));
  const repeated = (await f.service().inspect(capture())).findings[0];
  assert.equal(repeated.fingerprint, 'legacy-publication-discrepancy');
  assert.equal(repeated.publicationTime, first.publicationTime);
  assert.equal(f.saved.get(first.id).unread, 0);
  assert.equal(f.saved.get(first.id).acknowledged_at, NOW);
  assert.match(text(repeated), /source-data discrepancy/);
  assert.doesNotMatch(text(repeated), /excluded|saved review|Refresh this review/);
});
