const express = require('express');
const crypto = require('crypto');
const { createIbkrDatedFuturesFeed } = require('../services/predictionMarketTest/ibkrDatedFuturesFeed.cjs');
const { createPublicSources } = require('../services/predictionMarketTest/publicSources.cjs');
const { createPredictionMarketTestService } = require('../services/predictionMarketTest/snapshotService.cjs');
const { createSpxMonitorService } = require('../services/predictionMarketTest/spxMonitorService.cjs');
const {
  MARKET_IDS,
  MARKET_CONFIGS,
  createMarketMonitorService,
} = require('../services/predictionMarketTest/marketMonitorService.cjs');
const { createMarketMonitorCoordinator } = require('../services/predictionMarketTest/marketMonitorCoordinator.cjs');
const { MARKET_ORDER: MORNING_MARKET_IDS, buildMorningReport } = require('../services/predictionMarketTest/morningReport.cjs');
const { createCardView } = require('../services/predictionMarketTest/cardView.cjs');
const { createReviewView } = require('../services/predictionMarketTest/reviewView.cjs');
const { DIRECTIONAL_FEEDS } = require('../services/predictionMarketTest/directionalFeedRegistry.cjs');

const MORNING_REPORT_REFRESH_ATTEMPTS = 2;
const MORNING_REPORT_RETRY_DELAY_MS = 250;
const FULL_VIEW_RATE_LIMIT = 120;
const FULL_VIEW_RATE_WINDOW_MS = 60_000;
const PIPELINE_MARKET_FLAG = 'PREDICTION_CARD_PIPELINE_MARKETS';
// CPI shares the prediction-card scheduler but is intentionally not a
// directional-price feed. Its live section is the exact Kalshi native book;
// its research sections are source-dated monthly publications.
const PIPELINE_MARKET_IDS = Object.freeze([...Object.keys(DIRECTIONAL_FEEDS), 'cpi', 'gdp']);

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

