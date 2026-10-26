import { calculateSizingBand, SIZING_CONSTANTS } from './signalWeightedPositionSizing';
import { expectedSizingSession } from './volatilitySizingBand.cjs';

const SOURCE = 'Yahoo Finance chart API';
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const flagged = value => value && (['stale', 'cacheOnly', 'fromCache', 'mock', 'isMock', 'seeded', 'isSeeded', 'synthetic', 'inferred', 'fallback', 'offline', 'disconnected'].some(key => value[key] === true)
  || value.connected === false || /^(unavailable|error|failed|stale|cache-only|mock|seeded|offline|disconnected)$/.test(String(value.status || '')));

// Dated planning limits. These values never supply live quotes, order sizes,
// or a signal: Trade/Trend and execution eligibility are checked separately.
export function securitySizingReference(payload, symbol, { now = Date.now() } = {}) {
  const row = payload?.rows?.[symbol];
  const unavailable = reason => ({ available: false, minWeight: null, maxWeight: null, reason, historicalOnly: true, executable: false });
  if (!payload || !row || payload.historicalOnly !== true || payload.executable !== false
    || row.historicalOnly !== true || row.executable !== false || row.symbol !== symbol
    || payload.source !== SOURCE || row.source !== SOURCE
    || [payload, row, row.provenance, row.provenance?.security].some(flagged)) return unavailable('Verified daily history unavailable');
  const history = row.provenance?.security;
  if (row.provenance?.provider !== 'Yahoo Finance' || row.provenance?.dataset !== 'chart'
    || row.provenance?.interval !== '1d' || row.provenance?.adjustedCloseRequired !== true
    || history?.requestedSymbol !== symbol) return unavailable('Daily history source needs verification');
  const age = Number(now) - Date.parse(history.fetchedAt);
  if (!Number.isFinite(age) || age < -5000 || age > 3600000) return unavailable('Refresh daily history');
  const instrumentType = row.instrumentType;
  if (!instrumentType) return unavailable('Instrument type needs verification');
  if (!['ETF', 'EQUITY', 'CRYPTOCURRENCY'].includes(instrumentType)) return unavailable('Contract-specific sizing required');
  const expected = expectedSizingSession(now, instrumentType === 'CRYPTOCURRENCY' ? 365 : 252);
  // Overseas exchanges can complete a newer session during a US holiday.
  // Keep the provider's dated bar only when its regular-session clock proves
  // that bar is complete; never accept a current intraday daily candle.
  const period = history.regularSession;
  const timestamp = Date.parse(row.referencePrice?.timestamp) / 1000;
  const foreignCompleted = history.exchangeTimezone && history.exchangeTimezone !== 'America/New_York'
    && instrumentType !== 'CRYPTOCURRENCY' && number(period?.start) !== null && number(period?.end) !== null
    && period.start < period.end && Number.isFinite(timestamp)
    && (timestamp < period.start || (timestamp < period.end && Number(now) / 1000 >= period.end))
    && row.asOf >= expected && row.asOf <= new Date(now).toISOString().slice(0, 10);
  if (row.asOf !== expected && !foreignCompleted) return unavailable(`Latest completed daily history needed (received ${row.asOf || 'no date'})`);
  const metric = (value, observations, positive = false) => value?.status === 'available'
    && !flagged(value) && value.source === SOURCE && number(value.value) !== null
    && (!positive || value.value > 0) && Number.isInteger(value.observations) && value.observations >= observations
    && Number.isFinite(Date.parse(value.asOf)) && value.asOf <= row.asOf
    && Date.parse(row.asOf) - Date.parse(value.asOf) <= (positive ? 0 : 7 * 86400000) ? value : null;
  const atr14 = metric(row.atr14, SIZING_CONSTANTS.MIN_ATR_OBSERVATIONS, true);
  const referencePrice = metric(row.referencePrice, 1, true);
  const band = calculateSizingBand({ atr14, spot: referencePrice?.value });
  return {
    available: band.available, minWeight: band.minWeight, maxWeight: band.maxWeight,
    atr14, referencePrice, relativeAtr: band.relativeAtr, floorApplied: band.floorApplied,
    stopDistance: band.stopDistance, asOf: row.asOf, source: SOURCE,
    historicalOnly: true, executable: false, riskBlocked: band.riskBlocked,
    reason: !atr14 ? row.atr14?.observations >= SIZING_CONSTANTS.MIN_ATR_OBSERVATIONS ? 'ATR source needs verification' : 'ATR needs 14 completed sessions'
      : !referencePrice ? 'Verified closing price needed' : null,
  };
}

// Both ends share one precision so a 25 bp end never sits beside a rounded one.
const hasHundredths = value => Math.abs(value * 10 - Math.round(value * 10)) > 1e-9;

/**
 * The Positions table's MIN–MAX for a holding: the same ATR band as Exposure Lab,
 * gated on the current risk-metrics response and a spot-like instrument.
 */
export function holdingSizingReference({ symbol, payload, sourceStatus, sourceError, instrumentTypes = [], now = Date.now() } = {}) {
  const unavailable = reason => ({ available: false, reason, value: null, minWeight: null, maxWeight: null });
  if (instrumentTypes.some(type => type && !['STK', 'STOCK', 'ETF', 'CRYPTO'].includes(String(type).toUpperCase()))) {
    return unavailable('This instrument requires contract-specific risk sizing.');
  }
  if (sourceError || !['ready', 'partial'].includes(sourceStatus)) {
    return unavailable(sourceStatus === 'loading' ? 'Refreshing ATR inputs.' : 'The ATR provider is unavailable.');
  }
  const reference = securitySizingReference(payload, String(symbol || '').trim().toUpperCase(), { now });
  if (!reference.available) return { ...reference, value: null };
  // MAX below MIN: no position size fits, so show the reason instead of a band.
  if (reference.riskBlocked) return { ...reference, available: false, value: null, reason: 'Too volatile to size: ATR is near half the price.' };
  const digits = hasHundredths(reference.minWeight) || hasHundredths(reference.maxWeight) ? 2 : 1;
  return { ...reference, value: `${reference.minWeight.toFixed(digits)}–${reference.maxWeight.toFixed(digits)}%` };
}

export function sizingUniverse(catalogue = [], base = []) {
  const rows = new Map(base.map(row => [row.ticker, { ...row }]));
  for (const row of catalogue) {
    // A prose mention alone is not a security identity. Include the site's
    // catalogue and source-verified names, without activating trades.
    if (!row.existingUniverse && row.nameVerified !== true) continue;
    if (!/^[A-Z0-9][A-Z0-9.^=/_-]{0,31}$/.test(row.ticker || '')) continue;
    const prior = rows.get(row.ticker);
    rows.set(row.ticker, { ...prior, ticker: row.ticker, name: row.name || prior?.name || row.ticker,
      assetClass: prior?.assetClass || row.assetClass || (row.providerInstrumentType === 'CRYPTOCURRENCY' ? 'crypto' : 'equity'),
      instrumentType: row.providerInstrumentType || prior?.instrumentType || null,
    });
  }
  return [...rows.values()];
}
