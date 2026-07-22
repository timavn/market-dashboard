const DEFAULT_GMAIL_HEARTBEAT_MAX_AGE_MINUTES = 45;
const DEFAULT_GMAIL_SCHEDULE_ID = 'market-dashboard-gmail-v2-every-15m';

const AUTH_ERROR_CODES = new Set([
  'GMAIL_AUTH_REQUIRED',
  'GMAIL_OAUTH_CLIENT_DISABLED',
]);

function toDate(value) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function cloudWatchDiagnostic(metrics = {}) {
  return {
    functionName: metrics.functionName || null,
    invocations: Number(metrics.invocations || 0),
    errors: Number(metrics.errors || 0),
    latestAt: toDate(metrics.latestAt)?.toISOString() || null,
    windowMinutes: Number(metrics.windowMinutes || 0) || null,
    error: metrics.error || null,
  };
}

function unhealthyResult({
  account,
  serviceId,
  heartbeat,
  metrics,
  now,
  status = 'unhealthy',
  errorCode,
  reason,
}) {
  const observedAt = toDate(heartbeat?.finishedAt || heartbeat?.observedAt)?.toISOString() || null;
  return {
    status,
    healthy: false,
    verified: true,
    account,
    serviceId,
    checkedAt: now.toISOString(),
    observedAt,
    lastSuccessAt: toDate(heartbeat?.lastSuccessAt)?.toISOString() || null,
    errorCode,
    reason,
    source: 'service-heartbeat-table',
    heartbeatStatus: String(heartbeat?.status || '').trim().toLowerCase() || null,
    counts: heartbeat?.counts && typeof heartbeat.counts === 'object' ? heartbeat.counts : {},
    cloudwatch: cloudWatchDiagnostic(metrics),
  };
}

/**
 * Resolve Gmail ingestion health for active research surfaces.
 *
 * A fresh, successful, schedule-proven service heartbeat is the only positive
 * signal. Lambda invocation metrics are retained solely as diagnostics because
 * handled OAuth failures intentionally return HTTP 200 from the Lambda.
 */
function resolveGmailPollHealth({
  heartbeatStore,
  metrics = {},
  account,
  now = new Date(),
  maxAgeMinutes = DEFAULT_GMAIL_HEARTBEAT_MAX_AGE_MINUTES,
  expectedScheduleId = DEFAULT_GMAIL_SCHEDULE_ID,
} = {}) {
  const current = toDate(now) || new Date();
  const normalizedAccount = String(account || '').trim().toLowerCase();
  const serviceId = `gmail:${normalizedAccount}`;
  const diagnostic = cloudWatchDiagnostic(metrics);

  if (heartbeatStore?.available !== true) {
    return unhealthyResult({
      account: normalizedAccount,
      serviceId,
      heartbeat: null,
      metrics,
      now: current,
      errorCode: heartbeatStore?.errorCode || 'GMAIL_HEARTBEAT_UNAVAILABLE',
      reason: heartbeatStore?.error || 'The typed Gmail service heartbeat could not be read.',
    });
  }

  const heartbeat = heartbeatStore.heartbeat;
  if (!heartbeatStore.found || !heartbeat || typeof heartbeat !== 'object') {
    return unhealthyResult({
      account: normalizedAccount,
      serviceId,
      heartbeat: null,
      metrics,
      now: current,
      errorCode: 'GMAIL_HEARTBEAT_MISSING',
      reason: 'No scheduled Gmail ingestion heartbeat was found.',
    });
  }

  const heartbeatStatus = String(heartbeat.status || '').trim().toLowerCase();
  const heartbeatErrorCode = String(heartbeat.errorCode || '').trim().toUpperCase();
  if (heartbeatStatus === 'auth_required' || AUTH_ERROR_CODES.has(heartbeatErrorCode)) {
    return unhealthyResult({
      account: normalizedAccount,
      serviceId,
      heartbeat,
      metrics,
      now: current,
      status: 'auth_required',
      errorCode: heartbeatErrorCode || 'GMAIL_AUTH_REQUIRED',
      reason: heartbeat.detail || 'Gmail OAuth authorization requires attention.',
    });
  }

  const observed = toDate(heartbeat.finishedAt || heartbeat.observedAt);
  const ageMs = observed ? current.getTime() - observed.getTime() : Number.POSITIVE_INFINITY;
  const maxAgeMs = Math.max(1, Number(maxAgeMinutes) || DEFAULT_GMAIL_HEARTBEAT_MAX_AGE_MINUTES) * 60 * 1000;
  if (!observed || ageMs < -60_000 || ageMs > maxAgeMs) {
    return unhealthyResult({
      account: normalizedAccount,
      serviceId,
      heartbeat,
      metrics,
      now: current,
      status: 'stale',
      errorCode: 'GMAIL_POLL_STALE',
      reason: !observed
        ? 'The Gmail heartbeat timestamp is missing or invalid.'
        : `The last Gmail service heartbeat is older than ${Math.max(1, Number(maxAgeMinutes) || DEFAULT_GMAIL_HEARTBEAT_MAX_AGE_MINUTES)} minutes.`,
    });
  }

  const schedulerVerified = heartbeat.serviceId === serviceId
    && heartbeat.source === 'aws-lambda'
    && heartbeat.triggerSource === 'aws-scheduler'
    && heartbeat.scheduled === true
    && heartbeat.scheduleId === expectedScheduleId;
  if (!schedulerVerified) {
    return unhealthyResult({
      account: normalizedAccount,
      serviceId,
      heartbeat,
      metrics,
      now: current,
      errorCode: 'GMAIL_SCHEDULER_PROVENANCE_INVALID',
      reason: `The latest heartbeat did not prove invocation by ${expectedScheduleId}.`,
    });
  }

  if (heartbeatStatus !== 'success') {
    return unhealthyResult({
      account: normalizedAccount,
      serviceId,
      heartbeat,
      metrics,
      now: current,
      errorCode: heartbeatErrorCode || 'GMAIL_HEARTBEAT_INVALID',
      reason: heartbeat.detail || `The latest Gmail heartbeat has unsupported status ${heartbeatStatus || 'unknown'}.`,
    });
  }

  return {
    status: 'healthy',
    healthy: true,
    verified: true,
    account: normalizedAccount,
    serviceId,
    checkedAt: current.toISOString(),
    observedAt: observed.toISOString(),
    lastSuccessAt: observed.toISOString(),
    errorCode: null,
    reason: null,
    source: 'service-heartbeat-table',
    heartbeatStatus,
    counts: heartbeat.counts && typeof heartbeat.counts === 'object' ? heartbeat.counts : {},
    cloudwatch: diagnostic,
  };
}

module.exports = {
  AUTH_ERROR_CODES,
  DEFAULT_GMAIL_HEARTBEAT_MAX_AGE_MINUTES,
  DEFAULT_GMAIL_SCHEDULE_ID,
  resolveGmailPollHealth,
};
