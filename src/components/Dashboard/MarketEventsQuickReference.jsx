import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useSurfaceActivity } from '../common/PersistentSurface';
import MarketEventsBriefingModal from './MarketEventsBriefingModal';
import MarketEventsNavigationPopover from './MarketEventsNavigationPopover';
import { marketEventDateTime, marketEventPacificPreviousDay, marketEventTime } from '../../utils/marketEventTime';
import {
  MARKET_EVENTS_MAX_AGE_MS,
  MARKET_EVENTS_NEXT_PROVIDER,
  MARKET_EVENTS_NEXT_SOURCE_URL,
  MARKET_EVENTS_PROVIDER,
  MARKET_EVENTS_SOURCE_URL,
  addMarketDateKeyDays,
  currentMarketEventWeek,
  isMarketClosure,
  isMarketDateCovered,
  marketEventEtDateKey,
  useMarketEvents,
  validateMarketEventsSnapshot,
} from '../../hooks/useMarketEvents';
import './MarketEventsQuickReference.css';
import LoadingIndicator from '../common/LoadingIndicator';

const TODAY_REFRESH_MS = 5 * 60 * 1000;
const CLOCK_SKEW_MS = 2 * 60 * 1000;
// After a release, re-check for its actual more often than the regular poll.
const ACTUAL_REFRESH_MS = 2 * 60 * 1000;
const ACTUAL_WAIT_WINDOW_MS = 60 * 60 * 1000;
const MAX_TIMEOUT_MS = 2 ** 31 - 1;
const systemNow = () => new Date();

function dateKeyDate(dateKey) {
  return new Date(`${dateKey}T12:00:00.000Z`);
}

function dayHeading(dateKey, includeMonth = false) {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    day: 'numeric',
    ...(includeMonth ? { month: 'short' } : {}),
    timeZone: 'UTC',
  }).format(dateKeyDate(dateKey)).toUpperCase();
}

function weekdayHeading(dateKey) {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    timeZone: 'UTC',
  }).format(dateKeyDate(dateKey)).toUpperCase();
}

