import { dateKeyInTimeZone } from './spxClosePredictionMarket';

export const SPX_CONFLUENCE_MAX_SCORE = 8;
export const USD_CORRELATION_BASE_TIER = 0.5;
export const USD_CORRELATION_STRONG_TIER = 0.7;

const DIRECTION_TOKENS = Object.freeze({
  BULL: 'bullish',
  BULLISH: 'bullish',
  BUY: 'bullish',
  LONG: 'bullish',
  'RISK ON': 'bullish',
  RISK_ON: 'bullish',
  BEAR: 'bearish',
  BEARISH: 'bearish',
  SELL: 'bearish',
  SHORT: 'bearish',
  'RISK OFF': 'bearish',
  RISK_OFF: 'bearish',
});

function finiteNumber(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

export function normalizeDirection(value) {
  if (value == null) return null;
  return DIRECTION_TOKENS[String(value).trim().toUpperCase()] || null;
}

export function normalizeGammaExposure(value) {
  const token = String(value || '').trim().toUpperCase();
  if (token.includes('POSITIVE') || token === 'LONG') return 'positive';
  if (token.includes('NEGATIVE') || token === 'SHORT') return 'negative';
  if (token.includes('NEUTRAL')) return 'neutral';
  return null;
}

function normalizeStructureToken(value, kind) {
  const token = String(value || '').trim().toUpperCase().replace(/[_-]+/g, ' ');
  if (!token) return null;
  if (token.includes('NEUTRAL')) return 'neutral';
  if (kind === 'allocation') {
    if (token.includes('RISK ON')) return 'risk_on';
    if (token.includes('RISK OFF')) return 'risk_off';
  }
  if (kind === 'pv') {
    if (token.includes('LONG')) return 'long';
    if (token.includes('SHORT')) return 'short';
  }
  if (token.includes('BULLISH') || token === 'LONG') return 'bullish';
  if (token.includes('BEARISH') || token === 'SHORT') return 'bearish';
  return null;
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null) ?? null;
}

function findTickerSlot(data, ticker) {
  if (!data || typeof data !== 'object') return null;
  const upper = String(ticker || '').toUpperCase();
  const direct = data?.stocks?.[upper] || data?.securities?.[upper] || data?.[upper];
  if (direct && typeof direct === 'object') return direct;

  const rows = [data.rows, data.stocks, data.securities]
    .find((candidate) => Array.isArray(candidate));
  if (rows) {
    const row = rows.find((candidate) => (
      String(candidate?.ticker || candidate?.symbol || '').toUpperCase() === upper
    ));
    if (row) return row;
  }

  const namedEntry = Object.entries(data).find(([key, value]) => (
    value &&
    typeof value === 'object' &&
    (String(key).toUpperCase() === upper || String(key).toUpperCase().includes(`(${upper})`))
  ));
  return namedEntry?.[1] || null;
}

/**
 * Trade is intentionally independent from Risk Range Trend. It may come from
 * an explicit published tracker slot or a future explicit `trade` field on the
 * range record, but it is never copied from `riskRange.trend`.
 */
export function extractSpxTradeSignal(snapshot, riskRange = null) {
  const explicitRangeTrade = firstDefined(
    riskRange?.trade,
    riskRange?.tradeSignal,
    riskRange?.trackerTrade,
  );
  if (normalizeDirection(explicitRangeTrade)) {
    return {
      direction: normalizeDirection(explicitRangeTrade),
      raw: explicitRangeTrade,
      date: riskRange?.tradeDate || riskRange?.date || null,
      source: riskRange?.tradeSource || 'published-tracker',
    };
  }

  const slot = findTickerSlot(snapshot?.data, 'SPX');
  const raw = firstDefined(slot?.trade, slot?.tradeSignal, slot?.trackerTrend, slot?.trend);
  return {
    direction: normalizeDirection(raw),
    raw,
    date: slot?.date || snapshot?.date || null,
    source: slot ? (snapshot?.snapshotType || 'published-tracker') : null,
  };
}

