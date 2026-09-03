const crypto = require('crypto');
const { formatInTimeZone } = require('date-fns-tz');
const { validateFesGeneration } = require('../forecastExFesIdentity.cjs');
const { validateForecastCommodityGeneration } = require('../forecastExCommodityIdentity.cjs');
const { validateFnqGeneration } = require('../forecastExFnqIdentity.cjs');
const { buildWtiSettlementMapping } = require('../predictionMarketsIngest/watchlistProvider');
const {
  FORECAST_COMMODITY_PRODUCTS,
  PYTH_AUTHORITATIVE_HOSTS,
  PYTH_RESOLVER_IDENTITIES,
  pythExplorerSymbol,
} = require('./resolverIdentities.cjs');
const { evaluateRiskRangeBasis } = require('./directionalFeedRegistry.cjs');
const { normalizeDxyContext } = require('./usdContext.cjs');

const { kalshiFetch: defaultKalshiFetch } = require('../predictionMarketsIngest/providers/kalshiClient');
const {
  getCurrentCpiRelease,
  normalizeCpiMonthId,
} = require('../predictionMarketsIngest/cpiRelease');
const { loadClevelandFedCpiNowcast } = require('../predictionMarketsIngest/signalAvailabilityProvider');
const { loadOfficialCpiFinals } = require('../predictionMarketsIngest/cpiOfficial');

const CONTRACT_MAX_AGE_MS = 90_000;
const FES_CORE_LINES_PER_SIDE = 5;
const FES_LIQUID_EXTRA_THRESHOLD = 500;
const FES_LIQUID_EXTRAS_PER_SIDE = 2;
const FES_COLD_START_MAX_LINES = 10;
// Catalog, native-book, reference and research requests are independently
// represented in the response. The outer budget is deliberately long enough
// for a normal authenticated IBKR round trip; individual providers still own
// their tighter request timeouts and fail closed.
const INITIAL_REFRESH_BUDGET_MS = 12_000;
const SPX_REFRESH_BUDGET_MS = 6_000;
const RESEARCH_MAX_AGE_MS = 30 * 60_000;
const VOLATILITY_CONTEXT_MAX_AGE_MS = 5 * 24 * 60 * 60_000;
const USD_CORRELATION_MAX_AGE_MS = 36 * 60 * 60_000;
const CFTC_MAX_AGE_MS = 10 * 24 * 60 * 60_000;
const CFTC_OFFICIAL_SOURCE = 'cftc-public-reporting-environment';
const CFTC_SCHEMA_VERSION = 'cftc-positioning-v2';
const CFTC_CALCULATION_VERSION = 'cftc-combined-net-sample-z-v1';
const FORBIDDEN_PROVENANCE = /delayed|frozen|stale|cache(?:d|_only|-only)?|mock|seed|fallback|offline|disconnected|historical|synthetic|inferred|derived/i;
const REFRESH_FAILURE = /refresh(?:[_ -]?(?:failed|failure|error|issue|timeout|timed out))|(?:failed|failure|error).*refresh/i;
const CLOSED_STATUSES = new Set(['closed', 'settled', 'finalized', 'paused']);
const CPI_SERIES_TICKER = 'KXCPIYOY';
const CPI_BLS_SOURCE_URL = 'https://www.bls.gov/cpi/';

const MARKET_CONFIGS = Object.freeze({
  cpi: Object.freeze({
    id: 'cpi',
    label: 'CPI',
    fullLabel: 'Headline CPI YoY',
    symbol: 'CPI',
    venueIds: Object.freeze(['kalshi']),
    seriesTicker: CPI_SERIES_TICKER,
    seriesTickers: Object.freeze([CPI_SERIES_TICKER]),
    standardCadence: 'monthly',
    eventSuffix: null,
    horizonDays: 75,
    forecastExProduct: null,
    precision: 1,
    unit: 'percent',
    riskRange: null,
    trade: null,
    volatility: Object.freeze([]),
    cftc: null,
    usdCorrelationKey: null,
    kalshiResolver: Object.freeze({
      underlying: 'bls_all_items_cpi_u_yoy',
      resolver: 'kalshi_kxcpiyoy_bls_initial_one_decimal_release',
      observationTime: 'BLS scheduled CPI release',
      geometry: 'threshold',
      payout: 1,
      unit: 'percent_yoy',
      currency: 'USD',
      warning: 'Resolves from the initial one-decimal All Items CPI-U year-over-year value published by BLS.',
    }),
    forecastExResolver: null,
  }),
  sp500: Object.freeze({
    id: 'sp500',
    label: 'SP500',
    fullLabel: 'S&P 500',
    symbol: 'SPX',
    venueIds: Object.freeze(['forecastex']),
    seriesTicker: 'KXINXU',
    eventSuffix: 'H1600',
    horizonDays: 7,
    forecastExProduct: 'FES',
    precision: 0,
    unit: 'index points',
    riskRange: Object.freeze({ ticker: 'SPX', label: 'SPX Risk Range', fit: 'calibration' }),
    trade: Object.freeze({ ticker: 'SPX', label: 'SPX Trade' }),
    volatility: Object.freeze(['VIX', 'VVIX']),
    cftc: Object.freeze({ code: '13874A', label: 'CFTC · E-MINI NET · 1Y Z', seriesType: 'legacy-noncommercial-combined' }),
    kalshiResolver: Object.freeze({
      underlying: 'cash_spx',
      resolver: 'kalshi_kxinxu_cash_spx_close',
      observationTime: '16:00 America/New_York',
      geometry: 'threshold',
      payout: 1,
      unit: 'index_points',
      currency: 'USD',
      warning: 'Resolves from the 4:00 PM ET cash S&P 500 index value.',
    }),
    forecastExResolver: Object.freeze({
      underlying: 'cme_es_dated_future',
      resolver: 'forecastex_fes_cme_es_daily_settlement',
      observationTime: 'CME official daily settlement',
      geometry: 'threshold',
      payout: 1,
      unit: 'index_points',
      currency: 'USD',
      warning: 'ForecastEx FES resolves from a dated E-mini S&P 500 futures settlement, not cash SPX.',
    }),
  }),
  wti: Object.freeze({
    id: 'wti',
    label: 'WTI',
    fullLabel: 'WTI Oil',
    symbol: 'WTI',
    seriesTicker: 'KXWTI',
    seriesTickers: Object.freeze(['KXWTI', 'KXWTIW']),
    standardCadence: 'daily',
    eventSuffix: null,
    horizonDays: 15,
    forecastExProduct: 'COMCO',
    precision: 2,
    unit: 'USD/bbl',
    riskRange: Object.freeze({ ticker: 'WTIC', label: 'WTIC Risk Range', fit: 'calibration' }),
    trade: Object.freeze({ ticker: 'USO', label: 'WTI Trade' }),
    volatility: Object.freeze(['OVX']),
    cftc: Object.freeze({ code: '067651', label: 'CFTC CRUDE-OIL MANAGED MONEY · 1Y / 3Y Z', seriesType: 'legacy-noncommercial-combined' }),
    usdCorrelationKey: 'WTI',
    kalshiResolver: Object.freeze({
      underlying: 'ice_wbs_front_month',
      resolver: 'kalshi_kxwti_ice_wbs_daily_settlement',
      observationTime: 'ICE official daily settlement',
      geometry: 'threshold',
      payout: 1,
      unit: 'usd_per_barrel',
      currency: 'USD',
      warning: 'WTIC and OVX are research context; they are not the ICE settlement resolver.',
    }),
    forecastExResolver: Object.freeze({
      underlying: 'forecastex_comco_wti_future',
      resolver: 'forecastex_comco_daily_settlement',
      observationTime: 'ForecastEx published daily settlement schedule',
      geometry: 'threshold',
      payout: 1,
      unit: 'usd_per_barrel',
      currency: 'USD',
      warning: 'COMCO terms must match the Kalshi resolver exactly before prices can be compared.',
    }),
  }),
  nasdaq100: Object.freeze({
    id: 'nasdaq100',
    label: 'Nasdaq',
    fullLabel: 'Nasdaq-100',
    symbol: 'NDX',
    seriesTicker: 'KXNASDAQ100U',
    eventSuffix: 'H1600',
    horizonDays: 7,
    forecastExProduct: 'FNQ',
    precision: 0,
    unit: 'index points',
    riskRange: Object.freeze({ ticker: 'COMPQ', label: 'COMPQ Risk Range', fit: 'related_only' }),
    trade: Object.freeze({ ticker: 'COMPQ', label: 'Nasdaq Trade' }),
    volatility: Object.freeze(['NazVol']),
    cftc: Object.freeze({ code: '209742', label: 'CFTC · NASDAQ MINI · 1Y Z', seriesType: 'legacy-noncommercial-combined' }),
    usdCorrelationKey: 'NDX',
    kalshiResolver: Object.freeze({
      underlying: 'cash_nasdaq_100',
      resolver: 'kalshi_kxnasdaq100u_cash_ndx_close',
      observationTime: '16:00 America/New_York',
      geometry: 'threshold',
      payout: 1,
      unit: 'index_points',
      currency: 'USD',
      warning: 'Resolves from the cash Nasdaq-100 value. COMPQ is a related index only.',
    }),
    forecastExResolver: Object.freeze({
      underlying: 'cme_nq_dated_future',
      resolver: 'forecastex_fnq_cme_nq_daily_settlement',
      observationTime: 'CME official daily settlement',
      geometry: 'threshold',
      payout: 1,
      unit: 'index_points',
      currency: 'USD',
      warning: 'ForecastEx FNQ resolves from a dated E-mini Nasdaq-100 futures settlement, not cash NDX.',
    }),
  }),
  gold: Object.freeze({
    id: 'gold',
    label: 'Gold',
    fullLabel: 'Gold',
    symbol: 'GOLD',
    seriesTicker: 'KXGOLDD',
    seriesTickers: Object.freeze(['KXGOLDD']),
    eventSuffix: null,
    horizonDays: 15,
    forecastExProduct: 'METLG',
    precision: 1,
    unit: 'USD/oz',
    riskRange: Object.freeze({ ticker: 'GLD', label: 'Gold Risk Range', fit: 'strong_proxy' }),
    trade: Object.freeze({ ticker: 'GLD', label: 'Gold Trade' }),
    volatility: Object.freeze(['GVZ']),
    cftc: Object.freeze({ code: '088691', label: 'CFTC GOLD MANAGED MONEY · 1Y / 3Y Z', seriesType: 'disaggregated-managed-money-combined' }),
    usdCorrelationKey: 'GOLD',
    kalshiResolver: Object.freeze({
      underlying: 'pyth_gold_usd',
      resolver: 'kalshi_kxgoldd_pyth_gold_close',
      observationTime: '17:00 America/New_York',
      geometry: 'threshold',
      payout: 1,
      unit: 'usd_per_ounce',
      currency: 'USD',
      warning: 'Kalshi uses its published Pyth Gold close; GLD and GVZ are proxy context only.',
    }),
    forecastExResolver: Object.freeze({
      underlying: 'comex_gc_dated_future',
      resolver: 'forecastex_metlg_comex_gc_daily_settlement',
      observationTime: 'COMEX official daily settlement',
      geometry: 'threshold',
      payout: 1,
      unit: 'usd_per_ounce',
      currency: 'USD',
      warning: 'ForecastEx METLG resolves from a dated COMEX Gold settlement, not the Kalshi Pyth close.',
    }),
  }),
  silver: Object.freeze({
    id: 'silver',
    label: 'Silver',
    fullLabel: 'Silver',
    symbol: 'SILVER',
    seriesTicker: 'KXSILVERW',
    seriesTickers: Object.freeze(['KXSILVERW']),
    eventSuffix: null,
    horizonDays: 15,
    forecastExProduct: 'METLS',
    precision: 2,
    unit: 'USD/oz',
    riskRange: Object.freeze({ ticker: 'SILVER', label: 'Silver Risk Range', fit: 'calibration' }),
    trade: Object.freeze({ ticker: 'SILVER', label: 'Silver Trade' }),
    volatility: Object.freeze([]),
    cftc: Object.freeze({ code: '084691', label: 'CFTC SILVER MANAGED MONEY · 1Y / 3Y Z', seriesType: 'disaggregated-managed-money-combined' }),
    usdCorrelationKey: 'SILVER',
    kalshiResolver: Object.freeze({
      underlying: 'pyth_silver_usd',
      resolver: 'kalshi_kxsilverw_pyth_silver_close',
      observationTime: '17:00 America/New_York',
      geometry: 'range_or_threshold',
      payout: 1,
      unit: 'usd_per_ounce',
      currency: 'USD',
      warning: 'Kalshi uses its published Pyth Silver close; the SILVER Risk Range is research calibration, not the resolver.',
    }),
    forecastExResolver: Object.freeze({
      underlying: 'comex_si_dated_future',
      resolver: 'forecastex_metls_comex_si_daily_settlement',
      observationTime: 'COMEX official daily settlement',
      geometry: 'threshold',
      payout: 1,
      unit: 'usd_per_ounce',
      currency: 'USD',
      warning: 'ForecastEx METLS resolves from a dated COMEX Silver settlement, not the Kalshi Pyth close.',
    }),
  }),
  brent: Object.freeze({
    id: 'brent',
    label: 'Brent',
    fullLabel: 'Brent Oil',
    symbol: 'BRENT',
    seriesTicker: 'KXBRENTD',
    seriesTickers: Object.freeze(['KXBRENTD', 'KXBRENTW']),
    standardCadence: 'daily',
    eventSuffix: null,
    horizonDays: 15,
    forecastExProduct: null,
    precision: 2,
    unit: 'USD/bbl',
    riskRange: Object.freeze({ ticker: 'BRENT', label: 'Brent Risk Range', fit: 'calibration' }),
    trade: Object.freeze({ ticker: 'BRENT', label: 'Brent Trade' }),
    volatility: Object.freeze(['OVX']),
    cftc: null,
    usdCorrelationKey: 'BRENT',
    kalshiResolver: Object.freeze({
      underlying: 'pyth_brent_front_month',
      resolver: 'kalshi_kxbrent_pyth_front_month_close',
      observationTime: '17:00 America/New_York',
      geometry: 'range_or_threshold',
      payout: 1,
      unit: 'usd_per_barrel',
      currency: 'USD',
      warning: 'Kalshi uses the event-specific published Pyth/front-month Brent source; the BRENT Risk Range is research calibration only.',
    }),
    forecastExResolver: null,
  }),
  bitcoin: Object.freeze({
    id: 'bitcoin',
    label: 'Bitcoin',
    fullLabel: 'Bitcoin',
    symbol: 'BTC',
    seriesTicker: 'KXBTCD',
    seriesTickers: Object.freeze(['KXBTCD']),
    eventSuffix: null,
    horizonDays: 3,
    forecastExProduct: null,
    precision: 0,
    unit: 'USD',
    riskRange: Object.freeze({ ticker: 'BITCOIN', label: 'Bitcoin Risk Range', fit: 'calibration' }),
    trade: Object.freeze({ ticker: 'BITCOIN', label: 'Bitcoin Trade' }),
    volatility: Object.freeze(['BITVX']),
    cftc: Object.freeze({ code: '133741', label: 'CFTC CME BITCOIN · 1Y / 3Y Z', seriesType: 'legacy-noncommercial-combined' }),
    usdCorrelationKey: 'BTC',
    kalshiResolver: Object.freeze({
      underlying: 'cf_benchmarks_brti',
      resolver: 'kalshi_kxbtcd_brti_60_sample_average',
      observationTime: 'final minute before expiration',
      geometry: 'threshold',
      payout: 1,
      unit: 'usd',
      currency: 'USD',
      warning: 'Kalshi resolves from the average of 60 CF Benchmarks BRTI observations in the final minute; the Bitcoin Risk Range is research calibration only.',
    }),
    forecastExResolver: null,
  }),
});

const MARKET_IDS = Object.freeze([
  ...Object.keys(MARKET_CONFIGS).filter((marketId) => marketId !== 'cpi'),
  'cpi',
]);

function finiteNumber(value, { min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY } = {}) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

function isoTimestamp(value) {
  const parsed = value instanceof Date ? value.getTime() : Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function dateKey(value) {
  return String(value || '').match(/^(\d{4}-\d{2}-\d{2})/)?.[1] || null;
}

function normalizeDirection(value) {
  const normalized = String(value || '').trim().toUpperCase();
  if (['BULLISH', 'BULL', 'LONG', 'BUY'].includes(normalized)) return 'BULLISH';
  if (['BEARISH', 'BEAR', 'SHORT', 'SELL'].includes(normalized)) return 'BEARISH';
  if (['NEUTRAL', 'FLAT', 'MIXED'].includes(normalized)) return 'NEUTRAL';
  return null;
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

function refreshFailure(section, issue) {
  return {
    ...section,
    refreshing: false,
    refreshFailed: true,
    refreshIssue: sourceFailure(issue, section?.reason || 'Source refresh failed.'),
    errorCode: issue?.code || issue?.sidecarCode || section?.errorCode || 'PM_SOURCE_REFRESH_FAILED',
    lastAttemptAt: new Date().toISOString(),
  };
}

function refreshPending(section, reason) {
  return {
    ...section,
    status: 'refreshing',
    refreshing: true,
    refreshFailed: false,
    refreshIssue: null,
    errorCode: null,
    lastAttemptAt: new Date().toISOString(),
    reason: reason || section?.reason || 'This section is refreshing.',
  };
}

function refreshingSpxChart(reason = 'SPX chart is refreshing.') {
  const variant = (range) => refreshPending(unavailable(reason, {
    range,
    availability: 'unavailable',
    points: [],
    references: [],
    rangeDates: [],
    dailyRanges: [],
  }), reason);
  const oneDay = variant('1d');
  return {
    ...oneDay,
    variants: {
      '1d': { ...oneDay },
      '5d': variant('5d'),
      '10d': variant('10d'),
    },
  };
}

function refreshingResolverReference(resolver = null) {
  const reason = 'The exact FES resolver reference is refreshing.';
  return {
    status: 'refreshing',
    resolver,
    instrument: null,
    spot: refreshPending(unavailable(reason, {
      availability: 'unavailable',
      fit: 'exact',
      value: null,
      executable: false,
    }), reason),
    chart: refreshPending(unavailable(reason, {
      availability: 'unavailable',
      fit: 'exact',
      points: [],
      references: [],
      executable: false,
    }), reason),
  };
}

function ensureChartVariants(chart, reason = 'Verified chart history is unavailable.') {
  const variant = (range) => unavailable(reason, {
    range,
    availability: 'unavailable',
    points: [],
    references: [],
    rangeDates: [],
    dailyRanges: [],
    fit: chart?.fit || 'exact',
    executable: false,
  });
  const supplied = chart?.variants || {};
  const oneDay = supplied['1d'] || chart || variant('1d');
  const variants = {
    '1d': { ...oneDay, range: '1d' },
    '5d': supplied['5d'] || variant('5d'),
    '10d': supplied['10d'] || variant('10d'),
  };
  return { ...variants['1d'], variants };
}

function mapChartVariants(chart, mapper) {
  const complete = ensureChartVariants(chart, chart?.reason);
  const variants = Object.fromEntries(Object.entries(complete.variants).map(([range, value]) => [
    range,
    mapper(value, range),
  ]));
  return { ...variants['1d'], variants };
}

function utcWeekendDate(date) {
  const timestamp = Date.parse(`${date}T12:00:00.000Z`);
  if (!Number.isFinite(timestamp)) return false;
  const weekday = new Date(timestamp).getUTCDay();
  return weekday === 0 || weekday === 6;
}

function verifiedRiskRangeReferences(range, expectedDate = range?.date) {
  const date = String(expectedDate || '');
  const publicationDate = String(range?.riskRangePublicationDate || date);
  const carriedForward = range?.riskRangeCarryForward === 'last_published_non_publication_session';
  const references = Array.isArray(range?.references) ? range.references : [];
  const provenance = [
    range?.warning,
    range?.provenance,
    range?.cacheState,
    range?.fromCache ? 'cache' : '',
    range?.cachedOnly ? 'cache-only' : '',
    range?.seeded ? 'seed' : '',
  ].filter(Boolean).join(' ');
  if (
    range?.status !== 'available'
    || !/^\d{4}-\d{2}-\d{2}$/.test(date)
    || FORBIDDEN_PROVENANCE.test(provenance)
  ) return null;
  const resolved = ['LRR', 'HRR'].map((label) => {
    const reference = references.find((candidate) => String(candidate?.label || '').toUpperCase() === label);
    const value = finiteNumber(reference?.value);
    const source = String(reference?.source || '').trim();
    const asOf = String(reference?.asOf || '');
    const referenceDate = /^\d{4}-\d{2}-\d{2}/.test(asOf) ? asOf.slice(0, 10) : publicationDate;
    if (
      reference?.status !== 'available'
      || value == null
      || source.length === 0
      || FORBIDDEN_PROVENANCE.test(source)
      || (carriedForward
        ? !utcWeekendDate(date)
          || !/^\d{4}-\d{2}-\d{2}$/.test(publicationDate)
          || publicationDate >= date
          || reference?.carriedForward !== true
          || referenceDate !== publicationDate
        : referenceDate !== date)
      || reference?.refreshFailed === true
      || reference?.fromCache === true
      || reference?.cachedOnly === true
      || reference?.seeded === true
    ) return null;
    return { ...reference, label, value, source, asOf: asOf || date };
  });
  if (resolved.some((reference) => !reference)) return null;
  const lrr = resolved.find((reference) => reference.label === 'LRR')?.value;
  const hrr = resolved.find((reference) => reference.label === 'HRR')?.value;
  return lrr < hrr ? resolved : null;
}

function dailyRiskRangeFromSection(section) {
  const date = String(section?.date || '').slice(0, 10);
  const lrr = finiteNumber(section?.lrr);
  const hrr = finiteNumber(section?.hrr);
  const source = String(section?.source || '').trim();
  const asOf = String(section?.asOf || section?.date || '');
  if (
    section?.status !== 'available'
    || !/^\d{4}-\d{2}-\d{2}$/.test(date)
    || lrr == null
    || hrr == null
    || lrr >= hrr
    || source.length === 0
    || FORBIDDEN_PROVENANCE.test([
      source,
      section?.warning,
      section?.provenance,
      section?.cacheState,
      section?.fromCache ? 'cache' : '',
      section?.cachedOnly ? 'cache-only' : '',
      section?.seeded ? 'seed' : '',
    ].filter(Boolean).join(' '))
    || (/^\d{4}-\d{2}-\d{2}/.test(asOf) && asOf.slice(0, 10) !== date)
    || section?.refreshFailed === true
  ) return null;
  return {
    date,
    status: 'available',
    references: [
      { status: 'available', kind: 'underlying', label: 'LRR', tone: 'low', value: lrr, source, asOf: asOf || date },
      { status: 'available', kind: 'underlying', label: 'HRR', tone: 'high', value: hrr, source, asOf: asOf || date },
    ],
  };
}

function attachVerifiedRiskRangeOverlays(referenceChart, contextChart = null, currentRiskRange = null) {
  const contextVariants = contextChart
    ? ensureChartVariants(contextChart, contextChart?.reason).variants
    : {};
  const currentRange = dailyRiskRangeFromSection(currentRiskRange);
  return mapChartVariants(referenceChart, (variant, range) => {
    if (!Array.isArray(variant?.dailyRanges) || variant.dailyRanges.length === 0) return variant;
    const candidates = new Map();
    variant.dailyRanges.forEach((candidate) => {
      const references = verifiedRiskRangeReferences(candidate);
      if (references) candidates.set(candidate.date, { ...candidate, references });
    });
    (contextVariants?.[range]?.dailyRanges || []).forEach((candidate) => {
      const references = verifiedRiskRangeReferences(candidate);
      if (references) candidates.set(candidate.date, { ...candidate, references });
    });
    if (currentRange) candidates.set(currentRange.date, currentRange);
    let changed = false;
    const dailyRanges = variant.dailyRanges.map((dailyRange) => {
      if (verifiedRiskRangeReferences(dailyRange)) return dailyRange;
      const date = String(dailyRange?.date || '');
      let candidate = candidates.get(date);
      let carriedForward = false;
      if (!candidate
        && variant?.carryRiskRangeAcrossNonPublicationSessions === true
        && utcWeekendDate(date)) {
        const candidateDate = [...candidates.keys()]
          .filter((availableDate) => availableDate < date)
          .sort()
          .at(-1);
        candidate = candidateDate ? candidates.get(candidateDate) : null;
        carriedForward = Boolean(candidate);
      }
      const references = verifiedRiskRangeReferences(candidate);
      if (!candidate || !references) return dailyRange;
      changed = true;
      const publicationDate = String(candidate?.riskRangePublicationDate || candidate?.date || '');
      const usesCarryForward = carriedForward
        || candidate?.riskRangeCarryForward === 'last_published_non_publication_session';
      return {
        ...dailyRange,
        status: 'available',
        references: references.map((reference) => ({
          ...reference,
          ...(usesCarryForward ? {
            publicationDate,
            effectiveDate: date,
            carriedForward: true,
          } : {}),
        })),
        reason: null,
        refreshPending: false,
        refreshRetained: false,
        contextHydrated: true,
        ...(usesCarryForward ? {
          riskRangePublicationDate: publicationDate,
          riskRangeCarryForward: 'last_published_non_publication_session',
        } : {}),
      };
    });
    const missingDates = dailyRanges
      .filter((dailyRange) => !verifiedRiskRangeReferences(dailyRange))
      .map((dailyRange) => dailyRange.date);
    return {
      ...variant,
      dailyRanges,
      riskRangeStatus: missingDates.length ? 'partial' : 'available',
      riskRangeMissingDates: missingDates,
      ...(missingDates.length ? {} : {
        riskRangeReason: null,
        riskRangeRefreshPending: false,
      }),
      ...(changed ? { riskRangeContextHydrated: true } : {}),
    };
  });
}

function attachVerifiedVixCloses(referenceChart, cashChart) {
  const cashVariants = ensureChartVariants(cashChart, cashChart?.reason).variants;
  return mapChartVariants(referenceChart, (variant, range) => {
    const rangeDates = Array.isArray(variant?.rangeDates) ? variant.rangeDates : [];
    const context = cashVariants?.[range]?.vixCloses;
    if (
      rangeDates.length === 0
      || !['available', 'partial'].includes(context?.status)
      || context?.availability !== 'historical'
      || context?.source !== 'ibkr_historical_daily_close'
      || !Array.isArray(context?.values)
    ) return variant;
    const valuesByDate = new Map();
    context.values.forEach((row) => {
      const date = String(row?.date || '');
      const value = finiteNumber(row?.value, { min: Number.EPSILON });
      if (/^\d{4}-\d{2}-\d{2}$/.test(date) && value != null && !valuesByDate.has(date)) {
        valuesByDate.set(date, value);
      }
    });
    const values = rangeDates.flatMap((date) => (
      valuesByDate.has(date) ? [{ date, value: valuesByDate.get(date) }] : []
    ));
    if (!values.length) return variant;
    const missingDates = rangeDates.filter((date) => !valuesByDate.has(date));
    return {
      ...variant,
      vixCloses: {
        status: missingDates.length ? 'partial' : 'available',
        availability: 'historical',
        source: 'ibkr_historical_daily_close',
        asOf: context.asOf || null,
        values,
        missingDates,
        reason: missingDates.length
          ? `Verified IBKR VIX daily closes are unavailable for ${missingDates.join(', ')}.`
          : null,
      },
    };
  });
}

function refreshTimeout(source) {
  const error = new Error(`${source} is still refreshing.`);
  error.code = 'PM_MONITOR_SECTION_REFRESHING';
  error.refreshing = true;
  return error;
}

function settleByDeadline(promise, deadlineMs, source) {
  return new Promise((resolve) => {
    let finished = false;
    let timer = null;
    const complete = (result) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    const remainingMs = Math.max(0, deadlineMs - Date.now());
    timer = setTimeout(() => complete({
      status: 'pending',
      reason: refreshTimeout(source),
    }), remainingMs);
    Promise.resolve(promise).then(
      (value) => complete({ status: 'fulfilled', value }),
      (reason) => complete({ status: 'rejected', reason }),
    );
  });
}

function settleWithin(promise, timeoutMs, source) {
  return settleByDeadline(
    promise,
    Date.now() + Math.max(0, Number(timeoutMs) || 0),
    source,
  );
}

function isPendingResult(result) {
  return result?.status === 'pending';
}

function nextTurn() {
  return new Promise((resolve) => {
    if (typeof setImmediate === 'function') setImmediate(resolve);
    else setTimeout(resolve, 0);
  });
}

function sourceFailure(error, fallback) {
  return String(error?.message || error || fallback).slice(0, 240);
}

function normalizeFingerprintPart(value) {
  if (Array.isArray(value)) return value.map(normalizeFingerprintPart);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalizeFingerprintPart(value[key])]));
  }
  return typeof value === 'string' ? value.trim().toLowerCase().replace(/\s+/g, ' ') : value;
}

