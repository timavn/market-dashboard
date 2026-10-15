import React, { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { BarChart3, Droplet, Scale } from 'lucide-react';
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
import { MarketDataService } from '../../services/api/marketDataService';
import predictionMarketsIngestService from '../../services/api/predictionMarketsIngestService';
import { useSessionResource } from '../../hooks/useSessionResource';
import {
  buildRiskRangeThirdBands,
  RISK_RANGE_BAND_COLORS,
} from '../../utils/riskRangeChart';
import { startVisibilityAwarePolling } from '../../utils/visibilityAwarePolling';
import LoadingIndicator from '../common/LoadingIndicator';
import PersistentSurface, { useSurfaceActivity } from '../common/PersistentSurface';
import useHedgaiTickResearch from '../../hooks/useHedgaiTickResearch';
import DashboardResearchLabel from './DashboardResearchLabel';
import './PredictionMarketsHub.css';

const CpiWorkbench = lazy(() => import('./PredictionMarkets'));
const SpxWorkbench = lazy(() => import('./PredictionMarketsSandbox'));
const WtiWorkbench = lazy(() => import('./WtiWorkbench'));

export const PREDICTION_MARKET_VIEWS = Object.freeze(['overview', 'wti', 'spx', 'cpi']);
const POSITION_POLL_MS = 30000;
const POSITION_MAX_AGE_MS = 60000;
const OVERVIEW_POLL_MS = 30000;
const SPX_LIVE_SNAPSHOT_MAX_AGE_MS = 60000;
const CHART_AXIS_TICK_COLOR = '#64748b';
const PREDICTION_CONTRACT_PAYOUT = 1;
const EXCHANGE_OPTIONS = Object.freeze([
  Object.freeze({ value: 'kalshi', label: 'KALSHI' }),
  Object.freeze({ value: 'ibkr', label: 'IBKR' }),
]);

const finite = (value) => {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const firstValue = (...values) => values.find((value) => value != null && value !== '');

const formatNumber = (value, options = {}) => {
  const parsed = finite(value);
  if (parsed == null) return '—';
  return new Intl.NumberFormat('en-US', options).format(parsed);
};

const formatContractLabel = (label, seriesTicker) => {
  const text = String(label || '');
  if (!String(seriesTicker || '').trim().toUpperCase().startsWith('KXCPI')) return text;
  return text.replace(/(-?\d+(?:,\d{3})*(?:\.\d+)?)%/g, (match, rawValue) => {
    const numeric = Number(rawValue.replace(/,/g, ''));
    if (!Number.isFinite(numeric)) return match;
    return `${numeric.toLocaleString('en-US', {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    })}%`;
  });
};

const formatMoney = (value) => {
  const parsed = finite(value);
  if (parsed == null) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  }).format(parsed);
};

const formatPrice = (value) => {
  const parsed = finite(value);
  if (parsed == null) return '—';
  if (parsed >= 0 && parsed <= 1) return `${Math.round(parsed * 100)}¢`;
  return formatNumber(parsed, { maximumFractionDigits: 2 });
};

const formatPayoutRatio = (value) => {
  const parsed = finite(value);
  if (parsed == null || parsed <= 0) return '—';
  return `1:${new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(parsed)}`;
};

export function calculatePositionPayoff(position = {}) {
  const quantity = finite(position.quantity ?? position.position);
  if (quantity == null || quantity <= 0) {
    return { cost: null, payout: null, ratio: null, valid: false };
  }

  const avgCost = finite(position.avgCost ?? position.averageCost);
  const reportedCostBasis = finite(position.costBasis);
  const cost = reportedCostBasis != null
    ? reportedCostBasis
    : avgCost != null
      ? quantity * avgCost
      : null;
  if (cost == null || !Number.isFinite(cost) || cost <= 0) {
    return { cost: null, payout: null, ratio: null, valid: false };
  }

  const payout = quantity * PREDICTION_CONTRACT_PAYOUT;
  return {
    cost,
    payout,
    ratio: payout / cost,
    valid: true,
  };
}

const formatCompactNumber = (value) => {
  const parsed = finite(value);
  if (parsed == null) return '—';
  return new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(parsed);
};

const formatDateTime = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(date);
};

const normalizeStatus = (value) => String(value || '').trim().toLowerCase();

const normalizeDirectionalStatus = (value) => {
  const normalized = String(value || '').trim().toUpperCase().replace(/[_-]+/g, ' ');
  if (['BULL', 'BULLISH', 'BUY', 'LONG', 'POSITIVE'].includes(normalized)) return 'BULLISH';
  if (['BEAR', 'BEARISH', 'SELL', 'SHORT', 'NEGATIVE'].includes(normalized)) return 'BEARISH';
  if (['NEUTRAL', 'FLAT'].includes(normalized)) return 'NEUTRAL';
  return null;
};

const formatReferenceValue = (reference) => {
  const value = finite(reference?.value);
  if (value == null) return '—';
  if (reference.kind === 'forecast') {
    return `${formatNumber(value, { maximumFractionDigits: 1, minimumFractionDigits: 1 })}%`;
  }
  if (reference.displayFormat === 'spx_contract') {
    return formatNumber(value, { maximumFractionDigits: 0 });
  }
  if (reference.displayFormat === 'wti_contract') {
    const decimals = Math.abs(value % 1) > 0 ? 2 : 0;
    return `$${formatNumber(value, {
      maximumFractionDigits: decimals,
      minimumFractionDigits: decimals,
    })}`;
  }
  return formatNumber(value, { maximumFractionDigits: 2 });
};

function referenceQuoteState(reference) {
  if (normalizeStatus(reference?.status) !== 'available' || finite(reference?.value) == null) return null;
  const tone = normalizeStatus(reference.tone);
  const source = normalizeStatus(reference.source);
  const isClose = reference.historicalOnly === true ||
    reference.availability === 'historical' ||
    tone === 'close' ||
    /close|historical|settlement/.test(source);
  if (reference.kind === 'forecast') return { label: 'Forecast', tone: 'forecast' };
  return isClose
    ? { label: 'Close', tone: 'close' }
    : { label: 'Live', tone: 'live' };
}

function formatChartValue(value, chart = {}) {
  const parsed = finite(value);
  if (parsed == null) return '—';
  if (chart.unit === 'percent') {
    return `${formatNumber(parsed, { maximumFractionDigits: 1, minimumFractionDigits: 1 })}%`;
  }
  if (chart.displayFormat === 'spx_contract' || String(chart.ticker || '').toUpperCase() === 'SPX') {
    return formatNumber(parsed, { maximumFractionDigits: 0 });
  }
  if (chart.unit === 'usd') return formatMoney(parsed);
  return formatNumber(parsed, { maximumFractionDigits: 2 });
}

function chartReferenceValue(value, chart = {}) {
  const parsed = finite(value);
  if (parsed == null) return null;
  return chart.unit === 'percent' ? Number(parsed.toFixed(1)) : parsed;
}

export function normalizeForecastChartPoints(chart = {}) {
  return (Array.isArray(chart?.points) ? chart.points : [])
    .map((point) => ({
      timestamp: finite(point?.timestamp),
      value: chartReferenceValue(point?.value, chart),
    }))
    .filter((point) => point.timestamp != null && point.value != null)
    .sort((left, right) => left.timestamp - right.timestamp);
}

function buildPercentChartTicks(values, domain) {
  const step = 0.2;
  const source = values.length > 0 ? values : domain;
  const min = Math.min(...source);
  const max = Math.max(...source);
  const start = (Math.floor((min / step) + 1e-6) - 1) * step;
  const end = (Math.ceil((max / step) - 1e-6) + 1) * step;
  const count = Math.max(1, Math.round((end - start) / step));
  return Array.from({ length: count + 1 }, (_, index) => (
    Number((start + (index * step)).toFixed(1))
  ));
}

const chartReferenceColor = (tone) => tone === 'low'
  ? '#dc2626'
  : tone === 'high'
    ? '#059669'
    : '#111827';

export { buildRiskRangeThirdBands };

const MULTI_DAY_SESSION_GAP = 0.1;

