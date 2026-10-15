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
const { AWS } = require('../../src/services/aws/clients.cjs');

const REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-west-1';
const SNAPSHOT_TABLE = process.env.HERMES_INPUT_SNAPSHOT_TABLE || 'HermesInputSnapshots';
const HEARTBEAT_TABLE = process.env.SERVICE_HEARTBEAT_TABLE || 'MarketDashboardServiceHeartbeats';
const API_BASE = String(process.env.MARKET_DASHBOARD_API_URL || 'http://127.0.0.1:3001').replace(/\/$/, '');
const SIDECAR_BASE = String(process.env.IBKR_SIDECAR_URL || 'http://127.0.0.1:8765').replace(/\/$/, '');
const HOST_ID = process.env.HERMES_BRIDGE_HOST_ID || 'tim-market-dashboard';
const BUILD_VERSION = process.env.MARKET_DASHBOARD_BUILD_VERSION || require('../../package.json').version;
const INTERVAL_MS = Math.max(30_000, Number(process.env.HERMES_BRIDGE_INTERVAL_MS) || 60_000);
const REQUEST_TIMEOUT_MS = Math.max(2_000, Number(process.env.HERMES_BRIDGE_REQUEST_TIMEOUT_MS) || 20_000);
// Keep ahead of SYSTEM_READINESS_CACHE_MS (5m floor) so ops telemetry stays
// publishable while readiness reuses its hard collection budget.
const MAX_INPUT_AGE_MS = Math.max(30_000, Number(process.env.HERMES_BRIDGE_MAX_INPUT_AGE_MS) || 360_000);
const MAX_CLOCK_SKEW_MS = 30_000;
const TTL_DAYS = Math.max(1, Number(process.env.HERMES_BRIDGE_TTL_DAYS) || 30);
const configuredBridgeAwsProfile = String(
  process.env.HERMES_BRIDGE_AWS_PROFILE
    || process.env.AWS_PROFILE
    || 'market-dashboard-bridge',
).trim();
const BRIDGE_AWS_PROFILE = configuredBridgeAwsProfile || 'market-dashboard-bridge';
const once = process.argv.includes('--once');
const ENABLED_FLAG_VALUES = new Set(['1', 'true', 'yes', 'on', 'enabled']);
const EXPECTED_CAPABILITY_IDS = Object.freeze([
  'automation.hermes',
  'dashboard.core',
  'portfolio.live',
  'prediction.display',
  'prediction.ibkrExecution',
  'research.current',
]);

const PROHIBITED_PROVENANCE = /(?:^|[\s;,_-])(stale|offline|cache(?:d)?|mock|seed(?:ed)?|synthetic|fallback|inferred|portfolio[-_ ]derived|frozen|delayed|historical)(?:$|[\s;,_-])/i;

function hermesBridgeEnabled(env = process.env) {
  const partitions = bridgePartitions(env);
  return partitions.operations || partitions.portfolio;
}

function bridgePartitions(env = process.env) {
  const legacy = ENABLED_FLAG_VALUES.has(
    String(env.HERMES_BRIDGE_ENABLED || '').trim().toLowerCase(),
  );
  const enabled = (name) => (
    Object.prototype.hasOwnProperty.call(env, name)
      ? ENABLED_FLAG_VALUES.has(String(env[name] || '').trim().toLowerCase())
      : legacy
  );
  return {
    operations: enabled('HERMES_OPERATIONS_BRIDGE_ENABLED'),
    portfolio: enabled('HERMES_PORTFOLIO_BRIDGE_ENABLED'),
  };
}

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

