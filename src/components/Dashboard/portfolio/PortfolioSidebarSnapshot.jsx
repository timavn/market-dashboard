import React, { useMemo } from 'react';
import { RefreshCw } from 'lucide-react';
import StatusDot from '../../common/StatusDot';
import LoadingIndicator from '../../common/LoadingIndicator';
import {
  getIbkrPortfolioStatusDot,
  getPortfolioOfflinePanel,
  getPortfolioSidebarBanner,
  isPortfolioSyncPending,
} from '../../../utils/ibkrConnectionStatus';
import {
  computePortfolioExposure,
  computeMarginMetrics,
  computeDailyPnLPercent,
  formatExposurePct,
  formatCurrency,
  formatSignedCurrency,
  IDLE_CASH_TOOLTIP,
} from '../../../utils/portfolioExposureMetrics';
import { saveSelectedAccount } from '../../../constants/ibkrAccountStorage';
import { formatIbkrAccountLabel } from '../../../constants/ibkrAccountLabels';
import './PortfolioSidebarSnapshot.css';

const STRATEGY_SUBTITLE = 'Long/Short Global Macro';

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

function MetricRing({ value, label, sublabel, tone = 'neutral', size = 76, stroke = 5 }) {
  const pct = value != null && Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (pct / 100) * circumference;
  const toneClass =
    tone === 'positive' ? 'pf-ring--positive' : tone === 'negative' ? 'pf-ring--negative' : '';

  return (
    <div className={`pf-ring ${toneClass}`} style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
        <circle
          className="pf-ring__track"
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={stroke}
        />
        <circle
          className="pf-ring__fill"
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={stroke}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <div className="pf-ring__center">
        <span className="pf-ring__value">{label}</span>
        {sublabel && <span className="pf-ring__sublabel">{sublabel}</span>}
      </div>
    </div>
  );
}

function ExposureDonut({ longPct, shortPct, netPct }) {
  const size = 80;
  const stroke = 5;
  const radius = (size - stroke) / 2;
  const c = 2 * Math.PI * radius;
  const long = Math.max(0, longPct || 0);
  const short = Math.max(0, shortPct || 0);
  const total = long + short || 1;
  const longLen = (long / total) * c;
  const shortLen = (short / total) * c;
  const netLabel = formatExposurePct(netPct, { signed: true });

  return (
    <div className="pf-exposure-donut" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
        <circle
          className="pf-exposure-donut__track"
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={stroke}
        />
        {long > 0 && (
          <circle
            className="pf-exposure-donut__long"
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            strokeWidth={stroke}
            strokeDasharray={`${longLen} ${c - longLen}`}
            strokeLinecap="round"
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        )}
        {short > 0 && (
          <circle
            className="pf-exposure-donut__short"
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            strokeWidth={stroke}
            strokeDasharray={`${shortLen} ${c - shortLen}`}
            strokeLinecap="round"
            transform={`rotate(${-90 + (longLen / c) * 360} ${size / 2} ${size / 2})`}
          />
        )}
      </svg>
      <div className="pf-exposure-donut__center">
        <span
          className={`pf-exposure-donut__net${
            netPct > 0 ? ' pf-exposure-donut__net--long' : netPct < 0 ? ' pf-exposure-donut__net--short' : ''
          }`}
        >
          {netLabel}
        </span>
        <span className="pf-exposure-donut__caption">Net Exposure</span>
      </div>
    </div>
  );
}

function ExposureBar({ label, pct, variant = 'neutral', signed = false, tooltip }) {
  const display = formatExposurePct(pct, { signed });
  const barPct = pct != null && Number.isFinite(pct) ? Math.min(100, Math.abs(pct)) : 0;

  return (
    <div className="pf-bar" title={tooltip || undefined}>
      <div className="pf-bar__row">
        <span className="pf-label">{label}</span>
        <span className={`pf-bar__value pf-bar__value--${variant}`}>{display}</span>
      </div>
      <div className="pf-bar__track">
        <div
          className={`pf-bar__fill pf-bar__fill--${variant}`}
          style={{ width: `${barPct}%` }}
        />
      </div>
    </div>
  );
}

