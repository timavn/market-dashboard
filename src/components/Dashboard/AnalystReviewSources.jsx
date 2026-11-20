import React, { useCallback, useEffect, useId, useReducer, useRef, useState } from 'react';
// Vite and Jest resolve lucide-react to src/vendor/lucide-react.js; use only its icons.
import { CalendarClock, CheckCircle2, Info, RefreshCw, X } from 'lucide-react';
import { formatAnalystReportDate, presentAnalystReportDates } from '../../utils/analystReportDates';
import { useSurfaceActivity } from '../common/PersistentSurface';
import { verificationSourceDate } from './analystVerificationSources';
import { pendingReviewSourceItems } from '../../services/analyst/analystReviewSourceCatalog.cjs';
import { reviewSourceDisplayItems } from '../../services/analyst/analystReviewSourcePresentation.cjs';
import { loadingReviewSourceItems, rememberReviewSourceRoster } from '../../services/analyst/analystReviewSourceRoster';
import AnalystSpinner from './AnalystSpinner';
import LoadingIndicator from '../common/LoadingIndicator';
import './AnalystReviewSources.css';

const statuses = {
  ready: { label: 'Ready', Icon: CheckCircle2 },
  partial: { label: 'Partial', Icon: Info },
  checking: { label: 'Checking', Icon: RefreshCw },
  unavailable: { label: 'Unavailable', Icon: X },
  missing: { label: 'Missing', Icon: X },
  pending: { label: 'Pending', Icon: CalendarClock },
  indexed: { label: 'Indexed', Icon: CheckCircle2 },
  late: { label: 'Late', Icon: Info },
  // Display only: an unfinished row whose metadata read has stopped.
  unchecked: { label: 'Not checked', Icon: Info },
};
// A settled missing row gives its captured reason in one short word.
const missingReasons = {
  RESEARCH_PUBLICATION_LATE: { label: 'Late', Icon: Info },
  RESEARCH_NOT_DUE: { label: 'Not due', Icon: CalendarClock },
  SOURCE_NOT_ATTEMPTED: { label: 'Not checked', Icon: Info },
  SOURCE_CHECK_INCOMPLETE: { label: 'Not checked', Icon: Info },
  IBKR_CONNECTION_UNVERIFIED_NOT_ATTEMPTED: { label: 'Not checked', Icon: Info },
};
const settledStates = new Set(['succeeded', 'complete', 'ready', 'partial', 'failed', 'cancelled', 'interrupted']);
const activeStates = new Set(['queued', 'accepted', 'preparing', 'acquiring', 'running', 'checking']);
const notDue = item => item.status === 'missing' && item.diagnostic?.code === 'RESEARCH_NOT_DUE';
// Optional, paused, and not-yet-due sources do not count against readiness.
const countsTowardReady = item => item.optional !== true && item.status !== 'pending' && !notDue(item);

function elapsedLabel(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

function checkedIn(milliseconds) {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || milliseconds > 600_000) return '';
  return `Checked in ${milliseconds < 60_000 ? `${(milliseconds / 1000).toFixed(1)} s` : elapsedLabel(milliseconds)}`;
}

// One header clock per Sources table, ticking on its own second boundary.
function useElapsedSince(startedAt, ticking) {
  const [, tick] = useReducer(value => value + 1, 0);
  const start = typeof startedAt === 'string' ? Date.parse(startedAt) : NaN;
  const running = ticking && Number.isFinite(start);
  useEffect(() => {
    if (!running) return undefined;
    let interval;
    const timeout = setTimeout(() => {
      tick();
      interval = setInterval(tick, 1000);
    }, 1000 - (((Date.now() - start) % 1000) + 1000) % 1000);
    return () => { clearTimeout(timeout); clearInterval(interval); };
  }, [running, start]);
  return running ? elapsedLabel(Date.now() - start) : '';
}

function timestamp(value) {
  if (!value || typeof value !== 'string') return null;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  // A source time needs an explicit timezone; never assume the browser's zone.
  if (!dateOnly && !/T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) return null;
  const label = formatAnalystReportDate(value, { year: false });
  return label === '—' ? null : { value, label, dateOnly };
}

function explanationText(value) {
  return typeof value === 'string' ? presentAnalystReportDates(value.trim()).slice(0, 600) : '';
}

