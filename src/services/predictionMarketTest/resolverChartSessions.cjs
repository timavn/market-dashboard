const { formatInTimeZone, zonedTimeToUtc } = require('date-fns-tz');

const DAY_MS = 24 * 60 * 60_000;

const PROFILES = Object.freeze({
  cme_futures: Object.freeze({
    id: 'cme_futures',
    label: 'CME/COMEX resolver session',
    timeZone: 'America/New_York',
    kind: 'previous_day',
    openMinutes: 18 * 60,
    defaultCutoffMinutes: 16 * 60,
    source: 'official_exchange_session',
  }),
  ice_wti: Object.freeze({
    id: 'ice_wti',
    label: 'ICE WTI resolver session',
    timeZone: 'America/New_York',
    kind: 'previous_day',
    openMinutes: 20 * 60,
    mondayOpenMinutes: 18 * 60,
    defaultCutoffMinutes: (14 * 60) + 30,
    source: 'official_exchange_session',
  }),
  pyth_daily: Object.freeze({
    id: 'pyth_daily',
    label: 'Pyth daily observation window',
    timeZone: 'America/New_York',
    kind: 'previous_day',
    openMinutes: 17 * 60,
    defaultCutoffMinutes: 17 * 60,
    source: 'published_resolver_observation',
  }),
  us_cash: Object.freeze({
    id: 'us_cash',
    label: 'US cash-index resolver session',
    timeZone: 'America/New_York',
    kind: 'same_day',
    openMinutes: (9 * 60) + 30,
    defaultCutoffMinutes: 16 * 60,
    source: 'official_cash_session',
  }),
  continuous_calendar: Object.freeze({
    id: 'continuous_calendar',
    label: 'Continuous-market calendar session',
    timeZone: 'America/New_York',
    kind: 'calendar',
    openMinutes: 0,
    defaultCutoffMinutes: (24 * 60) - 1,
    source: 'continuous_market_calendar',
  }),
  event_window: Object.freeze({
    id: 'event_window',
    label: 'Selected contract observation window',
    timeZone: 'America/New_York',
    kind: 'event',
    source: 'published_contract_window',
  }),
});

