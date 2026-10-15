import { useCallback, useEffect, useMemo, useState } from 'react';
import { useDashboardResource } from './useDashboardResource';
import predictionMarketTestService from '../services/api/predictionMarketTestService';
import { activePredictionMarketNavIndicators, normalizePredictionMarketNavIndicators, PREDICTION_MARKET_INDICATOR_MAX_AGE_MS, PREDICTION_MARKET_INDICATOR_POLL_MS } from '../utils/predictionMarketNavIndicators';

export function useDashboardPredictionIndicators() {
  const [predictionIndicatorNow, setPredictionIndicatorNow] = useState(() => Date.now());

  const loadPredictionMarketIndicators = useCallback(async () => {
    const report = await predictionMarketTestService.getMorningReport();
    return normalizePredictionMarketNavIndicators(report);
  }, []);

  const predictionIndicatorResource = useDashboardResource('prediction-nav', {}, {
    fetcher: loadPredictionMarketIndicators,
    getObservedAt: (snapshot) => snapshot.generatedAt,
    maxAgeMs: PREDICTION_MARKET_INDICATOR_MAX_AGE_MS,
    pollIntervalMs: PREDICTION_MARKET_INDICATOR_POLL_MS,
    active: true,
    pollWhenHidden: true,
    pollWhenDocumentHidden: false,
    isExplicitInvalidation: () => true,
    expiredCode: 'PREDICTION_MARKET_INDICATORS_EXPIRED',
    expiredMessage: 'Prediction-market alignment indicators expired.',
  });

  const predictionMarketIndicators = useMemo(() => (
    activePredictionMarketNavIndicators(predictionIndicatorResource.data, {
      now: Math.max(predictionIndicatorNow, Date.now()),
    })
  ), [predictionIndicatorNow, predictionIndicatorResource.data]);

  useEffect(() => {
    const futureExpiries = Object.values(predictionIndicatorResource.data?.indicators || {})
      .map((indicator) => Date.parse(String(indicator?.expiresAt || '')))
      .filter((expiresAt) => Number.isFinite(expiresAt) && expiresAt > Date.now());
    if (!futureExpiries.length) return undefined;
    const timer = setTimeout(() => {
      setPredictionIndicatorNow(Date.now());
    }, Math.max(0, Math.min(...futureExpiries) - Date.now() + 1));
    return () => clearTimeout(timer);
  }, [predictionIndicatorNow, predictionIndicatorResource.data]);

  return predictionMarketIndicators;
}

export default useDashboardPredictionIndicators;
