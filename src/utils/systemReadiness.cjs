const SERVICE_MANIFEST = require('../../ops/services.json');

const VALID_CHECK_STATUSES = new Set(['pass', 'warn', 'fail']);
const VALID_CAPABILITY_STATUSES = new Set(['ready', 'degraded', 'blocked']);
const MAX_FUTURE_CLOCK_SKEW_MS = 30_000;
const EXPECTED_CLOUD_BUILD_VERSION = process.env.MARKET_DASHBOARD_EXPECTED_CLOUD_BUILD_VERSION
  || require('../../package.json').version;
const GMAIL_SERVICE_DEFINITION = (SERVICE_MANIFEST.services || [])
  .find((service) => service.id === 'gmail.ingestion');

function toDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function ageSeconds(observedAt, now = new Date()) {
  const observed = toDate(observedAt);
  const current = toDate(now);
  if (!observed || !current) return null;
  const ageMs = current.getTime() - observed.getTime();
  if (ageMs < -MAX_FUTURE_CLOCK_SKEW_MS) return null;
  return Math.max(0, Math.floor(ageMs / 1000));
}

function exceedsFutureClockSkew(observedAt, now = new Date()) {
  const observed = toDate(observedAt);
  const current = toDate(now);
  if (!observed || !current) return false;
  return observed.getTime() - current.getTime() > MAX_FUTURE_CLOCK_SKEW_MS;
}

function addMinutes(value, minutes) {
  const date = toDate(value);
  if (!date) return null;
  return new Date(date.getTime() + Math.max(0, Number(minutes) || 0) * 60 * 1000).toISOString();
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .filter((value) => value !== null && value !== undefined && value !== '')
    .map((value) => String(value)))];
}

function manifestIndexes(manifest = SERVICE_MANIFEST) {
  return {
    services: new Map((manifest?.services || []).map((service) => [String(service.id), service])),
    capabilities: new Map((manifest?.capabilities || []).map((capability) => [String(capability.id), capability])),
    repairs: new Map((manifest?.repairActions || []).map((action) => [String(action.id), action])),
    runbooks: new Map((manifest?.runbooks || []).map((runbook) => [String(runbook.id), runbook])),
  };
}

function normalizedErrorCode(value, id, status) {
  if (status === 'pass') return null;
  if (value) return String(value).trim().toUpperCase().replace(/[^A-Z0-9_]+/g, '_');
  const prefix = String(id || 'readiness_check').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  return `${prefix}_${status === 'warn' ? 'WARNING' : 'FAILED'}`;
}

function normalizeRecovery(input, service, indexes) {
  const configuredAction = service?.recoveryActionId
    ? indexes.repairs.get(String(service.recoveryActionId))
    : null;
  const supplied = input && typeof input === 'object' ? input : null;
  if (!supplied) return null;

  const actionId = supplied?.actionId || configuredAction?.id || null;
  const automatic = Boolean(
    actionId
    && configuredAction?.automatic === true
    && configuredAction?.loopbackOnly === true
    && supplied?.kind !== 'manual',
  );
  const kind = supplied?.kind === 'command' || automatic ? 'command' : 'manual';

  return {
    kind,
    label: supplied?.label || configuredAction?.label || 'Resolve this dependency and refresh.',
    ...(supplied?.command || configuredAction?.command
      ? { command: supplied?.command || configuredAction.command }
      : {}),
    automatic,
    ...(automatic ? { actionId } : {}),
  };
}

function makeCheck(input = {}) {
  const indexes = manifestIndexes(input.manifest || SERVICE_MANIFEST);
  const requestedStatus = VALID_CHECK_STATUSES.has(input.status) ? input.status : 'fail';
  const id = String(input.id || 'unknown');
  const service = indexes.services.get(id);
  const summary = input.summary || (requestedStatus === 'pass'
    ? 'Verified.'
    : 'Readiness could not be verified.');
  const observedAt = toDate(input.observedAt)?.toISOString() || null;
  const recovery = normalizeRecovery(input.recovery, service, indexes);
  const capabilityIds = uniqueStrings(input.capabilityIds || service?.capabilityIds);
  const dependsOn = uniqueStrings(input.dependsOn || service?.dependsOn);
  const inferredCapabilityBlocks = capabilityIds.some((capabilityId) => (
    indexes.capabilities.get(capabilityId)?.blocking === true
  ));
  const blocking = service && typeof service.blocking === 'boolean'
    ? service.blocking
    : (input.blocking === true && (capabilityIds.length === 0 || inferredCapabilityBlocks));
  const automatic = typeof input.automatic === 'boolean'
    ? input.automatic
    : Boolean(recovery?.automatic || service?.automatic === true);
  const runbookDefinition = service?.runbookId
    ? indexes.runbooks.get(String(service.runbookId))
    : null;
  const passthrough = { ...input };
  delete passthrough.manifest;
  delete passthrough.now;

  return {
    ...passthrough,
    id,
    label: String(input.label || service?.label || input.id || 'Unknown check'),
    status: requestedStatus,
    blocking,
    summary,
    detail: input.detail || null,
    observedAt,
    ageSeconds: Number.isFinite(input.ageSeconds)
      ? Math.max(0, Math.floor(input.ageSeconds))
      : ageSeconds(input.observedAt, input.now),
    capabilityIds,
    dependsOn,
    errorCode: normalizedErrorCode(input.errorCode, id, requestedStatus),
    lastSuccessAt: toDate(input.lastSuccessAt || (requestedStatus === 'pass' ? observedAt : null))?.toISOString() || null,
    nextDueAt: toDate(input.nextDueAt)?.toISOString() || null,
    owner: String(input.owner || service?.owner || 'unassigned'),
    automatic,
    impact: input.impact || null,
    recovery,
    provenance: input.provenance && typeof input.provenance === 'object'
      ? { ...input.provenance }
      : null,
    runbook: runbookDefinition ? {
      id: runbookDefinition.id,
      label: runbookDefinition.label,
      text: runbookDefinition.text,
    } : null,
    cadenceMinutes: Number.isFinite(Number(service?.cadenceMinutes))
      ? Number(service.cadenceMinutes)
      : null,
    readinessMaxAgeMinutes: Number.isFinite(Number(service?.readinessMaxAgeMinutes))
      ? Number(service.readinessMaxAgeMinutes)
      : null,
    scheduleWindow: service?.scheduleWindow ? { ...service.scheduleWindow } : null,
    aws: service?.aws ? { ...service.aws } : null,
  };
}

