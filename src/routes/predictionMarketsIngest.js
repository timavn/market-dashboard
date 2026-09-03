const express = require('express');
const router = express.Router();
const {
  getAggregatedFinancialPredictionEvents,
  fetchIBKREvents,
} = require('../services/predictionMarketsIngest');
const {
  getProviderStatus,
  loadOperationalCatalogByRelease,
  persistCatalogEvents,
  setProviderStatus,
} = require('../services/predictionMarketsIngest/cache');
const { normalizedToDashboardEvent } = require('../services/predictionMarketsIngest/toDashboardEvent');
const { fetchKalshiCpiEvents } = require('../services/predictionMarketsIngest/providers/kalshiProvider');
const {
  getCurrentCpiRelease,
  releaseKeyForEvent,
} = require('../services/predictionMarketsIngest/cpiRelease');
const { loadOfficialCpiFinals } = require('../services/predictionMarketsIngest/cpiOfficial');
const { loadCpiBenchmarks } = require('../services/predictionMarketsIngest/cpiBenchmarkProvider');
const {
  getLastSettledSpxCloseSession,
  getLastSettledWtiSession,
  getPredictionMarketsOverview,
  getPredictionMarketWatchlist,
  getRecentSettledSpxCloseSessions,
  getRecentSettledWtiSessions,
  getSpxCoverSnapshot,
  getSpxCloseWorkbench,
  getWtiWorkbench,
} = require('../services/predictionMarketsIngest/watchlistProvider');
const {
  getOverviewSignalAvailability,
  getRiskRangeHistoryAvailability,
} = require('../services/predictionMarketsIngest/signalAvailabilityProvider');
const {
  getLatestSpxRtaRiskRange,
} = require('../services/predictionMarketsIngest/rtaRiskRangeProvider');
const {
  getCpiCatalogReconcilerStatus,
  reconcileCurrentCpiCatalog,
} = require('../services/predictionMarketsIngest/reconciliationService');
const {
  isAuthoritativeIbkrCpiContract,
} = require('../utils/authoritativeIbkrCpiContract.cjs');

const NON_LIVE_TRADING_FLAGS = new Set([
  'stale_quote',
  'portfolio_seed',
  'portfolio_discovered',
  'catalog_missing',
  'mock',
  'fallback',
  'no_live_quote',
  'cached',
  'expired_contract',
  'wrong_release',
  'unknown_contract_side',
]);
const IBKR_CATALOG_VENUES = Object.freeze(['IBKR', 'ForecastEx', 'CME']);

function nowMs() {
  return Date.now();
}

async function loadCurrentIbkrCatalog(release = {}) {
  return loadOperationalCatalogByRelease(release.releaseKey, {
    venues: IBKR_CATALOG_VENUES,
    requireCurrent: true,
  });
}

async function persistCurrentVenueCatalog(events = [], release = {}, {
    venues,
    source,
    promoteCurrent = false,
  } = {}) {
  const currentEvents = (events || []).filter((event) => eventMatchesRelease(event, release));
  if (!currentEvents.length) {
    return { atomic: false, contracts: 0, skipped: true };
  }
  return persistCatalogEvents(currentEvents, {
    releaseKey: release.releaseKey,
    venues,
    source,
    promoteCurrent,
  });
}

function isPortfolioDiscoveredEvent(event = {}) {
  return [
    ...(event.data_quality_flags || []),
    ...(event.flags || []),
  ].includes('portfolio_discovered');
}

function nonLiveFlagsForEvent(event = {}) {
  return event.data_quality_flags || [];
}

function eventDeadlineMs(event = {}) {
  const raw = event.close_time || event.expiration_time || '';
  const compact = String(raw).match(/^(\d{4})(\d{2})(\d{2})/);
  const timestamp = compact
    ? Date.parse(`${compact[1]}-${compact[2]}-${compact[3]}T23:59:59Z`)
    : Date.parse(raw);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function isLiveTradingEvent(event, now = new Date()) {
  if (!event || event.source_api === 'IBKR_PORTFOLIO' || event.heldPosition) return false;
  if (nonLiveFlagsForEvent(event).some((flag) => NON_LIVE_TRADING_FLAGS.has(flag))) return false;
  const status = String(event.status || 'open').toLowerCase();
  if (!['open', 'active'].includes(status)) return false;
  const expiresAt = eventDeadlineMs(event);
  const observedAt = new Date(now).getTime();
  if (!Number.isFinite(observedAt)) return false;
  if (expiresAt != null && expiresAt <= observedAt) return false;
  return true;
}

function filterIbkrEvents(events = [], {
  now = new Date(),
  maxAgeSeconds = 120,
  releaseKey = null,
} = {}) {
  return (events || [])
    .filter((event) => isAuthoritativeIbkrCpiContract(event, {
      now,
      maxAgeSeconds,
      releaseKey,
    }));
}

function strikeTick(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 10) : null;
}

function tickToStrike(tick) {
  return Number((tick / 10).toFixed(1));
}

const CPI_MONTH_CODES = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const CPI_REQUEST_MONTH_MISMATCH = '__cpi_month_mismatch__';

