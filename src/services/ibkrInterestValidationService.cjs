const crypto = require('crypto');
const path = require('path');
const {
  calculateInterestGuardReserve,
  calibrateProspectiveInterest,
  forecastIbkrDebitInterest,
} = require('../utils/ibkrInterestValidation.cjs');
const {
  createIbkrFlexInterestService,
} = require('./ibkrFlexInterestService.cjs');
const {
  coveredMonthFromDescription,
  deriveDailyStockBorrowFees,
  deriveMonthlyPaid,
  deriveStockBorrowFeePayments,
  isStockBorrowFeeTransaction,
} = require('../utils/ibkrFlexInterest.cjs');
const {
  fetchOfficialUsdProMarginSchedule,
} = require('./ibkrPublishedMarginRateService.cjs');
const {
  DEFAULT_DATA_DIR,
  createInterestValidationStore,
} = require('./ibkrInterestValidationStore.cjs');
const {
  sidecarRequest,
} = require('./providers/ibkrSidecarClient');

const SOURCE = 'ibkr_interest_validation';
const MODEL_VERSION = 'ibkr-interest-validation-v1';
const TIME_ZONE = 'America/New_York';
const LOOKBACK_DAYS = 45;
const DEFAULT_POLL_MS = 60_000;
const MAX_RATE_AGE_DAYS = 7;
const OBSERVATION_MAX_AGE_MS = 45_000;
const OBSERVATION_FUTURE_TOLERANCE_MS = 5_000;
const ACCOUNT_VALUE_TOLERANCE = 0.01;
const EVENT_CONTRACT_POSITION_SCOPE = 'stocks_and_event_contracts';
const LEGACY_EVENT_CONTRACT_POSITION_SCOPE = 'stocks_and_kalshi';
const EVENT_CONTRACT_VENUES = new Set(['KALSHI', 'FORECASTX']);
const FORECAST_KINDS = new Set([
  'completed_session_window',
  'closed_day_remaining_window',
]);
const FLEX_SYNC_SLOTS = Object.freeze([
  { id: '06:30', minuteOfDay: (6 * 60) + 30 },
  { id: '09:35', minuteOfDay: (9 * 60) + 35 },
  { id: '12:05', minuteOfDay: (12 * 60) + 5 },
]);
const VALID_GUARD_MODES = new Set(['off', 'observe', 'graduated']);

function isoDate(value) {
  const text = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const parsed = Date.parse(`${text}T00:00:00Z`);
  return Number.isFinite(parsed) ? text : null;
}

function addUtcDays(value, count) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}

function daysBetween(left, right) {
  return Math.floor(
    (Date.parse(`${right}T00:00:00Z`) - Date.parse(`${left}T00:00:00Z`))
    / 86_400_000,
  );
}

function nyParts(value, timeZone = TIME_ZONE) {
  const date = value instanceof Date ? value : new Date(value);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    date: `${byType.year}-${byType.month}-${byType.day}`,
    weekday: byType.weekday,
    hour: Number(byType.hour),
    minute: Number(byType.minute),
  };
}

function afterMinute(parts, minuteOfDay) {
  return (parts.hour * 60) + parts.minute >= minuteOfDay;
}

function forecastAttemptWindowOpen(parts, force = false) {
  return (
    force
    || ['Sat', 'Sun'].includes(parts.weekday)
    || afterMinute(parts, (16 * 60) + 30)
  );
}

function maskAccountId(accountId) {
  const value = String(accountId || '').trim();
  return value ? `••••${value.slice(-4)}` : null;
}

function accountFingerprint(accountId) {
  return crypto.createHash('sha256').update(String(accountId || '')).digest('hex');
}

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizedVenueList(value) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map(
    (venue) => String(venue || '').trim().toUpperCase(),
  ).filter(Boolean))).sort();
}

function canonicalPositionScope(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === LEGACY_EVENT_CONTRACT_POSITION_SCOPE
    ? EVENT_CONTRACT_POSITION_SCOPE
    : normalized;
}

function normalizeDateKey(value) {
  const text = String(value || '');
  if (/^\d{8}$/.test(text)) {
    return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  }
  return isoDate(text);
}

function parseCashLadder(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.entries(value).reduce((result, [date, amount]) => {
      const normalizedDate = normalizeDateKey(date);
      const normalizedAmount = finite(amount);
      if (normalizedDate && normalizedAmount !== null) {
        result[normalizedDate] = normalizedAmount;
      }
      return result;
    }, {});
  }
  if (typeof value !== 'string' || !value.trim()) return {};
  return value.split(/[;,|]/).reduce((result, entry) => {
    const match = entry.trim().match(
      /^(\d{8}|\d{4}-\d{2}-\d{2})\s*[:=]\s*([-+]?(?:\d+(?:\.\d*)?|\.\d+))$/,
    );
    if (!match) return result;
    const normalizedDate = normalizeDateKey(match[1]);
    const amount = finite(match[2]);
    if (normalizedDate && amount !== null) result[normalizedDate] = amount;
    return result;
  }, {});
}

function exactLadderBalance(value, date) {
  const ladder = parseCashLadder(value);
  return Object.prototype.hasOwnProperty.call(ladder, date)
    ? ladder[date]
    : null;
}

function terminalLadderBalance(value) {
  const ladder = parseCashLadder(value);
  const terminalDate = Object.keys(ladder).sort().at(-1);
  return terminalDate
    ? { date: terminalDate, balance: ladder[terminalDate] }
    : null;
}

function flexReportingRange(parts, lookbackDays = LOOKBACK_DAYS) {
  let toDate = addUtcDays(parts.date, -1);
  while ([0, 6].includes(new Date(`${toDate}T00:00:00Z`).getUTCDay())) {
    toDate = addUtcDays(toDate, -1);
  }
  return {
    fromDate: addUtcDays(toDate, -(lookbackDays - 1)),
    toDate,
  };
}

function normalizeGuardMode(value) {
  const mode = String(value || 'graduated').trim().toLowerCase();
  return VALID_GUARD_MODES.has(mode) ? mode : 'off';
}

function getConfig(env = process.env) {
  const expectedAccountId = String(
    env.IBKR_FLEX_INTEREST_EXPECTED_ACCOUNT_ID
    || env.IBKR_FLEX_EXPECTED_ACCOUNT_ID
    || env.IBKR_ACCOUNT_ID
    || '',
  ).trim();
  const dataDirValue = String(
    env.IBKR_INTEREST_VALIDATION_DATA_DIR || DEFAULT_DATA_DIR,
  ).replace(/^~(?=$|\/)/, require('os').homedir());
  return {
    enabled: String(env.IBKR_INTEREST_VALIDATION_ENABLED || '').toLowerCase() === 'true',
    expectedAccountId,
    accountMasked: maskAccountId(expectedAccountId),
    accountFingerprint: accountFingerprint(expectedAccountId),
    guardMode: normalizeGuardMode(env.IBKR_INTEREST_GUARD_MODE),
    timeZone: env.IBKR_INTEREST_VALIDATION_TIME_ZONE || TIME_ZONE,
    pollMs: Math.max(
      10_000,
      Number(env.IBKR_INTEREST_VALIDATION_POLL_MS) || DEFAULT_POLL_MS,
    ),
    dataDir: path.resolve(dataDirValue),
  };
}

function safePublicError(error) {
  const code = String(error?.code || error?.sidecarCode || error?.reason || 'interest_validation_error')
    .replace(/[^a-zA-Z0-9_-]/g, '_');
  return {
    code,
    message: code.startsWith('flex_')
      ? 'IBKR Flex interest data is unavailable.'
      : 'Verified IBKR interest inputs are unavailable.',
  };
}

function isFreshObservationTimestamp(value, currentTimeMs) {
  const timestamp = Date.parse(String(value || ''));
  if (!Number.isFinite(timestamp) || !Number.isFinite(currentTimeMs)) return false;
  const ageMs = currentTimeMs - timestamp;
  return (
    ageMs >= -OBSERVATION_FUTURE_TOLERANCE_MS
    && ageMs <= OBSERVATION_MAX_AGE_MS
  );
}

function freshestLiveAccruedObservation(observations, currentTimeMs) {
  const latest = (Array.isArray(observations) ? observations : [])
    .filter((row) => (
      row?.verified === true
      && finite(row?.liveAccruedCash) !== null
      && Number.isFinite(Date.parse(String(row?.observedAt || '')))
    ))
    .sort((left, right) => (
      String(left.observedAt).localeCompare(String(right.observedAt))
      || Number(left.sequence || 0) - Number(right.sequence || 0)
    ))
    .at(-1) || null;
  return latest && isFreshObservationTimestamp(latest.observedAt, currentTimeMs)
    ? latest
    : null;
}

