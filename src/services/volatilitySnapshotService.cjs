const { zonedTimeToUtc } = require('date-fns-tz');

const NEW_YORK_TIME_ZONE = 'America/New_York';
const CBOE_HISTORY_CACHE_TTL_MS = 15 * 60 * 1000;
const CBOE_MAX_QUOTE_AGE_MS = 30 * 60 * 1000;

const CBOE_SERIES = [
  { name: 'VIX', symbol: 'VIX' },
  { name: 'VVIX', symbol: 'VVIX' },
  { name: 'RVX', symbol: 'RVX' },
  { name: 'NazVol', symbol: 'VXN' },
  { name: 'GVZ', symbol: 'GVZ' },
  { name: 'OVX', symbol: 'OVX' },
];

const NUMERIC_FIELDS = [
  'lastPx',
  'day1Ago',
  'week1Ago',
  'week4Ago',
  'dayChangePct',
  'weekChangePct',
  'monthChangePct',
  'threeMonthChangePct',
  'sixMonthChangePct',
  'ytdChangePct',
];

function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function sameProviderPrice(left, right) {
  const leftPrice = finitePositive(left);
  const rightPrice = finitePositive(right);
  if (leftPrice == null || rightPrice == null) return false;
  return Math.abs(leftPrice - rightPrice) <= Math.max(0.0001, rightPrice * 0.000001);
}

