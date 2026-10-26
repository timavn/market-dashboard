import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MarketDataService } from '../services/api/marketDataService';
import { RESEARCH_REFRESH_INTERVAL_MS } from '../constants/portfolioResearch';
import { finiteOptionalNumber } from '../utils/portfolioNumbers';
import { holdingSizingReference } from '../utils/securitySizingReference';
import { isRefreshDelayedVolatilityRow } from '../utils/volatilitySnapshotRows';
import { startVisibilityAwarePolling } from '../utils/visibilityAwarePolling';

// Keep the first verified risk response small enough to paint quickly. The
// expanded card can request the remaining rows progressively without making
// the whole portfolio appear wedged behind one large request.
const RISK_METRICS_BATCH_SIZE = 8;

// Own historical risk, volatility and USD request lifecycles together without
// changing their distinct acceptance rules or call-time sizing validation.
export function usePortfolioMarketContext({ active, symbolsKey, holdings, refreshKey }) {
  const [sizingClock, setSizingClock] = useState(Date.now);
  useEffect(() => {
    if (!active) return undefined;
    setSizingClock(Date.now());
    const timer = setInterval(() => setSizingClock(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [active]);

  const [marketContextState, setMarketContextState] = useState({
    status: 'idle',
    riskMetrics: null,
    volatility: null,
    usdCorrelations: null,
    errors: {},
    sourceStatus: {
      riskMetrics: 'idle',
      volatility: 'idle',
      usdCorrelations: 'idle',
    },
  });

  const marketContextRequestSequence = useRef(0);
  const marketContextLoadedKeyRef = useRef(null);
  const marketContextRefreshCompletedAtRef = useRef(0);
  const marketContextManualRefreshKeyRef = useRef(refreshKey);
  const priorityRiskRequestsRef = useRef(new Map());
  const riskMetricsInFlightSymbolsRef = useRef(new Map());

  const lastVerifiedRiskMetricsRef = useRef(null);

  const researchSymbols = useMemo(
    () => symbolsKey ? symbolsKey.split(',') : [],
    [symbolsKey],
  );

  const researchAssetTypes = useMemo(() => {
    const map = {};
    holdings.forEach((holding) => {
      const symbol = String(holding?.symbol || '').trim().toUpperCase();
      if (!symbol) return;
      // Crypto ETFs still trade on exchange sessions. The underlying exposure
      // label must not annualize an ETF's own returns as a 365-day asset.
      const securityType = String(holding.securityType || holding.secType || '').toUpperCase();
      const nativeCrypto = securityType === 'CRYPTO'
        || (!['STK', 'ETF'].includes(securityType)
          && (['BTC', 'BITCOIN', 'ETH', 'ETHEREUM'].includes(symbol) || symbol.endsWith('-USD')));
      map[symbol] = nativeCrypto ? 'crypto' : 'equity';
    });
    return map;
  }, [holdings]);
  const researchAssetTypesKey = useMemo(
    () => researchSymbols
      .map((symbol) => `${symbol}:${researchAssetTypes[symbol] || 'equity'}`)
      .join(','),
    [researchSymbols, researchAssetTypes],
  );

  const loadMarketContext = useCallback(async () => {
    const symbols = symbolsKey ? symbolsKey.split(',') : [];
    const requestSequence = marketContextRequestSequence.current + 1;
    marketContextRequestSequence.current = requestSequence;

    if (symbols.length === 0) {
      marketContextLoadedKeyRef.current = symbolsKey;
      marketContextRefreshCompletedAtRef.current = Date.now();
      setMarketContextState({
        status: 'empty',
        riskMetrics: null,
        volatility: null,
        usdCorrelations: null,
        errors: {},
        sourceStatus: {
          riskMetrics: 'empty',
          volatility: 'empty',
          usdCorrelations: 'empty',
        },
      });
      return;
    }

    // Beta/ATR/Z-score are explicitly historical-only and non-executable.
    // Keep the last verified completed-session payload visible while a refresh
    // runs; live/delayed volatility and correlation payloads still clear.
    setMarketContextState((current) => ({
      status: 'loading',
      riskMetrics: current.riskMetrics || lastVerifiedRiskMetricsRef.current,
      volatility: current.volatility,
      usdCorrelations: current.usdCorrelations,
      errors: {},
      sourceStatus: {
        riskMetrics: 'loading',
        volatility: 'loading',
        usdCorrelations: 'loading',
      },
    }));

    const symbolBatches = [];
    for (let index = 0; index < symbols.length; index += RISK_METRICS_BATCH_SIZE) {
      symbolBatches.push(symbols.slice(index, index + RISK_METRICS_BATCH_SIZE));
    }

    const sourceStatuses = ['loading', 'partial', 'ready', 'error', 'empty'];
    const updateSource = (source, sourceStatus, patch = {}, sourceError = null) => {
      if (marketContextRequestSequence.current !== requestSequence) return;
      setMarketContextState((current) => {
        const nextSourceStatus = {
          ...(current.sourceStatus || {}),
          [source]: sourceStatus,
        };
        const nextErrors = { ...(current.errors || {}) };
        if (sourceError) nextErrors[source] = sourceError;
        else delete nextErrors[source];
        const statuses = Object.values(nextSourceStatus).filter((value) => sourceStatuses.includes(value));
        const hasLoading = statuses.some((value) => value === 'loading' || value === 'idle');
        const hasPartial = statuses.some((value) => value === 'partial');
        const hasError = statuses.some((value) => value === 'error') || Object.keys(nextErrors).length > 0;
        const allSettled = statuses.length === 3 && statuses.every((value) => (
          ['ready', 'error', 'empty'].includes(value)
        ));
        return {
          ...current,
          ...patch,
          sourceStatus: nextSourceStatus,
          errors: nextErrors,
          status: hasLoading
            ? (hasPartial || hasError ? 'partial' : 'loading')
            : allSettled && !hasError ? 'ready' : 'partial',
        };
      });
    };

    const loadVolatility = async () => {
      try {
        const value = await MarketDataService.getVolatilitySnapshot();
        if (marketContextRequestSequence.current !== requestSequence) return;
        const refreshDelayed = Object.values(value || {}).some((row) => (
          isRefreshDelayedVolatilityRow(row)
        ));
        updateSource('volatility', refreshDelayed ? 'partial' : 'ready', { volatility: value });
      } catch (error) {
        if (marketContextRequestSequence.current !== requestSequence) return;
        updateSource(
          'volatility',
          'error',
          { volatility: null },
          error?.message || 'Volatility indexes are unavailable.',
        );
      }
    };

    const loadUsdCorrelations = async () => {
      try {
        const value = await MarketDataService.getUsdCorrelations();
        if (marketContextRequestSequence.current !== requestSequence) return;
        updateSource('usdCorrelations', 'ready', { usdCorrelations: value });
      } catch (error) {
        if (marketContextRequestSequence.current !== requestSequence) return;
        updateSource(
          'usdCorrelations',
          'error',
          { usdCorrelations: null },
          error?.message || 'USD correlations are unavailable.',
        );
      }
    };

    // These sources are independent of the heavier per-symbol historical
    // metrics, so let each one paint as soon as it is verified.
    const volatilityPromise = loadVolatility();
    const usdCorrelationsPromise = loadUsdCorrelations();

    let mergedRiskRows = {
      ...(lastVerifiedRiskMetricsRef.current?.rows || {}),
    };
    let riskMetadata = lastVerifiedRiskMetricsRef.current || null;
    let successfulBatches = 0;
    let lastRiskError = null;
    const assetTypeBySymbol = Object.fromEntries(
      researchAssetTypesKey.split(',')
        .filter(Boolean)
        .map((pair) => {
          const separator = pair.indexOf(':');
          return separator > 0
            ? [pair.slice(0, separator), pair.slice(separator + 1) || 'equity']
            : [pair, 'equity'];
        }),
    );
    for (const batch of symbolBatches) {
      if (marketContextRequestSequence.current !== requestSequence) return;
      const batchAssetTypes = Object.fromEntries(
        batch.map((symbol) => [symbol, assetTypeBySymbol[symbol] || 'equity']),
      );
      batch.forEach((symbol) => riskMetricsInFlightSymbolsRef.current.set(symbol, requestSequence));
      const releaseBatch = () => {
        batch.forEach((symbol) => {
          // An obsolete response must not release a newer request's ownership.
          if (riskMetricsInFlightSymbolsRef.current.get(symbol) === requestSequence) {
            riskMetricsInFlightSymbolsRef.current.delete(symbol);
          }
        });
      };
      try {
        const payload = await MarketDataService.getSecurityRiskMetrics(batch, {
          assetTypes: batchAssetTypes,
        });
        releaseBatch();
        if (marketContextRequestSequence.current !== requestSequence) return;
        const contractVerified = payload?.historicalOnly === true
          && payload?.executable === false
          && payload?._cache?.stale !== true;
        if (!contractVerified) {
          throw new Error('Historical security metrics failed the non-executable source contract.');
        }
        mergedRiskRows = {
          ...mergedRiskRows,
          ...(payload?.rows || {}),
        };
        riskMetadata = {
          ...(riskMetadata || {}),
          ...payload,
          rows: mergedRiskRows,
          historicalOnly: true,
          executable: false,
        };
        successfulBatches += 1;
        lastVerifiedRiskMetricsRef.current = riskMetadata;
        updateSource(
          'riskMetrics',
          successfulBatches === symbolBatches.length ? 'ready' : 'partial',
          { riskMetrics: riskMetadata },
        );
      } catch (error) {
        releaseBatch();
        if (marketContextRequestSequence.current !== requestSequence) return;
        lastRiskError = error?.message || 'Historical security metrics are unavailable.';
        updateSource(
          'riskMetrics',
          successfulBatches > 0 ? 'partial' : 'error',
          { riskMetrics: riskMetadata || lastVerifiedRiskMetricsRef.current },
          lastRiskError,
        );
      }
    }

    if (marketContextRequestSequence.current !== requestSequence) return;
    if (successfulBatches === 0) {
      updateSource(
        'riskMetrics',
        'error',
        { riskMetrics: lastVerifiedRiskMetricsRef.current },
        lastRiskError || 'Historical security metrics are unavailable.',
      );
    } else if (successfulBatches < symbolBatches.length) {
      updateSource(
        'riskMetrics',
        'partial',
        { riskMetrics: riskMetadata },
        lastRiskError || 'Some historical security metrics are unavailable.',
      );
    }

    await Promise.allSettled([volatilityPromise, usdCorrelationsPromise]);
    if (marketContextRequestSequence.current !== requestSequence) return;
    marketContextLoadedKeyRef.current = symbolsKey;
    marketContextRefreshCompletedAtRef.current = Date.now();
  }, [researchAssetTypesKey, symbolsKey]);

  useEffect(() => {
    if (!active) return undefined;
    const manualRefreshRequested = marketContextManualRefreshKeyRef.current !== refreshKey;
    marketContextManualRefreshKeyRef.current = refreshKey;
    const retainedForScope = marketContextLoadedKeyRef.current === symbolsKey;
    const elapsedMs = Date.now() - marketContextRefreshCompletedAtRef.current;
    const initialDelayMs = manualRefreshRequested || !retainedForScope
      ? 0
      : Math.max(0, RESEARCH_REFRESH_INTERVAL_MS - elapsedMs);
    if (initialDelayMs <= 0) loadMarketContext();
    const stopPolling = startVisibilityAwarePolling({
      poll: loadMarketContext,
      intervalMs: RESEARCH_REFRESH_INTERVAL_MS,
      initialDelayMs: initialDelayMs <= 0 ? RESEARCH_REFRESH_INTERVAL_MS : initialDelayMs,
    });
    return () => {
      marketContextRequestSequence.current += 1;
      stopPolling();
    };
  }, [active, loadMarketContext, refreshKey, symbolsKey]);

  const getVerifiedRiskMetrics = (symbol) => {
    const payload = marketContextState.riskMetrics;
    const row = payload?.rows?.[String(symbol || '').trim().toUpperCase()];
    if (
      !payload
      || payload.historicalOnly !== true
      || payload.executable !== false
      || !row
      || row.historicalOnly !== true
      || row.executable !== false
    ) {
      return null;
    }
    return row;
  };

  const getPositionSizeReference = (symbol) => {
    const normalizedSymbol = String(symbol || '').trim().toUpperCase();
    const riskMetrics = getVerifiedRiskMetrics(normalizedSymbol);
    const beta = riskMetrics?.beta?.status === 'available'
      && finiteOptionalNumber(riskMetrics.beta.value) !== null ? riskMetrics.beta : null;
    const reference = holdingSizingReference({
      symbol: normalizedSymbol,
      payload: marketContextState.riskMetrics,
      sourceStatus: marketContextState.sourceStatus?.riskMetrics,
      sourceError: marketContextState.errors?.riskMetrics,
      instrumentTypes: holdings
        .filter(holding => String(holding.symbol || '').trim().toUpperCase() === normalizedSymbol)
        .map(holding => holding.securityType || holding.secType || holding.contract?.secType),
      now: Math.max(sizingClock, Date.now()),
    });
    return {
      ...reference,
      beta,
      riskMetrics,
      loading: marketContextState.sourceStatus?.riskMetrics === 'loading',
      // Store the selection, never the result: an open explanation revalidates
      // after a refresh, provider failure, or local freshness expiry.
      verification: { symbol: normalizedSymbol, metric: 'Position size' },
    };
  };

  const loadPriorityRiskMetrics = useCallback((symbol) => {
    const normalizedSymbol = String(symbol || '').trim().toUpperCase();
    if (!normalizedSymbol) return Promise.resolve(null);
    if (riskMetricsInFlightSymbolsRef.current.has(normalizedSymbol)) return Promise.resolve(null);
    const riskSourceStatus = marketContextState.sourceStatus?.riskMetrics;
    if (riskSourceStatus === 'loading') return Promise.resolve(null);
    const existingRow = marketContextState.riskMetrics?.rows?.[normalizedSymbol];
    if (
      existingRow?.historicalOnly === true
      && existingRow?.executable === false
    ) return Promise.resolve(existingRow);
    if (priorityRiskRequestsRef.current.has(normalizedSymbol)) {
      return priorityRiskRequestsRef.current.get(normalizedSymbol);
    }

    const requestSequence = marketContextRequestSequence.current;
    setMarketContextState((current) => {
      const nextErrors = { ...(current.errors || {}) };
      delete nextErrors.riskMetrics;
      return {
        ...current,
        sourceStatus: {
          ...(current.sourceStatus || {}),
          riskMetrics: 'partial',
        },
        errors: nextErrors,
        status: current.status === 'ready' ? 'partial' : current.status,
      };
    });
    const promise = MarketDataService.getSecurityRiskMetrics([normalizedSymbol], {
      assetTypes: {
        [normalizedSymbol]: researchAssetTypes[normalizedSymbol] || 'equity',
      },
    })
      .then((payload) => {
        if (marketContextRequestSequence.current !== requestSequence) return null;
        const contractVerified = payload?.historicalOnly === true
          && payload?.executable === false
          && payload?._cache?.stale !== true;
        const row = payload?.rows?.[normalizedSymbol];
        if (!contractVerified || !row || row.historicalOnly !== true || row.executable !== false) {
          throw new Error('Verified historical risk metrics are unavailable for this holding.');
        }
        const prior = lastVerifiedRiskMetricsRef.current || marketContextState.riskMetrics || {};
        const merged = {
          ...prior,
          ...payload,
          rows: {
            ...(prior.rows || {}),
            ...(payload.rows || {}),
          },
          historicalOnly: true,
          executable: false,
        };
        lastVerifiedRiskMetricsRef.current = merged;
        setMarketContextState((current) => {
          const nextErrors = { ...(current.errors || {}) };
          delete nextErrors.riskMetrics;
          return {
            ...current,
            riskMetrics: merged,
            sourceStatus: {
              ...(current.sourceStatus || {}),
              riskMetrics: current.sourceStatus?.riskMetrics === 'ready' ? 'ready' : 'partial',
            },
            errors: nextErrors,
          };
        });
        return row;
      })
      .catch((error) => {
        if (marketContextRequestSequence.current !== requestSequence) return null;
        setMarketContextState((current) => ({
          ...current,
          errors: {
            ...(current.errors || {}),
            riskMetrics: error?.message || 'Verified historical risk metrics are unavailable.',
          },
        }));
        return null;
      })
      .finally(() => {
        priorityRiskRequestsRef.current.delete(normalizedSymbol);
      });
    priorityRiskRequestsRef.current.set(normalizedSymbol, promise);
    return promise;
  }, [
    marketContextState.riskMetrics,
    marketContextState.sourceStatus?.riskMetrics,
    researchAssetTypes,
  ]);

  return { marketContextState, getPositionSizeReference, loadPriorityRiskMetrics };
}

export default usePortfolioMarketContext;
