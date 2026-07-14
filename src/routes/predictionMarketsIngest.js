const express = require('express');
const router = express.Router();
const {
  getAggregatedFinancialPredictionEvents,
  fetchIBKREvents,
} = require('../services/predictionMarketsIngest');
const { getProviderStatus, setProviderStatus } = require('../services/predictionMarketsIngest/cache');
const { normalizedToDashboardEvent } = require('../services/predictionMarketsIngest/toDashboardEvent');
const { fetchKalshiCpiEvents } = require('../services/predictionMarketsIngest/providers/kalshiProvider');

const IBKR_VENUES = new Set(['ForecastEx', 'CME', 'IBKR']);
const NON_LIVE_TRADING_FLAGS = new Set([
  'stale_quote',
  'portfolio_seed',
  'portfolio_discovered',
  'catalog_missing',
  'mock',
  'fallback',
  'no_live_quote',
]);

function nowMs() {
  return Date.now();
}

function isIbkrTradableEvent(event) {
  return Boolean(
    event?.tradable_in_ibkr === true ||
    event?.ibkr_tradable === true ||
    event?.source_api === 'IBKR_CPAPI' ||
    IBKR_VENUES.has(event?.venue)
  );
}

function hasAnyExecutableAsk(event = {}) {
  const yesAsk = Number(event.yes_ask);
  const noAsk = Number(event.no_ask);
  return (
    (Number.isFinite(yesAsk) && yesAsk > 0 && yesAsk < 1) ||
    (Number.isFinite(noAsk) && noAsk > 0 && noAsk < 1)
  );
}

function isPortfolioDiscoveredEvent(event = {}) {
  return [
    ...(event.data_quality_flags || []),
    ...(event.flags || []),
  ].includes('portfolio_discovered');
}

function isVerifiedIbkrQuoteRefresh(event = {}) {
  return (
    event.source_api === 'IBKR_TWS_API' &&
    isPortfolioDiscoveredEvent(event) &&
    hasAnyExecutableAsk(event) &&
    Boolean(event.updated_at)
  );
}

function nonLiveFlagsForEvent(event = {}) {
  return (event.data_quality_flags || []).filter((flag) => (
    flag !== 'portfolio_discovered' || !isVerifiedIbkrQuoteRefresh(event)
  ));
}

function stripQuoteVerifiedPortfolioDiscoveryFlag(event = {}) {
  if (!isVerifiedIbkrQuoteRefresh(event)) return event;
  return {
    ...event,
    data_quality_flags: (event.data_quality_flags || []).filter((flag) => flag !== 'portfolio_discovered'),
    discovery_source: event.discovery_source || 'portfolio_position',
  };
}

function isLiveTradingEvent(event) {
  if (!event || event.source_api === 'IBKR_PORTFOLIO' || event.heldPosition) return false;
  return !nonLiveFlagsForEvent(event).some((flag) => NON_LIVE_TRADING_FLAGS.has(flag));
}

function filterIbkrEvents(events = []) {
  return (events || [])
    .filter((event) => isIbkrTradableEvent(event) && isLiveTradingEvent(event))
    .map(stripQuoteVerifiedPortfolioDiscoveryFlag);
}

function strikeTick(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 10) : null;
}

function tickToStrike(tick) {
  return Number((tick / 10).toFixed(1));
}

function extractCpiStrike(event = {}) {
  const text = [
    event.contract_title,
    event.question,
    event.event_title,
    event.api_raw_symbol,
    event.symbol,
    event.description,
    event.localSymbol,
  ].filter(Boolean).join(' ');
  const above = text.match(/\babove\s+(-?\d+(?:\.\d+)?)\s*%?/i);
  if (above) return Number(above[1]);
  const token = text.match(/(?:^|[-_\s])T(-?\d+(?:\.\d+)?)(?:[-_\s]?(?:YES|NO)\b|$)/i);
  return token ? Number(token[1]) : null;
}

function eventStrikeTick(event) {
  return strikeTick(extractCpiStrike(event));
}

function isKalshiCpiEvent(event = {}) {
  return event.venue === 'Kalshi' && event.source_api === 'kalshi_trade_api_v2';
}

