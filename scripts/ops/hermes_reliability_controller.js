#!/usr/bin/env node
'use strict';

/*
 * Deterministic local readiness controller.
 *
 * This process has no listener. It reads the loopback readiness API and may
 * invoke only fixed repair actions declared in ops/services.json. Shadow mode
 * is the default; active mode must be selected explicitly.
 */
const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SERVICE_MANIFEST = require('../../ops/services.json');

const REPO_ROOT = path.resolve(__dirname, '../..');
const APP_SUPPORT_DIR = path.join(
  os.homedir(),
  'Library/Application Support/market-dashboard',
);
const DEFAULT_STATE_FILE = path.join(APP_SUPPORT_DIR, 'readiness-controller.json');
const DEFAULT_LOG_DIR = path.join(os.homedir(), 'Library/Logs/market-dashboard');
const DEFAULT_BASE_URL = 'http://127.0.0.1:3001';
const DEFAULT_POLL_INTERVAL_MS = 60_000;
const DEFAULT_MIN_OBSERVATION_SEPARATION_MS = 60_000;
// The authoritative collector is hard-capped at a five-minute cadence and a
// cold pass may take about 90 seconds. Keep its completed result actionable
// through the next refresh window while remaining inside the ten-minute cloud
// detection objective.
const DEFAULT_TELEMETRY_MAX_AGE_MS = 8 * 60_000;
// A cold authoritative readiness pass can legitimately take about 90 seconds
// while the bounded research checks refill. Keep the client inside the
// telemetry-freshness window so that pass is shared instead of abandoned and
// retried by the next controller poll.
const DEFAULT_READINESS_TIMEOUT_MS = 120_000;
// The longest synchronous repair executor is bounded to five minutes and
// confirms child termination before returning. The client timeout must remain
// longer so it cannot abandon the server while that global action is running.
const DEFAULT_REQUEST_TIMEOUT_MS = 330_000;
// A live deferral check is one bounded loopback read made immediately before
// a dispatch decision; it never waits on the cached readiness collection.
const DEFAULT_LIVE_CHECK_TIMEOUT_MS = 15_000;
const MAX_DEFERRAL_CHECK_AGE_MS = 60_000;
const MAX_UNVERIFIED_DEFERRAL_MS = 30 * 60_000;
// A deferred action is re-evaluated on every poll. A deferral not re-evaluated
// within this gap ended (the action stopped being eligible); a new one starts.
// The gap grows with a slower configured poll so a hold cannot restart forever.
const DEFERRAL_EPISODE_GAP_MS = 5 * 60_000;
const deferralEpisodeGapMs = (pollIntervalMs) => Math.max(
  DEFERRAL_EPISODE_GAP_MS,
  2 * pollIntervalMs + DEFAULT_READINESS_TIMEOUT_MS + DEFAULT_LIVE_CHECK_TIMEOUT_MS,
);
const MAX_STATE_ACTIONS = 200;
const MAX_RESOLVED_INCIDENTS = 100;
const CONTROLLER_SERVICE_ID = 'dashboard-readiness-controller';
const CONTROLLER_STATE_VERSION = 1;
const ACTIVE_MODE = 'active';
const SHADOW_MODE = 'shadow';
const GATEWAY_API_UNRESPONSIVE = 'IBKR_GATEWAY_API_UNRESPONSIVE';
// One slow heartbeat reads as an unresponsive Gateway, and a readiness report
// may be served from cache for five minutes. The instruction to relaunch the
// Gateway waits until the failure has outlasted both.
const GATEWAY_UNRESPONSIVE_ESCALATION_DELAY_MS = 10 * 60_000;
const CONTROLLER_BUILD_FINGERPRINT = crypto
  .createHash('sha256')
  .update(fs.readFileSync(__filename))
  .update(JSON.stringify(SERVICE_MANIFEST.repairActions || []))
  .digest('hex');
const ALLOWED_SCOPES = new Set([
  'repo-processes',
  'sidecar-runtime',
  'gmail-incremental-poll',
  'research-projections',
  'dashboard-logs',
]);
const ACTION_EXECUTORS = Object.freeze({
  'start-local-stack': {
    manifestExecutor: 'dev-stack-start',
    controllerExecutor: 'loopback-readiness-api',
  },
  'restart-local-stack': {
    manifestExecutor: 'dev-stack-restart',
    controllerExecutor: 'loopback-readiness-api',
  },
  'restart-ibkr-sidecar': {
    manifestExecutor: 'dev-stack-sidecar-restart',
    controllerExecutor: 'loopback-readiness-api',
  },
  'rebuild-sidecar-runtime': {
    manifestExecutor: 'sidecar-runtime-rebuild',
    controllerExecutor: 'loopback-readiness-api',
  },
  'retry-gmail-poll': {
    manifestExecutor: 'gmail-poll-retry',
    controllerExecutor: 'loopback-readiness-api',
  },
  'rebuild-research-projections': {
    manifestExecutor: 'research-projections-rebuild',
    controllerExecutor: 'loopback-readiness-api',
  },
  'prune-dashboard-logs': {
    manifestExecutor: 'dashboard-log-prune',
    controllerExecutor: 'dashboard-log-prune',
  },
});
const OWNED_LOG_NAMES = Object.freeze([
  'api.log',
  'bridge.log',
  'controller.log',
  'sidecar.log',
  'supervisor.log',
  'ui.log',
]);

function normalizeMode(value) {
  return String(value || '').trim().toLowerCase() === ACTIVE_MODE
    ? ACTIVE_MODE
    : SHADOW_MODE;
}

