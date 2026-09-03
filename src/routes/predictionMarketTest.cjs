const express = require('express');
const crypto = require('crypto');
const { createIbkrDatedFuturesFeed } = require('../services/predictionMarketTest/ibkrDatedFuturesFeed.cjs');
const { createPublicSources } = require('../services/predictionMarketTest/publicSources.cjs');
const { createPredictionMarketTestService } = require('../services/predictionMarketTest/snapshotService.cjs');
const { createSpxMonitorService } = require('../services/predictionMarketTest/spxMonitorService.cjs');
const {
  MARKET_IDS,
  createMarketMonitorService,
} = require('../services/predictionMarketTest/marketMonitorService.cjs');
const { createMarketMonitorCoordinator } = require('../services/predictionMarketTest/marketMonitorCoordinator.cjs');
const { MARKET_ORDER: MORNING_MARKET_IDS, buildMorningReport } = require('../services/predictionMarketTest/morningReport.cjs');
const { createCardView } = require('../services/predictionMarketTest/cardView.cjs');
const { DIRECTIONAL_FEEDS } = require('../services/predictionMarketTest/directionalFeedRegistry.cjs');

const MORNING_REPORT_REFRESH_ATTEMPTS = 2;
const MORNING_REPORT_RETRY_DELAY_MS = 250;
const FULL_VIEW_RATE_LIMIT = 120;
const FULL_VIEW_RATE_WINDOW_MS = 60_000;
const PIPELINE_MARKET_FLAG = 'PREDICTION_CARD_PIPELINE_MARKETS';
// CPI shares the prediction-card scheduler but is intentionally not a
// directional-price feed. Its live section is the exact Kalshi native book;
// its research sections are source-dated monthly publications.
const PIPELINE_MARKET_IDS = Object.freeze([...Object.keys(DIRECTIONAL_FEEDS), 'cpi']);

function parsePipelineMarketIds(value = process.env[PIPELINE_MARKET_FLAG]) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized || normalized === 'all') return [...PIPELINE_MARKET_IDS];
  if (['none', 'off', 'disabled'].includes(normalized)) return [];
  const requested = [...new Set(normalized.split(',').map((entry) => entry.trim()).filter(Boolean))];
  const invalid = requested.filter((marketId) => !PIPELINE_MARKET_IDS.includes(marketId));
  if (invalid.length) {
    throw new TypeError(`${PIPELINE_MARKET_FLAG} contains unsupported markets: ${invalid.join(', ')}`);
  }
  return PIPELINE_MARKET_IDS.filter((marketId) => requested.includes(marketId));
}

function monitorEtag(payload, view) {
  // Pure reads may fail closed an expired live field between background
  // revisions. Hash the actual representation so a changed safe payload can
  // never inherit a 304 solely because its revision number is unchanged.
  const representation = `${view}\0${JSON.stringify(payload)}`;
  return `"${crypto.createHash('sha1').update(representation).digest('hex').slice(0, 20)}"`;
}

