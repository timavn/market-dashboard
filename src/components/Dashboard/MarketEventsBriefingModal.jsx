import React, { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import usePageScrollLock from '../../hooks/usePageScrollLock';
import {
  isMarketDateCovered, marketEventEtDateKey, MARKET_EVENTS_SOURCE_URL, MARKET_EVENTS_PROVIDER,
  MARKET_EVENTS_NEXT_PROVIDER,
} from '../../hooks/useMarketEvents';
import { getMarketEventBriefing } from '../../constants/marketEventBriefings';
import { marketEventDateTime } from '../../utils/marketEventTime';
import '../Process/ProcessWiki.css';
import './MarketEventsBriefingModal.css';
import LoadingIndicator from '../common/LoadingIndicator';

const valueText = (value) => value == null || String(value).trim() === '' ? 'Unavailable' : String(value);

function EventBriefing({ event }) {
  const info = getMarketEventBriefing(event);
  const sourceLabel = event.provider === MARKET_EVENTS_NEXT_PROVIDER ? 'TE' : 'FF';
  return (
    <article className="market-event-briefing" aria-label={`${event.countryCode} ${event.name}`}>
      <header>
        <span className="market-event-briefing__country">{event.countryCode} · {event.currency}</span>
        <h3>{event.name}</h3>
        <time dateTime={event.startAt}>{marketEventDateTime(event.startAt)}</time>
      </header>
      <dl className="market-event-briefing__facts">
        <div><dt>Released by / speaker’s institution</dt><dd>{info.publisher}</dd></div>
        <div><dt>Frequency / release</dt><dd>{info.cadence}</dd></div>
        {event.actual && <div><dt>Actual · TE</dt><dd>
          <a href={event.actualSourceUrl} target="_blank" rel="noreferrer">{event.actual} ↗</a>
        </dd></div>}
        <div><dt>Consensus · {sourceLabel}</dt><dd>{valueText(event.forecast)}</dd></div>
        <div><dt>Prior · {sourceLabel}</dt><dd>{valueText(event.previous)}</dd></div>
      </dl>
      <p className="market-event-briefing__summary">{info.summary}</p>
      <div className="market-event-briefing__context">
        <section><h4>What to watch</h4><p>{info.watch}</p></section>
        <section><h4>Macro relevance</h4><p>{info.markets}</p></section>
      </div>
      {info.sourceUrl && <a href={info.sourceUrl} target="_blank" rel="noreferrer">{info.sourceLabel} ↗</a>}
    </article>
  );
}

export default function MarketEventsBriefingModal({
  day, days, state, onDayChange, onClose, onRetry,
  provider = MARKET_EVENTS_PROVIDER, sourceUrl = MARKET_EVENTS_SOURCE_URL,
}) {
  const titleId = useId();
  const dialogRef = useRef(null);
  const closeRef = useRef(null);
  const bodyRef = useRef(null);
  usePageScrollLock(true);

  useEffect(() => {
    const launcher = document.activeElement;
    closeRef.current?.focus();
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
      if (event.key !== 'Tab') return;
      const items = Array.from(dialogRef.current?.querySelectorAll('button:not([disabled]), a[href]') || []);
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialogRef.current?.contains(document.activeElement))) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialogRef.current?.contains(document.activeElement))) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      if (launcher?.isConnected && !launcher.closest('[inert], [hidden]')) launcher.focus?.();
    };
  }, [onClose]);

  useEffect(() => { if (bodyRef.current) bodyRef.current.scrollTop = 0; }, [day.key]);

  const verified = state.status === 'verified';
  const sourceProvider = state.data?.provider || provider;
  const covered = verified && isMarketDateCovered(day.key, state.data.coverage);
  const events = covered ? state.data.events.filter((event) => marketEventEtDateKey(event.startAt) === day.key) : [];
  const heading = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  }).format(new Date(`${day.key}T12:00:00Z`));

  return createPortal(
    <div className="process-overlay-host market-events-briefing-host">
      <div className="process-overlay-backdrop" aria-hidden="true" onClick={onClose} />
      <section className="process-overlay-dialog market-events-briefing-modal" ref={dialogRef}
        role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="market-events-briefing-modal__header">
          <div><span>Market events · PT (ET)</span><h2 id={titleId}>{day.label} · {heading}</h2></div>
          <button ref={closeRef} type="button" onClick={onClose} aria-label="Close market events briefing">×</button>
        </header>
        <nav className="market-events-briefing-modal__days" aria-label="Briefing day">
          {days.map((item) => <button key={item.key} type="button" aria-pressed={day.key === item.key}
            onClick={() => onDayChange(item)}>{item.label}</button>)}
        </nav>
        <div className="market-events-briefing-modal__body" ref={bodyRef}>
          {!verified ? (
            <div className="market-events-briefing-modal__empty" role="status">
              {state.status === 'loading' ? <LoadingIndicator label="Loading verified calendar…" size="sm" announce={false} /> : <h3>Calendar unavailable</h3>}
              <p>{state.reason}</p>
              {state.status !== 'loading' && <button type="button" onClick={onRetry}>Retry</button>}
            </div>
          ) : !covered ? (
            <div className="market-events-briefing-modal__empty" role="status"><h3>Not covered yet</h3>
              <p>This date is outside the verified calendar coverage. Events will appear when the provider covers it.</p></div>
          ) : <>
            <div className="market-events-briefing-modal__note">
              <strong>{events.length} high-impact event{events.length === 1 ? '' : 's'}</strong>
              <p>Schedule, consensus and prior: {sourceProvider}. Actual results are not supplied by this feed, even after the scheduled time. Context below is reference analysis, not a report of the outcome.</p>
            </div>
            {events.length ? events.map((event) => <EventBriefing key={event.id} event={event} />)
              : <div className="market-events-briefing-modal__empty"><h3>No high-impact events</h3><p>No qualifying events are listed for this date in the verified calendar.</p></div>}
          </>}
        </div>
        <footer className="market-events-briefing-modal__footer">
          <a href={state.data?.sourceUrl || sourceUrl} target="_blank" rel="noreferrer">{sourceProvider} calendar ↗</a>
          {verified && <span>Source {state.data.sourceUpdatedAt ? 'updated' : 'observed'} {marketEventDateTime(state.data.sourceUpdatedAt || state.data.sourceObservedAt)}</span>}
        </footer>
      </section>
    </div>, document.body,
  );
}
