const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const test = require('node:test');
const express = require('express');

const {
  PDF_MAX_BYTES,
  FEED_TABLES,
  FEED_LOOKBACK_DAYS,
  FEED_SCAN_PAGE_LIMIT,
  buildPdfUploadPostParams,
  collectAnalystResearchPipelineCoverage,
  createAnalystRoutes,
  decodeCursor,
  encodeCursor,
  feedScanParams,
  normalizeFeedItem,
  normalizeText,
  resolveManualPublicationDate,
  validatePdfUploadRequest,
  verifyStagedPdfDigest,
} = require('./analyst.cjs');

const REVIEWS_FIXTURE = [
  {
    conversationId: '11111111-1111-4111-8111-111111111111',
    reviewKind: 'portfolio-review',
    title: 'Portfolio Review',
    state: 'succeeded',
  },
];

test('portfolio refresh research authenticates and validates before its read-only full archive scan', async t => {
  const previousToken = process.env.ANALYST_SERVICE_TOKEN;
  process.env.ANALYST_SERVICE_TOKEN = 'portfolio-refresh-test-token';
  let scans = 0;
  let sidecarCalls = 0;
  const { internalRouter } = createAnalystRoutes({
    s3: {},
    dynamodb: { scan: params => {
      scans += 1;
      assert.equal(params.TableName, 'HedgeyeDailySnapshot');
      assert.equal(params.FilterExpression, undefined);
      return { promise: async () => ({ Items: [{ snapshotType: 'etf-pro', date: '2026-06-02',
        article: { feedUrl: 'https://app.hedgeye.com/feed_items/123' },
        data: { changes: [{ ticker: 'TLT', action: 'REMOVE', side: 'Long' }] } }] }) };
    } },
    httpClient: async () => { sidecarCalls += 1; throw new Error('The read-only source route must not call the model or sidecar.'); },
  });
  const app = express();
  app.use(express.json());
  app.use('/internal/analyst', internalRouter);
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    if (previousToken === undefined) delete process.env.ANALYST_SERVICE_TOKEN;
    else process.env.ANALYST_SERVICE_TOKEN = previousToken;
    server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
  });
  const url = `http://127.0.0.1:${server.address().port}/internal/analyst/portfolio-refresh-research`;
  const request = { symbols: ['TLT'], marketDate: '2026-09-30', asOf: '2026-09-30T21:00:00Z' };
  const denied = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
  assert.equal(denied.status, 401);
  const invalid = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer portfolio-refresh-test-token' },
    body: JSON.stringify({ ...request, symbols: undefined }) });
  assert.equal(invalid.status, 400);
  assert.equal(scans, 0);
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer portfolio-refresh-test-token' },
    body: JSON.stringify(request) });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.scanComplete, true);
  assert.equal(result.manifest.earliestDate, '2026-06-02');
  assert.equal(result.bySymbol.TLT.references[0].value.action, 'REMOVE');
  assert.equal(scans, 1);
  assert.equal(sidecarCalls, 0);
});

test('portfolio refresh research returns partial evidence successfully when an archive page fails', async t => {
  const previousToken = process.env.ANALYST_SERVICE_TOKEN;
  process.env.ANALYST_SERVICE_TOKEN = 'portfolio-refresh-partial-token';
  let scans = 0;
  const { internalRouter } = createAnalystRoutes({ s3: {}, httpClient: async () => { throw new Error('Unexpected sidecar call'); },
    dynamodb: { scan: () => ({ promise: async () => {
      scans += 1;
      if (scans === 2) throw new Error('Provider offline');
      return { Items: [], LastEvaluatedKey: { date: '2026-06-02', snapshotType: 'etf-pro' } };
    } }) },
  });
  const app = express();
  app.use(express.json());
  app.use('/internal/analyst', internalRouter);
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    if (previousToken === undefined) delete process.env.ANALYST_SERVICE_TOKEN;
    else process.env.ANALYST_SERVICE_TOKEN = previousToken;
    server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
  });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/internal/analyst/portfolio-refresh-research`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer portfolio-refresh-partial-token' },
    body: JSON.stringify({ symbols: [], marketDate: '2026-09-30', asOf: '2026-09-30T21:00:00Z' }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.scanComplete, false);
  assert.deepEqual(result.coverage.reasons, ['archive-page-unavailable']);
});

test('sidecar requests use fresh connections and never replay an ambiguous review write', async t => {
  const axios = require('axios');
  const sockets = new Set();
  let writes = 0;
  const server = http.createServer((req, res) => {
    sockets.add(req.socket);
    req.resume();
    req.on('end', () => {
      if (req.url === '/internal/workspace/accept') {
        writes += 1;
        req.socket.destroy(); // The write committed but its response was lost.
        return;
      }
      assert.equal(req.headers.connection, 'close');
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ deletedConversationIds: [] }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const previousUrl = process.env.ANALYST_SIDECAR_URL;
  process.env.ANALYST_SIDECAR_URL = `http://127.0.0.1:${server.address().port}`;
  t.after(() => {
    if (previousUrl === undefined) delete process.env.ANALYST_SIDECAR_URL;
    else process.env.ANALYST_SIDECAR_URL = previousUrl;
    server.closeAllConnections();
    server.close();
  });
  const { workspace } = createAnalystRoutes({ s3: {}, dynamodb: {}, httpClient: axios });
  await workspace.call('deleted', { conversationIds: [] });
  await workspace.call('deleted', { conversationIds: [] });
  assert.equal(sockets.size, 2);
  await assert.rejects(workspace.call('accept', { requestId: 'stable-review-request' }), error => error.code === 'ECONNRESET');
  assert.equal(writes, 1);
  assert.equal(sockets.size, 3);
});