function statusRank(status) {
  if (status === 'fail' || status === 'blocked') return 2;
  if (status === 'warn' || status === 'degraded') return 1;
  return 0;
}

function buildRootCauses(checks) {
  const unhealthy = checks.filter((check) => check.status !== 'pass');
  const unhealthyById = new Map(unhealthy.map((check) => [check.id, check]));

  function resolveRootIds(checkId, trail = new Set()) {
    if (trail.has(checkId)) return [checkId];
    const check = unhealthyById.get(checkId);
    if (!check) return [];
    const nextTrail = new Set(trail).add(checkId);
    const unhealthyDependencies = check.dependsOn.filter((id) => unhealthyById.has(id));
    if (unhealthyDependencies.length === 0) return [checkId];
    return uniqueStrings(unhealthyDependencies.flatMap((id) => resolveRootIds(id, nextTrail)));
  }

  const roots = new Map();
  for (const affected of unhealthy) {
    const rootIds = resolveRootIds(affected.id);
    for (const rootId of rootIds.length > 0 ? rootIds : [affected.id]) {
      const root = unhealthyById.get(rootId) || affected;
      const legacyId = root.errorCode || root.id;
      const dedupeKey = `${root.id}:${legacyId}`;
      const existing = roots.get(dedupeKey);
      const capabilityIds = uniqueStrings([
        ...(existing?.capabilityIds || []),
        ...root.capabilityIds,
        ...affected.capabilityIds,
      ]);
      const affectedCheckIds = uniqueStrings([...(existing?.affectedCheckIds || []), affected.id]);
      if (existing) {
        roots.set(dedupeKey, {
          ...existing,
          status: statusRank(root.status) > statusRank(existing.status) ? root.status : existing.status,
          capabilityIds,
          affectedCheckIds,
        });
      } else {
        roots.set(dedupeKey, {
          id: legacyId,
          dedupeKey,
          errorCode: root.errorCode,
          checkId: root.id,
          label: root.label,
          status: root.status,
          summary: root.summary,
          owner: root.owner,
          capabilityIds,
          affectedCheckIds,
          recovery: root.recovery,
          impact: root.impact || null,
          suppressionReason: root.suppressionReason || null,
          nextRetryAt: root.nextRetryAt || root.nextDueAt || null,
          verification: root.verification || null,
          runbook: root.runbook || null,
        });
      }
    }
  }

  const values = [...roots.values()];
  const legacyIdCounts = values.reduce((counts, cause) => {
    counts.set(cause.id, Number(counts.get(cause.id) || 0) + 1);
    return counts;
  }, new Map());
  return values.map((cause) => (
    legacyIdCounts.get(cause.id) > 1
      ? { ...cause, id: cause.dedupeKey }
      : cause
  )).sort((left, right) => (
    statusRank(right.status) - statusRank(left.status)
    || left.label.localeCompare(right.label)
  ));
}

function buildManualActions(rootCauses) {
  const actions = new Map();
  for (const cause of rootCauses) {
    const recovery = cause?.recovery;
    if (!recovery || recovery.automatic === true || recovery.kind !== 'manual') continue;
    const id = `manual:${cause.errorCode || cause.checkId || cause.id}`;
    const existing = actions.get(id);
    if (existing) {
      existing.rootCauseIds = uniqueStrings([...existing.rootCauseIds, cause.id]);
      existing.affectedCheckIds = uniqueStrings([
        ...existing.affectedCheckIds,
        ...(cause.affectedCheckIds || []),
      ]);
      continue;
    }
    actions.set(id, {
      id,
      label: recovery.label || `Resolve ${cause.label}.`,
      owner: cause.owner || 'unassigned',
      rootCauseIds: [cause.id],
      affectedCheckIds: uniqueStrings(cause.affectedCheckIds),
      impact: cause.impact || null,
      runbook: cause.runbook || null,
      approvalRequired: true,
    });
  }
  return [...actions.values()];
}

