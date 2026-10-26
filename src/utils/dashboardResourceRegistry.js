import exchangeVolume from './exchangeVolume.cjs';
import { reconcileVolatilitySnapshot } from './volatilitySnapshotRows';
import { reconcileMarketQuotePayload } from './marketQuoteFreshness';

const { isVerifiedExchangeVolumeResponse } = exchangeVolume;

export const DASHBOARD_RESOURCE_CLASSIFICATIONS = Object.freeze({
  DATED_REFERENCE: 'dated-reference',
  INFORMATIONAL_LIVE: 'informational-live',
  EXECUTABLE_LIVE: 'executable-live',
  MIXED: 'mixed',
});

const CLASSIFICATIONS = new Set(Object.values(DASHBOARD_RESOURCE_CLASSIFICATIONS));

const identity = (value) => value;
const requireObject = (value) => (
  value && typeof value === 'object' ? value : null
);

const requireRows = (value) => (
  requireObject(value) && Array.isArray(value.rows) ? value : null
);

const requireLots = (value) => (
  requireObject(value) && Array.isArray(value.lots) ? value : null
);

const requireEvents = (value) => (
  requireObject(value) && Array.isArray(value.events) ? value : null
);

const resolveValue = (value, context) => (
  typeof value === 'function' ? value(context) : value
);

const safeString = (value, fallback = '') => {
  const normalized = String(value ?? '').trim();
  return normalized || fallback;
};

const pick = (source, keys) => Object.fromEntries(
  keys
    .filter((key) => source && Object.prototype.hasOwnProperty.call(source, key))
    .map((key) => [key, source[key]]),
);

export const projectExposureLabReference = (value) => {
  if (!value || typeof value !== 'object') return null;
  return {
    ...pick(value, [
      'asOf',
      'generatedAt',
      'snapshotDate',
      'methodology',
      'factors',
      'factorDefinitions',
      'archive',
      'history',
      'universe',
      'referenceRows',
    ]),
    referenceOnly: true,
    positions: undefined,
    balances: undefined,
    account: undefined,
    sizing: undefined,
  };
};

const storage = (eligible, key, ttlMs, projectionVersion = 1) => Object.freeze({
  eligible,
  key,
  ttlMs,
  projectionVersion,
});

const polling = (intervalMs = null, { whileHidden = false, whileDocumentHidden = false } = {}) => (
  Object.freeze({ intervalMs, whileHidden, whileDocumentHidden })
);

const definition = (id, options) => Object.freeze({
  id,
  validate: requireObject,
  freshnessSource: (data) => data?.observedAt || data?.generatedAt || data?.asOf || null,
  polling: polling(),
  storage: storage(false, null, null),
  warmup: Object.freeze({ eligible: false, providerPure: false }),
  maxAgeMs: null,
  futureToleranceMs: null,
  referenceProjection: null,
  validateReference: null,
  reconcileIncoming: null,
  accountScoped: false,
  retainOnRefreshFailure: options.classification !== DASHBOARD_RESOURCE_CLASSIFICATIONS.EXECUTABLE_LIVE,
  retainAfterExpiry: options.classification === DASHBOARD_RESOURCE_CLASSIFICATIONS.INFORMATIONAL_LIVE,
  ...options,
});

const DAY_MS = 24 * 60 * 60 * 1000;

