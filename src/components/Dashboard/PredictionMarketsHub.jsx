import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BarChart3, Droplet, RefreshCw, Scale, X } from 'lucide-react';
import { MarketDataService } from '../../services/api/marketDataService';
import predictionMarketsIngestService from '../../services/api/predictionMarketsIngestService';
import { startVisibilityAwarePolling } from '../../utils/visibilityAwarePolling';
import LoadingIndicator from '../common/LoadingIndicator';
import './PredictionMarketsHub.css';

const CpiWorkbench = lazy(() => import('./PredictionMarkets'));
const SpxWorkbench = lazy(() => import('./PredictionMarketsSandbox'));
const WtiWorkbench = lazy(() => import('./WtiWorkbench'));

export const PREDICTION_MARKET_VIEWS = Object.freeze(['overview', 'wti', 'spx', 'cpi']);
const POSITION_POLL_MS = 30000;
const OVERVIEW_POLL_MS = 30000;

const finite = (value) => {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const firstValue = (...values) => values.find((value) => value != null && value !== '');

const formatNumber = (value, options = {}) => {
  const parsed = finite(value);
  if (parsed == null) return '—';
  return new Intl.NumberFormat('en-US', options).format(parsed);
};

const formatMoney = (value) => {
  const parsed = finite(value);
  if (parsed == null) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  }).format(parsed);
};

const formatPrice = (value) => {
  const parsed = finite(value);
  if (parsed == null) return '—';
  if (parsed >= 0 && parsed <= 1) return `${Math.round(parsed * 100)}¢`;
  return formatNumber(parsed, { maximumFractionDigits: 2 });
};

const formatDateTime = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(date);
};

const normalizeStatus = (value) => String(value || '').trim().toLowerCase();

export function classifyPredictionMarketPosition(position = {}) {
  const supplied = normalizeStatus(
    position.marketClassification || position.marketType || position.classification,
  );
  const suppliedFamily = normalizeStatus(position.marketFamily);
  const suppliedProduct = normalizeStatus(position.marketProduct);
  if (supplied.includes('wti') && supplied.includes('week')) return 'wti-weekly';
  if (supplied.includes('wti') && supplied.includes('daily')) return 'wti-daily';
  if (suppliedFamily.includes('wti') && suppliedFamily.includes('week')) return 'wti-weekly';
  if (suppliedFamily.includes('wti') && suppliedFamily.includes('daily')) return 'wti-daily';
  if (suppliedFamily === 'wti' && suppliedProduct.includes('week')) return 'wti-weekly';
  if (suppliedFamily === 'wti' && suppliedProduct.includes('daily')) return 'wti-daily';
  if (suppliedFamily === 'wti' && suppliedProduct.includes('unsupported')) return 'wti-unsupported';
  if (supplied === 'wti') return 'wti-unsupported';
  if (supplied.includes('spx') || suppliedFamily === 'spx') return 'spx';
  if (supplied.includes('cpi') || suppliedFamily === 'cpi') return 'cpi';

  const text = [
    position.seriesTicker,
    position.eventTicker,
    position.ticker,
    position.symbol,
    position.description,
    position.localSymbol,
  ].filter(Boolean).join(' ').toUpperCase();

  if (/\bKXWTIW(?:\b|-)/.test(text)) return 'wti-weekly';
  if (/\bKXWTI(?:\b|-)/.test(text)) return 'wti-daily';
  if (/\bKXINXU(?:\b|-)/.test(text) || /S&P\s*500|SPX/.test(text)) return 'spx';
  if (/\bKXCPI|\bCPIY|CONSUMER PRICE INDEX/.test(text)) return 'cpi';
  if (/\bWTI\b|CRUDE OIL/.test(text)) return 'wti-unsupported';
  return 'other';
}

