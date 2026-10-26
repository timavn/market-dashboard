/**
 * Pure, deterministic signal-weighted position sizing.
 *
 * All weight values are percentage points of NLV: `2` means 2% and `0.5`
 * means 50 basis points. The module only returns read-only recommendations;
 * it has no order-routing side effects.
 */
export const SIZING_CONSTANTS = Object.freeze({
  MIN_ATR_OBSERVATIONS: 14,
  // A stop STOP_ATR_MULTIPLE ATRs away costs MIN_/MAX_STOP_LOSS_PCT_NLV of NLV
  // at MIN and MAX. MAX_POSITION_WEIGHT sets an ATR floor for quiet securities.
  STOP_ATR_MULTIPLE: 2,
  MIN_STOP_LOSS_PCT_NLV: 0.125,
  MAX_STOP_LOSS_PCT_NLV: 0.25,
  MAX_POSITION_WEIGHT: 10,
  WEIGHT_INCREMENT: 0.25,
  NORMAL_STEP: 0.5,
  ACCELERATED_STEP: 1,
  RANGE_CONVICTION_WEIGHT: 0.2,
  STRUCTURE_CONVICTION_WEIGHT: 0.3,
  RECORD_CONVICTION_WEIGHT: 0.5,
  MAX_STREAK: 5,
  MAX_QUOTE_AGE_SECONDS: 60,
  MAX_NLV_AGE_SECONDS: 60,
});

const PROHIBITED_LIVE_TOKENS = /\b(delayed|frozen|stale|cache(?:d|-only)?|mock|seed(?:ed)?|fallback|offline|disconnected|historical|synthetic|inferred|derived)\b/i;

