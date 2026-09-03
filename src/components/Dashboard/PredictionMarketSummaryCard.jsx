import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MarketDataService } from '../../services/api/marketDataService';
import LoadingIndicator from '../common/LoadingIndicator';
import './PredictionMarketSummaryCard.css';

const MARKETS = [
  { key: 'wti', label: 'WTI' },
  { key: 'gold', label: 'Gold' },
  { key: 'sp500', label: 'SP500' },
  { key: 'nasdaq100', label: 'NQ' },
  { key: 'bitcoin', label: 'BTC' },
  { key: 'ethereum', label: 'ETH' },
  { key: 'cpi', label: 'CPI' },
];

const SETTLED_STATUSES = new Set(['verified', 'confirmed']);

const lifecycleState = (row = {}) => {
  const explicit = String(row.displayState || '').toUpperCase();
  if (['OPEN', 'AWAITING_RESULT', 'CLOSED', 'SETTLED', 'CHECK'].includes(explicit)) return explicit;
  if (row.status === 'review') return 'CHECK';
  if (SETTLED_STATUSES.has(String(row.status || '').toLowerCase())) return row.resolutionType === 'early_exit' ? 'CLOSED' : 'SETTLED';
  if (row.status === 'awaiting_resolution') return 'AWAITING_RESULT';
  return 'OPEN';
};

const finite = (value) => {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const resolveMarketKey = (row = {}) => {
  if (MARKETS.some((item) => item.key === row.market)) return row.market;
  const source = `${row.contractLabel || ''} ${row.contractKey || ''} ${row.eventTicker || ''}`.toUpperCase();
  if (source.includes('METLG')) return 'gold';
  if (source.includes('COMCO') || source.includes('KXWTI')) return 'wti';
  if (/\bFES[_-]/.test(source) || source.includes('KXINX')) return 'sp500';
  if (source.includes('FNQ')) return 'nasdaq100';
  if (source.includes('CPIY') || source.includes('KXCPI')) return 'cpi';
  if (source.includes('KXBTC')) return 'bitcoin';
  if (source.includes('KXETH')) return 'ethereum';
  return 'other';
};

const calendarDateKey = (value) => {
  const raw = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw.slice(0, 10))) return raw.slice(0, 10);
  const compact = raw.match(/^(\d{4})(\d{2})(\d{2})/);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : null;
};

