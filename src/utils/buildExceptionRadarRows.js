import { USD_METRICS } from '../constants/usdMarket';
import { VOLATILITY_SERIES } from '../hooks/useVolatilitySnapshot';

export const IBKR_PROVIDER_STATUS_MAX_AGE_MS = 30 * 1000;
export const IBKR_QUOTE_HEARTBEAT_MAX_AGE_MS = 60 * 1000;
export const PUBLIC_DELAYED_QUOTE_MAX_AGE_MS = 4 * 24 * 60 * 60 * 1000;

export const FX_STABLE_SYMBOL_ORDER = Object.freeze([
  'EURUSD',
  'USDJPY',
  'GBPUSD',
  'AUDUSD',
  'USDCAD',
  'USDMXN',
  'USDCHF',
  'NZDUSD',
  'USDCNY',
  'EURGBP',
]);

export const US_CASH_INDEX_SYMBOL_ORDER = Object.freeze([
  'SPX',
  'DJI',
  'IXIC',
  'RUT',
]);

export const USD_CORRELATION_SYMBOL_ORDER = Object.freeze(
  USD_METRICS.map(({ symbol }) => symbol),
);

export const EXCEPTION_SLOT_DEFINITIONS = Object.freeze([
  Object.freeze({ slot: 1, id: 'volatility-primary', category: 'VOLATILITY', metric: 'day_change_pct' }),
  Object.freeze({ slot: 2, id: 'volatility-secondary', category: 'VOLATILITY', metric: 'day_change_pct' }),
  Object.freeze({ slot: 3, id: 'fx-primary', category: 'FX', metric: 'day_change_pct' }),
  Object.freeze({ slot: 4, id: 'equity-primary', category: 'EQUITY', metric: 'day_change_pct' }),
  Object.freeze({ slot: 5, id: 'correlation-primary', category: 'CORRELATION', metric: '30d_correlation' }),
]);

const IBKR_ALLOWED_DATA_TYPES = new Set(['live', 'unknown']);
const HARD_REJECTION_PATTERN = /(?:^|[\s;,_-])(stale|offline|cache(?:d)?|mock|seed(?:ed)?|synthetic|fallback|inferred|portfolio[-_ ]derived|frozen)(?:$|[\s;,_-])/i;
const UNAVAILABLE_PATTERN = /^(?:unavailable|offline|inactive|defective|error|failed|missing|disconnected)$/i;

