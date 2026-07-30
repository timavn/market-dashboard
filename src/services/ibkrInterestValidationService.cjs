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

function requireLiveObservation(
  response,
  expectedAccountId,
  { now: currentTime = new Date() } = {},
) {
  const forecast = response?.forecast || {};
  const marketCalendar = response?.market_calendar || {};
  const executionEvidence = response?.execution_evidence;
  const summary = response?.summary || {};
  const account = String(response?.account || '').trim();
  const currentTimeMs = currentTime instanceof Date
    ? currentTime.getTime()
    : Date.parse(String(currentTime || ''));
  const sessionDate = isoDate(forecast.sessionDate);
  const nextSessionDate = isoDate(forecast.nextSessionDate);
  const priorCompletedSessionDate = isoDate(
    forecast.priorCompletedSessionDate,
  );
  const sessionCloseAtMs = Date.parse(
    String(forecast.currentSessionCloseAt || ''),
  );
  const accrualDays = finite(forecast.accrualDays);
  const securitiesCash = exactLadderBalance(
    summary['SettledCashByDate-S']
      ?? response?.settlement_ladders?.securities,
    sessionDate,
  );
  const commoditiesCash = exactLadderBalance(
    summary['SettledCashByDate-C']
      ?? response?.settlement_ladders?.commodities,
    sessionDate,
  );
  let ibuklCash = exactLadderBalance(
    summary['SettledCashByDate-Z']
      ?? response?.settlement_ladders?.z,
    sessionDate,
  );
  const ibuklTotalCash = finite(summary['TotalCashValue-Z']);
  const fxCashBalance = finite(summary.FxCashBalance);
  if (
    ibuklCash === null
    && summary['SettledCashByDate-Z'] == null
    && summary['TotalCashValue-Z'] == null
    && fxCashBalance === 0
  ) {
    ibuklCash = 0;
  }
  const commodityMaintenanceMargin = finite(summary['MaintMarginReq-C']);
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
    || accrualDays === null
    || !Number.isInteger(accrualDays)
    || accrualDays <= 0
    || daysBetween(sessionDate, nextSessionDate) !== accrualDays
  ) {
    reasons.push('interest_observation_forecast_ineligible');
  }
  if (
    marketCalendar.verifiedNyDate !== sessionDate
    || marketCalendar.currentSessionScheduled !== true
    || marketCalendar.currentSessionComplete !== true
    || marketCalendar.latestCompletedSessionDate !== sessionDate
    || marketCalendar.nextSessionDate !== nextSessionDate
    || marketCalendar.source
      !== 'ibkr_contract_details_and_historical_schedule'
    || typeof marketCalendar.liquidHours !== 'string'
    || !marketCalendar.liquidHours.trim()
    || forecast.currentSessionComplete !== true
    || forecast.latestCompletedSessionDate !== sessionDate
    || forecast.nextSessionDate !== marketCalendar.nextSessionDate
    || forecast.currentSessionCloseAt
      !== marketCalendar.currentSessionCloseAt
    || forecast.priorCompletedSessionDate
      !== marketCalendar.priorCompletedSessionDate
    || !priorCompletedSessionDate
    || priorCompletedSessionDate >= sessionDate
    || forecast.verification !== 'ibkr_liquid_hours_and_broker_time'
    || !Number.isFinite(sessionCloseAtMs)
    || !String(forecast.currentSessionCloseAt || '').startsWith(sessionDate)
    || sessionCloseAtMs > currentTimeMs + OBSERVATION_FUTURE_TOLERANCE_MS
  ) {
    reasons.push('interest_observation_calendar_unverified');
  }
  if (securitiesCash === null || commoditiesCash === null) {
    reasons.push('interest_observation_cash_ladder_incomplete');
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
    nextSessionDate,
    accrualDays,
    observedAt: response.observed_at,
    socketVerifiedAt: response.socket_verified_at,
    accountValuesObservedAt: response.account_values_observed_at,
    evidenceHash: response.evidence_hash,
    currency: String(summary.baseCurrency || summary.currency || '').toUpperCase(),
    securitiesCash,
    commoditiesCash,
    ibuklCash,
    commodityMaintenanceMargin,
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

function latestVerifiedTierSchedule(snapshots, sessionDate) {
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
    if (daysBetween(rateDate, sessionDate) > MAX_RATE_AGE_DAYS) continue;
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
    };
  }
  return null;
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
  if (
    Array.isArray(prediction?.coveredValueDates)
    && prediction.coveredValueDates.length === prediction.accrualDays
  ) {
    return prediction.coveredValueDates;
  }
  if (!isoDate(prediction?.valueDate) || !Number.isInteger(prediction?.accrualDays)) {
    return [];
  }
  return Array.from(
    { length: prediction.accrualDays },
    (_value, index) => addUtcDays(prediction.valueDate, index),
  );
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

