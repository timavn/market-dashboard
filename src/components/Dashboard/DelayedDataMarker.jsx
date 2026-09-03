import React, {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import './DelayedDataMarker.css';

const MARKED_DATA_STATUSES = new Set([
  'delayed',
  'delayed-reference',
  'historical',
  'reference',
  'refresh-delayed',
  'stale',
]);

const DEFAULT_LABELS = Object.freeze({
  delayed: 'Delayed data',
  'delayed-reference': 'Delayed reference data',
  historical: 'Historical data',
  reference: 'Reference data',
  'refresh-delayed': 'Refresh delayed; showing last verified data',
  stale: 'Stale data',
});

export const DEFAULT_DELAYED_DATA_THRESHOLD_MS = 2 * 60 * 1000;
const MAX_FUTURE_TIMESTAMP_SKEW_MS = 5 * 60 * 1000;
const POPOVER_GAP_PX = 6;
const POPOVER_VIEWPORT_PADDING_PX = 8;
const INITIAL_POPOVER_POSITION = Object.freeze({
  top: 0,
  left: 0,
  placement: 'bottom',
  ready: false,
});

// D is an age badge, not a provider badge. Provider provenance stays on the
// surrounding datum, while every dashboard surface uses this one threshold.
export const shouldMarkDataDelayed = (
  status,
  updatedAt,
  now = Date.now(),
  thresholdMs = DEFAULT_DELAYED_DATA_THRESHOLD_MS,
) => {
  if (!MARKED_DATA_STATUSES.has(String(status || '').trim().toLowerCase())) return false;

  const timestamp = Date.parse(String(updatedAt || ''));
  if (!Number.isFinite(timestamp)) return true;

  const ageMs = Number(now) - timestamp;
  if (ageMs < -MAX_FUTURE_TIMESTAMP_SKEW_MS) return true;
  return ageMs > thresholdMs;
};

export const formatDelayedDataTimestamp = (value, status = 'delayed') => {
  const rawValue = String(value || '').trim();
  if (!rawValue) return 'Updated time unavailable';
  const timestamp = Date.parse(rawValue);
  if (!Number.isFinite(timestamp)) return `Updated ${rawValue}`;

  const normalizedStatus = String(status || '').trim().toLowerCase();
  const dailyObservation = ['historical', 'reference'].includes(normalizedStatus)
    && (/^\d{4}-\d{2}-\d{2}$/.test(rawValue) || /T00:00:00(?:\.000)?Z$/i.test(rawValue));
  const formatter = new Intl.DateTimeFormat('en-US', dailyObservation
    ? {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    }
    : {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      timeZoneName: 'short',
    });
  return `Updated ${formatter.format(new Date(timestamp))}`;
};

const DelayedDataMarker = ({
  status = 'delayed',
  title,
  updatedAt,
  className = '',
}) => {
  const normalizedStatus = String(status || '').trim().toLowerCase();
  const [open, setOpen] = useState(false);
  const [freshnessNow, setFreshnessNow] = useState(() => Date.now());
  const [popoverPosition, setPopoverPosition] = useState(INITIAL_POPOVER_POSITION);
  const markerRef = useRef(null);
  const triggerRef = useRef(null);
  const popoverRef = useRef(null);
  const popoverId = useId();
  const updatedLabel = formatDelayedDataTimestamp(updatedAt, normalizedStatus);
  const markerVisible = shouldMarkDataDelayed(
    normalizedStatus,
    updatedAt,
    Math.max(freshnessNow, Date.now()),
  );

  useEffect(() => {
    if (!MARKED_DATA_STATUSES.has(normalizedStatus)) return undefined;
    const timestamp = Date.parse(String(updatedAt || ''));
    if (!Number.isFinite(timestamp)) return undefined;

    const now = Date.now();
    const ageMs = now - timestamp;
    if (ageMs > DEFAULT_DELAYED_DATA_THRESHOLD_MS || ageMs < -MAX_FUTURE_TIMESTAMP_SKEW_MS) {
      return undefined;
    }

    const timeoutId = window.setTimeout(
      () => setFreshnessNow(Date.now()),
      Math.max(25, DEFAULT_DELAYED_DATA_THRESHOLD_MS - ageMs + 25),
    );
    return () => window.clearTimeout(timeoutId);
  }, [normalizedStatus, updatedAt]);

  useEffect(() => {
    if (!markerVisible && open) setOpen(false);
  }, [markerVisible, open]);

  useLayoutEffect(() => {
    if (!open) return undefined;

    const positionPopover = () => {
      const trigger = triggerRef.current;
      const popover = popoverRef.current;
      if (!trigger || !popover) return;

      const triggerRect = trigger.getBoundingClientRect();
      const popoverRect = popover.getBoundingClientRect();
      const belowTop = triggerRect.bottom + POPOVER_GAP_PX;
      const aboveTop = triggerRect.top - popoverRect.height - POPOVER_GAP_PX;
      const canFitBelow = belowTop + popoverRect.height
        <= window.innerHeight - POPOVER_VIEWPORT_PADDING_PX;
      const canFitAbove = aboveTop >= POPOVER_VIEWPORT_PADDING_PX;
      const placement = !canFitBelow && canFitAbove ? 'top' : 'bottom';
      const desiredTop = placement === 'top' ? aboveTop : belowTop;
      const maxTop = Math.max(
        POPOVER_VIEWPORT_PADDING_PX,
        window.innerHeight - POPOVER_VIEWPORT_PADDING_PX - popoverRect.height,
      );
      const top = Math.min(
        maxTop,
        Math.max(POPOVER_VIEWPORT_PADDING_PX, desiredTop),
      );

      const triggerCenter = triggerRect.left + (triggerRect.width / 2);
      const halfPopoverWidth = popoverRect.width / 2;
      const minLeft = POPOVER_VIEWPORT_PADDING_PX + halfPopoverWidth;
      const maxLeft = window.innerWidth - POPOVER_VIEWPORT_PADDING_PX - halfPopoverWidth;
      const left = minLeft <= maxLeft
        ? Math.min(maxLeft, Math.max(minLeft, triggerCenter))
        : window.innerWidth / 2;

      setPopoverPosition({ top, left, placement, ready: true });
    };

    positionPopover();
    window.addEventListener('resize', positionPopover);
    window.addEventListener('scroll', positionPopover, true);
    return () => {
      window.removeEventListener('resize', positionPopover);
      window.removeEventListener('scroll', positionPopover, true);
    };
  }, [open, updatedLabel]);

  useEffect(() => {
    if (!open) return undefined;
    const handlePointerDown = (event) => {
      if (
        !markerRef.current?.contains(event.target)
        && !popoverRef.current?.contains(event.target)
      ) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  if (!markerVisible) return null;

  const accessibleLabel = title || DEFAULT_LABELS[normalizedStatus] || DEFAULT_LABELS.delayed;
  return (
    <span
      ref={markerRef}
      className={`dashboard-delayed-data-marker-wrap${className ? ` ${className}` : ''}`}
    >
      <button
        ref={triggerRef}
        type="button"
        className="dashboard-delayed-data-marker-trigger"
        data-data-status={normalizedStatus}
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        aria-label={`${accessibleLabel}. ${updatedLabel}`}
        onClick={(event) => {
          event.stopPropagation();
          setPopoverPosition(INITIAL_POPOVER_POSITION);
          setOpen((current) => !current);
        }}
      >
        <sub className="dashboard-delayed-data-marker" aria-hidden="true">D</sub>
      </button>
      {open && typeof document !== 'undefined'
        ? createPortal(
          <span
            ref={popoverRef}
            id={popoverId}
            className="dashboard-delayed-data-timestamp"
            role="status"
            data-placement={popoverPosition.placement}
            style={{
              top: `${popoverPosition.top}px`,
              left: `${popoverPosition.left}px`,
              visibility: popoverPosition.ready ? 'visible' : 'hidden',
            }}
          >
            {updatedLabel}
          </span>,
          document.body,
        )
        : null}
    </span>
  );
};

export default DelayedDataMarker;
