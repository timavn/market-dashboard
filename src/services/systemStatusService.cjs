const STATUS = Object.freeze({
  ONLINE: 'online',
  OFFLINE: 'offline',
  ATTENTION: 'attention',
  UNKNOWN: 'unknown',
});

const SERVICE_DEFINITIONS = Object.freeze([
  Object.freeze({ id: 'dashboard', label: 'Dashboard' }),
  Object.freeze({ id: 'market-data', label: 'Market data' }),
  Object.freeze({ id: 'live-portfolio', label: 'Live portfolio' }),
  Object.freeze({ id: 'hermes-gmail', label: 'Hermes / Gmail' }),
]);

const DETAIL_DEFINITIONS = Object.freeze({
  dashboard: Object.freeze([
    Object.freeze({ id: 'api-server', label: 'API server' }),
    Object.freeze({ id: 'react-ui', label: 'React UI' }),
  ]),
  'market-data': Object.freeze([
    Object.freeze({ id: 'primary-provider', label: 'Primary provider' }),
    Object.freeze({ id: 'fresh-quote', label: 'Fresh quote' }),
  ]),
  'live-portfolio': Object.freeze([
    Object.freeze({ id: 'ibkr-sidecar', label: 'IBKR sidecar' }),
    Object.freeze({ id: 'gateway-session', label: 'Gateway session' }),
    Object.freeze({ id: 'managed-account', label: 'Managed account' }),
    Object.freeze({ id: 'fresh-session', label: 'Fresh session' }),
  ]),
  'hermes-gmail': Object.freeze([
    Object.freeze({ id: 'hermes-analyst', label: 'Hermes analyst' }),
    Object.freeze({ id: 'hermes-developer', label: 'Hermes developer' }),
    Object.freeze({ id: 'hermes-security', label: 'Hermes security' }),
    Object.freeze({ id: 'gmail-ingestion', label: 'Gmail ingestion' }),
  ]),
});

const DEFAULT_PROBE_TIMEOUT_MS = 650;
const DEFAULT_AUTOMATION_HEARTBEAT_TIMEOUT_MS = 450;
const DEFAULT_MARKET_EVIDENCE_MAX_AGE_MS = 60_000;
const DEFAULT_PORTFOLIO_EVIDENCE_MAX_AGE_MS = 30_000;
const MAX_FUTURE_CLOCK_SKEW_MS = 30_000;
const EXPECTED_AUTOMATION_HEARTBEATS = 4;

function safeNow(nowProvider = () => new Date()) {
  try {
    const value = nowProvider();
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  } catch (_error) {
    // A status response should remain available even if an injected clock fails.
  }
  return new Date();
}

function shortReason(value, fallback) {
  const normalized = String(value || fallback || '')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized.slice(0, 160) || 'Status could not be verified.';
}

function automationStoreFailureReason(store) {
  const context = `${store?.errorCode || ''} ${store?.error || ''}`.trim();
  if (
    /(?:expired.?token|token.?expired|request.?expired|security token.+expired)/i
      .test(context)
  ) {
    return 'AWS session expired.';
  }
  if (
    /(?:access.?denied|not.?authorized|unauthorized(?:operation)?|forbidden)/i
      .test(context)
  ) {
    return 'AWS heartbeat access is denied.';
  }
  if (
    /(?:credential|invalid.?access.?key|invalid.?client.?token|unrecognized.?client|signature.?does.?not.?match)/i
      .test(context)
  ) {
    return 'AWS credentials are unavailable.';
  }
  if (/(?:table.?missing|resource.?not.?found)/i.test(context)) {
    return 'Automation heartbeat table is unavailable.';
  }
  if (/(?:client.?unavailable|access is not configured)/i.test(context)) {
    return 'AWS heartbeat client is unavailable.';
  }
  if (/(?:query.?timeout|query timed out)/i.test(context)) {
    return 'AWS heartbeat query timed out.';
  }
  return 'Automation heartbeat query failed.';
}

