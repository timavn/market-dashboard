const test = require('node:test');
const assert = require('node:assert/strict');
const { createReviewSources } = require('./analystReviewSources.cjs');
const { reviewSourceDisplayItems } = require('./analystReviewSourcePresentation.cjs');

const at = '2026-09-18T18:00:00.000Z';
const conversation = (changes = {}) => ({ id: 'conversation-1', kind: 'portfolio-review', messages: [], ...changes });
function setup({ saved = conversation(), record = { runId: 'run-1' }, result, readiness } = {}) {
  const requests = [];
  const request = async (path, options) => {
    requests.push({ path, options });
    if (path === '/internal/workspace/readiness') return readiness;
    return result || { runId: 'run-1', conversationId: saved.id, reviewKind: saved.kind, state: 'running', checkedAt: at, items: [] };
  };
  const calls = [];
  const call = async (operation, body) => {
    calls.push({ operation, body });
    assert.equal(operation, 'source-binding');
    assert.equal(body.conversationId, saved.id);
    const latest = saved.messages?.findLast(message => /^(daily-report|review-message):/.test(message.source_id || ''));
    return { conversation: { id: saved.id, kind: saved.kind, activeTurn: saved.activeTurn },
      runId: record?.runId || saved.referenceReview?.runId || latest?.source_id?.split(':')[1] || null };
  };
  return { service: createReviewSources({ request, call, now: () => new Date(at) }), requests, calls };
}

test('review sources use the exact saved run and project compact metadata only', async () => {
  const { service, requests, calls } = setup({ result: {
    runId: 'run-1', conversationId: 'conversation-1', reviewKind: 'portfolio-review', state: 'succeeded', checkedAt: '2026-09-17T18:00:00Z',
    reportMarkdown: 'Private report', rawEvidence: { account: 'sensitive' },
    items: [{ id: 'risk-ranges', label: 'Risk Ranges', status: 'ready', observedAt: '2026-09-17', publishedAt: '2026-09-17', netLiquidation: 123456 }],
  } });
  const result = await service.getReviewSources('conversation-1');
  assert.deepEqual(requests.map(row => row.path), ['/internal/reviews/run-1/sources']);
  assert.deepEqual(calls, [{ operation: 'source-binding', body: { conversationId: 'conversation-1' } }]);
  assert.equal(result.basis, 'review');
  assert.equal(result.checkedAt, '2026-09-17T18:00:00Z');
  assert.deepEqual(result.items, [{ id: 'risk-ranges', label: 'Risk Ranges', status: 'ready', observedAt: '2026-09-17', publishedAt: '2026-09-17' }]);
  assert.doesNotMatch(JSON.stringify(result), /Private report|sensitive|123456/);
});

test('the captured Gateway check remains separate from account data outcomes and excludes account evidence', async () => {
  const { service } = setup({ result: {
    runId: 'run-1', conversationId: 'conversation-1', reviewKind: 'portfolio-review', state: 'succeeded', checkedAt: at,
    items: [{ id: 'ibGateway', label: 'IB Gateway', status: 'ready', observedAt: '2026-09-18T17:59:00Z',
      requiresIbGateway: true, timestampKind: 'captured', data: { accounts: ['private-account'] } },
    { id: 'portfolio', label: 'IBKR holdings', status: 'unavailable', requiresIbGateway: true,
      diagnostic: { code: 'IBKR_HOLDINGS_TIMEOUT' } }],
  } });
  const result = await service.getReviewSources('conversation-1');
  assert.equal(result.items[0].status, 'ready');
  assert.equal(result.items[0].observedAt, '2026-09-18T17:59:00Z');
  assert.equal(result.items[0].timestampKind, 'captured');
  assert.equal(result.items[1].status, 'unavailable');
  assert.doesNotMatch(JSON.stringify(result), /private-account|accounts/);
});

test('source metadata preserves explicit capture semantics and Gateway requirements only', async () => {
  const { service } = setup({ result: {
    runId: 'run-1', conversationId: 'conversation-1', reviewKind: 'portfolio-review', state: 'succeeded', checkedAt: at,
    items: [
      { id: 'market-structure', label: 'Market Situation Report', status: 'ready', observedAt: '2026-09-18T10:30:42Z', publishedAt: '2026-09-18', timestampKind: 'captured' },
      { id: 'marketSituation', label: 'Market data', status: 'ready', observedAt: at, timestampKind: 'review-captured', detail: 'Review capture; source data through 2026-09-18' },
      { id: 'portfolio', label: 'IBKR holdings', status: 'unavailable', requiresIbGateway: true },
      { id: 'research', label: 'Research', status: 'missing', requiresIbGateway: 'true', timestampKind: 'invented' },
    ],
  } });
  const result = await service.getReviewSources('conversation-1');
  assert.equal(result.items[0].timestampKind, 'captured');
  assert.equal(result.items[0].publishedAt, '2026-09-18');
  assert.equal(result.items[1].timestampKind, 'review-captured');
  assert.equal(result.items[1].detail, 'Review capture; source data through 2026-09-18');
  assert.equal(result.items[2].requiresIbGateway, true);
  assert.equal(result.items[3].requiresIbGateway, undefined);
  assert.equal(result.items[3].timestampKind, undefined);
});