export const DASHBOARD_RESOURCE_DEFINITIONS = Object.freeze({
  portfolio: definition('portfolio', {
    classification: DASHBOARD_RESOURCE_CLASSIFICATIONS.EXECUTABLE_LIVE,
    cacheKey: 'portfolio',
    scopeKey: ({ accountId }) => safeString(accountId, 'account-required'),
    accountScoped: true,
    maxAgeMs: 5 * 60_000,
    polling: polling(50_000, { whileHidden: true }),
  }),
  'market-quotes': definition('market-quotes', {
    classification: DASHBOARD_RESOURCE_CLASSIFICATIONS.INFORMATIONAL_LIVE,
    cacheKey: 'multi-region-market-quotes',
    scopeKey: 'current',
    polling: polling(30_000, { whileHidden: true }),
    // Dated readings last for this browser tab; their observation dates never advance on reload.
    storage: storage(true, 'market-dashboard.reference.multi-region-quotes.v1', Number.MAX_SAFE_INTEGER),
    warmup: Object.freeze({ eligible: false, providerPure: false }),
    retainOnRefreshFailure: true,
    retainAfterExpiry: true,
    reconcileIncoming: reconcileMarketQuotePayload,
  }),
  'market-period-returns': definition('market-period-returns', {
    classification: DASHBOARD_RESOURCE_CLASSIFICATIONS.DATED_REFERENCE,
    cacheKey: 'multi-region-market-quotes',
    scopeKey: 'period-returns',
    polling: polling(15 * 60_000, { whileHidden: true }),
    storage: storage(true, 'market-dashboard.reference.multi-region-period-returns.v1', Number.MAX_SAFE_INTEGER),
    retainAfterExpiry: true,
    reconcileIncoming: reconcileMarketQuotePayload,
  }),
  volatility: definition('volatility', {
    // An informational record of provider observations, each with its own date.
    classification: DASHBOARD_RESOURCE_CLASSIFICATIONS.DATED_REFERENCE,
    cacheKey: 'volatility-snapshot',
    scopeKey: ({ backendUrl }) => safeString(backendUrl, 'dashboard'),
    polling: polling(60_000),
    storage: storage(true, 'market-dashboard.reference.volatility.v1', Number.MAX_SAFE_INTEGER),
    retainOnRefreshFailure: true,
    retainAfterExpiry: true,
    reconcileIncoming: reconcileVolatilitySnapshot,
  }),
  'usd-correlations': definition('usd-correlations', {
    classification: DASHBOARD_RESOURCE_CLASSIFICATIONS.DATED_REFERENCE,
    cacheKey: 'usd-correlations',
    scopeKey: 'dashboard',
    storage: storage(true, 'market-dashboard.reference.usd-correlations.v1', 30 * DAY_MS),
  }),
  'market-events': definition('market-events', {
    classification: DASHBOARD_RESOURCE_CLASSIFICATIONS.INFORMATIONAL_LIVE,
    cacheKey: 'market-events',
    scopeKey: ({ week }) => (week === 'next' ? 'forex-factory-next-week' : 'forex-factory-current-week'),
    polling: polling(5 * 60_000),
    storage: storage(true, ({ week }) => (week === 'next'
      ? 'market-dashboard.reference.market-events.next-week.v1'
      : 'market-dashboard.reference.market-events.v1'), 8 * DAY_MS),
  }),
  cftc: definition('cftc', {
    classification: DASHBOARD_RESOURCE_CLASSIFICATIONS.DATED_REFERENCE,
    cacheKey: 'dashboard-reference',
    scopeKey: 'cftc-positioning',
    storage: storage(true, 'market-dashboard.reference.cftc-positioning.v1', 30 * DAY_MS),
    warmup: Object.freeze({ eligible: true, providerPure: true }),
  }),
  'global-quads': definition('global-quads', {
    classification: DASHBOARD_RESOURCE_CLASSIFICATIONS.DATED_REFERENCE,
    cacheKey: 'dashboard-reference',
    scopeKey: 'global-quads',
    storage: storage(true, 'market-dashboard.reference.global-quads.v1', 365 * DAY_MS),
  }),
  'market-situation': definition('market-situation', {
    classification: DASHBOARD_RESOURCE_CLASSIFICATIONS.DATED_REFERENCE,
    cacheKey: 'market-structure-report',
    scopeKey: ({ requestedDate }) => safeString(requestedDate, 'latest'),
    storage: storage(true, 'market-dashboard.reference.market-situation.v2', 30 * DAY_MS),
    warmup: Object.freeze({ eligible: true, providerPure: true }),
  }),
  'dollar-liquidity': definition('dollar-liquidity', {
    classification: DASHBOARD_RESOURCE_CLASSIFICATIONS.DATED_REFERENCE,
    cacheKey: 'dashboard-reference',
    scopeKey: 'dollar-liquidity',
    storage: storage(true, 'market-dashboard.reference.dollar-liquidity.v1', 30 * DAY_MS),
    warmup: Object.freeze({ eligible: true, providerPure: true }),
  }),
  'money-flow': definition('money-flow', {
    classification: DASHBOARD_RESOURCE_CLASSIFICATIONS.DATED_REFERENCE,
    cacheKey: 'dashboard-reference',
    scopeKey: 'money-flow',
    storage: storage(true, 'market-dashboard.reference.money-flow.v1', 30 * DAY_MS),
    warmup: Object.freeze({ eligible: true, providerPure: true }),
  }),
  'market-volume': definition('market-volume', {
    classification: DASHBOARD_RESOURCE_CLASSIFICATIONS.DATED_REFERENCE,
    cacheKey: 'market-share-volume-v2',
    scopeKey: '365-days',
    validate: value => isVerifiedExchangeVolumeResponse(value) ? value : null,
    retainOnRefreshFailure: false,
    retainAfterExpiry: false,
    storage: storage(false),
    warmup: Object.freeze({ eligible: true, providerPure: true }),
  }),
  'performance-history': definition('performance-history', {
    classification: DASHBOARD_RESOURCE_CLASSIFICATIONS.DATED_REFERENCE,
    cacheKey: 'performance-realized-history',
    scopeKey: ({ period }) => safeString(period, 'ytd'),
    validate: requireLots,
    freshnessSource: (data) => data?.generatedAt || data?.asOf || data?.endDate || null,
    // Realized account history is retained only in memory for this tab.
    storage: storage(false, null, null),
    warmup: Object.freeze({ eligible: false, providerPure: false }),
  }),
  workflow: definition('workflow', {
    classification: DASHBOARD_RESOURCE_CLASSIFICATIONS.DATED_REFERENCE,
    cacheKey: 'workflow-status',
    scopeKey: 'latest',
    validate: requireEvents,
    freshnessSource: (data) => data?.resourceObservedAt
      || data?.generatedAt
      || data?.asOf
      || data?.date,
    polling: polling(5 * 60_000),
    storage: storage(true, 'market-dashboard.reference.workflow.v1', 7 * DAY_MS),
    warmup: Object.freeze({ eligible: true, providerPure: true }),
  }),
  'signal-strength-research': definition('signal-strength-research', {
    classification: DASHBOARD_RESOURCE_CLASSIFICATIONS.DATED_REFERENCE,
    cacheKey: 'signal-strength-research',
    scopeKey: 'current-universe',
    storage: storage(true, 'market-dashboard.reference.signal-strength.v1', 30 * DAY_MS),
    warmup: Object.freeze({ eligible: true, providerPure: true }),
  }),
  'signal-strength-quotes': definition('signal-strength-quotes', {
    classification: DASHBOARD_RESOURCE_CLASSIFICATIONS.EXECUTABLE_LIVE,
    cacheKey: 'signal-strength-quotes',
    scopeKey: ({ symbols }) => safeString(symbols, 'none'),
    polling: polling(30_000),
    storage: storage(false, null, null),
  }),
  securities: definition('securities', {
    classification: DASHBOARD_RESOURCE_CLASSIFICATIONS.MIXED,
    cacheKey: 'securities',
    scopeKey: 'current',
    storage: storage(false, null, null),
    warmup: Object.freeze({ eligible: false, providerPure: false }),
  }),
  'exposure-lab-snapshot': definition('exposure-lab-snapshot', {
    classification: DASHBOARD_RESOURCE_CLASSIFICATIONS.MIXED,
    cacheKey: 'exposure-lab-snapshot',
    scopeKey: ({ accountId, portfolioScope }) => (
      `${safeString(accountId, 'account-required')}|${safeString(portfolioScope, 'unverified')}`
    ),
    accountScoped: true,
    retainOnRefreshFailure: false,
    retainAfterExpiry: false,
    storage: storage(false, null, null),
    warmup: Object.freeze({ eligible: false, providerPure: false }),
    referenceProjection: projectExposureLabReference,
    validateReference: projectExposureLabReference,
  }),
  'exposure-lab-universe': definition('exposure-lab-universe', {
    classification: DASHBOARD_RESOURCE_CLASSIFICATIONS.DATED_REFERENCE,
    cacheKey: 'exposure-lab-universe',
    scopeKey: 'security-master',
    validate: requireRows,
    freshnessSource: (data) => data?.resourceObservedAt
      || data?.asOf
      || data?.generatedAt
      || data?.meta?.generatedAt,
    storage: storage(true, 'market-dashboard.reference.exposure-lab-universe.v1', 30 * DAY_MS),
    warmup: Object.freeze({ eligible: true, providerPure: true }),
  }),
  'etf-pro': definition('etf-pro', {
    classification: DASHBOARD_RESOURCE_CLASSIFICATIONS.DATED_REFERENCE,
    cacheKey: 'etf-pro',
    scopeKey: 'latest',
    validate: (value) => (
      requireRows(value) && value.mock !== true && value.seeded !== true ? value : null
    ),
    freshnessSource: (data) => data?.meta?.snapshotDate || data?.generatedAt,
    storage: storage(true, 'market-dashboard.reference.etf-pro.v1', 30 * DAY_MS),
    warmup: Object.freeze({ eligible: true, providerPure: true }),
  }),
  'system-readiness': definition('system-readiness', {
    classification: DASHBOARD_RESOURCE_CLASSIFICATIONS.INFORMATIONAL_LIVE,
    cacheKey: 'system-readiness',
    scopeKey: 'local-stack',
    storage: storage(false, null, null),
  }),
});