function heartbeatFailureReason(record, heartbeat) {
  const label = shortReason(record?.label, 'Automation');
  const errorCode = String(heartbeat?.errorCode || '')
    .trim()
    .replace(/[^A-Za-z0-9_.:-]/g, '_')
    .slice(0, 64);
  if (errorCode) return `${label} reported ${errorCode}.`;
  const heartbeatStatus = String(heartbeat?.status || '').trim().toLowerCase();
  if (heartbeatStatus && heartbeatStatus !== 'error') {
    return `${label} reported ${heartbeatStatus}.`;
  }
  return `${label} reported an error.`;
}

async function collectAutomationHeartbeatEvidence({
  records,
  readHeartbeat,
  timeoutMs = DEFAULT_AUTOMATION_HEARTBEAT_TIMEOUT_MS,
} = {}) {
  const configuredRecords = Array.isArray(records) ? records : [];
  const boundedTimeoutMs = Math.min(
    800,
    Math.max(10, Number(timeoutMs) || DEFAULT_AUTOMATION_HEARTBEAT_TIMEOUT_MS),
  );
  return {
    records: await Promise.all(configuredRecords.map(async (record) => {
      if (typeof readHeartbeat !== 'function') {
        return {
          ...record,
          store: {
            available: false,
            found: false,
            errorCode: 'SERVICE_HEARTBEAT_CLIENT_UNAVAILABLE',
            error: 'DynamoDB heartbeat access is not configured.',
          },
        };
      }
      let timeoutId;
      try {
        const store = await Promise.race([
          Promise.resolve().then(() => readHeartbeat(record.serviceId)),
          new Promise((resolve) => {
            timeoutId = setTimeout(() => resolve({
              available: false,
              found: false,
              errorCode: 'SERVICE_HEARTBEAT_QUERY_TIMEOUT',
              error: 'AWS heartbeat query timed out.',
            }), boundedTimeoutMs);
          }),
        ]);
        return {
          ...record,
          store,
        };
      } catch (error) {
        return {
          ...record,
          store: {
            available: false,
            found: false,
            errorCode: error?.code || error?.name || 'SERVICE_HEARTBEAT_QUERY_FAILED',
            error: error?.message || String(error),
          },
        };
      } finally {
        clearTimeout(timeoutId);
      }
    })),
  };
}

function detailResult(definition, status, reason = null) {
  const normalizedStatus = status === STATUS.ONLINE
    ? STATUS.ONLINE
    : (status === STATUS.OFFLINE
      ? STATUS.OFFLINE
      : (status === STATUS.ATTENTION ? STATUS.ATTENTION : STATUS.UNKNOWN));
  const result = {
    ...definition,
    status: normalizedStatus,
  };
  if (normalizedStatus !== STATUS.ONLINE) {
    result.reason = shortReason(reason);
  }
  return result;
}

function unknownDetails(serviceId, reason) {
  return (DETAIL_DEFINITIONS[serviceId] || [])
    .map((definition) => detailResult(definition, STATUS.UNKNOWN, reason));
}

function serviceResult(status, reason = null, details = []) {
  const normalizedStatus = status === STATUS.ONLINE
    ? STATUS.ONLINE
    : (status === STATUS.OFFLINE
      ? STATUS.OFFLINE
      : (status === STATUS.ATTENTION ? STATUS.ATTENTION : STATUS.UNKNOWN));
  const result = {
    status: normalizedStatus,
    details,
  };
  if (normalizedStatus !== STATUS.ONLINE) {
    result.reason = shortReason(reason);
  }
  return result;
}

function timestampIsFresh(value, now, maxAgeMs) {
  const observedMs = value instanceof Date
    ? value.getTime()
    : Date.parse(String(value || ''));
  if (!Number.isFinite(observedMs)) return false;
  const ageMs = now.getTime() - observedMs;
  return ageMs >= -MAX_FUTURE_CLOCK_SKEW_MS && ageMs <= maxAgeMs;
}