const formatShortDate = (value) => {
  const key = calendarDateKey(value);
  if (!key) return null;
  const parsed = new Date(`${key}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(parsed);
};

const rowDate = (row = {}) => (
  calendarDateKey(row.resolvedDate) || calendarDateKey(row.openedAt) || calendarDateKey(row.expiration)
);

const formatPeriod = (dates = []) => {
  const valid = dates.filter(Boolean).sort();
  if (!valid.length) return 'All time';
  const first = formatShortDate(valid[0]);
  const last = formatShortDate(valid[valid.length - 1]);
  if (!first || !last) return 'All time';
  return first === last ? first : `${first} – ${last}`;
};

const sumExact = (values) => {
  if (!values.length || values.some((value) => value == null)) return null;
  return values.reduce((total, value) => total + value, 0);
};

const apiErrorMessage = (error) => {
  const payload = error?.response?.data;
  if (typeof payload?.error === 'string' && payload.error.trim()) return payload.error;
  if (typeof payload?.error?.message === 'string' && payload.error.message.trim()) return payload.error.message;
  if (typeof payload?.tracker?.message === 'string' && payload.tracker.message.trim()) return payload.tracker.message;
  return 'Prediction-market performance is unavailable.';
};

export function buildMarketSummaries(rows = []) {
  if (!rows.length) return [];

  const buckets = Object.fromEntries(MARKETS.map((item) => [item.key, []]));
  const other = [];
  rows.forEach((row) => {
    const key = resolveMarketKey(row);
    if (buckets[key]) buckets[key].push(row);
    else other.push(row);
  });

  const toStats = (key, label, marketRows) => {
    const settled = marketRows.filter((row) => ['CLOSED', 'SETTLED'].includes(lifecycleState(row)));
    const open = marketRows.filter((row) => lifecycleState(row) === 'OPEN');
    const awaiting = marketRows.filter((row) => lifecycleState(row) === 'AWAITING_RESULT');
    const unsettled = [...open, ...awaiting];
    const settledPnls = settled.map((row) => finite(row.pnl));
    const wins = settledPnls.filter((value) => value != null && value > 0);
    const losses = settledPnls.filter((value) => value != null && value < 0);
    const realizedPnl = sumExact(settledPnls);
    const totalPnl = sumExact(marketRows.map((row) => finite(row.pnl)));
    const totalRisked = marketRows.reduce((sum, row) => sum + (finite(row.risked) || 0), 0);
    const openPnl = unsettled.length ? sumExact(unsettled.map((row) => finite(row.pnl))) : null;
    const openRisked = unsettled.length ? unsettled.reduce((sum, row) => sum + (finite(row.risked) || 0), 0) : null;
    return {
      key,
      label,
      count: marketRows.length,
      settledCount: settled.length,
      openCount: open.length,
      awaitingCount: awaiting.length,
      period: formatPeriod(marketRows.map(rowDate)),
      realizedPnl,
      totalPnl,
      roi: totalPnl != null && totalRisked > 0 ? totalPnl / totalRisked : null,
      hitRate: settled.length ? wins.length / settled.length : null,
      hitLabel: settled.length ? `${wins.length}/${settled.length}` : null,
      biggestWin: wins.length ? Math.max(...wins) : null,
      biggestLoss: losses.length ? Math.min(...losses) : null,
      openPnl,
      openRisked,
    };
  };

  const cards = MARKETS.map((item) => toStats(item.key, item.label, buckets[item.key]));
  if (other.length) cards.push(toStats('other', 'Other', other));
  return cards;
}

const formatMoney = (value, signed = false) => {
  if (value == null || value === '') return '—';
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  const formatted = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  }).format(Math.abs(number));
  if (!signed) return formatted;
  return `${number >= 0 ? '+' : '-'}${formatted}`;
};

const formatPercent = (value) => {
  if (value == null || value === '') return '—';
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return `${number >= 0 ? '+' : '-'}${Math.abs(number * 100).toFixed(1)}%`;
};

const tone = (value) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number === 0) return '';
  return number > 0 ? 'positive' : 'negative';
};

const countLine = (card) => {
  const parts = [];
  if (card.settledCount) parts.push(`${card.settledCount} settled`);
  if (card.openCount) parts.push(`${card.openCount} open`);
  if (card.awaitingCount) parts.push(`${card.awaitingCount} awaiting`);
  return parts.join(' · ') || `${card.count} contracts`;
};

function MarketSummaryCard({ card }) {
  const headerMeta = card.count ? `${card.period} · ${countLine(card)}` : 'No tracked contracts';
  const performanceHeadingId = `pm-summary-${card.key}-performance`;
  const recordHeadingId = `pm-summary-${card.key}-record`;

  return (
    <article className="pm-summary-section" data-market={card.key} aria-label={`${card.label} overview`}>
      <header className="pm-summary-section__header">
        <strong>{card.label}</strong>
        <span>{headerMeta}</span>
      </header>
      <div className="pm-summary-section__columns">
        <section className="pm-summary-section__column" aria-labelledby={performanceHeadingId}>
          <h3 id={performanceHeadingId}>Performance</h3>
          <dl>
            <div>
              <dt>Realized</dt>
              <dd className={tone(card.realizedPnl)}>{formatMoney(card.realizedPnl, true)}</dd>
            </div>
            <div>
              <dt>Total P&amp;L</dt>
              <dd className={tone(card.totalPnl)}>{formatMoney(card.totalPnl, true)}</dd>
            </div>
            <div>
              <dt>ROI</dt>
              <dd className={tone(card.roi)}>{formatPercent(card.roi)}</dd>
            </div>
          </dl>
        </section>
        <section className="pm-summary-section__column" aria-labelledby={recordHeadingId}>
          <h3 id={recordHeadingId}>Record</h3>
          <dl>
            <div>
              <dt>Hit</dt>
              <dd>{card.hitLabel || '—'}</dd>
            </div>
            <div>
              <dt>Best</dt>
              <dd className={tone(card.biggestWin)}>{formatMoney(card.biggestWin, true)}</dd>
            </div>
            <div>
              <dt>Worst</dt>
              <dd className={tone(card.biggestLoss)}>{formatMoney(card.biggestLoss, true)}</dd>
            </div>
          </dl>
        </section>
      </div>
      <section className="pm-summary-section__open" aria-label={`${card.label} unsettled position`}>
        <h3>Unsettled position</h3>
        <dl>
          <div>
            <dt>At risk</dt>
            <dd>{formatMoney(card.openRisked)}</dd>
          </div>
          <div>
            <dt>Unsettled P&amp;L</dt>
            <dd className={tone(card.openPnl)}>{formatMoney(card.openPnl, true)}</dd>
          </div>
        </dl>
      </section>
    </article>
  );
}

export default function PredictionMarketSummaryCard({ accountId, data: externalData, status: externalStatus, error: externalError }) {
  const [state, setState] = useState({ status: 'loading', data: null, error: null });
  const requestIdRef = useRef(0);
  const isControlled = externalData !== undefined || externalStatus !== undefined || externalError !== undefined;

  const load = useCallback(async () => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    if (!accountId) {
      if (requestId === requestIdRef.current) {
        setState({ status: 'unavailable', data: null, error: 'Select an IBKR account to view Overview.' });
      }
      return;
    }
    setState((current) => ({ ...current, status: current.data ? 'refreshing' : 'loading', error: null }));
    try {
      const data = await MarketDataService.getPredictionMarketPerformance({
        account: accountId,
        market: 'all',
        sort: 'date',
        direction: 'desc',
      });
      if (requestId === requestIdRef.current) setState({ status: 'ready', data, error: null });
    } catch (error) {
      if (requestId === requestIdRef.current) {
        setState({
          status: 'unavailable',
          data: null,
          error: apiErrorMessage(error),
        });
      }
    }
  }, [accountId]);

  useEffect(() => {
    if (isControlled) return undefined;
    load();
    const timer = window.setInterval(load, 60_000);
    return () => {
      window.clearInterval(timer);
      requestIdRef.current += 1;
    };
  }, [isControlled, load]);

  const displayState = isControlled
    ? {
      status: externalStatus || (externalData ? 'ready' : 'loading'),
      data: externalData,
      error: externalError,
    }
    : state;
  const cards = useMemo(() => {
    const summaries = buildMarketSummaries(displayState.data?.rows || []);
    if (displayState.data?.tracker?.currentDataComplete !== false) return summaries;
    return summaries.map((card) => ({
      ...card,
      totalPnl: null,
      roi: null,
      openPnl: null,
      openRisked: null,
    }));
  }, [displayState.data?.rows, displayState.data?.tracker?.currentDataComplete]);

  return (
    <div className="pm-summary-shell" data-status={displayState.status}>
      {!accountId && !isControlled ? (
        <div className="pm-summary-state">{displayState.error}</div>
      ) : displayState.status === 'loading' ? (
        <div className="pm-summary-state"><LoadingIndicator label="Loading Overview…" size="sm" /></div>
      ) : displayState.status === 'unavailable' ? (
        <div className="pm-summary-state pm-summary-state--paused">
          <strong>P&L unavailable</strong>
          <span>{displayState.error || 'Prediction-market performance is unavailable.'}</span>
        </div>
      ) : (
        <div className="pm-summary-list">
          {displayState.status === 'refreshing' && <p className="pm-summary-refreshing">Refreshing…</p>}
          {cards.length ? cards.map((card) => (
            <MarketSummaryCard key={card.key} card={card} />
          )) : (
            <div className="pm-summary-state">No tracked contracts yet.</div>
          )}
        </div>
      )}
    </div>
  );
}