process.env.AWS_PROFILE = BRIDGE_AWS_PROFILE;
process.env.AWS_SDK_LOAD_CONFIG = process.env.AWS_SDK_LOAD_CONFIG || '1';
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
  if (
    code.includes('CREDENTIAL')
    || code.includes('EXPIREDTOKEN')
    || code.includes('INVALIDCLIENTTOKEN')
    || code.includes('UNRECOGNIZEDCLIENT')
    || /credentials?.*(?:not loaded|could not|missing|unavailable)/i.test(String(error?.message || ''))
  ) {
    return 'HERMES_BRIDGE_AWS_PROFILE_UNAVAILABLE';
  }
  if (code.includes('THROTTL') || code.includes('PROVISIONEDTHROUGHPUT')) {
    return 'HERMES_BRIDGE_AWS_THROTTLED';
  }
  if (
    code.includes('NETWORK')
    || code.includes('TIMEOUT')
    || ['ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH', 'ENOTFOUND', 'ETIMEDOUT'].includes(code)
  ) {
    return 'HERMES_BRIDGE_AWS_UNREACHABLE';
  }
  if (code.includes('RESOURCE') && code.includes('NOTFOUND')) return 'HERMES_BRIDGE_TABLE_MISSING';
  return 'HERMES_BRIDGE_PUBLISH_FAILED';
}

function inputFailure(error) {
  return {
    status: error?.blockedBy ? 'blocked' : 'error',
    errorCode: error?.code || 'HERMES_BRIDGE_INPUT_ERROR',
    detail: boundedDetail(error),
    blockedBy: error?.blockedBy || null,
    upstreamStatus: error?.upstreamStatus || null,
  };
}

function publishFailure(error, stage) {
  const errorCode = publishErrorCode(error);
  return {
    status: 'error',
    stage,
    errorCode,
    detail: errorCode === 'HERMES_BRIDGE_AWS_PROFILE_UNAVAILABLE'
      ? `Dedicated AWS profile ${BRIDGE_AWS_PROFILE} has no usable credentials.`
      : boundedDetail(error),
    awsProfile: BRIDGE_AWS_PROFILE,
  };
}

function ageMs(value) {
  const millis = Date.parse(String(value || ''));
  if (!Number.isFinite(millis)) return Number.POSITIVE_INFINITY;
  const age = Date.now() - millis;
  return age < -MAX_CLOCK_SKEW_MS ? Number.POSITIVE_INFINITY : Math.max(0, age);
}