function normalizeCpiMonthId(value) {
  const text = String(value?.id || value || '').trim().toUpperCase();
  if (!text) return null;

  const iso = text.match(/(?:^|#)(20\d{2})-(0[1-9]|1[0-2])$/);
  if (iso) return `${iso[1]}-${iso[2]}`;

  const toMonthId = (yearValue, monthValue) => {
    let year = Number(yearValue);
    if (Number.isInteger(year) && year >= 0 && year <= 99) year += 2000;
    const month = CPI_MONTH_CODES.indexOf(String(monthValue || '').slice(0, 3).toUpperCase());
    if (!Number.isInteger(year) || year < 2000 || year > 2099 || month < 0) return null;
    return `${year}-${String(month + 1).padStart(2, '0')}`;
  };

  const ticker = text.match(/(?:^|[-_\s])(\d{2}|20\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(?:[-_\s]|$)/);
  if (ticker) return toMonthId(ticker[1], ticker[2]);

  const monthThenYear = text.match(/\b(JAN(?:UARY)?|FEB(?:RUARY)?|MAR(?:CH)?|APR(?:IL)?|MAY|JUN(?:E)?|JUL(?:Y)?|AUG(?:UST)?|SEP(?:TEMBER)?|OCT(?:OBER)?|NOV(?:EMBER)?|DEC(?:EMBER)?)\b\D{0,6}(\d{2}|20\d{2})\b/);
  if (monthThenYear) return toMonthId(monthThenYear[2], monthThenYear[1]);

  const yearThenMonth = text.match(/\b(\d{2}|20\d{2})\b\D{0,6}(JAN(?:UARY)?|FEB(?:RUARY)?|MAR(?:CH)?|APR(?:IL)?|MAY|JUN(?:E)?|JUL(?:Y)?|AUG(?:UST)?|SEP(?:TEMBER)?|OCT(?:OBER)?|NOV(?:EMBER)?|DEC(?:EMBER)?)\b/);
  return yearThenMonth ? toMonthId(yearThenMonth[1], yearThenMonth[2]) : null;
}

function cpiMonthIdsForEvent(event = {}) {
  return [...new Set([
    event.releaseKey,
    event.release_key,
    event.reportMonthId,
    event.forecastMonth,
    event.forecast_month,
    event.reportMonth,
    event.report_month,
    event.releaseMonth,
    event.release_month,
    event.sourceMonth,
    event.source_month,
    event.eventMonth,
    event.event_month,
    event.releaseCode,
    event.release_code,
    event.event_ticker,
    event.eventTicker,
    event.api_raw_symbol,
    event.localSymbol,
    event.event_title,
    event.eventTitle,
    event.contract_title,
    event.question,
    event.description,
    event.ticker,
    event.symbol,
  ].map(normalizeCpiMonthId).filter(Boolean))];
}

function cpiMonthIdForEvent(event = {}) {
  const monthIds = cpiMonthIdsForEvent(event);
  return monthIds.length === 1 ? monthIds[0] : null;
}

function cpiMonthIdForRequest(body = {}) {
  const cpi = body?.cpi || {};
  const monthIds = [...new Set([
    cpi.releaseKey,
    cpi.reportMonthId,
    cpi.forecastMonth,
    cpi.reportMonth,
    cpi.releaseMonth,
    cpi.sourceMonth,
    cpi.eventMonth,
    cpi.releaseCode,
  ].map(normalizeCpiMonthId).filter(Boolean))];
  if (monthIds.length > 1) return CPI_REQUEST_MONTH_MISMATCH;
  return monthIds[0] || null;
}

function isEventForRequestedCpiMonth(event = {}, body = {}) {
  const requestedMonth = cpiMonthIdForRequest(body);
  return !requestedMonth || cpiMonthIdForEvent(event) === requestedMonth;
}

function resolveOperationalCpiBody(body = {}, currentRelease = {}) {
  const cpi = currentRelease.cpi || currentRelease.request?.cpi;
  if (!currentRelease.releaseKey || !cpi) {
    const error = new Error('The server could not resolve the current CPI release.');
    error.code = 'CPI_RELEASE_UNAVAILABLE';
    throw error;
  }
  const requestedMonth = cpiMonthIdForRequest(body);
  const currentMonth = normalizeCpiMonthId(currentRelease.reportMonth || cpi.reportMonthId || cpi.reportMonth);
  return {
    body: {
      ...(body?.fair_probability != null ? { fair_probability: body.fair_probability } : {}),
      cpi: { ...cpi, releaseKey: currentRelease.releaseKey },
    },
    requestedMonth: requestedMonth === CPI_REQUEST_MONTH_MISMATCH ? null : requestedMonth,
    currentMonth,
    ignoredHistoricalRequest: Boolean(requestedMonth && requestedMonth !== CPI_REQUEST_MONTH_MISMATCH && requestedMonth !== currentMonth),
  };
}

function eventMatchesRelease(event = {}, release = {}) {
  return Boolean(release?.releaseKey && releaseKeyForEvent(event) === release.releaseKey);
}

function hasNativeExecutableBook(event = {}) {
  const finite = (value) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
  const yesBook = finite(event.yes_bid) && finite(event.yes_ask);
  const noBook = finite(event.no_bid) && finite(event.no_ask);
  return yesBook || noBook;
}

function isFreshQuote(event = {}, now = new Date(), maxAgeSeconds = 120) {
  const timestamp = Date.parse(event.updated_at || event.fetched_at || '');
  if (!Number.isFinite(timestamp)) return false;
  const ageSeconds = (new Date(now).getTime() - timestamp) / 1000;
  return ageSeconds >= -5 && ageSeconds <= maxAgeSeconds;
}

function normalizeCatalogErrorCode(error, fallback = 'PREDICTION_CATALOG_UNAVAILABLE') {
  const code = String(error?.code || error?.errorCode || '');
  const message = String(error?.message || error || '');
  if (/access.?denied|not authorized/i.test(`${code} ${message}`)) {
    return 'PREDICTION_CATALOG_ACCESS_DENIED';
  }
  return code || fallback;
}

function buildCpiReadiness({
  release,
  events = [],
  now = new Date(),
  maxAgeSeconds = 120,
  providerErrorCode = null,
  displayErrorCode = null,
} = {}) {
  const currentLive = events.filter((event) => (
    eventMatchesRelease(event, release)
    && isLiveTradingEvent(event, now)
    && isFreshQuote(event, now, maxAgeSeconds)
    && hasNativeExecutableBook(event)
  ));
  const displayEvents = currentLive.filter((event) => (
    (event.source_api === 'kalshi_trade_api_v2' && event.venue === 'Kalshi')
    || isAuthoritativeIbkrCpiContract(event, {
      releaseKey: release?.releaseKey || null,
      now,
      maxAgeSeconds,
    })
  ));
  const executionEvents = currentLive.filter((event) => isAuthoritativeIbkrCpiContract(event, {
    releaseKey: release?.releaseKey || null,
    now,
    maxAgeSeconds,
  }));
  return {
    releaseKey: release?.releaseKey || null,
    display: {
      ready: displayEvents.length > 0,
      liveContracts: displayEvents.length,
      venues: [...new Set(displayEvents.map((event) => event.venue).filter(Boolean))],
      errorCode: displayEvents.length
        ? null
        : displayErrorCode || 'NO_CURRENT_NATIVE_LIVE_QUOTE',
      reason: displayEvents.length ? null : 'No current-release native live quote is available from an approved venue.',
    },
    ibkrExecution: {
      ready: executionEvents.length > 0,
      liveContracts: executionEvents.length,
      errorCode: executionEvents.length
        ? null
        : providerErrorCode || 'NO_CURRENT_EXECUTABLE_IBKR_CONTRACT',
      reason: executionEvents.length ? null : 'No current-release IBKR contract has a native live executable book.',
    },
  };
}

function applyCpiReadinessToProviders(providers = {}, readiness = {}, release = {}) {
  const next = { ...providers };
  const currentKey = release.releaseKey || readiness.releaseKey || null;
  if (next.kalshi) {
    next.kalshi = {
      ...next.kalshi,
      releaseKey: currentKey,
      display_ready: readiness.display?.ready === true && readiness.display.venues?.includes('Kalshi'),
    };
  }
  if (next.ibkr) {
    next.ibkr = {
      ...next.ibkr,
      releaseKey: currentKey,
      gateway_connected: next.ibkr?.gateway?.ok === true || next.ibkr?.status === 'connected',
      execution_ready: readiness.ibkrExecution?.ready === true,
      errorCode: readiness.ibkrExecution?.ready
        ? null
        : next.ibkr?.errorCode || readiness.ibkrExecution?.errorCode || null,
    };
  }
  return next;
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
  const byMonthAndTick = new Map();
  const extras = [];

  for (const event of [...ibkrEvents, ...kalshiEvents]) {
    if (!isEventForRequestedCpiMonth(event, body)) continue;
    const tick = eventStrikeTick(event);
    if (tick == null || (targetTicks.size > 0 && !targetTicks.has(tick))) {
      if (targetTicks.size === 0) extras.push(event);
      continue;
    }
    const monthId = cpiMonthIdForEvent(event) || 'unknown';
    const key = `${monthId}:${tick}`;
    byMonthAndTick.set(key, chooseCpiSourceEvent(byMonthAndTick.get(key), event));
  }

  const orderedEvents = [...byMonthAndTick.values()].sort((a, b) => {
    const tickDelta = (eventStrikeTick(a) ?? Infinity) - (eventStrikeTick(b) ?? Infinity);
    if (tickDelta !== 0) return tickDelta;
    return String(cpiMonthIdForEvent(a) || '').localeCompare(String(cpiMonthIdForEvent(b) || ''));
  });
  return [
    ...orderedEvents,
    ...extras,
  ];
}

function sourceFoundStrikes(events = [], body = {}) {
  const targetTicks = new Set((body?.cpi?.targetStrikes || []).map(strikeTick).filter((tick) => tick != null));
  const foundTicks = new Set();
  for (const event of events) {
    if (!isEventForRequestedCpiMonth(event, body)) continue;
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
  const hasEmptyCatalogStatus = ['connected', 'connected_no_contracts', 'connected_catalog_incomplete'].includes(status);
  const catalogHealth = getCpiCatalogHealth(next, ibkrEvents, diagnostics);
  const hasDiscoveredContracts = catalogHealth.contractsTotal > 0;
  if (hasEmptyCatalogStatus && hasDiscoveredContracts && catalogHealth.degraded) {
    const missingSuffix = catalogHealth.missingStrikes.length
      ? `; missing strikes ${formatCpiStrikeList(catalogHealth.missingStrikes)}`
      : '';
    const degraded = {
      status: 'connected_catalog_incomplete',
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
      message: 'IBKR connected; no authoritative current-release event contracts discovered',
      last_success_at: next.ibkr.last_success_at,
      portfolio_cpi_positions: catalogHealth.portfolioCpiPositionCount,
      execution_ready: false,
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
    const live = await sidecarRequest('/portfolio/live-positions', { timeoutMs: 4000 });
    if (live?.ok !== true || live?.source !== 'ibkr_live_session') {
      throw new Error(live?.message || 'IBKR live-session positions could not be verified.');
    }
    const positions = Array.isArray(live.positions) ? live.positions : [];
    const accounts = Array.isArray(live.accounts) ? live.accounts : [];
    diagnostics.managedAccounts = accounts;
    diagnostics.portfolioCpiPositionCount = positions.filter(isCpiPortfolioPosition).length;
    diagnostics.source = live.source;
    diagnostics.observedAt = live.observed_at || null;
    diagnostics.accounts = accounts.map((account) => {
      const rows = positions.filter((position) => position.account === account);
      return {
        account,
        positions: rows.length,
        cpiPositions: rows.filter(isCpiPortfolioPosition).length,
        observedAt: live.observed_at || null,
      };
    });
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
  const requestedMonth = cpiMonthIdForRequest(body);
  const discoveryMonth = cpiMonthIdForRequest({ cpi: cpiDiscovery || {} });
  const providerDiscoveryIsCurrent = !requestedMonth
    || (discoveryMonth && discoveryMonth !== CPI_REQUEST_MONTH_MISMATCH && discoveryMonth === requestedMonth);
  const providerFoundStrikes = providerDiscoveryIsCurrent ? (cpiDiscovery?.foundStrikes || []) : [];
  const ibkrSourceEvents = events.filter((event) => !isKalshiCpiEvent(event));
  const kalshiSourceEvents = events.filter(isKalshiCpiEvent);
  const eventIbkrFoundStrikes = sourceFoundStrikes(ibkrSourceEvents, body);
  const ibkrFoundStrikes = eventIbkrFoundStrikes.length ? eventIbkrFoundStrikes : providerFoundStrikes;
  const kalshiFoundStrikes = sourceFoundStrikes(kalshiSourceEvents, body);
  const foundTickSet = new Set([
    ...providerFoundStrikes,
    ...ibkrFoundStrikes,
    ...kalshiFoundStrikes,
  ].map(strikeTick).filter((tick) => tick != null));
  const foundStrikes = [...foundTickSet].sort((a, b) => a - b).map(tickToStrike);
  const missingStrikes = targetStrikes.filter((strike) => !foundTickSet.has(strikeTick(strike)));
  const ibkrTickSet = new Set(ibkrFoundStrikes.map(strikeTick).filter((tick) => tick != null));
  const kalshiTickSet = new Set(kalshiFoundStrikes.map(strikeTick).filter((tick) => tick != null));
  const ibkrMissingStrikes = targetStrikes.filter((strike) => !ibkrTickSet.has(strikeTick(strike)));
  const kalshiMissingStrikes = targetStrikes.filter((strike) => !kalshiTickSet.has(strikeTick(strike)));
  const contractsAdded = discovery?.contracts_added ?? result?.contracts_added ?? provider?.contracts_added ?? 0;
  const contractsTotal = Math.max(
    ibkrSourceEvents.length,
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
    releaseKey: body?.cpi?.releaseKey || cpiDiscovery?.releaseKey || null,
    venueCoverage: {
      ibkr: {
        foundStrikes: ibkrFoundStrikes,
        missingStrikes: ibkrMissingStrikes,
        contractsTotal,
      },
      kalshi: {
        foundStrikes: kalshiFoundStrikes,
        missingStrikes: kalshiMissingStrikes,
        contractsTotal: kalshiSourceEvents.length,
      },
      display: {
        foundStrikes,
        missingStrikes,
        contractsTotal: events.length,
      },
    },
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
  const shared = {
    ...(diagnostics.cpi_discovery || {}),
    releaseKey: diagnostics.releaseKey,
    targetStrikes: diagnostics.targetStrikes,
    ibkrFoundStrikes: diagnostics.ibkrFoundStrikes,
    kalshiFoundStrikes: diagnostics.kalshiFoundStrikes,
    contractsAdded: diagnostics.contractsAdded,
    contracts_added: diagnostics.contractsAdded,
  };
  const next = { ...providers };
  if (next.ibkr) {
    const coverage = diagnostics.venueCoverage?.ibkr || {};
    next.ibkr = {
      ...next.ibkr,
      cpi_discovery: {
        ...shared,
        ...coverage,
        contracts_total: coverage.contractsTotal ?? diagnostics.contractsTotal,
      },
    };
  }
  if (next.kalshi) {
    const coverage = diagnostics.venueCoverage?.kalshi || {};
    next.kalshi = {
      ...next.kalshi,
      cpi_discovery: {
        ...shared,
        ...coverage,
        contracts_total: coverage.contractsTotal ?? 0,
      },
    };
  }
  return next;
}

function persistProviderStatusSnapshot(providers = {}) {
  ['ibkr', 'forecastex', 'cme', 'kalshi'].forEach((provider) => {
    if (providers?.[provider]) {
      setProviderStatus(provider, providers[provider]);
    }
  });
}

// GET /api/prediction-markets/cpi/current
// The server owns this release identity. Historical UI selection is never an
// input to this endpoint and cannot roll the operational catalog backward.
router.get('/cpi/current', async (_req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const release = await getCurrentCpiRelease();
    const body = release.request;
    const [kalshiResult, catalogResult] = await Promise.allSettled([
      fetchKalshiCpiEvents(release.cpi),
      loadCurrentIbkrCatalog(release),
    ]);
    const kalshiEventsRaw = kalshiResult.status === 'fulfilled' ? kalshiResult.value : [];
    let ibkrEventsRaw = [];
    if (catalogResult.status === 'fulfilled') {
      ibkrEventsRaw = await fetchIBKREvents({
        cpi: release.cpi,
        catalogContracts: catalogResult.value,
      });
    } else {
      setProviderStatus('ibkr', {
        status: 'catalog_unavailable',
        errorCode: normalizeCatalogErrorCode(catalogResult.reason),
        message: catalogResult.reason?.message || 'The active V2 prediction catalog is unavailable.',
      });
    }
    // This readiness/read endpoint is deliberately catalog-read-only. Live
    // Kalshi rows remain in this response only; catalog promotion belongs to
    // the explicit refresh/discovery reconciliation paths below.
    const kalshiEvents = (kalshiEventsRaw || []).filter((event) => (
      eventMatchesRelease(event, release)
      && isLiveTradingEvent(event)
      && isFreshQuote(event)
    ));
    const ibkrEvents = filterIbkrEvents(ibkrEventsRaw || [], { releaseKey: release.releaseKey });

    const sourceEvents = [...ibkrEvents, ...kalshiEvents];
    const events = mergeCpiSourceEvents(ibkrEvents, kalshiEvents, body);
    let providers = getProviderStatus();
    const diagnostics = getCpiDiscoveryDiagnostics(body, {}, null, sourceEvents, providers);
    providers = attachCpiDiscoveryToProviders(providers, diagnostics);
    providers = withIbkrContractStatus(providers, ibkrEvents, {
      ...diagnostics,
      contractsTotal: diagnostics.venueCoverage?.ibkr?.contractsTotal ?? ibkrEvents.length,
      missingStrikes: diagnostics.venueCoverage?.ibkr?.missingStrikes || diagnostics.targetStrikes,
    });
    const readiness = buildCpiReadiness({
      release,
      events: sourceEvents,
      providerErrorCode: providers?.ibkr?.errorCode || null,
      displayErrorCode: providers?.kalshi?.errorCode || null,
    });
    providers = applyCpiReadinessToProviders(providers, readiness, release);
    persistProviderStatusSnapshot(providers);

    res.json({
      ...release,
      events,
      providerEvents: sourceEvents,
      dashboardEvents: events.map((event) => normalizedToDashboardEvent(event)),
      providers,
      readiness,
      cpi_discovery: {
        releaseKey: release.releaseKey,
        targetStrikes: diagnostics.targetStrikes,
        foundStrikes: diagnostics.foundStrikes,
        missingStrikes: diagnostics.missingStrikes,
        venueCoverage: diagnostics.venueCoverage,
      },
      fetched_at: new Date().toISOString(),
    });
  } catch (error) {
    const unavailable = String(error.code || '').startsWith('CPI_RELEASE_');
    console.error('[PM Ingest] current CPI release error:', error.message);
    res.status(unavailable ? 503 : 500).json({
      ok: false,
      code: error.code || 'CPI_CURRENT_ERROR',
      error: error.message,
      events: [],
      dashboardEvents: [],
      readiness: {
        display: { ready: false, liveContracts: 0, venues: [], reason: error.message },
        ibkrExecution: { ready: false, liveContracts: 0, reason: error.message },
      },
    });
  }
});

// GET /api/prediction-markets/cpi/finals
// Historical headline CPI is sourced from the official BLS CPI-U index. It is
// separate from the live contract endpoint so an unavailable BLS request can
// never make a stale or inferred market quote executable.
router.get('/cpi/finals', async (_req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    return res.json(await loadOfficialCpiFinals());
  } catch (error) {
    console.error('[PM Ingest] official CPI finals error:', error.message);
    return res.status(502).json({
      ok: false,
      source: 'bls_official',
      finals: [],
      error: error.message || 'Official CPI finals are unavailable.',
    });
  }
});

// GET /api/prediction-markets/cpi/benchmarks?month=YYYY-MM
// Research forecasts are isolated by provider. A failed source stays visible as
// unavailable and can never be replaced by an inferred or expired value.
router.get('/cpi/benchmarks', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const month = String(req.query.month || '').trim();
  if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month)) {
    return res.status(400).json({
      ok: false,
      code: 'CPI_BENCHMARK_MONTH_INVALID',
      error: 'CPI benchmark month must use YYYY-MM.',
      sources: [],
    });
  }
  try {
    return res.json(await loadCpiBenchmarks({ month }));
  } catch (error) {
    console.error('[PM Ingest] CPI benchmark error:', error.message);
    return res.status(error.code === 'CPI_BENCHMARK_MONTH_INVALID' ? 400 : 502).json({
      ok: false,
      code: error.code || 'CPI_BENCHMARKS_UNAVAILABLE',
      error: error.message || 'CPI forecast benchmarks are unavailable.',
      period: month,
      metric: 'headline-cpi-yoy',
      unit: 'percent',
      sources: [],
    });
  }
});

// GET /api/prediction-markets/aggregated-events
router.get('/aggregated-events', async (req, res) => {
  try {
    const refreshKalshi = req.query.refresh === 'kalshi' || req.query.refresh === 'all';
    const ibkrOnly = req.query.source === 'ibkr' || req.query.ibkrOnly === 'true';
    const fairProbability = req.query.fair_probability
      ? parseFloat(req.query.fair_probability)
      : null;

    const result = await getAggregatedFinancialPredictionEvents({
      refreshKalshi,
      refreshIbkr: false,
      fairProbability,
    });

    let events = result.events;
    let providers = result.providers;
    let ibkrOperationalBody = {};
    if (ibkrOnly) {
      try {
        const currentRelease = await getCurrentCpiRelease();
        ibkrOperationalBody = currentRelease.request;
        const catalogContracts = await loadCurrentIbkrCatalog(currentRelease);
        events = filterIbkrEvents(await fetchIBKREvents({
          cpi: currentRelease.cpi,
          catalogContracts,
        }), {
          releaseKey: currentRelease.releaseKey,
        });
        providers = getProviderStatus();
      } catch (err) {
        console.warn('[PM Ingest] live IBKR aggregate refresh failed:', err.message);
        events = [];
        setProviderStatus('ibkr', {
          status: 'catalog_unavailable',
          errorCode: err.code || 'CATALOG_UNAVAILABLE',
          message: err.message,
        });
        providers = getProviderStatus();
      }
    }
    if (ibkrOnly) {
      const diagnostics = getCpiDiscoveryDiagnostics(ibkrOperationalBody, {}, null, events, providers || getProviderStatus());
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

// GET /api/prediction-markets/watchlist
// This endpoint never falls back to cache, mock data, portfolio seeds, or inferred quotes.
router.get('/watchlist', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const forceRefresh = String(req.query?.forceRefresh || '').toLowerCase() === 'true';
    const result = await getPredictionMarketWatchlist({
      forceRefresh,
      retryMissing: forceRefresh,
    });
    res.json(result);
  } catch (err) {
    console.error('[PM Ingest] watchlist error:', err.message);
    res.status(err.code === 'VENUE_UNAVAILABLE' ? 503 : 500).json({
      ok: false,
      error: err.message,
      rows: [],
    });
  }
});

// GET /api/prediction-markets/overview/spx
// Keep the SPX chart request independent from WTI/CPI history workloads.
router.get('/overview/spx', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const result = await getPredictionMarketsOverview({
      marketKeys: ['spx'],
      getSignalAvailability: getOverviewSignalAvailability,
      getRiskRangeHistory: getRiskRangeHistoryAvailability,
      getSpxRtaRiskRange: getLatestSpxRtaRiskRange,
    });
    res.json({
      ok: result.ok,
      fetchedAt: result.fetchedAt,
      market: result.markets.spx,
      policy: result.policy,
    });
  } catch (err) {
    console.error('[PM Ingest] SPX overview error:', err.message);
    res.status(500).json({
      ok: false,
      code: 'SPX_OVERVIEW_ERROR',
      error: err.message,
      market: { status: 'unavailable', summary: null },
    });
  }
});

// GET /api/prediction-markets/overview
// Each market is isolated so one unavailable provider or contract never blanks the hub.
router.get('/overview', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const excludeSpx = String(req.query.excludeSpx || '').toLowerCase() === 'true';
    const result = await getPredictionMarketsOverview({
      marketKeys: excludeSpx ? ['cpi', 'wtiDaily', 'wtiWeekly'] : undefined,
      getSignalAvailability: getOverviewSignalAvailability,
      getRiskRangeHistory: getRiskRangeHistoryAvailability,
      getSpxRtaRiskRange: getLatestSpxRtaRiskRange,
    });
    res.json(result);
  } catch (err) {
    console.error('[PM Ingest] overview error:', err.message);
    res.status(500).json({
      ok: false,
      code: 'PREDICTION_MARKETS_OVERVIEW_ERROR',
      error: err.message,
      markets: {
        cpi: { status: 'unavailable', summary: null },
        spx: { status: 'unavailable', summary: null },
        wti: {
          daily: { status: 'unavailable', summary: null },
          weekly: { status: 'unavailable', summary: null },
        },
      },
    });
  }
});

