const SERVICE_MANIFEST = require('../../ops/services.json');
const {
  isAuthoritativeIbkrCpiContract,
} = require('./authoritativeIbkrCpiContract.cjs');

const VALID_CHECK_STATUSES = new Set(['pass', 'warn', 'fail']);
const VALID_CAPABILITY_STATUSES = new Set(['ready', 'degraded', 'blocked']);
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
  return Math.max(0, Math.floor((current.getTime() - observed.getTime()) / 1000));
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
      const key = root.errorCode || root.id;
      const existing = roots.get(key);
      const capabilityIds = uniqueStrings([
        ...(existing?.capabilityIds || []),
        ...root.capabilityIds,
        ...affected.capabilityIds,
      ]);
      const affectedCheckIds = uniqueStrings([...(existing?.affectedCheckIds || []), affected.id]);
      if (existing) {
        roots.set(key, {
          ...existing,
          status: statusRank(root.status) > statusRank(existing.status) ? root.status : existing.status,
          capabilityIds,
          affectedCheckIds,
        });
      } else {
        roots.set(key, {
          id: key,
          errorCode: root.errorCode,
          checkId: root.id,
          label: root.label,
          status: root.status,
          summary: root.summary,
          owner: root.owner,
          capabilityIds,
          affectedCheckIds,
          recovery: root.recovery,
        });
      }
    }
  }

  return [...roots.values()].sort((left, right) => (
    statusRank(right.status) - statusRank(left.status)
    || left.label.localeCompare(right.label)
  ));
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
  const heartbeatStatusValid = ['success', 'succeeded', 'healthy', 'warning'].includes(runStatus);
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
    label: 'Re-authorize the configured Gmail account in secret hermes/gmail/oauth, then invoke market-dashboard-gmail-ingestor-v2 once.',
  };
  const retryRecovery = {
    kind: 'command',
    label: 'Retry the configured Gmail incremental poll, then refresh readiness.',
    command: 'Retry the configured Gmail incremental poll',
  };
  const hasServiceHeartbeat = Boolean(heartbeat && typeof heartbeat === 'object');
  const observedAt = (hasServiceHeartbeat ? heartbeat.finishedAt || heartbeat.observedAt : null)
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
    : `Account: ${account || 'unknown'}; Lambda invocations: ${Number(metrics?.invocations || 0)}; errors: ${Number(metrics?.errors || 0)}.`;
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
        recovery: retryRecovery,
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

    if (heartbeatStatus === 'error' || heartbeatStatus === 'failed') {
      const messages = Number(heartbeatCounts.messages || 0);
      const errors = Number(heartbeatCounts.errors || 0);
      const partial = errors > 0 && (errors < messages || Number(heartbeatCounts.stored || 0) > 0);
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
        recovery: partial ? retryRecovery : authRecovery,
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
        recovery: retryRecovery,
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
        recovery: authRecovery,
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
        recovery: authRecovery,
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

  return makeCheck({
    id: 'gmail.ingestion',
    label: 'Gmail authentication and ingestion',
    status: 'fail',
    blocking: true,
    summary: 'No typed Gmail service heartbeat was available; Lambda metrics alone cannot prove ingestion health.',
    errorCode: 'GMAIL_HEARTBEAT_MISSING',
    detail,
    observedAt,
    lastSuccessAt,
    nextDueAt,
    now,
    impact: 'Email-driven dashboard data is not trusted until the owned poller writes a fresh typed heartbeat.',
    recovery: retryRecovery,
  });
}

function parseCompactDate(value) {
  const match = String(value || '').match(/^(\d{4})(\d{2})(\d{2})/);
  if (!match) return null;
  return new Date(`${match[1]}-${match[2]}-${match[3]}T23:59:59Z`);
}

