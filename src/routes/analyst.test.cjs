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

test('reports three ReviewRunV2 kinds independently from Hermes session transport', async (t) => {
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
  assert.deepEqual(status.readiness.balanceReview, {
    ready: false,
    reason: 'Review is disabled by its feature flag.',
  });
  assert.deepEqual(status.features.reviews, {
    portfolioReview: true,
    predictionMarketsReview: true,
    balanceReview: false,
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
      if (method === 'DELETE' && pathWithQuery === '/internal/review-conversations/22222222-2222-4222-8222-222222222222') {
        return { status: 200, data: { ok: true, conversationId: '22222222-2222-4222-8222-222222222222' } };
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
  const archived = await fetch(`${base}/review-conversations/22222222-2222-4222-8222-222222222222`, {
    method: 'DELETE',
  }).then((response) => response.json());
  assert.equal(archived.ok, true);
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
    {
      method: 'DELETE',
      pathWithQuery: '/internal/review-conversations/22222222-2222-4222-8222-222222222222',
      data: undefined,
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

test('front-loads verified Market Situation signals and source-dated chart metrics', async () => {
  const document = await normalizeFeedItem(
    {
      snapshotType: 'market-structure',
      date: '2026-08-25',
      data: {
        signals: [
          { id: 'spxGammaExposure', label: 'SPX Gamma Exposure', value: 'Neutral', tone: 'neutral' },
          { id: 'systematicFlowRisk', label: 'Systematic Flow Risk', value: 'Neutral', tone: 'neutral' },
          { id: 'pvBandRiskReward', label: 'PV Band Risk/Reward', value: 'Neutral', tone: 'neutral' },
          { id: 'strategicAllocation', label: 'Strategic Allocation', value: 'Risk On', tone: 'positive' },
        ],
        chartMetrics: {
          spxGammaVolatilityThrottle: {
            gammaThrottle: 0.56,
            tenDayRealizedVolatility: 9.37,
            chartDate: '2026-08-24',
            source: 'Tier1Alpha.com',
          },
          spxProbableVolatilityGamma: {
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