function hasTwoSidedExecutableAsk(event = {}) {
  const yesAsk = Number(event.yes_ask);
  const noAsk = Number(event.no_ask);
  return (
    Number.isFinite(yesAsk) &&
    yesAsk > 0 &&
    yesAsk < 1 &&
    Number.isFinite(noAsk) &&
    noAsk > 0 &&
    noAsk < 1
  );
}

function chooseCpiSourceEvent(current, candidate) {
  if (!current) return candidate;

  const currentComplete = hasTwoSidedExecutableAsk(current);
  const candidateComplete = hasTwoSidedExecutableAsk(candidate);
  if (candidateComplete !== currentComplete) {
    return candidateComplete ? candidate : current;
  }

  const currentKalshi = isKalshiCpiEvent(current);
  const candidateKalshi = isKalshiCpiEvent(candidate);
  if (candidateKalshi && !currentKalshi && isPortfolioDiscoveredEvent(current)) {
    return candidate;
  }

  return current;
}

function mergeCpiSourceEvents(ibkrEvents = [], kalshiEvents = [], body = {}) {
  const targetTicks = new Set((body?.cpi?.targetStrikes || []).map(strikeTick).filter((tick) => tick != null));
  const byTick = new Map();
  const extras = [];

  for (const event of [...ibkrEvents, ...kalshiEvents]) {
    const tick = eventStrikeTick(event);
    if (tick == null || (targetTicks.size > 0 && !targetTicks.has(tick))) {
      if (targetTicks.size === 0) extras.push(event);
      continue;
    }
    byTick.set(tick, chooseCpiSourceEvent(byTick.get(tick), event));
  }

  const orderedTicks = targetTicks.size
    ? [...targetTicks].sort((a, b) => a - b)
    : [...byTick.keys()].sort((a, b) => a - b);
  return [
    ...orderedTicks.map((tick) => byTick.get(tick)).filter(Boolean),
    ...extras,
  ];
}

function sourceFoundStrikes(events = [], body = {}) {
  const targetTicks = new Set((body?.cpi?.targetStrikes || []).map(strikeTick).filter((tick) => tick != null));
  const foundTicks = new Set();
  for (const event of events) {
    const tick = eventStrikeTick(event);
    if (tick == null) continue;
    if (targetTicks.size > 0 && !targetTicks.has(tick)) continue;
    foundTicks.add(tick);
  }
  return [...foundTicks].sort((a, b) => a - b).map(tickToStrike);
}

function isCpiPortfolioPosition(position = {}) {
  const text = [
    position.symbol,
    position.description,
    position.localSymbol,
    position.contract_title,
    position.question,
  ].filter(Boolean).join(' ').toUpperCase();
  return Number(position.quantity || position.position || 0) !== 0 && /\bKXCPI|CPIYOY|CPI\b/.test(text);
}

function formatCpiStrikeList(values = []) {
  return values.map((value) => `${Number(value).toFixed(1)}%`).join(', ');
}

function getCpiCatalogHealth(providers = {}, ibkrEvents = [], diagnostics = {}) {
  const ibkr = providers?.ibkr || {};
  const cpiDiscovery = diagnostics.cpi_discovery || diagnostics.cpiDiscovery || ibkr.cpi_discovery || ibkr.cpiDiscovery || {};
  const targetStrikes = diagnostics.targetStrikes || cpiDiscovery.targetStrikes || [];
  const missingStrikes = diagnostics.missingStrikes || cpiDiscovery.missingStrikes || [];
  const contractsTotal = Math.max(
    ibkrEvents.length,
    Number(
      diagnostics.contractsTotal ??
      diagnostics.contracts_total ??
      cpiDiscovery.contractsTotal ??
      cpiDiscovery.contracts_total ??
      ibkr.contracts_total ??
      ibkr.contractsTotal ??
      0,
    ),
  );
  const portfolioSeedCount = Number(
    diagnostics.portfolioSeedCount ??
    diagnostics.portfolio_seed_count ??
    ibkr.portfolio_seed_count ??
    ibkr.portfolioSeedCount ??
    0,
  );
  const portfolioCpiPositionCount = Number(
    diagnostics.portfolioCpiPositionCount ??
    diagnostics.portfolio_cpi_positions ??
    ibkr.portfolio_cpi_positions ??
    ibkr.portfolioCpiPositions ??
    0,
  );
  const missingTargetStrikes = targetStrikes.length > 0 && missingStrikes.length > 0;
  const incompleteTargetCoverage = targetStrikes.length > 0 && contractsTotal < targetStrikes.length;
  const seedOnlyCatalog = contractsTotal > 0 && portfolioSeedCount > 0 && portfolioSeedCount >= contractsTotal;

  return {
    targetStrikes,
    missingStrikes,
    contractsTotal,
    portfolioSeedCount,
    portfolioCpiPositionCount,
    missingTargetStrikes,
    incompleteTargetCoverage,
    seedOnlyCatalog,
    degraded: missingTargetStrikes || incompleteTargetCoverage || seedOnlyCatalog,
  };
}

