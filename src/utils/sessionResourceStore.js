import { startVisibilityAwarePolling } from './visibilityAwarePolling';
import {
  clearReferenceSnapshot,
  normalizeReferenceSnapshotConfig,
  readReferenceSnapshot,
  writeReferenceSnapshot,
} from './referenceSnapshotStorage';
import { DASHBOARD_RESOURCE_CLASSIFICATIONS } from './dashboardResourceRegistry';

export const SESSION_RESOURCE_EVICT_MS = 30 * 60 * 1000;

const resources = new Map();

const INITIAL_STATE = Object.freeze({
  data: null,
  referenceData: null,
  availability: 'idle',
  observedAt: null,
  referenceObservedAt: null,
  initialLoading: false,
  refreshing: false,
  error: null,
  hydratedFromStorage: false,
  persistedAt: null,
  phase: 'first-load',
});

const RESOURCE_CLASSES = new Set(Object.values(DASHBOARD_RESOURCE_CLASSIFICATIONS));

const forbiddenLiveEvidence = /(?:^|[_\s-])(cache|cached|mock|seed|seeded|synthetic|fallback|inferred|portfolio-derived|stale|expired|offline|disconnected)(?:$|[_\s-])/i;
const forbiddenReferenceEvidence = /(?:^|[_\s-])(mock|seed|seeded|synthetic|fallback|inferred|portfolio-derived)(?:$|[_\s-])/i;

function normalizeError(error, fallback = 'Resource unavailable') {
  if (error instanceof Error) return error;
  const normalized = new Error(
    error?.message
      || error?.response?.data?.message
      || error?.response?.data?.error
      || fallback,
  );
  Object.assign(normalized, error || {});
  return normalized;
}

function errorCode(error) {
  return String(
    error?.response?.data?.errorCode
      || error?.response?.data?.code
      || error?.errorCode
      || error?.code
      || '',
  ).trim().toUpperCase();
}

export function isExplicitLiveInvalidation(error) {
  if (error?.liveInvalidation === true) return true;
  const code = errorCode(error);
  if (/(?:GATEWAY|SIDECAR|DISCONNECT|OFFLINE|ACCOUNT_MISMATCH|ACCOUNT_NOT_MANAGED|ACCOUNT_REQUIRED|STALE|EXPIRED|CACHE|MOCK|SEED)/.test(code)) {
    return true;
  }
  const message = String(
    error?.response?.data?.message
      || error?.response?.data?.error
      || error?.message
      || '',
  );
  return forbiddenLiveEvidence.test(message)
    || /connection refused|econnrefused|ibkr.*(?:offline|disconnect)|gateway.*(?:offline|disconnect)/i.test(message);
}

function liveEvidenceFailure(message, code = 'LIVE_RESOURCE_FORBIDDEN_EVIDENCE') {
  return Object.assign(new Error(message), { code, liveInvalidation: true });
}

function assertPermittedLiveEvidence(value, config) {
  if (!value || typeof value !== 'object') return;
  const metadata = value.meta && typeof value.meta === 'object' ? value.meta : {};
  const cache = value._cache && typeof value._cache === 'object' ? value._cache : {};
  const cacheStatus = String(cache.status || metadata.cacheStatus || '').trim().toLowerCase();
  if (
    value.fromCache === true
    || value.cacheOnly === true
    || metadata.fromCache === true
    || metadata.cacheOnly === true
    || cache.stale === true
    || cache.hit === true
    || ['cache', 'cached', 'hit', 'stale'].includes(cacheStatus)
  ) {
    throw liveEvidenceFailure(
      'Live resource response contained cached evidence.',
      'LIVE_RESOURCE_CACHE_EVIDENCE',
    );
  }

  if (
    value.mock === true
    || value.isMock === true
    || value.seeded === true
    || value.synthetic === true
    || value.inferred === true
    || metadata.mock === true
    || metadata.seeded === true
    || metadata.synthetic === true
    || metadata.inferred === true
  ) {
    throw liveEvidenceFailure(
      'Live resource response contained mock, seeded, synthetic, or inferred evidence.',
      'LIVE_RESOURCE_SYNTHETIC_EVIDENCE',
    );
  }

  const evidenceText = [
    value.source,
    value.status,
    value.availability,
    value.freshness,
    metadata.source,
    metadata.status,
    metadata.availability,
    metadata.freshness,
  ].filter(Boolean).join(' ');
  if (forbiddenLiveEvidence.test(evidenceText)) {
    throw liveEvidenceFailure('Live resource response was explicitly non-live or unavailable.');
  }

  if (config.expectedScope && typeof config.getScope === 'function') {
    const reportedScope = String(config.getScope(value) || '').trim();
    const expectedScope = String(config.expectedScope || '').trim();
    if (reportedScope && expectedScope && reportedScope !== expectedScope) {
      throw liveEvidenceFailure(
        'Live resource response belongs to a different account or scope.',
        'LIVE_RESOURCE_SCOPE_MISMATCH',
      );
    }
  }
}

