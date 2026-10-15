import { sortPerformanceRows } from './contractPerformanceSort.cjs';

const KNOWN_MARKETS = [
  ['wti', 'WTI'], ['gold', 'Gold'], ['sp500', 'SP500'], ['nasdaq100', 'NQ'],
  ['bitcoin', 'BTC'], ['ethereum', 'ETH'], ['cpi', 'CPI'],
];
const PRODUCT_MARKETS = {
  METLG: 'gold', METLS: 'silver', COMCO: 'wti', FES: 'sp500', FNQ: 'nasdaq100',
  CPIY: 'cpi', CFBTC: 'bitcoin', CFETH: 'ethereum', KXWTI: 'wti', KXINX: 'sp500',
  KXCPI: 'cpi', KXBTC: 'bitcoin', KXETH: 'ethereum',
};
const number = (value) => value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
export const CONTRACT_CURRENT_MAX_AGE_MS = 180_000;
export const finalContractRow = (row) => row?.status === 'verified'
  && ['CLOSED', 'SETTLED'].includes(String(row.displayState || (row.resolutionType === 'early_exit' ? 'CLOSED' : 'SETTLED')));
export const forbiddenContractPayload = (value) => !value || [
  'fromCache', 'cacheOnly', 'stale', 'isMock', 'isSeeded', 'mock', 'seeded', 'fallback',
].some((flag) => value[flag] === true);

export function contractPerformanceMarket(row = {}) {
  const market = String(row.market || '').trim().toLowerCase();
  if (market && market !== 'other') return market;
  const source = [row.contractLabel, row.contractKey, row.eventTicker, row.localSymbol].join(' ').toUpperCase();
  return Object.entries(PRODUCT_MARKETS).find(([prefix]) => source.includes(prefix))?.[1] || 'other';
}

export function contractPerformanceMarkets(rows = []) {
  const markets = new Map(KNOWN_MARKETS);
  rows.forEach((row) => {
    const key = contractPerformanceMarket(row);
    if (!markets.has(key)) markets.set(key, key === 'other' ? 'Other' : key === 'silver' ? 'Silver' : key === 'brent' ? 'Brent' : key.toUpperCase());
  });
  return [...markets].map(([key, label]) => ({ key, label }));
}

export function contractHistoryIncomplete(data) {
  return data?.availability?.history?.status !== 'ready'
    || data?.availability?.history?.complete !== true;
}

export function currentContractPayloadAvailable(payload, now = Date.now()) {
  const current = payload?.availability?.current;
  const observed = Date.parse(current?.observedAt || '');
  return !forbiddenContractPayload(payload) && Array.isArray(payload.rows)
    && payload.status !== 'unavailable' && payload.tracker?.status !== 'unavailable'
    && payload.rows.every((row) => !forbiddenContractPayload(row))
    && current?.status === 'ready' && current.complete === true
    && payload.tracker?.currentDataComplete !== false
    && Number.isFinite(observed) && observed <= now + 5_000 && now - observed <= CONTRACT_CURRENT_MAX_AGE_MS;
}

export function selectContractPerformanceRows(rows, { venue = 'all', sort = 'status', direction = 'asc', search = '' } = {}) {
  const terms = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const selected = rows.filter((row) => {
    const identity = [row.exchange, row.contractKey, row.eventTicker].join(' ').toUpperCase();
    const rowVenue = row.venue || (/FORECAST|(?:METLG|METLS|FES|FNQ|COMCO|CPIY|CFBTC|CFETH)[_-]/.test(identity) ? 'forecastex' : /KALSHI|KX[A-Z]/.test(identity) ? 'kalshi' : 'unknown');
    const text = [row.contractLabel, row.contractKey, row.eventTicker, row.localSymbol, row.market, row.strike, row.conId, row.openedAt, row.resolvedDate].join(' ').toLowerCase();
    return (venue === 'all' || rowVenue === venue) && terms.every((term) => text.includes(term));
  });
  return sortPerformanceRows(selected, sort, direction);
}

export function summarizeContractPerformance(rows, { historyComplete, currentComplete }) {
  const final = rows.filter(finalContractRow);
  const open = rows.filter((row) => row.status === 'open');
  const awaiting = rows.filter((row) => row.status === 'awaiting_resolution');
  const sum = (items, field, known) => {
    if (!items.length) return known ? 0 : null;
    const values = items.map((row) => number(row[field]));
    return values.some((value) => value == null) ? null : Number(values.reduce((total, value) => total + value, 0).toFixed(6));
  };
  const complete = historyComplete && currentComplete;
  const pnl = complete ? sum(rows, 'pnl', true) : null;
  const risked = complete ? sum(rows, 'risked', true) : null;
  return {
    count: rows.length, openCount: currentComplete ? open.length : null,
    awaitingCount: currentComplete ? awaiting.length : null, realizedCount: final.length,
    openPnl: currentComplete ? sum(open, 'pnl', true) : null,
    awaitingPnl: currentComplete ? sum(awaiting, 'pnl', true) : null,
    realizedPnl: sum(final, 'pnl', historyComplete),
    pnl, risked, currentValue: complete ? sum(rows, 'currentValue', true) : null,
    paid: complete ? sum(rows, 'currentValue', true) : null,
    roi: pnl != null && risked > 0 ? pnl / risked : null,
    complete: complete && pnl != null, realizedScope: historyComplete ? 'complete_history' : 'verified_records',
  };
}

export function mergeContractPerformance({ history, current, now = Date.now(), ...selection }) {
  const currentComplete = currentContractPayloadAvailable(current, now);
  if (!history && !currentComplete) return null;
  const historyComplete = !contractHistoryIncomplete(history);
  const finals = (history?.rows || []).filter((row) => finalContractRow(row) && !forbiddenContractPayload(row));
  const finalKeys = new Set(finals.map((row) => row.id || row.recordKey));
  const activeRows = currentComplete ? current.rows.filter((row) => ['open', 'awaiting_resolution'].includes(row.status)
    && !forbiddenContractPayload(row) && !finalKeys.has(row.id || row.recordKey)) : [];
  const allRows = [...finals, ...activeRows].map((row) => ({ ...row, market: contractPerformanceMarket(row) }));
  const rows = selectContractPerformanceRows(allRows, selection);
  const availability = {
    history: history?.availability?.history || { status: 'incomplete', complete: false, observedAt: null },
    current: currentComplete ? current.availability.current : { status: 'unavailable', complete: false, observedAt: null },
  };
  const context = { historyComplete, currentComplete };
  const markets = contractPerformanceMarkets(allRows);
  return {
    ...history, ...current, rows, activeRows: rows.filter((row) => !finalContractRow(row)), markets,
    projectionRevision: history?.projectionRevision || null,
    summary: summarizeContractPerformance(rows, context),
    summaries: Object.fromEntries(['all', ...markets.map((market) => market.key)].map((key) => [key,
      summarizeContractPerformance(key === 'all' ? rows : rows.filter((row) => row.market === key), context),
    ])),
    availability,
    tracker: { ...history?.tracker, ...current?.tracker, currentDataComplete: currentComplete },
    consolidation: { historyComplete, currentComplete, complete: historyComplete && currentComplete },
  };
}
