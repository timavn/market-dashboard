const SUPPORTED_CURRENCY = "USD";
const SUPPORTED_POSITION_SCOPE = "stocks_only";
const EVENT_CONTRACT_POSITION_SCOPE = "stocks_and_event_contracts";
const LEGACY_EVENT_CONTRACT_POSITION_SCOPE = "stocks_and_kalshi";
const SUPPORTED_POSITION_SCOPES = new Set([
  SUPPORTED_POSITION_SCOPE,
  EVENT_CONTRACT_POSITION_SCOPE,
]);
const SHORT_COLLATERAL_MARKUP = 1.02;
const INTEREST_DAY_COUNT = 360;
const CALIBRATION_WINDOW = 90;
const Q95_PROBABILITY = 0.95;
const CENTS_EPSILON = 1e-9;

const UNSAFE_SOURCE_FLAGS = [
  "stale",
  "fromCache",
  "cacheOnly",
  "mock",
  "seeded",
  "reconstructed",
  "backfilled",
];

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function finiteNumber(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeCurrency(value) {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

function normalizeScope(value) {
  const normalized = typeof value === "string"
    ? value
        .trim()
        .toLowerCase()
        .replace(/[\s-]+/g, "_")
    : "";
  return normalized === LEGACY_EVENT_CONTRACT_POSITION_SCOPE
    ? EVENT_CONTRACT_POSITION_SCOPE
    : normalized;
}

function roundCent(value) {
  return Math.round((value + CENTS_EPSILON) * 100) / 100;
}

function ceilCent(value) {
  return Math.ceil((value - CENTS_EPSILON) * 100) / 100;
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function uniqueReasons(reasons) {
  return Array.from(new Set(reasons));
}

function failure(reasons, fields = {}) {
  const normalizedReasons = uniqueReasons(
    Array.isArray(reasons) ? reasons : [reasons],
  );
  return {
    available: false,
    status: "Unavailable",
    reason: normalizedReasons[0] || "invalid_interest_input",
    reasons: normalizedReasons,
    ...fields,
  };
}

function unsafeSourceReasons(value, prefix) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }

  const reasons = [];
  for (const flag of UNSAFE_SOURCE_FLAGS) {
    if (value[flag] === true) {
      reasons.push(`${prefix}_${flag}`);
    }
  }
  if (value.providerConnected === false) {
    reasons.push(`${prefix}_provider_disconnected`);
  }
  if (
    hasOwn(value, "providerStatus") &&
    !["live", "verified", "ready"].includes(
      String(value.providerStatus || "")
        .trim()
        .toLowerCase(),
    )
  ) {
    reasons.push(`${prefix}_provider_unavailable`);
  }
  return reasons;
}

/**
 * Calculates the only commodity-to-securities transfer recognized by this
 * model. Positive commodity excess can cure an existing securities-segment
 * deficit, but it cannot create a positive securities balance.
 */
function calculateSegmentTransfer(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return failure("invalid_segment_input");
  }

  const securitiesCash = finiteNumber(input.securitiesCash);
  const ibuklCash = hasOwn(input, "ibuklCash")
    ? finiteNumber(input.ibuklCash)
    : 0;
  const commoditiesCash = finiteNumber(input.commoditiesCash);
  const eventMarketValueProvided = hasOwn(input, "eventMarketValue");
  const legacyEventMarketValueProvided = hasOwn(input, "kalshiMarketValue");
  const eventMarketValue = eventMarketValueProvided
    ? finiteNumber(input.eventMarketValue)
    : legacyEventMarketValueProvided
      ? finiteNumber(input.kalshiMarketValue)
    : 0;
  const commodityAvailableFundsProvided = hasOwn(
    input,
    "commodityAvailableFunds",
  );
  const commodityAvailableFunds = commodityAvailableFundsProvided
    ? finiteNumber(input.commodityAvailableFunds)
    : null;
  const marginProvided = hasOwn(input, "commodityMaintenanceMargin");
  const commodityMaintenanceMargin = marginProvided
    ? finiteNumber(input.commodityMaintenanceMargin)
    : commoditiesCash === 0 && eventMarketValue === 0
      ? 0
      : null;
  const reasons = [];

  if (securitiesCash === null) reasons.push("invalid_securities_cash");
  if (ibuklCash === null) reasons.push("invalid_ibukl_cash");
  if (commoditiesCash === null) reasons.push("invalid_commodities_cash");
  if (eventMarketValue === null || eventMarketValue < 0) {
    reasons.push("invalid_event_market_value");
  }
  if (
    eventMarketValueProvided
    && legacyEventMarketValueProvided
    && finiteNumber(input.eventMarketValue) !== finiteNumber(input.kalshiMarketValue)
  ) {
    reasons.push("conflicting_event_market_value_aliases");
  }
  if (
    commodityAvailableFundsProvided
    && (commodityAvailableFunds === null || commodityAvailableFunds < 0)
  ) {
    reasons.push("invalid_commodity_available_funds");
  }
  if (commodityMaintenanceMargin === null || commodityMaintenanceMargin < 0) {
    reasons.push(
      !marginProvided && (commoditiesCash !== 0 || eventMarketValue !== 0)
        ? "commodity_margin_required_for_nonzero_commodities"
        : "invalid_commodity_maintenance_margin",
    );
  }

  if (reasons.length > 0) {
    return failure(reasons, {
      securitiesCash: null,
      ibuklCash: null,
      commoditiesCash: null,
      commodityMaintenanceMargin: null,
      eventMarketValue: null,
      kalshiMarketValue: null,
      commodityAvailableFunds: null,
      combinedSecuritiesCash: null,
      securitiesDeficit: null,
      commodityExcessBeforeBrokerHoldback: null,
      commodityExcess: null,
      commodityTransfer: null,
      eligibleCashBeforeCollateral: null,
    });
  }

  const combinedSecuritiesCash = securitiesCash + ibuklCash;
  const securitiesDeficit = Math.max(0, -combinedSecuritiesCash);
  const commodityExcessBeforeBrokerHoldback = Math.max(
    0,
    commoditiesCash + eventMarketValue - commodityMaintenanceMargin,
  );
  const commodityExcess = commodityAvailableFundsProvided
    ? Math.min(
        commodityExcessBeforeBrokerHoldback,
        commodityAvailableFunds,
      )
    : commodityExcessBeforeBrokerHoldback;
  const commodityTransfer = Math.min(securitiesDeficit, commodityExcess);

  return {
    available: true,
    status: "ok",
    securitiesCash,
    ibuklCash,
    commoditiesCash,
    eventMarketValue,
    // Backward-compatible result alias for stored forecast consumers.
    kalshiMarketValue: eventMarketValue,
    commodityAvailableFunds,
    commodityMaintenanceMargin,
    combinedSecuritiesCash,
    securitiesDeficit,
    commodityExcessBeforeBrokerHoldback,
    commodityExcess,
    commodityTransfer,
    commodityExcessAfterTransfer: commodityExcess - commodityTransfer,
    eligibleCashBeforeCollateral: combinedSecuritiesCash + commodityTransfer,
  };
}

