import React, { useEffect, useMemo, useState } from 'react';
import {
  MARKET_EVENTS_MAX_AGE_MS,
  MARKET_EVENTS_SOURCE_URL,
  addMarketDateKeyDays,
  isMarketDateCovered,
  marketEventEtDateKey,
  useMarketEvents,
  validateMarketEventsSnapshot,
} from '../../hooks/useMarketEvents';
import './MarketEventsQuickReference.css';

const ET_TIME_ZONE = 'America/New_York';
const TODAY_REFRESH_MS = 5 * 60 * 1000;
const CLOCK_SKEW_MS = 2 * 60 * 1000;
const systemNow = () => new Date();

function dateKeyDate(dateKey) {
  return new Date(`${dateKey}T12:00:00.000Z`);
}

function dayHeading(dateKey) {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    day: 'numeric',
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

export function marketEventTime(startAt) {
  const date = new Date(startAt);
  if (Number.isNaN(date.getTime())) return '--';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: ET_TIME_ZONE,
    hour: 'numeric',
    minute: '2-digit',
  }).format(date).replace(/\s/g, '').replace('AM', 'a').replace('PM', 'p');
}

function displayValue(value) {
  if (value == null || String(value).trim() === '') return 'unavailable';
  return String(value).trim();
}

export function marketEventDetails(event) {
  const updatedDate = new Date(event.lastUpdatedAt || '');
  const updated = !Number.isNaN(updatedDate.getTime())
    ? new Intl.DateTimeFormat('en-US', {
      timeZone: ET_TIME_ZONE,
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    }).format(updatedDate)
    : 'unavailable';
  return [
    `${event.countryCode} ${event.name}`,
    `Consensus: ${displayValue(event.forecast)}`,
    `Prior: ${displayValue(event.previous)}`,
    'Source: Forex Factory',
    `Source updated: ${updated}`,
  ].join(' · ');
}

export function isCurrentVerifiedSnapshot(data, currentTime = Date.now()) {
  try {
    validateMarketEventsSnapshot(data, { currentTime });
  } catch {
    return false;
  }
  const fetchedAt = Date.parse(data.fetchedAt || '');
  const age = Number(currentTime) - fetchedAt;
  return Number.isFinite(fetchedAt)
    && age >= -CLOCK_SKEW_MS
    && age <= MARKET_EVENTS_MAX_AGE_MS;
}

function EventsState({ status, reason, onRetry }) {
  if (status === 'loading') {
    return <div className="market-events-state" role="status">Loading verified calendar…</div>;
  }
  return (
    <div className="market-events-state" role="status" title={reason || undefined}>
      <span>Calendar unavailable</span>
      <button type="button" onClick={onRetry}>Retry</button>
    </div>
  );
}

function EventRows({ events, limit = 4 }) {
  const visibleEvents = events.slice(0, limit);
  return (
    <>
      <ol>
        {visibleEvents.map((event) => (
          <li key={event.id} title={marketEventDetails(event)}>
            <time dateTime={event.startAt}>{marketEventTime(event.startAt)}</time>
            <b>{event.countryCode}</b>
            <span>{event.name}</span>
          </li>
        ))}
      </ol>
      {events.length > visibleEvents.length ? (
        <small>+{events.length - visibleEvents.length} more</small>
      ) : null}
    </>
  );
}

function EmptyDay({ covered }) {
  return <p>{covered ? 'No high-impact events' : 'Not covered yet'}</p>;
}

function ThreeDayAgenda({ events, todayKey, coverage }) {
  const days = [
    { key: todayKey, label: 'TODAY' },
    { key: addMarketDateKeyDays(todayKey, 1), label: 'TOMORROW' },
    { key: addMarketDateKeyDays(todayKey, 2), label: 'NEXT' },
  ];
  const byDay = new Map(days.map(({ key }) => [key, []]));
  events.forEach((event) => {
    const key = marketEventEtDateKey(event.startAt);
    if (byDay.has(key)) byDay.get(key).push(event);
  });

  return (
    <div className="market-events-agenda">
      {days.map((day) => {
        const dayEvents = byDay.get(day.key);
        const covered = isMarketDateCovered(day.key, coverage);
        return (
          <section className="market-events-day" key={day.key} aria-label={`${day.label} market events`}>
            <header>
              <strong>{day.label}</strong>
              <span>{dayHeading(day.key)}</span>
            </header>
            {covered && dayEvents.length
              ? <EventRows events={dayEvents} />
              : <EmptyDay covered={covered} />}
          </section>
        );
      })}
    </div>
  );
}