function buildMatches(predictions, actuals) {
  const actualByDate = latestByDate(actuals);
  return predictions
    .filter((prediction) => prediction.prospective === true && prediction.verified === true)
    .sort((left, right) => left.valueDate.localeCompare(right.valueDate))
    .flatMap((prediction) => {
      const actual = matchedActualForPrediction(prediction, actualByDate);
      if (!actual) return [];
      const issuedAtMs = Date.parse(String(prediction.issuedAt || ''));
      const actualComponents = Array.isArray(actual.componentActuals)
        ? actual.componentActuals
        : [actual];
      const actualWasProspective = (
        Number.isFinite(issuedAtMs)
        && actualComponents.every((component) => {
          const fetchedAtMs = Date.parse(String(component?.fetchedAt || ''));
          return Number.isFinite(fetchedAtMs) && fetchedAtMs > issuedAtMs;
        })
      );
      if (!actualWasProspective) return [];
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

function hasMonthlyReconciliation(snapshots) {
  return snapshots.some((snapshot) => {
    const paidRows = (snapshot?.derived?.monthlyPaid || [])
      .filter((row) => (
        row.currency === 'USD'
        && finite(row.paid) > 0
        && finite(row.net) !== null
      ));
    if (!paidRows.length) return false;
    const paidNet = Number(
      paidRows.reduce((total, row) => total + finite(row.net), 0).toFixed(2),
    );
    return (snapshot?.cashReports || []).some((row) => {
      const reported = finite(row.brokerInterest);
      return (
        row.currency === 'USD'
        && reported !== null
        && Math.abs(reported - paidNet) <= 0.01
      );
    });
  });
}

function ingestFlexSnapshots(store, snapshots) {
  for (const snapshot of snapshots) {
    for (const row of snapshot?.derived?.dailyDebitActuals || []) {
      if (row.currency !== 'USD' || !isoDate(row.date)) continue;
      store.appendRecord('actuals', {
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
    for (const row of snapshot?.derived?.monthlyPaid || []) {
      if (row.currency !== 'USD' || !/^\d{4}-\d{2}$/.test(String(row.month || ''))) continue;
      store.appendRecord('actuals', {
        identity: `monthly|${row.month}|${snapshot.reportHash}`,
        kind: 'monthly',
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

function buildDerivedSummary({
  config,
  store,
  flexSnapshots,
  generatedAt,
  lastRun,
  lastError,
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
  const latestPrediction = [...predictions]
    .sort((left, right) => left.valueDate.localeCompare(right.valueDate))
    .at(-1) || null;
  const latestActual = latestPrediction
    ? matchedActualForPrediction(latestPrediction, actualByDate)
    : [...actualByDate.values()]
      .sort((left, right) => left.valueDate.localeCompare(right.valueDate))
      .at(-1) || null;
  const currentNyDate = nyParts(new Date(generatedAt), config.timeZone).date;
  const currentMonth = currentNyDate.slice(0, 7);
  const currentActuals = [...actualByDate.values()]
    .filter((row) => row.valueDate.startsWith(currentMonth));
  const priorMonth = previousMonth(currentMonth);
  const priorMonthDebit = [...actualByDate.values()]
    .filter((row) => row.valueDate.startsWith(priorMonth))
    .reduce((total, row) => total + row.debitAmount, 0);
  const currentMonthPaid = actuals
    .filter((row) => (
      row.kind === 'monthly'
      && row.month === currentMonth
      && row.verified === true
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
  const latestObservation = observations.at(-1) || null;
  const latestObservationFresh = (
    latestObservation?.verified === true
    && isFreshObservationTimestamp(
      latestObservation.observedAt,
      Date.parse(generatedAt),
    )
  );
  const sampleCount = calibration.available ? calibration.sampleCount : 0;
  const modelStatus = sampleCount === 0
    ? 'provisional'
    : sampleCount >= 30 && monthlyReconciled
      ? 'validated'
      : 'learning';
  const evidenceAvailable = Boolean(
    latestPrediction
    || currentActuals.length
    || unpaidActuals.length,
  );
  const available = evidenceAvailable && !lastError;
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
    status: available ? modelStatus : 'unavailable',
    modelStatus,
    monthlyReconciled,
    mtd: {
      verifiedDebit: available
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
      actualDayCount: currentActuals.length,
    },
    latest: available && (latestPrediction || latestActual)
      ? {
          valueDate: latestPrediction?.valueDate || latestActual?.valueDate || null,
          issuedAt: latestPrediction?.issuedAt || null,
          raw: latestPrediction?.raw ?? null,
          point: latestPrediction?.point ?? null,
          upper: latestPrediction?.upper ?? null,
          actual: latestActual?.debitAmount ?? null,
          residual: latestPrediction && latestActual
            ? Number((latestActual.debitAmount - latestPrediction.point).toFixed(2))
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
    lastFlexSyncDate: null,
    lastForecastAttemptAtMs: null,
    lastForecastIneligibleDate: null,
    lastRun: null,
    lastError: null,
  };

  function flexSnapshots() {
    return flexService.history({ limit: 50 });
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
      lastRun: state.lastRun,
      lastError: state.lastError,
    });
    store.writeSummary(summary);
    return summary;
  }

  async function syncFlexIfDue(parts, { force = false } = {}) {
    const status = flexService.status();
    if (!status.enabled || !status.configured) return null;
    const due = force || (
      afterMinute(parts, (6 * 60) + 30)
      && state.lastFlexSyncDate !== parts.date
    );
    if (!due) return null;
    const snapshot = await flexService.sync({
      fromDate: addUtcDays(parts.date, -(LOOKBACK_DAYS - 1)),
      toDate: parts.date,
    });
    state.lastFlexSyncDate = parts.date;
    ingestFlexSnapshots(store, [snapshot]);
    return snapshot;
  }

  async function issueForecastIfDue(parts, { force = false } = {}) {
    if (!force && !afterMinute(parts, (16 * 60) + 30)) return null;
    if (
      !force
      && !['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(parts.weekday)
    ) {
      return null;
    }
    if (!force && state.lastForecastIneligibleDate === parts.date) {
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
    const existing = store.readRecords('predictions')
      .some((prediction) => prediction.valueDate === parts.date);
    if (existing) return null;
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
    const snapshots = flexSnapshots();
    const tierEvidence = latestVerifiedTierSchedule(
      snapshots,
      observation.sessionDate,
    );
    if (!tierEvidence) {
      const error = new Error('No recent verified account-specific debit-interest tiers are available.');
      error.code = 'interest_rate_evidence_unavailable';
      throw error;
    }
    const predictions = store.readRecords('predictions');
    const actuals = store.readRecords('actuals');
    const matches = buildMatches(predictions, actuals);
    const monthlyReconciled = hasMonthlyReconciliation(snapshots);
    const forecast = forecastIbkrDebitInterest({
      currency: observation.currency,
      positionScope: 'stocks_only',
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
      forecast.principal > tierEvidence.observedPrincipalCoverage + 0.01
    ) {
      const error = new Error('Forecast principal exceeded the verified Flex tier coverage.');
      error.code = 'interest_tier_coverage_exceeded';
      throw error;
    }

    store.appendRecord('observations', {
      identity: `${observation.sessionDate}|${observation.evidenceHash}`,
      modelVersion: MODEL_VERSION,
      sessionDate: observation.sessionDate,
      observedAt: observation.observedAt,
      socketVerifiedAt: observation.socketVerifiedAt,
      evidenceHash: observation.evidenceHash,
      accountFingerprint: config.accountFingerprint,
      liveAccruedCash: observation.liveAccruedCash,
      verified: true,
    });
    return store.appendRecord('predictions', {
      identity: observation.sessionDate,
      modelVersion: MODEL_VERSION,
      valueDate: observation.sessionDate,
      nextSessionDate: observation.nextSessionDate,
      coveredValueDates: Array.from(
        { length: observation.accrualDays },
        (_value, index) => addUtcDays(observation.sessionDate, index),
      ),
      issuedAt: now().toISOString(),
      prospective: true,
      verified: true,
      evidenceHash: observation.evidenceHash,
      rateEvidenceDate: tierEvidence.rateDate,
      rateReportHash: tierEvidence.reportHash,
      accrualDays: forecast.accrualDays,
      currency: forecast.currency,
      raw: forecast.raw,
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
      let flexSynced = false;
      let forecastIssued = false;
      const errors = [];
      try {
        try {
          flexSynced = Boolean(await syncFlexIfDue(parts, { force }));
        } catch (error) {
          errors.push(safePublicError(error));
        }
        ingestFlexSnapshots(store, flexSnapshots());
        try {
          forecastIssued = Boolean(await issueForecastIfDue(parts, { force }));
        } catch (error) {
          if (error.code === 'interest_observation_forecast_ineligible') {
            state.lastForecastIneligibleDate = parts.date;
          }
          if (
            error.code !== 'interest_observation_forecast_ineligible'
            && afterMinute(parts, (16 * 60) + 30)
            && ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(parts.weekday)
          ) {
            store.appendRecord('misses', {
              identity: `${parts.date}|${error.code || 'unavailable'}`,
              sessionDate: parts.date,
              observedAt: now().toISOString(),
              reason: error.code || 'interest_forecast_unavailable',
            });
          }
          errors.push(safePublicError(error));
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
      status: !config.enabled
        ? 'disabled'
        : !accountMatched
          ? 'unavailable'
          : 'unavailable',
      modelStatus: 'provisional',
      mtd: {
        verifiedDebit: null,
        liveNetAccrued: null,
        actualDayCount: 0,
      },
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
    return {
      ...base,
      ...publicSummary,
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
    return {
      source: SOURCE,
      modelVersion: MODEL_VERSION,
      generatedAt: now().toISOString(),
      predictions: stored.predictions.map((row) => ({
        valueDate: row.valueDate,
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
    run,
    start,
    stop,
  };
}

const singleton = createIbkrInterestValidationService();

module.exports = {
  LOOKBACK_DAYS,
  MODEL_VERSION,
  SOURCE,
  buildDerivedSummary,
  buildMatches,
  createIbkrInterestValidationService,
  getConfig,
  hasMonthlyReconciliation,
  latestVerifiedTierSchedule,
  nyParts,
  remainingPredictionUpper,
  requireLiveObservation,
  getIbkrInterestValidationStatus: (options) => singleton.getStatus(options),
  getIbkrInterestValidationHistory: (options) => singleton.history(options),
  runIbkrInterestValidation: (options) => singleton.run(options),
  startIbkrInterestValidation: () => singleton.start(),
  stopIbkrInterestValidation: () => singleton.stop(),
};
