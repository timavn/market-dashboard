import React, { useCallback, useEffect, useRef, useState } from 'react';
import { MarketDataService } from '../../services/api/marketDataService';
import { useTheme } from '../../context/ThemeContext';
import { startVisibilityAwarePolling } from '../../utils/visibilityAwarePolling';
import LoadingIndicator from '../common/LoadingIndicator';
import RefreshButton from '../common/RefreshButton';
import './SystemReadinessPanel.css';

const READINESS_POLL_MS = 60 * 1000;
const MAX_SNAPSHOT_AGE_MS = 5 * 60 * 1000;

const CHECK_STATUS_META = {
  pass: { label: 'Pass', glyph: '✓' },
  warn: { label: 'Warning', glyph: '!' },
  fail: { label: 'Failed', glyph: '×' },
};

const AGGREGATE_STATUS_META = {
  ready: {
    label: 'Ready',
    summary: 'Every required dashboard dependency passed its latest check.',
  },
  degraded: {
    label: 'Degraded',
    summary: 'Core dashboard capabilities are available, but one or more ancillary services need attention.',
  },
  blocked: {
    label: 'Blocked',
    summary: 'A required dependency failed. Treat affected live data as unavailable.',
  },
  checking: {
    label: 'Checking',
    summary: 'Running the complete dashboard readiness checklist.',
  },
};

const CAPABILITY_STATUS_META = {
  ready: { label: 'Available', glyph: '✓' },
  degraded: { label: 'Degraded', glyph: '!' },
  blocked: { label: 'Blocked', glyph: '×' },
};

const AGGREGATE_RANK = {
  ready: 0,
  degraded: 1,
  blocked: 2,
};

function normalizeAggregateStatus(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(AGGREGATE_RANK, normalized)
    ? normalized
    : 'blocked';
}

function normalizeCheck(check, index, groupId) {
  const rawStatus = String(check?.status || '').trim().toLowerCase();
  const recognized = Object.prototype.hasOwnProperty.call(CHECK_STATUS_META, rawStatus);
  const status = recognized ? rawStatus : 'fail';
  const id = check?.id || `${groupId || 'group'}-check-${index + 1}`;
  const fallbackDetail = recognized
    ? null
    : `Unrecognized readiness status${rawStatus ? `: ${rawStatus}` : ''}.`;

  return {
    ...check,
    id,
    label: check?.label || id,
    status,
    // An unrecognized check cannot safely inherit a non-blocking classification.
    blocking: recognized ? check?.blocking === true : true,
    summary: check?.summary || fallbackDetail || CHECK_STATUS_META[status].label,
    detail: check?.detail || fallbackDetail,
    capabilityIds: Array.isArray(check?.capabilityIds)
      ? [...new Set(check.capabilityIds.map(String))]
      : [],
    dependsOn: Array.isArray(check?.dependsOn)
      ? [...new Set(check.dependsOn.map(String))]
      : [],
    errorCode: status === 'pass' ? null : (check?.errorCode || `${String(id).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_FAILED`),
    owner: check?.owner || 'unassigned',
    automatic: check?.automatic === true,
  };
}

function normalizeCapability(capability, index) {
  const rawStatus = String(capability?.status || '').trim().toLowerCase();
  const status = Object.prototype.hasOwnProperty.call(CAPABILITY_STATUS_META, rawStatus)
    ? rawStatus
    : 'blocked';
  const id = capability?.id || `capability-${index + 1}`;
  return {
    ...capability,
    id,
    label: capability?.label || id,
    status,
    ready: status === 'ready',
    blocking: capability?.blocking === true,
    checkIds: Array.isArray(capability?.checkIds) ? capability.checkIds.map(String) : [],
    rootCauseIds: Array.isArray(capability?.rootCauseIds) ? capability.rootCauseIds.map(String) : [],
  };
}

