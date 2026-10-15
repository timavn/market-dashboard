import {
  canonicalPredictionMonitorContext,
  predictionMonitorIdentityKey,
} from './predictionMonitorIdentity';
import { reconcilePredictionMonitorSnapshot } from './predictionMonitorSnapshotReconciler';
import exchangeVolume from './exchangeVolume.cjs';
import { reconcileVolatilitySnapshot } from './volatilitySnapshotRows';
import { reconcileMarketQuotePayload } from './marketQuoteFreshness';

const { isVerifiedExchangeVolumeResponse } = exchangeVolume;

export const DASHBOARD_RESOURCE_CLASSIFICATIONS = Object.freeze({
  DATED_REFERENCE: 'dated-reference',
  INFORMATIONAL_LIVE: 'informational-live',
  EXECUTABLE_LIVE: 'executable-live',
  MIXED: 'mixed',
});

const CLASSIFICATIONS = new Set(Object.values(DASHBOARD_RESOURCE_CLASSIFICATIONS));

const identity = (value) => value;
const requireObject = (value) => (
  value && typeof value === 'object' ? value : null
);

const requireRows = (value) => (
  requireObject(value) && Array.isArray(value.rows) ? value : null
);

const requireLots = (value) => (
  requireObject(value) && Array.isArray(value.lots) ? value : null
);

const requireEvents = (value) => (
  requireObject(value) && Array.isArray(value.events) ? value : null
);

const resolveValue = (value, context) => (
  typeof value === 'function' ? value(context) : value
);

const safeString = (value, fallback = '') => {
  const normalized = String(value ?? '').trim();
  return normalized || fallback;
};

const requirePredictionMonitor = (value, context = {}) => (
  requireObject(value)
  && value.schemaVersion === 2
  && value.marketId === safeString(context.marketId, 'sp500')
  && value.venues
  && value.contracts
  && Array.isArray(value.contracts.lines)
    ? value
    : null
);

const pick = (source, keys) => Object.fromEntries(
  keys
    .filter((key) => source && Object.prototype.hasOwnProperty.call(source, key))
    .map((key) => [key, source[key]]),
);

const safeContractEvent = (event) => {
  if (!event || typeof event !== 'object') return null;
  return pick(event, [
    'ticker',
    'eventTicker',
    'generationId',
    'seriesTicker',
    'title',
    'subtitle',
    'status',
    'openTime',
    'closeTime',
    'observationTime',
    'settlementTime',
    'strikeDate',
    'resolverSymbol',
    'settlementSource',
    'rulesUrl',
    'productCode', 'measuredQuarter', 'settlementStage', 'resolutionAt', 'expirationTime',
    'payoutAt', 'timezone', 'metric', 'unit', 'comparator',
  ]);
};

const safeContractGeometryLine = (line) => {
  if (!line || typeof line !== 'object') return null;
  return {
    ...pick(line, [
      'ticker',
      'symbol',
      'title',
      'subtitle',
      'label',
      'yesLabel',
      'noLabel',
      'threshold',
      'strike',
      'floor',
      'cap',
      'lowerBound',
      'upperBound',
      'rangeMin',
      'rangeMax',
      'interval',
      'payout',
      'result',
      'settlementValue',
      'settledAt',
      'settlementPayout',
      'volume',
      'volume24h',
      'volumeTotal',
      'openInterest',
    ]),
    yesBid: null,
    yesAsk: null,
    noBid: null,
    noAsk: null,
    bid: null,
    ask: null,
    mid: null,
    price: null,
    probability: null,
    yesDepth: null,
    noDepth: null,
    directNative: false,
    executable: false,
    quoteStatus: 'unavailable',
  };
};

const safeContractGeometry = (contracts) => {
  if (!contracts || typeof contracts !== 'object') {
    return {
      status: 'unavailable',
      event: null,
      lines: [],
      scheduleOnly: true,
      referenceOnly: true,
      reason: 'Live contract data must be refreshed.',
    };
  }
  return {
    ...pick(contracts, [
      'source',
      'asOf',
      'expiresAt',
      'selectedGenerationId',
      'generationKey',
      'settlementMapping',
      'historicalOnly',
    ]),
    status: 'unavailable',
    event: safeContractEvent(contracts.event),
    ...(contracts.event?.productCode === 'RGDP' ? {
      thresholds: (contracts.thresholds || []).map((line) => pick(line, [
        'contractId', 'threshold', 'comparator', 'measuredQuarter', 'unit',
        'volume', 'volume24h', 'openInterest', 'activityAsOf', 'activitySourceUrl',
      ])),
    } : {}),
    lines: (Array.isArray(contracts.lines) ? contracts.lines : [])
      .map(safeContractGeometryLine)
      .filter(Boolean),
    scheduleOnly: true,
    referenceOnly: true,
    reason: 'Last verified contract geometry only; live books must be refreshed.',
  };
};

