const CORRELATION_WINDOWS = Object.freeze([
  Object.freeze({ key: '5D', sessions: 5 }),
  Object.freeze({ key: '15D', sessions: 15 }),
  Object.freeze({ key: '30D', sessions: 30 }),
  Object.freeze({ key: '1M', sessions: 21 }),
  Object.freeze({ key: '3M', sessions: 63 }),
  Object.freeze({ key: '6M', sessions: 126 }),
]);
const LEGACY_CORRELATION_WINDOWS = Object.freeze([
  Object.freeze({ key: '90D', sessions: 90 }),
  Object.freeze({ key: '120D', sessions: 120 }),
  Object.freeze({ key: '180D', sessions: 180 }),
]);
const OUTPUT_CORRELATION_WINDOWS = Object.freeze([
  ...CORRELATION_WINDOWS,
  ...LEGACY_CORRELATION_WINDOWS,
]);
const ROLLING_WINDOW = 30;
const ROLLING_SAMPLE_COUNT = 252;
const REQUIRED_ROLLING_RETURNS = ROLLING_WINDOW + ROLLING_SAMPLE_COUNT - 1;
const DEFAULT_MAX_STALE_DAYS = 5;

const REQUIRED_SYMBOLS = ['DXY', 'SPX', 'BRENT', 'CRB', 'GOLD', 'BTC'];
const METRIC_SYMBOLS = REQUIRED_SYMBOLS.filter((symbol) => symbol !== 'DXY');

class UsdCorrelationDataError extends Error {
  constructor(message, code = 'USD_CORRELATION_DATA_UNAVAILABLE') {
    super(message);
    this.name = 'UsdCorrelationDataError';
    this.code = code;
  }
}

function round(value, decimals = 3) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function dateKeyFromRow(row) {
  if (row?.date) return String(row.date).slice(0, 10);
  const raw = row?.t ?? row?.timestamp;
  if (raw == null) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function completedDailyBarCutoff(now = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(now).map((part) => [part.type, part.value]),
  );
  const marketDate = `${parts.year}-${parts.month}-${parts.day}`;
  if (Number(parts.hour) >= 17) return marketDate;

  const previous = new Date(`${marketDate}T12:00:00Z`);
  previous.setUTCDate(previous.getUTCDate() - 1);
  return previous.toISOString().slice(0, 10);
}

function normalizeHistory(history = [], cutoffDate = null) {
  const byDate = new Map();
  for (const row of Array.isArray(history) ? history : []) {
    const date = dateKeyFromRow(row);
    const close = Number(row?.close ?? row?.price);
    if (!date || (cutoffDate && date > cutoffDate) || !Number.isFinite(close) || close <= 0) {
      continue;
    }
    byDate.set(date, { date, close });
  }
  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}

function buildReturnsByDate(history = []) {
  const returns = [];
  for (let index = 1; index < history.length; index += 1) {
    const previous = history[index - 1];
    const current = history[index];
    if (!previous || !current || previous.close <= 0 || current.close <= 0) continue;
    const value = Math.log(current.close / previous.close);
    if (Number.isFinite(value)) returns.push({ date: current.date, value });
  }
  return returns;
}

function alignReturns(baseReturns = [], metricReturns = []) {
  const baseByDate = new Map(baseReturns.map((row) => [row.date, row.value]));
  return metricReturns
    .filter((row) => baseByDate.has(row.date))
    .map((row) => ({ date: row.date, base: baseByDate.get(row.date), metric: row.value }));
}

function pearsonCorrelation(pairs = []) {
  if (!Array.isArray(pairs) || pairs.length < 2) return null;
  const meanBase = pairs.reduce((sum, row) => sum + row.base, 0) / pairs.length;
  const meanMetric = pairs.reduce((sum, row) => sum + row.metric, 0) / pairs.length;
  let covariance = 0;
  let baseVariance = 0;
  let metricVariance = 0;
  for (const row of pairs) {
    const baseDelta = row.base - meanBase;
    const metricDelta = row.metric - meanMetric;
    covariance += baseDelta * metricDelta;
    baseVariance += baseDelta * baseDelta;
    metricVariance += metricDelta * metricDelta;
  }
  if (baseVariance <= 0 || metricVariance <= 0) return null;
  return Math.max(-1, Math.min(1, covariance / Math.sqrt(baseVariance * metricVariance)));
}

function correlationForExactWindow(alignedReturns, window) {
  if (!Array.isArray(alignedReturns) || alignedReturns.length < window) return null;
  return pearsonCorrelation(alignedReturns.slice(-window));
}

