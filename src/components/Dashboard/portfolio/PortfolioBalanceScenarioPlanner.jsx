import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  Plus,
  Table2,
  Trash2,
} from 'lucide-react';
import { MarketDataService } from '../../../services/api/marketDataService';
import { usePortfolioBalance } from '../../../hooks/usePortfolioBalance';
import { useSurfaceActivity } from '../../common/PersistentSurface';
import { startVisibilityAwarePolling } from '../../../utils/visibilityAwarePolling';
import InterestLedgerPanel from './InterestLedgerPanel';
import './PortfolioBalanceScenarioPlanner.css';

const ACTIONS = {
  long: [
    { value: 'buy_long', label: 'Buy' },
    { value: 'sell_long', label: 'Sell' },
  ],
  short: [
    { value: 'add_short', label: 'Short' },
    { value: 'cover_short', label: 'Cover' },
  ],
};

const QUANTITY_MODES = [
  { value: 'shares', label: 'Shares' },
  { value: 'dollars', label: '$' },
  { value: 'nlv_percent', label: '% NLV' },
];

const ACTION_LABELS = {
  buy_long: 'Buy',
  sell_long: 'Sell',
  add_short: 'Short',
  cover_short: 'Cover',
};

const INTEREST_STATUS_MAX_AGE_MS = 36 * 60 * 60 * 1000;
const INTEREST_RESPONSE_MAX_AGE_MS = 5 * 60 * 1000;
const INTEREST_LIVE_MAX_AGE_MS = 45_000;

let nextLegId = 1;

function createLeg(kind) {
  const id = `${kind}-${nextLegId}`;
  nextLegId += 1;
  return {
    id,
    action: kind === 'long' ? 'buy_long' : 'add_short',
    symbol: '',
    quantityMode: 'shares',
    quantity: '1',
    price: '',
    priceMode: 'live_side',
  };
}

function formatCurrency(value, digits = 0, currency = 'USD') {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(number);
}

