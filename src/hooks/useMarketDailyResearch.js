import { useEffect, useState } from 'react';
import { MarketDataService } from '../services/api/marketDataService';
import { marketResearchTickers, projectMarketDailyResearch, validMarketResearchDate } from '../utils/marketDailyResearch';

export default function useMarketDailyResearch({ enabled = true, marketDate, tickers = [] } = {}) {
  const symbolsKey = marketResearchTickers(tickers).sort().join(',');
  const active = Boolean(enabled && validMarketResearchDate(marketDate) && symbolsKey);
  const requestKey = active ? `${marketDate}:${symbolsKey}` : '';
  const [state, setState] = useState({ requestKey: '', items: [], loading: false });

  useEffect(() => {
    if (!active) {
      setState({ requestKey: '', items: [], loading: false });
      return undefined;
    }
    const controller = new AbortController();
    let disposed = false;
    setState({ requestKey, items: [], loading: true });
    const symbols = symbolsKey.split(',');
    MarketDataService.getSecurityIntelligenceV2({
      date: marketDate, symbols, historyDays: 0, signal: controller.signal,
    }).then((response) => {
      if (disposed) return;
      setState({
        requestKey,
        items: projectMarketDailyResearch(response, { marketDate, tickers: symbols }),
        loading: false,
      });
    }).catch(() => {
      if (!disposed) setState({ requestKey, items: [], loading: false });
    });
    return () => {
      disposed = true;
      controller.abort();
    };
  }, [active, marketDate, requestKey, symbolsKey]);

  // Scope the render, not only the effect: changing cards/dates cannot briefly
  // flash the preceding card's research before its effect cleanup runs.
  return active && state.requestKey === requestKey
    ? { items: state.items, loading: state.loading }
    : { items: [], loading: active };
}
