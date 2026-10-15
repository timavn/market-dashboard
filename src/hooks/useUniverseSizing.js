import { useEffect, useRef, useState } from 'react';
import { SECURITIES_LIST } from '../constants/securitiesList';
import { MarketDataService } from '../services/api/marketDataService';
import { securitySizingReference, sizingUniverse } from '../utils/securitySizingReference';

export default function useUniverseSizing(active, universe = null) {
  const [revision, setRevision] = useState(0);
  const histories = useRef(new Map());
  const lastRefresh = useRef(0);
  const [state, setState] = useState({ securities: SECURITIES_LIST, bySymbol: {}, loading: false, completed: 0, error: null });
  useEffect(() => {
    if (!active) return undefined;
    let stopped = false;
    const forceRefresh = revision !== lastRefresh.current;
    lastRefresh.current = revision;
    setState(old => ({ ...old, bySymbol: {}, loading: true, completed: 0, error: null }));
    async function load() {
      let securities = SECURITIES_LIST;
      let error = null;
      try {
        const catalogue = universe || await MarketDataService.getExposureLabUniverse();
        if (catalogue?.status !== 'available' || catalogue.historicalOnly !== true || catalogue.executable !== false) throw new Error('Universe unavailable');
        securities = sizingUniverse(catalogue.rows, SECURITIES_LIST);
      } catch {
        error = 'The full research universe is unavailable. Showing the configured securities.';
      }
      if (stopped) return;
      const knownSymbols = new Set(securities.map(row => row.ticker));
      for (const symbol of histories.current.keys()) if (!knownSymbols.has(symbol)) histories.current.delete(symbol);
      const verified = {};
      if (!forceRefresh) for (const row of securities) {
        const value = securitySizingReference(histories.current.get(row.ticker), row.ticker);
        if (value.available) verified[row.ticker] = value;
      }
      const pending = securities.filter(row => !verified[row.ticker]);
      setState({ securities, bySymbol: verified, loading: true, completed: Object.keys(verified).length, error });
      let next = 0;
      async function worker() {
        while (!stopped && next < pending.length) {
          const batch = pending.slice(next, next + 6);
          next += 6;
          let payload = null;
          try { payload = await MarketDataService.getSecurityRiskMetrics(batch.map(row => row.ticker), { forceRefresh, sizingOnly: true }); }
          catch { /* Every failed symbol remains an explicit gap. */ }
          if (stopped) return;
          for (const row of batch) {
            histories.current.delete(row.ticker);
            if (payload?.rows?.[row.ticker]) histories.current.set(row.ticker, payload);
          }
          const rows = Object.fromEntries(batch.map(row => [row.ticker, securitySizingReference(payload, row.ticker)]));
          setState(old => ({ ...old, bySymbol: { ...old.bySymbol, ...rows }, completed: old.completed + batch.length }));
        }
      }
      await Promise.all(Array.from({ length: 4 }, worker));
      if (!stopped) setState(old => ({ ...old, loading: false }));
    }
    void load();
    return () => { stopped = true; };
  }, [active, revision, universe]);
  return { ...state, refresh: () => setRevision(value => value + 1) };
}