function evaluateDashboardEvidence(evidence) {
  const definitions = DETAIL_DEFINITIONS.dashboard;
  if (!evidence || typeof evidence !== 'object') {
    const reason = 'Dashboard availability could not be verified.';
    return serviceResult(STATUS.UNKNOWN, reason, unknownDetails('dashboard', reason));
  }

  const api = evidence.apiAvailable === true
    ? detailResult(definitions[0], STATUS.ONLINE)
    : detailResult(
      definitions[0],
      evidence.apiAvailable === false ? STATUS.OFFLINE : STATUS.UNKNOWN,
      evidence.apiAvailable === false
        ? 'API server is unavailable.'
        : 'API server availability is unverified.',
    );
  const ui = evidence.uiVerified === true && evidence.uiAvailable === true
    ? detailResult(definitions[1], STATUS.ONLINE)
    : detailResult(
      definitions[1],
      evidence.uiVerified === true && evidence.uiAvailable === false
        ? STATUS.OFFLINE
        : STATUS.UNKNOWN,
      evidence.uiVerified === true && evidence.uiAvailable === false
        ? 'React UI is unavailable.'
        : 'React UI availability is unverified.',
    );
  const details = [api, ui];

  if (evidence.apiAvailable === false) {
    return serviceResult(STATUS.OFFLINE, 'Dashboard API is unavailable.', details);
  }
  if (evidence.apiAvailable !== true) {
    return serviceResult(STATUS.UNKNOWN, 'Dashboard API availability is unverified.', details);
  }
  if (evidence.uiVerified === true && evidence.uiAvailable === false) {
    return serviceResult(STATUS.OFFLINE, 'Dashboard UI is unavailable.', details);
  }
  if (evidence.uiVerified !== true || evidence.uiAvailable !== true) {
    return serviceResult(STATUS.UNKNOWN, 'Dashboard UI availability is unverified.', details);
  }
  return serviceResult(STATUS.ONLINE, null, details);
}

function evaluateMarketDataEvidence(evidence, { now = new Date() } = {}) {
  const definitions = DETAIL_DEFINITIONS['market-data'];
  const providerVerified = evidence?.verified === true;
  const providerAvailable = evidence?.available;
  const provider = providerVerified && providerAvailable === true
    ? detailResult(definitions[0], STATUS.ONLINE)
    : detailResult(
      definitions[0],
      providerVerified && providerAvailable === false ? STATUS.OFFLINE : STATUS.UNKNOWN,
      providerVerified && providerAvailable === false
        ? (evidence?.reason || 'Primary provider is unavailable.')
        : 'Primary provider availability is unverified.',
    );

  let quote;
  if (providerVerified && providerAvailable === false) {
    quote = detailResult(definitions[1], STATUS.OFFLINE, 'No provider quote is available.');
  } else if (providerVerified && providerAvailable === true) {
    const maxAgeMs = Math.max(
      1,
      Number(evidence.maxAgeMs) || DEFAULT_MARKET_EVIDENCE_MAX_AGE_MS,
    );
    quote = timestampIsFresh(evidence.observedAt, now, maxAgeMs)
      ? detailResult(definitions[1], STATUS.ONLINE)
      : detailResult(definitions[1], STATUS.UNKNOWN, 'No fresh provider quote is available.');
  } else {
    quote = detailResult(definitions[1], STATUS.UNKNOWN, 'Fresh quote availability is unverified.');
  }
  const details = [provider, quote];

  if (!evidence || evidence.verified !== true) {
    return serviceResult(
      STATUS.UNKNOWN,
      'Fresh market-data evidence is unavailable.',
      details,
    );
  }
  if (evidence.available === false) {
    return serviceResult(
      STATUS.OFFLINE,
      evidence.reason || 'Market-data providers are unavailable.',
      details,
    );
  }
  if (evidence.available !== true) {
    return serviceResult(
      STATUS.UNKNOWN,
      'Market-data availability could not be verified.',
      details,
    );
  }
  const maxAgeMs = Math.max(
    1,
    Number(evidence.maxAgeMs) || DEFAULT_MARKET_EVIDENCE_MAX_AGE_MS,
  );
  if (!timestampIsFresh(evidence.observedAt, now, maxAgeMs)) {
    return serviceResult(
      STATUS.UNKNOWN,
      'Fresh market-data evidence is unavailable.',
      details,
    );
  }
  return serviceResult(STATUS.ONLINE, null, details);
}