const safeGenerationReference = (generation) => {
  if (!generation || typeof generation !== 'object') return null;
  return {
    ...pick(generation, [
      'id',
      'generationId',
      'generationKey',
      'venueId',
      'venueLabel',
      'seriesTicker',
      'eventTicker',
      'cadence',
      'title',
      'subtitle',
      'openTime',
      'closeTime',
      'observationTime',
      'settlementTime',
      'settlementSource',
      'resolverSymbol',
      'openInterest',
      'volume24h',
      'volumeTotal',
    ]),
    bookStatus: 'unavailable',
    executionAvailable: false,
    lines: undefined,
  };
};

const referenceSpot = (spot) => {
  if (!spot || typeof spot !== 'object') return null;
  const retainedAvailability = ['live', 'current'].includes(String(spot.availability || '').toLowerCase())
    ? String(spot.availability).toLowerCase()
    : 'current';
  return {
    ...pick(spot, [
      'value',
      'previousClose',
      'label',
      'symbol',
      'displaySymbol',
      'fit',
      'source',
      'asOf',
      'timestamp',
      'lastVerifiedAt',
      'generationKey',
      'resolverSymbol',
      'reason',
    ]),
    status: 'delayed',
    availability: 'delayed',
    retainedAvailability,
    displayDelayed: true,
    displayOnly: true,
    clientVerified: true,
    stale: false,
    executable: false,
    directNative: false,
    quoteMode: 'last-verified-reference',
  };
};

const safeResolverReference = (reference) => {
  if (!reference || typeof reference !== 'object') return null;
  const chart = reference.chart && typeof reference.chart === 'object'
    ? {
        ...pick(reference.chart, [
          'fit',
          'points',
          'references',
          'dailyRanges',
          'source',
          'asOf',
          'latestAt',
          'latestValue',
          'historicalThroughDate',
        ]),
        status: 'historical',
        availability: 'historical',
        executable: false,
      }
    : null;
  return {
    ...pick(reference, [
      'resolver',
      'settlementBasis',
      'generationId',
      'generationKey',
      'proxyFit',
    ]),
    status: 'reference',
    referenceOnly: true,
    instrument: reference.instrument && typeof reference.instrument === 'object'
      ? pick(reference.instrument, [
          'symbol',
          'localSymbol',
          'displaySymbol',
          'lastTradeDateOrContractMonth',
          'exchange',
          'currency',
        ])
      : null,
    spot: referenceSpot(reference.spot),
    lastVerifiedSpot: referenceSpot(reference.lastVerifiedSpot || reference.spot),
    chart,
    executable: false,
  };
};

const referenceVolatilityContext = (value) => {
  if (!value || typeof value !== 'object') return null;
  return {
    ...pick(value, [
      'value',
      'asOf',
      'date',
      'source',
      'quoteMode',
      'lastVerifiedAt',
    ]),
    status: 'reference',
    availability: 'reference',
    refreshDelayed: true,
    executable: false,
  };
};

const safeCpiForecastComparison = (comparison, nowMs = Date.now()) => {
  if (!comparison || typeof comparison !== 'object') return null;
  const releaseAtMs = Date.parse(comparison.releaseAt || '');
  if (!comparison.releaseKey
    || !/^20\d{2}-(0[1-9]|1[0-2])$/.test(String(comparison.reportMonth || ''))
    || !Number.isFinite(releaseAtMs)
    || releaseAtMs <= nowMs) return null;
  const safeSource = (source, extras = {}) => source && typeof source === 'object' ? {
    ...pick(source, [
      'status', 'value', 'reportMonth', 'source', 'sourceUrl', 'asOf', 'expiresAt',
      'datasetAsOf', 'fetchedAt', 'remoteStatus', 'refreshPending', 'reason',
    ]),
    executable: false,
    ...extras,
  } : null;
  const hedgeye = safeSource(comparison.hedgeye, {
    scenarios: (Array.isArray(comparison.hedgeye?.scenarios) ? comparison.hedgeye.scenarios : [])
      .slice(0, 3)
      .map((scenario) => pick(scenario, ['key', 'label', 'value'])),
    baseValue: comparison.hedgeye?.baseValue ?? null,
  });
  const clevelandFed = safeSource(comparison.clevelandFed, {
    points: (Array.isArray(comparison.clevelandFed?.points) ? comparison.clevelandFed.points : [])
      .slice(-120)
      .map((point) => pick(point, ['timestamp', 'value'])),
  });
  const bls = safeSource(comparison.bls, {
    latestFinal: comparison.bls?.latestFinal
      ? pick(comparison.bls.latestFinal, ['reportMonth', 'value', 'source', 'seriesId', 'sourceUrl'])
      : null,
  });
  return {
    ...pick(comparison, [
      'status', 'releaseKey', 'reportMonth', 'forecastMonth', 'releaseAt',
      'eventTicker', 'metric', 'unit', 'reason',
    ]),
    hedgeye,
    clevelandFed,
    bls,
    referenceOnly: true,
    executable: false,
  };
};

