const SUPPORTED_CURRENCY = 'USD';
const SUPPORTED_POSITION_SCOPE = 'stocks_only';
const EVENT_CONTRACT_POSITION_SCOPE = 'stocks_and_event_contracts';
const LEGACY_KALSHI_POSITION_SCOPE = 'stocks_and_kalshi';
const SUPPORTED_POSITION_SCOPES = new Set([
  SUPPORTED_POSITION_SCOPE,
  EVENT_CONTRACT_POSITION_SCOPE,
  LEGACY_KALSHI_POSITION_SCOPE,
]);
const SUPPORTED_EVENT_VENUES = new Set(['FORECASTX', 'KALSHI']);
const EVENT_ACCOUNTING_VERIFICATION =
  'ibkr_event_contract_commodity_segment_reconciled';
const LEGACY_KALSHI_ACCOUNTING_VERIFICATION =
  'ibkr_kalshi_commodity_segment_reconciled';
const SHORT_COLLATERAL_MARKUP = 1.02;
const FIXED_BUFFER = 2000;
const NLV_BUFFER_RATE = 0.01;
const SHORT_COLLATERAL_BUFFER_RATE = 0.05;
const EPSILON = 1e-8;
const ACCOUNT_VALUE_TOLERANCE = 0.01;

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeConId(value) {
  const number = finiteNumber(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function normalizeDate(value) {
  const match = String(value || '').match(/^(\d{4})-?(\d{2})-?(\d{2})$/);
  if (!match) return null;
  const iso = `${match[1]}-${match[2]}-${match[3]}`;
  return Number.isFinite(Date.parse(`${iso}T00:00:00Z`)) ? iso : null;
}

function normalizeEventVenues(value, { legacyKalshi = false } = {}) {
  if ((value === null || value === undefined) && legacyKalshi) {
    return ['KALSHI'];
  }
  if (!Array.isArray(value) || value.length === 0) return null;
  const venues = value.map((venue) => String(venue || '').trim());
  if (
    venues.some((venue) => !SUPPORTED_EVENT_VENUES.has(venue))
    || new Set(venues).size !== venues.length
  ) return null;
  const sorted = [...venues].sort();
  return venues.every((venue, index) => venue === sorted[index])
    ? venues
    : null;
}

function parseCashLadder(value) {
  let entries;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return null;
    entries = text.split(';').map((entry) => {
      const [rawDate, rawBalance, ...rest] = entry.split(':');
      if (rest.length > 0) return null;
      return [rawDate, rawBalance];
    });
  } else if (value && typeof value === 'object' && !Array.isArray(value)) {
    entries = Object.entries(value);
  } else {
    return null;
  }

  const rows = [];
  const dates = new Set();
  for (const entry of entries) {
    if (!entry) return null;
    const date = normalizeDate(entry[0]);
    const balance = finiteNumber(entry[1]);
    if (!date || balance === null || dates.has(date)) return null;
    dates.add(date);
    rows.push({ date, balance });
  }
  return rows.length > 0
    ? rows.sort((left, right) => left.date.localeCompare(right.date))
    : null;
}

function unavailable(reason, reasons = [reason]) {
  return {
    available: false,
    status: 'unavailable',
    source: 'unavailable',
    reason,
    reasons: [...new Set(reasons)],
  };
}

function validateTerminalBalance(rows, total) {
  return Boolean(
    rows
    && total !== null
    && Math.abs(rows[rows.length - 1].balance - total) <= 0.01,
  );
}

function lowestBalance(rows) {
  return rows.reduce((lowest, row) => (
    row.balance < lowest.balance
    || (row.balance === lowest.balance && row.date < lowest.date)
      ? row
      : lowest
  ));
}

function currentFutureLadder(rows, settlementDate) {
  if (!rows || !settlementDate) return null;
  const anchor = rows.reduce(
    (current, row) => (row.date <= settlementDate ? row : current),
    null,
  );
  if (!anchor) return null;
  return [anchor, ...rows.filter((row) => row.date > settlementDate)];
}

function calculateSegmentCash(securitiesCashFloor, commodityResidual, shortCollateral) {
  const securitiesDeficit = Math.max(0, -securitiesCashFloor);
  const commodityAdjustment = Math.min(securitiesDeficit, commodityResidual);
  const eligibleSecuritiesCash = securitiesCashFloor + commodityAdjustment;
  const adjustedCash = eligibleSecuritiesCash - shortCollateral;
  return {
    securitiesDeficit,
    commodityAdjustment,
    eligibleSecuritiesCash,
    adjustedCash,
    commodityResidual,
    commodityResidualAfterAdjustment: commodityResidual - commodityAdjustment,
  };
}

function calculateBalances({
  securitiesCashFloor,
  commodityResidual,
  shortCollateral,
  accruedDebitReserve,
  netLiquidation,
  longMarketValue,
}) {
  const segment = calculateSegmentCash(
    securitiesCashFloor,
    commodityResidual,
    shortCollateral,
  );
  const noBorrowBalance = segment.adjustedCash - accruedDebitReserve;
  const baseReserve = Math.max(FIXED_BUFFER, netLiquidation * NLV_BUFFER_RATE);
  const shortShockReserve = shortCollateral * SHORT_COLLATERAL_BUFFER_RATE;
  const totalReserve = baseReserve + shortShockReserve;
  const bufferedBalance = noBorrowBalance - totalReserve;

  return {
    segment,
    exact: {
      balance: noBorrowBalance,
      addLongRoom: Math.max(0, noBorrowBalance),
      trimRequired: Math.max(0, -noBorrowBalance),
      longLimit: Math.max(0, longMarketValue + noBorrowBalance),
    },
    buffer: {
      baseReserve,
      shortShockRate: SHORT_COLLATERAL_BUFFER_RATE,
      shortShockReserve,
      accruedDebitReserve,
      totalReserve,
      balance: bufferedBalance,
      addLongRoom: Math.max(0, bufferedBalance),
      trimRequired: Math.max(0, -bufferedBalance),
      longLimit: Math.max(0, longMarketValue + bufferedBalance),
    },
  };
}

function exposureSnapshot({ netLiquidation, longMarketValue, shortMarketValue }) {
  const grossMarketValue = longMarketValue + shortMarketValue;
  const netMarketValue = longMarketValue - shortMarketValue;
  const percentage = (value) => (value / netLiquidation) * 100;
  return {
    netLiquidation,
    longMarketValue,
    shortMarketValue,
    grossMarketValue,
    netMarketValue,
    longPercent: percentage(longMarketValue),
    shortPercent: percentage(shortMarketValue),
    grossPercent: percentage(grossMarketValue),
    netPercent: percentage(netMarketValue),
  };
}

function calculatePortfolioExposure(evidence) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    return unavailable('invalid_exposure_evidence');
  }

  const baseCurrency = String(
    evidence.baseCurrency || evidence.currency || '',
  ).trim().toUpperCase();
  const netLiquidation = finiteNumber(evidence.netLiquidation);
  const grossPositionValue = finiteNumber(evidence.grossPositionValue);
  const stockMarketValue = finiteNumber(evidence.stockMarketValue);
  const errors = [];

  if (!/^[A-Z]{3}$/.test(baseCurrency)) errors.push('invalid_base_currency');
  if (evidence.accountReady !== true) errors.push('account_not_ready');
  if (netLiquidation === null || netLiquidation <= 0) {
    errors.push('invalid_netLiquidation');
  }
  if (grossPositionValue === null || grossPositionValue < 0) {
    errors.push('invalid_grossPositionValue');
  }
  if (stockMarketValue === null) errors.push('invalid_stockMarketValue');
  if (
    grossPositionValue !== null
    && stockMarketValue !== null
    && grossPositionValue + EPSILON < Math.abs(stockMarketValue)
  ) errors.push('inconsistent_stock_exposure');

  if (errors.length > 0) return unavailable(errors[0], errors);

  const longMarketValue = Math.max(
    0,
    (grossPositionValue + stockMarketValue) / 2,
  );
  const shortMarketValue = Math.max(
    0,
    (grossPositionValue - stockMarketValue) / 2,
  );
  return {
    available: true,
    status: 'live',
    source: 'ibkr_live_session',
    currency: baseCurrency,
    ...exposureSnapshot({
      netLiquidation,
      longMarketValue,
      shortMarketValue,
    }),
  };
}