/**
 * IBKR's USD stock-short collateral rule applies the whole-dollar ceiling to
 * each share before multiplying by shares.
 */
function calculateUsdShortCollateral(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return failure("invalid_short_collateral_input");
  }

  const reasons = [];
  const currency = normalizeCurrency(input.currency);
  if (currency !== SUPPORTED_CURRENCY) {
    reasons.push("unsupported_short_collateral_currency");
  }
  if (!Array.isArray(input.shortPositions)) {
    reasons.push("invalid_short_positions");
  }

  const positions = [];
  if (Array.isArray(input.shortPositions)) {
    input.shortPositions.forEach((position, index) => {
      if (
        !position ||
        typeof position !== "object" ||
        Array.isArray(position)
      ) {
        reasons.push(`invalid_short_position_${index}`);
        return;
      }

      const quantity = finiteNumber(position.quantity);
      const priorClose = finiteNumber(position.priorClose);
      const positionCurrency = normalizeCurrency(position.currency);
      if (
        quantity === null ||
        quantity >= 0 ||
        priorClose === null ||
        priorClose <= 0 ||
        positionCurrency !== SUPPORTED_CURRENCY
      ) {
        reasons.push(`invalid_short_position_${index}`);
        return;
      }

      const collateralPrice = Math.ceil(priorClose * SHORT_COLLATERAL_MARKUP);
      const shares = Math.abs(quantity);
      positions.push({
        index,
        conId: position.conId ?? null,
        symbol:
          typeof position.symbol === "string" && position.symbol.trim()
            ? position.symbol.trim()
            : null,
        currency: positionCurrency,
        quantity,
        shares,
        priorClose,
        markup: SHORT_COLLATERAL_MARKUP,
        unroundedCollateralPrice: priorClose * SHORT_COLLATERAL_MARKUP,
        collateralPrice,
        collateral: shares * collateralPrice,
      });
    });
  }

  if (reasons.length > 0) {
    return failure(reasons, {
      currency: currency || null,
      collateral: null,
      positions: [],
    });
  }

  return {
    available: true,
    status: "ok",
    currency,
    markup: SHORT_COLLATERAL_MARKUP,
    calculation: "sum(abs(quantity) * ceil(priorClose * 1.02))",
    collateral: sum(positions.map((position) => position.collateral)),
    positions,
  };
}

