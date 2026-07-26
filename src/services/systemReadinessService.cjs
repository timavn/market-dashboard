const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  SERVICE_MANIFEST,
  ageSeconds,
  makeCheck,
  buildSystemReadiness,
  evaluateHermesWorker,
  evaluateGmailIngestion,
  evaluatePredictionMarketDisplay,
  evaluatePredictionMarketExecution,
} = require('../utils/systemReadiness.cjs');
const { computeRuntimeFingerprint } = require('../utils/runtimeFingerprint.cjs');
const {
  buildResearchPipelineCoverage,
  collectResearchPipelineCoverage,
} = require('../utils/researchPipelineCoverage.cjs');

const REPO_ROOT = path.resolve(__dirname, '../..');
const RUNTIME_BOOT_FINGERPRINT = computeRuntimeFingerprint(REPO_ROOT);
const DEFAULT_SUPERVISOR_STATE_FILE = path.join(
  os.homedir(),
  'Library/Application Support/market-dashboard/dev-stack.json',
);
const DEFAULT_LAUNCH_AGENT_PATH = path.join(
  os.homedir(),
  'Library/LaunchAgents/com.market-dashboard.stack.plist',
);

const SERVICE_DEFINITIONS = new Map(
  (SERVICE_MANIFEST.services || []).map((service) => [String(service.id), service]),
);
const DEFAULT_WORKER_THRESHOLDS_MINUTES = Object.fromEntries(
  ['quant-analyst', 'quant-developer', 'security'].map((key) => {
    const service = SERVICE_DEFINITIONS.get(`hermes.${key}`);
    return [key, Number(service?.readinessMaxAgeMinutes) || 45];
  }),
);
const DEFAULT_SERVICE_HEARTBEAT_TABLE = process.env.SERVICE_HEARTBEAT_TABLE
  || SERVICE_MANIFEST.aws?.resources?.serviceHeartbeatTable
  || 'MarketDashboardServiceHeartbeats';
const RESEARCH_PIPELINE_TABLES = Object.freeze({
  ledger: process.env.HERMES_EMAIL_LEDGER_TABLE
    || SERVICE_MANIFEST.aws?.resources?.gmailLedgerTable
    || 'HermesEmailIngestLedger',
  snapshots: process.env.HEDGEYE_DAILY_SNAPSHOT_TABLE
    || SERVICE_MANIFEST.aws?.resources?.hedgeyeDailySnapshotTable
    || 'HedgeyeDailySnapshot',
  events: process.env.RESEARCH_ENTITY_EVENTS_TABLE
    || SERVICE_MANIFEST.aws?.resources?.researchEntityEventsTable
    || 'ResearchEntityEventsV1',
  manifests: process.env.RESEARCH_PRODUCT_MANIFEST_TABLE
    || SERVICE_MANIFEST.aws?.resources?.researchProductManifestTable
    || 'ResearchProductManifestsV1',
});
const GMAIL_READINESS_MAX_AGE_MINUTES = Number(
  SERVICE_DEFINITIONS.get('gmail.ingestion')?.readinessMaxAgeMinutes,
) || 45;

function errorMessage(result) {
  if (!result || result.status !== 'rejected') return null;
  return result.reason?.message || String(result.reason || 'Unknown error');
}

function fulfilledValue(result) {
  return result?.status === 'fulfilled' ? result.value : null;
}

function serviceHeartbeatErrorCode(error) {
  const code = String(error?.code || error?.name || '').toUpperCase();
  if (code.includes('ACCESSDENIED') || /not authorized/i.test(String(error?.message || ''))) {
    return 'SERVICE_HEARTBEAT_ACCESS_DENIED';
  }
  if (code.includes('RESOURCENOTFOUND')) return 'SERVICE_HEARTBEAT_TABLE_MISSING';
  return 'SERVICE_HEARTBEAT_QUERY_FAILED';
}

function easternParts(now) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function isHermesDueNow(now, workerKey = null) {
  const parts = easternParts(now);
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  const service = workerKey ? SERVICE_DEFINITIONS.get(`hermes.${workerKey}`) : null;
  const window = service?.scheduleWindow || {
    weekdays: true,
    startHour: 8,
    endHour: 18,
  };
  if (window.weekdays !== false && ['Sat', 'Sun'].includes(parts.weekday)) return false;
  if (hour < Number(window.startHour) || hour >= Number(window.endHour)) return false;
  const minutesIntoWindow = (hour - Number(window.startHour)) * 60 + minute;
  return minutesIntoWindow >= Math.max(1, Number(service?.cadenceMinutes) || 1);
}

function businessDaysSince(dateValue, now = new Date()) {
  const observed = dateValue ? new Date(`${String(dateValue).slice(0, 10)}T12:00:00Z`) : null;
  if (!observed || Number.isNaN(observed.getTime())) return null;
  const cursor = new Date(observed);
  const end = new Date(now);
  cursor.setUTCHours(12, 0, 0, 0);
  end.setUTCHours(12, 0, 0, 0);
  let days = 0;
  while (cursor < end && days < 3660) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const weekday = cursor.getUTCDay();
    if (weekday !== 0 && weekday !== 6) days += 1;
  }
  return days;
}

async function getLambdaActivity(cloudwatch, functionName, now, windowMinutes) {
  if (!cloudwatch || !functionName) {
    return { error: 'CloudWatch or Lambda function name is not configured.' };
  }
  const common = {
    Namespace: 'AWS/Lambda',
    Dimensions: [{ Name: 'FunctionName', Value: functionName }],
    StartTime: new Date(now.getTime() - windowMinutes * 60 * 1000),
    EndTime: now,
    Period: 300,
    Statistics: ['Sum'],
  };
  try {
    const [invocationData, errorData] = await Promise.all([
      cloudwatch.getMetricStatistics({ ...common, MetricName: 'Invocations' }).promise(),
      cloudwatch.getMetricStatistics({ ...common, MetricName: 'Errors' }).promise(),
    ]);
    const invocations = (invocationData.Datapoints || [])
      .reduce((sum, point) => sum + Number(point.Sum || 0), 0);
    const errors = (errorData.Datapoints || [])
      .reduce((sum, point) => sum + Number(point.Sum || 0), 0);
    const latestAt = [...(invocationData.Datapoints || []), ...(errorData.Datapoints || [])]
      .filter((point) => point.Timestamp)
      .sort((a, b) => new Date(b.Timestamp) - new Date(a.Timestamp))[0]?.Timestamp || null;
    return {
      functionName,
      invocations,
      errors,
      latestAt: latestAt ? new Date(latestAt).toISOString() : null,
      windowMinutes,
    };
  } catch (error) {
    return { functionName, error: error.message, windowMinutes };
  }
}

async function getServiceHeartbeat(
  dynamodb,
  serviceId,
  { tableName = process.env.SERVICE_HEARTBEAT_TABLE || DEFAULT_SERVICE_HEARTBEAT_TABLE } = {},
) {
  if (!dynamodb || typeof dynamodb.query !== 'function') {
    return {
      available: false,
      found: false,
      serviceId,
      tableName,
      errorCode: 'SERVICE_HEARTBEAT_CLIENT_UNAVAILABLE',
      error: 'DynamoDB heartbeat access is not configured.',
    };
  }
  try {
    const result = await dynamodb.query({
      TableName: tableName,
      KeyConditionExpression: '#serviceId = :serviceId',
      ExpressionAttributeNames: { '#serviceId': 'serviceId' },
      ExpressionAttributeValues: { ':serviceId': serviceId },
      ScanIndexForward: false,
      Limit: 1,
    }).promise();
    const heartbeat = Array.isArray(result?.Items) ? result.Items[0] || null : null;
    return {
      available: true,
      found: Boolean(heartbeat),
      serviceId,
      tableName,
      heartbeat,
    };
  } catch (error) {
    return {
      available: false,
      found: false,
      serviceId,
      tableName,
      errorCode: serviceHeartbeatErrorCode(error),
      error: error.message || String(error),
    };
  }
}