function requireLiveObservation(
  response,
  expectedAccountId,
  { now: currentTime = new Date() } = {},
) {
  const forecast = response?.forecast || {};
  const marketCalendar = response?.market_calendar || {};
  const executionEvidence = response?.execution_evidence;
  const positionScope = response?.position_scope || {};
  const eventAccounting = response?.event_accounting;
  const eventPositions = response?.event_position_evidence;
  const summary = response?.summary || {};
  const account = String(response?.account || '').trim();
  const currentTimeMs = currentTime instanceof Date
    ? currentTime.getTime()
    : Date.parse(String(currentTime || ''));
  const sessionDate = isoDate(forecast.sessionDate);
  const nextSessionDate = isoDate(forecast.nextSessionDate);
  const basisSessionDate = isoDate(forecast.basisSessionDate);
  const cashAnchorDate = isoDate(forecast.cashAnchorDate);
  const forecastKind = String(
    forecast.forecastKind || forecast.kind || '',
  ).trim().toLowerCase();
  const priorCompletedSessionDate = isoDate(
    forecast.priorCompletedSessionDate,
  );
  const sessionCloseAtMs = Date.parse(
    String(forecast.currentSessionCloseAt || ''),
  );
  const accrualDays = finite(forecast.accrualDays);
  const securitiesLadder = summary['SettledCashByDate-S']
    ?? response?.settlement_ladders?.securities;
  const commoditiesLadder = summary['SettledCashByDate-C']
    ?? response?.settlement_ladders?.commodities;
  const ibuklLadder = summary['SettledCashByDate-Z']
    ?? response?.settlement_ladders?.z;
  const securitiesCash = exactLadderBalance(
    securitiesLadder,
    cashAnchorDate,
  );
  const commoditiesCash = exactLadderBalance(
    commoditiesLadder,
    cashAnchorDate,
  );
  const securitiesTerminalCash = terminalLadderBalance(securitiesLadder);
  const commoditiesTerminalCash = terminalLadderBalance(commoditiesLadder);
  const ibuklTerminalCash = terminalLadderBalance(ibuklLadder);
  const securitiesTotalCash = finite(summary['TotalCashValue-S']);
  const commoditiesTotalCash = finite(summary['TotalCashValue-C']);
  const ibuklCash = exactLadderBalance(ibuklLadder, cashAnchorDate);
  const ibuklTotalCash = finite(summary['TotalCashValue-Z']);
  const fxCashBalance = finite(summary.FxCashBalance);
  const commodityMaintenanceMargin = finite(summary['MaintMarginReq-C']);
  const rawPositionScopeMode = String(positionScope.mode || '').trim().toLowerCase();
  const positionScopeMode = canonicalPositionScope(rawPositionScopeMode);
  const eventPositionCount = Number(positionScope.eventPositionCount);
  const stockPositionCount = Number(positionScope.stockPositionCount);
  const eventMarketValue = finite(eventAccounting?.marketValue);
  const eventAvailableFunds = finite(eventAccounting?.availableFunds);
  const eventVenues = normalizedVenueList(
    Array.isArray(eventAccounting?.venues)
      ? eventAccounting.venues
      : eventAccounting?.venue
        ? [eventAccounting.venue]
        : [],
  );
  const liveAccruedCash = finite(summary['AccruedCash-S']);
  const shortPositions = response?.short_positions;
  const reasons = [];
  const observationTimestamps = [
    response?.observed_at,
    response?.socket_verified_at,
    response?.account_values_observed_at,
    response?.positions_observed_at,
    response?.executions_observed_at,
  ];

  if (
    response?.ok !== true
    || response?.connected !== true
    || response?.status !== 'live'
    || response?.source !== 'ibkr_live_interest_observation'
    || response?.from_cache !== false
    || response?.freshness?.status !== 'fresh'
    || Number(response?.freshness?.account_reads) !== 2
    || Number(response?.freshness?.position_reads) !== 2
    || Number(response?.freshness?.execution_reads) !== 2
  ) {
    reasons.push('interest_observation_unverified');
  }
  if (
    !Number.isFinite(currentTimeMs)
    || observationTimestamps.some(
      (timestamp) => !isFreshObservationTimestamp(timestamp, currentTimeMs),
    )
  ) {
    reasons.push('interest_observation_timestamp_unverified');
  }
  if (!expectedAccountId || account !== expectedAccountId) {
    reasons.push('interest_observation_account_mismatch');
  }
  if (
    forecast.eligible !== true
    || !sessionDate
    || !nextSessionDate
    || !basisSessionDate
    || !cashAnchorDate
    || ![sessionDate, basisSessionDate].includes(cashAnchorDate)
    || !FORECAST_KINDS.has(forecastKind)
    || accrualDays === null
    || !Number.isInteger(accrualDays)
    || accrualDays <= 0
    || daysBetween(sessionDate, nextSessionDate) !== accrualDays
  ) {
    reasons.push('interest_observation_forecast_ineligible');
  }
  const sharedCalendarInvalid = (
    marketCalendar.verifiedNyDate !== sessionDate
    || isoDate(marketCalendar.sessionDate) !== sessionDate
    || finite(marketCalendar.accrualDays) !== accrualDays
    || marketCalendar.nextSessionDate !== nextSessionDate
    || isoDate(marketCalendar.basisSessionDate) !== basisSessionDate
    || isoDate(marketCalendar.cashAnchorDate) !== cashAnchorDate
    || String(
      marketCalendar.forecastKind || marketCalendar.kind || '',
    ).trim().toLowerCase() !== forecastKind
    || marketCalendar.source
      !== 'ibkr_contract_details_and_historical_schedule'
    || typeof marketCalendar.liquidHours !== 'string'
    || !marketCalendar.liquidHours.trim()
    || forecast.nextSessionDate !== marketCalendar.nextSessionDate
    || forecast.currentSessionCloseAt
      !== marketCalendar.currentSessionCloseAt
    || forecast.priorCompletedSessionDate
      !== marketCalendar.priorCompletedSessionDate
    || forecast.verification !== 'ibkr_liquid_hours_and_broker_time'
  );
  const completedSessionCalendarInvalid = (
    forecastKind === 'completed_session_window'
    && (
      basisSessionDate !== sessionDate
      || cashAnchorDate !== sessionDate
      || marketCalendar.currentSessionScheduled !== true
      || marketCalendar.currentSessionComplete !== true
      || marketCalendar.latestCompletedSessionDate !== sessionDate
      || forecast.currentSessionScheduled !== true
      || forecast.currentSessionComplete !== true
      || forecast.latestCompletedSessionDate !== sessionDate
      || !priorCompletedSessionDate
      || priorCompletedSessionDate >= sessionDate
      || !Number.isFinite(sessionCloseAtMs)
      || !String(forecast.currentSessionCloseAt || '').startsWith(sessionDate)
      || sessionCloseAtMs > currentTimeMs + OBSERVATION_FUTURE_TOLERANCE_MS
    )
  );
  const closedDayCalendarInvalid = (
    forecastKind === 'closed_day_remaining_window'
    && (
      basisSessionDate >= sessionDate
      || cashAnchorDate !== sessionDate
      || priorCompletedSessionDate !== basisSessionDate
      || marketCalendar.latestCompletedSessionDate !== basisSessionDate
      || forecast.latestCompletedSessionDate !== basisSessionDate
      || marketCalendar.currentSessionScheduled !== false
      || marketCalendar.currentSessionComplete !== false
      || forecast.currentSessionScheduled !== false
      || forecast.currentSessionComplete !== false
      || forecast.currentSessionCloseAt != null
      || marketCalendar.currentSessionCloseAt != null
    )
  );
  if (
    sharedCalendarInvalid
    || completedSessionCalendarInvalid
    || closedDayCalendarInvalid
  ) {
    reasons.push('interest_observation_calendar_unverified');
  }
  if (securitiesCash === null || commoditiesCash === null) {
    reasons.push('interest_observation_cash_ladder_incomplete');
  }
  if (
    securitiesTerminalCash === null
    || commoditiesTerminalCash === null
    || ibuklTerminalCash === null
    || securitiesTotalCash === null
    || commoditiesTotalCash === null
    || ibuklTotalCash === null
    || Math.abs(securitiesTerminalCash.balance - securitiesTotalCash)
      > ACCOUNT_VALUE_TOLERANCE
    || Math.abs(commoditiesTerminalCash.balance - commoditiesTotalCash)
      > ACCOUNT_VALUE_TOLERANCE
    || Math.abs(ibuklTerminalCash.balance - ibuklTotalCash)
      > ACCOUNT_VALUE_TOLERANCE
  ) {
    reasons.push('interest_observation_cash_ladder_unreconciled');
  }
  if (
    ibuklCash === null
    || ibuklCash !== 0
    || fxCashBalance !== 0
    || (ibuklTotalCash !== null && ibuklTotalCash !== 0)
  ) {
    reasons.push('interest_observation_ibukl_ladder_incomplete');
  }
  if (commodityMaintenanceMargin === null || commodityMaintenanceMargin < 0) {
    reasons.push('interest_observation_commodity_margin_incomplete');
  }
  if (
    !['stocks_only', EVENT_CONTRACT_POSITION_SCOPE].includes(positionScopeMode)
    || positionScope.allSupportedForBalance !== true
    || !Number.isInteger(stockPositionCount)
    || stockPositionCount < 0
    || !Number.isInteger(eventPositionCount)
    || eventPositionCount < 0
    || !Array.isArray(eventPositions)
    || eventPositions.length !== eventPositionCount
  ) {
    reasons.push('interest_observation_position_scope_unverified');
  } else if (positionScopeMode === 'stocks_only') {
    if (
      eventPositionCount !== 0
      || eventAccounting != null
      || normalizedVenueList(positionScope.eventVenues).length !== 0
    ) {
      reasons.push('interest_observation_position_scope_unverified');
    }
  } else {
    const eventConIds = new Set();
    const eventPositionVenues = normalizedVenueList(
      eventPositions.map((position) => position?.exchange),
    );
    const accountingVenues = eventVenues;
    const scopeVenues = normalizedVenueList(
      Array.isArray(positionScope.eventVenues)
        ? positionScope.eventVenues
        : accountingVenues,
    );
    const venueListsMatch = (left, right) => (
      left.length === right.length
      && left.every((venue, index) => venue === right[index])
    );
    const legacyKalshiEvidence = (
      rawPositionScopeMode === LEGACY_EVENT_CONTRACT_POSITION_SCOPE
      && eventAccounting?.verification
        === 'ibkr_kalshi_commodity_segment_reconciled'
      && accountingVenues.length === 1
      && accountingVenues[0] === 'KALSHI'
    );
    const accountValues = eventAccounting?.accountValues || {};
    const commodityCash = finite(accountValues['TotalCashValue-C']);
    const netLiquidation = finite(accountValues['NetLiquidation-C']);
    const initialMargin = finite(accountValues['InitMarginReq-C']);
    const maintenanceMargin = finite(accountValues['MaintMarginReq-C']);
    const availableFunds = finite(accountValues['AvailableFunds-C']);
    const equityWithLoanValue = finite(
      accountValues['EquityWithLoanValue-C'],
    );
    const theoreticalAvailableFunds = (
      netLiquidation === null || initialMargin === null
        ? null
        : netLiquidation - initialMargin
    );
    const availableFundsHoldback = finite(
      eventAccounting?.availableFundsHoldback,
    );
    const withinCent = (left, right) => (
      left !== null
      && right !== null
      && Math.abs(left - right) <= ACCOUNT_VALUE_TOLERANCE
    );
    if (
      eventPositionCount <= 0
      || accountingVenues.length === 0
      || accountingVenues.some((venue) => !EVENT_CONTRACT_VENUES.has(venue))
      || !venueListsMatch(accountingVenues, scopeVenues)
      || !venueListsMatch(accountingVenues, eventPositionVenues)
      || eventAccounting?.positionCount !== eventPositionCount
      || (
        eventAccounting?.verification
          !== 'ibkr_event_contract_commodity_segment_reconciled'
        && !legacyKalshiEvidence
      )
      || finite(eventAccounting?.capacityContribution) !== 0
      || eventMarketValue === null
      || eventMarketValue < 0
      || eventAvailableFunds === null
      || eventAvailableFunds < 0
      || commodityCash === null
      || netLiquidation === null
      || initialMargin === null
      || maintenanceMargin === null
      || availableFunds === null
      || equityWithLoanValue === null
      || !withinCent(
        finite(eventAccounting?.maintenanceMargin),
        commodityMaintenanceMargin,
      )
      || !withinCent(finite(eventAccounting?.initialMargin), initialMargin)
      || !withinCent(
        finite(eventAccounting?.equityWithLoanValue),
        equityWithLoanValue,
      )
      || !withinCent(
        finite(eventAccounting?.theoreticalAvailableFunds),
        theoreticalAvailableFunds,
      )
      || !withinCent(
        finite(accountValues['GrossPositionValue-C']),
        eventMarketValue,
      )
      || !withinCent(commodityCash, commoditiesTotalCash)
      || !withinCent(maintenanceMargin, commodityMaintenanceMargin)
      || !withinCent(netLiquidation, commodityCash + eventMarketValue)
      || !withinCent(initialMargin, eventMarketValue)
      || !withinCent(maintenanceMargin, eventMarketValue)
      || !withinCent(
        equityWithLoanValue,
        commodityCash + eventMarketValue - maintenanceMargin,
      )
      || !withinCent(availableFunds, eventAvailableFunds)
      || theoreticalAvailableFunds === null
      || availableFunds
        > theoreticalAvailableFunds + ACCOUNT_VALUE_TOLERANCE
      || availableFundsHoldback === null
      || !withinCent(
        availableFundsHoldback,
        Math.max(0, theoreticalAvailableFunds - availableFunds),
      )
      || eventPositions.some((position) => {
        const conId = Number(position?.conId);
        const quantity = finite(position?.quantity);
        const exchange = String(
          position?.exchange || '',
        ).trim().toUpperCase();
        const secType = String(
          position?.secType || '',
        ).trim().toUpperCase();
        const supportedContractType = (
          secType === 'OPT'
          || (exchange === 'FORECASTX' && secType === 'FOP')
        );
        const invalid = !Number.isInteger(conId)
          || conId <= 0
          || eventConIds.has(conId)
          || quantity === null
          || quantity <= 0
          || !EVENT_CONTRACT_VENUES.has(exchange)
          || !supportedContractType
          || position?.currency !== 'USD'
          || finite(position?.multiplier) !== 1;
        eventConIds.add(conId);
        return invalid;
      })
    ) {
      reasons.push('interest_observation_event_accounting_unverified');
    }
  }
  if (liveAccruedCash === null) {
    reasons.push('interest_observation_accrued_cash_incomplete');
  }
  if (!Array.isArray(shortPositions)) {
    reasons.push('interest_observation_short_positions_incomplete');
  } else {
    const conIds = new Set();
    for (const position of shortPositions) {
      const conId = Number(position?.conId ?? position?.conid);
      const quantity = finite(position?.quantity);
      const priorClose = finite(position?.priorClose);
      if (
        !Number.isInteger(conId)
        || conId <= 0
        || conIds.has(conId)
        || quantity === null
        || quantity >= 0
        || priorClose === null
        || priorClose <= 0
        || String(position?.currency || '').toUpperCase() !== 'USD'
        || position?.priorCloseSource !== 'ibkr_historical_daily_close'
        || position?.priorCloseSessionDate
          !== marketCalendar.priorCompletedSessionDate
        || position?.snapshotTimestamp !== response?.positions_observed_at
        || !isFreshObservationTimestamp(
          position?.priorCloseObservedAt,
          currentTimeMs,
        )
        || !isFreshObservationTimestamp(
          position?.snapshotTimestamp,
          currentTimeMs,
        )
      ) {
        reasons.push('interest_observation_short_provenance_unverified');
        break;
      }
      conIds.add(conId);
    }
  }
  if (
    !executionEvidence
    || typeof executionEvidence !== 'object'
    || Array.isArray(executionEvidence)
    || !Number.isInteger(executionEvidence.count)
    || executionEvidence.count < 0
    || !Array.isArray(executionEvidence.rows)
    || executionEvidence.rows.length !== executionEvidence.count
    || executionEvidence.asOf !== response?.executions_observed_at
    || !isFreshObservationTimestamp(executionEvidence.asOf, currentTimeMs)
  ) {
    reasons.push('interest_observation_execution_unverified');
  } else {
    const executionIds = executionEvidence.rows.map(
      (row) => String(row?.execId || '').trim(),
    );
    if (
      executionIds.some((executionId) => !executionId)
      || new Set(executionIds).size !== executionIds.length
    ) {
      reasons.push('interest_observation_execution_unverified');
    }
  }
  if (!/^[a-f0-9]{64}$/.test(String(response?.evidence_hash || ''))) {
    reasons.push('interest_observation_hash_unverified');
  }
  if (reasons.length) {
    const error = new Error(reasons[0]);
    error.code = reasons[0];
    error.reasons = reasons;
    throw error;
  }

  return {
    account,
    sessionDate,
    basisSessionDate,
    cashAnchorDate,
    nextSessionDate,
    forecastKind,
    accrualDays,
    observedAt: response.observed_at,
    socketVerifiedAt: response.socket_verified_at,
    accountValuesObservedAt: response.account_values_observed_at,
    evidenceHash: response.evidence_hash,
    currency: String(summary.baseCurrency || summary.currency || '').toUpperCase(),
    positionScope: positionScopeMode,
    eventVenues: positionScopeMode === EVENT_CONTRACT_POSITION_SCOPE
      ? eventVenues
      : [],
    securitiesCash,
    commoditiesCash,
    ibuklCash,
    commodityMaintenanceMargin,
    eventMarketValue: positionScopeMode === EVENT_CONTRACT_POSITION_SCOPE
      ? eventMarketValue
      : 0,
    // Backward-compatible alias for consumers of legacy stored observations.
    kalshiMarketValue: positionScopeMode === EVENT_CONTRACT_POSITION_SCOPE
      ? eventMarketValue
      : 0,
    commodityAvailableFunds: positionScopeMode === EVENT_CONTRACT_POSITION_SCOPE
      ? eventAvailableFunds
      : null,
    eventAccountingVerified: positionScopeMode === EVENT_CONTRACT_POSITION_SCOPE
      ? !reasons.includes('interest_observation_event_accounting_unverified')
      : true,
    liveAccruedCash,
    shortPositions: shortPositions.map((position) => ({
      conId: position.conId ?? position.conid ?? null,
      symbol: position.symbol || null,
      currency: position.currency,
      quantity: finite(position.quantity),
      priorClose: finite(position.priorClose),
    })),
  };
}