function assertPermittedReferenceEvidence(value, config) {
  if (!value || typeof value !== 'object') return;
  const metadata = value.meta && typeof value.meta === 'object' ? value.meta : {};
  if (
    value.mock === true
    || value.isMock === true
    || value.seeded === true
    || value.synthetic === true
    || value.inferred === true
    || metadata.mock === true
    || metadata.seeded === true
    || metadata.synthetic === true
    || metadata.inferred === true
  ) {
    throw liveEvidenceFailure(
      'Reference resource response contained mock, seeded, synthetic, or inferred evidence.',
      'REFERENCE_RESOURCE_SYNTHETIC_EVIDENCE',
    );
  }
  const evidenceText = [
    value.source,
    metadata.source,
  ].filter(Boolean).join(' ');
  if (forbiddenReferenceEvidence.test(evidenceText)) {
    throw liveEvidenceFailure(
      'Reference resource response contained forbidden synthetic evidence.',
      'REFERENCE_RESOURCE_FORBIDDEN_EVIDENCE',
    );
  }
  if (config.expectedScope && typeof config.getScope === 'function') {
    const reportedScope = String(config.getScope(value) || '').trim();
    const expectedScope = String(config.expectedScope || '').trim();
    if (reportedScope && expectedScope && reportedScope !== expectedScope) {
      throw liveEvidenceFailure(
        'Reference resource response belongs to a different scope.',
        'REFERENCE_RESOURCE_SCOPE_MISMATCH',
      );
    }
  }
}

