import React, {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import {
  addCalendarDays,
  dateKeyToUtcDate,
  isTradingDateKey,
  usEquityCloseMinutes,
} from '../../utils/usEquityMarketCalendar.cjs';
import './DelayedDataMarker.css';

const MARKED_DATA_STATUSES = new Set([
  'delayed',
  'delayed-reference',
  'historical',
  'last-close',
  'reference',
  'refresh-delayed',
  'stale',
]);

const DEFAULT_LABELS = Object.freeze({
  delayed: 'Delayed data',
  'delayed-reference': 'Delayed reference data',
  historical: 'Historical data',
  'last-close': 'Delayed data',
  reference: 'Reference data',
  'refresh-delayed': 'Refresh delayed; showing last verified data',
  stale: 'Stale data',
});

const POPOVER_GAP_PX = 6;
const POPOVER_VIEWPORT_PADDING_PX = 8;
const INITIAL_POPOVER_POSITION = Object.freeze({
  top: 0,
  left: 0,
  placement: 'bottom',
  ready: false,
});

// D is a data-state badge. A provider-delayed observation must be identified
// immediately rather than appearing live during an arbitrary grace period.
export const shouldMarkDataDelayed = (status) => (
  MARKED_DATA_STATUSES.has(String(status || '').trim().toLowerCase())
);

const DAY_MS = 24 * 60 * 60 * 1000;
const marketClockFormatters = new Map();

const marketClockParts = (timestamp, timeZone) => {
  try {
    if (!marketClockFormatters.has(timeZone)) {
      marketClockFormatters.set(timeZone, new Intl.DateTimeFormat('en-US', {
        timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      }));
    }
    const parts = Object.fromEntries(marketClockFormatters.get(timeZone)
      .formatToParts(new Date(timestamp)).map(({ type, value }) => [type, value]));
    return {
      date: `${parts.year}-${parts.month}-${parts.day}`,
      minutes: Number(parts.hour) * 60 + Number(parts.minute),
    };
  } catch {
    return null;
  }
};

// Color describes the age of retained informational evidence; it never changes
// quote availability or promotes a delayed observation to executable data.
export const getDelayedDataAgeStatus = ({
  updatedAt,
  marketSessionDate,
  observationFrequency,
  marketTimeZone = 'America/New_York',
  marketOpenTime = '09:30',
  marketCalendar = 'US',
  marketHolidays = [],
  continuous = false,
  nowMs = Date.now(),
} = {}) => {
  const rawUpdatedAt = String(updatedAt || '').trim();
  const observationMs = Date.parse(rawUpdatedAt);
  const isoDate = /^\d{4}-\d{2}-\d{2}(?:$|T)/.test(rawUpdatedAt)
    ? rawUpdatedAt.slice(0, 10) : null;
  if (!Number.isFinite(observationMs) || !Number.isFinite(nowMs)
    || (isoDate && !dateKeyToUtcDate(isoDate))
    || observationMs > nowMs || observationFrequency === 'monthly') return 'older-session';

  if (continuous) {
    // A date alone does not establish a rolling 24-hour observation time.
    if (/^\d{4}-\d{2}-\d{2}$/.test(rawUpdatedAt)) return 'older-session';
    return nowMs - observationMs < DAY_MS ? 'same-session' : 'older-session';
  }

  const current = marketClockParts(nowMs, marketTimeZone);
  const observed = marketClockParts(observationMs, marketTimeZone);
  const openTimeMatch = /^(\d{2}):(\d{2})$/.exec(String(marketOpenTime));
  if (!current || !observed || !openTimeMatch) return 'older-session';
  const openHour = Number(openTimeMatch[1]);
  const openMinute = Number(openTimeMatch[2]);
  if (openHour > 23 || openMinute > 59) return 'older-session';

  const holidayDates = new Set((Array.isArray(marketHolidays) ? marketHolidays : []).map((holiday) => (
    typeof holiday === 'string' ? holiday : holiday?.date
  )));
  const isMarketDate = (dateKey) => {
    const date = dateKeyToUtcDate(dateKey);
    if (!date || holidayDates.has(dateKey)) return false;
    if (marketCalendar === 'US') return isTradingDateKey(dateKey);
    return date.getUTCDay() !== 0 && date.getUTCDay() !== 6;
  };
  let latestOpenedDate = current.date;
  if (!isMarketDate(latestOpenedDate) || current.minutes < openHour * 60 + openMinute) {
    latestOpenedDate = addCalendarDays(latestOpenedDate, -1);
  }
  while (latestOpenedDate && !isMarketDate(latestOpenedDate)) {
    latestOpenedDate = addCalendarDays(latestOpenedDate, -1);
  }

  // Explicit source session dates and date-only daily observations keep their
  // source date instead of shifting midnight UTC into the preceding US day.
  const observationDate = marketSessionDate
    || (/^\d{4}-\d{2}-\d{2}$/.test(rawUpdatedAt)
      || (observationFrequency === 'daily' && /T00:00:00(?:\.000)?Z$/i.test(rawUpdatedAt))
      ? rawUpdatedAt.slice(0, 10) : observed.date);
  if (!dateKeyToUtcDate(observationDate) || !isMarketDate(observationDate)
    || observationDate > current.date) return 'older-session';
  return observationDate >= latestOpenedDate ? 'same-session' : 'older-session';
};

// C replaces D when a price is the final print of its market's latest session and that market is now
// closed, so it will not move until the next open; D stays on anything still trading or delayed
// (user-specified 2026-11-22). Only quote values qualify; return and reference cells keep D.
const CLOSE_ELIGIBLE_STATUSES = new Set(['delayed', 'last-close', 'refresh-delayed', 'historical', 'stale']);
const CLOSE_PRINT_TOLERANCE_MINUTES = 20;
const minutesOf = (value) => {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value || ''));
  return match && Number(match[1]) < 24 && Number(match[2]) < 60 ? Number(match[1]) * 60 + Number(match[2]) : null;
};
const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const weekdayIn = (timestamp, timeZone) => {
  try {
    return WEEKDAY_INDEX[new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(new Date(timestamp))];
  } catch {
    return undefined;
  }
};

