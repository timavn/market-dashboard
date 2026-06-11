import React, { useMemo, useEffect, useCallback, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import StatusDot from '../../common/StatusDot';
import LoadingIndicator from '../../common/LoadingIndicator';
import PopoverSelect from '../../common/PopoverSelect';
import RefreshButton from '../../common/RefreshButton';
import { usePortfolioCorrelationConcentration } from '../../../hooks/usePortfolioCorrelationConcentration';
import {
  getIbkrPortfolioStatusDot,
  getPortfolioOfflinePanel,
  getPortfolioSidebarBanner,
  isPortfolioSyncPending,
} from '../../../utils/ibkrConnectionStatus';
import {
  computePortfolioExposure,
  formatExposurePct,
  formatCurrency,
  IDLE_CASH_TOOLTIP,
  isUsEquitySessionActive,
  resolvePortfolioHeaderSnapshot,
} from '../../../utils/portfolioExposureMetrics';
import { saveSelectedAccount, loadIbkrAccounts, saveIbkrAccounts } from '../../../constants/ibkrAccountStorage';
import { formatIbkrAccountLabel, IBKR_ACCOUNT_LABELS } from '../../../constants/ibkrAccountLabels';
import './PortfolioSidebarSnapshot.css';

const STRATEGY_SUBTITLE = 'Long/Short Global Macro';
const PORTFOLIO_CLOSE_CACHE_PREFIX = 'portfolioCloseSnapshot:';

function formatLensPct(value, decimals = 0, { signed = false } = {}) {
  if (value == null || !Number.isFinite(Number(value))) return '--';
  const number = Number(value);
  const sign = signed && number > 0 ? '+' : '';
  return `${sign}${number.toFixed(decimals)}%`;
}

function getClusterTone(cluster = {}) {
  const netPct = Number((cluster || {}).netClusterPct) || 0;
  if (netPct > 2) return { key: 'long', label: 'Long-biased' };
  if (netPct < -2) return { key: 'short', label: 'Short-biased' };
  return { key: 'offset', label: 'Offsetting' };
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

function ExposureBar({ label, pct, variant = 'neutral', signed = false, tooltip, scaleMin = -150, scaleMax = 150 }) {
  const display = formatExposurePct(pct, { signed });
  const value = pct != null && Number.isFinite(pct) ? pct : 0;
  const scaleRange = scaleMax - scaleMin;

  // Calculate positions as percentages of the scale
  const zeroPos = ((0 - scaleMin) / scaleRange) * 100;
  const valuePos = ((value - scaleMin) / scaleRange) * 100;

  // Determine bar segment: from zero to value
  const barStart = Math.min(zeroPos, valuePos);
  const barWidth = Math.abs(valuePos - zeroPos);

  // Color mapping
  const colorMap = {
    positive: '#059669',
    negative: '#dc2626',
    blue: '#2563eb',
    neutral: '#9ca3af',
  };
  const barColor = colorMap[variant] || colorMap.neutral;

  // Tick marks at -150, -100, -50, 0, 50, 100, 150
  const ticks = [-150, -100, -50, 0, 50, 100, 150];

  return (
    <div className="pf-bar" title={tooltip || undefined}>
      <div className="pf-bar__row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span className="pf-label">{label}</span>
        <span className={`pf-bar__value pf-bar__value--${variant}`} style={{ marginLeft: 'auto' }}>{display}</span>
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
          {value !== 0 && (
            <div
              className="pf-bar__segment"
              style={{
                left: `${barStart}%`,
                width: `${barWidth}%`,
                backgroundColor: barColor,
              }}
            />
          )}

          {/* Zero marker when value is exactly 0 */}
          {value === 0 && (
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

const KNOWN_ACCOUNT_IDS = Object.keys(IBKR_ACCOUNT_LABELS);

const PortfolioSidebarSnapshot = ({
  portfolioData,
  portfolioAccountsData = [],
  rtaPositions,
  etfProSnapshot,
  loading = false,
  accounts = [],
  connection = null,
  selectedAccount,
  onAccountChange,
  onRefresh,
  expandedUp = false,
  onToggleExpandUp,
}) => {
  const [sessionClock, setSessionClock] = useState(() => Date.now());
  const [cachedCloseSnapshot, setCachedCloseSnapshot] = useState(null);

  useEffect(() => {
    const interval = window.setInterval(() => setSessionClock(Date.now()), 60000);
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

  const isPortfolioLive = portfolioData?.dataSource === 'ibkr_api';
  const isSyncPending = isPortfolioSyncPending({ connection, portfolioData });
  const showPortfolioContent = isPortfolioLive || isSyncPending;

  const exposure = computePortfolioExposure({
    holdings: portfolioData?.holdings || [],
    accountSummary: portfolioData?.accountSummary,
    summary: portfolioData?.summary,
  });
  const currency = portfolioData?.accountSummary?.currency || 'USD';
  const sidebarBanner = getPortfolioSidebarBanner({ portfolioData, selectedAccount });
  const qualityWarnings = useMemo(() => {
    const warnings = [];
    if (Array.isArray(portfolioData?.reconciliationWarnings)) {
      warnings.push(...portfolioData.reconciliationWarnings);
    }
    if (Array.isArray(portfolioData?.dataQuality?.warnings)) {
      warnings.push(...portfolioData.dataQuality.warnings);
    }
    if (etfProSnapshot?.dataQuality?.status && etfProSnapshot.dataQuality.status !== 'ok') {
      warnings.push(...(etfProSnapshot.dataQuality.warnings || ['ETF Pro update is partial']));
    }
    const rtaWarnings = rtaPositions?.sourceDiagnostics?.reconstructionWarnings || rtaPositions?.reconstructionWarnings || [];
    if (Array.isArray(rtaWarnings) && rtaWarnings.length > 0) {
      warnings.push(...rtaWarnings.map((warning) => `RTA: ${warning}`));
    }
    return [...new Set(warnings)].slice(0, 3);
  }, [
    portfolioData?.reconciliationWarnings,
    portfolioData?.dataQuality,
    etfProSnapshot?.dataQuality,
    rtaPositions?.sourceDiagnostics,
    rtaPositions?.reconstructionWarnings,
  ]);
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
    () => getIbkrPortfolioStatusDot({ connection, portfolioData, loading }),
    [connection, portfolioData, loading],
  );

  const offlinePanel = useMemo(
    () => getPortfolioOfflinePanel({ connection, portfolioData }),
    [connection, portfolioData],
  );
  const liveLongCount = useMemo(
    () => (portfolioData?.holdings || []).filter((holding) => (parseFloat(holding.marketValue) || 0) > 0).length,
    [portfolioData?.holdings],
  );
  const liveShortCount = useMemo(
    () => (portfolioData?.holdings || []).filter((holding) => (parseFloat(holding.marketValue) || 0) < 0).length,
    [portfolioData?.holdings],
  );
  const rtaLongCount = rtaPositions?.available ? (rtaPositions.longCount || 0) : null;
  const rtaShortCount = rtaPositions?.available ? (rtaPositions.shortCount || 0) : null;
  const { etfProLongCount, etfProShortCount, etfProAvailable } = useMemo(() => {
    const rows = Array.isArray(etfProSnapshot?.rows) ? etfProSnapshot.rows : [];
    if (rows.length === 0) {
      return { etfProLongCount: null, etfProShortCount: null, etfProAvailable: false };
    }
    return rows.reduce((acc, row) => {
      if (String(row.call || '').toLowerCase() === 'short') {
        acc.etfProShortCount += 1;
      } else {
        acc.etfProLongCount += 1;
      }
      return acc;
    }, { etfProLongCount: 0, etfProShortCount: 0, etfProAvailable: true });
  }, [etfProSnapshot?.rows]);
  const buildNetDisplay = useCallback((longCount, shortCount) => {
    const total = (longCount || 0) + (shortCount || 0);
    if (!total) {
      return {
        longWidth: 50,
        shortWidth: 50,
        markerLeft: 50,
        netPctText: '0%',
        tone: 'neutral',
      };
    }

    const longWidth = ((longCount || 0) / total) * 100;
    const shortWidth = ((shortCount || 0) / total) * 100;
    const netPct = (((longCount || 0) - (shortCount || 0)) / total) * 100;

    return {
      longWidth,
      shortWidth,
      markerLeft: longWidth,
      netPctText: `${netPct > 0 ? '+' : ''}${Math.round(netPct)}%`,
      tone: netPct > 0 ? 'long' : netPct < 0 ? 'short' : 'neutral',
    };
  }, []);
  const liveNetBar = useMemo(() => {
    return buildNetDisplay(liveLongCount, liveShortCount);
  }, [buildNetDisplay, liveLongCount, liveShortCount]);
  const rtaNetBar = useMemo(() => {
    return buildNetDisplay(rtaLongCount || 0, rtaShortCount || 0);
  }, [buildNetDisplay, rtaLongCount, rtaShortCount]);
  const etfProNetBar = useMemo(() => {
    return buildNetDisplay(etfProLongCount || 0, etfProShortCount || 0);
  }, [buildNetDisplay, etfProLongCount, etfProShortCount]);

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

  const correlationLens = usePortfolioCorrelationConcentration({
    holdings: portfolioData?.holdings || [],
    totalValue: exposure.nlv,
    enabled: showMetrics,
  });

  const correlationClusters = useMemo(() => (
    [...(correlationLens.data?.clusters || [])]
      .sort((a, b) => (b.correlationAdjustedGrossPct || 0) - (a.correlationAdjustedGrossPct || 0))
      .slice(0, 3)
  ), [correlationLens.data?.clusters]);
  const topCorrelationCluster = correlationClusters[0] || null;
  const topClusterTone = getClusterTone(topCorrelationCluster);
  const unscoredCorrelationItems = (correlationLens.data?.unscored || []).slice(0, 3);

  return (
    <div className="pf-snapshot">
      <header className="pf-header">
        <div className="pf-header__top">
          <div className="pf-header__brand">
            <div className="pf-header__logo" aria-hidden="true">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.5" />
                <path
                  d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
              </svg>
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
              disabled={loading}
              title="Refresh portfolio"
              aria-label="Refresh portfolio"
            >
              <RefreshCw className={`pf-icon-btn__arrow${loading ? ' pf-spin' : ''}`} size={15} strokeWidth={2} />
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
        {loading && (
        <div className="pf-loading pf-loading--centered">
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

          {/* Portfolio / signal count comparison */}
          <div className="pf-metrics-row">
            <div className="pf-position-compare" role="table" aria-label="Portfolio versus RTA and ETF Pro position comparison">
              <div className="pf-position-compare__header pf-position-compare__cell" />
              <div className="pf-position-compare__header pf-position-compare__cell">Portfolio count</div>
              <div className="pf-position-compare__header pf-position-compare__cell">RTA signal count</div>
              <div className="pf-position-compare__header pf-position-compare__cell">ETF Pro</div>

              <div className="pf-position-compare__label pf-position-compare__label--long pf-position-compare__cell">Long</div>
              <div className="pf-position-compare__value pf-position-compare__value--long pf-position-compare__cell tabular-nums">
                {liveLongCount}
              </div>
              <div className="pf-position-compare__value pf-position-compare__value--long pf-position-compare__cell tabular-nums">
                {rtaLongCount ?? '—'}
              </div>
              <div className="pf-position-compare__value pf-position-compare__value--long pf-position-compare__cell tabular-nums">
                {etfProLongCount ?? '—'}
              </div>

              <div className="pf-position-compare__label pf-position-compare__label--short pf-position-compare__cell">Short</div>
              <div className="pf-position-compare__value pf-position-compare__value--short pf-position-compare__cell tabular-nums">
                {liveShortCount}
              </div>
              <div className="pf-position-compare__value pf-position-compare__value--short pf-position-compare__cell tabular-nums">
                {rtaShortCount ?? '—'}
              </div>
              <div className="pf-position-compare__value pf-position-compare__value--short pf-position-compare__cell tabular-nums">
                {etfProShortCount ?? '—'}
              </div>

              <div className="pf-position-compare__label pf-position-compare__cell">Net</div>
              <div className="pf-position-compare__cell">
                <div className="pf-netbar-wrap">
                  <div className={`pf-netbar__pct pf-netbar__pct--${liveNetBar.tone}`}>{liveNetBar.netPctText}</div>
                  <div className="pf-netbar" aria-hidden="true">
                    <div className="pf-netbar__segment pf-netbar__segment--long" style={{ width: `${liveNetBar.longWidth}%` }} />
                    <div className="pf-netbar__segment pf-netbar__segment--short" style={{ width: `${liveNetBar.shortWidth}%` }} />
                    <div className="pf-netbar__marker" style={{ left: `${liveNetBar.markerLeft}%` }} />
                  </div>
                </div>
              </div>
              <div className="pf-position-compare__cell">
                <div className={`pf-netbar-wrap${rtaPositions?.available ? '' : ' pf-netbar-wrap--muted'}`}>
                  <div className={`pf-netbar__pct pf-netbar__pct--${rtaNetBar.tone}`}>{rtaNetBar.netPctText}</div>
                  <div className="pf-netbar" aria-hidden="true">
                    <div className="pf-netbar__segment pf-netbar__segment--long" style={{ width: `${rtaNetBar.longWidth}%` }} />
                    <div className="pf-netbar__segment pf-netbar__segment--short" style={{ width: `${rtaNetBar.shortWidth}%` }} />
                    <div className="pf-netbar__marker" style={{ left: `${rtaNetBar.markerLeft}%` }} />
                  </div>
                </div>
              </div>
              <div className="pf-position-compare__cell">
                <div className={`pf-netbar-wrap${etfProAvailable ? '' : ' pf-netbar-wrap--muted'}`}>
                  <div className={`pf-netbar__pct pf-netbar__pct--${etfProNetBar.tone}`}>{etfProNetBar.netPctText}</div>
                  <div className="pf-netbar" aria-hidden="true">
                    <div className="pf-netbar__segment pf-netbar__segment--long" style={{ width: `${etfProNetBar.longWidth}%` }} />
                    <div className="pf-netbar__segment pf-netbar__segment--short" style={{ width: `${etfProNetBar.shortWidth}%` }} />
                    <div className="pf-netbar__marker" style={{ left: `${etfProNetBar.markerLeft}%` }} />
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Exposure */}
          <div className="pf-section">
            <div className="pf-bars">
              <ExposureBar label="Gross Exposure" pct={exposure.grossPct} variant="blue" />
              <ExposureBar label="Net Exposure" pct={exposure.netPct} variant="positive" signed />
              <ExposureBar label="Long Exposure" pct={exposure.longPct} variant="positive" />
              <ExposureBar label="Short Exposure" pct={exposure.shortPct} variant="negative" />
              <ExposureBar label="CASH" pct={exposure.cashPct} variant="neutral" tooltip={IDLE_CASH_TOOLTIP} />
            </div>
          </div>

          <div className="pf-section pf-corr-lens">
            <div className="pf-corr-lens__head">
              <div className="pf-section__head">Correlation / Exposure</div>
              <div className="pf-corr-lens__actions">
                {correlationLens.loading && correlationLens.data ? (
                  <LoadingIndicator label="Updating..." size="sm" className="pf-corr-lens__updating" />
                ) : null}
                <RefreshButton
                  onClick={correlationLens.refresh}
                  loading={correlationLens.loading}
                  disabled={!correlationLens.hasInput}
                  label={correlationLens.data ? 'Refresh' : 'Calculate'}
                  className="pf-corr-lens__refresh"
                />
              </div>
            </div>

            {correlationLens.loading && !correlationLens.data ? (
              <LoadingIndicator label="Calculating correlation..." size="sm" centered className="pf-corr-lens__loading" />
            ) : null}

            {!correlationLens.loading && correlationLens.error && !correlationLens.data ? (
              <div className="pf-corr-lens__state pf-corr-lens__state--error">{correlationLens.error}</div>
            ) : null}

            {!correlationLens.loading && !correlationLens.error && !correlationLens.data ? (
              <div className="pf-corr-lens__state">No correlation data available.</div>
            ) : null}

            {correlationLens.data && correlationLens.error ? (
              <div className="pf-corr-lens__state pf-corr-lens__state--error">
                Showing previous snapshot. Refresh failed: {correlationLens.error}
              </div>
            ) : null}

            {correlationLens.data ? (
              <>
                <div className="pf-corr-lens__kpis">
                  <div>
                    <span>Effective Bets</span>
                    <strong>{correlationLens.data.scores?.effectiveIndependentBets ?? '--'}</strong>
                  </div>
                  <div>
                    <span>Concentration</span>
                    <strong>{correlationLens.data.scores?.concentrationScore ?? '--'}</strong>
                  </div>
                  <div>
                    <span>Largest</span>
                    <strong>{formatLensPct(correlationLens.data.scores?.largestClusterPct || 0)}</strong>
                  </div>
                  <div>
                    <span>Coverage</span>
                    <strong>{formatLensPct(correlationLens.data.coverage?.scoredPct || 0)}</strong>
                  </div>
                </div>

                {topCorrelationCluster ? (
                  <div className={`pf-corr-lens__hero pf-corr-lens__hero--${topClusterTone.key}`}>
                    <div className="pf-corr-lens__hero-main">
                      <span>{topClusterTone.label}</span>
                      <strong>{topCorrelationCluster.label}</strong>
                    </div>
                    <div className="pf-corr-lens__hero-stats">
                      <span>Gross {formatLensPct(topCorrelationCluster.grossClusterPct || 0)}</span>
                      <span>Net {formatLensPct(topCorrelationCluster.netClusterPct || 0, 1, { signed: true })}</span>
                    </div>
                    <div className="pf-corr-lens__members">
                      {(topCorrelationCluster.members || []).slice(0, 5).map((member) => (
                        <span key={member.symbol}>{member.symbol}</span>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="pf-corr-lens__state">No correlated clusters yet.</div>
                )}

                {correlationClusters.length > 0 ? (
                  <div className="pf-corr-lens__clusters" aria-label="Top correlated clusters">
                    {correlationClusters.map((cluster) => {
                      const tone = getClusterTone(cluster);
                      return (
                        <div key={cluster.id} className="pf-corr-lens__cluster-row">
                          <span className={`pf-corr-lens__tone pf-corr-lens__tone--${tone.key}`}>{tone.label}</span>
                          <span className="pf-corr-lens__cluster-name">{cluster.label}</span>
                          <span className="pf-corr-lens__cluster-value">{formatLensPct(cluster.correlationAdjustedGrossPct || cluster.grossClusterPct || 0)}</span>
                        </div>
                      );
                    })}
                  </div>
                ) : null}

                <div className="pf-corr-lens__coverage">
                  <span>Cash {formatLensPct(correlationLens.data.coverage?.cashPct || 0)}</span>
                  <span>Unscored {correlationLens.data.coverage?.unscoredCount || 0}</span>
                  {unscoredCorrelationItems.map((item) => (
                    <span key={`${item.symbol}-${item.reason}`}>{item.symbol}</span>
                  ))}
                </div>
              </>
            ) : null}
          </div>

          {showPortfolioContent && qualityWarnings.length > 0 && !loading && (
            <div className="pf-banner pf-banner--warning">
              {qualityWarnings.join(' · ')}
            </div>
          )}

        </div>

      )}
      </div>
    </div>
  );
};

export default PortfolioSidebarSnapshot;
