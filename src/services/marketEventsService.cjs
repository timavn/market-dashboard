const { etInstant, usMarketClosures } = require('../utils/usMarketClosures.cjs');
const crypto = require('crypto');
const {
  PROVIDER: ACTUALS_PROVIDER,
  SOURCE_URL: ACTUALS_SOURCE_URL,
  loadCurrentWeekActuals,
  loadNextWeekCalendar,
} = require('./tradingEconomicsCalendarProvider.cjs');

const PROVIDER = 'Forex Factory';
const PROVIDER_MODE = 'weekly-export';
const PROVIDER_EXPORT_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
const PROVIDER_SOURCE_URL = 'https://www.forexfactory.com/calendar/rss';
const ET_TIME_ZONE = 'America/New_York';
const SUCCESS_CACHE_TTL_MS = 60 * 60 * 1000;
const FAILURE_COOLDOWN_MS = 5 * 60 * 1000;
const MAX_SOURCE_AGE_MS = 2 * 60 * 60 * 1000;
const FUTURE_TOLERANCE_MS = 2 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10 * 1000;
// Forex Factory's export never carries released figures, so actuals come from
// Trading Economics. Re-check quickly while a recent release is still missing
// its figure; otherwise only when another event releases.
const ACTUALS_PENDING_TTL_MS = 2 * 60 * 1000;
const ACTUALS_SETTLED_TTL_MS = 30 * 60 * 1000;
const ACTUALS_PENDING_WINDOW_MS = 60 * 60 * 1000;
const ACTUALS_FAILURE_COOLDOWN_MS = 5 * 60 * 1000;

const CURRENCY_REGIONS = Object.freeze({
  USD: Object.freeze({ country: 'United States', countryCode: 'US' }),
  GBP: Object.freeze({ country: 'United Kingdom', countryCode: 'UK' }),
  JPY: Object.freeze({ country: 'Japan', countryCode: 'JP' }),
  CAD: Object.freeze({ country: 'Canada', countryCode: 'CA' }),
});

const EURO_PREFIX_REGIONS = Object.freeze({
  german: Object.freeze({ country: 'Germany', countryCode: 'DE' }),
  french: Object.freeze({ country: 'France', countryCode: 'FR' }),
  italian: Object.freeze({ country: 'Italy', countryCode: 'IT' }),
});

// The prior calendar intentionally covered only the euro area aggregate plus
// Germany, France, and Italy. Reject other national EUR releases rather than
// silently relabeling them as euro-area data.
const UNSUPPORTED_EURO_PREFIX = /^(?:spanish|dutch|belgian|austrian|irish|finnish|portuguese|greek)\b/i;

const EVENT_CATEGORIES = Object.freeze([
  Object.freeze({
    category: 'central_bank',
    pattern: /\b(?:interest rate decision|fed interest rate|federal funds rate|fomc|federal reserve|ecb\b|boe\b|boj\b|bank of canada|boc\b|official bank rate|main refinancing rate|deposit facility rate|overnight rate|policy rate|rate statement|monetary policy (?:report|statement|meeting minutes|minutes))\b/i,
  }),
  Object.freeze({
    category: 'inflation',
    pattern: /\b(?:cpi|consumer prices?|inflation rate|core inflation|pce prices?|pce price index|producer prices?|ppi)\b/i,
  }),
  Object.freeze({
    category: 'employment',
    pattern: /\b(?:non[- ]?farm payrolls?|non[- ]?farm employment change|unemployment rate|employment change|employment report|jobless claims|unemployment claims|claimant count change|average hourly earnings|average earnings|jolts|job openings)\b/i,
  }),
  Object.freeze({
    category: 'gdp',
    pattern: /\b(?:gdp|gross domestic product)\b/i,
  }),
  Object.freeze({
    category: 'pmi',
    pattern: /\b(?:ism (?:manufacturing|services)|manufacturing pmi|services pmi|composite pmi)\b/i,
  }),
  Object.freeze({ category: 'retail_sales', pattern: /\bretail sales\b/i }),
  Object.freeze({ category: 'industrial_production', pattern: /\bindustrial production\b/i }),
  Object.freeze({ category: 'durable_goods', pattern: /\bdurable goods orders?\b/i }),
  Object.freeze({
    category: 'confidence',
    pattern: /\b(?:consumer confidence|consumer sentiment|business climate|economic sentiment|zew)\b/i,
  }),
]);

