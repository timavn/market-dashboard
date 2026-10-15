import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSurfaceActivity } from '../common/PersistentSurface';
import { useDashboardResource } from '../../hooks/useDashboardResource';
import { MarketDataService } from '../../services/api/marketDataService';
import { SECURITY_INTELLIGENCE_V2_ENABLED } from '../../hooks/useSecurityIntelligence';
import { canonicalProductState, getCanonicalRiskRange } from '../../utils/securityIntelligenceV2';
import { SECURITIES_LIST, ASSET_CLASS_NAMES } from '../../constants/securitiesList';
import ReferencePanelShell from './ReferencePanelShell';
import ResourceDataStatusChip from './ResourceDataStatusChip';
import { startVisibilityAwarePolling } from '../../utils/visibilityAwarePolling';

const QUOTE_POLL_MS = 30000;
const RISK_RANGE_POLL_MS = 5 * 60 * 1000;
const LIVE_QUOTE_MAX_AGE_MS = 60 * 1000;
const PAGE_SIZE = 25;

const asNumber = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const formatNumber = (value, digits = 2) => (
  Number.isFinite(value) ? value.toFixed(digits) : '—'
);

const formatPercent = (value, digits = 1) => {
  if (!Number.isFinite(value)) return '—';
  return `${value > 0 ? '+' : ''}${value.toFixed(digits)}%`;
};