async function collectHermesWorkerSignals({
  dynamodb,
  cloudwatch,
  workerDefinitions,
  now,
  heartbeatReader = getServiceHeartbeat,
  metricReader = getLambdaActivity,
}) {
  const definitions = Array.isArray(workerDefinitions) ? workerDefinitions : [];
  const functionUseCounts = definitions.reduce((counts, definition) => {
    const name = String(definition?.functionName || '');
    if (name) counts.set(name, (counts.get(name) || 0) + 1);
    return counts;
  }, new Map());
  const heartbeatResults = await Promise.all(definitions.map(async (definition) => {
    const serviceId = definition.heartbeatServiceId || `hermes:${definition.key}`;
    try {
      return await heartbeatReader(dynamodb, serviceId);
    } catch (error) {
      return {
        available: false,
        found: false,
        serviceId,
        errorCode: serviceHeartbeatErrorCode(error),
        error: error.message || String(error),
      };
    }
  }));

  return Promise.all(definitions.map(async (definition, index) => {
    const heartbeatStore = heartbeatResults[index];
    if (heartbeatStore?.available === true) {
      return {
        definition,
        heartbeatStore,
        heartbeat: heartbeatStore.heartbeat || null,
        invocation: null,
      };
    }
    if ((functionUseCounts.get(String(definition.functionName || '')) || 0) > 1) {
      return {
        definition,
        heartbeatStore,
        heartbeat: null,
        invocation: {
          errorCode: 'HERMES_SHARED_LAMBDA_METRICS_NOT_SERVICE_SPECIFIC',
          error: 'Per-service heartbeat data is unavailable; shared Lambda metrics cannot prove this worker ran.',
          source: 'shared-lambda-metrics-rejected',
        },
      };
    }
    return {
      definition,
      heartbeatStore,
      heartbeat: null,
      invocation: await metricReader(cloudwatch, definition.functionName, now, 180),
    };
  }));
}

async function probeUrl(url, { timeoutMs = 2_000 } = {}) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return {
    ok: true,
    status: response.status,
    contentType: response.headers.get('content-type'),
    observedAt: new Date().toISOString(),
  };
}

async function getLocalCurrentPredictionMarkets({ timeoutMs = 8_000 } = {}) {
  const port = Number(process.env.PORT || 3001);
  const response = await fetch(`http://127.0.0.1:${port}/api/prediction-markets/cpi/current`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `Current CPI endpoint returned HTTP ${response.status}`);
  }
  return payload;
}

