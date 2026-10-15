import { startVisibilityAwarePolling } from '../../utils/visibilityAwarePolling';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MarketDataService } from '../../services/api/marketDataService';
import { useTheme } from '../../context/ThemeContext';
import RefreshButton from '../common/RefreshButton';
import DataStatusChip from './DataStatusChip';
import {
  DASHBOARD_CARD_DEFINITIONS,
  DASHBOARD_SYSTEM_STATUS_META,
  getDashboardDataStatus,
  getDashboardSystemStatus,
  normalizeDashboardCardStatuses,
} from './dashboardStatus';
import './SystemReadinessPanel.css';

const MAX_STATUS_AGE_MS = 30 * 1000;
const MAX_LOGIN_STATUS_AGE_MS = 90 * 1000;
const LOGIN_POLL_INTERVAL_MS = 60 * 1000;
const ACTIVE_LOGIN_POLL_INTERVAL_MS = 2 * 1000;
const MAX_FUTURE_CLOCK_SKEW_MS = 30 * 1000;
const CLOSED_REFERENCE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const VALID_SERVICE_STATUSES = new Set(['online', 'offline', 'attention', 'closed', 'unknown']);
const VALID_MARKET_SESSIONS = new Set(['open', 'closed']);

const LOGIN_SERVICE_DEFINITION = {
  id: 'logins',
  label: 'Logins',
  summary: 'Sessions + API credentials',
};

const LOGIN_DETAIL_DEFINITIONS = [
  { id: 'ibkr-gateway', label: 'IBKR Gateway', summary: 'Brokerage + prediction markets', required: true },
  { id: 'gmail-oauth', label: 'Gmail OAuth', summary: 'Hedgeye inbox authorization', required: true },
  { id: 'aws-admin', label: 'AWS Admin', summary: 'Operator SSO session', required: false },
  { id: 'aws-api', label: 'AWS API', summary: 'Dashboard cloud reads', required: true },
  { id: 'aws-bridge', label: 'AWS Bridge', summary: 'Outbound snapshot publishing', required: false },
];

const LOGIN_STATES = new Set([
  'connected',
  'disabled',
  'disconnected',
  'expired',
  'expiring',
  'fresh',
  'invalid',
  'not_configured',
  'rate_limited',
  'forbidden',
  'wrong_principal',
  'environment_override',
  'socket_disabled',
  'sidecar_unavailable',
  'signed_out',
  'stale',
  'unverified',
]);

const LOGIN_ACTION_STATES = new Set([
  'idle',
  'awaiting_user',
  'verifying',
  'ready',
  'failed',
]);

const LOGIN_LOCAL_ACTIONS = Object.freeze({
  'open-ibkr-gateway': 'Open IB Gateway',
  'aws-admin-login': 'Refresh AWS SSO',
  'open-gmail-guide': 'Open Gmail recovery guide',
  'open-aws-guide': 'Open AWS credential guide',
});

function defaultLoginActions() {
  return Object.fromEntries(
    Object.entries(LOGIN_LOCAL_ACTIONS).map(([id, label]) => [id, {
      id,
      label,
      state: 'idle',
      startedAt: null,
      updatedAt: null,
      verifiedAt: null,
      failedAt: null,
      errorCode: null,
    }]),
  );
}

export function getSystemStatusServiceDefinitions() {
  return [
    { id: 'dashboard', label: 'Dashboard', summary: 'API + UI' },
    { id: 'market-data', label: 'Market data', summary: 'Quotes + freshness' },
    { id: 'live-portfolio', label: 'Portfolio', summary: 'IBKR session' },
    {
      id: 'resolver-sources',
      label: 'Resolver sources',
      summary: 'Prediction-market inputs',
      nonCore: true,
    },
    { id: 'ai', label: 'AI', summary: 'Analyst + ingestion' },
  ];
}

const SERVICE_DEFINITIONS = getSystemStatusServiceDefinitions();

function unknownLoginService(reason = 'Login status check returned no result.', checking = false) {
  return {
    ...LOGIN_SERVICE_DEFINITION,
    status: 'unknown',
    checking,
    reason,
    date: null,
    actions: defaultLoginActions(),
    details: LOGIN_DETAIL_DEFINITIONS.map((detail) => ({
      ...detail,
      status: 'unknown',
      checking,
      state: 'unverified',
      checkedAt: null,
      verifiedAt: null,
      expiresAt: null,
      reason,
      recovery: null,
    })),
  };
}

const DETAIL_DEFINITIONS = {
  dashboard: [
    { id: 'api-server', label: 'API server', summary: 'Serves dashboard APIs' },
    { id: 'react-ui', label: 'React UI', summary: 'Renders the dashboard' },
  ],
  'market-data': [
    { id: 'primary-provider', label: 'Primary provider', summary: 'Live quote source' },
    { id: 'fresh-quote', label: 'Fresh quote', summary: 'Age and session check' },
  ],
  'live-portfolio': [
    { id: 'ibkr-sidecar', label: 'IBKR sidecar', summary: 'Dashboard-to-IBKR bridge' },
    { id: 'gateway-session', label: 'Gateway session', summary: 'Authenticated gateway link' },
    { id: 'managed-account', label: 'Managed account', summary: 'Position account access' },
    { id: 'fresh-session', label: 'Session', summary: 'Session freshness' },
  ],
  ai: [
    { id: 'analyst-runtime', label: 'The Analyst', summary: 'On-demand research assistant' },
    { id: 'gmail-ingestion', label: 'Gmail Function', summary: 'Hedgeye email ingestion' },
  ],
  'resolver-sources': [
    {
      id: 'ibkr-dated-futures',
      label: 'IBKR dated futures',
      summary: 'GCQ6, ESU6, and NQU6 exact coverage; CLU6 optional proxy',
      role: 'live_dated_futures',
    },
    {
      id: 'kalshi-resolver',
      label: 'Kalshi resolver venues',
      summary: 'Venue books and published final values',
      role: 'resolver_venue',
    },
    {
      id: 'forecastex-publications',
      label: 'ForecastEx public publications',
      summary: 'Official contract publications and execution tape',
      role: 'official_publication',
    },
    {
      id: 'coinbase-proxy',
      label: 'Coinbase proxy',
      summary: 'Non-resolving spot reference only',
      role: 'proxy_only',
    },
    {
      id: 'bls-cpi-publication',
      label: 'BLS CPI publication',
      summary: 'Official release, RSS, and API verification',
      role: 'official_publication',
    },
  ],
};

const RESOLVER_FUTURE_SYMBOLS = new Set(['CLU6', 'GCQ6', 'ESU6', 'NQU6']);

