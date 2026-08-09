import React, { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Card } from '@tremor/react';
import { CalendarClock, ChevronDown, Download, Filter, RefreshCw, Search, X } from 'lucide-react';
import {
  separateLongsAndShorts,
  formatPerformance
} from '../../utils/portfolioBreakdownUtils';
import {
  calculateBetaBand,
  SIZING_CONSTANTS,
} from '../../utils/signalWeightedPositionSizing';
import { isTradingDay } from '../../utils/marketHolidays';
import { SECURITY_CATEGORY_MAPPING } from '../../constants/securityCategoryMapping';
import { SECURITIES_LIST } from '../../constants/securitiesList';
import {
  getExposureDefinition,
  resolveSecurityExposureProfile,
} from '../../constants/quadExposureCatalog';
import expectedValuesData from '../../constants/expectedValuesData';
import { MarketDataService } from '../../services/api/marketDataService';
import { retainHistoricalVolatilityRows } from '../../hooks/useVolatilitySnapshot';
import { useSurfaceActivity } from '../common/PersistentSurface';
import { resolveSizingVolatility } from '../../utils/realizedVolatility.cjs';
import {
  FACTOR_EXPOSURE_TABS,
  buildPortfolioFactorExposure,
  holdingMatchesFactorExposure,
} from '../../utils/portfolioFactorExposure';
import './PortfolioConstructionIdeas.css';

const ASSET_CLASS_COLORS = {
  'Equities': '#059669',      // Emerald green
  'Fixed Income': '#3B82F6',  // Blue
  'Commodities': '#F97316',   // Orange
  'FX': '#8B5CF6',            // Violet (includes Gold, USD, and other currencies)
  'Currencies': '#8B5CF6',    // Violet (alias for FX)
  'Cryptocurrency': '#F59E0B', // Amber
  'CASH': '#6B7280',          // Neutral gray
  // Note: "Other" category has been removed - all holdings are now properly classified
};

// Map category from SECURITY_CATEGORY_MAPPING to display asset class
// 5 core asset classes: Equities, Fixed Income, Commodities, FX (Currencies), Cryptocurrency
const CATEGORY_DISPLAY_NAMES = {
  'Equities': 'Equities',
  'Fixed Income': 'Fixed Income',
  'Commodities': 'Commodities',
  'Cash': 'CASH',
  'CASH': 'CASH',
  'FX': 'Currencies',           // FX (includes Gold, USD, and other currencies) → Currencies
  'USD': 'Currencies',          // Legacy USD category → Currencies
  'Gold': 'Currencies',         // Legacy Gold category → Currencies (due to volatility characteristics)
  'Cryptocurrency': 'Cryptocurrency',  // Cryptocurrency asset class
  'Tech': 'Equities',           // Tech sector → Equities
  'Consumer Discretionary': 'Equities',
  'Communication Services': 'Equities',
  'Industrials': 'Equities',
  'Materials': 'Equities',
  'REITs': 'Equities',
  'Utilities': 'Equities',
  'Consumer Staples': 'Equities',
  'Health Care': 'Equities',
  'Energy': 'Equities',
  'Financials': 'Equities',
  'Leveraged Loans': 'Fixed Income',
  'Convertibles': 'Fixed Income',
  'EM $ Debt': 'Fixed Income',
  'HY Credit': 'Fixed Income',
  'Treasury Belly': 'Fixed Income',
  'IG Credit': 'Fixed Income',
  'MBS': 'Fixed Income',
  'Preferreds': 'Fixed Income',
  'Short Duration Treasurys': 'Fixed Income',
  'TIPS': 'Fixed Income',
  'Long Bond': 'Fixed Income',
  'Momentum': 'Equities',
  'Low Beta': 'Equities',
  'Dividend Yield': 'Equities',
};

/**
 * Get the asset class for a ticker from the securities universe
 * Uses fallback logic to avoid "Other" category
 */
const getAssetClassForTicker = (ticker, holding = null) => {
  // First, try the mapping
  const mapping = SECURITY_CATEGORY_MAPPING[ticker?.toUpperCase()];
  if (mapping) {
    const category = mapping.category;
    return CATEGORY_DISPLAY_NAMES[category] || category;
  }

  // Fallback: Use holding's assetClass or assetType if available
  if (holding) {
    const assetClass = holding.assetClass || holding.assetType || '';
    const lower = assetClass.toLowerCase();

    // Map common asset class strings to display categories
    if (lower.includes('equity') || lower.includes('stock') || lower.includes('etf') || lower.includes('equities')) {
      return 'Equities';
    }
    if (lower.includes('cash') || lower.includes('money market') || lower.includes('t-bill') || lower.includes('treasury bill')) {
      return 'CASH';
    }
    if (lower.includes('fixed income') || lower.includes('bond') || lower.includes('treasury') || lower.includes('credit')) {
      return 'Fixed Income';
    }
    if (lower.includes('currency') || lower.includes('fx') || lower.includes('forex') || lower.includes('usd') || lower.includes('gold')) {
      return 'Currencies';
    }
    if (lower.includes('commodity') || lower.includes('metal') || lower.includes('oil') || lower.includes('energy') || lower.includes('agriculture')) {
      return 'Commodities';
    }
    if (lower.includes('crypto') || lower.includes('bitcoin') || lower.includes('ethereum') || lower.includes('cryptocurrency')) {
      return 'Cryptocurrency';
    }
  }

  // Final fallback: Infer from ticker symbol patterns
  const tickerUpper = (ticker || '').toUpperCase();
  if (tickerUpper.includes('USD') || tickerUpper.includes('EUR') || tickerUpper.includes('GBP') || tickerUpper.includes('JPY') || tickerUpper.includes('FX')) {
    return 'Currencies';
  }
  if (['TBIL', 'BIL', 'SGOV', 'SHV', 'GBIL', 'CLIP', 'USFR', 'TFLO', 'XBIL'].includes(tickerUpper)) {
    return 'CASH';
  }
  if (tickerUpper.includes('GOLD') || tickerUpper.includes('GLD') || tickerUpper.includes('SLV')) {
    return 'Currencies'; // Gold/Silver mapped to Currencies per existing logic
  }
  // Check for crypto ETFs and tokens - common crypto ticker patterns
  if (tickerUpper.includes('BTC') || tickerUpper.includes('ETH') || tickerUpper.includes('CRYPTO') ||
    tickerUpper.includes('BITCOIN') || tickerUpper.includes('IBIT') || tickerUpper.includes('BLOK') ||
    tickerUpper.includes('SOL') || tickerUpper.includes('AVAX') || tickerUpper.includes('XRP') ||
    tickerUpper.includes('ETHA') || tickerUpper.includes('CRCL') || tickerUpper.includes('BMNR')) {
    return 'Cryptocurrency';
  }
  if (tickerUpper.includes('TLT') || tickerUpper.includes('HYG') || tickerUpper.includes('LQD') || tickerUpper.includes('BOND')) {
    return 'Fixed Income';
  }
  if (tickerUpper.includes('OIL') || tickerUpper.includes('GAS') || tickerUpper.includes('CORN') || tickerUpper.includes('WHEAT')) {
    return 'Commodities';
  }

  // If we still can't determine, default to Equities (most common) instead of "Other"
  // This ensures we never show "Other" in the pie chart
  return 'Equities';
};

const SLEEVE_ORDER = ['Growth', 'Credit', 'Inflation', 'Defensive', 'Volatility', 'Cash'];

const SECURITY_NAME_BY_TICKER = SECURITIES_LIST.reduce((acc, security) => {
  acc[security.ticker.toUpperCase()] = security.name;
  return acc;
}, {});

const CREDIT_CATEGORIES = new Set([
  'HY Credit',
  'IG Credit',
  'Leveraged Loans',
  'Convertibles',
  'EM $ Debt',
  'MBS',
  'Preferreds'
]);

const DEFENSIVE_CATEGORIES = new Set([
  'Treasury Belly',
  'Short Duration Treasurys',
  'Long Bond',
  'Utilities',
  'Consumer Staples',
  'Health Care'
]);

const INFLATION_CATEGORIES = new Set([
  'Commodities',
  'Energy',
  'Materials',
  'TIPS',
  'FX',
  'Gold',
  'Currencies'
]);

const VOLATILITY_CATEGORIES = new Set(['Low Beta']);

const ASSET_CLASS_ABBREVIATIONS = {
  Equities: 'EQ',
  'Fixed Income': 'FI',
  Commodities: 'COM',
  Currencies: 'FX',
  'CASH': 'CASH',
  Cryptocurrency: 'CRYPTO',
};

const isCashHolding = (holding) => {
  const symbol = (holding?.symbol || '').toUpperCase();
  const assetClass = (holding?.assetClass || holding?.assetType || '').toLowerCase();
  const description = (holding?.description || holding?.name || '').toLowerCase();
  return (
    symbol === 'CASH & CASH INVESTMENTS' ||
    symbol === 'CASH' ||
    ['TBIL', 'BIL', 'SGOV', 'SHV', 'GBIL', 'CLIP', 'USFR', 'TFLO', 'XBIL'].includes(symbol) ||
    assetClass.includes('cash') ||
    assetClass.includes('money market') ||
    description.includes('treasury bill') ||
    description.includes('money market')
  );
};

const getSleeveForHolding = (holding) => {
  if (isCashHolding(holding)) return 'Cash';

  const symbol = (holding?.symbol || '').toUpperCase();
  const mapping = SECURITY_CATEGORY_MAPPING[symbol];
  const category = mapping?.category || getAssetClassForTicker(symbol, holding);
  const normalized = (category || '').toLowerCase();
  const description = (holding?.description || holding?.name || '').toLowerCase();

  if (CREDIT_CATEGORIES.has(category) || normalized.includes('credit') || normalized.includes('loan')) return 'Credit';
  if (DEFENSIVE_CATEGORIES.has(category) || normalized.includes('treasury') || normalized.includes('staples') || normalized.includes('utilities')) return 'Defensive';
  if (INFLATION_CATEGORIES.has(category) || normalized.includes('commodity') || normalized.includes('energy') || normalized.includes('materials') || description.includes('tips')) return 'Inflation';
  if (VOLATILITY_CATEGORIES.has(category) || symbol.includes('VIX') || ['VXX', 'UVXY', 'BTAL'].includes(symbol)) return 'Volatility';
  return 'Growth';
};

const getSecurityName = (holding) => {
  const symbol = (holding?.symbol || '').toUpperCase();
  return holding?.description || holding?.name || SECURITY_NAME_BY_TICKER[symbol] || holding?.symbol || '--';
};

const getQuadExposureLabels = (holding) => {
  const profile = resolveSecurityExposureProfile(holding);
  if (profile?.classificationStatus !== 'reviewed') return [];
  return [profile.primaryExposureId, ...(profile.secondaryExposureIds || [])]
    .map((exposureId) => getExposureDefinition(exposureId)?.label)
    .filter(Boolean);
};

const getAssetClassAbbreviation = (holding) => {
  const assetClass = getAssetClassForTicker(holding?.symbol, holding);
  return ASSET_CLASS_ABBREVIATIONS[assetClass] || assetClass || '--';
};

const formatPct = (value, decimals = 1, { signed = false } = {}) => {
  const num = Number(value) || 0;
  const sign = signed && num > 0 ? '+' : '';
  return `${sign}${num.toFixed(decimals)}%`;
};

const finiteOptionalNumber = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const getPortfolioWeight = (holding, totalValue) => {
  const marketValue = finiteOptionalNumber(holding?.marketValue);
  const nav = finiteOptionalNumber(totalValue);
  if (marketValue === null || nav === null || nav <= 0) return null;
  return (Math.abs(marketValue) / nav) * 100;
};

const isValidObservedAt = (value) => Number.isFinite(Date.parse(String(value || '')));
const isValidSessionDate = (value) => (
  /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
);
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

const isVerifiedLiveMark = (holding) => (
  holding?.priceState === 'live'
  && holding?.marketValueState === 'live'
  && holding?.priceSource === 'ibkr_live_last'
  && isValidObservedAt(holding?.priceObservedAt)
  && finiteOptionalNumber(holding?.price) > 0
);

const isHistoricalReferenceMark = (holding) => (
  holding?.priceState === 'historical_close'
  && holding?.marketValueState === 'historical_close'
  && holding?.priceSource === 'ibkr_historical_daily_close'
  && isValidSessionDate(holding?.priceSessionDate)
);

const isVerifiedHistoricalDisplayMark = (holding) => {
  const price = finiteOptionalNumber(holding?.price);
  const referenceClose = finiteOptionalNumber(holding?.referenceClose);
  return (
    isHistoricalReferenceMark(holding)
    && holding?.referenceCloseSource === 'ibkr_historical_daily_close'
    && isValidObservedAt(holding?.priceObservedAt)
    && isValidObservedAt(holding?.referenceCloseObservedAt)
    && isValidSessionDate(holding?.priceSessionDate)
    && holding?.priceSessionDate === holding?.referenceCloseSessionDate
    && price > 0
    && referenceClose > 0
    && Math.abs(price - referenceClose) < 1e-9
  );
};