function deriveRootCauses(checks, supplied) {
  if (Array.isArray(supplied)) {
    const unique = new Map();
    supplied.forEach((cause, index) => {
      if (!cause || typeof cause !== 'object') return;
      const id = String(cause.id || cause.errorCode || cause.checkId || `root-cause-${index + 1}`);
      if (unique.has(id)) return;
      unique.set(id, {
        ...cause,
        id,
        errorCode: cause.errorCode || id,
        status: cause.status === 'warn' ? 'warn' : 'fail',
        label: cause.label || cause.checkId || id,
        owner: cause.owner || 'unassigned',
        capabilityIds: Array.isArray(cause.capabilityIds) ? cause.capabilityIds.map(String) : [],
        affectedCheckIds: Array.isArray(cause.affectedCheckIds) ? cause.affectedCheckIds.map(String) : [],
      });
    });
    return [...unique.values()];
  }

  const unique = new Map();
  checks.filter((check) => check.status !== 'pass').forEach((check) => {
    const id = check.errorCode || check.id;
    const existing = unique.get(id);
    if (existing) {
      existing.affectedCheckIds = [...new Set([...existing.affectedCheckIds, check.id])];
      return;
    }
    unique.set(id, {
      id,
      errorCode: check.errorCode,
      checkId: check.id,
      label: check.label,
      status: check.status,
      summary: check.summary,
      owner: check.owner,
      capabilityIds: check.capabilityIds,
      affectedCheckIds: [check.id],
    });
  });
  return [...unique.values()];
}

function deriveAggregateStatus(checks, capabilities = []) {
  if (checks.length === 0) return 'blocked';
  if (capabilities.length > 0) {
    if (capabilities.some((capability) => capability.status === 'blocked')) return 'blocked';
    if (capabilities.some((capability) => capability.status === 'degraded')) return 'degraded';
    if (checks.some((check) => check.status !== 'pass')) return 'degraded';
    return 'ready';
  }
  if (checks.some((check) => check.status === 'fail' && check.blocking)) return 'blocked';
  if (checks.some((check) => check.status === 'fail' || check.status === 'warn')) return 'degraded';
  return 'ready';
}

function affectedChecksForCause(cause, groups = []) {
  const checkLabels = new Map(
    groups.flatMap((group) => group.checks || []).map((check) => [String(check.id), check.label]),
  );
  return (cause.affectedCheckIds || []).map((id) => ({
    id: String(id),
    label: checkLabels.get(String(id)) || String(id),
  }));
}

function worstAggregateStatus(...statuses) {
  return statuses
    .map(normalizeAggregateStatus)
    .reduce((worst, status) => (
      AGGREGATE_RANK[status] > AGGREGATE_RANK[worst] ? status : worst
    ), 'ready');
}

export function normalizeReadinessSnapshot(payload, now = Date.now()) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Readiness response was not a valid object.');
  }

  const checkedAt = new Date(payload.checkedAt || '');
  if (!Number.isFinite(checkedAt.getTime())) {
    throw new Error('Readiness response did not include a valid checkedAt timestamp.');
  }
  const snapshotAgeMs = Math.max(0, now - checkedAt.getTime());
  if (snapshotAgeMs > MAX_SNAPSHOT_AGE_MS) {
    throw new Error('Readiness response is stale. Run the checks again.');
  }

  const rawGroups = Array.isArray(payload.groups) ? payload.groups : [];
  const groups = rawGroups.map((group, groupIndex) => {
    const id = group?.id || `group-${groupIndex + 1}`;
    return {
      ...group,
      id,
      label: group?.label || id,
      checks: (Array.isArray(group?.checks) ? group.checks : [])
        .map((check, checkIndex) => normalizeCheck(check, checkIndex, id)),
    };
  });
  const checks = groups.flatMap((group) => group.checks);
  const capabilities = (Array.isArray(payload.capabilities) ? payload.capabilities : [])
    .map(normalizeCapability);
  const rootCauses = deriveRootCauses(checks, payload.rootCauses);
  const derivedStatus = deriveAggregateStatus(checks, capabilities);
  const reportedStatus = normalizeAggregateStatus(payload.status);
  const readyFlagStatus = payload.ready === false && reportedStatus === 'ready'
    ? 'degraded'
    : reportedStatus;
  const status = worstAggregateStatus(derivedStatus, readyFlagStatus);
  const counts = checks.reduce((result, check) => {
    result.total += 1;
    result[check.status] += 1;
    if (check.status === 'fail' && check.blocking) result.blockingFailures += 1;
    return result;
  }, { total: 0, pass: 0, warn: 0, fail: 0, blockingFailures: 0 });

  return {
    ...payload,
    checkedAt: checkedAt.toISOString(),
    groups,
    capabilities,
    rootCauses,
    status,
    ready: status === 'ready',
    operational: status !== 'blocked',
    fullyOperational: status === 'ready' && checks.every((check) => check.status === 'pass'),
    counts,
    snapshotAgeSeconds: Math.round(snapshotAgeMs / 1000),
  };
}

function formatDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatAge(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 0) return null;
  if (value < 60) return `${Math.round(value)}s ago`;
  if (value < 3600) return `${Math.round(value / 60)}m ago`;
  if (value < 86400) return `${Math.round(value / 3600)}h ago`;
  return `${Math.round(value / 86400)}d ago`;
}

function errorMessage(error) {
  return error?.response?.data?.error
    || error?.response?.data?.message
    || error?.message
    || 'The dashboard server did not return readiness results.';
}

function CheckRow({ check, onRepair, repairingActionId }) {
  const meta = CHECK_STATUS_META[check.status];
  const age = formatAge(check.ageSeconds);
  const recovery = check.recovery && typeof check.recovery === 'object'
    ? check.recovery
    : null;
  const canRepair = check.status !== 'pass'
    && recovery?.automatic === true
    && typeof recovery?.actionId === 'string';
  const repairing = canRepair && repairingActionId === recovery.actionId;

  return (
    <article
      className="sr-check"
      aria-label={check.label}
      data-status={check.status}
      data-blocking={check.blocking ? 'true' : 'false'}
    >
      <div className="sr-check__status" aria-label={meta.label}>
        <span aria-hidden="true">{meta.glyph}</span>
      </div>
      <div className="sr-check__content">
        <div className="sr-check__heading">
          <div>
            <h3>{check.label}</h3>
            {check.blocking ? <span className="sr-check__required">Required</span> : null}
          </div>
          <strong className="sr-check__status-label">{meta.label}</strong>
        </div>
        <p className="sr-check__summary">{check.summary}</p>
        {check.detail && check.detail !== check.summary ? (
          <p className="sr-check__detail">{check.detail}</p>
        ) : null}
        {(check.observedAt || age) ? (
          <p className="sr-check__observed">
            {check.observedAt ? `Observed ${formatDateTime(check.observedAt)}` : 'Observation time unavailable'}
            {age ? ` · ${age}` : ''}
          </p>
        ) : null}
        {(check.errorCode || check.owner || check.dependsOn.length > 0) ? (
          <p className="sr-check__operations">
            {check.errorCode ? <code>{check.errorCode}</code> : null}
            {check.owner ? <span>Owner: {check.owner}</span> : null}
            {check.dependsOn.length > 0 ? <span>Depends on: {check.dependsOn.join(', ')}</span> : null}
          </p>
        ) : null}
        {(check.lastSuccessAt || check.nextDueAt) ? (
          <p className="sr-check__schedule">
            {check.lastSuccessAt ? <span>Last success {formatDateTime(check.lastSuccessAt)}</span> : null}
            {check.nextDueAt ? <span>Next due {formatDateTime(check.nextDueAt)}</span> : null}
          </p>
        ) : null}
        {check.impact ? (
          <p className="sr-check__impact"><strong>Impact</strong>{check.impact}</p>
        ) : null}
        {recovery && (recovery.label || recovery.command) ? (
          <div className="sr-check__recovery">
            <strong>{recovery.label || 'Recovery'}</strong>
            {recovery.command ? <code>{recovery.command}</code> : null}
            {canRepair ? (
              <button
                type="button"
                className="sr-check__repair-button"
                disabled={repairing}
                onClick={() => onRepair?.(recovery)}
              >
                {repairing ? 'Starting safe repair…' : 'Run safe repair'}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </article>
  );
}

const SystemReadinessPanel = ({
  open = true,
  onClose,
  onStatusChange,
}) => {
  const { theme } = useTheme();
  const [snapshot, setSnapshot] = useState(null);
  const [error, setError] = useState('');
  const [repairState, setRepairState] = useState({ actionId: null, message: '', error: false });
  // The first readiness result is not known until the initial poll completes.
  // Starting in "checking" avoids a misleading blocked/green flash on mount.
  const [refreshing, setRefreshing] = useState(true);
  const requestIdRef = useRef(0);

  const load = useCallback(async ({ refresh = false } = {}) => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setRefreshing(true);
    setError('');
    onStatusChange?.('checking');

    try {
      const response = await MarketDataService.getSystemReadiness({ refresh });
      const normalized = normalizeReadinessSnapshot(response);
      if (requestId !== requestIdRef.current) return;
      setSnapshot(normalized);
      setError('');
      onStatusChange?.(normalized.status);
    } catch (loadError) {
      if (requestId !== requestIdRef.current) return;
      // A failed check invalidates the prior green snapshot immediately.
      setSnapshot(null);
      setError(errorMessage(loadError));
      onStatusChange?.('blocked');
    } finally {
      if (requestId === requestIdRef.current) setRefreshing(false);
    }
  }, [onStatusChange]);

  const runRepair = useCallback(async (recovery) => {
    if (!recovery?.actionId || recovery?.automatic !== true) return;
    setRepairState({ actionId: recovery.actionId, message: '', error: false });
    try {
      const result = await MarketDataService.runSystemReadinessRepair(recovery.actionId);
      setRepairState({
        actionId: null,
        message: result?.message || 'Safe local recovery started. Refresh readiness after the services settle.',
        error: false,
      });
    } catch (repairError) {
      setRepairState({ actionId: null, message: errorMessage(repairError), error: true });
    }
  }, []);

  useEffect(() => {
    const stopPolling = startVisibilityAwarePolling({
      poll: () => load(),
      intervalMs: READINESS_POLL_MS,
      pollOnStart: true,
    });
    return () => {
      requestIdRef.current += 1;
      stopPolling();
    };
  }, [load]);

  useEffect(() => {
    if (!open || typeof document === 'undefined') return undefined;
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') onClose?.();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose, open]);

  const visibleStatus = refreshing ? 'checking' : (snapshot?.status || 'blocked');
  const statusMeta = AGGREGATE_STATUS_META[visibleStatus];
  const counts = snapshot?.counts;

  return (
    <section
      className={`sr-panel ${theme === 'dark' ? 'sr-panel--dark' : ''}`}
      role={open ? 'dialog' : undefined}
      aria-modal={open ? 'false' : undefined}
      aria-label={open ? 'System readiness' : undefined}
      aria-busy={refreshing || undefined}
    >
      <header className="sr-panel__header">
        <div>
          <span className="sr-eyebrow">Morning operations checklist</span>
          <h1>System readiness</h1>
        </div>
        <div className="sr-panel__actions">
          <RefreshButton
            label="Refresh checks"
            title="Refresh system readiness"
            loading={refreshing}
            onClick={() => load({ refresh: true })}
          />
          <button type="button" className="sr-panel__close" onClick={onClose} aria-label="Close system readiness">
            <span aria-hidden="true">×</span>
          </button>
        </div>
      </header>

      <div className="sr-panel__body" aria-live="polite">
        <section className="sr-overview" data-status={visibleStatus}>
          <div className="sr-overview__state">
            <span className="sr-overview__dot" aria-hidden="true" />
            <strong>{statusMeta.label}</strong>
          </div>
          <p>{statusMeta.summary}</p>
          {snapshot ? (
            <div className="sr-overview__meta">
              <span>Checked {formatDateTime(snapshot.checkedAt)}</span>
              <span>{counts.total} checks</span>
              <span>{counts.pass} passed</span>
              {counts.warn > 0 ? <span>{counts.warn} warning{counts.warn === 1 ? '' : 's'}</span> : null}
              {counts.fail > 0 ? <span>{counts.fail} failed</span> : null}
              <span>{snapshot.rootCauses.length} root cause{snapshot.rootCauses.length === 1 ? '' : 's'}</span>
            </div>
          ) : null}
        </section>

        {repairState.message ? (
          <p className="sr-repair-notice" data-error={repairState.error ? 'true' : 'false'} role="status">
            {repairState.message}
          </p>
        ) : null}

        {refreshing && !snapshot ? (
          <div className="sr-panel__loading">
            <LoadingIndicator label="Checking every dashboard dependency…" size="sm" centered />
          </div>
        ) : error ? (
          <section className="sr-unavailable" role="alert">
            <strong>Readiness checks unavailable</strong>
            <p>{error}</p>
            <p>Because the complete check could not finish, system readiness is blocked.</p>
            <code>npm start</code>
          </section>
        ) : snapshot ? (
          <>
            {snapshot.capabilities.length > 0 ? (
              <section className="sr-capabilities" aria-labelledby="sr-capabilities-title">
                <header className="sr-section-heading">
                  <h2 id="sr-capabilities-title">Capabilities</h2>
                  <span>{snapshot.capabilities.length}</span>
                </header>
                <div className="sr-capabilities__grid">
                  {snapshot.capabilities.map((capability) => {
                    const meta = CAPABILITY_STATUS_META[capability.status];
                    return (
                      <article className="sr-capability" data-status={capability.status} key={capability.id}>
                        <div className="sr-capability__heading">
                          <strong>{capability.label}</strong>
                          <span>{meta.glyph} {meta.label}</span>
                        </div>
                        {capability.description ? <p>{capability.description}</p> : null}
                      </article>
                    );
                  })}
                </div>
              </section>
            ) : null}

            {snapshot.rootCauses.length > 0 ? (
              <section className="sr-root-causes" aria-labelledby="sr-root-causes-title">
                <header className="sr-section-heading">
                  <h2 id="sr-root-causes-title">What needs attention</h2>
                  <span>{snapshot.rootCauses.length}</span>
                </header>
                <div className="sr-root-causes__list">
                  {snapshot.rootCauses.map((cause) => {
                    const affectedChecks = affectedChecksForCause(cause, snapshot.groups);
                    return (
                      <article key={cause.id} data-status={cause.status}>
                        <div>
                          <strong>{cause.label}</strong>
                          {cause.errorCode ? <code>{cause.errorCode}</code> : null}
                        </div>
                        <p>{cause.summary}</p>
                        <span>
                          Owner: {cause.owner}
                          {affectedChecks.length > 1 ? ` · affects ${affectedChecks.length} checks` : ''}
                        </span>
                        {affectedChecks.length > 0 ? (
                          <div className="sr-root-cause__affected">
                            <strong>Affected checks</strong>
                            <ul aria-label={`${cause.label} affected checks`}>
                              {affectedChecks.map((check) => (
                                <li key={check.id}>{check.label}</li>
                              ))}
                            </ul>
                          </div>
                        ) : null}
                      </article>
                    );
                  })}
                </div>
              </section>
            ) : null}

            <div className="sr-groups">
            {snapshot.groups.map((group) => (
              <section className="sr-group" key={group.id} aria-labelledby={`sr-group-${group.id}`}>
                <header className="sr-group__header">
                  <h2 id={`sr-group-${group.id}`}>{group.label}</h2>
                  <span>{group.checks.length}</span>
                </header>
                {group.checks.length > 0 ? (
                  <div className="sr-group__checks">
                    {group.checks.map((check) => (
                      <CheckRow
                        key={check.id}
                        check={check}
                        onRepair={runRepair}
                        repairingActionId={repairState.actionId}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="sr-group__empty">No checks were returned for this group.</div>
                )}
              </section>
            ))}
            </div>
          </>
        ) : null}
      </div>
    </section>
  );
};

export { AGGREGATE_STATUS_META, CAPABILITY_STATUS_META, CHECK_STATUS_META };
export default SystemReadinessPanel;