export const settledCloseState = ({
  status,
  updatedAt,
  marketSessionDate,
  observationFrequency,
  marketTimeZone = 'America/New_York',
  marketOpenTime = '09:30',
  marketCloseTime,
  marketCalendar = 'US',
  marketHolidays = [],
  marketSchedule,
  continuous = false,
  nowMs = Date.now(),
} = {}) => {
  if (continuous || !CLOSE_ELIGIBLE_STATUSES.has(String(status || '').trim().toLowerCase())
    || observationFrequency === 'monthly') return null;
  const rawUpdatedAt = String(updatedAt || '').trim();
  const observationMs = Date.parse(rawUpdatedAt);
  if (!Number.isFinite(observationMs) || !Number.isFinite(nowMs) || observationMs > nowMs) return null;
  // A daily value stored at midnight UTC carries only its date, as the timestamp label reads it.
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(rawUpdatedAt)
    || (['historical', 'reference', 'refresh-delayed'].includes(String(status).trim().toLowerCase())
      && /T00:00:00(?:\.000)?Z$/i.test(rawUpdatedAt));
  const current = marketClockParts(nowMs, marketTimeZone);
  const observed = marketClockParts(observationMs, marketTimeZone);
  if (!current || !observed) return null;

  if (marketSchedule === 'weekly') {
    // Closed from Friday 17:00 to Sunday 18:00 New York. Its contracts settle from 14:20 (grains) to 17:00
    // (FX, energy), so a print from 14:00 is that day's close. Over the weekend Friday's is the latest;
    // any earlier day's close, then or during the week, is one that stopped updating.
    if (dateOnly || observed.minutes < 14 * 60) return null;
    const day = weekdayIn(nowMs, marketTimeZone);
    const weekendClosed = (day === 5 && current.minutes >= 17 * 60) || day === 6 || (day === 0 && current.minutes < 18 * 60);
    let previous = addCalendarDays(current.date, -1);
    while (previous && [0, 6].includes(dateKeyToUtcDate(previous)?.getUTCDay())) previous = addCalendarDays(previous, -1);
    if (weekendClosed) {
      const friday = addCalendarDays(current.date, -(day === 5 ? 0 : day === 6 ? 1 : 2));
      return observed.date === friday ? 'latest' : observed.date < friday ? 'older' : null;
    }
    return previous && observed.date < previous ? 'older' : null;
  }

  const holidayDates = new Set((Array.isArray(marketHolidays) ? marketHolidays : []).map((holiday) => (
    typeof holiday === 'string' ? holiday : holiday?.date
  )));
  const isMarketDate = (dateKey) => {
    const date = dateKeyToUtcDate(dateKey);
    if (!date || holidayDates.has(dateKey)) return false;
    if (marketCalendar === 'US') return isTradingDateKey(dateKey);
    return date.getUTCDay() !== 0 && date.getUTCDay() !== 6;
  };
  const closeMinutesOn = (dateKey) => (marketCalendar === 'US' && !marketCloseTime
    ? usEquityCloseMinutes(dateKey) : minutesOf(marketCloseTime || '16:00'));
  const openMinutes = minutesOf(marketOpenTime);
  if (openMinutes === null) return null;

  // The latest session that has finished; while one is in progress, the one before it.
  const inProgress = isMarketDate(current.date) && current.minutes >= openMinutes
    && current.minutes < closeMinutesOn(current.date);
  let session = current.date;
  if (inProgress || !isMarketDate(session) || current.minutes < openMinutes) {
    session = addCalendarDays(session, -1);
    while (session && !isMarketDate(session)) session = addCalendarDays(session, -1);
  }
  if (!session) return null;
  const observationDate = marketSessionDate
    || (dateOnly || (observationFrequency === 'daily' && /T00:00:00(?:\.000)?Z$/i.test(rawUpdatedAt))
      ? rawUpdatedAt.slice(0, 10) : observed.date);
  if (!isMarketDate(observationDate) || observationDate > session) return null;
  // A date-only daily close is that session's close; a timed print must be its closing one (or later).
  const closingPrint = dateOnly || /T00:00:00(?:\.000)?Z$/i.test(rawUpdatedAt) || observed.date > observationDate
    || (observed.date === observationDate && observed.minutes >= closeMinutesOn(observationDate) - CLOSE_PRINT_TOLERANCE_MINUTES);
  if (!closingPrint) return null;
  // Black C: the previous session's close while the market is shut. Red C: a close from any earlier day
  // (user-specified 2026-11-22: an easy sign that something is not updating).
  if (observationDate < session) return 'older';
  return inProgress ? null : 'latest';
};