function formatPercent(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${number.toFixed(1)}%` : '—';
}

function explicitFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function formatObservedAt(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'unavailable';
  return date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatSettlementDate(value) {
  const date = new Date(`${value}T12:00:00Z`);
  if (!Number.isFinite(date.getTime())) return value || '—';
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

function formatAccrualCoverage(fromDate, throughDate) {
  if (!fromDate || !throughDate) return null;
  const from = formatSettlementDate(fromDate);
  const through = formatSettlementDate(throughDate);
  return fromDate === throughDate ? from : `${from}–${through}`;
}

function hasForbiddenInterestEvidence(value) {
  if (!value || typeof value !== 'object') return false;
  return value.fromCache === true
    || value.cacheOnly === true
    || value.mock === true
    || value.isMock === true
    || value.seeded === true
    || value.synthetic === true
    || value.inferred === true
    || value._cache?.hit === true
    || value._cache?.stale === true;
}

function normalizeStockBorrowFees(response, latest) {
  const raw = response?.stockBorrowFees || {};
  const rawDaily = raw.daily || {};
  const rawAggregate = raw.aggregate || {};
  const evidenceMatches = raw.evidence?.source === 'ibkr_flex_interest_web_service'
    && raw.evidence.reportHash === latest.reportHash
    && raw.evidence.revisionHash === latest.revisionHash
    && raw.evidence.fetchedAt === latest.fetchedAt
    && !hasForbiddenInterestEvidence(raw.evidence);
  const dailyAmount = Number(rawDaily.amount);
  const dailyPositionCount = Number(rawDaily.positionCount);
  const dailyRowCount = Number(rawDaily.rowCount);
  const dailyVerified = rawDaily.status === 'verified'
    && rawDaily.source === 'ibkr_flex_securities_borrowed_lent_fee_details'
    && evidenceMatches
    && rawDaily.amount !== null
    && rawDaily.amount !== undefined
    && Number.isFinite(dailyAmount)
    && dailyAmount >= 0
    && Number.isInteger(dailyPositionCount)
    && dailyPositionCount >= 0
    && Number.isInteger(dailyRowCount)
    && dailyRowCount >= 0
    && (!rawDaily.valueDate || /^\d{4}-\d{2}-\d{2}$/.test(String(rawDaily.valueDate)));
  const aggregateTotal = Number(rawAggregate.total);
  const aggregateVerified = rawAggregate.status === 'verified'
    && rawAggregate.source === 'ibkr_flex_cash_transactions'
    && evidenceMatches
    && rawAggregate.total !== null
    && rawAggregate.total !== undefined
    && Number.isFinite(aggregateTotal)
    && aggregateTotal >= 0
    && /^\d{4}-\d{2}-\d{2}$/.test(String(rawAggregate.periodFrom || ''))
    && /^\d{4}-\d{2}-\d{2}$/.test(String(rawAggregate.periodTo || ''));
  const aggregateMonths = aggregateVerified && Array.isArray(rawAggregate.months)
    ? rawAggregate.months
      .filter((row) => (
        /^\d{4}-\d{2}$/.test(String(row?.month || ''))
        && Number.isFinite(Number(row?.amount))
        && Number(row.amount) >= 0
      ))
      .map((row) => ({
        month: row.month,
        amount: Number(row.amount),
        postedAt: row.postedAt || null,
        transactionCount: Number(row.transactionCount) || 0,
      }))
    : [];
  const aggregateMonthTotal = aggregateMonths.reduce((total, row) => total + row.amount, 0);
  const aggregateValuesReconcile = aggregateMonths.length === 0
    ? aggregateTotal === 0
    : Math.abs(aggregateMonthTotal - aggregateTotal) <= 0.01;
  const aggregateStatus = aggregateVerified
    && aggregateValuesReconcile
    ? 'verified'
    : rawAggregate.status === 'unavailable'
      ? 'unavailable'
      : 'awaiting';
  const dailyStatus = dailyVerified
    ? 'verified'
    : rawDaily.status === 'unavailable'
      ? 'unavailable'
      : 'awaiting';

  return {
    status: aggregateStatus === 'verified' || dailyStatus === 'verified'
      ? 'verified'
      : aggregateStatus === 'unavailable' || dailyStatus === 'unavailable'
        ? 'unavailable'
        : 'awaiting',
    daily: {
      status: dailyStatus,
      valueDate: dailyVerified ? rawDaily.valueDate || null : null,
      amount: dailyVerified ? dailyAmount : null,
      positionCount: dailyVerified ? dailyPositionCount : 0,
      rowCount: dailyVerified ? dailyRowCount : 0,
      currency: 'USD',
      reason: rawDaily.reason || null,
    },
    aggregate: {
      status: aggregateStatus,
      total: aggregateVerified ? aggregateTotal : null,
      currency: 'USD',
      periodFrom: aggregateVerified ? rawAggregate.periodFrom : null,
      periodTo: aggregateVerified ? rawAggregate.periodTo : null,
      throughDate: aggregateVerified ? rawAggregate.throughDate || null : null,
      latestMonth: aggregateVerified ? rawAggregate.latestMonth || null : null,
      months: aggregateMonths,
      reason: rawAggregate.reason || null,
    },
  };
}

export function normalizeVerifiedInterestStatus(response, now = Date.now()) {
  const latest = response?.flex?.latest;
  const generatedAt = Date.parse(String(response?.generatedAt || ''));
  const fetchedAt = Date.parse(String(latest?.fetchedAt || ''));
  const ageMs = now - fetchedAt;
  const hashesVerified = /^[a-f0-9]{64}$/.test(String(latest?.reportHash || ''))
    && /^[a-f0-9]{64}$/.test(String(latest?.revisionHash || ''));
  const evidenceObjects = [response, response?.meta, response?._cache];

  if (
    response?.source !== 'ibkr_interest_validation'
    || response?.configured !== true
    || response?.accountMatched !== true
    || !Number.isFinite(generatedAt)
    || now - generatedAt < -5_000
    || now - generatedAt > INTEREST_RESPONSE_MAX_AGE_MS
    || evidenceObjects.some(hasForbiddenInterestEvidence)
  ) return null;

  const flexEvidenceVerified = response?.flex?.status === 'ready'
    && hashesVerified
    && Number.isFinite(fetchedAt)
    && ageMs >= -5_000
    && ageMs <= INTEREST_STATUS_MAX_AGE_MS
    && !hasForbiddenInterestEvidence(response?.flex)
    && !hasForbiddenInterestEvidence(latest);

  const rawDebit = response?.mtd?.verifiedDebit;
  const verifiedDebit = rawDebit === null || rawDebit === undefined || rawDebit === ''
    ? null
    : Number(rawDebit);
  const actualDayCount = Number(response?.mtd?.actualDayCount);
  const rawLiveNetAccrued = explicitFiniteNumber(response?.mtd?.liveNetAccrued);
  const liveNetAccruedObservedAt = Date.parse(String(
    response?.mtd?.liveNetAccruedObservedAt || '',
  ));
  const liveNetAccruedSource = String(
    response?.mtd?.liveNetAccruedSource || '',
  );
  const liveNetAccruedAgeMs = now - liveNetAccruedObservedAt;
  const liveNetAccruedVerified = (
    response?.mtd?.liveNetAccruedStatus === 'live'
    && [
      'ibkr_live_portfolio_balance',
      'ibkr_live_interest_observation',
    ].includes(liveNetAccruedSource)
    && Number.isFinite(rawLiveNetAccrued)
    && Number.isFinite(liveNetAccruedObservedAt)
    && liveNetAccruedAgeMs >= -5_000
    && liveNetAccruedAgeMs <= INTEREST_LIVE_MAX_AGE_MS
  );
  const liveNetAccrued = liveNetAccruedVerified ? rawLiveNetAccrued : null;
  const throughDate = String(response?.mtd?.throughDate || '');
  const latestToDate = String(latest?.toDate || '');
  const mtdVerified = flexEvidenceVerified
    && response?.mtd?.status === 'verified'
    && Number.isFinite(verifiedDebit)
    && verifiedDebit >= 0
    && Number.isInteger(actualDayCount)
    && actualDayCount > 0
    && /^\d{4}-\d{2}-\d{2}$/.test(throughDate)
    && /^\d{4}-\d{2}-\d{2}$/.test(latestToDate)
    && throughDate <= latestToDate;

  const rawForecast = response?.forecast || {};
  const issuedAt = Date.parse(String(rawForecast.issuedAt || ''));
  const principal = explicitFiniteNumber(rawForecast.principal);
  const suppliedLower = explicitFiniteNumber(rawForecast.lower);
  const point = explicitFiniteNumber(rawForecast.point);
  const upper = explicitFiniteNumber(rawForecast.upper);
  const lower = suppliedLower ?? (
    Number.isFinite(point) && Number.isFinite(upper)
      ? Math.max(0, Number((point - (upper - point)).toFixed(2)))
      : null
  );
  const accrualDays = explicitFiniteNumber(rawForecast.accrualDays);
  const effectiveAnnualRate = explicitFiniteNumber(
    rawForecast.effectiveAnnualRate,
  );
  const rateEvidence = rawForecast.rateEvidence;
  const activeForDate = String(rawForecast.activeForDate || '');
  const valueDate = String(rawForecast.valueDate || '');
  const coverageFrom = String(rawForecast.coverageFrom || '');
  const coverageThrough = String(rawForecast.coverageThrough || '');
  const basisSessionDate = String(rawForecast.basisSessionDate || '');
  const cashAnchorDate = String(rawForecast.cashAnchorDate || '');
  const nextSessionDate = String(rawForecast.nextSessionDate || '');
  const forecastKind = String(rawForecast.kind || '');
  const coveredValueDates = Array.isArray(rawForecast.coveredValueDates)
    ? rawForecast.coveredValueDates.map((value) => String(value))
    : [];
  const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;
  const coverageConsecutive = isoDatePattern.test(coverageFrom)
    && coveredValueDates.every((value, index) => {
      if (!isoDatePattern.test(value)) return false;
      const expected = new Date(`${coverageFrom}T00:00:00Z`);
      expected.setUTCDate(expected.getUTCDate() + index);
      return expected.toISOString().slice(0, 10) === value;
    });
  const dayAfterCoverage = isoDatePattern.test(coverageThrough)
    ? new Date(`${coverageThrough}T00:00:00Z`)
    : null;
  dayAfterCoverage?.setUTCDate(dayAfterCoverage.getUTCDate() + 1);
  const forecastWindowVerified = (
    forecastKind === 'completed_session_window'
      ? basisSessionDate === valueDate && cashAnchorDate === valueDate
      : forecastKind === 'closed_day_remaining_window'
        ? basisSessionDate < valueDate && cashAnchorDate === valueDate
        : false
  );
  const coverageVerified = Number.isInteger(accrualDays)
    && accrualDays > 0
    && coveredValueDates.length === accrualDays
    && new Set(coveredValueDates).size === coveredValueDates.length
    && coverageConsecutive
    && coverageFrom === coveredValueDates[0]
    && valueDate === coverageFrom
    && coverageThrough === coveredValueDates.at(-1)
    && isoDatePattern.test(activeForDate)
    && coveredValueDates.includes(activeForDate)
    && isoDatePattern.test(basisSessionDate)
    && basisSessionDate <= coverageFrom
    && isoDatePattern.test(cashAnchorDate)
    && isoDatePattern.test(nextSessionDate)
    && dayAfterCoverage?.toISOString().slice(0, 10) === nextSessionDate
    && forecastWindowVerified;
  const officialRate = rateEvidence?.source === 'ibkr_official_margin_rates'
    && /^https:\/\/[^/]*interactivebrokers\.com\//i.test(String(rateEvidence.url || ''))
    && /^[a-f0-9]{64}$/.test(String(rateEvidence.scheduleHash || ''))
    && rateEvidence.provisional === true;
  const flexRate = rateEvidence?.source === 'ibkr_flex_interest_tier_detail'
    && /^[a-f0-9]{64}$/.test(String(rateEvidence.reportHash || ''))
    && /^[a-f0-9]{64}$/.test(String(rateEvidence.revisionHash || ''))
    && rateEvidence.provisional === false;
  const forecastIssued = rawForecast.status === 'issued'
    && Number.isFinite(principal)
    && principal >= 0
    && Number.isFinite(point)
    && point >= 0
    && Number.isFinite(lower)
    && lower >= 0
    && lower <= point
    && Number.isFinite(upper)
    && upper >= point
    && coverageVerified
    && Number.isFinite(effectiveAnnualRate)
    && effectiveAnnualRate >= 0
    && Number.isFinite(issuedAt)
    && now - issuedAt >= -5_000
    && (officialRate || flexRate)
    && !hasForbiddenInterestEvidence(rateEvidence);

  const normalizeComparison = (rawComparison) => {
    const actual = explicitFiniteNumber(rawComparison?.actual);
    const forecastPoint = explicitFiniteNumber(rawComparison?.forecastPoint);
    const forecastLower = explicitFiniteNumber(rawComparison?.forecastLower)
      ?? forecastPoint;
    const forecastUpper = explicitFiniteNumber(rawComparison?.forecastUpper)
      ?? forecastPoint;
    const residual = explicitFiniteNumber(rawComparison?.residual);
    const verifiedAt = Date.parse(String(rawComparison?.verifiedAt || ''));
    const valueDateValid = isoDatePattern.test(String(rawComparison?.valueDate || ''));
    const bandValid = Number.isFinite(forecastLower)
      && Number.isFinite(forecastPoint)
      && Number.isFinite(forecastUpper)
      && forecastLower >= 0
      && forecastLower <= forecastPoint
      && forecastUpper >= forecastPoint;
    const expectedOutcome = bandValid && Number.isFinite(actual)
      ? actual >= forecastLower - 0.001 && actual <= forecastUpper + 0.001
        ? 'within_band'
        : 'miss'
      : null;
    if (
      flexEvidenceVerified
      && rawComparison?.status === 'verified'
      && bandValid
      && Number.isFinite(actual)
      && actual >= 0
      && Number.isFinite(residual)
      && Math.abs(residual - (actual - forecastPoint)) <= 0.011
      && Number.isFinite(verifiedAt)
      && valueDateValid
      && (!rawComparison.outcome || rawComparison.outcome === expectedOutcome)
    ) {
      return {
        status: 'verified',
        outcome: expectedOutcome,
        valueDate: rawComparison.valueDate,
        forecastLower,
        forecastPoint,
        forecastUpper,
        actual,
        residual,
        issuedAt: rawComparison.issuedAt || null,
        verifiedAt: rawComparison.verifiedAt,
      };
    }
    return null;
  };
  const comparison = response?.comparison || {};
  const verifiedComparison = normalizeComparison(comparison);
  const lastVerifiedComparison = verifiedComparison
    || normalizeComparison(comparison.lastVerified);
  const pendingPoint = explicitFiniteNumber(comparison.forecastPoint);
  const pendingLower = explicitFiniteNumber(comparison.forecastLower);
  const pendingUpper = explicitFiniteNumber(comparison.forecastUpper);
  const pendingBandValid = Number.isFinite(pendingPoint)
    && Number.isFinite(pendingLower)
    && Number.isFinite(pendingUpper)
    && pendingLower >= 0
    && pendingLower <= pendingPoint
    && pendingUpper >= pendingPoint;
  const rawCapabilities = response?.capabilities || {};
  const requiredSectionNames = [
    'tierInterestDetails',
    'interestAccruals',
    'cashTransactions',
    'cashReport',
  ];
  const requiredSections = Object.fromEntries(requiredSectionNames.map(
    (name) => [name, rawCapabilities?.requiredSections?.[name] === true],
  ));
  const missingSections = requiredSectionNames.filter(
    (name) => requiredSections[name] !== true,
  );
  const capabilitiesReady = flexEvidenceVerified
    && rawCapabilities.ready === true
    && missingSections.length === 0;
  const modelStatus = ['provisional', 'learning', 'validated'].includes(
    response?.modelStatus,
  ) ? response.modelStatus : 'provisional';

  return {
    actionable: false,
    modelStatus,
    modelStatusReason: response?.modelStatusReason || null,
    capabilities: {
      ready: capabilitiesReady,
      status: capabilitiesReady
        ? 'ready'
        : flexEvidenceVerified ? 'incomplete' : 'unavailable',
      requiredSections,
      optionalSections: {
        stockBorrowFeeDetails:
          rawCapabilities?.optionalSections?.stockBorrowFeeDetails === true,
      },
      missingSections,
    },
    mtd: {
      status: mtdVerified
        ? 'verified'
        : response?.mtd?.status === 'unavailable'
          ? 'unavailable'
          : 'awaiting',
      verifiedDebit: mtdVerified ? verifiedDebit : null,
      liveNetAccrued,
      liveNetAccruedObservedAt: liveNetAccruedVerified
        ? response.mtd.liveNetAccruedObservedAt
        : null,
      liveNetAccruedSource: liveNetAccruedVerified
        ? liveNetAccruedSource
        : null,
      actualDayCount: mtdVerified ? actualDayCount : 0,
      throughDate: mtdVerified ? throughDate : null,
    },
    forecast: forecastIssued
      ? {
          status: 'issued',
          valueDate: rawForecast.valueDate || null,
          principal,
          lower,
          point,
          upper,
          accrualDays,
          effectiveAnnualRate,
          issuedAt: rawForecast.issuedAt,
          rateEvidence,
          activeForDate,
          coveredValueDates,
          coverageFrom,
          coverageThrough,
          basisSessionDate,
          cashAnchorDate,
          nextSessionDate,
          kind: forecastKind,
        }
      : {
          status: rawForecast.status === 'unavailable' ? 'unavailable' : 'awaiting',
          valueDate: rawForecast.valueDate || null,
          principal: null,
          lower: null,
          point: null,
          upper: null,
          accrualDays: null,
          effectiveAnnualRate: null,
          issuedAt: null,
          rateEvidence: null,
          activeForDate: rawForecast.activeForDate || null,
          coveredValueDates: [],
          coverageFrom: null,
          coverageThrough: null,
          basisSessionDate: null,
          cashAnchorDate: null,
          nextSessionDate: null,
          kind: null,
        },
    comparison: verifiedComparison
      ? { ...verifiedComparison, lastVerified: verifiedComparison }
      : {
          status: 'awaiting',
          outcome: 'pending',
          valueDate: isoDatePattern.test(String(comparison.valueDate || ''))
            ? comparison.valueDate
            : null,
          forecastLower: pendingBandValid ? pendingLower : null,
          forecastPoint: pendingBandValid ? pendingPoint : null,
          forecastUpper: pendingBandValid ? pendingUpper : null,
          actual: null,
          residual: null,
          issuedAt: comparison.issuedAt || null,
          verifiedAt: null,
          lastVerified: lastVerifiedComparison,
        },
    stockBorrowFees: normalizeStockBorrowFees(
      response,
      flexEvidenceVerified ? latest : {},
    ),
  };
}

function plannerErrorMessage(error) {
  const code = String(
    error?.response?.data?.errorCode || error?.code || '',
  ).toUpperCase();
  if (code.includes('OPEN_ORDERS')) {
    return 'Resolve open orders before calculating another scenario.';
  }
  if (code.includes('QUOTE') || code.includes('SYMBOL')) {
    return 'A verified live quote is unavailable for one or more tickers.';
  }
  if (code.includes('SHORTABLE')) {
    return 'IBKR did not verify enough shares are available to short.';
  }
  if (code.includes('CAPACITY')) {
    return 'Interest exposure requires complete live position and settlement detail.';
  }
  return 'This scenario could not be verified from live IBKR evidence.';
}

function capacityUnavailableMessage(capacity) {
  const code = String(capacity?.errorCode || capacity?.reason || '').toUpperCase();
  if (code.includes('SHORT_POSITION') || code.includes('POSITIONS')) {
    return 'Interest exposure unavailable until IBKR provides complete position detail.';
  }
  if (code.includes('POSITION_SCOPE')) {
    return 'Interest exposure is unavailable while an unsupported instrument is open.';
  }
  if (
    (code.includes('EVENT') || code.includes('KALSHI'))
    && code.includes('ACCOUNTING')
  ) {
    return 'Interest exposure is unavailable until IBKR prediction-market balances reconcile.';
  }
  if (code.includes('CURRENCY')) {
    return 'Interest exposure currently supports USD accounts, USD stocks, and supported prediction contracts.';
  }
  if (code.includes('LADDER') || code.includes('SETTLEMENT')) {
    return 'Interest exposure is unavailable until IBKR cash settlements reconcile.';
  }
  if (code.includes('OPEN_ORDERS')) {
    return 'Resolve open orders before calculating interest exposure.';
  }
  return 'Interest exposure is unavailable until IBKR provides complete balance evidence.';
}

function exposureUnavailableMessage(error, loading) {
  if (loading) return 'Reading live exposure from IBKR…';
  const code = String(
    error?.response?.data?.errorCode || error?.code || '',
  ).toUpperCase();
  if (/GATEWAY|SIDECAR|DISCONNECT|STALE/.test(code)) {
    return 'IBKR is disconnected or the live exposure snapshot expired.';
  }
  return 'Live IBKR exposure is unavailable.';
}

function MetricLine({ label, value, detail, nlvPercent, tone = '' }) {
  const formattedNlvPercent = nlvPercent === null || nlvPercent === undefined
    ? null
    : formatPercent(nlvPercent);
  return (
    <div className={`portfolio-scenario-planner__metric-line ${tone ? `is-${tone}` : ''}`}>
      <span>{label}</span>
      <span
        className="portfolio-scenario-planner__metric-value"
        aria-label={formattedNlvPercent
          ? `${formattedNlvPercent} of Net Liquidation Value, ${value}`
          : undefined}
      >
        {formattedNlvPercent && (
          <small
            className="portfolio-scenario-planner__nlv-percent"
            aria-label={`${formattedNlvPercent} of Net Liquidation Value`}
          >
            ({formattedNlvPercent} of <abbr title="Net Liquidation Value">NLV</abbr>)
          </small>
        )}
        {detail && <small>{detail}</small>}
        <strong>{value}</strong>
      </span>
    </div>
  );
}

const EXPOSURE_SCALE_MAX = 120;
const EXPOSURE_SCALE_TICKS = [0, 15, 30, 45, 60, 75, 90, 105, 120];

function scalePosition(value, maximum = EXPOSURE_SCALE_MAX) {
  const number = Number(value);
  if (!Number.isFinite(number) || maximum <= 0) return '0%';
  return `${Math.min(100, Math.max(0, Math.abs(number) / maximum * 100))}%`;
}

function ExposureBar({ label, value, percent, grossPercent, tone, currency }) {
  const formattedPercent = formatPercent(percent);
  const formattedValue = formatCurrency(value, 0, currency);
  const meterValue = Math.min(
    EXPOSURE_SCALE_MAX,
    Math.max(0, Math.abs(Number(percent) || 0)),
  );

  return (
    <div className={`portfolio-scenario-planner__exposure-bar is-${tone}`}>
      <div className="portfolio-scenario-planner__exposure-heading">
        <strong>{label}</strong>
        <span>{formattedPercent}</span>
        <b>{formattedValue}</b>
      </div>
      <div
        className="portfolio-scenario-planner__exposure-track"
        role="meter"
        aria-label={`${label} exposure ${formattedPercent} of Net Liquidation Value, ${formattedValue}`}
        aria-valuemin="0"
        aria-valuemax={EXPOSURE_SCALE_MAX}
        aria-valuenow={meterValue}
        style={{
          '--exposure-fill': scalePosition(percent),
          '--gross-marker': scalePosition(grossPercent),
        }}
      >
        <span className="portfolio-scenario-planner__exposure-fill" />
        <span
          className="portfolio-scenario-planner__gross-marker"
          aria-hidden="true"
        />
      </div>
      <div className="portfolio-scenario-planner__axis" aria-hidden="true">
        <div className="portfolio-scenario-planner__axis-ticks">
          {EXPOSURE_SCALE_TICKS.map((tick) => <i key={tick} />)}
        </div>
        <div className="portfolio-scenario-planner__axis-labels">
          <span>0%</span>
          <span>60%</span>
          <span>120%</span>
        </div>
      </div>
    </div>
  );
}

function ExposureSummary({
  label,
  value,
  percent,
  currency,
  tone = '',
  percentTone = '',
  ariaLabel = null,
}) {
  const formattedPercent = formatPercent(percent);
  const formattedValue = formatCurrency(value, 0, currency);
  const resolvedPercentTone = percentTone || tone || 'neutral';
  return (
    <div
      className={`portfolio-scenario-planner__exposure-summary-item ${tone ? `is-${tone}` : ''}`}
      aria-label={ariaLabel || `${label} exposure ${formattedPercent} of Net Liquidation Value, ${formattedValue}`}
    >
      <div
        className="portfolio-scenario-planner__exposure-summary-heading"
        role="group"
        aria-label={`${label} ${formattedPercent}`}
      >
        <span className="portfolio-scenario-planner__exposure-summary-label">{label}</span>
        <small
          className={`portfolio-scenario-planner__exposure-summary-percent is-${resolvedPercentTone}`}
        >
          ({formattedPercent})
        </small>
      </div>
      <strong>{formattedValue}</strong>
    </div>
  );
}

function ScenarioRow({ leg, kind, result, disabled, onChange, onRemove }) {
  const label = kind === 'long' ? 'Long' : 'Short';
  return (
    <div className="portfolio-scenario-planner__row-wrap">
      <div className="portfolio-scenario-planner__row" data-testid={`portfolio-scenario-row-${leg.id}`}>
        <select
          aria-label={`${label} action ${leg.id}`}
          value={leg.action}
          disabled={disabled}
          onChange={(event) => onChange({ action: event.target.value })}
        >
          {ACTIONS[kind].map((action) => (
            <option key={action.value} value={action.value}>{action.label}</option>
          ))}
        </select>
        <input
          aria-label={`${label} ticker ${leg.id}`}
          value={leg.symbol}
          disabled={disabled}
          placeholder="Ticker"
          autoCapitalize="characters"
          onChange={(event) => onChange({ symbol: event.target.value.toUpperCase() })}
        />
        <select
          aria-label={`${label} quantity mode ${leg.id}`}
          value={leg.quantityMode}
          disabled={disabled}
          onChange={(event) => onChange({ quantityMode: event.target.value })}
        >
          {QUANTITY_MODES.map((mode) => (
            <option key={mode.value} value={mode.value}>{mode.label}</option>
          ))}
        </select>
        <input
          aria-label={`${label} quantity ${leg.id}`}
          value={leg.quantity}
          disabled={disabled}
          inputMode="decimal"
          placeholder="Size"
          onChange={(event) => onChange({ quantity: event.target.value })}
        />
        <input
          aria-label={`${label} estimated fill ${leg.id}`}
          value={leg.price}
          disabled={disabled}
          inputMode="decimal"
          placeholder="Live"
          onChange={(event) => onChange({
            price: event.target.value,
            priceMode: event.target.value ? 'manual' : 'live_side',
          })}
        />
        <button
          type="button"
          className="portfolio-scenario-planner__remove"
          aria-label={`Remove ${label.toLowerCase()} scenario ${leg.id}`}
          title="Remove scenario leg"
          disabled={disabled}
          onClick={onRemove}
        >
          <Trash2 size={12} aria-hidden="true" />
        </button>
      </div>
      {result && (
        <div className="portfolio-scenario-planner__row-result">
          <span>
            {result.shares} shares @ {formatCurrency(result.fillPrice, 2)}
            {' · '}{formatCurrency(Math.abs(result.exposureImpact))}
          </span>
          {result.shortCapacity && (
            <span>
              Max add before estimated debit {result.shortCapacity.exactShares} shares
              {' · '}{formatCurrency(result.shortCapacity.exactNotional)}
              {' · '}{formatPercent(result.shortCapacity.exactPercent)} of NLV
            </span>
          )}
        </div>
      )}
    </div>
  );
}

const PortfolioBalanceScenarioPlanner = ({ accountId }) => {
  const surfaceActive = useSurfaceActivity();
  const {
    status,
    snapshot,
    executable: reportedExecutable,
    lastVerifiedAt,
    error: balanceError,
    loading,
  } = usePortfolioBalance(accountId, { active: surfaceActive });
  const executable = reportedExecutable ?? Boolean(
    snapshot && !['last_verified', 'loading', 'unavailable'].includes(status),
  );
  const liveSnapshot = snapshot && ['live', 'refreshing'].includes(status)
    ? snapshot
    : null;
  const hasLiveSnapshot = Boolean(liveSnapshot);
  const [legs, setLegs] = useState([]);
  const [openSection, setOpenSection] = useState(null);
  const [projection, setProjection] = useState(null);
  const [projectionError, setProjectionError] = useState(null);
  const [previewing, setPreviewing] = useState(false);
  const [interestLedgerOpen, setInterestLedgerOpen] = useState(false);
  const [interestState, setInterestState] = useState({
    status: accountId ? 'loading' : 'unavailable',
    data: null,
  });
  const previewSequenceRef = useRef(0);
  const inFlightPreviewRef = useRef(null);
  const interestLedgerButtonRef = useRef(null);
  const interestLoadedAccountRef = useRef(null);
  const interestRefreshCompletedAtRef = useRef(0);

  const capacityAvailable = Boolean(
    liveSnapshot?.cash
      && liveSnapshot?.buffer
      && liveSnapshot?.capacity?.available !== false,
  );
  const executableCapacityAvailable = executable && capacityAvailable;
  const openOrderCount = Number(liveSnapshot?.activity?.openOrderCount || 0);
  const currency = liveSnapshot?.currency || liveSnapshot?.exposure?.currency || 'USD';

  useEffect(() => {
    let active = true;

    if (!accountId || !hasLiveSnapshot) {
      interestLoadedAccountRef.current = null;
      interestRefreshCompletedAtRef.current = 0;
      setInterestState({ status: 'unavailable', data: null });
      return undefined;
    }
    if (!surfaceActive) return undefined;

    const loadInterest = async () => {
      try {
        const response = await MarketDataService.getIbkrInterestValidationStatus({
          account: accountId,
          refreshLive: true,
        });
        if (!active) return;
        const data = normalizeVerifiedInterestStatus(response);
        if (data) {
          interestLoadedAccountRef.current = accountId;
          interestRefreshCompletedAtRef.current = Date.now();
        } else {
          interestLoadedAccountRef.current = null;
          interestRefreshCompletedAtRef.current = 0;
        }
        setInterestState(data
          ? { status: 'ready', data }
          : { status: 'unavailable', data: null });
      } catch (_error) {
        if (active) {
          interestLoadedAccountRef.current = null;
          interestRefreshCompletedAtRef.current = 0;
          setInterestState({ status: 'unavailable', data: null });
        }
      }
    };

    const retainedForAccount = interestLoadedAccountRef.current === accountId;
    const elapsedMs = Date.now() - interestRefreshCompletedAtRef.current;
    const initialDelayMs = retainedForAccount
      ? Math.max(0, 60_000 - elapsedMs)
      : 0;
    if (initialDelayMs <= 0) {
      if (!retainedForAccount) setInterestState({ status: 'loading', data: null });
      loadInterest();
    }
    const stopPolling = startVisibilityAwarePolling({
      poll: loadInterest,
      intervalMs: 60_000,
      initialDelayMs: initialDelayMs <= 0 ? 60_000 : initialDelayMs,
    });
    return () => {
      active = false;
      stopPolling();
    };
  }, [accountId, hasLiveSnapshot, surfaceActive]);

  useEffect(() => {
    previewSequenceRef.current += 1;
    inFlightPreviewRef.current = null;
    setLegs([]);
    setProjection(null);
    setProjectionError(null);
    setOpenSection(null);
    setPreviewing(false);
    setInterestLedgerOpen(false);
  }, [accountId]);

  useEffect(() => {
    if (!surfaceActive) setInterestLedgerOpen(false);
  }, [surfaceActive]);

  useEffect(() => {
    if (!hasLiveSnapshot) setInterestLedgerOpen(false);
  }, [hasLiveSnapshot]);

  useEffect(() => {
    if (executableCapacityAvailable) return;
    previewSequenceRef.current += 1;
    inFlightPreviewRef.current = null;
    setProjection(null);
    setPreviewing(false);
  }, [executableCapacityAvailable, snapshot?.snapshotId]);

  const requestableLegs = useMemo(() => legs
    .filter((leg) => (
      leg.symbol.trim()
      && Number.isFinite(Number(leg.quantity))
      && Number(leg.quantity) > 0
    ))
    .map((leg) => {
      const manualPrice = Number(leg.price);
      return {
        ...leg,
        symbol: leg.symbol.trim().toUpperCase(),
        quantity: Number(leg.quantity),
        price: leg.price && Number.isFinite(manualPrice) && manualPrice > 0
          ? manualPrice
          : undefined,
      };
    }), [legs]);

  const previewKey = useMemo(() => JSON.stringify({
    accountId,
    snapshotId: snapshot?.snapshotId,
    legs: requestableLegs,
  }), [accountId, requestableLegs, snapshot?.snapshotId]);

  const runPreview = useCallback(async () => {
    if (
      !accountId
      || !snapshot
      || !executableCapacityAvailable
      || openOrderCount > 0
      || !requestableLegs.length
      || !openSection
    ) return null;
    if (inFlightPreviewRef.current?.key === previewKey) {
      return inFlightPreviewRef.current.promise;
    }
    const sequence = ++previewSequenceRef.current;
    setPreviewing(true);
    setProjectionError(null);
    const promise = MarketDataService.previewPortfolioBalance({
      accountId,
      legs: requestableLegs,
    })
      .then((result) => {
        if (sequence === previewSequenceRef.current) {
          setProjection(result);
          setProjectionError(null);
        }
        return result;
      })
      .catch((previewFailure) => {
        if (sequence === previewSequenceRef.current) {
          setProjection(null);
          setProjectionError(plannerErrorMessage(previewFailure));
        }
        return null;
      })
      .finally(() => {
        if (inFlightPreviewRef.current?.sequence === sequence) {
          inFlightPreviewRef.current = null;
          setPreviewing(false);
        }
      });
    inFlightPreviewRef.current = { key: previewKey, sequence, promise };
    return promise;
  }, [
    accountId,
    executableCapacityAvailable,
    openOrderCount,
    openSection,
    previewKey,
    requestableLegs,
    snapshot,
  ]);

  useEffect(() => {
    if (!surfaceActive || !openSection || !requestableLegs.length || !executableCapacityAvailable) return undefined;
    const timer = window.setTimeout(runPreview, 350);
    return () => window.clearTimeout(timer);
  }, [executableCapacityAvailable, openSection, previewKey, requestableLegs.length, runPreview, surfaceActive]);

  useEffect(() => {
    if (!surfaceActive || !openSection || !requestableLegs.length || !executableCapacityAvailable) return undefined;
    const timer = window.setInterval(runPreview, 15_000);
    return () => window.clearInterval(timer);
  }, [executableCapacityAvailable, openSection, requestableLegs.length, runPreview, surfaceActive]);

  const invalidateProjection = () => {
    previewSequenceRef.current += 1;
    inFlightPreviewRef.current = null;
    setProjection(null);
    setProjectionError(null);
    setPreviewing(false);
  };

  const addLeg = (kind) => {
    setLegs((current) => [...current, createLeg(kind)]);
    setOpenSection(kind);
    invalidateProjection();
  };

  const updateLeg = (id, changes) => {
    setLegs((current) => current.map((leg) => (
      leg.id === id ? { ...leg, ...changes } : leg
    )));
    invalidateProjection();
  };

  const removeLeg = (id) => {
    setLegs((current) => current.filter((leg) => leg.id !== id));
    invalidateProjection();
  };

  const longLegs = legs.filter((leg) => (
    leg.action === 'buy_long' || leg.action === 'sell_long'
  ));
  const shortLegs = legs.filter((leg) => (
    leg.action === 'add_short' || leg.action === 'cover_short'
  ));
  const projectionById = useMemo(() => new Map(
    (projection?.legs || []).map((leg) => [leg.id, leg]),
  ), [projection?.legs]);
  const hasScenario = legs.length > 0;
  const controlsDisabled = !accountId || !liveSnapshot || !executable;

  const toggleSection = (section) => {
    if (openSection === section) {
      setOpenSection(null);
      return;
    }
    if (section === 'long' && longLegs.length === 0) {
      setLegs((current) => [...current, createLeg('long')]);
      invalidateProjection();
    }
    if (section === 'short' && shortLegs.length === 0) {
      setLegs((current) => [...current, createLeg('short')]);
      invalidateProjection();
    }
    setOpenSection(section);
  };

  const closeInterestLedger = useCallback(() => {
    setInterestLedgerOpen(false);
    window.setTimeout(() => interestLedgerButtonRef.current?.focus(), 0);
  }, []);

  const renderLegs = (rows, kind) => rows.map((leg) => (
    <ScenarioRow
      key={leg.id}
      leg={leg}
      kind={kind}
      result={projectionById.get(leg.id)}
      disabled={controlsDisabled}
      onChange={(changes) => updateLeg(leg.id, changes)}
      onRemove={() => removeLeg(leg.id)}
    />
  ));

  const interestExposure = liveSnapshot?.interestExposure?.available === true
    && liveSnapshot.interestExposure.status === 'live'
    && liveSnapshot.interestExposure.source === 'ibkr_live_session'
    && liveSnapshot.interestExposure.actionable === false
    ? liveSnapshot.interestExposure
    : null;
  const marginHealth = liveSnapshot?.margin?.available === true
    && liveSnapshot.margin.status === 'live'
    && liveSnapshot.margin.source === 'ibkr_live_session'
    ? liveSnapshot.margin
    : null;
  const currentDebitPrincipal = explicitFiniteNumber(
    interestExposure?.current?.estimatedDebitPrincipal,
  );
  const projectedDebitPrincipal = explicitFiniteNumber(
    interestExposure?.projected?.estimatedDebitPrincipal,
  );
  const bufferedDebitPrincipal = explicitFiniteNumber(
    interestExposure?.policy?.estimatedDebitPrincipalAfterReserve,
  );
  const reserve = explicitFiniteNumber(interestExposure?.policy?.totalReserve);
  const interestExposureReady = Boolean(
    interestExposure
    && currentDebitPrincipal !== null
    && projectedDebitPrincipal !== null
    && bufferedDebitPrincipal !== null
    && reserve !== null,
  );
  const rawNetAccruedInterest = liveSnapshot?.cash?.netAccruedInterest;
  const netAccruedInterest = rawNetAccruedInterest === null
    || rawNetAccruedInterest === undefined
    || rawNetAccruedInterest === ''
    ? null
    : Number(rawNetAccruedInterest);
  const netAccruedAvailable = Number.isFinite(netAccruedInterest)
    && liveSnapshot;
  const netAccruedKind = !netAccruedAvailable
    ? null
    : netAccruedInterest < 0
      ? 'Net cost'
      : netAccruedInterest > 0
        ? 'Net credit'
        : 'No net accrual';
  const interestData = interestState.status === 'ready'
    ? interestState.data
    : null;
  const activeForecast = interestData?.forecast?.status === 'issued'
    ? interestData.forecast
    : null;
  const forecastCoverage = activeForecast
    ? formatAccrualCoverage(
      activeForecast.coverageFrom,
      activeForecast.coverageThrough,
    )
    : null;
  const borrowDaily = interestData?.stockBorrowFees?.daily?.status === 'verified'
    ? interestData.stockBorrowFees.daily.amount
    : null;
  const borrowAggregate = interestData?.stockBorrowFees?.aggregate?.status === 'verified'
    ? interestData.stockBorrowFees.aggregate.total
    : null;
  const interestAriaLabel = netAccruedAvailable
    ? `Net interest ${formatCurrency(Math.abs(netAccruedInterest), 2, currency)}, ${netAccruedKind}, IBKR as of ${formatObservedAt(liveSnapshot?.observedAt)}`
    : 'Net interest unavailable';
  const forecastAriaLabel = activeForecast
    ? `Accrual estimate ${formatCurrency(activeForecast.point, 2, currency)}, forecast band ${formatCurrency(activeForecast.lower, 2, currency)} to ${formatCurrency(activeForecast.upper, 2, currency)}, ${forecastCoverage}, ${activeForecast.accrualDays} day${activeForecast.accrualDays === 1 ? '' : 's'}, ${(activeForecast.effectiveAnnualRate * 100).toFixed(2)}%${activeForecast.rateEvidence?.provisional ? ' provisional' : ''}, ${formatCurrency(activeForecast.principal, 0, currency)} estimated principal`
    : interestState.status === 'loading'
      ? 'Accrual estimate checking IBKR'
      : 'Accrual estimate unavailable';
  const borrowAriaLabel = borrowAggregate !== null
    ? `Borrow fees ${formatCurrency(borrowAggregate, 2, currency)} posted total, daily ${borrowDaily === null ? 'unavailable' : formatCurrency(borrowDaily, 2, currency)}`
    : 'Borrow fees unavailable';
  const comparison = interestData?.comparison || null;
  const comparisonAudit = comparison?.status === 'verified'
    ? comparison
    : comparison?.lastVerified || null;
  const comparisonPending = comparison?.status !== 'verified';
  const missingFlexSections = interestData?.capabilities?.missingSections || [];
  const flexSectionLabels = {
    tierInterestDetails: 'Tier Interest Details',
    interestAccruals: 'Interest Accruals',
    cashTransactions: 'Cash Transactions',
    cashReport: 'Cash Report',
  };

  return (
    <section
      className={`portfolio-scenario-planner portfolio-scenario-planner--${status}`}
      data-testid="portfolio-balance-planner"
      data-status={status}
      aria-label="Portfolio balance scenario planner"
    >
      <div className="portfolio-scenario-planner__body">
        {liveSnapshot ? (
          <>
            <section
              className="portfolio-scenario-planner__exposure-map"
              aria-label="Exposure map"
            >
              <h4>Exposure Map</h4>
              <ExposureBar
                label="Long"
                value={liveSnapshot.exposure.longMarketValue}
                percent={liveSnapshot.exposure.longPercent}
                grossPercent={liveSnapshot.exposure.grossPercent}
                tone="long"
                currency={currency}
              />
              <ExposureBar
                label="Short"
                value={liveSnapshot.exposure.shortMarketValue}
                percent={liveSnapshot.exposure.shortPercent}
                grossPercent={liveSnapshot.exposure.grossPercent}
                tone="short"
                currency={currency}
              />
              <div className="portfolio-scenario-planner__exposure-summary">
                <ExposureSummary
                  label="Total Value"
                  value={liveSnapshot.exposure.netLiquidation}
                  percent={100}
                  currency={currency}
                  ariaLabel={`Total portfolio value ${formatCurrency(liveSnapshot.exposure.netLiquidation, 0, currency)}, 100.0% of Net Liquidation Value`}
                />
                <ExposureSummary
                  label="Gross"
                  value={liveSnapshot.exposure.grossMarketValue}
                  percent={liveSnapshot.exposure.grossPercent}
                  currency={currency}
                  percentTone="accent"
                />
                <ExposureSummary
                  label="Net"
                  value={liveSnapshot.exposure.netMarketValue}
                  percent={liveSnapshot.exposure.netPercent}
                  currency={currency}
                  tone={liveSnapshot.exposure.netMarketValue > 0
                    ? 'positive'
                    : liveSnapshot.exposure.netMarketValue < 0
                      ? 'negative'
                      : ''}
                />
              </div>
            </section>

            <section
              className="portfolio-scenario-planner__capacity-card"
              aria-label="Margin health and interest exposure"
            >
              <div className="portfolio-scenario-planner__card-heading">
                <h4>Margin Health</h4>
                <strong className={marginHealth?.health === 'healthy' ? 'is-positive' : 'is-negative'}>
                  {marginHealth?.health === 'healthy'
                    ? 'Healthy'
                    : marginHealth?.health === 'maintenance_deficit'
                      ? 'Maintenance deficit'
                      : marginHealth?.health === 'initial_deficit'
                        ? 'Initial deficit'
                        : 'Unavailable'}
                </strong>
              </div>
              {marginHealth ? (
                <>
                  <div className={`portfolio-scenario-planner__margin-status ${marginHealth.health === 'healthy' ? 'is-positive' : 'is-negative'}`} role="status">
                    {marginHealth.health === 'healthy' ? (
                      <CheckCircle2 size={13} aria-hidden="true" />
                    ) : (
                      <AlertTriangle size={13} aria-hidden="true" />
                    )}
                    <strong>
                      {marginHealth.health === 'healthy'
                        ? 'No broker margin deficit'
                        : marginHealth.health === 'maintenance_deficit'
                          ? `${formatCurrency(marginHealth.maintenanceDeficit, 0, currency)} broker maintenance deficit`
                          : `${formatCurrency(marginHealth.initialDeficit, 0, currency)} broker initial-margin deficit`}
                    </strong>
                  </div>
                  <div className="portfolio-scenario-planner__margin-grid">
                    <MetricLine
                      label="Excess liquidity"
                      value={formatCurrency(marginHealth.excessLiquidity, 0, currency)}
                      nlvPercent={marginHealth.excessLiquidityPercent}
                      tone={marginHealth.excessLiquidity >= 0 ? 'positive' : 'negative'}
                    />
                    <MetricLine
                      label="Available funds"
                      value={formatCurrency(marginHealth.availableFunds, 0, currency)}
                      tone={marginHealth.availableFunds >= 0 ? 'positive' : 'negative'}
                    />
                    <MetricLine
                      label="Buying power"
                      value={formatCurrency(marginHealth.buyingPower, 0, currency)}
                    />
                  </div>
                </>
              ) : (
                <div className="portfolio-scenario-planner__capacity-unavailable" role="status">
                  Broker-native margin health is unavailable.
                </div>
              )}

              <div className="portfolio-scenario-planner__card-heading portfolio-scenario-planner__card-heading--interest">
                <h4>Interest Exposure</h4>
                <strong>{formatCurrency(projectedDebitPrincipal, 0, currency)}</strong>
              </div>
              {capacityAvailable && interestExposureReady ? (
                <>
                  <div className={`portfolio-scenario-planner__capacity-action ${bufferedDebitPrincipal > 0 ? 'is-negative' : 'is-positive'}`}>
                    {bufferedDebitPrincipal > 0 ? (
                      <AlertTriangle size={13} aria-hidden="true" />
                    ) : (
                      <CheckCircle2 size={13} aria-hidden="true" />
                    )}
                    <strong>
                      {bufferedDebitPrincipal > 0
                        ? `${formatCurrency(bufferedDebitPrincipal, 0, currency)} estimated debit principal after reserve`
                        : 'No estimated debit principal after reserve'}
                    </strong>
                    <span>Policy reserve {formatCurrency(reserve, 0, currency)} · not a margin call or sell instruction</span>
                  </div>
                  <div className="portfolio-scenario-planner__margin-grid">
                    <MetricLine
                      label="Current debit principal"
                      value={formatCurrency(currentDebitPrincipal, 0, currency)}
                      detail={`Effective ${formatSettlementDate(interestExposure.current?.effectiveDate)}`}
                      tone={currentDebitPrincipal > 0 ? 'negative' : 'positive'}
                    />
                    <MetricLine
                      label="Projected debit principal"
                      value={formatCurrency(projectedDebitPrincipal, 0, currency)}
                      detail={`Effective ${formatSettlementDate(interestExposure.projected?.effectiveDate)}`}
                      tone={projectedDebitPrincipal > 0 ? 'negative' : 'positive'}
                    />
                  </div>

                  <div className="portfolio-scenario-planner__settlement-row">
                    <CalendarDays size={12} aria-hidden="true" />
                    <span>
                      {liveSnapshot.settlement?.pending ? 'Pending through ' : 'Settled through '}
                      {formatSettlementDate(liveSnapshot.settlement?.horizonDate)}
                    </span>
                    <span>
                      Projected settled-cash floor {formatCurrency(interestExposure.projected?.securitiesCash, 0, currency)}
                    </span>
                  </div>
                  {openOrderCount > 0 && (
                    <div className="portfolio-scenario-planner__capacity-warning" role="status">
                      Resolve open orders before calculating a scenario.
                    </div>
                  )}
                </>
              ) : (
                <div className="portfolio-scenario-planner__capacity-unavailable" role="status">
                  {capacityUnavailableMessage(liveSnapshot.capacity)} No interest-exposure amount is inferred.
                </div>
              )}
            </section>

            <section className="portfolio-scenario-planner__ledger" aria-label="Interest">
              <div className="portfolio-scenario-planner__ledger-heading">
                <h4>Ledger</h4>
                <button
                  ref={interestLedgerButtonRef}
                  type="button"
                  className="portfolio-scenario-planner__ledger-button"
                  aria-label="View ledger"
                  aria-controls="interest-ledger-panel"
                  aria-expanded={interestLedgerOpen}
                  disabled={!accountId}
                  title="View verified interest ledger"
                  onClick={() => setInterestLedgerOpen(true)}
                >
                  <Table2 size={13} aria-hidden="true" />
                </button>
              </div>
              <div className="portfolio-scenario-planner__ledger-grid">
                <div
                  className={`portfolio-scenario-planner__ledger-cell ${netAccruedAvailable && netAccruedInterest < 0 ? 'is-negative' : netAccruedAvailable && netAccruedInterest > 0 ? 'is-positive' : ''}`}
                  aria-label={interestAriaLabel}
                >
                  <span>MTD net</span>
                  <strong>
                    {netAccruedAvailable
                      ? formatCurrency(Math.abs(netAccruedInterest), 2, currency)
                      : '—'}
                  </strong>
                  <small>{netAccruedKind || 'IBKR live'}</small>
                </div>
                <div
                  className={`portfolio-scenario-planner__ledger-cell ${activeForecast && activeForecast.point > 0 ? 'is-negative' : ''}`}
                  aria-label={forecastAriaLabel}
                >
                  <span>Estimate</span>
                  <strong>
                    {activeForecast
                      ? formatCurrency(activeForecast.point, 2, currency)
                      : '—'}
                  </strong>
                  <small>
                    {activeForecast
                      ? `${formatCurrency(activeForecast.lower, 2, currency)}–${formatCurrency(activeForecast.upper, 2, currency)}`
                      : 'Daily charge'}
                  </small>
                </div>
                <div
                  className={`portfolio-scenario-planner__ledger-cell ${borrowAggregate !== null && borrowAggregate > 0 ? 'is-negative' : ''}`}
                  aria-label={borrowAriaLabel}
                >
                  <span>Borrow</span>
                  <strong>
                    {borrowAggregate !== null
                      ? formatCurrency(borrowAggregate, 2, currency)
                      : '—'}
                  </strong>
                  <small>
                    Daily {borrowDaily !== null
                      ? formatCurrency(borrowDaily, 2, currency)
                      : '—'}
                  </small>
                </div>
              </div>
              {interestState.status === 'loading' && (
                <div className="portfolio-scenario-planner__audit is-pending" role="status">
                  Checking the locked forecast against IBKR’s daily actual…
                </div>
              )}
              {interestState.status === 'unavailable' && (
                <div className="portfolio-scenario-planner__audit is-unavailable" role="status">
                  Daily reconciliation is unavailable; no accuracy conclusion is shown.
                </div>
              )}
              {interestData && comparisonPending && (
                <div className={`portfolio-scenario-planner__audit ${comparisonAudit?.outcome === 'miss' ? 'is-miss' : 'is-pending'}`} role="status">
                  <strong>
                    {comparisonAudit?.outcome === 'miss'
                      ? 'Model provisional after verified miss.'
                      : 'Daily actual pending.'}
                  </strong>{' '}
                  Awaiting IBKR’s daily debit-interest actual
                  {comparison?.valueDate ? ` for ${formatSettlementDate(comparison.valueDate)}` : ''}.
                  {' '}An unchanged MTD net is pending evidence, not a $0 actual.
                </div>
              )}
              {interestData && comparison?.status === 'verified' && (
                <div className={`portfolio-scenario-planner__audit ${comparison.outcome === 'miss' ? 'is-miss' : 'is-match'}`} role="status">
                  <strong>
                    {comparison.outcome === 'miss'
                      ? 'Forecast miss — model downgraded to provisional.'
                      : 'Forecast matched IBKR’s verified daily actual.'}
                  </strong>{' '}
                  {formatCurrency(comparison.actual, 2, currency)} actual versus{' '}
                  {formatCurrency(comparison.forecastLower, 2, currency)}–{formatCurrency(comparison.forecastUpper, 2, currency)} forecast band
                  {comparison.valueDate ? ` for ${formatSettlementDate(comparison.valueDate)}` : ''}.
                </div>
              )}
              {interestData && !interestData.capabilities?.ready && (
                <div className="portfolio-scenario-planner__audit is-unavailable" role="status">
                  <strong>Flex audit coverage incomplete.</strong>{' '}
                  Missing {missingFlexSections.map(
                    (section) => flexSectionLabels[section] || section,
                  ).join(', ') || 'required sections'}; model remains non-actionable.
                </div>
              )}
            </section>
          </>
        ) : (
          <div className="portfolio-scenario-planner__no-live" role="status">
            <AlertTriangle size={18} aria-hidden="true" />
            <strong>{exposureUnavailableMessage(balanceError, loading)}</strong>
            <span>
              {status === 'last_verified'
                ? `Last verified ${formatObservedAt(lastVerifiedAt || snapshot?.observedAt)}. Reconnect to view current values.`
                : balanceError?.message || 'Waiting for verified live IBKR data.'}
            </span>
          </div>
        )}

        <div className="portfolio-scenario-planner__sections" role="group" aria-label="Scenario planner">
          <button
            type="button"
            className={openSection === 'long' ? 'is-active' : ''}
            aria-label="+Long scenario"
            aria-expanded={openSection === 'long'}
            onClick={() => toggleSection('long')}
            disabled={controlsDisabled}
          >
            <span aria-hidden="true">+</span> Long
            {longLegs.length > 0 && (
              <small>{longLegs.length} row{longLegs.length === 1 ? '' : 's'}</small>
            )}
          </button>
          <button
            type="button"
            className={openSection === 'short' ? 'is-active' : ''}
            aria-label="-Short scenario"
            aria-expanded={openSection === 'short'}
            onClick={() => toggleSection('short')}
            disabled={controlsDisabled}
          >
            <span aria-hidden="true">−</span> Short
            {shortLegs.length > 0 && (
              <small>{shortLegs.length} row{shortLegs.length === 1 ? '' : 's'}</small>
            )}
          </button>
          <button
            type="button"
            className={openSection === 'combined' ? 'is-active' : ''}
            aria-label="Long+Short scenario"
            aria-expanded={openSection === 'combined'}
            onClick={() => toggleSection('combined')}
            disabled={controlsDisabled}
          >
            Combined
            {hasScenario && <small>{legs.length}</small>}
          </button>
        </div>

        {liveSnapshot && openSection === 'long' && (
          <div className="portfolio-scenario-planner__section-content">
            {renderLegs(longLegs, 'long')}
            <button type="button" className="portfolio-scenario-planner__add" onClick={() => addLeg('long')} disabled={controlsDisabled}>
              <Plus size={11} aria-hidden="true" /> Add long row
            </button>
          </div>
        )}

        {liveSnapshot && openSection === 'short' && (
          <div className="portfolio-scenario-planner__section-content">
            {renderLegs(shortLegs, 'short')}
            <button type="button" className="portfolio-scenario-planner__add" onClick={() => addLeg('short')} disabled={controlsDisabled}>
              <Plus size={11} aria-hidden="true" /> Add short row
            </button>
          </div>
        )}

        {liveSnapshot && openSection === 'combined' && (
          <div className="portfolio-scenario-planner__combined">
            {!hasScenario && <span>Add a long or short row first.</span>}
            {hasScenario && !executableCapacityAvailable && (
              <span>{capacityUnavailableMessage(liveSnapshot.capacity)}</span>
            )}
            {hasScenario && executableCapacityAvailable && !projection && (
              <span>{projectionError || (openOrderCount > 0
                ? 'Resolve open orders before calculating this scenario.'
                : 'Enter a ticker in each active row to calculate the combined result.')}</span>
            )}
            {projection?.legs?.map((leg) => (
              <div className="portfolio-scenario-planner__combined-leg" key={leg.id}>
                <span><strong>{leg.symbol}</strong> {ACTION_LABELS[leg.action]} {leg.shares} @ {formatCurrency(leg.fillPrice, 2, currency)}</span>
                <small>{formatCurrency(Math.abs(leg.exposureImpact), 0, currency)} exposure</small>
              </div>
            ))}
          </div>
        )}

        {liveSnapshot && projection && (
          <section className="portfolio-scenario-planner__metrics portfolio-scenario-planner__new-exposure" aria-label="New exposure">
            <h4>New Exposure</h4>
            <div className="portfolio-scenario-planner__metric-list">
              <MetricLine label="Long" value={formatCurrency(projection.exposure.longMarketValue, 0, currency)} nlvPercent={projection.exposure.longPercent} tone="long" />
              <MetricLine label="Short" value={formatCurrency(projection.exposure.shortMarketValue, 0, currency)} nlvPercent={projection.exposure.shortPercent} tone="short" />
              <MetricLine label="Gross" value={formatCurrency(projection.exposure.grossMarketValue, 0, currency)} nlvPercent={projection.exposure.grossPercent} />
              <MetricLine label="Net" value={formatCurrency(projection.exposure.netMarketValue, 0, currency)} nlvPercent={projection.exposure.netPercent} />
              <MetricLine
                label="Projected debit principal"
                value={formatCurrency(projection.exact?.trimRequired || 0, 0, currency)}
                detail={projection.exact?.trimRequired > 0
                  ? 'Interest estimate input; not a margin instruction'
                  : `${formatCurrency(projection.exact?.remainingRoom, 0, currency)} interest-free room`}
                tone={projection.exact?.trimRequired > 0 ? 'negative' : 'positive'}
              />
              <MetricLine
                label="Debit principal after reserve"
                value={formatCurrency(projection.buffered?.trimRequired || 0, 0, currency)}
                detail={projection.buffered?.trimRequired > 0
                  ? 'Policy-reserved interest estimate'
                  : `${formatCurrency(projection.buffered?.remainingRoom, 0, currency)} room after reserve`}
                tone={projection.buffered?.trimRequired > 0 ? 'negative' : 'positive'}
              />
            </div>
            <small className="portfolio-scenario-planner__no-order">
              Observed {formatObservedAt(projection.observedAt)} · No order submitted · Broker margin not projected
            </small>
          </section>
        )}

        <div className="portfolio-scenario-planner__footer" role="status">
          <span className={liveSnapshot ? 'is-verified' : 'is-unavailable'}>
            {liveSnapshot ? (
              <CheckCircle2 size={11} aria-hidden="true" />
            ) : (
              <AlertTriangle size={11} aria-hidden="true" />
            )}
            {liveSnapshot
              ? `Verified ${formatObservedAt(liveSnapshot.observedAt)}`
              : status === 'loading'
                ? 'Checking live IBKR'
                : 'No live IBKR data'}
          </span>
          {previewing && <span>Calculating scenario…</span>}
          {projectionError && openSection !== 'combined' && <span className="is-error">{projectionError}</span>}
        </div>
      </div>
      <InterestLedgerPanel
        accountId={accountId}
        anchorRef={interestLedgerButtonRef}
        onClose={closeInterestLedger}
        open={interestLedgerOpen}
      />
    </section>
  );
};

export default PortfolioBalanceScenarioPlanner;
