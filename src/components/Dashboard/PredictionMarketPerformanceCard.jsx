import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { MarketDataService } from '../../services/api/marketDataService';
import LoadingIndicator from '../common/LoadingIndicator';
import PopoverSelect from '../common/PopoverSelect';
import PredictionMarketSummaryCard from './PredictionMarketSummaryCard';
import PredictionMarketSp500Research from './PredictionMarketSp500Research';
import './PredictionMarketPerformanceCard.css';
import { useSurfaceActivity } from '../common/PersistentSurface';
import useContractPerformance from '../../hooks/useContractPerformance';
import RefreshButton from '../common/RefreshButton';
import { contractHistoryIncomplete, contractPerformanceMarket, contractPerformanceMarkets, finalContractRow } from '../../utils/contractPerformancePresentation';

const OVERVIEW_TAB = { key: 'overview', label: 'Overview' };
const RESEARCH_TAB = { key: 'research', label: 'Research' };
const OPEN_TAB = { key: 'open', label: 'Open' };

const VENUE_OPTIONS = [
  { value: 'all', label: 'All venues' },
  { value: 'kalshi', label: 'Kalshi' },
  { value: 'forecastex', label: 'ForecastEx' },
];

const FILTERS = [{ key: 'all', label: 'All' }, ...contractPerformanceMarkets()];

const MARKET_LABELS = Object.fromEntries(
  FILTERS.filter((item) => item.key !== 'all').map((item) => [item.key, item.label]),
);

const MARKET_PREFIXES = Object.values(MARKET_LABELS).sort((left, right) => right.length - left.length);

const COLUMNS = [
  { key: 'date', label: 'Date', field: 'date' },
  { key: 'status', label: 'Status', field: 'status' },
  { key: 'contract', label: 'Contract', field: 'contractLabel' },
  { key: 'quantity', label: 'Qty', field: 'entryQuantity', sortable: false },
  { key: 'settlementValue', label: 'Reference', field: 'settlementValue' },
  { key: 'resolutionAt', label: 'Resolves', field: 'resolutionAt' },
  { key: 'risked', label: 'Cost', field: 'risked' },
  { key: 'value', label: 'Value', field: 'currentValue' },
  { key: 'pnl', label: 'P&L', field: 'pnl' },
  { key: 'roi', label: 'Return', field: 'roi' },
];

const SUMMARY_LABEL_COLSPAN = 5;

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

const formatPercent = (value, signed = false) => {
  if (value == null || value === '') return '—';
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  const formatted = `${Math.abs(number * 100).toFixed(1)}%`;
  if (!signed) return formatted;
  return `${number >= 0 ? '+' : '-'}${formatted}`;
};

const formatContractPrice = (value) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1) return null;
  return `${(number * 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}¢`;
};

const formatQuantity = (value) => {
  const number = Number(value);
  return Number.isFinite(number)
    ? number.toLocaleString('en-US', { maximumFractionDigits: 2 })
    : '—';
};

