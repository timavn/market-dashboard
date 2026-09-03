const path = require('node:path');
const { spawn: defaultSpawn } = require('node:child_process');

const STATUS = Object.freeze({
  ONLINE: 'online',
  OFFLINE: 'offline',
  ATTENTION: 'attention',
  CLOSED: 'closed',
  UNKNOWN: 'unknown',
});

const LOGIN_ACTION_STATES = Object.freeze({
  IDLE: 'idle',
  AWAITING_USER: 'awaiting_user',
  VERIFYING: 'verifying',
  READY: 'ready',
  FAILED: 'failed',
});

const ACTIVE_LOGIN_ACTION_STATES = new Set([
  LOGIN_ACTION_STATES.AWAITING_USER,
  LOGIN_ACTION_STATES.VERIFYING,
]);

const LOGIN_ACTION_ERROR_CODES = new Set([
  'LOGIN_ACTION_START_FAILED',
  'LOGIN_ACTION_START_TIMEOUT',
  'LOGIN_ACTION_PROCESS_FAILED',
  'LOGIN_ACTION_PROCESS_EXITED',
  'LOGIN_ACTION_VERIFICATION_TIMEOUT',
  'LOGIN_ACTION_IN_PROGRESS',
  'IBKR_GATEWAY_OPEN_FAILED',
  'IBKR_GATEWAY_DISCONNECTED',
  'IBKR_SOCKET_DISABLED',
  'IBKR_VERIFICATION_TIMEOUT',
  'AWS_SSO_LOGIN_CANCELLED',
  'AWS_SSO_LOGIN_FAILED',
  'AWS_ADMIN_LOGIN_REQUIRED',
  'AWS_PROFILE_WRONG_PRINCIPAL',
  'AWS_PROFILE_ENVIRONMENT_OVERRIDE',
  'AWS_AUTHORIZATION_DENIED',
  'AWS_SERVICE_UNAVAILABLE',
]);

const LOGIN_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: 'ibkr-gateway',
    label: 'IBKR Gateway',
    summary: 'Brokerage + prediction markets',
    required: true,
  }),
  Object.freeze({
    id: 'gmail-oauth',
    label: 'Gmail OAuth',
    summary: 'Hedgeye inbox authorization',
    required: true,
  }),
  Object.freeze({
    id: 'aws-admin',
    label: 'AWS Admin',
    summary: 'Operator SSO session',
    required: false,
  }),
  Object.freeze({
    id: 'aws-api',
    label: 'AWS API',
    summary: 'Dashboard cloud reads',
    required: true,
  }),
  Object.freeze({
    id: 'aws-bridge',
    label: 'AWS Bridge',
    summary: 'Outbound snapshot publishing',
    required: false,
  }),
]);

const LOGIN_DEFINITION_BY_ID = new Map(
  LOGIN_DEFINITIONS.map((definition) => [definition.id, definition]),
);

const AWS_PROFILE_TARGETS = Object.freeze([
  Object.freeze({ id: 'aws-api', purpose: 'api', profile: 'market-dashboard-local' }),
  Object.freeze({ id: 'aws-bridge', purpose: 'bridge', profile: 'market-dashboard-bridge' }),
  Object.freeze({ id: 'aws-admin', purpose: 'admin', profile: 'market-dashboard-admin' }),
]);

const DEFAULT_FAST_INTERVAL_MS = 60_000;
const DEFAULT_SLOW_INTERVAL_MS = 5 * 60_000;
const DEFAULT_IBKR_MAX_AGE_MS = 90_000;
const DEFAULT_GMAIL_MAX_AGE_MS = 45 * 60_000;
// A cold AWS CLI/SSO cache can take several seconds because one preflight
// validates the provider, refreshable expiration, and caller identity. Keep
// that bounded, but leave enough headroom for the three independent profiles
// to be checked during one login-status collection.
const DEFAULT_AWS_PROBE_TIMEOUT_MS = 15_000;
const DEFAULT_FAST_PROBE_TIMEOUT_MS = 5_000;
const DEFAULT_SLOW_PROBE_TIMEOUT_MS = 20_000;
const DEFAULT_ACTION_TIMEOUT_MS = 5 * 60_000;
const MAX_FUTURE_CLOCK_SKEW_MS = 30_000;
const MAX_CAPTURE_BYTES = 64 * 1024;
const IB_GATEWAY_BUNDLE_ID = 'com.install4j.5556-0173-2910-4500.22';

const RECOVERY = Object.freeze({
  ibkr: Object.freeze({
    kind: 'local-action',
    actionId: 'open-ibkr-gateway',
    label: 'Open IB Gateway',
  }),
  gmail: Object.freeze({
    kind: 'local-action',
    actionId: 'open-gmail-guide',
    label: 'Open Gmail recovery guide',
  }),
  awsAdmin: Object.freeze({
    kind: 'local-action',
    actionId: 'aws-admin-login',
    label: 'Refresh AWS SSO',
  }),
  awsGuide: Object.freeze({
    kind: 'local-action',
    actionId: 'open-aws-guide',
    label: 'Open AWS credential guide',
  }),
});

const AWS_CREDENTIAL_ENVIRONMENT_KEYS = Object.freeze([
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_SECURITY_TOKEN',
  'AWS_ROLE_ARN',
  'AWS_ROLE_SESSION_NAME',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_CONFIG_FILE',
]);

function safeNow(nowProvider = () => new Date()) {
  try {
    const value = nowProvider();
    const parsed = value instanceof Date ? value : new Date(value);
    if (Number.isFinite(parsed.getTime())) return parsed;
  } catch (_error) {
    // Status collection must remain available even when an injected clock fails.
  }
  return new Date();
}

