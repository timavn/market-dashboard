const SUPPORTED_CURRENCY = 'USD';
const SUPPORTED_POSITION_SCOPE = 'stocks_only';
const FIXED_POLICY_BUFFER = 2000;
const NLV_POLICY_BUFFER_RATE = 0.01;
const DEFAULT_SHORT_ADVERSE_MOVE_RATE = 0.05;
const MIN_SHORT_ADVERSE_MOVE_RATE = 0.05;
const MAX_SHORT_ADVERSE_MOVE_RATE = 2;
const SHORT_COLLATERAL_MARKUP_RATE = 1.02;
const COMPARISON_EPSILON = 1e-8;
const SHORT_SNAPSHOT_MAX_AGE_MS = 60 * 1000;
const SHORT_EVIDENCE_ABSOLUTE_TOLERANCE = 1000;
const SHORT_EVIDENCE_RELATIVE_TOLERANCE = 0.05;
const SHORT_EVIDENCE_DEFICIT_MAX_TOLERANCE = 100;
const SHORT_EVIDENCE_DEFICIT_RELATIVE_TOLERANCE = 0.001;
const VERIFIED_CURRENT_PRICE_SOURCE = 'ibkr_ticker_direct_max';
const VERIFIED_PRIOR_CLOSE_SOURCES = new Set([
  'ibkr_live_tick_close',
  'ibkr_historical_daily_close',
]);
const VERIFIED_REFERENCE_SOURCE = 'ibkr_completed_session_reference';
const VERIFIED_REFERENCE_CLOSE_SOURCE = 'ibkr_historical_daily_close';
const VERIFIED_REFERENCE_KIND =
  'completed_market_session_with_current_settlement_ladder';
const VERIFIED_REFERENCE_SETTLEMENT =
  'reference_segment_ladders_double_snapshot';

const SUPPORTED_STOCK_SCOPES = new Set([
  'stock',
  'stocks',
  'stock_only',
  'stocks_only',
  'stk',
]);

function asFiniteNumber(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value !== 'string' || value.trim() === '') {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeCurrency(value) {
  return typeof value === 'string' ? value.trim().toUpperCase() : '';
}

function normalizePositionScope(value) {
  if (typeof value !== 'string') {
    return '';
  }

  return value.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function normalizeConId(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  }
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  if (!/^\d+$/.test(normalized) || /^0+$/.test(normalized)) {
    return null;
  }
  return normalized.replace(/^0+(?=\d)/, '');
}

function hasOwn(object, property) {
  return Object.prototype.hasOwnProperty.call(object, property);
}

function parseTimestampMs(value) {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return null;
  }

  const parsed =
    typeof value === 'number'
      ? value
      : /^\d+(?:\.\d+)?$/.test(value.trim())
        ? Number(value)
        : Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  // Accept either Unix seconds or milliseconds without consulting wall time,
  // so the calculator remains deterministic.
  return parsed < 1e11 ? parsed * 1000 : parsed;
}

function isDateKey(value) {
  return /^\d{8}$/.test(value) || /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isReferenceDate(value) {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
  );
}

/**
 * Parses the normalized object form or IBKR's compact
 * `YYYYMMDD:amount;YYYYMMDD:amount` representation.
 */
function parseSettledCashByDate(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }

    if (trimmed.startsWith('{')) {
      try {
        return parseSettledCashByDate(JSON.parse(trimmed));
      } catch (_error) {
        return null;
      }
    }

    const entries = trimmed.split(/[;,|]/).map((entry) => entry.trim());
    if (entries.length === 0 || entries.some((entry) => entry === '')) {
      return null;
    }

    const parsed = {};
    for (const entry of entries) {
      const match = entry.match(
        /^(\d{8}|\d{4}-\d{2}-\d{2})\s*[:=]\s*([-+]?(?:\d+(?:\.\d*)?|\.\d+))$/,
      );
      if (!match) {
        return null;
      }

      const balance = asFiniteNumber(match[2]);
      if (balance === null) {
        return null;
      }
      parsed[match[1]] = balance;
    }

    return parsed;
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const entries = Object.entries(value);
  if (entries.length === 0) {
    return null;
  }

  const parsed = {};
  for (const [date, rawBalance] of entries) {
    if (!isDateKey(date)) {
      return null;
    }

    const balance = asFiniteNumber(rawBalance);
    if (balance === null) {
      return null;
    }
    parsed[date] = balance;
  }

  return parsed;
}

function normalizedSettlementDate(value) {
  const match = String(value || '').match(
    /^(\d{4})-?(\d{2})-?(\d{2})$/,
  );
  if (!match) return null;
  const isoDate = `${match[1]}-${match[2]}-${match[3]}`;
  return Number.isFinite(Date.parse(`${isoDate}T00:00:00Z`))
    ? isoDate
    : null;
}

function latestSettlementEntry(ledger) {
  return Object.entries(ledger).reduce((latest, entry) => {
    const normalizedDate = normalizedSettlementDate(entry[0]);
    if (!normalizedDate) return latest;
    if (!latest || normalizedDate > latest.date) {
      return { date: normalizedDate, balance: entry[1] };
    }
    return latest;
  }, null);
}

function makeUnavailable(errors, metadata = {}) {
  const reasons = Array.from(new Set(errors));
  const result = {
    available: false,
    status: 'unavailable',
    reason: reasons[0] || 'invalid_funding_payload',
    reasons,
    currency: metadata.currency || null,
    positionScope: metadata.positionScope || null,
    rawHeadroom: null,
    guardedHeadroom: null,
    addLongAllowed: null,
    longTrimNeeded: null,
    longMV: null,
    shortMV: null,
    worstSettlementDate: null,
    worstSettlementBalance: null,
    eligibleProjectedCash: null,
    commodityResidual: null,
    adjustmentForSecuritiesDeficit: null,
    brokerAdjustedCash: null,
    adjustedCashSecurities: null,
    collateral: null,
    shortCollateral: null,
    policyBuffer: null,
    shortEvidenceMarketValue: null,
    shortExposureEvidenceTolerance: null,
    shortExposureEvidenceDeficitTolerance: null,
    shortExposureEvidenceSurplusTolerance: null,
  };

  result.scenario = () => ({
    available: false,
    status: 'unavailable',
    reason: 'baseline_unavailable',
    reasons,
  });
  result.projectScenario = result.scenario;

  return result;
}

