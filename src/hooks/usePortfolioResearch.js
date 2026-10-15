import { useCallback, useEffect, useRef, useState } from 'react';
import { MarketDataService } from '../services/api/marketDataService';
import { SECURITY_INTELLIGENCE_V2_ENABLED } from './useSecurityIntelligence';
import {
  RESEARCH_CURRENT_HISTORY_DAYS,
  RESEARCH_HISTORY_DAYS,
  RESEARCH_REFRESH_INTERVAL_MS,
} from '../constants/portfolioResearch';
import { normalizeResearchDate } from '../utils/researchDateFormat';
import {
  mergeSecurityIntelligenceHistory,
  replaceSecurityIntelligenceCurrent,
  securityIntelligencePayload,
  securityIntelligenceScope,
} from '../utils/securityIntelligenceResponses';
import { startVisibilityAwarePolling } from '../utils/visibilityAwarePolling';

// Own current and lazy-history requests together: history may only enrich the
// accepted current scope, never replace its decisions or observation date.
export function usePortfolioResearch({ active, symbolsKey, expandedRowCount, refreshKey }) {
  const hasExpandedRows = expandedRowCount > 0;
  const [researchMarketDate, setResearchMarketDate] = useState(null);
  const [researchState, setResearchState] = useState({
    status: 'idle',
    data: null,
    error: null,
    symbolsKey: null,
    historyStatus: 'idle',
    historyError: null,
  });

  const researchRequestSequence = useRef(0);
  const researchHistoryRequestSequence = useRef(0);
  const researchHistoryStartedKeyRef = useRef(null);
  const researchHistoryLoadedKeyRef = useRef(null);
  const researchHistoryLoadedScopeRef = useRef(null);
  const researchCurrentScopeRef = useRef(null);
  const researchLoadedKeyRef = useRef(null);
  const researchRefreshCompletedAtRef = useRef(0);
  const researchManualRefreshKeyRef = useRef(refreshKey);

  const loadSecurityIntelligence = useCallback(async (signal) => {
    const symbols = symbolsKey ? symbolsKey.split(',') : [];
    const requestSequence = researchRequestSequence.current + 1;
    researchRequestSequence.current = requestSequence;
    // Effects in this render still see the previous ready state. Do not start
    // history for it while a replacement current request is already in flight.
    researchCurrentScopeRef.current = null;
    const historyLoadedForSameKey = researchHistoryLoadedKeyRef.current === symbolsKey;
    if (!historyLoadedForSameKey) {
      researchHistoryStartedKeyRef.current = null;
      researchHistoryRequestSequence.current += 1;
    }

    if (symbols.length === 0) {
      researchHistoryLoadedKeyRef.current = null;
      researchHistoryLoadedScopeRef.current = null;
      researchCurrentScopeRef.current = null;
      researchLoadedKeyRef.current = symbolsKey;
      researchRefreshCompletedAtRef.current = Date.now();
      setResearchState({
        status: 'empty',
        data: null,
        error: null,
        symbolsKey: symbolsKey,
        historyStatus: 'empty',
        historyError: null,
      });
      return;
    }

    // Preserve only the last successfully verified response for the exact
    // same symbol set while refreshing. It remains dated research context,
    // never an executable quote or a substitute for current holdings.
    setResearchState((current) => ({
      status: 'loading',
      data: current.symbolsKey === symbolsKey ? current.data : null,
      error: null,
      symbolsKey: symbolsKey,
      historyStatus: historyLoadedForSameKey ? 'ready' : 'idle',
      historyError: null,
    }));
    try {
      const data = await (SECURITY_INTELLIGENCE_V2_ENABLED
        ? MarketDataService.getSecurityIntelligenceV2
        : MarketDataService.getSecurityIntelligence)({
        symbols,
        historyDays: RESEARCH_CURRENT_HISTORY_DAYS,
        signal,
      });
      if (signal?.aborted || researchRequestSequence.current !== requestSequence) return;
      const responseMarketDate = normalizeResearchDate(securityIntelligencePayload(data)?.marketDate);
      const responseScope = securityIntelligenceScope(data);
      const historyStillLoaded = Boolean(historyLoadedForSameKey && responseScope
        && researchHistoryLoadedScopeRef.current === responseScope);
      researchCurrentScopeRef.current = responseScope;
      // A new market day/schema needs a new five-day history window even when
      // the requested symbols have not changed. Never relabel old history.
      if (!historyStillLoaded) {
        researchHistoryLoadedKeyRef.current = null;
        researchHistoryLoadedScopeRef.current = null;
        researchHistoryStartedKeyRef.current = null;
        researchHistoryRequestSequence.current += 1;
      }
      researchLoadedKeyRef.current = symbolsKey;
      researchRefreshCompletedAtRef.current = Date.now();
      setResearchMarketDate(responseMarketDate);
      setResearchState((current) => ({
        ...current,
        status: 'ready',
        data: replaceSecurityIntelligenceCurrent(current.data, data),
        error: null,
        symbolsKey: symbolsKey,
        historyStatus: historyStillLoaded ? 'ready' : 'idle',
        historyError: null,
      }));
    } catch (error) {
      if (signal?.aborted || researchRequestSequence.current !== requestSequence) return;
      setResearchState((current) => ({
        ...current,
        status: 'error',
        data: current.symbolsKey === symbolsKey ? current.data : null,
        error: error?.message || 'Verified research is unavailable.',
        symbolsKey: symbolsKey,
      }));
    }
  }, [symbolsKey]);

  const loadSecurityIntelligenceHistory = useCallback(async (signal) => {
    const symbols = symbolsKey ? symbolsKey.split(',') : [];
    if (symbols.length === 0) return;

    const currentSequence = researchRequestSequence.current;
    const requestSequence = researchHistoryRequestSequence.current + 1;
    researchHistoryRequestSequence.current = requestSequence;
    setResearchState((current) => ({
      ...current,
      historyStatus: 'loading',
      historyError: null,
    }));

    try {
      const data = await (SECURITY_INTELLIGENCE_V2_ENABLED
        ? MarketDataService.getSecurityIntelligenceV2
        : MarketDataService.getSecurityIntelligence)({
        symbols,
        historyDays: RESEARCH_HISTORY_DAYS,
        signal,
      });
      if (
        signal?.aborted
        || researchRequestSequence.current !== currentSequence
        || researchHistoryRequestSequence.current !== requestSequence
      ) return;
      const responseScope = securityIntelligenceScope(data);
      if (!responseScope || responseScope !== researchCurrentScopeRef.current) {
        setResearchState((current) => ({
          ...current,
          historyStatus: 'error',
          historyError: 'Historical research is unavailable for the current market date.',
        }));
        return;
      }
      researchHistoryLoadedKeyRef.current = symbolsKey;
      researchHistoryLoadedScopeRef.current = responseScope;
      setResearchState((current) => (
        current.symbolsKey === symbolsKey
          ? {
            ...current,
            data: mergeSecurityIntelligenceHistory(current.data, data),
            historyStatus: 'ready',
            historyError: null,
          }
          : current
      ));
    } catch (error) {
      if (
        signal?.aborted
        || researchRequestSequence.current !== currentSequence
        || researchHistoryRequestSequence.current !== requestSequence
      ) return;
      researchHistoryLoadedKeyRef.current = null;
      researchHistoryLoadedScopeRef.current = null;
      researchHistoryStartedKeyRef.current = null;
      setResearchState((current) => ({
        ...current,
        historyStatus: 'error',
        historyError: error?.message || 'Historical research is unavailable.',
      }));
    }
  }, [symbolsKey]);

  useEffect(() => {
    if (!active) return undefined;
    const controller = new AbortController();
    const manualRefreshRequested = researchManualRefreshKeyRef.current !== refreshKey;
    researchManualRefreshKeyRef.current = refreshKey;
    const retainedForScope = researchLoadedKeyRef.current === symbolsKey;
    const elapsedMs = Date.now() - researchRefreshCompletedAtRef.current;
    const initialDelayMs = manualRefreshRequested || !retainedForScope
      ? 0
      : Math.max(0, RESEARCH_REFRESH_INTERVAL_MS - elapsedMs);
    if (initialDelayMs <= 0) loadSecurityIntelligence(controller.signal);
    const stopPolling = startVisibilityAwarePolling({
      poll: () => loadSecurityIntelligence(controller.signal),
      intervalMs: RESEARCH_REFRESH_INTERVAL_MS,
      initialDelayMs: initialDelayMs <= 0 ? RESEARCH_REFRESH_INTERVAL_MS : initialDelayMs,
    });

    return () => {
      controller.abort();
      stopPolling();
    };
  }, [active, loadSecurityIntelligence, refreshKey, symbolsKey]);

  // Historical product references are useful once a card is open, but they
  // are not needed to paint the first expanded frame. Fetch them lazily after
  // the current-day envelope is verified so an empty/slow history response
  // cannot make the card look broken.
  useEffect(() => {
    if (
      !active
      || !hasExpandedRows
      || !symbolsKey
      || researchState.status !== 'ready'
      || !researchCurrentScopeRef.current
      || researchHistoryStartedKeyRef.current === symbolsKey
    ) return undefined;

    researchHistoryStartedKeyRef.current = symbolsKey;
    const controller = new AbortController();
    const scope = researchCurrentScopeRef.current;
    let settled = false;
    const markSettled = () => { settled = true; };
    const request = loadSecurityIntelligenceHistory(controller.signal);
    // The loader claims its generation synchronously, before its first await.
    const generation = researchHistoryRequestSequence.current;
    request.then(markSettled, markSettled);
    return () => {
      controller.abort();
      if (researchHistoryRequestSequence.current !== generation) return;
      const acceptedForScope = researchHistoryLoadedKeyRef.current === symbolsKey
        && researchHistoryLoadedScopeRef.current === scope;
      // Only an unfinished attempt releases its start marker. Accepted empty
      // history is complete too; stale cleanup cannot invalidate a newer request.
      if (!settled && !acceptedForScope && researchHistoryStartedKeyRef.current === symbolsKey) {
        researchHistoryStartedKeyRef.current = null;
      }
      researchHistoryRequestSequence.current += 1;
    };
  }, [
    active,
    hasExpandedRows,
    loadSecurityIntelligenceHistory,
    refreshKey,
    // Fast current refreshes can batch loading -> ready without a status
    // change. Recheck the history scope when the accepted snapshot changes.
    researchState.data,
    researchState.status,
    symbolsKey,
  ]);

  const invalidateHistory = useCallback(() => {
    researchHistoryStartedKeyRef.current = null;
    researchHistoryLoadedKeyRef.current = null;
    researchHistoryLoadedScopeRef.current = null;
    researchHistoryRequestSequence.current += 1;
  }, []);

  return { researchState, researchMarketDate, invalidateHistory };
}

export default usePortfolioResearch;
