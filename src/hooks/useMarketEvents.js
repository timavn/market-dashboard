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
export const MARKET_EVENTS_NEXT_PROVIDER = 'Trading Economics';
export const MARKET_EVENTS_NEXT_SOURCE_URL = 'https://tradingeconomics.com/calendar';

const PROVIDER_CONTRACTS = {
  [MARKET_EVENTS_PROVIDER]: {
    mode: MARKET_EVENTS_PROVIDER_MODE, sourceUrl: MARKET_EVENTS_SOURCE_URL,
    idPattern: /^ff-.+$/, verification: 'provider-export', timestamp: 'sourceUpdatedAt',
  },
  [MARKET_EVENTS_NEXT_PROVIDER]: {
    mode: 'calendar-page', sourceUrl: MARKET_EVENTS_NEXT_SOURCE_URL,
    idPattern: /^te-\d+$/, verification: 'provider-calendar', timestamp: 'sourceObservedAt',
  },
};

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

export function currentMarketEventWeek(value = Date.now(), week = 'this') {
  const today = marketEventEtDateKey(value);
  if (!today) return null;
  const weekday = new Date(`${today}T12:00:00.000Z`).getUTCDay();
  const from = addMarketDateKeyDays(today, -weekday + (week === 'next' ? 7 : 0));
  return { from, to: addMarketDateKeyDays(from, 6) };
}

export function isMarketDateCovered(dateKey, coverage) {
  return validDateKey(dateKey)
    && validDateKey(coverage?.from)
    && validDateKey(coverage?.to)
    && dateKey >= coverage.from
    && dateKey <= coverage.to;
}

function hasUnverifiedEvidence(value) {
  if (!value || typeof value !== 'object') return false;
  const metadata = value.meta || {};
  return [value, metadata].some((evidence) => (
    ['stale', 'offline', 'disconnected', 'cacheOnly', 'fromCache', 'seeded', 'seed', 'mock', 'isMock', 'synthetic', 'inferred']
      .some((flag) => evidence[flag] === true)
    || evidence.connected === false
    || /(?:^|[_\s-])(cache|cached|mock|seed|seeded|synthetic|fallback|inferred|stale|expired|offline|disconnected|unavailable)(?:$|[_\s-])/i
      .test([evidence.source, evidence.status, evidence.availability, evidence.freshness].filter(Boolean).join(' '))
  )) || value._cache?.stale === true || value._cache?.hit === true
    || ['cache', 'cached', 'hit', 'stale', 'cache-only'].includes(
      String(value._cache?.status || metadata.cacheStatus || '').toLowerCase(),
    );
}

function validCalendarRowSource(value) {
  try {
    const url = new URL(value);
    return url.origin === 'https://tradingeconomics.com'
      && !url.username && !url.password
      && /^\/[a-z0-9-]+\/[a-z0-9-/]+$/i.test(url.pathname);
  } catch {
    return false;
  }
}

// Released figures are only accepted from the Trading Economics row that
// published them, and never before the release time.
function validActual(event, currentTime) {
  if (event.actual === null) return true;
  const startMs = Date.parse(event.startAt);
  const observedMs = Date.parse(event.actualObservedAt || '');
  return typeof event.actual === 'string'
    && event.actual.length <= 80
    && /\d/.test(event.actual)
    && event.actualSource === MARKET_EVENTS_NEXT_PROVIDER
    && validCalendarRowSource(event.actualSourceUrl)
    && Number.isFinite(observedMs)
    && observedMs >= startMs - MARKET_EVENTS_FUTURE_TOLERANCE_MS
    && startMs <= Number(currentTime) + MARKET_EVENTS_FUTURE_TOLERANCE_MS;
}

// A market closure or early close: from the exchange calendars (US) or the
// provider's holiday rows (other markets). It carries no figures.
export const isMarketClosure = event => event?.kind === 'closure';
const CLOSURE_SOURCES = {
  'exchange-calendar': { provider: 'Exchange calendar', idPattern: /^mc-[a-f0-9]{24}$/ },
  'provider-export': { provider: MARKET_EVENTS_PROVIDER, idPattern: /^ff-[a-f0-9]{24}$/ },
};

function validClosure(event, snapshot, ids) {
  const source = CLOSURE_SOURCES[event.verification];
  const eventDateKey = marketEventEtDateKey(event.startAt);
  return Boolean(source)
    && event.provider === source.provider
    && (event.verification === 'exchange-calendar' || snapshot.provider === MARKET_EVENTS_PROVIDER)
    && typeof event.id === 'string' && source.idPattern.test(event.id) && !ids.has(event.id)
    && typeof event.name === 'string' && event.name.trim().length > 0 && event.name.length <= 160
    && COUNTRY_CODES.has(event.countryCode) && CURRENCIES.has(event.currency)
    && typeof event.allDay === 'boolean'
    && event.actual === null && event.forecast === null && event.previous === null && event.unit === null
    && Boolean(eventDateKey) && isMarketDateCovered(eventDateKey, snapshot.coverage);
}

