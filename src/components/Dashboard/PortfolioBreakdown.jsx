import React, { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import { Card } from '@tremor/react';
import {
  separateLongsAndShorts,
  formatPerformance
} from '../../utils/portfolioBreakdownUtils';
import { finiteOptionalNumber } from '../../utils/portfolioNumbers';
import usePortfolioMarketContext from '../../hooks/usePortfolioMarketContext';
import { isTradingDay } from '../../utils/marketHolidays';
import { getSecurityQuadPlaybookRanking } from '../../utils/quadPlaybookRanking';
import { normalizeResearchDate } from '../../utils/researchDateFormat';
import { securityIntelligencePayload } from '../../utils/securityIntelligenceResponses';
import usePortfolioResearch from '../../hooks/usePortfolioResearch';
import { RESEARCH_HISTORY_DAYS } from '../../constants/portfolioResearch';
import PortfolioResearchPanel from './portfolio/PortfolioResearchPanel';
import PortfolioPositionsCard, { HoldingMarkWarning } from './portfolio/PortfolioPositionsCard';
import usePortfolioPositions from './portfolio/usePortfolioPositions';
import {
  formatPct, getAssetClassForTicker, getPortfolioWeight, getQuadExposureLabels, holdingSourceTitle,
} from './portfolio/portfolioPositionsModel';
import {
  SECURITY_RESEARCH_EXCLUDED_PRODUCTS,
  asArray,
  buildCanonicalResearchProductRows,
  buildResearchProductRows,
  formatResearchDateLabel,
  getResearchDatumDate,
  getResearchProductId,
  historicalResearchDisplayRow,
  normalizeResearchReferenceText,
  researchReferenceText,
  researchSourceLabel,
} from './portfolio/portfolioResearchRows';
import LeveragedProductModal from './portfolio/LeveragedProductModal';
import { buildBetaVerification } from './portfolio/betaPresentation';
import { buildStopLossPresentation } from './portfolio/stopLossPresentation';
import { calculateStopPrice } from '../../utils/signalWeightedPositionSizing';
import { buildUsdCorrelationPresentation } from './portfolio/usdCorrelationPresentation';
import {
  buildSizingVolatilityPresentation,
  buildSizingVolatilityVerification,
} from './portfolio/sizingVolatilityPresentation';
import { SECURITY_INTELLIGENCE_V2_ENABLED } from '../../hooks/useSecurityIntelligence';
import { isCanonicalSecurityIntelligence } from '../../utils/securityIntelligenceV2';
import { normalizeResearchBias } from '../../utils/researchBias.cjs';
import { isExplicitTradeProvenance } from '../../utils/publishedResearchSignals.cjs';
import { useSurfaceActivity } from '../common/PersistentSurface';
import useQuadResearch from '../../hooks/useQuadResearch';
import useHedgaiTickResearch from '../../hooks/useHedgaiTickResearch';
import PortfolioMetricVerificationModal from './portfolio/PortfolioMetricVerificationModal';
import PortfolioFactorQuadMatrix from './PortfolioFactorQuadMatrix';
import PortfolioQuadReference from './PortfolioQuadReference';
import { getPortfolioExposureValuation } from '../../utils/portfolioExposureValuation';
import { isRefreshDelayedVolatilityRow } from '../../utils/volatilitySnapshotRows';
import {
  buildPortfolioQuadExposure,
} from '../../utils/portfolioFactorExposure';
import './PortfolioConstructionIdeas.css';
// Feature overrides must follow the shared portfolio cell styles.
import './portfolio/LeveragedProducts.css';
import './portfolio/PortfolioResearchProducts.css';
import './portfolio/PortfolioResearchHistory.css';
import './portfolio/PortfolioDecisionMetrics.css';
import './portfolio/PortfolioMarketContext.css';
import './portfolio/PortfolioMetricVerificationModal.css';

// Preserve the existing helper export for callers while its implementation moves.
export { calculateLeveragedProductsFitScale } from './portfolio/LeveragedProductsCell';

const ASSET_CLASS_COLORS = {
  'Equities': '#059669',      // Emerald green
  'Fixed Income': '#3B82F6',  // Blue
  'Commodities': '#F97316',   // Orange
  'FX': '#8B5CF6',            // Violet (includes Gold, USD, and other currencies)
  'Currencies': '#8B5CF6',    // Violet (alias for FX)
  'Cryptocurrency': '#F59E0B', // Amber
  'Managed Futures': '#64748B',
  'CASH': '#6B7280',          // Neutral gray
  // Note: "Other" category has been removed - all holdings are now properly classified
};

const LIVE_PORTFOLIO_MAX_AGE_MS = 5 * 60 * 1000;
const LIVE_MARK_MAX_AGE_MS = 60 * 1000;
const LIVE_EVIDENCE_FUTURE_TOLERANCE_MS = 5 * 1000;

const isFreshLiveEvidence = (value, maxAgeMs, nowMs = Date.now()) => {
  const observedMs = Date.parse(String(value || ''));
  if (!Number.isFinite(observedMs)) return false;
  const ageMs = nowMs - observedMs;
  return ageMs >= -LIVE_EVIDENCE_FUTURE_TOLERANCE_MS && ageMs <= maxAgeMs;
};

const hasForbiddenLiveFlag = (value) => Boolean(
  value
  && (
    value.cacheOnly === true
    || value.cached === true
    || value.fromCache === true
    || value.mock === true
    || value.isMock === true
    || value.seed === true
    || value.seeded === true
    || value.isSeed === true
    || value.stale === true
  )
);

// The API's productCoverage array is authoritative. This small mirror only
// keeps the fail-closed UI useful before a first response (or after a request
// failure), without introducing another request or coupling the bundle to
// the infra-only registry file.
const RESEARCH_FALLBACK_PRODUCTS = Object.freeze([
  ['risk-ranges', 'Risk Ranges', 'market_day_0800'],
  ['early-look', 'Early Look', 'event_driven'],
  ['bitcoin-trend-tracker', 'Bitcoin Tracker', 'event_driven'],
  ['portfolio-solutions', 'Portfolio Solutions', 'event_driven'],
  ['momo-tracker', 'MOMO Tracker', 'event_driven'],
  ['signal-strength', 'Signal Strength', 'event_driven'],
  ['signal-strength-shorts', 'Signal Strength Shorts', 'event_driven'],
  ['real-time-alert', 'Real-Time Alerts', 'event_driven'],
  ['the-macro-show', 'Macro Show', 'event_driven'],
  ['the-call', 'The Call', 'event_driven'],
  ['etf-pro', 'ETF Pro', 'event_driven'],
  ['investing-ideas', 'Investing Ideas', 'event_driven'],
]);
const DIRECT_RESEARCH_MATCH_TYPES = new Set(['direct', 'direct_alias']);
const VOLATILITY_INDEX_META = Object.freeze({
  VIX: Object.freeze({ key: 'VIX', label: 'VIX', symbol: 'VIX' }),
  RVX: Object.freeze({ key: 'RVX', label: 'RVX', symbol: 'RVX' }),
  NazVol: Object.freeze({ key: 'NazVol', label: 'NAZVOL', symbol: 'VXN' }),
  GVZ: Object.freeze({ key: 'GVZ', label: 'GVZ', symbol: 'GVZ' }),
  OVX: Object.freeze({ key: 'OVX', label: 'OVX', symbol: 'OVX' }),
  MOVE: Object.freeze({ key: 'MOVE', label: 'MOVE', symbol: 'MOVE' }),
});
const NASDAQ_VOL_SYMBOLS = new Set(['COMPQ', 'NDX', 'QQQ', 'TQQQ']);
const NASDAQ_MEGA_CAP_SYMBOLS = new Set([
  'AAPL',
  'AMZN',
  'GOOG',
  'GOOGL',
  'META',
  'MSFT',
  'NFLX',
  'NVDA',
  'TSLA',
]);
const BROAD_US_VOL_SYMBOLS = new Set([
  'DIA',
  'RSP',
  'SPX',
  'SPY',
  'XLB',
  'XLC',
  'XLE',
  'XLF',
  'XLI',
  'XLK',
  'XLP',
  'XLRE',
  'XLU',
  'XLV',
  'XLY',
]);
const RUSSELL_VOL_SYMBOLS = new Set(['IWM', 'RUT']);
const GOLD_VOL_SYMBOLS = new Set(['AAAU', 'GLD', 'GOLD', 'IAU']);
const OIL_VOL_SYMBOLS = new Set(['BNO', 'BRENT', 'OVX', 'USO', 'WTIC']);
const RATES_VOL_SYMBOLS = new Set([
  'AGG',
  'BND',
  'IEF',
  'SHY',
  'TLT',
  'UST10Y',
  'UST2Y',
  'UST30Y',
]);
const USD_CORRELATION_PROXY_BY_SYMBOL = Object.freeze({
  AAAU: 'GOLD',
  BITCOIN: 'BTC',
  BTC: 'BTC',
  CRB: 'CRB',
  DBC: 'CRB',
  GLD: 'GOLD',
  GOLD: 'GOLD',
  IAU: 'GOLD',
  IBIT: 'BTC',
  GBTC: 'BTC',
  PDBC: 'CRB',
  SPX: 'SPX',
  SPY: 'SPX',
  BNO: 'BRENT',
  BRENT: 'BRENT',
});
const UNTRUSTED_RESEARCH_STATUSES = new Set([
  'cache',
  'cache_only',
  'cached',
  'disconnected',
  'error',
  'failed',
  'invalid',
  'missing',
  'mock',
  'seed',
  'stale',
  'unavailable',
  'unsupported',
]);

const latestExpectedResearchDate = (now = new Date()) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const cursor = new Date(`${values.year}-${values.month}-${values.day}T12:00:00Z`);
  while (!isTradingDay(cursor)) {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return cursor.toISOString().slice(0, 10);
};

const formatContextTimestamp = (value) => {
  if (!value) return 'Time unavailable';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return 'Time unavailable';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZoneName: 'short',
  }).format(parsed);
};

const getRelevantVolatilityIndexes = (symbol) => {
  const normalized = String(symbol || '').trim().toUpperCase();
  if (NASDAQ_VOL_SYMBOLS.has(normalized)) return [VOLATILITY_INDEX_META.NazVol];
  if (NASDAQ_MEGA_CAP_SYMBOLS.has(normalized)) {
    return [VOLATILITY_INDEX_META.NazVol, VOLATILITY_INDEX_META.VIX];
  }
  if (RUSSELL_VOL_SYMBOLS.has(normalized)) return [VOLATILITY_INDEX_META.RVX];
  if (GOLD_VOL_SYMBOLS.has(normalized)) return [VOLATILITY_INDEX_META.GVZ];
  if (OIL_VOL_SYMBOLS.has(normalized)) return [VOLATILITY_INDEX_META.OVX];
  if (RATES_VOL_SYMBOLS.has(normalized)) return [VOLATILITY_INDEX_META.MOVE];
  if (BROAD_US_VOL_SYMBOLS.has(normalized)) return [VOLATILITY_INDEX_META.VIX];
  return [];
};

const metricToneForValue = (value) => {
  const normalized = String(value || '').trim().toUpperCase();
  if (['ADDED', 'BULLISH', 'BUY', 'FULL', 'LONG', 'POSITIVE'].includes(normalized)) {
    return 'is-positive';
  }
  if (['BEARISH', 'PARTIAL', 'REMOVED', 'SELL', 'SHORT', 'SHORTS ADDED', 'SHORTS LISTED', 'UNAVAILABLE'].includes(normalized)) {
    return 'is-negative';
  }
  if (['HISTORICAL', 'REFERENCE'].includes(normalized)) {
    return 'is-reference';
  }
  if (normalized === 'NEUTRAL') return 'is-neutral';
  return '';
};

const zScoreToneForValue = (value) => {
  const numeric = finiteOptionalNumber(value);
  if (numeric === null || Math.abs(numeric) < 0.5) return 'is-neutral';
  const direction = numeric > 0 ? 'positive' : 'negative';
  const magnitude = Math.abs(numeric);
  if (magnitude >= 2) return `is-${direction}-strong`;
  if (magnitude >= 1) return `is-${direction}`;
  return `is-${direction}-soft`;
};

// Beta is a signed number like any other: positive green, negative red, zero plain.
const betaToneForValue = (value) => {
  const numeric = finiteOptionalNumber(value);
  if (numeric === null || numeric === 0) return 'is-neutral';
  return numeric > 0 ? 'is-positive' : 'is-negative';
};

const stopToneForDistance = ({ stop, mark, atr, quantity }) => {
  const stopValue = finiteOptionalNumber(stop);
  const markValue = finiteOptionalNumber(mark);
  const atrValue = finiteOptionalNumber(atr);
  const position = finiteOptionalNumber(quantity);
  if (
    stopValue === null
    || markValue === null
    || atrValue === null
    || atrValue <= 0
    || position === null
    || position === 0
  ) return 'is-neutral';
  const distanceInAtr = (position > 0 ? markValue - stopValue : stopValue - markValue) / atrValue;
  if (distanceInAtr <= 0) return 'is-negative-strong';
  if (distanceInAtr < 0.5) return 'is-negative';
  if (distanceInAtr < 1) return 'is-negative-soft';
  if (distanceInAtr >= 2) return 'is-positive-strong';
  return 'is-positive';
};

