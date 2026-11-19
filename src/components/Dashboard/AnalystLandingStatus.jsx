import React, { useEffect, useState } from 'react';
import { useGlobalQuads } from '../../hooks/useGlobalQuads';
import { usePublishedQuadReadings } from '../../hooks/usePublishedQuadReadings';
import { previewQuarters } from '../../utils/globalQuadsPeriods';
import { currentPortfolioQuadReadings, loadPortfolioQuadReadings, quadReadingDate } from '../../utils/portfolioQuadReadings';
import { seasonGame } from '../../utils/portfolioReviewGreeting';

const backend = () => process.env.REACT_APP_BACKEND_URL || 'http://localhost:3001';
const BASELINE_TTL_MS = 5 * 60_000;

// The landing remounts each time a chat closes; share one read per TTL.
const cache = {};
const cached = (key, ttl, load) => {
  const entry = cache[key];
  if (entry && Date.now() - entry.at < ttl) return entry.promise;
  const promise = load().catch(error => { delete cache[key]; throw error; });
  cache[key] = { at: Date.now(), promise };
  return promise;
};
const getJson = async path => {
  const response = await fetch(`${backend()}${path}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`${path} unavailable`);
  return response.json();
};
const loadBaseline = () => cached('baseline', BASELINE_TTL_MS, () => getJson('/api/analyst/automation/portfolio-close/baseline'));

const easternClock = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const clockLabel = now => {
  const parts = Object.fromEntries(easternClock.formatToParts(now).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} · ${parts.hour}:${parts.minute} ET`;
};
// Why the post-close holdings capture did not verify, in plain words.
const CLOSE_PROBLEMS = {
  review_failed: 'The 4:05pm ET holdings capture ran but could not verify holdings (usually IB Gateway was not responding).',
  review_start_failed: 'The 4:05pm ET holdings capture could not start.',
  not_started: 'The 4:05pm ET holdings capture never started.',
  current_holdings_unavailable: 'Live holdings were unavailable at the 4:05pm ET capture.',
  historical_holdings_only: 'Only saved, not live, holdings were available at the 4:05pm ET capture.',
  capture_start_unverified: 'The 4:05pm ET holdings capture could not be matched to that close.',
};
// Named by the broker error when the run carries one: an unresponsive Gateway is the usual cause.
const GATEWAY_ERRORS = {
  IBKR_GATEWAY_API_UNRESPONSIVE: 'IB Gateway was not responding',
  IBKR_GATEWAY_NOT_AUTHENTICATED: 'IB Gateway was not signed in',
  IBKR_SERVICE_UNAVAILABLE: 'the IBKR service was down',
};
export const closeProblem = close => {
  if (!close?.reason) return undefined;
  const gateway = GATEWAY_ERRORS[close.errorCode];
  if (close.reason === 'review_failed' && gateway) {
    return `Live holdings were never read: ${gateway} at every try from the 4:05pm ET capture until the 4:00am ET pre-market open.`;
  }
  return CLOSE_PROBLEMS[close.reason] || `The 4:05pm ET holdings capture did not verify (${close.reason}).`;
};
// Holdings cannot change before the next pre-market open, so a later read is that close's holdings.
const closeVerifiedNote = close => {
  const read = close.capturedAt ? clockLabel(new Date(close.capturedAt)) : null;
  return read ? `Live IBKR holdings read ${read}; positions are unchanged from the ${close.sessionDate} close until the next pre-market open.` : 'Live IBKR holdings verified.';
};
const sessionLabel = date => (/^\d{4}-(\d{2})-(\d{2})$/.exec(date || '') || []).slice(1).join('/');

// Current-quarter quad for one row of the published Global Quads table.
const tableQuad = (snapshot, groupId, country, now) => {
  const group = snapshot?.data?.groups?.[groupId];
  const current = previewQuarters(group, now).find(column => column.period === 'current');
  const quad = group?.rows?.find(row => row.country === country)?.values?.[current?.id]?.quad;
  return Number.isInteger(quad) && quad >= 1 && quad <= 4 ? quad : null;
};
export const usQuad = (snapshot, now = new Date()) => tableQuad(snapshot, 'g20', 'United States', now);

// A dated Hedgeye reading for the current period wins; otherwise the published
// Global Quads table supplies the current quarter. Monthly has no table fallback.
export function landingQuads(snapshot, readings, now = new Date()) {
  const current = currentPortfolioQuadReadings(readings, quadReadingDate(now));
  const fromReading = reading => reading && { quad: reading.quad, title: `${reading.sourceLabel || 'Manual Hedgeye entry'} · as of ${reading.asOf}` };
  const fromTable = (quad, label) => quad && { quad, title: `Global Quads table · ${label} · current quarter` };
  return {
    global: fromReading(current.global) || fromTable(tableQuad(snapshot, 'global', 'MODE/MEAN', now), 'Global MODE/MEAN'),
    quarterly: fromReading(current.usQuarterly) || fromTable(usQuad(snapshot, now), 'United States'),
    monthly: fromReading(current.usMonthly),
  };
}

function useLoaded(load) {
  const [value, setValue] = useState({ state: 'loading' });
  useEffect(() => {
    let live = true;
    load().then(data => live && setValue({ state: 'ready', data }), () => live && setValue({ state: 'failed' }));
    return () => { live = false; };
  }, [load]);
  return value;
}

const Item = ({ label, children, tone, title }) => <span className="analyst-landing-stat" title={title}>
  {label} <span className={tone ? `is-${tone}` : undefined}>{children}</span>
</span>;

// "Monday, November 2nd, '26": the market day the line describes, in New York time.
export function landingDate(date) {
  const day = new Date(`${date}T12:00:00Z`);
  const n = day.getUTCDate();
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th';
  const part = options => new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' }).format(day);
  return `${part({ weekday: 'long' })}, ${part({ month: 'long' })} ${n}${suffix}, '${date.slice(2, 4)}`;
}

const QuadItem = ({ label, value, missing }) => <Item label={label} title={value?.title || missing} tone={value && `q${value.quad}`}>{value ? `Q${value.quad}` : '—'}</Item>;

// "69 (24/45)": the count, then longs in green and shorts in red (user-specified 2026-11-18).
const Sides = ({ sides }) => (sides ? <> (<span className="is-long">{sides.long}</span>/<span className="is-short">{sides.short}</span>)</> : null);

export default function AnalystLandingStatus({ holdingsCount, holdingsSides }) {
  const snapshot = useGlobalQuads();
  const baseline = useLoaded(loadBaseline);
  const published = usePublishedQuadReadings();
  const quads = landingQuads(snapshot.data, loadPortfolioQuadReadings(published));
  const today = quadReadingDate();
  const game = seasonGame(today);
  const close = baseline.data;
  const verified = baseline.state === 'ready' && close?.status === 'ready';
  return <div className="analyst-landing-status" role="group" aria-label="Portfolio status">
    <span className="analyst-landing-stat analyst-landing-date">{landingDate(today)}</span>
    <Item label="SEASON">{game.year}</Item>
    <Item label="GAME">{game.game}/{game.totalGames}</Item>
    <Item label="HOLDINGS" title={holdingsSides ? `${holdingsSides.long} long, ${holdingsSides.short} short` : undefined}>
      {Number.isInteger(holdingsCount) ? <>{holdingsCount}<Sides sides={holdingsSides} /></> : '—'}</Item>
    <Item label="CLOSE" tone={verified ? 'positive' : close?.sessionDate ? 'warning' : undefined}
      title={verified ? closeVerifiedNote(close) : closeProblem(close)}>
      {close?.sessionDate ? `${sessionLabel(close.sessionDate)} ${verified ? 'VERIFIED' : 'UNVERIFIED'}` : '—'}
    </Item>
    <QuadItem label="GLOBAL QUAD" value={quads.global} missing="No current global reading" />
    <QuadItem label="QUARTERLY QUAD" value={quads.quarterly} missing="No current U.S. quarterly reading" />
    <QuadItem label="MONTHLY QUAD" value={quads.monthly} missing="No U.S. monthly reading for this month" />
  </div>;
}