// GET /api/prediction-markets/wti?cadence=daily|weekly
// Direct, no-store Kalshi venue books. Never marks Kalshi prices as IBKR executable.
router.get('/wti', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const result = await getWtiWorkbench({ cadence: req.query.cadence });
    res.json(result);
  } catch (err) {
    console.error('[PM Ingest] WTI workbench error:', err.message);
    const invalid = err.code === 'WTI_INVALID_CADENCE';
    const unavailable = ['WTI_EVENT_UNAVAILABLE', 'WTI_GEOMETRY_UNAVAILABLE', 'WTI_BOOK_UNAVAILABLE'].includes(err.code);
    res.status(invalid ? 400 : (unavailable ? 503 : 500)).json({
      ok: false,
      code: err.code || 'WTI_LIVE_UNAVAILABLE',
      error: err.message,
      cadence: ['daily', 'weekly'].includes(String(req.query.cadence || '').toLowerCase())
        ? String(req.query.cadence).toLowerCase()
        : null,
      markets: [],
      historicalOnly: false,
      executable: false,
    });
  }
});

// GET /api/prediction-markets/wti/last-settled?cadence=daily|weekly
// Historical outcomes only. This endpoint exposes no live or terminal quote fields.
router.get('/wti/last-settled', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const result = await getLastSettledWtiSession({ cadence: req.query.cadence });
    res.json(result);
  } catch (err) {
    console.error('[PM Ingest] WTI history error:', err.message);
    const invalid = err.code === 'WTI_INVALID_CADENCE';
    res.status(invalid ? 400 : (err.code === 'WTI_HISTORY_UNAVAILABLE' ? 503 : 500)).json({
      ok: false,
      code: err.code || 'WTI_HISTORY_ERROR',
      error: err.message,
      historicalOnly: true,
      executable: false,
      markets: [],
    });
  }
});