const asFiniteNumber = (value) => {
  if (value == null || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const normalizeSymbol = (value) => String(value || '')
  .toUpperCase()
  .replace(/[^A-Z0-9]/g, '');

const validTimestamp = (value) => {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
};

const resolveNowMs = (now) => {
  const value = typeof now === 'function' ? now() : now;
  const numericValue = Number(value);
  const parsed = value instanceof Date
    ? value.getTime()
    : Number.isFinite(numericValue)
      ? numericValue
      : new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : Date.now();
};

const isFreshTimestamp = (value, nowMs, maxAgeMs) => {
  const timestamp = validTimestamp(value);
  if (!timestamp) return false;
  const age = nowMs - new Date(timestamp).getTime();
  return age >= -maxAgeMs && age <= maxAgeMs;
};

const containsHardRejection = (...values) => values
  .flatMap((value) => (Array.isArray(value) ? value : [value]))
  .filter((value) => value != null)
  .some((value) => HARD_REJECTION_PATTERN.test(String(value)));

const explicitUnavailable = (...values) => values
  .filter((value) => value != null && value !== '')
  .some((value) => UNAVAILABLE_PATTERN.test(String(value)));

const statusLabelFor = (status) => {
  if (status === 'live') return 'LIVE';
  if (status === 'delayed') return 'DELAYED · AS OF';
  if (status === 'as-of') return 'AS OF';
  return 'UNAVAILABLE';
};

function isIbkrProviderCurrent(providerStatus, nowMs) {
  if (!providerStatus || providerStatus.unavailable || providerStatus.statusRefreshDelayed) return false;
  const ibkr = providerStatus.ibkr || {};
  if (ibkr.statusRefreshDelayed) return false;
  const connected = ibkr.connected === true || ibkr.status === 'connected';
  if (!connected) return false;

  const providerTimestamp = providerStatus.timestamp || providerStatus.responseTimestamp;
  if (!isFreshTimestamp(providerTimestamp, nowMs, IBKR_PROVIDER_STATUS_MAX_AGE_MS)) return false;
  return isFreshTimestamp(ibkr.lastQuoteAt, nowMs, IBKR_QUOTE_HEARTBEAT_MAX_AGE_MS);
}

function eligibleMarketRow(row, providerStatus, nowMs) {
  if (!row || typeof row !== 'object' || row.valid === false) return null;
  const source = String(row.source || '').trim().toLowerCase();
  const availability = String(row.availability || '').trim().toLowerCase();
  if (availability !== 'current' && availability !== 'delayed') return null;
  if (row.freshness != null && row.freshness !== 'current') return null;
  if (row.sourceStatus != null && row.sourceStatus !== 'current') return null;
  if (explicitUnavailable(row.status, row.entitlementStatus)) return null;
  const relevantWarnings = source === 'ibkr'
    ? row.warning
    : String(row.warning || '')
      .split(';')
      .filter((warning) => !/ibkr/i.test(warning));
  if (containsHardRejection(
    row.status,
    row.freshness,
    row.sourceStatus,
    relevantWarnings,
    row.error,
    row.entitlementStatus,
    row.dataType,
  )) return null;

  const dataType = String(row.dataType || '').trim().toLowerCase();
  const quoteAsOf = validTimestamp(row.quoteAsOf || row.timestamp || row.asOf);
  const value = asFiniteNumber(row.price ?? row.value ?? row.lastPx);
  const changeValue = asFiniteNumber(row.changePercent);
  if (!source || !quoteAsOf) return null;
  if (value == null || changeValue == null) return null;

  if (source === 'ibkr') {
    if (
      availability !== 'current'
      || !IBKR_ALLOWED_DATA_TYPES.has(dataType)
      || !isIbkrProviderCurrent(providerStatus, nowMs)
      || !isFreshTimestamp(quoteAsOf, nowMs, IBKR_QUOTE_HEARTBEAT_MAX_AGE_MS)
    ) return null;
  } else if (
    availability !== 'delayed'
    || dataType !== 'delayed'
    || !isFreshTimestamp(quoteAsOf, nowMs, PUBLIC_DELAYED_QUOTE_MAX_AGE_MS)
  ) {
    // A public-provider row is only eligible when it explicitly identifies as delayed.
    return null;
  }

  return {
    source,
    status: source === 'ibkr' ? 'live' : 'delayed',
    asOf: quoteAsOf,
    value,
    changeValue,
  };
}

function eligibleVolatilityRow(snapshot, series) {
  const row = snapshot?.[series.name];
  if (!row || row.availability !== 'available' || row.freshness !== 'current') return null;
  if (row.error || containsHardRejection(row.source, row.quoteMode, row.warning, row.error)) return null;

  const value = asFiniteNumber(row.lastPx);
  const changeValue = asFiniteNumber(row.dayChangePct);
  const asOf = validTimestamp(row.asOf || row.timestamp || row.lastUpdated);
  const source = String(row.source || '').trim().toLowerCase();
  if (value == null || changeValue == null || !asOf || !source) return null;

  const isVerifiedDelayed = source === 'cboe'
    || source === 'yahoo'
    || /delayed|provider-reported/i.test(String(row.quoteMode || ''));
  const status = isVerifiedDelayed ? 'delayed' : 'live';
  return { row, value, changeValue, asOf, source, status };
}

const stableRank = (symbol, stableOrder) => {
  const index = stableOrder.indexOf(symbol);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
};

const compareByAbsoluteMove = (stableOrder) => (left, right) => {
  const magnitudeDifference = Math.abs(right.changeValue) - Math.abs(left.changeValue);
  if (magnitudeDifference !== 0) return magnitudeDifference;
  const stableDifference = stableRank(left.symbol, stableOrder) - stableRank(right.symbol, stableOrder);
  if (stableDifference !== 0) return stableDifference;
  return left.symbol.localeCompare(right.symbol);
};

const availableRow = (definition, candidate) => ({
  ...definition,
  symbol: candidate.symbol,
  label: candidate.label,
  value: candidate.value,
  changeValue: candidate.changeValue,
  changeLabel: candidate.changeLabel,
  status: candidate.status,
  statusLabel: statusLabelFor(candidate.status),
  asOf: candidate.asOf,
  source: candidate.source,
  available: true,
  reason: null,
});

const unavailableRow = (definition) => ({
  ...definition,
  symbol: null,
  label: '—',
  value: null,
  changeValue: null,
  changeLabel: definition.metric === '30d_correlation' ? '30D' : 'DAY',
  status: 'unavailable',
  statusLabel: 'UNAVAILABLE',
  asOf: null,
  source: null,
  available: false,
  reason: `${definition.category.toLowerCase()} data unavailable`,
});

function buildVolatilityCandidates(volatilitySnapshot) {
  return VOLATILITY_SERIES.map((series) => {
    const eligible = eligibleVolatilityRow(volatilitySnapshot, series);
    if (!eligible) return null;
    return {
      symbol: series.symbol,
      label: series.symbol,
      value: eligible.value,
      changeValue: eligible.changeValue,
      changeLabel: 'DAY',
      status: eligible.status,
      asOf: eligible.asOf,
      source: eligible.source,
    };
  })
    .filter(Boolean)
    .sort(compareByAbsoluteMove(VOLATILITY_SERIES.map(({ symbol }) => symbol)));
}

function buildMarketCandidates(rows, stableOrder, providerStatus, nowMs) {
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const symbol = normalizeSymbol(row?.symbol || row?.ticker || row?.pair);
    if (!symbol || !stableOrder.includes(symbol)) return null;
    const eligible = eligibleMarketRow(row, providerStatus, nowMs);
    if (!eligible) return null;
    return {
      symbol,
      label: row.name || row.label || row.pair || symbol,
      value: eligible.value,
      changeValue: eligible.changeValue,
      changeLabel: 'DAY',
      status: eligible.status,
      asOf: eligible.asOf,
      source: eligible.source,
    };
  })
    .filter(Boolean)
    .sort(compareByAbsoluteMove(stableOrder));
}