function SourceStatus({ item, status, label, Icon, indexed, open, onToggle, onClose }) {
  const container = useRef(null);
  const button = useRef(null);
  const popup = useRef(null);
  const popupId = useId();
  const actionable = status === 'partial' || status === 'unavailable' || status === 'missing';
  const detail = explanationText(item.diagnostic?.reason) || explanationText(item.detail || (indexed ? item.publicationLabel : ''))
    || (status === 'partial' ? 'Only part of this source was verified for this review.' : 'This source was not verified for this review.');
  const remedy = explanationText(item.diagnostic?.remedy)
    || 'The cause and required fix have not yet been verified.';

  useEffect(() => {
    if (!open) return undefined;
    popup.current?.focus({ preventScroll: true });
    const outside = event => {
      if (!container.current?.contains(event.target)) onClose();
    };
    const escape = event => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
      button.current?.focus({ preventScroll: true });
    };
    document.addEventListener('mousedown', outside, true);
    document.addEventListener('focusin', outside);
    document.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('mousedown', outside, true);
      document.removeEventListener('focusin', outside);
      document.removeEventListener('keydown', escape, true);
    };
  }, [open, onClose]);

  return <span ref={container} className="analyst-review-source-status">
    {actionable ? <button ref={button} type="button" className="analyst-review-source-status-content analyst-review-source-status-button"
      aria-label={`${item.label}: ${label}. Show explanation`} aria-haspopup="dialog" aria-expanded={open}
      aria-controls={open ? popupId : undefined}
      onClick={event => { event.stopPropagation(); onToggle(); }}>
      <Icon size={12} aria-hidden="true" /><span>{label}</span>
    </button> : <span className="analyst-review-source-status-content">{status === 'checking' ? <AnalystSpinner size={12} text={label} /> : <><Icon size={12} aria-hidden="true" /><span>{label}</span></>}</span>}
    {open && <span ref={popup} id={popupId} role="dialog" tabIndex={-1}
      aria-labelledby={`${popupId}-heading`} aria-describedby={`${popupId}-detail ${popupId}-remedy`}
      className="analyst-review-source-explanation" onClick={event => event.stopPropagation()}>
      <span className="analyst-review-source-explanation-heading">
        <strong id={`${popupId}-heading`}>{item.label} · {label}</strong>
        <button type="button" aria-label="Close source explanation" onClick={() => {
          onClose(); button.current?.focus({ preventScroll: true });
        }}><X size={12} aria-hidden="true" /></button>
      </span>
      <span id={`${popupId}-detail`} className="analyst-review-source-explanation-detail">{detail}</span>
      <span id={`${popupId}-remedy`} className="analyst-review-source-explanation-remedy"><strong>To fix: </strong>{remedy}</span>
    </span>}
  </span>;
}