function validDateKey(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function addDateKey(dateKey, days) {
  if (!validDateKey(dateKey)) return null;
  const timestamp = Date.parse(`${dateKey}T12:00:00.000Z`);
  return Number.isFinite(timestamp)
    ? new Date(timestamp + (Number(days) * DAY_MS)).toISOString().slice(0, 10)
    : null;
}

function weekdayForDateKey(dateKey) {
  if (!validDateKey(dateKey)) return null;
  const timestamp = Date.parse(`${dateKey}T12:00:00.000Z`);
  return Number.isFinite(timestamp) ? new Date(timestamp).getUTCDay() : null;
}

function isoTimestamp(value) {
  const timestamp = Date.parse(String(value || ''));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function eventFromSelection(selected) {
  return selected?.contracts?.event
    || selected?.book?.event
    || selected?.catalog?.event
    || selected?.event
    || null;
}

function venueFromSelection(selected) {
  const event = eventFromSelection(selected);
  const value = selected?.id || selected?.venueId || event?.venueId || event?.venue;
  if (value) return String(value).trim().toLowerCase();
  if (event?.event_ticker || String(event?.ticker || '').startsWith('KX')) return 'kalshi';
  if (event?.productCode || selected?.resolverIdentity) return 'forecastex';
  return null;
}

function observationAtFromSelection(selected) {
  const event = eventFromSelection(selected);
  return isoTimestamp(
    selected?.settlementBasis?.observationAt
      || event?.observationTime
      || event?.closeTime
      || event?.strike_date
      || selected?.observationTime
      || selected?.closeTime
      || selected?.closeAt
      || selected?.expiresAt,
  );
}

function contractOpenAtFromSelection(selected) {
  const event = eventFromSelection(selected);
  const marketRows = selected?.markets
    || selected?.catalog?.lines
    || selected?.contracts?.lines
    || [];
  const earliestMarketOpen = marketRows
    .map((market) => isoTimestamp(market?.open_time || market?.openTime || market?.openAt))
    .filter(Boolean)
    .sort()[0] || null;
  return isoTimestamp(
    event?.openTime
      || event?.open_time
      || selected?.openTime
      || selected?.openAt
      || earliestMarketOpen,
  );
}

function profileFor({ marketId, selected, instrument } = {}) {
  const normalizedMarketId = String(marketId || '').trim().toLowerCase();
  const venue = venueFromSelection(selected);
  if (normalizedMarketId === 'bitcoin') return PROFILES.event_window;
  if (venue === 'forecastex' && ['sp500', 'nasdaq100', 'gold', 'silver', 'wti'].includes(normalizedMarketId)) {
    const cutoffByMarket = {
      gold: (13 * 60) + 30,
      silver: (13 * 60) + 25,
      wti: (14 * 60) + 30,
    };
    return cutoffByMarket[normalizedMarketId] == null
      ? PROFILES.cme_futures
      : { ...PROFILES.cme_futures, defaultCutoffMinutes: cutoffByMarket[normalizedMarketId] };
  }
  if (venue === 'kalshi') {
    if (normalizedMarketId === 'wti') return PROFILES.ice_wti;
    if (['gold', 'silver', 'brent'].includes(normalizedMarketId)) return PROFILES.pyth_daily;
    if (['sp500', 'nasdaq100'].includes(normalizedMarketId)) return PROFILES.us_cash;
  }
  if (String(instrument?.secType || '').toUpperCase() === 'IND') return PROFILES.us_cash;
  if (String(instrument?.secType || '').toUpperCase() === 'FUT') {
    if (normalizedMarketId === 'wti') return PROFILES.ice_wti;
    if (normalizedMarketId === 'brent') return PROFILES.pyth_daily;
    if (normalizedMarketId === 'gold') {
      return { ...PROFILES.cme_futures, defaultCutoffMinutes: (13 * 60) + 30 };
    }
    if (normalizedMarketId === 'silver') {
      return { ...PROFILES.cme_futures, defaultCutoffMinutes: (13 * 60) + 25 };
    }
    return PROFILES.cme_futures;
  }
  return normalizedMarketId === 'bitcoin' ? PROFILES.continuous_calendar : null;
}

function localParts(timestamp, timeZone) {
  if (!Number.isFinite(Number(timestamp))) return null;
  const value = Number(timestamp);
  try {
    return {
      dateKey: formatInTimeZone(value, timeZone, 'yyyy-MM-dd'),
      weekday: Number(formatInTimeZone(value, timeZone, 'i')) % 7,
      minutes: (Number(formatInTimeZone(value, timeZone, 'HH')) * 60)
        + Number(formatInTimeZone(value, timeZone, 'mm')),
    };
  } catch (_error) {
    return null;
  }
}

function zonedTimestamp(dateKey, minutes, timeZone) {
  if (!validDateKey(dateKey) || !Number.isFinite(Number(minutes))) return null;
  const totalMinutes = Number(minutes);
  const hour = Math.floor(totalMinutes / 60);
  const minute = totalMinutes % 60;
  try {
    return zonedTimeToUtc(
      `${dateKey} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`,
      timeZone,
    ).getTime();
  } catch (_error) {
    return null;
  }
}

function sessionDateForTimestamp(profile, timestamp) {
  if (!profile || profile.kind === 'event') return null;
  const parts = localParts(timestamp, profile.timeZone);
  if (!parts) return null;
  if (profile.kind === 'calendar') return parts.dateKey;
  const cutoff = Number(profile.defaultCutoffMinutes);
  if (profile.kind === 'same_day') {
    return parts.minutes >= profile.openMinutes && parts.minutes <= cutoff ? parts.dateKey : null;
  }
  if (profile.kind !== 'previous_day') return null;
  if (parts.weekday === 0 && Number.isFinite(profile.mondayOpenMinutes)
    && parts.minutes >= profile.mondayOpenMinutes) {
    return addDateKey(parts.dateKey, 1);
  }
  if (parts.minutes >= profile.openMinutes) return addDateKey(parts.dateKey, 1);
  if (parts.minutes <= cutoff) return parts.dateKey;
  return null;
}

function openMinutesForSession(profile, sessionDate) {
  return weekdayForDateKey(sessionDate) === 1 && Number.isFinite(profile?.mondayOpenMinutes)
    ? profile.mondayOpenMinutes
    : profile?.openMinutes;
}

function sessionWindowForDate(profile, sessionDate, overrides = {}) {
  if (!profile || !validDateKey(sessionDate)) return null;
  const exactObservationAt = isoTimestamp(overrides.observationAt);
  const exactObservationMs = Date.parse(exactObservationAt || '');
  const exactObservationDate = Number.isFinite(exactObservationMs)
    ? localParts(exactObservationMs, profile.timeZone)?.dateKey
    : null;
  let startMs;
  let endMs;
  if (profile.kind === 'event') {
    startMs = Date.parse(isoTimestamp(overrides.contractOpenAt) || '');
    endMs = exactObservationMs;
  } else if (profile.kind === 'calendar') {
    startMs = zonedTimestamp(sessionDate, 0, profile.timeZone);
    const nextStart = zonedTimestamp(addDateKey(sessionDate, 1), 0, profile.timeZone);
    endMs = Number.isFinite(nextStart) ? nextStart - 1 : null;
  } else {
    const startDate = profile.kind === 'previous_day' ? addDateKey(sessionDate, -1) : sessionDate;
    startMs = zonedTimestamp(startDate, openMinutesForSession(profile, sessionDate), profile.timeZone);
    endMs = exactObservationDate === sessionDate
      ? exactObservationMs
      : zonedTimestamp(sessionDate, profile.defaultCutoffMinutes, profile.timeZone);
  }
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return null;
  const contractOpenAt = isoTimestamp(overrides.contractOpenAt);
  const contractOpenMs = Date.parse(contractOpenAt || '');
  const closedIntervals = Number.isFinite(contractOpenMs) && contractOpenMs < startMs
    ? [{
        startAt: new Date(contractOpenMs).toISOString(),
        endAt: new Date(startMs).toISOString(),
        state: 'resolver_closed',
        label: 'Resolver market closed · no underlying prints',
      }]
    : [];
  const nowMs = Number(overrides.nowMs);
  const state = !Number.isFinite(nowMs)
    ? null
    : nowMs < startMs ? 'resolver_closed'
      : nowMs <= endMs ? 'resolver_open'
        : 'resolver_complete';
  return {
    profileId: profile.id,
    label: profile.label,
    sessionDate,
    timeZone: profile.timeZone,
    startAt: new Date(startMs).toISOString(),
    endAt: new Date(endMs).toISOString(),
    observationAt: new Date(endMs).toISOString(),
    contractOpenAt,
    state,
    source: profile.source,
    closedIntervals,
  };
}

function buildResolverChartSession({ marketId, selected, instrument, nowMs = Date.now() } = {}) {
  const profile = profileFor({ marketId, selected, instrument });
  if (!profile) return null;
  const observationAt = observationAtFromSelection(selected);
  const observationMs = Date.parse(observationAt || '');
  const contractOpenAt = contractOpenAtFromSelection(selected);
  let currentWindow = null;
  if (Number.isFinite(observationMs)) {
    const sessionDate = localParts(observationMs, profile.timeZone)?.dateKey || null;
    currentWindow = sessionWindowForDate(profile, sessionDate, {
      observationAt,
      contractOpenAt,
      nowMs,
    });
  }
  const activeProfile = profile.kind === 'event' && !currentWindow
    ? PROFILES.continuous_calendar
    : profile;
  return {
    profile: activeProfile,
    multiDayProfile: activeProfile.kind === 'event' ? PROFILES.continuous_calendar : activeProfile,
    currentWindow,
    marketId: String(marketId || '').toLowerCase(),
    venueId: venueFromSelection(selected),
  };
}

function dateForPoint(session, timestamp, { currentOnly = false } = {}) {
  const window = session?.currentWindow;
  if (currentOnly && window) {
    const startMs = Date.parse(window.startAt);
    const endMs = Date.parse(window.endAt);
    return Number(timestamp) >= startMs && Number(timestamp) <= endMs ? window.sessionDate : null;
  }
  return sessionDateForTimestamp(session?.profile, timestamp);
}

module.exports = {
  PROFILES,
  addDateKey,
  buildResolverChartSession,
  dateForPoint,
  eventFromSelection,
  observationAtFromSelection,
  profileFor,
  sessionDateForTimestamp,
  sessionWindowForDate,
  venueFromSelection,
};