function normalizeTierSchedule(tiers, tiersVerified) {
  const reasons = [];
  if (tiersVerified !== true) {
    reasons.push("interest_tiers_not_verified");
  }
  if (!Array.isArray(tiers) || tiers.length === 0) {
    reasons.push("invalid_interest_tiers");
    return { available: false, reasons, tiers: [] };
  }

  let lowerBound = 0;
  const normalized = [];
  tiers.forEach((tier, index) => {
    if (!tier || typeof tier !== "object" || Array.isArray(tier)) {
      reasons.push(`invalid_interest_tier_${index}`);
      return;
    }

    const isLast = index === tiers.length - 1;
    const annualRate = finiteNumber(tier.annualRate);
    const hasUpperBound = hasOwn(tier, "upTo");
    const upperBound = tier.upTo === null ? null : finiteNumber(tier.upTo);

    if (
      annualRate === null ||
      annualRate < 0 ||
      annualRate > 1 ||
      !hasUpperBound ||
      (isLast && upperBound !== null) ||
      (!isLast && (upperBound === null || upperBound <= lowerBound)) ||
      (!isLast && tier.upTo === null) ||
      (!isLast && upperBound !== null && !Number.isFinite(upperBound)) ||
      (!isLast && upperBound <= 0) ||
      (!isLast && reasons.includes(`invalid_interest_tier_${index}`))
    ) {
      reasons.push(`invalid_interest_tier_${index}`);
      return;
    }

    if (!isLast && upperBound === null) {
      reasons.push(`invalid_interest_tier_${index}`);
      return;
    }
    if (isLast && tier.upTo !== null) {
      reasons.push("uncapped_terminal_interest_tier_required");
      return;
    }

    normalized.push({
      index,
      label:
        typeof tier.label === "string" && tier.label.trim()
          ? tier.label.trim()
          : `tier_${index + 1}`,
      lowerBound,
      upperBound,
      annualRate,
    });
    if (upperBound !== null) lowerBound = upperBound;
  });

  if (tiers.length > 0 && tiers[tiers.length - 1]?.upTo !== null) {
    reasons.push("uncapped_terminal_interest_tier_required");
  }

  return {
    available: reasons.length === 0,
    reasons: uniqueReasons(reasons),
    tiers: reasons.length === 0 ? normalized : [],
  };
}

/**
 * Charges each tier independently on a USD/360 basis and rounds each tier to
 * the nearest cent once per supplied accrual period.
 */
function calculateTieredUsdInterest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return failure("invalid_tiered_interest_input");
  }

  const reasons = [];
  const currency = normalizeCurrency(input.currency);
  const principal = finiteNumber(input.principal);
  const accrualDays = finiteNumber(input.accrualDays);
  if (currency !== SUPPORTED_CURRENCY) {
    reasons.push("unsupported_interest_currency");
  }
  if (principal === null || principal < 0) {
    reasons.push("invalid_interest_principal");
  }
  if (
    accrualDays === null ||
    !Number.isInteger(accrualDays) ||
    accrualDays <= 0
  ) {
    reasons.push("invalid_accrual_days");
  }

  const schedule = normalizeTierSchedule(input.tiers, input.tiersVerified);
  reasons.push(...schedule.reasons);
  reasons.push(...unsafeSourceReasons(input, "interest_tiers"));

  if (reasons.length > 0) {
    return failure(reasons, {
      currency: currency || null,
      principal: null,
      accrualDays: null,
      dayCount: INTEREST_DAY_COUNT,
      interest: null,
      tiers: [],
    });
  }

  const tierResults = schedule.tiers.map((tier) => {
    const amountAboveFloor = Math.max(0, principal - tier.lowerBound);
    const tierPrincipal =
      tier.upperBound === null
        ? amountAboveFloor
        : Math.min(amountAboveFloor, tier.upperBound - tier.lowerBound);
    const unroundedInterest =
      (tierPrincipal * tier.annualRate * accrualDays) / INTEREST_DAY_COUNT;
    return {
      ...tier,
      principal: tierPrincipal,
      accrualDays,
      dayCount: INTEREST_DAY_COUNT,
      unroundedInterest,
      interest: roundCent(unroundedInterest),
    };
  });
  const interest = roundCent(sum(tierResults.map((tier) => tier.interest)));

  return {
    available: true,
    status: "ok",
    currency,
    principal,
    accrualDays,
    dayCount: INTEREST_DAY_COUNT,
    calculation:
      "sum(roundCent(tierPrincipal * annualRate * accrualDays / 360))",
    interest,
    tiers: tierResults,
  };
}