function buildEquivalenceFingerprint(identity = {}) {
  const normalized = normalizeFingerprintPart({
    underlying: identity.underlying || null,
    resolver: identity.resolver || null,
    observationTime: identity.observationTime || null,
    geometry: identity.geometry || null,
    strikeGeometry: identity.strikeGeometry || identity.comparatorStrikeGeometry || null,
    payout: finiteNumber(identity.payout),
    unit: identity.unit || null,
    currency: identity.currency || null,
  });
  const complete = Object.values(normalized).every((value) => (
    value !== null && value !== '' && (!Array.isArray(value) || value.length > 0)
  ));
  if (!complete) return null;
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

function buildContractGeometry(lines = []) {
  return (Array.isArray(lines) ? lines : [])
    .map((line) => ({
      comparator: line?.comparator || null,
      lowerBound: finiteNumber(line?.lowerBound ?? line?.threshold),
      upperBound: finiteNumber(line?.upperBound),
      threshold: finiteNumber(line?.threshold),
    }))
    .filter((entry) => entry.comparator && entry.threshold != null)
    .sort((left, right) => (
      left.threshold - right.threshold
      || String(left.comparator).localeCompare(String(right.comparator))
      || Number(left.lowerBound ?? Number.NEGATIVE_INFINITY) - Number(right.lowerBound ?? Number.NEGATIVE_INFINITY)
      || Number(left.upperBound ?? Number.POSITIVE_INFINITY) - Number(right.upperBound ?? Number.POSITIVE_INFINITY)
    ));
}

function buildVenueFingerprint(resolver, event, lines) {
  const observationTime = isoTimestamp(event?.observationTime || event?.closeTime);
  const strikeGeometry = buildContractGeometry(lines);
  if (!observationTime || !strikeGeometry.length) return null;
  return buildEquivalenceFingerprint({
    ...resolver,
    observationTime,
    strikeGeometry,
  });
}

function kalshiPrice(market, dollarsKey, centsKey) {
  const dollars = finiteNumber(market?.[dollarsKey], { min: 0, max: 1 });
  if (dollars != null) return dollars;
  const cents = finiteNumber(market?.[centsKey], { min: 0, max: 100 });
  return cents == null ? null : cents / 100;
}

function directPair(bid, ask) {
  return bid != null && ask != null && bid >= 0 && ask > 0 && ask <= 1 && ask >= bid;
}

function normalizeNativeBidArray(levels) {
  return (Array.isArray(levels) ? levels : []).map((level) => {
    if (!Array.isArray(level) || level.length < 2) return null;
    const price = finiteNumber(level[0], { min: 0, max: 1 });
    const size = finiteNumber(level[1], { min: 0 });
    return price == null || size == null ? null : [price, size];
  }).filter(Boolean);
}

function nativeOrderbookForTicker(orderbooks, ticker) {
  if (!orderbooks) return null;
  if (orderbooks instanceof Map) return orderbooks.get(String(ticker)) || null;
  return orderbooks[String(ticker)] || null;
}

function normalizeKalshiLine(market, fetchedAt, rawOrderbook = null) {
  const strikeType = String(market?.strike_type || 'greater').trim().toLowerCase();
  const lowerBound = finiteNumber(market?.floor_strike);
  const upperBound = finiteNumber(market?.cap_strike);
  const threshold = lowerBound ?? upperBound;
  const closeAt = isoTimestamp(market?.close_time);
  if (!market?.ticker || threshold == null || !closeAt || CLOSED_STATUSES.has(String(market.status || '').toLowerCase())) return null;
  const nativeBook = rawOrderbook?.orderbook_fp || rawOrderbook?.orderbook || rawOrderbook || {};
  const yesBids = normalizeNativeBidArray(nativeBook.yes_dollars);
  const noBids = normalizeNativeBidArray(nativeBook.no_dollars);
  const bestYesBid = [...yesBids].sort((left, right) => right[0] - left[0])[0] || null;
  const bestNoBid = [...noBids].sort((left, right) => right[0] - left[0])[0] || null;
  const batchVerified = Boolean(rawOrderbook);
  const yesBid = batchVerified ? bestYesBid?.[0] ?? null : null;
  const yesAsk = kalshiPrice(market, 'yes_ask_dollars', 'yes_ask');
  const noBid = batchVerified ? bestNoBid?.[0] ?? null : null;
  const noAsk = kalshiPrice(market, 'no_ask_dollars', 'no_ask');
  const yesBidSize = batchVerified ? bestYesBid?.[1] ?? null : null;
  const yesAskSize = finiteNumber(market.yes_ask_size_fp ?? market.yes_ask_size, { min: 0 });
  const noBidSize = batchVerified ? bestNoBid?.[1] ?? null : null;
  const noAskSize = finiteNumber(market.no_ask_size_fp ?? market.no_ask_size, { min: 0 });
  const yesDirect = directPair(yesBid, yesAsk);
  const noDirect = directPair(noBid, noAsk);
  const updatedAt = isoTimestamp(market.updated_time) || fetchedAt;
  const lastTrade = kalshiPrice(market, 'last_price_dollars', 'last_price');
  const volume24h = finiteNumber(market.volume_24h_fp ?? market.volume_24h, { min: 0 });
  const totalVolume = finiteNumber(market.volume_fp ?? market.volume, { min: 0 });
  const openInterest = finiteNumber(market.open_interest_fp ?? market.open_interest, { min: 0 });
  const liquidity = finiteNumber(market.liquidity_dollars ?? market.liquidity, { min: 0 });
  return {
    ticker: String(market.ticker),
    threshold,
    lowerBound,
    upperBound,
    strikeType,
    comparator: strikeType === 'less' ? '<' : strikeType === 'between' ? 'inclusive_range' : '>',
    status: yesDirect && noDirect ? 'available' : 'incomplete',
    yesBid,
    yesAsk,
    yesBidSize,
    yesAskSize,
    noBid,
    noAsk,
    noBidSize,
    noAskSize,
    lastTrade,
    previousYesBid: kalshiPrice(market, 'previous_yes_bid_dollars', 'previous_yes_bid'),
    previousYesAsk: kalshiPrice(market, 'previous_yes_ask_dollars', 'previous_yes_ask'),
    previousPrice: kalshiPrice(market, 'previous_price_dollars', 'previous_price'),
    volume24h,
    totalVolume,
    openInterest,
    liquidity,
    updatedAt,
    closeAt,
    openAt: isoTimestamp(market.open_time),
    expirationAt: isoTimestamp(market.expiration_time),
    expectedExpirationAt: isoTimestamp(market.expected_expiration_time),
    latestExpirationAt: isoTimestamp(market.latest_expiration_time),
    settlementTimerSeconds: finiteNumber(market.settlement_timer_seconds, { min: 0 }),
    notionalValue: finiteNumber(market.notional_value_dollars ?? market.notional_value, { min: 0 }),
    minTick: 0.01,
    title: market.title || null,
    subtitle: market.subtitle || null,
    rulesPrimary: market.rules_primary || null,
    rulesSecondary: market.rules_secondary || null,
    result: String(market.result || '').trim().toLowerCase() || null,
    canCloseEarly: market.can_close_early === true,
    customStrike: market.custom_strike && typeof market.custom_strike === 'object' ? { ...market.custom_strike } : null,
    source: batchVerified ? 'kalshi_batch_orderbooks_v2' : 'kalshi_trade_api_v2_catalog',
    derivedFields: [],
    quoteSources: {},
    directNative: batchVerified,
    depthCapability: batchVerified ? 'native_bid_depth' : 'no_live_book',
    nativeOrderbook: batchVerified ? { yesBids, noBids } : null,
    evidence: {
      quotes: batchVerified ? { source: 'kalshi_batch_orderbooks_v2', asOf: fetchedAt, fit: 'exact', executable: yesDirect || noDirect } : null,
      activity: { source: 'kalshi_trade_api_v2_catalog', asOf: fetchedAt, fit: 'exact', executable: false },
      openInterest: { source: 'kalshi_trade_api_v2_catalog', asOf: fetchedAt, fit: 'exact', executable: false, scope: 'contract_line' },
    },
  };
}

function catalogLine(line) {
  return {
    ...line,
    status: 'catalog',
    yesBid: null,
    yesAsk: null,
    yesBidSize: null,
    yesAskSize: null,
    noBid: null,
    noAsk: null,
    noBidSize: null,
    noAskSize: null,
    updatedAt: null,
    source: line.source === 'forecastex_official_schedule'
      ? line.source
      : 'kalshi_trade_api_v2_catalog',
    directNative: false,
    nativeOrderbook: undefined,
  };
}

function failedNativeBook(section, issue, fallbackReason = 'Native book refresh failed.') {
  const refreshIssue = sourceFailure(issue, fallbackReason);
  return refreshFailure({
    ...section,
    status: 'unavailable',
    source: null,
    asOf: null,
    expiresAt: null,
    reason: refreshIssue,
    scheduleOnly: true,
    lines: (Array.isArray(section?.lines) ? section.lines : []).map(catalogLine),
  }, issue);
}

function mergeVenueDisplayContracts(venue) {
  const catalog = venue?.catalog;
  if (catalog?.status !== 'available' || !Array.isArray(catalog.lines) || !catalog.lines.length) {
    return unavailable(venue?.catalog?.reason || `${venue?.label || 'Venue'} catalog is unavailable.`, { event: null, lines: [] });
  }
  const retainedWhileRefreshing = (venue?.book?.refreshing === true || venue?.book?.refreshPending === true)
    && venue?.book?.refreshRetained === true;
  const bookCanSupplyLiveFields = ['available', 'partial'].includes(venue?.book?.status)
    && (venue?.book?.refreshing !== true || retainedWhileRefreshing)
    && (venue?.book?.refreshPending !== true || retainedWhileRefreshing)
    && venue?.book?.refreshFailed !== true
    && Number.isFinite(Date.parse(venue?.book?.expiresAt || ''))
    && !FORBIDDEN_PROVENANCE.test(String(venue?.book?.source || ''));
  const nativeLines = bookCanSupplyLiveFields
    ? (venue.book.lines || []).filter((line) => line?.directNative === true)
    : [];
  const liveByTicker = new Map(nativeLines.map((line) => [String(line.ticker), line]));
  const selectedContractIds = new Set(
    Array.isArray(venue?.ladderSelection?.contractIds)
      ? venue.ladderSelection.contractIds.map(String)
      : [],
  );
  const hasNativeQuotes = nativeLines.some((line) => (
    [line.yesBid, line.yesAsk, line.noBid, line.noAsk]
      .some((value) => finiteNumber(value, { min: 0, max: 1 }) != null)
  ));
  const displayCatalogLines = selectedContractIds.size
    ? catalog.lines.filter((line) => selectedContractIds.has(String(line.contractId || line.ticker)))
    : catalog.lines;
  const lines = displayCatalogLines.map((line) => {
    const live = liveByTicker.get(String(line.ticker));
    return live ? { ...line, ...live } : { ...line, status: 'catalog', directNative: false };
  });
  return {
    ...catalog,
    status: 'available',
    source: `${catalog.source}${hasNativeQuotes ? '+native_live_quotes' : ''}`,
    bookStatus: venue?.book?.status || 'unavailable',
    bookExpiresAt: venue?.book?.expiresAt || null,
    ladderSelection: venue?.ladderSelection || venue?.book?.ladderSelection || null,
    refreshing: venue?.book?.refreshing === true,
    refreshPending: venue?.book?.refreshPending === true,
    refreshRetained: venue?.book?.refreshRetained === true,
    refreshFailed: venue?.book?.refreshFailed === true,
    refreshIssue: venue?.book?.refreshIssue || null,
    lines,
    scheduleOnly: !hasNativeQuotes,
    reason: venue?.book?.status === 'available'
      ? null
      : hasNativeQuotes
        ? venue?.book?.reason || 'Fresh native quotes are shown, but the book is incomplete for execution.'
        : venue?.book?.reason || 'Current contract geometry is shown without an executable live book.',
  };
}

function selectDisplayVenue(venuesById = {}, autoSelection = null, options = {}) {
  if (autoSelection?.status === 'available' && autoSelection.venueId === 'exact-best') {
    return {
      status: 'available',
      mode: 'executable',
      venueId: 'exact-best',
      label: autoSelection.label,
      reason: autoSelection.reason,
      contracts: autoSelection.contracts,
    };
  }
  const candidates = Object.values(venuesById).filter((venue) => (
    venue?.catalog?.status === 'available' && Array.isArray(venue.catalog.lines) && venue.catalog.lines.length
      && (!options.standardCadence
        || venue.catalog?.event?.cadence === options.standardCadence)
  )).map((venue) => {
    const contracts = mergeVenueDisplayContracts(venue);
    const basisStatus = String(venue?.settlementBasis?.status || '').toLowerCase();
    const instrumentScope = String(venue?.settlementBasis?.instrumentScope || '').toLowerCase();
    const settlementTier = basisStatus === 'verified' && instrumentScope !== 'product'
      ? 0
      : ['verified', 'partial'].includes(basisStatus) ? 1 : 2;
    const referenceSection = venue?.reference?.spot || venue?.reference?.chart || null;
    const referenceStatus = String(referenceSection?.status || '').toLowerCase();
    const referenceFit = String(referenceSection?.fit || venue?.reference?.fit || '').toLowerCase();
    const referenceTier = ['available', 'historical', 'partial'].includes(referenceStatus)
      ? referenceFit === 'exact' ? 0 : referenceFit === 'proxy' ? 1 : 2
      : 2;
    const quoteTier = contracts.scheduleOnly === true ? 1 : 0;
    const executableTier = autoSelection?.status === 'available' && autoSelection.venueId === venue.id ? 0 : 1;
    return {
      venue,
      contracts,
      settlementTier,
      referenceTier,
      quoteTier,
      executableTier,
      volume24h: finiteNumber(venue.activity?.volume24h?.value, { min: 0 }),
      openInterest: finiteNumber(venue.activity?.selectedGenerationOpenInterest?.value, { min: 0 }),
    };
  }).sort((left, right) => {
    if (options.preferVerifiedVolume === true) {
      const leftPositiveVolume = Number(left.volume24h) > 0;
      const rightPositiveVolume = Number(right.volume24h) > 0;
      if (leftPositiveVolume !== rightPositiveVolume) return rightPositiveVolume ? 1 : -1;
      if (left.volume24h != null && right.volume24h != null && left.volume24h !== right.volume24h) {
        return right.volume24h - left.volume24h;
      }
      if (left.openInterest != null && right.openInterest != null && left.openInterest !== right.openInterest) {
        return right.openInterest - left.openInterest;
      }
    }
    return left.settlementTier - right.settlementTier
      || left.referenceTier - right.referenceTier
      || left.executableTier - right.executableTier
      || left.quoteTier - right.quoteTier
      || (Number.isFinite(Date.parse(left.venue.catalog?.event?.closeTime || '')) ? Date.parse(left.venue.catalog.event.closeTime) : Number.POSITIVE_INFINITY)
        - (Number.isFinite(Date.parse(right.venue.catalog?.event?.closeTime || '')) ? Date.parse(right.venue.catalog.event.closeTime) : Number.POSITIVE_INFINITY)
      || Number(right.openInterest || 0) - Number(left.openInterest || 0)
      || `${left.venue.id}:${left.venue.catalog?.event?.ticker || ''}`.localeCompare(`${right.venue.id}:${right.venue.catalog?.event?.ticker || ''}`);
  });
  const selectedCandidate = candidates[0] || null;
  const selected = selectedCandidate?.venue || null;
  if (!selected) {
    return {
      status: 'unavailable',
      mode: 'none',
      venueId: null,
      label: 'No current catalog',
      reason: 'No current open venue catalog is available.',
      contracts: unavailable('No current contract catalog is available.', { event: null, lines: [] }),
    };
  }
  const contracts = selectedCandidate.contracts;
  const hasNativeQuotes = contracts.scheduleOnly !== true;
  const exactSettlement = selectedCandidate.settlementTier === 0;
  const productSettlement = selectedCandidate.settlementTier === 1;
  const executable = selectedCandidate.executableTier === 0;
  return {
    status: 'available',
    mode: executable ? 'executable' : hasNativeQuotes ? 'live_quotes' : 'catalog',
    venueId: selected.id,
    generationId: selected.generationId || selected.catalog?.event?.generationId || selected.catalog?.event?.ticker || null,
    label: `${selected.label} ${executable ? 'live book' : hasNativeQuotes ? 'live quotes' : 'catalog'}`,
    reason: options.preferVerifiedVolume === true
      ? `Showing ${selected.label} because it has the strongest verified 24-hour volume for the current open daily generation; execution eligibility remains independent.`
      : exactSettlement
      ? `Auto selected ${selected.label} because it has the strongest verified exact settlement identity; native-book execution remains a separate eligibility check.`
      : productSettlement
        ? `No exact resolver identity is available; showing the strongest verified product-level ${selected.label} settlement context.`
        : hasNativeQuotes
          ? `No venue has a verified resolver identity; showing fresh native ${selected.label} bid/ask quotes without treating them as resolver evidence.`
          : `No venue has a verified resolver identity or executable book; showing the current ${selected.label} contract geometry only.`,
    contracts,
  };
}

function selectRequestedVenue(venuesById = {}, autoSelection = null, selection = {}, options = {}) {
  const venueId = String(selection?.venue || 'auto').trim().toLowerCase();
  if (!venueId || venueId === 'auto') return selectDisplayVenue(venuesById, autoSelection, options);
  const venue = venuesById[venueId];
  if (!venue) {
    return {
      status: 'unavailable',
      mode: 'none',
      venueId,
      generationId: selection?.generationId || null,
      label: `${venueId} unavailable`,
      reason: `${venueId} is not configured for this market.`,
      contracts: unavailable(`${venueId} has no current contracts for this market.`, { event: null, lines: [] }),
    };
  }
  const contracts = mergeVenueDisplayContracts(venue);
  const catalogAvailable = venue.catalog?.status === 'available'
    && Array.isArray(venue.catalog.lines)
    && venue.catalog.lines.length > 0;
  const hasNativeQuotes = catalogAvailable && contracts.scheduleOnly !== true;
  return {
    status: catalogAvailable ? 'available' : 'unavailable',
    mode: hasNativeQuotes ? 'live_quotes' : catalogAvailable ? 'catalog' : 'none',
    venueId,
    generationId: venue.generationId || selection?.generationId || null,
    label: `${venue.label}${hasNativeQuotes ? ' live quotes' : catalogAvailable ? ' catalog' : ' unavailable'}`,
    reason: hasNativeQuotes
      ? `Showing fresh native ${venue.label} quotes for the selected generation.`
      : catalogAvailable
        ? `Showing the selected ${venue.label} generation without a verified live book.`
        : venue.catalog?.reason || `${venue.label} has no current contracts for this market.`,
    contracts,
  };
}

function kalshiSeriesTickers(config) {
  return [...new Set((Array.isArray(config?.seriesTickers) ? config.seriesTickers : [config?.seriesTicker])
    .map((ticker) => String(ticker || '').trim().toUpperCase())
    .filter(Boolean))];
}

function inferGenerationCadence({ seriesTicker, title, closeTime, observationTime } = {}) {
  const normalizedSeries = String(seriesTicker || '').trim().toUpperCase();
  const normalizedTitle = String(title || '').trim().toLowerCase();
  // Kalshi cadence is encoded in the contract family. Check that identity
  // before prose so clock text such as "5:00 PM" cannot be mistaken for a
  // monthly contract (and ordinary words ending in W cannot become weekly).
  if (/^KX[A-Z0-9]*W$/.test(normalizedSeries)) return 'weekly';
  if (/^KX[A-Z0-9]*D$/.test(normalizedSeries) || normalizedSeries === 'KXWTI') return 'daily';
  if (normalizedSeries === CPI_SERIES_TICKER) return 'monthly';
  if (/\b(?:weekly|week)\b/.test(normalizedTitle)) return 'weekly';
  if (/\b(?:monthly|month)\b/.test(normalizedTitle)) return 'monthly';
  if (/\bfutures?\b/.test(normalizedTitle)) return 'futures';
  const closeMs = Date.parse(closeTime || '');
  const observationMs = Date.parse(observationTime || closeTime || '');
  if (Number.isFinite(closeMs) && Number.isFinite(observationMs) && Math.abs(closeMs - observationMs) > 6 * 24 * 60 * 60_000) {
    return 'weekly';
  }
  return 'daily';
}

function listKalshiEvents(events = [], config, nowMs = Date.now()) {
  const configuredSeries = kalshiSeriesTickers(config);
  return (Array.isArray(events) ? events : [])
    .filter((event) => {
      const eventTicker = String(event?.event_ticker || '');
      const eventSeries = String(event?.series_ticker || configuredSeries.find((ticker) => eventTicker.startsWith(`${ticker}-`)) || '').toUpperCase();
      return configuredSeries.includes(eventSeries)
        && eventTicker.startsWith(`${eventSeries}-`)
        && (!config.eventSuffix || eventTicker.endsWith(config.eventSuffix))
        && !CLOSED_STATUSES.has(String(event?.status || '').toLowerCase());
    })
    .map((event) => {
      const eventTicker = String(event?.event_ticker || '');
      const seriesTicker = String(event?.series_ticker || configuredSeries.find((ticker) => eventTicker.startsWith(`${ticker}-`)) || '').toUpperCase();
      const markets = (Array.isArray(event.markets) ? event.markets : []).filter((market) => {
        const closeMs = Date.parse(String(market?.close_time || ''));
        return market?.event_ticker === event.event_ticker
          && Number.isFinite(closeMs)
          && closeMs > nowMs
          && !CLOSED_STATUSES.has(String(market.status || '').toLowerCase());
      });
      const closeTimes = [...new Set(markets.map((market) => isoTimestamp(market.close_time)).filter(Boolean))];
      const closeTime = closeTimes.length === 1 ? closeTimes[0] : null;
      return {
        event,
        markets,
        closeTime,
        seriesTicker,
        generationId: String(event.event_ticker),
        cadence: inferGenerationCadence({
          seriesTicker,
          title: event.title,
          closeTime,
          observationTime: event.strike_date,
        }),
      };
    })
    .filter((candidate) => candidate.markets.length > 0 && candidate.closeTime)
    .sort((left, right) => (
      Date.parse(left.closeTime) - Date.parse(right.closeTime)
      || configuredSeries.indexOf(left.seriesTicker) - configuredSeries.indexOf(right.seriesTicker)
      || String(left.event?.event_ticker || '').localeCompare(String(right.event?.event_ticker || ''))
    ));
}

function selectKalshiEvent(events = [], config, nowMs = Date.now(), generationId = null) {
  const listed = listKalshiEvents(events, config, nowMs);
  const candidates = config?.standardCadence
    ? listed.filter((candidate) => candidate.cadence === config.standardCadence)
    : listed;
  if (!candidates.length) return null;
  if (generationId) {
    return candidates.find((candidate) => candidate.generationId === String(generationId)) || null;
  }
  const selected = candidates[0];
  return candidates.filter((candidate) => (
    candidate.closeTime === selected.closeTime && candidate.seriesTicker === selected.seriesTicker
  )).length === 1
    ? selected
    : null;
}

function sumPublishedMetric(lines, key) {
  const values = (Array.isArray(lines) ? lines : [])
    .map((line) => finiteNumber(line?.[key], { min: 0 }))
    .filter((value) => value != null);
  return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
}

function eventSpecificKalshiResolver(config, lines = []) {
  if (config?.id !== 'brent') return config?.kalshiResolver || null;
  const pythRules = (Array.isArray(lines) ? lines : [])
    .flatMap((line) => [line?.rulesPrimary, line?.rulesSecondary])
    .filter(Boolean)
    .join(' ');
  const frontMonthContracts = [...new Set((Array.isArray(lines) ? lines : [])
    .map((line) => String(line?.customStrike?.front_month_contract || '').trim().toUpperCase())
    .filter(Boolean))];
  const indexStyle = frontMonthContracts.length === 1
    && frontMonthContracts[0] === 'N/A'
    && /\b1-minute(?:\s+candlestick)?\b/i.test(pythRules)
    && /\bclose price\b/i.test(pythRules)
    && PYTH_RESOLVER_IDENTITIES.brent.assetPattern.test(pythRules);
  if (indexStyle) {
    return {
      ...config.kalshiResolver,
      underlying: PYTH_RESOLVER_IDENTITIES.brent.symbol,
      contractSymbol: null,
      pythSymbol: PYTH_RESOLVER_IDENTITIES.brent.symbol,
    };
  }
  if (!/\bpyth\b/i.test(pythRules)
    || frontMonthContracts.length !== 1
    || !/^BRENT[FGHJKMNQUVXZ]\d{1,2}$/.test(frontMonthContracts[0])) {
    return config.kalshiResolver;
  }
  const contractSymbol = frontMonthContracts[0];
  const pythSymbol = `Commodities.${contractSymbol}/USD`;
  return {
    ...config.kalshiResolver,
    underlying: pythSymbol,
    contractSymbol,
    pythSymbol,
  };
}

const SETTLEMENT_SOURCE_URLS = Object.freeze({
  cmeEquityIndex: 'https://www.cmegroup.com/markets/equities.html',
  cmeWti: 'https://www.cmegroup.com/markets/energy/crude-oil/light-sweet-crude.html',
  comexGold: 'https://www.cmegroup.com/markets/metals/precious/gold.html',
  comexSilver: 'https://www.cmegroup.com/markets/metals/precious/silver.html',
});

function settlementBasisUnavailable(reason = 'Authoritative settlement metadata is unavailable for this generation.') {
  return {
    status: 'unavailable',
    instrument: null,
    instrumentScope: null,
    method: null,
    observationAt: null,
    sourceName: null,
    sourceUrl: null,
    rulesUrl: null,
    reason,
  };
}

function verifiedSettlementBasis({
  instrument,
  instrumentScope = 'exact',
  method,
  observationAt,
  sourceName,
  sourceUrl,
  rulesUrl = null,
} = {}) {
  const normalizedObservationAt = isoTimestamp(observationAt);
  const normalizedSourceUrl = authoritativeHttpsUrl(sourceUrl);
  const normalizedRulesUrl = rulesUrl ? authoritativeHttpsUrl(rulesUrl) : null;
  if (!String(instrument || '').trim()
    || !String(method || '').trim()
    || !normalizedObservationAt
    || !String(sourceName || '').trim()
    || !normalizedSourceUrl
    || (rulesUrl && !normalizedRulesUrl)) {
    return settlementBasisUnavailable('The selected generation does not provide one complete authoritative settlement identity.');
  }
  return {
    status: 'verified',
    instrument: String(instrument).trim(),
    instrumentScope: instrumentScope === 'product' ? 'product' : 'exact',
    method: String(method).trim(),
    observationAt: normalizedObservationAt,
    sourceName: String(sourceName).trim(),
    sourceUrl: normalizedSourceUrl,
    rulesUrl: normalizedRulesUrl,
    reason: null,
  };
}

function partialSettlementBasis({
  instrument,
  method,
  observationAt,
  sourceName,
  sourceUrl,
  rulesUrl = null,
  reason,
} = {}) {
  const verified = verifiedSettlementBasis({
    instrument,
    instrumentScope: 'product',
    method,
    observationAt,
    sourceName,
    sourceUrl,
    rulesUrl,
  });
  if (verified.status !== 'verified' || !String(reason || '').trim()) {
    return settlementBasisUnavailable('The selected generation does not provide a verifiable product-level settlement identity.');
  }
  return {
    ...verified,
    status: 'partial',
    reason: String(reason).trim(),
  };
}

function authoritativeHttpsUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return url.toString();
  } catch (_error) {
    return null;
  }
}

function authoritativeHost(value, allowedHosts = []) {
  const normalized = authoritativeHttpsUrl(value);
  if (!normalized) return false;
  const hostname = new URL(normalized).hostname.toLowerCase();
  return allowedHosts.some((allowedHost) => (
    hostname === allowedHost || hostname.endsWith(`.${allowedHost}`)
  ));
}

function oneSettlementSource(event = {}) {
  const sources = Array.isArray(event.settlement_sources)
    ? event.settlement_sources
    : Array.isArray(event.settlementSources) ? event.settlementSources : [];
  if (sources.length !== 1 || !sources[0]?.name || !sources[0]?.url) return null;
  return { name: String(sources[0].name).trim(), url: String(sources[0].url).trim() };
}

