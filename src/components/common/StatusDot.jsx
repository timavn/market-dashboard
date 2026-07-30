import React, { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  formatDateOnly,
  formatLastUpdated,
  formatLastUpdatedForSources
} from '../../utils/timeUtils';

function sourceCardTestId(id) {
  return `status-source-card-${String(id || 'source').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
}

const STATUS_DIALOG_WIDTH = 520;
const STATUS_DIALOG_MARGIN = 16;
const STATUS_DOT_MIN_HIT_TARGET = 24;

function normalizeStatus(status) {
  const normalized = String(status || '').trim().toLowerCase();

  if (['active', 'current', 'live', 'connected', 'ready', 'open'].includes(normalized)) {
    return 'active';
  }

  if (['failed', 'offline', 'unavailable'].includes(normalized)) {
    return 'error';
  }

  if (['checking', 'loading', 'refreshing'].includes(normalized)) {
    return 'loading';
  }

  if (['degraded', 'partial', 'reference', 'warning'].includes(normalized)) {
    return 'stale';
  }

  return normalized || null;
}

function aggregateStatus(status, sourceRows) {
  const explicitStatus = normalizeStatus(status);
  if (!Array.isArray(sourceRows) || sourceRows.length === 0) {
    return explicitStatus;
  }

  const statuses = sourceRows.map((source) => normalizeStatus(source?.status) || 'unknown');
  if (explicitStatus) statuses.push(explicitStatus);

  if (statuses.some((value) => ['inactive', 'defective', 'error', 'missing'].includes(value))) {
    return 'inactive';
  }
  if (statuses.some((value) => value === 'unknown')) return 'unknown';
  if (statuses.some((value) => value === 'stale')) return 'stale';
  if (statuses.some((value) => value === 'delayed')) return 'delayed';
  if (statuses.some((value) => value === 'loading')) return 'loading';
  if (statuses.some((value) => value === 'historical')) return 'historical';
  if (statuses.every((value) => value === 'active')) return 'active';

  return 'unknown';
}

function getDisplayStatus(source, visibleRows = []) {
  const rawStatus = normalizeStatus(source?.status);
  const rawDetail = String(source?.localeString || '').toLowerCase();
  const stateLabel = String(source?.stateLabel || '').trim();

  if (stateLabel) {
    if (rawStatus === 'active') {
      return { label: stateLabel, className: 'text-emerald-700' };
    }
    if (rawStatus === 'stale' || rawStatus === 'delayed') {
      return { label: stateLabel, className: 'text-[#ca8a04]' };
    }
    if (rawStatus === 'loading') {
      return { label: stateLabel, className: 'text-slate-500' };
    }
    if (['inactive', 'defective', 'error', 'missing'].includes(rawStatus)) {
      return { label: stateLabel, className: 'text-[#dc2626]' };
    }
  }

  if (rawStatus === 'loading' || /checking|loading|refreshing/.test(rawDetail)) {
    return { label: 'Checking', className: 'text-slate-500' };
  }

  if (rawStatus === 'active') {
    return { label: 'Live', className: 'text-emerald-700' };
  }

  if (rawStatus === 'delayed') {
    return { label: 'Delayed', className: 'text-[#175cd3]' };
  }

  if (rawStatus === 'historical') {
    return { label: 'As of', className: 'text-[#42648f]' };
  }

  if (rawStatus === 'stale') {
    return { label: 'Stale', className: 'text-[#ca8a04]' };
  }

  if (rawStatus === 'inactive' || rawStatus === 'defective' || rawStatus === 'error') {
    return { label: 'Error', className: 'text-[#dc2626]' };
  }

  if (rawStatus === 'missing' || rawStatus === 'unknown') {
    return visibleRows.length > 0
      ? { label: 'Error', className: 'text-[#dc2626]' }
      : { label: 'Unknown', className: 'text-slate-500' };
  }

  if (rawDetail === 'live' || rawDetail === 'current') {
    return { label: 'Live', className: 'text-emerald-700' };
  }

  if (rawDetail === 'error' || rawDetail === 'offline') {
    return { label: 'Error', className: 'text-[#dc2626]' };
  }

  return visibleRows.length > 0
    ? { label: 'Error', className: 'text-[#dc2626]' }
    : { label: 'Unknown', className: 'text-slate-500' };
}

function getStatusRuleClass(displayLabel) {
  if (displayLabel === 'Error') return 'border-red-200';
  if (displayLabel === 'Stale') return 'border-yellow-200';
  return 'border-blue-100';
}

function shouldShowDetailValue(source, displayLabel) {
  const detail = String(source?.localeString || '').trim();
  if (!detail) return false;
  if (detail === displayLabel) return false;
  return !['Live', 'Current', 'Error', 'Checking', 'Unknown'].includes(detail);
}

/**
 * StatusDot
 *
 * Clickable status indicator dot that opens a small popover showing
 * the last refresh time and relative age of the data powering a card.
 *
 * Props:
 * - updatedAt: Date | string | number – timestamp for last refresh
 * - status: 'active' | 'inactive' | 'stale' | undefined – optional explicit status
 * - size: number – dot size in px
 * - className: string – extra classes for positioning
 * - label: string – optional label describing which data this refers to
 * - emoji: string – optional emoji to render for shiny-dot style
 * - sources: optional array of sub-sources to show in popup
 * - overallLabel: optional override label for overall line
 * - showDateOnly: optional boolean to show only the update date
 */
const StatusDot = ({
  updatedAt,
  status,
  size = 8,
  className = '',
  label,
  emoji,
  sources,
  overallLabel,
  showDateOnly = false,
}) => {
  const [open, setOpen] = useState(false);
  const [popupPos, setPopupPos] = useState({ top: 0, left: 0, right: 'auto' });
  const [acknowledgedWarnings, setAcknowledgedWarnings] = useState({});
  const [expandedAcknowledged, setExpandedAcknowledged] = useState({});
  const [dragging, setDragging] = useState(false);
  const containerRef = useRef(null);
  const buttonRef = useRef(null);
  const popoverRef = useRef(null);
  const dragRef = useRef(null);
  const positionedByDragRef = useRef(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const raw = window.localStorage.getItem('dashboard.statusDot.acknowledgedWarnings');
      setAcknowledgedWarnings(raw ? JSON.parse(raw) : {});
    } catch {
      setAcknowledgedWarnings({});
    }
  }, []);

  const acknowledgeWarning = useCallback((key) => {
    if (!key) return;
    setAcknowledgedWarnings((current) => {
      const next = { ...current, [key]: new Date().toISOString() };
      if (typeof window !== 'undefined') {
        try {
          window.localStorage.setItem('dashboard.statusDot.acknowledgedWarnings', JSON.stringify(next));
        } catch {
          // Ignore storage failures; the UI still updates for this session.
        }
      }
      return next;
    });
  }, []);

  const normalizeDetailRow = useCallback((src, detail, index) => {
    if (detail && typeof detail === 'object') {
      const text = detail.text || detail.message || detail.label || '';
      const key = detail.id || detail.key || `${src.id || src.label || 'source'}:${text}`;
      return {
        key,
        text,
        acknowledgeable: Boolean(detail.acknowledgeable ?? src.acknowledgeableDetails),
        acknowledged: Boolean(acknowledgedWarnings[key]),
      };
    }
    const text = String(detail || '');
    const key = `${src.id || src.label || 'source'}:${index}:${text}`;
    return {
      key,
      text,
      acknowledgeable: Boolean(src.acknowledgeableDetails),
      acknowledged: Boolean(acknowledgedWarnings[key]),
    };
  }, [acknowledgedWarnings]);

  const toggleAcknowledgedRows = useCallback((sourceId) => {
    setExpandedAcknowledged((current) => ({
      ...current,
      [sourceId]: !current[sourceId],
    }));
  }, []);

  const effectiveSources = Array.isArray(sources)
    ? sources.map((src) => {
        const acknowledgeableRows = (src.detailRows || [])
          .map((detail, index) => normalizeDetailRow(src, detail, index))
          .filter((detail) => detail.acknowledgeable);
        const activeWarnings = acknowledgeableRows.filter((detail) => !detail.acknowledged).length;
        const acknowledgedCount = acknowledgeableRows.length - activeWarnings;
        const warningResolved = Boolean(src.acknowledgeableStatus && acknowledgeableRows.length > 0 && activeWarnings === 0);
        const effectiveSourceStatus = warningResolved ? (src.acknowledgedStatus || 'current') : src.status;
        return {
          ...src,
          status: normalizeStatus(effectiveSourceStatus) || 'unknown',
          detail: warningResolved && src.acknowledgedDetail ? src.acknowledgedDetail : src.detail,
          acknowledgedCount,
          activeWarnings,
        };
      })
    : null;

  const updatedDate = updatedAt ? new Date(updatedAt) : null;
  const updatedTime = updatedDate?.getTime();
  const hasValidUpdatedDate = Number.isFinite(updatedTime);
  const hoursAgo = hasValidUpdatedDate ? (Date.now() - updatedTime) / (1000 * 60 * 60) : null;
  const aggregateStatusValue = aggregateStatus(status, effectiveSources);
  const effectiveStatus = aggregateStatusValue || (() => {
    if (updatedAt && !hasValidUpdatedDate) return 'inactive';
    if (hoursAgo == null) return 'unknown';
    if (hoursAgo < 24) return 'active';
    if (hoursAgo < 72) return 'stale';
    return 'inactive';
  })();

  const effectiveEmoji = emoji && effectiveStatus === 'active'
    ? '🟢'
    : emoji && (effectiveStatus === 'stale' || effectiveStatus === 'delayed')
      ? '🟡'
      : emoji && effectiveStatus === 'historical'
        ? '🔵'
      : emoji && ['inactive', 'defective', 'error', 'missing'].includes(effectiveStatus)
        ? '🔴'
        : emoji
          ? '⚪'
          : emoji;

  let colorClass = 'bg-gray-400';
  let colorTone = {
    top: '#e5e7eb',
    base: '#9ca3af',
    dark: '#4b5563',
    ring: 'rgba(75, 85, 99, 0.35)',
    glow: 'rgba(75, 85, 99, 0.18)',
  };
  if (effectiveStatus === 'active' || effectiveStatus === 'current') {
    colorClass = 'bg-green-500';
    colorTone = {
      top: '#bbf7d0',
      base: '#22c55e',
      dark: '#15803d',
      ring: 'rgba(21, 128, 61, 0.42)',
      glow: 'rgba(34, 197, 94, 0.24)',
    };
  } else if (['inactive', 'defective', 'error', 'missing'].includes(effectiveStatus)) {
    colorClass = 'bg-red-500';
    colorTone = {
      top: '#fecaca',
      base: '#ef4444',
      dark: '#b91c1c',
      ring: 'rgba(185, 28, 28, 0.42)',
      glow: 'rgba(239, 68, 68, 0.22)',
    };
  } else if (effectiveStatus === 'stale' || effectiveStatus === 'delayed') {
    colorClass = 'bg-yellow-500';
    colorTone = {
      top: '#fef9c3',
      base: '#facc15',
      dark: '#a16207',
      ring: 'rgba(161, 98, 7, 0.42)',
      glow: 'rgba(250, 204, 21, 0.28)',
    };
  } else if (effectiveStatus === 'historical') {
    colorClass = 'bg-blue-500';
    colorTone = {
      top: '#dbeafe',
      base: '#3b82f6',
      dark: '#1d4ed8',
      ring: 'rgba(29, 78, 216, 0.38)',
      glow: 'rgba(59, 130, 246, 0.2)',
    };
  }

  // Close on outside click / Escape
  useEffect(() => {
    if (!open) return;

    const handleClickOutside = (event) => {
      const target = event.target;
      const inContainer = containerRef.current && containerRef.current.contains(target);
      const inPopover = popoverRef.current && popoverRef.current.contains(target);
      if (!inContainer && !inPopover) {
        setOpen(false);
      }
    };

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const calculatePosition = useCallback(() => {
    if (typeof window === 'undefined') return;
    const width = Math.min(STATUS_DIALOG_WIDTH, window.innerWidth - (STATUS_DIALOG_MARGIN * 2));
    const top = Math.max(STATUS_DIALOG_MARGIN, Math.round(window.innerHeight * 0.12));
    const left = Math.max(STATUS_DIALOG_MARGIN, Math.round((window.innerWidth - width) / 2));

    setPopupPos({ top, left, right: 'auto' });
  }, []);

  const handleToggle = () => {
    if (!open) {
      positionedByDragRef.current = false;
      calculatePosition();
    }
    setOpen((prev) => !prev);
  };

  const clampPopoverPosition = useCallback((top, left) => {
    if (typeof window === 'undefined') return { top, left };
    const margin = STATUS_DIALOG_MARGIN;
    const rect = popoverRef.current?.getBoundingClientRect();
    const width = rect?.width || Math.min(STATUS_DIALOG_WIDTH, window.innerWidth - (margin * 2));
    const height = rect?.height || Math.min(window.innerHeight - (margin * 2), 560);
    return {
      top: Math.min(Math.max(margin, top), Math.max(margin, window.innerHeight - height - margin)),
      left: Math.min(Math.max(margin, left), Math.max(margin, window.innerWidth - width - margin)),
    };
  }, []);

  useLayoutEffect(() => {
    if (!open || positionedByDragRef.current || typeof window === 'undefined') return;
    const rect = popoverRef.current?.getBoundingClientRect();
    const margin = STATUS_DIALOG_MARGIN;
    const width = rect?.width || Math.min(STATUS_DIALOG_WIDTH, window.innerWidth - (margin * 2));
    const height = rect?.height || Math.min(window.innerHeight - (margin * 2), 560);
    const next = {
      top: Math.max(margin, Math.round((window.innerHeight - height) / 2)),
      left: Math.max(margin, Math.round((window.innerWidth - width) / 2)),
      right: 'auto',
    };
    setPopupPos((current) => {
      const currentTop = Number(current.top);
      const currentLeft = Number(current.left);
      const topMatches = Number.isFinite(currentTop) && Math.abs(currentTop - next.top) < 1;
      const leftMatches = Number.isFinite(currentLeft) && Math.abs(currentLeft - next.left) < 1;
      if (topMatches && leftMatches && current.right === next.right) {
        return current;
      }
      return next;
    });
  }, [open]);

  useEffect(() => {
    if (!dragging) return undefined;

    const handleMouseMove = (event) => {
      if (!dragRef.current) return;
      event.preventDefault();
      const next = clampPopoverPosition(
        event.clientY - dragRef.current.offsetY,
        event.clientX - dragRef.current.offsetX,
      );
      positionedByDragRef.current = true;
      setPopupPos({ ...next, right: 'auto' });
    };

    const handleMouseUp = () => {
      dragRef.current = null;
      setDragging(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [clampPopoverPosition, dragging]);

  const startDrag = useCallback((event) => {
    if (!popoverRef.current) return;
    if (event.button !== 0) return;
    const target = event.target;
    if (target?.closest?.('button')) return;
    const rect = popoverRef.current.getBoundingClientRect();
    dragRef.current = {
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    };
    setDragging(true);
  }, []);

  const popover = open ? (
    <div
      ref={popoverRef}
      role="dialog"
      aria-modal="false"
      aria-label={overallLabel || label || 'Status details'}
      className="fixed overflow-hidden rounded-xl border border-blue-300 bg-white text-slate-900 shadow-lg"
      style={{
        top: popupPos.top,
        left: popupPos.left,
        right: popupPos.right,
        zIndex: 2147483647,
        width: 'min(520px, calc(100vw - 32px))',
        maxHeight: 'calc(100vh - 32px)',
        boxShadow: '0 18px 45px rgba(37, 99, 235, 0.12), 0 10px 20px rgba(15, 23, 42, 0.08)',
        cursor: dragging ? 'grabbing' : undefined,
        display: 'flex',
        flexDirection: 'column',
      }}
      onMouseDown={startDrag}
      title="Drag to move"
    >
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          setOpen(false);
        }}
        className="absolute right-3 top-3 z-10 flex h-6 w-6 shrink-0 items-center justify-center rounded border border-blue-200 bg-white text-[13px] font-bold leading-none text-blue-900 hover:bg-blue-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
        aria-label={`Close ${overallLabel || label || 'status details'}`}
        title="Close"
      >
        X
      </button>
      <div
        className="overflow-y-auto px-5 pb-5 pt-9 font-mono text-[13px] leading-6"
        style={{ maxHeight: 'calc(100vh - 32px)' }}
      >
        {Array.isArray(effectiveSources) && effectiveSources.length > 0 ? (
          (() => {
            const { perSource } = formatLastUpdatedForSources(effectiveSources);
            return (
              <div className="divide-y divide-blue-100">
                {perSource.map((src) => {
                  const normalizedRows = Array.isArray(src.detailRows)
                    ? src.detailRows.map((detail, index) => normalizeDetailRow(src, detail, index))
                    : [];
                  const visibleRows = normalizedRows.filter((detail) => detail.text && !detail.acknowledged);
                  const acknowledgedRows = normalizedRows.filter((detail) => detail.text && detail.acknowledged);
                  const acknowledgedExpanded = Boolean(expandedAcknowledged[src.id]);
                  const displayStatus = getDisplayStatus(src, visibleRows);
                  const detailRows = visibleRows.filter((normalized) => normalized.text !== src.localeString);
                  const showDetailValue = shouldShowDetailValue(src, displayStatus.label);
                  const statusRuleClass = getStatusRuleClass(displayStatus.label);

                  return (
                    <section
                      key={src.id}
                      className="py-3 first:pt-1"
                      data-testid={sourceCardTestId(src.id)}
                      data-status-tone={displayStatus.label.toLowerCase()}
                    >
                      <div className="flex items-baseline justify-between gap-4">
                        <h3 className={`min-w-0 text-[15px] font-normal leading-6 ${displayStatus.className}`}>
                          {src.label}
                        </h3>
                        <span
                          className={`shrink-0 text-right text-[15px] leading-6 ${displayStatus.className}`}
                          data-testid={`${sourceCardTestId(src.id)}-state`}
                        >
                          <span>{displayStatus.label}</span>
                          {src.action && (
                            <span className="ml-2 inline-flex align-middle">
                              {src.action}
                            </span>
                          )}
                        </span>
                      </div>
                      {(showDetailValue || detailRows.length > 0 || acknowledgedRows.length > 0) && (
                        <div className={`mt-2 border-t pt-2 ${statusRuleClass}`}>
                          <div className="space-y-1.5 whitespace-normal text-[12px] leading-5 text-slate-500">
                            {showDetailValue && (
                              <div className="pl-4">{src.localeString}</div>
                            )}
                            {detailRows.map((normalized) => (
                              <div
                                key={normalized.key}
                                className="flex items-start justify-between gap-3 pl-4"
                              >
                                <span className="min-w-0">{normalized.text}</span>
                                {normalized.acknowledgeable && (
                                  <button
                                    type="button"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      acknowledgeWarning(normalized.key);
                                    }}
                                    className="shrink-0 rounded border border-blue-200 bg-white px-1.5 py-0.5 text-[10px] font-semibold text-blue-800 hover:bg-blue-50"
                                  >
                                    Clear
                                  </button>
                                )}
                              </div>
                            ))}
                            {acknowledgedRows.length > 0 && (
                              <div className="pl-4 text-emerald-700">
                                <span>
                                  {acknowledgedRows.length} warning{acknowledgedRows.length === 1 ? '' : 's'} acknowledged
                                </span>
                                <button
                                  type="button"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    toggleAcknowledgedRows(src.id);
                                  }}
                                  className="ml-2 rounded border border-emerald-200 bg-white px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 hover:bg-emerald-50"
                                >
                                  {acknowledgedExpanded ? 'Hide' : 'Show'}
                                </button>
                                {acknowledgedExpanded && (
                                  <div className="mt-1.5 space-y-1 text-slate-500">
                                    {acknowledgedRows.map((detail) => (
                                      <div
                                        key={detail.key}
                                        className="flex items-start justify-between gap-3"
                                      >
                                        <span className="min-w-0">{detail.text}</span>
                                        <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-emerald-600">
                                          Muted
                                        </span>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                    </section>
                  );
                })}
              </div>
            );
          })()
        ) : (
          (() => {
            const { localeString } = formatLastUpdated(updatedDate || null);
            const dateOnly = formatDateOnly(updatedDate || null);
            const displayStatus = getDisplayStatus({ status: effectiveStatus });
            const statusRuleClass = getStatusRuleClass(displayStatus.label);
            return (
              <div className="divide-y divide-blue-100">
                <section
                  className="py-3 first:pt-1"
                  data-testid="status-source-card-updated"
                  data-status-tone={displayStatus.label.toLowerCase()}
                >
                  <div className="flex items-baseline justify-between gap-4">
                    <h3 className={`min-w-0 text-[15px] font-normal leading-6 ${displayStatus.className}`}>
                      {label || 'Updated'}
                    </h3>
                    <span className={`shrink-0 text-right text-[15px] leading-6 ${displayStatus.className}`}>
                      {displayStatus.label}
                    </span>
                  </div>
                  <div className={`mt-2 border-t pt-2 ${statusRuleClass}`}>
                    <div className="pl-4 whitespace-normal text-[12px] leading-5 text-slate-500">
                      {showDateOnly ? `Updated: ${dateOnly}` : `Last updated: ${localeString}`}
                    </div>
                  </div>
                </section>
              </div>
            );
          })()
        )}
      </div>
    </div>
  ) : null;

  const visibleDotSize = size + (effectiveEmoji ? 2 : 0);
  const hitTargetSize = Math.max(STATUS_DOT_MIN_HIT_TARGET, visibleDotSize);

  return (
    <div
      ref={containerRef}
      className={`relative inline-flex items-center ${className}`}
      style={{ width: `${visibleDotSize}px`, height: `${visibleDotSize}px` }}
    >
      <button
        ref={buttonRef}
        type="button"
        onClick={handleToggle}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={
          label
            ? `Show status details for ${label}`
            : 'Show status details'
        }
        data-status={effectiveStatus}
        className="absolute appearance-none border-0 rounded-full cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-indigo-500"
        style={{
          width: `${hitTargetSize}px`,
          height: `${hitTargetSize}px`,
          left: '50%',
          top: '50%',
          transform: 'translate(-50%, -50%)',
          padding: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'transparent',
        }}
      >
        <span
          aria-hidden="true"
          data-testid="status-dot-visual"
          className={`rounded-full ${effectiveEmoji ? '' : colorClass}`}
          style={{
            width: `${visibleDotSize}px`,
            height: `${visibleDotSize}px`,
            flex: '0 0 auto',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: effectiveEmoji
              ? 'transparent'
              : `radial-gradient(circle at 32% 24%, #ffffff 0 10%, ${colorTone.top} 11% 28%, ${colorTone.base} 52%, ${colorTone.dark} 100%)`,
            border: effectiveEmoji ? '0' : `1px solid ${colorTone.ring}`,
            boxShadow: effectiveEmoji
              ? 'none'
              : `inset 0 1px 1px rgba(255,255,255,0.78), inset 0 -1px 1px rgba(15,23,42,0.2), 0 1px 2px rgba(15,23,42,0.16), 0 0 0 2px ${colorTone.glow}`,
          }}
        >
          {effectiveEmoji && (
            <span
              className="ticker-dot-emoji"
              style={{ fontSize: '8px', lineHeight: 1 }}
            >
              {effectiveEmoji}
            </span>
          )}
        </span>
      </button>

      {popover && createPortal(popover, document.body)}
    </div>
  );
};

export default StatusDot;