function evaluateLivePortfolioEvidence(evidence, { now = new Date() } = {}) {
  const definitions = DETAIL_DEFINITIONS['live-portfolio'];
  if (!evidence || typeof evidence !== 'object') {
    const reason = 'Portfolio connectivity could not be verified.';
    return serviceResult(STATUS.UNKNOWN, reason, unknownDetails('live-portfolio', reason));
  }

  const accounts = Array.isArray(evidence.accounts) ? evidence.accounts.filter(Boolean) : [];
  const sidecar = detailResult(definitions[0], STATUS.ONLINE);
  const gateway = evidence.connected === true
    ? detailResult(definitions[1], STATUS.ONLINE)
    : detailResult(
      definitions[1],
      evidence.connected === false ? STATUS.OFFLINE : STATUS.UNKNOWN,
      evidence.connected === false
        ? 'IB Gateway is disconnected.'
        : 'Gateway connectivity is unverified.',
    );
  let account;
  if (evidence.connected === false || (evidence.connected === true
    && (accounts.length === 0 || evidence.account_discovery_ok === false))) {
    account = detailResult(definitions[2], STATUS.OFFLINE, 'No managed IBKR account is available.');
  } else if (evidence.connected === true && accounts.length > 0) {
    account = detailResult(definitions[2], STATUS.ONLINE);
  } else {
    account = detailResult(definitions[2], STATUS.UNKNOWN, 'Managed account availability is unverified.');
  }

  const sessionStatus = String(evidence.status || '').toLowerCase();
  const sessionMaxAgeMs = Math.max(
    1,
    Number(evidence.maxAgeMs) || DEFAULT_PORTFOLIO_EVIDENCE_MAX_AGE_MS,
  );
  let session;
  if (evidence.connected === false) {
    session = detailResult(definitions[3], STATUS.OFFLINE, 'No live portfolio session is available.');
  } else if (
    evidence.connected === true
    && ['connected', 'ready'].includes(sessionStatus)
    && timestampIsFresh(evidence.time || evidence.observedAt, now, sessionMaxAgeMs)
  ) {
    session = detailResult(definitions[3], STATUS.ONLINE);
  } else {
    session = detailResult(
      definitions[3],
      STATUS.UNKNOWN,
      evidence.connected === true && ['connected', 'ready'].includes(sessionStatus)
        ? 'Fresh portfolio session evidence is unavailable.'
        : 'Live portfolio session is unverified.',
    );
  }
  const details = [sidecar, gateway, account, session];

  if (evidence.connected === false) {
    return serviceResult(STATUS.OFFLINE, 'IB Gateway is disconnected.', details);
  }
  if (evidence.connected !== true) {
    return serviceResult(STATUS.UNKNOWN, 'Portfolio connectivity could not be verified.', details);
  }
  if (accounts.length === 0 || evidence.account_discovery_ok === false) {
    return serviceResult(STATUS.OFFLINE, 'No managed IBKR account is available.', details);
  }
  if (!['connected', 'ready'].includes(String(evidence.status || '').toLowerCase())) {
    return serviceResult(STATUS.UNKNOWN, 'The live portfolio session is unverified.', details);
  }
  const maxAgeMs = Math.max(
    1,
    Number(evidence.maxAgeMs) || DEFAULT_PORTFOLIO_EVIDENCE_MAX_AGE_MS,
  );
  if (!timestampIsFresh(evidence.time || evidence.observedAt, now, maxAgeMs)) {
    return serviceResult(
      STATUS.UNKNOWN,
      'Fresh portfolio connectivity evidence is unavailable.',
      details,
    );
  }
  return serviceResult(STATUS.ONLINE, null, details);
}