const formatDate = (value) => {
  if (!value) return '—';
  const date = new Date(String(value).includes('T') ? value : `${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleDateString();
};

const isIbkrConnected = (status) => Boolean(
  status?.ibkr?.connected ||
  status?.ibkr?.status === 'connected' ||
  status?.portfolio?.ibkr?.connected ||
  status?.portfolio?.ibkr?.status === 'connected'
);

export const isVerifiedLiveQuote = (quote, providerStatus, now = Date.now()) => {
  if (!isIbkrConnected(providerStatus)) return false;
  if (!quote || quote.source !== 'ibkr') return false;
  if (quote.dataType === 'delayed' || quote.dataType === 'delayed_frozen') return false;
  if (/stale|cache_only|mock|seed/i.test(String(quote.warning || ''))) return false;
  const price = asNumber(quote.price ?? quote.mark);
  const timestamp = new Date(quote.timestamp || 0).getTime();
  return Boolean(
    price > 0 &&
    Number.isFinite(timestamp) &&
    now - timestamp >= 0 &&
    now - timestamp <= LIVE_QUOTE_MAX_AGE_MS
  );
};

export const buildHistoryReturns = (history) => {
  const rows = Array.isArray(history?.data) ? history.data : [];
  const closes = rows
    .map((row) => ({ date: row?.date || row?.timestamp || null, close: asNumber(row?.close) }))
    .filter((row) => row.close > 0);
  if (closes.length < 2) return { weekly: null, monthly: null, asOf: null };
  const last = closes[closes.length - 1];
  const weekBase = closes[Math.max(0, closes.length - 6)].close;
  const monthBase = closes[0].close;
  return {
    weekly: ((last.close - weekBase) / weekBase) * 100,
    monthly: ((last.close - monthBase) / monthBase) * 100,
    asOf: last.date,
  };
};

const getRangePosition = (quote, range) => {
  const spot = asNumber(quote?.price ?? quote?.mark);
  const low = asNumber(range?.lrr);
  const high = asNumber(range?.hrr);
  if (!(spot > 0) || !(high > low)) return null;
  return ((spot - low) / (high - low)) * 100;
};

const sortMaybe = (a, b, direction) => {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  const result = typeof a === 'string'
    ? a.localeCompare(b)
    : Number(a) - Number(b);
  return direction === 'asc' ? result : -result;
};

const ChangePills = ({ values, tone }) => (
  <div className="reference-pill-row">
    {values.length ? values.map((ticker) => (
      <span key={ticker} className={`reference-pill reference-pill--${tone}`}>{ticker}</span>
    )) : <span className="reference-empty-inline">None</span>}
  </div>
);

const Movers = ({ values }) => (
  <div className="reference-pill-row">
    {values.length ? values.map((item) => (
      <span key={item.ticker} className={`reference-pill ${item.value >= 0 ? 'reference-pill--positive' : 'reference-pill--negative'}`}>
        {item.ticker} {formatPercent(item.value)}
      </span>
    )) : <span className="reference-empty-inline">Waiting for close history</span>}
  </div>
);

const SignalStrengthPanel = ({
  onClose,
  changelog,
  changelogLoading = false,
  changelogError = null,
  onRefreshChangelog,
}) => {
  const active = useSurfaceActivity();
  const [quotes, setQuotes] = useState({});
  const [histories, setHistories] = useState({});
  const [providerStatus, setProviderStatus] = useState(null);
  const [quoteLoading, setQuoteLoading] = useState(true);
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState('');
  const [assetClass, setAssetClass] = useState('all');
  const [bias, setBias] = useState('all');
  const [sort, setSort] = useState({ key: 'ticker', direction: 'asc' });
  const [page, setPage] = useState(0);
  const mountedRef = useRef(true);
  const activeRef = useRef(active);
  const quoteLoadedKeyRef = useRef(null);
  const quoteRefreshCompletedAtRef = useRef(0);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => () => {
    mountedRef.current = false;
  }, []);

  const loadResearchSnapshot = useCallback(async () => {
    if (SECURITY_INTELLIGENCE_V2_ENABLED) {
      const payload = await MarketDataService.getSecurityIntelligenceV2({
        symbols: SECURITIES_LIST.map((security) => security.ticker),
        historyDays: 0,
      });
      if (payload?.schemaVersion !== 2) {
        throw new Error('Canonical security intelligence returned an unsupported schema.');
      }
      const nextRanges = {};
      const nextIntelligence = {};
      SECURITIES_LIST.forEach((security) => {
        const ticker = security.ticker.toUpperCase();
        const entry = payload.bySymbol?.[ticker] || null;
        const product = entry?.products?.['risk-ranges'] || null;
        const range = getCanonicalRiskRange(entry, { primaryOnly: true });
        const status = canonicalProductState(product);
        const signalProduct = entry?.products?.['signal-strength'] || null;
        nextRanges[ticker] = range
          ? { ...range, date: range.date, status }
          : { lrr: null, hrr: null, trend: null, date: null, status };
        nextIntelligence[ticker] = {
          health: entry?.health?.status || 'unavailable',
          rangeStatus: status,
          action: signalProduct?.fields?.action?.value || null,
          marketDate: entry?.marketDate || payload.marketDate || null,
        };
      });
      return {
        riskRanges: nextRanges,
        securityIntelligence: nextIntelligence,
        snapshot: null,
        observedAt: payload.marketDate || payload.generatedAt || payload.fetchedAt,
      };
    }
    const [ranges, nextSnapshot] = await Promise.all([
      MarketDataService.getRiskRanges(SECURITIES_LIST.map((security) => security.ticker)),
      MarketDataService.getHedgeyeSnapshot('signal-strength'),
    ]);
    const rangeDates = Object.values(ranges || {}).map((row) => row?.date).filter(Boolean).sort();
    return {
      riskRanges: ranges || {},
      securityIntelligence: {},
      snapshot: nextSnapshot || null,
      observedAt: nextSnapshot?.date || nextSnapshot?.publishedAt || rangeDates.at(-1) || null,
    };
  }, []);

  const validateResearchSnapshot = useCallback((value) => (
    value
    && typeof value === 'object'
    && value.riskRanges
    && typeof value.riskRanges === 'object'
    && value.observedAt
      ? value
      : null
  ), []);

  const researchResource = useDashboardResource('signal-strength-research', {}, {
    fetcher: loadResearchSnapshot,
    validate: validateResearchSnapshot,
    getObservedAt: (value) => value.observedAt,
    pollIntervalMs: RISK_RANGE_POLL_MS,
    active,
    refreshOnActivate: false,
  });
  const riskRanges = researchResource.data?.riskRanges || {};
  const securityIntelligence = researchResource.data?.securityIntelligence || {};
  const snapshot = researchResource.data?.snapshot || null;
  const metadataLoading = researchResource.initialLoading && !researchResource.data;
  const refreshing = manualRefreshing || researchResource.refreshing;

  const canonicalChangeData = useMemo(() => {
    if (!SECURITY_INTELLIGENCE_V2_ENABLED) return null;
    const added = [];
    const removed = [];
    Object.entries(securityIntelligence).forEach(([ticker, value]) => {
      if (value?.action === 'ADDED') added.push(ticker);
      if (value?.action === 'REMOVED') removed.push(ticker);
    });
    return {
      added: added.sort(),
      removed: removed.sort(),
      currentDate: Object.values(securityIntelligence)
        .map((value) => value?.marketDate)
        .filter(Boolean)
        .sort()
        .at(-1) || null,
    };
  }, [securityIntelligence]);
  const changeData = (SECURITY_INTELLIGENCE_V2_ENABLED ? canonicalChangeData : changelog?.['signal-strength']) || {};
  const riskRangeDate = useMemo(() => {
    const dates = Object.values(riskRanges).map((row) => row?.date).filter(Boolean).sort();
    return dates[dates.length - 1] || null;
  }, [riskRanges]);

  const rows = useMemo(() => SECURITIES_LIST.map((security) => {
    const ticker = security.ticker.toUpperCase();
    const range = riskRanges[ticker] || null;
    const intelligence = securityIntelligence[ticker] || null;
    const quote = quotes[ticker] || null;
    const history = histories[ticker] || { weekly: null, monthly: null, asOf: null };
    const verifiedQuote = isVerifiedLiveQuote(quote, providerStatus) ? quote : null;
    return {
      ...security,
      ticker,
      range,
      quote: verifiedQuote,
      spot: verifiedQuote ? asNumber(verifiedQuote.price ?? verifiedQuote.mark) : null,
      trend: range?.trend || null,
      lrr: asNumber(range?.lrr),
      hrr: asNumber(range?.hrr),
      rangePosition: getRangePosition(verifiedQuote, range),
      researchHealth: intelligence?.health || null,
      researchStatus: intelligence?.rangeStatus || null,
      weekly: history.weekly,
      monthly: history.monthly,
      historyAsOf: history.asOf,
    };
  }), [histories, providerStatus, quotes, riskRanges, securityIntelligence]);

  const filteredRows = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return rows
      .filter((row) => assetClass === 'all' || row.assetClass === assetClass)
      .filter((row) => bias === 'all' || String(row.trend || '').toLowerCase() === bias)
      .filter((row) => !normalizedQuery || `${row.ticker} ${row.name}`.toLowerCase().includes(normalizedQuery))
      .sort((a, b) => sortMaybe(a[sort.key], b[sort.key], sort.direction));
  }, [assetClass, bias, query, rows, sort]);

  useEffect(() => setPage(0), [assetClass, bias, query]);
  const pageCount = Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const visibleRows = useMemo(
    () => filteredRows.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE),
    [filteredRows, safePage]
  );
  const visibleTickers = useMemo(() => visibleRows.map((row) => row.ticker), [visibleRows]);
  const visibleTickerKey = visibleTickers.join(',');

  const loadProviderAndQuotes = useCallback(async () => {
    setQuoteLoading(true);
    try {
      const status = await MarketDataService.getProviderStatus();
      if (!mountedRef.current) return;
      setProviderStatus(status);
      if (!isIbkrConnected(status)) {
        quoteLoadedKeyRef.current = null;
        setQuotes({});
        return;
      }
      const nextQuotes = await MarketDataService.getQuotes(visibleTickers);
      if (!mountedRef.current) return;
      const verified = Object.fromEntries(
        Object.entries(nextQuotes || {}).filter(([, quote]) => isVerifiedLiveQuote(quote, status))
      );
      if (Object.keys(verified).length > 0) {
        quoteLoadedKeyRef.current = visibleTickerKey;
        quoteRefreshCompletedAtRef.current = Date.now();
      } else {
        quoteLoadedKeyRef.current = null;
      }
      setQuotes((current) => {
        const next = { ...current };
        visibleTickers.forEach((ticker) => delete next[ticker]);
        return { ...next, ...verified };
      });
    } catch (loadError) {
      if (!mountedRef.current) return;
      quoteLoadedKeyRef.current = null;
      setProviderStatus(null);
      setQuotes({});
      setError(loadError.message || 'Live spot quotes are unavailable.');
    } finally {
      if (mountedRef.current) setQuoteLoading(false);
    }
  }, [visibleTickerKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const historiesLoadingRef = useRef(false);
  const historiesCompleteRef = useRef(false);
  const loadHistories = useCallback(async () => {
    if (historiesLoadingRef.current || historiesCompleteRef.current) return;
    historiesLoadingRef.current = true;
    const securities = [...SECURITIES_LIST];
    const batchSize = 12;
    let completed = true;
    try {
      for (let index = 0; index < securities.length && mountedRef.current; index += batchSize) {
        if (!activeRef.current) {
          completed = false;
          break;
        }
        const batch = securities.slice(index, index + batchSize);
        const results = await Promise.all(batch.map(async (security) => {
          try {
            const history = await MarketDataService.getHistoricalData(security.ticker, 30);
            return [security.ticker.toUpperCase(), buildHistoryReturns(history)];
          } catch {
            return [security.ticker.toUpperCase(), { weekly: null, monthly: null, asOf: null }];
          }
        }));
        if (mountedRef.current && activeRef.current) {
          setHistories((current) => ({ ...current, ...Object.fromEntries(results) }));
        } else {
          completed = false;
        }
      }
    } finally {
      historiesLoadingRef.current = false;
      if (completed && activeRef.current) historiesCompleteRef.current = true;
    }
  }, []);

  const refreshAll = useCallback(async () => {
    setManualRefreshing(true);
    setError(null);
    await Promise.allSettled([
      loadProviderAndQuotes(),
      researchResource.refresh(),
      onRefreshChangelog?.(true),
    ]);
    if (mountedRef.current) {
      setManualRefreshing(false);
    }
  }, [loadProviderAndQuotes, onRefreshChangelog, researchResource]);

  const historiesStartedRef = useRef(false);
  useEffect(() => {
    if (!active) return;
    if (!historiesStartedRef.current || !historiesCompleteRef.current) {
      historiesStartedRef.current = true;
      loadHistories();
    }
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!active) return undefined;
    const retainedForScope = quoteLoadedKeyRef.current === visibleTickerKey;
    const elapsedMs = Date.now() - quoteRefreshCompletedAtRef.current;
    const initialDelayMs = retainedForScope
      ? Math.max(0, QUOTE_POLL_MS - elapsedMs)
      : 0;
    if (initialDelayMs <= 0) loadProviderAndQuotes();
    return startVisibilityAwarePolling({
      poll: loadProviderAndQuotes,
      intervalMs: QUOTE_POLL_MS,
      initialDelayMs: initialDelayMs <= 0 ? QUOTE_POLL_MS : initialDelayMs,
    });
  }, [active, loadProviderAndQuotes, visibleTickerKey]);

  const breadth = useMemo(() => rows.reduce((acc, row) => {
    const trend = String(row.trend || '').toUpperCase();
    if (trend === 'BULLISH') acc.bullish += 1;
    else if (trend === 'BEARISH') acc.bearish += 1;
    else if (trend === 'NEUTRAL') acc.neutral += 1;
    return acc;
  }, { bullish: 0, bearish: 0, neutral: 0 }), [rows]);

  const movers = useMemo(() => {
    const ranked = (key, direction) => rows
      .filter((row) => Number.isFinite(row[key]))
      .sort((a, b) => direction * (b[key] - a[key]))
      .slice(0, 5)
      .map((row) => ({ ticker: row.ticker, value: row[key] }));
    return {
      weeklyUp: ranked('weekly', 1),
      weeklyDown: ranked('weekly', -1),
      monthlyUp: ranked('monthly', 1),
      monthlyDown: ranked('monthly', -1),
    };
  }, [rows]);

  const toggleSort = (key) => setSort((current) => ({
    key,
    direction: current.key === key && current.direction === 'asc' ? 'desc' : 'asc',
  }));

  const liveConnected = isIbkrConnected(providerStatus);
  const liveCount = rows.filter((row) => row.quote).length;
  const snapshotDate = changeData.currentDate || snapshot?.date || null;
  const historyAsOf = Object.values(histories).map((item) => item?.asOf).filter(Boolean).sort().pop();

  return (
    <ReferencePanelShell
      title="SS"
      subtitle={`Signal Strength reference · product ${formatDate(snapshotDate)} · ranges ${formatDate(riskRangeDate)} · returns through ${formatDate(historyAsOf)}`}
      status={liveConnected ? `IBKR live · ${liveCount} visible/loaded` : 'No live IBKR quotes'}
      statusTone={liveConnected ? 'live' : 'error'}
      statusIndicator={(
        <ResourceDataStatusChip
          resource={researchResource}
          context="Signal Strength research"
        />
      )}
      onRefresh={refreshAll}
      refreshing={refreshing}
      onClose={onClose}
    >
      {(error || researchResource.error?.message || changelogError) && (
        <div className="reference-alert reference-alert--error">
          {error || researchResource.error?.message || changelogError}
        </div>
      )}
      {!liveConnected && !quoteLoading && (
        <div className="reference-alert reference-alert--error">
          Live spot values are hidden because IBKR is disconnected or unavailable. Published ranges and close-to-close returns remain labeled by date.
        </div>
      )}

      <div className="reference-grid reference-grid--summary">
        <div className="reference-card reference-stat">
          <div className="reference-stat__label">Product Changes</div>
          <div className="reference-stat__value">{(changeData.added || []).length} / {(changeData.removed || []).length}</div>
          <div className="reference-stat__detail">Added / removed · {formatDate(snapshotDate)}</div>
        </div>
        <div className="reference-card reference-stat">
          <div className="reference-stat__label">Bullish</div>
          <div className="reference-stat__value reference-table__positive">{breadth.bullish}</div>
          <div className="reference-stat__detail">Current published risk-range trend</div>
        </div>
        <div className="reference-card reference-stat">
          <div className="reference-stat__label">Bearish</div>
          <div className="reference-stat__value reference-table__negative">{breadth.bearish}</div>
          <div className="reference-stat__detail">Current published risk-range trend</div>
        </div>
        <div className="reference-card reference-stat">
          <div className="reference-stat__label">Neutral</div>
          <div className="reference-stat__value">{breadth.neutral}</div>
          <div className="reference-stat__detail">Live spot coverage {liveCount}/{rows.length}</div>
        </div>
      </div>

      <div className="reference-change-grid">
        <div className="reference-card reference-change-card">
          <div className="reference-card__header"><span>Signal Strength Changes</span><span>{formatDate(snapshotDate)}</span></div>
          <div className="reference-change-card__body">
            <div><div className="reference-change-group__label">Added</div><ChangePills values={changeData.added || []} tone="positive" /></div>
            <div><div className="reference-change-group__label">Removed</div><ChangePills values={changeData.removed || []} tone="negative" /></div>
          </div>
        </div>
        <div className="reference-card reference-change-card">
          <div className="reference-card__header"><span>Close-to-Close Movers</span><span>{formatDate(historyAsOf)}</span></div>
          <div className="reference-change-card__body">
            <div><div className="reference-change-group__label">Weekly Leaders</div><Movers values={movers.weeklyUp} /></div>
            <div><div className="reference-change-group__label">Weekly Laggards</div><Movers values={movers.weeklyDown} /></div>
            <div><div className="reference-change-group__label">Monthly Leaders</div><Movers values={movers.monthlyUp} /></div>
            <div><div className="reference-change-group__label">Monthly Laggards</div><Movers values={movers.monthlyDown} /></div>
          </div>
        </div>
      </div>

      <div className="reference-card" style={{ marginTop: 6 }}>
        <div className="reference-toolbar">
          <input className="reference-input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search ticker or security" aria-label="Search SS securities" />
          <select className="reference-select" value={assetClass} onChange={(event) => setAssetClass(event.target.value)} aria-label="Filter SS asset class">
            <option value="all">All asset classes</option>
            {Object.entries(ASSET_CLASS_NAMES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <select className="reference-select" value={bias} onChange={(event) => setBias(event.target.value)} aria-label="Filter SS bias">
            <option value="all">All biases</option>
            <option value="bullish">Bullish</option>
            <option value="bearish">Bearish</option>
            <option value="neutral">Neutral</option>
          </select>
          <span className="reference-empty-inline">{filteredRows.length} securities</span>
        </div>
        <div className="reference-table-wrap">
          <table className="reference-table">
            <thead><tr>
              {[
                ['ticker', 'Ticker'], ['name', 'Security'], ['assetClass', 'Asset'], ['spot', 'Live Spot'],
                ['weekly', 'W/W'], ['monthly', 'M/M'], ['trend', 'Bias'], ['lrr', 'LRR'], ['hrr', 'HRR'], ['rangePosition', 'Range Pos.'],
              ].map(([key, label]) => <th key={key} className="is-sortable" onClick={() => toggleSort(key)}>{label}{sort.key === key ? (sort.direction === 'asc' ? ' ↑' : ' ↓') : ''}</th>)}
            </tr></thead>
            <tbody>
              {visibleRows.map((row) => (
                <tr
                  key={row.ticker}
                  className={SECURITY_INTELLIGENCE_V2_ENABLED && Object.keys(securityIntelligence).length > 0 && row.researchHealth !== 'ready' ? 'reference-row-attention' : ''}
                  title={SECURITY_INTELLIGENCE_V2_ENABLED && Object.keys(securityIntelligence).length > 0 && row.researchHealth !== 'ready'
                    ? `${row.ticker} current research is incomplete or unavailable.`
                    : undefined}
                >
                  <td className="reference-table__ticker">{row.ticker}</td>
                  <td>{row.name}</td>
                  <td>{ASSET_CLASS_NAMES[row.assetClass] || row.assetClass}</td>
                  <td className="reference-table__number">{quoteLoading && !row.quote ? '…' : formatNumber(row.spot)}</td>
                  <td className={`reference-table__number ${row.weekly > 0 ? 'reference-table__positive' : row.weekly < 0 ? 'reference-table__negative' : ''}`}>{formatPercent(row.weekly)}</td>
                  <td className={`reference-table__number ${row.monthly > 0 ? 'reference-table__positive' : row.monthly < 0 ? 'reference-table__negative' : ''}`}>{formatPercent(row.monthly)}</td>
                  <td className={row.trend === 'BULLISH' ? 'reference-table__positive' : row.trend === 'BEARISH' ? 'reference-table__negative' : 'reference-table__muted'}>{row.trend || (SECURITY_INTELLIGENCE_V2_ENABLED ? row.researchStatus === 'unavailable' ? 'UNAVAILABLE' : 'N/A' : '—')}</td>
                  <td className="reference-table__number">{Number.isFinite(row.lrr) ? formatNumber(row.lrr) : SECURITY_INTELLIGENCE_V2_ENABLED ? row.researchStatus === 'unavailable' ? 'UNAVAILABLE' : row.researchStatus === 'conflict' ? 'CONFLICT' : 'N/A' : '—'}</td>
                  <td className="reference-table__number">{Number.isFinite(row.hrr) ? formatNumber(row.hrr) : SECURITY_INTELLIGENCE_V2_ENABLED ? row.researchStatus === 'unavailable' ? 'UNAVAILABLE' : row.researchStatus === 'conflict' ? 'CONFLICT' : 'N/A' : '—'}</td>
                  <td className="reference-table__number">{Number.isFinite(row.rangePosition) ? `${row.rangePosition.toFixed(0)}%` : SECURITY_INTELLIGENCE_V2_ENABLED ? row.researchStatus === 'unavailable' ? 'UNAVAILABLE' : 'N/A' : '—'}</td>
                </tr>
              ))}
              {!visibleRows.length && <tr><td colSpan="10" className="reference-table__empty">{metadataLoading || changelogLoading ? 'Loading Signal Strength…' : 'No securities match these filters.'}</td></tr>}
            </tbody>
          </table>
        </div>
        {pageCount > 1 && <div className="reference-pagination"><button type="button" disabled={safePage === 0} onClick={() => setPage((value) => Math.max(0, value - 1))}>‹</button><span>{safePage + 1} / {pageCount}</span><button type="button" disabled={safePage === pageCount - 1} onClick={() => setPage((value) => Math.min(pageCount - 1, value + 1))}>›</button></div>}
      </div>
    </ReferencePanelShell>
  );
};

export default SignalStrengthPanel;
