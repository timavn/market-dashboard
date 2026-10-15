const CORRELATION_WINDOWS = Object.freeze([
  Object.freeze({ key: '5D', sessions: 5 }),
  Object.freeze({ key: '15D', sessions: 15 }),
  Object.freeze({ key: '30D', sessions: 30 }),
  Object.freeze({ key: '1M', sessions: 21 }),
  Object.freeze({ key: '3M', sessions: 63 }),
  Object.freeze({ key: '6M', sessions: 126 }),
]);
const LEGACY_CORRELATION_WINDOWS = Object.freeze([
  Object.freeze({ key: '60D', sessions: 60 }),
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
const REQUIRED_ROLLING_OBSERVATIONS = ROLLING_WINDOW + ROLLING_SAMPLE_COUNT - 1;
// Backward-compatible export for callers that imported the old return-oriented name.
const REQUIRED_ROLLING_RETURNS = REQUIRED_ROLLING_OBSERVATIONS;
const DEFAULT_MAX_STALE_DAYS = 5;

const REQUIRED_SYMBOLS = ['DXY', 'SPX', 'NDX', 'WTI', 'BRENT', 'CRB', 'GOLD', 'BTC'];
const OPTIONAL_SYMBOLS = ['SILVER', 'UST2Y', 'UST10Y', 'UST30Y', 'COPPER', 'ETH'];
const METRIC_SYMBOLS = [...REQUIRED_SYMBOLS, ...OPTIONAL_SYMBOLS].filter((symbol) => symbol !== 'DXY');

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

function alignPriceLevels(baseHistory = [], metricHistory = []) {
  const baseByDate = new Map(baseHistory.map((row) => [row.date, row.close]));
  return metricHistory
    .filter((row) => baseByDate.has(row.date))
    .map((row) => ({ date: row.date, base: baseByDate.get(row.date), metric: row.close }));
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

function correlationForExactWindow(alignedLevels, window) {
  if (!Array.isArray(alignedLevels) || alignedLevels.length < window) return null;
  return pearsonCorrelation(alignedLevels.slice(-window));
}

function buildRollingStats(alignedLevels) {
  if (!Array.isArray(alignedLevels) || alignedLevels.length < REQUIRED_ROLLING_OBSERVATIONS) return null;
  const rolling = [];
  for (let end = ROLLING_WINDOW; end <= alignedLevels.length; end += 1) {
    const correlation = pearsonCorrelation(alignedLevels.slice(end - ROLLING_WINDOW, end));
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
  for (const symbol of OPTIONAL_SYMBOLS) {
    // ETH daily candles close at 00:00 UTC, later than the DXY cutoff on
    // U.S. afternoons. Do not turn its still-open candle into a daily return.
    const priorUtcDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1))
      .toISOString().slice(0, 10);
    const completedCutoff = symbol === 'ETH' && priorUtcDay < cutoffDate ? priorUtcDay : cutoffDate;
    const history = normalizeHistory(histories?.[symbol], completedCutoff);
    if (history.length >= 2) normalized[symbol] = history;
  }

  const calculationDate = REQUIRED_SYMBOLS
    .map((symbol) => normalized[symbol][normalized[symbol].length - 1].date)
    .sort()[0];
  assertFreshCalculationDate(calculationDate, now, maxStaleDays);

  for (const symbol of Object.keys(normalized)) {
    normalized[symbol] = normalized[symbol].filter((row) => row.date <= calculationDate);
  }

  const correlations = {};
  const rollingStats = {};
  for (const symbol of METRIC_SYMBOLS) {
    if (!normalized[symbol]) continue;
    const aligned = alignPriceLevels(normalized.DXY, normalized[symbol]);
    // Optional comparisons must reach the same completed session as the matrix.
    // Never label an older series with the required series' newer calculation date.
    if (OPTIONAL_SYMBOLS.includes(symbol) && aligned.at(-1)?.date !== calculationDate) continue;
    if (aligned.length < REQUIRED_ROLLING_OBSERVATIONS) {
      if (OPTIONAL_SYMBOLS.includes(symbol)) continue;
      throw new UsdCorrelationDataError(
        `${symbol} has ${aligned.length} aligned closing levels; ${REQUIRED_ROLLING_OBSERVATIONS} are required`,
        'USD_CORRELATION_INSUFFICIENT_HISTORY',
      );
    }

    correlations[symbol] = {};
    for (const { key, sessions } of OUTPUT_CORRELATION_WINDOWS) {
      const value = correlationForExactWindow(aligned, sessions);
      if (!Number.isFinite(value)) {
        if (OPTIONAL_SYMBOLS.includes(symbol)) {
          delete correlations[symbol];
          break;
        }
        throw new UsdCorrelationDataError(
          `${symbol} ${key} correlation could not be calculated`,
          'USD_CORRELATION_CALCULATION_FAILED',
        );
      }
      correlations[symbol][key] = round(value);
    }
    if (!correlations[symbol]) continue;

    const stats = buildRollingStats(aligned);
    if (!stats) {
      if (OPTIONAL_SYMBOLS.includes(symbol)) {
        delete correlations[symbol];
        continue;
      }
      throw new UsdCorrelationDataError(
        `${symbol} rolling correlation statistics could not be calculated`,
        'USD_CORRELATION_CALCULATION_FAILED',
      );
    }
    rollingStats[symbol] = stats;
  }

  const assetContext = {};
  const dxyRows = normalized.DXY || [];
  const dxyLatest = dxyRows.at(-1) || null;
  const dxyPrevious = dxyRows.at(-2) || null;
  if (dxyLatest?.date === calculationDate && Number.isFinite(dxyLatest.close) && dxyLatest.close > 0) {
    const dxyChange = (sessions) => {
      const reference = dxyRows.at(-(sessions + 1));
      return Number.isFinite(reference?.close) && reference.close > 0
        ? round(((dxyLatest.close / reference.close) - 1) * 100, 4)
        : null;
    };
    assetContext.dxy = {
      status: 'historical',
      availability: 'historical',
      value: round(dxyLatest.close, 4),
      previousClose: Number.isFinite(dxyPrevious?.close) && dxyPrevious.close > 0
        ? round(dxyPrevious.close, 4)
        : null,
      changePercent: dxyChange(1),
      fifteenDayChangePercent: dxyChange(15),
      thirtyDayChangePercent: dxyChange(30),
      asOf: dxyLatest.date,
      source: 'Yahoo Finance completed DXY daily bars',
      decisionEligible: false,
    };
  }
  if (normalized.SILVER) {
    const realized = buildRealizedVolatilitySnapshot(normalized.SILVER, {
      assetType: 'commodity',
      includeLongWindows: false,
      includeSeries: false,
    });
    if (realized.status === 'available' && Number.isFinite(realized.rv21) && realized.rv21 > 0 && realized.asOf) {
      assetContext.silverRealizedVolatility = {
        status: 'historical',
        availability: 'historical',
        value: realized.rv21,
        window: 21,
        annualized: true,
        annualizationFactor: realized.annualizationFactor,
        observations: realized.observationCount,
        asOf: realized.asOf,
        source: 'Yahoo Finance completed Silver futures daily bars',
        decisionEligible: false,
      };
    }
  }
  if (normalized.ETH?.at(-1)?.date === calculationDate) {
    const realized = buildRealizedVolatilitySnapshot(normalized.ETH, {
      assetType: 'crypto', includeLongWindows: false, includeSeries: false,
    });
    if (realized.status === 'available' && Number.isFinite(realized.rv21) && realized.rv21 > 0) {
      assetContext.ethereumRealizedVolatility = {
        status: 'historical', availability: 'historical', value: realized.rv21,
        window: 21, annualized: true, annualizationFactor: realized.annualizationFactor,
        observations: realized.observationCount, asOf: realized.asOf,
        source: 'Yahoo Finance completed ETH-USD daily bars', decisionEligible: false,
      };
    }
  }
  const wtiByDate = new Map((normalized.WTI || []).map((row) => [row.date, row.close]));
  const alignedSpread = (normalized.BRENT || []).filter((row) => wtiByDate.has(row.date));
  const spreadRow = alignedSpread.at(-1) || null;
  if (spreadRow) {
    const wtiClose = wtiByDate.get(spreadRow.date);
    assetContext.brentWtiSpread = {
      status: 'historical',
      availability: 'historical',
      value: round(spreadRow.close - wtiClose, 4),
      brentClose: spreadRow.close,
      wtiClose,
      asOf: spreadRow.date,
      source: 'Yahoo Finance aligned completed Brent and WTI futures daily bars',
      decisionEligible: false,
    };
  }

  return {
    correlations,
    rollingStats,
    assetContext,
    timestamp: now.toISOString(),
    calculationDate,
    source: 'Yahoo Finance daily bars',
    sourceStatus: 'current',
  };
}

module.exports = {
  CORRELATION_WINDOWS,
  DEFAULT_MAX_STALE_DAYS,
  LEGACY_CORRELATION_WINDOWS,
  OUTPUT_CORRELATION_WINDOWS,
  ROLLING_SAMPLE_COUNT,
  ROLLING_WINDOW,
  REQUIRED_ROLLING_OBSERVATIONS,
  REQUIRED_ROLLING_RETURNS,
  REQUIRED_SYMBOLS,
  OPTIONAL_SYMBOLS,
  UsdCorrelationDataError,
  alignPriceLevels,
  buildRollingStats,
  buildUsdCorrelationSnapshot,
  completedDailyBarCutoff,
  correlationForExactWindow,
  normalizeHistory,
  pearsonCorrelation,
};
const { buildRealizedVolatilitySnapshot } = require('./realizedVolatility.cjs');