test('failed acquisition exposes only its typed diagnosis and original capture time', async () => {
  const { service } = setup({ result: {
    runId: 'run-1', conversationId: 'conversation-1', reviewKind: 'portfolio-review', state: 'succeeded',
    capturedAt: at, checkedAt: at,
    items: [{ id: 'portfolioBalance', label: 'IBKR account exposure', status: 'unavailable',
      diagnostic: { code: 'IBKR_BALANCE_TIMEOUT', message: 'Private account information', balance: 123456 } },
    { id: 'portfolio', label: 'IBKR holdings', status: 'unavailable', diagnostic: { code: 'Private account 123456' } }],
  } });
  const result = await service.getReviewSources('conversation-1');
  assert.equal(result.capturedAt, at);
  assert.equal(result.items[0].diagnostic.code, 'IBKR_BALANCE_TIMEOUT');
  assert.match(result.items[0].diagnostic.reason, /request timed out/);
  assert.match(result.items[0].diagnostic.remedy, /saved capture stays unchanged/);
  assert.equal(result.items[1].diagnostic, undefined);
  assert.doesNotMatch(JSON.stringify(result), /Private|123456/);
});

test('source explanations retain only bounded trusted reason and remedy beside a valid typed code', async () => {
  const { service } = setup({ result: {
    runId: 'run-1', conversationId: 'conversation-1', reviewKind: 'portfolio-review', state: 'succeeded', capturedAt: at,
    items: [{ id: 'signal-strength', label: 'Signal Strength', status: 'missing',
      diagnostic: { code: 'RESEARCH_PUBLICATION_NOT_CAPTURED', reason: 'No eligible publication was present in this capture.',
        remedy: 'Verify publication delivery, then refresh this review.', message: 'Private provider error', account: 123456 } },
    { id: 'portfolioRefreshResearch', label: 'Portfolio research archive', status: 'partial',
      diagnostic: { code: 'PORTFOLIO_REFRESH_ARCHIVE_PARTIAL', reason: 'x'.repeat(1000), remedy: '  Verify\nsource provenance.  ',
        providerResponse: 'Private source body' } },
    { id: 'invalid', label: 'Invalid', status: 'unavailable', diagnostic: { code: 'Private provider failure', reason: 'Private', remedy: 'Private' } }],
  } });
  const result = await service.getReviewSources('conversation-1');
  assert.deepEqual(result.items[0].diagnostic, { code: 'RESEARCH_PUBLICATION_NOT_CAPTURED',
    reason: 'No eligible publication was present in this capture.', remedy: 'Verify publication delivery, then refresh this review.' });
  assert.equal(result.items[0].detail, 'No eligible publication was present in this capture.');
  assert.equal(result.items[1].diagnostic.reason.length, 400);
  assert.equal(result.items[1].detail.length, 400);
  assert.equal(result.items[1].diagnostic.remedy, 'Verify source provenance.');
  assert.equal(result.items[2].diagnostic, undefined);
  assert.doesNotMatch(JSON.stringify(result), /Private|123456|providerResponse|message/);
});

test('partial archive preserves captured coverage gaps and excludes uncaptured provider fields', async () => {
  const coverage = { count: 2, products: [
    { id: 'etf-pro', label: 'ETF Pro', status: 'partial', reasons: ['source-uri-unavailable'], rawEvidence: 'Private source body' },
    { id: 'risk-ranges', label: 'Risk Ranges', status: 'partial', reasons: ['unverified-source-field'] },
  ], reasons: ['source-uri-unavailable', 'unverified-source-field', 'Private account 123456'], account: 123456 };
  const { service, requests } = setup({ result: {
    runId: 'run-1', conversationId: 'conversation-1', reviewKind: 'portfolio-review', state: 'succeeded', capturedAt: at, checkedAt: at,
    items: [{ id: 'portfolioRefreshResearch', label: 'Portfolio research archive', status: 'partial', observedAt: at,
      timestampKind: 'review-captured', detail: '54 source publications; complete available archive scan; 2 products with archived gaps',
      diagnostic: { code: 'PORTFOLIO_REFRESH_ARCHIVE_PARTIAL', providerResponse: 'Private provider response' }, archiveCoverage: coverage },
    { id: 'risk-ranges', label: 'Risk Ranges', status: 'ready', publishedAt: '2026-09-18', archiveCoverage: coverage }],
  } });
  const result = await service.getReviewSources('conversation-1');
  assert.equal(result.items[0].status, 'partial');
  assert.equal(result.items[0].observedAt, at);
  assert.equal(result.items[0].timestampKind, 'review-captured');
  assert.match(result.items[0].detail, /original source URL is unavailable \(ETF Pro\)/);
  assert.match(result.items[0].detail, /published fields failed verification \(Risk Ranges\)/);
  assert.match(result.items[0].detail, /54 source publications/);
  assert.deepEqual(result.items[0].archiveCoverage, { count: 2, products: [
    { id: 'etf-pro', label: 'ETF Pro', status: 'partial', reasons: ['source-uri-unavailable'] },
    { id: 'risk-ranges', label: 'Risk Ranges', status: 'partial', reasons: ['unverified-source-field'] },
  ], reasons: ['source-uri-unavailable', 'unverified-source-field'] });
  assert.equal(result.items[1].archiveCoverage, undefined);
  assert.deepEqual(requests.map(row => row.path), ['/internal/reviews/run-1/sources']);
  assert.doesNotMatch(JSON.stringify(result), /Private|123456|rawEvidence|providerResponse/);
});

