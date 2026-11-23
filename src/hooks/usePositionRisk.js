import { useEffect, useMemo, useState } from 'react';
import { MarketDataService } from '../services/api/marketDataService';

// Labels and risk numbers for the positions on screen. Weights are rounded to a
// tenth of a percent of NAV, so the read repeats when the book changes, not on
// every revaluation.
export default function usePositionRisk(positions, { enabled = true } = {}) {
  const signature = useMemo(() => JSON.stringify([...(positions || [])]
    .map(position => [position.symbol, Math.round(position.weightPct * 10) / 10])
    .filter(([, weightPct]) => weightPct !== 0)
    .sort(([left], [right]) => left.localeCompare(right))), [positions]);
  const [state, setState] = useState({ status: 'idle', signature: null, data: null });

  useEffect(() => {
    const book = JSON.parse(signature).map(([symbol, weightPct]) => ({ symbol, weightPct }));
    if (!enabled || book.length === 0) return undefined;
    const controller = new AbortController();
    setState(current => ({ ...current, status: 'loading' }));
    Promise.resolve().then(() => MarketDataService.getPortfolioRiskMatrix(book, { signal: controller.signal })).then(
      data => setState({ status: 'ready', signature, data }),
      () => { if (!controller.signal.aborted) setState(current => ({ ...current, status: 'error' })); },
    );
    return () => controller.abort();
  }, [enabled, signature]);

  return state;
}