function median(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * One-sided finite-sample order statistic. For n observations, the rank is
 * ceil((n + 1) * .95), capped at n and converted from one-based indexing.
 */
function calculateOneSidedQ95(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return failure("q95_sample_required", {
      sampleCount: 0,
      rank: null,
      q95: null,
    });
  }

  const normalized = values.map(finiteNumber);
  if (normalized.some((value) => value === null || value < 0)) {
    return failure("invalid_q95_sample", {
      sampleCount: null,
      rank: null,
      q95: null,
    });
  }

  const sorted = [...normalized].sort((left, right) => left - right);
  const rank = Math.min(
    sorted.length,
    Math.ceil((sorted.length + 1) * Q95_PROBABILITY),
  );
  return {
    available: true,
    status: "ok",
    sampleCount: sorted.length,
    probability: Q95_PROBABILITY,
    rank,
    q95: sorted[rank - 1],
  };
}

/**
 * Builds leakage-safe calibration statistics from locked forecasts matched to
 * verified actual debit interest. Input order must be verified oldest-first;
 * only the most recent 90 matches are retained.
 */
function calibrateProspectiveInterest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return failure("invalid_calibration_input");
  }

  if (!Array.isArray(input.matches)) {
    return failure("invalid_calibration_matches");
  }
  if (input.matches.length > 0 && input.chronologicalOrderVerified !== true) {
    return failure("calibration_order_not_verified");
  }

  const reasons = [];
  const normalized = [];
  input.matches.forEach((match, index) => {
    if (!match || typeof match !== "object" || Array.isArray(match)) {
      reasons.push(`invalid_calibration_match_${index}`);
      return;
    }
    const accrualDays = finiteNumber(match.accrualDays);
    const rawForecast = finiteNumber(match.rawForecast);
    const issuedPointForecast = finiteNumber(match.issuedPointForecast);
    const actualInterest = finiteNumber(match.actualInterest);
    const unsafeReasons = unsafeSourceReasons(
      match,
      `calibration_match_${index}`,
    );

    if (
      match.matched !== true ||
      match.prospective !== true ||
      match.verified !== true ||
      unsafeReasons.length > 0 ||
      accrualDays === null ||
      !Number.isInteger(accrualDays) ||
      accrualDays <= 0 ||
      rawForecast === null ||
      rawForecast < 0 ||
      issuedPointForecast === null ||
      issuedPointForecast < 0 ||
      actualInterest === null ||
      actualInterest < 0
    ) {
      reasons.push(...unsafeReasons);
      reasons.push(`invalid_calibration_match_${index}`);
      return;
    }

    normalized.push({
      index,
      id: match.id ?? null,
      accrualDays,
      rawForecast,
      issuedPointForecast,
      actualInterest,
      residualPerDay: (actualInterest - rawForecast) / accrualDays,
      underpredictionPerDay: Math.max(
        0,
        (actualInterest - issuedPointForecast) / accrualDays,
      ),
    });
  });

  if (reasons.length > 0) {
    return failure(reasons, {
      windowSize: CALIBRATION_WINDOW,
      sampleCount: null,
      totalMatchCount: null,
      biasPerDay: null,
      q95UnderpredictionPerDay: null,
      q95Rank: null,
      matches: [],
    });
  }

  const window = normalized.slice(-CALIBRATION_WINDOW);
  const biasPerDay =
    window.length === 0
      ? 0
      : median(window.map((match) => match.residualPerDay));
  const q95Result =
    window.length === 0
      ? null
      : calculateOneSidedQ95(
          window.map((match) => match.underpredictionPerDay),
        );

  return {
    available: true,
    status: "ok",
    windowSize: CALIBRATION_WINDOW,
    sampleCount: window.length,
    totalMatchCount: normalized.length,
    biasPerDay,
    q95UnderpredictionPerDay: q95Result?.q95 ?? null,
    q95Rank: q95Result?.rank ?? null,
    matches: window,
  };
}

function validationStatus(sampleCount, monthlyReconciled) {
  if (sampleCount === 0) return "Provisional";
  if (sampleCount >= 30 && monthlyReconciled === true) {
    return "Validated";
  }
  return "Learning";
}

/**
 * Graduated upper-forecast cushion. All candidates are evaluated before the
 * selected cushion is rounded upward to the next cent.
 */
