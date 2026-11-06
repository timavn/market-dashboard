#!/usr/bin/env node
/*
 * Local dashboard supervisor.  It intentionally owns only processes started
 * from this repository and never kills an arbitrary listener on a dashboard
 * port.  `start --detach` leaves a small monitor running after the caller
 * exits; the monitor restarts the UI/API with bounded backoff.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomBytes } = require('crypto');
const net = require('net');
const { spawn, execFileSync, execFile } = require('child_process');
const { analystHealthFailureRequiresInvalidation, createAnalystVerificationController } = require('./analystLifecycle.cjs');
const { CONTRACT_MESSAGE, CONTRACT_READY_MESSAGE } = require('../../src/services/analyst/analystRuntimeGate.cjs');
const { buildSystemReadiness } = require('../../src/utils/systemReadiness.cjs');
const { computeRuntimeFingerprint } = require('../../src/utils/runtimeFingerprint.cjs');
const {
  legacyHermesIsReadOnly,
  normalizeLegacyHermesMode,
} = require('../../src/utils/legacyHermesMode.cjs');
const { preflightAwsProfile } = require('../ops/aws_profile_preflight');

const root = path.resolve(__dirname, '../..');
const appSupport = path.join(os.homedir(), 'Library/Application Support/market-dashboard');
const logDir = path.join(os.homedir(), 'Library/Logs/market-dashboard');
const stateFile = path.join(appSupport, 'dev-stack.json');
const launchAgentLabel = 'com.market-dashboard.stack';
const launchAgentPlist = path.join(os.homedir(), 'Library/LaunchAgents', `${launchAgentLabel}.plist`);
const isDetach = process.argv.includes('--detach');
const asJson = process.argv.includes('--json');
const checkOnly = process.argv.includes('--check-only');
const command = process.argv[2] || 'start';
const maxLogBytes = 10 * 1024 * 1024;
const readinessBaseUrl = String(
  process.env.MARKET_DASHBOARD_API_URL || process.env.REACT_APP_BACKEND_URL || 'http://127.0.0.1:3001',
).replace(/\/$/, '');
const readinessUrl = `${readinessBaseUrl}/api/system-readiness`;
const loginStatusUrl = `${readinessBaseUrl}/api/login-status`;
const readinessTimeoutMs = Math.max(1_000, Number(process.env.MARKET_DASHBOARD_READINESS_TIMEOUT_MS) || 35_000);
// A forced authentication check runs the bounded IBKR/Gmail probes plus the
// three explicit AWS profile preflights. Do not turn a slow cold SSO cache
// into a false "unavailable" result before the server's own probe budget.
const loginStatusTimeoutMs = Math.max(1_000, Number(process.env.MARKET_DASHBOARD_LOGIN_STATUS_TIMEOUT_MS) || 30_000);
const morningStartTimeoutMs = Math.max(5_000, Number(process.env.MARKET_DASHBOARD_START_TIMEOUT_MS) || 60_000);
// Core readiness is independent of optional Analyst verification.
const dashboardBootstrapTimeoutMs = Math.max(
  morningStartTimeoutMs,
  Number(process.env.MARKET_DASHBOARD_BOOTSTRAP_TIMEOUT_MS) || 60_000,
);
const bridgeHeartbeatMaxAgeMs = Math.max(
  90_000,
  Number(process.env.HERMES_BRIDGE_HEARTBEAT_MAX_AGE_MS) || 180_000,
);
const controllerHeartbeatMaxAgeMs = Math.max(
  120_000,
  Number(process.env.READINESS_CONTROLLER_HEARTBEAT_MAX_AGE_MS)
    || Number(process.env.HERMES_CONTROLLER_HEARTBEAT_MAX_AGE_MS)
    || 180_000,
);
const monitorIntervalMs = Math.max(1_000, Number(process.env.MARKET_DASHBOARD_MONITOR_INTERVAL_MS) || 5_000);
// Seven-market Analyst acquisition can keep the API busy for 10–30 seconds.
// Let its health response drain before counting a failure: three short probes
// must not kill an active bounded review. Refused connections still fail at once.
const apiHealthTimeoutMs = Math.max(
  5_000,
  Number(process.env.MARKET_DASHBOARD_API_HEALTH_TIMEOUT_MS) || 30_000,
);
// Both sidecars can briefly serialize health behind a burst of verified IBKR
// or research work. Keep their probes bounded, but do not restart a healthy
// live-data process merely because three 1.5-second probes queued behind it.
const sidecarHealthTimeoutMs = Math.max(
  5_000,
  Number(process.env.MARKET_DASHBOARD_SIDECAR_HEALTH_TIMEOUT_MS) || 10_000,
);
// Hermes answers status from Python and slows sharply when the host is
// saturated (a full test run, indexing). Three 1.5-second misses used to
// restart a healthy gateway and drop the chat turn it was serving.
const analystHermesHealthTimeoutMs = Math.max(
  5_000,
  Number(process.env.MARKET_DASHBOARD_ANALYST_HERMES_HEALTH_TIMEOUT_MS) || 10_000,
);
// `lsof` and `ps` slow down under the same load. Bound them so one inspection
// cannot stall the monitor, and treat an unanswered inspection as unknown.
const processInspectionTimeoutMs = 10_000;
const awsPreflightRetryMs = Math.max(
  30_000,
  Number(process.env.MARKET_DASHBOARD_AWS_PREFLIGHT_RETRY_MS) || 60_000,
);
const healthFailureThreshold = Math.max(2, Number(process.env.MARKET_DASHBOARD_HEALTH_FAILURE_THRESHOLD) || 3);
const restartWindowMs = 5 * 60 * 1000;
const circuitOpenMs = 5 * 60 * 1000;
const defaultBridgeAwsProfile = 'market-dashboard-bridge';
const enabledFlagValues = new Set(['1', 'true', 'yes', 'on', 'enabled']);
function expectedCapabilityIdsForEnv(env = process.env) {
  const automationCapability = legacyHermesIsReadOnly(
    normalizeLegacyHermesMode(env.LEGACY_HERMES_MODE),
  )
    ? 'automation.readiness'
    : 'automation.hermes';
  return Object.freeze([
  automationCapability,
  'dashboard.core',
  'portfolio.live',
  'research.current',
  ]);
}
const expectedCapabilityIds = expectedCapabilityIdsForEnv();
const services = {
  api: { port: 3001, health: 'http://127.0.0.1:3001/api/health', healthTimeoutMs: apiHealthTimeoutMs, args: ['server.js'], env: { NODE_ENV: 'development' }, critical: true },
  ui: { port: 3000, health: 'http://127.0.0.1:3000/', args: [path.join(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', '3000', '--strictPort'], env: { HOST: '127.0.0.1', PORT: '3000', CI: 'true', BROWSER: 'none', NODE_OPTIONS: '--max-old-space-size=3072' }, critical: true },
  sidecar: { port: 8765, health: 'http://127.0.0.1:8765/livez', healthTimeoutMs: sidecarHealthTimeoutMs, shell: true, args: ['scripts/ibkr_sidecar/start.sh'], env: {}, critical: false },
  analystSidecar: { port: 6951, health: 'http://127.0.0.1:6951/livez', healthTimeoutMs: sidecarHealthTimeoutMs, shell: true, args: ['scripts/analyst_sidecar/start.sh'], env: {}, critical: false },
  analystHermes: { port: 9121, health: 'http://127.0.0.1:9121/api/status', healthTimeoutMs: analystHermesHealthTimeoutMs, shell: true, args: ['scripts/analyst/start_hermes.sh'], env: {}, critical: false },
  bridge: {
    processOnly: true,
    args: [path.join(root, 'scripts/ops/hermes_snapshot_bridge.js')],
    env: {},
    critical: false,
    heartbeatMaxAgeMs: bridgeHeartbeatMaxAgeMs,
  },
  controller: {
    processOnly: true,
    args: [path.join(root, 'scripts/ops/hermes_reliability_controller.js')],
    env: {},
    critical: false,
    heartbeatMaxAgeMs: controllerHeartbeatMaxAgeMs,
  },
};
const bridgeScriptPath = path.join(root, 'scripts/ops/hermes_snapshot_bridge.js');
const controllerScriptPath = path.join(root, 'scripts/ops/hermes_reliability_controller.js');
const sidecarDir = path.join(root, 'scripts/ibkr_sidecar');
const sidecarStartPath = path.join(sidecarDir, 'start.sh');
const sidecarRuntimeDir = path.join(sidecarDir, '.venv');
const analystSidecarDir = path.join(root, 'scripts/analyst_sidecar');
const analystSidecarStartPath = path.join(analystSidecarDir, 'start.sh');
const analystHermesStartPath = path.join(root, 'scripts/analyst/start_hermes.sh');
const analystContractPath = path.join(root, 'scripts/analyst/check_hermes_contract.mjs');
const analystBinPath = path.join(os.homedir(), '.local/bin/analyst');
const hermesBinPaths = new Set([
  path.join(os.homedir(), '.local/bin/hermes'),
  path.join(os.homedir(), '.hermes/hermes-agent/venv/bin/hermes'),
]);
let analystRuntimeEnvironment = Object.freeze({});

function hermesBridgeEnabled(env = process.env) {
  const legacy = enabledFlagValues.has(
    String(env.HERMES_BRIDGE_ENABLED || '').trim().toLowerCase(),
  );
  const partitionEnabled = (name) => (
    Object.prototype.hasOwnProperty.call(env, name)
      ? enabledFlagValues.has(String(env[name] || '').trim().toLowerCase())
      : legacy
  );
  return partitionEnabled('HERMES_OPERATIONS_BRIDGE_ENABLED')
    || partitionEnabled('HERMES_PORTFOLIO_BRIDGE_ENABLED');
}

function supervisedServiceNames(env = process.env) {
  return ['sidecar', 'analystSidecar', 'analystHermes', 'api', 'ui', 'controller', 'bridge']
    .filter((name) => name !== 'bridge' || hermesBridgeEnabled(env));
}

async function stopServicesInOrder(names, terminateService) {
  const pending = new Set(names);
  // Stop automated repair and outbound work before taking away their inputs.
  // Stop request producers before native workers so shutdown cannot schedule
  // replacement sidecars while the old generation is being drained.
  for (const name of ['controller', 'bridge', 'api', 'ui', 'analystHermes', 'analystSidecar', 'sidecar', ...pending]) {
    if (!pending.delete(name)) continue;
    await terminateService(name);
  }
}

const localServiceLabels = {
  ui: 'Dashboard UI',
  api: 'Express API',
  sidecar: 'IBKR sidecar',
  analystSidecar: 'Analyst research sidecar',
  analystHermes: 'The Analyst Hermes gateway',
  bridge: 'Hermes snapshot bridge',
  controller: 'Hermes reliability controller',
};

function bridgeRecoveryLabel(serviceState = {}) {
  const profile = serviceState.awsProfile || defaultBridgeAwsProfile;
  switch (serviceState.lastPublishErrorCode) {
    case 'HERMES_BRIDGE_AWS_PROFILE_UNAVAILABLE':
      return `Provision credentials for the dedicated ${profile} AWS profile, then restart the stack.`;
    case 'HERMES_BRIDGE_AWS_ACCESS_DENIED':
      return `Attach the write-only local bridge policy to the principal used by ${profile}, then restart the stack.`;
    case 'HERMES_BRIDGE_TABLE_MISSING':
      return 'Deploy the Hermes input snapshot and service heartbeat tables, then restart the stack.';
    case 'HERMES_BRIDGE_AWS_UNREACHABLE':
      return 'Restore DNS/network access to the regional DynamoDB endpoint; the bridge will retry automatically.';
    case 'HERMES_BRIDGE_AWS_THROTTLED':
      return 'Inspect DynamoDB throttling and capacity; the bridge will retry automatically.';
    default:
      if (serviceState.lastPublishErrorCode) {
        return `Inspect the ${serviceState.lastPublishErrorCode} publish failure for ${profile}, then restart the stack.`;
      }
      if (serviceState.lastInputErrorCode) {
        return `Resolve bridge input failure ${serviceState.lastInputErrorCode} in the API or IBKR sidecar, then restart the stack.`;
      }
      return 'Restart the repo-owned local stack, then rerun the morning checklist.';
  }
}

function ensureDirs() { fs.mkdirSync(appSupport, { recursive: true }); fs.mkdirSync(logDir, { recursive: true }); }
function readState() { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return null; } }
function writeJsonAtomically(targetPath, value, {
  fileSystem = fs,
  processId = process.pid,
} = {}) {
  const temporaryPath = `${targetPath}.tmp-${processId}`;
  try {
    fileSystem.mkdirSync(path.dirname(targetPath), { recursive: true });
    fileSystem.writeFileSync(temporaryPath, JSON.stringify(value, null, 2), { mode: 0o600 });
    fileSystem.renameSync(temporaryPath, targetPath);
    return { ok: true, error: null };
  } catch (error) {
    try { fileSystem.unlinkSync(temporaryPath); } catch { /* Process may have already exited. */ }
    return {
      ok: false,
      error,
      errorCode: error?.code || 'STATE_WRITE_FAILED',
    };
  }
}

let lastStateWriteErrorCode = null;
function planStateWriteNotification(previousErrorCode, result, observedAt = new Date().toISOString()) {
  const currentErrorCode = result?.ok ? null : (result?.errorCode || 'STATE_WRITE_FAILED');
  if (!previousErrorCode && currentErrorCode) {
    return {
      nextErrorCode: currentErrorCode,
      event: {
        kind: 'failure',
        service: 'supervisor-state',
        title: 'Market Dashboard: supervisor state persistence failed',
        body: `dev-stack.json could not be updated (${currentErrorCode}). The supervisor is still running with in-memory state; check free disk space.`,
        observedAt,
      },
    };
  }
  if (previousErrorCode && !currentErrorCode) {
    return {
      nextErrorCode: null,
      event: {
        kind: 'recovery',
        service: 'supervisor-state',
        title: 'Market Dashboard: supervisor state persistence recovered',
        body: `dev-stack.json writes are healthy again after ${previousErrorCode}.`,
        observedAt,
      },
    };
  }
  return { nextErrorCode: currentErrorCode, event: null };
}

function writeState(state) {
  const result = writeJsonAtomically(stateFile, state);
  const transition = planStateWriteNotification(lastStateWriteErrorCode, result);
  if (!result.ok) {
    if (lastStateWriteErrorCode !== result.errorCode) {
      console.error(
        `[dashboard-supervisor] State persistence degraded (${result.errorCode}): ${result.error?.message || 'unknown error'}`,
      );
    }
    if (transition.event && localNotificationsEnabled()) sendMacNotification(transition.event);
    lastStateWriteErrorCode = transition.nextErrorCode;
    return false;
  }
  if (lastStateWriteErrorCode) {
    console.log('[dashboard-supervisor] State persistence recovered.');
  }
  if (transition.event && localNotificationsEnabled()) sendMacNotification(transition.event);
  lastStateWriteErrorCode = transition.nextErrorCode;
  return true;
}
function removeState() { try { fs.unlinkSync(stateFile); } catch { /* Process may have already exited. */ } }

function configuredBridgeAwsProfile(env = process.env) {
  return String(env.HERMES_BRIDGE_AWS_PROFILE || defaultBridgeAwsProfile).trim()
    || defaultBridgeAwsProfile;
}

function preflightAwsService(name, {
  env = process.env,
  preflight = preflightAwsProfile,
} = {}) {
  const purpose = name === 'api' || name === 'analystSidecar'
    ? 'api'
    : (name === 'bridge' ? 'bridge' : null);
  if (!purpose) return null;
  const profile = purpose === 'api'
    ? 'market-dashboard-local'
    : configuredBridgeAwsProfile(env);
  try {
    return preflight({ purpose, profile, env });
  } catch {
    return {
      ok: false,
      purpose,
      profile,
      errorCode: 'AWS_PROFILE_UNUSABLE',
      detail: `${profile} could not be validated.`,
    };
  }
}

function credentialPreflightFailureState(name, result, {
  previous = {},
  now = Date.now(),
  retryMs = awsPreflightRetryMs,
} = {}) {
  const checkedAt = new Date(now).toISOString();
  const nextCredentialPreflightAt = new Date(now + retryMs).toISOString();
  return {
    ...previous,
    pid: null,
    external: false,
    status: 'blocked',
    errorCode: result.errorCode || 'AWS_PROFILE_UNUSABLE',
    lastDetail: result.detail || 'The dedicated AWS profile failed preflight.',
    healthFailures: 0,
    credentialPreflightBlocked: true,
    credentialPreflightPurpose: result.purpose || null,
    credentialPreflightCheckedAt: checkedAt,
    nextCredentialPreflightAt,
    ...(services[name]?.processOnly ? {
      enabled: true,
      intentionallyDisabled: false,
      lastHeartbeatAt: null,
      lastResultStatus: 'error',
      lastErrorCode: result.errorCode || 'AWS_PROFILE_UNUSABLE',
      lastInputErrorCode: null,
      lastInputDetail: null,
      lastPublishErrorCode: result.errorCode || 'AWS_PROFILE_UNUSABLE',
      lastPublishStage: null,
      lastPublishDetail: result.detail || 'The dedicated AWS profile failed preflight.',
      lastPublishFailures: [],
      lastFailureAt: checkedAt,
      awsProfile: result.profile || configuredBridgeAwsProfile(),
    } : {}),
  };
}

