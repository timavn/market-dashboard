import { useEffect, useState } from 'react';
import { MarketDataService } from '../services/api/marketDataService';
import { todayInNewYork } from '../utils/morningTldr';
import { normalizeDashboardTickResearch } from '../utils/dashboardResearch';
import { startVisibilityAwarePolling } from '../utils/visibilityAwarePolling';

export const HEDGAI_TICK_REFRESH_MS = 5 * 60 * 1000;
const emptyState = { readings: {}, status: 'unavailable', loading: false, error: null };

/** Quote-independent research for any source-listed security and the explicitly
 * mapped overview references. A failed current-book check withdraws Tick. */
export default function useHedgaiTickResearch({ active = true } = {}) {
  const [state, setState] = useState(active
    ? { ...emptyState, status: 'loading', loading: true } : emptyState);

  useEffect(() => {
    let disposed = false;
    let sequence = 0;
    let checked = null;
    if (!active) {
      setState(emptyState);
      return () => { disposed = true; };
    }
    const poll = async () => {
      const request = ++sequence;
      const date = todayInNewYork();
      const asOf = new Date().toISOString();
      const readings = normalizeDashboardTickResearch(checked, { date, asOf });
      setState({ readings, status: Object.keys(readings).length ? 'available' : 'loading', loading: true, error: null });
      try {
        const payload = await MarketDataService.getHedgaiResearch({ asOf });
        if (disposed || request !== sequence) return;
        checked = date === todayInNewYork() ? payload : null;
        const next = normalizeDashboardTickResearch(checked, { date: todayInNewYork(), asOf });
        setState({ readings: next, status: Object.keys(next).length ? 'available' : 'unavailable', loading: false, error: null });
      } catch (error) {
        if (disposed || request !== sequence) return;
        checked = null;
        setState({ ...emptyState, error });
      }
    };
    const stop = startVisibilityAwarePolling({ poll, intervalMs: HEDGAI_TICK_REFRESH_MS, pollOnStart: true });
    return () => { disposed = true; stop(); };
  }, [active]);

  return active ? state : emptyState;
}