export function normalizeLivePositionsPayload(payload) {
  const source = normalizeStatus(payload?.meta?.source || payload?.source);
  const status = normalizeStatus(
    payload?.status || payload?.aggregateStatus || payload?.meta?.aggregateStatus || payload?.meta?.status,
  );
  const quality = normalizeStatus(payload?.dataQuality?.status || payload?.meta?.dataQuality?.status);
  const cacheOnly = payload?._cache?.stale === true || payload?.meta?.cacheOnly === true;
  const forbiddenSource = /(cache|mock|seed|upload|fallback|reconstruct|unavailable|offline|stale)/.test(source);
  const forbiddenStatus = /(unavailable|offline|stale|error|failed|cache|mock|seed)/.test(status);
  const forbiddenQuality = /(unavailable|offline|stale|error|failed)/.test(quality);
  const explicitLive = status === 'live' || status === 'partial';
  const legacyLive = source === 'ibkr_live' || source === 'ibkr_live_partial' || source === 'ibkr_positions' || source === 'ibkr_positions_live';
  const available = !cacheOnly && !forbiddenSource && !forbiddenStatus && !forbiddenQuality && (explicitLive || legacyLive);

  if (!available) {
    return {
      status: 'unavailable',
      positions: [],
      accounts: Array.isArray(payload?.accounts) ? payload.accounts : [],
      message: firstValue(payload?.message, payload?.error, payload?.meta?.message, 'Verified-live IBKR positions are unavailable.'),
      fetchedAt: payload?.fetchedAt || payload?.meta?.fetchedAt || null,
    };
  }

  return {
    status: status === 'partial' || source === 'ibkr_live_partial' ? 'partial' : 'live',
    positions: Array.isArray(payload?.positions) ? payload.positions : [],
    accounts: Array.isArray(payload?.accounts) ? payload.accounts : [],
    message: firstValue(payload?.message, payload?.meta?.message, null),
    fetchedAt: payload?.fetchedAt || payload?.meta?.fetchedAt || null,
  };
}

