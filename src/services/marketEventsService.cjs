const crypto = require('crypto');

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

function currentEtWeek(nowValue) {
  const today = etDateKey(new Date(Number(nowValue)));
  if (!today) throw new TypeError('A valid current time is required.');
  const weekday = new Date(`${today}T12:00:00.000Z`).getUTCDay();
  const from = addDateKeyDays(today, -weekday);
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

function normalizeEvent(row = {}, context = {}) {
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

function unavailableSnapshot({ code, reason, requestedAt, retryAt = null }) {
  return {
    status: 'unavailable',
    provider: PROVIDER,
    providerMode: PROVIDER_MODE,
    timezone: ET_TIME_ZONE,
    coverage: currentEtWeek(requestedAt),
    fetchedAt: null,
    sourceUpdatedAt: null,
    sourceUrl: PROVIDER_SOURCE_URL,
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
  let successCache = null;
  let failureCache = null;
  let inFlight = null;

  async function refresh(requestedAt) {
    try {
      if (!httpClient?.get) throw providerFailure('PROVIDER_UNAVAILABLE');
      const response = await httpClient.get(PROVIDER_EXPORT_URL, {
        timeout: REQUEST_TIMEOUT_MS,
        headers: { Accept: 'application/json' },
      });
      const verified = validateProviderResponse(response, requestedAt);
      const fetchedAtMs = Number(now());
      const fetchedAt = new Date(fetchedAtMs).toISOString();
      const snapshot = Object.freeze({
        status: 'verified',
        provider: PROVIDER,
        providerMode: PROVIDER_MODE,
        timezone: ET_TIME_ZONE,
        coverage: verified.coverage,
        fetchedAt,
        sourceUpdatedAt: verified.sourceUpdatedAt,
        sourceUrl: PROVIDER_SOURCE_URL,
        code: null,
        reason: null,
        events: Object.freeze(normalizeEvents(verified.rows, {
          sourceUpdatedAt: verified.sourceUpdatedAt,
        })),
      });
      successCache = { snapshot, expiresAt: fetchedAtMs + SUCCESS_CACHE_TTL_MS };
      failureCache = null;
      return snapshot;
    } catch (error) {
      successCache = null;
      const failedAt = Number(now());
      const retryAtMs = failedAt + FAILURE_COOLDOWN_MS;
      const failure = failureFromError(error);
      const snapshot = unavailableSnapshot({
        ...failure,
        requestedAt: failedAt,
        retryAt: new Date(retryAtMs).toISOString(),
      });
      failureCache = { snapshot, retryAt: retryAtMs };
      return snapshot;
    }
  }

  function getEvents() {
    const requestedAt = Number(now());
    const requestedCoverage = currentEtWeek(requestedAt);
    const cacheMatchesWeek = successCache
      && successCache.snapshot.coverage.from === requestedCoverage.from
      && successCache.snapshot.coverage.to === requestedCoverage.to;
    if (successCache && successCache.expiresAt > requestedAt && cacheMatchesWeek) {
      return Promise.resolve(successCache.snapshot);
    }
    if (successCache && !cacheMatchesWeek) successCache = null;
    if (failureCache && failureCache.retryAt > requestedAt) {
      return Promise.resolve({
        ...failureCache.snapshot,
        coverage: currentEtWeek(requestedAt),
      });
    }
    if (inFlight) return inFlight;
    inFlight = refresh(requestedAt).finally(() => {
      inFlight = null;
    });
    return inFlight;
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
  createMarketEventsService,
  currentEtWeek,
  currencyRegion,
  etDateKey,
  eventCategory,
  isTierOneEvent,
  normalizeEvent,
  normalizeEvents,
  parseEventTimestamp,
  validateProviderResponse,
};