function oneLineIdentity(lines = [], selector) {
  if (!Array.isArray(lines) || !lines.length) return null;
  const values = lines.map(selector).map((value) => String(value || '').trim()).filter(Boolean);
  return values.length === lines.length && new Set(values).size === 1 ? values[0] : null;
}

function lineRulesAgree(lines = [], predicate) {
  return Array.isArray(lines) && lines.length > 0 && lines.every((line) => predicate(
    `${line?.rulesPrimary || line?.rules_primary || ''} ${line?.rulesSecondary || line?.rules_secondary || ''}`.trim(),
    line,
  ));
}

function kalshiObservationAt(event = {}, lines = []) {
  const observationAt = oneLineIdentity(lines, (line) => (
    line?.customStrike?.strike_date
    || line?.customStrike?.strikeDate
    || line?.custom_strike?.strike_date
    || line?.closeAt
    || line?.close_time
  ));
  const normalized = isoTimestamp(observationAt);
  const eventObservation = isoTimestamp(
    event.strike_date
    || event.observationTime
    || event.closeTime
    || event.close_time,
  );
  return normalized && (!eventObservation || normalized === eventObservation) ? normalized : null;
}

function buildKalshiSettlementBasis(config, event = {}, lines = [], { wtiMapping = null } = {}) {
  const unavailableReason = 'Kalshi did not publish one consistent, authoritative settlement basis across this generation.';
  if (!config || !Array.isArray(lines) || !lines.length) return settlementBasisUnavailable(unavailableReason);
  const source = oneSettlementSource(event);
  const observationAt = kalshiObservationAt(event, lines);
  const rulesUrl = event.rules_url || event.rulesUrl || null;
  if (!source || !observationAt) return settlementBasisUnavailable(unavailableReason);

  if (config.id === 'cpi') {
    const eventTicker = String(event.event_ticker || event.eventTicker || '').trim().toUpperCase();
    const eventSeries = String(event.series_ticker || event.seriesTicker || '').trim().toUpperCase();
    const rulesMatch = lineRulesAgree(lines, (rules) => (
      /\bConsumer Price Index\b|\bCPI\b/i.test(rules)
      && /\btwelve months\b|\byear[ -]over[ -]year\b|\bYoY\b/i.test(rules)
      && /\bone-decimal place value\b|\bnearest tenth\b|\b0\.1\b/i.test(rules)
      && /\bBureau of Labor Statistics\b|\bBLS\b/i.test(rules)
    ));
    if (eventSeries !== CPI_SERIES_TICKER
      || !eventTicker.startsWith(`${CPI_SERIES_TICKER}-`)
      || !/Bureau of Labor Statistics|\bBLS\b/i.test(source.name)
      || !authoritativeHost(source.url, ['bls.gov'])
      || !rulesMatch) {
      return settlementBasisUnavailable(unavailableReason);
    }
    return verifiedSettlementBasis({
      instrument: 'All Items CPI-U YoY',
      method: 'Initial one-decimal year-over-year release',
      observationAt,
      sourceName: 'Bureau of Labor Statistics',
      sourceUrl: source.url || CPI_BLS_SOURCE_URL,
      rulesUrl,
    });
  }

  if (config.id === 'wti') {
    const mapping = wtiMapping || buildWtiSettlementMapping(event, lines);
    const instrument = String(mapping?.frontMonthContract || '').trim().toUpperCase();
    const mappingObservation = isoTimestamp(mapping?.observationTime);
    if (mapping?.status !== 'consistent_unverified'
      || !/^WBS\s+\d{2}[FGHJKMNQUVXZ]-ICE$/.test(instrument)
      || mappingObservation !== observationAt
      || !/^ICE$/i.test(source.name)
      || !authoritativeHost(source.url, ['theice.com', 'ice.com'])
      || !lineRulesAgree(lines, (rules) => /\bdaily settlement price\b/i.test(rules))) {
      return settlementBasisUnavailable(unavailableReason);
    }
    return verifiedSettlementBasis({
      instrument,
      method: 'Official daily settlement',
      observationAt,
      sourceName: 'ICE',
      sourceUrl: source.url,
      rulesUrl,
    });
  }

  const pythIdentity = ['gold', 'silver'].includes(config.id)
    ? PYTH_RESOLVER_IDENTITIES[config.id]
    : null;
  if (pythIdentity) {
    const publishedSymbol = pythExplorerSymbol(source.url);
    if (!/pyth/i.test(source.name)
      || !authoritativeHost(source.url, PYTH_AUTHORITATIVE_HOSTS)
      || publishedSymbol !== pythIdentity.symbol
      || !lineRulesAgree(lines, (rules) => (
        /\b1-minute candlestick\b/i.test(rules)
        && /\bclose price\b/i.test(rules)
        && pythIdentity.assetPattern.test(rules)
      ))) {
      return settlementBasisUnavailable(unavailableReason);
    }
    return verifiedSettlementBasis({
      instrument: pythIdentity.symbol,
      method: '1-minute close',
      observationAt,
      sourceName: 'Pyth',
      sourceUrl: source.url,
      rulesUrl,
    });
  }

  if (config.id === 'brent') {
    const contractSymbol = String(oneLineIdentity(lines, (line) => (
      line?.customStrike?.front_month_contract
      || line?.customStrike?.frontMonthContract
      || line?.custom_strike?.front_month_contract
    )) || '').toUpperCase();
    const publishedSymbol = pythExplorerSymbol(source.url);
    const datedContract = /^BRENT[FGHJKMNQUVXZ]\d{1,2}$/.test(contractSymbol)
      ? contractSymbol
      : null;
    const instrument = datedContract
      ? `Commodities.${datedContract}/USD`
      : PYTH_RESOLVER_IDENTITIES.brent.symbol;
    const symbolMatches = !publishedSymbol || publishedSymbol === instrument;
    const rulesMatch = lineRulesAgree(lines, (rules) => (
      /\b1-minute(?:\s+candlestick)?\b/i.test(rules)
      && /\bclose price\b/i.test(rules)
      && PYTH_RESOLVER_IDENTITIES.brent.assetPattern.test(rules)
      && (!datedContract || new RegExp(`\\b${datedContract}\\b`, 'i').test(rules))
    ));
    if ((!datedContract && !['', 'N/A'].includes(contractSymbol))
      || !symbolMatches
      || !/pyth/i.test(source.name)
      || !authoritativeHost(source.url, PYTH_AUTHORITATIVE_HOSTS)
      || !rulesMatch) {
      return settlementBasisUnavailable(unavailableReason);
    }
    return verifiedSettlementBasis({
      instrument,
      method: '1-minute close',
      observationAt,
      sourceName: 'Pyth',
      sourceUrl: source.url,
      rulesUrl,
    });
  }

  if (config.id === 'bitcoin') {
    if (!/CF\s*Benchmarks/i.test(source.name)
      || !authoritativeHost(source.url, ['cfbenchmarks.com'])
      || !lineRulesAgree(lines, (rules) => (
        /\b(?:BRTI|Bitcoin\s+Real-Time\s+Index)\b/i.test(rules)
        && /\b(?:60|sixty)\b[^.]{0,100}\b(?:seconds?|RTI\s+prices?|prices?|values?|samples?|observations?)\b/i.test(rules)
        && /\baverage\b/i.test(rules)
        && /\b(?:final|last)\s+(?:one\s+)?minute\b|\bbefore\s+\d{1,2}(?::\d{2})?\s*(?:AM|PM)\b/i.test(rules)
      ))) {
      return settlementBasisUnavailable(unavailableReason);
    }
    return verifiedSettlementBasis({
      instrument: 'BRTI',
      method: 'Final-minute 60-sample average',
      observationAt,
      sourceName: 'CF Benchmarks',
      sourceUrl: source.url,
      rulesUrl,
    });
  }

  return settlementBasisUnavailable('No authoritative settlement-basis validator exists for this Kalshi product.');
}

function officialForecastTermsUrl(value, productCode) {
  const normalized = authoritativeHttpsUrl(value);
  if (!normalized) return false;
  const url = new URL(normalized);
  return url.hostname.toLowerCase() === 'data.forecastex.com'
    && url.pathname.toLowerCase() === `/regulatory/${String(productCode || '').toLowerCase()}termsandconditions.pdf`
    && !url.search
    && !url.hash;
}

function buildForecastSettlementBasis(generation, config) {
  const lines = Array.isArray(generation?.lines) ? generation.lines : [];
  const productCode = String(config?.forecastExProduct || lines[0]?.productId || '').toUpperCase();
  const unavailableReason = 'ForecastEx did not publish one consistent, authoritative settlement basis across this generation.';
  if (!generation || !config || !lines.length || !productCode) return settlementBasisUnavailable(unavailableReason);
  const rulesUrl = oneLineIdentity(lines, (line) => line?.rulesUrl || line?.exchangeSpecUrl);
  if (!rulesUrl || !officialForecastTermsUrl(rulesUrl, productCode)) {
    return settlementBasisUnavailable(unavailableReason);
  }

  let identity = null;
  try {
    if (productCode === 'FES') identity = validateFesGeneration(lines);
    else if (productCode === 'FNQ') identity = validateFnqGeneration(lines);
    else if (['METLG', 'METLS', 'COMCO'].includes(productCode)) {
      identity = validateForecastCommodityGeneration(lines, productCode);
    }
  } catch (_error) {
    identity = null;
  }
  const observationAt = isoTimestamp(generation.closeAt || lines[0]?.lastTradeDate || lines[0]?.closeAt);

  if (productCode === 'COMCO' && !identity) {
    const genericDefinitionVerified = lines.every((line) => (
      /\bWTI\b/i.test(String(line?.question || ''))
      && /\b(?:future|futures)\b/i.test(String(line?.question || ''))
      && /\bsettle\b/i.test(String(line?.question || ''))
    ));
    if (!genericDefinitionVerified) return settlementBasisUnavailable(unavailableReason);
    return verifiedSettlementBasis({
      instrument: 'WTI Crude Oil Futures',
      method: 'Official front-month daily settlement',
      observationAt,
      sourceName: 'CME',
      sourceUrl: SETTLEMENT_SOURCE_URLS.cmeWti,
      rulesUrl,
    });
  }

  const commodityProduct = FORECAST_COMMODITY_PRODUCTS[productCode] || null;
  if (commodityProduct && !identity) {
    const assetPattern = new RegExp(`\\b${commodityProduct.assetLabel}\\b`, 'i');
    const genericDefinitionVerified = lines.every((line) => {
      const question = String(line?.question || line?.title || '');
      return assetPattern.test(question)
        && /\b(?:price|settlement|settle)\b/i.test(question)
        && /\b(?:exceed|above|below|between|range)\b/i.test(question);
    });
    if (!genericDefinitionVerified) return settlementBasisUnavailable(unavailableReason);
    const sourceUrl = productCode === 'METLG'
      ? SETTLEMENT_SOURCE_URLS.comexGold
      : SETTLEMENT_SOURCE_URLS.comexSilver;
    return partialSettlementBasis({
      instrument: commodityProduct.productInstrument,
      method: 'Official front-month daily settlement',
      observationAt,
      sourceName: commodityProduct.sourceName,
      sourceUrl,
      rulesUrl,
      reason: `The active ${productCode} catalog verifies the product-level settlement method but omits the exact futures contract month.`,
    });
  }

  const symbol = String(identity?.resolverSymbol || '').trim().toUpperCase();
  const identityMatchesGeneration = (!generation.resolverSymbol || symbol === String(generation.resolverSymbol).toUpperCase())
    && (!generation.underlyingContractMonth
      || String(identity?.underlyingContractMonth || '') === String(generation.underlyingContractMonth));
  if (!identity || !symbol || !identityMatchesGeneration) return settlementBasisUnavailable(unavailableReason);

  const definition = {
    FES: { symbolPattern: /^ES[HMUZ]\d{2}$/, sourceName: 'CME', sourceUrl: SETTLEMENT_SOURCE_URLS.cmeEquityIndex },
    FNQ: { symbolPattern: /^NQ[HMUZ]\d{2}$/, sourceName: 'CME', sourceUrl: SETTLEMENT_SOURCE_URLS.cmeEquityIndex },
    METLG: { symbolPattern: FORECAST_COMMODITY_PRODUCTS.METLG.symbolPattern, sourceName: 'COMEX', sourceUrl: SETTLEMENT_SOURCE_URLS.comexGold },
    METLS: { symbolPattern: FORECAST_COMMODITY_PRODUCTS.METLS.symbolPattern, sourceName: 'COMEX', sourceUrl: SETTLEMENT_SOURCE_URLS.comexSilver },
    COMCO: { symbolPattern: /^CL[FGHJKMNQUVXZ]\d{2}$/, sourceName: 'CME', sourceUrl: SETTLEMENT_SOURCE_URLS.cmeWti },
  }[productCode];
  if (!definition || !definition.symbolPattern.test(symbol)) return settlementBasisUnavailable(unavailableReason);
  return verifiedSettlementBasis({
    instrument: symbol,
    method: 'Official daily settlement',
    observationAt,
    sourceName: definition.sourceName,
    sourceUrl: definition.sourceUrl,
    rulesUrl,
  });
}

function kalshiGenerationSummary(candidate, config, fetchedAt) {
  const lines = candidate.markets.map((market) => normalizeKalshiLine(market, fetchedAt, null)).filter(Boolean);
  const event = candidate.event || {};
  const resolver = eventSpecificKalshiResolver(config, lines);
  return {
    id: `kalshi:${candidate.generationId}`,
    generationId: candidate.generationId,
    venueId: 'kalshi',
    venueLabel: 'Kalshi',
    seriesTicker: candidate.seriesTicker,
    productCode: candidate.seriesTicker,
    cadence: candidate.cadence,
    title: event.title || config.fullLabel,
    subtitle: event.subtitle || null,
    category: event.category || null,
    measuredPeriod: isoTimestamp(event.strike_date) || candidate.closeTime,
    openTime: isoTimestamp(event.open_time) || lines.map((line) => line.openAt).filter(Boolean).sort()[0] || null,
    closeTime: candidate.closeTime,
    expirationTime: lines.map((line) => line.expirationAt).filter(Boolean).sort()[0] || candidate.closeTime,
    observationTime: isoTimestamp(event.strike_date) || candidate.closeTime,
    resolutionTime: isoTimestamp(event.settlement_time) || null,
    payoutTime: isoTimestamp(event.payout_time) || null,
    timezone: 'America/New_York',
    status: 'open',
    lineCount: lines.length,
    lines: lines.map(catalogLine),
    openInterest: sumPublishedMetric(lines, 'openInterest'),
    volume24h: sumPublishedMetric(lines, 'volume24h'),
    totalVolume: sumPublishedMetric(lines, 'totalVolume'),
    liquidity: sumPublishedMetric(lines, 'liquidity'),
    availableOnBrokers: event.available_on_brokers === true,
    mutuallyExclusive: event.mutually_exclusive === true,
    settlementSources: Array.isArray(event.settlement_sources) ? event.settlement_sources : [],
    rulesUrl: event.rules_url || null,
    resolverSymbol: resolver?.pythSymbol || null,
    resolverContractMonth: resolver?.contractSymbol || null,
    catalogStatus: lines.length ? 'live' : 'unavailable',
    bookStatus: 'not_loaded',
    quotedLineCount: 0,
    executableLineCount: 0,
    source: 'kalshi_trade_api_v2_catalog',
    asOf: fetchedAt,
    evidence: {
      metadata: { source: 'kalshi_trade_api_v2_catalog', asOf: fetchedAt, fit: 'exact', executable: false },
      activity: { source: 'kalshi_trade_api_v2_catalog', asOf: fetchedAt, fit: 'exact', executable: false },
    },
  };
}

function buildBookQuality(lines = []) {
  const liveLines = lines.filter((line) => line?.directNative === true);
  const executableLines = liveLines.filter((line) => (
    directPair(line.yesBid, line.yesAsk)
    && directPair(line.noBid, line.noAsk)
    && Number(line.yesBidSize) > 0
    && Number(line.yesAskSize) > 0
    && Number(line.noBidSize) > 0
    && Number(line.noAskSize) > 0
  ));
  const spreads = executableLines.flatMap((line) => [
    line.yesAsk - line.yesBid,
    line.noAsk - line.noBid,
  ]).filter(Number.isFinite).sort((left, right) => left - right);
  const medianSpread = spreads.length
    ? spreads.length % 2
      ? spreads[Math.floor(spreads.length / 2)]
      : (spreads[spreads.length / 2 - 1] + spreads[spreads.length / 2]) / 2
    : null;
  return {
    eligible: lines.length > 0 && executableLines.length === lines.length,
    lineCount: lines.length,
    directLineCount: liveLines.filter((line) => (
      [line.yesBid, line.yesAsk, line.noBid, line.noAsk].some((value) => finiteNumber(value, { min: 0, max: 1 }) != null)
    )).length,
    executableLineCount: executableLines.length,
    displayedDepth: executableLines.reduce((sum, line) => (
      sum + Number(line.yesBidSize) + Number(line.yesAskSize) + Number(line.noBidSize) + Number(line.noAskSize)
    ), 0),
    displayedAskDepth: executableLines.reduce((sum, line) => sum + Number(line.yesAskSize) + Number(line.noAskSize), 0),
    medianSpread,
  };
}

function autoVenueComparator(left, right) {
  const leftClose = Date.parse(left.contracts?.event?.closeTime || '');
  const rightClose = Date.parse(right.contracts?.event?.closeTime || '');
  const leftOi = finiteNumber(left.activity?.selectedGenerationOpenInterest?.value, { min: 0 }) || 0;
  const rightOi = finiteNumber(right.activity?.selectedGenerationOpenInterest?.value, { min: 0 }) || 0;
  return (Number.isFinite(leftClose) ? leftClose : Number.POSITIVE_INFINITY)
      - (Number.isFinite(rightClose) ? rightClose : Number.POSITIVE_INFINITY)
    || rightOi - leftOi
    || `${left.id}:${left.contracts?.event?.ticker || ''}`.localeCompare(`${right.id}:${right.contracts?.event?.ticker || ''}`);
}

function bestDirectField(lines, field, sizeField, preferLower) {
  return lines
    .filter(({ line }) => finiteNumber(line?.[field], { min: 0, max: 1 }) != null && Number(line?.[sizeField]) > 0)
    .sort((left, right) => {
      const priceDelta = Number(left.line[field]) - Number(right.line[field]);
      if (priceDelta) return preferLower ? priceDelta : -priceDelta;
      const sizeDelta = Number(right.line[sizeField]) - Number(left.line[sizeField]);
      if (sizeDelta) return sizeDelta;
      const side = field.startsWith('yes') ? 'yes' : 'no';
      const leftSpread = Number(left.line[`${side}Ask`]) - Number(left.line[`${side}Bid`]);
      const rightSpread = Number(right.line[`${side}Ask`]) - Number(right.line[`${side}Bid`]);
      const spreadDelta = (Number.isFinite(leftSpread) ? leftSpread : Number.POSITIVE_INFINITY)
        - (Number.isFinite(rightSpread) ? rightSpread : Number.POSITIVE_INFINITY);
      if (spreadDelta) return spreadDelta;
      return Date.parse(right.line.updatedAt || '') - Date.parse(left.line.updatedAt || '');
    })[0] || null;
}

function isFreshExecutableVenue(venue, nowMs) {
  const asOfMs = Date.parse(venue?.contracts?.asOf || '');
  const expiresMs = Date.parse(venue?.contracts?.expiresAt || '');
  return venue?.brokerRoutable === true
    && venue?.bookQuality?.eligible === true
    && venue?.book?.refreshing !== true
    && venue?.book?.refreshFailed !== true
    && venue?.equivalenceFingerprint
    && venue?.contracts?.status === 'available'
    && String(venue?.contracts?.event?.status || '').toLowerCase() === 'open'
    && Number.isFinite(asOfMs)
    && asOfMs <= nowMs + 5_000
    && Number.isFinite(expiresMs)
    && expiresMs >= nowMs
    && !FORBIDDEN_PROVENANCE.test(String(venue?.contracts?.source || ''));
}

function mergeExactVenueContracts(venues = [], nowMs = Date.now()) {
  const eligible = venues.filter((venue) => isFreshExecutableVenue(venue, nowMs));
  const fingerprints = new Set(eligible.map((venue) => venue.equivalenceFingerprint));
  if (eligible.length < 2 || fingerprints.size !== 1) return null;
  const byGeometry = new Map();
  eligible.forEach((venue) => {
    venue.contracts.lines.forEach((line) => {
      const key = `${line.comparator || '>'}:${line.lowerBound ?? ''}:${line.upperBound ?? ''}:${line.threshold}`;
      const entries = byGeometry.get(key) || [];
      entries.push({ venue, line });
      byGeometry.set(key, entries);
    });
  });
  const lines = [...byGeometry.values()].map((entries) => {
    if (entries.length !== eligible.length) return null;
    const template = entries[0].line;
    const fields = {
      yesAsk: bestDirectField(entries, 'yesAsk', 'yesAskSize', true),
      noAsk: bestDirectField(entries, 'noAsk', 'noAskSize', true),
      yesBid: bestDirectField(entries, 'yesBid', 'yesBidSize', false),
      noBid: bestDirectField(entries, 'noBid', 'noBidSize', false),
    };
    if (!fields.yesAsk || !fields.noAsk || !fields.yesBid || !fields.noBid) return null;
    return {
      ...template,
      ticker: entries.map(({ line }) => line.ticker).join('|'),
      yesBid: fields.yesBid.line.yesBid,
      yesBidSize: fields.yesBid.line.yesBidSize,
      yesAsk: fields.yesAsk.line.yesAsk,
      yesAskSize: fields.yesAsk.line.yesAskSize,
      noBid: fields.noBid.line.noBid,
      noBidSize: fields.noBid.line.noBidSize,
      noAsk: fields.noAsk.line.noAsk,
      noAskSize: fields.noAsk.line.noAskSize,
      updatedAt: [fields.yesBid, fields.yesAsk, fields.noBid, fields.noAsk]
        .map((entry) => entry.line.updatedAt).filter(Boolean).sort()[0] || null,
      source: 'exact_contract_best_native_quotes',
      quoteSources: Object.fromEntries(Object.entries(fields).map(([field, entry]) => [field, entry.venue.id])),
      derivedFields: [],
      directNative: true,
    };
  }).filter(Boolean).sort((left, right) => left.threshold - right.threshold);
  if (!lines.length) return null;
  const asOf = eligible.map((venue) => venue.contracts.asOf).filter(Boolean).sort()[0] || null;
  return {
    status: 'available',
    source: 'exact_contract_best_native_quotes',
    asOf,
    expiresAt: eligible.map((venue) => venue.contracts.expiresAt).filter(Boolean).sort()[0] || null,
    event: eligible[0].contracts.event,
    lines,
    comparedVenues: eligible.map((venue) => venue.id),
  };
}

function selectAutoVenue(venuesById = {}, nowMs = Date.now()) {
  const venues = Object.values(venuesById).filter(Boolean);
  const ranked = venues.filter((venue) => isFreshExecutableVenue(venue, nowMs)).sort(autoVenueComparator);
  const selected = ranked[0] || null;
  if (!selected) {
    return {
      status: 'unavailable',
      mode: 'none',
      venueId: null,
      label: 'No executable venue',
      reason: 'No venue has a fresh complete native book with positive displayed size.',
      contracts: unavailable('No verified executable contract ladder is available.', { event: null, lines: [] }),
    };
  }
  return {
    status: 'available',
    mode: 'most_executable',
    venueId: selected.id,
    generationId: selected.generationId || selected.contracts?.event?.generationId || selected.contracts?.event?.ticker || null,
    label: `${selected.label} live book`,
    reason: 'Auto selected the nearest-closing open generation with a complete fresh native book, then exact-generation OI and stable venue identity.',
    contracts: selected.contracts,
  };
}

function annotateAutoRefreshFailure(autoSelection, venues) {
  const refreshFailedVenueIds = Object.values(venues)
    .filter((venue) => venue.contracts?.refreshFailed === true || venue.catalog?.refreshFailed === true)
    .map((venue) => venue.id);
  if (autoSelection.status !== 'unavailable' || !refreshFailedVenueIds.length) return autoSelection;
  return {
    ...autoSelection,
    refreshFailedVenueIds,
    contracts: refreshFailure(
      autoSelection.contracts,
      refreshFailedVenueIds.map((id) => venues[id]?.contracts?.refreshIssue || venues[id]?.catalog?.refreshIssue).filter(Boolean).join('; '),
    ),
  };
}

function buildKalshiVenue(selected, config, requestDate, orderbooks = null) {
  const fetchedAt = requestDate.toISOString();
  const configuredSeries = kalshiSeriesTickers(config);
  const familyLabel = configuredSeries.join('/');
  if (!selected) {
    const catalog = unavailable(`No current open ${familyLabel} event is available.`, { event: null, lines: [] });
    const book = unavailable(`No current ${familyLabel} native book is available.`, { event: null, lines: [] });
    return {
      id: 'kalshi', label: 'Kalshi', status: 'unavailable', resolver: config.kalshiResolver,
      settlementBasis: settlementBasisUnavailable(`No current ${familyLabel} generation is available to verify.`),
      equivalenceFingerprint: null, brokerRoutable: false, catalog, book, contracts: book,
      bookQuality: buildBookQuality([]),
    };
  }
  const lines = selected.markets.map((market) => normalizeKalshiLine(
    market,
    fetchedAt,
    nativeOrderbookForTicker(orderbooks, market.ticker),
  )).filter(Boolean)
    .sort((left, right) => left.threshold - right.threshold);
  const bookQuality = buildBookQuality(lines);
  // Kalshi's generic "available on brokers" flag is not evidence that IBKR
  // can route this exact event contract. Keep Gold display-only until that
  // execution path is independently qualified.
  const brokerRoutable = ['cpi', 'gold'].includes(config.id)
    ? false
    : selected.event.available_on_brokers === true;
  const seriesTicker = selected.seriesTicker || selected.event.series_ticker || config.seriesTicker;
  const resolver = eventSpecificKalshiResolver(config, lines);
  const settlementBasis = buildKalshiSettlementBasis(config, selected.event, lines, {
    wtiMapping: config.id === 'wti'
      ? buildWtiSettlementMapping(selected.event, selected.markets)
      : null,
  });
  const event = {
    ticker: selected.event.event_ticker,
    generationId: selected.generationId,
    venueId: 'kalshi',
    seriesTicker,
    productCode: seriesTicker,
    cadence: selected.cadence,
    title: selected.event.title || config.fullLabel,
    subtitle: selected.event.subtitle || null,
    category: selected.event.category || null,
    status: 'open',
    openTime: isoTimestamp(selected.event.open_time) || lines.map((line) => line.openAt).filter(Boolean).sort()[0] || null,
    closeTime: selected.closeTime,
    expirationTime: lines.map((line) => line.expirationAt).filter(Boolean).sort()[0] || selected.closeTime,
    observationTime: isoTimestamp(selected.event.strike_date) || selected.closeTime,
    resolutionAt: isoTimestamp(selected.event.settlement_time) || null,
    payoutAt: isoTimestamp(selected.event.payout_time) || null,
    timezone: 'America/New_York',
    settlementSources: Array.isArray(selected.event.settlement_sources) ? selected.event.settlement_sources : [],
    rulesUrl: selected.event.rules_url || null,
    resolverSymbol: resolver?.pythSymbol || null,
    resolverContractMonth: resolver?.contractSymbol || null,
    mutuallyExclusive: selected.event.mutually_exclusive === true,
    availableOnBrokers: brokerRoutable,
    brokerRoutable,
  };
  const catalogLines = lines.map(catalogLine);
  const catalog = catalogLines.length ? {
    status: 'available',
    source: 'kalshi_trade_api_v2_catalog',
    asOf: fetchedAt,
    expiresAt: selected.closeTime,
    seriesTicker,
    event,
    lines: catalogLines,
    reason: null,
  } : unavailable(`No valid open ${seriesTicker} lines are available.`, { event: null, lines: [] });
  const anyNative = lines.some((line) => line.directNative);
  const book = lines.length ? {
    status: bookQuality.eligible ? 'available' : 'partial',
    source: anyNative ? 'kalshi_batch_orderbooks_v2' : null,
    asOf: anyNative ? fetchedAt : null,
    expiresAt: anyNative ? new Date(requestDate.getTime() + CONTRACT_MAX_AGE_MS).toISOString() : null,
    seriesTicker,
    event,
    lines,
    reason: bookQuality.eligible
      ? null
      : anyNative
        ? 'The current Kalshi native book is incomplete or lacks positive displayed size and is not executable in Auto.'
        : 'The current Kalshi catalog is available, but no native batch orderbook was verified.',
  } : unavailable(`No current ${seriesTicker} native book is available.`, { event, lines: [] });
  if (!anyNative) book.status = 'unavailable';
  return {
    id: 'kalshi',
    label: 'Kalshi',
    status: book.status === 'available' ? 'available' : catalog.status === 'available' ? 'partial' : 'unavailable',
    resolver,
    settlementBasis,
    equivalenceFingerprint: buildVenueFingerprint(resolver, event, catalogLines),
    brokerRoutable,
    catalog,
    book,
    contracts: book,
    bookQuality,
    generationId: selected.generationId,
    activity: {
      selectedGenerationOpenInterest: {
        value: sumPublishedMetric(lines, 'openInterest'),
        unit: 'contracts',
        scope: 'selected_generation_sum',
        source: 'kalshi_trade_api_v2_catalog',
        asOf: fetchedAt,
      },
      volume24h: {
        value: sumPublishedMetric(lines, 'volume24h'),
        unit: 'contracts',
        scope: 'selected_generation_sum',
        source: 'kalshi_trade_api_v2_catalog',
        asOf: fetchedAt,
      },
      totalVolume: {
        value: sumPublishedMetric(lines, 'totalVolume'),
        unit: 'contracts',
        scope: 'selected_generation_sum',
        source: 'kalshi_trade_api_v2_catalog',
        asOf: fetchedAt,
      },
    },
    capabilities: {
      book: anyNative ? 'native_bid_depth' : 'no_live_book',
      activity: 'published_contract_metrics',
      openInterest: 'published_contract_line',
    },
  };
}

