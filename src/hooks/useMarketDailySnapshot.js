import { useEffect, useState } from 'react';

import {
  validateMarketDailyReference, mergeMarketDailyReference, retainMarketDailyReference,
} from '../utils/marketDailyReference.cjs';

export const MARKET_DAILY_STORAGE_KEY = 'market-daily-verified-reference-v1';
export const validateMarketDailySnapshot = validateMarketDailyReference;

function readSnapshot() {
  try {
    return retainMarketDailyReference(JSON.parse(window.sessionStorage.getItem(MARKET_DAILY_STORAGE_KEY)));
  } catch {
    return null;
  }
}

// Persist only the merged, verified informational readings, with their original
// observations. Expiry changes their label; it never erases the reference.
export default function useMarketDailySnapshot({ enabled = true } = {}) {
  const [snapshot, setSnapshot] = useState(() => enabled ? readSnapshot() : null);
  const [loading, setLoading] = useState(enabled);

  useEffect(() => {
    if (!enabled) return undefined;
    let disposed = false;
    let timer;
    let controller;
    let running = false;
    let timeout;

    const refresh = async () => {
      if (disposed || running) return;
      clearTimeout(timer);
      if (document.visibilityState === 'hidden') {
        timer = setTimeout(refresh, 30_000);
        return;
      }
      running = true;
      controller = new AbortController();
      const requestController = controller;
      let nextPoll = 30_000;
      try {
        const payload = await Promise.race([
          (async () => {
            const response = await fetch('/api/market/daily-snapshot', {
              cache: 'no-store', signal: requestController.signal,
            });
            if (!response.ok) throw new Error('Daily snapshot unavailable');
            return response.json();
          })(),
          new Promise((resolve, reject) => {
            timeout = setTimeout(() => {
              requestController.abort();
              reject(new Error('Daily snapshot timed out'));
            }, 35_000);
          }),
        ]);
        if (disposed) return;
        setSnapshot(current => mergeMarketDailyReference(current, payload));
        setLoading(payload?.loading === true);
        if (payload?.loading === true) nextPoll = 10_000;
      } catch {
        if (!disposed) {
          setSnapshot(current => retainMarketDailyReference(current));
          setLoading(false);
        }
      } finally {
        clearTimeout(timeout);
        running = false;
        if (!disposed) timer = setTimeout(refresh, nextPoll);
      }
    };
    const resume = () => { if (document.visibilityState !== 'hidden') refresh(); };
    refresh();
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('online', resume);
    return () => {
      disposed = true;
      clearTimeout(timer);
      clearTimeout(timeout);
      controller?.abort();
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('online', resume);
    };
  }, [enabled]);

  useEffect(() => {
    if (!snapshot) return undefined;
    try {
      window.sessionStorage.setItem(MARKET_DAILY_STORAGE_KEY, JSON.stringify(snapshot));
    } catch {
      // The API persists the same verified reference if browser storage is blocked.
    }
    const observations = Object.values(snapshot.referenceObservations || {});
    const expiries = (observations.length ? observations.filter(value => !value.retained).map(value => value.expiresAt)
      : snapshot.retained ? [] : [snapshot.expiresAt])
      .map(Date.parse).filter(value => Number.isFinite(value) && value > Date.now());
    if (!expiries.length) return undefined;
    const timer = setTimeout(() => setSnapshot(current => validateMarketDailyReference(current)),
      Math.min(Math.max(0, Math.min(...expiries) - Date.now()), 2_147_483_647));
    return () => clearTimeout(timer);
  }, [snapshot]);

  return { snapshot: enabled ? snapshot : null, loading: enabled && loading };
}