function buildRollingStats(alignedReturns) {
  if (!Array.isArray(alignedReturns) || alignedReturns.length < REQUIRED_ROLLING_RETURNS) return null;
  const rolling = [];
  for (let end = ROLLING_WINDOW; end <= alignedReturns.length; end += 1) {
    const correlation = pearsonCorrelation(alignedReturns.slice(end - ROLLING_WINDOW, end));
    if (!Number.isFinite(correlation)) return null;
    rolling.push(correlation);
  }
  const latest = rolling.slice(-ROLLING_SAMPLE_COUNT);
  if (latest.length !== ROLLING_SAMPLE_COUNT) return null;
  const positiveCount = latest.filter((value) => value >= 0).length;
  return {
    high: round(Math.max(...latest)),
    low: round(Math.min(...latest)),
    percentPositive: round((positiveCount / latest.length) * 100, 1),
    percentNegative: round(((latest.length - positiveCount) / latest.length) * 100, 1),
  };
}

function assertFreshCalculationDate(calculationDate, now, maxStaleDays) {
  const asOf = new Date(`${calculationDate}T23:59:59.999Z`).getTime();
  const ageMs = now.getTime() - asOf;
  if (!Number.isFinite(asOf) || ageMs > maxStaleDays * 24 * 60 * 60 * 1000) {
    throw new UsdCorrelationDataError(
      `USD correlation source bars are stale (latest completed date: ${calculationDate || 'unknown'})`,
      'USD_CORRELATION_DATA_STALE',
    );
  }
}

function buildUsdCorrelationSnapshot(histories, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const maxStaleDays = Number.isFinite(options.maxStaleDays)
    ? options.maxStaleDays
    : DEFAULT_MAX_STALE_DAYS;
  const cutoffDate = options.cutoffDate || completedDailyBarCutoff(now);

  const normalized = {};
  for (const symbol of REQUIRED_SYMBOLS) {
    normalized[symbol] = normalizeHistory(histories?.[symbol], cutoffDate);
    if (normalized[symbol].length < 2) {
      throw new UsdCorrelationDataError(`No current daily history is available for ${symbol}`);
    }
  }

  const calculationDate = REQUIRED_SYMBOLS
    .map((symbol) => normalized[symbol][normalized[symbol].length - 1].date)
    .sort()[0];
  assertFreshCalculationDate(calculationDate, now, maxStaleDays);

  for (const symbol of REQUIRED_SYMBOLS) {
    normalized[symbol] = normalized[symbol].filter((row) => row.date <= calculationDate);
  }

  const dxyReturns = buildReturnsByDate(normalized.DXY);
  const correlations = {};
  const rollingStats = {};
  for (const symbol of METRIC_SYMBOLS) {
    const aligned = alignReturns(dxyReturns, buildReturnsByDate(normalized[symbol]));
    if (aligned.length < REQUIRED_ROLLING_RETURNS) {
      throw new UsdCorrelationDataError(
        `${symbol} has ${aligned.length} aligned returns; ${REQUIRED_ROLLING_RETURNS} are required`,
        'USD_CORRELATION_INSUFFICIENT_HISTORY',
      );
    }

    correlations[symbol] = {};
    for (const { key, sessions } of OUTPUT_CORRELATION_WINDOWS) {
      const value = correlationForExactWindow(aligned, sessions);
      if (!Number.isFinite(value)) {
        throw new UsdCorrelationDataError(
          `${symbol} ${key} correlation could not be calculated`,
          'USD_CORRELATION_CALCULATION_FAILED',
        );
      }
      correlations[symbol][key] = round(value);
    }

    const stats = buildRollingStats(aligned);
    if (!stats) {
      throw new UsdCorrelationDataError(
        `${symbol} rolling correlation statistics could not be calculated`,
        'USD_CORRELATION_CALCULATION_FAILED',
      );
    }
    rollingStats[symbol] = stats;
  }

  return {
    correlations,
    rollingStats,
    timestamp: now.toISOString(),
    calculationDate,
    source: 'Yahoo Finance daily bars',
    sourceStatus: 'current',
  };
}

module.exports = {
  CORRELATION_WINDOWS,
  LEGACY_CORRELATION_WINDOWS,
  OUTPUT_CORRELATION_WINDOWS,
  ROLLING_SAMPLE_COUNT,
  ROLLING_WINDOW,
  REQUIRED_ROLLING_RETURNS,
  REQUIRED_SYMBOLS,
  UsdCorrelationDataError,
  alignReturns,
  buildReturnsByDate,
  buildRollingStats,
  buildUsdCorrelationSnapshot,
  completedDailyBarCutoff,
  correlationForExactWindow,
  normalizeHistory,
  pearsonCorrelation,
};