function forecastGenerationKey(contractId) {
  const match = String(contractId || '').match(/^([A-Z0-9]+_\d{6})_/i);
  return match?.[1]?.toUpperCase() || null;
}

function forecastGenerationMatchesClose(generationKey, closeAt) {
  const match = String(generationKey || '').match(/^[A-Z0-9]+_(\d{2})(\d{2})(\d{2})$/);
  const closeMs = Date.parse(closeAt || '');
  if (!match || !Number.isFinite(closeMs)) return false;
  return match.slice(1).join('') === formatInTimeZone(new Date(closeMs), 'America/Chicago', 'MMddyy');
}

function forecastLineStrike(line) {
  return finiteNumber(line?.strike ?? line?.threshold);
}

function forecastLineActivity(line) {
  return Math.max(
    finiteNumber(line?.volume24h, { min: 0 }) || 0,
    finiteNumber(line?.openInterest, { min: 0 }) || 0,
  );
}

function selectForecastContractUniverse(lines = [], spotValue = null, {
  corePerSide = FES_CORE_LINES_PER_SIDE,
  extraThreshold = FES_LIQUID_EXTRA_THRESHOLD,
  extraPerSide = FES_LIQUID_EXTRAS_PER_SIDE,
  coldStartMaximum = FES_COLD_START_MAX_LINES,
} = {}) {
  const ordered = (Array.isArray(lines) ? lines : [])
    .map((line, originalIndex) => ({
      line,
      originalIndex,
      strike: forecastLineStrike(line),
      activity: forecastLineActivity(line),
    }))
    .filter(({ strike }) => strike != null)
    .sort((left, right) => left.strike - right.strike || left.originalIndex - right.originalIndex);
  const spot = finiteNumber(spotValue);
  if (spot == null) {
    return ordered
      .filter(({ activity }) => activity >= extraThreshold)
      .sort((left, right) => right.activity - left.activity || left.strike - right.strike)
      .slice(0, coldStartMaximum)
      .sort((left, right) => left.strike - right.strike)
      .map(({ line }) => line);
  }

  const below = ordered.filter(({ strike }) => strike < spot);
  const exact = ordered.filter(({ strike }) => strike === spot);
  const above = ordered.filter(({ strike }) => strike > spot);
  const coreBelow = below.slice(-corePerSide);
  const coreAbove = above.slice(0, corePerSide);
  const core = new Set([...coreBelow, ...exact, ...coreAbove].map(({ originalIndex }) => originalIndex));
  const rankExtras = (candidates) => candidates
    .filter(({ originalIndex, activity }) => !core.has(originalIndex) && activity >= extraThreshold)
    .sort((left, right) => (
      right.activity - left.activity
      || Math.abs(left.strike - spot) - Math.abs(right.strike - spot)
      || left.strike - right.strike
    ))
    .slice(0, extraPerSide);
  const selected = [
    ...coreBelow,
    ...exact,
    ...coreAbove,
    ...rankExtras(below),
    ...rankExtras(above),
  ];
  return [...new Map(selected.map((entry) => [entry.originalIndex, entry])).values()]
    .sort((left, right) => left.strike - right.strike || left.originalIndex - right.originalIndex)
    .map(({ line }) => line);
}

function listForecastGenerations(lines = [], productCode, nowMs = Date.now()) {
  const groups = new Map();
  (Array.isArray(lines) ? lines : []).forEach((line) => {
    if (line?.productId !== productCode) return;
    const key = forecastGenerationKey(line.contractId);
    if (!key) return;
    const closeAt = isoTimestamp(line.lastTradeDate || line.expirationDate);
    const entries = groups.get(key) || [];
    entries.push({ ...line, closeAt });
    groups.set(key, entries);
  });
  return [...groups.entries()].map(([generationKey, entries]) => {
    const closeTimes = [...new Set(entries.map((line) => line.closeAt))];
    let fesIdentity = null;
    let commodityIdentity = null;
    let fnqIdentity = null;
    if (productCode === 'FES') {
      try {
        fesIdentity = validateFesGeneration(entries);
      } catch (_error) {
        return null;
      }
    } else if (['COMCO', 'METLG', 'METLS'].includes(productCode)) {
      try {
        commodityIdentity = validateForecastCommodityGeneration(entries, productCode);
      } catch (_error) {
        // Keep the official current catalog visible, but withhold an exact
        // reference unless every line proves the same dated resolver.
        commodityIdentity = null;
      }
    } else if (productCode === 'FNQ') {
      try {
        fnqIdentity = validateFnqGeneration(entries);
      } catch (_error) {
        // Keep the official catalog, but never invent a dated NQ resolver.
        fnqIdentity = null;
      }
    }
    const resolverIdentity = fesIdentity || commodityIdentity || fnqIdentity;
    const generationDate = generationKey.match(/^[A-Z0-9]+_(\d{2})(\d{2})(\d{2})$/);
    return {
      generationKey,
      generationId: generationKey,
      closeAt: closeTimes.length === 1 ? closeTimes[0] : null,
      lines: fesIdentity?.lines || entries,
      cadence: inferGenerationCadence({
        seriesTicker: productCode,
        title: entries[0]?.eventDisplayName || entries[0]?.question,
        closeTime: closeTimes.length === 1 ? closeTimes[0] : null,
      }),
      ...(resolverIdentity ? {
        eventDate: resolverIdentity?.eventDate || (generationDate
          ? `20${generationDate[3]}-${generationDate[1]}-${generationDate[2]}`
          : null),
        resolverSymbol: resolverIdentity.resolverSymbol,
        underlyingContractMonth: resolverIdentity.underlyingContractMonth,
        resolverMonthLabel: resolverIdentity.resolverMonthLabel,
        resolverInstrument: resolverIdentity.instrument || null,
        resolutionAt: resolverIdentity.resolutionAt,
        payoutAt: resolverIdentity.payoutAt,
      } : {}),
    };
  }).filter(Boolean).filter((generation) => (
    generation.closeAt
    && Date.parse(generation.closeAt) > nowMs
    && forecastGenerationMatchesClose(generation.generationKey, generation.closeAt)
  ))
    .sort((left, right) => (
      Date.parse(left.closeAt) - Date.parse(right.closeAt)
      || Number(right.lines.reduce((sum, line) => sum + Number(line.openInterest || 0), 0))
        - Number(left.lines.reduce((sum, line) => sum + Number(line.openInterest || 0), 0))
      || left.generationKey.localeCompare(right.generationKey)
    ));
}

function selectForecastGeneration(lines = [], productCode, nowMs = Date.now(), generationId = null) {
  const generations = listForecastGenerations(lines, productCode, nowMs);
  if (!generations.length) return null;
  if (generationId) {
    return generations.find((generation) => generation.generationId === String(generationId).toUpperCase()) || null;
  }
  const firstClose = generations[0].closeAt;
  return generations.filter((generation) => generation.closeAt === firstClose).length === 1
    ? generations[0]
    : null;
}

function forecastGenerationSummary(generation, fetchedAt) {
  const first = generation.lines[0] || {};
  return {
    id: `forecastex:${generation.generationId}`,
    generationId: generation.generationId,
    venueId: 'forecastex',
    venueLabel: 'ForecastEx',
    seriesTicker: generation.generationKey,
    productCode: first.productId || generation.generationKey.split('_')[0],
    cadence: generation.cadence,
    title: first.eventDisplayName || first.question || generation.generationKey,
    subtitle: first.question || null,
    category: first.category || null,
    measuredPeriod: generation.eventDate || generation.closeAt,
    openTime: null,
    closeTime: generation.closeAt,
    expirationTime: first.expirationDate || generation.closeAt,
    observationTime: generation.closeAt,
    resolutionTime: generation.resolutionAt || first.expirationDate || null,
    payoutTime: generation.payoutAt || first.payoutDate || null,
    timezone: 'America/Chicago',
    status: 'open',
    lineCount: generation.lines.length,
    lines: generation.lines.map((line) => catalogLine(normalizeForecastLiveLines(
      { lines: [line] },
      null,
      fetchedAt,
      new Map(),
    )[0])).filter(Boolean),
    openInterest: sumPublishedMetric(generation.lines, 'openInterest'),
    volume24h: null,
    totalVolume: null,
    liquidity: null,
    availableOnBrokers: true,
    mutuallyExclusive: false,
    settlementSources: [],
    rulesUrl: first.rulesUrl || null,
    resolverSymbol: generation.resolverSymbol || first.resolverSymbol || null,
    resolverContractMonth: generation.underlyingContractMonth || first.underlyingContractMonth || null,
    resolverInstrument: generation.resolverInstrument || first.resolverInstrument || null,
    catalogStatus: generation.lines.length ? 'live' : 'unavailable',
    bookStatus: 'not_loaded',
    quotedLineCount: 0,
    executableLineCount: 0,
    source: 'forecastex_official_contracts',
    asOf: fetchedAt,
    evidence: {
      metadata: { source: 'forecastex_official_contracts', asOf: fetchedAt, fit: 'exact', executable: false },
      activity: { source: 'forecastex_official_contracts', asOf: fetchedAt, fit: 'exact', executable: false },
    },
  };
}

function aggregateForecastActivity(snapshots = [], generation, nowMs = Date.now()) {
  const cutoff = nowMs - 24 * 60 * 60_000;
  const allowed = new Set((generation?.lines || []).map((line) => String(line.contractId).toUpperCase()));
  const byContract = new Map();
  snapshots.flatMap((snapshot) => Array.isArray(snapshot?.executions) ? snapshot.executions : [])
    .filter((execution) => allowed.has(String(execution.contractId).toUpperCase()))
    .forEach((execution) => {
      const pairMs = Date.parse(execution.pairTime || '');
      if (!Number.isFinite(pairMs) || pairMs > nowMs + 5_000) return;
      const key = String(execution.contractId).toUpperCase();
      const current = byContract.get(key) || {
        volume24h: 0,
        observed24h: false,
        lastTrade: null,
        lastYesPrice: null,
        lastNoPrice: null,
        lastTradeAt: null,
      };
      if (pairMs >= cutoff) {
        current.volume24h += Number(execution.quantity || 0);
        current.observed24h = true;
      }
      if (!current.lastTradeAt || pairMs >= Date.parse(current.lastTradeAt)) {
        current.lastTrade = execution.yesPrice;
        current.lastYesPrice = execution.yesPrice;
        current.lastNoPrice = execution.noPrice;
        current.lastTradeAt = execution.pairTime;
      }
      byContract.set(key, current);
    });
  return byContract;
}

function normalizeForecastLiveLines(generation, liveSnapshot, fetchedAt, activityByContract = new Map()) {
  const live = Array.isArray(liveSnapshot?.lines) ? liveSnapshot.lines : [];
  const liveByContract = new Map(live.map((line) => [String(line.contractId || '').toUpperCase(), line]));
  return generation.lines.map((publicLine) => {
    const quote = liveByContract.get(String(publicLine.contractId).toUpperCase()) || null;
    const quoteAtMs = Date.parse(quote?.updatedAt || '');
    const fetchedAtMs = Date.parse(fetchedAt || '');
    const verified = liveSnapshot?.status === 'available'
      && quote?.directNative === true && quote?.dataType === 'live'
      && !FORBIDDEN_PROVENANCE.test(String(quote?.provenance || ''))
      && Number.isFinite(quoteAtMs)
      && Number.isFinite(fetchedAtMs)
      && quoteAtMs >= fetchedAtMs - CONTRACT_MAX_AGE_MS
      && quoteAtMs <= fetchedAtMs + 5_000;
    const yesBid = verified ? finiteNumber(quote.yesBid, { min: 0, max: 1 }) : null;
    const yesAsk = verified ? finiteNumber(quote.yesAsk, { min: 0, max: 1 }) : null;
    const noBid = verified ? finiteNumber(quote.noBid, { min: 0, max: 1 }) : null;
    const noAsk = verified ? finiteNumber(quote.noAsk, { min: 0, max: 1 }) : null;
    const yesDirect = directPair(yesBid, yesAsk);
    const noDirect = directPair(noBid, noAsk);
    const activity = activityByContract.get(String(publicLine.contractId).toUpperCase()) || null;
    return {
      ticker: publicLine.contractId,
      contractId: publicLine.contractId,
      productId: publicLine.productId,
      threshold: publicLine.strike,
      lowerBound: publicLine.strike,
      upperBound: null,
      strikeType: 'greater',
      comparator: '>',
      status: yesDirect && noDirect ? 'available' : 'unavailable',
      yesBid,
      yesAsk,
      yesBidSize: verified ? finiteNumber(quote.yesBidSize, { min: 0 }) : null,
      yesAskSize: verified ? finiteNumber(quote.yesAskSize, { min: 0 }) : null,
      noBid,
      noAsk,
      noBidSize: verified ? finiteNumber(quote.noBidSize, { min: 0 }) : null,
      noAskSize: verified ? finiteNumber(quote.noAskSize, { min: 0 }) : null,
      lastTrade: activity?.lastTrade ?? null,
      lastYesPrice: activity?.lastYesPrice ?? null,
      lastNoPrice: activity?.lastNoPrice ?? null,
      lastTradeAt: activity?.lastTradeAt || null,
      volume24h: activity?.observed24h ? activity.volume24h : null,
      totalVolume: null,
      openInterest: finiteNumber(publicLine.openInterest, { min: 0 }),
      liquidity: null,
      updatedAt: verified ? isoTimestamp(quote.updatedAt) : null,
      closeAt: publicLine.closeAt,
      source: verified ? 'ibkr_tws_forecastex_live' : 'forecastex_official_schedule',
      derivedFields: [],
      quoteSources: {},
      directNative: verified,
      depthCapability: verified ? 'top_of_book' : 'no_live_book',
      nativeOrderbook: null,
      rulesUrl: publicLine.rulesUrl || null,
      question: publicLine.question || null,
      expirationDate: publicLine.expirationDate || null,
      payoutDate: publicLine.payoutDate || null,
      resolverSymbol: publicLine.resolverSymbol || null,
      underlyingContractMonth: publicLine.underlyingContractMonth || null,
      resolverMonthLabel: publicLine.resolverMonthLabel || null,
      evidence: {
        quotes: verified ? { source: 'ibkr_tws_forecastex_live', asOf: isoTimestamp(quote.updatedAt), fit: 'exact', executable: yesDirect || noDirect } : null,
        activity: activity ? { source: 'forecastex_official_execution_tape', asOf: activity.lastTradeAt, fit: 'exact', executable: false } : null,
        openInterest: { source: 'forecastex_official_contracts', asOf: fetchedAt, fit: 'exact', executable: false, scope: 'contract_line' },
      },
    };
  }).sort((left, right) => left.threshold - right.threshold);
}

function buildForecastVenue(
  contractSnapshot,
  liveSnapshot,
  config,
  requestDate,
  selectedGeneration = null,
  activityByContract = new Map(),
  selectedContractIds = null,
) {
  const generation = selectedGeneration
    || selectForecastGeneration(contractSnapshot?.lines, config.forecastExProduct, requestDate.getTime());
  if (!generation) {
    const catalog = unavailable(`No current official ForecastEx ${config.forecastExProduct} generation is available.`, { event: null, lines: [] });
    const book = unavailable(`No verified live ForecastEx ${config.forecastExProduct} book is available.`, { event: null, lines: [] });
    return {
      id: 'forecastex', label: 'ForecastEx', status: 'unavailable', resolver: config.forecastExResolver,
      settlementBasis: settlementBasisUnavailable(`No current ForecastEx ${config.forecastExProduct} generation is available to verify.`),
      equivalenceFingerprint: null, brokerRoutable: false, catalog, book, contracts: book,
      bookQuality: buildBookQuality([]), backgroundRefresh: Boolean(liveSnapshot?.refreshing),
    };
  }
  const fetchedAt = isoTimestamp(liveSnapshot?.fetchedAt) || requestDate.toISOString();
  const allLines = normalizeForecastLiveLines(generation, liveSnapshot, fetchedAt, activityByContract);
  const selectedIds = selectedContractIds instanceof Set
    ? selectedContractIds
    : Array.isArray(selectedContractIds) ? new Set(selectedContractIds.map(String)) : null;
  const lines = selectedIds
    ? allLines.filter((line) => selectedIds.has(String(line.contractId)))
    : allLines;
  const bookQuality = buildBookQuality(lines);
  const anyLive = lines.some((line) => line.directNative);
  const brokerRoutable = liveSnapshot?.brokerRoutable === true || anyLive;
  const event = {
    ticker: generation.generationKey,
    generationId: generation.generationId,
    venueId: 'forecastex',
    seriesTicker: config.forecastExProduct,
    productCode: config.forecastExProduct,
    cadence: generation.cadence,
    title: generation.lines[0]?.eventDisplayName || `${config.fullLabel} · ForecastEx`,
    subtitle: generation.lines[0]?.question || null,
    status: 'open',
    openTime: null,
    closeTime: generation.closeAt,
    expirationTime: generation.lines[0]?.expirationDate || generation.closeAt,
    observationTime: generation.closeAt,
    timezone: 'America/Chicago',
    availableOnBrokers: brokerRoutable,
    brokerRoutable,
    measurementDate: generation.eventDate || null,
    lastTradeAt: generation.closeAt,
    resolutionAt: generation.resolutionAt || null,
    payoutAt: generation.payoutAt || null,
    payoutAmount: finiteNumber(config.forecastExResolver?.payout, { min: 0 }),
    rulesUrl: generation.lines[0]?.rulesUrl || null,
    resolverSymbol: generation.resolverSymbol || null,
    resolverContractMonth: generation.underlyingContractMonth || null,
    resolverMonthLabel: generation.resolverMonthLabel || null,
    resolverInstrument: generation.resolverInstrument || null,
  };
  const resolver = generation.resolverSymbol ? {
    ...config.forecastExResolver,
    contractSymbol: generation.resolverSymbol,
    contractMonth: generation.underlyingContractMonth,
    contractMonthLabel: generation.resolverMonthLabel,
  } : config.forecastExResolver;
  const settlementBasis = buildForecastSettlementBasis(generation, config);
  const catalogLines = allLines.map(catalogLine);
  const ladderSelection = selectedIds ? {
    contractIds: lines.map((line) => String(line.contractId)),
    corePerSide: FES_CORE_LINES_PER_SIDE,
    liquidExtraThreshold: FES_LIQUID_EXTRA_THRESHOLD,
    liquidExtrasPerSide: FES_LIQUID_EXTRAS_PER_SIDE,
    maximumLines: (FES_CORE_LINES_PER_SIDE * 2) + 1 + (FES_LIQUID_EXTRAS_PER_SIDE * 2),
  } : null;
  const catalog = {
    status: 'available',
    source: 'forecastex_official_schedule',
    asOf: isoTimestamp(contractSnapshot?.fetchedAt) || requestDate.toISOString(),
    expiresAt: generation.closeAt,
    seriesTicker: config.forecastExProduct,
    event,
    lines: catalogLines,
    reason: null,
    scheduleOnly: true,
  };
  const book = {
    status: bookQuality.eligible ? 'available' : anyLive ? 'partial' : 'unavailable',
    source: anyLive ? 'ibkr_tws_forecastex_live' : 'forecastex_official_schedule',
    asOf: anyLive ? fetchedAt : null,
    expiresAt: anyLive ? new Date(Date.parse(fetchedAt) + CONTRACT_MAX_AGE_MS).toISOString() : null,
    seriesTicker: config.forecastExProduct,
    event,
    lines,
    ladderSelection,
    reason: bookQuality.eligible
      ? null
      : anyLive
        ? 'Fresh native ForecastEx quotes are incomplete or lack positive displayed size and are not executable in Auto.'
        : 'Official contract terms are available, but no fresh native ForecastEx IBKR book is verified.',
    scheduleOnly: !anyLive,
    refreshing: liveSnapshot?.refreshing === true,
    refreshRetained: liveSnapshot?.refreshRetained === true && anyLive,
    refreshFailed: liveSnapshot?.refreshFailed === true,
    refreshIssue: liveSnapshot?.refreshIssue || (liveSnapshot?.refreshFailed ? liveSnapshot?.reason : null),
    errorCode: liveSnapshot?.errorCode || null,
    lastAttemptAt: liveSnapshot?.lastAttemptAt || null,
    lastSuccessfulObservationAt: liveSnapshot?.lastSuccessfulObservationAt || (anyLive ? fetchedAt : null),
    latencyMs: finiteNumber(liveSnapshot?.latencyMs, { min: 0 }),
  };
  return {
    id: 'forecastex',
    label: 'ForecastEx',
    status: book.status === 'available' ? 'available' : 'partial',
    resolver,
    settlementBasis,
    resolverIdentity: generation.resolverSymbol ? {
      generationKey: generation.generationKey,
      eventDate: generation.eventDate,
      resolverSymbol: generation.resolverSymbol,
      underlyingContractMonth: generation.underlyingContractMonth,
      resolverMonthLabel: generation.resolverMonthLabel,
      instrument: generation.resolverInstrument || null,
      lastTradeAt: generation.closeAt,
      resolutionAt: generation.resolutionAt,
      payoutAt: generation.payoutAt,
    } : null,
    equivalenceFingerprint: buildVenueFingerprint(resolver, event, catalogLines),
    brokerRoutable,
    catalog,
    book,
    contracts: book,
    ladderSelection,
    bookQuality,
    generationKey: generation.generationKey,
    generationId: generation.generationId,
    activity: {
      selectedGenerationOpenInterest: {
        value: sumPublishedMetric(allLines, 'openInterest'),
        unit: 'contracts',
        scope: 'selected_generation_sum',
        source: 'forecastex_official_contracts',
        asOf: catalog.asOf,
      },
      volume24h: {
        value: sumPublishedMetric(allLines, 'volume24h'),
        unit: 'contracts',
        scope: 'selected_generation_sum',
        source: 'forecastex_official_execution_tape',
        asOf: allLines.map((line) => line.lastTradeAt).filter(Boolean).sort().at(-1) || null,
      },
      totalVolume: {
        value: null,
        unit: 'contracts',
        scope: 'not_published',
        source: null,
        asOf: null,
      },
    },
    capabilities: {
      book: anyLive ? 'top_of_book' : 'no_live_book',
      activity: 'official_execution_tape',
      openInterest: 'official_contract_line',
    },
    backgroundRefresh: Boolean(liveSnapshot?.refreshing),
  };
}

function lifecycleStatus(section, { catalog = false, catalogAvailable = false, applicable = true } = {}) {
  if (!applicable) return 'not_applicable';
  if (section?.refreshing === true || section?.status === 'refreshing') return 'refreshing';
  const reason = `${section?.errorCode || ''} ${section?.refreshIssue || section?.reason || ''}`.toLowerCase();
  if (/401|unauth|api key|credential/.test(reason)) return 'auth_required';
  if (/403|entitle|permission|not entitled/.test(reason)) return 'entitlement_required';
  if (section?.refreshFailed === true) return 'refresh_failed';
  if (catalog && section?.status === 'available') return 'live';
  if (section?.status === 'available') return 'live';
  if (section?.status === 'partial') return 'partial';
  if (section?.status === 'closed' || section?.status === 'historical') return 'closed';
  if (catalogAvailable) return 'catalog_only';
  return 'unavailable';
}

function sourceHealthEntry(id, label, section, options = {}) {
  const status = lifecycleStatus(section, options);
  return {
    id,
    label,
    status,
    source: section?.source || null,
    lastAttemptAt: section?.lastAttemptAt || section?.asOf || null,
    lastSuccessAt: section?.lastSuccessfulObservationAt
      || (['live', 'partial', 'closed'].includes(status) ? section?.asOf || null : null),
    asOf: section?.asOf || null,
    expiresAt: section?.expiresAt || null,
    latencyMs: finiteNumber(section?.latencyMs, { min: 0 }),
    errorCode: section?.errorCode || null,
    reason: section?.refreshIssue || section?.reason || null,
    applicable: options.applicable !== false,
  };
}

function buildSourceHealth({ config, venues, reference, riskRange }) {
  const rows = [];
  const kalshi = venues?.kalshi;
  if (kalshi) {
    rows.push(sourceHealthEntry('kalshi_catalog', 'Kalshi catalog', kalshi.catalog, { catalog: true }));
    rows.push(sourceHealthEntry('kalshi_book', 'Kalshi native book', kalshi.book, {
      catalogAvailable: kalshi.catalog?.status === 'available',
    }));
  }
  const forecast = venues?.forecastex;
  rows.push(sourceHealthEntry('forecastex_catalog', 'ForecastEx catalog', forecast?.catalog, {
    catalog: true,
    applicable: Boolean(config?.forecastExProduct),
  }));
  rows.push(sourceHealthEntry('forecastex_book', 'ForecastEx via IBKR', forecast?.book, {
    applicable: Boolean(config?.forecastExProduct),
    catalogAvailable: forecast?.catalog?.status === 'available',
  }));
  const forecastActivity = forecast?.activity?.volume24h;
  rows.push(sourceHealthEntry('forecastex_activity', 'ForecastEx execution tape', forecastActivity ? {
    status: forecastActivity.status === 'refresh_failed'
      ? 'unavailable'
      : forecastActivity.value != null ? 'available' : 'unavailable',
    source: forecastActivity.source,
    asOf: forecastActivity.asOf,
    reason: forecastActivity.reason || (forecastActivity.value == null ? 'ForecastEx execution activity was not published.' : null),
    refreshFailed: forecastActivity.status === 'refresh_failed',
  } : null, { applicable: Boolean(config?.forecastExProduct) }));
  if (reference?.exactReference) {
    rows.push(sourceHealthEntry('resolver_exact_spot', 'Exact resolver reference', reference.exactReference.spot, { applicable: true }));
    rows.push(sourceHealthEntry('resolver_exact_chart', 'Exact resolver chart', reference.exactReference.chart, { applicable: true }));
  }
  rows.push(sourceHealthEntry('resolver_spot', reference?.spot?.fit === 'proxy' ? 'Resolver proxy reference' : 'Resolver reference', reference?.spot, { applicable: true }));
  rows.push(sourceHealthEntry('resolver_chart', reference?.chart?.fit === 'proxy' ? 'Resolver proxy chart' : 'Resolver chart', reference?.chart, { applicable: true }));
  rows.push(sourceHealthEntry('risk_range', 'Risk Range', riskRange, { applicable: true }));
  return rows;
}

function generationOptionsFromVenues(venues = {}) {
  return Object.values(venues).flatMap((venue) => Array.isArray(venue?.generations) ? venue.generations : [])
    .sort((left, right) => (
      Date.parse(left.closeTime || '') - Date.parse(right.closeTime || '')
      || Number(right.openInterest || 0) - Number(left.openInterest || 0)
      || left.id.localeCompare(right.id)
    ));
}