function eventHasNativeLiveQuote(event, now, maxQuoteAgeSeconds) {
  const flags = new Set((event?.data_quality_flags || []).map((flag) => String(flag).toLowerCase()));
  const disallowed = [
    'mock',
    'seed',
    'portfolio_seed',
    'portfolio_discovered',
    'cached',
    'stale',
    'stale_quote',
    'fallback',
    'no_live_quote',
    'expired_contract',
    'wrong_release',
  ];
  if (disallowed.some((flag) => flags.has(flag))) return false;
  if (!['open', 'active'].includes(String(event?.status || 'open').toLowerCase())) return false;
  const isFinitePrice = (value) => value !== null && value !== undefined && value !== ''
    && Number.isFinite(Number(value));
  const hasTwoSidedQuote = (
    isFinitePrice(event.yes_bid) && isFinitePrice(event.yes_ask)
  ) || (
    isFinitePrice(event.no_bid) && isFinitePrice(event.no_ask)
  );
  if (!hasTwoSidedQuote) return false;
  const quoteAge = ageSeconds(event.updated_at, now);
  if (quoteAge == null || quoteAge > maxQuoteAgeSeconds) return false;
  const expiration = parseCompactDate(event.expiration_time);
  if (expiration && expiration.getTime() < toDate(now).getTime()) return false;
  return true;
}

function eventMatchesCurrentRelease(event, payload) {
  const releaseKey = payload?.releaseKey || payload?.readiness?.releaseKey || null;
  if (!releaseKey) return true;
  return String(event?.releaseKey || event?.release_key || '') === String(releaseKey);
}

function eventHasDisplayLiveQuote(event, now, maxQuoteAgeSeconds, releaseKey = null) {
  const venue = String(event?.venue || '').toUpperCase();
  const source = String(event?.source_api || '').toLowerCase();
  if (source === 'kalshi_trade_api_v2' && venue === 'KALSHI') {
    return eventHasNativeLiveQuote(event, now, maxQuoteAgeSeconds);
  }
  return isAuthoritativeIbkrCpiContract(event, {
    now,
    maxAgeSeconds: maxQuoteAgeSeconds,
    releaseKey,
  });
}

function eventHasExecutableLiveQuote(event, now, maxQuoteAgeSeconds, releaseKey = null) {
  return isAuthoritativeIbkrCpiContract(event, {
    now,
    maxAgeSeconds: maxQuoteAgeSeconds,
    releaseKey,
  });
}

function predictionProviderError(payload, providerName, readinessKey) {
  const provider = payload?.providers?.[providerName] || {};
  const code = provider.errorCode
    || payload?.readiness?.[readinessKey]?.errorCode
    || payload?.errorCode
    || null;
  const message = [provider.message, payload?.readiness?.[readinessKey]?.reason, payload?.error]
    .filter(Boolean)
    .join(' ');
  if (/access.?denied|not authorized/i.test(`${code || ''} ${message}`)) {
    return 'PREDICTION_CATALOG_ACCESS_DENIED';
  }
  return code;
}

function evaluatePredictionMarketDisplay({ payload, now = new Date(), maxQuoteAgeSeconds = 120 }) {
  const events = Array.isArray(payload?.providerEvents)
    ? payload.providerEvents
    : Array.isArray(payload?.events) ? payload.events : [];
  const live = events.filter((event) => (
    eventMatchesCurrentRelease(event, payload)
    && eventHasDisplayLiveQuote(
      event,
      now,
      maxQuoteAgeSeconds,
      payload?.releaseKey || payload?.readiness?.releaseKey || null,
    )
  ));
  const venues = [...new Set(live.map((event) => event.venue).filter(Boolean))];
  const detail = `${events.length} current-release event(s), ${live.length} native live quote(s)${venues.length ? ` from ${venues.join(', ')}` : ''}.`;

  if (live.length === 0) {
    const providerErrorCode = predictionProviderError(payload, 'kalshi', 'display');
    const accessDenied = providerErrorCode === 'PREDICTION_CATALOG_ACCESS_DENIED';
    return makeCheck({
      id: 'prediction.display',
      label: 'Prediction-market live display',
      status: 'fail',
      blocking: false,
      summary: accessDenied
        ? 'The current prediction catalog cannot be read or promoted with the configured AWS identity.'
        : 'No current-release prediction contract has a fresh native venue quote.',
      errorCode: providerErrorCode || 'NO_CURRENT_NATIVE_LIVE_QUOTE',
      detail,
      observedAt: payload?.fetched_at,
      now,
      impact: 'The dashboard cannot display a verified live CPI prediction ladder.',
      recovery: accessDenied
        ? {
          kind: 'manual',
          label: 'Grant the dashboard API its least-privilege PredictionMarketCatalogV2 policy, then reconcile.',
        }
        : {
          kind: 'manual',
          label: 'Verify the current CPI release and Kalshi venue response, then refresh.',
        },
    });
  }

  return makeCheck({
    id: 'prediction.display',
    label: 'Prediction-market live display',
    status: 'pass',
    blocking: false,
    summary: `${live.length} current-release contract(s) have fresh native quotes${venues.length ? ` from ${venues.join(', ')}` : ''}.`,
    detail,
    observedAt: payload?.fetched_at,
    now,
  });
}

