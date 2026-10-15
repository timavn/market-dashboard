const { zonedTimeToUtc } = require('date-fns-tz');
const { DIRECTIONAL_FEEDS } = require('./directionalFeedRegistry.cjs');

const DAY_MS = 24 * 60 * 60_000;
const LOCAL_PARTS_FORMATTER_LIMIT = 16;
const localPartsFormatters = new Map();
const WEEKDAYS = Object.freeze({ Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 });

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
  if (DIRECTIONAL_FEEDS[normalizedMarketId]?.calendar === 'continuous') return PROFILES.event_window;
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
  return null;
}

function localParts(timestamp, timeZone) {
  if (!Number.isFinite(Number(timestamp))) return null;
  const value = Number(timestamp);
  try {
    // date-fns-tz treats an omitted zone or "Z" as UTC. Retain that behavior
    // for custom profiles, independently of the API process's local zone.
    const zone = !timeZone || timeZone === 'Z' ? 'UTC' : timeZone;
    let formatter = localPartsFormatters.get(zone);
    if (!formatter) {
      formatter = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
        timeZone: zone,
        year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
      });
      // Cache formatting machinery only, never prices or session observations.
      if (localPartsFormatters.size >= LOCAL_PARTS_FORMATTER_LIMIT) {
        localPartsFormatters.delete(localPartsFormatters.keys().next().value);
      }
      localPartsFormatters.set(zone, formatter);
    }
    // The fixed locale has a stable compact representation. Reading it avoids
    // allocating a parts array and several intermediate objects for every bar.
    const formatted = /^(\w{3}), (\d{2})\/(\d{2})\/(\d+), (\d{2}):(\d{2})$/.exec(formatter.format(value));
    if (formatted && Object.prototype.hasOwnProperty.call(WEEKDAYS, formatted[1])) {
      return {
        dateKey: `${formatted[4].padStart(4, '0')}-${formatted[2]}-${formatted[3]}`,
        weekday: WEEKDAYS[formatted[1]],
        minutes: (Number(formatted[5]) * 60) + Number(formatted[6]),
      };
    }
    // Preserve the established decoder if an Intl implementation uses a
    // different literal layout for the same explicitly requested fields.
    const parts = Object.fromEntries(formatter.formatToParts(value)
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, part.value]));
    return {
      dateKey: `${parts.year.padStart(4, '0')}-${parts.month}-${parts.day}`,
      weekday: WEEKDAYS[parts.weekday],
      minutes: (Number(parts.hour) * 60) + Number(parts.minute),
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

function sessionDateForTimestampUsing(profile, timestamp, readLocalParts) {
  if (!profile || profile.kind === 'event') return null;
  const parts = readLocalParts(timestamp, profile.timeZone);
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

function sessionDateForTimestamp(profile, timestamp) {
  return sessionDateForTimestampUsing(profile, timestamp, localParts);
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

function dateForPointUsing(session, timestamp, { currentOnly = false } = {}, readLocalParts = localParts) {
  const window = session?.currentWindow;
  if (currentOnly && window) {
    const startMs = Date.parse(window.startAt);
    const endMs = Date.parse(window.endAt);
    return Number(timestamp) >= startMs && Number(timestamp) <= endMs ? window.sessionDate : null;
  }
  return sessionDateForTimestampUsing(session?.profile, timestamp, readLocalParts);
}

function dateForPoint(session, timestamp, options) {
  return dateForPointUsing(session, timestamp, options);
}

function createSessionDateReader() {
  // One chart build visits the same bars for several ranges and its prior
  // close. Reuse date decoding only within that build, while applying each
  // profile and selected window independently on every visit.
  const partsByZone = new Map();
  const readLocalParts = (timestamp, timeZone) => {
    const value = Number(timestamp);
    const zone = !timeZone || timeZone === 'Z' ? 'UTC' : timeZone;
    let partsByTimestamp = partsByZone.get(zone);
    if (!partsByTimestamp) {
      partsByTimestamp = new Map();
      partsByZone.set(zone, partsByTimestamp);
    }
    if (!partsByTimestamp.has(value)) partsByTimestamp.set(value, localParts(timestamp, timeZone));
    return partsByTimestamp.get(value);
  };
  return (session, timestamp, options) => dateForPointUsing(session, timestamp, options, readLocalParts);
}

module.exports = {
  PROFILES,
  addDateKey,
  buildResolverChartSession,
  createSessionDateReader,
  dateForPoint,
  eventFromSelection,
  observationAtFromSelection,
  profileFor,
  sessionDateForTimestamp,
  sessionWindowForDate,
  venueFromSelection,
};