function processIsAlive(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

function processCommand(pid) {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function getSupervisorProvenance({
  stateFile = process.env.MARKET_DASHBOARD_SUPERVISOR_STATE_FILE || DEFAULT_SUPERVISOR_STATE_FILE,
  repoRoot = REPO_ROOT,
} = {}) {
  try {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const pid = Number(state?.supervisor?.pid);
    const command = processCommand(pid);
    const expectedCli = path.join(repoRoot, 'scripts/dev-stack/cli.js');
    const rootMatches = Boolean(state?.root)
      && path.resolve(String(state.root)) === path.resolve(repoRoot);
    const commandMatches = (command.includes(expectedCli) || command.includes('scripts/dev-stack/cli.js'))
      && /\b(?:start|restart|monitor)\b/.test(command);
    const bootFingerprint = state?.sourceFingerprint || null;
    const currentFingerprint = computeRuntimeFingerprint(repoRoot);
    const sourceMatches = Boolean(
      bootFingerprint?.digest
      && currentFingerprint.digest
      && bootFingerprint.digest === currentFingerprint.digest
    );
    const children = Object.fromEntries(Object.entries(state?.children || {}).map(([name, child]) => {
      const childPid = Number(child?.pid) || null;
      const childCommand = processCommand(childPid);
      const expectedBridge = path.join(repoRoot, 'scripts/ops/hermes_snapshot_bridge.js');
      return [name, {
        pid: childPid,
        status: child?.status || null,
        running: processIsAlive(childPid),
        commandMatches: name === 'bridge' ? childCommand.includes(expectedBridge) : null,
        lastHeartbeatAt: child?.lastHeartbeatAt || null,
        lastSuccessAt: child?.lastSuccessAt || null,
        lastResultStatus: child?.lastResultStatus || null,
        lastErrorCode: child?.lastErrorCode || null,
        restarts: Number(child?.restarts) || 0,
      }];
    }));
    return {
      stateFile,
      stateFound: true,
      instanceId: state?.startedAt || null,
      pid: Number.isInteger(pid) ? pid : null,
      running: processIsAlive(pid),
      rootMatches,
      commandMatches,
      sourceFingerprint: bootFingerprint,
      currentSourceFingerprint: currentFingerprint,
      sourceMatches,
      childPids: Object.fromEntries(Object.entries(children).map(([name, child]) => [name, child.pid])),
      children,
    };
  } catch (error) {
    return {
      stateFile,
      stateFound: false,
      running: false,
      rootMatches: false,
      commandMatches: false,
      error: error.code === 'ENOENT' ? 'Supervisor state file was not found.' : error.message,
    };
  }
}

function getRuntimeProvenance({ repoRoot = REPO_ROOT } = {}) {
  const cwd = path.resolve(process.cwd());
  const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : null;
  const expectedEntrypoint = path.join(repoRoot, 'server.js');
  const currentFingerprint = computeRuntimeFingerprint(repoRoot);
  const bootFingerprint = path.resolve(repoRoot) === path.resolve(REPO_ROOT)
    ? RUNTIME_BOOT_FINGERPRINT
    : null;
  const sourceMatches = Boolean(
    bootFingerprint?.digest
    && currentFingerprint.digest
    && bootFingerprint.digest === currentFingerprint.digest
  );
  return {
    pid: process.pid,
    node: process.version,
    executable: process.execPath,
    cwd,
    entrypoint,
    expectedRoot: repoRoot,
    rootMatches: cwd === path.resolve(repoRoot),
    entrypointMatches: entrypoint === expectedEntrypoint,
    packageVersion: require('../../package.json').version,
    buildVersion: process.env.MARKET_DASHBOARD_BUILD_VERSION || require('../../package.json').version,
    startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    bootSourceFingerprint: bootFingerprint,
    currentSourceFingerprint: currentFingerprint,
    sourceMatches,
  };
}

function getLaunchAgentProvenance({
  plistPath = DEFAULT_LAUNCH_AGENT_PATH,
  repoRoot = REPO_ROOT,
  env = process.env,
  readFile = (file) => fs.readFileSync(file, 'utf8'),
  runLaunchctl = (domain) => execFileSync(
    'launchctl',
    ['print', domain],
    { encoding: 'utf8', timeout: 1500 },
  ),
  uid = typeof process.getuid === 'function' ? process.getuid() : null,
} = {}) {
  const label = 'com.market-dashboard.stack';
  let contents = '';
  let installed = false;
  let configured = false;
  let configError = null;
  try {
    contents = readFile(plistPath);
    installed = true;
    configured = contents.includes(`<string>${label}</string>`)
      && contents.includes(path.resolve(repoRoot))
      && contents.includes('scripts/dev-stack/cli.js');
    if (!configured) configError = 'The installed plist does not target this repository supervisor.';
  } catch (error) {
    configError = error.code === 'ENOENT' ? 'The LaunchAgent plist is not installed.' : error.message;
  }

  let loaded = false;
  let launchctlError = null;
  const domain = uid == null ? null : `gui/${uid}/${label}`;
  if (domain) {
    try {
      const output = String(runLaunchctl(domain) || '');
      loaded = output.includes(label) || /\bstate\s*=\s*(?:running|waiting)/i.test(output);
    } catch (error) {
      launchctlError = String(error?.message || error);
    }
  }
  const inheritedLabel = env.MARKET_DASHBOARD_LAUNCHD_LABEL === label;
  return {
    label,
    plistPath,
    installed,
    configured,
    loaded,
    inheritedLabel,
    verified: installed && configured && loaded && inheritedLabel,
    configError,
    launchctlError,
  };
}

function buildDashboardChecks({ uiResult, supervisor, runtime, launchAgent, now }) {
  const ui = fulfilledValue(uiResult);
  const startRecovery = {
    kind: 'command',
    label: 'Start missing repo-owned dashboard services.',
    command: 'npm start',
  };
  const uiCheck = ui?.ok === true
    ? makeCheck({
        id: 'dashboard.ui',
        label: 'Dashboard UI',
        status: 'pass',
        summary: `React UI answered on port 3000 (HTTP ${ui.status}).`,
        observedAt: ui.observedAt || now,
        now,
        provenance: { url: 'http://127.0.0.1:3000/', contentType: ui.contentType || null },
      })
    : serviceFailureCheck({
        id: 'dashboard.ui',
        label: 'Dashboard UI',
        message: `React UI did not answer on port 3000${errorMessage(uiResult) ? `: ${errorMessage(uiResult)}` : '.'}`,
        errorCode: 'DASHBOARD_UI_UNREACHABLE',
        impact: 'The dashboard cannot be opened in the browser.',
        recovery: startRecovery,
      });

  const supervisorVerified = supervisor?.stateFound === true
    && supervisor?.running === true
    && supervisor?.rootMatches === true
    && supervisor?.commandMatches === true
    && supervisor?.sourceMatches === true;
  const supervisorCheck = makeCheck({
    id: 'dashboard.supervisor',
    label: 'Dashboard supervisor',
    status: supervisorVerified ? 'pass' : 'warn',
    summary: supervisorVerified
      ? `Repo-owned supervisor is active (PID ${supervisor.pid}).`
      : 'The dashboard is running without a verified repo-owned supervisor.',
    detail: supervisorVerified
      ? `Instance ${supervisor.instanceId || 'unknown'}; state ${supervisor.stateFile}.`
      : supervisor?.error || (supervisor?.sourceMatches === false
        ? 'The supervisor boot fingerprint does not match the current readiness source files.'
        : 'Supervisor state, process, repository root, command signature, or boot fingerprint did not verify.'),
    errorCode: supervisorVerified
      ? null
      : (supervisor?.sourceMatches === false ? 'DASHBOARD_SUPERVISOR_CODE_DRIFT' : 'DASHBOARD_SUPERVISOR_UNVERIFIED'),
    observedAt: now,
    now,
    impact: supervisorVerified ? null : 'Automatic restart of failed local services is not guaranteed.',
    recovery: supervisorVerified ? null : startRecovery,
    provenance: supervisor,
  });

  const runtimeVerified = runtime?.rootMatches === true
    && runtime?.entrypointMatches === true
    && runtime?.sourceMatches === true;
  const runtimeCheck = makeCheck({
    id: 'dashboard.runtime',
    label: 'API runtime provenance',
    status: runtimeVerified ? 'pass' : 'fail',
    summary: runtimeVerified
      ? `API PID ${runtime.pid} is running server.js from this repository.`
      : (runtime?.rootMatches === true && runtime?.entrypointMatches === true
        ? 'The API is running from this repository, but its booted source differs from the current readiness source.'
        : 'The API process did not match the expected repository runtime.'),
    detail: `${runtime?.node || 'Node unknown'}; build ${runtime?.buildVersion || 'unknown'}; cwd ${runtime?.cwd || 'unknown'}; entrypoint ${runtime?.entrypoint || 'unknown'}; source ${runtime?.bootSourceFingerprint?.digest || 'unknown'}.`,
    errorCode: runtimeVerified
      ? null
      : (runtime?.rootMatches === true && runtime?.entrypointMatches === true
        ? 'DASHBOARD_CODE_VERSION_DRIFT'
        : 'DASHBOARD_RUNTIME_MISMATCH'),
    observedAt: now,
    now,
    impact: runtimeVerified ? null : 'Health results may be coming from an unintended dashboard checkout or process.',
    recovery: runtimeVerified ? null : {
      kind: 'command',
      label: 'Restart the repo-owned stack so the API loads the current source version.',
      command: 'npm run dev:restart -- --detach',
    },
    provenance: runtime,
  });

  const launchAgentCheck = launchAgent === undefined ? null : makeCheck({
    id: 'dashboard.launchagent',
    label: 'Dashboard LaunchAgent',
    status: launchAgent?.verified === true ? 'pass' : 'warn',
    summary: launchAgent?.verified === true
      ? 'The repo-owned dashboard LaunchAgent is installed, loaded, and supervising this API.'
      : 'The dashboard is not running under the verified repo-owned LaunchAgent.',
    detail: launchAgent?.verified === true
      ? `${launchAgent.label}; ${launchAgent.plistPath}.`
      : [launchAgent?.configError, launchAgent?.launchctlError].filter(Boolean).join(' ') || null,
    errorCode: launchAgent?.verified === true ? null : 'DASHBOARD_LAUNCHAGENT_UNVERIFIED',
    observedAt: now,
    now,
    impact: launchAgent?.verified === true
      ? null
      : 'Login-time startup and recovery after a local process failure are not guaranteed.',
    recovery: launchAgent?.verified === true ? null : {
      kind: 'manual',
      label: 'Install and load the repo-owned dashboard LaunchAgent.',
      command: 'npm run ops:launchagent:install',
    },
    provenance: launchAgent || null,
  });

  return [uiCheck, supervisorCheck, runtimeCheck, ...(launchAgentCheck ? [launchAgentCheck] : [])];
}

function buildHermesBridgeCheck({ supervisor, now }) {
  const bridge = supervisor?.children?.bridge || null;
  const heartbeatAge = ageSeconds(bridge?.lastHeartbeatAt, now);
  const bridgeDefinition = SERVICE_DEFINITIONS.get('dashboard.hermes-bridge')
    || SERVICE_DEFINITIONS.get('local-bridge');
  const heartbeatMaxAgeSeconds = Math.max(
    90,
    Math.floor((Number(process.env.HERMES_BRIDGE_HEARTBEAT_MAX_AGE_MS)
      || Number(bridgeDefinition?.readinessMaxAgeMinutes) * 60_000
      || 180_000) / 1000),
  );
  const intervalMs = Math.max(
    30_000,
    Number(process.env.HERMES_BRIDGE_INTERVAL_MS)
      || Number(bridgeDefinition?.cadenceMinutes) * 60_000
      || 60_000,
  );
  const heartbeatAt = bridge?.lastHeartbeatAt || null;
  const heartbeatMillis = Date.parse(String(heartbeatAt || ''));
  const nextDueAt = Number.isFinite(heartbeatMillis)
    ? new Date(heartbeatMillis + intervalMs).toISOString()
    : null;
  const supervisorVerified = supervisor?.stateFound === true
    && supervisor?.running === true
    && supervisor?.rootMatches === true
    && supervisor?.commandMatches === true
    && supervisor?.sourceMatches === true;
  const ready = supervisorVerified
    && bridge?.running === true
    && bridge?.commandMatches === true
    && bridge?.status === 'ready'
    && bridge?.lastResultStatus === 'ready'
    && heartbeatAge != null
    && heartbeatAge <= heartbeatMaxAgeSeconds;

  if (ready) {
    return makeCheck({
      id: 'dashboard.hermes-bridge',
      label: 'Hermes snapshot bridge',
      status: 'pass',
      summary: `Outbound snapshot bridge is healthy (PID ${bridge.pid}).`,
      detail: 'The bridge has no inbound listener and its latest publish heartbeat succeeded.',
      observedAt: heartbeatAt,
      lastSuccessAt: bridge.lastSuccessAt || heartbeatAt,
      nextDueAt,
      now,
      provenance: { mode: 'outbound-only', ...bridge },
    });
  }

  let summary = 'Hermes snapshot bridge health could not be verified.';
  let errorCode = 'HERMES_BRIDGE_UNVERIFIED';
  if (!supervisorVerified) {
    summary = 'The snapshot bridge cannot be verified without the repo-owned supervisor.';
    errorCode = 'HERMES_BRIDGE_SUPERVISOR_UNVERIFIED';
  } else if (!bridge?.running) {
    summary = 'The supervisor does not have a running Hermes snapshot bridge.';
    errorCode = 'HERMES_BRIDGE_NOT_RUNNING';
  } else if (bridge?.commandMatches !== true) {
    summary = 'The recorded bridge PID does not match the repository bridge command.';
    errorCode = 'HERMES_BRIDGE_PROVENANCE_MISMATCH';
  } else if (heartbeatAge == null || heartbeatAge > heartbeatMaxAgeSeconds) {
    summary = `The bridge publish heartbeat is missing or older than ${heartbeatMaxAgeSeconds} seconds.`;
    errorCode = 'HERMES_BRIDGE_HEARTBEAT_STALE';
  } else if (bridge?.lastResultStatus !== 'ready') {
    summary = 'The bridge is running, but its latest outbound snapshot publish failed.';
    errorCode = bridge?.lastErrorCode || 'HERMES_BRIDGE_PUBLISH_FAILED';
  }

  return makeCheck({
    id: 'dashboard.hermes-bridge',
    label: 'Hermes snapshot bridge',
    status: 'fail',
    summary,
    detail: bridge?.lastErrorCode ? `Latest bridge error: ${bridge.lastErrorCode}.` : null,
    errorCode,
    observedAt: heartbeatAt,
    lastSuccessAt: bridge?.lastSuccessAt || null,
    nextDueAt,
    now,
    impact: 'Cloud Hermes workers cannot receive a verified current local portfolio snapshot.',
    recovery: {
      kind: 'command',
      label: 'Restart the repo-owned supervisor, then verify a successful bridge heartbeat.',
      command: 'npm run dev:restart -- --detach',
    },
    provenance: { mode: 'outbound-only', ...(bridge || {}) },
  });
}

function serviceFailureCheck({ id, label, message, impact, recovery, blocking = true, ...metadata }) {
  return makeCheck({
    id,
    label,
    status: 'fail',
    blocking,
    summary: message,
    impact,
    recovery,
    ...metadata,
  });
}

function buildSidecarChecks({ livezResult, readyzResult, statusResult, portfolioResult, now }) {
  const livez = fulfilledValue(livezResult);
  const readyz = fulfilledValue(readyzResult);
  const gateway = fulfilledValue(statusResult);
  const portfolio = fulfilledValue(portfolioResult);
  const restart = {
    kind: 'command',
    label: 'Restart the repo-owned dashboard stack.',
    command: 'npm run dev:restart',
  };

  const sidecar = livez
    ? makeCheck({
        id: 'ibkr.sidecar',
        label: 'IBKR sidecar',
        status: 'pass',
        blocking: true,
        summary: 'Sidecar is alive on port 8765.',
        observedAt: livez.time || now,
        now,
      })
    : serviceFailureCheck({
        id: 'ibkr.sidecar',
        label: 'IBKR sidecar',
        message: `Sidecar did not answer /livez${errorMessage(livezResult) ? `: ${errorMessage(livezResult)}` : '.'}`,
        errorCode: 'IBKR_SIDECAR_UNREACHABLE',
        impact: 'Portfolio, IBKR quotes, and prediction-market discovery are unavailable.',
        recovery: restart,
      });

  const runtime = livez?.runtime;
  const runtimeVerified = Boolean(
    runtime
    && runtime.errorCode == null
    && runtime.interpreterInsideWorkspace === true
    && runtime.prefixInsideWorkspace === true
    && runtime.appInsideWorkspace === true
    && runtime.dependenciesInsideWorkspace === true
  );
  const runtimeCheck = runtimeVerified
    ? makeCheck({
        id: 'ibkr.runtime',
        label: 'IBKR sidecar Python runtime',
        status: 'pass',
        blocking: true,
        summary: 'Sidecar invocation, environment, app, and dependencies resolve inside the active workspace.',
        observedAt: livez.time || now,
        provenance: runtime,
        now,
      })
    : serviceFailureCheck({
        id: 'ibkr.runtime',
        label: 'IBKR sidecar Python runtime',
        message: !livez
          ? 'Python runtime provenance cannot be verified until the sidecar is running.'
          : (!runtime
            ? 'The running sidecar does not publish Python runtime provenance.'
            : 'The sidecar invocation, environment, app, or dependencies resolve outside the active workspace.'),
        errorCode: runtime?.errorCode || (livez ? 'RUNTIME_PROVENANCE_MISSING' : 'RUNTIME_PROVENANCE_UNAVAILABLE'),
        dependsOn: livez ? [] : ['ibkr.sidecar'],
        observedAt: livez?.time || null,
        impact: 'The sidecar may be executing old or globally installed code and cannot satisfy live portfolio readiness.',
        recovery: {
          kind: 'command',
          label: 'Rebuild the workspace-owned sidecar environment and restart the supervised stack.',
          command: 'npm run dev:sidecar:rebuild && npm run dev:restart -- --detach',
        },
        provenance: runtime || null,
        now,
      });

  const connected = readyz?.ok === true
    && readyz?.connected === true
    && gateway?.connected === true
    && gateway?.status === 'connected';
  const gatewayCheck = connected
    ? makeCheck({
        id: 'ibkr.gateway',
        label: 'IB Gateway authentication',
        status: 'pass',
        blocking: true,
        summary: `Connected to IB Gateway on port ${gateway.port || 4001}.`,
        detail: `${(gateway.accounts || []).length} managed account(s); client ID ${gateway.client_id ?? 'unknown'}.`,
        observedAt: gateway.time || readyz.time || now,
        now,
      })
    : serviceFailureCheck({
        id: 'ibkr.gateway',
        label: 'IB Gateway authentication',
        message: livez
          ? `Sidecar is alive, but Gateway is not authenticated${errorMessage(readyzResult) ? `: ${errorMessage(readyzResult)}` : '.'}`
          : 'Gateway cannot be checked until the sidecar is running.',
        errorCode: livez ? 'IBKR_GATEWAY_NOT_AUTHENTICATED' : 'IBKR_GATEWAY_UNAVAILABLE',
        impact: 'No live brokerage data or trading capability is available.',
        recovery: {
          kind: 'manual',
          label: 'Open IB Gateway, sign in, confirm API socket access on port 4001, then refresh.',
        },
      });

  const accounts = gateway?.accounts || readyz?.accounts || [];
  const accountsCheck = connected && accounts.length > 0
    ? makeCheck({
        id: 'ibkr.accounts',
        label: 'Managed IBKR accounts',
        status: 'pass',
        blocking: true,
        summary: `${accounts.length} managed account(s) are available.`,
        detail: accounts.join(', '),
        observedAt: gateway.time || now,
        now,
      })
    : serviceFailureCheck({
        id: 'ibkr.accounts',
        label: 'Managed IBKR accounts',
        message: connected ? 'Gateway connected without returning a managed account.' : 'Accounts are unavailable while Gateway is disconnected.',
        errorCode: 'IBKR_ACCOUNTS_UNAVAILABLE',
        impact: 'The dashboard cannot select or load a live portfolio.',
        recovery: {
          kind: 'manual',
          label: 'Verify the IB Gateway login has access to the intended accounts and reconnect.',
        },
      });

  const positions = Array.isArray(portfolio?.positions) ? portfolio.positions : [];
  const liveAccounts = Array.isArray(portfolio?.accounts) ? portfolio.accounts.filter(Boolean) : [];
  const observedAt = portfolio?.observed_at || null;
  const socketVerifiedAt = portfolio?.socket_verified_at || null;
  const observationAge = ageSeconds(observedAt, now);
  const socketAge = ageSeconds(socketVerifiedAt, now);
  const liveSessionVerified = portfolio?.ok === true
    && portfolio?.connected === true
    && portfolio?.status === 'live'
    && portfolio?.source === 'ibkr_live_session';
  const managedAccountsVerified = liveAccounts.length > 0
    && (accounts.length === 0 || accounts.every((account) => liveAccounts.includes(account)));
  const socketFresh = observationAge != null
    && socketAge != null
    && observationAge <= 5 * 60
    && socketAge <= 5 * 60;
  const portfolioLive = connected && liveSessionVerified && managedAccountsVerified && socketFresh;
  const portfolioCheck = portfolioLive
    ? makeCheck({
        id: 'ibkr.portfolio',
        label: 'Live portfolio session',
        status: 'pass',
        blocking: true,
        summary: `${positions.length} live position(s) verified across ${liveAccounts.length} managed account(s).`,
        detail: positions.length === 0
          ? 'The verified live IB session currently has no open positions; an empty position set is valid.'
          : `Socket verified at ${socketVerifiedAt}.`,
        observedAt,
        provenance: {
          source: portfolio.source,
          status: portfolio.status,
          accountCount: liveAccounts.length,
          positionCount: positions.length,
          socketVerifiedAt,
        },
        now,
      })
    : serviceFailureCheck({
        id: 'ibkr.portfolio',
        label: 'Live portfolio session',
        message: !connected
          ? 'Live portfolio cannot be verified while Gateway is disconnected.'
          : (!portfolio
            ? `The live-session position endpoint did not answer${errorMessage(portfolioResult) ? `: ${errorMessage(portfolioResult)}` : '.'}`
            : (!liveSessionVerified
              ? 'The position response was not verified as a current IB live session.'
              : (!managedAccountsVerified
                ? 'The verified live session did not cover every managed account.'
                : 'The live-session socket verification is older than five minutes.'))),
        errorCode: !connected
          ? 'IBKR_PORTFOLIO_UNAVAILABLE'
          : (!portfolio
            ? 'IBKR_LIVE_SESSION_UNAVAILABLE'
            : (!liveSessionVerified
              ? 'IBKR_LIVE_SESSION_UNVERIFIED'
              : (!managedAccountsVerified
                ? 'IBKR_LIVE_ACCOUNTS_UNVERIFIED'
                : 'IBKR_LIVE_SESSION_STALE'))),
        observedAt,
        lastSuccessAt: liveSessionVerified ? observedAt : null,
        impact: 'Portfolio values must not be trusted or used for decisions.',
        recovery: restart,
        provenance: portfolio ? {
          source: portfolio.source || null,
          status: portfolio.status || null,
          accountCount: liveAccounts.length,
          positionCount: positions.length,
          socketVerifiedAt,
        } : null,
      });

  return [sidecar, runtimeCheck, gatewayCheck, accountsCheck, portfolioCheck];
}

function buildResearchPipelineCheck({ coverage, gmailCheck, now }) {
  if (!coverage || !Array.isArray(coverage.products)) return null;
  const summary = coverage.summary || {};
  const status = coverage.status === 'complete'
    ? 'pass'
    : (coverage.status === 'degraded' ? 'warn' : 'fail');
  const failed = Number(summary.failed || 0);
  const missing = Number(summary.missing || 0);
  const incomplete = Number(summary.received || 0)
    + Number(summary.parsed || 0)
    + Number(summary.validated || 0);
  const indexed = Number(summary.indexed || 0);
  const notDue = Number(summary.not_due || 0);
  const unavailable = Array.isArray(coverage.collectionErrors)
    && coverage.collectionErrors.length > 0;
  let summaryText;
  if (status === 'pass') {
    summaryText = `${indexed} product publication(s) are fully indexed; ${notDue} product(s) are not due.`;
  } else if (unavailable) {
    summaryText = 'Daily research product coverage could not be verified from the authoritative pipeline evidence.';
  } else {
    summaryText = [
      failed ? `${failed} failed` : null,
      missing ? `${missing} missing` : null,
      incomplete ? `${incomplete} still processing` : null,
      indexed ? `${indexed} indexed` : null,
      notDue ? `${notDue} not due` : null,
    ].filter(Boolean).join(', ');
  }
  const dependsOnGmail = !unavailable
    && coverage.products.some((product) => (
      ['missing', 'received'].includes(product.status)
      && product.errorCode !== 'RESEARCH_PRODUCT_UNSUPPORTED'
    ))
    && gmailCheck?.status !== 'pass';

  return makeCheck({
    id: 'research.pipeline-coverage',
    label: 'Daily research product pipeline',
    status,
    blocking: false,
    errorCode: status === 'pass'
      ? null
      : (unavailable
        ? 'RESEARCH_PIPELINE_EVIDENCE_UNAVAILABLE'
        : (failed || missing
          ? 'RESEARCH_PRODUCT_COVERAGE_FAILED'
          : 'RESEARCH_PRODUCT_COVERAGE_INCOMPLETE')),
    dependsOn: dependsOnGmail ? ['gmail.ingestion'] : [],
    summary: summaryText || 'No registered research products were evaluated.',
    detail: unavailable
      ? coverage.collectionErrors.join(' ')
      : `Market date ${coverage.marketDate}. Every received publication must complete received, parsed, validated, and indexed stages.`,
    observedAt: coverage.generatedAt,
    now,
    impact: status === 'pass'
      ? null
      : 'Portfolio research context may be incomplete. Live IBKR holdings remain independently verified and unaffected.',
    recovery: status === 'pass'
      ? null
      : {
        kind: 'manual',
        label: 'Inspect the product matrix, repair the first incomplete stage, replay immutable artifacts, and refresh SYS.',
      },
    provenance: {
      source: 'research-product-manifests-and-ledgers',
      marketDate: coverage.marketDate,
      status: coverage.status,
      summary,
      tableNames: RESEARCH_PIPELINE_TABLES,
    },
  });
}

function buildResearchChecks({
  rtaResult,
  etfResult,
  workflow,
  gmailCheck,
  researchPipelineCoverage = null,
  now,
}) {
  const rta = fulfilledValue(rtaResult);
  const etf = fulfilledValue(etfResult);
  const rtaCacheStale = rta?._readinessCache?.status === 'stale';
  const etfCacheStale = etf?._readinessCache?.status === 'stale';
  const workflowCacheStale = workflow?._readinessCache?.status === 'stale';
  const rtaWarnings = [...new Set([
    ...(Array.isArray(rta?.dataQuality?.warnings) ? rta.dataQuality.warnings : []),
    ...(Array.isArray(rta?.reconstructionWarnings) ? rta.reconstructionWarnings : []),
  ].filter(Boolean))];
  const gmailWasEvaluated = Boolean(gmailCheck);
  const gmailPassed = gmailCheck?.status === 'pass';
  const researchPipelineState = (payload) => {
    const availability = payload?.dataAvailability || {};
    const explicitlyUnhealthy = availability.current === false
      || ['unhealthy', 'stale', 'auth_required', 'error', 'failed'].includes(
        String(availability.ingestionStatus || availability.ingestionState || '').toLowerCase(),
      );
    const payloadHealthy = availability.current === true
      || String(availability.ingestionStatus || '').toLowerCase() === 'healthy'
      || payload?.meta?.ingestionStatus === 'healthy';
    const healthy = gmailWasEvaluated
      ? gmailPassed && !explicitlyUnhealthy
      : payloadHealthy && !explicitlyUnhealthy;
    return {
      healthy,
      availability,
      errorCode: availability.errorCode
        || (!gmailPassed ? gmailCheck?.errorCode : null)
        || 'GMAIL_HEARTBEAT_UNVERIFIED',
      reason: availability.reason
        || (!gmailPassed ? gmailCheck?.summary || gmailCheck?.detail : null)
        || 'Scheduled Gmail ingestion health could not be verified.',
      observedAt: availability.pipelineObservedAt || gmailCheck?.observedAt || null,
      lastSuccessAt: availability.pipelineLastSuccessAt || gmailCheck?.lastSuccessAt || null,
      recovery: gmailCheck?.recovery || {
        kind: 'manual',
        label: 'Restore scheduled Gmail ingestion, process the missed messages, then refresh readiness.',
      },
    };
  };

  const rtaPipeline = researchPipelineState(rta);
  const rtaContentAt = rta?.dataAvailability?.latestContentAt || rta?.lastUpdated || null;
  const rtaContentDate = rta?.dataAvailability?.contentDate
    || (rtaContentAt ? String(rtaContentAt).slice(0, 10) : null);
  const rtaStructurallyAvailable = !rtaCacheStale
    && rta?.available === true
    && rta?.dataQuality?.status !== 'error';
  const rtaStructuralErrorCode = rta?.dataQuality?.invalidEvents?.[0]?.code
    || rta?.dataAvailability?.errorCode
    || null;
  let rtaCheck;
  if (rtaStructurallyAvailable && rtaPipeline.healthy) {
    rtaCheck = makeCheck({
      id: 'research.rta',
      label: 'RTA positions',
      status: rtaWarnings.length ? 'warn' : 'pass',
      blocking: false,
      summary: rtaWarnings.length
        ? `RTA positions loaded with ${rtaWarnings.length} reconstruction warning(s).`
        : `RTA ingestion is current; the latest position-changing content is ${rtaContentDate || 'undated'}.`,
      detail: [
        `${Number(rta.longCount || 0)} long / ${Number(rta.shortCount || 0)} short position(s).`,
        ...rtaWarnings,
      ].join(' '),
      dependsOn: [],
      observedAt: rtaPipeline.observedAt || rtaContentAt,
      lastSuccessAt: rtaPipeline.lastSuccessAt || null,
      now,
      impact: rtaWarnings.length ? 'The RTA position book may be incomplete.' : null,
      recovery: rtaWarnings.length ? {
        kind: 'manual',
        label: 'Reconcile the invalid RTA events against the active-position baseline.',
      } : null,
      provenance: {
        contentDate: rtaContentDate,
        latestContentAt: rtaContentAt,
        pipelineObservedAt: rtaPipeline.observedAt,
      },
    });
  } else if (rtaStructurallyAvailable) {
    rtaCheck = makeCheck({
      id: 'research.rta',
      label: 'RTA positions',
      status: 'warn',
      blocking: false,
      errorCode: rtaPipeline.errorCode,
      dependsOn: ['gmail.ingestion'],
      summary: `RTA is last-known-good from ${rtaContentDate || 'an unknown date'}; Gmail ingestion is not current.`,
      detail: [
        `${Number(rta.longCount || 0)} long / ${Number(rta.shortCount || 0)} short position(s).`,
        rtaPipeline.reason,
      ].filter(Boolean).join(' '),
      observedAt: rtaPipeline.observedAt || rtaContentAt,
      lastSuccessAt: rtaPipeline.lastSuccessAt || null,
      now,
      impact: 'RTA positions remain available as dated reference data but are not comparison-safe.',
      recovery: rtaPipeline.recovery,
      provenance: {
        contentDate: rtaContentDate,
        latestContentAt: rtaContentAt,
        pipelineObservedAt: rtaPipeline.observedAt,
      },
    });
  } else {
    rtaCheck = serviceFailureCheck({
      id: 'research.rta',
      label: 'RTA positions',
      blocking: false,
      errorCode: rtaCacheStale
        ? 'RTA_RESPONSE_CACHE_STALE'
        : rtaStructuralErrorCode || 'RTA_PROJECTION_UNAVAILABLE',
      dependsOn: rtaStructuralErrorCode || rtaCacheStale || gmailPassed ? [] : ['gmail.ingestion'],
      message: rta
        ? (rtaCacheStale
          ? 'RTA refresh failed; only a stale cached response is available.'
          : `RTA positions are unavailable${rtaWarnings.length ? `: ${rtaWarnings.join(' ')}` : '.'}`)
        : `RTA check failed${errorMessage(rtaResult) ? `: ${errorMessage(rtaResult)}` : '.'}`,
      detail: rta?.dataAvailability?.reason || null,
      impact: 'RTA long/short positioning cannot be displayed reliably.',
      recovery: {
        kind: 'command',
        label: 'Rebuild the deterministic RTA projections from the immutable Gmail ledger, then refresh.',
        command: 'npm run rebuild:rta -- --apply --window-days=90 --json',
      },
    });
  }

  const activeEtfAvailable = Boolean(etf)
    && etf?.available !== false
    && etf?.meta?.available !== false
    && etf?.dataQuality?.status !== 'error'
    && Array.isArray(etf?.rows)
    && etf.rows.length > 0;
  const referenceEtf = etf?.lastKnownGood;
  const referenceEtfAvailable = Boolean(referenceEtf)
    && referenceEtf?.available !== false
    && referenceEtf?.dataQuality?.status !== 'error'
    && Array.isArray(referenceEtf?.rows)
    && referenceEtf.rows.length > 0;
  const etfBook = activeEtfAvailable ? etf : (referenceEtfAvailable ? referenceEtf : null);
  const snapshotDate = etfBook?.meta?.snapshotDate
    || etf?.dataAvailability?.contentDate
    || null;
  const businessAge = businessDaysSince(snapshotDate, now);
  const etfPipeline = researchPipelineState(etf);
  const etfStructurallyAvailable = !etfCacheStale && Boolean(etfBook);
  let etfCheck;
  if (etfStructurallyAvailable && activeEtfAvailable && etfPipeline.healthy) {
    etfCheck = makeCheck({
      id: 'research.etf-pro',
      label: 'ETF Pro',
      status: 'pass',
      blocking: false,
      summary: `ETF Pro ingestion is current; the latest position-changing content is ${snapshotDate || 'undated'}.`,
      detail: `${etfBook.rows.length} active row(s); ${businessAge ?? 'unknown'} business day(s) since the latest book change. A quiet content date is valid while the Gmail heartbeat remains healthy.`,
      observedAt: etfPipeline.observedAt || etfBook.meta?.parsedAt || snapshotDate,
      lastSuccessAt: etfPipeline.lastSuccessAt || null,
      dependsOn: [],
      now,
      provenance: {
        contentDate: snapshotDate,
        pipelineObservedAt: etfPipeline.observedAt,
      },
    });
  } else if (etfStructurallyAvailable) {
    etfCheck = makeCheck({
      id: 'research.etf-pro',
      label: 'ETF Pro',
      status: 'warn',
      blocking: false,
      errorCode: etfPipeline.errorCode || 'ETF_PRO_INGESTION_BLOCKED',
      dependsOn: ['gmail.ingestion'],
      summary: `ETF Pro is last-known-good from ${snapshotDate || 'an unknown date'} (${etfBook.rows.length} positions); Gmail ingestion is not current.`,
      detail: [
        etfPipeline.reason,
        etfBook.meta?.headline,
      ].filter(Boolean).join(' '),
      observedAt: etfPipeline.observedAt || etfBook.meta?.parsedAt || snapshotDate,
      lastSuccessAt: etfPipeline.lastSuccessAt || null,
      now,
      impact: 'ETF Pro positions remain available as dated reference data but are not comparison-safe.',
      recovery: etfPipeline.recovery,
      provenance: {
        contentDate: snapshotDate,
        pipelineObservedAt: etfPipeline.observedAt,
        referenceOnly: !activeEtfAvailable || etf?.dataAvailability?.referenceOnly === true,
      },
    });
  } else {
    etfCheck = serviceFailureCheck({
      id: 'research.etf-pro',
      label: 'ETF Pro',
      blocking: false,
      errorCode: etfCacheStale
        ? 'ETF_PRO_RESPONSE_CACHE_STALE'
        : etf?.dataAvailability?.errorCode || etf?.meta?.errorCode || 'ETF_PRO_BOOK_UNAVAILABLE',
      dependsOn: etf?.meta?.blockedByIngestion && !gmailPassed ? ['gmail.ingestion'] : [],
      message: !etf
        ? `ETF Pro check failed${errorMessage(etfResult) ? `: ${errorMessage(etfResult)}` : '.'}`
        : (etfCacheStale
          ? 'ETF Pro refresh failed; only a stale cached response is available.'
          : `ETF Pro has no structurally valid active or last-known-good book${snapshotDate ? ` for ${snapshotDate}` : ''}.`),
      detail: etf?.dataAvailability?.reason || etf?.meta?.reason || etf?.meta?.headline || null,
      observedAt: etf?.dataAvailability?.pipelineObservedAt || etf?.meta?.parsedAt || snapshotDate,
      now,
      impact: 'ETF Pro positions and changes are unavailable.',
      recovery: {
        kind: 'manual',
        label: 'Repair ETF Pro projection errors, restore Gmail ingestion if needed, then verify a structurally valid book.',
      },
    });
  }

  const risk = workflow?.hedgeye;
  const riskManifestAccessDenied = risk?.errorCode === 'RISK_RANGE_MANIFEST_ACCESS_DENIED';
  const riskHasIndependentFailure = Boolean(risk?.errorCode)
    && !['RISK_RANGE_PUBLICATION_MISSING', 'RISK_RANGE_INGESTION_STALE'].includes(risk.errorCode);
  const riskStatus = workflowCacheStale
    ? 'fail'
    : (risk?.status === 'success'
      ? 'pass'
      : (risk?.status === 'pending' || risk?.status === 'stale' ? 'warn' : 'fail'));
  const riskCheck = makeCheck({
    id: 'research.risk-ranges',
    label: 'Hedgeye risk ranges',
    status: riskStatus,
    blocking: false,
    errorCode: riskStatus === 'pass' || riskStatus === 'warn'
      ? null
      : (risk?.errorCode || 'RISK_RANGE_PUBLICATION_MISSING'),
    dependsOn: riskHasIndependentFailure || gmailCheck?.status === 'pass'
      ? []
      : ['gmail.ingestion'],
    summary: riskStatus === 'pass'
      ? `Current risk ranges are loaded (${risk.count || 0} rows).`
      : (workflowCacheStale
        ? 'Risk-range status refresh failed; only a stale cached response is available.'
        : risk?.status === 'pending'
          ? `Risk ranges are pending for ${risk.pendingDate || risk.expectedDate || 'the next market session'}; latest verified publication is ${risk.lastRun || 'unavailable'}.`
          : `Risk ranges are ${risk?.status || 'unavailable'}${risk?.lastRun ? `; latest ${risk.lastRun}` : '.'}`),
    observedAt: risk?.scrapedAt || risk?.lastRun,
    detail: risk?.error || risk?.diagnostics?.manifestError || null,
    now,
    impact: riskStatus === 'pass' ? null : 'Risk-range cards may be stale or empty.',
    recovery: riskStatus === 'pass'
      ? null
      : (riskManifestAccessDenied
        ? {
          kind: 'manual',
          label: 'Grant the dashboard API its least-privilege Risk Range manifest policy, then refresh.',
        }
        : {
          kind: 'manual',
          label: 'Run or repair the Hedgeye daily snapshot workflow, then refresh.',
        }),
  });

  const pipelineCheck = buildResearchPipelineCheck({
    coverage: researchPipelineCoverage,
    gmailCheck,
    now,
  });

  return [rtaCheck, etfCheck, riskCheck, ...(pipelineCheck ? [pipelineCheck] : [])];
}

function createSystemReadinessService({
  sidecarRequest,
  getCurrentPredictionMarkets = getLocalCurrentPredictionMarkets,
  getDirectorSnapshot,
  buildWorkflowStatusSnapshot,
  getHermesInboxStatus,
  buildRtaResponse,
  buildEtfResponse,
  dynamodb,
  cloudwatch,
  listWorkerDefinitions,
  readServiceHeartbeat = getServiceHeartbeat,
  readLambdaActivity = getLambdaActivity,
  probeLocalUrl = probeUrl,
  readSupervisorProvenance = getSupervisorProvenance,
  readRuntimeProvenance = getRuntimeProvenance,
  readLaunchAgentProvenance = getLaunchAgentProvenance,
  now: nowProvider = () => new Date(),
}) {
  let cached = null;
  let inFlight = null;
  const cacheMs = Math.max(0, Number(process.env.SYSTEM_READINESS_CACHE_MS || 15_000));

  async function collectUncached() {
    const now = nowProvider();
    const supervisor = readSupervisorProvenance();
    const runtime = readRuntimeProvenance();
    const launchAgent = readLaunchAgentProvenance();
    const [uiResult, livezResult, readyzResult, statusResult, eventsResult, currentPredictionResult, workflowResult, rtaResult, etfResult] = await Promise.allSettled([
      probeLocalUrl('http://127.0.0.1:3000/', { timeoutMs: 2_000 }),
      sidecarRequest('/livez', { timeoutMs: 1500 }),
      sidecarRequest('/readyz', { timeoutMs: 2500 }),
      sidecarRequest('/status', { timeoutMs: 3000 }),
      sidecarRequest('/events', { timeoutMs: 7000 }),
      getCurrentPredictionMarkets(),
      buildWorkflowStatusSnapshot(),
      buildRtaResponse(),
      buildEtfResponse(),
    ]);

    const portfolioResult = await Promise.allSettled([
      sidecarRequest('/portfolio/live-positions', { timeoutMs: 5_000 }),
    ]).then(([result]) => result);

    const workflow = fulfilledValue(workflowResult) || {};
    const researchPipelineCoveragePromise = collectResearchPipelineCoverage({
      dynamodb,
      now,
      riskRange: workflow.hedgeye || null,
      tables: RESEARCH_PIPELINE_TABLES,
    }).catch((error) => buildResearchPipelineCoverage({
      now,
      riskRange: workflow.hedgeye || null,
      collectionErrors: [
        `Research pipeline collection failed (${error.code || error.name || 'COLLECTION_FAILED'}): ${error.message || String(error)}`,
      ],
    }));
    let director = { workers: [], recentRuns: [] };
    try {
      director = await getDirectorSnapshot({ dynamodb, workflowSnapshot: workflow });
    } catch (error) {
      director = { workers: [], recentRuns: [], error: error.message };
    }

    let inbox = workflow.hermesInbox || null;
    if (!inbox) {
      try {
        inbox = await getHermesInboxStatus();
      } catch (error) {
        inbox = { error: error.message };
      }
    }

    const workerDefinitions = listWorkerDefinitions();
    const gmailAccount = inbox?.gmailAccount
      || process.env.HERMES_GMAIL_ACCOUNT
      || 'timsmithaviation@gmail.com';
    const gmailFunction = process.env.HERMES_GMAIL_INGESTOR_FUNCTION
      || SERVICE_DEFINITIONS.get('gmail.ingestion')?.aws?.functionName
      || 'market-dashboard-gmail-ingestor-v2';
    const workerSignals = await collectHermesWorkerSignals({
      dynamodb,
      cloudwatch,
      workerDefinitions,
      now,
      heartbeatReader: readServiceHeartbeat,
      metricReader: readLambdaActivity,
    });
    let gmailHeartbeatStore;
    try {
      gmailHeartbeatStore = await readServiceHeartbeat(
        dynamodb,
        `gmail:${String(gmailAccount).toLowerCase()}`,
      );
    } catch (error) {
      gmailHeartbeatStore = {
        available: false,
        found: false,
        errorCode: serviceHeartbeatErrorCode(error),
        error: error.message || String(error),
      };
    }
    const gmailMetrics = gmailHeartbeatStore?.available === true
      ? null
      : await readLambdaActivity(cloudwatch, gmailFunction, now, GMAIL_READINESS_MAX_AGE_MINUTES);
    const workerSignalByKey = new Map(workerSignals.map((signal) => [signal.definition.key, signal]));
    const recentRuns = Array.isArray(director.recentRuns) ? director.recentRuns : [];
    const workerChecks = workerDefinitions.map((definition) => {
      const due = isHermesDueNow(now, definition.key);
      const signal = workerSignalByKey.get(definition.key) || {};
      const snapshot = (director.workers || []).find((worker) => worker.key === definition.key) || definition;
      const matchingRun = recentRuns.find((run) => run.worker === definition.key);
      let enriched = {
        ...snapshot,
        source: matchingRun?.source || snapshot.source,
      };
      if (signal.heartbeatStore?.available === true && !signal.heartbeat) {
        enriched = {
          ...definition,
          status: 'idle',
          source: 'service-heartbeat-table',
          finishedAt: null,
          lastRun: null,
          summary: `No per-service heartbeat row was found for hermes:${definition.key}.`,
        };
      }
      return evaluateHermesWorker({
        worker: enriched,
        heartbeat: signal.heartbeat,
        now,
        maxAgeMinutes: due
          ? DEFAULT_WORKER_THRESHOLDS_MINUTES[definition.key]
          : 7 * 24 * 60,
        invocation: signal.invocation,
        due,
      });
    });
    if (director.error && workerChecks.length === 0) {
      workerChecks.push(serviceFailureCheck({
        id: 'hermes.status',
        label: 'Hermes worker status',
        message: `Hermes status could not be loaded: ${director.error}`,
        impact: 'Agent activity cannot be verified.',
        recovery: { kind: 'manual', label: 'Verify DynamoDB access and the Hermes worker schedules.' },
      }));
    }

    const gmailCheck = gmailHeartbeatStore?.available !== true
      ? serviceFailureCheck({
          id: 'gmail.ingestion',
          label: 'Gmail authentication and ingestion',
          message: 'The typed Gmail service heartbeat could not be read; Lambda metrics are diagnostic only.',
          errorCode: gmailHeartbeatStore?.errorCode || 'SERVICE_HEARTBEAT_QUERY_FAILED',
          detail: [
            gmailHeartbeatStore?.error,
            gmailMetrics?.error
              ? `CloudWatch diagnostic unavailable: ${gmailMetrics.error}`
              : `CloudWatch diagnostic: ${Number(gmailMetrics?.invocations || 0)} invocation(s), ${Number(gmailMetrics?.errors || 0)} error(s).`,
          ].filter(Boolean).join(' '),
          lastSuccessAt: inbox?.lastSuccessAt || inbox?.lastUpdated || null,
          impact: 'Email-driven dashboard data cannot be trusted without an authoritative typed heartbeat.',
          recovery: {
            kind: 'manual',
            label: 'Grant the dashboard API read access to MarketDashboardServiceHeartbeats, then refresh.',
          },
          provenance: {
            source: 'service-heartbeat-table',
            serviceId: gmailHeartbeatStore?.serviceId || `gmail:${String(gmailAccount).toLowerCase()}`,
            tableName: gmailHeartbeatStore?.tableName || DEFAULT_SERVICE_HEARTBEAT_TABLE,
          },
        })
      : !gmailHeartbeatStore?.heartbeat
        ? serviceFailureCheck({
          id: 'gmail.ingestion',
          label: 'Gmail authentication and ingestion',
          message: `No per-service heartbeat was found for gmail:${String(gmailAccount).toLowerCase()}.`,
          errorCode: 'GMAIL_HEARTBEAT_MISSING',
          lastSuccessAt: inbox?.lastSuccessAt || inbox?.lastUpdated || null,
          impact: 'Email-driven dashboard data is not being refreshed.',
          recovery: {
            kind: 'command',
            label: 'Retry the configured Gmail incremental poll, then refresh readiness.',
            command: 'Retry the configured Gmail incremental poll',
          },
          provenance: {
            source: 'service-heartbeat-table',
            serviceId: gmailHeartbeatStore.serviceId || `gmail:${String(gmailAccount).toLowerCase()}`,
            tableName: gmailHeartbeatStore.tableName || DEFAULT_SERVICE_HEARTBEAT_TABLE,
          },
        })
        : evaluateGmailIngestion({
          account: gmailAccount,
          metrics: gmailMetrics,
          heartbeat: gmailHeartbeatStore?.heartbeat || null,
          inbox,
          now,
          maxAgeMinutes: GMAIL_READINESS_MAX_AGE_MINUTES,
        });

    const currentPredictionPayload = fulfilledValue(currentPredictionResult);
    const predictionDisplayCheck = currentPredictionPayload
      ? evaluatePredictionMarketDisplay({ payload: currentPredictionPayload, now })
      : serviceFailureCheck({
          id: 'prediction.display',
          label: 'Prediction-market live display',
          message: `Current CPI venue data could not be loaded${errorMessage(currentPredictionResult) ? `: ${errorMessage(currentPredictionResult)}` : '.'}`,
          impact: 'Verified live prediction-market prices are unavailable.',
          recovery: {
            kind: 'manual',
            label: 'Verify the current CPI release and Kalshi venue response, then refresh.',
          },
        });
    const executionPayload = currentPredictionPayload || fulfilledValue(eventsResult);
    const predictionExecutionCheck = executionPayload
      ? evaluatePredictionMarketExecution({ payload: executionPayload, now })
      : serviceFailureCheck({
          id: 'prediction.ibkrExecution',
          label: 'Prediction-market IBKR execution catalog',
          message: `IBKR prediction catalog could not be loaded${errorMessage(eventsResult) ? `: ${errorMessage(eventsResult)}` : '.'}`,
          impact: 'Prediction-market order entry through IBKR is unavailable.',
          recovery: {
            kind: 'command',
            label: 'Restore the sidecar, then rediscover the current CPI contracts.',
            command: 'npm run ibkr-sidecar:discover',
          },
        });

    const apiCheck = makeCheck({
      id: 'dashboard.api',
      label: 'Dashboard API server',
      status: 'pass',
      blocking: true,
      summary: `Express API is responding (PID ${process.pid}, uptime ${Math.floor(process.uptime())}s).`,
      observedAt: now,
      now,
      provenance: runtime,
    });
    const dashboardChecks = buildDashboardChecks({ uiResult, supervisor, runtime, launchAgent, now });
    const bridgeCheck = buildHermesBridgeCheck({ supervisor, now });
    const sidecarChecks = buildSidecarChecks({ livezResult, readyzResult, statusResult, portfolioResult, now });
    const researchPipelineCoverage = await researchPipelineCoveragePromise;
    const researchChecks = buildResearchChecks({
      rtaResult,
      etfResult,
      workflow,
      gmailCheck,
      researchPipelineCoverage,
      now,
    });

    const report = buildSystemReadiness([
      {
        id: 'dashboard',
        label: 'Dashboard',
        checks: [dashboardChecks[0], apiCheck, ...dashboardChecks.slice(1)],
      },
      { id: 'brokerage', label: 'IBKR and live portfolio', checks: sidecarChecks },
      { id: 'automation', label: 'Hermes and Gmail automation', checks: [bridgeCheck, ...workerChecks, gmailCheck] },
      {
        id: 'prediction-markets',
        label: 'Prediction markets',
        checks: [predictionDisplayCheck, predictionExecutionCheck],
      },
      { id: 'research', label: 'Research data', checks: researchChecks },
    ], { now });
    return {
      ...report,
      researchProductMatrix: researchPipelineCoverage,
    };
  }

  async function collect({ refresh = false } = {}) {
    if (!refresh && cached && Date.now() - cached.savedAt < cacheMs) return cached.value;
    if (inFlight) return inFlight;
    inFlight = collectUncached()
      .then((value) => {
        cached = { value, savedAt: Date.now() };
        return value;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  return { collect };
}

module.exports = {
  DEFAULT_LAUNCH_AGENT_PATH,
  DEFAULT_SERVICE_HEARTBEAT_TABLE,
  DEFAULT_WORKER_THRESHOLDS_MINUTES,
  businessDaysSince,
  buildDashboardChecks,
  buildHermesBridgeCheck,
  collectHermesWorkerSignals,
  getLambdaActivity,
  getLaunchAgentProvenance,
  getServiceHeartbeat,
  getRuntimeProvenance,
  getSupervisorProvenance,
  isHermesDueNow,
  probeUrl,
  serviceHeartbeatErrorCode,
  buildSidecarChecks,
  buildResearchPipelineCheck,
  buildResearchChecks,
  createSystemReadinessService,
  getLocalCurrentPredictionMarkets,
};