function buildMultiDayChartLayout(points, dailyRanges = []) {
  const sessions = dailyRanges
    .map((range) => {
      const startAt = finite(range?.startAt);
      const endAt = finite(range?.endAt);
      if (!range?.date || startAt == null || endAt == null) return null;
      const sessionPoints = points.filter((point) => (
        point.timestamp >= startAt && point.timestamp <= endAt
      ));
      return sessionPoints.length > 0
        ? { date: range.date, points: sessionPoints }
        : null;
    })
    .filter(Boolean);

  if (sessions.length < 2) {
    return {
      points,
      sessions: [],
      gaps: [],
      maxX: null,
      latestPoint: points[points.length - 1] || null,
    };
  }

  const plottedPoints = [];
  const plottedSessions = [];
  const gaps = [];
  const slotWidth = 1;

  sessions.forEach((session, index) => {
    const firstPoint = session.points[0];
    const lastPoint = session.points[session.points.length - 1];
    const timestampSpan = Math.max(lastPoint.timestamp - firstPoint.timestamp, 1);
    const slotStart = index * (slotWidth + MULTI_DAY_SESSION_GAP);
    const slotEnd = slotStart + slotWidth;

    if (index > 0) {
      gaps.push({
        date: session.date,
        x: slotStart - (MULTI_DAY_SESSION_GAP / 2),
      });
      plottedPoints.push({
        plotX: slotStart - (MULTI_DAY_SESSION_GAP / 2),
        timestamp: null,
        value: null,
      });
    }

    session.points.forEach((point) => {
      plottedPoints.push({
        ...point,
        plotX: slotStart + ((point.timestamp - firstPoint.timestamp) / timestampSpan) * slotWidth,
      });
    });

    plottedSessions.push({
      date: session.date,
      startX: slotStart,
      endX: slotEnd,
      tickX: slotStart + (slotWidth / 2),
    });
  });

  const tickLabels = new Map(plottedSessions.map((session) => [
    session.tickX,
    new Date(`${session.date}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
  ]));

  return {
    points: plottedPoints,
    sessions: plottedSessions,
    gaps,
    maxX: plottedSessions[plottedSessions.length - 1].endX,
    latestPoint: plottedPoints[plottedPoints.length - 1] || null,
    tickLabels,
  };
}

export function classifyPredictionMarketPosition(position = {}) {
  const supplied = normalizeStatus(
    position.marketClassification || position.marketType || position.classification,
  );
  const suppliedFamily = normalizeStatus(position.marketFamily);
  const suppliedProduct = normalizeStatus(position.marketProduct);
  const suppliedVenue = normalizeStatus(position.marketVenue || position.venue || position.exchange);
  if (
    suppliedFamily === 'wti'
    && (suppliedProduct.includes('forecastex') || suppliedVenue.includes('forecast'))
  ) return 'wti-forecastex';
  if (supplied.includes('wti') && supplied.includes('week')) return 'wti-weekly';
  if (supplied.includes('wti') && supplied.includes('daily')) return 'wti-daily';
  if (suppliedFamily.includes('wti') && suppliedFamily.includes('week')) return 'wti-weekly';
  if (suppliedFamily.includes('wti') && suppliedFamily.includes('daily')) return 'wti-daily';
  if (suppliedFamily === 'wti' && suppliedProduct.includes('week')) return 'wti-weekly';
  if (suppliedFamily === 'wti' && suppliedProduct.includes('daily')) return 'wti-daily';
  if (suppliedFamily === 'wti' && suppliedProduct.includes('unsupported')) return 'wti-unsupported';
  if (supplied === 'wti') return 'wti-unsupported';
  if (supplied.includes('spx') || suppliedFamily === 'spx') return 'spx';
  if (supplied.includes('cpi') || suppliedFamily === 'cpi') return 'cpi';

  const text = [
    position.seriesTicker,
    position.eventTicker,
    position.ticker,
    position.symbol,
    position.description,
    position.localSymbol,
  ].filter(Boolean).join(' ').toUpperCase();

  if (/\bKXWTIW(?:\b|-)/.test(text)) return 'wti-weekly';
  if (/\bKXWTI(?:\b|-)/.test(text)) return 'wti-daily';
  if (/\bCOMCO(?:\b|_|-)/.test(text)) return 'wti-forecastex';
  if (/\bKXINXU(?:\b|-)/.test(text) || /S&P\s*500|SPX/.test(text)) return 'spx';
  if (/\bKXCPI|\bCPIY|CONSUMER PRICE INDEX/.test(text)) return 'cpi';
  if (/\bWTI\b|CRUDE OIL/.test(text)) return 'wti-unsupported';
  return 'other';
}

export function predictionMarketVenueLabel(position = {}, classification = null) {
  const suppliedVenue = normalizeStatus(position.marketVenue || position.venue || position.exchange);
  if (suppliedVenue.includes('forecast')) return 'ForecastEx';
  if (suppliedVenue.includes('kalshi')) return 'Kalshi';
  if (/\b(CME|CBOT|COMEX|NYMEX)\b/.test(String(position.exchange || '').toUpperCase())) return 'CME';

  const resolvedClassification = classification || classifyPredictionMarketPosition(position);
  if (resolvedClassification === 'wti-forecastex') return 'ForecastEx';
  const text = [
    position.seriesTicker,
    position.eventTicker,
    position.ticker,
    position.symbol,
    position.description,
    position.localSymbol,
  ].filter(Boolean).join(' ').toUpperCase();
  if (/\bKX[A-Z0-9]+(?:\b|-)/.test(text)) return 'Kalshi';
  return '—';
}

export const POSITION_MARKET_FILTERS = Object.freeze([
  Object.freeze({ key: 'all', label: 'All' }),
  Object.freeze({ key: 'cpi', label: 'CPI' }),
  Object.freeze({ key: 'sp500', label: 'SP500' }),
  Object.freeze({ key: 'wti', label: 'WTI' }),
]);

export function positionMarketFilter(position = {}) {
  const classification = classifyPredictionMarketPosition(position);
  if (classification === 'cpi') return 'cpi';
  if (classification === 'spx') return 'sp500';
  if (classification.startsWith('wti')) return 'wti';
  return 'other';
}

function predictionContractSide(position = {}) {
  const explicit = String(
    position.contractSide || position.side || position.nativeSide || position.right || '',
  ).trim().toUpperCase();
  if (explicit === 'YES' || explicit === 'NO') return explicit;
  const identity = [
    position.description,
    position.localSymbol,
    position.symbol,
    position.ticker,
  ].filter(Boolean).join(' ').toUpperCase();
  const match = identity.match(/(?:^|[-_\s])(YES|NO)(?:$|[-_\s])/);
  return match?.[1] || '—';
}

function predictionContractIdentity(position = {}) {
  return firstValue(
    position.description,
    position.localSymbol,
    position.contractTitle,
    position.ticker,
    position.symbol,
    position.conid != null ? `IBKR conId ${position.conid}` : null,
    'Unknown contract',
  );
}

export function selectIbkrContractPositions(positionsState, marketKey, cadence = null) {
  if (!['live', 'partial'].includes(normalizeStatus(positionsState?.status))) return [];
  return (positionsState?.positions || [])
    .filter((position) => positionMarketFilter(position) === marketKey)
    .filter((position) => {
      if (marketKey !== 'wti' || !cadence) return true;
      const classification = classifyPredictionMarketPosition(position);
      return cadence === 'weekly'
        ? classification === 'wti-weekly'
        : ['wti-daily', 'wti-forecastex'].includes(classification);
    })
    .map((position, index) => ({
      id: position.positionId
        || (position.conid != null ? `${position.accountId || position.account || 'account'}#${position.conid}` : null)
        || `${predictionContractIdentity(position)}-${index}`,
      identity: predictionContractIdentity(position),
      venue: predictionMarketVenueLabel(position),
      side: predictionContractSide(position),
      quantity: finite(position.quantity ?? position.position),
      averageCost: finite(position.avgCost ?? position.averageCost),
      accountId: position.accountId || position.account || '—',
    }));
}

export function normalizeLivePositionsPayload(payload) {
  const source = normalizeStatus(payload?.meta?.source || payload?.source);
  const status = normalizeStatus(
    payload?.status || payload?.aggregateStatus || payload?.meta?.aggregateStatus || payload?.meta?.status,
  );
  const quality = normalizeStatus(payload?.dataQuality?.status || payload?.meta?.dataQuality?.status);
  const cacheOnly = payload?._cache?.stale === true || payload?.meta?.cacheOnly === true;
  const forbiddenSource = /(cache|mock|seed|upload|fallback|reconstruct|unavailable|offline|stale)/.test(source);
  const forbiddenStatus = /(unavailable|offline|stale|error|failed|cache|mock|seed)/.test(status);
  const forbiddenQuality = /(unavailable|offline|stale|error|failed)/.test(quality);
  const explicitLive = status === 'live' || status === 'partial';
  const legacyLive = source === 'ibkr_live' || source === 'ibkr_live_partial' || source === 'ibkr_positions' || source === 'ibkr_positions_live';
  const available = !cacheOnly && !forbiddenSource && !forbiddenStatus && !forbiddenQuality && (explicitLive || legacyLive);

  if (!available) {
    return {
      status: 'unavailable',
      positions: [],
      accounts: Array.isArray(payload?.accounts) ? payload.accounts : [],
      message: firstValue(payload?.message, payload?.error, payload?.meta?.message, 'Verified-live IBKR positions are unavailable.'),
      fetchedAt: payload?.fetchedAt || payload?.meta?.fetchedAt || null,
    };
  }

  return {
    status: status === 'partial' || source === 'ibkr_live_partial' ? 'partial' : 'live',
    positions: Array.isArray(payload?.positions) ? payload.positions : [],
    accounts: Array.isArray(payload?.accounts) ? payload.accounts : [],
    message: firstValue(payload?.message, payload?.meta?.message, null),
    fetchedAt: payload?.fetchedAt || payload?.meta?.fetchedAt || null,
  };
}

function getOverviewEntry(payload, path) {
  let current = payload?.markets || payload || {};
  for (const key of path) current = current?.[key];
  return current || null;
}

export function normalizeSpxLiveWorkbench(workbench, baseEntry = null) {
  const snapshotType = normalizeStatus(workbench?.venue?.snapshotType || workbench?.snapshotType);
  const source = normalizeStatus(workbench?.venue?.source || workbench?.source);
  const freshnessStatus = normalizeStatus(workbench?.freshness?.status || workbench?.venue?.freshness?.status);
  const forbiddenLiveMetadata = /(cache|mock|seed|fallback|stale|unavailable|offline|historical|settled|synthetic|inferred)/;
  if (
    workbench?.ok !== true ||
    workbench?.historicalOnly === true ||
    workbench?.policy?.historicalOnly === true ||
    snapshotType !== 'direct_venue' ||
    forbiddenLiveMetadata.test(source) ||
    forbiddenLiveMetadata.test(freshnessStatus) ||
    !Array.isArray(workbench.markets)
  ) return null;

  const validPair = (bid, ask) => (
    bid != null &&
    ask != null &&
    bid >= 0 &&
    ask <= 1 &&
    ask >= bid
  );
  const lines = workbench.markets
    .map((market) => {
      const sortValue = finite(market?.threshold);
      const yesBid = finite(market?.yesBid ?? market?.yes_bid);
      const yesAsk = finite(market?.yesAsk ?? market?.yes_ask);
      const noBid = finite(market?.noBid ?? market?.no_bid);
      const noAsk = finite(market?.noAsk ?? market?.no_ask);
      if (!market?.ticker || sortValue == null) return null;
      return {
        ticker: market.ticker,
        label: `Above ${formatNumber(sortValue, { maximumFractionDigits: Math.abs(sortValue % 1) > 0 ? 2 : 0 })}`,
        sortValue,
        yesBid: validPair(yesBid, yesAsk) ? yesBid : null,
        yesAsk: validPair(yesBid, yesAsk) ? yesAsk : null,
        noBid: validPair(noBid, noAsk) ? noBid : null,
        noAsk: validPair(noBid, noAsk) ? noAsk : null,
        volume24h: finite(market?.volume24h ?? market?.volume_24h) ?? 0,
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.sortValue - right.sortValue);
  if (!lines.length || lines.every((line) => (
    line.yesBid == null && line.yesAsk == null && line.noBid == null && line.noAsk == null
  ))) return null;

  const representative = [...lines].sort((left, right) => right.volume24h - left.volume24h)[0];
  const baseSummary = baseEntry?.summary || baseEntry?.data || null;
  const baseIsHistorical = baseEntry?.status === 'historical' || baseSummary?.historicalOnly === true;
  const inheritedLiveContext = !baseIsHistorical && baseSummary
    ? {
      chart: baseSummary.chart || null,
      reference: baseSummary.reference || null,
      signal: baseSummary.signal || null,
      selection: baseSummary.selection || null,
    }
    : {};

  return {
    status: 'available',
    summary: {
      seriesTicker: workbench.seriesTicker || baseSummary?.seriesTicker || 'KXINXU',
      eventTicker: workbench.event?.ticker || baseSummary?.eventTicker || null,
      eventTitle: workbench.event?.title || baseSummary?.eventTitle || 'S&P 500 cash close',
      marketTicker: representative.ticker,
      marketTitle: representative.label,
      closeTime: workbench.event?.closeTime || baseSummary?.closeTime || null,
      yesBid: representative.yesBid,
      yesAsk: representative.yesAsk,
      noBid: representative.noBid,
      noAsk: representative.noAsk,
      volume24h: finite(workbench.venue?.volume24h) ?? 0,
      volumeTotal: finite(workbench.venue?.volumeTotal) ?? 0,
      openInterest: finite(workbench.venue?.openInterest) ?? 0,
      lines,
      lineCount: lines.length,
      freshness: {
        status: 'direct_snapshot',
        fetchedAt: workbench.fetchedAt || null,
        updatedAt: workbench.venue?.updatedAt || null,
        snapshotType: workbench.venue?.snapshotType || 'direct_venue',
      },
      source: workbench.venue?.source || 'kalshi_trade_api_v2',
      historicalOnly: false,
      executable: false,
      ...inheritedLiveContext,
    },
  };
}

export function normalizeSpxCoverSnapshot(snapshot, contextEntry = null, now = Date.now()) {
  const mode = normalizeStatus(snapshot?.mode);
  const venue = snapshot?.venue || {};
  const source = normalizeStatus(venue.source || snapshot?.source);
  const snapshotType = normalizeStatus(venue.snapshotType || snapshot?.snapshotType);
  const forbidden = /(cache|mock|seed|fallback|stale|unavailable|offline|historical|settled|synthetic|inferred)/;
  const fetchedAt = firstValue(snapshot?.fetchedAt, venue.fetchedAt);
  const fetchedAtMs = Date.parse(fetchedAt || '');
  const liveFresh = mode === 'live' && Number.isFinite(fetchedAtMs) && (
    now - fetchedAtMs >= -5000 && now - fetchedAtMs < SPX_LIVE_SNAPSHOT_MAX_AGE_MS
  );
  const liveMetadataValid = (
    snapshot?.ok === true &&
    mode === 'live' &&
    snapshotType === 'direct_venue' &&
    source === 'kalshi_trade_api_v2' &&
    snapshot?.historicalOnly !== true &&
    snapshot?.executable !== true &&
    snapshot?.policy?.researchOnly === true &&
    liveFresh &&
    !forbidden.test(source) &&
    !forbidden.test(normalizeStatus(snapshot?.freshness?.status))
  );
  const closedMetadataValid = (
    snapshot?.ok === true &&
    mode === 'closed' &&
    snapshotType === 'historical_quote_close' &&
    source === 'kalshi_trade_api_v2' &&
    snapshot?.historicalOnly === true &&
    snapshot?.executable === false &&
    snapshot?.policy?.historicalOnly === true &&
    Number.isFinite(Date.parse(venue.quoteAsOf || snapshot?.event?.closeTime)) &&
    !forbidden.test(source)
  );
  const metadataValid = liveMetadataValid || closedMetadataValid;
  const rawMarkets = Array.isArray(snapshot?.markets) ? snapshot.markets : [];
  const lines = rawMarkets.map((market) => {
    const threshold = finite(market?.threshold);
    const yesBid = finite(market?.yesBid ?? market?.yes_bid);
    const yesAsk = finite(market?.yesAsk ?? market?.yes_ask);
    const noBid = finite(market?.noBid ?? market?.no_bid);
    const noAsk = finite(market?.noAsk ?? market?.no_ask);
    const validPair = (bid, ask) => (
      bid != null && ask != null && bid >= 0 && ask <= 1 && ask >= bid
    );
    const derivedFields = Array.isArray(market?.nativeBook?.derivedFields)
      ? market.nativeBook.derivedFields
      : [];
    const liveLineValid = (
      liveMetadataValid &&
      market?.nativeBook?.complete === true &&
      derivedFields.length === 0 &&
      validPair(yesBid, yesAsk) &&
      validPair(noBid, noAsk)
    );
    const closedLineValid = (
      closedMetadataValid &&
      market?.nativeBook?.complete === true &&
      derivedFields.includes('noBid') &&
      derivedFields.includes('noAsk') &&
      validPair(yesBid, yesAsk) &&
      validPair(noBid, noAsk)
    );
    if (!market?.ticker || threshold == null || (!liveLineValid && !closedLineValid)) return null;
    return {
      ticker: market.ticker,
      label: `Above ${formatNumber(threshold, { maximumFractionDigits: Math.abs(threshold % 1) > 0 ? 2 : 0 })}`,
      sortValue: threshold,
      yesBid,
      yesAsk,
      noBid,
      noAsk,
      volume24h: finite(market?.volume24h ?? market?.volume_24h) ?? 0,
    };
  }).filter(Boolean).sort((left, right) => left.sortValue - right.sortValue);
  const expectedMarketCount = finite(snapshot?.event?.totalMarketCount);
  const completeLadder = metadataValid && lines.length > 0 && (
    expectedMarketCount == null || lines.length === expectedMarketCount
  );
  const baseSummary = contextEntry?.summary || contextEntry?.data || null;
  const context = baseSummary
    ? {
      chart: baseSummary.chart || null,
      reference: baseSummary.reference || null,
      signal: baseSummary.signal || null,
      selection: baseSummary.selection || null,
    }
    : {};
  if (!completeLadder) {
    return {
      status: 'unavailable',
      mode: 'unavailable',
      summary: null,
      error: snapshot?.error || 'No verified SPX quote ladder is available.',
      ...context,
    };
  }
  const quoteState = mode === 'closed' ? 'closed' : 'live';
  return {
    status: 'available',
    mode,
    summary: {
      seriesTicker: snapshot.seriesTicker || 'KXINXU',
      eventTicker: snapshot.event?.ticker || null,
      eventTitle: snapshot.event?.title || 'S&P 500 cash close',
      marketTicker: lines[Math.floor(lines.length / 2)]?.ticker || lines[0]?.ticker || null,
      marketTitle: lines[Math.floor(lines.length / 2)]?.label || lines[0]?.label || null,
      closeTime: snapshot.event?.closeTime || null,
      lines,
      lineCount: lines.length,
      freshness: {
        status: quoteState === 'live' ? 'direct_snapshot' : 'historical_close',
        fetchedAt,
        updatedAt: firstValue(venue.quoteAsOf, venue.fetchedAt, snapshot.event?.closeTime),
        snapshotType,
      },
      source,
      executable: false,
      historicalOnly: false,
      quoteState,
      mode,
      availableOnBrokers: snapshot.event?.availableOnBrokers === true,
      quoteAsOf: venue.quoteAsOf || null,
      ...context,
    },
  };
}

export function normalizeSummary(entry) {
  const summary = entry?.summary || entry?.data || entry;
  const seriesTicker = summary?.seriesTicker || null;
  const status = normalizeStatus(entry?.status || summary?.status);
  const freshnessStatus = normalizeStatus(summary?.freshness?.status || summary?.freshness);
  const source = normalizeStatus(summary?.source || summary?.provider || summary?.sourceApi);
  const unavailable = /(unavailable|error|offline|stale|cache|mock|seed|fallback|failed)/;
  const lines = (Array.isArray(summary?.lines) ? summary.lines : []).map((line) => {
    const rawYesBid = finite(line?.yesBid ?? line?.yes_bid);
    const rawYesAsk = finite(line?.yesAsk ?? line?.yes_ask);
    const rawNoBid = finite(line?.noBid ?? line?.no_bid);
    const rawNoAsk = finite(line?.noAsk ?? line?.no_ask);
    const validPair = (bid, ask) => (
      bid != null &&
      ask != null &&
      bid >= 0 &&
      ask <= 1 &&
      ask >= bid
    );
    const yesPairValid = validPair(rawYesBid, rawYesAsk);
    const noPairValid = validPair(rawNoBid, rawNoAsk);
    const sortValue = finite(line?.sortValue);
    const volume24h = finite(line?.volume24h);
    if (!line?.label) return null;
    return {
      ticker: line.ticker || null,
      label: formatContractLabel(line.label, seriesTicker),
      yesBid: yesPairValid ? rawYesBid : null,
      yesAsk: yesPairValid ? rawYesAsk : null,
      noBid: noPairValid ? rawNoBid : null,
      noAsk: noPairValid ? rawNoAsk : null,
      sortValue,
      volume24h,
      settlementResult: line.settlementResult ? String(line.settlementResult).toUpperCase() : null,
      settlementValue: finite(line.settlementValue),
    };
  }).filter(Boolean);
  const historicalOnly = summary?.historicalOnly === true || status === 'historical';
  const available = Boolean(summary) &&
    lines.length > 0 &&
    !unavailable.test(status) &&
    !unavailable.test(freshnessStatus) &&
    !unavailable.test(source) &&
    summary?._cache?.stale !== true;
  if (!available) {
    return {
      available: false,
      seriesTicker,
      eventTicker: summary?.eventTicker || null,
      eventTitle: summary?.eventTitle || null,
      identity: firstValue(summary?.eventTicker, summary?.seriesTicker, entry?.code, null),
      message: entry?.error || entry?.message || 'No verified current lines are available.',
      signal: summary?.signal || null,
      chart: summary?.chart || entry?.chart || null,
      reference: summary?.reference || entry?.reference || null,
      venue: summary?.venue || null,
      source: summary?.source || null,
      historicalOnly,
      quoteState: summary?.quoteState || null,
      mode: summary?.mode || null,
    };
  }

  return {
    available: true,
    seriesTicker,
    eventTicker: summary.eventTicker || null,
    eventTitle: summary.eventTitle || null,
    identity: [
      summary.seriesTicker,
      summary.eventTicker,
    ].filter(Boolean).join('|') || summary.marketTicker || lines[0]?.ticker || null,
    yesBid: finite(summary.yesBid ?? summary.yes_bid),
    yesAsk: finite(summary.yesAsk ?? summary.yes_ask),
    lines,
    lineCount: finite(summary.lineCount) ?? lines.length,
    checkedAt: firstValue(summary.freshness?.fetchedAt, summary.fetchedAt, entry?.fetchedAt),
    signal: summary.signal || null,
    chart: summary.chart || null,
    reference: summary.reference || null,
    selection: summary.selection || null,
    venue: summary.venue || null,
    source: summary.source || null,
    historicalOnly,
    historicalLabel: summary.historicalLabel || null,
    settlementTime: summary.settlementTime || null,
    quoteState: summary.quoteState || null,
    mode: summary.mode || null,
    availableOnBrokers: summary.availableOnBrokers === true,
    quoteAsOf: summary.quoteAsOf || null,
  };
}

export function getWtiContractPresentation(seriesTicker) {
  const normalized = String(seriesTicker || '').trim().toUpperCase();
  if (normalized === 'KXWTI') {
    return {
      seriesTicker: normalized,
      cadence: 'daily',
      geometry: 'threshold',
      columnLabel: 'Above threshold',
    };
  }
  if (normalized === 'KXWTIW') {
    return {
      seriesTicker: normalized,
      cadence: 'weekly',
      geometry: 'band',
      label: 'Weekly mutually exclusive price bands',
      explanation: 'A different Kalshi series from WTI Oil on Day',
      columnLabel: 'Settlement band',
    };
  }
  return null;
}

const SIGNAL_PROVENANCE_FORBIDDEN = /(unavailable|error|offline|stale|cache|mock|seed|fallback|failed|synthetic|inferred)/;

const signalText = (value) => {
  const text = String(value || '').trim();
  return text || null;
};

const validSignalDate = (value) => {
  const text = signalText(value);
  if (!text) return null;
  const dateOnly = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) {
    const [, yearText, monthText, dayText] = dateOnly;
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    const date = new Date(Date.UTC(year, month - 1, day));
    return (
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day
    ) ? text : null;
  }
  return Number.isFinite(Date.parse(text)) ? text : null;
};

const formatSignalDate = (value) => {
  const normalized = validSignalDate(value);
  if (!normalized) return '—';
  const date = new Date(normalized);
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? 'UTC' : undefined,
  }).format(date);
};