function requestHeader(req, name) {
  if (typeof req?.get === 'function') return req.get(name);
  return req?.headers?.[String(name).toLowerCase()] || null;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function currentSection(value, nowMs) {
  if (!value || value.status !== 'available'
    || value.refreshFailed === true || value.stale === true || value.cachedOnly === true) return false;
  const expiresAt = Date.parse(String(value.expiresAt || ''));
  return !value.expiresAt || (Number.isFinite(expiresAt) && expiresAt > nowMs);
}

function finiteValue(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
}

function observedProviderHealth(monitors, predicate, fallback = null) {
  const observations = Object.values(monitors || {}).flatMap((monitor) => (
    Array.isArray(monitor?.sourceHealth) ? monitor.sourceHealth : []
  )).filter((entry) => entry?.applicable !== false && predicate(entry));
  if (!observations.length) return fallback || {
    status: 'not_started', lastSuccessAt: null, error: null, observationCount: 0,
  };
  const usableStatuses = new Set(['live', 'available', 'historical', 'partial', 'catalog_only']);
  const usable = observations.filter((entry) => usableStatuses.has(String(entry.status || '').toLowerCase()));
  const refreshing = observations.some((entry) => String(entry.status || '').toLowerCase() === 'refreshing');
  const successes = observations
    .map((entry) => entry.lastSuccessAt || entry.asOf || null)
    .filter(Boolean)
    .sort();
  const failure = observations.find((entry) => !usableStatuses.has(String(entry.status || '').toLowerCase()) && entry.reason);
  return {
    status: usable.length ? 'available' : refreshing ? 'refreshing' : 'unavailable',
    lastSuccessAt: successes[successes.length - 1] || null,
    error: usable.length ? null : failure?.reason || null,
    observationCount: observations.length,
    usableObservationCount: usable.length,
  };
}

function unifiedHealthProviders(baseProviders, directionalPipeline, monitors) {
  const providerStatus = directionalPipeline?.providerStatus || {};
  const directionalSelections = directionalPipeline?.directionalSelections || {};
  const ibkrFeeds = Object.values(DIRECTIONAL_FEEDS).filter((feed) => feed.provider === 'ibkr');
  const symbols = Object.fromEntries(ibkrFeeds.map((feed) => {
    const selection = directionalSelections[feed.marketId] || {};
    return [feed.root, {
      marketId: feed.marketId,
      root: feed.root,
      exchange: feed.exchange,
      status: selection.status || 'unavailable',
      conId: selection.conId || null,
      localSymbol: selection.localSymbol || null,
      lastTradeDate: selection.lastTradeDate || null,
      rollReason: selection.rollReason || null,
      refreshPending: selection.refreshPending === true,
    }];
  }));
  const connected = providerStatus.connected === true;
  return {
    ...(baseProviders || {}),
    // Preserve the compatibility key while replacing the expired dated-symbol
    // registry behind it with the same ES/CL/GC/SI/BZ registry cards consume.
    ibkrFutures: {
      provider: 'ibkr',
      dataset: 'Unified liquid directional futures registry',
      configured: true,
      connected,
      status: connected ? 'available' : providerStatus.status || 'not_started',
      message: providerStatus.message || null,
      lastSuccessAt: providerStatus.asOf || null,
      requestedSymbolCount: ibkrFeeds.length,
      selectedSymbolCount: Object.values(symbols).filter((entry) => entry.conId != null).length,
      dataType: 'live_only',
      cachePolicy: 'verified_completed_history_only',
      symbols,
    },
    kalshi: observedProviderHealth(monitors, (entry) => String(entry.id || '').startsWith('kalshi_'), baseProviders?.kalshi),
    forecastex: observedProviderHealth(monitors, (entry) => String(entry.id || '').startsWith('forecastex_'), baseProviders?.forecastex),
    coinbase: observedProviderHealth(monitors, (entry) => /coinbase/i.test(String(entry.source || '')), baseProviders?.coinbase),
    hedgeyeRiskRanges: observedProviderHealth(monitors, (entry) => entry.id === 'risk_range', baseProviders?.hedgeyeRiskRanges),
  };
}

function morningAttentionReady(snapshot, nowMs) {
  const riskRange = snapshot?.riskRange;
  const currentRange = currentSection(riskRange, nowMs)
    && finiteValue(riskRange.lrr)
    && finiteValue(riskRange.hrr)
    && Number(riskRange.lrr) < Number(riskRange.hrr)
    && Boolean(riskRange.trend);
  const currentCatalog = currentSection(snapshot?.displayContracts, nowMs)
    && Boolean(snapshot.displayContracts?.event?.ticker);
  const currentExactSpot = currentSection(snapshot?.spot, nowMs)
    && String(snapshot.spot?.availability || '').toLowerCase() === 'live'
    && String(snapshot.spot?.fit || '').toLowerCase() === 'exact'
    && finiteValue(snapshot.spot?.value);
  const hasRangeReference = finiteValue(riskRange?.previousClose) || currentExactSpot;
  return Boolean(currentRange && currentCatalog && hasRangeReference);
}

function createPredictionMarketTestRouter({
  loadRiskRanges,
  loadInflationNowcasts,
  loadCryptoTracker,
  loadTradeSnapshots,
  loadCftcSnapshots,
  loadMarketStructureSnapshots,
  loadUsdSnapshot,
  loadVolatilitySnapshot,
  loadForecastExLive,
  loadMarketReference,
  loadMarketReferenceHealth,
  spxMonitorOptions = {},
  spxMonitorService: injectedSpxMonitorService = null,
  marketMonitorService: injectedMarketMonitorService = null,
  marketMonitorCoordinator: injectedMarketMonitorCoordinator = null,
  pipelineMarketIds = parsePipelineMarketIds(),
  feed = createIbkrDatedFuturesFeed(),
  publicSources = createPublicSources(),
  now = () => new Date(),
} = {}) {
  const router = express.Router();
  const fullViewRateStates = new Map();
  const service = createPredictionMarketTestService({
    feed,
    publicSources,
    loadRiskRanges,
    loadInflationNowcasts,
    loadCryptoTracker,
    now,
  });
  const spxMonitorService = injectedSpxMonitorService || createSpxMonitorService({
    loadTradeSnapshots,
    loadCftcSnapshots,
    loadMarketStructureSnapshots,
    loadUsdSnapshot,
    now,
    ...spxMonitorOptions,
  });
  const marketMonitorService = injectedMarketMonitorService || createMarketMonitorService({
    publicSources,
    spxMonitorService,
    loadRiskRanges,
    loadTradeSnapshots,
    loadVolatilitySnapshot,
    loadCftcSnapshots,
    loadUsdSnapshot,
    loadForecastExLive,
    loadMarketReference,
    now,
  });
  const marketMonitorCoordinator = injectedMarketMonitorCoordinator || createMarketMonitorCoordinator({
    monitorService: marketMonitorService,
    scheduledMarketIds: pipelineMarketIds,
    now,
  });

  function consumeFullViewRequest(req) {
    const key = String(req?.ip || req?.socket?.remoteAddress || 'local');
    const nowMs = now().getTime();
    const current = fullViewRateStates.get(key);
    const entry = !current || nowMs - current.startedAt >= FULL_VIEW_RATE_WINDOW_MS
      ? { startedAt: nowMs, count: 0 }
      : current;
    entry.count += 1;
    fullViewRateStates.set(key, entry);
    if (fullViewRateStates.size > 32) {
      [...fullViewRateStates.entries()]
        .sort((left, right) => left[1].startedAt - right[1].startedAt)
        .slice(0, fullViewRateStates.size - 32)
        .forEach(([candidate]) => fullViewRateStates.delete(candidate));
    }
    return entry.count <= FULL_VIEW_RATE_LIMIT;
  }

  router.get('/monitor/:marketId', async (req, res) => {
    const view = String(req.query?.view || 'full').trim().toLowerCase();
    if (!['full', 'card'].includes(view)) {
      return res.status(400).json({
        schemaVersion: 2,
        generatedAt: now().toISOString(),
        status: 'unavailable',
        error: { code: 'PM_MONITOR_INVALID_VIEW', message: 'view must be card or full.' },
      });
    }
    res.setHeader('Cache-Control', view === 'card' ? 'private, no-cache, max-age=0' : 'no-store, max-age=0');
    if (view === 'full' && !consumeFullViewRequest(req)) {
      res.setHeader('Retry-After', '5');
      return res.status(429).json({
        schemaVersion: 2,
        generatedAt: now().toISOString(),
        status: 'unavailable',
        error: { code: 'PM_MONITOR_LOCAL_RATE_LIMIT', message: 'The local compatibility monitor rate limit was exceeded.' },
      });
    }
    const marketId = String(req.params?.marketId || '').trim().toLowerCase();
    if (!MARKET_IDS.includes(marketId)) {
      return res.status(400).json({
        schemaVersion: 2,
        generatedAt: now().toISOString(),
        status: 'unavailable',
        marketId: marketId || null,
        supportedMarkets: MARKET_IDS,
        error: {
          code: 'PM_MONITOR_UNSUPPORTED_MARKET',
          message: `Prediction-market monitor must be one of: ${MARKET_IDS.join(', ')}.`,
        },
      });
    }
    const requestedVenueInput = String(req.query?.venue || 'auto').trim().toLowerCase();
    if (!['auto', 'kalshi', 'forecastex'].includes(requestedVenueInput)) {
      return res.status(400).json({
        schemaVersion: 2,
        generatedAt: now().toISOString(),
        status: 'unavailable',
        marketId,
        error: {
          code: 'PM_MONITOR_INVALID_VENUE',
          message: 'venue must be auto, kalshi, or forecastex.',
        },
      });
    }
    if (marketId === 'sp500' && requestedVenueInput === 'kalshi') {
      return res.status(400).json({
        schemaVersion: 2,
        generatedAt: now().toISOString(),
        status: 'unavailable',
        marketId,
        error: {
          code: 'PM_SP500_FORECASTEX_ONLY',
          message: 'The SP500 monitor is fixed to the current ForecastEx FES market routed through IBKR.',
        },
      });
    }
    if (marketId === 'cpi' && requestedVenueInput === 'forecastex') {
      return res.status(400).json({
        schemaVersion: 2,
        generatedAt: now().toISOString(),
        status: 'unavailable',
        marketId,
        error: {
          code: 'PM_CPI_KALSHI_ONLY',
          message: 'The CPI monitor is fixed to the current Kalshi KXCPIYOY release.',
        },
      });
    }
    const generationId = String(req.query?.generationId || '').trim() || null;
    if (generationId && (generationId.length > 120 || !/^[A-Za-z0-9._:#-]+$/.test(generationId))) {
      return res.status(400).json({
        schemaVersion: 2,
        generatedAt: now().toISOString(),
        status: 'unavailable',
        marketId,
        error: {
          code: 'PM_MONITOR_INVALID_GENERATION',
          message: 'generationId is invalid.',
        },
      });
    }
    if (marketId === 'sp500' && generationId) {
      return res.status(400).json({
        schemaVersion: 2,
        generatedAt: now().toISOString(),
        status: 'unavailable',
        marketId,
        error: {
          code: 'PM_SP500_GENERATION_FIXED',
          message: 'The SP500 monitor automatically uses the current official ForecastEx FES generation.',
        },
      });
    }
    if (marketId === 'cpi' && generationId) {
      return res.status(400).json({
        schemaVersion: 2,
        generatedAt: now().toISOString(),
        status: 'unavailable',
        marketId,
        error: {
          code: 'PM_CPI_GENERATION_FIXED',
          message: 'The CPI monitor automatically follows the current server-owned Kalshi release.',
        },
      });
    }
    // Gold is one fixed product in this monitor: the current Kalshi KXGOLDD
    // generation. Ignore legacy/manual venue and generation query parameters
    // so every reader lands on the same prewarmed coordinator state.
    const requestedVenue = marketId === 'sp500'
      ? 'forecastex'
      : ['cpi', 'gold'].includes(marketId) ? 'kalshi' : requestedVenueInput;
    const requestedGenerationId = ['cpi', 'gold'].includes(marketId) ? null : generationId;
    try {
      const snapshot = marketMonitorCoordinator.getSnapshot(marketId, {
        venue: requestedVenue,
        generationId: requestedGenerationId,
      });
      const payload = view === 'card' ? createCardView(snapshot) : snapshot;
      const etag = monitorEtag(payload, view);
      res.setHeader('ETag', etag);
      res.setHeader('X-Prediction-Monitor-Revision', String(snapshot.revision || 0));
      if (requestHeader(req, 'If-None-Match') === etag && typeof res.end === 'function') {
        return res.status(304).end();
      }
      return res.json(payload);
    } catch (error) {
      console.error(`[Prediction Monitor] ${marketId} snapshot failed:`, error);
      return res.status(error?.status === 400 ? 400 : 503).json({
        schemaVersion: 2,
        generatedAt: now().toISOString(),
        status: 'unavailable',
        marketId,
        session: { state: 'closed', asOf: now().toISOString() },
        refresh: { state: 'error', revision: 0, startedAt: null, completedAt: now().toISOString(), suggestedNextPollMs: 30_000 },
        spot: { status: 'unavailable', value: null, fit: 'exact', availability: 'unavailable', executable: false },
        chart: { status: 'unavailable', points: [], references: [], fit: 'exact', availability: 'unavailable', executable: false },
        riskRange: { status: 'unavailable', lrr: null, hrr: null, trend: null },
        forecastComparison: marketId === 'cpi' ? {
          status: 'unavailable', releaseKey: null, reportMonth: null, releaseAt: null,
          eventTicker: null, metric: 'Headline CPI YoY', unit: 'percent',
          hedgeye: { status: 'unavailable', scenarios: [], baseValue: null },
          clevelandFed: { status: 'unavailable', value: null, points: [] },
          bls: { status: 'unavailable', latestFinal: null },
        } : null,
        ladderReference: null,
        factors: {},
        factorRows: [],
        scoreInputs: {},
        generationOptions: [],
        selectedGeneration: null,
        selectedGenerationId: null,
        selectedVenueId: null,
        productActivity: null,
        sourceHealth: [],
        venues: {},
        autoSelection: {
          status: 'unavailable',
          mode: 'none',
          venueId: null,
          reason: 'Prediction-market monitor snapshot is unavailable.',
          contracts: { status: 'unavailable', event: null, lines: [] },
        },
        displaySelection: {
          status: 'unavailable',
          mode: 'none',
          venueId: null,
          reason: 'Prediction-market monitor snapshot is unavailable.',
          contracts: { status: 'unavailable', event: null, lines: [] },
        },
        displayContracts: { status: 'unavailable', event: null, lines: [] },
        contracts: { status: 'unavailable', event: null, lines: [] },
        strategy: { status: 'unavailable', model: null, eligibleVenueId: null },
        errors: ['Prediction-market monitor snapshot is unavailable.'],
      });
    }
  });

  router.get('/morning-report', async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    const entries = MORNING_MARKET_IDS.map((marketId) => {
      try {
        return [marketId, marketMonitorCoordinator.getSnapshot(marketId)];
      } catch (error) {
        console.error(`[Prediction Monitor] ${marketId} morning snapshot failed:`, error);
        return [marketId, null];
      }
    });
    const snapshots = Object.fromEntries(entries);
    const report = buildMorningReport(snapshots, { now: now() });
    return res.status(report.status === 'unavailable' ? 503 : 200).json(report);
  });

  router.get('/spx-monitor', async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    try {
      return res.json(marketMonitorCoordinator.getSnapshot('sp500', {
        venue: 'forecastex',
        generationId: null,
      }));
    } catch (error) {
      console.error('[Resolver Test] SPX monitor failed:', error);
      return res.status(503).json({
        schemaVersion: 2,
        marketId: 'sp500',
        generatedAt: now().toISOString(),
        status: 'unavailable',
        session: { state: 'closed', asOf: now().toISOString() },
        spot: { status: 'unavailable', value: null },
        chart: { status: 'unavailable', points: [], references: [] },
        riskRange: { status: 'unavailable', lrr: null, hrr: null, trend: null },
        factors: {},
        scoreInputs: {},
        contracts: { status: 'unavailable', event: null, lines: [] },
        errors: ['SPX monitor snapshot is unavailable.'],
      });
    }
  });

  router.get('/snapshot', async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    try {
      return res.json(await service.getSnapshot());
    } catch (error) {
      console.error('[Resolver Test] Snapshot failed:', error);
      return res.status(503).json({
        schemaVersion: 1,
        generatedAt: now().toISOString(),
        status: 'unavailable',
        providers: service.getHealth().providers,
        products: [],
        error: {
          code: error.code || 'PM_TEST_SNAPSHOT_UNAVAILABLE',
          message: 'Resolver Test snapshot is unavailable.',
        },
      });
    }
  });

  router.get('/health', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    const baseHealth = service.getHealth();
    const directionalPipeline = typeof loadMarketReferenceHealth === 'function'
      ? loadMarketReferenceHealth()
      : { status: 'unavailable' };
    const monitors = marketMonitorCoordinator.getHealth();
    return res.json({
      ...baseHealth,
      providers: unifiedHealthProviders(baseHealth.providers, directionalPipeline, monitors),
      directionalFeeds: DIRECTIONAL_FEEDS,
      directionalPipeline,
      pipelineRollout: {
        flag: PIPELINE_MARKET_FLAG,
        enabledMarkets: [...pipelineMarketIds],
        disabledMarkets: PIPELINE_MARKET_IDS.filter((marketId) => !pipelineMarketIds.includes(marketId)),
      },
      legacyDatedRegistry: { status: 'retired', reason: 'Prediction cards use the unified directional-feed registry.' },
      monitors,
    });
  });

  const start = () => {
    // The dated Aug-14 feed remains constructible for the legacy v1 snapshot,
    // but it is no longer started or consumed by prediction cards.
    return marketMonitorCoordinator.start();
  };

  const stop = () => {
    marketMonitorCoordinator.stop();
    return service.stop();
  };

  return {
    router,
    service,
    marketMonitorService,
    marketMonitorCoordinator,
    start,
    stop,
  };
}

module.exports = {
  createPredictionMarketTestRouter,
  parsePipelineMarketIds,
};