/**
 * Canonical normalized shape expected from the forthcoming daily email:
 * gammaExposure, gammaThrottle, realizedVol10d, systematicFlowRisk,
 * pvBandRiskReward, and strategicAllocation. A nested `SPX`/`spx` object is
 * also accepted so ingestion can retain report-level metadata at the root.
 */
export function normalizeMarketStructureSnapshot(snapshot) {
  const data = snapshot?.data && typeof snapshot.data === 'object' ? snapshot.data : {};
  const spx = data.SPX || data.spx || data.marketStructure || data.market_structure || {};
  const gammaExposureRaw = firstDefined(
    spx.gammaExposure,
    spx.spxGammaExposure,
    data.gammaExposure,
    data.spxGammaExposure,
  );
  const systematicRaw = firstDefined(
    spx.systematicFlowRisk,
    spx.systematicFlow,
    data.systematicFlowRisk,
    data.systematicFlow,
  );
  const pvRaw = firstDefined(
    spx.pvBandRiskReward,
    spx.pvBand,
    data.pvBandRiskReward,
    data.pvBand,
  );
  const allocationRaw = firstDefined(
    spx.strategicAllocation,
    data.strategicAllocation,
  );

  return {
    date: spx.date || data.date || snapshot?.date || null,
    scrapedAt: snapshot?.scrapedAt || snapshot?.updatedAt || null,
    source: snapshot ? (snapshot.snapshotType || 'market-structure') : null,
    gammaExposure: normalizeGammaExposure(gammaExposureRaw),
    gammaExposureRaw,
    gammaThrottle: finiteNumber(firstDefined(
      spx.gammaThrottle,
      spx.gammaVolatilityThrottle,
      data.gammaThrottle,
      data.gammaVolatilityThrottle,
    )),
    realizedVol10d: finiteNumber(firstDefined(
      spx.realizedVol10d,
      spx.tenDayRealizedVolatility,
      spx.rVol10d,
      data.realizedVol10d,
      data.tenDayRealizedVolatility,
      data.rVol10d,
    )),
    systematicFlow: normalizeStructureToken(systematicRaw, 'flow'),
    systematicFlowRaw: systematicRaw,
    pvBand: normalizeStructureToken(pvRaw, 'pv'),
    pvBandRaw: pvRaw,
    strategicAllocation: normalizeStructureToken(allocationRaw, 'allocation'),
    strategicAllocationRaw: allocationRaw,
  };
}

export function normalizeUsdCorrelationSnapshot(snapshot) {
  const correlations = snapshot?.correlations?.SPX || {};
  return {
    date: snapshot?.calculationDate || null,
    timestamp: snapshot?.timestamp || null,
    source: snapshot?.source || 'DXY / SPX daily log returns',
    sourceStatus: snapshot?.sourceStatus || null,
    r15: finiteNumber(correlations['15D']),
    r30: finiteNumber(correlations['30D']),
    r90: finiteNumber(correlations['90D']),
  };
}

export function normalizeVixSnapshot(snapshot) {
  const row = snapshot?.VIX || null;
  const value = finiteNumber(row?.lastPx);
  let bucket = null;
  if (value != null && value >= 9 && value < 20) bucket = 'investable';
  else if (value != null && value >= 20 && value < 29) bucket = 'chop';
  else if (value != null && value >= 29) bucket = 'uninvestable';
  return {
    value,
    bucket,
    date: dateKeyInTimeZone(row?.asOf || snapshot?.lastUpdated),
    asOf: row?.asOf || snapshot?.lastUpdated || null,
    source: row?.sourceLabel || row?.source || null,
    quoteMode: row?.quoteMode || null,
    current: row?.availability === 'available' && row?.freshness === 'current',
  };
}