function coverageLabel(coverage) {
  if (!coverage?.from || !coverage?.to) return 'Current week';
  const from = dateKeyDate(coverage.from);
  const to = dateKeyDate(coverage.to);
  const start = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(from);
  const end = new Intl.DateTimeFormat('en-US', {
    month: from.getUTCMonth() === to.getUTCMonth() ? undefined : 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(to);
  return `${start}–${end}`;
}

function displayValue(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  const text = String(value).trim();
  return /\d/.test(text) ? text : null;
}

export function marketEventFigures(event) {
  return [
    { label: 'Actual', value: displayValue(event.actual) },
    { label: 'Consensus', value: displayValue(event.forecast) },
    { label: 'Prior', value: displayValue(event.previous) },
  ].filter(({ value }) => value !== null);
}

export function marketEventDetails(event) {
  const sourceDate = new Date(event.lastUpdatedAt || event.observedAt || '');
  const sourceTime = !Number.isNaN(sourceDate.getTime())
    ? marketEventDateTime(sourceDate)
    : 'unavailable';
  if (isMarketClosure(event)) {
    return [`${event.countryCode} ${event.name}`, event.detail, `Source: ${event.provider}`].filter(Boolean).join(' · ');
  }
  return [
    `${event.countryCode} ${event.name}`,
    marketEventDateTime(event.startAt),
    ...marketEventFigures(event).map(({ label, value }) => `${label}: ${value}`),
    `Source: ${event.provider}`,
    `Source ${event.lastUpdatedAt ? 'updated' : 'observed'}: ${sourceTime}`,
    ...(displayValue(event.actual) ? [`Actual source: ${event.actualSource}`] : []),
  ].join(' · ');
}

export function isMarketEventReleased(event, currentTime) {
  return Date.parse(event.startAt) <= Number(currentTime);
}

function expectsActual(event) {
  return displayValue(event.forecast) !== null || displayValue(event.previous) !== null;
}

function isAwaitingActual(event, currentTime) {
  const startMs = Date.parse(event.startAt);
  return displayValue(event.actual) === null && expectsActual(event)
    && startMs <= currentTime && currentTime - startMs <= ACTUAL_WAIT_WINDOW_MS;
}

export function isCurrentVerifiedSnapshot(data, currentTime = Date.now(), week = 'this') {
  try {
    validateMarketEventsSnapshot(data, { currentTime, week });
  } catch {
    return false;
  }
  const fetchedAt = Date.parse(data.fetchedAt || '');
  const age = Number(currentTime) - fetchedAt;
  return Number.isFinite(fetchedAt)
    && age >= -CLOCK_SKEW_MS
    && age <= MARKET_EVENTS_MAX_AGE_MS;
}

function EventsState({ status, reason, onRetry, week }) {
  if (status === 'loading') {
    return <div className="market-events-state"><LoadingIndicator label="Loading verified calendar…" size="sm" /></div>;
  }
  return (
    <div className="market-events-state" role="status" title={reason || undefined}>
      <span>{week === 'next' ? 'Next week unavailable' : 'Calendar unavailable'}</span>
      {week === 'next'
        ? <a href={MARKET_EVENTS_NEXT_SOURCE_URL} target="_blank" rel="noreferrer">Open source calendar ↗</a>
        : <button type="button" onClick={onRetry}>Retry</button>}
    </div>
  );
}

const EVENT_ROW_HEIGHT = 9;
const EVENT_ROW_GAP = 2;

function EventFigures({ event, released }) {
  const actual = displayValue(event.actual);
  const figures = marketEventFigures(event).filter(({ label }) => label !== 'Actual');
  const pending = released && !actual && figures.length > 0;
  if (!actual && !pending && !figures.length) return null;
  return (
    <span className="market-events-day__figures">
      {actual && (
        <a className="market-events-day__figure market-events-day__actual" href={event.actualSourceUrl}
          target="_blank" rel="noreferrer"
          title={`Actual from ${event.actualSource} · checked ${marketEventDateTime(event.actualObservedAt)}`}>
          <small>Actual</small> {actual} <small>TE ↗</small>
        </a>
      )}
      {pending && (
        <span className="market-events-day__figure market-events-day__actual is-pending"
          title="Released — waiting for Trading Economics to post the actual">
          <small>Actual</small> —
        </span>
      )}
      {figures.map(({ label, value }) => (
        <span key={label} className="market-events-day__figure"><small>{label}</small> {value}</span>
      ))}
    </span>
  );
}

function EventRows({ events, onOpen, currentTime, rowHeight = EVENT_ROW_HEIGHT, fitContent = false }) {
  const listRef = useRef(null);
  const [capacity, setCapacity] = useState(null);

  useLayoutEffect(() => {
    if (fitContent) return undefined;
    const list = listRef.current;
    const measure = () => {
      const height = list.clientHeight;
      setCapacity(Math.max(1, Math.floor((height + EVENT_ROW_GAP) / (rowHeight + EVENT_ROW_GAP))));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    return () => observer.disconnect();
  }, [fitContent, rowHeight]);

  // Use the last available row for an event when everything fits. Only
  // replace it with the overflow control when additional events remain.
  const limit = fitContent || capacity == null || events.length <= capacity ? events.length : capacity - 1;
  const visibleEvents = events.slice(0, limit);
  return (
      <ol ref={listRef} style={fitContent ? undefined : { gridAutoRows: rowHeight, rowGap: EVENT_ROW_GAP }}>
        {visibleEvents.map((event) => {
          const released = isMarketEventReleased(event, currentTime);
          return (
          <li key={event.id} title={marketEventDetails(event)} className={isMarketClosure(event) ? 'is-closure' : undefined}>
            {isMarketClosure(event) && event.allDay
              ? <time dateTime={marketEventEtDateKey(event.startAt)} aria-label="All day">Closed</time>
              : <time dateTime={event.startAt} title={marketEventDateTime(event.startAt)} aria-label={marketEventDateTime(event.startAt)}>
              {marketEventTime(event.startAt)}
              {marketEventPacificPreviousDay(event.startAt) && <sup title="Pacific time is on the previous calendar day">−1d</sup>}
            </time>}
            <b>{event.countryCode}</b>
            <span>{event.name}</span>
            {fitContent && <EventFigures event={event} released={released} />}
          </li>
          );
        })}
      {events.length > visibleEvents.length ? (
        <li className="market-events-day__overflow">
          <button className="market-events-day__more" type="button" onClick={onOpen}>+{events.length - visibleEvents.length} more</button>
        </li>
      ) : null}
      </ol>
  );
}

function EmptyDay({ covered }) {
  return <p>{covered ? 'No high-impact events' : 'Not covered yet'}</p>;
}

function WeekAgenda({ events, days, coverage, onOpen, currentTime, fitContent = false }) {
  const byDay = new Map(days.map(({ key }) => [key, []]));
  events.forEach((event) => {
    const key = marketEventEtDateKey(event.startAt);
    if (byDay.has(key)) byDay.get(key).push(event);
  });

  return (
    <div className="market-events-agenda" style={{ gridTemplateColumns: `repeat(${Math.max(1, days.length)}, minmax(0, 1fr))` }}>
      {!days.length && <div className="market-events-state">No trading days remaining this week</div>}
      {days.map((day) => {
        const dayEvents = byDay.get(day.key);
        const covered = isMarketDateCovered(day.key, coverage);
        const relativeLabel = ['TODAY', 'TOMORROW'].includes(day.label);
        return (
          <section className="market-events-day" key={day.key} aria-label={`${day.label} market events`}>
            <header>
              <button className="market-events-day__heading" type="button" onClick={() => onOpen(day)}
                aria-label={`Open ${day.label.toLowerCase()} market events`} aria-haspopup="dialog">
                <strong>{relativeLabel ? day.label : dayHeading(day.key, fitContent)}</strong>
                {relativeLabel && <>
                  {fitContent && <span aria-hidden="true">·</span>}
                  <span>{dayHeading(day.key, fitContent)}</span>
                </>}
              </button>
            </header>
            {covered && dayEvents.length
              ? <EventRows events={dayEvents} onOpen={() => onOpen(day)} currentTime={currentTime} fitContent={fitContent} />
              : <EmptyDay covered={covered} />}
          </section>
        );
      })}
    </div>
  );
}

function SourceFooter({ data, view }) {
  if (view === 'next') {
    return (
      <footer className="market-events-quick-reference__sources">
        Schedule, consensus &amp; prior: <a href={data.sourceUrl} target="_blank" rel="noreferrer">{data.provider} ↗</a>
      </footer>
    );
  }
  const actuals = data.actuals;
  const actualsNote = actuals?.status === 'unavailable'
    ? ' (temporarily unavailable)'
    : actuals?.observedAt ? ` · checked ${marketEventTime(actuals.observedAt)}` : '';
  return (
    <footer className="market-events-quick-reference__sources">
      <span>
        Schedule, consensus &amp; prior: <a href={data.sourceUrl} target="_blank" rel="noreferrer">{data.provider} ↗</a>
      </span>
      <span>
        Actuals: <a href={actuals?.sourceUrl || MARKET_EVENTS_NEXT_SOURCE_URL} target="_blank" rel="noreferrer">
          {actuals?.provider || MARKET_EVENTS_NEXT_PROVIDER} ↗</a>{actualsNote}
      </span>
    </footer>
  );
}

function weekDays(todayKey, week) {
  const coverage = currentMarketEventWeek(`${todayKey}T12:00:00Z`, week);
  return Array.from({ length: 5 }, (_, index) => addMarketDateKeyDays(coverage.from, index + 1))
    .filter(key => week === 'next' || key >= todayKey)
    .map(key => ({
      key,
      label: key === todayKey ? 'TODAY'
        : key === addMarketDateKeyDays(todayKey, 1) ? 'TOMORROW' : weekdayHeading(key),
    }));
}

function calendarState(resource, currentTime, week) {
  if (resource.initialLoading || ['idle', 'loading'].includes(resource.availability)) {
    return { status: 'loading', data: null, reason: null };
  }
  if (resource.availability !== 'live' || !isCurrentVerifiedSnapshot(resource.data, currentTime, week)) {
    return {
      status: 'unavailable',
      data: null,
      reason: resource.error?.message || 'A current verified calendar is unavailable.',
    };
  }
  return { status: 'verified', data: resource.data, reason: null };
}

// Closures already looked at in the dock popover; the button stops being blue
// once each of today's closures has been seen. Stored per browser only.
const SEEN_CLOSURES_KEY = 'marketEvents.seenClosures.v1';
function readSeenClosures() {
  try {
    const value = JSON.parse(window.localStorage.getItem(SEEN_CLOSURES_KEY) || '[]');
    return Array.isArray(value) ? value.filter(id => typeof id === 'string') : [];
  } catch {
    return [];
  }
}
function writeSeenClosures(ids) {
  try {
    window.localStorage.setItem(SEEN_CLOSURES_KEY, JSON.stringify(ids));
  } catch {
    // Without storage the button simply stays blue for today's closures.
  }
}

const MarketEventsQuickReference = ({ now = systemNow, compact = false }) => {
  const [todayKey, setTodayKey] = useState(() => (
    marketEventEtDateKey(now()) || marketEventEtDateKey(new Date())
  ));
  const [view, setView] = useState('this');
  const [selectedDay, setSelectedDay] = useState(null);
  const [, setClockTick] = useState(0);
  const active = useSurfaceActivity();
  const closeBriefing = useCallback(() => setSelectedDay(null), []);
  const days = weekDays(todayKey, view);
  const currentResource = useMarketEvents({ week: 'this' });
  const nextResource = useMarketEvents({ week: 'next', active: view === 'next' });
  const resource = view === 'next' ? nextResource : currentResource;
  const [seenClosures, setSeenClosures] = useState(readSeenClosures);
  const todayClosureIdsRef = useRef([]);
  const openCalendar = useCallback(() => {
    setView('this');
    setSelectedDay(null);
    const ids = todayClosureIdsRef.current;
    if (!ids.length) return;
    setSeenClosures(previous => {
      if (ids.every(id => previous.includes(id))) return previous;
      // Keep only today's ids so the list never grows.
      writeSeenClosures(ids);
      return ids;
    });
  }, []);

  useEffect(() => { setSelectedDay(null); }, [active, todayKey, view]);

  useEffect(() => {
    const interval = setInterval(() => {
      const nextToday = marketEventEtDateKey(now());
      if (nextToday) setTodayKey(nextToday);
      setClockTick((tick) => tick + 1);
    }, TODAY_REFRESH_MS);
    return () => clearInterval(interval);
  }, [now]);

  const currentTime = new Date(now()).getTime();
  const currentState = calendarState(currentResource, currentTime, 'this');
  const state = view === 'this' ? currentState : calendarState(nextResource, currentTime, 'next');
  const sourceProvider = state.data?.provider || (view === 'next' ? MARKET_EVENTS_NEXT_PROVIDER : MARKET_EVENTS_PROVIDER);
  const sourceUrl = state.data?.sourceUrl || (view === 'next' ? MARKET_EVENTS_NEXT_SOURCE_URL : MARKET_EVENTS_SOURCE_URL);
  const todayCovered = currentState.status === 'verified' && isMarketDateCovered(todayKey, currentState.data.coverage);
  const todayEvents = todayCovered
    ? currentState.data.events.filter(event => marketEventEtDateKey(event.startAt) === todayKey)
    : [];
  const nextReleaseMs = state.status === 'verified'
    ? Math.min(...state.data.events.map(event => Date.parse(event.startAt)).filter(ms => ms > currentTime))
    : Infinity;
  const awaitingActual = currentState.status === 'verified'
    && currentState.data.events.some(event => isAwaitingActual(event, currentTime));
  const refreshCurrent = currentResource.refresh;

  // Re-render the moment the next event releases so its row turns blue.
  useEffect(() => {
    if (!Number.isFinite(nextReleaseMs)) return undefined;
    const delay = Math.min(MAX_TIMEOUT_MS, Math.max(0, nextReleaseMs - new Date(now()).getTime()) + 500);
    const timeout = setTimeout(() => setClockTick((tick) => tick + 1), delay);
    return () => clearTimeout(timeout);
  }, [nextReleaseMs, now]);

  useEffect(() => {
    if (!awaitingActual || typeof refreshCurrent !== 'function') return undefined;
    const interval = setInterval(() => {
      if (document.visibilityState !== 'hidden') refreshCurrent();
      setClockTick((tick) => tick + 1);
    }, ACTUAL_REFRESH_MS);
    return () => clearInterval(interval);
  }, [awaitingActual, refreshCurrent]);

  const calendar = (
    <section className={`market-events-quick-reference ${compact ? 'market-events-quick-reference--agenda-popover' : 'usd-card-section usd-card-section--market-events'}`} aria-label="Market events quick reference">
      <header className="market-events-quick-reference__header">
        <h3 title="Verified high-impact macro events">Market Events</h3>
        {!compact && <a
          href={sourceUrl}
          target="_blank"
          rel="noreferrer"
          title={`${sourceProvider} calendar source`}
        >
          {sourceProvider === MARKET_EVENTS_NEXT_PROVIDER ? 'TE' : 'FF'}
        </a>}
        <span title="Event times shown in Pacific Time (Eastern Time). Calendar days follow Eastern Time; −1d marks the previous Pacific day.">PT (ET)</span>
        <nav aria-label="Market events view">
          <button type="button" aria-pressed={view === 'this'} onClick={() => setView('this')}>This week</button>
          <button type="button" aria-pressed={view === 'next'} onClick={() => setView('next')}>Next week</button>
        </nav>
      </header>
      <div className="market-events-quick-reference__body">
        {state.status !== 'verified' ? (
          <EventsState
            status={state.status}
            reason={state.reason}
            week={view}
            onRetry={resource.refresh}
          />
        ) : (
          <WeekAgenda
            events={state.data.events}
            days={days}
            coverage={state.data.coverage}
            onOpen={setSelectedDay}
            currentTime={currentTime}
            fitContent={compact}
          />
        )}
      </div>
      {compact && state.status === 'verified' && <SourceFooter data={state.data} view={view} />}
      {active && selectedDay && <MarketEventsBriefingModal day={selectedDay} days={days} state={state}
        provider={sourceProvider} sourceUrl={sourceUrl}
        onDayChange={setSelectedDay} onClose={closeBriefing} onRetry={resource.refresh} />}
    </section>
  );

  if (!compact) return calendar;
  // A closure or early close today turns the dock button blue; releases never do.
  const todayClosures = todayEvents.filter(isMarketClosure);
  todayClosureIdsRef.current = todayClosures.map(event => event.id);
  const unseenClosure = todayClosures.some(event => !seenClosures.includes(event.id));
  const count = todayEvents.length - todayClosures.length;
  const detail = todayCovered
    ? `${todayClosures.length ? `${todayClosures.map(event => `${event.countryCode} ${event.name}`).join('; ')} · ` : ''}${count} high-impact event${count === 1 ? '' : 's'} today · PT (ET) · Forex Factory · Source updated ${marketEventDateTime(currentState.data.sourceUpdatedAt)}`
    : currentState.status === 'loading' ? 'Loading verified calendar' : 'Calendar unavailable';
  return <MarketEventsNavigationPopover detail={detail} closure={unseenClosure} briefingOpen={Boolean(selectedDay)} onOpen={openCalendar}>
    {calendar}
  </MarketEventsNavigationPopover>;
};

export { coverageLabel, dayHeading, marketEventTime };
export default MarketEventsQuickReference;