const safeCpiLadderReference = (reference, comparison) => {
  if (!reference || !comparison || reference.reportMonth !== comparison.reportMonth) return null;
  return {
    ...pick(reference, [
      'status', 'kind', 'label', 'value', 'reportMonth', 'source', 'asOf',
      'expiresAt', 'availability',
    ]),
    referenceOnly: true,
    executable: false,
  };
};

const unsafePredictionReferenceSection = (section) => {
  const source = String(section?.source || '').trim();
  return !section
    || section.fromCache === true
    || section.cachedOnly === true
    || section.cacheOnly === true
    || section.mock === true
    || section.seeded === true
    || section.synthetic === true
    || section.inferred === true
    || /(?:mock|seed|fixture|fallback|cache|portfolio|stale|offline|disconnected|synthetic|inferred|derived)/i.test(source);
};

const historicalChartPoint = (point) => {
  const timestamp = Number(point?.timestamp);
  const value = Number(point?.value);
  if (!Number.isFinite(timestamp) || !Number.isFinite(value)) return null;
  return {
    timestamp,
    value,
    ...(point?.sessionDate ? { sessionDate: point.sessionDate } : {}),
    ...(Number.isFinite(Number(point?.high)) ? { high: Number(point.high) } : {}),
  };
};

const safeHistoricalChart = (section) => {
  if (!section || unsafePredictionReferenceSection(section)) return null;
  const points = (Array.isArray(section.points) ? section.points : [])
    .map(historicalChartPoint)
    .filter(Boolean);
  if (points.length < 2) return null;
  const latestAtMs = Date.parse(section.latestAt || section.asOf || '')
    || Number(points[points.length - 1]?.timestamp);
  if (!Number.isFinite(latestAtMs)) return null;
  const latestAt = new Date(latestAtMs).toISOString();
  const historicalThroughDate = latestAt.slice(0, 10);
  const variants = section.variants && typeof section.variants === 'object'
    ? Object.fromEntries(Object.entries(section.variants)
        .map(([range, variant]) => [range, safeHistoricalChart(variant)])
        .filter(([, variant]) => variant))
    : undefined;
  return {
    ...pick(section, [
      'fit',
      'label',
      'symbol',
      'displaySymbol',
      'range',
      'interval',
      'references',
      'dailyRanges',
      'rangeDates',
      'source',
      'latestValue',
      'previousClose',
      'sessionMode',
      'sessionDate',
      'sessionWindow',
      'ath',
      'vixCloses',
      'riskRangeStatus',
      'riskRangeMissingDates',
    ]),
    status: 'historical',
    availability: 'historical',
    points,
    latestAt,
    asOf: latestAt,
    historicalThroughDate,
    refreshing: false,
    refreshPending: false,
    refreshRetained: false,
    refreshFailed: false,
    executable: false,
    ...(variants && Object.keys(variants).length ? { variants } : {}),
  };
};

/**
 * Positive-list projection for a prediction monitor. It deliberately removes
 * books, bids/asks, depths, positions, sizing, order state, and strategy
 * eligibility while retaining dated research, charts, completed history, and
 * contract geometry.
 */