test('partial archive explains captured provenance gaps with a bounded affected-product list', async () => {
  const labels = ['Risk Ranges', 'Signal Strength', 'The Call', 'ETF Pro', 'Early Look', 'Top 3 Things'];
  const { service } = setup({ result: {
    runId: 'run-1', conversationId: 'conversation-1', reviewKind: 'portfolio-review', state: 'succeeded',
    items: [{ id: 'portfolioRefreshResearch', label: 'Portfolio research archive', status: 'partial',
      detail: '1854 source publications; complete available archive scan; 6 products with archived gaps',
      diagnostic: { code: 'PORTFOLIO_REFRESH_ARCHIVE_PARTIAL', reason: 'Some publications have unverified provenance.',
        remedy: 'Verify original publication provenance; preserve the saved capture.' },
      archiveCoverage: { count: 6, products: labels.map((label, index) => ({ id: `product-${index}`, label,
        status: 'partial', reasons: ['source-provenance-missing'] })), reasons: ['source-provenance-missing'] } }],
  } });
  const result = await service.getReviewSources('conversation-1');
  assert.match(result.items[0].detail, /^No original source link, email identity, or artifact was captured/);
  assert.match(result.items[0].detail, /Risk Ranges, Signal Strength, The Call and 3 other products/);
  assert.match(result.items[0].detail, /1854 source publications/);
  assert.match(result.items[0].diagnostic.reason, /^No original source link, email identity, or artifact was captured/);
  assert.match(result.items[0].diagnostic.reason, /Risk Ranges, Signal Strength, The Call and 3 other products/);
  assert.doesNotMatch(result.items[0].diagnostic.reason, /Some publications have unverified provenance/);
  assert.equal(result.items[0].diagnostic.remedy, 'Verify original publication provenance; preserve the saved capture.');
  assert.ok(result.items[0].detail.length <= 400);
});

test('unknown archive qualification uses a trusted explanation and preserves substantive source detail', async () => {
  const { service } = setup({ result: {
    runId: 'run-1', conversationId: 'conversation-1', reviewKind: 'portfolio-review', state: 'succeeded',
    items: [{ id: 'portfolioRefreshResearch', label: 'Portfolio research archive', status: 'partial',
      detail: '54 source publications; complete available archive scan',
      diagnostic: { code: 'PORTFOLIO_REFRESH_ARCHIVE_PARTIAL', reason: 'Some archived publications did not qualify.' },
      archiveCoverage: { count: 1, products: [], reasons: ['new-qualification-code'] } },
    { id: 'market-structure', label: 'Market Structure', status: 'unavailable',
      detail: 'Original report date could not be verified.',
      diagnostic: { code: 'RESEARCH_PUBLICATION_REJECTED', reason: 'A publication did not qualify.' } }],
  } });
  const result = await service.getReviewSources('conversation-1');
  assert.equal(result.items[0].detail, 'Some archived publications did not qualify. 54 source publications; complete available archive scan');
  assert.doesNotMatch(result.items[0].detail, /new-qualification-code|URL|fields/);
  assert.equal(result.items[1].detail, 'Original report date could not be verified.');
});

test('captured dependency explanations distinguish auth, connection, timeout and service delivery failures', async () => {
  const codes = ['IBKR_GATEWAY_NOT_AUTHENTICATED', 'IBKR_GATEWAY_NOT_CONNECTED', 'GATEWAY_UNAVAILABLE',
    'BALANCE_REQUEST_TIMEOUT', 'IBKR_BALANCE_REQUEST_TIMEOUT', 'BALANCE_SNAPSHOT_TIMEOUT', 'IBKR_BALANCE_TIMEOUT',
    'IBKR_HOLDINGS_TIMEOUT', 'IBKR_POSITIONS_REQUEST_TIMEOUT', 'IBKR_SOCKET_VERIFICATION_TIMEOUT', 'OPEN_ORDERS_TIMEOUT',
    'BALANCE_SERVICE_UNAVAILABLE', 'UNKNOWN_CAPTURE_FAILURE'];
  const { service } = setup({ result: {
    runId: 'run-1', conversationId: 'conversation-1', reviewKind: 'portfolio-review', state: 'succeeded',
    items: codes.map((code, index) => ({ id: `source-${index}`, label: 'Captured source', status: 'unavailable',
      diagnostic: { code, message: 'Private provider body', recovered: true, account: 123456 } })),
  } });
  const result = await service.getReviewSources('conversation-1');
  assert.match(result.items[0].diagnostic.reason, /authenticated IB Gateway session/);
  for (const item of result.items.slice(1, 3)) assert.match(item.diagnostic.reason, /connection could not be verified/);
  for (const item of result.items.slice(3, 11)) {
    assert.match(item.diagnostic.reason, /request timed out/);
    assert.match(item.diagnostic.reason, /does not establish that IB Gateway was disconnected/);
    assert.match(item.diagnostic.remedy, /saved capture stays unchanged/);
  }
  assert.match(result.items[11].diagnostic.reason, /local balance service could not be reached/);
  assert.deepEqual(result.items[12].diagnostic, { code: 'UNKNOWN_CAPTURE_FAILURE' });
  assert.equal(result.items[12].detail, undefined);
  assert.doesNotMatch(JSON.stringify(result), /Private|123456|recovered/);
});

