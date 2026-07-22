const HERMES_AGENT_RUNS_TABLE = process.env.HERMES_AGENT_RUNS_TABLE || 'HermesAgentRuns';
const HERMES_ALERTS_TABLE = process.env.HERMES_ALERTS_TABLE || 'HermesAlerts';
const HERMES_ALERT_EMAIL_TO = process.env.HERMES_ALERT_EMAIL_TO || process.env.ALERT_EMAIL_TO || '';
const SERVICE_MANIFEST = require('../../ops/services.json');
const MANIFEST_SERVICES = new Map(
  (SERVICE_MANIFEST.services || []).map((service) => [String(service.id), service]),
);

function workerInfrastructure(key) {
  const service = MANIFEST_SERVICES.get(`hermes.${key}`) || {};
  return {
    cadence: service.cadenceMinutes ? `${service.cadenceMinutes} minutes` : 'not configured',
    cadenceMinutes: Number(service.cadenceMinutes) || null,
    readinessMaxAgeMinutes: Number(service.readinessMaxAgeMinutes) || null,
    scheduleWindow: service.scheduleWindow || null,
    defaultFunctionName: service.aws?.functionName || null,
    scheduleId: service.aws?.scheduleId || null,
    heartbeatServiceId: service.aws?.heartbeatServiceId || `hermes:${key}`,
  };
}

const WORKERS = [
  {
    key: 'quant-analyst',
    name: 'Quant Analyst',
    description: 'Monitors thresholds, outliers, Hedgeye freshness, and portfolio signals.',
    schedule: 'Every 5-15 minutes during market hours',
    ...workerInfrastructure('quant-analyst'),
    lambdaEnv: 'HERMES_QUANT_ANALYST_FUNCTION',
    triggerType: 'schedule',
  },
  {
    key: 'quant-developer',
    name: 'Quant Developer',
    description: 'Monitors dashboard, APIs, deployment freshness, and repo/site health.',
    schedule: 'Every 10-15 minutes',
    ...workerInfrastructure('quant-developer'),
    lambdaEnv: 'HERMES_QUANT_DEVELOPER_FUNCTION',
    triggerType: 'schedule',
  },
  {
    key: 'security',
    name: 'Security',
    description: 'Monitors auth/config drift, protections, and suspicious service failures.',
    schedule: 'Every 15-60 minutes',
    ...workerInfrastructure('security'),
    lambdaEnv: 'HERMES_SECURITY_FUNCTION',
    triggerType: 'schedule',
  },
];

const COMMANDS = [
  'status',
  'run analyst now',
  'run dev now',
  'run security now',
  'summarize today',
  'what changed',
  'morning setup',
  'close review',
  'snooze alerts',
];

const ephemeralRuns = new Map();
const ephemeralAlerts = new Map();

