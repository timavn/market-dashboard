import { useCallback, useEffect, useState } from 'react';
import { MarketDataService } from '../services/api/marketDataService';

export const VIX_RISK_RANGE_POLL_INTERVAL_MS = 5 * 60 * 1000;

const finiteNumber = (value) => {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const unavailableReason = (payload) => {
  const status = String(payload?.status || 'unavailable').trim().toUpperCase();
  return status === 'CURRENT'
    ? 'The current VIX Risk Range is not listed in the verified publication.'
    : `The verified VIX Risk Range publication is ${status}.`;
};

/**
 * Accept only the server's manifest-verified current primary publication.
 * A stale, pending, partial, supplemental, or malformed row becomes no data.
 */
export function normalizeCurrentVixRiskRange(payload) {
  const manifest = payload?.manifest;
  const publicationDate = String(manifest?.publicationDate || '');
  const expectedDate = String(manifest?.expectedDate || '');
  if (
    Number(payload?.schemaVersion) !== 1
    || payload?.available !== true
    || String(payload?.status || '').toLowerCase() !== 'current'
    || manifest?.persistedManifestVerified !== true
    || !/^\d{4}-\d{2}-\d{2}$/.test(publicationDate)
    || publicationDate !== expectedDate
  ) return null;

  const row = payload?.ranges?.VIX;
  const lrr = finiteNumber(row?.lrr);
  const hrr = finiteNumber(row?.hrr);
  if (
    !row
    || lrr == null
    || hrr == null
    || lrr >= hrr
    || row?.decisionEligible === false
    || (row?.date && row.date !== publicationDate)
  ) return null;

  return {
    status: 'available',
    verified: true,
    source: 'risk_range_publication',
    lrr,
    hrr,
    date: publicationDate,
    asOf: row.timestamp || manifest.latestUpdatedAt || publicationDate,
  };
}

const initialState = (enabled) => ({
  status: enabled ? 'loading' : 'disabled',
  range: null,
  error: null,
});

export default function useVixRiskRange({
  enabled = true,
  pollIntervalMs = VIX_RISK_RANGE_POLL_INTERVAL_MS,
} = {}) {
  const [reloadKey, setReloadKey] = useState(0);
  const [state, setState] = useState(() => initialState(enabled));

  useEffect(() => {
    let cancelled = false;
    let requestId = 0;

    if (!enabled) {
      setState(initialState(false));
      return () => {
        cancelled = true;
      };
    }

    const load = async () => {
      const currentRequest = ++requestId;
      setState(initialState(true));
      try {
        const payload = await MarketDataService.getRiskRanges(['VIX'], { envelope: true });
        if (cancelled || currentRequest !== requestId) return;
        const range = normalizeCurrentVixRiskRange(payload);
        setState(range
          ? { status: 'available', range, error: null }
          : { status: 'unavailable', range: null, error: unavailableReason(payload) });
      } catch (error) {
        if (cancelled || currentRequest !== requestId) return;
        setState({
          status: 'unavailable',
          range: null,
          error: error?.message || 'The verified VIX Risk Range is unavailable.',
        });
      }
    };

    load();
    const interval = Number(pollIntervalMs) > 0
      ? setInterval(load, Number(pollIntervalMs))
      : null;

    return () => {
      cancelled = true;
      requestId += 1;
      if (interval) clearInterval(interval);
    };
  }, [enabled, pollIntervalMs, reloadKey]);

  const retry = useCallback(() => setReloadKey((value) => value + 1), []);
  return { ...state, retry };
}