function normalizeRiskRange(envelope, config, nowMs) {
  const definition = config.riskRange;
  const range = envelope?.ranges?.[definition.ticker];
  const current = envelope?.available === true
    && envelope?.status === 'current'
    && envelope?.manifest?.publicationDate
    && envelope.manifest.publicationDate === envelope.manifest.expectedDate;
  const lrr = current ? finiteNumber(range?.lrr) : null;
  const hrr = current ? finiteNumber(range?.hrr) : null;
  if (!current || lrr == null || hrr == null || !(lrr < hrr)) {
    return unavailable(`Current ${definition.label} is unavailable.`, {
      lrr: null, hrr: null, previousClose: null, trend: null, date: null, fit: definition.fit, ticker: definition.ticker,
    });
  }
  return {
    status: 'available',
    lrr,
    hrr,
    previousClose: finiteNumber(range?.previousClose ?? range?.prevClose),
    trend: range.trend || null,
    date: envelope.manifest.publicationDate,
    fit: definition.fit,
    ticker: definition.ticker,
    source: range.source || 'hedgeye_risk_ranges',
    asOf: isoTimestamp(range.timestamp || envelope.manifest.latestUpdatedAt) || envelope.manifest.publicationDate,
    expiresAt: new Date(nowMs + RESEARCH_MAX_AGE_MS).toISOString(),
    reason: definition.fit === 'related_only'
      ? 'Related index only; this range is not eligible for Nasdaq-100 scoring or sizing.'
      : definition.fit === 'strong_proxy'
        ? 'Proxy research context only; this range is not the venue resolver.'
        : null,
  };
}

function chartWithBasisGate(chart, basisValidation) {
  if (!chart || !basisValidation) return chart;
  return mapChartVariants(chart, (variant) => {
    if (basisValidation.display === 'hide') {
      const publicationDate = String(basisValidation.publicationDate || '');
      let gated = false;
      const dailyRanges = (variant?.dailyRanges || []).map((range) => {
        if (publicationDate && range?.date !== publicationDate) return range;
        gated = true;
        return {
          ...range,
          status: 'unavailable',
          references: [],
          fit: 'mismatched',
          basisValidation,
          reason: basisValidation.reason,
        };
      });
      const missingDates = dailyRanges
        .filter((range) => !verifiedRiskRangeReferences(range))
        .map((range) => range.date);
      const availableCount = dailyRanges.length - missingDates.length;
      return {
        ...variant,
        dailyRanges,
        riskRangeStatus: missingDates.length
          ? availableCount ? 'partial' : 'unavailable'
          : 'available',
        riskRangeMissingDates: missingDates,
        ...(gated ? {
          riskRangeBasisStatus: 'mismatched',
          riskRangeBasis: basisValidation,
          riskRangeReason: basisValidation.reason,
        } : {}),
      };
    }
    if (basisValidation.display === 'proxy') {
      return {
        ...variant,
        dailyRanges: (variant?.dailyRanges || []).map((range) => ({
          ...range,
          fit: 'proxy_context',
          basisValidation,
        })),
        riskRangeStatus: variant?.riskRangeStatus || 'unavailable',
        riskRangeBasisStatus: 'proxy_context',
        riskRangeBasis: basisValidation,
        riskRangeReason: basisValidation.reason,
      };
    }
    return {
      ...variant,
      riskRangeStatus: variant?.riskRangeStatus || 'unavailable',
      riskRangeBasisStatus: 'aligned',
      riskRangeBasis: basisValidation,
      riskRangeReason: null,
    };
  });
}

function applyDirectionalBasisGate(riskRange, reference, contextChart = null) {
  const contextualReference = reference ? {
    ...reference,
    chart: attachVerifiedRiskRangeOverlays(reference.chart, contextChart, riskRange),
  } : reference;
  if (!contextualReference?.directionalFeed || riskRange?.status !== 'available') {
    return { riskRange, reference: contextualReference, basisValidation: null };
  }
  const publicationDate = String(riskRange?.date || '').slice(0, 10);
  const directionalCloseDate = String(
    contextualReference?.spot?.previousCloseAsOf || '',
  ).slice(0, 10);
  // After the next resolver session opens, the newest directional previous
  // close can be the same date as the still-current Hedgeye publication. It
  // is not the prior-session basis for that publication, so do not compare
  // the two or erase valid exact-date historical overlays.
  if (/^\d{4}-\d{2}-\d{2}$/.test(publicationDate)
    && /^\d{4}-\d{2}-\d{2}$/.test(directionalCloseDate)
    && directionalCloseDate >= publicationDate) {
    return { riskRange, reference: contextualReference, basisValidation: null };
  }
  const basisValidation = {
    ...evaluateRiskRangeBasis({
      directionalPreviousClose: contextualReference?.spot?.previousClose,
      hedgeyePreviousClose: riskRange?.previousClose,
      lrr: riskRange?.lrr,
      hrr: riskRange?.hrr,
    }),
    publicationDate: publicationDate || null,
  };
  const chart = chartWithBasisGate(contextualReference.chart, basisValidation);
  if (basisValidation.display === 'hide') {
    return {
      basisValidation,
      reference: { ...contextualReference, chart, basisValidation },
      riskRange: {
        ...riskRange,
        status: 'unavailable',
        lrr: null,
        hrr: null,
        trend: null,
        fit: 'mismatched',
        hiddenByBasisGate: true,
        basisValidation,
        reason: basisValidation.reason,
      },
    };
  }
  const effectiveRange = basisValidation.display === 'proxy'
    ? {
        ...riskRange,
        fit: 'proxy_context',
        basisValidation,
        reason: basisValidation.reason,
      }
    : { ...riskRange, basisValidation };
  return {
    basisValidation,
    riskRange: effectiveRange,
    reference: { ...contextualReference, chart, basisValidation },
  };
}

function normalizeVolatility(snapshot, key, nowMs) {
  const row = snapshot?.[key];
  const value = finiteNumber(row?.lastPx, { min: 0 });
  const asOf = isoTimestamp(row?.asOf || row?.timestamp || row?.lastUpdated);
  const ageMs = nowMs - Date.parse(asOf || '');
  const blocked = FORBIDDEN_PROVENANCE.test([
    row?.source, row?.warning, row?.error, row?.freshness, row?.availability,
  ].filter(Boolean).join(' '));
  if (row?.availability !== 'available' || row?.freshness !== 'current' || value == null || !asOf
    || ageMs < -5_000 || ageMs > VOLATILITY_CONTEXT_MAX_AGE_MS || blocked) {
    return unavailable(`Current ${key === 'NazVol' ? 'VXN' : key} is unavailable.`, { value: null });
  }
  return {
    status: 'historical',
    availability: 'historical',
    value,
    source: row.sourceLabel || row.source || 'CBOE',
    asOf,
    expiresAt: new Date(nowMs + RESEARCH_MAX_AGE_MS).toISOString(),
    decisionEligible: false,
    reason: 'Verified dated volatility context only; excluded from strategy scoring and execution.',
  };
}

function latestSnapshot(value) {
  return [...(Array.isArray(value) ? value : value ? [value] : [])].sort((left, right) => (
    String(right?.date || '').localeCompare(String(left?.date || ''))
    || String(right?.retrievedAt || right?.scrapedAt || '').localeCompare(String(left?.retrievedAt || left?.scrapedAt || ''))
  ))[0] || null;
}

function exactTickerSlot(data, ticker) {
  if (!data || typeof data !== 'object') return null;
  const target = String(ticker || '').trim().toUpperCase();
  if (!target) return null;
  if (String(data.ticker ?? data.symbol ?? '').trim().toUpperCase() === target) return data;
  for (const collection of [data.stocks, data.securities, data]) {
    if (!collection || typeof collection !== 'object' || Array.isArray(collection)) continue;
    const key = Object.keys(collection).find((candidate) => String(candidate).trim().toUpperCase() === target);
    if (!key) continue;
    const slot = collection[key];
    if (!slot || typeof slot !== 'object' || Array.isArray(slot)) return null;
    const declaredTicker = slot.ticker ?? slot.symbol;
    if (declaredTicker && String(declaredTicker).trim().toUpperCase() !== target) return null;
    return slot;
  }
  for (const rows of [data.rows, data.stocks, data.securities]) {
    if (!Array.isArray(rows)) continue;
    const matches = rows.filter((row) => (
      row
      && typeof row === 'object'
      && String(row.ticker ?? row.symbol ?? '').trim().toUpperCase() === target
    ));
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) return null;
  }
  return null;
}

function normalizeTrade(snapshotValue, config, targetDate, nowMs) {
  const ticker = config.trade.ticker;
  const exactDate = dateKey(targetDate);
  const candidates = (Array.isArray(snapshotValue) ? snapshotValue : snapshotValue ? [snapshotValue] : [])
    .filter((snapshot) => (
      snapshot?.snapshotType === 'momo-tracker'
      && dateKey(snapshot.date) === exactDate
    ))
    .sort((left, right) => String(
      right?.retrievedAt || right?.scrapedAt || right?.publishedAt || right?.updatedAt || ''
    ).localeCompare(String(
      left?.retrievedAt || left?.scrapedAt || left?.publishedAt || left?.updatedAt || ''
    )));
  const snapshot = candidates[0] || null;
  const provenance = [
    snapshot?.source,
    snapshot?.provenance,
    snapshot?.cacheState,
    snapshot?.freshness,
    snapshot?.availability,
    snapshot?.warning,
    snapshot?.error,
    snapshot?.reason,
    snapshot?.fromCache && 'cached',
    snapshot?.cachedOnly && 'cached-only',
    snapshot?.refreshFailed && 'refresh-failed',
    snapshot?.refreshIssue,
  ].filter(Boolean).join(' ');
  const snapshotUnsafe = snapshot?.refreshFailed === true
    || Boolean(snapshot?.refreshIssue)
    || FORBIDDEN_PROVENANCE.test(provenance)
    || REFRESH_FAILURE.test(provenance);
  const slot = snapshot && !snapshotUnsafe
    ? exactTickerSlot(snapshot.data, ticker)
    : null;
  const slotProvenance = [
    slot?.source,
    slot?.provenance,
    slot?.cacheState,
    slot?.freshness,
    slot?.availability,
    slot?.warning,
    slot?.error,
    slot?.reason,
    slot?.fromCache && 'cached',
    slot?.cachedOnly && 'cached-only',
    slot?.refreshIssue,
  ].filter(Boolean).join(' ');
  const slotUnsafe = slot?.refreshFailed === true
    || Boolean(slot?.refreshIssue)
    || FORBIDDEN_PROVENANCE.test(slotProvenance)
    || REFRESH_FAILURE.test(slotProvenance);
  const rowDate = dateKey(slot?.date || snapshot?.date);
  const raw = slot?.trade ?? slot?.tradeSignal ?? null;
  const direction = normalizeDirection(raw);
  if (!snapshot || !slot || slotUnsafe || !direction || !exactDate || rowDate !== exactDate) {
    return unavailable(`A same-session published ${config.trade.label} signal is unavailable.`, {
      direction: null,
      raw: null,
      date: rowDate,
      ticker,
    });
  }
  return {
    status: 'available',
    direction,
    raw,
    date: exactDate,
    ticker,
    source: 'momo-tracker',
    asOf: isoTimestamp(
      snapshot.retrievedAt || snapshot.scrapedAt || snapshot.publishedAt || snapshot.updatedAt,
    ) || exactDate,
    expiresAt: new Date(nowMs + RESEARCH_MAX_AGE_MS).toISOString(),
    reason: null,
  };
}

function selectCftcRow(value, config, nowMs) {
  const snapshot = latestSnapshot(value);
  const sourceDate = String(snapshot?.date || '').match(/^\d{4}-\d{2}-\d{2}$/)?.[0] || null;
  const sourceMs = sourceDate ? Date.parse(`${sourceDate}T23:59:59.000Z`) : NaN;
  const provenance = [snapshot?.cacheState, snapshot?.cachedOnly && 'cached-only', snapshot?.fromCache && 'cached', snapshot?.provenance]
    .filter(Boolean).join(' ');
  const official = snapshot?.snapshotType === 'cftc-positioning'
    && snapshot?.source === CFTC_OFFICIAL_SOURCE
    && snapshot?.schemaVersion === CFTC_SCHEMA_VERSION
    && snapshot?.calculationVersion === CFTC_CALCULATION_VERSION
    && snapshot?.decisionEligible === true
    && snapshot?.reportDate === sourceDate
    && snapshot?.datasetIds?.legacy === 'srt6-5q2f'
    && /^[a-f0-9]{64}$/i.test(String(snapshot?.sourceContentHash || ''))
    && !FORBIDDEN_PROVENANCE.test(provenance);
  if (!official || !Number.isFinite(sourceMs) || nowMs - sourceMs > CFTC_MAX_AGE_MS || nowMs - sourceMs < -24 * 60 * 60_000) {
    return unavailable(`Verified official ${config.cftc.label} is unavailable.`, { zScore1Y: null });
  }
  const rows = Array.isArray(snapshot?.data) ? snapshot.data : Array.isArray(snapshot?.data?.rows) ? snapshot.data.rows : [];
  const matches = rows.filter((row) => row?.cftcContractMarketCode === config.cftc.code);
  const row = matches.length === 1 ? matches[0] : null;
  const zScore1Y = finiteNumber(row?.zScore1Y);
  const zScore3Y = finiteNumber(row?.zScore3Y);
  const latest = finiteNumber(row?.latest);
  const weeklyChange = finiteNumber(row?.wwChg);
  if (!row || row.status !== 'current' || row.decisionEligible !== true || row.asOf !== sourceDate
    || row.seriesType !== config.cftc.seriesType || [zScore1Y, zScore3Y, latest, weeklyChange].some((field) => field == null)) {
    return unavailable(`Verified official ${config.cftc.label} is unavailable.`, { zScore1Y: null });
  }
  return {
    status: 'available', value: zScore1Y, zScore1Y, zScore3Y, latest, weeklyChange,
    metric: row.metric, contractCode: config.cftc.code, source: CFTC_OFFICIAL_SOURCE,
    asOf: sourceDate, expiresAt: new Date(sourceMs + CFTC_MAX_AGE_MS).toISOString(), reason: null,
  };
}

function normalizeUsdCorrelation(snapshot, config, nowMs) {
  if (!config.usdCorrelationKey) return unavailable('No exact current USD correlation is configured.', { r30: null });
  const row = snapshot?.correlations?.[config.usdCorrelationKey];
  const r30 = finiteNumber(row?.['30D'], { min: -1, max: 1 });
  const asOf = isoTimestamp(snapshot?.timestamp) || snapshot?.calculationDate || null;
  const asOfMs = Date.parse(asOf || '');
  const ageMs = nowMs - asOfMs;
  if (snapshot?.sourceStatus !== 'current' || r30 == null || !asOf || !Number.isFinite(asOfMs)
    || ageMs < -5_000 || ageMs > USD_CORRELATION_MAX_AGE_MS
    || FORBIDDEN_PROVENANCE.test(String(snapshot?.sourceStatus || ''))) {
    return unavailable(`Current USD/${config.usdCorrelationKey} correlation is unavailable.`, { r30: null });
  }
  return {
    status: 'available', value: r30, r15: finiteNumber(row?.['15D'], { min: -1, max: 1 }), r30,
    r90: finiteNumber(row?.['90D'], { min: -1, max: 1 }), source: snapshot.source || `DXY / ${config.usdCorrelationKey}`,
    asOf, expiresAt: new Date(asOfMs + USD_CORRELATION_MAX_AGE_MS).toISOString(), reason: 'Proxy context only; never an executable price.',
  };
}

function normalizeSilverRealizedVolatility(snapshot, nowMs) {
  const context = snapshot?.assetContext?.silverRealizedVolatility;
  const value = finiteNumber(context?.value, { min: 0, max: 10 });
  const asOf = isoTimestamp(context?.asOf);
  const asOfMs = Date.parse(asOf || '');
  const provenance = [snapshot?.sourceStatus, context?.source, context?.provenance, context?.warning]
    .filter(Boolean).join(' ');
  if (!['available', 'historical'].includes(String(context?.status || '').toLowerCase())
    || context?.availability !== 'historical'
    || Number(context?.window) !== 21
    || context?.annualized !== true
    || value == null
    || !Number.isFinite(asOfMs)
    || nowMs - asOfMs < -5_000
    || nowMs - asOfMs > VOLATILITY_CONTEXT_MAX_AGE_MS
    || FORBIDDEN_PROVENANCE.test(provenance)
    || context?.refreshFailed === true
    || context?.fromCache === true) {
    return unavailable('Verified 21D annualized Silver realized volatility is unavailable.', { value: null });
  }
  return {
    status: 'historical', availability: 'historical', value, window: 21, annualized: true,
    source: context.source, asOf, expiresAt: new Date(asOfMs + VOLATILITY_CONTEXT_MAX_AGE_MS).toISOString(),
    decisionEligible: false, reason: 'Completed Silver futures sessions only; context, not an executable input.',
  };
}

function normalizeBrentWtiSpread(snapshot, nowMs) {
  const context = snapshot?.assetContext?.brentWtiSpread;
  const value = finiteNumber(context?.value);
  const asOf = isoTimestamp(context?.asOf);
  const asOfMs = Date.parse(asOf || '');
  const provenance = [snapshot?.sourceStatus, context?.source, context?.provenance, context?.warning]
    .filter(Boolean).join(' ');
  if (!['available', 'historical'].includes(String(context?.status || '').toLowerCase())
    || context?.availability !== 'historical'
    || value == null
    || !Number.isFinite(asOfMs)
    || nowMs - asOfMs < -5_000
    || nowMs - asOfMs > VOLATILITY_CONTEXT_MAX_AGE_MS
    || FORBIDDEN_PROVENANCE.test(provenance)
    || context?.refreshFailed === true
    || context?.fromCache === true) {
    return unavailable('Verified completed-session Brent–WTI spread is unavailable.', { value: null });
  }
  return {
    status: 'historical', availability: 'historical', value, unit: 'USD/bbl',
    brentClose: finiteNumber(context?.brentClose), wtiClose: finiteNumber(context?.wtiClose),
    source: context.source, asOf, expiresAt: new Date(asOfMs + VOLATILITY_CONTEXT_MAX_AGE_MS).toISOString(),
    decisionEligible: false, reason: 'Aligned completed-session futures closes; context only.',
  };
}

function factorDisplayNumber(value, precision = 2, { signed = false } = {}) {
  if (finiteNumber(value) == null) return null;
  const number = Number(value);
  return `${signed && number > 0 ? '+' : ''}${number.toFixed(precision)}`;
}

function contextFactorRow({ id, label, factor, displayValue, fit = 'context', note = null }) {
  return {
    id,
    label,
    role: 'context',
    fit,
    decisionEligible: false,
    status: factor?.status || 'unavailable',
    value: factor?.value ?? null,
    displayValue: displayValue ?? null,
    displayState: null,
    source: factor?.source || null,
    asOf: factor?.asOf || null,
    note: factor?.reason || note,
  };
}

function tradeTrendGateRow(riskRange, trade) {
  const tradeDirection = normalizeDirection(trade?.direction);
  const trendDirection = normalizeDirection(riskRange?.trend);
  const complete = trade?.status === 'available'
    && riskRange?.status === 'available'
    && Boolean(tradeDirection && trendDirection);
  const displayState = !complete || tradeDirection === 'NEUTRAL' || trendDirection === 'NEUTRAL'
    ? 'WAIT'
    : tradeDirection === trendDirection ? 'CONTEXT ALIGNED' : 'CONFLICT';
  return {
    id: 'gate',
    label: 'TRADE / TREND GATE',
    role: 'gate',
    fit: 'context_only',
    decisionEligible: false,
    status: complete ? 'available' : 'unavailable',
    value: null,
    displayValue: `${tradeDirection || '—'} / ${trendDirection || '—'}`,
    displayState,
    source: [trade?.source, riskRange?.source].filter(Boolean).join(' + ') || null,
    asOf: trade?.asOf || riskRange?.asOf || null,
    note: 'Context agreement only; not a score, recommendation, or trade signal.',
  };
}

function contractGeometryRow(config, riskRange) {
  const available = riskRange?.status === 'available'
    && finiteNumber(riskRange?.lrr) != null
    && finiteNumber(riskRange?.hrr) != null;
  return contextFactorRow({
    id: 'geometry',
    label: 'CONTRACT / RR GEOMETRY',
    factor: available ? riskRange : unavailable('Current Risk Range geometry is unavailable.'),
    displayValue: available
      ? `${factorDisplayNumber(riskRange.lrr, config.precision)} – ${factorDisplayNumber(riskRange.hrr, config.precision)}`
      : null,
    fit: riskRange?.fit || config.riskRange.fit,
    note: 'Risk Range placement by contract line; context only.',
  });
}

function legacyGenericFactorRows(config, riskRange, factors) {
  const rows = config.usdCorrelationKey ? [
    contextFactorRow({
      id: 'dxy',
      label: 'DXY · LAST CLOSE',
      factor: factors.dxy,
      displayValue: factorDisplayNumber(factors.dxy?.value, 2),
      fit: 'completed_session',
    }),
    contextFactorRow({
      id: 'usd',
      label: `USD CORR · ${config.usdCorrelationKey}/DXY 30D`,
      factor: factors.usd,
      displayValue: factorDisplayNumber(factors.usd?.r30, 2, { signed: true }),
      fit: 'context_only',
    }),
  ] : [];
  rows.push({
    id: 'riskRange',
    label: `${config.riskRange.label.toUpperCase()}${config.riskRange.fit === 'related_only' ? ' · RELATED ONLY' : config.riskRange.fit === 'strong_proxy' ? ' · PROXY' : ''}`,
    status: riskRange.status,
    value: riskRange.status === 'available' ? `${riskRange.lrr} – ${riskRange.hrr}` : null,
    source: riskRange.source,
    asOf: riskRange.asOf,
    note: riskRange.reason,
  }, {
    id: 'trade',
    label: config.trade.label.toUpperCase(),
    status: factors.trade.status,
    value: factors.trade.direction,
    source: factors.trade.source,
    asOf: factors.trade.asOf,
    note: factors.trade.reason || 'Independent same-session MOMO Trade signal.',
  });
  config.volatility.forEach((key) => {
    const factor = factors[key];
    rows.push({
      id: key,
      label: key === 'NazVol' ? 'VXN' : key,
      status: factor.status,
      value: factor.value,
      source: factor.source,
      asOf: factor.asOf,
      note: 'Volatility context only; never an executable price or automatic signal.',
    });
  });
  if (config.cftc && factors.cftc) {
    rows.push({
      id: 'cftc', label: config.cftc.label, status: factors.cftc.status,
      value: factors.cftc.zScore1Y, source: factors.cftc.source, asOf: factors.cftc.asOf,
      note: 'Verified official positioning context only.',
    });
  }
  return rows;
}

function genericFactorRows(config, riskRange, factors) {
  if (config.id === 'nasdaq100') return legacyGenericFactorRows(config, riskRange, factors);
  const dxy = contextFactorRow({
    id: 'dxy',
    label: 'DXY · LAST CLOSE',
    factor: factors.dxy,
    displayValue: factorDisplayNumber(factors.dxy?.value, 2),
    fit: 'completed_session',
  });
  const correlation = contextFactorRow({
    id: 'usd',
    label: `${config.usdCorrelationKey}/DXY 30D CORRELATION`,
    factor: factors.usd,
    displayValue: factorDisplayNumber(factors.usd?.r30, 2, { signed: true }),
    fit: 'context_only',
  });
  const cftc = contextFactorRow({
    id: 'cftc',
    label: config.cftc?.label || 'CFTC POSITIONING · 1Y / 3Y Z',
    factor: factors.cftc,
    displayValue: factors.cftc?.status === 'available'
      ? `${factorDisplayNumber(factors.cftc.zScore1Y, 2, { signed: true })} / ${factorDisplayNumber(factors.cftc.zScore3Y, 2, { signed: true })}`
      : null,
    fit: 'official_context',
  });
  let second = cftc;
  let third = null;
  if (config.id === 'silver') {
    third = contextFactorRow({
      id: 'silverRealizedVolatility',
      label: '21D ANNUALIZED SILVER REALIZED VOLATILITY',
      factor: factors.silverRealizedVolatility,
      displayValue: finiteNumber(factors.silverRealizedVolatility?.value) == null
        ? null : `${(Number(factors.silverRealizedVolatility.value) * 100).toFixed(1)}%`,
      fit: 'completed_sessions',
    });
  } else if (config.id === 'brent') {
    second = contextFactorRow({
      id: 'brentWtiSpread',
      label: 'BRENT–WTI FRONT-MONTH SPREAD',
      factor: factors.brentWtiSpread,
      displayValue: finiteNumber(factors.brentWtiSpread?.value) == null
        ? null : `$${factorDisplayNumber(factors.brentWtiSpread.value, 2, { signed: true })}/bbl`,
      fit: 'aligned_completed_session',
    });
    third = contextFactorRow({
      id: 'OVX', label: 'OVX · WTI PROXY', factor: factors.OVX,
      displayValue: factorDisplayNumber(factors.OVX?.value, 2), fit: 'wti_proxy',
    });
  } else {
    const key = config.volatility[0];
    third = contextFactorRow({
      id: key,
      label: key,
      factor: factors[key],
      displayValue: factorDisplayNumber(factors[key]?.value, 2),
      fit: 'volatility_context',
    });
  }
  return [
    dxy,
    correlation,
    second,
    third,
    tradeTrendGateRow(riskRange, factors.trade),
    contractGeometryRow(config, riskRange),
  ];
}

function unavailableGoldMarketReferences(venueId, reason) {
  const forecastEx = venueId === 'forecastex';
  const item = (fields) => ({
    status: 'unavailable',
    price: null,
    previousClose: null,
    changePercent: null,
    unit: 'USD/ozt',
    source: null,
    instrument: null,
    asOf: null,
    reason,
    ...fields,
  });
  return [
    item({
      key: 'selectedResolver',
      label: forecastEx ? 'COMEX SETTLEMENT' : 'PYTH GOLD INDEX',
      symbol: forecastEx ? 'GC' : 'GOLD/USD',
      role: 'direct',
    }),
    item({ key: 'xauusd', label: 'SPOT GOLD', symbol: 'XAUUSD', role: 'proxy' }),
    item({ key: 'activeComex', label: 'COMEX GOLD', symbol: 'GC', role: 'proxy' }),
  ];
}

function bindVenueReference(reference, venue, config, reason = null) {
  const event = venue?.catalog?.event || venue?.book?.event || null;
  const fallbackReason = reason || `Verified ${venue?.label || 'venue'} ${config.symbol} reference is unavailable.`;
  const suppliedSpot = reference?.spot || unavailable(fallbackReason, {
    availability: 'unavailable', value: null, label: config.symbol, fit: 'exact', executable: false,
  });
  const fit = suppliedSpot.fit || reference?.fit || 'exact';
  const spot = {
    ...suppliedSpot,
    fit,
    availability: suppliedSpot.availability
      || (suppliedSpot.status === 'historical' ? 'historical' : suppliedSpot.status === 'available' ? 'live' : 'unavailable'),
    executable: false,
  };
  const chart = mapChartVariants(
    reference?.chart,
    (variant) => ({
      ...variant,
      fit: variant?.fit || reference?.fit || fit,
      availability: variant?.availability
        || (variant?.status === 'historical' ? 'historical' : variant?.status === 'available' ? 'live' : 'unavailable'),
      executable: false,
    }),
  );
  const available = ['available', 'historical'].includes(spot.status)
    || Object.values(chart.variants || {}).some((variant) => ['available', 'historical'].includes(variant?.status));
  return {
    ...(reference || {}),
    status: reference?.status || (available ? 'available' : 'unavailable'),
    resolver: reference?.resolver || venue?.resolver?.resolver || null,
    resolverIdentity: {
      venueId: venue?.id || event?.venueId || null,
      eventTicker: event?.ticker || null,
      generationId: venue?.generationId || event?.generationId || null,
      resolverSymbol: event?.resolverSymbol || venue?.resolverIdentity?.resolverSymbol || null,
      resolverContractMonth: event?.resolverContractMonth || venue?.resolverIdentity?.underlyingContractMonth || null,
    },
    fit,
    freshness: {
      status: spot.status,
      availability: spot.availability,
      asOf: spot.asOf || chart.asOf || null,
      expiresAt: spot.expiresAt || chart.expiresAt || null,
      refreshFailed: spot.refreshFailed === true || chart.refreshFailed === true,
    },
    spot,
    chart,
  };
}

function monitorChartReference({ role, symbol, riskRangeTicker, reference, exact, disclosure }) {
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
    disclosure: disclosure || null,
    backgroundRefresh: safeReference.backgroundRefresh === true,
  };
}