test('verified capture evidence is retained only for ready registered research publications', async () => {
  const { service } = setup({ result: {
    runId: 'run-1', conversationId: 'conversation-1', reviewKind: 'portfolio-review', state: 'succeeded', checkedAt: at,
    items: [
      { id: 'signal-strength', label: 'Signal Strength', status: 'ready', publishedAt: '2026-09-17', verifiedFromCapture: true },
      { id: 'the-macro-show', label: 'Macro Show', status: 'unavailable', verifiedFromCapture: true },
      { id: 'portfolio', label: 'IBKR holdings', status: 'ready', observedAt: at, verifiedFromCapture: true },
      { id: 'early-look', label: 'Early Look', status: 'ready', publishedAt: '2026-09-17', verifiedFromCapture: 'true' },
    ],
  } });
  const result = await service.getReviewSources('conversation-1');
  assert.equal(result.items[0].verifiedFromCapture, true);
  for (const item of result.items.slice(1)) assert.equal(item.verifiedFromCapture, undefined);
});

test('bounded readiness failures explain timeout and service delivery without claiming a verified disconnection', async () => {
  const { service } = setup({ result: {
    runId: 'run-1', conversationId: 'conversation-1', reviewKind: 'portfolio-review', state: 'failed',
    items: [{ id: 'portfolio', label: 'IBKR holdings', status: 'unavailable',
      diagnostic: { code: 'IBKR_GATEWAY_READINESS_TIMEOUT', message: 'Private provider connection details' } },
    { id: 'portfolioOpenOrders', label: 'IBKR open orders', status: 'unavailable',
      diagnostic: { code: 'IBKR_SERVICE_UNAVAILABLE', message: 'Private provider connection details' } }],
  } });
  const result = await service.getReviewSources('conversation-1');
  assert.match(result.items[0].diagnostic.reason, /one-second check/);
  assert.match(result.items[1].diagnostic.reason, /local IBKR service could not be reached/);
  for (const item of result.items) {
    assert.equal(item.status, 'unavailable');
    assert.match(item.diagnostic.remedy, /Systems.*refresh/);
    assert.doesNotMatch(item.diagnostic.reason, /Gateway was disconnected/);
  }
  assert.doesNotMatch(JSON.stringify(result), /Private provider/);
});

for (const mismatch of [{ runId: 'other-run' }, { conversationId: 'other-conversation' }, { reviewKind: 'balance-review' }]) {
  test(`review sources reject unrelated identity ${Object.keys(mismatch)[0]}`, async () => {
    const { service } = setup({ result: { runId: 'run-1', conversationId: 'conversation-1', reviewKind: 'portfolio-review', items: [], ...mismatch } });
    await assert.rejects(service.getReviewSources('conversation-1'), error => error.statusCode === 409);
  });
}

test('imported historical messages resolve their original run without current readiness', async () => {
  const { service, requests } = setup({ record: null, saved: conversation({ messages: [{ source_id: 'review-message:old-run:report' }] }),
    result: { runId: 'old-run', conversationId: 'conversation-1', reviewKind: 'portfolio-review', checkedAt: '2026-08-31T18:00:00Z', items: [] } });
  const result = await service.getReviewSources('conversation-1');
  assert.equal(result.runId, 'old-run');
  assert.deepEqual(requests.map(row => row.path), ['/internal/reviews/old-run/sources']);
});

function sourceReadiness(changes = {}) {
  return { feedGeneratedAt: at, errors: [], products: [{ product: 'risk-ranges', status: 'indexed', latestPublicationDate: '2026-09-18', observedAt: '2026-09-18T17:59:30.000Z', evidenceHash: 'verified-source-hash',
    sourceUri: 'https://app.hedgeye.com/feed_items/risk-ranges', stages: { received: true, parsed: true, validated: true, indexed: true } }],
  indexed: [{ product: 'risk-ranges', document_id: 'document-1', content_hash: 'verified-content-hash', source_uri: 'https://app.hedgeye.com/feed_items/risk-ranges', publication_date: '2026-09-18', indexed_at: at }], ...changes };
}