test('workspace transport forwards scalar Python timing headers without changing the captured response', async () => {
  const captured = { conversation: { id: 'exact-capture' } };
  const timing = 'workspace;dur=1, projection;dur=2, encode;dur=3';
  let observed;
  const { workspace } = createAnalystRoutes({ s3: {}, dynamodb: {},
    httpClient: async () => ({ status: 200, data: captured, headers: { 'server-timing': timing } }),
  });
  const result = await workspace.call('get', { conversationId: 'exact-capture' }, {
    onResponse: metadata => { observed = metadata; },
  });
  assert.equal(result, captured);
  assert.deepEqual(observed, { serverTiming: timing });
});

async function readStatusWithHealth(t, sidecarHealth) {
  const previousContract = process.env.ANALYST_CONTRACT_VERIFIED;
  const previousGm = process.env.ANALYST_GM_ENABLED;
  process.env.ANALYST_CONTRACT_VERIFIED = 'true';
  process.env.ANALYST_GM_ENABLED = 'false';
  const httpClient = async ({ url }) => {
    if (url.endsWith('/healthz')) return { status: 200, data: sidecarHealth };
    if (url.endsWith('/api/status')) return { status: 200, data: { ok: true } };
    throw new Error(`Unexpected URL: ${url}`);
  };
  const app = express();
  const { router } = createAnalystRoutes({
    getContractStatus: () => ({ verified: true }),
    s3: {},
    dynamodb: {},
    httpClient,
    gatewayStatus: () => ({ connectedUpstreams: 1 }),
  });
  app.use('/api/analyst', router);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    if (previousContract === undefined) delete process.env.ANALYST_CONTRACT_VERIFIED;
    else process.env.ANALYST_CONTRACT_VERIFIED = previousContract;
    if (previousGm === undefined) delete process.env.ANALYST_GM_ENABLED;
    else process.env.ANALYST_GM_ENABLED = previousGm;
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/analyst/status`);
  return response.json();
}

function emptyResearchPipelineClient() {
  return {
    query: () => ({ promise: async () => ({ Items: [] }) }),
  };
}

test('incremental research feed indexes source artifacts, not the massive derived entity table', () => {
  assert.deepEqual(FEED_TABLES, [
    { id: 'ledger', table: 'HermesEmailIngestLedger' },
    { id: 'snapshots', table: 'HedgeyeDailySnapshot' },
  ]);
  assert.equal(decodeCursor(encodeCursor({ phase: 2, lastKey: null })).phase, 2);
});

test('reports the two live ReviewRunV2 kinds independently from Hermes session transport; Balance Review is retired', async (t) => {
  const status = await readStatusWithHealth(t, {
    ok: true,
    status: 'ready',
    reviewCoordinator: { ready: true, state: 'ready' },
    reviews: {
      'portfolio-review': { ready: true, enabled: true },
      'prediction-markets-review': { ready: true, enabled: true },
      'balance-review': { ready: false, enabled: false, reason: 'Review is disabled by its feature flag.' },
    },
  });

  assert.equal(status.status, 'available');
  assert.equal(status.features.gm, false);
  assert.deepEqual(status.readiness.sessionTransport, { ready: true, reason: null });
  assert.deepEqual(status.readiness.reviewCoordinator, { ready: true, reason: null });
  assert.deepEqual(status.readiness.portfolioReview, { ready: true, reason: null });
  assert.deepEqual(status.readiness.predictionMarketsReview, { ready: true, reason: null });
  assert.equal(status.readiness.balanceReview, undefined);
  assert.deepEqual(status.features.reviews, {
    portfolioReview: true,
    predictionMarketsReview: true,
  });
});

test('holds one transient health-probe failure before pausing reviews', async (t) => {
  const previousContract = process.env.ANALYST_CONTRACT_VERIFIED;
  process.env.ANALYST_CONTRACT_VERIFIED = 'true';
  let sidecarCalls = 0;
  const sidecarHealth = {
    ok: true,
    reviewCoordinator: { ready: true },
    reviews: Object.fromEntries(REVIEWS_FIXTURE.map(({ reviewKind }) => [reviewKind, { ready: true }])),
  };
  const app = express();
  const { router } = createAnalystRoutes({
    getContractStatus: () => ({ verified: true }),
    s3: {},
    dynamodb: {},
    gatewayStatus: () => ({ connectedUpstreams: 1 }),
    httpClient: async ({ url }) => {
      if (url.endsWith('/api/status')) return { status: 200, data: { ok: true } };
      if (!url.endsWith('/healthz')) throw new Error(`Unexpected URL: ${url}`);
      sidecarCalls += 1;
      if (sidecarCalls > 1) throw new Error('transient sidecar probe failure');
      return { status: 200, data: sidecarHealth };
    },
  });
  app.use('/api/analyst', router);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    if (previousContract === undefined) delete process.env.ANALYST_CONTRACT_VERIFIED;
    else process.env.ANALYST_CONTRACT_VERIFIED = previousContract;
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  });
  const url = `http://127.0.0.1:${server.address().port}/api/analyst/status`;
  const first = await fetch(url).then((response) => response.json());
  const transient = await fetch(url).then((response) => response.json());
  const confirmed = await fetch(url).then((response) => response.json());

  assert.equal(first.readiness.reviewCoordinator.ready, true);
  assert.equal(transient.readiness.reviewCoordinator.ready, true);
  assert.equal(transient.healthObservations.sidecar.transient, true);
  assert.equal(transient.healthObservations.sidecar.consecutiveFailures, 1);
  assert.equal(confirmed.readiness.reviewCoordinator.ready, false);
  assert.equal(confirmed.healthObservations.sidecar.transient, false);
  assert.equal(confirmed.healthObservations.sidecar.consecutiveFailures, 2);
});