function calculatePositionCollateral(
  shortPositions,
  shortAdverseMoveRate = DEFAULT_SHORT_ADVERSE_MOVE_RATE,
) {
  let exact = 0;
  let unroundedCloseBasis = 0;
  let stressDelta = 0;
  const positions = [];

  for (const position of shortPositions) {
    const quantity = Math.abs(asFiniteNumber(position.quantity));
    const priorClose = asFiniteNumber(position.priorClose);
    const currentPrice = asFiniteNumber(position.currentPrice);
    const directBid = asFiniteNumber(position.directBid);
    const directAsk = asFiniteNumber(position.directAsk);
    const directLast = asFiniteNumber(position.directLast);
    const stressReferencePrice = Math.max(priorClose, currentPrice);
    const roundedCollateralPrice = Math.ceil(
      priorClose * SHORT_COLLATERAL_MARKUP_RATE,
    );
    const stressedRoundedPrice = Math.ceil(
      stressReferencePrice *
        (1 + shortAdverseMoveRate) *
        SHORT_COLLATERAL_MARKUP_RATE,
    );
    const positionCollateral = quantity * roundedCollateralPrice;
    const positionCloseBasis = quantity * priorClose;
    const positionStressDelta =
      quantity * (stressedRoundedPrice - roundedCollateralPrice);

    exact += positionCollateral;
    unroundedCloseBasis += positionCloseBasis;
    stressDelta += positionStressDelta;
    positions.push({
      conId: normalizeConId(position.conId),
      symbol:
        typeof position.symbol === 'string' && position.symbol.trim()
          ? position.symbol.trim()
          : null,
      quantity,
      priorClose,
      currentPrice,
      directBid,
      directAsk,
      directLast,
      currency: normalizeCurrency(position.currency),
      priorCloseSource:
        typeof position.priorCloseSource === 'string'
          ? position.priorCloseSource
          : null,
      priorCloseSessionDate: position.priorCloseSessionDate || null,
      priorCloseObservedAt: position.priorCloseObservedAt || null,
      currentPriceSource:
        typeof position.currentPriceSource === 'string'
          ? position.currentPriceSource
          : null,
      stressReferencePrice,
      roundedCollateralPrice,
      stressedRoundedPrice,
      collateral: positionCollateral,
      unroundedCloseBasis: positionCloseBasis,
      stressDelta: positionStressDelta,
    });
  }

  return {
    exact,
    unroundedCloseBasis,
    stressDelta,
    positions,
  };
}

function calculateReferencePositionCollateral(
  shortPositionReferences,
  shortAdverseMoveRate = DEFAULT_SHORT_ADVERSE_MOVE_RATE,
) {
  let exact = 0;
  let unroundedCloseBasis = 0;
  let stressDelta = 0;
  const positions = [];

  for (const position of shortPositionReferences) {
    const quantity = Math.abs(asFiniteNumber(position.quantity));
    const referenceClose = asFiniteNumber(position.referenceClose);
    const roundedCollateralPrice = Math.ceil(
      referenceClose * SHORT_COLLATERAL_MARKUP_RATE,
    );
    const stressedRoundedPrice = Math.ceil(
      referenceClose *
        (1 + shortAdverseMoveRate) *
        SHORT_COLLATERAL_MARKUP_RATE,
    );
    const positionCollateral = quantity * roundedCollateralPrice;
    const positionCloseBasis = quantity * referenceClose;
    const positionStressDelta =
      quantity * (stressedRoundedPrice - roundedCollateralPrice);

    exact += positionCollateral;
    unroundedCloseBasis += positionCloseBasis;
    stressDelta += positionStressDelta;
    positions.push({
      conId: normalizeConId(position.conId),
      symbol:
        typeof position.symbol === 'string' && position.symbol.trim()
          ? position.symbol.trim()
          : null,
      quantity,
      referenceClose,
      currency: normalizeCurrency(position.currency),
      referenceCloseSource: position.referenceCloseSource,
      referenceCloseSessionDate: position.referenceCloseSessionDate,
      referenceCloseObservedAt: position.referenceCloseObservedAt,
      roundedCollateralPrice,
      stressedRoundedPrice,
      collateral: positionCollateral,
      unroundedCloseBasis: positionCloseBasis,
      stressDelta: positionStressDelta,
    });
  }

  return {
    exact,
    unroundedCloseBasis,
    stressDelta,
    positions,
  };
}

function normalizeScenarioType(value) {
  return typeof value === 'string'
    ? value.trim().toLowerCase().replace(/[\s-]+/g, '_')
    : '';
}

function calculateSegmentCash(
  securitiesCash,
  commodityResidual,
  shortCollateral,
) {
  // The currently supported account scope has no IBUKL segment.
  const ibuklSettledCash = 0;
  const combinedSecuritiesCash = securitiesCash + ibuklSettledCash;
  const securitiesCashDeficit =
    combinedSecuritiesCash < 0 ? -combinedSecuritiesCash : 0;
  const adjustmentForSecuritiesDeficit = Math.min(
    securitiesCashDeficit,
    commodityResidual,
  );
  const eligibleProjectedCash =
    securitiesCash + adjustmentForSecuritiesDeficit + ibuklSettledCash;
  const brokerAdjustedCash =
    eligibleProjectedCash - shortCollateral;
  const commodityResidualAfterAdjustment =
    commodityResidual - adjustmentForSecuritiesDeficit;

  return {
    ibuklSettledCash,
    securitiesCashDeficit,
    adjustmentForSecuritiesDeficit,
    commodityTransferApplied: adjustmentForSecuritiesDeficit,
    commodityResidual,
    commodityResidualAfterAdjustment,
    commodityCashExcluded: Math.max(0, commodityResidualAfterAdjustment),
    eligibleProjectedCash,
    brokerAdjustedCash,
    adjustedCashSecurities: brokerAdjustedCash,
  };
}

function scenarioUnavailable(reason) {
  return {
    available: false,
    status: 'unavailable',
    reason,
  };
}