function requireLiveBalanceInterestObservation(
  snapshot,
  expectedAccountId,
  {
    now: currentTime = new Date(),
    timeZone = TIME_ZONE,
  } = {},
) {
  const account = String(snapshot?.accountId || snapshot?.account || '').trim();
  const observedAt = String(snapshot?.observedAt || '');
  const socketVerifiedAt = String(snapshot?.socketVerifiedAt || '');
  const currentTimeMs = currentTime instanceof Date
    ? currentTime.getTime()
    : Date.parse(String(currentTime || ''));
  const liveAccruedCash = finite(snapshot?.cash?.netAccruedInterest);
  const reasons = [];

  if (
    snapshot?.available !== true
    || snapshot?.status !== 'live'
    || snapshot?.source !== 'ibkr_live_session'
    || snapshot?.fromCache !== false
  ) {
    reasons.push('interest_balance_observation_unverified');
  }
  if (
    !Number.isFinite(currentTimeMs)
    || !isFreshObservationTimestamp(observedAt, currentTimeMs)
    || !isFreshObservationTimestamp(socketVerifiedAt, currentTimeMs)
  ) {
    reasons.push('interest_balance_observation_timestamp_unverified');
  }
  if (!expectedAccountId || account !== expectedAccountId) {
    reasons.push('interest_balance_observation_account_mismatch');
  }
  if (liveAccruedCash === null) {
    reasons.push('interest_balance_observation_accrued_cash_incomplete');
  }
  if (reasons.length) {
    const error = new Error(reasons[0]);
    error.code = reasons[0];
    error.reasons = reasons;
    throw error;
  }

  return {
    account,
    sessionDate: nyParts(new Date(observedAt), timeZone).date,
    observedAt,
    socketVerifiedAt,
    liveAccruedCash: Object.is(liveAccruedCash, -0) ? 0 : liveAccruedCash,
  };
}

function tierOrdinal(value, fallback) {
  const normalized = String(value || '').trim().toUpperCase();
  const roman = {
    I: 1,
    II: 2,
    III: 3,
    IV: 4,
    V: 5,
    VI: 6,
  };
  return roman[normalized] || Number(normalized) || fallback;
}

function tierPrincipal(row) {
  const reportedTotal = finite(row?.totalPrincipal);
  if (reportedTotal !== null) return Math.abs(reportedTotal);
  const components = [
    row?.securitiesPrincipal,
    row?.commoditiesPrincipal,
    row?.ibuklPrincipal,
  ]
    .map(finite)
    .filter((value) => value !== null);
  if (!components.length) return null;
  return components.reduce((total, value) => total + Math.abs(value), 0);
}

function latestVerifiedTierSchedule(
  snapshots,
  sessionDate,
  { maxAgeDays = MAX_RATE_AGE_DAYS } = {},
) {
  for (const snapshot of snapshots) {
    const rows = (snapshot?.tierDetails || [])
      .filter((row) => (
        row.currency === 'USD'
        && String(row.interestType || '').toLowerCase().includes('debit')
        && isoDate(row.valueDate || row.reportDate || row.toDate || row.fromDate)
        && (row.valueDate || row.reportDate || row.toDate || row.fromDate) <= sessionDate
      ));
    if (!rows.length) continue;
    const rateDate = rows
      .map((row) => row.valueDate || row.reportDate || row.toDate || row.fromDate)
      .sort()
      .at(-1);
    const rateAgeDays = daysBetween(rateDate, sessionDate);
    if (
      Number.isFinite(maxAgeDays)
      && rateAgeDays > maxAgeDays
    ) continue;
    const datedRows = rows
      .filter((row) => (
        (row.valueDate || row.reportDate || row.toDate || row.fromDate) === rateDate
      ))
      .sort((left, right) => (
        tierOrdinal(left.tierBreak, rows.indexOf(left) + 1)
        - tierOrdinal(right.tierBreak, rows.indexOf(right) + 1)
      ));
    if (datedRows.some((row) => (
      finite(row.rate) === null
      || tierPrincipal(row) === null
      || tierPrincipal(row) <= 0
    ))) {
      continue;
    }

    let cumulative = 0;
    const tiers = datedRows.map((row, index) => {
      cumulative += tierPrincipal(row);
      const rawRate = finite(row.rate);
      return {
        label: row.tierBreak || `tier_${index + 1}`,
        upTo: index === datedRows.length - 1 ? null : cumulative,
        annualRate: rawRate / 100,
      };
    });
    return {
      tiers,
      rateDate,
      observedPrincipalCoverage: cumulative,
      reportHash: snapshot.reportHash,
      revisionHash: snapshot.revisionHash,
      fetchedAt: snapshot.fetchedAt,
      rateAgeDays,
      source: 'ibkr_flex_interest_tier_detail',
      provisional: false,
    };
  }
  return null;
}

function corroborateIbkrProSchedule(accountSchedule, publishedSchedule) {
  const accountRate = finite(accountSchedule?.tiers?.[0]?.annualRate);
  const proRate = finite(publishedSchedule?.tiers?.[0]?.annualRate);
  const liteRate = finite(publishedSchedule?.liteAnnualRate);
  if (
    accountRate === null
    || proRate === null
    || liteRate === null
    || publishedSchedule?.plan !== 'IBKR Pro'
    || publishedSchedule?.currency !== 'USD'
  ) return false;
  const proDistance = Math.abs(accountRate - proRate);
  const liteDistance = Math.abs(accountRate - liteRate);
  return proDistance <= 0.0025 && proDistance < liteDistance;
}

async function resolveDebitRateEvidence({
  snapshots,
  sessionDate,
  fetchOfficialSchedule,
}) {
  const fresh = latestVerifiedTierSchedule(snapshots, sessionDate);
  if (fresh) {
    return {
      ...fresh,
      rateEvidence: {
        source: fresh.source,
        rateDate: fresh.rateDate,
        fetchedAt: fresh.fetchedAt,
        reportHash: fresh.reportHash,
        revisionHash: fresh.revisionHash,
        provisional: false,
      },
    };
  }

  const accountSchedule = latestVerifiedTierSchedule(
    snapshots,
    sessionDate,
    { maxAgeDays: Number.POSITIVE_INFINITY },
  );
  if (!accountSchedule) {
    const error = new Error('No account-specific Flex debit tiers are available to verify the pricing plan.');
    error.code = 'interest_rate_account_plan_unverified';
    throw error;
  }
  const published = await fetchOfficialSchedule();
  if (!corroborateIbkrProSchedule(accountSchedule, published)) {
    const error = new Error('The latest account-specific Flex tier does not corroborate the official IBKR Pro schedule.');
    error.code = 'interest_rate_account_plan_unverified';
    throw error;
  }
  return {
    tiers: published.tiers,
    rateDate: accountSchedule.rateDate,
    observedPrincipalCoverage: Number.POSITIVE_INFINITY,
    reportHash: accountSchedule.reportHash,
    revisionHash: accountSchedule.revisionHash,
    fetchedAt: published.fetchedAt,
    rateAgeDays: accountSchedule.rateAgeDays,
    source: published.source,
    provisional: true,
    rateEvidence: {
      source: published.source,
      url: published.url,
      fetchedAt: published.fetchedAt,
      scheduleHash: published.scheduleHash,
      plan: published.plan,
      currency: published.currency,
      provisional: true,
      corroboratedBy: {
        source: accountSchedule.source,
        rateDate: accountSchedule.rateDate,
        reportHash: accountSchedule.reportHash,
        revisionHash: accountSchedule.revisionHash,
        firstTierAnnualRate: accountSchedule.tiers[0].annualRate,
      },
    },
  };
}

