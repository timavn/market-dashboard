import React, { useMemo, useEffect, useCallback, useState } from 'react';
import { ArrowRight, RefreshCw } from 'lucide-react';
import StatusDot from '../../common/StatusDot';
import LoadingIndicator from '../../common/LoadingIndicator';
import PopoverSelect from '../../common/PopoverSelect';
import {
  getIbkrPortfolioStatusDot,
  getPortfolioOfflinePanel,
  getPortfolioSidebarBanner,
  getIbkrPortfolioFreshness,
  isPortfolioSyncPending,
} from '../../../utils/ibkrConnectionStatus';
import {
  computePortfolioExposure,
  formatExposurePct,
  formatCurrency,
  formatSignedCurrency,
  IDLE_CASH_TOOLTIP,
  isUsEquitySessionActive,
  resolvePortfolioHeaderSnapshot,
} from '../../../utils/portfolioExposureMetrics';
import calculateIbkrCashBorrowing, {
  calculateIbkrCashBorrowingReference,
} from '../../../utils/ibkrCashBorrowing';
import { getLongShortPositionSnapshot } from '../../../utils/portfolioBreakdownUtils';
import {
  buildHedgeyeLatestUpdatesFeed,
  buildHedgeyeLatestUpdatesStatus,
  formatHedgeyeFeedTime,
} from '../../../utils/hedgeyeLatestUpdatesFeed';
import { saveSelectedAccount, loadIbkrAccounts, saveIbkrAccounts } from '../../../constants/ibkrAccountStorage';
import { formatIbkrAccountLabel, IBKR_ACCOUNT_LABELS } from '../../../constants/ibkrAccountLabels';
import { isExplicitlySafeResearchComparison } from '../../../utils/researchComparisonContract';
import portfolioFolderIcon from '../../../assets/portfolio-folder-icon.png';
import './PortfolioSidebarSnapshot.css';

const STRATEGY_SUBTITLE = 'Long/Short Global Macro';
const PORTFOLIO_CLOSE_CACHE_PREFIX = 'portfolioCloseSnapshot:';
const FLEX_RECONCILIATION_TOLERANCE_PCT = 2.5;
const CASH_GUARD_MAX_AGE_MS = 15 * 1000;
const CASH_GUARD_REFERENCE_MAX_AGE_MS = 2 * 60 * 1000;
const CASH_GUARD_FUTURE_TOLERANCE_MS = 5 * 1000;
const INTEREST_VALIDATION_STATUS_MAX_AGE_MS = 2 * 60 * 1000;
const CASH_GUARD_PRIOR_CLOSE_SOURCES = new Set([
  'ibkr_live_tick_close',
  'ibkr_historical_daily_close',
]);
const consumedCashGuardSnapshots = new Set();

function consumeCashGuardSnapshot(snapshotKey) {
  consumedCashGuardSnapshots.add(snapshotKey);
  while (consumedCashGuardSnapshots.size > 100) {
    const oldest = consumedCashGuardSnapshots.values().next().value;
    consumedCashGuardSnapshots.delete(oldest);
  }
}

function AccountDropdownLabel({ accountId, value, currency, dailyPct }) {
  const label = formatIbkrAccountLabel(accountId);
  const hasDailyPct = dailyPct != null && Number.isFinite(dailyPct);
  const pctText = hasDailyPct
    ? `${dailyPct > 0 ? '+' : ''}${dailyPct.toFixed(2)}%`
    : '--';
  const pctTone = hasDailyPct
    ? dailyPct > 0
      ? 'positive'
      : dailyPct < 0
        ? 'negative'
        : 'neutral'
    : 'neutral';

  return (
    <span className="pf-account-label">
      <span className="pf-account-label__main">
        {label}: {formatCurrency(value, currency)}
      </span>
      <span className="pf-account-label__pct-wrap" aria-label={`Daily change ${pctText}`}>
        <span className="pf-account-label__paren">(</span>
        <span className={`pf-account-label__pct pf-account-label__pct--${pctTone}`}>
          {pctText}
        </span>
        <span className="pf-account-label__paren">)</span>
      </span>
    </span>
  );
}

function SetupStep({ done, label }) {
  return (
    <li className={`pf-setup__step${done ? ' pf-setup__step--done' : ''}`}>
      <span className="pf-setup__marker" aria-hidden="true">
        {done ? '✓' : '○'}
      </span>
      <span>{label}</span>
    </li>
  );
}

function clampPercent(value) {
  return Math.max(0, Math.min(100, value));
}

function formatSignedNominal(value) {
  if (value == null || !Number.isFinite(value)) return '—';
  const abs = new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 0,
  }).format(Math.abs(value));
  if (value > 0) return `+${abs}`;
  if (value < 0) return `-${abs}`;
  return abs;
}

function formatPortfolioRefreshAsOf(portfolioData) {
  const candidates = [
    portfolioData?.funding?.observedAt,
    portfolioData?.socketVerifiedAt,
    portfolioData?.dataQuality?.fetchedAt,
    portfolioData?.accountSummary?.lastUpdated,
  ];
  for (const candidate of candidates) {
    const timestamp = Date.parse(String(candidate || ''));
    if (!Number.isFinite(timestamp)) continue;
    return new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
    }).format(new Date(timestamp));
  }
  const label = String(portfolioData?.lastUpdated || '').trim();
  return label && label !== '—' ? label : 'time unavailable';
}

function ExposureBar({ label, pct, amount, currency = 'USD', netAmount = false, tooltip, scaleMin = -200, scaleMax = 200 }) {
  const display = formatExposurePct(pct);
  const amountDisplay = netAmount ? formatSignedNominal(amount) : formatCurrency(amount, currency);
  const hasAmount = amountDisplay !== '—';
  const hasValue = pct != null && Number.isFinite(pct);
  const segmentTestId = `exposure-segment-${label.toLowerCase().replace(/\s+/g, '-')}`;
  const value = hasValue ? pct : 0;
  const roundedValue = Math.round(value);
  const scaleRange = scaleMax - scaleMin;
  const tone = roundedValue > 0 ? 'positive' : roundedValue < 0 ? 'negative' : 'neutral';

  // Calculate positions as percentages of the scale
  const zeroPos = ((0 - scaleMin) / scaleRange) * 100;
  const valuePos = clampPercent(((value - scaleMin) / scaleRange) * 100);

  // Determine bar segment: from zero to value
  const barStart = Math.min(zeroPos, valuePos);
  const barWidth = Math.abs(valuePos - zeroPos);

  // Color mapping follows the displayed value: below 0 red, 0 black, above 0 green.
  const colorMap = {
    positive: '#059669',
    negative: '#dc2626',
    neutral: '#111827',
  };
  const barColor = colorMap[tone];

  // Tick marks at -200, -100, 0, 100, 200
  const ticks = [-200, -100, 0, 100, 200];

  return (
    <div className="pf-bar" role="group" aria-label={label} title={tooltip || undefined}>
      <div className="pf-bar__row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span className="pf-label">{label}</span>
        <span className={`pf-bar__value pf-bar__value--${tone}`} style={{ marginLeft: 'auto' }}>
          <span>{display}</span>
          {hasAmount && (
            <span className={`pf-bar__amount${netAmount ? ' pf-bar__amount--net' : ''}`}>
              ({amountDisplay})
            </span>
          )}
        </span>
      </div>
      <div className="pf-bar__track-container">
        <div className="pf-bar__track">
          {/* Tick marks */}
          {ticks.map((tick) => {
            const tickPos = ((tick - scaleMin) / scaleRange) * 100;
            return (
              <div
                key={tick}
                className={`pf-bar__tick ${tick === 0 ? 'pf-bar__tick--zero' : ''}`}
                style={{ left: `${tickPos}%` }}
              />
            );
          })}

          {/* Center zero line (taller than other ticks) */}
          <div className="pf-bar__zero-line" style={{ left: `${zeroPos}%` }} />

          {/* Active bar segment from 0 to value */}
          {hasValue && value !== 0 && barWidth > 0 && (
            <div
              className="pf-bar__segment"
              data-testid={segmentTestId}
              style={{
                left: `${barStart}%`,
                width: `${barWidth}%`,
                backgroundColor: barColor,
              }}
            />
          )}

          {/* Zero marker when value is exactly 0 */}
          {hasValue && value === 0 && (
            <div
              className="pf-bar__zero-marker"
              style={{ left: `${zeroPos}%` }}
            />
          )}

          {/* Value is shown in the row header; keep the track visually lean. */}
        </div>
      </div>
    </div>
  );
}

function isCurrentFundingTimestamp(value, now) {
  const timestamp = Date.parse(String(value || ''));
  if (!Number.isFinite(timestamp)) return false;
  const ageMs = Number(now) - timestamp;
  return ageMs >= -CASH_GUARD_FUTURE_TOLERANCE_MS && ageMs <= CASH_GUARD_MAX_AGE_MS;
}

function isCurrentReferenceTimestamp(value, now) {
  const timestamp = Date.parse(String(value || ''));
  if (!Number.isFinite(timestamp)) return false;
  const ageMs = Number(now) - timestamp;
  return (
    ageMs >= -CASH_GUARD_FUTURE_TOLERANCE_MS
    && ageMs <= CASH_GUARD_REFERENCE_MAX_AGE_MS
  );
}