function freshPinnedNativeBook(snapshot, marketId, venue, requestedAt, nowMs) {
  const selection = snapshot?.displaySelection;
  const catalog = snapshot?.displayContracts;
  const event = catalog?.event;
  const unsafe = value => value && (
    value.connected === false
    || ['stale', 'isStale', 'cachedOnly', 'cacheOnly', 'fromCache', 'from_cache', 'refreshFailed', 'mock', 'isMock', 'seed', 'seeded', 'fallback', 'offline', 'disconnected', 'synthetic', 'inferred', 'delayed', 'frozen'].some(flag => value[flag] === true)
    || /stale|cache|mock|seed|fallback|offline|disconnect|synthetic|inferred|derived|frozen|delayed|historical|portfolio/i.test(['source', 'provenance', 'status', 'availability', 'cacheState', 'freshness'].map(key => value[key] || '').join(' '))
    || ['metadata', 'freshness', 'providerStatus'].some(key => value[key] && typeof value[key] === 'object' && unsafe(value[key]))
  );
  const incompleteBook = [selection, catalog].some(value => unsafe(value)
    || ['refreshing', 'refreshPending', 'refreshRetained'].some(flag => value?.[flag] === true));
  if (snapshot?.marketId !== marketId || snapshot.selectedVenueId !== venue || selection?.venueId !== venue
    || selection.status !== 'available' || catalog?.status !== 'available' || incompleteBook || unsafe(snapshot)
    || !event?.ticker || event.venueId !== venue || !['open', 'active'].includes(event.status)
    || !(Date.parse(event.closeTime) > nowMs) || !(Date.parse(catalog.bookExpiresAt) > nowMs)) return false;
  return (Array.isArray(catalog.lines) ? catalog.lines : []).some(line => {
    const quotes = line.evidence?.quotes;
    const source = String(quotes?.source || line.source || '').toLowerCase();
    const observed = Date.parse(quotes?.asOf || line.quoteAsOf || '');
    const nativeSource = venue === 'kalshi' ? source.includes('kalshi') : source.includes('forecastex') && source.includes('ibkr');
    return line.directNative === true && !line.derivedFields?.length && quotes?.fit === 'exact'
      && nativeSource && !unsafe(line) && !unsafe(quotes)
      && Number.isFinite(observed) && observed >= Date.parse(requestedAt)
      && nowMs - observed >= -5_000 && nowMs - observed <= 90_000
      && ['yesBid', 'yesAsk', 'noBid', 'noAsk'].every(key => typeof line[key] === 'number' && Number.isFinite(line[key]) && line[key] >= 0 && line[key] <= 1)
      && line.yesBid <= line.yesAsk && line.noBid <= line.noAsk;
  });
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
  loadHedgaiResearch,
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
  monitorRefreshTimeoutMs,
} = {}) {
  const router = express.Router();
  const fullViewRateStates = new Map();
  const monitorRefreshes = new Map();
  const service = createPredictionMarketTestService({
    feed,
    publicSources,
    loadRiskRanges,
    loadInflationNowcasts,
    loadCryptoTracker,
    now,
  });
  const spxMonitorService = injectedSpxMonitorService || createSpxMonitorService({
    loadHedgaiResearch,
    loadTradeSnapshots,
    loadCftcSnapshots,
    loadMarketStructureSnapshots,
    loadUsdSnapshot,
    now,
    ...spxMonitorOptions,
  });
  const marketMonitorService = injectedMarketMonitorService || createMarketMonitorService({
    loadHedgaiResearch,
    publicSources,
    spxMonitorService,
    loadRiskRanges,
    loadCryptoTracker,
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

  router.post('/monitor/:marketId/refresh', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    const marketId = String(req.params?.marketId || '').trim().toLowerCase();
    const venue = String(req.query?.venue || '').trim().toLowerCase();
    const config = MARKET_CONFIGS[marketId];
    const venues = config?.venueIds || ['kalshi', 'forecastex'].filter(id => config?.[`${id === 'forecastex' ? 'forecastEx' : id}Resolver`]);
    if (!MARKET_IDS.includes(marketId) || !venues.includes(venue)) {
      return res.status(400).json({ status: 'unavailable', marketId, error: { code: 'PM_MONITOR_INVALID_SELECTION', message: 'A supported market and explicit venue are required.' } });
    }
    const key = `${marketId}:${venue}`;
    if (!monitorRefreshes.has(key)) {
      const refreshAfter = Date.now();
      const requestedAt = now().toISOString();
      const selection = { venue, generationId: null };
      const previousRevision = Number(marketMonitorCoordinator.getSnapshot(marketId, selection).revision) || 0;
      // ForecastEx qualifies broker contracts before acquiring native quotes.
      const refreshBudgetMs = monitorRefreshTimeoutMs ?? (venue === 'forecastex' ? 35_000 : 25_000);
      const deadline = Date.now() + Math.max(1, Math.min(35_000, refreshBudgetMs));
      const bounded = async (promise) => {
        let timer;
        try {
          return await Promise.race([promise, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Refresh timed out')), Math.max(1, deadline - Date.now()));
          })]);
        } finally { clearTimeout(timer); }
      };
      const refresh = (async () => {
        await bounded(marketMonitorCoordinator.refresh(marketId, { ...selection, forceRefresh: true, refreshAfter }));
        let snapshot = marketMonitorCoordinator.getSnapshot(marketId, selection);
        // Fresh native books settle independently of chart/research refreshes.
        // Preserve the monitor's pending state and every field's own provenance.
        const bookReady = () => freshPinnedNativeBook(snapshot, marketId, venue, requestedAt, now().getTime());
        while (snapshot.refresh?.state === 'refreshing' && !bookReady() && Date.now() < deadline) {
          await bounded(new Promise(resolve => setTimeout(resolve, 250)));
          await bounded(marketMonitorCoordinator.refresh(marketId, { ...selection, forceRefresh: true, refreshAfter }));
          snapshot = marketMonitorCoordinator.getSnapshot(marketId, selection);
        }
        const refreshMeta = snapshot.refresh || {};
        const started = Date.parse(refreshMeta.startedAt);
        const completed = Date.parse(refreshMeta.completedAt);
        const scopedBook = refreshMeta.state === 'refreshing' && bookReady();
        if ((refreshMeta.state !== 'idle' && !scopedBook) || refreshMeta.lastError || Number(snapshot.revision) <= previousRevision
          || !Number.isFinite(started) || !Number.isFinite(completed)
          || started < Date.parse(requestedAt) || completed < started) throw new Error('Fresh acquisition was not verified');
        return { ...snapshot, acquisition: { status: 'complete', ...(scopedBook ? { scope: 'pinned_native_book' } : {}), requestedAt, completedAt: refreshMeta.completedAt, previousRevision, revision: snapshot.revision } };
      })().finally(() => { if (monitorRefreshes.get(key) === refresh) monitorRefreshes.delete(key); });
      monitorRefreshes.set(key, refresh);
    }
    try {
      const snapshot = await monitorRefreshes.get(key);
      return res.json(req.query?.view === 'review' ? createReviewView(snapshot) : snapshot);
    }
    catch { return res.status(503).json({ status: 'unavailable', marketId, error: { code: 'PM_MONITOR_REFRESH_UNAVAILABLE', message: 'Fresh monitor acquisition is unavailable.' } }); }
  });

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
    if (marketId === 'gdp' && !['auto', 'forecastex'].includes(requestedVenueInput)) {
      return res.status(400).json({ schemaVersion: 2, marketId, status: 'unavailable',
        error: { code: 'PM_GDP_FORECASTEX_ONLY', message: 'GDP is fixed to ForecastEx RGDP Q3 2026.' } });
    }
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
    const generationId = String(req.query?.generationId || '').trim() || null;
    if (marketId === 'gdp' && (generationId || req.query?.quarter)) {
      return res.status(400).json({ schemaVersion: 2, marketId, status: 'unavailable',
        error: { code: 'PM_GDP_GENERATION_FIXED', message: 'GDP follows the Q3 2026 third-estimate contract through settlement.' } });
    }
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
          message: 'The CPI monitor automatically follows the current server-owned release for the selected venue.',
        },
      });
    }
    // Gold is one fixed product in this monitor: the current Kalshi KXGOLDD
    // generation. Ignore legacy/manual venue and generation query parameters
    // so every reader lands on the same prewarmed coordinator state.
    const requestedVenue = ['sp500', 'gdp'].includes(marketId)
      ? 'forecastex'
      : marketId === 'gold' || (marketId === 'cpi' && requestedVenueInput === 'auto') ? 'kalshi' : requestedVenueInput;
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
