#!/usr/bin/env node
/*
 * Outbound-only bridge from the loopback dashboard stack to AWS.
 *
 * The bridge publishes a deliberately small portfolio/readiness document. It
 * never opens an inbound listener and it never publishes uploaded, cached-
 * disconnected, delayed, mock, seeded, inferred, or fallback portfolio data.
 */

const crypto = require('crypto');
const os = require('os');
const AWS = require('aws-sdk');

const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-west-1';
const SNAPSHOT_TABLE = process.env.HERMES_INPUT_SNAPSHOT_TABLE || 'HermesInputSnapshots';
const HEARTBEAT_TABLE = process.env.SERVICE_HEARTBEAT_TABLE || 'MarketDashboardServiceHeartbeats';
const API_BASE = String(process.env.MARKET_DASHBOARD_API_URL || 'http://127.0.0.1:3001').replace(/\/$/, '');
const SIDECAR_BASE = String(process.env.IBKR_SIDECAR_URL || 'http://127.0.0.1:8765').replace(/\/$/, '');
const HOST_ID = process.env.HERMES_BRIDGE_HOST_ID || 'tim-market-dashboard';
const BUILD_VERSION = process.env.MARKET_DASHBOARD_BUILD_VERSION || require('../../package.json').version;
const INTERVAL_MS = Math.max(30_000, Number(process.env.HERMES_BRIDGE_INTERVAL_MS) || 60_000);
const REQUEST_TIMEOUT_MS = Math.max(2_000, Number(process.env.HERMES_BRIDGE_REQUEST_TIMEOUT_MS) || 20_000);
const MAX_INPUT_AGE_MS = Math.max(30_000, Number(process.env.HERMES_BRIDGE_MAX_INPUT_AGE_MS) || 180_000);
const TTL_DAYS = Math.max(1, Number(process.env.HERMES_BRIDGE_TTL_DAYS) || 30);
const once = process.argv.includes('--once');
const EXPECTED_CAPABILITY_IDS = Object.freeze([
  'automation.hermes',
  'dashboard.core',
  'portfolio.live',
  'prediction.display',
  'prediction.ibkrExecution',
  'research.current',
]);

const PROHIBITED_PROVENANCE = /(?:^|[\s;,_-])(stale|offline|cache(?:d)?|mock|seed(?:ed)?|synthetic|fallback|inferred|portfolio[-_ ]derived|frozen|delayed|historical)(?:$|[\s;,_-])/i;

function assertLoopbackBase(raw, label) {
  const parsed = new URL(raw);
  const allowed = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
  if (parsed.protocol !== 'http:' || !allowed.has(parsed.hostname)) {
    throw new Error(`${label} must be an http loopback URL; received ${parsed.origin}`);
  }
  return raw;
}

assertLoopbackBase(API_BASE, 'MARKET_DASHBOARD_API_URL');
assertLoopbackBase(SIDECAR_BASE, 'IBKR_SIDECAR_URL');

const dynamodb = new AWS.DynamoDB.DocumentClient({ region: REGION });

function nowIso() {
  return new Date().toISOString();
}

function ttlEpoch() {
  return Math.floor(Date.now() / 1000) + TTL_DAYS * 24 * 60 * 60;
}

function boundedDetail(error) {
  return String(error?.message || error || 'unknown error')
    .replace(/[\r\n]+/g, ' ')
    .replace(/(secret|token|password|authorization)\s*[=:]\s*[^\s,}]+/gi, '$1=[REDACTED]')
    .slice(0, 500);
}

function publishErrorCode(error) {
  const code = String(error?.code || error?.name || '').toUpperCase();
  if (code.includes('ACCESSDENIED') || /not authorized/i.test(String(error?.message || ''))) {
    return 'HERMES_BRIDGE_AWS_ACCESS_DENIED';
  }
  if (code.includes('RESOURCE') && code.includes('NOTFOUND')) return 'HERMES_BRIDGE_TABLE_MISSING';
  return 'HERMES_BRIDGE_PUBLISH_FAILED';
}

function ageMs(value) {
  const millis = Date.parse(String(value || ''));
  return Number.isFinite(millis) ? Math.max(0, Date.now() - millis) : Number.POSITIVE_INFINITY;
}

