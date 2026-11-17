const { zonedTimeToUtc } = require('date-fns-tz');
const fs = require('fs');
const path = require('path');
const VOLATILITY_FRESHNESS = require('../constants/volatilityFreshness.json');
const {
  addCalendarDays,
  isTradingDateKey,
  previousTradingDateKey,
  usEquityCloseMinutes,
} = require('../utils/usEquityMarketCalendar.cjs');
const {
  PERIOD_START_REFERENCE_MAX_GAP_MS,
  calendarMonthsBefore,
} = require('../utils/marketPeriodReturns.cjs');

const NEW_YORK_TIME_ZONE = 'America/New_York';
const NEW_YORK_PARTS_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: NEW_YORK_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
const CBOE_HISTORY_CACHE_TTL_MS = 15 * 60 * 1000;
// Cboe's index dashboards publish quotes and daily history on cdn-api.
// The legacy cdn hostname still returns HTTP 200 with frozen observations.
const CBOE_API_BASE_URL = 'https://cdn-api.cboe.com';
const CBOE_MAX_QUOTE_AGE_MS = Number(VOLATILITY_FRESHNESS.maxAgeMs);
const PROVIDER_REQUEST_ATTEMPTS = 2;
const REFERENCE_FILE_PATH = path.join(__dirname, '../../data/volatility-reference/last-verified-v1.json');
const REJECTED_EVIDENCE_FLAGS = ['mock', 'isMock', 'seed', 'seeded', 'isSeed', 'isSeeded',
  'synthetic', 'inferred', 'cacheOnly', 'fromCache', 'stale', 'isStale', 'offline', 'disconnected'];

function hasRejectedEvidence(value) {
  return Boolean(value && (
    REJECTED_EVIDENCE_FLAGS.some((flag) => value[flag] === true)
    || value.connected === false
    || ['source', 'providerStatus', 'dataType', 'cacheStatus'].some((key) => (
      /(?:^|[\s_-])(mock|seed(?:ed)?|synthetic|inferred|cache(?:d)?|offline|disconnected|error)(?:$|[\s_-])/i
        .test(String(value[key] || ''))
    ))
  ));
}

const CBOE_SERIES = [
  { name: 'VIX', symbol: 'VIX' },
  { name: 'VVIX', symbol: 'VVIX' },
  { name: 'RVX', symbol: 'RVX' },
  { name: 'NazVol', symbol: 'VXN' },
  { name: 'VXEEM', symbol: 'VXEEM' },
  { name: 'GVZ', symbol: 'GVZ' },
  { name: 'OVX', symbol: 'OVX' },
  { name: 'BITVX', symbol: 'BITVX' },
];