// GET /api/prediction-markets/wti/recent-settled?cadence=daily|weekly&limit=13
// Compact, fully verified settled sessions with quote fields stripped.
router.get('/wti/recent-settled', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const result = await getRecentSettledWtiSessions({
      cadence: req.query.cadence,
      limit: req.query.limit,
    });
    res.json(result);
  } catch (err) {
    console.error('[PM Ingest] WTI recent history error:', err.message);
    const invalid = err.code === 'WTI_INVALID_CADENCE';
    res.status(invalid ? 400 : (err.code === 'WTI_HISTORY_UNAVAILABLE' ? 503 : 500)).json({
      ok: false,
      code: err.code || 'WTI_HISTORY_ERROR',
      error: err.message,
      historicalOnly: true,
      executable: false,
      sessions: [],
    });
  }
});

// GET /api/prediction-markets/spx-close
// Dedicated live, no-store snapshot for the direct 4 p.m. cash S&P ladder.
router.get('/spx-close', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const result = await getSpxCloseWorkbench();
    res.json(result);
  } catch (err) {
    console.error('[PM Ingest] SPX close workbench error:', err.message);
    const unavailable = ['SPX_EVENT_UNAVAILABLE', 'SPX_BOOK_UNAVAILABLE'].includes(err.code);
    res.status(unavailable ? 503 : 500).json({
      ok: false,
      code: err.code || 'SPX_LIVE_UNAVAILABLE',
      error: err.message,
      markets: [],
    });
  }
});