const formatPrice = (value) => {
  const price = finiteOptionalNumber(value);
  if (price === null) return '—';
  const decimals = Math.abs(price) < 1 ? 4 : 2;
  return `$${price.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
};

const getVerifiedHoldingMark = (holding, verifiedPortfolioMarks) => {
  if (verifiedPortfolioMarks !== true) return null;
  const price = finiteOptionalNumber(holding?.price);
  if (price === null) return null;
  if (isVerifiedLiveMark(holding)) {
    return {
      value: price,
      state: 'live',
      ariaLabel: `Live price ${formatPrice(price)}`,
      title: `Verified live IBKR last · observed ${holding.priceObservedAt}`,
    };
  }
  if (isVerifiedHistoricalDisplayMark(holding)) {
    return {
      value: price,
      state: 'historical_close',
      ariaLabel: `Prior close ${formatPrice(price)} from ${holding.priceSessionDate}`,
      title: `Verified completed-session close from ${holding.priceSessionDate}; reference only`,
    };
  }
  return null;
};

const getVerifiedDayGainLossPercent = (holding, verifiedPortfolioMarks) => {
  if (verifiedPortfolioMarks !== true) return null;
  const percent = finiteOptionalNumber(holding?.dayChangePercent);
  if (percent === null) return null;

  if (
    isVerifiedLiveMark(holding)
    && holding?.dayChangeState === 'live_vs_reference_close'
    && finiteOptionalNumber(holding?.referenceClose) > 0
    && holding?.referenceCloseSource === 'ibkr_historical_daily_close'
    && isValidObservedAt(holding?.referenceCloseObservedAt)
    && isValidSessionDate(holding?.referenceCloseSessionDate)
    && holding?.dayChangeSessionDate === holding?.referenceCloseSessionDate
  ) {
    return percent;
  }

  if (
    isVerifiedHistoricalDisplayMark(holding)
    && holding?.dayChangeState === 'historical_session'
    && finiteOptionalNumber(holding?.previousClose) > 0
    && isValidSessionDate(holding?.previousCloseSessionDate)
    && holding?.previousCloseSessionDate < holding?.referenceCloseSessionDate
    && holding?.dayChangeSessionDate === holding?.referenceCloseSessionDate
  ) {
    return percent;
  }

  return null;
};

const csvEscape = (value) => {
  const str = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
};

const RESEARCH_HISTORY_DAYS = 5;
const RESEARCH_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const RISK_METRICS_BATCH_SIZE = 50;
// The API's productCoverage array is authoritative. This small mirror only
// keeps the fail-closed UI useful before a first response (or after a request
// failure), without introducing another request or coupling the bundle to
// the infra-only registry file.
const RESEARCH_FALLBACK_PRODUCTS = Object.freeze([
  ['risk-ranges', 'Risk Ranges', 'market_day_0800'],
  ['early-look', 'Early Look', 'event_driven'],
  ['crypto-quant', 'Crypto Quant', 'event_driven'],
  ['bitcoin-trend-tracker', 'Bitcoin Tracker', 'event_driven'],
  ['portfolio-solutions', 'Portfolio Solutions', 'event_driven'],
  ['momo-tracker', 'MOMO Tracker', 'event_driven'],
  ['signal-strength', 'Signal Strength', 'event_driven'],
  ['real-time-alert', 'Real-Time Alerts', 'event_driven'],
  ['the-macro-show', 'Macro Show', 'event_driven'],
  ['the-call', 'The Call', 'event_driven'],
  ['volume', 'Volume / Market Structure', 'event_driven'],
  ['market-structure', 'Market Situation Report', 'event_driven'],
  ['cftc-positioning', 'CFTC Positioning', 'weekly'],
  ['etf-pro', 'ETF Pro', 'event_driven'],
  ['investing-ideas', 'Investing Ideas', 'event_driven'],
]);
const RESEARCH_REFERENCE_KIND_PRIORITY = Object.freeze({
  primary_risk_range: 130,
  supplemental_risk_range: 125,
  historical_risk_range: 125,
  portfolio_solutions_rank: 125,
  tracker_trade: 125,
  trade_signal: 125,
  signal_strength_added: 125,
  signal_strength_removed: 125,
  signal_strength_listed: 125,
  signal_strength_membership: 125,
  etf_pro_change: 120,
  real_time_alert: 120,
  portfolio_solutions_mover: 115,
  position_mention: 115,
  position_change: 110,
  position_reference: 90,
  risk_range: 85,
  portfolio_rank: 80,
  commodity_mention: 70,
  factor_mention: 70,
  sector_mention: 70,
  country_mention: 70,
  macro_mention: 70,
  summary_mention: 60,
  mention: 60,
});
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
const VERIFIED_BETA_RETURN_BASIS = 'adjusted-close simple daily returns over adjacent common dates';

const normalizeResearchDate = (value) => {
  if (!value) return null;
  const text = String(value).trim();
  const isoDate = text.match(/^(\d{4}-\d{2}-\d{2})/);
  return isoDate ? isoDate[1] : null;
};

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

const formatResearchDateLabel = (value) => {
  const date = normalizeResearchDate(value);
  if (!date) return 'Date unavailable';
  const parsed = new Date(`${date}T12:00:00Z`);
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(parsed);
};

const formatResearchSourceDate = (value) => {
  const date = normalizeResearchDate(value);
  if (!date) return 'Date unavailable';
  const parsed = new Date(`${date}T12:00:00Z`);
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(parsed);
};

const formatResearchTime = (value) => {
  if (!value || typeof value !== 'string' || !value.includes('T')) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '—';
  // Some legacy parsers stored a date-only artifact as midnight UTC. Do not
  // present that synthetic value as a publication time.
  if (/T00:00(?::00(?:\.000)?)?(?:Z|[+-]00:00)?$/i.test(value)) return '—';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(parsed);
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

const getQuadExpectedValueRanking = (symbol) => {
  const row = expectedValuesData.getExpectedValueForTicker(symbol);
  const scores = expectedValuesData.getExpectedValueQuadScores(row);
  if (!row || !scores || Object.values(scores).some((value) => !Number.isFinite(value))) return null;
  return {
    label: row.ticker,
    order: Object.entries(scores)
      .sort((left, right) => right[1] - left[1])
      .map(([quad]) => Number(quad.replace('q', ''))),
  };
};

const metricToneForValue = (value) => {
  const normalized = String(value || '').trim().toUpperCase();
  if (['ADDED', 'BULLISH', 'BUY', 'FULL', 'LONG', 'POSITIVE'].includes(normalized)) {
    return 'is-positive';
  }
  if (['BEARISH', 'PARTIAL', 'REMOVED', 'SELL', 'SHORT', 'UNAVAILABLE'].includes(normalized)) {
    return 'is-negative';
  }
  if (['HISTORICAL', 'REFERENCE'].includes(normalized)) {
    return 'is-reference';
  }
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

const betaToneForValue = (value) => {
  const numeric = finiteOptionalNumber(value);
  if (numeric === null || (numeric >= 0.8 && numeric <= 1.2)) return 'is-neutral';
  if (numeric < 0.5) return 'is-positive-strong';
  if (numeric < 0.8) return 'is-positive';
  if (numeric <= 1.5) return 'is-negative-soft';
  if (numeric <= 2) return 'is-negative';
  return 'is-negative-strong';
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

const getResearchDatumDate = (datum) => normalizeResearchDate(
  datum?.marketDate
  || datum?.sourceDate
  || datum?.contentDate
  || datum?.publicationDate
  || datum?.asOfDate
  || datum?.date
  || datum?.source?.marketDate
  || datum?.source?.sourceDate
);

const getResearchProductId = (datum) => String(
  datum?.productId
  || datum?.product
  || datum?.sourceId
  || datum?.source?.productId
  || datum?.source?.id
  || datum?.source?.name
  || ''
).trim().toLowerCase();

const getResearchStatus = (datum) => String(
  datum?.qualityStatus
  || datum?.status
  || datum?.source?.qualityStatus
  || datum?.source?.status
  || ''
).trim().toLowerCase();

const isUntrustedResearchDatum = (datum) => {
  const status = getResearchStatus(datum);
  return Boolean(
    (status && UNTRUSTED_RESEARCH_STATUSES.has(status))
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
  if (getResearchStatus(datum) !== 'available') return false;

  const productId = getResearchProductId(datum);
  if (kind === 'trade' && !/(momo|bitcoin).*(tracker)|bitcoin-trend-tracker/.test(productId)) return false;
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
  if (kind === 'trade' && !/(momo|bitcoin).*(tracker)|bitcoin-trend-tracker/.test(productId)) return false;
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

const researchSourceLabel = (datum) => {
  const label = datum?.productLabel
    || datum?.sourceLabel
    || datum?.source?.label
    || datum?.source?.name
    || datum?.productId
    || datum?.product
    || datum?.sourceId;
  return label && typeof label !== 'object' ? String(label) : 'Research';
};

const safeResearchUrl = (value) => {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (/^\/\//.test(trimmed)) return null;
  return /^(https?:\/\/|\/(?!\/))/i.test(trimmed) ? trimmed : null;
};

const asArray = (value) => (Array.isArray(value) ? value : []);

const researchReferenceText = (reference) => (
  reference?.excerpt
  || reference?.description
  || reference?.summary
  || reference?.headline
  || ''
);

const normalizeResearchReferenceText = (value) => String(value || '')
  .replace(/\s+/g, ' ')
  .trim();

const researchEvidenceExcerpt = (reference) => {
  const rawText = normalizeResearchReferenceText(researchReferenceText(reference));
  if (!rawText) return '';
  if (!/\b(unsubscribe|manage (?:your )?preferences|prepared exclusively|having trouble viewing)\b/i.test(rawText)) {
    return rawText;
  }
  const tokens = [reference?.matchedText, reference?.exposureLabel]
    .map((value) => normalizeResearchReferenceText(value))
    .filter((value) => value.length > 1);
  if (tokens.length === 0) return '';
  const sentences = rawText.match(/[^.!?]+(?:[.!?]+|$)/g)?.map((sentence) => sentence.trim()).filter(Boolean) || [];
  const relevant = sentences.filter((sentence) => (
    !/\b(unsubscribe|manage (?:your )?preferences|prepared exclusively|having trouble viewing)\b/i.test(sentence)
      && tokens.some((token) => new RegExp(
        `(^|[^A-Za-z0-9])${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^A-Za-z0-9])`,
        'i',
      ).test(sentence))
  ));
  return normalizeResearchReferenceText(relevant.join(' '));
};

const formatResearchReferenceNumber = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric)
    ? numeric.toLocaleString(undefined, { maximumFractionDigits: 2 })
    : null;
};

const formatEmbeddedResearchJson = (value) => {
  const text = normalizeResearchReferenceText(value);
  if (!(text.startsWith('{') && text.endsWith('}'))) return null;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const symbol = String(parsed.ticker || parsed.symbol || parsed.security || '').trim().toUpperCase();
    const lrr = formatResearchReferenceNumber(parsed.lrr ?? parsed.low ?? parsed.riskRangeLow);
    const hrr = formatResearchReferenceNumber(parsed.hrr ?? parsed.high ?? parsed.riskRangeHigh);
    if (lrr !== null || hrr !== null) {
      return [
        symbol || null,
        `LRR ${lrr || '—'} – HRR ${hrr || '—'}`,
        parsed.trend ? `Trend ${String(parsed.trend).toUpperCase()}` : null,
      ].filter(Boolean).join(' · ');
    }
    const rank = formatResearchReferenceNumber(parsed.rank);
    if (symbol && rank !== null) {
      return [
        `${symbol} ranked #${rank}`,
        parsed.positionSizing ? `Sizing ${parsed.positionSizing}` : null,
        parsed.weekAgo ? `Weekly ${parsed.weekAgo}` : null,
        parsed.monthAgo ? `Monthly ${parsed.monthAgo}` : null,
      ].filter(Boolean).join('; ');
    }
    const change = formatResearchReferenceNumber(parsed.change);
    if (symbol && change !== null) return `${symbol} rank change ${change}`;
  } catch (_error) {
    return null;
  }
  return null;
};

const formatResearchReferenceDetail = (reference) => {
  const rawText = researchEvidenceExcerpt(reference);
  const text = formatEmbeddedResearchJson(rawText)
    || normalizeResearchReferenceText(rawText);
  if (!text) return null;
  const direction = String(reference?.direction || '').trim().toUpperCase();
  if (!direction) return text;
  const escapedDirection = direction.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const directionAlreadyLabeled = new RegExp(
    `(^|[·—:;])\\s*${escapedDirection}\\b|\\b(?:trend|trade)\\s+${escapedDirection}\\b`,
    'i',
  ).test(text);
  return directionAlreadyLabeled
    ? text
    : `${direction} · ${text}`;
};