const awsCredentialEnvironmentKeys = Object.freeze([
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

function clearAwsCredentialEnvironment(environment) {
  for (const key of awsCredentialEnvironmentKeys) delete environment[key];
  return environment;
}

function createAnalystRuntimeEnvironment(random = randomBytes) {
  return Object.freeze({
    ANALYST_SERVICE_TOKEN: random(32).toString('hex'),
    HERMES_DASHBOARD_SESSION_TOKEN: random(32).toString('hex'),
    ANALYST_CONTRACT_VERIFIED: 'false',
    MARKET_DASHBOARD_SUPERVISOR_GENERATION: random(16).toString('hex'),
  });
}

function childEnvironment(name, inheritedEnv = process.env, runtimeEnvironment = analystRuntimeEnvironment) {
  const environment = { ...inheritedEnv };
  delete environment.ANALYST_SERVICE_TOKEN;
  delete environment.HERMES_DASHBOARD_SESSION_TOKEN;
  delete environment.ANALYST_CONTRACT_VERIFIED;
  delete environment.MARKET_DASHBOARD_SUPERVISOR_GENERATION;
  if (name === 'api') {
    Object.assign(environment, runtimeEnvironment);
    environment.ANALYST_CONTRACT_VERIFIED = 'false';
  } else if (name === 'analystSidecar') {
    environment.ANALYST_SERVICE_TOKEN = runtimeEnvironment.ANALYST_SERVICE_TOKEN;
  } else if (name === 'analystHermes') {
    environment.ANALYST_SERVICE_TOKEN = runtimeEnvironment.ANALYST_SERVICE_TOKEN;
    environment.HERMES_DASHBOARD_SESSION_TOKEN = runtimeEnvironment.HERMES_DASHBOARD_SESSION_TOKEN;
  }
  Object.assign(environment, services[name]?.env || {});
  if (name === 'controller' || name === 'analystHermes') {
    // The local controller acts only through loopback APIs and must never
    // inherit credentials that could expand it into a cloud control plane.
    clearAwsCredentialEnvironment(environment);
    delete environment.AWS_PROFILE;
    delete environment.AWS_DEFAULT_PROFILE;
    return environment;
  }
  if (name === 'api' || name === 'analystSidecar') {
    clearAwsCredentialEnvironment(environment);
    environment.AWS_PROFILE = 'market-dashboard-local';
    environment.AWS_DEFAULT_PROFILE = 'market-dashboard-local';
    environment.AWS_REGION = 'us-west-1';
    environment.AWS_DEFAULT_REGION = 'us-west-1';
    environment.AWS_SDK_LOAD_CONFIG = '1';
    environment.AWS_EC2_METADATA_DISABLED = 'true';
    environment.MARKET_DASHBOARD_AWS_PROFILE_LOCKED = 'true';
    return environment;
  }
  if (name !== 'bridge') return environment;

  // The bridge is a write-only security principal. Environment credentials
  // take precedence over AWS_PROFILE in the SDK, so remove them before
  // selecting the dedicated profile.
  clearAwsCredentialEnvironment(environment);
  const profile = configuredBridgeAwsProfile(inheritedEnv);
  environment.HERMES_BRIDGE_AWS_PROFILE = profile;
  environment.AWS_PROFILE = profile;
  environment.AWS_SDK_LOAD_CONFIG = '1';
  return environment;
}

function runAsyncContractCommand(command, args, options) {
  return new Promise(resolve => {
    execFile(command, args, { ...options, killSignal: 'SIGKILL' }, (error, stdout, stderr) => {
      resolve({ status: error ? 1 : 0, stdout, stderr, error });
    });
  });
}
async function runAnalystContractCheck({
  runtimeEnvironment = analystRuntimeEnvironment,
  run = runAsyncContractCommand,
  signal,
} = {}) {
  const checkedAt = new Date().toISOString();
  const result = await run(process.execPath, [analystContractPath, '--deep'], {
    cwd: root,
    env: { ...process.env, ...runtimeEnvironment },
    encoding: 'utf8',
    timeout: 240_000,
    maxBuffer: 256 * 1024,
    signal,
  });
  if (result?.status !== 0) {
    return {
      verified: false,
      checkedAt,
      error: String(result?.stderr || result?.error?.message || 'Hermes JSON-RPC contract check failed.')
        .trim()
        .slice(0, 500),
    };
  }
  try {
    const evidence = JSON.parse(String(result.stdout || ''));
    const required = [
      'list',
      'create',
      'mostRecent',
      'history',
      'interrupt',
      'promptStreaming',
      'messageStart',
      'messageDelta',
      'messageComplete',
      'toolComplete',
      'mcpToolHistory',
      'mcpToolResume',
      'reconnect',
      'resume',
      'persistence',
    ];
    if (!required.every((name) => evidence?.checks?.[name] === true)) {
      throw new Error('Hermes contract evidence is incomplete.');
    }
    return { verified: true, checkedAt, evidence };
  } catch (error) {
    return { verified: false, checkedAt, error: error.message };
  }
}

function localNotificationsEnabled(env = process.env, platform = process.platform) {
  if (platform !== 'darwin') return false;
  const configured = String(
    env.MARKET_DASHBOARD_LOCAL_NOTIFICATIONS
      ?? env.MARKET_DASHBOARD_NOTIFICATIONS_ENABLED
      ?? 'true',
  ).trim().toLowerCase();
  return !['0', 'false', 'no', 'off', 'disabled'].includes(configured);
}

function notificationPhase(serviceState = {}) {
  if (['ready', 'disabled'].includes(serviceState.status)) return 'ready';
  if (['blocked', 'degraded', 'failed'].includes(serviceState.status)) return 'failed';
  if (
    serviceState.status === 'down'
    && Number(serviceState.healthFailures || 0) >= healthFailureThreshold
  ) {
    return 'failed';
  }
  return 'pending';
}

function serviceFailureCode(name, serviceState = {}) {
  return serviceState.lastPublishErrorCode
    || serviceState.lastInputErrorCode
    || serviceState.lastErrorCode
    || serviceState.errorCode
    || `LOCAL_${String(name).toUpperCase()}_UNAVAILABLE`;
}

function serviceFailureDetail(serviceState = {}) {
  const detail = serviceState.lastPublishDetail
    || serviceState.lastInputDetail
    || serviceState.lastDetail
    || serviceState.error
    || null;
  if (!detail) return null;
  return String(detail).replace(/[\r\n]+/g, ' ').slice(0, 180);
}

function planServiceNotificationTransition({
  name,
  serviceState,
  previous = null,
  observedAt = new Date().toISOString(),
} = {}) {
  const phase = notificationPhase(serviceState);
  if (phase === 'pending') return { next: previous, event: null };

  const label = localServiceLabels[name] || name;
  const errorCode = phase === 'failed' ? serviceFailureCode(name, serviceState) : null;
  const failureDetail = phase === 'failed' ? serviceFailureDetail(serviceState) : null;
  const next = {
    ...(previous || {}),
    phase,
    errorCode,
    status: serviceState.status || null,
    transitionedAt: previous?.phase === phase ? previous.transitionedAt : observedAt,
    observedAt,
  };

  if (!previous) {
    if (phase === 'ready') return { next, event: null };
    return {
      next,
      event: {
        kind: 'failure',
        service: name,
        title: `Market Dashboard: ${label} unavailable`,
        body: `${label} is ${serviceState.status || 'unavailable'} (${errorCode}).${failureDetail ? ` ${failureDetail}` : ''}`,
        observedAt,
      },
    };
  }
  if (previous.phase === phase) return { next, event: null };
  if (phase === 'failed') {
    return {
      next,
      event: {
        kind: 'failure',
        service: name,
        title: `Market Dashboard: ${label} unavailable`,
        body: `${label} is ${serviceState.status || 'unavailable'} (${errorCode}).${failureDetail ? ` ${failureDetail}` : ''}`,
        observedAt,
      },
    };
  }

  const failedAt = Date.parse(String(previous.transitionedAt || ''));
  const recoveredAt = Date.parse(observedAt);
  const durationMinutes = Number.isFinite(failedAt) && Number.isFinite(recoveredAt)
    ? Math.max(0, Math.round((recoveredAt - failedAt) / 60_000))
    : null;
  return {
    next,
    event: {
      kind: 'recovery',
      service: name,
      title: `Market Dashboard: ${label} recovered`,
      body: serviceState.status === 'disabled'
        ? `${label} is intentionally disabled and idle.`
        : `${label} is healthy again${durationMinutes == null ? '' : ` after ${durationMinutes} minute${durationMinutes === 1 ? '' : 's'}`}.`,
      observedAt,
    },
  };
}

function sendMacNotification(event, {
  execute = execFileSync,
  platform = process.platform,
} = {}) {
  if (platform !== 'darwin' || !event) return { delivered: false, reason: 'unsupported' };
  const script = [
    'on run argv',
    'display notification (item 2 of argv) with title (item 1 of argv)',
    'end run',
  ].join('\n');
  try {
    execute('/usr/bin/osascript', ['-e', script, event.title, event.body], {
      stdio: 'ignore',
      timeout: 3_000,
    });
    return { delivered: true };
  } catch (error) {
    return {
      delivered: false,
      reason: error?.code || error?.message || 'notification_failed',
    };
  }
}
function launchAgentDomain() {
  return typeof process.getuid === 'function' ? `gui/${process.getuid()}/${launchAgentLabel}` : null;
}
function launchAgentIsLoaded() {
  const domain = launchAgentDomain();
  if (!domain || !fs.existsSync(launchAgentPlist)) return false;
  try {
    execFileSync('launchctl', ['print', domain], { stdio: 'ignore', timeout: 2_000 });
    return true;
  } catch {
    return false;
  }
}
function listenerPid(port) {
  try { return Number(execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }).trim().split(/\s+/)[0]); } catch { return null; }
}
// `lsof -t` exits 1 with no output when nothing listens. A timeout, signal or
// any other failure is an unknown answer, never proof the port is free.
function listenerLookup(port, { run = execFileSync, timeoutMs = processInspectionTimeoutMs } = {}) {
  try {
    const pid = Number(String(run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
      encoding: 'utf8', timeout: timeoutMs,
    })).trim().split(/\s+/)[0]);
    return { pid: validProcessId(pid) ? pid : null, failed: false };
  } catch (error) {
    const nothingListening = error?.status === 1 && !error?.signal && !String(error?.stdout || '').trim();
    return { pid: null, failed: !nothingListening };
  }
}
function portAcceptsConnections(port, timeoutMs = 2_000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const finish = (accepted) => { socket.destroy(); resolve(accepted); };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}
function validProcessId(pid) {
  const numericPid = Number(pid);
  return Number.isInteger(numericPid) && numericPid > 0;
}
function processCommand(pid) {
  if (!validProcessId(pid)) return '';
  try { return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim(); } catch { return ''; }
}
function processEnvironment(pid) {
  if (!validProcessId(pid)) return '';
  try {
    const scoped = execFileSync('ps', ['eww', '-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim();
    if (/\bHERMES_DESKTOP_CHILD_PID=/.test(scoped)) return scoped;
  } catch { /* Process may have already exited. */ }
  try {
    return execFileSync('ps', ['eww', '-p', String(pid)], { encoding: 'utf8' })
      .split(/\r?\n/)
      .slice(1)
      .join(' ')
      .trim();
  } catch { return ''; }
}
function processParentPid(pid) {
  if (!validProcessId(pid)) return null;
  try {
    const value = Number(execFileSync('ps', ['-p', String(pid), '-o', 'ppid='], { encoding: 'utf8' }).trim());
    return validProcessId(value) ? value : null;
  } catch { return null; }
}
function processCwd(pid) {
  if (!validProcessId(pid)) return '';
  try { return fs.readlinkSync(`/proc/${pid}/cwd`); } catch { /* Process may have already exited. */ }
  try {
    return execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' })
      .split(/\r?\n/)
      .find(line => line.startsWith('n'))
      ?.slice(1) || '';
  } catch { return ''; }
}
function pathIsInRoot(candidate) {
  if (!candidate) return false;
  const relative = path.relative(root, path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
// `ps -o command=` prints arguments unquoted, so a checkout under a path with
// spaces (for example the tested-release export in "Application Support")
// would split every repository path. Protect the repository root first.
function commandTokens(commandText) {
  const text = String(commandText || '');
  if (!/\s/.test(root)) return text.split(/\s+/).filter(Boolean);
  const marker = '\u0000REPO_ROOT\u0000';
  return text.split(root).join(marker).split(/\s+/).filter(Boolean)
    .map((token) => token.split(marker).join(root));
}
function hasExactBridgeCommandSignature(commandText, cwd) {
  const tokens = commandTokens(commandText);
  const executableName = path.basename(tokens[0] || '');
  if (!['node', 'nodejs'].includes(executableName)) return false;
  const entrypoint = tokens[1] || '';
  if (path.isAbsolute(entrypoint)) {
    return path.normalize(entrypoint) === bridgeScriptPath;
  }
  if (!pathIsInRoot(cwd)) return false;
  const resolvedEntrypoint = path.resolve(cwd, entrypoint);
  return resolvedEntrypoint === bridgeScriptPath;
}
function hasExactControllerCommandSignature(commandText, cwd) {
  const tokens = commandTokens(commandText);
  const executableName = path.basename(tokens[0] || '');
  if (!['node', 'nodejs'].includes(executableName)) return false;
  const entrypoint = tokens[1] || '';
  if (path.isAbsolute(entrypoint)) {
    return path.normalize(entrypoint) === controllerScriptPath;
  }
  if (!pathIsInRoot(cwd)) return false;
  return path.resolve(cwd, entrypoint) === controllerScriptPath;
}
function hasExactSidecarCommandSignature(commandText, cwd) {
  const tokens = commandTokens(commandText);
  const resolvedCwd = cwd ? path.resolve(cwd) : '';
  const portIndex = tokens.indexOf('--port');
  const hasUvicorn = tokens.some((token) => path.basename(token) === 'uvicorn')
    || tokens.includes('uvicorn');
  return resolvedCwd === sidecarDir
    && hasUvicorn
    && tokens.includes('app:app')
    && portIndex >= 0
    && tokens[portIndex + 1] === String(services.sidecar.port);
}
function hasManagedSidecarRuntime(commandText, cwd, environment = '') {
  return hasExactSidecarCommandSignature(commandText, cwd)
    && (String(commandText || '').includes(`${sidecarRuntimeDir}${path.sep}`)
      || String(environment || '').includes(`IBKR_SIDECAR_RUNTIME_ROOT=${sidecarRuntimeDir}`));
}
function hasExactAnalystSidecarCommandSignature(commandText, cwd) {
  const tokens = commandTokens(commandText);
  const resolvedCwd = cwd ? path.resolve(cwd) : '';
  const portIndex = tokens.indexOf('--port');
  const hasUvicorn = tokens.some((token) => path.basename(token) === 'uvicorn')
    || tokens.includes('uvicorn');
  return resolvedCwd === analystSidecarDir
    && hasUvicorn
    && tokens.includes('app:app')
    && portIndex >= 0
    && tokens[portIndex + 1] === String(services.analystSidecar.port);
}
function hasExactAnalystHermesCommandSignature(commandText, cwd) {
  const tokens = commandTokens(commandText);
  const resolvedCwd = cwd ? path.resolve(cwd) : '';
  const portIndex = tokens.indexOf('--port');
  const usesAnalystBinary = tokens.includes(analystBinPath)
    || tokens.some((token) => hermesBinPaths.has(path.resolve(resolvedCwd || root, token)))
    || usesHermesBootstrapLauncher(tokens);
  const profileIndex = tokens.indexOf('-p');
  return resolvedCwd === root
    && usesAnalystBinary
    && (tokens.includes(analystBinPath) || (profileIndex >= 0 && tokens[profileIndex + 1] === 'analyst'))
    && tokens.includes('serve')
    && tokens.includes('--isolated')
    && portIndex >= 0
    && tokens[portIndex + 1] === String(services.analystHermes.port);
}
// Since `hermes update` (2026-11-02) the hermes command re-executes as Hermes's
// bundled Python, `-I -c`, an inline script that pins ~/.hermes/hermes-agent,
// imports hermes_bootstrap and enters hermes_cli.main, then the usual CLI args.
// Both the supervisor's own launch and an update respawn take this shape; the
// inline script varies by Hermes release, so only its stable markers are read
// (ps renders its newlines as a literal \012).
function usesHermesBootstrapLauncher(tokens) {
  const interpreter = tokens[0] || '';
  const toolsRoot = path.join(os.homedir(), '.hermes/tools') + path.sep;
  if (!path.resolve(interpreter).startsWith(toolsRoot) || !/^python3(\.\d+)?$/.test(path.basename(interpreter))) return false;
  if (tokens[1] !== '-I' || tokens[2] !== '-c') return false;
  const script = tokens.join(' ');
  return script.includes(`sys.path.insert(0, '${path.join(os.homedir(), '.hermes/hermes-agent')}')`)
    && /import hermes_bootstrap(?![\w.])/.test(script)
    && (script.includes("runpy.run_module('hermes_cli.main',") || script.includes('from hermes_cli.main import main'));
}
function hasExactAnalystHermesRuntimeSignature(commandText) {
  const tokens = commandTokens(commandText);
  const portIndex = tokens.indexOf('--port');
  const hostIndex = tokens.indexOf('--host');
  const profileIndex = tokens.indexOf('-p');
  const usesAnalystBinary = tokens.includes(analystBinPath)
    || tokens.some((token) => hermesBinPaths.has(path.resolve(token)))
    || usesHermesBootstrapLauncher(tokens);
  return usesAnalystBinary
    && profileIndex >= 0
    && tokens[profileIndex + 1] === 'analyst'
    && tokens.includes('serve')
    && tokens.includes('--isolated')
    && tokens.includes('--skip-build')
    && hostIndex >= 0
    && ['127.0.0.1', 'localhost'].includes(tokens[hostIndex + 1])
    && portIndex >= 0
    && tokens[portIndex + 1] === String(services.analystHermes.port);
}
function desktopBackendPids(environmentText) {
  const match = String(environmentText || '').match(
    /(?:^|\s)HERMES_DESKTOP_CHILD_PID=([0-9,]+)(?=\s|$)/,
  );
  if (!match) return [];
  return match[1]
    .split(',')
    .map((value) => Number(value))
    .filter(validProcessId);
}
function isRecoverableOrphanedAnalystHermes({
  pid,
  commandText,
  environmentText,
  parentPid,
} = {}) {
  if (!validProcessId(pid) || !hasExactAnalystHermesRuntimeSignature(commandText)) return false;
  if (![0, 1].includes(Number(parentPid))) return false;
  // HERMES_DESKTOP_CHILD_PID is a list of Desktop-owned backend PIDs, not a
  // parent/owner PID. `hermes update` inherits that list and then respawns a
  // fixed-port manual gateway with start_new_session=True. The new Analyst
  // process is therefore PPID 1 and can carry the PID of a separate, still-live
  // Desktop backend. Treat it as Desktop-owned only when the marker names the
  // listener itself; a different live marker must not strand port 9121 outside
  // dashboard supervision. Terminal-driven updates have no marker and are the
  // same safe handoff shape.
  return !desktopBackendPids(environmentText).includes(Number(pid));
}
function hasExpectedDashboardSignature(commandText, cwd) {
  const cmd = String(commandText || '');
  const tokens = commandTokens(cmd);
  const resolvedCwd = cwd ? path.resolve(cwd) : '';
  const cliPath = path.join(root, 'scripts/dev-stack/cli.js');
  const cracoRoot = `${path.join(root, 'node_modules/@craco/craco')}${path.sep}`;
  const vitePath = path.join(root, 'node_modules/vite/bin/vite.js');

  const supervisorCommand = tokens.includes(cliPath)
    || (resolvedCwd === root && tokens.includes('scripts/dev-stack/cli.js'));
  if (supervisorCommand && ['start', 'restart', 'monitor'].some(token => tokens.includes(token))) return true;
  if (resolvedCwd === root && (tokens.includes('server.js') || tokens.includes(path.join(root, 'server.js')))) return true;
  if (resolvedCwd === root && tokens.includes(vitePath) && tokens.includes('--strictPort')) return true;
  if (hasExactBridgeCommandSignature(commandText, cwd)) return true;
  if (hasExactControllerCommandSignature(commandText, cwd)) return true;
  if (tokens.some(token => token.startsWith(cracoRoot))
      && (tokens.includes('start') || tokens.some(token => token.endsWith('/start.js')))) return true;
  if (hasExactSidecarCommandSignature(commandText, cwd)) return true;
  if (hasExactAnalystSidecarCommandSignature(commandText, cwd)) return true;
  if (hasExactAnalystHermesCommandSignature(commandText, cwd)) return true;
  if ((resolvedCwd === root || resolvedCwd === sidecarDir)
      && (tokens.includes('scripts/ibkr_sidecar/start.sh') || tokens.includes(sidecarStartPath))) return true;
  if ((resolvedCwd === root || resolvedCwd === analystSidecarDir)
      && (tokens.includes('scripts/analyst_sidecar/start.sh') || tokens.includes(analystSidecarStartPath))) return true;
  if (resolvedCwd === root
      && (tokens.includes('scripts/analyst/start_hermes.sh') || tokens.includes(analystHermesStartPath))) return true;
  return false;
}
function ownershipLookup(pid, {
  cwdFor = processCwd,
  commandFor = processCommand,
  alive = isAlive,
} = {}) {
  if (!validProcessId(pid)) return { owned: false, inconclusive: false };
  const cwd = cwdFor(pid);
  const cmd = commandFor(pid);
  const owned = pathIsInRoot(cwd) && hasExpectedDashboardSignature(cmd, cwd);
  // A live process whose `ps`/`lsof` answer came back empty has an unknown
  // owner, not a foreign one.
  return { owned, inconclusive: !owned && (!cwd || !cmd) && alive(pid) };
}
function isOwned(pid) {
  return ownershipLookup(pid).owned;
}
// Decides whether a monitor tick learned anything about a port service. An
// unknown answer must hold the last observation: counting it as a failure is
// how a saturated host restarts a gateway that is still serving.
async function inspectServiceListener(port, previousPid, {
  lookup = listenerLookup,
  ownership = ownershipLookup,
  accepts = portAcceptsConnections,
} = {}) {
  const { pid, failed } = lookup(port);
  if (!pid) {
    const inconclusive = failed || await accepts(port);
    return { pid: null, owned: false, inconclusive };
  }
  const { owned, inconclusive } = ownership(pid);
  return { pid, owned, inconclusive: inconclusive && pid === Number(previousPid) };
}
function isAlive(pid) {
  if (!validProcessId(pid)) return false;
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}
function listProcessRows() {
  return execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', timeout: 5_000 })
    .split(/\r?\n/)
    .map((line) => String(line).match(/^\s*(\d+)\s+(.+)$/))
    .filter(Boolean)
    .map((match) => ({ pid: Number(match[1]), command: match[2] }))
    .filter(({ pid }) => Number.isInteger(pid) && pid > 0);
}
function discoverOwnedBridgeProcessIds({
  pids,
  commandFor = processCommand,
  cwdFor = processCwd,
  alive = isAlive,
} = {}) {
  // Reading the complete process table once is materially cheaper than
  // launching one `ps` process for every PID on the machine. The latter can
  // starve launchd-managed children and delay credential checks/recovery.
  const candidates = Array.isArray(pids)
    ? pids
    : listProcessRows()
      .filter(({ command }) => command.includes('hermes_snapshot_bridge.js'))
      .map(({ pid }) => pid);
  return [...new Set(candidates)]
    .filter(pid => Number.isInteger(Number(pid)) && Number(pid) > 0 && Number(pid) !== process.pid)
    .map(pid => Number(pid))
    .filter(pid => alive(pid))
    .filter((pid) => {
      const commandText = commandFor(pid);
      if (!String(commandText).includes('hermes_snapshot_bridge.js')) return false;
      return hasExactBridgeCommandSignature(commandText, cwdFor(pid));
    })
    .sort((left, right) => left - right);
}
function discoverOwnedSidecarProcessIds({
  pids,
  commandFor = processCommand,
  cwdFor = processCwd,
  alive = isAlive,
} = {}) {
  const candidates = Array.isArray(pids)
    ? pids
    : listProcessRows()
      .filter(({ command }) => (
        command.includes('uvicorn')
        && command.includes('app:app')
        && (
          command.includes(`--port ${services.sidecar.port}`)
          || command.includes(`--port=${services.sidecar.port}`)
        )
      ))
      .map(({ pid }) => pid);
  return [...new Set(candidates)]
    .filter(pid => Number.isInteger(Number(pid)) && Number(pid) > 0)
    .map(pid => Number(pid))
    .filter(pid => alive(pid))
    .filter((pid) => {
      const command = String(commandFor(pid) || '');
      // Avoid an lsof cwd lookup for every system process. Only a command with
      // the distinctive uvicorn/app/port shape can be this sidecar.
      if (!command.includes('uvicorn') || !command.includes('app:app')) return false;
      if (!command.includes(`--port ${services.sidecar.port}`)
          && !command.includes(`--port=${services.sidecar.port}`)) return false;
      return hasExactSidecarCommandSignature(command, cwdFor(pid));
    })
    .sort((left, right) => left - right);
}
function sidecarProcessSnapshot({
  pids,
  commandFor = processCommand,
  environmentFor = processEnvironment,
  cwdFor = processCwd,
  alive = isAlive,
  listener = () => listenerPid(services.sidecar.port),
} = {}) {
  const processPids = discoverOwnedSidecarProcessIds({ pids, commandFor, cwdFor, alive });
  const listenerPidValue = Number(listener()) || null;
  const managedProcessPids = processPids.filter(pid => (
    hasManagedSidecarRuntime(commandFor(pid), cwdFor(pid), environmentFor(pid))
  ));
  const listenerIsOwned = listenerPidValue !== null && processPids.includes(listenerPidValue);
  const listenerIsManaged = listenerIsOwned
    && hasManagedSidecarRuntime(
      commandFor(listenerPidValue),
      cwdFor(listenerPidValue),
      environmentFor(listenerPidValue),
    );
  const ownerPid = listenerIsManaged ? listenerPidValue : null;
  const startupPid = listenerPidValue === null && managedProcessPids.length === 1
    ? managedProcessPids[0]
    : null;
  const recommendedKeepPid = ownerPid || startupPid;
  const duplicatePids = processPids.filter(pid => pid !== recommendedKeepPid);
  return {
    processPids,
    managedProcessPids,
    processCount: processPids.length,
    managedProcessCount: managedProcessPids.length,
    ownerPid,
    recommendedKeepPid,
    duplicatePids,
    duplicateCount: duplicatePids.length,
    runtimeVerified: Boolean(recommendedKeepPid),
  };
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function restartPolicyFor({ history = [], now = Date.now(), critical = false, countFailure = true } = {}) {
  const recent = history.filter((time) => Number.isFinite(time) && now - time < restartWindowMs);
  if (countFailure) recent.push(now);
  if (critical && recent.length > 3) {
    return { history: recent, fatal: true, circuitOpenUntil: null, delayMs: null };
  }
  if (!critical && recent.length >= 5) {
    return {
      history: recent,
      fatal: false,
      circuitOpenUntil: new Date(now + circuitOpenMs).toISOString(),
      delayMs: null,
    };
  }
  return {
    history: recent,
    fatal: false,
    circuitOpenUntil: null,
    delayMs: Math.min(4_000, 1_000 * 2 ** Math.max(0, recent.length - 1)),
  };
}
async function httpOk(url, timeoutMs = 1_500) { try { const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) }); return response.ok; } catch { return false; } }
async function httpHealthProbe(url, timeoutMs = 1_500) {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetch(url, { signal, redirect: 'manual' });
    return { healthy: response.ok, transientFailure: false };
  } catch (error) {
    const code = error?.cause?.code || error?.code;
    const transientFailure = signal.aborted || [
      'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'EHOSTUNREACH',
      'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET',
    ].includes(code);
    return { healthy: false, transientFailure };
  }
}
function heartbeatAgeMs(value, now = Date.now()) {
  const observedAt = Date.parse(String(value || ''));
  if (!Number.isFinite(observedAt)) return null;
  const ageMs = now - observedAt;
  return ageMs < -30_000 ? null : Math.max(0, ageMs);
}
function processServiceStatus(name, item, now = Date.now()) {
  const service = services[name];
  const pid = Number(item?.pid) || null;
  const running = Boolean(pid && isAlive(pid));
  const owned = Boolean(running && isOwned(pid));
  const enabled = name !== 'bridge'
    || (typeof item?.enabled === 'boolean' ? item.enabled : hermesBridgeEnabled());
  if (!enabled) {
    const recordedErrorCode = item?.lastErrorCode || item?.errorCode || null;
    const disabledCleanly = !running
      && !recordedErrorCode
      && (!item?.status || item.status === 'disabled');
    return {
      pid,
      running,
      owned: disabledCleanly || owned,
      healthy: disabledCleanly,
      ready: disabledCleanly,
      enabled: false,
      intentionallyDisabled: true,
      status: disabledCleanly ? 'disabled' : (running && !owned ? 'blocked' : 'degraded'),
      lastHeartbeatAt: item?.lastHeartbeatAt || null,
      heartbeatAgeMs: null,
      lastResultStatus: 'disabled',
      lastErrorCode: disabledCleanly
        ? null
        : (recordedErrorCode || 'LOCAL_DISABLED_BRIDGE_PROCESS_PRESENT'),
      lastInputErrorCode: null,
      lastInputDetail: null,
      lastPublishErrorCode: null,
      lastPublishStage: null,
      lastPublishDetail: null,
      lastPublishFailures: [],
      lastDetail: disabledCleanly
        ? 'Both outbound bridge partitions are disabled.'
        : (item?.lastDetail
          || 'A bridge process is still running while outbound portfolio publishing is disabled.'),
      lastSuccessAt: null,
      lastFailureAt: null,
      awsProfile: null,
      ...(Array.isArray(item?.unexpectedPids)
        ? { unexpectedPids: [...item.unexpectedPids] }
        : {}),
      ...(typeof item?.discoveryVerified === 'boolean'
        ? { discoveryVerified: item.discoveryVerified }
        : {}),
    };
  }
  if (item?.credentialPreflightBlocked) {
    return {
      pid: null,
      running: false,
      owned: true,
      healthy: false,
      ready: false,
      enabled: true,
      intentionallyDisabled: false,
      status: 'blocked',
      lastHeartbeatAt: null,
      heartbeatAgeMs: null,
      lastResultStatus: 'error',
      lastErrorCode: item.lastErrorCode || item.errorCode || 'AWS_PROFILE_UNUSABLE',
      lastInputErrorCode: null,
      lastInputDetail: null,
      lastPublishErrorCode: item.lastPublishErrorCode || item.errorCode || 'AWS_PROFILE_UNUSABLE',
      lastPublishStage: null,
      lastPublishDetail: item.lastPublishDetail || item.lastDetail || null,
      lastPublishFailures: [],
      lastDetail: item.lastDetail || null,
      lastSuccessAt: item.lastSuccessAt || null,
      lastFailureAt: item.lastFailureAt || null,
      awsProfile: item.awsProfile || null,
      credentialPreflightBlocked: true,
      credentialPreflightCheckedAt: item.credentialPreflightCheckedAt || null,
      nextCredentialPreflightAt: item.nextCredentialPreflightAt || null,
    };
  }
  const age = heartbeatAgeMs(item?.lastHeartbeatAt, now);
  const fresh = age != null && age <= service.heartbeatMaxAgeMs;
  let status = 'down';
  if (running && !owned) status = 'blocked';
  else if (running && !item?.lastHeartbeatAt) status = 'starting';
  else if (running && (!fresh || item?.lastResultStatus !== 'ready')) status = 'degraded';
  else if (running) status = 'ready';
  return {
    pid,
    running,
    owned,
    healthy: status === 'ready',
    ready: status === 'ready',
    enabled: true,
    intentionallyDisabled: false,
    status,
    lastHeartbeatAt: item?.lastHeartbeatAt || null,
    heartbeatAgeMs: age,
    lastResultStatus: item?.lastResultStatus || null,
    lastErrorCode: item?.lastErrorCode || null,
    lastInputErrorCode: item?.lastInputErrorCode || null,
    lastInputDetail: item?.lastInputDetail || null,
    lastPublishErrorCode: item?.lastPublishErrorCode || null,
    lastPublishStage: item?.lastPublishStage || null,
    lastPublishDetail: item?.lastPublishDetail || null,
    lastPublishFailures: Array.isArray(item?.lastPublishFailures)
      ? item.lastPublishFailures
      : [],
    lastDetail: item?.lastDetail || null,
    lastSuccessAt: item?.lastSuccessAt || null,
    lastFailureAt: item?.lastFailureAt || null,
    awsProfile: item?.awsProfile || null,
    ...(name === 'controller' ? {
      mode: item?.mode || null,
      controllerStatus: item?.controllerStatus || null,
      incidentCount: Number(item?.incidentCount || 0),
      circuitCount: Number(item?.circuitCount || 0),
      inFlightAction: item?.inFlightAction || null,
      nextRetryAt: item?.nextRetryAt || null,
    } : {}),
  };
}

function applyBridgeStatusPayload(item, payload, observedAt = new Date().toISOString()) {
  if (!item || !payload || !['ready', 'error', 'degraded'].includes(payload.status)) return false;
  item.lastHeartbeatAt = payload.observedAt || observedAt;
  item.lastResultStatus = payload.status === 'ready' ? 'ready' : 'error';
  item.lastInputErrorCode = payload.inputErrorCode || payload.input?.errorCode || null;
  item.lastInputDetail = payload.input?.detail || null;
  item.lastPublishErrorCode = payload.publishErrorCode || payload.publish?.errorCode || null;
  item.lastPublishStage = payload.publishStage || payload.publish?.stage || null;
  item.lastPublishDetail = payload.publish?.detail || null;
  item.lastPublishFailures = Array.isArray(payload.publish?.failures)
    ? payload.publish.failures.map(failure => ({
      stage: failure?.stage || null,
      errorCode: failure?.errorCode || null,
      detail: failure?.detail || null,
    }))
    : [];
  item.awsProfile = payload.awsProfile || item.awsProfile || null;
  item.lastErrorCode = item.lastPublishErrorCode
    || item.lastInputErrorCode
    || payload.errorCode
    || null;
  item.lastDetail = payload.detail
    || payload.publish?.detail
    || payload.input?.detail
    || null;
  if (item.lastResultStatus === 'ready') {
    item.lastSuccessAt = item.lastHeartbeatAt;
  } else {
    item.lastFailureAt = item.lastHeartbeatAt;
  }
  return true;
}

function applyControllerStatusPayload(item, payload, observedAt = new Date().toISOString()) {
  if (!item || !['dashboard-readiness-controller', 'hermes-reliability-controller'].includes(payload?.service)
      || !['ready', 'degraded'].includes(payload.status)) {
    return false;
  }
  item.lastHeartbeatAt = payload.observedAt || observedAt;
  item.lastResultStatus = payload.status === 'ready' ? 'ready' : 'error';
  item.lastErrorCode = payload.errorCode || null;
  item.lastDetail = payload.detail || null;
  item.mode = payload.mode || null;
  item.enabledActionIds = Array.isArray(payload.enabledActionIds)
    ? payload.enabledActionIds
    : [];
  item.buildFingerprint = payload.buildFingerprint || null;
  item.shadowSoakStartedAt = payload.shadowSoakStartedAt || null;
  item.controllerStatus = payload.controllerStatus || null;
  item.incidentCount = Number(payload.incidentCount || 0);
  item.circuitCount = Number(payload.circuitCount || 0);
  item.inFlightAction = payload.inFlightAction || null;
  item.nextRetryAt = payload.nextRetryAt || null;
  item.lastInputErrorCode = null;
  item.lastInputDetail = null;
  item.lastPublishErrorCode = null;
  item.lastPublishStage = null;
  item.lastPublishDetail = null;
  item.lastPublishFailures = [];
  item.awsProfile = null;
  if (item.lastResultStatus === 'ready') item.lastSuccessAt = item.lastHeartbeatAt;
  else item.lastFailureAt = item.lastHeartbeatAt;
  return true;
}

function rotate(file) {
  try {
    if (fs.statSync(file).size < maxLogBytes) return;
    for (let n = 4; n >= 1; n--) { const from = `${file}.${n}`; const to = `${file}.${n + 1}`; if (fs.existsSync(from)) fs.renameSync(from, to); }
    fs.renameSync(file, `${file}.1`);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
function streamToLog(stream, file, onActivity) {
  stream.on('data', chunk => {
    try {
      rotate(file);
      fs.appendFileSync(file, chunk);
    } catch (error) {
      if (!['ENOSPC', 'EDQUOT'].includes(error?.code)) {
        console.error(`[dashboard-supervisor] Could not append ${path.basename(file)}: ${error.message}`);
      }
    }
    onActivity?.(chunk);
  });
}
function childFor(name, onActivity) {
  const service = services[name];
  const file = path.join(logDir, `${name}.log`);
  const options = { cwd: root, env: childEnvironment(name), stdio: name === 'api' ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'] };
  const child = service.shell ? spawn('bash', service.args, options) : spawn(process.execPath, service.args, options);
  streamToLog(child.stdout, file, chunk => onActivity?.('stdout', chunk));
  streamToLog(child.stderr, file, chunk => onActivity?.('stderr', chunk));
  return child;
}
function assertPorts() {
  for (const service of Object.values(services)) {
    if (!service.port || !service.critical) continue;
    const pid = listenerPid(service.port);
    if (!pid) continue;
    if (isOwned(pid)) continue;
    throw new Error(`Port ${service.port} is occupied by unknown PID ${pid}: ${processCommand(pid)}`);
  }
}
async function terminate(pid) {
  if (!pid || !isAlive(pid)) return;
  try { process.kill(pid, 'SIGTERM'); } catch { return; }
  for (let n = 0; n < 10 && isAlive(pid); n++) await sleep(1000);
  if (isAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* Process may have already exited. */ } }
}
async function reconcileOrphanedAnalystHermes({
  listener = () => listenerPid(services.analystHermes.port),
  commandFor = processCommand,
  environmentFor = processEnvironment,
  parentPidFor = processParentPid,
  alive = isAlive,
  terminateProcess = terminate,
} = {}) {
  const pid = Number(listener()) || null;
  if (!pid || isOwned(pid)) return { recovered: false, pid };
  const recoverable = isRecoverableOrphanedAnalystHermes({
    pid,
    commandText: commandFor(pid),
    environmentText: environmentFor(pid),
    parentPid: parentPidFor(pid),
    alive,
  });
  if (!recoverable) return { recovered: false, pid };

  await terminateProcess(pid);
  const remainingPid = Number(listener()) || null;
  if (remainingPid === pid && alive(pid)) {
    throw new Error(`Orphaned Analyst Hermes PID ${pid} did not stop.`);
  }
  console.warn(
    `[dashboard-supervisor] Reclaimed detached Analyst Hermes PID ${pid} after a Hermes update handoff.`,
  );
  return { recovered: true, pid };
}
async function reconcileDisabledBridgeProcesses({
  discover = discoverOwnedBridgeProcessIds,
  terminateProcess = terminate,
} = {}) {
  let discoveredPids;
  try {
    discoveredPids = discover();
  } catch (error) {
    return {
      verified: false,
      clean: false,
      discoveredPids: [],
      terminatedPids: [],
      remainingPids: [],
      errorCode: 'LOCAL_BRIDGE_PROCESS_DISCOVERY_FAILED',
      detail: String(error?.message || error || 'Bridge process discovery failed.').slice(0, 500),
    };
  }

  const terminatedPids = [];
  for (const pid of discoveredPids) {
    try {
      await terminateProcess(pid);
      terminatedPids.push(pid);
    } catch {
      // The verification pass below decides whether disabled mode is clean.
    }
  }

  let remainingPids;
  try {
    remainingPids = discover();
  } catch (error) {
    return {
      verified: false,
      clean: false,
      discoveredPids,
      terminatedPids,
      remainingPids: [],
      errorCode: 'LOCAL_BRIDGE_PROCESS_DISCOVERY_FAILED',
      detail: String(error?.message || error || 'Bridge process verification failed.').slice(0, 500),
    };
  }
  return {
    verified: true,
    clean: remainingPids.length === 0,
    discoveredPids,
    terminatedPids,
    remainingPids,
    errorCode: remainingPids.length > 0 ? 'LOCAL_DISABLED_BRIDGE_PROCESS_PRESENT' : null,
    detail: remainingPids.length > 0
      ? `Exact repo-owned bridge process${remainingPids.length === 1 ? '' : 'es'} still running: ${remainingPids.join(', ')}.`
      : 'Both outbound bridge partitions are disabled.',
  };
}
async function reconcileOwnedSidecarProcesses({
  keepPid = null,
  discover = discoverOwnedSidecarProcessIds,
  terminateProcess = terminate,
} = {}) {
  let discoveredPids;
  try {
    discoveredPids = discover();
  } catch (error) {
    return {
      verified: false,
      clean: false,
      discoveredPids: [],
      terminatedPids: [],
      remainingPids: [],
      keepPid: null,
      errorCode: 'IBKR_SIDECAR_PROCESS_DISCOVERY_FAILED',
      detail: String(error?.message || error || 'Sidecar process discovery failed.').slice(0, 500),
    };
  }

  const retainedPid = validProcessId(keepPid) && discoveredPids.includes(Number(keepPid))
    ? Number(keepPid)
    : null;
  const stalePids = discoveredPids.filter(pid => pid !== retainedPid);
  // Signal the exact stale set concurrently. A wedged IBKR socket may take
  // the full termination grace period; serial cleanup would multiply that
  // delay by the number of orphaned clients and hold the whole dashboard down.
  const terminationResults = await Promise.allSettled(
    stalePids.map(pid => terminateProcess(pid)),
  );
  const terminatedPids = stalePids.filter((_, index) => (
    terminationResults[index]?.status === 'fulfilled'
  ));

  let remainingPids;
  try {
    remainingPids = discover();
  } catch (error) {
    return {
      verified: false,
      clean: false,
      discoveredPids,
      terminatedPids,
      remainingPids: [],
      keepPid: retainedPid,
      errorCode: 'IBKR_SIDECAR_PROCESS_DISCOVERY_FAILED',
      detail: String(error?.message || error || 'Sidecar process verification failed.').slice(0, 500),
    };
  }

  const clean = retainedPid === null
    ? remainingPids.length === 0
    : remainingPids.length === 1 && remainingPids[0] === retainedPid;
  return {
    verified: true,
    clean,
    discoveredPids,
    terminatedPids,
    remainingPids,
    keepPid: retainedPid,
    errorCode: clean ? null : 'IBKR_SIDECAR_DUPLICATES',
    detail: clean
      ? 'Exactly one managed sidecar is retained.'
      : `Repo-owned sidecar processes remain after cleanup: ${remainingPids.join(', ') || 'none'}.`,
  };
}

async function reconcileSidecarOwnership({
  snapshot = sidecarProcessSnapshot,
  reconcile = reconcileOwnedSidecarProcesses,
} = {}) {
  let before = null;
  let cleanup = null;
  try {
    before = snapshot();
    cleanup = await reconcile({ keepPid: before.recommendedKeepPid });
    if (!cleanup.verified) return { verified: false, before, cleanup, after: null };
    const after = snapshot();
    return { verified: true, before, cleanup, after };
  } catch (error) {
    // A timed-out process-table read says nothing about which processes are
    // absent or safe to replace. Keep the core monitor alive and retry later.
    return {
      verified: false, before, after: null,
      cleanup: {
        ...(cleanup || {}), verified: false, clean: false,
        errorCode: 'IBKR_SIDECAR_PROCESS_DISCOVERY_FAILED',
        detail: `Sidecar ownership inspection failed (${error?.code || 'INSPECTION_FAILED'}).`,
      },
    };
  }
}

async function stop(options = {}) {
  const quiet = options.quiet === true;
  const preserveState = options.preserveState === true;
  const state = options.state || readState();
  const supervisorPid = state?.supervisor?.pid;
  const stopOwnedSupervisor = supervisorPid && supervisorPid !== process.pid && isOwned(supervisorPid);
  if (stopOwnedSupervisor) {
    // Tell its monitor to stop scheduling replacements before a child exits.
    try { process.kill(supervisorPid, 'SIGTERM'); } catch { /* It may have already exited. */ }
  }
  // The running supervisor may be an older generation whose shutdown order
  // leaves the repair controller active. Quiesce that known child first.
  const controllerPid = state?.children?.controller?.pid;
  if (isOwned(controllerPid)) await terminate(controllerPid);
  else if (isAlive(controllerPid)) console.warn(`Refusing to stop unknown controller PID ${controllerPid}.`);
  if (supervisorPid && supervisorPid !== process.pid) {
    if (stopOwnedSupervisor && isOwned(supervisorPid)) await terminate(supervisorPid);
    else if (isAlive(supervisorPid)) console.warn(`Refusing to stop unknown supervisor PID ${supervisorPid}.`);
  }
  await stopServicesInOrder(Object.keys(state?.children || {}), async name => {
    const item = state.children[name];
    if (isOwned(item.pid)) await terminate(item.pid);
    else if (isAlive(item.pid)) console.warn(`Refusing to stop unknown child PID ${item.pid}.`);
  });
  for (const service of Object.values(services)) {
    if (!service.port) continue;
    const pid = listenerPid(service.port);
    if (!pid) continue;
    if (isOwned(pid)) await terminate(pid);
    else console.warn(`Refusing to stop unknown listener PID ${pid} on port ${service.port}.`);
  }
  const sidecarCleanup = await reconcileOwnedSidecarProcesses({ keepPid: null });
  if (!sidecarCleanup.clean && !quiet) {
    console.warn(`[dashboard-supervisor] IBKR sidecar cleanup incomplete: ${sidecarCleanup.detail}`);
  }
  if (!preserveState) removeState();
  if (!quiet) console.log('Dashboard stack stopped.');
}
async function waitFor(name, timeout = 30000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (readState()?.children?.[name]?.credentialPreflightBlocked) return false;
    if (services[name].processOnly) {
      if (processServiceStatus(name, readState()?.children?.[name]).ready) return true;
    } else if (await httpOk(services[name].health, services[name].healthTimeoutMs)) return true;
    await sleep(500);
  }
  return false;
}
async function runMonitor() {
  ensureDirs();
  analystRuntimeEnvironment = createAnalystRuntimeEnvironment();
  assertPorts();
  const previousState = readState();
  const bridgeEnabled = hermesBridgeEnabled();
  const activeServiceNames = supervisedServiceNames();
  const notificationsActive = localNotificationsEnabled();
  // Run the two exact-principal checks before any long-lived child has a pipe
  // attached to this supervisor. A synchronous AWS CLI probe after uvicorn or
  // the UI starts can stall while those child pipes are active. The API and
  // Analyst sidecar intentionally share the same approved API principal.
  const startupAwsPreflights = {
    api: preflightAwsService('api'),
    bridge: bridgeEnabled ? preflightAwsService('bridge') : null,
  };
  const state = {
    version: 2,
    root,
    startedAt: new Date().toISOString(),
    sourceFingerprint: computeRuntimeFingerprint(root),
    bridgeEnabled,
    analystContract: {
      verified: false,
      checkedAt: null,
      error: 'The Analyst services have not completed their startup contract check.',
    },
    supervisor: { pid: process.pid },
    children: {},
    notifications: notificationsActive && previousState?.notifications
      ? { ...previousState.notifications }
      : {},
  };
  const children = {};
  const histories = {};
  const restartPending = new Set();
  const processOutputBuffers = {
    bridge: { stdout: '', stderr: '' },
    controller: { stdout: '', stderr: '' },
  };
  let timer = null;
  let reconciling = false;

  function observeServiceNotification(name, serviceState, observedAt = new Date().toISOString()) {
    if (!notificationsActive) return null;
    const planned = planServiceNotificationTransition({
      name,
      serviceState,
      previous: state.notifications[name] || null,
      observedAt,
    });
    if (planned.next) state.notifications[name] = planned.next;
    if (!planned.event) return null;
    const delivery = sendMacNotification(planned.event);
    state.notifications[name] = {
      ...state.notifications[name],
      lastNotificationAt: observedAt,
      notificationDelivered: delivery.delivered,
      notificationError: delivery.delivered ? null : delivery.reason,
    };
    return planned.event;
  }

  function recordActivity(name, pid, streamName, chunk) {
    if (!state.children[name] || state.children[name].pid !== pid) return;
    const item = state.children[name];
    if (name === 'bridge' || name === 'controller') {
      const outputBuffers = processOutputBuffers[name];
      outputBuffers[streamName] += String(chunk);
      const lines = outputBuffers[streamName].split(/\r?\n/);
      outputBuffers[streamName] = lines.pop() || '';
      let parsedStatus = false;
      for (const line of lines.filter(Boolean)) {
        try {
          const payload = JSON.parse(line);
          parsedStatus = (
            name === 'bridge'
              ? applyBridgeStatusPayload(item, payload)
              : applyControllerStatusPayload(item, payload)
          ) || parsedStatus;
        } catch {
          const fatalPattern = name === 'bridge'
            ? /\[hermes-bridge\]\s+fatal:/i
            : /\[(?:readiness-controller|hermes-reliability-controller)\]\s+fatal:/i;
          if (streamName === 'stderr' && fatalPattern.test(line)) {
            const observedAt = new Date().toISOString();
            parsedStatus = true;
            item.lastHeartbeatAt = observedAt;
            item.lastResultStatus = 'error';
            item.lastErrorCode = name === 'bridge'
              ? 'HERMES_BRIDGE_PROCESS_ERROR'
              : 'HERMES_CONTROLLER_PROCESS_ERROR';
            item.lastInputErrorCode = null;
            item.lastInputDetail = null;
            item.lastPublishErrorCode = null;
            item.lastPublishStage = null;
            item.lastPublishDetail = null;
            item.lastPublishFailures = [];
            item.lastDetail = line.slice(0, 500);
            item.lastFailureAt = observedAt;
          }
        }
      }
      if (parsedStatus) {
        item.status = processServiceStatus(name, item).status;
        observeServiceNotification(name, item, item.lastHeartbeatAt);
      }
    }
    writeState(state);
  }

  async function startOne(name, {
    initial = false,
    awsPreflightResult,
  } = {}) {
    const service = services[name];
    if (['analystSidecar', 'analystHermes'].includes(name)) analystVerification.invalidate();
    if (processOutputBuffers[name]) {
      processOutputBuffers[name].stdout = '';
      processOutputBuffers[name].stderr = '';
    }
    if (name === 'sidecar') {
      // A restart must begin from a single clean sidecar. The process scan is
      // restricted to this repository's exact sidecar command and cwd, so an
      // unrelated API client or Gateway listener is never touched.
      const cleanup = await reconcileOwnedSidecarProcesses({ keepPid: null });
      if (!cleanup.verified || !cleanup.clean) {
        state.children.sidecar = {
          ...(state.children.sidecar || {}),
          status: 'degraded',
          errorCode: cleanup.errorCode,
          lastDetail: cleanup.detail,
          sidecarProcessCleanup: cleanup,
        };
        writeState(state);
        return false;
      }
    }
    let existing = service.processOnly
      ? Number((initial ? previousState : state)?.children?.[name]?.pid) || null
      : listenerPid(service.port);
    if (existing && !isAlive(existing)) existing = null;
    const existingOwned = Boolean(existing && isOwned(existing));
    if (existing && !existingOwned) {
      state.children[name] = {
        pid: existing,
        external: true,
        status: 'blocked',
        errorCode: 'LOCAL_PORT_OWNERSHIP_CONFLICT',
        healthFailures: 0,
      };
      writeState(state);
      return false;
    }

    const awsPreflight = awsPreflightResult === undefined
      ? preflightAwsService(name)
      : awsPreflightResult;
    if (awsPreflight && !awsPreflight.ok) {
      if (existingOwned) await terminate(existing);
      state.children[name] = credentialPreflightFailureState(name, awsPreflight, {
        previous: (initial ? previousState : state)?.children?.[name] || {},
      });
      observeServiceNotification(name, state.children[name]);
      writeState(state);
      return false;
    }

    if (['api', 'analystSidecar', 'analystHermes'].includes(name) && existingOwned) {
      // These three processes share supervisor-scoped credentials. A process
      // left behind by an older supervisor must never be adopted with a token
      // the newly-started peers do not possess.
      await terminate(existing);
      existing = null;
    }
    if (service.processOnly && existingOwned) {
      await terminate(existing);
      existing = null;
    }
    if (existingOwned && existing) {
      state.children[name] = {
        pid: existing,
        external: true,
        status: await httpOk(service.health, service.healthTimeoutMs) ? 'ready' : 'starting',
        startedAt: new Date().toISOString(),
        healthFailures: 0,
        restarts: (histories[name] || []).length,
      };
      writeState(state);
      return true;
    }
    const child = childFor(name, (streamName, chunk) => recordActivity(name, child.pid, streamName, chunk));
    children[name] = child;
    if (name === 'api') child.on('message', message => {
      if (message?.type === CONTRACT_READY_MESSAGE
          && message.generation === analystRuntimeEnvironment.MARKET_DASHBOARD_SUPERVISOR_GENERATION
          && children.api === child) sendAnalystContract();
    });
    state.children[name] = {
      pid: child.pid,
      external: false,
      status: 'starting',
      startedAt: new Date().toISOString(),
      healthFailures: 0,
      restarts: (histories[name] || []).length,
      ...(service.processOnly ? {
        enabled: true,
        intentionallyDisabled: false,
        lastHeartbeatAt: null,
        lastResultStatus: 'starting',
        lastErrorCode: null,
        lastInputErrorCode: null,
        lastInputDetail: null,
        lastPublishErrorCode: null,
        lastPublishStage: null,
        lastPublishDetail: null,
        lastPublishFailures: [],
        awsProfile: name === 'bridge' ? configuredBridgeAwsProfile() : null,
      } : {}),
      ...(name === 'sidecar' ? {
        sidecarProcessPids: [],
        managedSidecarProcessPids: [],
        sidecarProcessCount: 0,
        managedSidecarProcessCount: 0,
        duplicatePids: [],
        duplicateCount: 0,
        sidecarRuntimeVerified: false,
      } : {}),
    };
    writeState(state);
    child.on('error', (error) => {
      if (state.children[name]?.pid !== child.pid) return;
      state.children[name] = {
        ...state.children[name],
        status: 'degraded',
        errorCode: error.code || 'LOCAL_PROCESS_SPAWN_ERROR',
        error: error.message,
      };
      observeServiceNotification(name, state.children[name]);
      writeState(state);
    });
    child.on('exit', (code, signal) => {
      if (children[name] === child) delete children[name];
      if (state.stopping || state.children[name]?.pid !== child.pid) return;
      if (['analystSidecar', 'analystHermes'].includes(name)) analystVerification.invalidate();
      void scheduleRestart(name, { code, signal, reason: 'process-exit' });
    });
    return true;
  }

  async function reconcileSidecarState({ restartIfMissing = true } = {}) {
    const { verified, before, cleanup, after } = await reconcileSidecarOwnership();
    const item = state.children.sidecar;
    if (!verified) {
      if (item) {
        item.status = 'degraded';
        item.errorCode = cleanup.errorCode;
        item.lastDetail = cleanup.detail;
        item.sidecarRuntimeVerified = false;
        item.sidecarProcessCount = null;
        item.managedSidecarProcessCount = null;
        item.sidecarProcessCleanup = cleanup;
        writeState(state);
      }
      return { before, cleanup, after, restarted: false };
    }
    if (item) {
      item.sidecarProcessPids = after.processPids;
      item.managedSidecarProcessPids = after.managedProcessPids;
      item.sidecarProcessCount = after.processCount;
      item.managedSidecarProcessCount = after.managedProcessCount;
      item.duplicatePids = after.duplicatePids;
      item.duplicateCount = after.duplicateCount;
      item.sidecarRuntimeVerified = after.runtimeVerified;
      item.sidecarProcessCleanup = cleanup;
      if (!cleanup.verified || !cleanup.clean || after.duplicateCount > 0) {
        item.status = 'degraded';
        item.errorCode = cleanup.errorCode || 'IBKR_SIDECAR_DUPLICATES';
        item.lastDetail = cleanup.detail;
      } else if (item.errorCode === 'IBKR_SIDECAR_DUPLICATES'
          || item.errorCode === 'IBKR_SIDECAR_PROCESS_DISCOVERY_FAILED') {
        item.errorCode = null;
        item.lastDetail = null;
      }
      if (cleanup.terminatedPids.length > 0) {
        console.warn(
          `[dashboard-supervisor] Reconciled IBKR sidecar PIDs: ${cleanup.terminatedPids.join(', ')}`,
        );
      }
      writeState(state);
    }

    const listener = listenerPid(services.sidecar.port);
    const shouldStart = restartIfMissing
      && !state.stopping
      && after.processCount === 0
      && !listener
      && !restartPending.has('sidecar');
    if (shouldStart) await startOne('sidecar');
    return { before, cleanup, after, restarted: shouldStart };
  }

  let analystContractRevision = 0;
  function sendAnalystContract() {
    const api = children.api;
    if (!api?.connected) return;
    api.send({
      type: CONTRACT_MESSAGE,
      generation: analystRuntimeEnvironment.MARKET_DASHBOARD_SUPERVISOR_GENERATION,
      revision: analystContractRevision,
      verified: state.analystContract.verified === true,
      checkedAt: state.analystContract.checkedAt || null,
      hermesPid: Number(state.children.analystHermes?.pid) || null,
      sidecarPid: Number(state.children.analystSidecar?.pid) || null,
    }, () => {});
  }
  const analystVerification = createAnalystVerificationController({
    verify: signal => runAnalystContractCheck({ signal }),
    publish(result) {
      state.analystContract = result;
      analystContractRevision += 1;
      sendAnalystContract();
      writeState(state);
    },
  });
  async function verifyAnalystHermesAfterRestart() {
    const ready = await Promise.all([
      waitFor('analystSidecar', 90_000), waitFor('analystHermes', 90_000),
    ]);
    if (state.stopping || !ready.every(Boolean)) return false;
    return analystVerification.check();
  }

  async function terminateOwnedService(name) {
    const service = services[name];
    const pid = service.processOnly
      ? Number(state.children[name]?.pid) || null
      : listenerPid(service.port);
    if (!pid || !isAlive(pid)) return true;
    if (!isOwned(pid)) {
      if (name === 'analystHermes') {
        const handoff = await reconcileOrphanedAnalystHermes();
        if (handoff.recovered) return true;
      }
      state.children[name] = {
        ...state.children[name],
        pid,
        status: 'blocked',
        errorCode: 'LOCAL_PORT_OWNERSHIP_CONFLICT',
      };
      writeState(state);
      return false;
    }
    await terminate(pid);
    if (children[name]?.pid === pid) delete children[name];
    return true;
  }

  async function scheduleRestart(name, context = {}) {
    if (state.stopping || restartPending.has(name)) return;
    const service = services[name];
    if (['analystSidecar', 'analystHermes'].includes(name)) analystVerification.invalidate();
    const circuitUntil = Date.parse(String(state.children[name]?.circuitOpenUntil || ''));
    if (Number.isFinite(circuitUntil) && circuitUntil > Date.now()) return;
    observeServiceNotification(name, {
      ...state.children[name],
      status: 'down',
      healthFailures: Math.max(
        healthFailureThreshold,
        Number(state.children[name]?.healthFailures || 0),
      ),
      errorCode: state.children[name]?.errorCode
        || `LOCAL_${name.toUpperCase()}_${context.reason === 'process-exit' ? 'PROCESS_EXIT' : 'UNHEALTHY'}`,
    });
    restartPending.add(name);
    try {
      const policy = restartPolicyFor({
        history: histories[name] || [],
        critical: service.critical === true,
        countFailure: context.countFailure !== false,
      });
      histories[name] = policy.history;
      if (policy.fatal) {
        state.children[name] = {
          ...state.children[name],
          status: 'failed',
          errorCode: 'LOCAL_CRITICAL_RESTART_LIMIT',
          code: context.code ?? null,
          signal: context.signal ?? null,
          restartReason: context.reason || null,
        };
        state.stopping = true;
        writeState(state);
        await stop({ quiet: true, preserveState: true, state });
        process.exit(1);
      }
      if (policy.circuitOpenUntil) {
        await terminateOwnedService(name);
        state.children[name] = {
          ...state.children[name],
          status: 'degraded',
          errorCode: 'LOCAL_RESTART_CIRCUIT_OPEN',
          circuitOpenUntil: policy.circuitOpenUntil,
          retryInMs: null,
          restartReason: context.reason || null,
          restarts: policy.history.length,
        };
        writeState(state);
        return;
      }

      state.children[name] = {
        ...state.children[name],
        status: 'restarting',
        errorCode: null,
        circuitOpenUntil: null,
        code: context.code ?? null,
        signal: context.signal ?? null,
        retryInMs: policy.delayMs,
        restartReason: context.reason || null,
        restarts: policy.history.length,
      };
      writeState(state);
      await sleep(policy.delayMs);
      if (state.stopping) return;
      if (!(await terminateOwnedService(name))) return;
      const started = await startOne(name);
      if (started && ['analystSidecar', 'analystHermes'].includes(name)) {
        await verifyAnalystHermesAfterRestart();
      }
    } finally {
      restartPending.delete(name);
    }
  }

  async function reconcileDisabledBridgeState() {
    const reconciliation = await reconcileDisabledBridgeProcesses();
    const remainingPids = reconciliation.remainingPids || [];
    state.children.bridge = {
      pid: remainingPids[0] || null,
      enabled: false,
      intentionallyDisabled: true,
      status: reconciliation.clean ? 'disabled' : 'degraded',
      healthFailures: 0,
      restarts: 0,
      lastHeartbeatAt: null,
      lastResultStatus: 'disabled',
      lastErrorCode: reconciliation.errorCode,
      lastInputErrorCode: null,
      lastInputDetail: null,
      lastPublishErrorCode: null,
      lastPublishStage: null,
      lastPublishDetail: null,
      lastPublishFailures: [],
      lastDetail: reconciliation.detail,
      lastSuccessAt: null,
      lastFailureAt: reconciliation.clean ? null : new Date().toISOString(),
      awsProfile: null,
      unexpectedPids: remainingPids,
      discoveryVerified: reconciliation.verified,
      terminatedPids: reconciliation.terminatedPids,
    };
    return reconciliation;
  }

  if (!bridgeEnabled) {
    await reconcileDisabledBridgeState();
  }
  // Core listeners start before optional analysis. Verification runs in an
  // asynchronous child so monitoring and output draining never pause for it.
  for (const name of ['ui', 'api', 'sidecar', 'controller', 'bridge']) {
    if (!activeServiceNames.includes(name)) continue;
    await startOne(name, {
      initial: true,
      awsPreflightResult: name === 'api' ? startupAwsPreflights.api
        : (name === 'bridge' ? startupAwsPreflights.bridge : undefined),
    });
  }
  async function startOptionalAnalyst() {
    try {
      await startOne('analystSidecar', { initial: true, awsPreflightResult: startupAwsPreflights.api });
      await reconcileOrphanedAnalystHermes();
      await startOne('analystHermes', { initial: true });
      await verifyAnalystHermesAfterRestart();
    } catch (_) {
      analystVerification.invalidate('The optional Analyst runtime could not start.');
    }
  }
  void startOptionalAnalyst();
  for (const name of ['api', 'ui']) {
    if (state.children[name]?.credentialPreflightBlocked) continue;
    state.children[name].status = await waitFor(name) ? 'ready' : 'starting';
  }
  if (state.children.sidecar) state.children.sidecar.status = await waitFor('sidecar', 5000) ? 'ready' : 'degraded';
  if (state.children.sidecar) await reconcileSidecarState({ restartIfMissing: false });
  if (state.children.controller) {
    state.children.controller.status = await waitFor('controller', 5000) ? 'ready' : 'degraded';
  }
  if (
    bridgeEnabled
    && state.children.bridge
    && !state.children.bridge.credentialPreflightBlocked
  ) {
    state.children.bridge.status = await waitFor('bridge', 5000) ? 'ready' : 'degraded';
  }
  for (const [name, item] of Object.entries(state.children)) {
    observeServiceNotification(name, item);
  }
  writeState(state);
  const degradedServices = ['sidecar', 'analystSidecar', 'analystHermes', 'controller', ...(bridgeEnabled ? ['bridge'] : [])]
    .filter(name => state.children[name]?.status !== 'ready');
  console.log(`Dashboard ${degradedServices.length === 0 ? 'READY' : `DEGRADED: ${degradedServices.join(', ')} unavailable`} (UI :3000, API :3001)`);
  timer = setInterval(async () => {
    if (reconciling || state.stopping) return;
    reconciling = true;
    try {
      if (!bridgeEnabled) {
        await reconcileDisabledBridgeState();
        observeServiceNotification('bridge', state.children.bridge);
      }
      if (state.children.sidecar && !restartPending.has('sidecar')) {
        await reconcileSidecarState();
      }
      for (const name of activeServiceNames) {
        const service = services[name];
        const item = state.children[name];
        if (!item || restartPending.has(name)) continue;
        if (name === 'sidecar' && item.sidecarProcessCleanup?.verified === false) {
          // Unknown ownership is not a failed health probe. Never escalate it
          // into a restart or an additional sidecar process.
          observeServiceNotification(name, item);
          continue;
        }
        if (item.credentialPreflightBlocked) {
          const retryAt = Date.parse(String(item.nextCredentialPreflightAt || ''));
          if (Number.isFinite(retryAt) && retryAt > Date.now()) continue;
          const awsPreflight = preflightAwsService(name);
          if (awsPreflight && !awsPreflight.ok) {
            state.children[name] = credentialPreflightFailureState(name, awsPreflight, {
              previous: item,
            });
            observeServiceNotification(name, state.children[name]);
            continue;
          }
          await startOne(name, { awsPreflightResult: awsPreflight });
          continue;
        }
        const circuitUntil = Date.parse(String(item.circuitOpenUntil || ''));
        if (Number.isFinite(circuitUntil) && circuitUntil > Date.now()) {
          item.status = 'degraded';
          continue;
        }
        if (Number.isFinite(circuitUntil) && circuitUntil <= Date.now()) {
          item.circuitOpenUntil = null;
          item.errorCode = null;
          void scheduleRestart(name, { reason: 'circuit-reset', countFailure: false });
          continue;
        }

        if (service.processOnly) {
          const snapshot = processServiceStatus(name, item);
          Object.assign(item, snapshot);
          const startupAge = heartbeatAgeMs(item.startedAt);
          const staleOrDead = !snapshot.running
            || (snapshot.heartbeatAgeMs != null && snapshot.heartbeatAgeMs > service.heartbeatMaxAgeMs)
            || (snapshot.heartbeatAgeMs == null && startupAge != null && startupAge > service.heartbeatMaxAgeMs);
          if (!snapshot.owned && snapshot.running) {
            item.status = 'blocked';
            item.errorCode = 'LOCAL_PORT_OWNERSHIP_CONFLICT';
            observeServiceNotification(name, item);
            continue;
          }
          item.healthFailures = staleOrDead ? Number(item.healthFailures || 0) + 1 : 0;
          if (snapshot.ready) item.lastHealthyAt = new Date().toISOString();
        } else {
          const inspection = await inspectServiceListener(service.port, item.pid);
          if (inspection.inconclusive) {
            item.inconclusiveInspections = Number(item.inconclusiveInspections || 0) + 1;
            observeServiceNotification(name, item);
            continue;
          }
          item.inconclusiveInspections = 0;
          const { pid, owned } = inspection;
          const analystDependency = ['analystSidecar', 'analystHermes'].includes(name);
          const probe = owned && analystDependency
            ? await httpHealthProbe(service.health, service.healthTimeoutMs)
            : null;
          const healthy = Boolean(owned && (analystDependency
            ? probe.healthy : await httpOk(service.health, service.healthTimeoutMs)));
          if (analystDependency && analystHealthFailureRequiresInvalidation({
            healthy,
            transientFailure: probe?.transientFailure === true,
            sameOwner: owned && pid === item.pid,
            verified: state.analystContract.verified,
            checking: analystVerification.isChecking(),
            healthFailures: Number(item.healthFailures || 0) + 1,
            failureThreshold: healthFailureThreshold,
          })) {
            analystVerification.invalidate('An Analyst dependency is unavailable.');
          }
          const sidecarProcessFailure = name === 'sidecar'
            && (Number(item.duplicateCount || 0) > 0
              || item.sidecarProcessCleanup?.verified === false);
          item.pid = pid;
          item.external = children[name]?.pid !== pid;
          if (name === 'analystHermes' && pid && !owned) {
            const handoff = await reconcileOrphanedAnalystHermes();
            if (handoff.recovered) {
              item.pid = null;
              item.external = false;
              item.status = 'restarting';
              item.errorCode = null;
              item.healthFailures = 0;
              analystVerification.invalidate('Hermes was updated; the replacement gateway is being verified.');
              writeState(state);
              void scheduleRestart(name, {
                reason: 'hermes-update-handoff',
                countFailure: false,
              });
              continue;
            }
          }
          if (pid && !owned) {
            item.status = 'blocked';
            item.errorCode = 'LOCAL_PORT_OWNERSHIP_CONFLICT';
            item.healthFailures = 0;
            observeServiceNotification(name, item);
            continue;
          }
          item.status = sidecarProcessFailure
            ? 'degraded'
            : (healthy ? 'ready' : (pid ? 'starting' : 'down'));
          item.errorCode = sidecarProcessFailure
            ? (item.sidecarProcessCleanup?.errorCode || 'IBKR_SIDECAR_DUPLICATES')
            : (healthy ? null : (item.errorCode || `LOCAL_${name.toUpperCase()}_UNHEALTHY`));
          item.healthFailures = sidecarProcessFailure
            ? Number(item.healthFailures || 0) + 1
            : (healthy ? 0 : Number(item.healthFailures || 0) + 1);
          if (healthy && !sidecarProcessFailure) item.lastHealthyAt = new Date().toISOString();
        }

        observeServiceNotification(name, item);
        if (item.healthFailures >= healthFailureThreshold) {
          void scheduleRestart(name, { reason: 'health-check-failed' });
        }
      }
      if (!state.analystContract.verified
          && ['analystSidecar', 'analystHermes'].every(name => state.children[name]?.status === 'ready' && !restartPending.has(name))) {
        void analystVerification.check();
      }
      state.supervisor.lastMonitorError = null;
      writeState(state);
    } catch (error) {
      state.supervisor.lastMonitorError = {
        errorCode: 'LOCAL_MONITOR_INSPECTION_FAILED',
        observedAt: new Date().toISOString(),
        detail: `Monitor inspection failed (${error?.code || 'INSPECTION_FAILED'}).`,
      };
      console.error(`[dashboard-supervisor] ${state.supervisor.lastMonitorError.detail}`);
      writeState(state);
    } finally {
      reconciling = false;
    }
  }, monitorIntervalMs);
  async function shutdown() {
    if (state.stopping) return;
    state.stopping = true;
    analystVerification.invalidate('The dashboard supervisor is stopping.');
    clearInterval(timer);
    await stopServicesInOrder(activeServiceNames, terminateOwnedService);
    writeState(state);
    process.exit(0);
  }
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}
async function start(options = {}) {
  const detach = options.detach ?? isDetach;
  const json = options.json ?? asJson;
  const quiet = options.quiet ?? false;
  const current = readState();
  if (current?.supervisor?.pid && isAlive(current.supervisor.pid) && isOwned(current.supervisor.pid)) {
    if (json) return doctor();
    if (!quiet) console.log(`Dashboard supervisor already running (PID ${current.supervisor.pid}).`);
    return;
  }
  if (detach) {
    ensureDirs();
    const log = path.join(logDir, 'supervisor.log');
    const daemon = spawn(process.execPath, [__filename, 'monitor'], { cwd: root, detached: true, stdio: ['ignore', fs.openSync(log, 'a'), fs.openSync(log, 'a')], env: process.env });
    daemon.unref();
    for (let n = 0; n < Math.ceil(dashboardBootstrapTimeoutMs / 500); n++) {
      await sleep(500);
      const supervisorState = readState();
      if (supervisorState?.children?.api?.credentialPreflightBlocked) break;
      if ((await httpOk(services.ui.health, services.ui.healthTimeoutMs))
          && (await httpOk(services.api.health, services.api.healthTimeoutMs))) break;
    }
    const supervisorState = readState();
    if (supervisorState?.children?.api?.credentialPreflightBlocked) {
      const item = supervisorState.children.api;
      throw new Error(
        `Dashboard API credential preflight failed (${item.errorCode}): ${item.lastDetail}`,
      );
    }
    if (json) return doctor();
    if (!quiet) console.log('Dashboard supervisor started in detached mode.');
    return;
  }
  await runMonitor();
}
async function restart(options = {}) {
  const quiet = options.quiet === true;
  if (launchAgentIsLoaded()) {
    execFileSync('launchctl', ['kickstart', '-k', launchAgentDomain()], {
      stdio: quiet ? 'ignore' : 'inherit',
      timeout: 10_000,
    });
    const [apiReady, uiReady] = await Promise.all([
      waitFor('api', dashboardBootstrapTimeoutMs),
      waitFor('ui', dashboardBootstrapTimeoutMs),
    ]);
    if (!apiReady || !uiReady) throw new Error('The loaded dashboard LaunchAgent did not restore API/UI health.');
    if (!quiet) console.log('Dashboard stack restarted through the loaded LaunchAgent.');
    return;
  }
  await stop({ quiet });
  return start({ detach: options.detach ?? isDetach, json: options.json ?? asJson, quiet });
}

async function restartIbkrSidecar({
  state = readState(),
  snapshot = sidecarProcessSnapshot,
  terminateProcess = terminate,
  alive = isAlive,
  owned = isOwned,
  healthCheck = () => httpOk(services.sidecar.health),
  pause = sleep,
  timeoutMs = 45_000,
  now = Date.now,
} = {}) {
  const supervisorPid = Number(state?.supervisor?.pid) || null;
  if (!supervisorPid || !alive(supervisorPid) || !owned(supervisorPid)) {
    throw new Error(
      'Refusing sidecar repair because no repo-owned dashboard supervisor is active.',
    );
  }

  const before = snapshot();
  const targetPid = Number(before?.ownerPid) || null;
  if (
    !targetPid
    || before?.runtimeVerified !== true
    || !Array.isArray(before?.managedProcessPids)
    || !before.managedProcessPids.includes(targetPid)
    || !alive(targetPid)
    || !owned(targetPid)
  ) {
    throw new Error(
      'Refusing sidecar repair because the port-8765 owner is not the exact repo-managed IBKR sidecar.',
    );
  }
  if (Number(before?.duplicateCount || 0) > 0) {
    throw new Error(
      'Refusing sidecar repair while multiple repo-owned sidecars are present; run the supervisor reconciliation first.',
    );
  }

  // Only this exact uvicorn PID is signalled. Gateway/TWS is a Java process,
  // cannot pass the sidecar signature above, and is never a repair target.
  await terminateProcess(targetPid);

  const deadline = now() + Math.max(1_000, Number(timeoutMs) || 45_000);
  let after = snapshot();
  while (now() < deadline) {
    const replacementPid = Number(after?.ownerPid) || null;
    if (
      replacementPid
      && replacementPid !== targetPid
      && after?.runtimeVerified === true
      && Number(after?.duplicateCount || 0) === 0
      && alive(replacementPid)
      && owned(replacementPid)
      && await healthCheck()
    ) {
      return {
        ok: true,
        action: 'restart-ibkr-sidecar',
        previousPid: targetPid,
        pid: replacementPid,
        sidecarProcessCount: after.processCount,
        gatewaySignalled: false,
        observedAt: new Date().toISOString(),
      };
    }
    await pause(500);
    after = snapshot();
  }
  throw new Error(
    `Repo-owned IBKR sidecar PID ${targetPid} stopped, but the supervisor did not restore one healthy replacement within ${timeoutMs}ms.`,
  );
}

async function restartSidecarCommand() {
  const result = await restartIbkrSidecar();
  console.log(JSON.stringify(result));
  return result;
}
async function status() {
  const report = await doctorReport();
  if (asJson) { console.log(JSON.stringify(report, null, 2)); process.exitCode = report.ok ? 0 : 1; return; }
  const state = readState();
  const legacy = { state, services: {} };
  for (const [name, value] of Object.entries(report.services)) legacy.services[name] = { pid: value.pid, healthy: value.healthy };
  console.log(JSON.stringify(legacy, null, 2));
  process.exitCode = report.ok ? 0 : 1;
}
async function doctorReport() {
  const state = readState();
  const report = { ok: false, status: 'down', instanceId: state?.startedAt || null, logDir, services: {} };
  for (const [name, service] of Object.entries(services)) {
    const recordedState = state?.children?.[name];
    if (recordedState?.credentialPreflightBlocked) {
      report.services[name] = {
        pid: null,
        running: false,
        owned: true,
        healthy: false,
        ready: false,
        status: 'blocked',
        errorCode: recordedState.errorCode || 'AWS_PROFILE_UNUSABLE',
        detail: recordedState.lastDetail || 'The dedicated AWS profile failed preflight.',
        credentialPreflightBlocked: true,
        credentialPreflightCheckedAt: recordedState.credentialPreflightCheckedAt || null,
        nextCredentialPreflightAt: recordedState.nextCredentialPreflightAt || null,
      };
      continue;
    }
    if (service.processOnly) {
      report.services[name] = processServiceStatus(name, recordedState);
      continue;
    }
    const pid = listenerPid(service.port);
    const owned = Boolean(pid && isOwned(pid));
    const healthy = await httpOk(service.health, service.healthTimeoutMs);
    const sidecarSnapshot = name === 'sidecar' ? sidecarProcessSnapshot() : null;
    const sidecarDuplicateFailure = Boolean(sidecarSnapshot?.duplicateCount > 0);
    const tradingReady = name === 'sidecar' ? await httpOk('http://127.0.0.1:8765/readyz') : healthy;
    const analystContractFailure = name === 'analystHermes'
      && state?.analystContract?.verified !== true;
    const status = pid && !owned
      ? 'blocked'
      : (sidecarDuplicateFailure
        ? 'degraded'
        : (analystContractFailure
          ? 'degraded'
          : (tradingReady ? 'ready' : (healthy ? 'degraded' : (pid ? 'starting' : 'down')))));
    report.services[name] = {
      pid,
      running: Boolean(pid),
      owned,
      healthy,
      ready: owned && tradingReady && !sidecarDuplicateFailure && !analystContractFailure,
      status,
      ...(sidecarSnapshot || {}),
      ...(sidecarDuplicateFailure ? {
        errorCode: 'IBKR_SIDECAR_DUPLICATES',
        detail: `Repo-owned sidecar process(es) require cleanup: ${sidecarSnapshot.duplicatePids.join(', ')}.`,
      } : {}),
      ...(analystContractFailure ? {
        errorCode: 'ANALYST_HERMES_CONTRACT_UNVERIFIED',
        detail: state?.analystContract?.error || 'The Hermes JSON-RPC contract is not verified.',
      } : {}),
    };
  }
  const ownershipBlocked = Object.entries(report.services)
    .some(([name, service]) => services[name].port && service.running && !service.owned);
  report.ok = report.services.ui.healthy && report.services.ui.owned
    && report.services.api.healthy && report.services.api.owned
    && !ownershipBlocked;
  report.status = !report.ok
    ? 'down'
    : (
      report.services.sidecar.ready
      && report.services.analystSidecar.ready
      && report.services.analystHermes.ready
      && report.services.bridge.ready
      && report.services.controller.ready
        ? 'ready'
        : 'degraded'
    );
  return report;
}

async function localStackGroup() {
  const state = readState();
  const snapshots = await Promise.all(Object.entries(services).map(async ([name, service]) => {
    const processSnapshot = service.processOnly
      ? processServiceStatus(name, state?.children?.[name])
      : null;
    const pid = service.processOnly ? processSnapshot.pid : listenerPid(service.port);
    const owned = service.processOnly ? processSnapshot.owned : Boolean(pid && isOwned(pid));
    const healthy = service.processOnly
      ? processSnapshot.healthy
      : await httpOk(service.health, service.healthTimeoutMs);
    const sidecarSnapshot = name === 'sidecar' ? sidecarProcessSnapshot() : null;
    const sidecarDuplicateFailure = Boolean(sidecarSnapshot?.duplicateCount > 0);
    const analystContractFailure = name === 'analystHermes'
      && state?.analystContract?.verified !== true;
    const intentionallyDisabled = service.processOnly
      && processSnapshot?.status === 'disabled'
      && processSnapshot?.intentionallyDisabled === true;
    const checkPassed = intentionallyDisabled
      || Boolean(pid && owned && healthy && !sidecarDuplicateFailure && !analystContractFailure);
    let summary;
    let recovery;
    const processErrorCode = processSnapshot?.lastPublishErrorCode
      || processSnapshot?.lastInputErrorCode
      || processSnapshot?.lastErrorCode
      || null;

    if (intentionallyDisabled) {
      summary = 'Outbound operations and portfolio publishing are intentionally disabled; the bridge is idle.';
      recovery = null;
    } else if (sidecarDuplicateFailure) {
      summary = `Repo-owned IBKR sidecar duplicate process(es) remain connected to Gateway: ${sidecarSnapshot.duplicatePids.join(', ')}.`;
      recovery = {
        kind: 'command',
        label: 'Restart the repo-owned local stack to reconcile IBKR sidecar processes.',
        command: 'npm run dev:restart -- --detach',
      };
    } else if (analystContractFailure) {
      summary = state?.analystContract?.error
        || 'The Analyst Hermes JSON-RPC contract has not been verified.';
      recovery = {
        kind: 'command',
        label: 'Restart the repo-owned stack to rerun the pinned Hermes contract check.',
        command: 'npm run dev:restart -- --detach',
      };
    } else if (pid && !owned) {
      summary = service.processOnly
        ? `Supervisor state points to unknown ${name} PID ${pid}; it will not be adopted or stopped.`
        : `Port ${service.port} is occupied by unknown PID ${pid}; it will not be adopted or stopped.`;
      recovery = {
        kind: 'manual',
        label: service.processOnly
          ? `Inspect the recorded ${name} PID, then restart the repo-owned supervisor if appropriate.`
          : `Inspect the unknown listener on port ${service.port}; stop or reconfigure it manually if appropriate.`,
        ...(service.processOnly ? {} : { command: `lsof -nP -iTCP:${service.port} -sTCP:LISTEN` }),
      };
    } else if (!pid) {
      summary = service.processOnly
        ? `No repo-owned ${localServiceLabels[name]} process is recorded.`
        : `Nothing is listening on port ${service.port}.`;
      recovery = {
        kind: 'command',
        label: 'Start the missing repo-owned dashboard services and rerun all checks.',
        command: 'npm run morning',
      };
    } else if (!healthy) {
      summary = service.processOnly
        ? `Repo-owned ${name} PID ${pid} is not publishing a fresh successful heartbeat.`
        : `Repo-owned PID ${pid} is listening on port ${service.port}, but its health check failed.`;
      recovery = service.processOnly
        ? {
          kind: 'manual',
          label: name === 'bridge'
            ? bridgeRecoveryLabel(processSnapshot)
            : 'Inspect the controller state and log, then restart the repo-owned supervisor if needed.',
        }
        : {
          kind: 'command',
          label: 'Restart the repo-owned local stack, then rerun the morning checklist.',
          command: 'npm run dev:restart',
        };
    } else {
      summary = service.processOnly
        ? (name === 'bridge'
          ? `Publishing outbound snapshots from repo-owned PID ${pid}.`
          : `Readiness controller is ${processSnapshot.mode || 'shadow'} from repo-owned PID ${pid}.`)
        : `Healthy on port ${service.port} (PID ${pid}).`;
      recovery = null;
    }

    return {
      id: `local-${name}`,
      label: localServiceLabels[name],
      status: checkPassed ? 'pass' : 'fail',
      blocking: name !== 'controller' && !intentionallyDisabled,
      summary,
      errorCode: checkPassed
        ? null
        : sidecarDuplicateFailure
          ? 'IBKR_SIDECAR_DUPLICATES'
          : analystContractFailure
            ? 'ANALYST_HERMES_CONTRACT_UNVERIFIED'
          : pid && !owned
            ? 'LOCAL_PORT_OWNERSHIP_CONFLICT'
            : !pid
            ? `LOCAL_${name.toUpperCase()}_NOT_RUNNING`
            : (processErrorCode || `LOCAL_${name.toUpperCase()}_UNHEALTHY`),
      detail: intentionallyDisabled
        ? 'Both bridge partition controls are false; no bridge process or outbound AWS writer is running.'
        : service.processOnly
        ? [
          `Heartbeat ${processSnapshot.lastHeartbeatAt || 'unavailable'}; latest result ${processSnapshot.lastResultStatus || 'unknown'}.`,
          processSnapshot.lastInputErrorCode
            ? `Input: ${processSnapshot.lastInputErrorCode}${processSnapshot.lastInputDetail ? ` — ${processSnapshot.lastInputDetail}` : ''}.`
            : null,
          processSnapshot.lastPublishErrorCode
            ? `Publish: ${processSnapshot.lastPublishErrorCode}${processSnapshot.lastPublishStage ? ` at ${processSnapshot.lastPublishStage}` : ''}${processSnapshot.lastPublishDetail ? ` — ${processSnapshot.lastPublishDetail}` : ''}.`
            : null,
          !processSnapshot.lastInputDetail && !processSnapshot.lastPublishDetail
            ? processSnapshot.lastDetail || null
            : null,
        ].filter(Boolean).join(' ')
        : (sidecarDuplicateFailure
          ? `Sidecar process PIDs ${sidecarSnapshot.processPids.join(', ') || 'none'}; duplicate PIDs ${sidecarSnapshot.duplicatePids.join(', ') || 'none'}.`
          : service.health),
      observedAt: new Date().toISOString(),
      ageSeconds: 0,
      impact: intentionallyDisabled
        ? null
        : service.processOnly
        ? (name === 'bridge'
          ? 'Hermes operations telemetry cannot refresh while the bridge is unhealthy.'
          : 'Deterministic local readiness repair is unavailable while the controller is unhealthy.')
        : `${localServiceLabels[name]} is required for the local dashboard stack.`,
      recovery,
      provenance: {
        source: 'morning-cli',
        repositoryRoot: root,
        healthUrl: service.health || null,
        healthMode: intentionallyDisabled
          ? 'disabled'
          : (service.processOnly ? 'process-heartbeat' : 'http'),
        ...(sidecarSnapshot || {}),
      },
      local: {
        name,
        port: service.port || null,
        pid,
        owned,
        healthy,
        ...(processSnapshot || {}),
        ...(sidecarSnapshot || {}),
      },
    };
  }));

  return { id: 'local-stack', label: 'Local stack', checks: snapshots };
}

function validateSystemReadinessReport(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    throw new Error('Readiness response is not a JSON object.');
  }
  if (report.version !== 1) throw new Error(`Unsupported readiness report version: ${report.version ?? 'missing'}.`);
  if (!['ready', 'degraded', 'blocked'].includes(report.status)) {
    throw new Error(`Invalid readiness status: ${report.status ?? 'missing'}.`);
  }
  if (typeof report.ready !== 'boolean') throw new Error('Readiness response is missing the ready boolean.');
  if (report.ready !== (report.status === 'ready')) {
    throw new Error('Readiness response has inconsistent ready and status values.');
  }
  if (report.operational != null && report.operational !== (report.status !== 'blocked')) {
    throw new Error('Readiness response has an inconsistent operational flag.');
  }
  if (report.fullyOperational != null && typeof report.fullyOperational !== 'boolean') {
    throw new Error('Readiness response has an invalid fullyOperational flag.');
  }
  if (typeof report.checkedAt !== 'string' || Number.isNaN(new Date(report.checkedAt).getTime())) {
    throw new Error('Readiness response has an invalid checkedAt timestamp.');
  }
  if (!report.summary || typeof report.summary !== 'object') {
    throw new Error('Readiness response is missing its summary.');
  }
  for (const key of ['passed', 'warnings', 'failed', 'total', 'blockingFailures']) {
    if (typeof report.summary[key] !== 'number' || !Number.isFinite(report.summary[key])) {
      throw new Error(`Readiness summary is missing numeric ${key}.`);
    }
  }
  if (report.summary.passed + report.summary.warnings + report.summary.failed !== report.summary.total
      || report.summary.blockingFailures > report.summary.failed) {
    throw new Error('Readiness summary counts are inconsistent.');
  }
  if (!Array.isArray(report.groups)) throw new Error('Readiness response is missing its groups array.');

  for (const group of report.groups) {
    if (!group || typeof group.id !== 'string' || typeof group.label !== 'string' || !Array.isArray(group.checks)) {
      throw new Error('Readiness response contains an invalid group.');
    }
    for (const check of group.checks) {
      if (!check || typeof check.id !== 'string' || typeof check.label !== 'string') {
        throw new Error(`Readiness group ${group.id} contains an invalid check.`);
      }
      if (!['pass', 'warn', 'fail'].includes(check.status) || typeof check.blocking !== 'boolean') {
        throw new Error(`Readiness check ${check.id} has an invalid status or blocking flag.`);
      }
      if (typeof check.summary !== 'string') {
        throw new Error(`Readiness check ${check.id} is missing its summary.`);
      }
      if (check.dependsOn != null && !Array.isArray(check.dependsOn)) {
        throw new Error(`Readiness check ${check.id} has invalid dependencies.`);
      }
      if (check.capabilityIds != null && !Array.isArray(check.capabilityIds)) {
        throw new Error(`Readiness check ${check.id} has invalid capabilities.`);
      }
      if (check.errorCode != null && typeof check.errorCode !== 'string') {
        throw new Error(`Readiness check ${check.id} has an invalid error code.`);
      }
      if (check.recovery != null) {
        const recovery = check.recovery;
        if (!recovery || !['command', 'manual'].includes(recovery.kind) || typeof recovery.label !== 'string') {
          throw new Error(`Readiness check ${check.id} has an invalid recovery action.`);
        }
        if (recovery.kind === 'command' && typeof recovery.command !== 'string') {
          throw new Error(`Readiness check ${check.id} is missing its recovery command.`);
        }
        if (recovery.automatic != null && typeof recovery.automatic !== 'boolean') {
          throw new Error(`Readiness check ${check.id} has an invalid automatic recovery flag.`);
        }
        if (recovery.automatic === true && typeof recovery.actionId !== 'string') {
          throw new Error(`Readiness check ${check.id} is missing its allowlisted repair action ID.`);
        }
      }
    }
  }
  if (!Array.isArray(report.capabilities)) throw new Error('Readiness response is missing its capabilities array.');
  for (const capability of report.capabilities) {
    if (!capability || typeof capability.id !== 'string' || typeof capability.label !== 'string'
        || !['ready', 'degraded', 'blocked'].includes(capability.status)) {
      throw new Error('Readiness response contains an invalid capability.');
    }
  }
  const receivedCapabilityIds = report.capabilities.map((capability) => capability.id).sort();
  if (new Set(receivedCapabilityIds).size !== receivedCapabilityIds.length
      || receivedCapabilityIds.length !== expectedCapabilityIds.length
      || receivedCapabilityIds.some((id, index) => id !== expectedCapabilityIds[index])) {
    throw new Error(`Readiness response does not implement the required capability contract: ${expectedCapabilityIds.join(', ')}.`);
  }
  if (report.rootCauses != null) {
    if (!Array.isArray(report.rootCauses)) throw new Error('Readiness response has invalid root causes.');
    for (const cause of report.rootCauses) {
      if (!cause || typeof cause.id !== 'string' || typeof cause.summary !== 'string'
          || !Array.isArray(cause.affectedCheckIds)) {
        throw new Error('Readiness response contains an invalid root cause.');
      }
    }
  }
  return report;
}

async function fetchSystemReadiness() {
  let response;
  try {
    response = await fetch(readinessUrl, { signal: AbortSignal.timeout(readinessTimeoutMs) });
  } catch (error) {
    throw new Error(`Could not reach ${readinessUrl}: ${error.message}`);
  }

  const body = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(`Readiness endpoint returned HTTP ${response.status} with a non-JSON body.`);
  }
  if (!response.ok) {
    const detail = parsed?.details || parsed?.error || response.statusText;
    throw new Error(`Readiness endpoint returned HTTP ${response.status}: ${detail}`);
  }
  return validateSystemReadinessReport(parsed);
}

