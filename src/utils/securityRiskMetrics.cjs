const BETA_WINDOW_RETURNS = 252;
const MIN_BETA_RETURNS = 126;
const ATR_PERIOD = 14;
const DEFAULT_SOURCE = 'Yahoo Finance chart API';

const REASONS = Object.freeze({
  BENCHMARK_UNAVAILABLE: 'benchmark_unavailable',
  HISTORY_UNAVAILABLE: 'history_unavailable',
  INSUFFICIENT_ALIGNED_RETURNS: 'insufficient_aligned_returns',
  INSUFFICIENT_PRICE_HISTORY: 'insufficient_price_history',
  INSUFFICIENT_TRUE_RANGES: 'insufficient_true_ranges',
  INVALID_SYMBOL: 'invalid_symbol',
  UNSUPPORTED_SOURCE: 'unsupported_source',
  ZERO_BENCHMARK_VARIANCE: 'zero_benchmark_variance',
});

function finiteNumber(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function finiteNonZero(value) {
  const parsed = finiteNumber(value);
  return parsed != null && parsed !== 0 ? parsed : null;
}

function round(value, decimals = 6) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function timestampMs(value) {
  if (value == null) return null;
  if (typeof value === 'number' || /^\d+(?:\.\d+)?$/.test(String(value))) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return null;
    return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  }
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function dateKeyFromRow(row) {
  if (row?.date) {
    const parsedDate = new Date(String(row.date));
    if (!Number.isNaN(parsedDate.getTime())) return parsedDate.toISOString().slice(0, 10);
  }
  const parsedTimestamp = timestampMs(row?.timestamp ?? row?.t);
  if (parsedTimestamp == null) return null;
  return new Date(parsedTimestamp).toISOString().slice(0, 10);
}

/**
 * Normalize explicitly adjusted daily price bars. Raw close is never used as a
 * substitute for adjusted close. Raw high/low may only be converted when an
 * explicit adjusted-close/raw-close factor is available on the same bar.
 */
function normalizeAdjustedPriceBars(bars = []) {
  const byDate = new Map();

  for (const row of Array.isArray(bars) ? bars : []) {
    const date = dateKeyFromRow(row);
    if (!date) continue;

    const rawClose = finiteNonZero(row?.rawClose ?? row?.close);
    const adjustedClose = finiteNonZero(row?.adjustedClose ?? row?.adjClose);
    const adjustmentFactor = adjustedClose != null && rawClose != null
      ? adjustedClose / rawClose
      : null;

    let adjustedHigh = finiteNumber(row?.adjustedHigh);
    let adjustedLow = finiteNumber(row?.adjustedLow);
    const rawHigh = finiteNumber(row?.rawHigh ?? row?.high);
    const rawLow = finiteNumber(row?.rawLow ?? row?.low);

    if (adjustedHigh == null && rawHigh != null && adjustmentFactor != null) {
      adjustedHigh = rawHigh * adjustmentFactor;
    }
    if (adjustedLow == null && rawLow != null && adjustmentFactor != null) {
      adjustedLow = rawLow * adjustmentFactor;
    }
    if (adjustedHigh != null && adjustedLow != null && adjustedHigh < adjustedLow) {
      adjustedHigh = null;
      adjustedLow = null;
    }

    const parsedTimestamp = timestampMs(row?.timestamp ?? row?.t);
    byDate.set(date, {
      date,
      timestamp: parsedTimestamp == null
        ? `${date}T00:00:00.000Z`
        : new Date(parsedTimestamp).toISOString(),
      rawClose,
      rawHigh,
      rawLow,
      adjustedClose,
      adjustedHigh: adjustedHigh == null ? null : adjustedHigh,
      adjustedLow: adjustedLow == null ? null : adjustedLow,
    });
  }

  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}

/** Convert a Yahoo chart result into the explicit adjusted-bar contract. */
function parseYahooChartBars(chartResult, { now = Date.now(), dropIncompleteSession = true } = {}) {
  const timestamps = Array.isArray(chartResult?.timestamp) ? chartResult.timestamp : [];
  const quote = chartResult?.indicators?.quote?.[0] || {};
  const adjusted = chartResult?.indicators?.adjclose?.[0]?.adjclose || [];
  const regularSession = chartResult?.meta?.currentTradingPeriod?.regular || {};
  const sessionStart = finiteNumber(regularSession.start);
  const sessionEnd = finiteNumber(regularSession.end);
  const nowMs = timestampMs(now);
  const nowSeconds = nowMs == null ? null : nowMs / 1000;
  const latestTimestamp = finiteNumber(timestamps[timestamps.length - 1]);
  const incompleteLatestSession = dropIncompleteSession
    && latestTimestamp != null
    && sessionStart != null
    && sessionEnd != null
    && nowSeconds != null
    && nowSeconds < sessionEnd
    && latestTimestamp >= sessionStart
    && latestTimestamp < sessionEnd;
  const selectedTimestamps = incompleteLatestSession ? timestamps.slice(0, -1) : timestamps;
  const rows = selectedTimestamps.map((timestamp, index) => ({
    timestamp,
    adjustedClose: adjusted[index],
    close: quote.close?.[index],
    high: quote.high?.[index],
    low: quote.low?.[index],
  }));
  return normalizeAdjustedPriceBars(rows);
}

function buildAdjustedReturns(bars = []) {
  const normalized = normalizeAdjustedPriceBars(bars);
  const returns = [];
  for (let index = 1; index < normalized.length; index += 1) {
    const previous = normalized[index - 1];
    const current = normalized[index];
    if (previous.adjustedClose == null || current.adjustedClose == null) continue;
    const value = (current.adjustedClose / previous.adjustedClose) - 1;
    if (Number.isFinite(value)) returns.push({ date: current.date, value });
  }
  return returns;
}

function unavailableValueMetric({
  source,
  asOf = null,
  observations = 0,
  reason,
  extra = {},
}) {
  return {
    status: 'unavailable',
    value: null,
    source,
    asOf,
    observations,
    reason,
    ...extra,
  };
}

function calculateAlignedBeta(securityBars, benchmarkBars, options = {}) {
  const source = options.source || DEFAULT_SOURCE;
  const benchmark = options.benchmark || 'SPY';
  const windowSessions = Number.isInteger(options.windowSessions)
    ? options.windowSessions
    : BETA_WINDOW_RETURNS;
  const minObservations = Number.isInteger(options.minObservations)
    ? options.minObservations
    : MIN_BETA_RETURNS;
  const common = {
    benchmark,
    returnBasis: 'adjusted-close simple daily returns over adjacent common dates',
    windowSessions,
    minObservations,
  };

  const securityByDate = new Map(
    normalizeAdjustedPriceBars(securityBars)
      .filter((row) => row.adjustedClose != null)
      .map((row) => [row.date, row.adjustedClose]),
  );
  const benchmarkByDate = new Map(
    normalizeAdjustedPriceBars(benchmarkBars)
      .filter((row) => row.adjustedClose != null)
      .map((row) => [row.date, row.adjustedClose]),
  );
  const commonDates = Array.from(securityByDate.keys())
    .filter((date) => benchmarkByDate.has(date))
    .sort();
  const aligned = [];
  for (let index = 1; index < commonDates.length; index += 1) {
    const previousDate = commonDates[index - 1];
    const date = commonDates[index];
    const security = (securityByDate.get(date) / securityByDate.get(previousDate)) - 1;
    const benchmarkReturn = (benchmarkByDate.get(date) / benchmarkByDate.get(previousDate)) - 1;
    if (Number.isFinite(security) && Number.isFinite(benchmarkReturn)) {
      aligned.push({ date, security, benchmark: benchmarkReturn });
    }
  }
  const selected = aligned.slice(-windowSessions);
  const asOf = selected.length > 0 ? selected[selected.length - 1].date : null;

  if (selected.length < minObservations) {
    return unavailableValueMetric({
      source,
      asOf,
      observations: selected.length,
      reason: REASONS.INSUFFICIENT_ALIGNED_RETURNS,
      extra: common,
    });
  }

  const meanSecurity = selected.reduce((sum, row) => sum + row.security, 0) / selected.length;
  const meanBenchmark = selected.reduce((sum, row) => sum + row.benchmark, 0) / selected.length;
  let covariance = 0;
  let benchmarkVariance = 0;
  for (const row of selected) {
    const benchmarkDelta = row.benchmark - meanBenchmark;
    covariance += (row.security - meanSecurity) * benchmarkDelta;
    benchmarkVariance += benchmarkDelta ** 2;
  }

  if (!Number.isFinite(benchmarkVariance) || benchmarkVariance <= 0) {
    return unavailableValueMetric({
      source,
      asOf,
      observations: selected.length,
      reason: REASONS.ZERO_BENCHMARK_VARIANCE,
      extra: common,
    });
  }

  return {
    status: 'available',
    value: round(covariance / benchmarkVariance),
    source,
    asOf,
    observations: selected.length,
    reason: null,
    ...common,
  };
}

function calculateAtr14(bars, options = {}) {
  const source = options.source || DEFAULT_SOURCE;
  const periodSessions = Number.isInteger(options.periodSessions)
    ? options.periodSessions
    : ATR_PERIOD;
  const normalized = normalizeAdjustedPriceBars(bars);
  const trueRanges = [];

  for (let index = 1; index < normalized.length; index += 1) {
    const previous = normalized[index - 1];
    const current = normalized[index];
    if (
      previous.adjustedClose == null
      || current.adjustedHigh == null
      || current.adjustedLow == null
    ) {
      continue;
    }
    const value = Math.max(
      current.adjustedHigh - current.adjustedLow,
      Math.abs(current.adjustedHigh - previous.adjustedClose),
      Math.abs(current.adjustedLow - previous.adjustedClose),
    );
    if (Number.isFinite(value) && value >= 0) {
      trueRanges.push({ date: current.date, value });
    }
  }

  const selected = trueRanges.slice(-periodSessions);
  const asOf = selected.length > 0 ? selected[selected.length - 1].date : null;
  const common = {
    method: 'simple average of true range',
    periodSessions,
    priceBasis: 'adjusted daily high, low, and prior close',
  };
  if (selected.length < periodSessions) {
    return unavailableValueMetric({
      source,
      asOf,
      observations: selected.length,
      reason: REASONS.INSUFFICIENT_TRUE_RANGES,
      extra: common,
    });
  }

  return {
    status: 'available',
    value: round(selected.reduce((sum, row) => sum + row.value, 0) / periodSessions),
    source,
    asOf,
    observations: selected.length,
    reason: null,
    ...common,
  };
}

function calculatePriorAllTimePrices(bars, options = {}) {
  const source = options.source || DEFAULT_SOURCE;
  const normalized = normalizeAdjustedPriceBars(bars);
  const comparisonDate = options.beforeDate
    ? dateKeyFromRow({ date: options.beforeDate })
    : null;
  const priorBars = comparisonDate
    ? normalized.filter((bar) => bar.date < comparisonDate)
    : normalized;
  const highs = priorBars.filter((bar) => bar.rawHigh != null);
  const lows = priorBars.filter((bar) => bar.rawLow != null);
  const asOf = priorBars[priorBars.length - 1]?.date || null;
  const observations = priorBars.length;
  const common = {
    source,
    asOf,
    observations,
    highObservations: highs.length,
    lowObservations: lows.length,
    comparisonBarAsOf: comparisonDate,
    historyRule: comparisonDate ? 'strictly before comparison date' : 'all completed provider bars',
    priceBasis: 'provider daily high and low (not dividend-adjusted)',
    splitHandling: 'provider OHLC as returned; no local split inference or back-adjustment',
  };

  if (highs.length === 0 || lows.length === 0) {
    return {
      status: 'unavailable',
      priorAllTimeHigh: null,
      priorAllTimeLow: null,
      reason: REASONS.INSUFFICIENT_PRICE_HISTORY,
      ...common,
    };
  }

  return {
    status: 'available',
    priorAllTimeHigh: round(Math.max(...highs.map((bar) => bar.rawHigh))),
    priorAllTimeLow: round(Math.min(...lows.map((bar) => bar.rawLow))),
    reason: null,
    ...common,
  };
}

function unavailablePriceStructure(reason = REASONS.INSUFFICIENT_PRICE_HISTORY, extra = {}) {
  return {
    status: 'unavailable',
    reason,
    asOf: null,
    observations: 0,
    score: null,
    highLeg: null,
    lowLeg: null,
    timeline: [],
    priceBasis: 'completed SPX cash-index daily high and low',
    ...extra,
  };
}

function applyStructureLeg(previous, direction, eventCredit) {
  if (direction === 0) {
    return {
      score: previous.score,
      direction: previous.direction,
      appliedCredit: 0,
      reversal: false,
    };
  }
  if (previous.direction != null && previous.direction !== direction) {
    return {
      score: 0,
      direction,
      appliedCredit: 0,
      reversal: true,
    };
  }
  return {
    score: previous.score + eventCredit,
    direction,
    appliedCredit: eventCredit,
    reversal: false,
  };
}

/**
 * Signed, path-dependent SPX price-structure accumulator.
 *
 * Higher highs and higher lows add bullish points; lower highs and lower lows
 * add bearish points. The first move in the opposite direction wipes only that
 * leg to zero while retaining the new direction, so confirmation on the next
 * same-direction session begins accumulating. Strict ATH/ATL extensions add a
 * one-point event bonus, except on a reversal/reset session.
 */
function calculatePriceStructureRun(bars = [], options = {}) {
  const normalized = normalizeAdjustedPriceBars(bars);
  const complete = normalized.filter((bar) => bar.rawHigh != null && bar.rawLow != null);
  if (normalized.length < 2 || complete.length !== normalized.length) {
    return unavailablePriceStructure(REASONS.INSUFFICIENT_PRICE_HISTORY, {
      asOf: normalized[normalized.length - 1]?.date || null,
      observations: normalized.length,
    });
  }

  let priorAllTimeHigh = complete[0].rawHigh;
  let priorAllTimeLow = complete[0].rawLow;
  let allTimeHighDate = complete[0].date;
  let allTimeLowDate = complete[0].date;
  let highState = { score: 0, direction: null };
  let lowState = { score: 0, direction: null };
  const timeline = [];

  for (let index = 1; index < complete.length; index += 1) {
    const previous = complete[index - 1];
    const current = complete[index];
    const highDirection = current.rawHigh > previous.rawHigh
      ? 1
      : current.rawHigh < previous.rawHigh ? -1 : 0;
    const lowDirection = current.rawLow > previous.rawLow
      ? 1
      : current.rawLow < previous.rawLow ? -1 : 0;
    const isAllTimeHigh = highDirection > 0 && current.rawHigh > priorAllTimeHigh;
    const isAllTimeLow = lowDirection < 0 && current.rawLow < priorAllTimeLow;
    const highEventCredit = highDirection > 0 ? 1 + (isAllTimeHigh ? 1 : 0) : highDirection < 0 ? -1 : 0;
    const lowEventCredit = lowDirection > 0 ? 1 : lowDirection < 0 ? -1 - (isAllTimeLow ? 1 : 0) : 0;
    const nextHighState = applyStructureLeg(highState, highDirection, highEventCredit);
    const nextLowState = applyStructureLeg(lowState, lowDirection, lowEventCredit);

    highState = { score: nextHighState.score, direction: nextHighState.direction };
    lowState = { score: nextLowState.score, direction: nextLowState.direction };
    timeline.push({
      date: current.date,
      high: current.rawHigh,
      priorHigh: previous.rawHigh,
      low: current.rawLow,
      priorLow: previous.rawLow,
      highEvent: highDirection > 0 ? (isAllTimeHigh ? 'HH + ATH' : 'HH') : highDirection < 0 ? 'LH' : 'EH',
      lowEvent: lowDirection > 0 ? 'HL' : lowDirection < 0 ? (isAllTimeLow ? 'LL + ATL' : 'LL') : 'EL',
      highEventCredit,
      lowEventCredit,
      highAppliedCredit: nextHighState.appliedCredit,
      lowAppliedCredit: nextLowState.appliedCredit,
      highReversal: nextHighState.reversal,
      lowReversal: nextLowState.reversal,
      highLegScore: highState.score,
      lowLegScore: lowState.score,
      score: highState.score + lowState.score,
      isAllTimeHigh,
      isAllTimeLow,
    });

    if (current.rawHigh > priorAllTimeHigh) {
      priorAllTimeHigh = current.rawHigh;
      allTimeHighDate = current.date;
    }
    if (current.rawLow < priorAllTimeLow) {
      priorAllTimeLow = current.rawLow;
      allTimeLowDate = current.date;
    }
  }

  const latest = timeline[timeline.length - 1];
  return {
    status: 'available',
    reason: null,
    asOf: latest.date,
    observations: complete.length,
    score: latest.score,
    highLeg: {
      score: latest.highLegScore,
      event: latest.highEvent,
      eventCredit: latest.highEventCredit,
      appliedCredit: latest.highAppliedCredit,
      reversal: latest.highReversal,
      value: latest.high,
      previousValue: latest.priorHigh,
      allTimeHigh: latest.isAllTimeHigh,
    },
    lowLeg: {
      score: latest.lowLegScore,
      event: latest.lowEvent,
      eventCredit: latest.lowEventCredit,
      appliedCredit: latest.lowAppliedCredit,
      reversal: latest.lowReversal,
      value: latest.low,
      previousValue: latest.priorLow,
      allTimeLow: latest.isAllTimeLow,
    },
    records: {
      allTimeHigh: priorAllTimeHigh,
      allTimeHighDate,
      allTimeLow: priorAllTimeLow,
      allTimeLowDate,
    },
    timeline: timeline.slice(-(options.timelineLimit || 8)),
    priceBasis: 'completed SPX cash-index daily high and low',
    ruleVersion: 'spx-structure-run-v1',
  };
}

function createUnavailableSecurityRiskMetrics({
  symbol,
  reason = REASONS.HISTORY_UNAVAILABLE,
  source = DEFAULT_SOURCE,
  provenance = {},
} = {}) {
  const normalizedSymbol = String(symbol || '').trim().toUpperCase();
  const beta = unavailableValueMetric({
    source,
    reason,
    extra: {
      benchmark: 'SPY',
      returnBasis: 'adjusted-close simple daily returns over adjacent common dates',
      windowSessions: BETA_WINDOW_RETURNS,
      minObservations: MIN_BETA_RETURNS,
    },
  });
  const atr14 = unavailableValueMetric({
    source,
    reason,
    extra: {
      method: 'simple average of true range',
      periodSessions: ATR_PERIOD,
      priceBasis: 'adjusted daily high, low, and prior close',
    },
  });
  const records = {
    status: 'unavailable',
    priorAllTimeHigh: null,
    priorAllTimeLow: null,
    source,
    asOf: null,
    observations: 0,
    highObservations: 0,
    lowObservations: 0,
    comparisonBarAsOf: null,
    historyRule: 'all completed provider bars unless a comparison date is supplied',
    priceBasis: 'provider daily high and low (not dividend-adjusted)',
    splitHandling: 'provider OHLC as returned; no local split inference or back-adjustment',
    reason,
  };
  const priceStructure = unavailablePriceStructure(reason);

  return {
    symbol: normalizedSymbol,
    status: 'unavailable',
    source,
    asOf: null,
    observations: 0,
    beta,
    atr14,
    records,
    priceStructure,
    provenance,
    historicalOnly: true,
    executable: false,
  };
}

function buildSecurityRiskMetrics({
  symbol,
  securityBars,
  benchmarkBars,
  source = DEFAULT_SOURCE,
  provenance = {},
  recordsBeforeDate = null,
} = {}) {
  const normalizedSymbol = String(symbol || '').trim().toUpperCase();
  if (!normalizedSymbol) {
    return createUnavailableSecurityRiskMetrics({
      symbol: normalizedSymbol,
      reason: REASONS.INVALID_SYMBOL,
      source,
      provenance,
    });
  }

  const normalized = normalizeAdjustedPriceBars(securityBars);
  if (normalized.length === 0) {
    return createUnavailableSecurityRiskMetrics({
      symbol: normalizedSymbol,
      reason: REASONS.HISTORY_UNAVAILABLE,
      source,
      provenance,
    });
  }

  const beta = calculateAlignedBeta(normalized, benchmarkBars, { source });
  const atr14 = calculateAtr14(normalized, { source });
  const records = calculatePriorAllTimePrices(normalized, { source, beforeDate: recordsBeforeDate });
  const priceStructure = calculatePriceStructureRun(normalized);
  const availableCount = [beta, atr14, records, priceStructure]
    .filter((metric) => metric.status === 'available').length;

  return {
    symbol: normalizedSymbol,
    status: availableCount === 4 ? 'available' : (availableCount > 0 ? 'partial' : 'unavailable'),
    source,
    asOf: normalized[normalized.length - 1].date,
    observations: normalized.length,
    beta,
    atr14,
    records,
    priceStructure,
    provenance,
    historicalOnly: true,
    executable: false,
  };
}

module.exports = {
  ATR_PERIOD,
  BETA_WINDOW_RETURNS,
  DEFAULT_SOURCE,
  MIN_BETA_RETURNS,
  REASONS,
  buildAdjustedReturns,
  buildSecurityRiskMetrics,
  calculateATR14: calculateAtr14,
  calculateAlignedBeta,
  calculateAtr14,
  calculateBeta: calculateAlignedBeta,
  calculatePriorAllTimePrices,
  calculatePriorAllTimeRange: calculatePriorAllTimePrices,
  calculatePriceStructureRun,
  createUnavailableSecurityRiskMetrics,
  normalizeAdjustedPriceBars,
  parseYahooChartBars,
};
