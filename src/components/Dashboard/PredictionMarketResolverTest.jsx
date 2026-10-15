import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSurfaceActivity } from '../common/PersistentSurface';
import usePageScrollLock from '../../hooks/usePageScrollLock';
import { startVisibilityAwarePolling } from '../../utils/visibilityAwarePolling';
import { useDashboardResource } from '../../hooks/useDashboardResource';
import { useSessionResource } from '../../hooks/useSessionResource';
import { MarketDataService } from '../../services/api/marketDataService';
import predictionMarketTestService from '../../services/api/predictionMarketTestService';
import { isExplicitLiveInvalidation } from '../../utils/sessionResourceStore';
import { canonicalPredictionMonitorVenue } from '../../utils/predictionMonitorIdentity';
import FactorMonitor from './predictionMonitor/FactorMonitor';
import { finite } from './predictionMonitor/monitorNumbers';
import { MARKET_UI } from './predictionMonitor/marketUi';
import { isSpxMonitorSectionUsable } from './predictionMonitor/monitorSectionValidation';
import {
  formatIndex, formatCount, formatCents, formatAsOf,
} from './predictionMonitor/monitorFormatting';
import {
  normalizeCpiChartValue, resolveCpiBlsActualAvailability,
} from './predictionMonitor/cpiForecastValues';

// Preserve monitor entry-point exports for existing consumers.
export { isSpxMonitorSectionUsable, normalizeCpiChartValue, resolveCpiBlsActualAvailability };
import GdpPredictionMarketCard from './GdpPredictionMarketCard';
import { buildSpxCloseConfluence } from '../../utils/spxCloseConfluence';
import predictionMarketAth from '../../utils/predictionMarketAth.cjs';
import analyticsDailyBrief from '../../utils/analyticsDailyBrief.cjs';
import {
  buildSpxStrategyCandidates,
  defaultSpxStrategyMix,
  resolveVerifiedPortfolioSizingBase,
  sizeSpxStrategy,
} from '../../utils/spxStrategySizing';
import {
  normalizeGoldCorrelationSnapshot,
  isGoldCorrelationSnapshotUsable,
  withCanonicalGoldCorrelationFactor,
} from './predictionMonitor/goldCorrelationContext';
import {
  normalizeVerifiedMomoTrackerSpots,
  normalizeMomoTrackerSnapshot,
} from './predictionMonitor/momoTrackerContext';
import './PredictionMarketResolverTest.css';
import useMomoTrackerReference from './predictionMonitor/useMomoTrackerReference';
import useSp500ContributorsReference from './predictionMonitor/useSp500ContributorsReference';
import useGoldCorrelationReference from './predictionMonitor/useGoldCorrelationReference';
import useCpiBenchmarkReference from './predictionMonitor/useCpiBenchmarkReference';
import {
  resolveVerifiedGoldSettlements,
  resolveVerifiedGoldSettlementTime,
} from './predictionMonitor/goldSettlementReferences';
import {
  HEADER_QUOTE_MAX_AGE_MS,
  isRetainableSpxHeaderReference,
  isVerifiedHistoricalCashHeaderQuote,
  isVerifiedLiveCashHeaderQuote,
  normalizeGoldHeaderMarketReference,
} from './predictionMonitor/headerMarketReferences';
import { humanizeSource } from './predictionMonitor/HeaderMarketStrip';
import { ChartTooltip } from './predictionMonitor/RiskRangeChartAnnotations';
import {
  buildIntradayTimeAxis,
  buildSpxPriceAxis,
  clampChartReferenceValue,
  expandSpxPriceAxis,
  resolveAthReferenceDate,
  resolveAthReferenceValue,
  resolveVerifiedVixCloses,
} from './predictionMonitor/riskRangeChartAxes';
import {
  buildFiveDayChartLayout,
  buildMultiDayChartLayout,
  projectOverlayPointsToSessions,
} from './predictionMonitor/riskRangeChartSessions';
import { calculateRiskRangeStructureScore } from './predictionMonitor/riskRangeStructure';
import { SettlementIdentityChips } from './predictionMonitor/SettlementIdentityChips';
import { SpxRiskRangeChart } from './predictionMonitor/SpxRiskRangeChart';

