const ANNUALIZATION_EQUITY = 252;
const ANNUALIZATION_CRYPTO = 365;
const WINDOW_63 = 63;
const WINDOW_252 = 252;
const WINDOW_3Y = 756; // ~3 * 252 trading sessions
const WINDOW_5Y = 1260;
const WINDOW_10Y = 2520;
const MIN_OBSERVATIONS = 63;
const SPIKE_RATIO = 1.5;

function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function round(value, decimals = 6) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function resolveAnnualizationFactor(assetType) {
  const normalized = String(assetType || '').trim().toLowerCase();
  if (
    normalized === 'crypto'
    || normalized === 'cryptocurrency'
    || normalized === 'cryptocurrencies'
  ) {
    return ANNUALIZATION_CRYPTO;
  }
  return ANNUALIZATION_EQUITY;
}

/**
 * Normalize price bars to chronological { date, close } using adjusted close
 * when present. Invalid/missing prices are dropped.
 */
function normalizePriceSeries(bars = []) {
  const byDate = new Map();
  (Array.isArray(bars) ? bars : []).forEach((row) => {
    let date = null;
    if (row?.date) {
      const parsed = new Date(String(row.date));
      if (!Number.isNaN(parsed.getTime())) date = parsed.toISOString().slice(0, 10);
    } else if (row?.t != null || row?.timestamp != null) {
      const raw = Number(row.t ?? row.timestamp);
      const ms = raw < 10_000_000_000 ? raw * 1000 : raw;
      const parsed = new Date(ms);
      if (!Number.isNaN(parsed.getTime())) date = parsed.toISOString().slice(0, 10);
    }
    const close = finitePositive(
      row?.adjustedClose ?? row?.adjClose ?? row?.close ?? row?.price,
    );
    if (date && close != null) byDate.set(date, { date, close });
  });
  return [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date));
}

function buildLogReturns(series) {
  const rows = Array.isArray(series) ? series : [];
  const returns = [];
  for (let index = 1; index < rows.length; index += 1) {
    const prior = finitePositive(rows[index - 1]?.close);
    const current = finitePositive(rows[index]?.close);
    if (prior == null || current == null) continue;
    returns.push({
      date: rows[index].date,
      value: Math.log(current / prior),
    });
  }
  return returns;
}

function sampleStdev(values) {
  if (!Array.isArray(values) || values.length < 2) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + ((value - mean) ** 2), 0)
    / (values.length - 1);
  if (!(variance > 0)) return null;
  return Math.sqrt(variance);
}

function annualizeStdev(stdev, annualizationFactor) {
  if (!Number.isFinite(stdev) || stdev <= 0) return null;
  if (!Number.isFinite(annualizationFactor) || annualizationFactor <= 0) return null;
  return stdev * Math.sqrt(annualizationFactor);
}

/**
 * Trailing window annualized realized vol from the end of the log-return series.
 * Requires `window` log-return observations (so at least window+1 prices upstream).
 */
function trailingAnnualizedVol(logReturns, window, annualizationFactor) {
  if (!Array.isArray(logReturns) || logReturns.length < window || window < 2) {
    return null;
  }
  const slice = logReturns.slice(-window);
  const stdev = sampleStdev(slice.map((row) => row.value));
  const annualized = annualizeStdev(stdev, annualizationFactor);
  if (annualized == null) return null;
  return {
    value: round(annualized, 6),
    asOf: slice[slice.length - 1]?.date || null,
    observations: slice.length,
    window,
  };
}

/**
 * Rolling series of annualized vol for charting (one point per end date).
 */
function rollingAnnualizedVolSeries(logReturns, window, annualizationFactor) {
  if (!Array.isArray(logReturns) || logReturns.length < window || window < 2) return [];
  const out = [];
  for (let end = window; end <= logReturns.length; end += 1) {
    const slice = logReturns.slice(end - window, end);
    const stdev = sampleStdev(slice.map((row) => row.value));
    const annualized = annualizeStdev(stdev, annualizationFactor);
    if (annualized == null) continue;
    out.push({
      date: slice[slice.length - 1].date,
      value: round(annualized, 6),
    });
  }
  return out;
}