function finite(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function positive(value) {
  const parsed = finite(value);
  return parsed != null && parsed > 0 ? parsed : null;
}

function metricValue(metric) {
  return finite(metric && typeof metric === 'object' ? metric.value : metric);
}

function metricProvenance(metric, fallback = null) {
  if (metric && typeof metric === 'object') {
    const { value: _value, ...metadata } = metric;
    return { ...metadata };
  }
  return fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function roundUnits(value, increment, method) {
  const units = value / increment;
  return Number((method(units + (method === Math.floor ? 1e-10 : method === Math.ceil ? -1e-10 : 0)) * increment).toFixed(10));
}

export function roundWeightUp(value, increment = SIZING_CONSTANTS.WEIGHT_INCREMENT) {
  return roundUnits(value, increment, Math.ceil);
}

export function roundWeightDown(value, increment = SIZING_CONSTANTS.WEIGHT_INCREMENT) {
  return roundUnits(value, increment, Math.floor);
}

export function roundWeightNearest(value, increment = SIZING_CONSTANTS.WEIGHT_INCREMENT) {
  return roundUnits(value, increment, Math.round);
}

export function normalizeBias(value) {
  const normalized = String(value || '').trim().toUpperCase();
  if (['LONG', 'BULL', 'BULLISH'].includes(normalized)) return 'LONG';
  if (['SHORT', 'BEAR', 'BEARISH'].includes(normalized)) return 'SHORT';
  return null;
}

export function normalizeSignal(value) {
  const side = normalizeBias(value);
  if (side) return side;
  const normalized = String(value || '').trim().toUpperCase();
  if (['NEUTRAL', 'FLAT'].includes(normalized)) return 'NEUTRAL';
  return null;
}

/** The ATR floor at which MAX reaches MAX_POSITION_WEIGHT, as a fraction of price. */
export const ATR_FLOOR = SIZING_CONSTANTS.MAX_STOP_LOSS_PCT_NLV
  / (SIZING_CONSTANTS.STOP_ATR_MULTIPLE * SIZING_CONSTANTS.MAX_POSITION_WEIGHT);

/** Stop price STOP_ATR_MULTIPLE ATRs against the side from a basis price. */
export function calculateStopPrice({ basis, atr14, side } = {}) {
  const price = positive(basis);
  const atr = positive(metricValue(atr14));
  const direction = normalizeBias(side);
  if (price == null || atr == null || !direction) return null;
  const stop = price + (direction === 'SHORT' ? 1 : -1) * SIZING_CONSTANTS.STOP_ATR_MULTIPLE * atr;
  return stop > 0 ? stop : null;
}

/**
 * Size each security from its own volatility, in percentage points of NLV.
 * The stop sits STOP_ATR_MULTIPLE ATRs away, so MIN and MAX are the weights
 * whose stop-out costs MIN_ and MAX_STOP_LOSS_PCT_NLV. Below ATR_FLOOR the
 * floor sets the band, which caps MAX at MAX_POSITION_WEIGHT; the stop still
 * uses the measured ATR.
 */
export function calculateSizingBand({ atr14, spot } = {}) {
  const atr = positive(metricValue(atr14));
  const price = positive(spot);
  if (atr == null || price == null) {
    return {
      available: false,
      reason: atr == null ? 'ATR_UNAVAILABLE' : 'SPOT_UNAVAILABLE',
      atr14: atr,
      spot: price,
      relativeAtr: null,
      effectiveRelativeAtr: null,
      floorApplied: false,
      stopDistance: null,
      rawMinWeight: null,
      rawMaxWeight: null,
      minWeight: null,
      maxWeight: null,
      riskBlocked: false,
      unit: 'percentage-points',
    };
  }
  const relativeAtr = atr / price;
  const effectiveRelativeAtr = Math.max(relativeAtr, ATR_FLOOR);
  const sizingStopDistance = SIZING_CONSTANTS.STOP_ATR_MULTIPLE * effectiveRelativeAtr;
  const rawMinWeight = SIZING_CONSTANTS.MIN_STOP_LOSS_PCT_NLV / sizingStopDistance;
  const rawMaxWeight = SIZING_CONSTANTS.MAX_STOP_LOSS_PCT_NLV / sizingStopDistance;
  const minWeight = roundWeightUp(rawMinWeight);
  const maxWeight = roundWeightDown(rawMaxWeight);
  return {
    available: true,
    reason: null,
    atr14: atr,
    spot: price,
    relativeAtr,
    effectiveRelativeAtr,
    floorApplied: relativeAtr < ATR_FLOOR,
    stopDistance: SIZING_CONSTANTS.STOP_ATR_MULTIPLE * relativeAtr,
    rawMinWeight,
    rawMaxWeight,
    minWeight,
    maxWeight,
    // Only an ATR near half the price leaves no increment between MIN and MAX.
    riskBlocked: maxWeight < minWeight,
    unit: 'percentage-points',
  };
}

/** NLV percentage points lost if a position of `weight` reaches its stop. */
export function stopLossPctNlv(weight, stopDistance) {
  const size = finite(weight);
  const distance = finite(stopDistance);
  return size == null || distance == null ? null : Math.abs(size) * distance;
}

function hasSource(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasAsOf(value) {
  return Number.isFinite(timestampMillis(value));
}

function validateDatedMetric(metric, {
  prefix,
  minimumObservations,
  requireValue = true,
} = {}) {
  const blockers = [];
  if (!metric || typeof metric !== 'object') return [`${prefix}_PROVENANCE_UNAVAILABLE`];
  if (requireValue && metricValue(metric) == null) blockers.push(`${prefix}_UNAVAILABLE`);
  if (!hasSource(metric.source)) blockers.push(`${prefix}_SOURCE_UNAVAILABLE`);
  if (!hasAsOf(metric.asOf)) blockers.push(`${prefix}_AS_OF_UNAVAILABLE`);
  const observations = finite(metric.observations);
  if (observations == null || observations < minimumObservations) {
    blockers.push(`${prefix}_OBSERVATIONS_UNAVAILABLE`);
  }
  return blockers;
}

/** Required research inputs must be attributable before an executable output is allowed. */
export function validateResearchProvenance(input = {}) {
  const provenance = input.provenance || {};
  const blockers = [
    ...validateDatedMetric(input.atr14, {
      prefix: 'ATR',
      minimumObservations: SIZING_CONSTANTS.MIN_ATR_OBSERVATIONS,
    }),
  ];

  const requireDatedSource = (value, prefix, minimumObservations = null) => {
    if (!value || typeof value !== 'object') {
      blockers.push(`${prefix}_PROVENANCE_UNAVAILABLE`);
      return;
    }
    if (!hasSource(value.source)) blockers.push(`${prefix}_SOURCE_UNAVAILABLE`);
    if (!hasAsOf(value.asOf)) blockers.push(`${prefix}_AS_OF_UNAVAILABLE`);
    if (minimumObservations != null) {
      const observations = finite(value.observations);
      if (observations == null || observations < minimumObservations) {
        blockers.push(`${prefix}_OBSERVATIONS_UNAVAILABLE`);
      }
    }
  };

  requireDatedSource(provenance.signals?.trade, 'TRADE');
  requireDatedSource(provenance.signals?.trend, 'TREND');
  requireDatedSource(provenance.range, 'RANGE', 1);

  const trade = normalizeSignal(input.tradeSignal);
  const trend = normalizeSignal(input.trendSignal);
  const alignedSignalBias = trade && trade === trend ? normalizeBias(trade) : null;
  const bias = normalizeBias(input.position?.side ?? input.positionSide ?? input.bias) || alignedSignalBias;
  const recordRequired = bias === 'SHORT'
    ? finite(input.priorAtl ?? input.records?.priorAllTimeLow) != null
    : finite(input.priorAth ?? input.records?.priorAllTimeHigh) != null;
  if (recordRequired) requireDatedSource(provenance.records, 'RECORDS', 1);

  return {
    available: blockers.length === 0,
    blockers: unique(blockers),
  };
}

/** V1 quantity output supports verified spot-like stock and ETF contracts. */
export function validateInstrumentContext(instrument = {}) {
  const blockers = [];
  const value = instrument || {};
  const source = String(value.source || '').trim().toLowerCase();
  const securityType = String(value.securityType || value.secType || '').trim().toUpperCase();
  const currency = String(value.currency || '').trim().toUpperCase();
  const multiplier = positive(value.multiplier);
  const lotSize = positive(value.lotSize);

  if (source !== 'ibkr' || value.verified !== true) blockers.push('INSTRUMENT_NOT_VERIFIED_IBKR');
  if (value.tradable !== true) blockers.push('INSTRUMENT_NOT_TRADABLE');
  if (!['STK', 'ETF'].includes(securityType)) blockers.push('UNSUPPORTED_INSTRUMENT');
  if (currency !== 'USD') blockers.push('UNSUPPORTED_INSTRUMENT_CURRENCY');
  if (multiplier == null) blockers.push('INSTRUMENT_MULTIPLIER_UNAVAILABLE');
  if (lotSize == null || !Number.isInteger(lotSize)) blockers.push('INSTRUMENT_LOT_SIZE_UNAVAILABLE');

  return {
    available: blockers.length === 0,
    blockers: unique(blockers),
    source: source || null,
    securityType: securityType || null,
    currency: currency || null,
    multiplier,
    lotSize,
  };
}

export function calculateRangePosition({ spot, lrr, hrr, bias } = {}) {
  const price = positive(spot);
  const low = positive(lrr);
  const high = positive(hrr);
  const side = normalizeBias(bias);
  if (price == null || low == null || high == null || high <= low) {
    return {
      available: false,
      position: null,
      inRange: false,
      favorableHalf: false,
      favorableProximity: null,
      reason: price == null ? 'SPOT_UNAVAILABLE' : 'RANGE_UNAVAILABLE',
    };
  }
  const position = (price - low) / (high - low);
  const inRange = position >= 0 && position <= 1;
  const favorableHalf = side === 'LONG'
    ? inRange && position <= 0.5
    : side === 'SHORT'
      ? inRange && position >= 0.5
      : false;
  const favorableProximity = side === 'LONG' && inRange && position <= 0.5
    ? 1 - 2 * position
    : side === 'SHORT' && inRange && position >= 0.5
      ? 2 * position - 1
      : side
        ? 0
        : null;
  return {
    available: true,
    position,
    inRange,
    favorableHalf,
    favorableProximity,
    reason: null,
  };
}

function isMissingEdition(row) {
  const status = String(row?.status || '').toLowerCase();
  return row?.missing === true || row?.available === false || ['missing', 'unavailable', 'error'].includes(status);
}

function businessDaysBetween(start, end) {
  const first = new Date(`${start}T00:00:00.000Z`);
  const last = new Date(`${end}T00:00:00.000Z`);
  if (!Number.isFinite(first.getTime()) || !Number.isFinite(last.getTime()) || last <= first) return 0;
  let count = 0;
  for (let cursor = first.getTime() + 86400000; cursor < last.getTime(); cursor += 86400000) {
    const day = new Date(cursor).getUTCDay();
    if (day !== 0 && day !== 6) count += 1;
  }
  return count;
}

function hasEditionGap(previous, current) {
  if (isMissingEdition(previous) || isMissingEdition(current)) return true;
  const previousSequence = finite(previous?.edition ?? previous?.sequence);
  const currentSequence = finite(current?.edition ?? current?.sequence);
  if (previousSequence != null && currentSequence != null && currentSequence !== previousSequence + 1) return true;
  if (previous?.date && current?.date && businessDaysBetween(previous.date, current.date) > 0) return true;
  return false;
}

function streak(history, key, comparator) {
  let count = 0;
  let available = false;
  for (let index = history.length - 1; index > 0 && count < SIZING_CONSTANTS.MAX_STREAK; index -= 1) {
    const currentRow = history[index];
    const previousRow = history[index - 1];
    if (hasEditionGap(previousRow, currentRow)) break;
    const current = finite(currentRow?.[key]);
    const previous = finite(previousRow?.[key]);
    if (current == null || previous == null) break;
    available = true;
    if (!comparator(current, previous)) break;
    count += 1;
  }
  return { count, available };
}

/** History is ordered oldest to newest. A streak counts consecutive comparisons. */
export function calculateDirectionalStreaks(rangeHistory = []) {
  const history = Array.isArray(rangeHistory) ? rangeHistory : [];
  const hh = streak(history, 'hrr', (current, previous) => current > previous);
  const lh = streak(history, 'hrr', (current, previous) => current < previous);
  const hl = streak(history, 'lrr', (current, previous) => current > previous);
  const ll = streak(history, 'lrr', (current, previous) => current < previous);
  return {
    higherHigh: hh.count,
    higherLow: hl.count,
    lowerHigh: lh.count,
    lowerLow: ll.count,
    availability: { hrr: hh.available || lh.available, lrr: hl.available || ll.available },
    maxStreak: SIZING_CONSTANTS.MAX_STREAK,
  };
}

export function calculateRecordSignal({ hrr, lrr, priorAth, priorAtl } = {}) {
  const high = finite(hrr);
  const low = finite(lrr);
  const ath = finite(priorAth);
  const atl = finite(priorAtl);
  const longAvailable = high != null && ath != null;
  const shortAvailable = low != null && atl != null;
  return {
    long: { available: longAvailable, extended: longAvailable ? high > ath : null },
    short: { available: shortAvailable, extended: shortAvailable ? low < atl : null },
  };
}

export function calculateConviction({ bias, range, streaks, record } = {}) {
  const side = normalizeBias(bias);
  const proximityAvailable = range?.available === true && range.favorableProximity != null;
  const proximityScore = proximityAvailable ? clamp(range.favorableProximity, 0, 1) : 0;
  const firstStreak = side === 'LONG' ? streaks?.higherHigh : streaks?.lowerHigh;
  const secondStreak = side === 'LONG' ? streaks?.higherLow : streaks?.lowerLow;
  const firstAvailable = side != null && streaks?.availability?.hrr === true;
  const secondAvailable = side != null && streaks?.availability?.lrr === true;
  const structureScore = (
    (firstAvailable ? clamp(finite(firstStreak) || 0, 0, SIZING_CONSTANTS.MAX_STREAK) : 0)
    + (secondAvailable ? clamp(finite(secondStreak) || 0, 0, SIZING_CONSTANTS.MAX_STREAK) : 0)
  ) / (2 * SIZING_CONSTANTS.MAX_STREAK);
  const selectedRecord = side === 'LONG' ? record?.long : side === 'SHORT' ? record?.short : null;
  const recordScore = selectedRecord?.available && selectedRecord.extended ? 1 : 0;
  const rangeWeighted = SIZING_CONSTANTS.RANGE_CONVICTION_WEIGHT * proximityScore;
  const structureWeighted = SIZING_CONSTANTS.STRUCTURE_CONVICTION_WEIGHT * structureScore;
  const recordWeighted = SIZING_CONSTANTS.RECORD_CONVICTION_WEIGHT * recordScore;
  const conviction = rangeWeighted + structureWeighted + recordWeighted;
  return {
    value: conviction,
    components: {
      range: { available: proximityAvailable, score: proximityScore, weighted: rangeWeighted },
      structure: {
        available: { first: firstAvailable, second: secondAvailable },
        score: structureScore,
        weighted: structureWeighted,
      },
      record: {
        available: selectedRecord?.available === true,
        active: selectedRecord?.available ? selectedRecord.extended : null,
        score: recordScore,
        weighted: recordWeighted,
      },
    },
  };
}

export function calculateTargetWeight({ minWeight, maxWeight, conviction } = {}) {
  const min = finite(minWeight);
  const max = finite(maxWeight);
  const score = finite(conviction);
  if (min == null || max == null || score == null || max < min) return null;
  const raw = min + clamp(score, 0, 1) * (max - min);
  const rounded = roundWeightNearest(raw);
  return clamp(rounded, min, roundWeightDown(max));
}

function liveMetadataText(context) {
  const accountSummary = context.accountSummary || {};
  return [
    context.warning,
    ...(Array.isArray(context.warnings) ? context.warnings : []),
    context.status,
    context.quoteMode,
    context.freshness,
    context.dataSource,
    context.dataType,
    context.quote?.warning,
    context.quote?.status,
    context.quote?.quoteMode,
    context.quote?.freshness,
    context.quote?.dataType,
    accountSummary.warning,
    ...(Array.isArray(accountSummary.warnings) ? accountSummary.warnings : []),
    accountSummary.status,
    accountSummary.freshness,
    accountSummary.dataType,
  ].filter(Boolean).join(' ');
}

function timestampMillis(value) {
  if (value instanceof Date) return value.getTime();
  const numeric = finite(value);
  if (numeric != null) return Math.abs(numeric) < 1e12 ? numeric * 1000 : numeric;
  return new Date(value || '').getTime();
}

function hasProhibitedLiveFlag(value = {}) {
  return Boolean(
    value.delayed || value.frozen || value.stale || value.cacheOnly || value.cached
    || value.mock || value.seed || value.seeded || value.fallback || value.historicalOnly
    || value.synthetic || value.inferred || value.derived || value.executable === false
  );
}

/** Validate the execution context without weakening historical research output. */
export function validateLiveContext({ liveContext = {}, spot, netLiquidationValue, now = null } = {}) {
  const blockers = [];
  const context = liveContext || {};
  const quote = context.quote || {};
  const accountSummary = context.accountSummary || {};
  const provider = String(quote.source || '').trim().toLowerCase();
  const accountProvider = String(accountSummary.source || '').trim().toLowerCase();
  const price = positive(spot);
  const quotePrice = positive(quote.price);
  const nlv = positive(netLiquidationValue);
  const accountNlv = positive(accountSummary.netLiquidationValue ?? accountSummary.nlv);
  const dataType = quote.dataType;
  const liveDataType = dataType === 1 || String(dataType || '').trim().toLowerCase() === 'live';
  const quoteTimestampMs = timestampMillis(quote.asOf || quote.timestamp);
  const nlvTimestampMs = timestampMillis(accountSummary.asOf || accountSummary.timestamp);
  const numericNow = finite(now);
  const nowMs = now instanceof Date
    ? now.getTime()
    : numericNow != null
      ? numericNow
      : new Date(now || '').getTime();
  const maxAgeSeconds = positive(context.maxQuoteAgeSeconds) || SIZING_CONSTANTS.MAX_QUOTE_AGE_SECONDS;
  const maxNlvAgeSeconds = positive(context.maxNlvAgeSeconds) || SIZING_CONSTANTS.MAX_NLV_AGE_SECONDS;
  const ageSeconds = Number.isFinite(quoteTimestampMs) && Number.isFinite(nowMs)
    ? (nowMs - quoteTimestampMs) / 1000
    : null;
  const nlvAgeSeconds = Number.isFinite(nlvTimestampMs) && Number.isFinite(nowMs)
    ? (nowMs - nlvTimestampMs) / 1000
    : null;

  if (context.connected !== true) blockers.push('IBKR_DISCONNECTED');
  if (provider !== 'ibkr') blockers.push('QUOTE_NOT_IBKR');
  if (price == null || quotePrice == null) blockers.push('LIVE_SPOT_UNAVAILABLE');
  if (price != null && quotePrice != null) {
    const toleranceBps = positive(context.spotToleranceBps) || 1;
    const tolerance = Math.max(0.01, quotePrice * toleranceBps / 10000);
    if (Math.abs(price - quotePrice) > tolerance) blockers.push('LIVE_SPOT_MISMATCH');
  }
  if (nlv == null || accountNlv == null) blockers.push('NLV_UNAVAILABLE');
  if (accountProvider !== 'ibkr' || accountSummary.verified !== true) blockers.push('NLV_NOT_VERIFIED_IBKR');
  if (nlv != null && accountNlv != null) {
    const toleranceBps = positive(context.nlvToleranceBps) || 0.1;
    const tolerance = Math.max(0.01, accountNlv * toleranceBps / 10000);
    if (Math.abs(nlv - accountNlv) > tolerance) blockers.push('LIVE_NLV_MISMATCH');
  }
  if (!Number.isFinite(nowMs)) blockers.push('VALIDATION_TIME_UNAVAILABLE');
  if (ageSeconds == null || ageSeconds < -5 || ageSeconds > maxAgeSeconds) blockers.push('QUOTE_STALE');
  if (nlvAgeSeconds == null || nlvAgeSeconds < -5 || nlvAgeSeconds > maxNlvAgeSeconds) blockers.push('NLV_STALE');
  if (!liveDataType) blockers.push('UNVERIFIED_LIVE_DATA');
  if (
    hasProhibitedLiveFlag(context) || hasProhibitedLiveFlag(quote) || hasProhibitedLiveFlag(accountSummary)
    || String(dataType || '').toLowerCase().startsWith('delayed')
    || PROHIBITED_LIVE_TOKENS.test(liveMetadataText(context).replace(/_/g, ' '))
  ) blockers.push('UNVERIFIED_LIVE_DATA');

  return {
    available: blockers.length === 0,
    blockers: [...new Set(blockers)],
    provider: provider || null,
    accountProvider: accountProvider || null,
    spot: price,
    netLiquidationValue: nlv,
    quoteAsOf: Number.isFinite(quoteTimestampMs) ? new Date(quoteTimestampMs).toISOString() : null,
    quoteAgeSeconds: ageSeconds,
    nlvAsOf: Number.isFinite(nlvTimestampMs) ? new Date(nlvTimestampMs).toISOString() : null,
    nlvAgeSeconds,
  };
}

function selectedStreaks(side, streaks) {
  return side === 'LONG'
    ? [streaks.higherHigh, streaks.higherLow]
    : [streaks.lowerHigh, streaks.lowerLow];
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

/**
 * Produce research and separately gated actionable recommendations.
 * The function never transmits orders and never substitutes non-live quote data.
 */
export function calculateSizingDecision(input = {}) {
  const sizingBand = calculateSizingBand({ atr14: input.atr14, spot: input.spot });
  const recordsInput = input.records || {};
  const priorAth = input.priorAth ?? recordsInput.priorAllTimeHigh;
  const priorAtl = input.priorAtl ?? recordsInput.priorAllTimeLow;
  const tradeSignal = normalizeSignal(input.tradeSignal);
  const trendSignal = normalizeSignal(input.trendSignal);
  const positionWeight = Math.abs(finite(input.position?.weight ?? input.currentWeight) || 0);
  const positionExists = input.position?.exists != null ? input.position.exists === true : positionWeight > 0;
  const positionSide = normalizeBias(input.position?.side ?? input.positionSide);
  const sharedSignalSide = tradeSignal && tradeSignal === trendSignal ? normalizeBias(tradeSignal) : null;
  const bias = (positionExists && positionSide)
    ? positionSide
    : normalizeBias(input.bias) || sharedSignalSide;
  const range = calculateRangePosition({ spot: input.spot, lrr: input.lrr, hrr: input.hrr, bias });
  const streaks = calculateDirectionalStreaks(input.riskRangeHistory);
  const record = calculateRecordSignal({ hrr: input.hrr, lrr: input.lrr, priorAth, priorAtl });
  const conviction = calculateConviction({ bias, range, streaks, record });
  const minWeight = sizingBand.minWeight;
  const maxWeight = sizingBand.maxWeight;
  const operationalMaxWeight = maxWeight;
  const riskBlocked = sizingBand.riskBlocked;
  const stop = {
    atrMultiple: SIZING_CONSTANTS.STOP_ATR_MULTIPLE,
    distance: sizingBand.stopDistance,
    price: calculateStopPrice({ basis: sizingBand.spot, atr14: sizingBand.atr14, side: bias }),
    lossAtMinPctNlv: stopLossPctNlv(minWeight, sizingBand.stopDistance),
    lossAtMaxPctNlv: stopLossPctNlv(maxWeight, sizingBand.stopDistance),
    unit: 'percentage-points',
  };
  const targetWeight = riskBlocked ? null : calculateTargetWeight({
    minWeight,
    maxWeight,
    conviction: conviction.value,
  });
  const signalDataComplete = Boolean(tradeSignal && trendSignal);
  const signalsAvailable = Boolean(bias && (tradeSignal || trendSignal));
  const tradeAvailable = Boolean(tradeSignal);
  const trendAvailable = Boolean(trendSignal);
  const tradeAligned = Boolean(bias && tradeSignal === bias);
  const trendAligned = Boolean(bias && trendSignal === bias);
  const tradeBroken = Boolean(bias && tradeAvailable && !tradeAligned);
  const trendBroken = Boolean(bias && trendAvailable && !trendAligned);
  const alignedCount = bias
    ? Number(tradeSignal === bias) + Number(trendSignal === bias)
    : null;
  const reversal = positionExists && positionSide && sharedSignalSide && sharedSignalSide !== positionSide;
  const researchReasons = [];
  let lifecycleState = 'WATCH';
  let researchAction = 'WATCH';
  let recommendedWeight = null;

  if (!sizingBand.available) researchReasons.push(sizingBand.reason);
  if (!bias) researchReasons.push('BIAS_UNAVAILABLE');
  if (!signalDataComplete) researchReasons.push('SIGNAL_DATA_INCOMPLETE');
  if (!range.available) researchReasons.push(range.reason);
  if (riskBlocked) researchReasons.push('VOLATILITY_TOO_HIGH_TO_SIZE');

  if (positionExists && tradeBroken) {
    lifecycleState = 'EXIT';
    researchAction = 'EXIT';
    recommendedWeight = 0;
    researchReasons.push(reversal ? 'REVERSAL_EXIT_FIRST' : 'TRADE_BREAK');
  } else if (riskBlocked) {
    lifecycleState = positionExists ? 'EXIT' : 'WATCH';
    researchAction = positionExists ? 'EXIT' : 'WATCH';
    recommendedWeight = positionExists ? 0 : null;
  } else if (positionExists && tradeAligned && trendBroken) {
    lifecycleState = 'BENCH';
    recommendedWeight = sizingBand.available ? Math.min(positionWeight, minWeight) : null;
    researchAction = sizingBand.available && positionWeight > minWeight ? 'REDUCE_TO_BENCH' : 'HOLD';
    researchReasons.push('TREND_BREAK_TRADE_ALIGNED');
    if (sizingBand.available && positionWeight < minWeight) researchReasons.push('BELOW_MIN_NO_RISK_INCREASE');
  } else if (positionExists && sizingBand.available && tradeAligned && trendAligned && range.available) {
    lifecycleState = 'ACTIVE';
    recommendedWeight = positionWeight;
    researchAction = 'HOLD';
    if (positionWeight > operationalMaxWeight) {
      recommendedWeight = operationalMaxWeight;
      researchAction = 'TRIM';
      researchReasons.push('ABOVE_EFFECTIVE_MAX');
    } else if (input.newRangeEdition === true && targetWeight != null) {
      const [firstStreak, secondStreak] = selectedStreaks(bias, streaks);
      const selectedRecord = bias === 'LONG' ? record.long : record.short;
      const accelerated = (selectedRecord.available && selectedRecord.extended)
        || (firstStreak >= 3 && secondStreak >= 3);
      const step = accelerated ? SIZING_CONSTANTS.ACCELERATED_STEP : SIZING_CONSTANTS.NORMAL_STEP;
      if (targetWeight < positionWeight) {
        recommendedWeight = Math.max(targetWeight, positionWeight - step);
        researchAction = 'TRIM';
      } else if (targetWeight > positionWeight && range.favorableHalf) {
        recommendedWeight = Math.min(targetWeight, positionWeight + step);
        researchAction = 'ADD';
      } else if (targetWeight > positionWeight) {
        researchReasons.push(range.inRange ? 'WRONG_RANGE_HALF' : 'OUT_OF_RANGE');
      }
    }
  } else if (!positionExists && sizingBand.available && tradeAligned && trendAligned && range.favorableHalf) {
    lifecycleState = 'ACTIVE';
    researchAction = 'OPEN';
    recommendedWeight = minWeight;
  } else if (!positionExists && bias && (!tradeAligned || !trendAligned)) {
    researchReasons.push('BOTH_SIGNALS_REQUIRED_TO_OPEN');
  } else if (!positionExists && range.available && !range.favorableHalf) {
    researchReasons.push(range.inRange ? 'WRONG_RANGE_HALF' : 'OUT_OF_RANGE');
  }

  if (recommendedWeight != null && recommendedWeight > 0 && operationalMaxWeight != null) {
    recommendedWeight = clamp(roundWeightNearest(recommendedWeight), 0, operationalMaxWeight);
  }

  const researchReady = !['WATCH'].includes(lifecycleState) && recommendedWeight != null;
  const research = {
    available: sizingBand.available && signalsAvailable,
    lifecycleState,
    action: researchAction,
    targetWeight,
    recommendedWeight,
    referenceMinWeight: minWeight,
    reasons: unique(researchReasons),
    unit: 'percentage-points',
  };

  const live = validateLiveContext({
    liveContext: input.liveContext,
    spot: input.spot,
    netLiquidationValue: input.netLiquidationValue,
    now: input.now,
  });
  const researchProvenance = validateResearchProvenance(input);
  const instrument = validateInstrumentContext(input.instrument);
  const actionableReady = live.available
    && researchReady
    && signalDataComplete
    && sizingBand.available
    && researchProvenance.available
    && instrument.available;
  const direction = bias === 'SHORT' ? -1 : 1;
  const signedWeight = actionableReady ? direction * recommendedWeight : null;
  const targetNotional = actionableReady ? live.netLiquidationValue * signedWeight / 100 : null;
  const targetShares = actionableReady && live.spot && instrument.multiplier && instrument.lotSize
    ? direction * (
      Math.floor(Math.abs(targetNotional) / (live.spot * instrument.multiplier * instrument.lotSize))
      * instrument.lotSize
    )
    : null;
  const actionable = {
    available: actionableReady,
    action: actionableReady ? researchAction : null,
    recommendedWeight: actionableReady ? recommendedWeight : null,
    signedWeight,
    targetNotional,
    targetShares,
    blockers: actionableReady ? [] : unique([
      ...live.blockers,
      ...(!researchReady ? ['RESEARCH_DECISION_UNAVAILABLE'] : []),
      ...(!signalDataComplete ? ['SIGNAL_DATA_INCOMPLETE'] : []),
      ...(!sizingBand.available ? ['ATR_SIZING_UNAVAILABLE'] : []),
      ...researchProvenance.blockers,
      ...instrument.blockers,
    ]),
    readOnly: true,
    orderTransmissionAllowed: false,
    unit: 'percentage-points',
  };

  const suppliedProvenance = input.provenance || {};
  const provenance = {
    atr: metricProvenance(input.atr14, suppliedProvenance.atr || null),
    signals: suppliedProvenance.signals || { trade: null, trend: null },
    range: suppliedProvenance.range || null,
    records: metricProvenance(input.records, suppliedProvenance.records || null),
    quote: suppliedProvenance.quote || {
      source: live.provider,
      asOf: live.quoteAsOf,
      ageSeconds: live.quoteAgeSeconds,
    },
    nlv: suppliedProvenance.nlv || {
      source: live.accountProvider,
      asOf: live.nlvAsOf,
      ageSeconds: live.nlvAgeSeconds,
    },
    instrument: suppliedProvenance.instrument || {
      source: instrument.source,
      securityType: instrument.securityType,
      currency: instrument.currency,
      multiplier: instrument.multiplier,
      lotSize: instrument.lotSize,
      verified: instrument.available,
    },
  };

  return {
    rawMinWeight: sizingBand.rawMinWeight,
    rawMaxWeight: sizingBand.rawMaxWeight,
    sizingBand,
    minWeight,
    stop,
    maxWeight,
    operationalMaxWeight,
    riskBlocked,
    rangePosition: range.position,
    range,
    streaks,
    record,
    conviction: conviction.value,
    strengthInputs: conviction.components,
    targetWeight,
    lifecycleState,
    action: actionable.action,
    reasons: unique([...research.reasons, ...actionable.blockers]),
    bias,
    tradeSignal,
    trendSignal,
    alignedSignalCount: alignedCount,
    tradeAligned,
    trendAligned,
    tradeBroken,
    trendBroken,
    signalDataComplete,
    research,
    actionable,
    researchProvenance,
    instrument,
    provenance,
    unit: 'percentage-points',
  };
}