function WeekCalendar({ events, todayKey, coverage }) {
  const days = Array.from(
    { length: 7 },
    (_, index) => addMarketDateKeyDays(coverage.from, index),
  );
  const byDay = new Map(days.map((dateKey) => [dateKey, []]));
  events.forEach((event) => {
    const key = marketEventEtDateKey(event.startAt);
    if (byDay.has(key)) byDay.get(key).push(event);
  });

  return (
    <div className="market-events-week">
      <div className="market-events-week__coverage">Verified week · {coverageLabel(coverage)} ET</div>
      <div className="market-events-week__grid" role="grid" aria-label={`${coverageLabel(coverage)} market events`}>
        {days.map((dateKey) => {
          const dayEvents = byDay.get(dateKey);
          return (
            <section
              className={`market-events-week__day${dateKey === todayKey ? ' is-today' : ''}`}
              key={dateKey}
              role="gridcell"
              aria-label={`${dayHeading(dateKey)}; ${dayEvents.length} high-impact event${dayEvents.length === 1 ? '' : 's'}`}
            >
              <header>
                <strong>{weekdayHeading(dateKey)}</strong>
                <time dateTime={dateKey}>{Number(dateKey.slice(-2))}</time>
              </header>
              {dayEvents.length ? (
                <div className="market-events-week__events">
                  {dayEvents.slice(0, 2).map((event) => (
                    <span key={event.id} title={marketEventDetails(event)}>
                      <b>{event.countryCode}</b> {event.name}
                    </span>
                  ))}
                  {dayEvents.length > 2 ? <small>+{dayEvents.length - 2}</small> : null}
                </div>
              ) : <p title="No high-impact events">No high-impact events</p>}
            </section>
          );
        })}
      </div>
    </div>
  );
}

const MarketEventsQuickReference = ({ now = systemNow }) => {
  const [todayKey, setTodayKey] = useState(() => (
    marketEventEtDateKey(now()) || marketEventEtDateKey(new Date())
  ));
  const [view, setView] = useState('agenda');
  const resource = useMarketEvents();

  useEffect(() => {
    const interval = setInterval(() => {
      const nextToday = marketEventEtDateKey(now());
      if (nextToday) setTodayKey(nextToday);
    }, TODAY_REFRESH_MS);
    return () => clearInterval(interval);
  }, [now]);

  const state = useMemo(() => {
    if (resource.initialLoading || ['idle', 'loading'].includes(resource.availability)) {
      return { status: 'loading', data: null, reason: null };
    }
    const currentTime = new Date(now()).getTime();
    if (resource.availability !== 'live' || !isCurrentVerifiedSnapshot(resource.data, currentTime)) {
      return {
        status: 'unavailable',
        data: null,
        reason: resource.error?.message || 'A current verified calendar is unavailable.',
      };
    }
    return { status: 'verified', data: resource.data, reason: null };
  }, [now, resource.availability, resource.data, resource.error, resource.initialLoading]);

  return (
    <section className="usd-card-section usd-card-section--market-events market-events-quick-reference" aria-label="Market events quick reference">
      <header className="market-events-quick-reference__header">
        <h3 title="Verified high-impact macro events">Market Events</h3>
        <a
          href={MARKET_EVENTS_SOURCE_URL}
          target="_blank"
          rel="noreferrer"
          title="Forex Factory calendar source"
        >
          FF
        </a>
        <span title="All event times shown in Eastern Time">ET</span>
        <nav aria-label="Market events view">
          <button type="button" aria-pressed={view === 'agenda'} onClick={() => setView('agenda')}>3 Day</button>
          <button type="button" aria-pressed={view === 'week'} onClick={() => setView('week')}>Week</button>
        </nav>
      </header>
      <div className="market-events-quick-reference__body">
        {state.status !== 'verified' ? (
          <EventsState
            status={state.status}
            reason={state.reason}
            onRetry={resource.refresh}
          />
        ) : view === 'agenda' ? (
          <ThreeDayAgenda
            events={state.data.events}
            todayKey={todayKey}
            coverage={state.data.coverage}
          />
        ) : (
          <WeekCalendar
            events={state.data.events}
            todayKey={todayKey}
            coverage={state.data.coverage}
          />
        )}
      </div>
    </section>
  );
};

export { coverageLabel, dayHeading };
export default MarketEventsQuickReference;
