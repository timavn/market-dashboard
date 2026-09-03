const ibkrMarketDataProvider = require('../providers/ibkr/ibkrMarketDataProvider');
const { buildExactEsFutureInstrument } = require('../forecastExFesIdentity.cjs');
const { buildExactForecastCommodityInstrument } = require('../forecastExCommodityIdentity.cjs');
const { getRiskRangeHistoryAvailability } = require('../predictionMarketsIngest/signalAvailabilityProvider');
const {
  buildWtiSettlementMapping,
  historicalBarDateKey,
  latestCompletedSpxSessionDate,
  latestCompletedWtiSessionDate,
  normalizeUnderlyingBars,
  wtiIbkrInstrument,
} = require('../predictionMarketsIngest/watchlistProvider');
const {
  FORECAST_COMMODITY_PRODUCTS,
  PYTH_RESOLVER_IDENTITIES,
  pythExplorerSymbol,
} = require('./resolverIdentities.cjs');
const {
  DIRECTIONAL_FEEDS,
  FUTURES_MARKET_IDS,
  generateDirectionalCandidates,
  selectDirectionalContract,
} = require('./directionalFeedRegistry.cjs');
const { createHistoricalRequestQueue } = require('./historicalRequestQueue.cjs');
const { createHistoricalCheckpointStore } = require('./historicalCheckpointStore.cjs');
const {
  retainVerifiedAthWhilePending,
  synchronizeVerifiedAthAcrossChartRanges,
} = require('../../utils/predictionMarketAth.cjs');
const { kalshiFetch: defaultKalshiFetch } = require('../predictionMarketsIngest/providers/kalshiClient');
const {
  GOLD_TRACKING_WINDOW,
  buildGoldPythTracking,
  emptyGoldPythTracking,
  selectedGoldEventTicker,
} = require('./goldPythTracking.cjs');
const {
  buildProxyFitComparison,
  proxyFitCandidateDates,
  unavailableProxyFit,
} = require('./proxyFit.cjs');
const {
  buildResolverChartSession,
  dateForPoint: resolverSessionDateForPoint,
  eventFromSelection,
  sessionWindowForDate,
} = require('./resolverChartSessions.cjs');

const LIVE_QUOTE_MAX_AGE_MS = 60_000;
const LIVE_BAR_MAX_AGE_MS = 10 * 60_000;
const HISTORICAL_RETENTION_MS = 30 * 60_000;
const FUTURE_TOLERANCE_MS = 5_000;
// Allow the selected contract's coarse history to win first paint even when a
// second Risk Range-basis reference is being initialized. Hard provider calls
// remain independently bounded; this is only the progressive publish probe.
const LIVE_CONTEXT_WAIT_MS = 900;
const FRESH_REFERENCE_PROBE_MS = 100;
// A wedged Coinbase transport must not permanently own Bitcoin's single
// reference-refresh slot. The live ticker/candle requests each have an
// eight-second source timeout, so this outer bound leaves enough time for
// normalization while still clearing the slot before the next monitor cycle.
const COINBASE_REFERENCE_REFRESH_TIMEOUT_MS = 10_000;
// Gold performs multiple independently bounded IBKR reads. This outer
// deadline keeps one wedged transport from permanently owning its reference
// refresh slot after those reads should have settled.
const GOLD_REFERENCE_REFRESH_TIMEOUT_MS = 30_000;
const IBKR_WORKER_WAIT_MS = 12_000;
const PRIORITY_IBKR_HISTORY_TIMEOUT_MS = 16_000;
const GOLD_HEADER_REFERENCE_WAIT_MS = IBKR_WORKER_WAIT_MS + 250;
const GOLD_SECONDARY_HEADER_PROBE_MS = 750;
// Keep the price chart bounded, but allow the production DynamoDB batch read
// enough time to return the full exact-date overlay set under dashboard load.
// The shorter test bound preserves deterministic timeout coverage.
const RISK_RANGE_HISTORY_WAIT_MS = process.env.NODE_ENV === 'test' ? 500 : 2_500;
// BTC's live ticker and candles must not wait behind its slower historical
// Risk Range overlay. Keeping this probe inside the first-paint budget lets
// verified price data publish immediately while the exact-date overlay keeps
// refreshing independently.
const BITCOIN_RISK_RANGE_HISTORY_WAIT_MS = 150;
const RISK_RANGE_HISTORY_CACHE_MS = 30 * 60_000;
const INTRADAY_HISTORY_TTL_MS = 5 * 60_000;
const MULTI_DAY_HISTORY_TTL_MS = 60 * 60_000;
const ATH_RECORD_TTL_MS = 24 * 60 * 60_000;
const ATH_RECORD_REQUEST_TIMEOUT_MS = 120_000;
const PROXY_FIT_HISTORY_TTL_MS = 60 * 60_000;
const GOLD_PYTH_TRACKING_TTL_MS = 15 * 60_000;
// Ten completed sessions regularly span more than eleven calendar days once
// weekends, exchange holidays, or a contract-specific no-trade day are
// included. Ask IBKR for a month, then strictly trim to the last 5/10 verified
// sessions in buildSessionVariant.
const MULTI_DAY_HISTORY_RANGE = '1mo';
const PROXY_FIT_HISTORY_RANGE = '6mo';
const PYTH_LAZER_URL = process.env.PYTH_LAZER_URL || 'https://pyth-lazer.dourolabs.app';
const PYTH_HISTORY_URL = process.env.PYTH_HISTORY_URL || 'https://pyth.dourolabs.app/v1';
const COINBASE_EXCHANGE_URL = 'https://api.exchange.coinbase.com';
const FORBIDDEN = /delayed|frozen|stale|cache(?:d|_only|-only)?|mock|seed|fallback|offline|disconnected|synthetic|inferred|derived/i;
const DAY_MS = 24 * 60 * 60_000;
const CHART_RANGES = Object.freeze(['1d', '5d', '10d']);
const FUTURES_MONTH_BY_CODE = Object.freeze({
  F: 1, G: 2, H: 3, J: 4, K: 5, M: 6,
  N: 7, Q: 8, U: 9, V: 10, X: 11, Z: 12,
});
const FUTURES_CODE_BY_MONTH = Object.freeze(Object.fromEntries(
  Object.entries(FUTURES_MONTH_BY_CODE).map(([code, month]) => [month, code]),
));

const NDX_INSTRUMENT = Object.freeze({
  symbol: 'NDX',
  displaySymbol: 'NDX',
  secType: 'IND',
  exchange: 'NASDAQ',
  currency: 'USD',
  provider: 'ibkr',
});

const GOLD_SPOT_PROXY_INSTRUMENT = Object.freeze({
  symbol: 'XAUUSD',
  displaySymbol: 'XAUUSD',
  ibkrSymbol: 'XAUUSD',
  conId: 69067924,
  secType: 'CMDTY',
  exchange: 'SMART',
  currency: 'USD',
  tradingClass: 'XAUUSD',
  provider: 'ibkr',
});

const RISK_RANGE_BASIS_SYMBOLS = Object.freeze({
  wti: 'WTIC',
  silver: 'SILVER',
  brent: 'BRENT',
  bitcoin: 'BITCOIN',
  gold: 'XAUUSD',
});

function chartReferenceEntry({
  role,
  symbol,
  riskRangeTicker,
  reference,
  exact = false,
  disclosure = null,
}) {
  const safeReference = reference || {};
  const spotStatus = String(safeReference.spot?.status || safeReference.chart?.status || '').toLowerCase();
  const availability = String(safeReference.spot?.availability || safeReference.chart?.availability || '').toLowerCase();
  const freshnessStatus = spotStatus === 'historical' || availability === 'historical'
    ? 'verified_historical'
    : ['available', 'partial'].includes(spotStatus)
      ? 'verified_live'
      : ['loading', 'refreshing'].includes(spotStatus)
        ? 'loading'
        : 'unavailable';
  return {
    role,
    symbol: String(symbol || '').trim() || null,
    riskRangeTicker: riskRangeTicker || null,
    exact: exact === true,
    fit: safeReference.fit || safeReference.spot?.fit || (exact ? 'exact' : 'proxy'),
    instrument: safeReference.instrument || null,
    resolver: safeReference.resolver || null,
    spot: safeReference.spot || null,
    chart: safeReference.chart || null,
    freshness: {
      status: freshnessStatus,
      asOf: safeReference.spot?.asOf || safeReference.chart?.asOf || safeReference.chart?.latestAt || null,
      expiresAt: safeReference.spot?.expiresAt || safeReference.chart?.expiresAt || null,
      reason: safeReference.spot?.refreshIssue
        || safeReference.spot?.reason
        || safeReference.chart?.refreshIssue
        || safeReference.chart?.reason
        || null,
    },
    directionalFeed: safeReference.directionalFeed || null,
    disclosure,
    backgroundRefresh: safeReference.backgroundRefresh === true,
  };
}