function normalizeEnabledActionIds(value, policies = compilePolicies()) {
  const requested = Array.isArray(value)
    ? value
    : String(value || '').split(',');
  const enabled = [...new Set(
    requested.map((item) => String(item || '').trim()).filter(Boolean),
  )].sort();
  const known = new Set(policies.map((policy) => policy.id));
  const unknown = enabled.filter((actionId) => !known.has(actionId));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown Hermes controller action ID${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}`,
    );
  }
  return enabled;
}

function iso(value) {
  return new Date(value).toISOString();
}

function timestamp(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function boundedText(value, length = 500) {
  return String(value || '').slice(0, length);
}

function compatibilityEnvValue(env, primaryName, legacyName) {
  if (Object.prototype.hasOwnProperty.call(env, primaryName)) return env[primaryName];
  return env[legacyName];
}

function controllerStateFile(env = process.env) {
  const configured = String(
    compatibilityEnvValue(
      env,
      'READINESS_CONTROLLER_STATE_FILE',
      'HERMES_CONTROLLER_STATE_FILE',
    ) || '',
  ).trim();
  return configured ? path.resolve(configured) : DEFAULT_STATE_FILE;
}

function writeStateAtomically(targetPath, value, {
  fileSystem = fs,
  processId = process.pid,
  random = Math.random,
} = {}) {
  const parent = path.dirname(targetPath);
  const suffix = `${processId}-${Math.floor(random() * 1_000_000_000)}`;
  const temporaryPath = `${targetPath}.tmp-${suffix}`;
  let descriptor = null;
  try {
    fileSystem.mkdirSync(parent, { recursive: true });
    descriptor = fileSystem.openSync(
      temporaryPath,
      fileSystem.constants.O_CREAT
        | fileSystem.constants.O_EXCL
        | fileSystem.constants.O_WRONLY,
      0o600,
    );
    fileSystem.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fileSystem.fsyncSync(descriptor);
    fileSystem.closeSync(descriptor);
    descriptor = null;
    fileSystem.renameSync(temporaryPath, targetPath);
    fileSystem.chmodSync(targetPath, 0o600);
    try {
      const parentDescriptor = fileSystem.openSync(parent, fileSystem.constants.O_RDONLY);
      try {
        fileSystem.fsyncSync(parentDescriptor);
      } finally {
        fileSystem.closeSync(parentDescriptor);
      }
    } catch {
      // Some filesystems do not support fsync on directories.
    }
    return { ok: true, path: targetPath };
  } catch (error) {
    if (descriptor !== null) {
      try { fileSystem.closeSync(descriptor); } catch {}
    }
    try { fileSystem.unlinkSync(temporaryPath); } catch {}
    return {
      ok: false,
      path: targetPath,
      errorCode: error?.code || 'CONTROLLER_STATE_WRITE_FAILED',
      error,
    };
  }
}

function readState(targetPath, { fileSystem = fs } = {}) {
  try {
    const parsed = JSON.parse(fileSystem.readFileSync(targetPath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function newState({
  mode = SHADOW_MODE,
  now = Date.now(),
  enabledActionIds = [],
} = {}) {
  return {
    version: CONTROLLER_STATE_VERSION,
    serviceId: CONTROLLER_SERVICE_ID,
    mode: normalizeMode(mode),
    enabledActionIds: [...enabledActionIds],
    status: normalizeMode(mode) === ACTIVE_MODE ? 'monitoring' : 'shadow',
    buildFingerprint: CONTROLLER_BUILD_FINGERPRINT,
    observedAt: iso(now),
    startedAt: iso(now),
    shadowSoakStartedAt: normalizeMode(mode) === SHADOW_MODE ? iso(now) : null,
    lastReadinessAt: null,
    lastSuccessfulPollAt: null,
    lastError: null,
    incidents: [],
    actions: [],
    circuits: [],
    suppressions: [],
    nextRetryAt: null,
    inFlight: null,
    persistenceBlocked: false,
  };
}

function restoreState(raw, {
  mode = SHADOW_MODE,
  now = Date.now(),
  enabledActionIds = [],
} = {}) {
  const fresh = newState({ mode, now, enabledActionIds });
  if (!raw || raw.version !== CONTROLLER_STATE_VERSION) return fresh;
  const sameBuild = raw.buildFingerprint === CONTROLLER_BUILD_FINGERPRINT;
  const normalizedMode = normalizeMode(mode);
  const restored = {
    ...fresh,
    ...raw,
    serviceId: CONTROLLER_SERVICE_ID,
    mode: normalizedMode,
    enabledActionIds: [...enabledActionIds],
    status: normalizedMode === ACTIVE_MODE ? 'monitoring' : 'shadow',
    buildFingerprint: CONTROLLER_BUILD_FINGERPRINT,
    observedAt: iso(now),
    shadowSoakStartedAt: normalizedMode === SHADOW_MODE
      ? (
        sameBuild
        && raw.mode === SHADOW_MODE
        && timestamp(raw.shadowSoakStartedAt) !== null
          ? raw.shadowSoakStartedAt
          : iso(now)
      )
      : null,
    incidents: Array.isArray(raw.incidents) ? raw.incidents : [],
    actions: Array.isArray(raw.actions) ? raw.actions : [],
    circuits: Array.isArray(raw.circuits) ? raw.circuits : [],
    suppressions: Array.isArray(raw.suppressions) ? raw.suppressions : [],
    inFlight: null,
    persistenceBlocked: raw.persistenceBlocked === true,
  };
  if (raw.inFlight?.actionRecordId) {
    const startedAt = timestamp(raw.inFlight.startedAt) ?? now;
    const releaseAfter = Math.max(
      startedAt
        + Math.max(0, Number(raw.inFlight.settleTimeoutMs) || 0)
        + Math.max(0, Number(raw.inFlight.cooldownMs) || 0),
      timestamp(raw.inFlight.releaseAfter) ?? 0,
    );
    restored.inFlight = {
      ...raw.inFlight,
      recoveryHold: true,
      releaseAfter: iso(releaseAfter),
      postRestartVerifiedAt: null,
      phase: 'controller-restart-recovery',
    };
    const record = restored.actions.find((item) => item.id === raw.inFlight.actionRecordId);
    if (record && !record.completedAt) {
      record.outcome = 'uncertain';
      record.errorCode = 'CONTROLLER_RESTARTED_DURING_ACTION';
      record.detail = 'The controller restarted with an action in flight. Global dispatch is held until its full settle and cooldown window expires and fresh readiness is verified.';
    }
    const incident = restored.incidents.find((item) => item.id === raw.inFlight.incidentId);
    if (incident && incident.status !== 'resolved') {
      incident.status = 'verifying';
      incident.verificationOutcome = 'controller-restarted';
      incident.nextRetryAt = iso(releaseAfter);
    }
  }
  return restored;
}

function policyValidationErrors(manifest = SERVICE_MANIFEST) {
  const errors = [];
  for (const action of manifest?.repairActions || []) {
    if (!ACTION_EXECUTORS[action.id]) continue;
    const expected = ACTION_EXECUTORS[action.id];
    if (action.automatic !== true || action.loopbackOnly !== true) {
      errors.push(`${action.id}: action must be automatic and loopback-only`);
    }
    if (action.executor !== expected.manifestExecutor) {
      errors.push(`${action.id}: unexpected manifest executor`);
    }
    if (action.controllerExecutor !== expected.controllerExecutor) {
      errors.push(`${action.id}: unexpected controller executor`);
    }
    if (action.authority !== 'automatic') {
      errors.push(`${action.id}: authority must be automatic`);
    }
    if (!ALLOWED_SCOPES.has(action.scope)) {
      errors.push(`${action.id}: scope is not controller-safe`);
    }
    if (action.riskClass !== 'low') {
      errors.push(`${action.id}: only low-risk policies may be automatic`);
    }
    if (!Array.isArray(action.triggeringErrorCodes)
        || action.triggeringErrorCodes.length === 0
        || action.triggeringErrorCodes.some((code) => !/^[A-Z][A-Z0-9_]+$/.test(code))) {
      errors.push(`${action.id}: triggeringErrorCodes must be a non-empty exact-code list`);
    }
    if (action.triggeringCheckIds != null
        && (!Array.isArray(action.triggeringCheckIds)
          || action.triggeringCheckIds.length === 0
          || action.triggeringCheckIds.some(
            (checkId) => !/^[a-z][a-zA-Z0-9.-]+$/.test(checkId),
          ))) {
      errors.push(`${action.id}: triggeringCheckIds must be a non-empty exact-check list`);
    }
    if (!Array.isArray(action.prerequisites)) {
      errors.push(`${action.id}: prerequisites must be an array`);
    }
    for (const prerequisite of action.prerequisites || []) {
      if (prerequisite.allowedErrorCodes != null
          && (!Array.isArray(prerequisite.allowedErrorCodes)
            || prerequisite.allowedErrorCodes.length === 0
            || prerequisite.allowedErrorCodes.some(
              (code) => code !== null
                && !/^[A-Z][A-Z0-9_]+$/.test(String(code)),
            ))) {
        errors.push(
          `${action.id}: prerequisite allowedErrorCodes must be exact codes or null`,
        );
      }
    }
    if (action.deferrals != null && !Array.isArray(action.deferrals)) {
      errors.push(`${action.id}: deferrals must be an array`);
    }
    for (const deferral of Array.isArray(action.deferrals) ? action.deferrals : []) {
      if (!/^[a-z][a-zA-Z0-9.-]+$/.test(String(deferral?.checkId || ''))) {
        errors.push(`${action.id}: deferral checkId must be an exact check id`);
      }
      const maxAgeMs = Number(deferral?.maxAgeMs);
      if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0 || maxAgeMs > MAX_DEFERRAL_CHECK_AGE_MS) {
        errors.push(`${action.id}: deferral maxAgeMs must be positive and at most ${MAX_DEFERRAL_CHECK_AGE_MS}`);
      }
      const unverifiedMs = Number(deferral?.unverifiedMaxDeferralMs);
      if (!Number.isFinite(unverifiedMs) || unverifiedMs < 0 || unverifiedMs > MAX_UNVERIFIED_DEFERRAL_MS) {
        errors.push(
          `${action.id}: deferral unverifiedMaxDeferralMs must be from 0 to ${MAX_UNVERIFIED_DEFERRAL_MS}`,
        );
      }
      if (deferral?.errorCodes != null && (!Array.isArray(deferral.errorCodes)
          || deferral.errorCodes.length === 0
          || deferral.errorCodes.some((code) => !(action.triggeringErrorCodes || []).includes(code)))) {
        errors.push(`${action.id}: deferral errorCodes must be a non-empty subset of triggeringErrorCodes`);
      }
    }
    if (!Array.isArray(action.verificationChecks)
        || action.verificationChecks.length === 0) {
      errors.push(`${action.id}: verificationChecks must be a non-empty array`);
    }
    for (const field of [
      'settleTimeoutMs',
      'cooldownMs',
      'attemptWindowMs',
      'circuitDurationMs',
    ]) {
      if (!Number.isFinite(Number(action[field])) || Number(action[field]) < 0) {
        errors.push(`${action.id}: ${field} must be a non-negative number`);
      }
    }
    if (Number(action.maxAttempts) !== 2) {
      errors.push(`${action.id}: maxAttempts must be exactly 2`);
    }
    if (!String(action.escalationOwner || '').trim()) {
      errors.push(`${action.id}: escalationOwner is required`);
    }
  }
  for (const actionId of Object.keys(ACTION_EXECUTORS)) {
    if (!(manifest?.repairActions || []).some((action) => action.id === actionId)) {
      errors.push(`${actionId}: allowlisted controller action is missing from the manifest`);
    }
  }
  return errors;
}

function compilePolicies(manifest = SERVICE_MANIFEST) {
  const errors = policyValidationErrors(manifest);
  if (errors.length > 0) {
    throw new Error(`Invalid Hermes controller policies: ${errors.join('; ')}`);
  }
  return (manifest.repairActions || [])
    .filter((action) => ACTION_EXECUTORS[action.id])
    .map((action, order) => ({
      ...action,
      _order: order,
      triggeringErrorCodes: [...new Set(action.triggeringErrorCodes)],
      triggeringCheckIds: [...new Set(action.triggeringCheckIds || [])],
      verificationChecks: [...new Set(action.verificationChecks)],
      prerequisites: action.prerequisites.map((item) => ({ ...item })),
      deferrals: (action.deferrals || []).map((item) => ({ ...item })),
    }));
}

function flattenChecks(report) {
  return (Array.isArray(report?.groups) ? report.groups : [])
    .flatMap((group) => Array.isArray(group?.checks) ? group.checks : []);
}

function reportFreshness(report, {
  now = Date.now(),
  telemetryMaxAgeMs = DEFAULT_TELEMETRY_MAX_AGE_MS,
} = {}) {
  const checkedAt = timestamp(report?.checkedAt);
  if (checkedAt === null) {
    return { fresh: false, reason: 'READINESS_CHECKED_AT_INVALID' };
  }
  const ageMs = now - checkedAt;
  if (ageMs < -30_000 || ageMs > telemetryMaxAgeMs) {
    return {
      fresh: false,
      reason: 'READINESS_TELEMETRY_STALE',
      ageMs,
    };
  }
  if (!Array.isArray(report?.rootCauses) || !Array.isArray(report?.groups)) {
    return { fresh: false, reason: 'READINESS_CONTRACT_INVALID' };
  }
  return { fresh: true, ageMs: Math.max(0, ageMs) };
}

function valueAt(object, dottedPath) {
  return String(dottedPath || '').split('.').reduce(
    (value, key) => (value && typeof value === 'object' ? value[key] : undefined),
    object,
  );
}

function evaluatePrerequisites(policy, checksById, now = Date.now()) {
  for (const prerequisite of policy.prerequisites) {
    const check = checksById.get(prerequisite.checkId);
    if (!check) {
      return {
        ok: false,
        reason: 'PREREQUISITE_CHECK_MISSING',
        detail: prerequisite.checkId,
      };
    }
    const statuses = Array.isArray(prerequisite.statuses)
      ? prerequisite.statuses
      : ['pass'];
    if (!statuses.includes(check.status)) {
      return {
        ok: false,
        reason: 'PREREQUISITE_UNHEALTHY',
        detail: `${prerequisite.checkId}:${check.status}`,
      };
    }
    if (Array.isArray(prerequisite.allowedErrorCodes)) {
      const errorCode = check.errorCode || null;
      if (!prerequisite.allowedErrorCodes.includes(errorCode)) {
        return {
          ok: false,
          reason: 'PREREQUISITE_ERROR_CODE_NOT_ALLOWED',
          detail: `${prerequisite.checkId}:${errorCode || 'none'}`,
        };
      }
    }
    if (prerequisite.maxAgeMs != null) {
      const observedAt = timestamp(check.observedAt);
      const ageMs = observedAt === null ? null : now - observedAt;
      if (ageMs === null || ageMs < -30_000 || ageMs > Number(prerequisite.maxAgeMs)) {
        return {
          ok: false,
          reason: 'PREREQUISITE_TELEMETRY_STALE',
          detail: prerequisite.checkId,
        };
      }
    }
    for (const [field, expected] of Object.entries(prerequisite.provenanceEquals || {})) {
      if (valueAt(check.provenance, field) !== expected) {
        return {
          ok: false,
          reason: 'PREREQUISITE_PROVENANCE_UNVERIFIED',
          detail: `${prerequisite.checkId}:${field}`,
        };
      }
    }
  }
  return { ok: true, reason: null, detail: null };
}

function currentDeferral(incident, now, episodeGapMs = DEFERRAL_EPISODE_GAP_MS) {
  const lastEvaluatedAt = timestamp(incident?.deferral?.lastEvaluatedAt);
  return lastEvaluatedAt !== null && now - lastEvaluatedAt <= episodeGapMs
    ? incident.deferral
    : null;
}

// A deferral protects work only from the causes it names, such as code drift.
// Any other trigger, for example a process the user disabled, is not held.
function applicableDeferrals(policy, incident) {
  return (policy.deferrals || []).filter((deferral) => !deferral.errorCodes
    || deferral.errorCodes.includes(incident?.errorCode));
}

// A deferral check passes while the work it protects is verifiably idle and
// warns while that work is verifiably in progress. A failed, stale, or missing
// check leaves the work unverified: that defers only until
// unverifiedMaxDeferralMs after the deferral began or the work was last seen
// in progress, so an unreadable check cannot hold recovery indefinitely.
function evaluateDeferrals(policy, liveChecksById, incident, now = Date.now(), {
  episodeGapMs = DEFERRAL_EPISODE_GAP_MS,
} = {}) {
  for (const deferral of applicableDeferrals(policy, incident)) {
    const check = liveChecksById.get(deferral.checkId) || null;
    const observedAt = timestamp(check?.observedAt);
    const ageMs = observedAt === null ? null : now - observedAt;
    const fresh = ageMs !== null && ageMs >= -30_000 && ageMs <= Number(deferral.maxAgeMs);
    if (fresh && check.status === 'pass') continue;
    if (fresh && check.status === 'warn') {
      return {
        defer: true,
        reason: 'DEFERRED_FOR_ACTIVE_WORK',
        detail: `${deferral.checkId}: ${boundedText(check.summary || check.errorCode, 200)}`,
        workActive: true,
      };
    }
    const episode = currentDeferral(incident, now, episodeGapMs);
    const startedAt = timestamp(episode?.startedAt) ?? now;
    const heldSince = Math.max(startedAt, timestamp(episode?.lastActiveAt) ?? startedAt);
    if (now - heldSince < Number(deferral.unverifiedMaxDeferralMs)) {
      return {
        defer: true,
        reason: 'DEFERRED_ACTIVITY_UNVERIFIED',
        detail: `${deferral.checkId}: ${check ? (fresh ? check.errorCode || check.status : 'stale') : 'unavailable'}`,
        workActive: false,
      };
    }
  }
  return { defer: false, reason: null, detail: null, workActive: false };
}

// A deferral is quiet: it records no action attempt, opens no circuit, and
// sends no notification. The episode clock survives polls until dispatch.
function deferIncident(incident, deferral, now, episodeGapMs = DEFERRAL_EPISODE_GAP_MS) {
  const observedAt = iso(now);
  const episode = currentDeferral(incident, now, episodeGapMs);
  incident.status = 'deferred';
  incident.suppressionReason = deferral.reason;
  incident.suppressionDetail = deferral.detail;
  incident.nextRetryAt = null;
  incident.deferral = {
    startedAt: episode?.startedAt || observedAt,
    lastActiveAt: deferral.workActive ? observedAt : (episode?.lastActiveAt || null),
    lastEvaluatedAt: observedAt,
  };
}

function verificationCheckIds(incident, policy) {
  return [...new Set([
    incident.checkId,
    ...(policy?.verificationChecks || []),
  ].filter(Boolean))];
}

function verificationPassed(incident, policy, checksById) {
  const checkIds = verificationCheckIds(incident, policy);
  return checkIds.length > 0
    && checkIds.every((checkId) => checksById.get(checkId)?.status === 'pass');
}

function incidentId(cause) {
  const checkId = String(cause?.checkId || 'unknown-check');
  const errorCode = String(cause?.errorCode || cause?.id || 'UNKNOWN_ERROR');
  return `${checkId}:${errorCode}`;
}

function policyForCause(cause, policies) {
  const code = String(cause?.errorCode || '');
  const checkId = String(cause?.checkId || '');
  return policies.find((policy) => (
    policy.triggeringErrorCodes.includes(code)
    && (
      policy.triggeringCheckIds.length === 0
      || policy.triggeringCheckIds.includes(checkId)
    )
  )) || null;
}

function notificationTitle(kind, incident) {
  const noun = incident.label || incident.checkId;
  if (kind === 'opening') return `Market Dashboard: ${noun} incident`;
  if (kind === 'recovery') return `Market Dashboard: ${noun} recovered`;
  if (kind === 'circuit') return `Market Dashboard: ${noun} repair circuit open`;
  return `Market Dashboard: ${noun} needs attention`;
}

function notificationBody(kind, incident) {
  const code = incident.errorCode || 'UNKNOWN_ERROR';
  if (kind === 'recovery') return `${code} cleared after two verified clean observations.`;
  if (kind === 'circuit') {
    if (incident.actionId === 'restart-ibkr-sidecar') {
      return `${code} persisted after two sidecar-only repairs. Relaunch and log in to IB Gateway manually; automatic Gateway quit/login/MFA is disabled.`;
    }
    return `${code} reached the two-attempt limit; automatic repair is paused until ${incident.circuitOpenUntil}.`;
  }
  if (kind === 'escalation') {
    if (code === GATEWAY_API_UNRESPONSIVE) {
      // The Gateway is running but no longer answers any API client, so a new
      // sidecar process meets the same silence. Only a Gateway relaunch helps.
      return `${code}: IB Gateway has not answered for 10 minutes. Quit IB Gateway, open it again and log in. Restarting the dashboard's IBKR service does not fix this.`;
    }
    if (incident.actionId === 'restart-ibkr-sidecar') {
      return `${code}: sidecar-only recovery is unavailable. Relaunch and log in to IB Gateway manually.`;
    }
    return `${code}: ${incident.suppressionReason || 'manual operator action is required'}.`;
  }
  return `${code}: ${incident.summary || 'readiness is degraded'}.`;
}

