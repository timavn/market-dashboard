const {
  completedDailyBarCutoff,
  pearsonCorrelation,
} = require('./usdCorrelations.cjs');

const DAY_MS = 24 * 60 * 60_000;
const DEFAULT_MAX_STALE_DAYS = 5;

const GOLD_CORRELATION_HORIZONS = Object.freeze([
  Object.freeze({ key: '15D', sessions: 15 }),
  Object.freeze({ key: '30D', sessions: 30 }),
  Object.freeze({ key: '90D', sessions: 90 }),
  Object.freeze({ key: '120D', sessions: 120 }),
  Object.freeze({ key: '180D', sessions: 180 }),
]);

const GOLD_CORRELATION_ROWS = Object.freeze([
  Object.freeze({
    key: 'DXY', label: 'DXY', symbol: 'DXY', transform: 'price_return',
    source: 'Yahoo Finance DX-Y.NYB completed daily closes', unit: 'index',
  }),
  Object.freeze({
    key: 'UST10Y_REAL', label: 'U.S. 10Y Real', symbol: 'DFII10', transform: 'yield_change_bps',
    source: 'FRED DFII10 daily observations', unit: 'percent',
  }),
  Object.freeze({
    key: 'UST10Y_NOMINAL', label: 'U.S. 10Y Nominal', symbol: 'DGS10', transform: 'yield_change_bps',
    source: 'FRED DGS10 daily observations', unit: 'percent',
  }),
  Object.freeze({
    key: 'SPX', label: 'S&P 500', symbol: 'SPX', transform: 'price_return',
    source: 'Yahoo Finance ^GSPC completed daily closes', unit: 'index',
  }),
  Object.freeze({
    key: 'SILVER', label: 'Silver', symbol: 'SILVER', transform: 'price_return',
    source: 'Yahoo Finance SI=F completed daily closes', unit: 'USD/ozt',
  }),
  Object.freeze({
    key: 'CRB', label: 'CRB', symbol: 'CRB', transform: 'price_return',
    source: 'Yahoo Finance ^TRCCRB completed daily closes', unit: 'index',
  }),
  Object.freeze({
    key: 'WTI', label: 'WTI', symbol: 'WTI', transform: 'price_return',
    source: 'Yahoo Finance CL=F completed daily closes', unit: 'USD/bbl',
  }),
]);

class GoldCorrelationDataError extends Error {
  constructor(message, code = 'GOLD_CORRELATION_DATA_UNAVAILABLE') {
    super(message);
    this.name = 'GoldCorrelationDataError';
    this.code = code;
  }
}