const LOGIN_STATUS_VALUES = new Set(['online', 'offline', 'attention', 'closed', 'unknown']);
const LOGIN_DETAIL_IDS = new Set([
  'ibkr-gateway',
  'gmail-oauth',
  'aws-admin',
  'aws-api',
  'aws-bridge',
]);

function validateLoginStatusReport(report) {
  if (!report || typeof report !== 'object' || report.version !== 1) {
    throw new Error('Login status response has an unsupported version.');
  }
  if (!report.service || report.service.id !== 'logins') {
    throw new Error('Login status response is missing the Logins service.');
  }
  if (!Number.isFinite(Date.parse(String(report.checkedAt || '')))) {
    throw new Error('Login status response is missing a valid checkedAt timestamp.');
  }
  if (!Array.isArray(report.service.details)) {
    throw new Error('Login status response is missing its details array.');
  }
  for (const detail of report.service.details) {
    if (!detail || !LOGIN_DETAIL_IDS.has(String(detail.id || ''))
        || !LOGIN_STATUS_VALUES.has(String(detail.status || ''))
        || typeof detail.required !== 'boolean') {
      throw new Error('Login status response contains an invalid authentication detail.');
    }
  }
  return report;
}

async function fetchLoginStatus({ refresh = null } = {}) {
  const requestUrl = refresh
    ? `${loginStatusUrl}?refresh=${encodeURIComponent(refresh === true ? '1' : refresh)}`
    : loginStatusUrl;
  let response;
  try {
    response = await fetch(requestUrl, { signal: AbortSignal.timeout(loginStatusTimeoutMs) });
  } catch (error) {
    throw new Error(`Could not reach ${loginStatusUrl}: ${error.message}`);
  }
  const body = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(`Login status endpoint returned HTTP ${response.status} with a non-JSON body.`);
  }
  if (!response.ok) {
    throw new Error(`Login status endpoint returned HTTP ${response.status}.`);
  }
  return validateLoginStatusReport(parsed);
}