function localNotificationsEnabled(
  env = process.env,
  platform = process.platform,
) {
  if (platform !== 'darwin') return false;
  return !new Set(['0', 'false', 'no', 'off', 'disabled'])
    .has(String(env.MARKET_DASHBOARD_LOCAL_NOTIFICATIONS || 'true').trim().toLowerCase());
}

function sendMacNotification(event, {
  env = process.env,
  platform = process.platform,
  execute = execFileSync,
} = {}) {
  if (!localNotificationsEnabled(env, platform)) {
    return { delivered: false, reason: 'disabled' };
  }
  try {
    execute(
      '/usr/bin/osascript',
      [
        '-e',
        'on run argv',
        '-e',
        'display notification (item 2 of argv) with title (item 1 of argv)',
        '-e',
        'end run',
        event.title,
        event.body,
      ],
      { stdio: 'ignore', timeout: 5_000 },
    );
    return { delivered: true, reason: null };
  } catch (error) {
    return {
      delivered: false,
      reason: error?.code || boundedText(error?.message || error),
    };
  }
}

// Every other manual incident is escalated when it is first seen. A Gateway
// that has stopped answering is escalated only once it has stayed that way,
// so a blip never asks the user to relaunch a Gateway that is working.
function escalationIsDue(incident, now) {
  if (incident.errorCode !== GATEWAY_API_UNRESPONSIVE) return true;
  const openedAt = timestamp(incident.openedAt);
  return openedAt !== null
    && now - openedAt >= GATEWAY_UNRESPONSIVE_ESCALATION_DELAY_MS;
}

