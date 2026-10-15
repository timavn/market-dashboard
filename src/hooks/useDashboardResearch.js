import { useEffect, useState } from 'react';
import { MarketDataService } from '../services/api/marketDataService';
import { todayInNewYork } from '../utils/morningTldr';
import { DASHBOARD_RESEARCH_SYMBOLS, dashboardResearchMarketDate, normalizeDashboardResearch } from '../utils/dashboardResearch';
import { startVisibilityAwarePolling } from '../utils/visibilityAwarePolling';

export const DASHBOARD_RESEARCH_REFRESH_MS = 5 * 60 * 1000;

/** Mounted once by the front dashboard and shared by all of its asset tables. */
export default function useDashboardResearch() {
  const [state, setState] = useState({ readings: {}, status: 'loading', loading: true, error: null });

  useEffect(() => {
    let disposed = false;
    let sequence = 0;
    let retainedMarketDate = null;
    let sources = { riskRanges: null, earlyLook: null, cryptoTracker: null, cryptoQuant: null, narrative: null, intelligence: null, hedgai: null };
    const poll = async () => {
      const request = ++sequence;
      const date = todayInNewYork();
      const asOf = new Date().toISOString();
      const marketDate = dashboardResearchMarketDate(date);
      if (retainedMarketDate !== marketDate) {
        sources = { ...sources, riskRanges: null, earlyLook: null };
        retainedMarketDate = marketDate;
      }
      setState(() => {
        const readings = normalizeDashboardResearch(sources, { date, asOf });
        return { readings, status: Object.keys(readings).length ? 'available' : 'loading', loading: true, error: null };
      });
      const sourceKeys = ['riskRanges', 'earlyLook', 'cryptoTracker', 'cryptoQuant', 'narrative', 'intelligence', 'hedgai'];
      const requests = [
        MarketDataService.getRiskRanges(null, { envelope: true }),
        MarketDataService.getHedgeyeSnapshot('early-look', marketDate, { throwOnError: true }),
        MarketDataService.getHedgeyeSnapshot('bitcoin-trend-tracker', null, { throwOnError: true }),
        MarketDataService.getHedgeyeSnapshot('crypto-quant', null, { throwOnError: true }),
        MarketDataService.getDashboardNarrativeResearch(),
        MarketDataService.getSecurityIntelligenceV2({ symbols: DASHBOARD_RESEARCH_SYMBOLS, date: marketDate, historyDays: 5 }),
        MarketDataService.getHedgaiResearch({ asOf }),
      ];
      const results = await Promise.allSettled(requests.map(async (pending, index) => {
        let value;
        try {
          value = await pending;
        } catch (error) {
          // Keep the checked Tick during a pending refresh, but withdraw its
          // active arrow as soon as publisher delivery can no longer be checked.
          if (sourceKeys[index] === 'hedgai' && !disposed && request === sequence) {
            sources.hedgai = null;
            const readings = normalizeDashboardResearch(sources, { date, asOf });
            setState({ readings, status: Object.keys(readings).length ? 'available' : 'loading', loading: true, error: null });
          }
          throw error;
        }
        if (!disposed && request === sequence && date === todayInNewYork()) {
          sources[sourceKeys[index]] = value;
          const readings = normalizeDashboardResearch(sources, { date, asOf });
          setState({ readings, status: Object.keys(readings).length ? 'available' : 'loading', loading: true, error: null });
        }
        return value;
      }));
      if (disposed || request !== sequence) return;
      // A transport error says nothing new about a previously verified
      // publication. Retain its original evidence for this publication date.
      // A returned missing/invalid/withdrawn source does revoke that source.
      // Tick is withdrawn on failure because its current status must be checked.
      if (date === todayInNewYork()) {
        sourceKeys.forEach((key, index) => {
          if (results[index].status === 'fulfilled') sources[key] = results[index].value;
        });
      }
      const readings = date === todayInNewYork() ? normalizeDashboardResearch(sources, { date, asOf }) : {};
      const error = results.find((result) => result.status === 'rejected')?.reason || null;
      setState({ readings, status: Object.keys(readings).length ? 'available' : 'unavailable', loading: false, error });
    };
    const stop = startVisibilityAwarePolling({ poll, intervalMs: DASHBOARD_RESEARCH_REFRESH_MS, pollOnStart: true });
    return () => { disposed = true; stop(); };
  }, []);

  return state;
}