// Preserve the monitor entry point used by existing callers and regressions.
export { ChartTooltip, SettlementIdentityChips, SpxRiskRangeChart, buildFiveDayChartLayout, buildIntradayTimeAxis, buildMultiDayChartLayout, buildSpxPriceAxis, calculateRiskRangeStructureScore, clampChartReferenceValue, expandSpxPriceAxis, normalizeGoldHeaderMarketReference, projectOverlayPointsToSessions, resolveAthReferenceDate, resolveAthReferenceValue, resolveVerifiedGoldSettlementTime, resolveVerifiedGoldSettlements, resolveVerifiedVixCloses };
import CpiForecastComparisonPanel from './predictionMonitor/CpiForecastComparisonPanel';
import { CpiForecastTooltip } from './predictionMonitor/CpiForecastDetails';
import { normalizeCpiBenchmarkPanelData, buildCpiCalendarAxis, buildCpiDailyChartRows } from './predictionMonitor/cpiForecastContext';
import { buildContractTradingClock, formatDateTimeInZone } from './predictionMonitor/contractTradingClock';
import { buildSettlementIdentityViewModel } from './predictionMonitor/settlementIdentity';
import { resolveChartLabelOffsets } from './predictionMonitor/chartLabelLayout';

// Preserve the monitor entry point used by existing callers and regressions.
export { CpiForecastTooltip, normalizeCpiBenchmarkPanelData, buildCpiCalendarAxis, buildCpiDailyChartRows, buildContractTradingClock, buildSettlementIdentityViewModel, resolveChartLabelOffsets };
import ContractLadder from './predictionMonitor/ContractLadder';
import SettlementBenchmarkStrip from './predictionMonitor/SettlementBenchmarkStrip';
import { buildSettlementBenchmarkView, SETTLEMENT_BENCHMARK_MARKETS } from './predictionMonitor/settlementBenchmark';
import { formatSpotMarker } from './predictionMonitor/contractLadderPresentation';
import { parseLiveFesPosition, buildLiveFesPositionMap } from './predictionMonitor/predictionPositionOverlay';
import { selectContractLinesAroundSpot, buildLadderProximityLevels, buildGoldLadderProximityLevels, selectContractLinesForReference } from './predictionMonitor/contractLadderGeometry';
import {
  isLastVerifiedContractReference,
  isVerifiedDelayedContractReference,
  isVerifiedDelayedSpxHeaderReference,
  isVerifiedDisplayReference,
} from './predictionMonitor/contractReferenceValidation';

export {
  formatSpotMarker, parseLiveFesPosition, buildLiveFesPositionMap,
  selectContractLinesAroundSpot, buildLadderProximityLevels, buildGoldLadderProximityLevels, selectContractLinesForReference,
  isVerifiedDelayedSpxHeaderReference,
};

// Preserve the monitor entry point used by existing callers and regressions.
export { normalizeVerifiedMomoTrackerSpots, normalizeMomoTrackerSnapshot };

// Preserve the monitor entry point used by existing callers and regressions.
export {
  normalizeGoldCorrelationSnapshot,
  isGoldCorrelationSnapshotUsable,
  withCanonicalGoldCorrelationFactor,
};


const {
  retainVerifiedAthWhilePending,
  synchronizeVerifiedAthAcrossChartRanges,
} = predictionMarketAth;

const POLL_MS = 5_000;
const CLOSED_POLL_MS = 30_000;
const CLOCK_TICK_MS = 1_000;
const POSITION_MAX_AGE_MS = 60_000;
const VENUE_OPTIONS = Object.freeze([
  Object.freeze({ id: 'auto', label: 'Auto' }),
  Object.freeze({ id: 'kalshi', label: 'Kalshi' }),
  Object.freeze({ id: 'forecastex', label: 'ForecastEx' }),
]);

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









// Kept as an export alias for callers/tests written when Gold was the only
// prediction-market ladder with reference-proximity shading.










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