function evaluatePredictionMarketExecution({ payload, now = new Date(), maxQuoteAgeSeconds = 120 }) {
  const events = Array.isArray(payload?.providerEvents)
    ? payload.providerEvents
    : Array.isArray(payload?.events) ? payload.events : [];
  const executable = events.filter((event) => (
    eventMatchesCurrentRelease(event, payload)
    && eventHasExecutableLiveQuote(
      event,
      now,
      maxQuoteAgeSeconds,
      payload?.releaseKey || payload?.readiness?.releaseKey || null,
    )
  ));
  const discovery = payload?.providers?.ibkr?.cpi_discovery || payload?.cpi_discovery || {};
  const providerErrorCode = predictionProviderError(payload, 'ibkr', 'ibkrExecution');
  const missing = discovery.missingStrikes || [];
  const reportMonth = discovery.reportMonth || discovery.forecastMonth || null;
  const recovery = {
    kind: 'command',
    label: 'Roll the CPI catalog to the current release, then rediscover and verify executable IBKR quotes.',
    command: 'npm run ibkr-sidecar:discover',
  };
  const detail = `${events.length} event(s), ${executable.length} executable live quote(s)${reportMonth ? `, catalog ${reportMonth}` : ''}${missing.length ? `, missing strikes ${missing.join(', ')}` : ''}.`;

  if (executable.length === 0) {
    const accessDenied = providerErrorCode === 'PREDICTION_CATALOG_ACCESS_DENIED';
    return makeCheck({
      id: 'prediction.ibkrExecution',
      label: 'Prediction-market IBKR execution catalog',
      status: 'fail',
      blocking: true,
      summary: providerErrorCode === 'UNSUPPORTED_OR_NOT_ENTITLED'
        ? 'IBKR returned no supported/entitled current-release prediction product.'
        : (accessDenied
          ? 'The current IBKR prediction catalog cannot be read with the configured AWS identity.'
          : 'No current, executable IBKR prediction contract has a verified live two-sided quote.'),
      detail,
      observedAt: payload?.fetched_at,
      now,
      errorCode: providerErrorCode || 'NO_CURRENT_EXECUTABLE_IBKR_CONTRACT',
      impact: 'Prediction-market order entry through IBKR is unavailable; display availability is evaluated separately.',
      recovery: accessDenied
        ? {
          kind: 'manual',
          label: 'Grant the dashboard API its least-privilege PredictionMarketCatalogV2 policy, then reconcile.',
        }
        : recovery,
    });
  }

  if (missing.length > 0 || payload?.providers?.ibkr?.status === 'error') {
    return makeCheck({
      id: 'prediction.ibkrExecution',
      label: 'Prediction-market IBKR execution catalog',
      status: 'warn',
      blocking: true,
      summary: 'At least one executable contract is live, but catalog discovery is incomplete.',
      detail,
      observedAt: payload?.fetched_at,
      now,
      errorCode: providerErrorCode,
      impact: 'Some target strikes may be absent from the prediction ladder.',
      recovery,
    });
  }

  return makeCheck({
    id: 'prediction.ibkrExecution',
    label: 'Prediction-market IBKR execution catalog',
    status: 'pass',
    blocking: true,
    summary: `${executable.length} executable IBKR contract(s) have verified live quotes.`,
    detail,
    observedAt: payload?.fetched_at,
    now,
  });
}

// Backward-compatible name for callers that historically treated prediction
// readiness as IBKR execution readiness.
function evaluatePredictionMarkets(options) {
  return evaluatePredictionMarketExecution(options);
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
  evaluatePredictionMarketDisplay,
  evaluatePredictionMarketExecution,
  evaluatePredictionMarkets,
  eventHasDisplayLiveQuote,
  eventHasExecutableLiveQuote,
  eventHasNativeLiveQuote,
};