function validateEvent(event, snapshot, contract, ids, currentTime) {
  if (isMarketClosure(event)) {
    if (!validClosure(event, snapshot, ids)) throw invalidSnapshot('The market-event feed contained an unverified closure row.');
    ids.add(event.id);
    return event;
  }
  const eventDateKey = marketEventEtDateKey(event?.startAt);
  if (
    !event
    || hasUnverifiedEvidence(event)
    || typeof event.id !== 'string'
    || !contract.idPattern.test(event.id)
    || ids.has(event.id)
    || typeof event.name !== 'string'
    || !event.name.trim()
    || !COUNTRY_CODES.has(event.countryCode)
    || !CURRENCIES.has(event.currency)
    || event.provider !== snapshot.provider
    || event.verification !== contract.verification
    || Number(event.importance) !== 3
    || !validActual(event, currentTime)
    || event.unit !== null
    || !eventDateKey
    || !isMarketDateCovered(eventDateKey, snapshot.coverage)
    || (snapshot.provider === MARKET_EVENTS_NEXT_PROVIDER && (
      event.lastUpdatedAt !== null
      || event.observedAt !== snapshot.sourceObservedAt
      || !validCalendarRowSource(event.sourceUrl)
    ))
  ) {
    throw invalidSnapshot('The market-event feed contained an unverified event row.');
  }
  ids.add(event.id);
  return event;
}

export function validateMarketEventsSnapshot(snapshot, { currentTime = Date.now(), week = 'this' } = {}) {
  const contract = PROVIDER_CONTRACTS[snapshot?.provider];
  if (
    !snapshot
    || !contract
    || hasUnverifiedEvidence(snapshot)
    || snapshot.status !== 'verified'
    || (snapshot.provider === MARKET_EVENTS_NEXT_PROVIDER && week !== 'next')
    || snapshot.providerMode !== contract.mode
    || snapshot.timezone !== MARKET_EVENTS_TIME_ZONE
    || snapshot.sourceUrl !== contract.sourceUrl
    || (snapshot.provider === MARKET_EVENTS_NEXT_PROVIDER && snapshot.sourceUpdatedAt !== null)
    || !Array.isArray(snapshot.events)
  ) {
    throw invalidSnapshot(
      snapshot?.reason || 'A verified selected-week calendar was not returned.',
      snapshot?.code || 'MARKET_EVENTS_SNAPSHOT_UNAVAILABLE',
    );
  }

  const fetchedAtMs = Date.parse(snapshot.fetchedAt || '');
  const sourceTimestampMs = Date.parse(snapshot[contract.timestamp] || '');
  if (!Number.isFinite(fetchedAtMs) || !Number.isFinite(sourceTimestampMs)) {
    throw invalidSnapshot('The market-event feed is missing authoritative timestamps.');
  }
  const age = Number(currentTime) - fetchedAtMs;
  if (!Number.isFinite(age) || age < -MARKET_EVENTS_FUTURE_TOLERANCE_MS || age > MARKET_EVENTS_MAX_AGE_MS) {
    throw invalidSnapshot('The market-event snapshot is outside its freshness window.', 'LIVE_RESOURCE_STALE');
  }
  const sourceAgeAtFetch = fetchedAtMs - sourceTimestampMs;
  if (
    sourceAgeAtFetch < -MARKET_EVENTS_FUTURE_TOLERANCE_MS
    || sourceAgeAtFetch > MARKET_EVENTS_SOURCE_MAX_AGE_AT_FETCH_MS
    || sourceTimestampMs - Number(currentTime) > MARKET_EVENTS_FUTURE_TOLERANCE_MS
  ) {
    throw invalidSnapshot('The market-event source timestamp was stale when fetched.', 'MARKET_EVENTS_SOURCE_STALE');
  }

  const coverage = snapshot.coverage;
  const expectedFetchCoverage = currentMarketEventWeek(fetchedAtMs, week);
  const expectedCurrentCoverage = currentMarketEventWeek(currentTime, week);
  if (
    !validDateKey(coverage?.from)
    || !validDateKey(coverage?.to)
    || addMarketDateKeyDays(coverage.from, 6) !== coverage.to
    || coverage.from !== expectedFetchCoverage?.from
    || coverage.to !== expectedFetchCoverage?.to
    || coverage.from !== expectedCurrentCoverage?.from
    || coverage.to !== expectedCurrentCoverage?.to
  ) {
    throw invalidSnapshot('The market-event feed has invalid selected-week coverage.');
  }

  const ids = new Set();
  snapshot.events.forEach((event) => validateEvent(event, snapshot, contract, ids, currentTime));
  return {
    ...snapshot,
    events: [...snapshot.events].sort((left, right) => (
      String(left.startAt).localeCompare(String(right.startAt)) || left.id.localeCompare(right.id)
    )),
  };
}

const observedAt = (snapshot) => snapshot.fetchedAt;
const invalidateEveryFailure = () => true;
const fetchNextWeekMarketEvents = () => fetchMarketEvents({ week: 'next' });
const validateNextWeekMarketEvents = (snapshot) => validateMarketEventsSnapshot(snapshot, { week: 'next' });

export function useMarketEvents({ active = true, week = 'this' } = {}) {
  const selectedWeek = week === 'next' ? 'next' : 'this';
  return useDashboardResource('market-events', { week: selectedWeek }, {
    fetcher: selectedWeek === 'next' ? fetchNextWeekMarketEvents : fetchMarketEvents,
    validate: selectedWeek === 'next' ? validateNextWeekMarketEvents : validateMarketEventsSnapshot,
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