function withIbkrContractStatus(providers = {}, ibkrEvents = [], diagnostics = {}) {
  const next = { ...providers };
  const status = next.ibkr?.status;
  const hasEmptyCatalogStatus = status === 'connected' || status === 'connected_no_contracts';
  const catalogHealth = getCpiCatalogHealth(next, ibkrEvents, diagnostics);
  const hasDiscoveredContracts = catalogHealth.contractsTotal > 0;
  if (hasEmptyCatalogStatus && hasDiscoveredContracts && catalogHealth.degraded) {
    const missingSuffix = catalogHealth.missingStrikes.length
      ? `; missing strikes ${formatCpiStrikeList(catalogHealth.missingStrikes)}`
      : '';
    const degraded = {
      status: 'connected_positions_only',
      message: `IBKR connected; CPI contract catalog incomplete${missingSuffix}`,
      last_success_at: next.ibkr.last_success_at,
      portfolio_cpi_positions: catalogHealth.portfolioCpiPositionCount,
      portfolio_seed_count: catalogHealth.portfolioSeedCount,
      contracts_total: catalogHealth.contractsTotal,
    };
    next.ibkr = { ...next.ibkr, ...degraded };
    next.forecastex = { ...next.forecastex, ...degraded };
    next.cme = { ...next.cme, ...degraded };
    return next;
  }
  if (hasEmptyCatalogStatus && !hasDiscoveredContracts) {
    if (catalogHealth.portfolioCpiPositionCount > 0) {
      const positionsOnly = {
        status: 'connected_positions_only',
        message: 'IBKR connected; CPI positions loaded from portfolio, contract catalog missing',
        last_success_at: next.ibkr.last_success_at,
        portfolio_cpi_positions: catalogHealth.portfolioCpiPositionCount,
      };
      next.ibkr = { ...next.ibkr, ...positionsOnly };
      next.forecastex = { ...next.forecastex, ...positionsOnly };
      next.cme = { ...next.cme, ...positionsOnly };
      return next;
    }
    const streamError = next.ibkr?.gateway?.gateway?.stream?.last_error || next.ibkr?.gateway?.stream?.last_error;
    if (streamError && /portfolio|account|position/i.test(streamError)) {
      const halfConnected = {
        status: 'gateway_half_connected',
        message: 'Gateway half-connected: account data stale/timeouts',
        last_success_at: next.ibkr.last_success_at,
      };
      next.ibkr = { ...next.ibkr, ...halfConnected };
      next.forecastex = { ...next.forecastex, ...halfConnected };
      next.cme = { ...next.cme, ...halfConnected };
      return next;
    }
    const empty = {
      status: 'connected_no_contracts',
      message: 'IBKR connected, no event contracts discovered',
      last_success_at: next.ibkr.last_success_at,
    };
    next.ibkr = { ...next.ibkr, ...empty };
    next.forecastex = { ...next.forecastex, ...empty };
    next.cme = { ...next.cme, ...empty };
  }
  return next;
}