function loginDetailErrorCode(detail) {
  const state = String(detail?.state || '').trim().toLowerCase();
  if (detail?.id === 'gmail-oauth' && state === 'expired') return 'GMAIL_AUTH_REQUIRED';
  if (state === 'signed_out' || state === 'expired') return 'AWS_ADMIN_LOGIN_REQUIRED';
  if (state === 'wrong_principal') return 'AWS_PROFILE_WRONG_PRINCIPAL';
  if (state === 'forbidden') return 'AWS_AUTHORIZATION_DENIED';
  if (state === 'socket_disabled') return 'IBKR_SOCKET_DISABLED';
  if (state === 'sidecar_unavailable') return 'IBKR_SIDECAR_UNAVAILABLE';
  if (state === 'disconnected') return 'IBKR_GATEWAY_DISCONNECTED';
  return null;
}

function authenticationCheck(detail, {
  id,
  label,
  recovery = null,
  optional = false,
} = {}) {
  const status = String(detail?.status || 'unknown');
  const state = String(detail?.state || 'unverified');
  const sourceId = String(detail?.id || id || '');
  const observedAt = detail?.verifiedAt || detail?.checkedAt || new Date().toISOString();
  const errorCode = loginDetailErrorCode({
    ...detail,
    id: detail?.id || id,
  });
  if (sourceId === 'aws-admin') {
    let summary = 'Ready for operator changes.';
    if (state === 'signed_out' || state === 'expired') {
      summary = 'Signed out — required only for operator changes.';
    } else if (status !== 'online') {
      summary = 'Operator AWS SSO is not verified; trading readiness is unaffected.';
    }
    return {
      id: 'aws-admin-sso',
      label,
      status: 'pass',
      blocking: false,
      summary,
      detail: detail?.reason || null,
      observedAt,
      errorCode,
      impact: 'Deployments, IAM changes, backfills, and replays require the approved administrator SSO session.',
      recovery: null,
    };
  }

  if (status === 'online' || (status === 'closed' && state === 'disabled')) {
    return {
      id,
      label,
      status: 'pass',
      blocking: !optional,
      summary: status === 'closed' ? 'Intentionally disabled.' : 'Verified and operational.',
      detail: null,
      observedAt,
      errorCode: null,
      recovery: null,
    };
  }

  const failed = status === 'offline';
  return {
    id,
    label,
    status: failed ? 'fail' : 'warn',
    blocking: !optional,
    summary: detail?.reason || 'Authentication could not be verified.',
    detail: state,
    observedAt,
    errorCode: errorCode || `${id.replace(/[^a-z0-9]+/gi, '_').toUpperCase()}_${failed ? 'FAILED' : 'UNVERIFIED'}`,
    impact: `${label} is required for its enabled dashboard capability.`,
    recovery,
  };
}