function roundToTwo(value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

function percentageChange(current, reference) {
  if (!Number.isFinite(current) || !Number.isFinite(reference) || reference === 0) return null;
  return roundToTwo(((current / reference) - 1) * 100);
}

function normalizeDateKey(raw) {
  const value = String(raw || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const match = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return null;
  return `${match[3]}-${match[1].padStart(2, '0')}-${match[2].padStart(2, '0')}`;
}

function parseCboeHistoryCsv(csvText) {
  const lines = String(csvText || '')
    .replace(/^\uFEFF/, '')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
  if (lines.length < 2) return [];

  const headers = lines[0].split(',').map((header) => header.trim().toUpperCase());
  const closeIndex = headers.indexOf('CLOSE') >= 0 ? headers.indexOf('CLOSE') : 1;

  return lines
    .slice(1)
    .map((line) => {
      const columns = line.split(',');
      const date = normalizeDateKey(columns[0]);
      const close = finitePositive(columns[closeIndex]);
      return date && close != null ? { date, close } : null;
    })
    .filter(Boolean)
    .sort((left, right) => left.date.localeCompare(right.date));
}

function newYorkParts(dateLike) {
  const date = dateLike instanceof Date ? dateLike : new Date(dateLike);
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: NEW_YORK_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

function dateKeyToUtcDate(dateKey) {
  return new Date(`${dateKey}T12:00:00.000Z`);
}

function addCalendarDays(dateKey, days) {
  const date = dateKeyToUtcDate(dateKey);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function observedFixedHoliday(year, monthIndex, day) {
  const date = new Date(Date.UTC(year, monthIndex, day));
  if (date.getUTCDay() === 6) date.setUTCDate(date.getUTCDate() - 1);
  if (date.getUTCDay() === 0) date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function nthWeekdayOfMonth(year, monthIndex, weekday, occurrence) {
  const date = new Date(Date.UTC(year, monthIndex, 1));
  const offset = (weekday - date.getUTCDay() + 7) % 7;
  date.setUTCDate(1 + offset + ((occurrence - 1) * 7));
  return date.toISOString().slice(0, 10);
}

function lastWeekdayOfMonth(year, monthIndex, weekday) {
  const date = new Date(Date.UTC(year, monthIndex + 1, 0));
  const offset = (date.getUTCDay() - weekday + 7) % 7;
  date.setUTCDate(date.getUTCDate() - offset);
  return date.toISOString().slice(0, 10);
}

function easterSundayDateKey(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = ((19 * a) + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + (2 * e) + (2 * i) - h - k) % 7;
  const m = Math.floor((a + (11 * h) + (22 * l)) / 451);
  const month = Math.floor((h + l - (7 * m) + 114) / 31);
  const day = ((h + l - (7 * m) + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function marketHolidayKeys(year) {
  const keys = new Set([
    observedFixedHoliday(year, 0, 1),
    nthWeekdayOfMonth(year, 0, 1, 3),
    nthWeekdayOfMonth(year, 1, 1, 3),
    addCalendarDays(easterSundayDateKey(year), -2),
    lastWeekdayOfMonth(year, 4, 1),
    observedFixedHoliday(year, 6, 4),
    nthWeekdayOfMonth(year, 8, 1, 1),
    nthWeekdayOfMonth(year, 10, 4, 4),
    observedFixedHoliday(year, 11, 25),
  ]);
  if (year >= 2022) keys.add(observedFixedHoliday(year, 5, 19));
  // A Saturday New Year's Day is observed on December 31 of the prior year.
  keys.add(observedFixedHoliday(year + 1, 0, 1));
  return keys;
}

function isTradingDateKey(dateKey) {
  const date = dateKeyToUtcDate(dateKey);
  const weekday = date.getUTCDay();
  if (weekday === 0 || weekday === 6) return false;
  return !marketHolidayKeys(date.getUTCFullYear()).has(dateKey);
}

function previousTradingDateKey(dateKey) {
  let candidate = addCalendarDays(dateKey, -1);
  while (!isTradingDateKey(candidate)) candidate = addCalendarDays(candidate, -1);
  return candidate;
}

function isUsMarketOpen(now) {
  const parts = newYorkParts(now);
  if (!isTradingDateKey(parts.dateKey)) return false;
  const minutes = (parts.hour * 60) + parts.minute;
  return minutes >= (9 * 60 + 30) && minutes < (16 * 60 + 15);
}

function mostRecentCompletedTradingDateKey(now) {
  const parts = newYorkParts(now);
  if (!isTradingDateKey(parts.dateKey)) {
    let candidate = parts.dateKey;
    while (!isTradingDateKey(candidate)) candidate = addCalendarDays(candidate, -1);
    return candidate;
  }
  const minutes = (parts.hour * 60) + parts.minute;
  return minutes >= (16 * 60 + 15) ? parts.dateKey : previousTradingDateKey(parts.dateKey);
}

function parseCboeAsOf(lastTradeTime, payloadTimestamp) {
  if (lastTradeTime) {
    const raw = String(lastTradeTime).trim();
    const parsed = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw)
      ? new Date(raw)
      : zonedTimeToUtc(raw, NEW_YORK_TIME_ZONE);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  if (payloadTimestamp) {
    const parsed = new Date(`${String(payloadTimestamp).trim().replace(' ', 'T')}Z`);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return null;
}

function quoteFreshness(asOf, now, maxAgeMs) {
  if (!(asOf instanceof Date) || Number.isNaN(asOf.getTime())) return 'defective';
  const ageMs = now.getTime() - asOf.getTime();
  if (ageMs < -(5 * 60 * 1000)) return 'defective';
  if (isUsMarketOpen(now)) return ageMs <= maxAgeMs ? 'current' : 'stale';
  const quoteDate = newYorkParts(asOf).dateKey;
  return quoteDate === mostRecentCompletedTradingDateKey(now) ? 'current' : 'stale';
}

function normalizeRows(rows) {
  const byDate = new Map();
  (rows || []).forEach((row) => {
    const date = normalizeDateKey(row?.date);
    const close = finitePositive(row?.close);
    if (date && close != null && isTradingDateKey(date)) byDate.set(date, { date, close });
  });
  return [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date));
}

function combineCurrentQuote(history, asOf, currentPrice) {
  const currentDate = newYorkParts(asOf).dateKey;
  return normalizeRows([
    ...history.filter((row) => row.date !== currentDate),
    { date: currentDate, close: currentPrice },
  ]);
}

function computeVolatilityMetrics(rows) {
  const normalized = normalizeRows(rows);
  if (normalized.length < 2) return null;
  const lastIndex = normalized.length - 1;
  const currentRow = normalized[lastIndex];
  const reference = (sessionsAgo) => (
    lastIndex - sessionsAgo >= 0 ? normalized[lastIndex - sessionsAgo] : null
  );
  const priorYearClose = [...normalized]
    .reverse()
    .find((row) => row.date < `${currentRow.date.slice(0, 4)}-01-01`) || null;

  const day = reference(1);
  const week = reference(5);
  const month = reference(21);
  const threeMonth = reference(63);
  const sixMonth = reference(126);

  return {
    lastPx: currentRow.close,
    day1Ago: day?.close ?? null,
    week1Ago: week?.close ?? null,
    week4Ago: month?.close ?? null,
    dayChangePct: percentageChange(currentRow.close, day?.close),
    weekChangePct: percentageChange(currentRow.close, week?.close),
    monthChangePct: percentageChange(currentRow.close, month?.close),
    threeMonthChangePct: percentageChange(currentRow.close, threeMonth?.close),
    sixMonthChangePct: percentageChange(currentRow.close, sixMonth?.close),
    ytdChangePct: percentageChange(currentRow.close, priorYearClose?.close),
  };
}

function unavailableRow({ source, sourceLabel, quoteMode, freshness = 'defective', asOf = null, error = null }) {
  return {
    ...Object.fromEntries(NUMERIC_FIELDS.map((field) => [field, null])),
    source,
    sourceLabel,
    quoteMode,
    asOf: asOf instanceof Date && !Number.isNaN(asOf.getTime()) ? asOf.toISOString() : null,
    availability: 'unavailable',
    freshness,
    ...(error ? { error } : {}),
  };
}

function availableRow(metrics, { source, sourceLabel, quoteMode, asOf }) {
  return {
    ...metrics,
    source,
    sourceLabel,
    quoteMode,
    asOf: asOf.toISOString(),
    availability: 'available',
    freshness: 'current',
  };
}

function historicalRow(metrics, { source, sourceLabel, quoteMode, asOf }) {
  return {
    ...metrics,
    source,
    sourceLabel,
    quoteMode,
    asOf: asOf.toISOString(),
    availability: 'historical',
    freshness: 'historical',
  };
}

function validatePriorSession(history, quoteDate) {
  const expectedPrior = previousTradingDateKey(quoteDate);
  return history.some((row) => row.date === expectedPrior);
}

function createVolatilitySnapshotService({
  httpClient = null,
  now = () => new Date(),
  logger = console,
  historyCacheTtlMs = CBOE_HISTORY_CACHE_TTL_MS,
} = {}) {
  const client = httpClient || require('axios');
  const historyCache = new Map();

  async function fetchCboeHistory(symbol) {
    const currentTime = now().getTime();
    const cached = historyCache.get(symbol);
    if (cached && currentTime - cached.cachedAt < historyCacheTtlMs) return cached.rows;
    historyCache.delete(symbol);

    const url = `https://cdn.cboe.com/api/global/us_indices/daily_prices/${symbol}_History.csv`;
    const response = await client.get(url, {
      responseType: 'text',
      timeout: 12000,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    const rows = parseCboeHistoryCsv(response.data);
    if (rows.length < 2) throw new Error(`${symbol} history is empty or invalid`);
    historyCache.set(symbol, { rows, cachedAt: currentTime });
    return rows;
  }

  async function fetchCboeSeries({ name, symbol }) {
    const sourceMeta = {
      source: 'cboe',
      sourceLabel: 'Cboe Global Indices',
      quoteMode: 'delayed',
    };
    try {
      const [quoteResponse, history] = await Promise.all([
        client.get(`https://cdn.cboe.com/api/global/delayed_quotes/quotes/_${symbol}.json`, {
          timeout: 12000,
          headers: { 'User-Agent': 'Mozilla/5.0' },
        }),
        fetchCboeHistory(symbol),
      ]);
      const payload = quoteResponse.data || {};
      const quote = payload.data || {};
      const currentPrice = finitePositive(quote.current_price);
      const asOf = parseCboeAsOf(quote.last_trade_time, payload.timestamp);
      const freshness = quoteFreshness(asOf, now(), CBOE_MAX_QUOTE_AGE_MS);
      if (currentPrice == null || !asOf || freshness !== 'current') {
        return [name, unavailableRow({
          ...sourceMeta,
          freshness,
          asOf,
          error: currentPrice == null ? 'invalid_quote' : 'stale_quote',
        })];
      }
      const quoteDate = newYorkParts(asOf).dateKey;
      if (!validatePriorSession(history, quoteDate)) {
        return [name, unavailableRow({ ...sourceMeta, asOf, error: 'incomplete_history' })];
      }
      const metrics = computeVolatilityMetrics(combineCurrentQuote(history, asOf, currentPrice));
      if (!metrics) return [name, unavailableRow({ ...sourceMeta, asOf, error: 'insufficient_history' })];
      return [name, availableRow(metrics, { ...sourceMeta, asOf })];
    } catch (error) {
      logger.warn?.(`[volatility-snapshot] ${name} unavailable: ${error.message}`);
      return [name, unavailableRow({ ...sourceMeta, error: 'provider_error' })];
    }
  }

  async function fetchMoveSeries() {
    const sourceMeta = {
      source: 'yahoo',
      sourceLabel: 'Yahoo Finance',
      quoteMode: 'end-of-day',
    };
    try {
      const response = await client.get(
        'https://query1.finance.yahoo.com/v8/finance/chart/%5EMOVE',
        {
          params: { range: '1y', interval: '1d', includePrePost: 'false' },
          timeout: 12000,
          headers: { 'User-Agent': 'Mozilla/5.0' },
        }
      );
      const result = response.data?.chart?.result?.[0];
      const meta = result?.meta || {};
      const timestamps = result?.timestamp || [];
      const closes = result?.indicators?.quote?.[0]?.close || [];
      const currentPrice = finitePositive(meta.regularMarketPrice);
      const asOf = meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000) : null;
      if (!result || currentPrice == null || !asOf || Number.isNaN(asOf.getTime())) {
        return ['MOVE', unavailableRow({
          ...sourceMeta,
          asOf,
          error: 'invalid_quote',
        })];
      }

      const currentTime = now();
      const quoteDate = newYorkParts(asOf).dateKey;
      const expectedCompletedSession = mostRecentCompletedTradingDateKey(currentTime);
      const history = normalizeRows(timestamps.map((timestamp, index) => ({
        date: newYorkParts(new Date(timestamp * 1000)).dateKey,
        close: closes[index],
      })));

      const currentDate = newYorkParts(currentTime).dateKey;
      const carriedRow = history.at(-1);
      const rowBeforeCarry = history.at(-2);
      const carriedSession = previousTradingDateKey(quoteDate);
      const expectedBeforeCarry = previousTradingDateKey(carriedSession);
      const isCurrentDayCarry = quoteDate === currentDate
        && [carriedSession, quoteDate].includes(expectedCompletedSession)
        && carriedRow?.date === quoteDate
        && sameProviderPrice(carriedRow.close, currentPrice)
        && rowBeforeCarry?.date === expectedBeforeCarry;

      // ^MOVE's current-day daily bar can carry the prior session's published
      // EOD value across the 16:15 ET cutoff. Re-date that verified carry before
      // evaluating the generic completed-session timestamp rules below.
      if (isCurrentDayCarry) {
        const carriedHistory = normalizeRows([
          ...history.filter((row) => row.date < carriedSession),
          { date: carriedSession, close: carriedRow.close },
        ]);
        const completedAsOf = zonedTimeToUtc(
          `${carriedSession}T16:15:00`,
          NEW_YORK_TIME_ZONE,
        );
        const metrics = computeVolatilityMetrics(carriedHistory);
        if (!metrics) {
          return ['MOVE', unavailableRow({ ...sourceMeta, asOf: completedAsOf, error: 'insufficient_history' })];
        }
        return ['MOVE', historicalRow(metrics, { ...sourceMeta, asOf: completedAsOf })];
      }

      // Yahoo updates ^MOVE's regularMarketTime intraday even though this card is
      // intentionally end-of-day. Prefer an exact completed-session history row.
      // Yahoo can instead stamp the carried prior close with today's active-session
      // date, so accept that shape only when the immediately preceding bar proves
      // the completed-session sequence is contiguous.
      if (quoteDate > expectedCompletedSession) {
        const completedTimestampIndex = timestamps.findIndex((timestamp, index) => (
          newYorkParts(new Date(timestamp * 1000)).dateKey === expectedCompletedSession
          && finitePositive(closes[index]) != null
        ));
        const completedHistory = history.filter((row) => row.date <= expectedCompletedSession);
        if (completedTimestampIndex >= 0 && completedHistory.some((row) => row.date === expectedCompletedSession)) {
          if (!validatePriorSession(completedHistory, expectedCompletedSession)) {
            return ['MOVE', unavailableRow({ ...sourceMeta, asOf, error: 'incomplete_history' })];
          }
          const completedAsOf = new Date(timestamps[completedTimestampIndex] * 1000);
          const metrics = computeVolatilityMetrics(completedHistory);
          if (!metrics) {
            return ['MOVE', unavailableRow({ ...sourceMeta, asOf: completedAsOf, error: 'insufficient_history' })];
          }
          return ['MOVE', historicalRow(metrics, { ...sourceMeta, asOf: completedAsOf })];
        }

        return ['MOVE', unavailableRow({
          ...sourceMeta,
          freshness: 'stale',
          asOf,
          error: 'stale_quote',
        })];
      }

      if (quoteDate !== expectedCompletedSession) {
        return ['MOVE', unavailableRow({
          ...sourceMeta,
          freshness: 'stale',
          asOf,
          error: 'stale_quote',
        })];
      }

      if (!validatePriorSession(history.filter((row) => row.date !== quoteDate), quoteDate)) {
        return ['MOVE', unavailableRow({ ...sourceMeta, asOf, error: 'incomplete_history' })];
      }
      const metrics = computeVolatilityMetrics(combineCurrentQuote(history, asOf, currentPrice));
      if (!metrics) return ['MOVE', unavailableRow({ ...sourceMeta, asOf, error: 'insufficient_history' })];
      return ['MOVE', historicalRow(metrics, { ...sourceMeta, asOf })];
    } catch (error) {
      logger.warn?.(`[volatility-snapshot] MOVE unavailable: ${error.message}`);
      return ['MOVE', unavailableRow({ ...sourceMeta, error: 'provider_error' })];
    }
  }

  async function fetchSnapshot() {
    const generatedAt = now();
    const entries = await Promise.all([
      ...CBOE_SERIES.map(fetchCboeSeries),
      fetchMoveSeries(),
    ]);
    const snapshot = Object.fromEntries(entries);
    const currentRows = entries
      .map(([, row]) => row)
      .filter((row) => row.availability === 'available' && row.freshness === 'current');
    const historicalRows = entries
      .map(([, row]) => row)
      .filter((row) => row.availability === 'historical' && row.freshness === 'historical');
    const displayableRows = [...currentRows, ...historicalRows];
    const lastUpdatedRows = currentRows.length > 0 ? currentRows : historicalRows;
    const lastUpdated = lastUpdatedRows
      .map((row) => new Date(row.asOf))
      .filter((date) => !Number.isNaN(date.getTime()))
      .sort((left, right) => left - right)[0] || null;
    const status = currentRows.length === entries.length
      ? 'ok'
      : displayableRows.length > 0
        ? 'partial'
        : 'unavailable';

    return {
      status,
      generatedAt: generatedAt.toISOString(),
      lastUpdated: lastUpdated?.toISOString() ?? null,
      ...snapshot,
    };
  }

  return { fetchSnapshot };
}

module.exports = {
  CBOE_SERIES,
  addCalendarDays,
  combineCurrentQuote,
  computeVolatilityMetrics,
  createVolatilitySnapshotService,
  isTradingDateKey,
  isUsMarketOpen,
  mostRecentCompletedTradingDateKey,
  parseCboeAsOf,
  parseCboeHistoryCsv,
  percentageChange,
  previousTradingDateKey,
  quoteFreshness,
};