function calculateForecastCushion(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return failure("invalid_cushion_input");
  }

  const point = finiteNumber(input.point);
  const accrualDays = finiteNumber(input.accrualDays);
  const sampleCount = finiteNumber(input.sampleCount);
  const q95 =
    input.q95UnderpredictionPerDay === null ||
    input.q95UnderpredictionPerDay === undefined
      ? null
      : finiteNumber(input.q95UnderpredictionPerDay);
  const monthlyReconciled = input.monthlyReconciled;
  const reasons = [];

  if (point === null || point < 0) reasons.push("invalid_point_forecast");
  if (
    accrualDays === null ||
    !Number.isInteger(accrualDays) ||
    accrualDays <= 0
  ) {
    reasons.push("invalid_accrual_days");
  }
  if (
    sampleCount === null ||
    !Number.isInteger(sampleCount) ||
    sampleCount < 0 ||
    sampleCount > CALIBRATION_WINDOW
  ) {
    reasons.push("invalid_calibration_sample_count");
  }
  if (typeof monthlyReconciled !== "boolean") {
    reasons.push("invalid_monthly_reconciliation_status");
  }
  if (
    (sampleCount === 0 && q95 !== null) ||
    (sampleCount > 0 && (q95 === null || q95 < 0))
  ) {
    reasons.push("invalid_q95_for_sample_count");
  }
  if (reasons.length > 0) {
    return failure(reasons, {
      cushion: null,
      validationStatus: null,
      band: null,
      candidates: null,
    });
  }

  const status = validationStatus(sampleCount, monthlyReconciled);
  let band;
  let fixedFloor;
  let pointRate;
  let bracketAddon;

  if (sampleCount <= 4) {
    band = "0-4";
    fixedFloor = 1;
    pointRate = 0.25;
    bracketAddon = sampleCount > 0 ? 0.5 : null;
  } else if (sampleCount <= 14) {
    band = "5-14";
    fixedFloor = 0.5;
    pointRate = 0.15;
    bracketAddon = 0.25;
  } else if (status !== "Validated") {
    band = sampleCount <= 29 ? "15-29" : "learning_30_plus";
    fixedFloor = 0.25;
    pointRate = 0.05;
    bracketAddon = 0;
  } else {
    band = "validated";
    fixedFloor = 0.01;
    pointRate = null;
    bracketAddon = 0;
  }

  const fixedFloorCandidate = fixedFloor;
  const pointRateCandidate = pointRate === null ? null : point * pointRate;
  const underpredictionCandidate =
    sampleCount === 0 ? null : accrualDays * q95 + bracketAddon;
  const candidates = [
    fixedFloorCandidate,
    pointRateCandidate,
    underpredictionCandidate,
  ].filter((value) => value !== null);
  const cushion = ceilCent(Math.max(...candidates));

  return {
    available: true,
    status: "ok",
    validationStatus: status,
    band,
    cushion,
    candidates: {
      fixedFloor: fixedFloorCandidate,
      pointRate,
      pointRateAmount: pointRateCandidate,
      q95PerDay: q95,
      q95Days: sampleCount === 0 ? null : accrualDays,
      bracketAddon,
      underpredictionAmount: underpredictionCandidate,
    },
  };
}

function baseForecastFailure(reasons) {
  return failure(reasons, {
    currency: null,
    positionScope: null,
    raw: null,
    point: null,
    upper: null,
    cushion: null,
    principal: null,
    collateral: null,
    accrualDays: null,
    sampleCount: null,
    segmentDetails: [],
  });
}

function normalizeForecastInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { available: false, reasons: ["invalid_forecast_input"] };
  }

  const reasons = [];
  const currency = normalizeCurrency(input.currency);
  const positionScope = normalizeScope(input.positionScope);
  if (currency !== SUPPORTED_CURRENCY) {
    reasons.push("unsupported_forecast_currency");
  }
  if (!SUPPORTED_POSITION_SCOPES.has(positionScope)) {
    reasons.push("unsupported_position_scope");
  }
  if (input.accountInputsVerified !== true) {
    reasons.push("account_inputs_not_verified");
  }
  reasons.push(...unsafeSourceReasons(input, "account_inputs"));

  const rootSchedule = normalizeTierSchedule(input.tiers, input.tiersVerified);
  reasons.push(...rootSchedule.reasons);
  if (input.tiersStale === true) reasons.push("interest_tiers_stale");
  if (input.tiersFromCache === true) {
    reasons.push("interest_tiers_from_cache");
  }

  if (
    !Array.isArray(input.accrualPeriods) ||
    input.accrualPeriods.length === 0
  ) {
    reasons.push("invalid_accrual_periods");
  }

  const periods = [];
  if (Array.isArray(input.accrualPeriods)) {
    input.accrualPeriods.forEach((period, index) => {
      if (!period || typeof period !== "object" || Array.isArray(period)) {
        reasons.push(`invalid_accrual_period_${index}`);
        return;
      }
      const periodReasons = unsafeSourceReasons(
        period,
        `accrual_period_${index}`,
      );
      reasons.push(...periodReasons);
      const accrualDays = finiteNumber(period.accrualDays);
      if (
        accrualDays === null ||
        !Number.isInteger(accrualDays) ||
        accrualDays <= 0
      ) {
        reasons.push(`invalid_accrual_period_days_${index}`);
      }
      if (
        hasOwn(period, "currency") &&
        normalizeCurrency(period.currency) !== SUPPORTED_CURRENCY
      ) {
        reasons.push(`invalid_accrual_period_currency_${index}`);
      }

      let periodSchedule = rootSchedule;
      if (hasOwn(period, "tiers")) {
        periodSchedule = normalizeTierSchedule(
          period.tiers,
          period.tiersVerified,
        );
        reasons.push(
          ...periodSchedule.reasons.map(
            (reason) => `accrual_period_${index}_${reason}`,
          ),
        );
      }

      periods.push({
        index,
        id: period.id ?? `period_${index + 1}`,
        accrualDays,
        securitiesCash: period.securitiesCash,
        ibuklCash: hasOwn(period, "ibuklCash") ? period.ibuklCash : 0,
        commoditiesCash: period.commoditiesCash,
        eventMarketValue: hasOwn(period, "eventMarketValue")
          ? period.eventMarketValue
          : hasOwn(period, "kalshiMarketValue")
            ? period.kalshiMarketValue
            : 0,
        legacyEventMarketValue: hasOwn(period, "kalshiMarketValue")
          ? period.kalshiMarketValue
          : undefined,
        eventMarketValueProvided: hasOwn(period, "eventMarketValue"),
        legacyEventMarketValueProvided: hasOwn(period, "kalshiMarketValue"),
        eventAccountingVerified: period.eventAccountingVerified === true,
        commodityAvailableFunds: hasOwn(period, "commodityAvailableFunds")
          ? period.commodityAvailableFunds
          : null,
        commodityAvailableFundsProvided: hasOwn(
          period,
          "commodityAvailableFunds",
        ),
        commodityMaintenanceMargin: period.commodityMaintenanceMargin,
        commodityMarginProvided: hasOwn(period, "commodityMaintenanceMargin"),
        shortPositions: period.shortPositions,
        tiers: periodSchedule.tiers,
        tiersVerified: periodSchedule.available,
      });
    });
  }

  if (
    positionScope === EVENT_CONTRACT_POSITION_SCOPE
    && periods.some((period) => period.eventAccountingVerified !== true)
  ) {
    reasons.push("event_accounting_not_verified");
  }

  if (
    !input.calibration ||
    typeof input.calibration !== "object" ||
    Array.isArray(input.calibration)
  ) {
    reasons.push("invalid_calibration_input");
  } else if (typeof input.calibration.monthlyReconciled !== "boolean") {
    reasons.push("invalid_monthly_reconciliation_status");
  }

  if (reasons.length > 0) {
    return { available: false, reasons: uniqueReasons(reasons) };
  }
  return {
    available: true,
    reasons: [],
    currency,
    positionScope,
    periods,
    calibration: input.calibration,
  };
}

function validateInterestForecastInput(input) {
  const result = forecastIbkrDebitInterest(input);
  return result.available
    ? { valid: true, reasons: [] }
    : { valid: false, reasons: result.reasons };
}

/**
 * End-to-end deterministic forecast. `principal` and `collateral` are the
 * maximum period values; the full period-by-period values remain in
 * `segmentDetails`.
 */