function authenticationGroup(loginReport) {
  const details = new Map(
    loginReport.service.details.map((detail) => [String(detail.id), detail]),
  );
  return {
    id: 'authentication',
    label: 'Authentication',
    checks: [
      authenticationCheck(details.get('ibkr-gateway'), {
        id: 'auth-ibkr',
        label: 'IBKR Gateway',
        recovery: {
          kind: 'manual',
          label: 'Open IB Gateway from the Systems panel, finish login, then wait for live portfolio verification.',
        },
      }),
      authenticationCheck(details.get('aws-api'), {
        id: 'auth-aws-api',
        label: 'AWS API',
        recovery: {
          kind: 'command',
          label: 'Verify the dashboard read profile.',
          command: 'node scripts/ops/aws_profile_preflight.js --purpose api --profile market-dashboard-local',
        },
      }),
      authenticationCheck(details.get('aws-bridge'), {
        id: 'auth-aws-bridge',
        label: 'AWS Bridge',
        optional: details.get('aws-bridge')?.required !== true,
        recovery: {
          kind: 'command',
          label: 'Restart the repo-owned bridge after fixing its dedicated profile.',
          command: 'npm run dev:restart',
        },
      }),
      authenticationCheck(details.get('aws-admin'), {
        id: 'auth-aws-admin',
        label: 'AWS Admin',
        optional: true,
      }),
      authenticationCheck(details.get('gmail-oauth'), {
        id: 'auth-gmail',
        label: 'Gmail OAuth',
        recovery: {
          kind: 'manual',
          label: 'Refresh Gmail OAuth only if the Gmail authentication proof is expired or revoked.',
        },
      }),
    ],
  };
}

