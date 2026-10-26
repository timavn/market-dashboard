const path = require('path');
const { spawn } = require('child_process');
const SERVICE_MANIFEST = require('../../ops/services.json');

const REPO_ROOT = path.resolve(__dirname, '../..');
const DEFAULT_COOLDOWN_MS = 10_000;
const DEFAULT_PROCESS_TIMEOUT_MS = 5 * 60 * 1_000;
const DEFAULT_PROCESS_TERMINATION_GRACE_MS = 2_000;
const MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024;
const API_AWS_PROFILE = 'market-dashboard-local';
const EXPECTED_AWS_REGION = 'us-west-1';
const RESEARCH_REBUILD_ENVIRONMENT = Object.freeze({
  HERMES_LEDGER_TABLE: 'HermesEmailIngestLedger',
  RESEARCH_EVENT_LEDGER_TABLE: 'ResearchEventLedgerV2',
  HEDGEYE_SNAPSHOT_TABLE: 'HedgeyeDailySnapshot',
  HEDGEYE_BUCKET: 'market-dashboard-csv-data',
});

function isLoopbackAddress(address) {
  const normalized = String(address || '').trim().toLowerCase();
  if (normalized === '::1' || normalized === 'localhost') return true;
  const ipv4 = normalized.startsWith('::ffff:') ? normalized.slice(7) : normalized;
  return /^127(?:\.\d{1,3}){3}$/.test(ipv4);
}

