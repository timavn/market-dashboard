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
} = require('../utils/systemReadiness.cjs');
const { computeRuntimeFingerprint } = require('../utils/runtimeFingerprint.cjs');
const {
  buildResearchPipelineCoverage,
  collectResearchPipelineCoverage,
} = require('../utils/researchPipelineCoverage.cjs');
const {
  legacyHermesIsReadOnly,
  normalizeLegacyHermesMode,
} = require('../utils/legacyHermesMode.cjs');

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
const DEFAULT_CONTROLLER_STATE_FILE = path.join(
  os.homedir(),
  'Library/Application Support/market-dashboard/readiness-controller.json',
);
const DEFAULT_SYSTEM_READINESS_CACHE_MS = 5 * 60 * 1000;
const MIN_SYSTEM_READINESS_CACHE_MS = 5 * 60 * 1000;
// A cached report remains inside the bridge's six-minute evidence contract for
// this entire window. Public callers can consume that still-valid report while
// one background refresh runs, but a completed failed refresh replaces it and
// fails closed immediately.
const SYSTEM_READINESS_REVALIDATE_GRACE_MS = 50 * 1000;
const GIB = 1024 ** 3;
// Analyst work a stack restart would interrupt. Each store counts a row only
// while it was updated inside this window, so an orphaned in-progress row
// cannot defer recovery indefinitely.
const ANALYST_ACTIVITY_WINDOW_SECONDS = 30 * 60;

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

function hermesBridgeEnabled(env = process.env) {
  const enabledValues = ['1', 'true', 'yes', 'on', 'enabled'];
  const legacy = enabledValues
    .includes(String(env.HERMES_BRIDGE_ENABLED || '').trim().toLowerCase());
  const partitionEnabled = (name) => (
    Object.prototype.hasOwnProperty.call(env, name)
      ? enabledValues.includes(String(env[name] || '').trim().toLowerCase())
      : legacy
  );
  return partitionEnabled('HERMES_OPERATIONS_BRIDGE_ENABLED')
    || partitionEnabled('HERMES_PORTFOLIO_BRIDGE_ENABLED');
}

function errorMessage(result) {
  if (!result || result.status !== 'rejected') return null;
  return result.reason?.message || String(result.reason || 'Unknown error');
}

function isFreshTimestamp(value, now, maxAgeSeconds, maxFutureSeconds = 30) {
  const observedMs = Date.parse(String(value || ''));
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now || ''));
  if (!Number.isFinite(observedMs) || !Number.isFinite(nowMs)) return false;
  const ageSecondsValue = (nowMs - observedMs) / 1000;
  return ageSecondsValue >= -maxFutureSeconds && ageSecondsValue <= maxAgeSeconds;
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
  };
  try {
    const [invocationData, errorData, durationData] = await Promise.all([
      cloudwatch.getMetricStatistics({
        ...common,
        MetricName: 'Invocations',
        Statistics: ['Sum'],
      }).promise(),
      cloudwatch.getMetricStatistics({
        ...common,
        MetricName: 'Errors',
        Statistics: ['Sum'],
      }).promise(),
      cloudwatch.getMetricStatistics({
        ...common,
        MetricName: 'Duration',
        Statistics: ['Maximum'],
      }).promise(),
    ]);
    const invocations = (invocationData.Datapoints || [])
      .reduce((sum, point) => sum + Number(point.Sum || 0), 0);
    const errors = (errorData.Datapoints || [])
      .reduce((sum, point) => sum + Number(point.Sum || 0), 0);
    const maxDurationMs = (durationData.Datapoints || [])
      .reduce((maximum, point) => Math.max(maximum, Number(point.Maximum || 0)), 0);
    const latestAt = [
      ...(invocationData.Datapoints || []),
      ...(errorData.Datapoints || []),
      ...(durationData.Datapoints || []),
    ]
      .filter((point) => point.Timestamp)
      .sort((a, b) => new Date(b.Timestamp) - new Date(a.Timestamp))[0]?.Timestamp || null;
    return {
      functionName,
      invocations,
      errors,
      maxDurationMs,
      timedOut: errors > 0 && maxDurationMs >= 295_000,
      latestAt: latestAt ? new Date(latestAt).toISOString() : null,
      windowMinutes,
    };
  } catch (error) {
    return { functionName, error: error.message, windowMinutes };
  }
}

function getHostCapacity({
  targetPath = REPO_ROOT,
  statfs = fs.statfsSync,
} = {}) {
  try {
    const stats = statfs(targetPath);
    const blockSize = Number(stats.bsize || stats.frsize || 0);
    const blocks = Number(stats.blocks || 0);
    const availableBlocks = Number(stats.bavail ?? stats.bfree ?? 0);
    if (!(blockSize > 0) || !(blocks > 0) || availableBlocks < 0) {
      throw new Error('Filesystem statistics were incomplete.');
    }
    const totalBytes = blockSize * blocks;
    const freeBytes = blockSize * availableBlocks;
    return {
      available: true,
      targetPath,
      totalBytes,
      freeBytes,
      totalGiB: totalBytes / GIB,
      freeGiB: freeBytes / GIB,
      usedPercent: Math.max(0, Math.min(100, (1 - (freeBytes / totalBytes)) * 100)),
      observedAt: new Date().toISOString(),
    };
  } catch (error) {
    return {
      available: false,
      targetPath,
      error: error.message || String(error),
      observedAt: new Date().toISOString(),
    };
  }
}

function configuredControllerStateFile(env = process.env) {
  if (Object.prototype.hasOwnProperty.call(env, 'READINESS_CONTROLLER_STATE_FILE')) {
    return String(env.READINESS_CONTROLLER_STATE_FILE || '').trim()
      || DEFAULT_CONTROLLER_STATE_FILE;
  }
  return String(env.HERMES_CONTROLLER_STATE_FILE || '').trim()
    || DEFAULT_CONTROLLER_STATE_FILE;
}

function getControllerState({
  stateFile = configuredControllerStateFile(),
  readFile = (file) => fs.readFileSync(file, 'utf8'),
} = {}) {
  try {
    const parsed = JSON.parse(readFile(stateFile));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Controller state was not an object.');
    }
    return {
      available: true,
      stateFile,
      ...parsed,
      incidents: Array.isArray(parsed.incidents) ? parsed.incidents : [],
      actions: Array.isArray(parsed.actions) ? parsed.actions : [],
      circuits: Array.isArray(parsed.circuits)
        ? parsed.circuits
        : (parsed.circuits && typeof parsed.circuits === 'object'
          ? Object.values(parsed.circuits)
          : []),
    };
  } catch (error) {
    return {
      available: false,
      stateFile,
      incidents: [],
      actions: [],
      circuits: [],
      error: error.code === 'ENOENT'
        ? 'Controller state has not been written yet.'
        : (error.message || String(error)),
      errorCode: error.code === 'ENOENT'
        ? 'HERMES_CONTROLLER_STATE_MISSING'
        : 'HERMES_CONTROLLER_STATE_INVALID',
    };
  }
}

