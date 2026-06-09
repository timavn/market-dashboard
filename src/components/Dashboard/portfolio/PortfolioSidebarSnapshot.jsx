import React, { useMemo, useEffect, useCallback } from 'react';
import { RefreshCw } from 'lucide-react';
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
} from '../../../utils/portfolioExposureMetrics';
import { saveSelectedAccount, loadIbkrAccounts, saveIbkrAccounts } from '../../../constants/ibkrAccountStorage';
import { SECURITY_CATEGORY_MAPPING } from '../../../constants/securityCategoryMapping';
import { formatIbkrAccountLabel, IBKR_ACCOUNT_LABELS } from '../../../constants/ibkrAccountLabels';
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
  rtaPositions,
  loading = false,
  accounts = [],
  connection = null,
  selectedAccount,
  onAccountChange,
  onRefresh,
  expandedUp = false,
  onToggleExpandUp,
}) => {
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

  const statusDot = useMemo(
    () => getIbkrPortfolioStatusDot({ connection, portfolioData, loading }),
    [connection, portfolioData, loading],
  );

  const topFactorExposures = useMemo(() => {
    const holdings = portfolioData?.holdings || [];
    const totalValue = exposure.nlv || 0;
    if (totalValue === 0 || holdings.length === 0) return [];
    const factorMap = {};
    holdings.forEach(holding => {
      const mv = Math.abs(parseFloat(holding.marketValue) || 0);
      const mapping = SECURITY_CATEGORY_MAPPING[holding.symbol?.toUpperCase()];
      if (mapping?.category) {
        factorMap[mapping.category] = (factorMap[mapping.category] || 0) + mv;
      }
    });
    return Object.entries(factorMap)
      .map(([factor, value]) => ({ factor, pct: (value / totalValue) * 100 }))
      .sort((a, b) => b.pct - a.pct)
      .slice(0, 5);
  }, [portfolioData?.holdings, exposure.nlv]);

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
              title={expandedUp ? "Collapse construction" : "Expand construction"}
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
              label: formatIbkrAccountLabel(acct),
            }))}
            onChange={(value) => {
              saveSelectedAccount(value);
              onAccountChange(value);
            }}
            buttonClassName="pf-account-select"
            menuClassName="min-w-[200px]"
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

          {/* 3-col top metrics */}
          <div className="pf-metrics-row">
            <div className="pf-metric">
              <span className="pf-label">Net Liquidation</span>
              <span className="pf-metric__value tabular-nums">
                {formatCurrency(exposure.nlv, currency)}
              </span>
              <span className="pf-metric__hint">Total account value</span>
            </div>
            <div className="pf-position-compare" role="table" aria-label="Portfolio versus RTA position comparison">
              <div className="pf-position-compare__header pf-position-compare__cell" />
              <div className="pf-position-compare__header pf-position-compare__cell">Portfolio count</div>
              <div className="pf-position-compare__header pf-position-compare__cell">RTA signal count</div>

              <div className="pf-position-compare__label pf-position-compare__label--long pf-position-compare__cell">Long</div>
              <div className="pf-position-compare__value pf-position-compare__value--long pf-position-compare__cell tabular-nums">
                {liveLongCount}
              </div>
              <div className="pf-position-compare__value pf-position-compare__value--long pf-position-compare__cell tabular-nums">
                {rtaLongCount ?? '—'}
              </div>

              <div className="pf-position-compare__label pf-position-compare__label--short pf-position-compare__cell">Short</div>
              <div className="pf-position-compare__value pf-position-compare__value--short pf-position-compare__cell tabular-nums">
                {liveShortCount}
              </div>
              <div className="pf-position-compare__value pf-position-compare__value--short pf-position-compare__cell tabular-nums">
                {rtaShortCount ?? '—'}
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

          {/* Portfolio Construction - only shown when expanded */}
          {expandedUp && (topFactorExposures.length > 0 || exposure.nlv != null) && (
            <div className="pf-section">
              <div className="pf-section__head">Portfolio Construction</div>
              <div className="pf-section__divider" />

              {/* Top 5 Factors */}
              {topFactorExposures.length > 0 && (
                <div className="pf-construct-card pf-construct-card--blue">
                  <div className="pf-construct-card__title" style={{ color: 'var(--pf-blue)' }}>Top 5 Factors</div>
                  <div className="pf-construct-list">
                    {topFactorExposures.map((item, idx) => (
                      <div key={idx} className="pf-construct-row">
                        <span>{item.factor}</span>
                        <span className="pf-construct-row__val">{item.pct.toFixed(1)}%</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Basis Points */}
              {exposure.nlv != null && (
                <div className="pf-construct-card pf-construct-card--neutral" style={{ marginTop: '4px' }}>
                  <div className="pf-construct-card__title">Basis Points</div>
                  <div className="pf-construct-bps">
                    {[25, 75, 125, 175, 225].map((bps, i) => (
                      <React.Fragment key={bps}>
                        <div className="pf-construct-row">
                          <span>{bps}:</span>
                          <span className="pf-construct-row__val">${Math.floor(exposure.nlv * bps / 10000).toLocaleString()}</span>
                        </div>
                        <div className="pf-construct-row">
                          <span>{bps + 25}:</span>
                          <span className="pf-construct-row__val">${Math.floor(exposure.nlv * (bps + 25) / 10000).toLocaleString()}</span>
                        </div>
                      </React.Fragment>
                    ))}
                  </div>
                </div>
              )}

              {/* Longs / Shorts sizing */}
              <div className="pf-construct-ls" style={{ marginTop: '4px' }}>
                <div className="pf-construct-card pf-construct-card--green">
                  <div className="pf-construct-card__title" style={{ color: 'var(--pf-green)' }}>Longs</div>
                  <div className="pf-construct-list">
                    <div className="pf-construct-row"><span>FX:</span><span className="pf-construct-row__val">4–12%</span></div>
                    <div className="pf-construct-row"><span>FI:</span><span className="pf-construct-row__val">3–10%</span></div>
                    <div className="pf-construct-row"><span>Eq:</span><span className="pf-construct-row__val">2–6%</span></div>
                    <div className="pf-construct-row"><span>Com:</span><span className="pf-construct-row__val">2–4%</span></div>
                    <div className="pf-construct-row"><span>Crypto:</span><span className="pf-construct-row__val">1–3%</span></div>
                  </div>
                </div>
                <div className="pf-construct-card pf-construct-card--red">
                  <div className="pf-construct-card__title" style={{ color: 'var(--pf-red)' }}>Shorts</div>
                  <div className="pf-construct-list">
                    <div className="pf-construct-row"><span>FX:</span><span className="pf-construct-row__val">2–6%</span></div>
                    <div className="pf-construct-row"><span>FI:</span><span className="pf-construct-row__val">2–5%</span></div>
                    <div className="pf-construct-row"><span>Eq:</span><span className="pf-construct-row__val">1–3%</span></div>
                    <div className="pf-construct-row"><span>Com:</span><span className="pf-construct-row__val">1–2%</span></div>
                    <div className="pf-construct-row"><span>Crypto:</span><span className="pf-construct-row__val">0.5–1%</span></div>
                  </div>
                </div>
              </div>

            </div>
          )}

        </div>

      )}
      </div>
    </div>
  );
};

export default PortfolioSidebarSnapshot;
