const crypto = require('crypto');
const http = require('node:http');
const https = require('node:https');
const express = require('express');
const registryDocument = require('../../infra/lambdas/gmail_ingestor/research_products.json');
const { collectResearchPipelineCoverage } = require('../utils/researchPipelineCoverage.cjs');
const { verifiedMarketStructureChartMetrics } = require('../utils/marketStructureReport.cjs');
const { publicationIssues, discrepancyText } = require('../utils/researchSourceQuality.cjs');
const { capturePortfolioRefreshResearch } = require('../services/analyst/portfolioRefreshResearch.cjs');

const PDF_MAX_BYTES = 50 * 1024 * 1024;
const PRESIGN_TTL_SECONDS = 10 * 60;
const STAGING_PREFIX = 'analyst-staging/';
const IMMUTABLE_PREFIX = 'hedgeye-uploads/manual/';
const STAGING_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_BUCKET = 'market-dashboard-csv-data';
const MANUAL_IMPORT_PRODUCT = 'generic';
const RESEARCH_ENTITY_EVENTS_TABLE = process.env.RESEARCH_ENTITY_EVENTS_TABLE || 'ResearchEntityEventsV1';
const FEED_TABLES = [
  { id: 'ledger', table: 'HermesEmailIngestLedger' },
  { id: 'snapshots', table: 'HedgeyeDailySnapshot' },
];
const FEED_LOOKBACK_DAYS = 21;
const FEED_SCAN_PAGE_LIMIT = 1_000;
const MAX_DOCUMENT_CHARS = 120_000;
const MARKET_STRUCTURE_SIGNAL_FIELDS = [
  ['spxGammaExposure', 'SPX Gamma Exposure', new Set(['Positive', 'Neutral', 'Negative'])],
  ['systematicFlowRisk', 'Systematic Flow Risk', new Set(['Bullish', 'Neutral', 'Bearish'])],
  ['pvBandRiskReward', 'PV Band Risk/Reward', new Set(['Long', 'Neutral', 'Short'])],
  ['strategicAllocation', 'Strategic Allocation', new Set(['Risk On', 'Neutral', 'Risk Off'])],
];
const ANALYST_HEALTH_PROBE_TIMEOUT_MS = 5_000;
const ANALYST_HEALTH_FAILURE_THRESHOLD = 2;
const ANALYST_HEALTH_GRACE_MS = 30_000;
// Uvicorn closes idle connections after five seconds. A busy API event loop
// can reuse that expired socket before processing its close notification.
// Sidecar calls are local; fresh connections avoid resets without replaying
// requests whose durable writes may already have committed.
const SIDECAR_HTTP_AGENT = new http.Agent({ keepAlive: false });
const SIDECAR_HTTPS_AGENT = new https.Agent({ keepAlive: false });

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