// GET /api/prediction-markets/spx-close/cover
// Canonical compact-cover ladder. This response is either a verified direct
// Kalshi ladder or an explicitly historical closing quote snapshot; it never
// returns settled outcome rows.
router.get('/spx-close/cover', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const result = await getSpxCoverSnapshot();
    res.json(result);
  } catch (err) {
    console.error('[PM Ingest] SPX cover error:', err.message);
    res.status(503).json({
      ok: false,
      mode: 'unavailable',
      code: err.code || 'SPX_COVER_UNAVAILABLE',
      error: err.message,
      executable: false,
      markets: [],
    });
  }
});

// GET /api/prediction-markets/spx-close/last-settled
// Historical outcomes only. This endpoint never returns executable quotes.
router.get('/spx-close/last-settled', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const result = await getLastSettledSpxCloseSession();
    res.json(result);
  } catch (err) {
    console.error('[PM Ingest] SPX close history error:', err.message);
    res.status(err.code === 'SPX_HISTORY_UNAVAILABLE' ? 503 : 500).json({
      ok: false,
      code: err.code || 'SPX_HISTORY_ERROR',
      error: err.message,
      markets: [],
    });
  }
});

// GET /api/prediction-markets/spx-close/recent-settled?limit=13
// Compact, fully verified historical outcomes only. No quote or execution fields are exposed.
router.get('/spx-close/recent-settled', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const result = await getRecentSettledSpxCloseSessions({ limit: req.query.limit });
    res.json(result);
  } catch (err) {
    console.error('[PM Ingest] SPX recent settled history error:', err.message);
    res.status(err.code === 'SPX_HISTORY_UNAVAILABLE' ? 503 : 500).json({
      ok: false,
      code: err.code || 'SPX_HISTORY_ERROR',
      error: err.message,
      historicalOnly: true,
      executable: false,
      sessions: [],
    });
  }
});