function latestByDate(actuals) {
  return actuals.reduce((map, row) => {
    if (row.kind !== 'daily' || !isoDate(row.valueDate)) return map;
    const existing = map.get(row.valueDate);
    if (
      !existing
      || String(row.fetchedAt || '').localeCompare(String(existing.fetchedAt || '')) >= 0
    ) {
      map.set(row.valueDate, row);
    }
    return map;
  }, new Map());
}

function coveredValueDates(prediction) {
  if (!isoDate(prediction?.valueDate) || !Number.isInteger(prediction?.accrualDays)) {
    return [];
  }
  if (prediction.accrualDays <= 0) return [];
  const generatedDates = Array.from(
    { length: prediction.accrualDays },
    (_value, index) => addUtcDays(prediction.valueDate, index),
  );
  if (
    Array.isArray(prediction?.coveredValueDates)
    && prediction.coveredValueDates.length === prediction.accrualDays
    && prediction.coveredValueDates.every(
      (date, index) => isoDate(date) === generatedDates[index],
    )
  ) {
    return generatedDates;
  }
  return prediction?.coveredValueDates == null ? generatedDates : [];
}

function verifiedPredictionCoveringDate(predictions, date) {
  return [...predictions]
    .filter((prediction) => (
      prediction?.prospective === true
      && prediction?.verified === true
      && coveredValueDates(prediction).includes(date)
    ))
    .sort((left, right) => (
      String(left.issuedAt || '').localeCompare(String(right.issuedAt || ''))
      || String(left.valueDate || '').localeCompare(String(right.valueDate || ''))
    ))
    .at(-1) || null;
}

function predictionCoverageOverlaps(prediction, existingPredictions) {
  const dates = new Set(coveredValueDates(prediction));
  return dates.size > 0 && existingPredictions.some((existing) => (
    existing?.prospective === true
    && existing?.verified === true
    && coveredValueDates(existing).some((date) => dates.has(date))
  ));
}

function matchedActualForPrediction(prediction, actualByDate) {
  const direct = actualByDate.get(prediction.valueDate);
  if (
    direct
    && Number(direct.accrualDays) === Number(prediction.accrualDays)
  ) {
    return {
      ...direct,
      debitAmount: direct.debitAmount,
      componentActuals: [direct],
    };
  }
  const dates = coveredValueDates(prediction);
  if (!dates.length) return null;
  const components = dates.map((date) => actualByDate.get(date));
  if (components.some((row) => !row || Number(row.accrualDays || 1) !== 1)) {
    return null;
  }
  return {
    valueDate: prediction.valueDate,
    debitAmount: Number(
      components
        .reduce((total, row) => total + row.debitAmount, 0)
        .toFixed(2),
    ),
    fetchedAt: components
      .map((row) => row.fetchedAt)
      .filter(Boolean)
      .sort()
      .at(-1) || null,
    verified: components.every((row) => row.verified === true),
    provisional: components.some((row) => row.provisional === true),
    componentActuals: components,
  };
}

function forecastBand(prediction) {
  const point = finite(prediction?.point);
  const storedUpper = finite(prediction?.upper);
  const storedCushion = finite(prediction?.cushion);
  if (point === null || point < 0) {
    return { lower: null, point: null, upper: null };
  }
  const cushion = storedCushion !== null && storedCushion >= 0
    ? storedCushion
    : storedUpper !== null && storedUpper >= point
      ? storedUpper - point
      : 0;
  return {
    lower: Number(Math.max(0, point - cushion).toFixed(2)),
    point: Number(point.toFixed(2)),
    upper: Number(Math.max(point, storedUpper ?? point).toFixed(2)),
  };
}

function verifiedForecastComparison(prediction, actual) {
  if (!prediction || !actual) return null;
  const band = forecastBand(prediction);
  const actualInterest = finite(actual.debitAmount);
  if (
    band.lower === null
    || band.upper === null
    || actualInterest === null
    || actual.verified !== true
  ) return null;
  const withinBand = (
    actualInterest >= band.lower - 0.001
    && actualInterest <= band.upper + 0.001
  );
  return {
    status: 'verified',
    outcome: withinBand ? 'within_band' : 'miss',
    valueDate: prediction.valueDate || null,
    forecastLower: band.lower,
    forecastPoint: band.point,
    forecastUpper: band.upper,
    actual: Number(actualInterest.toFixed(2)),
    residual: Number((actualInterest - band.point).toFixed(2)),
    issuedAt: prediction.issuedAt || null,
    verifiedAt: actual.fetchedAt || null,
  };
}

function actualWasObservedAfterPrediction(prediction, actual) {
  const issuedAtMs = Date.parse(String(prediction?.issuedAt || ''));
  const components = Array.isArray(actual?.componentActuals)
    ? actual.componentActuals
    : [actual];
  return (
    Number.isFinite(issuedAtMs)
    && components.length > 0
    && components.every((component) => {
      const fetchedAtMs = Date.parse(String(component?.fetchedAt || ''));
      return Number.isFinite(fetchedAtMs) && fetchedAtMs > issuedAtMs;
    })
  );
}

function latestVerifiedForecastComparison(predictions, actualByDate) {
  return [...predictions]
    .filter((prediction) => (
      prediction?.prospective === true
      && prediction?.verified === true
    ))
    .sort((left, right) => (
      String(left.valueDate || '').localeCompare(String(right.valueDate || ''))
      || String(left.issuedAt || '').localeCompare(String(right.issuedAt || ''))
    ))
    .flatMap((prediction) => {
      const actual = matchedActualForPrediction(prediction, actualByDate);
      if (!actualWasObservedAfterPrediction(prediction, actual)) return [];
      const comparison = verifiedForecastComparison(prediction, actual);
      return comparison ? [comparison] : [];
    })
    .at(-1) || null;
}

function pendingForecastComparison(prediction, lastVerified = null) {
  const band = forecastBand(prediction);
  return {
    status: 'awaiting',
    outcome: 'pending',
    valueDate: prediction?.valueDate || null,
    forecastLower: band.lower,
    forecastPoint: band.point,
    forecastUpper: band.upper,
    actual: null,
    residual: null,
    issuedAt: prediction?.issuedAt || null,
    verifiedAt: null,
    lastVerified,
  };
}

function buildMatches(predictions, actuals) {
  const actualByDate = latestByDate(actuals);
  return predictions
    .filter((prediction) => prediction.prospective === true && prediction.verified === true)
    .sort((left, right) => left.valueDate.localeCompare(right.valueDate))
    .flatMap((prediction) => {
      const actual = matchedActualForPrediction(prediction, actualByDate);
      if (!actual) return [];
      if (!actualWasObservedAfterPrediction(prediction, actual)) return [];
      return [{
        id: prediction.identity,
        matched: true,
        prospective: true,
        verified: actual.verified === true,
        accrualDays: prediction.accrualDays,
        rawForecast: prediction.raw,
        issuedPointForecast: prediction.point,
        actualInterest: actual.debitAmount,
      }];
    });
}

function monthlyPaidForSnapshot(snapshot) {
  const hasCashEvidence = Array.isArray(snapshot?.cashTransactions)
    && (
      snapshot.cashTransactions.length > 0
      || snapshot.cashTransactionSectionPresent === true
    );
  return hasCashEvidence
    ? deriveMonthlyPaid(snapshot.cashTransactions)
    : (snapshot?.derived?.monthlyPaid || []);
}

function hasMonthlyReconciliation(snapshots) {
  return snapshots.some((snapshot) => {
    const paidRows = monthlyPaidForSnapshot(snapshot)
      .filter((row) => (
        row.currency === 'USD'
        && finite(row.paid) > 0
        && finite(row.net) !== null
      ));
    if (!paidRows.length) return false;
    const paidNet = Number(
      paidRows.reduce((total, row) => total + finite(row.net), 0).toFixed(2),
    );
    const borrowTotal = deriveStockBorrowFeePayments(
      Array.isArray(snapshot?.cashTransactions)
        ? snapshot.cashTransactions
        : [],
    )
      .filter((row) => row.currency === 'USD' && finite(row.amount) !== null)
      .reduce((total, row) => total + finite(row.amount), 0);
    return (snapshot?.cashReports || []).some((row) => {
      const reported = finite(row.brokerInterest);
      return (
        row.currency === 'USD'
        && reported !== null
        && (
          Math.abs(reported - paidNet) <= 0.01
          || Math.abs((reported + borrowTotal) - paidNet) <= 0.01
        )
      );
    });
  });
}

function ingestFlexSnapshots(store, snapshots) {
  // Validate the append-only journal once, then avoid asking appendRecord to
  // rescan and rehash the full file for every Flex row already materialized.
  // A cold startup commonly revisits hundreds of immutable rows; performing
  // the same fail-closed verification for each duplicate can starve Express.
  const knownActualIdentities = new Set(
    store.readRecords('actuals')
      .map((row) => row.identity || row.recordHash)
      .filter(Boolean),
  );
  const appendActual = (record) => {
    if (knownActualIdentities.has(record.identity)) return;
    const outcome = store.appendRecord('actuals', record);
    const storedIdentity = outcome?.record?.identity || record.identity;
    if (storedIdentity) knownActualIdentities.add(storedIdentity);
  };

  for (const snapshot of snapshots) {
    for (const row of snapshot?.derived?.dailyDebitActuals || []) {
      if (row.currency !== 'USD' || !isoDate(row.date)) continue;
      appendActual({
        identity: `daily|${row.date}|${snapshot.reportHash}`,
        kind: 'daily',
        valueDate: row.date,
        currency: 'USD',
        debitAmount: row.debitAmount,
        signedInterest: row.totalInterest,
        rowCount: row.rowCount,
        fromDate: row.fromDate || row.date,
        toDate: row.toDate || row.date,
        accrualDays: Number.isInteger(row.accrualDays)
          ? row.accrualDays
          : 1,
        reportHash: snapshot.reportHash,
        revisionHash: snapshot.revisionHash,
        fetchedAt: snapshot.fetchedAt,
        verified: true,
        provisional: true,
      });
    }
    const monthlyPaid = monthlyPaidForSnapshot(snapshot);
    for (const row of monthlyPaid) {
      if (row.currency !== 'USD' || !/^\d{4}-\d{2}$/.test(String(row.month || ''))) continue;
      appendActual({
        identity: `monthly-margin-only|${row.month}|${snapshot.reportHash}`,
        kind: 'monthly',
        classification: 'margin_debit_and_credit_interest_only',
        month: row.month,
        currency: 'USD',
        paid: row.paid,
        received: row.received,
        net: row.net,
        reportHash: snapshot.reportHash,
        revisionHash: snapshot.revisionHash,
        fetchedAt: snapshot.fetchedAt,
        verified: true,
        provisional: false,
      });
    }
  }
}

function monthStart(month) {
  return /^\d{4}-\d{2}$/.test(String(month || ''))
    ? `${month}-01`
    : null;
}

function previousMonth(month) {
  const start = monthStart(month);
  return start ? addUtcDays(start, -1).slice(0, 7) : null;
}

function actualOverlapsMonth(actual, month) {
  const start = isoDate(actual?.fromDate || actual?.valueDate);
  const end = isoDate(actual?.toDate || actual?.valueDate);
  const startOfMonth = monthStart(month);
  if (!start || !end || !startOfMonth) return false;
  const nextMonthDate = new Date(`${startOfMonth}T00:00:00Z`);
  nextMonthDate.setUTCMonth(nextMonthDate.getUTCMonth() + 1);
  const startOfNextMonth = nextMonthDate.toISOString().slice(0, 10);
  const endOfMonth = addUtcDays(startOfNextMonth, -1);
  return start <= endOfMonth && end >= startOfMonth;
}