function calculateLongSizing(
  securitiesCash,
  commodityResidual,
  shortCollateral,
  accruedCashReserve,
  policyBuffer,
) {
  // A positive guarded balance necessarily requires a positive securities
  // balance; positive commodities cash only cures a securities deficit and
  // does not fund the safety reserve. A negative commodity residual does raise
  // the securities cash required to reach the guard.
  const requiredSecuritiesCashForGuard =
    shortCollateral +
    accruedCashReserve +
    policyBuffer.total -
    Math.min(0, commodityResidual);
  const securitiesCashDistanceToGuard =
    securitiesCash - requiredSecuritiesCashForGuard;

  return {
    requiredSecuritiesCashForGuard,
    securitiesCashDistanceToGuard,
    addLongAllowed: Math.max(0, securitiesCashDistanceToGuard),
    longTrimNeeded: Math.max(0, -securitiesCashDistanceToGuard),
  };
}

function scenarioResult(baseline, details) {
  const collateral = baseline.collateral + details.deltaCollateral;
  const securitiesCashFloor =
    baseline.securitiesCashFloor + details.deltaSettledCash;
  const segmentCash = calculateSegmentCash(
    securitiesCashFloor,
    baseline.commodityResidual,
    collateral,
  );
  const rawHeadroom =
    segmentCash.brokerAdjustedCash -
    baseline.negativeAccruedCashReserve;
  const deltaRawHeadroom = rawHeadroom - baseline.rawHeadroom;
  const shortShock = Math.max(
    0,
    baseline.policyBuffer.shortShock + details.deltaShortShock,
  );
  const policyBuffer = {
    ...baseline.policyBuffer,
    shortShock,
    total: baseline.policyBuffer.base + shortShock,
  };
  const guardedHeadroom = rawHeadroom - policyBuffer.total;
  const longSizing = calculateLongSizing(
    securitiesCashFloor,
    baseline.commodityResidual,
    collateral,
    baseline.negativeAccruedCashReserve,
    policyBuffer,
  );
  const longMV = baseline.longMV + details.deltaLongMV;
  const shortMV = baseline.shortMV + details.deltaShortMV;

  return {
    available: true,
    status: guardedHeadroom >= 0 ? 'within_guard' : 'trim_required',
    type: details.type,
    rawHeadroom,
    guardedHeadroom,
    ...longSizing,
    timing: 'post_settlement',
    projectionTiming: 'post_settlement',
    improvesOnlyAfterSettlement:
      details.type === 'trim_long' || details.type === 'cover_short',
    settledCashChange: details.deltaSettledCash,
    securitiesCashFloor,
    ...segmentCash,
    negativeAccruedCashReserve: baseline.negativeAccruedCashReserve,
    deltaRawHeadroom,
    deltaPolicyBuffer: details.deltaShortShock,
    deltaGuardedHeadroom:
      deltaRawHeadroom - details.deltaShortShock,
    longMV,
    shortMV,
    grossMV: longMV + shortMV,
    netMV: longMV - shortMV,
    policyBuffer,
    collateral,
    shortCollateral: collateral,
    ...details.output,
  };
}

/**
 * Projects a single planned trade against an already validated baseline.
 *
 * Long scenarios accept `{ type, amount }`.
 * Both short scenarios accept only `{ type, conId, quantity, limitPrice }`.
 * They can increase or cover an existing verified short; market evidence,
 * currency, collateral, and stress inputs are derived from that exact baseline
 * position. The user-supplied limit is used only as the conservative
 * cash-proceeds/cost bound if the order fills at that price or better. There
 * is intentionally no generic "safe short capacity" or market-order sizing.
 */
function projectIbkrCashBorrowingScenario(baseline, scenario) {
  if (
    baseline?.referenceOnly === true
    || baseline?.status === 'reference'
    || baseline?.actionable === false
  ) {
    return scenarioUnavailable('reference_not_actionable');
  }
  if (
    !baseline
    || baseline.available !== true
    || baseline.actionable !== true
  ) {
    return scenarioUnavailable('baseline_unavailable');
  }
  if (!scenario || typeof scenario !== 'object' || Array.isArray(scenario)) {
    return scenarioUnavailable('invalid_scenario');
  }

  const type = normalizeScenarioType(scenario.type);
  if (type === 'add_long' || type === 'trim_long') {
    const amount = asFiniteNumber(
      scenario.amount === undefined ? scenario.notional : scenario.amount,
    );
    if (amount === null || amount <= 0) {
      return scenarioUnavailable('invalid_long_notional');
    }

    const direction = type === 'add_long' ? -1 : 1;
    if (
      type === 'trim_long' &&
      amount > baseline.longMV + COMPARISON_EPSILON
    ) {
      return scenarioUnavailable('trim_exceeds_validated_long_baseline');
    }
    return scenarioResult(baseline, {
      type,
      deltaSettledCash: direction * amount,
      deltaShortShock: 0,
      deltaCollateral: 0,
      deltaLongMV: -direction * amount,
      deltaShortMV: 0,
      output: {
        amount,
      },
    });
  }

  if (type === 'add_short' || type === 'cover_short') {
    const quantity = asFiniteNumber(scenario.quantity);
    if (quantity === null || quantity <= 0) {
      return scenarioUnavailable('short_trade_requires_quantity');
    }

    if (
      hasOwn(scenario, 'priorClose') ||
      hasOwn(scenario, 'currentPrice') ||
      hasOwn(scenario, 'currency') ||
      hasOwn(scenario, 'directBid') ||
      hasOwn(scenario, 'directAsk') ||
      hasOwn(scenario, 'directLast') ||
      hasOwn(scenario, 'roundedCollateralPrice') ||
      hasOwn(scenario, 'stressedRoundedPrice')
    ) {
      return scenarioUnavailable('short_trade_manual_pricing_not_allowed');
    }

    const limitPrice = asFiniteNumber(scenario.limitPrice);
    if (limitPrice === null || limitPrice <= 0) {
      return scenarioUnavailable('short_trade_requires_limit_price');
    }

    const conId = normalizeConId(scenario.conId);
    if (conId === null) {
      return scenarioUnavailable('short_trade_requires_verified_conid');
    }

    const verifiedPositions = Array.isArray(
      baseline.collateralBreakdown?.positions,
    )
      ? baseline.collateralBreakdown.positions
      : [];
    const matches = verifiedPositions.filter(
      (position) => position?.conId === conId,
    );
    if (matches.length === 0) {
      return scenarioUnavailable('short_trade_position_not_found');
    }
    if (matches.length !== 1) {
      return scenarioUnavailable('short_trade_position_ambiguous');
    }

    const position = matches[0];
    if (
      type === 'add_short' &&
      limitPrice > position.directBid + COMPARISON_EPSILON
    ) {
      return scenarioUnavailable('add_short_limit_above_live_bid');
    }
    if (
      type === 'cover_short' &&
      limitPrice + COMPARISON_EPSILON < position.directAsk
    ) {
      return scenarioUnavailable('cover_short_limit_below_live_ask');
    }
    if (
      type === 'cover_short' &&
      quantity > position.quantity + COMPARISON_EPSILON
    ) {
      return scenarioUnavailable(
        'cover_short_quantity_exceeds_verified_position',
      );
    }

    const collateral = quantity * position.roundedCollateralPrice;
    const markedNotional = quantity * position.currentPrice;
    const settledCashNotional = quantity * limitPrice;
    const shortShock =
      quantity *
      (position.stressedRoundedPrice - position.roundedCollateralPrice);
    if (
      type === 'cover_short' &&
      markedNotional > baseline.shortMV + COMPARISON_EPSILON
    ) {
      return scenarioUnavailable(
        'cover_short_exceeds_validated_short_exposure',
      );
    }
    const direction = type === 'add_short' ? 1 : -1;

    return scenarioResult(baseline, {
      type,
      deltaSettledCash: direction * settledCashNotional,
      deltaShortShock: direction * shortShock,
      deltaCollateral: direction * collateral,
      deltaLongMV: 0,
      deltaShortMV: direction * markedNotional,
      output: {
        conId,
        symbol: position.symbol,
        quantity,
        limitPrice,
        orderType: 'limit',
        conditionalOnFill: true,
        fillCondition: 'limit_price_or_better',
        submissionTiming: 'immediate_live_snapshot',
        marketOrderSupported: false,
        priorClose: position.priorClose,
        currentPrice: position.currentPrice,
        directBid: position.directBid,
        directAsk: position.directAsk,
        directLast: position.directLast,
        currency: position.currency,
        stressReferencePrice: position.stressReferencePrice,
        roundedCollateralPrice: position.roundedCollateralPrice,
        stressedRoundedPrice: position.stressedRoundedPrice,
        stressDelta: direction * shortShock,
        collateralChange: direction * collateral,
        ...(type === 'add_short'
          ? { shortSaleProceeds: settledCashNotional }
          : { coverCost: settledCashNotional }),
        shortMarketValueChange: direction * markedNotional,
        derivedFromVerifiedPosition: true,
      },
    });
  }

  return scenarioUnavailable('unsupported_scenario_type');
}