export const projectPredictionMonitorReference = (snapshot) => {
  if (!snapshot || typeof snapshot !== 'object') return null;
  // Bitcoin now uses a direct perpetual feed. Reapply this on hydration so
  // older Coinbase references cannot restore prices before a fresh response.
  const directBitcoin = snapshot.marketId === 'bitcoin';
  const venues = Object.fromEntries(
    Object.entries(snapshot.venues || {}).map(([venueId, venue]) => [venueId, {
      ...pick(venue, [
        'id',
        'label',
        'resolver',
        'settlementBasis',
        'generationId',
        'generationKey',
        'activity',
      ]),
      reference: directBitcoin ? null : safeResolverReference(venue?.reference),
      status: 'reference',
      brokerRoutable: false,
      executionAvailable: false,
      strategyEligible: false,
      catalog: safeContractGeometry(venue?.catalog),
      contracts: safeContractGeometry(venue?.contracts),
      book: {
        status: 'unavailable',
        event: safeContractEvent(venue?.book?.event || venue?.catalog?.event),
        lines: [],
        reason: 'Live venue book must be refreshed.',
      },
    }]),
  );
  const contracts = safeContractGeometry(snapshot.contracts || snapshot.displayContracts);
  const forecastComparison = snapshot.marketId === 'cpi'
    ? safeCpiForecastComparison(snapshot.forecastComparison)
    : null;
  const ladderReference = snapshot.marketId === 'cpi'
    ? safeCpiLadderReference(snapshot.ladderReference, forecastComparison)
    : null;
  return {
    ...pick(snapshot, [
      'schemaVersion',
      'marketId',
      'displayName',
      'symbol',
      'generatedAt',
      'session',
      'riskRange',
      'factors',
      'factorRows',
      'scoreInputs',
      'sourceHealth',
      'productActivity',
      'selectedGenerationId',
      'selectedVenueId',
      'proxyFit',
      'cardView',
    ]),
    status: 'reference',
    referenceOnly: true,
    chart: directBitcoin ? null : safeHistoricalChart(snapshot.chart),
    spot: directBitcoin ? null : referenceSpot(snapshot.spot),
    cashSpot: directBitcoin ? null : referenceSpot(snapshot.cashSpot),
    spySpot: directBitcoin ? null : referenceSpot(snapshot.spySpot),
    resolverReference: directBitcoin ? null : safeResolverReference(snapshot.resolverReference),
    ...(directBitcoin ? {
      chartReferences: null,
      proxyFit: null,
      cardView: null,
      perpetualReference: {
        referenceKind: 'perpetual_contract', referenceOnly: true,
        spot: null, chart: null, proxyFit: null,
      },
      sourceHealth: (Array.isArray(snapshot.sourceHealth) ? snapshot.sourceHealth : [])
        .filter((row) => row?.id === 'risk_range'),
    } : {}),
    ...(snapshot.marketId === 'cpi' ? { forecastComparison, ladderReference } : {}),
    ...(snapshot.marketId === 'gdp' ? { gdp: snapshot.gdp || null } : {}),
    contracts,
    displayContracts: contracts,
    venues,
    generationOptions: (Array.isArray(snapshot.generationOptions)
      ? snapshot.generationOptions
      : [])
      .map(safeGenerationReference)
      .filter(Boolean),
    selectedGeneration: safeGenerationReference(snapshot.selectedGeneration),
    autoSelection: {
      status: 'unavailable',
      mode: 'reference',
      venueId: snapshot.autoSelection?.venueId || snapshot.selectedVenueId || null,
      label: 'Last verified contract geometry',
      reason: 'Live execution state must be refreshed.',
      contracts,
    },
    displaySelection: {
      status: 'unavailable',
      mode: 'reference',
      venueId: snapshot.displaySelection?.venueId || snapshot.selectedVenueId || null,
      label: 'Last verified contract geometry',
      reason: 'Live execution state must be refreshed.',
      contracts,
    },
    strategy: {
      status: 'unavailable',
      model: null,
      eligibleVenueId: null,
      reason: 'Sizing and execution require a fresh verified live snapshot.',
    },
    executionAvailable: false,
    positions: undefined,
    orders: undefined,
    sizing: undefined,
    refresh: { state: 'reference', revision: snapshot.refresh?.revision || 0 },
    errors: [],
  };
};

export const validatePredictionMonitorReference = (value) => {
  const projected = projectPredictionMonitorReference(value);
  if (
    !projected
    || projected.referenceOnly !== true
    || !projected.marketId
    || !projected.generatedAt
  ) return null;
  return projected;
};

export const projectWtiReference = (value) => {
  if (!value || typeof value !== 'object') return null;
  return {
    ...pick(value, [
      'cadence',
      'seriesTicker',
      'historicalOnly',
      'settlementMapping',
      'riskRange',
      'riskRangeMessage',
      'ovxMessage',
      'modeMessage',
      'marketType',
      'settlementValue',
      'history',
      'sessions',
      'generatedAt',
      'asOf',
    ]),
    event: safeContractEvent(value.event),
    ovxReference: referenceVolatilityContext(value.ovxReference),
    referenceOnly: true,
    markets: (Array.isArray(value.markets) ? value.markets : [])
      .map(safeContractGeometryLine)
      .filter(Boolean),
    executionAvailable: false,
  };
};

const validateWtiReference = (value) => {
  const projected = projectWtiReference(value);
  if (
    !projected
    || projected.referenceOnly !== true
    || !projected.cadence
    || !projected.event?.ticker
    || !Array.isArray(projected.markets)
  ) return null;
  return projected;
};

export const projectExposureLabReference = (value) => {
  if (!value || typeof value !== 'object') return null;
  return {
    ...pick(value, [
      'asOf',
      'generatedAt',
      'snapshotDate',
      'methodology',
      'factors',
      'factorDefinitions',
      'archive',
      'history',
      'universe',
      'referenceRows',
    ]),
    referenceOnly: true,
    positions: undefined,
    balances: undefined,
    account: undefined,
    sizing: undefined,
  };
};

const storage = (eligible, key, ttlMs, projectionVersion = 1) => Object.freeze({
  eligible,
  key,
  ttlMs,
  projectionVersion,
});