const FAILURE_REASONS = Object.freeze({
  PROVIDER_UNAVAILABLE: 'The Forex Factory calendar feed is temporarily unavailable.',
  PROVIDER_RATE_LIMITED: 'The Forex Factory calendar feed temporarily refused the refresh.',
  PROVIDER_INVALID_CONTENT_TYPE: 'The Forex Factory calendar feed did not return JSON.',
  PROVIDER_INVALID_RESPONSE: 'The Forex Factory calendar feed returned an invalid weekly export.',
  PROVIDER_SOURCE_TIMESTAMP_MISSING: 'The Forex Factory calendar feed is missing its update timestamp.',
  PROVIDER_SOURCE_TIMESTAMP_INVALID: 'The Forex Factory calendar feed has an invalid update timestamp.',
  PROVIDER_SOURCE_TIMESTAMP_FUTURE: 'The Forex Factory calendar feed has an unverified future update timestamp.',
  PROVIDER_SOURCE_STALE: 'The Forex Factory calendar feed has not been updated recently enough.',
  PROVIDER_WEEK_MISMATCH: 'The Forex Factory calendar feed does not match the current ET week.',
});

function cleanText(value, maxLength = 160) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, maxLength) : null;
}

function cleanValue(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text ? text.slice(0, 80) : null;
}

