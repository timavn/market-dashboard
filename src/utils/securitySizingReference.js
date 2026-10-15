import { calculateSizingBand, calculateAtrRiskCap, roundWeightDown, SIZING_CONSTANTS } from './signalWeightedPositionSizing';
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
  const benchmark = row.provenance?.benchmark;
  const benchmarkAge = Number(now) - Date.parse(benchmark?.fetchedAt);
  const beta = benchmark?.symbol === 'SPY' && !flagged(benchmark) && benchmarkAge >= -5000 && benchmarkAge <= 3600000
    ? metric(row.beta, SIZING_CONSTANTS.MIN_BETA_OBSERVATIONS) : null;
  const atr14 = metric(row.atr14, SIZING_CONSTANTS.MIN_ATR_OBSERVATIONS, true);
  const referencePrice = metric(row.referencePrice, 1, true);
  const band = calculateSizingBand({ symbol, beta });
  const cap = calculateAtrRiskCap({ atr14, spot: referencePrice?.value });
  const maxWeight = band.available && cap.available ? roundWeightDown(Math.min(band.maxWeight, cap.capWeight)) : null;
  return {
    available: band.available && cap.available, minWeight: band.minWeight, maxWeight,
    beta, atr14, referencePrice, sizingPolicy: band.policy, asOf: row.asOf, source: SOURCE,
    historicalOnly: true, executable: false, riskBlocked: maxWeight !== null && maxWeight < band.minWeight,
    reason: band.requiresBeta && !beta ? row.beta?.observations >= SIZING_CONSTANTS.MIN_BETA_OBSERVATIONS ? 'Beta source needs verification' : `Beta needs ${SIZING_CONSTANTS.MIN_BETA_OBSERVATIONS} aligned sessions (${row.beta?.observations || 0} available)`
      : !atr14 ? 'ATR needs 14 completed sessions' : !referencePrice ? 'Verified closing price needed' : null,
  };
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
