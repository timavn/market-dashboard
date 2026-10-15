const { isTradingDateKey, previousTradingDateKey, addCalendarDays } = require('./usEquityMarketCalendar.cjs');

// These are allocation-policy choices, not estimates fitted to past returns.
const VOLATILITY_BAND_POLICY = Object.freeze({
  version: 'volatility-band-v1',
  referenceVolatility: 0.20,
  referenceMinPct: 2,
  referenceMaxPct: 6,
  volatilityFloor: 0.10,
  minimumReturns: 63,
  longWindowReturns: 252,
  maxHistoryAgeMs: 60 * 60 * 1000,
  maxResponseAgeMs: 10 * 60 * 1000,
});

const positive = (value) => (
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
);

/** Arithmetic only. Call validateVolatilityBandInputs before displaying a holding's range. */
function calculateVolatilityBand(volatility) {
  if (positive(volatility) === null) return null;
  const policy = VOLATILITY_BAND_POLICY;
  const effectiveVolatility = Math.max(volatility, policy.volatilityFloor);
  const scale = policy.referenceVolatility / effectiveVolatility;
  return {
    minWeightPct: policy.referenceMinPct * scale,
    maxWeightPct: policy.referenceMaxPct * scale,
    widthPct: (policy.referenceMaxPct - policy.referenceMinPct) * scale,
    volatility,
    effectiveVolatility,
    floorApplied: volatility < policy.volatilityFloor,
    scale,
    methodVersion: policy.version,
  };
}

function formatVolatilityBand(band) {
  if (!band) return null;
  // Extra precision keeps very small bands visible instead of imposing a 2% minimum.
  const digits = band.minWeightPct < 0.1 ? 2 : 1;
  return `${band.minWeightPct.toFixed(digits)}–${band.maxWeightPct.toFixed(digits)}%`;
}

// Match the completed-session contract's 16:15 New York publication allowance.
// Historical estimates remain usable over exchange holidays, not across a new close.
function expectedSizingSession(now = Date.now(), annualizationFactor = 252) {
  const date = new Date(now);
  if (!Number.isFinite(date.getTime())) return null;
  if (annualizationFactor === 365) return addCalendarDays(date.toISOString().slice(0, 10), -1);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map(part => [part.type, part.value]));
  const today = `${parts.year}-${parts.month}-${parts.day}`;
  return isTradingDateKey(today) && Number(parts.hour) * 60 + Number(parts.minute) >= 975
    ? today : previousTradingDateKey(today);
}

function rejectedMetadata(value) {
  if (!value || typeof value !== 'object') return false;
  const flags = ['stale', 'cacheOnly', 'cached', 'fromCache', 'mock', 'isMock', 'seed', 'seeded',
    'isSeed', 'isSeeded', 'synthetic', 'inferred', 'fallback', 'offline', 'disconnected'];
  if (flags.some(flag => value[flag] === true) || value.connected === false) return true;
  return ['status', 'source', 'providerStatus', 'freshness', 'cacheStatus', 'reason'].some(key => (
    /(?:^|[\s_-])(stale|cache(?:d|_only|-only)?|mock|seed(?:ed)?|synthetic|inferred|fallback|offline|disconnected|error|failed|unavailable)(?:$|[\s_-])/i.test(String(value[key] || ''))
  ));
}

function freshTimestamp(value, maxAge, now) {
  const age = Number(now) - Date.parse(String(value || ''));
  return Number.isFinite(age) && age >= -5000 && age <= maxAge;
}

/**
 * A completed-close estimate is a dated research input, never an executable quote.
 * Require the current successful response and attributable adjusted history; no
 * beta, asset-class default, older payload, or live portfolio mark substitutes for it.
 */
function validateVolatilityBandInputs({ symbol, payload, sourceStatus, sourceError, instrumentTypes = [], now = Date.now() } = {}) {
  const row = payload?.rows?.[String(symbol || '').trim().toUpperCase()];
  const rv = row?.realizedVolatility;
  const provenance = row?.provenance;
  const history = provenance?.security;
  const unavailable = (reason) => ({ available: false, reason, band: null, value: null });
  if (instrumentTypes.some(type => type && !['STK', 'STOCK', 'ETF', 'CRYPTO'].includes(String(type).toUpperCase()))) {
    return unavailable('This instrument requires contract-specific risk sizing.');
  }
  if (sourceError || !['ready', 'partial'].includes(sourceStatus)) {
    return unavailable(sourceStatus === 'loading' ? 'Refreshing volatility inputs.' : 'The volatility provider is unavailable.');
  }
  if (!payload || !row || payload.historicalOnly !== true || payload.executable !== false
    || row.historicalOnly !== true || row.executable !== false
    || [payload, payload._cache, payload.cache, row, rv, provenance, history].some(rejectedMetadata)) {
    return unavailable('Verified volatility inputs are unavailable.');
  }
  if (row.source !== 'Yahoo Finance chart API' || provenance?.provider !== 'Yahoo Finance'
    || provenance?.dataset !== 'chart' || provenance?.interval !== '1d'
    || provenance?.adjustedCloseRequired !== true
    || history?.requestedSymbol !== row.symbol || row.symbol !== String(symbol || '').trim().toUpperCase()
    || !freshTimestamp(history?.fetchedAt, VOLATILITY_BAND_POLICY.maxHistoryAgeMs, now)
    || !freshTimestamp(payload.generatedAt, VOLATILITY_BAND_POLICY.maxResponseAgeMs, now)) {
    return unavailable('Current, sourced adjusted daily history is required.');
  }
  if (rv?.status !== 'available' || ![252, 365].includes(rv.annualizationFactor)
    || !Number.isInteger(rv.observationCount) || rv.observationCount < VOLATILITY_BAND_POLICY.minimumReturns
    || positive(rv.rv63) === null) {
    return unavailable('At least 63 verified daily returns are required.');
  }
  const expected = expectedSizingSession(now, rv.annualizationFactor);
  if (!expected || rv.asOf !== expected || row.asOf !== expected) {
    return unavailable(`Volatility must include the latest completed session (${expected || 'date unavailable'}).`);
  }
  const limitedHistory = rv.observationCount < VOLATILITY_BAND_POLICY.longWindowReturns;
  if ((!limitedHistory && positive(rv.rv252) === null)
    || (limitedHistory && (rv.rv252 != null || rv.limitedHistory !== true))) {
    return unavailable('The volatility lookbacks are incomplete or inconsistent.');
  }
  const volatility = limitedHistory ? rv.rv63 : Math.max(rv.rv63, rv.rv252);
  if (positive(rv.sizingVol) === null || Math.abs(rv.sizingVol - volatility) > 0.000002) {
    return unavailable('The sizing volatility does not match its verified lookbacks.');
  }
  const band = calculateVolatilityBand(volatility);
  return {
    available: true, reason: null, band, value: formatVolatilityBand(band),
    rv, asOf: rv.asOf, source: row.source, fetchedAt: history.fetchedAt,
    limitedHistory, observationCount: rv.observationCount,
  };
}

module.exports = {
  VOLATILITY_BAND_POLICY,
  calculateVolatilityBand,
  expectedSizingSession,
  formatVolatilityBand,
  validateVolatilityBandInputs,
};