function finiteNumber(value) {
  if (value == null || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function round(value, decimals = 3) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function dateKeyFromRow(row) {
  const rawDate = String(row?.date || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) return rawDate;
  if (/^\d{8}$/.test(rawDate)) {
    return `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}`;
  }
  const rawTimestamp = row?.t ?? row?.timestamp ?? row?.time;
  if (rawTimestamp == null) return null;
  const parsed = new Date(rawTimestamp);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function normalizeDailyHistory(history = [], {
  cutoffDate = null,
  allowNonPositive = false,
} = {}) {
  const byDate = new Map();
  for (const row of Array.isArray(history) ? history : []) {
    const date = dateKeyFromRow(row);
    const value = finiteNumber(row?.close ?? row?.value ?? row?.price);
    if (!date || (cutoffDate && date > cutoffDate) || value == null) continue;
    if (!allowNonPositive && value <= 0) continue;
    byDate.set(date, { date, value });
  }
  return [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date));
}

function assertFreshDate(date, now, maxStaleDays, label) {
  const asOf = Date.parse(`${date || ''}T23:59:59.999Z`);
  const ageMs = now.getTime() - asOf;
  if (!Number.isFinite(asOf) || ageMs < -DAY_MS || ageMs > maxStaleDays * DAY_MS) {
    throw new GoldCorrelationDataError(
      `${label} daily history is stale (latest completed date: ${date || 'unknown'}).`,
      'GOLD_CORRELATION_DATA_STALE',
    );
  }
}

function alignCompletedLevels(basisHistory = [], comparatorHistory = []) {
  const basisByDate = new Map(basisHistory.map((row) => [row.date, row.value]));
  return comparatorHistory
    .filter((row) => basisByDate.has(row.date))
    .map((row) => ({
      date: row.date,
      basis: basisByDate.get(row.date),
      comparator: row.value,
    }));
}

function completedDailyChanges(alignedLevels = [], transform = 'price_return') {
  const changes = [];
  for (let index = 1; index < alignedLevels.length; index += 1) {
    const previous = alignedLevels[index - 1];
    const current = alignedLevels[index];
    if (!(previous.basis > 0) || !(current.basis > 0)) continue;
    const basis = (current.basis / previous.basis) - 1;
    let comparator = null;
    if (transform === 'yield_change_bps') {
      comparator = (current.comparator - previous.comparator) * 100;
    } else if (previous.comparator > 0 && current.comparator > 0) {
      comparator = (current.comparator / previous.comparator) - 1;
    }
    if (!Number.isFinite(basis) || !Number.isFinite(comparator)) continue;
    changes.push({ date: current.date, base: basis, metric: comparator });
  }
  return changes;
}

function correlationsForHorizons(changes = []) {
  return Object.fromEntries(GOLD_CORRELATION_HORIZONS.map(({ key, sessions }) => {
    if (changes.length < sessions) return [key, null];
    return [key, round(pearsonCorrelation(changes.slice(-sessions)))];
  }));
}

function unavailableRow(definition, reason) {
  return {
    key: definition.key,
    label: definition.label,
    symbol: definition.symbol,
    status: 'unavailable',
    source: definition.source,
    transform: definition.transform,
    asOf: null,
    observations: 0,
    latest: { value: null, asOf: null, unit: definition.unit },
    values: Object.fromEntries(GOLD_CORRELATION_HORIZONS.map(({ key }) => [key, null])),
    reason,
  };
}

function buildGoldCorrelationRow(definition, basis, history, {
  now,
  cutoffDate,
  maxStaleDays,
  error = null,
} = {}) {
  if (error) return unavailableRow(definition, error);
  const comparator = normalizeDailyHistory(history, {
    cutoffDate,
    allowNonPositive: definition.transform === 'yield_change_bps',
  });
  if (comparator.length < 2) {
    return unavailableRow(definition, `Verified ${definition.label} daily history is unavailable.`);
  }
  try {
    assertFreshDate(comparator.at(-1)?.date, now, maxStaleDays, definition.label);
  } catch (freshnessError) {
    return unavailableRow(definition, freshnessError.message);
  }
  const aligned = alignCompletedLevels(basis, comparator);
  const changes = completedDailyChanges(aligned, definition.transform);
  const values = correlationsForHorizons(changes);
  const latest = aligned.at(-1) || null;
  const availableCount = Object.values(values).filter(Number.isFinite).length;
  if (!availableCount) {
    return unavailableRow(
      definition,
      `${definition.label} has ${changes.length} aligned completed changes; 15 are required.`,
    );
  }
  return {
    key: definition.key,
    label: definition.label,
    symbol: definition.symbol,
    status: availableCount === GOLD_CORRELATION_HORIZONS.length ? 'available' : 'partial',
    source: definition.source,
    transform: definition.transform,
    asOf: changes.at(-1)?.date || null,
    observations: changes.length,
    latest: {
      value: finiteNumber(latest?.comparator),
      asOf: latest?.date || null,
      unit: definition.unit,
    },
    values,
    reason: availableCount === GOLD_CORRELATION_HORIZONS.length
      ? null
      : `Only ${changes.length} aligned completed changes are available.`,
  };
}

function buildGoldCorrelationSnapshot({
  basisHistory,
  comparatorHistories = {},
  comparatorErrors = {},
} = {}, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const maxStaleDays = Number.isFinite(options.maxStaleDays)
    ? options.maxStaleDays
    : DEFAULT_MAX_STALE_DAYS;
  const cutoffDate = options.cutoffDate || completedDailyBarCutoff(now);
  const basis = normalizeDailyHistory(basisHistory, { cutoffDate });
  if (basis.length < 2) {
    throw new GoldCorrelationDataError(
      'Verified IBKR XAUUSD completed daily history is unavailable.',
      'GOLD_CORRELATION_BASIS_UNAVAILABLE',
    );
  }
  assertFreshDate(basis.at(-1)?.date, now, maxStaleDays, 'IBKR XAUUSD');

  const rows = GOLD_CORRELATION_ROWS.map((definition) => buildGoldCorrelationRow(
    definition,
    basis,
    comparatorHistories[definition.key],
    {
      now,
      cutoffDate,
      maxStaleDays,
      error: comparatorErrors[definition.key] || null,
    },
  ));
  const availableRows = rows.filter((row) => row.status === 'available').length;
  const partialRows = rows.filter((row) => row.status === 'partial').length;
  const status = availableRows === rows.length
    ? 'available'
    : availableRows + partialRows > 0 ? 'partial' : 'unavailable';

  return {
    schemaVersion: 1,
    status,
    method: 'pearson_completed_daily_changes',
    horizons: GOLD_CORRELATION_HORIZONS.map(({ key }) => key),
    basis: {
      symbol: 'XAUUSD',
      label: 'IBKR XAUUSD Spot Gold',
      role: 'proxy',
      status: 'available',
      source: 'IBKR completed daily midpoint bars',
      asOf: basis.at(-1).date,
      unit: 'USD/ozt',
      reason: 'Spot-gold proxy basis; contextual and non-executable.',
    },
    rows,
    timestamp: now.toISOString(),
    calculationDate: basis.at(-1).date,
    sourceStatus: status,
    reason: status === 'unavailable'
      ? 'No comparator has enough current aligned observations.'
      : null,
  };
}

function unavailableGoldCorrelationSnapshot(error, now = new Date()) {
  const reason = String(error?.message || error || 'Gold correlation data is unavailable.');
  return {
    schemaVersion: 1,
    status: 'unavailable',
    method: 'pearson_completed_daily_changes',
    horizons: GOLD_CORRELATION_HORIZONS.map(({ key }) => key),
    basis: {
      symbol: 'XAUUSD', label: 'IBKR XAUUSD Spot Gold', role: 'proxy', status: 'unavailable',
      source: null, asOf: null, unit: 'USD/ozt', reason,
    },
    rows: GOLD_CORRELATION_ROWS.map((definition) => unavailableRow(definition, reason)),
    timestamp: (now instanceof Date ? now : new Date(now)).toISOString(),
    calculationDate: null,
    sourceStatus: 'unavailable',
    reason,
    code: error?.code || 'GOLD_CORRELATION_DATA_UNAVAILABLE',
  };
}

module.exports = {
  DEFAULT_MAX_STALE_DAYS,
  GOLD_CORRELATION_HORIZONS,
  GOLD_CORRELATION_ROWS,
  GoldCorrelationDataError,
  alignCompletedLevels,
  buildGoldCorrelationSnapshot,
  completedDailyChanges,
  correlationsForHorizons,
  normalizeDailyHistory,
  unavailableGoldCorrelationSnapshot,
};