export function getSummarySignalProvenance(summary = {}) {
  const signal = summary?.signal || {};
  const details = signal?.details || {};
  const status = normalizeStatus(signal.status);
  const product = signalText(firstValue(
    signal.product,
    signal.sourceProduct,
    signal.name,
    details.product,
    details.sourceProduct,
  ));
  const source = signalText(firstValue(signal.source, details.source));
  const sourceDate = [details.date, signal.asOf]
    .map(validSignalDate)
    .find(Boolean) || null;
  const instrument = signalText(firstValue(details.ticker, signal.ticker));
  const requiredDate = validSignalDate(signal.requiredDate);
  const freshnessStatus = normalizeStatus(signal?.freshness?.status || signal.freshness);
  const unsafeMetadata = [source, product, freshnessStatus]
    .filter(Boolean)
    .some((value) => SIGNAL_PROVENANCE_FORBIDDEN.test(normalizeStatus(value)));
  const verified = (
    status === 'available' &&
    Boolean(product) &&
    Boolean(source) &&
    Boolean(sourceDate) &&
    signal?.stale !== true &&
    signal?._cache?.stale !== true &&
    !unsafeMetadata
  );

  return {
    verified,
    product: verified ? product : null,
    source: verified ? source : null,
    sourceDate: verified ? sourceDate : null,
    instrument: verified ? instrument : null,
    requiredDate: verified ? requiredDate : null,
    reason: signalText(signal.reason) || (
      verified
        ? null
        : 'No verified source publication metadata is available for this signal.'
    ),
  };
}

function getSummarySignalRecord(summary, signalType) {
  const provenance = getSummarySignalProvenance(summary);
  if (!provenance.verified) return { direction: null, field: null, provenance };
  const details = summary?.signal?.details || {};
  const fields = signalType === 'trade'
    ? [
      ['trade', details.trade],
      ['tradeSignal', details.tradeSignal],
      ['trackerTrade', details.trackerTrade],
      ['publishedTrade', details.publishedTrade],
      ['trackerTrend', details.trackerTrend],
    ]
    : [
      ['trend', details.trend],
      ['riskTrend', details.riskTrend],
    ];
  const published = fields
    .map(([field, value]) => ({ field, direction: normalizeDirectionalStatus(value) }))
    .find((candidate) => candidate.direction);
  return {
    direction: published?.direction || null,
    field: published?.field || null,
    provenance,
  };
}

const SIGNAL_FIELD_LABELS = Object.freeze({
  trade: 'Trade',
  tradeSignal: 'Trade signal',
  trackerTrade: 'Tracker trade',
  publishedTrade: 'Published trade',
  trackerTrend: 'Tracker trend',
  trend: 'Trend',
  riskTrend: 'Risk trend',
});