const formatVerificationDecimal = (value) => {
  const numeric = finiteOptionalNumber(value);
  if (numeric === null) return 'Unavailable';
  return numeric.toLocaleString(undefined, {
    minimumFractionDigits: Math.abs(numeric) < 0.01 ? 6 : 2,
    maximumFractionDigits: 8,
  });
};

const formatVerificationCurrency = (value) => {
  const numeric = finiteOptionalNumber(value);
  if (numeric === null) return 'Unavailable';
  return `$${numeric.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
};

const getResearchStatus = (datum) => String(
  datum?.qualityStatus
  || datum?.status
  || datum?.source?.qualityStatus
  || datum?.source?.status
  || ''
).trim().toLowerCase();

const isUntrustedResearchDatum = (datum) => {
  const statuses = [datum?.status, datum?.qualityStatus, datum?.source?.status, datum?.source?.qualityStatus]
    .map(status => String(status || '').trim().toLowerCase());
  return Boolean(
    statuses.some(status => UNTRUSTED_RESEARCH_STATUSES.has(status))
    || datum?.stale === true
    || datum?.fromCache === true
    || datum?.cacheOnly === true
    || datum?.mock === true
    || datum?.seed === true
    || datum?.verified === false
    || datum?.source?.verified === false
  );
};

const isVerifiedResearchReference = (datum, { historical = false } = {}) => {
  if (!datum || typeof datum !== 'object' || isUntrustedResearchDatum(datum)) return false;
  const status = getResearchStatus(datum);
  return historical
    ? ['indexed', 'validated'].includes(status)
    : ['indexed', 'available'].includes(status);
};

const isVerifiedCurrentDecisionDatum = (datum, marketDate, kind) => {
  if (!datum || typeof datum !== 'object') return false;
  if (getResearchDatumDate(datum) !== marketDate || isUntrustedResearchDatum(datum)) return false;
  // Availability and publication validation are independent canonical fields.
  // A validated source cannot make an unavailable decision current, and an
  // indexed source does not make an available decision unavailable.
  if (String(datum.status || '').trim().toLowerCase() !== 'available') return false;
  if ([datum.qualityStatus, datum.source?.qualityStatus]
    .filter(status => status != null && String(status).trim())
    .some(status => !['indexed', 'validated'].includes(String(status).trim().toLowerCase()))) return false;

  const productId = getResearchProductId(datum);
  if (kind === 'trade' && !isExplicitTradeProvenance(datum.signalProvenance)) return false;
  if ((kind === 'trend' || kind === 'riskRange') && !/risk[-_\s]*ranges?/.test(productId)) return false;

  if (kind === 'riskRange' || kind === 'trend') {
    const sourceType = String(datum.sourceType || datum.rangeType || datum.source?.type || '').toLowerCase();
    if (sourceType && !['primary', 'risk-range', 'risk-ranges'].includes(sourceType)) return false;
    if (kind === 'riskRange' && datum.decisionEligible !== true) return false;
    if (datum.manifestVerified === false) return false;
  }
  return true;
};

const isVerifiedHistoricalDecisionDatum = (datum, kind) => {
  if (!datum || typeof datum !== 'object' || isUntrustedResearchDatum(datum)) return false;
  if (
    !['historical', 'reference'].includes(String(datum.status || '').toLowerCase())
    || !['indexed', 'validated'].includes(String(datum.qualityStatus || '').toLowerCase())
    || datum.referenceOnly !== true
    || datum.executable !== false
    || !getResearchDatumDate(datum)
  ) {
    return false;
  }

  const productId = getResearchProductId(datum);
  if (kind === 'trade' && !isExplicitTradeProvenance(datum.signalProvenance)) return false;
  if ((kind === 'trend' || kind === 'riskRange') && !/risk[-_\s]*ranges?/.test(productId)) return false;
  if (kind === 'riskRange') {
    const lrr = finiteOptionalNumber(datum.lrr ?? datum.value?.lrr);
    const hrr = finiteOptionalNumber(datum.hrr ?? datum.value?.hrr);
    if (
      lrr === null
      || hrr === null
      || lrr > hrr
      || datum.publicationDecisionEligible !== true
      || datum.currentDecisionEligible !== false
      || datum.decisionEligible !== false
    ) {
      return false;
    }
  }
  return true;
};

const researchValue = (datum, fields = []) => {
  if (!datum || typeof datum !== 'object') return null;
  for (const field of fields) {
    const value = datum[field];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
};

const CONTROLLED_EXPOSURE_TYPES = new Set([
  'factor',
  'sector',
  'country',
  'commodity',
  'macro',
]);

const normalizeControlledExposureTags = (values) => {
  const tags = asArray(values).map((value) => {
    if (typeof value === 'string' && value.trim()) {
      const id = value.trim().toLowerCase();
      return { id, type: null, label: value.trim() };
    }
    if (!value || typeof value !== 'object') return null;
    const id = String(value.id || value.exposureId || value.exposure || '').trim().toLowerCase();
    const type = String(value.type || value.exposureType || '').trim().toLowerCase();
    if (!id || !CONTROLLED_EXPOSURE_TYPES.has(type)) return null;
    return {
      id,
      type,
      label: String(value.label || id).trim(),
    };
  }).filter(Boolean);
  return [...new Map(tags.map((tag) => [`${tag.type || 'legacy'}:${tag.id}`, tag])).values()];
};

const exposureTypeLabel = (value) => (
  String(value || '').replace(/(^|[-_\s])(\w)/g, (_match, prefix, letter) => (
    `${prefix ? ' ' : ''}${letter.toUpperCase()}`
  ))
);

const PortfolioBreakdown = ({
  portfolioData,
  isLoading = false,
  isRefreshing = false,
  onRefresh = null,
}) => {
  const active = useSurfaceActivity();
  const { estimates: quadResearch } = useQuadResearch({ active });
  const { readings: tickReadings } = useHedgaiTickResearch({ active });
  const holdings = useMemo(() => portfolioData?.holdings || [], [portfolioData?.holdings]);

  const holdingRowIds = useMemo(() => {
    const ids = new Map();
    const seen = new Map();
    holdings.forEach((holding) => {
      const symbol = String(holding?.symbol || 'unknown').trim().toUpperCase();
      const side = Number(holding?.quantity ?? holding?.position ?? holding?.shares) < 0 ? 'short' : 'long';
      const account = holding?.accountId || holding?.account || holding?.accountNumber || 'account';
      const contract = holding?.positionId || holding?.conid || holding?.contractId || holding?.localSymbol || 'position';
      const currency = holding?.currency || 'currency';
      const base = [side, account, contract, symbol, currency]
        .map((part) => String(part).replace(/[^a-zA-Z0-9_-]+/g, '-'))
        .join('-');
      const ordinal = seen.get(base) || 0;
      seen.set(base, ordinal + 1);
      ids.set(holding, `${base}-${ordinal}`);
    });
    return ids;
  }, [holdings]);

  const [expandedResearchRows, setExpandedResearchRows] = useState(() => new Set());
  const [expandedResearchProducts, setExpandedResearchProducts] = useState(() => new Set());
  const toggleResearchProduct = useCallback((expansionKey) => {
    setExpandedResearchProducts((current) => {
      const next = new Set(current);
      if (next.has(expansionKey)) next.delete(expansionKey);
      else next.add(expansionKey);
      return next;
    });
  }, []);
  const [metricVerification, setMetricVerification] = useState(null);
  const closeMetricVerification = useCallback(() => setMetricVerification(null), []);
  const [leveragedProductModal, setLeveragedProductModal] = useState(null);
  const closeLeveragedProductModal = useCallback(() => setLeveragedProductModal(null), []);
  const [factorExposureDimension, setFactorExposureDimension] = useState('equityStyleFactors');
  const [selectedFactorExposureId, setSelectedFactorExposureId] = useState(null);
  const [manualResearchRefreshKey, setManualResearchRefreshKey] = useState(0);
  const researchProductRowsCacheRef = useRef(new WeakMap());
  const researchFallbackPayloadRef = useRef({});


  const researchSymbols = useMemo(() => [...new Set(
    holdings
      .map((holding) => String(holding?.symbol || '').trim().toUpperCase())
      .filter(Boolean)
  )].sort(), [holdings]);
  const researchSymbolsKey = researchSymbols.join(',');

  const [, setLiveEvidenceTick] = useState(0);
  const liveEvidenceExpiryAt = useMemo(() => {
    const expirations = [
      [portfolioData?.fetchedAt, LIVE_PORTFOLIO_MAX_AGE_MS],
      [portfolioData?.socketVerifiedAt, LIVE_PORTFOLIO_MAX_AGE_MS],
      [portfolioData?.accountSummary?.lastUpdated, LIVE_PORTFOLIO_MAX_AGE_MS],
      [portfolioData?.accountSummary?.socketVerifiedAt, LIVE_PORTFOLIO_MAX_AGE_MS],
      ...holdings.map((holding) => [holding?.priceObservedAt, LIVE_MARK_MAX_AGE_MS]),
    ].map(([value, maxAgeMs]) => {
      const observedMs = Date.parse(String(value || ''));
      return Number.isFinite(observedMs) ? observedMs + maxAgeMs : null;
    }).filter(Number.isFinite);
    return expirations.length > 0 ? Math.min(...expirations) : null;
  }, [
    holdings,
    portfolioData?.fetchedAt,
    portfolioData?.socketVerifiedAt,
    portfolioData?.accountSummary?.lastUpdated,
    portfolioData?.accountSummary?.socketVerifiedAt,
  ]);

  useEffect(() => {
    if (!active || !Number.isFinite(liveEvidenceExpiryAt)) return undefined;
    const delayMs = liveEvidenceExpiryAt - Date.now() + 25;
    if (delayMs <= 0) return undefined;
    const timeoutId = window.setTimeout(() => {
      // Expire sizing locally even if the normal portfolio refresh is delayed
      // or hung. The next render re-evaluates every timestamp against Date.now.
      setLiveEvidenceTick((value) => value + 1);
    }, Math.min(delayMs, 2_147_483_647));
    return () => window.clearTimeout(timeoutId);
  }, [active, liveEvidenceExpiryAt]);


  const { researchState, researchMarketDate, invalidateHistory } = usePortfolioResearch({
    active,
    symbolsKey: researchSymbolsKey,
    expandedRowCount: expandedResearchRows.size,
    refreshKey: manualResearchRefreshKey,
  });

  const { marketContextState, getPositionSizeReference, loadPriorityRiskMetrics } = usePortfolioMarketContext({
    active,
    symbolsKey: researchSymbolsKey,
    holdings,
    refreshKey: manualResearchRefreshKey,
  });

  const handleManualRefresh = useCallback(() => {
    invalidateHistory();
    setManualResearchRefreshKey((current) => current + 1);
    if (typeof onRefresh === 'function') {
      Promise.resolve(onRefresh()).catch(() => {
        // Portfolio connection errors are rendered by the owning dashboard.
        // Research refresh remains independent and fail-closed.
      });
    }
  }, [invalidateHistory, onRefresh]);

  useEffect(() => {
    const validRowIds = new Set(holdingRowIds.values());
    setExpandedResearchRows((current) => {
      const next = new Set([...current].filter((rowId) => validRowIds.has(rowId)));
      return next.size === current.size ? current : next;
    });
  }, [holdingRowIds]);

  const totalValue = portfolioData?.summary?.totalValue || 0;
  const hasVerifiedPortfolioMarks = Boolean(
    portfolioData?.dataSource === 'ibkr_api'
    && portfolioData?.liveSessionVerified === true
    && portfolioData?.fromCache === false
  );
  const hasVerifiedLiveNav = Boolean(
    hasVerifiedPortfolioMarks
    && portfolioData?.accountSummary?.source === 'ibkr_live_session'
    && finiteOptionalNumber(portfolioData?.accountSummary?.netLiquidation) > 0
    && isFreshLiveEvidence(portfolioData?.fetchedAt, LIVE_PORTFOLIO_MAX_AGE_MS)
    && isFreshLiveEvidence(portfolioData?.socketVerifiedAt, LIVE_PORTFOLIO_MAX_AGE_MS)
    && isFreshLiveEvidence(
      portfolioData?.accountSummary?.lastUpdated,
      LIVE_PORTFOLIO_MAX_AGE_MS,
    )
    && isFreshLiveEvidence(
      portfolioData?.accountSummary?.socketVerifiedAt,
      LIVE_PORTFOLIO_MAX_AGE_MS,
    )
    && portfolioData?.dataQuality?.status === 'ok'
    && portfolioData?.dataQuality?.markState === 'live'
    && !hasForbiddenLiveFlag(portfolioData)
    && !hasForbiddenLiveFlag(portfolioData?._cache)
    && !hasForbiddenLiveFlag(portfolioData?.dataQuality)
  );
  const canUseHoldingForSizing = useCallback((holding) => Boolean(
    hasVerifiedLiveNav
    && holding?.priceState === 'live'
    && holding?.marketValueState === 'live'
    && holding?.priceSource === 'ibkr_live_last'
    && holding?.positionSource === 'ibkr_live_session'
    && holding?.markPending !== true
    && !holding?.markFailure
    && !hasForbiddenLiveFlag(holding)
    && isFreshLiveEvidence(holding?.priceObservedAt, LIVE_MARK_MAX_AGE_MS)
    && finiteOptionalNumber(holding?.price) > 0
    && finiteOptionalNumber(holding?.marketValue) !== null
  ), [hasVerifiedLiveNav]);

  const factorValuation = getPortfolioExposureValuation(portfolioData, { loading: isLoading });
  const factorExposureAvailable = factorValuation.available;
  const factorExposure = buildPortfolioQuadExposure(
    factorValuation.holdings, portfolioData?.accountSummary?.netLiquidation,
    factorExposureAvailable, factorValuation.unavailableHoldings,
  );
  useEffect(() => {
    if (!active || !factorValuation.expiresAt) return undefined;
    const timeout = window.setTimeout(() => setLiveEvidenceTick(value => value + 1),
      Math.max(25, factorValuation.expiresAt - Date.now() + 25));
    return () => window.clearTimeout(timeout);
  }, [active, factorValuation.expiresAt]);

  // Column visibility state (shared for both tables)
  // Default selection: % Acct, % Portfolio, Buy/Sell, Intraday G/L
  const [columnVisibility, setColumnVisibility] = useState({
    qty: false,
    price: false,
    marketValue: false,
    pctAccount: true,
    basisPts: false,
    percentPortfolio: true,
    qtyNeeded: true,
    intradayGainLoss: true,
    gainLoss: false
  });

  // Refs for measuring filter button widths to match search input width
  const longsButtonRowRef = useRef(null);
  const shortsButtonRowRef = useRef(null);
  const longsInputRef = useRef(null);
  const shortsInputRef = useRef(null);

  // Update search input width to match button row width
  useEffect(() => {
    if (!active) return undefined;
    const updateWidths = () => {
      if (longsButtonRowRef.current && longsInputRef.current) {
        longsInputRef.current.style.width = `${longsButtonRowRef.current.offsetWidth}px`;
      }
      if (shortsButtonRowRef.current && shortsInputRef.current) {
        shortsInputRef.current.style.width = `${shortsButtonRowRef.current.offsetWidth}px`;
      }
    };

    updateWidths();
    window.addEventListener('resize', updateWidths);
    return () => window.removeEventListener('resize', updateWidths);
  }, [active, columnVisibility]);

  // Sorting state for longs and shorts tables
  const [longsSortConfig, setLongsSortConfig] = useState({ field: null, direction: 'desc' });
  const [shortsSortConfig, setShortsSortConfig] = useState({ field: null, direction: 'desc' });

  // Search filters for tickers
  const [longsSearchFilter, setLongsSearchFilter] = useState('');
  const [shortsSearchFilter, setShortsSearchFilter] = useState('');
  // Column order state (Intraday G/L after Mkt Value by default, % Portfolio after Basis Pts)
  const [columnOrder, setColumnOrder] = useState([
    'qty',
    'price',
    'marketValue',
    'intradayGainLoss', // Moved after Mkt Value
    'pctAccount',
    'basisPts',
    'percentPortfolio', // Moved to right after Basis Pts
    'qtyNeeded',
    'gainLoss'
  ]);

  // Column definitions for toggle buttons
  const columnDefinitions = [
    { key: 'qty', label: 'Qty' },
    { key: 'price', label: 'Price' },
    { key: 'marketValue', label: 'Mkt Value' },
    { key: 'pctAccount', label: '% Portfolio' },
    { key: 'basisPts', label: 'Basis Pts' },
    { key: 'percentPortfolio', label: 'Δ Portfolio' },
    { key: 'qtyNeeded', label: 'Buy/Sell' },
    { key: 'intradayGainLoss', label: 'Day G/L' },
    { key: 'gainLoss', label: 'Total G/L' }
  ];

  // Drag and drop handlers for column reordering
  const [draggedColumn, setDraggedColumn] = useState(null);
  const [dragOverColumn, setDragOverColumn] = useState(null);

  const handleDragStart = (e, columnKey) => {
    setDraggedColumn(columnKey);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragEnd = (e) => {
    // Reset dragged element opacity
    e.target.style.opacity = '1';
    setDraggedColumn(null);
    setDragOverColumn(null);
  };

  const handleDragOver = (e, columnKey) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (columnKey !== draggedColumn) {
      setDragOverColumn(columnKey);
    }
  };

  const handleDragLeave = (e) => {
    // Only clear if we're actually leaving the element (not just moving to a child)
    if (!e.currentTarget.contains(e.relatedTarget)) {
      setDragOverColumn(null);
    }
  };

  const handleDrop = (e, targetColumnKey) => {
    e.preventDefault();
    if (!draggedColumn || draggedColumn === targetColumnKey) {
      setDraggedColumn(null);
      setDragOverColumn(null);
      return;
    }

    const newOrder = [...columnOrder];
    const draggedIndex = newOrder.indexOf(draggedColumn);
    const targetIndex = newOrder.indexOf(targetColumnKey);

    // Remove dragged column and insert at target position
    newOrder.splice(draggedIndex, 1);
    newOrder.splice(targetIndex, 0, draggedColumn);

    setColumnOrder(newOrder);
    setDraggedColumn(null);
    setDragOverColumn(null);
  };

  // Toggle column visibility
  const toggleColumn = (columnKey) => {
    setColumnVisibility(prev => ({
      ...prev,
      [columnKey]: !prev[columnKey]
    }));
  };

  // Render column header based on column key
  const renderColumnHeader = (columnKey, isLongs) => {
    const sortConfig = isLongs ? longsSortConfig : shortsSortConfig;
    const handleSortClick = (field) => handleSort(field, isLongs);

    // Map column keys to sort fields
    const columnToSortField = {
      'qty': null,
      'price': null,
      'marketValue': 'marketValue',
      'intradayGainLoss': 'intradayGainLoss',
      'pctAccount': 'pctAccount',
      'basisPts': null,
      'percentPortfolio': null,
      'qtyNeeded': null,
      'gainLoss': 'gainLoss'
    };

    const sortField = columnToSortField[columnKey];
    const isSorted = sortField && sortConfig.field === sortField;
    const isDragged = draggedColumn === columnKey;
    const isDragTarget = dragOverColumn === columnKey && !isDragged;

    // Base styles with conditional styling
    const getBaseStyles = (defaultStyles) => ({
      ...defaultStyles,
      ...(isDragged && {
        outline: '2px solid #3b82f6',
        outlineOffset: '-2px',
        borderRadius: '4px',
        opacity: 0.5
      }),
      ...(isDragTarget && {
        backgroundColor: '#374151',
        borderRadius: '4px',
        transition: 'background-color 0.2s'
      }),
      ...(isSorted && !isDragged && !isDragTarget && {
        backgroundColor: '#eff6ff',
        borderRadius: '4px'
      })
    });

    // Get className with dark mode support
    const getClassName = () => {
      let className = 'dark:text-white';
      if (isDragTarget) {
        className += ' dark:bg-blue-900';
      } else if (isSorted && !isDragged && !isDragTarget) {
        className += ' dark:bg-blue-800';
      }
      return className;
    };

    switch (columnKey) {
      case 'qty':
        return (
          <th
            key={columnKey}
            draggable
            onDragStart={(e) => handleDragStart(e, columnKey)}
            onDragEnd={handleDragEnd}
            onDragOver={(e) => handleDragOver(e, columnKey)}
            onDragLeave={handleDragLeave}
            onDrop={(e) => handleDrop(e, columnKey)}
            style={getBaseStyles({ padding: '6px', textAlign: 'center', fontWeight: 600, width: '8%', cursor: 'move' })}
            className={getClassName()}
          >
            Qty
          </th>
        );
      case 'price':
        return (
          <th
            key={columnKey}
            draggable
            onDragStart={(e) => handleDragStart(e, columnKey)}
            onDragEnd={handleDragEnd}
            onDragOver={(e) => handleDragOver(e, columnKey)}
            onDragLeave={handleDragLeave}
            onDrop={(e) => handleDrop(e, columnKey)}
            style={getBaseStyles({ padding: '6px', textAlign: 'center', fontWeight: 600, width: '10%', cursor: 'move' })}
            className={getClassName()}
          >
            Price
          </th>
        );
      case 'marketValue':
        return (
          <th
            key={columnKey}
            draggable
            onDragStart={(e) => handleDragStart(e, columnKey)}
            onDragEnd={handleDragEnd}
            onDragOver={(e) => handleDragOver(e, columnKey)}
            onDragLeave={handleDragLeave}
            onDrop={(e) => handleDrop(e, columnKey)}
            style={getBaseStyles({ padding: '6px', textAlign: 'center', fontWeight: 600, cursor: 'pointer', userSelect: 'none', position: 'relative', width: '12%' })}
            className={getClassName()}
            onClick={() => handleSortClick('marketValue')}
          >
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', position: 'relative' }}>
              <div>Mkt</div>
              <div>Value</div>
              <span style={{ position: 'absolute', bottom: '2px', right: '2px', fontSize: '10px', opacity: 0.5 }}>{renderSortIndicator('marketValue', sortConfig)}</span>
            </div>
          </th>
        );
      case 'intradayGainLoss':
        return (
          <th
            key={columnKey}
            draggable
            onDragStart={(e) => handleDragStart(e, columnKey)}
            onDragEnd={handleDragEnd}
            onDragOver={(e) => handleDragOver(e, columnKey)}
            onDragLeave={handleDragLeave}
            onDrop={(e) => handleDrop(e, columnKey)}
            style={getBaseStyles({ padding: '6px', textAlign: 'center', fontWeight: 600, cursor: 'pointer', userSelect: 'none', position: 'relative', width: '11%' })}
            className={getClassName()}
            onClick={() => handleSortClick('intradayGainLoss')}
          >
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', position: 'relative' }}>
              <div>Day</div>
              <div>G/L</div>
              <span style={{ position: 'absolute', bottom: '2px', right: '2px', fontSize: '10px', opacity: 0.5 }}>{renderSortIndicator('intradayGainLoss', sortConfig)}</span>
            </div>
          </th>
        );
      case 'pctAccount':
        return (
          <th
            key={columnKey}
            draggable
            onDragStart={(e) => handleDragStart(e, columnKey)}
            onDragEnd={handleDragEnd}
            onDragOver={(e) => handleDragOver(e, columnKey)}
            onDragLeave={handleDragLeave}
            onDrop={(e) => handleDrop(e, columnKey)}
            style={getBaseStyles({ padding: '6px', textAlign: 'center', fontWeight: 600, cursor: 'pointer', userSelect: 'none', position: 'relative', width: '8%' })}
            className={getClassName()}
            onClick={() => handleSortClick('pctAccount')}
          >
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', position: 'relative' }}>
              <div>%</div>
              <div>Portfolio</div>
              <span style={{ position: 'absolute', bottom: '2px', right: '2px', fontSize: '10px', opacity: 0.5 }}>{renderSortIndicator('pctAccount', sortConfig)}</span>
            </div>
          </th>
        );
      case 'basisPts':
        return (
          <th
            key={columnKey}
            draggable
            onDragStart={(e) => handleDragStart(e, columnKey)}
            onDragEnd={handleDragEnd}
            onDragOver={(e) => handleDragOver(e, columnKey)}
            onDragLeave={handleDragLeave}
            onDrop={(e) => handleDrop(e, columnKey)}
            style={getBaseStyles({ padding: '6px', textAlign: 'center', fontWeight: 600, width: '9%', cursor: 'move' })}
            className={getClassName()}
          >
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <div>Basis</div>
              <div>Pts</div>
            </div>
          </th>
        );
      case 'percentPortfolio':
        return (
          <th
            key={columnKey}
            draggable
            onDragStart={(e) => handleDragStart(e, columnKey)}
            onDragEnd={handleDragEnd}
            onDragOver={(e) => handleDragOver(e, columnKey)}
            onDragLeave={handleDragLeave}
            onDrop={(e) => handleDrop(e, columnKey)}
            style={getBaseStyles({ padding: '6px', textAlign: 'center', fontWeight: 600, width: '10%', cursor: 'move' })}
            className={getClassName()}
          >
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <div>Δ</div>
              <div>Portfolio</div>
            </div>
          </th>
        );
      case 'qtyNeeded':
        return (
          <th
            key={columnKey}
            draggable
            onDragStart={(e) => handleDragStart(e, columnKey)}
            onDragEnd={handleDragEnd}
            onDragOver={(e) => handleDragOver(e, columnKey)}
            onDragLeave={handleDragLeave}
            onDrop={(e) => handleDrop(e, columnKey)}
            style={getBaseStyles({ padding: '6px', textAlign: 'center', fontWeight: 600, width: '10%', cursor: 'move' })}
            className={getClassName()}
          >
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <div>Buy/Sell</div>
            </div>
          </th>
        );
      case 'gainLoss':
        return (
          <th
            key={columnKey}
            draggable
            onDragStart={(e) => handleDragStart(e, columnKey)}
            onDragEnd={handleDragEnd}
            onDragOver={(e) => handleDragOver(e, columnKey)}
            onDragLeave={handleDragLeave}
            onDrop={(e) => handleDrop(e, columnKey)}
            style={getBaseStyles({ padding: '6px', textAlign: 'center', fontWeight: 600, cursor: 'pointer', userSelect: 'none', position: 'relative', width: '10%' })}
            className={getClassName()}
            onClick={() => handleSortClick('gainLoss')}
          >
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', position: 'relative' }}>
              <div>Total</div>
              <div>G/L</div>
              <span style={{ position: 'absolute', bottom: '2px', right: '2px', fontSize: '10px', opacity: 0.5 }}>{renderSortIndicator('gainLoss', sortConfig)}</span>
            </div>
          </th>
        );
      default:
        return null;
    }
  };

  // Render column cell based on column key
  const renderColumnCell = (columnKey, holding, pctOfAccount, isLongs) => {
    const basisPointsState = isLongs ? longsBasisPoints : shortsBasisPoints;
    const setBasisPointsState = isLongs ? setLongsBasisPoints : setShortsBasisPoints;

    switch (columnKey) {
      case 'qty':
        return (
          <td key={columnKey} style={{ padding: isLongs ? '6px 4px 6px 2px' : '6px', textAlign: 'center' }} className="dark:text-gray-300">
            {isLongs ? Math.abs(holding.quantity || 0) : `-${Math.abs(holding.quantity || 0)}`}
          </td>
        );
      case 'price':
        return (
          <td key={columnKey} style={{ padding: '6px', textAlign: 'center' }} className="dark:text-gray-300">
            ${parseFloat(holding.price || 0).toFixed(2)}
          </td>
        );
      case 'marketValue':
        return (
          <td key={columnKey} style={{ padding: '6px', textAlign: 'center' }} className="dark:text-gray-300">
            ${Math.abs(holding.marketValue || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </td>
        );
      case 'intradayGainLoss':
        return React.cloneElement(renderPerformanceCell(holding.dayChangePercent), { key: columnKey });
      case 'pctAccount':
        return (
          <td key={columnKey} style={{ padding: '6px', textAlign: 'center' }} className="dark:text-gray-300">
            {pctOfAccount}%
          </td>
        );
      case 'basisPts':
        return (
          <td key={columnKey} style={{ padding: '6px', textAlign: 'center' }}>
            <div style={{ position: 'relative', display: 'inline-block' }}>
              <input
                type="number"
                step="25"
                placeholder="bps"
                value={basisPointsState[holding.symbol] || ''}
                onChange={(e) => {
                  const value = e.target.value;
                  setBasisPointsState(prev => ({
                    ...prev,
                    [holding.symbol]: value === '' ? undefined : value
                  }));
                }}
                onKeyDown={(e) => {
                  // Prevent arrow keys from incrementing by 1
                  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                    e.preventDefault();
                    const current = parseFloat(basisPointsState[holding.symbol]) || 0;
                    const increment = e.key === 'ArrowUp' ? 25 : -25;
                    setBasisPointsState(prev => ({
                      ...prev,
                      [holding.symbol]: current + increment
                    }));
                  }
                }}
                style={{
                  width: '60px',
                  padding: '4px 20px 4px 4px',
                  fontSize: '10px',
                  border: '1px solid #d1d5db',
                  borderRadius: '4px',
                  textAlign: 'center',
                  MozAppearance: 'textfield' // Firefox: hide spinner
                }}
                className="dark:bg-gray-700 dark:border-gray-600 dark:text-white [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
              />
              <div style={{ position: 'absolute', right: '2px', top: '50%', transform: 'translateY(-50%)', display: 'flex', flexDirection: 'column', gap: '1px' }}>
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    const current = parseFloat(basisPointsState[holding.symbol]) || 0;
                    setBasisPointsState(prev => ({
                      ...prev,
                      [holding.symbol]: current + 25
                    }));
                  }}
                  style={{
                    width: '14px',
                    height: '10px',
                    padding: 0,
                    border: 'none',
                    background: 'transparent',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '8px',
                    color: '#6b7280'
                  }}
                  className="dark:text-gray-400 hover:dark:text-gray-200"
                >
                  ▲
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    const current = parseFloat(basisPointsState[holding.symbol]) || 0;
                    setBasisPointsState(prev => ({
                      ...prev,
                      [holding.symbol]: current - 25
                    }));
                  }}
                  style={{
                    width: '14px',
                    height: '10px',
                    padding: 0,
                    border: 'none',
                    background: 'transparent',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '8px',
                    color: '#6b7280'
                  }}
                  className="dark:text-gray-400 hover:dark:text-gray-200"
                >
                  ▼
                </button>
              </div>
            </div>
          </td>
        );
      case 'percentPortfolio': {
        const percentPortfolioState = isLongs ? longsPercentPortfolio : shortsPercentPortfolio;
        const setPercentPortfolioState = isLongs ? setLongsPercentPortfolio : setShortsPercentPortfolio;
        const currentPctAcct = parseFloat(pctOfAccount) || 0;
        const basisPoints = parseFloat(basisPointsState[holding.symbol]) || 0;
        const basisPointsAsPercent = basisPoints / 100;
        const targetPercent = percentPortfolioState[holding.symbol];

        // Use target % if set, otherwise calculate from basis points
        const displayPercent = targetPercent !== undefined
          ? parseFloat(targetPercent)
          : currentPctAcct + basisPointsAsPercent;

        // Check if this input is currently being edited
        const editingKey = `${isLongs ? 'long' : 'short'}_${holding.symbol}`;
        const isEditing = editingPercentPortfolio[editingKey] !== undefined;
        const editingValue = editingPercentPortfolio[editingKey];

        return (
          <td key={columnKey} style={{ padding: '6px', textAlign: 'center' }}>
            <div style={{ position: 'relative', display: 'inline-block' }}>
              <input
                type="text"
                inputMode="decimal"
                pattern="[0-9]*\.?[0-9]*"
                placeholder="%"
                value={isEditing ? editingValue : displayPercent.toFixed(2)}
                onFocus={(e) => {
                  // Start editing - store current value as string
                  setEditingPercentPortfolio(prev => ({
                    ...prev,
                    [editingKey]: displayPercent.toFixed(2)
                  }));
                  // Select all text on focus for easy replacement
                  e.target.select();
                }}
                onChange={(e) => {
                  const value = e.target.value;
                  // Allow any input while typing (including intermediate states like "2." or empty)
                  // Only allow digits and one decimal point
                  if (value === '' || /^\d*\.?\d*$/.test(value)) {
                    setEditingPercentPortfolio(prev => ({
                      ...prev,
                      [editingKey]: value
                    }));
                  }
                }}
                onBlur={(e) => {
                  const value = e.target.value;
                  // Clear editing state
                  setEditingPercentPortfolio(prev => {
                    const newState = { ...prev };
                    delete newState[editingKey];
                    return newState;
                  });

                  if (value === '') {
                    // Clear the target percent
                    setPercentPortfolioState(prev => {
                      const newState = { ...prev };
                      delete newState[holding.symbol];
                      return newState;
                    });
                    setBasisPointsState(prev => {
                      const newState = { ...prev };
                      delete newState[holding.symbol];
                      return newState;
                    });
                  } else {
                    const numValue = parseFloat(value);
                    if (!isNaN(numValue)) {
                      // Store value rounded to 2 decimal places
                      const roundedValue = Math.round(numValue * 100) / 100;
                      setPercentPortfolioState(prev => ({
                        ...prev,
                        [holding.symbol]: roundedValue
                      }));
                      // Clear basis points when setting target %
                      setBasisPointsState(prev => {
                        const newState = { ...prev };
                        delete newState[holding.symbol];
                        return newState;
                      });
                    }
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.target.blur();
                  } else if (e.key === 'Escape') {
                    // Cancel editing - restore original value
                    setEditingPercentPortfolio(prev => {
                      const newState = { ...prev };
                      delete newState[editingKey];
                      return newState;
                    });
                    e.target.blur();
                  } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                    e.preventDefault();
                    const current = parseFloat(isEditing ? editingValue : displayPercent.toFixed(2)) || 0;
                    // Round to 2 decimal places first to avoid floating point issues
                    const rounded = Math.round(current * 100) / 100;
                    // Check if current value is a multiple of 0.10 (last digit in hundredths place is 0)
                    const isMultipleOfTen = Math.round(rounded * 100) % 10 === 0;
                    // If at a rounded 10, increment by 0.10, otherwise by 0.01
                    const increment = isMultipleOfTen ? 0.10 : 0.01;
                    let newValue;
                    if (e.key === 'ArrowUp') {
                      newValue = Math.round((rounded + increment) * 100) / 100;
                    } else {
                      newValue = Math.round((rounded - increment) * 100) / 100;
                    }
                    // Update editing value if editing, otherwise update state directly
                    if (isEditing) {
                      setEditingPercentPortfolio(prev => ({
                        ...prev,
                        [editingKey]: newValue.toFixed(2)
                      }));
                    }
                    setPercentPortfolioState(prev => ({
                      ...prev,
                      [holding.symbol]: newValue
                    }));
                    // Clear basis points when setting target %
                    setBasisPointsState(prev => {
                      const newState = { ...prev };
                      delete newState[holding.symbol];
                      return newState;
                    });
                  }
                }}
                style={{
                  width: '60px',
                  padding: '4px 20px 4px 4px',
                  fontSize: '10px',
                  border: '1px solid #d1d5db',
                  borderRadius: '4px',
                  textAlign: 'center',
                  MozAppearance: 'textfield' // Firefox: hide spinner
                }}
                className="dark:bg-gray-700 dark:border-gray-600 dark:text-white [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
              />
              <div style={{ position: 'absolute', right: '2px', top: '50%', transform: 'translateY(-50%)', display: 'flex', flexDirection: 'column', gap: '1px' }}>
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    const current = parseFloat(targetPercent !== undefined ? targetPercent : displayPercent) || 0;
                    // Round to 2 decimal places first to avoid floating point issues
                    const rounded = Math.round(current * 100) / 100;
                    // Check if current value is a multiple of 0.10 (last digit in hundredths place is 0)
                    const isMultipleOfTen = Math.round(rounded * 100) % 10 === 0;
                    // If at a rounded 10, increment by 0.10, otherwise by 0.01
                    const increment = isMultipleOfTen ? 0.10 : 0.01;
                    const newValue = Math.round((rounded + increment) * 100) / 100;
                    setPercentPortfolioState(prev => ({
                      ...prev,
                      [holding.symbol]: newValue
                    }));
                    // Clear basis points when setting target %
                    setBasisPointsState(prev => {
                      const newState = { ...prev };
                      delete newState[holding.symbol];
                      return newState;
                    });
                  }}
                  style={{
                    width: '14px',
                    height: '10px',
                    padding: 0,
                    border: 'none',
                    background: 'transparent',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '8px',
                    color: '#6b7280'
                  }}
                  className="dark:text-gray-400 hover:dark:text-gray-200"
                >
                  ▲
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    const current = parseFloat(targetPercent !== undefined ? targetPercent : displayPercent) || 0;
                    // Round to 2 decimal places first to avoid floating point issues
                    const rounded = Math.round(current * 100) / 100;
                    // Check if current value is a multiple of 0.10 (last digit in hundredths place is 0)
                    const isMultipleOfTen = Math.round(rounded * 100) % 10 === 0;
                    // If at a rounded 10, decrement by 0.10, otherwise by 0.01
                    const decrement = isMultipleOfTen ? 0.10 : 0.01;
                    const newValue = Math.round((rounded - decrement) * 100) / 100;
                    setPercentPortfolioState(prev => ({
                      ...prev,
                      [holding.symbol]: newValue
                    }));
                    // Clear basis points when setting target %
                    setBasisPointsState(prev => {
                      const newState = { ...prev };
                      delete newState[holding.symbol];
                      return newState;
                    });
                  }}
                  style={{
                    width: '14px',
                    height: '10px',
                    padding: 0,
                    border: 'none',
                    background: 'transparent',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '8px',
                    color: '#6b7280'
                  }}
                  className="dark:text-gray-400 hover:dark:text-gray-200"
                >
                  ▼
                </button>
              </div>
            </div>
          </td>
        );
      }
      case 'qtyNeeded': {
        const percentPortfolioStateForQty = isLongs ? longsPercentPortfolio : shortsPercentPortfolio;
        const targetPercentForQty = percentPortfolioStateForQty[holding.symbol];
        const basisPointsForQty = basisPointsState[holding.symbol];

        return (
          <td key={columnKey} style={{ padding: '6px', textAlign: 'center', fontWeight: '600' }}>
            {(() => {
              let shares = null;

              // Prioritize target % portfolio over basis points
              if (targetPercentForQty !== undefined) {
                shares = calculateSharesFromPercent(holding, targetPercentForQty, totalValue, !isLongs);
              } else if (basisPointsForQty) {
                shares = calculateSharesFromBasisPoints(holding, basisPointsForQty, totalValue, !isLongs);
              }

              if (shares === null) return <span className="dark:text-gray-400">--</span>;
              if (shares === 0) return <span className="dark:text-gray-300">0</span>;

              // Format with color: negative (red) = sell, positive (green) = buy
              if (shares < 0) {
                return <span className="text-red-500 dark:text-red-400">{shares}</span>;
              } else {
                return <span className="text-green-500 dark:text-green-400">+{shares}</span>;
              }
            })()}
          </td>
        );
      }
      case 'gainLoss':
        return React.cloneElement(renderPerformanceCell(holding.gainLossPercent), { key: columnKey });
      default:
        return null;
    }
  };

  // State for basis points and % portfolio inputs for each holding
  // Separate longs and shorts
  const { longs, shorts } = useMemo(() => {
    return separateLongsAndShorts(holdings);
  }, [holdings]);

  const positions = usePortfolioPositions({
    longs, shorts, totalValue, hasVerifiedPortfolioMarks, canUseHoldingForSizing,
    factorSelection: {
      available: factorExposureAvailable,
      dimension: factorExposureDimension,
      id: selectedFactorExposureId,
    },
  });
  const {
    longsBasisPoints, setLongsBasisPoints, longsPercentPortfolio, setLongsPercentPortfolio,
    shortsBasisPoints, setShortsBasisPoints, shortsPercentPortfolio, setShortsPercentPortfolio,
    editingPercentPortfolio, setEditingPercentPortfolio,
    calculateSharesFromBasisPoints, calculateSharesFromPercent,
  } = positions.legacySizing;

  // Helper function to sort holdings
  const sortHoldings = useCallback((holdings, sortConfig) => {
    if (!sortConfig.field) return holdings;

    return [...holdings].sort((a, b) => {
      let aValue, bValue;

      switch (sortConfig.field) {
        case 'ticker':
          aValue = (a.symbol || '').toUpperCase();
          bValue = (b.symbol || '').toUpperCase();
          if (sortConfig.direction === 'asc') {
            return aValue.localeCompare(bValue);
          } else {
            return bValue.localeCompare(aValue);
          }
        case 'marketValue':
          aValue = Math.abs(parseFloat(a.marketValue) || 0);
          bValue = Math.abs(parseFloat(b.marketValue) || 0);
          break;
        case 'pctAccount':
          aValue = totalValue > 0 ? ((Math.abs(a.marketValue) / totalValue) * 100) : 0;
          bValue = totalValue > 0 ? ((Math.abs(b.marketValue) / totalValue) * 100) : 0;
          break;
        case 'intradayGainLoss':
          aValue = parseFloat(a.dayChangePercent) || 0;
          bValue = parseFloat(b.dayChangePercent) || 0;
          break;
        case 'gainLoss':
          aValue = parseFloat(a.gainLossPercent) || 0;
          bValue = parseFloat(b.gainLossPercent) || 0;
          break;
        default:
          return 0;
      }

      if (sortConfig.direction === 'asc') {
        return aValue - bValue;
      } else {
        return bValue - aValue;
      }
    });
  }, [totalValue]);

  // Handle sort click
  const handleSort = (field, isLongs) => {
    const currentConfig = isLongs ? longsSortConfig : shortsSortConfig;
    const setConfig = isLongs ? setLongsSortConfig : setShortsSortConfig;

    if (currentConfig.field === field) {
      // Toggle direction if same field
      setConfig({
        field,
        direction: currentConfig.direction === 'desc' ? 'asc' : 'desc'
      });
    } else {
      // New field, default to descending
      setConfig({ field, direction: 'desc' });
    }
  };

  // Render sort indicator
  const renderSortIndicator = (field, sortConfig) => {
    if (sortConfig.field !== field) {
      return <span style={{ opacity: 0.3 }}>⇅</span>;
    }
    return (
      <span>
        {sortConfig.direction === 'desc' ? '↓' : '↑'}
      </span>
    );
  };

  // Apply filtering and sorting to longs and shorts
  const sortedLongs = useMemo(() => {
    const filtered = longsSearchFilter
      ? longs.filter(holding =>
        holding.symbol?.toUpperCase().includes(longsSearchFilter.toUpperCase())
      )
      : longs;
    return sortHoldings(filtered, longsSortConfig);
  }, [longs, longsSortConfig, longsSearchFilter, sortHoldings]);

  const sortedShorts = useMemo(() => {
    const filtered = shortsSearchFilter
      ? shorts.filter(holding =>
        holding.symbol?.toUpperCase().includes(shortsSearchFilter.toUpperCase())
      )
      : shorts;
    return sortHoldings(filtered, shortsSortConfig);
  }, [shorts, shortsSortConfig, shortsSearchFilter, sortHoldings]);

  const hasLivePortfolio = Boolean(
    portfolioData
    && (
      holdings.length > 0
      || totalValue !== 0
      || portfolioData?.accountSummary?.netLiquidation
    )
  );
  const portfolioAvailabilityLabel = !hasLivePortfolio && isLoading
    ? 'Connecting to live portfolio…'
    : null;

  // Render performance cell without color coding
  const renderPerformanceCell = (value) => {
    const formatted = formatPerformance(value);

    // Determine color based on value
    let colorClass = 'text-gray-500';
    if (value !== null && value !== undefined && !isNaN(value)) {
      const num = parseFloat(value);
      if (num > 0) {
        colorClass = 'text-green-500 dark:text-green-400';
      } else if (num < 0) {
        colorClass = 'text-red-500 dark:text-red-400';
      }
    }

    return (
      <td
        style={{
          padding: '6px',
          textAlign: 'center',
          fontWeight: '500'
        }}
        className={colorClass}
      >
        {formatted}
      </td>
    );
  };

  const renderHoldingWarningIcon = (holding) => <HoldingMarkWarning holding={holding} />;

  const researchPayload = securityIntelligencePayload(researchState.data);
  const canonicalResearchPayload = isCanonicalSecurityIntelligence(researchPayload)
    ? researchPayload
    : null;
  const canonicalResearchRequestFailed = SECURITY_INTELLIGENCE_V2_ENABLED
    && researchState.status === 'error'
    && researchState.symbolsKey === researchSymbolsKey;
  const researchEnvelopeStatus = String(
    researchPayload?.coverage?.state || researchPayload?.status || ''
  ).toLowerCase();
  const expectedResearchMarketDate = latestExpectedResearchDate();
  const researchEnvelopeIsRetained = Boolean(
    researchPayload
    && ['loading', 'error'].includes(researchState.status)
  );
  const researchEnvelopeIsCurrent = Boolean(
    ['ready', 'loading', 'error'].includes(researchState.status)
    && researchPayload
    && normalizeResearchDate(researchPayload?.marketDate) === expectedResearchMarketDate
    && researchMarketDate === expectedResearchMarketDate
    && !UNTRUSTED_RESEARCH_STATUSES.has(researchEnvelopeStatus)
  );

  const getSymbolResearch = (symbol) => {
    const normalizedSymbol = String(symbol || '').trim().toUpperCase();
    return researchPayload?.bySymbol?.[normalizedSymbol]
      || researchPayload?.securities?.[normalizedSymbol]
      || null;
  };

  const normalizeReferences = (values, defaultMatchType = 'direct', inheritedDate = null) => {
    const normalized = [];
    const visit = (value, matchType, parentDate) => {
      if (!value) return;
      if (Array.isArray(value)) {
        value.forEach((item) => visit(item, matchType, parentDate));
        return;
      }
      if (typeof value !== 'object') return;

      const itemDate = normalizeResearchDate(
        value.marketDate || value.sourceDate || value.contentDate || value.date || parentDate
      );
      const nested = [
        ...asArray(value.directReferences),
        ...asArray(value.inferredReferences),
        ...asArray(value.references),
        ...asArray(value.events),
      ];
      if (nested.length > 0 && !value.excerpt && !value.description && !value.summary && !value.headline) {
        asArray(value.directReferences).forEach((item) => visit(item, 'direct', itemDate));
        asArray(value.inferredReferences).forEach((item) => visit(item, 'inferred_exposure', itemDate));
        asArray(value.references).forEach((item) => visit(item, matchType, itemDate));
        asArray(value.events).forEach((item) => visit(item, matchType, itemDate));
        return;
      }

      normalized.push({
        ...value,
        marketDate: itemDate,
        matchType: value.matchType || matchType,
      });
    };
    visit(values, defaultMatchType, inheritedDate);
    return normalized;
  };

  const uniqueReferences = (references) => {
    const seen = new Set();
    return references.filter((reference) => {
      const excerpt = reference.excerpt || reference.description || reference.summary || reference.headline || '';
      const key = reference.id
        || reference.eventId
        || reference.hash
        || [
          reference.marketDate,
          getResearchProductId(reference),
          reference.kind,
          reference.direction,
          reference.matchType,
          excerpt,
        ].join('|');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  const getCurrentReferences = (entry) => {
    if (!entry || !researchEnvelopeIsCurrent) return [];
    const references = [
      ...normalizeReferences(entry.directReferences, 'direct'),
      ...normalizeReferences(entry.todayReferences, 'direct'),
      ...normalizeReferences(entry.current?.references, 'direct'),
    ];
    return uniqueReferences(references).filter((reference) => (
      getResearchDatumDate(reference) === researchMarketDate
      && DIRECT_RESEARCH_MATCH_TYPES.has(String(reference?.matchType || '').trim().toLowerCase())
      && isVerifiedResearchReference(reference)
    ));
  };

  const getHistoricalReferences = (entry) => {
    if (!entry) return [];
    const history = [
      ...normalizeReferences(entry.history, 'direct'),
      ...normalizeReferences(entry.historicalReferences, 'direct'),
    ];
    return uniqueReferences(history)
      .filter((reference) => {
        const date = getResearchDatumDate(reference);
        return date
          && date !== researchMarketDate
          && DIRECT_RESEARCH_MATCH_TYPES.has(String(reference?.matchType || '').trim().toLowerCase())
          && isVerifiedResearchReference(reference, { historical: true });
      })
      .sort((a, b) => String(getResearchDatumDate(b)).localeCompare(String(getResearchDatumDate(a))));
  };

  const formatResearchNumber = (value) => {
    const number = Number(value);
    if (!Number.isFinite(number)) return value === null || value === undefined || value === '' ? '—' : String(value);
    return number.toLocaleString(undefined, { maximumFractionDigits: 2 });
  };


  const getControlledOtherExposures = (entry) => normalizeControlledExposureTags(entry?.exposures)
    .filter((exposure) => exposure.type && exposure.type !== 'factor');


  const renderSecurityResearch = (holding, rowId) => {
    const symbol = String(holding?.symbol || '').trim().toUpperCase();
    const tickReading = tickReadings[symbol];
    const tickEvidence = tickReading?.verified === true ? tickReading.tickEvidence : null;
    const tickValue = tickEvidence
      ? tickEvidence.position === 'Wait' ? 'Wait' : tickReading.tick
      : null;
    const sourceStatus = marketContextState.sourceStatus || {};
    const riskMetricsSourceStatus = sourceStatus.riskMetrics || marketContextState.status;
    const volatilitySourceStatus = sourceStatus.volatility || marketContextState.status;
    const usdCorrelationSourceStatus = sourceStatus.usdCorrelations || marketContextState.status;
    const riskMetricsLoading = (
      ['loading', 'partial'].includes(riskMetricsSourceStatus)
      && !marketContextState.errors?.riskMetrics
    );
    const volatilityLoading = ['loading', 'idle'].includes(volatilitySourceStatus);
    const usdCorrelationLoading = ['loading', 'idle'].includes(usdCorrelationSourceStatus);
    const entry = getSymbolResearch(symbol);
    const canonicalSecurity = canonicalResearchPayload && entry?.products ? entry : null;
    const canonicalHealth = canonicalSecurity?.health || null;
    const canonicalHealthLabel = canonicalHealth?.status
      || (canonicalResearchRequestFailed ? 'unavailable' : null);
    const decision = entry?.decision || entry?.signals || entry?.current?.decision || {};
    const lastVerifiedDecision = entry?.lastVerifiedDecision || {};
    const trade = decision.trade || entry?.trade;
    const trend = decision.trend || entry?.trend;
    const riskRange = decision.riskRange || entry?.riskRange;
    const signalStrength = decision.signalStrength || entry?.signalStrength;
    const signalStrengthShorts = decision.signalStrengthShorts || entry?.signalStrengthShorts;
    const supplementalRange = entry?.supplementalRange || entry?.earlyLookRange;
    const currentReferences = getCurrentReferences(entry);
    const historicalReferences = getHistoricalReferences(entry);

    const canonicalPortfolioSolutionsProduct = canonicalSecurity?.products?.['portfolio-solutions'];
    const canonicalPortfolioSolutionsField = canonicalPortfolioSolutionsProduct?.status === 'available'
      ? canonicalPortfolioSolutionsProduct.fields?.trade || canonicalPortfolioSolutionsProduct.fields?.trend
      : null;
    const portfolioSolutionsProductIndexed = canonicalPortfolioSolutionsProduct
      ? canonicalPortfolioSolutionsProduct.pipelineStatus === 'indexed'
        && canonicalPortfolioSolutionsProduct.status === 'available'
      : asArray(researchPayload?.products).some((product) => (
        String(product?.id || '').trim().toLowerCase() === 'portfolio-solutions'
        && String(product?.status || '').trim().toLowerCase() === 'indexed'
      ));
    const portfolioSolutionsReference = portfolioSolutionsProductIndexed
      ? currentReferences.find((reference) => (
        getResearchProductId(reference) === 'portfolio-solutions'
        && String(reference?.kind || '').trim().toLowerCase() === 'portfolio_solutions_rank'
        && finiteOptionalNumber(reference?.value) !== null
      ))
      : null;
    const portfolioSolutionsDatum = canonicalPortfolioSolutionsField
      && String(canonicalPortfolioSolutionsField.value || '').trim().toUpperCase() === 'BULLISH'
      ? {
        ...canonicalPortfolioSolutionsField,
        status: 'available',
        productId: 'portfolio-solutions',
        productLabel: canonicalPortfolioSolutionsProduct.label || 'Portfolio Solutions',
        sourceId: 'portfolio-solutions',
        sourceLabel: canonicalPortfolioSolutionsProduct.label || 'Portfolio Solutions',
        sourceDate: canonicalPortfolioSolutionsField.marketDate || canonicalPortfolioSolutionsProduct.marketDate,
        marketDate: canonicalPortfolioSolutionsField.marketDate || canonicalPortfolioSolutionsProduct.marketDate,
        value: canonicalPortfolioSolutionsField.value,
        referenceOnly: true,
        decisionEligible: false,
      }
      : portfolioSolutionsReference
        ? {
          ...portfolioSolutionsReference,
          status: 'available',
          productId: 'portfolio-solutions',
          productLabel: portfolioSolutionsReference.productLabel || 'Portfolio Solutions',
          sourceId: 'portfolio-solutions',
          sourceLabel: portfolioSolutionsReference.productLabel || 'Portfolio Solutions',
          sourceDate: portfolioSolutionsReference.marketDate,
          value: 'BULLISH',
          referenceOnly: true,
          decisionEligible: false,
        }
        : null;

    const currentVerifiedTrade = researchEnvelopeIsCurrent
      && isVerifiedCurrentDecisionDatum(trade, researchMarketDate, 'trade') ? trade : null;
    const currentVerifiedTrend = researchEnvelopeIsCurrent
      && isVerifiedCurrentDecisionDatum(trend, researchMarketDate, 'trend') ? trend : null;
    const currentVerifiedRiskRange = researchEnvelopeIsCurrent
      && isVerifiedCurrentDecisionDatum(riskRange, researchMarketDate, 'riskRange') ? riskRange : null;
    const currentVerifiedSignalStrength = researchEnvelopeIsCurrent
      && isVerifiedCurrentDecisionDatum(signalStrength, researchMarketDate, 'signalStrength') ? signalStrength : null;
    const historicalVerifiedTrade = !currentVerifiedTrade
      && isVerifiedHistoricalDecisionDatum(lastVerifiedDecision.trade, 'trade')
      ? lastVerifiedDecision.trade
      : null;
    const historicalVerifiedTrend = !currentVerifiedTrend
      && isVerifiedHistoricalDecisionDatum(lastVerifiedDecision.trend, 'trend')
      ? lastVerifiedDecision.trend
      : null;
    const historicalVerifiedRiskRange = !currentVerifiedRiskRange
      && isVerifiedHistoricalDecisionDatum(lastVerifiedDecision.riskRange, 'riskRange')
      ? lastVerifiedDecision.riskRange
      : null;
    const historicalVerifiedSignalStrength = !currentVerifiedSignalStrength
      && isVerifiedHistoricalDecisionDatum(lastVerifiedDecision.signalStrength, 'signalStrength')
      ? lastVerifiedDecision.signalStrength
      : null;
    // Signal Strength Shorts is its own list; it fills the cell only when the long list has no reading.
    const currentVerifiedSignalStrengthShorts = researchEnvelopeIsCurrent
      && isVerifiedCurrentDecisionDatum(signalStrengthShorts, researchMarketDate, 'signalStrength') ? signalStrengthShorts : null;
    const historicalVerifiedSignalStrengthShorts = !currentVerifiedSignalStrengthShorts
      && isVerifiedHistoricalDecisionDatum(lastVerifiedDecision.signalStrengthShorts, 'signalStrength')
      ? lastVerifiedDecision.signalStrengthShorts
      : null;
    const verifiedTrade = currentVerifiedTrade || historicalVerifiedTrade;
    const verifiedTrend = currentVerifiedTrend || portfolioSolutionsDatum || historicalVerifiedTrend;
    const verifiedRiskRange = currentVerifiedRiskRange || historicalVerifiedRiskRange;
    const verifiedLongSignalStrength = currentVerifiedSignalStrength || historicalVerifiedSignalStrength;
    const verifiedSignalStrength = verifiedLongSignalStrength
      || currentVerifiedSignalStrengthShorts
      || historicalVerifiedSignalStrengthShorts;
    const tradeIsReference = Boolean(
      historicalVerifiedTrade
      || (currentVerifiedTrade && researchEnvelopeIsRetained),
    );
    const trendIsReference = Boolean(
      historicalVerifiedTrend
      || (!currentVerifiedTrend && portfolioSolutionsDatum)
      || (currentVerifiedTrend && researchEnvelopeIsRetained),
    );
    const signalIsReference = verifiedLongSignalStrength
      ? Boolean(historicalVerifiedSignalStrength || (currentVerifiedSignalStrength && researchEnvelopeIsRetained))
      : Boolean(historicalVerifiedSignalStrengthShorts || (currentVerifiedSignalStrengthShorts && researchEnvelopeIsRetained));
    const verifiedSupplementalRange = researchEnvelopeIsCurrent
      && supplementalRange
      && typeof supplementalRange === 'object'
      && getResearchDatumDate(supplementalRange) === researchMarketDate
      && !isUntrustedResearchDatum(supplementalRange)
      && getResearchStatus(supplementalRange) === 'available'
      && supplementalRange.decisionEligible === false
      ? supplementalRange
      : null;

    const coverageState = String(
      entry?.coverage?.state || entry?.state || researchEnvelopeStatus || 'unavailable'
    ).toLowerCase();
    const coverageReasons = [
      ...asArray(entry?.coverage?.reasons),
      ...asArray(entry?.unavailableReasons),
    ].filter(Boolean);
    const otherExposures = getControlledOtherExposures(entry);
    const positionSizeReference = getPositionSizeReference(symbol);
    const {
      beta,
      riskMetrics,
    } = positionSizeReference;
    const atr14 = riskMetrics?.atr14?.status === 'available'
      && finiteOptionalNumber(riskMetrics.atr14.value) !== null ? riskMetrics.atr14 : null;
    const zScore20 = riskMetrics?.zScore20?.status === 'available'
      && finiteOptionalNumber(riskMetrics.zScore20.value) !== null ? riskMetrics.zScore20 : null;
    const factorContribution = getPortfolioWeight(holding, totalValue);
    const researchInitialLoading = researchState.status === 'loading' && !researchPayload;

    const tradeValue = normalizeResearchBias(
      researchValue(verifiedTrade, ['value', 'signal', 'trade']),
    );
    const trendValue = normalizeResearchBias(
      researchValue(verifiedTrend, ['value', 'trend', 'signal']),
    );
    const signalReading = researchValue(verifiedSignalStrength, ['value', 'action', 'change', 'state']);
    const signalValue = signalReading && !verifiedLongSignalStrength ? `SHORTS ${signalReading}` : signalReading;
    const quadClassification = getSecurityQuadPlaybookRanking(holding);
    const quadRanking = quadClassification.ranking;
    const primaryRangeProduct = canonicalSecurity?.products?.['risk-ranges'];
    const rangeSources = [
      researchPayload, researchPayload?._cache, entry, currentVerifiedRiskRange,
      currentVerifiedRiskRange?.source, currentVerifiedRiskRange?.value,
      primaryRangeProduct, primaryRangeProduct?.fields?.riskRange,
    ];
    const rangeSourceAvailable = Boolean(
      researchState.status === 'ready'
      && !researchState.error
      && currentVerifiedRiskRange
      && (!canonicalSecurity || (
        primaryRangeProduct?.status === 'available'
        && primaryRangeProduct.pipelineStatus === 'indexed'
      ))
      && rangeSources.every((source) => (
        !hasForbiddenLiveFlag(source)
        && !isUntrustedResearchDatum(source)
        && source?.connected !== false
      ))
    );
    const rangeLow = finiteOptionalNumber(
      currentVerifiedRiskRange?.lrr ?? currentVerifiedRiskRange?.low
      ?? currentVerifiedRiskRange?.value?.lrr ?? currentVerifiedRiskRange?.value?.low
    );
    const rangeHigh = finiteOptionalNumber(
      currentVerifiedRiskRange?.hrr ?? currentVerifiedRiskRange?.high
      ?? currentVerifiedRiskRange?.value?.hrr ?? currentVerifiedRiskRange?.value?.high
    );
    const rangeAvailable = rangeSourceAvailable
      && rangeLow !== null && rangeHigh !== null && rangeLow <= rangeHigh;
    const rangeMeta = rangeAvailable
      ? `Risk Ranges · ${formatResearchDateLabel(getResearchDatumDate(currentVerifiedRiskRange))}`
      : researchState.status === 'loading' ? 'Loading published risk range' : 'Published risk range unavailable';

    const quantity = finiteOptionalNumber(
      holding?.quantity ?? holding?.position ?? holding?.shares
    );
    const averageCost = finiteOptionalNumber(holding?.avgCost ?? holding?.averageCost);
    const stopReferenceEligible = Boolean(
      atr14
      && averageCost !== null
      && averageCost > 0
      && quantity !== null
      && quantity !== 0
      && portfolioData?.liveSessionVerified === true
      && ['ibkr_live_session', 'ibkr_completed_session_reference'].includes(
        portfolioData?.accountSummary?.source
      )
      && ['ibkr_api', 'ibkr_live_session'].includes(holding?.positionSource)
    );
    const stopReference = stopReferenceEligible
      ? calculateStopPrice({ basis: averageCost, atr14: Number(atr14.value), side: quantity < 0 ? 'SHORT' : 'LONG' })
      : null;
    const holdingReferenceMark = (
      stopReferenceEligible
      && ['live', 'historical_close'].includes(String(holding?.priceState || '').toLowerCase())
    )
      ? finiteOptionalNumber(holding?.price)
      : null;
    const stopTone = stopToneForDistance({
      stop: stopReference,
      mark: holdingReferenceMark,
      atr: atr14?.value,
      quantity,
    });
    const betaCovariance = finiteOptionalNumber(beta?.calculation?.covarianceSum);
    const betaBenchmarkVariance = finiteOptionalNumber(
      beta?.calculation?.benchmarkVarianceSum
    );
    const betaHasCalculation = beta && betaCovariance !== null && betaBenchmarkVariance !== null;
    const betaVerification = buildBetaVerification({
      symbol,
      beta,
      covarianceLabel: betaHasCalculation ? formatVerificationDecimal(betaCovariance) : null,
      benchmarkVarianceLabel: betaHasCalculation ? formatVerificationDecimal(betaBenchmarkVariance) : null,
      asOfLabel: beta ? formatResearchDateLabel(beta.asOf) : null,
    });
    const stopLossModel = buildStopLossPresentation({
      symbol,
      isShort: quantity !== null && quantity < 0,
      hasAtr: Boolean(atr14),
      reference: stopReference === null ? null : {
        value: stopReference,
        averageCostLabel: formatVerificationCurrency(averageCost),
        atrLabel: formatVerificationCurrency(atr14?.value),
        resultLabel: formatVerificationCurrency(stopReference),
        asOfLabel: formatResearchDateLabel(atr14?.asOf),
        tone: stopTone,
      },
    });

    const volatilityIndexes = getRelevantVolatilityIndexes(symbol);
    const validVolatilityRows = volatilityIndexes.map((definition) => {
      const row = marketContextState.volatility?.[definition.key];
      const value = finiteOptionalNumber(row?.lastPx ?? row?.value ?? row?.price);
      const current = (
        row?.availability === 'available'
        && row?.freshness === 'current'
      );
      const historicalClose = (
        definition.key === 'MOVE'
        && row?.availability === 'historical'
        && row?.freshness === 'historical'
        && row?.quoteMode === 'end-of-day'
      );
      const refreshDelayed = isRefreshDelayedVolatilityRow(row);
      return value !== null && (current || historicalClose || refreshDelayed)
        ? { definition, row, value, historicalClose, refreshDelayed }
        : null;
    }).filter(Boolean);
    const volatilityValue = volatilityIndexes.length === 0
      ? 'N/A'
      : validVolatilityRows.length === 0
        ? volatilityLoading ? '…' : 'Unavailable'
        : validVolatilityRows
          .map(({ definition, value }) => `${definition.label} ${Number(value).toFixed(2)}`)
          .join(' · ');
    const volatilityMeta = volatilityIndexes.length === 0
      ? 'No controlled vol-index mapping'
      : validVolatilityRows.length === 0
        ? 'Mapped source unavailable'
        : [
          validVolatilityRows.map(({ definition }) => definition.symbol).join(' / '),
          validVolatilityRows.some(({ refreshDelayed }) => refreshDelayed)
            ? `Refresh delayed · last verified ${formatContextTimestamp(validVolatilityRows[0].row?.lastVerifiedAt || validVolatilityRows[0].row?.asOf)}`
            : validVolatilityRows.some(({ historicalClose }) => historicalClose)
            ? `Close · ${formatResearchDateLabel(validVolatilityRows[0].row?.asOf)}`
            : formatContextTimestamp(validVolatilityRows[0].row?.asOf || validVolatilityRows[0].row?.timestamp),
        ].join(' · ');
    const volatilityReadings = validVolatilityRows.map(({ definition, row, value, historicalClose, refreshDelayed }) => ({
      key: definition.key,
      label: definition.label,
      value: Number(value).toFixed(2),
      marker: {
        status: refreshDelayed ? 'refresh-delayed' : historicalClose ? 'historical' : 'live',
        title: refreshDelayed
          ? `Refresh delayed · last verified ${formatContextTimestamp(row?.lastVerifiedAt || row?.asOf)}`
          : `Historical reference · as of ${formatContextTimestamp(row?.asOf)}`,
        updatedAt: row?.lastVerifiedAt || row?.asOf || row?.timestamp,
      },
    }));

    const usdProxy = USD_CORRELATION_PROXY_BY_SYMBOL[symbol] || null;
    const usdPayload = marketContextState.usdCorrelations;
    const usdRow = usdProxy && usdPayload?.sourceStatus === 'current'
      ? usdPayload?.correlations?.[usdProxy]
      : null;
    const usdCorrelation = finiteOptionalNumber(usdRow?.['30D'] ?? usdRow?.['1M']);
    const usdCorrelationModel = buildUsdCorrelationPresentation({
      proxy: usdProxy,
      correlation: usdCorrelation,
      loading: usdCorrelationLoading,
      asOfLabel: usdProxy && usdCorrelation !== null ? formatResearchDateLabel(usdPayload.calculationDate) : null,
    });

    const currentDateLabel = formatResearchDateLabel(expectedResearchMarketDate);
    const decisionSourceMeta = (datum, isReference, fallback) => {
      if (!datum) return fallback;
      const source = researchSourceLabel(datum);
      const date = formatResearchDateLabel(getResearchDatumDate(datum));
      if (isReference) {
        const refreshState = researchEnvelopeIsRetained
          ? researchState.status === 'loading' ? 'refreshing' : 'refresh failed'
          : 'reference only';
        return `Last verified · ${source} · ${date} · ${refreshState}`;
      }
      return `${source} · ${date}`;
    };
    const unavailableDecisionMeta = researchState.status === 'loading'
      && !researchPayload
      ? 'Loading verified source'
      : `No verified ${currentDateLabel} source`;
    const hasLastVerifiedDecision = Boolean(
      verifiedTrade || verifiedTrend || verifiedRiskRange || verifiedSignalStrength
    );
    const coverageValue = researchState.status === 'loading' && !researchPayload
      ? 'LOADING'
      : !researchEnvelopeIsCurrent || !entry
        ? hasLastVerifiedDecision ? 'REFERENCE' : 'UNAVAILABLE'
        : ['complete', 'no_references'].includes(coverageState)
          ? 'FULL'
          : coverageState === 'partial' ? 'PARTIAL' : 'UNAVAILABLE';
    const coverageMeta = researchEnvelopeIsRetained && researchPayload
      ? `Last verified · ${formatResearchDateLabel(researchPayload.marketDate)} · ${
        researchState.status === 'loading' ? 'refreshing' : 'refresh failed'
      }`
      : ['complete', 'no_references'].includes(coverageState)
      && researchEnvelopeIsCurrent
        ? `Verified · ${currentDateLabel}`
        : coverageReasons[0] || (researchState.error
          ? hasLastVerifiedDecision ? 'Refresh failed · last verified retained' : 'Refresh failed'
          : 'Product coverage incomplete');

    const apiResearchProducts = asArray(researchPayload?.products).filter((product) => (
      !SECURITY_RESEARCH_EXCLUDED_PRODUCTS.has(
        String(product?.id || '').trim().toLowerCase(),
      )
    ));
    const apiProductsById = new Map(
      apiResearchProducts
        .map((product) => [String(product?.id || '').trim().toLowerCase(), product])
        .filter(([id]) => id)
    );
    const fallbackProductRows = RESEARCH_FALLBACK_PRODUCTS.map(([id, label, cadence]) => (
      apiProductsById.get(id) || {
        id,
        label,
        cadence,
        status: researchState.status === 'loading' ? 'missing' : 'failed',
        marketDate: expectedResearchMarketDate,
        publishedAt: null,
      }
    ));
    const researchProducts = [
      ...fallbackProductRows,
      ...apiResearchProducts.filter((product) => (
        !RESEARCH_FALLBACK_PRODUCTS.some(([id]) => id === String(product?.id || '').trim().toLowerCase())
      )),
    ];
    const productsById = new Map(
      researchProducts.map((product) => [String(product.id || '').toLowerCase(), product])
    );
    const fallbackProductOrder = new Map(
      RESEARCH_FALLBACK_PRODUCTS.map(([id], index) => [id, index])
    );
    const productOrder = new Map(
      researchProducts.map((product, index) => {
        const productId = String(product.id || '').toLowerCase();
        return [productId, fallbackProductOrder.get(productId) ?? index];
      })
    );
    const displayCurrentReferences = [...currentReferences];
    const hasSupplementalReference = currentReferences.some((reference) => (
      getResearchProductId(reference) === 'early-look'
    ));
    if (verifiedSupplementalRange && !hasSupplementalReference) {
      const supplementalTrend = researchValue(verifiedSupplementalRange, ['trend']);
      displayCurrentReferences.push({
        productId: 'early-look',
        productLabel: 'Early Look',
        marketDate: getResearchDatumDate(verifiedSupplementalRange) || researchMarketDate,
        publishedAt: verifiedSupplementalRange.publishedAt,
        sourceUrl: verifiedSupplementalRange.sourceUrl,
        kind: 'supplemental_risk_range',
        qualityStatus: 'indexed',
        matchType: 'direct',
        decisionEligible: false,
        excerpt: [
          `Supplemental LRR ${formatResearchNumber(researchValue(verifiedSupplementalRange, ['lrr', 'low']))} – HRR ${formatResearchNumber(researchValue(verifiedSupplementalRange, ['hrr', 'high']))}`,
          supplementalTrend ? `Trend ${String(supplementalTrend).toUpperCase()}` : null,
          'reference only',
        ].filter(Boolean).join(' · '),
      });
    }
    const referenceCacheToken = (references) => references.map((reference) => [
      reference?.id,
      reference?.sourceEventId,
      getResearchProductId(reference),
      getResearchDatumDate(reference),
      reference?.kind,
      reference?.matchType,
      reference?.matchedText,
      normalizeResearchReferenceText(researchReferenceText(reference)).slice(0, 96),
    ].join('|')).join('~');
    const productCacheKey = [
      symbol,
      expectedResearchMarketDate,
      researchMarketDate,
      researchEnvelopeIsCurrent,
      researchEnvelopeIsRetained,
      referenceCacheToken(displayCurrentReferences),
      referenceCacheToken(historicalReferences),
    ].join('::');
    const cachePayload = researchPayload && typeof researchPayload === 'object'
      ? researchPayload
      : researchFallbackPayloadRef.current;
    let payloadCache = researchProductRowsCacheRef.current.get(cachePayload);
    if (!payloadCache) {
      payloadCache = new Map();
      researchProductRowsCacheRef.current.set(cachePayload, payloadCache);
    }
    let cachedProductRows = payloadCache.get(productCacheKey) || null;
    if (!cachedProductRows) {
      cachedProductRows = {
        current: canonicalSecurity
          ? buildCanonicalResearchProductRows({
            security: canonicalSecurity,
            productOrder,
            marketDate: expectedResearchMarketDate,
          })
          : buildResearchProductRows({
            references: displayCurrentReferences,
            symbol,
            productsById,
            productOrder,
            marketDate: expectedResearchMarketDate,
            requireCurrentIndexed: true,
            includeEmptyProducts: true,
          }),
        historical: buildResearchProductRows({
          references: historicalReferences,
          symbol,
          productOrder,
          groupByDate: true,
        }),
      };
      payloadCache.set(productCacheKey, cachedProductRows);
    }
    const currentProductRows = cachedProductRows.current;
    const historicalProductRows = cachedProductRows.historical.map(historicalResearchDisplayRow);

    const sizingVolatilityModel = buildSizingVolatilityPresentation({
      symbol,
      reference: positionSizeReference,
      loading: riskMetricsLoading,
      asOfLabel: positionSizeReference.available ? formatResearchDateLabel(positionSizeReference.asOf) : null,
    });
    const marketContextMetrics = {
      zScore: {
        value: zScore20
          ? `${Number(zScore20.value) > 0 ? '+' : ''}${Number(zScore20.value).toFixed(2)}`
          : riskMetricsLoading ? '…' : 'Unavailable',
        meta: zScore20
          ? `Completed close · ${formatResearchDateLabel(zScore20.asOf)}`
          : 'Verified completed-close series unavailable',
        tone: zScore20 ? zScoreToneForValue(zScore20.value) : 'is-muted',
        className: zScore20 ? 'is-reference' : '',
      },
      sizingVolatility: {
        ...sizingVolatilityModel.metric,
        onClick: sizingVolatilityModel.display
          ? () => setMetricVerification(buildSizingVolatilityVerification({ symbol, reference: positionSizeReference }))
          : null,
      },
      volatilityIndex: {
        value: volatilityValue,
        meta: volatilityMeta,
        tone: volatilityValue === 'Unavailable' ? 'is-muted' : '',
      },
      usdCorrelation: usdCorrelationModel,
      stopLoss: {
        ...stopLossModel.metric,
        onClick: () => setMetricVerification(stopLossModel.verification),
      },
    };

    // Prepared display props; validation and calculations stay with the position owner.
    const decisionMetrics = {
      tick: {
        value: tickValue ? `${tickValue}${tickEvidence.matchType === 'proxy' ? ` (${tickEvidence.sourceTicker})` : ''}` : '—',
        meta: tickEvidence
          ? [tickEvidence.source, formatResearchDateLabel(tickEvidence.date), tickEvidence.sourceTicker,
            tickEvidence.sourceLabel, tickEvidence.basisRelationship,
            tickEvidence.position === 'Wait' ? 'Wait and Watch (no directional call)' : null,
            tickEvidence.evidenceText].filter(Boolean).join(' · ')
          : 'Published Tick unavailable',
        tone: tickValue === 'Wait' ? 'is-neutral' : metricToneForValue(tickValue),
        className: tickEvidence?.matchType === 'proxy' ? 'is-reference' : '',
      },
      trade: {
        value: tradeValue || (researchInitialLoading ? '…' : '—'),
        meta: decisionSourceMeta(verifiedTrade, tradeIsReference, unavailableDecisionMeta),
        tone: metricToneForValue(tradeValue),
        className: tradeIsReference ? 'is-reference' : '',
      },
      trend: {
        value: trendValue || (researchInitialLoading ? '…' : '—'),
        meta: decisionSourceMeta(verifiedTrend, trendIsReference, unavailableDecisionMeta),
        tone: metricToneForValue(trendValue),
        className: trendIsReference ? 'is-reference' : '',
      },
      beta: {
        value: beta ? Number(beta.value).toFixed(2) : riskMetricsLoading ? '…' : '—',
        meta: beta
          ? `${beta.windowSessions || 252}D vs ${beta.benchmark || 'SPY'} · ${formatResearchDateLabel(beta.asOf)}`
          : 'Historical beta unavailable',
        tone: beta ? betaToneForValue(beta.value) : 'is-muted',
        className: beta ? 'is-reference' : '',
      },
      factorContribution: {
        value: factorContribution === null
          ? '—'
          : formatPct(quantity < 0 ? -factorContribution : factorContribution, 1, { signed: true }),
        meta: factorContribution === null
          ? 'Verified live NAV contribution unavailable'
          : `${getQuadExposureLabels(holding).join(' · ') || 'Unclassified'} · signed % NAV`,
        title: 'Current signed position contribution across the displayed +EV exposures.',
        // The displayed signed contribution reads by its own sign.
        tone: factorContribution === null
          ? 'is-muted'
          : (quantity < 0 ? -factorContribution : factorContribution) > 0 ? 'is-positive'
            : (quantity < 0 ? -factorContribution : factorContribution) < 0 ? 'is-negative' : '',
      },
      quad: {
        meta: quadRanking
          ? `${quadRanking.exposure.label} · chart order${quadRanking.hasTies ? ' · = tied' : ''}`
          : quadClassification.reason,
        value: quadRanking ? null : quadClassification.status === 'not-covered' ? 'Not covered' : 'Unclassified',
      },
      signal: {
        value: signalValue || (researchInitialLoading ? '…' : '—'),
        meta: decisionSourceMeta(
          verifiedSignalStrength,
          signalIsReference,
          unavailableDecisionMeta,
        ),
        tone: metricToneForValue(signalValue),
        className: signalIsReference ? 'is-reference' : '',
      },
      lowRange: {
        value: rangeAvailable ? formatResearchNumber(rangeLow) : researchState.status === 'loading' ? '…' : '—',
        meta: rangeMeta,
        title: 'Low price risk range',
        tone: rangeAvailable ? '' : 'is-muted',
      },
      highRange: {
        value: rangeAvailable ? formatResearchNumber(rangeHigh) : researchState.status === 'loading' ? '…' : '—',
        meta: rangeMeta,
        title: 'High price risk range',
        tone: rangeAvailable ? '' : 'is-muted',
      },
      otherExposure: {
        value: otherExposures.length > 0
          ? otherExposures.map((exposure) => exposure.label).join(' · ')
          : '—',
        meta: otherExposures.length > 0
          ? `${[...new Set(otherExposures.map((exposure) => exposureTypeLabel(exposure.type)))].join(' / ')} · controlled`
          : 'No controlled mapping',
        title: otherExposures.map((exposure) => (
          `${exposureTypeLabel(exposure.type)} · ${exposure.label}`
        )).join(' · '),
      },
      coverage: {
        value: coverageValue,
        meta: coverageMeta,
        tone: metricToneForValue(coverageValue),
        title: coverageReasons.join(' · ') || coverageMeta,
      },
    };

    return (
      <PortfolioResearchPanel
        rowId={rowId}
        symbol={symbol}
        model={{
          healthStatus: canonicalHealthLabel,
          busy: researchInitialLoading || riskMetricsLoading || volatilityLoading || usdCorrelationLoading,
          decision: {
            metrics: decisionMetrics,
            quadRanking: quadRanking ? { groups: quadRanking.groups, orderText: quadRanking.orderText } : null,
          },
          marketContext: {
            metrics: marketContextMetrics,
            sizingVolatilityDisplay: sizingVolatilityModel.display,
            volatilityReadings,
          },
          products: {
            rows: currentProductRows,
            loading: researchInitialLoading,
          },
          history: {
            rows: historicalProductRows,
            historyDays: RESEARCH_HISTORY_DAYS,
            loading: researchState.historyStatus === 'loading',
            error: researchState.historyStatus === 'error',
          },
        }}
        expandedProducts={expandedResearchProducts}
        actions={{
          onExplainBeta: () => setMetricVerification(betaVerification),
          onExplainQuad: () => setMetricVerification({ symbol, metric: 'Quad +EV', classification: quadClassification }),
          onSelectLeveragedProduct: setLeveragedProductModal,
          onToggleProduct: toggleResearchProduct,
        }}
      />
    );
  };


  const renderFactorExposureBalance = () => (
    <div className="pcv2-factor-workspace">
      <PortfolioFactorQuadMatrix
        rows={factorExposure}
        estimates={quadResearch}
        available={factorExposureAvailable}
        loading={isLoading}
        valuation={factorValuation}
        selectedFactorId={factorExposureAvailable ? selectedFactorExposureId : null}
        onSelectFactor={(row) => {
          setFactorExposureDimension(row.dimension);
          setSelectedFactorExposureId(current => current === row.id ? null : row.id);
        }}
        onClearFactor={() => setSelectedFactorExposureId(null)}
      />
      <PortfolioQuadReference />
    </div>
  );

  const describeLedgerResearch = (holding, isLongs, index) => {
    const positionSizeReference = getPositionSizeReference(holding.symbol);
    const rowId = holdingRowIds.get(holding)
      || `${isLongs ? 'long' : 'short'}-${holding.symbol || 'unknown'}-${index}`;
    const isExpanded = expandedResearchRows.has(rowId);
    const symbolResearch = getSymbolResearch(holding.symbol);
    const healthStatus = symbolResearch?.health?.status || null;
    const researchNeedsAttention = SECURITY_INTELLIGENCE_V2_ENABLED
      && ['ready', 'error'].includes(researchState.status)
      && (
        canonicalResearchRequestFailed
        || !symbolResearch
        || ['attention', 'unavailable'].includes(healthStatus)
      );
    return {
      rowId, isExpanded, healthStatus, researchNeedsAttention, positionSizeReference,
      riskMetricsError: marketContextState.errors?.riskMetrics,
    };
  };

  const toggleLedgerResearch = (holding, rowId) => {
    const willExpand = !expandedResearchRows.has(rowId);
    if (willExpand) void loadPriorityRiskMetrics(holding.symbol);
    setExpandedResearchRows((current) => {
      const next = new Set(current);
      if (next.has(rowId)) next.delete(rowId);
      else next.add(rowId);
      return next;
    });
  };

  return (
    <div className="pcv2-workspace">
      {/* Scrollable Content */}
      <div className="pcv2-workspace__scroll">

        <section className="pcv2-shell">
          {renderFactorExposureBalance()}
          <PortfolioPositionsCard
            positions={positions}
            research={{
              describeRow: describeLedgerResearch,
              toggleRow: toggleLedgerResearch,
              explainSize: setMetricVerification,
              renderExpanded: renderSecurityResearch,
            }}
            refresh={{ availabilityLabel: portfolioAvailabilityLabel, isRefreshing, onRefresh: handleManualRefresh }}
          />
        </section>

        {false && (
        <div style={{ marginBottom: '32px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '24px' }}>
            {/* Longs Section */}
            <Card className="dark:bg-gray-800 rounded-lg" style={{ padding: 0, backgroundColor: '#ffffff', border: '1px solid #e5e7eb' }}>
              {/* Longs Banner */}
              <div style={{
                textAlign: 'center',
                marginBottom: '16px',
                padding: '8px',
                backgroundColor: '#059669',
                color: 'white',
                fontWeight: 700,
                fontSize: '14px',
                borderRadius: '4px',
                margin: '16px 16px 16px 16px'
              }}>
                LONG
              </div>

              {/* Longs Data Table */}
              {longs.length > 0 && (
                <div style={{ overflowX: 'auto' }}>
                  {/* Search Box and Filter Buttons Container */}
                  <div style={{ marginBottom: '8px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                    <input
                      ref={longsInputRef}
                      type="text"
                      placeholder="Search ticker..."
                      value={longsSearchFilter}
                      onChange={(e) => setLongsSearchFilter(e.target.value)}
                      style={{
                        padding: '6px 10px',
                        fontSize: '12px',
                        border: '1px solid #d1d5db',
                        borderRadius: '4px',
                        outline: 'none',
                        marginBottom: '6px'
                      }}
                      className="dark:bg-gray-700 dark:border-gray-600 dark:text-white"
                    />
                    {/* Column Toggle Buttons */}
                    <div ref={longsButtonRowRef} style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', justifyContent: 'center', width: 'fit-content' }}>
                      {columnDefinitions.map(col => (
                        <button
                          key={col.key}
                          onClick={() => toggleColumn(col.key)}
                          style={{
                            padding: '4px 8px',
                            fontSize: '10px',
                            border: '1px solid #d1d5db',
                            borderRadius: '4px',
                            cursor: 'pointer',
                            backgroundColor: columnVisibility[col.key] ? '#374151' : '#f9fafb',
                            color: columnVisibility[col.key] ? '#fff' : '#6b7280',
                            fontWeight: columnVisibility[col.key] ? '600' : '400',
                            transition: 'all 0.2s',
                            outline: 'none'
                          }}
                          className="dark:border-gray-600 hover:opacity-80"
                          onMouseEnter={(e) => {
                            if (!columnVisibility[col.key]) {
                              e.target.style.backgroundColor = '#e5e7eb';
                              e.target.style.color = '#374151';
                            }
                          }}
                          onMouseLeave={(e) => {
                            if (!columnVisibility[col.key]) {
                              e.target.style.backgroundColor = '#f9fafb';
                              e.target.style.color = '#6b7280';
                            }
                          }}
                        >
                          {col.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px', tableLayout: 'fixed' }}>
                    <thead>
                      <tr style={{ borderBottom: '2px solid #e5e7eb' }} className="dark:border-gray-700">
                        <th
                          style={{ padding: '6px', textAlign: 'left', fontWeight: 600, cursor: 'pointer', userSelect: 'none', width: '12%', position: 'relative' }}
                          className="dark:text-white"
                          onClick={() => handleSort('ticker', true)}
                        >
                          Ticker
                          <span style={{ position: 'absolute', bottom: '2px', right: '2px', fontSize: '10px', opacity: 0.5 }}>{renderSortIndicator('ticker', longsSortConfig)}</span>
                        </th>
                        {columnOrder.map(columnKey =>
                          columnVisibility[columnKey] && renderColumnHeader(columnKey, true)
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {sortedLongs.map((holding, index) => {
                        const assetClass = getAssetClassForTicker(holding.symbol);
                        const bgColor = ASSET_CLASS_COLORS[assetClass] || ASSET_CLASS_COLORS['Equities'];
                        const pctOfAccount = totalValue > 0 ? ((Math.abs(holding.marketValue) / totalValue) * 100).toFixed(2) : '0.00';

                        return (
                          <tr
                            key={index}
                            style={{
                              borderBottom: '1px solid #e5e7eb'
                            }}
                            className="dark:border-gray-700"
                          >
                            <td style={{ padding: '0', fontWeight: '600', position: 'relative' }} className="dark:text-white">
                              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 4px 6px 6px' }}>
                                <div style={{
                                  position: 'absolute',
                                  left: 0,
                                  top: 0,
                                  bottom: 0,
                                  width: '12px',
                                  backgroundColor: bgColor,
                                  flexShrink: 0
                                }}></div>
                                <span
                                  style={{ marginLeft: '10px' }}
                                  title={holdingSourceTitle(holding) || undefined}
                                >
                                  {holding.symbol}
                                  {renderHoldingWarningIcon(holding)}
                                </span>
                              </div>
                            </td>
                            {columnOrder.map(columnKey =>
                              columnVisibility[columnKey] && renderColumnCell(columnKey, holding, pctOfAccount, true)
                            )}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>

            {/* Shorts Section */}
            <Card className="dark:bg-gray-800 rounded-lg" style={{ padding: 0, backgroundColor: '#ffffff', border: '1px solid #e5e7eb' }}>
              {/* Shorts Banner */}
              <div style={{
                textAlign: 'center',
                marginBottom: '16px',
                padding: '8px',
                backgroundColor: '#dc2626',
                color: 'white',
                fontWeight: 700,
                fontSize: '14px',
                borderRadius: '4px',
                margin: '16px 16px 16px 16px'
              }}>
                SHORT
              </div>

              {/* Shorts Data Table */}
              {shorts.length > 0 && (
                <div style={{ overflowX: 'auto' }}>
                  {/* Search Box and Filter Buttons Container */}
                  <div style={{ marginBottom: '8px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                    <input
                      ref={shortsInputRef}
                      type="text"
                      placeholder="Search ticker..."
                      value={shortsSearchFilter}
                      onChange={(e) => setShortsSearchFilter(e.target.value)}
                      style={{
                        padding: '6px 10px',
                        fontSize: '12px',
                        border: '1px solid #d1d5db',
                        borderRadius: '4px',
                        outline: 'none',
                        marginBottom: '6px'
                      }}
                      className="dark:bg-gray-700 dark:border-gray-600 dark:text-white"
                    />
                    {/* Column Toggle Buttons */}
                    <div ref={shortsButtonRowRef} style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', justifyContent: 'center', width: 'fit-content' }}>
                      {columnDefinitions.map(col => (
                        <button
                          key={col.key}
                          onClick={() => toggleColumn(col.key)}
                          style={{
                            padding: '4px 8px',
                            fontSize: '10px',
                            border: '1px solid #d1d5db',
                            borderRadius: '4px',
                            cursor: 'pointer',
                            backgroundColor: columnVisibility[col.key] ? '#374151' : '#f9fafb',
                            color: columnVisibility[col.key] ? '#fff' : '#6b7280',
                            fontWeight: columnVisibility[col.key] ? '600' : '400',
                            transition: 'all 0.2s',
                            outline: 'none'
                          }}
                          className="dark:border-gray-600 hover:opacity-80"
                          onMouseEnter={(e) => {
                            if (!columnVisibility[col.key]) {
                              e.target.style.backgroundColor = '#e5e7eb';
                              e.target.style.color = '#374151';
                            }
                          }}
                          onMouseLeave={(e) => {
                            if (!columnVisibility[col.key]) {
                              e.target.style.backgroundColor = '#f9fafb';
                              e.target.style.color = '#6b7280';
                            }
                          }}
                        >
                          {col.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px', tableLayout: 'fixed' }}>
                    <thead>
                      <tr style={{ borderBottom: '2px solid #e5e7eb' }} className="dark:border-gray-700">
                        <th
                          style={{ padding: '6px', textAlign: 'left', fontWeight: 600, cursor: 'pointer', userSelect: 'none', width: '12%', position: 'relative' }}
                          className="dark:text-white"
                          onClick={() => handleSort('ticker', false)}
                        >
                          Ticker
                          <span style={{ position: 'absolute', bottom: '2px', right: '2px', fontSize: '10px', opacity: 0.5 }}>{renderSortIndicator('ticker', shortsSortConfig)}</span>
                        </th>
                        {columnOrder.map(columnKey =>
                          columnVisibility[columnKey] && renderColumnHeader(columnKey, false)
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {sortedShorts.map((holding, index) => {
                        const assetClass = getAssetClassForTicker(holding.symbol);
                        const bgColor = ASSET_CLASS_COLORS[assetClass] || ASSET_CLASS_COLORS['Equities'];
                        const pctOfAccount = totalValue > 0 ? ((Math.abs(holding.marketValue) / totalValue) * 100).toFixed(2) : '0.00';

                        return (
                          <tr
                            key={index}
                            style={{
                              borderBottom: '1px solid #e5e7eb'
                            }}
                            className="dark:border-gray-700"
                          >
                            <td style={{ padding: '0', fontWeight: '600', position: 'relative' }} className="dark:text-white">
                              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '6px' }}>
                                <div style={{
                                  position: 'absolute',
                                  left: 0,
                                  top: 0,
                                  bottom: 0,
                                  width: '12px',
                                  backgroundColor: bgColor,
                                  flexShrink: 0
                                }}></div>
                                <span
                                  style={{ marginLeft: '10px' }}
                                  title={holdingSourceTitle(holding) || undefined}
                                >
                                  {holding.symbol}
                                  {renderHoldingWarningIcon(holding)}
                                </span>
                              </div>
                            </td>
                            {columnOrder.map(columnKey =>
                              columnVisibility[columnKey] && renderColumnCell(columnKey, holding, pctOfAccount, false)
                            )}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </div>
        </div>
        )}

      </div>
      <PortfolioMetricVerificationModal
        active={active}
        selection={metricVerification}
        positionSizeReference={active && metricVerification?.metric === 'Position size'
          ? getPositionSizeReference(metricVerification.symbol)
          : null}
        onClose={closeMetricVerification}
      />
      <LeveragedProductModal
        active={active}
        selection={leveragedProductModal}
        onClose={closeLeveragedProductModal}
      />
    </div>

  );
};

export default React.memo(PortfolioBreakdown);