function safeIso(value) {
  const parsed = value instanceof Date ? value : new Date(value || '');
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function boundedProbe(operation, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (handler, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      handler(value);
    };
    const timer = setTimeout(() => {
      const error = new Error('Login probe timed out.');
      error.code = 'LOGIN_PROBE_TIMEOUT';
      finish(reject, error);
    }, Math.max(100, Number(timeoutMs) || DEFAULT_FAST_PROBE_TIMEOUT_MS));
    timer.unref?.();
    Promise.resolve()
      .then(operation)
      .then((value) => finish(resolve, value))
      .catch((error) => finish(reject, error));
  });
}

function timestampIsFresh(value, now, maxAgeMs) {
  const observedAt = Date.parse(String(value || ''));
  if (!Number.isFinite(observedAt)) return false;
  const ageMs = now.getTime() - observedAt;
  return ageMs >= -MAX_FUTURE_CLOCK_SKEW_MS && ageMs <= maxAgeMs;
}

function safeReason(value, fallback = 'Login status could not be verified.') {
  let result = String(value || fallback || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  result = result
    .replace(/(?:client[_-]?secret|(?:client|refresh|access|session)[_-]?token|password|authorization)\s*[=:]\s*[^\s,;}]+/gi, '[REDACTED]')
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{12,}\b/g, '[REDACTED]')
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, '[REDACTED]');
  return (result || fallback).slice(0, 180);
}

function enabledFlag(value) {
  return new Set(['1', 'true', 'yes', 'on', 'enabled'])
    .has(String(value || '').trim().toLowerCase());
}

function bridgeIsEnabled(env = process.env) {
  const legacy = enabledFlag(env.HERMES_BRIDGE_ENABLED);
  const partition = (name) => (
    Object.prototype.hasOwnProperty.call(env, name)
      ? enabledFlag(env[name])
      : legacy
  );
  return partition('HERMES_OPERATIONS_BRIDGE_ENABLED')
    || partition('HERMES_PORTFOLIO_BRIDGE_ENABLED');
}

function loginDetail(id, {
  status = STATUS.UNKNOWN,
  state = 'unverified',
  required,
  checkedAt,
  verifiedAt = null,
  expiresAt = null,
  reason = null,
  recovery = null,
} = {}) {
  const definition = LOGIN_DEFINITION_BY_ID.get(id);
  if (!definition) throw new Error(`Unknown login definition: ${id}`);
  const normalizedStatus = Object.values(STATUS).includes(status) ? status : STATUS.UNKNOWN;
  const normalizedState = String(state || 'unverified').slice(0, 40);
  const signedOutReference = normalizedStatus === STATUS.CLOSED && normalizedState === 'signed_out';
  const result = {
    id: definition.id,
    label: definition.label,
    summary: definition.summary,
    status: normalizedStatus,
    state: normalizedState,
    required: required ?? definition.required,
    checkedAt: safeIso(checkedAt),
    verifiedAt: safeIso(verifiedAt),
    expiresAt: safeIso(expiresAt),
    reason: normalizedStatus !== STATUS.ONLINE
      && (normalizedStatus !== STATUS.CLOSED || signedOutReference)
      ? safeReason(reason)
      : null,
    recovery: recovery && normalizedStatus !== STATUS.ONLINE
      && (normalizedStatus !== STATUS.CLOSED || signedOutReference)
      ? { ...recovery }
      : null,
  };
  return result;
}

function unknownLogin(id, checkedAt, options = {}) {
  return loginDetail(id, {
    ...options,
    status: STATUS.UNKNOWN,
    state: options.state || 'unverified',
    checkedAt,
    reason: options.reason || 'Login status could not be verified.',
  });
}

function evaluateIbkrLogin(evidence, {
  now = new Date(),
  maxAgeMs = DEFAULT_IBKR_MAX_AGE_MS,
} = {}) {
  const checkedAt = safeNow(() => now);
  if (!evidence || typeof evidence !== 'object') {
    return unknownLogin('ibkr-gateway', checkedAt, {
      reason: 'IBKR Gateway status is unavailable.',
      recovery: RECOVERY.ibkr,
    });
  }
  const evidenceStatus = String(evidence.status || '').trim().toLowerCase();
  const socketDisabled = evidence.api_socket_enabled === false
    || evidence.socket_enabled === false
    || evidence.api_enabled === false
    || ['api_disabled', 'socket_disabled', 'disabled'].includes(evidenceStatus)
    || ['IBKR_SOCKET_DISABLED', 'API_SOCKET_DISABLED'].includes(
      String(evidence.error_code || evidence.errorCode || '').trim().toUpperCase(),
    );
  if (socketDisabled) {
    return loginDetail('ibkr-gateway', {
      status: STATUS.OFFLINE,
      state: 'socket_disabled',
      checkedAt,
      verifiedAt: evidence.time || evidence.observedAt,
      reason: 'IBKR Gateway API socket is disabled; enable socket API access in Gateway settings.',
      recovery: RECOVERY.ibkr,
    });
  }
  if (evidence.connected === false) {
    const sidecarUnavailable = ['sidecar_offline', 'sidecar_unresponsive', 'sidecar_unavailable']
      .includes(evidenceStatus);
    return loginDetail('ibkr-gateway', {
      status: STATUS.OFFLINE,
      state: sidecarUnavailable ? 'sidecar_unavailable' : 'disconnected',
      checkedAt,
      reason: sidecarUnavailable
        ? 'The IBKR sidecar is unavailable, so the Gateway session cannot be verified.'
        : 'IB Gateway is not authenticated.',
      recovery: RECOVERY.ibkr,
    });
  }
  if (evidence.connected !== true) {
    return unknownLogin('ibkr-gateway', checkedAt, {
      reason: 'IBKR Gateway authentication is unverified.',
      recovery: RECOVERY.ibkr,
    });
  }
  const accounts = Array.isArray(evidence.accounts) ? evidence.accounts.filter(Boolean) : [];
  if (evidence.account_discovery_ok === false || accounts.length === 0) {
    return loginDetail('ibkr-gateway', {
      status: STATUS.OFFLINE,
      state: 'invalid',
      checkedAt,
      verifiedAt: evidence.time || evidence.observedAt,
      reason: 'IB Gateway returned no authorized managed accounts.',
      recovery: RECOVERY.ibkr,
    });
  }
  const observedAt = evidence.time || evidence.observedAt;
  if (!timestampIsFresh(observedAt, checkedAt, maxAgeMs)) {
    return unknownLogin('ibkr-gateway', checkedAt, {
      state: 'stale',
      verifiedAt: observedAt,
      reason: 'The IBKR authentication check is stale.',
      recovery: RECOVERY.ibkr,
    });
  }
  if (!['connected', 'ready'].includes(evidenceStatus)) {
    return unknownLogin('ibkr-gateway', checkedAt, {
      verifiedAt: observedAt,
      reason: 'IBKR Gateway returned an unverified session state.',
      recovery: RECOVERY.ibkr,
    });
  }
  return loginDetail('ibkr-gateway', {
    status: STATUS.ONLINE,
    state: 'connected',
    checkedAt,
    verifiedAt: observedAt,
  });
}