const researchReferenceScore = (reference, detail) => {
  const kind = String(reference?.kind || '').trim().toLowerCase();
  let score = RESEARCH_REFERENCE_KIND_PRIORITY[kind] || 50;
  const matchType = String(reference?.matchType || '').trim().toLowerCase();
  if (matchType === 'direct') score += 20;
  else if (matchType === 'direct_alias') score += 15;
  if (reference?.direction) score += 5;
  if (reference?.value !== undefined && reference?.value !== null) score += 5;
  if (detail.length <= 240) score += 8;
  if (detail.length > 420) score -= 12;
  if (detail.length > 600) score -= 18;
  if (/\b(unsubscribe|manage your preferences|prepared exclusively|having trouble viewing)\b/i.test(detail)) {
    score -= 90;
  }
  if (/^[A-Z0-9./=^_-]{1,20}$/.test(detail)) score -= 18;
  if (/^[{[]/.test(normalizeResearchReferenceText(researchReferenceText(reference)))) score -= 20;
  return score;
};

const isResearchBoilerplate = (value) => {
  const text = normalizeResearchReferenceText(value);
  if (!text) return true;
  if (/\b(unsubscribe|manage (?:your )?preferences|prepared exclusively|having trouble viewing)\b/i.test(text)) {
    return true;
  }
  return /^[A-Z0-9./=^_-]{1,20}$/.test(text);
};

const researchReferenceIsMapped = (reference) => (
  String(reference?.matchType || '').trim().toLowerCase() === 'inferred_exposure'
);

const researchEvidenceScore = (reference, detail) => (
  researchReferenceScore(reference, detail)
  + (researchReferenceIsMapped(reference) ? -18 : 0)
  + (reference?.matchedText ? 5 : 0)
);

const compactResearchEvidence = (productId, references) => {
  const ranked = asArray(references).map((reference) => {
    const rawText = researchEvidenceExcerpt(reference);
    const detail = formatResearchReferenceDetail(reference);
    const kind = String(reference?.kind || '').trim().toLowerCase();
    return {
      reference,
      rawText,
      detail,
      kind,
      score: detail && !isResearchBoilerplate(rawText)
        ? researchEvidenceScore(reference, detail)
        : Number.NEGATIVE_INFINITY,
    };
  }).filter((item) => item.detail && Number.isFinite(item.score)).sort((left, right) => (
    Number(researchReferenceIsMapped(left.reference)) - Number(researchReferenceIsMapped(right.reference))
    || right.score - left.score
    || String(left.reference?.publishedAt || '').localeCompare(String(right.reference?.publishedAt || ''))
    || right.rawText.length - left.rawText.length
  ));

  const selected = [];
  ranked.forEach((candidate) => {
    const normalized = candidate.rawText.toLowerCase();
    const duplicate = selected.some((item) => {
      const existing = item.rawText.toLowerCase();
      if (existing === normalized) return true;
      // A short structured/ticker-only match is redundant when a richer
      // excerpt from the same publication already contains it.
      if (Math.min(existing.length, normalized.length) < 40) {
        return existing.includes(normalized) || normalized.includes(existing);
      }
      if (item.reference?.sourceEventId && item.reference.sourceEventId === candidate.reference?.sourceEventId) {
        return existing.includes(normalized) || normalized.includes(existing);
      }
      if (productId === 'portfolio-solutions' && item.kind === candidate.kind) {
        return existing.includes(normalized) || normalized.includes(existing);
      }
      return existing.includes(normalized) || normalized.includes(existing);
    });
    if (!duplicate) selected.push(candidate);
  });
  return selected;
};

const RESEARCH_FACT_LINE_LIMIT = 4;
const RESEARCH_FACT_ORDER = Object.freeze({
  rank: 10,
  sizing: 20,
  weeklyChange: 30,
  monthlyChange: 40,
  riskRange: 50,
  trend: 60,
  trade: 70,
  buyTrade: 80,
  sellTrade: 90,
  signalStrength: 100,
  position: 110,
  etfPro: 120,
});

const ensureResearchSentence = (value) => {
  const text = normalizeResearchReferenceText(value);
  if (!text) return null;
  return /[.!?]$/.test(text) ? text : `${text}.`;
};

const formatResearchSignedChange = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const text = normalizeResearchReferenceText(value);
  const arrowMatch = text.match(/^([▲△↑▼▽↓])\s*([+-]?\d+(?:\.\d+)?)$/);
  if (arrowMatch) {
    const magnitude = Math.abs(Number(arrowMatch[2]));
    return /[▲△↑]/.test(arrowMatch[1]) ? `+${magnitude}` : `-${magnitude}`;
  }
  const numeric = Number(text.replace(/,/g, ''));
  if (!Number.isFinite(numeric)) return text;
  const formatted = formatResearchReferenceNumber(numeric);
  return numeric > 0 ? `+${formatted}` : formatted;
};

const researchLabeledValue = (value, labelPattern) => {
  const text = normalizeResearchReferenceText(value);
  if (!text) return null;
  const match = text.match(new RegExp(
    `\\b(?:${labelPattern})\\b\\s*(?::|=|is)?\\s*([^;·|]+?)(?=\\s*(?:[;·|]|$))`,
    'i',
  ));
  return normalizeResearchReferenceText(match?.[1]);
};

const buildStructuredResearchFacts = (productId, evidence, symbol) => {
  const reference = evidence?.reference || {};
  const kind = String(evidence?.kind || reference.kind || '').trim().toLowerCase();
  const text = normalizeResearchReferenceText(evidence?.rawText || researchReferenceText(reference));
  const normalizedSymbol = String(symbol || reference.matchedText || '').trim().toUpperCase();
  const facts = [];
  const add = (key, factText) => {
    const sentence = ensureResearchSentence(factText);
    if (sentence) facts.push({ key, text: sentence });
  };

  if (productId === 'portfolio-solutions') {
    const rankValue = finiteOptionalNumber(reference.value);
    const rankMatch = text.match(/\branked?\s*#?\s*(\d+(?:\.\d+)?)/i);
    const rank = rankValue === null
      ? formatResearchReferenceNumber(rankMatch?.[1])
      : formatResearchReferenceNumber(rankValue);
    if (rank && normalizedSymbol) {
      add('rank', `${normalizedSymbol} is ranked #${rank} in today’s ETF re-rank`);
    }

    const sizing = researchLabeledValue(text, '(?:position\\s+)?sizing');
    if (sizing) add('sizing', `Recommended position sizing is ${sizing}`);

    const weekly = researchLabeledValue(text, 'weekly(?:\\s+rank\\s+change)?');
    if (weekly) add('weeklyChange', `Weekly rank change is ${formatResearchSignedChange(weekly)}`);
    const monthly = researchLabeledValue(text, 'monthly(?:\\s+rank\\s+change)?');
    if (monthly) add('monthlyChange', `Monthly rank change is ${formatResearchSignedChange(monthly)}`);

    if (kind === 'portfolio_solutions_mover') {
      const period = text.match(/\b(weekly|monthly)\b/i)?.[1]?.toLowerCase();
      const change = formatResearchSignedChange(
        finiteOptionalNumber(reference.value) ?? text.match(/\brank\s+change\s+([▲△↑▼▽↓]?\s*[+-]?\d+(?:\.\d+)?)/i)?.[1],
      );
      if (period && change) {
        add(
          period === 'weekly' ? 'weeklyChange' : 'monthlyChange',
          `${period === 'weekly' ? 'Weekly' : 'Monthly'} rank change is ${change}`,
        );
      }
    }
    return facts;
  }

  if (['primary_risk_range', 'supplemental_risk_range', 'historical_risk_range', 'risk_range'].includes(kind)) {
    const rangeValue = reference.value && typeof reference.value === 'object' ? reference.value : {};
    const lrrMatch = text.match(/\bLRR\s*\$?([\d,.]+)/i);
    const hrrMatch = text.match(/\bHRR\s*\$?([\d,.]+)/i);
    const lrr = formatResearchReferenceNumber(
      rangeValue.lrr ?? rangeValue.low ?? (lrrMatch ? Number(lrrMatch[1].replace(/,/g, '')) : null),
    );
    const hrr = formatResearchReferenceNumber(
      rangeValue.hrr ?? rangeValue.high ?? (hrrMatch ? Number(hrrMatch[1].replace(/,/g, '')) : null),
    );
    if (lrr && hrr && normalizedSymbol) add('riskRange', `${normalizedSymbol} risk range is ${lrr}–${hrr}`);
    const trend = String(reference.direction || rangeValue.trend || '').trim().toUpperCase();
    if (trend && normalizedSymbol) add('trend', `${normalizedSymbol} trend is ${trend}`);
    return facts;
  }

  if (['tracker_trade', 'trade_signal'].includes(kind)) {
    const trade = String(reference.direction || reference.value || '').trim().toUpperCase();
    if (trade && normalizedSymbol) add('trade', `${normalizedSymbol} trade signal is ${trade}`);
    const buyTrade = researchLabeledValue(text, 'buy\\s+trade');
    if (buyTrade) add('buyTrade', `Buy Trade is ${buyTrade}`);
    const sellTrade = researchLabeledValue(text, 'sell\\s+trade');
    if (sellTrade) add('sellTrade', `Sell Trade is ${sellTrade}`);
    return facts;
  }

  if (kind.startsWith('signal_strength_')) {
    if (!normalizedSymbol) return facts;
    if (kind === 'signal_strength_added') add('signalStrength', `${normalizedSymbol} was added to Signal Strength`);
    else if (kind === 'signal_strength_removed') add('signalStrength', `${normalizedSymbol} was removed from Signal Strength`);
    else {
      const direction = String(reference.direction || reference.value || '').trim().toUpperCase();
      if (direction) add('signalStrength', `${normalizedSymbol} Signal Strength status is ${direction}`);
    }
    return facts;
  }

  if (kind === 'position_mention') {
    const direction = String(reference.direction || reference.value || '').trim().toUpperCase();
    if (direction && normalizedSymbol) {
      add('position', `${normalizedSymbol} is listed ${direction} in ${researchSourceLabel(reference)}`);
    }
    return facts;
  }

  if (kind === 'etf_pro_change') {
    const direction = String(reference.direction || reference.value || '').trim().toUpperCase();
    if (direction && normalizedSymbol) {
      const action = direction === 'ADD' || direction === 'ADDED'
        ? 'was added to'
        : direction === 'REMOVE' || direction === 'REMOVED' ? 'was removed from' : `has a ${direction} update in`;
      add('etfPro', `${normalizedSymbol} ${action} ETF Pro`);
    }
    return facts;
  }

  return facts;
};

const clipResearchFocusText = (value, tokens, maxLength = 280) => {
  const text = normalizeResearchReferenceText(value);
  if (!text || text.length <= maxLength) return text;
  const lowerText = text.toLowerCase();
  const tokenIndex = tokens.map((token) => lowerText.indexOf(token.toLowerCase()))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0] ?? 0;
  let start = Math.max(0, tokenIndex - Math.floor(maxLength * 0.3));
  let end = Math.min(text.length, start + maxLength);
  if (end - start < maxLength) start = Math.max(0, end - maxLength);
  if (start > 0) {
    const nextSpace = text.indexOf(' ', start);
    if (nextSpace > start && nextSpace < end) start = nextSpace + 1;
  }
  if (end < text.length) {
    const previousSpace = text.lastIndexOf(' ', end);
    if (previousSpace > start) end = previousSpace;
  }
  const excerpt = text.slice(start, end).trim();
  return `${start > 0 ? '… ' : ''}${excerpt}${end < text.length ? ' …' : ''}`;
};

const researchFocusSentence = (reference, symbol, fallbackText = null) => {
  const text = normalizeResearchReferenceText(fallbackText || researchEvidenceExcerpt(reference));
  if (!text) return null;
  const tokens = [
    reference?.matchedText,
    reference?.exposureLabel,
    symbol,
  ].map((value) => normalizeResearchReferenceText(value)).filter(Boolean);
  const tokenMatcher = tokens.length > 0
    ? new RegExp(
      `(^|[^A-Za-z0-9])(?:${tokens.map((token) => token.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')).join('|')})(?=$|[^A-Za-z0-9])`,
      'i',
    )
    : null;
  const sentences = text.match(/[^.!?]+(?:[.!?]+|$)/g)
    ?.map((sentence) => sentence.trim())
    .filter(Boolean) || [];
  let focus = sentences.find((sentence) => tokenMatcher?.test(sentence)) || sentences[0] || text;
  if (focus.length > 280) {
    const clauses = focus.split(/\s*(?:;|\||•)\s*/).filter(Boolean);
    const matchedClause = clauses.find((clause) => tokenMatcher?.test(clause));
    if (matchedClause) focus = matchedClause;
  }
  return clipResearchFocusText(focus, tokens);
};

const buildResearchFactLines = (productId, evidence, symbol) => {
  const rankedEvidence = asArray(evidence);
  const structuredFacts = [];
  rankedEvidence.forEach((item, evidenceIndex) => {
    buildStructuredResearchFacts(productId, item, symbol).forEach((fact, factIndex) => {
      structuredFacts.push({
        ...fact,
        reference: item.reference,
        evidenceIndex,
        factIndex,
      });
    });
  });

  const candidates = structuredFacts.length > 0
    ? structuredFacts.sort((left, right) => (
      (RESEARCH_FACT_ORDER[left.key] ?? 500) - (RESEARCH_FACT_ORDER[right.key] ?? 500)
      || left.evidenceIndex - right.evidenceIndex
      || left.factIndex - right.factIndex
    ))
    : rankedEvidence.map((item, evidenceIndex) => ({
      key: `source-${evidenceIndex}`,
      text: researchFocusSentence(item.reference, symbol, item.rawText),
      reference: item.reference,
      evidenceIndex,
      factIndex: 0,
    }));

  const selected = [];
  candidates.some((candidate) => {
    if (!candidate.text) return false;
    const mapped = researchReferenceIsMapped(candidate.reference);
    const mappedLabel = normalizeResearchReferenceText(
      candidate.reference?.exposureLabel || candidate.reference?.matchedText || 'controlled exposure',
    );
    const text = mapped ? `Mapped from ${mappedLabel}: ${candidate.text}` : candidate.text;
    const normalized = normalizeResearchReferenceText(text).toLowerCase();
    const duplicate = selected.some((item) => (
      item.key === candidate.key
      || normalizeResearchReferenceText(item.text).toLowerCase() === normalized
    ));
    if (!duplicate) selected.push({ ...candidate, text });
    return selected.length >= RESEARCH_FACT_LINE_LIMIT;
  });
  return selected;
};

const selectResearchProductDetails = (productId, references) => {
  const ranked = references.map((reference) => {
    const detail = formatResearchReferenceDetail(reference);
    const kind = String(reference?.kind || '').trim().toLowerCase();
    return {
      reference,
      detail,
      kind,
      kindPriority: RESEARCH_REFERENCE_KIND_PRIORITY[kind] || 50,
      score: detail ? researchReferenceScore(reference, detail) : Number.NEGATIVE_INFINITY,
    };
  }).filter((item) => item.detail && !isResearchBoilerplate(researchEvidenceExcerpt(item.reference))).sort((left, right) => (
    right.score - left.score
    || String(right.reference?.publishedAt || '').localeCompare(String(left.reference?.publishedAt || ''))
    || left.detail.length - right.detail.length
  ));

  if (ranked.length === 0) return { selected: [], details: [] };
  const top = ranked[0];
  const candidates = ranked.filter((item) => (
    top.kindPriority >= 110
      ? item.kindPriority >= top.kindPriority - 15
      : item.score >= top.score - 32
  ));
  const limit = ['portfolio-solutions', 'real-time-alert', 'etf-pro', 'signal-strength'].includes(productId)
    ? 4
    : 3;
  const selected = [];
  candidates.some((candidate) => {
    const normalized = candidate.detail.toLowerCase();
    const moverPeriod = candidate.kind === 'portfolio_solutions_mover'
      ? normalized.match(/\b(weekly|monthly)\b/)?.[1]
      : null;
    const duplicate = selected.some((item) => {
      const existing = item.detail.toLowerCase();
      if (existing === normalized) return true;
      if (
        productId === 'portfolio-solutions'
        && moverPeriod
        && item.kind === 'portfolio_solutions_rank'
        && existing.includes(moverPeriod)
      ) return true;
      return item.kind === candidate.kind
        && Math.min(existing.length, normalized.length) >= 8
        && (existing.includes(normalized) || normalized.includes(existing));
    });
    if (!duplicate) selected.push(candidate);
    return selected.length >= limit;
  });
  if (selected.length === 0) selected.push(top);
  return {
    selected,
    details: selected.map((item) => item.detail),
  };
};

const latestResearchPublicationTime = (references, product = null) => {
  const validCandidates = (values) => values.filter(Boolean)
    .map((value) => ({ value, timestamp: Date.parse(value) }))
    .filter((candidate) => Number.isFinite(candidate.timestamp));
  const referenceCandidates = validCandidates(
    references.map((reference) => reference?.publishedAt)
      .filter((value) => !/T00:00(?::00(?:\.000)?)?(?:Z|[+-]00:00)?$/i.test(String(value || ''))),
  );
  const productCandidates = validCandidates([product?.publishedAt, product?.latestPublishedAt]);
  const fallbackCandidates = validCandidates(references.map((reference) => reference?.publishedAt));
  return [referenceCandidates, productCandidates, fallbackCandidates]
    .find((candidates) => candidates.length > 0)
    ?.sort((left, right) => right.timestamp - left.timestamp)[0]?.value || null;
};

const buildResearchProductRows = ({
  references,
  symbol = null,
  productsById = new Map(),
  productOrder = new Map(),
  marketDate = null,
  requireCurrentIndexed = false,
  groupByDate = false,
  includeEmptyProducts = false,
}) => {
  const groups = new Map();
  if (includeEmptyProducts && !groupByDate) {
    productsById.forEach((product, productId) => {
      if (!productId || productId === 'unknown' || product?.cadence === 'unsupported') return;
      groups.set(productId, {
        key: productId,
        productId,
        product,
        marketDate: normalizeResearchDate(product.marketDate || marketDate) || marketDate,
        references: [],
      });
    });
  }
  references.forEach((reference) => {
    const productId = getResearchProductId(reference);
    const referenceDate = getResearchDatumDate(reference);
    if (!productId || productId === 'unknown' || !referenceDate) return;
    const product = productsById.get(productId) || null;
    if (requireCurrentIndexed && (
      !product
      || !['indexed', 'not_due'].includes(String(product.status || '').toLowerCase())
      || normalizeResearchDate(product.marketDate || marketDate) !== marketDate
    )) return;
    const key = groupByDate ? `${referenceDate}\u0000${productId}` : productId;
    const group = groups.get(key) || {
      key,
      productId,
      product,
      marketDate: referenceDate,
      references: [],
    };
    group.references.push(reference);
    groups.set(key, group);
  });

  return [...groups.values()].map((group) => {
    const selection = selectResearchProductDetails(group.productId, group.references);
    const evidence = compactResearchEvidence(group.productId, group.references);
    const factEntries = buildResearchFactLines(group.productId, evidence, symbol);
    const selectedReference = selection.selected[0]?.reference || group.references[0];
    const sourceReference = factEntries
      .map((item) => item.reference)
      .find((reference) => safeResearchUrl(reference?.sourceUrl || reference?.url))
      || selection.selected.map((item) => item.reference)
      .find((reference) => safeResearchUrl(reference?.sourceUrl || reference?.url))
      || group.references.find((reference) => safeResearchUrl(reference?.sourceUrl || reference?.url))
      || selectedReference;
    const productLabel = group.product?.label || researchSourceLabel(selectedReference);
    const publishedAt = latestResearchPublicationTime(group.references, group.product);
    const productStatus = String(group.product?.status || '').trim().toLowerCase();
    const hasEvidence = evidence.length > 0;
    const productDateMismatch = Boolean(
      !groupByDate
      && marketDate
      && normalizeResearchDate(group.product?.marketDate || group.marketDate) !== normalizeResearchDate(marketDate)
    );
    const isUnavailable = !hasEvidence && (
      productDateMismatch || !['indexed', 'not_due'].includes(productStatus)
    );
    return {
      key: group.key,
      productId: group.productId,
      productLabel,
      marketDate: group.marketDate,
      publishedAt,
      referenceCount: group.references.length,
      references: group.references,
      evidence,
      factLines: factEntries.map((item) => item.text),
      status: productStatus || null,
      state: hasEvidence ? 'available' : isUnavailable ? 'unavailable' : 'empty',
      reference: {
        ...selectedReference,
        id: `${group.marketDate}-${group.productId}-product-row`,
        productId: group.productId,
        productLabel,
        marketDate: group.marketDate,
        publishedAt,
        direction: null,
        excerpt: selection.details.join(' · ') || null,
        sourceUrl: sourceReference?.sourceUrl || sourceReference?.url || null,
      },
    };
  }).sort((left, right) => {
    if (groupByDate && left.marketDate !== right.marketDate) {
      return String(right.marketDate).localeCompare(String(left.marketDate));
    }
    if (!groupByDate) {
      const orderDelta = (productOrder.get(left.productId) ?? Number.MAX_SAFE_INTEGER)
        - (productOrder.get(right.productId) ?? Number.MAX_SAFE_INTEGER);
      if (orderDelta !== 0) return orderDelta;
    }
    const leftTime = Date.parse(left.publishedAt || '');
    const rightTime = Date.parse(right.publishedAt || '');
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
      return leftTime - rightTime;
    }
    if (Number.isFinite(leftTime) !== Number.isFinite(rightTime)) return Number.isFinite(leftTime) ? -1 : 1;
    return (productOrder.get(left.productId) ?? Number.MAX_SAFE_INTEGER)
      - (productOrder.get(right.productId) ?? Number.MAX_SAFE_INTEGER)
      || left.productLabel.localeCompare(right.productLabel);
  });
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
  const [metricVerification, setMetricVerification] = useState(null);
  const [researchMarketDate, setResearchMarketDate] = useState(null);
  const [researchState, setResearchState] = useState({
    status: 'idle',
    data: null,
    error: null,
    symbolsKey: null,
  });
  const [marketContextState, setMarketContextState] = useState({
    status: 'idle',
    riskMetrics: null,
    volatility: null,
    usdCorrelations: null,
    errors: {},
  });
  const [factorExposureDimension, setFactorExposureDimension] = useState('equityStyleFactors');
  const [selectedFactorExposureId, setSelectedFactorExposureId] = useState(null);
  const [manualResearchRefreshKey, setManualResearchRefreshKey] = useState(0);
  const researchRequestSequence = useRef(0);
  const marketContextRequestSequence = useRef(0);
  const researchProductRowsCacheRef = useRef(new WeakMap());
  const researchFallbackPayloadRef = useRef({});
  const lastVerifiedRiskMetricsRef = useRef(null);

  useEffect(() => {
    if (!active || !metricVerification) return undefined;
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') setMetricVerification(null);
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [active, metricVerification]);

  const researchSymbols = useMemo(() => [...new Set(
    holdings
      .map((holding) => String(holding?.symbol || '').trim().toUpperCase())
      .filter(Boolean)
  )].sort(), [holdings]);
  const researchSymbolsKey = researchSymbols.join(',');
  const researchAssetTypes = useMemo(() => {
    const map = {};
    holdings.forEach((holding) => {
      const symbol = String(holding?.symbol || '').trim().toUpperCase();
      if (!symbol) return;
      const assetClass = getAssetClassForTicker(symbol, holding);
      map[symbol] = assetClass === 'Cryptocurrency' ? 'crypto' : 'equity';
    });
    return map;
  }, [holdings]);
  const researchAssetTypesKey = useMemo(
    () => researchSymbols
      .map((symbol) => `${symbol}:${researchAssetTypes[symbol] || 'equity'}`)
      .join(','),
    [researchSymbols, researchAssetTypes],
  );

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

  const loadSecurityIntelligence = useCallback(async (signal) => {
    const symbols = researchSymbolsKey ? researchSymbolsKey.split(',') : [];
    const requestSequence = researchRequestSequence.current + 1;
    researchRequestSequence.current = requestSequence;

    if (symbols.length === 0) {
      setResearchState({
        status: 'empty',
        data: null,
        error: null,
        symbolsKey: researchSymbolsKey,
      });
      return;
    }

    // Preserve only the last successfully verified response for the exact
    // same symbol set while refreshing. It remains dated research context,
    // never an executable quote or a substitute for current holdings.
    setResearchState((current) => ({
      status: 'loading',
      data: current.symbolsKey === researchSymbolsKey ? current.data : null,
      error: null,
      symbolsKey: researchSymbolsKey,
    }));
    try {
      const data = await MarketDataService.getSecurityIntelligence({
        symbols,
        historyDays: RESEARCH_HISTORY_DAYS,
        signal,
      });
      if (signal?.aborted || researchRequestSequence.current !== requestSequence) return;
      const responseMarketDate = normalizeResearchDate(data?.marketDate);
      setResearchMarketDate(responseMarketDate);
      setResearchState({
        status: 'ready',
        data,
        error: null,
        symbolsKey: researchSymbolsKey,
      });
    } catch (error) {
      if (signal?.aborted || researchRequestSequence.current !== requestSequence) return;
      setResearchState((current) => ({
        status: 'error',
        data: current.symbolsKey === researchSymbolsKey ? current.data : null,
        error: error?.message || 'Verified research is unavailable.',
        symbolsKey: researchSymbolsKey,
      }));
    }
  }, [researchSymbolsKey]);

  const loadMarketContext = useCallback(async () => {
    const symbols = researchSymbolsKey ? researchSymbolsKey.split(',') : [];
    const requestSequence = marketContextRequestSequence.current + 1;
    marketContextRequestSequence.current = requestSequence;

    if (symbols.length === 0) {
      setMarketContextState({
        status: 'empty',
        riskMetrics: null,
        volatility: null,
        usdCorrelations: null,
        errors: {},
      });
      return;
    }

    // Beta/ATR/Z-score are explicitly historical-only and non-executable.
    // Keep the last verified completed-session payload visible while a refresh
    // runs; live/delayed volatility and correlation payloads still clear.
    setMarketContextState((current) => ({
      status: 'loading',
      riskMetrics: current.riskMetrics || lastVerifiedRiskMetricsRef.current,
      volatility: current.volatility,
      usdCorrelations: current.usdCorrelations,
      errors: {},
    }));

    const symbolBatches = [];
    for (let index = 0; index < symbols.length; index += RISK_METRICS_BATCH_SIZE) {
      symbolBatches.push(symbols.slice(index, index + RISK_METRICS_BATCH_SIZE));
    }

    const [riskResult, volatilityResult, usdResult] = await Promise.allSettled([
      Promise.all(symbolBatches.map((batch) => {
        const batchAssetTypes = Object.fromEntries(
          batch.map((symbol) => {
            const match = researchAssetTypesKey
              .split(',')
              .find((pair) => pair.startsWith(`${symbol}:`));
            const assetType = match ? match.slice(symbol.length + 1) : 'equity';
            return [symbol, assetType || 'equity'];
          }),
        );
        return MarketDataService.getSecurityRiskMetrics(batch, {
          assetTypes: batchAssetTypes,
        });
      })),
      MarketDataService.getVolatilitySnapshot(),
      MarketDataService.getUsdCorrelations(),
    ]);
    if (marketContextRequestSequence.current !== requestSequence) return;

    const riskPayloads = riskResult.status === 'fulfilled' ? riskResult.value : [];
    const riskContractVerified = riskPayloads.length > 0 && riskPayloads.every((payload) => (
      payload?.historicalOnly === true
      && payload?.executable === false
      && payload?._cache?.stale !== true
    ));
    const fetchedRiskMetrics = riskContractVerified
      ? {
        ...riskPayloads[0],
        rows: Object.assign({}, ...riskPayloads.map((payload) => payload?.rows || {})),
        historicalOnly: true,
        executable: false,
      }
      : null;
    if (fetchedRiskMetrics) {
      lastVerifiedRiskMetricsRef.current = fetchedRiskMetrics;
    }
    const riskMetrics = fetchedRiskMetrics || lastVerifiedRiskMetricsRef.current;
    const errors = {};
    if (riskResult.status === 'rejected') {
      errors.riskMetrics = riskResult.reason?.message || 'Historical security metrics are unavailable.';
    } else if (!riskContractVerified) {
      errors.riskMetrics = 'Historical security metrics failed the non-executable source contract.';
    }
    if (!fetchedRiskMetrics && riskMetrics) {
      errors.riskMetrics = `${errors.riskMetrics} Last verified completed-session metrics retained.`;
    }
    if (volatilityResult.status === 'rejected') {
      errors.volatility = volatilityResult.reason?.message || 'Volatility indexes are unavailable.';
    }
    if (usdResult.status === 'rejected') {
      errors.usdCorrelations = usdResult.reason?.message || 'USD correlations are unavailable.';
    }

    setMarketContextState((current) => ({
      status: Object.keys(errors).length > 0 ? 'partial' : 'ready',
      riskMetrics,
      volatility: volatilityResult.status === 'fulfilled'
        ? volatilityResult.value
        : retainHistoricalVolatilityRows(current.volatility),
      usdCorrelations: usdResult.status === 'fulfilled'
        ? usdResult.value
        : current.usdCorrelations,
      errors,
    }));
  }, [researchSymbolsKey, researchAssetTypesKey]);

  useEffect(() => {
    if (!active) return undefined;
    const controller = new AbortController();
    loadSecurityIntelligence(controller.signal);

    const intervalId = window.setInterval(() => {
      loadSecurityIntelligence(controller.signal);
    }, RESEARCH_REFRESH_INTERVAL_MS);

    return () => {
      controller.abort();
      window.clearInterval(intervalId);
    };
  }, [active, loadSecurityIntelligence, manualResearchRefreshKey]);

  useEffect(() => {
    if (!active) return undefined;
    loadMarketContext();
    const intervalId = window.setInterval(loadMarketContext, RESEARCH_REFRESH_INTERVAL_MS);
    return () => {
      marketContextRequestSequence.current += 1;
      window.clearInterval(intervalId);
    };
  }, [active, loadMarketContext, manualResearchRefreshKey]);

  const handleManualRefresh = useCallback(() => {
    setManualResearchRefreshKey((current) => current + 1);
    if (typeof onRefresh === 'function') {
      Promise.resolve(onRefresh()).catch(() => {
        // Portfolio connection errors are rendered by the owning dashboard.
        // Research refresh remains independent and fail-closed.
      });
    }
  }, [onRefresh]);

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

  const factorExposureAvailable = Boolean(
    hasVerifiedLiveNav
    && holdings.length > 0
    && holdings.every(canUseHoldingForSizing)
  );
  const factorExposure = useMemo(() => (
    factorExposureAvailable
      ? buildPortfolioFactorExposure(holdings, totalValue, factorExposureDimension)
      : { rows: [], coverage: { classifiedPct: 0, unclassifiedPct: 0 } }
  ), [factorExposureAvailable, factorExposureDimension, holdings, totalValue]);

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
  const [ledgerSearchFilter, setLedgerSearchFilter] = useState('');
  const [ledgerSortField, setLedgerSortField] = useState('weight');
  const [ledgerSleeveFilter, setLedgerSleeveFilter] = useState('all');

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
      case 'percentPortfolio':
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
      case 'qtyNeeded':
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
      case 'gainLoss':
        return React.cloneElement(renderPerformanceCell(holding.gainLossPercent), { key: columnKey });
      default:
        return null;
    }
  };

  // State for basis points and % portfolio inputs for each holding
  const [longsBasisPoints, setLongsBasisPoints] = useState({});
  const [longsPercentPortfolio, setLongsPercentPortfolio] = useState({});
  const [shortsBasisPoints, setShortsBasisPoints] = useState({});
  const [shortsPercentPortfolio, setShortsPercentPortfolio] = useState({});

  // State for tracking raw input values while editing (allows typing intermediate values like "2.")
  const [editingPercentPortfolio, setEditingPercentPortfolio] = useState({});

  // Separate longs and shorts
  const { longs, shorts } = useMemo(() => {
    return separateLongsAndShorts(holdings);
  }, [holdings]);

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

  // Calculate shares needed based on basis points
  const calculateSharesFromBasisPoints = (holding, basisPoints, totalValue, isShort = false) => {
    if (!canUseHoldingForSizing(holding) || !basisPoints || !totalValue) return null;
    const price = parseFloat(holding.price);
    if (price === 0) return null;

    // Basis points to dollar amount: (basisPoints / 10000) * totalValue
    const dollarAmount = (parseFloat(basisPoints) / 10000) * totalValue;
    let shares = dollarAmount / price;

    // For shorts: positive basis points means increase short (sell more = negative shares)
    // Negative basis points means reduce short (buy back = positive shares)
    if (isShort) {
      shares = -shares; // Flip sign for shorts
    }

    return Math.round(shares);
  };

  // Calculate shares needed based on target % of portfolio
  const calculateSharesFromPercent = (holding, targetPercent, totalValue, isShort = false) => {
    if (
      !canUseHoldingForSizing(holding)
      || targetPercent === undefined
      || targetPercent === null
      || !totalValue
    ) return null;
    const price = parseFloat(holding.price);
    if (price === 0) return null;

    // Current % of portfolio - use rounded value to match what's displayed
    // This ensures the calculation matches user expectations from the UI
    const currentPercentRaw = totalValue > 0 ? ((Math.abs(holding.marketValue) / totalValue) * 100) : 0;
    const currentPercent = Math.round(currentPercentRaw * 100) / 100; // Round to 2 decimal places
    const targetPercentNum = parseFloat(targetPercent);

    // Round target to 2 decimal places as well for consistent comparison
    const targetPercentRounded = Math.round(targetPercentNum * 100) / 100;

    // Difference in percentage (using rounded values)
    const percentDiff = targetPercentRounded - currentPercent;

    // If no difference after rounding, return 0
    if (Math.abs(percentDiff) < 0.001) return 0;

    // Dollar amount needed: (percentDiff / 100) * totalValue
    const dollarAmount = (percentDiff / 100) * totalValue;
    let shares = dollarAmount / price;

    // For shorts: if target % is higher than current, we need to sell more (negative shares)
    // If target % is lower, we need to buy back (positive shares)
    if (isShort) {
      shares = -shares; // Flip sign for shorts
    }

    // Round shares, but ensure at least 1 or -1 if there's any non-zero diff
    // This prevents the counter showing 0 when the user has changed the target %
    if (shares > 0 && shares < 1) {
      return 1;
    } else if (shares < 0 && shares > -1) {
      return -1;
    }

    return Math.round(shares);
  };

  const getHoldingTargetPercent = useCallback((holding, isLongs) => {
    const percentPortfolioState = isLongs ? longsPercentPortfolio : shortsPercentPortfolio;
    const basisPointsState = isLongs ? longsBasisPoints : shortsBasisPoints;
    const absolutePct = getPortfolioWeight(holding, totalValue);
    if (absolutePct === null && percentPortfolioState[holding.symbol] === undefined) return null;
    const currentPct = isLongs ? absolutePct : -absolutePct;
    if (percentPortfolioState[holding.symbol] !== undefined) return Number(percentPortfolioState[holding.symbol]);
    if (basisPointsState[holding.symbol] !== undefined) return currentPct + (Number(basisPointsState[holding.symbol]) / 100);
    return currentPct;
  }, [longsBasisPoints, longsPercentPortfolio, shortsBasisPoints, shortsPercentPortfolio, totalValue]);

  const getResizeShares = (holding, isLongs) => {
    if (!canUseHoldingForSizing(holding)) return null;
    const percentPortfolioState = isLongs ? longsPercentPortfolio : shortsPercentPortfolio;
    const basisPointsState = isLongs ? longsBasisPoints : shortsBasisPoints;
    const targetPercent = percentPortfolioState[holding.symbol];
    const basisPoints = basisPointsState[holding.symbol];

    if (targetPercent !== undefined) {
      return calculateSharesFromPercent(holding, Math.abs(Number(targetPercent)), totalValue, !isLongs);
    }

    if (basisPoints) {
      return calculateSharesFromBasisPoints(holding, basisPoints, totalValue, !isLongs);
    }

    return 0;
  };

  const getActionForResize = (shares, isLongs, holding = null) => {
    if (shares === null || shares === undefined) {
      return {
        label: isHistoricalReferenceMark(holding) ? 'Reference only' : 'Unavailable',
        tone: 'neutral',
      };
    }
    const absShares = Math.abs(Number(shares) || 0);
    if (!absShares) return { label: 'Hold', tone: 'neutral' };

    if (isLongs) {
      return shares < 0
        ? { label: `Trim ${absShares}`, tone: 'trim' }
        : { label: `Add ${absShares}`, tone: 'add' };
    }

    return shares > 0
      ? { label: `Cover ${absShares}`, tone: 'add' }
      : { label: `Short ${absShares}`, tone: 'trim' };
  };

  const getDayGainLossPercent = (holding) => (
    getVerifiedDayGainLossPercent(holding, hasVerifiedPortfolioMarks)
  );

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

  const sortLedgerHoldings = useCallback((rows) => {
    const sorted = [...rows];
    sorted.sort((a, b) => {
      const getValue = (holding) => {
        const weight = getPortfolioWeight(holding, totalValue);
        switch (ledgerSortField) {
          case 'ticker':
            return (holding.symbol || '').toUpperCase();
          case 'name':
            return getSecurityName(holding).toUpperCase();
          case 'dayGainLoss':
            return Math.abs(
              getVerifiedDayGainLossPercent(holding, hasVerifiedPortfolioMarks) || 0
            );
          case 'weight':
          default:
            return weight ?? Number.NEGATIVE_INFINITY;
        }
      };

      const aValue = getValue(a);
      const bValue = getValue(b);
      if (typeof aValue === 'string' || typeof bValue === 'string') {
        return String(aValue).localeCompare(String(bValue));
      }
      return Number(bValue) - Number(aValue);
    });
    return sorted;
  }, [hasVerifiedPortfolioMarks, ledgerSortField, totalValue]);

  const filterLedgerHoldings = useCallback((rows) => {
    const query = ledgerSearchFilter.trim().toLowerCase();
    return rows.filter(holding => {
      if (ledgerSleeveFilter !== 'all' && getSleeveForHolding(holding) !== ledgerSleeveFilter) return false;
      if (
        factorExposureAvailable
        && selectedFactorExposureId
        && !holdingMatchesFactorExposure(
          holding,
          factorExposureDimension,
          selectedFactorExposureId,
        )
      ) return false;
      if (!query) return true;
      const name = getSecurityName(holding).toLowerCase();
      const symbol = (holding.symbol || '').toLowerCase();
      return symbol.includes(query) || name.includes(query);
    });
  }, [
    factorExposureAvailable,
    factorExposureDimension,
    ledgerSearchFilter,
    ledgerSleeveFilter,
    selectedFactorExposureId,
  ]);

  const ledgerLongs = useMemo(() => {
    return sortLedgerHoldings(filterLedgerHoldings(longs));
  }, [filterLedgerHoldings, longs, sortLedgerHoldings]);

  const ledgerShorts = useMemo(() => {
    return sortLedgerHoldings(filterLedgerHoldings(shorts));
  }, [filterLedgerHoldings, shorts, sortLedgerHoldings]);

  const ledgerRows = useMemo(() => ([
    ...ledgerLongs.map((holding, index) => ({ holding, index, isLongs: true })),
    ...ledgerShorts.map((holding, index) => ({ holding, index, isLongs: false }))
  ]), [ledgerLongs, ledgerShorts]);

  const handleExportCsv = () => {
    const rows = [
      ['Rank', 'Ticker', 'Name', 'Side', 'Weight % (NAV)', 'Target % (NAV)', '+EV Exposure Labels', 'Exposure Ctrb', 'Resize (Shares)', 'Price', 'Day G/L (%)', 'Action']
    ];

    ledgerRows.forEach(({ holding, index, isLongs }) => {
      const currentPct = getPortfolioWeight(holding, totalValue);
      const targetPct = getHoldingTargetPercent(holding, isLongs);
      const exposureLabels = getQuadExposureLabels(holding);
      const shares = getResizeShares(holding, isLongs);
      const action = getActionForResize(shares, isLongs, holding);
      const mark = getVerifiedHoldingMark(holding, hasVerifiedPortfolioMarks);
      const dayGainLossPercent = getDayGainLossPercent(holding);

      rows.push([
        index + 1,
        holding.symbol || '',
        getSecurityName(holding),
        isLongs ? 'Long' : 'Short',
        currentPct === null ? '' : (isLongs ? currentPct : -currentPct).toFixed(2),
        Number.isFinite(targetPct) ? targetPct.toFixed(2) : '',
        exposureLabels.join(' · ') || 'Unclassified',
        currentPct === null ? '' : formatPct(isLongs ? currentPct : -currentPct, 1, { signed: true }),
        shares ?? '',
        mark === null ? '' : mark.value.toFixed(4),
        dayGainLossPercent === null ? '' : dayGainLossPercent.toFixed(2),
        action.label
      ]);
    });

    const csv = rows.map((row) => row.map(csvEscape).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `portfolio-construction-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const hasLivePortfolio = Boolean(
    portfolioData
    && (
      holdings.length > 0
      || totalValue !== 0
      || portfolioData?.accountSummary?.netLiquidation
    )
  );
  const portfolioAvailabilityLabel = !hasLivePortfolio
    ? (
      isLoading
        ? 'Connecting to live portfolio…'
        : 'Live portfolio unavailable — connect IB Gateway and the IBKR API.'
    )
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

  const holdingSourceTitle = (holding) =>
    [
      holding.positionSource && `pos: ${holding.positionSource}`,
      holding.priceSource && `price: ${holding.priceSource}`,
      holding.priceSessionDate && `session: ${holding.priceSessionDate}`,
      holding.priceObservedAt && `observed: ${holding.priceObservedAt}`,
      holding.warning,
    ]
      .filter(Boolean)
      .join(' · ');

  const renderHoldingWarningIcon = (holding) => {
    const historicalReference = isHistoricalReferenceMark(holding);
    const markLoading = (
      holding?.markPending === true
      || holding?.markWarmState === 'warming'
      || holding?.warning === 'reference_mark_warming'
    );
    const unavailableMark = (
      ['unavailable', 'failed', 'error'].includes(String(holding?.priceState || '').toLowerCase())
      || ['unavailable', 'failed', 'error'].includes(String(holding?.marketValueState || '').toLowerCase())
      || ['degraded', 'unavailable'].includes(String(holding?.markWarmState || '').toLowerCase())
    );
    const nonBenignWarning = Boolean(
      holding?.warning && holding.warning !== 'reference_mark_warming'
    );
    const hasError = Boolean(
      holding?.markFailure
      || nonBenignWarning
      || (!historicalReference && !markLoading && unavailableMark)
    );
    if (!historicalReference && !markLoading && !hasError) return null;

    const state = hasError ? 'error' : historicalReference ? 'reference' : markLoading ? 'loading' : 'error';
    const title = state === 'reference'
      ? `EOD close${holding.priceSessionDate ? ` from ${holding.priceSessionDate}` : ''}; reference only, not a live executable mark`
      : state === 'loading'
        ? 'Live IBKR market mark is still loading; no executable price is shown'
        : holding.warning || 'Verified live market mark is unavailable';
    const ariaLabel = state === 'reference'
      ? 'EOD reference close'
      : state === 'loading'
        ? 'Market mark loading'
        : 'Bad data warning';

    return (
      <span
        className={`pcv2-mark-status pcv2-mark-status--${state}`}
        aria-label={ariaLabel}
        title={title}
      >
        {state === 'reference' ? (
          <>
            <CalendarClock size={11} strokeWidth={2} aria-hidden="true" />
            <span aria-hidden="true">EOD</span>
          </>
        ) : state === 'loading' ? (
          <RefreshCw size={10} strokeWidth={2} aria-hidden="true" />
        ) : (
          <span aria-hidden="true">⚠</span>
        )}
      </span>
    );
  };

  const researchPayload = researchState.data?.data && researchState.data?.data?.bySymbol
    ? researchState.data.data
    : researchState.data;
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
      ...normalizeReferences(entry.inferredReferences, 'inferred_exposure'),
      ...normalizeReferences(entry.todayReferences, 'direct'),
      ...normalizeReferences(entry.current?.references, 'direct'),
    ];
    return uniqueReferences(references).filter((reference) => (
      getResearchDatumDate(reference) === researchMarketDate
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
          && isVerifiedResearchReference(reference, { historical: true });
      })
      .sort((a, b) => String(getResearchDatumDate(b)).localeCompare(String(getResearchDatumDate(a))));
  };

  const formatResearchNumber = (value) => {
    const number = Number(value);
    if (!Number.isFinite(number)) return value === null || value === undefined || value === '' ? '—' : String(value);
    return number.toLocaleString(undefined, { maximumFractionDigits: 2 });
  };

  const getVerifiedRiskMetrics = (symbol) => {
    const payload = marketContextState.riskMetrics;
    const row = payload?.rows?.[String(symbol || '').trim().toUpperCase()];
    if (
      !payload
      || payload.historicalOnly !== true
      || payload.executable !== false
      || !row
      || row.historicalOnly !== true
      || row.executable !== false
    ) {
      return null;
    }
    return row;
  };

  const getPositionSizeReference = (symbol) => {
    const normalizedSymbol = String(symbol || '').trim().toUpperCase();
    const riskMetrics = getVerifiedRiskMetrics(normalizedSymbol);
    const beta = riskMetrics?.beta?.status === 'available'
      && finiteOptionalNumber(riskMetrics.beta.value) !== null ? riskMetrics.beta : null;
    const sizingMetric = (
      beta
      && finiteOptionalNumber(beta.observations) >= SIZING_CONSTANTS.MIN_BETA_OBSERVATIONS
      && String(beta.source || '').trim().length > 0
      && isValidSessionDate(normalizeResearchDate(beta.asOf))
      && String(beta.benchmark || '').trim().toUpperCase() === 'SPY'
      && beta.returnBasis === VERIFIED_BETA_RETURN_BASIS
    ) ? beta : null;
    const band = sizingMetric ? calculateBetaBand(sizingMetric) : null;
    const available = Boolean(
      band?.available
      && finiteOptionalNumber(band.minWeight) !== null
      && finiteOptionalNumber(band.betaMaxWeight) !== null
    );
    const value = available
      ? `${Number(band.minWeight).toFixed(1)}–${Number(band.betaMaxWeight).toFixed(1)}%`
      : null;
    const verification = {
      symbol: normalizedSymbol,
      metric: 'Position size',
      formula: `β* = clamp(|β|, ${SIZING_CONSTANTS.MIN_BETA.toFixed(2)}, ${SIZING_CONSTANTS.MAX_BETA.toFixed(2)}); MIN = ${SIZING_CONSTANTS.MIN_WEIGHT_NUMERATOR.toFixed(2)}% ÷ β*; MAX = ${SIZING_CONSTANTS.MAX_WEIGHT_NUMERATOR.toFixed(2)}% ÷ β*`,
      equation: available
        ? `|β| ${Math.abs(Number(band.rawBeta)).toFixed(2)} → β* ${Number(band.effectiveBeta).toFixed(2)}; raw ${Number(band.rawMinWeight).toFixed(2)}%–${Number(band.rawMaxWeight).toFixed(2)}% → rounded ${value}`
        : 'Not calculated — verified completed-session beta provenance is required.',
      result: value || 'Unavailable',
      details: available
        ? [
          `${sizingMetric.observations} aligned completed-session returns`,
          `Beta source: ${sizingMetric.source}`,
          `${SIZING_CONSTANTS.WEIGHT_INCREMENT.toFixed(2)} percentage-point grid`,
          'ATR may reduce MAX',
          'Beta alone does not select a final target',
          `As of ${formatResearchDateLabel(sizingMetric.asOf)}`,
        ]
        : ['No position-size band is shown without verified historical beta inputs.'],
    };

    return {
      available,
      band,
      beta,
      riskMetrics,
      sizingMetric,
      value,
      verification,
    };
  };

  const getControlledOtherExposures = (entry) => normalizeControlledExposureTags(entry?.exposures)
    .filter((exposure) => exposure.type && exposure.type !== 'factor');

  const renderMetricCell = ({
    value,
    meta,
    tone = '',
    title = null,
    className = '',
    spanClassName = 'pcv2-intel-span-2',
    children = null,
    onClick = null,
    buttonLabel = null,
  }) => {
    const accessibleLabel = [
      value === null || value === undefined ? null : String(value),
      meta,
      title,
    ].filter(Boolean).join(' · ');
    return (
      <div
        className={`pcv2-intel-cell ${spanClassName} ${className}`.trim()}
        title={title || meta || undefined}
        aria-label={accessibleLabel || undefined}
      >
        {onClick ? (
          <button
            type="button"
            className="pcv2-intel-metric-button"
            aria-label={buttonLabel || undefined}
            title={buttonLabel || undefined}
            onClick={onClick}
          >
            <span className={`pcv2-intel-value ${tone}`.trim()}>
              {children || value}
            </span>
          </button>
        ) : (
          <div className={`pcv2-intel-value ${tone}`.trim()}>
            {children || value}
          </div>
        )}
      </div>
    );
  };

  const renderCompactReferenceRow = ({
    reference = null,
    productLabel,
    emptyState = null,
    rowKey,
    historical = false,
  }) => {
    const sourceUrl = safeResearchUrl(reference?.sourceUrl || reference?.url);
    const direction = reference?.direction ? String(reference.direction).toUpperCase() : null;
    const rawNote = reference ? researchReferenceText(reference) : emptyState?.note;
    const note = direction ? `${direction} · ${rawNote}` : rawNote;
    const sourceLabel = sourceUrl
      ? 'SOURCE ›'
      : emptyState?.sourceLabel || (reference ? 'INDEXED ✓' : 'UNAVAILABLE');
    return (
      <div
        className={`pcv2-intel-grid pcv2-intel-reference-row ${emptyState?.kind === 'indexed-empty' ? 'is-empty' : ''}`}
        key={rowKey}
      >
        <div className="pcv2-intel-cell pcv2-intel-span-2 pcv2-intel-reference-time">
          {historical
            ? formatResearchDateLabel(getResearchDatumDate(reference || emptyState))
            : formatResearchTime(reference?.publishedAt || emptyState?.publishedAt)}
        </div>
        <div className="pcv2-intel-cell pcv2-intel-span-2 pcv2-intel-reference-product">
          {productLabel}
        </div>
        <div
          className={`pcv2-intel-cell pcv2-intel-span-14 pcv2-intel-reference-note ${emptyState ? 'is-empty' : ''}`}
          title={note || undefined}
        >
          {note}
        </div>
        <div className="pcv2-intel-cell pcv2-intel-span-2 pcv2-intel-reference-source">
          {sourceUrl ? (
            <a href={sourceUrl} target="_blank" rel="noreferrer">
              {sourceLabel}
            </a>
          ) : sourceLabel}
        </div>
      </div>
    );
  };

  const buildRiskRangeStructure = ({
    currentReferences,
    historicalReferences,
    verifiedRiskRange,
    tradeValue,
    trendValue,
  }) => {
    const normalizeDecisionBias = (value) => {
      const normalized = String(value || '').trim().toUpperCase();
      if (['BULLISH', 'BUY', 'LONG', 'POSITIVE'].includes(normalized)) return 'bullish';
      if (['BEARISH', 'SELL', 'SHORT', 'NEGATIVE'].includes(normalized)) return 'bearish';
      return null;
    };
    const tradeBias = normalizeDecisionBias(tradeValue);
    const trendBias = normalizeDecisionBias(trendValue);
    if (!tradeBias || tradeBias !== trendBias) {
      return {
        value: '—',
        meta: 'Trade + Trend not aligned',
        tone: 'is-muted',
      };
    }

    const byDate = new Map();
    [...historicalReferences, ...currentReferences].forEach((reference) => {
      const verifiedHistoricalPrimary = (
        reference.kind === 'historical_risk_range'
        && ['indexed', 'validated'].includes(String(reference.qualityStatus || '').toLowerCase())
      );
      if (
        getResearchProductId(reference) !== 'risk-ranges'
        || !['primary_risk_range', 'historical_risk_range'].includes(reference.kind)
        || (reference.decisionEligible !== true && !verifiedHistoricalPrimary)
      ) return;
      const value = reference.value && typeof reference.value === 'object' ? reference.value : reference;
      const lrr = finiteOptionalNumber(value.lrr ?? value.low);
      const hrr = finiteOptionalNumber(value.hrr ?? value.high);
      const marketDate = getResearchDatumDate(reference);
      if (marketDate && lrr !== null && hrr !== null && lrr <= hrr) {
        byDate.set(marketDate, { marketDate, lrr, hrr });
      }
    });
    if (verifiedRiskRange) {
      const lrr = finiteOptionalNumber(researchValue(verifiedRiskRange, ['lrr', 'low']));
      const hrr = finiteOptionalNumber(researchValue(verifiedRiskRange, ['hrr', 'high']));
      if (lrr !== null && hrr !== null && lrr <= hrr) {
        const rangeDate = getResearchDatumDate(verifiedRiskRange) || researchMarketDate;
        byDate.set(rangeDate, { marketDate: rangeDate, lrr, hrr });
      }
    }

    const ranges = [...byDate.values()].sort((left, right) => (
      left.marketDate.localeCompare(right.marketDate)
    ));
    if (ranges.length < 2) {
      return {
        value: '—',
        meta: 'Need 2 verified primary ranges',
        tone: 'is-muted',
      };
    }

    let highDirection = 0;
    let lowDirection = 0;
    let highScore = 0;
    let lowScore = 0;
    let highEvent = 'EH';
    let lowEvent = 'EL';
    let priorAllTimeHigh = ranges[0].hrr;
    let priorAllTimeLow = ranges[0].lrr;
    let latestAth = false;
    let latestAtl = false;

    for (let index = 1; index < ranges.length; index += 1) {
      const previous = ranges[index - 1];
      const current = ranges[index];
      const nextHighDirection = current.hrr > previous.hrr ? 1 : current.hrr < previous.hrr ? -1 : 0;
      const nextLowDirection = current.lrr > previous.lrr ? 1 : current.lrr < previous.lrr ? -1 : 0;
      latestAth = nextHighDirection > 0 && current.hrr > priorAllTimeHigh;
      latestAtl = nextLowDirection < 0 && current.lrr < priorAllTimeLow;
      const highCredit = nextHighDirection > 0 ? 1 + (latestAth ? 1 : 0) : nextHighDirection < 0 ? -1 : 0;
      const lowCredit = nextLowDirection > 0 ? 1 : nextLowDirection < 0 ? -1 - (latestAtl ? 1 : 0) : 0;
      highScore = nextHighDirection === 0
        ? highScore
        : nextHighDirection === highDirection ? highScore + highCredit : highCredit;
      lowScore = nextLowDirection === 0
        ? lowScore
        : nextLowDirection === lowDirection ? lowScore + lowCredit : lowCredit;
      if (nextHighDirection !== 0) highDirection = nextHighDirection;
      if (nextLowDirection !== 0) lowDirection = nextLowDirection;
      highEvent = nextHighDirection > 0 ? (latestAth ? 'HH + ATH' : 'HH') : nextHighDirection < 0 ? 'LH' : 'EH';
      lowEvent = nextLowDirection > 0 ? 'HL' : nextLowDirection < 0 ? (latestAtl ? 'LL + ATL' : 'LL') : 'EL';
      priorAllTimeHigh = Math.max(priorAllTimeHigh, current.hrr);
      priorAllTimeLow = Math.min(priorAllTimeLow, current.lrr);
    }

    const score = highScore + lowScore;
    const directionConfirmed = tradeBias === 'bullish'
      ? highDirection > 0 && lowDirection > 0
      : highDirection < 0 && lowDirection < 0;
    const recordLabel = latestAth ? ' · ATH' : latestAtl ? ' · ATL' : '';
    return {
      value: `${score > 0 ? '+' : ''}${score}${recordLabel}`,
      meta: `${highEvent} ${highScore > 0 ? '+' : ''}${highScore} · ${lowEvent} ${lowScore > 0 ? '+' : ''}${lowScore} · ${formatResearchDateLabel(ranges.at(-1).marketDate)}`,
      tone: directionConfirmed
        ? tradeBias === 'bullish' ? 'is-positive' : 'is-negative'
        : 'is-muted',
    };
  };

  const renderSecurityResearch = (holding, rowId) => {
    const symbol = String(holding?.symbol || '').trim().toUpperCase();
    const entry = getSymbolResearch(symbol);
    const decision = entry?.decision || entry?.signals || entry?.current?.decision || {};
    const lastVerifiedDecision = entry?.lastVerifiedDecision || {};
    const trade = decision.trade || entry?.trade;
    const trend = decision.trend || entry?.trend;
    const riskRange = decision.riskRange || entry?.riskRange;
    const signalStrength = decision.signalStrength || entry?.signalStrength;
    const supplementalRange = entry?.supplementalRange || entry?.earlyLookRange;

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
    const verifiedTrade = currentVerifiedTrade || historicalVerifiedTrade;
    const verifiedTrend = currentVerifiedTrend || historicalVerifiedTrend;
    const verifiedRiskRange = currentVerifiedRiskRange || historicalVerifiedRiskRange;
    const verifiedSignalStrength = currentVerifiedSignalStrength || historicalVerifiedSignalStrength;
    const tradeIsReference = Boolean(historicalVerifiedTrade || (currentVerifiedTrade && researchEnvelopeIsRetained));
    const trendIsReference = Boolean(historicalVerifiedTrend || (currentVerifiedTrend && researchEnvelopeIsRetained));
    const riskRangeIsReference = Boolean(
      historicalVerifiedRiskRange || (currentVerifiedRiskRange && researchEnvelopeIsRetained)
    );
    const signalIsReference = Boolean(
      historicalVerifiedSignalStrength || (currentVerifiedSignalStrength && researchEnvelopeIsRetained)
    );
    const verifiedSupplementalRange = researchEnvelopeIsCurrent
      && supplementalRange
      && typeof supplementalRange === 'object'
      && getResearchDatumDate(supplementalRange) === researchMarketDate
      && !isUntrustedResearchDatum(supplementalRange)
      && getResearchStatus(supplementalRange) === 'available'
      && supplementalRange.decisionEligible === false
      ? supplementalRange
      : null;

    const currentReferences = getCurrentReferences(entry);
    const historicalReferences = getHistoricalReferences(entry);
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

    const tradeValue = researchValue(verifiedTrade, ['value', 'signal', 'trade']);
    const trendValue = researchValue(verifiedTrend, ['value', 'trend', 'signal']);
    const signalValue = researchValue(verifiedSignalStrength, ['value', 'action', 'change', 'state']);
    const quadRanking = getQuadExpectedValueRanking(symbol);
    const riskRangeStructure = buildRiskRangeStructure({
      currentReferences,
      historicalReferences,
      verifiedRiskRange,
      tradeValue,
      trendValue,
    });

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
      ? averageCost + (quantity < 0 ? 1 : -1) * 2 * Number(atr14.value)
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
    const betaVerification = {
      symbol,
      metric: 'Beta',
      formula: `Beta = covariance of ${symbol} and ${beta?.benchmark || 'SPY'} returns ÷ variance of ${beta?.benchmark || 'SPY'} returns`,
      equation: beta
        ? betaCovariance !== null && betaBenchmarkVariance !== null
          ? `${formatVerificationDecimal(betaCovariance)} ÷ ${formatVerificationDecimal(betaBenchmarkVariance)} = ${Number(beta.value).toFixed(2)}`
          : `${beta.observations || beta.windowSessions || 252} aligned daily returns = ${Number(beta.value).toFixed(2)}`
        : 'Not calculated — verified aligned return history is unavailable.',
      result: beta ? Number(beta.value).toFixed(2) : 'Unavailable',
      details: beta
        ? [
          `${beta.observations || beta.windowSessions || 252} aligned daily returns`,
          'Completed adjusted closes',
          `As of ${formatResearchDateLabel(beta.asOf)}`,
        ]
        : ['Historical beta inputs are unavailable.'],
    };
    const stopOperator = quantity !== null && quantity < 0 ? '+' : '−';
    const stopVerification = {
      symbol,
      metric: 'Stop loss',
      formula: quantity !== null && quantity < 0
        ? 'Stop = average cost + (2 × ATR14)'
        : 'Stop = average cost − (2 × ATR14)',
      equation: stopReference !== null
        ? `${formatVerificationCurrency(averageCost)} ${stopOperator} (2 × ${formatVerificationCurrency(atr14?.value)}) = ${formatVerificationCurrency(stopReference)}`
        : 'Not calculated — verified IBKR average cost and ATR14 are required.',
      result: stopReference !== null ? formatVerificationCurrency(stopReference) : 'Unavailable',
      details: stopReference !== null
        ? [
          `${quantity < 0 ? 'Short' : 'Long'} position`,
          'Verified IBKR average cost',
          `ATR14 through ${formatResearchDateLabel(atr14?.asOf)}`,
        ]
        : ['No executable stop is created; this is a reference check only.'],
    };

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
      return value !== null && (current || historicalClose)
        ? { definition, row, value, historicalClose }
        : null;
    }).filter(Boolean);
    const volatilityValue = volatilityIndexes.length === 0
      ? 'N/A'
      : validVolatilityRows.length === 0
        ? marketContextState.status === 'loading' ? '…' : 'Unavailable'
        : validVolatilityRows
          .map(({ definition, value }) => `${definition.label} ${Number(value).toFixed(2)}`)
          .join(' · ');
    const volatilityMeta = volatilityIndexes.length === 0
      ? 'No controlled vol-index mapping'
      : validVolatilityRows.length === 0
        ? 'Mapped source unavailable'
        : [
          validVolatilityRows.map(({ definition }) => definition.symbol).join(' / '),
          validVolatilityRows.some(({ historicalClose }) => historicalClose)
            ? `Close · ${formatResearchDateLabel(validVolatilityRows[0].row?.asOf)}`
            : formatContextTimestamp(validVolatilityRows[0].row?.asOf || validVolatilityRows[0].row?.timestamp),
        ].join(' · ');

    const usdProxy = USD_CORRELATION_PROXY_BY_SYMBOL[symbol] || null;
    const usdPayload = marketContextState.usdCorrelations;
    const usdRow = usdProxy && usdPayload?.sourceStatus === 'current'
      ? usdPayload?.correlations?.[usdProxy]
      : null;
    const usdCorrelation = finiteOptionalNumber(usdRow?.['30D'] ?? usdRow?.['1M']);
    const usdValue = !usdProxy
      ? 'N/A'
      : usdCorrelation === null
        ? marketContextState.status === 'loading' ? '…' : 'Unavailable'
        : `${usdCorrelation > 0 ? '+' : ''}${usdCorrelation.toFixed(2)}`;
    const usdMeta = !usdProxy
      ? 'No direct USD proxy'
      : usdCorrelation === null
        ? `DXY vs ${usdProxy} unavailable`
        : `DXY vs ${usdProxy} · 30D · ${formatResearchDateLabel(usdPayload.calculationDate)}`;

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

    const apiResearchProducts = asArray(researchPayload?.products);
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
        current: buildResearchProductRows({
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
    const historicalProductRows = cachedProductRows.historical;

    const researchProductExpansionKey = (row) => `${rowId}:${row.productId}`;
    const renderResearchProductContext = (row) => {
      const sourceUrl = safeResearchUrl(row.reference?.sourceUrl || row.reference?.url);
      const sourceTime = formatResearchTime(row.publishedAt);
      const sourceMeta = [
        row.productLabel,
        formatResearchSourceDate(row.marketDate),
        sourceTime === '—' ? null : `${sourceTime} ET`,
      ].filter(Boolean).join(' · ');
      return (
        <div
          className="pcv2-intel-grid pcv2-intel-reference-context"
          id={`research-product-context-${rowId}-${row.productId}`}
          role="region"
          aria-label={`${row.productLabel} facts for ${symbol}`}
          data-testid={`research-product-context-${rowId}-${row.productId}`}
        >
          <div className="pcv2-intel-cell pcv2-intel-span-20">
            <div
              className="pcv2-intel-reference-facts"
              role="list"
              aria-label={`${row.productLabel} fact list for ${symbol}`}
            >
              {row.factLines.map((fact, index) => (
                <p
                  className="pcv2-intel-reference-fact"
                  role="listitem"
                  key={`${row.productId}-fact-${index}`}
                >
                  {fact}
                </p>
              ))}
            </div>
            <div className="pcv2-intel-reference-context-source">
              <span>Source: {sourceMeta}</span>
              {sourceUrl ? (
                <a href={sourceUrl} target="_blank" rel="noreferrer">
                  OPEN SOURCE ↗
                </a>
              ) : (
                <span aria-disabled="true">SOURCE UNAVAILABLE</span>
              )}
            </div>
          </div>
        </div>
      );
    };

    const renderCurrentResearchProductRow = (row) => {
      const expansionKey = researchProductExpansionKey(row);
      const isExpanded = expandedResearchProducts.has(expansionKey);
      const detail = row.state === 'available'
        ? `${row.factLines.length} ${row.factLines.length === 1 ? 'fact' : 'facts'} for ${symbol}`
        : row.state === 'unavailable' ? 'UNAVAILABLE' : 'N/A';
      const statusLabel = row.state === 'available'
        ? `Verified ${row.productLabel} evidence for ${symbol}`
        : row.state === 'unavailable'
          ? `${row.productLabel} evidence is unavailable for ${symbol}`
          : `${row.productLabel} has no verified mention for ${symbol}`;
      return (
        <React.Fragment key={`${rowId}-current-${row.key}`}>
          <div
            className={`pcv2-intel-grid pcv2-intel-reference-row ${isExpanded ? 'is-expanded' : ''} ${row.state !== 'available' ? 'is-empty' : ''} ${row.state === 'unavailable' ? 'is-unavailable' : ''}`}
            data-product-id={row.productId}
            data-testid={`research-product-row-${rowId}-${row.productId}`}
          >
            <div className="pcv2-intel-cell pcv2-intel-span-2 pcv2-intel-reference-time">
              {formatResearchTime(row.publishedAt)}
            </div>
            <div className="pcv2-intel-cell pcv2-intel-span-2 pcv2-intel-reference-product">
              {row.productLabel}
            </div>
            <div
              className={`pcv2-intel-cell pcv2-intel-span-14 pcv2-intel-reference-note ${row.state !== 'available' ? 'is-empty' : ''}`}
              title={detail}
            >
              {detail}
            </div>
            <div className="pcv2-intel-cell pcv2-intel-span-2 pcv2-intel-reference-source">
              {row.state === 'available' ? (
                <button
                  type="button"
                  className="pcv2-intel-reference-toggle"
                  aria-expanded={isExpanded}
                  aria-controls={`research-product-context-${rowId}-${row.productId}`}
                  aria-label={`${isExpanded ? 'Collapse' : 'View'} ${row.productLabel} context for ${symbol}`}
                  onClick={() => {
                    setExpandedResearchProducts((current) => {
                      const next = new Set(current);
                      if (next.has(expansionKey)) next.delete(expansionKey);
                      else next.add(expansionKey);
                      return next;
                    });
                  }}
                >
                  {isExpanded ? 'HIDE ↑' : 'VIEW ›'}
                </button>
              ) : (
                <span
                  className="pcv2-intel-reference-source-disabled"
                  aria-disabled="true"
                  title={statusLabel}
                >
                  VIEW ›
                </span>
              )}
            </div>
          </div>
          {isExpanded && row.state === 'available' && renderResearchProductContext(row)}
        </React.Fragment>
      );
    };

    return (
      <div
        className="pcv2-intel-panel"
        id={`portfolio-research-${rowId}`}
        aria-label={`Research intelligence for ${symbol}`}
      >
        <div className="pcv2-intel-grid pcv2-intel-header" aria-label="Decision intelligence headers">
          {[
            'Trade',
            'Trend',
            'Beta',
            'Factor Ctrb',
            'Quad +EV',
          ].map((label) => (
            <div className="pcv2-intel-cell pcv2-intel-span-4" key={label}>{label}</div>
          ))}
        </div>

        <div className="pcv2-intel-grid pcv2-intel-values" aria-label={`${symbol} decision intelligence`}>
          {renderMetricCell({
            value: tradeValue || '—',
            meta: decisionSourceMeta(verifiedTrade, tradeIsReference, unavailableDecisionMeta),
            tone: metricToneForValue(tradeValue),
            className: tradeIsReference ? 'is-reference' : '',
            spanClassName: 'pcv2-intel-span-4',
          })}
          {renderMetricCell({
            value: trendValue || '—',
            meta: decisionSourceMeta(verifiedTrend, trendIsReference, unavailableDecisionMeta),
            tone: metricToneForValue(trendValue),
            className: trendIsReference ? 'is-reference' : '',
            spanClassName: 'pcv2-intel-span-4',
          })}
          {renderMetricCell({
            value: beta ? Number(beta.value).toFixed(2) : marketContextState.status === 'loading' ? '…' : '—',
            meta: beta
              ? `${beta.windowSessions || 252}D vs ${beta.benchmark || 'SPY'} · ${formatResearchDateLabel(beta.asOf)}`
              : 'Historical beta unavailable',
            tone: beta ? betaToneForValue(beta.value) : 'is-muted',
            className: beta ? 'is-reference' : '',
            spanClassName: 'pcv2-intel-span-4',
            onClick: () => setMetricVerification(betaVerification),
            buttonLabel: `Verify ${symbol} beta calculation`,
          })}
          {renderMetricCell({
            value: factorContribution === null
              ? '—'
              : formatPct(quantity < 0 ? -factorContribution : factorContribution, 1, { signed: true }),
            meta: factorContribution === null
              ? 'Verified live NAV contribution unavailable'
              : `${getQuadExposureLabels(holding).join(' · ') || 'Unclassified'} · signed % NAV`,
            title: 'Current signed position contribution across the displayed +EV exposures.',
            tone: factorContribution === null
              ? 'is-muted'
              : quantity < 0 ? 'is-negative' : 'is-positive',
            spanClassName: 'pcv2-intel-span-4',
          })}
          {renderMetricCell({
            meta: quadRanking ? `${quadRanking.label} · best → worst` : 'No direct +EV row',
            value: quadRanking ? null : '—',
            spanClassName: 'pcv2-intel-span-4',
            children: quadRanking ? (
              <span className="pcv2-intel-quad-order" aria-label={`Quad order ${quadRanking.order.join(', ')}`}>
                {quadRanking.order.map((quad, index) => (
                  <React.Fragment key={quad}>
                    <span className={`pcv2-intel-quad is-q${quad}`}>{quad}</span>
                    {index < quadRanking.order.length - 1 && <span className="pcv2-intel-quad-arrow">›</span>}
                  </React.Fragment>
                ))}
              </span>
            ) : null,
          })}
        </div>

        <div
          className="pcv2-intel-grid pcv2-intel-header"
          aria-label="Decision intelligence secondary headers"
        >
          {[
            'Primary range',
            'Signal strength',
            'RR structure',
            'Other exposure',
            'Coverage',
          ].map((label) => (
            <div className="pcv2-intel-cell pcv2-intel-span-4" key={label}>{label}</div>
          ))}
        </div>

        <div
          className="pcv2-intel-grid pcv2-intel-values"
          aria-label={`${symbol} supplemental decision intelligence`}
        >
          {renderMetricCell({
            value: verifiedRiskRange
              ? `${formatResearchNumber(researchValue(verifiedRiskRange, ['lrr', 'low']))}–${formatResearchNumber(researchValue(verifiedRiskRange, ['hrr', 'high']))}`
              : '—',
            meta: verifiedRiskRange
              ? decisionSourceMeta(verifiedRiskRange, riskRangeIsReference, unavailableDecisionMeta)
              : unavailableDecisionMeta,
            className: riskRangeIsReference ? 'is-reference' : '',
            spanClassName: 'pcv2-intel-span-4',
          })}
          {renderMetricCell({
            value: signalValue || '—',
            meta: decisionSourceMeta(
              verifiedSignalStrength,
              signalIsReference,
              unavailableDecisionMeta,
            ),
            tone: metricToneForValue(signalValue),
            className: signalIsReference ? 'is-reference' : '',
            spanClassName: 'pcv2-intel-span-4',
          })}
          {renderMetricCell({
            ...riskRangeStructure,
            spanClassName: 'pcv2-intel-span-4',
          })}
          {renderMetricCell({
            value: otherExposures.length > 0
              ? otherExposures.map((exposure) => exposure.label).join(' · ')
              : '—',
            meta: otherExposures.length > 0
              ? `${[...new Set(otherExposures.map((exposure) => exposureTypeLabel(exposure.type)))].join(' / ')} · controlled`
              : 'No controlled mapping',
            title: otherExposures.map((exposure) => (
              `${exposureTypeLabel(exposure.type)} · ${exposure.label}`
            )).join(' · '),
            spanClassName: 'pcv2-intel-span-4',
          })}
          {renderMetricCell({
            value: coverageValue,
            meta: coverageMeta,
            tone: metricToneForValue(coverageValue),
            title: coverageReasons.join(' · ') || coverageMeta,
            spanClassName: 'pcv2-intel-span-4',
          })}
        </div>

        <div className="pcv2-intel-grid pcv2-intel-header" aria-label="Market context headers">
          {[
            'Price Z-score · 20D',
            'Sizing vol',
            'Relevant vol index',
            'USD correlation',
            'Stop loss',
          ].map((label) => (
            <div className="pcv2-intel-cell pcv2-intel-span-4" key={label}>{label}</div>
          ))}
        </div>

        <div className="pcv2-intel-grid pcv2-intel-values pcv2-intel-context" aria-label={`${symbol} market context`}>
          {renderMetricCell({
            value: zScore20
              ? `${Number(zScore20.value) > 0 ? '+' : ''}${Number(zScore20.value).toFixed(2)}`
              : marketContextState.status === 'loading' ? '…' : 'Unavailable',
            meta: zScore20
              ? `Completed close · ${formatResearchDateLabel(zScore20.asOf)}`
              : 'Verified completed-close series unavailable',
            tone: zScore20 ? zScoreToneForValue(zScore20.value) : 'is-muted',
            className: zScore20 ? 'is-reference' : '',
            spanClassName: 'pcv2-intel-span-4',
          })}
          {(() => {
            const rv = riskMetrics?.realizedVolatility;
            const sizingVol = rv?.status === 'available'
              ? resolveSizingVolatility(rv, { useRecent63: true })
              : null;
            const sizingVolPct = Number.isFinite(sizingVol) ? sizingVol * 100 : null;
            const badges = [];
            if (rv?.limitedHistory) badges.push('Limited history');
            if (rv?.spikeWarning) badges.push('Spike');
            const badgeText = badges.length > 0 ? ` · ${badges.join(' · ')}` : '';
            return renderMetricCell({
              value: sizingVolPct != null
                ? `${sizingVolPct.toFixed(1)}%`
                : marketContextState.status === 'loading' ? '…' : 'Unavailable',
              meta: sizingVolPct != null
                ? `max(63d, 1Y) realized · ${formatResearchDateLabel(rv?.asOf)}${badgeText}`
                : (rv?.warnings?.[0] || 'Insufficient adjusted history for sizing vol'),
              title: 'Sizing uses the higher of 3-month and 1-year annualized realized volatility. Reference only — not options IV.',
              tone: sizingVolPct != null ? 'is-muted' : 'is-muted',
              className: sizingVolPct != null ? 'is-reference' : '',
              spanClassName: 'pcv2-intel-span-4',
              children: sizingVolPct != null ? (
                <span className="pcv2-sizing-vol-value">
                  {`${sizingVolPct.toFixed(1)}%`}
                  {badges.length > 0 && (
                    <span className={`pcv2-vol-badge ${rv?.spikeWarning ? 'is-spike' : 'is-limited'}`}>
                      {rv?.spikeWarning ? 'Spike' : 'Limited'}
                    </span>
                  )}
                </span>
              ) : null,
              onClick: sizingVolPct != null
                ? () => setMetricVerification({
                  symbol,
                  metric: 'Sizing volatility',
                  formula: 'SizingVol = max(RV₆₃, RV₂₅₂); RV = stdev(ln returns) × √N',
                  equation: [
                    `RV₆₃ = ${Number.isFinite(rv?.rv63) ? `${(rv.rv63 * 100).toFixed(2)}%` : 'n/a'}`,
                    `RV₂₅₂ = ${Number.isFinite(rv?.rv252) ? `${(rv.rv252 * 100).toFixed(2)}%` : 'n/a'}`,
                    `SizingVol = ${sizingVolPct.toFixed(2)}%`,
                    `N = ${rv?.annualizationFactor || 252}`,
                    `Observations = ${rv?.observationCount || 0}`,
                  ].join(' · '),
                  result: `${sizingVolPct.toFixed(2)}% annualized`,
                  details: [
                    ...(rv?.warnings || []),
                    'Uses Yahoo adjusted closes only.',
                    'Leveraged/inverse ETFs use their own price history.',
                    'Reference-only / non-executable.',
                  ],
                })
                : null,
              buttonLabel: sizingVolPct != null
                ? `Verify ${symbol} sizing volatility`
                : null,
            });
          })()}
          {renderMetricCell({
            value: volatilityValue,
            meta: volatilityMeta,
            tone: volatilityValue === 'Unavailable' ? 'is-muted' : '',
            spanClassName: 'pcv2-intel-span-4',
          })}
          {renderMetricCell({
            value: usdValue,
            meta: usdMeta,
            tone: usdCorrelation !== null && usdCorrelation > 0
              ? 'is-positive'
              : usdCorrelation !== null && usdCorrelation < 0 ? 'is-negative' : 'is-muted',
            spanClassName: 'pcv2-intel-span-4',
          })}
          {renderMetricCell({
            value: stopReference === null ? '—' : stopReference.toFixed(2),
            meta: stopReference === null
              ? atr14 ? 'Verified IBKR average cost required' : 'ATR14 reference unavailable'
              : `IBKR basis · 2×ATR14 · ${formatResearchDateLabel(atr14.asOf)} · reference only`,
            title: stopReference === null
              ? 'A stop reference requires verified IBKR average cost and historical ATR14.'
              : 'Non-executable reference: IBKR average cost adjusted by two historical ATR14 values.',
            tone: stopReference === null ? 'is-muted' : stopTone,
            className: stopReference === null ? '' : 'is-reference',
            spanClassName: 'pcv2-intel-span-4',
            onClick: () => setMetricVerification(stopVerification),
            buttonLabel: `Verify ${symbol} stop loss calculation`,
          })}
        </div>

        <div className="pcv2-intel-grid pcv2-intel-header pcv2-intel-reference-header" aria-label={`${symbol} research product references`}>
          <div className="pcv2-intel-cell pcv2-intel-span-2">TIME</div>
          <div className="pcv2-intel-cell pcv2-intel-span-2">PRODUCT</div>
          <div className="pcv2-intel-cell pcv2-intel-span-14">DETAIL</div>
          <div className="pcv2-intel-cell pcv2-intel-span-2">SOURCE</div>
        </div>
        {currentProductRows.map((row) => renderCurrentResearchProductRow(row))}

        <details className="pcv2-intel-history">
          <summary>Previous {RESEARCH_HISTORY_DAYS} market days ({historicalProductRows.length} product rows)</summary>
          <div className="pcv2-intel-history-body">
            {historicalProductRows.length > 0
              ? historicalProductRows.map((row) => renderCompactReferenceRow({
                reference: row.reference,
                productLabel: row.productLabel,
                rowKey: `${rowId}-history-${row.key}`,
                historical: true,
              }))
              : (
                <div className="pcv2-intel-grid pcv2-intel-reference-row is-empty">
                  <div className="pcv2-intel-cell pcv2-intel-span-20 pcv2-intel-history-empty">
                    No verified historical references returned.
                  </div>
                </div>
              )}
          </div>
        </details>
      </div>
    );
  };

  const renderMetricVerification = () => {
    if (!active || !metricVerification) return null;
    return createPortal(
      <div
        className="pcv2-verification-backdrop"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) setMetricVerification(null);
        }}
      >
        <section
          className="pcv2-verification-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="pcv2-verification-title"
        >
          <header className="pcv2-verification-header">
            <div>
              <span>{metricVerification.symbol}</span>
              <h2 id="pcv2-verification-title">{metricVerification.metric} calculation</h2>
            </div>
            <button
              type="button"
              aria-label="Close calculation"
              title="Close"
              onClick={() => setMetricVerification(null)}
              autoFocus
            >
              <X size={15} aria-hidden="true" />
            </button>
          </header>
          <div className="pcv2-verification-formula">{metricVerification.formula}</div>
          <div className="pcv2-verification-equation">{metricVerification.equation}</div>
          <dl className="pcv2-verification-result">
            <dt>Result</dt>
            <dd>{metricVerification.result}</dd>
          </dl>
          <div className="pcv2-verification-details">
            {metricVerification.details.map((detail) => <span key={detail}>{detail}</span>)}
          </div>
          <footer>Verification only · historical/reference data · not executable</footer>
        </section>
      </div>,
      document.body
    );
  };

  const renderTargetControl = (holding, isLongs, pctOfAccount) => {
    if (!canUseHoldingForSizing(holding)) {
      return (
        <span
          aria-label={`Target weight unavailable for ${holding?.symbol || 'position'}; verified live mark and NAV required`}
          title="Sizing is disabled until IBKR supplies a verified live mark and live NAV"
        >
          —
        </span>
      );
    }
    const percentPortfolioState = isLongs ? longsPercentPortfolio : shortsPercentPortfolio;
    const setPercentPortfolioState = isLongs ? setLongsPercentPortfolio : setShortsPercentPortfolio;
    const setBasisPointsState = isLongs ? setLongsBasisPoints : setShortsBasisPoints;
    const targetPercent = percentPortfolioState[holding.symbol];
    const displayPercent = targetPercent !== undefined ? Number(targetPercent) : (isLongs ? Number(pctOfAccount) : -Number(pctOfAccount));
    const editingKey = `${isLongs ? 'long' : 'short'}_${holding.symbol}`;
    const isEditing = editingPercentPortfolio[editingKey] !== undefined;

    const commitValue = (value) => {
      if (value === '') {
        setPercentPortfolioState(prev => {
          const next = { ...prev };
          delete next[holding.symbol];
          return next;
        });
        setBasisPointsState(prev => {
          const next = { ...prev };
          delete next[holding.symbol];
          return next;
        });
        return;
      }

      const parsed = Number(value);
      if (!Number.isNaN(parsed)) {
        setPercentPortfolioState(prev => ({ ...prev, [holding.symbol]: Math.round(parsed * 100) / 100 }));
        setBasisPointsState(prev => {
          const next = { ...prev };
          delete next[holding.symbol];
          return next;
        });
      }
    };

    const bump = (direction) => {
      const current = Number(isEditing ? editingPercentPortfolio[editingKey] : displayPercent) || 0;
      const next = Math.round((current + direction * 0.01) * 100) / 100;
      setPercentPortfolioState(prev => ({ ...prev, [holding.symbol]: next }));
      if (isEditing) {
        setEditingPercentPortfolio(prev => ({ ...prev, [editingKey]: next.toFixed(2) }));
      }
    };

    return (
      <div className="pcv2-target-control">
        <input
          type="text"
          inputMode="decimal"
          aria-label={`Target weight for ${holding.symbol}, percent of NAV`}
          value={isEditing ? editingPercentPortfolio[editingKey] : displayPercent.toFixed(2)}
          onFocus={(e) => {
            setEditingPercentPortfolio(prev => ({ ...prev, [editingKey]: displayPercent.toFixed(2) }));
            e.target.select();
          }}
          onChange={(e) => {
            if (e.target.value === '' || e.target.value === '-' || /^-?\d*\.?\d*$/.test(e.target.value)) {
              setEditingPercentPortfolio(prev => ({ ...prev, [editingKey]: e.target.value }));
            }
          }}
          onBlur={(e) => {
            commitValue(e.target.value);
            setEditingPercentPortfolio(prev => {
              const next = { ...prev };
              delete next[editingKey];
              return next;
            });
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') {
              setEditingPercentPortfolio(prev => {
                const next = { ...prev };
                delete next[editingKey];
                return next;
              });
              e.currentTarget.blur();
            }
            if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
              e.preventDefault();
              bump(e.key === 'ArrowUp' ? 1 : -1);
            }
          }}
        />
        <span aria-hidden="true">▲<br />▼</span>
      </div>
    );
  };

  const renderLedgerRows = (rows, isLongs) => {
    if (rows.length === 0) {
      return (
        <tr>
          <td colSpan={10} className="pcv2-empty">
            No {isLongs ? 'long' : 'short'} positions
          </td>
        </tr>
      );
    }

    return rows.map((holding, index) => {
      const pctOfAccount = getPortfolioWeight(holding, totalValue);
      const assetClass = getAssetClassAbbreviation(holding);
      const shares = getResizeShares(holding, isLongs);
      const action = getActionForResize(shares, isLongs, holding);
      const mark = getVerifiedHoldingMark(holding, hasVerifiedPortfolioMarks);
      const dayGainLossPercent = getDayGainLossPercent(holding);
      const positionSizeReference = getPositionSizeReference(holding.symbol);
      const factorLabels = getQuadExposureLabels(holding);
      const factorExposureText = factorLabels.length > 0 ? factorLabels.join(' · ') : 'Unclassified';
      const compactActionLabel = action.label === 'Reference only'
        ? 'Ref only'
        : action.label === 'Unavailable'
          ? 'No live'
          : String(action.label || '—').split(/\s+/)[0];
      const rowId = holdingRowIds.get(holding)
        || `${isLongs ? 'long' : 'short'}-${holding.symbol || 'unknown'}-${index}`;
      const isExpanded = expandedResearchRows.has(rowId);

      return (
        <React.Fragment key={rowId}>
          <tr className={`pcv2-ledger-row ${isExpanded ? 'is-expanded' : ''}`} data-row-id={rowId}>
            <td className="pcv2-ticker">
              <button
                type="button"
                className="pcv2-research-toggle"
                aria-expanded={isExpanded}
                aria-controls={`portfolio-research-${rowId}`}
                aria-label={`${isExpanded ? 'Hide' : 'Show'} research intelligence for ${holding.symbol}`}
                onClick={() => {
                  setExpandedResearchRows((current) => {
                    const next = new Set(current);
                    if (next.has(rowId)) next.delete(rowId);
                    else next.add(rowId);
                    return next;
                  });
                }}
              >
                <svg
                  className="pcv2-research-toggle__icon"
                  viewBox="0 0 16 16"
                  aria-hidden="true"
                >
                  <path
                    d="M3 8h10"
                    fill="none"
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeWidth="1.7"
                  />
                  {!isExpanded && (
                    <path
                      d="M8 3v10"
                      fill="none"
                      stroke="currentColor"
                      strokeLinecap="round"
                      strokeWidth="1.7"
                    />
                  )}
                </svg>
              </button>
              <span title={holdingSourceTitle(holding) || undefined}>
                {holding.symbol}
                {renderHoldingWarningIcon(holding)}
              </span>
            </td>
            <td className="pcv2-num">{assetClass}</td>
            <td className="pcv2-num">
              {pctOfAccount === null ? '—' : formatPct(isLongs ? pctOfAccount : -pctOfAccount, 2)}
            </td>
            <td className="pcv2-num pcv2-ledger-size-reference">
              <button
                type="button"
                aria-label={`Verify ${holding.symbol} position size calculation`}
                title={positionSizeReference.available
                  ? 'Historical beta position-size reference band; not a target or executable sizing instruction.'
                  : 'A size reference requires verified completed-session beta provenance.'}
                onClick={() => setMetricVerification(positionSizeReference.verification)}
              >
                {positionSizeReference.value
                  || (marketContextState.status === 'loading' ? '…' : '—')}
              </button>
            </td>
            <td className="pcv2-num">{renderTargetControl(holding, isLongs, pctOfAccount)}</td>
            <td className="pcv2-factor-exposures" title={factorLabels.join(' · ') || 'Needs +EV classification review'}>
              {factorExposureText}
            </td>
            <td className="pcv2-num">
              {shares === null ? '—' : shares ? (shares > 0 ? `+${shares}` : shares) : '0'}
            </td>
            <td
              className="pcv2-num pcv2-price-value"
              aria-label={mark?.ariaLabel || 'Price unavailable'}
              title={mark?.title || 'Verified live price or completed-session close unavailable'}
            >
              {mark === null ? '—' : formatPrice(mark.value)}
            </td>
            <td
              className={`pcv2-num ${dayGainLossPercent > 0 ? 'pcv2-positive' : dayGainLossPercent < 0 ? 'pcv2-negative' : ''}`}
              aria-label={dayGainLossPercent === null
                ? 'Day gain/loss percentage unavailable'
                : `Day gain/loss ${formatPct(dayGainLossPercent, 2, { signed: true })}`}
              title={dayGainLossPercent === null
                ? 'Verified day gain/loss percentage unavailable'
                : `Verified session change: ${formatPct(dayGainLossPercent, 2, { signed: true })}`}
            >
              {dayGainLossPercent === null
                ? '—'
                : formatPct(dayGainLossPercent, 2, { signed: true })}
            </td>
            <td
              className={`pcv2-action-cell ${action.tone === 'trim' ? 'pcv2-negative' : action.tone === 'add' ? 'pcv2-positive' : ''}`}
              aria-label={action.label}
              title={action.label}
            >
              {compactActionLabel}
            </td>
          </tr>
          {isExpanded && (
            <tr className="pcv2-research-row">
              <td colSpan={10}>{renderSecurityResearch(holding, rowId)}</td>
            </tr>
          )}
        </React.Fragment>
      );
    });
  };

  const renderLedgerTableHead = () => (
    <thead>
      <tr>
        <th title="Ticker">Ticker</th>
        <th className="pcv2-num" aria-label="Asset class" title="Asset class">Asset<br />Class</th>
        <th className="pcv2-num" aria-label="Weight % (NAV)" title="Weight % of NAV">Weight<br />% NAV</th>
        <th className="pcv2-num" aria-label="Position size" title="Historical beta position-size reference band; not a target">Size</th>
        <th className="pcv2-num" aria-label="Target % (NAV)" title="Target % of NAV">Target<br />% NAV</th>
        <th aria-label="Factor exposures" title="Reviewed +EV exposure labels">Factors</th>
        <th className="pcv2-num" aria-label="Resize (Shares)" title="Resize in shares">Resize<br />Sh</th>
        <th className="pcv2-num" aria-label="Price" title="Verified live price or latest completed-session close">Price</th>
        <th className="pcv2-num" aria-label="Day G/L (%)" title="Day gain/loss percentage">Day G/L<br />%</th>
        <th aria-label="Action" title="Action">Action</th>
      </tr>
    </thead>
  );

  const renderLedgerPane = ({ label, rows, isLongs }) => {
    return (
      <div className={`pcv2-ledger-pane ${isLongs ? 'pcv2-ledger-pane--long' : 'pcv2-ledger-pane--short'}`}>
        <div className="pcv2-ledger-pane-head">
          <span>{label} ({rows.length})</span>
        </div>
        <div
          className="pcv2-ledger-pane-scroll"
          data-layout="fit-columns"
        >
          <table className="pcv2-ledger-table" data-column-count="10">
            <colgroup>
              <col style={{ width: '17%' }} />
              <col style={{ width: '7%' }} />
              <col style={{ width: '9%' }} />
              <col style={{ width: '11%' }} />
              <col style={{ width: '10%' }} />
              <col style={{ width: '10%' }} />
              <col style={{ width: '8%' }} />
              <col style={{ width: '10%' }} />
              <col style={{ width: '10%' }} />
              <col style={{ width: '8%' }} />
            </colgroup>
            {renderLedgerTableHead()}
            <tbody>
              {renderLedgerRows(rows, isLongs)}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  const renderFactorExposureBalance = () => {
    const maxSidePct = Math.max(
      1,
      ...factorExposure.rows.flatMap(({ longPct, shortPct }) => [longPct, shortPct]),
    );
    const activeTab = FACTOR_EXPOSURE_TABS.find(({ id }) => id === factorExposureDimension);
    const selectedFactor = factorExposureAvailable ? selectedFactorExposureId : null;

    return (
      <section className="pcv2-card pcv2-factor-balance" aria-label="Factor exposure balance">
        <header className="pcv2-factor-balance__header">
          <div>
            <h3>Factor Exposure</h3>
            <p>Combined gross long and short exposure · % NAV</p>
          </div>
          {selectedFactor ? (
            <button
              type="button"
              className="pcv2-factor-balance__clear"
              onClick={() => setSelectedFactorExposureId(null)}
            >
              Clear factor filter
            </button>
          ) : null}
        </header>
        <div className="pcv2-factor-balance__tabs" role="tablist" aria-label="Factor exposure category">
          {FACTOR_EXPOSURE_TABS.map(({ id, label }) => (
            <button
              type="button"
              role="tab"
              key={id}
              aria-selected={factorExposureDimension === id}
              className={factorExposureDimension === id ? 'is-active' : ''}
              onClick={() => {
                setFactorExposureDimension(id);
                setSelectedFactorExposureId(null);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        {!factorExposureAvailable ? (
          <div className="pcv2-factor-balance__state">
            Factor exposure unavailable — verified IBKR live NAV and marks are required.
          </div>
        ) : factorExposure.rows.length === 0 ? (
          <div className="pcv2-factor-balance__state">
            No reviewed {activeTab?.label.toLowerCase() || 'factor'} exposures in the current portfolio.
          </div>
        ) : (
          <>
            <div className="pcv2-factor-balance__legend" aria-hidden="true">
              <span className="is-short">← Short</span>
              <span>Gross exposure</span>
              <span className="is-long">Long →</span>
            </div>
            <div className="pcv2-factor-balance__rows" role="list">
              {factorExposure.rows.map(({ id, label, longPct, shortPct, netPct }) => {
                const shortWidth = (shortPct / maxSidePct) * 50;
                const longWidth = (longPct / maxSidePct) * 50;
                const selected = selectedFactor === id;
                return (
                  <div key={id} role="listitem">
                    <button
                      type="button"
                      className={`pcv2-factor-balance__row${selected ? ' is-selected' : ''}`}
                      aria-pressed={selected}
                      aria-label={`${selected ? 'Clear' : 'Filter by'} ${label}; ${shortPct.toFixed(1)}% short, ${longPct.toFixed(1)}% long, ${formatPct(netPct, 1, { signed: true })} net`}
                      onClick={() => setSelectedFactorExposureId((current) => (
                        current === id ? null : id
                      ))}
                    >
                      <span className="pcv2-factor-balance__label">{label}</span>
                      <span className="pcv2-factor-balance__bar" aria-hidden="true">
                        <span className="pcv2-factor-balance__short" style={{ width: `${shortWidth}%` }} />
                        <span className="pcv2-factor-balance__zero" />
                        <span className="pcv2-factor-balance__long" style={{ width: `${longWidth}%` }} />
                      </span>
                      <span className={`pcv2-factor-balance__net${netPct > 0 ? ' is-long' : netPct < 0 ? ' is-short' : ''}`}>
                        {formatPct(netPct, 1, { signed: true })}
                      </span>
                    </button>
                  </div>
                );
              })}
            </div>
            <footer className="pcv2-factor-balance__coverage">
              Reviewed classification: {formatPct(factorExposure.coverage.classifiedPct, 1)} gross NAV
              {' · '}
              Unclassified: {formatPct(factorExposure.coverage.unclassifiedPct, 1)} gross NAV
            </footer>
          </>
        )}
      </section>
    );
  };

  const renderUnifiedLedger = () => (
    <section className="pcv2-card pcv2-ledger-card">
      <div className="pcv2-ledger-toolbar">
        {portfolioAvailabilityLabel && (
          <span className="pcv2-ledger-availability" role="status">
            {portfolioAvailabilityLabel}
          </span>
        )}
        <label className="pcv2-search">
          <input
            type="text"
            placeholder="Search ticker or name..."
            value={ledgerSearchFilter}
            onChange={(e) => setLedgerSearchFilter(e.target.value)}
          />
          <Search aria-hidden="true" />
        </label>
        <label className="pcv2-field">
          <span>Sort:</span>
          <select value={ledgerSortField} onChange={(e) => setLedgerSortField(e.target.value)}>
            <option value="weight">Weight</option>
            <option value="ticker">Ticker</option>
            <option value="name">Name</option>
            <option value="dayGainLoss">Day G/L</option>
          </select>
          <ChevronDown aria-hidden="true" />
        </label>
        <label className="pcv2-field">
          <span>Sleeve:</span>
          <select value={ledgerSleeveFilter} onChange={(e) => setLedgerSleeveFilter(e.target.value)}>
            <option value="all">All</option>
            {SLEEVE_ORDER.map((sleeve) => (
              <option value={sleeve} key={sleeve}>{sleeve}</option>
            ))}
          </select>
          <ChevronDown aria-hidden="true" />
        </label>
        <button type="button" className="pcv2-toolbar-icon" title="Filter options">
          <Filter size={14} />
        </button>
        <button
          type="button"
          className="pcv2-toolbar-icon"
          title="Refresh portfolio and research"
          aria-label={isRefreshing ? 'Refreshing portfolio and research' : 'Refresh portfolio and research'}
          aria-busy={isRefreshing}
          onClick={handleManualRefresh}
        >
          <RefreshCw size={14} />
        </button>
        <button type="button" className="pcv2-columns-button">
          Columns
          <ChevronDown size={13} />
        </button>
        <button type="button" className="pcv2-export pcv2-ledger-export" onClick={handleExportCsv}>
          <Download size={14} />
          Export CSV
        </button>
      </div>
      <div className="pcv2-ledger-split">
        {renderLedgerPane({ label: 'LONG', rows: ledgerLongs, isLongs: true })}
        {renderLedgerPane({ label: 'SHORT', rows: ledgerShorts, isLongs: false })}
      </div>
    </section>
  );

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Scrollable Content */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 8px 16px 2px', display: 'flex', flexDirection: 'column' }}>

        <section className="pcv2-shell">
          {renderFactorExposureBalance()}
          {renderUnifiedLedger()}
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
      {renderMetricVerification()}
    </div>

  );
};

export default PortfolioBreakdown;