function notifyIncident(incident, kind, observedAt, notifier) {
  incident.notifications = incident.notifications || {};
  if (incident.notifications[kind]) return null;
  const event = {
    kind,
    service: incident.checkId,
    rootCause: incident.errorCode,
    dedupeKey: `${incident.checkId}:${incident.errorCode}:${kind}`,
    title: notificationTitle(kind, incident),
    body: notificationBody(kind, incident),
    observedAt,
  };
  const result = notifier(event);
  incident.notifications[kind] = {
    observedAt,
    delivered: result?.delivered === true,
    error: result?.delivered === true ? null : result?.reason || null,
  };
  return event;
}

function actionAttempts(state, incidentIdValue, policy, now) {
  return state.actions.filter((action) => (
    action.incidentId === incidentIdValue
    && action.actionId === policy.id
    && !['shadowed', 'not_dispatched'].includes(action.outcome)
    && timestamp(action.startedAt) !== null
    && now - timestamp(action.startedAt) < Number(policy.attemptWindowMs)
  ));
}

function latestActionAttempt(state, incidentIdValue, policy) {
  return state.actions.find((action) => (
    action.incidentId === incidentIdValue
    && action.actionId === policy.id
    && !['shadowed', 'not_dispatched'].includes(action.outcome)
  )) || null;
}

function refreshDerivedState(state, now = Date.now()) {
  state.actions = state.actions.slice(0, MAX_STATE_ACTIONS);
  const active = state.incidents.filter((item) => item.status !== 'resolved');
  const resolved = state.incidents
    .filter((item) => item.status === 'resolved')
    .slice(0, MAX_RESOLVED_INCIDENTS);
  state.incidents = [...active, ...resolved];
  state.circuits = state.incidents
    .filter((item) => timestamp(item.circuitOpenUntil) > now)
    .map((item) => ({
      incidentId: item.id,
      checkId: item.checkId,
      errorCode: item.errorCode,
      actionId: item.actionId,
      openedAt: item.circuitOpenedAt,
      until: item.circuitOpenUntil,
      owner: item.owner,
    }));
  const retries = state.incidents
    .filter((item) => item.status !== 'resolved')
    .map((item) => timestamp(item.nextRetryAt))
    .filter((value) => value !== null && value > now)
    .sort((left, right) => left - right);
  state.nextRetryAt = retries.length > 0 ? iso(retries[0]) : null;
  state.observedAt = iso(now);
}

function buildDependentSuppressions(report) {
  const checks = flattenChecks(report);
  const roots = Array.isArray(report?.rootCauses) ? report.rootCauses : [];
  const rootCheckIds = new Set(roots.map((cause) => cause.checkId).filter(Boolean));
  return checks
    .filter((check) => check.status !== 'pass' && !rootCheckIds.has(check.id))
    .map((check) => {
      const parentRoots = roots
        .filter((cause) => (cause.affectedCheckIds || []).includes(check.id))
        .map((cause) => incidentId(cause));
      return {
        checkId: check.id,
        errorCode: check.errorCode || null,
        reason: 'DEPENDENT_SYMPTOM',
        rootCauseIds: parentRoots,
      };
    });
}

