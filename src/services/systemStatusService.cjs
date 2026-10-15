const { isUsMarketOpen, mostRecentCompletedTradingDateKey } = require('./volatilitySnapshotService.cjs');

const STATUS = Object.freeze({
  ONLINE: 'online',
  OFFLINE: 'offline',
  ATTENTION: 'attention',
  CLOSED: 'closed',
  UNKNOWN: 'unknown',
});

const SERVICE_DEFINITIONS = Object.freeze([
  Object.freeze({ id: 'dashboard', label: 'Dashboard' }),
  Object.freeze({ id: 'market-data', label: 'Market data' }),
  Object.freeze({ id: 'live-portfolio', label: 'Portfolio' }),
  Object.freeze({ id: 'resolver-sources', label: 'Resolver sources', nonCore: true }),
  Object.freeze({ id: 'ai', label: 'AI' }),
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
    Object.freeze({ id: 'fresh-session', label: 'Session' }),
  ]),
  'resolver-sources': Object.freeze([
    Object.freeze({ id: 'ibkr-dated-futures', label: 'IBKR dated futures' }),
    Object.freeze({ id: 'kalshi-resolver', label: 'Kalshi resolver venues' }),
    Object.freeze({ id: 'forecastex-publications', label: 'ForecastEx public publications' }),
    Object.freeze({ id: 'coinbase-proxy', label: 'Coinbase proxy' }),
    Object.freeze({ id: 'bls-cpi-publication', label: 'BLS CPI publication' }),
  ]),
  ai: Object.freeze([
    Object.freeze({ id: 'analyst-runtime', label: 'The Analyst' }),
    Object.freeze({ id: 'gmail-ingestion', label: 'Gmail Function' }),
  ]),
});

const DEFAULT_PROBE_TIMEOUT_MS = 650;
const DEFAULT_GMAIL_HEARTBEAT_TIMEOUT_MS = 450;
const DEFAULT_MARKET_EVIDENCE_MAX_AGE_MS = 60_000;
const DEFAULT_PORTFOLIO_EVIDENCE_MAX_AGE_MS = 120_000;
const DEFAULT_RESOLVER_SOURCE_MAX_AGE_MS = 15_000;
const DEFAULT_RESOLVER_FUTURES_MAX_AGE_MS = 10_000;
const RESOLVER_FUTURES = Object.freeze([
  Object.freeze({ symbol: 'CLU6', role: 'proxy', required: false }),
  Object.freeze({ symbol: 'GCQ6', role: 'exact', required: true }),
  Object.freeze({ symbol: 'ESU6', role: 'exact', required: true }),
  Object.freeze({ symbol: 'NQU6', role: 'exact', required: true }),
]);
const MAX_FUTURE_CLOCK_SKEW_MS = 30_000;

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

function humanHeartbeatDetail(value) {
  const normalized = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized || /^(?:\d+|[A-Z0-9_.:-]+)$/.test(normalized)) return '';
  return normalized.slice(0, 160);
}

function sentence(value) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return /[.!?]$/.test(normalized) ? normalized : `${normalized}.`;
}

function quarantinedMessageCount(heartbeat, detail) {
  const candidates = [
    heartbeat?.quarantinedCount,
    heartbeat?.counts?.quarantined,
    heartbeat?.counts?.quarantinedMessages,
  ];
  const count = candidates.find((value) => Number.isFinite(Number(value)) && Number(value) > 0);
  if (count !== undefined) return Number(count);
  const parsed = String(detail || '').match(/\b(\d+)\s+Gmail message/i);
  return parsed ? Number(parsed[1]) : null;
}

function gmailHeartbeatStoreFailureReason(store) {
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
    return 'Gmail heartbeat table is unavailable.';
  }
  if (/(?:client.?unavailable|access is not configured)/i.test(context)) {
    return 'AWS heartbeat client is unavailable.';
  }
  if (/(?:query.?timeout|query timed out)/i.test(context)) {
    return 'AWS heartbeat query timed out.';
  }
  return 'Gmail heartbeat query failed.';
}