function wrapSpxForecastOnlySnapshot(
  snapshot,
  forecastVenue,
  config,
  requestDate,
  resolverReference = null,
) {
  const unavailableReference = {
    status: 'unavailable',
    resolver: forecastVenue?.resolverIdentity?.resolverSymbol || null,
    instrument: null,
    spot: unavailable('The exact live FES futures reference is unavailable.', { value: null }),
    chart: unavailable('The exact FES futures reference chart is unavailable.', { points: [] }),
  };
  let boundReference = bindVenueReference(
    resolverReference || unavailableReference,
    forecastVenue,
    config,
  );
  boundReference = {
    ...boundReference,
    // VIX is SPX cash-session context. Carry only exact-date, verified IBKR
    // daily closes onto the ES resolver chart; it never becomes a live quote
    // or an executable contract input.
    chart: attachVerifiedVixCloses(boundReference?.chart, snapshot.chart),
  };
  const contractSymbol = boundReference?.instrument?.displaySymbol
    || forecastVenue?.resolverIdentity?.resolverSymbol
    || boundReference?.spot?.label
    || 'ES';
  const chartReferences = {
    basis: monitorChartReference({
      role: 'risk_range_basis',
      symbol: 'SPX',
      riskRangeTicker: 'SPX',
      reference: {
        spot: snapshot.spot,
        chart: snapshot.chart,
        instrument: {
          symbol: 'SPX', displaySymbol: 'SPX', secType: 'IND', exchange: 'CBOE', currency: 'USD', provider: 'ibkr',
        },
        resolver: 'IBKR cash S&P 500 index',
        fit: 'exact',
        backgroundRefresh: snapshot.sourceRefreshPending === true,
      },
      exact: true,
      disclosure: 'SPX cash is the verified price basis for the SPX Risk Range.',
    }),
    contract: monitorChartReference({
      role: 'contract_reference',
      symbol: contractSymbol,
      riskRangeTicker: 'SPX',
      reference: boundReference,
      exact: true,
      disclosure: 'The dated E-mini S&P 500 future is the ForecastEx FES reference; it is not cash SPX.',
    }),
  };
  boundReference = { ...boundReference, chartReferences };
  const venues = { forecastex: { ...forecastVenue, reference: boundReference } };
  const autoSelection = annotateAutoRefreshFailure(
    selectAutoVenue(venues, requestDate.getTime()),
    venues,
  );
  const displaySelection = selectRequestedVenue(venues, autoSelection, {
    venue: 'forecastex',
    generationId: null,
  });
  const selectedGenerationId = forecastVenue?.generationId
    || displaySelection.contracts?.event?.generationId
    || displaySelection.contracts?.event?.ticker
    || null;
  const selectedGeneration = (forecastVenue?.generations || []).find((generation) => (
    generation.venueId === 'forecastex'
    && generation.generationId === selectedGenerationId
  )) || null;
  return {
    ...snapshot,
    schemaVersion: 2,
    marketId: config.id,
    displayName: config.fullLabel,
    symbol: config.symbol,
    precision: config.precision,
    unit: config.unit,
    resolverMetadata: {
      forecastex: config.forecastExResolver,
      reference: 'SPX research context; ForecastEx FES uses the exact dated ES futures reference below.',
      fesReference: resolverReference?.resolver || null,
    },
    resolverReference: boundReference,
    // Preserve the separately verified cash-index context for the S&P header.
    // Cash SPX owns the black Risk Range chart. The selected ES reference stays
    // separate so the ladder and its deltas remain contract-anchored.
    cashSpot: snapshot.spot || null,
    chartReferences,
    directionalFeed: boundReference.directionalFeed || null,
    basisValidation: snapshot.riskRange?.basisValidation || null,
    venues,
    // The SP500 surface is intentionally fixed to the current official FES
    // generation. Do not expose alternate generations as trading choices.
    generationOptions: [],
    selectedGeneration,
    selectedGenerationId,
    selectedVenueId: 'forecastex',
    selection: {
      requestedVenue: 'forecastex',
      requestedGenerationId: null,
      venueId: 'forecastex',
      generationId: selectedGenerationId,
      reason: displaySelection.reason,
    },
    productActivity: forecastVenue?.activity || null,
    autoSelection,
    displaySelection,
    displayContracts: displaySelection.contracts,
    contracts: displaySelection.contracts,
    executionContracts: forecastVenue?.book || autoSelection.contracts,
    spot: snapshot.spot,
    chart: snapshot.chart,
    riskRange: snapshot.riskRange,
    sourceRefreshPending: snapshot.sourceRefreshPending === true
      || forecastVenue?.backgroundRefresh === true
      || boundReference?.backgroundRefresh === true,
    sourceHealth: buildSourceHealth({
      config,
      venues,
      reference: boundReference,
      riskRange: snapshot.riskRange,
    }),
    strategy: {
      status: 'unavailable',
      model: null,
      eligibleVenueId: null,
      eligibleSeriesTicker: null,
      reason: 'No validated ForecastEx FES strategy or sizing model is configured. Live IBKR quotes remain informational only.',
    },
  };
}

function wrapSpxSnapshot(
  snapshot,
  forecastVenue,
  config,
  requestDate,
  orderbooks = null,
  resolverReference = null,
  kalshiVenueOverride = null,
  selection = {},
) {
  if (config?.venueIds?.length === 1 && config.venueIds[0] === 'forecastex') {
    return wrapSpxForecastOnlySnapshot(
      snapshot,
      forecastVenue,
      config,
      requestDate,
      resolverReference,
    );
  }
  const kalshiContracts = snapshot?.contracts || unavailable('SP500 Kalshi contracts are unavailable.', { event: null, lines: [] });
  const exactKalshiFamily = kalshiContracts?.seriesTicker === 'KXINXU'
    && String(kalshiContracts?.event?.ticker || '').startsWith('KXINXU-');
  const eventStillOpen = Date.parse(kalshiContracts?.event?.closeTime || '') > requestDate.getTime();
  const kalshiLines = (Array.isArray(kalshiContracts.lines) ? kalshiContracts.lines : []).map((line) => {
    const rawOrderbook = nativeOrderbookForTicker(orderbooks, line.ticker);
    const nativeBook = rawOrderbook?.orderbook_fp || rawOrderbook?.orderbook || rawOrderbook || {};
    const yesBids = normalizeNativeBidArray(nativeBook.yes_dollars);
    const noBids = normalizeNativeBidArray(nativeBook.no_dollars);
    const bestYesBid = [...yesBids].sort((left, right) => right[0] - left[0])[0] || null;
    const bestNoBid = [...noBids].sort((left, right) => right[0] - left[0])[0] || null;
    const verified = exactKalshiFamily && Boolean(rawOrderbook)
      && Array.isArray(line.derivedFields) && line.derivedFields.length === 0;
    const yesBid = verified ? bestYesBid?.[0] ?? null : null;
    const noBid = verified ? bestNoBid?.[0] ?? null : null;
    const yesAsk = verified ? finiteNumber(line.yesAsk, { min: 0, max: 1 }) : null;
    const noAsk = verified ? finiteNumber(line.noAsk, { min: 0, max: 1 }) : null;
    return {
      ...line,
      lowerBound: line.threshold,
      upperBound: null,
      strikeType: 'greater',
      comparator: '>',
      closeAt: kalshiContracts.event?.closeTime || null,
      yesBid: directPair(yesBid, yesAsk) ? yesBid : null,
      yesAsk: directPair(yesBid, yesAsk) ? yesAsk : null,
      yesBidSize: verified ? bestYesBid?.[1] ?? null : null,
      noBid: directPair(noBid, noAsk) ? noBid : null,
      noAsk: directPair(noBid, noAsk) ? noAsk : null,
      noBidSize: verified ? bestNoBid?.[1] ?? null : null,
      directNative: verified,
      source: verified ? 'kalshi_batch_orderbooks_v2' : 'kalshi_trade_api_v2_catalog',
      quoteSources: line.quoteSources || {},
      nativeOrderbook: { yesBids, noBids },
    };
  });
  const normalizedKalshiContracts = {
    ...kalshiContracts,
    event: kalshiContracts.event ? {
      ...kalshiContracts.event,
      status: exactKalshiFamily && eventStillOpen ? 'open' : 'closed',
    } : null,
    lines: kalshiLines,
  };
  const kalshiBookQuality = buildBookQuality(kalshiLines);
  const normalizedKalshiStatus = normalizedKalshiContracts.status === 'available' && kalshiLines.length
    ? kalshiBookQuality.eligible ? 'available' : 'partial'
    : 'unavailable';
  normalizedKalshiContracts.status = normalizedKalshiStatus;
  if (normalizedKalshiStatus === 'partial') {
    normalizedKalshiContracts.reason = 'The current KXINXU ladder is incomplete or lacks positive displayed size and is not executable in Auto.';
  }
  const brokerRoutable = kalshiContracts?.event?.availableOnBrokers === true;
  const kalshiCatalog = kalshiLines.length ? {
    ...normalizedKalshiContracts,
    status: 'available',
    source: 'kalshi_trade_api_v2_catalog',
    expiresAt: normalizedKalshiContracts.event?.closeTime || normalizedKalshiContracts.expiresAt,
    lines: kalshiLines.map(catalogLine),
  } : unavailable('No current KXINXU catalog is available.', { event: null, lines: [] });
  const kalshiVenue = {
    id: 'kalshi', label: 'Kalshi', status: normalizedKalshiStatus === 'available' ? 'available' : kalshiCatalog.status === 'available' ? 'partial' : 'unavailable',
    resolver: config.kalshiResolver,
    settlementBasis: settlementBasisUnavailable('The legacy SP500 Kalshi catalog does not expose a verified settlement basis.'),
    equivalenceFingerprint: buildVenueFingerprint(config.kalshiResolver, normalizedKalshiContracts.event, kalshiLines),
    brokerRoutable,
    catalog: kalshiCatalog,
    book: normalizedKalshiContracts,
    contracts: normalizedKalshiContracts,
    bookQuality: kalshiBookQuality,
  };
  const effectiveKalshiVenue = kalshiVenueOverride || kalshiVenue;
  const venues = { kalshi: effectiveKalshiVenue, forecastex: forecastVenue };
  const autoSelection = annotateAutoRefreshFailure(
    selectAutoVenue(venues, requestDate.getTime()),
    venues,
  );
  const displaySelection = selectRequestedVenue(venues, autoSelection, selection);
  const generationOptions = generationOptionsFromVenues(venues);
  const selectedGenerationId = displaySelection.generationId
    || displaySelection.contracts?.event?.generationId
    || displaySelection.contracts?.event?.ticker
    || null;
  const selectedGeneration = generationOptions.find((generation) => (
    generation.venueId === displaySelection.venueId
    && generation.generationId === selectedGenerationId
  )) || null;
  return {
    ...snapshot,
    schemaVersion: 2,
    marketId: config.id,
    displayName: config.fullLabel,
    symbol: config.symbol,
    precision: config.precision,
    unit: config.unit,
    resolverMetadata: {
      kalshi: config.kalshiResolver,
      forecastex: config.forecastExResolver,
      reference: 'cash SPX / verified IBKR context',
      fesReference: resolverReference?.resolver || null,
    },
    resolverReference: resolverReference || {
      status: 'unavailable',
      resolver: forecastVenue?.resolverIdentity?.resolverSymbol || null,
      instrument: null,
      spot: unavailable('The exact live FES ES resolver quote is unavailable.', { value: null }),
      chart: unavailable('The exact FES ES resolver chart is unavailable.', { points: [] }),
    },
    venues,
    generationOptions,
    selectedGeneration,
    selectedGenerationId,
    selectedVenueId: displaySelection.venueId,
    selection: {
      requestedVenue: selection?.venue || 'auto',
      requestedGenerationId: selection?.generationId || null,
      venueId: displaySelection.venueId,
      generationId: selectedGenerationId,
      reason: selection?.venue && selection.venue !== 'auto' ? displaySelection.reason : autoSelection.reason,
    },
    productActivity: displaySelection.venueId && venues[displaySelection.venueId]
      ? venues[displaySelection.venueId].activity || null
      : null,
    autoSelection,
    displaySelection,
    displayContracts: displaySelection.contracts,
    contracts: displaySelection.contracts,
    executionContracts: autoSelection.contracts,
    spot: {
      ...snapshot.spot,
      fit: 'exact',
      availability: snapshot.spot?.availability || (snapshot.spot?.status === 'historical' ? 'historical' : snapshot.spot?.status === 'available' ? 'live' : 'unavailable'),
      executable: false,
    },
    chart: mapChartVariants(snapshot.chart, (chart) => ({
      ...chart,
      fit: 'exact',
      availability: chart?.availability || (chart?.status === 'historical' ? 'historical' : chart?.status === 'available' ? 'live' : 'unavailable'),
      executable: false,
    })),
    sourceRefreshPending: snapshot.sourceRefreshPending === true
      || forecastVenue?.backgroundRefresh === true,
    sourceHealth: buildSourceHealth({
      config,
      venues,
      reference: { spot: snapshot.spot, chart: snapshot.chart },
      riskRange: snapshot.riskRange,
    }),
    strategy: {
      status: effectiveKalshiVenue.status === 'available' && effectiveKalshiVenue.bookQuality?.eligible && exactKalshiFamily && eventStillOpen && effectiveKalshiVenue.brokerRoutable
        ? 'available'
        : 'unavailable',
      model: 'spx-close-confluence-v1',
      eligibleVenueId: 'kalshi',
      eligibleSeriesTicker: 'KXINXU',
      reason: effectiveKalshiVenue.status === 'available' && effectiveKalshiVenue.bookQuality?.eligible && exactKalshiFamily && eventStillOpen && effectiveKalshiVenue.brokerRoutable
        ? null
        : 'The validated strategy requires the current broker-routable KXINXU cash-SPX resolver and a verified direct book.',
    },
  };
}

function chunkKalshiTickers(tickers = [], maximum = 100) {
  const unique = [...new Set((Array.isArray(tickers) ? tickers : [])
    .map((ticker) => String(ticker || '').trim())
    .filter(Boolean))];
  const chunks = [];
  for (let index = 0; index < unique.length; index += maximum) chunks.push(unique.slice(index, index + maximum));
  return chunks;
}

function normalizeKalshiOrderbookResponse(payload) {
  const rows = Array.isArray(payload?.orderbooks) ? payload.orderbooks : [];
  return rows.map((row) => {
    const ticker = String(row?.market_ticker || row?.ticker || '').trim();
    return ticker ? [ticker, row] : null;
  }).filter(Boolean);
}

function cpiSourceUnavailable(reason, extras = {}) {
  return {
    status: 'unavailable',
    value: null,
    asOf: null,
    source: null,
    reason,
    ...extras,
  };
}

function normalizeCpiHedgeyeComparison(release = {}) {
  const reportMonth = normalizeCpiMonthId(release.reportMonth || release.cpi?.reportMonthId);
  const releaseAt = isoTimestamp(release.releaseAt || release.cpi?.releaseAt);
  const asOf = isoTimestamp(release.source?.asOf || release.source?.snapshotDate);
  const scenarios = (Array.isArray(release.scenarios) ? release.scenarios : []).map((scenario) => ({
    key: String(scenario?.key || '').trim().toLowerCase(),
    label: String(scenario?.label || '').trim() || null,
    value: finiteNumber(scenario?.value, { min: -20, max: 100 }),
  })).filter((scenario) => ['upside', 'base', 'downside'].includes(scenario.key) && scenario.value != null);
  const byKey = new Map(scenarios.map((scenario) => [scenario.key, scenario]));
  const ordered = ['downside', 'base', 'upside'].map((key) => byKey.get(key)).filter(Boolean);
  if (!reportMonth || !releaseAt || !asOf || ordered.length !== 3) {
    return cpiSourceUnavailable('No exact-month Hedgeye headline CPI YoY scenario set is available.', {
      reportMonth,
      scenarios: [],
      baseValue: null,
      expiresAt: releaseAt,
    });
  }
  return {
    status: 'available',
    reportMonth,
    scenarios: ordered,
    baseValue: byKey.get('base').value,
    source: release.source?.type || 'hedgeye-inflation-nowcast',
    asOf,
    expiresAt: releaseAt,
    reason: null,
  };
}

function normalizeCpiClevelandComparison(payload = {}, release = {}, nowMs = Date.now()) {
  const reportMonth = normalizeCpiMonthId(release.reportMonth || release.cpi?.reportMonthId);
  const releaseAt = isoTimestamp(release.releaseAt || release.cpi?.releaseAt);
  const releaseMs = Date.parse(releaseAt || '');
  const sourceMonth = normalizeCpiMonthId(payload.sourceMonth || payload.requiredMonth || payload.period);
  const points = (Array.isArray(payload.points) ? payload.points : []).map((point) => ({
    timestamp: finiteNumber(point?.timestamp, { min: 0 }),
    value: finiteNumber(point?.value, { min: -20, max: 100 }),
  })).filter((point) => point.timestamp != null
    && point.value != null
    && point.timestamp <= nowMs + 5_000
    && (!Number.isFinite(releaseMs) || point.timestamp < releaseMs))
    .sort((left, right) => left.timestamp - right.timestamp);
  const latest = points.at(-1) || null;
  const source = String(payload.source || '').trim();
  const provenance = [source, payload.warning, payload.cacheState, payload.fromCache ? 'cache' : null]
    .filter(Boolean).join(' ');
  if (payload.status !== 'available'
    || !reportMonth
    || sourceMonth !== reportMonth
    || !latest
    || !source
    || FORBIDDEN_PROVENANCE.test(provenance)) {
    return cpiSourceUnavailable(
      payload.reason || `No exact ${reportMonth || 'current'} Cleveland Fed headline CPI YoY nowcast is available.`,
      {
        reportMonth,
        points: [],
        sourceUrl: authoritativeHttpsUrl(payload.sourceUrl),
        expiresAt: releaseAt,
      },
    );
  }
  return {
    status: 'available',
    reportMonth,
    value: latest.value,
    points,
    source,
    sourceUrl: authoritativeHttpsUrl(payload.sourceUrl),
    asOf: new Date(latest.timestamp).toISOString(),
    datasetAsOf: isoTimestamp(payload.datasetAsOf),
    expiresAt: releaseAt,
    reason: null,
  };
}

function previousCpiMonthId(monthId) {
  const normalized = normalizeCpiMonthId(monthId);
  const match = normalized?.match(/^(\d{4})-(\d{2})$/);
  if (!match) return null;
  const previous = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 2, 1));
  return `${previous.getUTCFullYear()}-${String(previous.getUTCMonth() + 1).padStart(2, '0')}`;
}

function normalizeCpiBlsComparison(payload = {}, release = {}) {
  const reportMonth = normalizeCpiMonthId(release.reportMonth || release.cpi?.reportMonthId);
  const expectedPriorMonth = previousCpiMonthId(reportMonth);
  const candidates = (Array.isArray(payload.finals) ? payload.finals : []).map((final) => ({
    reportMonth: normalizeCpiMonthId(final?.id || final?.reportMonth),
    value: finiteNumber(final?.value, { min: -20, max: 100 }),
    source: String(final?.source || payload.source || '').trim() || null,
    seriesId: final?.seriesId || payload.seriesId || null,
    sourceUrl: authoritativeHttpsUrl(final?.sourceUrl || CPI_BLS_SOURCE_URL),
  })).filter((final) => final.reportMonth
    && final.value != null
    && final.source
    && final.reportMonth === expectedPriorMonth)
    .sort((left, right) => left.reportMonth.localeCompare(right.reportMonth));
  const latestFinal = candidates.at(-1) || null;
  if (!reportMonth || !latestFinal) {
    return cpiSourceUnavailable(`No official BLS headline CPI YoY final for ${expectedPriorMonth || 'the immediately preceding month'} is available.`, {
      reportMonth,
      expectedPriorMonth,
      latestFinal: null,
      fetchedAt: isoTimestamp(payload.lastRemoteSuccessAt || payload.fetchedAt),
    });
  }
  return {
    status: 'available',
    reportMonth,
    expectedPriorMonth,
    latestFinal,
    source: latestFinal.source,
    sourceUrl: latestFinal.sourceUrl,
    asOf: isoTimestamp(payload.lastRemoteSuccessAt || payload.fetchedAt),
    fetchedAt: isoTimestamp(payload.lastRemoteSuccessAt || payload.fetchedAt),
    refreshPending: payload.refreshing === true,
    remoteStatus: payload.remoteStatus || null,
    reason: null,
  };
}

function buildCpiForecastComparison(release, clevelandPayload, blsPayload, nowMs = Date.now()) {
  const reportMonth = normalizeCpiMonthId(release?.reportMonth || release?.cpi?.reportMonthId);
  const releaseAt = isoTimestamp(release?.releaseAt || release?.cpi?.releaseAt);
  const eventTicker = String(release?.eventTicker || release?.cpi?.eventTicker || '').trim().toUpperCase() || null;
  const hedgeye = normalizeCpiHedgeyeComparison(release);
  const clevelandFed = normalizeCpiClevelandComparison(clevelandPayload, release, nowMs);
  const bls = normalizeCpiBlsComparison(blsPayload, release);
  const availableCount = [hedgeye, clevelandFed, bls].filter((source) => source.status === 'available').length;
  return {
    status: availableCount === 3 ? 'available' : availableCount > 0 ? 'partial' : 'unavailable',
    releaseKey: release?.releaseKey || release?.cpi?.releaseKey || null,
    reportMonth,
    forecastMonth: release?.forecastMonth || release?.cpi?.forecastMonth || null,
    releaseAt,
    eventTicker,
    metric: 'Headline CPI YoY',
    unit: 'percent',
    hedgeye,
    clevelandFed,
    bls,
    reason: availableCount > 0 ? null : 'No verified CPI forecast comparison sources are available.',
  };
}

function cpiLadderReference(comparison = {}) {
  const hedgeye = comparison.hedgeye;
  if (hedgeye?.status !== 'available' || finiteNumber(hedgeye.baseValue) == null) return null;
  return {
    status: 'available',
    kind: 'hedgeye_base',
    label: 'HEDGEYE BASE',
    value: Number(hedgeye.baseValue),
    reportMonth: comparison.reportMonth,
    source: hedgeye.source,
    asOf: hedgeye.asOf,
    expiresAt: comparison.releaseAt,
    availability: 'dated',
    executable: false,
  };
}

function selectExactCpiKalshiEvent(payload, config, release, nowMs) {
  const event = payload?.event || payload;
  const expectedTicker = String(release?.eventTicker || release?.cpi?.eventTicker || '').trim().toUpperCase();
  const expectedMonth = normalizeCpiMonthId(release?.reportMonth || release?.cpi?.reportMonthId);
  const releaseMs = Date.parse(release?.releaseAt || release?.cpi?.releaseAt || '');
  if (!event
    || String(event.event_ticker || '').trim().toUpperCase() !== expectedTicker
    || String(event.series_ticker || '').trim().toUpperCase() !== CPI_SERIES_TICKER
    || normalizeCpiMonthId(event.event_ticker) !== expectedMonth) return null;
  const selected = selectKalshiEvent([event], config, nowMs, expectedTicker);
  const closeMs = Date.parse(selected?.closeTime || '');
  if (!selected
    || !Number.isFinite(closeMs)
    || !Number.isFinite(releaseMs)
    || closeMs > releaseMs
    || releaseMs - closeMs > 15 * 60_000) return null;
  return selected;
}