function SummarySignalIndicator({ title, summary, signalType }) {
  const surfaceActive = useSurfaceActivity();
  const triggerRef = useRef(null);
  const popoverRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState(null);
  const { direction, field, provenance } = getSummarySignalRecord(summary, signalType);
  const label = direction || 'UNAVAILABLE';
  const tone = direction ? direction.toLowerCase() : 'unavailable';
  const labelText = signalType === 'trade' ? 'TRADE:' : 'TREND:';
  const signalName = signalType === 'trade' ? 'Trade' : 'Trend';
  const provenanceKey = [
    provenance.verified,
    provenance.product,
    provenance.source,
    provenance.sourceDate,
    provenance.instrument,
    provenance.requiredDate,
    provenance.reason,
    direction,
    field,
  ].join('|');
  const idBase = `${title}-${signalType}`.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const popoverId = `pm-hub-${idBase}-source`;
  const popoverTitleId = `${popoverId}-title`;

  const closePopover = useCallback(({ restoreFocus = false } = {}) => {
    setOpen(false);
    setPosition(null);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  const updatePosition = useCallback(() => {
    if (!triggerRef.current || !popoverRef.current || typeof window === 'undefined') return;
    const triggerRect = triggerRef.current.getBoundingClientRect();
    const popoverRect = popoverRef.current.getBoundingClientRect();
    const margin = 12;
    const gap = 7;
    const width = popoverRect.width || Math.min(278, window.innerWidth - (margin * 2));
    const height = popoverRect.height || 240;
    const maxLeft = Math.max(margin, window.innerWidth - width - margin);
    const centeredLeft = triggerRect.left + (triggerRect.width / 2) - (width / 2);
    const left = Math.min(Math.max(margin, centeredLeft), maxLeft);
    const belowTop = triggerRect.bottom + gap;
    const top = belowTop + height <= window.innerHeight - margin
      ? belowTop
      : Math.max(margin, triggerRect.top - height - gap);
    setPosition({ left, top });
  }, []);

  useLayoutEffect(() => {
    if (!surfaceActive || !open) return;
    updatePosition();
  }, [open, provenanceKey, surfaceActive, updatePosition]);

  useEffect(() => {
    if (surfaceActive || !open) return;
    closePopover();
  }, [closePopover, open, surfaceActive]);

  useEffect(() => {
    if (!surfaceActive || !open) return undefined;
    const handlePointerDown = (event) => {
      if (triggerRef.current?.contains(event.target) || popoverRef.current?.contains(event.target)) return;
      closePopover();
    };
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') closePopover({ restoreFocus: true });
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [closePopover, open, surfaceActive, updatePosition]);

  const provenancePopover = surfaceActive && open && typeof document !== 'undefined'
    ? createPortal(
      <section
        ref={popoverRef}
        id={popoverId}
        className="pm-hub-signal-popover"
        data-tone={tone}
        role="dialog"
        aria-modal="false"
        aria-labelledby={popoverTitleId}
        style={{
          left: position?.left ?? 0,
          top: position?.top ?? 0,
          visibility: position ? 'visible' : 'hidden',
        }}
      >
        <header className="pm-hub-signal-popover-header">
          <div>
            <span>{title}</span>
            <h3 id={popoverTitleId}>{signalName} source</h3>
          </div>
          <button
            type="button"
            aria-label={`Close ${title} ${signalType} signal source`}
            onClick={() => closePopover({ restoreFocus: true })}
          >
            <span aria-hidden="true">×</span>
          </button>
        </header>
        <div className="pm-hub-signal-popover-state">
          <span aria-hidden="true" />
          <div>
            <small>Signal value</small>
            <strong>{label}</strong>
          </div>
        </div>
        {provenance.verified ? (
          <>
            <dl className="pm-hub-signal-popover-details">
              <div><dt>Product</dt><dd>{provenance.product}</dd></div>
              <div>
                <dt>Source date</dt>
                <dd><time dateTime={provenance.sourceDate}>{formatSignalDate(provenance.sourceDate)}</time></dd>
              </div>
              {provenance.requiredDate && provenance.requiredDate !== provenance.sourceDate ? (
                <div>
                  <dt>Market date</dt>
                  <dd><time dateTime={provenance.requiredDate}>{formatSignalDate(provenance.requiredDate)}</time></dd>
                </div>
              ) : null}
              {provenance.instrument ? <div><dt>Instrument</dt><dd>{provenance.instrument}</dd></div> : null}
              <div><dt>Source</dt><dd>{provenance.source}</dd></div>
              {field ? <div><dt>Published field</dt><dd>{SIGNAL_FIELD_LABELS[field] || field}</dd></div> : null}
            </dl>
            {!direction ? (
              <p className="pm-hub-signal-popover-note">
                This verified product record does not publish a {signalName.toLowerCase()} value.
              </p>
            ) : null}
          </>
        ) : (
          <p className="pm-hub-signal-popover-note unavailable">
            {provenance.reason}
          </p>
        )}
      </section>,
      document.body,
    )
    : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="pm-hub-summary-signal"
        aria-label={`${title} ${signalType} signal`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        title={`Show ${signalName.toLowerCase()} source date and product`}
        onClick={() => {
          if (!open) setPosition(null);
          setOpen((current) => !current);
        }}
      >
        <span className="pm-hub-summary-signal-label">{labelText}</span>
        <span className={`pm-hub-summary-signal-pill ${tone}`}>
          {label}
          <span className="pm-hub-summary-signal-disclosure" aria-hidden="true">▾</span>
        </span>
      </button>
      {provenancePopover}
    </>
  );
}

function SummarySignalIndicators({ title, summary, tickReading }) {
  return (
    <span className="pm-hub-summary-signals" aria-label={`${title} signals`}>
      {tickReading?.verified === true && tickReading.tickEvidence && (
        <span aria-label={`${title} tick signal`}>
          <DashboardResearchLabel label={title} reading={tickReading} showName={false} />
        </span>
      )}
      <SummarySignalIndicator title={title} summary={summary} signalType="trade" />
      <SummarySignalIndicator title={title} summary={summary} signalType="trend" />
    </span>
  );
}

function ReferenceMarker({ reference, historical = false, listItem = false }) {
  const value = finite(reference?.value);
  if (normalizeStatus(reference?.status) !== 'available' || value == null) return null;
  const forecast = reference.kind === 'forecast';
  const underlyingTone = normalizeStatus(reference?.tone) === 'close' ? 'close' : 'spot';
  const formattedValue = formatReferenceValue(reference);
  const quoteState = referenceQuoteState(reference);
  const centerMarker = !forecast || normalizeStatus(reference?.tone) === 'base';
  const prefix = forecast ? reference.label : '';
  const accessibleLabel = `${prefix} ${formattedValue}`.trim();
  const layoutClass = forecast
    ? 'pm-hub-reference-row'
    : 'pm-hub-current-price-row pm-hub-current-price-separator';
  return (
    <div
      className={`${layoutClass} pm-hub-reference-marker ${forecast ? `forecast ${reference.tone || 'base'}` : `underlying ${underlyingTone}`} ${historical || reference.historicalOnly ? 'historical' : ''} ${historical ? 'historical-layout' : ''}`}
      data-center-marker={centerMarker ? 'true' : undefined}
      data-reference-state={quoteState?.tone || undefined}
      role={listItem ? 'listitem' : undefined}
    >
      {!forecast ? <span className="pm-hub-current-price-line" aria-hidden="true" /> : null}
      <strong aria-label={accessibleLabel}>
        <span className="pm-hub-reference-prefix" aria-hidden="true">{prefix}</span>
        <span className="pm-hub-reference-value" aria-hidden="true">{formattedValue}</span>
      </strong>
    </div>
  );
}

export function centerPredictionContractList(scroller) {
  if (!scroller || scroller.clientHeight <= 0) return false;
  const marker = scroller.querySelector('[data-center-marker="true"]');
  if (!marker) return false;
  const scrollerRect = scroller.getBoundingClientRect();
  const markerRect = marker.getBoundingClientRect();
  const markerTop = markerRect.top - scrollerRect.top + scroller.scrollTop;
  const centeredTop = markerTop - ((scroller.clientHeight - markerRect.height) / 2);
  const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  scroller.scrollTop = Math.max(0, Math.min(centeredTop, maxScrollTop));
  return true;
}

function lineReferences(summary) {
  const scenarios = normalizeStatus(summary.signal?.status) === 'available' &&
    Array.isArray(summary.signal?.details?.scenarios)
    ? summary.signal.details.scenarios
      .map((scenario) => {
        const value = finite(scenario?.value);
        if (value == null) return null;
        const key = String(scenario?.key || scenario?.label || '').trim().toLowerCase();
        const tone = key === 'upside' || key === 'high'
          ? 'high'
          : key === 'downside' || key === 'low'
            ? 'low'
            : 'base';
        return {
          status: 'available',
          kind: 'forecast',
          label: tone === 'high' ? 'High' : tone === 'low' ? 'Low' : 'Base',
          tone,
          value,
        };
      })
      .filter(Boolean)
    : [];

  if (scenarios.length > 0) return scenarios;
  return normalizeStatus(summary.reference?.status) === 'available' &&
    finite(summary.reference?.value) != null
    ? [summary.reference]
    : [];
}

function verifiedChartReference(summary) {
  const reference = summary?.reference;
  if (normalizeStatus(reference?.status) === 'available' && finite(reference?.value) != null) {
    return reference;
  }

  const chart = summary?.chart?.variants?.['1d'] || summary?.chart;
  const status = normalizeStatus(chart?.status);
  const source = normalizeStatus(chart?.source);
  const availability = normalizeStatus(chart?.availability);
  if (
    normalizeStatus(chart?.kind) !== 'underlying' ||
    status !== 'available' ||
    source !== 'ibkr_historical_bars' ||
    !['current', 'historical'].includes(availability)
  ) return null;

  const points = (Array.isArray(chart?.points) ? chart.points : [])
    .map((point) => ({
      timestamp: finite(point?.timestamp),
      value: finite(point?.value ?? point?.close),
    }))
    .filter((point) => point.timestamp != null && point.value != null && point.value > 0)
    .sort((left, right) => left.timestamp - right.timestamp);
  const latestPoint = points[points.length - 1];
  if (!latestPoint) return null;

  return {
    status: 'available',
    kind: 'underlying',
    label: chart.label || 'Underlying price',
    displayFormat: chart.unit === 'index'
      ? 'spx_contract'
      : chart.unit === 'usd'
        ? 'wti_contract'
        : undefined,
    tone: availability === 'historical' ? 'close' : 'spot',
    value: latestPoint.value,
    source,
    asOf: chart.latestAt || new Date(latestPoint.timestamp).toISOString(),
    availability,
    historicalOnly: availability === 'historical',
  };
}

function ScrollbarReferenceMarker({ scrollRef, reference }) {
  const [position, setPosition] = useState(null);
  const referenceKey = reference
    ? `${reference.kind}|${reference.tone || ''}|${reference.value}`
    : 'none';

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const marker = scroller?.querySelector('[data-center-marker="true"]');
    if (!scroller || !marker) {
      setPosition(null);
      return undefined;
    }

    const updatePosition = () => {
      const scrollerRect = scroller.getBoundingClientRect();
      const markerRect = marker.getBoundingClientRect();
      const markerTop = markerRect.top - scrollerRect.top + scroller.scrollTop;
      const contentHeight = Math.max(scroller.scrollHeight, 1);
      const ratio = (markerTop + (markerRect.height / 2)) / contentHeight;
      setPosition(Math.max(0, Math.min(1, ratio)));
    };

    updatePosition();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(updatePosition);
    observer.observe(scroller);
    observer.observe(marker);
    return () => observer.disconnect();
  }, [referenceKey, scrollRef]);

  if (position == null) return null;
  const formattedValue = reference?.kind === 'underlying'
    ? formatReferenceValue(reference)
    : null;
  return (
    <span
      className="pm-hub-scroll-reference-marker"
      aria-hidden="true"
      style={{ top: `${position * 100}%` }}
    >
      {formattedValue ? <span className="pm-hub-scroll-reference-value">{formattedValue}</span> : null}
    </span>
  );
}

function WtiContractStructure({ presentation, onShowDaily }) {
  if (!presentation || presentation.cadence !== 'weekly') return null;
  return (
    <div
      className={`pm-hub-wti-contract-structure ${presentation.geometry}`}
      aria-label={`${presentation.seriesTicker} contract structure`}
    >
      <strong>{presentation.seriesTicker}</strong>
      <span>{presentation.label}</span>
      <small>{presentation.explanation}</small>
      {onShowDaily ? (
        <button type="button" onClick={onShowDaily}>
          Show KXWTI “Above” lines
        </button>
      ) : null}
    </div>
  );
}

function LinesTable({ summary, quoteOnly = false, contractPresentation = null, onShowDailyWti = null }) {
  const scrollRef = useRef(null);
  const historicalLayout = summary.historicalOnly && !quoteOnly;
  const resolvedReference = verifiedChartReference(summary);
  const references = summary.available
    ? historicalLayout
      ? (resolvedReference ? [resolvedReference] : [])
      : lineReferences({ ...summary, reference: resolvedReference })
    : [];
  const centerReference = references.find((reference) => (
    reference.kind !== 'forecast' || normalizeStatus(reference.tone) === 'base'
  )) || null;
  const centerReferenceKey = centerReference
    ? `${centerReference.kind}|${centerReference.tone || ''}|${centerReference.value}`
    : null;

  useLayoutEffect(() => {
    if (!summary.available || !centerReferenceKey) return undefined;

    const scroller = scrollRef.current;
    if (!scroller) return undefined;
    let secondFrame = null;
    const center = () => centerPredictionContractList(scroller);
    center();
    const firstFrame = requestAnimationFrame(() => {
      center();
      secondFrame = requestAnimationFrame(center);
    });
    const observer = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(center);
    observer?.observe(scroller);
    const marker = scroller.querySelector('[data-center-marker="true"]');
    if (marker) observer?.observe(marker);

    return () => {
      cancelAnimationFrame(firstFrame);
      if (secondFrame != null) cancelAnimationFrame(secondFrame);
      observer?.disconnect();
    };
  }, [centerReferenceKey, summary.available, summary.identity]);

  if (!summary.available) {
    return (
      <div className="pm-hub-lines">
        <WtiContractStructure
          presentation={contractPresentation}
          onShowDaily={onShowDailyWti}
        />
        {quoteOnly && (
          <div className="pm-hub-lines-heading">
            <span>Line</span>
            <span className="pm-hub-quote-cell yes yes-start">YES bid</span>
            <span className="pm-hub-quote-cell yes yes-end">YES ask</span>
            <span className="pm-hub-quote-cell no no-start">NO bid</span>
            <span className="pm-hub-quote-cell no no-end">NO ask</span>
            <span>24h vol</span>
          </div>
        )}
        <ReferenceMarker reference={resolvedReference} historical={historicalLayout} />
        <div className="pm-hub-local-unavailable">{summary.message}</div>
      </div>
    );
  }
  const displayRows = [
    ...summary.lines.map((line, index) => ({
      type: 'market',
      key: line.ticker || line.label,
      value: line.sortValue ?? (index === 0 ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY),
      order: index,
      line,
    })),
    ...references.map((reference, index) => ({
      type: 'reference',
      key: `${reference.label}-${reference.value}`,
      value: finite(reference.value),
      order: index,
      reference,
    })),
  ].sort((left, right) => {
    if (left.value == null && right.value == null) return left.order - right.order;
    if (left.value == null) return 1;
    if (right.value == null) return -1;
    if (left.value !== right.value) return left.value - right.value;
    // Put a reference marker immediately before the contract at the same
    // threshold so the marker reads as its own row (e.g. Above 3.3%, Low
    // 3.4%, Above 3.4%).
    if (left.type !== right.type) return left.type === 'reference' ? -1 : 1;
    return left.order - right.order;
  });

  return (
    <div className="pm-hub-lines">
      {!historicalLayout ? (
        <WtiContractStructure
          presentation={contractPresentation}
          onShowDaily={onShowDailyWti}
        />
      ) : null}
      <div className={`pm-hub-lines-heading ${historicalLayout ? 'historical' : ''}`}>
        {historicalLayout ? (
          <>
            <span>{summary.historicalLabel || 'Previous contract · settled'}</span>
            <span>Outcome</span>
            <span>Close</span>
          </>
        ) : (
          <>
            <span>{contractPresentation?.columnLabel || 'Current line'}</span>
            <span className="pm-hub-quote-cell yes yes-start">YES bid</span>
            <span className="pm-hub-quote-cell yes yes-end">YES ask</span>
            <span className="pm-hub-quote-cell no no-start">NO bid</span>
            <span className="pm-hub-quote-cell no no-end">NO ask</span>
            <span>24h vol</span>
          </>
        )}
      </div>
      <div className="pm-hub-lines-scroll-viewport">
        <div className="pm-hub-lines-scroll-shell">
          <div ref={scrollRef} className="pm-hub-lines-scroll" role="list" aria-label={historicalLayout ? 'Previous settled prediction contracts' : 'Available prediction contracts'}>
            {displayRows.map((row) => (
              row.type === 'reference' ? (
                <ReferenceMarker
                  key={row.key}
                  reference={row.reference}
                  historical={historicalLayout}
                  listItem
                />
              ) : historicalLayout ? (
                <div className="pm-hub-line historical" key={row.key} role="listitem">
                  <strong>{row.line.label}</strong>
                  <span className={`pm-hub-settlement-result ${row.line.settlementResult === 'YES' ? 'yes' : row.line.settlementResult === 'NO' ? 'no' : ''}`}>
                    {row.line.settlementResult || '—'}
                  </span>
                  <span className="pm-hub-settlement-value">
                    {row.line.settlementValue == null ? '—' : formatNumber(row.line.settlementValue, { maximumFractionDigits: 0 })}
                  </span>
                </div>
              ) : (
                <div className="pm-hub-line" key={row.key} role="listitem">
                  <strong>{row.line.label}</strong>
                  <span className="pm-hub-quote-cell yes yes-start">{formatPrice(row.line.yesBid)}</span>
                  <span className="pm-hub-quote-cell yes yes-end">{formatPrice(row.line.yesAsk)}</span>
                  <span className="pm-hub-quote-cell no no-start">{formatPrice(row.line.noBid)}</span>
                  <span className="pm-hub-quote-cell no no-end">{formatPrice(row.line.noAsk)}</span>
                  <span className="pm-hub-volume">{formatCompactNumber(row.line.volume24h)}</span>
                </div>
              )
            ))}
          </div>
          <div className="pm-hub-scroll-reference-rail" aria-hidden="true">
            <ScrollbarReferenceMarker scrollRef={scrollRef} reference={centerReference} />
          </div>
        </div>
      </div>
    </div>
  );
}

function ChartTooltip({ active, payload, chart = {} }) {
  if (!active || !payload?.length) return null;
  const point = payload[0].payload;
  const multiDayUnderlying = chart.kind === 'underlying' && chart.range === '5d';
  const value = point.value ?? point.close;
  const label = chart.kind === 'forecast'
    ? new Date(point.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : multiDayUnderlying
      ? new Date(point.timestamp).toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    : new Date(point.timestamp).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return (
    <div className="pm-hub-chart-tooltip">
      <span>{label}</span>
      <strong>{chart.kind ? formatChartValue(value, chart) : formatPrice(value)}</strong>
    </div>
  );
}

function ChartEndpointLabel({
  viewBox,
  value,
  xOffset = 5,
  yOffset = -4,
  trailingValue = null,
  trailingColor = '#dc2626',
}) {
  const x = finite(viewBox?.x);
  const y = finite(viewBox?.y);
  if (x == null || y == null) return null;
  return (
    <text
      x={x + xOffset}
      y={y + yOffset}
      fill="#2563eb"
      fontSize={8}
      fontWeight={700}
      textAnchor="start"
      dominantBaseline="middle"
    >
      <tspan fill="#2563eb">{value}</tspan>
      {trailingValue != null && (
        <>
          <tspan fill="#64748b">, </tspan>
          <tspan fill={trailingColor}>{trailingValue}</tspan>
        </>
      )}
    </text>
  );
}

function SummaryQuoteStack({ contractValue = null, reference = null, historicalOnly = false }) {
  const contract = !historicalOnly ? finite(contractValue) : null;
  const referenceState = referenceQuoteState(reference);
  const referenceValue = referenceState ? formatReferenceValue(reference) : null;
  if (contract == null && referenceValue == null) return null;

  return (
    <div className="pm-hub-chart-quotes" aria-label="Market price status">
      <strong className={contract != null ? 'live' : referenceState?.tone || ''}>
        {contract != null ? formatPrice(contract) : referenceValue}
      </strong>
    </div>
  );
}

function UnderlyingPriceChart({ chart, reference }) {
  const status = normalizeStatus(chart?.status);
  const source = normalizeStatus(chart?.source);
  const forbidden = /(unavailable|error|offline|stale|cache|mock|seed|fallback|failed)/;
  const points = (Array.isArray(chart?.points) ? chart.points : [])
    .map((point) => ({
      timestamp: finite(point?.timestamp),
      value: finite(point?.value ?? point?.close),
    }))
    .filter((point) => point.timestamp != null && point.value != null && point.value > 0);
  const references = (Array.isArray(chart?.references) ? chart.references : [])
    .map((item) => ({
      ...item,
      value: finite(item?.value),
    }))
    .filter((item) => item.value != null);
  const chartReferences = references.map((item) => ({
    ...item,
    value: chartReferenceValue(item.value, chart),
  }));
  const dailyReferenceSegments = (Array.isArray(chart?.dailyRanges) ? chart.dailyRanges : [])
    .flatMap((range) => (Array.isArray(range?.references) ? range.references : []).map((item) => ({
      ...item,
      date: range.date || null,
      startAt: finite(range.startAt),
      endAt: finite(range.endAt),
      value: chartReferenceValue(item?.value, chart),
    })))
    .filter((item) => (
      item.value != null &&
      item.startAt != null &&
      item.endAt != null &&
      item.endAt >= item.startAt
    ));
  const available = status === 'available' &&
    source === 'ibkr_historical_bars' &&
    !forbidden.test(status) &&
    points.length >= 2;
  const periodLabel = chart?.range === '5d'
    ? (chart?.availability === 'historical' ? 'Close 5D' : 'Live 5D')
    : (chart?.availability === 'historical' ? 'Close 24H' : 'Live 24H');
  const label = chart?.label || chart?.ticker || 'Underlying price';
  const riskRangeMissingDates = Array.isArray(chart?.riskRangeMissingDates)
    ? chart.riskRangeMissingDates
    : [];
  const riskRangeMissingLabel = riskRangeMissingDates.map((date) => {
    const parsed = new Date(`${date}T12:00:00Z`);
    return Number.isNaN(parsed.getTime())
      ? date
      : parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }).join(', ');
  const rtaRiskRangeRefresh = normalizeStatus(chart?.riskRangeSource) === 'hedgeye real-time alert';

  if (!available) {
    return (
      <div className="pm-hub-chart pm-hub-chart-unavailable">
        <div className="pm-hub-chart-meta">
          <span>{periodLabel} · {label} unavailable</span>
          <SummaryQuoteStack reference={reference} />
        </div>
        <strong>{chart?.reason || 'No current or latest completed verified underlying price history is available.'}</strong>
      </div>
    );
  }

  const multiDayLayout = buildMultiDayChartLayout(
    points,
    Array.isArray(chart?.dailyRanges) ? chart.dailyRanges : [],
  );
  const multiDay = multiDayLayout.sessions.length > 1;
  const plotPoints = multiDay ? multiDayLayout.points : points;
  const latestPoint = points[points.length - 1];
  const plotLatestPoint = multiDay ? multiDayLayout.latestPoint : latestPoint;
  const plottedReferenceSegments = multiDay
    ? dailyReferenceSegments.map((item) => {
      const session = multiDayLayout.sessions.find((candidate) => candidate.date === item.date);
      return session
        ? { ...item, startAt: session.startX, endAt: session.endX }
        : null;
    }).filter(Boolean)
    : dailyReferenceSegments;
  const riskRangeBands = multiDay
    ? multiDayLayout.sessions.flatMap((session) => buildRiskRangeThirdBands(
      plottedReferenceSegments.filter((item) => item.date === session.date),
    ).map((band) => ({
      ...band,
      key: `${session.date}-${band.key}`,
      x1: session.startX,
      x2: session.endX,
    })))
    : buildRiskRangeThirdBands(chartReferences);
  const allReferenceValues = [
    ...chartReferences.map((item) => item.value),
    ...dailyReferenceSegments.map((item) => item.value),
  ];
  const values = [...points.map((point) => point.value), ...allReferenceValues];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const padding = Math.max((max - min) * 0.16, chart.unit === 'usd' ? 0.05 : 1);
  const domain = [Math.max(0, min - padding), max + padding];
  return (
    <div className="pm-hub-chart pm-hub-chart--underlying">
      {rtaRiskRangeRefresh && (
        <div className="pm-hub-chart-note">
          SPX Risk Range refreshed by Real-Time Alert{chart?.riskRangeAsOf ? ` · ${formatDateTime(chart.riskRangeAsOf)}` : ''}
        </div>
      )}
      {chart?.riskRangeStatus === 'partial' && (
        <div className="pm-hub-chart-note">
          Daily Risk Range unavailable for {riskRangeMissingLabel || 'one or more sessions'}; price history remains verified.
        </div>
      )}
      <div
        className="pm-hub-chart-canvas"
        aria-label={`${periodLabel} chart for ${label}`}
      >
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={plotPoints} margin={{ top: 7, right: multiDay ? 50 : 44, left: 0, bottom: 0 }}>
            {riskRangeBands.map((band) => (
              <ReferenceArea
                key={band.key}
                x1={band.x1}
                x2={band.x2}
                y1={band.y1}
                y2={band.y2}
                fill={RISK_RANGE_BAND_COLORS[band.tone]}
                fillOpacity={0.62}
                stroke="none"
                ifOverflow="hidden"
              />
            ))}
            <CartesianGrid vertical={false} stroke="#dbe4ef" strokeDasharray="2 4" />
            {multiDayLayout.gaps.map((gap) => (
              <ReferenceLine
                key={`session-gap-${gap.date}`}
                x={gap.x}
                stroke="#e2e8f0"
                strokeDasharray="2 3"
              />
            ))}
            <XAxis
              type={multiDay ? 'number' : 'category'}
              dataKey={multiDay ? 'plotX' : 'timestamp'}
              domain={multiDay ? [0, multiDayLayout.maxX] : undefined}
              ticks={multiDay ? multiDayLayout.sessions.map((session) => session.tickX) : undefined}
              axisLine={false}
              tickLine={false}
              interval={multiDay ? 0 : undefined}
              minTickGap={multiDay ? 0 : 38}
              tick={{ fill: CHART_AXIS_TICK_COLOR, fontSize: 8 }}
              tickFormatter={(value) => multiDay
                ? multiDayLayout.tickLabels.get(Number(value)) || ''
                : new Date(value).toLocaleTimeString('en-US', { hour: 'numeric' })}
            />
            <YAxis
              orientation="left"
              domain={domain}
              axisLine={false}
              tickLine={false}
              tick={{ fill: CHART_AXIS_TICK_COLOR, fontSize: 8 }}
              tickFormatter={(value) => formatChartValue(value, chart)}
              width={39}
            />
            <Tooltip content={<ChartTooltip chart={chart} />} />
            {!multiDay && chartReferences.map((item) => (
              <ReferenceLine
                key={`${item.label}-${item.value}`}
                y={item.value}
                stroke={chartReferenceColor(item.tone)}
                strokeDasharray="4 4"
                label={{
                  value: formatChartValue(item.value, chart),
                  fill: chartReferenceColor(item.tone),
                  fontSize: 8,
                  fontWeight: 700,
                  position: 'right',
                  offset: 5,
                }}
              />
            ))}
            {plottedReferenceSegments.map((item) => (
              <ReferenceLine
                key={`${item.date}-${item.label}`}
                segment={[
                  { x: item.startAt, y: item.value },
                  { x: item.endAt, y: item.value },
                ]}
                stroke={chartReferenceColor(item.tone)}
                strokeDasharray="4 4"
                label={{
                  value: formatChartValue(item.value, chart),
                  fill: chartReferenceColor(item.tone),
                  fontSize: 8,
                  fontWeight: 700,
                  position: 'right',
                  offset: 5,
                }}
              />
            ))}
            <Line
              type="linear"
              dataKey="value"
              stroke="#2563eb"
              strokeWidth={1.3}
              strokeLinecap="butt"
              dot={false}
              activeDot={false}
              connectNulls={false}
              isAnimationActive={false}
            />
            <ReferenceDot
              x={plotLatestPoint.plotX ?? plotLatestPoint.timestamp}
              y={plotLatestPoint.value}
              r={0}
              fill="transparent"
              stroke="none"
              isFront
              label={(labelProps) => (
                <ChartEndpointLabel
                  viewBox={labelProps.viewBox}
                  value={formatChartValue(plotLatestPoint.value, chart)}
                />
              )}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function ForecastPriceChart({ chart, reference }) {
  const status = normalizeStatus(chart?.status);
  const source = normalizeStatus(chart?.source);
  const forbidden = /(unavailable|error|offline|stale|cache|mock|seed|fallback|failed)/;
  const points = normalizeForecastChartPoints(chart);
  const references = (Array.isArray(chart?.references) ? chart.references : [])
    .map((item) => ({
      ...item,
      value: finite(item?.value),
    }))
    .filter((item) => item.value != null);
  const chartReferences = references.map((item) => ({
    ...item,
    value: chartReferenceValue(item.value, chart),
  }));
  const available = status === 'available' &&
    source === 'cleveland_fed_inflation_nowcasting' &&
    !forbidden.test(status) &&
    points.length > 0;

  if (!available) {
    return (
      <div className="pm-hub-chart pm-hub-chart-unavailable">
        <div className="pm-hub-chart-meta">
          <span>CPI forecast · unavailable</span>
          <SummaryQuoteStack reference={reference} />
        </div>
        <strong>{chart?.reason || 'No current Cleveland Fed CPI consensus nowcast is available.'}</strong>
      </div>
    );
  }

  const values = [...points.map((point) => point.value), ...chartReferences.map((item) => item.value)];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const padding = Math.max((max - min) * 0.22, 0.08);
  const domain = [Math.max(0, min - padding), max + padding];
  const chartTicks = chart.unit === 'percent'
    ? buildPercentChartTicks(chartReferences.map((item) => item.value), domain)
    : undefined;
  const latestPoint = points[points.length - 1];
  const endpointLabelValue = latestPoint.value;
  const endpointReference = chartReferences
    .find((item) => item.value === endpointLabelValue) || null;
  return (
    <div className="pm-hub-chart pm-hub-chart--forecast">
      <div
        className="pm-hub-chart-canvas"
        aria-label="CPI consensus forecast chart"
      >
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={points} margin={{ top: 7, right: 55, left: 0, bottom: 0 }}>
            <CartesianGrid vertical={false} horizontal={false} stroke="#dbe4ef" strokeDasharray="2 4" />
            <XAxis
              dataKey="timestamp"
              axisLine={false}
              tickLine={false}
              minTickGap={38}
              tick={{ fill: CHART_AXIS_TICK_COLOR, fontSize: 8 }}
              tickFormatter={(value) => new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
            />
            <YAxis
              orientation="left"
              domain={domain}
              ticks={chartTicks}
              axisLine={false}
              tickLine={false}
              tick={{ fill: CHART_AXIS_TICK_COLOR, fontSize: 8 }}
              tickFormatter={(value) => formatChartValue(value, chart)}
              width={39}
            />
            <Tooltip content={<ChartTooltip chart={chart} />} />
            {(chartTicks || []).map((value) => (
              <ReferenceLine
                key={`grid-${value}`}
                y={value}
                stroke="#dbe4ef"
                strokeDasharray="2 4"
              />
            ))}
            {chartReferences.map((item) => (
              <ReferenceLine
                key={`${item.label}-${item.value}`}
                y={item.value}
                stroke={chartReferenceColor(item.tone)}
                strokeDasharray="4 4"
                label={endpointReference?.value === item.value ? null : {
                  value: formatChartValue(item.value, chart),
                  fill: chartReferenceColor(item.tone),
                  fontSize: 8,
                  fontWeight: 700,
                  position: 'right',
                  offset: 5,
                }}
              />
            ))}
            <Line
              type="stepAfter"
              dataKey="value"
              stroke="#2563eb"
              strokeWidth={1.5}
              strokeLinecap="butt"
              dot={false}
              activeDot={false}
              isAnimationActive={false}
            />
            <ReferenceDot
              x={latestPoint.timestamp}
              y={endpointLabelValue}
              r={0}
              fill="transparent"
              stroke="none"
              isFront
              label={(labelProps) => (
                <ChartEndpointLabel
                  viewBox={labelProps.viewBox}
                  value={formatChartValue(endpointLabelValue, chart)}
                  trailingValue={endpointReference ? formatChartValue(endpointReference.value, chart) : null}
                  trailingColor={endpointReference ? chartReferenceColor(endpointReference.tone) : undefined}
                  xOffset={5}
                  yOffset={0}
                />
              )}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function IntradayChart({ chart, summary, reference, historicalOnly = false }) {
  if (normalizeStatus(chart?.kind) === 'underlying') {
    return <UnderlyingPriceChart chart={chart} reference={reference} />;
  }
  if (normalizeStatus(chart?.kind) === 'forecast') {
    return <ForecastPriceChart chart={chart} reference={reference} />;
  }
  const snapshotQuote = summary?.available
    ? finite(summary.yesAsk ?? summary.yesBid)
    : null;
  const status = normalizeStatus(chart?.status);
  const source = normalizeStatus(chart?.source);
  const forbidden = /(unavailable|error|offline|stale|cache|mock|seed|fallback|failed)/;
  const points = (Array.isArray(chart?.points) ? chart.points : [])
    .map((point) => ({
      timestamp: finite(point?.timestamp),
      close: finite(point?.close),
    }))
    .filter((point) => (
      point.timestamp != null &&
      point.close != null &&
      point.close >= 0 &&
      point.close <= 1
    ));
  const available = status === 'available' &&
    source === 'kalshi_trade_api_v2' &&
    !forbidden.test(status) &&
    points.length > 0;

  if (historicalOnly && !available) {
    return (
      <div className="pm-hub-chart pm-hub-chart-unavailable pm-hub-history-chart">
        <div className="pm-hub-chart-meta">
          <span>Previous contract · close</span>
          <SummaryQuoteStack reference={reference} historicalOnly />
        </div>
        <strong>{chart?.reason || 'Settled contract price history is unavailable.'}</strong>
      </div>
    );
  }

  if (!available) {
    return (
      <div className="pm-hub-chart pm-hub-chart-unavailable">
        <div className="pm-hub-chart-meta">
          <span>Live snapshot · 1D chart unavailable</span>
          <SummaryQuoteStack contractValue={snapshotQuote} reference={reference} />
        </div>
        <strong>{chart?.reason || 'No current direct venue price history is available.'}</strong>
      </div>
    );
  }

  const values = points.map((point) => point.close);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const padding = Math.max((max - min) * 0.16, 0.025);
  const domain = [Math.max(0, min - padding), Math.min(1, max + padding)];
  const latestPoint = points[points.length - 1];
  return (
    <div className={`pm-hub-chart ${historicalOnly ? 'pm-hub-history-chart' : ''}`}>
      <div className="pm-hub-chart-meta">
        <span>{historicalOnly ? 'Previous contract · 1D' : 'Live 1D'} · {chart.label || 'Representative contract'}</span>
        <SummaryQuoteStack
          contractValue={latestPoint.close}
          reference={reference}
          historicalOnly={historicalOnly}
        />
      </div>
      <div
        className="pm-hub-chart-canvas"
        aria-label={`${historicalOnly ? 'Previous settled' : 'Live'} 1-day chart for ${chart.label || chart.ticker}`}
      >
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={points} margin={{ top: 7, right: 5, left: 0, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke="#dbe4ef" strokeDasharray="2 4" />
            <XAxis
              dataKey="timestamp"
              axisLine={false}
              tickLine={false}
              minTickGap={38}
              tick={{ fill: CHART_AXIS_TICK_COLOR, fontSize: 8 }}
              tickFormatter={(value) => new Date(value).toLocaleTimeString('en-US', { hour: 'numeric' })}
            />
            <YAxis
              orientation="right"
              domain={domain}
              axisLine={false}
              tickLine={false}
              tick={{ fill: CHART_AXIS_TICK_COLOR, fontSize: 8 }}
              tickFormatter={(value) => `${Math.round(value * 100)}¢`}
              width={29}
            />
            <Tooltip content={<ChartTooltip chart={chart} />} />
            <Line
              type="linear"
              dataKey="close"
              stroke="#2563eb"
              strokeWidth={1.7}
              strokeLinecap="butt"
              dot={false}
              activeDot={false}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function ContractIdentityStrip({ title, summary }) {
  const verifiedIdentity = summary.available || summary.historicalOnly;
  const contract = verifiedIdentity ? summary.eventTicker || summary.seriesTicker : null;
  return (
    <div className="pm-hub-contract-identity" aria-label={`${title} selected contract`}>
      <span>Kalshi</span>
      <strong>{contract || 'No verified contract'}</strong>
      {contract && summary.seriesTicker && summary.eventTicker && summary.seriesTicker !== summary.eventTicker ? (
        <small>{summary.seriesTicker}</small>
      ) : null}
    </div>
  );
}

function IbkrContractsPanel({ title, contracts, positionsState }) {
  const status = normalizeStatus(positionsState?.status);
  const loading = status === 'loading';
  const live = status === 'live' || status === 'partial';
  const message = loading
    ? 'Checking verified-live IBKR contracts.'
    : !live
      ? positionsState?.message || 'Verified-live IBKR contracts are unavailable.'
      : `No open ${title} prediction contracts are held in the verified-live IBKR account snapshot.`;
  return (
    <div className="pm-hub-ibkr-contracts">
      <div className="pm-hub-contract-identity" aria-label={`${title} selected contract source`}>
        <span>IBKR</span>
        <strong>{contracts.length ? `${contracts.length} held contract${contracts.length === 1 ? '' : 's'}` : 'No held contract'}</strong>
        <small>Account snapshot</small>
      </div>
      {contracts.length ? (
        <>
          <div className="pm-hub-ibkr-contract-heading" aria-hidden="true">
            <span>Contract</span><span>Venue</span><span>Side</span><span>Qty</span><span>Avg</span>
          </div>
          <div className="pm-hub-ibkr-contract-list" role="list" aria-label={`Open IBKR ${title} contracts`}>
            {contracts.map((contract) => (
              <div className="pm-hub-ibkr-contract-row" role="listitem" key={contract.id}>
                <strong title={contract.identity}>{contract.identity}</strong>
                <span>{contract.venue}</span>
                <span className={contract.side === 'YES' ? 'yes' : contract.side === 'NO' ? 'no' : ''}>{contract.side}</span>
                <span>{formatCompactNumber(Math.abs(contract.quantity ?? 0))}</span>
                <span>{formatPrice(contract.averageCost)}</span>
              </div>
            ))}
          </div>
          {status === 'partial' ? (
            <p>{positionsState?.message || 'Some IBKR accounts are unavailable; only verified accounts are shown.'}</p>
          ) : null}
        </>
      ) : (
        <div className="pm-hub-local-unavailable" role="status">{message}</div>
      )}
      <small className="pm-hub-ibkr-contract-note">
        Held-contract identity only. Missing native live bid/ask data stays unavailable.
      </small>
    </div>
  );
}

function ExchangeSelect({ title, value, onChange }) {
  const surfaceActive = useSurfaceActivity();
  const triggerRef = useRef(null);
  const menuRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState(null);
  const menuId = `pm-hub-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-exchange-menu`;
  const selectedLabel = EXCHANGE_OPTIONS.find((option) => option.value === value)?.label || value;

  const closeMenu = useCallback(({ restoreFocus = false } = {}) => {
    setOpen(false);
    setPosition(null);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  const updatePosition = useCallback(() => {
    if (!triggerRef.current || typeof window === 'undefined') return;
    const rect = triggerRef.current.getBoundingClientRect();
    const margin = 6;
    const width = rect.width;
    const maxLeft = Math.max(margin, window.innerWidth - width - margin);
    setPosition({
      left: Math.min(Math.max(margin, rect.left), maxLeft),
      top: rect.bottom + 1,
      width,
    });
  }, []);

  useLayoutEffect(() => {
    if (!surfaceActive || !open) return;
    updatePosition();
  }, [open, surfaceActive, updatePosition]);

  useEffect(() => {
    if (surfaceActive || !open) return;
    closeMenu();
  }, [closeMenu, open, surfaceActive]);

  useEffect(() => {
    if (!surfaceActive || !open) return undefined;
    const handlePointerDown = (event) => {
      if (triggerRef.current?.contains(event.target) || menuRef.current?.contains(event.target)) return;
      closeMenu();
    };
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') closeMenu({ restoreFocus: true });
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [closeMenu, open, surfaceActive, updatePosition]);

  useEffect(() => {
    if (!open || !position) return;
    menuRef.current?.querySelector('[aria-selected="true"]')?.focus();
  }, [open, position]);

  const handleMenuKeyDown = (event) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const options = Array.from(menuRef.current?.querySelectorAll('[role="option"]') || []);
    if (!options.length) return;
    const currentIndex = options.indexOf(document.activeElement);
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? options.length - 1
        : event.key === 'ArrowUp'
          ? (currentIndex <= 0 ? options.length - 1 : currentIndex - 1)
          : (currentIndex + 1) % options.length;
    options[nextIndex]?.focus();
  };

  const menu = surfaceActive && open && typeof document !== 'undefined'
    ? createPortal(
      <div
        ref={menuRef}
        id={menuId}
        className="pm-hub-exchange-menu"
        role="listbox"
        aria-label={`${title} exchanges`}
        onKeyDown={handleMenuKeyDown}
        style={{
          left: position?.left ?? 0,
          top: position?.top ?? 0,
          width: position?.width ?? 0,
          visibility: position ? 'visible' : 'hidden',
        }}
      >
        {EXCHANGE_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            className="pm-hub-exchange-option"
            role="option"
            aria-selected={option.value === value}
            tabIndex={option.value === value ? 0 : -1}
            onClick={() => {
              onChange(option.value);
              closeMenu({ restoreFocus: true });
            }}
          >
            {option.label}
          </button>
        ))}
      </div>,
      document.body,
    )
    : null;

  return (
    <>
      <div className="pm-hub-exchange-select">
        <span>Exchange</span>
        <button
          ref={triggerRef}
          type="button"
          role="combobox"
          className="pm-hub-exchange-button"
          aria-label={`${title} exchange`}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          value={value}
          onClick={() => {
            if (!open) setPosition(null);
            setOpen((current) => !current);
          }}
          onKeyDown={(event) => {
            if (!['ArrowDown', 'ArrowUp'].includes(event.key) || open) return;
            event.preventDefault();
            setPosition(null);
            setOpen(true);
          }}
        >
          <span className="pm-hub-exchange-value">{selectedLabel}</span>
          <span className="pm-hub-exchange-disclosure" aria-hidden="true">▾</span>
        </button>
      </div>
      {menu}
    </>
  );
}

function MarketSummaryCard({
  title,
  icon,
  entry,
  onOpen,
  headerControls = null,
  headerClassName = '',
  chartRange = '1d',
  testId = null,
  showSignals = false,
  quoteOnly = false,
  contractPresentation = null,
  onShowDailyWti = null,
  marketKey,
  positionsState,
  ibkrCadence = null,
  tickReading = null,
}) {
  const [exchange, setExchange] = useState('kalshi');
  const summary = normalizeSummary(entry);
  const selectedChart = chartRange === '5d'
    ? summary.chart?.variants?.['5d'] || summary.chart
    : summary.chart?.variants?.['1d'] || summary.chart;
  const viewingIbkr = exchange === 'ibkr';
  const ibkrContracts = selectIbkrContractPositions(positionsState, marketKey, ibkrCadence);
  return (
    <section
      id={testId || undefined}
      data-testid={testId || undefined}
      className="pm-hub-summary-card"
      aria-label={`${title} market summary`}
    >
      <div className={`pm-hub-summary-header ${showSignals ? 'pm-hub-summary-header--signals' : ''} ${headerClassName}`.trim()}>
        <div className="pm-hub-summary-header-content">
          <button
            type="button"
            className="pm-hub-summary-open"
            onClick={onOpen}
            aria-label={title}
            disabled={viewingIbkr}
            title={viewingIbkr ? 'The detailed workbench currently uses the direct Kalshi contract feed.' : undefined}
          >
            <span className="pm-hub-summary-title">{icon}{title}</span>
          </button>
          {showSignals ? <SummarySignalIndicators title={title} summary={summary} tickReading={tickReading} /> : null}
          <ExchangeSelect title={title} value={exchange} onChange={setExchange} />
          {headerControls}
        </div>
      </div>
      <IntradayChart
        chart={selectedChart}
        summary={summary}
        reference={summary.reference}
        historicalOnly={summary.historicalOnly || summary.quoteState === 'closed'}
      />
      <div className="pm-hub-summary-lower">
        {viewingIbkr ? (
          <IbkrContractsPanel
            title={title}
            contracts={ibkrContracts}
            positionsState={positionsState}
          />
        ) : (
          <>
            <ContractIdentityStrip title={title} summary={summary} />
            <LinesTable
              summary={summary}
              quoteOnly={quoteOnly}
              contractPresentation={contractPresentation}
              onShowDailyWti={onShowDailyWti}
            />
          </>
        )}
      </div>
    </section>
  );
}

function WtiSummaryCard({ entry, activeCadence, onCadenceChange, activeRange, onRangeChange, onOpen, positionsState, tickReading }) {
  const cadence = activeCadence === 'weekly' ? 'weekly' : 'daily';
  const selectedEntry = entry?.[cadence];
  const normalized = normalizeSummary(selectedEntry);
  const contractPresentation = getWtiContractPresentation(
    normalized.seriesTicker || (cadence === 'weekly' ? 'KXWTIW' : 'KXWTI'),
  );
  const fiveDayReady = normalizeStatus(normalized.chart?.variants?.['5d']?.status) === 'available';
  const range = activeRange === '5d' && fiveDayReady ? '5d' : '1d';
  const rangeTabs = (
    <div className="pm-hub-cadence-tabs pm-hub-chart-range-tabs" role="tablist" aria-label="WTI chart range">
      {['1d', '5d'].map((option) => (
        <button
          key={option}
          type="button"
          role="tab"
          aria-selected={range === option}
          className={range === option ? 'active' : ''}
          disabled={option === '5d' && !fiveDayReady}
          title={option === '5d' && !fiveDayReady ? 'Verified five-session WTI history and daily Risk Range data are unavailable.' : undefined}
          onClick={() => onRangeChange?.(option)}
        >
          {option === '1d' ? '1D' : '5D'}
        </button>
      ))}
    </div>
  );
  const cadenceTabs = (
    <div className="pm-hub-cadence-tabs" role="tablist" aria-label="WTI market cadence">
      {['daily', 'weekly'].map((option) => (
        <button
          key={option}
          type="button"
          role="tab"
          aria-selected={cadence === option}
          className={cadence === option ? 'active' : ''}
          title={option === 'daily'
            ? 'KXWTI daily contracts'
            : 'KXWTIW: weekly mutually exclusive settlement bands'}
          onClick={() => onCadenceChange?.(option)}
        >
          {option === 'daily' ? 'Daily' : 'Weekly'}
        </button>
      ))}
    </div>
  );
  return (
    <MarketSummaryCard
      title="WTI"
      icon={<Droplet size={16} color="#111827" fill="#111827" />}
      entry={selectedEntry}
      onOpen={onOpen}
      headerClassName="pm-hub-summary-header--wti"
      headerControls={(
        <div className="pm-hub-summary-header-controls pm-hub-summary-header-controls--wti">
          {rangeTabs}
          {cadenceTabs}
        </div>
      )}
      chartRange={range}
      showSignals
      contractPresentation={contractPresentation}
      onShowDailyWti={cadence === 'weekly' ? () => onCadenceChange?.('daily') : null}
      marketKey="wti"
      positionsState={positionsState}
      ibkrCadence={cadence}
      tickReading={tickReading}
    />
  );
}

function SpxSummaryCard({ entry, activeRange, onRangeChange, onOpen, positionsState, tickReading }) {
  const normalized = normalizeSummary(entry);
  const fiveDayChart = normalized.chart?.variants?.['5d'];
  const fiveDayReady = fiveDayChart?.status === 'available';
  const range = activeRange === '5d' && fiveDayReady ? '5d' : '1d';
  const tabs = (
    <div className="pm-hub-summary-header-controls">
      <div className="pm-hub-cadence-tabs pm-hub-chart-range-tabs" role="tablist" aria-label="S&P 500 chart range">
        {['1d', '5d'].map((option) => (
          <button
            key={option}
            type="button"
            role="tab"
            aria-selected={range === option}
            className={range === option ? 'active' : ''}
            disabled={option === '5d' && !fiveDayReady}
            title={option === '5d' && !fiveDayReady ? 'Verified five-session history and daily Risk Range data are unavailable.' : undefined}
            onClick={() => onRangeChange?.(option)}
          >
            {option === '1d' ? '1D' : '5D'}
          </button>
        ))}
      </div>
    </div>
  );
  return (
    <MarketSummaryCard
      title="S&P 500"
      icon={<BarChart3 size={16} />}
      entry={entry}
      onOpen={onOpen}
      headerControls={tabs}
      chartRange={range}
      testId="spx-cover-card"
      quoteOnly
      showSignals
      marketKey="sp500"
      positionsState={positionsState}
      tickReading={tickReading}
    />
  );
}


function PositionsCard({ positionsState, onOpenMarket }) {
  const { status, positions, message } = positionsState;
  const [activeFilter, setActiveFilter] = useState('all');
  const positionRows = positions.map((position, index) => {
    const classification = classifyPredictionMarketPosition(position);
    return {
      position,
      index,
      classification,
      venue: predictionMarketVenueLabel(position, classification),
      filterKey: positionMarketFilter(position),
      payoff: calculatePositionPayoff(position),
    };
  });
  const displayedPositionRows = activeFilter === 'all'
    ? positionRows
    : positionRows.filter(({ filterKey }) => filterKey === activeFilter);
  const completePayoffInputs = displayedPositionRows.length > 0
    && displayedPositionRows.every(({ payoff }) => payoff.valid);
  const totals = completePayoffInputs
    ? displayedPositionRows.reduce((summary, { payoff }) => ({
        cost: summary.cost + payoff.cost,
        payout: summary.payout + payoff.payout,
      }), { cost: 0, payout: 0 })
    : null;
  const totalRatio = totals?.cost > 0 ? totals.payout / totals.cost : null;
  return (
    <section className="pm-hub-positions-card" aria-label="Prediction-market positions">
      <div className="pm-hub-position-filters" role="group" aria-label="Filter prediction-market positions">
        {POSITION_MARKET_FILTERS.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            aria-pressed={activeFilter === key}
            className={activeFilter === key ? 'active' : ''}
            onClick={() => setActiveFilter(key)}
          >
            {label}
          </button>
        ))}
      </div>
      {status === 'partial' && <div className="pm-hub-partial-note">{message || 'Some IBKR accounts could not be verified. Unverified accounts are omitted.'}</div>}
      {status === 'loading' ? (
        <div className="pm-hub-local-unavailable"><LoadingIndicator label="Loading live IBKR positions..." size="sm" /></div>
      ) : status === 'unavailable' ? (
        <div className="pm-hub-local-unavailable">{message || 'Verified-live IBKR positions are unavailable.'}</div>
      ) : positions.length === 0 ? (
        <div className="pm-hub-empty-positions">No open prediction-market positions in the verified-live IBKR accounts.</div>
      ) : displayedPositionRows.length === 0 ? (
        <div className="pm-hub-empty-positions">No positions match the {POSITION_MARKET_FILTERS.find(({ key }) => key === activeFilter)?.label} filter.</div>
      ) : (
        <div className="pm-hub-table-wrap">
          <table className="pm-hub-positions-table">
            <thead><tr><th>Market</th><th>Venue</th><th>Contract</th><th>Account</th><th>Qty</th><th>Avg cost</th><th>Cost</th><th>Payout if win</th><th>Payout ratio</th><th>Market value</th><th>Unrealized P&amp;L</th><th>Updated</th></tr></thead>
            <tbody className="pm-hub-position-rows" tabIndex="0" aria-label="Open prediction-market contracts">
              {displayedPositionRows.map(({ position, index, classification, venue, payoff }) => {
                const market = classification.startsWith('wti')
                  ? 'WTI'
                  : classification === 'spx' ? 'SPX' : classification === 'cpi' ? 'CPI' : 'Other';
                const openable = ['spx', 'cpi'].includes(classification);
                return (
                  <tr key={position.positionId || position.conid || `${position.symbol}-${index}`}>
                    <td>
                      {openable ? (
                        <button type="button" className="pm-hub-position-link" onClick={() => onOpenMarket(classification)}>{market}</button>
                      ) : market}
                    </td>
                    <td>{venue}</td>
                    <td>{position.description || position.localSymbol || position.symbol || '—'}</td>
                    <td>{position.accountId || position.account || '—'}</td>
                    <td>{formatNumber(position.quantity ?? position.position)}</td>
                    <td>{formatPrice(position.avgCost ?? position.averageCost)}</td>
                    <td className="pm-hub-position-metric">{formatMoney(payoff.cost)}</td>
                    <td className="pm-hub-position-metric">{formatMoney(payoff.payout)}</td>
                    <td className="pm-hub-position-metric">{formatPayoutRatio(payoff.ratio)}</td>
                    <td>{formatMoney(position.marketValue)}</td>
                    <td>{formatMoney(position.unrealizedPnL ?? position.unrealizedPnl ?? position.gainLoss)}</td>
                    <td>{formatDateTime(position.lastUpdated || position.updatedAt)}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <th className="pm-hub-position-total-label" colSpan={6} scope="row">{completePayoffInputs ? 'Total (if all displayed positions win)' : 'Total unavailable'}</th>
                <td className="pm-hub-position-metric">{formatMoney(totals?.cost)}</td>
                <td className="pm-hub-position-metric" title={completePayoffInputs ? 'Gross payout if every displayed position wins' : 'A complete payout total requires valid cost inputs for every displayed position'}>{formatMoney(totals?.payout)}</td>
                <td className="pm-hub-position-metric">{formatPayoutRatio(totalRatio)}</td>
                <td className="pm-hub-position-total-rest" colSpan={3}>—</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </section>
  );
}

function PredictionMarketsOverview({
  positionsState,
  onSelectMarket,
  activeWtiCadence,
  onSelectWtiCadence,
}) {
  const active = useSurfaceActivity();
  const { readings: tickReadings } = useHedgaiTickResearch({ active });
  const [state, setState] = useState({ status: 'loading', data: null, error: null });
  const [spxContextEntry, setSpxContextEntry] = useState(null);
  const [spxCoverSnapshot, setSpxCoverSnapshot] = useState(null);
  const [activeSpxRange, setActiveSpxRange] = useState('1d');
  const [activeWtiRange, setActiveWtiRange] = useState('1d');
  const requestRef = useRef(0);
  const inFlightRef = useRef(null);

  const load = useCallback(async () => {
    if (inFlightRef.current) return inFlightRef.current;
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    setState((current) => current.data
      ? { ...current, refreshing: true, error: null }
      : { status: 'loading', data: null, error: null, refreshing: false });
    const loadSpx = predictionMarketsIngestService.getSpxPredictionMarketsOverview;
    const loadSpxCover = predictionMarketsIngestService.getSpxCoverSnapshot;
    const request = Promise.allSettled([
      predictionMarketsIngestService.getPredictionMarketsOverview({ excludeSpx: true }),
      typeof loadSpx === 'function'
        ? loadSpx.call(predictionMarketsIngestService)
        : Promise.reject(new Error('The dedicated SPX chart response is unavailable.')),
      typeof loadSpxCover === 'function'
        ? loadSpxCover.call(predictionMarketsIngestService)
        : Promise.reject(new Error('The direct SPX cover feed is unavailable.')),
    ]).then(([overviewResult, spxResult, coverResult]) => {
      if (requestId !== requestRef.current) return;
      if (overviewResult.status === 'fulfilled') {
        setState({ status: 'ready', data: overviewResult.value, error: null, refreshing: false });
      } else {
        const error = overviewResult.reason;
        const message = error?.response?.data?.error || error?.message || 'Prediction-market summaries are unavailable.';
        setState((current) => current.data
          ? { ...current, status: 'ready', refreshing: false, error: message }
          : { status: 'unavailable', data: null, error: message, refreshing: false });
      }

      if (spxResult.status === 'fulfilled') {
        setSpxContextEntry(spxResult.value?.market || spxResult.value?.markets?.spx || {
          status: 'unavailable',
          summary: null,
          error: 'The dedicated SPX chart response is unavailable.',
        });
      } else {
        const error = spxResult.reason;
        setSpxContextEntry((current) => current
          ? { ...current, refreshError: error?.response?.data?.error || error?.message }
          : {
              status: 'unavailable',
              summary: null,
              error: error?.response?.data?.error || error?.message || 'The dedicated SPX chart response is unavailable.',
            });
      }

      if (coverResult.status === 'fulfilled') {
        setSpxCoverSnapshot(coverResult.value);
      } else {
        const error = coverResult.reason;
        setSpxCoverSnapshot((current) => current
          ? { ...current, refreshError: error?.response?.data?.error || error?.message }
          : {
              ok: false,
              mode: 'unavailable',
              error: error?.response?.data?.error || error?.message || 'The direct SPX cover feed is unavailable.',
              markets: [],
            });
      }
    }).finally(() => {
      if (inFlightRef.current === request) inFlightRef.current = null;
    });
    inFlightRef.current = request;
    return request;
  }, []);

  useEffect(() => {
    load();
    const stop = startVisibilityAwarePolling({ poll: load, intervalMs: OVERVIEW_POLL_MS });
    return () => {
      requestRef.current += 1;
      stop();
    };
  }, [load]);

  const markets = state.data?.markets || {};
  const overviewSpxEntry = spxContextEntry || getOverviewEntry(state.data, ['spx']);
  const selectedSpxEntry = normalizeSpxCoverSnapshot(spxCoverSnapshot, overviewSpxEntry);
  return (
    <main className="pm-hub-overview" data-testid="prediction-markets-overview">
      {state.error && (
        <div className="pm-hub-overview-error">
          {state.data ? 'Market summary refresh delayed' : 'Market summaries are unavailable'}: {state.error}
        </div>
      )}
      <div className="pm-hub-summary-grid" aria-busy={state.status === 'loading' || state.refreshing}>
        <MarketSummaryCard
          title="CPI"
          icon={<Scale size={16} />}
          entry={getOverviewEntry(state.data, ['cpi'])}
          onOpen={() => onSelectMarket('cpi')}
          marketKey="cpi"
          positionsState={positionsState}
        />
        <SpxSummaryCard
          entry={selectedSpxEntry}
          activeRange={activeSpxRange}
          onRangeChange={setActiveSpxRange}
          onOpen={() => onSelectMarket('spx')}
          positionsState={positionsState}
          tickReading={tickReadings.SPX}
        />
        <WtiSummaryCard
          entry={markets.wti}
          activeCadence={activeWtiCadence}
          onCadenceChange={onSelectWtiCadence}
          activeRange={activeWtiRange}
          onRangeChange={setActiveWtiRange}
          onOpen={() => onSelectMarket('wti')}
          positionsState={positionsState}
          tickReading={tickReadings.CL}
        />
      </div>
      <PositionsCard positionsState={positionsState} onOpenMarket={(market, cadence) => { if (market === 'wti') onSelectWtiCadence(cadence); onSelectMarket(market); }} />
    </main>
  );
}

const INITIAL_POSITIONS_STATE = Object.freeze({
  status: 'loading',
  positions: [],
  accounts: [],
  message: null,
  fetchedAt: null,
});

export default function PredictionMarketsHub({
  onClose,
  portfolioData,
  selectedAccount = null,
  activeMarket = 'overview',
  onActiveMarketChange,
  activeWtiCadence = 'daily',
  onWtiCadenceChange,
  ibkrConnection = null,
}) {
  const selectedView = PREDICTION_MARKET_VIEWS.includes(activeMarket) ? activeMarket : 'overview';
  const accountId = selectedAccount || portfolioData?.accountId || null;
  const ibkrDisconnected = ibkrConnection?.connected === false;
  const loadPositions = useCallback(
    () => MarketDataService.getPortfolioPredictionMarketPositions({ primaryAccount: accountId }),
    [accountId],
  );
  const validatePositions = useCallback((payload) => {
    const normalized = normalizeLivePositionsPayload(payload);
    if (normalized.status === 'unavailable') {
      throw Object.assign(new Error(normalized.message), {
        code: payload?.errorCode || payload?.code || 'PREDICTION_POSITIONS_UNAVAILABLE',
        liveInvalidation: true,
      });
    }
    return normalized;
  }, []);
  const positionsResource = useSessionResource({
    resourceKey: 'prediction-market-positions',
    scopeKey: accountId || 'all-managed-accounts',
    kind: 'live',
    fetcher: loadPositions,
    validate: validatePositions,
    getObservedAt: (positions) => positions.fetchedAt,
    maxAgeMs: POSITION_MAX_AGE_MS,
    pollIntervalMs: POSITION_POLL_MS,
    enabled: !ibkrDisconnected,
    active: true,
    pollWhenHidden: true,
    pollWhenDocumentHidden: true,
    invalidateOnScopeChange: true,
    core: true,
    expiredCode: 'PREDICTION_POSITIONS_EXPIRED',
    expiredMessage: 'The verified-live prediction-market positions expired.',
  });
  const invalidatePositions = positionsResource.invalidate;

  useEffect(() => {
    if (!ibkrDisconnected) return;
    invalidatePositions(Object.assign(
      new Error(ibkrConnection?.title || 'IB Gateway/TWS is disconnected.'),
      { code: 'GATEWAY_OFFLINE' },
    ));
  }, [ibkrConnection?.title, ibkrDisconnected, invalidatePositions]);

  const positionsState = ibkrDisconnected
    ? {
        status: 'unavailable',
        positions: [],
        accounts: [],
        message: ibkrConnection?.title || 'IB Gateway/TWS is disconnected; verified-live positions are unavailable.',
        fetchedAt: null,
        refreshing: false,
      }
    : positionsResource.data
      ? {
          ...positionsResource.data,
          refreshing: positionsResource.refreshing,
          message: positionsResource.error
            ? `Position refresh delayed: ${positionsResource.error.message}`
            : positionsResource.data.message,
        }
      : positionsResource.initialLoading || positionsResource.availability === 'loading'
        ? INITIAL_POSITIONS_STATE
        : {
            status: 'unavailable',
            positions: [],
            accounts: [],
            message: positionsResource.error?.message || 'Verified-live IBKR positions are unavailable.',
            fetchedAt: null,
            refreshing: false,
          };

  const childFallback = useCallback((label) => (
    <LoadingIndicator label={`Loading ${label} workbench...`} size="sm" />
  ), []);
  return (
    <div className="prediction-markets-hub" data-testid="prediction-markets-hub">
      <div className="pm-hub-content">
        <PersistentSurface active={selectedView === 'overview'}>
          <PredictionMarketsOverview
            positionsState={positionsState}
            onSelectMarket={onActiveMarketChange}
            activeWtiCadence={activeWtiCadence}
            onSelectWtiCadence={onWtiCadenceChange}
          />
        </PersistentSurface>
        <PersistentSurface active={selectedView === 'wti'}>
          <Suspense fallback={childFallback('WTI')}>
            <WtiWorkbench
              cadence={activeWtiCadence}
              onBack={() => onActiveMarketChange?.('overview')}
              onCadenceChange={onWtiCadenceChange}
              sharedPositionsState={positionsState}
            />
          </Suspense>
        </PersistentSurface>
        <PersistentSurface active={selectedView === 'spx'}>
          <Suspense fallback={childFallback('SPX')}>
            <SpxWorkbench embedded onClose={onClose} portfolioData={portfolioData} sharedPositionsState={positionsState} />
          </Suspense>
        </PersistentSurface>
        <PersistentSurface active={selectedView === 'cpi'}>
          <Suspense fallback={childFallback('CPI')}>
            <CpiWorkbench embedded portfolioData={portfolioData} sharedPositionsState={positionsState} />
          </Suspense>
        </PersistentSurface>
      </div>
    </div>
  );
}