async function getJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
    });
    if (!response.ok) throw new Error(`${new URL(url).pathname} returned HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function readinessCapabilities(report) {
  if (Array.isArray(report?.capabilities)) {
    return Object.fromEntries(
      report.capabilities.filter(item => item?.id).map(item => [item.id, item]),
    );
  }
  return report?.capabilities && typeof report.capabilities === 'object'
    ? report.capabilities
    : {};
}

function capabilityIsReady(capability) {
  return capability?.ready === true || ['pass', 'ready'].includes(capability?.status);
}

function sanitizeCapabilities(report) {
  const result = {};
  for (const [id, capability] of Object.entries(readinessCapabilities(report))) {
    if (!capability || typeof capability !== 'object') continue;
    result[id] = {
      status: capability.status || (capability.ready ? 'pass' : 'fail'),
      ready: Boolean(capability.ready),
      errorCode: capability.errorCode || null,
      lastSuccessAt: capability.lastSuccessAt || null,
      nextDueAt: capability.nextDueAt || null,
    };
  }
  return result;
}

function accountRef(accountId) {
  return crypto.createHash('sha256').update(String(accountId)).digest('hex').slice(0, 12);
}

function verifyPortfolio({ portfolio, readiness }) {
  if (readiness?.version !== 1 || ageMs(readiness?.checkedAt) > MAX_INPUT_AGE_MS) {
    const error = new Error('The dashboard readiness report is missing, unsupported, or stale.');
    error.code = 'SYSTEM_READINESS_UNVERIFIED';
    throw error;
  }
  const capabilities = readinessCapabilities(readiness);
  const capabilityIds = Object.keys(capabilities).sort();
  if (capabilityIds.length !== EXPECTED_CAPABILITY_IDS.length
      || capabilityIds.some((id, index) => id !== EXPECTED_CAPABILITY_IDS[index])) {
    const error = new Error('The dashboard readiness report does not implement the exact capability contract.');
    error.code = 'SYSTEM_READINESS_CAPABILITY_CONTRACT_INVALID';
    throw error;
  }
  const portfolioCapability = capabilities['portfolio.live'] || capabilities.portfolio;
  if (!portfolioCapability) {
    const error = new Error('The dashboard readiness report omitted the portfolio.live capability.');
    error.code = 'PORTFOLIO_CAPABILITY_MISSING';
    throw error;
  }
  if (!capabilityIsReady(portfolioCapability)) {
    const error = new Error('The portfolio.live readiness gate is not ready.');
    error.code = portfolioCapability.errorCode || 'PORTFOLIO_CAPABILITY_BLOCKED';
    throw error;
  }
  if (
    portfolio?.ok !== true
    || portfolio?.connected !== true
    || portfolio?.status !== 'live'
    || portfolio?.source !== 'ibkr_live_session'
  ) {
    const error = new Error('IBKR sidecar did not verify the live Gateway session.');
    error.code = 'IBKR_GATEWAY_DISCONNECTED';
    throw error;
  }
  if (!Array.isArray(portfolio.accounts) || portfolio.accounts.length === 0) {
    const error = new Error('IBKR managed-account coverage could not be verified.');
    error.code = 'IBKR_ACCOUNTS_UNVERIFIED';
    throw error;
  }
  const observedAt = portfolio.observed_at;
  const socketVerifiedAt = portfolio.socket_verified_at;
  if (ageMs(observedAt) > MAX_INPUT_AGE_MS || ageMs(socketVerifiedAt) > MAX_INPUT_AGE_MS) {
    const error = new Error('IBKR portfolio observation or socket verification is stale.');
    error.code = 'PORTFOLIO_SNAPSHOT_STALE';
    throw error;
  }
  const positions = Array.isArray(portfolio.positions) ? portfolio.positions : null;
  if (!positions) {
    const error = new Error('Verified live portfolio response does not contain a positions array.');
    error.code = 'PORTFOLIO_SCHEMA_INVALID';
    throw error;
  }
  const managedAccounts = new Set(portfolio.accounts.map(String));
  if (positions.some(row => !managedAccounts.has(String(row?.account || '')))) {
    const error = new Error('A live position does not belong to a verified managed account.');
    error.code = 'IBKR_ACCOUNTS_UNVERIFIED';
    throw error;
  }
  return { observedAt, socketVerifiedAt, positions, managedAccounts };
}

function buildReadySnapshot({ portfolio, readiness, capturedAt = nowIso() }) {
  const verified = verifyPortfolio({ portfolio, readiness });
  const managed = new Set([...verified.managedAccounts].map(accountRef));
  const positions = verified.positions.map(row => ({
    accountRef: accountRef(row.account),
    symbol: String(row.symbol || ''),
    localSymbol: row.localSymbol || null,
    conId: row.conId == null ? null : Number(row.conId),
    secType: row.secType || null,
    exchange: row.exchange || null,
    currency: row.currency || null,
    quantity: Number(row.position),
    positionSource: 'ibkr_api',
  }));
  if (positions.some(position => !position.symbol || !Number.isFinite(position.quantity))) {
    const error = new Error('Portfolio response contains malformed positions.');
    error.code = 'PORTFOLIO_SCHEMA_INVALID';
    throw error;
  }
  return {
    hostId: HOST_ID,
    capturedAt,
    source: 'local-outbound-bridge',
    bridgeStatus: 'ready',
    buildVersion: BUILD_VERSION,
    runtime: {
      hostnameHash: accountRef(os.hostname()),
      node: process.version,
      platform: process.platform,
    },
    gateway: {
      connected: true,
      observedAt: portfolio.observed_at,
      socketVerifiedAt: verified.socketVerifiedAt,
    },
    capabilities: sanitizeCapabilities(readiness),
    rootCauseCodes: Array.from(new Set((readiness.rootCauses || []).map(item => item?.errorCode).filter(Boolean))),
    manualActions: (readiness.manualActions || []).map(item => ({
      id: item.id || null,
      label: item.label || item.summary || null,
    })),
    portfolio: {
      verified: true,
      source: 'ibkr_live',
      positionSource: 'ibkr_api',
      priceSource: 'not_included',
      accountsVerified: true,
      accountCount: managed.size,
      observedAt: verified.observedAt,
      positionCount: positions.length,
      positions,
    },
    ttl: ttlEpoch(),
  };
}

function buildDegradedSnapshot(error, capturedAt = nowIso()) {
  return {
    hostId: HOST_ID,
    capturedAt,
    source: 'local-outbound-bridge',
    bridgeStatus: 'error',
    buildVersion: BUILD_VERSION,
    errorCode: error?.code || 'HERMES_BRIDGE_INPUT_ERROR',
    detail: boundedDetail(error),
    gateway: { connected: false },
    capabilities: {},
    manualActions: [],
    portfolio: {
      verified: false,
      source: 'unavailable',
      accountsVerified: false,
      positions: [],
    },
    ttl: ttlEpoch(),
  };
}

async function putHeartbeat(snapshot, startedAt) {
  const observedAt = nowIso();
  await dynamodb.put({
    TableName: HEARTBEAT_TABLE,
    Item: {
      serviceId: 'bridge:local-dashboard',
      observedAt,
      startedAt,
      finishedAt: observedAt,
      status: snapshot.bridgeStatus === 'ready' ? 'success' : 'error',
      errorCode: snapshot.errorCode || null,
      detail: snapshot.detail || null,
      source: 'local-outbound-bridge',
      buildVersion: BUILD_VERSION,
      counts: { positions: snapshot.portfolio?.positionCount || 0 },
      ttl: ttlEpoch(),
    },
  }).promise();
}

async function captureAndPublish() {
  const startedAt = nowIso();
  let snapshot;
  try {
    const [portfolio, readiness] = await Promise.all([
      getJson(`${SIDECAR_BASE}/portfolio/live-positions`),
      getJson(`${API_BASE}/api/system-readiness?refresh=1`),
    ]);
    snapshot = buildReadySnapshot({ portfolio, readiness });
  } catch (error) {
    snapshot = buildDegradedSnapshot(error);
  }

  await dynamodb.put({ TableName: SNAPSHOT_TABLE, Item: snapshot }).promise();
  await putHeartbeat(snapshot, startedAt);
  process.stdout.write(`${JSON.stringify({
    observedAt: snapshot.capturedAt,
    status: snapshot.bridgeStatus,
    errorCode: snapshot.errorCode || null,
    positions: snapshot.portfolio?.positionCount || 0,
  })}\n`);
  return snapshot;
}

async function main() {
  if (once) {
    const snapshot = await captureAndPublish();
    process.exitCode = snapshot.bridgeStatus === 'ready' ? 0 : 2;
    return;
  }
  let stopping = false;
  const stop = () => { stopping = true; };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  while (!stopping) {
    try {
      await captureAndPublish();
    } catch (error) {
      process.stdout.write(`${JSON.stringify({
        observedAt: nowIso(),
        status: 'error',
        errorCode: publishErrorCode(error),
        detail: boundedDetail(error),
        positions: 0,
      })}\n`);
    }
    if (stopping) break;
    await new Promise(resolve => setTimeout(resolve, INTERVAL_MS));
  }
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`[hermes-bridge] fatal: ${boundedDetail(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  PROHIBITED_PROVENANCE,
  EXPECTED_CAPABILITY_IDS,
  accountRef,
  assertLoopbackBase,
  buildDegradedSnapshot,
  buildReadySnapshot,
  capabilityIsReady,
  publishErrorCode,
  readinessCapabilities,
  sanitizeCapabilities,
  verifyPortfolio,
};