function heartbeatFailureReason(record, heartbeat) {
  const label = shortReason(record?.label, 'Gmail Function');
  const errorCode = String(heartbeat?.errorCode || '')
    .trim()
    .replace(/[^A-Za-z0-9_.:-]/g, '_')
    .slice(0, 64);
  const detail = humanHeartbeatDetail(heartbeat?.detail || heartbeat?.error);
  if (errorCode === 'GMAIL_QUARANTINED_ARTIFACTS_PENDING') {
    const count = quarantinedMessageCount(heartbeat, detail);
    const messages = count
      ? `${count} quarantined Gmail message${count === 1 ? '' : 's'}`
      : 'Quarantined Gmail messages';
    return `The Gmail poller is current; ${messages} remain after research materialization failed.`;
  }
  if (errorCode === 'GMAIL_AUTH_REQUIRED') {
    return 'Gmail authorization is required before ingestion can continue.';
  }
  const heartbeatStatus = String(heartbeat?.status || '').trim().toLowerCase();
  if (heartbeatStatus && heartbeatStatus !== 'error') {
    return `${label} needs attention because its latest run is ${heartbeatStatus}.`;
  }
  if (detail) return sentence(`${label} could not complete: ${detail}`);
  return `${label} did not complete successfully; a fresh heartbeat is required.`;
}

