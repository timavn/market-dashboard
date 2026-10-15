import { useEffect, useState } from 'react';
import {
  validateMarketRotationQuote, validateMarketRotationPair, validateMarketRotationSnapshot,
  mergeMarketRotationSnapshots, retainMarketRotationSnapshot, restoreMarketRotationSnapshot,
  ageMarketRotationSnapshot, nextMarketRotationExpiry,
} from '../utils/marketRotationReference.cjs';

export { validateMarketRotationQuote, validateMarketRotationPair, validateMarketRotationSnapshot };
export const MARKET_ROTATION_POLL_INTERVAL_MS = 60_000;
export const MARKET_ROTATION_REQUEST_TIMEOUT_MS = 35_000;
export const MARKET_ROTATION_MAX_PAIR_SKEW_MS = 5 * 60_000;
export const MARKET_ROTATION_STORAGE_KEY = 'market-dashboard:market-rotation-reference:v1';

function readSnapshot() {
  try {
    const stored = JSON.parse(window.localStorage.getItem(MARKET_ROTATION_STORAGE_KEY));
    return stored?.schemaVersion === 1 ? restoreMarketRotationSnapshot(stored.snapshot) : null;
  } catch { return null; }
}

function saveSnapshot(snapshot) {
  if (!snapshot) return;
  try {
    window.localStorage.setItem(MARKET_ROTATION_STORAGE_KEY, JSON.stringify({ schemaVersion: 1, snapshot }));
  } catch { /* Keep the verified in-memory readings when storage is unavailable. */ }
}

export default function useMarketRotationSnapshot({ enabled = true } = {}) {
  const [snapshot, setSnapshot] = useState(() => enabled ? readSnapshot() : null);
  const [loading, setLoading] = useState(enabled);

  useEffect(() => {
    if (!enabled) {
      setSnapshot(null);
      setLoading(false);
      return undefined;
    }
    let disposed = false;
    let timer;
    let controller;
    let timeout;
    let running = false;
    setSnapshot((current) => current || readSnapshot());
    setLoading(true);

    const refresh = async () => {
      if (disposed || running) return;
      clearTimeout(timer);
      if (document.visibilityState === 'hidden') {
        timer = setTimeout(refresh, MARKET_ROTATION_POLL_INTERVAL_MS);
        return;
      }
      running = true;
      controller = new AbortController();
      const requestController = controller;
      try {
        const payload = await Promise.race([
          (async () => {
            const response = await fetch('/api/market/rotation-snapshot', {
              cache: 'no-store', signal: requestController.signal,
            });
            if (!response.ok) throw new Error('Market rotation unavailable');
            return response.json();
          })(),
          new Promise((resolve, reject) => {
            timeout = setTimeout(() => {
              requestController.abort();
              reject(new Error('Market rotation timed out'));
            }, MARKET_ROTATION_REQUEST_TIMEOUT_MS);
          }),
        ]);
        if (!disposed) {
          setSnapshot((current) => mergeMarketRotationSnapshots(current, payload));
          setLoading(payload?.loading === true);
        }
      } catch {
        if (!disposed) {
          setSnapshot((current) => retainMarketRotationSnapshot(current));
          setLoading(false);
        }
      } finally {
        clearTimeout(timeout);
        running = false;
        if (!disposed) timer = setTimeout(refresh, MARKET_ROTATION_POLL_INTERVAL_MS);
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
    saveSnapshot(snapshot);
    const remaining = nextMarketRotationExpiry(snapshot) - Date.now();
    if (!Number.isFinite(remaining)) return undefined;
    const timer = setTimeout(() => {
      setSnapshot((current) => ageMarketRotationSnapshot(current));
    }, Math.max(0, Math.min(remaining, 2_147_483_647)));
    return () => clearTimeout(timer);
  }, [snapshot]);

  return { snapshot: enabled ? snapshot : null, loading: enabled && loading };
}