function calculatePortfolioBalance(evidence) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    return unavailable('invalid_balance_evidence');
  }

  const errors = [];
  const currency = String(evidence.currency || '').trim().toUpperCase();
  const baseCurrency = String(evidence.baseCurrency || '').trim().toUpperCase();
  const positionScope = String(evidence.positionScope || '').trim();
  const includesEventContracts = [
    EVENT_CONTRACT_POSITION_SCOPE,
    LEGACY_KALSHI_POSITION_SCOPE,
  ].includes(positionScope);
  const usesLegacyKalshiEvidence = positionScope === LEGACY_KALSHI_POSITION_SCOPE;
  const eventVenues = includesEventContracts
    ? normalizeEventVenues(evidence.eventVenues, {
      legacyKalshi: usesLegacyKalshiEvidence,
    })
    : null;
  if (currency !== SUPPORTED_CURRENCY || baseCurrency !== SUPPORTED_CURRENCY) {
    errors.push('unsupported_currency');
  }
  if (!SUPPORTED_POSITION_SCOPES.has(positionScope)) {
    errors.push('unsupported_position_scope');
  }
  if (evidence.accountReady !== true) errors.push('account_not_ready');
  if (evidence.settlementLaddersVerified !== true) {
    errors.push('settlement_ladders_unverified');
  }
  if (!['settled', 'pending'].includes(evidence.settlementState)) {
    errors.push('invalid_settlement_state');
  }
  if (evidence.activitySnapshotVerified !== true) {
    errors.push('activity_snapshot_unverified');
  }

  const numericNames = [
    'netLiquidation',
    'totalCashValueSecurities',
    'totalCashValueCommodities',
    'commodityMaintenanceMargin',
    'grossPositionValue',
    'stockMarketValue',
    'accruedCashSecurities',
    'openOrderCount',
    'sameDayExecutionCount',
  ];
  const numbers = {};
  for (const name of numericNames) {
    const value = finiteNumber(evidence[name]);
    if (value === null) errors.push(`invalid_${name}`);
    else numbers[name] = value;
  }
  if (includesEventContracts) {
    const eventNumericEvidence = {
      eventMarketValue:
        evidence.eventMarketValue ?? evidence.kalshiMarketValue,
      eventNetLiquidation:
        evidence.eventNetLiquidation ?? evidence.kalshiNetLiquidation,
      eventInitialMargin:
        evidence.eventInitialMargin ?? evidence.kalshiInitialMargin,
      eventMaintenanceMargin:
        evidence.eventMaintenanceMargin ?? evidence.kalshiMaintenanceMargin,
      eventAvailableFunds:
        evidence.eventAvailableFunds ?? evidence.kalshiAvailableFunds,
      eventEquityWithLoanValue:
        evidence.eventEquityWithLoanValue
          ?? evidence.kalshiEquityWithLoanValue,
      eventContractQuantity:
        evidence.eventContractQuantity ?? evidence.kalshiContractQuantity,
      eventPositionCount:
        evidence.eventPositionCount ?? evidence.kalshiPositionCount,
    };
    for (const [name, rawValue] of Object.entries(eventNumericEvidence)) {
      const value = finiteNumber(rawValue);
      if (value === null) errors.push(`invalid_${name}`);
      else numbers[name] = value;
    }
  }
  let eventTheoreticalAvailableFunds = null;
  let eventAvailableFundsHoldback = 0;

  if (numbers.netLiquidation !== undefined && numbers.netLiquidation <= 0) {
    errors.push('invalid_netLiquidation');
  }
  if (
    numbers.grossPositionValue !== undefined
    && numbers.grossPositionValue < 0
  ) errors.push('invalid_grossPositionValue');
  if (
    numbers.grossPositionValue !== undefined
    && numbers.stockMarketValue !== undefined
    && numbers.grossPositionValue + EPSILON < Math.abs(numbers.stockMarketValue)
  ) errors.push('inconsistent_stock_exposure');
  for (const countName of ['openOrderCount', 'sameDayExecutionCount']) {
    if (
      numbers[countName] !== undefined
      && (!Number.isInteger(numbers[countName]) || numbers[countName] < 0)
    ) errors.push(`invalid_${countName}`);
  }
  if (includesEventContracts) {
    const errorPrefix = usesLegacyKalshiEvidence ? 'kalshi' : 'event_contract';
    if (!eventVenues) errors.push('invalid_event_venues');
    if (
      numbers.eventMarketValue < -ACCOUNT_VALUE_TOLERANCE
      || numbers.eventInitialMargin < -ACCOUNT_VALUE_TOLERANCE
      || numbers.eventMaintenanceMargin < -ACCOUNT_VALUE_TOLERANCE
      || numbers.eventAvailableFunds < -ACCOUNT_VALUE_TOLERANCE
      || numbers.eventEquityWithLoanValue < -ACCOUNT_VALUE_TOLERANCE
      || !Number.isFinite(numbers.eventContractQuantity)
      || numbers.eventContractQuantity <= 0
      || !Number.isInteger(numbers.eventPositionCount)
      || numbers.eventPositionCount <= 0
    ) errors.push(`invalid_${errorPrefix}_accounting`);
    eventTheoreticalAvailableFunds = (
      numbers.eventNetLiquidation - numbers.eventInitialMargin
    );
    const eventChecks = [
      [
        numbers.eventNetLiquidation,
        numbers.totalCashValueCommodities + numbers.eventMarketValue,
      ],
      [numbers.eventInitialMargin, numbers.eventMarketValue],
      [numbers.eventMaintenanceMargin, numbers.eventMarketValue],
      [
        numbers.eventEquityWithLoanValue,
        numbers.totalCashValueCommodities
          + numbers.eventMarketValue
          - numbers.eventMaintenanceMargin,
      ],
    ];
    if (eventChecks.some(([left, right]) => (
      left !== undefined
      && right !== undefined
      && Math.abs(left - right) > ACCOUNT_VALUE_TOLERANCE
    ))) errors.push(`${errorPrefix}_accounting_unreconciled`);
    if (
      numbers.eventAvailableFunds !== undefined
      && Number.isFinite(eventTheoreticalAvailableFunds)
      && numbers.eventAvailableFunds
        > eventTheoreticalAvailableFunds + ACCOUNT_VALUE_TOLERANCE
    ) errors.push(`${errorPrefix}_accounting_unreconciled`);
    if (
      numbers.eventAvailableFunds !== undefined
      && Number.isFinite(eventTheoreticalAvailableFunds)
    ) {
      eventAvailableFundsHoldback = Math.max(
        0,
        eventTheoreticalAvailableFunds - numbers.eventAvailableFunds,
      );
    }
    const reportedEventPositionCount = finiteNumber(
      evidence.eventPositionCount ?? evidence.kalshiPositionCount,
    );
    const legacyAccountingPositionCount = finiteNumber(
      evidence.kalshiPositionCount,
    );
    if (
      numbers.eventPositionCount !== reportedEventPositionCount
      || (
        usesLegacyKalshiEvidence
        && legacyAccountingPositionCount !== null
        && finiteNumber(evidence.eventPositionCount) !== null
        && legacyAccountingPositionCount
          !== finiteNumber(evidence.eventPositionCount)
      )
    ) errors.push(`${errorPrefix}_position_count_mismatch`);
    const accountingVerified = evidence.eventAccountingVerified === true
      || (usesLegacyKalshiEvidence && evidence.kalshiAccountingVerified === true);
    const accountingVerification = evidence.eventAccountingVerification
      ?? evidence.kalshiAccountingVerification;
    const verificationAccepted =
      accountingVerification === EVENT_ACCOUNTING_VERIFICATION
      || (
        usesLegacyKalshiEvidence
        && accountingVerification === LEGACY_KALSHI_ACCOUNTING_VERIFICATION
      );
    if (!accountingVerified || !verificationAccepted) {
      errors.push(`${errorPrefix}_accounting_unverified`);
    }
  }

  const securitiesLadder = parseCashLadder(evidence.settledCashByDateSecurities);
  const commoditiesLadder = parseCashLadder(evidence.settledCashByDateCommodities);
  if (!securitiesLadder) errors.push('invalid_securities_cash_ladder');
  if (!commoditiesLadder) errors.push('invalid_commodities_cash_ladder');
  if (
    securitiesLadder
    && numbers.totalCashValueSecurities !== undefined
    && !validateTerminalBalance(securitiesLadder, numbers.totalCashValueSecurities)
  ) errors.push('securities_cash_ladder_unreconciled');
  if (
    commoditiesLadder
    && numbers.totalCashValueCommodities !== undefined
    && !validateTerminalBalance(commoditiesLadder, numbers.totalCashValueCommodities)
  ) errors.push('commodities_cash_ladder_unreconciled');

  const settlementDate = normalizeDate(evidence.settlementDate);
  const settlementHorizonDate = normalizeDate(evidence.settlementHorizonDate);
  let securitiesSettlementLadder = null;
  let commoditiesSettlementLadder = null;
  if (!settlementDate || !settlementHorizonDate) {
    errors.push('invalid_settlement_date');
  } else if (settlementHorizonDate < settlementDate) {
    errors.push('stale_settlement_ladder');
  } else if (
    evidence.settlementState === 'pending'
    && settlementHorizonDate <= settlementDate
  ) {
    errors.push('settlement_state_mismatch');
  } else if (
    evidence.settlementState === 'settled'
    && settlementHorizonDate > settlementDate
  ) {
    errors.push('settlement_state_mismatch');
  }
  if (settlementDate && securitiesLadder && commoditiesLadder) {
    securitiesSettlementLadder = currentFutureLadder(
      securitiesLadder,
      settlementDate,
    );
    commoditiesSettlementLadder = currentFutureLadder(
      commoditiesLadder,
      settlementDate,
    );
    if (!securitiesSettlementLadder) {
      errors.push('securities_cash_ladder_incomplete');
    }
    if (!commoditiesSettlementLadder) {
      errors.push('commodities_cash_ladder_incomplete');
    }
    const securitiesHorizon = securitiesLadder[securitiesLadder.length - 1].date;
    const commoditiesHorizon = commoditiesLadder[commoditiesLadder.length - 1].date;
    const brokerHorizon = securitiesHorizon > commoditiesHorizon
      ? securitiesHorizon
      : commoditiesHorizon;
    if (settlementHorizonDate && brokerHorizon !== settlementHorizonDate) {
      errors.push('settlement_horizon_mismatch');
    }
    const ladderHasFuture = Boolean(
      securitiesSettlementLadder?.some((row) => row.date > settlementDate)
      || commoditiesSettlementLadder?.some((row) => row.date > settlementDate),
    );
    if (
      ['settled', 'pending'].includes(evidence.settlementState)
      && (evidence.settlementState === 'pending') !== ladderHasFuture
    ) errors.push('settlement_state_mismatch');
  }

  const shortPositions = [];
  const seenConIds = new Set();
  if (!Array.isArray(evidence.shortPositions)) {
    errors.push('invalid_short_positions');
  } else {
    for (const row of evidence.shortPositions) {
      const conId = normalizeConId(row?.conId ?? row?.conid);
      const quantity = finiteNumber(row?.quantity);
      const priorClose = finiteNumber(row?.priorClose);
      const priorCloseSessionDate = normalizeDate(row?.priorCloseSessionDate);
      if (
        !conId
        || seenConIds.has(conId)
        || quantity === null
        || quantity >= 0
        || priorClose === null
        || priorClose <= 0
        || String(row?.currency || '').toUpperCase() !== SUPPORTED_CURRENCY
        || row?.priorCloseSource !== 'ibkr_historical_daily_close'
        || !priorCloseSessionDate
        || (settlementDate && priorCloseSessionDate >= settlementDate)
      ) {
        errors.push('invalid_short_position');
        continue;
      }
      seenConIds.add(conId);
      const absoluteQuantity = Math.abs(quantity);
      const collateralPerShare = Math.ceil(priorClose * SHORT_COLLATERAL_MARKUP);
      shortPositions.push({
        conId,
        symbol: typeof row.symbol === 'string' ? row.symbol : null,
        currency: SUPPORTED_CURRENCY,
        quantity,
        absoluteQuantity,
        priorClose,
        priorCloseSource: row.priorCloseSource,
        priorCloseSessionDate,
        priorCloseObservedAt: row.priorCloseObservedAt || null,
        collateralPerShare,
        collateral: absoluteQuantity * collateralPerShare,
      });
    }
  }
  const reportedShortCount = finiteNumber(evidence.shortPositionCount);
  const reportedOpenCount = finiteNumber(evidence.openPositionCount);
  if (
    !Number.isInteger(reportedShortCount)
    || reportedShortCount !== shortPositions.length
  ) errors.push('short_position_count_mismatch');
  if (
    !Number.isInteger(reportedOpenCount)
    || reportedOpenCount < shortPositions.length
  ) errors.push('invalid_open_position_count');

  if (errors.length > 0) return unavailable(errors[0], errors);

  const longMarketValue = Math.max(
    0,
    (numbers.grossPositionValue + numbers.stockMarketValue) / 2,
  );
  const shortMarketValue = Math.max(
    0,
    (numbers.grossPositionValue - numbers.stockMarketValue) / 2,
  );
  if (shortPositions.length === 0 && shortMarketValue > 0.01) {
    return unavailable('short_position_evidence_missing');
  }

  const securitiesFloor = lowestBalance(securitiesSettlementLadder);
  const commoditiesFloor = lowestBalance(commoditiesSettlementLadder);
  const shortCollateral = shortPositions.reduce(
    (total, position) => total + position.collateral,
    0,
  );
  const commodityResidualBeforeBrokerHoldback = (
    commoditiesFloor.balance
    + (includesEventContracts ? numbers.eventMarketValue : 0)
    - numbers.commodityMaintenanceMargin
  );
  const commodityResidual = includesEventContracts
    ? Math.min(
        commodityResidualBeforeBrokerHoldback,
        numbers.eventAvailableFunds,
      )
    : commodityResidualBeforeBrokerHoldback;
  const accruedDebitReserve = Math.max(0, -numbers.accruedCashSecurities);
  const balances = calculateBalances({
    securitiesCashFloor: securitiesFloor.balance,
    commodityResidual,
    shortCollateral,
    accruedDebitReserve,
    netLiquidation: numbers.netLiquidation,
    longMarketValue,
  });
  const currentSecuritiesCash = securitiesSettlementLadder[0];
  const currentCommoditiesCash = commoditiesSettlementLadder[0];
  const currentCommodityResidualBeforeBrokerHoldback = (
    currentCommoditiesCash.balance
    + (includesEventContracts ? numbers.eventMarketValue : 0)
    - numbers.commodityMaintenanceMargin
  );
  const currentCommodityResidual = includesEventContracts
    ? Math.min(
        currentCommodityResidualBeforeBrokerHoldback,
        numbers.eventAvailableFunds,
      )
    : currentCommodityResidualBeforeBrokerHoldback;
  const currentBalances = calculateBalances({
    securitiesCashFloor: currentSecuritiesCash.balance,
    commodityResidual: currentCommodityResidual,
    shortCollateral,
    accruedDebitReserve,
    netLiquidation: numbers.netLiquidation,
    longMarketValue,
  });

  return {
    available: true,
    status: 'live',
    source: 'ibkr_live_session',
    accountId: String(evidence.accountId || '').trim() || null,
    currency: SUPPORTED_CURRENCY,
    positionScope,
    observedAt: evidence.observedAt || null,
    socketVerifiedAt: evidence.socketVerifiedAt || null,
    accountValuesObservedAt: evidence.accountValuesObservedAt || null,
    fromCache: false,
    settlement: {
      state: evidence.settlementState,
      date: settlementDate,
      horizonDate: settlementHorizonDate,
      pending: evidence.settlementState === 'pending',
    },
    activity: {
      openOrderCount: numbers.openOrderCount,
      sameDayExecutionCount: numbers.sameDayExecutionCount,
      previewAvailable: numbers.openOrderCount === 0,
      previewUnavailableReason:
        numbers.openOrderCount > 0 ? 'open_orders_present' : null,
    },
    exposure: exposureSnapshot({
      netLiquidation: numbers.netLiquidation,
      longMarketValue,
      shortMarketValue,
    }),
    cash: {
      securitiesCashFloor: securitiesFloor.balance,
      worstSettlementDate: securitiesFloor.date,
      commodityCashFloor: commoditiesFloor.balance,
      worstCommoditySettlementDate: commoditiesFloor.date,
      commodityMaintenanceMargin: numbers.commodityMaintenanceMargin,
      commodityResidualBeforeBrokerHoldback,
      commodityAvailableFundsHoldback: includesEventContracts
        ? eventAvailableFundsHoldback
        : 0,
      shortCollateral,
      netAccruedInterest: numbers.accruedCashSecurities,
      accruedDebitReserve,
      ...balances.segment,
      noBorrowBalance: balances.exact.balance,
      addLongRoom: balances.exact.addLongRoom,
      trimRequired: balances.exact.trimRequired,
      noBorrowLongLimit: balances.exact.longLimit,
    },
    buffer: {
      ...balances.buffer,
      bufferedLongLimit: balances.buffer.longLimit,
    },
    interestExposure: {
      available: true,
      status: 'live',
      source: 'ibkr_live_session',
      interpretation: 'debit_interest_exposure_only',
      actionable: false,
      current: {
        effectiveDate: currentSecuritiesCash.date,
        securitiesCash: currentSecuritiesCash.balance,
        commodityAdjustment: currentBalances.segment.commodityAdjustment,
        shortCollateral,
        accruedDebit: accruedDebitReserve,
        adjustedSettledCash: currentBalances.exact.balance,
        estimatedDebitPrincipal: currentBalances.exact.trimRequired,
        interestFreeRoom: currentBalances.exact.addLongRoom,
      },
      projected: {
        effectiveDate: securitiesFloor.date,
        securitiesCash: securitiesFloor.balance,
        commodityAdjustment: balances.segment.commodityAdjustment,
        shortCollateral,
        accruedDebit: accruedDebitReserve,
        adjustedSettledCash: balances.exact.balance,
        estimatedDebitPrincipal: balances.exact.trimRequired,
        interestFreeRoom: balances.exact.addLongRoom,
      },
      policy: {
        baseReserve: balances.buffer.baseReserve,
        shortShockReserve: balances.buffer.shortShockReserve,
        totalReserve: balances.buffer.totalReserve,
        adjustedSettledCashAfterReserve: balances.buffer.balance,
        estimatedDebitPrincipalAfterReserve: balances.buffer.trimRequired,
      },
    },
    shortPositions,
    eventContracts: includesEventContracts
      ? {
        venues: eventVenues,
        venue: eventVenues.length === 1 ? eventVenues[0] : null,
        positionCount: numbers.eventPositionCount,
        contractQuantity: numbers.eventContractQuantity,
        marketValue: numbers.eventMarketValue,
        initialMargin: numbers.eventInitialMargin,
        maintenanceMargin: numbers.eventMaintenanceMargin,
        availableFunds: numbers.eventAvailableFunds,
        equityWithLoanValue: numbers.eventEquityWithLoanValue,
        theoreticalAvailableFunds: eventTheoreticalAvailableFunds,
        availableFundsHoldback: eventAvailableFundsHoldback,
        capacityContribution: 0,
        verification: evidence.eventAccountingVerification
          ?? evidence.kalshiAccountingVerification,
      }
      : null,
  };
}