function unavailableAuthenticationGroup(message) {
  return {
    id: 'authentication',
    label: 'Authentication',
    checks: [{
      id: 'auth-status',
      label: 'Authentication status',
      status: 'fail',
      blocking: true,
      summary: message,
      errorCode: 'AUTHENTICATION_STATUS_UNAVAILABLE',
      detail: loginStatusUrl,
      observedAt: new Date().toISOString(),
      recovery: {
        kind: 'command',
        label: 'Restore the local API, then rerun the authentication checks.',
        command: 'npm run auth:status',
      },
    }],
  };
}

function summarizeGroups(groups, minimumStatus = 'ready') {
  const readiness = buildSystemReadiness(groups);
  const rank = { ready: 0, degraded: 1, blocked: 2 };
  let derived = readiness.status;
  if (rank[minimumStatus] > rank[derived]) derived = minimumStatus;
  return { status: derived, summary: readiness.summary };
}

function mergedMorningReport(localGroup, systemReport, metadata = {}, authentication = null) {
  const groups = [localGroup, ...(systemReport?.groups || []), ...(authentication ? [authentication] : [])];
  const aggregate = buildSystemReadiness(groups, {
    now: systemReport?.checkedAt || new Date(),
  });
  return {
    ...aggregate,
    logDir,
    systemReadinessAvailable: Boolean(systemReport),
    ...metadata,
  };
}