const formatDate = (value) => {
  if (!value) return '—';
  const parsed = new Date(`${String(value).slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: '2-digit', timeZone: 'UTC' }).format(parsed);
};

const accountRowKey = (row = {}, revision = '') => `${row.accountId || 'unknown'}:${row.id || row.recordKey || 'row'}:${revision}`;

const formatVenueDateTime = (value, timeZone, suffix, includeDate = true) => {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  const options = {
    ...(includeDate ? { month: 'short', day: 'numeric' } : {}),
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone,
  };
  return `${new Intl.DateTimeFormat('en-US', options).format(new Date(parsed)).replace(', ', ' ')} ${suffix}`;
};

const formatPacificDateTime = (value, includeDate = true) => (
  formatVenueDateTime(value, 'America/Los_Angeles', 'PT', includeDate)
);

const resolutionDisplay = (row = {}) => {
  const parsed = Date.parse(row.resolutionAt);
  if (Number.isFinite(parsed)) {
    return formatPacificDateTime(row.resolutionAt);
  }
  return formatDate(row.settlementDate);
};

const scheduleTiming = (row = {}) => {
  if (row.outcomeObservedAt) {
    return { label: 'Settled', value: row.outcomeObservedAt };
  }
  return null;
};

const scheduleTooltip = (row = {}) => {
  const timing = scheduleTiming(row);
  return [
    row.lastTradeAt && `Last trade: ${formatPacificDateTime(row.lastTradeAt)} (${formatVenueDateTime(row.lastTradeAt, 'America/Chicago', 'CT')})`,
    row.resolutionAt && `Resolves: ${formatPacificDateTime(row.resolutionAt)} (${formatVenueDateTime(row.resolutionAt, 'America/Chicago', 'CT')})`,
    timing && `${timing.label}: ${formatPacificDateTime(timing.value)} (${formatVenueDateTime(timing.value, 'America/Chicago', 'CT')})`,
  ].filter(Boolean).join('\n');
};

const tradingDayKey = (value = new Date()) => (
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(value instanceof Date ? value : new Date(value))
);

const calendarDateKey = (value) => {
  const raw = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw.slice(0, 10))) return raw.slice(0, 10);
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? tradingDayKey(new Date(parsed)) : null;
};

const rowGroupDate = (row) => calendarDateKey(row.openedAt) || 'undated';

const formatDayHeading = (dateKey) => {
  if (dateKey === 'undated') return { title: 'Undated', detail: null };
  const parsed = new Date(`${String(dateKey).slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return { title: dateKey, detail: null };
  const weekday = new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(parsed);
  return { title: weekday, detail: null };
};

const groupRowsByDay = (rows = []) => {
  const groups = new Map();
  rows.forEach((row) => {
    const key = rowGroupDate(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  });
  return [...groups.entries()].sort((left, right) => {
    if (left[0] === 'undated') return 1;
    if (right[0] === 'undated') return -1;
    return right[0].localeCompare(left[0]);
  });
};

const FORECASTEX_PRODUCTS = {
  METLG: 'gold',
  COMCO: 'wti',
  FES: 'sp500',
  FNQ: 'nasdaq100',
  CPIY: 'cpi',
};

const KALSHI_PRODUCTS = {
  WTI: 'wti',
  INX: 'sp500',
  CPI: 'cpi',
  BTC: 'bitcoin',
  ETH: 'ethereum',
};

const THRESHOLD_MARKETS = new Set(['wti', 'gold', 'sp500', 'nasdaq100', 'cpi']);

const formatStrikeValue = (market, strike) => {
  const number = Number(strike);
  if (!Number.isFinite(number)) return null;
  if (market === 'cpi') return `${number.toLocaleString('en-US', { maximumFractionDigits: 1 })}%`;
  if (market === 'wti') return number.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (market === 'gold') return number.toLocaleString('en-US', { maximumFractionDigits: 1 });
  if (market === 'bitcoin' || market === 'ethereum') return number.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return number.toLocaleString('en-US', { maximumFractionDigits: 0 });
};

const formatSettlementValue = (row = {}) => {
  const number = Number(row.settlementValue);
  if (row.settlementValue == null || !Number.isFinite(number)) return '—';
  if (row.market === 'cpi') return `${number.toLocaleString('en-US', { maximumFractionDigits: 1 })}%`;
  if (['wti', 'gold', 'bitcoin', 'ethereum'].includes(row.market)) {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(number);
  }
  return number.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

const parseVenueTicker = (source = '') => {
  const raw = String(source || '').toUpperCase();
  const forecastEx = raw.match(/(METLG|COMCO|FES|FNQ|CPIY)[_-]\d{4,6}[_-](-?\d+(?:\.\d+)?)(?:[_-](YES|NO))?/);
  if (forecastEx) {
    return {
      market: FORECASTEX_PRODUCTS[forecastEx[1]],
      strike: Number(forecastEx[2]),
      side: forecastEx[3] || null,
      rule: 'above',
    };
  }
  const kalshi = raw.match(/KX(WTI|INX|CPI|BTC|ETH)[A-Z0-9]*[-_][A-Z0-9]+[-_]([TB])?(-?\d+(?:\.\d+)?)[-_](YES|NO)/);
  if (kalshi) {
    const market = KALSHI_PRODUCTS[kalshi[1]];
    const marker = kalshi[2] || null;
    return {
      market,
      strike: Number(kalshi[3]),
      side: kalshi[4],
      rule: marker === 'T' ? 'above' : marker === 'B' && THRESHOLD_MARKETS.has(market) ? 'below' : null,
    };
  }
  return null;
};

const forecastExContractDescriptor = (row = {}) => {
  const source = [row.contractKey, row.eventTicker, row.localSymbol]
    .filter(Boolean)
    .join(' ')
    .toUpperCase();
  const match = source.match(/\b(COMCO|METLG|FES|FNQ|CPIY)[_-](\d{2})(\d{2})(\d{2})[_-](-?\d+(?:\.\d+)?)(?:[_-](YES|NO))?/);
  if (!match) return null;
  const eventContract = `${match[1]}_${match[2]}${match[3]}${match[4]}_${match[5]}`;
  const side = String(row.contractSide || match[6] || '').toUpperCase();
  return {
    productCode: match[1],
    ticker: `${eventContract}${['YES', 'NO'].includes(side) ? `_${side}` : ''}`,
  };
};

const looksLikeRawTicker = (value) => /METLG|COMCO|FES_|FNQ_|CPIY|\bKX[A-Z]/i.test(String(value || ''));

const splitPriceAndSide = (value, fallbackSide = null) => {
  const raw = String(value || '').trim();
  const match = raw.match(/^(.*?)\s+(YES|NO)$/i);
  if (match) return { strike: match[1].trim() || '—', side: match[2].toUpperCase() };
  const side = String(fallbackSide || '').toUpperCase();
  return { strike: raw || '—', side: side === 'YES' || side === 'NO' ? side : null };
};

const normalizeContractDirection = (value) => {
  const raw = String(value || '').toLowerCase().replace(/[^a-z]+/g, '_');
  if (/^(?:above|greater|greater_than|at_or_above)$/.test(raw)) return 'above';
  if (/^(?:below|less|less_than|under)$/.test(raw)) return 'below';
  return null;
};

const contractIdentityParts = (row = {}) => {
  const source = [row.contractLabel, row.contractKey, row.eventTicker].filter(Boolean).join(' ');
  const parsed = parseVenueTicker(source);
  const marketKey = contractPerformanceMarket(row);
  const market = contractPerformanceMarkets([row]).find((item) => item.key === marketKey)?.label || 'Contract';
  const label = String(row.contractLabel || '').trim();
  let parts = splitPriceAndSide(label, row.contractSide || parsed?.side);
  for (const prefix of MARKET_PREFIXES) {
    const match = label.match(new RegExp(`^${prefix}\\s+(.+)$`, 'i'));
    if (match) {
      parts = splitPriceAndSide(match[1], row.contractSide || parsed?.side);
      break;
    }
  }
  const thresholdLabel = String(parts.strike || '').match(/^(?:Above|Below)\s+(.+)$/i);
  if (thresholdLabel) parts = { ...parts, strike: thresholdLabel[1] };
  const numericStrike = Number.isFinite(Number(row.strike)) ? Number(row.strike) : parsed?.strike;
  if (looksLikeRawTicker(parts.strike)) {
    parts = { ...parts, strike: formatStrikeValue(marketKey, numericStrike) || '—' };
  }
  const side = parts.side || parsed?.side || null;
  const direction = normalizeContractDirection(row.contractRule)
    || normalizeContractDirection(parsed?.rule)
    // The supported ForecastEx/Kalshi threshold products are above-strike
    // contracts unless the authoritative row/ticker explicitly says below.
    || (THRESHOLD_MARKETS.has(marketKey) ? 'above' : null);
  return {
    market,
    marketKey,
    strike: String(parts.strike || '—').replace(/\$/g, ''),
    side,
    direction,
  };
};

const rowTone = (value) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number === 0) return '';
  return number > 0 ? 'positive' : 'negative';
};

const settledStatus = (status) => String(status || '').toLowerCase() === 'verified';

const currentOpenContract = (row = {}) => (
  String(row.displayState || '').toUpperCase() === 'OPEN'
  || String(row.status || '').toLowerCase() === 'open'
);

const awaitingFinalResult = (row = {}) => (
  String(row.displayState || '').toUpperCase() === 'AWAITING_RESULT'
  || row.status === 'awaiting_resolution'
);

const displayedRowValue = (row = {}) => (
  row.currentValue ?? (settledStatus(row.status) ? row.paid : null)
);

const finiteMetric = (value) => {
  if (value == null || (typeof value === 'string' && value.trim() === '')) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const preliminaryReferenceMark = (row = {}) => (
  awaitingFinalResult(row)
  && String(row.valuationStatus || '') === 'preliminary'
  && finiteMetric(row.preliminaryReferenceValue) != null
  && ['YES', 'NO'].includes(String(row.preliminaryOutcome || '').toUpperCase())
  && Number.isFinite(Date.parse(row.preliminaryReferenceCutoffAt))
);

const preliminaryContractMark = (row = {}) => (
  awaitingFinalResult(row)
  && String(row.markState || '') === 'official_reference'
  && String(row.markSource || '') === 'forecastex_official_price'
  && finiteMetric(row.markPrice) != null
  && finiteMetric(row.markPrice) >= 0
  && finiteMetric(row.markPrice) <= 1
  && Number.isFinite(Date.parse(row.markObservedAt))
);

const completeMetricTotal = (rows, selectValue) => {
  if (!rows.length) return null;
  const values = rows.map((row) => finiteMetric(selectValue(row)));
  if (values.some((value) => value == null)) return null;
  return values.reduce((total, value) => total + value, 0);
};

const missingMetricCount = (rows, selectValue) => (
  rows.filter((row) => finiteMetric(selectValue(row)) == null).length
);

const incompletePerformanceEvidence = (row = {}) => {
  if (!settledStatus(row.status)) return null;
  const basisUnavailable = finiteMetric(row.risked) == null;
  const performanceUnavailable = row.performanceComplete === false
    || finiteMetric(row.pnl) == null;
  if (!basisUnavailable && !performanceUnavailable) return null;
  return {
    basisUnavailable,
    performanceUnavailable,
    reason: basisUnavailable
      ? (row.coverageMessage || 'Historical activity source not configured; exact cost basis, P&L, and ROI are unavailable.')
      : 'Complete broker cost and fee evidence is unavailable, so P&L and ROI are not calculated.',
  };
};

const pendingFinalTitle = (row = {}) => {
  const identitySource = [row.exchange, row.contractKey, row.eventTicker].filter(Boolean).join(' ');
  const venue = /FORECAST|\b(?:COMCO|METLG|FES|FNQ|CPIY)[_-]/i.test(identitySource)
    ? 'ForecastEx'
    : String(row.exchange || 'venue');
  const symbol = row.settlementSymbol ? ` for ${row.settlementSymbol}` : '';
  const scheduled = row.resolutionAt
    ? ` Scheduled to resolve ${formatPacificDateTime(row.resolutionAt)}.`
    : '';
  if (preliminaryReferenceMark(row)) {
    const reference = Number(row.preliminaryReferenceValue).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const high = Number(row.preliminaryReferenceWindowHigh).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const low = Number(row.preliminaryReferenceWindowLow).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const cutoff = formatPacificDateTime(row.preliminaryReferenceCutoffAt);
    const source = `the exact ${row.settlementSymbol || 'resolver'} cutoff bar (${low}–${high}, close ${reference}) ending ${cutoff}`;
    return `Preliminary ${row.preliminaryOutcome} outcome from ${source}. Final ${venue} settlement${symbol} remains pending.${scheduled}`;
  }
  if (preliminaryContractMark(row)) {
    const price = formatContractPrice(row.markPrice);
    return `Preliminary mark-to-market from the official ForecastEx ${price} contract price. Final ${venue} settlement${symbol} remains pending.${scheduled}`;
  }
  return `Awaiting the official ${venue} final result${symbol}.${scheduled} No preliminary value is available from a verified source.`;
};

const summarizeDay = (rows = []) => {
  const cost = completeMetricTotal(rows, (row) => row.risked);
  const value = completeMetricTotal(rows, displayedRowValue);
  const pnl = completeMetricTotal(rows, (row) => row.pnl);
  const pendingRows = rows.filter((row) => awaitingFinalResult(row));
  const preliminaryRows = rows.filter((row) => (
    preliminaryReferenceMark(row) || preliminaryContractMark(row)
  ));
  const savedVsHold = completeMetricTotal(rows, (row) => row.savedVsHold);
  const holdToExpiryPnl = completeMetricTotal(rows, (row) => row.holdToExpiryPnl);
  return {
    cost,
    value,
    pnl,
    roi: cost != null && cost > 0 && pnl != null ? pnl / cost : null,
    missing: {
      cost: missingMetricCount(rows, (row) => row.risked),
      value: missingMetricCount(rows, displayedRowValue),
      pnl: missingMetricCount(rows, (row) => row.pnl),
    },
    pending: {
      cost: missingMetricCount(pendingRows, (row) => row.risked),
      value: missingMetricCount(pendingRows, displayedRowValue),
      pnl: missingMetricCount(pendingRows, (row) => row.pnl),
    },
    pendingResultCount: pendingRows.length,
    preliminaryResultCount: preliminaryRows.length,
    savedVsHold,
    holdToExpiryPnl,
    evidenceGapCount: rows.filter((row) => incompletePerformanceEvidence(row)).length,
  };
};

const pendingSummaryTitle = (count) => (
  count > 0
    ? `${count} contract${count === 1 ? '' : 's'} await the official final result; no partial total is shown.`
    : undefined
);

const preliminarySummaryTitle = (summary) => (
  summary.preliminaryResultCount > 0
    ? `${summary.preliminaryResultCount} awaiting contract${summary.preliminaryResultCount === 1 ? '' : 's'} use an exact verified cutoff bar; final settlement is still pending.`
    : undefined
);

const formatSummaryMoney = (value, summary, metric, signed = false) => {
  if (value != null) return formatMoney(value, signed);
  if (summary.pending[metric] > 0) return 'Pending';
  return summary.evidenceGapCount > 0 ? 'Incomplete' : formatMoney(value, signed);
};

const formatSummaryPercent = (value, summary) => {
  if (value != null) return formatPercent(value, true);
  if (summary.pending.pnl > 0) return 'Pending';
  return summary.evidenceGapCount > 0 ? 'Incomplete' : formatPercent(value, true);
};

const incompleteSummaryTitle = (missingCount) => (
  missingCount > 0
    ? `${missingCount} contract${missingCount === 1 ? '' : 's'} lack complete source data; no partial total is shown.`
    : undefined
);

const statusLabel = (row = {}) => {
  const explicit = String(row.displayState || '').toUpperCase();
  if (awaitingFinalResult(row)) return 'AWAITING RESULT';
  if (['OPEN', 'CLOSED', 'SETTLED'].includes(explicit)) return explicit;
  if (settledStatus(row.status)) return row.resolutionType === 'early_exit' ? 'CLOSED' : 'SETTLED';
  if (row.status === 'awaiting_resolution') return 'AWAITING RESULT';
  return 'UNAVAILABLE';
};

function PerformanceExecutionDetails({ detailState }) {
  if (!detailState || detailState.status === 'loading') {
    return <div className="pm-performance-detail-state">Loading execution evidence…</div>;
  }
  if (detailState.status === 'error') {
    return <div className="pm-performance-detail-state pm-performance-detail-state--error">Execution evidence is unavailable.</div>;
  }
  const details = detailState.data || {};
  const renderRawLegs = (legs = [], label) => (
    <details className="pm-performance-raw-legs">
      <summary>{legs.length} raw leg{legs.length === 1 ? '' : 's'} · {label}</summary>
      <div className="pm-performance-raw-grid">
        {legs.map((leg) => (
          <div key={leg.execId}>
            <span>{leg.role || leg.direction}</span>
            <strong>{formatQuantity(leg.quantity)} @ {formatContractPrice(leg.price)}</strong>
            <small>{formatPacificDateTime(leg.executionTime)} · {leg.execId}</small>
          </div>
        ))}
      </div>
    </details>
  );
  if (!(details.economicEntries || []).length && !(details.cashOuts || []).length) {
    return (
      <div className="pm-performance-detail-panel">
        {(details.rawExecutions || []).length
          ? renderRawLegs(details.rawExecutions, 'broker executions')
          : <p className="pm-performance-detail-state">Detailed executions unavailable.</p>}
      </div>
    );
  }
  return (
    <div className="pm-performance-detail-panel">
      <div className="pm-performance-detail-summary">
        <span>Bought <strong>{formatQuantity(details.entryQuantity)}</strong></span>
        <span>Exited <strong>{formatQuantity(details.exitedQuantity)}</strong></span>
        <span>Remaining <strong>{formatQuantity(details.remainingQuantity)}</strong></span>
        <span>Net cash-outs <strong>{formatMoney(details.netExitProceeds)}</strong></span>
        <span>Exit fees <strong>{formatMoney(details.exitFees)}</strong></span>
      </div>
      <div className="pm-performance-transaction-groups">
        <section>
          <h4>Entries</h4>
          {(details.economicEntries || []).map((entry) => (
            <div className="pm-performance-transaction" key={entry.id}>
              <div><strong>{formatQuantity(entry.quantity)} @ {formatContractPrice(entry.price)}</strong><span>{formatMoney(entry.totalCost)} cost</span><small>{formatPacificDateTime(entry.executedAt)}</small></div>
              {renderRawLegs(entry.rawLegs, 'entry')}
            </div>
          ))}
        </section>
        <section>
          <h4>Cash-outs</h4>
          {(details.cashOuts || []).length ? (details.cashOuts || []).map((cashOut) => (
            <div className="pm-performance-transaction" key={cashOut.id}>
              <div><strong>{formatQuantity(cashOut.quantity)} contracts</strong><span>{formatMoney(cashOut.netProceeds)} net</span><small>{formatPacificDateTime(cashOut.executedAt)} · {formatMoney(cashOut.exchangeFee)} fee</small></div>
              {renderRawLegs(cashOut.rawLegs, 'cash-out')}
            </div>
          )) : <p>No cash-outs.</p>}
        </section>
      </div>
    </div>
  );
}


export default function PredictionMarketPerformanceCard({ accountId }) {
  const active = useSurfaceActivity();
  const [activeTab, setActiveTab] = useState('all');
  const [sort, setSort] = useState('status');
  const [direction, setDirection] = useState('asc');
  const [expandedRows, setExpandedRows] = useState(() => new Set());
  const [executionDetails, setExecutionDetails] = useState({});
  const [venue, setVenue] = useState('all');
  const [search, setSearch] = useState('');
  const accountScopeRef = useRef(String(accountId || '').trim());
  const shellRef = useRef(null);
  const tableHeadRef = useRef(null);
  const researchActive = activeTab === RESEARCH_TAB.key;
  const selectedAccount = String(accountId || '').trim();
  const state = useContractPerformance({
    account: selectedAccount, venue, sort, direction, search, active: active && !researchActive,
  });
  const detailsRevision = state.data?.projectionRevision || state.data?.historyRevision || '';
  const refreshPerformance = state.refresh;
  const detailsRevisionRef = useRef(detailsRevision);
  detailsRevisionRef.current = detailsRevision;
  const filters = [{ key: 'all', label: 'All' }, ...(state.data?.markets || contractPerformanceMarkets())];
  const marketSelected = filters.some((item) => item.key === activeTab && item.key !== 'all');

  useLayoutEffect(() => {
    if (accountScopeRef.current === selectedAccount) return;
    accountScopeRef.current = selectedAccount;
    setExpandedRows(new Set());
    setExecutionDetails({});
    setSearch('');
  }, [selectedAccount]);

  useLayoutEffect(() => {
    setExpandedRows(new Set());
    setExecutionDetails({});
  }, [detailsRevision]);

  useLayoutEffect(() => {
    const shell = shellRef.current;
    const head = tableHeadRef.current;
    if (!shell || !head) return undefined;
    const update = () => {
      const height = head.getBoundingClientRect().height;
      if (Number.isFinite(height) && height > 0) shell.style.setProperty('--pm-performance-sticky-header-offset', `${height}px`);
    };
    update();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null;
    observer?.observe(head);
    window.addEventListener('resize', update);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [state.data?.rows, activeTab]);

  const toggleExecutionDetails = useCallback(async (row) => {
    const rowKey = accountRowKey(row, detailsRevision);
    const shouldLoad = !expandedRows.has(rowKey)
      && (!executionDetails[rowKey] || executionDetails[rowKey].status === 'error');
    setExpandedRows((current) => {
      const next = new Set(current);
      if (next.has(rowKey)) next.delete(rowKey);
      else next.add(rowKey);
      return next;
    });
    if (!shouldLoad) return;
    const detailAccount = selectedAccount;
    setExecutionDetails((current) => ({ ...current, [rowKey]: { status: 'loading', data: null } }));
    try {
      const data = await MarketDataService.getPredictionMarketPerformanceExecutions(row.id, {
        account: row.accountId || selectedAccount,
        ...(finalContractRow(row) && detailsRevision ? { revision: detailsRevision } : {}),
      });
      if (accountScopeRef.current === detailAccount && detailsRevisionRef.current === detailsRevision) setExecutionDetails((current) => ({ ...current, [rowKey]: { status: 'ready', data } }));
    } catch (error) {
      if (accountScopeRef.current === detailAccount && detailsRevisionRef.current === detailsRevision) {
        setExecutionDetails((current) => ({ ...current, [rowKey]: { status: 'error', data: null } }));
        if (error?.response?.status === 409 && error.response.data?.projectionRevision) {
          refreshPerformance({ revision: error.response.data.projectionRevision });
        }
      }
    }
  }, [detailsRevision, executionDetails, expandedRows, selectedAccount, refreshPerformance]);

  const baseSummary = (marketSelected ? state.data?.summaries?.[activeTab] : state.data?.summary) || {
    count: null,
    openCount: null,
    openPnl: null,
    awaitingCount: null,
    awaitingPnl: null,
    realizedCount: null,
    realizedPnl: null,
    pnl: null,
    roi: null,
  };
  const visibleRows = useMemo(() => {
    let rows = (state.data?.rows || []).filter((row) => (
      row.status !== 'review' && String(row.displayState || '').toUpperCase() !== 'CHECK'
    ));
    if (marketSelected) {
      rows = rows.filter((row) => contractIdentityParts(row).marketKey === activeTab);
    }
    return activeTab === OPEN_TAB.key ? rows.filter(currentOpenContract) : rows;
  }, [activeTab, marketSelected, state.data?.rows]);
  const currentUnavailable = state.data?.availability?.current?.status === 'unavailable';
  const currentKnown = Boolean(state.data) && !currentUnavailable;
  const summary = activeTab === OPEN_TAB.key
    ? {
      ...baseSummary,
      count: currentKnown ? finiteMetric(baseSummary.openCount) ?? visibleRows.length : null,
      awaitingCount: currentKnown ? 0 : null,
      awaitingPnl: currentKnown ? 0 : null,
      realizedCount: currentKnown ? 0 : null,
      realizedPnl: currentKnown ? 0 : null,
      pnl: baseSummary.openPnl,
    }
    : baseSummary;
  const openCount = Number(state.data?.tracker?.openCount || 0);
  const historyIncomplete = contractHistoryIncomplete(state.data);
  const partialRecords = currentUnavailable || historyIncomplete;
  const emptyMessage = activeTab === OPEN_TAB.key && currentUnavailable
    ? 'Current contracts unavailable.'
    : historyIncomplete && activeTab !== OPEN_TAB.key
      ? 'No verified records for this filter.'
      : activeTab === OPEN_TAB.key
    ? openCount > 0
      ? `Tracking ${openCount} open contract${openCount === 1 ? '' : 's'}, but their contract details are temporarily unavailable.`
      : 'No current open contracts.'
    : Number(summary.awaitingCount || 0) > 0
      ? `Waiting for final settlement on ${summary.awaitingCount} contract${summary.awaitingCount === 1 ? '' : 's'}. Contract details will remain visible here.`
      : Number(summary.openCount || 0) > 0
        ? `Tracking ${summary.openCount} open contract${summary.openCount === 1 ? '' : 's'}, but their contract details are temporarily unavailable.`
        : 'No verified contract P&L is available for this selection.';
  const setSortValue = (key) => {
    if (sort === key) setDirection((current) => (current === 'asc' ? 'desc' : 'asc'));
    else { setSort(key); setDirection(key === 'status' || key === 'contract' ? 'asc' : 'desc'); }
  };
  const dayGroups = useMemo(
    () => groupRowsByDay(visibleRows),
    [visibleRows],
  );
  const preliminaryCount = visibleRows.filter((row) => (
    preliminaryReferenceMark(row) || preliminaryContractMark(row)
  )).length;
  const renderTab = (item) => (
    <button
      key={item.key}
      type="button"
      role="tab"
      data-market={item.key}
      aria-selected={activeTab === item.key}
      className={activeTab === item.key ? 'active' : ''}
      onClick={() => setActiveTab(item.key)}
    >
      {item.label}
    </button>
  );

  return (
    <div className="pm-performance-shell" data-status={state.status} ref={shellRef}>
      <div className="pm-performance-scope-controls" aria-label="Contract P&L reporting scope">
        <PopoverSelect
          ariaLabel="Venue"
          value={venue}
          options={VENUE_OPTIONS}
          onChange={setVenue}
          rootClassName="pm-performance-scope-select pm-performance-scope-select--venue"
          buttonClassName="pm-performance-scope-trigger"
          buttonLabel="Venue"
          menuClassName="pm-performance-scope-menu"
          optionClassName="pm-performance-scope-option"
          menuMatchButtonWidth
          menuOffset={4}
          showChevron
          showSelectionMark
        />
        {!researchActive && <input
          type="search"
          className="pm-performance-search"
          aria-label="Search contracts"
          placeholder="Search contracts"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />}
        {partialRecords && (
          <span className="pm-performance-scope-note" title={[
            historyIncomplete && 'Account history is incomplete. Subtotals include only independently verified records.',
            currentUnavailable && 'Current positions and P&L are unavailable. Verified settled history remains readable.',
            state.data?.availability?.history?.observedAt && `History checked ${formatPacificDateTime(state.data.availability.history.observedAt)}`,
          ].filter(Boolean).join(' ')}>
            {historyIncomplete ? 'Verified records only' : 'Current P&L unavailable'}
          </span>
        )}
        {!researchActive && <RefreshButton
          onClick={state.refresh}
          loading={['loading', 'refreshing'].includes(state.status)}
          disabled={!selectedAccount}
          label={state.status === 'unavailable' ? 'Retry P&L' : 'Refresh P&L'}
          className="pm-performance-refresh-button"
        />}

      </div>
      <div className="pm-performance-tabs" role="tablist" aria-label="Contract P&L views and market filters">
        <div className="pm-performance-tab-group pm-performance-tab-group--markets" data-tab-group="markets" role="group" aria-label="Market filters">
          {filters.map(renderTab)}
        </div>
        <div className="pm-performance-tab-group pm-performance-tab-group--views" data-tab-group="views" role="group" aria-label="P&L views">
          {[OVERVIEW_TAB, RESEARCH_TAB, OPEN_TAB].map(renderTab)}
        </div>
      </div>
      {activeTab === RESEARCH_TAB.key ? (
        <PredictionMarketSp500Research accountId={selectedAccount || null} />
      ) : activeTab === OVERVIEW_TAB.key ? (
        <div className="pm-performance-summary-view">
          <PredictionMarketSummaryCard
            accountId={selectedAccount || null}
            data={state.data}
            status={state.status}
            error={state.error}
          />
        </div>
      ) : (
        <>
          <dl className="pm-performance-summary" aria-label="Contract P&L summary" aria-live="polite">
            {[
              { key: 'count', label: 'CONTRACTS', value: summary.count ?? '—' },
              { key: 'open', label: 'OPEN', value: formatMoney(summary.openPnl, true), tone: rowTone(summary.openPnl) },
              { key: 'awaiting', label: preliminaryCount > 0 ? 'AWAITING MTM' : 'AWAITING', value: formatMoney(summary.awaitingPnl, true), tone: rowTone(summary.awaitingPnl) },
              { key: 'realized', label: historyIncomplete ? 'REALIZED SUBTOTAL' : 'REALIZED', value: formatMoney(summary.realizedPnl, true), tone: rowTone(summary.realizedPnl) },
              { key: 'total', label: preliminaryCount > 0 ? 'MTM TOTAL' : 'TOTAL', value: formatMoney(summary.pnl, true), tone: rowTone(summary.pnl) },
            ].map((metric) => (
              <div key={metric.key} className="pm-performance-summary-cell">
                <dt>{metric.label}</dt>
                <dd className={metric.tone}>{metric.value}</dd>
              </div>
            ))}
          </dl>
          {state.status === 'refreshing' && <span className="pm-performance-refreshing" role="status">Refreshing…</span>}
          {!selectedAccount ? (
            <div className="pm-performance-state">{state.error}</div>
          ) : state.status === 'loading' ? (
            <div className="pm-performance-state"><LoadingIndicator label="Loading contract P&L…" size="sm" /></div>
          ) : state.status === 'unavailable' ? (
            <div className="pm-performance-state pm-performance-state--paused"><strong>P&L unavailable</strong><span>{state.error || 'Contract P&L could not be refreshed. Try again.'}</span></div>
          ) : (
            <>
              {visibleRows.length ? (
                <div
                  className="pm-performance-table-wrap"
                  role="region"
                  aria-label="Contract P&L table"
                  tabIndex={0}
                >
                  <table className="pm-performance-table">
                    <colgroup>{COLUMNS.map((column) => <col key={column.key} className={`pm-performance-col pm-performance-col--${column.key}`} />)}</colgroup>
                    <thead ref={tableHeadRef}>
                      <tr>
                        {COLUMNS.map((column) => {
                          const sortable = column.sortable !== false;
                          const activeSort = sort === column.key;
                          return (
                            <th
                              key={column.key}
                              className={`pm-performance-header pm-performance-header--${column.key}`}
                              aria-sort={sortable ? (activeSort ? (direction === 'asc' ? 'ascending' : 'descending') : 'none') : undefined}
                            >
                              {sortable ? (
                                <button type="button" onClick={() => setSortValue(column.key)}>
                                  <span className="pm-performance-header-cluster">
                                    <span>{column.label}</span>
                                    {activeSort && (
                                      <span className="pm-performance-sort-icon" aria-hidden="true">{direction === 'asc' ? '↑' : '↓'}</span>
                                    )}
                                  </span>
                                </button>
                              ) : (
                                <span className="pm-performance-header-cluster"><span>{column.label}</span></span>
                              )}
                            </th>
                          );
                        })}
                      </tr>
                    </thead>
                    {dayGroups.map(([dateKey, rows]) => {
                      const heading = formatDayHeading(dateKey);
                      const daySummary = summarizeDay(rows);
                      const expandedDetailCount = rows.filter((row) => expandedRows.has(accountRowKey(row, detailsRevision))).length;
                      const dateRowSpan = rows.length + expandedDetailCount + 1;
                      return (
                        <tbody
                          key={dateKey}
                          className="pm-performance-day-card"
                          data-day={dateKey}
                          aria-label={`${heading.title} contracts`}
                        >
                          {rows.map((row, rowIndex) => {
                            const identity = contractIdentityParts(row);
                            const contractDescriptor = forecastExContractDescriptor(row);
                            const resolution = resolutionDisplay(row);
                            const evidenceGap = incompletePerformanceEvidence(row);
                            const finalPending = awaitingFinalResult(row);
                            const preliminaryReference = preliminaryReferenceMark(row);
                            const preliminaryPrice = preliminaryContractMark(row);
                            const preliminary = preliminaryReference || preliminaryPrice;
                            const finalPendingTitle = finalPending || preliminary ? pendingFinalTitle(row) : undefined;
                            const valuePending = finalPending && finiteMetric(displayedRowValue(row)) == null;
                            const pnlPending = finalPending && finiteMetric(row.pnl) == null;
                            const roiPending = finalPending && finiteMetric(row.roi) == null;
                            const rowKey = accountRowKey(row, detailsRevision);
                            const expanded = expandedRows.has(rowKey);
                            return (
                              <React.Fragment key={rowKey}>
                              <tr data-market={identity.marketKey} data-day={dateKey} aria-label={`${identity.market} ${identity.strike}${identity.side ? ` ${identity.side}` : ''}`} aria-expanded={expanded}>
                                {rowIndex === 0 && (
                                  <th
                                    scope="rowgroup"
                                    rowSpan={dateRowSpan}
                                    data-label="Date"
                                    className="pm-performance-day-date"
                                  >
                                    <span>{heading.title}</span>
                                    {heading.detail && <small>{heading.detail}</small>}
                                  </th>
                                )}
                                <td data-label="Status" className="pm-performance-status">
                                  <strong data-tone={statusLabel(row).toLowerCase().replaceAll(' ', '-')}>{statusLabel(row)}</strong>
                                  {preliminaryReference && <small className="pm-performance-preliminary-label">Prelim {row.preliminaryOutcome}</small>}
                                  {preliminaryPrice && <small className="pm-performance-preliminary-label">Prelim {formatContractPrice(row.markPrice)}</small>}
                                </td>
                                <td
                                  data-label="Contract"
                                  className="pm-performance-contract"
                                  title={[`${identity.market} ${identity.strike}${identity.side ? ` ${identity.side}` : ''}`, contractDescriptor?.ticker].filter(Boolean).join('\n')}
                                >
                                  <button
                                    type="button"
                                    className="pm-performance-contract-toggle"
                                    onClick={() => toggleExecutionDetails(row)}
                                    aria-expanded={expanded}
                                    aria-label={`${expanded ? 'Collapse' : 'Expand'} ${row.contractLabel || `${identity.strike} ${identity.side || ''}`} transactions`}
                                  >
                                  <span className="pm-performance-contract-detail">
                                    {contractDescriptor?.productCode && (
                                      <span className="pm-performance-contract-code">{contractDescriptor.productCode}</span>
                                    )}
                                    {identity.direction && (
                                      <span
                                        aria-hidden="true"
                                        className={`pm-performance-direction pm-performance-direction--${identity.direction}`}
                                        title={identity.direction === 'above' ? 'Above strike' : 'Below strike'}
                                      >
                                        {identity.direction === 'above' ? '↑' : '↓'}
                                      </span>
                                    )}
                                    <span className="pm-performance-strike">{identity.strike}</span>
                                    {identity.side && <span className="pm-performance-side" data-side={identity.side.toLowerCase()}> {identity.side}</span>}
                                  </span>
                                  <span className="pm-performance-expand-icon" aria-hidden="true">{expanded ? '−' : '+'}</span>
                                  </button>
                                </td>
                                <td data-label="Qty" className="pm-performance-number pm-performance-quantity">
                                  {formatQuantity(row.entryQuantity ?? row.quantity)}
                                </td>
                                <td
                                  data-label="Reference"
                                  className="pm-performance-number pm-performance-settle-price"
                                  title={finalPendingTitle}
                                >
                                  {row.settlementValue != null
                                    ? formatSettlementValue(row)
                                    : preliminaryReference
                                      ? (
                                        <>
                                          <span className="pm-performance-cutoff-reference">
                                            {Number(row.preliminaryReferenceValue).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                          </span>
                                          <small className="pm-performance-preliminary-label">cutoff ref</small>
                                        </>
                                      )
                                      : preliminaryPrice
                                        ? (
                                          <>
                                            <span>{formatContractPrice(row.markPrice)} prelim</span>
                                            {row.settlementSymbol && <small>{row.settlementSymbol}</small>}
                                          </>
                                        )
                                      : finalPending
                                        ? <span className="pm-performance-final-pending">Pending</span>
                                      : <span>{row.settlementSymbol || '—'}</span>}
                                </td>
                                <td data-label="Resolves" className="pm-performance-number pm-performance-schedule" title={scheduleTooltip(row) || (resolution !== '—' ? 'Date only; exact resolution time unavailable.' : undefined)}>
                                  {resolution}
                                </td>
                                <td
                                  data-label="Cost"
                                  className="pm-performance-number pm-performance-money"
                                  title={evidenceGap?.basisUnavailable ? evidenceGap.reason : undefined}
                                >
                                  {evidenceGap?.basisUnavailable
                                    ? <span className="pm-performance-evidence-gap">History unavailable</span>
                                    : formatMoney(row.risked)}
                                </td>
                                <td
                                  data-label="Value"
                                  className={`pm-performance-number pm-performance-money ${preliminary ? 'pm-performance-preliminary-metric' : ''}`}
                                  title={preliminary || valuePending ? finalPendingTitle : undefined}
                                >
                                  {valuePending
                                    ? <span className="pm-performance-final-pending">Pending</span>
                                    : formatMoney(displayedRowValue(row))}
                                </td>
                                <td
                                  data-label="P&L"
                                  className={`pm-performance-number pm-performance-money ${rowTone(row.pnl)} ${preliminary ? 'pm-performance-preliminary-metric' : ''}`}
                                  title={preliminary || pnlPending ? finalPendingTitle : (evidenceGap?.performanceUnavailable ? evidenceGap.reason : undefined)}
                                >
                                  {pnlPending
                                    ? <span className="pm-performance-final-pending">Pending</span>
                                    : evidenceGap?.performanceUnavailable
                                    ? <span className="pm-performance-evidence-gap">Unavailable</span>
                                    : formatMoney(row.pnl, true)}
                                </td>
                                <td
                                  data-label="Return"
                                  className={`pm-performance-number ${rowTone(row.roi)} ${preliminary ? 'pm-performance-preliminary-metric' : ''}`}
                                  title={preliminary || roiPending ? finalPendingTitle : (evidenceGap?.performanceUnavailable ? evidenceGap.reason : undefined)}
                                >
                                  {roiPending
                                    ? <span className="pm-performance-final-pending">Pending</span>
                                    : evidenceGap?.performanceUnavailable
                                    ? <span className="pm-performance-evidence-gap">Unavailable</span>
                                    : formatPercent(row.roi, true)}
                                </td>
                              </tr>
                              {expanded && (
                                <tr className="pm-performance-detail-row" data-day={dateKey}>
                                  <td colSpan={COLUMNS.length - 1}>
                                    <PerformanceExecutionDetails detailState={executionDetails[rowKey]} />
                                  </td>
                                </tr>
                              )}
                              </React.Fragment>
                            );
                          })}
                          <tr className="pm-performance-day-summary" aria-label={`${heading.title} totals`}>
                            <th scope="row" colSpan={SUMMARY_LABEL_COLSPAN}>
                              {daySummary.preliminaryResultCount > 0 ? 'Prelim total' : partialRecords ? 'Day subtotal' : 'Day total'}
                              {daySummary.pendingResultCount > 0 && (
                                <small aria-hidden="true">
                                  {daySummary.pendingResultCount} final{daySummary.pendingResultCount === 1 ? '' : 's'} pending
                                  {daySummary.preliminaryResultCount > 0 && ` · ${daySummary.preliminaryResultCount} prelim ref${daySummary.preliminaryResultCount === 1 ? '' : 's'}`}
                                </small>
                              )}
                              {daySummary.evidenceGapCount > 0 && (
                                <small aria-hidden="true">
                                  {daySummary.evidenceGapCount} basis gap{daySummary.evidenceGapCount === 1 ? '' : 's'}
                                </small>
                              )}
                            </th>
                            <td
                              data-label="Cost"
                              className="pm-performance-number pm-performance-money"
                              title={pendingSummaryTitle(daySummary.pending.cost) || incompleteSummaryTitle(
                                daySummary.evidenceGapCount > 0 ? daySummary.missing.cost : 0,
                              )}
                            >
                              {formatSummaryMoney(daySummary.cost, daySummary, 'cost')}
                            </td>
                            <td
                              data-label="Value"
                              className={`pm-performance-number pm-performance-money ${daySummary.preliminaryResultCount > 0 ? 'pm-performance-preliminary-metric' : ''}`}
                              title={preliminarySummaryTitle(daySummary) || pendingSummaryTitle(daySummary.pending.value) || incompleteSummaryTitle(
                                daySummary.evidenceGapCount > 0 ? daySummary.missing.value : 0,
                              )}
                            >
                              {formatSummaryMoney(daySummary.value, daySummary, 'value')}
                            </td>
                            <td
                              data-label="P&L"
                              className={`pm-performance-number pm-performance-money ${rowTone(daySummary.pnl)} ${daySummary.preliminaryResultCount > 0 ? 'pm-performance-preliminary-metric' : ''}`}
                              title={preliminarySummaryTitle(daySummary) || pendingSummaryTitle(daySummary.pending.pnl) || incompleteSummaryTitle(
                                daySummary.evidenceGapCount > 0 ? daySummary.missing.pnl : 0,
                              )}
                            >
                              {formatSummaryMoney(daySummary.pnl, daySummary, 'pnl', true)}
                            </td>
                            <td
                              data-label="Return"
                              className={`pm-performance-number ${rowTone(daySummary.roi)} ${daySummary.preliminaryResultCount > 0 ? 'pm-performance-preliminary-metric' : ''}`}
                              title={preliminarySummaryTitle(daySummary) || pendingSummaryTitle(daySummary.pending.pnl) || incompleteSummaryTitle(daySummary.evidenceGapCount)}
                            >
                              {formatSummaryPercent(daySummary.roi, daySummary)}
                            </td>
                          </tr>
                        </tbody>
                      );
                    })}
                  </table>
                </div>
              ) : <div className="pm-performance-state">{emptyMessage}</div>}
            </>
          )}
        </>
      )}
    </div>
  );
}