const PortfolioSidebarSnapshot = ({
  portfolioData,
  loading = false,
  accounts = [],
  connection = null,
  selectedAccount,
  onAccountChange,
  onRefresh,
}) => {
  const handleAccountSelect = (e) => {
    const acct = e.target.value;
    saveSelectedAccount(acct);
    onAccountChange(acct);
  };

  const isPortfolioLive = portfolioData?.dataSource === 'ibkr_api';
  const isSyncPending = isPortfolioSyncPending({ connection, portfolioData });
  const showPortfolioContent = isPortfolioLive || isSyncPending;
  const isConnected = Boolean(connection?.connected);

  const exposure = computePortfolioExposure({
    holdings: portfolioData?.holdings || [],
    accountSummary: portfolioData?.accountSummary,
    summary: portfolioData?.summary,
  });
  const margin = computeMarginMetrics(portfolioData?.accountSummary);
  const currency = portfolioData?.accountSummary?.currency || 'USD';
  const dailyPnL = portfolioData?.pnl?.dailyPnL ?? null;
  const dailyPnLPct = computeDailyPnLPercent(dailyPnL, exposure.nlv);
  const sidebarBanner = getPortfolioSidebarBanner({ portfolioData, selectedAccount });
  const showMetrics =
    showPortfolioContent && exposure.nlv != null && Number.isFinite(exposure.nlv);

  const accountOptions = useMemo(() => {
    const ids = Array.isArray(accounts) ? [...accounts] : [];
    if (selectedAccount && !ids.includes(selectedAccount)) {
      ids.unshift(selectedAccount);
    }
    return ids;
  }, [accounts, selectedAccount]);

  const statusDot = useMemo(
    () => getIbkrPortfolioStatusDot({ connection, portfolioData, loading }),
    [connection, portfolioData, loading],
  );

  const offlinePanel = useMemo(
    () => getPortfolioOfflinePanel({ connection, portfolioData }),
    [connection, portfolioData],
  );

  const marginHealthClass =
    margin.healthLabel === 'Healthy'
      ? 'healthy'
      : margin.healthLabel === 'Moderate'
        ? 'moderate'
        : margin.healthLabel === 'Low'
          ? 'low'
          : 'neutral';

  return (
    <div className="pf-snapshot">
      <header className="pf-header">
        <div className="pf-header__top">
          <div className="pf-header__brand">
            <div className="pf-header__logo" aria-hidden>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.5" />
                <path
                  d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
              </svg>
            </div>
            <div>
              <h1 className="pf-header__title">Portfolio</h1>
              <p className="pf-header__subtitle">{STRATEGY_SUBTITLE}</p>
            </div>
          </div>
          <div className="pf-header__status">
            <span className={`pf-status-pill${isConnected ? ' pf-status-pill--on' : ''}`}>
              <span className="pf-status-pill__dot" aria-hidden />
              {isConnected ? 'Connected' : 'Offline'}
            </span>
          </div>
        </div>

        <div className="pf-header__controls">
          <select
            id="ibkr-account-select"
            className="pf-account-select"
            value={selectedAccount || ''}
            onChange={handleAccountSelect}
            disabled={accountOptions.length === 0}
            aria-label="Account"
          >
            {accountOptions.length === 0 ? (
              <option value="">No accounts</option>
            ) : (
              accountOptions.map((acct) => (
                <option key={acct} value={acct}>
                  {formatIbkrAccountLabel(acct)}
                </option>
              ))
            )}
          </select>
          <div className="pf-header__actions">
            <button
              type="button"
              className="pf-icon-btn"
              onClick={onRefresh}
              disabled={loading}
              title="Refresh portfolio"
              aria-label="Refresh portfolio"
            >
              <RefreshCw className={loading ? 'pf-spin' : ''} size={15} strokeWidth={2} />
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
              placement="top"
            />
          </div>
        </div>

      </header>

      {loading && (
        <div className="pf-loading">
          <LoadingIndicator label="Syncing…" size="sm" />
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

      {showMetrics && (
        <div className="pf-body">
          <section className="pf-card pf-hero">
            <div className="pf-hero__col">
              <span className="pf-label">Net Liquidation</span>
              <span className="pf-hero__value tabular-nums">
                {formatCurrency(exposure.nlv, currency)}
              </span>
              <span className="pf-hero__hint">Total account value</span>
            </div>
            <div className="pf-hero__divider" aria-hidden />
            <div className="pf-hero__col">
              <span className="pf-label">Daily P&amp;L</span>
              <span
                className={`pf-hero__value tabular-nums${
                  dailyPnL > 0
                    ? ' pf-hero__value--up'
                    : dailyPnL < 0
                      ? ' pf-hero__value--down'
                      : ''
                }`}
              >
                {dailyPnL != null && Number.isFinite(dailyPnL)
                  ? formatSignedCurrency(dailyPnL, currency)
                  : '—'}
              </span>
              <span className="pf-hero__hint">
                {dailyPnLPct != null
                  ? `${formatExposurePct(dailyPnLPct, { signed: true })} vs prior close`
                  : dailyPnL != null
                    ? 'vs prior close'
                    : 'Unavailable from IBKR'}
              </span>
            </div>
          </section>

          <section className="pf-card">
            <div className="pf-card__head">
              <div className="pf-card__icon pf-card__icon--exposure" aria-hidden>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.75" />
                  <circle cx="12" cy="12" r="2" fill="currentColor" />
                </svg>
              </div>
              <h2 className="pf-card__title">Exposure</h2>
            </div>
            <div className="pf-exposure">
              <ExposureDonut
                longPct={exposure.longPct}
                shortPct={exposure.shortPct}
                netPct={exposure.netPct}
              />
              <div className="pf-exposure__bars">
                <ExposureBar label="Gross Exposure" pct={exposure.grossPct} variant="blue" />
                <ExposureBar
                  label="Net Exposure"
                  pct={exposure.netPct}
                  variant="positive"
                  signed
                />
                <ExposureBar label="Long Exposure" pct={exposure.longPct} variant="positive" />
                <ExposureBar label="Short Exposure" pct={exposure.shortPct} variant="negative" />
                <ExposureBar
                  label="Idle Cash"
                  pct={exposure.cashPct}
                  variant="neutral"
                  tooltip={IDLE_CASH_TOOLTIP}
                />
              </div>
            </div>
          </section>

          <section className="pf-card">
            <div className="pf-card__head">
              <div className="pf-card__icon pf-card__icon--liquidity" aria-hidden>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                  <path
                    d="M12 3l7 4v6c0 4.5-3 7.5-7 8-4-.5-7-3.5-7-8V7l7-4z"
                    stroke="currentColor"
                    strokeWidth="1.75"
                    strokeLinejoin="round"
                  />
                </svg>
              </div>
              <h2 className="pf-card__title">Liquidity &amp; Margin</h2>
            </div>
            <div className="pf-liquidity">
              <div className="pf-liquidity__rows">
                <div className="pf-liquidity__row">
                  <span className="pf-label">Excess Liquidity</span>
                  <span className="pf-liquidity__amount tabular-nums">
                    {formatCurrency(margin.excessLiquidity, currency)}
                  </span>
                </div>
                <div className="pf-liquidity__row">
                  <span className="pf-label">Available Funds</span>
                  <span className="pf-liquidity__amount tabular-nums">
                    {formatCurrency(margin.availableFunds, currency)}
                  </span>
                </div>
                <div className="pf-liquidity__divider" />
                <div className="pf-liquidity__row">
                  <span className="pf-label">Margin Used</span>
                  <span className="pf-liquidity__amount tabular-nums">
                    {formatCurrency(margin.marginUsed, currency)}
                  </span>
                </div>
                <div className="pf-liquidity__row">
                  <span className="pf-label">Margin Cushion</span>
                  <span className="pf-liquidity__amount pf-liquidity__amount--positive tabular-nums">
                    {margin.marginCushionPct != null
                      ? `${Math.round(margin.marginCushionPct)}%`
                      : '—'}
                  </span>
                </div>
              </div>
              {margin.marginCushionPct != null && (
                <div className="pf-liquidity__gauge">
                  <MetricRing
                    value={margin.marginCushionPct}
                    label={`${Math.round(margin.marginCushionPct)}%`}
                    sublabel="Cushion"
                    tone="positive"
                    size={72}
                    stroke={5}
                  />
                  {margin.healthLabel && (
                    <span className={`pf-health-pill pf-health-pill--${marginHealthClass}`}>
                      {margin.healthLabel}
                    </span>
                  )}
                </div>
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  );
};

export default PortfolioSidebarSnapshot;