function unavailableSystemGroup(message, recoveryCommand = 'npm run morning') {
  return {
    id: 'system-readiness',
    label: 'System readiness',
    checks: [{
      id: 'system-readiness-report',
      label: 'System readiness report',
      status: 'fail',
      blocking: true,
      summary: message,
      errorCode: 'SYSTEM_READINESS_UNAVAILABLE',
      detail: readinessUrl,
      observedAt: new Date().toISOString(),
      ageSeconds: null,
      impact: 'Gateway, portfolio, Hermes, Gmail, and research readiness could not be verified.',
      recovery: {
        kind: 'command',
        label: 'Restore the local API and rerun the full morning checklist.',
        command: recoveryCommand,
      },
    }],
  };
}

function localApiIsHealthy(localGroup) {
  return localGroup.checks.find(check => check.id === 'local-api')?.status === 'pass';
}

function localCoreIsHealthy(localGroup) {
  return ['local-api', 'local-ui'].every((id) => (
    localGroup.checks.find((check) => check.id === id)?.status === 'pass'
  ));
}

function hasUnknownListener(localGroup, coreOnly = false) {
  return localGroup.checks.some(check => (!coreOnly || ['local-api', 'local-ui'].includes(check.id)) && check.local?.pid && !check.local?.owned);
}

function hasMissingListener(localGroup) {
  return localGroup.checks.some(check => !check.local?.pid && check.local?.enabled !== false);
}