function forecastIbkrDebitInterest(input) {
  const normalized = normalizeForecastInput(input);
  if (!normalized.available) {
    return baseForecastFailure(normalized.reasons);
  }

  const calibration = calibrateProspectiveInterest({
    matches: normalized.calibration.matches,
    chronologicalOrderVerified:
      normalized.calibration.chronologicalOrderVerified,
  });
  if (!calibration.available) {
    return baseForecastFailure(calibration.reasons);
  }

  const segmentDetails = [];
  const reasons = [];
  for (const period of normalized.periods) {
    const segmentInput = {
      securitiesCash: period.securitiesCash,
      ibuklCash: period.ibuklCash,
      commoditiesCash: period.commoditiesCash,
      eventMarketValue: period.eventMarketValue,
    };
    if (period.legacyEventMarketValueProvided) {
      segmentInput.kalshiMarketValue = period.legacyEventMarketValue;
    }
    if (period.commodityMarginProvided) {
      segmentInput.commodityMaintenanceMargin =
        period.commodityMaintenanceMargin;
    }
    if (period.commodityAvailableFundsProvided) {
      segmentInput.commodityAvailableFunds = period.commodityAvailableFunds;
    }
    const segment = calculateSegmentTransfer(segmentInput);
    const collateral = calculateUsdShortCollateral({
      currency: normalized.currency,
      shortPositions: period.shortPositions,
    });

    if (!segment.available) {
      reasons.push(
        ...segment.reasons.map(
          (reason) => `accrual_period_${period.index}_${reason}`,
        ),
      );
    }
    if (!collateral.available) {
      reasons.push(
        ...collateral.reasons.map(
          (reason) => `accrual_period_${period.index}_${reason}`,
        ),
      );
    }
    if (!segment.available || !collateral.available) continue;

    const adjustedCash =
      segment.eligibleCashBeforeCollateral - collateral.collateral;
    const principal = Math.max(0, -adjustedCash);
    const interest = calculateTieredUsdInterest({
      currency: normalized.currency,
      principal,
      accrualDays: period.accrualDays,
      tiers: period.tiers.map((tier) => ({
        label: tier.label,
        upTo: tier.upperBound,
        annualRate: tier.annualRate,
      })),
      tiersVerified: period.tiersVerified,
    });
    if (!interest.available) {
      reasons.push(
        ...interest.reasons.map(
          (reason) => `accrual_period_${period.index}_${reason}`,
        ),
      );
      continue;
    }

    segmentDetails.push({
      id: period.id,
      index: period.index,
      accrualDays: period.accrualDays,
      securitiesCash: segment.securitiesCash,
      ibuklCash: segment.ibuklCash,
      combinedSecuritiesCash: segment.combinedSecuritiesCash,
      commoditiesCash: segment.commoditiesCash,
      eventMarketValue: segment.eventMarketValue,
      // Backward-compatible result alias for stored forecast consumers.
      kalshiMarketValue: segment.eventMarketValue,
      commodityAvailableFunds: segment.commodityAvailableFunds,
      commodityMaintenanceMargin: segment.commodityMaintenanceMargin,
      commodityExcessBeforeBrokerHoldback:
        segment.commodityExcessBeforeBrokerHoldback,
      commodityExcess: segment.commodityExcess,
      commodityTransfer: segment.commodityTransfer,
      commodityExcessAfterTransfer: segment.commodityExcessAfterTransfer,
      eligibleCashBeforeCollateral: segment.eligibleCashBeforeCollateral,
      collateral: collateral.collateral,
      collateralPositions: collateral.positions,
      adjustedCash,
      principal,
      rawInterest: interest.interest,
      interestTiers: interest.tiers,
    });
  }

  if (reasons.length > 0) {
    return baseForecastFailure(reasons);
  }

  const accrualDays = sum(segmentDetails.map((period) => period.accrualDays));
  const raw = roundCent(
    sum(segmentDetails.map((period) => period.rawInterest)),
  );
  const point = Math.max(
    0,
    roundCent(raw + calibration.biasPerDay * accrualDays),
  );
  const cushion = calculateForecastCushion({
    point,
    accrualDays,
    sampleCount: calibration.sampleCount,
    q95UnderpredictionPerDay: calibration.q95UnderpredictionPerDay,
    monthlyReconciled: normalized.calibration.monthlyReconciled,
  });
  if (!cushion.available) {
    return baseForecastFailure(cushion.reasons);
  }

  const upper = roundCent(point + cushion.cushion);
  const principal = Math.max(
    ...segmentDetails.map((period) => period.principal),
  );
  const collateral = Math.max(
    ...segmentDetails.map((period) => period.collateral),
  );

  return {
    available: true,
    status: cushion.validationStatus,
    currency: normalized.currency,
    positionScope: normalized.positionScope,
    raw,
    point,
    upper,
    cushion: cushion.cushion,
    principal,
    collateral,
    principalMode: "maximum_across_accrual_periods",
    collateralMode: "maximum_across_accrual_periods",
    accrualDays,
    sampleCount: calibration.sampleCount,
    totalMatchCount: calibration.totalMatchCount,
    biasPerDay: calibration.biasPerDay,
    q95UnderpredictionPerDay: calibration.q95UnderpredictionPerDay,
    q95Rank: calibration.q95Rank,
    monthlyReconciled: normalized.calibration.monthlyReconciled,
    calibrationWindow: CALIBRATION_WINDOW,
    cushionBand: cushion.band,
    cushionBreakdown: cushion.candidates,
    segmentDetails,
  };
}

/**
 * The reserve is the larger of the verified live accrued debit and the
 * independently verified unpaid ledger debit plus the upper forecast for
 * interest not yet represented in that ledger. It never sums the live and
 * ledger candidates, and positive accrued credits never reduce the reserve.
 */