const HEDGEYE_PRODUCT_DEFINITIONS = [
  { id: 'risk-ranges', label: 'Risk Ranges', summary: 'Daily LRR/HRR levels, Trend signals, and out-of-bucket names.' },
  { id: 'early-look', label: 'Early Look', summary: 'Early Trend changes across the published coverage list.' },
  { id: 'bitcoin-trend-tracker', label: 'Bitcoin Trend Tracker', summary: 'Crypto and related-equity Trend changes.' },
  { id: 'momo-tracker', label: 'MOMO Tracker', summary: 'Momentum coverage and Trend changes.' },
  { id: 'signal-strength', label: 'Signal Strength', summary: 'Security rankings plus added and removed names.' },
  { id: 'portfolio-solutions', label: 'Portfolio Solutions', summary: 'Rankings and top or bottom movers.' },
  { id: 'the-macro-show', label: 'The Macro Show', summary: 'Long, short, and neutral macro summary notes.' },
  { id: 'the-call', label: 'The Call', summary: 'Long, short, and neutral call summary notes.' },
  { id: 'real-time-alert', label: 'Real-Time Alert', summary: 'Published alert headlines, tickers, and signal phrases.' },
  { id: 'volume', label: 'Volume', summary: 'Market-volume snapshots and market-share data.' },
  { id: 'market-structure', label: 'Market Structure', summary: 'Market-structure snapshot data and notes.' },
  { id: 'cftc-positioning', label: 'CFTC Positioning', summary: 'Positioning metrics, weekly changes, and Z-scores.' },
  { id: 'etf-pro', label: 'ETF Pro', summary: 'Long and short ETF lists with reported changes.' },
  { id: 'inflation-nowcast', label: 'Inflation Nowcast', summary: 'Inflation forecast, outlook, and scenario notes.' },
];

const STATUS_META = {
  online: { label: 'Online', glyph: '✓' },
  closed: { label: 'Closed', glyph: '◷' },
  offline: { label: 'Error', glyph: '×' },
  attention: { label: 'Attention', glyph: '!' },
  unknown: { label: 'Check failed', glyph: '!' },
  checking: { label: 'Checking', glyph: '◷' },
};

const DETAIL_STATUS_META = STATUS_META;

function unknownProducts(reason = 'Product status check returned no result.', checking = false) {
  return HEDGEYE_PRODUCT_DEFINITIONS.map((product) => ({
    ...product,
    status: 'unknown',
    checking,
    reason,
    date: null,
    checkedAt: null,
    marketSession: 'open',
  }));
}

function normalizeMarketSession(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return VALID_MARKET_SESSIONS.has(normalized) ? normalized : 'open';
}

function isRecentReferenceDate(value, asOf) {
  if (!value) return false;
  const normalized = String(value).trim();
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(normalized)
    ? new Date(`${normalized}T12:00:00Z`)
    : new Date(normalized);
  const reference = new Date(asOf || Date.now());
  if (!Number.isFinite(parsed.getTime()) || !Number.isFinite(reference.getTime())) return false;
  const ageMs = reference.getTime() - parsed.getTime();
  return ageMs >= -24 * 60 * 60 * 1000 && ageMs <= CLOSED_REFERENCE_MAX_AGE_MS;
}

function normalizeProductStatus(status, {
  marketSession = 'open',
  date = null,
  asOf = null,
} = {}) {
  const closedReference = marketSession === 'closed' && isRecentReferenceDate(date, asOf);
  switch (String(status || '').toLowerCase()) {
    case 'fresh':
    case 'current':
    case 'available':
    case 'indexed':
    case 'success':
      return closedReference ? 'closed' : 'online';
    case 'missing':
    case 'error':
    case 'failed':
    case 'invalid':
    case 'unavailable':
      return 'offline';
    case 'stale':
    case 'retained':
      return closedReference ? 'closed' : 'attention';
    case 'pending':
      return 'attention';
    case 'closed':
    case 'historical':
      return 'closed';
    default:
      return 'unknown';
  }
}

export function normalizeHedgeyeProducts(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || !payload.dataTypes || typeof payload.dataTypes !== 'object' || Array.isArray(payload.dataTypes)) {
    throw new Error('Hedgeye product status response was not valid.');
  }

  const checkedAt = payload.meta?.timestamp || payload.date || null;
  const marketSession = normalizeMarketSession(payload.marketSession);
  return HEDGEYE_PRODUCT_DEFINITIONS.map((product) => {
    const source = payload.dataTypes[product.id] || {};
    const date = source.date || source.lastUpdated || null;
    const status = normalizeProductStatus(source.status, {
      marketSession,
      date,
      asOf: payload.date || checkedAt,
    });
    return {
      ...product,
      status,
      date,
      checkedAt,
      marketSession,
      reason: productReason(source, status, date),
    };
  });
}

export function deriveProductsStatus(products = []) {
  if (!products.length || products.every((product) => product.status === 'unknown')) return 'unknown';
  if (products.every((product) => product.status === 'online')) return 'online';
  if (products.every((product) => product.status === 'offline')) return 'offline';
  if (products.every((product) => ['online', 'closed'].includes(product.status))) return 'closed';
  return 'attention';
}

function unknownServices(reason = 'System status check returned no result.', checking = false) {
  return SERVICE_DEFINITIONS.map((service) => ({
    ...service,
    status: 'unknown',
    checking,
    reason,
    date: null,
    details: DETAIL_DEFINITIONS[service.id].map((detail) => ({
      ...detail,
      status: 'unknown',
      checking,
      reason,
      date: null,
    })),
  }));
}

function cleanReason(value) {
  if (!value) return '';
  const reason = String(value).replace(/\s+/g, ' ').trim();
  return reason.length > 160 ? `${reason.slice(0, 157)}…` : reason;
}

function missingCheckReason(source, label) {
  if (source?.reason) return cleanReason(source.reason);
  if (VALID_SERVICE_STATUSES.has(source?.status) && source.status !== 'unknown') return '';
  return source?.status
    ? `${label} check did not return a usable status.`
    : `${label} check returned no result.`;
}