function buildCorrelationCandidates(correlationState) {
  if (
    !correlationState
    || correlationState.loading === true
    || correlationState.error
    || (correlationState.sourceStatus && correlationState.sourceStatus !== 'current')
    || !correlationState.correlations
    || !correlationState.rollingStats
  ) return [];

  const correlationsTimestamp = validTimestamp(correlationState.correlationsTimestamp);
  const calculationDate = correlationState.calculationDate;
  if (!correlationsTimestamp || !validTimestamp(`${calculationDate}T00:00:00Z`)) return [];

  return USD_CORRELATION_SYMBOL_ORDER.map((symbol) => {
    const value = asFiniteNumber(correlationState.correlations?.[symbol]?.['30D']);
    if (value == null) return null;
    return {
      symbol,
      label: `${symbol} / USD`,
      value,
      changeValue: null,
      changeLabel: '30D',
      status: 'as-of',
      asOf: calculationDate,
      source: correlationState.source || 'usd-correlation-analysis',
      correlationMagnitude: Math.abs(value),
    };
  })
    .filter(Boolean)
    .sort((left, right) => {
      const magnitudeDifference = right.correlationMagnitude - left.correlationMagnitude;
      if (magnitudeDifference !== 0) return magnitudeDifference;
      return stableRank(left.symbol, USD_CORRELATION_SYMBOL_ORDER)
        - stableRank(right.symbol, USD_CORRELATION_SYMBOL_ORDER);
    });
}

/**
 * Produces the five fixed exception slots. A missing family remains unavailable;
 * candidates never backfill across categories.
 */
export function buildExceptionRadarRows({
  volatilitySnapshot = null,
  marketData = {},
  correlationState = null,
  providerStatus = null,
  now = Date.now(),
} = {}) {
  const nowMs = resolveNowMs(now);
  const volatility = buildVolatilityCandidates(volatilitySnapshot);
  const fx = buildMarketCandidates(
    marketData?.currencies,
    FX_STABLE_SYMBOL_ORDER,
    providerStatus,
    nowMs,
  );
  const equity = buildMarketCandidates(
    marketData?.us,
    US_CASH_INDEX_SYMBOL_ORDER,
    providerStatus,
    nowMs,
  );
  const correlation = buildCorrelationCandidates(correlationState);
  const candidatesBySlot = [volatility[0], volatility[1], fx[0], equity[0], correlation[0]];

  return EXCEPTION_SLOT_DEFINITIONS.map((definition, index) => (
    candidatesBySlot[index]
      ? availableRow(definition, candidatesBySlot[index])
      : unavailableRow(definition)
  ));
}

export default buildExceptionRadarRows;