function evaluateGmailLogin(store, {
  account,
  scheduleId,
  now = new Date(),
  maxAgeMs = DEFAULT_GMAIL_MAX_AGE_MS,
} = {}) {
  const checkedAt = safeNow(() => now);
  const normalizedAccount = String(account || '').trim().toLowerCase();
  const serviceId = `gmail:${normalizedAccount}`;
  const base = {
    checkedAt,
    recovery: RECOVERY.gmail,
  };
  if (store?.available !== true) {
    return unknownLogin('gmail-oauth', checkedAt, {
      ...base,
      reason: 'The Gmail authentication heartbeat could not be read.',
    });
  }
  const heartbeat = store.heartbeat;
  if (store.found !== true || !heartbeat || typeof heartbeat !== 'object') {
    return unknownLogin('gmail-oauth', checkedAt, {
      ...base,
      reason: 'No scheduled Gmail authentication proof was found.',
    });
  }
  const provenanceVerified = heartbeat.serviceId === serviceId
    && heartbeat.source === 'aws-lambda'
    && heartbeat.triggerSource === 'aws-scheduler'
    && heartbeat.scheduled === true
    && heartbeat.scheduleId === scheduleId;
  if (!provenanceVerified) {
    return unknownLogin('gmail-oauth', checkedAt, {
      ...base,
      verifiedAt: heartbeat.authVerifiedAt || heartbeat.finishedAt || heartbeat.observedAt,
      reason: 'The Gmail authentication proof did not come from the owned scheduler.',
    });
  }

  const heartbeatStatus = String(heartbeat.status || '').trim().toLowerCase();
  const errorCode = String(heartbeat.errorCode || '').trim().toUpperCase();
  const explicitAuthFailure = heartbeatStatus === 'auth_required'
    || [
      'GMAIL_AUTH_REQUIRED',
      'GMAIL_OAUTH_CLIENT_DISABLED',
      'GMAIL_SCOPE_INSUFFICIENT',
      'GMAIL_SECRET_INVALID',
      'GMAIL_ACCOUNT_MISMATCH',
    ].includes(errorCode);
  if (explicitAuthFailure) {
    return loginDetail('gmail-oauth', {
      ...base,
      status: STATUS.OFFLINE,
      state: 'expired',
      verifiedAt: heartbeat.authVerifiedAt || null,
      reason: errorCode === 'GMAIL_ACCOUNT_MISMATCH'
        ? 'Gmail authorization is bound to the wrong account.'
        : 'Gmail OAuth authorization requires attention.',
    });
  }

  // New builds publish authVerifiedAt even when later ingestion work fails.
  // A legacy scheduled success is also proof because that handler could only
  // succeed after refreshing OAuth and reading users.getProfile.
  const proofAt = heartbeat.authVerifiedAt
    || (heartbeatStatus === 'success'
      ? (heartbeat.finishedAt || heartbeat.observedAt)
      : null);
  if (!proofAt) {
    return unknownLogin('gmail-oauth', checkedAt, {
      ...base,
      reason: 'The latest Gmail run did not contain a successful authentication proof.',
    });
  }
  if (!timestampIsFresh(proofAt, checkedAt, maxAgeMs)) {
    return unknownLogin('gmail-oauth', checkedAt, {
      ...base,
      state: 'stale',
      verifiedAt: proofAt,
      reason: 'The last successful Gmail authentication proof is stale.',
    });
  }
  return loginDetail('gmail-oauth', {
    ...base,
    status: STATUS.ONLINE,
    state: 'fresh',
    verifiedAt: proofAt,
  });
}