function buildHostChecks({ capacity, controller, now, legacyReadOnly = false }) {
  const controllerId = legacyReadOnly ? 'readiness.controller' : 'hermes.controller';
  const controllerLabel = legacyReadOnly
    ? 'Dashboard readiness controller'
    : 'Hermes reliability controller';
  let capacityCheck;
  if (!capacity?.available) {
    capacityCheck = makeCheck({
      id: 'host.capacity',
      label: 'Host disk capacity',
      status: 'fail',
      blocking: false,
      owner: 'local-operations',
      errorCode: 'HOST_CAPACITY_UNAVAILABLE',
      summary: 'Host disk capacity could not be measured.',
      detail: capacity?.error || null,
      observedAt: capacity?.observedAt || now,
      now,
      impact: 'ENOSPC risk cannot be evaluated for dashboard state, logs, and checkpoints.',
      recovery: {
        kind: 'manual',
        label: 'Inspect host storage manually. Do not delete non-dashboard files without operator approval.',
      },
    });
  } else {
    const freeGiB = Number(capacity.freeGiB || 0);
    const usedPercent = Number(capacity.usedPercent || 0);
    const status = freeGiB < 15 || usedPercent >= 98
      ? 'fail'
      : (freeGiB < 25 || usedPercent >= 90 ? 'warn' : 'pass');
    capacityCheck = makeCheck({
      id: 'host.capacity',
      label: 'Host disk capacity',
      status,
      blocking: false,
      owner: 'local-operations',
      errorCode: status === 'pass' ? null : (status === 'fail'
        ? 'HOST_DISK_CAPACITY_CRITICAL'
        : 'HOST_DISK_CAPACITY_LOW'),
      summary: `${freeGiB.toFixed(1)} GiB free; ${usedPercent.toFixed(1)}% used.`,
      detail: status === 'pass'
        ? 'Free capacity meets the 25 GiB operating target.'
        : 'Only declared dashboard-owned logs may be pruned automatically.',
      observedAt: capacity.observedAt || now,
      now,
      impact: status === 'pass'
        ? null
        : 'Low capacity can prevent atomic state writes, builds, checkpoints, and service recovery.',
      recovery: status === 'pass' ? null : {
        kind: 'manual',
        label: 'Attribute disk usage and restore at least 25 GiB free. Approval is required for non-dashboard deletion.',
      },
      provenance: {
        source: 'fs.statfs',
        targetPath: capacity.targetPath,
        freeBytes: capacity.freeBytes,
        totalBytes: capacity.totalBytes,
      },
    });
  }

  if (!controller?.available) {
    return [
      capacityCheck,
      makeCheck({
        id: controllerId,
        label: controllerLabel,
        status: 'warn',
        blocking: false,
        owner: 'automation-operations',
        errorCode: controller?.errorCode || 'HERMES_CONTROLLER_STATE_MISSING',
        summary: 'The supervised local readiness controller has not published valid state.',
        detail: controller?.error || null,
        observedAt: now,
        now,
        impact: 'Readiness remains visible, but eligible low-risk repairs are not being coordinated.',
        recovery: {
          kind: 'manual',
          label: 'Start the repository-owned supervisor with the controller in shadow mode.',
        },
      }),
    ];
  }

  const controllerObservedAt = controller.observedAt
    || controller.updatedAt
    || controller.lastPollAt
    || null;
  const controllerAgeSeconds = ageSeconds(controllerObservedAt, now);
  const openCircuits = controller.circuits.filter((circuit) => (
    !circuit?.closedAt
    && (!circuit?.until || new Date(circuit.until) > now)
  ));
  const stale = controllerAgeSeconds == null || controllerAgeSeconds > 180;
  const controllerStatus = String(controller.status || '').toLowerCase();
  const degraded = ['degraded', 'error', 'failed'].includes(controllerStatus);
  const circuitOpen = controllerStatus === 'circuit_open' || openCircuits.length > 0;
  const status = stale || degraded
    ? 'fail'
    : (circuitOpen ? 'warn' : 'pass');
  const controllerError = controller.lastError && typeof controller.lastError === 'object'
    ? controller.lastError
    : null;
  return [
    capacityCheck,
    makeCheck({
      id: controllerId,
      label: controllerLabel,
      status,
      blocking: false,
      owner: 'automation-operations',
      errorCode: status === 'pass'
        ? null
        : (stale
          ? 'HERMES_CONTROLLER_STALE'
          : (degraded
            ? controllerError?.errorCode || controller.errorCode || 'HERMES_CONTROLLER_DEGRADED'
            : 'HERMES_CONTROLLER_CIRCUIT_OPEN')),
      summary: stale
        ? 'Controller state is stale or missing an observation timestamp.'
        : (degraded
          ? `The controller cannot complete its readiness loop (${controllerStatus}).`
          : `${String(controller.mode || 'shadow')} mode is active${openCircuits.length ? ` with ${openCircuits.length} open circuit(s)` : ''}.`),
      detail: (controller.inFlightAction || controller.inFlight)
        ? `Action in flight: ${(controller.inFlightAction || controller.inFlight).actionId || (controller.inFlightAction || controller.inFlight).id || 'unknown'}.`
        : (controllerError?.detail || controller.error || null),
      observedAt: controllerObservedAt,
      nextDueAt: controller.nextRetryAt || null,
      nextRetryAt: controller.nextRetryAt || null,
      now,
      impact: status === 'pass'
        ? null
        : 'Automated low-risk repair may be delayed or circuit-broken.',
      recovery: status === 'pass' ? null : {
        kind: 'manual',
        label: 'Inspect controller incident history and leave approval-only actions for the operator.',
      },
      provenance: {
        source: 'controller-state-file',
        stateFile: controller.stateFile,
        mode: controller.mode || null,
      },
    }),
  ];
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
  // A child with no recorded PID has no command to read; do not ask `ps` about "null".
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return '';
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
        enabled: typeof child?.enabled === 'boolean' ? child.enabled : null,
        intentionallyDisabled: child?.intentionallyDisabled === true,
        discoveryVerified: child?.discoveryVerified === true,
        unexpectedPids: Array.isArray(child?.unexpectedPids)
          ? child.unexpectedPids.map(value => Number(value)).filter(Number.isInteger)
          : [],
        status: child?.status || null,
        running: processIsAlive(childPid),
        commandMatches: name === 'bridge' ? childCommand.includes(expectedBridge) : null,
        lastHeartbeatAt: child?.lastHeartbeatAt || null,
        lastSuccessAt: child?.lastSuccessAt || null,
        lastResultStatus: child?.lastResultStatus || null,
        lastErrorCode: child?.lastErrorCode || null,
        restarts: Number(child?.restarts) || 0,
        sidecarProcessPids: Array.isArray(child?.sidecarProcessPids)
          ? child.sidecarProcessPids.map(value => Number(value)).filter(Number.isInteger)
          : [],
        managedSidecarProcessPids: Array.isArray(child?.managedSidecarProcessPids)
          ? child.managedSidecarProcessPids.map(value => Number(value)).filter(Number.isInteger)
          : [],
        sidecarProcessCount: Number.isFinite(Number(child?.sidecarProcessCount))
          ? Number(child.sidecarProcessCount)
          : null,
        managedSidecarProcessCount: Number.isFinite(Number(child?.managedSidecarProcessCount))
          ? Number(child.managedSidecarProcessCount)
          : null,
        duplicatePids: Array.isArray(child?.duplicatePids)
          ? child.duplicatePids.map(value => Number(value)).filter(Number.isInteger)
          : [],
        duplicateCount: Number.isFinite(Number(child?.duplicateCount))
          ? Number(child.duplicateCount)
          : null,
        sidecarRuntimeVerified: typeof child?.sidecarRuntimeVerified === 'boolean'
          ? child.sidecarRuntimeVerified
          : null,
        sidecarProcessCleanup: child?.sidecarProcessCleanup || null,
      }];
    }));
    return {
      stateFile,
      stateFound: true,
      instanceId: state?.startedAt || null,
      bridgeEnabled: typeof state?.bridgeEnabled === 'boolean'
        ? state.bridgeEnabled
        : (typeof state?.children?.bridge?.enabled === 'boolean'
          ? state.children.bridge.enabled
          : (Object.prototype.hasOwnProperty.call(state?.children || {}, 'bridge')
            ? true
            : hermesBridgeEnabled())),
      pid: Number.isInteger(pid) ? pid : null,
      running: processIsAlive(pid),
      rootMatches,
      commandMatches,
      sourceFingerprint: bootFingerprint,
      currentSourceFingerprint: currentFingerprint,
      sourceMatches,
      childPids: Object.fromEntries(Object.entries(children).map(([name, child]) => [name, child.pid])),
      children,
      analystContract: {
        verified: state?.analystContract?.verified === true,
        checkedAt: state?.analystContract?.checkedAt || null,
        error: state?.analystContract?.error
          ? String(state.analystContract.error).slice(0, 500)
          : null,
      },
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
  const bridgeEnabled = typeof supervisor?.bridgeEnabled === 'boolean'
    ? supervisor.bridgeEnabled
    : (typeof bridge?.enabled === 'boolean' ? bridge.enabled : hermesBridgeEnabled());
  if (!bridgeEnabled) {
    if (bridge?.running === true) {
      return makeCheck({
        id: 'dashboard.hermes-bridge',
        label: 'Hermes snapshot bridge',
        status: 'fail',
        summary: 'A bridge process is still running while both outbound partitions are disabled.',
        errorCode: 'HERMES_BRIDGE_DISABLED_PROCESS_PRESENT',
        detail: bridge.pid ? `Unexpected bridge PID ${bridge.pid}.` : null,
        observedAt: now,
        now,
        impact: 'Outbound telemetry writes may continue until the unexpected bridge process is stopped.',
        recovery: {
          kind: 'command',
          label: 'Restart the repo-owned supervisor to enforce disabled bridge mode.',
          command: 'npm run dev:restart -- --detach',
        },
        provenance: {
          mode: 'disabled',
          enabled: false,
          intentionallyDisabled: true,
          ...bridge,
        },
      });
    }
    const disabledStateVerified = supervisor?.stateFound === true
      && supervisor?.running === true
      && bridge?.intentionallyDisabled === true
      && bridge?.discoveryVerified === true
      && bridge?.status === 'disabled'
      && !bridge?.lastErrorCode;
    if (!disabledStateVerified) {
      return makeCheck({
        id: 'dashboard.hermes-bridge',
        label: 'Hermes snapshot bridge',
        status: 'fail',
        summary: 'Disabled bridge mode could not verify that every outbound writer is stopped.',
        errorCode: bridge?.lastErrorCode || 'HERMES_BRIDGE_DISABLED_STATE_UNVERIFIED',
        detail: bridge?.unexpectedPids?.length > 0
          ? `Unexpected exact bridge PIDs: ${bridge.unexpectedPids.join(', ')}.`
          : null,
        observedAt: now,
        now,
        impact: 'Outbound telemetry publishing cannot be confirmed idle.',
        recovery: {
          kind: 'command',
          label: 'Restart the repo-owned supervisor to verify disabled bridge mode.',
          command: 'npm run dev:restart -- --detach',
        },
        provenance: {
          mode: 'disabled',
          enabled: false,
          intentionallyDisabled: true,
          ...bridge,
        },
      });
    }
    return makeCheck({
      id: 'dashboard.hermes-bridge',
      label: 'Hermes snapshot bridge',
      status: 'pass',
      summary: 'Outbound operations and portfolio publishing are intentionally disabled; the bridge is idle.',
      detail: 'Both bridge partition controls are false, so no local snapshot is written to AWS.',
      observedAt: supervisor?.instanceId || null,
      now,
      provenance: {
        mode: 'disabled',
        enabled: false,
        intentionallyDisabled: true,
      },
    });
  }
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

// Compact 24-hour Eastern label, such as `Jul 24 16:30`.
const easternClock = (value) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(value)).map(({ type, value: part }) => [type, part]));
  return `${parts.month} ${parts.day} ${parts.hour}:${parts.minute}`;
};