function nowIso() {
  return new Date().toISOString();
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function toWorkerMap() {
  return WORKERS.reduce((acc, worker) => {
    acc[worker.key] = worker;
    return acc;
  }, {});
}

function getWorkerDefinition(workerKey) {
  return toWorkerMap()[workerKey] || null;
}

function listWorkerDefinitions() {
  return WORKERS.map((worker) => ({
    ...worker,
    functionName: process.env[worker.lambdaEnv] || worker.defaultFunctionName || null,
  }));
}

function normalizeWorkerStatus(status) {
  switch (status) {
    case 'success':
    case 'healthy':
      return 'succeeded';
    case 'error':
    case 'failed':
      return 'failed';
    case 'stale':
      return 'warning';
    case 'running':
    case 'warning':
    case 'idle':
    case 'succeeded':
      return status;
    default:
      return 'idle';
  }
}

function normalizeSeverity(severity) {
  switch (severity) {
    case 'critical':
    case 'warning':
    case 'info':
      return severity;
    default:
      return 'info';
  }
}

function buildRunRecord({
  worker,
  triggerType = 'manual',
  status = 'running',
  summary,
  severity = 'info',
  command = null,
  detailBucket = null,
  detailKey = null,
  detailLinks = [],
  metadata = {},
  startedAt = nowIso(),
  finishedAt = null,
  source = 'dashboard',
}) {
  return {
    worker,
    startedAt,
    finishedAt,
    status: normalizeWorkerStatus(status),
    summary,
    severity: normalizeSeverity(severity),
    triggerType,
    command,
    detailBucket,
    detailKey,
    detailLinks,
    metadata,
    source,
    runId: `${worker}#${startedAt}`,
    runDate: startedAt.slice(0, 10),
    updatedAt: nowIso(),
  };
}

function buildAlertRecord({
  worker,
  severity = 'warning',
  status = 'open',
  title,
  message,
  sourceRunId = null,
  channels = ['dashboard'],
  details = {},
  type = 'alert',
  dedupeKey = null,
  recommendedAction = null,
  priority = null,
}) {
  const createdAt = nowIso();
  const alertId = dedupeKey
    ? `${worker}#${type}#${dedupeKey}`
    : `${worker}#${createdAt}#${Math.random().toString(36).slice(2, 8)}`;
  return {
    alertId,
    worker,
    severity: normalizeSeverity(severity),
    status,
    type,
    dedupeKey,
    priority,
    title,
    message,
    recommendedAction,
    sourceRunId,
    channels,
    details,
    createdAt,
    updatedAt: createdAt,
  };
}

async function safeQueryLatestRun(dynamodb, workerKey) {
  try {
    const result = await dynamodb.query({
      TableName: HERMES_AGENT_RUNS_TABLE,
      KeyConditionExpression: '#worker = :worker',
      ExpressionAttributeNames: {
        '#worker': 'worker',
      },
      ExpressionAttributeValues: {
        ':worker': workerKey,
      },
      ScanIndexForward: false,
      Limit: 1,
    }).promise();
    return (result.Items || [])[0] || null;
  } catch (error) {
    if (error.code !== 'ResourceNotFoundException') {
      console.warn('[HermesDirector] Latest run query failed:', error.message);
    }
    const runs = ephemeralRuns.get(workerKey) || [];
    return runs.length > 0 ? runs[runs.length - 1] : null;
  }
}

async function safeQueryRunsForToday(dynamodb, workerKey) {
  try {
    const result = await dynamodb.query({
      TableName: HERMES_AGENT_RUNS_TABLE,
      KeyConditionExpression: '#worker = :worker AND begins_with(#startedAt, :today)',
      ExpressionAttributeNames: {
        '#worker': 'worker',
        '#startedAt': 'startedAt',
      },
      ExpressionAttributeValues: {
        ':worker': workerKey,
        ':today': todayKey(),
      },
      ScanIndexForward: false,
      Limit: 20,
    }).promise();
    return result.Items || [];
  } catch (error) {
    if (error.code !== 'ResourceNotFoundException') {
      console.warn('[HermesDirector] Today runs query failed:', error.message);
    }
    const runs = ephemeralRuns.get(workerKey) || [];
    return runs.filter((run) => String(run.startedAt || '').startsWith(todayKey())).slice().reverse();
  }
}

async function safeListAlerts(dynamodb) {
  try {
    const result = await dynamodb.scan({
      TableName: HERMES_ALERTS_TABLE,
      Limit: 100,
    }).promise();
    return (result.Items || []).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  } catch (error) {
    if (error.code !== 'ResourceNotFoundException') {
      console.warn('[HermesDirector] Alert scan failed:', error.message);
    }
    return Array.from(ephemeralAlerts.values()).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  }
}

async function persistRunRecord(dynamodb, runRecord) {
  try {
    await dynamodb.put({
      TableName: HERMES_AGENT_RUNS_TABLE,
      Item: runRecord,
    }).promise();
  } catch (error) {
    if (error.code !== 'ResourceNotFoundException') {
      console.warn('[HermesDirector] Persist run failed:', error.message);
    }
    const runs = ephemeralRuns.get(runRecord.worker) || [];
    runs.push(runRecord);
    runs.sort((a, b) => String(a.startedAt || '').localeCompare(String(b.startedAt || '')));
    ephemeralRuns.set(runRecord.worker, runs);
  }
  return runRecord;
}

async function persistAlertRecord(dynamodb, alertRecord) {
  try {
    await dynamodb.put({
      TableName: HERMES_ALERTS_TABLE,
      Item: alertRecord,
    }).promise();
  } catch (error) {
    if (error.code !== 'ResourceNotFoundException') {
      console.warn('[HermesDirector] Persist alert failed:', error.message);
    }
    ephemeralAlerts.set(alertRecord.alertId, alertRecord);
  }
  return alertRecord;
}

async function updateAlertRecord(dynamodb, alertId, updates) {
  const currentAlerts = await safeListAlerts(dynamodb);
  const existing = currentAlerts.find((alert) => alert.alertId === alertId);
  if (!existing) {
    return null;
  }

  const next = {
    ...existing,
    ...updates,
    updatedAt: nowIso(),
  };

  try {
    await dynamodb.put({
      TableName: HERMES_ALERTS_TABLE,
      Item: next,
    }).promise();
  } catch (error) {
    if (error.code !== 'ResourceNotFoundException') {
      console.warn('[HermesDirector] Update alert failed:', error.message);
    }
    ephemeralAlerts.set(alertId, next);
  }

  return next;
}

function unresolvedAlertCount(alerts) {
  return alerts.filter((alert) => alert.status !== 'resolved').length;
}

function workerFallback(workerKey, workflowSnapshot, alerts) {
  const unresolved = alerts.filter((alert) => alert.worker === workerKey && alert.status !== 'resolved');
  const workflow = workflowSnapshot || {};

  if (workerKey === 'quant-analyst') {
    const hedgeyeStatus = workflow.hedgeye?.status || 'unknown';
    const inboxStatus = workflow.hermesInbox?.status || 'unknown';
    const hasWarning = ['error', 'failed', 'stale', 'warning', 'missing'].includes(hedgeyeStatus)
      || ['error', 'stale', 'warning', 'missing'].includes(inboxStatus)
      || unresolved.some((alert) => alert.severity === 'critical');
    return {
      status: hasWarning ? 'warning' : 'idle',
      summary: hasWarning
        ? 'Watching Hedgeye freshness and Hermes inbox; one or more analyst signals need review.'
        : 'Ready to monitor portfolio thresholds, outliers, and Hedgeye updates.',
      severity: hasWarning ? 'warning' : 'info',
    };
  }

  if (workerKey === 'quant-developer') {
    const unhealthyWorkflows = ['hedgeye', 'csvUpload', 'hermesInbox']
      .map((key) => workflow[key]?.status)
      .filter((status) => ['error', 'failed', 'stale'].includes(status));
    return {
      status: unhealthyWorkflows.length > 0 ? 'warning' : 'idle',
      summary: unhealthyWorkflows.length > 0
        ? 'Monitoring dashboard/API regressions and workflow drift; one or more backend services are degraded.'
        : 'Ready to monitor dashboard, API, and deployment health.',
      severity: unhealthyWorkflows.length > 0 ? 'warning' : 'info',
    };
  }

  const hasCritical = unresolved.some((alert) => alert.severity === 'critical');
  const hasAwsCreds = Boolean(process.env.AWS_REGION);
  return {
    status: hasCritical ? 'warning' : 'idle',
    summary: hasAwsCreds
      ? 'Ready to monitor auth/config drift and suspicious failures.'
      : 'Security checks are waiting for AWS runtime configuration.',
    severity: hasCritical ? 'critical' : (hasAwsCreds ? 'info' : 'warning'),
  };
}

function buildWorkerSnapshot(workerDefinition, latestRun, workflowSnapshot, alerts) {
  const fallback = workerFallback(workerDefinition.key, workflowSnapshot, alerts);
  const source = latestRun || {};
  const status = normalizeWorkerStatus(source.status || fallback.status);
  return {
    key: workerDefinition.key,
    name: workerDefinition.name,
    description: workerDefinition.description,
    schedule: workerDefinition.schedule,
    cadence: workerDefinition.cadence,
    functionName: process.env[workerDefinition.lambdaEnv] || workerDefinition.defaultFunctionName || null,
    status,
    severity: normalizeSeverity(source.severity || fallback.severity),
    summary: source.summary || fallback.summary,
    lastRun: source.startedAt || null,
    finishedAt: source.finishedAt || null,
    triggerType: source.triggerType || workerDefinition.triggerType,
    openAlertCount: alerts.filter((alert) => alert.worker === workerDefinition.key && alert.status !== 'resolved').length,
  };
}

function buildDirectorStatus(workers, alerts) {
  const hasFailed = workers.some((worker) => worker.status === 'failed');
  const hasWarning = workers.some((worker) => worker.status === 'warning');
  const hasRunning = workers.some((worker) => worker.status === 'running');
  const unresolved = unresolvedAlertCount(alerts);

  let status = 'idle';
  if (hasFailed) status = 'failed';
  else if (hasWarning || unresolved > 0) status = 'warning';
  else if (hasRunning) status = 'running';
  else if (workers.some((worker) => worker.lastRun)) status = 'succeeded';

  let summary = 'Background workers are idle and ready.';
  if (status === 'failed') {
    summary = 'At least one worker failed and needs attention.';
  } else if (status === 'warning') {
    summary = unresolved > 0
      ? `${unresolved} unresolved Hermes alert${unresolved === 1 ? '' : 's'} need review.`
      : 'One or more workers are degraded or stale.';
  } else if (status === 'running') {
    summary = 'A worker run is in progress.';
  } else if (status === 'succeeded') {
    summary = 'Workers have recent successful runs and no open alerts.';
  }

  return {
    key: 'the-managing-director',
    name: 'The Managing Director',
    status,
    summary,
    lastUpdated: nowIso(),
    openAlertCount: unresolved,
    commandVocabulary: COMMANDS,
  };
}

function summarizeToday(runs, alerts) {
  if (runs.length === 0) {
    return 'No worker runs have been recorded today yet.';
  }
  const completed = runs.filter((run) => ['succeeded', 'warning', 'failed'].includes(run.status)).length;
  const unresolved = unresolvedAlertCount(alerts);
  return `${completed} worker run${completed === 1 ? '' : 's'} recorded today. ${unresolved} unresolved alert${unresolved === 1 ? '' : 's'} currently open.`;
}

function summarizeChanges(runs, alerts) {
  const recentAlerts = alerts.slice(0, 3);
  if (recentAlerts.length === 0 && runs.length === 0) {
    return 'No meaningful worker changes have been recorded yet.';
  }
  if (recentAlerts.length > 0) {
    return recentAlerts.map((alert) => `${alert.worker}: ${alert.title}`).join(' • ');
  }
  return runs.slice(0, 3).map((run) => `${run.worker}: ${run.summary}`).join(' • ');
}

function buildMorningSetup(workers, alerts) {
  const open = unresolvedAlertCount(alerts);
  const analyst = workers.find((worker) => worker.key === 'quant-analyst');
  const developer = workers.find((worker) => worker.key === 'quant-developer');
  const security = workers.find((worker) => worker.key === 'security');
  return [
    `Morning setup: ${open} open alert${open === 1 ? '' : 's'}.`,
    `Analyst: ${analyst?.summary || 'waiting for first run'}`,
    `Data trust: ${developer?.status || 'idle'}.`,
    `Security: ${security?.status || 'idle'}.`,
  ].join(' ');
}

function buildCloseReview(runs, alerts) {
  const completed = runs.filter((run) => ['succeeded', 'warning', 'failed'].includes(run.status)).length;
  const critical = alerts.filter((alert) => alert.severity === 'critical' && alert.status !== 'resolved').length;
  const backlog = alerts.filter((alert) => alert.type === 'backlog' && alert.status !== 'resolved').length;
  return `Close review: ${completed} worker run${completed === 1 ? '' : 's'} today, ${critical} critical alert${critical === 1 ? '' : 's'}, ${backlog} open backlog item${backlog === 1 ? '' : 's'}.`;
}

async function dispatchAlertEmail(ses, alertRecord) {
  if (!HERMES_ALERT_EMAIL_TO || !ses || !alertRecord.channels.includes('email')) {
    return { delivered: false, reason: 'email_not_configured' };
  }

  const sourceEmail = process.env.HERMES_ALERT_EMAIL_FROM || HERMES_ALERT_EMAIL_TO;
  try {
    await ses.sendEmail({
      Source: sourceEmail,
      Destination: {
        ToAddresses: [HERMES_ALERT_EMAIL_TO],
      },
      Message: {
        Subject: {
          Data: `[Hermes] ${alertRecord.title}`,
        },
        Body: {
          Text: {
            Data: `${alertRecord.message}\n\nWorker: ${alertRecord.worker}\nSeverity: ${alertRecord.severity}\nCreated: ${alertRecord.createdAt}`,
          },
        },
      },
    }).promise();
    return { delivered: true };
  } catch (error) {
    console.warn('[HermesDirector] SES delivery failed:', error.message);
    return { delivered: false, reason: error.message };
  }
}

async function getDirectorSnapshot({ dynamodb, workflowSnapshot = {} }) {
  const alerts = await safeListAlerts(dynamodb);
  const unresolvedAlerts = alerts.filter((alert) => alert.status !== 'resolved');
  const workers = [];
  const latestRuns = {};
  const todaysRuns = [];

  for (const worker of WORKERS) {
    const latestRun = await safeQueryLatestRun(dynamodb, worker.key);
    latestRuns[worker.key] = latestRun;
    const todaysWorkerRuns = await safeQueryRunsForToday(dynamodb, worker.key);
    todaysRuns.push(...todaysWorkerRuns);
    workers.push(buildWorkerSnapshot(worker, latestRun, workflowSnapshot, unresolvedAlerts));
  }

  todaysRuns.sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')));
  const director = buildDirectorStatus(workers, unresolvedAlerts);

  return {
    director: {
      ...director,
      latestSummary: summarizeToday(todaysRuns, unresolvedAlerts),
      whatChanged: summarizeChanges(todaysRuns, unresolvedAlerts),
    },
    workers,
    alerts: unresolvedAlerts.slice(0, 20),
    recentRuns: todaysRuns.slice(0, 20),
    tables: {
      runs: HERMES_AGENT_RUNS_TABLE,
      alerts: HERMES_ALERTS_TABLE,
    },
  };
}

function parseCommand(command) {
  const normalized = String(command || '').trim().toLowerCase();
  if (normalized === 'status') return { action: 'status' };
  if (normalized === 'summarize today') return { action: 'summarize_today' };
  if (normalized === 'what changed') return { action: 'what_changed' };
  if (normalized === 'morning setup') return { action: 'morning_setup' };
  if (normalized === 'close review') return { action: 'close_review' };
  if (normalized === 'snooze alerts') return { action: 'snooze_alerts' };
  if (normalized === 'run analyst now') return { action: 'run_worker', worker: 'quant-analyst' };
  if (normalized === 'run dev now') return { action: 'run_worker', worker: 'quant-developer' };
  if (normalized === 'run security now') return { action: 'run_worker', worker: 'security' };
  return null;
}

async function invokeWorkerLambda(lambdaClient, workerKey, payload) {
  const worker = getWorkerDefinition(workerKey);
  const functionName = process.env[worker.lambdaEnv] || worker.defaultFunctionName;
  if (!functionName || !lambdaClient) {
    return { invoked: false, reason: 'function_not_configured' };
  }

  try {
    await lambdaClient.invoke({
      FunctionName: functionName,
      InvocationType: 'Event',
      Payload: JSON.stringify(payload),
    }).promise();
    return { invoked: true, functionName };
  } catch (error) {
    console.warn('[HermesDirector] Lambda invoke failed:', error.message);
    return { invoked: false, reason: error.message, functionName };
  }
}

async function executeDirectorCommand({
  dynamodb,
  lambdaClient,
  ses,
  command,
  workflowSnapshot = {},
  payload = {},
}) {
  const parsed = parseCommand(command);
  if (!parsed) {
    throw new Error(`Unsupported command: ${command}`);
  }

  if (parsed.action === 'status') {
    return {
      command,
      message: 'Hermes status refreshed.',
      snapshot: await getDirectorSnapshot({ dynamodb, workflowSnapshot }),
    };
  }

  if (parsed.action === 'summarize_today') {
    const snapshot = await getDirectorSnapshot({ dynamodb, workflowSnapshot });
    return {
      command,
      message: snapshot.director.latestSummary,
      snapshot,
    };
  }

  if (parsed.action === 'what_changed') {
    const snapshot = await getDirectorSnapshot({ dynamodb, workflowSnapshot });
    return {
      command,
      message: snapshot.director.whatChanged,
      snapshot,
    };
  }

  if (parsed.action === 'morning_setup') {
    const snapshot = await getDirectorSnapshot({ dynamodb, workflowSnapshot });
    return {
      command,
      message: buildMorningSetup(snapshot.workers, snapshot.alerts),
      snapshot,
    };
  }

  if (parsed.action === 'close_review') {
    const snapshot = await getDirectorSnapshot({ dynamodb, workflowSnapshot });
    return {
      command,
      message: buildCloseReview(snapshot.recentRuns, snapshot.alerts),
      snapshot,
    };
  }

  if (parsed.action === 'snooze_alerts') {
    const hours = Number(payload.hours) > 0 ? Number(payload.hours) : 2;
    const until = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
    const alerts = await safeListAlerts(dynamodb);
    const actionable = alerts.filter((alert) => alert.status !== 'resolved');
    for (const alert of actionable) {
      await updateAlertRecord(dynamodb, alert.alertId, {
        status: 'snoozed',
        snoozedUntil: until,
      });
    }
    return {
      command,
      message: actionable.length > 0
        ? `Snoozed ${actionable.length} alert${actionable.length === 1 ? '' : 's'} until ${until}.`
        : 'No active alerts needed snoozing.',
      snapshot: await getDirectorSnapshot({ dynamodb, workflowSnapshot }),
    };
  }

  const dispatch = await invokeWorkerLambda(lambdaClient, parsed.worker, {
    source: 'managing-director',
    jobType: parsed.worker,
    command,
    requestedAt: nowIso(),
    triggerType: 'manual',
    workflowSnapshot,
    ...payload,
  });

  let runRecord;
  if (dispatch.invoked) {
    runRecord = buildRunRecord({
      worker: parsed.worker,
      triggerType: 'manual',
      status: 'running',
      summary: `Manual run dispatched to ${dispatch.functionName}.`,
      severity: 'info',
      command,
    });
  } else {
    const startedAt = nowIso();
    runRecord = buildRunRecord({
      worker: parsed.worker,
      triggerType: 'manual',
      status: 'failed',
      summary: `Worker dispatch failed: ${dispatch.reason || 'unknown error'}.`,
      severity: 'warning',
      command,
      startedAt,
      finishedAt: nowIso(),
      source: 'dashboard-dispatch',
      metadata: { dispatchFailure: true, functionName: dispatch.functionName || null },
    });
  }

  await persistRunRecord(dynamodb, runRecord);

  if (runRecord.severity === 'critical' || runRecord.severity === 'warning') {
    const channels = ['dashboard'];
    const alertRecord = buildAlertRecord({
      worker: runRecord.worker,
      severity: runRecord.severity,
      title: `${getWorkerDefinition(runRecord.worker).name} attention needed`,
      message: runRecord.summary,
      sourceRunId: runRecord.runId,
      channels,
      details: {
        command,
      },
    });
    await persistAlertRecord(dynamodb, alertRecord);
    await dispatchAlertEmail(ses, alertRecord);
  }

  return {
    command,
    message: runRecord.summary,
    runRecord,
    snapshot: await getDirectorSnapshot({ dynamodb, workflowSnapshot }),
  };
}

module.exports = {
  HERMES_AGENT_RUNS_TABLE,
  HERMES_ALERTS_TABLE,
  HERMES_ALERT_EMAIL_TO,
  listWorkerDefinitions,
  getDirectorSnapshot,
  executeDirectorCommand,
  updateAlertRecord,
  buildRunRecord,
  buildAlertRecord,
  normalizeWorkerStatus,
  COMMANDS,
};