function finiteNumber(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function createFetchHttpClient(fetchImpl = global.fetch) {
  const request = async (method, url, { params, data, headers = {}, timeout = 8_000 } = {}) => {
    if (typeof fetchImpl !== 'function') {
      throw Object.assign(new Error('HTTP fetch is unavailable.'), { code: 'REFERENCE_HTTP_UNAVAILABLE' });
    }
    const target = new URL(url);
    Object.entries(params || {}).forEach(([key, value]) => {
      if (value != null) target.searchParams.set(key, String(value));
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetchImpl(target, {
        method,
        signal: controller.signal,
        headers: {
          accept: 'application/json',
          ...(data == null ? {} : { 'content-type': 'application/json' }),
          ...headers,
        },
        ...(data == null ? {} : { body: JSON.stringify(data) }),
      });
      const text = await response.text();
      let payload = null;
      try { payload = text ? JSON.parse(text) : null; } catch (_error) { payload = text; }
      if (!response.ok) {
        const error = new Error(payload?.message || payload?.detail || `HTTP ${response.status}`);
        error.response = { status: response.status, data: payload };
        throw error;
      }
      return { data: payload, status: response.status };
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw Object.assign(new Error('Reference source request timed out.'), { code: 'REFERENCE_HTTP_TIMEOUT' });
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    get: (url, options) => request('GET', url, options),
    post: (url, data, options = {}) => request('POST', url, { ...options, data }),
  };
}

function unavailable(reason, extras = {}) {
  return {
    status: 'unavailable',
    source: null,
    asOf: null,
    expiresAt: null,
    reason,
    ...extras,
  };
}

function pendingProxyFit(reason, labels = {}) {
  return unavailableProxyFit(reason, { ...labels, status: 'loading' });
}

function expectedFuturesContractMonth(instrument) {
  const raw = String(
    instrument?.contractMonth
      || instrument?.deliveryMonth
      || instrument?.lastTradeDateOrContractMonth
      || '',
  ).trim();
  const match = raw.match(/^(20\d{2})(0[1-9]|1[0-2])$/);
  return match ? `${match[1]}${match[2]}` : null;
}

function localSymbolMatchesContractMonth(localSymbol, expectedMonth, expectedRoot = null) {
  const expected = String(expectedMonth || '').match(/^(20\d{2})(0[1-9]|1[0-2])$/);
  const local = String(localSymbol || '').trim().toUpperCase();
  const match = local.match(/^([A-Z0-9]+?)([FGHJKMNQUVXZ])(\d{1,2})$/);
  if (!expected || !match) return false;
  const expectedCode = FUTURES_CODE_BY_MONTH[Number(expected[2])];
  const expectedYear = expected[1];
  const actualYearMatches = match[3].length === 1
    ? match[3] === expectedYear.slice(-1)
    : match[3] === expectedYear.slice(-2);
  const normalizedRoot = String(expectedRoot || '').trim().toUpperCase();
  return (!normalizedRoot || match[1] === normalizedRoot)
    && match[2] === expectedCode
    && actualYearMatches;
}

function normalizedDatedFutureSymbol(root, localSymbol, contractMonth, fallback = null) {
  const expected = String(contractMonth || '').match(/^(20\d{2})(0[1-9]|1[0-2])$/);
  const normalizedRoot = String(root || '').trim().toUpperCase();
  if (!expected || !normalizedRoot
    || !localSymbolMatchesContractMonth(localSymbol, contractMonth, normalizedRoot)) {
    return String(fallback || localSymbol || normalizedRoot).trim().toUpperCase() || null;
  }
  return `${normalizedRoot}${FUTURES_CODE_BY_MONTH[Number(expected[2])]}${expected[1].slice(-2)}`;
}

function contractMonthFromLocalSymbol(localSymbol, nowMs = Date.now(), expectedRoot = null) {
  const local = String(localSymbol || '').trim().toUpperCase();
  const match = local.match(/^([A-Z0-9]+?)([FGHJKMNQUVXZ])(\d{1,2})$/);
  const normalizedRoot = String(expectedRoot || '').trim().toUpperCase();
  if (!match || (normalizedRoot && match[1] !== normalizedRoot)) return null;
  const month = FUTURES_MONTH_BY_CODE[match[2]];
  if (!month) return null;
  const currentYear = new Date(nowMs).getUTCFullYear();
  let year = match[3].length === 2
    ? 2000 + Number(match[3])
    : Math.floor(currentYear / 10) * 10 + Number(match[3]);
  if (match[3].length === 1) {
    while (year < currentYear - 1) year += 10;
    while (year > currentYear + 8) year -= 10;
  }
  return year >= 2020 && year <= 2099
    ? `${year}${String(month).padStart(2, '0')}`
    : null;
}

function normalizeDirectionalInstrumentIdentity(marketId, instrument, nowMs = Date.now()) {
  const definition = DIRECTIONAL_FEEDS[marketId];
  if (!definition || !instrument) return instrument || null;
  const localSymbol = String(
    instrument.localSymbol || instrument.displaySymbol || '',
  ).trim().toUpperCase();
  const derivedMonth = contractMonthFromLocalSymbol(localSymbol, nowMs, definition.root);
  if (!derivedMonth) return instrument;
  const lastTradeDate = String(
    instrument.lastTradeDate
      || (/^20\d{6}$/.test(String(instrument.lastTradeDateOrContractMonth || ''))
        ? instrument.lastTradeDateOrContractMonth
        : ''),
  ).trim() || null;
  return {
    ...instrument,
    symbol: definition.root,
    ibkrSymbol: definition.root,
    displaySymbol: normalizedDatedFutureSymbol(
      definition.root,
      localSymbol,
      derivedMonth,
      instrument.displaySymbol || localSymbol,
    ),
    localSymbol,
    contractMonth: derivedMonth,
    ...(lastTradeDate ? { lastTradeDate } : {}),
  };
}

function verifiedHistoricalContract(history, instrument) {
  const expectedType = String(instrument?.secType || '').trim().toUpperCase();
  if (!['FUT', 'CMDTY'].includes(expectedType)) return true;
  const actual = history?.contract;
  if (!actual || typeof actual !== 'object') return false;
  const actualType = String(actual.secType || '').trim().toUpperCase();
  if (actualType && actualType !== expectedType) return false;
  const expectedConId = Number(instrument?.conId ?? instrument?.conid);
  const actualConId = Number(actual?.conId ?? actual?.conid);
  if (Number.isInteger(expectedConId) && expectedConId > 0) {
    if (!Number.isInteger(actualConId) || actualConId !== expectedConId) return false;
  }
  const expectedSymbol = String(instrument?.symbol || instrument?.ibkrSymbol || '').trim().toUpperCase();
  const actualSymbol = String(actual?.symbol || '').trim().toUpperCase();
  if (expectedSymbol && actualSymbol && actualSymbol !== expectedSymbol) return false;
  if (!expectedSymbol && !(Number.isInteger(expectedConId) && expectedConId > 0)) return false;
  const expectedMonth = expectedFuturesContractMonth(instrument);
  if (!expectedMonth || expectedType !== 'FUT') return true;
  const actualLocalSymbol = String(actual?.localSymbol || '').trim().toUpperCase();
  if (actualLocalSymbol) {
    return localSymbolMatchesContractMonth(actualLocalSymbol, expectedMonth, expectedSymbol);
  }
  const explicitActualMonth = String(actual?.contractMonth || actual?.deliveryMonth || '').trim();
  if (/^20\d{4}$/.test(explicitActualMonth)) return explicitActualMonth === expectedMonth;
  const ambiguousDateOrMonth = String(actual?.lastTradeDateOrContractMonth || '').trim();
  if (/^20\d{4}$/.test(ambiguousDateOrMonth)) return ambiguousDateOrMonth === expectedMonth;
  // A matching conId is authoritative when IBKR omits local-symbol delivery
  // metadata. An eight-digit last-trade date must never be treated as the
  // delivery month.
  return Number.isInteger(expectedConId) && expectedConId > 0 && actualConId === expectedConId;
}

function qualifiedFuturesInstrument(requested, history) {
  if (!requested || !verifiedHistoricalContract(history, requested)) return null;
  const contract = history?.contract;
  const conId = Number(contract?.conId ?? contract?.conid);
  const localSymbol = String(contract?.localSymbol || '').trim().toUpperCase();
  const contractMonth = expectedFuturesContractMonth(requested);
  if (!Number.isInteger(conId) || conId <= 0 || !localSymbol || !contractMonth) return null;
  const lastTradeDate = String(contract?.lastTradeDateOrContractMonth || '').trim();
  return {
    ...requested,
    provider: 'ibkr',
    symbol: String(contract?.symbol || requested.symbol || '').trim().toUpperCase(),
    ibkrSymbol: String(contract?.symbol || requested.ibkrSymbol || requested.symbol || '').trim().toUpperCase(),
    conId,
    localSymbol,
    contractMonth,
    lastTradeDate: /^20\d{6}$/.test(lastTradeDate) ? lastTradeDate : null,
    lastTradeDateOrContractMonth: lastTradeDate || requested.lastTradeDateOrContractMonth,
    secType: contract?.secType || requested.secType,
    exchange: contract?.exchange || requested.exchange,
    currency: contract?.currency || requested.currency,
    multiplier: contract?.multiplier || requested.multiplier,
    tradingClass: contract?.tradingClass || requested.tradingClass,
    displaySymbol: requested.displaySymbol || localSymbol,
  };
}

function directIbkrProxyFitPoints(history, nowMs, instrument = null) {
  const provenance = [
    history?.error,
    history?.warning,
    history?.provenance,
    history?.cacheStatus,
    history?.cacheState,
    history?.fromCache ? 'cache' : null,
    history?.cached ? 'cache' : null,
    history?.restoredFromCheckpoint ? 'cache' : null,
    history?.refreshFailed ? 'refresh failed' : null,
  ].filter(Boolean).join(' ');
  if (
    String(history?.source || '').toLowerCase() !== 'ibkr'
    || !Array.isArray(history?.bars)
    || history.bars.length < 2
    || FORBIDDEN.test(provenance)
    || !verifiedHistoricalContract(history, instrument)
  ) return [];
  return normalizeUnderlyingBars(history.bars, nowMs);
}

async function buildVerifiedProxyFit({
  proxyPoints,
  proxyLabel,
  underlyingLabel,
  proxySource,
  loadRiskRangeHistory,
}) {
  const requestedDates = proxyFitCandidateDates(proxyPoints);
  if (requestedDates.length < 5 || typeof loadRiskRangeHistory !== 'function') {
    return unavailableProxyFit('Verified aligned proxy and underlying history is unavailable.', {
      proxyLabel,
      underlyingLabel,
    });
  }
  const underlyingHistory = await loadRiskRangeHistory({
    ticker: underlyingLabel,
    dates: requestedDates,
  });
  return buildProxyFitComparison({
    proxyPoints,
    underlyingHistory,
    proxyLabel,
    underlyingLabel,
    proxySource,
  });
}

function unavailableChartVariant(range, reason, extras = {}) {
  return unavailable(reason, {
    range,
    interval: null,
    availability: 'unavailable',
    points: [],
    references: [],
    rangeDates: [],
    dailyRanges: [],
    riskRangeStatus: 'unavailable',
    riskRangeMissingDates: [],
    fit: extras.fit || 'exact',
    executable: false,
    ...extras,
  });
}

function chartContract(variants = {}, reason = 'Verified chart history is unavailable.', fit = 'exact') {
  const complete = Object.fromEntries(CHART_RANGES.map((range) => [
    range,
    variants[range] || unavailableChartVariant(range, reason, { fit }),
  ]));
  return { ...complete['1d'], variants: complete };
}

function unavailableAth(reason = 'Verified complete IBKR all-time-high history is unavailable.') {
  return {
    status: 'unavailable',
    source: null,
    asOf: null,
    value: null,
    date: null,
    baseline: null,
    markers: [],
    reason,
  };
}

function loadingAth() {
  return {
    ...unavailableAth('Verified IBKR all-time-high history is still loading.'),
    status: 'loading',
  };
}

function verifiedHistoricalRecord(record, throughDate, expectedSource = 'ibkr') {
  const provenance = [
    record?.warning,
    record?.error,
    record?.provenance,
    record?.cacheStatus,
    record?.cacheState,
    record?.sourceStatus,
    record?.fromCache ? 'cached' : '',
    record?.cached ? 'cached' : '',
    record?.cachedOnly ? 'cached-only' : '',
    record?.cacheOnly ? 'cache-only' : '',
    record?.cacheHit ? 'cache-hit' : '',
  ].filter(Boolean).join(' ');
  const recordHigh = finiteNumber(record?.recordHigh);
  const recordDate = String(record?.recordDate || '');
  const coverageStart = String(record?.coverage?.startDate || '');
  const coverageHead = String(record?.coverage?.headDate || '');
  const observations = Number(record?.coverage?.observations);
  const chunks = Number(record?.coverage?.chunks);
  return Boolean(
    record?.status === 'available'
    && String(record?.source || '').toLowerCase() === expectedSource
    && String(record?.dataset || 'historical_record') === 'historical_record'
    && record?.coverage?.complete === true
    && record?.throughDate === throughDate
    && record?.coverage?.endDate === throughDate
    && /^\d{4}-\d{2}-\d{2}$/.test(coverageStart)
    && coverageHead === coverageStart
    && Number.isInteger(observations)
    && observations >= 2
    && Number.isInteger(chunks)
    && chunks >= 1
    && /^\d{4}-\d{2}-\d{2}$/.test(recordDate)
    && recordDate >= coverageStart
    && recordDate <= throughDate
    && recordHigh != null
    && recordHigh > 0
    && !FORBIDDEN.test(provenance)
  );
}

function normalizeHistoricalAth(
  recordResult,
  recordSettlement,
  points,
  throughDate,
  expectedSource = 'ibkr',
) {
  if (recordSettlement?.status === 'pending') return loadingAth();
  if (recordSettlement?.status === 'rejected') {
    return unavailableAth(String(
      recordSettlement.reason?.message
      || recordSettlement.reason
      || 'Verified IBKR ATH refresh failed.',
    ));
  }
  if (!verifiedHistoricalRecord(recordResult, throughDate, expectedSource)) {
    return unavailableAth(
      recordResult?.reason
      || recordResult?.error
      || 'Verified complete IBKR all-time-high history is unavailable.',
    );
  }

  let runningHigh = Number(recordResult.recordHigh);
  let recordDate = String(recordResult.recordDate);
  const markers = [];
  (Array.isArray(points) ? points : [])
    .filter((point) => historicalBarDateKey(point?.timestamp) > throughDate)
    .sort((left, right) => Number(left.timestamp) - Number(right.timestamp))
    .forEach((point) => {
      const explicitHigh = finiteNumber(point?.high);
      const verifiedLiveValue = point?.verifiedCurrent === true ? finiteNumber(point?.value) : null;
      const candidate = explicitHigh ?? verifiedLiveValue;
      if (candidate == null || candidate <= runningHigh) return;
      runningHigh = candidate;
      recordDate = historicalBarDateKey(point.timestamp);
      markers.push({
        date: recordDate,
        timestamp: Number(point.timestamp),
        value: runningHigh,
        label: 'ATH',
      });
    });

  return {
    status: 'available',
    source: `${expectedSource}_historical_record`,
    asOf: recordResult.asOf || null,
    value: runningHigh,
    date: recordDate,
    baseline: {
      value: Number(recordResult.recordHigh),
      date: recordResult.recordDate,
      throughDate,
      source: expectedSource,
      dataset: recordResult.dataset || 'historical_record',
      coverageComplete: true,
      coverageStart: recordResult.coverage.startDate,
      coverageEnd: recordResult.coverage.endDate,
      coverageHead: recordResult.coverage.headDate,
      chunks: recordResult.coverage.chunks,
      observations: recordResult.coverage.observations,
    },
    markers,
    reason: null,
  };
}

function attachAthToChart(chart, ath) {
  const variants = Object.fromEntries(CHART_RANGES.map((range) => [range, {
    ...chart?.variants?.[range],
    ath,
  }]));
  return { ...variants['1d'], variants };
}

function verifiedHistoricalSection(section, expectedHistoricalDate) {
  const status = String(section?.status || '').toLowerCase();
  const availability = String(section?.availability || '').toLowerCase();
  const historicalDate = String(section?.historicalThroughDate || '');
  const latestDate = historicalBarDateKey(Date.parse(section?.latestAt || section?.asOf || ''));
  return (status === 'historical' || availability === 'historical')
    && /^\d{4}-\d{2}-\d{2}$/.test(String(expectedHistoricalDate || ''))
    && historicalDate === expectedHistoricalDate
    && latestDate === expectedHistoricalDate;
}

function verifiedFreshReferenceSpot(section, nowMs, expectedHistoricalDate = null) {
  const status = String(section?.status || '').toLowerCase();
  const source = String(section?.source || '').trim();
  const expiresAt = Date.parse(section?.expiresAt || '');
  const historical = verifiedHistoricalSection(section, expectedHistoricalDate);
  return ['available', 'historical'].includes(status)
    && finiteNumber(section?.value) != null
    && source.length > 0
    && !FORBIDDEN.test(source)
    && section?.refreshFailed !== true
    && section?.fromCache !== true
    && section?.cachedOnly !== true
    && section?.seeded !== true
    && (historical || (Number.isFinite(expiresAt) && nowMs <= expiresAt));
}

function verifiedFreshReferenceChart(section, nowMs, expectedHistoricalDate = null) {
  const status = String(section?.status || '').toLowerCase();
  const source = String(section?.source || '').trim();
  const expiresAt = Date.parse(section?.expiresAt || '');
  const historical = verifiedHistoricalSection(section, expectedHistoricalDate);
  return ['available', 'historical', 'partial'].includes(status)
    && source.length > 0
    && !FORBIDDEN.test(source)
    && section?.refreshFailed !== true
    && section?.fromCache !== true
    && section?.cachedOnly !== true
    && section?.seeded !== true
    && Array.isArray(section?.points)
    && section.points.length >= 2
    && (historical || (Number.isFinite(expiresAt) && nowMs <= expiresAt));
}

function retainVerifiedSectionWhileRefreshing(section) {
  return {
    ...section,
    refreshing: false,
    refreshPending: true,
    refreshRetained: true,
    refreshFailed: false,
    refreshIssue: null,
  };
}

function terminalUnavailableSection(section) {
  const status = String(section?.status || '').toLowerCase();
  return ['unavailable', 'refresh_failed'].includes(status)
    && section?.refreshing !== true
    && section?.refreshPending !== true
    && (
      section?.refreshFailed === true
      || Boolean(section?.errorCode)
      || Boolean(String(section?.reason || '').trim())
    );
}

function retainTerminalSectionWhileRefreshing(previous, next) {
  const pending = String(next?.status || '').toLowerCase() === 'refreshing'
    || next?.refreshing === true
    || next?.refreshPending === true;
  return pending && terminalUnavailableSection(previous) ? previous : null;
}

function retainVerifiedChartWhileRefreshing(previous, next, nowMs, expectedHistoricalDate = null) {
  const previousVariants = previous?.variants || {};
  const nextVariants = next?.variants || {};
  let retained = false;
  let overlayRetained = false;
  let terminalRetained = false;
  const variants = Object.fromEntries(CHART_RANGES.map((range) => {
    const previousVariant = previousVariants[range] || (range === '1d' ? previous : null);
    const suppliedNextVariant = nextVariants[range] || (range === '1d' ? next : null);
    const nextVariant = retainVerifiedAthWhilePending(
      previousVariant,
      retainRiskRangeOverlaysWhilePending(previousVariant, suppliedNextVariant),
    );
    if (nextVariant !== suppliedNextVariant) overlayRetained = true;
    if (verifiedFreshReferenceChart(nextVariant, nowMs, expectedHistoricalDate)) return [range, nextVariant];
    if (verifiedFreshReferenceChart(previousVariant, nowMs, expectedHistoricalDate)) {
      retained = true;
      return [range, retainVerifiedSectionWhileRefreshing(previousVariant)];
    }
    const previousTerminal = retainTerminalSectionWhileRefreshing(previousVariant, nextVariant);
    if (previousTerminal) {
      terminalRetained = true;
      return [range, previousTerminal];
    }
    return [range, nextVariant || unavailableChartVariant(
      range,
      `Verified ${range.toUpperCase()} chart history is refreshing.`,
      { status: 'refreshing', refreshing: true, fit: next?.fit || previous?.fit || 'exact' },
    )];
  }));
  const root = variants['1d'];
  const synchronizedChart = synchronizeVerifiedAthAcrossChartRanges({
    ...root,
    variants,
    ...(retained ? { refreshing: false, refreshPending: true, refreshRetained: true } : {}),
  });
  return {
    chart: synchronizedChart,
    retained: retained || overlayRetained,
    terminalRetained,
  };
}

function retainVerifiedReferenceWhileRefreshing(previous, next, nowMs, expectedHistoricalDate = null) {
  if (!previous || !next) return null;
  let retained = false;
  let spot = next.spot;
  if (!verifiedFreshReferenceSpot(spot, nowMs, expectedHistoricalDate)
    && verifiedFreshReferenceSpot(previous.spot, nowMs, expectedHistoricalDate)) {
    spot = retainVerifiedSectionWhileRefreshing(previous.spot);
    retained = true;
  } else if (!verifiedFreshReferenceSpot(spot, nowMs, expectedHistoricalDate)) {
    spot = retainTerminalSectionWhileRefreshing(previous.spot, spot) || spot;
  }
  const chartResult = retainVerifiedChartWhileRefreshing(previous.chart, next.chart, nowMs, expectedHistoricalDate);
  retained = retained || chartResult.retained;
  const terminalRetained = spot === previous.spot || chartResult.terminalRetained;
  if (!retained && !terminalRetained) return null;
  return {
    ...previous,
    ...next,
    spot,
    chart: chartResult.chart,
    resolver: next.resolver || previous.resolver || null,
    instrument: next.instrument || previous.instrument || null,
    fit: next.fit || previous.fit || spot?.fit || chartResult.chart?.fit || 'exact',
    backgroundRefresh: true,
    refreshRetained: retained,
  };
}

function dateIsWeekday(dateKey) {
  const parsed = Date.parse(`${dateKey}T12:00:00.000Z`);
  if (!Number.isFinite(parsed)) return false;
  const day = new Date(parsed).getUTCDay();
  return day > 0 && day < 6;
}

function groupPointsBySession(points = [], {
  calendarSessions = false,
  chartSession = null,
  currentWindowOnly = false,
  allowSingletonSessions = false,
  allowFreshSingletonDate = null,
  nowMs = null,
  singletonMaxAgeMs = 75 * 60_000,
} = {}) {
  const groups = new Map();
  points.forEach((point) => {
    const date = chartSession
      ? resolverSessionDateForPoint(chartSession, point.timestamp, { currentOnly: currentWindowOnly })
      : historicalBarDateKey(point.timestamp);
    if (!date || (!calendarSessions && !dateIsWeekday(date))) return;
    if (!groups.has(date)) groups.set(date, []);
    groups.get(date).push({ ...point, sessionDate: date });
  });
  return [...groups.entries()]
    .map(([date, sessionPoints]) => [date, sessionPoints.sort((left, right) => left.timestamp - right.timestamp)])
    .filter(([date, sessionPoints]) => {
      if (sessionPoints.length >= 2) return true;
      if (allowSingletonSessions && sessionPoints.length === 1) return true;
      const timestamp = sessionPoints[0]?.timestamp;
      return date === allowFreshSingletonDate
        && Number.isFinite(nowMs)
        && Number.isFinite(timestamp)
        && nowMs - timestamp >= -FUTURE_TOLERANCE_MS
        && nowMs - timestamp <= singletonMaxAgeMs;
    })
    .sort(([left], [right]) => left.localeCompare(right));
}

function verifiedCurrentPointFromSpot(spot, nowMs) {
  const timestamp = Date.parse(spot?.asOf || '');
  const expiresAt = Date.parse(spot?.expiresAt || '');
  const value = finiteNumber(spot?.value);
  const source = String(spot?.source || '').trim();
  if (
    spot?.status !== 'available'
    || spot?.availability !== 'live'
    || value == null
    || value <= 0
    || !source
    || FORBIDDEN.test(source)
    || spot?.fromCache === true
    || spot?.cachedOnly === true
    || spot?.refreshFailed === true
    || !Number.isFinite(timestamp)
    || nowMs - timestamp < -FUTURE_TOLERANCE_MS
    || nowMs - timestamp > LIVE_QUOTE_MAX_AGE_MS
    || !Number.isFinite(expiresAt)
    || expiresAt < nowMs
  ) return null;
  return {
    timestamp,
    value,
    source,
    availability: 'live',
    fit: spot.fit || 'exact',
    verifiedCurrent: true,
  };
}

function appendVerifiedCurrentPoint(points = [], currentPoint = null) {
  const sourcePoints = Array.isArray(points) ? points : [];
  if (!currentPoint) return sourcePoints;
  const latest = sourcePoints[sourcePoints.length - 1];
  if (Number.isFinite(latest?.timestamp) && latest.timestamp >= currentPoint.timestamp) return sourcePoints;
  return [...sourcePoints, currentPoint];
}

function previousCompletedClose(points = [], asOf, {
  calendarSessions = false,
  chartSession = null,
} = {}) {
  const asOfMs = Date.parse(asOf || '');
  const currentDate = chartSession
    ? resolverSessionDateForPoint(chartSession, asOfMs)
    : historicalBarDateKey(asOfMs);
  if (!currentDate) return null;
  const prior = groupPointsBySession(points, { calendarSessions, chartSession })
    .filter(([date]) => date < currentDate)
    .at(-1);
  const point = prior?.[1]?.at(-1) || null;
  return point && finiteNumber(point.value) != null
    ? { value: Number(point.value), date: prior[0], asOf: new Date(point.timestamp).toISOString() }
    : null;
}

function riskRangeValues(range) {
  const references = Array.isArray(range?.references) ? range.references : [];
  const lrr = finiteNumber(references.find((reference) => reference?.label === 'LRR')?.value);
  const hrr = finiteNumber(references.find((reference) => reference?.label === 'HRR')?.value);
  return lrr != null && hrr != null && lrr < hrr ? { lrr, hrr } : null;
}

function cacheableVerifiedRiskRangeHistory(result, { ticker, dates = [] } = {}) {
  const normalizedTicker = String(ticker || '').trim().toUpperCase();
  const requestedDates = [...new Set((Array.isArray(dates) ? dates : [])
    .map((date) => String(date || '').trim())
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)))].sort();
  if (
    !normalizedTicker
    || requestedDates.length === 0
    || String(result?.ticker || normalizedTicker).trim().toUpperCase() !== normalizedTicker
    || result?.fromCache === true
    || result?.cachedOnly === true
    || result?.seeded === true
    || FORBIDDEN.test([
      result?.warning,
      result?.provenance,
      result?.cacheState,
    ].filter(Boolean).join(' '))
  ) return false;
  const missingDates = new Set((Array.isArray(result?.missingDates) ? result.missingDates : [])
    .map((date) => String(date || '').trim()));
  const unexpectedMissingDates = requestedDates.filter((date) => (
    missingDates.has(date)
    && !(normalizedTicker === 'BITCOIN' && utcWeekendDate(date))
  ));
  let verifiedCount = 0;
  const safe = requestedDates.every((date) => {
    const range = result?.ranges?.[date];
    const lrr = finiteNumber(range?.lrr);
    const hrr = finiteNumber(range?.hrr);
    const source = String(range?.source || result?.source || '').trim();
    const asOf = String(range?.asOf || range?.date || '');
    const verified = lrr != null
      && hrr != null
      && lrr < hrr
      && source.length > 0
      && !FORBIDDEN.test(source)
      && (!/^\d{4}-\d{2}-\d{2}/.test(asOf) || asOf.slice(0, 10) === date)
      && range?.fromCache !== true
      && range?.cachedOnly !== true
      && range?.seeded !== true;
    if (verified) verifiedCount += 1;
    return verified || missingDates.has(date);
  });
  return safe && verifiedCount > 0 && unexpectedMissingDates.length === 0;
}

function utcWeekendDate(date) {
  const timestamp = Date.parse(`${date}T12:00:00.000Z`);
  if (!Number.isFinite(timestamp)) return false;
  const weekday = new Date(timestamp).getUTCDay();
  return weekday === 0 || weekday === 6;
}

function verifiedDailyRiskRange(range) {
  const date = String(range?.date || '');
  const publicationDate = String(range?.riskRangePublicationDate || date);
  const carriedForward = range?.riskRangeCarryForward === 'last_published_non_publication_session';
  const references = Array.isArray(range?.references) ? range.references : [];
  const values = riskRangeValues(range);
  if (range?.status !== 'available'
    || !/^\d{4}-\d{2}-\d{2}$/.test(date)
    || !values
    || range?.refreshFailed === true
    || range?.fromCache === true
    || range?.cachedOnly === true
    || range?.seeded === true) return false;
  return ['LRR', 'HRR'].every((label) => {
    const reference = references.find((candidate) => candidate?.label === label);
    const source = String(reference?.source || '').trim();
    const asOf = String(reference?.asOf || '');
    const referenceDate = /^\d{4}-\d{2}-\d{2}/.test(asOf) ? asOf.slice(0, 10) : publicationDate;
    return reference?.status === 'available'
      && source.length > 0
      && !FORBIDDEN.test(source)
      && (carriedForward
        ? utcWeekendDate(date)
          && /^\d{4}-\d{2}-\d{2}$/.test(publicationDate)
          && publicationDate < date
          && reference?.carriedForward === true
          && referenceDate === publicationDate
        : referenceDate === date)
      && reference?.refreshFailed !== true
      && reference?.fromCache !== true
      && reference?.cachedOnly !== true
      && reference?.seeded !== true;
  });
}

function retainRiskRangeOverlaysWhilePending(previous, next) {
  if (!previous
    || previous.refreshFailed === true
    || previous.fromCache === true
    || previous.cachedOnly === true
    || previous.seeded === true
    || FORBIDDEN.test(String(previous.source || ''))
    || !next
    || next.riskRangeRefreshPending !== true
    || next.refreshFailed === true
    || next.fromCache === true
    || next.cachedOnly === true
    || next.seeded === true
    || FORBIDDEN.test(String(next.source || ''))
    || !Array.isArray(next.dailyRanges)) return next;
  const priorByDate = new Map((previous?.dailyRanges || [])
    .filter(verifiedDailyRiskRange)
    .map((range) => [range.date, range]));
  let retained = false;
  const dailyRanges = next.dailyRanges.map((range) => {
    if (verifiedDailyRiskRange(range)) return range;
    const prior = priorByDate.get(range?.date);
    if (!prior) return range;
    retained = true;
    return {
      ...range,
      status: 'available',
      references: prior.references.map((reference) => ({ ...reference })),
      ...(prior.structure ? { structure: prior.structure } : {}),
      reason: null,
      refreshPending: true,
      refreshRetained: true,
    };
  });
  if (!retained) return next;
  const missingDates = dailyRanges.filter((range) => !verifiedDailyRiskRange(range)).map((range) => range.date);
  return {
    ...next,
    dailyRanges,
    riskRangeStatus: missingDates.length ? 'partial' : 'available',
    riskRangeMissingDates: missingDates,
    riskRangeRefreshPending: true,
    riskRangeRefreshRetained: true,
  };
}

function buildDailyRange(date, points, historyResult, { carryAcrossNonPublicationSessions = false } = {}) {
  const exactRange = historyResult?.ranges?.[date];
  const carryDate = carryAcrossNonPublicationSessions && utcWeekendDate(date) && !exactRange
    ? Object.keys(historyResult?.ranges || {})
      .filter((candidateDate) => /^\d{4}-\d{2}-\d{2}$/.test(candidateDate) && candidateDate < date)
      .sort()
      .at(-1)
    : null;
  const publicationDate = exactRange ? date : carryDate;
  const sourceRange = exactRange || (carryDate ? historyResult?.ranges?.[carryDate] : null);
  const carriedForward = Boolean(sourceRange && publicationDate !== date);
  const lrr = finiteNumber(sourceRange?.lrr);
  const hrr = finiteNumber(sourceRange?.hrr);
  const forbiddenProvenance = [
    historyResult?.warning,
    historyResult?.provenance,
    historyResult?.cacheState,
    historyResult?.fromCache ? 'cached' : '',
    historyResult?.cached ? 'cached' : '',
    sourceRange?.warning,
    sourceRange?.provenance,
    sourceRange?.cacheState,
    sourceRange?.fromCache ? 'cached' : '',
    sourceRange?.cached ? 'cached' : '',
  ].filter(Boolean).join(' ');
  const startAt = points[0]?.timestamp || null;
  const endAt = points[points.length - 1]?.timestamp || startAt;
  if (lrr == null || hrr == null || lrr >= hrr || FORBIDDEN.test(forbiddenProvenance)) {
    return {
      date,
      startAt,
      endAt,
      status: 'unavailable',
      references: [],
      reason: `Exact-date Risk Range data is unavailable for ${date}.`,
    };
  }
  const source = sourceRange?.source || historyResult?.source || 'RiskRangeData';
  const asOf = sourceRange?.asOf || sourceRange?.date || publicationDate || date;
  const carryMetadata = carriedForward ? {
    riskRangePublicationDate: publicationDate,
    riskRangeCarryForward: 'last_published_non_publication_session',
  } : {};
  const referenceCarryMetadata = carriedForward ? {
    publicationDate,
    effectiveDate: date,
    carriedForward: true,
  } : {};
  return {
    date,
    startAt,
    endAt,
    status: 'available',
    references: [
      { status: 'available', kind: 'underlying', label: 'LRR', tone: 'low', value: lrr, source, asOf, ...referenceCarryMetadata },
      { status: 'available', kind: 'underlying', label: 'HRR', tone: 'high', value: hrr, source, asOf, ...referenceCarryMetadata },
    ],
    reason: null,
    ...carryMetadata,
  };
}

function verifiedSessionState(groups, config, nowMs, maxAgeMs = LIVE_BAR_MAX_AGE_MS) {
  const latestGroup = groups[groups.length - 1];
  const latest = latestGroup?.[1]?.[latestGroup[1].length - 1] || null;
  if (!latest) return null;
  const ageMs = nowMs - latest.timestamp;
  const current = ageMs >= -FUTURE_TOLERANCE_MS && ageMs <= maxAgeMs;
  const expectedHistoricalDate = typeof config.latestCompletedDate === 'function'
    ? config.latestCompletedDate(nowMs)
    : null;
  const historical = !current && latestGroup[0] === expectedHistoricalDate;
  if (!current && !historical) return null;
  return { latest, current, historical };
}

function chartSessionWindow(config, date, nowMs) {
  const session = config?.chartSession;
  if (!session || !date) return null;
  if (session.currentWindow?.sessionDate === date) {
    const startMs = Date.parse(session.currentWindow.startAt || '');
    const endMs = Date.parse(session.currentWindow.endAt || '');
    return {
      ...session.currentWindow,
      state: nowMs < startMs ? 'resolver_closed'
        : nowMs <= endMs ? 'resolver_open'
          : 'resolver_complete',
    };
  }
  return sessionWindowForDate(session.profile, date, { nowMs });
}

function missingSessionReason(config, range, nowMs) {
  const window = range === '1d' ? config?.chartSession?.currentWindow : null;
  const startMs = Date.parse(window?.startAt || '');
  if (Number.isFinite(startMs) && nowMs < startMs) {
    return `The selected resolver session is closed until ${window.startAt}; no underlying price is shown while it is closed.`;
  }
  return `Verified price history does not contain ${range === '1d' ? 'the selected resolver session' : `the required ${range.toUpperCase()} resolver sessions`}.`;
}

function buildSessionVariant({
  range,
  groups,
  sessionCount,
  config,
  nowMs,
  source,
  interval,
  fit,
  label,
  reason,
  riskRangeHistory,
}) {
  const unavailableReason = `Verified ${config.label} ${range.toUpperCase()} chart history is unavailable.`;
  const expectedWindow = range === '1d' ? config?.chartSession?.currentWindow || null : null;
  if (groups.length < sessionCount) {
    return unavailableChartVariant(range, missingSessionReason(config, range, nowMs), {
      fit, label, interval, sessionWindow: expectedWindow,
    });
  }
  const selected = groups.slice(-sessionCount);
  const maxAgeMs = interval === '1d'
    ? 30 * 60 * 60_000
    : interval === '1h' ? 75 * 60_000 : LIVE_BAR_MAX_AGE_MS;
  const state = verifiedSessionState(groups, config, nowMs, maxAgeMs);
  if (!state) return unavailableChartVariant(range, unavailableReason, {
    fit, label, interval, sessionWindow: expectedWindow,
  });
  const rangeDates = selected.map(([date]) => date);
  const points = selected.flatMap(([, sessionPoints]) => sessionPoints);
  const sessionWindow = chartSessionWindow(config, rangeDates[rangeDates.length - 1], nowMs);
  const sessionDate = rangeDates[rangeDates.length - 1] || null;
  const selectedCurrentSession = Boolean(
    config?.chartSession?.currentWindow?.sessionDate
      && config.chartSession.currentWindow.sessionDate === sessionDate,
  );
  const sessionMode = state.current
    && (selectedCurrentSession
      ? sessionWindow?.state === 'resolver_open'
      : !config?.chartSession?.currentWindow)
    ? 'current'
    : 'last_complete';
  const dailyRanges = selected.map(([date, sessionPoints]) => buildDailyRange(date, sessionPoints, riskRangeHistory, {
    carryAcrossNonPublicationSessions: config.carryRiskRangeAcrossNonPublicationSessions === true,
  }));
  const missingDates = dailyRanges.filter((dailyRange) => !riskRangeValues(dailyRange)).map((dailyRange) => dailyRange.date);
  const riskRangeRefreshPending = riskRangeHistory?.errorCode === 'RISK_RANGE_HISTORY_TIMEOUT';
  return {
    status: state.current ? 'available' : 'historical',
    availability: state.current ? 'live' : 'historical',
    range,
    interval,
    source,
    latestSource: state.latest.source || source,
    asOf: new Date(state.latest.timestamp).toISOString(),
    latestAt: new Date(state.latest.timestamp).toISOString(),
    latestValue: state.latest.value,
    historicalThroughDate: state.historical ? rangeDates[rangeDates.length - 1] : null,
    expiresAt: state.current
      ? new Date(state.latest.timestamp + maxAgeMs).toISOString()
      : new Date(nowMs + HISTORICAL_RETENTION_MS).toISOString(),
    points,
    references: [],
    rangeDates,
    dailyRanges,
    riskRangeStatus: missingDates.length ? 'partial' : 'available',
    riskRangeMissingDates: missingDates,
    riskRangeReason: riskRangeHistory?.reason || null,
    riskRangeRefreshPending,
    carryRiskRangeAcrossNonPublicationSessions: config.carryRiskRangeAcrossNonPublicationSessions === true,
    fit,
    label,
    executable: false,
    reason: [
      reason,
      range === '1d' && sessionMode === 'last_complete'
        ? 'Latest completed resolver session shown while the selected session is not yet renderable.'
        : null,
    ].filter(Boolean).join(' ') || null,
    sessionWindow,
    sessionMode,
    sessionDate,
    ...(state.latest.verifiedCurrent === true ? {
      includesVerifiedCurrentPoint: true,
      currentSessionSource: state.latest.source,
      currentSessionAsOf: new Date(state.latest.timestamp).toISOString(),
    } : {}),
  };
}

async function buildChartVariants({
  oneDayPoints,
  multiDayPoints,
  currentPoint = null,
  config,
  nowMs,
  source,
  oneDayInterval,
  multiDayInterval,
  fit = 'exact',
  label = null,
  successfulReason = null,
  calendarSessions = false,
  loadRiskRangeHistory,
  riskRangeWaitMs = RISK_RANGE_HISTORY_WAIT_MS,
}) {
  const oneDayWithCurrent = appendVerifiedCurrentPoint(oneDayPoints, currentPoint);
  const multiDayWithCurrent = appendVerifiedCurrentPoint(multiDayPoints, currentPoint);
  const chartSession = config?.chartSession || null;
  const multiDayChartSession = chartSession?.multiDayProfile
    ? { ...chartSession, profile: chartSession.multiDayProfile, currentWindow: null }
    : chartSession;
  const currentDate = chartSession
    ? resolverSessionDateForPoint(chartSession, currentPoint?.timestamp, {
        currentOnly: Boolean(chartSession.currentWindow),
      })
    : historicalBarDateKey(currentPoint?.timestamp);
  const oneDayGroups = groupPointsBySession(oneDayWithCurrent, {
    calendarSessions,
    chartSession,
    currentWindowOnly: Boolean(chartSession?.currentWindow),
  });
  const completedOneDayGroups = groupPointsBySession(oneDayWithCurrent, {
    calendarSessions,
    chartSession,
  }).filter(([date]) => (
    !chartSession?.currentWindow?.sessionDate
      || (date < chartSession.currentWindow.sessionDate
        && chartSessionWindow(config, date, nowMs)?.state === 'resolver_complete')
  ));
  const dailyMultiDayHistory = multiDayInterval === '1d';
  const multiDayOneDayGroups = groupPointsBySession(multiDayWithCurrent, {
    calendarSessions,
    chartSession,
    currentWindowOnly: Boolean(chartSession?.currentWindow),
    allowSingletonSessions: dailyMultiDayHistory,
  });
  const completedMultiDayOneDayGroups = groupPointsBySession(multiDayWithCurrent, {
    calendarSessions,
    chartSession,
    allowSingletonSessions: dailyMultiDayHistory,
  }).filter(([date]) => (
    !chartSession?.currentWindow?.sessionDate
      || (date < chartSession.currentWindow.sessionDate
        && chartSessionWindow(config, date, nowMs)?.state === 'resolver_complete')
  ));
  const multiDayGroups = groupPointsBySession(multiDayWithCurrent, {
    calendarSessions,
    chartSession: multiDayChartSession,
    allowSingletonSessions: dailyMultiDayHistory,
    // An hourly current session is not eligible for a 5D/10D window until it
    // has at least two verified observations. Until then the last completed
    // session remains the ending session instead of creating a one-point day
    // that the chart cannot render.
    allowFreshSingletonDate: dailyMultiDayHistory ? currentDate : null,
    nowMs,
  });
  const requestedDates = (multiDayGroups.length ? multiDayGroups : oneDayGroups)
    .slice(-10)
    .map(([date]) => date);
  let riskRangeHistory = { status: 'unavailable', ranges: {}, reason: 'Verified daily Risk Range history is unavailable.' };
  if (requestedDates.length && typeof loadRiskRangeHistory === 'function') {
    const result = await settleWithin(loadRiskRangeHistory({
      ticker: config.riskRangeTicker,
      dates: requestedDates,
    }), riskRangeWaitMs);
    if (result.status === 'fulfilled' && result.value && typeof result.value === 'object') {
      riskRangeHistory = result.value;
    } else if (result.status === 'rejected') {
      riskRangeHistory = {
        status: 'unavailable',
        ranges: {},
        reason: String(result.reason?.message || result.reason || 'Verified daily Risk Range history is unavailable.'),
      };
    } else if (result.status === 'pending') {
      riskRangeHistory = {
        status: 'unavailable',
        ranges: {},
        reason: 'Risk Range history timed out; verified price history remains available without overlays.',
        errorCode: 'RISK_RANGE_HISTORY_TIMEOUT',
      };
    }
  }
  const currentFineOneDay = buildSessionVariant({
    range: '1d', groups: oneDayGroups, sessionCount: 1, config, nowMs, source,
    interval: oneDayInterval, fit, label, reason: successfulReason, riskRangeHistory,
  });
  const currentCoarseOneDay = config.allowCoarserOneDay !== false
    && multiDayOneDayGroups.length
    ? buildSessionVariant({
        range: '1d', groups: multiDayOneDayGroups, sessionCount: 1, config, nowMs, source,
        interval: multiDayInterval, fit, label, reason: successfulReason, riskRangeHistory,
      })
    : null;
  const completedFineOneDay = chartSession?.currentWindow && completedOneDayGroups.length
    ? buildSessionVariant({
        range: '1d', groups: completedOneDayGroups, sessionCount: 1, config, nowMs, source,
        interval: oneDayInterval, fit, label, reason: successfulReason, riskRangeHistory,
      })
    : null;
  const completedCoarseOneDay = config.allowCoarserOneDay !== false
    && chartSession?.currentWindow
    && completedMultiDayOneDayGroups.length
    ? buildSessionVariant({
        range: '1d', groups: completedMultiDayOneDayGroups, sessionCount: 1, config, nowMs, source,
        interval: multiDayInterval, fit, label, reason: successfulReason, riskRangeHistory,
      })
    : null;
  const usableVariant = (variant) => ['available', 'historical'].includes(variant?.status);
  const selectedOneDay = [
    { variant: currentFineOneDay, coarse: false },
    { variant: currentCoarseOneDay, coarse: true },
    { variant: completedFineOneDay, coarse: false },
    { variant: completedCoarseOneDay, coarse: true },
  ].find(({ variant }) => usableVariant(variant)) || { variant: currentFineOneDay, coarse: false };
  const oneDay = selectedOneDay.coarse
    ? {
        ...selectedOneDay.variant,
        resolutionState: 'coarser_verified',
        preferredInterval: oneDayInterval,
        refreshFailed: false,
        reason: [
          selectedOneDay.variant?.reason,
          `Verified ${multiDayInterval} bars are shown while ${oneDayInterval} history refreshes.`,
        ].filter(Boolean).join(' '),
      }
    : selectedOneDay.variant;
  const variants = {
    '1d': oneDay,
    '5d': buildSessionVariant({
      range: '5d', groups: multiDayGroups, sessionCount: 5, config, nowMs, source,
      interval: multiDayInterval, fit, label, reason: successfulReason, riskRangeHistory,
    }),
    '10d': buildSessionVariant({
      range: '10d', groups: multiDayGroups, sessionCount: 10, config, nowMs, source,
      interval: multiDayInterval, fit, label, reason: successfulReason, riskRangeHistory,
    }),
  };
  return chartContract(variants, `Verified ${config.label} chart history is unavailable.`, fit);
}

function refreshFailure(section, error) {
  return {
    ...section,
    refreshFailed: true,
    refreshIssue: String(error?.message || error || section?.reason || 'Source refresh failed.').slice(0, 160),
  };
}

function settleWithin(promise, waitMs = IBKR_WORKER_WAIT_MS) {
  return Promise.race([
    Promise.resolve(promise).then(
      (value) => ({ status: 'fulfilled', value }),
      (reason) => ({ status: 'rejected', reason }),
    ),
    new Promise((resolve) => setTimeout(() => resolve({ status: 'pending' }), waitMs)),
  ]);
}

function isConnected(status) {
  return status?.connected === true
    || String(status?.status || '').toLowerCase() === 'connected';
}

function providerConnectionState(status) {
  if (isConnected(status)) return 'connected';
  const token = String(status?.status || '').trim().toLowerCase();
  const evidence = `${token} ${status?.message || status?.error || ''}`;
  if (['disconnected', 'offline', 'not_connected', 'disabled'].includes(token)
    || /(?:gateway|broker|ibkr).*(?:disconnected|offline|not connected)/i.test(evidence)) {
    return 'disconnected';
  }
  return 'indeterminate';
}

function latestCompletedGoldPythSessionDate(nowMs = Date.now()) {
  return latestCompletedSpxSessionDate(Number(nowMs) - (60 * 60_000));
}

function isLiveDataType(value) {
  return value === 1 || String(value || '').trim().toLowerCase() === 'live';
}

function normalizeLiveQuote(result, label, nowMs, { requireLast = false } = {}) {
  const quote = result?.canonical || result;
  const value = finiteNumber(requireLast ? quote?.last : quote?.mark ?? quote?.last ?? quote?.mid);
  const asOfMs = Date.parse(quote?.timestamp || '');
  const provenance = [quote?.source, quote?.warning, quote?.entitlementStatus, result?.error]
    .filter(Boolean).join(' ');
  if (
    quote?.valid !== true
    || String(quote?.source || '').toLowerCase() !== 'ibkr'
    || !isLiveDataType(quote?.dataType)
    || value == null
    || value <= 0
    || !Number.isFinite(asOfMs)
    || nowMs - asOfMs < -FUTURE_TOLERANCE_MS
    || nowMs - asOfMs > LIVE_QUOTE_MAX_AGE_MS
    || FORBIDDEN.test(provenance)
  ) return unavailable(`Verified live ${label} resolver reference is unavailable.`, { value: null, label });
  return {
    status: 'available',
    availability: 'live',
    value,
    label: `LIVE ${label}`,
    source: 'ibkr_live_native_quote',
    asOf: new Date(asOfMs).toISOString(),
    expiresAt: new Date(asOfMs + LIVE_QUOTE_MAX_AGE_MS).toISOString(),
    fit: 'exact',
    executable: false,
    reason: null,
    priceType: requireLast ? 'direct_last_trade' : 'native_quote_value',
  };
}

function normalizeIbkrChart(history, config, nowMs) {
  const reason = `Verified ${config.label} resolver chart is unavailable.`;
  if (String(history?.source || '').toLowerCase() !== 'ibkr' || FORBIDDEN.test(String(history?.error || ''))) {
    return unavailable(reason, { points: [], references: [] });
  }
  let points = normalizeUnderlyingBars(history?.bars || [], nowMs);
  const expectedHistoricalDate = config.latestCompletedDate(nowMs);
  if (config.interval === '1d' && expectedHistoricalDate) {
    const expectedIndex = points.map((point) => historicalBarDateKey(point.timestamp)).lastIndexOf(expectedHistoricalDate);
    if (expectedIndex >= 0) points = points.slice(0, expectedIndex + 1);
  }
  const latest = points[points.length - 1];
  if (!latest || points.length < 2) return unavailable(reason, { points: [], references: [] });
  const ageMs = nowMs - latest.timestamp;
  const current = ageMs >= 0 && ageMs <= LIVE_BAR_MAX_AGE_MS;
  const historical = !current && historicalBarDateKey(latest.timestamp) === expectedHistoricalDate;
  if (!current && !historical) return unavailable(reason, { points: [], references: [] });
  return {
    status: historical ? 'historical' : 'available',
    availability: historical ? 'historical' : 'live',
    range: config.range || '1d',
    interval: config.interval || null,
    source: 'ibkr_historical_bars',
    asOf: new Date(latest.timestamp).toISOString(),
    latestAt: new Date(latest.timestamp).toISOString(),
    latestValue: latest.value,
    historicalThroughDate: historical ? expectedHistoricalDate : null,
    expiresAt: current
      ? new Date(latest.timestamp + LIVE_BAR_MAX_AGE_MS).toISOString()
      : new Date(nowMs + HISTORICAL_RETENTION_MS).toISOString(),
    points,
    references: [],
    fit: config.fit || 'exact',
    executable: false,
    reason: null,
  };
}

function dynamicGcInstrument(nowMs = Date.now()) {
  const date = new Date(nowMs);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const deliveryMonths = [2, 4, 6, 8, 10, 12];
  let deliveryYear = year;
  let deliveryMonth = deliveryMonths.find((candidate) => candidate > month || (candidate === month && date.getUTCDate() <= 10));
  if (!deliveryMonth) {
    deliveryYear += 1;
    [deliveryMonth] = deliveryMonths;
  }
  const monthCodes = { 2: 'G', 4: 'J', 6: 'M', 8: 'Q', 10: 'V', 12: 'Z' };
  const contractMonth = `${deliveryYear}${String(deliveryMonth).padStart(2, '0')}`;
  return {
    symbol: 'GC',
    displaySymbol: `GC${monthCodes[deliveryMonth]}${String(deliveryYear).slice(-2)}`,
    ibkrSymbol: 'GC',
    secType: 'FUT',
    exchange: 'COMEX',
    currency: 'USD',
    lastTradeDateOrContractMonth: contractMonth,
    multiplier: '100',
    provider: 'ibkr',
  };
}

function dynamicSiInstrument(nowMs = Date.now()) {
  const date = new Date(nowMs);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const deliveryMonths = [3, 5, 7, 9, 12];
  let deliveryYear = year;
  let deliveryMonth = deliveryMonths.find((candidate) => candidate > month || (candidate === month && date.getUTCDate() <= 10));
  if (!deliveryMonth) {
    deliveryYear += 1;
    [deliveryMonth] = deliveryMonths;
  }
  const monthCodes = { 3: 'H', 5: 'K', 7: 'N', 9: 'U', 12: 'Z' };
  const contractMonth = `${deliveryYear}${String(deliveryMonth).padStart(2, '0')}`;
  return {
    symbol: 'SI',
    displaySymbol: `SI${monthCodes[deliveryMonth]}${String(deliveryYear).slice(-2)}`,
    ibkrSymbol: 'SI',
    secType: 'FUT',
    exchange: 'COMEX',
    currency: 'USD',
    lastTradeDateOrContractMonth: contractMonth,
    multiplier: '5000',
    provider: 'ibkr',
  };
}

function dynamicBzInstrument(nowMs = Date.now()) {
  // ICE Brent expires before its delivery month. A three-month lead provides
  // a current, independently verified BZ context contract without claiming it
  // is the stable Pyth index used by the prediction contract.
  const delivery = new Date(Date.UTC(
    new Date(nowMs).getUTCFullYear(),
    new Date(nowMs).getUTCMonth() + 3,
    1,
  ));
  const deliveryYear = delivery.getUTCFullYear();
  const deliveryMonth = delivery.getUTCMonth() + 1;
  const monthCodes = ['F', 'G', 'H', 'J', 'K', 'M', 'N', 'Q', 'U', 'V', 'X', 'Z'];
  return {
    symbol: 'BZ',
    displaySymbol: `BZ${monthCodes[deliveryMonth - 1]}${String(deliveryYear).slice(-2)}`,
    ibkrSymbol: 'BZ',
    secType: 'FUT',
    exchange: 'NYMEX',
    currency: 'USD',
    lastTradeDateOrContractMonth: `${deliveryYear}${String(deliveryMonth).padStart(2, '0')}`,
    multiplier: '1000',
    provider: 'ibkr',
  };
}

function brentIbkrInstrument(selected, nowMs = Date.now()) {
  const marketRows = selected?.markets
    || selected?.catalog?.lines
    || selected?.contracts?.lines
    || [];
  const contractIds = [...new Set(marketRows
    .map((market) => String(
      market?.custom_strike?.front_month_contract
      || market?.customStrike?.front_month_contract
      || '',
    ).trim().toUpperCase())
    .filter(Boolean))];
  if (contractIds.length !== 1) return null;
  // The current KXBRENTD family settles on the stable Pyth Brent index and
  // publishes N/A instead of a dated resolver contract. Its chart proxy must
  // therefore come from the independently selected liquid BZ basis, not a
  // calendar guess several months forward.
  if (contractIds[0] === 'N/A') return null;
  const match = contractIds[0].match(/^BRENT([FGHJKMNQUVXZ])(\d{1,2})$/);
  if (!match) return null;
  const monthByCode = { F: 1, G: 2, H: 3, J: 4, K: 5, M: 6, N: 7, Q: 8, U: 9, V: 10, X: 11, Z: 12 };
  const yearDigits = Number(match[2]);
  const deliveryYear = match[2].length === 1 ? 2020 + yearDigits : 2000 + yearDigits;
  const deliveryMonth = monthByCode[match[1]];
  if (!deliveryMonth || deliveryYear < 2020 || deliveryYear > 2099) return null;
  return {
    symbol: 'BZ',
    displaySymbol: `BZ${match[1]}${String(deliveryYear).slice(-2)}`,
    ibkrSymbol: 'BZ',
    secType: 'FUT',
    exchange: 'NYMEX',
    currency: 'USD',
    lastTradeDateOrContractMonth: `${deliveryYear}${String(deliveryMonth).padStart(2, '0')}`,
    multiplier: '1000',
    provider: 'ibkr',
  };
}

function referenceVenueId(selected) {
  const value = selected?.id
    || selected?.venueId
    || selected?.catalog?.event?.venueId
    || selected?.event?.venueId
    || selected?.event?.venue;
  if (value) return String(value).trim().toLowerCase();
  if (selected?.event?.event_ticker || Array.isArray(selected?.markets)) return 'kalshi';
  if (selected?.resolverIdentity || selected?.catalog?.event?.productCode) return 'forecastex';
  return null;
}

function withResolverChartSession(config, selected, nowMs = Date.now()) {
  if (!config) return config;
  return {
    ...config,
    chartSession: buildResolverChartSession({
      marketId: config.marketId,
      selected,
      instrument: config.instrument,
      nowMs,
    }),
  };
}

function goldSpotProxyConfig() {
  return {
    marketId: 'gold',
    label: 'XAUUSD',
    instrument: GOLD_SPOT_PROXY_INSTRUMENT,
    resolver: 'IBKR XAUUSD spot gold proxy for Kalshi Pyth Metal.Index.GOLD/USD',
    latestCompletedDate: latestCompletedGoldPythSessionDate,
    riskRangeTicker: 'GLD',
    requireLast: true,
    allowCurrentBarSpot: true,
    preferIntradayHistory: true,
    priorityIntradayHistory: true,
    multiDayInterval: '1h',
    // Keep 1D populated from verified same-instrument hourly bars while the
    // preferred five-minute request refreshes. The chart marks this state as
    // `coarser_verified`; it is never synthetic or cross-instrument data.
    allowCoarserOneDay: true,
    skipProxyFit: true,
    proxyReason: 'Verified live IBKR XAUUSD spot-gold proxy; not the Pyth resolver and non-executable.',
    proxyHistoryReason: 'Verified IBKR XAUUSD midpoint history shown as proxy context only.',
  };
}

function compactGoldInstrument(instrument = null) {
  if (!instrument) return null;
  return {
    symbol: instrument.symbol || instrument.ibkrSymbol || null,
    displaySymbol: instrument.displaySymbol || instrument.localSymbol || instrument.symbol || null,
    conId: Number.isInteger(Number(instrument.conId || instrument.conid))
      ? Number(instrument.conId || instrument.conid)
      : null,
    secType: instrument.secType || null,
    exchange: instrument.exchange || null,
    currency: instrument.currency || 'USD',
    contractMonth: instrument.lastTradeDateOrContractMonth || null,
  };
}

function goldResolverContractMatches(activeInstrument, resolverReference, selected) {
  if (referenceVenueId(selected) !== 'forecastex' || resolverReference?.fit !== 'exact') return false;
  const resolverInstrument = resolverReference?.instrument;
  if (!activeInstrument || !resolverInstrument) return false;
  const activeRoot = String(activeInstrument.symbol || activeInstrument.ibkrSymbol || '').toUpperCase();
  const resolverRoot = String(resolverInstrument.symbol || resolverInstrument.ibkrSymbol || '').toUpperCase();
  if (activeRoot !== 'GC' || resolverRoot !== 'GC') return false;
  const activeConId = Number(activeInstrument.conId || activeInstrument.conid);
  const resolverConId = Number(resolverInstrument.conId || resolverInstrument.conid);
  if (Number.isInteger(activeConId) && activeConId > 0
    && Number.isInteger(resolverConId) && resolverConId > 0) {
    return activeConId === resolverConId;
  }
  const activeMonth = String(activeInstrument.lastTradeDateOrContractMonth || '').slice(0, 6);
  const resolverMonth = String(resolverInstrument.lastTradeDateOrContractMonth || '').slice(0, 6);
  return /^\d{6}$/.test(activeMonth) && activeMonth === resolverMonth;
}

function goldReferenceItem({
  key,
  label,
  symbol,
  role,
  reference,
  instrument = null,
  nowMs = Date.now(),
  unavailableReason,
}) {
  const spot = reference?.spot || null;
  const statusToken = String(spot?.status || '').toLowerCase();
  const availability = String(spot?.availability || '').toLowerCase();
  const source = String(spot?.source || '').trim();
  const asOfMs = Date.parse(spot?.asOf || '');
  const expiresAtMs = Date.parse(spot?.expiresAt || '');
  const provenance = [
    source,
    spot?.warning,
    spot?.provenance,
    spot?.cacheStatus,
    spot?.cacheState,
    spot?.fromCache ? 'cached' : null,
    spot?.cachedOnly ? 'cached-only' : null,
    spot?.refreshFailed ? 'refresh-failed' : null,
    spot?.mock ? 'mock' : null,
    spot?.seeded ? 'seed' : null,
  ].filter(Boolean).join(' ');
  const price = finiteNumber(spot?.value);
  const previousClose = finiteNumber(spot?.previousClose);
  const liveMaxAgeMs = source.toLowerCase() === 'ibkr_historical_bars'
    ? LIVE_BAR_MAX_AGE_MS
    : LIVE_QUOTE_MAX_AGE_MS;
  const live = statusToken === 'available'
    && availability === 'live'
    && price != null
    && price > 0
    && source
    && !FORBIDDEN.test(provenance)
    && Number.isFinite(asOfMs)
    && nowMs - asOfMs >= -FUTURE_TOLERANCE_MS
    && nowMs - asOfMs <= liveMaxAgeMs
    && Number.isFinite(expiresAtMs)
    && expiresAtMs >= nowMs;
  const historical = statusToken === 'historical'
    && availability === 'historical'
    && price != null
    && price > 0
    && source
    && !FORBIDDEN.test(provenance)
    && Number.isFinite(asOfMs)
    && historicalBarDateKey(asOfMs) === latestCompletedWtiSessionDate(nowMs);
  const loading = ['loading', 'refreshing'].includes(statusToken) && !spot?.refreshFailed;
  const displayStatus = live ? 'live' : historical ? 'historical' : loading ? 'loading' : 'unavailable';
  const displayPrice = live || historical ? price : null;
  const displayPreviousClose = (live || historical) && previousClose != null && previousClose > 0
    ? previousClose
    : null;
  const changePercent = displayPrice != null && displayPreviousClose != null
    ? ((displayPrice - displayPreviousClose) / displayPreviousClose) * 100
    : null;
  const exactAccessReason = ['PYTH_ENTITLEMENT_REQUIRED', 'PYTH_AUTH_REQUIRED'].includes(spot?.errorCode)
    ? 'Live exact Pyth Gold API access requires a paid entitlement; use the exact Pyth Terminal link or the official Kalshi final after settlement.'
    : null;
  return {
    key,
    label,
    symbol,
    role,
    status: displayStatus,
    price: displayPrice,
    previousClose: displayPreviousClose,
    changePercent: Number.isFinite(changePercent) ? changePercent : null,
    unit: 'USD/ozt',
    source: live || historical ? source : null,
    instrument: compactGoldInstrument(instrument || reference?.instrument),
    asOf: live || historical ? new Date(asOfMs).toISOString() : null,
    expiresAt: live ? new Date(expiresAtMs).toISOString() : null,
    reason: live || historical
      ? null
      : exactAccessReason
        || spot?.refreshIssue
        || spot?.reason
        || unavailableReason
        || 'Verified Gold reference is unavailable.',
  };
}

function forecastCommodityReferenceConfig(marketId, selected, nowMs = Date.now()) {
  if (referenceVenueId(selected) !== 'forecastex') return null;
  const identity = selected?.resolverIdentity || selected?.catalog?.event || selected?.event || {};
  const registeredProduct = Object.entries(FORECAST_COMMODITY_PRODUCTS)
    .find(([, definition]) => definition.marketId === marketId);
  const expected = registeredProduct
    ? {
      productCode: registeredProduct[0],
      label: registeredProduct[1].assetLabel,
      riskRangeTicker: marketId === 'gold' ? 'GLD' : 'SILVER',
    }
    : marketId === 'wti'
      ? { productCode: 'COMCO', label: 'WTI', riskRangeTicker: 'WTIC' }
      : null;
  const productCode = selected?.catalog?.event?.productCode || selected?.event?.productCode;
  if (!expected || productCode !== expected.productCode) return null;
  const exactInstrument = buildExactForecastCommodityInstrument(identity);
  const instrument = exactInstrument || (marketId === 'gold'
    ? dynamicGcInstrument(nowMs)
    : marketId === 'silver' ? dynamicSiInstrument(nowMs) : null);
  if (!instrument) return null;
  const fit = exactInstrument ? 'exact' : 'proxy';
  return {
    marketId,
    label: instrument.displaySymbol,
    instrument,
    resolver: exactInstrument
      ? `ForecastEx ${expected.productCode} exact dated ${instrument.displaySymbol} settlement reference`
      : `COMEX ${instrument.displaySymbol} proxy; ForecastEx ${expected.productCode} did not publish the exact resolver month`,
    latestCompletedDate: latestCompletedWtiSessionDate,
    riskRangeTicker: expected.riskRangeTicker,
    fit,
    exactResolverAvailable: Boolean(exactInstrument),
  };
}

function referenceConfig(marketId, selected, nowMs = Date.now()) {
  if (marketId === 'sp500') {
    const resolverIdentity = selected?.resolverIdentity || selected?.event || {};
    const instrument = buildExactEsFutureInstrument(resolverIdentity);
    return {
      marketId,
      label: resolverIdentity.resolverSymbol || 'ES',
      instrument,
      resolver: instrument
        ? `CME ${instrument.displaySymbol} dated E-mini S&P 500 future`
        : 'Exact dated FES E-mini S&P 500 future unavailable',
      latestCompletedDate: latestCompletedSpxSessionDate,
      riskRangeTicker: 'SPX',
      requireLast: true,
    };
  }
  if (marketId === 'wti') {
    const forecast = forecastCommodityReferenceConfig(marketId, selected, nowMs);
    if (forecast) return forecast;
    if (referenceVenueId(selected) === 'forecastex') {
      return {
        marketId,
        label: 'WTI',
        instrument: null,
        resolver: 'The exact dated ForecastEx COMCO resolver instrument is unavailable.',
        latestCompletedDate: latestCompletedWtiSessionDate,
        riskRangeTicker: 'WTIC',
      };
    }
    const verifiedBasis = selected?.settlementBasis?.status === 'verified'
      && selected?.settlementBasis?.instrumentScope === 'exact'
      ? {
          status: 'consistent_unverified',
          source: { name: selected.settlementBasis.sourceName },
          frontMonthContract: selected.settlementBasis.instrument,
        }
      : null;
    const settlementMapping = verifiedBasis || buildWtiSettlementMapping(
      selected?.event || eventFromSelection(selected) || {},
      selected?.markets || [],
    );
    const rawInstrument = wtiIbkrInstrument(settlementMapping);
    const contractLabelMatch = String(settlementMapping?.frontMonthContract || '')
      .trim().toUpperCase().match(/^WBS\s+(\d{2})([FGHJKMNQUVXZ])-ICE$/);
    const instrument = rawInstrument ? {
      ...rawInstrument,
      displaySymbol: contractLabelMatch
        ? `WBS${contractLabelMatch[2]}${contractLabelMatch[1]}`
        : rawInstrument.displaySymbol || 'WTI',
    } : null;
    return {
      marketId,
      label: instrument?.displaySymbol || 'WTI',
      instrument,
      resolver: 'ICE WBS dated settlement contract',
      latestCompletedDate: latestCompletedWtiSessionDate,
      riskRangeTicker: 'WTIC',
      preferIntradayHistory: true,
      allowCoarserOneDay: true,
      riskRangeWaitMs: 25,
    };
  }
  if (marketId === 'nasdaq100') {
    return {
      marketId,
      label: 'NDX',
      instrument: NDX_INSTRUMENT,
      resolver: 'cash Nasdaq-100 index',
      latestCompletedDate: latestCompletedSpxSessionDate,
      riskRangeTicker: 'COMPQ',
    };
  }
  if (marketId === 'silver') {
    const instrument = dynamicSiInstrument(nowMs);
    return {
      marketId,
      label: instrument.displaySymbol,
      instrument,
      resolver: `COMEX ${instrument.displaySymbol} · proxy for Pyth Silver`,
      latestCompletedDate: latestCompletedWtiSessionDate,
      riskRangeTicker: 'SILVER',
      fit: 'proxy',
    };
  }
  if (marketId === 'brent') {
    const instrument = brentIbkrInstrument(selected, nowMs);
    const publishedContract = selected?.markets?.[0]?.custom_strike?.front_month_contract
      || selected?.markets?.[0]?.customStrike?.front_month_contract
      || selected?.catalog?.lines?.[0]?.customStrike?.front_month_contract
      || selected?.contracts?.lines?.[0]?.customStrike?.front_month_contract
      || 'Brent';
    return {
      marketId,
      label: instrument?.displaySymbol || 'BRENT',
      instrument,
      resolver: instrument
        ? `NYMEX ${instrument.displaySymbol} · proxy for Kalshi Pyth ${publishedContract}`
        : 'The event-specific Brent front-month proxy is unavailable',
      latestCompletedDate: latestCompletedGoldPythSessionDate,
      riskRangeTicker: 'BRENT',
      fit: 'proxy',
      preferIntradayHistory: true,
      allowCoarserOneDay: true,
      riskRangeWaitMs: 25,
    };
  }
  return null;
}

function pythApiKey() {
  return process.env.PYTH_API_KEY || process.env.HERMES_API_KEY || null;
}

function pythSettlementMetadata(selected) {
  if (!selected) return { observed: false, pyth: false, symbol: null, text: '' };
  const settlementSources = selected?.event?.settlement_sources
    || selected?.event?.settlementSources
    || selected?.catalog?.event?.settlementSources
    || [];
  const marketRows = selected?.markets
    || selected?.catalog?.lines
    || selected?.contracts?.lines
    || [];
  const evidence = {
    settlementSources,
    eventRules: [selected?.event?.rules_primary, selected?.event?.rules_secondary, selected?.event?.rulesUrl],
    markets: marketRows.map((market) => ({
      rulesPrimary: market?.rules_primary || market?.rulesPrimary,
      rulesSecondary: market?.rules_secondary || market?.rulesSecondary,
      customStrike: market?.custom_strike || market?.customStrike,
    })),
  };
  const text = JSON.stringify(evidence);
  const sourceSymbols = [...new Set(settlementSources
    .map((source) => pythExplorerSymbol(source?.url))
    .filter(Boolean))];
  const explicitSymbol = sourceSymbols.length === 1 ? sourceSymbols[0] : null;
  return {
    observed: true,
    pyth: /pyth/i.test(text),
    symbol: explicitSymbol,
    text,
  };
}

function pythReferenceConfig(marketId, selected) {
  const settlement = pythSettlementMetadata(selected);
  if (settlement.observed && !settlement.pyth) return null;
  const identity = PYTH_RESOLVER_IDENTITIES[marketId] || null;
  if (['gold', 'silver'].includes(marketId)) {
    if (!identity || settlement.symbol !== identity.symbol) return null;
    return {
      symbol: identity.symbol,
      label: identity.label,
      assetType: identity.assetType,
      riskRangeTicker: identity.riskRangeTicker,
      settlementValidated: settlement.pyth,
    };
  }
  if (marketId === 'brent') {
    const marketRows = selected?.markets
      || selected?.catalog?.lines
      || selected?.contracts?.lines
      || [];
    const contracts = [...new Set(marketRows
      .map((market) => String(
        market?.custom_strike?.front_month_contract
        || market?.customStrike?.front_month_contract
        || '',
      ).trim().toUpperCase())
      .filter(Boolean))];
    const datedContract = contracts.length === 1 && /^BRENT[FGHJKMNQUVXZ]\d{1,2}$/.test(contracts[0])
      ? contracts[0]
      : null;
    const indexStyle = contracts.length === 1 && contracts[0] === 'N/A';
    if (!datedContract && !indexStyle) return null;
    const expectedSymbol = datedContract
      ? `Commodities.${datedContract}/USD`
      : identity.symbol;
    if (settlement.symbol && settlement.symbol !== expectedSymbol) return null;
    if (!settlement.symbol && !indexStyle) return null;
    return {
      symbol: expectedSymbol,
      label: datedContract || identity.label,
      assetType: identity.assetType,
      riskRangeTicker: identity.riskRangeTicker,
      settlementValidated: settlement.pyth,
    };
  }
  return null;
}

function pythFailure(error, fallback) {
  const status = Number(error?.response?.status);
  const raw = status === 403
    ? 'Live Pyth history requires an entitled API subscription; the exact resolver remains available from the official Pyth source link.'
    : status === 401
      ? 'Live Pyth history requires an authenticated API key; the exact resolver remains available from the official Pyth source link.'
      : error?.response?.data?.message || error?.response?.data?.detail || error?.message || fallback;
  return {
    code: status === 403 ? 'PYTH_ENTITLEMENT_REQUIRED'
      : status === 401 ? 'PYTH_AUTH_REQUIRED'
        : 'PYTH_REFRESH_FAILED',
    message: String(raw || fallback).slice(0, 240),
  };
}

function pythEntitlementState(failure, { configured = true } = {}) {
  if (!configured) return 'authenticated_history_unavailable';
  if (failure?.code === 'PYTH_ENTITLEMENT_REQUIRED') return 'api_entitlement_required';
  if (failure?.code === 'PYTH_AUTH_REQUIRED') return 'authentication_required';
  return failure ? 'configured_unavailable' : 'entitled';
}

async function loadPythReference({ marketId, selected, client, nowMs, loadRiskRangeHistory }) {
  const config = pythReferenceConfig(marketId, selected);
  const chartSession = buildResolverChartSession({ marketId, selected, nowMs });
  const key = pythApiKey();
  const label = config?.label || String(marketId || '').toUpperCase();
  const resolver = config ? `Pyth ${config.symbol}` : null;
  const exactSourceUrl = marketId === 'brent'
    ? 'https://pyth.dourolabs.app/v1/symbols?query=BRENT'
    : config?.symbol
      ? `${PYTH_HISTORY_URL}/symbols?query=${encodeURIComponent(config.symbol)}`
      : null;
  const entitlement = pythEntitlementState(null, { configured: Boolean(key) });
  const unavailableReason = !config
    ? `The exact ${label} Pyth resolver symbol could not be derived from the current contract.`
    : !key
      ? `Live Pyth history requires an authenticated entitlement; no paid API is configured. Use the official Pyth source link for the exact ${label} resolver.`
      : `Verified live Pyth ${config.symbol} is unavailable.`;
  const emptySpot = unavailable(unavailableReason, {
    value: null,
    label,
    fit: 'exact',
    executable: false,
    errorCode: !key ? 'PYTH_ENTITLEMENT_REQUIRED' : null,
  });
  const emptyChart = chartContract({
    '1d': unavailableChartVariant('1d', `Verified Pyth ${label} history is unavailable.`, {
      fit: 'exact',
      sessionWindow: chartSession?.currentWindow || null,
    }),
  }, `Verified Pyth ${label} history is unavailable.`, 'exact');
  if (!config || !key) return {
    spot: emptySpot,
    chart: emptyChart,
    resolver,
    fit: 'exact',
    exactSourceUrl,
    entitlement,
  };
  const headers = { Authorization: `Bearer ${key}` };
  let symbol;
  try {
    const response = await client.get(`${PYTH_HISTORY_URL}/symbols`, {
      params: { query: config.symbol },
      headers,
      timeout: 8_000,
    });
    const rows = Array.isArray(response?.data)
      ? response.data
      : Array.isArray(response?.data?.data) ? response.data.data : [];
    symbol = rows.find((row) => String(row?.symbol || '').toUpperCase() === config.symbol.toUpperCase());
    if (!symbol
      || String(symbol.state || '').toLowerCase() !== 'stable'
      || String(symbol.asset_type || '').toLowerCase() !== config.assetType
      || finiteNumber(symbol.pyth_lazer_id) == null
      || !String(symbol.min_channel || '').startsWith('fixed_rate@')) {
      throw Object.assign(new Error(`Pyth symbol metadata for ${config.symbol} is invalid.`), { code: 'PYTH_SYMBOL_INVALID' });
    }
  } catch (error) {
    const failure = pythFailure(error, `Pyth symbol metadata for ${config.symbol} is unavailable.`);
    return {
      spot: { ...emptySpot, refreshFailed: true, refreshIssue: failure.message, errorCode: error?.code || failure.code },
      chart: { ...emptyChart, refreshFailed: true, refreshIssue: failure.message, errorCode: error?.code || failure.code },
      resolver,
      fit: 'exact',
      exactSourceUrl,
      entitlement: pythEntitlementState(failure),
    };
  }

  const feedId = Number(symbol.pyth_lazer_id);
  const channel = String(symbol.min_channel);
  const oneDayFrom = Math.floor((nowMs - DAY_MS) / 1000);
  const tenSessionFrom = Math.floor((nowMs - 14 * DAY_MS) / 1000);
  const to = Math.floor(nowMs / 1000);
  const [latestResult, oneDayResult, multiDayResult] = await Promise.allSettled([
    client.post(`${PYTH_LAZER_URL}/v1/latest_price`, {
      priceFeedIds: [feedId],
      properties: ['price', 'exponent', 'feedUpdateTimestamp'],
      formats: [],
      channel,
    }, { headers, timeout: 8_000 }),
    client.get(`${PYTH_HISTORY_URL}/${channel}/history`, {
      params: { symbol: config.symbol, resolution: '5', from: oneDayFrom, to },
      headers,
      timeout: 8_000,
    }),
    client.get(`${PYTH_HISTORY_URL}/${channel}/history`, {
      params: { symbol: config.symbol, resolution: '60', from: tenSessionFrom, to },
      headers,
      timeout: 8_000,
    }),
  ]);
  const entitlementFailures = [latestResult, oneDayResult, multiDayResult]
    .filter((result) => result.status === 'rejected')
    .map((result) => pythFailure(result.reason, unavailableReason));
  const entitlementFailure = entitlementFailures.find((failure) => (
    ['PYTH_ENTITLEMENT_REQUIRED', 'PYTH_AUTH_REQUIRED'].includes(failure.code)
  )) || entitlementFailures[0] || null;
  const resolvedEntitlement = pythEntitlementState(entitlementFailure);

  let spot = emptySpot;
  if (latestResult.status === 'fulfilled') {
    const parsed = latestResult.value?.data?.parsed;
    const feed = Array.isArray(parsed?.priceFeeds) ? parsed.priceFeeds[0] : null;
    const publishMs = finiteNumber(feed?.feedUpdateTimestamp) == null
      ? finiteNumber(parsed?.timestampUs) == null ? null : Number(parsed.timestampUs) / 1000
      : Number(feed.feedUpdateTimestamp) / 1000;
    const raw = finiteNumber(feed?.price);
    const exponent = finiteNumber(feed?.exponent);
    const value = raw == null || exponent == null ? null : raw * (10 ** exponent);
    if (Number(feed?.priceFeedId) === feedId
      && value != null && value > 0
      && Number.isFinite(publishMs)
      && nowMs - publishMs >= -FUTURE_TOLERANCE_MS
      && nowMs - publishMs <= LIVE_QUOTE_MAX_AGE_MS) {
      spot = {
        status: 'available', availability: 'live', value,
        label: `LIVE PYTH ${label}`,
        source: `pyth_pro_${config.symbol.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
        asOf: new Date(publishMs).toISOString(),
        expiresAt: new Date(publishMs + LIVE_QUOTE_MAX_AGE_MS).toISOString(),
        fit: 'exact', executable: false, reason: null,
        feed: { symbol: config.symbol, priceFeedId: feedId, channel },
      };
    }
  } else {
    const failure = pythFailure(latestResult.reason, unavailableReason);
    spot = { ...emptySpot, refreshFailed: true, refreshIssue: failure.message, errorCode: failure.code };
  }

  const pythPoints = (result, oldestMs) => {
    if (result?.status !== 'fulfilled') return [];
    const payload = result.value?.data;
    if (String(payload?.s || '').toLowerCase() !== 'ok') return [];
    const timestamps = Array.isArray(payload?.t) ? payload.t : [];
    const closes = Array.isArray(payload?.c) ? payload.c : [];
    return timestamps.map((timestamp, index) => ({
      timestamp: Number(timestamp) * 1000,
      value: finiteNumber(closes[index]),
    })).filter((point) => (
      Number.isFinite(point.timestamp)
      && point.timestamp <= nowMs + FUTURE_TOLERANCE_MS
      && point.timestamp >= oldestMs
      && point.value != null
      && point.value > 0
    )).sort((left, right) => left.timestamp - right.timestamp);
  };
  const oneDayPoints = pythPoints(oneDayResult, nowMs - DAY_MS);
  const multiDayPoints = pythPoints(multiDayResult, nowMs - 14 * DAY_MS);
  let chart = await buildChartVariants({
    oneDayPoints,
    multiDayPoints,
    currentPoint: verifiedCurrentPointFromSpot(spot, nowMs),
    config: {
      label: `Pyth ${label}`,
      latestCompletedDate: latestCompletedWtiSessionDate,
      riskRangeTicker: config.riskRangeTicker,
      chartSession,
    },
    nowMs,
    source: `pyth_pro_history_${config.symbol.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
    oneDayInterval: '5m',
    multiDayInterval: '1h',
    fit: 'exact',
    label: `EXACT · PYTH ${config.symbol}`,
    loadRiskRangeHistory,
  });
  const priorClose = previousCompletedClose(multiDayPoints, spot.asOf, { chartSession });
  if (priorClose) {
    spot = {
      ...spot,
      previousClose: priorClose.value,
      previousCloseAsOf: priorClose.asOf,
      previousCloseSource: `pyth_pro_history_${config.symbol.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
    };
  }
  const failedRanges = [
    ...(oneDayResult.status === 'rejected' ? [['1d', oneDayResult.reason]] : []),
    ...(multiDayResult.status === 'rejected' ? [['5d', multiDayResult.reason], ['10d', multiDayResult.reason]] : []),
  ];
  failedRanges.forEach(([range, error]) => {
    const failure = pythFailure(error, `Pyth ${config.symbol} ${range.toUpperCase()} history is unavailable.`);
    if (range === '1d' && chart.variants[range]?.resolutionState === 'coarser_verified') {
      chart.variants[range] = {
        ...chart.variants[range],
        preferredResolutionRefreshIssue: failure.message,
        preferredResolutionErrorCode: failure.code,
      };
      return;
    }
    chart.variants[range] = {
      ...chart.variants[range],
      refreshFailed: true,
      refreshIssue: failure.message,
      errorCode: failure.code,
    };
  });
  chart = { ...chart.variants['1d'], variants: chart.variants };
  return {
    spot,
    chart,
    resolver: `${resolver} · feed ${feedId}`,
    fit: 'exact',
    feed: { symbol: config.symbol, priceFeedId: feedId, channel },
    exactSourceUrl,
    entitlement: resolvedEntitlement,
    backgroundRefresh: CHART_RANGES.some((range) => chart.variants?.[range]?.riskRangeRefreshPending === true),
  };
}

function previousCalendarSessionDate(nowMs) {
  const today = historicalBarDateKey(nowMs);
  if (!today) return null;
  const parsed = Date.parse(`${today}T12:00:00.000Z`);
  return Number.isFinite(parsed) ? new Date(parsed - DAY_MS).toISOString().slice(0, 10) : null;
}

function expectedHistoricalDateForMarket(marketId, nowMs) {
  if (['sp500', 'nasdaq100'].includes(marketId)) return latestCompletedSpxSessionDate(nowMs);
  if (marketId === 'bitcoin') return previousCalendarSessionDate(nowMs);
  return latestCompletedWtiSessionDate(nowMs);
}

async function loadCoinbaseHistoricalRecord(client, throughDate, nowMs = Date.now()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(throughDate || ''))) {
    throw new Error('A valid Coinbase historical-record through date is required.');
  }
  const throughEndMs = Date.parse(`${throughDate}T00:00:00.000Z`) + DAY_MS;
  if (!Number.isFinite(throughEndMs)) throw new Error('The Coinbase historical-record cutoff is invalid.');
  const rowsByTimestamp = new Map();
  let cursorEndMs = throughEndMs;
  let chunks = 0;
  let complete = false;
  const maximumChunks = 80;
  const chunkSpanMs = 299 * DAY_MS;

  while (chunks < maximumChunks) {
    const chunkStartMs = cursorEndMs - chunkSpanMs;
    const response = await client.get(`${COINBASE_EXCHANGE_URL}/products/BTC-USD/candles`, {
      params: {
        granularity: 86400,
        start: new Date(chunkStartMs).toISOString(),
        end: new Date(cursorEndMs).toISOString(),
      },
      timeout: 8_000,
    });
    chunks += 1;
    const rows = Array.isArray(response?.data) ? response.data : [];
    const accepted = rows.map((candle) => ({
      timestamp: Number(candle?.[0]) * 1000,
      high: finiteNumber(candle?.[2]),
    })).filter((row) => (
      Number.isFinite(row.timestamp)
      && row.timestamp >= chunkStartMs
      && row.timestamp < cursorEndMs
      && row.high != null
      && row.high > 0
    ));
    accepted.forEach((row) => rowsByTimestamp.set(row.timestamp, row.high));
    if (!accepted.length) {
      if (rowsByTimestamp.size >= 2) {
        complete = true;
        break;
      }
      throw new Error('Coinbase returned no usable BTC-USD daily history.');
    }
    const earliest = Math.min(...accepted.map((row) => row.timestamp));
    if (earliest >= cursorEndMs) {
      throw new Error('Coinbase historical-record pagination made no backward progress.');
    }
    cursorEndMs = earliest;
  }
  if (!complete || rowsByTimestamp.size < 2) {
    throw new Error('Coinbase BTC-USD all-history coverage is incomplete.');
  }
  const ordered = [...rowsByTimestamp.entries()].sort((left, right) => left[0] - right[0]);
  const coverageStart = new Date(ordered[0][0]).toISOString().slice(0, 10);
  const coverageEnd = new Date(ordered[ordered.length - 1][0]).toISOString().slice(0, 10);
  if (coverageEnd !== throughDate) {
    throw new Error(`Coinbase BTC-USD record history ended on ${coverageEnd} instead of ${throughDate}.`);
  }
  const [recordTimestamp, recordHigh] = ordered.reduce((highest, row) => (
    !highest || row[1] > highest[1] || (row[1] === highest[1] && row[0] > highest[0]) ? row : highest
  ), null);
  return {
    status: 'available',
    source: 'coinbase_exchange',
    dataset: 'historical_record',
    asOf: new Date(nowMs).toISOString(),
    throughDate,
    recordHigh,
    recordDate: new Date(recordTimestamp).toISOString().slice(0, 10),
    coverage: {
      complete: true,
      startDate: coverageStart,
      endDate: coverageEnd,
      headDate: coverageStart,
      chunks,
      observations: ordered.length,
    },
    reason: null,
  };
}

async function loadCoinbaseProxyFitHistory(client, nowMs = Date.now()) {
  const end = new Date(nowMs).toISOString();
  const start = new Date(nowMs - 200 * DAY_MS).toISOString();
  const response = await client.get(`${COINBASE_EXCHANGE_URL}/products/BTC-USD/candles`, {
    params: { granularity: 86400, start, end },
    timeout: 8_000,
  });
  if (!Array.isArray(response?.data)) {
    throw new Error('Coinbase returned no verified BTC-USD daily proxy history.');
  }
  const points = response.data.map((candle) => ({
    timestamp: Number(candle?.[0]) * 1000,
    value: finiteNumber(candle?.[4]),
  })).filter((point) => (
    Number.isFinite(point.timestamp)
    && point.timestamp <= nowMs + FUTURE_TOLERANCE_MS
    && point.timestamp >= nowMs - 201 * DAY_MS
    && point.value != null
    && point.value > 0
  )).sort((left, right) => left.timestamp - right.timestamp);
  if (points.length < 5) {
    throw new Error('Coinbase returned insufficient verified BTC-USD daily proxy history.');
  }
  return {
    status: 'available',
    source: 'coinbase_exchange_public_candles',
    asOf: new Date(nowMs).toISOString(),
    points,
  };
}

async function loadCoinbaseBitcoinReference({
  client,
  nowMs,
  selected,
  loadRiskRangeHistory,
  loadProxyFitComparison = (_key, factory) => factory(),
  athRecordSettlement = { status: 'rejected', reason: 'Coinbase ATH history is unavailable.' },
  proxyFitHistorySettlement = { status: 'pending' },
}) {
  const spotUnavailable = unavailable('Verified live Coinbase BTC-USD proxy is unavailable.', { value: null, label: 'BTC' });
  const from = new Date(nowMs - DAY_MS).toISOString();
  const multiDayFrom = new Date(nowMs - 10 * DAY_MS).toISOString();
  const to = new Date(nowMs).toISOString();
  const [tickerResult, oneDayResult, multiDayResult] = await Promise.allSettled([
    client.get(`${COINBASE_EXCHANGE_URL}/products/BTC-USD/ticker`, { timeout: 8_000 }),
    client.get(`${COINBASE_EXCHANGE_URL}/products/BTC-USD/candles`, {
      params: { granularity: 300, start: from, end: to },
      timeout: 8_000,
    }),
    client.get(`${COINBASE_EXCHANGE_URL}/products/BTC-USD/candles`, {
      params: { granularity: 3600, start: multiDayFrom, end: to },
      timeout: 8_000,
    }),
  ]);

  let spot = spotUnavailable;
  if (tickerResult.status === 'fulfilled') {
    const payload = tickerResult.value?.data;
    const value = finiteNumber(payload?.price);
    const asOfMs = Date.parse(payload?.time || '');
    if (value != null && value > 0 && Number.isFinite(asOfMs)
      && nowMs - asOfMs >= -FUTURE_TOLERANCE_MS && nowMs - asOfMs <= LIVE_QUOTE_MAX_AGE_MS) {
      spot = {
        status: 'available', availability: 'live', value,
        label: 'PROXY · COINBASE BTC-USD · NOT RESOLVER / NOT EXECUTABLE',
        source: 'coinbase_exchange_public_ticker', asOf: new Date(asOfMs).toISOString(),
        expiresAt: new Date(asOfMs + LIVE_QUOTE_MAX_AGE_MS).toISOString(),
        fit: 'proxy', executable: false,
        reason: 'Coinbase BTC-USD is a live proxy; Kalshi resolves from a CF Benchmarks BRTI final-minute average.',
      };
    }
  } else {
    spot = refreshFailure(spot, tickerResult.reason);
  }

  const candlePoints = (result, oldestMs) => {
    if (result?.status !== 'fulfilled' || !Array.isArray(result.value?.data)) return [];
    return result.value.data.map((candle) => ({
      timestamp: Number(candle?.[0]) * 1000,
      value: finiteNumber(candle?.[4]),
    })).filter((point) => (
      Number.isFinite(point.timestamp) && point.timestamp <= nowMs + FUTURE_TOLERANCE_MS
      && point.timestamp >= oldestMs && point.value != null && point.value > 0
    )).sort((left, right) => left.timestamp - right.timestamp);
  };
  const proxyLabel = 'PROXY · COINBASE BTC-USD · NOT RESOLVER / NOT EXECUTABLE';
  const oneDayPoints = candlePoints(oneDayResult, nowMs - DAY_MS);
  const multiDayPoints = candlePoints(multiDayResult, nowMs - 10 * DAY_MS);
  const currentPoint = verifiedCurrentPointFromSpot(spot, nowMs);
  const chartSession = buildResolverChartSession({ marketId: 'bitcoin', selected, nowMs });
  const athThroughDate = previousCalendarSessionDate(nowMs);
  const ath = normalizeHistoricalAth(
    athRecordSettlement.status === 'fulfilled' ? athRecordSettlement.value : null,
    athRecordSettlement,
    [...multiDayPoints, ...oneDayPoints, ...(currentPoint ? [currentPoint] : [])],
    athThroughDate,
    'coinbase_exchange',
  );
  let chart = await buildChartVariants({
    oneDayPoints,
    multiDayPoints,
    currentPoint,
    config: {
      label: 'Coinbase BTC-USD',
      latestCompletedDate: previousCalendarSessionDate,
      riskRangeTicker: 'BITCOIN',
      carryRiskRangeAcrossNonPublicationSessions: true,
      chartSession,
    },
    nowMs,
    source: 'coinbase_exchange_public_candles',
    oneDayInterval: '5m',
    multiDayInterval: '1h',
    fit: 'proxy',
    label: proxyLabel,
    successfulReason: 'Verified Coinbase history shown as proxy context only; it is not CF Benchmarks BRTI.',
    calendarSessions: true,
    loadRiskRangeHistory,
    riskRangeWaitMs: BITCOIN_RISK_RANGE_HISTORY_WAIT_MS,
  });
  const priorClose = previousCompletedClose(
    multiDayPoints,
    spot.asOf || chart.latestAt,
    {
      calendarSessions: true,
      chartSession: chartSession?.multiDayProfile
        ? { ...chartSession, profile: chartSession.multiDayProfile, currentWindow: null }
        : null,
    },
  );
  if (priorClose) {
    spot = {
      ...spot,
      previousClose: priorClose.value,
      previousCloseAsOf: priorClose.asOf,
      previousCloseSource: 'coinbase_exchange_public_candles',
    };
    const variants = Object.fromEntries(CHART_RANGES.map((range) => [range, {
      ...chart.variants[range],
      previousClose: priorClose.value,
      previousCloseAsOf: priorClose.asOf,
      previousCloseSource: 'coinbase_exchange_public_candles',
    }]));
    chart = { ...variants['1d'], variants };
  }
  if (oneDayResult.status === 'rejected' && chart.variants['1d']?.resolutionState !== 'coarser_verified') {
    chart = {
      ...refreshFailure(chart, oneDayResult.reason),
      variants: { ...chart.variants, '1d': refreshFailure(chart.variants['1d'], oneDayResult.reason) },
    };
  } else if (oneDayResult.status === 'rejected') {
    const issue = String(
      oneDayResult.reason?.message || oneDayResult.reason || 'Verified Coinbase 5-minute history is unavailable.',
    ).slice(0, 160);
    chart = {
      ...chart.variants['1d'],
      preferredResolutionRefreshIssue: issue,
      variants: {
        ...chart.variants,
        '1d': { ...chart.variants['1d'], preferredResolutionRefreshIssue: issue },
      },
    };
  }
  if (multiDayResult.status === 'rejected') {
    chart = {
      ...chart,
      variants: {
        ...chart.variants,
        '5d': refreshFailure(chart.variants['5d'], multiDayResult.reason),
        '10d': refreshFailure(chart.variants['10d'], multiDayResult.reason),
      },
    };
  }
  chart = attachAthToChart(chart, ath);
  const proxyFitLabels = { proxyLabel: 'COINBASE BTC-USD', underlyingLabel: 'BITCOIN' };
  let proxyFit = proxyFitHistorySettlement.status === 'pending'
    ? pendingProxyFit('Verified proxy-fit history is loading.', proxyFitLabels)
    : proxyFitHistorySettlement.status === 'rejected'
      ? unavailableProxyFit('Verified Coinbase proxy-fit history is unavailable.', proxyFitLabels)
      : unavailableProxyFit('Verified Coinbase proxy-fit history is unavailable.', proxyFitLabels);
  let proxyFitPending = proxyFitHistorySettlement.status === 'pending';
  if (proxyFitHistorySettlement.status === 'fulfilled') {
    const proxyFitResult = await settleWithin(loadProxyFitComparison(
      `coinbase:BTC-USD:${previousCalendarSessionDate(nowMs)}`,
      () => buildVerifiedProxyFit({
        proxyPoints: proxyFitHistorySettlement.value?.points,
        proxyLabel: proxyFitLabels.proxyLabel,
        underlyingLabel: proxyFitLabels.underlyingLabel,
        proxySource: proxyFitHistorySettlement.value?.source,
        loadRiskRangeHistory,
      }),
    ), BITCOIN_RISK_RANGE_HISTORY_WAIT_MS);
    proxyFitPending = proxyFitResult.status === 'pending';
    proxyFit = proxyFitResult.status === 'fulfilled'
      ? proxyFitResult.value
      : proxyFitResult.status === 'pending'
        ? pendingProxyFit('Verified proxy-fit comparison is loading.', proxyFitLabels)
        : unavailableProxyFit('Verified proxy-fit comparison is unavailable.', proxyFitLabels);
  }
  return {
    spot,
    chart,
    proxyFit,
    resolver: 'CF Benchmarks BRTI final-minute average · Coinbase BTC-USD proxy shown',
    fit: 'proxy',
    // ATH and Risk Range overlays are secondary chart context. They must not
    // keep the entire live BTC reference in a perpetual progressive state:
    // doing so eventually expires an otherwise current spot and removes the
    // ladder marker. The normal five-second monitor cadence retries these
    // overlays while the verified ticker/candles remain publishable.
    backgroundRefresh: false,
    secondaryContextRefreshPending: athRecordSettlement.status === 'pending'
      || proxyFitPending
      || CHART_RANGES.some((range) => chart.variants?.[range]?.riskRangeRefreshPending === true),
  };
}

function createMarketReferenceProvider({
  ibkr = ibkrMarketDataProvider,
  client = null,
  now = Date.now,
  loadRiskRangeHistory = (context) => getRiskRangeHistoryAvailability(context, { useCache: false }),
  historicalQueue: injectedHistoricalQueue = null,
  checkpointStore: injectedCheckpointStore = null,
  loadDirectionalSelection: injectedDirectionalSelection = null,
  loadKalshiGoldSettlements = () => defaultKalshiFetch('/events', {
    series_ticker: 'KXGOLDD',
    status: 'settled',
    limit: GOLD_TRACKING_WINDOW,
    with_nested_markets: true,
  }),
  riskRangeHistoryCacheMs = RISK_RANGE_HISTORY_CACHE_MS,
  coinbaseReferenceRefreshTimeoutMs = COINBASE_REFERENCE_REFRESH_TIMEOUT_MS,
  goldReferenceRefreshTimeoutMs = GOLD_REFERENCE_REFRESH_TIMEOUT_MS,
  priorityIbkrHistoryTimeoutMs = PRIORITY_IBKR_HISTORY_TIMEOUT_MS,
} = {}) {
  const httpClient = client || createFetchHttpClient();
  const referenceStates = new Map();
  const historicalStates = new Map();
  const historicalRecordStates = new Map();
  const quoteStates = new Map();
  const directionalStates = new Map();
  const directionalBasisReferenceStates = new Map();
  const contractReferenceStates = new Map();
  const qualifiedFuturesStates = new Map();
  const riskRangeHistoryStates = new Map();
  const proxyFitStates = new Map();
  const goldPythTrackingState = { value: null, expiresAt: 0, inFlight: null };
  const historicalQueue = injectedHistoricalQueue || createHistoricalRequestQueue();
  const checkpointStore = injectedCheckpointStore || (process.env.NODE_ENV === 'test'
    ? null
    : createHistoricalCheckpointStore());
  const coinbaseHistoricalRecordState = {
    throughDate: null,
    value: null,
    expiresAt: 0,
    inFlight: null,
  };
  const coinbaseProxyFitHistoryState = {
    value: null,
    expiresAt: 0,
    inFlight: null,
  };
  const currentMs = () => {
    const value = now();
    return value instanceof Date ? value.getTime() : Number(value);
  };
  const loadCoinbaseAthRecord = (throughDate) => {
    if (coinbaseHistoricalRecordState.throughDate !== throughDate) {
      coinbaseHistoricalRecordState.throughDate = throughDate;
      coinbaseHistoricalRecordState.value = null;
      coinbaseHistoricalRecordState.expiresAt = 0;
      coinbaseHistoricalRecordState.inFlight = null;
    }
    if (coinbaseHistoricalRecordState.value
      && currentMs() < coinbaseHistoricalRecordState.expiresAt) {
      return Promise.resolve(coinbaseHistoricalRecordState.value);
    }
    if (coinbaseHistoricalRecordState.inFlight) return coinbaseHistoricalRecordState.inFlight;
    coinbaseHistoricalRecordState.inFlight = loadCoinbaseHistoricalRecord(
      httpClient,
      throughDate,
      currentMs(),
    ).then((value) => {
      if (verifiedHistoricalRecord(value, throughDate, 'coinbase_exchange')) {
        coinbaseHistoricalRecordState.value = value;
        coinbaseHistoricalRecordState.expiresAt = currentMs() + ATH_RECORD_TTL_MS;
      }
      return value;
    }).finally(() => {
      coinbaseHistoricalRecordState.inFlight = null;
    });
    return coinbaseHistoricalRecordState.inFlight;
  };
  const loadCoinbaseProxyFitHistoryCached = () => {
    if (coinbaseProxyFitHistoryState.value
      && currentMs() < coinbaseProxyFitHistoryState.expiresAt) {
      return Promise.resolve(coinbaseProxyFitHistoryState.value);
    }
    if (coinbaseProxyFitHistoryState.inFlight) return coinbaseProxyFitHistoryState.inFlight;
    coinbaseProxyFitHistoryState.inFlight = loadCoinbaseProxyFitHistory(
      httpClient,
      currentMs(),
    ).then((value) => {
      coinbaseProxyFitHistoryState.value = value;
      coinbaseProxyFitHistoryState.expiresAt = currentMs() + PROXY_FIT_HISTORY_TTL_MS;
      return value;
    }).finally(() => {
      coinbaseProxyFitHistoryState.inFlight = null;
    });
    return coinbaseProxyFitHistoryState.inFlight;
  };
  const loadStableRiskRangeHistory = (context = {}) => {
    const ticker = String(context?.ticker || '').trim().toUpperCase();
    const dates = [...new Set((Array.isArray(context?.dates) ? context.dates : [])
      .map((date) => String(date || '').trim())
      .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)))].sort();
    const key = `${ticker}:${dates.join(',')}`;
    let state = riskRangeHistoryStates.get(key);
    if (!state) {
      state = { value: null, expiresAt: 0, inFlight: null };
      riskRangeHistoryStates.set(key, state);
    }
    if (state.value && currentMs() < state.expiresAt) return Promise.resolve(state.value);
    if (state.inFlight) return state.inFlight;
    state.inFlight = Promise.resolve(loadRiskRangeHistory({ ticker, dates })).then((value) => {
      const cacheMs = Math.max(0, Number(riskRangeHistoryCacheMs) || 0);
      if (cacheMs > 0 && cacheableVerifiedRiskRangeHistory(value, { ticker, dates })) {
        state.value = value;
        state.expiresAt = currentMs() + cacheMs;
      } else {
        state.value = null;
        state.expiresAt = 0;
      }
      return value;
    }).finally(() => {
      state.inFlight = null;
    });
    return state.inFlight;
  };
  const loadProxyFitComparison = (key, factory) => {
    const normalizedKey = String(key || '').trim();
    if (!normalizedKey || typeof factory !== 'function') {
      return Promise.reject(new TypeError('A proxy-fit key and factory are required.'));
    }
    let state = proxyFitStates.get(normalizedKey);
    if (!state) {
      state = { value: null, expiresAt: 0, inFlight: null };
      proxyFitStates.set(normalizedKey, state);
    }
    if (state.value && currentMs() < state.expiresAt) return Promise.resolve(state.value);
    if (state.inFlight) return state.inFlight;
    state.inFlight = Promise.resolve().then(factory).then((value) => {
      const status = String(value?.status || '').toLowerCase();
      // This cache retains only a fully computed, date-labeled historical
      // analysis result. It is never used when the direct provider is
      // disconnected, and unavailable results are retried quickly.
      state.value = value;
      state.expiresAt = currentMs() + (
        ['available', 'partial'].includes(status) ? PROXY_FIT_HISTORY_TTL_MS : 30_000
      );
      return value;
    }).catch((error) => {
      state.value = null;
      state.expiresAt = 0;
      throw error;
    }).finally(() => {
      state.inFlight = null;
    });
    return state.inFlight;
  };
  const loadGoldPythTrackingPayload = () => {
    if (goldPythTrackingState.value && currentMs() < goldPythTrackingState.expiresAt) {
      return Promise.resolve(goldPythTrackingState.value);
    }
    if (goldPythTrackingState.inFlight) return goldPythTrackingState.inFlight;
    goldPythTrackingState.inFlight = Promise.resolve()
      .then(() => loadKalshiGoldSettlements())
      .then((value) => {
        if (!value || !Array.isArray(value.events)) {
          throw new Error('Kalshi finalized Gold history returned an invalid response.');
        }
        goldPythTrackingState.value = value;
        goldPythTrackingState.expiresAt = currentMs() + GOLD_PYTH_TRACKING_TTL_MS;
        return value;
      })
      .catch((error) => {
        goldPythTrackingState.value = null;
        goldPythTrackingState.expiresAt = 0;
        throw error;
      })
      .finally(() => {
        goldPythTrackingState.inFlight = null;
      });
    return goldPythTrackingState.inFlight;
  };
  const providerStatusState = { value: null, expiresAt: 0, inFlight: null };

  const loadIbkrProviderStatus = () => {
    if (providerStatusState.value && currentMs() < providerStatusState.expiresAt) {
      return Promise.resolve(providerStatusState.value);
    }
    if (providerStatusState.inFlight) return providerStatusState.inFlight;
    const readProviderStatus = () => Promise.resolve().then(() => ibkr.getProviderStatus());
    // The sidecar can briefly miss one health probe while its socket is being
    // re-established. Confirm a negative probe before publishing a broker
    // disconnect; otherwise one dropped health response blanks every IBKR
    // Gold reference for the duration of the status cache.
    const indeterminateStatus = (first, second, error) => ({
      connected: null,
      status: 'unresponsive',
      transient: true,
      message: String(
        error?.message
          || second?.message
          || second?.error
          || first?.message
          || first?.error
          || 'IBKR provider status is temporarily unresponsive.',
      ).slice(0, 160),
    });
    const readConfirmedProviderStatus = async () => {
      let first = null;
      let firstError = null;
      try {
        first = await readProviderStatus();
      } catch (error) {
        firstError = error;
      }
      if (isConnected(first)) return first;
      let second = null;
      try {
        second = await readProviderStatus();
      } catch (secondError) {
        return indeterminateStatus(first, null, secondError || firstError);
      }
      if (isConnected(second)) return second;
      if (providerConnectionState(first) === 'disconnected'
        && providerConnectionState(second) === 'disconnected') return second;
      return indeterminateStatus(first, second, firstError);
    };
    providerStatusState.inFlight = readConfirmedProviderStatus().then((value) => {
      providerStatusState.value = value;
      providerStatusState.expiresAt = currentMs() + (isConnected(value) ? 5_000 : 1_000);
      return value;
    }).catch((error) => {
      providerStatusState.value = {
        connected: null,
        status: 'unresponsive',
        transient: true,
        message: String(error?.message || error || 'IBKR provider status unavailable.'),
      };
      providerStatusState.expiresAt = currentMs() + 1_000;
      return providerStatusState.value;
    }).finally(() => {
      providerStatusState.inFlight = null;
    });
    return providerStatusState.inFlight;
  };

  const historicalStateKey = (instrument, range, interval, {
    marketId = null,
    completedThroughDate = null,
    useRth = false,
  } = {}) => [
    marketId || 'unscoped',
    instrument?.symbol,
    instrument?.conId || instrument?.conid || '',
    instrument?.secType,
    instrument?.exchange,
    instrument?.lastTradeDateOrContractMonth,
    range,
    interval,
    useRth ? 'rth' : 'full',
    completedThroughDate || 'no-session',
  ].join(':');

  const loadIbkrHistory = (instrument, range, interval, {
    marketId = null,
    completedThroughDate = null,
    useRth = false,
    allowProviderRequest = true,
    priorityProviderRequest = false,
  } = {}) => {
    const key = historicalStateKey(instrument, range, interval, {
      marketId, completedThroughDate, useRth,
    });
    let state = historicalStates.get(key);
    if (!state) {
      const restored = marketId && completedThroughDate && checkpointStore
        ? checkpointStore.loadHistory({ marketId, contract: instrument, interval, completedThroughDate })
        : null;
      state = { value: restored, expiresAt: 0, inFlight: null };
      historicalStates.set(key, state);
    }
    if (state.value && currentMs() < state.expiresAt) return Promise.resolve(state.value);
    if (!allowProviderRequest) {
      return Promise.resolve(state.value || {
        source: null,
        bars: [],
        error: 'ibkr_disconnected',
      });
    }
    if (!state.inFlight) {
      const requestProvider = () => (
        ['FUT', 'CMDTY'].includes(String(instrument?.secType || '').toUpperCase())
          ? ibkr.getHistoricalBars(instrument, range, interval, { useRth })
          : ibkr.getHistoricalBars(instrument, range, interval)
      );
      // The sidecar still serializes broker historical work. This priority
      // path only keeps the current Kalshi Gold display reference from
      // waiting behind unrelated long-range research queued in this process.
      const rawProviderRequest = priorityProviderRequest
        ? Promise.resolve().then(requestProvider)
        : historicalQueue.enqueue(key, requestProvider);
      const providerRequest = priorityProviderRequest
        ? settleWithin(
            rawProviderRequest,
            Math.max(25, Number(priorityIbkrHistoryTimeoutMs)
              || PRIORITY_IBKR_HISTORY_TIMEOUT_MS),
          ).then((result) => {
            if (result.status === 'fulfilled') return result.value;
            if (result.status === 'rejected') throw result.reason;
            throw Object.assign(
              new Error(`Verified IBKR priority history timed out for ${instrument?.displaySymbol || instrument?.symbol || 'instrument'}.`),
              { code: 'IBKR_PRIORITY_HISTORY_TIMEOUT' },
            );
          })
        : rawProviderRequest;
      state.inFlight = providerRequest.then((value) => {
      const provenance = [
        value?.error,
        value?.warning,
        value?.provenance,
        value?.cacheStatus,
        value?.cacheState,
        value?.fromCache ? 'cached' : '',
        value?.cached ? 'cached' : '',
      ].filter(Boolean).join(' ');
      const verified = String(value?.source || '').toLowerCase() === 'ibkr'
        && Array.isArray(value?.bars)
        && value.bars.length > 0
        && !FORBIDDEN.test(provenance)
        && (!(instrument?.conId || instrument?.conid)
          || Number(value?.contract?.conId) === Number(instrument.conId || instrument.conid));
      if (verified) {
        state.value = value;
        state.expiresAt = currentMs() + (interval === '1h' || interval === '1d'
          ? MULTI_DAY_HISTORY_TTL_MS
          : INTRADAY_HISTORY_TTL_MS);
        if (marketId && completedThroughDate && checkpointStore && value?.contract) {
          try {
            checkpointStore.saveHistory({
              marketId,
              contract: value.contract,
              interval,
              bars: value.bars,
              sourceTimestamp: value.asOf,
              completedThroughDate,
              provenance: 'ibkr',
            });
          } catch (error) {
            // Persistence is a restart optimization. A checkpoint write must
            // never invalidate provider-verified history already in memory.
          }
        }
      } else {
        if (!state.value) state.value = null;
        state.expiresAt = 0;
      }
      return verified ? value : state.value || value;
      }).catch((error) => {
        if (state.value) {
          return {
            ...state.value,
            refreshPending: false,
            refreshFailed: true,
            refreshIssue: String(error?.message || error || 'IBKR history refresh failed.').slice(0, 160),
          };
        }
        throw error;
      }).finally(() => {
        state.inFlight = null;
      });
    }
    if (state.value?.restoredFromCheckpoint) {
      return Promise.resolve({ ...state.value, refreshPending: true });
    }
    return state.inFlight;
  };

  async function loadQualifiedFuturesReference(config, options = {}) {
    const requested = config?.instrument;
    const contractMonth = expectedFuturesContractMonth(requested);
    const qualificationKey = [
      config?.marketId || 'unscoped',
      requested?.symbol || '',
      requested?.exchange || '',
      contractMonth || '',
      requested?.displaySymbol || '',
    ].join(':');
    let instrument = qualifiedFuturesStates.get(qualificationKey) || null;
    if (!instrument) {
      const statusResult = await settleWithin(loadIbkrProviderStatus());
      if (statusResult.status !== 'fulfilled'
        || providerConnectionState(statusResult.value) !== 'connected') {
        return loadIbkrReference(config, options);
      }
      const completedThroughDate = config.latestCompletedDate(currentMs());
      const qualificationHistory = await loadIbkrHistory(requested, '1d', '5m', {
        marketId: config.marketId || null,
        completedThroughDate,
        useRth: false,
        allowProviderRequest: true,
        priorityProviderRequest: true,
      });
      instrument = qualifiedFuturesInstrument(requested, qualificationHistory);
      if (!instrument) return loadIbkrReference(config, options);
      qualifiedFuturesStates.set(qualificationKey, instrument);

      // Reuse a provider-verified qualification bar under the conId key. A
      // restored completed-history checkpoint may establish identity, but it
      // is not promoted into the qualified live-history cache.
      if (String(qualificationHistory?.source || '').toLowerCase() === 'ibkr'
        && qualificationHistory?.restoredFromCheckpoint !== true
        && Array.isArray(qualificationHistory?.bars)
        && qualificationHistory.bars.length > 0) {
        const qualifiedHistoryKey = historicalStateKey(instrument, '1d', '5m', {
          marketId: config.marketId || null,
          completedThroughDate,
          useRth: false,
        });
        historicalStates.set(qualifiedHistoryKey, {
          value: qualificationHistory,
          expiresAt: currentMs() + INTRADAY_HISTORY_TTL_MS,
          inFlight: null,
        });
      }
    }
    return loadIbkrReference({ ...config, instrument }, options);
  }

  const loadIbkrHistoricalRecord = (instrument, throughDate, allowProviderRequest = true) => {
    const key = [
      instrument?.symbol,
      instrument?.conId || instrument?.conid || '',
      instrument?.secType,
      instrument?.exchange,
      instrument?.lastTradeDateOrContractMonth,
      throughDate,
    ].join(':');
    let state = historicalRecordStates.get(key);
    if (!state) {
      state = { value: null, expiresAt: 0, inFlight: null };
      historicalRecordStates.set(key, state);
    }
    if (state.value && currentMs() < state.expiresAt) return Promise.resolve(state.value);
    if (!allowProviderRequest || typeof ibkr.getHistoricalRecord !== 'function') {
      return Promise.resolve(unavailableAth(
        !allowProviderRequest
          ? 'IBKR is disconnected; verified all-time-high history is unavailable.'
          : 'The IBKR historical-record provider is unavailable.',
      ));
    }
    if (state.inFlight) return state.inFlight;
    state.inFlight = historicalQueue.enqueue(`historical-record:${key}`, () => (
      ibkr.getHistoricalRecord(instrument, throughDate)
    ), { timeoutMs: ATH_RECORD_REQUEST_TIMEOUT_MS }).then((value) => {
      if (verifiedHistoricalRecord(value, throughDate)) {
        state.value = value;
        state.expiresAt = currentMs() + ATH_RECORD_TTL_MS;
      } else {
        state.value = null;
        state.expiresAt = 0;
      }
      return value;
    }).finally(() => {
      state.inFlight = null;
    });
    return state.inFlight;
  };

  function directionalVolumeSessions(bars, completedThroughDate) {
    const byDate = new Map();
    (Array.isArray(bars) ? bars : []).forEach((bar) => {
      const [point] = normalizeUnderlyingBars([bar], currentMs());
      const date = historicalBarDateKey(point?.timestamp);
      const volume = finiteNumber(bar?.volume);
      if (!date || date > completedThroughDate || volume == null || volume < 0) return;
      byDate.set(date, (byDate.get(date) || 0) + volume);
    });
    return [...byDate.entries()]
      .map(([date, volume]) => ({ date, volume }))
      .sort((left, right) => left.date.localeCompare(right.date))
      .slice(-3);
  }

  function qualifiedDirectionalCandidate(marketId, requested, response, completedThroughDate) {
    const definition = DIRECTIONAL_FEEDS[marketId];
    const contract = response?.contract;
    const conId = Number(contract?.conId);
    const expiry = String(contract?.lastTradeDateOrContractMonth || '');
    const root = String(contract?.symbol || requested?.symbol || '').toUpperCase();
    const provenance = `${response?.source || ''} ${response?.error || ''} ${response?.warning || ''}`;
    if (!definition || response?.source !== 'ibkr' || !Number.isInteger(conId) || conId <= 0
      || root !== definition.root || !/^\d{6,8}$/.test(expiry)
      || FORBIDDEN.test(provenance) || !Array.isArray(response?.bars)) return null;
    const localSymbol = String(contract.localSymbol || requested.displaySymbol || definition.root).toUpperCase();
    const contractMonth = expectedFuturesContractMonth(requested);
    if (contractMonth
      && !localSymbolMatchesContractMonth(localSymbol, contractMonth, definition.root)) return null;
    const displaySymbol = normalizedDatedFutureSymbol(
      definition.root,
      localSymbol,
      contractMonth,
      requested.displaySymbol || localSymbol,
    );
    const instrument = {
      ...requested,
      symbol: definition.root,
      ibkrSymbol: definition.root,
      displaySymbol,
      localSymbol,
      conId,
      secType: 'FUT',
      exchange: contract.exchange || definition.exchange,
      currency: contract.currency || definition.currency,
      multiplier: String(contract.multiplier || definition.multiplier),
      tradingClass: contract.tradingClass || null,
      contractMonth,
      lastTradeDate: expiry,
      lastTradeDateOrContractMonth: expiry,
      provider: 'ibkr',
    };
    return {
      qualified: true,
      instrument,
      contract: instrument,
      lastTradeDate: expiry,
      volumeSessions: directionalVolumeSessions(response.bars, completedThroughDate),
    };
  }

  function restoredDirectionalCandidate(marketId) {
    const restored = checkpointStore?.loadSelection(marketId);
    return restored ? {
      qualified: true,
      instrument: restored,
      contract: restored,
      lastTradeDate: restored.lastTradeDateOrContractMonth,
      volumeSessions: [],
      rollReason: restored.rollReason,
    } : null;
  }

  async function refreshDirectionalSelection(marketId, state) {
    const definition = DIRECTIONAL_FEEDS[marketId];
    if (!definition || definition.provider !== 'ibkr') return null;
    // Contract discovery is historical work and must never occupy the shared
    // pacing queue when the sidecar already reports a disconnected broker.
    // A restored verified identity remains usable for checkpoint history, but
    // no provider request is attempted until the shared status cache reconnects.
    const providerStatus = await loadIbkrProviderStatus();
    if (!isConnected(providerStatus)) return state.value || null;
    const completedThroughDate = expectedHistoricalDateForMarket(marketId, currentMs());
    const requested = generateDirectionalCandidates(marketId, currentMs(), 3);
    const currentInstrument = state.value?.instrument || state.value || null;
    if (currentInstrument && !requested.some((candidate) => (
      String(candidate.lastTradeDateOrContractMonth).slice(0, 6)
        === String(currentInstrument.lastTradeDateOrContractMonth).slice(0, 6)
    ))) requested.unshift(currentInstrument);
    const candidates = [];
    for (const instrument of requested) {
      const key = [
        'directional-selection', marketId, instrument.symbol,
        instrument.conId || instrument.conid || instrument.lastTradeDateOrContractMonth,
      ].join(':');
      try {
        const response = await historicalQueue.enqueue(key, () => (
          ibkr.getHistoricalBars(instrument, '5d', '1d', { useRth: false })
        ));
        const qualified = qualifiedDirectionalCandidate(marketId, instrument, response, completedThroughDate);
        if (qualified) candidates.push(qualified);
      } catch (_error) {
        // Candidate discovery is fail-closed. A timeout releases the shared
        // queue and cannot evict the currently selected verified identity.
      }
    }
    const orderedCandidates = [...candidates].sort((left, right) => (
      String(left.instrument?.lastTradeDateOrContractMonth || '').localeCompare(
        String(right.instrument?.lastTradeDateOrContractMonth || ''),
      )
    ));
    const shortlist = orderedCandidates.slice(0, 3);
    const currentConId = Number(currentInstrument?.conId || currentInstrument?.conid);
    const currentCandidate = Number.isInteger(currentConId)
      ? orderedCandidates.find((candidate) => Number(candidate.instrument?.conId) === currentConId)
      : null;
    if (currentCandidate && !shortlist.includes(currentCandidate)) shortlist.unshift(currentCandidate);
    const selected = selectDirectionalContract({
      candidates: shortlist,
      current: state.value || null,
      nowMs: currentMs(),
    });
    if (!selected.selected) return state.value || null;
    const instrument = selected.selected.instrument || selected.selected.contract || selected.selected;
    state.value = {
      instrument,
      selectedAt: new Date(currentMs()).toISOString(),
      rollReason: selected.reason,
      volumeSessions: selected.selected.volumeSessions || [],
      medianVolume: selected.selected.medianVolume ?? null,
    };
    state.completedAt = currentMs();
    if (checkpointStore) {
      try { checkpointStore.saveSelection(marketId, instrument, selected.reason); } catch (_error) { /* in-memory selection remains valid */ }
    }
    return state.value;
  }

  async function resolveDirectionalInstrument(marketId) {
    if (typeof injectedDirectionalSelection === 'function') {
      const supplied = await injectedDirectionalSelection(marketId);
      if (supplied?.instrument) return supplied;
      if (supplied?.conId || supplied?.conid) {
        return { instrument: supplied, rollReason: 'injected_verified_selection', refreshPending: false };
      }
    }
    let state = directionalStates.get(marketId);
    if (!state) {
      const restored = restoredDirectionalCandidate(marketId);
      state = {
        value: restored ? {
          instrument: restored.instrument,
          selectedAt: restored.instrument.selectedAt || null,
          rollReason: restored.rollReason || 'restored_verified_identity',
          volumeSessions: [],
          medianVolume: null,
        } : null,
        completedAt: 0,
        inFlight: null,
      };
      directionalStates.set(marketId, state);
    }
    const selectionAge = currentMs() - Number(state.completedAt || 0);
    if (!state.inFlight && (!state.value || selectionAge >= 6 * 60 * 60_000)) {
      state.inFlight = refreshDirectionalSelection(marketId, state).finally(() => {
        state.inFlight = null;
      });
    }
    if (state.value?.instrument) return { ...state.value, refreshPending: Boolean(state.inFlight) };
    return state.inFlight;
  }

  async function directionalReferenceConfig(marketId, venueSelection = null) {
    const definition = DIRECTIONAL_FEEDS[marketId];
    if (!definition || definition.provider !== 'ibkr') return null;
    const selected = await resolveDirectionalInstrument(marketId);
    const instrument = normalizeDirectionalInstrumentIdentity(
      marketId,
      selected?.instrument || null,
      currentMs(),
    );
    return withResolverChartSession({
      marketId,
      label: instrument?.displaySymbol || definition.root,
      instrument,
      resolver: instrument
        ? `${definition.exchange} ${instrument.displaySymbol} liquid directional future`
        : `${definition.exchange} ${definition.root} directional contract selection is unavailable`,
      latestCompletedDate: marketId === 'sp500'
        ? latestCompletedSpxSessionDate
        : marketId === 'brent' ? latestCompletedGoldPythSessionDate : latestCompletedWtiSessionDate,
      riskRangeTicker: definition.riskRangeTicker,
      fit: 'proxy',
      directional: true,
      preferIntradayHistory: ['wti', 'brent'].includes(marketId),
      allowCoarserOneDay: true,
      riskRangeWaitMs: ['wti', 'brent'].includes(marketId) ? 25 : undefined,
      rollReason: selected?.rollReason || null,
      selectionRefreshPending: selected?.refreshPending === true,
    }, venueSelection, currentMs());
  }

  const loadIbkrQuote = (instrument) => {
    const key = [
      instrument?.symbol,
      instrument?.secType,
      instrument?.exchange,
      instrument?.lastTradeDateOrContractMonth,
    ].join(':');
    let state = quoteStates.get(key);
    if (!state) {
      state = { value: null, expiresAt: 0, inFlight: null };
      quoteStates.set(key, state);
    }
    if (state.value && currentMs() < state.expiresAt) return Promise.resolve(state.value);
    if (state.inFlight) return state.inFlight;
    state.inFlight = Promise.resolve(ibkr.getQuote(instrument)).then((value) => {
      state.value = value;
      state.expiresAt = currentMs() + 1_000;
      return value;
    }).finally(() => {
      state.inFlight = null;
    });
    return state.inFlight;
  };

  async function loadIbkrReference(config, { fit = 'exact', riskRangeLoader = loadRiskRangeHistory } = {}) {
    const nowMs = currentMs();
    // The sidecar paces historical subscriptions. Establish connectivity,
    // then prioritize the one 1-hour request that can populate every range.
    // Finer 5-minute bars and the quote are follow-up upgrades and cannot
    // block or erase completed history.
    const statusResult = await settleWithin(loadIbkrProviderStatus());
    const status = statusResult.status === 'fulfilled' ? statusResult.value : null;
    const connectionState = statusResult.status === 'fulfilled'
      ? providerConnectionState(status)
      : 'indeterminate';
    const connected = connectionState === 'connected';
    if (!connected) {
      const transient = connectionState === 'indeterminate';
      const reason = transient
        ? 'IBKR is temporarily unresponsive; waiting for a confirmed provider state.'
        : 'IBKR is disconnected; the verified market reference is unavailable.';
      const stateFields = transient ? {
        // Keep retrying in the background, but do not leave a cold card in an
        // indefinite loading state when no verified value exists yet. The
        // retention layer still keeps an unexpired verified value/series and
        // marks it delayed while this refresh is pending.
        status: 'unavailable',
        refreshing: false,
        refreshPending: true,
        errorCode: 'IBKR_STATUS_UNRESPONSIVE',
      } : {
        errorCode: 'IBKR_DISCONNECTED',
      };
      const variant = (range) => ({
        ...unavailableChartVariant(range, reason, {
          fit,
          label: fit === 'proxy' ? `PROXY · ${config.instrument?.displaySymbol || config.label}` : null,
          interval: range === '1d' ? '5m' : config.multiDayInterval || '1h',
        }),
        ...stateFields,
      });
      const oneDay = variant('1d');
      return {
        spot: {
          ...unavailable(reason, {
            value: null,
            label: config.label,
            fit,
            executable: false,
          }),
          ...stateFields,
        },
        chart: { ...oneDay, variants: { '1d': oneDay, '5d': variant('5d'), '10d': variant('10d') } },
        proxyFit: {
          ...unavailableProxyFit(reason, {
            proxyLabel: config.instrument?.displaySymbol || config.label,
            underlyingLabel: config.riskRangeTicker,
          }),
          ...(transient ? {
            refreshPending: true,
            errorCode: 'IBKR_STATUS_UNRESPONSIVE',
          } : {}),
        },
        resolver: config.resolver,
        fit,
        instrument: config.instrument,
        backgroundRefresh: transient,
      };
    }
    const completedThroughDate = config.latestCompletedDate(nowMs);
    const historyOptions = {
      marketId: config.marketId || null,
      completedThroughDate,
      useRth: false,
      allowProviderRequest: connected,
    };
    const chartReason = `Verified ${config.label} directional chart is unavailable.`;
    const quotePromise = connected ? loadIbkrQuote(config.instrument) : Promise.resolve(null);
    const multiDayInterval = config.multiDayInterval || '1h';
    let oneDayHistoryResult = { status: 'pending' };
    let multiDayHistoryResult = { status: 'pending' };
    if (config.preferIntradayHistory === true) {
      const oneDayHistoryPromise = loadIbkrHistory(config.instrument, '1d', '5m', {
        ...historyOptions,
        priorityProviderRequest: config.priorityIntradayHistory === true,
      });
      const multiDayHistoryPromise = loadIbkrHistory(
        config.instrument,
        MULTI_DAY_HISTORY_RANGE,
        multiDayInterval,
        historyOptions,
      );
      [oneDayHistoryResult, multiDayHistoryResult] = await Promise.all([
        settleWithin(oneDayHistoryPromise),
        settleWithin(multiDayHistoryPromise),
      ]);
    } else {
      const multiDayHistoryPromise = loadIbkrHistory(
        config.instrument,
        MULTI_DAY_HISTORY_RANGE,
        multiDayInterval,
        historyOptions,
      );
      multiDayHistoryResult = await settleWithin(multiDayHistoryPromise);
      if (multiDayHistoryResult.status !== 'pending') {
        const oneDayHistoryPromise = loadIbkrHistory(config.instrument, '1d', '5m', historyOptions);
        oneDayHistoryResult = await settleWithin(oneDayHistoryPromise, FRESH_REFERENCE_PROBE_MS);
      }
    }
    const quoteResult = await settleWithin(quotePromise, FRESH_REFERENCE_PROBE_MS);
    let spot = normalizeLiveQuote(
      quoteResult.status === 'fulfilled' ? quoteResult.value : null,
      config.label,
      nowMs,
      { requireLast: config.requireLast === true },
    );
    const verifiedPoints = (result) => {
      const rawHistory = result.status === 'fulfilled' ? result.value : null;
      const provenance = [
        rawHistory?.error,
        rawHistory?.warning,
        rawHistory?.provenance,
        rawHistory?.cacheStatus,
        rawHistory?.cacheState,
        rawHistory?.fromCache ? 'cached' : '',
        rawHistory?.cached ? 'cached' : '',
      ].filter(Boolean).join(' ');
      const source = String(rawHistory?.source || '').toLowerCase();
      const verifiedHistory = ['ibkr', 'ibkr_completed_history_checkpoint'].includes(source)
        && Array.isArray(rawHistory?.bars)
        && rawHistory.bars.length > 0
        && verifiedHistoricalContract(rawHistory, config.instrument)
        && !FORBIDDEN.test(provenance);
      return verifiedHistory ? normalizeUnderlyingBars(rawHistory.bars, nowMs) : [];
    };
    const oneDayPoints = verifiedPoints(oneDayHistoryResult);
    const multiDayPoints = verifiedPoints(multiDayHistoryResult);
    const currentPoint = verifiedCurrentPointFromSpot(spot, nowMs);
    const athRecordSettlement = config.skipAthRecord === true
      ? { status: 'skipped' }
      : await settleWithin(loadIbkrHistoricalRecord(
          config.instrument,
          completedThroughDate,
          true,
        ), FRESH_REFERENCE_PROBE_MS);
    const ath = config.skipAthRecord === true
      ? unavailableAth('An all-time-high overlay is not available for the IBKR spot-gold proxy.')
      : normalizeHistoricalAth(
          athRecordSettlement.status === 'fulfilled' ? athRecordSettlement.value : null,
          athRecordSettlement,
          [...multiDayPoints, ...oneDayPoints, ...(currentPoint ? [currentPoint] : [])],
          completedThroughDate,
        );
    const proxyFitLabels = {
      proxyLabel: config.instrument?.displaySymbol || config.label,
      underlyingLabel: config.riskRangeTicker,
    };
    // Proxy-fit history is useful secondary context, but it must never consume
    // the card's first-paint budget or jump ahead of the price chart and ATH
    // request in the serialized IBKR history queue. Start it last and publish a
    // permanent CHECKING panel until the verified result is ready on a later
    // refresh.
    const proxyFitKey = [
      'ibkr',
      config.marketId || config.riskRangeTicker,
      config.instrument?.conId || config.instrument?.displaySymbol || config.label,
      completedThroughDate,
    ].join(':');
    let chart = await buildChartVariants({
      oneDayPoints,
      multiDayPoints,
      currentPoint,
      config,
      nowMs,
      source: [oneDayHistoryResult, multiDayHistoryResult].some((result) => (
        result.status === 'fulfilled' && result.value?.restoredFromCheckpoint === true
      )) ? 'ibkr_completed_history_checkpoint' : 'ibkr_historical_bars',
      oneDayInterval: '5m',
      multiDayInterval,
      fit,
      label: fit === 'proxy'
        ? `PROXY · ${config.instrument.displaySymbol || config.label}`
        : null,
      successfulReason: fit === 'proxy'
        ? config.proxyHistoryReason || 'Verified native futures history shown as proxy context only.'
        : null,
      loadRiskRangeHistory: riskRangeLoader,
      riskRangeWaitMs: config.riskRangeWaitMs,
    });
    const proxyFitPromise = connected && config.skipProxyFit !== true
      ? loadProxyFitComparison(proxyFitKey, () => loadIbkrHistory(
          config.instrument,
          PROXY_FIT_HISTORY_RANGE,
          '1d',
          historyOptions,
        ).then((history) => buildVerifiedProxyFit({
          proxyPoints: directIbkrProxyFitPoints(history, nowMs, config.instrument),
          proxyLabel: proxyFitLabels.proxyLabel,
          underlyingLabel: proxyFitLabels.underlyingLabel,
          proxySource: 'ibkr_historical_bars',
          loadRiskRangeHistory: riskRangeLoader,
        })))
      : Promise.resolve(unavailableProxyFit(
          config.skipProxyFit === true
            ? 'Proxy-fit research is not used for this resolver reference.'
            : 'IBKR is disconnected; verified proxy-fit history is unavailable.',
          proxyFitLabels,
        ));
    const proxyFitResult = await settleWithin(proxyFitPromise, 0);
    const proxyFit = proxyFitResult.status === 'fulfilled'
      ? proxyFitResult.value
      : proxyFitResult.status === 'pending'
        ? pendingProxyFit('Verified proxy-fit comparison is loading.', proxyFitLabels)
        : unavailableProxyFit('Verified proxy-fit comparison is unavailable.', proxyFitLabels);
    if (oneDayHistoryResult.status === 'rejected' && chart.variants['1d']?.resolutionState !== 'coarser_verified') {
      chart = {
        ...refreshFailure(chart, oneDayHistoryResult.reason),
        variants: {
          ...chart.variants,
          '1d': refreshFailure(chart.variants['1d'], oneDayHistoryResult.reason),
        },
      };
    } else if (oneDayHistoryResult.status === 'rejected') {
      chart = {
        ...chart.variants['1d'],
        preferredResolutionRefreshIssue: String(
          oneDayHistoryResult.reason?.message || oneDayHistoryResult.reason || 'Verified 5-minute history is unavailable.',
        ).slice(0, 160),
        variants: {
          ...chart.variants,
          '1d': {
            ...chart.variants['1d'],
            preferredResolutionRefreshIssue: String(
              oneDayHistoryResult.reason?.message || oneDayHistoryResult.reason || 'Verified 5-minute history is unavailable.',
            ).slice(0, 160),
          },
        },
      };
    }
    if (multiDayHistoryResult.status === 'rejected') {
      chart = {
        ...chart,
        variants: {
          ...chart.variants,
          '5d': refreshFailure(chart.variants['5d'], multiDayHistoryResult.reason),
          '10d': refreshFailure(chart.variants['10d'], multiDayHistoryResult.reason),
        },
      };
    }
    if (quoteResult.status === 'rejected') spot = refreshFailure(spot, quoteResult.reason);
    if (fit === 'proxy') {
      const proxyLabel = `PROXY · ${config.instrument.displaySymbol || config.label}`;
      spot = {
        ...spot,
        fit: 'proxy',
        executable: false,
        label: proxyLabel,
        reason: spot.status === 'available'
          ? config.proxyReason || 'Verified liquid directional future; non-executable card reference.'
          : spot.reason,
      };
      chart = chartContract(Object.fromEntries(CHART_RANGES.map((range) => [range, {
        ...chart.variants[range],
        fit: 'proxy',
        executable: false,
        label: proxyLabel,
        reason: ['historical', 'available'].includes(chart.variants[range]?.status)
          ? config.proxyHistoryReason || 'Verified native futures history shown as proxy context only.'
          : chart.variants[range]?.reason,
      }])), chartReason, 'proxy');
    }
    chart = attachAthToChart(chart, ath);
    const completedHistoricalReference = chart.status === 'historical'
      || chart.availability === 'historical';
    const chartMaySupplyDisplayReference = completedHistoricalReference
      || config.allowCurrentBarSpot === true
      || config.requireLast !== true;
    if (chartMaySupplyDisplayReference
      && spot.status !== 'available'
      && ['available', 'historical'].includes(chart.status)) {
      const historical = chart.status === 'historical';
      spot = {
        status: historical ? 'historical' : 'available',
        availability: historical ? 'historical' : 'live',
        value: chart.latestValue,
        label: fit === 'proxy'
          ? `PROXY · ${config.instrument.displaySymbol || config.label} ${historical ? 'LAST CLOSE' : 'CURRENT BAR'}`
          : historical ? `${config.label} LAST CLOSE` : `${config.label} CURRENT BAR`,
        source: chart.source,
        asOf: chart.latestAt,
        expiresAt: chart.expiresAt,
        historicalThroughDate: chart.historicalThroughDate || null,
        fit,
        executable: false,
        reason: fit === 'proxy'
          ? config.proxyReason || 'Verified directional proxy reference; non-executable.'
          : historical ? 'Latest completed resolver-reference close; not an executable quote.' : 'Current verified resolver-reference bar; not an executable quote.',
      };
    }
    const priorClose = previousCompletedClose(multiDayPoints, spot.asOf, {
      chartSession: config.chartSession,
    });
    if (priorClose && ['available', 'historical'].includes(spot.status)) {
      spot = {
        ...spot,
        previousClose: priorClose.value,
        previousCloseAsOf: priorClose.asOf,
        previousCloseSource: chart.source || 'ibkr_historical_bars',
      };
    }
    return {
      spot,
      chart,
      proxyFit,
      resolver: config.resolver,
      fit,
      instrument: config.instrument,
      ...(config.collectGoldTrackingPoints === true ? {
        _goldTrackingPoints: multiDayPoints.map((point) => ({
          timestamp: point.timestamp,
          value: point.value,
        })),
      } : {}),
      backgroundRefresh: [statusResult, quoteResult, oneDayHistoryResult, multiDayHistoryResult, proxyFitResult]
        .concat(athRecordSettlement)
        .some((result) => result.status === 'pending')
        || config.selectionRefreshPending === true
        || CHART_RANGES.some((range) => chart.variants?.[range]?.riskRangeRefreshPending === true),
    };
  }

  async function loadGoldHeaderIbkrReference(config) {
    const nowMs = currentMs();
    const providerStatus = await loadIbkrProviderStatus();
    const connectionState = providerConnectionState(providerStatus);
    if (connectionState !== 'connected' || !config?.instrument) {
      const transient = Boolean(config?.instrument) && connectionState === 'indeterminate';
      const reason = !config?.instrument
        ? `The verified ${config?.label || 'Gold'} instrument is unavailable.`
        : transient
          ? 'IBKR is temporarily unresponsive; the verified Gold reference is refreshing.'
          : 'IBKR is disconnected; the verified Gold reference is unavailable.';
      return {
        spot: {
          ...unavailable(reason, {
            value: null, label: config?.label || 'GOLD', fit: 'proxy', executable: false,
          }),
          ...(transient ? {
            status: 'refreshing',
            refreshing: true,
            refreshPending: true,
            errorCode: 'IBKR_STATUS_UNRESPONSIVE',
          } : config?.instrument ? { errorCode: 'IBKR_DISCONNECTED' } : {}),
        },
        instrument: config?.instrument || null,
        resolver: config?.resolver || null,
        fit: 'proxy',
        backgroundRefresh: transient,
      };
    }
    const completedThroughDate = typeof config.latestCompletedDate === 'function'
      ? config.latestCompletedDate(nowMs)
      : latestCompletedWtiSessionDate(nowMs);
    const quotePromise = loadIbkrQuote(config.instrument);
    const intradayPromise = config.allowCurrentBarSpot === true
      ? loadIbkrHistory(config.instrument, '1d', '5m', {
          useRth: false,
          allowProviderRequest: true,
          priorityProviderRequest: config.priorityIntradayHistory === true,
        })
      : null;
    const historyPromise = loadIbkrHistory(config.instrument, MULTI_DAY_HISTORY_RANGE, '1h', {
      marketId: config.marketId || 'gold',
      completedThroughDate,
      useRth: false,
      allowProviderRequest: true,
      priorityProviderRequest: true,
    });
    let [quoteResult, intradayResult, historyResult] = await Promise.all([
      settleWithin(quotePromise),
      intradayPromise
        ? settleWithin(intradayPromise)
        : Promise.resolve({ status: 'fulfilled', value: null }),
      // Prior-close context must not hold a verified live quote behind the
      // historical worker queue. The request continues and populates its
      // verified provider cache for a later refresh.
      settleWithin(historyPromise, FRESH_REFERENCE_PROBE_MS),
    ]);
    let spot = normalizeLiveQuote(
      quoteResult.status === 'fulfilled' ? quoteResult.value : null,
      config.label,
      nowMs,
      { requireLast: config.requireLast === true },
    );
    const currentBar = intradayResult.status === 'fulfilled' && intradayResult.value
      ? normalizeIbkrChart(intradayResult.value, {
          ...config,
          range: '1d',
          interval: '5m',
          fit: 'proxy',
        }, nowMs)
      : null;
    if (spot.status !== 'available'
      && currentBar?.status === 'available'
      && currentBar.availability === 'live') {
      spot = {
        status: 'available',
        availability: 'live',
        value: currentBar.latestValue,
        label: `${config.label} CURRENT BAR`,
        source: currentBar.source,
        asOf: currentBar.latestAt,
        expiresAt: currentBar.expiresAt,
        fit: 'proxy',
        executable: false,
        reason: config.proxyReason || 'Verified current IBKR Gold bar; non-executable.',
      };
    }
    if (spot.status !== 'available' && historyResult.status === 'pending') {
      historyResult = await settleWithin(historyPromise);
    }
    const points = directIbkrProxyFitPoints(
      historyResult.status === 'fulfilled' ? historyResult.value : null,
      nowMs,
      config.instrument,
    ).filter((point) => historicalBarDateKey(point.timestamp) <= completedThroughDate);
    if (spot.status === 'available') {
      const prior = previousCompletedClose(points, spot.asOf, {
        chartSession: config.chartSession || null,
      });
      if (prior) {
        spot = {
          ...spot,
          previousClose: prior.value,
          previousCloseAsOf: prior.asOf,
          previousCloseSource: 'ibkr_historical_bars',
        };
      }
    } else {
      const latest = points.at(-1) || null;
      const latestSessionDate = config.chartSession
        ? resolverSessionDateForPoint(config.chartSession, latest?.timestamp)
        : historicalBarDateKey(latest?.timestamp);
      const previous = latest ? previousCompletedClose(
        points,
        new Date(latest.timestamp).toISOString(),
        { chartSession: config.chartSession || null },
      ) : null;
      if (latest && latestSessionDate === completedThroughDate) {
        spot = {
          status: 'historical',
          availability: 'historical',
          value: latest.value,
          previousClose: previous?.value ?? null,
          previousCloseAsOf: previous?.asOf || null,
          previousCloseSource: 'ibkr_historical_bars',
          label: `${config.label} LAST CLOSE`,
          source: 'ibkr_historical_bars',
          asOf: new Date(latest.timestamp).toISOString(),
          expiresAt: null,
          fit: 'proxy',
          executable: false,
          reason: 'Latest verified completed IBKR session; not an executable quote.',
        };
      }
    }
    return {
      spot: { ...spot, fit: 'proxy', executable: false },
      instrument: config.instrument,
      resolver: config.resolver,
      fit: 'proxy',
      backgroundRefresh: historyResult.status === 'pending'
        || intradayResult.status === 'pending'
        || quoteResult.status === 'pending',
    };
  }

  async function attachGoldMarketReferences(reference, selected) {
    const nowMs = currentMs();
    const venueId = referenceVenueId(selected) || 'kalshi';
    const exactReference = venueId === 'forecastex'
      ? reference?.fit === 'exact' ? reference : null
      : reference?.exactReference || (reference?.fit === 'exact' ? reference : null);
    const exactUnavailableReason = venueId === 'forecastex'
      ? 'The selected ForecastEx contract does not publish a verified exact dated COMEX Gold resolver instrument.'
      : 'The exact Pyth Metal.Index.GOLD/USD resolver reference is unavailable.';
    const xauReferencePromise = reference?.proxyReference
      ? Promise.resolve(reference.proxyReference)
      : loadIbkrReference(
          withResolverChartSession(goldSpotProxyConfig(), selected, nowMs),
          { fit: 'proxy', riskRangeLoader: loadStableRiskRangeHistory },
        );
    const activeReferencePromise = directionalReferenceConfig('gold', selected).then((config) => (
      config?.instrument
        ? loadGoldHeaderIbkrReference(config)
        : {
          spot: unavailable('The active liquid COMEX Gold contract is unavailable.', {
            value: null, label: 'GC', fit: 'proxy', executable: false,
          }),
          instrument: null,
          resolver: config?.resolver || null,
          fit: 'proxy',
        }
    ));
    const [xauResult, activeResult] = await Promise.all([
      settleWithin(xauReferencePromise, GOLD_HEADER_REFERENCE_WAIT_MS),
      // COMEX is secondary context. Do not hold XAUUSD and the Gold chart for
      // a full historical-worker timeout; the request continues and its
      // verified result is published by the next monitor pass.
      settleWithin(activeReferencePromise, GOLD_SECONDARY_HEADER_PROBE_MS),
    ]);
    const xauReference = xauResult.status === 'fulfilled' ? xauResult.value : {
      spot: {
        ...unavailable('Verified IBKR XAUUSD is loading.', {
          value: null, label: 'XAUUSD', fit: 'proxy', executable: false,
        }),
        status: xauResult.status === 'pending' ? 'loading' : 'unavailable',
      },
      instrument: GOLD_SPOT_PROXY_INSTRUMENT,
      fit: 'proxy',
    };
    const activeReference = activeResult.status === 'fulfilled' ? activeResult.value : {
      spot: {
        ...unavailable('The active liquid COMEX Gold reference is loading.', {
          value: null, label: 'GC', fit: 'proxy', executable: false,
        }),
        status: activeResult.status === 'pending' ? 'loading' : 'unavailable',
      },
      instrument: null,
      fit: 'proxy',
    };
    const activeDirect = goldResolverContractMatches(activeReference.instrument, reference, selected);
    const exactSymbol = venueId === 'forecastex'
      ? exactReference?.instrument?.displaySymbol || selected?.resolverIdentity?.resolverSymbol || 'GC'
      : 'GOLD/USD';
    const items = [
      goldReferenceItem({
        key: 'selectedResolver',
        label: venueId === 'forecastex' ? 'COMEX SETTLEMENT' : 'PYTH GOLD INDEX',
        symbol: exactSymbol,
        role: 'direct',
        reference: exactReference || {
          spot: unavailable(exactUnavailableReason, {
            value: null, label: exactSymbol, fit: 'exact', executable: false,
          }),
        },
        instrument: exactReference?.instrument || null,
        nowMs,
        unavailableReason: exactUnavailableReason,
      }),
      goldReferenceItem({
        key: 'xauusd',
        label: 'SPOT GOLD',
        symbol: 'XAUUSD',
        role: 'proxy',
        reference: xauReference,
        instrument: GOLD_SPOT_PROXY_INSTRUMENT,
        nowMs,
        unavailableReason: 'Verified IBKR XAUUSD spot gold is unavailable.',
      }),
      goldReferenceItem({
        key: 'activeComex',
        label: 'COMEX GOLD',
        symbol: activeReference?.instrument?.displaySymbol || 'GC',
        role: activeDirect ? 'direct' : 'proxy',
        reference: activeReference,
        instrument: activeReference?.instrument || null,
        nowMs,
        unavailableReason: 'The verified active liquid COMEX Gold reference is unavailable.',
      }),
    ];
    return {
      ...reference,
      // Publish the complete XAUUSD reference outside the compact header list
      // as well. This keeps the black Risk Range series tied to XAUUSD even
      // when the selected settlement contract is a dated ForecastEx future.
      proxyReference: xauReference,
      goldMarketReferences: items,
      backgroundRefresh: reference?.backgroundRefresh === true
        || xauResult.status === 'pending'
        || activeResult.status === 'pending'
        || xauReference?.backgroundRefresh === true
        || activeReference?.backgroundRefresh === true,
    };
  }

  async function loadKalshiGoldReference({ selected, nowMs, loadRiskRangeHistory }) {
    const [exact, rawProxy] = await Promise.all([
      loadPythReference({
        marketId: 'gold',
        selected,
        client: httpClient,
        nowMs,
        loadRiskRangeHistory,
      }),
      loadIbkrReference(withResolverChartSession({
        ...goldSpotProxyConfig(),
        collectGoldTrackingPoints: true,
      }, selected, nowMs), {
        fit: 'proxy',
        riskRangeLoader: loadRiskRangeHistory,
      }),
    ]);
    const { _goldTrackingPoints: trackingPoints = [], ...proxy } = rawProxy || {};
    const eventTicker = selectedGoldEventTicker(selected);
    let resolverTracking = emptyGoldPythTracking(
      eventTicker
        ? 'Verified Pyth tracking history is loading.'
        : 'The selected contract is not a verified daily KXGOLDD event.',
      eventTicker ? { status: 'loading', refreshPending: true } : {},
    );
    let trackingPending = false;
    if (eventTicker) {
      const trackingResult = await settleWithin(loadGoldPythTrackingPayload(), 2_500);
      trackingPending = trackingResult.status === 'pending';
      if (trackingResult.status === 'fulfilled') {
        resolverTracking = buildGoldPythTracking({
          payload: trackingResult.value,
          proxyPoints: trackingPoints,
          selectedEventTicker: eventTicker,
        });
      } else if (trackingResult.status === 'rejected') {
        resolverTracking = emptyGoldPythTracking(
          'Official finalized Kalshi Gold tracking history is temporarily unavailable.',
        );
      }
    }
    const exactSpotAvailable = exact.spot?.status === 'available';
    const exactVariantsAvailable = CHART_RANGES.every((range) => (
      ['available', 'historical'].includes(exact.chart?.variants?.[range]?.status)
    ));
    if (exactSpotAvailable && exactVariantsAvailable) {
      return {
        ...exact,
        fit: 'exact',
        proxyFit: proxy.proxyFit,
        proxyReference: proxy,
        resolverTracking,
        backgroundRefresh: exact.backgroundRefresh === true
          || proxy.backgroundRefresh === true
          || trackingPending,
      };
    }
    const exactVariantAvailable = (range) => (
      ['available', 'historical'].includes(exact.chart?.variants?.[range]?.status)
    );
    const anyExactChart = CHART_RANGES.some(exactVariantAvailable);
    if (exactSpotAvailable || anyExactChart) {
      const variants = Object.fromEntries(CHART_RANGES.map((range) => [
        range,
        exactVariantAvailable(range) ? exact.chart.variants[range] : proxy.chart?.variants?.[range],
      ]));
      const chart = chartContract(
        variants,
        'Verified Pyth Gold and IBKR XAUUSD chart history are unavailable.',
        variants['1d']?.fit || 'proxy',
      );
      return {
        spot: exactSpotAvailable ? exact.spot : proxy.spot,
        chart,
        proxyFit: proxy.proxyFit,
        resolver: exact.resolver || 'Pyth Metal.Index.GOLD/USD',
        fit: exactSpotAvailable ? 'exact' : 'proxy',
        instrument: exactSpotAvailable ? null : proxy.instrument,
        proxyInstrument: proxy.instrument,
        proxyResolver: proxy.resolver,
        exactReference: exact,
        proxyReference: proxy,
        resolverTracking,
        backgroundRefresh: exact.backgroundRefresh === true
          || proxy.backgroundRefresh === true
          || trackingPending,
      };
    }
    return {
      ...proxy,
      resolver: `${exact.resolver || 'Pyth Metal.Index.GOLD/USD'}; IBKR XAUUSD spot proxy shown`,
      proxyResolver: proxy.resolver,
      exactReference: exact,
      proxyReference: proxy,
      resolverTracking,
      backgroundRefresh: proxy.backgroundRefresh === true || trackingPending,
    };
  }

  async function loadContractReference({ marketId, selected }) {
    const nowMs = currentMs();
    const riskRangeRequests = new Map();
    const loadRiskRangeOnce = (context) => {
      const ticker = String(context?.ticker || '').trim().toUpperCase();
      const dates = [...new Set((Array.isArray(context?.dates) ? context.dates : [])
        .map((date) => String(date || '').trim())
        .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)))].sort();
      const key = `${ticker}:${dates.join(',')}`;
      if (!riskRangeRequests.has(key)) {
        riskRangeRequests.set(key, loadStableRiskRangeHistory({ ticker, dates }));
      }
      return riskRangeRequests.get(key);
    };
    const venueId = referenceVenueId(selected);
    if (marketId === 'gold' && venueId !== 'forecastex') {
      const reference = await loadKalshiGoldReference({
        selected,
        nowMs,
        loadRiskRangeHistory: loadRiskRangeOnce,
      });
      return attachGoldMarketReferences(reference, selected, loadRiskRangeOnce);
    }
    if (venueId === 'forecastex' && ['sp500', 'gold', 'silver', 'wti'].includes(marketId)) {
      const rawConfig = ['gold', 'silver'].includes(marketId)
        ? forecastCommodityReferenceConfig(marketId, selected, nowMs)
        : referenceConfig(marketId, selected, nowMs);
      const config = withResolverChartSession(rawConfig, selected, nowMs);
      if (!config?.instrument) {
        const label = String(marketId || '').toUpperCase();
        const missingExactReference = {
          spot: unavailable(`The exact dated ForecastEx ${label} resolver instrument is unavailable.`, {
            value: null, label, fit: 'exact', executable: false,
          }),
          chart: chartContract({}, `Verified exact dated ForecastEx ${label} chart is unavailable.`, 'exact'),
          proxyFit: unavailableProxyFit('Verified resolver comparison history is unavailable.', {
            proxyLabel: label,
            underlyingLabel: marketId === 'gold' ? 'GLD' : 'SILVER',
          }),
          resolver: null,
          fit: 'exact',
        };
        return marketId === 'gold'
          ? attachGoldMarketReferences(missingExactReference, selected, loadRiskRangeOnce)
          : missingExactReference;
      }
      const reference = await loadIbkrReference(config, {
        fit: config.fit || 'exact',
        riskRangeLoader: loadRiskRangeOnce,
      });
      return marketId === 'gold'
        ? attachGoldMarketReferences(reference, selected, loadRiskRangeOnce)
        : reference;
    }
    if (marketId === 'wti' && venueId === 'kalshi') {
      const config = withResolverChartSession(referenceConfig(marketId, selected, nowMs), selected, nowMs);
      if (!config?.instrument) {
        return {
          spot: unavailable('The exact dated ICE WTI resolver instrument is unavailable.', {
            value: null, label: 'WTI', fit: 'exact', executable: false,
          }),
          chart: chartContract({}, 'Verified exact dated ICE WTI chart history is unavailable.', 'exact'),
          proxyFit: unavailableProxyFit('Verified ICE WTI comparison history is unavailable.', {
            proxyLabel: 'WTI', underlyingLabel: 'WTIC',
          }),
          resolver: config?.resolver || 'ICE WBS dated settlement contract',
          fit: 'exact',
        };
      }
      return loadQualifiedFuturesReference(config, {
        fit: 'exact',
        riskRangeLoader: loadRiskRangeOnce,
      });
    }
    if (['gold', 'silver', 'brent'].includes(marketId)) {
      const exact = await loadPythReference({
        marketId,
        selected,
        client: httpClient,
        nowMs,
        loadRiskRangeHistory: loadRiskRangeOnce,
      });
      if (exact.spot?.status === 'available' && exact.chart?.status === 'available'
        && CHART_RANGES.every((range) => ['available', 'historical'].includes(exact.chart?.variants?.[range]?.status))) {
        return { ...exact, fit: 'exact' };
      }
      // Gold and Silver are exact Pyth-resolver products. A COMEX future must
      // never silently replace their resolver series. Brent alone keeps its
      // explicitly labeled, non-executable futures proxy until Pyth access is
      // entitled for the event-specific symbol.
      if (marketId !== 'brent') return { ...exact, fit: 'exact' };
      const proxyConfig = withResolverChartSession(referenceConfig('brent', selected, nowMs), selected, nowMs);
      if (!proxyConfig?.instrument) return { ...exact, fit: 'exact' };
      const proxy = await loadIbkrReference({
        ...proxyConfig,
      }, { fit: 'proxy', riskRangeLoader: loadRiskRangeOnce });
      if (exact.spot?.status === 'available' || CHART_RANGES.some((range) => (
        ['available', 'historical'].includes(exact.chart?.variants?.[range]?.status)
      ))) {
        const variants = Object.fromEntries(CHART_RANGES.map((range) => {
          const exactVariant = exact.chart?.variants?.[range];
          const proxyVariant = proxy.chart?.variants?.[range];
          return [range, ['available', 'historical'].includes(exactVariant?.status) ? exactVariant : proxyVariant];
        }));
        const chart = chartContract(variants, `Verified ${marketId} chart history is unavailable.`, variants['1d']?.fit || 'exact');
        return {
          spot: exact.spot?.status === 'available' ? exact.spot : proxy.spot,
          chart,
          resolver: exact.resolver,
          fit: chart.fit,
          proxyResolver: proxy.resolver,
          exactReference: exact,
        };
      }
      return { ...proxy, exactReference: exact };
    }
    if (marketId === 'bitcoin') {
      const [athRecordSettlement, proxyFitHistorySettlement] = await Promise.all([
        settleWithin(
          loadCoinbaseAthRecord(previousCalendarSessionDate(nowMs)),
          FRESH_REFERENCE_PROBE_MS,
        ),
        settleWithin(loadCoinbaseProxyFitHistoryCached(), FRESH_REFERENCE_PROBE_MS),
      ]);
      return loadCoinbaseBitcoinReference({
        client: httpClient,
        nowMs,
        selected,
        loadRiskRangeHistory: loadRiskRangeOnce,
        loadProxyFitComparison,
        athRecordSettlement,
        proxyFitHistorySettlement,
      });
    }
    if (FUTURES_MARKET_IDS.includes(marketId)) {
      const config = await directionalReferenceConfig(marketId, selected);
      if (!config?.instrument) {
        const definition = DIRECTIONAL_FEEDS[marketId];
        const label = definition?.root || String(marketId || '').toUpperCase();
        return {
          spot: unavailable(`Verified ${label} directional contract selection is unavailable.`, {
            value: null, label, fit: 'proxy', executable: false,
          }),
          chart: chartContract({}, `Verified ${label} directional chart is unavailable.`, 'proxy'),
          proxyFit: unavailableProxyFit('Verified directional proxy history is unavailable.', {
            proxyLabel: label,
            underlyingLabel: definition?.riskRangeTicker || null,
          }),
          resolver: config?.resolver || null,
          fit: 'proxy',
          directionalFeed: definition || null,
        };
      }
      const reference = await loadIbkrReference(config, {
        fit: 'proxy',
        riskRangeLoader: loadRiskRangeOnce,
      });
      return {
        ...reference,
        directionalFeed: {
          marketId,
          provider: 'ibkr',
          conId: config.instrument.conId || null,
          localSymbol: config.instrument.localSymbol || config.instrument.displaySymbol || null,
          lastTradeDate: config.instrument.lastTradeDateOrContractMonth || null,
          rollReason: config.rollReason,
          executable: false,
        },
      };
    }
    const config = withResolverChartSession(referenceConfig(marketId, selected, nowMs), selected, nowMs);
    if (!config?.instrument) {
      const label = config?.label || String(marketId || '').toUpperCase();
      return {
        spot: unavailable(`The exact ${label} resolver instrument is unavailable.`, { value: null, label }),
        chart: chartContract({}, `Verified ${label} resolver chart is unavailable.`, config?.fit || 'exact'),
        proxyFit: unavailableProxyFit('Verified reference comparison history is unavailable.', {
          proxyLabel: label,
          underlyingLabel: config?.riskRangeTicker || null,
        }),
        resolver: config?.resolver || null,
      };
    }
    return loadIbkrReference(config, { fit: config.fit || 'exact', riskRangeLoader: loadRiskRangeOnce });
  }

  function sameVerifiedIbkrInstrument(left, right) {
    const leftInstrument = left?.instrument || left;
    const rightInstrument = right?.instrument || right;
    if (!leftInstrument || !rightInstrument) return false;
    const leftProvider = String(leftInstrument.provider || 'ibkr').toLowerCase();
    const rightProvider = String(rightInstrument.provider || 'ibkr').toLowerCase();
    if (leftProvider !== 'ibkr' || rightProvider !== 'ibkr') return false;
    const leftConId = Number(leftInstrument.conId || leftInstrument.conid);
    const rightConId = Number(rightInstrument.conId || rightInstrument.conid);
    return Number.isInteger(leftConId) && leftConId > 0
      && Number.isInteger(rightConId) && rightConId > 0
      && leftConId === rightConId;
  }

  async function loadDirectionalBasisReference(
    marketId,
    selected,
    reusableReference = null,
    suppliedConfig = null,
  ) {
    const definition = DIRECTIONAL_FEEDS[marketId];
    const config = suppliedConfig || await directionalReferenceConfig(marketId, selected);
    if (!definition || !config?.instrument) {
      const label = definition?.root || String(marketId || '').toUpperCase();
      return {
        spot: unavailable(`Verified ${label} Risk Range basis selection is unavailable.`, {
          value: null, label, fit: 'proxy', executable: false,
        }),
        chart: chartContract({}, `Verified ${label} Risk Range basis chart is unavailable.`, 'proxy'),
        resolver: config?.resolver || null,
        fit: 'proxy',
        instrument: config?.instrument || null,
        directionalFeed: definition || null,
      };
    }
    // A selected resolver and its Risk Range basis can intentionally be the
    // same verified IBKR contract. Reuse that response by conId so the two
    // visual roles remain distinct without opening duplicate quote/history
    // subscriptions. Symbol-only matches are not sufficient across rolls.
    const reference = sameVerifiedIbkrInstrument(reusableReference, config.instrument)
      ? reusableReference
      : await loadIbkrReference(config, {
          fit: 'proxy',
          riskRangeLoader: loadStableRiskRangeHistory,
        });
    return {
      ...reference,
      directionalFeed: {
        marketId,
        provider: 'ibkr',
        conId: config.instrument.conId || null,
        localSymbol: config.instrument.localSymbol || config.instrument.displaySymbol || null,
        lastTradeDate: config.instrument.lastTradeDateOrContractMonth || null,
        rollReason: config.rollReason,
        executable: false,
      },
    };
  }

  async function loadStableDirectionalBasisReference(marketId, selected, reusableReference = null) {
    const config = await directionalReferenceConfig(marketId, selected);
    const event = eventFromSelection(selected);
    const generationId = event?.event_ticker
      || event?.ticker
      || event?.generationId
      || selected?.generationId
      || 'default';
    const conId = Number(config?.instrument?.conId || config?.instrument?.conid);
    const identity = Number.isInteger(conId) && conId > 0
      ? String(conId)
      : config?.instrument?.localSymbol
        || config?.instrument?.displaySymbol
        || 'unavailable';
    const key = `${marketId}:${identity}:${generationId}`;
    let state = directionalBasisReferenceStates.get(key);
    if (!state) {
      state = { value: null, completedAt: 0, inFlight: null };
      directionalBasisReferenceStates.set(key, state);
    }
    const ageMs = currentMs() - Number(state.completedAt || 0);
    if (state.value && state.value.backgroundRefresh !== true && ageMs < 5_000) {
      return state.value;
    }
    if (!state.inFlight) {
      state.inFlight = loadDirectionalBasisReference(
        marketId,
        selected,
        reusableReference,
        config,
      ).then((value) => {
        const expectedHistoricalDate = typeof config?.latestCompletedDate === 'function'
          ? config.latestCompletedDate(currentMs())
          : null;
        state.value = value?.backgroundRefresh === true
          ? retainVerifiedReferenceWhileRefreshing(
              state.value,
              value,
              currentMs(),
              expectedHistoricalDate,
            ) || value
          : value;
        state.completedAt = currentMs();
        return state.value;
      }).finally(() => {
        state.inFlight = null;
      });
    }
    const confirmedDisconnected = currentMs() < providerStatusState.expiresAt
      && providerConnectionState(providerStatusState.value) === 'disconnected';
    if (state.value && !confirmedDisconnected) {
      // Give a fast, already-verified overlay/cache refresh one brief chance to
      // publish before returning the retained card. A genuinely slow provider
      // still falls through to the prior unexpired value without blanking it.
      const probe = await settleWithin(state.inFlight, FRESH_REFERENCE_PROBE_MS);
      if (probe.status === 'fulfilled') return probe.value;
      const expectedHistoricalDate = typeof config?.latestCompletedDate === 'function'
        ? config.latestCompletedDate(currentMs())
        : null;
      const retained = retainVerifiedReferenceWhileRefreshing(
        state.value,
        pendingDirectionalBasisReference(marketId),
        currentMs(),
        expectedHistoricalDate,
      );
      if (retained) return retained;
    }
    return state.inFlight;
  }

  function pendingDirectionalBasisReference(marketId) {
    const definition = DIRECTIONAL_FEEDS[marketId];
    const label = definition?.root || String(marketId || '').toUpperCase();
    const reason = `Verified ${label} Risk Range basis is loading.`;
    const variant = (range) => ({
      ...unavailableChartVariant(range, reason, { fit: 'proxy' }),
      status: 'refreshing',
      refreshing: true,
      refreshPending: true,
    });
    const oneDay = variant('1d');
    return {
      spot: {
        ...unavailable(reason, { value: null, label, fit: 'proxy', executable: false }),
        status: 'refreshing',
        refreshing: true,
        refreshPending: true,
      },
      chart: {
        ...oneDay,
        variants: { '1d': oneDay, '5d': variant('5d'), '10d': variant('10d') },
      },
      resolver: `${definition?.exchange || ''} ${label} liquid Risk Range basis`.trim(),
      fit: 'proxy',
      instrument: null,
      directionalFeed: definition || null,
      backgroundRefresh: true,
    };
  }

  function referenceSymbol(reference, fallback) {
    return reference?.instrument?.displaySymbol
      || reference?.instrument?.localSymbol
      || fallback;
  }

  function pendingContractReference(marketId, selected) {
    const config = withResolverChartSession(referenceConfig(marketId, selected, currentMs()), selected, currentMs());
    const label = config?.instrument?.displaySymbol || config?.label || String(marketId || '').toUpperCase();
    const reason = `Verified ${label} contract reference is loading.`;
    const variant = (range) => ({
      ...unavailableChartVariant(range, reason, {
        fit: config?.fit || 'exact',
        interval: range === '1d' ? '5m' : '1h',
        sessionWindow: range === '1d' ? config?.chartSession?.currentWindow || null : null,
      }),
      status: 'refreshing',
      refreshing: true,
      refreshPending: true,
    });
    const oneDay = variant('1d');
    return {
      spot: {
        ...unavailable(reason, {
          value: null,
          label,
          fit: config?.fit || 'exact',
          executable: false,
        }),
        status: 'refreshing',
        refreshing: true,
        refreshPending: true,
      },
      chart: {
        ...oneDay,
        variants: { '1d': oneDay, '5d': variant('5d'), '10d': variant('10d') },
      },
      proxyFit: pendingProxyFit(reason, {
        proxyLabel: label,
        underlyingLabel: config?.riskRangeTicker || null,
      }),
      resolver: config?.resolver || null,
      fit: config?.fit || 'exact',
      instrument: config?.instrument || null,
      backgroundRefresh: true,
    };
  }

  async function loadStableContractReference(marketId, selected) {
    const config = withResolverChartSession(
      referenceConfig(marketId, selected, currentMs()),
      selected,
      currentMs(),
    );
    const event = eventFromSelection(selected);
    const generationId = event?.event_ticker
      || event?.ticker
      || event?.generationId
      || selected?.generationId
      || 'default';
    const instrumentIdentity = [
      config?.instrument?.conId || config?.instrument?.conid || '',
      config?.instrument?.symbol || '',
      expectedFuturesContractMonth(config?.instrument) || '',
      config?.instrument?.displaySymbol || '',
    ].join(':');
    const key = `${marketId}:${referenceVenueId(selected) || 'unknown'}:${generationId}:${instrumentIdentity}`;
    let state = contractReferenceStates.get(key);
    if (!state) {
      state = { value: null, completedAt: 0, inFlight: null };
      contractReferenceStates.set(key, state);
    }
    const ageMs = currentMs() - Number(state.completedAt || 0);
    if (state.value && state.value.backgroundRefresh !== true && ageMs < 5_000) {
      return state.value;
    }
    if (!state.inFlight) {
      state.inFlight = loadContractReference({ marketId, selected }).then((value) => {
        const prior = state.value;
        const expectedHistoricalDate = typeof config?.latestCompletedDate === 'function'
          ? config.latestCompletedDate(currentMs())
          : null;
        let next = value?.backgroundRefresh === true
          ? retainVerifiedReferenceWhileRefreshing(
              prior,
              value,
              currentMs(),
              expectedHistoricalDate,
            ) || value
          : value;
        if (['available', 'partial'].includes(prior?.proxyFit?.status)
          && ['loading', 'refreshing'].includes(next?.proxyFit?.status)) {
          next = { ...next, proxyFit: prior.proxyFit };
        }
        state.value = next;
        state.completedAt = currentMs();
        return state.value;
      }).finally(() => {
        state.inFlight = null;
      });
    }
    const confirmedDisconnected = currentMs() < providerStatusState.expiresAt
      && providerConnectionState(providerStatusState.value) === 'disconnected';
    if (state.value && !confirmedDisconnected) {
      const probe = await settleWithin(state.inFlight, FRESH_REFERENCE_PROBE_MS);
      if (probe.status === 'fulfilled') return probe.value;
      if (probe.status === 'rejected') throw probe.reason;
      const expectedHistoricalDate = typeof config?.latestCompletedDate === 'function'
        ? config.latestCompletedDate(currentMs())
        : null;
      const retained = retainVerifiedReferenceWhileRefreshing(
        state.value,
        pendingContractReference(marketId, selected),
        currentMs(),
        expectedHistoricalDate,
      );
      if (retained) return {
        ...retained,
        proxyFit: state.value.proxyFit,
        instrument: state.value.instrument,
      };
    }
    return state.inFlight;
  }

  async function loadSnapshot({ marketId, selected }) {
    // WTI's black Risk Range chart is the first-paint reference. Load it before
    // scheduling the independent ICE resolver history so the serialized IBKR
    // queue cannot make the visible chart wait behind the blue overlay.
    let contractReference;
    let directionalBasisReference = null;
    if (marketId === 'wti') {
      directionalBasisReference = await loadStableDirectionalBasisReference(marketId, selected);
      const contractResult = await settleWithin(
        loadStableContractReference(marketId, selected),
        350,
      );
      contractReference = contractResult.status === 'fulfilled'
        ? contractResult.value
        : contractResult.status === 'rejected'
          ? refreshFailure(pendingContractReference(marketId, selected), contractResult.reason)
          : pendingContractReference(marketId, selected);
    } else {
      contractReference = await loadContractReference({ marketId, selected });
    }
    const brentPythConfig = marketId === 'brent' ? pythReferenceConfig('brent', selected) : null;
    const stableBrentIndex = brentPythConfig?.symbol === PYTH_RESOLVER_IDENTITIES.brent.symbol;
    if (marketId === 'brent') {
      directionalBasisReference = await loadStableDirectionalBasisReference(
        marketId,
        selected,
        contractReference,
      );
      if (stableBrentIndex) {
        const exactReference = contractReference;
        const proxyFit = directionalBasisReference?.proxyFit ? {
          ...directionalBasisReference.proxyFit,
          exactResolverSymbol: brentPythConfig.symbol,
          exactResolverUrl: exactReference?.exactSourceUrl || null,
          exactResolverEntitlement: exactReference?.entitlement || null,
        } : null;
        contractReference = {
          ...directionalBasisReference,
          resolver: exactReference?.resolver || directionalBasisReference?.resolver || null,
          proxyResolver: directionalBasisReference?.resolver || null,
          exactReference,
          proxyReference: directionalBasisReference,
          proxyFit,
          fit: 'proxy',
          backgroundRefresh: exactReference?.backgroundRefresh === true
            || directionalBasisReference?.backgroundRefresh === true,
        };
      }
    } else if (['silver', 'gold'].includes(marketId)) {
      const directionalBasisResult = await settleWithin(
        loadDirectionalBasisReference(marketId, selected, contractReference),
        25,
      );
      directionalBasisReference = directionalBasisResult.status === 'fulfilled'
        ? directionalBasisResult.value
        : directionalBasisResult.status === 'rejected'
          ? {
              ...pendingDirectionalBasisReference(marketId),
              spot: refreshFailure(pendingDirectionalBasisReference(marketId).spot, directionalBasisResult.reason),
              chart: refreshFailure(pendingDirectionalBasisReference(marketId).chart, directionalBasisResult.reason),
            }
          : pendingDirectionalBasisReference(marketId);
    }
    if (!RISK_RANGE_BASIS_SYMBOLS[marketId]) return contractReference;

    let basisReference = contractReference;
    let comparisonReference = contractReference;
    let basisSymbol = RISK_RANGE_BASIS_SYMBOLS[marketId];
    let comparisonSymbol = referenceSymbol(contractReference, basisSymbol);
    let comparisonDisclosure = contractReference?.spot?.reason || null;
    let comparisonExact = contractReference?.fit === 'exact';

    if (['wti', 'silver', 'brent'].includes(marketId)) {
      basisReference = directionalBasisReference;
      if (marketId === 'brent' && stableBrentIndex) {
        comparisonReference = directionalBasisReference;
        comparisonSymbol = referenceSymbol(comparisonReference, 'BZ');
        comparisonDisclosure = 'Active BZ is a verified non-executable chart proxy for the Kalshi Pyth Brent index. The proxy fit does not compare against Pyth history.';
        comparisonExact = false;
      } else if (marketId === 'silver') {
        const selectedInstrument = contractReference?.instrument;
        const selectedDatedSilver = String(selectedInstrument?.symbol || '').toUpperCase() === 'SI'
          && /^SI[FGHJKMNQUVXZ]\d{1,2}$/i.test(String(
            selectedInstrument?.displaySymbol || selectedInstrument?.localSymbol || '',
          ));
        // Kalshi's exact Pyth resolver is retained in resolverReference. The
        // chart's blue role is the selected dated SI market reference; when
        // Kalshi does not name one, use the independently verified liquid SI
        // basis as an explicitly disclosed proxy (often the identical feed).
        if (!selectedDatedSilver) {
          comparisonReference = directionalBasisReference;
          const nativeSymbol = referenceSymbol(comparisonReference, 'SI');
          const nativeMonth = String(
            comparisonReference?.instrument?.lastTradeDateOrContractMonth || '',
          ).replace(/[^0-9]/g, '').slice(0, 6);
          const nativeMatch = String(nativeSymbol || '').toUpperCase()
            .match(/^SI([FGHJKMNQUVXZ])\d{1,2}$/);
          comparisonSymbol = nativeMatch && /^20\d{4}$/.test(nativeMonth)
            ? `SI${nativeMatch[1]}${nativeMonth.slice(2, 4)}`
            : nativeSymbol;
          comparisonDisclosure = 'The selected liquid COMEX Silver contract is a verified non-executable chart proxy; it is not the Pyth resolver.';
          comparisonExact = false;
        }
      }
    } else if (marketId === 'gold') {
      basisReference = contractReference?.proxyReference || contractReference;
      comparisonReference = directionalBasisReference;
      comparisonSymbol = referenceSymbol(comparisonReference, 'GC');
      comparisonDisclosure = 'Active COMEX Gold is a verified non-executable proxy; it is not the Kalshi Pyth resolver.';
      comparisonExact = false;
    } else if (marketId === 'bitcoin') {
      basisSymbol = 'BITCOIN';
      comparisonSymbol = 'BTC-USD';
      comparisonDisclosure = 'Coinbase BTC-USD is a verified non-executable proxy; it is not the CF Benchmarks BRTI resolver.';
      comparisonExact = false;
    }

    const riskRangeTicker = DIRECTIONAL_FEEDS[marketId]?.riskRangeTicker
      || (marketId === 'gold' ? 'GLD' : basisSymbol);
    const chartReferences = {
      basis: chartReferenceEntry({
        role: 'risk_range_basis',
        symbol: basisSymbol,
        riskRangeTicker,
        reference: basisReference,
        exact: marketId === 'bitcoin' || marketId === 'gold',
        disclosure: `${basisSymbol} is the verified price basis used with the ${riskRangeTicker} Risk Range.`,
      }),
      contract: chartReferenceEntry({
        role: comparisonExact ? 'contract_reference' : 'proxy_reference',
        symbol: comparisonSymbol,
        riskRangeTicker,
        reference: comparisonReference,
        exact: comparisonExact,
        disclosure: comparisonDisclosure,
      }),
    };
    const compatibleRootReference = marketId === 'wti' && basisReference
      ? {
          ...contractReference,
          spot: basisReference.spot,
          chart: basisReference.chart,
        }
      : contractReference;
    return {
      ...compatibleRootReference,
      chartReferences,
      backgroundRefresh: contractReference?.backgroundRefresh === true
        || basisReference?.backgroundRefresh === true
        || comparisonReference?.backgroundRefresh === true,
    };
  }

  async function getSnapshot(context) {
    const marketId = String(context?.marketId || '').toLowerCase();
    const selectedEvent = eventFromSelection(context?.selected);
    const eventId = selectedEvent?.event_ticker
      || selectedEvent?.ticker
      || selectedEvent?.generationId
      || context?.selected?.generationId
      || 'default';
    const venueId = referenceVenueId(context?.selected);
    const exactResolverSelection = (venueId === 'forecastex'
      && ['sp500', 'gold', 'silver', 'wti'].includes(marketId))
      || (venueId === 'kalshi' && ['wti', 'gold', 'silver'].includes(marketId));
    const directionalFeed = marketId === 'bitcoin'
      || (FUTURES_MARKET_IDS.includes(marketId) && !exactResolverSelection);
    const key = `${marketId}:${venueId || 'unknown'}:${eventId}`;
    const expectedHistoricalDate = expectedHistoricalDateForMarket(marketId, currentMs());
    let state = referenceStates.get(key);
    if (!state) {
      state = { value: null, completedAt: 0, inFlight: null };
      referenceStates.set(key, state);
    }
    if (state.value
      && state.value.backgroundRefresh !== true
      && currentMs() - state.completedAt < 5_000) return state.value;
    if (!state.inFlight) {
      const snapshotLoad = Promise.resolve(loadSnapshot(context));
      const refreshTimeoutMs = marketId === 'bitcoin'
        ? Math.max(25, Number(coinbaseReferenceRefreshTimeoutMs)
          || COINBASE_REFERENCE_REFRESH_TIMEOUT_MS)
        : marketId === 'gold'
          ? Math.max(25, Number(goldReferenceRefreshTimeoutMs)
            || GOLD_REFERENCE_REFRESH_TIMEOUT_MS)
          : null;
      const boundedSnapshotLoad = refreshTimeoutMs != null
        ? settleWithin(
            snapshotLoad,
            refreshTimeoutMs,
          ).then((result) => {
            if (result.status === 'fulfilled') return result.value;
            if (result.status === 'rejected') throw result.reason;
            const goldTimeout = marketId === 'gold';
            throw Object.assign(
              new Error(goldTimeout
                ? 'Verified Gold reference refresh timed out.'
                : 'Verified Coinbase BTC-USD reference refresh timed out.'),
              { code: goldTimeout
                ? 'GOLD_REFERENCE_REFRESH_TIMEOUT'
                : 'COINBASE_REFERENCE_REFRESH_TIMEOUT' },
            );
          })
        : snapshotLoad;
      state.inFlight = boundedSnapshotLoad.then((value) => {
        state.value = value?.backgroundRefresh === true
          ? retainVerifiedReferenceWhileRefreshing(state.value, value, currentMs(), expectedHistoricalDate) || value
          : value;
        state.completedAt = currentMs();
        return state.value;
      }).finally(() => {
        state.inFlight = null;
      });
    }
    const fit = directionalFeed ? 'proxy' : 'exact';
    const label = String(marketId || 'market').toUpperCase();
    const pendingVariant = (range) => ({
      ...unavailableChartVariant(range, `${label} ${range.toUpperCase()} chart is refreshing.`, { fit }),
      status: 'refreshing',
      refreshing: true,
    });
    const oneDay = pendingVariant('1d');
    const pending = {
      spot: {
        ...unavailable(`${label} resolver reference is refreshing.`, {
          value: null, label, availability: 'unavailable', fit, executable: false,
        }),
        status: 'refreshing',
        refreshing: true,
      },
      chart: {
        ...oneDay,
        variants: {
          '1d': { ...oneDay },
          '5d': pendingVariant('5d'),
          '10d': pendingVariant('10d'),
        },
      },
      resolver: null,
      fit,
      backgroundRefresh: true,
    };
    // Refresh verified data in the background without making a fresh chart
    // disappear. Every retained section still has to pass its own provider,
    // provenance, and expiry checks above.
    const retained = retainVerifiedReferenceWhileRefreshing(
      state.value,
      pending,
      currentMs(),
      expectedHistoricalDate,
    );
    if (retained) {
      const probe = await settleWithin(state.inFlight, FRESH_REFERENCE_PROBE_MS);
      if (probe.status === 'fulfilled') return probe.value;
      if (probe.status === 'rejected') throw probe.reason;
      return retained;
    }
    const initialWaitMs = ['wti', 'brent'].includes(marketId) ? 2_950 : LIVE_CONTEXT_WAIT_MS;
    const result = await settleWithin(state.inFlight, initialWaitMs);
    if (result.status === 'fulfilled') return result.value;
    if (result.status === 'rejected') throw result.reason;
    return pending;
  }

  return {
    getSnapshot,
    getHealth: () => ({
      providerStatus: providerStatusState.value ? {
        connected: providerStatusState.value.connected === true,
        status: providerStatusState.value.status || (providerStatusState.value.connected === true ? 'connected' : 'disconnected'),
        message: providerStatusState.value.message || providerStatusState.value.error || null,
        asOf: providerStatusState.value.asOf || providerStatusState.value.timestamp || null,
        expiresAt: providerStatusState.expiresAt ? new Date(providerStatusState.expiresAt).toISOString() : null,
      } : {
        connected: false,
        status: 'not_started',
        message: 'The shared IBKR provider status has not been observed yet.',
        asOf: null,
        expiresAt: null,
      },
      historicalQueue: historicalQueue.getHealth(),
      checkpoint: checkpointStore?.getHealth?.() || { status: 'disabled' },
      directionalSelections: Object.fromEntries([...directionalStates.entries()].map(([marketId, state]) => [marketId, {
        status: state.value?.instrument ? 'available' : state.inFlight ? 'refreshing' : 'unavailable',
        conId: state.value?.instrument?.conId || null,
        localSymbol: state.value?.instrument?.localSymbol || state.value?.instrument?.displaySymbol || null,
        lastTradeDate: state.value?.instrument?.lastTradeDateOrContractMonth || null,
        rollReason: state.value?.rollReason || null,
        refreshPending: Boolean(state.inFlight),
      }])),
    }),
  };
}

module.exports = {
  LIVE_BAR_MAX_AGE_MS,
  LIVE_QUOTE_MAX_AGE_MS,
  NDX_INSTRUMENT,
  GOLD_SPOT_PROXY_INSTRUMENT,
  PYTH_HISTORY_URL,
  PYTH_LAZER_URL,
  createMarketReferenceProvider,
  createFetchHttpClient,
  brentIbkrInstrument,
  dynamicBzInstrument,
  dynamicGcInstrument,
  dynamicSiInstrument,
  DIRECTIONAL_FEEDS,
  isLiveDataType,
  loadCoinbaseHistoricalRecord,
  loadPythReference,
  normalizeIbkrChart,
  normalizeLiveQuote,
  goldSpotProxyConfig,
  goldReferenceItem,
  goldResolverContractMatches,
  pythReferenceConfig,
  pythSettlementMetadata,
  referenceVenueId,
  retainVerifiedChartWhileRefreshing,
  forecastCommodityReferenceConfig,
};
