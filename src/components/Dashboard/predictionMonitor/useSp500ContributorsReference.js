import { useEffect, useState } from 'react';
import { MarketDataService } from '../../../services/api/marketDataService';
import { startVisibilityAwarePolling } from '../../../utils/visibilityAwarePolling';
import { currentSp500Contributors } from './sp500ContributorsContext';

// Index composition and fundamentals are dated references; live quotes retain
// their independent 15-second polling in useMomoTrackerReference.
const POLL_MS = 5 * 60_000;
const RETRY_MS = 15_000;
const LOADING_REFERENCE = Object.freeze({ status: 'loading', rows: Object.freeze([]) });

export default function useSp500ContributorsReference({ active, normalizedMarketId, chartRange }) {
  const [snapshot, setSnapshot] = useState(null);
  const [requestPending, setRequestPending] = useState(false);
  const applicable = normalizedMarketId === 'sp500' && chartRange === '1d';
  const enabled = active && applicable;
  useEffect(() => {
    if (!enabled) return undefined;
    let disposed = false;
    let pending = false;
    let retryTimer = null;
    const clearRetry = () => {
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
    };
    const load = async () => {
      if (disposed || pending || document.hidden) return;
      clearRetry();
      pending = true;
      setRequestPending(true);
      let accepted = null;
      try {
        const payload = await MarketDataService.getSp500Contributors();
        accepted = currentSp500Contributors(payload);
      } catch {
        // A failed refresh clears the reference and retries promptly while visible.
      } finally {
        pending = false;
      }
      if (disposed) return;
      setSnapshot(accepted);
      setRequestPending(false);
      if (!accepted && !document.hidden) {
        retryTimer = setTimeout(() => {
          retryTimer = null;
          void load();
        }, RETRY_MS);
      }
    };
    if (!document.hidden) void load();
    const stop = startVisibilityAwarePolling({ poll: load, intervalMs: POLL_MS });
    return () => { disposed = true; clearRetry(); stop(); setRequestPending(false); };
  }, [enabled]);
  // Inactivity pauses requests; only source validity determines whether the
  // already verified reference remains usable in a persistent workspace.
  if (!applicable) return null;
  return currentSp500Contributors(snapshot) || (enabled && requestPending ? LOADING_REFERENCE : null);
}