test('proxies the complete ReviewRunV2 HTTP lifecycle without using Hermes', async (t) => {
  const calls = [];
  const responseFor = ({ method, url, data }) => {
    calls.push({ method, url, data });
    const path = new URL(url).pathname + new URL(url).search;
    if (method === 'POST' && path === '/internal/reviews') {
      return { status: 200, data: { ...data, runId: 'run-1', state: 'queued' } };
    }
    if (method === 'GET' && path === '/internal/reviews/run-1') {
      return { status: 200, data: { runId: 'run-1', sessionId: 'session-1', state: 'succeeded' } };
    }
    if (method === 'GET' && path === '/internal/reviews?sessionId=session-1') {
      return { status: 200, data: { run: { runId: 'run-1', sessionId: 'session-1' } } };
    }
    if (method === 'POST' && path === '/internal/reviews/run-1/retry') {
      return { status: 200, data: { runId: 'run-2', requestId: data.requestId, state: 'queued' } };
    }
    throw new Error(`Unexpected ReviewRunV2 request: ${method} ${path}`);
  };
  const app = express();
  app.use(express.json());
  const { router } = createAnalystRoutes({
    getContractStatus: () => ({ verified: true }),
    s3: {},
    dynamodb: {},
    httpClient: responseFor,
  });
  app.use('/api/analyst', router);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}/api/analyst/reviews`;

  const started = await fetch(base, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      reviewKind: 'portfolio-review',
      sessionId: 'session-1',
      requestId: 'request-1',
    }),
  });
  assert.equal(started.status, 202);
  assert.equal((await started.json()).runId, 'run-1');
  assert.equal((await fetch(`${base}/run-1`).then((response) => response.json())).state, 'succeeded');
  assert.equal(
    (await fetch(`${base}?sessionId=session-1`).then((response) => response.json())).run.runId,
    'run-1',
  );
  const retried = await fetch(`${base}/run-1/retry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId: 'request-2' }),
  });
  assert.equal(retried.status, 202);
  assert.deepEqual(await retried.json(), {
    runId: 'run-2', requestId: 'request-2', state: 'queued',
  });
  assert.deepEqual(
    calls.filter(({ url }) => url.includes('/internal/reviews')).map(({ method, data }) => ({ method, data })),
    [
      { method: 'POST', data: { reviewKind: 'portfolio-review', sessionId: 'session-1', requestId: 'request-1' } },
      { method: 'GET', data: undefined },
      { method: 'GET', data: undefined },
      { method: 'POST', data: { requestId: 'request-2' } },
    ],
  );
});