function remainingPredictionUpper(prediction, actualByDate) {
  if (matchedActualForPrediction(prediction, actualByDate)) return 0;
  const dates = coveredValueDates(prediction);
  const upper = finite(prediction?.upper);
  if (!dates.length || upper === null || upper < 0) return 0;
  const reportedDayCount = dates.filter((date) => {
    const actual = actualByDate.get(date);
    return actual && Number(actual.accrualDays || 1) === 1;
  }).length;
  const remainingDayCount = Math.max(0, dates.length - reportedDayCount);
  return Math.ceil(
    ((upper * remainingDayCount) / dates.length) * 100 - Number.EPSILON,
  ) / 100;
}

function latestVerifiedMtdFlexCoverage(
  snapshots,
  currentMonth,
  expectedAccountFingerprint,
) {
  const startOfMonth = monthStart(currentMonth);
  if (!startOfMonth) return null;
  return [...snapshots]
    .flatMap((snapshot) => {
      if (
        snapshot?.source !== 'ibkr_flex_interest_web_service'
        || !/^[a-f0-9]{64}$/.test(String(snapshot.reportHash || ''))
        || !/^[a-f0-9]{64}$/.test(String(snapshot.revisionHash || ''))
        || !isoDate(snapshot.fromDate)
        || !isoDate(snapshot.toDate)
        || (
          snapshot.expectedAccountFingerprint
          && snapshot.expectedAccountFingerprint !== expectedAccountFingerprint
        )
        || !Array.isArray(snapshot?.derived?.dailyDebitActuals)
      ) {
        return [];
      }
      const currentMonthRows = snapshot.derived.dailyDebitActuals.filter((row) => {
        const rowDate = isoDate(row?.date);
        const rowFromDate = isoDate(row?.fromDate || row?.date);
        const rowToDate = isoDate(row?.toDate || row?.date);
        const debitAmount = finite(row?.debitAmount);
        return (
          row?.currency === 'USD'
          && rowDate?.startsWith(currentMonth)
          && rowFromDate
          && rowToDate
          && rowFromDate <= rowToDate
          && rowFromDate >= snapshot.fromDate
          && rowToDate <= snapshot.toDate
          && debitAmount !== null
          && debitAmount >= 0
          && Number.isInteger(row?.rowCount)
          && row.rowCount > 0
        );
      });
      if (!currentMonthRows.length) return [];
      return [{
        ...snapshot,
        mtdRows: currentMonthRows,
        mtdThroughDate: currentMonthRows
          .map((row) => row.toDate || row.date)
          .sort()
          .at(-1),
      }];
    })
    .sort((left, right) => (
      left.mtdThroughDate.localeCompare(right.mtdThroughDate)
      || String(left.fetchedAt || '').localeCompare(String(right.fetchedAt || ''))
    ))
    .at(-1) || null;
}

function emptyStockBorrowFees(status = 'unavailable', reason = null) {
  return {
    status,
    daily: {
      status,
      valueDate: null,
      amount: null,
      positionCount: 0,
      rowCount: 0,
      currency: 'USD',
      source: 'ibkr_flex_securities_borrowed_lent_fee_details',
      reason,
    },
    aggregate: {
      status,
      total: null,
      currency: 'USD',
      periodFrom: null,
      periodTo: null,
      throughDate: null,
      latestMonth: null,
      months: [],
      source: 'ibkr_flex_cash_transactions',
      reason,
    },
    evidence: null,
  };
}

function latestVerifiedBorrowFlexSnapshot(snapshots, expectedAccountFingerprint) {
  return [...snapshots]
    .filter((snapshot) => (
      snapshot?.source === 'ibkr_flex_interest_web_service'
      && /^[a-f0-9]{64}$/.test(String(snapshot.reportHash || ''))
      && /^[a-f0-9]{64}$/.test(String(snapshot.revisionHash || ''))
      && isoDate(snapshot.fromDate)
      && isoDate(snapshot.toDate)
      && (
        !snapshot.expectedAccountFingerprint
        || snapshot.expectedAccountFingerprint === expectedAccountFingerprint
      )
    ))
    .sort((left, right) => (
      String(left.fetchedAt || '').localeCompare(String(right.fetchedAt || ''))
      || String(left.revisionHash || '').localeCompare(String(right.revisionHash || ''))
    ))
    .at(-1) || null;
}

function buildFlexCapabilities(snapshots, expectedAccountFingerprint) {
  const snapshot = latestVerifiedBorrowFlexSnapshot(
    snapshots,
    expectedAccountFingerprint,
  );
  const requiredSections = {
    tierInterestDetails: Boolean(
      snapshot?.tierDetailSectionPresent === true
      || (snapshot?.tierDetails?.length || 0) > 0,
    ),
    interestAccruals: Boolean(
      snapshot?.accrualSectionPresent === true
      || (snapshot?.accruals?.length || 0) > 0,
    ),
    cashTransactions: Boolean(
      snapshot?.cashTransactionSectionPresent === true
      || (snapshot?.cashTransactions?.length || 0) > 0,
    ),
    cashReport: Boolean(
      snapshot?.cashReportSectionPresent === true
      || (snapshot?.cashReports?.length || 0) > 0,
    ),
  };
  const missingSections = Object.entries(requiredSections)
    .filter(([, present]) => present !== true)
    .map(([section]) => section);
  const ready = Boolean(snapshot) && missingSections.length === 0;
  return {
    ready,
    status: !snapshot ? 'awaiting' : ready ? 'ready' : 'incomplete',
    requiredSections,
    optionalSections: {
      stockBorrowFeeDetails: Boolean(
        snapshot?.borrowFeeDetailsSectionPresent === true
        || (snapshot?.borrowFeeDetails?.length || 0) > 0,
      ),
    },
    missingSections,
    evidence: snapshot
      ? {
          fetchedAt: snapshot.fetchedAt || null,
          fromDate: snapshot.fromDate || null,
          toDate: snapshot.toDate || null,
          reportHash: snapshot.reportHash || null,
          revisionHash: snapshot.revisionHash || null,
        }
      : null,
  };
}

function buildStockBorrowFeeSummary({
  flexSnapshots = [],
  expectedAccountFingerprint,
  currentNyDate,
  error = null,
}) {
  const snapshot = latestVerifiedBorrowFlexSnapshot(
    flexSnapshots,
    expectedAccountFingerprint,
  );
  if (!snapshot) {
    return emptyStockBorrowFees(
      error ? 'unavailable' : 'awaiting',
      error?.code || (error ? 'interest_flex_unavailable' : 'interest_flex_not_synced'),
    );
  }

  const cashTransactions = Array.isArray(snapshot.cashTransactions)
    ? snapshot.cashTransactions
    : [];
  const paymentRows = Array.isArray(snapshot?.derived?.stockBorrowFeePayments)
    ? snapshot.derived.stockBorrowFeePayments
    : deriveStockBorrowFeePayments(cashTransactions);
  const borrowCashRows = cashTransactions.filter(isStockBorrowFeeTransaction);
  const unaccountedBorrowRows = borrowCashRows.some(
    (row) => !coveredMonthFromDescription(row.description),
  );
  const monthlyRows = paymentRows.filter((row) => (
    row?.currency === 'USD'
    && /^\d{4}-\d{2}$/.test(String(row.month || ''))
    && finite(row.amount) !== null
    && finite(row.amount) >= 0
  ));
  const aggregateStatus = unaccountedBorrowRows
    ? 'unavailable'
    : monthlyRows.length
      || cashTransactions.length
      || snapshot.cashTransactionSectionPresent === true
      ? 'verified'
      : 'awaiting';
  const aggregateTotal = monthlyRows.reduce(
    (total, row) => total + finite(row.amount),
    0,
  );
  const aggregateMonths = monthlyRows
    .sort((left, right) => left.month.localeCompare(right.month))
    .map((row) => ({
      month: row.month,
      amount: Number(row.amount.toFixed(2)),
      postedAt: row.postedDates?.at(-1) || null,
      transactionCount: row.transactionCount,
    }));
  const latestMonth = aggregateMonths.at(-1) || null;

  const detailRows = Array.isArray(snapshot.borrowFeeDetails)
    ? snapshot.borrowFeeDetails
    : [];
  const dailyRows = Array.isArray(snapshot?.derived?.dailyStockBorrowFees)
    ? snapshot.derived.dailyStockBorrowFees
    : deriveDailyStockBorrowFees(detailRows);
  const validDetailRows = detailRows.filter((row) => (
    row?.currency === 'USD'
    && isoDate(row.valueDate)
    && finite(row.totalCharges) !== null
    && finite(row.totalCharges) >= 0
  ));
  const invalidDetailRows = detailRows.length !== validDetailRows.length;
  const feeDetailSectionPresent = snapshot.borrowFeeDetailsSectionPresent === true
    || detailRows.length > 0;
  const datedDailyRows = dailyRows
    .filter((row) => (
      isoDate(row?.date)
      && (!currentNyDate || row.date <= currentNyDate)
      && finite(row?.amount) !== null
      && finite(row.amount) >= 0
    ))
    .sort((left, right) => left.date.localeCompare(right.date));
  const latestDaily = datedDailyRows.at(-1) || null;
  let daily;
  if (invalidDetailRows) {
    daily = {
      ...emptyStockBorrowFees('unavailable', 'interest_borrow_fee_detail_unverified').daily,
    };
  } else if (latestDaily) {
    daily = {
      status: 'verified',
      valueDate: latestDaily.date,
      amount: Number(latestDaily.amount.toFixed(2)),
      positionCount: Number(latestDaily.positionCount) || 0,
      rowCount: Number(latestDaily.rowCount) || 0,
      currency: 'USD',
      source: 'ibkr_flex_securities_borrowed_lent_fee_details',
      reason: null,
    };
  } else if (feeDetailSectionPresent) {
    daily = {
      status: 'verified',
      valueDate: null,
      amount: 0,
      positionCount: 0,
      rowCount: 0,
      currency: 'USD',
      source: 'ibkr_flex_securities_borrowed_lent_fee_details',
      reason: 'no_fee_detail_rows_in_report',
    };
  } else {
    daily = {
      ...emptyStockBorrowFees(
        error ? 'unavailable' : 'awaiting',
        error?.code || 'flex_query_borrow_fee_details_not_configured',
      ).daily,
    };
  }

  const status = aggregateStatus === 'verified' || daily.status === 'verified'
    ? 'verified'
    : aggregateStatus === 'unavailable' || daily.status === 'unavailable'
      ? 'unavailable'
      : 'awaiting';
  return {
    status,
    daily,
    aggregate: {
      status: aggregateStatus,
      total: aggregateStatus === 'verified'
        ? Number(aggregateTotal.toFixed(2))
        : null,
      currency: 'USD',
      periodFrom: snapshot.fromDate,
      periodTo: snapshot.toDate,
      throughDate: snapshot.toDate,
      latestMonth,
      months: aggregateMonths,
      source: 'ibkr_flex_cash_transactions',
      reason: unaccountedBorrowRows
        ? 'interest_borrow_fee_payment_unattributed'
        : null,
    },
    evidence: {
      source: 'ibkr_flex_interest_web_service',
      reportHash: snapshot.reportHash,
      revisionHash: snapshot.revisionHash,
      fetchedAt: snapshot.fetchedAt,
      fromDate: snapshot.fromDate,
      toDate: snapshot.toDate,
      feeDetailSectionPresent,
    },
  };
}