// True for any close a C marks, black or red.
export const isSettledSessionClose = (options) => settledCloseState(options) !== null;

const markerClockSubscribers = new Map();
let markerClockTimer = null;
const notifyMarkerClock = () => {
  const nowMs = Date.now();
  markerClockSubscribers.forEach((_deadline, notify) => notify(nowMs));
};
const scheduleMarkerClock = () => {
  // One shared timer lets session colors roll over even when providers are down.
  clearTimeout(markerClockTimer);
  const nowMs = Date.now();
  const nextMinuteMs = nowMs + 60 * 1000 - (nowMs % (60 * 1000));
  const nextTickMs = [...markerClockSubscribers.values()]
    .filter((deadline) => Number.isFinite(deadline) && deadline > nowMs)
    .reduce((nextTick, deadline) => Math.min(nextTick, deadline), nextMinuteMs);
  markerClockTimer = setTimeout(() => {
    notifyMarkerClock();
    if (markerClockSubscribers.size) scheduleMarkerClock();
  }, nextTickMs - nowMs);
};

export const useDelayedDataMarkerClock = (enabled = true, nextChangeAt) => {
  const [nowMs, setNowMs] = useState(Date.now);
  useEffect(() => {
    if (!enabled) return undefined;
    setNowMs(Date.now());
    markerClockSubscribers.set(setNowMs, nextChangeAt);
    scheduleMarkerClock();
    if (markerClockSubscribers.size === 1) {
      window.addEventListener('focus', notifyMarkerClock);
      document.addEventListener('visibilitychange', notifyMarkerClock);
    }
    return () => {
      markerClockSubscribers.delete(setNowMs);
      if (!markerClockSubscribers.size) {
        clearTimeout(markerClockTimer);
        markerClockTimer = null;
        window.removeEventListener('focus', notifyMarkerClock);
        document.removeEventListener('visibilitychange', notifyMarkerClock);
      }
    };
  }, [enabled, nextChangeAt]);
  // Provider updates can render between clock ticks. Evaluate their timestamp
  // against the current instant, while the shared timer forces aging renders.
  return Math.max(nowMs, Date.now());
};