function observeReport(state, report, {
  policies,
  now = Date.now(),
  minObservationSeparationMs = DEFAULT_MIN_OBSERVATION_SEPARATION_MS,
  notifier = () => ({ delivered: false, reason: 'test' }),
} = {}) {
  const observedAt = iso(now);
  const checks = flattenChecks(report);
  const checksById = new Map(checks.map((check) => [check.id, check]));
  const causes = Array.isArray(report.rootCauses) ? report.rootCauses : [];
  const activeIds = new Set(causes.map(incidentId));

  state.lastReadinessAt = report.checkedAt;
  state.lastSuccessfulPollAt = observedAt;
  state.lastError = null;
  state.suppressions = buildDependentSuppressions(report);

  for (const cause of causes) {
    const id = incidentId(cause);
    const policy = policyForCause(cause, policies);
    let incident = state.incidents.find((item) => item.id === id);
    const isNew = !incident || incident.status === 'resolved';
    if (isNew) {
      incident = {
        id,
        checkId: cause.checkId || null,
        errorCode: cause.errorCode || cause.id || null,
        label: cause.label || cause.checkId || 'Readiness',
        summary: cause.summary || null,
        owner: cause.owner || policy?.escalationOwner || 'unassigned',
        actionId: policy?.id || null,
        affectedCheckIds: [...new Set(cause.affectedCheckIds || [])],
        capabilityIds: [...new Set(cause.capabilityIds || [])],
        status: 'observing',
        openedAt: observedAt,
        lastSeenAt: observedAt,
        lastMatchingObservationAt: observedAt,
        observationCount: 1,
        cleanObservationCount: 0,
        lastCleanObservedAt: null,
        suppressionReason: null,
        nextRetryAt: null,
        circuitOpenedAt: null,
        circuitOpenUntil: null,
        verificationOutcome: null,
        notifications: {},
      };
      state.incidents = state.incidents.filter((item) => item.id !== id);
      state.incidents.unshift(incident);
      notifyIncident(incident, 'opening', observedAt, notifier);
    } else {
      const lastMatching = timestamp(incident.lastMatchingObservationAt);
      if (lastMatching === null || now - lastMatching >= minObservationSeparationMs) {
        incident.observationCount = Number(incident.observationCount || 0) + 1;
        incident.lastMatchingObservationAt = observedAt;
      }
      incident.lastSeenAt = observedAt;
      incident.summary = cause.summary || incident.summary;
      incident.affectedCheckIds = [...new Set(cause.affectedCheckIds || [])];
      incident.capabilityIds = [...new Set(cause.capabilityIds || [])];
      incident.cleanObservationCount = 0;
      incident.lastCleanObservedAt = null;
      const conflictingInFlightAction = state.inFlight?.incidentId === incident.id
        && state.inFlight?.actionId !== policy?.id;
      if (policy && conflictingInFlightAction) {
        const supersededFlight = state.inFlight;
        const supersededRecord = state.actions.find(
          (item) => item.id === supersededFlight.actionRecordId,
        );
        if (supersededRecord && !supersededRecord.completedAt) {
          supersededRecord.completedAt = observedAt;
          supersededRecord.outcome = 'superseded';
          supersededRecord.verificationOutcome = 'policy-rebound';
          supersededRecord.errorCode = 'CONTROLLER_ACTION_POLICY_REBOUND';
          supersededRecord.detail = (
            `Recovery policy changed from ${supersededFlight.actionId} to ${policy.id}.`
          );
        }
        // A conflicting flight can only survive from persisted controller
        // state: policies are immutable within a running controller process.
        // Retire that stale global hold so the incident can adopt the current
        // bounded action instead of dispatching the old recovery again.
        state.inFlight = null;
      }
      if (
        policy
        && (
          !incident.actionId
          || incident.actionId !== policy.id
          || incident.suppressionReason === 'NO_AUTOMATIC_POLICY'
        )
      ) {
        const actionChanged = Boolean(
          incident.actionId && incident.actionId !== policy.id,
        );
        incident.actionId = policy.id;
        if (incident.status === 'manual' || actionChanged) {
          incident.status = 'open';
          incident.suppressionReason = null;
          incident.suppressionDetail = null;
          incident.nextRetryAt = null;
          incident.circuitOpenedAt = null;
          incident.circuitOpenUntil = null;
          incident.verificationOutcome = actionChanged ? 'policy-rebound' : null;
        }
      }
      if (incident.status === 'verifying') {
        incident.verificationOutcome = 'failed';
        incident.status = 'open';
      }
    }
    if (!policy) {
      incident.status = 'manual';
      incident.suppressionReason = 'NO_AUTOMATIC_POLICY';
      if (escalationIsDue(incident, now)) {
        notifyIncident(incident, 'escalation', observedAt, notifier);
      }
    }
  }

  for (const incident of state.incidents) {
    if (incident.status === 'resolved' || activeIds.has(incident.id)) continue;
    const policy = policies.find((item) => item.id === incident.actionId) || null;
    if (!verificationPassed(incident, policy, checksById)) {
      incident.cleanObservationCount = 0;
      incident.lastCleanObservedAt = null;
      continue;
    }
    const previousClean = timestamp(incident.lastCleanObservedAt);
    if (previousClean === null || now - previousClean >= minObservationSeparationMs) {
      incident.cleanObservationCount = Number(incident.cleanObservationCount || 0) + 1;
      incident.lastCleanObservedAt = observedAt;
    }
    incident.status = 'verifying';
    incident.verificationOutcome = `clean-${incident.cleanObservationCount}-of-2`;
    incident.suppressionReason = null;
    if (incident.cleanObservationCount >= 2) {
      incident.status = 'resolved';
      incident.resolvedAt = observedAt;
      incident.verificationOutcome = 'verified-clean';
      incident.nextRetryAt = null;
      incident.circuitOpenUntil = null;
      notifyIncident(incident, 'recovery', observedAt, notifier);
    }
  }

  return { checksById, activeIds };
}

function openCircuit(state, incident, policy, now, notifier) {
  incident.status = 'circuit_open';
  incident.suppressionReason = 'ATTEMPT_LIMIT_REACHED';
  incident.circuitOpenedAt = iso(now);
  incident.circuitOpenUntil = iso(now + Number(policy.circuitDurationMs));
  incident.nextRetryAt = incident.circuitOpenUntil;
  notifyIncident(incident, 'circuit', iso(now), notifier);
}

