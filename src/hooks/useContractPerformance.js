import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { MarketDataService } from '../services/api/marketDataService';
import { startVisibilityAwarePolling } from '../utils/visibilityAwarePolling';
import { createContractPerformanceHistoryStore } from '../utils/contractPerformanceHistoryStore';
import {
  CONTRACT_CURRENT_MAX_AGE_MS, currentContractPayloadAvailable, forbiddenContractPayload,
  finalContractRow, mergeContractPerformance,
} from '../utils/contractPerformancePresentation';

const historyStore = createContractPerformanceHistoryStore((options) => MarketDataService.getPredictionMarketPerformanceHistory(options));
export const preloadContractPerformanceHistory = (account) => historyStore.refresh(String(account || '').trim());
// Session teardown (also used by isolated resource tests); never browser persistence.
export const clearContractPerformanceHistory = () => historyStore.clear();

// Compatibility for existing consumers of the normalization boundary.
export function normalizeContractPerformance(payload) {
  if (forbiddenContractPayload(payload) || !Array.isArray(payload.rows)
    || payload.status === 'unavailable' || payload.tracker?.status === 'unavailable'
    || payload.availability?.history?.status === 'unavailable') return null;
  if (currentContractPayloadAvailable(payload)) return payload;
  const mask = (summary = {}) => ({ ...summary, openCount: null, awaitingCount: null,
    openPnl: null, awaitingPnl: null, pnl: null, roi: null, risked: null, currentValue: null, paid: null });
  const rows = payload.rows.filter(finalContractRow);
  return { ...payload, rows, activeRows: [], summary: { ...mask(payload.summary), count: rows.length },
    summaries: Object.fromEntries(Object.entries(payload.summaries || {}).map(([key, summary]) => [key, mask(summary)])),
    tracker: { ...payload.tracker, currentDataComplete: false },
    availability: { ...payload.availability, current: { status: 'unavailable', complete: false, observedAt: null } },
  };
}

export default function useContractPerformance({ account, venue = 'all', sort = 'status', direction = 'asc', search = '', active }) {
  const subscribe = useCallback((listener) => historyStore.subscribe(account, listener), [account]);
  const getSnapshot = useCallback(() => historyStore.getSnapshot(account), [account]);
  const history = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const [current, setCurrent] = useState({ account, data: null, status: 'idle' });
  const [clock, setClock] = useState(Date.now);
  const request = useRef(null);
  const generation = useRef(0);
  const lastCurrentSuccess = useRef(null);
  const revisionGeneration = useRef(0);

  useEffect(() => {
    generation.current += 1;
    request.current?.abort();
    request.current = null;
    lastCurrentSuccess.current = null;
    setCurrent({ account, data: null, status: 'idle' });
    return () => {
      generation.current += 1;
      request.current?.abort();
      request.current = null;
    };
  }, [account]);

  const refreshCurrent = useCallback(async (force = false) => {
    if (!account || !active || request.current) return;
    if (!force && lastCurrentSuccess.current != null && Date.now() - lastCurrentSuccess.current < 60_000) return;
    const controller = new AbortController();
    request.current = controller;
    const ownedGeneration = generation.current;
    const ownedRevisionGeneration = revisionGeneration.current;
    setCurrent((previous) => ({ account, data: previous.account === account ? previous.data : null, status: 'loading' }));
    try {
      const payload = await MarketDataService.getPredictionMarketPerformanceCurrent({ account, signal: controller.signal });
      if (controller.signal.aborted || ownedGeneration !== generation.current) return;
      const scoped = !forbiddenContractPayload(payload) && payload.selectedAccount === account && payload.scope === 'account'
        && Array.isArray(payload.rows) && payload.rows.every((row) => !row.accountId || row.accountId === account);
      const data = scoped && currentContractPayloadAvailable(payload)
        && payload.rows.every((row) => ['open', 'awaiting_resolution'].includes(row.status)) ? payload : null;
      lastCurrentSuccess.current = data ? Date.now() : null;
      setCurrent({ account, data, status: data ? 'ready' : 'unavailable' });
      setClock(Date.now());
      if (scoped && ownedRevisionGeneration === revisionGeneration.current) {
        historyStore.refresh(account, { revision: payload.historyRevision || null });
      }
    } catch (error) {
      if (!controller.signal.aborted && ownedGeneration === generation.current) {
        lastCurrentSuccess.current = null;
        if ([401, 403].includes(error?.response?.status)) historyStore.invalidate(account);
        setCurrent({ account, data: null, status: 'unavailable' });
      }
    } finally {
      if (request.current === controller) request.current = null;
    }
  }, [account, active]);

  useEffect(() => {
    if (!active || !account) return undefined;
    // Saved history and live marks never wait for each other.
    historyStore.refresh(account);
    const remaining = lastCurrentSuccess.current == null ? 0 : Math.max(0, 60_000 - (Date.now() - lastCurrentSuccess.current));
    return startVisibilityAwarePolling({ poll: refreshCurrent, intervalMs: 60_000, initialDelayMs: remaining });
    // Hidden retained panels stop new polling, but a pending same-account read may finish.
  }, [account, active, refreshCurrent]);

  useEffect(() => {
    const observed = Date.parse(current.data?.availability?.current?.observedAt || '');
    if (!Number.isFinite(observed)) return undefined;
    const delay = observed + CONTRACT_CURRENT_MAX_AGE_MS - Date.now() + 1;
    if (delay <= 0) { setClock(Date.now()); return undefined; }
    const timer = setTimeout(() => setClock(Date.now()), delay);
    return () => clearTimeout(timer);
  }, [current.data]);

  const refresh = useCallback(({ revision = null } = {}) => {
    if (!active || !account) return;
    if (revision) revisionGeneration.current += 1;
    historyStore.refresh(account, { force: true, revision });
    refreshCurrent(true);
  }, [account, active, refreshCurrent]);
  const data = useMemo(() => mergeContractPerformance({
    history: history.data, current: current.account === account ? current.data : null,
    now: Math.max(clock, Date.now()), venue, sort, direction, search,
  }), [account, clock, current, direction, history.data, search, sort, venue]);
  const currentStatus = current.account === account ? current.status : 'idle';
  const loading = ['idle', 'loading'].includes(history.status) || ['idle', 'loading'].includes(currentStatus);
  const status = !account ? 'unavailable' : data
    ? history.status === 'refreshing' ? 'refreshing'
      : data.consolidation.complete ? data.rows.length ? 'ready' : 'empty' : 'partial'
    : loading ? 'loading' : 'unavailable';
  return { status, data, refresh, error: !account ? 'The Individual IBKR account is unavailable.'
    : history.error || (!data ? 'Contract P&L could not be refreshed. Try again.' : null) };
}