function normalizeLoginTimestamp(value) {
  const parsed = new Date(value || '');
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function normalizeLoginRecovery(recovery) {
  if (!recovery || typeof recovery !== 'object' || Array.isArray(recovery)) return null;
  if (recovery.kind === 'local-action') {
    const actionId = String(recovery.actionId || '');
    const label = LOGIN_LOCAL_ACTIONS[actionId];
    return label ? { kind: 'local-action', actionId, label } : null;
  }
  return null;
}

function deriveLoginStatus(details = []) {
  const requiredDetails = details.filter((detail) => detail.required);
  if (requiredDetails.some((detail) => detail.status === 'offline')) return 'offline';
  if (requiredDetails.some((detail) => detail.status === 'unknown')) return 'unknown';
  if (requiredDetails.some((detail) => !['online', 'closed'].includes(detail.status))) return 'attention';
  return 'online';
}

function normalizeLoginActions(source) {
  const normalized = defaultLoginActions();
  if (!source || typeof source !== 'object' || Array.isArray(source)) return normalized;
  Object.keys(normalized).forEach((actionId) => {
    const candidate = source[actionId];
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return;
    const state = String(candidate.state || '').trim().toLowerCase();
    normalized[actionId] = {
      ...normalized[actionId],
      state: LOGIN_ACTION_STATES.has(state) ? state : 'idle',
      startedAt: normalizeLoginTimestamp(candidate.startedAt),
      updatedAt: normalizeLoginTimestamp(candidate.updatedAt),
      verifiedAt: normalizeLoginTimestamp(candidate.verifiedAt),
      failedAt: normalizeLoginTimestamp(candidate.failedAt),
      errorCode: String(candidate.errorCode || '').trim().slice(0, 64) || null,
    };
  });
  return normalized;
}

export function normalizeLoginStatus(payload, now = Date.now()) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.version !== 1) {
    throw new Error('Login status response was not valid.');
  }
  const checkedAt = new Date(payload.checkedAt || '');
  if (!Number.isFinite(checkedAt.getTime())) {
    throw new Error('Login status response did not include a valid checkedAt timestamp.');
  }
  const ageMs = now - checkedAt.getTime();
  if (ageMs > MAX_LOGIN_STATUS_AGE_MS || ageMs < -MAX_FUTURE_CLOCK_SKEW_MS) {
    throw new Error('Login status response is stale.');
  }
  if (!payload.service || payload.service.id !== LOGIN_SERVICE_DEFINITION.id) {
    throw new Error('Login status response did not include the Logins service.');
  }
  const suppliedDetails = new Map(
    (Array.isArray(payload.service.details) ? payload.service.details : [])
      .filter((detail) => detail && typeof detail === 'object')
      .map((detail) => [String(detail.id || ''), detail]),
  );
  const details = LOGIN_DETAIL_DEFINITIONS.map((definition) => {
    const source = suppliedDetails.get(definition.id) || {};
    const rawStatus = String(source.status || '').trim().toLowerCase();
    const status = VALID_SERVICE_STATUSES.has(rawStatus) ? rawStatus : 'unknown';
    const rawState = String(source.state || '').trim().toLowerCase();
    const state = LOGIN_STATES.has(rawState) ? rawState : 'unverified';
    const detailCheckedAt = normalizeLoginTimestamp(source.checkedAt) || checkedAt.toISOString();
    const keepsRecovery = status !== 'online' && !(status === 'closed' && state === 'disabled');
    return {
      ...definition,
      status,
      state,
      checkedAt: detailCheckedAt,
      verifiedAt: normalizeLoginTimestamp(source.verifiedAt),
      expiresAt: normalizeLoginTimestamp(source.expiresAt),
      date: normalizeLoginTimestamp(source.verifiedAt) || detailCheckedAt,
      reason: !keepsRecovery
        ? ''
        : cleanReason(source.reason || 'Login status could not be verified.'),
      recovery: !keepsRecovery
        ? null
        : normalizeLoginRecovery(source.recovery),
    };
  });
  const status = deriveLoginStatus(details);
  const failedCheck = details.find((detail) => detail.status === 'unknown');
  return {
    ...LOGIN_SERVICE_DEFINITION,
    status,
    date: checkedAt.toISOString(),
    actions: normalizeLoginActions(payload.actions),
    reason: status === 'online'
      ? ''
      : cleanReason(payload.service.reason || (failedCheck
        ? `${failedCheck.label}: ${failedCheck.reason}`
        : 'One or more login checks require attention.')),
    details,
  };
}

function productReason(source = {}, status, date) {
  const explicitReason = source.reason || source.error || source.message || source.detail;
  if (explicitReason) return cleanReason(explicitReason);
  const rawStatus = String(source.status || '').trim().toLowerCase();
  if (status === 'attention') {
    if (rawStatus === 'pending') return 'The latest update is still pending.';
    return date
      ? `The latest available data is from ${date}.`
      : 'The latest available data is not current.';
  }
  if (status === 'offline') {
    return rawStatus === 'missing' ? 'No data is available.' : 'This product is unavailable.';
  }
  if (status === 'unknown') return 'Product status could not be verified.';
  return '';
}

function reasonBullets(reason) {
  return String(reason || '')
    .split(/\s*;\s*/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const sentence = `${part.charAt(0).toUpperCase()}${part.slice(1)}`;
      return /[.!?…]$/.test(sentence) ? sentence : `${sentence}.`;
    });
}

function normalizedResolverSourceStatus(value) {
  const status = String(value || '').trim().toLowerCase();
  return VALID_SERVICE_STATUSES.has(status) ? status : 'unknown';
}

function normalizedResolverSourceText(value, maxLength = 64) {
  return String(value || '')
    .replace(/[^A-Za-z0-9_.:/ -]/g, '')
    .trim()
    .slice(0, maxLength);
}

function normalizedResolverCount(value) {
  const count = Number(value);
  return Number.isInteger(count) && count >= 0 ? count : null;
}

function normalizeResolverSymbols(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.flatMap((source) => {
    const symbol = String(source?.symbol || '').trim().toUpperCase();
    if (!RESOLVER_FUTURE_SYMBOLS.has(symbol) || seen.has(symbol)) return [];
    seen.add(symbol);
    const rawStatus = String(source?.status || '').trim().toLowerCase();
    return [{
      symbol,
      role: symbol === 'CLU6' ? 'proxy' : 'exact',
      required: symbol !== 'CLU6',
      status: ['online', 'offline', 'unknown'].includes(rawStatus) ? rawStatus : 'unknown',
      sourceStatus: normalizedResolverSourceText(source?.sourceStatus),
      lastQuoteAt: normalizeLoginTimestamp(source?.lastQuoteAt),
      errorCode: normalizedResolverSourceText(source?.errorCode),
    }];
  }).sort((left, right) => (
    [...RESOLVER_FUTURE_SYMBOLS].indexOf(left.symbol)
      - [...RESOLVER_FUTURE_SYMBOLS].indexOf(right.symbol)
  ));
}