function eligibleActions(state, checksById, {
  policies,
  now = Date.now(),
  mode = state.mode,
  enabledActionIds = state.enabledActionIds || [],
  notifier = () => ({ delivered: false, reason: 'test' }),
} = {}) {
  const enabledActions = new Set(enabledActionIds);
  const eligible = [];
  for (const incident of state.incidents) {
    if (['resolved', 'manual', 'verifying'].includes(incident.status)) continue;
    const policy = policies.find((item) => item.id === incident.actionId);
    // A persisted actionId is not permission to execute a policy whose exact
    // trigger allowlist has changed since this incident was first observed.
    if (!policy || !policyForCause(incident, [policy])) {
      incident.status = 'manual';
      incident.suppressionReason = 'NO_AUTOMATIC_POLICY';
      incident.nextRetryAt = null;
      continue;
    }
    const currentTrigger = checksById.get(incident.checkId);
    if (policy.id === 'restart-ibkr-sidecar' && (!currentTrigger
        || currentTrigger.status === 'pass' || currentTrigger.errorCode !== incident.errorCode)) {
      // Persisted incidents can remain unresolved while another dependency
      // fails. Only the currently observed exact broker failure can restart
      // its process, never an obsolete transport or session diagnosis.
      incident.status = 'suppressed';
      incident.suppressionReason = 'CURRENT_TRIGGER_CHANGED';
      incident.nextRetryAt = null;
      continue;
    }
    if (Number(incident.observationCount || 0) < 2) {
      incident.status = 'observing';
      incident.suppressionReason = 'AWAITING_SECOND_OBSERVATION';
      continue;
    }
    const circuitUntil = timestamp(incident.circuitOpenUntil);
    if (circuitUntil !== null && circuitUntil > now) {
      incident.status = 'circuit_open';
      incident.suppressionReason = 'CIRCUIT_OPEN';
      incident.nextRetryAt = iso(circuitUntil);
      continue;
    }
    if (circuitUntil !== null && circuitUntil <= now) {
      incident.circuitOpenUntil = null;
      incident.circuitOpenedAt = null;
      incident.notifications = {
        ...(incident.notifications || {}),
        circuit: null,
      };
    }
    const attempts = actionAttempts(state, incident.id, policy, now);
    if (attempts.length >= Number(policy.maxAttempts)) {
      openCircuit(state, incident, policy, now, notifier);
      continue;
    }
    const latest = latestActionAttempt(state, incident.id, policy);
    const latestAt = timestamp(latest?.startedAt);
    if (latestAt !== null && now - latestAt < Number(policy.cooldownMs)) {
      incident.status = 'cooldown';
      incident.suppressionReason = 'ACTION_COOLDOWN';
      incident.nextRetryAt = iso(latestAt + Number(policy.cooldownMs));
      continue;
    }
    const prerequisites = evaluatePrerequisites(policy, checksById, now);
    if (!prerequisites.ok) {
      incident.status = 'suppressed';
      incident.suppressionReason = prerequisites.reason;
      incident.suppressionDetail = prerequisites.detail;
      notifyIncident(incident, 'escalation', iso(now), notifier);
      continue;
    }
    if (mode === ACTIVE_MODE && !enabledActions.has(policy.id)) {
      incident.status = 'suppressed';
      incident.suppressionReason = 'ACTION_CLASS_DISABLED';
      incident.suppressionDetail = `${policy.id} is not in READINESS_CONTROLLER_ENABLED_ACTIONS.`;
      incident.nextRetryAt = null;
      continue;
    }
    incident.suppressionReason = null;
    incident.suppressionDetail = null;
    incident.nextRetryAt = null;
    if (mode !== ACTIVE_MODE) {
      incident.status = 'shadow';
      incident.suppressionReason = 'SHADOW_MODE';
      if (!state.actions.some((action) => (
        action.incidentId === incident.id
        && action.actionId === policy.id
        && action.outcome === 'shadowed'
        && timestamp(action.startedAt) >= timestamp(incident.openedAt)
      ))) {
        state.actions.unshift({
          id: `${policy.id}:${now}:shadow`,
          incidentId: incident.id,
          actionId: policy.id,
          scope: policy.scope,
          owner: policy.escalationOwner,
          startedAt: iso(now),
          completedAt: iso(now),
          outcome: 'shadowed',
          verificationOutcome: 'not-run',
          errorCode: null,
          detail: 'Policy was eligible, but the controller is in shadow mode.',
        });
      }
      continue;
    }
    incident.status = 'eligible';
    eligible.push({ incident, policy });
  }
  return eligible.sort((left, right) => (
    left.policy._order - right.policy._order
    || left.incident.id.localeCompare(right.incident.id)
  ));
}

function matchesOwnedLogName(name) {
  return OWNED_LOG_NAMES.some((baseName) => (
    name === baseName
    || new RegExp(`^${baseName.replace('.', '\\.')}\\.\\d+$`).test(name)
  ));
}

function pruneDashboardLogs({
  logDir = DEFAULT_LOG_DIR,
  fileSystem = fs,
  retainedRotations = 2,
} = {}) {
  const result = {
    logDir,
    retainedRotations,
    removed: [],
    bytesReclaimed: 0,
  };
  let entries;
  try {
    entries = fileSystem.readdirSync(logDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return result;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !matchesOwnedLogName(entry.name)) continue;
    const rotationMatch = entry.name.match(/\.(\d+)$/);
    if (!rotationMatch || Number(rotationMatch[1]) <= retainedRotations) continue;
    const target = path.join(logDir, entry.name);
    const stat = fileSystem.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
    fileSystem.unlinkSync(target);
    result.removed.push(entry.name);
    result.bytesReclaimed += stat.size;
  }
  result.removed.sort();
  return result;
}

async function fetchJson(url, options = {}, {
  fetchImpl = fetch,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
} = {}) {
  const response = await fetchImpl(url, {
    ...options,
    signal: options.signal || AbortSignal.timeout(timeoutMs),
  });
  const body = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    const error = new Error(`HTTP ${response.status} returned a non-JSON body.`);
    error.code = 'CONTROLLER_RESPONSE_INVALID';
    throw error;
  }
  if (!response.ok) {
    const error = new Error(parsed?.error || parsed?.detail || `HTTP ${response.status}`);
    error.code = parsed?.code || `HTTP_${response.status}`;
    throw error;
  }
  return parsed;
}

function readinessUrls(env = process.env) {
  const configured = String(
    env.MARKET_DASHBOARD_API_URL
      || env.REACT_APP_BACKEND_URL
      || DEFAULT_BASE_URL,
  ).replace(/\/$/, '');
  let parsed;
  try {
    parsed = new URL(configured);
  } catch {
    throw new Error('Hermes controller API URL must be an absolute loopback HTTP URL.');
  }
  const loopbackHosts = new Set(['127.0.0.1', '::1', 'localhost']);
  if (parsed.protocol !== 'http:'
      || !loopbackHosts.has(parsed.hostname)
      || parsed.username
      || parsed.password
      || !['', '/'].includes(parsed.pathname)
      || parsed.search
      || parsed.hash) {
    throw new Error('Hermes controller API URL must be a loopback HTTP origin.');
  }
  const baseUrl = parsed.origin;
  return {
    baseUrl,
    readinessUrl: `${baseUrl}/api/system-readiness`,
  };
}

function createDefaultIo({
  env = process.env,
  fetchImpl = fetch,
  logDir = DEFAULT_LOG_DIR,
  fileSystem = fs,
} = {}) {
  const urls = readinessUrls(env);
  return {
    async fetchReadiness() {
      return fetchJson(
        urls.readinessUrl,
        {},
        { fetchImpl, timeoutMs: DEFAULT_READINESS_TIMEOUT_MS },
      );
    },
    async fetchLiveCheck(checkId) {
      return fetchJson(
        `${urls.readinessUrl}/checks/${encodeURIComponent(checkId)}`,
        {},
        { fetchImpl, timeoutMs: DEFAULT_LIVE_CHECK_TIMEOUT_MS },
      );
    },
    async dispatch(policy) {
      if (policy.controllerExecutor === 'dashboard-log-prune') {
        return {
          accepted: true,
          completed: true,
          cleanup: pruneDashboardLogs({ logDir, fileSystem }),
        };
      }
      if (policy.controllerExecutor !== 'loopback-readiness-api') {
        const error = new Error('Controller executor is not allowlisted.');
        error.code = 'CONTROLLER_EXECUTOR_NOT_ALLOWLISTED';
        throw error;
      }
      const expected = ACTION_EXECUTORS[policy.id];
      if (!expected || expected.controllerExecutor !== policy.controllerExecutor) {
        const error = new Error('Repair action is not in the compiled controller allowlist.');
        error.code = 'CONTROLLER_ACTION_NOT_ALLOWLISTED';
        throw error;
      }
      return fetchJson(
        `${urls.baseUrl}/api/system-readiness/actions/${encodeURIComponent(policy.id)}`,
        {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'X-Readiness-Repair': '1',
          },
          body: '{}',
        },
        { fetchImpl },
      );
    },
  };
}

function controllerHeartbeat(state) {
  const healthy = !state.lastError && state.persistenceBlocked !== true;
  return {
    service: CONTROLLER_SERVICE_ID,
    buildFingerprint: state.buildFingerprint,
    observedAt: state.observedAt,
    shadowSoakStartedAt: state.shadowSoakStartedAt,
    status: healthy ? 'ready' : 'degraded',
    mode: state.mode,
    enabledActionIds: state.enabledActionIds,
    controllerStatus: state.status,
    errorCode: healthy ? null : state.lastError?.errorCode || 'HERMES_CONTROLLER_DEGRADED',
    detail: healthy ? null : state.lastError?.detail || null,
    incidentCount: state.incidents.filter((item) => item.status !== 'resolved').length,
    circuitCount: state.circuits.length,
    inFlightAction: state.inFlight?.actionId || null,
    nextRetryAt: state.nextRetryAt,
  };
}