export const formatDelayedDataTimestamp = (value, status = 'delayed', observationFrequency) => {
  const rawValue = String(value || '').trim();
  if (!rawValue) return 'Updated time unavailable';
  const timestamp = Date.parse(rawValue);
  if (!Number.isFinite(timestamp)) return `Updated ${rawValue}`;

  if (observationFrequency === 'monthly') {
    return `Observation ${new Intl.DateTimeFormat('en-US', {
      year: 'numeric', month: 'short', timeZone: 'UTC',
    }).format(new Date(timestamp))}`;
  }

  const normalizedStatus = String(status || '').trim().toLowerCase();
  const dailyObservation = /^\d{4}-\d{2}-\d{2}$/.test(rawValue)
    || (['historical', 'reference', 'refresh-delayed'].includes(normalizedStatus) && /T00:00:00(?:\.000)?Z$/i.test(rawValue));
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
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'short',
    });
  return `Updated ${formatter.format(new Date(timestamp))}`;
};

const DelayedDataMarker = ({
  status = 'delayed',
  title,
  updatedAt,
  observationFrequency,
  marketSessionDate,
  marketTimeZone,
  marketOpenTime,
  marketCloseTime,
  marketCalendar,
  marketHolidays,
  marketSchedule,
  continuous,
  popoverLabel,
  // Only a price can be a close (C); day changes, returns and report dates keep D.
  priceMarker = true,
  className = '',
}) => {
  const normalizedStatus = String(status || '').trim().toLowerCase();
  const [open, setOpen] = useState(false);
  const [popoverPosition, setPopoverPosition] = useState(INITIAL_POPOVER_POSITION);
  const markerRef = useRef(null);
  const triggerRef = useRef(null);
  const popoverRef = useRef(null);
  const popoverId = useId();
  const updatedLabel = formatDelayedDataTimestamp(updatedAt, normalizedStatus, observationFrequency);
  const displayedLabel = popoverLabel || updatedLabel;
  const markerVisible = shouldMarkDataDelayed(normalizedStatus);
  const nextChangeAt = continuous ? Date.parse(String(updatedAt || '')) + DAY_MS : undefined;
  const nowMs = useDelayedDataMarkerClock(markerVisible, nextChangeAt);
  const dataAge = getDelayedDataAgeStatus({
    updatedAt, observationFrequency, marketSessionDate, marketTimeZone,
    marketOpenTime, marketCalendar, marketHolidays, continuous, nowMs,
  });
  const closeState = markerVisible && priceMarker ? settledCloseState({
    status: normalizedStatus, updatedAt, observationFrequency, marketSessionDate, marketTimeZone,
    marketOpenTime, marketCloseTime, marketCalendar, marketHolidays, marketSchedule, continuous, nowMs,
  }) : null;
  const settledClose = closeState !== null;
  const closeNote = closeState === 'older' ? 'Close from an earlier session, not updating' : 'Close, market closed';
  const shownLabel = settledClose ? `${displayedLabel} · ${closeNote}` : displayedLabel;

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
  }, [open, shownLabel]);

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
        title=""
        data-data-status={normalizedStatus}
        data-data-age={dataAge}
        data-settled-close={settledClose ? 'true' : undefined}
        data-close-age={closeState || undefined}
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        aria-label={`${popoverLabel || `${accessibleLabel}. ${updatedLabel}`}${settledClose ? `. ${closeNote}` : ''}`}
        onClick={(event) => {
          event.stopPropagation();
          setPopoverPosition(INITIAL_POPOVER_POSITION);
          setOpen((current) => !current);
        }}
      >
        <sub className={`dashboard-delayed-data-marker dashboard-delayed-data-marker--${closeState === 'older' ? 'close-older' : settledClose ? 'close' : dataAge}`} aria-hidden="true">{settledClose ? 'C' : 'D'}</sub>
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
            {shownLabel}
          </span>,
          document.body,
        )
        : null}
    </span>
  );
};

export default DelayedDataMarker;