function normalizeResolverSourcesService(service, definition, checkedAt) {
  const rawStatus = String(service?.status || '').trim().toLowerCase();
  const status = VALID_SERVICE_STATUSES.has(rawStatus) ? rawStatus : 'unknown';
  const suppliedDetails = new Map(
    (Array.isArray(service?.details) ? service.details : [])
      .filter((detail) => detail && typeof detail === 'object')
      .map((detail) => [String(detail.id || ''), detail]),
  );
  const details = DETAIL_DEFINITIONS[definition.id].map((detailDefinition) => {
    const source = suppliedDetails.get(detailDefinition.id) || {};
    const detailStatus = normalizedResolverSourceStatus(source.status);
    const sourceStatus = normalizedResolverSourceText(source.sourceStatus);
    const observedAt = normalizeLoginTimestamp(source.observedAt);
    const lastSuccessAt = normalizeLoginTimestamp(source.lastSuccessAt);
    const neutral = source.neutral === true;
    const base = {
      ...detailDefinition,
      status: detailStatus,
      sourceStatus,
      neutral,
      observedAt,
      lastSuccessAt,
      date: observedAt || lastSuccessAt || checkedAt,
      reason: detailStatus === 'online' ? '' : missingCheckReason(source, detailDefinition.label),
      statusLabel: typeof source.statusLabel === 'string' && source.statusLabel.trim()
        ? source.statusLabel.trim().slice(0, 40)
        : neutral && detailStatus === 'unknown' && sourceStatus === 'not_started'
          ? 'Not observed'
          : null,
    };

    if (detailDefinition.id === 'ibkr-dated-futures') {
      const coverage = {
        requested: normalizedResolverCount(source.coverage?.requested),
        verified: normalizedResolverCount(source.coverage?.verified),
        rejected: normalizedResolverCount(source.coverage?.rejected),
        status: normalizedResolverSourceText(source.coverage?.status),
      };
      const optionalCoverage = {
        requested: normalizedResolverCount(source.optionalCoverage?.requested),
        verified: normalizedResolverCount(source.optionalCoverage?.verified),
        rejected: normalizedResolverCount(source.optionalCoverage?.rejected),
      };
      const symbols = normalizeResolverSymbols(source.symbols);
      const hasCoverage = coverage.requested !== null && coverage.verified !== null;
      const proxyStatus = symbols.find(({ symbol }) => symbol === 'CLU6')?.status;
      const proxySummary = proxyStatus === 'online'
        ? 'CLU6 optional proxy live'
        : proxyStatus === 'offline'
          ? 'CLU6 optional proxy unavailable'
          : 'CLU6 optional proxy unverified';
      return {
        ...base,
        coverage,
        optionalCoverage,
        symbols,
        summary: hasCoverage
          ? `${coverage.verified}/${coverage.requested} exact verified · ${proxySummary}`
          : detailDefinition.summary,
      };
    }

    if (detailDefinition.id === 'bls-cpi-publication') {
      const releaseAt = normalizeLoginTimestamp(source.releaseAt);
      const windowOpensAt = normalizeLoginTimestamp(source.windowOpensAt);
      const due = source.due === true;
      const released = source.released === true;
      const scheduled = neutral && !due && sourceStatus === 'pending_release';
      return {
        ...base,
        releaseAt,
        reportMonth: normalizedResolverSourceText(source.reportMonth),
        windowOpensAt,
        due,
        released,
        sources: {
          release: normalizedResolverSourceText(source.sources?.release),
          rss: normalizedResolverSourceText(source.sources?.rss),
          api: normalizedResolverSourceText(source.sources?.api),
        },
        date: releaseAt || base.date,
        summary: scheduled
          ? 'Official CPI release · outside verification window'
          : detailDefinition.summary,
        statusLabel: scheduled ? 'Scheduled' : base.statusLabel,
      };
    }

    return base;
  });
  return {
    ...definition,
    status,
    date: checkedAt,
    reason: status === 'online' ? '' : missingCheckReason(service, definition.label),
    details,
  };
}

function normalizeService(service, definition, checkedAt) {
  if (definition.id === 'resolver-sources') {
    return normalizeResolverSourcesService(service, definition, checkedAt);
  }
  const rawStatus = String(service?.status || '').trim().toLowerCase();
  const status = VALID_SERVICE_STATUSES.has(rawStatus) ? rawStatus : 'unknown';
  const suppliedDetails = new Map(
    (Array.isArray(service?.details) ? service.details : [])
      .filter((detail) => detail && typeof detail === 'object')
      .map((detail) => [String(detail.id || ''), detail]),
  );
  const details = DETAIL_DEFINITIONS[definition.id].map((detailDefinition) => {
    const detail = suppliedDetails.get(detailDefinition.id);
    const rawDetailStatus = String(detail?.status || '').trim().toLowerCase();
    const detailStatus = VALID_SERVICE_STATUSES.has(rawDetailStatus)
      ? rawDetailStatus
      : 'unknown';
    return {
      ...detailDefinition,
      status: detailStatus,
      date: checkedAt,
      reason: detailStatus === 'online'
        ? ''
        : missingCheckReason(detail, detailDefinition.label),
    };
  });
  return {
    ...definition,
    status,
    date: checkedAt,
    reason: status === 'online' ? '' : missingCheckReason(service, definition.label),
    details,
  };
}

export function deriveSystemRailStatus(services = []) {
  const dashboard = services.find((service) => service.id === 'dashboard');
  if (!dashboard || dashboard.status === 'unknown') return 'unknown';
  if (dashboard.status === 'offline') return 'offline';
  return services.some((service) => (
    service.nonCore !== true && !['online', 'closed'].includes(service.status)
  ))
    ? 'attention'
    : 'online';
}

export function derivePanelRailStatus(services = [], products = []) {
  const servicesStatus = deriveSystemRailStatus(services);
  if (servicesStatus === 'offline' || servicesStatus === 'unknown') return servicesStatus;
  const productsStatus = deriveProductsStatus(products);
  return servicesStatus === 'attention' || !['online', 'closed'].includes(productsStatus)
    ? 'attention'
    : 'online';
}

export function normalizeSystemStatus(payload, now = Date.now()) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('System status response was not a valid object.');
  }

  const checkedAt = new Date(payload.checkedAt || '');
  if (!Number.isFinite(checkedAt.getTime())) {
    throw new Error('The status check returned no valid observation time.');
  }
  const statusAgeMs = now - checkedAt.getTime();
  if (statusAgeMs > MAX_STATUS_AGE_MS || statusAgeMs < -MAX_FUTURE_CLOCK_SKEW_MS) {
    throw new Error(statusAgeMs < 0
      ? 'The status check returned a future observation time.'
      : 'The status check returned a result more than 30 seconds old.');
  }

  const suppliedServices = new Map(
    (Array.isArray(payload.services) ? payload.services : [])
      .filter((service) => service && typeof service === 'object')
      .map((service) => [String(service.id || ''), service]),
  );
  const services = SERVICE_DEFINITIONS.map((definition) => (
    normalizeService(suppliedServices.get(definition.id), definition, checkedAt.toISOString())
  ));

  return {
    checkedAt: checkedAt.toISOString(),
    services,
    railStatus: deriveSystemRailStatus(services),
  };
}