function buildCashBorrowingResult({
  numbers,
  settledCash,
  settledCommodityCash,
  collateralBreakdown,
  shortAdverseMoveRate,
  shortEvidenceMarketValue,
  shortExposureEvidenceTolerance,
  shortExposureEvidenceDeficitTolerance,
  shortExposureEvidenceSurplusTolerance,
  referenceMetadata = null,
}) {
  const settlementEntries = Object.entries(settledCash);
  const commoditySettlementEntries = Object.entries(settledCommodityCash);
  const [worstSettlementDate, worstSettlementBalance] =
    settlementEntries.reduce((worst, candidate) => {
      if (
        candidate[1] < worst[1] ||
        (candidate[1] === worst[1] && candidate[0] < worst[0])
      ) {
        return candidate;
      }
      return worst;
    });
  const [worstCommoditySettlementDate, worstCommoditySettlementBalance] =
    commoditySettlementEntries.reduce((worst, candidate) => {
      if (
        candidate[1] < worst[1] ||
        (candidate[1] === worst[1] && candidate[0] < worst[0])
      ) {
        return candidate;
      }
      return worst;
    });
  const settlementBalances = settlementEntries.map((entry) => entry[1]);
  const commoditySettlementBalances =
    commoditySettlementEntries.map((entry) => entry[1]);
  const securitiesCashFloor = Math.min(
    numbers.totalCashValueSecurities,
    ...settlementBalances,
  );
  const commodityCashFloor = Math.min(
    numbers.totalCashValueCommodities,
    ...commoditySettlementBalances,
  );
  const commodityResidual =
    commodityCashFloor -
    numbers.commodityMaintenanceMargin;
  const commodityExcessCash = Math.max(0, commodityResidual);
  const segmentCash = calculateSegmentCash(
    securitiesCashFloor,
    commodityResidual,
    collateralBreakdown.exact,
  );
  const negativeAccruedCashReserve = Math.max(
    0,
    -numbers.accruedCashSecurities,
  );
  const modelInterestReserve = Math.max(
    0,
    numbers.interestValidationReserve || 0,
  );
  const appliedInterestReserve = Math.max(
    negativeAccruedCashReserve,
    modelInterestReserve,
  );
  const interestReserve = {
    liveNegativeAccruedCash: negativeAccruedCashReserve,
    modelOutstandingUpper: modelInterestReserve,
    incrementalModelReserve: Math.max(
      0,
      modelInterestReserve - negativeAccruedCashReserve,
    ),
    applied: appliedInterestReserve,
  };
  const rawHeadroom =
    segmentCash.brokerAdjustedCash -
    appliedInterestReserve;

  const fixedOrNlvBuffer = Math.max(
    FIXED_POLICY_BUFFER,
    numbers.netLiquidation * NLV_POLICY_BUFFER_RATE,
  );
  const shortShock = collateralBreakdown.stressDelta;
  const policyBuffer = {
    fixedFloor: FIXED_POLICY_BUFFER,
    nlvRate: NLV_POLICY_BUFFER_RATE,
    nlvAmount: numbers.netLiquidation * NLV_POLICY_BUFFER_RATE,
    base: fixedOrNlvBuffer,
    shortAdverseMoveRate,
    shortShockCalculation: 'per_share_ceiling_delta',
    shortShock,
    total: fixedOrNlvBuffer + shortShock,
  };
  const guardedHeadroom = rawHeadroom - policyBuffer.total;
  const longSizing = calculateLongSizing(
    securitiesCashFloor,
    commodityResidual,
    collateralBreakdown.exact,
    appliedInterestReserve,
    policyBuffer,
  );

  const longMV =
    (numbers.grossPositionValue + numbers.stockMarketValue) / 2;
  const shortMV =
    (numbers.grossPositionValue - numbers.stockMarketValue) / 2;
  const referenceOnly = Boolean(referenceMetadata);
  const headroomStatus =
    guardedHeadroom >= 0 ? 'within_guard' : 'trim_required';

  const result = {
    available: true,
    status: referenceOnly ? 'reference' : headroomStatus,
    headroomStatus,
    actionable: !referenceOnly,
    referenceOnly,
    currency: SUPPORTED_CURRENCY,
    baseCurrency: SUPPORTED_CURRENCY,
    positionScope: SUPPORTED_POSITION_SCOPE,
    longMV,
    shortMV,
    grossMV: numbers.grossPositionValue,
    netMV: numbers.stockMarketValue,
    securitiesCashFloor,
    settlementBalances,
    worstSettlementDate,
    worstSettlementBalance,
    commodityCashFloor,
    commoditySettlementBalances,
    worstCommoditySettlementDate,
    worstCommoditySettlementBalance,
    commodityExcessCash,
    ...segmentCash,
    negativeAccruedCashReserve: appliedInterestReserve,
    liveNegativeAccruedCashReserve: negativeAccruedCashReserve,
    modelInterestReserve,
    interestReserve,
    collateral: collateralBreakdown.exact,
    shortCollateral: collateralBreakdown.exact,
    collateralBreakdown,
    shortEvidenceMarketValue,
    shortExposureEvidenceTolerance,
    shortExposureEvidenceDeficitTolerance,
    shortExposureEvidenceSurplusTolerance,
    rawHeadroom,
    policyBuffer,
    guardedHeadroom,
    ...longSizing,
    ...(referenceMetadata || {}),
  };

  if (referenceOnly) {
    result.scenario = () => scenarioUnavailable('reference_not_actionable');
  } else {
    result.scenario = (scenario) =>
      projectIbkrCashBorrowingScenario(result, scenario);
  }
  result.projectScenario = result.scenario;

  return result;
}