function evaluateAutomationEvidence(evidence, { now = new Date() } = {}) {
  const definitions = DETAIL_DEFINITIONS['hermes-gmail'];
  const records = Array.isArray(evidence?.records) ? evidence.records : [];
  if (records.length !== EXPECTED_AUTOMATION_HEARTBEATS) {
    const reason = 'Automation heartbeat evidence is incomplete.';
    return serviceResult(STATUS.UNKNOWN, reason, unknownDetails('hermes-gmail', reason));
  }

  let unknownReason = null;
  let offlineReason = null;
  let attentionReason = null;
  const details = [];

  records.forEach((record, index) => {
    const definition = definitions[index];
    const store = record?.store;
    if (store?.available !== true) {
      const reason = automationStoreFailureReason(store);
      unknownReason ||= reason;
      details.push(detailResult(definition, STATUS.UNKNOWN, reason));
      return;
    }

    const heartbeat = store.heartbeat;
    if (store.found !== true || !heartbeat || typeof heartbeat !== 'object') {
      const reason = 'Automation heartbeat evidence is missing.';
      unknownReason ||= reason;
      details.push(detailResult(definition, STATUS.UNKNOWN, reason));
      return;
    }

    const expectedServiceId = String(record.serviceId || '');
    const expectedScheduleId = String(record.scheduleId || '');
    const provenanceVerified = Boolean(
      expectedServiceId
      && expectedScheduleId
      && heartbeat.serviceId === expectedServiceId
      && heartbeat.source === 'aws-lambda'
      && heartbeat.triggerSource === 'aws-scheduler'
      && heartbeat.scheduled === true
      && heartbeat.scheduleId === expectedScheduleId,
    );
    if (!provenanceVerified) {
      const reason = 'Automation heartbeat provenance is unverified.';
      unknownReason ||= reason;
      details.push(detailResult(definition, STATUS.UNKNOWN, reason));
      return;
    }

    const heartbeatStatus = String(heartbeat.status || '').toLowerCase();
    const completedWithAttention = ['warning', 'blocked'].includes(heartbeatStatus);
    if (heartbeatStatus !== 'success' && !completedWithAttention) {
      const reason = heartbeatFailureReason(record, heartbeat);
      offlineReason ||= reason;
      details.push(detailResult(definition, STATUS.OFFLINE, reason));
      return;
    }

    const label = shortReason(record.label, 'Automation');
    const maxAgeMs = Math.max(1, Number(record.maxAgeMinutes) || 45) * 60 * 1000;
    if (!timestampIsFresh(heartbeat.finishedAt || heartbeat.observedAt, now, maxAgeMs)) {
      const reason = `${label} heartbeat is stale.`;
      offlineReason ||= reason;
      details.push(detailResult(definition, STATUS.OFFLINE, reason));
      return;
    }
    if (completedWithAttention) {
      const reason = heartbeatFailureReason(record, heartbeat);
      attentionReason ||= reason;
      details.push(detailResult(definition, STATUS.ATTENTION, reason));
      return;
    }
    details.push(detailResult(definition, STATUS.ONLINE));
  });

  if (offlineReason) return serviceResult(STATUS.OFFLINE, offlineReason, details);
  if (unknownReason) return serviceResult(STATUS.UNKNOWN, unknownReason, details);
  if (attentionReason) return serviceResult(STATUS.ATTENTION, attentionReason, details);
  return serviceResult(STATUS.ONLINE, null, details);
}

async function runBoundedProbe({
  serviceId,
  read,
  evaluate,
  nowProvider,
  timeoutMs,
  timeoutReason,
  unavailableReason,
}) {
  if (typeof read !== 'function') {
    return serviceResult(
      STATUS.UNKNOWN,
      unavailableReason,
      unknownDetails(serviceId, unavailableReason),
    );
  }

  let timeoutId;
  const work = Promise.resolve()
    .then(() => read())
    .then((evidence) => evaluate(evidence, { now: safeNow(nowProvider) }))
    .catch(() => serviceResult(
      STATUS.UNKNOWN,
      unavailableReason,
      unknownDetails(serviceId, unavailableReason),
    ));
  const timeout = new Promise((resolve) => {
    timeoutId = setTimeout(
      () => resolve(serviceResult(
        STATUS.UNKNOWN,
        timeoutReason,
        unknownDetails(serviceId, timeoutReason),
      )),
      timeoutMs,
    );
  });

  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
}

