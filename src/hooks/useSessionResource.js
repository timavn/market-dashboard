import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { getSessionResource } from '../utils/sessionResourceStore';
import { isDashboardSessionRetentionEnabled } from '../config/dashboardSessionRetention';

export function useSessionResource({
  resourceKey,
  scopeKey = '',
  kind = 'live',
  fetcher,
  validate,
  getObservedAt,
  maxAgeMs,
  futureToleranceMs,
  pollIntervalMs = null,
  enabled = true,
  active = true,
  pollWhenHidden = false,
  pollWhenDocumentHidden = false,
  refreshOnActivate = true,
  invalidateOnScopeChange = false,
  core = false,
  evictAfterMs,
  isExplicitInvalidation,
  retainOnRefreshFailure = false,
  retainAfterExpiry = false,
  displayRole = 'executable',
  persistReferenceSnapshot = null,
  resourceClass,
  classification,
  referenceProjection,
  validateReference,
  reconcileIncoming,
  accountScoped = false,
  expectedScope,
  getScope,
  expiredCode,
  expiredMessage,
} = {}) {
  const retentionEnabled = isDashboardSessionRetentionEnabled();
  const normalizedScope = String(scopeKey || '').trim();
  const key = `${String(resourceKey || '').trim()}::${normalizedScope}`;
  const config = useMemo(() => ({
    kind,
    fetcher,
    validate,
    getObservedAt,
    maxAgeMs,
    futureToleranceMs,
    core,
    pollWhenDocumentHidden,
    evictAfterMs,
    isExplicitInvalidation,
    retainOnRefreshFailure: retentionEnabled ? retainOnRefreshFailure : false,
    retainAfterExpiry: retentionEnabled ? retainAfterExpiry : false,
    displayRole,
    persistReferenceSnapshot: retentionEnabled ? persistReferenceSnapshot : null,
    resourceClass: resourceClass || classification,
    referenceProjection: retentionEnabled ? referenceProjection : null,
    validateReference: retentionEnabled ? validateReference : null,
    reconcileIncoming,
    accountScoped,
    expectedScope,
    getScope,
    expiredCode,
    expiredMessage,
  }), [
    core,
    evictAfterMs,
    expectedScope,
    expiredCode,
    expiredMessage,
    fetcher,
    futureToleranceMs,
    getObservedAt,
    getScope,
    isExplicitInvalidation,
    kind,
    maxAgeMs,
    accountScoped,
    pollWhenDocumentHidden,
    classification,
    referenceProjection,
    resourceClass,
    retainAfterExpiry,
    retainOnRefreshFailure,
    displayRole,
    persistReferenceSnapshot,
    retentionEnabled,
    validateReference,
    validate,
    reconcileIncoming,
  ]);
  const entry = useMemo(() => getSessionResource(key, config), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const state = useSyncExternalStore(entry.subscribe, entry.getSnapshot, entry.getSnapshot);
  const pollTokenRef = useRef(Symbol(key));
  const previousEntryRef = useRef(null);
  const shouldRun = Boolean(enabled && (active || pollWhenHidden));

  useEffect(() => {
    const previous = previousEntryRef.current;
    if (invalidateOnScopeChange && previous && previous.entry !== entry) {
      previous.entry.invalidate(Object.assign(new Error('Resource scope changed.'), {
        code: 'RESOURCE_SCOPE_CHANGED',
      }));
    }
    previousEntryRef.current = { entry, key };
  }, [entry, invalidateOnScopeChange, key]);

  useEffect(() => {
    entry.configure(config);
  }, [config, entry]);

  useEffect(() => {
    if (!shouldRun) return undefined;
    const snapshot = entry.getSnapshot();
    const hasRetainedData = Boolean(snapshot.data || snapshot.referenceData);
    // A same-tab hard refresh hydrates reference data synchronously, then must
    // always revalidate it in the background. In-memory data retained by a
    // still-mounted surface does not need an activation-only request.
    const needsRecoveryRefresh = Boolean(snapshot.error) || [
      'persisted-reference',
      'refresh-delayed',
      'delayed-reference',
      'unavailable',
    ].includes(snapshot.availability);
    if (
      !retentionEnabled
      || refreshOnActivate
      || !hasRetainedData
      || needsRecoveryRefresh
    ) entry.refresh();
    if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) return undefined;
    return entry.addPoller(pollTokenRef.current, pollIntervalMs);
  }, [entry, pollIntervalMs, refreshOnActivate, retentionEnabled, shouldRun]);

  return {
    ...state,
    resourceClass: resourceClass || classification,
    resourceState: state.phase,
    refresh: entry.refresh,
    invalidate: entry.invalidate,
  };
}

export default useSessionResource;