function buildSuppressedSymptoms(checks, rootCauses) {
  const unhealthyIds = new Set(
    checks.filter((check) => check.status !== 'pass').map((check) => check.id),
  );
  return checks.flatMap((check) => {
    if (check.status === 'pass') return [];
    const unhealthyDependencies = check.dependsOn.filter((id) => unhealthyIds.has(id));
    if (unhealthyDependencies.length === 0) return [];
    const suppressedBy = uniqueStrings(rootCauses
      .filter((cause) => cause.affectedCheckIds.includes(check.id))
      .map((cause) => cause.id));
    return [{
      checkId: check.id,
      errorCode: check.errorCode,
      suppressedBy,
      reason: `Dependent symptom is suppressed while ${unhealthyDependencies.join(', ')} remains unhealthy.`,
    }];
  });
}

function buildCapabilities(checks, rootCauses, manifest = SERVICE_MANIFEST) {
  const indexes = manifestIndexes(manifest);
  return [...indexes.capabilities.values()].flatMap((definition) => {
    const capabilityChecks = checks.filter((check) => check.capabilityIds.includes(definition.id));
    if (capabilityChecks.length === 0) return [];
    const failures = capabilityChecks.filter((check) => check.status === 'fail');
    const warnings = capabilityChecks.filter((check) => check.status === 'warn');
    const blockingFailures = failures.filter((check) => check.blocking);
    const status = definition.blocking === true && blockingFailures.length > 0
      ? 'blocked'
      : (failures.length > 0 || warnings.length > 0 ? 'degraded' : 'ready');

    return [{
      id: definition.id,
      label: definition.label || definition.id,
      description: definition.description || null,
      blocking: definition.blocking === true,
      status: VALID_CAPABILITY_STATUSES.has(status) ? status : 'blocked',
      ready: status === 'ready',
      fullyOperational: failures.length === 0 && warnings.length === 0,
      checkIds: capabilityChecks.map((check) => check.id),
      failedCheckIds: failures.map((check) => check.id),
      warningCheckIds: warnings.map((check) => check.id),
      rootCauseIds: rootCauses
        .filter((cause) => cause.capabilityIds.includes(definition.id))
        .map((cause) => cause.id),
    }];
  });
}

function buildSystemReadiness(rawGroups = [], options = {}) {
  const checkedAt = toDate(options.now || new Date()) || new Date();
  const manifest = options.manifest || SERVICE_MANIFEST;
  const indexes = manifestIndexes(manifest);
  const groups = rawGroups.map((group) => {
    const checks = (group.checks || []).map((check) => makeCheck({
      ...check,
      capabilityIds: Array.isArray(check.capabilityIds) && check.capabilityIds.length > 0
        ? check.capabilityIds
        : (indexes.capabilities.has(String(group.id)) ? [String(group.id)] : undefined),
      now: checkedAt,
      manifest,
    }));
    return {
      id: String(group.id || 'other'),
      label: String(group.label || group.id || 'Other'),
      checks,
    };
  });
  const checks = groups.flatMap((group) => group.checks);
  const summary = checks.reduce((counts, check) => {
    if (check.status === 'pass') counts.passed += 1;
    if (check.status === 'warn') counts.warnings += 1;
    if (check.status === 'fail') counts.failed += 1;
    if (check.status === 'fail' && check.blocking) counts.blockingFailures += 1;
    counts.total += 1;
    return counts;
  }, { passed: 0, warnings: 0, failed: 0, total: 0, blockingFailures: 0 });

  const rootCauses = buildRootCauses(checks);
  const manualActions = buildManualActions(rootCauses);
  const suppressedSymptoms = buildSuppressedSymptoms(checks, rootCauses);
  const capabilities = buildCapabilities(checks, rootCauses, manifest);
  const hasBlockedCapability = capabilities.some((capability) => capability.status === 'blocked');
  const hasLegacyBlockingFailure = checks.some((check) => (
    check.status === 'fail' && check.blocking && check.capabilityIds.length === 0
  ));
  const status = hasBlockedCapability || hasLegacyBlockingFailure
    ? 'blocked'
    : (summary.failed > 0 || summary.warnings > 0 ? 'degraded' : 'ready');

  return {
    version: 1,
    status,
    ready: status === 'ready',
    operational: status !== 'blocked',
    fullyOperational: checks.length > 0 && checks.every((check) => check.status === 'pass'),
    checkedAt: checkedAt.toISOString(),
    summary,
    capabilities,
    rootCauses,
    manualActions,
    suppressedSymptoms,
    groups,
  };
}

