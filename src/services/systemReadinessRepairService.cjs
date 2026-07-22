const path = require('path');
const { spawn } = require('child_process');
const SERVICE_MANIFEST = require('../../ops/services.json');

const REPO_ROOT = path.resolve(__dirname, '../..');
const DEFAULT_COOLDOWN_MS = 10_000;

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

function createSystemReadinessRepairService({
  manifest = SERVICE_MANIFEST,
  repoRoot = REPO_ROOT,
  spawnProcess = spawn,
  lambdaClient = null,
  reconcilePredictionCatalog = null,
  now = () => Date.now(),
  cooldownMs = DEFAULT_COOLDOWN_MS,
} = {}) {
  const configured = new Map((manifest?.repairActions || []).map((action) => [action.id, action]));
  const lastAcceptedAt = new Map();
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
      kind: 'process',
      file: process.execPath,
      args: [
        path.join(repoRoot, 'scripts/rebuild_rta_materializations.js'),
        '--apply',
        '--window-days=90',
        '--json',
      ],
    }],
    ['prediction-catalog-reconcile', {
      kind: 'handler',
      run: reconcilePredictionCatalog || (async () => {
        const { reconcileCurrentCpiCatalog } = require('./predictionMarketsIngest/reconciliationService');
        return reconcileCurrentCpiCatalog({ trigger: 'manual' });
      }),
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
    const previousAt = lastAcceptedAt.get(action.id);
    if (Number.isFinite(previousAt) && acceptedAtMs - previousAt < cooldownMs) {
      throw repairError(
        'That repair action was just requested. Wait for the current recovery attempt to finish.',
        429,
        'READINESS_REPAIR_COOLDOWN',
      );
    }

    lastAcceptedAt.set(action.id, acceptedAtMs);
    try {
      if (executor.kind === 'lambda') {
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
      } else if (executor.kind === 'handler') {
        const result = await executor.run();
        const outcome = result?.outcome || result;
        if (outcome?.status !== 'succeeded') {
          throw repairError(
            outcome?.message || 'Current CPI catalog reconciliation did not succeed.',
            503,
            outcome?.code || 'PREDICTION_CATALOG_RECONCILE_FAILED',
          );
        }
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
  createSystemReadinessRepairService,
  isLoopbackAddress,
};