test('pre-run readiness is explicit and cannot check broker sources', async () => {
  const { service } = setup({ record: null, readiness: sourceReadiness() });
  const result = await service.getReviewSources('conversation-1');
  assert.equal(result.runId, null);
  assert.equal(result.basis, 'readiness');
  const byId = Object.fromEntries(result.items.map(item => [item.id, item]));
  assert.equal(byId['risk-ranges'].status, 'ready');
  assert.equal(byId['risk-ranges'].observedAt, '2026-09-18');
  assert.equal(byId.portfolio.status, 'missing');
  assert.equal(byId.portfolioOpenOrders.status, 'missing');
  assert.equal(byId.portfolio.requiresIbGateway, true);
  assert.equal(byId.portfolioOpenOrders.requiresIbGateway, true);
  assert.equal(byId.portfolioPca, undefined, 'the removed PCA model has no roster row');
  assert.equal(byId.portfolioFactors, undefined);
  assert.equal(byId['risk-ranges'].requiresIbGateway, undefined);
  assert.equal(byId['early-look'].status, 'missing');
});

for (const change of [{ feedGeneratedAt: '2026-09-17T18:00:00Z' }, { stale: true }, { cacheOnly: true }, { mock: true }, { seeded: true }, { connected: false }]) {
  test(`pre-run source evidence stays unchecked for ${Object.keys(change)[0]}`, async () => {
    const { service } = setup({ record: null, readiness: sourceReadiness(change) });
    const result = await service.getReviewSources('conversation-1');
    assert.equal(result.items.find(item => item.id === 'risk-ranges').status, 'unavailable');
  });
}

test('before a balance run, all inputs stay unchecked and no live reads are triggered', async () => {
  const { service, requests } = setup({ record: null, saved: conversation({ kind: 'balance-review', activeTurn: { id: 'accepted-turn' } }) });
  const result = await service.getReviewSources('conversation-1');
  assert.equal(result.items.length, 4);
  assert.ok(result.items.every(item => item.status === 'checking'));
  assert.deepEqual(requests, []);
});

test('prediction Sources lists only the setup board inputs without implying broker readiness', async () => {
  const { service } = setup({ record: null, saved: conversation({ kind: 'prediction-markets-review' }), readiness: sourceReadiness() });
  const result = await service.getReviewSources('conversation-1');
  assert.deepEqual(result.items.map(item => item.id), ['risk-ranges', 'crypto-quant', 'hedgai-signals', 'tradeResearch',
    'inflation-nowcast', 'marketPrices', 'volatilityIndices', 'usdCorrelations', 'kalshiContracts']);
  const byId = Object.fromEntries(result.items.map(item => [item.id, item]));
  assert.equal(byId['risk-ranges'].status, 'ready');
  for (const id of ['crypto-quant', 'inflation-nowcast', 'marketPrices', 'kalshiContracts']) assert.equal(byId[id].status, 'missing');
  for (const id of ['portfolio', 'balance', 'predictionUniverse', 'early-look', 'alphaCodes']) assert.equal(byId[id], undefined);
});

for (const change of [{ stale: true }, { cacheOnly: true }, { mock: true }, { seeded: true }, { connected: false }]) {
  test(`prediction pre-run research readiness rejects ${Object.keys(change)[0]}`, async () => {
    const { service } = setup({ record: null, saved: conversation({ kind: 'prediction-markets-review' }), readiness: sourceReadiness(change) });
    const result = await service.getReviewSources('conversation-1');
    assert.equal(result.items.find(item => item.id === 'risk-ranges').status, 'unavailable');
  });
}

test('an unavailable saved run is not replaced with fresh research readiness', async () => {
  const paths = [];
  const service = createReviewSources({
    call: async operation => {
      assert.equal(operation, 'source-binding');
      return { conversation: conversation(), runId: 'old-run' };
    },
    request: async path => { paths.push(path); throw new Error('Run unavailable'); },
  });
  await assert.rejects(service.getReviewSources('conversation-1'), /Run unavailable/);
  assert.deepEqual(paths, ['/internal/reviews/old-run/sources']);
});

test('concurrent Sources requests share one metadata read and captured acquisition without caching later checks', async () => {
  let release;
  let acquisitions = 0;
  let bindings = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const service = createReviewSources({
    call: async (operation, body) => {
      assert.equal(operation, 'source-binding');
      assert.deepEqual(body, { conversationId: 'conversation-1' });
      bindings++;
      return { conversation: { id: 'conversation-1', kind: 'portfolio-review' }, runId: 'captured-run' };
    },
    request: async path => {
      assert.equal(path, '/internal/reviews/captured-run/sources');
      acquisitions++;
      await pending;
      return { conversationId: 'conversation-1', reviewKind: 'portfolio-review', runId: 'captured-run', checkedAt: at, items: [] };
    },
  });
  const first = service.getReviewSources('conversation-1');
  const second = service.getReviewSources('conversation-1');
  assert.equal(first, second);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(bindings, 1);
  assert.equal(acquisitions, 1);
  release();
  await Promise.all([first, second]);
  await service.getReviewSources('conversation-1');
  assert.equal(bindings, 2);
  assert.equal(acquisitions, 2);
});