// POST /api/prediction-markets/refresh/ibkr
router.post('/refresh/ibkr', async (req, res) => {
  const startedAt = nowMs();
  try {
    const currentRelease = await getCurrentCpiRelease();
    const operational = resolveOperationalCpiBody(req.body || {}, currentRelease);
    const requestBody = operational.body;
    let phaseStartedAt = nowMs();
    let rawEvents = [];
    let ibkrError = null;
    try {
      const catalogContracts = await loadCurrentIbkrCatalog(currentRelease);
      rawEvents = await fetchIBKREvents({
        fairProbability: requestBody.fair_probability ?? null,
        cpi: requestBody.cpi,
        catalogContracts,
      });
    } catch (err) {
      ibkrError = err;
      console.warn('[PM Ingest] IBKR refresh unavailable; trying Kalshi CPI fallback:', err.message);
    }
    const sidecarRefreshMs = nowMs() - phaseStartedAt;
    const ibkrEvents = filterIbkrEvents(rawEvents, { releaseKey: currentRelease.releaseKey });
    phaseStartedAt = nowMs();
    let kalshiEvents = await fetchKalshiCpiEvents(requestBody.cpi);
    if (kalshiEvents.length) {
      try {
        await persistCurrentVenueCatalog(kalshiEvents, currentRelease, {
          venues: ['Kalshi'],
          source: 'kalshi-native-current-release',
          promoteCurrent: true,
        });
      } catch (error) {
        setProviderStatus('kalshi', {
          status: 'catalog_persistence_error',
          errorCode: normalizeCatalogErrorCode(error, 'CATALOG_PERSISTENCE_FAILED'),
          message: error.message,
        });
        kalshiEvents = [];
      }
    }
    const kalshiRefreshMs = nowMs() - phaseStartedAt;
    const sourceEvents = [...ibkrEvents, ...kalshiEvents];
    const events = mergeCpiSourceEvents(ibkrEvents, kalshiEvents, requestBody);
    phaseStartedAt = nowMs();
    const ibkrDiagnostics = await getIbkrCpiPortfolioDiagnostics();
    const portfolioDiagnosticsMs = nowMs() - phaseStartedAt;
    let providers = withIbkrContractStatus(getProviderStatus(), ibkrEvents, ibkrDiagnostics);
    if (ibkrError && providers.ibkr) {
      providers.ibkr = {
        ...providers.ibkr,
        status: 'error',
        errorCode: normalizeCatalogErrorCode(ibkrError, 'IBKR_REFRESH_UNAVAILABLE'),
        message: ibkrError.message,
      };
    }
    const diagnostics = getCpiDiscoveryDiagnostics(requestBody, {}, null, sourceEvents, providers);
    providers = attachCpiDiscoveryToProviders(providers, diagnostics);
    providers = withIbkrContractStatus(providers, ibkrEvents, {
      ...diagnostics,
      contractsTotal: diagnostics.venueCoverage?.ibkr?.contractsTotal ?? ibkrEvents.length,
      missingStrikes: diagnostics.venueCoverage?.ibkr?.missingStrikes || diagnostics.targetStrikes,
    });
    const readiness = buildCpiReadiness({
      release: currentRelease,
      events: sourceEvents,
      providerErrorCode: providers?.ibkr?.errorCode || null,
      displayErrorCode: providers?.kalshi?.errorCode || null,
    });
    providers = applyCpiReadinessToProviders(providers, readiness, currentRelease);
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
      errorCode: readiness.ibkrExecution?.ready
        ? null
        : providers?.ibkr?.errorCode || readiness.ibkrExecution?.errorCode || null,
      events,
      providerEvents: sourceEvents,
      reference: {},
      fetched_at: new Date().toISOString(),
      dashboardEvents,
      providers,
      currentRelease,
      operationalContext: {
        releaseKey: currentRelease.releaseKey,
        ignoredHistoricalRequest: operational.ignoredHistoricalRequest,
        requestedMonth: operational.requestedMonth,
        currentMonth: operational.currentMonth,
      },
      readiness,
      ibkrDiagnostics,
      ...diagnostics,
      timing,
    });
  } catch (err) {
    console.error('[PM Ingest] refresh/ibkr error:', err.message);
    res.status(String(err.code || '').startsWith('CPI_RELEASE_') ? 503 : 500).json({
      error: err.message,
      providers: getProviderStatus(),
    });
  }
});