function calculateInterestGuardReserve(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return failure("invalid_guard_reserve_input", {
      reserve: null,
    });
  }

  const liveAccruedCash = finiteNumber(input.liveAccruedCash);
  const verifiedUnpaidDebit = finiteNumber(input.verifiedUnpaidDebit);
  const unreportedUpper = finiteNumber(input.unreportedUpper);
  const reasons = [];
  if (input.liveAccruedVerified !== true) {
    reasons.push("live_accrued_not_verified");
  }
  if (input.unpaidDebitVerified !== true) {
    reasons.push("unpaid_debit_not_verified");
  }
  if (input.unreportedUpperVerified !== true) {
    reasons.push("unreported_upper_not_verified");
  }
  if (liveAccruedCash === null) {
    reasons.push("invalid_live_accrued_cash");
  }
  if (verifiedUnpaidDebit === null || verifiedUnpaidDebit < 0) {
    reasons.push("invalid_verified_unpaid_debit");
  }
  if (unreportedUpper === null || unreportedUpper < 0) {
    reasons.push("invalid_unreported_upper");
  }
  reasons.push(...unsafeSourceReasons(input, "guard_reserve"));

  if (reasons.length > 0) {
    return failure(reasons, {
      reserve: null,
      liveNegativeAccrued: null,
      positiveAccruedCreditExcluded: null,
      verifiedUnpaidDebit: null,
      unreportedUpper: null,
      unpaidPlusUnreportedUpper: null,
      selectedCandidate: null,
    });
  }

  const liveNegativeAccrued = Math.max(0, -liveAccruedCash);
  const positiveAccruedCreditExcluded = Math.max(0, liveAccruedCash);
  const unpaidPlusUnreportedUpper = verifiedUnpaidDebit + unreportedUpper;
  const reserve = Math.max(liveNegativeAccrued, unpaidPlusUnreportedUpper);
  const selectedCandidate =
    liveNegativeAccrued > unpaidPlusUnreportedUpper
      ? "live_negative_accrued"
      : unpaidPlusUnreportedUpper > liveNegativeAccrued
        ? "verified_unpaid_plus_unreported_upper"
        : "equal";

  return {
    available: true,
    status: "ok",
    reserve,
    liveAccruedCash,
    liveNegativeAccrued,
    positiveAccruedCreditExcluded,
    verifiedUnpaidDebit,
    unreportedUpper,
    unpaidPlusUnreportedUpper,
    selectedCandidate,
    doubleCountedLiveAccrued: 0,
    positiveCreditsApplied: 0,
  };
}

/**
 * Convenience composition for an unreported-period forecast and its guard.
 * The forecast's upper amount is wired directly into the max-based reserve so
 * callers cannot accidentally pass a different point estimate.
 */
function buildIbkrInterestDecision(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return failure("invalid_interest_decision_input", {
      forecast: null,
      guard: null,
      guardReserve: null,
    });
  }

  const forecast = forecastIbkrDebitInterest(input.forecast);
  if (!forecast.available) {
    return failure(
      forecast.reasons.map((reason) => `forecast_${reason}`),
      {
        forecast,
        guard: null,
        guardReserve: null,
      },
    );
  }
  const guardInput =
    input.guard && typeof input.guard === "object" ? input.guard : {};
  if (hasOwn(guardInput, "unreportedUpper")) {
    return failure("guard_unreported_upper_must_come_from_forecast", {
      forecast,
      guard: null,
      guardReserve: null,
    });
  }
  const guard = calculateInterestGuardReserve({
    ...guardInput,
    unreportedUpper: forecast.upper,
    unreportedUpperVerified: true,
  });
  if (!guard.available) {
    return failure(
      guard.reasons.map((reason) => `guard_${reason}`),
      {
        forecast,
        guard,
        guardReserve: null,
      },
    );
  }

  return {
    available: true,
    status: forecast.status,
    forecast,
    guard,
    guardReserve: guard.reserve,
  };
}

module.exports = {
  CALIBRATION_WINDOW,
  EVENT_CONTRACT_POSITION_SCOPE,
  INTEREST_DAY_COUNT,
  Q95_PROBABILITY,
  SHORT_COLLATERAL_MARKUP,
  SUPPORTED_CURRENCY,
  SUPPORTED_POSITION_SCOPE,
  buildIbkrInterestDecision,
  calculateForecastCushion,
  calculateInterestGuardReserve,
  calculateOneSidedQ95,
  calculateSegmentTransfer,
  calculateTieredUsdInterest,
  calculateUsdShortCollateral,
  calibrateProspectiveInterest,
  forecastIbkrDebitInterest,
  validateInterestForecastInput,
};