function createController({
  manifest = SERVICE_MANIFEST,
  env = process.env,
  mode = normalizeMode(compatibilityEnvValue(
    env,
    'READINESS_CONTROLLER_MODE',
    'HERMES_RELIABILITY_CONTROLLER_MODE',
  )),
  enabledActionIds: requestedEnabledActionIds = null,
  statePath = controllerStateFile(env),
  state: suppliedState = null,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  io = createDefaultIo({ env }),
  notifier = (event) => sendMacNotification(event, { env }),
  persist = null,
  emit = (payload) => process.stdout.write(`${JSON.stringify(payload)}\n`),
  minObservationSeparationMs = DEFAULT_MIN_OBSERVATION_SEPARATION_MS,
  telemetryMaxAgeMs = DEFAULT_TELEMETRY_MAX_AGE_MS,
  pollIntervalMs = configuredPollIntervalMs(env),
} = {}) {
  const policies = compilePolicies(manifest);
  const episodeGapMs = deferralEpisodeGapMs(pollIntervalMs);
  const enabledActionIds = normalizeEnabledActionIds(
    requestedEnabledActionIds == null
      ? compatibilityEnvValue(
        env,
        'READINESS_CONTROLLER_ENABLED_ACTIONS',
        'HERMES_RELIABILITY_ENABLED_ACTIONS',
      )
      : requestedEnabledActionIds,
    policies,
  );
  const loaded = suppliedState || readState(statePath);
  const state = restoreState(loaded, {
    mode,
    now: now(),
    enabledActionIds,
  });
  const save = persist || ((value) => {
    const result = writeStateAtomically(statePath, value);
    if (!result.ok) {
      const error = result.error || new Error(result.errorCode);
      error.code = result.errorCode;
      throw error;
    }
  });

  function persistAndEmit() {
    refreshDerivedState(state, now());
    state.persistenceBlocked = false;
    try {
      save(state);
      emit(controllerHeartbeat(state));
      return true;
    } catch (error) {
      const observedAt = iso(now());
      state.persistenceBlocked = true;
      state.lastError = {
        errorCode: 'CONTROLLER_STATE_WRITE_FAILED',
        detail: boundedText(
          `${error?.code ? `[${error.code}] ` : ''}${error?.message || error || 'Controller state could not be persisted.'}`,
        ),
        observedAt,
      };
      state.status = 'degraded';
      state.observedAt = observedAt;
      emit(controllerHeartbeat(state));
      return false;
    }
  }

  function recordPollError(error) {
    const observedAt = iso(now());
    state.lastError = {
      errorCode: error?.code || 'HERMES_CONTROLLER_READINESS_UNAVAILABLE',
      detail: boundedText(error?.message || error || 'Readiness poll failed.'),
      observedAt,
    };
    state.status = 'degraded';
    state.observedAt = observedAt;
  }

  function holdInFlightForRecovery(reason) {
    if (!state.inFlight) return;
    const startedAt = timestamp(state.inFlight.startedAt) ?? now();
    const releaseAfter = Math.max(
      startedAt
        + Math.max(0, Number(state.inFlight.settleTimeoutMs) || 0)
        + Math.max(0, Number(state.inFlight.cooldownMs) || 0),
      timestamp(state.inFlight.releaseAfter) ?? 0,
    );
    state.inFlight = {
      ...state.inFlight,
      recoveryHold: true,
      releaseAfter: iso(releaseAfter),
      postRestartVerifiedAt: null,
      phase: reason,
    };
    const incident = state.incidents.find(
      (item) => item.id === state.inFlight.incidentId,
    );
    if (incident && incident.status !== 'resolved') {
      incident.status = 'verifying';
      incident.verificationOutcome = 'global-recovery-hold';
      incident.nextRetryAt = state.inFlight.releaseAfter;
    }
  }

  function releaseRecoveryHoldAfterFreshReadiness(observedAtMs) {
    if (!state.inFlight?.recoveryHold) return false;
    state.inFlight.postRestartVerifiedAt = iso(observedAtMs);
    const releaseAfter = timestamp(state.inFlight.releaseAfter);
    if (releaseAfter === null || observedAtMs < releaseAfter) return false;
    const record = state.actions.find(
      (item) => item.id === state.inFlight.actionRecordId,
    );
    if (record && !record.completedAt) {
      record.completedAt = iso(observedAtMs);
      record.outcome = 'uncertain';
      record.verificationOutcome = 'fresh-readiness-observed-after-recovery-hold';
      record.errorCode = record.errorCode || 'CONTROLLER_ACTION_COMPLETION_UNCERTAIN';
      record.detail = record.detail
        || 'Fresh readiness was observed after the full settle and cooldown window, but action completion could not be reconstructed.';
    }
    state.inFlight = null;
    return true;
  }

  // Deferrable actions read their live checks here, immediately before the
  // dispatch decision, never from the cached readiness report. A deferred
  // action leaves later eligible actions free to run.
  async function firstUndeferredAction(candidates) {
    for (const candidate of candidates) {
      const { incident, policy } = candidate;
      const deferrals = applicableDeferrals(policy, incident);
      if (deferrals.length === 0) return candidate;
      const liveChecks = new Map();
      for (const { checkId } of deferrals) {
        if (liveChecks.has(checkId)) continue;
        try {
          const check = await io.fetchLiveCheck(checkId);
          if (check?.id === checkId) liveChecks.set(checkId, check);
        } catch {
          // An unreadable live check leaves the protected work unverified.
        }
      }
      const evaluatedAt = now();
      const deferral = evaluateDeferrals(policy, liveChecks, incident, evaluatedAt, { episodeGapMs });
      if (!deferral.defer) {
        delete incident.deferral;
        return candidate;
      }
      deferIncident(incident, deferral, evaluatedAt, episodeGapMs);
    }
    return null;
  }

  // A poll that could not re-evaluate a deferral, because another action was
  // in flight or just ran, still observed its incident eligible. Keep that
  // episode current so a busy poll never restarts its bounded hold.
  function keepDeferrals(eligible, observedAt) {
    const keptAt = now();
    for (const { incident } of eligible) {
      if (!currentDeferral(incident, observedAt, episodeGapMs)) continue;
      incident.deferral.lastEvaluatedAt = iso(Math.max(keptAt, timestamp(incident.deferral.lastEvaluatedAt)));
    }
  }

  async function runAction(candidate) {
    const { incident, policy } = candidate;
    const startedAtMs = now();
    const actionRecord = {
      id: `${policy.id}:${startedAtMs}`,
      incidentId: incident.id,
      actionId: policy.id,
      scope: policy.scope,
      owner: policy.escalationOwner,
      startedAt: iso(startedAtMs),
      completedAt: null,
      outcome: 'running',
      verificationOutcome: 'pending',
      errorCode: null,
      detail: null,
    };
    state.actions.unshift(actionRecord);
    state.inFlight = {
      actionRecordId: actionRecord.id,
      incidentId: incident.id,
      actionId: policy.id,
      startedAt: actionRecord.startedAt,
      settleTimeoutMs: Number(policy.settleTimeoutMs),
      cooldownMs: Number(policy.cooldownMs),
      recoveryHold: false,
      releaseAfter: null,
      postRestartVerifiedAt: null,
      phase: 'prepared',
    };
    state.status = 'acting';
    incident.status = 'verifying';
    incident.verificationOutcome = 'pending';
    if (!persistAndEmit()) {
      const failedAtMs = now();
      actionRecord.completedAt = iso(failedAtMs);
      actionRecord.outcome = 'not_dispatched';
      actionRecord.verificationOutcome = 'not-run';
      actionRecord.errorCode = 'CONTROLLER_STATE_WRITE_FAILED';
      actionRecord.detail = 'The mandatory pre-dispatch state checkpoint failed; no repair was dispatched.';
      incident.status = 'suppressed';
      incident.suppressionReason = 'CONTROLLER_STATE_WRITE_FAILED';
      incident.nextRetryAt = null;
      state.inFlight = null;
      return;
    }

    let retainInFlight = false;
    try {
      const dispatchResult = await io.dispatch(policy, incident);
      if (dispatchResult?.accepted !== true) {
        const error = new Error('Repair executor did not accept the action.');
        error.code = 'CONTROLLER_ACTION_NOT_ACCEPTED';
        throw error;
      }
      actionRecord.dispatch = {
        accepted: true,
        completed: dispatchResult.completed === true,
        acceptedAt: dispatchResult.acceptedAt || null,
        cleanup: dispatchResult.cleanup || null,
      };
      state.inFlight.phase = 'dispatched';
      if (!persistAndEmit()) {
        holdInFlightForRecovery('post-dispatch-persistence-failure');
        retainInFlight = true;
        return;
      }
      if (Number(policy.settleTimeoutMs) > 0) {
        await sleep(Number(policy.settleTimeoutMs));
      }
      const verificationReport = await io.fetchReadiness();
      const verifiedAtMs = now();
      const freshness = reportFreshness(verificationReport, {
        now: verifiedAtMs,
        telemetryMaxAgeMs,
      });
      if (!freshness.fresh) {
        const error = new Error(`Post-action readiness was not fresh: ${freshness.reason}.`);
        error.code = freshness.reason;
        throw error;
      }
      const observation = observeReport(state, verificationReport, {
        policies,
        now: verifiedAtMs,
        minObservationSeparationMs,
        notifier,
      });
      const causeStillActive = observation.activeIds.has(incident.id);
      const checksClean = verificationPassed(
        incident,
        policy,
        observation.checksById,
      );
      actionRecord.outcome = 'accepted';
      actionRecord.completedAt = iso(verifiedAtMs);
      actionRecord.verificationOutcome = !causeStillActive && checksClean
        ? 'clean-1-of-2'
        : 'failed';
      if (causeStillActive || !checksClean) {
        incident.status = 'open';
        incident.verificationOutcome = 'failed';
        incident.cleanObservationCount = 0;
        incident.lastCleanObservedAt = null;
        incident.nextRetryAt = iso(verifiedAtMs + Number(policy.cooldownMs));
      }
    } catch (error) {
      const failedAtMs = now();
      actionRecord.outcome = 'failed';
      actionRecord.completedAt = iso(failedAtMs);
      actionRecord.verificationOutcome = 'failed';
      actionRecord.errorCode = error?.code || 'CONTROLLER_ACTION_FAILED';
      actionRecord.detail = boundedText(error?.message || error);
      incident.status = 'open';
      incident.verificationOutcome = 'failed';
      incident.suppressionReason = 'ACTION_FAILED';
      incident.nextRetryAt = iso(failedAtMs + Number(policy.cooldownMs));
      notifyIncident(incident, 'escalation', iso(failedAtMs), notifier);
    } finally {
      const attempts = actionAttempts(state, incident.id, policy, now());
      if (incident.status !== 'resolved'
          && attempts.length >= Number(policy.maxAttempts)) {
        openCircuit(state, incident, policy, now(), notifier);
      }
      if (!retainInFlight && state.inFlight) {
        state.inFlight.phase = 'verification-complete';
        if (!persistAndEmit()) {
          holdInFlightForRecovery('verification-persistence-failure');
          retainInFlight = true;
        }
      }
      if (!retainInFlight && state.inFlight) {
        const completedFlight = state.inFlight;
        state.inFlight = null;
        if (!persistAndEmit()) {
          state.inFlight = completedFlight;
          holdInFlightForRecovery('in-flight-clear-persistence-failure');
        }
      }
    }
  }

  async function tick() {
    if (state.persistenceBlocked && !persistAndEmit()) {
      return state;
    }
    try {
      const report = await io.fetchReadiness();
      // A cold readiness collection can legitimately take tens of seconds and
      // return observations created after the request began. Judge freshness
      // and incident timing when the completed report is actually observed.
      const observedAt = now();
      const freshness = reportFreshness(report, {
        now: observedAt,
        telemetryMaxAgeMs,
      });
      if (!freshness.fresh) {
        const error = new Error(`Readiness telemetry is not actionable: ${freshness.reason}.`);
        error.code = freshness.reason;
        throw error;
      }
      const observation = observeReport(state, report, {
        policies,
        now: observedAt,
        minObservationSeparationMs,
        notifier,
      });
      const releasedRecoveryHold = releaseRecoveryHoldAfterFreshReadiness(
        observedAt,
      );
      const eligible = eligibleActions(state, observation.checksById, {
        policies,
        now: observedAt,
        mode,
        enabledActionIds,
        notifier,
      });
      if (
        mode === ACTIVE_MODE
        && !state.inFlight
        && !releasedRecoveryHold
        && eligible.length > 0
      ) {
        const candidate = await firstUndeferredAction(eligible);
        if (candidate) await runAction(candidate);
      }
      keepDeferrals(eligible, observedAt);
      if (!state.lastError) {
        state.status = state.inFlight
          ? 'acting'
          : (state.incidents.some(
            (incident) => timestamp(incident.circuitOpenUntil) > now(),
          )
            ? 'circuit_open'
            : (mode === ACTIVE_MODE ? 'monitoring' : 'shadow'));
      }
    } catch (error) {
      recordPollError(error);
    }
    persistAndEmit();
    return state;
  }

  return {
    mode,
    policies,
    state,
    statePath,
    tick,
  };
}