// POST /api/prediction-markets/discover/ibkr
router.post('/discover/ibkr', async (req, res) => {
  const startedAt = nowMs();
  try {
    const reconciliationResult = await reconcileCurrentCpiCatalog({
      trigger: 'manual',
      requestedBody: req.body || {},
    });
    const currentRelease = reconciliationResult.currentRelease;
    if (!currentRelease) {
      const error = new Error(reconciliationResult.outcome?.message || 'The current CPI release is unavailable.');
      error.code = reconciliationResult.outcome?.code || 'CPI_RELEASE_UNAVAILABLE';
      throw error;
    }
    const operational = resolveOperationalCpiBody(req.body || {}, currentRelease);
    const requestBody = operational.body;
    const discovery = reconciliationResult.discovery || {
      ok: false,
      message: reconciliationResult.outcome?.message || 'CPI catalog discovery did not return an outcome.',
      contracts_added: 0,
      contracts_total: 0,
    };
    const sidecarDiscoveryMs = reconciliationResult.outcome?.durationMs || 0;
    const ibkrDiagnostics = await getIbkrCpiPortfolioDiagnostics();
    const kalshiStartedAt = nowMs();
    let kalshiEvents = await fetchKalshiCpiEvents(requestBody.cpi);
    if (kalshiEvents.length) {
      try {
        await persistCurrentVenueCatalog(kalshiEvents, currentRelease, {
          venues: ['Kalshi'],
          source: 'kalshi-native-current-release',
          promoteCurrent: true,
        });
      } catch (error) {
        setProviderStatus('kalshi', {
          status: 'catalog_persistence_error',
          errorCode: normalizeCatalogErrorCode(error, 'CATALOG_PERSISTENCE_FAILED'),
          message: error.message,
        });
        kalshiEvents = [];
      }
    }
    const kalshiDiscoveryMs = nowMs() - kalshiStartedAt;
    const sourceEvents = [...kalshiEvents];
    const events = mergeCpiSourceEvents([], kalshiEvents, requestBody);
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
    const diagnostics = getCpiDiscoveryDiagnostics(requestBody, {}, discovery, sourceEvents, providers);
    providers = attachCpiDiscoveryToProviders(providers, diagnostics);
    providers = withIbkrContractStatus(providers, [], {
      ...diagnostics,
      contractsTotal: diagnostics.venueCoverage?.ibkr?.contractsTotal ?? discoveredContractsTotal,
      missingStrikes: diagnostics.venueCoverage?.ibkr?.missingStrikes || diagnostics.targetStrikes,
    });
    const readiness = buildCpiReadiness({
      release: currentRelease,
      events: sourceEvents,
      providerErrorCode: discovery?.errorCode || providers?.ibkr?.errorCode || null,
      displayErrorCode: providers?.kalshi?.errorCode || null,
    });
    providers = applyCpiReadinessToProviders(providers, readiness, currentRelease);
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
      ok: discovery.ok !== false && reconciliationResult.outcome?.status === 'succeeded',
      errorCode: discovery.ok !== false && reconciliationResult.outcome?.status === 'succeeded'
        ? null
        : discovery?.errorCode || reconciliationResult.outcome?.code || null,
      reconciliation: reconciliationResult.outcome,
      discovery,
      events,
      providerEvents: sourceEvents,
      reference: {},
      fetched_at: new Date().toISOString(),
      dashboardEvents,
      providers,
      currentRelease,
      operationalContext: {
        releaseKey: currentRelease.releaseKey,
        ignoredHistoricalRequest: operational.ignoredHistoricalRequest,
        requestedMonth: operational.requestedMonth,
        currentMonth: operational.currentMonth,
      },
      readiness,
      ibkrDiagnostics,
      ...diagnostics,
      timing,
    });
  } catch (err) {
    console.error('[PM Ingest] discover/ibkr error:', err.message);
    res.status(String(err.code || '').startsWith('CPI_RELEASE_') ? 503 : 500).json({
      error: err.message,
      providers: getProviderStatus(),
    });
  }
});