/**
 * Calculates USD settled-cash headroom before an IBKR securities cash debit.
 * This is deliberately fail-closed: an unavailable result never publishes a
 * zero that could be mistaken for a verified sizing limit.
 */
function calculateIbkrCashBorrowing(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return makeUnavailable(['invalid_funding_payload']);
  }

  const errors = [];
  const currency = normalizeCurrency(payload.currency);
  const baseCurrency = normalizeCurrency(payload.baseCurrency);
  const positionScope = normalizePositionScope(payload.positionScope);
  let shortAdverseMoveRate = DEFAULT_SHORT_ADVERSE_MOVE_RATE;
  if (hasOwn(payload, 'policyShortAdverseMoveRate')) {
    const requestedRate = asFiniteNumber(payload.policyShortAdverseMoveRate);
    if (
      requestedRate === null ||
      requestedRate < MIN_SHORT_ADVERSE_MOVE_RATE ||
      requestedRate > MAX_SHORT_ADVERSE_MOVE_RATE
    ) {
      errors.push('invalid_policy_short_adverse_move_rate');
    } else {
      shortAdverseMoveRate = requestedRate;
    }
  }

  if (
    currency !== SUPPORTED_CURRENCY ||
    baseCurrency !== SUPPORTED_CURRENCY
  ) {
    errors.push('unsupported_currency');
  }
  if (!SUPPORTED_STOCK_SCOPES.has(positionScope)) {
    errors.push('unsupported_position_scope');
  }
  if (payload.accountReady !== true) {
    errors.push('account_not_ready');
  }
  if (payload.settledShortPositionsVerified !== true) {
    errors.push('settlement_unverified');
  } else if (payload.settlementStatus !== 'settled') {
    errors.push('unsettled_securities_activity');
  }
  if (
    payload.noSameDayExecutionsVerified !== true ||
    payload.sameDayExecutionCount !== 0
  ) {
    errors.push('execution_unverified');
  }

  const openOrderCount = asFiniteNumber(payload.openOrderCount);
  if (
    openOrderCount === null ||
    !Number.isInteger(openOrderCount) ||
    openOrderCount < 0
  ) {
    errors.push('invalid_open_order_count');
  } else if (openOrderCount > 0) {
    errors.push('open_orders_present');
  }

  const numericFieldNames = [
    'netLiquidation',
    'totalCashValueSecurities',
    'totalCashValueCommodities',
    'commodityMaintenanceMargin',
    'grossPositionValue',
    'stockMarketValue',
    'accruedCashSecurities',
  ];
  const numbers = {};
  for (const fieldName of numericFieldNames) {
    const parsed = asFiniteNumber(payload[fieldName]);
    if (parsed === null) {
      errors.push(`invalid_${fieldName}`);
    } else {
      numbers[fieldName] = parsed;
    }
  }
  if (hasOwn(payload, 'interestValidationReserve')) {
    const parsed = asFiniteNumber(payload.interestValidationReserve);
    if (parsed === null || parsed < 0) {
      errors.push('invalid_interest_validation_reserve');
    } else {
      numbers.interestValidationReserve = parsed;
    }
  } else {
    numbers.interestValidationReserve = 0;
  }

  if (
    numbers.netLiquidation !== undefined &&
    numbers.netLiquidation <= 0
  ) {
    errors.push('invalid_netLiquidation');
  }
  if (
    numbers.commodityMaintenanceMargin !== undefined &&
    numbers.commodityMaintenanceMargin < 0
  ) {
    errors.push('invalid_commodityMaintenanceMargin');
  }
  if (
    numbers.grossPositionValue !== undefined &&
    numbers.grossPositionValue < 0
  ) {
    errors.push('invalid_grossPositionValue');
  }

  const settledCash = parseSettledCashByDate(
    payload.settledCashByDateSecurities,
  );
  if (!settledCash) {
    errors.push('invalid_settled_cash_by_date');
  }
  const settledCommodityCash = parseSettledCashByDate(
    payload.settledCashByDateCommodities,
  );
  if (!settledCommodityCash) {
    errors.push('invalid_commodity_settled_cash_by_date');
  }

  let shortEvidenceMarketValue = 0;
  if (!Array.isArray(payload.shortPositions)) {
    errors.push('invalid_short_positions');
  } else {
    if (hasOwn(payload, 'shortPositionCount')) {
      const shortPositionCount = asFiniteNumber(payload.shortPositionCount);
      if (
        shortPositionCount === null ||
        !Number.isInteger(shortPositionCount) ||
        shortPositionCount < 0 ||
        shortPositionCount !== payload.shortPositions.length
      ) {
        errors.push('short_position_count_mismatch');
      }
    }

    if (hasOwn(payload, 'openPositionCount')) {
      const openPositionCount = asFiniteNumber(payload.openPositionCount);
      if (
        openPositionCount === null ||
        !Number.isInteger(openPositionCount) ||
        openPositionCount < payload.shortPositions.length
      ) {
        errors.push('invalid_open_position_count');
      }
    }

    const observedAt = parseTimestampMs(payload.observedAt);
    for (const position of payload.shortPositions) {
      if (!position || typeof position !== 'object' || Array.isArray(position)) {
        errors.push('invalid_short_position');
        continue;
      }

      const quantity = asFiniteNumber(position.quantity);
      const priorClose = asFiniteNumber(position.priorClose);
      const currentPrice = asFiniteNumber(position.currentPrice);
      const directBid = asFiniteNumber(position.directBid);
      const directAsk = asFiniteNumber(position.directAsk);
      const directLast = asFiniteNumber(position.directLast);
      if (
        quantity !== null &&
        quantity < 0 &&
        currentPrice !== null &&
        currentPrice > 0
      ) {
        shortEvidenceMarketValue += Math.abs(quantity) * currentPrice;
      }
      if (
        quantity === null ||
        quantity >= 0 ||
        priorClose === null ||
        priorClose <= 0 ||
        currentPrice === null ||
        currentPrice <= 0 ||
        directBid === null ||
        directBid <= 0 ||
        directAsk === null ||
        directAsk <= 0
      ) {
        errors.push('invalid_short_position');
      }
      const directQuoteMax = Math.max(
        directBid || 0,
        directAsk || 0,
        directLast && directLast > 0 ? directLast : 0,
      );
      if (
        currentPrice !== null &&
        currentPrice > 0 &&
        currentPrice + COMPARISON_EPSILON < directQuoteMax
      ) {
        errors.push('short_position_direct_max_inconsistent');
      }
      if (normalizeCurrency(position.currency) !== SUPPORTED_CURRENCY) {
        errors.push('unsupported_short_position_currency');
      }
      if (position.currentPriceSource !== VERIFIED_CURRENT_PRICE_SOURCE) {
        errors.push('short_position_current_price_source_unverified');
      }
      if (!VERIFIED_PRIOR_CLOSE_SOURCES.has(position.priorCloseSource)) {
        errors.push('short_position_prior_close_source_unverified');
      }
      if (
        hasOwn(position, 'marketDataType') &&
        asFiniteNumber(position.marketDataType) !== 1
      ) {
        errors.push('short_position_market_data_not_live');
      }
      if (hasOwn(position, 'snapshotTimestamp')) {
        const snapshotTimestamp = parseTimestampMs(
          position.snapshotTimestamp,
        );
        if (snapshotTimestamp === null) {
          errors.push('invalid_short_position_timestamp');
        } else if (
          observedAt !== null &&
          (snapshotTimestamp > observedAt + COMPARISON_EPSILON ||
            observedAt - snapshotTimestamp > SHORT_SNAPSHOT_MAX_AGE_MS)
        ) {
          errors.push('stale_short_position_timestamp');
        }
      }
    }
  }

  if (
    numbers.grossPositionValue !== undefined &&
    numbers.stockMarketValue !== undefined &&
    numbers.grossPositionValue + COMPARISON_EPSILON <
      Math.abs(numbers.stockMarketValue)
  ) {
    errors.push('inconsistent_stock_exposure');
  }

  let shortExposureEvidenceTolerance = null;
  let shortExposureEvidenceDeficitTolerance = null;
  let shortExposureEvidenceSurplusTolerance = null;
  if (
    Array.isArray(payload.shortPositions) &&
    numbers.grossPositionValue !== undefined &&
    numbers.stockMarketValue !== undefined &&
    numbers.grossPositionValue + COMPARISON_EPSILON >=
      Math.abs(numbers.stockMarketValue)
  ) {
    const derivedShortMarketValue =
      (numbers.grossPositionValue - numbers.stockMarketValue) / 2;
    // Direct-max marks above the aggregate are conservative, so permit the
    // larger of $1,000 or 5%. Evidence below the aggregate can hide borrowing:
    // permit only 0.1%, capped at $100, for broker timing/rounding.
    shortExposureEvidenceSurplusTolerance = Math.max(
      SHORT_EVIDENCE_ABSOLUTE_TOLERANCE,
      Math.abs(derivedShortMarketValue) *
        SHORT_EVIDENCE_RELATIVE_TOLERANCE,
    );
    shortExposureEvidenceDeficitTolerance = Math.min(
      SHORT_EVIDENCE_DEFICIT_MAX_TOLERANCE,
      Math.abs(derivedShortMarketValue) *
        SHORT_EVIDENCE_DEFICIT_RELATIVE_TOLERANCE,
    );
    shortExposureEvidenceTolerance =
      shortExposureEvidenceSurplusTolerance;
    const evidenceDelta =
      shortEvidenceMarketValue - derivedShortMarketValue;
    if (
      evidenceDelta <
        -shortExposureEvidenceDeficitTolerance - COMPARISON_EPSILON ||
      evidenceDelta >
        shortExposureEvidenceSurplusTolerance + COMPARISON_EPSILON
    ) {
      errors.push('short_exposure_evidence_mismatch');
    }
  }

  if (errors.length > 0) {
    return makeUnavailable(errors, {
      currency: currency || null,
      positionScope: positionScope || null,
    });
  }

  const collateralBreakdown = calculatePositionCollateral(
    payload.shortPositions,
    shortAdverseMoveRate,
  );
  return buildCashBorrowingResult({
    numbers,
    settledCash,
    settledCommodityCash,
    collateralBreakdown,
    shortAdverseMoveRate,
    shortEvidenceMarketValue,
    shortExposureEvidenceTolerance,
    shortExposureEvidenceDeficitTolerance,
    shortExposureEvidenceSurplusTolerance,
  });
}