async function getJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const path = new URL(url).pathname;
      const upstreamStatus = String(payload?.status || '').trim().toLowerCase();
      const upstreamErrorCode = String(payload?.error_code || payload?.errorCode || '').trim();
      const portfolioCodes = {
        disconnected: 'IBKR_GATEWAY_NOT_AUTHENTICATED',
        gateway_unavailable: 'IBKR_GATEWAY_NOT_AUTHENTICATED',
        gateway_not_authenticated: 'IBKR_GATEWAY_NOT_AUTHENTICATED',
        gateway_api_unresponsive: 'IBKR_GATEWAY_API_UNRESPONSIVE',
        client_id_in_use: 'IBKR_CLIENT_ID_IN_USE',
        not_connected: 'IBKR_GATEWAY_NOT_AUTHENTICATED',
        positions_request_busy: 'IBKR_POSITIONS_REQUEST_BUSY',
        positions_request_timeout: 'IBKR_POSITIONS_REQUEST_TIMEOUT',
        socket_verification_timeout: 'IBKR_SOCKET_VERIFICATION_TIMEOUT',
        live_session_unverified: 'IBKR_LIVE_SESSION_UNVERIFIED',
        tws_offline: 'IBKR_POSITIONS_CLIENT_UNAVAILABLE',
        positions_client_unavailable: 'IBKR_POSITIONS_CLIENT_UNAVAILABLE',
      };
      const error = new Error(
        boundedDetail(payload?.message || `${path} returned HTTP ${response.status}`),
      );
      error.code = path === '/portfolio/live-positions'
        ? (upstreamErrorCode || portfolioCodes[upstreamStatus] || 'IBKR_LIVE_PORTFOLIO_UNAVAILABLE')
        : 'HERMES_BRIDGE_INPUT_UNAVAILABLE';
      error.blockedBy = path === '/portfolio/live-positions' ? 'portfolio.live' : null;
      error.upstreamStatus = upstreamStatus || null;
      error.upstreamErrorCode = upstreamErrorCode || null;
      error.httpStatus = response.status;
      throw error;
    }
    return payload;
  } catch (error) {
    if (error?.name !== 'AbortError' && Number(error?.code) !== 20) throw error;
    const path = new URL(url).pathname;
    const timeoutError = new Error(
      `${path} did not respond within the bridge input budget.`,
    );
    timeoutError.code = path === '/api/system-readiness'
      ? 'SYSTEM_READINESS_REQUEST_TIMEOUT'
      : path === '/portfolio/live-positions'
        ? 'IBKR_POSITIONS_REQUEST_TIMEOUT'
        : 'HERMES_BRIDGE_INPUT_TIMEOUT';
    timeoutError.blockedBy = path === '/portfolio/live-positions' ? 'portfolio.live' : null;
    timeoutError.upstreamStatus = 'timeout';
    throw timeoutError;
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

function verifyReadiness(readiness) {
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
  return capabilities;
}

function sanitizeRootCauses(readiness) {
  return (readiness.rootCauses || []).slice(0, 24).map(item => ({
    id: item?.id ? boundedDetail(item.id).slice(0, 120) : null,
    errorCode: item?.errorCode ? boundedDetail(item.errorCode).slice(0, 120) : null,
    summary: item?.summary ? boundedDetail(item.summary).slice(0, 300) : null,
    owner: item?.owner ? boundedDetail(item.owner).slice(0, 120) : null,
    affectedCheckIds: Array.isArray(item?.affectedCheckIds)
      ? item.affectedCheckIds.slice(0, 24).map(value => boundedDetail(value).slice(0, 120))
      : [],
    suppressionReason: item?.suppressionReason
      ? boundedDetail(item.suppressionReason).slice(0, 240)
      : null,
    nextRetryAt: item?.nextRetryAt || null,
  }));
}

function buildOperationsSnapshot({ readiness, capturedAt = nowIso() }) {
  verifyReadiness(readiness);
  const rootCauses = sanitizeRootCauses(readiness);
  return {
    hostId: `${HOST_ID}#operations`,
    capturedAt,
    schemaVersion: 2,
    snapshotType: 'operations',
    source: 'local-outbound-bridge',
    bridgeStatus: 'ready',
    buildVersion: BUILD_VERSION,
    readinessCheckedAt: readiness.checkedAt,
    runtime: {
      hostnameHash: accountRef(os.hostname()),
      node: process.version,
      platform: process.platform,
    },
    capabilities: sanitizeCapabilities(readiness),
    rootCauseCodes: Array.from(new Set(
      rootCauses.map(item => item.errorCode).filter(Boolean),
    )).slice(0, 24),
    rootCauses,
    manualActions: (readiness.manualActions || []).slice(0, 24).map(item => ({
      id: item?.id ? boundedDetail(item.id).slice(0, 120) : null,
      label: item?.label ? boundedDetail(item.label).slice(0, 300) : null,
      owner: item?.owner ? boundedDetail(item.owner).slice(0, 120) : null,
      approvalRequired: item?.approvalRequired !== false,
      rootCauseIds: Array.isArray(item?.rootCauseIds)
        ? item.rootCauseIds.slice(0, 24).map(value => boundedDetail(value).slice(0, 120))
        : [],
    })),
    hostResources: {
      checks: (readiness.groups || [])
        .find(group => group?.id === 'host')?.checks?.slice(0, 12)
        .map(check => ({
          id: check?.id || null,
          status: check?.status || 'fail',
          errorCode: check?.errorCode || null,
          summary: check?.summary ? boundedDetail(check.summary).slice(0, 300) : null,
          observedAt: check?.observedAt || null,
        })) || [],
    },
    controller: readiness.controller && typeof readiness.controller === 'object'
      ? {
        available: readiness.controller.available === true,
        mode: readiness.controller.mode || null,
        status: readiness.controller.status || null,
        observedAt: readiness.controller.observedAt || null,
        nextRetryAt: readiness.controller.nextRetryAt || null,
        circuitCount: Array.isArray(readiness.controller.circuits)
          ? readiness.controller.circuits.length
          : 0,
      }
      : null,
    incidentHistory: (readiness.incidentHistory || []).slice(-20).map(item => ({
      id: item?.id || item?.incidentId || null,
      rootCause: item?.rootCause || item?.errorCode || null,
      status: item?.status || null,
      openedAt: item?.openedAt || null,
      resolvedAt: item?.resolvedAt || null,
    })),
    actionHistory: (readiness.actionHistory || []).slice(-20).map(item => ({
      id: item?.id || item?.actionId || null,
      incidentId: item?.incidentId || null,
      actionId: item?.actionId || null,
      status: item?.status || null,
      startedAt: item?.startedAt || null,
      finishedAt: item?.finishedAt || null,
      verification: item?.verification || null,
    })),
    suppressionReasons: (readiness.suppressionReasons || []).slice(-40).map(item => ({
      checkId: item?.checkId || null,
      errorCode: item?.errorCode || null,
      suppressedBy: Array.isArray(item?.suppressedBy) ? item.suppressedBy.slice(0, 12) : [],
      reason: item?.reason ? boundedDetail(item.reason).slice(0, 300) : null,
    })),
    ttl: ttlEpoch(),
  };
}

function verifyPortfolio({ portfolio, readiness }) {
  const capabilities = verifyReadiness(readiness);
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
  const positionsObservedAt = portfolio.positions_observed_at;
  if (
    portfolio.from_cache !== false
    || portfolio.position_source !== 'ibkr_req_positions'
    || !positionsObservedAt
    || positionsObservedAt !== observedAt
  ) {
    const error = new Error('IBKR position rows were not returned by a fresh reqPositions response.');
    error.code = 'PORTFOLIO_POSITION_PROVENANCE_UNVERIFIED';
    throw error;
  }
  if (
    ageMs(observedAt) > MAX_INPUT_AGE_MS
    || ageMs(socketVerifiedAt) > MAX_INPUT_AGE_MS
    || ageMs(positionsObservedAt) > MAX_INPUT_AGE_MS
  ) {
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
    positionSource: portfolio.position_source,
  }));
  if (positions.some(position => !position.symbol || !Number.isFinite(position.quantity))) {
    const error = new Error('Portfolio response contains malformed positions.');
    error.code = 'PORTFOLIO_SCHEMA_INVALID';
    throw error;
  }
  return {
    hostId: `${HOST_ID}#portfolio`,
    capturedAt,
    schemaVersion: 2,
    snapshotType: 'portfolio',
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
    capabilities: {
      'portfolio.live': sanitizeCapabilities(readiness)['portfolio.live'],
    },
    portfolio: {
      verified: true,
      source: 'ibkr_live',
      positionSource: portfolio.position_source,
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

function buildDegradedSnapshot(error, capturedAt = nowIso(), snapshotType = 'portfolio') {
  const failure = inputFailure(error);
  const operations = snapshotType === 'operations';
  const snapshot = {
    hostId: `${HOST_ID}#${snapshotType}`,
    capturedAt,
    schemaVersion: 2,
    snapshotType,
    source: 'local-outbound-bridge',
    bridgeStatus: failure.status,
    buildVersion: BUILD_VERSION,
    errorCode: failure.errorCode,
    detail: failure.detail,
    inputErrorCode: failure.errorCode,
    blockedBy: failure.blockedBy,
    upstreamStatus: failure.upstreamStatus,
    gateway: { connected: false },
    capabilities: {},
    manualActions: [],
    ttl: ttlEpoch(),
  };
  if (!operations) {
    snapshot.portfolio = {
      verified: false,
      source: 'unavailable',
      accountsVerified: false,
      positions: [],
    };
  }
  return snapshot;
}

async function putHeartbeat(snapshot, startedAt, {
  client = dynamodb,
  publishProblem = null,
} = {}) {
  const observedAt = nowIso();
  const inputErrorCode = snapshot.bridgeStatus === 'ready'
    ? null
    : (snapshot.inputErrorCode || snapshot.errorCode || 'HERMES_BRIDGE_INPUT_ERROR');
  await client.put({
    TableName: HEARTBEAT_TABLE,
    Item: {
      serviceId: 'bridge:local-dashboard',
      observedAt,
      startedAt,
      finishedAt: observedAt,
      status: inputErrorCode || publishProblem ? 'error' : 'success',
      errorCode: publishProblem?.errorCode || inputErrorCode || null,
      inputErrorCode,
      publishErrorCode: publishProblem?.errorCode || null,
      publishStage: publishProblem?.stage || null,
      detail: publishProblem?.detail || snapshot.detail || null,
      source: 'local-outbound-bridge',
      buildVersion: BUILD_VERSION,
      awsProfile: BRIDGE_AWS_PROFILE,
      counts: {
        positions: snapshot.portfolio?.positionCount || 0,
        operations: snapshot.snapshotType === 'operations' && snapshot.bridgeStatus === 'ready' ? 1 : 0,
      },
      ttl: ttlEpoch(),
    },
  }).promise();
}

async function publishBridgeSnapshot(snapshot, startedAt, {
  client = dynamodb,
} = {}) {
  const failures = [];
  let snapshotPublished = false;
  let heartbeatPublished = false;

  try {
    await client.put({ TableName: SNAPSHOT_TABLE, Item: snapshot }).promise();
    snapshotPublished = true;
  } catch (error) {
    failures.push(publishFailure(error, 'snapshot'));
  }

  try {
    await putHeartbeat(snapshot, startedAt, {
      client,
      publishProblem: failures[0] || null,
    });
    heartbeatPublished = true;
  } catch (error) {
    failures.push(publishFailure(error, 'heartbeat'));
  }

  return {
    status: failures.length === 0 ? 'ready' : 'error',
    snapshotPublished,
    heartbeatPublished,
    failures,
  };
}

async function publishBridgeSnapshots(snapshots, startedAt, {
  client = dynamodb,
} = {}) {
  const failures = [];
  const publishedPartitions = {};
  for (const snapshot of snapshots) {
    const partition = snapshot.snapshotType || 'unknown';
    try {
      await client.put({ TableName: SNAPSHOT_TABLE, Item: snapshot }).promise();
      publishedPartitions[partition] = true;
    } catch (error) {
      failures.push(publishFailure(error, `snapshot:${partition}`));
      publishedPartitions[partition] = false;
    }
  }

  const operations = snapshots.find(snapshot => snapshot.snapshotType === 'operations');
  const portfolio = snapshots.find(snapshot => snapshot.snapshotType === 'portfolio');
  const inputFailureSnapshot = [operations, portfolio]
    .find(snapshot => snapshot?.bridgeStatus !== 'ready');
  const heartbeatSnapshot = {
    ...(inputFailureSnapshot || operations || portfolio),
    bridgeStatus: inputFailureSnapshot ? 'error' : 'ready',
    inputErrorCode: inputFailureSnapshot?.inputErrorCode || inputFailureSnapshot?.errorCode || null,
    detail: inputFailureSnapshot?.detail || null,
    portfolio: portfolio?.portfolio || null,
    snapshotType: 'operations',
  };
  let heartbeatPublished = false;
  try {
    await putHeartbeat(heartbeatSnapshot, startedAt, {
      client,
      publishProblem: failures[0] || null,
    });
    heartbeatPublished = true;
  } catch (error) {
    failures.push(publishFailure(error, 'heartbeat'));
  }

  return {
    status: failures.length === 0 ? 'ready' : 'error',
    snapshotPublished: Object.values(publishedPartitions).every(Boolean),
    operationsPublished: publishedPartitions.operations === true,
    portfolioPublished: publishedPartitions.portfolio === true,
    heartbeatPublished,
    publishedPartitions,
    failures,
  };
}

function buildBridgeResult(snapshot, published) {
  const inputErrorCode = snapshot.bridgeStatus === 'ready'
    ? null
    : (snapshot.inputErrorCode || snapshot.errorCode || 'HERMES_BRIDGE_INPUT_ERROR');
  const primaryPublishFailure = published.failures[0] || null;
  const publishErrorCode = primaryPublishFailure?.errorCode || null;
  const status = inputErrorCode || publishErrorCode ? 'error' : 'ready';
  const publishStages = published.failures.map(item => item.stage);
  return {
    observedAt: snapshot.capturedAt,
    status,
    errorCode: publishErrorCode || inputErrorCode || null,
    inputErrorCode,
    publishErrorCode,
    publishStage: publishStages.length > 0 ? publishStages.join(',') : null,
    detail: primaryPublishFailure?.detail || snapshot.detail || null,
    positions: snapshot.portfolio?.positionCount || 0,
    awsProfile: BRIDGE_AWS_PROFILE,
    input: {
      status: inputErrorCode ? 'error' : 'ready',
      errorCode: inputErrorCode,
      detail: inputErrorCode ? snapshot.detail || null : null,
    },
    publish: {
      status: publishErrorCode ? 'error' : 'ready',
      errorCode: publishErrorCode,
      stage: publishStages.length > 0 ? publishStages.join(',') : null,
      detail: primaryPublishFailure?.detail || null,
      snapshotPublished: published.snapshotPublished,
      heartbeatPublished: published.heartbeatPublished,
      failures: published.failures,
    },
  };
}

async function captureAndPublish({
  client = dynamodb,
  readJson = getJson,
  env = process.env,
} = {}) {
  const startedAt = nowIso();
  const partitions = bridgePartitions(env);
  if (!partitions.operations && !partitions.portfolio) {
    const error = new Error('No outbound bridge partition is enabled.');
    error.code = 'HERMES_BRIDGE_DISABLED';
    throw error;
  }
  const [portfolioResult, readinessResult] = await Promise.allSettled([
    partitions.portfolio
      ? readJson(`${SIDECAR_BASE}/portfolio/live-positions`)
      : Promise.resolve(null),
    readJson(`${API_BASE}/api/system-readiness`),
  ]);
  let operationsSnapshot;
  if (readinessResult.status === 'fulfilled') {
    try {
      operationsSnapshot = buildOperationsSnapshot({ readiness: readinessResult.value });
    } catch (error) {
      operationsSnapshot = buildDegradedSnapshot(error, nowIso(), 'operations');
    }
  } else {
    operationsSnapshot = buildDegradedSnapshot(readinessResult.reason, nowIso(), 'operations');
  }

  let portfolioSnapshot;
  if (readinessResult.status === 'fulfilled' && portfolioResult.status === 'fulfilled') {
    try {
      portfolioSnapshot = buildReadySnapshot({
        portfolio: portfolioResult.value,
        readiness: readinessResult.value,
      });
    } catch (error) {
      portfolioSnapshot = buildDegradedSnapshot(error);
    }
  } else {
    portfolioSnapshot = buildDegradedSnapshot(
      portfolioResult.status === 'rejected'
        ? portfolioResult.reason
        : readinessResult.reason,
    );
  }

  const snapshots = [
    ...(partitions.operations ? [operationsSnapshot] : []),
    ...(partitions.portfolio ? [portfolioSnapshot] : []),
  ];
  const published = await publishBridgeSnapshots(snapshots, startedAt, { client });
  const snapshot = partitions.portfolio ? portfolioSnapshot : operationsSnapshot;
  return {
    snapshot,
    snapshots: {
      operations: operationsSnapshot,
      portfolio: portfolioSnapshot,
    },
    published,
    result: {
      ...buildBridgeResult(snapshot, published),
      operations: {
        status: partitions.operations ? operationsSnapshot.bridgeStatus : 'disabled',
        errorCode: partitions.operations ? operationsSnapshot.errorCode || null : null,
        published: published.operationsPublished,
      },
      portfolio: {
        status: partitions.portfolio ? portfolioSnapshot.bridgeStatus : 'disabled',
        errorCode: partitions.portfolio ? portfolioSnapshot.errorCode || null : null,
        published: published.portfolioPublished,
      },
    },
  };
}

function writeBridgeResult(result) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function runBridge({
  env = process.env,
  onceMode = once,
  capture = captureAndPublish,
  writeResult = writeBridgeResult,
  wait = (delayMs) => new Promise(resolve => setTimeout(resolve, delayMs)),
  installSignalHandlers = true,
} = {}) {
  if (!hermesBridgeEnabled(env)) {
    const result = {
      observedAt: nowIso(),
      status: 'disabled',
      errorCode: null,
      inputErrorCode: null,
      publishErrorCode: null,
      publishStage: null,
      detail: 'Outbound operations and verified-live portfolio publishing are disabled by the partition controls.',
      positions: 0,
      awsProfile: null,
      input: {
        status: 'disabled',
        errorCode: null,
        detail: null,
      },
      publish: {
        status: 'disabled',
        errorCode: null,
        stage: null,
        detail: null,
        snapshotPublished: false,
        heartbeatPublished: false,
        failures: [],
      },
    };
    writeResult(result);
    return result;
  }
  if (onceMode) {
    const outcome = await capture({ env });
    writeResult(outcome.result);
    return outcome.result;
  }
  let stopping = false;
  const stop = () => { stopping = true; };
  if (installSignalHandlers) {
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  }
  while (!stopping) {
    try {
      const outcome = await capture({ env });
      writeResult(outcome.result);
    } catch (error) {
      writeResult({
        observedAt: nowIso(),
        status: 'error',
        errorCode: error?.code || 'HERMES_BRIDGE_RUNTIME_ERROR',
        inputErrorCode: error?.code || 'HERMES_BRIDGE_RUNTIME_ERROR',
        publishErrorCode: null,
        publishStage: null,
        detail: boundedDetail(error),
        positions: 0,
        awsProfile: BRIDGE_AWS_PROFILE,
        input: inputFailure(error),
        publish: {
          status: 'unknown',
          errorCode: null,
          stage: null,
          detail: null,
          snapshotPublished: false,
          heartbeatPublished: false,
          failures: [],
        },
      });
    }
    if (stopping) break;
    await wait(INTERVAL_MS);
  }
  return null;
}

async function main() {
  const result = await runBridge();
  if (once || result?.status === 'disabled') {
    process.exitCode = ['ready', 'disabled'].includes(result?.status) ? 0 : 2;
  }
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`[hermes-bridge] fatal: ${boundedDetail(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  BRIDGE_AWS_PROFILE,
  PROHIBITED_PROVENANCE,
  EXPECTED_CAPABILITY_IDS,
  accountRef,
  assertLoopbackBase,
  buildBridgeResult,
  bridgePartitions,
  buildDegradedSnapshot,
  buildOperationsSnapshot,
  buildReadySnapshot,
  captureAndPublish,
  capabilityIsReady,
  hermesBridgeEnabled,
  getJson,
  inputFailure,
  publishBridgeSnapshot,
  publishBridgeSnapshots,
  publishFailure,
  publishErrorCode,
  putHeartbeat,
  readinessCapabilities,
  runBridge,
  sanitizeCapabilities,
  verifyReadiness,
  verifyPortfolio,
};
