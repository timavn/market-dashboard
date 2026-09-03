import fetchMarketEvents from '../services/api/marketEventsService';
import { useDashboardResource } from './useDashboardResource';

export const MARKET_EVENTS_POLL_MS = 5 * 60 * 1000;
export const MARKET_EVENTS_MAX_AGE_MS = 70 * 60 * 1000;
export const MARKET_EVENTS_SOURCE_MAX_AGE_AT_FETCH_MS = 2 * 60 * 60 * 1000;
export const MARKET_EVENTS_FUTURE_TOLERANCE_MS = 2 * 60 * 1000;
export const MARKET_EVENTS_PROVIDER = 'Forex Factory';
export const MARKET_EVENTS_PROVIDER_MODE = 'weekly-export';
export const MARKET_EVENTS_TIME_ZONE = 'America/New_York';
export const MARKET_EVENTS_SOURCE_URL = 'https://www.forexfactory.com/calendar/rss';

const DATE_KEY_PATTERN = /^20\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;
const COUNTRY_CODES = new Set(['US', 'EU', 'DE', 'FR', 'IT', 'UK', 'JP', 'CA']);
const CURRENCIES = new Set(['USD', 'EUR', 'GBP', 'JPY', 'CAD']);

function invalidSnapshot(message, code = 'MARKET_EVENTS_SNAPSHOT_INVALID') {
  return Object.assign(new Error(message), { code, liveInvalidation: true });
}

function validDateKey(value) {
  if (!DATE_KEY_PATTERN.test(String(value || ''))) return false;
  const parsed = new Date(`${value}T12:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function addMarketDateKeyDays(dateKey, days) {
  const date = new Date(`${dateKey}T12:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function dateKeyFromParts(parts) {
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function marketEventEtDateKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return dateKeyFromParts(new Intl.DateTimeFormat('en-US', {
    timeZone: MARKET_EVENTS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date));
}

export function currentMarketEventWeek(value = Date.now()) {
  const today = marketEventEtDateKey(value);
  if (!today) return null;
  const weekday = new Date(`${today}T12:00:00.000Z`).getUTCDay();
  const from = addMarketDateKeyDays(today, -weekday);
  return { from, to: addMarketDateKeyDays(from, 6) };
}

export function isMarketDateCovered(dateKey, coverage) {
  return validDateKey(dateKey)
    && validDateKey(coverage?.from)
    && validDateKey(coverage?.to)
    && dateKey >= coverage.from
    && dateKey <= coverage.to;
}

function validateEvent(event, coverage, ids) {
  const eventDateKey = marketEventEtDateKey(event?.startAt);
  if (
    !event
    || typeof event.id !== 'string'
    || !event.id.startsWith('ff-')
    || ids.has(event.id)
    || typeof event.name !== 'string'
    || !event.name.trim()
    || !COUNTRY_CODES.has(event.countryCode)
    || !CURRENCIES.has(event.currency)
    || event.provider !== MARKET_EVENTS_PROVIDER
    || event.verification !== 'provider-export'
    || Number(event.importance) !== 3
    || event.actual !== null
    || event.unit !== null
    || !eventDateKey
    || !isMarketDateCovered(eventDateKey, coverage)
  ) {
    throw invalidSnapshot('The market-event feed contained an unverified event row.');
  }
  ids.add(event.id);
  return event;
}

export function validateMarketEventsSnapshot(snapshot, { currentTime = Date.now() } = {}) {
  if (
    !snapshot
    || snapshot.status !== 'verified'
    || snapshot.provider !== MARKET_EVENTS_PROVIDER
    || snapshot.providerMode !== MARKET_EVENTS_PROVIDER_MODE
    || snapshot.timezone !== MARKET_EVENTS_TIME_ZONE
    || snapshot.sourceUrl !== MARKET_EVENTS_SOURCE_URL
    || !Array.isArray(snapshot.events)
  ) {
    throw invalidSnapshot(
      snapshot?.reason || 'A verified Forex Factory weekly calendar was not returned.',
      snapshot?.code || 'MARKET_EVENTS_SNAPSHOT_UNAVAILABLE',
    );
  }

  const fetchedAtMs = Date.parse(snapshot.fetchedAt || '');
  const sourceUpdatedAtMs = Date.parse(snapshot.sourceUpdatedAt || '');
  if (!Number.isFinite(fetchedAtMs) || !Number.isFinite(sourceUpdatedAtMs)) {
    throw invalidSnapshot('The market-event feed is missing authoritative timestamps.');
  }
  const sourceAgeAtFetch = fetchedAtMs - sourceUpdatedAtMs;
  if (
    sourceAgeAtFetch < -MARKET_EVENTS_FUTURE_TOLERANCE_MS
    || sourceAgeAtFetch > MARKET_EVENTS_SOURCE_MAX_AGE_AT_FETCH_MS
  ) {
    throw invalidSnapshot('The market-event source timestamp was stale when fetched.', 'MARKET_EVENTS_SOURCE_STALE');
  }

  const coverage = snapshot.coverage;
  const expectedFetchCoverage = currentMarketEventWeek(fetchedAtMs);
  const expectedCurrentCoverage = currentMarketEventWeek(currentTime);
  if (
    !validDateKey(coverage?.from)
    || !validDateKey(coverage?.to)
    || addMarketDateKeyDays(coverage.from, 6) !== coverage.to
    || coverage.from !== expectedFetchCoverage?.from
    || coverage.to !== expectedFetchCoverage?.to
    || coverage.from !== expectedCurrentCoverage?.from
    || coverage.to !== expectedCurrentCoverage?.to
  ) {
    throw invalidSnapshot('The market-event feed has invalid current-week coverage.');
  }

  const ids = new Set();
  snapshot.events.forEach((event) => validateEvent(event, coverage, ids));
  return {
    ...snapshot,
    events: [...snapshot.events].sort((left, right) => (
      String(left.startAt).localeCompare(String(right.startAt)) || left.id.localeCompare(right.id)
    )),
  };
}

const observedAt = (snapshot) => snapshot.fetchedAt;
const invalidateEveryFailure = () => true;

export function useMarketEvents({ active = true } = {}) {
  return useDashboardResource('market-events', {}, {
    fetcher: fetchMarketEvents,
    validate: validateMarketEventsSnapshot,
    getObservedAt: observedAt,
    maxAgeMs: MARKET_EVENTS_MAX_AGE_MS,
    futureToleranceMs: MARKET_EVENTS_FUTURE_TOLERANCE_MS,
    pollIntervalMs: MARKET_EVENTS_POLL_MS,
    active,
    pollWhenDocumentHidden: false,
    refreshOnActivate: false,
    isExplicitInvalidation: invalidateEveryFailure,
    expiredCode: 'MARKET_EVENTS_SNAPSHOT_EXPIRED',
    expiredMessage: 'The verified market-event snapshot expired.',
  });
}

export default useMarketEvents;