function buildDerivedSummary({
  config,
  store,
  flexSnapshots,
  generatedAt,
  latestLiveObservation = null,
  lastRun,
  lastError,
  mtdError = null,
  forecastError = null,
}) {
  const predictions = store.readRecords('predictions');
  const actuals = store.readRecords('actuals');
  const observations = store.readRecords('observations');
  const matches = buildMatches(predictions, actuals);
  const monthlyReconciled = hasMonthlyReconciliation(flexSnapshots);
  const calibration = calibrateProspectiveInterest({
    matches,
    chronologicalOrderVerified: true,
  });
  const actualByDate = latestByDate(actuals);
  const eligiblePredictions = predictions
    .filter((prediction) => (
      prediction?.prospective === true
      && prediction?.verified === true
    ))
    .sort((left, right) => (
      String(left.valueDate || '').localeCompare(String(right.valueDate || ''))
      || String(left.issuedAt || '').localeCompare(String(right.issuedAt || ''))
    ));
  const latestPrediction = eligiblePredictions
    .at(-1) || null;
  const latestMatchedActual = latestPrediction
    ? matchedActualForPrediction(latestPrediction, actualByDate)
    : [...actualByDate.values()]
      .sort((left, right) => left.valueDate.localeCompare(right.valueDate))
      .at(-1) || null;
  const currentNyDate = nyParts(new Date(generatedAt), config.timeZone).date;
  const flexCapabilities = buildFlexCapabilities(
    flexSnapshots,
    config.accountFingerprint,
  );
  const stockBorrowFees = buildStockBorrowFeeSummary({
    flexSnapshots,
    expectedAccountFingerprint: config.accountFingerprint,
    currentNyDate,
    error: mtdError,
  });
  const currentMonth = currentNyDate.slice(0, 7);
  const mtdCoverage = latestVerifiedMtdFlexCoverage(
    flexSnapshots,
    currentMonth,
    config.accountFingerprint,
  );
  const currentActuals = (mtdCoverage?.mtdRows || []).map((row) => ({
    ...row,
    valueDate: row.date,
    debitAmount: finite(row.debitAmount),
    verified: true,
  }));
  const priorMonth = previousMonth(currentMonth);
  const priorMonthDebit = [...actualByDate.values()]
    .filter((row) => row.valueDate.startsWith(priorMonth))
    .reduce((total, row) => total + row.debitAmount, 0);
  const currentMonthPaid = flexSnapshots
    .flatMap((snapshot) => monthlyPaidForSnapshot(snapshot))
    .filter((row) => (
      row.month === currentMonth
      && row.currency === 'USD'
      && finite(row.paid) > 0
    ))
    .reduce((largest, row) => Math.max(largest, finite(row.paid)), 0);
  const currentMonthPaymentPosted = (
    currentMonthPaid > 0
    && (
      priorMonthDebit <= 0.01
      || currentMonthPaid + 0.01 >= priorMonthDebit
    )
  );
  const reserveStartMonth = currentMonthPaymentPosted
    ? currentMonth
    : priorMonth;
  const reserveStartDate = monthStart(reserveStartMonth);
  const unpaidActuals = [...actualByDate.values()].filter((row) => (
    row.verified === true
    && (
      row.valueDate >= reserveStartDate
      || actualOverlapsMonth(row, currentMonth)
    )
  ));
  const verifiedUnpaidDebit = unpaidActuals.reduce(
    (total, row) => total + row.debitAmount,
    0,
  );
  const unreportedPredictions = predictions.filter((prediction) => (
    coveredValueDates(prediction).some((date) => date >= reserveStartDate)
    && !matchedActualForPrediction(prediction, actualByDate)
  ));
  const unreportedUpper = unreportedPredictions.reduce(
    (total, prediction) => (
      total + remainingPredictionUpper(prediction, actualByDate)
    ),
    0,
  );
  const modelOutstandingUpper = verifiedUnpaidDebit + unreportedUpper;
  const latestObservation = freshestLiveAccruedObservation(
    [...observations, latestLiveObservation].filter(Boolean),
    Date.parse(generatedAt),
  );
  const latestObservationFresh = Boolean(latestObservation);
  const sampleCount = calibration.available ? calibration.sampleCount : 0;
  const latestVerifiedComparison = latestVerifiedForecastComparison(
    eligiblePredictions,
    actualByDate,
  );
  const sampleModelStatus = sampleCount === 0
    ? 'provisional'
    : sampleCount >= 30 && monthlyReconciled
      ? 'validated'
      : 'learning';
  const modelStatus = latestVerifiedComparison?.outcome === 'miss'
    ? 'provisional'
    : sampleModelStatus;
  const modelStatusReason = latestVerifiedComparison?.outcome === 'miss'
    ? 'latest_verified_forecast_miss'
    : sampleModelStatus === 'provisional'
      ? 'no_verified_forecast_matches'
      : sampleModelStatus === 'learning'
        ? 'calibration_in_progress'
        : null;
  const evidenceAvailable = Boolean(
    latestPrediction
    || currentActuals.length
    || unpaidActuals.length
    || mtdCoverage
  );
  const available = evidenceAvailable;
  const modelGuardDecision = calculateInterestGuardReserve({
    liveAccruedCash: 0,
    liveAccruedVerified: true,
    verifiedUnpaidDebit,
    unpaidDebitVerified: available,
    unreportedUpper,
    unreportedUpperVerified: available,
  });
  const combinedGuardDecision = latestObservationFresh
    ? calculateInterestGuardReserve({
        liveAccruedCash: latestObservation.liveAccruedCash,
        liveAccruedVerified: true,
        verifiedUnpaidDebit,
        unpaidDebitVerified: available,
        unreportedUpper,
        unreportedUpperVerified: available,
      })
    : null;
  const guardAvailable = (
    available
    && config.guardMode === 'graduated'
    && modelGuardDecision.available === true
  );

  return {
    schemaVersion: '1',
    modelVersion: MODEL_VERSION,
    source: SOURCE,
    generatedAt,
    accountFingerprint: config.accountFingerprint,
    accountMasked: config.accountMasked,
    available,
    actionable: false,
    status: available ? modelStatus : 'unavailable',
    modelStatus,
    modelStatusReason,
    capabilities: flexCapabilities,
    monthlyReconciled,
    mtd: {
      status: mtdCoverage ? 'verified' : (mtdError ? 'unavailable' : 'awaiting'),
      verifiedDebit: mtdCoverage
        ? Number(
          currentActuals
            .reduce((total, row) => total + row.debitAmount, 0)
            .toFixed(2),
        )
        : null,
      liveNetAccrued: available
        && latestObservationFresh
        ? latestObservation.liveAccruedCash
        : null,
      liveNetAccruedStatus: available && latestObservationFresh
        ? 'live'
        : 'unavailable',
      liveNetAccruedObservedAt: available && latestObservationFresh
        ? latestObservation.observedAt
        : null,
      liveNetAccruedSource: available && latestObservationFresh
        ? latestObservation.source || 'ibkr_live_interest_observation'
        : null,
      actualDayCount: currentActuals.reduce(
        (total, row) => total + Math.max(1, Number(row.accrualDays) || 1),
        0,
      ),
      throughDate: mtdCoverage?.mtdThroughDate || null,
    },
    forecast: (() => {
      const prediction = verifiedPredictionCoveringDate(
        predictions,
        currentNyDate,
      );
      const coverage = prediction ? coveredValueDates(prediction) : [];
      return prediction
        ? {
            status: 'issued',
            valueDate: prediction.valueDate,
            activeForDate: currentNyDate,
            coveredValueDates: coverage,
            coverageFrom: coverage[0] || null,
            coverageThrough: coverage.at(-1) || null,
            basisSessionDate: prediction.basisSessionDate
              || prediction.valueDate,
            cashAnchorDate: prediction.cashAnchorDate
              || prediction.basisSessionDate
              || prediction.valueDate,
            nextSessionDate: prediction.nextSessionDate || null,
            kind: prediction.kind || prediction.forecastKind
              || 'completed_session_window',
            principal: prediction.principal ?? null,
            lower: forecastBand(prediction).lower,
            point: prediction.point ?? null,
            upper: prediction.upper ?? null,
            accrualDays: prediction.accrualDays ?? null,
            effectiveAnnualRate: prediction.effectiveAnnualRate ?? null,
            issuedAt: prediction.issuedAt || null,
            rateEvidence: prediction.rateEvidence || null,
          }
        : {
            status: forecastError ? 'unavailable' : 'awaiting',
            valueDate: currentNyDate,
            activeForDate: currentNyDate,
            coveredValueDates: [],
            coverageFrom: null,
            coverageThrough: null,
            basisSessionDate: null,
            cashAnchorDate: null,
            nextSessionDate: null,
            kind: null,
            principal: null,
            lower: null,
            point: null,
            upper: null,
            accrualDays: null,
            effectiveAnnualRate: null,
            issuedAt: null,
            rateEvidence: null,
          };
    })(),
    comparison: (() => {
      const prediction = latestPrediction;
      const actual = prediction
        ? matchedActualForPrediction(prediction, actualByDate)
        : null;
      const verified = actualWasObservedAfterPrediction(prediction, actual)
        ? verifiedForecastComparison(prediction, actual)
        : null;
      if (verified) return { ...verified, lastVerified: verified };
      return pendingForecastComparison(prediction, latestVerifiedComparison);
    })(),
    stockBorrowFees,
    latest: available && (latestPrediction || latestMatchedActual)
      ? {
          valueDate: latestPrediction?.valueDate || latestMatchedActual?.valueDate || null,
          issuedAt: latestPrediction?.issuedAt || null,
          raw: latestPrediction?.raw ?? null,
          lower: latestPrediction ? forecastBand(latestPrediction).lower : null,
          point: latestPrediction?.point ?? null,
          upper: latestPrediction?.upper ?? null,
          actual: latestMatchedActual?.debitAmount ?? null,
          residual: latestPrediction && latestMatchedActual
            ? Number((latestMatchedActual.debitAmount - latestPrediction.point).toFixed(2))
            : null,
          accrualDays: latestPrediction?.accrualDays ?? null,
        }
      : null,
    calibration: {
      sampleCount,
      totalMatchCount: calibration.available ? calibration.totalMatchCount : 0,
      biasPerDay: calibration.available ? calibration.biasPerDay : null,
      q95UnderpredictionPerDay:
        calibration.available ? calibration.q95UnderpredictionPerDay : null,
      window: 90,
      monthlyReconciled,
    },
    guard: {
      available: guardAvailable,
      mode: config.guardMode,
      appliedReserve: guardAvailable
        ? modelGuardDecision.reserve
        : null,
      verifiedUnpaidDebit: available
        ? Number(verifiedUnpaidDebit.toFixed(2))
        : null,
      unreportedUpper: available
        ? Number(unreportedUpper.toFixed(2))
        : null,
      modelOutstandingUpper: available
        ? Number(modelOutstandingUpper.toFixed(2))
        : null,
      liveNegativeAccrued: combinedGuardDecision?.available === true
        ? combinedGuardDecision.liveNegativeAccrued
        : null,
      combinedReserve: combinedGuardDecision?.available === true
        ? combinedGuardDecision.reserve
        : null,
    },
    lastRun,
    lastError,
    channelErrors: {
      mtd: mtdError,
      forecast: forecastError,
      stockBorrowFees: mtdError,
    },
  };
}