async function getIbkrCpiPortfolioDiagnostics() {
  const diagnostics = { portfolioCpiPositionCount: 0, accounts: [] };
  try {
    const { sidecarRequest } = require('../services/predictionMarketsIngest/providers/ibkrHttp');
    let managedAccounts = [];
    try {
      const accounts = await sidecarRequest('/accounts', { timeoutMs: 3000 });
      managedAccounts = Array.isArray(accounts.accounts) ? accounts.accounts : [];
      diagnostics.managedAccounts = managedAccounts;
    } catch (err) {
      diagnostics.accountLookupError = err.message;
    }

    const orderedAccounts = [
      process.env.IBKR_ACCOUNT_ID,
      'U25779973',
      ...managedAccounts,
    ].filter(Boolean);

    for (const account of [...new Set(orderedAccounts)]) {
      try {
        const cache = await sidecarRequest(`/cache/portfolio?account=${encodeURIComponent(account)}`, { timeoutMs: 2500 });
        const positions = Array.isArray(cache.positions) ? cache.positions : [];
        const cpiCount = positions.filter(isCpiPortfolioPosition).length;
        diagnostics.portfolioCpiPositionCount += cpiCount;
        diagnostics.accounts.push({
          account,
          positions: positions.length,
          cpiPositions: cpiCount,
          fetchedAt: cache.fetched_at || null,
        });
      } catch (err) {
        diagnostics.accounts.push({
          account,
          positions: 0,
          cpiPositions: 0,
          error: err.message,
        });
      }
    }
  } catch (err) {
    diagnostics.error = err.message;
  }
  return diagnostics;
}

function getCpiDiscoveryDiagnostics(body = {}, result = {}, discovery = null, events = [], providers = {}) {
  const provider = providers?.ibkr || {};
  const cpiDiscovery =
    discovery?.cpi_discovery ||
    result?.cpi_discovery ||
    provider?.cpi_discovery ||
    null;
  const targetStrikes = cpiDiscovery?.targetStrikes || body?.cpi?.targetStrikes || [];
  const providerFoundStrikes = cpiDiscovery?.foundStrikes || [];
  const eventIbkrFoundStrikes = sourceFoundStrikes(events.filter((event) => !isKalshiCpiEvent(event)), body);
  const ibkrFoundStrikes = eventIbkrFoundStrikes.length ? eventIbkrFoundStrikes : providerFoundStrikes;
  const kalshiFoundStrikes = sourceFoundStrikes(events.filter(isKalshiCpiEvent), body);
  const foundTickSet = new Set([
    ...providerFoundStrikes,
    ...ibkrFoundStrikes,
    ...kalshiFoundStrikes,
  ].map(strikeTick).filter((tick) => tick != null));
  const foundStrikes = [...foundTickSet].sort((a, b) => a - b).map(tickToStrike);
  const missingStrikes = targetStrikes.filter((strike) => !foundTickSet.has(strikeTick(strike)));
  const contractsAdded = discovery?.contracts_added ?? result?.contracts_added ?? provider?.contracts_added ?? 0;
  const contractsTotal = Math.max(
    events.length,
    Number(discovery?.contracts_total ?? 0),
    Number(result?.contracts_total ?? 0),
    Number(provider?.contracts_total ?? 0),
  );
  const timing = discovery?.timing || result?.timing || provider?.cpi_timing || null;
  const portfolioSeedCount = discovery?.portfolio_seed_count ?? result?.portfolio_seed_count ?? provider?.portfolio_seed_count ?? 0;

  return {
    cpi_discovery: cpiDiscovery,
    cpiDiscovery,
    targetStrikes,
    ibkrFoundStrikes,
    kalshiFoundStrikes,
    foundStrikes,
    missingStrikes,
    contractsAdded,
    contractsTotal,
    portfolioSeedCount,
    timing,
    sidecarStatus: {
      status: provider.status || discovery?.status || null,
      message: provider.message || discovery?.message || null,
      lastSuccessAt: provider.last_success_at || null,
      gateway: provider.gateway || null,
      timing,
    },
  };
}