test('a failed shared Sources read is released for retry and never substitutes current readiness', async () => {
  let attempts = 0;
  const service = createReviewSources({
    call: async () => ({ conversation: { id: 'conversation-1', kind: 'portfolio-review' }, runId: 'saved-run' }),
    request: async path => {
      assert.equal(path, '/internal/reviews/saved-run/sources');
      attempts++;
      if (attempts === 1) throw new Error('Temporary source failure');
      return { conversationId: 'conversation-1', reviewKind: 'portfolio-review', runId: 'saved-run', items: [] };
    },
  });
  await assert.rejects(service.getReviewSources('conversation-1'), /Temporary source failure/);
  assert.equal((await service.getReviewSources('conversation-1')).runId, 'saved-run');
  assert.equal(attempts, 2);
});

for (const binding of [
  { conversation: { id: 'other-chat', kind: 'portfolio-review' }, runId: 'run-1' },
  { conversation: { id: 'conversation-1', kind: 'portfolio-review' }, runId: 42 },
]) test('invalid compact source binding is rejected before acquiring source evidence', async () => {
  const service = createReviewSources({ call: async () => binding,
    request: async () => { assert.fail('An invalid binding must not acquire evidence'); } });
  await assert.rejects(service.getReviewSources('conversation-1'), error => [404, 409].includes(error.statusCode));
});

for (const kind of ['portfolio-review', 'prediction-markets-review', 'balance-review']) {
  test(`${kind} queued Sources stay checking before worker creation without provider or readiness reads`, async () => {
    const service = createReviewSources({
      call: async () => ({ conversation: { id: 'conversation-1', kind,
        activeTurn: { id: 'queued-turn' }, reviewStartPending: true }, runId: 'queued-run' }),
      request: async () => assert.fail('Queued Sources must not wait for acquisition'),
    });
    const result = await service.getReviewSources('conversation-1');
    assert.equal(result.runId, 'queued-run');
    assert.equal(result.state, 'queued');
    assert.equal(result.checkedAt, null);
    assert.ok(result.items.length > 0);
    assert.ok(result.items.every(item => item.status === 'checking' && item.observedAt === null));
  });
}

// Contract change: a run that was never created checked nothing, so its rows
// settle as missing/SOURCE_NOT_ATTEMPTED ("Not checked") instead of Unavailable,
// and the derived IB Gateway row can no longer imply a failed connection check.
test('a review stopped before worker creation retains its exact run binding with unchecked Sources', async () => {
  const paths = [];
  const service = createReviewSources({
    call: async () => ({ conversation: { id: 'conversation-1', kind: 'balance-review' }, runId: 'queued-run' }),
    request: async path => { paths.push(path); throw Object.assign(new Error('Run not created'), { statusCode: 404 }); },
  });
  const result = await service.getReviewSources('conversation-1');
  assert.equal(result.runId, 'queued-run');
  assert.equal(result.basis, 'review');
  assert.equal(result.state, 'failed');
  assert.equal(result.checkedAt, null);
  assert.ok(result.items.every(item => item.status === 'missing' && item.observedAt === null
    && item.diagnostic.code === 'SOURCE_NOT_ATTEMPTED' && /not checked/.test(item.diagnostic.reason)));
  assert.equal(result.items.find(item => item.id === 'portfolio').requiresIbGateway, true);
  const [gateway] = reviewSourceDisplayItems(result.items);
  assert.equal(gateway.id, 'ibGateway');
  assert.equal(gateway.status, 'missing');
  assert.equal(gateway.diagnostic.code, 'SOURCE_NOT_ATTEMPTED');
  assert.deepEqual(paths, ['/internal/reviews/queued-run/sources']);
});

for (const kind of ['portfolio-review', 'prediction-markets-review', 'balance-review']) {
  test(`${kind} active owned Sources keep checking across a missing worker record then show captured progress`, async () => {
    const binding = { conversation: { id: 'conversation-1', kind,
      activeTurn: { id: 'accepted-turn', state: 'accepted' }, reviewStartPending: false }, runId: 'accepted-run' };
    let reads = 0;
    const calls = [];
    const service = createReviewSources({
      call: async (operation, body) => { calls.push({ operation, body }); return binding; },
      request: async path => {
        assert.equal(path, '/internal/reviews/accepted-run/sources');
        if (++reads === 1) throw Object.assign(new Error('Worker record not visible yet'), { statusCode: 404 });
        return { runId: binding.runId, conversationId: 'conversation-1', reviewKind: kind, state: 'running',
          checkedAt: at, items: [{ id: 'ibGateway', label: 'IB Gateway', status: 'ready', observedAt: at }] };
      },
    });
    const queued = await service.getReviewSources('conversation-1');
    assert.equal(queued.state, 'queued');
    assert.equal(queued.runId, 'accepted-run');
    assert.ok(queued.items.every(row => row.status === 'checking' && row.observedAt === null));
    assert.equal(calls.length, 2, 'missing metadata rechecks the exact durable owner');
    const progress = await service.getReviewSources('conversation-1');
    assert.equal(progress.state, 'running');
    assert.equal(progress.items[0].status, 'ready');
    assert.equal(reads, 2, 'a transient 404 cannot stop subsequent Sources acquisition');
  });
}