const publicationDateForSession = (date) => {
  const timestamp = Date.parse(`${date}T12:00:00.000Z`);
  if (!Number.isFinite(timestamp)) return null;
  const publication = new Date(timestamp);
  if (publication.toISOString().slice(0, 10) !== date) return null;
  while (!analyticsDailyBrief.isMarketDay(publication)) publication.setUTCDate(publication.getUTCDate() - 1);
  return publication.toISOString().slice(0, 10);
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
        ? publicationDateForSession(date) === publicationDate
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
      riskRangePublicationDate: prior.riskRangePublicationDate,
      riskRangeCarryForward: prior.riskRangeCarryForward,
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

export function mergeSpxMonitorSnapshots(previous, next, nowMs = Date.now()) {
  if (!previous || !next || previous.marketId !== next.marketId) return next;
  // A direct perpetual has its own provider validation and refresh lifecycle.
  // Never restore a Coinbase series or expired contract prices into it.
  if (next.perpetualReference || previous.perpetualReference) return next;
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





const formatCurrency = (value, maximumFractionDigits = 0) => finite(value)
  ? Number(value).toLocaleString('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: maximumFractionDigits,
      maximumFractionDigits,
    })
  : '—';




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

const formatExchangeAndLocalTime = (value, exchangeTimeZone) => {
  const exchange = formatDateTimeInZone(value, exchangeTimeZone || 'America/New_York');
  const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const local = formatDateTimeInZone(value, localZone);
  return exchange === '—' ? '—' : exchange === local ? exchange : `${exchange} / ${local}`;
};


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
  const retainedCatalog = snapshot.referenceOnly === true && catalog?.referenceOnly === true
    ? catalog
    : null;
  const displayContracts = compactDisplayContracts || retainedCatalog || (catalog?.status === 'available' ? {
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
  const reference = snapshot.cardView || snapshot.perpetualReference
    ? null : venueSelection.venue?.reference || null;
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
  onMarketChange,
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

  const sp500Contributors = useSp500ContributorsReference({ active, normalizedMarketId, chartRange });
  const {
    snapshot: momoTrackerSnapshot,
    state: momoTrackerState,
    spots: momoTrackerSpots,
  } = useMomoTrackerReference({ active, normalizedMarketId, chartRange, contributors: sp500Contributors });

  const {
    snapshot: goldCorrelationSnapshot,
    state: goldCorrelationState,
    reason: goldCorrelationReason,
    resource: goldCorrelationResource,
    usable: goldCorrelationUsable,
  } = useGoldCorrelationReference({ active, normalizedMarketId, chartRange, clockMs });

  usePageScrollLock(active);

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
    return startVisibilityAwarePolling({
      poll: () => setClockMs(Date.now()),
      intervalMs: CLOCK_TICK_MS,
    });
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
  const { data: cpiBenchmarkData } = useCpiBenchmarkReference({
    active,
    normalizedMarketId,
    forecastComparison: displaySnapshot?.forecastComparison,
  });
  const positionMap = useMemo(() => buildLiveFesPositionMap(
    positionOverlayResource.data?.positions,
    {
      generationKey: displaySnapshot?.contracts?.event?.ticker,
      accountId: positionAccountId,
    },
  ), [displaySnapshot?.contracts?.event?.ticker, positionAccountId, positionOverlayResource.data?.positions]);
  const showsSettlementBenchmark = SETTLEMENT_BENCHMARK_MARKETS.includes(normalizedMarketId);
  const settlementBenchmark = useMemo(() => buildSettlementBenchmarkView(displaySnapshot, {
    nowMs: clockMs,
    refreshFailed: Boolean(refreshError),
  }), [clockMs, displaySnapshot, refreshError]);
  const contractLadderSnapshot = useMemo(() => {
    if (showsSettlementBenchmark) {
      return {
        ...displaySnapshot,
        spot: settlementBenchmark.spot || { status: 'unavailable', value: null, executable: false },
        contractReferenceLabel: 'INPUT',
      };
    }
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
  }, [clockMs, currentSnapshot?.resolverReference, currentSnapshot?.venues?.forecastex?.generationKey, displaySnapshot, marketUi.symbol, normalizedMarketId, settlementBenchmark, showsSettlementBenchmark, simplifiedTemplate, spxHeaderMarketReferences?.futuresReference, venueSelection.id, venueSelection?.venue?.reference]);
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
  const contractLadder = (
    <ContractLadder
      snapshot={contractLadderSnapshot}
      analyses={ladderAnalyses}
      nowMs={clockMs}
      marketUi={marketUi}
      venueSelection={venueSelection}
      positionMap={positionMap}
    />
  );

  if (normalizedMarketId === 'gdp') {
    return <GdpPredictionMarketCard snapshot={refreshError && currentSnapshot ? {
      ...currentSnapshot,
      refreshFailed: true,
      contracts: { ...currentSnapshot.contracts, status: 'unavailable', refreshFailed: true, lines: [] },
    } : currentSnapshot} loading={loading} nowMs={clockMs} />;
  }

  return (
    <section
      className="pm-spx-monitor-shell"
      data-market-id={normalizedMarketId}
      aria-label={!snapshot
        ? `${marketUi.fullLabel} prediction-market monitor loading`
        : snapshot.referenceOnly
          ? `${marketUi.fullLabel} prediction-market retained reference`
          : `Live ${marketUi.fullLabel} prediction-market monitor`}
      aria-busy={loading || monitorResource.refreshing || currentSnapshot?.refresh?.state === 'refreshing'}
    >
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
            benchmarkData={cpiBenchmarkData}
          />
        ) : (
          <SpxRiskRangeChart
            snapshot={displaySnapshot}
            nowMs={clockMs}
            refreshDelayed={refreshDelayed}
            marketUi={marketUi}
            onMarketChange={onMarketChange}
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
            sp500Contributors={sp500Contributors}
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
        {showsSettlementBenchmark ? (
          <div className="pm-settlement-ladder">
            <SettlementBenchmarkStrip benchmark={settlementBenchmark} />
            {contractLadder}
          </div>
        ) : contractLadder}
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

export default React.memo(PredictionMarketResolverTest);