function parseObservedAt(value) {
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeFutureToleranceMs(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 5000;
}

function liveFreshnessFailure({ observedAtMs, nowMs, maxAgeMs, futureToleranceMs }) {
  const ageMs = nowMs - observedAtMs;
  const observedAt = new Date(observedAtMs).toISOString();
  const metadata = {
    observedAt,
    ageMs,
    maxAgeMs,
    futureToleranceMs,
    liveInvalidation: true,
  };
  if (ageMs < -futureToleranceMs) {
    return Object.assign(
      new Error('Verified live data has an observation timestamp beyond the allowed future tolerance.'),
      {
        ...metadata,
        code: 'LIVE_RESOURCE_FUTURE_TIMESTAMP',
        futureByMs: -ageMs,
        thresholdMs: futureToleranceMs,
      },
    );
  }
  return Object.assign(
    new Error('Verified live data is outside its freshness window.'),
    {
      ...metadata,
      code: 'LIVE_RESOURCE_STALE',
      thresholdMs: maxAgeMs,
    },
  );
}

function validateResourceConfig(config = {}) {
  const inferredClass = config.kind === 'reference'
    ? DASHBOARD_RESOURCE_CLASSIFICATIONS.DATED_REFERENCE
    : config.displayRole === 'informational'
      ? DASHBOARD_RESOURCE_CLASSIFICATIONS.INFORMATIONAL_LIVE
      : DASHBOARD_RESOURCE_CLASSIFICATIONS.EXECUTABLE_LIVE;
  const resourceClass = config.resourceClass || config.classification || inferredClass;
  if (!RESOURCE_CLASSES.has(resourceClass)) {
    throw new TypeError(`Unsupported dashboard resource classification: ${resourceClass}`);
  }
  const persistence = normalizeReferenceSnapshotConfig(config.persistReferenceSnapshot);
  if (config.persistReferenceSnapshot && !persistence) {
    throw new TypeError('persistReferenceSnapshot requires a storage key and positive ttlMs.');
  }
  const executable = resourceClass === DASHBOARD_RESOURCE_CLASSIFICATIONS.EXECUTABLE_LIVE;
  const mixed = resourceClass === DASHBOARD_RESOURCE_CLASSIFICATIONS.MIXED;
  if (persistence && executable) {
    throw new TypeError('Persisted snapshots are restricted to informational resources.');
  }
  if (persistence && config.accountScoped) {
    throw new TypeError('Account-scoped resources cannot be stored in sessionStorage.');
  }
  if (executable && config.retainOnRefreshFailure === true) {
    throw new TypeError('Executable resources cannot retain stale data after refresh failure.');
  }
  if (config.accountScoped && config.retainOnRefreshFailure === true) {
    throw new TypeError('Account-scoped resources cannot opt into stale retention.');
  }
  if (mixed && persistence && (
    typeof config.referenceProjection !== 'function'
    || typeof config.validateReference !== 'function'
  )) {
    throw new TypeError('Persisted mixed resources require a reference projection and validator.');
  }
  return {
    ...config,
    resourceClass,
    persistReferenceSnapshot: persistence,
    displayRole: config.displayRole || (
      executable ? 'executable' : mixed ? 'mixed' : 'informational'
    ),
    retainAfterExpiry: config.retainAfterExpiry === true,
  };
}

export function deriveSessionResourcePhase(candidate = INITIAL_STATE) {
  const hasData = candidate.data != null;
  const hasReference = candidate.referenceData != null;
  if (candidate.initialLoading && !hasData && !hasReference) return 'first-load';
  if (candidate.refreshing && (hasData || hasReference)) return 'refreshing-with-data';
  // A mixed resource may carry a sanitized reference projection alongside a
  // currently verified full snapshot. The verified snapshot takes precedence;
  // the projection only becomes the visible state after the live data is
  // cleared or expires.
  if (hasData && ['live', 'reference'].includes(candidate.availability)) return 'ready';
  if (
    hasReference
    || candidate.availability === 'persisted-reference'
    || candidate.availability === 'refresh-delayed'
    || candidate.availability === 'delayed-reference'
  ) return 'delayed-reference';
  if (candidate.availability === 'unavailable') return 'unavailable';
  return 'first-load';
}

const splitResourceKey = (key) => {
  const separator = key.indexOf('::');
  if (separator === -1) return { resourceKey: key, scopeKey: '' };
  return {
    resourceKey: key.slice(0, separator),
    scopeKey: key.slice(separator + 2),
  };
};

// A fetcher that never settles would otherwise stay "in flight" for the rest
// of the session, and every later poll would wait on it. The bound is longer
// than the longest client timeout (120 seconds), so it only ends a request
// that has no working timeout of its own.
const DEFAULT_REQUEST_TIMEOUT_MS = 150_000;
// The store cannot cancel a fetcher's request, so one it has given up on may
// still hold one of the browser's six connections to the API. A resource
// stops starting new requests while this many of its old ones are still open.
const MAX_OPEN_ABANDONED_REQUESTS = 2;
const requestTimeoutMs = (config) => {
  const configured = Number(config?.requestTimeoutMs);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_REQUEST_TIMEOUT_MS;
};
const requestTimeoutError = (timeoutMs) => Object.assign(
  new Error(`No response within ${Math.round(timeoutMs / 1000)} seconds`),
  { code: 'RESOURCE_REQUEST_TIMEOUT' },
);

function createEntry(key, initialConfig, removeEntry) {
  let state = INITIAL_STATE;
  let config = validateResourceConfig(initialConfig);
  let inFlight = null;
  let generation = 0;
  let expiryTimer = null;
  let evictionTimer = null;
  let stopPolling = null;
  let pollingIntervalMs = null;
  let pollingInBackground = false;
  let lastRefreshCompletedAt = 0;
  let openAbandonedRequests = 0;
  const listeners = new Set();
  const pollers = new Map();

  const emit = (nextState) => {
    state = Object.freeze({
      ...nextState,
      phase: deriveSessionResourcePhase(nextState),
    });
    listeners.forEach((listener) => listener());
  };

  const clearExpiry = () => {
    if (expiryTimer !== null) {
      clearTimeout(expiryTimer);
      expiryTimer = null;
    }
  };

  const invalidate = (error = null, { preserveReference = false } = {}) => {
    generation += 1;
    inFlight = null;
    clearExpiry();
    const referenceData = preserveReference ? state.referenceData : null;
    const referenceObservedAt = preserveReference ? state.referenceObservedAt : null;
    if (
      config.persistReferenceSnapshot
      && !preserveReference
      && (
        config.kind === 'live'
        || /(?:STALE|EXPIRED|INVALID)/.test(errorCode(error))
      )
    ) {
      clearReferenceSnapshot(config.persistReferenceSnapshot);
    }
    emit({
      ...INITIAL_STATE,
      referenceData,
      referenceObservedAt,
      availability: referenceData ? 'delayed-reference' : 'unavailable',
      error: error ? normalizeError(error) : null,
      persistedAt: referenceData ? state.persistedAt : null,
    });
  };

  const dataIsFresh = (candidateState = state, now = Date.now()) => {
    if (!candidateState.data || config.kind !== 'live') return false;
    const observedAt = parseObservedAt(candidateState.observedAt);
    const maxAgeMs = Number(config.maxAgeMs);
    if (!Number.isFinite(observedAt) || !Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
      return false;
    }
    const age = now - observedAt;
    return age >= -normalizeFutureToleranceMs(config.futureToleranceMs) && age <= maxAgeMs;
  };

  const scheduleExpiry = () => {
    clearExpiry();
    if (config.kind !== 'live' || !state.data) return;
    const observedAt = parseObservedAt(state.observedAt);
    const maxAgeMs = Number(config.maxAgeMs);
    if (!Number.isFinite(observedAt) || !Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
      invalidate(Object.assign(new Error('Live resource is missing a valid freshness window.'), {
        code: 'LIVE_RESOURCE_FRESHNESS_MISSING',
      }));
      return;
    }
    const delay = Math.max(0, observedAt + maxAgeMs - Date.now() + 1);
    expiryTimer = setTimeout(() => {
      if (dataIsFresh()) {
        scheduleExpiry();
        return;
      }
      const expiryError = Object.assign(new Error(config.expiredMessage || 'The last verified live observation expired.'), {
        code: config.expiredCode || 'LIVE_RESOURCE_EXPIRED',
        liveInvalidation: true,
      });
      if (
        config.resourceClass === DASHBOARD_RESOURCE_CLASSIFICATIONS.INFORMATIONAL_LIVE
        && config.retainAfterExpiry
        && state.data
      ) {
        clearExpiry();
        emit({
          ...state,
          availability: 'delayed-reference',
          initialLoading: false,
          refreshing: false,
          error: expiryError,
        });
        return;
      }
      if (
        config.resourceClass === DASHBOARD_RESOURCE_CLASSIFICATIONS.MIXED
        && state.referenceData
      ) {
        clearExpiry();
        emit({
          ...state,
          data: null,
          availability: 'delayed-reference',
          initialLoading: false,
          refreshing: false,
          error: expiryError,
        });
        return;
      }
      invalidate(expiryError);
    }, delay);
  };

  const validateResult = (raw) => {
    const nextData = typeof config.validate === 'function' ? config.validate(raw) : raw;
    if (nextData == null) {
      throw Object.assign(new Error('Resource response did not contain verified data.'), {
        code: 'RESOURCE_DATA_MISSING',
      });
    }
    return nextData;
  };

  const getObservedAt = (data, raw) => {
    if (typeof config.getObservedAt === 'function') return config.getObservedAt(data, raw);
    return data?.observedAt || data?.fetchedAt || data?.lastUpdated || data?.timestamp || null;
  };

  const persistVerifiedSnapshot = ({ data, raw, observedAt }) => {
    let referenceData = null;
    if (config.resourceClass === DASHBOARD_RESOURCE_CLASSIFICATIONS.MIXED) {
      if (
        typeof config.referenceProjection !== 'function'
        || typeof config.validateReference !== 'function'
      ) {
        return { record: null, referenceData: null };
      }
      referenceData = config.referenceProjection(data, raw);
      referenceData = config.validateReference(referenceData);
      if (referenceData == null) {
        throw Object.assign(new Error('Mixed resource did not produce a safe reference projection.'), {
          code: 'RESOURCE_REFERENCE_PROJECTION_INVALID',
          liveInvalidation: true,
        });
      }
    }
    if (!config.persistReferenceSnapshot) return { record: null, referenceData };
    if (!Number.isFinite(parseObservedAt(observedAt))) return { record: null, referenceData };
    const { resourceKey, scopeKey } = splitResourceKey(key);
    const record = writeReferenceSnapshot({
      config: config.persistReferenceSnapshot,
      resourceKey,
      scopeKey,
      observedAt,
      // Store the provider payload, not only the normalized view. Validators
      // such as the correlation parser need their source-status fields again
      // when a snapshot is hydrated after a page reload.
      data: referenceData ?? (raw == null ? data : raw),
      resourceClass: config.resourceClass,
    });
    return { record, referenceData };
  };

  const hydratePersistedSnapshot = () => {
    if (!config.persistReferenceSnapshot) return;
    const { resourceKey, scopeKey } = splitResourceKey(key);
    const record = readReferenceSnapshot({
      config: config.persistReferenceSnapshot,
      resourceKey,
      scopeKey,
      resourceClass: config.resourceClass,
    });
    if (!record) return;

    try {
      const mixed = config.resourceClass === DASHBOARD_RESOURCE_CLASSIFICATIONS.MIXED;
      const data = mixed
        ? config.validateReference(record.data)
        : validateResult(record.data);
      if (data == null) throw new Error('Persisted reference projection was invalid.');
      // Reference snapshots are informational, but they still need the same
      // cache/mock/stale evidence guard before they may be shown after reload.
      // Correlation data additionally enforces sourceStatus === current in its
      // resource validator.
      if (!mixed) {
        const assertEvidence = config.kind === 'live'
          ? assertPermittedLiveEvidence
          : assertPermittedReferenceEvidence;
        assertEvidence(record.data, config);
        if (data !== record.data) assertEvidence(data, config);
      }
      const observedAtValue = record.observedAt || getObservedAt(data, record.data);
      const observedAtMs = parseObservedAt(observedAtValue);
      if (!Number.isFinite(observedAtMs)) {
        throw new Error('Persisted reference data is missing an authoritative observation timestamp.');
      }
      let outsideLiveWindow = false;
      if (config.kind === 'live' && !mixed) {
        const age = Date.now() - observedAtMs;
        const maxAgeMs = Number(config.maxAgeMs);
        outsideLiveWindow = !Number.isFinite(maxAgeMs)
          || maxAgeMs <= 0
          || age > maxAgeMs
          || age < -normalizeFutureToleranceMs(config.futureToleranceMs);
        if (outsideLiveWindow && !config.retainAfterExpiry) {
          throw new Error('Persisted live data is outside its freshness window.');
        }
      }
      const observedAt = new Date(observedAtMs).toISOString();
      const hydratedState = {
        ...INITIAL_STATE,
        data: mixed ? null : data,
        referenceData: mixed ? data : null,
        availability: outsideLiveWindow ? 'delayed-reference' : 'persisted-reference',
        observedAt,
        referenceObservedAt: mixed ? observedAt : null,
        hydratedFromStorage: true,
        persistedAt: record.persistedAt,
      };
      state = Object.freeze({
        ...hydratedState,
        phase: deriveSessionResourcePhase(hydratedState),
      });
      if (!outsideLiveWindow && !mixed) scheduleExpiry();
    } catch {
      clearReferenceSnapshot(config.persistReferenceSnapshot);
    }
  };

  const refresh = () => {
    if (inFlight) return inFlight;
    if (typeof config.fetcher !== 'function') {
      return Promise.reject(new TypeError(`Resource ${key} is missing a fetcher`));
    }

    const requestGeneration = generation;
    const handleFailure = (caught) => {
      if (requestGeneration !== generation) return null;
      const error = normalizeError(caught);
      const explicitInvalidation = isExplicitLiveInvalidation(error)
        || (typeof config.isExplicitInvalidation === 'function'
          && config.isExplicitInvalidation(error));

      const informationalLive = config.resourceClass
        === DASHBOARD_RESOURCE_CLASSIFICATIONS.INFORMATIONAL_LIVE;
      const mixed = config.resourceClass === DASHBOARD_RESOURCE_CLASSIFICATIONS.MIXED;

      // Failed verification is never executable evidence, even if the last
      // observation has not reached its normal expiry. Transport errors do
      // not reliably carry provider-specific error codes.
      if (
        config.resourceClass === DASHBOARD_RESOURCE_CLASSIFICATIONS.EXECUTABLE_LIVE
        || config.accountScoped
      ) {
        invalidate(error);
        return null;
      }

      // Dashboard reference cards should remain readable while a scheduled
      // refresh is in flight or has failed. Retention is opt-in so live
      // executable resources (portfolio, positions, orders) still fail
      // closed on every failed refresh.
      if (
        state.data
        && config.retainOnRefreshFailure === true
        && informationalLive
      ) {
        emit({
          ...state,
          availability: dataIsFresh() ? 'refresh-delayed' : 'delayed-reference',
          initialLoading: false,
          refreshing: false,
          error,
        });
        return null;
      }
      if (mixed) {
        // Mixed monitors may retain dated chart/catalog context, but their
        // executable books and sizing inputs must pass verification again.
        invalidate(error, { preserveReference: true });
        return null;
      }
      if (config.kind === 'reference' && state.data) {
        emit({
          ...state,
          availability: 'refresh-delayed',
          initialLoading: false,
          refreshing: false,
          error,
        });
        return null;
      }
      if (config.kind === 'live' && state.data && !explicitInvalidation && dataIsFresh()) {
        emit({
          ...state,
          initialLoading: false,
          refreshing: false,
          error,
        });
        return null;
      }
      invalidate(error);
      return null;
    };

    const timeoutMs = requestTimeoutMs(config);
    if (openAbandonedRequests >= MAX_OPEN_ABANDONED_REQUESTS) {
      // Earlier requests for this resource are still open with no answer.
      // Say so instead of opening another connection.
      if (!state.error) handleFailure(requestTimeoutError(timeoutMs));
      return Promise.resolve(null);
    }

    emit({
      ...state,
      initialLoading: !state.data && !state.referenceData,
      refreshing: Boolean(state.data || state.referenceData),
      availability: state.data || state.referenceData ? state.availability : 'loading',
      error: null,
    });

    // Start the request immediately. Promise-normalize its result so both
    // synchronous test fetchers and ordinary async clients share the same
    // atomic commit/error path without adding an avoidable blank-frame turn.
    let fetchResult;
    try {
      fetchResult = config.fetcher();
    } catch (error) {
      fetchResult = Promise.reject(error);
    }
    // Callers and later polls share this promise. It settles when the request
    // does, or when the request is given up on.
    let abandoned = false;
    let settlePublic;
    let rejectPublic;
    const publicPromise = new Promise((resolve, reject) => {
      settlePublic = resolve;
      rejectPublic = reject;
    });
    const requestTimer = setTimeout(() => {
      // No answer. Release whoever is waiting; a late answer is ignored.
      abandoned = true;
      openAbandonedRequests += 1;
      if (inFlight !== publicPromise) {
        // An invalidation or a reset has already replaced this request.
        settlePublic(null);
        return;
      }
      // Treat it as failed so the next poll can start a new request.
      inFlight = null;
      lastRefreshCompletedAt = Date.now();
      settlePublic(handleFailure(requestTimeoutError(timeoutMs)));
    }, timeoutMs);
    requestTimer?.unref?.();

    const promise = Promise.resolve(fetchResult)
      .then((raw) => {
        if (abandoned || requestGeneration !== generation) return null;
        const incomingData = validateResult(raw);
        if (config.kind === 'live') {
          // A resource-specific validator gets first say so it can return its
          // typed domain error. The shared guard then ensures normalization
          // cannot accidentally strip forbidden cache/mock/stale evidence.
          assertPermittedLiveEvidence(raw, config);
          if (incomingData !== raw) assertPermittedLiveEvidence(incomingData, config);
        } else if (config.persistReferenceSnapshot) {
          assertPermittedReferenceEvidence(raw, config);
          if (incomingData !== raw) assertPermittedReferenceEvidence(incomingData, config);
        }
        const nowMs = Date.now();
        const hasReconciler = typeof config.reconcileIncoming === 'function';
        const reconciledCandidate = hasReconciler
          ? config.reconcileIncoming({
              currentData: state.data,
              currentReferenceData: state.referenceData,
              incomingData,
              raw,
              nowMs,
            })
          : incomingData;
        // Re-run the domain validator and evidence guard on the exact object
        // that will be committed. A reconciler may retain verified sections,
        // but it cannot bypass the resource contract or live-data policy.
        const data = hasReconciler ? validateResult(reconciledCandidate) : incomingData;
        if (config.kind === 'live') {
          assertPermittedLiveEvidence(data, config);
        } else if (config.persistReferenceSnapshot) {
          assertPermittedReferenceEvidence(data, config);
        }
        const observedAtValue = getObservedAt(data, raw);
        const observedAtMs = parseObservedAt(observedAtValue);
        if (config.kind === 'live') {
          if (!Number.isFinite(observedAtMs)) {
            throw Object.assign(new Error('Verified live data is missing an authoritative observation timestamp.'), {
              code: 'LIVE_RESOURCE_OBSERVED_AT_MISSING',
              liveInvalidation: true,
            });
          }
          const futureToleranceMs = normalizeFutureToleranceMs(config.futureToleranceMs);
          const age = nowMs - observedAtMs;
          const maxAgeMs = Number(config.maxAgeMs);
          if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
            throw Object.assign(new Error('Live resource is missing a valid freshness window.'), {
              code: 'LIVE_RESOURCE_FRESHNESS_MISSING',
              observedAt: new Date(observedAtMs).toISOString(),
              liveInvalidation: true,
            });
          }
          if (age > maxAgeMs || age < -futureToleranceMs) {
            throw liveFreshnessFailure({
              observedAtMs,
              nowMs,
              maxAgeMs,
              futureToleranceMs,
            });
          }
        }
        const observedAt = Number.isFinite(observedAtMs)
          ? new Date(observedAtMs).toISOString()
          : observedAtValue || null;
        // A partial response must not erase retained sections on the next reload.
        // Persist the exact validated reconciliation when the resource merges rows.
        const persisted = persistVerifiedSnapshot({ data, raw: hasReconciler ? data : raw, observedAt }) || {};
        const mixed = config.resourceClass === DASHBOARD_RESOURCE_CLASSIFICATIONS.MIXED;
        emit({
          data,
          referenceData: mixed ? persisted.referenceData : null,
          availability: config.kind === 'reference' ? 'reference' : 'live',
          observedAt,
          referenceObservedAt: mixed ? observedAt : null,
          initialLoading: false,
          refreshing: false,
          error: null,
          hydratedFromStorage: false,
          persistedAt: persisted.record?.persistedAt || state.persistedAt || null,
        });
        scheduleExpiry();
        return data;
      })
      .catch((caught) => (abandoned ? null : handleFailure(caught)))
      .finally(() => {
        clearTimeout(requestTimer);
        if (abandoned) {
          openAbandonedRequests -= 1;
          return;
        }
        lastRefreshCompletedAt = Date.now();
        if (inFlight === publicPromise) inFlight = null;
      });
    promise.then(settlePublic, rejectPublic);

    inFlight = publicPromise;
    return publicPromise;
  };

  const reconcilePolling = () => {
    const intervals = [...pollers.values()].filter((value) => Number.isFinite(value) && value > 0);
    const nextInterval = intervals.length ? Math.min(...intervals) : null;
    const nextPollingInBackground = Boolean(config.pollWhenDocumentHidden);
    if (
      nextInterval === pollingIntervalMs
      && nextPollingInBackground === pollingInBackground
    ) return;
    stopPolling?.();
    stopPolling = null;
    pollingIntervalMs = nextInterval;
    pollingInBackground = nextPollingInBackground;
    if (nextInterval != null) {
      const elapsedMs = lastRefreshCompletedAt > 0
        ? Date.now() - lastRefreshCompletedAt
        : null;
      const initialDelayMs = Number.isFinite(elapsedMs)
        ? Math.max(0, nextInterval - elapsedMs)
        : nextInterval;
      stopPolling = startVisibilityAwarePolling({
        poll: refresh,
        intervalMs: nextInterval,
        initialDelayMs,
        ...(nextPollingInBackground ? { documentObject: null } : {}),
      });
    }
  };

  // Hydrate before the first React subscription/render. The initial refresh
  // still starts from useSessionResource's effect, but the last verified
  // informational values never disappear during that request.
  hydratePersistedSnapshot();

  return {
    key,
    configure(nextConfig) {
      config = validateResourceConfig({ ...config, ...nextConfig });
      if (state.data && config.kind === 'live') scheduleExpiry();
      reconcilePolling();
    },
    getSnapshot: () => state,
    subscribe(listener) {
      if (evictionTimer !== null) {
        clearTimeout(evictionTimer);
        evictionTimer = null;
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && !config.core) {
          evictionTimer = setTimeout(() => {
            if (listeners.size === 0) {
              stopPolling?.();
              clearExpiry();
              removeEntry();
            }
          }, Number(config.evictAfterMs) || SESSION_RESOURCE_EVICT_MS);
        }
      };
    },
    refresh,
    invalidate,
    addPoller(token, intervalMs) {
      pollers.set(token, intervalMs);
      reconcilePolling();
      return () => {
        pollers.delete(token);
        reconcilePolling();
      };
    },
    dispose() {
      generation += 1;
      inFlight = null;
      stopPolling?.();
      stopPolling = null;
      clearExpiry();
      if (evictionTimer !== null) clearTimeout(evictionTimer);
      listeners.clear();
      pollers.clear();
    },
  };
}

export function getSessionResource(key, config = {}) {
  const normalizedKey = String(key || '').trim();
  if (!normalizedKey) throw new TypeError('Session resource key is required');
  let entry = resources.get(normalizedKey);
  if (!entry) {
    entry = createEntry(normalizedKey, config, () => {
      if (resources.get(normalizedKey) === entry) resources.delete(normalizedKey);
    });
    resources.set(normalizedKey, entry);
  } else {
    entry.configure(config);
  }
  return entry;
}

export function resetSessionResourceStore() {
  resources.forEach((entry) => entry.dispose());
  resources.clear();
}

export function getSessionResourceCount() {
  return resources.size;
}