function attachCpiDiscoveryToProviders(providers = {}, diagnostics = {}) {
  const cpiDiscovery = {
    ...(diagnostics.cpi_discovery || {}),
    targetStrikes: diagnostics.targetStrikes,
    ibkrFoundStrikes: diagnostics.ibkrFoundStrikes,
    kalshiFoundStrikes: diagnostics.kalshiFoundStrikes,
    foundStrikes: diagnostics.foundStrikes,
    missingStrikes: diagnostics.missingStrikes,
    contractsTotal: diagnostics.contractsTotal,
    contracts_total: diagnostics.contractsTotal,
    contractsAdded: diagnostics.contractsAdded,
    contracts_added: diagnostics.contractsAdded,
  };
  const next = { ...providers };
  if (next.ibkr) next.ibkr = { ...next.ibkr, cpi_discovery: cpiDiscovery };
  if (next.kalshi) next.kalshi = { ...next.kalshi, cpi_discovery: cpiDiscovery };
  return next;
}

function cpiDiscoveryCoverageScore(discovery = {}) {
  const found = Array.isArray(discovery?.foundStrikes) ? discovery.foundStrikes.length : 0;
  const total = Number(discovery?.contractsTotal ?? discovery?.contracts_total ?? 0);
  const missing = Array.isArray(discovery?.missingStrikes) ? discovery.missingStrikes.length : 0;
  return found + total - missing;
}

function pickBestCpiDiscovery(...discoveries) {
  return discoveries
    .filter(Boolean)
    .sort((a, b) => cpiDiscoveryCoverageScore(b) - cpiDiscoveryCoverageScore(a))[0] || null;
}

function persistProviderStatusSnapshot(providers = {}) {
  ['ibkr', 'forecastex', 'cme', 'kalshi'].forEach((provider) => {
    if (providers?.[provider]) {
      setProviderStatus(provider, providers[provider]);
    }
  });
}