function createIbkrInterestValidationService({
  env = process.env,
  now = () => new Date(),
  schedule = setInterval,
  cancelSchedule = clearInterval,
  sidecarRequestImpl = sidecarRequest,
  store: injectedStore = null,
  flexService: injectedFlexService = null,
  officialRateFetchImpl = global.fetch,
  fetchOfficialScheduleImpl = fetchOfficialUsdProMarginSchedule,
  logger = console,
} = {}) {
  const config = getConfig(env);
  const accountDataDir = path.join(
    config.dataDir,
    'accounts',
    config.accountFingerprint,
  );
  const store = injectedStore || createInterestValidationStore({
    dataDir: accountDataDir,
  });
  const flexService = injectedFlexService || createIbkrFlexInterestService({
    env,
    dataDir: path.join(accountDataDir, 'flex'),
    now,
  });
  const state = {
    started: false,
    timer: null,
    inFlight: null,
    flexSyncSlotsByDate: new Map(),
    lastForecastAttemptAtMs: null,
    lastRun: null,
    lastError: null,
    mtdError: null,
    forecastError: null,
    latestBalanceObservation: null,
  };

  function flexSnapshots() {
    return flexService.history({ limit: 50 });
  }

  function recordBalanceObservation(snapshot) {
    if (!config.enabled || !config.expectedAccountId) {
      return {
        appended: false,
        reason: 'interest_validation_disabled',
      };
    }
    const reportedAccount = String(
      snapshot?.accountId || snapshot?.account || '',
    ).trim();
    if (reportedAccount !== config.expectedAccountId) {
      return {
        appended: false,
        reason: 'interest_balance_observation_account_mismatch',
      };
    }
    const observation = requireLiveBalanceInterestObservation(
      snapshot,
      config.expectedAccountId,
      { now: now(), timeZone: config.timeZone },
    );
    const normalizedValue = Number(observation.liveAccruedCash.toFixed(8));
    state.latestBalanceObservation = {
      modelVersion: MODEL_VERSION,
      source: 'ibkr_live_portfolio_balance',
      sessionDate: observation.sessionDate,
      observedAt: observation.observedAt,
      socketVerifiedAt: observation.socketVerifiedAt,
      accountFingerprint: config.accountFingerprint,
      liveAccruedCash: normalizedValue,
      verified: true,
    };
    const alreadyRecorded = store.readRecords('observations').some((row) => {
      const storedValue = finite(row?.liveAccruedCash);
      return (
        row?.verified === true
        && row?.sessionDate === observation.sessionDate
        && storedValue !== null
        && Number(storedValue.toFixed(8)) === normalizedValue
      );
    });
    if (alreadyRecorded) {
      return {
        appended: false,
        reason: 'interest_balance_observation_unchanged',
      };
    }
    return store.appendRecord('observations', {
      identity: [
        'balance',
        observation.sessionDate,
        normalizedValue.toFixed(8),
      ].join('|'),
      modelVersion: MODEL_VERSION,
      source: 'ibkr_live_portfolio_balance',
      sessionDate: observation.sessionDate,
      observedAt: observation.observedAt,
      socketVerifiedAt: observation.socketVerifiedAt,
      accountFingerprint: config.accountFingerprint,
      liveAccruedCash: normalizedValue,
      verified: true,
    });
  }

  function persistSummary() {
    let snapshots = [];
    try {
      snapshots = flexSnapshots();
    } catch (error) {
      state.lastError = safePublicError(error);
    }
    const summary = buildDerivedSummary({
      config,
      store,
      flexSnapshots: snapshots,
      generatedAt: now().toISOString(),
      latestLiveObservation: state.latestBalanceObservation,
      lastRun: state.lastRun,
      lastError: state.lastError,
      mtdError: state.mtdError,
      forecastError: state.forecastError,
    });
    store.writeSummary(summary);
    return summary;
  }

  async function syncFlexIfDue(parts, { force = false } = {}) {
    const status = flexService.status();
    if (!status.enabled || !status.configured) return null;
    const completedSlots = state.flexSyncSlotsByDate.get(parts.date) || new Set();
    const slot = force
      ? { id: `force:${now().toISOString()}`, minuteOfDay: 0 }
      : FLEX_SYNC_SLOTS
        .filter((candidate) => afterMinute(parts, candidate.minuteOfDay))
        .at(-1);
    if (!slot || completedSlots.has(slot.id)) return null;
    if (!force && slot !== FLEX_SYNC_SLOTS[0] && completedSlots.size > 0) {
      const actualByDate = latestByDate(store.readRecords('actuals'));
      const hasOutstandingForecast = store.readRecords('predictions').some(
        (prediction) => (
          prediction.prospective === true
          && prediction.verified === true
          && !matchedActualForPrediction(prediction, actualByDate)
        ),
      );
      if (!hasOutstandingForecast) {
        completedSlots.add(slot.id);
        state.flexSyncSlotsByDate.set(parts.date, completedSlots);
        return null;
      }
    }
    const snapshot = await flexService.sync(flexReportingRange(parts));
    completedSlots.add(slot.id);
    state.flexSyncSlotsByDate.set(parts.date, completedSlots);
    ingestFlexSnapshots(store, [snapshot]);
    return snapshot;
  }

  async function issueForecastIfDue(parts, { force = false } = {}) {
    if (!forecastAttemptWindowOpen(parts, force)) return null;
    const existingPredictions = store.readRecords('predictions');
    if (verifiedPredictionCoveringDate(existingPredictions, parts.date)) {
      return null;
    }
    const attemptAt = now().getTime();
    if (
      !force
      && state.lastForecastAttemptAtMs !== null
      && attemptAt - state.lastForecastAttemptAtMs < 15 * 60_000
    ) {
      return null;
    }
    state.lastForecastAttemptAtMs = attemptAt;

    const response = await sidecarRequestImpl(
      `/portfolio/interest-observation?account=${encodeURIComponent(config.expectedAccountId)}`,
      { timeoutMs: 30_000 },
    );
    const observation = requireLiveObservation(
      response,
      config.expectedAccountId,
      { now: now() },
    );
    if (observation.sessionDate !== parts.date) {
      const error = new Error('Interest observation did not cover the current NY session.');
      error.code = 'interest_observation_session_mismatch';
      throw error;
    }
    const observationCoverage = {
      valueDate: observation.sessionDate,
      accrualDays: observation.accrualDays,
      coveredValueDates: Array.from(
        { length: observation.accrualDays },
        (_value, index) => addUtcDays(observation.sessionDate, index),
      ),
    };
    if (predictionCoverageOverlaps(observationCoverage, existingPredictions)) {
      return null;
    }
    store.appendRecord('observations', {
      identity: `${observation.sessionDate}|${observation.evidenceHash}`,
      modelVersion: MODEL_VERSION,
      source: 'ibkr_live_interest_observation',
      sessionDate: observation.sessionDate,
      observedAt: observation.observedAt,
      socketVerifiedAt: observation.socketVerifiedAt,
      evidenceHash: observation.evidenceHash,
      accountFingerprint: config.accountFingerprint,
      liveAccruedCash: observation.liveAccruedCash,
      verified: true,
    });
    const snapshots = flexSnapshots();
    const tierEvidence = await resolveDebitRateEvidence({
      snapshots,
      sessionDate: observation.sessionDate,
      fetchOfficialSchedule: () => fetchOfficialScheduleImpl({
        fetchImpl: officialRateFetchImpl,
        now,
      }),
    });
    const predictions = store.readRecords('predictions');
    const actuals = store.readRecords('actuals');
    const matches = buildMatches(predictions, actuals);
    const monthlyReconciled = hasMonthlyReconciliation(snapshots);
    const forecast = forecastIbkrDebitInterest({
      currency: observation.currency,
      positionScope: observation.positionScope,
      accountInputsVerified: true,
      providerStatus: 'live',
      fromCache: false,
      tiers: tierEvidence.tiers,
      tiersVerified: true,
      tiersStale: false,
      tiersFromCache: false,
      accrualPeriods: [{
        id: observation.sessionDate,
        accrualDays: observation.accrualDays,
        securitiesCash: observation.securitiesCash,
        ibuklCash: observation.ibuklCash,
        commoditiesCash: observation.commoditiesCash,
        eventMarketValue: observation.eventMarketValue,
        eventAccountingVerified: observation.eventAccountingVerified,
        ...(observation.commodityAvailableFunds === null
          ? {}
          : {
              commodityAvailableFunds:
                observation.commodityAvailableFunds,
            }),
        commodityMaintenanceMargin: observation.commodityMaintenanceMargin,
        shortPositions: observation.shortPositions,
        providerStatus: 'live',
        fromCache: false,
      }],
      calibration: {
        matches,
        chronologicalOrderVerified: true,
        monthlyReconciled,
      },
    });
    if (!forecast.available) {
      const error = new Error(forecast.reason || 'Interest forecast unavailable.');
      error.code = forecast.reason || 'interest_forecast_unavailable';
      throw error;
    }
    if (
      Number.isFinite(tierEvidence.observedPrincipalCoverage)
      && forecast.principal > tierEvidence.observedPrincipalCoverage + 0.01
    ) {
      const error = new Error('Forecast principal exceeded the verified Flex tier coverage.');
      error.code = 'interest_tier_coverage_exceeded';
      throw error;
    }

    const principalDays = forecast.segmentDetails.reduce(
      (total, period) => total + (period.principal * period.accrualDays),
      0,
    );
    const effectiveAnnualRate = principalDays > 0
      ? (forecast.raw * 360) / principalDays
      : tierEvidence.tiers[0]?.annualRate ?? null;
    return store.appendRecord('predictions', {
      identity: observation.sessionDate,
      modelVersion: MODEL_VERSION,
      valueDate: observation.sessionDate,
      basisSessionDate: observation.basisSessionDate,
      cashAnchorDate: observation.cashAnchorDate,
      nextSessionDate: observation.nextSessionDate,
      kind: observation.forecastKind,
      coveredValueDates: observationCoverage.coveredValueDates,
      issuedAt: now().toISOString(),
      prospective: true,
      verified: true,
      evidenceHash: observation.evidenceHash,
      rateEvidenceDate: tierEvidence.rateDate,
      rateReportHash: tierEvidence.reportHash,
      rateEvidence: tierEvidence.rateEvidence,
      effectiveAnnualRate,
      accrualDays: forecast.accrualDays,
      currency: forecast.currency,
      raw: forecast.raw,
      lower: Number(Math.max(0, forecast.point - forecast.cushion).toFixed(2)),
      point: forecast.point,
      upper: forecast.upper,
      cushion: forecast.cushion,
      principal: forecast.principal,
      collateral: forecast.collateral,
      status: String(forecast.status).toLowerCase(),
      sampleCount: forecast.sampleCount,
      biasPerDay: forecast.biasPerDay,
      q95UnderpredictionPerDay: forecast.q95UnderpredictionPerDay,
      segmentDetails: forecast.segmentDetails,
      positionScope: forecast.positionScope,
    }).record;
  }

  async function run({ trigger = 'manual', force = false } = {}) {
    if (state.inFlight) {
      return {
        ...getStatus(),
        run: { status: 'busy', trigger },
      };
    }
    if (!config.enabled) {
      return getStatus();
    }
    if (!config.expectedAccountId) {
      state.lastError = {
        code: 'interest_validation_missing_account',
        message: 'The exact strategy account is not configured.',
      };
      return getStatus();
    }

    state.inFlight = (async () => {
      const startedAt = now();
      const parts = nyParts(startedAt, config.timeZone);
      if (state.forecastError?.date && state.forecastError.date !== parts.date) {
        state.forecastError = null;
      }
      let flexSynced = false;
      let forecastIssued = false;
      const errors = [];
      try {
        try {
          flexSynced = Boolean(await syncFlexIfDue(parts, { force }));
          if (flexSynced) state.mtdError = null;
        } catch (error) {
          state.mtdError = safePublicError(error);
          errors.push(state.mtdError);
        }
        ingestFlexSnapshots(store, flexSnapshots());
        try {
          forecastIssued = Boolean(await issueForecastIfDue(parts, { force }));
          if (forecastIssued) state.forecastError = null;
        } catch (error) {
          if (
            error.code !== 'interest_observation_forecast_ineligible'
            && forecastAttemptWindowOpen(parts, force)
          ) {
            store.appendRecord('misses', {
              identity: `${parts.date}|${error.code || 'unavailable'}`,
              sessionDate: parts.date,
              observedAt: now().toISOString(),
              reason: error.code || 'interest_forecast_unavailable',
            });
          }
          state.forecastError = {
            ...safePublicError(error),
            date: parts.date,
          };
          errors.push(state.forecastError);
        }
        state.lastRun = {
          trigger,
          startedAt: startedAt.toISOString(),
          completedAt: now().toISOString(),
          flexSynced,
          forecastIssued,
          status: errors.length ? 'partial' : 'succeeded',
        };
        if (errors.length) {
          state.lastError = errors.at(-1);
        } else if (flexSynced || forecastIssued) {
          state.lastError = null;
        }
        return persistSummary();
      } catch (error) {
        state.lastError = safePublicError(error);
        state.lastRun = {
          trigger,
          startedAt: startedAt.toISOString(),
          completedAt: now().toISOString(),
          flexSynced,
          forecastIssued,
          status: 'failed',
        };
        return persistSummary();
      }
    })();
    try {
      await state.inFlight;
      return getStatus();
    } finally {
      state.inFlight = null;
    }
  }

  function getStatus({ account = null } = {}) {
    const requestedAccount = String(account || config.expectedAccountId || '').trim();
    const accountMatched = Boolean(
      requestedAccount
      && config.expectedAccountId
      && requestedAccount === config.expectedAccountId
    );
    const flexStatus = flexService.status();
    let summary = null;
    try {
      summary = store.readSummary();
    } catch (error) {
      state.lastError = safePublicError(error);
    }
    const base = {
      source: SOURCE,
      modelVersion: MODEL_VERSION,
      generatedAt: now().toISOString(),
      enabled: config.enabled,
      configured: Boolean(config.expectedAccountId && flexStatus.configured),
      accountMatched,
      accountMasked: config.accountMasked,
      available: false,
      actionable: false,
      status: !config.enabled
        ? 'disabled'
        : !accountMatched
          ? 'unavailable'
          : 'unavailable',
      modelStatus: 'provisional',
      modelStatusReason: 'interest_validation_unavailable',
      capabilities: {
        ready: false,
        status: 'unavailable',
        requiredSections: {
          tierInterestDetails: false,
          interestAccruals: false,
          cashTransactions: false,
          cashReport: false,
        },
        optionalSections: {
          stockBorrowFeeDetails: false,
        },
        missingSections: [
          'tierInterestDetails',
          'interestAccruals',
          'cashTransactions',
          'cashReport',
        ],
        evidence: null,
      },
      mtd: {
        status: 'unavailable',
        verifiedDebit: null,
        liveNetAccrued: null,
        liveNetAccruedStatus: 'unavailable',
        liveNetAccruedObservedAt: null,
        liveNetAccruedSource: null,
        actualDayCount: 0,
        throughDate: null,
      },
      forecast: {
        status: 'unavailable',
        valueDate: null,
        activeForDate: null,
        coveredValueDates: [],
        coverageFrom: null,
        coverageThrough: null,
        basisSessionDate: null,
        cashAnchorDate: null,
        nextSessionDate: null,
        kind: null,
        principal: null,
        lower: null,
        point: null,
        upper: null,
        accrualDays: null,
        effectiveAnnualRate: null,
        issuedAt: null,
        rateEvidence: null,
      },
      comparison: {
        status: 'awaiting',
        outcome: 'pending',
        valueDate: null,
        forecastLower: null,
        forecastPoint: null,
        forecastUpper: null,
        actual: null,
        residual: null,
        issuedAt: null,
        verifiedAt: null,
        lastVerified: null,
      },
      stockBorrowFees: emptyStockBorrowFees('unavailable', 'interest_validation_unavailable'),
      latest: null,
      calibration: {
        sampleCount: 0,
        totalMatchCount: 0,
        biasPerDay: null,
        q95UnderpredictionPerDay: null,
        window: 90,
        monthlyReconciled: false,
      },
      guard: {
        available: false,
        mode: config.guardMode,
        appliedReserve: null,
        verifiedUnpaidDebit: null,
        unreportedUpper: null,
        modelOutstandingUpper: null,
        liveNegativeAccrued: null,
        combinedReserve: null,
      },
      flex: flexStatus,
      run: {
        inFlight: Boolean(state.inFlight),
        started: state.started,
        last: state.lastRun,
      },
      error: state.lastError,
    };
    if (
      !summary
      || summary.source !== SOURCE
      || summary.accountFingerprint !== config.accountFingerprint
      || !config.enabled
      || !accountMatched
      || flexStatus.configured !== true
      || flexStatus.status === 'storage_error'
    ) {
      return base;
    }
    const {
      accountFingerprint: _accountFingerprint,
      ...publicSummary
    } = summary;
    let storedLatestObservation = null;
    try {
      storedLatestObservation = store.readRecords('observations').at(-1) || null;
    } catch (error) {
      state.lastError = safePublicError(error);
    }
    const liveObservation = freshestLiveAccruedObservation(
      [storedLatestObservation, state.latestBalanceObservation].filter(Boolean),
      now().getTime(),
    );
    const liveAvailable = publicSummary.available === true && Boolean(liveObservation);
    const liveGuard = liveAvailable
      ? calculateInterestGuardReserve({
          liveAccruedCash: liveObservation.liveAccruedCash,
          liveAccruedVerified: true,
          verifiedUnpaidDebit: publicSummary.guard?.verifiedUnpaidDebit,
          unpaidDebitVerified: publicSummary.available === true,
          unreportedUpper: publicSummary.guard?.unreportedUpper,
          unreportedUpperVerified: publicSummary.available === true,
        })
      : null;
    const currentSummary = {
      ...publicSummary,
      mtd: {
        ...publicSummary.mtd,
        liveNetAccrued: liveAvailable
          ? liveObservation.liveAccruedCash
          : null,
        liveNetAccruedStatus: liveAvailable ? 'live' : 'unavailable',
        liveNetAccruedObservedAt: liveAvailable
          ? liveObservation.observedAt
          : null,
        liveNetAccruedSource: liveAvailable
          ? liveObservation.source || 'ibkr_live_interest_observation'
          : null,
      },
      guard: {
        ...publicSummary.guard,
        liveNegativeAccrued: liveGuard?.available === true
          ? liveGuard.liveNegativeAccrued
          : null,
        combinedReserve: liveGuard?.available === true
          ? liveGuard.reserve
          : null,
      },
    };
    return {
      ...base,
      ...currentSummary,
      accountMatched: true,
      flex: flexStatus,
      run: {
        inFlight: Boolean(state.inFlight),
        started: state.started,
        last: state.lastRun || summary.lastRun || null,
      },
      error: state.lastError || summary.lastError || null,
    };
  }

  function history({ limit = 90 } = {}) {
    const normalizedLimit = Math.max(1, Math.min(366, Number(limit) || 90));
    const stored = store.history({ limit: normalizedLimit });
    const seenObservationValues = new Set();
    return {
      source: SOURCE,
      modelVersion: MODEL_VERSION,
      generatedAt: now().toISOString(),
      observations: stored.observations
        .filter((row) => (
          row?.verified === true
          && isoDate(row.sessionDate)
          && Number.isFinite(finite(row.liveAccruedCash))
          && Number.isFinite(Date.parse(String(row.observedAt || '')))
        ))
        .sort((left, right) => (
          String(left.observedAt).localeCompare(String(right.observedAt))
          || Number(left.sequence || 0) - Number(right.sequence || 0)
        ))
        .filter((row) => {
          const value = finite(row.liveAccruedCash);
          const identity = `${row.sessionDate}|${Number(value.toFixed(8)).toFixed(8)}`;
          if (seenObservationValues.has(identity)) return false;
          seenObservationValues.add(identity);
          return true;
        })
        .map((row) => ({
          sessionDate: row.sessionDate,
          observedAt: row.observedAt,
          liveNetAccrued: finite(row.liveAccruedCash),
          source: row.source || 'ibkr_live_interest_observation',
        })),
      predictions: stored.predictions.map((row) => ({
        valueDate: row.valueDate,
        coveredValueDates: coveredValueDates(row),
        basisSessionDate: row.basisSessionDate || row.valueDate || null,
        cashAnchorDate: row.cashAnchorDate
          || row.basisSessionDate
          || row.valueDate
          || null,
        nextSessionDate: row.nextSessionDate || null,
        kind: row.kind || row.forecastKind || 'completed_session_window',
        issuedAt: row.issuedAt,
        status: row.status,
        raw: row.raw,
        point: row.point,
        upper: row.upper,
        actual:
          matchedActualForPrediction(row, latestByDate(stored.actuals))?.debitAmount
          ?? null,
        accrualDays: row.accrualDays,
        sampleCount: row.sampleCount,
      })),
      actuals: [...latestByDate(stored.actuals).values()].map((row) => ({
        valueDate: row.valueDate,
        debitAmount: row.debitAmount,
        fetchedAt: row.fetchedAt,
        provisional: row.provisional,
      })),
      misses: stored.misses.map((row) => ({
        sessionDate: row.sessionDate,
        observedAt: row.observedAt,
        reason: row.reason,
      })),
    };
  }

  async function poll() {
    return run({ trigger: 'scheduled', force: false });
  }

  async function start() {
    if (!config.enabled) return getStatus();
    if (state.started) return getStatus();
    state.started = true;
    state.timer = schedule(() => {
      poll().catch((error) => logger.warn?.(
        `[IBKR Interest Validation] ${error.message}`,
      ));
    }, config.pollMs);
    state.timer?.unref?.();
    await poll();
    return getStatus();
  }

  function stop() {
    if (state.timer) cancelSchedule(state.timer);
    state.timer = null;
    state.started = false;
  }

  return {
    getConfig: () => ({ ...config }),
    getStatus,
    history,
    poll,
    recordBalanceObservation,
    run,
    start,
    stop,
  };
}

const singleton = createIbkrInterestValidationService();

module.exports = {
  LOOKBACK_DAYS,
  FLEX_SYNC_SLOTS,
  MODEL_VERSION,
  SOURCE,
  buildDerivedSummary,
  buildMatches,
  buildStockBorrowFeeSummary,
  createIbkrInterestValidationService,
  flexReportingRange,
  getConfig,
  hasMonthlyReconciliation,
  latestVerifiedTierSchedule,
  corroborateIbkrProSchedule,
  resolveDebitRateEvidence,
  nyParts,
  remainingPredictionUpper,
  requireLiveBalanceInterestObservation,
  requireLiveObservation,
  getIbkrInterestValidationStatus: (options) => singleton.getStatus(options),
  getIbkrInterestValidationHistory: (options) => singleton.history(options),
  recordIbkrInterestBalanceObservation: (snapshot) => (
    singleton.recordBalanceObservation(snapshot)
  ),
  runIbkrInterestValidation: (options) => singleton.run(options),
  startIbkrInterestValidation: () => singleton.start(),
  stopIbkrInterestValidation: () => singleton.stop(),
};