function configuredPollIntervalMs(env = process.env) {
  return Math.max(
    DEFAULT_POLL_INTERVAL_MS,
    Number(compatibilityEnvValue(
      env,
      'READINESS_CONTROLLER_POLL_INTERVAL_MS',
      'HERMES_CONTROLLER_POLL_INTERVAL_MS',
    ))
      || DEFAULT_POLL_INTERVAL_MS,
  );
}

async function runDaemon({
  env = process.env,
  intervalMs = configuredPollIntervalMs(env),
  controller = createController({ env, pollIntervalMs: intervalMs }),
} = {}) {
  let stopping = false;
  let wake = null;
  const stop = () => {
    stopping = true;
    wake?.();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  while (!stopping) {
    const startedAt = Date.now();
    await controller.tick();
    if (stopping) break;
    const remaining = Math.max(0, intervalMs - (Date.now() - startedAt));
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        wake = null;
        resolve();
      }, remaining);
      wake = () => {
        clearTimeout(timer);
        wake = null;
        resolve();
      };
    });
  }
}

if (require.main === module) {
  runDaemon().catch((error) => {
    process.stderr.write(
      `[readiness-controller] fatal: ${boundedText(error?.stack || error)}\n`,
    );
    process.exitCode = 1;
  });
}

module.exports = {
  ACTION_EXECUTORS,
  ACTIVE_MODE,
  CONTROLLER_SERVICE_ID,
  CONTROLLER_BUILD_FINGERPRINT,
  DEFAULT_LIVE_CHECK_TIMEOUT_MS,
  DEFAULT_LOG_DIR,
  DEFAULT_MIN_OBSERVATION_SEPARATION_MS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_READINESS_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_STATE_FILE,
  DEFAULT_TELEMETRY_MAX_AGE_MS,
  OWNED_LOG_NAMES,
  SHADOW_MODE,
  buildDependentSuppressions,
  compilePolicies,
  compatibilityEnvValue,
  controllerHeartbeat,
  controllerStateFile,
  createController,
  createDefaultIo,
  deferIncident,
  deferralEpisodeGapMs,
  eligibleActions,
  evaluateDeferrals,
  evaluatePrerequisites,
  flattenChecks,
  incidentId,
  localNotificationsEnabled,
  newState,
  normalizeEnabledActionIds,
  normalizeMode,
  notifyIncident,
  observeReport,
  policyValidationErrors,
  pruneDashboardLogs,
  readState,
  reportFreshness,
  readinessUrls,
  restoreState,
  runDaemon,
  sendMacNotification,
  verificationPassed,
  writeStateAtomically,
};