// Today's "Since previous close" compares against a verified holdings capture
// taken after the preceding session's close. A missing capture leaves every
// Previous cell empty, so it is a Systems signal (never an Inbox alert).
function buildPortfolioCloseCheck({ result, now }) {
  const baseline = result?.status === 'fulfilled' ? result.value : null;
  const ready = baseline?.status === 'ready';
  const date = baseline?.sessionDate || 'the previous session';
  return makeCheck({
    id: 'analyst.portfolio-close',
    label: 'Portfolio close baseline',
    status: ready ? 'pass' : 'warn',
    blocking: false,
    errorCode: ready ? null : 'PORTFOLIO_CLOSE_BASELINE_MISSING',
    summary: ready
      ? `Verified holdings captured after the ${date} close (${easternClock(baseline.capturedAt)} ET).`
      : baseline
        ? `No verified holdings capture after the ${date} close; Since previous close is unavailable.`
        : 'The previous-close capture status could not be read.',
    detail: ready ? null : (baseline?.reason || (result?.reason?.message ?? null)),
    observedAt: ready ? baseline.capturedAt : now,
    now,
    impact: ready ? null : 'Portfolio Review cannot show previous-close exposure or interest.',
    recovery: ready ? null : {
      kind: 'manual',
      label: 'Keep the Hermes "Portfolio close capture (4:30pm ET)" job enabled and IB Gateway connected at 4:30 PM ET.',
    },
  });
}

