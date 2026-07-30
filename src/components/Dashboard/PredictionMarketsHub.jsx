import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BarChart3, Droplet, Scale } from 'lucide-react';
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
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

const formatCompactNumber = (value) => {
  const parsed = finite(value);
  if (parsed == null) return '—';
  return new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(parsed);
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
  const lines = (Array.isArray(summary?.lines) ? summary.lines : []).map((line) => {
    const yesBid = finite(line?.yesBid ?? line?.yes_bid);
    const yesAsk = finite(line?.yesAsk ?? line?.yes_ask);
    const noBid = finite(line?.noBid ?? line?.no_bid);
    const noAsk = finite(line?.noAsk ?? line?.no_ask);
    const sortValue = finite(line?.sortValue);
    const volume24h = finite(line?.volume24h);
    if (
      !line?.label ||
      yesBid == null ||
      yesAsk == null ||
      noBid == null ||
      noAsk == null ||
      yesBid < 0 ||
      yesAsk > 1 ||
      yesAsk < yesBid ||
      noBid < 0 ||
      noAsk > 1 ||
      noAsk < noBid
    ) return null;
    return {
      ticker: line.ticker || null,
      label: String(line.label),
      yesBid,
      yesAsk,
      noBid,
      noAsk,
      sortValue,
      volume24h,
    };
  }).filter(Boolean);
  const available = Boolean(summary) &&
    lines.length > 0 &&
    !unavailable.test(status) &&
    !unavailable.test(freshnessStatus) &&
    !unavailable.test(source) &&
    summary?._cache?.stale !== true;
  if (!available) {
    return {
      available: false,
      message: entry?.error || entry?.message || 'No verified current lines are available.',
      signal: summary?.signal || null,
    };
  }

  return {
    available: true,
    lines,
    lineCount: finite(summary.lineCount) ?? lines.length,
    checkedAt: firstValue(summary.freshness?.fetchedAt, summary.fetchedAt, entry?.fetchedAt),
    signal: summary.signal || null,
    chart: summary.chart || null,
    reference: summary.reference || null,
    selection: summary.selection || null,
  };
}

function formatSignalPercent(value) {
  const parsed = finite(value);
  return parsed == null ? '—' : `${parsed.toFixed(2)}%`;
}

function ReferenceMarker({ reference }) {
  if (normalizeStatus(reference?.status) !== 'available' || finite(reference?.value) == null) return null;
  const forecast = reference.kind === 'forecast';
  return (
    <div className={`pm-hub-reference-marker ${forecast ? 'forecast' : 'underlying'}`}>
      <span />
      <strong>
        {reference.label} {formatNumber(reference.value, {
          maximumFractionDigits: forecast ? 2 : 2,
          minimumFractionDigits: forecast ? 2 : 0,
        })}{forecast ? '%' : ''}
      </strong>
    </div>
  );
}

function LinesTable({ summary, limit = 7 }) {
  if (!summary.available) {
    return <div className="pm-hub-local-unavailable">{summary.message}</div>;
  }
  const start = Math.max(0, Math.floor((summary.lines.length - limit) / 2));
  const visibleLines = summary.lines.slice(start, start + limit);
  const referenceValue = normalizeStatus(summary.reference?.status) === 'available'
    ? finite(summary.reference?.value)
    : null;
  const markerAfterIndex = referenceValue == null
    ? null
    : visibleLines.findIndex((line, index) => {
      const next = visibleLines[index + 1];
      return line.sortValue != null &&
        line.sortValue <= referenceValue &&
        (!next || next.sortValue == null || next.sortValue > referenceValue);
    });
  const markerBeforeFirst = referenceValue != null &&
    visibleLines[0]?.sortValue != null &&
    referenceValue < visibleLines[0].sortValue;
  return (
    <div className="pm-hub-lines">
      <div className="pm-hub-lines-heading">
        <span>Current line</span>
        <span>YES bid</span>
        <span>YES ask</span>
        <span>NO bid</span>
        <span>NO ask</span>
        <span>24h vol</span>
      </div>
      {markerBeforeFirst && <ReferenceMarker reference={summary.reference} />}
      {visibleLines.map((line, index) => (
        <React.Fragment key={line.ticker || line.label}>
          <div className="pm-hub-line">
            <strong>{line.label}</strong>
            <span>{formatPrice(line.yesBid)}</span>
            <span>{formatPrice(line.yesAsk)}</span>
            <span>{formatPrice(line.noBid)}</span>
            <span>{formatPrice(line.noAsk)}</span>
            <span>{formatCompactNumber(line.volume24h)}</span>
          </div>
          {markerAfterIndex === index && <ReferenceMarker reference={summary.reference} />}
        </React.Fragment>
      ))}
      <div className="pm-hub-lines-asof">
        {summary.lineCount > visibleLines.length ? `${visibleLines.length} of ${summary.lineCount} live lines · ` : ''}
        {summary.selection?.label ? `${summary.selection.label} · ` : ''}
        Checked {summary.checkedAt ? formatDateTime(summary.checkedAt) : 'just now'}
      </div>
    </div>
  );
}

function ChartTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const point = payload[0].payload;
  return (
    <div className="pm-hub-chart-tooltip">
      <span>{new Date(point.timestamp).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</span>
      <strong>{formatPrice(point.close)}</strong>
    </div>
  );
}

function IntradayChart({ chart }) {
  const status = normalizeStatus(chart?.status);
  const source = normalizeStatus(chart?.source);
  const forbidden = /(unavailable|error|offline|stale|cache|mock|seed|fallback|failed)/;
  const points = (Array.isArray(chart?.points) ? chart.points : [])
    .map((point) => ({
      timestamp: finite(point?.timestamp),
      close: finite(point?.close),
    }))
    .filter((point) => (
      point.timestamp != null &&
      point.close != null &&
      point.close >= 0 &&
      point.close <= 1
    ));
  const available = status === 'available' &&
    source === 'kalshi_trade_api_v2' &&
    !forbidden.test(status) &&
    points.length > 0;

  if (!available) {
    return (
      <div className="pm-hub-chart pm-hub-chart-unavailable">
        <span>1D direct venue chart</span>
        <strong>{chart?.reason || 'No current direct venue price history is available.'}</strong>
      </div>
    );
  }

  const values = points.map((point) => point.close);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const padding = Math.max((max - min) * 0.16, 0.025);
  const domain = [Math.max(0, min - padding), Math.min(1, max + padding)];
  return (
    <div className="pm-hub-chart">
      <div className="pm-hub-chart-meta">
        <span>Live 1D · {chart.label || 'Representative contract'}</span>
        <strong>{formatPrice(points[points.length - 1].close)}</strong>
      </div>
      <div className="pm-hub-chart-canvas" aria-label={`Live 1-day chart for ${chart.label || chart.ticker}`}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={points} margin={{ top: 7, right: 5, left: 0, bottom: 0 }}>
            <XAxis
              dataKey="timestamp"
              axisLine={false}
              tickLine={false}
              minTickGap={38}
              tick={{ fill: '#94a3b8', fontSize: 8 }}
              tickFormatter={(value) => new Date(value).toLocaleTimeString('en-US', { hour: 'numeric' })}
            />
            <YAxis
              orientation="right"
              domain={domain}
              axisLine={false}
              tickLine={false}
              tick={{ fill: '#94a3b8', fontSize: 8 }}
              tickFormatter={(value) => `${Math.round(value * 100)}¢`}
              width={29}
            />
            <Tooltip content={<ChartTooltip />} />
            <Line type="monotone" dataKey="close" stroke="#2563eb" strokeWidth={2} dot={false} activeDot={{ r: 3 }} />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div className="pm-hub-chart-asof">Direct Kalshi price history · through {formatDateTime(chart.latestAt)}</div>
    </div>
  );
}