function formatStatusDate(value) {
  if (!value) return '—';
  const normalized = String(value).trim();
  const dateOnly = normalized.match(/^(\d{4}-\d{2}-\d{2})$/);
  if (dateOnly) return dateOnly[1];
  const parsed = new Date(normalized);
  if (!Number.isFinite(parsed.getTime())) return '—';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(parsed);
  const values = Object.fromEntries(parts.map(({ type, value: partValue }) => [type, partValue]));
  return `${values.year}-${values.month}-${values.day}`;
}

function formatLoginTimestamp(value) {
  if (!value) return '—';
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return '—';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'short',
  }).format(parsed);
}

function formatLoginState(value) {
  const state = String(value || 'unverified');
  if (state === 'connected' || state === 'fresh') return 'Online';
  if (state === 'signed_out') return 'Signed out';
  if (state === 'socket_disabled') return 'API socket disabled';
  if (state === 'sidecar_unavailable') return 'Sidecar unavailable';
  if (state === 'wrong_principal') return 'Wrong principal';
  if (state === 'forbidden') return 'Authorization denied';
  if (state === 'not_configured') return 'Attention';
  return state
    .split('_')
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

function errorMessage(error) {
  return error?.response?.data?.error
    || error?.response?.data?.message
    || error?.message
    || 'Status unavailable';
}

function statusCheckFailureReason(error) {
  const message = cleanReason(errorMessage(error));
  if (/timeout|timed out/i.test(message) || ['ECONNABORTED', 'ETIMEDOUT'].includes(error?.code)) {
    return 'The status service did not respond in time.';
  }
  if (/network error|failed to fetch/i.test(message) || error?.code === 'ERR_NETWORK') {
    return 'The browser could not reach the status service.';
  }
  return message || 'The status service returned no usable result.';
}

function isActiveLoginAction(action) {
  return ['awaiting_user', 'verifying'].includes(String(action?.state || ''));
}

function loginActionStatusLabel(actionId, action) {
  const state = String(action?.state || 'idle');
  if (state === 'awaiting_user') {
    return actionId === 'aws-admin-login'
      ? 'Waiting for browser authorization'
      : actionId === 'open-ibkr-gateway'
        ? 'Waiting for IBKR login'
        : 'Waiting for user action';
  }
  if (state === 'verifying') {
    return actionId === 'aws-admin-login'
      ? 'Verifying AWS administrator role'
      : actionId === 'open-ibkr-gateway'
        ? 'Verifying IBKR socket and portfolio'
        : 'Verifying action';
  }
  if (state === 'ready') return 'Verified';
  if (state === 'failed') return action?.errorCode ? `Failed · ${action.errorCode}` : 'Failed';
  return '';
}

const SystemReadinessPanel = ({
  open = true,
  onClose,
  onStatusChange,
  dashboardCards = {},
  resolverMarketId = null,
}) => {
  const { theme } = useTheme();
  const [services, setServices] = useState(() => [
    unknownLoginService('', true),
    ...unknownServices('', true),
  ]);
  const [products, setProducts] = useState(() => unknownProducts('', true));
  const [coreCheckError, setCoreCheckError] = useState(null);
  const [marketSession, setMarketSession] = useState('open');
  const [refreshing, setRefreshing] = useState(false);
  const [coreCheckedAt, setCoreCheckedAt] = useState(null);
  const [coreExpired, setCoreExpired] = useState(false);
  const coreCheckedAtRef = useRef(null);
  const [actionFeedback, setActionFeedback] = useState({});
  const [expandedServiceId, setExpandedServiceId] = useState(null);
  const [expandedDetailKeys, setExpandedDetailKeys] = useState(() => new Set());
  const [productsExpanded, setProductsExpanded] = useState(false);
  const requestIdRef = useRef(0);
  const loginRequestIdRef = useRef(0);
  const loginInFlightRef = useRef(null);
  const loginForceQueuedRef = useRef(false);
  const initialLoadCompletedRef = useRef(false);
  const openRef = useRef(open);
  const onStatusChangeRef = useRef(onStatusChange);
  const servicesRef = useRef(services);
  const loginServiceRef = useRef(services[0]);
  const coreServicesRef = useRef(services.slice(1));
  const productsRef = useRef(products);
  const lastRailStatusRef = useRef(null);
  const panelRef = useRef(null);
  openRef.current = open;
  onStatusChangeRef.current = onStatusChange;
  const normalizedDashboardCards = useMemo(
    () => normalizeDashboardCardStatuses(dashboardCards),
    [dashboardCards],
  );
  const activeLoginActionIds = useMemo(() => (
    Object.entries(services[0]?.actions || {})
      .filter(([, action]) => isActiveLoginAction(action))
      .map(([actionId]) => actionId)
  ), [services]);

  const publishRailStatus = useCallback((nextStatus) => {
    const checkedMs = Date.parse(coreCheckedAtRef.current || '');
    const status = Number.isFinite(checkedMs) && Date.now() - checkedMs > MAX_STATUS_AGE_MS
      ? 'unknown'
      : nextStatus;
    if (lastRailStatusRef.current === status) return;
    lastRailStatusRef.current = status;
    onStatusChangeRef.current?.(status);
  }, []);

  const commitServices = useCallback(({ login, core } = {}) => {
    const nextLogin = login || loginServiceRef.current;
    const nextCore = core || coreServicesRef.current;
    loginServiceRef.current = nextLogin;
    coreServicesRef.current = nextCore;
    const combined = [nextLogin, ...nextCore];
    servicesRef.current = combined;
    setServices(combined);
    publishRailStatus(derivePanelRailStatus(combined, productsRef.current));
  }, [publishRailStatus]);

  const loadLoginStatus = useCallback(({ force = false } = {}) => {
    if (loginInFlightRef.current) {
      if (force) loginForceQueuedRef.current = true;
      return loginInFlightRef.current;
    }
    const requestId = loginRequestIdRef.current + 1;
    loginRequestIdRef.current = requestId;
    if (loginServiceRef.current.details.every((detail) => detail.status === 'unknown')) {
      commitServices({ login: unknownLoginService('', true) });
    }
    const run = async () => {
      let refresh = force;
      do {
        loginForceQueuedRef.current = false;
        try {
          const payload = await MarketDataService.getLoginStatus({ refresh });
          if (requestId !== loginRequestIdRef.current || !openRef.current) return;
          commitServices({ login: normalizeLoginStatus(payload) });
        } catch (loadError) {
          if (requestId !== loginRequestIdRef.current || !openRef.current) return;
          commitServices({ login: unknownLoginService(statusCheckFailureReason(loadError)) });
        }
        refresh = loginForceQueuedRef.current;
      } while (refresh && requestId === loginRequestIdRef.current && openRef.current);
    };
    const request = run().finally(() => {
      if (loginInFlightRef.current === request) loginInFlightRef.current = null;
    });
    loginInFlightRef.current = request;
    return request;
  }, [commitServices]);

  const load = useCallback(async ({ forceLogins = false } = {}) => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setRefreshing(true);
    setCoreCheckError(null);
    if (coreServicesRef.current.every((service) => service.status === 'unknown')) {
      commitServices({ core: unknownServices('', true) });
    }
    if (productsRef.current.every((product) => product.status === 'unknown')) {
      const checkingProducts = unknownProducts('', true);
      productsRef.current = checkingProducts;
      setProducts(checkingProducts);
    }

    const systemRequest = MarketDataService.getSystemStatus({ marketId: resolverMarketId })
      .then((payload) => {
        if (requestId !== requestIdRef.current) return;
        const normalized = normalizeSystemStatus(payload);
        coreCheckedAtRef.current = normalized.checkedAt;
        setCoreCheckedAt(normalized.checkedAt);
        setCoreExpired(false);
        commitServices({ core: normalized.services });
      })
      .catch((loadError) => {
        if (requestId !== requestIdRef.current) return;
        // Failed verification invalidates every previously displayed status.
        const reason = statusCheckFailureReason(loadError);
        coreCheckedAtRef.current = null;
        initialLoadCompletedRef.current = false;
        setCoreCheckedAt(null);
        setCoreExpired(false);
        setCoreCheckError(reason);
        commitServices({ core: unknownServices(reason) });
      });

    const productsRequest = MarketDataService.getHedgeyeFreshness()
      .then((payload) => {
        if (requestId !== requestIdRef.current) return;
        try {
          const normalizedProducts = normalizeHedgeyeProducts(payload);
          setMarketSession(normalizedProducts[0]?.marketSession || 'open');
          productsRef.current = normalizedProducts;
          setProducts(normalizedProducts);
          publishRailStatus(derivePanelRailStatus(servicesRef.current, normalizedProducts));
        } catch (loadError) {
          const unavailable = unknownProducts(statusCheckFailureReason(loadError));
          productsRef.current = unavailable;
          setProducts(unavailable);
          publishRailStatus(derivePanelRailStatus(servicesRef.current, unavailable));
        }
      })
      .catch((loadError) => {
        if (requestId !== requestIdRef.current) return;
        const unavailable = unknownProducts(statusCheckFailureReason(loadError));
        productsRef.current = unavailable;
        setProducts(unavailable);
        publishRailStatus(derivePanelRailStatus(servicesRef.current, unavailable));
      });

    const loginRequest = loadLoginStatus({ force: forceLogins });
    await Promise.allSettled([loginRequest, systemRequest, productsRequest]);

    if (requestId === requestIdRef.current) {
      initialLoadCompletedRef.current = Boolean(coreCheckedAtRef.current)
        && coreServicesRef.current.every((service) => service.status !== 'unknown');
      setRefreshing(false);
    }
  }, [commitServices, loadLoginStatus, publishRailStatus, resolverMarketId]);

  const runLoginRecovery = useCallback(async (detail) => {
    const actionId = detail?.recovery?.actionId;
    const action = loginServiceRef.current?.actions?.[actionId];
    if (!LOGIN_LOCAL_ACTIONS[actionId] || isActiveLoginAction(action)) return;
    setActionFeedback((current) => ({ ...current, [detail.id]: null }));
    try {
      await MarketDataService.runLoginAction(actionId);
      setActionFeedback((current) => ({
        ...current,
        [detail.id]: actionId === 'aws-admin-login'
          ? 'Interactive flow launched. Complete browser authorization; AWS role verification is pending.'
          : actionId === 'open-ibkr-gateway'
            ? 'IB Gateway launched. Complete login; socket and portfolio verification is pending.'
            : 'Interactive flow launched; verification is pending.',
      }));
      await loadLoginStatus();
    } catch (error) {
      setActionFeedback((current) => ({
        ...current,
        [detail.id]: `The approved action could not be started: ${cleanReason(errorMessage(error))}`,
      }));
      await loadLoginStatus();
    }
  }, [loadLoginStatus]);

  useEffect(() => {
    if (!open || initialLoadCompletedRef.current) return undefined;
    load();
    return () => {
      requestIdRef.current += 1;
      loginRequestIdRef.current += 1;
      loginForceQueuedRef.current = false;
      loginInFlightRef.current = null;
    };
  }, [load, open]);

  useEffect(() => {
    if (!open) return undefined;
    return startVisibilityAwarePolling({
      poll: loadLoginStatus,
      intervalMs: activeLoginActionIds.length > 0
        ? ACTIVE_LOGIN_POLL_INTERVAL_MS
        : LOGIN_POLL_INTERVAL_MS,
    });
  }, [activeLoginActionIds.length, loadLoginStatus, open]);

  useEffect(() => {
    if (!coreCheckedAt) return undefined;
    const expire = () => {
      setCoreExpired(true);
      publishRailStatus('unknown');
    };
    const remaining = Date.parse(coreCheckedAt) + MAX_STATUS_AGE_MS - Date.now() + 1;
    if (remaining <= 0) {
      expire();
      return undefined;
    }
    const timer = setTimeout(expire, remaining);
    return () => clearTimeout(timer);
  }, [coreCheckedAt, publishRailStatus]);

  useEffect(() => {
    if (!open || typeof document === 'undefined') return undefined;
    const handleOutsideMouseDown = (event) => {
      if (event.target?.closest?.('.efr-status-popover')) return;
      // Let the Systems rail button own its toggle. Closing here on mousedown
      // and toggling again on click would immediately reopen the flyout.
      if (event.target?.closest?.('[data-navigation-item-id="system"]')) return;
      if (panelRef.current && !panelRef.current.contains(event.target)) onClose?.();
    };
    const handleEscape = (event) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault();
        onClose?.();
      }
    };
    document.addEventListener('mousedown', handleOutsideMouseDown);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleOutsideMouseDown);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [onClose, open]);

  return (
    <section
      ref={panelRef}
      className={`sr-panel ${theme === 'dark' ? 'sr-panel--dark' : ''}`}
      role={open ? 'dialog' : undefined}
      aria-label={open ? 'Systems' : undefined}
      aria-busy={refreshing || undefined}
    >
      <header className="sr-panel__toolbar">
        <h2>Systems</h2>
        <button type="button" className="sr-panel__close" aria-label="Close Systems" onClick={onClose}>
          <span aria-hidden="true">×</span>
        </button>
        <RefreshButton
          label="Refresh systems"
          title="Refresh systems"
          loading={refreshing}
          iconOnly
          onClick={() => load({ forceLogins: true })}
        />
      </header>

      {coreCheckError && (
        <p className="sr-check-age" role="alert">
          Status check failed. {coreCheckError} Use Refresh to retry.
        </p>
      )}
      {coreCheckedAt && (
        <p className="sr-check-age" role="status">
          {coreExpired ? 'Last checked' : 'Checked'} {formatLoginTimestamp(coreCheckedAt)}
          {coreExpired ? ' · Status expired; refresh to verify current health.' : ''}
        </p>
      )}
      <ul className="sr-services" aria-label={coreExpired ? 'Last checked system status' : 'Current system status'}>
        {services.map((service) => {
          const meta = service.checking
            ? STATUS_META.checking
            : coreExpired && service.id !== LOGIN_SERVICE_DEFINITION.id
              ? { label: `Last checked · ${STATUS_META[service.status].label}`, glyph: '◷' }
              : STATUS_META[service.status];
          const expanded = expandedServiceId === service.id;
          const checklistId = `sr-details-${service.id}`;
          const loginCategory = service.id === LOGIN_SERVICE_DEFINITION.id;
          return (
            <li
              className={loginCategory ? 'sr-login-service' : undefined}
              data-status={service.status}
              key={service.id}
            >
              <div
                className={`sr-service__summary${expanded ? ' sr-service__summary--expanded' : ''}`}
                data-testid={`system-service-summary-${service.id}`}
              >
                <button
                  type="button"
                  className="sr-service__toggle sr-service__trigger"
                  aria-expanded={expanded}
                  aria-controls={checklistId}
                  aria-label={`${expanded ? 'Collapse' : 'Expand'} ${service.label} checklist`}
                  onClick={() => {
                    setExpandedServiceId(expanded ? null : service.id);
                    setExpandedDetailKeys(new Set());
                    setProductsExpanded(false);
                  }}
                >
                  <span className="sr-chevron" aria-hidden="true" />
                  <strong>{service.label}</strong>
                </button>
                <span className="sr-service__date" title={formatLoginTimestamp(service.date)}>{formatStatusDate(service.date)}</span>
                <span className="sr-service__scope" title={service.reason || undefined}>
                  {service.status === 'unknown' && !service.checking && !coreCheckError
                    ? service.reason
                    : service.summary}
                </span>
                <span className="sr-service__result">
                  <span className="sr-service__status">
                    <i aria-hidden="true">{meta.glyph}</i>
                    {meta.label}
                  </span>
                </span>
              </div>
              {expanded ? (
                <>
                  <ul
                    className="sr-service__details"
                    id={checklistId}
                    aria-label={`${service.label} checklist`}
                  >
                    <li className="sr-section__column-headings" aria-hidden="true">
                      <span>Service</span>
                      <span>{loginCategory ? 'Verification' : 'Date'}</span>
                      <span>{loginCategory ? 'Purpose' : 'Description'}</span>
                      <span>{loginCategory ? 'State' : 'Status'}</span>
                    </li>
                    {service.details.map((detail) => {
                      const detailMeta = DETAIL_STATUS_META[detail.checking ? 'checking' : detail.status];
                      const actionId = detail.recovery?.actionId;
                      const action = actionId ? service.actions?.[actionId] : null;
                      const actionActive = isActiveLoginAction(action);
                      const actionStatus = actionId ? loginActionStatusLabel(actionId, action) : '';
                      const detailKey = `${service.id}:${detail.id}`;
                      const detailExpanded = expandedDetailKeys.has(detailKey);
                      const reasonId = `sr-detail-reason-${service.id}-${detail.id}`;
                      const hasReason = Boolean(detail.reason);
                      const hasExplanation = hasReason
                        || Boolean(detail.recovery)
                        || Boolean(actionStatus)
                        || Boolean(actionFeedback[detail.id]);
                      return (
                        <li data-status={detail.status} key={detail.id}>
                          {hasExplanation ? (
                            <button
                              type="button"
                              className="sr-service__toggle sr-service__detail-toggle"
                              aria-expanded={detailExpanded}
                              aria-controls={reasonId}
                              aria-label={`${detailExpanded ? 'Collapse' : 'Expand'} ${detail.label} ${loginCategory ? 'login details' : 'issue'}`}
                              onClick={() => {
                                setExpandedDetailKeys((currentKeys) => {
                                  const nextKeys = new Set(currentKeys);
                                  if (nextKeys.has(detailKey)) nextKeys.delete(detailKey);
                                  else nextKeys.add(detailKey);
                                  return nextKeys;
                                });
                              }}
                            >
                              <span className="sr-chevron" aria-hidden="true" />
                              <span className="sr-service__detail-label">{detail.label}</span>
                            </button>
                          ) : (
                            <span className="sr-service__detail-label">{detail.label}</span>
                          )}
                          {loginCategory ? (
                            <span className="sr-service__detail-date sr-login__timestamps">
                              <span title={detail.verifiedAt || detail.checkedAt || undefined}>
                                {detail.verifiedAt ? 'Verified ' : 'Checked '}
                                {formatLoginTimestamp(detail.verifiedAt || detail.checkedAt)}
                              </span>
                              {detail.expiresAt ? (
                                <span title={detail.expiresAt}>
                                  Expires {formatLoginTimestamp(detail.expiresAt)}
                                </span>
                              ) : null}
                            </span>
                          ) : (
                            <span className="sr-service__detail-date">{formatStatusDate(detail.date)}</span>
                          )}
                          <span className="sr-service__detail-scope">
                            <span>{detail.summary}</span>
                            {loginCategory ? (
                              <small>{detail.required ? 'Required' : 'Optional'}</small>
                            ) : null}
                          </span>
                          <span className="sr-service__detail-result">
                            <span className="sr-service__detail-status">
                              <i aria-hidden="true">{detailMeta.glyph}</i>
                              {loginCategory && !detail.checking
                                ? formatLoginState(detail.state)
                                : detail.statusLabel || detailMeta.label}
                            </span>
                          </span>
                          {hasExplanation && detailExpanded ? (
                            <div className="sr-service__detail-explanation" id={reasonId}>
                              <strong>{hasReason || action?.state === 'failed' ? 'ISSUE' : 'RECOVERY'}</strong>
                              {hasReason ? (
                                <ul className="sr-service__detail-reasons">
                                  {reasonBullets(detail.reason).map((bullet) => (
                                    <li key={bullet}>{bullet}</li>
                                  ))}
                                </ul>
                              ) : null}
                              {detail.recovery?.kind === 'local-action' ? (
                                <button
                                  type="button"
                                  className="sr-login__recovery-action"
                                  disabled={actionActive}
                                  onClick={() => runLoginRecovery(detail)}
                                >
                                  {actionActive
                                    ? (action?.state === 'awaiting_user' ? 'Waiting…' : 'Verifying…')
                                    : action?.state === 'failed'
                                      ? `Retry ${detail.recovery.label}`
                                    : detail.recovery.label}
                                </button>
                              ) : null}
                              {detail.recovery?.kind === 'external-link' ? (
                                <a
                                  className="sr-login__recovery-action"
                                  href={detail.recovery.href}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  {detail.recovery.label}
                                </a>
                              ) : null}
                              {actionFeedback[detail.id] ? (
                                <span className="sr-login__action-feedback" role="status">
                                  {actionFeedback[detail.id]}
                                </span>
                              ) : null}
                              {actionStatus ? (
                                <span className="sr-login__action-feedback" role="status">
                                  {actionStatus}
                                </span>
                              ) : null}
                            </div>
                          ) : null}
                        </li>
                      );
                    })}
                    {service.id === 'dashboard' ? DASHBOARD_CARD_DEFINITIONS.map((definition) => {
                      const card = normalizedDashboardCards[definition.id] || definition;
                      const statusOptions = {
                        marketSession,
                        sourceDate: card.sourceDate,
                        issues: card.issues,
                      };
                      const systemStatus = getDashboardSystemStatus(card.status, statusOptions);
                      const systemMeta = DASHBOARD_SYSTEM_STATUS_META[systemStatus];
                      return (
                        <li
                          data-status={systemStatus}
                          data-dashboard-status={card.status}
                          data-testid={`system-dashboard-card-${definition.id}`}
                          key={definition.id}
                        >
                          <span>{definition.label}</span>
                          <span className="sr-service__detail-date">
                            {formatStatusDate(card.sourceDate || card.date)}
                          </span>
                          <span className="sr-service__detail-scope">
                            {card.summary || definition.summary}
                          </span>
                          <span className="sr-service__detail-result">
                            <DataStatusChip
                              status={getDashboardDataStatus(card.status, statusOptions)}
                              label={systemMeta.label}
                              summary={systemMeta.summary}
                              detail={card.detail}
                              context={`Dashboard · ${definition.label}`}
                              diagnostics={card.diagnostics}
                              issues={card.issues}
                              compact
                              plain
                              showDetail={false}
                            />
                          </span>
                        </li>
                      );
                    }) : null}
                  </ul>
                </>
              ) : null}
            </li>
          );
        })}
        <li className="sr-products-row" data-status={deriveProductsStatus(products)}>
          <div
            className={`sr-service__summary${productsExpanded ? ' sr-service__summary--expanded' : ''}`}
            data-testid="system-service-summary-products"
          >
            <button
              type="button"
              className="sr-service__toggle sr-service__trigger"
              aria-expanded={productsExpanded}
              aria-controls="sr-products-list"
              aria-label={`${productsExpanded ? 'Collapse' : 'Expand'} Products`}
              onClick={() => {
                setProductsExpanded(!productsExpanded);
                setExpandedServiceId(null);
                setExpandedDetailKeys(new Set());
              }}
            >
              <span className="sr-chevron" aria-hidden="true" />
              <strong>Products</strong>
            </button>
            <span className="sr-service__date">{formatStatusDate(products[0]?.checkedAt)}</span>
            <span className="sr-service__scope" title={products[0]?.reason || undefined}>
              {deriveProductsStatus(products) === 'unknown' && !products[0]?.checking
                ? products[0]?.reason
                : 'Hedgeye research feeds'}
            </span>
            <span className="sr-service__result">
              <span className="sr-service__status">
                <i aria-hidden="true">{STATUS_META[products[0]?.checking ? 'checking' : deriveProductsStatus(products)].glyph}</i>
                {STATUS_META[products[0]?.checking ? 'checking' : deriveProductsStatus(products)].label}
              </span>
            </span>
          </div>
          {productsExpanded ? (
            <ul
              className="sr-product__details"
              id="sr-products-list"
              aria-label="Hedgeye products pulled by the dashboard"
            >
              <li className="sr-section__column-headings" aria-hidden="true">
                <span>Service</span>
                <span>Date</span>
                <span>Description</span>
                <span>Status</span>
              </li>
              {products.map((product) => {
                const meta = STATUS_META[product.checking ? 'checking' : product.status];
                const productKey = `products:${product.id}`;
                const productExpanded = expandedDetailKeys.has(productKey);
                const reasonId = `sr-product-reason-${product.id}`;
                const hasReason = Boolean(product.reason);
                return (
                  <li data-status={product.status} key={product.id}>
                    {hasReason ? (
                      <button
                        type="button"
                        className="sr-service__toggle sr-product__toggle"
                        aria-expanded={productExpanded}
                        aria-controls={reasonId}
                        aria-label={`${productExpanded ? 'Collapse' : 'Expand'} ${product.label} issue`}
                        onClick={() => {
                          setExpandedDetailKeys((currentKeys) => {
                            const nextKeys = new Set(currentKeys);
                            if (nextKeys.has(productKey)) nextKeys.delete(productKey);
                            else nextKeys.add(productKey);
                            return nextKeys;
                          });
                        }}
                      >
                        <span className="sr-chevron" aria-hidden="true" />
                        <strong className="sr-product__label">{product.label}</strong>
                      </button>
                    ) : (
                      <strong className="sr-product__label">{product.label}</strong>
                    )}
                    <span className="sr-product__date">{formatStatusDate(product.date)}</span>
                    <span className="sr-product__description">{product.summary}</span>
                    <span className="sr-product__status">
                      <i aria-hidden="true">{meta.glyph}</i>
                      {meta.label}
                    </span>
                    {hasReason && productExpanded ? (
                      <div className="sr-service__detail-explanation" id={reasonId}>
                        <strong>ISSUE</strong>
                        <ul className="sr-service__detail-reasons">
                          {reasonBullets(product.reason).map((bullet) => (
                            <li key={bullet}>{bullet}</li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : null}
        </li>
      </ul>
    </section>
  );
};

export {
  DETAIL_DEFINITIONS,
  DETAIL_STATUS_META,
  HEDGEYE_PRODUCT_DEFINITIONS,
  SERVICE_DEFINITIONS,
  STATUS_META,
};
export default SystemReadinessPanel;