const polling = (intervalMs = null, { whileHidden = false, whileDocumentHidden = false } = {}) => (
  Object.freeze({ intervalMs, whileHidden, whileDocumentHidden })
);

const definition = (id, options) => Object.freeze({
  id,
  validate: requireObject,
  freshnessSource: (data) => data?.observedAt || data?.generatedAt || data?.asOf || null,
  polling: polling(),
  storage: storage(false, null, null),
  warmup: Object.freeze({ eligible: false, providerPure: false }),
  maxAgeMs: null,
  futureToleranceMs: null,
  referenceProjection: null,
  validateReference: null,
  reconcileIncoming: null,
  accountScoped: false,
  retainOnRefreshFailure: options.classification !== DASHBOARD_RESOURCE_CLASSIFICATIONS.EXECUTABLE_LIVE,
  retainAfterExpiry: options.classification === DASHBOARD_RESOURCE_CLASSIFICATIONS.INFORMATIONAL_LIVE,
  ...options,
});

const DAY_MS = 24 * 60 * 60 * 1000;

export const DASHBOARD_RESOURCE_DEFINITIONS = Object.freeze({
  portfolio: definition('portfolio', {
    classification: DASHBOARD_RESOURCE_CLASSIFICATIONS.EXECUTABLE_LIVE,
    cacheKey: 'portfolio',
    scopeKey: ({ accountId }) => safeString(accountId, 'account-required'),
    accountScoped: true,
    maxAgeMs: 5 * 60_000,
    polling: polling(50_000, { whileHidden: true }),
  }),
  'market-quotes': definition('market-quotes', {
    classification: DASHBOARD_RESOURCE_CLASSIFICATIONS.INFORMATIONAL_LIVE,
    cacheKey: 'multi-region-market-quotes',
    scopeKey: 'current',
    polling: polling(30_000, { whileHidden: true }),
    // Dated readings last for this browser tab; their observation dates never advance on reload.
    storage: storage(true, 'market-dashboard.reference.multi-region-quotes.v1', Number.MAX_SAFE_INTEGER),
    warmup: Object.freeze({ eligible: false, providerPure: false }),
    retainOnRefreshFailure: true,
    retainAfterExpiry: true,
    reconcileIncoming: reconcileMarketQuotePayload,
  }),
  'market-period-returns': definition('market-period-returns', {
    classification: DASHBOARD_RESOURCE_CLASSIFICATIONS.DATED_REFERENCE,
    cacheKey: 'multi-region-market-quotes',
    scopeKey: 'period-returns',
    polling: polling(15 * 60_000, { whileHidden: true }),
    storage: storage(true, 'market-dashboard.reference.multi-region-period-returns.v1', Number.MAX_SAFE_INTEGER),
    retainAfterExpiry: true,
    reconcileIncoming: reconcileMarketQuotePayload,
  }),
  volatility: definition('volatility', {
    // An informational record of provider observations, each with its own date.
    classification: DASHBOARD_RESOURCE_CLASSIFICATIONS.DATED_REFERENCE,
    cacheKey: 'volatility-snapshot',
    scopeKey: ({ backendUrl }) => safeString(backendUrl, 'dashboard'),
    polling: polling(60_000),
    storage: storage(true, 'market-dashboard.reference.volatility.v1', Number.MAX_SAFE_INTEGER),
    retainOnRefreshFailure: true,
    retainAfterExpiry: true,
    reconcileIncoming: reconcileVolatilitySnapshot,
  }),
  'usd-correlations': definition('usd-correlations', {
    classification: DASHBOARD_RESOURCE_CLASSIFICATIONS.DATED_REFERENCE,
    cacheKey: 'usd-correlations',
    scopeKey: 'dashboard',
    storage: storage(true, 'market-dashboard.reference.usd-correlations.v1', 30 * DAY_MS),
  }),
  'market-events': definition('market-events', {
    classification: DASHBOARD_RESOURCE_CLASSIFICATIONS.INFORMATIONAL_LIVE,
    cacheKey: 'market-events',
    scopeKey: ({ week }) => (week === 'next' ? 'forex-factory-next-week' : 'forex-factory-current-week'),
    polling: polling(5 * 60_000),
    storage: storage(true, ({ week }) => (week === 'next'
      ? 'market-dashboard.reference.market-events.next-week.v1'
      : 'market-dashboard.reference.market-events.v1'), 8 * DAY_MS),
  }),
  cftc: definition('cftc', {
    classification: DASHBOARD_RESOURCE_CLASSIFICATIONS.DATED_REFERENCE,
    cacheKey: 'dashboard-reference',
    scopeKey: 'cftc-positioning',
    storage: storage(true, 'market-dashboard.reference.cftc-positioning.v1', 30 * DAY_MS),
    warmup: Object.freeze({ eligible: true, providerPure: true }),
  }),
  'global-quads': definition('global-quads', {
    classification: DASHBOARD_RESOURCE_CLASSIFICATIONS.DATED_REFERENCE,
    cacheKey: 'dashboard-reference',
    scopeKey: 'global-quads',
    storage: storage(true, 'market-dashboard.reference.global-quads.v1', 365 * DAY_MS),
  }),
  'market-situation': definition('market-situation', {
    classification: DASHBOARD_RESOURCE_CLASSIFICATIONS.DATED_REFERENCE,
    cacheKey: 'market-structure-report',
    scopeKey: ({ requestedDate }) => safeString(requestedDate, 'latest'),
    storage: storage(true, 'market-dashboard.reference.market-situation.v2', 30 * DAY_MS),
    warmup: Object.freeze({ eligible: true, providerPure: true }),
  }),
  'dollar-liquidity': definition('dollar-liquidity', {
    classification: DASHBOARD_RESOURCE_CLASSIFICATIONS.DATED_REFERENCE,
    cacheKey: 'dashboard-reference',
    scopeKey: 'dollar-liquidity',
    storage: storage(true, 'market-dashboard.reference.dollar-liquidity.v1', 30 * DAY_MS),
    warmup: Object.freeze({ eligible: true, providerPure: true }),
  }),
  'market-volume': definition('market-volume', {
    classification: DASHBOARD_RESOURCE_CLASSIFICATIONS.DATED_REFERENCE,
    cacheKey: 'market-share-volume-v2',
    scopeKey: '365-days',
    validate: value => isVerifiedExchangeVolumeResponse(value) ? value : null,
    retainOnRefreshFailure: false,
    retainAfterExpiry: false,
    storage: storage(false),
    warmup: Object.freeze({ eligible: true, providerPure: true }),
  }),
  'performance-history': definition('performance-history', {
    classification: DASHBOARD_RESOURCE_CLASSIFICATIONS.DATED_REFERENCE,
    cacheKey: 'performance-realized-history',
    scopeKey: ({ period }) => safeString(period, 'ytd'),
    validate: requireLots,
    freshnessSource: (data) => data?.generatedAt || data?.asOf || data?.endDate || null,
    // Realized account history is retained only in memory for this tab.
    storage: storage(false, null, null),
    warmup: Object.freeze({ eligible: false, providerPure: false }),
  }),
  workflow: definition('workflow', {
    classification: DASHBOARD_RESOURCE_CLASSIFICATIONS.DATED_REFERENCE,
    cacheKey: 'workflow-status',
    scopeKey: 'latest',
    validate: requireEvents,
    freshnessSource: (data) => data?.resourceObservedAt
      || data?.generatedAt
      || data?.asOf
      || data?.date,
    polling: polling(5 * 60_000),
    storage: storage(true, 'market-dashboard.reference.workflow.v1', 7 * DAY_MS),
    warmup: Object.freeze({ eligible: true, providerPure: true }),
  }),
  'signal-strength-research': definition('signal-strength-research', {
    classification: DASHBOARD_RESOURCE_CLASSIFICATIONS.DATED_REFERENCE,
    cacheKey: 'signal-strength-research',
    scopeKey: 'current-universe',
    storage: storage(true, 'market-dashboard.reference.signal-strength.v1', 30 * DAY_MS),
    warmup: Object.freeze({ eligible: true, providerPure: true }),
  }),
  'signal-strength-quotes': definition('signal-strength-quotes', {
    classification: DASHBOARD_RESOURCE_CLASSIFICATIONS.EXECUTABLE_LIVE,
    cacheKey: 'signal-strength-quotes',
    scopeKey: ({ symbols }) => safeString(symbols, 'none'),
    polling: polling(30_000),
    storage: storage(false, null, null),
  }),
  'momo-tracker': definition('momo-tracker', {
    classification: DASHBOARD_RESOURCE_CLASSIFICATIONS.DATED_REFERENCE,
    cacheKey: 'momo-tracker',
    scopeKey: 'current-publication',
    polling: polling(15 * 60_000),
    storage: storage(true, 'market-dashboard.reference.momo-tracker.v1', 7 * DAY_MS),
    warmup: Object.freeze({ eligible: true, providerPure: true }),
    freshnessSource: (data) => data?.publicationDate || data?.date || data?.generatedAt,
  }),
  'gold-correlations': definition('gold-correlations', {
    classification: DASHBOARD_RESOURCE_CLASSIFICATIONS.DATED_REFERENCE,
    cacheKey: 'gold-correlations',
    scopeKey: 'current-completed-sessions',
    polling: polling(60 * 60_000),
    storage: storage(true, 'market-dashboard.reference.gold-correlations.v1', 7 * DAY_MS),
    warmup: Object.freeze({ eligible: false, providerPure: false }),
    freshnessSource: (data) => data?.basis?.asOf || data?.asOf || data?.generatedAt,
  }),
  securities: definition('securities', {
    classification: DASHBOARD_RESOURCE_CLASSIFICATIONS.MIXED,
    cacheKey: 'securities',
    scopeKey: 'current',
    storage: storage(false, null, null),
    warmup: Object.freeze({ eligible: false, providerPure: false }),
  }),
  'exposure-lab-snapshot': definition('exposure-lab-snapshot', {
    classification: DASHBOARD_RESOURCE_CLASSIFICATIONS.MIXED,
    cacheKey: 'exposure-lab-snapshot',
    scopeKey: ({ accountId, portfolioScope }) => (
      `${safeString(accountId, 'account-required')}|${safeString(portfolioScope, 'unverified')}`
    ),
    accountScoped: true,
    retainOnRefreshFailure: false,
    retainAfterExpiry: false,
    storage: storage(false, null, null),
    warmup: Object.freeze({ eligible: false, providerPure: false }),
    referenceProjection: projectExposureLabReference,
    validateReference: projectExposureLabReference,
  }),
  'exposure-lab-universe': definition('exposure-lab-universe', {
    classification: DASHBOARD_RESOURCE_CLASSIFICATIONS.DATED_REFERENCE,
    cacheKey: 'exposure-lab-universe',
    scopeKey: 'security-master',
    validate: requireRows,
    freshnessSource: (data) => data?.resourceObservedAt
      || data?.asOf
      || data?.generatedAt
      || data?.meta?.generatedAt,
    storage: storage(true, 'market-dashboard.reference.exposure-lab-universe.v1', 30 * DAY_MS),
    warmup: Object.freeze({ eligible: true, providerPure: true }),
  }),
  'etf-pro': definition('etf-pro', {
    classification: DASHBOARD_RESOURCE_CLASSIFICATIONS.DATED_REFERENCE,
    cacheKey: 'etf-pro',
    scopeKey: 'latest',
    validate: (value) => (
      requireRows(value) && value.mock !== true && value.seeded !== true ? value : null
    ),
    freshnessSource: (data) => data?.meta?.snapshotDate || data?.generatedAt,
    storage: storage(true, 'market-dashboard.reference.etf-pro.v1', 30 * DAY_MS),
    warmup: Object.freeze({ eligible: true, providerPure: true }),
  }),
  'wti-workbench': definition('wti-workbench', {
    classification: DASHBOARD_RESOURCE_CLASSIFICATIONS.MIXED,
    cacheKey: 'wti-workbench',
    scopeKey: ({ cadence }) => safeString(cadence, 'daily'),
    storage: storage(true, ({ cadence }) => `market-dashboard.reference.wti.${safeString(cadence, 'daily')}.v1`, 7 * DAY_MS),
    warmup: Object.freeze({ eligible: false, providerPure: false }),
    referenceProjection: projectWtiReference,
    validateReference: validateWtiReference,
  }),
  'prediction-monitor': definition('prediction-monitor', {
    classification: DASHBOARD_RESOURCE_CLASSIFICATIONS.MIXED,
    cacheKey: 'prediction-market-monitor',
    scopeKey: (context) => predictionMonitorIdentityKey(context),
    storage: storage(
      true,
      (context) => {
        const canonical = canonicalPredictionMonitorContext(context);
        return `market-dashboard.reference.prediction-monitor.${canonical.marketId}.${canonical.venue}.${canonical.generationId || 'default'}.v1`;
      },
      7 * DAY_MS,
    ),
    polling: polling(5_000),
    validate: requirePredictionMonitor,
    freshnessSource: (data) => data?.generatedAt,
    maxAgeMs: 90_000,
    warmup: Object.freeze({ eligible: true, providerPure: true }),
    referenceProjection: projectPredictionMonitorReference,
    validateReference: validatePredictionMonitorReference,
    reconcileIncoming: reconcilePredictionMonitorSnapshot,
  }),
  'prediction-nav': definition('prediction-nav', {
    // Alignment badges can influence trade selection, so they fail closed
    // even though they are rendered in navigation chrome.
    classification: DASHBOARD_RESOURCE_CLASSIFICATIONS.EXECUTABLE_LIVE,
    cacheKey: 'prediction-market-nav-indicators',
    scopeKey: 'four-market-morning',
    storage: storage(false, null, null),
    polling: polling(5 * 60_000, { whileHidden: true }),
    retainOnRefreshFailure: false,
    retainAfterExpiry: false,
  }),
  'system-readiness': definition('system-readiness', {
    classification: DASHBOARD_RESOURCE_CLASSIFICATIONS.INFORMATIONAL_LIVE,
    cacheKey: 'system-readiness',
    scopeKey: 'local-stack',
    storage: storage(false, null, null),
  }),
});