function normalizeText(value) {
  const raw = typeof value === 'string' ? value : JSON.stringify(stableValue(value ?? ''));
  return raw
    .replace(/\0/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/[\t\f\v ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function hashText(value) {
  return crypto.createHash('sha256').update(normalizeText(value), 'utf8').digest('hex');
}

function stableId(prefix, ...values) {
  const digest = crypto.createHash('sha256').update(JSON.stringify(values)).digest('hex').slice(0, 32);
  return `${prefix}_${digest}`;
}

function safeFilename(value) {
  const leaf = String(value || '').split(/[\\/]/).pop() || 'research.pdf';
  const cleaned = leaf.normalize('NFKC').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-');
  return cleaned.slice(0, 140) || 'research.pdf';
}

function validatePdfUploadRequest({ filename, contentType, sizeBytes }) {
  const cleanFilename = safeFilename(filename);
  if (!cleanFilename.toLowerCase().endsWith('.pdf')) {
    return { ok: false, statusCode: 400, error: 'Only PDF files are accepted.' };
  }
  if (String(contentType || '').toLowerCase() !== 'application/pdf') {
    return { ok: false, statusCode: 400, error: 'PDF uploads must use application/pdf.' };
  }
  const size = Number(sizeBytes);
  if (!Number.isInteger(size) || size <= 0) {
    return { ok: false, statusCode: 400, error: 'A positive file size is required.' };
  }
  if (size > PDF_MAX_BYTES) {
    return { ok: false, statusCode: 413, error: 'PDF exceeds the 50 MB maximum.' };
  }
  return { ok: true, cleanFilename, sizeBytes: size };
}

function normalizedIsoDate(value) {
  const candidate = String(value || '').slice(0, 10);
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(candidate)) return null;
  const timestamp = Date.parse(`${candidate}T00:00:00Z`);
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp).toISOString().slice(0, 10) === candidate ? candidate : null;
}

function resolveManualPublicationDate({ detectedPublicationDate, requestedPublicationDate, uploadedAt, now = new Date() } = {}) {
  const requested = normalizedIsoDate(requestedPublicationDate);
  if (requested) return { publicationDate: requested, source: 'requested' };
  const detected = normalizedIsoDate(detectedPublicationDate);
  if (detected) return { publicationDate: detected, source: 'pdf' };
  const uploadedTimestamp = Date.parse(String(uploadedAt || ''));
  if (Number.isFinite(uploadedTimestamp)) {
    return { publicationDate: new Date(uploadedTimestamp).toISOString().slice(0, 10), source: 'upload' };
  }
  return { publicationDate: new Date(now).toISOString().slice(0, 10), source: 'clock' };
}

function requestError(message, statusCode = 400, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (code) error.code = code;
  return error;
}

function buildPdfUploadPostParams({ bucket, key, uploadId, cleanFilename }) {
  return {
    Bucket: bucket,
    Fields: {
      key,
      'Content-Type': 'application/pdf',
      'x-amz-meta-upload-id': uploadId,
      'x-amz-meta-original-filename': cleanFilename,
    },
    Conditions: [
      ['eq', '$key', key],
      ['eq', '$Content-Type', 'application/pdf'],
      ['content-length-range', 1, PDF_MAX_BYTES],
      ['eq', '$x-amz-meta-upload-id', uploadId],
      ['eq', '$x-amz-meta-original-filename', cleanFilename],
    ],
    Expires: PRESIGN_TTL_SECONDS,
  };
}

function encodeCursor(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeCursor(value) {
  if (!value) return { phase: 0, lastKey: null };
  try {
    const parsed = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
    const phase = Number(parsed.phase);
    if (!Number.isInteger(phase) || phase < 0 || phase > FEED_TABLES.length) throw new Error('phase');
    return {
      phase,
      lastKey: parsed.lastKey && typeof parsed.lastKey === 'object' ? parsed.lastKey : null,
    };
  } catch (_error) {
    const error = new Error('Invalid research-feed cursor.');
    error.statusCode = 400;
    throw error;
  }
}

function feedScanParams(table, { lastKey = null, limit = FEED_SCAN_PAGE_LIMIT, now = new Date() } = {}) {
  const cutoff = new Date(now.getTime() - (FEED_LOOKBACK_DAYS * 24 * 60 * 60 * 1000));
  const params = {
    TableName: table.table,
    Limit: Math.max(FEED_SCAN_PAGE_LIMIT, Math.min(5_000, Number(limit) || FEED_SCAN_PAGE_LIMIT)),
    ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
  };
  if (table.id === 'ledger') {
    return {
      ...params,
      FilterExpression: 'begins_with(#s3Key, :researchPrefix) AND #receivedAt >= :cutoff',
      ExpressionAttributeNames: {
        '#s3Key': 's3Key',
        '#receivedAt': 'receivedAt',
      },
      ExpressionAttributeValues: {
        ':researchPrefix': 'hedgeye-email/',
        ':cutoff': cutoff.toISOString(),
      },
    };
  }
  if (table.id === 'snapshots') {
    return {
      ...params,
      FilterExpression: '#snapshotDate >= :cutoffDate',
      ExpressionAttributeNames: { '#snapshotDate': 'date' },
      ExpressionAttributeValues: { ':cutoffDate': cutoff.toISOString().slice(0, 10) },
    };
  }
  return params;
}

function productIdFor(item) {
  const candidate = String(
    item?.product
      || item?.productId
      || item?.snapshotType
      || item?.reportType
      || item?.sourceProduct
      || item?.productKey
      || '',
  ).trim().toLowerCase();
  const known = registryDocument.products.find((product) => (
    product.id === candidate
    || (product.aliases || []).includes(candidate)
    || (product.snapshotTypes || []).includes(candidate)
  ));
  if (known) return known.id;
  if (candidate === 'inflation-nowcast') return candidate;
  return candidate || 'generic';
}

function publicationDateFor(item) {
  const values = [
    item?.publicationDate,
    item?.marketDate,
    item?.snapshotDate,
    item?.date,
    item?.publishedAt,
    item?.receivedAt,
    item?.eventTime,
    item?.createdAt,
  ];
  const match = values.map((value) => String(value || '').slice(0, 10))
    .find((value) => /^20\d{2}-\d{2}-\d{2}$/.test(value));
  return match || null;
}

function sourceTimestamp(value) {
  return typeof value === 'string'
    && /T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)
    && Number.isFinite(Date.parse(value)) ? value : null;
}

function sourceTimeMetadata(item) {
  let publishedAt = sourceTimestamp(item?.publishedAt);
  if (publishedAt) {
    const utcPublication = new Date(publishedAt).toISOString();
    const declaredDates = [item?.publicationDate, item?.marketDate, item?.snapshotDate, item?.date];
    // Legacy parsers expanded publication dates to midnight UTC. That is a
    // date placeholder, not evidence of an exact publication time.
    if (utcPublication.endsWith('T00:00:00.000Z') && declaredDates.includes(utcPublication.slice(0, 10))) publishedAt = null;
  }
  return {
    publishedAt,
    observedAt: [item?.retrievedAt, item?.observedAt, item?.receivedAt, publishedAt, item?.scrapedAt]
      .map(sourceTimestamp).find(Boolean) || null,
    // Indexing and maintenance timestamps are not source publication times.
    ingestedAt: item?.ingestedAt || null,
  };
}

function sourceUriFor(item, tableName) {
  const bucket = item?.s3Bucket || item?.bucket || DEFAULT_BUCKET;
  const key = item?.s3Key || item?.sourceArtifact || item?.htmlSource || item?.pdfSource || item?.pdfS3Key;
  if (key) return `s3://${bucket}/${String(key).replace(/^\/+/, '')}`;
  const messageId = item?.gmailMessageId || item?.sourceMessageId || item?.messageId;
  if (messageId) return `gmail://message/${encodeURIComponent(messageId)}`;
  const identity = item?.eventKey || item?.artifactId || item?.date || hashText(item);
  return `dynamodb://${tableName}/${encodeURIComponent(String(identity))}`;
}

function stripHtml(value) {
  return String(value || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(br|p|div|li|tr|h[1-6])\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

function selectedResearchPayload(item) {
  const ignored = new Set([
    'leaseOwner', 'leaseExpiresAt', 'retryAfter', 'ttl', 'oauthState', 'credentials',
  ]);
  return Object.fromEntries(
    Object.entries(item || {}).filter(([key]) => !ignored.has(key)),
  );
}

function boundedMetricText(value, minimum, maximum) {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  const text = String(value).trim();
  if (!/^[-+]?\d+(?:\.\d+)?$/.test(text)) return null;
  const numeric = Number(text);
  return Number.isFinite(numeric) && numeric >= minimum && numeric <= maximum ? text : null;
}

function marketStructureAnalystSummary(item) {
  if (productIdFor(item) !== 'market-structure') return '';
  const sourceDate = publicationDateFor(item);
  const sourceSignals = Array.isArray(item?.data?.signals) ? item.data.signals : [];
  const signalLines = MARKET_STRUCTURE_SIGNAL_FIELDS.flatMap(([id, label, allowed]) => {
    const signal = sourceSignals.find((candidate) => candidate?.id === id);
    const value = String(signal?.value || '').trim();
    return allowed.has(value) ? [`${label}: ${value}`] : [];
  });

  const chartMetrics = verifiedMarketStructureChartMetrics(item);
  const throttle = chartMetrics.spxGammaVolatilityThrottle;
  const gammaThrottle = boundedMetricText(throttle?.gammaThrottle, -250, 250);
  const tenDayRealizedVolatility = boundedMetricText(
    throttle?.tenDayRealizedVolatility,
    0,
    250,
  );
  const chartDate = normalizedIsoDate(throttle?.chartDate);
  const metricLines = (
    (gammaThrottle !== null || tenDayRealizedVolatility !== null)
    && chartDate
  ) ? [
      'SPX Gamma Volatility Throttle chart (labeled chart OCR):',
      ...(gammaThrottle !== null ? [`Gamma Throttle: ${gammaThrottle}`] : []),
      ...(tenDayRealizedVolatility !== null ? [`10-Day Realized Volatility: ${tenDayRealizedVolatility}`] : []),
      `Chart date: ${chartDate}`,
      ...(String(throttle?.source || '').trim()
        ? [`Chart source label: ${String(throttle.source).trim().slice(0, 120)}`]
        : []),
    ] : [];

  const gammaMap = chartMetrics.spxProbableVolatilityGamma;
  const zeroGamma = boundedMetricText(gammaMap?.zeroGamma, 100, 100000);
  const upperPvBand = boundedMetricText(gammaMap?.upperPvBand, 100, 100000);
  const lowerPvBand = boundedMetricText(gammaMap?.lowerPvBand, 100, 100000);
  const gammaMapDate = normalizedIsoDate(gammaMap?.chartDate);
  const strikesInPlay = Array.isArray(gammaMap?.strikesInPlay)
    ? gammaMap.strikesInPlay
      .map((value) => boundedMetricText(value, 100, 100000))
      .filter(Boolean)
      .slice(0, 20)
    : [];
  const gammaMapLines = (
    (zeroGamma !== null || upperPvBand !== null || lowerPvBand !== null)
    && gammaMapDate
  ) ? [
      'SPX Probable Volatility / Gamma By Strike chart (labeled chart OCR):',
      ...(zeroGamma !== null ? [`Zero Gamma: ${zeroGamma}`] : []),
      ...(upperPvBand !== null ? [`Upper PV Band: ${upperPvBand}`] : []),
      ...(lowerPvBand !== null ? [`Lower PV Band: ${lowerPvBand}`] : []),
      ...(strikesInPlay.length ? [`Strikes In Play: ${strikesInPlay.join(', ')}`] : []),
      `Chart date: ${gammaMapDate}`,
      ...(String(gammaMap?.source || '').trim()
        ? [`Chart source label: ${String(gammaMap.source).trim().slice(0, 120)}`]
        : []),
    ] : [];

  if (!signalLines.length && !metricLines.length && !gammaMapLines.length) return '';
  return [
    'Verified Market Situation structured data:',
    `Publication date: ${sourceDate || 'unavailable'}`,
    'Data class: source-dated research context; not a live or executable quote.',
    ...(signalLines.length ? ['Signal matrix:', ...signalLines] : []),
    ...metricLines,
    ...gammaMapLines,
  ].join('\n');
}

function formatPipelineCoverage(pipelineCoverage) {
  if (!pipelineCoverage) return undefined;
  return {
    generatedAt: pipelineCoverage.generatedAt || new Date().toISOString(),
    products: (pipelineCoverage.products || []).map((product) => ({
      product: product.id,
      stages: product.stages,
      evidenceHash: product.evidenceHash,
      observedAt: product.observedAt,
      sourceIds: product.sourceIds,
      status: product.status === 'failed'
        ? 'failed'
        : (['received', 'parsed', 'validated'].includes(product.status) ? 'indexing' : product.status),
      latestPublicationDate: product.publicationDate || null,
      sourceUri: product.sourceIds?.[0] || null,
      failureReason: product.status === 'failed' ? product.detail : null,
    })),
    warnings: pipelineCoverage.collectionErrors || [],
  };
}

async function collectAnalystResearchPipelineCoverage({
  dynamodb,
  getRiskRangeStatus = null,
  now = new Date(),
} = {}) {
  let riskRange = null;
  if (typeof getRiskRangeStatus === 'function') {
    try {
      riskRange = await getRiskRangeStatus({ now });
    } catch (error) {
      // Risk Ranges has a separate decision-grade publication gate. If that
      // gate cannot be read, fail only RR closed instead of leaving it in a
      // misleading perpetual "indexing" state or failing every product.
      riskRange = {
        status: 'error',
        available: false,
        errorCode: error.code || 'RISK_RANGE_PIPELINE_STATUS_UNAVAILABLE',
        error: error.message || String(error),
      };
    }
  }
  return collectResearchPipelineCoverage({ dynamodb, now, riskRange });
}

async function verifyStagedPdfDigest(s3, { bucket, key, expectedSha256 }) {
  const object = await s3.getObject({ Bucket: bucket, Key: key }).promise();
  const body = Buffer.isBuffer(object.Body) ? object.Body : Buffer.from(object.Body || '');
  if (!body.length || body.length > PDF_MAX_BYTES) {
    const error = new Error(body.length ? 'PDF exceeds the 50 MB maximum.' : 'The staged PDF is empty.');
    error.statusCode = body.length ? 413 : 400;
    throw error;
  }
  if (!body.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
    const error = new Error('The staged object signature is not a PDF.');
    error.statusCode = 400;
    throw error;
  }
  const actualSha256 = crypto.createHash('sha256').update(body).digest('hex');
  if (actualSha256 !== expectedSha256) {
    const error = new Error('The staged PDF changed after analysis. Analyze it again before committing.');
    error.statusCode = 409;
    error.code = 'digest_mismatch';
    throw error;
  }
  return actualSha256;
}

async function ledgerArtifactText(item, s3) {
  const key = String(item?.s3Key || item?.sourceArtifact || '');
  if (!key || !key.startsWith('hedgeye-email/')) return '';
  if (/\.pdf(?:$|\?)/i.test(key)) return '';
  const bucket = item?.s3Bucket || DEFAULT_BUCKET;
  try {
    const object = await s3.getObject({ Bucket: bucket, Key: key }).promise();
    const body = Buffer.isBuffer(object.Body) ? object.Body : Buffer.from(object.Body || '');
    if (body.length > 2 * 1024 * 1024) return '';
    const contentType = String(object.ContentType || item.contentType || '').toLowerCase();
    const decoded = body.toString('utf8');
    return /html/.test(contentType) || /\.html?$/i.test(key) ? stripHtml(decoded) : decoded;
  } catch (_error) {
    return '';
  }
}

async function normalizeFeedItem(item, tableName, s3) {
  const issues = publicationIssues(item);
  const qualityAnnotation = issues.length
    ? `Source quality annotation (dashboard validation, not publisher text): ${discrepancyText(issues)} The original publication is retained as evidence. Only the disputed fields are unavailable for calculations or recommendations; unaffected research remains usable. No corrected values have been established.`
    : '';
  const qualityMetadata = issues.length
    ? { sourceQuality: { status: 'discrepancy', issues }, sourceQualityAnnotation: qualityAnnotation }
    : {};
  if (tableName === FEED_TABLES[0].table) {
    const artifactKey = String(item?.s3Key || item?.sourceArtifact || '');
    if (!artifactKey.startsWith('hedgeye-email/')) return null;
    const mediaType = String(item?.mimeType || item?.contentType || '').toLowerCase();
    const isPdf = mediaType === 'application/pdf' || /\.pdf$/i.test(artifactKey);
    if (isPdf) {
      const sourceUri = sourceUriFor(item, tableName);
      const product = productIdFor(item);
      const publicationDate = publicationDateFor(item);
      const expectedSha256 = /^[a-f0-9]{64}$/.test(String(item?.contentSha256 || '').toLowerCase())
        ? String(item.contentSha256).toLowerCase()
        : null;
      return {
        documentId: stableId('doc', sourceUri, expectedSha256 || ''),
        product,
        publicationDate,
        title: String(item?.filename || item?.subject || `${product} ${publicationDate || ''}`).trim(),
        sourceUri,
        parserVersion: 'analyst-pdf-direct-textract-v1',
        mediaType: 'application/pdf',
        ingestMode: 'pdf',
        expectedSha256,
        metadata: {
          ...qualityMetadata,
          table: tableName,
          gmailMessageId: item?.gmailMessageId || item?.sourceMessageId || item?.messageId || null,
          attachmentId: item?.attachmentId || item?.sourceAttachmentId || null,
          lifecycleStage: item?.researchLifecycleStage || item?.stage || item?.status || null,
          ...sourceTimeMetadata(item),
        },
      };
    }
  }
  const artifactText = tableName === FEED_TABLES[0].table ? await ledgerArtifactText(item, s3) : '';
  const body = normalizeText([
    qualityAnnotation,
    marketStructureAnalystSummary(item),
    item?.subject,
    item?.title,
    artifactText,
    normalizeText(selectedResearchPayload(item)),
  ].filter(Boolean).join('\n\n')).slice(0, MAX_DOCUMENT_CHARS);
  if (!body) return null;
  const sourceUri = sourceUriFor(item, tableName);
  const product = productIdFor(item);
  const publicationDate = publicationDateFor(item);
  const identity = item?.artifactId
    || item?.eventKey
    || item?.gmailMessageId
    || item?.sourceMessageId
    || `${item?.date || ''}:${item?.snapshotType || ''}:${hashText(body)}`;
  return {
    documentId: stableId('doc', tableName, identity, sourceUri),
    product,
    publicationDate,
    title: String(item?.subject || item?.title || `${product} ${publicationDate || ''}`).trim(),
    sourceUri,
    contentHash: hashText(body),
    parserVersion: 'analyst-feed-normalizer-v1',
    section: tableName === RESEARCH_ENTITY_EVENTS_TABLE ? 'Entity event' : 'Parsed research',
    mediaType: 'text/plain',
    text: body,
    metadata: {
      ...qualityMetadata,
      table: tableName,
      gmailMessageId: item?.gmailMessageId || item?.sourceMessageId || null,
      artifactUri: item?.s3Key ? `s3://${item?.s3Bucket || DEFAULT_BUCKET}/${item.s3Key}` : null,
      lifecycleStage: item?.researchLifecycleStage || item?.stage || item?.status || null,
      ...sourceTimeMetadata(item),
    },
  };
}

function requireInternalToken(req, res, next) {
  const expected = process.env.ANALYST_SERVICE_TOKEN || '';
  const supplied = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const valid = expected && supplied.length === expected.length
    && crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
  if (!valid) return res.status(401).json({ error: 'Unauthorized' });
  return next();
}

function sidecarRequestFactory(httpClient) {
  return async function analystSidecarRequest(path, options = {}) {
    const base = (process.env.ANALYST_SIDECAR_URL || 'http://127.0.0.1:6951').replace(/\/$/, '');
    const response = await httpClient({
      method: options.method || 'GET',
      url: `${base}${path}`,
      data: options.body,
      timeout: options.timeoutMs || 90_000,
      httpAgent: SIDECAR_HTTP_AGENT,
      httpsAgent: SIDECAR_HTTPS_AGENT,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${process.env.ANALYST_SERVICE_TOKEN || ''}`,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      },
      validateStatus: () => true,
    });
    options.onResponse?.({ serverTiming: response.headers?.['server-timing'] });
    if (response.status < 200 || response.status >= 300) {
      const error = new Error(response.data?.error || `Analyst sidecar HTTP ${response.status}`);
      error.statusCode = response.status;
      error.code = response.data?.code;
      error.payload = response.data;
      throw error;
    }
    return response.data;
  };
}

function createAnalystRoutes({
  s3,
  dynamodb,
  httpClient,
  gatewayStatus = () => null,
  getContractStatus = () => ({ verified: false }),
  getRiskRangeStatus = null,
  capturePortfolioResearch = params => capturePortfolioRefreshResearch({ ...params, dynamodb }),
}) {
  const router = express.Router();
  const internalRouter = express.Router();
  const sidecarRequest = sidecarRequestFactory(httpClient);
  const canGenerate = () => getContractStatus()?.verified === true;
  const workspace = require('../services/analyst/analystWorkspace.cjs').createAnalystWorkspace({ request: sidecarRequest, canGenerate });
  const dailyWorkflow = require('../services/analyst/analystDaily.cjs').attachDailyWorkflow({ workspace, request: sidecarRequest, canGenerate });
  router.use(workspace.router);
  const bucket = process.env.ANALYST_RESEARCH_BUCKET || DEFAULT_BUCKET;
  const healthObservations = {
    sidecar: { consecutiveFailures: 0, lastSuccessAt: null, response: null },
    hermes: { consecutiveFailures: 0, lastSuccessAt: null, response: null },
  };

  const observeHealth = (name, settled, now = Date.now()) => {
    const observation = healthObservations[name];
    const response = settled.status === 'fulfilled' ? settled.value : null;
    if (response?.status === 200) {
      observation.consecutiveFailures = 0;
      observation.lastSuccessAt = new Date(now).toISOString();
      observation.response = response;
      return { response, reachable: true, transient: false };
    }
    observation.consecutiveFailures += 1;
    const lastSuccessMs = Date.parse(observation.lastSuccessAt || '');
    const withinGrace = Number.isFinite(lastSuccessMs)
      && now - lastSuccessMs < ANALYST_HEALTH_GRACE_MS;
    const transient = Boolean(
      observation.response
      && observation.consecutiveFailures < ANALYST_HEALTH_FAILURE_THRESHOLD
      && withinGrace
    );
    return {
      response: transient ? observation.response : response,
      reachable: transient,
      transient,
    };
  };

  internalRouter.use(requireInternalToken);
  internalRouter.get('/market-session', (_req, res) => {
    const { portfolioResearchDate } = require('../services/analyst/analystPortfolioReference.cjs');
    res.json({ marketDate: portfolioResearchDate(new Date()) });
  });
  internalRouter.post('/portfolio-refresh-research', async (req, res) => {
    try {
      const { symbols, marketDate, asOf } = req.body || {};
      res.json(await capturePortfolioResearch({ symbols, marketDate, asOf }));
    } catch (error) {
      res.status(error.statusCode || 503).json({ error: error.message || 'Portfolio research archive unavailable.' });
    }
  });
  internalRouter.post('/prediction-analysis', async (req, res) => {
    try {
      const facts = { ...req.body };
      const cpi = facts.markets?.find(m => m.marketId === 'cpi');
      if (cpi?.snapshot?.forecastComparison?.hedgeye?.status === 'available') {
        const get = async path => { const response = await fetch(`http://127.0.0.1:${process.env.PORT || 3001}${path}`, { signal: AbortSignal.timeout(6000) }); if (!response.ok) throw new Error('CPI evidence unavailable'); return response.json(); };
        const [history, finals] = await Promise.allSettled([get('/api/hedgeye/inflation-nowcast/history'), get('/api/prediction-markets/cpi/finals')]);
        facts.cpi = { history: history.status === 'fulfilled' ? history.value : [], finals: finals.status === 'fulfilled' ? finals.value : [] };
      }
      res.json(await require('../services/analyst/analystPredictions.cjs').buildPredictionAnalysis(facts));
    }
    catch (e) { res.status(503).json({ error: e.message }); }
  });

  let changeCoverage = null;
  let changeCoverageAt = 0;
  let costMeasurement = null;
  let gmailHealth = null;
  internalRouter.get('/change-feed', async (req, res) => {
    try {
      const cursor = String(req.query.cursor || '');
      let checkpoint = {};
      if (cursor) {
        try { checkpoint = /^\d{4}-/.test(cursor) ? { after: cursor } : JSON.parse(Buffer.from(cursor, 'base64url').toString()); }
        catch { return res.status(400).json({ error: 'Invalid change cursor' }); }
      }
      const through = checkpoint.through || new Date().toISOString();
      const lower = checkpoint.after || new Date(Date.now() - 7 * 86400000).toISOString();
      if (!Number.isFinite(Date.parse(lower.split('#')[0])) || !Number.isFinite(Date.parse(through))) return res.status(400).json({ error: 'Invalid change cursor timestamps' });
      const page = await dynamodb.query({ TableName: 'ResearchEventLedgerV2', KeyConditionExpression: 'productKey = :product AND eventKey BETWEEN :cursor AND :through', ExpressionAttributeValues: { ':product': 'analyst-change', ':cursor': lower, ':through': through }, ConsistentRead: true, Limit: 25 }).promise();
      // Overlap successive completed sweeps so delayed writes and source corrections
      // cannot fall behind a high-water mark. Stable documents/findings deduplicate replay.
      const next = page.LastEvaluatedKey && page.Items?.length
        ? { after: `${page.Items.at(-1).eventKey}\u0000`, through }
        : { after: new Date(Date.parse(through) - 120000).toISOString() };
      const nextCursor = Buffer.from(JSON.stringify(next)).toString('base64url');
      const documents = [];
      const events = [];
      for (const change of page.Items || []) {
        if (change.stage !== 'indexed') continue;
        const document = await normalizeFeedItem(change.snapshot, 'HedgeyeDailySnapshot', s3);
        if (document) documents.push(document);
        events.push(...(change.entityEvents || []));
      }
      if (Date.now() - changeCoverageAt > 60000) {
        changeCoverage = formatPipelineCoverage(await collectAnalystResearchPipelineCoverage({ dynamodb, getRiskRangeStatus }));
        changeCoverageAt = Date.now();
        const metadata = await Promise.allSettled([
          dynamodb.query({ TableName: 'ResearchEventLedgerV2', KeyConditionExpression: 'productKey = :p AND eventKey = :e', ExpressionAttributeValues: { ':p': 'analyst-cost-guard', ':e': 'current' }, ConsistentRead: true, Limit: 1 }).promise(),
          dynamodb.get({ TableName: 'HermesEmailIngestLedger', Key: { messageId: `runtime#gmail#${(process.env.HERMES_GMAIL_ACCOUNT || 'timsmithaviation@gmail.com').toLowerCase()}`, attachmentId: 'history-cursor' } }).promise(),
        ]);
        costMeasurement = metadata[0].status === 'fulfilled' ? metadata[0].value.Items?.[0]?.measurement || { status: 'unavailable' } : { status: 'unavailable', error: metadata[0].reason.message };
        const gmail = metadata[1].status === 'fulfilled' ? metadata[1].value.Item : null;
        gmailHealth = gmail ? { status: gmail.status, errorCode: gmail.errorCode, lastSuccessAt: gmail.lastSuccessAt, lastPollAt: gmail.updatedAt, pendingSince: gmail.pendingSince, quarantinedCount: gmail.quarantinedCount || 0, delaySeconds: gmail.pendingSince ? Math.max(0, (Date.now() - Date.parse(gmail.pendingSince)) / 1000) : 0 } : { status: 'unavailable', error: metadata[1].reason?.message };

      }
      return res.json({ documents, events, cursor: nextCursor, coverage: changeCoverage, ingestion: { checkedAt: new Date().toISOString(), lastChangeAt: page.Items?.at(-1)?.capturedAt || null, cost: costMeasurement, gmail: gmailHealth } });
    } catch (e) { return res.status(503).json({ error: e.message }); }
  });

  internalRouter.get('/research-feed', async (req, res) => {
    try {
      const requestedLimit = Number(req.query.limit || 50);
      const limit = Math.max(10, Math.min(100, Number.isFinite(requestedLimit) ? requestedLimit : 50));
      let { phase, lastKey } = decodeCursor(req.query.cursor);
      const coveragePromise = !req.query.cursor
        ? collectAnalystResearchPipelineCoverage({ dynamodb, getRiskRangeStatus })
          .catch((error) => ({ collectionErrors: [error.message], products: [] }))
        : Promise.resolve(null);
      if (phase >= FEED_TABLES.length) {
        const coverage = formatPipelineCoverage(await coveragePromise);
        return res.json({
          documents: [],
          nextCursor: null,
          hasMore: false,
          cycleComplete: true,
          ...(coverage ? { coverage } : {}),
        });
      }
      let result;
      let table;
      while (phase < FEED_TABLES.length) {
        table = FEED_TABLES[phase];
        result = await dynamodb.scan(feedScanParams(table, { lastKey, limit })).promise();
        if ((result.Items || []).length || result.LastEvaluatedKey) break;
        phase += 1;
        lastKey = null;
      }
      if (phase >= FEED_TABLES.length || !table || !result) {
        const coverage = formatPipelineCoverage(await coveragePromise);
        return res.json({
          documents: [],
          nextCursor: null,
          hasMore: false,
          cycleComplete: true,
          ...(coverage ? { coverage } : {}),
        });
      }
      const documents = (await Promise.all(
        (result.Items || []).map((item) => normalizeFeedItem(item, table.table, s3)),
      )).filter(Boolean);
      let nextPhase = phase;
      let nextKey = result.LastEvaluatedKey || null;
      if (!nextKey) {
        nextPhase += 1;
        nextKey = null;
      }
      const hasMore = nextPhase < FEED_TABLES.length;
      const coverage = formatPipelineCoverage(await coveragePromise);
      return res.json({
        documents,
        nextCursor: encodeCursor({ phase: nextPhase, lastKey: nextKey }),
        hasMore,
        cycleComplete: !hasMore,
        source: table.table,
        ...(coverage ? { coverage } : {}),
      });
    } catch (error) {
      return res.status(error.statusCode || 500).json({ error: error.message });
    }
  });

  router.get('/status', async (_req, res) => {
    const base = (process.env.ANALYST_SIDECAR_URL || 'http://127.0.0.1:6951').replace(/\/$/, '');
    const hermesBase = (process.env.ANALYST_HERMES_HTTP_URL || 'http://127.0.0.1:9121').replace(/\/$/, '');
    const [sidecarResult, hermesResult] = await Promise.allSettled([
      httpClient({ method: 'GET', url: `${base}/healthz`, timeout: ANALYST_HEALTH_PROBE_TIMEOUT_MS, validateStatus: () => true }),
      httpClient({ method: 'GET', url: `${hermesBase}/api/status`, timeout: ANALYST_HEALTH_PROBE_TIMEOUT_MS, validateStatus: () => true }),
    ]);
    const observedAt = Date.now();
    const sidecarObservation = observeHealth('sidecar', sidecarResult, observedAt);
    const hermesObservation = observeHealth('hermes', hermesResult, observedAt);
    const sidecarResponse = sidecarObservation.response;
    const contractVerified = getContractStatus()?.verified === true;
    const sidecarReachable = sidecarObservation.reachable;
    const hermesReachable = hermesObservation.reachable;
    const sessionTransportReady = hermesReachable && contractVerified;
    const reviewHealth = sidecarResponse?.data?.reviews || {};
    const coordinatorHealth = sidecarResponse?.data?.reviewCoordinator || {};
    const reviewReady = (reviewKind) => Boolean(
      sidecarReachable
      && coordinatorHealth.ready === true
      && reviewHealth[reviewKind]?.ready === true
    );
    const reviewReason = (reviewKind, fallback) => (
      reviewReady(reviewKind)
        ? null
        : reviewHealth[reviewKind]?.reason
          || coordinatorHealth.reason
          || (!sidecarReachable ? 'Analyst review service unavailable' : fallback)
    );
    const chatFailedDependencies = [
      ...(!contractVerified ? ['Hermes contract verification'] : []),
      ...(!hermesReachable ? ['Hermes session transport'] : []),
    ];
    const reviewFailedDependencies = [
      ...(!sidecarReachable ? ['Analyst review service'] : []),
      ...(sidecarReachable && coordinatorHealth.ready !== true
        ? [coordinatorHealth.reason || 'Review coordinator']
        : []),
    ];
    return res.json({
      status: sessionTransportReady ? 'available' : 'degraded',
      contractVerified,
      features: {
        gm: false,
        reviews: {
          portfolioReview: reviewReady('portfolio-review'),
          predictionMarketsReview: reviewReady('prediction-markets-review'),
        },
      },
      readiness: {
        sessionTransport: {
          ready: sessionTransportReady,
          reason: sessionTransportReady ? null : chatFailedDependencies[0] || 'Session transport unavailable',
        },
        reviewCoordinator: {
          ready: sidecarReachable && coordinatorHealth.ready === true,
          reason: sidecarReachable && coordinatorHealth.ready === true
            ? null
            : coordinatorHealth.reason || 'Analyst review service unavailable',
        },
        portfolioReview: {
          ready: reviewReady('portfolio-review'),
          reason: reviewReason('portfolio-review', 'Portfolio Review unavailable'),
        },
        predictionMarketsReview: {
          ready: reviewReady('prediction-markets-review'),
          reason: reviewReason('prediction-markets-review', 'Predictive Markets Review unavailable'),
        },
      },
      failedDependencies: [...chatFailedDependencies, ...reviewFailedDependencies],
      chatFailedDependencies,
      reviewFailedDependencies,
      healthObservations: {
        sidecar: {
          observedAt: new Date(observedAt).toISOString(),
          lastSuccessAt: healthObservations.sidecar.lastSuccessAt,
          consecutiveFailures: healthObservations.sidecar.consecutiveFailures,
          transient: sidecarObservation.transient,
        },
        hermes: {
          observedAt: new Date(observedAt).toISOString(),
          lastSuccessAt: healthObservations.hermes.lastSuccessAt,
          consecutiveFailures: healthObservations.hermes.consecutiveFailures,
          transient: hermesObservation.transient,
        },
      },
      sidecar: sidecarResponse?.data || {
        ok: false,
        error: sidecarResult.status === 'rejected'
          ? sidecarResult.reason?.message
          : `Analyst sidecar HTTP ${sidecarResponse?.status || 'unavailable'}`,
      },
      hermes: {
        ...gatewayStatus(),
        reachable: hermesReachable,
        ...(hermesResult.status === 'rejected' ? { error: hermesResult.reason?.message } : {}),
      },
    });
  });

  router.post('/reviews', async (req, res) => {
    try {
      const reviewKind = String(req.body?.reviewKind || '');
      const conversationId = String(req.body?.conversationId || '');
      const sessionId = String(req.body?.sessionId || '');
      const requestId = String(req.body?.requestId || '');
      const result = await sidecarRequest('/internal/reviews', {
        method: 'POST',
        timeoutMs: 5_000,
        body: {
          reviewKind,
          ...(conversationId ? { conversationId } : {}),
          sessionId,
          requestId,
        },
      });
      return res.status(['queued', 'running'].includes(result.state) ? 202 : 200).json(result);
    } catch (error) {
      return res.status(error.statusCode || 503).json(error.payload || {
        ok: false,
        code: error.code || 'REVIEW_REQUEST_FAILED',
        error: error.message || 'The review service could not start the review.',
      });
    }
  });

  router.get('/reviews', async (req, res) => {
    try {
      const conversationId = String(req.query?.conversationId || '').trim();
      const sessionId = String(req.query?.sessionId || '').trim();
      const limit = Math.max(1, Math.min(500, Number(req.query?.limit) || 100));
      const query = conversationId
        ? `?conversationId=${encodeURIComponent(conversationId)}`
        : sessionId
          ? `?sessionId=${encodeURIComponent(sessionId)}`
        : `?limit=${limit}`;
      return res.json(await sidecarRequest(`/internal/reviews${query}`, { timeoutMs: 5_000 }));
    } catch (error) {
      return res.status(error.statusCode || 503).json(error.payload || {
        ok: false,
        code: error.code || 'REVIEW_STATUS_UNAVAILABLE',
        error: error.message || 'Review status is unavailable.',
      });
    }
  });

  router.get('/review-conversations', async (req, res) => {
    try {
      const limit = Math.max(1, Math.min(100, Number(req.query?.limit) || 50));
      const cursor = String(req.query?.cursor || '');
      const query = String(req.query?.q || '');
      const params = new URLSearchParams({ limit: String(limit) });
      if (cursor) params.set('cursor', cursor);
      if (query) params.set('q', query);
      return res.json(await sidecarRequest(
        `/internal/review-conversations?${params.toString()}`,
        { timeoutMs: 5_000 },
      ));
    } catch (error) {
      return res.status(error.statusCode || 503).json(error.payload || {
        ok: false,
        code: error.code || 'REVIEW_STATUS_UNAVAILABLE',
        error: error.message || 'Review conversations are unavailable.',
      });
    }
  });

  router.post('/review-conversations', async (req, res) => {
    try {
      const result = await sidecarRequest(
        '/internal/review-conversations',
        {
          method: 'POST',
          timeoutMs: 5_000,
          body: {
            reviewKind: String(req.body?.reviewKind || ''),
            requestId: String(req.body?.requestId || ''),
          },
        },
      );
      return res.status(result.created ? 202 : 200).json(result);
    } catch (error) {
      return res.status(error.statusCode || 503).json(error.payload || {
        ok: false,
        code: error.code || 'REVIEW_REQUEST_FAILED',
        error: error.message || 'The review service could not start the review.',
      });
    }
  });

  router.post('/review-conversations/:reviewKind/runs', (_req, res) => res.status(410).json({
    ok: false,
    code: 'FIXED_REVIEW_CONVERSATIONS_RETIRED',
    error: 'Create a review conversation through POST /api/analyst/review-conversations.',
  }));

  router.get('/review-conversations/:conversationId', async (req, res) => {
    try {
      const conversationId = encodeURIComponent(String(req.params.conversationId || ''));
      return res.json(await sidecarRequest(
        `/internal/review-conversations/${conversationId}`,
        { timeoutMs: 8_000 },
      ));
    } catch (error) {
      return res.status(error.statusCode || 503).json(error.payload || {
        ok: false,
        code: error.code || 'REVIEW_CONVERSATION_UNAVAILABLE',
        error: error.message || 'Review conversation is unavailable.',
      });
    }
  });

  router.post('/review-conversations/:conversationId/retries', async (req, res) => {
    try {
      const conversationId = encodeURIComponent(String(req.params.conversationId || ''));
      const result = await sidecarRequest(
        `/internal/review-conversations/${conversationId}/retries`,
        {
          method: 'POST',
          timeoutMs: 5_000,
          body: {
            requestId: String(req.body?.requestId || ''),
            previousRunId: String(req.body?.previousRunId || ''),
          },
        },
      );
      return res.status(202).json(result);
    } catch (error) {
      return res.status(error.statusCode || 503).json(error.payload || {
        ok: false,
        code: error.code || 'REVIEW_RETRY_FAILED',
        error: error.message || 'The review could not be retried.',
      });
    }
  });

  router.get('/reviews/:runId', async (req, res) => {
    try {
      const runId = encodeURIComponent(String(req.params.runId || ''));
      return res.json(await sidecarRequest(`/internal/reviews/${runId}`, { timeoutMs: 5_000 }));
    } catch (error) {
      return res.status(error.statusCode || 503).json(error.payload || {
        ok: false,
        code: error.code || 'REVIEW_STATUS_UNAVAILABLE',
        error: error.message || 'Review status is unavailable.',
      });
    }
  });

  router.get('/reviews/:runId/status', async (req, res) => {
    try {
      const runId = encodeURIComponent(String(req.params.runId || ''));
      return res.json(await sidecarRequest(
        `/internal/reviews/${runId}/status`,
        { timeoutMs: 5_000 },
      ));
    } catch (error) {
      return res.status(error.statusCode || 503).json(error.payload || {
        ok: false,
        code: error.code || 'REVIEW_STATUS_UNAVAILABLE',
        error: error.message || 'Review status is unavailable.',
      });
    }
  });

  router.post('/reviews/:runId/retry', async (req, res) => {
    try {
      const runId = encodeURIComponent(String(req.params.runId || ''));
      const result = await sidecarRequest(`/internal/reviews/${runId}/retry`, {
        method: 'POST',
        timeoutMs: 5_000,
        body: { requestId: String(req.body?.requestId || '') },
      });
      return res.status(202).json(result);
    } catch (error) {
      return res.status(error.statusCode || 503).json(error.payload || {
        ok: false,
        code: error.code || 'REVIEW_RETRY_FAILED',
        error: error.message || 'The review could not be retried.',
      });
    }
  });

  router.get('/sources', async (_req, res) => {
    try {
      const result = await sidecarRequest('/internal/pdf/imports');
      return res.json(result);
    } catch (error) {
      return res.status(error.statusCode || 503).json({ error: error.message, imports: [] });
    }
  });

  router.get('/catalog', (_req, res) => res.json({
    products: [{ id: MANUAL_IMPORT_PRODUCT, label: 'Generic Analyst knowledge' }],
    upload: {
      mediaType: 'application/pdf',
      maxBytes: PDF_MAX_BYTES,
      stagingExpiresHours: 24,
      autoIndex: true,
    },
  }));

  async function commitStagedPdf({
    importId,
    key,
    sha256,
    title,
    requestedPublicationDate,
    detectedPublicationDate,
    stagedHead,
  }) {
    if (!String(key || '').startsWith(STAGING_PREFIX) || String(key).includes('..')) {
      throw requestError('Invalid Analyst staging key.');
    }
    if (!/^([a-f0-9]{64})$/.test(String(sha256 || ''))) {
      throw requestError('A valid analyzed SHA-256 is required.');
    }
    const head = stagedHead || await s3.headObject({ Bucket: bucket, Key: key }).promise();
    if (Number(head.ContentLength || 0) > PDF_MAX_BYTES || String(head.ContentType || '').toLowerCase() !== 'application/pdf') {
      throw requestError('Staged object no longer passes PDF validation.');
    }
    const resolvedDate = resolveManualPublicationDate({
      requestedPublicationDate,
      detectedPublicationDate,
      uploadedAt: head.LastModified,
    });
    const publicationDate = resolvedDate.publicationDate;
    await verifyStagedPdfDigest(s3, {
      bucket,
      key,
      expectedSha256: sha256,
    });
    const immutableKey = `${IMMUTABLE_PREFIX}${MANUAL_IMPORT_PRODUCT}/${publicationDate}/${sha256}.pdf`;
    let copied = false;
    try {
      await s3.headObject({ Bucket: bucket, Key: immutableKey }).promise();
    } catch (error) {
      if (error.code !== 'NotFound' && error.statusCode !== 404) throw error;
      await s3.copyObject({
        Bucket: bucket,
        Key: immutableKey,
        CopySource: encodeURIComponent(`${bucket}/${key}`).replace(/%2F/g, '/'),
        ContentType: 'application/pdf',
        MetadataDirective: 'REPLACE',
        Metadata: {
          'content-sha256': sha256,
          'report-type': MANUAL_IMPORT_PRODUCT,
          'published-at': `${publicationDate}T12:00:00Z`,
          'publication-date-source': resolvedDate.source,
          'analyst-import-id': String(importId),
          'original-filename': head.Metadata?.['original-filename'] || key.split('/').pop(),
        },
      }).promise();
      copied = true;
    }
    const downloadUrl = await s3.getSignedUrlPromise('getObject', { Bucket: bucket, Key: immutableKey, Expires: 600 });
    const result = await sidecarRequest('/internal/pdf/commit', {
      method: 'POST',
      timeoutMs: 10 * 60 * 1000,
      body: {
        importId,
        sourceUri: `s3://${bucket}/${immutableKey}`,
        downloadUrl,
        product: MANUAL_IMPORT_PRODUCT,
        publicationDate,
        sha256,
        title,
      },
    });
    await s3.deleteObject({ Bucket: bucket, Key: key }).promise();
    return {
      ...result,
      product: MANUAL_IMPORT_PRODUCT,
      publicationDate,
      publicationDateSource: resolvedDate.source,
      immutableKey,
      copied,
      autoIndexed: true,
      structuredParserQueued: false,
      structuredParserRequired: false,
    };
  }

  router.post('/sources/presign', async (req, res) => {
    try {
      const validation = validatePdfUploadRequest(req.body || {});
      if (!validation.ok) return res.status(validation.statusCode).json({ error: validation.error });
      const uploadId = crypto.randomUUID();
      const key = `${STAGING_PREFIX}${uploadId}/${validation.cleanFilename}`;
      const params = buildPdfUploadPostParams({
        bucket,
        key,
        uploadId,
        cleanFilename: validation.cleanFilename,
      });
      const post = await new Promise((resolve, reject) => {
        s3.createPresignedPost(params, (error, data) => (error ? reject(error) : resolve(data)));
      });
      return res.json({
        uploadId,
        key,
        url: post.url,
        fields: post.fields,
        expiresAt: new Date(Date.now() + PRESIGN_TTL_SECONDS * 1000).toISOString(),
        maxBytes: PDF_MAX_BYTES,
      });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  });

  router.post('/sources/analyze', async (req, res) => {
    try {
      const key = String(req.body?.key || '');
      if (!key.startsWith(STAGING_PREFIX) || key.includes('..')) {
        return res.status(400).json({ error: 'Invalid Analyst staging key.' });
      }
      const head = await s3.headObject({ Bucket: bucket, Key: key }).promise();
      if (Number(head.ContentLength || 0) > PDF_MAX_BYTES) {
        return res.status(413).json({ error: 'PDF exceeds the 50 MB maximum.' });
      }
      if (String(head.ContentType || '').toLowerCase() !== 'application/pdf') {
        return res.status(400).json({ error: 'Staged object is not application/pdf.' });
      }
      const downloadUrl = await s3.getSignedUrlPromise('getObject', { Bucket: bucket, Key: key, Expires: 300 });
      const result = await sidecarRequest('/internal/pdf/analyze', {
        method: 'POST',
        body: {
          stagingKey: key,
          filename: head.Metadata?.['original-filename'] || key.split('/').pop(),
          contentType: head.ContentType,
          downloadUrl,
        },
      });
      if (result.status === 'duplicate') {
        await s3.deleteObject({ Bucket: bucket, Key: key }).promise();
        return res.json({
          ...result,
          product: MANUAL_IMPORT_PRODUCT,
          autoIndexed: false,
        });
      }
      const committed = await commitStagedPdf({
        importId: result.importId,
        key,
        sha256: result.sha256,
        title: result.filename,
        detectedPublicationDate: result.detectedPublicationDate,
        stagedHead: head,
      });
      return res.json(committed);
    } catch (error) {
      return res.status(error.statusCode || 500).json(error.payload || { error: error.message, code: error.code });
    }
  });

  router.post('/sources/commit', async (req, res) => {
    try {
      const { importId, key, sha256, publicationDate, detectedPublicationDate, title } = req.body || {};
      return res.json(await commitStagedPdf({
        importId,
        key,
        sha256,
        title,
        requestedPublicationDate: publicationDate,
        detectedPublicationDate,
      }));
    } catch (error) {
      return res.status(error.statusCode || 500).json(error.payload || { error: error.message, code: error.code });
    }
  });

  async function cleanupStaging() {
    let continuationToken;
    let removed = 0;
    do {
      const page = await s3.listObjectsV2({
        Bucket: bucket,
        Prefix: STAGING_PREFIX,
        ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
      }).promise();
      const expired = (page.Contents || []).filter((object) => (
        object.Key?.startsWith(STAGING_PREFIX)
        && object.LastModified
        && Date.now() - new Date(object.LastModified).getTime() >= STAGING_MAX_AGE_MS
      ));
      if (expired.length) {
        await s3.deleteObjects({
          Bucket: bucket,
          Delete: { Quiet: true, Objects: expired.map((object) => ({ Key: object.Key })) },
        }).promise();
        removed += expired.length;
      }
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken);
    return removed;
  }

  return { router, internalRouter, cleanupStaging, workspace, dailyWorkflow };
}

module.exports = {
  DEFAULT_BUCKET,
  FEED_TABLES,
  FEED_LOOKBACK_DAYS,
  FEED_SCAN_PAGE_LIMIT,
  IMMUTABLE_PREFIX,
  PDF_MAX_BYTES,
  STAGING_PREFIX,
  buildPdfUploadPostParams,
  collectAnalystResearchPipelineCoverage,
  createAnalystRoutes,
  decodeCursor,
  encodeCursor,
  feedScanParams,
  normalizeFeedItem,
  normalizeText,
  resolveManualPublicationDate,
  verifyStagedPdfDigest,
  validatePdfUploadRequest,
};