/**
 * Calculates a read-only completed-session reference. Historical closes never
 * enter the live/actionable scenario path.
 */
function calculateIbkrCashBorrowingReference(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return makeUnavailable(['invalid_reference_payload']);
  }

  const errors = [];
  const currency = normalizeCurrency(payload.currency);
  const baseCurrency = normalizeCurrency(payload.baseCurrency);
  const positionScope = normalizePositionScope(payload.positionScope);
  if (
    payload.schemaVersion !== 1
    || payload.referenceOnly !== true
    || payload.actionable !== false
    || payload.status !== 'reference'
    || payload.source !== VERIFIED_REFERENCE_SOURCE
    || payload.referenceKind !== VERIFIED_REFERENCE_KIND
    || payload.settlementVerification !== VERIFIED_REFERENCE_SETTLEMENT
    || payload.fromCache !== false
  ) {
    errors.push('reference_provenance_unverified');
  }
  if (!String(payload.accountId || '').trim()) {
    errors.push('reference_account_unverified');
  }
  if (
    currency !== SUPPORTED_CURRENCY
    || baseCurrency !== SUPPORTED_CURRENCY
  ) {
    errors.push('unsupported_currency');
  }
  if (!SUPPORTED_STOCK_SCOPES.has(positionScope)) {
    errors.push('unsupported_position_scope');
  }
  if (payload.accountReady !== true) {
    errors.push('account_not_ready');
  }
  if (hasOwn(payload, 'policyShortAdverseMoveRate')) {
    errors.push('reference_policy_override_not_allowed');
  }

  const referenceSessionDate = payload.referenceSessionDate;
  const cashLedgerObservedDate = payload.cashLedgerObservedDate;
  const settlementHorizonDate = payload.settlementHorizonDate;
  if (
    !isReferenceDate(referenceSessionDate)
    || !isReferenceDate(cashLedgerObservedDate)
    || !isReferenceDate(settlementHorizonDate)
  ) {
    errors.push('invalid_reference_date');
  } else {
    const referenceMs = Date.parse(`${referenceSessionDate}T00:00:00Z`);
    const cashObservedMs = Date.parse(`${cashLedgerObservedDate}T00:00:00Z`);
    const horizonMs = Date.parse(`${settlementHorizonDate}T00:00:00Z`);
    if (referenceMs >= cashObservedMs || horizonMs < referenceMs) {
      errors.push('invalid_reference_date_order');
    }
  }

  const observationTimestamps = [
    payload.observedAt,
    payload.socketVerifiedAt,
    payload.accountValuesObservedAt,
  ].map(parseTimestampMs);
  if (observationTimestamps.some((value) => value === null)) {
    errors.push('invalid_reference_observation_timestamp');
  }

  const openOrderCount = asFiniteNumber(payload.openOrderCount);
  if (
    openOrderCount === null
    || !Number.isInteger(openOrderCount)
    || openOrderCount < 0
  ) {
    errors.push('invalid_open_order_count');
  } else if (openOrderCount > 0) {
    errors.push('open_orders_present');
  }
  const executionCountObserved = asFiniteNumber(
    payload.executionCountObserved,
  );
  if (
    executionCountObserved === null
    || !Number.isInteger(executionCountObserved)
    || executionCountObserved < 0
  ) {
    errors.push('invalid_reference_execution_count');
  }

  const numericFieldNames = [
    'netLiquidation',
    'totalCashValueSecurities',
    'totalCashValueCommodities',
    'commodityMaintenanceMargin',
    'grossPositionValue',
    'stockMarketValue',
    'accruedCashSecurities',
  ];
  const numbers = {};
  for (const fieldName of numericFieldNames) {
    const parsed = asFiniteNumber(payload[fieldName]);
    if (parsed === null) {
      errors.push(`invalid_${fieldName}`);
    } else {
      numbers[fieldName] = parsed;
    }
  }
  if (hasOwn(payload, 'interestValidationReserve')) {
    const parsed = asFiniteNumber(payload.interestValidationReserve);
    if (parsed === null || parsed < 0) {
      errors.push('invalid_interest_validation_reserve');
    } else {
      numbers.interestValidationReserve = parsed;
    }
  } else {
    numbers.interestValidationReserve = 0;
  }
  if (
    numbers.netLiquidation !== undefined
    && numbers.netLiquidation <= 0
  ) {
    errors.push('invalid_netLiquidation');
  }
  if (
    numbers.commodityMaintenanceMargin !== undefined
    && numbers.commodityMaintenanceMargin < 0
  ) {
    errors.push('invalid_commodityMaintenanceMargin');
  }
  if (
    numbers.grossPositionValue !== undefined
    && numbers.grossPositionValue < 0
  ) {
    errors.push('invalid_grossPositionValue');
  }

  const settledCash = parseSettledCashByDate(
    payload.settledCashByDateSecurities,
  );
  if (!settledCash) {
    errors.push('invalid_settled_cash_by_date');
  }
  const settledCommodityCash = parseSettledCashByDate(
    payload.settledCashByDateCommodities,
  );
  if (!settledCommodityCash) {
    errors.push('invalid_commodity_settled_cash_by_date');
  }
  if (settledCash && settledCommodityCash) {
    const terminalSecurities = latestSettlementEntry(settledCash);
    const terminalCommodities = latestSettlementEntry(
      settledCommodityCash,
    );
    const settlementHorizonDates = [
      terminalSecurities?.date,
      terminalCommodities?.date,
    ].filter(Boolean).sort();
    const derivedSettlementHorizon =
      settlementHorizonDates[settlementHorizonDates.length - 1];
    if (derivedSettlementHorizon !== settlementHorizonDate) {
      errors.push('reference_settlement_horizon_mismatch');
    }
    if (
      numbers.totalCashValueSecurities !== undefined
      && (
        !terminalSecurities
        || Math.abs(
          terminalSecurities.balance - numbers.totalCashValueSecurities,
        ) > 0.01
      )
    ) {
      errors.push('reference_securities_ladder_unreconciled');
    }
    if (
      numbers.totalCashValueCommodities !== undefined
      && (
        !terminalCommodities
        || Math.abs(
          terminalCommodities.balance
            - numbers.totalCashValueCommodities,
        ) > 0.01
      )
    ) {
      errors.push('reference_commodities_ladder_unreconciled');
    }
  }

  const references = payload.shortPositionReferences;
  let shortEvidenceMarketValue = 0;
  const normalizedReferences = [];
  const seenConIds = new Set();
  const forbiddenLiveFields = [
    'priorClose',
    'priorCloseSource',
    'currentPrice',
    'currentPriceSource',
    'directBid',
    'directAsk',
    'directLast',
    'marketDataType',
    'snapshotTimestamp',
  ];
  if (!Array.isArray(references)) {
    errors.push('invalid_short_position_references');
  } else {
    const shortPositionCount = asFiniteNumber(payload.shortPositionCount);
    if (
      shortPositionCount === null
      || !Number.isInteger(shortPositionCount)
      || shortPositionCount !== references.length
    ) {
      errors.push('short_position_count_mismatch');
    }
    const openPositionCount = asFiniteNumber(payload.openPositionCount);
    if (
      openPositionCount === null
      || !Number.isInteger(openPositionCount)
      || openPositionCount < references.length
    ) {
      errors.push('invalid_open_position_count');
    }

    const observedAt = parseTimestampMs(payload.observedAt);
    for (const position of references) {
      const conId = normalizeConId(position?.conId);
      const quantity = asFiniteNumber(position?.quantity);
      const referenceClose = asFiniteNumber(position?.referenceClose);
      const closeObservedAt = parseTimestampMs(
        position?.referenceCloseObservedAt,
      );
      if (
        !position
        || typeof position !== 'object'
        || Array.isArray(position)
        || conId === null
        || seenConIds.has(conId)
        || quantity === null
        || quantity >= 0
        || referenceClose === null
        || referenceClose <= 0
        || normalizeCurrency(position.currency) !== SUPPORTED_CURRENCY
        || position.referenceCloseSource
          !== VERIFIED_REFERENCE_CLOSE_SOURCE
        || position.referenceCloseSessionDate !== referenceSessionDate
        || closeObservedAt === null
        || (
          observedAt !== null
          && (
            closeObservedAt > observedAt + COMPARISON_EPSILON
            || observedAt - closeObservedAt > SHORT_SNAPSHOT_MAX_AGE_MS
          )
        )
        || forbiddenLiveFields.some((field) => hasOwn(position, field))
      ) {
        errors.push('invalid_short_position_reference');
        continue;
      }
      seenConIds.add(conId);
      shortEvidenceMarketValue += Math.abs(quantity) * referenceClose;
      normalizedReferences.push({
        ...position,
        conId,
        quantity,
        referenceClose,
      });
    }
  }

  const aggregateReferenceValue = asFiniteNumber(
    payload.shortStockReferenceCloseValue,
  );
  if (
    aggregateReferenceValue === null
    || aggregateReferenceValue < 0
    || Math.abs(aggregateReferenceValue - shortEvidenceMarketValue) > 0.01
  ) {
    errors.push('short_reference_value_mismatch');
  }

  if (
    numbers.grossPositionValue !== undefined
    && numbers.stockMarketValue !== undefined
    && numbers.grossPositionValue + COMPARISON_EPSILON
      < Math.abs(numbers.stockMarketValue)
  ) {
    errors.push('inconsistent_stock_exposure');
  }

  let shortExposureEvidenceTolerance = null;
  let shortExposureEvidenceDeficitTolerance = null;
  let shortExposureEvidenceSurplusTolerance = null;
  if (
    Array.isArray(references)
    && numbers.grossPositionValue !== undefined
    && numbers.stockMarketValue !== undefined
    && numbers.grossPositionValue + COMPARISON_EPSILON
      >= Math.abs(numbers.stockMarketValue)
  ) {
    const derivedShortMarketValue =
      (numbers.grossPositionValue - numbers.stockMarketValue) / 2;
    shortExposureEvidenceSurplusTolerance = Math.max(
      SHORT_EVIDENCE_ABSOLUTE_TOLERANCE,
      Math.abs(derivedShortMarketValue)
        * SHORT_EVIDENCE_RELATIVE_TOLERANCE,
    );
    shortExposureEvidenceDeficitTolerance = Math.min(
      SHORT_EVIDENCE_DEFICIT_MAX_TOLERANCE,
      Math.abs(derivedShortMarketValue)
        * SHORT_EVIDENCE_DEFICIT_RELATIVE_TOLERANCE,
    );
    shortExposureEvidenceTolerance =
      shortExposureEvidenceSurplusTolerance;
    const evidenceDelta =
      shortEvidenceMarketValue - derivedShortMarketValue;
    if (
      evidenceDelta
        < -shortExposureEvidenceDeficitTolerance - COMPARISON_EPSILON
      || evidenceDelta
        > shortExposureEvidenceSurplusTolerance + COMPARISON_EPSILON
    ) {
      errors.push('short_exposure_evidence_mismatch');
    }
  }

  if (errors.length > 0) {
    return makeUnavailable(errors, {
      currency: currency || null,
      positionScope: positionScope || null,
    });
  }

  const collateralBreakdown = calculateReferencePositionCollateral(
    normalizedReferences,
    DEFAULT_SHORT_ADVERSE_MOVE_RATE,
  );
  return buildCashBorrowingResult({
    numbers,
    settledCash,
    settledCommodityCash,
    collateralBreakdown,
    shortAdverseMoveRate: DEFAULT_SHORT_ADVERSE_MOVE_RATE,
    shortEvidenceMarketValue,
    shortExposureEvidenceTolerance,
    shortExposureEvidenceDeficitTolerance,
    shortExposureEvidenceSurplusTolerance,
    referenceMetadata: {
      referenceSessionDate,
      cashLedgerObservedDate,
      settlementHorizonDate,
      referenceKind: payload.referenceKind,
      source: payload.source,
    },
  });
}

export {
  calculateIbkrCashBorrowing,
  calculateIbkrCashBorrowingReference,
  parseSettledCashByDate,
  projectIbkrCashBorrowingScenario,
};

export default calculateIbkrCashBorrowing;