// Contract change: unchecked (missing/SOURCE_NOT_ATTEMPTED) instead of Unavailable.
// 'deleted' is the sidecar's typed 410 for a tombstone; 'absent' is a code-less 404.
for (const change of ['stopped', 'deleted', 'absent', 'replaced']) test(`a missing worker record settles unchecked when its accepted owner was ${change}`, async () => {
  const first = { conversation: { id: 'conversation-1', kind: 'prediction-markets-review',
    activeTurn: { id: 'accepted-turn', state: 'accepted' } }, runId: 'accepted-run' };
  let ownerReads = 0;
  const service = createReviewSources({
    call: async () => {
      if (++ownerReads === 1) return first;
      if (change === 'deleted') throw Object.assign(new Error('Conversation was deleted'), { statusCode: 410, code: 'ANALYST_CONVERSATION_DELETED' });
      if (change === 'absent') throw Object.assign(new Error('Conversation not found'), { statusCode: 404 });
      return { ...first, ...(change === 'replaced' ? { runId: 'replacement-run' } : {}),
        conversation: { ...first.conversation, activeTurn: change === 'stopped' ? null : { id: 'replacement-turn', state: 'running' } } };
    },
    request: async () => { throw Object.assign(new Error('Run not created'), { statusCode: 404 }); },
  });
  const result = await service.getReviewSources('conversation-1');
  assert.equal(result.runId, 'accepted-run');
  assert.equal(result.state, 'failed');
  assert.ok(result.items.every(row => row.status === 'missing' && row.diagnostic.code === 'SOURCE_NOT_ATTEMPTED'));
});

test('an authoritative failed coordinator settles Sources even while its workspace turn awaits publication', async () => {
  const { service, calls } = setup({ saved: conversation({ activeTurn: { id: 'pending-publication', state: 'accepted' } }), result: {
    runId: 'run-1', conversationId: 'conversation-1', reviewKind: 'portfolio-review', state: 'failed', checkedAt: at,
    items: [{ id: 'ibGateway', label: 'IB Gateway', status: 'unavailable', diagnostic: { code: 'GATEWAY_UNAVAILABLE' } }],
  } });
  const result = await service.getReviewSources('conversation-1');
  assert.equal(result.state, 'failed');
  assert.equal(result.items[0].status, 'unavailable');
  assert.equal(calls.length, 1, 'verified terminal state needs no retry or readiness acquisition');
});

test('paused, optional and timed source metadata pass through only in their allowed forms', async () => {
  const { service } = setup({ result: {
    runId: 'run-1', conversationId: 'conversation-1', reviewKind: 'portfolio-review', state: 'succeeded', capturedAt: at, checkedAt: at,
    startedAt: at,
    items: [
      { id: 'portfolioPca', label: 'PCA model', status: 'pending', elapsedMs: 10, diagnostic: { code: 'SOURCE_PAUSED' } },
      { id: 'risk-ranges', label: 'Risk Ranges', status: 'ready', observedAt: '2026-09-18', elapsedMs: 1400, optional: true },
      { id: 'early-look', label: 'Early Look', status: 'missing', elapsedMs: 600_000, optional: 'true', diagnostic: { code: 'RESEARCH_NOT_DUE' } },
      { id: 'the-call', label: 'The Call', status: 'checking', elapsedMs: 50 },
      { id: 'signal-strength', label: 'Signal Strength', status: 'unavailable', elapsedMs: 600_001 },
      { id: 'market-structure', label: 'Market Situation Report', status: 'ready', observedAt: at, elapsedMs: -1 },
      { id: 'the-macro-show', label: 'Macro Show', status: 'missing', elapsedMs: 1.5 },
    ],
  } });
  const result = await service.getReviewSources('conversation-1');
  assert.equal(result.startedAt, undefined);
  const byId = Object.fromEntries(result.items.map(item => [item.id, item]));
  assert.equal(byId.portfolioPca.status, 'pending');
  assert.equal(byId.portfolioPca.elapsedMs, undefined);
  assert.equal(byId.portfolioPca.diagnostic.code, 'SOURCE_PAUSED');
  assert.equal(byId.portfolioPca.detail, 'Paused for now. This source returns when it is re-enabled.');
  assert.equal(byId['risk-ranges'].optional, true);
  assert.equal(byId['risk-ranges'].elapsedMs, 1400);
  assert.equal(byId['early-look'].optional, undefined);
  assert.equal(byId['early-look'].elapsedMs, 600_000);
  assert.match(byId['early-look'].diagnostic.reason, /No new publication was due/);
  for (const id of ['the-call', 'signal-strength', 'market-structure', 'the-macro-show']) assert.equal(byId[id].elapsedMs, undefined, id);
});

test('a paused alpha-code scan keeps its Predictive place as one Pending row', async () => {
  const { pendingReviewSourceItems } = require('./analystReviewSourceCatalog.cjs');
  // The setup board review has no alpha-code scan; only a saved capture that recorded the pause lists it.
  for (const kind of ['prediction-markets-review', 'portfolio-review', 'balance-review']) {
    assert.ok(!pendingReviewSourceItems(kind).some(item => item.id === 'alphaCodes'), kind);
  }
  const { service } = setup({ saved: conversation({ kind: 'prediction-markets-review' }), result: {
    runId: 'run-1', conversationId: 'conversation-1', reviewKind: 'prediction-markets-review', state: 'succeeded', checkedAt: at,
    items: [{ id: 'alphaCodes', label: 'Alpha codes', status: 'pending', observedAt: null,
      diagnostic: { code: 'SOURCE_PAUSED', reason: 'Paused for now. This source returns when it is re-enabled.' } }],
  } });
  const [row] = (await service.getReviewSources('conversation-1')).items;
  assert.equal(row.status, 'pending');
  assert.equal(row.diagnostic.code, 'SOURCE_PAUSED');
  assert.equal(row.diagnostic.remedy, 'No action is needed while this source is paused.');
});

