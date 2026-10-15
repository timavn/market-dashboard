import { useEffect, useState } from 'react';
import { MarketDataService } from '../services/api/marketDataService';
import { normalizeResearchDate } from '../utils/researchDateFormat';

const isVerifiedHoldingsOverlap = (value) => {
  if (
    value?.available !== true
    || value?.status !== 'available'
    || value?.fromCache !== false
    || !Number.isFinite(Number(value?.weightedOverlapPct))
    || !Number.isFinite(Number(value?.sharedHoldings))
    || !normalizeResearchDate(value?.asOf)
    || !Array.isArray(value?.sources)
    || value.sources.length < 2
  ) {
    return false;
  }
  const asOfTimestamp = Date.parse(`${normalizeResearchDate(value.asOf)}T12:00:00Z`);
  const age = Date.now() - asOfTimestamp;
  return age >= -(24 * 60 * 60 * 1000) && age <= (7 * 24 * 60 * 60 * 1000);
};

// Keep request identity scoped to holdings, not the selected leveraged ticker.
// Products sharing a reference reuse the request; hiding or closing aborts it.
export default function useLeveragedProductOverlap({ active, baseSymbol, referenceSymbol }) {
  const [leveragedOverlapState, setLeveragedOverlapState] = useState({
    status: 'idle',
    data: null,
  });

  useEffect(() => {
    if (!active || !baseSymbol || !referenceSymbol) {
      setLeveragedOverlapState({ status: 'idle', data: null });
      return undefined;
    }

    const controller = new AbortController();
    setLeveragedOverlapState({ status: 'loading', data: null });
    MarketDataService.getLeveragedProductOverlap({
      baseSymbol,
      referenceSymbol,
      signal: controller.signal,
    }).then((data) => {
      if (controller.signal.aborted) return;
      setLeveragedOverlapState(isVerifiedHoldingsOverlap(data)
        ? { status: 'available', data }
        : { status: 'unavailable', data: null });
    }).catch((error) => {
      if (controller.signal.aborted || error?.name === 'CanceledError' || error?.code === 'ERR_CANCELED') return;
      setLeveragedOverlapState({ status: 'unavailable', data: null });
    });
    return () => controller.abort();
  }, [
    active,
    baseSymbol,
    referenceSymbol,
  ]);

  return leveragedOverlapState;
}