const NUMERIC_FIELDS = [
  'lastPx',
  'day1Ago',
  'day15Ago',
  'week1Ago',
  'week4Ago',
  'month3Ago',
  'month6Ago',
  'priorYearClose',
  'dayChangePct',
  'fifteenDayChangePct',
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

function isRetryableProviderError(error) {
  const status = Number(error?.response?.status);
  if (Number.isFinite(status)) return status === 408 || status === 429 || status >= 500;
  const code = String(error?.code || '').trim().toUpperCase();
  if (['ECONNABORTED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT'].includes(code)) {
    return true;
  }
  // Axios transport failures do not carry a response. Retrying once is safe
  // for these idempotent provider GETs and prevents a single CDN hiccup from
  // becoming an unavailable dashboard row.
  return !error?.response;
}

async function providerGet(client, url, config, attempts = PROVIDER_REQUEST_ATTEMPTS) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await client.get(url, config);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isRetryableProviderError(error)) throw error;
    }
  }
  throw lastError;
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
  const parts = Object.fromEntries(NEW_YORK_PARTS_FORMATTER.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

// Cboe's index session runs 15 minutes past the cash close, early closes included.
const indexSessionCloseMinutes = (dateKey) => usEquityCloseMinutes(dateKey) + 15;

function isUsMarketOpen(now) {
  const parts = newYorkParts(now);
  if (!isTradingDateKey(parts.dateKey)) return false;
  const minutes = (parts.hour * 60) + parts.minute;
  return minutes >= (9 * 60 + 30) && minutes < indexSessionCloseMinutes(parts.dateKey);
}

function mostRecentCompletedTradingDateKey(now) {
  const parts = newYorkParts(now);
  if (!isTradingDateKey(parts.dateKey)) {
    let candidate = parts.dateKey;
    while (!isTradingDateKey(candidate)) candidate = addCalendarDays(candidate, -1);
    return candidate;
  }
  const minutes = (parts.hour * 60) + parts.minute;
  return minutes >= indexSessionCloseMinutes(parts.dateKey) ? parts.dateKey : previousTradingDateKey(parts.dateKey);
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
  // The last close on or before the same calendar date `months` earlier: the
  // rule the market overview uses, and how Hedgeye states monthly changes.
  const currentTime = Date.parse(`${currentRow.date}T00:00:00Z`);
  const monthsAgo = (months) => {
    const target = calendarMonthsBefore(currentTime, months);
    const targetDate = new Date(target).toISOString().slice(0, 10);
    let match = null;
    for (const row of normalized) {
      if (row.date > targetDate) break;
      match = row;
    }
    if (!match) return null;
    return target - Date.parse(`${match.date}T00:00:00Z`) <= PERIOD_START_REFERENCE_MAX_GAP_MS ? match : null;
  };
  const priorYearClose = [...normalized]
    .reverse()
    .find((row) => row.date < `${currentRow.date.slice(0, 4)}-01-01`) || null;

  const day = reference(1);
  const fifteenDay = reference(15);
  // Five sessions, which is a calendar week except in a holiday week. The
  // prediction sizing thresholds read this value, so it is left as it is.
  const week = reference(5);
  const month = monthsAgo(1);
  const threeMonth = monthsAgo(3);
  const sixMonth = monthsAgo(6);

  return {
    lastPx: currentRow.close,
    day1Ago: day?.close ?? null,
    day15Ago: fifteenDay?.close ?? null,
    week1Ago: week?.close ?? null,
    week4Ago: month?.close ?? null,
    month3Ago: threeMonth?.close ?? null,
    month6Ago: sixMonth?.close ?? null,
    priorYearClose: priorYearClose?.close ?? null,
    dayChangePct: percentageChange(currentRow.close, day?.close),
    fifteenDayChangePct: percentageChange(currentRow.close, fifteenDay?.close),
    weekChangePct: percentageChange(currentRow.close, week?.close),
    monthChangePct: percentageChange(currentRow.close, month?.close),
    threeMonthChangePct: percentageChange(currentRow.close, threeMonth?.close),
    sixMonthChangePct: percentageChange(currentRow.close, sixMonth?.close),
    ytdChangePct: percentageChange(currentRow.close, priorYearClose?.close),
  };
}

function unavailableRow({
  source,
  sourceLabel,
  quoteMode,
  freshness = 'defective',
  asOf = null,
  error = null,
  retryable = null,
}) {
  return {
    ...Object.fromEntries(NUMERIC_FIELDS.map((field) => [field, null])),
    source,
    sourceLabel,
    quoteMode,
    asOf: asOf instanceof Date && !Number.isNaN(asOf.getTime()) ? asOf.toISOString() : null,
    availability: 'unavailable',
    freshness,
    ...(error ? { error } : {}),
    ...(typeof retryable === 'boolean' ? { retryable } : {}),
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

// Overview reference evidence does not expire. It retains the provider's exact
// observation date/time and can never become an executable quote on a refresh.
function referenceRow(row, reason) {
  const { retainedUntil, ...observation } = row;
  return {
    ...observation,
    availability: 'reference',
    freshness: 'refresh-delayed',
    refreshDelayed: true,
    displayDelayed: true,
    displayOnly: true,
    executable: false,
    lastVerifiedAt: row.asOf,
    retentionReason: reason,
  };
}

function isVerifiedRow(name, row, currentTime) {
  if (!row || hasRejectedEvidence(row)) return false;
  const expectedSource = name === 'MOVE' ? 'yahoo' : 'cboe';
  const observedAt = Date.parse(String(row.asOf || ''));
  return row.source === expectedSource
    && finitePositive(row.lastPx) != null
    && Number.isFinite(observedAt)
    && observedAt <= currentTime + 5 * 60 * 1000
    && (row.availability === 'available' && row.freshness === 'current'
      || row.availability === 'historical' && row.freshness === 'historical'
      || row.availability === 'reference' && row.freshness === 'refresh-delayed'
        && row.displayOnly === true && row.executable === false);
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
  referenceFilePath = REFERENCE_FILE_PATH,
} = {}) {
  const client = httpClient || require('axios');
  const historyCache = new Map();
  const verifiedRows = new Map();
  let inFlightSnapshot = null;
  let referenceWritePending = false;

  if (referenceFilePath) {
    try {
      const stored = JSON.parse(fs.readFileSync(referenceFilePath, 'utf8'));
      if (stored.schemaVersion === 1) {
        [...CBOE_SERIES.map(({ name }) => name), 'MOVE'].forEach((name) => {
          if (isVerifiedRow(name, stored.rows?.[name], now().getTime())) {
            verifiedRows.set(name, stored.rows[name]);
          }
        });
      }
    } catch (error) {
      if (error.code !== 'ENOENT') logger.warn?.(`[volatility-snapshot] reference read failed: ${error.message}`);
    }
  }

  function reconcileRows(entries) {
    let changed = false;
    const reconciled = entries.map(([name, incoming]) => {
      const stored = verifiedRows.get(name);
      const incomingVerified = isVerifiedRow(name, incoming, now().getTime());
      if (stored && incoming.historyUnavailable) {
        return [name, referenceRow(stored, 'history_refresh_unavailable')];
      }
      if (incomingVerified && (!stored || Date.parse(incoming.asOf) >= Date.parse(stored.asOf))) {
        // A truncated history response cannot revoke independently verified
        // periods for the exact same observation. A revised price must instead
        // keep only its own calculated periods to avoid combining observations.
        const row = { ...incoming };
        if (stored && stored.asOf === incoming.asOf && stored.source === incoming.source
          && stored.lastPx === incoming.lastPx) {
          NUMERIC_FIELDS.forEach((field) => {
            if (row[field] == null && Number.isFinite(stored[field])) row[field] = stored[field];
          });
        }
        if (JSON.stringify(stored) !== JSON.stringify(row)) {
          verifiedRows.set(name, row);
          changed = true;
        }
        return [name, row];
      }
      return [name, stored ? referenceRow(stored,
        incomingVerified ? 'older_provider_observation' : incoming.error || 'provider_refresh_unavailable') : incoming];
    });
    referenceWritePending ||= changed;
    if (referenceWritePending && referenceFilePath) {
      try {
        fs.mkdirSync(path.dirname(referenceFilePath), { recursive: true, mode: 0o700 });
        const temporaryPath = `${referenceFilePath}.${process.pid}.tmp`;
        fs.writeFileSync(temporaryPath, JSON.stringify({ schemaVersion: 1, rows: Object.fromEntries(verifiedRows) }), { mode: 0o600 });
        fs.renameSync(temporaryPath, referenceFilePath);
        referenceWritePending = false;
      } catch (error) {
        logger.warn?.(`[volatility-snapshot] reference write failed: ${error.message}`);
      }
    }
    return reconciled;
  }

  async function fetchCboeHistory(symbol) {
    const currentTime = now().getTime();
    const cached = historyCache.get(symbol);
    if (cached && currentTime - cached.cachedAt < historyCacheTtlMs) return cached.rows;

    const url = `${CBOE_API_BASE_URL}/api/global/us_indices/daily_prices/${symbol}_History.csv`;
    const response = await providerGet(client, url, {
      responseType: 'text',
      timeout: 12000,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    const rows = parseCboeHistoryCsv(response.data);
    if (rows.length === 0) throw new Error(`${symbol} history is empty or invalid`);
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
      const [quoteResult, historyResult] = await Promise.allSettled([
        providerGet(client, `${CBOE_API_BASE_URL}/api/global/delayed_quotes/quotes/_${symbol}.json`, {
          timeout: 12000,
          headers: { 'User-Agent': 'Mozilla/5.0' },
        }),
        fetchCboeHistory(symbol),
      ]);
      const history = historyResult.status === 'fulfilled'
        ? historyResult.value : historyCache.get(symbol)?.rows || [];
      const historicalReference = () => {
        const completedSession = mostRecentCompletedTradingDateKey(now());
        const completedRows = history.filter((row) => row.date <= completedSession);
        if (completedRows.length === 0) return null;
        const metrics = computeVolatilityMetrics(completedRows)
          || { ...Object.fromEntries(NUMERIC_FIELDS.map((field) => [field, null])), lastPx: completedRows.at(-1).close };
        const date = completedRows.at(-1).date;
        return referenceRow({ ...metrics, ...sourceMeta, asOf: date,
          asOfPrecision: 'date', marketSessionDate: date, quoteMode: 'end-of-day' }, 'provider_refresh_unavailable');
      };
      if (quoteResult.status === 'rejected') {
        return [name, historicalReference() || unavailableRow({ ...sourceMeta,
          error: 'provider_error', retryable: isRetryableProviderError(quoteResult.reason) })];
      }
      const payload = quoteResult.value.data || {};
      const quote = payload.data || {};
      const currentPrice = finitePositive(quote.current_price);
      const asOf = parseCboeAsOf(quote.last_trade_time, payload.timestamp);
      const freshness = quoteFreshness(asOf, now(), CBOE_MAX_QUOTE_AGE_MS);
      if (currentPrice == null || !asOf || freshness === 'defective'
        || hasRejectedEvidence(payload) || hasRejectedEvidence(quote)) {
        return [name, historicalReference() || unavailableRow({
          ...sourceMeta,
          freshness,
          asOf,
          error: currentPrice == null ? 'invalid_quote' : 'stale_quote',
        })];
      }
      const quoteDate = newYorkParts(asOf).dateKey;
      // Future daily rows must not overwrite an older provider quote or inherit
      // that quote's timestamp. Every calculated period stays on its own date.
      const quoteHistory = history.filter((row) => row.date <= quoteDate);
      const metrics = computeVolatilityMetrics(combineCurrentQuote(quoteHistory, asOf, currentPrice))
        || { ...Object.fromEntries(NUMERIC_FIELDS.map((field) => [field, null])), lastPx: currentPrice };
      if (!validatePriorSession(quoteHistory, quoteDate)) {
        NUMERIC_FIELDS.filter((field) => field !== 'lastPx').forEach((field) => { metrics[field] = null; });
      }
      const row = availableRow(metrics, { ...sourceMeta, asOf });
      if (historyResult.status === 'rejected' || !validatePriorSession(quoteHistory, quoteDate)) {
        row.historyUnavailable = true;
      }
      if (freshness === 'current') return [name, row];
      const historical = historicalReference();
      return [name, historical && Date.parse(historical.asOf) > asOf.getTime()
        ? historical : referenceRow(row, 'observation_aged')];
    } catch (error) {
      logger.warn?.(`[volatility-snapshot] ${name} unavailable: ${error.message}`);
      return [name, unavailableRow({
        ...sourceMeta,
        error: 'provider_error',
        retryable: isRetryableProviderError(error),
      })];
    }
  }

  async function fetchMoveSeries() {
    const sourceMeta = {
      source: 'yahoo',
      sourceLabel: 'Yahoo Finance',
      quoteMode: 'end-of-day',
    };
    try {
      const response = await providerGet(
        client,
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
      if (!result || [response.data, result, meta].some(hasRejectedEvidence)) {
        return ['MOVE', unavailableRow({
          ...sourceMeta,
          error: 'invalid_quote',
        })];
      }

      const currentTime = now();
      const expectedCompletedSession = mostRecentCompletedTradingDateKey(currentTime);
      const history = normalizeRows(timestamps.map((timestamp, index) => {
        const timestampDate = new Date(Number(timestamp) * 1000);
        if (Number.isNaN(timestampDate.getTime())) return null;
        return {
          date: newYorkParts(timestampDate).dateKey,
          close: closes[index],
        };
      }));

      const latestVerifiedHistoricalRow = () => {
        const eligibleHistory = history.filter((row) => row.date <= expectedCompletedSession);
        const retainedRow = [...eligibleHistory]
          .reverse()
          .find((row) => validatePriorSession(eligibleHistory, row.date));
        if (!retainedRow) return null;

        const retainedTimestampIndex = timestamps.findLastIndex((timestamp, index) => {
          const timestampDate = new Date(Number(timestamp) * 1000);
          return !Number.isNaN(timestampDate.getTime())
            && newYorkParts(timestampDate).dateKey === retainedRow.date
            && finitePositive(closes[index]) != null;
        });
        if (retainedTimestampIndex < 0) return null;

        const retainedAsOf = new Date(Number(timestamps[retainedTimestampIndex]) * 1000);
        const retainedHistory = eligibleHistory.filter((row) => row.date <= retainedRow.date);
        const metrics = computeVolatilityMetrics(retainedHistory);
        if (!metrics) return null;
        return historicalRow(metrics, { ...sourceMeta, asOf: retainedAsOf });
      };

      const retainVerifiedOrUnavailable = (options) => (
        ['MOVE', latestVerifiedHistoricalRow() || unavailableRow({ ...sourceMeta, ...options })]
      );

      if (currentPrice == null || !asOf || Number.isNaN(asOf.getTime())) {
        return retainVerifiedOrUnavailable({ asOf, error: 'invalid_quote' });
      }

      const quoteDate = newYorkParts(asOf).dateKey;

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
          return retainVerifiedOrUnavailable({ asOf: completedAsOf, error: 'insufficient_history' });
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
            return retainVerifiedOrUnavailable({ asOf, error: 'incomplete_history' });
          }
          const completedAsOf = new Date(timestamps[completedTimestampIndex] * 1000);
          const metrics = computeVolatilityMetrics(completedHistory);
          if (!metrics) {
            return retainVerifiedOrUnavailable({ asOf: completedAsOf, error: 'insufficient_history' });
          }
          return ['MOVE', historicalRow(metrics, { ...sourceMeta, asOf: completedAsOf })];
        }

        return retainVerifiedOrUnavailable({
          freshness: 'stale',
          asOf,
          error: 'stale_quote',
        });
      }

      if (quoteDate !== expectedCompletedSession) {
        return retainVerifiedOrUnavailable({
          freshness: 'stale',
          asOf,
          error: 'stale_quote',
        });
      }

      if (!validatePriorSession(history.filter((row) => row.date !== quoteDate), quoteDate)) {
        return retainVerifiedOrUnavailable({ asOf, error: 'incomplete_history' });
      }
      const metrics = computeVolatilityMetrics(combineCurrentQuote(history, asOf, currentPrice));
      if (!metrics) return ['MOVE', unavailableRow({ ...sourceMeta, asOf, error: 'insufficient_history' })];
      return ['MOVE', historicalRow(metrics, { ...sourceMeta, asOf })];
    } catch (error) {
      logger.warn?.(`[volatility-snapshot] MOVE unavailable: ${error.message}`);
      return ['MOVE', unavailableRow({
        ...sourceMeta,
        error: 'provider_error',
        retryable: isRetryableProviderError(error),
      })];
    }
  }

  async function buildSnapshot() {
    const generatedAt = now();
    const entries = reconcileRows(await Promise.all([
      ...CBOE_SERIES.map(fetchCboeSeries),
      fetchMoveSeries(),
    ]));
    const snapshot = Object.fromEntries(entries);
    const currentRows = entries
      .map(([, row]) => row)
      .filter((row) => row.availability === 'available' && row.freshness === 'current');
    const historicalRows = entries
      .map(([, row]) => row)
      .filter((row) => row.availability === 'historical' && row.freshness === 'historical');
    const referenceRows = entries.map(([, row]) => row).filter((row) => row.availability === 'reference');
    const displayableRows = [...currentRows, ...historicalRows, ...referenceRows];
    const lastUpdatedRows = currentRows.length > 0
      ? currentRows
      : [...historicalRows, ...referenceRows];
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
      // The client uses this to distinguish a fresh after-hours fetch from a
      // live-session quote that has aged past the intraday freshness window.
      marketSession: isUsMarketOpen(generatedAt) ? 'open' : 'closed',
      lastUpdated: lastUpdated?.toISOString() ?? null,
      ...snapshot,
    };
  }

  function fetchSnapshot() {
    if (inFlightSnapshot) return inFlightSnapshot;
    inFlightSnapshot = buildSnapshot().finally(() => {
      inFlightSnapshot = null;
    });
    return inFlightSnapshot;
  }

  // Additional Cboe indices for other consumers (e.g. the prediction setup board's VXSLV); the
  // dashboard snapshot roster above is unchanged.
  async function fetchCboeRows(series) {
    return Object.fromEntries(await Promise.all(series.map(fetchCboeSeries)));
  }

  return { fetchSnapshot, fetchCboeRows };
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