test('rosters built without a capture leave out the PCA model and never list an unpaused alpha scan', async () => {
  const notCreated = () => { throw Object.assign(new Error('Run not created'), { statusCode: 404 }); };
  const rows = async (kind, binding) => {
    const service = createReviewSources({ call: async () => ({ conversation: { id: 'conversation-1', kind }, ...binding }),
      request: async path => path === '/internal/workspace/readiness' ? sourceReadiness() : notCreated() });
    return Object.fromEntries((await service.getReviewSources('conversation-1')).items.map(item => [item.id, item]));
  };
  const paused = { pausedSources: ['portfolioPca', 'alphaCodes', 'portfolio'] };
  for (const runId of ['never-created', null]) {
    // A review stopped before its worker existed, and one with no run yet.
    const portfolio = await rows('portfolio-review', { runId, ...paused });
    assert.equal(portfolio.portfolioPca, undefined);
    assert.equal(portfolio.portfolio.status, 'missing', 'only pausable sources can be paused');
    assert.equal((await rows('prediction-markets-review', { runId, ...paused })).alphaCodes, undefined);
    // Without the sidecar's pause flags, PCA and the alpha-code row stay absent.
    assert.equal((await rows('portfolio-review', { runId })).portfolioPca, undefined);
    assert.equal((await rows('prediction-markets-review', { runId, pausedSources: [] })).alphaCodes, undefined);
  }
  const queued = await rows('portfolio-review', { runId: 'queued-run', ...paused,
    conversation: { id: 'conversation-1', kind: 'portfolio-review', reviewStartPending: true, activeTurn: { id: 'turn', state: 'accepted' } } });
  assert.equal(queued.portfolioPca, undefined);
  assert.equal(queued.portfolio.status, 'checking');
});

test('every new capture failure code explains itself without implying a disconnect', async () => {
  const unverified = ['IBKR_GATEWAY_RECONNECTING', 'IBKR_GATEWAY_API_UNRESPONSIVE', 'IBKR_CLIENT_ID_IN_USE',
    'IBKR_CONNECTION_UNVERIFIED_NOT_ATTEMPTED', 'IBKR_HOLDINGS_SERVICE_UNAVAILABLE',
    'IBKR_HOLDINGS_REQUEST_FAILED', 'IBKR_HOLDINGS_UNVERIFIED', 'IBKR_BALANCE_UNVERIFIED'];
  const settled = ['SOURCE_PAUSED', 'SOURCE_NOT_ATTEMPTED', 'SOURCE_CHECK_INCOMPLETE', 'RESEARCH_PUBLICATION_LATE',
    'RESEARCH_PUBLICATION_MISSING', 'RESEARCH_NOT_DUE'];
  const { service } = setup({ result: {
    runId: 'run-1', conversationId: 'conversation-1', reviewKind: 'portfolio-review', state: 'failed',
    items: [...unverified, ...settled].map((code, index) => ({ id: `source-${index}`, label: 'Captured source',
      status: unverified.includes(code) ? 'unavailable' : code === 'SOURCE_PAUSED' ? 'pending' : 'missing', diagnostic: { code } })),
  } });
  const result = await service.getReviewSources('conversation-1');
  for (const item of result.items) {
    assert.ok(item.diagnostic.reason && item.diagnostic.remedy, item.diagnostic.code);
    assert.doesNotMatch(item.diagnostic.reason.replace('does not establish that IB Gateway was disconnected', ''), /disconnect/i, item.diagnostic.code);
  }
  for (const item of result.items.slice(0, unverified.length)) {
    assert.match(item.diagnostic.reason, /does not establish that IB Gateway was disconnected/, item.diagnostic.code);
  }
});

test('a failed readiness read keeps an active pre-run acquisition checking', async () => {
  const service = createReviewSources({
    call: async () => ({ conversation: { id: 'conversation-1', kind: 'portfolio-review', activeTurn: { id: 'turn', state: 'accepted' } }, runId: null }),
    request: async () => { throw new Error('Readiness timed out'); },
    now: () => new Date(at),
  });
  const result = await service.getReviewSources('conversation-1');
  assert.equal(result.basis, 'readiness');
  assert.ok(result.items.every(item => item.status === 'checking'));
  const idle = createReviewSources({
    call: async () => ({ conversation: { id: 'conversation-1', kind: 'portfolio-review' }, runId: null }),
    request: async () => { throw new Error('Readiness timed out'); },
    now: () => new Date(at),
  });
  assert.equal((await idle.getReviewSources('conversation-1')).items.find(item => item.id === 'risk-ranges').status, 'unavailable');
});