function repairError(message, statusCode, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function researchRebuildEnvironment(inheritedEnvironment = process.env) {
  const environment = { ...inheritedEnvironment };
  for (const key of [
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'AWS_SECURITY_TOKEN',
    'AWS_ROLE_ARN',
    'AWS_ROLE_SESSION_NAME',
    'AWS_WEB_IDENTITY_TOKEN_FILE',
    'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
    'AWS_CONTAINER_CREDENTIALS_FULL_URI',
    'AWS_CONTAINER_AUTHORIZATION_TOKEN',
    'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
    'AWS_SHARED_CREDENTIALS_FILE',
    'AWS_CONFIG_FILE',
  ]) {
    delete environment[key];
  }
  return {
    ...environment,
    ...RESEARCH_REBUILD_ENVIRONMENT,
    AWS_PROFILE: API_AWS_PROFILE,
    AWS_DEFAULT_PROFILE: API_AWS_PROFILE,
    AWS_REGION: EXPECTED_AWS_REGION,
    AWS_DEFAULT_REGION: EXPECTED_AWS_REGION,
    AWS_SDK_LOAD_CONFIG: '1',
    AWS_EC2_METADATA_DISABLED: 'true',
    MARKET_DASHBOARD_AWS_PROFILE_LOCKED: 'true',
  };
}

function validateResearchRebuildReport(report) {
  const rejected = report?.rejected;
  const canonicalCoverageGaps = report?.canonicalCoverageGaps;
  const canonicalEventCount = report?.v2EventCount;
  const legacyMigrationEventCount = report?.legacyMigrationEventCount ?? 0;
  const materializedEventCount = report?.materializedEventCount;
  const currentBoard = report?.currentBoard;
  const longCount = currentBoard?.longCount;
  const shortCount = currentBoard?.shortCount;
  const holdings = currentBoard?.holdings;
  const summaryDates = report?.summary?.dates;
  const summaryWritten = report?.summary?.written;
  const structurallyValidHoldings = Array.isArray(holdings)
    && holdings.length === longCount + shortCount
    && holdings.every((holding) => (
      holding
      && typeof holding === 'object'
      && typeof holding.ticker === 'string'
      && holding.ticker.length > 0
      && ['long', 'short'].includes(holding.side)
    ))
    && holdings.filter((holding) => holding.side === 'long').length === longCount
    && holdings.filter((holding) => holding.side === 'short').length === shortCount;
  const failure = (
    !report
    || typeof report !== 'object'
    || Array.isArray(report)
    || report.mode !== 'apply'
    || report.eventLedgerError
    || !Number.isInteger(canonicalEventCount)
    || canonicalEventCount <= 0
    || !Number.isInteger(legacyMigrationEventCount)
    || legacyMigrationEventCount < 0
    || !Number.isInteger(materializedEventCount)
    || materializedEventCount < canonicalEventCount
    || !Array.isArray(rejected)
    || rejected.length > 0
    || !Array.isArray(canonicalCoverageGaps)
    || canonicalCoverageGaps.length > 0
    || currentBoard?.available !== true
    || currentBoard?.checkpointValidation?.valid !== true
    || currentBoard?.dataQuality?.status !== 'ok'
    || !Array.isArray(currentBoard?.dataQuality?.invalidEvents)
    || currentBoard.dataQuality.invalidEvents.length > 0
    || !Number.isInteger(longCount)
    || longCount < 0
    || !Number.isInteger(shortCount)
    || shortCount < 0
    || !structurallyValidHoldings
    || !currentBoard?.lastUpdated
    || !Number.isFinite(Date.parse(currentBoard.lastUpdated))
    || !Number.isInteger(summaryDates)
    || summaryDates <= 0
    || !Number.isInteger(summaryWritten)
    || summaryWritten < 0
    || summaryWritten > summaryDates
  );
  if (failure) {
    throw repairError(
      'The canonical 90-day RTA rebuild did not complete with a valid, rejection-free board.',
      503,
      report?.eventLedgerError
        ? 'RTA_CANONICAL_LEDGER_UNAVAILABLE'
        : 'RTA_REBUILD_VERIFICATION_FAILED',
    );
  }
  return {
    status: 'succeeded',
    canonicalEventCount,
    legacyMigrationEventCount,
    materializedEventCount,
    rejectedCount: 0,
    canonicalCoverageGapCount: 0,
    dates: summaryDates,
    written: summaryWritten,
    longCount,
    shortCount,
  };
}

function runVerifiedProcess(
  spawnProcess,
  executor,
  {
    repoRoot,
    inheritedEnvironment,
    timeoutMs = DEFAULT_PROCESS_TIMEOUT_MS,
    terminationGraceMs = DEFAULT_PROCESS_TERMINATION_GRACE_MS,
  },
) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(executor.file, executor.args, {
      cwd: repoRoot,
      detached: false,
      env: researchRebuildEnvironment(inheritedEnvironment),
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer;
    let forceKillTimer;
    let terminationConfirmationTimer;
    let terminationError = null;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceKillTimer);
      clearTimeout(terminationConfirmationTimer);
      callback(value);
    };
    const requestTermination = (error) => {
      if (settled || terminationError) return;
      terminationError = error;
      try { child.kill('SIGTERM'); } catch {}
      if (settled) return;
      forceKillTimer = setTimeout(() => {
        if (settled) return;
        try { child.kill('SIGKILL'); } catch {}
        if (settled) return;
        terminationConfirmationTimer = setTimeout(() => {
          finish(
            reject,
            repairError(
              `${error.message} Child-process termination could not be confirmed.`,
              error.statusCode,
              'RTA_REBUILD_TERMINATION_UNCONFIRMED',
            ),
          );
        }, terminationGraceMs);
        terminationConfirmationTimer.unref?.();
      }, terminationGraceMs);
      forceKillTimer.unref?.();
    };
    const append = (current, chunk) => {
      if (terminationError) return current;
      const next = current + String(chunk || '');
      if (Buffer.byteLength(next, 'utf8') > MAX_PROCESS_OUTPUT_BYTES) {
        requestTermination(
          repairError(
            'The RTA rebuild exceeded the bounded output limit.',
            503,
            'RTA_REBUILD_OUTPUT_LIMIT_EXCEEDED',
          ),
        );
        return current;
      }
      return next;
    };
    child.stdout?.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr?.on('data', (chunk) => { stderr = append(stderr, chunk); });
    child.once('error', (error) => finish(reject, terminationError || error));
    child.once('close', (code, signal) => {
      if (settled) return;
      if (terminationError) {
        finish(reject, terminationError);
        return;
      }
      if (code !== 0) {
        finish(
          reject,
          repairError(
            `The RTA rebuild exited ${code ?? 'without a code'}${signal ? ` (${signal})` : ''}: ${stderr.trim().slice(-500) || 'no diagnostic'}`,
            503,
            'RTA_REBUILD_PROCESS_FAILED',
          ),
        );
        return;
      }
      let report;
      try {
        report = JSON.parse(stdout);
      } catch {
        finish(
          reject,
          repairError(
            'The RTA rebuild did not return a valid JSON completion report.',
            503,
            'RTA_REBUILD_REPORT_INVALID',
          ),
        );
        return;
      }
      try {
        finish(resolve, validateResearchRebuildReport(report));
      } catch (error) {
        finish(reject, error);
      }
    });
    timer = setTimeout(() => {
      requestTermination(
        repairError(
          'The canonical 90-day RTA rebuild exceeded its five-minute limit.',
          504,
          'RTA_REBUILD_TIMEOUT',
        ),
      );
    }, timeoutMs);
    timer.unref?.();
  });
}

