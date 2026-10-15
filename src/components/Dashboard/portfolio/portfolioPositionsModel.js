import { SECURITY_CATEGORY_MAPPING } from '../../../constants/securityCategoryMapping';
import { SECURITIES_LIST } from '../../../constants/securitiesList';
import { getExposureDefinition, resolveSecurityExposureProfile } from '../../../constants/quadExposureCatalog';
import { finiteOptionalNumber } from '../../../utils/portfolioNumbers';
import { formatResearchDateLabel } from './portfolioResearchRows';

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

export const getAssetClassForTicker = (ticker, holding = null) => {
  // Use the reviewed economic exposure before a broker's generic ETF/equity type.
  const profile = resolveSecurityExposureProfile(holding || ticker);
  const primary = getExposureDefinition(profile.primaryExposureId);
  if (profile.classificationStatus === 'reviewed' && primary) {
    if (['equitySectors', 'equityStyleFactors'].includes(primary.dimension)) return 'Equities';
    if (primary.dimension === 'fixedIncomeSectors') return 'Fixed Income';
    if (primary.dimension === 'assetClasses') {
      if (primary.label === 'Credit') return 'Fixed Income';
      return CATEGORY_DISPLAY_NAMES[primary.label] || primary.label;
    }
  }

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

export const SLEEVE_ORDER = ['Growth', 'Credit', 'Inflation', 'Defensive', 'Volatility', 'Cash'];

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
  'Managed Futures': 'MF',
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

export const getSleeveForHolding = (holding) => {
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

export const getSecurityName = (holding) => {
  const symbol = (holding?.symbol || '').toUpperCase();
  return holding?.description || holding?.name || SECURITY_NAME_BY_TICKER[symbol] || holding?.symbol || '--';
};

export const getQuadExposureLabels = (holding) => {
  const profile = resolveSecurityExposureProfile(holding);
  if (profile?.classificationStatus !== 'reviewed') return [];
  return [profile.primaryExposureId, ...(profile.secondaryExposureIds || [])]
    .map((exposureId) => getExposureDefinition(exposureId)?.label)
    .filter(Boolean);
};

export const getAssetClassAbbreviation = (holding) => {
  const assetClass = getAssetClassForTicker(holding?.symbol, holding);
  return ASSET_CLASS_ABBREVIATIONS[assetClass] || assetClass || '--';
};

export const formatPct = (value, decimals = 1, { signed = false } = {}) => {
  const num = Number(value) || 0;
  const sign = signed && num > 0 ? '+' : '';
  return `${sign}${num.toFixed(decimals)}%`;
};

export const getPortfolioWeight = (holding, totalValue) => {
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

const isVerifiedLiveMark = (holding) => (
  holding?.priceState === 'live'
  && holding?.marketValueState === 'live'
  && holding?.priceSource === 'ibkr_live_last'
  && isValidObservedAt(holding?.priceObservedAt)
  && finiteOptionalNumber(holding?.price) > 0
);

export const isHistoricalReferenceMark = (holding) => (
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

export const formatPrice = (value) => {
  const price = finiteOptionalNumber(value);
  if (price === null) return '—';
  const decimals = Math.abs(price) < 1 ? 4 : 2;
  return `$${price.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
};

export const getVerifiedHoldingMark = (holding, verifiedPortfolioMarks) => {
  if (verifiedPortfolioMarks !== true) return null;
  const price = finiteOptionalNumber(holding?.price);
  if (price === null) return null;
  if (isVerifiedLiveMark(holding)) {
    return {
      value: price,
      state: 'live',
      ariaLabel: `Live price ${formatPrice(price)}`,
      title: `Verified live IBKR last · observed ${holding.priceObservedAt}`,
      updatedAt: holding.priceObservedAt,
    };
  }
  if (isVerifiedHistoricalDisplayMark(holding)) {
    return {
      value: price,
      state: 'historical_close',
      statusLabel: `LAST CLOSE · ${formatResearchDateLabel(holding.priceSessionDate)}`,
      ariaLabel: `Last close ${formatPrice(price)} from ${holding.priceSessionDate}`,
      title: `Last close · ${holding.priceSessionDate} · reference only`,
      updatedAt: holding.priceObservedAt || holding.priceSessionDate,
    };
  }
  return null;
};

export const getVerifiedDayGainLossPercent = (holding, verifiedPortfolioMarks) => {
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

export const csvEscape = (value) => {
  const str = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
};

export const holdingSourceTitle = (holding) =>
  [
    holding.positionSource && `pos: ${holding.positionSource}`,
    holding.priceSource && `price: ${holding.priceSource}`,
    holding.priceSessionDate && `session: ${holding.priceSessionDate}`,
    holding.priceObservedAt && `observed: ${holding.priceObservedAt}`,
    holding.warning,
  ]
    .filter(Boolean)
    .join(' · ');