export const DASHBOARD_REFRESHABLE_NAVIGATION_SURFACES = Object.freeze({
  dashboard: Object.freeze(['market-quotes', 'market-period-returns', 'volatility', 'usd-correlations', 'market-events', 'cftc', 'market-situation', 'dollar-liquidity', 'market-volume']),
  balance: Object.freeze(['portfolio']),
  performance: Object.freeze(['performance-history']),
  portfolio: Object.freeze(['portfolio', 'securities']),
  exposureLab: Object.freeze(['portfolio', 'exposure-lab-snapshot', 'exposure-lab-universe']),
  predictionMonitor: Object.freeze(['prediction-monitor', 'momo-tracker', 'gold-correlations']),
  analytics: Object.freeze(['workflow']),
  ss: Object.freeze(['signal-strength-research', 'signal-strength-quotes']),
  etfPro: Object.freeze(['etf-pro']),
  system: Object.freeze(['system-readiness']),
});

export function getDashboardResourceDefinition(id) {
  const resource = DASHBOARD_RESOURCE_DEFINITIONS[id];
  if (!resource) throw new TypeError(`Unknown dashboard resource definition: ${id}`);
  return resource;
}

export function resolveDashboardResourceDefinition(id, context = {}, overrides = {}) {
  const resource = getDashboardResourceDefinition(id);
  const classification = resource.classification;
  if (!CLASSIFICATIONS.has(classification)) {
    throw new TypeError(`Dashboard resource ${id} has an invalid classification.`);
  }
  const storagePolicy = resource.storage || {};
  const storageKey = storagePolicy.eligible ? resolveValue(storagePolicy.key, context) : null;
  const baseValidate = resource.validate || identity;
  const overrideValidate = overrides.validate;
  const validate = (raw) => {
    const baseValue = baseValidate(raw, context);
    if (baseValue == null) return null;
    return typeof overrideValidate === 'function'
      ? overrideValidate(baseValue, context)
      : baseValue;
  };
  const freshnessSource = overrides.getObservedAt
    || resource.freshnessSource
    || (() => null);
  const isReference = classification === DASHBOARD_RESOURCE_CLASSIFICATIONS.DATED_REFERENCE;
  const isExecutable = classification === DASHBOARD_RESOURCE_CLASSIFICATIONS.EXECUTABLE_LIVE;
  const isMixed = classification === DASHBOARD_RESOURCE_CLASSIFICATIONS.MIXED;
  const persistence = storagePolicy.eligible && storageKey
    ? {
        key: storageKey,
        ttlMs: storagePolicy.ttlMs,
        projectionVersion: storagePolicy.projectionVersion || 1,
      }
    : null;
  return {
    ...overrides,
    definitionId: id,
    classification,
    resourceClass: classification,
    resourceKey: safeString(resolveValue(resource.cacheKey, context), id),
    scopeKey: safeString(resolveValue(resource.scopeKey, context), 'dashboard'),
    kind: isReference ? 'reference' : 'live',
    displayRole: isExecutable ? 'executable' : isMixed ? 'mixed' : 'informational',
    validate,
    getObservedAt: freshnessSource,
    maxAgeMs: overrides.maxAgeMs ?? resource.maxAgeMs ?? undefined,
    futureToleranceMs: overrides.futureToleranceMs ?? resource.futureToleranceMs ?? undefined,
    pollIntervalMs: overrides.pollIntervalMs ?? resource.polling?.intervalMs ?? null,
    pollWhenHidden: overrides.pollWhenHidden ?? resource.polling?.whileHidden ?? false,
    pollWhenDocumentHidden: overrides.pollWhenDocumentHidden
      ?? resource.polling?.whileDocumentHidden
      ?? false,
    retainOnRefreshFailure: overrides.retainOnRefreshFailure
      ?? resource.retainOnRefreshFailure,
    retainAfterExpiry: overrides.retainAfterExpiry ?? resource.retainAfterExpiry,
    persistReferenceSnapshot: overrides.persistReferenceSnapshot === undefined
      ? persistence
      : overrides.persistReferenceSnapshot,
    referenceProjection: overrides.referenceProjection || resource.referenceProjection,
    validateReference: overrides.validateReference || resource.validateReference,
    reconcileIncoming: overrides.reconcileIncoming || resource.reconcileIncoming,
    accountScoped: overrides.accountScoped ?? resource.accountScoped,
  };
}

export function assertDashboardResourceRegistryComplete() {
  const missing = [];
  Object.entries(DASHBOARD_REFRESHABLE_NAVIGATION_SURFACES).forEach(([surface, ids]) => {
    if (!Array.isArray(ids) || ids.length === 0) missing.push(surface);
    ids.forEach((id) => {
      if (!DASHBOARD_RESOURCE_DEFINITIONS[id]) missing.push(`${surface}:${id}`);
    });
  });
  return missing;
}