function createSystemReadinessRepairService({
  manifest = SERVICE_MANIFEST,
  repoRoot = REPO_ROOT,
  spawnProcess = spawn,
  lambdaClient = null,
  collectReadiness = null,
  now = () => Date.now(),
  cooldownMs = DEFAULT_COOLDOWN_MS,
  processTimeoutMs = DEFAULT_PROCESS_TIMEOUT_MS,
  processTerminationGraceMs = DEFAULT_PROCESS_TERMINATION_GRACE_MS,
  inheritedEnvironment = process.env,
} = {}) {
  const configured = new Map((manifest?.repairActions || []).map((action) => [action.id, action]));
  const lastAcceptedAt = new Map();
  let inFlightActionId = null;
  const executors = new Map([
    ['dev-stack-start', {
      kind: 'process',
      file: process.execPath,
      args: [path.join(repoRoot, 'scripts/dev-stack/cli.js'), 'start', '--detach'],
    }],
    ['dev-stack-restart', {
      kind: 'process',
      file: process.execPath,
      args: [path.join(repoRoot, 'scripts/dev-stack/delayed_restart.js')],
    }],
    ['dev-stack-sidecar-restart', {
      kind: 'process',
      file: process.execPath,
      args: [path.join(repoRoot, 'scripts/dev-stack/cli.js'), 'restart-sidecar'],
    }],
    ['sidecar-runtime-rebuild', {
      kind: 'process',
      file: process.execPath,
      args: [path.join(repoRoot, 'scripts/dev-stack/delayed_rebuild_sidecar_runtime.js')],
    }],
    ['gmail-poll-retry', {
      kind: 'lambda',
      functionName: process.env.HERMES_GMAIL_INGESTOR_FUNCTION || 'market-dashboard-gmail-ingestor-v2',
      payload: { source: 'readiness-repair', poll: 'incremental' },
    }],
    ['research-projections-rebuild', {
      kind: 'verified-process',
      file: process.execPath,
      args: [
        path.join(repoRoot, 'scripts/rebuild_rta_materializations.js'),
        '--apply',
        '--window-days=90',
        '--json',
      ],
    }],
  ]);

  function listActions() {
    return [...configured.values()]
      .filter((action) => (
        action?.automatic === true
        && action?.loopbackOnly === true
        && executors.has(action.executor)
      ))
      .map((action) => ({
        id: action.id,
        label: action.label,
        description: action.description || null,
        command: action.command || null,
        automatic: true,
        loopbackOnly: true,
      }));
  }

  async function run(actionId, { remoteAddress } = {}) {
    if (!isLoopbackAddress(remoteAddress)) {
      throw repairError(
        'Readiness repair actions are available only from this computer.',
        403,
        'READINESS_REPAIR_LOOPBACK_REQUIRED',
      );
    }

    const action = configured.get(String(actionId || ''));
    const executor = action ? executors.get(action.executor) : null;
    if (!action || action.automatic !== true || action.loopbackOnly !== true || !executor) {
      throw repairError(
        'That readiness repair action is not allowlisted.',
        404,
        'READINESS_REPAIR_NOT_ALLOWLISTED',
      );
    }

    const acceptedAtMs = now();
    if (inFlightActionId) {
      throw repairError(
        inFlightActionId === action.id
          ? 'That repair action is already running. Wait for the current recovery attempt to finish.'
          : `Repair ${inFlightActionId} is already running. Only one readiness repair may run at a time.`,
        429,
        inFlightActionId === action.id
          ? 'READINESS_REPAIR_IN_PROGRESS'
          : 'READINESS_REPAIR_GLOBAL_IN_PROGRESS',
      );
    }
    const previousAt = lastAcceptedAt.get(action.id);
    if (Number.isFinite(previousAt) && acceptedAtMs - previousAt < cooldownMs) {
      throw repairError(
        'That repair action was just requested. Wait for the current recovery attempt to finish.',
        429,
        'READINESS_REPAIR_COOLDOWN',
      );
    }

    lastAcceptedAt.set(action.id, acceptedAtMs);
    inFlightActionId = action.id;
    try {
      if (executor.kind === 'lambda') {
        if (action.id === 'retry-gmail-poll') {
          if (typeof collectReadiness !== 'function') {
            throw repairError(
              'Gmail retry requires a refreshed readiness proof from the canonical scheduled heartbeat.',
              503,
              'GMAIL_RETRY_READINESS_UNAVAILABLE',
            );
          }
          const readiness = await collectReadiness({ refresh: true });
          const gmailCheck = (readiness?.groups || [])
            .flatMap((group) => group?.checks || [])
            .find((check) => check?.id === 'gmail.ingestion');
          const retryableCodes = new Set([
            'GMAIL_PROVIDER_UNAVAILABLE',
            'GMAIL_RATE_LIMITED',
            'GMAIL_TRANSIENT_ERROR',
          ]);
          const provenance = gmailCheck?.provenance || {};
          const authenticSchedule = provenance.heartbeatSource === 'aws-lambda'
            && provenance.triggerSource === 'aws-scheduler'
            && Boolean(provenance.scheduleId);
          if (
            !gmailCheck
            || !retryableCodes.has(gmailCheck.errorCode)
            || gmailCheck.recovery?.automatic !== true
            || !authenticSchedule
          ) {
            throw repairError(
              'Gmail retry is allowed only for an explicitly transient failure from the authentic scheduled poller.',
              409,
              'GMAIL_RETRY_NOT_ELIGIBLE',
            );
          }
        }
        if (!lambdaClient || typeof lambdaClient.invoke !== 'function') {
          throw repairError(
            'The configured Lambda repair executor is unavailable.',
            503,
            'READINESS_REPAIR_EXECUTOR_UNAVAILABLE',
          );
        }
        await lambdaClient.invoke({
          FunctionName: executor.functionName,
          InvocationType: 'Event',
          Payload: JSON.stringify(executor.payload),
        }).promise();
      } else if (executor.kind === 'verified-process') {
        const execution = await runVerifiedProcess(spawnProcess, executor, {
          repoRoot,
          inheritedEnvironment,
          timeoutMs: processTimeoutMs,
          terminationGraceMs: processTerminationGraceMs,
        });
        return {
          accepted: true,
          completed: true,
          action: {
            id: action.id,
            label: action.label,
            automatic: true,
          },
          acceptedAt: new Date(acceptedAtMs).toISOString(),
          message: 'The canonical 90-day RTA rebuild completed successfully.',
          execution,
        };
      } else {
        const child = spawnProcess(executor.file, executor.args, {
          cwd: repoRoot,
          detached: true,
          env: process.env,
          shell: false,
          stdio: 'ignore',
        });
        await new Promise((resolve, reject) => {
          child.once('spawn', resolve);
          child.once('error', reject);
        });
        child.unref();
      }
    } catch (error) {
      if (lastAcceptedAt.get(action.id) === acceptedAtMs) lastAcceptedAt.delete(action.id);
      throw error;
    } finally {
      if (inFlightActionId === action.id) inFlightActionId = null;
    }

    return {
      accepted: true,
      action: {
        id: action.id,
        label: action.label,
        automatic: true,
      },
      acceptedAt: new Date(acceptedAtMs).toISOString(),
      message: 'The safe local recovery was started. Refresh readiness after the services settle.',
    };
  }

  return { listActions, run };
}

module.exports = {
  DEFAULT_COOLDOWN_MS,
  DEFAULT_PROCESS_TERMINATION_GRACE_MS,
  DEFAULT_PROCESS_TIMEOUT_MS,
  createSystemReadinessRepairService,
  isLoopbackAddress,
  researchRebuildEnvironment,
  runVerifiedProcess,
  validateResearchRebuildReport,
};