test('proxies compact dated review conversations and per-launch lifecycle endpoints', async (t) => {
  const calls = [];
  const app = express();
  app.use(express.json());
  const { router } = createAnalystRoutes({
    getContractStatus: () => ({ verified: true }),
    s3: {},
    dynamodb: {},
    httpClient: async ({ method, url, data }) => {
      const pathWithQuery = new URL(url).pathname + new URL(url).search;
      calls.push({ method, pathWithQuery, data });
      if (method === 'GET' && pathWithQuery === '/internal/review-conversations?limit=25&cursor=next-1&q=portfolio') {
        return { status: 200, data: { conversations: REVIEWS_FIXTURE, nextCursor: null } };
      }
      if (method === 'POST' && pathWithQuery === '/internal/review-conversations') {
        return {
          status: 202,
          data: {
            created: true,
            conversation: {
              conversationId: '22222222-2222-4222-8222-222222222222',
              reviewKind: 'balance-review',
            },
            run: { runId: 'balance-run-1', state: 'queued' },
          },
        };
      }
      if (method === 'GET' && pathWithQuery === '/internal/review-conversations/22222222-2222-4222-8222-222222222222') {
        return {
          status: 200,
          data: {
            conversation: {
              conversationId: '22222222-2222-4222-8222-222222222222',
              messages: [{ role: 'assistant', text: '# Immutable report' }],
            },
          },
        };
      }
      if (method === 'GET' && pathWithQuery === '/internal/reviews/balance-run-1/status') {
        return { status: 200, data: { run: { runId: 'balance-run-1', state: 'running', active: true } } };
      }
      if (method === 'POST' && pathWithQuery === '/internal/review-conversations/22222222-2222-4222-8222-222222222222/retries') {
        return { status: 202, data: { conversation: { conversationId: '22222222-2222-4222-8222-222222222222' }, run: { runId: 'balance-run-2' } } };
      }
      throw new Error(`Unexpected review conversation request: ${method} ${pathWithQuery}`);
    },
  });
  app.use('/api/analyst', router);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}/api/analyst`;
  const listed = await fetch(`${base}/review-conversations?limit=25&cursor=next-1&q=portfolio`).then((response) => response.json());
  assert.deepEqual(listed.conversations, REVIEWS_FIXTURE);
  const startedResponse = await fetch(`${base}/review-conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reviewKind: 'balance-review', requestId: 'balance-request' }),
  });
  assert.equal(startedResponse.status, 202);
  const started = await startedResponse.json();
  assert.equal(started.conversation.conversationId, '22222222-2222-4222-8222-222222222222');
  const detail = await fetch(`${base}/review-conversations/22222222-2222-4222-8222-222222222222`).then((response) => response.json());
  assert.equal(detail.conversation.messages[0].text, '# Immutable report');
  const status = await fetch(`${base}/reviews/balance-run-1/status`).then((response) => response.json());
  assert.deepEqual(status.run, { runId: 'balance-run-1', state: 'running', active: true });
  const retryResponse = await fetch(`${base}/review-conversations/22222222-2222-4222-8222-222222222222/retries`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId: 'balance-retry', previousRunId: 'balance-run-1' }),
  });
  assert.equal(retryResponse.status, 202);
  assert.equal((await retryResponse.json()).run.runId, 'balance-run-2');
  // No archive: the retired soft-archive route stays gone. Chats are deleted
  // only through the workspace's permanent DELETE /conversations/:id.
  const refused = await fetch(`${base}/review-conversations/22222222-2222-4222-8222-222222222222`, { method: 'DELETE' });
  assert.equal(refused.status, 404);
  const retired = await fetch(`${base}/review-conversations/balance-review/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId: 'old-request' }),
  });
  assert.equal(retired.status, 410);
  assert.deepEqual(calls, [
    {
      method: 'GET',
      pathWithQuery: '/internal/review-conversations?limit=25&cursor=next-1&q=portfolio',
      data: undefined,
    },
    {
      method: 'POST',
      pathWithQuery: '/internal/review-conversations',
      data: { reviewKind: 'balance-review', requestId: 'balance-request' },
    },
    {
      method: 'GET',
      pathWithQuery: '/internal/review-conversations/22222222-2222-4222-8222-222222222222',
      data: undefined,
    },
    {
      method: 'GET',
      pathWithQuery: '/internal/reviews/balance-run-1/status',
      data: undefined,
    },
    {
      method: 'POST',
      pathWithQuery: '/internal/review-conversations/22222222-2222-4222-8222-222222222222/retries',
      data: { requestId: 'balance-retry', previousRunId: 'balance-run-1' },
    },
  ]);
});

test('source feed scans bounded recent windows in large DynamoDB pages', () => {
  const now = new Date('2026-08-20T14:00:00.000Z');
  assert.equal(FEED_LOOKBACK_DAYS, 21);
  assert.equal(FEED_SCAN_PAGE_LIMIT, 1000);
  assert.deepEqual(
    feedScanParams(FEED_TABLES[0], { lastKey: { messageId: 'cursor' }, now }),
    {
      TableName: 'HermesEmailIngestLedger',
      Limit: 1000,
      ExclusiveStartKey: { messageId: 'cursor' },
      FilterExpression: 'begins_with(#s3Key, :researchPrefix) AND #receivedAt >= :cutoff',
      ExpressionAttributeNames: { '#s3Key': 's3Key', '#receivedAt': 'receivedAt' },
      ExpressionAttributeValues: {
        ':researchPrefix': 'hedgeye-email/',
        ':cutoff': '2026-07-30T14:00:00.000Z',
      },
    },
  );
  assert.deepEqual(
    feedScanParams(FEED_TABLES[1], { now }),
    {
      TableName: 'HedgeyeDailySnapshot',
      Limit: 1000,
      FilterExpression: '#snapshotDate >= :cutoffDate',
      ExpressionAttributeNames: { '#snapshotDate': 'date' },
      ExpressionAttributeValues: { ':cutoffDate': '2026-07-30' },
    },
  );
});

test('passes the verified current Risk Range gate into Analyst feed coverage', async () => {
  const now = new Date('2026-08-24T16:00:00.000Z');
  const coverage = await collectAnalystResearchPipelineCoverage({
    dynamodb: emptyResearchPipelineClient(),
    now,
    getRiskRangeStatus: async ({ now: observedNow }) => {
      assert.equal(observedNow, now);
      return {
        status: 'success',
        available: true,
        lastRun: '2026-08-24',
        scrapedAt: '2026-08-24T12:05:00.000Z',
        diagnostics: { manifestReasons: [] },
      };
    },
  });

  const riskRanges = coverage.products.find((product) => product.id === 'risk-ranges');
  assert.equal(riskRanges.status, 'indexed');
  assert.equal(riskRanges.stages.indexed, true);
});

test('fails Risk Range coverage closed when its publication gate cannot be read', async () => {
  const coverage = await collectAnalystResearchPipelineCoverage({
    dynamodb: emptyResearchPipelineClient(),
    now: new Date('2026-08-24T16:00:00.000Z'),
    getRiskRangeStatus: async () => {
      const error = new Error('manifest read unavailable');
      error.code = 'RISK_RANGE_MANIFEST_ACCESS_DENIED';
      throw error;
    },
  });

  const riskRanges = coverage.products.find((product) => product.id === 'risk-ranges');
  assert.equal(riskRanges.status, 'failed');
  assert.equal(riskRanges.errorCode, 'RISK_RANGE_MANIFEST_ACCESS_DENIED');
  assert.equal(riskRanges.stages.indexed, false);
});

test('normalizes research deterministically and preserves source metadata', async () => {
  assert.equal(normalizeText(' A\tB\r\n\r\n\r\nC\0 '), 'A B\n\nC');
  const document = await normalizeFeedItem(
    {
      snapshotType: 'the-call',
      publicationDate: '2026-08-15',
      title: 'The Call',
      body: 'Research body',
      s3Key: 'research/the-call.json',
      credentials: 'must not be indexed',
    },
    'HedgeyeDailySnapshot',
    {},
  );
  assert.equal(document.product, 'the-call');
  assert.equal(document.publicationDate, '2026-08-15');
  assert.equal(document.sourceUri, 's3://market-dashboard-csv-data/research/the-call.json');
  assert.doesNotMatch(document.text, /must not be indexed/);
  assert.match(document.documentId, /^doc_[a-f0-9]{32}$/);
  assert.equal(document.contentHash.length, 64);
});

test('snapshot and original HTML feed documents explain field-only source defects without altering publication evidence', async () => {
  const quality = { status: 'discrepancy', issues: [{ id: 'original-rut-range', code: 'invalid_bounds', ticker: 'RUT',
    field: 'riskRange', observed: { lrr: 2834, hrr: 2825, trend: 'BULLISH' }, disposition: 'withheld_from_structured_data',
    source: { productId: 'early-look', reportDate: '2026-09-22', url: 'https://app.hedgeye.com/feed_items/187503' } }] };
  const originalArticle = 'Russell 2000 (RUT): lower 2834, upper 2825. SPX: lower 7000, upper 7100. Published thesis remains available.';
  const snapshot = { snapshotType: 'early-look', date: '2026-09-22', sourceQuality: quality,
    article: { bodyText: originalArticle }, data: { SPX: { lrr: 7000, hrr: 7100, trend: 'BULLISH' } } };
  const original = structuredClone(snapshot);
  const ledger = { reportType: 'early-look', receivedAt: '2026-09-22T12:00:00Z',
    s3Key: 'hedgeye-email/original.html', sourceQuality: quality };
  const s3 = { getObject: () => ({ promise: async () => ({ Body: Buffer.from(`<p>${originalArticle}</p>`), ContentType: 'text/html' }) }) };
  for (const [item, table] of [[snapshot, 'HedgeyeDailySnapshot'], [ledger, 'HermesEmailIngestLedger']]) {
    const document = await normalizeFeedItem(item, table, s3);
    assert.match(document.text, /^Source quality annotation \(dashboard validation, not publisher text\):/);
    assert.match(document.text, /published lower 2,834 exceeds upper 2,825/);
    assert.match(document.text, /Only the disputed fields are unavailable for calculations or recommendations; unaffected research remains usable/);
    assert.ok(document.text.includes(originalArticle));
    assert.deepEqual(document.metadata.sourceQuality, quality);
    assert.match(document.metadata.sourceQualityAnnotation, /No corrected values have been established/);
  }
  assert.deepEqual(snapshot, original);
  const pdf = await normalizeFeedItem({ ...ledger, s3Key: 'hedgeye-email/original.pdf', mimeType: 'application/pdf' }, 'HermesEmailIngestLedger', s3);
  assert.deepEqual(pdf.metadata.sourceQuality, quality);
  assert.match(pdf.metadata.sourceQualityAnnotation, /unaffected research remains usable/);
});

test('preserves authoritative source timestamps separately from indexing metadata', async () => {
  const base = { snapshotType: 'the-call', publicationDate: '2026-09-18', title: 'The Call', body: 'Research body' };
  const document = await normalizeFeedItem({
    ...base,
    publishedAt: '2026-09-18T08:05:00-04:00',
    retrievedAt: '2026-09-18T13:00:00Z',
    observedAt: '2026-09-18T12:30:00Z',
    receivedAt: '2026-09-18T12:06:00Z',
    scrapedAt: '2026-09-18T12:45:00Z',
    ingestedAt: '2026-09-18T14:00:00Z',
    updatedAt: '2026-09-18T15:00:00Z',
  }, 'HedgeyeDailySnapshot', {});
  assert.equal(document.metadata.publishedAt, '2026-09-18T08:05:00-04:00');
  assert.equal(document.metadata.observedAt, '2026-09-18T13:00:00Z');
  assert.equal(document.metadata.ingestedAt, '2026-09-18T14:00:00Z');
  const dateOnly = await normalizeFeedItem({
    ...base, publishedAt: '2026-09-18', observedAt: '2026-09-18T10:00:00',
    updatedAt: '2026-09-18T15:00:00Z', indexedAt: '2026-09-18T16:00:00Z', ingestedAt: '2026-09-18T14:00:00Z',
  }, 'HedgeyeDailySnapshot', {});
  assert.equal(dateOnly.metadata.publishedAt, null);
  assert.equal(dateOnly.metadata.observedAt, null);
  assert.equal(dateOnly.publicationDate, '2026-09-18');
  assert.equal(dateOnly.contentHash, crypto.createHash('sha256').update(dateOnly.text).digest('hex'));
  assert.equal(document.contentHash, crypto.createHash('sha256').update(document.text).digest('hex'));
  assert.equal(dateOnly.parserVersion, document.parserVersion);
});

test('uses provider observations without calling receipt, scraping, or indexing a publication', async () => {
  const base = { snapshotType: 'the-call', publicationDate: '2026-09-18', body: 'Research body' };
  for (const field of ['observedAt', 'receivedAt', 'scrapedAt']) {
    const document = await normalizeFeedItem({ ...base, [field]: '2026-09-18T13:00:00Z' }, 'HedgeyeDailySnapshot', {});
    assert.equal(document.metadata.observedAt, '2026-09-18T13:00:00Z');
    assert.equal(document.metadata.publishedAt, null);
    assert.equal(document.metadata.ingestedAt, null);
  }
  const published = await normalizeFeedItem({ ...base, publishedAt: '2026-09-18T13:00:00Z' }, 'HedgeyeDailySnapshot', {});
  assert.equal(published.metadata.observedAt, published.metadata.publishedAt);
});

test('omits synthetic midnight publication clocks while keeping independent source observations', async () => {
  const base = { snapshotType: 'the-call', title: 'The Call', body: 'Research body' };
  for (const dateField of ['publicationDate', 'marketDate', 'snapshotDate', 'date']) {
    const dated = { ...base, [dateField]: '2026-09-18', publishedAt: '2026-09-18T00:00:00+00:00' };
    const missing = await normalizeFeedItem(dated, 'HedgeyeDailySnapshot', {});
    assert.equal(missing.metadata.publishedAt, null);
    assert.equal(missing.metadata.observedAt, null);
    assert.equal(missing.publicationDate, '2026-09-18');
    for (const observationField of ['receivedAt', 'scrapedAt']) {
      const observed = await normalizeFeedItem({ ...dated, [observationField]: '2026-09-18T13:00:00Z' }, 'HedgeyeDailySnapshot', {});
      assert.equal(observed.metadata.publishedAt, null);
      assert.equal(observed.metadata.observedAt, '2026-09-18T13:00:00Z');
    }
    for (const observationField of ['observedAt', 'retrievedAt']) {
      const midnight = await normalizeFeedItem({ ...dated, [observationField]: '2026-09-18T00:00:00Z' }, 'HedgeyeDailySnapshot', {});
      assert.equal(midnight.metadata.publishedAt, null);
      assert.equal(midnight.metadata.observedAt, '2026-09-18T00:00:00Z');
    }
  }
});

test('front-loads verified Market Situation signals and source-dated chart metrics', async () => {
  const document = await normalizeFeedItem(
    {
      snapshotType: 'market-structure',
      schemaVersion: 'market-structure-v4',
      contentComplete: true,
      date: '2026-08-25',
      data: {
        charts: [{ id: 'a'.repeat(64), sha256: 'a'.repeat(64) }],
        signals: [
          { id: 'spxGammaExposure', label: 'SPX Gamma Exposure', value: 'Neutral', tone: 'neutral' },
          { id: 'systematicFlowRisk', label: 'Systematic Flow Risk', value: 'Neutral', tone: 'neutral' },
          { id: 'pvBandRiskReward', label: 'PV Band Risk/Reward', value: 'Neutral', tone: 'neutral' },
          { id: 'strategicAllocation', label: 'Strategic Allocation', value: 'Risk On', tone: 'positive' },
        ],
        chartMetrics: {
          spxGammaVolatilityThrottle: {
            chartId: 'a'.repeat(64), extractionBasis: 'labeled-chart-ocr',
            parserVersion: 'market-structure-chart-metrics-v3',
            gammaThrottle: 0.56,
            tenDayRealizedVolatility: 9.37,
            chartDate: '2026-08-24',
            source: 'Tier1Alpha.com',
          },
          spxProbableVolatilityGamma: {
            chartId: 'a'.repeat(64), extractionBasis: 'labeled-chart-ocr',
            parserVersion: 'market-structure-chart-metrics-v3',
            zeroGamma: 7646,
            upperPvBand: 7798,
            lowerPvBand: 7573,
            strikesInPlay: [7600, 7650, 7675, 7700, 7750],
            chartDate: '2026-08-24',
            source: 'Tier1Alpha.com',
          },
        },
        blocks: [{ type: 'paragraph', text: 'x'.repeat(4_000) }],
      },
    },
    'HedgeyeDailySnapshot',
    {},
  );

  assert.match(document.text, /^Verified Market Situation structured data:/);
  assert.match(document.text, /Publication date: 2026-08-25/);
  assert.match(document.text, /PV Band Risk\/Reward: Neutral/);
  assert.match(document.text, /Strategic Allocation: Risk On/);
  assert.match(document.text, /Gamma Throttle: 0\.56/);
  assert.match(document.text, /10-Day Realized Volatility: 9\.37/);
  assert.match(document.text, /Zero Gamma: 7646/);
  assert.match(document.text, /Upper PV Band: 7798/);
  assert.match(document.text, /Lower PV Band: 7573/);
  assert.match(document.text, /Strikes In Play: 7600, 7650, 7675, 7700, 7750/);
  assert.match(document.text, /Chart date: 2026-08-24/);
  assert.match(document.text, /not a live or executable quote/);
  assert.ok(document.text.indexOf('Strategic Allocation: Risk On') < 1_500);
  assert.ok(document.text.indexOf('Gamma Throttle: 0.56') < 1_500);
});

test('does not promote missing Market Situation chart values into numeric metrics', async () => {
  const document = await normalizeFeedItem(
    {
      snapshotType: 'market-structure',
      date: '2026-08-25',
      data: {
        signals: [
          { id: 'strategicAllocation', value: 'Risk On' },
        ],
        chartMetrics: {
          spxGammaVolatilityThrottle: {
            gammaThrottle: null,
            tenDayRealizedVolatility: null,
            chartDate: '2026-08-24',
          },
        },
      },
    },
    'HedgeyeDailySnapshot',
    {},
  );

  assert.match(document.text, /Strategic Allocation: Risk On/);
  assert.doesNotMatch(document.text, /Gamma Throttle:/);
  assert.doesNotMatch(document.text, /10-Day Realized Volatility:/);
});

test('includes independently verified partial chart metrics in Analyst research', async () => {
  const item = {
    snapshotType: 'market-structure', schemaVersion: 'market-structure-v4', contentComplete: true,
    date: '2026-09-16',
    data: {
      charts: [{ id: 'a'.repeat(64), sha256: 'a'.repeat(64) }],
      chartMetrics: {
        spxGammaVolatilityThrottle: {
          chartId: 'a'.repeat(64), chartDate: '2026-09-15',
          extractionBasis: 'labeled-chart-ocr', parserVersion: 'market-structure-chart-metrics-v3',
          gammaThrottle: -4.72, source: 'Tier1Alpha.com',
        },
      },
    },
  };
  const document = await normalizeFeedItem(item, 'HedgeyeDailySnapshot', {});
  assert.match(document.text, /Gamma Throttle: -4\.72/);
  assert.match(document.text, /Chart date: 2026-09-15/);
  assert.doesNotMatch(document.text, /10-Day Realized Volatility:/);
  for (const flags of [{ stale: true }, { cacheOnly: true }, { mock: true }, { seeded: true }, { connected: false }]) {
    const unsafe = await normalizeFeedItem({ ...item, ...flags }, 'HedgeyeDailySnapshot', {});
    assert.doesNotMatch(unsafe.text, /Gamma Throttle:/);
  }
});

test('does not expose non-research rows from the Gmail runtime ledger', async () => {
  const document = await normalizeFeedItem(
    { product: 'the-call', s3Key: 'runtime/snapshot.json', subject: 'not research' },
    'HermesEmailIngestLedger',
    {},
  );
  assert.equal(document, null);
});

test('routes archived Gmail PDFs into page-aware local extraction', async () => {
  const document = await normalizeFeedItem(
    {
      reportType: 'risk-ranges',
      s3Bucket: 'market-dashboard-csv-data',
      s3Key: 'hedgeye-email/risk-ranges/2026/08/15/deck.pdf',
      mimeType: 'application/pdf',
      filename: 'risk-ranges.pdf',
      contentSha256: 'a'.repeat(64),
      receivedAt: '2026-08-15T12:00:00Z',
      messageId: 'gmail-1',
      attachmentId: 'attachment-1',
    },
    'HermesEmailIngestLedger',
    {},
  );
  assert.equal(document.ingestMode, 'pdf');
  assert.equal(document.mediaType, 'application/pdf');
  assert.equal(document.product, 'risk-ranges');
  assert.equal(document.publicationDate, '2026-08-15');
  assert.equal(document.expectedSha256, 'a'.repeat(64));
  assert.equal(document.text, undefined);
  assert.equal(document.metadata.observedAt, '2026-08-15T12:00:00Z');
  assert.equal(document.metadata.publishedAt, null);
  assert.equal(document.metadata.ingestedAt, null);
});

test('round-trips feed cursors and rejects malformed input', () => {
  const cursor = { phase: 2, lastKey: { id: 'abc' } };
  assert.deepEqual(decodeCursor(encodeCursor(cursor)), cursor);
  assert.throws(() => decodeCursor('not-a-cursor'), /Invalid research-feed cursor/);
});

test('validates PDF-only 50 MB upload requests', () => {
  assert.equal(validatePdfUploadRequest({ filename: 'deck.pdf', contentType: 'application/pdf', sizeBytes: 123 }).ok, true);
  assert.equal(validatePdfUploadRequest({ filename: 'deck.txt', contentType: 'application/pdf', sizeBytes: 123 }).statusCode, 400);
  assert.equal(validatePdfUploadRequest({ filename: 'deck.pdf', contentType: 'text/plain', sizeBytes: 123 }).statusCode, 400);
  assert.equal(validatePdfUploadRequest({ filename: 'deck.pdf', contentType: 'application/pdf', sizeBytes: PDF_MAX_BYTES + 1 }).statusCode, 413);
});

test('auto-dates manual imports from the PDF and falls back to upload time', () => {
  assert.deepEqual(
    resolveManualPublicationDate({
      detectedPublicationDate: '2026-08-13',
      uploadedAt: '2026-08-16T20:48:53Z',
    }),
    { publicationDate: '2026-08-13', source: 'pdf' },
  );
  assert.deepEqual(
    resolveManualPublicationDate({
      detectedPublicationDate: 'not-a-date',
      uploadedAt: '2026-08-16T20:48:53Z',
    }),
    { publicationDate: '2026-08-16', source: 'upload' },
  );
  assert.deepEqual(
    resolveManualPublicationDate({
      requestedPublicationDate: '2026-08-14',
      detectedPublicationDate: '2026-08-13',
    }),
    { publicationDate: '2026-08-14', source: 'requested' },
  );
});

test('authorizes every fixed field in the constrained PDF staging POST', () => {
  const params = buildPdfUploadPostParams({
    bucket: 'market-dashboard-csv-data',
    key: 'analyst-staging/upload-id/report.pdf',
    uploadId: 'upload-id',
    cleanFilename: 'report.pdf',
  });
  assert.equal(params.Bucket, 'market-dashboard-csv-data');
  assert.equal(params.Fields['x-amz-meta-original-filename'], 'report.pdf');
  assert.deepEqual(params.Conditions, [
    ['eq', '$key', 'analyst-staging/upload-id/report.pdf'],
    ['eq', '$Content-Type', 'application/pdf'],
    ['content-length-range', 1, PDF_MAX_BYTES],
    ['eq', '$x-amz-meta-upload-id', 'upload-id'],
    ['eq', '$x-amz-meta-original-filename', 'report.pdf'],
  ]);
});

test('verifies signature and SHA-256 before any immutable copy', async () => {
  const body = Buffer.from('%PDF-test-body');
  const s3 = {
    getObject: () => ({ promise: async () => ({ Body: body }) }),
  };
  const digest = crypto.createHash('sha256').update(body).digest('hex');
  assert.equal(
    await verifyStagedPdfDigest(s3, { bucket: 'bucket', key: 'analyst-staging/x.pdf', expectedSha256: digest }),
    digest,
  );
  await assert.rejects(
    verifyStagedPdfDigest(s3, { bucket: 'bucket', key: 'analyst-staging/x.pdf', expectedSha256: '0'.repeat(64) }),
    (error) => error.code === 'digest_mismatch' && error.statusCode === 409,
  );
  const badS3 = { getObject: () => ({ promise: async () => ({ Body: Buffer.from('not-pdf') }) }) };
  await assert.rejects(
    verifyStagedPdfDigest(badS3, { bucket: 'bucket', key: 'analyst-staging/x.pdf', expectedSha256: digest }),
    /signature is not a PDF/,
  );
});

test('conversation reads preserve the sidecar status and typed code for the browser', async t => {
  const app = express();
  const outcomes = {
    deleted: { status: 410, data: { error: 'Conversation deleted', code: 'ANALYST_CONVERSATION_DELETED' } },
    missing: { status: 404, data: { error: 'Conversation not found', code: 'ANALYST_CONVERSATION_NOT_FOUND' } },
    untyped: { status: 404, data: { error: "'Conversation record not found'" } },
  };
  const { router } = createAnalystRoutes({ s3: {}, dynamodb: {},
    httpClient: async ({ url, data }) => {
      if (url.endsWith('/internal/workspace/get')) return { ...outcomes[data.conversationId], headers: {} };
      return { status: 200, data: {}, headers: {} };
    } });
  app.use('/api/analyst', router);
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  for (const [id, outcome] of Object.entries(outcomes)) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/analyst/conversations/${id}?includeBriefs=false`);
    assert.equal(response.status, outcome.status, id);
    assert.deepEqual(await response.json(), outcome.data, id);
  }
});