function buildAnalystRuntimeCheck({ supervisor, now }) {
  const sidecar = supervisor?.children?.analystSidecar || null;
  const gateway = supervisor?.children?.analystHermes || null;
  const contract = supervisor?.analystContract || null;
  const supervisorVerified = supervisor?.stateFound === true
    && supervisor?.running === true
    && supervisor?.rootMatches === true
    && supervisor?.commandMatches === true
    && supervisor?.sourceMatches === true;
  const childReady = (child) => (
    child?.running === true
    && ['ready', 'healthy'].includes(String(child?.status || '').toLowerCase())
  );
  const sidecarReady = childReady(sidecar);
  const gatewayReady = childReady(gateway);
  const contractVerified = contract?.verified === true;
  const ready = supervisorVerified && sidecarReady && gatewayReady && contractVerified;

  let errorCode = null;
  let summary = 'The Analyst gateway, research sidecar, and JSON-RPC contract are verified.';
  let detail = `Sidecar PID ${sidecar?.pid || 'unknown'}; gateway PID ${gateway?.pid || 'unknown'}.`;
  if (!ready) {
    if (gatewayReady && sidecarReady && !contractVerified) {
      errorCode = 'ANALYST_CONTRACT_UNVERIFIED';
      summary = 'The Analyst processes are running, but the Hermes JSON-RPC contract is unverified.';
      detail = contract?.error || 'The deep create/resume/list/stream/interrupt contract check has not passed.';
    } else {
      errorCode = 'ANALYST_RUNTIME_UNAVAILABLE';
      summary = 'The Analyst runtime is unavailable or has unverified process provenance.';
      detail = [
        supervisorVerified ? null : 'The repository-owned supervisor is unverified.',
        sidecarReady ? null : 'The research sidecar is not ready.',
        gatewayReady ? null : 'The Analyst Hermes gateway is not ready.',
        contractVerified ? null : contract?.error,
      ].filter(Boolean).join(' ') || null;
    }
  }

  return makeCheck({
    id: 'analyst.runtime',
    label: 'The Analyst runtime',
    status: ready ? 'pass' : 'fail',
    blocking: false,
    owner: 'automation-operations',
    errorCode,
    summary,
    detail,
    observedAt: contract?.checkedAt || now,
    now,
    impact: ready ? null : 'On-demand Analyst chats and cited research requests may be unavailable.',
    recovery: ready ? null : {
      kind: 'command',
      label: 'Restart the repo-owned stack and repeat the Analyst contract check.',
      command: 'npm run dev:restart -- --detach',
    },
    provenance: {
      source: 'dashboard-supervisor',
      contractVerified,
      contractCheckedAt: contract?.checkedAt || null,
      sidecar: {
        pid: sidecar?.pid || null,
        running: sidecar?.running === true,
        status: sidecar?.status || null,
      },
      gateway: {
        pid: gateway?.pid || null,
        running: gateway?.running === true,
        status: gateway?.status || null,
      },
    },
  });
}

function analystActivityCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function countedNoun(count, singular) {
  return `${count} ${singular}${count === 1 ? '' : 's'}`;
}