function dateOnly(value) {
  if (!value) return null;
  const match = String(value).match(/^\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : dateKeyInTimeZone(value);
}

export function isExactSessionInput(value, targetDate) {
  return Boolean(dateOnly(value) && dateOnly(value) === dateOnly(targetDate));
}

export function isRecentReferenceInput(value, targetDate, maxCalendarDays = 3) {
  const sourceDate = dateOnly(value);
  const sessionDate = dateOnly(targetDate);
  if (!sourceDate || !sessionDate) return false;
  const sourceMs = Date.parse(`${sourceDate}T12:00:00.000Z`);
  const targetMs = Date.parse(`${sessionDate}T12:00:00.000Z`);
  const days = (targetMs - sourceMs) / 86400000;
  return days >= 0 && days <= maxCalendarDays;
}

function geometryScore(direction, strike, lower, upper) {
  const width = upper - lower;
  if (!direction || !Number.isFinite(strike) || !(width > 0)) {
    return { available: false, points: null, coverage: null, strikeInside: false };
  }
  const strikeInside = strike >= lower && strike <= upper;
  const rawCoverage = direction === 'bullish'
    ? (upper - strike) / width
    : (strike - lower) / width;
  const coverage = clamp(rawCoverage);
  const points = coverage >= 0.75 ? 2 : coverage >= 0.5 ? 1 : 0;
  return { available: strikeInside, points, coverage, strikeInside };
}

function sameNonZeroSign(values) {
  return values.every((value) => Number.isFinite(value) && value !== 0) &&
    values.every((value) => Math.sign(value) === Math.sign(values[0]));
}

function correlationScore(usd, targetDate, historical) {
  const fresh = historical
    ? isExactSessionInput(usd?.date, targetDate)
    : isRecentReferenceInput(usd?.date, targetDate);
  const available = Boolean(
    usd?.sourceStatus === 'current' &&
    fresh &&
    Number.isFinite(usd?.r30)
  );
  if (!available) return { available: false, points: null, stableSign: false };
  const magnitude = Math.abs(usd.r30);
  const stableSign = sameNonZeroSign([usd.r15, usd.r30, usd.r90]);
  const points = magnitude >= USD_CORRELATION_STRONG_TIER && stableSign
    ? 2
    : magnitude >= USD_CORRELATION_BASE_TIER ? 1 : 0;
  return { available: true, points, stableSign };
}

function gammaScore(gammaExposure, coverage, geometryAvailable) {
  const inputAvailable = Boolean(gammaExposure);
  if (!inputAvailable || !geometryAvailable || !Number.isFinite(coverage)) {
    return { inputAvailable, available: false, points: null };
  }
  if (gammaExposure === 'neutral') return { inputAvailable: true, available: true, points: 0 };
  const contained = coverage >= 0.5;
  const points = (
    (gammaExposure === 'positive' && contained) ||
    (gammaExposure === 'negative' && !contained)
  ) ? 1 : 0;
  return { inputAvailable: true, available: true, points };
}

function vixScore(vix, direction, targetDate, historical) {
  const fresh = historical
    ? isExactSessionInput(vix?.date, targetDate)
    : isRecentReferenceInput(vix?.date, targetDate);
  const inputAvailable = Boolean(vix?.current && fresh && vix?.bucket);
  const available = Boolean(direction && inputAvailable);
  if (!available) return { inputAvailable, available: false, points: null };
  const points = (
    (direction === 'bullish' && vix.bucket === 'investable') ||
    (direction === 'bearish' && vix.bucket === 'uninvestable')
  ) ? 1 : 0;
  return { inputAvailable: true, available: true, points };
}

function structureDirection(value, kind) {
  if (value === 'neutral' || !value) return null;
  if (kind === 'pv') return value === 'long' ? 'bullish' : value === 'short' ? 'bearish' : null;
  if (kind === 'allocation') return value === 'risk_on' ? 'bullish' : value === 'risk_off' ? 'bearish' : null;
  return value === 'bullish' || value === 'bearish' ? value : null;
}

function structureScore(structure, direction, targetDate) {
  const exactDate = isExactSessionInput(structure?.date, targetDate);
  const fieldsPresent = Boolean(
    structure?.systematicFlow &&
    structure?.pvBand &&
    structure?.strategicAllocation
  );
  const inputAvailable = Boolean(exactDate && fieldsPresent);
  const available = Boolean(direction && inputAvailable);
  const directions = available ? [
    structureDirection(structure.systematicFlow, 'flow'),
    structureDirection(structure.pvBand, 'pv'),
    structureDirection(structure.strategicAllocation, 'allocation'),
  ] : [];
  const alignedCount = directions.filter((value) => value === direction).length;
  const conflictCount = directions.filter((value) => value && value !== direction).length;
  const points = available ? (alignedCount === 3 ? 2 : alignedCount >= 2 ? 1 : 0) : null;
  return { inputAvailable, exactDate, available, points, alignedCount, conflictCount };
}

export function buildSpxCloseConfluence({
  targetDate,
  historical = false,
  riskRange,
  trade,
  selectedMarket,
  usd,
  vix,
  marketStructure,
} = {}) {
  const trendDirection = normalizeDirection(riskRange?.trend);
  const tradeDirection = normalizeDirection(trade?.direction || trade?.raw);
  const exactTrend = isExactSessionInput(riskRange?.date, targetDate);
  const exactTrade = isExactSessionInput(trade?.date, targetDate);
  const aligned = Boolean(
    exactTrend &&
    exactTrade &&
    tradeDirection &&
    trendDirection &&
    tradeDirection === trendDirection
  );
  const direction = aligned ? tradeDirection : null;
  const side = direction === 'bullish' ? 'YES' : direction === 'bearish' ? 'NO' : null;
  const lower = finiteNumber(riskRange?.lrr);
  const upper = finiteNumber(riskRange?.hrr);
  const strike = finiteNumber(selectedMarket?.threshold);
  const geometry = geometryScore(direction, strike, lower, upper);

  const blockers = [];
  if (!tradeDirection) blockers.push('Published SPX Trade is unavailable');
  else if (!exactTrade) blockers.push('SPX Trade is not dated for this contract session');
  if (!trendDirection) blockers.push('Published SPX Trend is unavailable');
  else if (!exactTrend) blockers.push('SPX Trend is not dated for this contract session');
  if (tradeDirection && trendDirection && tradeDirection !== trendDirection) {
    blockers.push('SPX Trade and Trend are not aligned');
  }
  if (aligned && !geometry.strikeInside) blockers.push('Selected strike is outside the Hedgeye Risk Range');

  const eligibilityPassed = blockers.length === 0;
  const correlation = correlationScore(usd, targetDate, historical);
  const structure = structureScore(marketStructure, direction, targetDate);
  const gammaCurrent = isExactSessionInput(marketStructure?.date, targetDate);
  const gamma = gammaCurrent
    ? gammaScore(marketStructure?.gammaExposure, geometry.coverage, geometry.available)
    : { inputAvailable: false, available: false, points: null };
  const volatility = vixScore(vix, direction, targetDate, historical);
  const domains = [
    { key: 'geometry', max: 2, ...geometry },
    { key: 'usd', max: 2, ...correlation },
    {
      key: 'volatility',
      max: 2,
      available: gamma.available && volatility.available,
      points: gamma.available && volatility.available ? gamma.points + volatility.points : null,
    },
    { key: 'structure', max: 2, ...structure },
  ];
  const missing = domains.filter((domain) => !domain.available).map((domain) => domain.key);
  const scoreReady = eligibilityPassed && missing.length === 0;
  const score = scoreReady
    ? domains.reduce((total, domain) => total + domain.points, 0)
    : null;
  const band = score == null ? null : score >= 6 ? 'high' : score >= 3 ? 'mixed' : 'low';

  return {
    version: 'v0.1',
    maxScore: SPX_CONFLUENCE_MAX_SCORE,
    score,
    band,
    scoreReady,
    eligibilityPassed,
    status: !eligibilityPassed ? 'blocked' : scoreReady ? 'scored' : 'incomplete',
    blockers,
    missing,
    direction,
    side,
    tradeDirection,
    trendDirection,
    exactTrade,
    exactTrend,
    geometry,
    correlation,
    gamma,
    volatility,
    structure,
    domains,
  };
}