function buildRealizedVolatilitySnapshot(bars, {
  assetType = 'equity',
  includeLongWindows = true,
} = {}) {
  const annualizationFactor = resolveAnnualizationFactor(assetType);
  const series = normalizePriceSeries(bars);
  const logReturns = buildLogReturns(series);
  const asOf = series.at(-1)?.date || null;
  const observationCount = logReturns.length;

  if (observationCount < MIN_OBSERVATIONS) {
    return {
      status: 'unavailable',
      reason: 'insufficient_data',
      annualizationFactor,
      observationCount,
      asOf,
      rv63: null,
      rv252: null,
      rv3y: null,
      rv5y: null,
      rv10y: null,
      sizingVol: null,
      limitedHistory: true,
      spikeWarning: false,
      warnings: ['Insufficient price history for a volatility estimate (need at least 63 returns).'],
    };
  }

  const rv63 = trailingAnnualizedVol(logReturns, WINDOW_63, annualizationFactor);
  const rv252 = observationCount >= WINDOW_252
    ? trailingAnnualizedVol(logReturns, WINDOW_252, annualizationFactor)
    : null;
  const rv3y = includeLongWindows && observationCount >= WINDOW_3Y
    ? trailingAnnualizedVol(logReturns, WINDOW_3Y, annualizationFactor)
    : (includeLongWindows && observationCount > WINDOW_252
      ? trailingAnnualizedVol(logReturns, observationCount, annualizationFactor)
      : null);
  const rv5y = includeLongWindows && observationCount >= WINDOW_5Y
    ? trailingAnnualizedVol(logReturns, WINDOW_5Y, annualizationFactor)
    : null;
  const rv10y = includeLongWindows && observationCount >= WINDOW_10Y
    ? trailingAnnualizedVol(logReturns, WINDOW_10Y, annualizationFactor)
    : null;

  const limitedHistory = observationCount < WINDOW_252;
  const warnings = [];
  if (limitedHistory) {
    warnings.push('Limited history: fewer than 252 returns; sizing uses available history with a conservative warning.');
  }

  let sizingVol = null;
  if (rv63 && rv252) {
    sizingVol = {
      value: Math.max(rv63.value, rv252.value),
      asOf: rv63.asOf || rv252.asOf,
      components: { rv63: rv63.value, rv252: rv252.value },
    };
  } else if (rv63 && limitedHistory) {
    sizingVol = {
      value: rv63.value,
      asOf: rv63.asOf,
      components: { rv63: rv63.value, rv252: null },
    };
  }

  const spikeWarning = Boolean(
    rv63
    && rv252
    && Number.isFinite(rv63.value)
    && Number.isFinite(rv252.value)
    && rv252.value > 0
    && rv63.value > SPIKE_RATIO * rv252.value,
  );
  if (spikeWarning) {
    warnings.push('Recent 63-day vol is more than 1.5× the 1-year vol.');
  }

  return {
    status: sizingVol ? 'available' : 'unavailable',
    reason: sizingVol ? null : 'insufficient_data',
    annualizationFactor,
    observationCount,
    asOf,
    rv63: rv63 ? rv63.value : null,
    rv252: rv252 ? rv252.value : null,
    rv3y: rv3y ? rv3y.value : null,
    rv5y: rv5y ? rv5y.value : null,
    rv10y: rv10y ? rv10y.value : null,
    sizingVol: sizingVol ? round(sizingVol.value, 6) : null,
    sizingVolDetail: sizingVol,
    limitedHistory,
    spikeWarning,
    warnings,
    rolling63: rollingAnnualizedVolSeries(logReturns, WINDOW_63, annualizationFactor),
    rolling252: observationCount >= WINDOW_252
      ? rollingAnnualizedVolSeries(logReturns, WINDOW_252, annualizationFactor)
      : [],
    priceSeries: series,
  };
}

function resolveSizingVolatility(snapshot, { useRecent63 = true } = {}) {
  if (!snapshot || snapshot.status !== 'available') return null;
  if (!useRecent63) {
    if (Number.isFinite(snapshot.rv252) && snapshot.rv252 > 0) return snapshot.rv252;
    if (Number.isFinite(snapshot.rv63) && snapshot.rv63 > 0) return snapshot.rv63;
    return null;
  }
  return Number.isFinite(snapshot.sizingVol) && snapshot.sizingVol > 0
    ? snapshot.sizingVol
    : null;
}

module.exports = {
  ANNUALIZATION_CRYPTO,
  ANNUALIZATION_EQUITY,
  MIN_OBSERVATIONS,
  SPIKE_RATIO,
  WINDOW_10Y,
  WINDOW_252,
  WINDOW_3Y,
  WINDOW_5Y,
  WINDOW_63,
  annualizeStdev,
  buildLogReturns,
  buildRealizedVolatilitySnapshot,
  normalizePriceSeries,
  resolveAnnualizationFactor,
  resolveSizingVolatility,
  rollingAnnualizedVolSeries,
  sampleStdev,
  trailingAnnualizedVol,
};