const BATCH_PREVIEW_ACTIONS = new Set([
  'buy_long',
  'sell_long',
  'add_short',
  'cover_short',
]);

function normalizePreviewLegAction(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizePreviewQuantityMode(value) {
  const mode = String(value || 'shares').trim().toLowerCase();
  return ['shares', 'dollars', 'nlv_percent'].includes(mode) ? mode : null;
}

function previewLegEvidenceFor(leg, evidence) {
  if (!evidence || typeof evidence !== 'object') return null;
  if (evidence.legs && typeof evidence.legs === 'object') {
    return evidence.legs[leg.id]
      || evidence.legs[String(leg.id)]
      || null;
  }
  if (Array.isArray(evidence)) {
    return evidence.find((row) => String(row?.id || '') === String(leg.id)) || null;
  }
  return evidence;
}

function previewFillPrice(action, leg, evidence) {
  const priceMode = String(leg?.priceMode || 'live_side').trim().toLowerCase();
  if (priceMode === 'manual' || priceMode === 'manual_assumption') {
    const manual = finiteNumber(leg?.price);
    return manual !== null && manual > 0 ? manual : null;
  }
  if (action === 'buy_long' || action === 'cover_short') {
    return finiteNumber(evidence?.ask);
  }
  return finiteNumber(evidence?.bid);
}

function previewSharesFromLeg(leg, price, netLiquidation) {
  const mode = normalizePreviewQuantityMode(leg?.quantityMode);
  const requested = finiteNumber(leg?.quantity);
  if (!mode || requested === null || requested <= 0 || !Number.isFinite(price) || price <= 0) {
    return { mode, requested, shares: null, unallocated: null };
  }
  if (mode === 'shares') {
    const shares = Math.floor(requested);
    return { mode, requested, shares, unallocated: 0 };
  }
  const notional = mode === 'nlv_percent'
    ? netLiquidation * requested / 100
    : requested;
  const shares = Math.floor(notional / price);
  return {
    mode,
    requested,
    shares,
    unallocated: Math.max(0, notional - (shares * price)),
  };
}

function projectPortfolioBalanceLegs(snapshot, request, evidence) {
  if (snapshot?.available !== true || snapshot?.status !== 'live') {
    return unavailable('baseline_unavailable');
  }
  if (snapshot?.activity?.openOrderCount > 0) {
    return unavailable('open_orders_present');
  }
  const legs = Array.isArray(request?.legs) ? request.legs : [];
  if (!legs.length) return unavailable('no_preview_legs');

  const current = snapshot.exposure;
  let longMarketValue = current.longMarketValue;
  let shortMarketValue = current.shortMarketValue;
  let securitiesCashFloor = snapshot.cash.securitiesCashFloor;
  let shortCollateral = snapshot.cash.shortCollateral;
  const projectedLegs = [];
  const plannedLongByConId = new Map();
  const plannedShortByConId = new Map();

  for (const rawLeg of legs) {
    const id = String(rawLeg?.id || '').trim();
    const action = normalizePreviewLegAction(rawLeg?.action);
    const legEvidence = previewLegEvidenceFor({ ...rawLeg, id }, evidence);
    if (!id || !BATCH_PREVIEW_ACTIONS.has(action)) {
      return unavailable('invalid_preview_leg');
    }
    if (!legEvidence || legEvidence.available !== true) {
      return unavailable('live_leg_evidence_unavailable');
    }
    const bid = finiteNumber(legEvidence.bid);
    const ask = finiteNumber(legEvidence.ask);
    const currentPrice = finiteNumber(
      legEvidence.currentPrice ?? legEvidence.last,
    );
    if (
      bid === null || bid <= 0
      || ask === null || ask <= 0
      || currentPrice === null || currentPrice <= 0
      || Number(legEvidence.marketDataType) !== 1
    ) return unavailable('live_leg_evidence_invalid');

    const fillPrice = previewFillPrice(action, rawLeg, legEvidence);
    if (fillPrice === null || fillPrice <= 0) {
      return unavailable('preview_price_invalid');
    }
    const quantity = previewSharesFromLeg(rawLeg, fillPrice, current.netLiquidation);
    if (!Number.isSafeInteger(quantity.shares) || quantity.shares <= 0) {
      return unavailable('preview_quantity_invalid');
    }

    const conId = normalizeConId(
      legEvidence.conId ?? rawLeg.conId,
    );
    const positionQuantity = finiteNumber(legEvidence.positionQuantity);
    const longPosition = positionQuantity !== null && positionQuantity > 0
      ? positionQuantity
      : 0;
    const shortPosition = positionQuantity !== null && positionQuantity < 0
      ? Math.abs(positionQuantity)
      : 0;
    const priorClose = finiteNumber(legEvidence.priorClose);
    const collateralPerShare = finiteNumber(
      legEvidence.collateralPerShare
      ?? (priorClose !== null ? Math.ceil(priorClose * SHORT_COLLATERAL_MARKUP) : null),
    );
    const markedNotional = quantity.shares * currentPrice;
    const cashNotional = quantity.shares * fillPrice;
    let shortCapacity = null;

    if (action === 'buy_long') {
      securitiesCashFloor -= cashNotional;
      longMarketValue += markedNotional;
      plannedLongByConId.set(
        conId,
        (plannedLongByConId.get(conId) || 0) + quantity.shares,
      );
    } else if (action === 'sell_long') {
      const planned = plannedLongByConId.get(conId) || 0;
      if (!conId || longPosition + planned + EPSILON < quantity.shares) {
        return unavailable('sell_exceeds_verified_long_position');
      }
      plannedLongByConId.set(conId, planned - quantity.shares);
      securitiesCashFloor += cashNotional;
      longMarketValue = Math.max(0, longMarketValue - markedNotional);
    } else if (action === 'add_short') {
      const shortableShares = finiteNumber(legEvidence.shortableShares);
      if (shortableShares === null || shortableShares < quantity.shares) {
        return unavailable('insufficient_verified_shortable_shares');
      }
      if (collateralPerShare === null || collateralPerShare <= 0) {
        return unavailable('short_prior_close_unavailable');
      }
      const balancesBeforeLeg = calculateBalances({
        securitiesCashFloor,
        commodityResidual: snapshot.cash.commodityResidual,
        shortCollateral,
        accruedDebitReserve: snapshot.cash.accruedDebitReserve,
        netLiquidation: current.netLiquidation,
        longMarketValue,
      });
      const cashConsumedPerShare = Math.max(0, collateralPerShare - fillPrice);
      const borrowLimit = Math.max(0, Math.floor(shortableShares));
      const exactCashLimit = cashConsumedPerShare > EPSILON
        ? Math.max(0, Math.floor(
          balancesBeforeLeg.exact.addLongRoom / cashConsumedPerShare,
        ))
        : borrowLimit;
      const bufferedCashLimit = cashConsumedPerShare > EPSILON
        ? Math.max(0, Math.floor(
          balancesBeforeLeg.buffer.addLongRoom / cashConsumedPerShare,
        ))
        : borrowLimit;
      const exactShares = Math.min(borrowLimit, exactCashLimit);
      const bufferedShares = Math.min(borrowLimit, bufferedCashLimit);
      shortCapacity = {
        cashConsumedPerShare,
        borrowAvailableShares: borrowLimit,
        exactShares,
        exactNotional: exactShares * currentPrice,
        exactPercent: (exactShares * currentPrice / current.netLiquidation) * 100,
        bufferedShares,
        bufferedNotional: bufferedShares * currentPrice,
        bufferedPercent: (
          bufferedShares * currentPrice / current.netLiquidation
        ) * 100,
      };
      const planned = plannedShortByConId.get(conId) || 0;
      plannedShortByConId.set(conId, planned + quantity.shares);
      securitiesCashFloor += cashNotional;
      shortMarketValue += markedNotional;
      shortCollateral += collateralPerShare * quantity.shares;
    } else if (action === 'cover_short') {
      const planned = plannedShortByConId.get(conId) || 0;
      if (!conId || shortPosition + planned + EPSILON < quantity.shares) {
        return unavailable('cover_exceeds_verified_short_position');
      }
      if (collateralPerShare === null || collateralPerShare <= 0) {
        return unavailable('short_prior_close_unavailable');
      }
      plannedShortByConId.set(conId, planned - quantity.shares);
      securitiesCashFloor -= cashNotional;
      shortMarketValue = Math.max(0, shortMarketValue - markedNotional);
      shortCollateral = Math.max(
        0,
        shortCollateral - collateralPerShare * quantity.shares,
      );
    }

    projectedLegs.push({
      id,
      action,
      symbol: legEvidence.symbol || rawLeg.symbol || null,
      conId,
      quantityMode: quantity.mode,
      requestedQuantity: quantity.requested,
      shares: quantity.shares,
      unallocated: quantity.unallocated,
      fillPrice,
      priceMode: rawLeg.priceMode || 'live_side',
      bid,
      ask,
      last: finiteNumber(legEvidence.last),
      currentPrice,
      quoteObservedAt: legEvidence.quoteObservedAt || null,
      priorClose,
      priorCloseSessionDate: legEvidence.priorCloseSessionDate || null,
      shortableShares: finiteNumber(legEvidence.shortableShares),
      cashImpact: action === 'buy_long' || action === 'cover_short'
        ? -cashNotional
        : cashNotional,
      exposureImpact: action === 'buy_long' || action === 'add_short'
        ? markedNotional
        : -markedNotional,
      shortCapacity,
    });
  }

  const balances = calculateBalances({
    securitiesCashFloor,
    commodityResidual: snapshot.cash.commodityResidual,
    shortCollateral,
    accruedDebitReserve: snapshot.cash.accruedDebitReserve,
    netLiquidation: current.netLiquidation,
    longMarketValue,
  });
  return {
    available: true,
    status: 'preview',
    source: 'ibkr_live_session',
    accountId: snapshot.accountId,
    fromCache: false,
    basedOnSnapshotId: snapshot.snapshotId || null,
    observedAt: snapshot.observedAt,
    conditionalOnFill: true,
    orderSubmitted: false,
    legs: projectedLegs,
    exposure: exposureSnapshot({
      netLiquidation: current.netLiquidation,
      longMarketValue,
      shortMarketValue,
    }),
    cash: {
      noBorrowBalance: balances.exact.balance,
      addLongRoom: balances.exact.addLongRoom,
      trimRequired: balances.exact.trimRequired,
      noBorrowLongLimit: balances.exact.longLimit,
      shortCollateral,
      securitiesCashFloor,
    },
    buffer: {
      ...balances.buffer,
      bufferedLongLimit: balances.buffer.longLimit,
    },
    exact: {
      remainingRoom: balances.exact.addLongRoom,
      trimRequired: balances.exact.trimRequired,
    },
    buffered: {
      remainingRoom: balances.buffer.addLongRoom,
      trimRequired: balances.buffer.trimRequired,
    },
  };
}

function projectPortfolioBalance(snapshot, request, shortEvidence = null) {
  if (Array.isArray(request?.legs)) {
    return projectPortfolioBalanceLegs(snapshot, request, shortEvidence);
  }
  if (snapshot?.available !== true || snapshot?.status !== 'live') {
    return unavailable('baseline_unavailable');
  }
  if (snapshot?.activity?.openOrderCount > 0) {
    return unavailable('open_orders_present');
  }
  const action = String(request?.action || '').trim().toLowerCase();
  const current = snapshot.exposure;
  let longMarketValue = current.longMarketValue;
  let shortMarketValue = current.shortMarketValue;
  let securitiesCashFloor = snapshot.cash.securitiesCashFloor;
  let shortCollateral = snapshot.cash.shortCollateral;
  const details = { action, conditionalOnFill: true, orderSubmitted: false };

  if (action === 'add_long' || action === 'trim_long') {
    const amount = finiteNumber(request?.amount);
    if (amount === null || amount <= 0) return unavailable('invalid_long_amount');
    if (action === 'trim_long' && amount > longMarketValue + EPSILON) {
      return unavailable('trim_exceeds_current_long_exposure');
    }
    const direction = action === 'add_long' ? 1 : -1;
    longMarketValue = Math.max(0, longMarketValue + direction * amount);
    securitiesCashFloor -= direction * amount;
    details.amount = amount;
  } else if (action === 'add_short' || action === 'cover_short') {
    const conId = normalizeConId(request?.conId);
    const quantity = finiteNumber(request?.quantity);
    const limitPrice = finiteNumber(request?.limitPrice);
    const position = snapshot.shortPositions.find((row) => row.conId === conId);
    if (!position) return unavailable('short_position_not_found');
    if (quantity === null || quantity <= 0) return unavailable('invalid_short_quantity');
    if (limitPrice === null || limitPrice <= 0) return unavailable('invalid_limit_price');
    if (!shortEvidence || shortEvidence.available !== true) {
      return unavailable('live_short_evidence_unavailable');
    }
    const evidenceConId = normalizeConId(shortEvidence.conId);
    const bid = finiteNumber(shortEvidence.bid);
    const ask = finiteNumber(shortEvidence.ask);
    const currentPrice = finiteNumber(shortEvidence.currentPrice);
    const verifiedPositionQuantity = finiteNumber(shortEvidence.positionQuantity);
    if (
      evidenceConId !== conId
      || bid === null || bid <= 0
      || ask === null || ask <= 0
      || currentPrice === null || currentPrice <= 0
      || verifiedPositionQuantity === null || verifiedPositionQuantity >= 0
      || Number(shortEvidence.marketDataType) !== 1
    ) return unavailable('live_short_evidence_invalid');
    if (Math.abs(verifiedPositionQuantity - position.quantity) > EPSILON) {
      return unavailable('live_short_position_changed');
    }
    const verifiedAbsoluteQuantity = Math.abs(verifiedPositionQuantity);
    if (action === 'cover_short' && quantity > verifiedAbsoluteQuantity + EPSILON) {
      return unavailable('cover_exceeds_verified_short_position');
    }
    if (action === 'add_short') {
      const shortableShares = finiteNumber(shortEvidence.shortableShares);
      if (shortableShares === null || shortableShares < quantity) {
        return unavailable('insufficient_verified_shortable_shares');
      }
      if (limitPrice > bid + EPSILON) {
        return unavailable('add_short_limit_above_live_bid');
      }
    }
    if (action === 'cover_short' && limitPrice + EPSILON < ask) {
      return unavailable('cover_short_limit_below_live_ask');
    }
    const direction = action === 'add_short' ? 1 : -1;
    const cashNotional = quantity * limitPrice;
    const markedNotional = quantity * currentPrice;
    securitiesCashFloor += direction * cashNotional;
    shortCollateral = Math.max(
      0,
      shortCollateral + direction * quantity * position.collateralPerShare,
    );
    shortMarketValue = Math.max(0, shortMarketValue + direction * markedNotional);
    Object.assign(details, {
      conId,
      symbol: position.symbol,
      quantity,
      limitPrice,
      bid,
      ask,
      currentPrice,
      shortableShares:
        action === 'add_short' ? finiteNumber(shortEvidence.shortableShares) : null,
      orderType: 'limit',
    });
  } else {
    return unavailable('unsupported_preview_action');
  }

  const balances = calculateBalances({
    securitiesCashFloor,
    commodityResidual: snapshot.cash.commodityResidual,
    shortCollateral,
    accruedDebitReserve: snapshot.cash.accruedDebitReserve,
    netLiquidation: current.netLiquidation,
    longMarketValue,
  });
  return {
    available: true,
    status: 'preview',
    source: 'ibkr_live_session',
    accountId: snapshot.accountId,
    fromCache: false,
    basedOnSnapshotId: snapshot.snapshotId || null,
    observedAt: snapshot.observedAt,
    ...details,
    exposure: exposureSnapshot({
      netLiquidation: current.netLiquidation,
      longMarketValue,
      shortMarketValue,
    }),
    cash: {
      noBorrowBalance: balances.exact.balance,
      addLongRoom: balances.exact.addLongRoom,
      trimRequired: balances.exact.trimRequired,
      noBorrowLongLimit: balances.exact.longLimit,
      shortCollateral,
      securitiesCashFloor,
    },
    buffer: {
      ...balances.buffer,
      bufferedLongLimit: balances.buffer.longLimit,
    },
  };
}

module.exports = {
  calculatePortfolioBalance,
  calculatePortfolioExposure,
  parseCashLadder,
  projectPortfolioBalance,
};