function awsFailureReason(purpose, errorCode) {
  const label = purpose === 'admin'
    ? 'AWS Admin SSO'
    : purpose === 'bridge' ? 'AWS Bridge credentials' : 'AWS API credentials';
  if (errorCode === 'AWS_PROFILE_EXPIRING_SOON') return `${label} expire in less than 15 minutes.`;
  if (errorCode === 'AWS_PROFILE_EXPIRED') {
    return purpose === 'admin'
      ? 'AWS Admin SSO session has expired; refresh it before operator changes.'
      : `${label} credentials have expired.`;
  }
  if (errorCode === 'AWS_PROFILE_WRONG_PRINCIPAL') return `${label} resolve to the wrong AWS principal.`;
  if (errorCode === 'AWS_PROFILE_ENVIRONMENT_OVERRIDE') return `${label} are being overridden by the shell environment.`;
  if (errorCode === 'AWS_PROFILE_STATIC_SESSION_REJECTED') return `${label} use an unsupported copied session token.`;
  if (errorCode === 'AWS_AUTHORIZATION_DENIED') {
    return `${label} is authenticated, but the approved principal is not authorized for this operation.`;
  }
  if (errorCode === 'AWS_PROFILE_PROVIDER_INVALID') return `${label} use an unsupported credential provider.`;
  if (errorCode === 'AWS_CLI_UNAVAILABLE') return 'AWS CLI is unavailable, so login status cannot be verified.';
  if (errorCode === 'AWS_PROFILE_CHECK_TIMEOUT') return `${label} could not be verified before the timeout.`;
  return `${label} could not be verified.`;
}

function evaluateAwsLogin(result, target, {
  now = new Date(),
  bridgeEnabled = true,
} = {}) {
  const checkedAt = safeNow(() => now);
  const definition = LOGIN_DEFINITION_BY_ID.get(target.id);
  const required = target.purpose === 'bridge' ? bridgeEnabled : definition.required;
  const recovery = target.purpose === 'admin' ? RECOVERY.awsAdmin : RECOVERY.awsGuide;
  if (target.purpose === 'bridge' && !bridgeEnabled) {
    return loginDetail(target.id, {
      status: STATUS.CLOSED,
      state: 'disabled',
      required: false,
      checkedAt,
    });
  }
  const expiresAt = safeIso(result?.expiresAt);
  if (result?.ok === true) {
    if (expiresAt && Date.parse(expiresAt) - checkedAt.getTime() < 15 * 60_000) {
      return loginDetail(target.id, {
        status: STATUS.ATTENTION,
        state: 'expiring',
        required,
        checkedAt,
        verifiedAt: checkedAt,
        expiresAt,
        reason: awsFailureReason(target.purpose, 'AWS_PROFILE_EXPIRING_SOON'),
        recovery,
      });
    }
    return loginDetail(target.id, {
      status: STATUS.ONLINE,
      state: 'fresh',
      required,
      checkedAt,
      verifiedAt: checkedAt,
      expiresAt,
    });
  }
  const errorCode = String(result?.errorCode || 'AWS_PROFILE_UNUSABLE');
  if (target.purpose === 'admin' && errorCode === 'AWS_PROFILE_EXPIRED') {
    return loginDetail(target.id, {
      status: STATUS.CLOSED,
      state: 'signed_out',
      required: false,
      checkedAt,
      expiresAt,
      reason: awsFailureReason(target.purpose, errorCode),
      recovery,
    });
  }
  if (errorCode === 'AWS_PROFILE_EXPIRING_SOON') {
    return loginDetail(target.id, {
      status: STATUS.ATTENTION,
      state: 'expiring',
      required,
      checkedAt,
      expiresAt,
      reason: awsFailureReason(target.purpose, errorCode),
      recovery,
    });
  }
  const unverified = [
    'AWS_CLI_UNAVAILABLE',
    'AWS_PROFILE_EXPIRATION_UNVERIFIED',
    'AWS_PROFILE_CHECK_TIMEOUT',
    'AWS_PROFILE_RESPONSE_INVALID',
    'AWS_PROFILE_UNUSABLE',
  ].includes(errorCode);
  return loginDetail(target.id, {
    status: unverified ? STATUS.UNKNOWN : STATUS.OFFLINE,
    state: errorCode === 'AWS_PROFILE_EXPIRED'
      ? 'expired'
        : errorCode === 'AWS_PROFILE_WRONG_PRINCIPAL'
          ? 'wrong_principal'
          : errorCode === 'AWS_PROFILE_ENVIRONMENT_OVERRIDE'
            ? 'environment_override'
          : errorCode === 'AWS_AUTHORIZATION_DENIED'
          ? 'forbidden'
          : (unverified ? 'unverified' : 'invalid'),
    required,
    checkedAt,
    expiresAt,
    reason: awsFailureReason(target.purpose, errorCode),
    recovery,
  });
}

function aggregateLoginStatus(details) {
  const requiredDetails = details.filter((detail) => detail.required);
  if (requiredDetails.some((detail) => detail.status === STATUS.OFFLINE)) {
    return STATUS.OFFLINE;
  }
  if (requiredDetails.some((detail) => detail.status === STATUS.UNKNOWN)) {
    return STATUS.UNKNOWN;
  }
  if (requiredDetails.some((detail) => ![STATUS.ONLINE, STATUS.CLOSED].includes(detail.status))) {
    return STATUS.ATTENTION;
  }
  return STATUS.ONLINE;
}

function buildLoginReport(details, now) {
  const checkedAt = safeNow(() => now).toISOString();
  const status = aggregateLoginStatus(details);
  return {
    version: 1,
    checkedAt,
    service: {
      id: 'logins',
      label: 'Logins',
      summary: 'Sessions + API credentials',
      status,
      details,
      ...(status === STATUS.ONLINE ? {} : {
        reason: 'One or more login checks require attention.',
      }),
    },
  };
}