export const DASHBOARD_REFRESHABLE_NAVIGATION_SURFACES = Object.freeze({
  dashboard: Object.freeze(['market-quotes', 'market-period-returns', 'volatility', 'usd-correlations', 'market-events', 'cftc', 'market-situation', 'dollar-liquidity', 'market-volume']),
  balance: Object.freeze(['portfolio']),
  performance: Object.freeze(['performance-history']),
  portfolio: Object.freeze(['portfolio', 'securities']),
  exposureLab: Object.freeze(['portfolio', 'exposure-lab-snapshot', 'exposure-lab-universe']),
  analytics: Object.freeze(['workflow']),
  ss: Object.freeze(['signal-strength-research', 'signal-strength-quotes']),
  etfPro: Object.freeze(['etf-pro']),
  system: Object.freeze(['system-readiness']),
});

export function getDashboardResourceDefinition(id) {
  const resource = DASHBOARD_RESOURCE_DEFINITIONS[id];
  if (!resource) throw new TypeError(`Unknown dashboard resource definition: ${id}`);
  return resource;
}

export function resolveDashboardResourceDefinition(id, context = {}, overrides = {}) {
  const resource = getDashboardResourceDefinition(id);
  const classification = resource.classification;
  if (!CLASSIFICATIONS.has(classification)) {
    throw new TypeError(`Dashboard resource ${id} has an invalid classification.`);
  }
  const storagePolicy = resource.storage || {};
  const storageKey = storagePolicy.eligible ? resolveValue(storagePolicy.key, context) : null;
  const baseValidate = resource.validate || identity;
  const overrideValidate = overrides.validate;
  const validate = (raw) => {
    const baseValue = baseValidate(raw, context);
    if (baseValue == null) return null;
    return typeof overrideValidate === 'function'
      ? overrideValidate(baseValue, context)
      : baseValue;
  };
  const freshnessSource = overrides.getObservedAt
    || resource.freshnessSource
    || (() => null);
  const isReference = classification === DASHBOARD_RESOURCE_CLASSIFICATIONS.DATED_REFERENCE;
  const isExecutable = classification === DASHBOARD_RESOURCE_CLASSIFICATIONS.EXECUTABLE_LIVE;
  const isMixed = classification === DASHBOARD_RESOURCE_CLASSIFICATIONS.MIXED;
  const persistence = storagePolicy.eligible && storageKey
    ? {
        key: storageKey,
        ttlMs: storagePolicy.ttlMs,
        projectionVersion: storagePolicy.projectionVersion || 1,
      }
    : null;
  return {
    ...overrides,
    definitionId: id,
    classification,
    resourceClass: classification,
    resourceKey: safeString(resolveValue(resource.cacheKey, context), id),
    scopeKey: safeString(resolveValue(resource.scopeKey, context), 'dashboard'),
    kind: isReference ? 'reference' : 'live',
    displayRole: isExecutable ? 'executable' : isMixed ? 'mixed' : 'informational',
    validate,
    getObservedAt: freshnessSource,
    maxAgeMs: overrides.maxAgeMs ?? resource.maxAgeMs ?? undefined,
    futureToleranceMs: overrides.futureToleranceMs ?? resource.futureToleranceMs ?? undefined,
    pollIntervalMs: overrides.pollIntervalMs ?? resource.polling?.intervalMs ?? null,
    pollWhenHidden: overrides.pollWhenHidden ?? resource.polling?.whileHidden ?? false,
    pollWhenDocumentHidden: overrides.pollWhenDocumentHidden
      ?? resource.polling?.whileDocumentHidden
      ?? false,
    retainOnRefreshFailure: overrides.retainOnRefreshFailure
      ?? resource.retainOnRefreshFailure,
    retainAfterExpiry: overrides.retainAfterExpiry ?? resource.retainAfterExpiry,
    persistReferenceSnapshot: overrides.persistReferenceSnapshot === undefined
      ? persistence
      : overrides.persistReferenceSnapshot,
    referenceProjection: overrides.referenceProjection || resource.referenceProjection,
    validateReference: overrides.validateReference || resource.validateReference,
    reconcileIncoming: overrides.reconcileIncoming || resource.reconcileIncoming,
    accountScoped: overrides.accountScoped ?? resource.accountScoped,
  };
}

export function assertDashboardResourceRegistryComplete() {
  const missing = [];
  Object.entries(DASHBOARD_REFRESHABLE_NAVIGATION_SURFACES).forEach(([surface, ids]) => {
    if (!Array.isArray(ids) || ids.length === 0) missing.push(surface);
    ids.forEach((id) => {
      if (!DASHBOARD_RESOURCE_DEFINITIONS[id]) missing.push(`${surface}:${id}`);
    });
  });
  return missing;
}