export default function AnalystReviewSources({ sources, loading = false, readFailed = false, reconnecting = false, reviewKind, phase, modelPhase = false }) {
  const surfaceActive = useSurfaceActivity();
  const [openSource, setOpenSource] = useState(null);
  const closeExplanation = useCallback(() => setOpenSource(null), []);
  const captureKey = `${sources?.conversationId || ''}:${sources?.runId || ''}:${sources?.basis || ''}`;
  // Only the server settles a capture. A failed metadata read never turns
  // its unfinished rows into a terminal Unavailable (AGENTS.md).
  const settled = settledStates.has(sources?.state);
  const acquiring = !settled && !readFailed && (loading || activeStates.has(sources?.state) || sources?.basis === 'pending');
  // The loading rows are the last loaded review's rows, so the menu keeps its rows and size when it settles.
  const pendingItems = reviewSourceDisplayItems(loadingReviewSourceItems(reviewKind));
  // A queued or partial acquisition may publish no rows yet. Keep the same
  // reserved source slots until each captured result arrives, without changing
  // any explicit failure or adding evidence to a settled historical capture.
  // Without rows, only a settled capture says its sources were not checked; a
  // failed read leaves them unchecked, never Unavailable (AGENTS.md).
  // Until the first result arrives, a loading list is only a reservation, and it can name rows the loaded
  // review never shows. The reserved rows stand in for it, so those rows never flash in and out.
  const reserved = new Set(pendingItems.map(item => item.id));
  const reservation = acquiring && reserved.size > 0 && Array.isArray(sources?.items)
    && sources.items.every(item => item?.status === 'checking');
  const suppliedItems = Array.isArray(sources?.items)
    ? [...(acquiring ? pendingItems : []), ...reviewSourceDisplayItems(sources.items)
      .filter(item => !reservation || reserved.has(item.id))]
    : settled ? reviewSourceDisplayItems(pendingReviewSourceItems(reviewKind, 'missing')) : pendingItems;
  const sourceOrder = new Map(pendingItems.map((item, index) => [item.id, index]));
  const items = [...new Map(suppliedItems
    .filter(item => item?.id && item?.label).map(item => [item.id, item])).values()]
    .sort((left, right) => (sourceOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (sourceOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER));
  const counted = items.filter(countsTowardReady);
  const ready = counted.filter(item => item.status === 'ready').length;
  const indexed = sources?.basis === 'indexed-research';
  const captured = items.filter(item => item.publicationLabel && item.status !== 'unavailable').length;
  const checking = !settled && !readFailed && (acquiring || items.some(item => item.status === 'checking'));
  // Checking appears only while a read is scheduled. A stopped read leaves an
  // unfinished row Not checked; only a terminal capture settles it Unavailable.
  const sourceStatus = item => item.status === 'checking' ? settled ? 'unavailable' : readFailed ? 'unchecked' : 'checking'
    : statuses[item.status] ? item.status : 'unavailable';
  // Model work continues after its sources settle; a failed read replaces the
  // acquisition phase with its own short notice while rows keep their state.
  // While sources are still being read their own row rings are the progress,
  // so the header shows a phase ring and clock only for model work after them.
  const showPhase = Boolean(phase) && settled && modelPhase;
  // The acquisition phase is still announced, for screen readers only.
  const quietPhase = Boolean(phase) && !settled && !reconnecting && !readFailed;
  // Reviews count from their run's creation, through any model phase that
  // follows settled sources. The clock is decorative; the polite region must
  // not announce it.
  const elapsed = useElapsedSince(sources?.capturedAt, showPhase);
  const notice = !settled && (reconnecting ? 'Reconnecting…' : readFailed ? 'Unavailable' : '');
  const openItem = surfaceActive && openSource?.captureKey === captureKey && items.find(item => item.id === openSource.id
    && sourceStatus(item) === openSource.status);

  useEffect(() => {
    if (!openItem) closeExplanation();
  }, [openItem, closeExplanation]);

  // A loaded review's rows become the next load's reserved rows.
  const loadedRoster = settled && Array.isArray(sources?.items) ? JSON.stringify(items.map(({ id, label }) => ({ id, label }))) : '';
  useEffect(() => {
    if (loadedRoster) rememberReviewSourceRoster(reviewKind, sources, JSON.parse(loadedRoster));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the roster string and capture identify the loaded review.
  }, [loadedRoster, reviewKind, captureKey, sources?.state, sources?.capturedAt]);

  return (
    <section className="analyst-review-sources" aria-label="Review sources" aria-busy={checking} title={presentAnalystReportDates(sources?.detail) || undefined}>
      <header className="analyst-review-sources-heading">
        <span className="analyst-review-sources-progress">
          {showPhase ? <span role="status" aria-label="Response running"><AnalystSpinner size={12} text={phase} /></span>
            : quietPhase ? <span role="status" aria-label="Response running" className="sr-only">{phase}</span>
              : notice && <span>{notice}</span>}
          {elapsed && <span className="analyst-review-sources-elapsed" aria-hidden="true">{elapsed}</span>}
        </span>
        <h3>Sources</h3>
        {items.length > 0 && !checking && <span aria-live="polite">{indexed ? `${captured}/${items.length} indexed` : `${ready}/${counted.length} ready`}</span>}
      </header>
      {items.length > 0 ? (
        <ul className="analyst-review-sources-list">
          {items.map(item => {
            const status = sourceStatus(item);
            const reason = status === 'missing' ? missingReasons[item.diagnostic?.code] || statuses.missing : statuses[status];
            const { Icon } = reason;
            const label = item.id === 'ibGateway' && item.connectionState === 'disconnected' ? 'Disconnected'
                : item.id === 'ibGateway' && status === 'unavailable' && item.connectionState === 'unverified' ? 'Unverified' : reason.label;
            // A settled check's duration belongs in secondary hover detail only.
            const title = [presentAnalystReportDates(item.detail || (indexed ? item.publicationLabel : '')),
              status !== 'checking' && checkedIn(item.elapsedMs)].filter(Boolean).join(' · ');
            // A partial archive has a verified capture time and retained valid evidence.
            // Failed attempts still cannot supply a displayable source date.
            const dated = status === 'ready' || (status === 'partial' && item.id === 'portfolioRefreshResearch');
            const times = dated ? [timestamp(item.observedAt), timestamp(item.publishedAt)].filter(Boolean) : [];
            const observed = indexed
              ? (status !== 'unavailable' ? verificationSourceDate(item.publicationLabel) : null)
              : times.find(time => !time.dateOnly) || times[0];
            return (
              <li key={item.id} className={`analyst-review-source is-${status}`} title={title || undefined}>
                <span className="analyst-review-source-label" title={item.label}>{item.label}</span>
                <span className="analyst-review-source-time">
                  {observed ? (observed.value
                    ? <time className="analyst-process--key" dateTime={observed.value}>{observed.label}</time>
                    : <span className="analyst-process--key">{observed.label}</span>)
                    : status !== 'checking' && <span aria-label="Source time unavailable">—</span>}
                </span>
                <SourceStatus item={item} status={status} Icon={Icon} label={label} indexed={indexed}
                  open={Boolean(openItem && openSource.id === item.id)} onClose={closeExplanation}
                  onToggle={() => setOpenSource(current => current?.captureKey === captureKey && current.id === item.id && current.status === status
                    ? null : { captureKey, id: item.id, status })} />
              </li>
            );
          })}
        </ul>
      ) : <p className="analyst-review-sources-empty" role="status">{checking ? <LoadingIndicator label="Checking sources…" size="sm" announce={false} /> : 'UNAVAILABLE'}</p>}
    </section>
  );
}