function overallStatus(services) {
  const dashboard = services.find((service) => service.id === 'dashboard');
  if (!dashboard || dashboard.status === STATUS.UNKNOWN) return STATUS.UNKNOWN;
  if (dashboard.status === STATUS.OFFLINE) return STATUS.OFFLINE;
  if (services.some((service) => service.status === STATUS.UNKNOWN)) return STATUS.UNKNOWN;
  return services.every((service) => service.status === STATUS.ONLINE)
    ? STATUS.ONLINE
    : STATUS.ATTENTION;
}

function createUnavailableSystemStatus({ now = new Date() } = {}) {
  const checkedAt = safeNow(() => now).toISOString();
  const services = SERVICE_DEFINITIONS.map((definition) => ({
    ...definition,
    status: STATUS.UNKNOWN,
    reason: 'Status could not be verified.',
    details: unknownDetails(definition.id, 'Status could not be verified.'),
  }));
  return {
    checkedAt,
    overall: overallStatus(services),
    services,
  };
}

function createSystemStatusService({
  readDashboardEvidence,
  readMarketDataEvidence,
  readLivePortfolioEvidence,
  readAutomationEvidence,
  now = () => new Date(),
  probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
} = {}) {
  const boundedTimeoutMs = Math.min(850, Math.max(10, Number(probeTimeoutMs) || 0));

  async function collect() {
    const [dashboard, marketData, livePortfolio, automation] = await Promise.all([
      runBoundedProbe({
        serviceId: 'dashboard',
        read: readDashboardEvidence,
        evaluate: evaluateDashboardEvidence,
        nowProvider: now,
        timeoutMs: boundedTimeoutMs,
        timeoutReason: 'Dashboard check timed out.',
        unavailableReason: 'Dashboard availability could not be verified.',
      }),
      runBoundedProbe({
        serviceId: 'market-data',
        read: readMarketDataEvidence,
        evaluate: evaluateMarketDataEvidence,
        nowProvider: now,
        timeoutMs: boundedTimeoutMs,
        timeoutReason: 'Market-data check timed out.',
        unavailableReason: 'Market-data availability could not be verified.',
      }),
      runBoundedProbe({
        serviceId: 'live-portfolio',
        read: readLivePortfolioEvidence,
        evaluate: evaluateLivePortfolioEvidence,
        nowProvider: now,
        timeoutMs: boundedTimeoutMs,
        timeoutReason: 'Portfolio check timed out.',
        unavailableReason: 'Portfolio connectivity could not be verified.',
      }),
      runBoundedProbe({
        serviceId: 'hermes-gmail',
        read: readAutomationEvidence,
        evaluate: evaluateAutomationEvidence,
        nowProvider: now,
        timeoutMs: boundedTimeoutMs,
        timeoutReason: 'Automation check timed out.',
        unavailableReason: 'Automation status could not be verified.',
      }),
    ]);

    const results = new Map([
      ['dashboard', dashboard],
      ['market-data', marketData],
      ['live-portfolio', livePortfolio],
      ['hermes-gmail', automation],
    ]);
    const services = SERVICE_DEFINITIONS.map((definition) => ({
      ...definition,
      ...results.get(definition.id),
    }));

    return {
      checkedAt: safeNow(now).toISOString(),
      overall: overallStatus(services),
      services,
    };
  }

  return { collect };
}

module.exports = {
  DEFAULT_AUTOMATION_HEARTBEAT_TIMEOUT_MS,
  DEFAULT_PROBE_TIMEOUT_MS,
  DETAIL_DEFINITIONS,
  SERVICE_DEFINITIONS,
  STATUS,
  automationStoreFailureReason,
  collectAutomationHeartbeatEvidence,
  createSystemStatusService,
  createUnavailableSystemStatus,
  evaluateAutomationEvidence,
  evaluateDashboardEvidence,
  evaluateLivePortfolioEvidence,
  evaluateMarketDataEvidence,
};
