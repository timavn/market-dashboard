import { useEffect, useMemo, useState } from 'react';
import { MarketDataService } from '../services/api/marketDataService';

export const SECURITY_INTELLIGENCE_V2_ENABLED = (
  process.env.REACT_APP_SECURITY_INTELLIGENCE_V2_ENABLED === 'true'
);

function normalizeSymbols(symbols) {
  return [...new Set(
    (Array.isArray(symbols) ? symbols : [])
      .map((symbol) => String(symbol || '').trim().toUpperCase())
      .filter(Boolean),
  )].sort();
}

function unavailableError(error) {
  return error instanceof Error ? error : new Error(String(error || 'Security intelligence is unavailable.'));
}

export function useSecurityIntelligence(
  symbols = [],
  {
    date = null,
    historyDays = 0,
    signal = undefined,
    enabled = true,
    reloadKey = '',
  } = {},
) {
  const normalizedSymbols = useMemo(() => normalizeSymbols(symbols), [symbols]);
  const symbolKey = normalizedSymbols.join(',');
  const [state, setState] = useState({
    status: enabled ? 'loading' : 'disabled',
    data: null,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    if (!enabled) {
      setState({ status: 'disabled', data: null, error: null });
      return () => {
        cancelled = true;
      };
    }
    if (!normalizedSymbols.length) {
      setState({ status: 'ready', data: null, error: null });
      return () => {
        cancelled = true;
      };
    }

    setState({ status: 'loading', data: null, error: null });
    MarketDataService.getCanonicalSecurityIntelligence({
      symbols: normalizedSymbols,
      date,
      historyDays,
      signal,
    }).then((data) => {
      if (cancelled) return;
      if (SECURITY_INTELLIGENCE_V2_ENABLED && data?.schemaVersion !== 2) {
        throw new Error('Canonical security intelligence returned an unsupported schema.');
      }
      setState({ status: 'ready', data, error: null });
    }).catch((error) => {
      if (cancelled) return;
      setState({ status: 'unavailable', data: null, error: unavailableError(error) });
    });

    return () => {
      cancelled = true;
    };
  }, [date, historyDays, normalizedSymbols, reloadKey, signal, symbolKey, enabled]);

  return {
    ...state,
    isLoading: state.status === 'loading',
    isUnavailable: state.status === 'unavailable',
    isVerified: state.status === 'ready' && Boolean(state.data),
    bySymbol: state.data?.bySymbol || {},
  };
}

export function useSecurityIntelligenceUniverse({
  date = null,
  enabled = true,
  reloadKey = '',
} = {}) {
  const [state, setState] = useState({
    status: enabled ? 'loading' : 'disabled',
    data: null,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    if (!enabled) {
      setState({ status: 'disabled', data: null, error: null });
      return () => {
        cancelled = true;
      };
    }

    setState({ status: 'loading', data: null, error: null });
    const load = async () => {
      const bySymbol = {};
      let cursor = null;
      let firstPage = null;
      do {
        const page = await MarketDataService.getSecurityIntelligenceUniverseV2({
          date,
          limit: 200,
          cursor,
        });
        if (page?.schemaVersion !== 2) {
          throw new Error('Canonical security universe returned an unsupported schema.');
        }
        firstPage = firstPage || page;
        Object.assign(bySymbol, page.bySymbol || {});
        cursor = page.page?.nextCursor || null;
      } while (cursor && !cancelled);

      if (cancelled) return;
      setState({
        status: 'ready',
        error: null,
        data: {
          ...(firstPage || { schemaVersion: 2, bySymbol: {} }),
          bySymbol,
          requestedSymbols: Object.keys(bySymbol).sort(),
          page: null,
        },
      });
    };

    load().catch((error) => {
      if (cancelled) return;
      setState({ status: 'unavailable', data: null, error: unavailableError(error) });
    });

    return () => {
      cancelled = true;
    };
  }, [date, reloadKey, enabled]);

  return {
    ...state,
    isLoading: state.status === 'loading',
    isUnavailable: state.status === 'unavailable',
    isVerified: state.status === 'ready' && Boolean(state.data),
    bySymbol: state.data?.bySymbol || {},
  };
}

export default useSecurityIntelligence;