function sanitizedChildEnvironment(inherited = process.env) {
  const environment = { ...inherited };
  for (const key of AWS_CREDENTIAL_ENVIRONMENT_KEYS) delete environment[key];
  delete environment.AWS_PROFILE;
  delete environment.AWS_DEFAULT_PROFILE;
  environment.AWS_PAGER = '';
  environment.AWS_CLI_AUTO_PROMPT = 'off';
  environment.AWS_EC2_METADATA_DISABLED = 'true';
  return environment;
}

function createAwsProfileProbe({
  repoRoot = path.resolve(__dirname, '../..'),
  spawnProcess = defaultSpawn,
  inheritedEnvironment = process.env,
  timeoutMs = DEFAULT_AWS_PROBE_TIMEOUT_MS,
} = {}) {
  const scriptPath = path.join(repoRoot, 'scripts/ops/aws_profile_preflight.js');
  return (target) => new Promise((resolve) => {
    let child;
    let stdout = '';
    let settled = false;
    let timer;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    try {
      child = spawnProcess(process.execPath, [
        scriptPath,
        '--purpose', target.purpose,
        '--profile', target.profile,
        '--json',
      ], {
        cwd: repoRoot,
        env: sanitizedChildEnvironment(inheritedEnvironment),
        shell: false,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch (_error) {
      finish({ ok: false, errorCode: 'AWS_PROFILE_UNUSABLE' });
      return;
    }
    child.stdout?.on('data', (chunk) => {
      if (Buffer.byteLength(stdout, 'utf8') >= MAX_CAPTURE_BYTES) return;
      stdout += String(chunk || '').slice(0, MAX_CAPTURE_BYTES);
    });
    child.once('error', () => finish({ ok: false, errorCode: 'AWS_PROFILE_UNUSABLE' }));
    child.once('close', (exitCode) => {
      let parsed;
      try {
        parsed = JSON.parse(stdout);
      } catch (_error) {
        finish({ ok: false, errorCode: 'AWS_PROFILE_RESPONSE_INVALID' });
        return;
      }
      finish({
        ok: exitCode === 0 && parsed?.ok === true,
        errorCode: parsed?.errorCode || (exitCode === 0 ? null : 'AWS_PROFILE_UNUSABLE'),
        expiresAt: safeIso(parsed?.expiresAt),
      });
    });
    if (settled) return;
    timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch (_error) {}
      finish({ ok: false, errorCode: 'AWS_PROFILE_CHECK_TIMEOUT' });
    }, Math.max(100, Number(timeoutMs) || DEFAULT_AWS_PROBE_TIMEOUT_MS));
    timer.unref?.();
  });
}

function createLoginStatusService({
  readIbkr,
  readGmail,
  readAwsProfile,
  env = process.env,
  now = () => new Date(),
  fastIntervalMs = DEFAULT_FAST_INTERVAL_MS,
  slowIntervalMs = DEFAULT_SLOW_INTERVAL_MS,
  fastProbeTimeoutMs = DEFAULT_FAST_PROBE_TIMEOUT_MS,
  slowProbeTimeoutMs = DEFAULT_SLOW_PROBE_TIMEOUT_MS,
  gmailAccount = env.HERMES_GMAIL_ACCOUNT || 'timsmithaviation@gmail.com',
  gmailScheduleId = env.HERMES_GMAIL_SCHEDULE_ID || 'market-dashboard-gmail-v2-every-15m',
} = {}) {
  const detailsById = new Map();
  let fastCheckedAtMs = null;
  let slowCheckedAtMs = null;
  let fastInFlight = null;
  let slowInFlight = null;
  let timer = null;

  const setDetail = (detail) => detailsById.set(detail.id, detail);

  async function refreshFast() {
    if (fastInFlight) return fastInFlight;
    fastInFlight = (async () => {
      const evaluationNow = safeNow(now);
      const [ibkrResult, gmailResult] = await Promise.allSettled([
        typeof readIbkr === 'function'
          ? boundedProbe(readIbkr, fastProbeTimeoutMs)
          : Promise.reject(new Error('unavailable')),
        typeof readGmail === 'function'
          ? boundedProbe(readGmail, fastProbeTimeoutMs)
          : Promise.reject(new Error('unavailable')),
      ]);
      setDetail(ibkrResult.status === 'fulfilled'
        ? evaluateIbkrLogin(ibkrResult.value, { now: evaluationNow })
        : unknownLogin('ibkr-gateway', evaluationNow, {
          reason: ibkrResult.reason?.code === 'LOGIN_PROBE_TIMEOUT'
            ? 'IBKR Gateway authentication could not be verified before the timeout.'
            : 'IBKR Gateway status is unavailable.',
          recovery: RECOVERY.ibkr,
        }));
      setDetail(gmailResult.status === 'fulfilled'
        ? evaluateGmailLogin(gmailResult.value, {
          account: gmailAccount,
          scheduleId: gmailScheduleId,
          now: evaluationNow,
        })
        : unknownLogin('gmail-oauth', evaluationNow, {
          reason: gmailResult.reason?.code === 'LOGIN_PROBE_TIMEOUT'
            ? 'The Gmail authentication heartbeat could not be read before the timeout.'
            : 'The Gmail authentication heartbeat could not be read.',
          recovery: RECOVERY.gmail,
        }));
      fastCheckedAtMs = evaluationNow.getTime();
    })().finally(() => { fastInFlight = null; });
    return fastInFlight;
  }

  async function refreshSlow() {
    if (slowInFlight) return slowInFlight;
    slowInFlight = (async () => {
      const evaluationNow = safeNow(now);
      const bridgeEnabled = bridgeIsEnabled(env);
      const awsPromises = AWS_PROFILE_TARGETS.map((target) => {
        if (target.purpose === 'bridge' && !bridgeEnabled) {
          return Promise.resolve({ skipped: true });
        }
        return typeof readAwsProfile === 'function'
          ? boundedProbe(() => readAwsProfile(target), slowProbeTimeoutMs)
          : Promise.reject(new Error('unavailable'));
      });
      const awsResults = await Promise.allSettled(awsPromises);
      AWS_PROFILE_TARGETS.forEach((target, index) => {
        const result = awsResults[index];
        setDetail(evaluateAwsLogin(
          result.status === 'fulfilled'
            ? result.value
            : {
              ok: false,
              errorCode: result.reason?.code === 'LOGIN_PROBE_TIMEOUT'
                ? 'AWS_PROFILE_CHECK_TIMEOUT'
                : 'AWS_PROFILE_UNUSABLE',
            },
          target,
          { now: evaluationNow, bridgeEnabled },
        ));
      });
      slowCheckedAtMs = evaluationNow.getTime();
    })().finally(() => { slowInFlight = null; });
    return slowInFlight;
  }

  function report() {
    const reportNow = safeNow(now);
    const bridgeEnabled = bridgeIsEnabled(env);
    const details = LOGIN_DEFINITIONS.map((definition) => {
      const existing = detailsById.get(definition.id);
      if (existing) return existing;
      if (definition.id === 'aws-bridge' && !bridgeEnabled) {
        return evaluateAwsLogin(
          { skipped: true },
          AWS_PROFILE_TARGETS.find((target) => target.id === 'aws-bridge'),
          { now: reportNow, bridgeEnabled },
        );
      }
      const recovery = definition.id === 'ibkr-gateway'
        ? RECOVERY.ibkr
        : definition.id === 'gmail-oauth'
          ? RECOVERY.gmail
          : definition.id === 'aws-admin'
            ? RECOVERY.awsAdmin
            : RECOVERY.awsGuide;
      return unknownLogin(definition.id, reportNow, { recovery });
    });
    return buildLoginReport(details, reportNow);
  }

  async function collect({ force = false, fast = false, slow = false } = {}) {
    const currentMs = safeNow(now).getTime();
    const fastDue = force || fast || !Number.isFinite(fastCheckedAtMs)
      || currentMs - fastCheckedAtMs >= fastIntervalMs;
    const slowDue = force || slow || !Number.isFinite(slowCheckedAtMs)
      || currentMs - slowCheckedAtMs >= slowIntervalMs;
    await Promise.all([
      fastDue ? refreshFast() : Promise.resolve(),
      slowDue ? refreshSlow() : Promise.resolve(),
    ]);
    return report();
  }

  async function start() {
    if (!timer) {
      timer = setInterval(() => {
        collect().catch(() => {});
      }, Math.max(1_000, Number(fastIntervalMs) || DEFAULT_FAST_INTERVAL_MS));
      timer.unref?.();
    }
    return collect({ force: true });
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return {
    collect,
    report,
    start,
    stop,
  };
}

function isLoopbackAddress(address) {
  const normalized = String(address || '').trim().toLowerCase();
  if (normalized === '::1' || normalized === 'localhost') return true;
  const ipv4 = normalized.startsWith('::ffff:') ? normalized.slice(7) : normalized;
  return /^127(?:\.\d{1,3}){3}$/.test(ipv4);
}

function sanitizeLoginActionErrorCode(value) {
  const normalized = String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, '_')
    .slice(0, 64);
  return LOGIN_ACTION_ERROR_CODES.has(normalized) ? normalized : null;
}

function createLoginActionService({
  repoRoot = path.resolve(__dirname, '../..'),
  spawnProcess = defaultSpawn,
  inheritedEnvironment = process.env,
  onSettled = null,
  actionTimeoutMs = DEFAULT_ACTION_TIMEOUT_MS,
} = {}) {
  const actions = new Map([
    ['open-ibkr-gateway', {
      label: 'Open IB Gateway',
      file: '/usr/bin/open',
      args: ['-b', IB_GATEWAY_BUNDLE_ID],
      timeoutMs: 15_000,
      verificationId: 'ibkr-gateway',
    }],
    ['aws-admin-login', {
      label: 'Refresh AWS SSO',
      file: 'aws',
      args: ['sso', 'login', '--profile', 'market-dashboard-admin'],
      prepare: {
        file: 'aws',
        args: ['sso', 'logout'],
      },
      timeoutMs: actionTimeoutMs,
      awsEnvironment: true,
      verificationId: 'aws-admin',
    }],
    ['open-gmail-guide', {
      label: 'Open Gmail recovery guide',
      file: '/usr/bin/open',
      args: [path.join(repoRoot, 'infra/README.md')],
      timeoutMs: 15_000,
    }],
    ['open-aws-guide', {
      label: 'Open AWS credential guide',
      file: '/usr/bin/open',
      args: [path.join(repoRoot, 'infra/README.md')],
      timeoutMs: 15_000,
    }],
  ]);
  const records = new Map();

  function timestamp() {
    return new Date().toISOString();
  }

  function blankRecord(actionId, action) {
    return {
      id: actionId,
      label: action.label,
      state: LOGIN_ACTION_STATES.IDLE,
      startedAt: null,
      updatedAt: null,
      verifiedAt: null,
      failedAt: null,
      errorCode: null,
      timeout: null,
      acknowledged: false,
      settledNotified: false,
    };
  }

  function publicRecord(actionId, action) {
    const record = records.get(actionId) || blankRecord(actionId, action);
    return {
      id: record.id,
      label: record.label,
      state: record.state,
      startedAt: safeIso(record.startedAt),
      updatedAt: safeIso(record.updatedAt),
      verifiedAt: safeIso(record.verifiedAt),
      failedAt: safeIso(record.failedAt),
      errorCode: sanitizeLoginActionErrorCode(record.errorCode),
    };
  }

  function updateRecord(actionId, patch) {
    const action = actions.get(actionId);
    const current = records.get(actionId) || blankRecord(actionId, action);
    const next = {
      ...current,
      ...patch,
      updatedAt: timestamp(),
    };
    records.set(actionId, next);
    return next;
  }

  function clearTimeoutFor(actionId) {
    const record = records.get(actionId);
    if (record?.timeout) clearTimeout(record.timeout);
    if (record?.timeout) records.set(actionId, { ...record, timeout: null });
  }

  function notifySettled(actionId) {
    const record = records.get(actionId);
    if (!record || record.settledNotified) return;
    records.set(actionId, { ...record, settledNotified: true });
    try {
      const result = onSettled?.(actionId);
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch (_error) {}
  }

  function failAction(actionId, errorCode, { notify = true } = {}) {
    clearTimeoutFor(actionId);
    updateRecord(actionId, {
      state: LOGIN_ACTION_STATES.FAILED,
      errorCode: sanitizeLoginActionErrorCode(errorCode) || 'LOGIN_ACTION_PROCESS_FAILED',
      failedAt: timestamp(),
    });
    if (notify) notifySettled(actionId);
  }

  function classifyProcessExit(actionId, exitCode, signal, stderr) {
    const diagnostic = String(stderr || '');
    if (actionId === 'aws-admin-login') {
      if (signal === 'SIGINT' || Number(exitCode) === 130 || /cancel|abort/i.test(diagnostic)) {
        return 'AWS_SSO_LOGIN_CANCELLED';
      }
      return 'AWS_SSO_LOGIN_FAILED';
    }
    if (actionId === 'open-ibkr-gateway') return 'IBKR_GATEWAY_OPEN_FAILED';
    return signal ? 'LOGIN_ACTION_PROCESS_FAILED' : 'LOGIN_ACTION_PROCESS_EXITED';
  }

  function verificationTimeoutCode(actionId) {
    if (actionId === 'aws-admin-login') return 'AWS_ADMIN_LOGIN_REQUIRED';
    if (actionId === 'open-ibkr-gateway') return 'IBKR_VERIFICATION_TIMEOUT';
    return 'LOGIN_ACTION_VERIFICATION_TIMEOUT';
  }

  function verificationFailureCode(actionId, detail) {
    if (actionId === 'aws-admin-login') {
      if (detail?.state === 'wrong_principal') return 'AWS_PROFILE_WRONG_PRINCIPAL';
      if (detail?.state === 'forbidden') return 'AWS_AUTHORIZATION_DENIED';
      if (detail?.state === 'signed_out' || detail?.state === 'expired') {
        return 'AWS_ADMIN_LOGIN_REQUIRED';
      }
      if (detail?.status === STATUS.UNKNOWN) return 'AWS_SERVICE_UNAVAILABLE';
    }
    if (actionId === 'open-ibkr-gateway' && detail?.state === 'socket_disabled') {
      return 'IBKR_SOCKET_DISABLED';
    }
    return null;
  }

  function syncVerification(report) {
    const details = new Map(
      (Array.isArray(report?.service?.details) ? report.service.details : [])
        .map((detail) => [String(detail?.id || ''), detail]),
    );
    for (const [actionId, action] of actions.entries()) {
      const record = records.get(actionId);
      if (!record || record.state !== LOGIN_ACTION_STATES.VERIFYING || !action.verificationId) continue;
      const detail = details.get(action.verificationId);
      if (detail?.status === STATUS.ONLINE) {
        clearTimeoutFor(actionId);
        updateRecord(actionId, {
          state: LOGIN_ACTION_STATES.READY,
          verifiedAt: detail.verifiedAt || detail.checkedAt || timestamp(),
          errorCode: null,
        });
        continue;
      }
      const failureCode = verificationFailureCode(actionId, detail);
      if (failureCode) failAction(actionId, failureCode, { notify: false });
    }
    return getStatus();
  }

  function prepareAction(action) {
    if (!action.prepare) return null;
    return new Promise((resolve) => {
      let child;
      let settled = false;
      let timer;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      try {
        child = spawnProcess(action.prepare.file, action.prepare.args, {
          cwd: repoRoot,
          env: sanitizedChildEnvironment(inheritedEnvironment),
          shell: false,
          stdio: 'ignore',
        });
      } catch (_error) {
        // Logout is a cache cleanup step. A missing or already-clean cache must
        // not prevent the real interactive login from starting.
        finish();
        return;
      }
      child.once('error', finish);
      child.once('close', finish);
      timer = setTimeout(finish, 10_000);
      timer.unref?.();
    });
  }

  async function run(actionId, { remoteAddress } = {}) {
    if (!isLoopbackAddress(remoteAddress)) {
      const error = new Error('Login actions are available only from this computer.');
      error.statusCode = 403;
      error.code = 'LOGIN_ACTION_LOOPBACK_REQUIRED';
      throw error;
    }
    const normalizedActionId = String(actionId || '');
    const action = actions.get(normalizedActionId);
    if (!action) {
      const error = new Error('That login action is not allowlisted.');
      error.statusCode = 404;
      error.code = 'LOGIN_ACTION_NOT_ALLOWLISTED';
      throw error;
    }
    const existing = records.get(normalizedActionId);
    if (existing && ACTIVE_LOGIN_ACTION_STATES.has(existing.state)) {
      const error = new Error('That login action is already waiting for verification.');
      error.statusCode = 429;
      error.code = 'LOGIN_ACTION_IN_PROGRESS';
      throw error;
    }

    const startedAt = timestamp();
    records.set(normalizedActionId, {
      ...blankRecord(normalizedActionId, action),
      state: LOGIN_ACTION_STATES.AWAITING_USER,
      startedAt,
      updatedAt: startedAt,
    });
    let child;
    try {
      if (action.prepare) await prepareAction(action);
      child = spawnProcess(action.file, action.args, {
        cwd: repoRoot,
        env: action.awsEnvironment
          ? sanitizedChildEnvironment(inheritedEnvironment)
          : { ...inheritedEnvironment },
        shell: false,
        stdio: action.awsEnvironment ? ['ignore', 'ignore', 'pipe'] : 'ignore',
      });
    } catch (_error) {
      failAction(normalizedActionId, 'LOGIN_ACTION_START_FAILED');
      const error = new Error('The approved login action could not be started.');
      error.statusCode = 503;
      error.code = 'LOGIN_ACTION_START_FAILED';
      throw error;
    }

    return new Promise((resolve, reject) => {
      let acknowledged = false;
      let stderr = '';
      const acknowledge = () => {
        if (acknowledged) return;
        acknowledged = true;
        updateRecord(normalizedActionId, { acknowledged: true });
        resolve({
          accepted: true,
          action: { id: normalizedActionId, label: action.label },
          state: LOGIN_ACTION_STATES.AWAITING_USER,
          startedAt,
        });
      };

      child.stderr?.on('data', (chunk) => {
        if (Buffer.byteLength(stderr, 'utf8') >= MAX_CAPTURE_BYTES) return;
        stderr += String(chunk || '').slice(0, MAX_CAPTURE_BYTES);
      });
      child.once('spawn', acknowledge);
      child.once('error', () => {
        const started = acknowledged;
        if (!started) {
          failAction(normalizedActionId, 'LOGIN_ACTION_START_FAILED');
          const error = new Error('The approved login action could not be started.');
          error.statusCode = 503;
          error.code = 'LOGIN_ACTION_START_FAILED';
          reject(error);
          return;
        }
        failAction(normalizedActionId, 'LOGIN_ACTION_PROCESS_FAILED');
      });
      child.once('close', (exitCode, signal) => {
        if (!acknowledged) {
          failAction(normalizedActionId, 'LOGIN_ACTION_START_FAILED');
          const error = new Error('The approved login action exited before it started.');
          error.statusCode = 503;
          error.code = 'LOGIN_ACTION_START_FAILED';
          reject(error);
          return;
        }
        const current = records.get(normalizedActionId);
        if (!current || !ACTIVE_LOGIN_ACTION_STATES.has(current.state)) return;
        if (Number(exitCode) !== 0 || signal) {
          failAction(normalizedActionId, classifyProcessExit(
            normalizedActionId,
            exitCode,
            signal,
            stderr,
          ));
          return;
        }
        if (action.verificationId) {
          updateRecord(normalizedActionId, { state: LOGIN_ACTION_STATES.VERIFYING });
        } else {
          clearTimeoutFor(normalizedActionId);
          updateRecord(normalizedActionId, {
            state: LOGIN_ACTION_STATES.READY,
            verifiedAt: timestamp(),
          });
        }
        notifySettled(normalizedActionId);
      });

      const timeout = setTimeout(() => {
        const current = records.get(normalizedActionId);
        if (!current || !ACTIVE_LOGIN_ACTION_STATES.has(current.state)) return;
        try { child.kill('SIGTERM'); } catch (_error) {}
        const errorCode = current.state === LOGIN_ACTION_STATES.VERIFYING
          ? verificationTimeoutCode(normalizedActionId)
          : 'LOGIN_ACTION_START_TIMEOUT';
        failAction(normalizedActionId, errorCode);
        if (!acknowledged) {
          const error = new Error('The approved login action timed out before it started.');
          error.statusCode = 504;
          error.code = 'LOGIN_ACTION_START_TIMEOUT';
          reject(error);
        }
      }, Math.max(1_000, Number(action.timeoutMs) || DEFAULT_ACTION_TIMEOUT_MS));
      timeout.unref?.();
      const current = records.get(normalizedActionId);
      if (current) records.set(normalizedActionId, { ...current, timeout });
    });
  }

  function getStatus() {
    return Object.fromEntries(
      [...actions.entries()].map(([actionId, action]) => [actionId, publicRecord(actionId, action)]),
    );
  }

  return { getStatus, run, syncVerification };
}

module.exports = {
  AWS_PROFILE_TARGETS,
  ACTIVE_LOGIN_ACTION_STATES,
  DEFAULT_FAST_INTERVAL_MS,
  DEFAULT_FAST_PROBE_TIMEOUT_MS,
  DEFAULT_GMAIL_MAX_AGE_MS,
  DEFAULT_IBKR_MAX_AGE_MS,
  DEFAULT_SLOW_INTERVAL_MS,
  DEFAULT_SLOW_PROBE_TIMEOUT_MS,
  IB_GATEWAY_BUNDLE_ID,
  LOGIN_DEFINITIONS,
  LOGIN_ACTION_STATES,
  RECOVERY,
  STATUS,
  aggregateLoginStatus,
  bridgeIsEnabled,
  createAwsProfileProbe,
  createLoginActionService,
  createLoginStatusService,
  evaluateAwsLogin,
  evaluateGmailLogin,
  evaluateIbkrLogin,
  isLoopbackAddress,
  safeReason,
  sanitizedChildEnvironment,
};
