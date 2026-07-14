import React, { useMemo, useEffect, useCallback, useState } from 'react';
import { ArrowRight, RefreshCw } from 'lucide-react';
import StatusDot from '../../common/StatusDot';
import LoadingIndicator from '../../common/LoadingIndicator';
import PopoverSelect from '../../common/PopoverSelect';
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
import { getLongShortPositionSnapshot } from '../../../utils/portfolioBreakdownUtils';
import {
  buildHedgeyeLatestUpdatesFeed,
  buildHedgeyeLatestUpdatesStatus,
  formatHedgeyeFeedTime,
} from '../../../utils/hedgeyeLatestUpdatesFeed';
import { saveSelectedAccount, loadIbkrAccounts, saveIbkrAccounts } from '../../../constants/ibkrAccountStorage';
import { formatIbkrAccountLabel, IBKR_ACCOUNT_LABELS } from '../../../constants/ibkrAccountLabels';
import portfolioFolderIcon from '../../../assets/portfolio-folder-icon.png';
import './PortfolioSidebarSnapshot.css';

const STRATEGY_SUBTITLE = 'Long/Short Global Macro';
const PORTFOLIO_CLOSE_CACHE_PREFIX = 'portfolioCloseSnapshot:';
const FLEX_RECONCILIATION_TOLERANCE_PCT = 2.5;

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

function ExposureBar({ label, pct, amount, currency = 'USD', netAmount = false, tooltip, scaleMin = -200, scaleMax = 200 }) {
  const display = formatExposurePct(pct);
  const amountDisplay = netAmount ? formatSignedNominal(amount) : formatCurrency(amount, currency);
  const hasAmount = amountDisplay !== '—';
  const segmentTestId = `exposure-segment-${label.toLowerCase().replace(/\s+/g, '-')}`;
  const value = pct != null && Number.isFinite(pct) ? pct : 0;
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
    <div className="pf-bar" title={tooltip || undefined}>
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
          {value !== 0 && barWidth > 0 && (
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

const PortfolioSidebarSnapshot = ({
  portfolioData,
  portfolioAccountsData = [],
  rtaPositions,
  etfProSnapshot,
  exposureReconciliation,
  exposureReconciliationLoading = false,
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
    }),
    [connection, portfolioData, loading, rtaPositions, etfProSnapshot, predictionMarketProviderStatus],
  );

  const offlinePanel = useMemo(
    () => getPortfolioOfflinePanel({ connection, portfolioData }),
    [connection, portfolioData],
  );
  const { longCount: liveLongCount, shortCount: liveShortCount } = useMemo(
    () => resolvePositionSideCounts(portfolioData),
    [portfolioData],
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
        {loading && !showMetrics && (
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
              <div className="pf-position-compare__header pf-position-compare__cell">Portfolio</div>
              <div className="pf-position-compare__header pf-position-compare__cell">RTA</div>
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
              <ExposureBar
                label="Gross Exposure"
                pct={exposure.grossPct}
                amount={exposure.longMV + exposure.shortMV}
                currency={currency}
              />
              <ExposureBar
                label="Net Exposure"
                pct={exposure.netPct}
                amount={exposure.netMV}
                netAmount
                currency={currency}
              />
              <ExposureBar
                label="Long Exposure"
                pct={exposure.longPct}
                amount={exposure.longMV}
                currency={currency}
              />
              <ExposureBar
                label="Short Exposure"
                pct={exposure.shortPct}
                amount={exposure.shortMV}
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
            liveExposure={exposure}
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

        </div>

      )}
      </div>
    </div>
  );
};

export default PortfolioSidebarSnapshot;