function createMarketMonitorService(options = {}) {
  const now = options.now || (() => new Date());
  const kalshiFetch = options.kalshiFetch || defaultKalshiFetch;
  const publicSources = options.publicSources;
  const spxMonitorService = options.spxMonitorService;
  const loadRiskRanges = options.loadRiskRanges || (async () => null);
  const loadTradeSnapshots = options.loadTradeSnapshots || (async () => []);
  const loadVolatilitySnapshot = options.loadVolatilitySnapshot || (async () => null);
  const loadCftcSnapshots = options.loadCftcSnapshots || (async () => []);
  const loadUsdSnapshot = options.loadUsdSnapshot || (async () => null);
  const loadForecastExLive = options.loadForecastExLive || (async () => ({ status: 'unavailable', fetchedAt: null, lines: [] }));
  const loadMarketReference = options.loadMarketReference || (async () => null);
  const loadCurrentCpiRelease = options.loadCurrentCpiRelease || ((context = {}) => getCurrentCpiRelease(context));
  const loadClevelandCpi = options.loadClevelandCpi || ((context = {}) => loadClevelandFedCpiNowcast(context));
  const loadCpiFinals = options.loadCpiFinals || ((context = {}) => loadOfficialCpiFinals(context));
  const refreshBudgetMs = Math.max(250, Number(options.refreshBudgetMs) || INITIAL_REFRESH_BUDGET_MS);
  const loadKalshiOrderbooks = options.loadKalshiOrderbooks || (async (tickers) => {
    const orderbooks = new Map();
    for (const chunk of chunkKalshiTickers(tickers)) {
      const response = await kalshiFetch('/markets/orderbooks', { tickers: chunk });
      normalizeKalshiOrderbookResponse(response).forEach(([ticker, row]) => orderbooks.set(ticker, row));
      await nextTurn();
    }
    return orderbooks;
  });
  if (!publicSources || !spxMonitorService) throw new TypeError('publicSources and spxMonitorService are required');
  const sharedResearch = new Map();
  const referenceLoads = new Map();
  const lastVerifiedReferences = new Map();

  function sharedLoad(key, loader, ttlMs = 30_000) {
    const cached = sharedResearch.get(key);
    const nowMs = now().getTime();
    if (cached?.value !== undefined && nowMs < cached.expiresAt) return Promise.resolve(cached.value);
    if (cached?.inFlight) return cached.inFlight;
    const entry = cached || { value: undefined, expiresAt: 0, inFlight: null };
    entry.inFlight = Promise.resolve().then(loader).then((value) => {
      entry.value = value;
      entry.expiresAt = now().getTime() + ttlMs;
      return value;
    }).finally(() => {
      entry.inFlight = null;
    });
    sharedResearch.set(key, entry);
    return entry.inFlight;
  }

  function unavailableCpiSnapshot(config, requestDate, reason, { pending = false, error = null } = {}) {
    const waiting = pending ? 'The current CPI release identity is refreshing.' : reason;
    let kalshiVenue = buildKalshiVenue(null, config, requestDate, null);
    if (pending) {
      kalshiVenue = {
        ...kalshiVenue,
        status: 'refreshing',
        catalog: refreshPending(kalshiVenue.catalog, waiting),
        book: refreshPending(kalshiVenue.book, waiting),
        contracts: refreshPending(kalshiVenue.contracts, waiting),
      };
    } else if (error) {
      kalshiVenue = {
        ...kalshiVenue,
        catalog: refreshFailure(kalshiVenue.catalog, error),
      };
    }
    const contracts = pending
      ? refreshPending(unavailable(waiting, { event: null, lines: [] }), waiting)
      : unavailable(reason, { event: null, lines: [] });
    const comparison = {
      status: pending ? 'refreshing' : 'unavailable',
      releaseKey: null,
      reportMonth: null,
      forecastMonth: null,
      releaseAt: null,
      eventTicker: null,
      metric: 'Headline CPI YoY',
      unit: 'percent',
      hedgeye: cpiSourceUnavailable(waiting, { scenarios: [], baseValue: null }),
      clevelandFed: cpiSourceUnavailable(waiting, { points: [] }),
      bls: cpiSourceUnavailable(waiting, { latestFinal: null }),
      reason: waiting,
    };
    return {
      schemaVersion: 2,
      marketId: config.id,
      displayName: config.fullLabel,
      symbol: config.symbol,
      precision: config.precision,
      unit: config.unit,
      generatedAt: requestDate.toISOString(),
      status: pending ? 'refreshing' : 'unavailable',
      session: { state: 'unknown', asOf: requestDate.toISOString() },
      resolverMetadata: { kalshi: config.kalshiResolver, reference: null },
      spot: unavailable('CPI is a scheduled release outcome; no live underlying spot is used.', {
        value: null, label: 'CPI', fit: 'exact', availability: 'not_applicable', executable: false,
      }),
      chart: ensureChartVariants(unavailable('A directional price chart is not applicable to CPI.', {
        availability: 'not_applicable', points: [], references: [], executable: false,
      })),
      chartReferences: null,
      resolverReference: null,
      directionalFeed: null,
      basisValidation: null,
      riskRange: unavailable('Risk Range is not applicable to CPI.', {
        lrr: null, hrr: null, trend: null, fit: 'not_applicable', ticker: null,
      }),
      forecastComparison: comparison,
      ladderReference: null,
      factors: {},
      factorRows: [],
      scoreInputs: {},
      venues: { kalshi: kalshiVenue },
      generationOptions: [],
      selectedGeneration: null,
      selectedGenerationId: null,
      selectedVenueId: 'kalshi',
      selection: {
        requestedVenue: 'kalshi', requestedGenerationId: null,
        venueId: 'kalshi', generationId: null, reason: waiting,
      },
      productActivity: null,
      sourceHealth: [
        sourceHealthEntry('kalshi_catalog', 'Kalshi CPI catalog', kalshiVenue.catalog, { catalog: true }),
        sourceHealthEntry('kalshi_book', 'Kalshi CPI native book', kalshiVenue.book, { catalogAvailable: false }),
      ],
      autoSelection: {
        status: 'unavailable', mode: 'none', venueId: null, label: 'No executable venue',
        reason: 'The CPI monitor is display-only and has no qualified broker route.',
        contracts: unavailable('No verified executable CPI contract ladder is available.', { event: null, lines: [] }),
      },
      displaySelection: {
        status: pending ? 'refreshing' : 'unavailable', mode: 'none', venueId: 'kalshi',
        generationId: null, label: 'Kalshi CPI unavailable', reason: waiting, contracts,
      },
      displayContracts: contracts,
      contracts,
      executionContracts: unavailable('CPI execution is not enabled.', { event: null, lines: [] }),
      sourceRefreshPending: pending,
      strategy: {
        status: 'unavailable', model: null, eligibleVenueId: null,
        reason: 'No validated CPI strategy, sizing model, or execution route is configured.',
      },
      errors: pending ? [] : [reason],
    };
  }

  async function getCpiSnapshot(config, requestDate) {
    const nowMs = requestDate.getTime();
    const releaseResult = await settleWithin(
      sharedLoad('cpi-current-release', () => loadCurrentCpiRelease({ now: nowMs }), 30_000),
      refreshBudgetMs,
      'Current CPI release',
    );
    if (isPendingResult(releaseResult)) {
      return unavailableCpiSnapshot(config, requestDate, 'The current CPI release identity is refreshing.', { pending: true });
    }
    if (releaseResult.status === 'rejected') {
      const reason = sourceFailure(releaseResult.reason, 'The current CPI release identity is unavailable.');
      return unavailableCpiSnapshot(config, requestDate, reason, { error: releaseResult.reason });
    }

    const release = releaseResult.value;
    const reportMonth = normalizeCpiMonthId(release?.reportMonth || release?.cpi?.reportMonthId);
    const eventTicker = String(release?.eventTicker || release?.cpi?.eventTicker || '').trim().toUpperCase();
    const releaseAt = isoTimestamp(release?.releaseAt || release?.cpi?.releaseAt);
    if (!release?.releaseKey
      || !reportMonth
      || !eventTicker.startsWith(`${CPI_SERIES_TICKER}-`)
      || normalizeCpiMonthId(eventTicker) !== reportMonth
      || !releaseAt
      || Date.parse(releaseAt) <= nowMs) {
      return unavailableCpiSnapshot(config, requestDate, 'The current CPI release identity is incomplete, mismatched, or expired.');
    }

    const catalogPromise = sharedLoad(`cpi-kalshi-catalog:${eventTicker}`, () => (
      kalshiFetch(`/events/${encodeURIComponent(eventTicker)}`, { with_nested_markets: true })
    ), 30_000);
    const clevelandPromise = sharedLoad(`cpi-cleveland:${reportMonth}`, () => loadClevelandCpi({
      requiredMonth: reportMonth,
      releaseAt,
      now: nowMs,
      // The provider retains only verified datasets; transient failures stay
      // retryable and cannot replace the dated Cleveland reference.
      useCache: true,
    }), 60_000);
    const blsPromise = sharedLoad(`cpi-bls:${reportMonth}`, () => loadCpiFinals({
      now: nowMs,
      useCache: true,
      awaitRemote: true,
    }), 30_000);

    const catalogResult = await settleWithin(catalogPromise, refreshBudgetMs, 'Kalshi CPI catalog');
    const selected = catalogResult.status === 'fulfilled'
      ? selectExactCpiKalshiEvent(catalogResult.value, config, release, nowMs)
      : null;
    const orderbookPromise = selected
      ? loadKalshiOrderbooks(selected.markets.map((market) => market.ticker))
      : Promise.resolve(new Map());
    const [orderbookResult, clevelandResult, blsResult] = await Promise.all([
      settleWithin(orderbookPromise, refreshBudgetMs, 'Kalshi CPI native book'),
      settleWithin(clevelandPromise, refreshBudgetMs, 'Cleveland Fed CPI nowcast'),
      settleWithin(blsPromise, refreshBudgetMs, 'Official BLS CPI finals'),
    ]);

    let kalshiVenue = buildKalshiVenue(
      selected,
      config,
      requestDate,
      orderbookResult.status === 'fulfilled' ? orderbookResult.value : null,
    );
    if (isPendingResult(catalogResult)) {
      kalshiVenue = {
        ...kalshiVenue,
        status: 'refreshing',
        catalog: refreshPending(kalshiVenue.catalog, 'The exact-month Kalshi CPI catalog is refreshing.'),
        book: refreshPending(kalshiVenue.book, 'The exact-month Kalshi CPI book is refreshing.'),
        contracts: refreshPending(kalshiVenue.contracts, 'The exact-month Kalshi CPI book is refreshing.'),
      };
    } else if (catalogResult.status === 'rejected') {
      kalshiVenue = {
        ...kalshiVenue,
        status: 'unavailable',
        catalog: refreshFailure(kalshiVenue.catalog, catalogResult.reason),
      };
    } else if (!selected) {
      const reason = `Kalshi did not publish the exact active ${eventTicker} CPI generation.`;
      kalshiVenue = {
        ...kalshiVenue,
        status: 'unavailable',
        catalog: unavailable(reason, { event: null, lines: [] }),
        book: unavailable(reason, { event: null, lines: [] }),
        contracts: unavailable(reason, { event: null, lines: [] }),
      };
    } else if (isPendingResult(orderbookResult)) {
      kalshiVenue = {
        ...kalshiVenue,
        status: kalshiVenue.catalog?.status === 'available' ? 'partial' : 'refreshing',
        book: refreshPending(unavailable('The direct Kalshi CPI native book is refreshing.', {
          event: kalshiVenue.catalog?.event || null, lines: [],
        })),
      };
      kalshiVenue.contracts = kalshiVenue.book;
    } else if (orderbookResult.status === 'rejected') {
      kalshiVenue = {
        ...kalshiVenue,
        status: kalshiVenue.catalog?.status === 'available' ? 'partial' : 'unavailable',
        book: failedNativeBook(kalshiVenue.book, orderbookResult.reason, 'Kalshi CPI native book refresh failed.'),
        bookQuality: buildBookQuality([]),
      };
      kalshiVenue.contracts = kalshiVenue.book;
    }

    const cpiEventFields = {
      eventTicker,
      releaseKey: release.releaseKey,
      reportMonth,
      reportMonthId: reportMonth,
      forecastMonth: release.forecastMonth || release.cpi?.forecastMonth || null,
      releaseAt,
      metric: 'Headline CPI YoY',
      brokerRoutable: false,
      availableOnBrokers: false,
    };
    const closeAtMs = Date.parse(kalshiVenue.catalog?.event?.closeTime || '');
    const liveExpiryMs = Date.parse(kalshiVenue.book?.expiresAt || '');
    const safeBookExpiry = Number.isFinite(closeAtMs) && Number.isFinite(liveExpiryMs)
      ? new Date(Math.min(closeAtMs, liveExpiryMs)).toISOString()
      : kalshiVenue.book?.expiresAt || null;
    const enrichSection = (section, { live = false } = {}) => section ? {
      ...section,
      ...(live && section.expiresAt ? { expiresAt: safeBookExpiry } : {}),
      event: section.event ? { ...section.event, ...cpiEventFields } : section.event,
    } : section;
    kalshiVenue = {
      ...kalshiVenue,
      brokerRoutable: false,
      settlementBasis: kalshiVenue.settlementBasis?.status === 'verified'
        ? { ...kalshiVenue.settlementBasis, observationAt: releaseAt }
        : kalshiVenue.settlementBasis,
      catalog: enrichSection(kalshiVenue.catalog),
      book: enrichSection(kalshiVenue.book, { live: true }),
      contracts: enrichSection(kalshiVenue.contracts, { live: true }),
    };

    if (kalshiVenue.settlementBasis?.status !== 'verified') {
      const reason = kalshiVenue.settlementBasis?.reason
        || 'The exact CPI generation has no verified BLS settlement identity.';
      const cleared = unavailable(reason, {
        event: kalshiVenue.catalog?.event || null,
        lines: [],
        scheduleOnly: true,
      });
      kalshiVenue = {
        ...kalshiVenue,
        status: kalshiVenue.catalog?.status === 'available' ? 'partial' : 'unavailable',
        book: cleared,
        contracts: cleared,
        bookQuality: buildBookQuality([]),
      };
    }

    if (selected) {
      const summary = {
        ...kalshiGenerationSummary(selected, config, requestDate.toISOString()),
        ...cpiEventFields,
        availableOnBrokers: false,
        brokerRoutable: false,
        bookStatus: kalshiVenue.book?.status || 'unavailable',
        quotedLineCount: kalshiVenue.bookQuality?.directLineCount || 0,
        executableLineCount: 0,
        lines: mergeVenueDisplayContracts(kalshiVenue).lines,
      };
      kalshiVenue.generations = [summary];
    } else {
      kalshiVenue.generations = [];
    }

    const clevelandPayload = clevelandResult.status === 'fulfilled' ? clevelandResult.value : {
      status: 'unavailable',
      reason: isPendingResult(clevelandResult)
        ? 'The exact-month Cleveland Fed CPI nowcast is refreshing.'
        : sourceFailure(clevelandResult.reason, 'The Cleveland Fed CPI nowcast is unavailable.'),
    };
    const blsPayload = blsResult.status === 'fulfilled' ? blsResult.value : {
      finals: [],
      reason: isPendingResult(blsResult)
        ? 'Official BLS CPI history is refreshing.'
        : sourceFailure(blsResult.reason, 'Official BLS CPI history is unavailable.'),
    };
    const forecastComparison = buildCpiForecastComparison(release, clevelandPayload, blsPayload, nowMs);
    const ladderReference = cpiLadderReference(forecastComparison);
    const venues = { kalshi: kalshiVenue };
    const autoSelection = selectAutoVenue(venues, nowMs);
    const displaySelection = selectRequestedVenue(venues, autoSelection, { venue: 'kalshi', generationId: null });
    const generationOptions = generationOptionsFromVenues(venues);
    const selectedGenerationId = eventTicker;
    const selectedGeneration = generationOptions.find((generation) => generation.generationId === selectedGenerationId) || null;
    const liveQuotes = displaySelection.status === 'available' && displaySelection.contracts?.scheduleOnly !== true;
    const catalogAvailable = kalshiVenue.catalog?.status === 'available';
    const comparisonAvailable = ['available', 'partial'].includes(forecastComparison.status);
    const pendingResults = [catalogResult, orderbookResult, clevelandResult, blsResult].filter(isPendingResult);
    const sourceRefreshPending = pendingResults.length > 0 || forecastComparison.bls?.refreshPending === true;
    const sourceHealth = [
      sourceHealthEntry('kalshi_catalog', 'Kalshi CPI catalog', kalshiVenue.catalog, { catalog: true }),
      sourceHealthEntry('kalshi_book', 'Kalshi CPI native book', kalshiVenue.book, {
        catalogAvailable,
      }),
      sourceHealthEntry('hedgeye_cpi', 'Hedgeye CPI scenarios', forecastComparison.hedgeye, { applicable: true }),
      sourceHealthEntry('cleveland_fed_cpi', 'Cleveland Fed CPI nowcast', forecastComparison.clevelandFed, { applicable: true }),
      sourceHealthEntry('bls_cpi', 'Official BLS CPI history', forecastComparison.bls, { applicable: true }),
    ];
    const errors = [
      catalogResult.status === 'rejected' ? sourceFailure(catalogResult.reason) : null,
      orderbookResult.status === 'rejected' ? sourceFailure(orderbookResult.reason) : null,
      clevelandResult.status === 'rejected' ? sourceFailure(clevelandResult.reason) : null,
      blsResult.status === 'rejected' ? sourceFailure(blsResult.reason) : null,
      selected ? null : `No exact ${eventTicker} Kalshi CPI generation is available.`,
      kalshiVenue.settlementBasis?.status === 'verified' ? null : kalshiVenue.settlementBasis?.reason,
    ].filter(Boolean);

    return {
      schemaVersion: 2,
      marketId: config.id,
      displayName: config.fullLabel,
      symbol: config.symbol,
      precision: config.precision,
      unit: config.unit,
      generatedAt: requestDate.toISOString(),
      status: liveQuotes && forecastComparison.status === 'available'
        ? 'available'
        : catalogAvailable || comparisonAvailable ? 'partial' : 'unavailable',
      session: {
        state: selected && Date.parse(selected.closeTime) > nowMs ? 'open' : 'closed',
        asOf: requestDate.toISOString(),
        closeTime: selected?.closeTime || null,
      },
      resolverMetadata: { kalshi: config.kalshiResolver, reference: null },
      spot: unavailable('CPI is a scheduled release outcome; no live underlying spot is used.', {
        value: null, label: 'CPI', fit: 'exact', availability: 'not_applicable', executable: false,
      }),
      chart: ensureChartVariants(unavailable('A directional price chart is not applicable to CPI.', {
        availability: 'not_applicable', points: [], references: [], executable: false,
      })),
      chartReferences: null,
      resolverReference: null,
      directionalFeed: null,
      basisValidation: null,
      riskRange: unavailable('Risk Range is not applicable to CPI.', {
        lrr: null, hrr: null, trend: null, fit: 'not_applicable', ticker: null,
      }),
      forecastComparison,
      ladderReference,
      factors: {},
      factorRows: [],
      scoreInputs: {},
      venues,
      generationOptions,
      selectedGeneration,
      selectedGenerationId,
      selectedVenueId: 'kalshi',
      selection: {
        requestedVenue: 'kalshi',
        requestedGenerationId: null,
        venueId: 'kalshi',
        generationId: selectedGenerationId,
        reason: 'CPI is fixed to the server-selected current Kalshi KXCPIYOY release.',
      },
      productActivity: kalshiVenue.activity || null,
      sourceHealth,
      autoSelection,
      displaySelection,
      displayContracts: displaySelection.contracts,
      contracts: displaySelection.contracts,
      executionContracts: autoSelection.contracts,
      sourceRefreshPending,
      strategy: {
        status: 'unavailable', model: null, eligibleVenueId: null,
        reason: 'No validated CPI strategy, sizing model, or execution route is configured.',
      },
      errors,
    };
  }

  function loadReferenceDeduped(config, selected, requestDate) {
    const venueKey = selected?.id
      || selected?.venueId
      || selected?.catalog?.event?.venueId
      || (selected?.event?.event_ticker ? 'kalshi' : 'unknown');
    const eventKey = selected?.event?.event_ticker
      || selected?.event?.ticker
      || selected?.catalog?.event?.ticker
      || selected?.generationId
      || 'no-event';
    const key = `${config.id}:${venueKey}:${eventKey}`;
    const cached = referenceLoads.get(key);
    const nowMs = Date.now();
    if (cached?.value && nowMs < cached.expiresAt) return Promise.resolve(cached.value);
    if (cached?.inFlight) return cached.inFlight;
    const entry = cached || { value: null, expiresAt: 0, inFlight: null };
    entry.inFlight = Promise.resolve(loadMarketReference({
      marketId: config.id,
      selected,
      now: requestDate,
    })).then((value) => {
      const sections = [value?.spot, value?.chart].filter(Boolean);
      const refreshPending = value?.backgroundRefresh === true || sections.some((section) => (
        String(section?.status || '').toLowerCase() === 'refreshing'
        || section?.refreshing === true
        || section?.refreshPending === true
      ));
      const includesLive = sections.some((section) => section.availability === 'live');
      const includesHistorical = sections.some((section) => (
        section.status === 'historical' || section.availability === 'historical'
      ));
      // A provider may return a usable retained chart while its quote is still
      // finishing. Do not pin that progressive envelope through the chart's
      // freshness deadline: the provider owns the retained payload and the
      // next worker pass must be allowed to publish its completed spot/marker.
      if (refreshPending) {
        entry.value = null;
        entry.expiresAt = 0;
      } else if (includesLive) {
        const observedAt = Date.now();
        const liveExpiries = sections
          .filter((section) => section.availability === 'live')
          .map((section) => Date.parse(section.expiresAt || ''))
          .filter((expiresAt) => Number.isFinite(expiresAt) && expiresAt > observedAt);
        if (liveExpiries.length) {
          // A slow first request may complete after the outer monitor snapshot
          // returned a bounded "refreshing" state. Preserve that verified
          // result briefly, while still forcing the next normal monitor poll
          // through to the provider before a short-lived quote can expire.
          entry.value = value;
          entry.expiresAt = Math.min(...liveExpiries, observedAt + 5_000);
        }
      } else if (includesHistorical) {
        entry.value = value;
        entry.expiresAt = Date.now() + 30_000;
      }
      return value;
    }).finally(() => {
      entry.inFlight = null;
      if (!entry.value) referenceLoads.delete(key);
    });
    referenceLoads.set(key, entry);
    return entry.inFlight;
  }

  function verifiedExactLiveSpot(section, nowMs) {
    const asOfMs = Date.parse(section?.asOf || '');
    const expiresAtMs = Date.parse(section?.expiresAt || '');
    const source = String(section?.source || '').trim();
    return section?.status === 'available'
      && section?.availability === 'live'
      && section?.fit === 'exact'
      && finiteNumber(section?.value) != null
      && source.length > 0
      && !FORBIDDEN_PROVENANCE.test(source)
      && section?.fromCache !== true
      && section?.cachedOnly !== true
      && section?.refreshFailed !== true
      && Number.isFinite(asOfMs)
      && asOfMs <= nowMs + 5_000
      && Number.isFinite(expiresAtMs)
      && expiresAtMs >= nowMs;
  }

  function referenceWithLastVerified(config, generation, reference, requestDate) {
    if (!generation) return reference;
    const key = `${config.id}:${generation.generationKey}`;
    const nowMs = requestDate.getTime();
    for (const existingKey of lastVerifiedReferences.keys()) {
      if (existingKey.startsWith(`${config.id}:`) && existingKey !== key) {
        lastVerifiedReferences.delete(existingKey);
      }
    }
    if (verifiedExactLiveSpot(reference?.spot, nowMs)) {
      const spot = reference.spot;
      lastVerifiedReferences.set(key, {
        status: 'last_verified',
        availability: 'last_verified',
        fit: 'exact',
        value: Number(spot.value),
        label: spot.label || reference?.instrument?.displaySymbol || generation.resolverSymbol || 'FES',
        source: spot.source,
        asOf: spot.asOf,
        generationKey: generation.generationKey,
        retainedUntil: generation.closeAt,
        displayOnly: true,
        executable: false,
        stale: true,
      });
    }
    const retained = lastVerifiedReferences.get(key) || null;
    const retainedUntilMs = Date.parse(retained?.retainedUntil || '');
    if (retained && (!Number.isFinite(retainedUntilMs) || retainedUntilMs <= nowMs)) {
      lastVerifiedReferences.delete(key);
    }
    const lastVerifiedSpot = lastVerifiedReferences.get(key) || null;
    if (reference) return { ...reference, lastVerifiedSpot };
    const reason = 'The exact FES resolver reference is unavailable.';
    return {
      status: 'unavailable',
      resolver: generation.resolverSymbol || null,
      instrument: null,
      spot: unavailable(reason, {
        availability: 'unavailable',
        fit: 'exact',
        value: null,
        executable: false,
      }),
      chart: unavailable(reason, {
        availability: 'unavailable',
        fit: 'exact',
        points: [],
        references: [],
        executable: false,
      }),
      lastVerifiedSpot,
    };
  }

  async function loadForecastVenue(config, requestDate, generationId = null) {
    if (!config.forecastExProduct) return null;
    try {
      const contracts = await publicSources.getForecastExContracts(config.forecastExProduct);
      const allGenerations = listForecastGenerations(
        contracts?.lines,
        config.forecastExProduct,
        requestDate.getTime(),
      );
      const generation = selectForecastGeneration(
        contracts?.lines,
        config.forecastExProduct,
        requestDate.getTime(),
        generationId,
      );
      let live = null;
      let liveRefreshError = null;
      let activityByContract = new Map();
      let activityRefreshError = null;
      let activityObservedAt = null;
      let resolverReference = null;
      let selectedContractIds = null;
      if (generation) {
        const activityDates = [
          formatInTimeZone(requestDate, 'America/Chicago', 'yyyyMMdd'),
          formatInTimeZone(new Date(requestDate.getTime() - 24 * 60 * 60_000), 'America/Chicago', 'yyyyMMdd'),
        ];
        const activityPromise = typeof publicSources.getForecastExPairs === 'function'
          ? Promise.all(activityDates.map((date) => publicSources.getForecastExPairs(date, [`${generation.generationKey}_`])))
          : Promise.resolve([]);
        let activityResult;
        if (config.id === 'sp500' && config.forecastExProduct === 'FES') {
          const preliminaryVenue = buildForecastVenue(
            contracts,
            null,
            config,
            requestDate,
            generation,
          );
          const [referenceResult, settledActivity] = await Promise.allSettled([
            loadReferenceDeduped(config, preliminaryVenue, requestDate),
            activityPromise,
          ]);
          activityResult = settledActivity;
          resolverReference = referenceWithLastVerified(
            config,
            generation,
            referenceResult.status === 'fulfilled' ? referenceResult.value : null,
            requestDate,
          );
        } else {
          const preliminaryVenue = buildForecastVenue(
            contracts,
            null,
            config,
            requestDate,
            generation,
          );
          const [referenceResult, settledActivity] = await Promise.allSettled([
            loadReferenceDeduped(config, preliminaryVenue, requestDate),
            activityPromise,
          ]);
          activityResult = settledActivity;
          resolverReference = referenceResult.status === 'fulfilled' ? referenceResult.value : null;
        }
        if (activityResult.status === 'fulfilled') {
          activityByContract = aggregateForecastActivity(activityResult.value, generation, requestDate.getTime());
          activityObservedAt = activityResult.value.map((snapshot) => snapshot?.fetchedAt)
            .filter(Boolean)
            .sort()
            .at(-1) || requestDate.toISOString();
          generation.lines.forEach((line) => {
            const key = String(line.contractId || '').toUpperCase();
            if (!activityByContract.has(key)) {
              activityByContract.set(key, {
                volume24h: 0,
                observed24h: true,
                lastTrade: null,
                lastYesPrice: null,
                lastNoPrice: null,
                lastTradeAt: null,
              });
            }
          });
        } else {
          activityRefreshError = activityResult.reason;
        }

        let selectedLines = generation.lines;
        if (config.id === 'sp500' && config.forecastExProduct === 'FES') {
          const selectionCandidates = generation.lines.map((line) => {
            const activity = activityByContract.get(String(line.contractId || '').toUpperCase());
            return {
              ...line,
              volume24h: activity?.observed24h ? activity.volume24h : null,
            };
          });
          const liveAnchor = verifiedExactLiveSpot(resolverReference?.spot, requestDate.getTime())
            ? resolverReference.spot.value
            : null;
          const anchorValue = liveAnchor ?? resolverReference?.lastVerifiedSpot?.value ?? null;
          selectedLines = selectForecastContractUniverse(selectionCandidates, anchorValue);
          selectedContractIds = new Set(selectedLines.map((line) => String(line.contractId)));
        }
        if (selectedLines.length) {
          try {
            live = await loadForecastExLive({
              marketId: config.id,
              productCode: config.forecastExProduct,
              generationKey: generation.generationKey,
              closeTime: generation.closeAt,
              contracts: selectedLines,
            });
          } catch (error) {
            liveRefreshError = error;
          }
        } else {
          live = {
            status: 'unavailable',
            fetchedAt: null,
            lines: [],
            brokerRoutable: false,
            reason: 'Waiting for an exact FES reference or current-generation liquid contract activity.',
          };
        }
      }
      let venue = buildForecastVenue(
        contracts,
        live,
        config,
        requestDate,
        generation,
        activityByContract,
        selectedContractIds,
      );
      if (resolverReference) venue = { ...venue, _resolverReference: resolverReference };
      if (venue.activity?.volume24h && activityObservedAt) {
        venue.activity = {
          ...venue.activity,
          volume24h: { ...venue.activity.volume24h, asOf: activityObservedAt },
        };
      }
      const summaries = allGenerations.map((candidate) => forecastGenerationSummary(
        candidate,
        isoTimestamp(contracts?.fetchedAt) || requestDate.toISOString(),
      )).map((summary) => summary.generationId === venue.generationId ? {
        ...summary,
        bookStatus: venue.book?.status || 'unavailable',
        quotedLineCount: venue.bookQuality?.directLineCount || 0,
        executableLineCount: venue.bookQuality?.executableLineCount || 0,
        volume24h: venue.activity?.volume24h?.value ?? summary.volume24h,
        lines: mergeVenueDisplayContracts(venue).lines,
      } : summary);
      venue = {
        ...venue,
        generations: summaries,
        activity: {
          ...(venue.activity || {}),
          allOpenGenerationsOpenInterest: {
            value: sumPublishedMetric(summaries, 'openInterest'),
            unit: 'contracts',
            scope: 'all_open_generations_sum',
            source: 'forecastex_official_contracts',
            asOf: isoTimestamp(contracts?.fetchedAt) || requestDate.toISOString(),
          },
        },
      };
      if (activityRefreshError) {
        venue.activity = {
          ...venue.activity,
          volume24h: {
            value: null,
            unit: 'contracts',
            scope: 'selected_generation_sum',
            source: null,
            asOf: null,
            status: 'refresh_failed',
            reason: sourceFailure(activityRefreshError, 'ForecastEx execution tape refresh failed.'),
          },
        };
      }
      return liveRefreshError
        ? {
            ...venue,
            book: failedNativeBook(venue.book, liveRefreshError, 'ForecastEx IBKR book refresh failed.'),
            contracts: failedNativeBook(venue.contracts, liveRefreshError, 'ForecastEx IBKR book refresh failed.'),
          }
        : venue;
    } catch (error) {
      const catalog = unavailable(sourceFailure(error, 'ForecastEx contract schedule is unavailable.'), { event: null, lines: [] });
      const book = unavailable('No verified live ForecastEx book is available.', { event: null, lines: [] });
      return {
        id: 'forecastex', label: 'ForecastEx', status: 'unavailable', resolver: config.forecastExResolver,
        equivalenceFingerprint: null, brokerRoutable: false,
        catalog: refreshFailure(catalog, error), book, contracts: book,
        bookQuality: buildBookQuality([]), backgroundRefresh: false, generations: [],
      };
    }
  }

  async function getGenericSnapshot(config, requestDate, selection = {}) {
    const nowMs = requestDate.getTime();
    const requestedVenue = config.id === 'gold'
      ? 'kalshi'
      : ['kalshi', 'forecastex'].includes(String(selection?.venue || '').toLowerCase())
        ? String(selection.venue).toLowerCase()
        : 'auto';
    const requestedGenerationId = String(selection?.generationId || '').trim() || null;
    const goldDailyPinned = config.id === 'gold';
    const configuredSeries = goldDailyPinned
      ? [config.seriesTicker]
      : kalshiSeriesTickers(config);
    const familyLabel = configuredSeries.join('/');
    const kalshiPromise = Promise.allSettled(configuredSeries.map((seriesTicker) => (
      sharedLoad(`kalshi-catalog:${seriesTicker}`, () => kalshiFetch('/events', {
        series_ticker: seriesTicker,
        status: 'open',
        limit: 200,
        min_close_ts: Math.floor(nowMs / 1000),
        max_close_ts: Math.floor((nowMs + config.horizonDays * 24 * 60 * 60_000) / 1000),
        with_nested_markets: true,
      }), 30_000)
    ))).then((seriesResults) => {
      const fulfilled = seriesResults.filter((result) => result.status === 'fulfilled');
      if (!fulfilled.length) throw seriesResults.find((result) => result.status === 'rejected')?.reason || new Error('Kalshi catalog is unavailable.');
      return {
        events: fulfilled.flatMap((result) => Array.isArray(result.value?.events) ? result.value.events : []),
        failedSeries: seriesResults.map((result, index) => result.status === 'rejected' ? {
          seriesTicker: configuredSeries[index],
          reason: sourceFailure(result.reason, 'Kalshi catalog refresh failed.'),
        } : null).filter(Boolean),
      };
    });
    const forecastPromise = config.forecastExProduct && !goldDailyPinned
      ? loadForecastVenue(
          config,
          requestDate,
          requestedVenue === 'forecastex' ? requestedGenerationId : null,
        )
      : Promise.resolve(null);
    const riskPromise = sharedLoad('risk-ranges', () => loadRiskRanges({ now: requestDate }), 15 * 60_000);
    const tradePromise = sharedLoad('trade', () => loadTradeSnapshots({ limit: 2 }));
    const volatilityPromise = sharedLoad('volatility', () => loadVolatilitySnapshot());
    const cftcPromise = config.cftc
      ? sharedLoad('cftc', () => loadCftcSnapshots({ limit: 2 }))
      : Promise.resolve(null);
    const usdPromise = config.usdCorrelationKey
      ? sharedLoad('usd', () => loadUsdSnapshot())
      : Promise.resolve(null);
    const kalshiResult = await settleWithin(kalshiPromise, refreshBudgetMs, 'Kalshi catalog');
    const selected = kalshiResult.status === 'fulfilled'
      ? selectKalshiEvent(
          kalshiResult.value?.events,
          config,
          nowMs,
          requestedVenue === 'kalshi' ? requestedGenerationId : null,
        )
      : null;
    const orderbookPromise = selected
      ? loadKalshiOrderbooks(selected.markets.map((market) => market.ticker))
      : Promise.resolve(new Map());
    const referencePromise = loadReferenceDeduped(config, selected, requestDate);
    const [forecastResult, riskResult, tradeResult, volatilityResult, cftcResult, usdResult, orderbookResult, referenceResult] = await Promise.all([
      settleWithin(forecastPromise, refreshBudgetMs, 'ForecastEx catalog'),
      settleWithin(riskPromise, refreshBudgetMs, 'Risk Range'),
      settleWithin(tradePromise, refreshBudgetMs, 'Trade context'),
      settleWithin(volatilityPromise, refreshBudgetMs, 'volatility context'),
      settleWithin(cftcPromise, refreshBudgetMs, 'CFTC positioning'),
      settleWithin(usdPromise, refreshBudgetMs, 'USD correlation'),
      settleWithin(orderbookPromise, refreshBudgetMs, 'Kalshi native book'),
      settleWithin(referencePromise, refreshBudgetMs, `${config.symbol} reference`),
    ]);
    const results = [kalshiResult, forecastResult, riskResult, tradeResult, volatilityResult, cftcResult, usdResult];
    const pendingResults = [...results, orderbookResult, referenceResult].filter(isPendingResult);
    const reference = referenceResult.status === 'fulfilled' ? referenceResult.value : null;
    const referenceError = referenceResult.status === 'rejected'
      ? sourceFailure(referenceResult.reason, `${config.symbol} resolver reference is unavailable.`)
      : null;
    const kalshiVenue = buildKalshiVenue(
      selected,
      config,
      requestDate,
      orderbookResult.status === 'fulfilled' ? orderbookResult.value : null,
    );
    const kalshiGenerationCandidates = kalshiResult.status === 'fulfilled'
      ? listKalshiEvents(kalshiResult.value?.events, config, nowMs)
      : [];
    kalshiVenue.generations = kalshiGenerationCandidates.map((candidate) => kalshiGenerationSummary(
      candidate,
      config,
      requestDate.toISOString(),
    )).map((summary) => summary.generationId === kalshiVenue.generationId ? {
      ...summary,
      bookStatus: kalshiVenue.book?.status || 'unavailable',
      quotedLineCount: kalshiVenue.bookQuality?.directLineCount || 0,
      executableLineCount: kalshiVenue.bookQuality?.executableLineCount || 0,
      lines: mergeVenueDisplayContracts(kalshiVenue).lines,
    } : summary);
    kalshiVenue.activity = {
      ...(kalshiVenue.activity || {}),
      allOpenGenerationsOpenInterest: {
        value: sumPublishedMetric(kalshiVenue.generations, 'openInterest'),
        unit: 'contracts',
        scope: 'all_open_generations_sum',
        source: 'kalshi_trade_api_v2_catalog',
        asOf: requestDate.toISOString(),
      },
    };
    if (isPendingResult(kalshiResult)) {
      kalshiVenue.catalog = refreshPending(
        unavailable(`The current ${familyLabel} catalog is refreshing.`, { event: null, lines: [] }),
      );
      kalshiVenue.book = refreshPending(
        unavailable(`The current ${familyLabel} native book is refreshing.`, { event: null, lines: [] }),
      );
      kalshiVenue.contracts = kalshiVenue.book;
      kalshiVenue.status = 'refreshing';
    } else if (kalshiResult.status === 'rejected') {
      kalshiVenue.catalog = refreshFailure(
        unavailable(sourceFailure(kalshiResult.reason, 'Kalshi is unavailable.'), { event: null, lines: [] }),
        kalshiResult.reason,
      );
      kalshiVenue.book = unavailable('No verified live Kalshi book is available.', { event: null, lines: [] });
      kalshiVenue.contracts = kalshiVenue.book;
      kalshiVenue.status = 'unavailable';
      kalshiVenue.bookQuality = buildBookQuality([]);
    } else if (isPendingResult(orderbookResult)) {
      kalshiVenue.book = refreshPending(
        unavailable('The current Kalshi native book is refreshing.', {
          event: kalshiVenue.catalog?.event || null,
          lines: [],
        }),
      );
      kalshiVenue.contracts = kalshiVenue.book;
      kalshiVenue.status = kalshiVenue.catalog?.status === 'available' ? 'partial' : 'refreshing';
    } else if (orderbookResult.status === 'rejected') {
      kalshiVenue.book = failedNativeBook(
        kalshiVenue.book,
        orderbookResult.reason,
        'Kalshi native book refresh failed.',
      );
      kalshiVenue.contracts = kalshiVenue.book;
      kalshiVenue.status = kalshiVenue.catalog?.status === 'available' ? 'partial' : 'unavailable';
      kalshiVenue.bookQuality = buildBookQuality([]);
    }
    let forecastVenue = config.forecastExProduct && !goldDailyPinned
      ? forecastResult.status === 'fulfilled'
        ? forecastResult.value
        : buildForecastVenue(null, null, config, requestDate)
      : null;
    let forecastReference = forecastVenue?._resolverReference || null;
    if (forecastVenue?._resolverReference) {
      const { _resolverReference, ...publicForecastVenue } = forecastVenue;
      forecastVenue = publicForecastVenue;
    }
    if (forecastVenue && isPendingResult(forecastResult)) {
      forecastVenue = {
        ...forecastVenue,
        status: 'refreshing',
        catalog: refreshPending(forecastVenue.catalog, 'The current ForecastEx schedule is refreshing.'),
        book: refreshPending(forecastVenue.book, 'The ForecastEx IBKR book is refreshing in the background.'),
        contracts: refreshPending(forecastVenue.contracts, 'The ForecastEx IBKR book is refreshing in the background.'),
        backgroundRefresh: true,
      };
    }
    kalshiVenue.reference = bindVenueReference(
      reference,
      kalshiVenue,
      config,
      isPendingResult(referenceResult)
        ? `${config.symbol} Kalshi reference is refreshing.`
        : referenceError,
    );
    if (forecastVenue) {
      forecastVenue.reference = bindVenueReference(
        forecastReference,
        forecastVenue,
        config,
        forecastVenue.backgroundRefresh ? `${config.symbol} ForecastEx reference is refreshing.` : null,
      );
    }
    const venues = { kalshi: kalshiVenue };
    if (forecastVenue) venues.forecastex = forecastVenue;
    const autoSelection = annotateAutoRefreshFailure(selectAutoVenue(venues, nowMs), venues);
    const displaySelection = selectRequestedVenue(venues, autoSelection, {
      venue: requestedVenue,
      generationId: requestedGenerationId,
    }, {
      standardCadence: config.standardCadence || null,
      preferVerifiedVolume: ['wti', 'brent'].includes(config.id),
    });
    let riskRange = normalizeRiskRange(riskResult.status === 'fulfilled' ? riskResult.value : null, config, nowMs);
    if (isPendingResult(riskResult)) riskRange = refreshPending(riskRange, 'Risk Range is refreshing.');
    else if (riskResult.status === 'rejected') riskRange = refreshFailure(riskRange, riskResult.reason);
    const trade = tradeResult.status === 'fulfilled'
      ? normalizeTrade(tradeResult.value, config, riskRange.date, nowMs)
      : isPendingResult(tradeResult)
        ? refreshPending(
            normalizeTrade(null, config, riskRange.date, nowMs),
            `${config.trade.label} is refreshing.`,
          )
        : refreshFailure(
            normalizeTrade(null, config, riskRange.date, nowMs),
            tradeResult.reason,
          );
    const volatility = Object.fromEntries(config.volatility.map((key) => [
      key,
      volatilityResult.status === 'fulfilled'
        ? normalizeVolatility(volatilityResult.value, key, nowMs)
        : isPendingResult(volatilityResult)
          ? refreshPending(normalizeVolatility(null, key, nowMs), `${key} context is refreshing.`)
          : refreshFailure(normalizeVolatility(null, key, nowMs), volatilityResult.reason),
    ]));
    const cftc = config.cftc
      ? cftcResult.status === 'fulfilled'
        ? selectCftcRow(cftcResult.value, config, nowMs)
        : isPendingResult(cftcResult)
          ? refreshPending(selectCftcRow(null, config, nowMs), 'CFTC positioning is refreshing.')
          : refreshFailure(selectCftcRow(null, config, nowMs), cftcResult.reason)
      : null;
    const usd = config.usdCorrelationKey
      ? usdResult.status === 'fulfilled'
        ? normalizeUsdCorrelation(usdResult.value, config, nowMs)
        : isPendingResult(usdResult)
          ? refreshPending(normalizeUsdCorrelation(null, config, nowMs), 'USD correlation is refreshing.')
          : refreshFailure(normalizeUsdCorrelation(null, config, nowMs), usdResult.reason)
      : null;
    const dxy = config.usdCorrelationKey
      ? usdResult.status === 'fulfilled'
        ? normalizeDxyContext(usdResult.value, nowMs)
        : isPendingResult(usdResult)
          ? refreshPending(normalizeDxyContext(null, nowMs), 'DXY context is refreshing.')
          : refreshFailure(normalizeDxyContext(null, nowMs), usdResult.reason)
      : null;
    const silverRealizedVolatility = config.id === 'silver'
      ? usdResult.status === 'fulfilled'
        ? normalizeSilverRealizedVolatility(usdResult.value, nowMs)
        : isPendingResult(usdResult)
          ? refreshPending(normalizeSilverRealizedVolatility(null, nowMs), 'Silver realized volatility is refreshing.')
          : refreshFailure(normalizeSilverRealizedVolatility(null, nowMs), usdResult.reason)
      : null;
    const brentWtiSpread = config.id === 'brent'
      ? usdResult.status === 'fulfilled'
        ? normalizeBrentWtiSpread(usdResult.value, nowMs)
        : isPendingResult(usdResult)
          ? refreshPending(normalizeBrentWtiSpread(null, nowMs), 'Brent–WTI spread is refreshing.')
          : refreshFailure(normalizeBrentWtiSpread(null, nowMs), usdResult.reason)
      : null;
    const factors = {
      trade,
      ...volatility,
      ...(cftc ? { cftc } : {}),
      ...(dxy ? { dxy } : {}),
      ...(usd ? { usd } : {}),
      ...(silverRealizedVolatility ? { silverRealizedVolatility } : {}),
      ...(brentWtiSpread ? { brentWtiSpread } : {}),
    };
    const anyContracts = Object.values(venues).some((venue) => venue.catalog?.status === 'available');
    const errors = [
      ...results.map((result) => result.status === 'rejected' ? sourceFailure(result.reason) : null),
      ...(kalshiResult.status === 'fulfilled' ? (kalshiResult.value?.failedSeries || []).map((failure) => (
        `${failure.seriesTicker}: ${failure.reason}`
      )) : []),
      orderbookResult.status === 'rejected' ? sourceFailure(orderbookResult.reason) : null,
      referenceError,
    ].filter(Boolean);
    let selectedReference = venues[displaySelection.venueId]?.reference
      || bindVenueReference(null, null, config);
    const incomingBasisReference = selectedReference?.chartReferences?.basis || selectedReference;
    const incomingContractReference = selectedReference?.chartReferences?.contract
      || monitorChartReference({
        role: selectedReference?.fit === 'exact' ? 'contract_reference' : 'proxy_reference',
        symbol: selectedReference?.instrument?.displaySymbol || selectedReference?.spot?.label || config.symbol,
        riskRangeTicker: config.riskRange.ticker,
        reference: selectedReference,
        exact: selectedReference?.fit === 'exact',
        disclosure: selectedReference?.spot?.reason || null,
      });
    const gatedBasis = applyDirectionalBasisGate(riskRange, incomingBasisReference);
    riskRange = gatedBasis.riskRange;
    const chartReferences = {
      basis: gatedBasis.reference,
      contract: incomingContractReference,
    };
    selectedReference = {
      ...selectedReference,
      chartReferences,
      basisValidation: gatedBasis.basisValidation,
    };
    if (displaySelection.venueId && venues[displaySelection.venueId]) {
      venues[displaySelection.venueId] = {
        ...venues[displaySelection.venueId],
        reference: selectedReference,
      };
    }
    const spot = chartReferences.basis?.spot || selectedReference.spot;
    const chart = chartReferences.basis?.chart || selectedReference.chart;
    const sessionOpen = selected || Object.values(venues).some((venue) => venue.contracts?.event?.status === 'open');
    const generationOptions = generationOptionsFromVenues(venues);
    const selectedGenerationId = displaySelection.generationId
      || displaySelection.contracts?.event?.generationId
      || displaySelection.contracts?.event?.ticker
      || null;
    const selectedGeneration = generationOptions.find((generation) => (
      generation.venueId === displaySelection.venueId
      && generation.generationId === selectedGenerationId
    )) || null;
    const productActivity = displaySelection.venueId && venues[displaySelection.venueId]
      ? venues[displaySelection.venueId].activity || null
      : null;
    const sourceHealth = buildSourceHealth({ config, venues, reference: selectedReference, riskRange });
    return {
      schemaVersion: 2,
      marketId: config.id,
      displayName: config.fullLabel,
      symbol: config.symbol,
      precision: config.precision,
      unit: config.unit,
      generatedAt: requestDate.toISOString(),
      status: autoSelection.status === 'available' ? 'partial' : anyContracts ? 'partial' : 'unavailable',
      session: { state: sessionOpen ? 'open' : 'closed', asOf: requestDate.toISOString() },
      resolverMetadata: {
        kalshi: kalshiVenue.resolver || config.kalshiResolver,
        ...(config.forecastExResolver ? { forecastex: config.forecastExResolver } : {}),
        reference: selectedReference.resolver || null,
      },
      spot,
      chart,
      chartReferences,
      resolverReference: selectedReference,
      ...(config.id === 'gold' ? {
        resolverTracking: selectedReference?.resolverTracking || null,
        goldMarketReferences: Array.isArray(selectedReference?.goldMarketReferences)
          && selectedReference.goldMarketReferences.length === 3
          ? selectedReference.goldMarketReferences
          : unavailableGoldMarketReferences(
              displaySelection.venueId,
              selectedReference?.backgroundRefresh === true
                ? 'Verified Gold market references are loading.'
                : 'Verified Gold market references are unavailable.',
            ),
      } : {}),
      directionalFeed: selectedReference.directionalFeed || null,
      basisValidation: gatedBasis.basisValidation,
      riskRange,
      factors,
      factorRows: genericFactorRows(config, riskRange, factors),
      scoreInputs: {
        riskRange: {
          lrr: riskRange.lrr,
          hrr: riskRange.hrr,
          trend: riskRange.trend,
          date: riskRange.date,
          ticker: riskRange.ticker,
        },
        trade: {
          direction: trade.direction,
          raw: trade.raw,
          date: trade.date,
          ticker: trade.ticker,
          source: trade.source,
        },
      },
      venues,
      generationOptions,
      selectedGeneration,
      selectedGenerationId,
      selectedVenueId: displaySelection.venueId,
      selection: {
        requestedVenue,
        requestedGenerationId,
        venueId: displaySelection.venueId,
        generationId: selectedGenerationId,
        reason: requestedVenue === 'auto'
          ? autoSelection.reason
          : displaySelection.reason,
      },
      productActivity,
      sourceHealth,
      autoSelection,
      displaySelection,
      displayContracts: displaySelection.contracts,
      contracts: displaySelection.contracts,
      executionContracts: autoSelection.contracts,
      sourceRefreshPending: pendingResults.length > 0
        || selectedReference?.backgroundRefresh === true
        || Object.values(venues).some((venue) => venue.backgroundRefresh === true),
      strategy: {
        status: 'unavailable',
        model: null,
        eligibleVenueId: null,
        reason: `No validated ${config.fullLabel} prediction-contract strategy or sizing model is configured.`,
      },
      errors,
    };
  }

  async function getSnapshot(marketId, selection = {}) {
    const config = MARKET_CONFIGS[marketId];
    if (!config) {
      const error = new Error(`Unsupported prediction-market monitor: ${marketId}`);
      error.code = 'PM_MONITOR_UNSUPPORTED_MARKET';
      error.status = 400;
      throw error;
    }
    const requestDate = now();
    if (marketId === 'cpi') {
      return getCpiSnapshot(config, requestDate);
    }
    if (marketId === 'sp500') {
      const workerBudgetMs = Math.max(refreshBudgetMs, SPX_REFRESH_BUDGET_MS);
      const forecastOnly = config.venueIds?.length === 1 && config.venueIds[0] === 'forecastex';
      if (forecastOnly) {
        const [spxResult, forecastResult] = await Promise.all([
          settleWithin(
            spxMonitorService.getSnapshot({ includeContracts: false }),
            workerBudgetMs,
            'SP500 research context',
          ),
          settleWithin(
            loadForecastVenue(config, requestDate, null),
            workerBudgetMs,
            'ForecastEx FES catalog',
          ),
        ]);
        const spx = spxResult.status === 'fulfilled' ? spxResult.value : {
          schemaVersion: 1,
          generatedAt: requestDate.toISOString(),
          status: 'refreshing',
          session: { state: 'unknown', asOf: requestDate.toISOString() },
          spot: refreshPending(unavailable('SPX research reference is refreshing.', { value: null, label: 'SPX' })),
          chart: refreshingSpxChart(),
          riskRange: refreshPending(unavailable('SPX Risk Range is refreshing.', { lrr: null, hrr: null, trend: null })),
          factors: {},
          scoreInputs: {},
          contracts: unavailable('Only ForecastEx FES contracts are configured.', { event: null, lines: [] }),
          sourceRefreshPending: true,
          errors: [],
        };
        let forecastVenue = forecastResult.status === 'fulfilled'
          ? forecastResult.value
          : buildForecastVenue(null, null, config, requestDate);
        const prefetchedResolverReference = forecastVenue?._resolverReference || null;
        if (forecastVenue?._resolverReference) {
          const { _resolverReference, ...publicForecastVenue } = forecastVenue;
          forecastVenue = publicForecastVenue;
        }
        if (isPendingResult(forecastResult)) {
          forecastVenue = {
            ...forecastVenue,
            status: 'refreshing',
            catalog: refreshPending(forecastVenue.catalog, 'The current ForecastEx FES schedule is refreshing.'),
            book: refreshPending(forecastVenue.book, 'The ForecastEx FES IBKR book is refreshing in the background.'),
            contracts: refreshPending(forecastVenue.contracts, 'The ForecastEx FES IBKR book is refreshing in the background.'),
            backgroundRefresh: true,
          };
        }
        const tenDayChart = spx?.chart?.variants?.['10d'];
        const deferResolverReference = spx?.sourceRefreshPending === true
          && (tenDayChart?.status === 'refreshing' || tenDayChart?.refreshing === true);
        const resolverReferenceResult = prefetchedResolverReference
          ? { status: 'fulfilled', value: prefetchedResolverReference }
          : deferResolverReference
          ? { status: 'pending' }
          : await settleWithin(
              loadReferenceDeduped(config, forecastVenue, requestDate),
              workerBudgetMs,
              'FES exact ES resolver reference',
            );
        const resolverReference = resolverReferenceResult.status === 'fulfilled'
          ? resolverReferenceResult.value
          : isPendingResult(resolverReferenceResult)
            ? refreshingResolverReference(forecastVenue?.resolverIdentity?.resolverSymbol || null)
            : null;
        return wrapSpxSnapshot({
          ...spx,
          sourceRefreshPending: spx.sourceRefreshPending === true
            || isPendingResult(spxResult)
            || isPendingResult(forecastResult)
            || isPendingResult(resolverReferenceResult),
        }, forecastVenue, config, requestDate, null, resolverReference, null, {
          venue: 'forecastex',
          generationId: null,
        });
      }
      const requestedVenue = ['kalshi', 'forecastex'].includes(String(selection?.venue || '').toLowerCase())
        ? String(selection.venue).toLowerCase()
        : 'auto';
      const requestedGenerationId = String(selection?.generationId || '').trim() || null;
      const spxKalshiCatalogPromise = kalshiFetch('/events', {
        series_ticker: config.seriesTicker,
        status: 'open',
        limit: 200,
        min_close_ts: Math.floor(requestDate.getTime() / 1000),
        max_close_ts: Math.floor((requestDate.getTime() + config.horizonDays * 24 * 60 * 60_000) / 1000),
        with_nested_markets: true,
      });
      const [spxResult, forecastResult, spxKalshiCatalogResult] = await Promise.all([
        settleWithin(spxMonitorService.getSnapshot(), workerBudgetMs, 'SP500 monitor core'),
        settleWithin(loadForecastVenue(
          config,
          requestDate,
          requestedVenue === 'forecastex' ? requestedGenerationId : null,
        ), workerBudgetMs, 'ForecastEx catalog'),
        settleWithin(spxKalshiCatalogPromise, workerBudgetMs, 'Kalshi generation catalog'),
      ]);
      const spx = spxResult.status === 'fulfilled' ? spxResult.value : {
        schemaVersion: 1,
        generatedAt: requestDate.toISOString(),
        status: 'refreshing',
        session: { state: 'unknown', asOf: requestDate.toISOString() },
        spot: refreshPending(unavailable('SPX reference is refreshing.', { value: null, label: 'SPX' })),
        chart: refreshingSpxChart(),
        riskRange: refreshPending(unavailable('SPX Risk Range is refreshing.', { lrr: null, hrr: null, trend: null })),
        factors: {},
        scoreInputs: {},
        contracts: refreshPending(unavailable('The current KXINXU catalog is refreshing.', { event: null, lines: [] })),
        sourceRefreshPending: true,
        errors: [],
      };
      let forecastVenue = forecastResult.status === 'fulfilled'
        ? forecastResult.value
        : buildForecastVenue(null, null, config, requestDate);
      const prefetchedResolverReference = forecastVenue?._resolverReference || null;
      if (forecastVenue?._resolverReference) {
        const { _resolverReference, ...publicForecastVenue } = forecastVenue;
        forecastVenue = publicForecastVenue;
      }
      if (isPendingResult(forecastResult)) {
        forecastVenue = {
          ...forecastVenue,
          status: 'refreshing',
          catalog: refreshPending(forecastVenue.catalog, 'The current ForecastEx schedule is refreshing.'),
          book: refreshPending(forecastVenue.book, 'The ForecastEx IBKR book is refreshing in the background.'),
          contracts: refreshPending(forecastVenue.contracts, 'The ForecastEx IBKR book is refreshing in the background.'),
          backgroundRefresh: true,
        };
      }
      let orderbooks = null;
      let orderbooksPending = false;
      const spxKalshiCandidates = spxKalshiCatalogResult.status === 'fulfilled'
        ? listKalshiEvents(spxKalshiCatalogResult.value?.events, config, requestDate.getTime())
        : [];
      const selectedKalshi = requestedVenue === 'kalshi' && requestedGenerationId
        ? spxKalshiCandidates.find((candidate) => candidate.generationId === requestedGenerationId) || null
        : spxKalshiCandidates[0] || null;
      const tickers = selectedKalshi
        ? selectedKalshi.markets.map((market) => market.ticker).filter(Boolean)
        : (spx?.contracts?.lines || []).map((line) => line.ticker).filter(Boolean);
      const [resolverReferenceResult, orderbookResult] = await Promise.all([
        prefetchedResolverReference
          ? Promise.resolve({ status: 'fulfilled', value: prefetchedResolverReference })
          : settleWithin(
              loadReferenceDeduped(config, forecastVenue, requestDate),
              workerBudgetMs,
              'FES exact ES resolver reference',
            ),
        tickers.length
          ? settleWithin(loadKalshiOrderbooks(tickers), workerBudgetMs, 'Kalshi native book')
          : Promise.resolve({ status: 'fulfilled', value: null }),
      ]);
      const resolverReference = resolverReferenceResult.status === 'fulfilled'
        ? resolverReferenceResult.value
        : isPendingResult(resolverReferenceResult)
          ? refreshingResolverReference(forecastVenue?.resolverIdentity?.resolverSymbol || null)
          : null;
      if (tickers.length) {
        orderbooks = orderbookResult.status === 'fulfilled' ? orderbookResult.value : null;
        orderbooksPending = isPendingResult(orderbookResult);
      }
      let kalshiVenueOverride = selectedKalshi
        ? buildKalshiVenue(selectedKalshi, config, requestDate, orderbooks)
        : null;
      if (kalshiVenueOverride) {
        kalshiVenueOverride.generations = spxKalshiCandidates.map((candidate) => kalshiGenerationSummary(
          candidate,
          config,
          requestDate.toISOString(),
        )).map((summary) => summary.generationId === kalshiVenueOverride.generationId ? {
          ...summary,
          bookStatus: kalshiVenueOverride.book?.status || 'unavailable',
          quotedLineCount: kalshiVenueOverride.bookQuality?.directLineCount || 0,
          executableLineCount: kalshiVenueOverride.bookQuality?.executableLineCount || 0,
          lines: mergeVenueDisplayContracts(kalshiVenueOverride).lines,
        } : summary);
        kalshiVenueOverride.activity = {
          ...(kalshiVenueOverride.activity || {}),
          allOpenGenerationsOpenInterest: {
            value: sumPublishedMetric(kalshiVenueOverride.generations, 'openInterest'),
            unit: 'contracts',
            scope: 'all_open_generations_sum',
            source: 'kalshi_trade_api_v2_catalog',
            asOf: requestDate.toISOString(),
          },
        };
      }
      return wrapSpxSnapshot({
        ...spx,
        sourceRefreshPending: spx.sourceRefreshPending === true
          || isPendingResult(spxResult)
          || isPendingResult(forecastResult)
          || isPendingResult(spxKalshiCatalogResult)
          || isPendingResult(resolverReferenceResult)
          || orderbooksPending,
      }, forecastVenue, config, requestDate, orderbooks, resolverReference, kalshiVenueOverride, {
        venue: requestedVenue,
        generationId: requestedGenerationId,
      });
    }
    return getGenericSnapshot(config, requestDate, selection);
  }

  return { getSnapshot };
}

module.exports = {
  CONTRACT_MAX_AGE_MS,
  FES_COLD_START_MAX_LINES,
  FES_CORE_LINES_PER_SIDE,
  FES_LIQUID_EXTRAS_PER_SIDE,
  FES_LIQUID_EXTRA_THRESHOLD,
  MARKET_CONFIGS,
  MARKET_IDS,
  buildBookQuality,
  buildCpiForecastComparison,
  buildForecastSettlementBasis,
  buildKalshiSettlementBasis,
  buildContractGeometry,
  buildEquivalenceFingerprint,
  buildSourceHealth,
  createMarketMonitorService,
  chunkKalshiTickers,
  generationOptionsFromVenues,
  inferGenerationCadence,
  listForecastGenerations,
  listKalshiEvents,
  mergeExactVenueContracts,
  mergeVenueDisplayContracts,
  normalizeKalshiOrderbookResponse,
  selectAutoVenue,
  selectDisplayVenue,
  selectForecastGeneration,
  selectForecastContractUniverse,
  selectExactCpiKalshiEvent,
  selectKalshiEvent,
  selectRequestedVenue,
  settlementBasisUnavailable,
};