async function waitForLocalStack(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let snapshot = await localStackGroup();
  // Startup completion is gated only by dashboard.core. Ancillary services such
  // as the outbound AWS bridge may remain degraded for a real external reason;
  // waiting for them here would turn every morning check into a minute-long
  // timeout and blur a usable dashboard into a global startup failure.
  while (Date.now() < deadline && !localCoreIsHealthy(snapshot)) {
    await sleep(750);
    snapshot = await localStackGroup();
  }
  return snapshot;
}

async function recoverMissingLocalStack(initialGroup) {
  const recovery = { attempted: false, mode: 'local-only', startedServices: [] };
  if (!hasMissingListener(initialGroup) || hasUnknownListener(initialGroup, true)) return { localGroup: initialGroup, recovery };

  recovery.attempted = true;
  recovery.startedServices = initialGroup.checks
    .filter(check => !check.local?.pid && check.local?.enabled !== false)
    .map(check => check.local.name);
  const startedAt = Date.now();
  try {
    await start({ detach: true, json: false, quiet: true });
  } catch (error) {
    recovery.error = error.message;
  }
  const remaining = Math.max(1_000, morningStartTimeoutMs - (Date.now() - startedAt));
  const localGroup = await waitForLocalStack(remaining);
  recovery.completed = localGroup.checks.every(check => check.status === 'pass');
  return { localGroup, recovery };
}

function systemSourceIsStale(report) {
  return (report?.groups || []).flatMap((group) => group.checks || []).some((check) => (
    ['DASHBOARD_CODE_VERSION_DRIFT', 'DASHBOARD_SUPERVISOR_CODE_DRIFT'].includes(check.errorCode)
  ));
}

function hasStartupReadinessMismatch(localGroup, systemReport, { sidecarReady = false } = {}) {
  const localChecks = new Map((localGroup?.checks || []).map((check) => [check.id, check]));
  const systemChecks = new Map(
    (systemReport?.groups || [])
      .flatMap((group) => group.checks || [])
      .map((check) => [check.id, check]),
  );
  const localUiReady = localChecks.get('local-ui')?.status === 'pass';
  const uiCheck = systemChecks.get('dashboard.ui');
  if (localUiReady && uiCheck?.status === 'fail' && uiCheck.errorCode === 'DASHBOARD_UI_UNREACHABLE') {
    return true;
  }

  const localSidecarReady = localChecks.get('local-sidecar')?.status === 'pass' && sidecarReady;
  if (!localSidecarReady) return false;
  const sidecarStartupCodes = new Set([
    'IBKR_SIDECAR_UNREACHABLE',
    'RUNTIME_PROVENANCE_UNAVAILABLE',
    'IBKR_GATEWAY_DISCONNECTED',
    'IBKR_ACCOUNTS_UNAVAILABLE',
    'IBKR_PORTFOLIO_UNAVAILABLE',
  ]);
  return ['ibkr.sidecar', 'ibkr.runtime', 'ibkr.gateway', 'ibkr.accounts', 'ibkr.portfolio']
    .some((id) => {
      const check = systemChecks.get(id);
      return check?.status === 'fail' && sidecarStartupCodes.has(check.errorCode);
    });
}

async function restartOwnedLocalStack(initialGroup, reason) {
  const recovery = {
    attempted: false,
    mode: 'restart-owned-stack',
    reason,
    startedServices: Object.keys(services),
  };
  if (hasUnknownListener(initialGroup)) {
    recovery.error = 'An unknown listener is present; automatic restart was refused.';
    return { localGroup: initialGroup, recovery };
  }

  recovery.attempted = true;
  const knownPids = [...new Set(initialGroup.checks
    .map((check) => Number(check.local?.pid) || null)
    .filter(Boolean))];
  try {
    if (launchAgentIsLoaded()) {
      await restart({ detach: true, quiet: true });
    } else {
      await stop({ quiet: true });
      for (const pid of knownPids) {
        if (isAlive(pid) && isOwned(pid)) await terminate(pid);
      }
      await start({ detach: true, json: false, quiet: true });
    }
  } catch (error) {
    recovery.error = error.message;
  }
  const localGroup = await waitForLocalStack(morningStartTimeoutMs);
  recovery.completed = localCoreIsHealthy(localGroup);
  return { localGroup, recovery };
}

function recoveryActions(groups) {
  const actions = [];
  const seen = new Set();
  const checks = groups.flatMap((group, groupIndex) => (
    (group.checks || []).map((check, checkIndex) => ({ check, groupIndex, checkIndex }))
  ));
  checks.sort((left, right) => {
    const severity = check => check.status === 'fail' ? 0 : check.status === 'warn' ? 1 : 2;
    return severity(left.check) - severity(right.check)
      || Number(right.check.blocking) - Number(left.check.blocking)
      || left.groupIndex - right.groupIndex
      || left.checkIndex - right.checkIndex;
  });
  for (const { check } of checks) {
    if (check.status === 'pass' || !check.recovery) continue;
    const key = `${check.recovery.kind}|${check.recovery.command || ''}|${check.recovery.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    actions.push({ check: check.label, status: check.status, ...check.recovery });
  }
  return actions;
}

function formatMorningReport(report) {
  const lines = [
    'Market Dashboard Morning Checklist',
    `Overall: ${report.status.toUpperCase()}  (${report.summary.passed} pass, ${report.summary.warnings} warn, ${report.summary.failed} fail)`,
    `Checked: ${report.checkedAt}`,
  ];
  if (report.localRecovery?.attempted) {
    const serviceList = report.localRecovery.startedServices.join(', ') || 'local services';
    lines.push(`Local recovery: ${report.localRecovery.completed ? 'completed' : 'attempted'} (${serviceList})`);
  }

  if (Array.isArray(report.capabilities) && report.capabilities.length > 0) {
    lines.push('', 'CAPABILITIES');
    for (const capability of report.capabilities) {
      const label = capability.status === 'ready' ? 'AVAILABLE' : capability.status.toUpperCase();
      lines.push(`[${label}] ${capability.label}${capability.description ? ` — ${capability.description}` : ''}`);
    }
  }

  if (Array.isArray(report.rootCauses) && report.rootCauses.length > 0) {
    lines.push('', `ROOT CAUSES (${report.rootCauses.length})`);
    report.rootCauses.forEach((cause, index) => {
      lines.push(`${index + 1}. [${cause.status.toUpperCase()}] ${cause.errorCode || cause.id} — ${cause.summary}`);
      lines.push(`   Owner: ${cause.owner || 'unassigned'}${cause.affectedCheckIds?.length > 1 ? `; affects ${cause.affectedCheckIds.length} checks` : ''}`);
    });
  }

  for (const group of report.groups) {
    lines.push('', group.label.toUpperCase());
    for (const check of group.checks || []) {
      lines.push(`[${check.status === 'pass' ? 'PASS' : check.status === 'warn' ? 'WARN' : 'FAIL'}] ${check.label} — ${check.summary}`);
      if (check.status !== 'pass' && check.detail && check.detail !== check.summary) lines.push(`       ${check.detail}`);
      if (check.status !== 'pass' && check.impact) lines.push(`       Impact: ${check.impact}`);
    }
  }

  const actions = recoveryActions(report.groups);
  if (actions.length > 0) {
    lines.push('', 'RECOVERY ACTIONS');
    actions.forEach((action, index) => {
      lines.push(`${index + 1}. ${action.label}`);
      if (action.command) lines.push(`   $ ${action.command}`);
    });
  } else {
    lines.push('', 'No recovery actions required.');
  }
  lines.push('', `Logs: ${report.logDir}`);
  return lines.join('\n');
}

function morningExitCode(status) {
  if (status === 'ready') return 0;
  if (status === 'degraded') return 1;
  if (status === 'blocked') return 2;
  return 3;
}

async function authStatus() {
  try {
    const report = await fetchLoginStatus({ refresh: '1' });
    if (asJson) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log('Market Dashboard Authentication');
      for (const detail of report.service.details) {
        const optional = detail.required ? '' : ' (optional)';
        console.log(`- ${detail.label}${optional}: ${detail.state || detail.status}`);
        if (detail.reason) console.log(`  ${detail.reason}`);
      }
      const admin = report.service.details.find((detail) => detail.id === 'aws-admin');
      console.log(admin?.state === 'signed_out' || admin?.state === 'expired'
        ? '- AWS Admin: Signed out — required only for operator changes.'
        : '- AWS Admin: Operator changes use the approved administrator SSO session.');
    }
    const requiredFailure = report.service.details.some((detail) => (
      detail.required && !['online', 'closed'].includes(detail.status)
    ));
    process.exitCode = requiredFailure ? 1 : 0;
  } catch (error) {
    const message = `Authentication status unavailable: ${error.message}`;
    if (asJson) {
      console.log(JSON.stringify({ status: 'blocked', errorCode: 'AUTHENTICATION_STATUS_UNAVAILABLE', error: message }));
    } else {
      console.error(message);
    }
    process.exitCode = 2;
  }
}

function authAdminLogin() {
  const environment = { ...process.env };
  clearAwsCredentialEnvironment(environment);
  delete environment.AWS_PROFILE;
  delete environment.AWS_DEFAULT_PROFILE;
  environment.AWS_PAGER = '';
  console.log('Clearing the cached AWS SSO session. Complete browser authorization manually when prompted.');
  execFileSync('aws', ['sso', 'logout'], { env: environment, stdio: 'inherit' });
  execFileSync('aws', ['sso', 'login', '--profile', 'market-dashboard-admin'], {
    env: environment,
    stdio: 'inherit',
  });
  execFileSync(process.execPath, [
    path.join(root, 'scripts/ops/aws_profile_preflight.js'),
    '--purpose',
    'admin',
    '--profile',
    'market-dashboard-admin',
  ], { env: environment, stdio: 'inherit' });
  console.log('AWS Admin SSO is verified for operator changes.');
}

async function morning() {
  let localGroup = await localStackGroup();
  let localRecovery = { attempted: false, mode: 'read-only', startedServices: [] };
  if (!checkOnly) {
    const recovered = await recoverMissingLocalStack(localGroup);
    localGroup = recovered.localGroup;
    localRecovery = recovered.recovery;
  }

  if (!localApiIsHealthy(localGroup)) {
    const report = mergedMorningReport(localGroup, {
      status: 'blocked',
      checkedAt: new Date().toISOString(),
      groups: [unavailableSystemGroup('The local API is unavailable, so dependency readiness could not be collected.')],
    }, { localRecovery, checkOnly, systemReadinessAvailable: false }, unavailableAuthenticationGroup(
      'The local API is unavailable, so authentication status could not be collected.',
    ));
    if (asJson) console.log(JSON.stringify(report, null, 2));
    else console.log(formatMorningReport(report));
    process.exitCode = 2;
    return;
  }

  let systemReport;
  let fetchError = null;
  try {
    systemReport = await fetchSystemReadiness();
  } catch (error) {
    fetchError = error;
  }

  if (!checkOnly && (fetchError || systemSourceIsStale(systemReport))) {
    const reason = fetchError ? `readiness-contract-error: ${fetchError.message}` : 'runtime-source-drift';
    const recovered = await restartOwnedLocalStack(localGroup, reason);
    if (recovered.recovery.attempted) {
      localGroup = recovered.localGroup;
      localRecovery = recovered.recovery;
      try {
        let firstPostRestartError = null;
        try {
          systemReport = await fetchSystemReadiness();
        } catch (error) {
          firstPostRestartError = error;
        }
        // The first comprehensive report can begin in the few seconds between
        // process liveness and UI compilation / IB session readiness. If the
        // completed report contradicts live local probes, discard it and take
        // one new snapshot. A first collection timeout is handled the same way
        // when the local API/UI are still healthy. A genuine outage still fails
        // on the second report.
        const refreshedLocalGroup = await localStackGroup();
        const sidecarReady = await httpOk('http://127.0.0.1:8765/readyz');
        const retryPostRestart = (
          firstPostRestartError && localCoreIsHealthy(refreshedLocalGroup)
        ) || hasStartupReadinessMismatch(refreshedLocalGroup, systemReport, { sidecarReady });
        if (retryPostRestart) {
          await sleep(500);
          localGroup = await localStackGroup();
          systemReport = await fetchSystemReadiness();
          fetchError = null;
        } else if (firstPostRestartError) {
          throw firstPostRestartError;
        } else {
          localGroup = refreshedLocalGroup;
          fetchError = null;
        }
      } catch (error) {
        fetchError = error;
      }
    }
  }

  if (fetchError) {
    const report = mergedMorningReport(localGroup, {
      status: 'blocked',
      checkedAt: new Date().toISOString(),
      groups: [unavailableSystemGroup(fetchError.message, 'npm run morning:check')],
    }, {
      localRecovery,
      checkOnly,
      valid: false,
      systemReadinessAvailable: false,
      preflightError: fetchError.message,
    }, unavailableAuthenticationGroup(
      'The local API readiness contract could not be collected, so authentication status is unavailable.',
    ));
    if (asJson) console.log(JSON.stringify(report, null, 2));
    else console.log(formatMorningReport(report));
    process.exitCode = 3;
    return;
  }

  let loginReport = null;
  let loginError = null;
  try {
    loginReport = await fetchLoginStatus();
  } catch (error) {
    loginError = error;
  }
  const report = mergedMorningReport(
    localGroup,
    systemReport,
    {
      localRecovery,
      checkOnly,
      valid: !loginError,
      authenticationError: loginError?.message || null,
    },
    loginError ? unavailableAuthenticationGroup(loginError.message) : authenticationGroup(loginReport),
  );
  if (asJson) console.log(JSON.stringify(report, null, 2));
  else console.log(formatMorningReport(report));
  process.exitCode = morningExitCode(report.status);
}

async function doctor() {
  const report = await doctorReport();
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.ok ? 0 : 1;
}
async function main() {
  if (command === 'monitor') return runMonitor();
  if (command === 'stop') return stop();
  if (command === 'restart') return restart();
  if (command === 'restart-sidecar') return restartSidecarCommand();
  if (command === 'status') return status();
  if (command === 'doctor') return doctor();
  if (command === 'auth-status') return authStatus();
  if (command === 'auth-admin-login') return authAdminLogin();
  if (command === 'morning') return morning();
  if (command === 'start') return start();
  throw new Error(`Unknown command: ${command}`);
}
if (require.main === module) {
  main().catch(error => {
    if (command === 'morning') {
      const message = `Morning preflight failed: ${error.message}`;
      if (asJson) {
        console.log(JSON.stringify({
          version: 1,
          status: 'blocked',
          ready: false,
          operational: false,
          fullyOperational: false,
          valid: false,
          checkedAt: new Date().toISOString(),
          summary: { passed: 0, warnings: 0, failed: 0, total: 0, blockingFailures: 0 },
          groups: [],
          capabilities: [],
          rootCauses: [],
          logDir,
          preflightError: message,
        }, null, 2));
      } else {
        console.error(message);
      }
      process.exitCode = 3;
      return;
    }
    console.error(`Dashboard supervisor: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  applyBridgeStatusPayload,
  applyControllerStatusPayload,
  authStatus,
  authenticationCheck,
  authAdminLogin,
  bridgeRecoveryLabel,
  childEnvironment,
  createAnalystRuntimeEnvironment,
  configuredBridgeAwsProfile,
  credentialPreflightFailureState,
  discoverOwnedBridgeProcessIds,
  discoverOwnedSidecarProcessIds,
  expectedCapabilityIdsForEnv,
  formatMorningReport,
  hasExactBridgeCommandSignature,
  hasExactControllerCommandSignature,
  hasExactAnalystHermesCommandSignature,
  hasExactAnalystHermesRuntimeSignature,
  hasExactAnalystSidecarCommandSignature,
  hasExactSidecarCommandSignature,
  hasManagedSidecarRuntime,
  hasExpectedDashboardSignature,
  heartbeatAgeMs,
  httpOk,
  httpHealthProbe,
  hermesBridgeEnabled,
  inspectServiceListener,
  isRecoverableOrphanedAnalystHermes,
  listenerLookup,
  ownershipLookup,
  authenticationGroup,
  fetchLoginStatus,
  launchAgentIsLoaded,
  localNotificationsEnabled,
  mergedMorningReport,
  morningExitCode,
  pathIsInRoot,
  planServiceNotificationTransition,
  planStateWriteNotification,
  preflightAwsService,
  processServiceStatus,
  reconcileDisabledBridgeProcesses,
  reconcileOrphanedAnalystHermes,
  reconcileOwnedSidecarProcesses,
  reconcileSidecarOwnership,
  recoveryActions,
  readinessUrl,
  loginStatusUrl,
  restartIbkrSidecar,
  restartPolicyFor,
  runAnalystContractCheck,
  sendMacNotification,
  services,
  stopServicesInOrder,
  sidecarProcessSnapshot,
  supervisedServiceNames,
  summarizeGroups,
  systemSourceIsStale,
  hasStartupReadinessMismatch,
  hasUnknownListener,
  validateSystemReadinessReport,
  validateLoginStatusReport,
  unavailableAuthenticationGroup,
  validProcessId,
  writeJsonAtomically,
};