// GET /api/prediction-markets/aggregated-events
router.get('/aggregated-events', async (req, res) => {
  try {
    const refreshKalshi = req.query.refresh === 'kalshi' || req.query.refresh === 'all';
    const ibkrOnly = req.query.source === 'ibkr' || req.query.ibkrOnly === 'true';
    let useMock = req.query.mock === 'true' || process.env.PM_USE_MOCK === 'true';
    const fairProbability = req.query.fair_probability
      ? parseFloat(req.query.fair_probability)
      : null;

    let result = await getAggregatedFinancialPredictionEvents({
      refreshKalshi,
      refreshIbkr: false,
      useMock,
      fairProbability,
    });

    if (!result.events.length && !refreshKalshi && process.env.NODE_ENV !== 'production') {
      useMock = true;
      result = await getAggregatedFinancialPredictionEvents({
        refreshKalshi: false,
        refreshIbkr: false,
        useMock: true,
        fairProbability,
      });
    }

    let events = ibkrOnly ? filterIbkrEvents(result.events) : result.events;
    let providers = result.providers;
    if (ibkrOnly && events.length === 0) {
      try {
        const { sidecarRequest } = require('../services/predictionMarketsIngest/providers/ibkrHttp');
        const snapshot = await sidecarRequest('/events', { timeoutMs: 3000 });
        const sidecarEvents = filterIbkrEvents(snapshot.events || []);
        if (sidecarEvents.length > 0) {
          events = sidecarEvents;
          providers = {
            ...(providers || getProviderStatus()),
            ...(snapshot.providers || {}),
          };
          if (providers.ibkr) {
            providers.ibkr = {
              ...providers.ibkr,
              gateway: { ok: providers.ibkr.status === 'connected' },
              cpi_discovery: snapshot.cpi_discovery || providers.ibkr.cpi_discovery,
              cpi_timing: snapshot.timing || providers.ibkr.cpi_timing,
              contracts_total: snapshot.contracts_total ?? providers.ibkr.contracts_total,
              portfolio_seed_count: snapshot.portfolio_seed_count ?? providers.ibkr.portfolio_seed_count,
            };
          }
        }
      } catch (err) {
        console.warn('[PM Ingest] sidecar /events fallback failed:', err.message);
      }
    }
    if (ibkrOnly) {
      const diagnostics = getCpiDiscoveryDiagnostics(req.body, {}, null, events, providers || getProviderStatus());
      providers = attachCpiDiscoveryToProviders(providers || getProviderStatus(), diagnostics);
      providers = withIbkrContractStatus(providers, events, diagnostics);
    }
    const dashboardEvents = events.map((e) => normalizedToDashboardEvent(e));

    res.json({
      ...result,
      events,
      dashboardEvents,
      providers,
    });
  } catch (err) {
    console.error('[PM Ingest] aggregated-events error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/prediction-markets/refresh/ibkr
router.post('/refresh/ibkr', async (req, res) => {
  const startedAt = nowMs();
  try {
    let phaseStartedAt = nowMs();
    let rawEvents = [];
    let ibkrError = null;
    try {
      rawEvents = await fetchIBKREvents({
        fairProbability: req.body?.fair_probability ?? null,
        cpi: req.body?.cpi ?? null,
      });
    } catch (err) {
      ibkrError = err;
      console.warn('[PM Ingest] IBKR refresh unavailable; trying Kalshi CPI fallback:', err.message);
    }
    const sidecarRefreshMs = nowMs() - phaseStartedAt;
    const ibkrEvents = filterIbkrEvents(rawEvents);
    phaseStartedAt = nowMs();
    const kalshiEvents = req.body?.cpi ? await fetchKalshiCpiEvents(req.body.cpi) : [];
    const kalshiRefreshMs = nowMs() - phaseStartedAt;
    const events = mergeCpiSourceEvents(ibkrEvents, kalshiEvents, req.body);
    phaseStartedAt = nowMs();
    const ibkrDiagnostics = await getIbkrCpiPortfolioDiagnostics();
    const portfolioDiagnosticsMs = nowMs() - phaseStartedAt;
    let providers = withIbkrContractStatus(getProviderStatus(), ibkrEvents, ibkrDiagnostics);
    if (ibkrError && providers.ibkr) {
      providers.ibkr = {
        ...providers.ibkr,
        status: 'error',
        message: ibkrError.message,
      };
    }
    const diagnostics = getCpiDiscoveryDiagnostics(req.body, {}, null, events, providers);
    providers = attachCpiDiscoveryToProviders(providers, diagnostics);
    providers = withIbkrContractStatus(providers, ibkrEvents, diagnostics);
    const timing = {
      ...(diagnostics.timing || {}),
      express_total_ms: nowMs() - startedAt,
      express_sidecar_refresh_ms: sidecarRefreshMs,
      express_kalshi_cpi_ms: kalshiRefreshMs,
      express_portfolio_diagnostics_ms: portfolioDiagnosticsMs,
      phase: 'refresh',
    };
    if (providers.ibkr) providers.ibkr = { ...providers.ibkr, cpi_timing: timing };
    persistProviderStatusSnapshot(providers);
    const dashboardEvents = events.map((e) => normalizedToDashboardEvent(e));
    res.json({
      ok: true,
      events,
      reference: {},
      fetched_at: new Date().toISOString(),
      dashboardEvents,
      providers,
      ibkrDiagnostics,
      ...diagnostics,
      timing,
    });
  } catch (err) {
    console.error('[PM Ingest] refresh/ibkr error:', err.message);
    res.status(500).json({
      error: err.message,
      providers: getProviderStatus(),
    });
  }
});

// POST /api/prediction-markets/discover/ibkr
router.post('/discover/ibkr', async (req, res) => {
  const startedAt = nowMs();
  try {
    const { discoverIbkrEventContracts } = require('../services/predictionMarketsIngest/providers/ibkrProvider');
    const phaseStartedAt = nowMs();
    const discovery = await discoverIbkrEventContracts(req.body || {});
    const sidecarDiscoveryMs = nowMs() - phaseStartedAt;
    const ibkrDiagnostics = await getIbkrCpiPortfolioDiagnostics();
    const kalshiStartedAt = nowMs();
    const kalshiEvents = req.body?.cpi ? await fetchKalshiCpiEvents(req.body.cpi) : [];
    const kalshiDiscoveryMs = nowMs() - kalshiStartedAt;
    const events = mergeCpiSourceEvents([], kalshiEvents, req.body);
    const discoveredContractsTotal = Number(
      discovery.contracts_total ??
      discovery.contractsTotal ??
      discovery.cpi_discovery?.contracts_total ??
      discovery.cpi_discovery?.contractsTotal ??
      0
    );
    let providers = withIbkrContractStatus(getProviderStatus(), [], {
      ...ibkrDiagnostics,
      contractsTotal: discoveredContractsTotal,
    });
    const diagnostics = getCpiDiscoveryDiagnostics(req.body, {}, discovery, events, providers);
    providers = attachCpiDiscoveryToProviders(providers, diagnostics);
    providers = withIbkrContractStatus(providers, [], diagnostics);
    const timing = {
      ...(diagnostics.timing || {}),
      express_total_ms: nowMs() - startedAt,
      express_sidecar_discovery_ms: sidecarDiscoveryMs,
      express_kalshi_cpi_ms: kalshiDiscoveryMs,
      phase: 'discovery',
    };
    if (providers.ibkr) providers.ibkr = { ...providers.ibkr, cpi_timing: timing };
    persistProviderStatusSnapshot(providers);
    const dashboardEvents = events.map((e) => normalizedToDashboardEvent(e));
    res.json({
      ok: discovery.ok !== false,
      discovery,
      events,
      reference: {},
      fetched_at: new Date().toISOString(),
      dashboardEvents,
      providers,
      ibkrDiagnostics,
      ...diagnostics,
      timing,
    });
  } catch (err) {
    console.error('[PM Ingest] discover/ibkr error:', err.message);
    res.status(500).json({
      error: err.message,
      providers: getProviderStatus(),
    });
  }
});

// GET /api/prediction-markets/providers/status
router.get('/providers/status', async (req, res) => {
  try {
    const { checkGatewayHealth } = require('../services/predictionMarketsIngest/providers/ibkrProvider');
    const { sidecarRequest } = require('../services/predictionMarketsIngest/providers/ibkrHttp');
    const health = await checkGatewayHealth();
    let ibkrEvents = [];
    let ibkrSnapshot = null;
    let portfolioCpiPositionCount = 0;
    if (health.ok) {
      try {
        ibkrSnapshot = await sidecarRequest('/events', { timeoutMs: 3000 });
        ibkrEvents = filterIbkrEvents(ibkrSnapshot.events || []);
      } catch (err) {
        console.warn('[PM Ingest] sidecar /events status check failed:', err.message);
      }
      try {
        const diagnostics = await getIbkrCpiPortfolioDiagnostics();
        portfolioCpiPositionCount = diagnostics.portfolioCpiPositionCount;
      } catch (err) {
        console.warn('[PM Ingest] sidecar portfolio CPI status check failed:', err.message);
      }
    }
    let providers = getProviderStatus();
    const cachedDiscovery = providers.ibkr?.cpi_discovery || providers.ibkr?.cpiDiscovery || null;
    const snapshotDiscovery = ibkrSnapshot?.cpi_discovery || null;
    const bestDiscovery = pickBestCpiDiscovery(snapshotDiscovery, cachedDiscovery);
    const bestContractsTotal = Math.max(
      Number(ibkrSnapshot?.contracts_total ?? 0),
      Number(providers.ibkr?.contracts_total ?? 0),
      Number(bestDiscovery?.contractsTotal ?? bestDiscovery?.contracts_total ?? 0),
      ibkrEvents.length,
    );
    providers.ibkr = {
      ...providers.ibkr,
      gateway: health,
      ...(bestDiscovery ? { cpi_discovery: bestDiscovery } : {}),
      ...(ibkrSnapshot?.timing ? { cpi_timing: ibkrSnapshot.timing } : {}),
      contracts_total: bestContractsTotal,
      portfolio_seed_count: ibkrSnapshot?.portfolio_seed_count ?? providers.ibkr?.portfolio_seed_count,
    };
    const diagnostics = getCpiDiscoveryDiagnostics({}, {}, null, ibkrEvents, providers);
    providers = attachCpiDiscoveryToProviders(providers, diagnostics);
    res.json({
      providers: withIbkrContractStatus(providers, ibkrEvents, {
        ...diagnostics,
        portfolioCpiPositionCount,
      }),
    });
  } catch (err) {
    console.error('[PM Ingest] providers/status error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router._private = {
  filterIbkrEvents,
  isLiveTradingEvent,
  mergeCpiSourceEvents,
  hasTwoSidedExecutableAsk,
  chooseCpiSourceEvent,
  withIbkrContractStatus,
  getCpiDiscoveryDiagnostics,
  nowMs,
};

module.exports = router;
