import React from 'react';
import './ExceptionFirstRadar.css';

const STATUS_ALIASES = {
  active: 'live',
  current: 'live',
  connected: 'live',
  mixed_delayed: 'mixed',
  'mixed/delayed': 'mixed',
  'as-of': 'historical',
  stale: 'historical',
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

const normalizeStatus = (status) => {
  const key = String(status || 'unavailable').trim().toLowerCase();
  return STATUS_ALIASES[key] || (DATA_STATUS_META[key] ? key : 'unavailable');
};

/**
 * Explicit data-state badge used by the Exception-First Radar.
 * Unlike StatusDot, this component never maps delayed or historical data to green.
 */
const DataStatusChip = ({ status, label, detail, className = '', title, compact = false }) => {
  const normalizedStatus = normalizeStatus(status);
  const meta = DATA_STATUS_META[normalizedStatus];
  const visibleLabel = label || meta.label;
  const accessibleLabel = detail ? `${visibleLabel} · ${detail}` : visibleLabel;

  return (
    <span
      className={`efr-status-chip efr-status-chip--${meta.tone}${compact ? ' efr-status-chip--compact' : ''}${className ? ` ${className}` : ''}`}
      title={title || accessibleLabel}
      aria-label={accessibleLabel}
      data-status={normalizedStatus}
    >
      <span className="efr-status-chip__dot" aria-hidden="true" />
      <span>{visibleLabel}</span>
      {detail ? <span className="efr-status-chip__detail">{detail}</span> : null}
    </span>
  );
};

export { normalizeStatus };
export default DataStatusChip;
