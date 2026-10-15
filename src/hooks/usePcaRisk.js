import { useCallback, useEffect, useRef, useState } from 'react';
import { pcaRiskService } from '../services/api/pcaRiskService';

export const DEFAULT_PCA_CONFIG = Object.freeze({ window: 126, warnThreshold: 0.35, highThreshold: 0.5 });
const forbidden = value => value && ['mock', 'isMock', 'seed', 'seeded', 'isSeed', 'synthetic', 'inferred', 'stale', 'cacheOnly', 'offline', 'disconnected'].some(key => value[key] === true);

// A saved, dated model is historical evidence. It never becomes a live quote or
// a current account valuation just because the user opens or refreshes the view.
export function validPcaSnapshot(envelope, account, window) {
  const snapshot = envelope?.snapshot;
  if (!snapshot || forbidden(envelope) || forbidden(snapshot) || forbidden(snapshot.model)
    || snapshot.accountId !== account || !snapshot.id || !/^\d{4}-\d{2}-\d{2}$/.test(snapshot.sessionDate || '')
    || !Array.isArray(snapshot.model?.components) || !Array.isArray(snapshot.model?.holdings)
    || forbidden(snapshot.provenance) || snapshot.model.components.some(forbidden) || snapshot.model.holdings.some(forbidden)
    || (snapshot.config?.window != null && Number(snapshot.config.window) !== Number(window))) return null;
  return snapshot;
}

export default function usePcaRisk(account, active = true) {
  const [window, setWindow] = useState(126);
  const [config, setConfig] = useState(DEFAULT_PCA_CONFIG);
  const [configAccount, setConfigAccount] = useState(null);
  const [snapshotId, setSnapshotId] = useState(null);
  const [history, setHistory] = useState([]);
  const [state, setState] = useState({ account: null, window: 126, envelope: null, loading: false, refreshing: false, error: null });
  const scope = `${account || ''}:${window}:${snapshotId || 'latest'}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const attemptsRef = useRef(new Set());
  const requestRef = useRef(0);

  useEffect(() => { setSnapshotId(null); setHistory([]); }, [account, window]);

  useEffect(() => {
    if (!account || !active) return undefined;
    let cancelled = false;
    const controller = new AbortController();
    pcaRiskService.getConfig({ account, signal: controller.signal }).then(response => {
      if (cancelled) return;
      const next = { ...DEFAULT_PCA_CONFIG, ...(response?.config || {}) };
      setConfig(next);
      setWindow(next.window);
      setConfigAccount(account);
    }).catch(() => {
      if (!cancelled) { setConfig(DEFAULT_PCA_CONFIG); setWindow(DEFAULT_PCA_CONFIG.window); setConfigAccount(account); }
    });
    return () => { cancelled = true; controller.abort(); };
  }, [account, active]);

  const accept = useCallback((response, requestScope) => {
    if (scopeRef.current !== requestScope) return;
    const snapshot = validPcaSnapshot(response, account, window);
    setState({
      account, window,
      envelope: { ...response, snapshot },
      loading: false, refreshing: response?.pending === true,
      error: response?.snapshot && !snapshot ? 'Snapshot verification unavailable.'
        : response?.latestAttempt?.status === 'failed' ? snapshot ? 'Refresh unavailable. The dated snapshot is unchanged.' : 'A verified post-close snapshot could not be built.' : null,
    });
  }, [account, window]);

  const refresh = useCallback(async () => {
    if (!account) return null;
    const requestScope = `${account || ''}:${window}:latest`;
    setSnapshotId(null);
    setState(previous => ({ ...previous, account, window, refreshing: true, error: null }));
    try {
      const response = await pcaRiskService.refresh({ account, window });
      accept(response, requestScope);
      return response;
    } catch (error) {
      const message = error?.response?.data?.code === 'post_close_required'
        ? 'Build after 17:30 New York on a trading day. Saved snapshots remain available.'
        : 'Refresh unavailable. Any displayed snapshot retains its original date.';
      if (scopeRef.current === requestScope) setState(previous => ({ ...previous, refreshing: false, error: message }));
      return null;
    }
  }, [account, window, accept]);

  useEffect(() => {
    if (!account || !active || configAccount !== account) return undefined;
    let cancelled = false;
    const controller = new AbortController();
    const request = ++requestRef.current;
    setState({ account, window, envelope: null, loading: true, refreshing: false, error: null });
    pcaRiskService.getSnapshot({ account, window, id: snapshotId, signal: controller.signal }).then(response => {
      if (cancelled || request !== requestRef.current) return;
      accept(response, scope);
      if (!snapshotId && !response?.snapshot && !response?.latestAttempt && !response?.pending && !attemptsRef.current.has(scope)) {
        attemptsRef.current.add(scope);
        void refresh();
      }
    }).catch(() => {
      if (!cancelled && request === requestRef.current) setState({ account, window, envelope: null, loading: false, refreshing: false, error: 'PCA snapshot unavailable.' });
    });
    return () => { cancelled = true; controller.abort(); };
  }, [account, active, configAccount, window, scope, snapshotId, accept, refresh]);

  const storedId = state.envelope?.snapshot?.id;
  useEffect(() => {
    if (!account || !active || configAccount !== account) return undefined;
    const controller = new AbortController();
    let cancelled = false;
    pcaRiskService.getHistory({ account, window, signal: controller.signal }).then(response => {
      if (!cancelled) {
        const next = Array.isArray(response?.snapshots) ? response.snapshots : [];
        setHistory(previous => previous.length === next.length && previous.every((row, index) => row.id === next[index].id) ? previous : next);
      }
    }).catch(() => { if (!cancelled) setHistory([]); });
    return () => { cancelled = true; controller.abort(); };
  }, [account, active, window, configAccount, storedId]);

  useEffect(() => {
    if (!active || !account || !state.refreshing || state.account !== account || state.window !== window) return undefined;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const response = await pcaRiskService.getSnapshot({ account, window, id: snapshotId });
        if (!cancelled) accept(response, scope);
      } catch {
        if (!cancelled) setState(previous => ({ ...previous, refreshing: false, error: 'Snapshot refresh unavailable. Try again.' }));
      }
    }, 2000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [active, account, window, state, scope, snapshotId, accept]);

  const saveConfig = useCallback(async changes => {
    const response = await pcaRiskService.saveConfig({ account, ...changes });
    if (!scopeRef.current.startsWith(`${account}:`)) return;
    const next = { ...config, ...changes, ...(response?.config || {}) };
    setConfig(next);
    setWindow(next.window);
    return next;
  }, [account, config]);
  const scopedState = state.account === account && state.window === window ? state : { envelope: null, loading: Boolean(account), refreshing: false, error: null };
  return { ...scopedState, snapshot: scopedState.envelope?.snapshot || null, config, window, setWindow, history, snapshotId, setSnapshotId, refresh, saveConfig };
}
