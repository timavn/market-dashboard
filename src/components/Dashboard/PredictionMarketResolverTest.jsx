import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useSurfaceActivity } from '../common/PersistentSurface';
import LoadingIndicator from '../common/LoadingIndicator';
import { useDashboardResource } from '../../hooks/useDashboardResource';
import { useSessionResource } from '../../hooks/useSessionResource';
import { MarketDataService } from '../../services/api/marketDataService';
import predictionMarketTestService from '../../services/api/predictionMarketTestService';
import { isExplicitLiveInvalidation } from '../../utils/sessionResourceStore';
import { canonicalPredictionMonitorVenue } from '../../utils/predictionMonitorIdentity';
import DelayedDataMarker from './DelayedDataMarker';
import ResourceDataStatusChip from './ResourceDataStatusChip';
import { locateSpxLivePrice } from '../../utils/spxClosePredictionMarket';
import { buildSpxCloseConfluence } from '../../utils/spxCloseConfluence';
import { getBucketForSeries } from '../../utils/volatilityRegimes';
import usEquityMarketCalendar from '../../utils/usEquityMarketCalendar.cjs';
import predictionMarketAth from '../../utils/predictionMarketAth.cjs';
import {
  buildSpxStrategyCandidates,
  defaultSpxStrategyMix,
  resolveVerifiedPortfolioSizingBase,
  sizeSpxStrategy,
} from '../../utils/spxStrategySizing';
import './PredictionMarketResolverTest.css';

const {
  addCalendarDays: addUsEquityCalendarDays,
  closedUsEquityDatesBetween,
} = usEquityMarketCalendar;

const {
  retainVerifiedAthWhilePending,
  synchronizeVerifiedAthAcrossChartRanges,
} = predictionMarketAth;

const POLL_MS = 5_000;
const CLOSED_POLL_MS = 30_000;
const CLOCK_TICK_MS = 1_000;
const POSITION_MAX_AGE_MS = 60_000;
const HEADER_QUOTE_MAX_AGE_MS = 60_000;
const HEADER_CURRENT_BAR_MAX_AGE_MS = 10 * 60_000;
const MOMO_TRACKER_POLL_MS = 15 * 60_000;
const MOMO_SPOT_POLL_MS = 15_000;
const MOMO_SPOT_MAX_AGE_MS = 60_000;
const GOLD_CORRELATION_POLL_MS = 60 * 60_000;
const GOLD_CORRELATION_RETRY_POLL_MS = 10_000;
const GOLD_CORRELATION_MAX_AGE_MS = 75 * 60_000;
const GOLD_CORRELATION_DAILY_MAX_AGE_MS = 5 * 24 * 60 * 60_000;
const GOLD_CORRELATION_HORIZONS = Object.freeze(['15D', '30D', '90D', '120D', '180D']);
const GOLD_CORRELATION_SHADE_THRESHOLD = 0.5;
const GOLD_CORRELATION_STRONG_THRESHOLD = 0.7;
const INITIAL_ONE_DAY_CHART_DIMENSION = Object.freeze({ width: 540, height: 185 });
const INITIAL_MULTI_DAY_CHART_DIMENSION = Object.freeze({ width: 1080, height: 185 });
const GOLD_CORRELATION_OBSERVATIONS = Object.freeze({
  '15D': 15,
  '30D': 30,
  '90D': 90,
  '120D': 120,
  '180D': 180,
});
const GOLD_CORRELATION_ROW_KEYS = Object.freeze([
  'DXY', 'UST10Y_REAL', 'UST10Y_NOMINAL', 'SPX', 'SILVER', 'CRB', 'WTI',
]);
const GOLD_CORRELATION_LAST_UNITS = Object.freeze({
  DXY: 'index',
  UST10Y_REAL: 'percent',
  UST10Y_NOMINAL: 'percent',
  SPX: 'index',
  SILVER: 'USD/ozt',
  CRB: 'index',
  WTI: 'USD/bbl',
});
const MOMO_TRACKER_LEGACY_ROW_COUNT = 9;
const MOMO_TRACKER_MIN_ROW_COUNT = 8;
const MOMO_TRACKER_MAX_ROW_COUNT = 25;
const MOMO_TRACKER_TRENDS = new Set(['BULLISH', 'BEARISH', 'NEUTRAL']);
const MOMO_TRACKER_TICKER_ORDER = new Map([
  'MSFT', 'AAPL', 'AMZN', 'META', 'GOOGL', 'NFLX', 'TSLA', 'NVDA', 'SNDK', 'ORCL',
].map((ticker, index) => [ticker, index]));
const FORBIDDEN_SPX_HEADER_REFERENCE_SOURCE = /(?:mock|seed|fixture|fallback|cache|portfolio|delayed|frozen|stale|offline|disconnected|synthetic|inferred|derived)/i;
const CONTRACT_COLUMN_COUNT = 9;
const SPX_CONTRACT_LINES_PER_SIDE = 5;
const VENUE_OPTIONS = Object.freeze([
  Object.freeze({ id: 'auto', label: 'Auto' }),
  Object.freeze({ id: 'kalshi', label: 'Kalshi' }),
  Object.freeze({ id: 'forecastex', label: 'ForecastEx' }),
]);
const MARKET_UI = Object.freeze({
  cpi: Object.freeze({
    label: 'CPI',
    fullLabel: 'Headline CPI YoY',
    symbol: 'CPI',
    precision: 1,
    simplified: true,
    defaultVenue: 'kalshi',
    venueIds: Object.freeze(['kalshi']),
    fixedContract: Object.freeze({ venueId: 'kalshi', venueLabel: 'Kalshi', productCode: 'KXCPIYOY' }),
  }),
  sp500: Object.freeze({
    label: 'SP500',
    fullLabel: 'S&P 500',
    symbol: 'SPX',
    precision: 0,
    spotPrecision: 2,
    defaultVenue: 'auto',
    venueIds: Object.freeze(['forecastex']),
    simplified: true,
    chartCalendar: 'us_equity',
    fixedContract: Object.freeze({ venueId: 'forecastex', venueLabel: 'ForecastEx', productCode: 'FES' }),
  }),
  wti: Object.freeze({
    label: 'WTI', fullLabel: 'WTI Oil', symbol: 'WTI', precision: 2, simplified: true, chartCalendar: 'weekday',
  }),
  nasdaq100: Object.freeze({ label: 'Nasdaq', fullLabel: 'Nasdaq-100', symbol: 'NDX', precision: 0, simplified: false }),
  gold: Object.freeze({
    label: 'Gold', fullLabel: 'Gold', symbol: 'GOLD', precision: 1, simplified: true, chartCalendar: 'weekday',
    defaultVenue: 'kalshi',
    venueIds: Object.freeze(['kalshi']),
    fixedContract: Object.freeze({ venueId: 'kalshi', venueLabel: 'Kalshi', productCode: 'KXGOLDD' }),
  }),
  silver: Object.freeze({
    label: 'Silver', fullLabel: 'Silver', symbol: 'SILVER', precision: 2, simplified: true, chartCalendar: 'weekday',
  }),
  brent: Object.freeze({
    label: 'Brent', fullLabel: 'Brent Oil', symbol: 'BRENT', precision: 2, simplified: true, chartCalendar: 'weekday',
  }),
  bitcoin: Object.freeze({
    label: 'Bitcoin', fullLabel: 'Bitcoin', symbol: 'BTC', precision: 0, spotPrecision: 2, simplified: true,
    chartCalendar: 'continuous',
  }),
});

const finite = (value) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));

const FORBIDDEN_GOLD_CONTEXT_PROVENANCE = /(?:mock|seed|fixture|fallback|cache(?:d|[_ -]?only)?|portfolio|delayed|frozen|stale|offline|disconnected|synthetic|inferred|derived)/i;
const GOLD_SETTLEMENT_SOURCE = 'kalshi_finalized_expiration_value';
const GOLD_SETTLEMENT_INSTRUMENT = 'Metal.Index.GOLD/USD';
const GOLD_EVENT_MONTH_CODES = Object.freeze(['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']);

const unavailableGoldCorrelationSnapshot = (reason) => ({
  status: 'unavailable',
  method: 'pearson_completed_daily_changes',
  horizons: GOLD_CORRELATION_HORIZONS,
  basis: null,
  rows: [],
  timestamp: null,
  reason: reason || 'Verified Gold correlation data is unavailable.',
});

const freshDatedObservation = (value, nowMs, maxAgeMs = GOLD_CORRELATION_DAILY_MAX_AGE_MS) => {
  const token = String(value || '').slice(0, 10);
  const asOfMs = /^\d{4}-\d{2}-\d{2}$/.test(token)
    ? Date.parse(`${token}T23:59:59.999Z`)
    : Date.parse(value || '');
  const ageMs = Number(nowMs) - asOfMs;
  return Number.isFinite(asOfMs) && ageMs >= -24 * 60 * 60_000 && ageMs <= maxAgeMs;
};

export function normalizeGoldCorrelationSnapshot(payload = {}, nowMs = Date.now()) {
  const timestampMs = Date.parse(payload?.timestamp || '');
  const timestampAge = Number(nowMs) - timestampMs;
  const basisSource = String(payload?.basis?.source || '');
  const provenance = [
    payload?.warning,
    payload?.provenance,
    payload?.cacheState,
    payload?.cachedOnly ? 'cached-only' : null,
    payload?.fromCache ? 'cached' : null,
    payload?.mock ? 'mock' : null,
    payload?.seeded ? 'seed' : null,
    basisSource,
  ].filter(Boolean).join(' ');
  const horizonsValid = Array.isArray(payload?.horizons)
    && payload.horizons.length === GOLD_CORRELATION_HORIZONS.length
    && payload.horizons.every((horizon, index) => horizon === GOLD_CORRELATION_HORIZONS[index]);
  const basisValid = ['available', 'partial'].includes(String(payload?.status || '').toLowerCase())
    && payload?.method === 'pearson_completed_daily_changes'
    && horizonsValid
    && payload?.basis?.status === 'available'
    && String(payload?.basis?.symbol || '').toUpperCase() === 'XAUUSD'
    && payload?.basis?.role === 'proxy'
    && /^IBKR\b/i.test(basisSource)
    && !FORBIDDEN_GOLD_CONTEXT_PROVENANCE.test(provenance)
    && Number.isFinite(timestampMs)
    && timestampAge >= -5_000
    && timestampAge <= GOLD_CORRELATION_MAX_AGE_MS
    && freshDatedObservation(payload?.basis?.asOf, nowMs);
  if (!basisValid) {
    return unavailableGoldCorrelationSnapshot(
      payload?.reason || payload?.basis?.reason || 'The verified IBKR XAUUSD correlation basis is unavailable.',
    );
  }

  const incomingRows = new Map((Array.isArray(payload?.rows) ? payload.rows : [])
    .map((row) => [String(row?.key || '').toUpperCase(), row]));
  const rows = GOLD_CORRELATION_ROW_KEYS.map((key) => {
    const row = incomingRows.get(key);
    const source = String(row?.source || '');
    const sourceValid = key.startsWith('UST10Y_') ? /^FRED\b/i.test(source) : /^Yahoo Finance\b/i.test(source);
    const rowProvenance = [
      source,
      row?.warning,
      row?.provenance,
      row?.cacheState,
      row?.cachedOnly ? 'cached-only' : null,
      row?.fromCache ? 'cached' : null,
      row?.mock ? 'mock' : null,
      row?.seeded ? 'seed' : null,
      row?.latest?.warning,
      row?.latest?.provenance,
      row?.latest?.cacheState,
      row?.latest?.cachedOnly ? 'cached-only' : null,
      row?.latest?.fromCache ? 'cached' : null,
      row?.latest?.mock ? 'mock' : null,
      row?.latest?.seeded ? 'seed' : null,
    ].filter(Boolean).join(' ');
    const expectedTransform = key.startsWith('UST10Y_') ? 'yield_change_bps' : 'price_return';
    const observations = Number.isFinite(Number(row?.observations)) ? Number(row.observations) : 0;
    const rowValid = ['available', 'partial'].includes(String(row?.status || '').toLowerCase())
      && sourceValid
      && row?.transform === expectedTransform
      && !FORBIDDEN_GOLD_CONTEXT_PROVENANCE.test(rowProvenance)
      && freshDatedObservation(row?.asOf, nowMs);
    const expectedLatestUnit = GOLD_CORRELATION_LAST_UNITS[key];
    const latestValid = rowValid
      && finite(row?.latest?.value)
      && (expectedTransform === 'yield_change_bps' || Number(row.latest.value) > 0)
      && row?.latest?.unit === expectedLatestUnit
      && row?.latest?.asOf === row?.asOf
      && freshDatedObservation(row.latest.asOf, nowMs);
    const values = Object.fromEntries(GOLD_CORRELATION_HORIZONS.map((horizon) => {
      const value = rowValid && finite(row?.values?.[horizon])
        && observations >= GOLD_CORRELATION_OBSERVATIONS[horizon]
        && Number(row.values[horizon]) >= -1 && Number(row.values[horizon]) <= 1
        ? Number(row.values[horizon])
        : null;
      return [horizon, value];
    }));
    const availableCount = Object.values(values).filter(finite).length;
    return {
      key,
      label: row?.label || key,
      symbol: row?.symbol || key,
      status: availableCount === GOLD_CORRELATION_HORIZONS.length
        ? 'available'
        : availableCount > 0 ? 'partial' : 'unavailable',
      source: sourceValid ? source : null,
      transform: row?.transform || null,
      asOf: rowValid ? row.asOf : null,
      observations: rowValid ? observations : 0,
      latest: {
        value: latestValid ? Number(row.latest.value) : null,
        asOf: latestValid ? row.latest.asOf : null,
        unit: expectedLatestUnit,
      },
      values,
      reason: availableCount > 0 ? row?.reason || null : row?.reason || `Verified ${row?.label || key} history is unavailable.`,
    };
  });
  const availableRows = rows.filter((row) => ['available', 'partial'].includes(row.status)).length;
  return {
    status: availableRows === rows.length ? 'available' : availableRows > 0 ? 'partial' : 'unavailable',
    method: payload.method,
    horizons: GOLD_CORRELATION_HORIZONS,
    basis: {
      symbol: 'XAUUSD',
      label: payload.basis.label || 'IBKR XAUUSD Spot Gold',
      role: 'proxy',
      status: 'available',
      source: basisSource,
      asOf: payload.basis.asOf,
      unit: payload.basis.unit || 'USD/ozt',
      reason: payload.basis.reason || null,
    },
    rows,
    timestamp: new Date(timestampMs).toISOString(),
    calculationDate: payload.calculationDate || payload.basis.asOf,
    reason: availableRows ? null : payload?.reason || 'No verified Gold correlation rows are available.',
  };
}

export const isGoldCorrelationSnapshotUsable = (snapshot, nowMs = Date.now()) => {
  const timestampMs = Date.parse(snapshot?.timestamp || '');
  const ageMs = Number(nowMs) - timestampMs;
  return ['available', 'partial'].includes(snapshot?.status)
    && snapshot?.basis?.status === 'available'
    && Number.isFinite(timestampMs)
    && ageMs >= -5_000
    && ageMs <= GOLD_CORRELATION_MAX_AGE_MS;
};

export function withCanonicalGoldCorrelationFactor(snapshot, correlationSnapshot, nowMs = Date.now()) {
  if (!snapshot || snapshot?.marketId !== 'gold') return snapshot;
  const usable = isGoldCorrelationSnapshotUsable(correlationSnapshot, nowMs);
  const dxy = usable
    ? correlationSnapshot.rows.find((row) => row.key === 'DXY')
    : null;
  const correlationValue = finite(dxy?.values?.['30D']) ? Number(dxy.values['30D']) : null;
  const correlationReplacement = {
    id: 'usd',
    label: 'XAUUSD/DXY 30D RETURN CORRELATION',
    status: correlationValue == null ? 'unavailable' : 'available',
    value: correlationValue,
    displayValue: correlationValue == null ? null : `${correlationValue > 0 ? '+' : ''}${correlationValue.toFixed(2)}`,
    source: correlationValue == null ? null : dxy.source,
    asOf: correlationValue == null ? null : dxy.asOf,
    fit: 'context_only',
    decisionEligible: false,
    note: correlationValue == null
      ? correlationSnapshot?.reason || dxy?.reason || 'Verified XAUUSD/DXY return correlation is unavailable.'
      : 'Completed-session return correlation context only; never an executable price or scoring input.',
  };
  const rows = Array.isArray(snapshot.factorRows) ? snapshot.factorRows : [];
  const existingDxy = rows.find((row) => row?.id === 'dxy');
  const canonicalDxyValue = finite(dxy?.latest?.value) ? Number(dxy.latest.value) : null;
  const dxyReplacement = canonicalDxyValue == null ? existingDxy || {
    id: 'dxy',
    label: 'DXY · LAST CLOSE',
    status: 'unavailable',
    value: null,
    displayValue: null,
    source: null,
    asOf: null,
    fit: 'completed_session',
    decisionEligible: false,
    note: 'Verified completed-session DXY context is unavailable.',
  } : {
    id: 'dxy',
    label: 'DXY · LAST CLOSE',
    status: 'historical',
    availability: 'historical',
    value: canonicalDxyValue,
    displayValue: canonicalDxyValue.toFixed(2),
    source: dxy.source,
    asOf: dxy.latest.asOf,
    historicalThroughDate: dxy.latest.asOf,
    fit: 'completed_session',
    decisionEligible: false,
    note: 'Completed-session DXY close; dollar-strength context only, not an executable price or scoring input.',
  };
  return {
    ...snapshot,
    factorRows: [
      dxyReplacement,
      correlationReplacement,
      ...rows.filter((row) => !['dxy', 'usd'].includes(row?.id)),
    ],
  };
}

const normalizedStatus = (value) => String(value || '').trim().toLowerCase();
const firstPresent = (...values) => values.find((value) => value !== null && value !== undefined && value !== '');

const headerQuoteState = (symbol, status, reason) => ({
  symbol,
  status,
  price: null,
  previousClose: null,
  changePercent: null,
  asOf: null,
  source: null,
  reason,
});

const unavailableSpxHeaderQuotes = (reason) => ({
  status: 'unavailable',
  spy: headerQuoteState('SPY', 'unavailable', reason || 'The verified-live IBKR SPY quote is unavailable.'),
});

export function normalizeVerifiedSpxHeaderQuotes(quotes = {}, providerStatus = null, nowMs = Date.now()) {
  const providerConnected = providerStatus?.ibkr?.connected === true;
  const quote = quotes?.SPY;
  const symbol = String(quote?.symbol || '').trim().toUpperCase();
  const source = normalizedStatus(quote?.source);
  const dataType = normalizedStatus(quote?.dataType);
  const price = finite(quote?.last) ? Number(quote.last) : null;
  const previousClose = finite(quote?.previousClose) && Number(quote.previousClose) > 0
    ? Number(quote.previousClose)
    : null;
  const changePercent = previousClose != null && finite(quote?.changePercent)
    ? Number(quote.changePercent)
    : null;
  const asOfMs = Date.parse(quote?.timestamp || '');
  const ageMs = Number(nowMs) - asOfMs;
  const provenance = [
    quote?.warning,
    quote?.error,
    quote?.freshness,
    quote?.sourceStatus,
    quote?.fromCache ? 'cache' : null,
    quote?.cacheOnly ? 'cache-only' : null,
    quote?.mock ? 'mock' : null,
    quote?.seeded ? 'seed' : null,
    quote?.fallback ? 'fallback' : null,
  ].filter(Boolean).join(' ');
  const forbiddenProvenance = /delayed|frozen|stale|cache(?:d|[_ -]?only)?|mock|seed|fallback|offline|disconnected|historical|synthetic|inferred|derived/i;
  const deniedEntitlement = /denied|unavailable|not[_ -]?subscribed|not[_ -]?entitled|no[_ -]?permission/i;
  const verified = providerConnected
    && symbol === 'SPY'
    && source === 'ibkr'
    && dataType === 'live'
    && price != null
    && price > 0
    && Number.isFinite(asOfMs)
    && ageMs >= -5_000
    && ageMs <= HEADER_QUOTE_MAX_AGE_MS
    && !forbiddenProvenance.test(provenance)
    && !deniedEntitlement.test(String(quote?.entitlementStatus || ''));

  if (!verified) {
    return unavailableSpxHeaderQuotes(
      !providerConnected
        ? 'IBKR is disconnected; the live SPY quote is unavailable.'
        : 'IBKR did not return a fresh, entitled, direct-live SPY trade.',
    );
  }

  return {
    status: 'live',
    spy: {
      symbol: 'SPY',
      status: 'live',
      price,
      previousClose,
      changePercent,
      asOf: new Date(asOfMs).toISOString(),
      source: 'ibkr',
      reason: null,
    },
  };
}

export function normalizeLivePositionOverlayPayload(payload = {}) {
  const source = normalizedStatus(payload?.meta?.source || payload?.source);
  const status = normalizedStatus(
    payload?.status || payload?.aggregateStatus || payload?.meta?.aggregateStatus || payload?.meta?.status,
  );
  const quality = normalizedStatus(payload?.dataQuality?.status || payload?.meta?.dataQuality?.status);
  const fetchedAt = payload?.fetchedAt || payload?.meta?.fetchedAt || null;
  const fetchedAtMs = Date.parse(fetchedAt || '');
  const cacheOnly = payload?._cache?.stale === true
    || payload?.fromCache === true
    || payload?.cacheOnly === true
    || payload?.meta?.fromCache === true
    || payload?.meta?.cacheOnly === true;
  const forbiddenSource = /(cache|mock|seed|upload|fallback|reconstruct|unavailable|offline|stale)/.test(source);
  const forbiddenStatus = /(unavailable|offline|stale|error|failed|cache|mock|seed)/.test(status);
  const forbiddenQuality = /(unavailable|offline|stale|error|failed)/.test(quality);
  const verifiedLiveSource = source === 'ibkr_live' || source === 'ibkr_live_partial';
  const verifiedLiveStatus = status === 'live' || status === 'partial';

  if (
    cacheOnly
    || forbiddenSource
    || forbiddenStatus
    || forbiddenQuality
    || !verifiedLiveSource
    || !verifiedLiveStatus
    || !Number.isFinite(fetchedAtMs)
  ) {
    return {
      status: 'unavailable',
      positions: [],
      accounts: Array.isArray(payload?.accounts) ? payload.accounts : [],
      message: firstPresent(
        payload?.message,
        payload?.error,
        payload?.meta?.message,
        'Verified-live IBKR prediction positions are unavailable.',
      ),
      fetchedAt: null,
    };
  }

  return {
    status: status === 'partial' || source === 'ibkr_live_partial' ? 'partial' : 'live',
    positions: Array.isArray(payload?.positions) ? payload.positions : [],
    accounts: Array.isArray(payload?.accounts) ? payload.accounts : [],
    message: firstPresent(payload?.message, payload?.meta?.message, null),
    fetchedAt: new Date(fetchedAtMs).toISOString(),
  };
}

export function parseLiveFesPosition(position = {}) {
  const identity = [
    position.localSymbol,
    position.description,
    position.contractKey,
    position.ticker,
    position.symbol,
  ].filter(Boolean).join(' ').toUpperCase();
  const match = identity.match(/\b(FES_\d{6})_(-?\d+(?:\.\d+)?)_(YES|NO)\b/);
  const quantity = finite(position.quantity ?? position.position)
    ? Number(position.quantity ?? position.position)
    : null;
  const averageCost = finite(position.avgCost ?? position.averageCost)
    ? Number(position.avgCost ?? position.averageCost)
    : null;
  if (!match || quantity == null || quantity <= 0 || averageCost == null || averageCost < 0 || averageCost > 1) {
    return null;
  }
  return {
    generationKey: match[1],
    eventContract: `${match[1]}_${match[2]}`,
    side: match[3],
    quantity,
    averageCost,
    cost: quantity * averageCost,
    accountId: String(position.accountId || position.account || '').trim() || null,
  };
}

export function buildLiveFesPositionMap(positions = [], { generationKey = null, accountId = null } = {}) {
  const requiredGeneration = String(generationKey || '').trim().toUpperCase();
  const requiredAccount = String(accountId || '').trim();
  const grouped = new Map();

  (Array.isArray(positions) ? positions : []).forEach((position) => {
    const parsed = parseLiveFesPosition(position);
    if (!parsed) return;
    if (requiredGeneration && parsed.generationKey !== requiredGeneration) return;
    if (requiredAccount && parsed.accountId !== requiredAccount) return;
    const key = `${parsed.eventContract}:${parsed.side}`;
    const current = grouped.get(key);
    grouped.set(key, current ? {
      ...current,
      quantity: current.quantity + parsed.quantity,
      cost: current.cost + parsed.cost,
    } : parsed);
  });

  const byContract = new Map();
  grouped.forEach((position) => {
    const total = {
      ...position,
      averageCost: position.cost / position.quantity,
    };
    const existing = byContract.get(position.eventContract) || [];
    byContract.set(position.eventContract, [...existing, total].sort((left, right) => (
      left.side === right.side ? 0 : left.side === 'YES' ? -1 : 1
    )));
  });
  return byContract;
}

const formatPositionCost = (value) => {
  const rounded = Math.round(Number(value) * 100) / 100;
  const wholeDollars = Math.abs(rounded - Math.round(rounded)) < 0.005;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: wholeDollars ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(rounded);
};

const formatPositionAverage = (value) => `${new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 2,
}).format(Number(value) * 100)}¢`;

const formatPositionQuantity = (value) => new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 2,
}).format(Number(value));

export function selectContractLinesAroundSpot(analyses = [], spotValue, linesPerSide = SPX_CONTRACT_LINES_PER_SIDE) {
  if (!Array.isArray(analyses) || !finite(spotValue)) return analyses;
  const sideLimit = Math.max(0, Math.floor(Number(linesPerSide)) || 0);
  const spot = Number(spotValue);
  const ordered = analyses
    .map((analysis, originalIndex) => ({
      analysis,
      originalIndex,
      threshold: Number(analysis?.line?.threshold),
    }))
    .filter(({ threshold }) => Number.isFinite(threshold))
    .sort((left, right) => left.threshold - right.threshold || left.originalIndex - right.originalIndex);

  const below = sideLimit > 0
    ? ordered.filter(({ threshold }) => threshold < spot).slice(-sideLimit)
    : [];
  const exact = ordered.filter(({ threshold }) => threshold === spot);
  const above = sideLimit > 0
    ? ordered.filter(({ threshold }) => threshold > spot).slice(0, sideLimit)
    : [];
  return [...below, ...exact, ...above].map(({ analysis }) => analysis);
}

const contractLineGeometry = (line) => {
  const lower = finite(line?.lowerBound) ? Number(line.lowerBound) : null;
  const upper = finite(line?.upperBound) ? Number(line.upperBound) : null;
  const threshold = finite(line?.threshold) ? Number(line.threshold) : lower ?? upper;
  if (line?.comparator === 'inclusive_range' && lower != null && upper != null && lower <= upper) {
    return { lower, upper, anchor: (lower + upper) / 2, range: true };
  }
  return threshold == null
    ? null
    : { lower: threshold, upper: threshold, anchor: threshold, range: false };
};

export const buildLadderProximityLevels = (lines = [], spotValue) => {
  const levels = new Map();
  if (!finite(spotValue)) return levels;
  const spot = Number(spotValue);
  const entries = (Array.isArray(lines) ? lines : []).map((line, index) => {
    const geometry = contractLineGeometry(line);
    if (!geometry) return null;
    const containsSpot = geometry.range
      ? spot >= geometry.lower && spot <= geometry.upper
      : spot === geometry.anchor;
    return { index, geometry, containsSpot };
  }).filter(Boolean);
  const containing = entries.filter(({ containsSpot }) => containsSpot);
  const below = entries
    .filter(({ geometry, containsSpot }) => !containsSpot && geometry.anchor < spot)
    .sort((left, right) => right.geometry.anchor - left.geometry.anchor);
  const above = entries
    .filter(({ geometry, containsSpot }) => !containsSpot && geometry.anchor > spot)
    .sort((left, right) => left.geometry.anchor - right.geometry.anchor);

  containing.forEach(({ index }) => levels.set(index, 'dark'));
  ['dark', 'medium', 'light'].forEach((level, index) => {
    if (below[index]) levels.set(below[index].index, level);
    if (above[index]) levels.set(above[index].index, level);
  });
  return levels;
};

// Kept as an export alias for callers/tests written when Gold was the only
// prediction-market ladder with reference-proximity shading.
export const buildGoldLadderProximityLevels = buildLadderProximityLevels;

const contractLineActivity = (line) => [line?.openInterest, line?.volume24h, line?.totalVolume, line?.liquidity]
  .reduce((total, value) => total + (finite(value) ? Number(value) : 0), 0);

export function selectContractLinesForReference(
  analyses = [],
  spotValue,
  linesPerSide = SPX_CONTRACT_LINES_PER_SIDE,
  maximumWithoutReference = 10,
) {
  if (!Array.isArray(analyses)) return [];
  const ordered = analyses.map((analysis, originalIndex) => ({
    analysis,
    originalIndex,
    geometry: contractLineGeometry(analysis?.line),
  })).filter(({ geometry }) => geometry).sort((left, right) => (
    left.geometry.anchor - right.geometry.anchor || left.originalIndex - right.originalIndex
  ));
  if (!finite(spotValue)) {
    return ordered
      .sort((left, right) => (
        contractLineActivity(right.analysis?.line) - contractLineActivity(left.analysis?.line)
        || left.geometry.anchor - right.geometry.anchor
        || String(left.analysis?.line?.ticker || '').localeCompare(String(right.analysis?.line?.ticker || ''))
      ))
      .slice(0, Math.max(0, Math.floor(Number(maximumWithoutReference)) || 0))
      .sort((left, right) => left.geometry.anchor - right.geometry.anchor || left.originalIndex - right.originalIndex)
      .map(({ analysis }) => analysis);
  }
  const spot = Number(spotValue);
  const sideLimit = Math.max(0, Math.floor(Number(linesPerSide)) || 0);
  const below = ordered.filter(({ geometry }) => geometry.upper < spot).slice(-sideLimit);
  const containing = ordered.filter(({ geometry }) => geometry.lower <= spot && geometry.upper >= spot);
  const above = ordered.filter(({ geometry }) => geometry.lower > spot).slice(0, sideLimit);
  return [...below, ...containing, ...above].map(({ analysis }) => analysis);
}

export const isSpxMonitorSectionUsable = (section, nowMs = Date.now()) => {
  if (!section || !['available', 'partial', 'historical'].includes(section.status)) return false;
  if (section.refreshFailed === true || section.fromCache === true || section.cachedOnly === true
    || section.cacheOnly === true || section.seeded === true || section.mock === true || section.stale === true) return false;
  if ((section.refreshing === true || section.refreshPending === true) && section.refreshRetained !== true) return false;
  const status = String(section.status || '').toLowerCase();
  const availability = String(section.availability || '').toLowerCase();
  if (status === 'historical' || availability === 'historical') {
    const historicalThroughDate = String(section.historicalThroughDate || '');
    const latestAt = Date.parse(section.latestAt || section.asOf || '');
    const latestDate = Number.isFinite(latestAt) ? new Date(latestAt).toISOString().slice(0, 10) : null;
    const source = String(section.source || '');
    return /^\d{4}-\d{2}-\d{2}$/.test(historicalThroughDate)
      && latestDate === historicalThroughDate
      && !/(?:mock|seed|fixture|fallback|cache|portfolio|delayed|frozen|stale|offline|disconnected|synthetic|inferred|derived)/i.test(source);
  }
  if (!section.expiresAt) return true;
  const expiresAt = Date.parse(section.expiresAt);
  return Number.isFinite(expiresAt) && nowMs <= expiresAt;
};

const isVerifiedLiveCashHeaderQuote = (section, nowMs = Date.now()) => {
  const source = String(section?.source || '').trim();
  const asOf = Date.parse(section?.asOf || '');
  const expiresAt = Date.parse(section?.expiresAt || '');
  return section?.status === 'available'
    && section?.availability === 'live'
    && finite(section?.value)
    && source.length > 0
    && !/(?:mock|seed|fixture|fallback|cache|portfolio|delayed|frozen|stale|offline|disconnected|historical|synthetic|inferred|derived)/i.test(source)
    && section?.refreshing !== true
    && section?.refreshFailed !== true
    && section?.fromCache !== true
    && Number.isFinite(asOf)
    && asOf <= nowMs + 5_000
    && Number.isFinite(expiresAt)
    && nowMs <= expiresAt;
};

const isVerifiedHistoricalCashHeaderQuote = (section, nowMs = Date.now()) => {
  const source = String(section?.source || '').trim();
  const asOf = Date.parse(section?.asOf || '');
  const historicalThroughDate = String(section?.historicalThroughDate || '');
  const asOfDate = Number.isFinite(asOf) ? new Date(asOf).toISOString().slice(0, 10) : null;
  return section?.status === 'historical'
    && section?.availability === 'last_close'
    && finite(section?.value)
    && /^(?:ibkr_historical_daily_close|ibkr_historical_intraday_session_close)$/.test(source)
    && /^\d{4}-\d{2}-\d{2}$/.test(historicalThroughDate)
    && asOfDate === historicalThroughDate
    && Number.isFinite(asOf)
    && asOf <= nowMs + 5_000
    && section?.refreshing !== true
    && section?.refreshFailed !== true
    && section?.fromCache !== true
    && section?.cachedOnly !== true
    && section?.stale !== true;
};

const isLastVerifiedContractReference = (section, generationKey, nowMs = Date.now()) => {
  const retainedUntil = Date.parse(section?.retainedUntil || '');
  const asOf = Date.parse(section?.asOf || '');
  const source = String(section?.source || '').trim();
  const retainedAvailability = String(section?.retainedAvailability || 'live').toLowerCase();
  return section?.status === 'last_verified'
    && section?.availability === 'last_verified'
    && section?.fit === 'exact'
    && section?.displayOnly === true
    && section?.executable === false
    && ['live', 'current'].includes(retainedAvailability)
    && finite(section?.value)
    && source.length > 0
    && !/(?:mock|seed|fixture|fallback|cache|portfolio|delayed|frozen|offline|disconnected|historical|synthetic|inferred|derived)/i.test(source)
    && section?.fromCache !== true
    && section?.cachedOnly !== true
    && section?.cacheOnly !== true
    && section?.seeded !== true
    && section?.mock !== true
    && (!generationKey || section?.generationKey === generationKey)
    && Number.isFinite(asOf)
    && asOf <= nowMs + 5_000
    && Number.isFinite(retainedUntil)
    && nowMs < retainedUntil;
};

const isVerifiedDisplayReference = (section, nowMs = Date.now()) => {
  const status = String(section?.status || '').toLowerCase();
  const availability = String(section?.availability || '').toLowerCase();
  const source = String(section?.source || '').trim();
  const asOf = Date.parse(section?.asOf || '');
  const expiresAt = Date.parse(section?.expiresAt || '');
  const historicalThroughDate = String(section?.historicalThroughDate || '');
  const datedHistorical = status === 'historical' || availability === 'historical';
  const historicalDateMatches = datedHistorical
    && Number.isFinite(asOf)
    && /^\d{4}-\d{2}-\d{2}$/.test(historicalThroughDate)
    && new Date(asOf).toISOString().slice(0, 10) === historicalThroughDate;
  const retainedRefresh = section?.refreshRetained === true
    && (section?.refreshPending === true || section?.refreshing === true);
  return ['available', 'historical'].includes(status)
    && ['live', 'current', 'historical'].includes(availability || (datedHistorical ? 'historical' : ''))
    && ['exact', 'proxy'].includes(String(section?.fit || 'exact').toLowerCase())
    && finite(section?.value)
    && source.length > 0
    && !/(?:mock|seed|fixture|fallback|cache|portfolio|delayed|frozen|stale|offline|disconnected|synthetic|inferred|derived)/i.test(source)
    && (section?.refreshing !== true || retainedRefresh)
    && (section?.refreshPending !== true || retainedRefresh)
    && section?.refreshFailed !== true
    && section?.fromCache !== true
    && section?.cachedOnly !== true
    && section?.seeded !== true
    && Number.isFinite(asOf)
    && asOf <= nowMs + 5_000
    && (historicalDateMatches || (!datedHistorical && Number.isFinite(expiresAt) && nowMs <= expiresAt));
};

export const isVerifiedDelayedSpxHeaderReference = (section, nowMs = Date.now()) => {
  const asOf = Date.parse(section?.asOf || '');
  const source = String(section?.source || '').trim();
  const retainedAvailability = String(section?.retainedAvailability || '').toLowerCase();
  return section?.status === 'delayed'
    && section?.availability === 'delayed'
    && section?.displayDelayed === true
    && section?.displayOnly === true
    && section?.executable === false
    && section?.clientVerified === true
    && ['live', 'current'].includes(retainedAvailability)
    && finite(section?.value)
    && source.length > 0
    && !FORBIDDEN_SPX_HEADER_REFERENCE_SOURCE.test(source)
    && section?.fromCache !== true
    && section?.cachedOnly !== true
    && section?.cacheOnly !== true
    && section?.seeded !== true
    && section?.mock !== true
    && section?.stale !== true
    && Number.isFinite(asOf)
    && asOf <= nowMs + 5_000;
};

const isVerifiedDelayedContractReference = (section, expectedSymbol, nowMs = Date.now()) => {
  const label = String(section?.label || '').trim().toUpperCase();
  const symbol = String(expectedSymbol || '').trim().toUpperCase();
  const fit = String(section?.fit || '').trim().toLowerCase();
  return ['exact', 'proxy'].includes(fit)
    && isVerifiedDelayedSpxHeaderReference(section, nowMs)
    && (fit === 'proxy' || !symbol || label === symbol);
};

const isRetainableSpxHeaderReference = (section, nowMs = Date.now()) => {
  if (isVerifiedLiveCashHeaderQuote(section, nowMs)
    || isVerifiedDisplayReference(section, nowMs)
    || isVerifiedDelayedSpxHeaderReference(section, nowMs)) return true;
  const status = String(section?.status || '').toLowerCase();
  const availability = String(section?.availability || '').toLowerCase();
  const source = String(section?.source || '').trim();
  const asOf = Date.parse(section?.asOf || '');
  return status === 'available'
    && ['live', 'current'].includes(availability)
    && section?.clientVerified === true
    && finite(section?.value)
    && source.length > 0
    && !FORBIDDEN_SPX_HEADER_REFERENCE_SOURCE.test(source)
    && section?.refreshFailed !== true
    && section?.fromCache !== true
    && section?.cachedOnly !== true
    && section?.cacheOnly !== true
    && section?.seeded !== true
    && section?.mock !== true
    && section?.stale !== true
    && Number.isFinite(asOf)
    && asOf <= nowMs + 5_000;
};

const delayedSpxHeaderReference = (previous, next, nowMs) => {
  const previousAvailability = String(
    previous?.status === 'delayed' ? previous?.retainedAvailability : previous?.availability,
  ).toLowerCase();
  const previousAvailable = ['live', 'current'].includes(previousAvailability)
    && isRetainableSpxHeaderReference(previous, nowMs);
  if (!previousAvailable) return next;
  return {
    ...previous,
    status: 'delayed',
    availability: 'delayed',
    retainedStatus: previous?.retainedStatus || previous?.status || 'available',
    retainedAvailability: previous?.retainedAvailability || previous?.availability || 'live',
    retainedUntil: null,
    displayDelayed: true,
    displayOnly: true,
    executable: false,
    refreshing: false,
    refreshPending: true,
    refreshRetained: true,
    refreshFailed: next?.refreshFailed === true,
    delayedReason: next?.reason || next?.refreshIssue || 'A fresh quote is unavailable; showing the last verified quote.',
    reason: next?.reason || next?.refreshIssue || previous?.reason || null,
  };
};

const stableSpxHeaderReference = (previous, next, nowMs, validator) => {
  if (validator(next, nowMs)) {
    return {
      ...next,
      clientVerified: true,
      clientVerifiedAt: new Date(nowMs).toISOString(),
    };
  }
  return delayedSpxHeaderReference(previous, next, nowMs);
};

export function stabilizeSpxHeaderMarketReferences(previous, snapshot, nowMs = Date.now()) {
  if (!snapshot || snapshot?.marketId !== 'sp500') return null;
  const nextCashSpot = snapshot?.cashSpot || (snapshot?.cardView ? null : snapshot?.spot) || null;
  const nextSpySpot = snapshot?.spySpot || null;
  const nextFuturesReference = snapshot?.resolverReference || null;
  const previousFuturesReference = previous?.futuresReference || null;
  const previousFuturesSymbol = String(
    previousFuturesReference?.instrument?.displaySymbol
    || previousFuturesReference?.spot?.label
    || '',
  ).trim().toUpperCase();
  const nextFuturesSymbol = String(
    nextFuturesReference?.instrument?.displaySymbol
    || nextFuturesReference?.spot?.label
    || '',
  ).trim().toUpperCase();
  const sameFuturesContract = !previousFuturesSymbol
    || !nextFuturesSymbol
    || previousFuturesSymbol === nextFuturesSymbol;
  const futuresSpot = sameFuturesContract
    ? stableSpxHeaderReference(
        previousFuturesReference?.spot,
        nextFuturesReference?.spot,
        nowMs,
        isVerifiedDisplayReference,
      )
    : nextFuturesReference?.spot || null;
  const stabilizedFuturesReference = futuresSpot !== nextFuturesReference?.spot
    ? {
        ...(futuresSpot?.status === 'delayed' ? previousFuturesReference : null),
        ...(nextFuturesReference || {}),
        instrument: nextFuturesReference?.instrument || previousFuturesReference?.instrument || null,
        spot: futuresSpot,
      }
    : nextFuturesReference;

  return {
    cashSpot: stableSpxHeaderReference(
      previous?.cashSpot,
      nextCashSpot,
      nowMs,
      (section, atMs) => (
        isVerifiedLiveCashHeaderQuote(section, atMs)
        || isVerifiedHistoricalCashHeaderQuote(section, atMs)
      ),
    ),
    spySpot: stableSpxHeaderReference(
      previous?.spySpot,
      nextSpySpot,
      nowMs,
      (section, atMs) => (
        isVerifiedLiveCashHeaderQuote(section, atMs)
        || isVerifiedHistoricalCashHeaderQuote(section, atMs)
      ),
    ),
    futuresReference: stabilizedFuturesReference,
  };
}

const retainDisplayReferenceDuringRefresh = (previous, next, nowMs = Date.now()) => {
  const pending = String(next?.status || '').toLowerCase() === 'refreshing'
    || next?.refreshing === true
    || next?.refreshPending === true;
  if (!pending || !isVerifiedDisplayReference(previous, nowMs)) return next;
  return {
    ...previous,
    refreshing: false,
    refreshPending: true,
    refreshRetained: true,
    refreshFailed: false,
    refreshIssue: null,
  };
};

export const getMonitorVenueAvailability = (snapshot, venueId, nowMs = Date.now()) => {
  if (venueId === 'auto') return { selectable: true, reason: null, quotedLineCount: 0 };
  const venue = snapshot?.venues?.[venueId] || null;
  const label = venue?.label || VENUE_OPTIONS.find((option) => option.id === venueId)?.label || venueId;
  if (!venue) {
    return {
      selectable: false,
      reason: `${label} is not configured for this market.`,
      quotedLineCount: 0,
    };
  }

  const catalog = venue.catalog || null;
  const catalogExpiresAt = Date.parse(catalog?.expiresAt || catalog?.event?.closeTime || '');
  const catalogAvailable = catalog?.status === 'available'
    && Array.isArray(catalog?.lines)
    && catalog.lines.length > 0
    && (!Number.isFinite(catalogExpiresAt) || nowMs <= catalogExpiresAt);
  if (!catalogAvailable) {
    return {
      selectable: false,
      reason: catalog?.refreshIssue || catalog?.reason || `${label} has no current contract catalog for this market.`,
      quotedLineCount: 0,
    };
  }

  const book = venue.book || venue.contracts || null;
  const bookExpiresAt = Date.parse(book?.expiresAt || book?.observedAt || '');
  const bookUsable = ['available', 'partial'].includes(book?.status)
    && (book?.refreshing !== true || book?.refreshRetained === true)
    && (book?.refreshPending !== true || book?.refreshRetained === true)
    && book?.refreshFailed !== true
    && (!Number.isFinite(bookExpiresAt) || nowMs <= bookExpiresAt);
  const quotedLineCount = (bookUsable ? book.lines || [] : []).filter((line) => (
    line?.directNative === true
    && [line.yesBid, line.yesAsk, line.noBid, line.noAsk].some(finite)
  )).length;
  return {
    selectable: true,
    reason: quotedLineCount > 0
      ? null
      : book?.refreshIssue || book?.reason || `${label} catalog is available; no fresh native book is currently verified.`,
    quotedLineCount,
  };
};

const retainRefreshFailedSection = (previous, next, nowMs) => {
  const retained = Boolean(next?.refreshFailed && isSpxMonitorSectionUsable(previous, nowMs));
  return {
    retained,
    value: retained ? {
      ...previous,
      refreshFailed: true,
      refreshIssue: next.refreshIssue || next.reason || 'Refresh delayed',
    } : next,
  };
};

const verifiedFreshNativeBook = (section, nowMs) => {
  const expiresAt = Date.parse(section?.bookExpiresAt || section?.expiresAt || '');
  const source = String(section?.source || '').trim();
  const lines = Array.isArray(section?.lines) ? section.lines : [];
  return ['available', 'partial'].includes(String(section?.status || '').toLowerCase())
    && source.length > 0
    && !/(?:mock|seed|fixture|fallback|cache|portfolio|delayed|frozen|stale|offline|disconnected|historical|synthetic|inferred|derived)/i.test(source)
    && section?.refreshFailed !== true
    && Number.isFinite(expiresAt)
    && nowMs <= expiresAt
    && lines.some((line) => line?.directNative === true && [line.yesBid, line.yesAsk, line.noBid, line.noAsk].some(finite));
};

const isFesNativeBook = (section) => {
  const eventIdentity = `${section?.event?.productCode || ''} ${section?.event?.seriesTicker || ''} ${section?.event?.ticker || ''}`;
  return /(?:^|\s)FES(?:_|\s|$)/i.test(eventIdentity)
    || (Array.isArray(section?.lines) && section.lines.some((line) => /^FES_/i.test(String(line?.contractId || line?.ticker || ''))));
};

const retainNativeBookDuringRefresh = (previous, next, nowMs) => {
  const nextStatus = String(next?.status || '').toLowerCase();
  if (next?.refreshRetained === true && verifiedFreshNativeBook(next, nowMs)) return next;
  const pending = (nextStatus === 'refreshing' || next?.refreshing === true || next?.refreshPending === true)
    && next?.refreshFailed !== true;
  if (!pending || !isFesNativeBook(previous) || !verifiedFreshNativeBook(previous, nowMs)) return next;
  return {
    ...previous,
    refreshing: false,
    refreshPending: true,
    refreshRetained: true,
    refreshFailed: false,
    refreshIssue: null,
  };
};

const verifiedChartSectionDuringRefresh = (section, nowMs) => {
  const status = String(section?.status || '').toLowerCase();
  const availability = String(section?.availability || '').toLowerCase();
  const source = String(section?.source || '').trim();
  const expiresAt = Date.parse(section?.expiresAt || '');
  const historicalThroughDate = String(section?.historicalThroughDate || '');
  const latestAt = Date.parse(section?.latestAt || section?.asOf || '');
  const datedHistorical = (status === 'historical' || availability === 'historical')
    && Number.isFinite(latestAt)
    && /^\d{4}-\d{2}-\d{2}$/.test(historicalThroughDate)
    && new Date(latestAt).toISOString().slice(0, 10) === historicalThroughDate;
  return ['available', 'partial', 'historical'].includes(status)
    && source.length > 0
    && !/(?:mock|seed|fixture|fallback|cache|portfolio|delayed|frozen|stale|offline|disconnected|synthetic|inferred|derived)/i.test(source)
    && section?.refreshFailed !== true
    && section?.fromCache !== true
    && section?.cachedOnly !== true
    && section?.stale !== true
    && section?.seeded !== true
    && Array.isArray(section?.points)
    && section.points.length >= 2
    && (datedHistorical || (Number.isFinite(expiresAt) && nowMs <= expiresAt));
};

const retainChartSectionDuringRefresh = (previous, next, nowMs) => {
  const refreshing = next?.status === 'refreshing' || next?.refreshing === true;
  if (!refreshing || !verifiedChartSectionDuringRefresh(previous, nowMs)) return next;
  return {
    ...previous,
    refreshing: false,
    refreshPending: true,
    refreshRetained: true,
    refreshFailed: false,
    refreshIssue: null,
  };
};

const utcWeekendDate = (date) => {
  const timestamp = Date.parse(`${date}T12:00:00.000Z`);
  if (!Number.isFinite(timestamp)) return false;
  const weekday = new Date(timestamp).getUTCDay();
  return weekday === 0 || weekday === 6;
};

const verifiedDailyRiskRange = (range) => {
  const date = String(range?.date || '');
  const publicationDate = String(range?.riskRangePublicationDate || date);
  const carriedForward = range?.riskRangeCarryForward === 'last_published_non_publication_session';
  const references = Array.isArray(range?.references) ? range.references : [];
  const referenceFor = (label) => references.find((reference) => reference?.label === label);
  const lrr = Number(referenceFor('LRR')?.value);
  const hrr = Number(referenceFor('HRR')?.value);
  if (range?.status !== 'available'
    || !/^\d{4}-\d{2}-\d{2}$/.test(date)
    || !Number.isFinite(lrr)
    || !Number.isFinite(hrr)
    || lrr >= hrr
    || range?.refreshFailed === true
    || range?.fromCache === true
    || range?.cachedOnly === true
    || range?.seeded === true) return false;
  return ['LRR', 'HRR'].every((label) => {
    const reference = referenceFor(label);
    const source = String(reference?.source || '').trim();
    const asOf = String(reference?.asOf || '');
    const referenceDate = /^\d{4}-\d{2}-\d{2}/.test(asOf) ? asOf.slice(0, 10) : publicationDate;
    return reference?.status === 'available'
      && source.length > 0
      && !/(?:mock|seed|fixture|fallback|cache|portfolio|delayed|frozen|stale|offline|disconnected|synthetic|inferred|derived)/i.test(source)
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
};

const retainRiskRangeOverlaysDuringRefresh = (previous, next) => {
  if (!previous
    || previous.refreshFailed === true
    || previous.fromCache === true
    || previous.cachedOnly === true
    || previous.seeded === true
    || /(?:mock|seed|fixture|fallback|cache|portfolio|delayed|frozen|stale|offline|disconnected|synthetic|inferred|derived)/i.test(String(previous.source || ''))
    || !next
    || next.riskRangeRefreshPending !== true
    || next.refreshFailed === true
    || next.fromCache === true
    || next.cachedOnly === true
    || next.seeded === true
    || /(?:mock|seed|fixture|fallback|cache|portfolio|delayed|frozen|stale|offline|disconnected|synthetic|inferred|derived)/i.test(String(next.source || ''))
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
};

const retainChartDuringRefresh = (previous, next, nowMs) => {
  if (!next) return next;
  const retainedRoot = retainVerifiedAthWhilePending(
    previous,
    retainRiskRangeOverlaysDuringRefresh(
      previous,
      retainChartSectionDuringRefresh(previous, next, nowMs),
    ),
  );
  if (!next.variants) return synchronizeVerifiedAthAcrossChartRanges(retainedRoot);
  const previousVariants = previous?.variants || {};
  const variants = Object.fromEntries(Object.entries(next.variants).map(([range, variant]) => [
    range,
    retainVerifiedAthWhilePending(
      previousVariants[range] || (range === '1d' ? previous : null),
      retainRiskRangeOverlaysDuringRefresh(
        previousVariants[range] || (range === '1d' ? previous : null),
        retainChartSectionDuringRefresh(
          previousVariants[range] || (range === '1d' ? previous : null),
          variant,
          nowMs,
        ),
      ),
    ),
  ]));
  return synchronizeVerifiedAthAcrossChartRanges({ ...retainedRoot, variants });
};

const catalogOnlySection = (catalog, reason) => {
  if (!catalog || catalog.status !== 'available' || !Array.isArray(catalog.lines)) return null;
  return {
    ...catalog,
    source: catalog.source || 'venue_catalog',
    lines: catalog.lines.map((line) => ({
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
      directNative: false,
      nativeOrderbook: undefined,
    })),
    scheduleOnly: true,
    bookStatus: 'refresh_failed',
    reason,
  };
};

const unavailableSettlementBasis = (reason) => ({
  status: 'unavailable',
  instrument: null,
  method: null,
  observationAt: null,
  sourceName: null,
  sourceUrl: null,
  rulesUrl: null,
  reason,
});

export function mergeSpxMonitorSnapshots(previous, next, nowMs = Date.now()) {
  if (!previous || !next || previous.marketId !== next.marketId) return next;
  const mergedSpot = retainDisplayReferenceDuringRefresh(previous.spot, next.spot, nowMs);
  const spot = { retained: mergedSpot !== next.spot, value: mergedSpot };
  const chart = { retained: false, value: retainChartDuringRefresh(previous.chart, next.chart, nowMs) };
  const riskRange = retainRefreshFailedSection(previous.riskRange, next.riskRange, nowMs);
  const hasVenueFailureMetadata = Array.isArray(next.autoSelection?.refreshFailedVenueIds);
  const failedVenueIds = new Set(next.autoSelection?.refreshFailedVenueIds || []);
  const previousAutoVenueId = previous.autoSelection?.venueId;
  const previousExactVenues = previous.autoSelection?.contracts?.comparedVenues || [];
  const autoRefreshMatchesPrevious = previousAutoVenueId === 'exact-best'
    ? previousExactVenues.length > 0 && previousExactVenues.every((id) => failedVenueIds.has(id))
    : failedVenueIds.has(previousAutoVenueId);
  const nextContracts = hasVenueFailureMetadata && next.contracts?.refreshFailed && !autoRefreshMatchesPrevious
    ? { ...next.contracts, refreshFailed: false, refreshIssue: null }
    : next.contracts;
  const retainedContracts = retainNativeBookDuringRefresh(previous.contracts, nextContracts, nowMs);
  const contracts = { retained: retainedContracts !== nextContracts, value: retainedContracts };
  const selectedDisplayVenueId = next.displaySelection?.venueId;
  const selectedDisplayVenue = next.venues?.[selectedDisplayVenueId];
  const selectedBookFailed = [selectedDisplayVenue?.book, selectedDisplayVenue?.contracts, next.contracts]
    .some((section) => section?.refreshFailed === true
      || ((section?.refreshing === true || section?.refreshPending === true)
        && section?.refreshRetained !== true));
  const safeDisplayCatalog = selectedBookFailed
    ? catalogOnlySection(
        selectedDisplayVenue?.catalog,
        selectedDisplayVenue?.book?.refreshIssue
          || selectedDisplayVenue?.contracts?.refreshIssue
          || next.contracts?.refreshIssue
          || 'Native book refresh failed.',
      )
    : null;
  const nextDisplayContracts = safeDisplayCatalog || next.displayContracts || next.displaySelection?.contracts;
  const retainedDisplayContracts = safeDisplayCatalog
    ? nextDisplayContracts
    : retainNativeBookDuringRefresh(previous.displayContracts, nextDisplayContracts, nowMs);
  const displayContracts = {
    retained: retainedDisplayContracts !== nextDisplayContracts,
    value: retainedDisplayContracts,
  };
  const factorKeys = [...new Set([
    ...Object.keys(previous.factors || {}),
    ...Object.keys(next.factors || {}),
  ])];
  const factorSections = Object.fromEntries(factorKeys.map((key) => [
    key,
    retainRefreshFailedSection(previous.factors?.[key], next.factors?.[key], nowMs),
  ]));
  const factors = Object.fromEntries(factorKeys.map((key) => [key, factorSections[key].value]));
  const previousFactorRows = new Map((previous.factorRows || []).map((row) => [row.id, row]));
  const factorRows = (next.factorRows || []).map((row) => {
    const retained = row.id === 'riskRange'
      ? riskRange.retained
      : factorSections[row.id]?.retained === true;
    return retained && previousFactorRows.has(row.id)
      ? { ...previousFactorRows.get(row.id), refreshDelayed: true }
      : row;
  });
  const previousInputs = previous.scoreInputs || {};
  const nextInputs = next.scoreInputs || {};
  const nextResolverGenerationKey = next.venues?.forecastex?.generationKey
    || next.venues?.forecastex?.book?.event?.ticker
    || null;
  const previousLastVerifiedSpot = previous.resolverReference?.lastVerifiedSpot;
  const previousLastRetainedUntil = Date.parse(previousLastVerifiedSpot?.retainedUntil || '');
  const lastVerifiedSpot = next.resolverReference?.lastVerifiedSpot || (
    previousLastVerifiedSpot
    && Number.isFinite(previousLastRetainedUntil)
    && nowMs < previousLastRetainedUntil
    && (!nextResolverGenerationKey || nextResolverGenerationKey === previousLastVerifiedSpot.generationKey)
      ? previousLastVerifiedSpot
      : null
  );
  const resolverReference = (next.resolverReference || lastVerifiedSpot)
    ? {
        ...(next.resolverReference || previous.resolverReference),
        ...(next.resolverReference ? {
          spot: retainDisplayReferenceDuringRefresh(
            previous.resolverReference?.spot,
            next.resolverReference.spot,
            nowMs,
          ),
          chart: retainChartDuringRefresh(
            previous.resolverReference?.chart,
            next.resolverReference.chart,
            nowMs,
          ),
        } : {}),
        lastVerifiedSpot,
      }
    : next.resolverReference;

  const venueKeys = [...new Set([
    ...Object.keys(previous.venues || {}),
    ...Object.keys(next.venues || {}),
  ])];
  const venues = Object.fromEntries(venueKeys.map((key) => {
    const previousVenue = previous.venues?.[key];
    const nextVenue = next.venues?.[key];
    if (!nextVenue) return [key, previousVenue];
    const nextBook = nextVenue.book || nextVenue.contracts;
    const retainedBook = retainNativeBookDuringRefresh(
      previousVenue?.book || previousVenue?.contracts,
      nextBook,
      nowMs,
    );
    const previousGeneration = String(previousVenue?.generationId || previousVenue?.generationKey || '');
    const nextGeneration = String(nextVenue?.generationId || nextVenue?.generationKey || '');
    const sameGeneration = previousGeneration && nextGeneration && previousGeneration === nextGeneration;
    const reference = nextVenue.reference ? {
      ...nextVenue.reference,
      spot: sameGeneration
        ? retainDisplayReferenceDuringRefresh(
            previousVenue?.reference?.spot,
            nextVenue.reference.spot,
            nowMs,
          )
        : nextVenue.reference.spot,
      chart: sameGeneration
        ? retainChartDuringRefresh(previousVenue?.reference?.chart, nextVenue.reference.chart, nowMs)
        : nextVenue.reference.chart,
    } : nextVenue.reference;
    if (retainedBook !== nextBook) {
      return [key, {
        ...nextVenue,
        status: retainedBook?.status || nextVenue.status,
        book: retainedBook,
        contracts: retainedBook,
        reference,
        ladderSelection: nextVenue.ladderSelection || (sameGeneration ? previousVenue?.ladderSelection : null) || null,
        bookQuality: previousVenue?.bookQuality || nextVenue.bookQuality,
      }];
    }
    const failed = [nextVenue.book, nextVenue.contracts]
      .some((section) => section?.refreshFailed === true
        || ((section?.refreshing === true || section?.refreshPending === true)
          && section?.refreshRetained !== true));
    if (!failed) return [key, {
      ...nextVenue,
      contracts: nextVenue.contracts,
      book: nextVenue.book,
      reference,
    }];
    const reason = nextVenue.book?.refreshIssue
      || nextVenue.contracts?.refreshIssue
      || nextVenue.book?.reason
      || nextVenue.contracts?.reason
      || 'Native book refresh failed.';
    const book = {
      status: nextVenue.book?.refreshing || nextVenue.contracts?.refreshing
        || nextVenue.book?.refreshPending || nextVenue.contracts?.refreshPending
        ? 'refreshing' : 'refresh_failed',
      source: null,
      asOf: null,
      expiresAt: null,
      event: nextVenue.catalog?.event || null,
      lines: [],
      refreshFailed: !nextVenue.book?.refreshing && !nextVenue.contracts?.refreshing
        && !nextVenue.book?.refreshPending && !nextVenue.contracts?.refreshPending,
      refreshing: nextVenue.book?.refreshing === true || nextVenue.contracts?.refreshing === true,
      refreshPending: nextVenue.book?.refreshPending === true || nextVenue.contracts?.refreshPending === true,
      refreshIssue: reason,
      reason,
    };
    return [key, {
      ...nextVenue,
      status: nextVenue.catalog?.status === 'available' ? 'partial' : 'unavailable',
      catalog: catalogOnlySection(nextVenue.catalog, reason) || nextVenue.catalog,
      contracts: book,
      book,
      reference,
      bookQuality: {
        eligible: false,
        lineCount: 0,
        directLineCount: 0,
        executableLineCount: 0,
        displayedDepth: 0,
        displayedAskDepth: 0,
        medianSpread: null,
      },
    }];
  }));
  const retainedSelectedVenueBook = venues[selectedDisplayVenueId]?.book?.refreshRetained === true;
  const mergedDisplayContracts = retainedSelectedVenueBook && verifiedFreshNativeBook(previous.displayContracts, nowMs)
    ? {
        ...previous.displayContracts,
        refreshing: false,
        refreshPending: true,
        refreshRetained: true,
        refreshFailed: false,
        refreshIssue: venues[selectedDisplayVenueId]?.book?.refreshIssue || null,
      }
    : displayContracts.value;

  return {
    ...next,
    spot: spot.value,
    chart: chart.value,
    riskRange: riskRange.value,
    resolverReference,
    contracts: contracts.value,
    displayContracts: mergedDisplayContracts,
    factors,
    factorRows,
    venues,
    autoSelection: next.autoSelection ? {
      ...next.autoSelection,
      contracts: contracts.value,
    } : next.autoSelection,
    displaySelection: next.displaySelection ? {
      ...next.displaySelection,
      contracts: mergedDisplayContracts,
    } : next.displaySelection,
    scoreInputs: {
      ...nextInputs,
      targetDate: contracts.retained ? previousInputs.targetDate : nextInputs.targetDate,
      riskRange: riskRange.retained ? previousInputs.riskRange : nextInputs.riskRange,
      trade: factorSections.trade?.retained ? previousInputs.trade : nextInputs.trade,
      usd: factorSections.usd?.retained ? previousInputs.usd : nextInputs.usd,
      vix: factorSections.vix?.retained ? previousInputs.vix : nextInputs.vix,
      marketStructure: factorSections.gamma?.retained || factorSections.structure?.retained
        ? previousInputs.marketStructure
        : nextInputs.marketStructure,
    },
  };
}

const formatIndex = (value, decimals = 2) => finite(value)
  ? Number(value).toLocaleString('en-US', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    })
  : '—';

const resolveDayChangePercent = (value, previousClose) => {
  if (!finite(value) || !finite(previousClose) || Number(previousClose) <= 0) return null;
  return Number((((Number(value) - Number(previousClose)) / Number(previousClose)) * 100).toFixed(2));
};

const formatDayChangePercent = (value) => {
  if (!finite(value)) return '—';
  const number = Number(value);
  return `${number > 0 ? '+' : ''}${number.toFixed(2)}%`;
};

const formatMarkerDate = (value) => {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toLocaleDateString('en-US', {
    month: 'numeric',
    day: 'numeric',
    timeZone: 'America/New_York',
  });
};

export const formatSpotMarker = (spot) => {
  const historicalClose = spot?.status === 'historical' || ['last_close', 'historical'].includes(spot?.availability);
  const delayed = spot?.status === 'last_verified'
    || ['last_verified', 'delayed'].includes(String(spot?.availability || '').toLowerCase());
  const proxy = spot?.fit === 'proxy';
  const fromBar = /historical[_ -]?bars|current[_ -]?bar/i.test(`${spot?.source || ''} ${spot?.label || ''}`);
  const mode = delayed
    ? 'DELAYED'
    : historicalClose
      ? 'LAST CLOSE'
      : fromBar || spot?.availability === 'current' ? null : 'LIVE';
  const rawLabel = String(spot?.label || '').trim()
    .replace(/^PROXY\s*·\s*/i, '')
    .replace(/^EXACT\s*·\s*/i, '')
    .replace(/^LAST VERIFIED\s+/i, '')
    .replace(/^DELAYED\s+/i, '')
    .replace(/^LIVE\s+/i, '')
    .replace(/\s*·\s*NOT RESOLVER\s*\/\s*NOT EXECUTABLE$/i, '')
    .replace(/\s+(?:LAST CLOSE|CURRENT BAR|LIVE|DELAYED)$/i, '')
    || 'REFERENCE';
  const provenance = proxy ? 'PROXY' : 'EXACT';
  const closeDate = historicalClose ? formatMarkerDate(spot?.asOf) : null;
  return `${provenance} · ${rawLabel}${mode ? ` · ${mode}` : ''} ${formatIndex(spot?.value)}${closeDate ? ` (${closeDate})` : ''}`;
};

const formatCount = (value) => finite(value)
  ? Number(value).toLocaleString('en-US', { maximumFractionDigits: 0 })
  : '—';

const formatCurrency = (value, maximumFractionDigits = 0) => finite(value)
  ? Number(value).toLocaleString('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: maximumFractionDigits,
      maximumFractionDigits,
    })
  : '—';

const formatCents = (value) => finite(value) ? `${Math.round(Number(value) * 100)}¢` : '—';

const formatSpread = (bid, ask) => finite(bid) && finite(ask) && Number(ask) >= Number(bid)
  ? `${Math.round((Number(ask) - Number(bid)) * 100)}¢`
  : '—';

const ContractQuoteCell = ({ outcome, side, price, size, groupStart = false }) => {
  const hasPrice = finite(price);
  const hasSize = hasPrice && finite(size);
  const priceLabel = hasPrice ? formatCents(price) : '—';
  const sizeLabel = hasPrice ? (hasSize ? `× ${formatCount(size)}` : 'SIZE —') : 'NO QUOTE';
  const accessibilityLabel = hasPrice
    ? `${outcome} ${side}: ${priceLabel}${hasSize ? `, displayed size ${formatCount(size)} contracts` : ', displayed size unavailable'}`
    : `${outcome} ${side}: no live quote`;

  return (
    <td
      className={`pm-spx-quote-cell${groupStart ? ' pm-spx-quote-group-start' : ''}${hasPrice ? '' : ' is-empty'}`}
      aria-label={accessibilityLabel}
    >
      <span className="pm-spx-quote-price">{priceLabel}</span>
      <span className="pm-spx-quote-size">{sizeLabel}</span>
    </td>
  );
};

const formatSignedDistance = (strike, spot) => {
  if (!finite(strike) || !finite(spot) || Number(spot) === 0) return '—';
  const points = Number(strike) - Number(spot);
  const percent = (points / Number(spot)) * 100;
  const sign = points > 0 ? '+' : points < 0 ? '−' : '';
  return `${sign}${Math.abs(points).toFixed(2)} (${sign}${Math.abs(percent).toFixed(2)}%)`;
};

const formatAsOf = (value, refreshDelayed = false) => {
  if (!value) return refreshDelayed ? 'REFRESH DELAYED' : '—';
  const raw = String(value);
  const dateOnly = raw.match(/^\d{4}-\d{2}-\d{2}$/);
  const parsed = Date.parse(dateOnly ? `${raw}T12:00:00Z` : raw);
  if (!Number.isFinite(parsed)) return raw;
  const label = dateOnly
    ? new Date(parsed).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
    : new Date(parsed).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  return refreshDelayed ? `${label} · REFRESH DELAYED` : label;
};

const formatContractMeasuredPeriod = (value) => {
  const dateOnly = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  const parsed = Date.parse(dateOnly ? `${dateOnly[0]}T12:00:00Z` : String(value || ''));
  if (!Number.isFinite(parsed)) return 'CURRENT OPEN GENERATION';
  const formatted = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: '2-digit',
    timeZone: dateOnly ? 'UTC' : undefined,
  }).format(new Date(parsed));
  return formatted.replace(',', '').toUpperCase().replace(/ (\d{2})$/, " '$1");
};

const formatMeasuredPeriod = (value, timeZone) => (
  /^\d{4}-\d{2}-\d{2}$/.test(String(value || '').trim())
    ? formatContractMeasuredPeriod(value)
    : formatExchangeAndLocalTime(value, timeZone)
);

const formatDateTimeInZone = (value, timeZone) => {
  const parsed = Date.parse(value || '');
  if (!Number.isFinite(parsed)) return '—';
  try {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone,
      timeZoneName: 'short',
    }).format(new Date(parsed));
  } catch (_error) {
    return formatAsOf(value);
  }
};

const formatExchangeAndLocalTime = (value, exchangeTimeZone) => {
  const exchange = formatDateTimeInZone(value, exchangeTimeZone || 'America/New_York');
  const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const local = formatDateTimeInZone(value, localZone);
  return exchange === '—' ? '—' : exchange === local ? exchange : `${exchange} / ${local}`;
};

const timestampMs = (value) => {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
};

const formatTradingDuration = (targetMs, nowMs) => {
  const remainingSeconds = Math.max(0, Math.floor((targetMs - nowMs) / 1_000));
  const days = Math.floor(remainingSeconds / 86_400);
  const hours = Math.floor((remainingSeconds % 86_400) / 3_600);
  const minutes = Math.floor((remainingSeconds % 3_600) / 60);
  const seconds = remainingSeconds % 60;
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
};

const formatTradingWindow = (openTime, closeTime, timeZone) => {
  const openLabel = openTime ? formatDateTimeInZone(openTime, timeZone) : '—';
  const closeLabel = closeTime ? formatDateTimeInZone(closeTime, timeZone) : '—';
  if (openLabel !== '—' && closeLabel !== '—') return `${openLabel} → ${closeLabel}`;
  if (closeLabel !== '—') return `CLOSE ${closeLabel}`;
  if (openLabel !== '—') return `OPEN ${openLabel}`;
  return null;
};

export function buildContractTradingClock({
  event = null,
  generation = null,
  nowMs = Date.now(),
  localTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
} = {}) {
  const pick = (key) => event?.[key] || generation?.[key] || null;
  const openTime = pick('openTime');
  const closeTime = pick('closeTime');
  const observationTime = pick('observationTime');
  const resolutionTime = event?.resolutionAt || pick('resolutionTime');
  const exchangeTimeZone = pick('timezone');
  const openMs = timestampMs(openTime);
  const closeMs = timestampMs(closeTime);
  const observationMs = timestampMs(observationTime);
  const resolutionMs = timestampMs(resolutionTime);
  const normalizedNowMs = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  const rawStatus = String(event?.status || generation?.status || '').trim().toLowerCase();
  const closedStatuses = new Set(['closed', 'expired', 'settled', 'resolved', 'finalized', 'cancelled', 'canceled']);
  const pausedStatuses = new Set(['halted', 'paused', 'suspended']);
  const openStatuses = new Set(['open', 'active', 'live', 'trading']);
  const scheduledStatuses = new Set(['scheduled', 'upcoming', 'pending', 'initialized']);
  let state = 'unavailable';
  let headline = 'CONTRACT HOURS UNAVAILABLE';

  if (closedStatuses.has(rawStatus) || (closeMs != null && closeMs <= normalizedNowMs)) {
    state = 'closed';
    if (observationMs != null && observationMs > normalizedNowMs && observationMs !== closeMs) {
      headline = `TRADING CLOSED · OBSERVES IN ${formatTradingDuration(observationMs, normalizedNowMs)}`;
    } else if (resolutionMs != null && resolutionMs > normalizedNowMs) {
      headline = `TRADING CLOSED · RESOLVES IN ${formatTradingDuration(resolutionMs, normalizedNowMs)}`;
    } else {
      headline = 'TRADING CLOSED';
    }
  } else if (openMs != null && openMs > normalizedNowMs) {
    state = 'scheduled';
    headline = `OPENS IN ${formatTradingDuration(openMs, normalizedNowMs)}`;
  } else if (pausedStatuses.has(rawStatus)) {
    state = 'paused';
    headline = closeMs != null
      ? `TRADING ${rawStatus.toUpperCase()} · CLOSES IN ${formatTradingDuration(closeMs, normalizedNowMs)}`
      : `TRADING ${rawStatus.toUpperCase()} · CLOSE TIME UNAVAILABLE`;
  } else if (
    openStatuses.has(rawStatus)
    || (openMs != null && closeMs != null && openMs <= normalizedNowMs && closeMs > normalizedNowMs)
  ) {
    state = 'open';
    headline = closeMs != null
      ? `OPEN · CLOSES IN ${formatTradingDuration(closeMs, normalizedNowMs)}`
      : 'OPEN · CLOSE TIME UNAVAILABLE';
  } else if (scheduledStatuses.has(rawStatus)) {
    state = 'scheduled';
    headline = openMs != null
      ? `OPENS IN ${formatTradingDuration(openMs, normalizedNowMs)}`
      : 'SCHEDULED · OPEN TIME UNAVAILABLE';
  } else if (closeMs != null && closeMs > normalizedNowMs) {
    state = 'unavailable';
    headline = `TRADING STATUS UNAVAILABLE · CLOSES IN ${formatTradingDuration(closeMs, normalizedNowMs)}`;
  }

  const exchangeWindow = exchangeTimeZone
    ? formatTradingWindow(openTime, closeTime, exchangeTimeZone)
    : null;
  const localWindow = formatTradingWindow(openTime, closeTime, localTimeZone);
  const scheduleLines = [];
  if (exchangeWindow) {
    scheduleLines.push(`${exchangeTimeZone === localTimeZone ? 'EXCHANGE / LOCAL' : 'EXCHANGE'} · ${exchangeWindow}`);
  }
  if (localWindow && exchangeTimeZone !== localTimeZone) {
    scheduleLines.push(`LOCAL · ${localWindow}`);
  }
  if (!scheduleLines.length && observationMs != null) {
    const observationLabel = formatDateTimeInZone(observationTime, localTimeZone);
    if (observationLabel !== '—') scheduleLines.push(`LOCAL OBSERVATION · ${observationLabel}`);
  }

  return {
    state,
    headline,
    primarySchedule: scheduleLines[0] || 'VERIFIED TRADING WINDOW UNAVAILABLE',
    secondarySchedule: scheduleLines[1] || null,
    title: [headline, ...scheduleLines].join(' · '),
  };
}

const humanizeSource = (value) => String(value || '—')
  .replaceAll('_', ' ')
  .replace(/\b\w/g, (character) => character.toUpperCase());

const formatFactorNumber = (value, precision = 2) => finite(value)
  ? Number(value).toLocaleString('en-US', {
      minimumFractionDigits: precision,
      maximumFractionDigits: precision,
    })
  : '—';

const formatSignedFactorNumber = (value, precision = 2) => finite(value)
  ? `${Number(value) > 0 ? '+' : ''}${formatFactorNumber(value, precision)}`
  : '—';

const pointLabel = (value) => finite(value) ? String(Number(value)) : '—';

export function buildSpxContractAnalyses(snapshot, nowMs = Date.now()) {
  const contractsAvailable = isSpxMonitorSectionUsable(snapshot?.contracts, nowMs);
  const lines = contractsAvailable && Array.isArray(snapshot?.contracts?.lines)
    ? [...snapshot.contracts.lines].sort((left, right) => Number(left.threshold) - Number(right.threshold))
    : [];
  const inputs = snapshot?.scoreInputs || {};
  return lines.map((line) => ({
    line,
    confluence: buildSpxCloseConfluence({
      targetDate: inputs.targetDate,
      historical: false,
      riskRange: inputs.riskRange,
      trade: inputs.trade,
      selectedMarket: line,
      usd: inputs.usd,
      vix: inputs.vix,
      marketStructure: inputs.marketStructure,
    }),
  }));
}

export function resolveMonitorVenue(snapshot, preference = 'auto') {
  if (!snapshot || snapshot.schemaVersion !== 2) {
    return {
      id: 'kalshi',
      label: 'Kalshi',
      resolver: null,
      contracts: snapshot?.contracts || null,
      strategyEligible: true,
      selectionMode: 'legacy',
      selectionReason: null,
    };
  }
  if (preference === 'auto') {
    const auto = snapshot.autoSelection || {};
    const display = snapshot.displaySelection || auto;
    const venue = snapshot.venues?.[display.venueId] || snapshot.venues?.[auto.venueId] || null;
    return {
      id: display.venueId || 'auto',
      label: display.label || venue?.label || 'Auto',
      resolver: venue?.resolver || null,
      contracts: display.contracts || snapshot.displayContracts || auto.contracts || snapshot.contracts,
      executionContracts: auto.contracts || snapshot.contracts,
      executionAvailable: auto.status === 'available',
      brokerRoutable: venue?.brokerRoutable === true,
      venue,
      strategyEligible: Boolean(
        snapshot.strategy?.status === 'available'
        && snapshot.strategy?.eligibleVenueId
        && auto.venueId === snapshot.strategy.eligibleVenueId
      ),
      selectionMode: display.mode || auto.mode || 'none',
      selectionReason: auto.status === 'available'
        ? auto.reason || display.reason || null
        : [auto.reason, display.reason].filter(Boolean).join(' · '),
    };
  }
  const venue = snapshot.venues?.[preference] || null;
  const catalog = venue?.catalog;
  const book = venue?.book || venue?.contracts;
  const compactDisplayContracts = snapshot.cardView === true
    && preference === (snapshot.selectedVenueId || snapshot.displaySelection?.venueId)
    && Array.isArray(snapshot.contracts?.lines)
    ? snapshot.contracts
    : null;
  const bookExpiresAt = Date.parse(book?.expiresAt || book?.observedAt || '');
  const bookUsable = ['available', 'partial'].includes(book?.status)
    && (book?.refreshing !== true || book?.refreshRetained === true)
    && book?.refreshFailed !== true
    && (!Number.isFinite(bookExpiresAt) || Date.now() <= bookExpiresAt);
  const nativeLines = bookUsable
    ? (book?.lines || []).filter((line) => line?.directNative === true)
    : [];
  const liveByTicker = new Map(nativeLines.map((line) => [String(line.ticker), line]));
  const hasNativeQuotes = nativeLines.some((line) => (
    [line.yesBid, line.yesAsk, line.noBid, line.noAsk].some(finite)
  ));
  const displayContracts = compactDisplayContracts || (catalog?.status === 'available' ? {
    ...catalog,
    status: 'available',
    bookStatus: book?.status || 'unavailable',
    bookExpiresAt: book?.expiresAt || null,
    scheduleOnly: !hasNativeQuotes,
    reason: bookUsable && book?.status === 'available'
      ? null
      : hasNativeQuotes
        ? book?.reason || 'Fresh native quotes are available, but execution depth is incomplete.'
        : book?.reason || 'No verified live book is available.',
    lines: (catalog.lines || []).map((line) => ({ ...line, ...(liveByTicker.get(String(line.ticker)) || {}) })),
  } : book);
  return {
    id: preference,
    label: venue?.label || preference,
    resolver: venue?.resolver || null,
    contracts: displayContracts || {
      status: 'unavailable', event: null, lines: [], reason: `${preference} is unavailable.`,
    },
    executionContracts: book,
    executionAvailable: bookUsable && book?.status === 'available',
    brokerRoutable: venue?.brokerRoutable === true,
    venue,
    strategyEligible: Boolean(
      snapshot.strategy?.status === 'available'
      && snapshot.strategy?.eligibleVenueId === preference
      && bookUsable
      && book?.status === 'available'
    ),
    selectionMode: 'manual',
    selectionReason: book?.status === 'available'
      ? venue?.resolver?.warning || null
      : book?.reason || `${venue?.label || preference} has a current catalog but no verified live book.`,
  };
}

function snapshotForVenue(snapshot, venueSelection) {
  if (!snapshot || !venueSelection) return snapshot;
  const reference = snapshot.cardView ? null : venueSelection.venue?.reference || null;
  const basisReference = reference?.chartReferences?.basis || reference;
  return {
    ...snapshot,
    contracts: venueSelection.contracts,
    ...(reference ? {
      spot: basisReference?.spot || reference.spot,
      chart: basisReference?.chart || reference.chart,
      chartReferences: reference.chartReferences || snapshot.chartReferences || null,
      resolverReference: reference,
    } : {}),
  };
}

const labelOffsetAttributes = (verticalOffset) => ({
  'data-label-offset': Number(verticalOffset || 0).toFixed(2),
  'data-collision-adjusted': Math.abs(Number(verticalOffset || 0)) > 0.01 ? 'true' : undefined,
});

const ChartEndpointLabel = ({
  viewBox,
  value,
  color = '#111827',
  fontWeight = 800,
  verticalOffset = 0,
  testId,
}) => {
  if (!viewBox || value === '—') return null;
  return (
    <text
      x={viewBox.x + 8}
      y={viewBox.y + 3 + verticalOffset}
      fill={color}
      fontSize="10"
      fontWeight={fontWeight}
      textAnchor="start"
      data-testid={testId}
      {...labelOffsetAttributes(verticalOffset)}
      pointerEvents="none"
    >
      {value}
    </text>
  );
};

const CpiChartRailLabel = ({
  viewBox,
  value,
  color,
  verticalOffset = 0,
  testId,
}) => {
  if (!viewBox || !value) return null;
  const lineEndX = Number(viewBox.x) + Number(viewBox.width);
  const lineY = Number(viewBox.y);
  const labelX = lineEndX + 18;
  const labelY = lineY + 3 + verticalOffset;
  return (
    <g
      data-testid={testId}
      {...labelOffsetAttributes(verticalOffset)}
      pointerEvents="none"
    >
      <text
        x={labelX}
        y={labelY}
        fill={color}
        fontSize="9"
        fontWeight="400"
        textAnchor="start"
      >
        {value}
      </text>
    </g>
  );
};

const proxyFitSigned = (value, suffix = '') => finite(value)
  ? `${Number(value) > 0 ? '+' : ''}${Number(value).toFixed(2)}${suffix}`
  : '—';

const proxyFitDeviationTone = (value) => {
  if (!finite(value)) return 'is-unavailable';
  const magnitude = Math.abs(Number(value));
  if (magnitude >= 2) return 'is-danger';
  if (magnitude >= 1) return 'is-caution';
  return 'is-normal';
};

const unavailableMomoTrackerSnapshot = (reason) => ({
  status: 'unavailable',
  rows: [],
  publicationDate: null,
  publishedAt: null,
  reason,
});

const newYorkDateKey = (nowMs = Date.now()) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(nowMs));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return values.year && values.month && values.day
    ? `${values.year}-${values.month}-${values.day}`
    : null;
};

const unavailableMomoValue = (value) => value === null || value === undefined || value === '';

const unavailableMomoSpot = (ticker) => ({
  ticker,
  status: 'unavailable',
  price: null,
  asOf: null,
  source: null,
});

export function normalizeVerifiedMomoTrackerSpots(
  tickers = [],
  quotes = {},
  providerStatus = null,
  nowMs = Date.now(),
) {
  const providerConnected = providerStatus?.ibkr?.connected === true;
  const quoteValues = quotes && typeof quotes === 'object' && !Array.isArray(quotes)
    ? Object.values(quotes)
    : [];
  const quoteBySymbol = new Map(quoteValues.map((quote) => [
    String(quote?.symbol || '').trim().toUpperCase(),
    quote,
  ]));
  const forbiddenProvenance = /delayed|frozen|stale|cache(?:d|[_ -]?only)?|mock|seed|fixture|fallback|offline|disconnected|historical|synthetic|inferred|derived/i;
  const deniedEntitlement = /denied|unavailable|not[_ -]?subscribed|not[_ -]?entitled|no[_ -]?permission|disabled/i;

  return Object.fromEntries([...new Set(tickers.map((ticker) => String(ticker || '').trim().toUpperCase()))]
    .filter(Boolean)
    .map((ticker) => {
      const quote = quoteBySymbol.get(ticker) || quotes?.[ticker];
      const symbol = String(quote?.symbol || '').trim().toUpperCase();
      const source = normalizedStatus(quote?.source);
      const dataType = normalizedStatus(quote?.dataType);
      const price = finite(quote?.last) ? Number(quote.last) : null;
      const asOfMs = Date.parse(quote?.timestamp || '');
      const ageMs = Number(nowMs) - asOfMs;
      const provenance = [
        quote?.warning,
        quote?.error,
        quote?.freshness,
        quote?.sourceStatus,
        quote?.fromCache ? 'cache' : null,
        quote?.cacheOnly ? 'cache-only' : null,
        quote?.stale ? 'stale' : null,
        quote?.mock ? 'mock' : null,
        quote?.seeded ? 'seed' : null,
        quote?.fallback ? 'fallback' : null,
        quote?.offline ? 'offline' : null,
        quote?.disconnected ? 'disconnected' : null,
        quote?.refreshFailed ? 'refresh-failed' : null,
      ].filter(Boolean).join(' ');
      const verified = providerConnected
        && symbol === ticker
        && source === 'ibkr'
        && dataType === 'live'
        && price != null
        && price > 0
        && Number.isFinite(asOfMs)
        && ageMs >= -5_000
        && ageMs <= MOMO_SPOT_MAX_AGE_MS
        && !forbiddenProvenance.test(provenance)
        && !deniedEntitlement.test(String(quote?.entitlementStatus || ''));

      return [ticker, verified ? {
        ticker,
        status: 'live',
        price,
        asOf: new Date(asOfMs).toISOString(),
        source: 'ibkr',
      } : unavailableMomoSpot(ticker)];
    }));
}

const currentMomoSpot = (spot, nowMs = Date.now()) => {
  const asOfMs = Date.parse(spot?.asOf || '');
  const ageMs = Number(nowMs) - asOfMs;
  return spot?.status === 'live'
    && spot?.source === 'ibkr'
    && finite(spot?.price)
    && Number(spot.price) > 0
    && Number.isFinite(asOfMs)
    && ageMs >= -5_000
    && ageMs <= MOMO_SPOT_MAX_AGE_MS
    ? spot
    : null;
};

export function normalizeMomoTrackerSnapshot(payload = {}, nowMs = Date.now()) {
  const evidence = [
    payload?.warning,
    payload?.error,
    payload?.reason,
    payload?.freshness,
    payload?.cacheState,
    payload?.fromCache ? 'cache' : null,
    payload?.cacheOnly ? 'cache-only' : null,
    payload?.stale ? 'stale' : null,
    payload?.mock ? 'mock' : null,
    payload?.seeded ? 'seed' : null,
    payload?.fallback ? 'fallback' : null,
    payload?.offline ? 'offline' : null,
    payload?.disconnected ? 'disconnected' : null,
    payload?.refreshFailed ? 'refresh-failed' : null,
  ].filter(Boolean).join(' ');
  const publicationDate = String(payload?.date || '');
  const currentDate = newYorkDateKey(nowMs);
  const data = payload?.data && typeof payload.data === 'object' && !Array.isArray(payload.data)
    ? payload.data
    : {};
  const rows = Object.entries(data).map(([ticker, rawRow], sourceIndex) => {
    const row = rawRow && typeof rawRow === 'object' ? rawRow : {};
    const normalizedTicker = String(ticker || '').trim().toUpperCase();
    const rangeStatus = String(row.rangeStatus || '').trim().toLowerCase();
    return {
      ticker: normalizedTicker,
      buyTrade: finite(row.buyTrade) ? Number(row.buyTrade) : null,
      sellTrade: finite(row.sellTrade) ? Number(row.sellTrade) : null,
      upside: finite(row.upside) ? Number(row.upside) : null,
      downside: finite(row.downside) ? Number(row.downside) : null,
      trend: String(row.trend || '').trim().toUpperCase(),
      rangeStatus,
      rangeStatusDate: row.rangeStatusDate == null ? null : String(row.rangeStatusDate).trim(),
      index: finite(row.index) ? Number(row.index) : null,
      displayIndex: finite(row.index)
        ? Number(row.index)
        : MOMO_TRACKER_TICKER_ORDER.get(normalizedTicker) ?? (MOMO_TRACKER_TICKER_ORDER.size + sourceIndex),
      sourceIndex,
      rawRow: row,
    };
  });
  const hasDeclaredStockCount = payload?.meta?.stockCount !== null
    && payload?.meta?.stockCount !== undefined
    && payload?.meta?.stockCount !== '';
  const declaredStockCount = hasDeclaredStockCount && Number.isInteger(Number(payload.meta.stockCount))
    ? Number(payload.meta.stockCount)
    : null;
  const validDeclaredStockCount = !hasDeclaredStockCount || (
    declaredStockCount >= MOMO_TRACKER_MIN_ROW_COUNT
    && declaredStockCount <= MOMO_TRACKER_MAX_ROW_COUNT
  );
  const expectedStockCount = hasDeclaredStockCount
    ? declaredStockCount
    : MOMO_TRACKER_LEGACY_ROW_COUNT;
  const validRows = validDeclaredStockCount
    && rows.length === expectedStockCount
    && rows.every((row) => {
      const availableRange = row.rangeStatus === 'available'
        && finite(row.buyTrade)
        && finite(row.sellTrade)
        && finite(row.upside)
        && finite(row.downside)
        && row.buyTrade > 0
        && row.sellTrade > row.buyTrade;
      const outbucketRange = row.rangeStatus === 'outbucket'
        && unavailableMomoValue(row.rawRow.buyTrade)
        && unavailableMomoValue(row.rawRow.sellTrade)
        && unavailableMomoValue(row.rawRow.upside)
        && unavailableMomoValue(row.rawRow.downside)
        && (!row.rangeStatusDate || /^\d{2}\/\d{2}$/.test(row.rangeStatusDate));
      return /^[A-Z][A-Z0-9.]{0,9}$/.test(row.ticker)
        && (row.index === null || (
          Number.isInteger(row.index)
          && row.index >= 0
          && row.index < expectedStockCount
        ))
        && MOMO_TRACKER_TRENDS.has(row.trend)
        && (availableRange || outbucketRange);
    })
    && new Set(rows.map((row) => row.ticker)).size === rows.length
    && new Set(rows.filter((row) => row.index !== null).map((row) => row.index)).size
      === rows.filter((row) => row.index !== null).length;
  const verified = payload?.snapshotType === 'momo-tracker'
    && (!payload?.reportType || payload.reportType === 'momo-tracker')
    && /^\d{4}-\d{2}-\d{2}$/.test(publicationDate)
    && publicationDate === currentDate
    && payload?.contentComplete !== false
    && payload?.decisionEligible !== false
    && payload?.refreshFailed !== true
    && validRows
    && !/(?:stale|cache|mock|seed|fallback|offline|disconnected|synthetic|inferred|derived)/i.test(evidence);

  if (!verified) {
    const datedReason = publicationDate && publicationDate !== currentDate
      ? `Today's Hedgeye MOMO Tracker is not published yet. Latest publication: ${publicationDate}.`
      : null;
    return unavailableMomoTrackerSnapshot(
      payload?.reason || datedReason || "Today's complete Hedgeye MOMO Tracker table is unavailable.",
    );
  }

  return {
    status: 'available',
    rows: rows
      .sort((left, right) => left.displayIndex - right.displayIndex || left.sourceIndex - right.sourceIndex)
      .map(({ displayIndex, sourceIndex, rawRow, ...row }) => row),
    publicationDate,
    publishedAt: payload.publishedAt || payload.scrapedAt || payload.retrievedAt || null,
    reason: null,
  };
}

const ProxyFitPanel = ({ comparison, marketUi }) => {
  const status = ['available', 'partial', 'loading'].includes(String(comparison?.status || '').toLowerCase())
    ? String(comparison.status).toLowerCase()
    : 'unavailable';
  const rowsByWindow = new Map((Array.isArray(comparison?.rows) ? comparison.rows : [])
    .map((row) => [Number(row?.window), row]));
  const rows = [5, 20, 60, 120].map((window) => rowsByWindow.get(window) || {
    window,
    status: 'unavailable',
    averageBasisPct: null,
    deviationZ: null,
    returnCorrelation: null,
  });
  const proxyLabel = comparison?.proxyLabel || '—';
  const underlyingLabel = comparison?.underlyingLabel || marketUi.symbol || '—';
  const comparisonUsable = status === 'available' || status === 'partial';
  const alignedDate = comparisonUsable
    && /^\d{4}-\d{2}-\d{2}$/.test(String(comparison?.alignedThroughDate || ''))
    ? formatAthSessionDate(comparison.alignedThroughDate)
    : null;
  const statusLabel = status === 'available'
    ? 'VERIFIED'
    : status === 'partial' ? 'PARTIAL' : status === 'loading' ? 'CHECKING' : 'UNAVAILABLE';

  return (
    <aside
      className={`pm-spx-proxy-fit is-${status}`}
      aria-label={`${marketUi.fullLabel} proxy fit comparison`}
      data-testid={`${marketUi.symbol.toLowerCase()}-proxy-fit`}
      title={comparison?.reason || comparison?.methodology || undefined}
    >
      <header>
        <strong>PROXY FIT</strong>
      </header>
      <div
        className="pm-spx-proxy-fit-pair"
        aria-label={`Proxy ${proxyLabel} compared with underlying ${underlyingLabel}`}
      >
        <b title={proxyLabel}>{proxyLabel}</b>
        <span aria-hidden="true">→</span>
        <b title={underlyingLabel}>{underlyingLabel}</b>
      </div>
      <div className="pm-spx-proxy-fit-current">
        <b className={`is-${status}`}>
          {comparisonUsable ? proxyFitSigned(comparison?.currentBasisPct, '%') : statusLabel}
        </b>
        <span>
          {comparisonUsable ? (
            <>
              <i>{statusLabel}</i>
              <em aria-hidden="true">·</em>
              <span>LAST ALIGNED BASIS · AS OF {alignedDate || '—'}</span>
            </>
          ) : status === 'loading'
            ? 'WAITING FOR VERIFIED COMPARISON'
            : 'NO VERIFIED ALIGNED COMPARISON'}
        </span>
      </div>
      <table>
        <thead>
          <tr>
            <th aria-label="WINDOW" />
            <th>AVG BASIS</th>
            <th>DEVIATION</th>
            <th>RET CORR</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const available = comparisonUsable && row?.status === 'available';
            return (
              <tr key={row.window} className={available ? undefined : 'is-unavailable'}>
                <th>{row.window}D</th>
                <td>{available ? proxyFitSigned(row.averageBasisPct, '%') : '—'}</td>
                <td className={available ? proxyFitDeviationTone(row.deviationZ) : undefined}>
                  {available ? proxyFitSigned(row.deviationZ, 'σ') : '—'}
                </td>
                <td>{available && finite(row.returnCorrelation) ? Number(row.returnCorrelation).toFixed(2) : '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <footer>
        <span>COMPLETED, TIME-ALIGNED CLOSES · RETURNS CORRELATION</span>
        {marketUi.symbol === 'BRENT' && (
          <span>
            PYTH INDEX NOT INCLUDED · LIVE HISTORY ENTITLEMENT REQUIRED
            {comparison?.exactResolverUrl && (
              <a href={comparison.exactResolverUrl} target="_blank" rel="noreferrer">
                OPEN EXACT PYTH BRENT INDEX
              </a>
            )}
          </span>
        )}
      </footer>
    </aside>
  );
};

const formatPythTrackingUsd = (value, { signed = false } = {}) => finite(value)
  ? `${signed ? Number(value) > 0 ? '+' : Number(value) < 0 ? '-' : '' : ''}$${Math.abs(Number(value)).toFixed(2)}`
  : '—';

const PythTrackingPanel = ({ tracking }) => {
  const status = ['available', 'partial', 'loading'].includes(String(tracking?.status || '').toLowerCase())
    ? String(tracking.status).toLowerCase()
    : 'unavailable';
  const available = status === 'available';
  const latestFinal = tracking?.currentEventFinal || tracking?.latestFinal || null;
  const guardBand = finite(tracking?.guardBandUsd) ? Number(tracking.guardBandUsd) : 10;
  const metrics = [
    ['N', Number.isInteger(Number(tracking?.sampleSize)) ? Number(tracking.sampleSize) : 0],
    ['BIAS', formatPythTrackingUsd(tracking?.meanSignedErrorUsd, { signed: true })],
    ['MAE', formatPythTrackingUsd(tracking?.meanAbsoluteErrorUsd)],
    ['MEDIAN', formatPythTrackingUsd(tracking?.medianAbsoluteErrorUsd)],
    ['P90', formatPythTrackingUsd(tracking?.p90AbsoluteErrorUsd)],
    ['MAX', formatPythTrackingUsd(tracking?.maxAbsoluteErrorUsd)],
  ];
  return (
    <aside
      className={`pm-spx-proxy-fit pm-gold-pyth-tracking is-${status}`}
      aria-label="Gold Pyth resolver tracking"
      data-testid="gold-pyth-tracking"
      title={tracking?.reason || tracking?.methodology || undefined}
    >
      <header><strong>PYTH TRACKING</strong></header>
      <div className="pm-spx-proxy-fit-pair" aria-label="IBKR XAUUSD proxy compared with Pyth Metal Index Gold USD">
        <b>XAUUSD</b><span aria-hidden="true">→</span><b>PYTH GOLD/USD</b>
      </div>
      <div className="pm-gold-pyth-resolver">
        <span>PYTH 1-MIN CANDLE CLOSE · 4:59–5:00 PM ET</span>
      </div>
      <div className="pm-spx-proxy-fit-current">
        <b className={`is-${status}`}>±{formatPythTrackingUsd(guardBand)}</b>
      </div>
      <dl className="pm-gold-pyth-metrics">
        {metrics.map(([label, value]) => (
          <div key={label} className={!available && label !== 'N' ? 'is-unavailable' : undefined}>
            <dt>{label}</dt><dd>{available || label === 'N' ? value : '—'}</dd>
          </div>
        ))}
      </dl>
      <div className="pm-gold-pyth-final">
        <span>{tracking?.currentEventFinal ? 'CURRENT EVENT FINAL' : 'LATEST OFFICIAL FINAL'}</span>
        <strong>{latestFinal && finite(latestFinal.value)
          ? `$${Number(latestFinal.value).toFixed(2)}`
          : '—'}</strong>
        <small>{latestFinal?.eventTicker || 'NO FINALIZED MATCH'}</small>
      </div>
    </aside>
  );
};

const formatMomoLevel = (value) => finite(value)
  ? Number(value).toLocaleString('en-US', { maximumFractionDigits: 2 })
  : '—';

const formatMomoPercent = (value) => finite(value)
  ? `${Number(value).toFixed(2)}%`
  : '—';

const MomoTrackerPanel = ({
  snapshot,
  spots = {},
  state = 'loading',
  nowMs = Date.now(),
}) => {
  const available = ['available', 'refresh-delayed'].includes(state)
    && snapshot?.status === 'available'
    && snapshot?.publicationDate === newYorkDateKey(nowMs);
  const rows = available ? snapshot.rows : [];

  return (
    <aside
      className={`pm-spx-momo-tracker is-${available ? 'available' : state}`}
      aria-label="Published Hedgeye MOMO Tracker risk ranges"
      data-testid="sp500-momo-tracker"
    >
      {available ? (
        <table aria-label="Hedgeye MOMO Tracker risk ranges">
          <colgroup>
            <col className="is-ticker" />
            <col className="is-level" />
            <col className="is-spot" />
            <col className="is-level" />
            <col className="is-percent" />
            <col className="is-percent" />
            <col className="is-trend" />
          </colgroup>
          <thead>
            <tr className="pm-spx-momo-tracker-columns">
              <th>TICKER</th>
              <th className="is-buy">BUY TRADE</th>
              <th className="is-spot">SPOT</th>
              <th className="is-sell">SELL TRADE</th>
              <th>UPSIDE</th>
              <th>DOWNSIDE</th>
              <th>TREND</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const spot = currentMomoSpot(spots?.[row.ticker], nowMs);
              return (
                <tr key={row.ticker}>
                  <th scope="row">{row.ticker}</th>
                  <td className={row.rangeStatus === 'outbucket' ? 'is-outbucket' : undefined}>
                    {row.rangeStatus === 'outbucket'
                      ? `OUTBUCKET${row.rangeStatusDate ? ` ${row.rangeStatusDate}` : ''}`
                      : formatMomoLevel(row.buyTrade)}
                  </td>
                  <td
                    className={`is-spot${spot ? '' : ' is-unavailable'}`}
                    aria-label={spot
                      ? `${row.ticker} verified live spot ${formatMomoLevel(spot.price)}`
                      : `${row.ticker} live spot unavailable`}
                  >
                    {spot ? formatMomoLevel(spot.price) : '—'}
                  </td>
                  <td className={row.rangeStatus === 'outbucket' ? 'is-outbucket' : undefined}>
                    {row.rangeStatus === 'outbucket'
                      ? `OUTBUCKET${row.rangeStatusDate ? ` ${row.rangeStatusDate}` : ''}`
                      : formatMomoLevel(row.sellTrade)}
                  </td>
                  <td className="is-upside">{formatMomoPercent(row.upside)}</td>
                  <td className="is-downside">{formatMomoPercent(row.downside)}</td>
                  <td className={`is-trend is-${row.trend.toLowerCase()}`}>{row.trend}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <div className="pm-spx-momo-tracker-state" role="status">
          <strong>NO NEW DATA</strong>
        </div>
      )}
    </aside>
  );
};

const RightEdgeReferenceLabel = ({ viewBox, value, color, verticalOffset = 0, testId }) => {
  if (!viewBox || !value) return null;
  return (
    <text
      x={Number(viewBox.x) + Number(viewBox.width) + 8}
      y={Number(viewBox.y) + 3 + verticalOffset}
      fill={color}
      fontSize="10"
      fontWeight="800"
      textAnchor="start"
      data-testid={testId}
      {...labelOffsetAttributes(verticalOffset)}
      pointerEvents="none"
    >
      {value}
    </text>
  );
};

const MarketClosedBandLabel = ({ viewBox, closure, testId }) => {
  if (!viewBox || !closure) return null;
  const visibleLabel = closure.type === 'holiday'
    ? 'MARKET CLOSED HOLIDAY'
    : 'MARKET CLOSED WEEKEND';
  const accessibleLabel = closure.type === 'holiday'
    ? `${closure.date}: market closed holiday — ${closure.holidayName}`
    : `${closure.date}: market closed weekend`;
  const x = Number(viewBox.x) + (Number(viewBox.width) / 2);
  const y = Number(viewBox.y) + (Number(viewBox.height) / 2);
  return (
    <g
      className={`pm-spx-market-closed-label is-${closure.type}`}
      data-testid={testId}
      role="img"
      aria-label={accessibleLabel}
      pointerEvents="none"
    >
      <title>{accessibleLabel}</title>
      <text
        x={x}
        y={y}
        transform={`rotate(-90 ${x} ${y})`}
        textAnchor="middle"
        dominantBaseline="central"
      >
        {visibleLabel}
      </text>
    </g>
  );
};

const RiskRangeChartLabel = ({ viewBox, value, tone, placement, testId }) => {
  if (!viewBox || !value) return null;
  const color = tone === 'high' ? '#059669' : tone === 'low' ? '#dc2626' : '#a53844';
  const labelWidth = Math.max(58, (String(value).length * 5.8) + 14);
  const labelHeight = 16;
  const x = Number(viewBox.x) - (labelWidth / 2);
  const y = placement === 'above'
    ? Number(viewBox.y) - labelHeight - 4
    : Number(viewBox.y) + 4;
  return (
    <g
      data-testid={testId}
      data-boundary-placement={placement}
      pointerEvents="none"
    >
      <rect
        x={x}
        y={y}
        width={labelWidth}
        height={labelHeight}
        rx="2"
        fill="rgba(255, 255, 255, 0.96)"
        stroke="#cbd5e1"
        strokeWidth="0.8"
      />
      <text
        x={Number(viewBox.x)}
        y={y + 11.5}
        fill={color}
        fontSize="9"
        fontWeight="800"
        textAnchor="middle"
      >
        {value}
      </text>
    </g>
  );
};

const AthReferenceLabel = ({ viewBox, value, testId, clampEdge = null, verticalOffset = 0 }) => {
  if (!viewBox || !value) return null;
  const x = Number(viewBox.x) + Number(viewBox.width) + 8;
  const y = Number(viewBox.y) + 3 + verticalOffset;
  const rangePosition = clampEdge === 'top'
    ? ', above visible chart range'
    : clampEdge === 'bottom'
      ? ', below visible chart range'
      : '';
  return (
    <text
      x={x}
      y={y}
      fill="#2563eb"
      fontSize="10"
      fontWeight="800"
      textAnchor="start"
      data-testid={testId}
      data-clamp-edge={clampEdge || undefined}
      aria-label={`${value}${rangePosition}`}
      {...labelOffsetAttributes(verticalOffset)}
      pointerEvents="none"
    >
      {value}
    </text>
  );
};

const chartSessionParts = (timestamp) => {
  if (!Number.isFinite(Number(timestamp))) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(Number(timestamp)));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const hour = Number(values.hour);
  const minute = Number(values.minute);
  return values.year && values.month && values.day && Number.isFinite(hour) && Number.isFinite(minute)
    ? {
      date: `${values.year}-${values.month}-${values.day}`,
      minutes: (hour * 60) + minute,
    }
    : null;
};

const chartSessionDate = (timestamp) => chartSessionParts(timestamp)?.date || null;

const goldEventTickerForSessionDate = (date) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''));
  const monthCode = match ? GOLD_EVENT_MONTH_CODES[Number(match[2]) - 1] : null;
  return match && monthCode ? `KXGOLDD-${match[1].slice(-2)}${monthCode}${match[3]}17` : null;
};

export const resolveVerifiedGoldSettlements = (tracking, rangeDates = []) => {
  const trackingProvenance = [
    tracking?.source,
    tracking?.provenance,
    tracking?.cacheStatus,
    tracking?.cacheState,
    tracking?.warning,
    tracking?.error,
    tracking?.fromCache ? 'cached' : null,
    tracking?.cachedOnly ? 'cached-only' : null,
    tracking?.cacheOnly ? 'cache-only' : null,
    tracking?.mock ? 'mock' : null,
    tracking?.seeded ? 'seeded' : null,
    tracking?.fallback ? 'fallback' : null,
  ].filter(Boolean).join(' ');
  const trustedTracking = ['available', 'partial'].includes(tracking?.status)
    && tracking?.source === GOLD_SETTLEMENT_SOURCE
    && tracking?.resolverSymbol === GOLD_SETTLEMENT_INSTRUMENT
    && tracking?.refreshFailed !== true
    && !FORBIDDEN_GOLD_CONTEXT_PROVENANCE.test(trackingProvenance);
  if (!trustedTracking) return [];

  const dates = new Set((Array.isArray(rangeDates) ? rangeDates : [])
    .map((date) => String(date || ''))
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)));
  const grouped = new Map();
  (Array.isArray(tracking?.settlements) ? tracking.settlements : []).forEach((row) => {
    const observationAt = Date.parse(row?.observationAt || '');
    const finalizedAt = Date.parse(row?.finalizedAt || '');
    const value = Number(row?.value);
    const session = chartSessionParts(observationAt);
    const rowProvenance = [
      row?.source,
      row?.provenance,
      row?.cacheStatus,
      row?.cacheState,
      row?.warning,
      row?.error,
      row?.fromCache ? 'cached' : null,
      row?.cachedOnly ? 'cached-only' : null,
      row?.cacheOnly ? 'cache-only' : null,
      row?.mock ? 'mock' : null,
      row?.seeded ? 'seeded' : null,
      row?.fallback ? 'fallback' : null,
    ].filter(Boolean).join(' ');
    const valid = row?.status === 'available'
      && row?.availability === 'official_final'
      && row?.final === true
      && row?.source === GOLD_SETTLEMENT_SOURCE
      && Number.isFinite(observationAt)
      && Number.isFinite(finalizedAt)
      && finalizedAt >= observationAt
      && value > 0
      && session?.minutes === (17 * 60)
      && dates.has(session?.date)
      && row?.eventTicker === goldEventTickerForSessionDate(session?.date)
      && !FORBIDDEN_GOLD_CONTEXT_PROVENANCE.test(rowProvenance);
    if (!valid) return;
    grouped.set(session.date, [...(grouped.get(session.date) || []), {
      date: session.date,
      eventTicker: row.eventTicker,
      observationAt: new Date(observationAt).toISOString(),
      timestamp: observationAt,
      finalizedAt: new Date(finalizedAt).toISOString(),
      value,
      source: row.source,
      availability: row.availability,
    }]);
  });
  return [...grouped.entries()]
    .flatMap(([, rows]) => (rows.length === 1 ? rows : []))
    .sort((left, right) => left.timestamp - right.timestamp);
};

export const resolveVerifiedGoldSettlementTime = (venueSelection, sessionDate, nowMs = Date.now()) => {
  const identity = buildSettlementIdentityViewModel(venueSelection, { nowMs });
  const basis = identity?.basis;
  const observationAt = Date.parse(basis?.observationAt || '');
  const session = chartSessionParts(observationAt);
  const provenance = [
    basis?.sourceName,
    basis?.source,
    basis?.provenance,
    basis?.warning,
    basis?.fromCache ? 'cached' : null,
    basis?.mock ? 'mock' : null,
    basis?.seeded ? 'seeded' : null,
    basis?.fallback ? 'fallback' : null,
  ].filter(Boolean).join(' ');
  const valid = identity?.status === 'verified'
    && basis?.instrumentScope === 'exact'
    && basis?.instrument === GOLD_SETTLEMENT_INSTRUMENT
    && /^Pyth$/i.test(String(basis?.sourceName || ''))
    && /1-minute\s+close/i.test(String(basis?.method || ''))
    && Number.isFinite(observationAt)
    && session?.minutes === (17 * 60)
    && session?.date === String(sessionDate || '')
    && !FORBIDDEN_GOLD_CONTEXT_PROVENANCE.test(provenance);
  return valid ? {
    timestamp: observationAt,
    observationAt: new Date(observationAt).toISOString(),
    date: session.date,
    sourceName: basis.sourceName,
    instrument: basis.instrument,
    method: basis.method,
  } : null;
};

const riskRangeValues = (range) => {
  const references = Array.isArray(range?.references) ? range.references : [];
  const low = references.find((reference) => String(reference?.label || '').toUpperCase() === 'LRR');
  const high = references.find((reference) => String(reference?.label || '').toUpperCase() === 'HRR');
  const lrr = finite(low?.value) ? Number(low.value) : null;
  const hrr = finite(high?.value) ? Number(high.value) : null;
  return range?.status === 'available' && lrr != null && hrr != null && lrr < hrr
    ? { available: true, lrr, hrr }
    : { available: false, lrr: null, hrr: null };
};

const unavailableRiskRangeStructureScore = (reason, sessionCount = 0) => ({
  status: 'unavailable',
  score: null,
  highScore: null,
  lowScore: null,
  sessionCount,
  comparisonCount: 0,
  eventCount: 0,
  counts: { HH: 0, HL: 0, LH: 0, LL: 0, EH: 0, EL: 0 },
  events: [],
  sessions: [],
  reason,
  basis: 'risk_range_endpoints',
});

const nextRiskRangeTrendScore = (currentScore, credit) => {
  if (credit === 0) return 0;
  return Math.sign(currentScore) === Math.sign(credit)
    ? currentScore + credit
    : credit;
};

/**
 * Consecutive Risk Range trend score for the sessions visible in a chart.
 *
 * The first visible session is the baseline. Each later HRR starts or extends
 * a positive higher-high (HH) run or a negative lower-high (LH) run. LRR runs
 * independently track higher lows (HL) and lower lows (LL). A direction
 * reversal restarts that leg at +1 or -1 immediately, while an equal endpoint
 * breaks its run back to zero. A complete verified window is required so a
 * partial trend cannot be mistaken for the requested 5D or 10D result.
 */
export const calculateRiskRangeStructureScore = (dailyRanges = [], expectedSessionCount = null) => {
  const ranges = Array.isArray(dailyRanges) ? dailyRanges : [];
  const requiredCount = Number.isInteger(expectedSessionCount) && expectedSessionCount > 0
    ? expectedSessionCount
    : ranges.length;
  if (requiredCount < 2 || ranges.length !== requiredCount) {
    return unavailableRiskRangeStructureScore(
      `Complete exact-date Risk Range history is required for all ${requiredCount || 'requested'} sessions.`,
      ranges.length,
    );
  }

  const normalized = ranges.map((range) => {
    const values = riskRangeValues(range);
    return values.available && /^\d{4}-\d{2}-\d{2}$/.test(String(range?.date || ''))
      ? { date: range.date, lrr: values.lrr, hrr: values.hrr }
      : null;
  });
  if (normalized.some((range) => !range)) {
    return unavailableRiskRangeStructureScore(
      `Complete exact-date Risk Range history is required for all ${requiredCount} sessions.`,
      ranges.length,
    );
  }
  if (new Set(normalized.map((range) => range.date)).size !== normalized.length) {
    return unavailableRiskRangeStructureScore('Risk Range session dates are not unique.', ranges.length);
  }

  const chronological = [...normalized].sort((left, right) => left.date.localeCompare(right.date));
  const counts = { HH: 0, HL: 0, LH: 0, LL: 0, EH: 0, EL: 0 };
  const events = [];
  const sessions = [{
    date: chronological[0].date,
    comparisonDate: null,
    highEvent: 'BASE',
    highCredit: 0,
    highScore: 0,
    lowEvent: 'BASE',
    lowCredit: 0,
    lowScore: 0,
    score: 0,
    cumulativeScore: 0,
  }];
  let highScore = 0;
  let lowScore = 0;
  for (let index = 1; index < chronological.length; index += 1) {
    const previous = chronological[index - 1];
    const current = chronological[index];
    const highCredit = current.hrr > previous.hrr ? 1 : current.hrr < previous.hrr ? -1 : 0;
    const lowCredit = current.lrr > previous.lrr ? 1 : current.lrr < previous.lrr ? -1 : 0;
    const highEvent = highCredit > 0 ? 'HH' : highCredit < 0 ? 'LH' : 'EH';
    const lowEvent = lowCredit > 0 ? 'HL' : lowCredit < 0 ? 'LL' : 'EL';
    counts[highEvent] += 1;
    counts[lowEvent] += 1;
    highScore = nextRiskRangeTrendScore(highScore, highCredit);
    lowScore = nextRiskRangeTrendScore(lowScore, lowCredit);
    const event = {
      date: current.date,
      comparisonDate: previous.date,
      highEvent,
      highCredit,
      highScore,
      lowEvent,
      lowCredit,
      lowScore,
      score: highCredit + lowCredit,
      cumulativeScore: highScore + lowScore,
    };
    events.push(event);
    sessions.push(event);
  }

  return {
    status: 'available',
    score: highScore + lowScore,
    highScore,
    lowScore,
    sessionCount: chronological.length,
    comparisonCount: events.length,
    eventCount: events.length * 2,
    baselineDate: chronological[0].date,
    asOf: chronological[chronological.length - 1].date,
    counts,
    events,
    sessions,
    reason: null,
    basis: 'risk_range_endpoints',
    ruleVersion: 'visible-window-split-streak-v3',
  };
};

const formatSignedStructureScore = (score) => (
  Number(score) >= 0 ? `+${Number(score)}` : String(Number(score))
);

const structureScoreAriaValue = (score) => (
  Number(score) > 0 ? `plus ${Number(score)}` : Number(score) < 0 ? `minus ${Math.abs(Number(score))}` : 'zero'
);

const structureScoreToneFor = (score) => (
  Number(score) > 0 ? 'positive' : Number(score) < 0 ? 'negative' : 'neutral'
);

const VixCloseLabel = ({ viewBox, value, date, state = 'unavailable', compact = false, testId }) => {
  if (!viewBox) return null;
  const available = state === 'available' && finite(value) && Number(value) > 0;
  const displayValue = available ? formatIndex(value, compact ? 1 : 2) : state === 'loading' ? '…' : '—';
  const label = `VIX ${displayValue}`;
  const labelWidth = Math.max(38, (label.length * (compact ? 4.5 : 5.2)) + 10);
  const labelHeight = 15;
  const x = Number(viewBox.x) - (labelWidth / 2);
  const y = Number(viewBox.y) + 3;
  const ariaLabel = available
    ? `${date} VIX close ${displayValue}`
    : state === 'loading'
      ? `${date} VIX close loading`
      : `${date} VIX close unavailable`;
  return (
    <g
      className={`pm-spx-vix-close-label is-${available ? 'available' : state}`}
      data-testid={testId}
      data-state={available ? 'available' : state}
      data-value={available ? Number(value) : undefined}
      aria-label={ariaLabel}
      pointerEvents="none"
    >
      <title>{ariaLabel}</title>
      <rect x={x} y={y} width={labelWidth} height={labelHeight} rx="3" strokeWidth="0.8" />
      <text
        x={Number(viewBox.x)}
        y={y + 11.2}
        fontSize={compact ? '7.5' : '8.5'}
        fontWeight="850"
        textAnchor="middle"
      >
        {label}
      </text>
    </g>
  );
};

const GoldSettlementMarkerLabel = ({ viewBox, settlement, compact = false, testId }) => {
  if (!viewBox || !settlement || !finite(settlement.value)) return null;
  const time = formatSessionTime(settlement.timestamp);
  const displayValue = formatIndex(settlement.value, 1);
  const label = compact ? `5P · ${displayValue}` : `${time} · ${displayValue}`;
  const labelWidth = Math.max(48, (label.length * (compact ? 4.4 : 5.1)) + 10);
  const labelHeight = compact ? 14 : 15;
  const x = Number(viewBox.x) - labelWidth - 5;
  const y = Number(viewBox.y) - labelHeight - 5;
  const ariaLabel = `${settlement.date} official Pyth settlement, ${displayValue} at ${time} Eastern Time`;
  return (
    <g
      className="pm-gold-settlement-label"
      data-testid={testId}
      data-date={settlement.date}
      data-value={settlement.value}
      data-observation-at={settlement.observationAt}
      data-source={settlement.source}
      aria-label={ariaLabel}
      pointerEvents="none"
    >
      <title>{ariaLabel}</title>
      <rect x={x} y={y} width={labelWidth} height={labelHeight} rx="3" strokeWidth="0.9" />
      <text
        x={x + (labelWidth / 2)}
        y={y + (compact ? 10.2 : 11.2)}
        fontSize={compact ? '7.5' : '8.5'}
        fontWeight="400"
        textAnchor="middle"
      >
        {label}
      </text>
    </g>
  );
};

const GoldSettlementTimeLabel = ({ viewBox, settlement, testId }) => {
  if (!viewBox || !settlement) return null;
  const time = formatSessionTime(settlement.timestamp);
  const label = `PYTH ${time} ET`;
  const labelWidth = Math.max(78, (label.length * 5.2) + 10);
  const x = Number(viewBox.x) - labelWidth - 5;
  const y = Number(viewBox.y) + 3;
  const ariaLabel = `Exact Gold settlement observation at ${time} Eastern Time on ${settlement.date}`;
  return (
    <g
      className="pm-gold-settlement-time-label"
      data-testid={testId}
      data-date={settlement.date}
      data-observation-at={settlement.observationAt}
      aria-label={ariaLabel}
      pointerEvents="none"
    >
      <title>{ariaLabel}</title>
      <rect x={x} y={y} width={labelWidth} height="15" rx="3" strokeWidth="0.9" />
      <text x={x + (labelWidth / 2)} y={y + 11.2} fontSize="8.5" fontWeight="400" textAnchor="middle">
        {label}
      </text>
    </g>
  );
};

const RiskRangeStructureCounterLabel = ({
  viewBox,
  score,
  leg,
  event,
  date,
  testId,
  boundaryOffset = 4,
}) => {
  if (!viewBox || !Number.isFinite(Number(score))) return null;
  const value = formatSignedStructureScore(score);
  const tone = structureScoreToneFor(score);
  const placement = leg === 'high' ? 'above' : 'below';
  const labelWidth = Math.max(24, (value.length * 6) + 10);
  const labelHeight = 15;
  const x = Number(viewBox.x) - (labelWidth / 2);
  const y = placement === 'above'
    ? Number(viewBox.y) - labelHeight - boundaryOffset
    : Number(viewBox.y) + boundaryOffset;
  const eventLabel = event === 'BASE' ? 'window baseline' : event;
  const boundaryLabel = leg === 'high' ? 'above HRR' : 'below LRR';
  const ariaLabel = `${date} ${leg} structure ${structureScoreAriaValue(score)}, ${boundaryLabel}, ${eventLabel}`;
  return (
    <g
      className={`pm-spx-structure-counter is-${tone}`}
      data-testid={testId}
      data-score={Number(score)}
      data-score-tone={tone}
      data-boundary-placement={placement}
      data-boundary-offset={boundaryOffset}
      aria-label={ariaLabel}
      pointerEvents="none"
    >
      <title>{ariaLabel}</title>
      <rect
        x={x}
        y={y}
        width={labelWidth}
        height={labelHeight}
        rx="3"
        strokeWidth="0.9"
      />
      <text
        x={Number(viewBox.x)}
        y={y + 11.2}
        fontSize="9"
        fontWeight="850"
        textAnchor="middle"
      >
        {value}
      </text>
    </g>
  );
};

const isVerifiedRiskRangeStructureChart = (chart, nowMs) => {
  const source = String(chart?.source || '').trim();
  const availability = String(chart?.availability || '').toLowerCase();
  const riskRangeStatus = String(chart?.riskRangeStatus || '').toLowerCase();
  return isSpxMonitorSectionUsable(chart, nowMs)
    && source.length > 0
    && !/(?:mock|seed|fixture|fallback|cache|portfolio)/i.test(source)
    && !['unavailable', 'stale', 'cache', 'cache_only'].includes(availability)
    && Array.isArray(chart?.points)
    && chart.points.length >= 2
    && (!riskRangeStatus || ['available', 'aligned', 'proxy_context'].includes(riskRangeStatus))
    && chart?.refreshFailed !== true
    && chart?.connected !== false
    && chart?.disconnected !== true
    && chart?.fromCache !== true
    && chart?.cacheOnly !== true
    && chart?.seeded !== true
    && chart?.mock !== true
    && chart?.stale !== true;
};

const formatSessionLabel = (date) => {
  const parsed = Date.parse(`${date}T12:00:00.000Z`);
  if (!Number.isFinite(parsed)) return { weekday: '—', date: String(date || '—') };
  return {
    weekday: new Date(parsed).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }).toUpperCase(),
    date: new Date(parsed).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).toUpperCase(),
  };
};

const formatShortSessionDate = (date) => {
  const parsed = Date.parse(`${date}T12:00:00.000Z`);
  return Number.isFinite(parsed)
    ? new Date(parsed).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', timeZone: 'UTC' })
    : String(date || '—');
};

const formatAthSessionDate = (date) => {
  const parsed = Date.parse(`${date}T12:00:00.000Z`);
  return Number.isFinite(parsed)
    ? new Date(parsed).toLocaleDateString('en-US', {
        month: 'numeric', day: 'numeric', year: 'numeric', timeZone: 'UTC',
      })
    : String(date || '—');
};

const formatSessionTime = (timestamp) => Number.isFinite(Number(timestamp))
  ? new Date(Number(timestamp)).toLocaleTimeString('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      minute: '2-digit',
    })
  : '—';

const INTRADAY_TIME_STEPS_MS = Object.freeze([
  30 * 60_000,
  60 * 60_000,
  2 * 60 * 60_000,
  3 * 60 * 60_000,
  4 * 60 * 60_000,
  6 * 60 * 60_000,
  12 * 60 * 60_000,
]);

export const buildIntradayTimeAxis = (timestamps, targetTickCount = 8, options = {}) => {
  const numeric = [...new Set((timestamps || []).map(Number).filter(Number.isFinite))]
    .sort((left, right) => left - right);
  if (!numeric.length) return { domain: [0, 1], ticks: [], step: null };
  const requestedDomain = Array.isArray(options?.domain)
    ? options.domain.map(Number)
    : [];
  const hasSessionDomain = requestedDomain.length === 2
    && requestedDomain.every(Number.isFinite)
    && requestedDomain[0] < requestedDomain[1]
    && requestedDomain[0] <= numeric[0]
    && requestedDomain[1] >= numeric[numeric.length - 1];
  const domain = hasSessionDomain
    ? requestedDomain
    : [numeric[0], numeric[numeric.length - 1]];
  if (domain[0] === domain[1]) {
    return { domain, ticks: domain, step: null, hasSessionEndpoints: false };
  }
  const span = domain[1] - domain[0];
  const rawStep = span / Math.max(1, Number(targetTickCount) - 1);
  const step = INTRADAY_TIME_STEPS_MS.find((candidate) => candidate >= rawStep)
    || Math.ceil(rawStep / INTRADAY_TIME_STEPS_MS[INTRADAY_TIME_STEPS_MS.length - 1])
      * INTRADAY_TIME_STEPS_MS[INTRADAY_TIME_STEPS_MS.length - 1];
  const firstTick = Math.ceil(domain[0] / step) * step;
  let ticks = [];
  for (let tick = firstTick; tick <= domain[1]; tick += step) ticks.push(tick);
  if (hasSessionDomain && options?.includeEndpoints) {
    ticks = [
      domain[0],
      ...ticks.filter((tick) => tick > domain[0] && tick < domain[1]),
      domain[1],
    ];
  }
  return {
    domain,
    ticks: ticks.length >= 2 ? ticks : domain,
    step,
    hasSessionEndpoints: hasSessionDomain && Boolean(options?.includeEndpoints),
  };
};

const formatIntradayTimeTick = (timestamp, step) => {
  const date = new Date(Number(timestamp));
  if (!Number.isFinite(date.getTime())) return '—';
  const includeMinutes = Number(step) < 60 * 60_000 || date.getMinutes() !== 0;
  return date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    ...(includeMinutes ? { minute: '2-digit' } : {}),
  });
};

const nicePriceStep = (rawStep) => {
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(rawStep, 1)));
  const normalized = rawStep / magnitude;
  const factor = normalized <= 1 ? 1
    : normalized <= 2 ? 2
      : normalized <= 2.5 ? 2.5
        : normalized <= 5 ? 5 : 10;
  return factor * magnitude;
};

export const buildSpxPriceAxis = (values, targetIntervals = 6) => {
  const numeric = (values || []).map(Number).filter(Number.isFinite);
  if (!numeric.length) return { domain: [0, 1], ticks: [0, 1], step: 1 };
  const minimum = Math.min(...numeric);
  const maximum = Math.max(...numeric);
  const span = Math.max(maximum - minimum, 1);
  const padding = Math.max(span * 0.08, 8);
  const step = nicePriceStep((span + (padding * 2)) / Math.max(targetIntervals, 1));
  const domainMinimum = Math.floor((minimum - padding) / step) * step;
  const domainMaximum = Math.ceil((maximum + padding) / step) * step;
  const tickCount = Math.round((domainMaximum - domainMinimum) / step);
  const ticks = Array.from({ length: tickCount + 1 }, (_, index) => (
    Number((domainMinimum + (index * step)).toFixed(6))
  ));
  return { domain: [domainMinimum, domainMaximum], ticks, step };
};

export const expandSpxPriceAxis = (axis, padding = 100) => {
  const minimum = Number(axis?.domain?.[0]);
  const maximum = Number(axis?.domain?.[1]);
  const step = Number(axis?.step);
  const extra = Math.max(0, Number(padding) || 0);
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || maximum <= minimum || !(step > 0)) return axis;
  const domain = [minimum - extra, maximum + extra];
  const firstTick = Math.ceil(domain[0] / step) * step;
  const tickCount = Math.floor((domain[1] - firstTick) / step);
  const ticks = Array.from({ length: tickCount + 1 }, (_, index) => (
    Number((firstTick + (index * step)).toFixed(6))
  ));
  return { ...axis, domain, ticks };
};

export const resolveVerifiedVixCloses = (section, rangeDates = []) => {
  const provenance = [
    section?.source,
    section?.provenance,
    section?.cacheStatus,
    section?.cacheState,
    section?.sourceStatus,
    section?.warning,
    section?.error,
    section?.fromCache ? 'cached' : '',
    section?.cachedOnly ? 'cached-only' : '',
    section?.cacheOnly ? 'cache-only' : '',
    section?.mock ? 'mock' : '',
    section?.seeded ? 'seeded' : '',
    section?.fallback ? 'fallback' : '',
  ].filter(Boolean).join(' ');
  const trusted = ['available', 'partial'].includes(section?.status)
    && section?.availability === 'historical'
    && section?.source === 'ibkr_historical_daily_close'
    && section?.refreshFailed !== true
    && !/(?:mock|seed|fixture|fallback|cache|portfolio|delayed|frozen|stale|offline|disconnected|synthetic|inferred|derived)/i.test(provenance);
  if (!trusted) return new Map();

  const dates = new Set(rangeDates);
  const grouped = new Map();
  (Array.isArray(section?.values) ? section.values : []).forEach((row) => {
    const date = String(row?.date || '');
    const value = Number(row?.value);
    if (!dates.has(date) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !(value > 0)) return;
    grouped.set(date, [...(grouped.get(date) || []), value]);
  });
  return new Map([...grouped.entries()].flatMap(([date, values]) => (
    values.length === 1 ? [[date, values[0]]] : []
  )));
};

const MULTI_DAY_SESSION_GAP = 0.04;
const UTC_DAY_MS = 24 * 60 * 60 * 1000;
const WEEKEND_SEPARATOR_WIDTH_PX = 15;
const WEEKEND_SEPARATOR_GUTTER_PX = 2;
const WEEKEND_INTERVAL_WIDTH_PX = WEEKEND_SEPARATOR_WIDTH_PX + (WEEKEND_SEPARATOR_GUTTER_PX * 2);
const DEFAULT_WEEKEND_SESSION_GAP = 0.24;
const CLOSED_DAY_BAND_GUTTER_PX = 2;
const SPX_CLOSED_DAY_WIDTH_PX = Object.freeze({ 5: 44, 10: 28 });
const US_EQUITY_CALENDAR = 'us_equity';
const WEEKDAY_CALENDAR = 'weekday';
const CONTINUOUS_CALENDAR = 'continuous';
const CHART_PLOT_HORIZONTAL_INSET_PX = 164;
const WEEKEND_SEPARATOR_PATTERN_ID = 'pm-spx-weekend-separator-pattern';
const CLOSED_DAY_PATTERN_IDS = Object.freeze({
  weekend: 'pm-spx-market-closed-weekend-pattern',
  holiday: 'pm-spx-market-closed-holiday-pattern',
});

const utcDateValue = (value) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!match) return null;
  const timestamp = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const date = new Date(timestamp);
  return date.getUTCFullYear() === Number(match[1])
    && date.getUTCMonth() === Number(match[2]) - 1
    && date.getUTCDate() === Number(match[3])
    ? timestamp
    : null;
};

const crossesWeekend = (previousDate, nextDate) => {
  const previous = utcDateValue(previousDate);
  const next = utcDateValue(nextDate);
  if (!Number.isFinite(previous) || !Number.isFinite(next) || next <= previous) return false;
  for (let cursor = previous + UTC_DAY_MS; cursor < next; cursor += UTC_DAY_MS) {
    const day = new Date(cursor).getUTCDay();
    if (day === 0 || day === 6) return true;
  }
  return false;
};

const calendarDateKeysBetween = (previousDate, nextDate) => {
  if (utcDateValue(previousDate) == null || utcDateValue(nextDate) == null || previousDate >= nextDate) return [];
  const dates = [];
  for (let date = addUsEquityCalendarDays(previousDate, 1); date && date < nextDate; date = addUsEquityCalendarDays(date, 1)) {
    dates.push(date);
  }
  return dates;
};

const closedDatesBetweenForCalendar = (calendar, previousDate, nextDate) => {
  if (calendar === US_EQUITY_CALENDAR) {
    return closedUsEquityDatesBetween(previousDate, nextDate);
  }
  if (calendar === WEEKDAY_CALENDAR) {
    return calendarDateKeysBetween(previousDate, nextDate).flatMap((date) => {
      const timestamp = utcDateValue(date);
      const day = Number.isFinite(timestamp) ? new Date(timestamp).getUTCDay() : null;
      return day === 0 || day === 6
        ? [{ date, type: 'weekend', holidayName: null }]
        : [];
    });
  }
  return [];
};

const sessionProgress = (timestamp, startAt, endAt) => {
  const value = Number(timestamp);
  const start = Number(startAt);
  const end = Number(endAt);
  if (!Number.isFinite(value) || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return Math.min(1, Math.max(0, (value - start) / (end - start)));
};

export const buildMultiDayChartLayout = (
  points,
  dailyRanges = [],
  expectedSessionCount = 5,
  plotWidthPx = null,
  configuration = {},
) => {
  const calendar = configuration?.calendar;
  const sessions = dailyRanges.map((range) => {
    const sessionPoints = points.filter((point) => (
      point?.sessionDate || chartSessionDate(point?.timestamp)
    ) === range?.date);
    if (!range?.date || sessionPoints.length < 2) return null;
    const firstTimestamp = Number(sessionPoints[0].timestamp);
    const lastTimestamp = Number(sessionPoints[sessionPoints.length - 1].timestamp);
    const startAt = Number.isFinite(Number(range.startAt)) ? Number(range.startAt) : firstTimestamp;
    const endAt = Number.isFinite(Number(range.endAt)) ? Number(range.endAt) : lastTimestamp;
    if (!(endAt > startAt)) return null;
    return {
      date: range.date,
      points: sessionPoints,
      range,
      riskRange: riskRangeValues(range),
      startAt,
      endAt,
    };
  }).filter(Boolean);
  if (sessions.length !== expectedSessionCount) {
    return {
      points: [], sessions: [], gaps: [], closedDays: [], weekendOpenSessions: [],
      maxX: null, axisGridTemplate: null, latestPoint: null,
    };
  }

  const calendarAware = [US_EQUITY_CALENDAR, WEEKDAY_CALENDAR, CONTINUOUS_CALENDAR].includes(calendar);
  const gapDefinitions = sessions.slice(1).map((session, index) => {
    const previousDate = sessions[index].date;
    if (calendarAware) {
      const missingDateKeys = calendarDateKeysBetween(previousDate, session.date);
      const closuresByDate = new Map(
        closedDatesBetweenForCalendar(calendar, previousDate, session.date)
          .map((closure) => [closure.date, closure]),
      );
      const segments = missingDateKeys.length
        ? missingDateKeys.map((date) => {
            const closure = closuresByDate.get(date);
            return closure
              ? { type: 'closed', date, closure }
              : { type: 'neutral', date, closure: null };
          })
        : [{ type: 'neutral', date: null, closure: null }];
      const closedDays = segments.filter((segment) => segment.type === 'closed').map((segment) => segment.closure);
      return {
        date: session.date,
        previousDate,
        calendarAware: true,
        missingDateKeys,
        unknownDateKeys: segments
          .filter((segment) => segment.type === 'neutral' && segment.date)
          .map((segment) => segment.date),
        segments,
        closedDays,
        isWeekend: closedDays.some((closure) => closure.type === 'weekend'),
      };
    }
    return {
      date: session.date,
      previousDate,
      calendarAware: false,
      missingDateKeys: calendarDateKeysBetween(previousDate, session.date),
      unknownDateKeys: [],
      segments: [],
      closedDays: [],
      isWeekend: crossesWeekend(previousDate, session.date),
    };
  });
  const numericPlotWidth = Number(plotWidthPx);
  let weekendGapUnits = DEFAULT_WEEKEND_SESSION_GAP;
  let closedDayUnits = null;
  const closedDayWidthPx = Number(configuration?.closedDayWidthPx);
  if (calendarAware) {
    const closedDayCount = gapDefinitions.reduce((sum, gap) => sum + gap.closedDays.length, 0);
    const neutralSegmentCount = gapDefinitions.reduce(
      (sum, gap) => sum + gap.segments.filter((segment) => segment.type === 'neutral').length,
      0,
    );
    const baseLayoutUnits = sessions.length + (neutralSegmentCount * MULTI_DAY_SESSION_GAP);
    const desiredWidthPx = Number.isFinite(closedDayWidthPx) && closedDayWidthPx > 0 ? closedDayWidthPx : 44;
    const fixedClosedWidthPx = desiredWidthPx * closedDayCount;
    closedDayUnits = closedDayCount > 0
      && Number.isFinite(numericPlotWidth)
      && numericPlotWidth > fixedClosedWidthPx
      ? (desiredWidthPx * baseLayoutUnits) / (numericPlotWidth - fixedClosedWidthPx)
      : Math.max(0.18, desiredWidthPx / 140);
  } else {
    const weekendGapCount = gapDefinitions.filter((gap) => gap.isWeekend).length;
    const regularGapCount = gapDefinitions.length - weekendGapCount;
    const baseLayoutUnits = sessions.length + (regularGapCount * MULTI_DAY_SESSION_GAP);
    weekendGapUnits = weekendGapCount > 0
      && Number.isFinite(numericPlotWidth)
      && numericPlotWidth > WEEKEND_INTERVAL_WIDTH_PX * weekendGapCount
      ? (WEEKEND_INTERVAL_WIDTH_PX * baseLayoutUnits)
        / (numericPlotWidth - (WEEKEND_INTERVAL_WIDTH_PX * weekendGapCount))
      : DEFAULT_WEEKEND_SESSION_GAP;
  }

  const plottedPoints = [];
  const plottedSessions = [];
  const gaps = [];
  let cursorX = 0;
  sessions.forEach((session, index) => {
    if (index > 0) {
      const definition = gapDefinitions[index - 1];
      const startX = cursorX;
      if (calendarAware) {
        let segmentCursorX = startX;
        const segments = definition.segments.map((segment) => {
          const width = segment.type === 'closed' ? closedDayUnits : MULTI_DAY_SESSION_GAP;
          const segmentStartX = segmentCursorX;
          const segmentEndX = segmentStartX + width;
          const inset = segment.type === 'closed'
            ? width * (CLOSED_DAY_BAND_GUTTER_PX / Math.max(closedDayWidthPx || 44, 1))
            : 0;
          segmentCursorX = segmentEndX;
          return {
            ...segment,
            x: segmentStartX + (width / 2),
            startX: segmentStartX,
            endX: segmentEndX,
            width,
            ...(segment.type === 'closed' ? {
              bandStartX: segmentStartX + inset,
              bandEndX: segmentEndX - inset,
            } : {}),
          };
        });
        const endX = segmentCursorX;
        const closedDays = segments
          .filter((segment) => segment.type === 'closed')
          .map((segment) => ({
            ...segment.closure,
            x: segment.x,
            startX: segment.startX,
            endX: segment.endX,
            width: segment.width,
            bandStartX: segment.bandStartX,
            bandEndX: segment.bandEndX,
          }));
        const separatorStartX = closedDays[0]?.bandStartX ?? startX;
        const separatorEndX = closedDays[closedDays.length - 1]?.bandEndX ?? endX;
        const x = startX + ((endX - startX) / 2);
        gaps.push({
          ...definition,
          x,
          startX,
          endX,
          width: endX - startX,
          segments,
          closedDays,
          separatorStartX,
          separatorEndX,
        });
        plottedPoints.push({ plotX: x, timestamp: null, value: null, sessionDate: null });
        cursorX = endX;
      } else {
        const width = definition.isWeekend ? weekendGapUnits : MULTI_DAY_SESSION_GAP;
        const endX = startX + width;
        const separatorX = startX + (width / 2);
        const separatorInset = definition.isWeekend
          ? width * (WEEKEND_SEPARATOR_GUTTER_PX / WEEKEND_INTERVAL_WIDTH_PX)
          : 0;
        gaps.push({
          ...definition,
          x: separatorX,
          startX,
          endX,
          width,
          separatorStartX: startX + separatorInset,
          separatorEndX: endX - separatorInset,
        });
        plottedPoints.push({ plotX: separatorX, timestamp: null, value: null, sessionDate: null });
        cursorX = endX;
      }
    }
    const startX = cursorX;
    const endX = startX + 1;
    session.points.forEach((point) => {
      const progress = sessionProgress(point.timestamp, session.startAt, session.endAt);
      if (progress == null) return;
      plottedPoints.push({
        ...point,
        plotX: startX + progress,
        sessionDate: session.date,
      });
    });
    plottedSessions.push({
      ...session,
      startX,
      endX,
      tickX: startX + 0.5,
      label: formatSessionLabel(session.date),
    });
    cursorX = endX;
  });
  const axisGridTemplate = plottedSessions.flatMap((session, index) => {
    if (index === 0) return ['minmax(0, 1fr)'];
    const gap = gaps[index - 1];
    const gapColumns = gap.calendarAware
      ? gap.segments.map((segment) => `${segment.width}fr`)
      : [`${gap.width}fr`];
    return [...gapColumns, 'minmax(0, 1fr)'];
  }).join(' ');
  return {
    points: plottedPoints,
    sessions: plottedSessions,
    gaps,
    closedDays: gaps.flatMap((gap) => gap.closedDays),
    weekendOpenSessions: [],
    maxX: cursorX,
    axisGridTemplate,
    latestPoint: [...plottedPoints].reverse().find((point) => finite(point.value)) || null,
  };
};

export const buildFiveDayChartLayout = (points, dailyRanges = [], plotWidthPx = null, configuration = {}) => (
  buildMultiDayChartLayout(points, dailyRanges, 5, plotWidthPx, configuration)
);

export const projectOverlayPointsToSessions = (points = [], sessions = []) => {
  const orderedSessions = (Array.isArray(sessions) ? sessions : [])
    .filter((session) => Number.isFinite(Number(session?.startAt))
      && Number.isFinite(Number(session?.endAt))
      && Number(session.endAt) > Number(session.startAt));
  const projected = (Array.isArray(points) ? points : []).flatMap((point) => {
    const timestamp = Number(point?.timestamp);
    const value = Number(point?.value);
    if (!Number.isFinite(timestamp) || !Number.isFinite(value)) return [];
    const session = orderedSessions.find((candidate) => (
      timestamp >= Number(candidate.startAt) && timestamp <= Number(candidate.endAt)
    ));
    if (!session) return [];
    const progress = sessionProgress(timestamp, session.startAt, session.endAt);
    if (progress == null) return [];
    return [{
      ...point,
      timestamp,
      value,
      contractValue: value,
      plotX: Number(session.startX) + progress,
      sessionDate: session.date,
    }];
  }).sort((left, right) => left.timestamp - right.timestamp);
  return projected.reduce((withSessionGaps, point) => {
    const previous = withSessionGaps.at(-1);
    if (previous && previous.sessionDate && previous.sessionDate !== point.sessionDate) {
      withSessionGaps.push({
        timestamp: null,
        value: null,
        contractValue: null,
        plotX: (Number(previous.plotX) + Number(point.plotX)) / 2,
        sessionDate: null,
        isSessionGap: true,
      });
    }
    withSessionGaps.push(point);
    return withSessionGaps;
  }, []);
};

export const resolveAthReferenceValue = (ath) => {
  if (ath?.status !== 'available') return null;
  const candidates = [
    ath.value,
    ath.baseline?.value,
    ...(Array.isArray(ath.markers) ? ath.markers.map((marker) => marker?.value) : []),
  ].map(Number).filter((value) => Number.isFinite(value) && value > 0);
  return candidates.length ? Math.max(...candidates) : null;
};

export const resolveAthReferenceDate = (ath, value = resolveAthReferenceValue(ath)) => {
  if (ath?.status !== 'available' || !finite(value)) return null;
  const matchingMarkers = (Array.isArray(ath.markers) ? ath.markers : [])
    .filter((marker) => Number(marker?.value) === Number(value))
    .reverse();
  const datedCandidate = [
    ...(Number(ath.value) === Number(value) ? [ath] : []),
    ...matchingMarkers,
    ...(Number(ath.baseline?.value) === Number(value) ? [ath.baseline] : []),
  ].find((candidate) => /^\d{4}-\d{2}-\d{2}$/.test(String(candidate?.date || '')));
  return datedCandidate?.date || null;
};

export const clampChartReferenceValue = (value, domain) => {
  if (!finite(value) || !finite(domain?.[0]) || !finite(domain?.[1])) {
    return { value: null, edge: null };
  }
  const numericValue = Number(value);
  const minimum = Number(domain?.[0]);
  const maximum = Number(domain?.[1]);
  if (minimum > maximum) {
    return { value: null, edge: null };
  }
  if (numericValue > maximum) return { value: maximum, edge: 'top' };
  if (numericValue < minimum) return { value: minimum, edge: 'bottom' };
  return { value: numericValue, edge: null };
};

const CHART_LABEL_LAYOUT_HEIGHT_PX = 220;
const CHART_LABEL_MIN_GAP_PX = 16;
const CHART_LABEL_EDGE_PADDING_PX = 8;
const CHART_LABEL_TIE_PRIORITY = Object.freeze({ ath: 0, hrr: 1, contract: 2, latest: 3, lrr: 4 });

export const resolveChartLabelOffsets = (labels, domain, options = {}) => {
  const offsets = Object.fromEntries((labels || [])
    .filter((label) => label?.id)
    .map((label) => [label.id, 0]));
  const minimum = Number(domain?.[0]);
  const maximum = Number(domain?.[1]);
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || maximum <= minimum) return offsets;

  const height = Math.max(1, Number(options.height) || CHART_LABEL_LAYOUT_HEIGHT_PX);
  const gap = Math.max(1, Number(options.minGap) || CHART_LABEL_MIN_GAP_PX);
  const requestedPadding = Math.max(0, Number(options.padding) || CHART_LABEL_EDGE_PADDING_PX);
  const padding = Math.min(requestedPadding, height / 2);
  const usableHeight = Math.max(1, height - (padding * 2));
  const positioned = (labels || []).map((label, index) => ({
    ...label,
    index,
    value: Number(label?.value),
  })).filter((label) => label.id && Number.isFinite(label.value))
    .map((label) => ({
      ...label,
      rawY: padding + (((maximum - label.value) / (maximum - minimum)) * usableHeight),
      priority: CHART_LABEL_TIE_PRIORITY[label.id] ?? label.index,
    }))
    .sort((left, right) => left.rawY - right.rawY || left.priority - right.priority || left.index - right.index);

  const clusters = [];
  positioned.forEach((label) => {
    const cluster = clusters[clusters.length - 1];
    const prior = cluster?.[cluster.length - 1];
    if (!cluster || label.rawY - prior.rawY >= gap) clusters.push([label]);
    else cluster.push(label);
  });

  clusters.filter((cluster) => cluster.length > 1).forEach((cluster) => {
    const center = cluster.reduce((sum, label) => sum + label.rawY, 0) / cluster.length;
    const clusterHeight = (cluster.length - 1) * gap;
    const maximumStart = Math.max(padding, height - padding - clusterHeight);
    const start = Math.min(Math.max(center - (clusterHeight / 2), padding), maximumStart);
    cluster.forEach((label, index) => {
      offsets[label.id] = Number(((start + (index * gap)) - label.rawY).toFixed(2));
    });
  });
  return offsets;
};

const formatTooltipTimestamp = (timestamp, includeDate) => new Date(timestamp).toLocaleString('en-US', {
  timeZone: 'America/New_York',
  ...(includeDate ? { weekday: 'short', month: 'short', day: 'numeric' } : {}),
  hour: 'numeric',
  minute: '2-digit',
  timeZoneName: 'short',
});

export const ChartTooltip = ({
  active,
  payload,
  multiDay = false,
  dailyRanges = [],
  ath = null,
  basisSymbol = 'SPOT',
  contractSymbol = 'CONTRACT',
  contractPoints = [],
}) => {
  const basisPayload = (active && payload?.find((entry) => (
    entry?.dataKey === 'value' && finite(entry?.payload?.value)
  ))) || (active && payload?.find((entry) => finite(entry?.payload?.value)));
  const point = basisPayload?.payload;
  if (!point || !finite(point.value) || !Number.isFinite(Number(point.timestamp))) return null;
  const payloadContractPoint = payload?.find((entry) => (
    entry?.dataKey === 'contractValue' && finite(entry?.payload?.contractValue)
  ))?.payload;
  const contractPoint = payloadContractPoint || contractPoints.find((candidate) => (
    Number(candidate?.timestamp) === Number(point.timestamp)
  ));
  const range = multiDay
    ? dailyRanges.find((candidate) => candidate?.date === (point.sessionDate || chartSessionDate(point.timestamp)))
    : null;
  const rangeValues = riskRangeValues(range);
  const structure = range?.structure?.status === 'available' ? range.structure : null;
  const athMarker = multiDay && ath?.status === 'available'
    ? ath.markers?.find((marker) => (
      marker?.date === (point.sessionDate || chartSessionDate(point.timestamp))
      && Number(marker?.timestamp) === Number(point.timestamp)
    ))
    : null;
  return (
    <div className="pm-spx-chart-tooltip">
      <strong>{basisSymbol} {formatIndex(point.value)}</strong>
      {finite(contractPoint?.value ?? contractPoint?.contractValue) && (
        <strong className="pm-spx-chart-tooltip-contract">
          {contractSymbol} {formatIndex(contractPoint?.value ?? contractPoint?.contractValue)}
        </strong>
      )}
      <span>{formatTooltipTimestamp(Number(point.timestamp), multiDay)}</span>
      {multiDay && rangeValues.available && (
        <span className="pm-spx-chart-tooltip-range">
          LRR {formatIndex(rangeValues.lrr, Number.isInteger(rangeValues.lrr) ? 0 : 2)}{structure ? ` · ${structure.lowEvent}` : ''} · HRR {formatIndex(rangeValues.hrr, Number.isInteger(rangeValues.hrr) ? 0 : 2)}{structure ? ` · ${structure.highEvent}` : ''}
          {range?.riskRangeCarryForward === 'last_published_non_publication_session'
            ? ` · published ${formatShortSessionDate(range.riskRangePublicationDate)}`
            : ''}
        </span>
      )}
      {multiDay && !rangeValues.available && <span className="pm-spx-chart-tooltip-range is-unavailable">RR unavailable</span>}
      {athMarker && <span className="pm-spx-chart-tooltip-ath">ATH {formatIndex(athMarker.value, 0)}</span>}
    </div>
  );
};

export function buildSettlementIdentityViewModel(venueSelection, {
  checking = false,
  nowMs = Date.now(),
} = {}) {
  const venue = venueSelection?.venue || null;
  const venueId = String(venue?.id || venueSelection?.id || '').trim().toLowerCase();
  const recognizedVenue = venueId === 'kalshi'
    ? 'KALSHI'
    : venueId === 'forecastex' ? 'FORECASTEX' : null;
  const event = venueSelection?.contracts?.event || venue?.catalog?.event || null;
  if (checking && !venue) {
    return {
      status: 'checking',
      venueText: 'VENUE CHECKING',
      settlementText: 'SETTLEMENT CHECKING',
      eventTicker: null,
      basis: null,
      accessibleLabel: 'Prediction venue checking. Settlement basis checking.',
    };
  }

  const basis = venue?.settlementBasis || null;
  const rawProductCode = event?.seriesTicker || event?.productCode || '';
  const eventProductCode = /^KX[A-Z0-9]+-/i.exec(String(event?.ticker || event?.generationId || ''))?.[0]?.slice(0, -1) || '';
  const productCode = String(rawProductCode || eventProductCode || '').trim().toUpperCase() || null;
  const catalogExpiry = Date.parse(venue?.catalog?.expiresAt || venue?.catalog?.event?.closeTime || '');
  const currentGenerationId = String(venue?.catalog?.event?.generationId || venue?.catalog?.event?.ticker || '');
  const displayedGenerationId = String(event?.generationId || event?.ticker || '');
  const generationMatches = !currentGenerationId || !displayedGenerationId
    || currentGenerationId === displayedGenerationId;
  const catalogCurrent = venue?.catalog?.status === 'available'
    && Number.isFinite(catalogExpiry)
    && catalogExpiry >= Number(nowMs)
    && generationMatches;
  const verified = basis?.status === 'verified'
    && catalogCurrent
    && Boolean(basis.instrument && basis.method && basis.observationAt && basis.sourceName && basis.sourceUrl);
  const partial = basis?.status === 'partial'
    && basis?.instrumentScope === 'product'
    && catalogCurrent
    && Boolean(basis.instrument && basis.method && basis.observationAt && basis.sourceName && basis.sourceUrl && basis.reason);
  if (recognizedVenue && partial) {
    const eventTicker = event?.ticker || event?.generationId || null;
    return {
      status: 'partial',
      venueText: recognizedVenue,
      settlementText: 'SETTLEMENT VERIFIED',
      eventTicker,
      productCode,
      basis,
      reason: basis.reason,
      accessibleLabel: [
        `Prediction venue ${recognizedVenue}.`,
        `Settlement product ${basis.instrument}.`,
        `${basis.method}.`,
        'Exact futures contract month unavailable; any displayed reference is non-executable proxy context.',
        eventTicker ? `Event ${eventTicker}.` : null,
      ].filter(Boolean).join(' '),
    };
  }
  if (!recognizedVenue || !verified) {
    const reason = !recognizedVenue
      ? 'The selected prediction venue is unavailable.'
      : !catalogCurrent
        ? 'The selected catalog generation is missing, changed, or expired.'
        : basis?.reason || 'The selected generation has no verified authoritative settlement basis.';
    return {
      status: 'unavailable',
      venueText: recognizedVenue || 'VENUE UNAVAILABLE',
      settlementText: 'SETTLEMENT BASIS UNAVAILABLE',
      eventTicker: event?.ticker || event?.generationId || null,
      productCode,
      basis: basis || unavailableSettlementBasis(reason),
      reason,
      accessibleLabel: `${recognizedVenue ? `Prediction venue ${recognizedVenue}. ` : ''}Settlement basis unavailable. ${reason}`,
    };
  }

  const settlementText = `SETTLES ON · ${String(basis.sourceName).toUpperCase()} ${basis.instrument} · ${String(basis.method).toUpperCase()}`;
  const eventTicker = event?.ticker || event?.generationId || null;
  return {
    status: 'verified',
    venueText: recognizedVenue,
    settlementText,
    eventTicker,
    productCode,
    basis,
    reason: null,
    accessibleLabel: [
      `Prediction venue ${recognizedVenue}.`,
      `Settles on ${basis.sourceName} ${basis.instrument}.`,
      `${basis.method}.`,
      `Observation time ${basis.observationAt}.`,
      eventTicker ? `Event ${eventTicker}.` : null,
    ].filter(Boolean).join(' '),
  };
}

export const SettlementIdentityChips = ({ venueSelection, checking = false, nowMs = Date.now() }) => {
  const tooltipId = useId();
  const identity = buildSettlementIdentityViewModel(venueSelection, { checking, nowMs });
  const basis = identity.basis;
  return (
    <div
      className={`pm-spx-settlement-identity pm-spx-settlement-identity--compact is-${identity.status}`}
      tabIndex={0}
      aria-label={identity.accessibleLabel}
      aria-describedby={tooltipId}
      data-settlement-status={identity.status}
    >
        <span className={`pm-spx-venue-chip is-${identity.status}`}>
          <strong>{identity.venueText}</strong>
          {identity.productCode && <small>{identity.productCode}</small>}
        </span>
        <div id={tooltipId} className="pm-spx-settlement-tooltip" role="tooltip">
          <strong>{identity.eventTicker ? `EVENT · ${identity.eventTicker}` : 'EVENT · UNAVAILABLE'}</strong>
          {['verified', 'partial'].includes(identity.status) ? (
            <>
              <span>{identity.status === 'partial' ? 'PRODUCT' : 'INSTRUMENT'} · {basis.instrument}</span>
              <span>METHOD · {basis.method}</span>
              <span>OBSERVATION · <time dateTime={basis.observationAt}>{basis.observationAt}</time></span>
              <span>
                SOURCE · <a href={basis.sourceUrl} target="_blank" rel="noreferrer">{basis.sourceName}</a>
              </span>
              <span>
                OFFICIAL RULES · {basis.rulesUrl
                  ? <a href={basis.rulesUrl} target="_blank" rel="noreferrer">{basis.rulesUrl}</a>
                  : identity.eventTicker || 'Contract metadata identity unavailable'}
              </span>
              {identity.status === 'partial' && <span>LIMITATION · {identity.reason}</span>}
            </>
          ) : (
            <span>{identity.reason || 'Waiting for authoritative generation metadata.'}</span>
          )}
        </div>
    </div>
  );
};

export const normalizeGoldHeaderMarketReference = (reference, nowMs) => {
  const role = reference?.role === 'direct' ? 'direct' : 'proxy';
  const rawStatus = String(reference?.status || '').toLowerCase();
  const retainedStatus = String(reference?.retainedStatus || '').toLowerCase();
  const source = String(reference?.source || '');
  const price = finite(reference?.price) && Number(reference.price) > 0 ? Number(reference.price) : null;
  const previousClose = finite(reference?.previousClose) && Number(reference.previousClose) > 0
    ? Number(reference.previousClose)
    : null;
  const changePercent = previousClose != null && price != null
    ? resolveDayChangePercent(price, previousClose)
    : null;
  const asOfMs = Date.parse(reference?.asOf || '');
  const expiresAtMs = Date.parse(reference?.expiresAt || '');
  const ageMs = Number(nowMs) - asOfMs;
  const provenance = [
    source,
    reference?.warning,
    reference?.provenance,
    reference?.cacheState,
    reference?.fromCache ? 'cached' : null,
    reference?.cachedOnly ? 'cached-only' : null,
    reference?.mock ? 'mock' : null,
    reference?.seeded ? 'seed' : null,
  ].filter(Boolean).join(' ');
  const sourceValid = /^(?:ibkr|pyth)(?:\b|_)/i.test(source)
    && !FORBIDDEN_GOLD_CONTEXT_PROVENANCE.test(provenance);
  const currentIbkrBar = source.toLowerCase() === 'ibkr_historical_bars';
  const liveMaxAgeMs = currentIbkrBar
    ? HEADER_CURRENT_BAR_MAX_AGE_MS
    : HEADER_QUOTE_MAX_AGE_MS;
  const liveEvidence = price != null
    && sourceValid
    && Number.isFinite(asOfMs)
    && ageMs >= -5_000
    && ageMs <= liveMaxAgeMs
    && Number.isFinite(expiresAtMs)
    && expiresAtMs >= Number(nowMs);
  const historicalEvidence = price != null
    && sourceValid
    && freshDatedObservation(reference?.asOf, nowMs);
  const live = rawStatus === 'live'
    && liveEvidence;
  const historical = rawStatus === 'historical'
    && historicalEvidence;
  const delayed = rawStatus === 'delayed'
    && ['live', 'historical'].includes(retainedStatus)
    && reference?.displayOnly === true
    && reference?.refreshRetained === true
    && reference?.refreshFailed !== true
    && (retainedStatus === 'live' ? liveEvidence : historicalEvidence);
  const loading = rawStatus === 'loading' || rawStatus === 'refreshing';
  const available = live || historical || delayed;
  return {
    key: reference?.key || null,
    label: reference?.label || 'GOLD REFERENCE',
    symbol: reference?.symbol || 'GOLD',
    role,
    status: live ? 'live' : historical ? 'historical' : delayed ? 'delayed' : loading ? 'loading' : 'unavailable',
    retainedStatus: delayed ? retainedStatus : null,
    price: available ? price : null,
    previousClose: available ? previousClose : null,
    changePercent: available ? changePercent : null,
    source: available ? source : null,
    asOf: available ? reference.asOf : null,
    expiresAt: available ? reference?.expiresAt || null : null,
    instrument: reference?.instrument || null,
    reason: available
      ? reference?.reason || null
      : reference?.reason || 'Verified Gold reference is unavailable.',
  };
};

const GOLD_HEADER_REFERENCE_KEYS = Object.freeze(['selectedResolver', 'xauusd', 'activeComex']);
const GOLD_HEADER_HARD_FAILURE = /(?:disconnect|offline|delayed market data|frozen|stale|expired|entitle|permission|not[_ -]?connected|gateway[_ -]?(?:unavailable|not connected)|non[_ -]?live)/i;

const goldHeaderReferenceIdentityMatches = (previous, next) => {
  if (!previous || !next || previous.key !== next.key) return false;
  const previousConId = Number(previous?.instrument?.conId);
  const nextConId = Number(next?.instrument?.conId);
  if (Number.isInteger(previousConId) && previousConId > 0
    && Number.isInteger(nextConId) && nextConId > 0
    && previousConId !== nextConId) return false;
  const previousMonth = String(previous?.instrument?.contractMonth || '').slice(0, 6);
  const nextMonth = String(next?.instrument?.contractMonth || '').slice(0, 6);
  if (/^\d{6}$/.test(previousMonth) && /^\d{6}$/.test(nextMonth)
    && previousMonth !== nextMonth) return false;
  const specificSymbol = (item) => {
    const symbol = String(
      item?.instrument?.displaySymbol
      || item?.instrument?.symbol
      || item?.symbol
      || '',
    ).trim().toUpperCase();
    return ['', 'GC', 'GOLD'].includes(symbol) ? null : symbol;
  };
  const previousSymbol = specificSymbol(previous);
  const nextSymbol = specificSymbol(next);
  return !previousSymbol || !nextSymbol || previousSymbol === nextSymbol;
};

const pendingGoldHeaderReference = (reference, snapshotPending) => {
  const failure = `${reference?.errorCode || ''} ${reference?.refreshIssue || reference?.reason || ''}`;
  if (reference?.refreshFailed === true || GOLD_HEADER_HARD_FAILURE.test(failure)) return false;
  const status = String(reference?.status || '').toLowerCase();
  if (['loading', 'refreshing'].includes(status)
    || reference?.refreshing === true
    || reference?.refreshPending === true) return true;
  return snapshotPending
    && status === 'unavailable'
    && /(?:load|refresh|pending|checking|waiting)/i.test(failure);
};

const delayedGoldHeaderReference = (previous, next, nowMs) => {
  const normalized = normalizeGoldHeaderMarketReference(previous, nowMs);
  if (!['live', 'historical', 'delayed'].includes(normalized.status)) return next;
  return {
    ...previous,
    status: 'delayed',
    retainedStatus: normalized.status === 'delayed'
      ? normalized.retainedStatus
      : normalized.status,
    displayOnly: true,
    executable: false,
    refreshPending: true,
    refreshRetained: true,
    refreshFailed: false,
    delayedReason: next?.refreshIssue || next?.reason || 'A fresh quote is loading; showing the last verified value.',
    reason: next?.refreshIssue || next?.reason || previous?.reason || null,
  };
};

export function stabilizeGoldHeaderMarketReferences(previous, snapshot, nowMs = Date.now()) {
  if (!snapshot || snapshot?.marketId !== 'gold') return null;
  const snapshotPending = snapshot?.sourceRefreshPending === true
    || snapshot?.refreshPending === true
    || snapshot?.refresh?.state === 'refreshing';
  const previousByKey = new Map((Array.isArray(previous) ? previous : [])
    .map((reference) => [reference?.key, reference]));
  const incomingByKey = new Map((Array.isArray(snapshot?.goldMarketReferences)
    ? snapshot.goldMarketReferences
    : []).map((reference) => [reference?.key, reference]));
  return GOLD_HEADER_REFERENCE_KEYS.map((key) => {
    const prior = previousByKey.get(key) || null;
    const incoming = incomingByKey.get(key) || (snapshotPending && prior ? {
      key,
      label: prior.label,
      symbol: prior.symbol,
      role: prior.role,
      status: 'loading',
      reason: 'A fresh Gold reference is loading.',
    } : null);
    const normalizedIncoming = normalizeGoldHeaderMarketReference(incoming, nowMs);
    if (['live', 'historical', 'delayed'].includes(normalizedIncoming.status)) return incoming;
    if (prior
      && incoming
      && goldHeaderReferenceIdentityMatches(prior, incoming)
      && pendingGoldHeaderReference(incoming, snapshotPending)) {
      return delayedGoldHeaderReference(prior, incoming, nowMs);
    }
    return incoming;
  }).filter(Boolean);
}

const compactGoldReferenceSource = (source) => {
  const token = String(source || '').trim().toLowerCase();
  if (!token) return 'SOURCE —';
  if (token.startsWith('pyth_lazer')) return 'PYTH LAZER';
  if (token.startsWith('pyth')) return 'PYTH';
  if (token === 'ibkr') return 'IBKR';
  if (token.startsWith('ibkr_historical')) return 'IBKR HISTORY';
  if (token.startsWith('ibkr')) return 'IBKR';
  return humanizeSource(token);
};

const SpxHeaderMarketMeasure = ({
  kind,
  symbol,
  value,
  changePercent = null,
  asOf = null,
  status = 'unavailable',
  reason = null,
  precision = 2,
  primary = false,
  referenceRole = 'proxy',
  testIdPrefix = 'spx',
  details = null,
}) => {
  const historical = status === 'historical';
  const delayed = status === 'delayed';
  const available = ['live', 'historical', 'delayed'].includes(status) && finite(value);
  const priceTone = !available
    ? 'unavailable'
    : finite(changePercent)
      ? Number(changePercent) > 0 ? 'positive' : Number(changePercent) < 0 ? 'negative' : 'neutral'
      : 'neutral';
  const changeTone = available && finite(changePercent)
    ? priceTone
    : 'unavailable';
  const directionPeriod = historical ? 'versus the prior close' : 'today';
  const direction = !finite(changePercent)
    ? 'daily change unavailable'
    : Number(changePercent) > 0
      ? `up ${Math.abs(Number(changePercent)).toFixed(2)} percent ${directionPeriod}`
      : Number(changePercent) < 0
        ? `down ${Math.abs(Number(changePercent)).toFixed(2)} percent ${directionPeriod}`
        : `unchanged ${directionPeriod}`;
  const directReference = ['primary', 'direct'].includes(referenceRole);
  const referenceRoleLabel = referenceRole === 'direct' ? 'DIRECT' : referenceRole === 'primary' ? 'PRIMARY' : 'PROXY';
  const referenceRoleDescription = referenceRole === 'primary'
    ? 'Primary instrument used by this contract'
    : directReference
      ? 'Direct instrument used by this contract settlement basis'
      : 'Related market proxy; not the contract resolver';
  const statusText = status === 'loading'
    ? `Checking ${referenceRoleDescription.toLowerCase()} ${symbol}`
    : available
      ? `${referenceRoleDescription}. ${delayed ? 'Delayed, last verified ' : ''}${kind} ${symbol}, ${formatIndex(value, precision)}, ${direction}${asOf ? `, as of ${asOf}` : ''}`
      : `${referenceRoleDescription}. ${kind} ${symbol} unavailable${reason ? `. ${reason}` : ''}`;
  const parenthesizedChange = available && finite(changePercent)
    ? `(${formatDayChangePercent(changePercent)})`
    : '(—)';

  return (
    <div
      className={`pm-spx-market-measure is-${status}${primary ? ' is-primary' : ''}`}
      data-testid={`${testIdPrefix}-header-measure-${String(symbol).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}
      aria-label={statusText}
      title={statusText}
    >
      <span className="pm-spx-market-measure-kind">
        <span>{kind}</span>
        <b>{symbol}</b>
        <em
          className={`pm-spx-market-measure-role pm-spx-market-measure-role--${referenceRole}`}
          aria-label={referenceRoleDescription}
          title={referenceRoleDescription}
        >
          {referenceRoleLabel}
        </em>
      </span>
      <span className="pm-spx-market-measure-row">
        <span className="pm-spx-market-measure-value">
          <strong className={`${primary ? 'pm-spx-chart-price ' : ''}pm-spx-market-measure-price is-${priceTone}`}>
            {available ? formatIndex(value, precision) : '—'}
          </strong>
          <span
            className={`${primary ? 'pm-spx-day-change ' : ''}pm-spx-market-measure-change is-${changeTone}`}
            aria-label={available && finite(changePercent) ? `${symbol} ${direction}` : `${symbol} daily change unavailable`}
          >
            {parenthesizedChange}
          </span>
          <DelayedDataMarker
            status={status}
            title={delayed ? `${symbol} delayed quote` : `${symbol} historical reference`}
            updatedAt={asOf}
          />
        </span>
      </span>
      {details && (
        <span className="pm-spx-market-measure-details" aria-label={`${details.sourceInstrument}. ${details.statusAsOf}.`}>
          <span>{details.sourceInstrument}</span>
          <span>{details.statusAsOf}</span>
        </span>
      )}
    </div>
  );
};

const SpxHeaderMarketStrip = ({ cashSpot, spySpot, futuresReference, nowMs }) => {
  const cashLive = isVerifiedLiveCashHeaderQuote(cashSpot, nowMs);
  const cashHistorical = isVerifiedHistoricalCashHeaderQuote(cashSpot, nowMs);
  const cashDelayed = !cashLive && !cashHistorical
    && isRetainableSpxHeaderReference(cashSpot, nowMs);
  const cashAvailable = cashLive || cashHistorical || cashDelayed;
  const cashChange = cashAvailable
    ? resolveDayChangePercent(cashSpot?.value, cashSpot?.previousClose)
    : null;
  const spyLive = isVerifiedLiveCashHeaderQuote(spySpot, nowMs);
  const spyHistorical = isVerifiedHistoricalCashHeaderQuote(spySpot, nowMs);
  const spyDelayed = !spyLive && !spyHistorical
    && isRetainableSpxHeaderReference(spySpot, nowMs);
  const spyAvailable = spyLive || spyHistorical || spyDelayed;
  const spyChange = spyAvailable
    ? resolveDayChangePercent(spySpot?.value, spySpot?.previousClose)
    : null;
  const futuresSpot = futuresReference?.spot;
  const futuresLive = isVerifiedDisplayReference(futuresSpot, nowMs);
  const futuresDelayed = !futuresLive && isRetainableSpxHeaderReference(futuresSpot, nowMs);
  const futuresAvailable = futuresLive || futuresDelayed;
  const futuresHistorical = futuresSpot?.status === 'historical'
    || futuresSpot?.availability === 'historical';
  const futuresSymbol = futuresReference?.instrument?.displaySymbol
    || futuresSpot?.label
    || 'ES';
  const futuresChange = futuresAvailable
    ? resolveDayChangePercent(futuresSpot?.value, futuresSpot?.previousClose)
    : null;

  return (
    <div className="pm-spx-market-strip" role="group" aria-label="S&P 500 market measures">
      <SpxHeaderMarketMeasure
        kind={`S&P 500 INDEX${cashHistorical ? ' · LAST CLOSE' : ''}`}
        symbol="SPX"
        value={cashSpot?.value}
        changePercent={cashChange}
        asOf={cashSpot?.asOf}
        status={cashLive ? 'live' : cashHistorical ? 'historical' : cashDelayed ? 'delayed' : cashSpot?.status === 'loading' ? 'loading' : 'unavailable'}
        reason={cashSpot?.reason || 'A verified-live cash-index trade is unavailable.'}
        referenceRole="proxy"
        primary
      />
      <SpxHeaderMarketMeasure
        kind={`SPDR ETF${spyHistorical ? ' · LAST CLOSE' : ''}`}
        symbol="SPY"
        value={spySpot?.value}
        changePercent={spyChange}
        asOf={spySpot?.asOf}
        status={spyLive ? 'live' : spyHistorical ? 'historical' : spyDelayed ? 'delayed' : spySpot?.status === 'loading' ? 'loading' : 'unavailable'}
        reason={spySpot?.reason}
        referenceRole="proxy"
      />
      <SpxHeaderMarketMeasure
        kind={`E-MINI FUTURE${futuresHistorical ? ' · LAST CLOSE' : ''}`}
        symbol={futuresSymbol}
        value={futuresSpot?.value}
        changePercent={futuresChange}
        asOf={futuresSpot?.asOf}
        status={futuresAvailable
          ? futuresDelayed ? 'delayed' : futuresHistorical ? 'historical' : 'live'
          : futuresSpot?.status === 'loading' ? 'loading' : 'unavailable'}
        reason={futuresSpot?.reason || 'The verified ES directional reference is unavailable.'}
        referenceRole="primary"
      />
    </div>
  );
};

const GoldHeaderMarketStrip = ({ references = [], nowMs }) => {
  const incoming = new Map((Array.isArray(references) ? references : [])
    .map((reference) => [reference?.key, reference]));
  const placeholders = [
    { key: 'xauusd', label: 'SPOT GOLD', symbol: 'XAUUSD', role: 'proxy' },
    { key: 'activeComex', label: 'COMEX GOLD', symbol: 'GC', role: 'proxy' },
  ];
  const items = placeholders.map((placeholder) => normalizeGoldHeaderMarketReference(
    incoming.get(placeholder.key) || {
      ...placeholder,
      status: 'loading',
      reason: 'Verified Gold reference is loading.',
    },
    nowMs,
  ));
  return (
    <div className="pm-spx-market-strip pm-gold-market-strip" role="group" aria-label="Gold market references">
      {items.map((item, index) => (
        <SpxHeaderMarketMeasure
          key={item.key}
          kind={`${item.label}${item.status === 'historical'
            || (item.status === 'delayed' && item.retainedStatus === 'historical')
            ? ' · LAST CLOSE'
            : ''}`}
          symbol={item.symbol}
          value={item.price}
          changePercent={item.changePercent}
          asOf={item.asOf}
          status={item.status}
          reason={item.reason}
          precision={1}
          referenceRole={item.role}
          primary={index === 0}
          testIdPrefix="gold"
          details={{
            sourceInstrument: `${compactGoldReferenceSource(item.source)} · ${item.instrument?.displaySymbol || item.instrument?.symbol || item.symbol}`,
            statusAsOf: `${item.status.toUpperCase()} · AS OF ${item.asOf ? formatAsOf(item.asOf) : '—'}`,
          }}
        />
      ))}
      <div
        className="pm-spx-market-measure pm-gold-market-spacer"
        data-testid="gold-header-measure-spacer"
        aria-hidden="true"
      />
    </div>
  );
};

const goldCorrelationHeatClass = (value) => {
  if (!finite(value)) return 'is-unavailable';
  const displayed = Number(Number(value).toFixed(2));
  const magnitude = Math.abs(displayed);
  if (displayed === 0) return 'is-neutral';
  const direction = displayed > 0 ? 'positive' : 'negative';
  if (magnitude >= GOLD_CORRELATION_STRONG_THRESHOLD) return `is-${direction}-strong`;
  if (magnitude >= GOLD_CORRELATION_SHADE_THRESHOLD) return `is-${direction}-light`;
  return `is-${direction}`;
};

const formatCorrelationCell = (value) => finite(value)
  ? Math.abs(Number(value)).toFixed(2)
  : '—';

const goldCorrelationAccessibleLabel = (rowLabel, horizon, value) => {
  if (!finite(value)) return `${rowLabel} ${horizon}: correlation unavailable`;
  const displayed = Number(Number(value).toFixed(2));
  const direction = displayed > 0 ? 'positive' : displayed < 0 ? 'negative' : 'zero';
  return `${rowLabel} ${horizon}: ${direction} correlation ${Math.abs(displayed).toFixed(2)}`;
};

const goldCorrelationLastFormatters = Object.freeze({
  index: new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  percent: new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  'USD/ozt': new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  'USD/bbl': new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }),
});

const formatGoldCorrelationLast = (latest) => {
  if (!finite(latest?.value)) return '—';
  const formatted = goldCorrelationLastFormatters[latest.unit]?.format(Number(latest.value));
  if (!formatted) return '—';
  return latest.unit === 'percent' ? `${formatted}%` : formatted;
};

const GoldCorrelationPanel = ({ snapshot, state = 'loading', reason = null }) => {
  const available = ['available', 'partial'].includes(snapshot?.status)
    && Array.isArray(snapshot?.rows)
    && snapshot.rows.length > 0;
  const loading = state === 'loading' && !available;
  return (
    <aside
      className={`pm-gold-correlation-panel is-${loading ? 'loading' : available ? snapshot.status : 'unavailable'}`}
      aria-label="Gold correlation matrix"
      data-testid="gold-correlation-panel"
    >
      <header>
        <strong>GOLD CORRELATION</strong>
        <span>XAUUSD PROXY BASIS · COMPLETED DAILY CHANGES</span>
      </header>
      {available ? (
        <table>
          <colgroup>
            <col className="is-driver" />
            <col className="is-last" />
            {GOLD_CORRELATION_HORIZONS.map((horizon) => <col key={horizon} />)}
          </colgroup>
          <thead>
            <tr>
              <th scope="col">DRIVER</th>
              <th scope="col">LAST</th>
              {GOLD_CORRELATION_HORIZONS.map((horizon) => <th key={horizon} scope="col">{horizon}</th>)}
            </tr>
          </thead>
          <tbody>
            {snapshot.rows.map((row) => (
              <tr key={row.key} className={`is-${row.status}`} title={[row.source, row.asOf && `As of ${row.asOf}`, row.reason].filter(Boolean).join(' · ')}>
                <th scope="row">
                  <span>{row.label}</span>
                  {row.transform === 'yield_change_bps' && <small>Δ BP</small>}
                </th>
                <td
                  className="is-last"
                  aria-label={`${row.label} last completed observation: ${formatGoldCorrelationLast(row.latest)}${row.latest?.asOf ? ` as of ${row.latest.asOf}` : ''}`}
                >
                  {formatGoldCorrelationLast(row.latest)}
                </td>
                {GOLD_CORRELATION_HORIZONS.map((horizon) => {
                  const value = row.values?.[horizon];
                  return (
                    <td
                      key={horizon}
                      className={goldCorrelationHeatClass(value)}
                      aria-label={goldCorrelationAccessibleLabel(row.label, horizon, value)}
                    >
                      {formatCorrelationCell(value)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="pm-gold-correlation-state" role="status" aria-live="polite">
          <strong>{loading ? 'CHECKING VERIFIED DAILY HISTORY' : 'CORRELATION DATA UNAVAILABLE'}</strong>
          <span>{loading
            ? 'Waiting for IBKR XAUUSD and current comparator histories.'
            : reason || snapshot?.reason || 'No verified current Gold correlation snapshot is available.'}</span>
        </div>
      )}
    </aside>
  );
};

const formatCpiPercent = (value) => finite(value) ? `${Number(value).toFixed(1)}%` : '—';

const formatCpiMonth = (value) => {
  const match = String(value || '').match(/^(20\d{2})-(0[1-9]|1[0-2])$/);
  if (!match) return value || 'CURRENT REPORT';
  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1)));
};

const formatCpiReleaseAt = (value) => {
  const timestamp = Date.parse(value || '');
  if (!Number.isFinite(timestamp)) return 'RELEASE TIME UNAVAILABLE';
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/New_York',
    timeZoneName: 'short',
  }).format(new Date(timestamp));
};

const cpiUtcDayStart = (value) => {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
};

const cpiUtcDateKey = (value) => {
  const dayStart = cpiUtcDayStart(value);
  return Number.isFinite(dayStart) ? new Date(dayStart).toISOString().slice(0, 10) : null;
};

export const buildCpiCalendarAxis = (reportMonth, points = []) => {
  const monthMatch = /^(20\d{2})-(0[1-9]|1[0-2])$/.exec(String(reportMonth || ''));
  const sourceTimestamps = (Array.isArray(points) ? points : [])
    .map((point) => Number(point?.timestamp ?? point))
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  const firstSourceDay = sourceTimestamps.length ? cpiUtcDayStart(sourceTimestamps[0]) : null;
  const lastSourceDay = sourceTimestamps.length ? cpiUtcDayStart(sourceTimestamps.at(-1)) : null;
  const reportStart = monthMatch
    ? Date.UTC(Number(monthMatch[1]), Number(monthMatch[2]) - 1, 1)
    : null;
  const reportEndExclusive = monthMatch
    ? Date.UTC(Number(monthMatch[1]), Number(monthMatch[2]), 1)
    : null;
  const startMs = Number.isFinite(reportStart) && Number.isFinite(firstSourceDay)
    ? Math.min(reportStart, firstSourceDay)
    : reportStart ?? firstSourceDay;
  const endExclusiveMs = Number.isFinite(reportEndExclusive) && Number.isFinite(lastSourceDay)
    ? Math.max(reportEndExclusive, lastSourceDay + UTC_DAY_MS)
    : reportEndExclusive ?? (Number.isFinite(lastSourceDay) ? lastSourceDay + UTC_DAY_MS : null);
  if (!Number.isFinite(startMs) || !Number.isFinite(endExclusiveMs) || endExclusiveMs <= startMs) {
    return null;
  }

  const weekendDays = [];
  for (let cursor = startMs; cursor < endExclusiveMs; cursor += UTC_DAY_MS) {
    const day = new Date(cursor).getUTCDay();
    if (day !== 0 && day !== 6) continue;
    weekendDays.push({
      date: cpiUtcDateKey(cursor),
      startMs: cursor,
      endMs: Math.min(cursor + UTC_DAY_MS, endExclusiveMs),
    });
  }

  const ticks = [];
  for (let cursor = startMs; cursor < endExclusiveMs; cursor += 7 * UTC_DAY_MS) {
    ticks.push(cursor + (UTC_DAY_MS / 2));
  }
  const lastCalendarDay = endExclusiveMs - UTC_DAY_MS;
  const lastTickDay = ticks.length ? cpiUtcDayStart(ticks.at(-1)) : null;
  if (!Number.isFinite(lastTickDay) || lastCalendarDay - lastTickDay >= 2 * UTC_DAY_MS) {
    ticks.push(lastCalendarDay + (UTC_DAY_MS / 2));
  }

  return {
    domain: [startMs, endExclusiveMs - 1],
    ticks,
    weekendDays,
    startDate: cpiUtcDateKey(startMs),
    endDate: cpiUtcDateKey(lastCalendarDay),
    sourceStartDate: sourceTimestamps.length ? cpiUtcDateKey(sourceTimestamps[0]) : null,
    sourceEndDate: sourceTimestamps.length ? cpiUtcDateKey(sourceTimestamps.at(-1)) : null,
  };
};

const CpiForecastTooltip = ({ active, payload, label }) => {
  if (!active || !Array.isArray(payload) || !payload.length) return null;
  const point = payload.find((entry) => finite(entry?.value));
  if (!point) return null;
  return (
    <div className="pm-cpi-tooltip">
      <strong>CLEVELAND FED {formatCpiPercent(point.value)}</strong>
      <span>{Number.isFinite(Number(label)) ? new Date(Number(label)).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
      }) : 'DATE UNAVAILABLE'}</span>
    </div>
  );
};

const CpiForecastComparisonPanel = ({
  snapshot,
  nowMs,
  loading = false,
  refreshDelayed = false,
  resourceRefreshing = false,
  venueSelection = null,
}) => {
  const comparison = snapshot?.forecastComparison || null;
  const reportMonth = comparison?.reportMonth || null;
  const event = venueSelection?.contracts?.event
    || venueSelection?.venue?.book?.event
    || venueSelection?.venue?.catalog?.event
    || snapshot?.contracts?.event
    || null;
  const releaseAtMs = Date.parse(comparison?.releaseAt || '');
  const releaseCurrent = Number.isFinite(releaseAtMs) && releaseAtMs > nowMs;
  const contractClock = buildContractTradingClock({ event, nowMs });
  const contractClockChecking = loading && !event;
  const contractClockHeadline = contractClockChecking
    ? 'CHECKING MARKET HOURS'
    : String(contractClock.headline || '');
  const contractClockSeparator = contractClockHeadline.indexOf(' · ');
  const contractClockStatus = contractClockSeparator >= 0
    ? contractClockHeadline.slice(0, contractClockSeparator)
    : contractClockHeadline;
  const contractClockTiming = contractClockSeparator >= 0
    ? contractClockHeadline.slice(contractClockSeparator + 3)
    : null;
  const exactSource = (source) => source?.status === 'available'
    && source?.reportMonth === reportMonth
    && releaseCurrent;
  const hedgeyeAvailable = exactSource(comparison?.hedgeye);
  const clevelandAvailable = exactSource(comparison?.clevelandFed);
  const blsFinal = comparison?.bls?.latestFinal || null;
  const blsAvailable = comparison?.bls?.status === 'available'
    && finite(blsFinal?.value)
    && String(blsFinal?.reportMonth || '') < String(reportMonth || '');
  const scenarios = hedgeyeAvailable
    ? (comparison.hedgeye.scenarios || []).filter((scenario) => finite(scenario?.value))
    : [];
  const clevelandPoints = clevelandAvailable
    ? (comparison.clevelandFed.points || []).map((point) => ({
        timestamp: Number(point.timestamp),
        cleveland: Number(point.value),
      })).filter((point) => Number.isFinite(point.timestamp) && finite(point.cleveland))
        .sort((left, right) => left.timestamp - right.timestamp)
    : [];
  const latestCleveland = clevelandPoints.at(-1) || null;
  const cpiCalendarAxis = buildCpiCalendarAxis(reportMonth, clevelandPoints);
  const allValues = [
    ...scenarios.map((scenario) => Number(scenario.value)),
    ...clevelandPoints.map((point) => Number(point.cleveland)),
    ...(blsAvailable ? [Number(blsFinal.value)] : []),
  ].filter(Number.isFinite);
  const minimum = allValues.length ? Math.min(...allValues) : 0;
  const maximum = allValues.length ? Math.max(...allValues) : 5;
  const padding = Math.max(0.15, (maximum - minimum) * 0.18);
  const yDomain = [
    Math.floor((minimum - padding) * 10) / 10,
    Math.ceil((maximum + padding) * 10) / 10,
  ];
  const scenarioByKey = new Map(scenarios.map((scenario) => [scenario.key, scenario]));
  const cpiChartLabelOffsets = resolveChartLabelOffsets([
    ...(scenarioByKey.has('upside') ? [{ id: 'upside', value: Number(scenarioByKey.get('upside').value) }] : []),
    ...(scenarioByKey.has('base') ? [{ id: 'base', value: Number(scenarioByKey.get('base').value) }] : []),
    ...(blsAvailable ? [{ id: 'bls', value: Number(blsFinal.value) }] : []),
    ...(latestCleveland ? [{ id: 'cleveland', value: Number(latestCleveland.cleveland) }] : []),
    ...(scenarioByKey.has('downside') ? [{ id: 'downside', value: Number(scenarioByKey.get('downside').value) }] : []),
  ], yDomain, {
    height: 84,
    minGap: 14,
    padding: 4,
  });
  const chartRows = clevelandPoints.length
    ? clevelandPoints
    : [
        { timestamp: Math.max(0, nowMs - 7 * 24 * 60 * 60_000), cleveland: null },
        { timestamp: Number.isFinite(releaseAtMs) ? Math.max(nowMs, releaseAtMs) : nowMs, cleveland: null },
      ];
  const settlement = buildSettlementIdentityViewModel(venueSelection, {
    checking: loading && !snapshot,
    nowMs,
  });
  const settlementStatusLabel = settlement.status === 'verified'
    ? 'BLS VERIFIED'
    : settlement.status === 'partial'
      ? 'SETTLEMENT PARTIAL'
      : 'SETTLEMENT UNAVAILABLE';
  const sourceTiles = [
    {
      id: 'hedgeye', label: 'HEDGEYE', status: hedgeyeAvailable ? 'available' : comparison?.hedgeye?.status || 'unavailable',
      value: hedgeyeAvailable ? `D ${formatCpiPercent(scenarios.find((item) => item.key === 'downside')?.value)} · B ${formatCpiPercent(scenarios.find((item) => item.key === 'base')?.value)} · U ${formatCpiPercent(scenarios.find((item) => item.key === 'upside')?.value)}` : '—',
      asOf: comparison?.hedgeye?.asOf, reason: comparison?.hedgeye?.reason,
    },
    {
      id: 'cleveland', label: 'CLEVELAND FED', status: clevelandAvailable ? 'available' : comparison?.clevelandFed?.status || 'unavailable',
      value: clevelandAvailable ? formatCpiPercent(comparison.clevelandFed.value) : '—',
      asOf: comparison?.clevelandFed?.asOf, reason: comparison?.clevelandFed?.reason,
    },
    {
      id: 'bls', label: blsAvailable ? `BLS ${formatCpiMonth(blsFinal.reportMonth).toUpperCase()} ACTUAL` : 'BLS LATEST ACTUAL',
      status: blsAvailable ? 'available' : comparison?.bls?.status || 'unavailable',
      value: blsAvailable ? formatCpiPercent(blsFinal.value) : '—',
      asOf: comparison?.bls?.fetchedAt || comparison?.bls?.asOf, reason: comparison?.bls?.reason,
    },
  ];
  const waiting = loading || resourceRefreshing || comparison?.status === 'refreshing';

  return (
    <section
      className={`pm-cpi-comparison-panel is-${comparison?.status || (waiting ? 'refreshing' : 'unavailable')}`}
      aria-label={`${formatCpiMonth(reportMonth)} headline CPI year-over-year forecast comparison`}
      data-testid="cpi-forecast-comparison"
    >
      <header className="pm-cpi-comparison-header">
        <div className="pm-cpi-contract-identity">
          <span>HEADLINE CPI-U · YEAR OVER YEAR</span>
          <strong>{formatCpiMonth(reportMonth).toUpperCase()}</strong>
          <small>{comparison?.eventTicker || 'CURRENT KALSHI EVENT CHECKING'}</small>
        </div>
        <div
          className="pm-cpi-settlement-badges"
          aria-label={settlement.accessibleLabel}
          title={settlement.status === 'verified' ? settlement.settlementText : settlement.reason || undefined}
        >
          <span className={`is-${settlement.status === 'unavailable' ? 'unavailable' : 'verified'}`}>{settlement.venueText}</span>
          <span className={`is-${settlement.status === 'unavailable' ? 'unavailable' : 'verified'}`}>{settlementStatusLabel}</span>
          {(snapshot?.referenceOnly || refreshDelayed) && <span className="is-reference">DATED REFERENCE</span>}
        </div>
        <div
          className="pm-cpi-event-clock pm-cpi-release-clock"
          aria-label="BLS release time"
          data-testid="cpi-release-clock"
        >
          <span>BLS RELEASE</span>
          <strong>{formatCpiReleaseAt(comparison?.releaseAt)}</strong>
        </div>
        <div
          className={`pm-spx-contract-clock pm-spx-chart-contract-clock is-${contractClockChecking ? 'loading' : contractClock.state}`}
          aria-label="Selected contract trading hours"
          title={contractClockChecking ? 'Waiting for verified current contract hours.' : contractClock.title}
        >
          <strong className="pm-spx-contract-clock-status">{contractClockStatus}</strong>
          {contractClockTiming && (
            <span className="pm-spx-contract-clock-timing">{contractClockTiming}</span>
          )}
        </div>
      </header>

      <div className="pm-cpi-comparison-chart" role="img" aria-label="Cleveland Fed CPI nowcast history with Hedgeye scenario and latest BLS actual reference lines">
        {allValues.length ? (
          <div
            className="pm-cpi-comparison-chart-plot"
            data-testid="cpi-forecast-chart-plot"
            data-label-collision-count={Object.values(cpiChartLabelOffsets)
              .filter((offset) => Math.abs(Number(offset)) > 0.01).length}
            data-calendar-start-date={cpiCalendarAxis?.startDate || undefined}
            data-calendar-end-date={cpiCalendarAxis?.endDate || undefined}
            data-source-start-date={cpiCalendarAxis?.sourceStartDate || undefined}
            data-source-end-date={cpiCalendarAxis?.sourceEndDate || undefined}
            data-source-point-count={clevelandPoints.length}
            data-weekend-day-count={cpiCalendarAxis?.weekendDays.length || 0}
          >
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartRows} margin={{ top: 12, right: 122, bottom: 2, left: 0 }}>
                {(cpiCalendarAxis?.weekendDays || []).map((weekend) => (
                  <ReferenceArea
                    key={weekend.date}
                    className="pm-cpi-weekend-band"
                    x1={weekend.startMs}
                    x2={weekend.endMs}
                    fill="var(--pm-cpi-weekend-fill)"
                    fillOpacity={0.62}
                    stroke="none"
                    ifOverflow="hidden"
                    data-testid={`cpi-weekend-${weekend.date}`}
                    data-weekend-date={weekend.date}
                    aria-label={`${weekend.date}: weekend, no Cleveland Fed publication`}
                  />
                ))}
                <CartesianGrid strokeDasharray="2 4" vertical={false} />
                <XAxis
                  type="number"
                  scale="time"
                  dataKey="timestamp"
                  domain={cpiCalendarAxis?.domain || ['dataMin', 'dataMax']}
                  ticks={cpiCalendarAxis?.ticks}
                  interval={0}
                  tickFormatter={(value) => new Date(Number(value)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}
                  tick={{ fontSize: 9 }}
                  axisLine={false}
                  tickLine={false}
                  allowDataOverflow
                />
                <YAxis
                  domain={yDomain}
                  tickFormatter={(value) => `${Number(value).toFixed(1)}%`}
                  tick={{ fontSize: 9 }}
                  axisLine={false}
                  tickLine={false}
                  width={42}
                />
                <Tooltip content={<CpiForecastTooltip />} />
                {scenarios.map((scenario) => (
                  <ReferenceLine
                    key={scenario.key}
                    y={Number(scenario.value)}
                    stroke={`var(--pm-cpi-${scenario.key})`}
                    strokeDasharray="5 4"
                    strokeWidth={1}
                    data-testid={`cpi-hedgeye-${scenario.key}-reference`}
                    label={(props) => (
                      <CpiChartRailLabel
                        viewBox={props.viewBox}
                        value={`${scenario.key.toUpperCase()} ${formatCpiPercent(scenario.value)}`}
                        color={`var(--pm-cpi-${scenario.key})`}
                        verticalOffset={cpiChartLabelOffsets[scenario.key] || 0}
                        testId={`cpi-chart-label-${scenario.key}`}
                      />
                    )}
                  />
                ))}
                {blsAvailable && (
                  <ReferenceLine
                    y={Number(blsFinal.value)}
                    stroke="var(--pm-cpi-bls)"
                    strokeDasharray="2 3"
                    strokeWidth={1}
                    data-testid="cpi-bls-reference"
                    label={(props) => (
                      <CpiChartRailLabel
                        viewBox={props.viewBox}
                        value={`BLS ACTUAL ${formatCpiPercent(blsFinal.value)}`}
                        color="var(--pm-cpi-bls)"
                        verticalOffset={cpiChartLabelOffsets.bls || 0}
                        testId="cpi-chart-label-bls"
                      />
                    )}
                  />
                )}
                <Line
                  type="monotone"
                  dataKey="cleveland"
                  name="Cleveland Fed"
                  stroke="var(--pm-cpi-cleveland)"
                  strokeWidth={1}
                  connectNulls={false}
                  dot={{ r: 2, fill: 'var(--pm-cpi-cleveland)' }}
                  activeDot={{ r: 4 }}
                  data-testid="cpi-cleveland-line"
                  isAnimationActive={false}
                />
                {latestCleveland && (
                  <ReferenceLine
                    y={latestCleveland.cleveland}
                    stroke="transparent"
                    strokeWidth={0}
                    label={(props) => (
                      <CpiChartRailLabel
                        viewBox={props.viewBox}
                        value={`CLEVELAND FED ${formatCpiPercent(latestCleveland.cleveland)}`}
                        color="var(--pm-cpi-cleveland)"
                        verticalOffset={cpiChartLabelOffsets.cleveland || 0}
                        testId="cpi-cleveland-endpoint-label"
                      />
                    )}
                  />
                )}
                {latestCleveland && (
                  <ReferenceDot
                    x={latestCleveland.timestamp}
                    y={latestCleveland.cleveland}
                    r={3}
                    fill="var(--pm-cpi-cleveland)"
                    stroke="var(--pm-surface)"
                    isFront
                  />
                )}
              </LineChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="pm-cpi-comparison-empty" role="status">
            <strong>{waiting ? 'CHECKING VERIFIED CPI SOURCES' : 'CPI COMPARISON UNAVAILABLE'}</strong>
            <span>{comparison?.reason || 'No exact-month forecast comparison is available.'}</span>
          </div>
        )}
      </div>

      <div className="pm-cpi-source-tiles">
        {sourceTiles.map((source) => (
          <div key={source.id} className={`is-${source.status}`} title={source.reason || undefined}>
            <span>{source.label}</span>
            <strong>{source.value}</strong>
            <small>{source.status === 'available' && source.asOf ? `AS OF ${formatAsOf(source.asOf)}` : source.reason || 'UNAVAILABLE'}</small>
          </div>
        ))}
      </div>
    </section>
  );
};

const SpxRiskRangeChart = ({
  snapshot,
  nowMs,
  refreshDelayed,
  marketUi = MARKET_UI.sp500,
  chartRange = '1d',
  onChartRangeChange,
  tradingClock = null,
  checkingHours = false,
  loading = false,
  venueSelection = null,
  spySpot = null,
  cashIndexSpot = null,
  futuresReference = null,
  momoTracker = null,
  momoTrackerSpots = {},
  momoTrackerState = 'loading',
  goldMarketReferences = [],
  goldCorrelationSnapshot = null,
  goldCorrelationState = 'idle',
  goldCorrelationReason = null,
  goldCorrelationResource = null,
  resourceRefreshing = false,
}) => {
  const chartPlotRef = useRef(null);
  const [chartPlotWidth, setChartPlotWidth] = useState(null);
  const rootChart = snapshot?.chart;
  const basisChartReference = snapshot?.chartReferences?.basis || null;
  const contractChartReference = snapshot?.chartReferences?.contract || null;
  const supportsRangeSelection = ['SPX', 'WTI', 'GOLD', 'SILVER', 'BRENT', 'BTC'].includes(marketUi.symbol);
  const selectedRange = supportsRangeSelection && ['1d', '5d', '10d'].includes(chartRange) ? chartRange : '1d';
  const chart = rootChart?.variants?.[selectedRange] || (selectedRange === '1d' ? rootChart : null);
  const contractRootChart = contractChartReference?.chart || null;
  const contractChart = contractRootChart?.variants?.[selectedRange]
    || (selectedRange === '1d' ? contractRootChart : null);
  const riskRange = snapshot?.riskRange;
  const spot = snapshot?.spot;
  const multiDay = selectedRange !== '1d';
  const sp500OneDayLayout = marketUi.symbol === 'SPX' && !multiDay;
  const goldOneDayLayout = marketUi.symbol === 'GOLD' && !multiDay;
  const compactMultiDay = selectedRange === '10d';
  const expectedSessionCount = selectedRange === '10d' ? 10 : selectedRange === '5d' ? 5 : 1;
  useLayoutEffect(() => {
    const plot = chartPlotRef.current;
    if (!multiDay || !plot) return undefined;
    const updateWidth = () => {
      const width = plot.getBoundingClientRect().width - CHART_PLOT_HORIZONTAL_INSET_PX;
      if (!(width > 0)) return;
      setChartPlotWidth((current) => (Math.abs(Number(current) - width) < 0.5 ? current : width));
    };
    updateWidth();
    if (typeof ResizeObserver === 'function') {
      const observer = new ResizeObserver(updateWidth);
      observer.observe(plot);
      return () => observer.disconnect();
    }
    window.addEventListener('resize', updateWidth);
    return () => window.removeEventListener('resize', updateWidth);
  }, [multiDay]);
  const rawPoints = Array.isArray(chart?.points) ? chart.points
    .map((point) => ({
      timestamp: Number(point.timestamp),
      value: Number(point.value),
      ...(point.sessionDate ? { sessionDate: point.sessionDate } : {}),
      ...(finite(point.high) ? { high: Number(point.high) } : {}),
    }))
    .filter((point) => Number.isFinite(point.timestamp) && Number.isFinite(point.value)) : [];
  const rawContractPoints = Array.isArray(contractChart?.points) ? contractChart.points
    .map((point) => ({
      timestamp: Number(point.timestamp),
      value: Number(point.value),
      ...(point.sessionDate ? { sessionDate: point.sessionDate } : {}),
    }))
    .filter((point) => Number.isFinite(point.timestamp) && Number.isFinite(point.value)) : [];
  const multiDayLayout = multiDay
    ? buildMultiDayChartLayout(
        rawPoints,
        chart?.dailyRanges,
        expectedSessionCount,
        chartPlotWidth,
        marketUi.chartCalendar ? {
          calendar: marketUi.chartCalendar,
          closedDayWidthPx: SPX_CLOSED_DAY_WIDTH_PX[expectedSessionCount],
        } : {},
      )
    : null;
  const chartAvailable = isSpxMonitorSectionUsable(chart, nowMs)
    && rawPoints.length >= 2
    && (!multiDay || multiDayLayout.sessions.length === expectedSessionCount);
  const contractChartUsable = isSpxMonitorSectionUsable(contractChart, nowMs)
    && rawContractPoints.length >= 2;
  const chartTerminal = chart?.refreshFailed === true
    || (
      ['unavailable', 'refresh_failed'].includes(String(chart?.status || '').toLowerCase())
      && chart?.refreshing !== true
      && (Boolean(chart?.errorCode) || Boolean(String(chart?.reason || '').trim()))
    );
  const chartIsLoading = !chartAvailable && !chartTerminal && (
    chart?.status === 'refreshing'
    || chart?.refreshing === true
    || chart?.refreshPending === true
    || (loading && !snapshot)
  );
  const chartRefreshActive = Boolean(
    resourceRefreshing
      || snapshot?.refresh?.state === 'refreshing'
      || chart?.refreshing === true
      || chart?.refreshPending === true,
  );
  const retainedChartRefresh = Boolean(chartAvailable && chart?.refreshRetained === true);
  const chartDisplayPhase = !chartAvailable
    ? chartIsLoading ? 'first-load' : 'unavailable'
    : snapshot?.referenceOnly
      ? 'dated-reference'
      : chart?.displayDelayed === true
        ? 'dated-reference'
      : chartRefreshActive
        ? retainedChartRefresh ? 'retained-refresh' : 'refreshing-with-chart'
        : 'ready';
  const latestDailyRange = !multiDay && Array.isArray(chart?.dailyRanges) && chart.dailyRanges.length
    ? chart.dailyRanges[chart.dailyRanges.length - 1]
    : null;
  const variantRange = latestDailyRange
    ? riskRangeValues(latestDailyRange)
    : !multiDay && Array.isArray(chart?.references) && chart.references.length
      ? riskRangeValues({ status: 'available', references: chart.references })
      : null;
  const snapshotRangeAvailable = isSpxMonitorSectionUsable(riskRange, nowMs)
    && finite(riskRange?.lrr) && finite(riskRange?.hrr);
  const latestChartDate = String(
    latestDailyRange?.date
      || chart?.rangeDates?.[chart.rangeDates.length - 1]
      || rawPoints[rawPoints.length - 1]?.sessionDate
      || chartSessionDate(rawPoints[rawPoints.length - 1]?.timestamp)
      || '',
  );
  const snapshotRangeDate = String(riskRange?.date || '').slice(0, 10);
  const snapshotRangeMatchesChart = snapshotRangeAvailable
    && /^\d{4}-\d{2}-\d{2}$/.test(latestChartDate)
    && snapshotRangeDate === latestChartDate;
  const selectedRiskRange = variantRange?.available
    ? { lrr: variantRange.lrr, hrr: variantRange.hrr }
    : snapshotRangeMatchesChart
      ? riskRange
      : null;
  const rangeAvailable = finite(selectedRiskRange?.lrr) && finite(selectedRiskRange?.hrr);
  const spotAvailable = isSpxMonitorSectionUsable(spot, nowMs) && finite(spot?.value);
  const points = chartAvailable ? (multiDay ? multiDayLayout.points : rawPoints) : [];
  const latest = multiDay ? multiDayLayout?.latestPoint : points[points.length - 1] || null;
  const visibleGoldSettlementDates = chartAvailable && marketUi.symbol === 'GOLD'
    ? multiDay
      ? multiDayLayout.sessions.map((session) => session.date)
      : [latestChartDate]
    : [];
  const exactGoldSettlements = resolveVerifiedGoldSettlements(
    snapshot?.resolverTracking || snapshot?.resolverReference?.resolverTracking || null,
    visibleGoldSettlementDates,
  );
  const goldSettlementMarkers = exactGoldSettlements.flatMap((settlement) => {
    if (!multiDay) return [{ ...settlement, x: settlement.timestamp }];
    const session = multiDayLayout.sessions.find((candidate) => candidate.date === settlement.date);
    if (!session) return [];
    const progress = sessionProgress(settlement.timestamp, session.startAt, session.endAt);
    return progress == null ? [] : [{
      ...settlement,
      x: Number(session.startX) + progress,
    }];
  });
  const basisWindowStart = points.find((point) => Number.isFinite(Number(point?.timestamp)))?.timestamp;
  const basisWindowEnd = [...points].reverse().find((point) => Number.isFinite(Number(point?.timestamp)))?.timestamp;
  const contractPoints = chartAvailable && contractChartUsable
    ? multiDay
      ? projectOverlayPointsToSessions(rawContractPoints, multiDayLayout.sessions)
      : rawContractPoints
        .filter((point) => point.timestamp >= Number(basisWindowStart) && point.timestamp <= Number(basisWindowEnd))
        .map((point) => ({ ...point, contractValue: point.value }))
    : [];
  const contractChartPointCount = contractPoints.filter((point) => finite(point?.contractValue)).length;
  const contractChartAvailable = contractChartPointCount >= 2;
  const contractLatest = contractChartAvailable
    ? [...contractPoints].reverse().find((point) => finite(point?.contractValue)) || null
    : null;
  const structureSourceRange = multiDay ? selectedRange : '10d';
  const structureSourceChart = multiDay ? chart : rootChart?.variants?.['10d'];
  const structureExpectedSessionCount = multiDay ? expectedSessionCount : 10;
  const structureSourceVerified = supportsRangeSelection
    && isVerifiedRiskRangeStructureChart(structureSourceChart, nowMs)
    && (!multiDay || chartAvailable);
  const riskRangeStructureScore = structureSourceVerified
    ? calculateRiskRangeStructureScore(
      structureSourceChart?.dailyRanges,
      structureExpectedSessionCount,
    )
    : unavailableRiskRangeStructureScore(
      `Verified ${structureSourceRange.toUpperCase()} Risk Range structure is unavailable.`,
      Array.isArray(structureSourceChart?.dailyRanges) ? structureSourceChart.dailyRanges.length : 0,
    );
  const structureScoreAvailable = riskRangeStructureScore.status === 'available';
  const structureSessionScoresByDate = new Map(
    riskRangeStructureScore.sessions.map((session) => [session.date, session]),
  );
  const structureSummaryLabel = multiDay
    ? `${selectedRange.toUpperCase()} consecutive Risk Range trends`
    : '1D summary from the ending 10D consecutive Risk Range trends';
  const structureScoreTitle = structureScoreAvailable
    ? [
      structureSummaryLabel,
      `high ${formatSignedStructureScore(riskRangeStructureScore.highScore)}`,
      `low ${formatSignedStructureScore(riskRangeStructureScore.lowScore)}`,
      `HH events ${riskRangeStructureScore.counts.HH}`,
      `HL events ${riskRangeStructureScore.counts.HL}`,
      `LH events ${riskRangeStructureScore.counts.LH}`,
      `LL events ${riskRangeStructureScore.counts.LL}`,
      'direction changes restart at +1 or −1',
      `equal endpoints reset to 0 × ${riskRangeStructureScore.counts.EH + riskRangeStructureScore.counts.EL}`,
      'first visible session is the baseline',
    ].join(' · ')
    : riskRangeStructureScore.reason;
  const multiDayRangeValues = multiDay && chartAvailable
    ? multiDayLayout.sessions.flatMap((session) => session.riskRange.available
      ? [session.riskRange.lrr, session.riskRange.hrr]
      : [])
    : [];
  const values = [
    ...points.map((point) => point.value).filter(finite),
    ...contractPoints.map((point) => point.value).filter(finite),
    ...goldSettlementMarkers.map((settlement) => settlement.value).filter(finite),
    ...(multiDay ? multiDayRangeValues : rangeAvailable ? [Number(selectedRiskRange.lrr), Number(selectedRiskRange.hrr)] : []),
  ];
  const minimum = values.length ? Math.min(...values) : 0;
  const maximum = values.length ? Math.max(...values) : 1;
  const padding = Math.max((maximum - minimum) * 0.14, 8);
  const baseMultiDayPriceAxis = multiDay ? buildSpxPriceAxis(values) : null;
  const multiDayPriceAxis = multiDay && marketUi.symbol === 'SPX'
    ? expandSpxPriceAxis(baseMultiDayPriceAxis, 100)
    : baseMultiDayPriceAxis;
  const domain = multiDay ? multiDayPriceAxis.domain : [minimum - padding, maximum + padding];
  const vixClosesByDate = multiDay && marketUi.symbol === 'SPX'
    ? resolveVerifiedVixCloses(chart?.vixCloses, multiDayLayout.sessions.map((session) => session.date))
    : new Map();
  const vixCloseFallbackState = chart?.vixCloses?.status === 'loading' ? 'loading' : 'unavailable';
  const athValue = chartAvailable ? resolveAthReferenceValue(chart?.ath) : null;
  const athDate = chartAvailable ? resolveAthReferenceDate(chart?.ath, athValue) : null;
  const athDateLabel = athDate ? formatAthSessionDate(athDate) : null;
  const athReference = clampChartReferenceValue(athValue, domain);
  const chartLabelOffsets = resolveChartLabelOffsets([
    ...(athReference.value != null ? [{ id: 'ath', value: athReference.value }] : []),
    ...(!multiDay && rangeAvailable ? [
      { id: 'hrr', value: Number(selectedRiskRange.hrr) },
      { id: 'lrr', value: Number(selectedRiskRange.lrr) },
    ] : []),
    ...(contractLatest && finite(contractLatest.value) ? [{ id: 'contract', value: Number(contractLatest.value) }] : []),
    ...(latest && finite(latest.value) ? [{ id: 'latest', value: Number(latest.value) }] : []),
  ], domain);
  const chartLabelCollisionCount = Object.values(chartLabelOffsets)
    .filter((offset) => Math.abs(Number(offset)) > 0.01).length;
  const third = rangeAvailable ? (Number(selectedRiskRange.hrr) - Number(selectedRiskRange.lrr)) / 3 : null;
  const sameFitSpot = spotAvailable && (spot?.fit || 'exact') === (chart?.fit || 'exact');
  const displayedValue = chartAvailable
    ? selectedRange === '1d' && sameFitSpot ? spot.value : (chart.latestValue ?? latest?.value)
    : spotAvailable ? spot.value : null;
  const compactMarketHeader = marketUi.simplified === true;
  const dayChangePreviousClose = spotAvailable && finite(spot?.previousClose)
    ? Number(spot.previousClose)
    : chartAvailable && finite(chart?.previousClose)
      ? Number(chart.previousClose)
      : null;
  const dayChangePercent = compactMarketHeader && finite(displayedValue) && dayChangePreviousClose != null
    ? resolveDayChangePercent(displayedValue, dayChangePreviousClose)
    : null;
  const compactPriceTone = !finite(displayedValue)
    ? 'unavailable'
    : dayChangePercent == null
      ? 'neutral'
      : dayChangePercent > 0 ? 'positive' : dayChangePercent < 0 ? 'negative' : 'neutral';
  const dayChangeTone = dayChangePercent == null
    ? 'unavailable'
    : dayChangePercent > 0 ? 'positive' : dayChangePercent < 0 ? 'negative' : 'neutral';
  const sessionState = String(snapshot?.session?.state || 'closed').toLowerCase();
  const trend = rangeAvailable ? String(riskRange?.trend || '').toUpperCase() : '';
  const headerAsOf = chartAvailable
    ? selectedRange === '1d' && sameFitSpot ? spot.asOf : chart.latestAt
    : spotAvailable ? spot.asOf : null;
  const sectionRefreshDelayed = Boolean(
    refreshDelayed
      || basisChartReference?.freshness?.status === 'delayed'
      || spot?.refreshIssue
      || chart?.refreshIssue
      || riskRange?.refreshIssue
  );
  const dailyAxis = !multiDay && (chart?.interval === '1d'
    || chart?.range === '1mo'
    || (points.length > 1 && points[points.length - 1].timestamp - points[0].timestamp > 2 * 24 * 60 * 60_000));
  const resolverSessionOpenTime = Date.parse(String(chart?.sessionWindow?.startAt || ''));
  const resolverSessionCloseTime = Date.parse(String(chart?.sessionWindow?.endAt || ''));
  const fallbackSessionOpenTime = Date.parse(String(snapshot?.session?.openTime || ''));
  const fallbackSessionCloseTime = Date.parse(String(snapshot?.session?.closeTime || ''));
  const sessionDomain = Number.isFinite(resolverSessionOpenTime) && Number.isFinite(resolverSessionCloseTime)
    ? [resolverSessionOpenTime, resolverSessionCloseTime]
    : Number.isFinite(fallbackSessionOpenTime) && Number.isFinite(fallbackSessionCloseTime)
      ? [fallbackSessionOpenTime, fallbackSessionCloseTime]
    : null;
  const intradayTimeAxis = !multiDay && !dailyAxis && chartAvailable
    ? buildIntradayTimeAxis(points.map((point) => point.timestamp), 8, {
        domain: sessionDomain,
        includeEndpoints: true,
      })
    : null;
  const goldSettlementSchedule = goldOneDayLayout && chartAvailable && !dailyAxis
    ? resolveVerifiedGoldSettlementTime(venueSelection, latestChartDate, nowMs)
    : null;
  const goldSettlementScheduleVisible = goldSettlementSchedule
    && intradayTimeAxis
    && goldSettlementSchedule.timestamp >= intradayTimeAxis.domain[0]
    && goldSettlementSchedule.timestamp <= intradayTimeAxis.domain[1]
    ? goldSettlementSchedule
    : null;
  const referenceMode = chartAvailable && (chart?.status === 'historical' || chart?.availability === 'historical')
    ? 'LAST CLOSE'
    : chartAvailable ? 'CURRENT BAR' : 'UNAVAILABLE';
  const xauSpotProxy = chart?.fit === 'proxy'
    && /\bXAUUSD\b/i.test(`${spot?.label || ''} ${chart?.label || ''}`);
  const referenceBadge = xauSpotProxy ? 'XAUUSD PROXY' : chart && chart?.fit !== 'proxy' ? 'EXACT' : null;
  const referenceBadgeDetails = xauSpotProxy
    ? `Live IBKR XAUUSD spot-gold proxy. ${referenceMode}. This is not the exact Pyth resolver and is not executable.`
    : referenceBadge
      ? `Exact reference. ${referenceMode}. Full provenance is labeled on the blue reference marker.`
      : null;
  const basisSeriesSymbol = basisChartReference?.symbol
    || (snapshot?.chartReferences ? marketUi.symbol : 'SPOT');
  const contractSeriesSymbol = contractChartReference?.symbol
    || contractChartReference?.instrument?.displaySymbol
    || contractChartReference?.spot?.label
    || 'CONTRACT';
  const basisSeriesDelayed = basisChartReference?.freshness?.status === 'delayed';
  const contractSeriesDelayed = contractChartReference?.freshness?.status === 'delayed'
    || contractChartReference?.spot?.status === 'delayed'
    || contractChartReference?.spot?.availability === 'delayed';
  const contractSeriesState = contractChartAvailable
    ? contractSeriesDelayed ? 'delayed' : 'available'
    : contractChart?.status === 'refreshing' || contractChart?.refreshing === true
      ? 'loading'
      : 'unavailable';
  const chartClockHeadline = checkingHours
    ? 'CHECKING MARKET HOURS'
    : String(tradingClock?.headline || '');
  const chartClockSeparator = chartClockHeadline.indexOf(' · ');
  const chartClockStatus = chartClockSeparator >= 0
    ? chartClockHeadline.slice(0, chartClockSeparator)
    : chartClockHeadline;
  const chartClockTiming = chartClockSeparator >= 0
    ? chartClockHeadline.slice(chartClockSeparator + 3)
    : null;

  return (
    <section
      className="pm-spx-chart-panel"
      aria-label={loading && !snapshot
        ? `Loading ${marketUi.symbol} Risk Range chart`
        : `${marketUi.symbol} Risk Range chart`}
    >
      <div className="pm-spx-chart-header">
        {compactMarketHeader && marketUi.symbol === 'SPX' ? (
          <SpxHeaderMarketStrip
            cashSpot={cashIndexSpot}
            spySpot={spySpot}
            futuresReference={futuresReference}
            nowMs={nowMs}
          />
        ) : compactMarketHeader && marketUi.symbol === 'GOLD' ? (
          <GoldHeaderMarketStrip
            references={goldMarketReferences}
            nowMs={nowMs}
          />
        ) : (
          <>
            <span className="pm-spx-chart-symbol">{marketUi.symbol}</span>
            <strong className={compactMarketHeader ? `pm-spx-chart-price is-${compactPriceTone}` : undefined}>
              {formatIndex(displayedValue, marketUi.spotPrecision ?? marketUi.precision ?? 2)}
            </strong>
          </>
        )}
        {compactMarketHeader && !['SPX', 'GOLD'].includes(marketUi.symbol) ? (
          <span
            className={`pm-spx-day-change is-${dayChangeTone}`}
            aria-label={dayChangePercent == null
              ? `${marketUi.symbol} daily change unavailable`
              : `${marketUi.symbol} ${dayChangePercent > 0 ? 'up' : dayChangePercent < 0 ? 'down' : 'unchanged'} ${Math.abs(dayChangePercent).toFixed(2)} percent today`}
          >
            {formatDayChangePercent(dayChangePercent)}
          </span>
        ) : !compactMarketHeader ? (
          <>
            <span className={`pm-spx-session pm-spx-session--${sessionState}`}>{sessionState === 'open' ? 'OPEN' : 'CLOSED'}</span>
            <span className={`pm-spx-trend ${trend ? `pm-spx-trend--${trend.toLowerCase()}` : ''}`}>{trend || '—'}</span>
          </>
        ) : null}
        <SettlementIdentityChips
          venueSelection={venueSelection}
          checking={loading && !venueSelection?.venue}
          nowMs={nowMs}
        />
        {referenceBadge && !['GOLD', 'SPX'].includes(marketUi.symbol) && (
          <span
            className={`pm-spx-reference-badge pm-spx-reference-badge--${xauSpotProxy ? 'proxy' : 'exact'}`}
            aria-label={referenceBadgeDetails}
            title={referenceBadgeDetails}
          >
            {referenceBadge}
          </span>
        )}
        {supportsRangeSelection && (
          <div className="pm-spx-chart-range-tabs" role="tablist" aria-label={`${marketUi.symbol} chart range`}>
            {['1d', '5d', '10d'].map((range) => (
              <button
                key={range}
                type="button"
                role="tab"
                aria-selected={selectedRange === range}
                className={selectedRange === range ? 'is-active' : undefined}
                onClick={() => onChartRangeChange?.(range)}
              >
                {range.toUpperCase()}
              </button>
            ))}
          </div>
        )}
        {marketUi.symbol !== 'SPX' && contractChartReference && contractSeriesState !== 'available' && (
          <span
            className={`pm-spx-contract-series-state is-${contractSeriesState}`}
            data-testid={`spx-${selectedRange}-contract-state`}
            aria-label={`${contractSeriesSymbol} contract reference ${contractSeriesState}`}
            title={contractChartReference.disclosure || contractChartReference?.spot?.reason || undefined}
          >
            {contractSeriesSymbol}
            {contractSeriesState === 'delayed' ? (
              <DelayedDataMarker
                status="delayed"
                title={contractChartReference.disclosure || `${contractSeriesSymbol} delayed contract reference`}
                updatedAt={contractChartReference?.freshness?.asOf
                  || contractChartReference?.spot?.lastVerifiedAt
                  || contractChartReference?.spot?.asOf
                  || contractChartReference?.spot?.timestamp}
              />
            ) : ` ${contractSeriesState === 'loading' ? '…' : '—'}`}
          </span>
        )}
        {supportsRangeSelection && marketUi.symbol !== 'SPX' && (
          <span
            className={`pm-spx-structure-score${structureScoreAvailable ? '' : ' is-unavailable'}`}
            data-testid={`spx-${selectedRange}-rr-structure-summary`}
            data-source-range={structureSourceRange}
            title={structureScoreTitle}
            aria-label={structureScoreAvailable
              ? `${structureSummaryLabel}, high ${structureScoreAriaValue(riskRangeStructureScore.highScore)}, low ${structureScoreAriaValue(riskRangeStructureScore.lowScore)}`
              : `${structureSummaryLabel} unavailable`}
          >
            <span>H</span>
            <strong className={structureScoreAvailable ? `is-${structureScoreToneFor(riskRangeStructureScore.highScore)}` : undefined}>
              {structureScoreAvailable ? formatSignedStructureScore(riskRangeStructureScore.highScore) : '—'}
            </strong>
            <i aria-hidden="true">·</i>
            <span>L</span>
            <strong className={structureScoreAvailable ? `is-${structureScoreToneFor(riskRangeStructureScore.lowScore)}` : undefined}>
              {structureScoreAvailable ? formatSignedStructureScore(riskRangeStructureScore.lowScore) : '—'}
            </strong>
          </span>
        )}
        {chart?.ath && (
          <span className="pm-spx-ath-slot">
            {chart?.ath?.status === 'loading' && <span className="pm-spx-ath-state is-loading">ATH CHECKING</span>}
            {chart?.ath?.status === 'unavailable' && <span className="pm-spx-ath-state is-unavailable">ATH UNAVAILABLE</span>}
          </span>
        )}
        {chartAvailable && chart?.sessionMode === 'last_complete' && (
          <span
            className="pm-spx-last-complete-session"
            title={chart?.sessionDate ? `Verified resolver session ${chart.sessionDate}` : undefined}
          >
            LAST COMPLETE SESSION
          </span>
        )}
        {marketUi.symbol !== 'SPX' && (
          <span
            className="pm-spx-chart-time"
            data-testid={`${marketUi.symbol.toLowerCase()}-chart-as-of`}
          >
            {formatAsOf(headerAsOf, sectionRefreshDelayed)}
          </span>
        )}
        {compactMarketHeader && tradingClock && (
          <div
            className={`pm-spx-contract-clock pm-spx-chart-contract-clock is-${checkingHours ? 'loading' : tradingClock.state}`}
            aria-label="Selected contract trading hours"
            title={checkingHours ? 'Waiting for verified current contract hours.' : tradingClock.title}
          >
            <strong className="pm-spx-contract-clock-status">{chartClockStatus}</strong>
            {chartClockTiming && (
              <span className="pm-spx-contract-clock-timing">{chartClockTiming}</span>
            )}
          </div>
        )}
      </div>
      <div
        className={`pm-spx-chart-canvas${!multiDay ? ' has-proxy-fit' : ''}${sp500OneDayLayout ? ' has-sp500-one-day-layout' : ''}${goldOneDayLayout ? ' has-gold-one-day-layout' : ''}`}
        data-testid="spx-chart-canvas"
        data-chart-range={selectedRange}
        data-session-mode={chart?.sessionMode || undefined}
        data-session-date={chart?.sessionDate || undefined}
        data-basis-series-symbol={basisSeriesSymbol}
        data-basis-series-status={basisSeriesDelayed ? 'delayed' : chartAvailable ? 'available' : 'unavailable'}
        data-basis-series-point-count={chartAvailable ? points.length : 0}
        data-chart-point-count={chartAvailable ? points.length : 0}
        data-chart-display-phase={chartDisplayPhase}
        data-chart-refresh-status={chartRefreshActive ? 'refreshing' : 'idle'}
        data-chart-retained-refresh={retainedChartRefresh ? 'true' : 'false'}
        data-contract-series-symbol={contractSeriesSymbol}
        data-contract-series-status={contractSeriesState}
        data-contract-series-point-count={contractChartAvailable ? contractChartPointCount : 0}
        data-gold-settlement-count={marketUi.symbol === 'GOLD' ? goldSettlementMarkers.length : undefined}
        data-gold-settlement-source={goldSettlementMarkers.length ? GOLD_SETTLEMENT_SOURCE : undefined}
        data-session-count={multiDay && chartAvailable ? multiDayLayout.sessions.length : undefined}
        data-rr-overlay-count={chartAvailable
          ? multiDay
            ? multiDayLayout.sessions.filter((session) => session.riskRange.available).length
            : rangeAvailable ? 1 : 0
          : undefined}
        data-ath-reference-value={athValue ?? undefined}
        data-ath-reference-date={athDate || undefined}
        data-ath-reference-clamp={athReference.edge || undefined}
        data-vix-close-count={multiDay && marketUi.symbol === 'SPX' ? vixClosesByDate.size : undefined}
        data-price-domain-min={chartAvailable ? domain[0] : undefined}
        data-price-domain-max={chartAvailable ? domain[1] : undefined}
        data-label-collision-count={chartLabelCollisionCount}
        data-risk-range-structure-score={structureScoreAvailable ? riskRangeStructureScore.score : undefined}
        data-risk-range-high-structure-score={structureScoreAvailable ? riskRangeStructureScore.highScore : undefined}
        data-risk-range-low-structure-score={structureScoreAvailable ? riskRangeStructureScore.lowScore : undefined}
        data-risk-range-structure-source={structureScoreAvailable ? structureSourceRange : undefined}
        data-time-tick-count={intradayTimeAxis?.ticks.length || undefined}
        data-time-tick-step-minutes={intradayTimeAxis?.step ? intradayTimeAxis.step / 60_000 : undefined}
        data-session-open-time={intradayTimeAxis?.hasSessionEndpoints
          ? chart?.sessionWindow?.startAt || snapshot?.session?.openTime
          : undefined}
        data-session-close-time={intradayTimeAxis?.hasSessionEndpoints
          ? chart?.sessionWindow?.endAt || snapshot?.session?.closeTime
          : undefined}
      >
        {!['GOLD', 'SPX'].includes(marketUi.symbol) && chartAvailable && chartRefreshActive && (
          <LoadingIndicator
            label="Refreshing"
            size="sm"
            className="pm-spx-chart-refresh-indicator"
          />
        )}
        {!multiDay && (
          marketUi.symbol === 'GOLD'
            ? <PythTrackingPanel tracking={snapshot?.resolverTracking || snapshot?.resolverReference?.resolverTracking || null} />
            : <ProxyFitPanel
                comparison={snapshot?.proxyFit || snapshot?.resolverReference?.proxyFit || null}
                marketUi={marketUi}
              />
        )}
        {chartAvailable ? (
          <div className={`pm-spx-chart-frame ${multiDay ? compactMultiDay ? 'is-ten-day' : 'is-five-day' : 'is-one-day'}`}>
            <div className="pm-spx-chart-plot" ref={chartPlotRef}>
              <ResponsiveContainer
                width="100%"
                height="100%"
                initialDimension={multiDay
                  ? INITIAL_MULTI_DAY_CHART_DIMENSION
                  : INITIAL_ONE_DAY_CHART_DIMENSION}
              >
                <LineChart data={points} margin={{ top: multiDay ? 22 : 12, right: 144, left: 2, bottom: multiDay ? 0 : 2 }}>
                  <defs>
                    <pattern
                      id={WEEKEND_SEPARATOR_PATTERN_ID}
                      width="6"
                      height="6"
                      patternUnits="userSpaceOnUse"
                    >
                      <rect className="pm-spx-weekend-pattern-base" width="6" height="6" />
                      <path
                        className="pm-spx-weekend-pattern-stripe"
                        d="M-1 1 L1 -1 M0 6 L6 0 M5 7 L7 5"
                        fill="none"
                        strokeWidth="1.5"
                      />
                    </pattern>
                    {Object.entries(CLOSED_DAY_PATTERN_IDS).map(([type, patternId]) => (
                      <pattern
                        key={patternId}
                        id={patternId}
                        width="7"
                        height="7"
                        patternUnits="userSpaceOnUse"
                      >
                        <rect className={`pm-spx-market-closed-pattern-base is-${type}`} width="7" height="7" />
                        <path
                          className={`pm-spx-market-closed-pattern-stripe is-${type}`}
                          d="M-1 1 L1 -1 M0 7 L7 0 M6 8 L8 6"
                          fill="none"
                          strokeWidth="1.4"
                        />
                      </pattern>
                    ))}
                  </defs>
              {!multiDay && rangeAvailable && (
                <>
                  <ReferenceArea y1={Number(selectedRiskRange.lrr)} y2={Number(selectedRiskRange.lrr) + third} fill="#fee2e2" fillOpacity={0.68} stroke="none" />
                  <ReferenceArea y1={Number(selectedRiskRange.hrr) - third} y2={Number(selectedRiskRange.hrr)} fill="#dcfce7" fillOpacity={0.72} stroke="none" />
                </>
              )}
              {!multiDay && (chart?.sessionWindow?.closedIntervals || []).map((interval, index) => (
                <ReferenceArea
                  key={`resolver-closed-${interval.startAt}-${index}`}
                  x1={Date.parse(interval.startAt)}
                  x2={Date.parse(interval.endAt)}
                  fill="#cbd5e1"
                  fillOpacity={0.45}
                  stroke="none"
                  ifOverflow="hidden"
                  data-testid={`resolver-closed-interval-${index}`}
                />
              ))}
              {multiDay && multiDayLayout.sessions.map((session) => session.riskRange.available && (
                <React.Fragment key={`areas-${session.date}`}>
                  <ReferenceArea
                    x1={session.startX}
                    x2={session.endX}
                    y1={session.riskRange.lrr}
                    y2={session.riskRange.lrr + ((session.riskRange.hrr - session.riskRange.lrr) / 3)}
                    fill="#fee2e2"
                    fillOpacity={0.68}
                    stroke="none"
                  />
                  <ReferenceArea
                    x1={session.startX}
                    x2={session.endX}
                    y1={session.riskRange.hrr - ((session.riskRange.hrr - session.riskRange.lrr) / 3)}
                    y2={session.riskRange.hrr}
                    fill="#dcfce7"
                    fillOpacity={0.72}
                    stroke="none"
                  />
                </React.Fragment>
              ))}
              <CartesianGrid vertical={false} stroke="#dbe4ef" strokeDasharray="3 5" />
              {multiDay ? (
                <XAxis
                  type="number"
                  dataKey="plotX"
                  domain={[0, multiDayLayout.maxX]}
                  ticks={multiDayLayout.sessions.map((session) => session.tickX)}
                  axisLine={false}
                  tickLine={false}
                  tick={false}
                  height={1}
                  allowDataOverflow
                />
              ) : dailyAxis ? (
                <XAxis
                  dataKey="timestamp"
                  axisLine={false}
                  tickLine={false}
                  minTickGap={54}
                  tick={{ fill: '#64748b', fontSize: 10 }}
                  tickFormatter={(value) => new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                />
              ) : (
                <XAxis
                  type="number"
                  scale="time"
                  dataKey="timestamp"
                  domain={intradayTimeAxis.domain}
                  ticks={intradayTimeAxis.ticks}
                  interval={0}
                  axisLine={false}
                  tickLine={false}
                  minTickGap={54}
                  tick={{ fill: '#64748b', fontSize: 10 }}
                  tickFormatter={(value) => {
                    const time = formatIntradayTimeTick(value, intradayTimeAxis.step);
                    if (!intradayTimeAxis.hasSessionEndpoints) return time;
                    if (Number(value) === intradayTimeAxis.domain[0]) return `OPEN ${time}`;
                    if (Number(value) === intradayTimeAxis.domain[1]) return `CLOSE ${time}`;
                    return time;
                  }}
                  allowDataOverflow
                />
              )}
              <YAxis
                domain={domain}
                ticks={multiDay ? multiDayPriceAxis.ticks : undefined}
                interval={multiDay ? 0 : undefined}
                width={58}
                axisLine={false}
                tickLine={false}
                tick={{ fill: '#64748b', fontSize: 10 }}
                tickFormatter={(value) => Number(value).toLocaleString('en-US', {
                  maximumFractionDigits: marketUi.precision ?? 2,
                })}
              />
              <Tooltip content={<ChartTooltip
                multiDay={multiDay}
                dailyRanges={chart?.dailyRanges || []}
                ath={chart?.ath}
                basisSymbol={basisSeriesSymbol}
                contractSymbol={contractSeriesSymbol}
                contractPoints={contractPoints}
              />} />
              {!multiDay && rangeAvailable && (
                <>
                  <ReferenceLine
                    y={Number(selectedRiskRange.lrr)}
                    stroke="#dc2626"
                    strokeDasharray="6 6"
                    label={(props) => (
                      <RightEdgeReferenceLabel
                        viewBox={props.viewBox}
                        value={`LRR ${formatIndex(selectedRiskRange.lrr, marketUi.precision ?? 2)}`}
                        color="#dc2626"
                        verticalOffset={chartLabelOffsets.lrr}
                        testId={`spx-${selectedRange}-lrr-reference`}
                      />
                    )}
                  />
                  <ReferenceLine
                    y={Number(selectedRiskRange.hrr)}
                    stroke="#059669"
                    strokeDasharray="6 6"
                    label={(props) => (
                      <RightEdgeReferenceLabel
                        viewBox={props.viewBox}
                        value={`HRR ${formatIndex(selectedRiskRange.hrr, marketUi.precision ?? 2)}`}
                        color="#059669"
                        verticalOffset={chartLabelOffsets.hrr}
                        testId={`spx-${selectedRange}-hrr-reference`}
                      />
                    )}
                  />
                </>
              )}
              {multiDay && multiDayLayout.gaps.map((gap) => (
                gap.calendarAware ? (
                  <React.Fragment key={`gap-${gap.previousDate}-${gap.date}`}>
                    {gap.closedDays.map((closure) => {
                      const accessibleLabel = closure.type === 'holiday'
                        ? `${closure.date}: market closed holiday — ${closure.holidayName}`
                        : `${closure.date}: market closed weekend`;
                      return (
                        <ReferenceArea
                          key={`closed-${closure.date}`}
                          className={`pm-spx-market-closed-band is-${closure.type}`}
                          x1={closure.bandStartX}
                          x2={closure.bandEndX}
                          fill={`url(#${CLOSED_DAY_PATTERN_IDS[closure.type]})`}
                          stroke="none"
                          data-testid={`spx-${selectedRange}-market-closed-${closure.date}`}
                          data-closure-date={closure.date}
                          data-closure-type={closure.type}
                          data-holiday-name={closure.holidayName || undefined}
                          aria-label={accessibleLabel}
                          label={(props) => (
                            <MarketClosedBandLabel
                              viewBox={props.viewBox}
                              closure={closure}
                              testId={`spx-${selectedRange}-market-closed-label-${closure.date}`}
                            />
                          )}
                        />
                      );
                    })}
                    {gap.segments.filter((segment) => segment.type === 'neutral').map((segment, segmentIndex) => (
                      <ReferenceLine
                        key={`neutral-${gap.previousDate}-${gap.date}-${segment.date || segmentIndex}`}
                        x={segment.x}
                        stroke="#94a3b8"
                        strokeWidth={1}
                      />
                    ))}
                  </React.Fragment>
                ) : gap.isWeekend ? (
                  <ReferenceArea
                    key={`gap-${gap.date}`}
                    className="pm-spx-weekend-separator"
                    x1={gap.separatorStartX}
                    x2={gap.separatorEndX}
                    fill={`url(#${WEEKEND_SEPARATOR_PATTERN_ID})`}
                    stroke="none"
                    data-testid={`spx-${selectedRange}-weekend-separator-${gap.date}`}
                    data-previous-session={gap.previousDate}
                    aria-label={`Weekend between ${gap.previousDate} and ${gap.date}`}
                  />
                ) : (
                  <ReferenceLine key={`gap-${gap.date}`} x={gap.x} stroke="#94a3b8" strokeWidth={1} />
                )
              ))}
              {multiDay && multiDayLayout.sessions.map((session) => session.riskRange.available && (
                <React.Fragment key={`ranges-${session.date}`}>
                  <ReferenceLine
                    segment={[{ x: session.startX, y: session.riskRange.lrr }, { x: session.endX, y: session.riskRange.lrr }]}
                    stroke="#dc2626"
                    strokeDasharray="6 5"
                  />
                  <ReferenceLine
                    segment={[{ x: session.startX, y: session.riskRange.hrr }, { x: session.endX, y: session.riskRange.hrr }]}
                    stroke="#059669"
                    strokeDasharray="6 5"
                  />
                </React.Fragment>
              ))}
              {athReference.value != null && (
                <ReferenceLine
                  y={athReference.value}
                  className="pm-spx-ath-reference-line"
                  stroke="#2563eb"
                  strokeWidth={1.25}
                  strokeDasharray="2 4"
                  strokeLinecap="round"
                  ifOverflow="visible"
                  data-testid={`spx-${selectedRange}-ath-line`}
                  data-clamp-edge={athReference.edge || undefined}
                  label={(props) => (
                    <AthReferenceLabel
                      viewBox={props.viewBox}
                      value={`ATH ${formatIndex(athValue, marketUi.precision ?? 2)}${athDateLabel ? ` (${athDateLabel})` : ''}`}
                      clampEdge={athReference.edge}
                      verticalOffset={chartLabelOffsets.ath}
                      testId={`spx-${selectedRange}-ath-reference`}
                    />
                  )}
                />
              )}
              {goldSettlementScheduleVisible && goldSettlementMarkers.length === 0 && (
                <ReferenceLine
                  x={goldSettlementScheduleVisible.timestamp}
                  className="pm-gold-settlement-time-line"
                  stroke="#7c3aed"
                  strokeWidth={1}
                  strokeDasharray="3 4"
                  ifOverflow="visible"
                  data-testid="spx-1d-settlement-time-line"
                  label={(props) => (
                    <GoldSettlementTimeLabel
                      viewBox={props.viewBox}
                      settlement={goldSettlementScheduleVisible}
                      testId="spx-1d-settlement-time"
                    />
                  )}
                />
              )}
              <Line
                type="linear"
                dataKey="value"
                stroke="#111827"
                strokeWidth={1.75}
                dot={false}
                activeDot={{ r: 3 }}
                connectNulls={false}
                isAnimationActive={false}
                data-testid={`spx-${selectedRange}-price-line`}
              />
              {contractChartAvailable && (
                <Line
                  type="linear"
                  data={contractPoints}
                  dataKey="contractValue"
                  stroke="#2563eb"
                  strokeWidth={1}
                  dot={false}
                  activeDot={{ r: 2.5 }}
                  connectNulls={false}
                  isAnimationActive={false}
                  data-testid={`spx-${selectedRange}-contract-line`}
                />
              )}
              {goldSettlementMarkers.map((settlement) => (
                <ReferenceDot
                  key={`gold-settlement-${settlement.date}`}
                  x={settlement.x}
                  y={settlement.value}
                  r={3.5}
                  fill="#7c3aed"
                  stroke="#ffffff"
                  strokeWidth={1.25}
                  ifOverflow="visible"
                  isFront
                  data-testid={`spx-${selectedRange}-settlement-dot-${settlement.date}`}
                  label={(props) => (
                    <GoldSettlementMarkerLabel
                      viewBox={props.viewBox}
                      settlement={settlement}
                      compact={compactMultiDay}
                      testId={`spx-${selectedRange}-settlement-${settlement.date}`}
                    />
                  )}
                />
              ))}
              {multiDay && marketUi.symbol === 'SPX' && multiDayLayout.sessions.map((session) => {
                const vixClose = vixClosesByDate.get(session.date);
                const state = finite(vixClose) ? 'available' : vixCloseFallbackState;
                return (
                  <ReferenceDot
                    key={`vix-close-${session.date}`}
                    x={session.tickX}
                    y={domain[1]}
                    r={0}
                    fill="transparent"
                    stroke="none"
                    ifOverflow="visible"
                    isFront
                    label={(props) => (
                      <VixCloseLabel
                        viewBox={props.viewBox}
                        value={vixClose}
                        date={session.date}
                        state={state}
                        compact={compactMultiDay}
                        testId={`spx-${selectedRange}-vix-close-${session.date}`}
                      />
                    )}
                  />
                );
              })}
              {multiDay && structureScoreAvailable && multiDayLayout.sessions.map((session) => {
                const sessionScore = structureSessionScoresByDate.get(session.date);
                if (!session.riskRange.available || !sessionScore) return null;
                return (
                  <React.Fragment key={`structure-counters-${session.date}`}>
                    <ReferenceDot
                      x={session.tickX}
                      y={session.riskRange.hrr}
                      r={0}
                      fill="transparent"
                      stroke="none"
                      isFront
                      label={(props) => (
                        <RiskRangeStructureCounterLabel
                          viewBox={props.viewBox}
                          score={sessionScore.highScore}
                          leg="high"
                          event={sessionScore.highEvent}
                          date={session.date}
                          testId={`spx-${selectedRange}-high-structure-${session.date}`}
                          boundaryOffset={compactMultiDay ? 4 : 24}
                        />
                      )}
                    />
                    <ReferenceDot
                      x={session.tickX}
                      y={session.riskRange.lrr}
                      r={0}
                      fill="transparent"
                      stroke="none"
                      isFront
                      label={(props) => (
                        <RiskRangeStructureCounterLabel
                          viewBox={props.viewBox}
                          score={sessionScore.lowScore}
                          leg="low"
                          event={sessionScore.lowEvent}
                          date={session.date}
                          testId={`spx-${selectedRange}-low-structure-${session.date}`}
                          boundaryOffset={compactMultiDay ? 4 : 24}
                        />
                      )}
                    />
                  </React.Fragment>
                );
              })}
              {multiDay && !compactMultiDay && multiDayLayout.sessions.map((session) => (
                session.riskRange.available ? (
                  <React.Fragment key={`range-labels-${session.date}`}>
                    <ReferenceDot
                      x={session.tickX}
                      y={session.riskRange.hrr}
                      r={0}
                      fill="transparent"
                      stroke="none"
                      isFront
                      label={(props) => (
                        <RiskRangeChartLabel
                          viewBox={props.viewBox}
                          value={`HRR ${formatIndex(session.riskRange.hrr, Number.isInteger(session.riskRange.hrr) ? 0 : 2)}${session.range?.structure?.status === 'available' ? ` · ${session.range.structure.highEvent}` : ''}`}
                          tone="high"
                          placement="above"
                          testId={`spx-${selectedRange}-hrr-${session.date}`}
                        />
                      )}
                    />
                    <ReferenceDot
                      x={session.tickX}
                      y={session.riskRange.lrr}
                      r={0}
                      fill="transparent"
                      stroke="none"
                      isFront
                      label={(props) => (
                        <RiskRangeChartLabel
                          viewBox={props.viewBox}
                          value={`LRR ${formatIndex(session.riskRange.lrr, Number.isInteger(session.riskRange.lrr) ? 0 : 2)}${session.range?.structure?.status === 'available' ? ` · ${session.range.structure.lowEvent}` : ''}`}
                          tone="low"
                          placement="below"
                          testId={`spx-${selectedRange}-lrr-${session.date}`}
                        />
                      )}
                    />
                  </React.Fragment>
                ) : (
                  <ReferenceDot
                    key={`range-unavailable-${session.date}`}
                    x={session.tickX}
                    y={multiDayPriceAxis.domain[1]}
                    r={0}
                    fill="transparent"
                    stroke="none"
                    isFront
                    label={(props) => (
                      <RiskRangeChartLabel
                        viewBox={props.viewBox}
                        value="RR unavailable"
                        tone="unavailable"
                        placement="below"
                        testId={`spx-${selectedRange}-rr-unavailable-${session.date}`}
                      />
                    )}
                  />
                )
              ))}
              {latest && (
                <ReferenceDot
                  x={multiDay ? latest.plotX : latest.timestamp}
                  y={latest.value}
                  r={0}
                  fill="transparent"
                  stroke="none"
                  isFront
                  label={(props) => (
                    <ChartEndpointLabel
                      viewBox={props.viewBox}
                      value={`${basisSeriesSymbol} ${formatIndex(latest.value, marketUi.precision ?? 2)}`}
                      fontWeight={marketUi.symbol === 'GOLD' ? 400 : 800}
                      verticalOffset={chartLabelOffsets.latest}
                      testId={`spx-${selectedRange}-latest-reference`}
                    />
                  )}
                />
              )}
              {contractChartAvailable && contractLatest && (
                <ReferenceDot
                  x={multiDay ? contractLatest.plotX : contractLatest.timestamp}
                  y={contractLatest.value}
                  r={0}
                  fill="transparent"
                  stroke="none"
                  isFront
                  label={(props) => (
                    <ChartEndpointLabel
                      viewBox={props.viewBox}
                      value={`${contractSeriesSymbol} ${formatIndex(contractLatest.value, marketUi.precision ?? 2)}${contractSeriesDelayed ? ' · D' : ''}`}
                      color="#2563eb"
                      fontWeight={marketUi.symbol === 'GOLD' ? 400 : 800}
                      verticalOffset={chartLabelOffsets.contract}
                      testId={`spx-${selectedRange}-contract-reference`}
                    />
                  )}
                />
              )}
                </LineChart>
              </ResponsiveContainer>
            </div>
            {multiDay && (
              <div
                className={`pm-spx-five-day-axis ${compactMultiDay ? 'is-ten-day' : ''}`}
                aria-label={`${expectedSessionCount} ${marketUi.symbol} session dates${multiDayLayout.closedDays.length ? ' and closed calendar dates' : ''}${compactMultiDay ? '' : ' and market-hour ticks'}`}
                style={{
                  gridTemplateColumns: multiDayLayout.axisGridTemplate,
                }}
              >
                {multiDayLayout.sessions.map((session, index) => (
                  <React.Fragment key={`axis-${session.date}`}>
                    {index > 0 && (multiDayLayout.gaps[index - 1].calendarAware
                      ? multiDayLayout.gaps[index - 1].segments.map((segment, segmentIndex) => (
                          segment.type === 'closed' ? (
                            <span
                              key={`closed-date-${segment.date}`}
                              className={`pm-spx-axis-closed-day is-${segment.closure.type}`}
                              data-testid={`spx-${selectedRange}-closed-date-${segment.date}`}
                              aria-label={segment.closure.type === 'holiday'
                                ? `${segment.date}: market closed holiday — ${segment.closure.holidayName}`
                                : `${segment.date}: market closed weekend`}
                              title={segment.closure.type === 'holiday' ? segment.closure.holidayName : undefined}
                            >
                              <strong>{compactMultiDay
                                ? formatShortSessionDate(segment.date)
                                : `${formatSessionLabel(segment.date).weekday} · ${formatSessionLabel(segment.date).date}`}</strong>
                            </span>
                          ) : (
                            <span
                              key={`axis-gap-${segment.date || segmentIndex}`}
                              className="pm-spx-axis-gap"
                              aria-hidden="true"
                            />
                          )
                        ))
                      : (
                          <span
                            className={`pm-spx-axis-gap${multiDayLayout.gaps[index - 1].isWeekend ? ' is-weekend' : ''}`}
                            aria-hidden="true"
                          />
                        ))}
                    <div
                      data-testid={`spx-${selectedRange}-session-${session.date}`}
                      aria-label={`${session.label.weekday} ${session.label.date}`}
                    >
                      {!compactMultiDay && (
                        <span className="pm-spx-five-day-time-ticks" aria-label="Actual New York session times">
                          <i className="is-first" style={{ left: '0%' }}>{formatSessionTime(session.startAt)}</i>
                          <i className="is-last" style={{ left: '100%' }}>{formatSessionTime(session.endAt)}</i>
                        </span>
                      )}
                      <strong>{compactMultiDay ? formatShortSessionDate(session.date) : `${session.label.weekday} · ${session.label.date}`}</strong>
                    </div>
                  </React.Fragment>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div
            className={`pm-spx-inline-empty${chartIsLoading ? ' is-loading' : ''}`}
            role="status"
            aria-live="polite"
          >
            {chartIsLoading
              ? `LOADING VERIFIED ${marketUi.symbol} ${selectedRange.toUpperCase()} PRICE HISTORY…`
              : `${marketUi.symbol} ${selectedRange.toUpperCase()} DATA UNAVAILABLE`}
          </div>
        )}
        {sp500OneDayLayout && (
          <MomoTrackerPanel
            snapshot={momoTracker}
            spots={momoTrackerSpots}
            state={momoTrackerState}
            nowMs={nowMs}
          />
        )}
        {goldOneDayLayout && (
          <GoldCorrelationPanel
            snapshot={goldCorrelationSnapshot}
            state={goldCorrelationState}
            reason={goldCorrelationReason}
          />
        )}
      </div>
    </section>
  );
};

const factorToken = (value) => String(value || '').trim().replaceAll('_', ' ').toUpperCase();

const factorDirectionTone = (value) => {
  const token = factorToken(value);
  if (['BULL', 'BULLISH', 'BUY', 'LONG', 'POSITIVE', 'RISK ON', 'INVESTABLE', 'PASS'].includes(token)) {
    return 'positive';
  }
  if (['BEAR', 'BEARISH', 'SELL', 'SHORT', 'NEGATIVE', 'RISK OFF', 'UNINVESTABLE', 'BLOCKED'].includes(token)) {
    return 'negative';
  }
  if (token === 'CHOP') return 'caution';
  return token ? 'neutral' : null;
};

const factorSignTone = (value) => {
  if (!finite(value)) return null;
  const number = Number(value);
  return number > 0 ? 'positive' : number < 0 ? 'negative' : 'neutral';
};

const factorCorrelationTone = (value) => {
  if (!finite(value)) return null;
  const displayed = Number(Number(value).toFixed(2));
  if (Math.abs(displayed) <= 0.5) return 'neutral';
  return displayed > 0 ? 'positive' : 'negative';
};

const factorRelativeTone = (value, baseline = 1) => {
  if (!finite(value)) return null;
  const number = Number(value);
  return number > baseline ? 'positive' : number < baseline ? 'negative' : 'neutral';
};

const factorVolatilityTone = (series, value) => ({
  green: 'positive',
  yellow: 'caution',
  red: 'negative',
}[getBucketForSeries(series, value)] || null);

const factorScoreTone = (value) => {
  if (!finite(value)) return null;
  return Number(value) > 0 ? 'positive' : 'neutral';
};

const FactorToken = ({ value, tone }) => {
  const resolvedTone = tone ?? (value === '—' ? 'unavailable' : factorDirectionTone(value));
  return (
    <span className={`pm-spx-factor-token${resolvedTone ? ` is-${resolvedTone}` : ''}`}>{value}</span>
  );
};

const CompoundFactorValue = ({ values, separator }) => (
  <span className="pm-spx-factor-compound">
    {values.map(({ key, value, tone }, index) => (
      <React.Fragment key={key}>
        {index > 0 ? <span className="pm-spx-factor-separator">{separator}</span> : null}
        <FactorToken value={value} tone={tone} />
      </React.Fragment>
    ))}
  </span>
);

const genericFactorValuePresentation = (row, displayValue) => {
  const id = factorToken(row?.id);
  const label = factorToken(row?.label);
  if (id === 'GATE') {
    const directions = String(displayValue || '— / —').split('/').map((value) => factorToken(value) || '—');
    return {
      value: (
        <CompoundFactorValue
          separator=" / "
          values={directions.map((value, index) => ({
            key: `direction-${index}`,
            value,
            tone: value === '—' ? 'unavailable' : factorDirectionTone(value),
          }))}
        />
      ),
      tone: null,
    };
  }
  if (id === 'CFTC') {
    const zScores = String(displayValue || '— / —').split('/').map((value) => String(value || '').trim() || '—');
    return {
      value: (
        <CompoundFactorValue
          separator=" / "
          values={zScores.map((value, index) => ({
            key: `z-score-${index}`,
            value,
            tone: value === '—' ? 'unavailable' : factorSignTone(value),
          }))}
        />
      ),
      tone: null,
    };
  }
  if (id === 'USD' || label.includes('CORRELATION')) {
    return { value: displayValue, tone: factorCorrelationTone(row?.value) };
  }
  if (['VIX', 'VVIX', 'NAZVOL', 'RVX', 'GVZ', 'OVX', 'MOVE', 'BITVX'].includes(id)) {
    return { value: displayValue, tone: factorVolatilityTone(id, row?.value) };
  }
  const directionalTone = factorDirectionTone(row?.value ?? displayValue);
  return {
    value: displayValue,
    tone: ['positive', 'negative', 'caution'].includes(directionalTone) ? directionalTone : null,
  };
};

const FactorRow = ({
  label,
  value,
  valueTone,
  maximum,
  points,
  pointsTone,
  source,
  detail,
  asOf,
  available,
  partial = false,
  refreshDelayed,
  referenceStatus = 'live',
  unavailableValue = '—',
  unavailableAsOf = null,
}) => {
  const availability = available ? (partial ? 'partial' : 'available') : 'unavailable';
  const title = [source, detail].filter(Boolean).join(' · ') || undefined;
  return (
    <tr
      className={!available ? 'is-unavailable' : partial ? 'is-partial' : undefined}
      data-availability={availability}
      title={title}
    >
      <th scope="row">{label}</th>
      <td
        className={`pm-spx-factor-value${valueTone ? ` is-${valueTone}` : ''}`}
        data-tone={valueTone || undefined}
      >
        {available ? (
          <>
            {value}
            <DelayedDataMarker
              status={refreshDelayed ? 'refresh-delayed' : referenceStatus}
              title={refreshDelayed
                ? `Refresh delayed · last verified ${asOf || 'time unavailable'}`
                : `Historical reference · as of ${asOf || 'time unavailable'}`}
              updatedAt={asOf}
            />
          </>
        ) : unavailableValue}
      </td>
      <td>{maximum}</td>
      <td className={`pm-spx-factor-points${pointsTone ? ` is-${pointsTone}` : ''}`}>
        {available ? points : '—'}
      </td>
      <td>{available
        ? formatAsOf(asOf)
        : refreshDelayed
          ? 'REFRESH DELAYED'
          : unavailableAsOf ? formatAsOf(unavailableAsOf) : '—'}</td>
    </tr>
  );
};

const GenericFactorMonitor = ({ snapshot, refreshDelayed, marketUi }) => {
  const rows = Array.isArray(snapshot?.factorRows) ? snapshot.factorRows : [];
  const venueId = snapshot?.selectedVenueId || snapshot?.selection?.venueId || snapshot?.displaySelection?.venueId || 'auto';
  const venueLabel = snapshot?.venues?.[venueId]?.label || (venueId === 'auto' ? 'AUTO' : venueId);
  const eventTicker = snapshot?.contracts?.event?.ticker || snapshot?.selectedGenerationId || null;
  const accessibleMetadata = [venueLabel, eventTicker, 'CURRENT'].filter(Boolean).join(' · ').toUpperCase();
  return (
    <section
      className="pm-spx-factor-panel"
      aria-label={`${marketUi.fullLabel} factor monitor · ${accessibleMetadata}`}
      data-selected-venue={venueId}
      data-event-ticker={eventTicker || undefined}
    >
      <table className="pm-spx-factor-table">
        <thead>
          <tr><th>FACTOR</th><th>VALUE</th><th>MAX PTS</th><th>POINTS</th><th>AS OF</th></tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const gate = row.role === 'gate';
            const displayState = factorToken(row.displayState || row.state || (gate ? 'WAIT' : ''));
            const available = gate || ['available', 'historical', 'proxy'].includes(row.status);
            const displayValue = row.displayValue ?? (finite(row.value) ? formatFactorNumber(row.value) : row.value);
            const valuePresentation = genericFactorValuePresentation(row, displayValue || '—');
            const pointsTone = displayState === 'CONTEXT ALIGNED'
              ? 'positive'
              : displayState === 'CONFLICT' ? 'negative' : displayState === 'WAIT' ? 'caution' : null;
            return (
              <FactorRow
                key={row.id || row.label}
                label={row.label}
                value={valuePresentation.value}
                valueTone={valuePresentation.tone}
                maximum={gate ? 'GATE' : 'CTX'}
                points={gate ? displayState || 'WAIT' : '—'}
                pointsTone={pointsTone}
                source={[
                  row.status === 'historical' ? 'LAST COMPLETED SESSION' : null,
                  row.source,
                  row.fit ? `FIT ${String(row.fit).toUpperCase()}` : null,
                  row.note,
                ].filter(Boolean).join(' · ')}
                asOf={row.asOf}
                available={available}
                refreshDelayed={refreshDelayed || row.refreshDelayed}
                referenceStatus={row.status}
              />
            );
          })}
          {!rows.length && (
            <tr className="is-unavailable"><td colSpan="5">NO VERIFIED CURRENT FACTORS</td></tr>
          )}
        </tbody>
      </table>
    </section>
  );
};

const CpiSourceMonitor = ({ snapshot, refreshDelayed, nowMs = Date.now() }) => {
  const comparison = snapshot?.forecastComparison || null;
  const reportMonth = comparison?.reportMonth || null;
  const releaseAtMs = Date.parse(comparison?.releaseAt || '');
  const currentRelease = Number.isFinite(releaseAtMs) && releaseAtMs > nowMs;
  const hedgeye = comparison?.hedgeye;
  const rows = [
    ...(Array.isArray(hedgeye?.scenarios) ? hedgeye.scenarios : []).map((scenario) => ({
      id: `hedgeye-${scenario.key}`,
      source: 'HEDGEYE',
      value: scenario.value,
      role: String(scenario.label || scenario.key || 'Scenario').toUpperCase(),
      period: reportMonth,
      asOf: hedgeye.asOf,
      status: hedgeye.status,
      exact: hedgeye.reportMonth === reportMonth,
      reason: hedgeye.reason,
    })),
    {
      id: 'cleveland-fed',
      source: 'CLEVELAND FED',
      value: comparison?.clevelandFed?.value,
      role: 'NOWCAST',
      period: comparison?.clevelandFed?.reportMonth || reportMonth,
      asOf: comparison?.clevelandFed?.asOf,
      status: comparison?.clevelandFed?.status,
      exact: comparison?.clevelandFed?.reportMonth === reportMonth,
      reason: comparison?.clevelandFed?.reason,
    },
    {
      id: 'bls-actual',
      source: 'BLS',
      value: comparison?.bls?.latestFinal?.value,
      role: 'LATEST ACTUAL',
      period: comparison?.bls?.latestFinal?.reportMonth || null,
      asOf: comparison?.bls?.fetchedAt || comparison?.bls?.asOf,
      status: comparison?.bls?.status,
      exact: Boolean(comparison?.bls?.latestFinal?.reportMonth
        && comparison.bls.latestFinal.reportMonth < reportMonth),
      reason: comparison?.bls?.reason,
    },
  ];
  return (
    <section
      className="pm-spx-factor-panel pm-cpi-source-panel"
      aria-label="CPI forecast and official source monitor"
      data-testid="cpi-source-monitor"
    >
      <table className="pm-spx-factor-table pm-cpi-source-table">
        <thead>
          <tr><th>SOURCE</th><th>VALUE</th><th>ROLE</th><th>PERIOD</th><th>AS OF</th></tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const available = row.status === 'available'
              && row.exact
              && finite(row.value)
              && (row.id === 'bls-actual' || currentRelease);
            const delayed = snapshot?.referenceOnly || refreshDelayed;
            return (
              <tr
                key={row.id}
                className={available ? undefined : 'is-unavailable'}
                data-availability={available ? 'available' : 'unavailable'}
                title={row.reason || undefined}
              >
                <th scope="row">{row.source}</th>
                <td className="pm-spx-factor-value">
                  {available ? (
                    <>
                      {formatCpiPercent(row.value)}
                      <DelayedDataMarker
                        status={delayed ? 'refresh-delayed' : row.id === 'bls-actual' ? 'historical' : 'available'}
                        title={`${row.source} ${row.role} as of ${row.asOf || 'unknown'}`}
                      />
                    </>
                  ) : '—'}
                </td>
                <td>{row.role}</td>
                <td>{row.period ? formatCpiMonth(row.period).toUpperCase() : '—'}</td>
                <td>{available && row.asOf ? formatAsOf(row.asOf) : '—'}</td>
              </tr>
            );
          })}
          {!rows.length && (
            <tr className="is-unavailable"><td colSpan="5">NO VERIFIED CPI FORECAST SOURCES</td></tr>
          )}
        </tbody>
      </table>
    </section>
  );
};

const FactorMonitor = ({ snapshot, analyses, nowMs, refreshDelayed, marketId = 'sp500', marketUi = MARKET_UI.sp500 }) => {
  if (marketId === 'cpi') {
    return <CpiSourceMonitor snapshot={snapshot} refreshDelayed={refreshDelayed} nowMs={nowMs} />;
  }
  if (marketId !== 'sp500') {
    return (
      <GenericFactorMonitor
        snapshot={snapshot}
        refreshDelayed={refreshDelayed}
        marketUi={marketUi}
      />
    );
  }
  const factors = snapshot?.factors || {};
  const riskRange = snapshot?.riskRange;
  const shared = analyses[0]?.confluence || null;
  const usable = (factor) => isSpxMonitorSectionUsable(factor, nowMs);
  const dxyAvailable = usable(factors.dxy);
  const usdAvailable = usable(factors.usd);
  const cftcAvailable = usable(factors.cftc);
  const gammaAvailable = usable(factors.gamma);
  const gammaLevelsAvailable = usable(factors.gammaLevels);
  const spyAvailable = usable(factors.spyVolume);
  const vixAvailable = usable(factors.vix);
  const vvixAvailable = usable(factors.vvix);
  const structureAvailable = usable(factors.structure);
  const tradeAvailable = usable(factors.trade);
  const rangeAvailable = usable(riskRange);
  const tradeDirection = tradeAvailable && factorToken(factors.trade?.direction)
    ? factorToken(factors.trade.direction)
    : null;
  const trendDirection = rangeAvailable && factorToken(riskRange?.trend)
    ? factorToken(riskRange.trend)
    : null;
  const gateAvailable = Boolean(tradeDirection || trendDirection);
  const gateComplete = Boolean(tradeDirection && trendDirection);
  const structureValue = structureAvailable
    ? (
      <CompoundFactorValue
        separator=" · "
        values={[
          { key: 'flow', value: factorToken(factors.structure.systematicFlow) },
          { key: 'pv', value: factorToken(factors.structure.pvBand) },
          { key: 'allocation', value: factorToken(factors.structure.strategicAllocation) },
        ]}
      />
    )
    : '—';
  const gateValue = gateAvailable
    ? (
      <CompoundFactorValue
        separator=" / "
        values={[
          { key: 'trade', value: tradeDirection || '—', tone: factorDirectionTone(tradeDirection) },
          { key: 'trend', value: trendDirection || '—', tone: factorDirectionTone(trendDirection) },
        ]}
      />
    )
    : '—';
  const cftcValue = cftcAvailable ? (
    <CompoundFactorValue
      separator=" / "
      values={[
        { key: '1y', value: formatSignedFactorNumber(factors.cftc?.zScore1Y), tone: factorSignTone(factors.cftc?.zScore1Y) },
        { key: '3y', value: formatSignedFactorNumber(factors.cftc?.zScore3Y), tone: factorSignTone(factors.cftc?.zScore3Y) },
      ]}
    />
  ) : '—';
  const gammaThrottlePresent = finite(factors.gamma?.throttle);
  const realizedVolPresent = finite(factors.gamma?.realizedVol10d);
  const gammaMetricsAvailable = gammaAvailable && (gammaThrottlePresent || realizedVolPresent);
  const gammaMetricsComplete = gammaThrottlePresent && realizedVolPresent;
  const gammaMetricsValue = gammaMetricsAvailable ? (
    <CompoundFactorValue
      separator=" / "
      values={[
        {
          key: 'throttle',
          value: gammaThrottlePresent ? formatSignedFactorNumber(factors.gamma.throttle) : '—',
          tone: factorSignTone(factors.gamma?.throttle),
        },
        {
          key: 'rvol',
          value: realizedVolPresent ? formatFactorNumber(factors.gamma.realizedVol10d) : '—',
          tone: realizedVolPresent ? 'neutral' : 'unavailable',
        },
      ]}
    />
  ) : '—';
  const gammaLevelsValue = gammaLevelsAvailable ? (
    <CompoundFactorValue
      separator=" · "
      values={[
        { key: 'zero', value: `ZG ${formatFactorNumber(factors.gammaLevels?.zeroGamma, 0)}`, tone: 'neutral' },
        {
          key: 'pv',
          value: `PV ${formatFactorNumber(factors.gammaLevels?.lowerPvBand, 0)}–${formatFactorNumber(factors.gammaLevels?.upperPvBand, 0)}`,
          tone: 'neutral',
        },
      ]}
    />
  ) : '—';
  const eventTicker = snapshot?.contracts?.event?.ticker || snapshot?.selectedGenerationId || 'KXINXU';
  const selectedVenueId = snapshot?.selectedVenueId || snapshot?.displaySelection?.venueId || 'auto';
  const factorRows = [
    {
      label: 'DXY · LAST CLOSE',
      value: formatFactorNumber(factors.dxy?.value, 2), maximum: 'CTX', points: '—',
      source: factors.dxy?.source, asOf: factors.dxy?.asOf, available: dxyAvailable,
      detail: factors.dxy?.reason,
      valueTone: 'neutral',
      refreshDelayed: Boolean(factors.dxy?.refreshIssue),
      referenceStatus: factors.dxy?.status,
    },
    {
      label: 'USD CORR · SPX/DXY 30D',
      value: formatFactorNumber(factors.usd?.r30), maximum: '2', points: pointLabel(shared?.correlation?.points),
      source: factors.usd?.source, asOf: factors.usd?.asOf, available: usdAvailable,
      detail: factors.usd?.reason,
      valueTone: factorCorrelationTone(factors.usd?.r30),
      pointsTone: factorScoreTone(shared?.correlation?.points),
      refreshDelayed: Boolean(factors.usd?.refreshIssue),
      referenceStatus: factors.usd?.status,
    },
    {
      label: 'CFTC · E-MINI · 1Y / 3Y Z',
      value: cftcValue, maximum: 'CTX', points: '—',
      source: factors.cftc?.source, asOf: factors.cftc?.asOf, available: cftcAvailable,
      detail: cftcAvailable
        ? [
            finite(factors.cftc?.latest) ? `Net ${formatSignedFactorNumber(factors.cftc.latest, 0)}` : null,
            finite(factors.cftc?.weeklyChange) ? `W/W ${formatSignedFactorNumber(factors.cftc.weeklyChange, 0)}` : null,
            'Positioning context only; it does not add points.',
          ].filter(Boolean).join(' · ')
        : factors.cftc?.reason,
      unavailableValue: 'NOT VERIFIED',
      unavailableAsOf: factors.cftc?.date,
      refreshDelayed: Boolean(factors.cftc?.refreshIssue),
      referenceStatus: factors.cftc?.status,
    },
    {
      label: 'DEALER GAMMA · EXPOSURE',
      value: String(factors.gamma?.value || '').toUpperCase(), maximum: '1', points: 'BY LINE',
      source: factors.gamma?.source, asOf: factors.gamma?.asOf, available: gammaAvailable,
      detail: factors.gamma?.reason,
      valueTone: factorDirectionTone(factors.gamma?.value),
      refreshDelayed: Boolean(factors.gamma?.refreshIssue),
      referenceStatus: factors.gamma?.status,
    },
    {
      label: 'GAMMA THROTTLE / 10D RVOL',
      value: gammaMetricsValue, maximum: 'CTX', points: '—',
      source: factors.gamma?.metricSource || factors.gamma?.source,
      asOf: factors.gamma?.metricAsOf || factors.gamma?.asOf,
      available: gammaMetricsAvailable,
      partial: gammaMetricsAvailable && !gammaMetricsComplete,
      detail: gammaMetricsAvailable
        ? 'Source-dated Market Situation Report context; no independent point threshold is defined.'
        : 'The current Market Situation Report did not publish verified Gamma Throttle / 10D RVOL metrics.',
      unavailableValue: 'NOT EXTRACTED',
      unavailableAsOf: factors.gamma?.asOf,
      refreshDelayed: Boolean(factors.gamma?.refreshIssue),
      referenceStatus: factors.gamma?.status,
    },
    {
      label: 'ZERO GAMMA / PV BANDS',
      value: gammaLevelsValue, maximum: 'CTX', points: '—',
      source: factors.gammaLevels?.source,
      asOf: factors.gammaLevels?.asOf,
      available: gammaLevelsAvailable,
      detail: gammaLevelsAvailable
        ? [
            Array.isArray(factors.gammaLevels?.strikesInPlay) && factors.gammaLevels.strikesInPlay.length
              ? `Strikes in play: ${factors.gammaLevels.strikesInPlay.map((value) => formatFactorNumber(value, 0)).join(', ')}`
              : null,
            'Location context only; Risk Range remains the scored geometry model.',
          ].filter(Boolean).join(' · ')
        : factors.gammaLevels?.reason,
      unavailableValue: 'NOT EXTRACTED',
      unavailableAsOf: factors.gamma?.asOf,
      refreshDelayed: Boolean(factors.gammaLevels?.refreshIssue),
      referenceStatus: factors.gammaLevels?.status,
    },
    {
      label: `SPY RTH VOLUME / 20D${factors.spyVolume?.status === 'historical' ? ' · LAST SESSION' : ''}`,
      value: finite(factors.spyVolume?.ratio) ? `${Number(factors.spyVolume.ratio).toFixed(2)}×` : '—', maximum: '—', points: '—',
      source: factors.spyVolume?.source, asOf: factors.spyVolume?.asOf, available: spyAvailable,
      detail: factors.spyVolume?.reason,
      valueTone: factorRelativeTone(factors.spyVolume?.ratio),
      refreshDelayed: Boolean(factors.spyVolume?.refreshIssue),
      referenceStatus: factors.spyVolume?.status,
    },
    {
      label: `VIX${factors.vix?.status === 'historical' ? ' · LAST CLOSE' : ''}`,
      value: formatFactorNumber(factors.vix?.value, 2), maximum: '1', points: pointLabel(shared?.volatility?.points),
      source: factors.vix?.source, asOf: factors.vix?.asOf, available: vixAvailable,
      detail: factors.vix?.reason,
      valueTone: factorVolatilityTone('VIX', factors.vix?.value),
      pointsTone: factorScoreTone(shared?.volatility?.points),
      refreshDelayed: Boolean(factors.vix?.refreshIssue),
      referenceStatus: factors.vix?.status,
    },
    {
      label: `VVIX${factors.vvix?.status === 'historical' ? ' · LAST CLOSE' : ''}`,
      value: formatFactorNumber(factors.vvix?.value, 2), maximum: '—', points: '—',
      source: factors.vvix?.source, asOf: factors.vvix?.asOf, available: vvixAvailable,
      detail: factors.vvix?.reason,
      valueTone: factorVolatilityTone('VVIX', factors.vvix?.value),
      refreshDelayed: Boolean(factors.vvix?.refreshIssue),
      referenceStatus: factors.vvix?.status,
    },
    {
      label: 'HEDGEYE STRUCTURE BREADTH',
      value: structureValue, maximum: '2', points: pointLabel(shared?.structure?.points),
      source: factors.structure?.source, asOf: factors.structure?.asOf, available: structureAvailable,
      detail: factors.structure?.reason,
      pointsTone: factorScoreTone(shared?.structure?.points),
      refreshDelayed: Boolean(factors.structure?.refreshIssue),
      referenceStatus: factors.structure?.status,
    },
    {
      label: 'TRADE / TREND GATE',
      value: gateValue, maximum: 'GATE', points: shared?.eligibilityPassed ? 'PASS' : 'BLOCKED',
      source: [tradeDirection ? factors.trade?.source : null, trendDirection ? riskRange?.source : null]
        .filter(Boolean).join(' · '),
      detail: [
        tradeDirection ? null : `Trade unavailable: ${factors.trade?.reason || 'No verified same-session publication.'}`,
        trendDirection ? null : `Trend unavailable: ${riskRange?.reason || 'No verified current Risk Range trend.'}`,
      ].filter(Boolean).join(' · '),
      asOf: tradeDirection ? factors.trade?.asOf : riskRange?.asOf,
      available: gateAvailable,
      partial: gateAvailable && !gateComplete,
      pointsTone: factorDirectionTone(shared?.eligibilityPassed ? 'PASS' : 'BLOCKED'),
      refreshDelayed: Boolean(factors.trade?.refreshIssue || riskRange?.refreshIssue),
      referenceStatus: factors.trade?.status,
    },
    {
      label: 'CONTRACT / RR GEOMETRY',
      value: 'PER STRIKE', maximum: '2', points: 'BY LINE',
      source: riskRange?.source, asOf: riskRange?.asOf, available: rangeAvailable,
      detail: riskRange?.reason,
      refreshDelayed: Boolean(riskRange?.refreshIssue),
      referenceStatus: riskRange?.status,
    },
  ];
  return (
    <section
      className="pm-spx-factor-panel"
      aria-label="SPX factor monitor"
      data-selected-venue={selectedVenueId}
      data-event-ticker={eventTicker || undefined}
    >
      <table className="pm-spx-factor-table">
        <thead>
          <tr><th>FACTOR</th><th>VALUE</th><th>MAX PTS</th><th>POINTS</th><th>AS OF</th></tr>
        </thead>
        <tbody>
          {factorRows.map((row) => (
            <FactorRow
              key={row.label}
              {...row}
              refreshDelayed={refreshDelayed || row.refreshDelayed}
            />
          ))}
        </tbody>
      </table>
    </section>
  );
};

const LiveSpotMarkerRow = ({ spot, columnCount }) => {
  const markerLabel = formatSpotMarker(spot);
  const markerPrice = formatIndex(spot?.value);
  const markerDataStatus = spot?.status === 'historical'
    || ['last_close', 'historical'].includes(String(spot?.availability || '').toLowerCase())
    ? 'historical'
    : spot?.status === 'last_verified'
      || ['last_verified', 'delayed'].includes(String(spot?.availability || '').toLowerCase())
      ? 'delayed'
      : 'live';
  const markerPriceStart = markerLabel.lastIndexOf(markerPrice);
  const markerPrefix = markerPriceStart >= 0 ? markerLabel.slice(0, markerPriceStart) : markerLabel;
  const markerSuffix = markerPriceStart >= 0
    ? markerLabel.slice(markerPriceStart + markerPrice.length)
    : '';
  const markerContext = markerPriceStart >= 0
    ? [markerPrefix.trim(), markerSuffix.trim()].filter(Boolean).join(' ')
    : markerLabel;
  return (
    <tr
      className={`pm-spx-live-marker-row${['last_verified', 'delayed'].includes(spot?.availability) ? ' is-last-verified' : ''}`}
      aria-label={markerLabel}
    >
      <td colSpan={columnCount}>
        <div className="pm-spx-live-marker-line" data-testid="spx-live-marker-line">
          <span className="pm-spx-live-marker-price-track" data-testid="spx-live-marker-price-track">
            <span className="pm-spx-live-marker-segment" data-testid="spx-live-marker-segment" aria-hidden="true" />
            {markerPriceStart >= 0 && (
              <b className="pm-spx-live-marker-price">
                {markerPrice}
                <DelayedDataMarker
                  status={markerDataStatus}
                  title={markerLabel}
                  updatedAt={spot?.lastVerifiedAt || spot?.asOf || spot?.timestamp || spot?.observedAt}
                />
              </b>
            )}
            <span className="pm-spx-live-marker-segment" data-testid="spx-live-marker-segment" aria-hidden="true" />
          </span>
          <span className="pm-spx-live-marker-middle-track">
            <span className="pm-spx-live-marker-segment" data-testid="spx-live-marker-segment" aria-hidden="true" />
          </span>
          <span className="pm-spx-live-marker-context-track" data-testid="spx-live-marker-context-track">
            <span className="pm-spx-live-marker-segment" data-testid="spx-live-marker-segment" aria-hidden="true" />
            {markerPriceStart >= 0 && (
              <span className="pm-spx-live-marker-label" data-testid="spx-live-marker-label">
                <span className="pm-spx-live-marker-context">{markerContext}</span>
              </span>
            )}
            <span className="pm-spx-live-marker-segment" data-testid="spx-live-marker-segment" aria-hidden="true" />
          </span>
        </div>
      </td>
    </tr>
  );
};

const CpiLadderReferenceRow = ({ reference, columnCount }) => {
  const parsedAsOf = Date.parse(reference?.asOf || '');
  const pullDate = Number.isFinite(parsedAsOf)
    ? new Intl.DateTimeFormat('en-US', {
        month: 'numeric',
        day: 'numeric',
        year: '2-digit',
        timeZone: 'America/Los_Angeles',
      }).format(new Date(parsedAsOf))
    : 'DATE UNAVAILABLE';
  const label = reference.label || 'HEDGEYE BASE';
  return (
    <tr
      className="pm-cpi-ladder-reference-row"
      aria-label={`${label} ${pullDate} ${formatCpiPercent(reference.value)}`}
      data-testid="cpi-ladder-reference-row"
    >
      <td colSpan={columnCount}>
        <div className="pm-spx-live-marker-line">
          <span className="pm-spx-live-marker-price-track">
            <span className="pm-spx-live-marker-segment" aria-hidden="true" />
            <b className="pm-spx-live-marker-price">
              {formatCpiPercent(reference.value)}
            </b>
            <span className="pm-spx-live-marker-segment" aria-hidden="true" />
          </span>
          <span className="pm-spx-live-marker-middle-track">
            <span className="pm-spx-live-marker-segment" aria-hidden="true" />
          </span>
          <span className="pm-spx-live-marker-context-track">
            <span className="pm-spx-live-marker-segment" aria-hidden="true" />
            <span className="pm-spx-live-marker-label">
              <span className="pm-spx-live-marker-context">{label} · {pullDate}</span>
            </span>
            <span className="pm-spx-live-marker-segment" aria-hidden="true" />
          </span>
        </div>
      </td>
    </tr>
  );
};

const LiveFesPositionSummary = ({ position }) => {
  const cost = formatPositionCost(position.cost);
  const average = formatPositionAverage(position.averageCost);
  const quantity = formatPositionQuantity(position.quantity);
  return (
    <span
      className="pm-spx-position-summary"
      aria-label={`Live IBKR position: ${position.side}, cost ${cost}, average price ${average}, quantity ${quantity}`}
    >
      <span className={`pm-spx-position-side is-${position.side.toLowerCase()}`}>{position.side}</span>
      <span aria-hidden="true"> - {cost} ({average} × {quantity})</span>
    </span>
  );
};

const ContractLadder = ({
  snapshot,
  analyses,
  nowMs,
  marketUi = MARKET_UI.sp500,
  venueSelection = null,
  positionMap = null,
}) => {
  const spot = snapshot?.spot;
  const eventTicker = snapshot?.contracts?.event?.ticker || null;
  const referenceSymbol = snapshot?.contractReferenceLabel || marketUi.symbol;
  const contractResolverSymbol = snapshot?.contracts?.event?.resolverSymbol || referenceSymbol;
  const strictFesReference = marketUi.fixedContract?.productCode === 'FES'
    && venueSelection?.id === 'forecastex';
  const spotAvailable = finite(spot?.value) && (strictFesReference
    ? (
        isVerifiedDisplayReference(spot, nowMs)
        || isLastVerifiedContractReference(spot, eventTicker, nowMs)
        || isVerifiedDelayedContractReference(spot, contractResolverSymbol, nowMs)
      )
    : marketUi.simplified === true
      ? isVerifiedDisplayReference(spot, nowMs)
      : isSpxMonitorSectionUsable(spot, nowMs));
  const ladderReference = snapshot?.ladderReference;
  const ladderReferenceAvailable = marketUi.fixedContract?.productCode === 'KXCPIYOY'
    && ladderReference?.status === 'available'
    && ladderReference?.kind === 'hedgeye_base'
    && ladderReference?.executable === false
    && ladderReference?.reportMonth === snapshot?.contracts?.event?.reportMonth
    && finite(ladderReference?.value)
    && Number.isFinite(Date.parse(ladderReference?.expiresAt || ''))
    && Date.parse(ladderReference.expiresAt) > nowMs
    && Boolean(String(ladderReference?.source || '').trim());
  const activeReference = spotAvailable ? spot : ladderReferenceAvailable ? ladderReference : null;
  const referenceAvailable = Boolean(activeReference);
  const usesSharedAboveComparator = marketUi.fixedContract?.productCode === 'FES'
    && analyses.every(({ line }) => !line?.comparator || line.comparator === '>');
  const lines = analyses.map(({ line }) => line);
  const placementLines = lines.map((line) => ({
    ...line,
    threshold: contractLineGeometry(line)?.anchor ?? line.threshold,
  }));
  const placement = referenceAvailable ? locateSpxLivePrice(placementLines, activeReference.value) : null;
  const proximityLevels = referenceAvailable
    ? buildLadderProximityLevels(lines, activeReference.value)
    : new Map();
  const contractRowCount = Math.max(1, analyses.length);
  const ladderStyle = {
    '--pm-spx-ladder-row-share': `${100 / contractRowCount}%`,
  };

  return (
    <section
      className="pm-spx-ladder-panel"
      aria-label={`${marketUi.fullLabel} prediction-market contract ladder`}
      data-market-symbol={marketUi.symbol}
      data-contract-row-count={analyses.length}
      data-fit-mode="no-scroll"
      style={ladderStyle}
    >
      <table className="pm-spx-ladder-table">
        <caption className="pm-spx-visually-hidden">
          {snapshot?.cardView ? 'Selected display' : 'All active'} {venueSelection?.label || 'prediction-market'} {marketUi.fullLabel} lines, sorted by strike
        </caption>
        <colgroup>
          <col className="pm-spx-ladder-col-line" />
          <col className="pm-spx-ladder-col-quote" span="4" />
          <col className="pm-spx-ladder-col-volume" />
          <col className="pm-spx-ladder-col-open-interest" />
          <col className="pm-spx-ladder-col-spread" />
          <col className="pm-spx-ladder-col-distance" />
        </colgroup>
        <thead>
          <tr className="pm-spx-ladder-group-row">
            <th rowSpan="2" scope="col">
              <span>{usesSharedAboveComparator ? `${contractResolverSymbol} SETTLES ABOVE` : 'LINE'}</span>
            </th>
            <th className="pm-spx-quote-group-heading is-yes" colSpan="2" scope="colgroup" title="Native Yes quotes and displayed sizes from the selected venue.">YES</th>
            <th className="pm-spx-quote-group-heading is-no pm-spx-quote-group-start" colSpan="2" scope="colgroup" title="Native No quotes and displayed sizes from the selected venue.">NO</th>
            <th rowSpan="2" scope="col" title="Contracts traded during the published rolling 24-hour period. Volume may include contracts later closed.">24H VOL</th>
            <th rowSpan="2" scope="col" title="Currently open contracts on this exact line. OI is a contract count, not dollars or an entry-price distribution.">LINE OI</th>
            <th rowSpan="2" scope="col">Y / N SPREAD</th>
            <th rowSpan="2" scope="col">Δ {ladderReferenceAvailable ? 'HYE BASE' : referenceSymbol}</th>
          </tr>
          <tr className="pm-spx-ladder-quote-row">
            <th scope="col" title="Native venue Yes bid; displayed size appears below the price when published.">BID</th>
            <th scope="col" title="Native venue Yes ask; displayed size appears below the price when published.">ASK</th>
            <th className="pm-spx-quote-group-start" scope="col" title="Native venue No bid; displayed size appears below the price when published.">BID</th>
            <th scope="col" title="Native venue No ask; displayed size appears below the price when published.">ASK</th>
          </tr>
        </thead>
        <tbody>
          {placement?.afterIndex === -1 && (spotAvailable
            ? <LiveSpotMarkerRow spot={spot} columnCount={CONTRACT_COLUMN_COUNT} />
            : <CpiLadderReferenceRow reference={ladderReference} columnCount={CONTRACT_COLUMN_COUNT} />)}
          {analyses.map(({ line }, index) => {
            const positionKey = String(line.contractId || line.ticker || '').trim().toUpperCase();
            const linePositions = positionMap?.get(positionKey) || [];
            const lineLabel = line.comparator === 'inclusive_range'
              ? `${formatIndex(line.lowerBound, marketUi.precision ?? 0)}–${formatIndex(line.upperBound, marketUi.precision ?? 0)}`
              : formatIndex(line.threshold, marketUi.precision ?? 0);
            const lineDescription = line.comparator === 'inclusive_range'
              ? `Inclusive range ${lineLabel}`
              : `${line.comparator === '<' ? 'Settles below' : 'Settles above'} ${lineLabel}`;
            const proximityLevel = proximityLevels.get(index) || null;
            const rowClasses = [
              line.status === 'incomplete' || line.status === 'unavailable' ? 'is-incomplete' : null,
              proximityLevel ? `is-spot-proximity-${proximityLevel}` : null,
            ].filter(Boolean).join(' ') || undefined;
            return (
              <React.Fragment key={line.ticker}>
                <tr className={rowClasses} data-spot-proximity={proximityLevel || undefined}>
                  <td
                    className={`pm-spx-line-cell${linePositions.length ? ' has-position' : ''}`}
                    data-comparator={line.comparator || '>'}
                  >
                    <div className="pm-spx-line-content">
                      <strong title={lineDescription}>{lineLabel}</strong>
                      {linePositions.map((position) => (
                        <LiveFesPositionSummary key={position.side} position={position} />
                      ))}
                    </div>
                  </td>
                  <ContractQuoteCell outcome="Yes" side="bid" price={line.yesBid} size={line.yesBidSize} />
                  <ContractQuoteCell outcome="Yes" side="ask" price={line.yesAsk} size={line.yesAskSize} />
                  <ContractQuoteCell outcome="No" side="bid" price={line.noBid} size={line.noBidSize} groupStart />
                  <ContractQuoteCell outcome="No" side="ask" price={line.noAsk} size={line.noAskSize} />
                  <td>{formatCount(line.volume24h)}</td>
                  <td>{formatCount(line.openInterest)}</td>
                  <td>{formatSpread(line.yesBid, line.yesAsk)} / {formatSpread(line.noBid, line.noAsk)}</td>
                  <td className={referenceAvailable && Number(contractLineGeometry(line)?.anchor) < Number(activeReference.value) ? 'is-negative' : referenceAvailable ? 'is-positive' : ''}>
                    {referenceAvailable ? formatSignedDistance(
                      contractLineGeometry(line)?.range
                        ? Number(activeReference.value) < contractLineGeometry(line).lower
                          ? contractLineGeometry(line).lower
                          : Number(activeReference.value) > contractLineGeometry(line).upper
                            ? contractLineGeometry(line).upper
                            : activeReference.value
                        : contractLineGeometry(line)?.anchor,
                      activeReference.value,
                    ) : '—'}
                  </td>
                </tr>
                {placement?.afterIndex === index && (spotAvailable
                  ? <LiveSpotMarkerRow spot={spot} columnCount={CONTRACT_COLUMN_COUNT} />
                  : <CpiLadderReferenceRow reference={ladderReference} columnCount={CONTRACT_COLUMN_COUNT} />)}
              </React.Fragment>
            );
          })}
          {analyses.length === 0 && (
            <tr className="pm-spx-ladder-empty"><td colSpan={CONTRACT_COLUMN_COUNT}>
              {snapshot?.contracts?.reason || `NO VERIFIED ACTIVE ${marketUi.label.toUpperCase()} LINES`}
            </td></tr>
          )}
        </tbody>
      </table>
    </section>
  );
};

const StrategyPlanner = ({ snapshot, analyses, portfolioData, selectedAccount, nowMs }) => {
  const [portfolioPercent, setPortfolioPercent] = useState('');
  const [legMix, setLegMix] = useState({});
  const portfolio = useMemo(
    () => resolveVerifiedPortfolioSizingBase(portfolioData, selectedAccount, nowMs),
    [portfolioData, selectedAccount, nowMs],
  );
  const candidates = useMemo(() => buildSpxStrategyCandidates({
    analyses,
    contracts: snapshot?.contracts,
    nowMs,
  }), [analyses, snapshot?.contracts, nowMs]);
  const candidateSignature = candidates.map(({ ticker }) => ticker).join('|');

  useEffect(() => {
    setLegMix((previous) => {
      if (!candidates.length) return {};
      const hasCompleteExistingMix = candidates.every(({ ticker }) => finite(previous[ticker]));
      return hasCompleteExistingMix
        ? Object.fromEntries(candidates.map(({ ticker }) => [ticker, previous[ticker]]))
        : defaultSpxStrategyMix(candidates);
    });
  // The ticker signature is the intentional reset boundary. Quote updates do
  // not erase an operator's mix while the selected legs remain unchanged.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidateSignature]);

  const plan = useMemo(() => sizeSpxStrategy({
    candidates,
    netLiquidation: portfolio.netLiquidation,
    portfolioPercent,
    legMix,
  }), [candidates, legMix, portfolio.netLiquidation, portfolioPercent]);
  const planByTicker = useMemo(
    () => new Map(plan.legs.map((leg) => [leg.ticker, leg])),
    [plan.legs],
  );
  const parsedPercent = finite(portfolioPercent) ? Number(portfolioPercent) : null;
  const draftBudget = portfolio.available && parsedPercent > 0 && parsedPercent <= 100
    ? portfolio.netLiquidation * (parsedPercent / 100)
    : null;
  const canSize = portfolio.available && candidates.length > 0;
  const mixTotal = candidates.reduce((sum, { ticker }) => (
    sum + (finite(legMix[ticker]) ? Number(legMix[ticker]) : 0)
  ), 0);
  const strategySide = candidates[0]?.side || null;
  const issue = !portfolio.available
    ? portfolio.reason
    : !candidates.length
      ? 'MODEL GATE / DIRECT BOOK UNAVAILABLE'
      : plan.ready
        ? null
        : plan.reason;
  const cappedCount = plan.ready ? plan.legs.filter((leg) => leg.depthCapped).length : 0;

  const updateMix = (ticker, value) => {
    if (value === '') {
      setLegMix((current) => ({ ...current, [ticker]: '' }));
      return;
    }
    const number = Number(value);
    if (!Number.isFinite(number)) return;
    setLegMix((current) => ({ ...current, [ticker]: Math.min(100, Math.max(0, number)) }));
  };

  return (
    <aside className="pm-spx-strategy-panel" aria-label="SPX strategy and position sizing">
      <header className="pm-spx-strategy-header">
        <span>STRATEGY / SIZE</span>
        <small>{strategySide ? `BUY ${strategySide} LADDER` : 'WAITING FOR GATE'}</small>
      </header>

      <div className="pm-spx-strategy-inputs">
        <div>
          <span>PORTFOLIO</span>
          <strong>{portfolio.available ? formatCurrency(portfolio.netLiquidation) : '—'}</strong>
          <small>{portfolio.available ? `${portfolio.accountId} · ${formatAsOf(portfolio.asOf)}` : portfolio.reason}</small>
        </div>
        <label>
          <span>ALLOC %</span>
          <span className="pm-spx-percent-input">
            <input
              aria-label="Portfolio allocation percent"
              type="number"
              inputMode="decimal"
              min="0"
              max="100"
              step="0.1"
              placeholder="0.0"
              value={portfolioPercent}
              disabled={!canSize}
              onChange={(event) => setPortfolioPercent(event.target.value)}
            />
            <i>%</i>
          </span>
        </label>
        <div>
          <span>BUDGET</span>
          <strong>{formatCurrency(draftBudget, 2)}</strong>
          <small>MIX {candidates.length ? `${mixTotal.toFixed(0)}%` : '—'}</small>
        </div>
      </div>

      <div className="pm-spx-strategy-table-wrap">
        <table className="pm-spx-strategy-table">
          <caption className="pm-spx-visually-hidden">Model-aligned SPX contract ladder sizing</caption>
          <thead>
            <tr><th>BUY</th><th>ASK</th><th>SCORE</th><th>MIX %</th><th>QTY</th><th>COST</th></tr>
          </thead>
          <tbody>
            {candidates.map((candidate) => {
              const sized = planByTicker.get(candidate.ticker);
              return (
                <tr key={candidate.ticker}>
                  <td title={candidate.ticker}>
                    <strong>{candidate.side} &gt; {formatIndex(candidate.threshold, 0)}</strong>
                  </td>
                  <td>{formatCents(candidate.ask)}</td>
                  <td>{candidate.score} / {candidate.maxScore}</td>
                  <td>
                    <input
                      aria-label={`${candidate.ticker} mix percent`}
                      type="number"
                      inputMode="decimal"
                      min="0"
                      max="100"
                      step="1"
                      value={legMix[candidate.ticker] ?? ''}
                      disabled={!portfolio.available}
                      onChange={(event) => updateMix(candidate.ticker, event.target.value)}
                    />
                  </td>
                  <td className={sized?.depthCapped ? 'is-depth-capped' : undefined}>
                    {sized ? formatCount(sized.quantity) : '—'}
                  </td>
                  <td>{sized ? formatCurrency(sized.cost, 2) : '—'}</td>
                </tr>
              );
            })}
            {!candidates.length && (
              <tr className="pm-spx-strategy-empty"><td colSpan="6">NO MODEL-ELIGIBLE DIRECT BOOKS</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="pm-spx-strategy-totals">
        <div><span>PLANNED COST</span><strong>{plan.ready ? formatCurrency(plan.totalCost, 2) : '—'}</strong></div>
        <div><span>UNUSED</span><strong>{plan.ready ? formatCurrency(plan.unusedBudget, 2) : '—'}</strong></div>
        <div><span>DEPTH CAPS</span><strong>{plan.ready ? cappedCount : '—'}</strong></div>
      </div>
      <footer className={issue ? 'is-blocked' : 'is-ready'}>
        <span>{issue || 'READY'}</span>
        <small>DIRECT ASK · VISIBLE DEPTH</small>
      </footer>
    </aside>
  );
};

const ResolverDashboard = ({ snapshot, marketUi, venueSelection }) => {
  const event = venueSelection?.contracts?.event || venueSelection?.venue?.catalog?.event || null;
  const fixedContract = Boolean(marketUi.fixedContract);
  const venues = Object.values(snapshot?.venues || {});
  const coverage = venues.map((venue) => (
    `${venue.label}: ${venue.catalog?.lines?.length || 0} catalog / ${venue.bookQuality?.directLineCount || 0} quoted / ${venue.bookQuality?.executableLineCount || 0} executable`
  )).join(' · ') || 'No current venue coverage';
  const referenceFit = snapshot?.spot?.fit || snapshot?.chart?.fit || 'exact';
  const strategyReason = snapshot?.strategy?.status === 'available' && !venueSelection?.strategyEligible
    ? `The validated SP500 model applies only to ${snapshot.strategy.eligibleSeriesTicker} on Kalshi; ${venueSelection?.label || 'this venue'} uses a different resolver.`
    : snapshot?.strategy?.reason || `No validated ${marketUi.fullLabel} prediction-contract model is configured.`;
  const sourceHealth = Array.isArray(snapshot?.sourceHealth) ? snapshot.sourceHealth : [];
  const settlementSources = (Array.isArray(event?.settlementSources) ? event.settlementSources : [])
    .map((source) => typeof source === 'string' ? source : source?.name || source?.url)
    .filter(Boolean)
    .join(' · ');
  const measuredPeriod = event?.measurementDate || event?.measuredPeriod || event?.observationTime;
  const exactResolver = venueSelection?.resolver?.pythSymbol
    || event?.resolverSymbol
    || venueSelection?.resolver?.resolver
    || '—';
  const resolverUnderlying = venueSelection?.resolver?.contractSymbol
    || event?.resolverContractMonth
    || venueSelection?.resolver?.underlying
    || '—';
  const referenceAvailability = snapshot?.resolverReference?.spot?.availability || snapshot?.spot?.availability;
  const referenceLabel = referenceFit === 'proxy'
    ? 'PROXY · NOT EXECUTABLE'
    : referenceAvailability === 'live'
      ? 'EXACT · LIVE'
      : referenceAvailability === 'last_verified'
        ? 'EXACT · LAST VERIFIED'
        : 'UNAVAILABLE';
  const payoutTime = formatExchangeAndLocalTime(event?.payoutAt || event?.payoutTime, event?.timezone);
  const payoutLabel = [
    finite(event?.payoutAmount) ? formatCurrency(event.payoutAmount, 2) : null,
    payoutTime === '—' ? null : payoutTime,
  ].filter(Boolean).join(' · ') || '—';
  const liveBookVerified = venueSelection?.executionAvailable === true;
  const routingVerified = venueSelection?.brokerRoutable === true;
  const readiness = liveBookVerified && routingVerified
    ? {
        label: 'MANUAL REVIEW',
        status: 'MANUAL ONLY',
        tone: 'ready',
        detail: 'Live book and broker routing are verified. Automated sizing remains disabled.',
      }
    : liveBookVerified
      ? {
          label: 'VERIFY ROUTING',
          status: 'NOT ACTIONABLE',
          tone: 'blocked',
          detail: 'The live book is verified, but broker routing is not. Do not place an order from this card.',
        }
      : {
          label: 'WAIT',
          status: 'NOT ACTIONABLE',
          tone: 'blocked',
          detail: 'No verified executable book. Catalog and quote-only rows are context, not an order signal.',
        };
  const eventFields = fixedContract ? [
    ['CONTRACT', event?.ticker || 'DISCOVERING'],
    ['MEASURED PERIOD', formatMeasuredPeriod(measuredPeriod, event?.timezone)],
    ['CLOSE', formatExchangeAndLocalTime(event?.closeTime, event?.timezone)],
    ['RESOLUTION', formatExchangeAndLocalTime(event?.resolutionAt || event?.resolutionTime, event?.timezone)],
    ['PAYOUT', payoutLabel],
    ['EXACT RESOLVER', exactResolver],
    ['REFERENCE', referenceLabel],
    ['ROUTING', routingVerified ? 'VERIFIED' : 'UNVERIFIED'],
  ] : [
      ['CURRENT EVENT', event?.ticker || 'DISCOVERING'],
      ['VENUE / CADENCE', [event?.venueId || venueSelection?.id, event?.cadence].filter(Boolean).join(' / ') || '—'],
      ['MEASURED PERIOD', formatMeasuredPeriod(measuredPeriod, event?.timezone)],
      ['OPEN', formatExchangeAndLocalTime(event?.openTime, event?.timezone)],
      ['CLOSE', formatExchangeAndLocalTime(event?.closeTime, event?.timezone)],
      ['OBSERVATION', formatExchangeAndLocalTime(event?.observationTime, event?.timezone)],
      ['RESOLUTION', formatExchangeAndLocalTime(event?.resolutionAt || event?.resolutionTime, event?.timezone)],
      ['PAYOUT', formatExchangeAndLocalTime(event?.payoutAt || event?.payoutTime, event?.timezone)],
      ['EXACT RESOLVER', exactResolver],
      ['UNDERLYING', resolverUnderlying],
      ['REFERENCE', referenceFit === 'proxy' ? 'PROXY · NOT RESOLVER / NOT EXECUTABLE' : snapshot?.spot?.availability === 'live' ? 'EXACT · LIVE' : 'EXACT · LAST CLOSE'],
      ['BROKER ROUTABLE', routingVerified ? 'YES' : 'NO / UNVERIFIED'],
      ['SETTLEMENT SOURCE', settlementSources || event?.settlementSource || '—'],
      ['EARLY CLOSE', event?.canCloseEarly === true ? 'ALLOWED BY TERMS' : event?.canCloseEarly === false ? 'NOT INDICATED' : '—'],
    ];

  return (
    <aside className="pm-spx-strategy-panel pm-spx-strategy-panel--unavailable" aria-label={`${marketUi.fullLabel} resolver diagnostics and position sizing`}>
    <header className="pm-spx-strategy-header">
      <span>{fixedContract ? 'TRADE READINESS' : 'RESOLVER / STRATEGY'}</span>
      <small className={fixedContract ? `is-${readiness.tone}` : undefined}>
        {fixedContract ? readiness.status : 'NO VALIDATED MODEL · SIZING DISABLED'}
      </small>
    </header>
    <div className="pm-spx-resolver-dashboard">
      {fixedContract && (
        <div className={`pm-spx-action-state is-${readiness.tone}`}>
          <strong>{readiness.label}</strong>
          <span>{readiness.detail}</span>
        </div>
      )}
      <dl className="pm-spx-resolver-grid">
        {eventFields.map(([label, value]) => (
          <div key={label}><dt>{label}</dt><dd title={value}>{value}</dd></div>
        ))}
      </dl>
      {event?.rulesUrl && (
        <a className="pm-spx-resolver-rules" href={event.rulesUrl} target="_blank" rel="noreferrer">VIEW OFFICIAL CONTRACT RULES</a>
      )}
      {!fixedContract && (
        <div className="pm-spx-resolver-coverage">
          <span>VENUE COVERAGE</span>
          <strong>{coverage}</strong>
        </div>
      )}
      {!fixedContract && (
        <div className="pm-spx-source-health" aria-label="Selected market source health">
          <span>SOURCE HEALTH</span>
          <ul>
            {sourceHealth.map((source) => (
              <li key={source.id} className={`is-${source.status}`} title={source.reason || undefined}>
                <strong>{source.label}</strong>
                <em>{humanizeSource(source.status)}</em>
                <small>{source.reason || (source.asOf ? `Observed ${formatAsOf(source.asOf)}` : source.status === 'not_applicable' ? 'Not applicable to this market.' : 'No verified observation.')}</small>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="pm-spx-model-disabled">
        <strong>NO VALIDATED MODEL / SIZING DISABLED</strong>
        <p>{strategyReason}</p>
      </div>
    </div>
    {!fixedContract && (
      <footer className="is-blocked">
        <span>MODEL / RESOLVER GATE</span>
        <small>NO PROXY SIZING</small>
      </footer>
    )}
    </aside>
  );
};

const MonitorToolbar = ({
  marketUi,
  snapshot,
  venuePreference,
  venueSelection,
  onVenuePreferenceChange,
  generationOptions = [],
  selectedGenerationOptionId = '',
  onGenerationChange,
  onClose,
  loading,
  nowMs,
}) => {
  const venueOptions = Array.isArray(marketUi.venueIds)
    ? VENUE_OPTIONS.filter((option) => marketUi.venueIds.includes(option.id))
    : VENUE_OPTIONS;
  const hasNativeQuotes = venueSelection?.contracts?.scheduleOnly !== true
    && (venueSelection?.contracts?.lines || []).some((line) => line?.directNative === true && (
      [line.yesBid, line.yesAsk, line.noBid, line.noAsk].some(finite)
    ));
  const selectedStatus = venueSelection?.executionAvailable
    ? 'LIVE BOOK'
    : hasNativeQuotes ? 'LIVE QUOTES'
    : venueSelection?.contracts?.status === 'available' ? 'CATALOG ONLY' : snapshot?.status || 'unavailable';
  const statusClass = venueSelection?.executionAvailable || hasNativeQuotes
    ? 'available'
    : venueSelection?.contracts?.status === 'available' ? 'partial' : 'unavailable';
  const selectedEvent = venueSelection?.contracts?.event || venueSelection?.venue?.catalog?.event || null;
  const tradingClock = buildContractTradingClock({
    event: selectedEvent,
    generation: snapshot?.selectedGeneration || null,
    nowMs,
  });

  return (
    <header className="pm-spx-monitor-toolbar">
    <div className="pm-spx-monitor-title">
      <strong>{marketUi.label}</strong>
      <span>{venueSelection?.contracts?.event?.title || `${marketUi.fullLabel} prediction contracts`}</span>
      <small className={`pm-spx-monitor-state pm-spx-monitor-state--${loading && !snapshot ? 'loading' : statusClass}`}>
        {loading && !snapshot ? 'LOADING' : String(selectedStatus).toUpperCase()}
      </small>
    </div>
    <div className="pm-spx-monitor-venue-tabs" role="tablist" aria-label={`${marketUi.fullLabel} contract venue`}>
      {venueOptions.map((option) => {
        const availability = getMonitorVenueAvailability(snapshot, option.id, nowMs);
        return (
          <button
            key={option.id}
            type="button"
            role="tab"
            aria-selected={venuePreference === option.id}
            aria-disabled={!availability.selectable}
            className={venuePreference === option.id ? 'is-active' : undefined}
            disabled={!availability.selectable}
            title={!availability.selectable ? availability.reason : undefined}
            onClick={() => onVenuePreferenceChange(option.id)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
    <label className="pm-spx-generation-selector">
      <span>CONTRACT GENERATION</span>
      <select
        aria-label={`${marketUi.fullLabel} contract generation`}
        value={selectedGenerationOptionId}
        disabled={!generationOptions.length}
        onChange={(event) => onGenerationChange?.(event.target.value)}
      >
        {!selectedGenerationOptionId && <option value="">No current generation</option>}
        {['kalshi', 'forecastex'].flatMap((venueId) => {
          const venueLabel = venueId === 'kalshi' ? 'Kalshi' : 'ForecastEx';
          const cadences = [...new Set(
            generationOptions
              .filter((option) => option.venueId === venueId)
              .map((option) => String(option.cadence || 'daily').toLowerCase()),
          )];
          return cadences.map((cadence) => {
            const options = generationOptions.filter((option) => (
              option.venueId === venueId
              && String(option.cadence || 'daily').toLowerCase() === cadence
            ));
            return (
              <optgroup key={`${venueId}:${cadence}`} label={`${venueLabel} · ${cadence.toUpperCase()}`}>
                {options.map((option) => (
                  <option key={option.id} value={option.id}>
                    {formatAsOf(option.closeTime)} · OI {formatCount(option.openInterest)} · VOL {formatCount(option.volume24h)} · {option.bookStatus === 'available' ? 'LIVE' : option.bookStatus === 'partial' ? 'PARTIAL' : 'CATALOG'}
                  </option>
                ))}
              </optgroup>
            );
          });
        })}
      </select>
    </label>
    <div
      className={`pm-spx-contract-clock is-${tradingClock.state}`}
      aria-label="Selected contract trading hours"
      title={tradingClock.title}
    >
      <strong>{tradingClock.headline}</strong>
      <span>{tradingClock.primarySchedule}</span>
      {tradingClock.secondarySchedule && <small>{tradingClock.secondarySchedule}</small>}
    </div>
    <button type="button" className="pm-spx-monitor-close" aria-label={`Close ${marketUi.label} monitor`} onClick={onClose}>
      <span aria-hidden="true">×</span>
    </button>
    </header>
  );
};

const compactAge = (value, nowMs) => {
  const timestamp = Date.parse(value || '');
  if (!Number.isFinite(timestamp)) return '—';
  const seconds = Math.max(0, Math.floor((nowMs - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
};

const compactCountdown = (value, nowMs) => {
  const closeMs = Date.parse(value || '');
  if (!Number.isFinite(closeMs)) return '—';
  const remaining = Math.max(0, closeMs - nowMs);
  const hours = Math.floor(remaining / 3_600_000);
  const minutes = Math.floor((remaining % 3_600_000) / 60_000);
  return remaining === 0 ? 'CLOSED' : `${hours}h ${String(minutes).padStart(2, '0')}m`;
};

const MonitorStatusStrip = ({ snapshot, venueSelection, nowMs, refreshError }) => {
  const event = venueSelection?.contracts?.event || venueSelection?.venue?.catalog?.event;
  const apiState = snapshot?.referenceOnly ? 'REFERENCE' : snapshot ? 'CONNECTED' : 'WAITING';
  return (
    <div className="pm-spx-status-strip" role="status" aria-label="Prediction monitor data status">
      <span className="pm-spx-status-api"><i className={snapshot && !snapshot.referenceOnly ? 'is-ok' : 'is-warn'} /> API {apiState}</span>
      <span className={refreshError ? 'pm-spx-status-revision is-delayed' : 'pm-spx-status-revision'} title={refreshError || undefined}>REVISION R{snapshot?.refresh?.revision || 0}</span>
      <span className="pm-spx-status-event">EVENT {event?.ticker || 'DISCOVERING'}</span>
      <span className="pm-spx-status-close">CLOSE {compactCountdown(event?.closeTime, nowMs)}</span>
      <span className="pm-spx-status-age">SNAPSHOT AGE {compactAge(snapshot?.generatedAt, nowMs)}</span>
      <span className={`pm-spx-status-execution ${venueSelection?.executionAvailable ? 'is-executable' : 'is-blocked'}`}>
        EXECUTION {venueSelection?.executionAvailable ? 'AVAILABLE' : 'UNAVAILABLE'}
      </span>
    </div>
  );
};

const ContractSummaryBar = ({ snapshot, venueSelection, nowMs }) => {
  const activity = snapshot?.productActivity || venueSelection?.venue?.activity || {};
  const event = venueSelection?.contracts?.event || venueSelection?.venue?.catalog?.event || null;
  const selectedGeneration = snapshot?.selectedGeneration || null;
  const quotedLines = selectedGeneration?.quotedLineCount
    ?? venueSelection?.venue?.bookQuality?.directLineCount
    ?? 0;
  const metrics = [
    {
      label: 'SELECTED-GEN OI',
      value: activity?.selectedGenerationOpenInterest?.value,
      title: 'The number of currently open contracts summed across this exact venue generation. OI is a contract count, not dollars and not an entry-price distribution.',
      suffix: ' contracts',
    },
    {
      label: 'ALL-OPEN OI',
      value: activity?.allOpenGenerationsOpenInterest?.value,
      title: 'The number of currently open contracts summed across every open generation for this product on the selected venue.',
      suffix: ' contracts',
    },
    {
      label: '24H VOLUME',
      value: activity?.volume24h?.value,
      title: 'Contracts traded during the published rolling 24-hour period. Volume can include contracts that traders later closed.',
      suffix: ' contracts',
    },
    {
      label: 'LIVE QUOTED LINES',
      value: quotedLines,
      title: 'Lines with a fresh native venue quote. Catalog-only lines are excluded.',
      suffix: '',
    },
  ];

  return (
    <div className="pm-spx-contract-summary" aria-label="Selected prediction contract generation summary">
      {metrics.map((metric) => (
        <div key={metric.label} title={metric.title}>
          <span>{metric.label}</span>
          <strong>{finite(metric.value) ? `${formatCount(metric.value)}${metric.suffix}` : '—'}</strong>
        </div>
      ))}
      <div title="Time remaining until the venue closes this exact generation.">
        <span>NEXT CLOSE / OBSERVATION</span>
        <strong>{compactCountdown(event?.observationTime || event?.closeTime, nowMs)}</strong>
      </div>
    </div>
  );
};

const PredictionMarketResolverTest = ({
  marketId = 'sp500',
  portfolioData = null,
  selectedAccount = null,
  onClose = () => {},
}) => {
  const active = useSurfaceActivity();
  const normalizedMarketId = MARKET_UI[marketId] ? marketId : 'sp500';
  const marketUi = MARKET_UI[normalizedMarketId];
  const simplifiedTemplate = marketUi.simplified === true;
  const [clockMs, setClockMs] = useState(() => Date.now());
  const [venuePreferences, setVenuePreferences] = useState({});
  const [generationPreferences, setGenerationPreferences] = useState({});
  const [monitorPollIntervalMs, setMonitorPollIntervalMs] = useState(POLL_MS);
  const [chartRange, setChartRange] = useState('1d');
  const [momoTrackerSpots, setMomoTrackerSpots] = useState({});
  const [spxHeaderMarketReferences, setSpxHeaderMarketReferences] = useState(null);
  const [goldHeaderMarketReferences, setGoldHeaderMarketReferences] = useState(null);
  const monitorRequestControllerRef = useRef(null);
  const spxHeaderMarketReferencesRef = useRef(null);
  const goldHeaderMarketReferencesRef = useRef(null);
  const positionAccountId = [selectedAccount, portfolioData?.accountId, portfolioData?.accountSummary?.accountId]
    .find((value) => typeof value === 'string' && value.trim())?.trim() || null;
  const positionOverlayEnabled = active
    && normalizedMarketId === 'sp500'
    && marketUi.fixedContract?.productCode === 'FES'
    && Boolean(positionAccountId);
  const loadPositionOverlay = useCallback(
    () => MarketDataService.getPortfolioPredictionMarketPositions({ primaryAccount: positionAccountId }),
    [positionAccountId],
  );
  const validatePositionOverlay = useCallback((payload) => {
    const normalized = normalizeLivePositionOverlayPayload(payload);
    if (normalized.status === 'unavailable') {
      throw Object.assign(new Error(normalized.message), {
        code: 'LIVE_FES_POSITIONS_UNAVAILABLE',
        liveInvalidation: true,
      });
    }
    return normalized;
  }, []);
  const positionOverlayResource = useSessionResource({
    resourceKey: 'prediction-market-resolver-fes-positions',
    scopeKey: positionAccountId || 'all-managed-accounts',
    kind: 'live',
    fetcher: loadPositionOverlay,
    validate: validatePositionOverlay,
    getObservedAt: (positions) => positions.fetchedAt,
    maxAgeMs: POSITION_MAX_AGE_MS,
    pollIntervalMs: POLL_MS,
    enabled: positionOverlayEnabled,
    active: positionOverlayEnabled,
    refreshOnActivate: true,
    invalidateOnScopeChange: true,
    retainOnRefreshFailure: false,
    displayRole: 'executable',
    expiredCode: 'LIVE_FES_POSITIONS_EXPIRED',
    expiredMessage: 'The verified-live ForecastEx position snapshot expired.',
  });

  useEffect(() => () => monitorRequestControllerRef.current?.abort(), []);

  const loadMomoTracker = useCallback(
    () => MarketDataService.getHedgeyeSnapshot('momo-tracker'),
    [],
  );
  const momoTrackerResource = useDashboardResource('momo-tracker', {}, {
    fetcher: loadMomoTracker,
    validate: (payload) => {
      const normalized = normalizeMomoTrackerSnapshot(payload || {});
      if (normalized.status === 'available') return normalized;
      throw new Error(normalized.reason || 'No verified current MOMO publication is available.');
    },
    getObservedAt: (value) => value.publicationDate,
    pollIntervalMs: MOMO_TRACKER_POLL_MS,
    active: active && normalizedMarketId === 'sp500' && chartRange === '1d',
    refreshOnActivate: true,
  });
  const momoTrackerSnapshot = momoTrackerResource.data;
  const momoTrackerState = momoTrackerSnapshot
    ? momoTrackerResource.error ? 'refresh-delayed' : 'available'
    : momoTrackerResource.initialLoading ? 'loading' : 'unavailable';

  useEffect(() => {
    const tickers = Array.isArray(momoTrackerSnapshot?.rows)
      ? momoTrackerSnapshot.rows.map((row) => row.ticker)
      : [];
    const enabled = active
      && normalizedMarketId === 'sp500'
      && chartRange === '1d'
      && ['available', 'refresh-delayed'].includes(momoTrackerState)
      && momoTrackerSnapshot?.status === 'available'
      && momoTrackerSnapshot?.publicationDate === newYorkDateKey();
    if (!enabled || !tickers.length) return undefined;

    let disposed = false;
    const loadMomoSpots = async () => {
      if (momoTrackerSnapshot.publicationDate !== newYorkDateKey()) {
        if (!disposed) setMomoTrackerSpots({});
        return;
      }
      try {
        const [quotes, providerStatus] = await Promise.all([
          MarketDataService.getQuotes(tickers),
          MarketDataService.getProviderStatus(),
        ]);
        const normalized = normalizeVerifiedMomoTrackerSpots(
          tickers,
          quotes,
          providerStatus,
          Date.now(),
        );
        if (!disposed) setMomoTrackerSpots(normalized);
      } catch (error) {
        if (disposed || error?.code === 'ERR_CANCELED' || error?.name === 'CanceledError') return;
        // Keep provider-timestamped informational spots through a transport
        // failure. currentMomoSpot fails each cell closed at its own expiry.
      }
    };

    void loadMomoSpots();
    const interval = setInterval(loadMomoSpots, MOMO_SPOT_POLL_MS);
    return () => {
      disposed = true;
      clearInterval(interval);
    };
  }, [active, chartRange, momoTrackerSnapshot, momoTrackerState, normalizedMarketId]);

  const loadGoldCorrelations = useCallback(
    () => MarketDataService.getGoldCorrelations(),
    [],
  );
  const [goldCorrelationPollIntervalMs, setGoldCorrelationPollIntervalMs] = useState(
    GOLD_CORRELATION_RETRY_POLL_MS,
  );
  const goldCorrelationResource = useDashboardResource('gold-correlations', {}, {
    fetcher: loadGoldCorrelations,
    validate: (payload) => {
      const normalized = normalizeGoldCorrelationSnapshot(payload || {}, Date.now());
      if (['available', 'partial'].includes(normalized.status)) return normalized;
      throw new Error(normalized.reason || 'Verified Gold correlation data is unavailable.');
    },
    getObservedAt: (value) => value?.basis?.asOf || value?.asOf,
    pollIntervalMs: goldCorrelationPollIntervalMs,
    active: active && normalizedMarketId === 'gold' && chartRange === '1d',
    refreshOnActivate: false,
  });
  const goldCorrelationSnapshot = goldCorrelationResource.data;
  const goldCorrelationState = goldCorrelationSnapshot
    ? goldCorrelationResource.error ? 'refresh-delayed' : goldCorrelationSnapshot.status
    : goldCorrelationResource.initialLoading ? 'loading' : 'unavailable';
  const goldCorrelationReason = goldCorrelationResource.error?.response?.data?.reason
    || goldCorrelationResource.error?.message
    || goldCorrelationSnapshot?.reason
    || null;

  useEffect(() => {
    const verified = ['available', 'partial'].includes(goldCorrelationSnapshot?.status)
      && !goldCorrelationResource.error;
    const nextInterval = verified
      ? GOLD_CORRELATION_POLL_MS
      : GOLD_CORRELATION_RETRY_POLL_MS;
    setGoldCorrelationPollIntervalMs((currentInterval) => (
      currentInterval === nextInterval ? currentInterval : nextInterval
    ));
  }, [goldCorrelationResource.error, goldCorrelationSnapshot?.status]);

  useEffect(() => {
    if (!active) return undefined;
    const previousRootOverflow = document.documentElement.style.overflow;
    const previousBodyOverflow = document.body.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';
    return () => {
      document.documentElement.style.overflow = previousRootOverflow;
      document.body.style.overflow = previousBodyOverflow;
    };
  }, [active]);

  const requestVenue = canonicalPredictionMonitorVenue(
    normalizedMarketId,
    normalizedMarketId === 'gold' ? 'kalshi' : (simplifiedTemplate
      ? 'auto'
      : venuePreferences[normalizedMarketId] || marketUi.defaultVenue || 'auto'),
  );
  const requestGenerationId = simplifiedTemplate
    ? null
    : generationPreferences[`${normalizedMarketId}:${requestVenue}`] || null;
  const requestKey = `${normalizedMarketId}|${requestVenue}|${requestGenerationId || 'default'}`;
  const previousRequestKeyRef = useRef(requestKey);
  const loadSnapshot = useCallback(async () => {
    monitorRequestControllerRef.current?.abort();
    const controller = new AbortController();
    monitorRequestControllerRef.current = controller;
    try {
      const next = await predictionMarketTestService.getMonitor(normalizedMarketId, {
        signal: controller.signal,
        venue: requestVenue,
        generationId: requestGenerationId,
      });
      if (
        !next
        || next.schemaVersion !== 2
        || next.marketId !== normalizedMarketId
        || !next.venues
        || !next.contracts
        || !Array.isArray(next.contracts.lines)
      ) {
        throw new Error(`${marketUi.label} monitor returned an invalid snapshot.`);
      }
      return next;
    } catch (error) {
      const localized = error?.response?.data?.errors?.[0];
      const message = (typeof localized === 'string' ? localized : localized?.message)
        || error.message
        || `${marketUi.label} monitor refresh failed.`;
      if (message === error?.message) throw error;
      throw Object.assign(new Error(message), {
        cause: error,
        liveInvalidation: isExplicitLiveInvalidation(error),
      });
    } finally {
      if (monitorRequestControllerRef.current === controller) {
        monitorRequestControllerRef.current = null;
      }
    }
  }, [marketUi.label, normalizedMarketId, requestGenerationId, requestVenue]);
  const monitorResource = useDashboardResource('prediction-monitor', {
    marketId: normalizedMarketId,
    venue: requestVenue,
    generationId: requestGenerationId,
  }, {
    fetcher: loadSnapshot,
    validate: (next) => (
      next
      && next.schemaVersion === 2
      && next.marketId === normalizedMarketId
      && next.venues
      && next.contracts
      && Array.isArray(next.contracts.lines)
        ? next
        : null
    ),
    getObservedAt: (next) => next.generatedAt,
    maxAgeMs: 90_000,
    pollIntervalMs: monitorPollIntervalMs,
    active,
    // A ready retained snapshot is already safe to paint on the first visible
    // frame. Polling resumes independently; cold, delayed, expired and
    // session-hydrated snapshots still revalidate immediately in the hook.
    refreshOnActivate: false,
    invalidateOnScopeChange: false,
    isExplicitInvalidation: isExplicitLiveInvalidation,
    expiredCode: 'PREDICTION_MONITOR_EXPIRED',
    expiredMessage: 'The last verified prediction-monitor snapshot expired.',
  });
  const snapshot = monitorResource.data || monitorResource.referenceData;
  const loading = monitorResource.initialLoading && !snapshot;
  const refreshError = monitorResource.error?.message || null;

  useEffect(() => {
    if (previousRequestKeyRef.current === requestKey) return;
    previousRequestKeyRef.current = requestKey;
    monitorRequestControllerRef.current?.abort();
    spxHeaderMarketReferencesRef.current = null;
    goldHeaderMarketReferencesRef.current = null;
    setSpxHeaderMarketReferences(null);
    setGoldHeaderMarketReferences(null);
    setMonitorPollIntervalMs(POLL_MS);
    setChartRange('1d');
  }, [requestKey]);

  useEffect(() => {
    setMonitorPollIntervalMs(snapshot?.session?.state === 'closed' ? CLOSED_POLL_MS : POLL_MS);
  }, [snapshot?.session?.state]);

  useEffect(() => {
    if (!active) return undefined;
    setClockMs(Date.now());
    const timer = setInterval(() => setClockMs(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, [active]);

  const currentSnapshot = snapshot?.marketId === normalizedMarketId ? snapshot : null;
  useEffect(() => {
    if (!currentSnapshot) return;
    if (normalizedMarketId === 'sp500') {
      const headerReferences = stabilizeSpxHeaderMarketReferences(
        spxHeaderMarketReferencesRef.current,
        currentSnapshot,
        Date.now(),
      );
      spxHeaderMarketReferencesRef.current = headerReferences;
      setSpxHeaderMarketReferences(headerReferences);
    }
    if (normalizedMarketId === 'gold') {
      const headerReferences = stabilizeGoldHeaderMarketReferences(
        goldHeaderMarketReferencesRef.current,
        currentSnapshot,
        Date.now(),
      );
      goldHeaderMarketReferencesRef.current = headerReferences;
      setGoldHeaderMarketReferences(headerReferences);
    }
  }, [currentSnapshot, normalizedMarketId]);
  const requestedVenuePreference = marketUi.fixedContract?.venueId || (simplifiedTemplate
    ? 'auto'
    : venuePreferences[normalizedMarketId] || marketUi.defaultVenue || 'auto');
  const requestedVenueAvailability = useMemo(
    () => getMonitorVenueAvailability(currentSnapshot, requestedVenuePreference, clockMs),
    [clockMs, currentSnapshot, requestedVenuePreference],
  );
  const refreshInProgress = currentSnapshot?.refresh?.state === 'refreshing';
  const fixedVenueId = marketUi.fixedContract?.venueId || null;
  const venuePreference = fixedVenueId || (
    requestedVenuePreference === 'auto' || requestedVenueAvailability.selectable || refreshInProgress
      ? requestedVenuePreference
      : 'auto'
  );
  useEffect(() => {
    if (
      fixedVenueId
      || !currentSnapshot
      || refreshInProgress
      || requestedVenuePreference === 'auto'
      || requestedVenueAvailability.selectable
    ) return;
    setVenuePreferences((current) => (
      current[normalizedMarketId] === requestedVenuePreference
        ? { ...current, [normalizedMarketId]: 'auto' }
        : current
    ));
  }, [currentSnapshot, fixedVenueId, normalizedMarketId, refreshInProgress, requestedVenueAvailability.selectable, requestedVenuePreference]);
  const venueSelection = useMemo(
    () => resolveMonitorVenue(currentSnapshot, venuePreference),
    [currentSnapshot, venuePreference],
  );
  const displaySnapshot = useMemo(
    () => snapshotForVenue(currentSnapshot, venueSelection),
    [currentSnapshot, venueSelection],
  );
  const positionMap = useMemo(() => buildLiveFesPositionMap(
    positionOverlayResource.data?.positions,
    {
      generationKey: displaySnapshot?.contracts?.event?.ticker,
      accountId: positionAccountId,
    },
  ), [displaySnapshot?.contracts?.event?.ticker, positionAccountId, positionOverlayResource.data?.positions]);
  const contractLadderSnapshot = useMemo(() => {
    if (!displaySnapshot || !simplifiedTemplate) {
      return displaySnapshot;
    }
    if (normalizedMarketId !== 'sp500' || venueSelection.id !== 'forecastex') {
      const reference = displaySnapshot?.cardView
        ? displaySnapshot?.resolverReference || null
        : venueSelection?.venue?.reference || displaySnapshot?.resolverReference || null;
      const referenceLabel = reference?.instrument?.displaySymbol
        || reference?.instrument?.localSymbol
        || reference?.spot?.label
        || marketUi.symbol;
      return {
        ...displaySnapshot,
        spot: reference?.spot || displaySnapshot.spot,
        contractReferenceLabel: referenceLabel,
      };
    }
    const serverReference = currentSnapshot?.resolverReference || null;
    const reference = spxHeaderMarketReferences?.futuresReference || serverReference;
    const referenceLabel = reference?.instrument?.displaySymbol
      || reference?.instrument?.localSymbol
      || reference?.resolver
      || 'FES';
    const contractResolverSymbol = displaySnapshot?.contracts?.event?.resolverSymbol || referenceLabel;
    const generationKey = displaySnapshot?.contracts?.event?.ticker
      || currentSnapshot?.venues?.forecastex?.generationKey
      || null;
    const displaySpot = isVerifiedDisplayReference(reference?.spot, clockMs)
      ? { ...reference.spot, label: referenceLabel }
      : null;
    const lastVerifiedSpot = isLastVerifiedContractReference(
      serverReference?.lastVerifiedSpot,
      generationKey,
      clockMs,
    ) ? {
        ...serverReference.lastVerifiedSpot,
        label: referenceLabel,
      } : null;
    const delayedCandidate = delayedSpxHeaderReference(
      reference?.spot,
      { reason: 'A fresh futures reference is unavailable.' },
      clockMs,
    );
    const delayedSpot = isVerifiedDelayedContractReference(
      delayedCandidate,
      contractResolverSymbol,
      clockMs,
    ) ? {
        ...delayedCandidate,
        label: referenceLabel,
      } : null;
    const spot = displaySpot || lastVerifiedSpot || delayedSpot || {
          status: 'unavailable',
          availability: 'unavailable',
          fit: reference?.spot?.fit || 'proxy',
          value: null,
          label: referenceLabel,
          source: null,
          asOf: null,
          expiresAt: null,
          executable: false,
          reason: 'The verified directional FES futures reference is unavailable.',
        };
    return {
      ...displaySnapshot,
      spot,
      contractReferenceLabel: referenceLabel,
    };
  }, [clockMs, currentSnapshot?.resolverReference, currentSnapshot?.venues?.forecastex?.generationKey, displaySnapshot, marketUi.symbol, normalizedMarketId, simplifiedTemplate, spxHeaderMarketReferences?.futuresReference, venueSelection.id, venueSelection?.venue?.reference]);
  const analyses = useMemo(() => {
    const contracts = displaySnapshot?.contracts;
    const mayShowSchedule = contracts?.scheduleOnly === true;
    const usable = isSpxMonitorSectionUsable(contracts, clockMs);
    const lines = (usable || mayShowSchedule) && Array.isArray(contracts?.lines)
      ? [...contracts.lines].sort((left, right) => Number(left.threshold) - Number(right.threshold))
      : [];
    return lines.map((line) => ({ line, confluence: null }));
  }, [clockMs, displaySnapshot]);
  const ladderAnalyses = useMemo(() => (
    simplifiedTemplate
      ? selectContractLinesForReference(
          analyses,
          (
            isVerifiedDisplayReference(contractLadderSnapshot?.spot, clockMs)
            || isLastVerifiedContractReference(
              contractLadderSnapshot?.spot,
              displaySnapshot?.contracts?.event?.ticker,
              clockMs,
            )
            || isVerifiedDelayedContractReference(
              contractLadderSnapshot?.spot,
              displaySnapshot?.contracts?.event?.resolverSymbol,
              clockMs,
            )
          ) ? contractLadderSnapshot.spot.value
            : normalizedMarketId === 'cpi'
              && contractLadderSnapshot?.ladderReference?.status === 'available'
              && contractLadderSnapshot.ladderReference?.reportMonth === displaySnapshot?.contracts?.event?.reportMonth
              && Date.parse(contractLadderSnapshot.ladderReference?.expiresAt || '') > clockMs
              && finite(contractLadderSnapshot.ladderReference?.value)
              ? contractLadderSnapshot.ladderReference.value
              : null,
        )
      : analyses
  ), [analyses, clockMs, contractLadderSnapshot?.ladderReference, contractLadderSnapshot?.spot, displaySnapshot?.contracts?.event?.reportMonth, displaySnapshot?.contracts?.event?.resolverSymbol, displaySnapshot?.contracts?.event?.ticker, normalizedMarketId, simplifiedTemplate]);
  const strategySnapshot = useMemo(() => (
    venueSelection.strategyEligible
      ? { ...currentSnapshot, contracts: venueSelection.executionContracts }
      : null
  ), [currentSnapshot, venueSelection.executionContracts, venueSelection.strategyEligible]);
  const strategyAnalyses = useMemo(() => (
    strategySnapshot ? buildSpxContractAnalyses(strategySnapshot, clockMs) : []
  ), [clockMs, strategySnapshot]);
  const refreshDelayed = Boolean(refreshError && snapshot);
  const goldCorrelationUsable = normalizedMarketId === 'gold'
    && isGoldCorrelationSnapshotUsable(goldCorrelationSnapshot, clockMs);
  const factorDisplaySnapshot = useMemo(() => withCanonicalGoldCorrelationFactor(
    displaySnapshot,
    goldCorrelationUsable ? goldCorrelationSnapshot : null,
    clockMs,
  ), [clockMs, displaySnapshot, goldCorrelationSnapshot, goldCorrelationUsable]);
  const generationOptions = useMemo(() => (
    Array.isArray(currentSnapshot?.generationOptions)
      ? currentSnapshot.generationOptions
      : []
  ), [currentSnapshot?.generationOptions]);
  const selectedGenerationOptionId = currentSnapshot?.selectedGeneration
    ? currentSnapshot.selectedGeneration.id
    : currentSnapshot?.selectedVenueId && currentSnapshot?.selectedGenerationId
      ? `${currentSnapshot.selectedVenueId}:${currentSnapshot.selectedGenerationId}`
      : '';
  const updateVenuePreference = useCallback((preference) => {
    if (!getMonitorVenueAvailability(currentSnapshot, preference, clockMs).selectable) return;
    setVenuePreferences((current) => ({ ...current, [normalizedMarketId]: preference }));
  }, [clockMs, currentSnapshot, normalizedMarketId]);
  const updateGenerationPreference = useCallback((optionId) => {
    const selected = generationOptions.find((option) => option.id === optionId);
    if (!selected) return;
    setVenuePreferences((current) => ({ ...current, [normalizedMarketId]: selected.venueId }));
    setGenerationPreferences((current) => ({
      ...current,
      [`${normalizedMarketId}:${selected.venueId}`]: selected.generationId,
    }));
    setChartRange('1d');
  }, [generationOptions, normalizedMarketId]);
  const fixedContractTradingClock = simplifiedTemplate ? buildContractTradingClock({
    event: venueSelection?.contracts?.event || venueSelection?.venue?.catalog?.event || null,
    generation: currentSnapshot?.selectedGeneration || null,
    nowMs: clockMs,
  }) : null;
  const factorMonitor = (
    <FactorMonitor
      snapshot={factorDisplaySnapshot}
      analyses={normalizedMarketId === 'sp500' ? strategyAnalyses : analyses}
      nowMs={clockMs}
      loading={loading}
      refreshDelayed={refreshDelayed}
      marketId={normalizedMarketId}
      marketUi={marketUi}
    />
  );

  return (
    <section
      className="pm-spx-monitor-shell"
      aria-label={!snapshot
        ? `${marketUi.fullLabel} prediction-market monitor loading`
        : snapshot.referenceOnly
          ? `${marketUi.fullLabel} prediction-market retained reference`
          : `Live ${marketUi.fullLabel} prediction-market monitor`}
      aria-busy={loading || monitorResource.refreshing || currentSnapshot?.refresh?.state === 'refreshing'}
    >
      {!['cpi', 'gold', 'sp500'].includes(normalizedMarketId) && (
        <div className="pm-spx-resource-status">
          <ResourceDataStatusChip
            resource={monitorResource}
            context={`${marketUi.fullLabel} prediction monitor`}
          />
        </div>
      )}
      {!simplifiedTemplate && (
        <MonitorToolbar
          marketUi={marketUi}
          snapshot={currentSnapshot}
          venuePreference={venuePreference}
          venueSelection={venueSelection}
          onVenuePreferenceChange={updateVenuePreference}
          generationOptions={generationOptions}
          selectedGenerationOptionId={selectedGenerationOptionId}
          onGenerationChange={updateGenerationPreference}
          onClose={onClose}
          loading={loading}
          nowMs={clockMs}
        />
      )}
      {!simplifiedTemplate && (
        <MonitorStatusStrip
          snapshot={currentSnapshot}
          venueSelection={venueSelection}
          nowMs={clockMs}
          refreshError={refreshError}
        />
      )}
      {!simplifiedTemplate && (
        <ContractSummaryBar
          snapshot={currentSnapshot}
          venueSelection={venueSelection}
          nowMs={clockMs}
        />
      )}
      <div className={`pm-spx-monitor-top${simplifiedTemplate ? ' pm-spx-monitor-top--chart-only' : ''}`}>
        {normalizedMarketId === 'cpi' ? (
          <CpiForecastComparisonPanel
            snapshot={displaySnapshot}
            nowMs={clockMs}
            refreshDelayed={refreshDelayed}
            loading={loading}
            resourceRefreshing={monitorResource.refreshing
              || currentSnapshot?.refresh?.state === 'refreshing'}
            venueSelection={venueSelection}
          />
        ) : (
          <SpxRiskRangeChart
            snapshot={displaySnapshot}
            nowMs={clockMs}
            refreshDelayed={refreshDelayed}
            marketUi={marketUi}
            chartRange={chartRange}
            onChartRangeChange={setChartRange}
            tradingClock={fixedContractTradingClock}
            checkingHours={loading && !currentSnapshot}
            loading={loading}
            resourceRefreshing={monitorResource.refreshing
              || currentSnapshot?.refresh?.state === 'refreshing'}
            venueSelection={venueSelection}
            spySpot={normalizedMarketId === 'sp500'
              ? spxHeaderMarketReferences?.spySpot || currentSnapshot?.spySpot || null
              : null}
            cashIndexSpot={normalizedMarketId === 'sp500'
              ? spxHeaderMarketReferences?.cashSpot
                || currentSnapshot?.cashSpot
                || (currentSnapshot?.cardView ? null : currentSnapshot?.spot)
              : null}
            futuresReference={normalizedMarketId === 'sp500'
              ? spxHeaderMarketReferences?.futuresReference || currentSnapshot?.resolverReference || null
              : currentSnapshot?.resolverReference || null}
            momoTracker={normalizedMarketId === 'sp500' ? momoTrackerSnapshot : null}
            momoTrackerSpots={normalizedMarketId === 'sp500' ? momoTrackerSpots : {}}
            momoTrackerState={normalizedMarketId === 'sp500' ? momoTrackerState : 'idle'}
            goldMarketReferences={normalizedMarketId === 'gold'
              ? goldHeaderMarketReferences
                || displaySnapshot?.goldMarketReferences
                || currentSnapshot?.goldMarketReferences
                || []
              : []}
            goldCorrelationSnapshot={goldCorrelationUsable ? goldCorrelationSnapshot : null}
            goldCorrelationState={normalizedMarketId === 'gold'
              ? goldCorrelationUsable ? goldCorrelationSnapshot.status : goldCorrelationState
              : 'idle'}
            goldCorrelationReason={goldCorrelationReason}
            goldCorrelationResource={normalizedMarketId === 'gold' ? goldCorrelationResource : null}
          />
        )}
        {!simplifiedTemplate && factorMonitor}
      </div>
      <div className={`pm-spx-monitor-bottom${simplifiedTemplate ? ' pm-spx-monitor-bottom--factor-layout' : ''}`}>
        <ContractLadder
          snapshot={contractLadderSnapshot}
          analyses={ladderAnalyses}
          nowMs={clockMs}
          marketUi={marketUi}
          venueSelection={venueSelection}
          positionMap={positionMap}
        />
        {simplifiedTemplate ? factorMonitor : venueSelection.strategyEligible ? (
          <StrategyPlanner
            snapshot={strategySnapshot}
            analyses={strategyAnalyses}
            portfolioData={portfolioData}
            selectedAccount={selectedAccount}
            nowMs={clockMs}
          />
        ) : (
          <ResolverDashboard snapshot={currentSnapshot} marketUi={marketUi} venueSelection={venueSelection} />
        )}
      </div>
      {refreshError && <span className="pm-spx-visually-hidden" role="status">{refreshError}</span>}
    </section>
  );
};

export default PredictionMarketResolverTest;
