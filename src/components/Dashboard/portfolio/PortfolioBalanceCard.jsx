import React, { useEffect, useMemo, useState } from 'react';
import { usePortfolioBalance } from '../../../hooks/usePortfolioBalance';
import { MarketDataService } from '../../../services/api/marketDataService';
import { useSurfaceActivity } from '../../common/PersistentSurface';
import './PortfolioBalanceCard.css';

const ACTION_LABELS = {
  add_long: 'Add long exposure',
  trim_long: 'Reduce long exposure',
  add_short: 'Add to an existing short',
  cover_short: 'Cover an existing short',
};

const EVENT_VENUE_LABELS = {
  FORECASTX: 'ForecastEx',
  KALSHI: 'Kalshi',
};

function formatCurrency(value, currency = 'USD') {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(number);
}

function formatPercent(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${number.toFixed(1)}%` : '—';
}

function formatObservedAt(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Unknown';
  return date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatSettlementDate(value) {
  const date = new Date(`${value}T12:00:00Z`);
  if (!Number.isFinite(date.getTime())) return value || 'unknown date';
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

function formatEventVenueNames(eventContracts) {
  if (!eventContracts || typeof eventContracts !== 'object') return null;
  const venues = Array.isArray(eventContracts.venues)
    ? eventContracts.venues
    : eventContracts.venue
      ? [eventContracts.venue]
      : null;
  if (!venues || venues.length === 0 || new Set(venues).size !== venues.length) {
    return null;
  }
  const sorted = [...venues].sort();
  if (
    venues.some((venue, index) => (
      venue !== sorted[index] || !EVENT_VENUE_LABELS[venue]
    ))
  ) return null;
  return venues.map((venue) => EVENT_VENUE_LABELS[venue]).join(' + ');
}

function balanceErrorMessage(error) {
  const code = String(error?.code || '');
  if (/GATEWAY|SIDECAR|DISCONNECTED/.test(code)) {
    return 'IBKR is disconnected. Reconnect Gateway to restore the live balance.';
  }
  if (/POSITION_SCOPE|CURRENCY|KALSHI|EVENT_CONTRACT/.test(code)) {
    return 'Live balance is unavailable while an IBKR position or event-contract accounting value is unverified.';
  }
  if (/LADDER|RECONCIL/.test(code)) {
    return 'IBKR cash settlement evidence could not be reconciled safely.';
  }
  if (/STALE/.test(code)) {
    return 'The verified balance expired before a replacement arrived.';
  }
  return error?.message || 'Verified live IBKR portfolio balance is unavailable.';
}

function capacityErrorMessage(capacity) {
  const code = String(capacity?.errorCode || capacity?.reason || '').toUpperCase();
  if (/SHORT_POSITION|POSITIONS/.test(code)) {
    return 'Interest exposure unavailable until IBKR provides complete position detail.';
  }
  if (/POSITION_SCOPE/.test(code)) {
    return 'Interest exposure is unavailable while an unsupported instrument is open.';
  }
  if (/KALSHI|EVENT_CONTRACT/.test(code)) {
    return 'Interest exposure is unavailable until IBKR event-contract value and margin reconcile.';
  }
  if (/LADDER|SETTLEMENT|RECONCIL/.test(code)) {
    return 'Interest exposure is unavailable until IBKR cash settlements reconcile.';
  }
  return 'Interest exposure is unavailable until IBKR provides complete balance evidence.';
}

function Metric({ label, value, detail, tone = 'neutral', testId }) {
  return (
    <div className={`portfolio-balance__metric portfolio-balance__metric--${tone}`}>
      <span>{label}</span>
      <strong data-testid={testId}>{value}</strong>
      {detail && <small>{detail}</small>}
    </div>
  );
}

function ExposureMetric({ label, value, percent, tone }) {
  return (
    <div className={`portfolio-balance__exposure portfolio-balance__exposure--${tone}`}>
      <span>{label}</span>
      <strong>{formatCurrency(value)}</strong>
      <small>{formatPercent(percent)} of NLV</small>
    </div>
  );
}

function previewError(error) {
  return error?.response?.data?.message
    || error?.message
    || 'The trade preview is unavailable.';
}

const PortfolioBalanceCard = ({ accountId }) => {
  const surfaceActive = useSurfaceActivity();
  const {
    status,
    snapshot,
    executable: reportedExecutable,
    lastVerifiedAt,
    error,
    loading,
  } = usePortfolioBalance(accountId, { active: surfaceActive });
  const executable = reportedExecutable ?? Boolean(
    snapshot && !['last_verified', 'loading', 'unavailable'].includes(status),
  );
  const [action, setAction] = useState('add_long');
  const [amount, setAmount] = useState('');
  const [conId, setConId] = useState('');
  const [quantity, setQuantity] = useState('');
  const [limitPrice, setLimitPrice] = useState('');
  const [projection, setProjection] = useState(null);
  const [projectionError, setProjectionError] = useState(null);
  const [previewing, setPreviewing] = useState(false);

  useEffect(() => {
    setProjection(null);
    setProjectionError(null);
  }, [accountId, snapshot?.snapshotId]);

  const shortPositions = useMemo(
    () => snapshot?.shortPositions || [],
    [snapshot?.shortPositions],
  );
  const eventVenueNames = formatEventVenueNames(snapshot?.eventContracts);
  const capacityAvailable = Boolean(
    snapshot?.cash
      && snapshot?.buffer
      && snapshot?.capacity?.available !== false
      && (!snapshot?.eventContracts || eventVenueNames)
  );
  const margin = snapshot?.margin?.available === true
    && snapshot.margin.status === 'live'
    && snapshot.margin.source === 'ibkr_live_session'
    ? snapshot.margin
    : null;
  const interestExposure = snapshot?.interestExposure?.available === true
    && snapshot.interestExposure.status === 'live'
    && snapshot.interestExposure.source === 'ibkr_live_session'
    && snapshot.interestExposure.actionable === false
    ? snapshot.interestExposure
    : null;
  const projectedDebitPrincipal = Number(
    interestExposure?.projected?.estimatedDebitPrincipal,
  );
  const bufferedDebitPrincipal = Number(
    interestExposure?.policy?.estimatedDebitPrincipalAfterReserve,
  );
  const reserve = Number(interestExposure?.policy?.totalReserve);
  const interestExposureAvailable = capacityAvailable
    && Number.isFinite(projectedDebitPrincipal)
    && Number.isFinite(bufferedDebitPrincipal)
    && Number.isFinite(reserve);
  useEffect(() => {
    if (shortPositions.length > 0 && !shortPositions.some(
      (position) => String(position.conId) === conId,
    )) {
      setConId(String(shortPositions[0].conId));
    }
  }, [conId, shortPositions]);

  const previewDisabledReason = useMemo(() => {
    if (!snapshot) return 'A verified live balance is required.';
    if (!executable) return 'Reconnect IBKR and verify a fresh live balance before previewing a trade.';
    if (!capacityAvailable) {
      return 'Complete live position and settlement evidence is required for an interest-exposure preview.';
    }
    if (snapshot.activity?.openOrderCount > 0) {
      return 'Resolve open orders before previewing another trade.';
    }
    if (
      ['add_short', 'cover_short'].includes(action)
      && shortPositions.length === 0
    ) return 'There is no existing verified short position to preview.';
    return null;
  }, [action, capacityAvailable, executable, shortPositions.length, snapshot]);

  const submitPreview = async (event) => {
    event.preventDefault();
    setProjection(null);
    setProjectionError(null);
    if (previewDisabledReason) {
      setProjectionError(previewDisabledReason);
      return;
    }

    const request = { accountId, action };
    if (action === 'add_long' || action === 'trim_long') {
      const parsedAmount = Number(amount);
      if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
        setProjectionError('Enter a positive dollar amount.');
        return;
      }
      request.amount = parsedAmount;
    } else {
      const parsedConId = Number(conId);
      const parsedQuantity = Number(quantity);
      const parsedLimitPrice = Number(limitPrice);
      if (!Number.isSafeInteger(parsedConId) || parsedConId <= 0) {
        setProjectionError('Select an existing verified short position.');
        return;
      }
      if (!Number.isFinite(parsedQuantity) || parsedQuantity <= 0) {
        setProjectionError('Enter a positive share quantity.');
        return;
      }
      if (!Number.isFinite(parsedLimitPrice) || parsedLimitPrice <= 0) {
        setProjectionError('Enter a positive limit price.');
        return;
      }
      Object.assign(request, {
        conId: parsedConId,
        quantity: parsedQuantity,
        limitPrice: parsedLimitPrice,
      });
    }

    setPreviewing(true);
    try {
      const result = await MarketDataService.previewPortfolioBalance(request);
      setProjection(result);
    } catch (previewFailure) {
      setProjectionError(previewError(previewFailure));
    } finally {
      setPreviewing(false);
    }
  };

  return (
    <section
      className={`portfolio-balance portfolio-balance--${status}`}
      data-testid="portfolio-balance"
      data-status={status}
      aria-label="Portfolio balance"
    >
      <header className="portfolio-balance__header">
        <h3>Portfolio balance</h3>
      </header>

      {!snapshot && loading && (
        <div className="portfolio-balance__message" role="status">
          Reading live cash, settlements, and positions from IBKR…
        </div>
      )}

      {!snapshot && !loading && (
        <div className="portfolio-balance__message portfolio-balance__message--error" role="status">
          <strong>Live balance unavailable</strong>
          <span>{balanceErrorMessage(error)}</span>
        </div>
      )}

      {snapshot && (
        <>
          {status === 'last_verified' && (
            <div className="portfolio-balance__reference-status" role="status">
              <strong>Last verified {formatObservedAt(lastVerifiedAt || snapshot.observedAt)} · reconnecting</strong>
              <span>{error?.message || 'Waiting for a fresh live IBKR snapshot.'}</span>
            </div>
          )}
          <div className="portfolio-balance__exposures" aria-label="Current portfolio exposure">
            <ExposureMetric
              label="Current long"
              value={snapshot.exposure.longMarketValue}
              percent={snapshot.exposure.longPercent}
              tone="long"
            />
            <ExposureMetric
              label="Current short"
              value={snapshot.exposure.shortMarketValue}
              percent={snapshot.exposure.shortPercent}
              tone="short"
            />
            <ExposureMetric
              label="Gross"
              value={snapshot.exposure.grossMarketValue}
              percent={snapshot.exposure.grossPercent}
              tone="neutral"
            />
            <ExposureMetric
              label="Net"
              value={snapshot.exposure.netMarketValue}
              percent={snapshot.exposure.netPercent}
              tone="neutral"
            />
          </div>

          {interestExposureAvailable ? (
            <>
              {snapshot.settlement?.pending && (
                <p className="portfolio-balance__settlement" data-testid="portfolio-balance-settlement">
                  Pending settlements included through{' '}
                  <strong>{formatSettlementDate(snapshot.settlement.horizonDate)}</strong>
                </p>
              )}

              <div className="portfolio-balance__primary">
                <Metric
                  label="Margin health"
                  value={margin?.health === 'healthy'
                    ? 'No broker deficit'
                    : margin?.health === 'maintenance_deficit'
                      ? `${formatCurrency(margin.maintenanceDeficit)} maintenance deficit`
                      : margin?.health === 'initial_deficit'
                        ? `${formatCurrency(margin.initialDeficit)} initial deficit`
                        : 'Unavailable'}
                  detail={margin
                    ? `${formatCurrency(margin.excessLiquidity)} excess liquidity · ${formatCurrency(margin.availableFunds)} available funds`
                    : 'Broker-native margin evidence unavailable'}
                  tone={margin?.health === 'healthy' ? 'positive' : 'negative'}
                  testId="portfolio-balance-exact"
                />
                <Metric
                  label="Estimated debit principal"
                  value={formatCurrency(projectedDebitPrincipal)}
                  detail={`Effective ${formatSettlementDate(interestExposure.projected?.effectiveDate)} · interest model only`}
                  tone={projectedDebitPrincipal > 0 ? 'positive' : projectedDebitPrincipal < 0 ? 'negative' : 'neutral'}
                  testId="portfolio-balance-buffered"
                />
                <Metric
                  label="After policy reserve"
                  value={formatCurrency(bufferedDebitPrincipal)}
                  detail={`${formatCurrency(reserve)} reserve · not a margin call or sell instruction`}
                  tone={bufferedDebitPrincipal > 0 ? 'positive' : bufferedDebitPrincipal < 0 ? 'negative' : 'neutral'}
                  testId="portfolio-balance-long-limit"
                />
              </div>

              <div className="portfolio-balance__context">
                <span>
                  Projected settled-cash floor{' '}
                  {formatCurrency(interestExposure.projected?.securitiesCash)} on{' '}
                  {formatSettlementDate(interestExposure.projected?.effectiveDate)}
                </span>
                <span>Short collateral {formatCurrency(interestExposure.projected?.shortCollateral)}</span>
                {snapshot.eventContracts && eventVenueNames && (
                  <span>
                    {eventVenueNames}: {snapshot.eventContracts.positionCount} position
                    {snapshot.eventContracts.positionCount === 1 ? '' : 's'} ·{' '}
                    {formatCurrency(snapshot.eventContracts.marketValue)} value · fully margined ·{' '}
                    {formatCurrency(snapshot.eventContracts.capacityContribution)} interest-model contribution
                  </span>
                )}
                <span>
                  {status === 'last_verified'
                    ? `Last verified ${formatObservedAt(lastVerifiedAt || snapshot.observedAt)} · reconnecting`
                    : `Verified ${formatObservedAt(snapshot.observedAt)}`}
                </span>
              </div>
            </>
          ) : (
            <div className="portfolio-balance__message" role="status">
              {capacityErrorMessage(snapshot.capacity)} No amount is inferred.
            </div>
          )}

          {snapshot.activity?.sameDayExecutionCount > 0 && (
            <p className="portfolio-balance__activity-note">
              Includes {snapshot.activity.sameDayExecutionCount} stable same-day execution
              {snapshot.activity.sameDayExecutionCount === 1 ? '' : 's'}.
            </p>
          )}

          <details className="portfolio-balance__preview">
            <summary>Trade preview</summary>
            <p className="portfolio-balance__preview-intro">
              Read-only and conditional on a fill. Short capacity is security-specific;
              no universal short limit is inferred.
            </p>
            <form onSubmit={submitPreview}>
              <label>
                <span>Action</span>
                <select
                  aria-label="Portfolio balance preview action"
                  value={action}
                  onChange={(event) => {
                    setAction(event.target.value);
                    setProjection(null);
                    setProjectionError(null);
                  }}
                  disabled={
                    !snapshot
                    || !executable
                    || snapshot.activity?.openOrderCount > 0
                    || previewing
                  }
                >
                  {Object.entries(ACTION_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              </label>

              {(action === 'add_long' || action === 'trim_long') ? (
                <label>
                  <span>Dollar amount</span>
                  <input
                    aria-label="Portfolio balance preview dollar amount"
                    type="number"
                    min="0"
                    step="100"
                    value={amount}
                    onChange={(event) => setAmount(event.target.value)}
                    disabled={Boolean(previewDisabledReason) || previewing}
                  />
                </label>
              ) : (
                <>
                  <label>
                    <span>Existing short</span>
                    <select
                      aria-label="Portfolio balance existing short"
                      value={conId}
                      onChange={(event) => setConId(event.target.value)}
                      disabled={Boolean(previewDisabledReason) || previewing}
                    >
                      {shortPositions.map((position) => (
                        <option key={position.conId} value={position.conId}>
                          {position.symbol || position.conId} · {position.absoluteQuantity} shares
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>Shares</span>
                    <input
                      aria-label="Portfolio balance preview shares"
                      type="number"
                      min="0"
                      step="1"
                      value={quantity}
                      onChange={(event) => setQuantity(event.target.value)}
                      disabled={Boolean(previewDisabledReason) || previewing}
                    />
                  </label>
                  <label>
                    <span>Limit price</span>
                    <input
                      aria-label="Portfolio balance preview limit price"
                      type="number"
                      min="0"
                      step="0.01"
                      value={limitPrice}
                      onChange={(event) => setLimitPrice(event.target.value)}
                      disabled={Boolean(previewDisabledReason) || previewing}
                    />
                  </label>
                </>
              )}

              <button
                type="submit"
                disabled={Boolean(previewDisabledReason) || previewing}
              >
                {previewing ? 'Verifying…' : 'Preview trade'}
              </button>
            </form>

            {previewDisabledReason && (
              <p className="portfolio-balance__preview-error" role="status">
                {previewDisabledReason}
              </p>
            )}
            {projectionError && (
              <p className="portfolio-balance__preview-error" role="status">
                {projectionError}
              </p>
            )}
            {projection && (
              <div className="portfolio-balance__projection" data-testid="portfolio-balance-projection">
                <div>
                  <span>Projected debit principal</span>
                  <strong>{formatCurrency(projection.exact?.trimRequired || 0)}</strong>
                </div>
                <div>
                  <span>Debit principal after reserve</span>
                  <strong>{formatCurrency(projection.buffered?.trimRequired || 0)}</strong>
                </div>
                <div>
                  <span>Projected long / short</span>
                  <strong>
                    {formatCurrency(projection.exposure.longMarketValue)} /{' '}
                    {formatCurrency(projection.exposure.shortMarketValue)}
                  </strong>
                </div>
                <small>Interest-exposure estimate only · broker margin not projected · no order submitted.</small>
              </div>
            )}
          </details>
        </>
      )}
    </section>
  );
};

export default PortfolioBalanceCard;