function evaluateHermesWorker({
  worker,
  heartbeat,
  now = new Date(),
  maxAgeMinutes,
  invocation,
  due = true,
}) {
  const hasServiceHeartbeat = Boolean(heartbeat && typeof heartbeat === 'object');
  const label = `Hermes ${worker?.name || worker?.key || 'worker'}`;
  const recovery = {
    kind: 'manual',
    label: 'Enable the worker schedule, verify its dashboard target, then run it once.',
  };
  const lastRun = (hasServiceHeartbeat ? heartbeat.finishedAt || heartbeat.observedAt : null)
    || worker?.finishedAt
    || worker?.lastRun
    || null;
  const runAgeSeconds = ageSeconds(lastRun, now);
  const thresholdSeconds = Math.max(1, Number(maxAgeMinutes) || 30) * 60;
  const source = String(
    (hasServiceHeartbeat ? heartbeat.source || 'service-heartbeat-table' : null)
      || worker?.source
      || worker?.latestRunSource
      || '',
  ).toLowerCase();
  const runStatus = String(
    (hasServiceHeartbeat ? heartbeat.status : null) || worker?.status || '',
  ).toLowerCase();
  const heartbeatStatusValid = ['success', 'succeeded', 'healthy', 'warning', 'blocked'].includes(runStatus);
  const runSummary = (hasServiceHeartbeat ? heartbeat.detail : null) || worker?.summary || null;
  const lastSuccessAt = heartbeat?.lastSuccessAt
    || worker?.lastSuccessAt
    || (['success', 'succeeded', 'healthy'].includes(runStatus) ? lastRun : null);
  const nextDueAt = addMinutes(lastRun, thresholdSeconds / 60);
  const provenance = hasServiceHeartbeat ? {
    source: 'service-heartbeat-table',
    serviceId: heartbeat.serviceId || worker?.heartbeatServiceId || `hermes:${worker?.key || 'unknown'}`,
    heartbeatSource: heartbeat.source || null,
    triggerSource: heartbeat.triggerSource || null,
    scheduleId: heartbeat.scheduleId || null,
    buildVersion: heartbeat.buildVersion || null,
    counts: heartbeat.counts || {},
  } : null;

  if (hasServiceHeartbeat) {
    const expectedScheduleId = worker?.scheduleId || `market-dashboard-hermes-${worker?.key || 'unknown'}-v2`;
    const schedulerVerified = heartbeat.source === 'aws-lambda'
      && heartbeat.triggerSource === 'aws-scheduler'
      && heartbeat.scheduled === true
      && heartbeat.scheduleId === expectedScheduleId;
    if (!schedulerVerified) {
      return makeCheck({
        id: `hermes.${worker?.key || 'unknown'}`,
        label,
        status: 'fail',
        blocking: true,
        summary: 'The latest heartbeat did not prove invocation by the owned AWS schedule.',
        errorCode: 'HERMES_SCHEDULER_PROVENANCE_INVALID',
        detail: `Expected ${expectedScheduleId}; received ${heartbeat.scheduleId || 'no schedule ID'} from ${heartbeat.triggerSource || 'unknown trigger'}.`,
        observedAt: lastRun,
        lastSuccessAt,
        nextDueAt,
        now,
        impact: 'A manual or unrelated invocation cannot prove this automation remains scheduled.',
        recovery,
        provenance,
      });
    }
  }

  if (!lastRun || (!hasServiceHeartbeat && source === 'dashboard')) {
    return makeCheck({
      id: `hermes.${worker?.key || 'unknown'}`,
      label,
      status: 'fail',
      blocking: true,
      summary: source === 'dashboard'
        ? 'Only a synthetic dashboard run exists; no worker heartbeat was verified.'
        : 'No completed worker heartbeat was found.',
      errorCode: 'HERMES_HEARTBEAT_MISSING',
      detail: worker?.summary || null,
      lastSuccessAt,
      nextDueAt,
      impact: 'This automation may not be monitoring the dashboard.',
      recovery,
      provenance,
    });
  }

  if (['error', 'failed'].includes(runStatus)) {
    return makeCheck({
      id: `hermes.${worker.key}`,
      label,
      status: 'fail',
      blocking: true,
      summary: `Latest worker run failed${runSummary ? `: ${runSummary}` : '.'}`,
      errorCode: heartbeat?.errorCode || 'HERMES_WORKER_FAILED',
      observedAt: lastRun,
      lastSuccessAt,
      nextDueAt,
      now,
      impact: 'This automation is not completing successfully.',
      recovery,
      provenance,
    });
  }

  if (runStatus === 'blocked') {
    const blockedBy = String(heartbeat?.blockedBy || 'portfolio.live');
    return makeCheck({
      id: `hermes.${worker.key}`,
      label,
      status: 'warn',
      blocking: true,
      dependsOn: blockedBy === 'portfolio.live' ? ['ibkr.gateway'] : [],
      summary: `${label} completed but is blocked by ${blockedBy}.`,
      errorCode: heartbeat?.errorCode || 'HERMES_DEPENDENCY_BLOCKED',
      detail: runSummary,
      observedAt: lastRun,
      lastSuccessAt,
      nextDueAt,
      now,
      impact: 'The worker is scheduled and healthy, but live-dependent analysis is paused.',
      recovery: null,
      provenance,
    });
  }

  if (hasServiceHeartbeat && !heartbeatStatusValid) {
    return makeCheck({
      id: `hermes.${worker.key}`,
      label,
      status: 'fail',
      blocking: true,
      summary: `The per-service heartbeat has unsupported status ${runStatus || 'unknown'}.`,
      errorCode: 'HERMES_HEARTBEAT_INVALID',
      detail: runSummary,
      observedAt: lastRun,
      lastSuccessAt,
      nextDueAt,
      now,
      impact: 'This automation cannot be assumed healthy.',
      recovery,
      provenance,
    });
  }

  if (due && (runAgeSeconds == null || runAgeSeconds > thresholdSeconds)) {
    const ageMinutes = runAgeSeconds == null ? null : Math.floor(runAgeSeconds / 60);
    const schedulerEvidence = hasServiceHeartbeat
      ? `Per-service heartbeat status: ${runStatus || 'unknown'}.`
      : invocation?.error
      ? `Scheduler metrics unavailable: ${invocation.error}`
      : `${Number(invocation?.invocations || 0)} Lambda invocation(s) and ${Number(invocation?.errors || 0)} error(s) in the last ${Number(invocation?.windowMinutes || 0)} minutes.`;
    return makeCheck({
      id: `hermes.${worker.key}`,
      label,
      status: 'fail',
      blocking: true,
      summary: ageMinutes == null
        ? 'Worker heartbeat time is invalid.'
        : `Last completed heartbeat was ${ageMinutes} minutes ago; expected within ${thresholdSeconds / 60} minutes.`,
      errorCode: 'HERMES_SCHEDULE_STALE',
      detail: [runSummary, schedulerEvidence].filter(Boolean).join(' '),
      observedAt: lastRun,
      lastSuccessAt,
      nextDueAt,
      now,
      impact: 'This automation is stale and cannot be assumed to be running.',
      recovery,
      provenance,
    });
  }

  if (hasServiceHeartbeat && heartbeat.buildVersion !== EXPECTED_CLOUD_BUILD_VERSION) {
    return makeCheck({
      id: `hermes.${worker.key}`,
      label,
      status: 'fail',
      blocking: true,
      summary: 'The worker heartbeat came from an unexpected code version.',
      errorCode: 'HERMES_BUILD_VERSION_MISMATCH',
      detail: `Expected ${EXPECTED_CLOUD_BUILD_VERSION}; received ${heartbeat.buildVersion || 'missing'}.`,
      observedAt: lastRun,
      lastSuccessAt,
      nextDueAt,
      now,
      impact: 'The schedule may still be invoking an old or unmanaged Lambda package.',
      recovery,
      provenance,
    });
  }

  if (!hasServiceHeartbeat && invocation?.error) {
    return makeCheck({
      id: `hermes.${worker.key}`,
      label,
      status: 'warn',
      blocking: true,
      summary: due
        ? 'Worker completed recently, but its scheduler could not be verified.'
        : 'Worker is not currently due; scheduler verification was unavailable.',
      errorCode: 'HERMES_METRICS_UNAVAILABLE',
      detail: invocation.error,
      observedAt: lastRun,
      lastSuccessAt,
      nextDueAt,
      now,
      impact: 'A recent result exists, but continued scheduling is unknown.',
      recovery,
      provenance,
    });
  }

  if (!hasServiceHeartbeat && due && Number(invocation?.invocations || 0) === 0) {
    return makeCheck({
      id: `hermes.${worker.key}`,
      label,
      status: 'fail',
      blocking: true,
      summary: 'No scheduled Lambda invocation was observed in the readiness window.',
      errorCode: 'HERMES_SCHEDULE_STALE',
      observedAt: lastRun,
      lastSuccessAt,
      nextDueAt,
      now,
      impact: 'The schedule may be disabled even though an older run exists.',
      recovery,
      provenance,
    });
  }

  if ((!hasServiceHeartbeat && Number(invocation?.errors || 0) > 0) || runStatus === 'warning') {
    return makeCheck({
      id: `hermes.${worker.key}`,
      label,
      status: 'warn',
      blocking: true,
      summary: `${label} is running with warnings.`,
      errorCode: 'HERMES_WORKER_WARNING',
      detail: runSummary || `${invocation.errors} Lambda error(s) in the readiness window.`,
      observedAt: lastRun,
      lastSuccessAt,
      nextDueAt,
      now,
      impact: 'Monitoring is active but may be incomplete.',
      recovery,
      provenance,
    });
  }

  return makeCheck({
    id: `hermes.${worker.key}`,
    label,
    status: 'pass',
    blocking: true,
    summary: due
      ? `Completed within its ${thresholdSeconds / 60}-minute readiness window.`
      : 'Not currently due; the most recent scheduled run completed successfully.',
    detail: runSummary,
    observedAt: lastRun,
    lastSuccessAt: lastRun,
    nextDueAt,
    now,
    provenance,
  });
}

