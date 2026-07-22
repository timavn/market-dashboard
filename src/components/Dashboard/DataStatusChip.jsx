import React, {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import './ExceptionFirstRadar.css';

const STATUS_ALIASES = {
  active: 'live',
  current: 'live',
  connected: 'live',
  mixed_delayed: 'mixed',
  'mixed/delayed': 'mixed',
  'as-of': 'historical',
  asof: 'historical',
  stale: 'delayed',
  partial: 'mixed',
  provisional: 'delayed',
  error: 'unavailable',
  missing: 'unavailable',
  unknown: 'unavailable',
  defective: 'unavailable',
  inactive: 'offline',
};

export const DATA_STATUS_META = {
  live: { label: 'LIVE', tone: 'live' },
  delayed: { label: 'DELAYED', tone: 'delayed' },
  mixed: { label: 'MIXED / DELAYED', tone: 'delayed' },
  historical: { label: 'AS OF', tone: 'historical' },
  asof: { label: 'AS OF', tone: 'historical' },
  manual: { label: 'MANUAL', tone: 'manual' },
  loading: { label: 'LOADING', tone: 'loading' },
  offline: { label: 'OFFLINE', tone: 'offline' },
  unavailable: { label: 'UNAVAILABLE', tone: 'unavailable' },
};

export const DATA_STATUS_SUMMARIES = {
  live: 'Verified live provider data is current.',
  delayed: 'Live data is not available; delayed data is shown.',
  mixed: 'Sources have mixed freshness or availability; see the counts below.',
  historical: 'Historical snapshot only; this is not a live feed.',
  manual: 'Manually maintained reference data; this is not a live feed.',
  loading: 'Checking the data provider now.',
  offline: 'The provider is offline; live data is unavailable.',
  unavailable: 'No verified data is available. The source may be missing, offline, or not entitled.',
};

const normalizeStatus = (status) => {
  const key = String(status || 'unavailable').trim().toLowerCase();
  return STATUS_ALIASES[key] || (DATA_STATUS_META[key] ? key : 'unavailable');
};

const getStatusSummary = (status, label) => {
  const normalizedLabel = String(label || '').trim().toUpperCase();
  if (status === 'offline' || status === 'unavailable') {
    return DATA_STATUS_SUMMARIES[status];
  }
  if (normalizedLabel === 'STALE') {
    return 'The latest data is older than the freshness limit.';
  }
  if (normalizedLabel === 'PARTIAL') {
    return 'Some expected source data is missing; available values are shown.';
  }
  if (normalizedLabel === 'PROVISIONAL') {
    return 'The latest dataset is preliminary and may be incomplete.';
  }
  return DATA_STATUS_SUMMARIES[status];
};

const cleanDiagnostics = (diagnostics) => (Array.isArray(diagnostics) ? diagnostics : [])
  .map((item) => {
    if (typeof item === 'string') return { label: null, value: item };
    if (!item || typeof item !== 'object') return null;
    const value = item.value ?? item.detail;
    if (value == null || value === '') return null;
    return { label: item.label || null, value: String(value) };
  })
  .filter(Boolean)
  .slice(0, 4);

const cleanIssues = (issues) => (Array.isArray(issues) ? issues : [issues])
  .map((issue) => (issue == null ? '' : String(issue).trim()))
  .filter(Boolean)
  .slice(0, 3);

/**
 * Explicit data-state control used by the Exception-First Radar.
 * Delayed, historical, missing, and unavailable data always retain non-live tones.
 */
const DataStatusChip = ({
  status,
  label,
  detail,
  className = '',
  title,
  compact = false,
  indicatorOnly = false,
  context = 'Data status',
  summary,
  diagnostics = [],
  issues = [],
}) => {
  const normalizedStatus = normalizeStatus(status);
  const meta = DATA_STATUS_META[normalizedStatus];
  const visibleLabel = label || meta.label;
  const accessibleLabel = detail ? `${visibleLabel} · ${detail}` : visibleLabel;
  const diagnosticRows = cleanDiagnostics(diagnostics);
  const issueRows = cleanIssues(issues);
  const popoverContentKey = [
    context,
    normalizedStatus,
    visibleLabel,
    detail,
    summary,
    ...diagnosticRows.flatMap((item) => [item.label, item.value]),
    ...issueRows,
  ].filter(Boolean).join('|');
  const triggerRef = useRef(null);
  const popoverRef = useRef(null);
  const dialogId = useId();
  const [isOpen, setIsOpen] = useState(false);
  const [position, setPosition] = useState(null);

  const closePopover = useCallback(({ restoreFocus = false } = {}) => {
    setIsOpen(false);
    setPosition(null);
    if (restoreFocus) {
      triggerRef.current?.focus();
    }
  }, []);

  const updatePosition = useCallback(() => {
    if (!triggerRef.current || !popoverRef.current || typeof window === 'undefined') return;
    const triggerRect = triggerRef.current.getBoundingClientRect();
    const popoverRect = popoverRef.current.getBoundingClientRect();
    const margin = 12;
    const gap = 7;
    const width = popoverRect.width || Math.min(292, window.innerWidth - (margin * 2));
    const height = popoverRect.height || 160;
    const maxLeft = Math.max(margin, window.innerWidth - width - margin);
    const left = Math.min(Math.max(margin, triggerRect.left), maxLeft);
    const belowTop = triggerRect.bottom + gap;
    const top = belowTop + height <= window.innerHeight - margin
      ? belowTop
      : Math.max(margin, triggerRect.top - height - gap);
    setPosition({ left, top });
  }, []);

  useLayoutEffect(() => {
    if (!isOpen) return;
    updatePosition();
  }, [isOpen, popoverContentKey, updatePosition]);

  useEffect(() => {
    if (!isOpen) return undefined;

    const handlePointerDown = (event) => {
      if (triggerRef.current?.contains(event.target) || popoverRef.current?.contains(event.target)) return;
      closePopover();
    };
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') closePopover({ restoreFocus: true });
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [closePopover, isOpen, updatePosition]);

  const togglePopover = () => {
    if (!isOpen) setPosition(null);
    setIsOpen((open) => !open);
  };

  const popover = isOpen && typeof document !== 'undefined'
    ? createPortal(
      <section
        ref={popoverRef}
        id={dialogId}
        className="efr-status-popover"
        data-tone={meta.tone}
        role="dialog"
        aria-modal="false"
        aria-label={`${context} data status`}
        style={{
          left: position?.left ?? 0,
          top: position?.top ?? 0,
          visibility: position ? 'visible' : 'hidden',
        }}
      >
        <header className="efr-status-popover__header">
          <h3>{context}</h3>
          <button
            type="button"
            className="efr-status-popover__close"
            aria-label={`Close ${context} data status`}
            onClick={() => closePopover({ restoreFocus: true })}
          >
            <span aria-hidden="true">×</span>
          </button>
        </header>
        <div className="efr-status-popover__state">
          <span className="efr-status-popover__state-dot" aria-hidden="true" />
          <strong>{visibleLabel}</strong>
        </div>
        <p className="efr-status-popover__summary">
          {summary || getStatusSummary(normalizedStatus, visibleLabel)}
        </p>
        {detail ? <p className="efr-status-popover__detail">{detail}</p> : null}
        {diagnosticRows.length > 0 ? (
          <dl className="efr-status-popover__diagnostics">
            {diagnosticRows.map((item, index) => (
              <div key={`${item.label || 'detail'}-${item.value}-${index}`}>
                {item.label ? <dt>{item.label}</dt> : null}
                <dd>{item.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {issueRows.length > 0 ? (
          <div className="efr-status-popover__issues">
            <strong>Issues</strong>
            <ul>
              {issueRows.map((issue, index) => <li key={`${issue}-${index}`}>{issue}</li>)}
            </ul>
          </div>
        ) : null}
      </section>,
      document.body,
    )
    : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`efr-status-chip efr-status-chip--${meta.tone}${compact ? ' efr-status-chip--compact' : ''}${indicatorOnly ? ' efr-status-chip--indicator-only' : ''}${className ? ` ${className}` : ''}`}
        title={title || accessibleLabel}
        aria-label={accessibleLabel}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        aria-controls={isOpen ? dialogId : undefined}
        data-status={normalizedStatus}
        onClick={togglePopover}
      >
        <span className="efr-status-chip__dot" aria-hidden="true" />
        {!indicatorOnly ? <span>{visibleLabel}</span> : null}
        {!indicatorOnly && detail ? <span className="efr-status-chip__detail">{detail}</span> : null}
      </button>
      {popover}
    </>
  );
};

export { getStatusSummary, normalizeStatus };
export default DataStatusChip;
