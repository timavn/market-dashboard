import React, { useMemo } from 'react';
import useContractPerformance from '../../hooks/useContractPerformance';
import { useSurfaceActivity } from '../common/PersistentSurface';
import { contractHistoryIncomplete, contractPerformanceMarket, contractPerformanceMarkets } from '../../utils/contractPerformancePresentation';
import LoadingIndicator from '../common/LoadingIndicator';
import './PredictionMarketSummaryCard.css';

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

const resolveMarketKey = contractPerformanceMarket;

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

export function buildMarketSummaries(rows = []) {
  if (!rows.length) return [];

  const markets = contractPerformanceMarkets(rows);
  const buckets = Object.fromEntries(markets.map((item) => [item.key, []]));
  rows.forEach((row) => {
    const key = resolveMarketKey(row);
    buckets[key].push(row);
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

  return markets.map((item) => toStats(item.key, item.label, buckets[item.key]));
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
  const headerMeta = card.count ? `${card.period} · ${countLine(card)}`
    : card.partial ? 'No verified records · Account history incomplete'
      : card.currentUnavailable ? 'No settled records · Current unavailable' : 'No tracked contracts';
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
              <dt>{card.partial ? 'Realized subtotal' : 'Realized'}</dt>
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
  const active = useSurfaceActivity();
  const isControlled = externalData !== undefined || externalStatus !== undefined || externalError !== undefined;
  const state = useContractPerformance({ account: accountId, active: active && !isControlled });

  const displayState = isControlled
    ? {
      status: externalStatus || (externalData ? 'ready' : 'loading'),
      data: externalData,
      error: externalError,
    }
    : state;
  const cards = useMemo(() => {
    const summaries = buildMarketSummaries(displayState.data?.rows || []);
    const currentUnavailable = displayState.data?.tracker?.currentDataComplete === false
      || displayState.data?.availability?.current?.status === 'unavailable';
    const historyIncomplete = contractHistoryIncomplete(displayState.data);
    return summaries.map((card) => ({
      ...card,
      partial: historyIncomplete,
      currentUnavailable,
      ...((currentUnavailable || historyIncomplete) ? { totalPnl: null, roi: null } : {}),
      ...(currentUnavailable ? { openPnl: null, openRisked: null } : {}),
    }));
  }, [displayState.data]);

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
            <div className="pm-summary-state">{contractHistoryIncomplete(displayState.data)
              ? 'No verified records for this filter. Account history is incomplete.'
              : displayState.data?.availability?.current?.status === 'unavailable'
                ? 'No settled records for this filter. Current contracts unavailable.'
              : 'No tracked contracts yet.'}</div>
          )}
        </div>
      )}
    </div>
  );
}