function HedgeyeReference({ signal }) {
  const status = normalizeStatus(signal?.status);
  const details = signal?.details || {};
  const available = status === 'available';
  return (
    <div className="pm-hub-hedgeye">
      <div className="pm-hub-hedgeye-heading">
        <span>{signal?.name || 'Hedgeye reference'}</span>
        <small>{available ? 'Source matched' : 'Unavailable'}</small>
      </div>
      {!available ? (
        <p>{signal?.reason || 'No source-matched Hedgeye reference is available.'}</p>
      ) : Array.isArray(details.scenarios) && details.scenarios.length > 0 ? (
        <>
          <div className="pm-hub-hedgeye-meta">
            <strong>{details.forecastMonth || signal.requiredMonth || 'Current CPI release'}</strong>
            <span>{details.metric || details.outlook || 'Inflation Nowcast'}</span>
          </div>
          <div className="pm-hub-nowcast-scenarios">
            {details.scenarios.map((scenario) => (
              <span key={scenario.key || scenario.label}>
                <small>{scenario.label}</small>
                <strong>{formatSignalPercent(scenario.value)}</strong>
              </span>
            ))}
          </div>
        </>
      ) : finite(details.lrr) != null && finite(details.hrr) != null ? (
        <div className="pm-hub-risk-range">
          <span><small>LRR</small><strong>{formatNumber(details.lrr, { maximumFractionDigits: 2 })}</strong></span>
          <span><small>HRR</small><strong>{formatNumber(details.hrr, { maximumFractionDigits: 2 })}</strong></span>
          <span><small>Trend</small><strong>{details.trend || '—'}</strong></span>
          <span><small>As of</small><strong>{details.date || signal.asOf || '—'}</strong></span>
        </div>
      ) : (
        <p>Source matched, but no displayable Hedgeye values were supplied.</p>
      )}
    </div>
  );
}

function MarketSummaryCard({ title, icon, entry, onOpen, children }) {
  const summary = normalizeSummary(entry);
  return (
    <section className="pm-hub-summary-card" aria-label={`${title} market summary`}>
      <button type="button" className="pm-hub-summary-open" onClick={onOpen}>
        <span className="pm-hub-summary-title">{icon}{title}</span>
      </button>
      <IntradayChart chart={summary.chart} />
      <div className="pm-hub-summary-lower">
        {children || (
        <>
          <LinesTable summary={summary} />
          <HedgeyeReference signal={summary.signal} />
        </>
        )}
      </div>
    </section>
  );
}

function WtiSummaryRows({ entry, onOpen }) {
  const daily = normalizeSummary(entry?.daily);
  const weekly = normalizeSummary(entry?.weekly);
  const signal = daily.signal?.status === 'available' ? daily.signal : weekly.signal;
  return (
    <div className="pm-hub-wti-stack">
      <div className="pm-hub-wti-rows">
        {[
          ['Daily', 'daily', daily],
          ['Weekly', 'weekly', weekly],
        ].map(([label, cadence, summary]) => (
          <div className="pm-hub-wti-row" key={cadence}>
            <button type="button" className="pm-hub-wti-row-heading" onClick={() => onOpen(cadence)}>
              <strong className="pm-hub-wti-row-label">{label}</strong>
            </button>
            <LinesTable summary={summary} limit={4} />
          </div>
        ))}
      </div>
      <HedgeyeReference signal={signal} />
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
      {state.status === 'unavailable' && <div className="pm-hub-overview-error">Market summaries are unavailable: {state.error}</div>}
      <div className="pm-hub-summary-grid" aria-busy={state.status === 'loading' || state.refreshing}>
        <MarketSummaryCard title="CPI" icon={<Scale size={16} />} entry={getOverviewEntry(state.data, ['cpi'])} onOpen={() => onSelectMarket('cpi')} />
        <MarketSummaryCard title="S&P 500 Close" icon={<BarChart3 size={16} />} entry={getOverviewEntry(state.data, ['spx'])} onOpen={() => onSelectMarket('spx')} />
        <MarketSummaryCard title="WTI" icon={<Droplet size={16} />} entry={getOverviewEntry(state.data, ['wti', 'daily'])} onOpen={() => onSelectMarket('wti')}>
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
      {selectedView !== 'overview' && (
        <header className="pm-hub-header">
          <button
            type="button"
            className="pm-hub-back"
            onClick={() => onActiveMarketChange?.('overview')}
          >
            <span aria-hidden="true">←</span> All markets
          </button>
        </header>
      )}
      <div className="pm-hub-content">
        {selectedView === 'overview' && (
          <PredictionMarketsOverview
            positionsState={positionsState}
            onSelectMarket={onActiveMarketChange}
            onSelectWtiCadence={onWtiCadenceChange}
          />
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