// A live dispatch guard, not a health check: it passes while no Analyst work
// is in progress, warns while work is in progress, and fails when the counts
// cannot be read. It is never part of the cached readiness report.
function buildAnalystActivityCheck({ activity = null, error = null, now }) {
  const counts = {
    reviews: analystActivityCount(activity?.reviews),
    turns: analystActivityCount(activity?.turns),
  };
  const verified = !error && Object.values(counts).every((count) => count !== null);
  const active = verified && Object.values(counts).some((count) => count > 0);
  return makeCheck({
    id: 'analyst.activity',
    label: 'Analyst work in progress',
    status: verified ? (active ? 'warn' : 'pass') : 'fail',
    blocking: false,
    owner: 'research-operations',
    errorCode: verified ? (active ? 'ANALYST_WORK_ACTIVE' : null) : 'ANALYST_ACTIVITY_UNVERIFIED',
    summary: !verified
      ? 'Analyst activity could not be read.'
      : (active
        ? `Analyst work is in progress: ${[
          countedNoun(counts.reviews, 'review run'),
          countedNoun(counts.turns, 'turn'),
        ].join(', ')}.`
        : 'No Analyst work is in progress.'),
    detail: verified
      ? `Counts work updated within the last ${ANALYST_ACTIVITY_WINDOW_SECONDS / 60} minutes.`
      : String(error?.message || 'The Analyst sidecar returned invalid activity counts.').slice(0, 500),
    observedAt: now,
    now,
    impact: active ? 'Automatic stack restarts wait until this work settles.' : null,
    provenance: {
      source: 'analyst-sidecar',
      windowSeconds: ANALYST_ACTIVITY_WINDOW_SECONDS,
      ...counts,
    },
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

function buildSidecarChecks({
  livezResult,
  readyzResult,
  statusResult,
  portfolioResult,
  supervisor,
  expectedAccounts = [],
  now,
}) {
  const livez = fulfilledValue(livezResult);
  const readyz = fulfilledValue(readyzResult);
  const gateway = fulfilledValue(statusResult);
  const portfolio = fulfilledValue(portfolioResult);
  const portfolioErrorCode = portfolio?.error_code
    || portfolio?.errorCode
    || portfolioResult?.reason?.sidecarCode
    || null;
  const gatewayErrorCode = gateway?.error_code
    || gateway?.errorCode
    || readyzResult?.reason?.sidecarCode
    || null;
  const sidecarState = supervisor?.children?.sidecar || null;
  const duplicatePids = Array.isArray(sidecarState?.duplicatePids)
    ? sidecarState.duplicatePids
    : [];
  const duplicateCount = Number(sidecarState?.duplicateCount);
  const processCleanupFailed = sidecarState?.sidecarProcessCleanup?.verified === false;
  const sidecarDuplicateFailure = processCleanupFailed
    || (Number.isFinite(duplicateCount) && duplicateCount > 0);
  const restartSidecar = {
    kind: 'command',
    label: 'Restart only the repo-owned IBKR sidecar.',
    command: 'npm run dev:sidecar:restart',
  };

  const sidecar = sidecarDuplicateFailure
    ? serviceFailureCheck({
        id: 'ibkr.sidecar',
        label: 'IBKR sidecar',
        message: processCleanupFailed
          ? `The supervisor could not verify IBKR sidecar process cleanup${sidecarState?.sidecarProcessCleanup?.detail ? `: ${sidecarState.sidecarProcessCleanup.detail}` : '.'}`
          : `Duplicate repo-owned IBKR sidecar process(es) remain connected to Gateway: ${duplicatePids.join(', ') || 'unknown PID(s)'}.`,
        errorCode: processCleanupFailed
          ? (sidecarState?.sidecarProcessCleanup?.errorCode || 'IBKR_SIDECAR_PROCESS_DISCOVERY_FAILED')
          : 'IBKR_SIDECAR_DUPLICATES',
        impact: 'The sidecar is not singleton-safe; duplicate Gateway sessions can cause connection errors and live data is not considered ready.',
        recovery: restartSidecar,
        provenance: {
          sidecarProcessPids: sidecarState?.sidecarProcessPids || [],
          managedSidecarProcessPids: sidecarState?.managedSidecarProcessPids || [],
          duplicatePids,
          duplicateCount: Number.isFinite(duplicateCount) ? duplicateCount : null,
          sidecarProcessCleanup: sidecarState?.sidecarProcessCleanup || null,
        },
        now,
      })
    : livez
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
        impact: 'Portfolio and IBKR quotes are unavailable.',
        recovery: restartSidecar,
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
  // A failed position delivery cannot disprove the independently verified
  // socket heartbeat. Keep the book unavailable without restarting that
  // healthy process; typed broker failures still retain their own recovery.
  const portfolioDeliveryFailed = livez?.ok === true && connected && !portfolio
    && !portfolioErrorCode && portfolioResult?.status === 'rejected';
  const portfolioDeliveryCode = portfolioResult?.reason?.reason === 'sidecar_timeout'
    ? 'IBKR_PORTFOLIO_DELIVERY_TIMEOUT' : 'IBKR_PORTFOLIO_DELIVERY_UNAVAILABLE';
  const gatewayApiUnresponsive = gatewayErrorCode === 'IBKR_GATEWAY_API_UNRESPONSIVE';
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
          ? (gatewayApiUnresponsive
            ? `Sidecar is alive, but Gateway did not complete a verified API heartbeat${gateway?.message ? `: ${gateway.message}` : '.'}`
            : `Sidecar is alive, but Gateway is not authenticated${errorMessage(readyzResult) ? `: ${errorMessage(readyzResult)}` : '.'}`)
          : 'Gateway cannot be checked until the sidecar is running.',
        errorCode: livez
          ? (gatewayErrorCode || 'IBKR_GATEWAY_NOT_AUTHENTICATED')
          : 'IBKR_GATEWAY_UNAVAILABLE',
        impact: 'No live brokerage data or trading capability is available.',
        recovery: gatewayApiUnresponsive
          ? restartSidecar
          : {
            kind: 'manual',
            label: 'Open IB Gateway, sign in, confirm API socket access on port 4001, then refresh.',
          },
      });

  const accounts = gateway?.accounts || readyz?.accounts || [];
  const normalizedExpectedAccounts = [...new Set((expectedAccounts || [])
    .map((account) => String(account || '').trim())
    .filter(Boolean))];
  const missingExpectedAccounts = normalizedExpectedAccounts
    .filter((account) => !accounts.includes(account));
  const accountsCheck = connected && (accounts.length > 0 || normalizedExpectedAccounts.length > 0)
    ? makeCheck({
        id: 'ibkr.accounts',
        label: 'Managed IBKR accounts',
        status: missingExpectedAccounts.length ? 'warn' : 'pass',
        blocking: false,
        errorCode: missingExpectedAccounts.length ? 'IBKR_PARTIAL_ACCOUNT_COVERAGE' : null,
        accountCoverageStatus: missingExpectedAccounts.length ? 'partial_account_coverage' : 'complete',
        summary: missingExpectedAccounts.length
          ? `Gateway has partial account coverage (${accounts.length} of ${normalizedExpectedAccounts.length} expected).`
          : `${accounts.length} managed account(s) are available.`,
        detail: missingExpectedAccounts.length
          ? `Connected: ${accounts.join(', ') || 'none'}. Missing live: ${missingExpectedAccounts.join(', ')}.`
          : accounts.join(', '),
        observedAt: gateway.time || now,
        impact: missingExpectedAccounts.length
          ? 'Disconnected accounts remain history-only until they reconnect.'
          : null,
        recovery: missingExpectedAccounts.length ? {
          kind: 'manual',
          label: 'Sign in to IB Gateway with the linked username that exposes every expected account, then reconnect.',
        } : null,
        provenance: {
          expectedAccountIds: normalizedExpectedAccounts,
          connectedAccountIds: accounts,
          missingLiveAccountIds: missingExpectedAccounts,
        },
        now,
      })
    : serviceFailureCheck({
        id: 'ibkr.accounts',
        label: 'Managed IBKR accounts',
        message: connected ? 'Gateway connected without returning a managed account.' : 'Accounts are unavailable while Gateway is disconnected.',
        errorCode: 'IBKR_ACCOUNTS_UNAVAILABLE',
        accountCoverageStatus: 'unavailable',
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
  const positionsObservedAt = portfolio?.positions_observed_at || null;
  const liveSessionVerified = portfolio?.ok === true
    && portfolio?.connected === true
    && portfolio?.status === 'live'
    && portfolio?.source === 'ibkr_live_session';
  const acceptedPositionSources = new Set([
    'ibkr_req_positions',
    // Fresh account-update portfolio rows when Gateway Read-Only API mode
    // accepts the socket but never completes reqPositions/positionsEnd.
    'ibkr_req_account_updates',
  ]);
  const positionProvenanceVerified = portfolio?.from_cache === false
    && acceptedPositionSources.has(portfolio?.position_source)
    && positionsObservedAt === observedAt;
  const managedAccountsVerified = liveAccounts.length > 0
    && (accounts.length === 0 || accounts.every((account) => liveAccounts.includes(account)));
  const socketFresh = isFreshTimestamp(observedAt, now, 5 * 60)
    && isFreshTimestamp(socketVerifiedAt, now, 5 * 60)
    && isFreshTimestamp(positionsObservedAt, now, 5 * 60);
  const portfolioLive = connected
    && liveSessionVerified
    && positionProvenanceVerified
    && managedAccountsVerified
    && socketFresh;
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
          positionsObservedAt,
          positionSource: portfolio.position_source,
          fromCache: portfolio.from_cache,
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
              : (!positionProvenanceVerified
                ? 'The position rows were not returned by a fresh IBKR positions or account-updates response.'
                : (!managedAccountsVerified
                  ? 'The verified live session did not cover every managed account.'
                  : 'The live-session socket or position observation is stale or future-dated.')))),
        errorCode: !connected
          ? 'IBKR_PORTFOLIO_UNAVAILABLE'
          : (!portfolio
            ? (portfolioErrorCode || (portfolioDeliveryFailed ? portfolioDeliveryCode : 'IBKR_LIVE_SESSION_UNAVAILABLE'))
            : (!liveSessionVerified
              ? 'IBKR_LIVE_SESSION_UNVERIFIED'
              : (!positionProvenanceVerified
                ? 'IBKR_LIVE_POSITION_PROVENANCE_UNVERIFIED'
                : (!managedAccountsVerified
                  ? 'IBKR_LIVE_ACCOUNTS_UNVERIFIED'
                  : 'IBKR_LIVE_SESSION_STALE')))),
        observedAt,
        lastSuccessAt: liveSessionVerified ? observedAt : null,
        impact: 'Portfolio values must not be trusted or used for decisions.',
        recovery: portfolioDeliveryFailed ? {
          kind: 'manual',
          label: 'Retry live portfolio verification and inspect local request delivery if the failure persists.',
        } : restartSidecar,
        provenance: portfolio ? {
          source: portfolio.source || null,
          status: portfolio.status || null,
          errorCode: portfolioErrorCode,
          accountCount: liveAccounts.length,
          positionCount: positions.length,
          socketVerifiedAt,
          positionsObservedAt,
          positionSource: portfolio.position_source || null,
          fromCache: portfolio.from_cache ?? null,
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
  const rtaCacheStatus = String(rta?._readinessCache?.status || '').toLowerCase();
  const etfCacheStatus = String(etf?._readinessCache?.status || '').toLowerCase();
  const rtaCacheStale = rtaCacheStatus === 'stale';
  const etfCacheStale = etfCacheStatus === 'stale';
  const optimisticCacheStatuses = new Set(['checkpoint', 'revalidating']);
  const rtaAuthoritativeStatus = String(
    rta?.dataAvailability?.authoritativeRevalidationStatus
      || rta?.authoritativeRevalidationStatus
      || '',
  ).toLowerCase();
  const etfAuthoritativeStatus = String(
    etf?.dataAvailability?.authoritativeRevalidationStatus
      || etf?.meta?.authoritativeRevalidationStatus
      || etf?.authoritativeRevalidationStatus
      || '',
  ).toLowerCase();
  const rtaAuthoritativeFailed = rtaAuthoritativeStatus === 'failed';
  const etfAuthoritativeFailed = etfAuthoritativeStatus === 'failed';
  const rtaAuthoritativePending = optimisticCacheStatuses.has(rtaCacheStatus)
    || rtaAuthoritativeStatus === 'pending';
  const etfAuthoritativePending = optimisticCacheStatuses.has(etfCacheStatus)
    || etfAuthoritativeStatus === 'pending';
  const rtaAuthoritativeUnverified = rtaAuthoritativePending || rtaAuthoritativeFailed;
  const etfAuthoritativeUnverified = etfAuthoritativePending || etfAuthoritativeFailed;
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
    && !rtaAuthoritativeUnverified
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
        : rtaAuthoritativeFailed
          ? 'RTA_AUTHORITATIVE_REVALIDATION_FAILED'
        : rtaAuthoritativePending
          ? 'RTA_AUTHORITATIVE_REVALIDATION_PENDING'
        : rtaStructuralErrorCode || 'RTA_PROJECTION_UNAVAILABLE',
      dependsOn: rtaStructuralErrorCode || rtaCacheStale || gmailPassed ? [] : ['gmail.ingestion'],
      message: rta
        ? (rtaCacheStale
          ? 'RTA refresh failed; only a stale cached response is available.'
          : rtaAuthoritativeFailed
            ? 'RTA authoritative revalidation failed; the current manual checkpoint is not an authoritative readiness result.'
          : rtaAuthoritativePending
            ? 'RTA authoritative revalidation is still pending.'
          : `RTA positions are unavailable${rtaWarnings.length ? `: ${rtaWarnings.join(' ')}` : '.'}`)
        : `RTA check failed${errorMessage(rtaResult) ? `: ${errorMessage(rtaResult)}` : '.'}`,
      detail: rta?.dataAvailability?.authoritativeRevalidationReason
        || rta?.dataAvailability?.reason
        || null,
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
  const etfStructurallyAvailable = !etfCacheStale
    && !etfAuthoritativeUnverified
    && Boolean(etfBook);
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
        : etfAuthoritativeFailed
          ? 'ETF_PRO_AUTHORITATIVE_REVALIDATION_FAILED'
        : etfAuthoritativePending
          ? 'ETF_PRO_AUTHORITATIVE_REVALIDATION_PENDING'
        : etf?.dataAvailability?.errorCode || etf?.meta?.errorCode || 'ETF_PRO_BOOK_UNAVAILABLE',
      dependsOn: etf?.meta?.blockedByIngestion && !gmailPassed ? ['gmail.ingestion'] : [],
      message: !etf
        ? `ETF Pro check failed${errorMessage(etfResult) ? `: ${errorMessage(etfResult)}` : '.'}`
        : (etfCacheStale
          ? 'ETF Pro refresh failed; only a stale cached response is available.'
          : etfAuthoritativeFailed
            ? 'ETF Pro authoritative revalidation failed; the current manual checkpoint is not an authoritative readiness result.'
          : etfAuthoritativePending
            ? 'ETF Pro authoritative revalidation is still pending.'
          : `ETF Pro has no structurally valid active or last-known-good book${snapshotDate ? ` for ${snapshotDate}` : ''}.`),
      detail: etf?.dataAvailability?.authoritativeRevalidationReason
        || etf?.meta?.authoritativeRevalidationReason
        || etf?.dataAvailability?.reason
        || etf?.meta?.reason
        || etf?.meta?.headline
        || null,
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
  readHostCapacity = getHostCapacity,
  readControllerState = getControllerState,
  readAnalystActivity = null,
  readPortfolioCloseBaseline = null,
  expectedIbkrAccounts = [],
  now: nowProvider = () => new Date(),
  cacheNow = () => Date.now(),
  legacyMode = process.env.LEGACY_HERMES_MODE,
}) {
  const legacyReadOnly = legacyHermesIsReadOnly(normalizeLegacyHermesMode(legacyMode));
  let cached = null;
  let inFlight = null;
  const configuredCacheMs = Number(process.env.SYSTEM_READINESS_CACHE_MS);
  const cacheMs = Math.max(
    MIN_SYSTEM_READINESS_CACHE_MS,
    Number.isFinite(configuredCacheMs)
      ? configuredCacheMs
      : DEFAULT_SYSTEM_READINESS_CACHE_MS,
  );

  async function collectUncached() {
    const now = nowProvider();
    const supervisor = readSupervisorProvenance();
    const runtime = readRuntimeProvenance();
    const launchAgent = readLaunchAgentProvenance();
    let hostCapacity;
    try {
      hostCapacity = readHostCapacity();
    } catch (error) {
      hostCapacity = {
        available: false,
        error: error.message || String(error),
        observedAt: now.toISOString(),
      };
    }
    let controllerState;
    try {
      controllerState = readControllerState();
    } catch (error) {
      controllerState = {
        available: false,
        incidents: [],
        actions: [],
        circuits: [],
        error: error.message || String(error),
        errorCode: 'HERMES_CONTROLLER_STATE_INVALID',
      };
    }
    const [uiResult, livezResult, readyzResult, statusResult, workflowResult, rtaResult, etfResult] = await Promise.allSettled([
      probeLocalUrl('http://127.0.0.1:3000/', { timeoutMs: 2_000 }),
      sidecarRequest('/livez', { timeoutMs: 1500 }),
      sidecarRequest('/readyz', { timeoutMs: 2500 }),
      sidecarRequest('/status', { timeoutMs: 3000 }),
      buildWorkflowStatusSnapshot(),
      buildRtaResponse(),
      buildEtfResponse(),
    ]);

    const portfolioResult = await Promise.allSettled([
      sidecarRequest('/portfolio/live-positions', { timeoutMs: 45_000 }),
    ]).then(([result]) => result);
    const portfolioCloseResult = typeof readPortfolioCloseBaseline === 'function'
      ? await Promise.allSettled([readPortfolioCloseBaseline()]).then(([result]) => result)
      : null;

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
    if (!legacyReadOnly) {
      try {
        director = await getDirectorSnapshot({ dynamodb, workflowSnapshot: workflow });
      } catch (error) {
        director = { workers: [], recentRuns: [], error: error.message };
      }
    }

    let inbox = workflow.hermesInbox || null;
    if (!inbox) {
      try {
        inbox = await getHermesInboxStatus();
      } catch (error) {
        inbox = { error: error.message };
      }
    }

    const workerDefinitions = legacyReadOnly ? [] : listWorkerDefinitions();
    const gmailAccount = inbox?.gmailAccount
      || process.env.HERMES_GMAIL_ACCOUNT
      || 'timsmithaviation@gmail.com';
    const gmailFunction = process.env.HERMES_GMAIL_INGESTOR_FUNCTION
      || SERVICE_DEFINITIONS.get('gmail.ingestion')?.aws?.functionName
      || 'market-dashboard-gmail-ingestor-v2';
    const workerSignals = legacyReadOnly
      ? []
      : await collectHermesWorkerSignals({
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
    const gmailMetrics = await readLambdaActivity(
      cloudwatch,
      gmailFunction,
      now,
      GMAIL_READINESS_MAX_AGE_MINUTES,
    );
    const researchPipelineCoverage = await researchPipelineCoveragePromise;
    // External readiness probes can take long enough for their observations to
    // be newer than the collection start time. Evaluate freshness against the
    // time all evidence is in hand so a genuinely current live observation is
    // not rejected as future-dated.
    const evaluationNow = nowProvider();
    const workerSignalByKey = new Map(workerSignals.map((signal) => [signal.definition.key, signal]));
    const recentRuns = Array.isArray(director.recentRuns) ? director.recentRuns : [];
    const workerChecks = workerDefinitions.map((definition) => {
      const due = isHermesDueNow(evaluationNow, definition.key);
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
        now: evaluationNow,
        maxAgeMinutes: due
          ? DEFAULT_WORKER_THRESHOLDS_MINUTES[definition.key]
          : 7 * 24 * 60,
        invocation: signal.invocation,
        due,
      });
    });
    if (!legacyReadOnly && director.error && workerChecks.length === 0) {
      workerChecks.push(serviceFailureCheck({
        id: 'hermes.status',
        label: 'Hermes worker status',
        message: `Hermes status could not be loaded: ${director.error}`,
        impact: 'Agent activity cannot be verified.',
        recovery: { kind: 'manual', label: 'Verify DynamoDB access and the Hermes worker schedules.' },
      }));
    }

    const rawGmailCheck = gmailHeartbeatStore?.available !== true
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
      : evaluateGmailIngestion({
          account: gmailAccount,
          metrics: gmailMetrics,
          heartbeat: gmailHeartbeatStore?.heartbeat || null,
          inbox,
          now: evaluationNow,
          maxAgeMinutes: GMAIL_READINESS_MAX_AGE_MINUTES,
        });
    const gmailCheck = {
      ...rawGmailCheck,
      capabilityIds: [legacyReadOnly ? 'automation.readiness' : 'automation.hermes'],
    };

    const apiCheck = makeCheck({
      id: 'dashboard.api',
      label: 'Dashboard API server',
      status: 'pass',
      blocking: true,
      summary: `Express API is responding (PID ${process.pid}, uptime ${Math.floor(process.uptime())}s).`,
      observedAt: evaluationNow,
      now: evaluationNow,
      provenance: runtime,
    });
    const dashboardChecks = buildDashboardChecks({
      uiResult,
      supervisor,
      runtime,
      launchAgent,
      now: evaluationNow,
    });
    const bridgeCheck = legacyReadOnly
      ? null
      : buildHermesBridgeCheck({ supervisor, now: evaluationNow });
    const analystRuntimeCheck = buildAnalystRuntimeCheck({ supervisor, now: evaluationNow });
    const portfolioCloseCheck = portfolioCloseResult
      ? buildPortfolioCloseCheck({ result: portfolioCloseResult, now: evaluationNow })
      : null;
    const sidecarChecks = buildSidecarChecks({
      livezResult,
      readyzResult,
      statusResult,
      portfolioResult,
      supervisor,
      expectedAccounts: expectedIbkrAccounts,
      now: evaluationNow,
    });
    const researchChecks = buildResearchChecks({
      rtaResult,
      etfResult,
      workflow,
      gmailCheck,
      researchPipelineCoverage,
      now: evaluationNow,
    });
    const hostChecks = buildHostChecks({
      capacity: hostCapacity,
      controller: controllerState,
      now: evaluationNow,
      legacyReadOnly,
    });

    const report = buildSystemReadiness([
      {
        id: 'dashboard',
        label: 'Dashboard',
        checks: [dashboardChecks[0], apiCheck, ...dashboardChecks.slice(1)],
      },
      { id: 'brokerage', label: 'IBKR and live portfolio', checks: sidecarChecks },
      {
        id: 'automation',
        label: legacyReadOnly ? 'Gmail and readiness automation' : 'Hermes and Gmail automation',
        checks: legacyReadOnly ? [gmailCheck] : [bridgeCheck, ...workerChecks, gmailCheck],
      },
      { id: 'analyst', label: 'The Analyst', checks: [analystRuntimeCheck, ...(portfolioCloseCheck ? [portfolioCloseCheck] : [])] },
      { id: 'research', label: 'Research data', checks: researchChecks },
      { id: 'host', label: 'Host and reliability controller', checks: hostChecks },
    ], { now: evaluationNow });
    return {
      ...report,
      researchProductMatrix: researchPipelineCoverage,
      controller: {
        available: controllerState.available === true,
        buildFingerprint: controllerState.buildFingerprint || null,
        mode: controllerState.mode || null,
        enabledActionIds: Array.isArray(controllerState.enabledActionIds)
          ? controllerState.enabledActionIds
          : [],
        status: controllerState.status || null,
        shadowSoakStartedAt: controllerState.shadowSoakStartedAt || null,
        observedAt: controllerState.observedAt
          || controllerState.updatedAt
          || controllerState.lastPollAt
          || null,
        inFlightAction: controllerState.inFlightAction || controllerState.inFlight || null,
        nextRetryAt: controllerState.nextRetryAt || null,
        circuits: controllerState.circuits || [],
      },
      incidentHistory: (controllerState.incidents || []).slice(-50),
      actionHistory: (controllerState.actions || []).slice(-50),
      suppressionReasons: [
        ...(report.suppressedSymptoms || []),
        ...(Array.isArray(controllerState.suppressions) ? controllerState.suppressions : []),
      ].slice(-100),
    };
  }

  async function runCollection() {
    if (inFlight) return inFlight;
    inFlight = collectUncached()
      .then((value) => {
        cached = { value, error: null, savedAt: cacheNow() };
        return value;
      })
      .catch((error) => {
        // Failed probes consume the same budget as successful probes. Retaining
        // the failure prevents a broken dependency from creating a request
        // storm while still failing closed for every caller.
        cached = { value: null, error, savedAt: cacheNow() };
        throw error;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  async function collect() {
    // Public callers, including `?refresh=1`, share this hard minimum interval.
    // A UI request must never turn the expensive AWS/database probes into an
    // unbounded request-driven workload.
    const cacheAgeMs = cached ? cacheNow() - cached.savedAt : Number.POSITIVE_INFINITY;
    if (cached && cacheAgeMs < cacheMs) {
      if (cached.error) throw cached.error;
      return cached.value;
    }
    if (
      cached?.value
      && !cached.error
      && cacheAgeMs < cacheMs + SYSTEM_READINESS_REVALIDATE_GRACE_MS
    ) {
      const stillValidValue = cached.value;
      void runCollection().catch(() => {});
      return stillValidValue;
    }
    return runCollection();
  }

  async function collectForVerification() {
    // This method is wired only to the allowlisted, rate-limited repair service.
    // It intentionally bypasses a fresh cache so post-repair eligibility checks
    // are based on a new authoritative observation.
    return runCollection();
  }

  // Live checks are read on demand for one controller dispatch decision. They
  // bypass the cached report, so a request never starts the full collection.
  async function collectLiveCheck(checkId) {
    if (checkId !== 'analyst.activity') return null;
    try {
      if (typeof readAnalystActivity !== 'function') {
        throw new Error('The Analyst activity reader is not configured.');
      }
      const activity = await readAnalystActivity({
        windowSeconds: ANALYST_ACTIVITY_WINDOW_SECONDS,
      });
      return buildAnalystActivityCheck({ activity, now: nowProvider() });
    } catch (error) {
      return buildAnalystActivityCheck({ error, now: nowProvider() });
    }
  }

  return { collect, collectForVerification, collectLiveCheck };
}

module.exports = {
  ANALYST_ACTIVITY_WINDOW_SECONDS,
  DEFAULT_CONTROLLER_STATE_FILE,
  DEFAULT_LAUNCH_AGENT_PATH,
  DEFAULT_SERVICE_HEARTBEAT_TABLE,
  DEFAULT_SYSTEM_READINESS_CACHE_MS,
  DEFAULT_WORKER_THRESHOLDS_MINUTES,
  MIN_SYSTEM_READINESS_CACHE_MS,
  SYSTEM_READINESS_REVALIDATE_GRACE_MS,
  businessDaysSince,
  buildAnalystActivityCheck,
  buildAnalystRuntimeCheck,
  buildDashboardChecks,
  buildHermesBridgeCheck,
  collectHermesWorkerSignals,
  configuredControllerStateFile,
  getLambdaActivity,
  getHostCapacity,
  getControllerState,
  getLaunchAgentProvenance,
  getServiceHeartbeat,
  getRuntimeProvenance,
  getSupervisorProvenance,
  isHermesDueNow,
  probeUrl,
  serviceHeartbeatErrorCode,
  buildSidecarChecks,
  buildHostChecks,
  buildResearchPipelineCheck,
  buildResearchChecks,
  createSystemReadinessService,
};