function MarketMetric({ label, value }) {
  return (
    <div className="pm-hub-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function getOverviewEntry(payload, path) {
  let current = payload?.markets || payload || {};
  for (const key of path) current = current?.[key];
  return current || null;
}

function normalizeSummary(entry) {
  const summary = entry?.summary || entry?.data || entry;
  const status = normalizeStatus(entry?.status || summary?.status);
  const freshnessStatus = normalizeStatus(summary?.freshness?.status || summary?.freshness);
  const source = normalizeStatus(summary?.source || summary?.provider || summary?.sourceApi);
  const unavailable = /(unavailable|error|offline|stale|cache|mock|seed|fallback|failed)/;
  const available = Boolean(summary) && !unavailable.test(status) && !unavailable.test(freshnessStatus) && !unavailable.test(source) && summary?._cache?.stale !== true;
  if (!available) return { available: false, message: entry?.error || entry?.message || 'No verified current market is available.' };

  const book = summary?.representativeBook || summary?.book || summary?.market || summary?.topContract || {};
  const yesBid = firstValue(book.yesBid, book.yes_bid, summary.yesBid, summary.yes_bid);
  const yesAsk = firstValue(book.yesAsk, book.yes_ask, summary.yesAsk, summary.yes_ask);
  const directSpread = firstValue(book.spread, summary.spread);
  const calculatedSpread = finite(yesAsk) != null && finite(yesBid) != null
    ? finite(yesAsk) - finite(yesBid)
    : null;
  const signalName = firstValue(summary.signal?.name, summary.signalAvailability?.label);
  const signalStatus = firstValue(summary.signal?.status, summary.signalAvailability?.status, summary.signalStatus, summary.contextStatus);

  return {
    available: true,
    event: firstValue(summary.eventTitle, summary.title, summary.event?.title, summary.eventTicker, summary.event?.ticker, '—'),
    contract: firstValue(book.title, book.ticker, summary.contractTicker, summary.marketTicker, '—'),
    closeTime: firstValue(summary.closeTime, summary.event?.closeTime, summary.expirationTime),
    yesBid,
    yesAsk,
    bidSize: firstValue(book.yesBidSize, book.yes_bid_size, summary.yesBidSize, summary.yes_bid_size),
    askSize: firstValue(book.yesAskSize, book.yes_ask_size, summary.yesAskSize, summary.yes_ask_size),
    spread: directSpread ?? calculatedSpread,
    completeBooks: firstValue(summary.completeBookCount, summary.completeBooks, summary.marketCount),
    volume: firstValue(summary.volume24h, summary.volume_24h, summary.volume, summary.aggregateVolume),
    openInterest: firstValue(summary.openInterest, summary.open_interest, summary.aggregateOpenInterest),
    freshnessStatus: firstValue(summary.freshness?.label, summary.freshness?.status, typeof summary.freshness === 'string' ? summary.freshness : null),
    freshnessAt: firstValue(summary.freshness?.updatedAt, summary.freshness?.fetchedAt, summary.asOf, summary.updatedAt, entry?.fetchedAt),
    signal: signalName && signalStatus ? `${signalName} · ${signalStatus}` : firstValue(signalName, signalStatus, 'Unavailable'),
  };
}

function SummaryBody({ summary }) {
  if (!summary.available) {
    return <div className="pm-hub-local-unavailable">{summary.message}</div>;
  }
  return (
    <>
      <div className="pm-hub-event-title">{summary.event}</div>
      <div className="pm-hub-contract-title">{summary.contract}</div>
      <div className="pm-hub-metrics-grid">
        <MarketMetric label="Closes" value={formatDateTime(summary.closeTime)} />
        <MarketMetric label="YES bid / ask" value={`${formatPrice(summary.yesBid)} / ${formatPrice(summary.yesAsk)}`} />
        <MarketMetric label="Native depth" value={`${formatNumber(summary.bidSize)} / ${formatNumber(summary.askSize)}`} />
        <MarketMetric label="Spread" value={formatPrice(summary.spread)} />
        <MarketMetric label="Complete books" value={formatNumber(summary.completeBooks)} />
        <MarketMetric label="24h volume" value={formatNumber(summary.volume)} />
        <MarketMetric label="Open interest" value={formatNumber(summary.openInterest)} />
        <MarketMetric label="Signal data" value={String(summary.signal)} />
      </div>
      <div className="pm-hub-freshness">
        Freshness: {summary.freshnessStatus || '—'}{summary.freshnessAt ? ` · ${formatDateTime(summary.freshnessAt)}` : ''}
      </div>
    </>
  );
}

function MarketSummaryCard({ title, icon, entry, onOpen, children }) {
  return (
    <section className="pm-hub-summary-card" aria-label={`${title} market summary`}>
      <button type="button" className="pm-hub-summary-open" onClick={onOpen}>
        <span className="pm-hub-summary-title">{icon}{title}</span>
        <span>Open workbench →</span>
      </button>
      {children || <SummaryBody summary={normalizeSummary(entry)} />}
    </section>
  );
}

function WtiSummaryRows({ entry, onOpen }) {
  const daily = normalizeSummary(entry?.daily);
  const weekly = normalizeSummary(entry?.weekly);
  return (
    <div className="pm-hub-wti-rows">
      {[
        ['Daily', 'daily', daily],
        ['Weekly', 'weekly', weekly],
      ].map(([label, cadence, summary]) => (
        <button type="button" className="pm-hub-wti-row" key={cadence} onClick={() => onOpen(cadence)}>
          <span className="pm-hub-wti-row-heading">
            <strong className="pm-hub-wti-row-label">{label}</strong>
            <span>Open {label.toLowerCase()} workbench →</span>
          </span>
          {summary.available ? (
            <>
              <span className="pm-hub-wti-event-title">{summary.event}</span>
              <span className="pm-hub-wti-contract-title">{summary.contract}</span>
              <span className="pm-hub-wti-metrics-grid">
                <span><small>Closes</small><strong>{formatDateTime(summary.closeTime)}</strong></span>
                <span><small>YES bid / ask</small><strong>{formatPrice(summary.yesBid)} / {formatPrice(summary.yesAsk)}</strong></span>
                <span><small>YES native depth</small><strong>{formatNumber(summary.bidSize)} / {formatNumber(summary.askSize)}</strong></span>
                <span><small>Spread</small><strong>{formatPrice(summary.spread)}</strong></span>
                <span><small>Complete books</small><strong>{formatNumber(summary.completeBooks)}</strong></span>
                <span><small>24h volume</small><strong>{formatNumber(summary.volume)}</strong></span>
                <span><small>Open interest</small><strong>{formatNumber(summary.openInterest)}</strong></span>
                <span><small>Signal data</small><strong>{String(summary.signal)}</strong></span>
              </span>
              <span className="pm-hub-wti-freshness">
                Freshness: {summary.freshnessStatus || '—'}{summary.freshnessAt ? ` · ${formatDateTime(summary.freshnessAt)}` : ''}
              </span>
            </>
          ) : <span className="pm-hub-wti-row-unavailable">{summary.message}</span>}
        </button>
      ))}
    </div>
  );
}

function PositionsCard({ positionsState, onOpenMarket }) {
  const { status, positions, accounts, message, fetchedAt } = positionsState;
  return (
    <section className="pm-hub-positions-card" aria-labelledby="pm-hub-positions-title">
      <div className="pm-hub-card-heading">
        <div>
          <h2 id="pm-hub-positions-title">IBKR Prediction-Market Positions</h2>
          <p>Verified-live IBKR account positions only</p>
        </div>
        <span className={`pm-hub-state-badge ${status}`}>{status === 'partial' ? 'Partial' : status === 'live' ? 'Live' : status === 'loading' ? 'Loading' : 'Unavailable'}</span>
      </div>
      {status === 'loading' ? (
        <div className="pm-hub-local-unavailable"><LoadingIndicator label="Loading live IBKR positions..." size="sm" /></div>
      ) : status === 'unavailable' ? (
        <div className="pm-hub-local-unavailable">{message || 'Verified-live IBKR positions are unavailable.'}</div>
      ) : positions.length === 0 ? (
        <div className="pm-hub-empty-positions">No open prediction-market positions in the verified-live IBKR accounts.</div>
      ) : (
        <div className="pm-hub-table-wrap">
          <table className="pm-hub-positions-table">
            <thead><tr><th>Market</th><th>Contract</th><th>Account</th><th>Qty</th><th>Avg cost</th><th>Market value</th><th>Unrealized P&amp;L</th><th>Updated</th></tr></thead>
            <tbody>
              {positions.map((position, index) => {
                const classification = classifyPredictionMarketPosition(position);
                const market = classification === 'wti-daily' || classification === 'wti-weekly'
                  ? 'WTI'
                  : classification === 'spx' ? 'SPX' : classification === 'cpi' ? 'CPI' : classification === 'wti-unsupported' ? 'WTI (Other)' : 'Other';
                const openable = ['wti-daily', 'wti-weekly', 'spx', 'cpi'].includes(classification);
                const route = classification.startsWith('wti') ? 'wti' : classification;
                return (
                  <tr key={position.positionId || position.conid || `${position.symbol}-${index}`}>
                    <td>
                      {openable ? (
                        <button type="button" className="pm-hub-position-link" onClick={() => onOpenMarket(route, classification.endsWith('weekly') ? 'weekly' : 'daily')}>{market}</button>
                      ) : market}
                    </td>
                    <td>{position.description || position.localSymbol || position.symbol || '—'}</td>
                    <td>{position.accountId || position.account || '—'}</td>
                    <td>{formatNumber(position.quantity ?? position.position)}</td>
                    <td>{formatPrice(position.avgCost ?? position.averageCost)}</td>
                    <td>{formatMoney(position.marketValue)}</td>
                    <td>{formatMoney(position.unrealizedPnL ?? position.unrealizedPnl ?? position.gainLoss)}</td>
                    <td>{formatDateTime(position.lastUpdated || position.updatedAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {status === 'partial' && <div className="pm-hub-partial-note">{message || 'Some IBKR accounts could not be verified. Unverified accounts are omitted.'}</div>}
      {accounts.length > 0 && <div className="pm-hub-account-note">Accounts checked: {accounts.length}{fetchedAt ? ` · ${formatDateTime(fetchedAt)}` : ''}</div>}
    </section>
  );
}

function PredictionMarketsOverview({ positionsState, onSelectMarket, onSelectWtiCadence }) {
  const [state, setState] = useState({ status: 'loading', data: null, error: null });
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    setState((current) => current.data
      ? { ...current, refreshing: true, error: null }
      : { status: 'loading', data: null, error: null, refreshing: false });
    try {
      const data = await predictionMarketsIngestService.getPredictionMarketsOverview();
      if (requestId !== requestRef.current) return;
      setState({ status: 'ready', data, error: null, refreshing: false });
    } catch (error) {
      if (requestId !== requestRef.current) return;
      setState({ status: 'unavailable', data: null, error: error?.response?.data?.error || error?.message || 'Prediction-market summaries are unavailable.', refreshing: false });
    }
  }, []);

  useEffect(() => {
    load();
    const stop = startVisibilityAwarePolling({ poll: load, intervalMs: OVERVIEW_POLL_MS });
    return () => {
      requestRef.current += 1;
      stop();
    };
  }, [load]);

  const markets = state.data?.markets || {};
  return (
    <main className="pm-hub-overview" data-testid="prediction-markets-overview">
      <div className="pm-hub-overview-heading">
        <div>
          <h1>Prediction Markets Overview</h1>
          <p>Direct market facts and verified-live portfolio exposure. No ranking or recommendation.</p>
        </div>
        <button type="button" className="pm-hub-refresh" onClick={load} disabled={state.status === 'loading' || state.refreshing} aria-label="Refresh prediction markets overview">
          <RefreshCw size={14} aria-hidden="true" /> Refresh
        </button>
      </div>
      {state.status === 'unavailable' && <div className="pm-hub-overview-error">Market summaries are unavailable: {state.error}</div>}
      <div className="pm-hub-summary-grid" aria-busy={state.status === 'loading' || state.refreshing}>
        <MarketSummaryCard title="CPI" icon={<Scale size={16} />} entry={getOverviewEntry(state.data, ['cpi'])} onOpen={() => onSelectMarket('cpi')} />
        <MarketSummaryCard title="S&P 500 Close" icon={<BarChart3 size={16} />} entry={getOverviewEntry(state.data, ['spx'])} onOpen={() => onSelectMarket('spx')} />
        <MarketSummaryCard title="WTI" icon={<Droplet size={16} />} entry={getOverviewEntry(state.data, ['wti'])} onOpen={() => onSelectMarket('wti')}>
          <WtiSummaryRows entry={markets.wti} onOpen={(cadence) => { onSelectWtiCadence(cadence); onSelectMarket('wti'); }} />
        </MarketSummaryCard>
      </div>
      <PositionsCard positionsState={positionsState} onOpenMarket={(market, cadence) => { if (market === 'wti') onSelectWtiCadence(cadence); onSelectMarket(market); }} />
    </main>
  );
}

const INITIAL_POSITIONS_STATE = Object.freeze({
  status: 'loading',
  positions: [],
  accounts: [],
  message: null,
  fetchedAt: null,
});

export default function PredictionMarketsHub({
  onClose,
  portfolioData,
  selectedAccount = null,
  activeMarket = 'overview',
  onActiveMarketChange,
  activeWtiCadence = 'daily',
  onWtiCadenceChange,
  ibkrConnection = null,
}) {
  const selectedView = PREDICTION_MARKET_VIEWS.includes(activeMarket) ? activeMarket : 'overview';
  const [positionsState, setPositionsState] = useState(INITIAL_POSITIONS_STATE);
  const positionRequestRef = useRef(0);
  const accountId = selectedAccount || portfolioData?.accountId || null;
  const ibkrDisconnected = ibkrConnection?.connected === false;

  const loadPositions = useCallback(async () => {
    if (ibkrDisconnected) {
      setPositionsState({
        status: 'unavailable',
        positions: [],
        accounts: [],
        message: ibkrConnection?.title || 'IB Gateway/TWS is disconnected; verified-live positions are unavailable.',
        fetchedAt: null,
        refreshing: false,
      });
      return;
    }
    const requestId = positionRequestRef.current + 1;
    positionRequestRef.current = requestId;
    setPositionsState((current) => ['live', 'partial'].includes(current.status)
      ? { ...current, refreshing: true }
      : INITIAL_POSITIONS_STATE);
    try {
      const payload = await MarketDataService.getPortfolioPredictionMarketPositions({ primaryAccount: accountId });
      if (requestId !== positionRequestRef.current) return;
      setPositionsState({ ...normalizeLivePositionsPayload(payload), refreshing: false });
    } catch (error) {
      if (requestId !== positionRequestRef.current) return;
      setPositionsState({
        status: 'unavailable',
        positions: [],
        accounts: [],
        message: error?.response?.data?.error || error?.message || 'Verified-live IBKR positions are unavailable.',
        fetchedAt: null,
        refreshing: false,
      });
    }
  }, [accountId, ibkrConnection?.title, ibkrDisconnected]);

  useEffect(() => {
    if (ibkrDisconnected) {
      positionRequestRef.current += 1;
      setPositionsState({
        status: 'unavailable',
        positions: [],
        accounts: [],
        message: ibkrConnection?.title || 'IB Gateway/TWS is disconnected; verified-live positions are unavailable.',
        fetchedAt: null,
        refreshing: false,
      });
      return undefined;
    }
    setPositionsState(INITIAL_POSITIONS_STATE);
    loadPositions();
    const stop = startVisibilityAwarePolling({ poll: loadPositions, intervalMs: POSITION_POLL_MS });
    return () => {
      positionRequestRef.current += 1;
      stop();
    };
  }, [ibkrConnection?.title, ibkrDisconnected, loadPositions]);

  const childFallback = useMemo(() => <LoadingIndicator label={`Loading ${selectedView.toUpperCase()} workbench...`} size="sm" />, [selectedView]);
  return (
    <div className="prediction-markets-hub" data-testid="prediction-markets-hub">
      <header className="pm-hub-header">
        <div className="pm-hub-header-left">
          <div>
            <div className="pm-hub-eyebrow">Prediction Markets</div>
            <nav className="pm-hub-selector" aria-label="Prediction market view">
              {PREDICTION_MARKET_VIEWS.map((view) => (
                <button
                  type="button"
                  key={view}
                  className={selectedView === view ? 'active' : ''}
                  aria-current={selectedView === view ? 'page' : undefined}
                  onClick={() => onActiveMarketChange?.(view)}
                >
                  {view === 'spx' ? 'SPX' : view === 'wti' ? 'WTI' : view === 'cpi' ? 'CPI' : 'Overview'}
                </button>
              ))}
            </nav>
          </div>
        </div>
        <button type="button" className="pm-hub-close" onClick={onClose} aria-label="Close Prediction Markets"><X size={20} /></button>
      </header>
      <div className="pm-hub-content">
        {selectedView === 'overview' && (
          <PredictionMarketsOverview positionsState={positionsState} onSelectMarket={onActiveMarketChange} onSelectWtiCadence={onWtiCadenceChange} />
        )}
        {selectedView === 'wti' && (
          <Suspense fallback={childFallback}>
            <WtiWorkbench cadence={activeWtiCadence} onCadenceChange={onWtiCadenceChange} sharedPositionsState={positionsState} />
          </Suspense>
        )}
        {selectedView === 'spx' && (
          <Suspense fallback={childFallback}>
            <SpxWorkbench embedded onClose={onClose} portfolioData={portfolioData} sharedPositionsState={positionsState} />
          </Suspense>
        )}
        {selectedView === 'cpi' && (
          <Suspense fallback={childFallback}>
            <CpiWorkbench embedded portfolioData={portfolioData} sharedPositionsState={positionsState} />
          </Suspense>
        )}
      </div>
    </div>
  );
}