// GET /api/prediction-markets/reconciliation/status
router.get('/reconciliation/status', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(getCpiCatalogReconcilerStatus());
});

// GET /api/prediction-markets/providers/status
router.get('/providers/status', async (req, res) => {
  try {
    const currentRelease = await getCurrentCpiRelease();
    const requestBody = currentRelease.request;
    const { checkGatewayHealth } = require('../services/predictionMarketsIngest/providers/ibkrProvider');
    const health = await checkGatewayHealth();
    let ibkrEvents = [];
    let ibkrSnapshot = null;
    let portfolioCpiPositionCount = 0;
    if (health.ok) {
      try {
        const catalogContracts = await loadCurrentIbkrCatalog(currentRelease);
        ibkrEvents = filterIbkrEvents(await fetchIBKREvents({
          cpi: currentRelease.cpi,
          catalogContracts,
        }), {
          releaseKey: currentRelease.releaseKey,
        });
        const refreshedStatus = getProviderStatus().ibkr || {};
        ibkrSnapshot = {
          cpi_discovery: refreshedStatus.cpi_discovery || null,
          timing: refreshedStatus.cpi_timing || null,
          contracts_total: refreshedStatus.contracts_total ?? ibkrEvents.length,
          errorCode: refreshedStatus.errorCode || null,
        };
      } catch (err) {
        ibkrSnapshot = {
          errorCode: normalizeCatalogErrorCode(err),
          message: err.message,
          events: [],
        };
        setProviderStatus('ibkr', {
          status: 'catalog_unavailable',
          errorCode: normalizeCatalogErrorCode(err),
          message: err.message,
        });
        console.warn('[PM Ingest] current V2 catalog quote check failed:', err.message);
      }
      try {
        const diagnostics = await getIbkrCpiPortfolioDiagnostics();
        portfolioCpiPositionCount = diagnostics.portfolioCpiPositionCount;
      } catch (err) {
        console.warn('[PM Ingest] sidecar portfolio CPI status check failed:', err.message);
      }
    }
    const kalshiEvents = await fetchKalshiCpiEvents(currentRelease.cpi);
    const sourceEvents = [...ibkrEvents, ...kalshiEvents];
    let providers = getProviderStatus();
    const snapshotDiscovery = ibkrSnapshot?.cpi_discovery || null;
    const snapshotMonth = cpiMonthIdForRequest({ cpi: snapshotDiscovery || {} });
    const currentMonth = normalizeCpiMonthId(currentRelease.reportMonth);
    const currentDiscovery = snapshotMonth === currentMonth ? snapshotDiscovery : null;
    const currentContractsTotal = currentDiscovery
      ? Math.max(Number(ibkrSnapshot?.contracts_total ?? 0), ibkrEvents.length)
      : ibkrEvents.length;
    providers.ibkr = {
      ...providers.ibkr,
      gateway: health,
      ...(currentDiscovery ? { cpi_discovery: currentDiscovery } : { cpi_discovery: null }),
      ...(ibkrSnapshot?.timing ? { cpi_timing: ibkrSnapshot.timing } : {}),
      contracts_total: currentContractsTotal,
      portfolio_seed_count: 0,
    };
    const diagnostics = getCpiDiscoveryDiagnostics(requestBody, {}, null, sourceEvents, providers);
    providers = attachCpiDiscoveryToProviders(providers, diagnostics);
    providers = withIbkrContractStatus(providers, ibkrEvents, {
      ...diagnostics,
      contractsTotal: diagnostics.venueCoverage?.ibkr?.contractsTotal ?? ibkrEvents.length,
      missingStrikes: diagnostics.venueCoverage?.ibkr?.missingStrikes || diagnostics.targetStrikes,
      portfolioCpiPositionCount,
    });
    const readiness = buildCpiReadiness({
      release: currentRelease,
      events: sourceEvents,
      providerErrorCode: providers?.ibkr?.errorCode || ibkrSnapshot?.errorCode || null,
      displayErrorCode: providers?.kalshi?.errorCode || null,
    });
    providers = applyCpiReadinessToProviders(providers, readiness, currentRelease);
    res.json({
      releaseKey: currentRelease.releaseKey,
      providers,
      readiness,
    });
  } catch (err) {
    console.error('[PM Ingest] providers/status error:', err.message);
    res.status(String(err.code || '').startsWith('CPI_RELEASE_') ? 503 : 500).json({ error: err.message });
  }
});

router._private = {
  cpiMonthIdForEvent,
  cpiMonthIdForRequest,
  filterIbkrEvents,
  isEventForRequestedCpiMonth,
  isLiveTradingEvent,
  mergeCpiSourceEvents,
  normalizeCpiMonthId,
  hasTwoSidedExecutableAsk,
  chooseCpiSourceEvent,
  withIbkrContractStatus,
  getCpiDiscoveryDiagnostics,
  applyCpiReadinessToProviders,
  buildCpiReadiness,
  normalizeCatalogErrorCode,
  eventMatchesRelease,
  hasNativeExecutableBook,
  loadCurrentIbkrCatalog,
  persistCurrentVenueCatalog,
  resolveOperationalCpiBody,
  nowMs,
};

module.exports = router;