function dateKeyFromParts(parts) {
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function etDateKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return dateKeyFromParts(new Intl.DateTimeFormat('en-US', {
    timeZone: ET_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date));
}

function addDateKeyDays(dateKey, days) {
  const date = new Date(`${dateKey}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function currentEtWeek(nowValue, week = 'this') {
  const today = etDateKey(new Date(Number(nowValue)));
  if (!today) throw new TypeError('A valid current time is required.');
  const weekday = new Date(`${today}T12:00:00.000Z`).getUTCDay();
  const from = addDateKeyDays(today, -weekday + (week === 'next' ? 7 : 0));
  return Object.freeze({ from, to: addDateKeyDays(from, 6) });
}

function parseEventTimestamp(value) {
  const raw = cleanText(value, 80);
  if (!raw || !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw)) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function eventCategory(title) {
  return EVENT_CATEGORIES.find(({ pattern }) => pattern.test(title))?.category || null;
}

function currencyRegion(currencyValue, titleValue) {
  const currency = cleanText(currencyValue, 8)?.toUpperCase();
  const title = cleanText(titleValue) || '';
  if (CURRENCY_REGIONS[currency]) return CURRENCY_REGIONS[currency];
  if (currency !== 'EUR' || UNSUPPORTED_EURO_PREFIX.test(title)) return null;
  const prefix = title.match(/^(German|French|Italian)\b/i)?.[1]?.toLowerCase();
  return EURO_PREFIX_REGIONS[prefix] || Object.freeze({ country: 'Euro Area', countryCode: 'EU' });
}

function isCandidateEvent(row = {}) {
  const impact = cleanText(row.impact ?? row.Impact, 20)?.toLowerCase();
  const currency = cleanText(row.country ?? row.currency ?? row.Country ?? row.Currency, 8)?.toUpperCase();
  return impact === 'high' && ['USD', 'EUR', 'GBP', 'JPY', 'CAD'].includes(currency);
}

function isTierOneEvent(row = {}) {
  if (!isCandidateEvent(row)) return false;
  const title = cleanText(row.title ?? row.Title);
  if (!title || !currencyRegion(row.country ?? row.currency ?? row.Country ?? row.Currency, title)) return false;
  return Boolean(eventCategory(title));
}

function eventIdentifier(startAt, currency, title) {
  const digest = crypto
    .createHash('sha256')
    .update([startAt, currency, title].join('\u0000'))
    .digest('hex')
    .slice(0, 24);
  return `ff-${digest}`;
}

// A market holiday the provider publishes for a covered currency. US closures
// come from the exchange calendars instead (usMarketClosures), which say which
// market is shut: the provider's "Bank Holiday" does not.
function isHolidayRow(row = {}) {
  const impact = cleanText(row.impact ?? row.Impact, 20)?.toLowerCase();
  const currency = cleanText(row.country ?? row.currency ?? row.Country ?? row.Currency, 8)?.toUpperCase();
  return impact === 'holiday' && ['EUR', 'GBP', 'JPY', 'CAD'].includes(currency);
}

function normalizeHoliday(row = {}, context = {}) {
  const title = cleanText(row.title ?? row.Title);
  const currency = cleanText(row.country ?? row.currency ?? row.Country ?? row.Currency, 8)?.toUpperCase();
  const region = currencyRegion(currency, title);
  const startAt = parseEventTimestamp(row.date ?? row.Date);
  const dateKey = startAt && etDateKey(startAt);
  if (!title || !region || !dateKey) return null;
  const allDayAt = etInstant(dateKey, 0);
  const name = /bank holiday/i.test(title) ? `${region.country} bank holiday` : `${region.country}: ${title}`;
  return closureEvent({ id: eventIdentifier(allDayAt, currency, title), name, detail: `${region.country}: banks closed; local markets may be shut or thin.`,
    region, currency, startAt: allDayAt, allDay: true, provider: PROVIDER, verification: 'provider-export', sourceUrl: PROVIDER_SOURCE_URL,
    lastUpdatedAt: context.sourceUpdatedAt || null });
}

function closureEvent({ id, name, detail, region, currency, startAt, allDay, provider, verification, sourceUrl, lastUpdatedAt = null }) {
  return {
    id, kind: 'closure', name, detail, category: 'closure', country: region.country, countryCode: region.countryCode, currency,
    startAt, allDay, importance: 3, forecast: null, previous: null, actual: null, unit: null,
    source: provider, sourceUrl, lastUpdatedAt, provider, verification,
  };
}

const EXCHANGE_CALENDAR = 'Exchange calendar';
// US stock and bond closures and early closes in a week's coverage.
function usClosureEvents(coverage) {
  if (!coverage?.from || !coverage?.to) return [];
  return usMarketClosures(coverage.from, coverage.to).map((item) => closureEvent({
    id: `mc-${crypto.createHash('sha256').update([item.dateKey, item.name].join('\u0000')).digest('hex').slice(0, 24)}`,
    name: item.name, detail: item.detail, region: CURRENCY_REGIONS.USD, currency: 'USD', startAt: item.startAt, allDay: item.allDay,
    provider: EXCHANGE_CALENDAR, verification: 'exchange-calendar', sourceUrl: 'https://www.nyse.com/markets/hours-calendars',
  }));
}

function withClosures(events, coverage) {
  return [...events, ...usClosureEvents(coverage)].sort((left, right) => (
    left.startAt.localeCompare(right.startAt) || left.id.localeCompare(right.id)
  ));
}

function normalizeEvent(row = {}, context = {}) {
  if (isHolidayRow(row)) return normalizeHoliday(row, context);
  if (!isTierOneEvent(row)) return null;
  const title = cleanText(row.title ?? row.Title);
  const currency = cleanText(row.country ?? row.currency ?? row.Country ?? row.Currency, 8)?.toUpperCase();
  const region = currencyRegion(currency, title);
  const startAt = parseEventTimestamp(row.date ?? row.Date);
  if (!title || !currency || !region || !startAt) return null;

  return {
    id: eventIdentifier(startAt, currency, title),
    name: title,
    category: eventCategory(title),
    country: region.country,
    countryCode: region.countryCode,
    currency,
    startAt,
    importance: 3,
    forecast: cleanValue(row.forecast ?? row.Forecast),
    previous: cleanValue(row.previous ?? row.Previous),
    actual: null,
    unit: null,
    source: PROVIDER,
    sourceUrl: PROVIDER_SOURCE_URL,
    lastUpdatedAt: context.sourceUpdatedAt || null,
    provider: PROVIDER,
    verification: 'provider-export',
  };
}

function normalizeEvents(payload, context = {}) {
  if (!Array.isArray(payload)) return [];
  const seen = new Set();
  return payload
    .map((row) => normalizeEvent(row, context))
    .filter((event) => {
      if (!event || seen.has(event.id)) return false;
      seen.add(event.id);
      return true;
    })
    .sort((left, right) => (
      left.startAt.localeCompare(right.startAt) || left.id.localeCompare(right.id)
    ));
}

// Forex Factory and Trading Economics name the same release differently
// ("Core CPI m/m" vs "Core Inflation Rate MoM"). Reduce both to an
// order-independent token signature; an actual is attached only when exactly
// one release in the same country and minute has the same signature.
const RELEASE_ALIASES = Object.freeze([
  [/\bm\/m\b/g, ' mom '],
  [/\by\/y\b/g, ' yoy '],
  [/\bq\/q\b/g, ' qoq '],
  [/\bs&p global\b/g, ' '],
  [/\bnon farm employment change\b/g, ' non farm payrolls '],
  [/\bunemployment claims\b/g, ' initial jobless claims '],
  [/\bcore retail sales\b/g, ' retail sales ex autos '],
  [/\b(?:federal funds rate|main refinancing rate|official bank rate|boj policy rate|overnight rate|(?:fed|ecb|boe|boj|boc) interest rate decision)\b/g, ' interest rate decision '],
  [/\buom\b/g, ' michigan '],
  [/\bcpi\b/g, ' inflation rate '],
  [/\bgdp growth rate\b/g, ' gdp '],
]);
const RELEASE_QUALIFIERS = new Set([
  'prelim', 'preliminary', 'prel', 'flash', 'final', 'advance', 'adv', 'estimate', 'est',
  '2nd', '3rd', 'second', 'third', 'german', 'french', 'italian', 'hcob', 'index',
]);

function releaseSignature(name) {
  let text = String(name || '').toLowerCase().replace(/-/g, ' ');
  for (const [pattern, replacement] of RELEASE_ALIASES) text = text.replace(pattern, replacement);
  return [...new Set(text.split(/[^a-z0-9]+/).filter((token) => token && !RELEASE_QUALIFIERS.has(token)))]
    .sort()
    .join(' ');
}

function expectsActual(event) {
  return Boolean(event.forecast || event.previous);
}

function attachActuals(events, actuals, requestedAt) {
  const bySlot = new Map();
  for (const release of actuals.releases) {
    const key = `${release.countryCode}|${release.startAt}`;
    if (!bySlot.has(key)) bySlot.set(key, []);
    bySlot.get(key).push(release);
  }
  return events.map((event) => {
    if (Date.parse(event.startAt) > requestedAt || !expectsActual(event)) return event;
    const signature = releaseSignature(event.name);
    const matches = (bySlot.get(`${event.countryCode}|${event.startAt}`) || [])
      .filter((release) => releaseSignature(release.name) === signature);
    if (matches.length !== 1) return event;
    return {
      ...event,
      actual: matches[0].actual,
      actualSource: actuals.provider,
      actualSourceUrl: matches[0].sourceUrl,
      actualObservedAt: actuals.observedAt,
    };
  });
}

function awaitingActual(events, requestedAt) {
  return events.some((event) => {
    const startMs = Date.parse(event.startAt);
    return event.actual === null && expectsActual(event)
      && startMs <= requestedAt && requestedAt - startMs <= ACTUALS_PENDING_WINDOW_MS;
  });
}

function headerValue(headers, name) {
  if (typeof headers?.get === 'function') return headers.get(name);
  const lowerName = name.toLowerCase();
  const key = Object.keys(headers || {}).find((candidate) => candidate.toLowerCase() === lowerName);
  return key ? headers[key] : null;
}

function providerFailure(code) {
  return Object.assign(new Error(FAILURE_REASONS[code] || FAILURE_REASONS.PROVIDER_UNAVAILABLE), {
    code,
    safeReason: FAILURE_REASONS[code] || FAILURE_REASONS.PROVIDER_UNAVAILABLE,
  });
}

function parsePayload(data) {
  if (Array.isArray(data)) return data;
  if (typeof data !== 'string') throw providerFailure('PROVIDER_INVALID_RESPONSE');
  try {
    const parsed = JSON.parse(data);
    if (!Array.isArray(parsed)) throw providerFailure('PROVIDER_INVALID_RESPONSE');
    return parsed;
  } catch (error) {
    if (error?.code) throw error;
    throw providerFailure('PROVIDER_INVALID_RESPONSE');
  }
}

function validateProviderResponse(response, requestedAt) {
  const responseText = typeof response?.data === 'string' ? response.data : '';
  if (/rate limit|too many requests|request denied/i.test(responseText)) {
    throw providerFailure('PROVIDER_RATE_LIMITED');
  }
  const contentType = cleanText(headerValue(response?.headers, 'content-type'), 100)?.toLowerCase() || '';
  if (!/^application\/(?:[a-z0-9.+-]*\+)?json(?:\s*;|$)/i.test(contentType)) {
    throw providerFailure('PROVIDER_INVALID_CONTENT_TYPE');
  }

  const sourceHeader = cleanText(headerValue(response?.headers, 'last-modified'), 100);
  if (!sourceHeader) throw providerFailure('PROVIDER_SOURCE_TIMESTAMP_MISSING');
  const sourceUpdatedMs = Date.parse(sourceHeader);
  if (!Number.isFinite(sourceUpdatedMs)) throw providerFailure('PROVIDER_SOURCE_TIMESTAMP_INVALID');
  const sourceAge = requestedAt - sourceUpdatedMs;
  if (sourceAge < -FUTURE_TOLERANCE_MS) throw providerFailure('PROVIDER_SOURCE_TIMESTAMP_FUTURE');
  if (sourceAge > MAX_SOURCE_AGE_MS) throw providerFailure('PROVIDER_SOURCE_STALE');

  const rows = parsePayload(response?.data);
  if (!rows.length) throw providerFailure('PROVIDER_INVALID_RESPONSE');
  const coverage = currentEtWeek(requestedAt);
  for (const row of rows) {
    const startAt = parseEventTimestamp(row?.date ?? row?.Date);
    const dateKey = startAt ? etDateKey(startAt) : null;
    if (!dateKey || dateKey < coverage.from || dateKey > coverage.to) {
      throw providerFailure('PROVIDER_WEEK_MISMATCH');
    }
  }

  return {
    rows,
    coverage,
    sourceUpdatedAt: new Date(sourceUpdatedMs).toISOString(),
  };
}

function unavailableSnapshot({ code, reason, requestedAt, retryAt = null, week = 'this' }) {
  const nextWeek = week === 'next';
  return {
    status: 'unavailable',
    provider: nextWeek ? 'Trading Economics' : PROVIDER,
    providerMode: nextWeek ? 'calendar-page' : PROVIDER_MODE,
    timezone: ET_TIME_ZONE,
    coverage: currentEtWeek(requestedAt, week),
    fetchedAt: null,
    sourceUpdatedAt: null,
    ...(nextWeek ? { sourceObservedAt: null } : {}),
    sourceUrl: nextWeek ? 'https://tradingeconomics.com/calendar' : PROVIDER_SOURCE_URL,
    code: code || 'PROVIDER_UNAVAILABLE',
    reason: reason || FAILURE_REASONS.PROVIDER_UNAVAILABLE,
    ...(retryAt ? { retryAt } : {}),
    events: [],
  };
}

function failureFromError(error) {
  if (error?.code && FAILURE_REASONS[error.code]) {
    return { code: error.code, reason: error.safeReason || FAILURE_REASONS[error.code] };
  }
  const status = Number(error?.response?.status);
  const body = typeof error?.response?.data === 'string' ? error.response.data : '';
  if (status === 429 || /rate limit|too many requests|request denied/i.test(body)) {
    return { code: 'PROVIDER_RATE_LIMITED', reason: FAILURE_REASONS.PROVIDER_RATE_LIMITED };
  }
  return { code: 'PROVIDER_UNAVAILABLE', reason: FAILURE_REASONS.PROVIDER_UNAVAILABLE };
}

function createMarketEventsService(options = {}) {
  const httpClient = options.httpClient;
  const now = options.now || (() => Date.now());
  // The two sources have independent coverage, failure cooldowns and requests.
  const weeks = new Map(['this', 'next'].map(week => [week, {
    successCache: null, failureCache: null, inFlight: null,
  }]));
  const actualsState = { cache: null, inFlight: null };

  function actualsCacheFresh(cache, snapshot, requestedAt) {
    if (!cache || cache.coverageFrom !== snapshot.coverage.from || cache.expiresAt <= requestedAt) return false;
    if (cache.status !== 'verified') return true;
    return !snapshot.events.some((event) => {
      const startMs = Date.parse(event.startAt);
      return expectsActual(event) && startMs > cache.fetchedAt && startMs <= requestedAt;
    });
  }

  async function refreshActuals(snapshot, requestedAt) {
    let cache;
    try {
      if (typeof loadCurrentWeekActuals !== 'function') throw providerFailure('PROVIDER_UNAVAILABLE');
      const actuals = await loadCurrentWeekActuals({ httpClient, requestedAt, coverage: snapshot.coverage });
      const fetchedAt = Number(now());
      const events = attachActuals(snapshot.events, actuals, fetchedAt);
      cache = {
        status: 'verified', coverageFrom: snapshot.coverage.from, fetchedAt, actuals,
        expiresAt: fetchedAt + (awaitingActual(events, fetchedAt) ? ACTUALS_PENDING_TTL_MS : ACTUALS_SETTLED_TTL_MS),
      };
    } catch {
      const fetchedAt = Number(now());
      cache = {
        status: 'unavailable', coverageFrom: snapshot.coverage.from, fetchedAt, actuals: null,
        expiresAt: fetchedAt + ACTUALS_FAILURE_COOLDOWN_MS,
      };
    }
    actualsState.cache = cache;
    return cache;
  }

  async function withActuals(snapshot) {
    const requestedAt = Number(now());
    if (snapshot.status !== 'verified'
        || !snapshot.events.some((event) => expectsActual(event) && Date.parse(event.startAt) <= requestedAt)) {
      return snapshot;
    }
    let cache = actualsState.cache;
    if (!actualsCacheFresh(cache, snapshot, requestedAt)) {
      if (!actualsState.inFlight) {
        actualsState.inFlight = refreshActuals(snapshot, requestedAt).finally(() => {
          actualsState.inFlight = null;
        });
      }
      cache = await actualsState.inFlight;
    }
    // Reuse the merged snapshot so concurrent and cached callers share one object.
    if (cache.merged?.base === snapshot) return cache.merged.result;
    const result = Object.freeze({
      ...snapshot,
      events: Object.freeze(cache.actuals
        ? attachActuals(snapshot.events, cache.actuals, Number(now()))
        : snapshot.events),
      actuals: Object.freeze({
        status: cache.status,
        provider: ACTUALS_PROVIDER,
        sourceUrl: ACTUALS_SOURCE_URL,
        observedAt: cache.actuals?.observedAt || null,
      }),
    });
    cache.merged = { base: snapshot, result };
    return result;
  }

  async function refresh(requestedAt, week, state) {
    try {
      if (!httpClient?.get) throw providerFailure('PROVIDER_UNAVAILABLE');
      let payload;
      if (week === 'next') {
        payload = await loadNextWeekCalendar({
          httpClient,
          requestedAt,
          coverage: currentEtWeek(requestedAt, week),
          categorizeEvent: eventCategory,
        });
      } else {
        const response = await httpClient.get(PROVIDER_EXPORT_URL, {
          timeout: REQUEST_TIMEOUT_MS,
          headers: { Accept: 'application/json' },
        });
        const verified = validateProviderResponse(response, requestedAt);
        payload = {
          status: 'verified',
          provider: PROVIDER,
          providerMode: PROVIDER_MODE,
          timezone: ET_TIME_ZONE,
          coverage: verified.coverage,
          sourceUpdatedAt: verified.sourceUpdatedAt,
          sourceUrl: PROVIDER_SOURCE_URL,
          code: null,
          reason: null,
          events: normalizeEvents(verified.rows, { sourceUpdatedAt: verified.sourceUpdatedAt }),
        };
      }
      const fetchedAtMs = Number(now());
      const completedCoverage = currentEtWeek(fetchedAtMs, week);
      if (payload.coverage.from !== completedCoverage.from || payload.coverage.to !== completedCoverage.to) {
        throw providerFailure('PROVIDER_WEEK_MISMATCH');
      }
      const fetchedAt = new Date(fetchedAtMs).toISOString();
      const snapshot = Object.freeze({
        ...payload,
        fetchedAt,
        events: Object.freeze(withClosures(payload.events, payload.coverage)),
      });
      state.successCache = { snapshot, expiresAt: fetchedAtMs + SUCCESS_CACHE_TTL_MS };
      state.failureCache = null;
      return snapshot;
    } catch (error) {
      state.successCache = null;
      const failedAt = Number(now());
      const retryAtMs = failedAt + FAILURE_COOLDOWN_MS;
      const failure = week === 'next'
        ? {
          code: error?.code?.startsWith('CALENDAR_') ? error.code : 'PROVIDER_UNAVAILABLE',
          reason: error?.code?.startsWith('CALENDAR_') && error.safeReason
            ? error.safeReason : 'The Trading Economics calendar is temporarily unavailable.',
        }
        : failureFromError(error);
      const snapshot = unavailableSnapshot({
        ...failure,
        requestedAt: failedAt,
        retryAt: new Date(retryAtMs).toISOString(),
        week,
      });
      state.failureCache = { snapshot, retryAt: retryAtMs };
      return snapshot;
    }
  }

  function getEvents({ week = 'this' } = {}) {
    week = week === 'next' ? 'next' : 'this';
    const snapshot = getSnapshot(week);
    return week === 'this' ? snapshot.then(withActuals) : snapshot;
  }

  function getSnapshot(week) {
    const state = weeks.get(week);
    const requestedAt = Number(now());
    const { successCache, failureCache } = state;
    const requestedCoverage = currentEtWeek(requestedAt, week);
    const cacheMatchesWeek = successCache
      && successCache.snapshot.coverage.from === requestedCoverage.from
      && successCache.snapshot.coverage.to === requestedCoverage.to;
    if (successCache && successCache.expiresAt > requestedAt && cacheMatchesWeek) {
      return Promise.resolve(successCache.snapshot);
    }
    if (successCache && !cacheMatchesWeek) state.successCache = null;
    if (failureCache && failureCache.retryAt > requestedAt) {
      return Promise.resolve({
        ...failureCache.snapshot,
        coverage: requestedCoverage,
      });
    }
    if (state.inFlight) return state.inFlight;
    state.inFlight = refresh(requestedAt, week, state).finally(() => {
      state.inFlight = null;
    });
    return state.inFlight;
  }

  return { getEvents };
}

module.exports = {
  ET_TIME_ZONE,
  FAILURE_COOLDOWN_MS,
  MAX_SOURCE_AGE_MS,
  PROVIDER,
  PROVIDER_EXPORT_URL,
  PROVIDER_MODE,
  PROVIDER_SOURCE_URL,
  SUCCESS_CACHE_TTL_MS,
  ACTUALS_PENDING_TTL_MS,
  ACTUALS_SETTLED_TTL_MS,
  attachActuals,
  createMarketEventsService,
  usClosureEvents,
  currentEtWeek,
  currencyRegion,
  etDateKey,
  eventCategory,
  isTierOneEvent,
  normalizeEvent,
  normalizeEvents,
  parseEventTimestamp,
  releaseSignature,
  validateProviderResponse,
};