function cashGuardReasonText(reason) {
  const messages = {
    refreshing: 'Refreshing the verified IBKR funding snapshot.',
    portfolio_offline: 'Verified live IBKR funding is unavailable.',
    provider_status_delayed: 'The live IBKR connection status could not be refreshed. Refresh before sizing.',
    live_session_unverified: 'The portfolio is not backed by a verified live IBKR session.',
    cached_snapshot: 'Cached portfolio or funding data cannot be used for sizing.',
    account_mismatch: 'The funding snapshot does not match the selected account.',
    funding_missing: 'IBKR did not return the funding inputs required for this guard.',
    funding_unverified: 'The funding snapshot is not verified as live IBKR data.',
    funding_stale: 'The live funding snapshot is more than 15 seconds old. Refresh for a one-use estimate.',
    reference_unverified: 'IBKR did not return a verified completed-session reference.',
    reference_stale: 'The broker connection used for this reference is no longer current. Refresh to verify it again.',
    short_evidence_mismatch: 'The verified short-position evidence is incomplete.',
    short_evidence_unverified: 'Every short requires a fresh live IBKR prior close and current price.',
    short_exposure_evidence_mismatch: 'Live short marks do not reconcile to IBKR aggregate short exposure.',
    settlement_unverified: 'IBKR has not verified that the short evidence is fully settled.',
    unsettled_securities_activity: 'Unsettled securities activity prevents safe cash sizing.',
    non_settlement_day: 'Cash sizing is unavailable outside a U.S. securities settlement day.',
    execution_unverified: 'IBKR has not verified that there are no same-day executions.',
    open_orders_present: 'Open orders can change cash. Resolve them and refresh.',
    unsupported_currency: 'This guard currently supports USD-only funding and positions.',
    unsupported_short_position_currency: 'A short position is outside the supported USD scope.',
    unsupported_position_scope: 'This guard requires a stock-only portfolio.',
    account_not_ready: 'IBKR has not marked the account funding snapshot ready.',
    invalid_funding_payload: 'The live funding payload is incomplete.',
    inconsistent_stock_exposure: 'IBKR returned inconsistent stock exposure totals.',
  };
  return messages[reason] || 'The live funding inputs are incomplete or inconsistent.';
}

function verifiedInterestValidationReserve(snapshot, now, selectedAccount) {
  const requestedAccount = String(snapshot?.requestedAccount || '').trim();
  const currentAccount = String(selectedAccount || '').trim();
  if (
    !snapshot
    || snapshot.source !== 'ibkr_interest_validation'
    || snapshot.accountMatched !== true
    || !currentAccount
    || requestedAccount !== currentAccount
    || snapshot.guard?.available !== true
    || snapshot.guard?.mode !== 'graduated'
  ) {
    return null;
  }
  const generatedAt = Date.parse(String(snapshot.generatedAt || ''));
  const age = Number(now) - generatedAt;
  const reserve = Number(snapshot.guard.appliedReserve);
  if (
    !Number.isFinite(generatedAt)
    || age < -CASH_GUARD_FUTURE_TOLERANCE_MS
    || age > INTEREST_VALIDATION_STATUS_MAX_AGE_MS
    || !Number.isFinite(reserve)
    || reserve < 0
  ) {
    return null;
  }
  return reserve;
}

function resolveCashDebitGuard({
  portfolioData,
  selectedAccount,
  connection,
  interestValidation,
  refreshing,
  now,
}) {
  if (refreshing && !portfolioData) {
    return {
      available: false,
      viewStatus: 'refreshing',
      reason: 'refreshing',
      calculation: null,
      funding: null,
    };
  }

  if (portfolioData?.dataSource !== 'ibkr_api') {
    return {
      available: false,
      viewStatus: 'unavailable',
      reason: 'portfolio_offline',
      calculation: null,
      funding: null,
    };
  }

  if (portfolioData?.liveSessionVerified !== true) {
    return {
      available: false,
      viewStatus: 'unavailable',
      reason: 'live_session_unverified',
      calculation: null,
      funding: null,
    };
  }

  const funding = portfolioData?.funding;
  const fundingReference = portfolioData?.fundingReference;
  const selectedEvidence = funding || fundingReference;
  if (
    portfolioData?.fromCache === true
    || (selectedEvidence && selectedEvidence.fromCache !== false)
  ) {
    return {
      available: false,
      viewStatus: 'unavailable',
      reason: 'cached_snapshot',
      calculation: null,
      funding: null,
    };
  }

  const requestedAccount = String(selectedAccount || '').trim();
  const fundingAccount = String(selectedEvidence?.accountId || '').trim();
  const portfolioAccount = String(portfolioData?.accountId || '').trim();
  if (
    !requestedAccount ||
    (selectedEvidence && fundingAccount !== requestedAccount) ||
    (portfolioAccount && portfolioAccount !== requestedAccount)
  ) {
    return {
      available: false,
      viewStatus: 'unavailable',
      reason: 'account_mismatch',
      calculation: null,
      funding: null,
    };
  }

  if (!funding && fundingReference) {
    if (
      portfolioData?.fundingUnavailableReason !== 'non_settlement_day'
      || fundingReference.status !== 'reference'
      || fundingReference.source !== 'ibkr_completed_session_reference'
      || fundingReference.referenceOnly !== true
      || fundingReference.actionable !== false
    ) {
      return {
        available: false,
        viewStatus: 'unavailable',
        reason: 'reference_unverified',
        calculation: null,
        funding: null,
      };
    }

    const referenceTimestamps = [
      fundingReference.observedAt,
      fundingReference.socketVerifiedAt,
      fundingReference.accountValuesObservedAt,
    ];
    if (
      referenceTimestamps.some(
        (timestamp) => !isCurrentReferenceTimestamp(timestamp, now),
      )
    ) {
      return {
        available: false,
        viewStatus: 'unavailable',
        reason: 'reference_stale',
        calculation: null,
        funding: null,
      };
    }

    const interestValidationReserve = verifiedInterestValidationReserve(
      interestValidation,
      now,
      selectedAccount,
    );
    const referenceCalculation =
      calculateIbkrCashBorrowingReference({
        ...fundingReference,
        ...(interestValidationReserve !== null
          ? { interestValidationReserve }
          : {}),
      });
    if (
      referenceCalculation?.available !== true
      || referenceCalculation.referenceOnly !== true
      || referenceCalculation.actionable !== false
    ) {
      return {
        available: false,
        viewStatus: 'unavailable',
        reason: referenceCalculation?.reason || 'reference_unverified',
        reasons: referenceCalculation?.reasons || [],
        calculation: null,
        funding: null,
      };
    }

    return {
      available: false,
      referenceAvailable: true,
      viewStatus: 'reference',
      reason: 'non_settlement_day',
      calculation: referenceCalculation,
      funding: null,
      referenceFunding: fundingReference,
    };
  }

  if (connection?.connected !== true) {
    return {
      available: false,
      viewStatus: 'unavailable',
      reason: 'portfolio_offline',
      calculation: null,
      funding: null,
    };
  }

  if (connection?.statusRefreshDelayed === true) {
    return {
      available: false,
      viewStatus: 'unavailable',
      reason: 'provider_status_delayed',
      calculation: null,
      funding: null,
    };
  }

  if (!funding) {
    const unavailableReason = [
      'non_settlement_day',
      'settlement_unverified',
      'unsettled_securities_activity',
    ].includes(portfolioData?.fundingUnavailableReason)
      ? portfolioData.fundingUnavailableReason
      : 'funding_missing';
    return {
      available: false,
      viewStatus: 'unavailable',
      reason: unavailableReason,
      calculation: null,
      funding: null,
    };
  }

  if (
    funding.status !== 'live' ||
    funding.source !== 'ibkr_live_session'
  ) {
    return {
      available: false,
      viewStatus: 'unavailable',
      reason: 'funding_unverified',
      calculation: null,
      funding: null,
    };
  }

  if (funding.settledShortPositionsVerified !== true) {
    return {
      available: false,
      viewStatus: 'unavailable',
      reason: 'settlement_unverified',
      calculation: null,
      funding: null,
    };
  }
  if (funding.settlementStatus !== 'settled') {
    return {
      available: false,
      viewStatus: 'unavailable',
      reason: 'unsettled_securities_activity',
      calculation: null,
      funding: null,
    };
  }
  if (
    funding.noSameDayExecutionsVerified !== true ||
    funding.sameDayExecutionCount !== 0
  ) {
    return {
      available: false,
      viewStatus: 'unavailable',
      reason: 'execution_unverified',
      calculation: null,
      funding: null,
    };
  }

  const fundingTimestamps = [
    funding.observedAt,
    funding.socketVerifiedAt,
    funding.accountValuesObservedAt,
  ];
  if (fundingTimestamps.some((timestamp) => !isCurrentFundingTimestamp(timestamp, now))) {
    return {
      available: false,
      viewStatus: 'unavailable',
      reason: 'funding_stale',
      calculation: null,
      funding: null,
    };
  }

  const shortPositions = Array.isArray(funding.shortPositions) ? funding.shortPositions : null;
  const shortPositionCount = Number(funding.shortPositionCount);
  if (
    !shortPositions ||
    !Number.isInteger(shortPositionCount) ||
    shortPositionCount < 0 ||
    shortPositionCount !== shortPositions.length
  ) {
    return {
      available: false,
      viewStatus: 'unavailable',
      reason: 'short_evidence_mismatch',
      calculation: null,
      funding: null,
    };
  }
  if (shortPositions.some((position) => (
    Number(position?.marketDataType) !== 1 ||
    position?.currentPriceSource !== 'ibkr_ticker_direct_max' ||
    !CASH_GUARD_PRIOR_CLOSE_SOURCES.has(position?.priorCloseSource) ||
    !isCurrentFundingTimestamp(position?.snapshotTimestamp, now)
  ))) {
    return {
      available: false,
      viewStatus: 'unavailable',
      reason: 'short_evidence_unverified',
      calculation: null,
      funding: null,
    };
  }

  const interestValidationReserve = verifiedInterestValidationReserve(
    interestValidation,
    now,
    selectedAccount,
  );
  const fundingWithInterestReserve = {
    ...funding,
    ...(interestValidationReserve !== null
      ? { interestValidationReserve }
      : {}),
  };
  const calculation = calculateIbkrCashBorrowing(fundingWithInterestReserve);
  if (calculation?.available !== true) {
    return {
      available: false,
      viewStatus: 'unavailable',
      reason: calculation?.reason || 'invalid_funding_payload',
      reasons: calculation?.reasons || [],
      calculation: null,
      funding: null,
    };
  }

  return {
    available: true,
    viewStatus: 'live',
    reason: null,
    calculation,
    funding: fundingWithInterestReserve,
  };
}

function formatLiveFundingTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Live';
  return `Live ${date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  })}`;
}

function formatSettlementDate(value) {
  const normalized = String(value || '').trim();
  const match = normalized.match(/^(\d{4})-?(\d{2})-?(\d{2})$/);
  if (!match) return normalized || 'unknown date';
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

function formatReferenceDate(value, { weekday = false } = {}) {
  const normalized = String(value || '').trim();
  const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return normalized || 'unknown date';
  const date = new Date(Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
  ));
  return date.toLocaleDateString('en-US', {
    ...(weekday ? { weekday: 'short' } : {}),
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

function positiveInputNumber(value) {
  if (String(value || '').trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function formatShareQuantity(value) {
  if (!Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 4,
  }).format(value);
}

function formatProjectedExposure(value, nlv, currency, { signed = false } = {}) {
  if (!Number.isFinite(value)) return '—';
  const amount = signed ? formatSignedCurrency(value, currency) : formatCurrency(value, currency);
  if (!Number.isFinite(nlv) || nlv <= 0) return amount;
  const pct = (value / nlv) * 100;
  return `${amount} · ${formatExposurePct(pct, { signed })}`;
}

function scenarioReasonText(reason) {
  const messages = {
    invalid_long_notional: 'Enter a positive dollar amount.',
    short_trade_requires_quantity: 'Enter a positive share quantity.',
    short_trade_requires_limit_price: 'Enter a positive limit price.',
    add_short_limit_above_live_bid: 'For immediate sizing, the add-to-short sell limit must be at or below the verified live bid.',
    cover_short_limit_below_live_ask: 'For immediate sizing, the cover buy limit must be at or above the verified live ask.',
    short_trade_requires_verified_conid: 'Select one exact verified live short position.',
    short_trade_position_not_found: 'That short is no longer present in the verified snapshot.',
    short_trade_position_ambiguous: 'IBKR returned an ambiguous short identity. Refresh before sizing.',
    short_trade_identity_unavailable: 'No uniquely identified live short is available for sizing.',
    short_trade_manual_pricing_not_allowed: 'Current and prior market evidence must come from the verified live position.',
    cover_short_quantity_exceeds_verified_position: 'Cover shares exceed that exact verified short.',
    cover_short_exceeds_validated_short_exposure: 'The cover exceeds verified aggregate short exposure.',
  };
  return messages[reason] || 'This planned trade cannot be projected from the verified snapshot.';
}

function CashDebitReferenceContent({ calculation }) {
  const currency = calculation?.currency || 'USD';
  const hasHeadroom = calculation.guardedHeadroom >= 0;
  const referenceAmount = hasHeadroom
    ? calculation.addLongAllowed
    : calculation.longTrimNeeded;
  const commodityAdjustment = Number(
    calculation?.adjustmentForSecuritiesDeficit || 0,
  );
  const commodityCashExcluded = Number(
    calculation?.commodityCashExcluded || 0,
  );

  return (
    <div
      className="pf-cash-guard__reference"
      data-testid="cash-debit-reference"
    >
      <div
        className="pf-cash-guard__reference-summary"
        data-testid="cash-debit-guard-hero"
      >
        <span className="pf-cash-guard__reference-label">
          {hasHeadroom
            ? 'Estimated long headroom'
            : 'Estimated long reduction'}
        </span>
        <strong
          className={`pf-cash-guard__reference-value ${
            hasHeadroom
              ? 'pf-cash-guard__reference-value--headroom'
              : 'pf-cash-guard__reference-value--trim'
          }`}
        >
          {formatCurrency(referenceAmount, currency)}
        </strong>
      </div>

      <dl
        className="pf-cash-guard__reference-ledger"
        aria-label="Historical cash debit calculation"
      >
        <div className="pf-cash-guard__reference-row">
          <dt>
            Securities cash floor · {formatSettlementDate(
              calculation.worstSettlementDate,
            )}
          </dt>
          <dd>
            {formatSignedCurrency(calculation.securitiesCashFloor, currency)}
          </dd>
        </div>
        <div className="pf-cash-guard__reference-row">
          <dt>Less: required short collateral</dt>
          <dd>
            {formatSignedCurrency(
              -Math.abs(calculation.shortCollateral),
              currency,
            )}
          </dd>
        </div>
        <div className="pf-cash-guard__reference-row pf-cash-guard__reference-row--subtotal">
          <dt>Cash after short collateral</dt>
          <dd>
            {formatSignedCurrency(calculation.brokerAdjustedCash, currency)}
          </dd>
        </div>
        <div className="pf-cash-guard__reference-row">
          <dt>
            <span>Less: 5% safety buffer</span>
            <small>
              {formatCurrency(calculation.policyBuffer.base, currency)}
              {' minimum + '}
              {formatCurrency(
                calculation.policyBuffer.shortShock,
                currency,
              )}
              {' short stress'}
            </small>
          </dt>
          <dd>
            {formatSignedCurrency(
              -Math.abs(calculation.policyBuffer.total),
              currency,
            )}
          </dd>
        </div>
        {calculation.negativeAccruedCashReserve > 0 && (
          <div className="pf-cash-guard__reference-row">
            <dt>
              {calculation.interestReserve?.incrementalModelReserve > 0
                ? 'Less: cash-interest reserve'
                : 'Less: accrued-cash reserve'}
            </dt>
            <dd>
              {formatSignedCurrency(
                -calculation.negativeAccruedCashReserve,
                currency,
              )}
            </dd>
          </div>
        )}
      </dl>

      <div
        className="pf-cash-guard__reference-details"
        aria-label="Additional calculation details"
      >
        <div className="pf-cash-guard__reference-secondary">
          <div>
            <span>Long exposure at close</span>
            <strong>{formatCurrency(calculation.longMV, currency)}</strong>
          </div>
          <div>
            <span>
              {commodityAdjustment > 0
                ? 'Commodity cash applied'
                : 'Commodity cash excluded'}
            </span>
            <strong>
              {formatCurrency(
                commodityAdjustment > 0
                  ? commodityAdjustment
                  : commodityCashExcluded,
                currency,
              )}
            </strong>
          </div>
        </div>
      </div>
    </div>
  );
}

function CashDebitGuardCard({ guard, selectedAccount, onRefresh }) {
  const [action, setAction] = useState('add_long');
  const [longAmount, setLongAmount] = useState('');
  const [shortShares, setShortShares] = useState('');
  const [shortConId, setShortConId] = useState('');
  const [shortLimitPrice, setShortLimitPrice] = useState('');
  const [shortShockPercent, setShortShockPercent] = useState('5');
  const [consumedSnapshotKey, setConsumedSnapshotKey] = useState(null);
  const [lockedEstimate, setLockedEstimate] = useState(null);
  const [estimateRefreshing, setEstimateRefreshing] = useState(false);
  const isAddShort = action === 'add_short';
  const isShortAction = isAddShort || action === 'cover_short';
  const funding = guard?.funding;
  const referenceFunding = guard?.referenceFunding;
  const snapshotKey = guard?.available === true
    ? [
      selectedAccount,
      funding?.observedAt,
      funding?.accountValuesObservedAt,
      funding?.socketVerifiedAt,
    ].join('|')
    : null;
  const shortShockPercentNumber = Number(shortShockPercent);
  const shortShockInputValid =
    Number.isFinite(shortShockPercentNumber) &&
    shortShockPercentNumber >= 5 &&
    shortShockPercentNumber <= 200;
  const calculation = useMemo(() => {
    if (
      guard?.available !== true ||
      !funding ||
      !shortShockInputValid
    ) {
      return guard?.calculation;
    }
    return calculateIbkrCashBorrowing({
      ...funding,
      policyShortAdverseMoveRate: shortShockPercentNumber / 100,
    });
  }, [
    funding,
    guard?.available,
    guard?.calculation,
    shortShockInputValid,
    shortShockPercentNumber,
  ]);
  const snapshotConsumed =
    Boolean(snapshotKey) && (
      consumedSnapshotKey === snapshotKey ||
      consumedCashGuardSnapshots.has(snapshotKey)
    );
  const activeLockedEstimate =
    guard?.available === true &&
    Boolean(snapshotKey) &&
    lockedEstimate?.snapshotKey === snapshotKey
      ? lockedEstimate
      : null;

  useEffect(() => {
    if (consumedSnapshotKey && consumedSnapshotKey !== snapshotKey) {
      setConsumedSnapshotKey(null);
    }
    if (
      lockedEstimate &&
      (
        guard?.available !== true ||
        lockedEstimate.snapshotKey !== snapshotKey
      )
    ) {
      setLockedEstimate(null);
      setEstimateRefreshing(false);
    }
  }, [
    consumedSnapshotKey,
    guard?.available,
    lockedEstimate,
    snapshotKey,
  ]);

  const currency = calculation?.currency || 'USD';
  const verifiedShortPositions = useMemo(() => {
    const positions = Array.isArray(calculation?.collateralBreakdown?.positions)
      ? calculation.collateralBreakdown.positions
      : [];
    const counts = positions.reduce((accumulator, position) => {
      const conId = String(position?.conId || '').trim();
      if (conId) {
        accumulator.set(conId, (accumulator.get(conId) || 0) + 1);
      }
      return accumulator;
    }, new Map());

    return positions.filter((position) => {
      const conId = String(position?.conId || '').trim();
      return conId && counts.get(conId) === 1;
    });
  }, [calculation]);

  const projectionState = useMemo(() => {
    if (guard?.available !== true || !calculation) {
      return { kind: 'hidden', projection: null };
    }

    if (!isShortAction) {
      if (String(longAmount || '').trim() === '') {
        return { kind: 'empty', projection: null };
      }
      const amount = positiveInputNumber(longAmount);
      if (amount == null) {
        return {
          kind: 'invalid',
          projection: { available: false, reason: 'invalid_long_notional' },
        };
      }
      return {
        kind: 'ready',
        projection: calculation.projectScenario({ type: action, amount }),
      };
    }

    if (verifiedShortPositions.length === 0) {
      return {
        kind: 'invalid',
        projection: {
          available: false,
          reason: 'short_trade_identity_unavailable',
        },
      };
    }
    if (
      String(shortConId || '').trim() === '' &&
      String(shortShares || '').trim() === '' &&
      String(shortLimitPrice || '').trim() === ''
    ) {
      return { kind: 'empty', projection: null };
    }
    if (String(shortConId || '').trim() === '') {
      return {
        kind: 'invalid',
        projection: {
          available: false,
          reason: 'short_trade_requires_verified_conid',
        },
      };
    }
    const quantity = positiveInputNumber(shortShares);
    if (quantity == null) {
      return {
        kind: 'invalid',
        projection: {
          available: false,
          reason: 'short_trade_requires_quantity',
        },
      };
    }
    const limitPrice = positiveInputNumber(shortLimitPrice);
    if (limitPrice == null) {
      return {
        kind: 'invalid',
        projection: {
          available: false,
          reason: 'short_trade_requires_limit_price',
        },
      };
    }
    return {
      kind: 'ready',
      projection: calculation.projectScenario({
        type: action,
        conId: shortConId,
        quantity,
        limitPrice,
      }),
    };
  }, [
    action,
    calculation,
    guard?.available,
    isShortAction,
    longAmount,
    shortConId,
    shortLimitPrice,
    shortShares,
    verifiedShortPositions,
  ]);

  const projection = projectionState.projection;
  const projectionAvailable = projection?.available === true;
  const canLockEstimate =
    guard?.available === true &&
    calculation?.available === true &&
    Boolean(snapshotKey) &&
    !snapshotConsumed &&
    shortShockInputValid &&
    (
      isShortAction
        ? projectionAvailable
        : projectionState.kind === 'empty' || projectionAvailable
    );
  const lockEstimate = () => {
    if (!canLockEstimate) return;
    consumeCashGuardSnapshot(snapshotKey);
    setConsumedSnapshotKey(snapshotKey);
    setLockedEstimate({
      snapshotKey,
      action,
      calculation,
      funding,
      isShortAction,
      projection: projectionAvailable ? projection : null,
    });
  };
  const refreshEstimate = async () => {
    setLockedEstimate(null);
    setEstimateRefreshing(true);
    try {
      await onRefresh?.();
    } finally {
      setEstimateRefreshing(false);
    }
  };
  const displayedCalculation = activeLockedEstimate?.calculation || calculation;
  const displayedFunding = activeLockedEstimate?.funding || funding;
  const displayedProjection = activeLockedEstimate?.projection || null;
  const nlv = Number(displayedFunding?.netLiquidation);
  const commodityAdjustment = Number(
    displayedCalculation?.adjustmentForSecuritiesDeficit || 0,
  );
  const commodityCashExcluded = Number(
    displayedCalculation?.commodityCashExcluded || 0,
  );
  const tone = guard?.referenceAvailable === true
    ? 'reference'
    : guard?.available
      ? displayedCalculation?.guardedHeadroom >= 0
        ? 'safe'
        : 'trim'
      : 'unavailable';

  return (
    <section
      className={`pf-cash-guard pf-cash-guard--${tone}`}
      aria-label="Cash debit guard"
      data-testid="cash-debit-guard"
      data-status={guard?.viewStatus || 'unavailable'}
    >
      <header className="pf-cash-guard__header">
        <h2 className="pf-cash-guard__title">Cash debit guard</h2>
        <span className={`pf-cash-guard__status pf-cash-guard__status--${guard?.viewStatus || 'unavailable'}`}>
          {guard?.viewStatus === 'live'
            ? activeLockedEstimate
              ? `One use · ${formatLiveFundingTime(displayedFunding?.observedAt)}`
              : snapshotConsumed
                ? 'Refresh required'
                : `Ready · ${formatLiveFundingTime(funding?.observedAt)}`
            : guard?.viewStatus === 'reference'
              ? `Historical · ${formatReferenceDate(
                referenceFunding?.referenceSessionDate,
                { weekday: true },
              )}`
            : guard?.viewStatus === 'refreshing'
              ? 'Refreshing'
              : 'Unavailable'}
        </span>
      </header>

      {guard?.referenceAvailable === true ? (
        <CashDebitReferenceContent
          calculation={guard.calculation}
        />
      ) : guard?.available !== true ? (
        <div className="pf-cash-guard__unavailable" role="status" aria-live="polite">
          <strong>
            {guard?.viewStatus === 'refreshing' ? 'Refreshing' : 'Unavailable'}
          </strong>
          <span>{cashGuardReasonText(guard?.reason)}</span>
        </div>
      ) : (
        <>
          {activeLockedEstimate && (
            <>
              <p
                className={`pf-cash-guard__hero pf-cash-guard__hero--${tone}`}
                data-testid="cash-debit-guard-hero"
              >
                <span>
                  {displayedCalculation.guardedHeadroom >= 0
                    ? 'BUFFERED MAX ESTIMATE'
                    : 'BUFFERED TRIM ESTIMATE'}
                </span>
                {' '}
                <strong>
                  {formatCurrency(
                    displayedCalculation.guardedHeadroom >= 0
                      ? displayedCalculation.addLongAllowed
                      : displayedCalculation.longTrimNeeded,
                    currency,
                  )}
                </strong>
                {' '}
                <span>LONGS AFTER SETTLEMENT</span>
              </p>

              <div className="pf-cash-guard__metrics">
                <div className="pf-cash-guard__metric">
                  <span title={`Worst securities settlement balance on ${formatSettlementDate(displayedCalculation.worstSettlementDate)}`}>
                    Securities settled cash · {formatSettlementDate(displayedCalculation.worstSettlementDate)}
                  </span>
                  <strong>{formatSignedCurrency(displayedCalculation.securitiesCashFloor, currency)}</strong>
                </div>
                <div className="pf-cash-guard__metric">
                  <span>Short collateral</span>
                  <strong>{formatCurrency(displayedCalculation.shortCollateral, currency)}</strong>
                </div>
                <div className="pf-cash-guard__metric">
                  <span>IBKR adjusted cash</span>
                  <strong>{formatSignedCurrency(displayedCalculation.brokerAdjustedCash, currency)}</strong>
                </div>
                <div className="pf-cash-guard__metric">
                  <span>Policy buffer</span>
                  <strong>{formatCurrency(displayedCalculation.policyBuffer.total, currency)}</strong>
                  <small>
                    {formatCurrency(displayedCalculation.policyBuffer.base, currency)} base
                    {' + '}
                    {formatCurrency(displayedCalculation.policyBuffer.shortShock, currency)} short shock
                  </small>
                </div>
                <div className="pf-cash-guard__metric">
                  <span>Current long</span>
                  <strong>{formatCurrency(displayedCalculation.longMV, currency)}</strong>
                </div>
                <div className="pf-cash-guard__metric">
                  <span>
                    {commodityAdjustment > 0
                      ? 'Commodity transfer applied'
                      : 'Commodities cash excluded'}
                  </span>
                  <strong>
                    {formatCurrency(
                      commodityAdjustment > 0
                        ? commodityAdjustment
                        : commodityCashExcluded,
                      currency,
                    )}
                  </strong>
                </div>
              </div>

              {displayedCalculation.negativeAccruedCashReserve > 0 && (
                <div className="pf-cash-guard__accrued">
                  <span>
                    {displayedCalculation.interestReserve?.incrementalModelReserve > 0
                      ? 'Cash-interest reserve'
                      : 'Negative accrued cash'}
                  </span>
                  <strong>
                    {formatSignedCurrency(
                      -displayedCalculation.negativeAccruedCashReserve,
                      currency,
                    )}
                  </strong>
                </div>
              )}
            </>
          )}

          {!activeLockedEstimate && !snapshotConsumed && (
            <p className="pf-cash-guard__one-use-intro">
              Set the trade and short-shock buffer, then lock one estimate.
              Actionable numbers stay hidden until the snapshot is consumed.
            </p>
          )}

          {snapshotConsumed && !activeLockedEstimate ? (
            <div className="pf-cash-guard__consumed" role="status">
              <strong>Snapshot consumed</strong>
              <span>
                Refresh after any order or fill before sizing another trade.
              </span>
              <button
                type="button"
                onClick={refreshEstimate}
                disabled={estimateRefreshing}
              >
                {estimateRefreshing ? 'Refreshing…' : 'Refresh for another estimate'}
              </button>
            </div>
          ) : (
          <div className="pf-cash-guard__scenario" aria-label="Planned trade calculator">
            <div
              className={`pf-cash-guard__scenario-row${
                isShortAction ? ' pf-cash-guard__scenario-row--cover' : ''
              }`}
            >
              <label className="pf-cash-guard__field pf-cash-guard__field--action">
                <span>Planned trade</span>
                <select
                  aria-label="Planned trade action"
                  value={action}
                  onChange={(event) => setAction(event.target.value)}
                  disabled={Boolean(activeLockedEstimate)}
                >
                  <option value="add_long">Add long</option>
                  <option value="trim_long">Trim long</option>
                  <option value="add_short">Add to short</option>
                  <option value="cover_short">Cover short</option>
                </select>
              </label>

              {!isShortAction ? (
                <label className="pf-cash-guard__field">
                  <span>Dollars</span>
                  <input
                    aria-label="Planned long dollars"
                    inputMode="decimal"
                    min="0"
                    step="100"
                    type="number"
                    value={longAmount}
                    onChange={(event) => setLongAmount(event.target.value)}
                    placeholder="0"
                    disabled={Boolean(activeLockedEstimate)}
                  />
                </label>
              ) : (
                <>
                  <label className="pf-cash-guard__field">
                    <span>Verified short</span>
                    <select
                      aria-label="Verified short position"
                      value={shortConId}
                      onChange={(event) => setShortConId(event.target.value)}
                      disabled={
                        Boolean(activeLockedEstimate) ||
                        verifiedShortPositions.length === 0
                      }
                    >
                      <option value="">
                        {verifiedShortPositions.length > 0
                          ? 'Select position'
                          : 'No unique live short'}
                      </option>
                      {verifiedShortPositions.map((position) => (
                        <option key={position.conId} value={position.conId}>
                          {position.symbol || 'Short'} · {position.conId} ·{' '}
                          {formatShareQuantity(position.quantity)} sh
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="pf-cash-guard__field">
                    <span>Shares</span>
                    <input
                      aria-label={
                        isAddShort
                          ? 'Planned add-to-short shares'
                          : 'Planned cover shares'
                      }
                      inputMode="decimal"
                      min="0"
                      step="any"
                      type="number"
                      value={shortShares}
                      onChange={(event) => setShortShares(event.target.value)}
                      placeholder="0"
                      disabled={Boolean(activeLockedEstimate)}
                    />
                  </label>
                  <label className="pf-cash-guard__field">
                    <span>Limit price</span>
                    <input
                      aria-label="Limit price"
                      inputMode="decimal"
                      min="0.00000001"
                      required
                      step="any"
                      type="number"
                      value={shortLimitPrice}
                      onChange={(event) => setShortLimitPrice(event.target.value)}
                      placeholder="0.00"
                      disabled={Boolean(activeLockedEstimate)}
                    />
                  </label>
                </>
              )}
            </div>

            <div className="pf-cash-guard__lock-row">
              <label className="pf-cash-guard__field pf-cash-guard__field--shock">
                <span>Adverse short move buffer</span>
                <span className="pf-cash-guard__percent-input">
                  <input
                    aria-label="Adverse short move buffer percent"
                    inputMode="decimal"
                    min="5"
                    max="200"
                    step="1"
                    type="number"
                    value={shortShockPercent}
                    onChange={(event) => setShortShockPercent(event.target.value)}
                    disabled={Boolean(activeLockedEstimate)}
                  />
                  <span>%</span>
                </span>
              </label>
              {!activeLockedEstimate && (
                <button
                  type="button"
                  className="pf-cash-guard__lock-button"
                  onClick={lockEstimate}
                  disabled={!canLockEstimate}
                >
                  Lock one-use estimate
                </button>
              )}
            </div>

            {!shortShockInputValid && !activeLockedEstimate ? (
              <p className="pf-cash-guard__scenario-error" role="status">
                Enter a short-move buffer from 5% to 200%.
              </p>
            ) : activeLockedEstimate && displayedProjection ? (
              <div
                className={`pf-cash-guard__projection${displayedProjection.guardedHeadroom < 0 ? ' pf-cash-guard__projection--trim' : ''}`}
                data-testid="cash-debit-projection"
                aria-live="polite"
              >
                <div>
                  <span>
                    {activeLockedEstimate.isShortAction
                      ? 'Buffered headroom if limit fills'
                      : 'Buffered headroom after settlement'}
                  </span>
                  <strong>
                    {formatSignedCurrency(
                      displayedProjection.guardedHeadroom,
                      currency,
                    )}
                  </strong>
                </div>
                <div>
                  <span>Gross</span>
                  <strong>
                    {formatProjectedExposure(
                      displayedProjection.grossMV,
                      nlv,
                      currency,
                    )}
                  </strong>
                </div>
                <div>
                  <span>Net</span>
                  <strong>
                    {formatProjectedExposure(
                      displayedProjection.netMV,
                      nlv,
                      currency,
                      { signed: true },
                    )}
                  </strong>
                </div>
              </div>
            ) : activeLockedEstimate ? (
              <p className="pf-cash-guard__scenario-hint">
                The one-use maximum estimate is locked above.
              </p>
            ) : projectionState.kind === 'empty' ? (
              <p className="pf-cash-guard__scenario-hint">
                Leave dollars blank to lock the current maximum, or enter one
                planned trade.
              </p>
            ) : projectionAvailable ? (
              <p className="pf-cash-guard__scenario-hint">
                Trade inputs are valid. Lock to reveal one actionable estimate.
              </p>
            ) : (
              <p className="pf-cash-guard__scenario-error" role="status">
                {scenarioReasonText(projection?.reason)}
              </p>
            )}

            {activeLockedEstimate && (
              <div className="pf-cash-guard__one-use-warning" role="status">
                <strong>One use only</strong>
                <span>
                  This snapshot is consumed. Do not reuse this number for a
                  second order; refresh after any order or fill.
                </span>
                <button
                  type="button"
                  onClick={refreshEstimate}
                  disabled={estimateRefreshing}
                >
                  {estimateRefreshing ? 'Refreshing…' : 'Refresh for another estimate'}
                </button>
              </div>
            )}
          </div>
          )}

          <p className="pf-cash-guard__disclaimer">
            This is a buffered live policy estimate, not a zero-debit guarantee.
            A short move beyond the selected buffer, a journal/transfer, or an
            account change before settlement can still create a debit. Use one
            locked estimate for one order only.
            {' '}
            Short projections apply only to a limit order at the entered price or
            better, submitted immediately against this live snapshot. Add-to-short
            sell limits must be at or below the displayed live bid, and cover buy
            limits must be at or above the displayed live ask. Cancel and refresh if
            the order does not fill promptly. Market-order short sizing is unsupported.
            Short changes remain bound to one verified live position,
            and this calculator does not size a new short name. Stock-borrow fees and
            payments in lieu of dividends are separate. Selling longs may not stop
            today&apos;s interest immediately; trim figures are post-settlement.
          </p>
          <span className="sr-only">Selected account {selectedAccount}</span>
        </>
      )}
    </section>
  );
}

function getFeedTokenTone(value) {
  const normalized = String(value || '').trim().toUpperCase();
  if (normalized === 'BULLISH' || normalized === 'LONG') return 'positive';
  if (normalized === 'BEARISH' || normalized === 'SHORT') return 'negative';
  return 'neutral';
}

function FeedStatusToken({ children }) {
  return (
    <span className={`pf-update__status-token pf-update__status-token--${getFeedTokenTone(children)}`}>
      {String(children || '').toUpperCase()}
    </span>
  );
}

function FeedArrow() {
  return (
    <ArrowRight className="pf-update__arrow-icon" size={13} strokeWidth={1.9} aria-hidden="true" />
  );
}

function FeedAction({ item }) {
  if (item.trendFrom && item.trendTo) {
    return (
      <span className="pf-update__action" aria-label={`${item.trendFrom} to ${item.trendTo}`}>
        <FeedStatusToken>{item.trendFrom}</FeedStatusToken>
        <FeedArrow />
        <FeedStatusToken>{item.trendTo}</FeedStatusToken>
      </span>
    );
  }

  const displayAction = String(item.displayAction || '').trim();
  const transitionMatch = displayAction.match(/^(.+?)\s*->\s*(.+)$/);
  if (transitionMatch) {
    return (
      <span className="pf-update__action">
        <FeedStatusToken>{transitionMatch[1]}</FeedStatusToken>
        <FeedArrow />
        <FeedStatusToken>{transitionMatch[2]}</FeedStatusToken>
      </span>
    );
  }

  const addedMatch = displayAction.match(/^(Added to|Doubling)\s+(.+)$/i);
  if (addedMatch) {
    return (
      <span className="pf-update__action">
        <span>{addedMatch[1]}</span>
        <FeedStatusToken>{addedMatch[2]}</FeedStatusToken>
      </span>
    );
  }

  return <span className="pf-update__action">{displayAction.toUpperCase()}</span>;
}

function LatestUpdatesFeed({ changelog, loading = false, error = null, now, lastSuccessAt }) {
  const items = useMemo(() => buildHedgeyeLatestUpdatesFeed(changelog, { now }), [changelog, now]);
  const feedStatus = useMemo(
    () => buildHedgeyeLatestUpdatesStatus(changelog, { loading, error, now, lastSuccessAt }),
    [changelog, error, lastSuccessAt, loading, now],
  );
  const hasItems = items.length > 0;

  return (
    <section className="pf-updates" aria-label="Latest Hedgeye updates">
      <header className="pf-updates__header">
        <h2 className="pf-updates__title">FEED</h2>
        <StatusDot
          updatedAt={feedStatus.updatedAt}
          status={feedStatus.status}
          emoji={feedStatus.emoji}
          size={8}
          label={feedStatus.label}
          overallLabel={feedStatus.overallLabel}
          sources={feedStatus.sources}
          align="right"
          placement="side"
        />
      </header>
      <div className="pf-updates__body">
        {loading && !hasItems ? (
          <div className="pf-updates__state">
            <LoadingIndicator label="Loading updates…" size="sm" />
          </div>
        ) : error && !hasItems ? (
          <div className="pf-updates__state pf-updates__state--error">
            Unable to load latest updates.
          </div>
        ) : !hasItems ? (
          <div className="pf-updates__state">
            No latest updates available.
          </div>
        ) : (
          <div className="pf-updates__list" role="list">
            {items.map((item) => (
              <article className={`pf-update${item.trendFrom && item.trendTo ? ' pf-update--trend' : ''}`} role="listitem" key={item.id}>
                <div className="pf-update__topline">
                  <span className="pf-update__ticker">{item.ticker}</span>
                  <FeedAction item={item} />
                  <span className="pf-update__source" data-testid={`latest-update-source-${item.ticker}`}>
                    {item.source}
                  </span>
                </div>
                <p className="pf-update__description">{item.description}</p>
                <time className="pf-update__time" dateTime={item.eventTime || item.currentDate || undefined}>
                  {formatHedgeyeFeedTime(item, now)}
                </time>
              </article>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function formatBaselineDate(value) {
  if (!value) return null;
  const dateOnly = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) {
    const [, year, month, day] = dateOnly;
    const date = new Date(Number(year), Number(month) - 1, Number(day));
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatFlexAmount(value, currency = 'USD') {
  if (value == null || !Number.isFinite(Number(value))) return '--';
  return formatCurrency(Number(value), currency);
}

function FlexMetric({ label, value, tone = 'neutral' }) {
  return (
    <div className="pf-flex-recon__metric">
      <span className="pf-flex-recon__metric-label">{label}</span>
      <span className={`pf-flex-recon__metric-value pf-flex-recon__metric-value--${tone}`}>
        {value}
      </span>
    </div>
  );
}

function FlexReconciliationPanel({
  liveExposure,
  currency = 'USD',
  reconciliation = null,
  loading = false,
}) {
  const flex = reconciliation?.flex || null;
  const flexExposure = flex?.exposure || null;
  const hasReadyFlex = reconciliation?.status === 'ready' && flexExposure?.hasData;
  const latestDate = formatBaselineDate(reconciliation?.latestSnapshot?.date);

  if (loading && !reconciliation) {
    return (
      <div className="pf-flex-recon pf-flex-recon--state">
        <LoadingIndicator label="Loading Flex baseline..." size="sm" />
      </div>
    );
  }

  if (!hasReadyFlex) {
    const status = reconciliation?.status || 'missing';
    const message = status === 'disabled'
      ? 'Flex baseline disabled'
      : status === 'error'
        ? 'Flex baseline unavailable'
        : 'Flex baseline missing';
    const detail = reconciliation?.error
      || (latestDate ? `Latest saved baseline: ${latestDate}` : 'Run an IBKR Flex sync after the Activity Flex Query is configured.');

    return (
      <div className="pf-flex-recon pf-flex-recon--state">
        <div className="pf-flex-recon__header">
          <span className="pf-flex-recon__title">Flex baseline</span>
          <span className="pf-flex-recon__status pf-flex-recon__status--muted">{message}</span>
        </div>
        <p className="pf-flex-recon__state">{detail}</p>
      </div>
    );
  }

  const baselineDate = formatBaselineDate(flex.reportDate || flex.date);
  const mismatchRows = [
    ['Long', liveExposure?.longPct, flexExposure.longPct],
    ['Short', liveExposure?.shortPct, flexExposure.shortPct],
    ['Gross', liveExposure?.grossPct, flexExposure.grossPct],
    ['Net', liveExposure?.netPct, flexExposure.netPct],
    ['Cash', liveExposure?.cashPct, flexExposure.cashPct],
  ].filter(([, liveValue, flexValue]) => (
    Number.isFinite(Number(liveValue)) &&
    Number.isFinite(Number(flexValue)) &&
    Math.abs(Number(liveValue) - Number(flexValue)) >= FLEX_RECONCILIATION_TOLERANCE_PCT
  ));

  const fundingGap = Number(flexExposure.longFundingGap || 0);
  const cashSurplus = Number(flexExposure.equityCashSurplus || 0);

  return (
    <div className="pf-flex-recon">
      <div className="pf-flex-recon__header">
        <span className="pf-flex-recon__title">Flex baseline</span>
        <span className="pf-flex-recon__status">
          {baselineDate || 'Saved report'}
        </span>
      </div>
      <div className="pf-flex-recon__grid">
        <FlexMetric
          label="Cash surplus after longs"
          value={formatFlexAmount(cashSurplus, flex.currency || currency)}
          tone={cashSurplus >= 0 ? 'positive' : 'negative'}
        />
        <FlexMetric
          label="Long funding gap"
          value={formatFlexAmount(fundingGap, flex.currency || currency)}
          tone={fundingGap > 0 ? 'negative' : 'positive'}
        />
        <FlexMetric
          label="Long baseline"
          value={`${formatExposurePct(flexExposure.longPct)} (${formatFlexAmount(flexExposure.longMV, flex.currency || currency)})`}
          tone={flexExposure.longPct > 100 ? 'warning' : 'neutral'}
        />
        <FlexMetric
          label="Short baseline"
          value={`${formatExposurePct(flexExposure.shortPct)} (${formatFlexAmount(flexExposure.shortMV, flex.currency || currency)})`}
          tone="neutral"
        />
      </div>
      {mismatchRows.length > 0 && (
        <p className="pf-flex-recon__warning">
          Live vs Flex differs: {mismatchRows.map(([label, liveValue, flexValue]) => {
            const diff = Number(liveValue) - Number(flexValue);
            return `${label} ${diff > 0 ? '+' : ''}${diff.toFixed(1)} pts`;
          }).join(', ')}
        </p>
      )}
    </div>
  );
}

const KNOWN_ACCOUNT_IDS = Object.keys(IBKR_ACCOUNT_LABELS);

function resolvePositionSideCounts(portfolioData) {
  const holdings = Array.isArray(portfolioData?.holdings) ? portfolioData.holdings : [];
  const { longCount, shortCount } = getLongShortPositionSnapshot(holdings);
  return { longCount, shortCount };
}

function normalizePositionCount(value) {
  if (value === null || value === undefined || value === '') return null;
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? Math.trunc(count) : null;
}

function getReferenceDataQuality(snapshot) {
  return snapshot?.dataQuality || snapshot?.meta?.dataQuality || null;
}

function isCleanReferenceComparison(snapshot, { requireAvailable = false } = {}) {
  if (!snapshot || snapshot?._cache?.stale === true) return false;
  if (snapshot?.comparisonAvailable === false || snapshot?.available === false) return false;
  if (requireAvailable && snapshot?.available !== true) return false;
  return isExplicitlySafeResearchComparison(snapshot)
    && getReferenceDataQuality(snapshot)?.status === 'ok';
}

function countEtfProPositionSides(snapshot) {
  const explicitLongCount = normalizePositionCount(snapshot?.longCount);
  const explicitShortCount = normalizePositionCount(snapshot?.shortCount);
  if (explicitLongCount !== null && explicitShortCount !== null) {
    return { longCount: explicitLongCount, shortCount: explicitShortCount, hasCounts: true };
  }

  const rows = Array.isArray(snapshot?.rows) ? snapshot.rows : [];
  if (rows.length === 0) {
    return { longCount: null, shortCount: null, hasCounts: false };
  }

  const longs = new Set();
  const shorts = new Set();
  rows.forEach((row, index) => {
    const ticker = String(row?.ticker || row?.symbol || '').trim().toUpperCase();
    const key = ticker || `__row_${index}`;
    if (String(row?.call || row?.side || '').toLowerCase() === 'short') {
      shorts.add(key);
    } else {
      longs.add(key);
    }
  });
  return { longCount: longs.size, shortCount: shorts.size, hasCounts: true };
}

const PortfolioSidebarSnapshot = ({
  portfolioData,
  portfolioAccountsData = [],
  rtaPositions,
  etfProSnapshot,
  exposureReconciliation,
  exposureReconciliationLoading = false,
  interestValidation,
  interestValidationLoading = false,
  hedgeyeChangelog,
  hedgeyeChangelogLoading = false,
  hedgeyeChangelogError = null,
  hedgeyeChangelogLastSuccessAt = null,
  loading = false,
  refreshing = false,
  accounts = [],
  connection = null,
  predictionMarketProviderStatus = null,
  selectedAccount,
  onAccountChange,
  onRefresh,
  expandedUp = false,
  onToggleExpandUp,
}) => {
  const [sessionClock, setSessionClock] = useState(() => Date.now());
  const [cachedCloseSnapshot, setCachedCloseSnapshot] = useState(null);

  useEffect(() => {
    const interval = window.setInterval(() => setSessionClock(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!selectedAccount || typeof window === 'undefined') {
      setCachedCloseSnapshot(null);
      return;
    }

    try {
      const raw = window.localStorage.getItem(`${PORTFOLIO_CLOSE_CACHE_PREFIX}${selectedAccount}`);
      setCachedCloseSnapshot(raw ? JSON.parse(raw) : null);
    } catch {
      setCachedCloseSnapshot(null);
    }
  }, [selectedAccount]);

  // Persist accounts to localStorage when they come from API
  useEffect(() => {
    if (Array.isArray(accounts) && accounts.length > 0) {
      saveIbkrAccounts(accounts);
    }
  }, [accounts]);

  const portfolioVerifiedAt =
    portfolioData?.socketVerifiedAt ||
    portfolioData?.dataQuality?.fetchedAt ||
    portfolioData?.funding?.observedAt ||
    portfolioData?.accountSummary?.lastUpdated ||
    null;
  const isPortfolioLive =
    portfolioData?.dataSource === 'ibkr_api'
    && portfolioData?.liveSessionVerified === true
    && portfolioData?.fromCache !== true
    && portfolioData?._cache?.stale !== true
    && getIbkrPortfolioFreshness(portfolioVerifiedAt, sessionClock) === 'current';
  const isSyncPending = isPortfolioSyncPending({ connection, portfolioData });
  const showPortfolioContent = isPortfolioLive || isSyncPending;
  const refreshActive = loading || refreshing;
  const retainingVerifiedSnapshot = refreshing && isPortfolioLive;

  const exposure = computePortfolioExposure({
    holdings: portfolioData?.holdings || [],
    accountSummary: portfolioData?.accountSummary,
    summary: portfolioData?.summary,
  });
  const currency = portfolioData?.accountSummary?.currency || 'USD';
  const cashDebitGuard = useMemo(
    () => resolveCashDebitGuard({
      portfolioData,
      selectedAccount,
      connection,
      interestValidation,
      refreshing: loading || refreshing,
      now: sessionClock,
    }),
    [
      connection,
      loading,
      interestValidation,
      portfolioData,
      refreshing,
      selectedAccount,
      sessionClock,
    ],
  );
  const displayExposure = useMemo(() => {
    if (cashDebitGuard.available !== true) {
      const reportedMissingMarks = Number(
        portfolioData?.dataQuality?.missingMarketValueCount,
      );
      const hasMissingDirectMarks =
        (Number.isFinite(reportedMissingMarks) && reportedMissingMarks > 0) ||
        (Array.isArray(portfolioData?.holdings) &&
          portfolioData.holdings.some((holding) => {
            const quantity = Number(holding?.quantity);
            const directMarketValue = holding?.marketValue;
            return (
              Number.isFinite(quantity) &&
              quantity !== 0 &&
              (directMarketValue == null ||
                directMarketValue === '' ||
                !Number.isFinite(Number(directMarketValue)))
            );
          }));

      if (!hasMissingDirectMarks) return exposure;
      return {
        ...exposure,
        longMV: null,
        shortMV: null,
        netMV: null,
        grossPct: null,
        netPct: null,
        longPct: null,
        shortPct: null,
        hasData: false,
      };
    }
    const calculation = cashDebitGuard.calculation;
    const nlv = Number(cashDebitGuard.funding?.netLiquidation);
    if (!Number.isFinite(nlv) || nlv <= 0) return exposure;

    return {
      ...exposure,
      nlv,
      longMV: calculation.longMV,
      shortMV: calculation.shortMV,
      netMV: calculation.netMV,
      longPct: (calculation.longMV / nlv) * 100,
      shortPct: (calculation.shortMV / nlv) * 100,
      grossPct: (calculation.grossMV / nlv) * 100,
      netPct: (calculation.netMV / nlv) * 100,
      hasData: true,
    };
  }, [cashDebitGuard, exposure, portfolioData]);
  const sidebarBanner = getPortfolioSidebarBanner({ portfolioData, selectedAccount });
  const showMetrics =
    showPortfolioContent && exposure.nlv != null && Number.isFinite(exposure.nlv);

  const accountOptions = useMemo(() => {
    // Merge: API accounts + localStorage accounts + known account IDs
    const apiIds = Array.isArray(accounts) ? accounts : [];
    const savedIds = loadIbkrAccounts();
    const allIds = new Set([...KNOWN_ACCOUNT_IDS, ...savedIds, ...apiIds]);
    const ids = Array.from(allIds);
    // Ensure selected account is in the list
    if (selectedAccount && !ids.includes(selectedAccount)) {
      ids.unshift(selectedAccount);
    }
    return ids;
  }, [accounts, selectedAccount]);

  const accountSnapshotsById = useMemo(() => {
    const entries = Array.isArray(portfolioAccountsData) ? portfolioAccountsData : [];
    return entries.reduce((acc, entry) => {
      if (entry?.accountId) {
        acc[entry.accountId] = entry;
      }
      return acc;
    }, {});
  }, [portfolioAccountsData]);

  const statusDot = useMemo(
    () => getIbkrPortfolioStatusDot({
      connection,
      portfolioData,
      loading,
      rtaPositions,
      etfProSnapshot,
      predictionMarketProviderStatus,
      interestValidation,
      interestValidationLoading,
      selectedAccount,
      now: sessionClock,
    }),
    [
      connection,
      etfProSnapshot,
      interestValidation,
      interestValidationLoading,
      loading,
      portfolioData,
      predictionMarketProviderStatus,
      rtaPositions,
      selectedAccount,
      sessionClock,
    ],
  );

  const offlinePanel = useMemo(
    () => getPortfolioOfflinePanel({ connection, portfolioData }),
    [connection, portfolioData],
  );
  const { longCount: liveLongCount, shortCount: liveShortCount } = useMemo(
    () => resolvePositionSideCounts(portfolioData),
    [portfolioData],
  );
  const rawRtaLongCount = normalizePositionCount(rtaPositions?.longCount);
  const rawRtaShortCount = normalizePositionCount(rtaPositions?.shortCount);
  const rtaAvailable = isCleanReferenceComparison(rtaPositions, { requireAvailable: true })
    && rawRtaLongCount !== null
    && rawRtaShortCount !== null;
  const rtaLongCount = rtaAvailable ? rawRtaLongCount : null;
  const rtaShortCount = rtaAvailable ? rawRtaShortCount : null;
  const { etfProLongCount, etfProShortCount, etfProAvailable } = useMemo(() => {
    const counts = countEtfProPositionSides(etfProSnapshot);
    const shapeAvailable = etfProSnapshot?.available === true
      || (etfProSnapshot?.available !== false && counts.hasCounts);
    const available = shapeAvailable && counts.hasCounts && isCleanReferenceComparison(etfProSnapshot);
    return {
      etfProLongCount: available ? counts.longCount : null,
      etfProShortCount: available ? counts.shortCount : null,
      etfProAvailable: available,
    };
  }, [etfProSnapshot]);
  const buildNetDisplay = useCallback((longCount, shortCount, available = true) => {
    if (!available) {
      return {
        available: false,
        longWidth: 0,
        shortWidth: 0,
        markerLeft: null,
        netPctText: '—',
        tone: 'neutral',
      };
    }

    const total = (longCount || 0) + (shortCount || 0);
    if (!total) {
      return {
        available: true,
        longWidth: 0,
        shortWidth: 0,
        markerLeft: 50,
        netPctText: '0%',
        tone: 'neutral',
      };
    }

    const longWidth = ((longCount || 0) / total) * 100;
    const shortWidth = ((shortCount || 0) / total) * 100;
    const netPct = (((longCount || 0) - (shortCount || 0)) / total) * 100;

    return {
      available: true,
      longWidth,
      shortWidth,
      markerLeft: longWidth,
      netPctText: `${netPct > 0 ? '+' : ''}${Math.round(netPct)}%`,
      tone: netPct > 0 ? 'long' : netPct < 0 ? 'short' : 'neutral',
    };
  }, []);
  const liveNetBar = useMemo(() => {
    return buildNetDisplay(liveLongCount, liveShortCount, showMetrics);
  }, [buildNetDisplay, liveLongCount, liveShortCount, showMetrics]);
  const rtaNetBar = useMemo(() => {
    return buildNetDisplay(rtaLongCount, rtaShortCount, rtaAvailable);
  }, [buildNetDisplay, rtaAvailable, rtaLongCount, rtaShortCount]);
  const etfProNetBar = useMemo(() => {
    return buildNetDisplay(etfProLongCount, etfProShortCount, etfProAvailable);
  }, [buildNetDisplay, etfProAvailable, etfProLongCount, etfProShortCount]);

  const usEquitySessionActive = useMemo(
    () => isUsEquitySessionActive(new Date(sessionClock)),
    [sessionClock],
  );

  const headerSnapshot = useMemo(
    () => resolvePortfolioHeaderSnapshot({
      nlv: exposure.nlv,
      dailyPnL: portfolioData?.pnl?.dailyPnL,
      dailyPnLPercent: portfolioData?.pnl?.dailyPnLPercent,
      sessionActive: usEquitySessionActive,
      cachedCloseSnapshot,
    }),
    [cachedCloseSnapshot, exposure.nlv, portfolioData?.pnl?.dailyPnL, portfolioData?.pnl?.dailyPnLPercent, usEquitySessionActive],
  );

  useEffect(() => {
    if (!selectedAccount || typeof window === 'undefined') return;
    const storageKey = `${PORTFOLIO_CLOSE_CACHE_PREFIX}${selectedAccount}`;

    if (usEquitySessionActive) {
      window.localStorage.removeItem(storageKey);
      if (cachedCloseSnapshot != null) {
        setCachedCloseSnapshot(null);
      }
      return;
    }

    const snapshotToCache = headerSnapshot.snapshotToCache;
    if (!snapshotToCache) return;

    try {
      const nextSnapshot = {
        ...snapshotToCache,
        capturedAt: new Date().toISOString(),
      };
      window.localStorage.setItem(storageKey, JSON.stringify(nextSnapshot));
      setCachedCloseSnapshot((prev) => {
        if (
          prev?.netLiquidation === nextSnapshot.netLiquidation &&
          prev?.dailyPct === nextSnapshot.dailyPct
        ) {
          return prev;
        }
        return nextSnapshot;
      });
    } catch {
      // Ignore localStorage failures; header falls back to live data / (--).
    }
  }, [cachedCloseSnapshot, headerSnapshot.snapshotToCache, selectedAccount, usEquitySessionActive]);

  const accountValueLabel = useMemo(() => {
    if (!selectedAccount || !showMetrics) return null;
    const displayNlv = headerSnapshot.displayNlv ?? exposure.nlv;
    const dailyPct = headerSnapshot.displayDailyPct;
    return (
      <AccountDropdownLabel
        accountId={selectedAccount}
        value={displayNlv}
        currency={currency}
        dailyPct={dailyPct}
      />
    );
  }, [currency, exposure.nlv, headerSnapshot.displayDailyPct, headerSnapshot.displayNlv, selectedAccount, showMetrics]);

  const buildAccountOptionLabel = useCallback((accountId) => {
    if (!accountId) return '';

    if (accountId === selectedAccount && accountValueLabel) {
      return accountValueLabel;
    }

    const snapshot = accountSnapshotsById[accountId];
    const snapshotNlv = snapshot?.accountSummary?.netLiquidation;
    const snapshotCurrency = snapshot?.accountSummary?.currency || 'USD';
    const snapshotDailyPnl = snapshot?.pnl?.dailyPnL;

    if (!Number.isFinite(Number(snapshotNlv))) {
      return formatIbkrAccountLabel(accountId);
    }

    const derivedSnapshot = resolvePortfolioHeaderSnapshot({
      nlv: snapshotNlv,
      dailyPnL: snapshotDailyPnl,
      dailyPnLPercent: snapshot?.pnl?.dailyPnLPercent,
      sessionActive: usEquitySessionActive,
      cachedCloseSnapshot: null,
    });
    const dailyPct = derivedSnapshot.displayDailyPct;

    return (
      <AccountDropdownLabel
        accountId={accountId}
        value={derivedSnapshot.displayNlv}
        currency={snapshotCurrency}
        dailyPct={dailyPct}
      />
    );
  }, [accountSnapshotsById, accountValueLabel, selectedAccount, usEquitySessionActive]);

  return (
    <div className="pf-snapshot">
      <header className="pf-header">
        <div className="pf-header__top">
          <div className="pf-header__brand">
            <div className="pf-header__logo" aria-hidden="true">
              <img className="pf-header__logo-img" src={portfolioFolderIcon} alt="" />
            </div>
            <div style={{ minWidth: 0 }}>
              <h1 className="pf-header__title">Portfolio</h1>
              <p className="pf-header__subtitle">{STRATEGY_SUBTITLE}</p>
            </div>
          </div>

          {onToggleExpandUp && (
            <button
              type="button"
              onClick={onToggleExpandUp}
              className="rounded-md border border-blue-500 dark:border-blue-400 bg-white dark:bg-gray-800 hover:bg-blue-50 dark:hover:bg-gray-700 transition-colors"
              title={expandedUp ? "Collapse portfolio panel" : "Expand portfolio panel"}
              style={{
                width: '24px',
                height: '24px',
                padding: '0',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                position: 'absolute',
                left: '50%',
                transform: 'translateX(-50%)',
              }}
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 16 16"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path
                  d={expandedUp ? 'M4 6L8 10L12 6' : 'M4 10L8 6L12 10'}
                  stroke="#3b82f6"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          )}

          <div className="pf-header__actions">
            <button
              type="button"
              className="pf-icon-btn"
              onClick={onRefresh}
              disabled={loading || refreshing}
              title={refreshing ? 'Refreshing portfolio' : 'Refresh portfolio'}
              aria-label="Refresh portfolio"
            >
              <RefreshCw className={`pf-icon-btn__arrow${loading || refreshing ? ' pf-spin' : ''}`} size={15} strokeWidth={2} />
            </button>
            <StatusDot
              status={statusDot.status}
              emoji={statusDot.emoji}
              size={8}
              label={statusDot.label}
              overallLabel={statusDot.overallLabel}
              sources={statusDot.sources}
              updatedAt={statusDot.updatedAt}
              align="right"
              placement="bottom"
            />
          </div>
        </div>

        <div className="pf-header__controls">
          <PopoverSelect
            value={selectedAccount || ''}
            options={accountOptions.map((acct) => ({
              value: acct,
              label: buildAccountOptionLabel(acct),
            }))}
            onChange={(value) => {
              saveSelectedAccount(value);
              onAccountChange(value);
            }}
            buttonClassName="pf-account-select"
            menuClassName="pf-account-select-menu"
            optionClassName="pf-account-select-option"
            menuMatchButtonWidth
            menuOffset={0}
          />
        </div>

      </header>

      <div className="pf-body-container">
        {refreshActive && (
          <div
            className="pf-refresh-state"
            data-testid="portfolio-refresh-state"
            role="status"
            aria-live="polite"
          >
            <RefreshCw className="pf-refresh-state__icon pf-spin" size={12} aria-hidden="true" />
            <span>
              {retainingVerifiedSnapshot
                ? `Refreshing · last verified as of ${formatPortfolioRefreshAsOf(portfolioData)}`
                : 'Syncing live IBKR…'}
            </span>
          </div>
        )}

      {!isPortfolioLive && !loading && (
        <div className="pf-card pf-card--muted pf-setup">
          <p className="pf-setup__heading">{offlinePanel.heading}</p>
          {offlinePanel.steps && (
            <ol className="pf-setup__list">
              {offlinePanel.steps.map((step) => (
                <SetupStep key={step.id} label={step.label} done={step.done} />
              ))}
            </ol>
          )}
        </div>
      )}

      {showPortfolioContent && sidebarBanner && !loading && (
        <p className="pf-banner">{sidebarBanner.message}</p>
      )}

      {!showMetrics && !loading && (
        <CashDebitGuardCard
          key={selectedAccount || 'no-account'}
          guard={cashDebitGuard}
          selectedAccount={selectedAccount}
          onRefresh={onRefresh}
        />
      )}

      {(showMetrics || loading || refreshing) && (
        <div className="pf-body">

          {/* Portfolio / signal count comparison */}
          <div className="pf-metrics-row">
            <div className="pf-position-compare" role="table" aria-label="Portfolio versus RTA and ETF Pro position comparison">
              <div className="pf-position-compare__header pf-position-compare__cell" />
              <div className="pf-position-compare__header pf-position-compare__cell">Portfolio</div>
              <div className="pf-position-compare__header pf-position-compare__cell">RTA</div>
              <div className="pf-position-compare__header pf-position-compare__cell">ETF Pro</div>

              <div className="pf-position-compare__label pf-position-compare__label--long pf-position-compare__cell">Long</div>
              <div className="pf-position-compare__value pf-position-compare__value--long pf-position-compare__cell tabular-nums">
                {showMetrics ? liveLongCount : '—'}
              </div>
              <div className="pf-position-compare__value pf-position-compare__value--long pf-position-compare__cell tabular-nums" data-testid="rta-long-count">
                {rtaLongCount ?? '—'}
              </div>
              <div className="pf-position-compare__value pf-position-compare__value--long pf-position-compare__cell tabular-nums" data-testid="etf-pro-long-count">
                {etfProLongCount ?? '—'}
              </div>

              <div className="pf-position-compare__label pf-position-compare__label--short pf-position-compare__cell">Short</div>
              <div className="pf-position-compare__value pf-position-compare__value--short pf-position-compare__cell tabular-nums">
                {showMetrics ? liveShortCount : '—'}
              </div>
              <div className="pf-position-compare__value pf-position-compare__value--short pf-position-compare__cell tabular-nums" data-testid="rta-short-count">
                {rtaShortCount ?? '—'}
              </div>
              <div className="pf-position-compare__value pf-position-compare__value--short pf-position-compare__cell tabular-nums" data-testid="etf-pro-short-count">
                {etfProShortCount ?? '—'}
              </div>

              <div className="pf-position-compare__label pf-position-compare__cell">Net</div>
              <div className="pf-position-compare__cell">
                <div className="pf-netbar-wrap">
                  <div className={`pf-netbar__pct pf-netbar__pct--${liveNetBar.tone}`}>{liveNetBar.netPctText}</div>
                  <div className="pf-netbar" aria-hidden="true">
                    {liveNetBar.available && (
                      <>
                        <div className="pf-netbar__segment pf-netbar__segment--long" style={{ width: `${liveNetBar.longWidth}%` }} />
                        <div className="pf-netbar__segment pf-netbar__segment--short" style={{ width: `${liveNetBar.shortWidth}%` }} />
                        <div className="pf-netbar__marker" style={{ left: `${liveNetBar.markerLeft}%` }} />
                      </>
                    )}
                  </div>
                </div>
              </div>
              <div className="pf-position-compare__cell">
                <div className={`pf-netbar-wrap${rtaAvailable ? '' : ' pf-netbar-wrap--muted'}`}>
                  <div className={`pf-netbar__pct pf-netbar__pct--${rtaNetBar.tone}`} data-testid="rta-net-percent">{rtaNetBar.netPctText}</div>
                  <div className="pf-netbar" aria-hidden="true" data-testid="rta-net-bar">
                    {rtaNetBar.available && (
                      <>
                        <div className="pf-netbar__segment pf-netbar__segment--long" style={{ width: `${rtaNetBar.longWidth}%` }} />
                        <div className="pf-netbar__segment pf-netbar__segment--short" style={{ width: `${rtaNetBar.shortWidth}%` }} />
                        <div className="pf-netbar__marker" style={{ left: `${rtaNetBar.markerLeft}%` }} />
                      </>
                    )}
                  </div>
                </div>
              </div>
              <div className="pf-position-compare__cell">
                <div className={`pf-netbar-wrap${etfProAvailable ? '' : ' pf-netbar-wrap--muted'}`}>
                  <div className={`pf-netbar__pct pf-netbar__pct--${etfProNetBar.tone}`} data-testid="etf-pro-net-percent">{etfProNetBar.netPctText}</div>
                  <div className="pf-netbar" aria-hidden="true" data-testid="etf-pro-net-bar">
                    {etfProNetBar.available && (
                      <>
                        <div className="pf-netbar__segment pf-netbar__segment--long" style={{ width: `${etfProNetBar.longWidth}%` }} />
                        <div className="pf-netbar__segment pf-netbar__segment--short" style={{ width: `${etfProNetBar.shortWidth}%` }} />
                        <div className="pf-netbar__marker" style={{ left: `${etfProNetBar.markerLeft}%` }} />
                      </>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>

          {showMetrics && (
            <>
              <CashDebitGuardCard
                key={selectedAccount || 'no-account'}
                guard={cashDebitGuard}
                selectedAccount={selectedAccount}
                onRefresh={onRefresh}
              />

              {/* Exposure */}
              <div className="pf-section">
                <div className="pf-bars">
                  <ExposureBar
                    label="Gross Exposure"
                    pct={displayExposure.grossPct}
                    amount={
                      Number.isFinite(displayExposure.longMV) &&
                      Number.isFinite(displayExposure.shortMV)
                        ? displayExposure.longMV + displayExposure.shortMV
                        : null
                    }
                    currency={currency}
                  />
                  <ExposureBar
                    label="Net Exposure"
                    pct={displayExposure.netPct}
                    amount={displayExposure.netMV}
                    netAmount
                    currency={currency}
                  />
                  <ExposureBar
                    label="Long Exposure"
                    pct={displayExposure.longPct}
                    amount={displayExposure.longMV}
                    currency={currency}
                  />
                  <ExposureBar
                    label="Short Exposure"
                    pct={displayExposure.shortPct}
                    amount={displayExposure.shortMV}
                    currency={currency}
                  />
                  <ExposureBar
                    label="CASH"
                    pct={exposure.cashPct}
                    amount={exposure.cashValue}
                    currency={currency}
                    tooltip={IDLE_CASH_TOOLTIP}
                  />
                </div>
              </div>

              <FlexReconciliationPanel
                liveExposure={displayExposure}
                currency={currency}
                reconciliation={exposureReconciliation}
                loading={exposureReconciliationLoading}
              />

              <LatestUpdatesFeed
                changelog={hedgeyeChangelog}
                loading={hedgeyeChangelogLoading}
                error={hedgeyeChangelogError}
                now={sessionClock}
                lastSuccessAt={hedgeyeChangelogLastSuccessAt}
              />
            </>
          )}

        </div>

      )}
      </div>
    </div>
  );
};

export default PortfolioSidebarSnapshot;