function evaluateGmailIngestion({
  account,
  metrics,
  heartbeat,
  inbox,
  now = new Date(),
  maxAgeMinutes = 45,
}) {
  const authRecovery = {
    kind: 'manual',
    label: 'Run the OAuth-only probe. Re-authorize or rotate hermes/gmail/oauth only if that probe fails.',
  };
  const scheduleRecovery = {
    kind: 'manual',
    label: 'Inspect the owned Scheduler state and latest Lambda timeout logs; schedule activation or deployment requires operator approval.',
  };
  const investigateRecovery = {
    kind: 'manual',
    label: 'Inspect the Gmail poll heartbeat, Lambda logs, and retained failure queue before choosing a recovery action.',
  };
  const transientRetryRecovery = {
    kind: 'command',
    label: 'Retry one bounded Gmail poll from the verified scheduled poller, then refresh readiness.',
    command: 'Retry the configured Gmail incremental poll',
  };
  const hasServiceHeartbeat = Boolean(heartbeat && typeof heartbeat === 'object');
  const heartbeatObservedAt = hasServiceHeartbeat
    ? heartbeat.finishedAt || heartbeat.observedAt || null
    : null;
  const observedAt = heartbeatObservedAt
    || metrics?.latestAt
    || inbox?.lastUpdated
    || null;
  const observedAge = ageSeconds(observedAt, now);
  const heartbeatStatus = String(heartbeat?.status || '').toLowerCase();
  const heartbeatSucceeded = heartbeatStatus === 'success';
  const lastSuccessAt = heartbeat?.lastSuccessAt
    || (heartbeatSucceeded ? observedAt : null)
    || inbox?.lastSuccessAt
    || inbox?.lastUpdated
    || null;
  const nextDueAt = addMinutes(observedAt, 15);
  const heartbeatCounts = heartbeat?.counts && typeof heartbeat.counts === 'object'
    ? heartbeat.counts
    : {};
  const detail = hasServiceHeartbeat
    ? `Account: ${account || heartbeat?.accountEmail || 'unknown'}; heartbeat status: ${heartbeatStatus || 'unknown'}; messages: ${Number(heartbeatCounts.messages || 0)}; stored: ${Number(heartbeatCounts.stored || 0)}; errors: ${Number(heartbeatCounts.errors || 0)}.`
    : `Account: ${account || 'unknown'}; Lambda invocations: ${Number(metrics?.invocations || 0)}; errors: ${Number(metrics?.errors || 0)}; maximum duration: ${Number(metrics?.maxDurationMs || 0)}ms.`;
  const provenance = hasServiceHeartbeat ? {
    source: 'service-heartbeat-table',
    serviceId: heartbeat.serviceId || `gmail:${String(account || '').toLowerCase()}`,
    heartbeatSource: heartbeat.source || null,
    triggerSource: heartbeat.triggerSource || null,
    scheduleId: heartbeat.scheduleId || null,
    buildVersion: heartbeat.buildVersion || null,
    counts: heartbeatCounts,
  } : null;

  if (hasServiceHeartbeat) {
    const expectedScheduleId = process.env.HERMES_GMAIL_SCHEDULE_ID
      || GMAIL_SERVICE_DEFINITION?.aws?.scheduleId
      || 'market-dashboard-gmail-v2-every-15m';
    const schedulerVerified = heartbeat.source === 'aws-lambda'
      && heartbeat.triggerSource === 'aws-scheduler'
      && heartbeat.scheduled === true
      && heartbeat.scheduleId === expectedScheduleId;
    if (!schedulerVerified) {
      return makeCheck({
        id: 'gmail.ingestion',
        label: 'Gmail authentication and ingestion',
        status: 'fail',
        blocking: true,
        summary: 'The latest Gmail heartbeat did not prove invocation by the owned AWS schedule.',
        errorCode: 'GMAIL_SCHEDULER_PROVENANCE_INVALID',
        detail: `Expected ${expectedScheduleId}; received ${heartbeat.scheduleId || 'no schedule ID'} from ${heartbeat.triggerSource || 'unknown trigger'}.`,
        observedAt,
        lastSuccessAt,
        nextDueAt,
        now,
        impact: 'A manual poll cannot prove Gmail ingestion remains scheduled.',
        recovery: scheduleRecovery,
        provenance,
      });
    }
    if (exceedsFutureClockSkew(heartbeatObservedAt, now)) {
      return makeCheck({
        id: 'gmail.ingestion',
        label: 'Gmail authentication and ingestion',
        status: 'fail',
        blocking: true,
        summary: 'The latest Gmail heartbeat is more than 30 seconds ahead of the dashboard clock.',
        errorCode: 'GMAIL_HEARTBEAT_FUTURE_TIMESTAMP',
        detail: `Received ${heartbeatObservedAt}; future clock skew beyond 30 seconds is not accepted as current telemetry.`,
        observedAt,
        lastSuccessAt: inbox?.lastSuccessAt || null,
        nextDueAt: null,
        now,
        impact: 'Future-dated telemetry cannot prove that the scheduled poller is currently healthy.',
        recovery: investigateRecovery,
        provenance,
      });
    }
    const heartbeatErrorCode = String(heartbeat.errorCode || '').toUpperCase();
    const authFailure = heartbeatStatus === 'auth_required'
      || heartbeatErrorCode === 'GMAIL_AUTH_REQUIRED'
      || heartbeatErrorCode === 'GMAIL_OAUTH_CLIENT_DISABLED';
    if (authFailure) {
      return makeCheck({
        id: 'gmail.ingestion',
        label: 'Gmail authentication and ingestion',
        status: 'fail',
        blocking: true,
        summary: 'Gmail OAuth authorization requires attention.',
        errorCode: heartbeatErrorCode || 'GMAIL_AUTH_REQUIRED',
        detail: heartbeat.detail || detail,
        observedAt,
        lastSuccessAt,
        nextDueAt,
        now,
        impact: 'Email-driven dashboard data cannot update until Gmail authorization is restored.',
        recovery: authRecovery,
        provenance,
      });
    }

    const timeoutFailure = heartbeatStatus === 'timeout'
      || heartbeatErrorCode === 'GMAIL_INVOCATION_TIMEOUT'
      || heartbeatErrorCode === 'GMAIL_SHUTDOWN_MARGIN_REACHED';
    if (timeoutFailure) {
      return makeCheck({
        id: 'gmail.ingestion',
        label: 'Gmail authentication and ingestion',
        status: 'fail',
        blocking: true,
        summary: 'The scheduled Gmail invocation exhausted its bounded processing window.',
        errorCode: 'GMAIL_INVOCATION_TIMEOUT',
        detail: heartbeat.detail || detail,
        observedAt,
        lastSuccessAt,
        nextDueAt,
        now,
        impact: 'The cursor and message checkpoints require inspection before another poll is attempted.',
        recovery: investigateRecovery,
        provenance,
      });
    }

    if (heartbeatErrorCode === 'GMAIL_HEARTBEAT_WRITE_FAILED') {
      return makeCheck({
        id: 'gmail.ingestion',
        label: 'Gmail authentication and ingestion',
        status: 'fail',
        blocking: true,
        summary: 'The poller could not persist its authoritative service heartbeat.',
        errorCode: 'GMAIL_HEARTBEAT_WRITE_FAILED',
        detail: heartbeat.detail || detail,
        observedAt,
        lastSuccessAt,
        nextDueAt,
        now,
        impact: 'Ingestion health cannot be proven even if message processing occurred.',
        recovery: investigateRecovery,
        provenance,
      });
    }

    if (heartbeatErrorCode === 'GMAIL_BACKLOG_STALLED') {
      return makeCheck({
        id: 'gmail.ingestion',
        label: 'Gmail authentication and ingestion',
        status: 'fail',
        blocking: true,
        summary: 'The Gmail backlog is no longer making checkpointed progress.',
        errorCode: 'GMAIL_BACKLOG_STALLED',
        detail: heartbeat.detail || detail,
        observedAt,
        lastSuccessAt,
        nextDueAt,
        now,
        impact: 'Queued email products will remain delayed until the stalled record is isolated.',
        recovery: investigateRecovery,
        provenance,
      });
    }

    if (heartbeatStatus === 'warning') {
      return makeCheck({
        id: 'gmail.ingestion',
        label: 'Gmail authentication and ingestion',
        status: 'warn',
        blocking: true,
        summary: 'Gmail polling is current, but one or more immutable artifacts require recovery.',
        errorCode: heartbeatErrorCode || 'GMAIL_QUARANTINED_ARTIFACTS_PENDING',
        detail: heartbeat.detail || detail,
        observedAt,
        lastSuccessAt,
        nextDueAt,
        now,
        impact: 'Unaffected email products continue ingesting; quarantined products remain unavailable.',
        recovery: investigateRecovery,
        provenance,
      });
    }

    if (heartbeatStatus === 'error' || heartbeatStatus === 'failed') {
      const messages = Number(heartbeatCounts.messages || 0);
      const errors = Number(heartbeatCounts.errors || 0);
      const partial = errors > 0 && (errors < messages || Number(heartbeatCounts.stored || 0) > 0);
      const retryable = new Set([
        'GMAIL_PROVIDER_UNAVAILABLE',
        'GMAIL_RATE_LIMITED',
        'GMAIL_TRANSIENT_ERROR',
      ]).has(heartbeatErrorCode);
      return makeCheck({
        id: 'gmail.ingestion',
        label: 'Gmail authentication and ingestion',
        status: partial ? 'warn' : 'fail',
        blocking: true,
        summary: partial
          ? `${errors} of ${messages} message(s) failed during the latest Gmail poll.`
          : 'The latest Gmail poll failed.',
        errorCode: heartbeatErrorCode || 'GMAIL_INGESTION_FAILED',
        detail: heartbeat.detail || detail,
        observedAt,
        lastSuccessAt,
        nextDueAt,
        now,
        impact: partial
          ? 'Some email updates may be delayed or missing.'
          : 'The Gmail ingestion Lambda is not completing successfully.',
        recovery: retryable ? transientRetryRecovery : investigateRecovery,
        provenance,
      });
    }

    if (observedAge == null || observedAge > maxAgeMinutes * 60) {
      return makeCheck({
        id: 'gmail.ingestion',
        label: 'Gmail authentication and ingestion',
        status: 'fail',
        blocking: true,
        summary: `Last Gmail service heartbeat is older than ${maxAgeMinutes} minutes.`,
        errorCode: 'GMAIL_POLL_STALE',
        detail,
        observedAt,
        lastSuccessAt,
        nextDueAt,
        now,
        impact: 'Email-driven dashboard data is not being refreshed.',
        recovery: scheduleRecovery,
        provenance,
      });
    }

    if (heartbeatStatus === 'in_progress') {
      return makeCheck({
        id: 'gmail.ingestion',
        label: 'Gmail authentication and ingestion',
        status: 'warn',
        blocking: true,
        summary: 'The scheduled Gmail poll checkpointed a bounded batch and has more work queued.',
        errorCode: heartbeatErrorCode || 'GMAIL_BACKLOG_IN_PROGRESS',
        detail,
        observedAt,
        lastSuccessAt,
        nextDueAt,
        now,
        impact: 'Email-driven products may lag while the retained backlog drains.',
        recovery: investigateRecovery,
        provenance,
      });
    }

    if (!heartbeatSucceeded) {
      return makeCheck({
        id: 'gmail.ingestion',
        label: 'Gmail authentication and ingestion',
        status: 'fail',
        blocking: true,
        summary: `The latest Gmail heartbeat has unsupported status ${heartbeatStatus || 'unknown'}.`,
        errorCode: 'GMAIL_HEARTBEAT_INVALID',
        detail,
        observedAt,
        lastSuccessAt,
        nextDueAt,
        now,
        impact: 'Gmail ingestion cannot be assumed healthy.',
        recovery: investigateRecovery,
        provenance,
      });
    }

    if (heartbeat.buildVersion !== EXPECTED_CLOUD_BUILD_VERSION) {
      return makeCheck({
        id: 'gmail.ingestion',
        label: 'Gmail authentication and ingestion',
        status: 'fail',
        blocking: true,
        summary: 'The Gmail heartbeat came from an unexpected code version.',
        errorCode: 'GMAIL_BUILD_VERSION_MISMATCH',
        detail: `Expected ${EXPECTED_CLOUD_BUILD_VERSION}; received ${heartbeat.buildVersion || 'missing'}.`,
        observedAt,
        lastSuccessAt,
        nextDueAt,
        now,
        impact: 'The schedule may still be invoking an old or unmanaged ingestion package.',
        recovery: investigateRecovery,
        provenance,
      });
    }

    return makeCheck({
      id: 'gmail.ingestion',
      label: 'Gmail authentication and ingestion',
      status: 'pass',
      blocking: true,
      summary: `Polling ${account || 'the configured Gmail account'} successfully.`,
      detail,
      observedAt,
      lastSuccessAt: observedAt,
      nextDueAt,
      now,
      provenance,
    });
  }

  const maxDurationMs = Number(metrics?.maxDurationMs || metrics?.durationMaximum || 0);
  const timeoutObserved = metrics?.timedOut === true
    || (Number(metrics?.errors || 0) > 0 && maxDurationMs >= 295_000);
  const noScheduledInvocation = !metrics?.error && Number(metrics?.invocations || 0) === 0;
  const inboxErrorCode = String(inbox?.errorCode || '').toUpperCase();
  const inboxAuthFailure = ['GMAIL_AUTH_REQUIRED', 'GMAIL_OAUTH_CLIENT_DISABLED']
    .includes(inboxErrorCode);
  const inboxHeartbeatFailure = inboxErrorCode === 'GMAIL_HEARTBEAT_WRITE_FAILED';
  const inboxBacklogStalled = [
    'GMAIL_BACKLOG_STALLED',
    'GMAIL_POISON_MESSAGES_QUARANTINED',
  ].includes(inboxErrorCode);
  const missingErrorCode = timeoutObserved
    ? 'GMAIL_INVOCATION_TIMEOUT'
    : (inboxAuthFailure
      ? inboxErrorCode
      : (inboxHeartbeatFailure || inboxBacklogStalled
        ? inboxErrorCode
        : (noScheduledInvocation ? 'GMAIL_SCHEDULE_MISSING' : 'GMAIL_HEARTBEAT_MISSING')));
  return makeCheck({
    id: 'gmail.ingestion',
    label: 'Gmail authentication and ingestion',
    status: 'fail',
    blocking: true,
    summary: timeoutObserved
      ? 'The scheduled Gmail Lambda is reaching its timeout without writing a typed heartbeat.'
      : (inboxAuthFailure
        ? 'The OAuth-only Gmail state indicates authorization is required, but no scheduled heartbeat is healthy.'
        : (inboxHeartbeatFailure
          ? 'The Gmail poller reported that it could not persist its typed heartbeat.'
          : (inboxBacklogStalled
            ? 'The retained Gmail backlog requires operator inspection before another poll.'
      : (noScheduledInvocation
        ? 'No scheduled Gmail invocation or typed heartbeat was observed in the readiness window.'
        : 'No typed Gmail service heartbeat was available; Lambda metrics alone cannot prove ingestion health.')))),
    errorCode: missingErrorCode,
    detail,
    observedAt,
    lastSuccessAt,
    nextDueAt,
    now,
    impact: timeoutObserved
      ? 'The poller may have advanced partially; inspect durable checkpoints and retained failures before retrying.'
      : 'Email-driven dashboard data is not trusted until the owned poller writes a fresh typed heartbeat.',
    recovery: inboxAuthFailure
      ? authRecovery
      : (timeoutObserved || inboxHeartbeatFailure || inboxBacklogStalled
        ? investigateRecovery
        : scheduleRecovery),
  });
}

module.exports = {
  SERVICE_MANIFEST,
  VALID_CHECK_STATUSES,
  VALID_CAPABILITY_STATUSES,
  ageSeconds,
  buildCapabilities,
  buildRootCauses,
  makeCheck,
  buildSystemReadiness,
  evaluateHermesWorker,
  evaluateGmailIngestion,
};