async function collectScheduledHeartbeatEvidence({
  records,
  readHeartbeat,
  timeoutMs = DEFAULT_GMAIL_HEARTBEAT_TIMEOUT_MS,
} = {}) {
  const configuredRecords = Array.isArray(records) ? records : [];
  const boundedTimeoutMs = Math.min(
    800,
    Math.max(10, Number(timeoutMs) || DEFAULT_GMAIL_HEARTBEAT_TIMEOUT_MS),
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

function detailResult(definition, status, reason = null, metadata = {}) {
  const normalizedStatus = status === STATUS.ONLINE
    ? STATUS.ONLINE
    : (status === STATUS.OFFLINE
      ? STATUS.OFFLINE
      : (status === STATUS.ATTENTION
        ? STATUS.ATTENTION
        : (status === STATUS.CLOSED ? STATUS.CLOSED : STATUS.UNKNOWN)));
  const result = {
    ...definition,
    ...metadata,
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
      : (status === STATUS.ATTENTION
        ? STATUS.ATTENTION
        : (status === STATUS.CLOSED ? STATUS.CLOSED : STATUS.UNKNOWN)));
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

function portfolioFreshnessReason(value, now, maxAgeMs) {
  const observedMs = value instanceof Date
    ? value.getTime()
    : Date.parse(String(value || ''));
  if (!Number.isFinite(observedMs)) return 'Fresh live portfolio evidence is unavailable.';
  const ageMs = now.getTime() - observedMs;
  if (ageMs < -MAX_FUTURE_CLOCK_SKEW_MS) {
    return `The verified live portfolio timestamp is ${Math.ceil(Math.abs(ageMs) / 1000)}s ahead of the local clock.`;
  }
  return `The last verified live portfolio snapshot is ${Math.ceil(Math.max(0, ageMs) / 1000)}s old; the freshness limit is ${Math.round(maxAgeMs / 1000)}s.`;
}

function normalizedIso(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function latestIso(values = []) {
  return values
    .map(normalizedIso)
    .filter(Boolean)
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0] || null;
}

function resolverSourceStatus(value, fallback = 'unverified') {
  return String(value || fallback).trim().toLowerCase() || fallback;
}

function publicResolverDetail(definition, provider, {
  role,
  label,
  lastAttemptAt,
  now,
  maxAgeMs,
} = {}) {
  if (!provider || typeof provider !== 'object') {
    const reason = `${label} health is unverified.`;
    return detailResult(definition, STATUS.UNKNOWN, reason, {
      sourceStatus: 'unverified',
      role,
      neutral: false,
      lastSuccessAt: null,
      observedAt: null,
    });
  }

  const sourceStatus = resolverSourceStatus(provider.status);
  const lastSuccessAt = normalizedIso(provider.lastSuccessAt);
  const attemptAt = normalizedIso(lastAttemptAt);
  const common = {
    sourceStatus,
    role,
    neutral: ['not_started', 'not_applicable'].includes(sourceStatus),
    lastSuccessAt,
    observedAt: sourceStatus === 'unavailable' ? attemptAt : lastSuccessAt,
  };
  if (sourceStatus === 'not_applicable') {
    return detailResult(definition, STATUS.UNKNOWN, 'Not applicable to the selected prediction market.', {
      ...common,
      statusLabel: 'Not applicable',
    });
  }
  if (sourceStatus === 'not_started') {
    return detailResult(definition, STATUS.UNKNOWN, 'Not yet observed.', common);
  }
  if (sourceStatus === 'available') {
    if (timestampIsFresh(lastSuccessAt, now, maxAgeMs)) {
      return detailResult(definition, STATUS.ONLINE, null, common);
    }
    return detailResult(
      definition,
      STATUS.UNKNOWN,
      `${label} last successful observation is stale.`,
      common,
    );
  }
  if (sourceStatus === 'partial') {
    return detailResult(
      definition,
      STATUS.ATTENTION,
      shortReason(provider.error?.message, `${label} is only partially available.`),
      common,
    );
  }
  if (sourceStatus === 'unavailable') {
    const recentFailure = timestampIsFresh(attemptAt, now, maxAgeMs);
    const reason = recentFailure
      ? shortReason(provider.error?.message, `${label} is unavailable.`)
      : `${label} has no recent verified observation.`;
    return detailResult(
      definition,
      recentFailure ? STATUS.OFFLINE : STATUS.UNKNOWN,
      reason,
      common,
    );
  }
  return detailResult(definition, STATUS.UNKNOWN, `${label} health is unverified.`, common);
}

function ibkrResolverDetail(definition, provider, { now, maxAgeMs } = {}) {
  const raw = provider && typeof provider === 'object' ? provider : {};
  const sourceStatus = resolverSourceStatus(raw.status);
  const rawSymbols = raw.symbols && typeof raw.symbols === 'object' ? raw.symbols : {};
  const symbols = RESOLVER_FUTURES.map(({ symbol, role, required }) => {
    const state = rawSymbols[symbol] || {};
    const symbolSourceStatus = resolverSourceStatus(state.status);
    const lastQuoteAt = normalizedIso(state.lastQuoteAt || state.lastTradeAt);
    const definitionVerified = state.definition?.valid === true;
    const fresh = symbolSourceStatus === 'live'
      && definitionVerified
      && timestampIsFresh(lastQuoteAt, now, maxAgeMs);
    const pending = ['starting', 'not_started'].includes(symbolSourceStatus);
    return {
      symbol,
      role,
      required,
      status: fresh ? STATUS.ONLINE : pending ? STATUS.UNKNOWN : STATUS.OFFLINE,
      sourceStatus: symbolSourceStatus,
      lastQuoteAt,
      errorCode: state.error?.code
        || (state.definition?.valid === false ? state.definition?.code : null)
        || (!definitionVerified ? 'RESOLVER_FUTURES_DEFINITION_UNVERIFIED' : null)
        || (!fresh && symbolSourceStatus === 'live' ? 'RESOLVER_FUTURES_QUOTE_STALE' : null),
    };
  });
  const requiredSymbols = symbols.filter((symbol) => symbol.required);
  const optionalSymbols = symbols.filter((symbol) => !symbol.required);
  const requested = requiredSymbols.length;
  const verified = requiredSymbols.filter((symbol) => symbol.status === STATUS.ONLINE).length;
  const rejected = Math.max(0, requested - verified);
  const coverageStatus = requested > 0 && verified === requested
    ? 'complete'
    : verified > 0 ? 'partial' : 'none';
  const provenanceVerified = raw.dataType === 'live_only'
    && raw.cachePolicy === 'no_fallback';
  const common = {
    sourceStatus,
    role: 'live_dated_futures',
    neutral: false,
    observedAt: normalizedIso(raw.lastMessageAt),
    lastSuccessAt: ['live', 'degraded'].includes(sourceStatus)
      ? normalizedIso(raw.lastMessageAt)
      : null,
    coverage: {
      requested,
      verified,
      rejected,
      status: coverageStatus,
    },
    symbols,
    optionalCoverage: {
      requested: optionalSymbols.length,
      verified: optionalSymbols.filter((symbol) => symbol.status === STATUS.ONLINE).length,
      rejected: optionalSymbols.filter((symbol) => symbol.status !== STATUS.ONLINE).length,
    },
  };

  if (
    ['live', 'degraded'].includes(sourceStatus)
    && raw.connected === true
    && provenanceVerified
    && requested > 0
    && verified === requested
  ) {
    return detailResult(definition, STATUS.ONLINE, null, common);
  }
  if (
    ['live', 'degraded'].includes(sourceStatus)
    && raw.connected === true
    && provenanceVerified
    && verified < requested
    && verified > 0
  ) {
    return detailResult(
      definition,
      STATUS.ATTENTION,
      shortReason(raw.message, `IBKR exact dated-futures coverage is partial (${verified}/${requested}).`),
      common,
    );
  }
  if (['unavailable', 'disabled'].includes(sourceStatus) || raw.connected === false) {
    return detailResult(
      definition,
      STATUS.OFFLINE,
      shortReason(raw.message, 'Fresh verified IBKR dated-futures quotes are unavailable.'),
      common,
    );
  }
  const reason = ['live', 'degraded'].includes(sourceStatus) && !provenanceVerified
    ? 'IBKR dated-futures live-only provenance is unverified.'
    : ['live', 'degraded'].includes(sourceStatus) && verified < requested
      ? `IBKR exact dated-futures coverage is stale or incomplete (${verified}/${requested}).`
      : 'IBKR dated-futures health is not yet verified.';
  return detailResult(definition, STATUS.UNKNOWN, reason, common);
}

function blsResolverDetail(definition, evidence, { now, maxAgeMs } = {}) {
  const providers = evidence?.providers || {};
  const schedule = evidence?.schedule?.blsCpi;
  const releaseAt = normalizedIso(schedule?.releaseAt);
  const windowOpensAt = normalizedIso(schedule?.windowOpensAt);
  const reportMonth = schedule?.reportMonth ? String(schedule.reportMonth) : null;
  const sources = {
    release: resolverSourceStatus(providers.blsRelease?.status, 'not_started'),
    rss: resolverSourceStatus(providers.blsRss?.status, 'not_started'),
    api: resolverSourceStatus(providers.blsApi?.status, 'not_started'),
  };
  const base = {
    role: 'official_publication',
    releaseAt,
    reportMonth,
    windowOpensAt,
    sources,
    lastSuccessAt: null,
    observedAt: null,
  };
  if (!releaseAt || !windowOpensAt) {
    return detailResult(
      definition,
      STATUS.UNKNOWN,
      'BLS CPI publication schedule is unverified.',
      {
        ...base,
        sourceStatus: 'unverified',
        neutral: false,
        due: false,
        released: false,
      },
    );
  }

  const due = now.getTime() >= Date.parse(windowOpensAt);
  const released = now.getTime() >= Date.parse(releaseAt);
  if (!due) {
    return detailResult(definition, STATUS.ONLINE, null, {
      ...base,
      sourceStatus: 'pending_release',
      statusLabel: 'Scheduled',
      neutral: true,
      due,
      released,
    });
  }

  const expectedKeys = released
    ? ['blsRelease', 'blsRss', 'blsApi']
    : ['blsRelease', 'blsRss'];
  const lastSuccessAt = latestIso(expectedKeys.map((key) => providers[key]?.lastSuccessAt));
  const lastAttemptAt = normalizedIso(evidence?.lastSnapshotAt);
  const anyUnavailable = expectedKeys.some((key) => (
    resolverSourceStatus(providers[key]?.status, 'not_started') === 'unavailable'
  ));
  const allFresh = expectedKeys.every((key) => (
    resolverSourceStatus(providers[key]?.status, 'not_started') === 'available'
    && timestampIsFresh(providers[key]?.lastSuccessAt, now, maxAgeMs)
  ));
  const common = {
    ...base,
    neutral: false,
    due,
    released,
    lastSuccessAt,
    observedAt: anyUnavailable ? lastAttemptAt : lastSuccessAt,
  };
  if (allFresh) {
    return detailResult(definition, STATUS.ONLINE, null, {
      ...common,
      sourceStatus: 'available',
    });
  }
  if (anyUnavailable && timestampIsFresh(lastAttemptAt, now, maxAgeMs)) {
    return detailResult(
      definition,
      STATUS.OFFLINE,
      'One or more due BLS CPI publication sources are unavailable.',
      { ...common, sourceStatus: 'unavailable' },
    );
  }
  const anyAvailable = expectedKeys.some((key) => (
    resolverSourceStatus(providers[key]?.status, 'not_started') === 'available'
  ));
  return detailResult(
    definition,
    STATUS.UNKNOWN,
    anyAvailable
      ? 'BLS CPI publication evidence is stale or incomplete.'
      : 'BLS CPI publication has not yet been observed in its due window.',
    { ...common, sourceStatus: anyAvailable ? 'stale' : 'not_started' },
  );
}

function evaluateResolverSourcesEvidence(evidence, {
  now = new Date(),
  sourceMaxAgeMs = DEFAULT_RESOLVER_SOURCE_MAX_AGE_MS,
  futuresMaxAgeMs = DEFAULT_RESOLVER_FUTURES_MAX_AGE_MS,
} = {}) {
  const definitions = DETAIL_DEFINITIONS['resolver-sources'];
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    const reason = 'Resolver-source health could not be verified.';
    return {
      ...serviceResult(
        STATUS.UNKNOWN,
        reason,
        definitions.map((definition) => detailResult(
          definition,
          STATUS.UNKNOWN,
          reason,
          { neutral: false },
        )),
      ),
      nonCore: true,
    };
  }

  const providers = evidence.providers && typeof evidence.providers === 'object'
    ? evidence.providers
    : {};
  const publicOptions = {
    lastAttemptAt: evidence.lastSnapshotAt,
    now,
    maxAgeMs: Math.max(1, Number(sourceMaxAgeMs) || DEFAULT_RESOLVER_SOURCE_MAX_AGE_MS),
  };
  const details = [
    ibkrResolverDetail(definitions[0], providers.ibkrFutures, {
      now,
      maxAgeMs: Math.max(
        1,
        Number(futuresMaxAgeMs) || DEFAULT_RESOLVER_FUTURES_MAX_AGE_MS,
      ),
    }),
    publicResolverDetail(definitions[1], providers.kalshi, {
      ...publicOptions,
      role: 'resolver_venue',
      label: 'Kalshi resolver venue',
    }),
    publicResolverDetail(definitions[2], providers.forecastex, {
      ...publicOptions,
      role: 'official_publication',
      label: 'ForecastEx public publication',
    }),
    publicResolverDetail(definitions[3], providers.coinbase, {
      ...publicOptions,
      role: 'proxy_only',
      label: 'Coinbase proxy',
    }),
    blsResolverDetail(definitions[4], evidence, publicOptions),
  ];
  const active = details.filter((detail) => detail.neutral !== true);
  const issue = active.find((detail) => detail.status !== STATUS.ONLINE);
  let status = STATUS.ONLINE;
  if (active.length > 0 && active.every((detail) => detail.status === STATUS.OFFLINE)) {
    status = STATUS.OFFLINE;
  } else if (issue) {
    status = STATUS.ATTENTION;
  }
  return {
    ...serviceResult(status, issue?.reason || null, details),
    nonCore: true,
  };
}

function isRecentCompletedMarketQuote(value, now) {
  const observedAt = new Date(value || '');
  if (!Number.isFinite(observedAt.getTime())) return false;
  const quoteDate = observedAt.toLocaleDateString('en-CA', {
    timeZone: 'America/New_York',
  });
  return quoteDate === mostRecentCompletedTradingDateKey(now);
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
  const availability = String(evidence?.availability || '').trim().toLowerCase();
  const delayedOnly = providerVerified
    && providerAvailable === true
    && availability === 'delayed';
  const mixed = providerVerified
    && providerAvailable === true
    && availability === 'mixed';
  const closedSessionReference = !isUsMarketOpen(now)
    && (delayedOnly || isRecentCompletedMarketQuote(evidence?.observedAt, now));
  const delayedReason = evidence?.reason
    || 'Only delayed provider data is available; current live quotes are unavailable.';
  const mixedReason = evidence?.reason
    || 'Live IBKR quotes are available; some requested instruments are using delayed Yahoo data.';
  const closedReason = 'The market is closed; the most recent completed close is shown.';
  const provider = providerVerified && providerAvailable === true
    ? detailResult(
      definitions[0],
      closedSessionReference
        ? STATUS.CLOSED
        : delayedOnly
          ? STATUS.ATTENTION
          : STATUS.ONLINE,
      closedSessionReference
        ? closedReason
        : delayedOnly
          ? delayedReason
          : null,
    )
    : detailResult(
      definitions[0],
      providerVerified && providerAvailable === false
        ? (closedSessionReference ? STATUS.CLOSED : STATUS.OFFLINE)
        : STATUS.UNKNOWN,
      providerVerified && providerAvailable === false
        ? (closedSessionReference ? closedReason : (evidence?.reason || 'Primary provider is unavailable.'))
        : 'Primary provider availability is unverified.',
    );

  let quote;
  if (providerVerified && providerAvailable === false) {
    quote = detailResult(
      definitions[1],
      closedSessionReference ? STATUS.CLOSED : STATUS.OFFLINE,
      closedSessionReference ? closedReason : 'No provider quote is available.',
    );
  } else if (providerVerified && providerAvailable === true) {
    const maxAgeMs = Math.max(
      1,
      Number(evidence.maxAgeMs) || DEFAULT_MARKET_EVIDENCE_MAX_AGE_MS,
    );
    const liveObservedAt = evidence.currentObservedAt || evidence.observedAt;
    const delayedObservedAt = evidence.delayedObservedAt || evidence.observedAt;
    const evidenceFresh = mixed
      ? timestampIsFresh(liveObservedAt, now, maxAgeMs)
        && timestampIsFresh(delayedObservedAt, now, maxAgeMs)
      : timestampIsFresh(evidence.observedAt, now, maxAgeMs);
    quote = closedSessionReference
      ? detailResult(definitions[1], STATUS.CLOSED, closedReason)
      : evidenceFresh
      ? detailResult(
        definitions[1],
        delayedOnly || mixed ? STATUS.ATTENTION : STATUS.ONLINE,
        delayedOnly ? delayedReason : mixed ? mixedReason : null,
      )
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
      closedSessionReference ? STATUS.CLOSED : STATUS.OFFLINE,
      closedSessionReference
        ? closedReason
        : (evidence.reason || 'Market-data providers are unavailable.'),
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
  if (closedSessionReference) {
    return serviceResult(STATUS.CLOSED, closedReason, details);
  }
  const maxAgeMs = Math.max(
    1,
    Number(evidence.maxAgeMs) || DEFAULT_MARKET_EVIDENCE_MAX_AGE_MS,
  );
  const liveObservedAt = evidence.currentObservedAt || evidence.observedAt;
  const delayedObservedAt = evidence.delayedObservedAt || evidence.observedAt;
  const evidenceFresh = mixed
    ? timestampIsFresh(liveObservedAt, now, maxAgeMs)
      && timestampIsFresh(delayedObservedAt, now, maxAgeMs)
    : timestampIsFresh(evidence.observedAt, now, maxAgeMs);
  if (!evidenceFresh) {
    return serviceResult(
      STATUS.UNKNOWN,
      'Fresh market-data evidence is unavailable.',
      details,
    );
  }
  if (delayedOnly) {
    return serviceResult(STATUS.ATTENTION, delayedReason, details);
  }
  if (mixed) {
    return serviceResult(STATUS.ATTENTION, mixedReason, details);
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
  const hasPortfolioReadinessEvidence = (
    Object.hasOwn(evidence, 'portfolio_verified')
    || Object.hasOwn(evidence, 'portfolio_status')
  );
  const portfolioStatus = String(evidence.portfolio_status || '').toLowerCase();
  const portfolioVerified = evidence.portfolio_verified === true;
  const portfolioObservedAt = evidence.portfolio_observed_at || evidence.portfolioObservedAt;
  const sessionMaxAgeMs = Math.max(
    1,
    Number(evidence.maxAgeMs) || DEFAULT_PORTFOLIO_EVIDENCE_MAX_AGE_MS,
  );
  const freshPortfolioSnapshot = hasPortfolioReadinessEvidence
    ? (
      portfolioVerified
      && portfolioStatus === 'ready'
      && timestampIsFresh(portfolioObservedAt, now, sessionMaxAgeMs)
    )
    : (
      ['connected', 'ready'].includes(sessionStatus)
      && timestampIsFresh(evidence.time || evidence.observedAt, now, sessionMaxAgeMs)
    );
  const stalePortfolioReason = hasPortfolioReadinessEvidence
    ? (
      evidence.portfolio_message
        || (portfolioStatus === 'ready'
          ? portfolioFreshnessReason(portfolioObservedAt, now, sessionMaxAgeMs)
          : 'IBKR is connected, but a verified live position snapshot is unavailable.')
    )
    : 'Fresh portfolio session evidence is unavailable.';
  let session;
  if (evidence.connected === false) {
    session = detailResult(definitions[3], STATUS.OFFLINE, 'No live portfolio session is available.');
  } else if (evidence.connected === true && freshPortfolioSnapshot) {
    session = detailResult(definitions[3], STATUS.ONLINE);
  } else {
    session = detailResult(
      definitions[3],
      evidence.connected === true ? STATUS.ATTENTION : STATUS.UNKNOWN,
      stalePortfolioReason,
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
  if (hasPortfolioReadinessEvidence && (!portfolioVerified || portfolioStatus !== 'ready')) {
    return serviceResult(
      STATUS.ATTENTION,
      evidence.portfolio_message
        || 'IBKR is connected, but live positions are not verified.',
      details,
    );
  }
  if (!freshPortfolioSnapshot) {
    return serviceResult(
      hasPortfolioReadinessEvidence ? STATUS.ATTENTION : STATUS.UNKNOWN,
      hasPortfolioReadinessEvidence
        ? stalePortfolioReason
        : 'Fresh portfolio connectivity evidence is unavailable.',
      details,
    );
  }
  return serviceResult(STATUS.ONLINE, null, details);
}

function evaluateAnalystRuntimeEvidence(evidence) {
  const definition = DETAIL_DEFINITIONS.ai[0];
  if (!evidence || typeof evidence !== 'object' || evidence.id !== 'analyst.runtime') {
    return detailResult(
      definition,
      STATUS.UNKNOWN,
      'The Analyst runtime evidence is unverified.',
    );
  }

  const status = String(evidence.status || '').trim().toLowerCase();
  if (status === 'pass') return detailResult(definition, STATUS.ONLINE);
  if (status === 'warn') {
    return detailResult(
      definition,
      STATUS.ATTENTION,
      'The Analyst runtime needs attention.',
    );
  }
  if (status === 'fail') {
    const reason = evidence.errorCode === 'ANALYST_CONTRACT_UNVERIFIED'
      ? 'The Analyst is running, but its runtime contract is unverified.'
      : evidence.errorCode === 'ANALYST_RUNTIME_UNAVAILABLE'
        ? 'The Analyst runtime is unavailable or has unverified process provenance.'
        : 'The Analyst runtime could not be verified.';
    return detailResult(definition, STATUS.OFFLINE, reason);
  }
  return detailResult(
    definition,
    STATUS.UNKNOWN,
    'The Analyst runtime evidence is unverified.',
  );
}

function evaluateGmailHeartbeatEvidence(evidence, { now = new Date() } = {}) {
  const definition = DETAIL_DEFINITIONS.ai[1];
  const records = Array.isArray(evidence?.records) ? evidence.records : [];
  if (records.length !== 1) {
    return detailResult(
      definition,
      STATUS.UNKNOWN,
      'Gmail Function heartbeat evidence is incomplete.',
    );
  }

  const record = records[0];
  const store = record?.store;
  if (store?.available !== true) {
    return detailResult(
      definition,
      STATUS.UNKNOWN,
      gmailHeartbeatStoreFailureReason(store),
    );
  }

  const heartbeat = store.heartbeat;
  if (store.found !== true || !heartbeat || typeof heartbeat !== 'object') {
    return detailResult(
      definition,
      STATUS.UNKNOWN,
      'Gmail Function heartbeat evidence is missing.',
    );
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
    return detailResult(
      definition,
      STATUS.UNKNOWN,
      'Gmail Function heartbeat provenance is unverified.',
    );
  }

  const heartbeatStatus = String(heartbeat.status || '').toLowerCase();
  const completedWithAttention = ['warning', 'blocked'].includes(heartbeatStatus);
  if (heartbeatStatus !== 'success' && !completedWithAttention) {
    return detailResult(
      definition,
      STATUS.OFFLINE,
      heartbeatFailureReason(record, heartbeat),
    );
  }

  const label = shortReason(record.label, 'Gmail Function');
  const maxAgeMs = Math.max(1, Number(record.maxAgeMinutes) || 45) * 60 * 1000;
  if (!timestampIsFresh(heartbeat.finishedAt || heartbeat.observedAt, now, maxAgeMs)) {
    return detailResult(definition, STATUS.OFFLINE, `${label} heartbeat is stale.`);
  }
  if (completedWithAttention) {
    return detailResult(
      definition,
      STATUS.ATTENTION,
      heartbeatFailureReason(record, heartbeat),
    );
  }
  return detailResult(definition, STATUS.ONLINE);
}

function evaluateAiEvidence(evidence, { now = new Date() } = {}) {
  const details = [
    evaluateAnalystRuntimeEvidence(evidence?.analyst),
    evaluateGmailHeartbeatEvidence(evidence?.gmail, { now }),
  ];
  const issueByPriority = [STATUS.OFFLINE, STATUS.UNKNOWN, STATUS.ATTENTION]
    .map((status) => details.find((detail) => detail.status === status))
    .find(Boolean);
  return issueByPriority
    ? serviceResult(issueByPriority.status, issueByPriority.reason, details)
    : serviceResult(STATUS.ONLINE, null, details);
}

async function runBoundedProbe({
  serviceId,
  read,
  evaluate,
  nowProvider,
  timeoutMs,
  timeoutReason,
  unavailableReason,
  context,
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
    .then(() => read(context))
    .then((evidence) => evaluate(evidence, { now: safeNow(nowProvider), context }))
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
  const coreServices = services.filter((service) => service.nonCore !== true);
  if (coreServices.some((service) => service.status === STATUS.UNKNOWN)) return STATUS.UNKNOWN;
  return coreServices.every((service) => [STATUS.ONLINE, STATUS.CLOSED].includes(service.status))
    ? STATUS.ONLINE
    : STATUS.ATTENTION;
}

function createUnavailableSystemStatus({ now = new Date() } = {}) {
  const checkedAt = safeNow(() => now).toISOString();
  const services = SERVICE_DEFINITIONS.map((definition) => ({
    ...definition,
    status: STATUS.UNKNOWN,
    reason: 'Status could not be verified.',
    details: (DETAIL_DEFINITIONS[definition.id] || []).map((detail) => detailResult(
      detail,
      STATUS.UNKNOWN,
      'Status could not be verified.',
    )),
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
  readResolverSourcesEvidence,
  readAiEvidence,
  now = () => new Date(),
  probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
} = {}) {
  const boundedTimeoutMs = Math.min(850, Math.max(10, Number(probeTimeoutMs) || 0));

  async function collect(context = {}) {
    const [dashboard, marketData, livePortfolio, resolverSources, ai] = await Promise.all([
      runBoundedProbe({
        serviceId: 'dashboard',
        read: readDashboardEvidence,
        evaluate: evaluateDashboardEvidence,
        nowProvider: now,
        timeoutMs: boundedTimeoutMs,
        timeoutReason: 'Dashboard check timed out.',
        unavailableReason: 'Dashboard availability could not be verified.',
        context,
      }),
      runBoundedProbe({
        serviceId: 'market-data',
        read: readMarketDataEvidence,
        evaluate: evaluateMarketDataEvidence,
        nowProvider: now,
        timeoutMs: boundedTimeoutMs,
        timeoutReason: 'Market-data check timed out.',
        unavailableReason: 'Market-data availability could not be verified.',
        context,
      }),
      runBoundedProbe({
        serviceId: 'live-portfolio',
        read: readLivePortfolioEvidence,
        evaluate: evaluateLivePortfolioEvidence,
        nowProvider: now,
        timeoutMs: boundedTimeoutMs,
        timeoutReason: 'Portfolio check timed out.',
        unavailableReason: 'Portfolio connectivity could not be verified.',
        context,
      }),
      runBoundedProbe({
        serviceId: 'resolver-sources',
        read: readResolverSourcesEvidence,
        evaluate: evaluateResolverSourcesEvidence,
        nowProvider: now,
        timeoutMs: boundedTimeoutMs,
        timeoutReason: 'Resolver-source check timed out.',
        unavailableReason: 'Resolver-source health could not be verified.',
        context,
      }),
      runBoundedProbe({
        serviceId: 'ai',
        read: readAiEvidence,
        evaluate: evaluateAiEvidence,
        nowProvider: now,
        timeoutMs: boundedTimeoutMs,
        timeoutReason: 'AI check timed out.',
        unavailableReason: 'AI status could not be verified.',
        context,
      }),
    ]);

    const results = new Map([
      ['dashboard', dashboard],
      ['market-data', marketData],
      ['live-portfolio', livePortfolio],
      ['resolver-sources', resolverSources],
      ['ai', ai],
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
  DEFAULT_GMAIL_HEARTBEAT_TIMEOUT_MS,
  DEFAULT_PROBE_TIMEOUT_MS,
  DEFAULT_RESOLVER_FUTURES_MAX_AGE_MS,
  DEFAULT_RESOLVER_SOURCE_MAX_AGE_MS,
  DETAIL_DEFINITIONS,
  SERVICE_DEFINITIONS,
  STATUS,
  collectScheduledHeartbeatEvidence,
  createSystemStatusService,
  createUnavailableSystemStatus,
  evaluateAiEvidence,
  evaluateAnalystRuntimeEvidence,
  evaluateDashboardEvidence,
  evaluateGmailHeartbeatEvidence,
  gmailHeartbeatStoreFailureReason,
  evaluateLivePortfolioEvidence,
  evaluateMarketDataEvidence,
  evaluateResolverSourcesEvidence,
};
