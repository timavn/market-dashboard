import React, { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import { Card, Text } from '@tremor/react';
import { ChevronDown, Download, Filter, Search } from 'lucide-react';
import {
  separateLongsAndShorts,
  formatPerformance
} from '../../utils/portfolioBreakdownUtils';
import { getIbkrPortfolioStatusDot } from '../../utils/ibkrConnectionStatus';
import { SECURITY_CATEGORY_MAPPING } from '../../constants/securityCategoryMapping';
import { SECURITIES_LIST } from '../../constants/securitiesList';
import LoadingIndicator from '../common/LoadingIndicator';
import StatusDot from '../common/StatusDot';
import './PortfolioConstructionIdeas.css';

const ASSET_CLASS_COLORS = {
  'Equities': '#10B981',      // Emerald green
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

const POSITION_SIZE_PARAMETERS = {
  long: {
    Currencies: '4-12%',
    'CASH': '0-100%',
    'Fixed Income': '3-10%',
    Equities: '2-6%',
    Commodities: '2-4%',
    Cryptocurrency: '1-3%',
  },
  short: {
    Currencies: '2-6%',
    'CASH': '0-100%',
    'Fixed Income': '2-5%',
    Equities: '1-3%',
    Commodities: '1-2%',
    Cryptocurrency: '0.5-1%',
  },
};

const POSITION_SIZE_BPS_STEPS = [50, 100, 150, 200, 250];
const POSITION_SIZE_GUIDE_ROWS = [
  { label: 'FX', long: POSITION_SIZE_PARAMETERS.long.Currencies, short: POSITION_SIZE_PARAMETERS.short.Currencies },
  { label: 'FI', long: POSITION_SIZE_PARAMETERS.long['Fixed Income'], short: POSITION_SIZE_PARAMETERS.short['Fixed Income'] },
  { label: 'Eq', long: POSITION_SIZE_PARAMETERS.long.Equities, short: POSITION_SIZE_PARAMETERS.short.Equities },
  { label: 'Com', long: POSITION_SIZE_PARAMETERS.long.Commodities, short: POSITION_SIZE_PARAMETERS.short.Commodities },
  { label: 'Crypto', long: POSITION_SIZE_PARAMETERS.long.Cryptocurrency, short: POSITION_SIZE_PARAMETERS.short.Cryptocurrency },
];

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

const getPositionSizeParameter = (holding, isLongs) => {
  const assetClass = getAssetClassForTicker(holding?.symbol, holding);
  const sizeMap = isLongs ? POSITION_SIZE_PARAMETERS.long : POSITION_SIZE_PARAMETERS.short;
  return sizeMap[assetClass] || '--';
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

const formatBps = (value) => {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '--';
  const rounded = Math.round(Number(value) * 100);
  if (rounded > 0) return `+${rounded}`;
  return `${rounded}`;
};

const formatSignedCurrency = (value, { compact = false } = {}) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return '--';
  const absValue = Math.abs(num);
  const sign = num > 0 ? '+' : num < 0 ? '-' : '';

  if (compact) {
    if (absValue >= 1000000) return `${sign}$${(absValue / 1000000).toFixed(1)}M`;
    if (absValue >= 1000) return `${sign}$${(absValue / 1000).toFixed(1)}K`;
  }

  return `${sign}$${absValue.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
};

const AS_OF_TIMEZONES = {
  pacific: {
    label: 'PST',
    timeZone: 'America/Los_Angeles',
  },
};

const formatAsOf = (value, zoneKey = 'pacific') => {
  if (!value) return 'As of --';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'As of --';
  const zone = AS_OF_TIMEZONES[zoneKey] || AS_OF_TIMEZONES.pacific;
  const formatted = date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: zone.timeZone,
  });
  return `As of ${formatted} ${zone.label}`;
};

const csvEscape = (value) => {
  const str = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
};

const PortfolioBreakdown = ({
  portfolioData,
  isLoading = false,
  connection = null,
  onRefresh = null,
}) => {
  const holdings = useMemo(() => portfolioData?.holdings || [], [portfolioData?.holdings]);

  const totalValue = portfolioData?.summary?.totalValue || 0;
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
  }, [columnVisibility]);

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
    if (!holding || !basisPoints || !totalValue || !holding.price) return null;
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
    if (!holding || targetPercent === undefined || targetPercent === null || !totalValue || !holding.price) return null;
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
    const absolutePct = totalValue > 0 ? ((Math.abs(holding.marketValue || 0) / totalValue) * 100) : 0;
    const currentPct = isLongs ? absolutePct : -absolutePct;
    if (percentPortfolioState[holding.symbol] !== undefined) return Number(percentPortfolioState[holding.symbol]);
    if (basisPointsState[holding.symbol] !== undefined) return currentPct + (Number(basisPointsState[holding.symbol]) / 100);
    return currentPct;
  }, [longsBasisPoints, longsPercentPortfolio, shortsBasisPoints, shortsPercentPortfolio, totalValue]);

  const getHoldingGap = useCallback((holding, isLongs) => {
    const target = getHoldingTargetPercent(holding, isLongs);
    if (target === null || Number.isNaN(target)) return null;
    const absolutePct = totalValue > 0 ? ((Math.abs(holding.marketValue || 0) / totalValue) * 100) : 0;
    const currentPct = isLongs ? absolutePct : -absolutePct;
    return currentPct - target;
  }, [getHoldingTargetPercent, totalValue]);

  const getResizeShares = (holding, isLongs) => {
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

  const getActionForResize = (shares, isLongs) => {
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

  const getDayGainLossValue = (holding) => {
    const explicit = Number(holding.dayChange ?? holding.dayGainLoss ?? holding.dailyPnL);
    if (Number.isFinite(explicit)) return explicit;
    const pct = Number(holding.dayChangePercent);
    const marketValue = Number(holding.marketValue);
    if (Number.isFinite(pct) && Number.isFinite(marketValue)) {
      return Math.abs(marketValue) * (pct / 100);
    }
    return null;
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

  const sortLedgerHoldings = useCallback((rows, isLongs) => {
    const sorted = [...rows];
    sorted.sort((a, b) => {
      const getValue = (holding) => {
        const weight = totalValue > 0 ? ((Math.abs(Number(holding.marketValue) || 0) / totalValue) * 100) : 0;
        switch (ledgerSortField) {
          case 'ticker':
            return (holding.symbol || '').toUpperCase();
          case 'name':
            return getSecurityName(holding).toUpperCase();
          case 'gap':
            return Math.abs(getHoldingGap(holding, isLongs) || 0);
          case 'dayGainLoss':
            return Math.abs(getDayGainLossValue(holding) || 0);
          case 'weight':
          default:
            return weight;
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
  }, [getHoldingGap, ledgerSortField, totalValue]);

  const filterLedgerHoldings = useCallback((rows) => {
    const query = ledgerSearchFilter.trim().toLowerCase();
    return rows.filter(holding => {
      if (ledgerSleeveFilter !== 'all' && getSleeveForHolding(holding) !== ledgerSleeveFilter) return false;
      if (!query) return true;
      const name = getSecurityName(holding).toLowerCase();
      const symbol = (holding.symbol || '').toLowerCase();
      return symbol.includes(query) || name.includes(query);
    });
  }, [ledgerSearchFilter, ledgerSleeveFilter]);

  const ledgerLongs = useMemo(() => {
    return sortLedgerHoldings(filterLedgerHoldings(longs), true);
  }, [filterLedgerHoldings, longs, sortLedgerHoldings]);

  const ledgerShorts = useMemo(() => {
    return sortLedgerHoldings(filterLedgerHoldings(shorts), false);
  }, [filterLedgerHoldings, shorts, sortLedgerHoldings]);

  const ledgerRows = useMemo(() => ([
    ...ledgerLongs.map((holding, index) => ({ holding, index, isLongs: true })),
    ...ledgerShorts.map((holding, index) => ({ holding, index, isLongs: false }))
  ]), [ledgerLongs, ledgerShorts]);

  const latestHoldingTimestamp = useMemo(() => {
    const timestamps = (portfolioData?.holdings || [])
      .map((holding) => holding?.lastUpdated || holding?.timestamp || null)
      .filter(Boolean)
      .map((value) => new Date(value))
      .filter((date) => !Number.isNaN(date.getTime()))
      .map((date) => date.getTime());

    if (timestamps.length === 0) {
      return null;
    }

    return new Date(Math.max(...timestamps)).toISOString();
  }, [portfolioData?.holdings]);

  const portfolioUpdatedAt =
    portfolioData?.accountSummary?.lastUpdated ||
    portfolioData?.lastUpdated ||
    portfolioData?.snapshotDate ||
    portfolioData?.summary?.lastUpdated ||
    latestHoldingTimestamp;

  const asOfLabel = formatAsOf(portfolioUpdatedAt);
  const statusDot = useMemo(
    () => getIbkrPortfolioStatusDot({ connection, portfolioData, loading: isLoading }),
    [connection, portfolioData, isLoading],
  );

  const handleExportCsv = () => {
    const rows = [
      ['Rank', 'Ticker', 'Name', 'Side', 'Weight % (NAV)', 'Target % (NAV)', 'Gap (bps)', 'Sleeve', 'Factor Ctrb', 'Resize (Shares)', 'Day G/L (USD)', 'Action']
    ];

    ledgerRows.forEach(({ holding, index, isLongs }) => {
      const currentPct = totalValue > 0 ? ((Math.abs(Number(holding.marketValue) || 0) / totalValue) * 100) : 0;
      const targetPct = getHoldingTargetPercent(holding, isLongs);
      const gap = getHoldingGap(holding, isLongs);
      const sleeve = getSleeveForHolding(holding);
      const shares = getResizeShares(holding, isLongs);
      const action = getActionForResize(shares, isLongs);
      const dayGainLoss = getDayGainLossValue(holding);

      rows.push([
        index + 1,
        holding.symbol || '',
        getSecurityName(holding),
        isLongs ? 'Long' : 'Short',
        (isLongs ? currentPct : -currentPct).toFixed(2),
        Number.isFinite(targetPct) ? targetPct.toFixed(2) : '',
        gap === null ? '' : Math.round(gap * 100),
        sleeve,
        formatPct(isLongs ? currentPct : -currentPct, 1, { signed: true }),
        shares ?? '',
        dayGainLoss === null ? '' : dayGainLoss.toFixed(2),
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

  // Early return after all hooks - check for actual data, not just portfolioData existence
  // The API returns an object with empty values when no data exists, so we need to check for actual holdings
  // Don't show "no data" message if we're actively loading/polling
  if (!isLoading && (!portfolioData || !holdings || (holdings.length === 0 && totalValue === 0 && !portfolioData?.accountSummary?.netLiquidation))) {
    return (
      <div style={{ padding: '32px', textAlign: 'center' }}>
        <Text className="text-gray-500 dark:text-gray-400">
          No portfolio data available. Connect IB Gateway and the IBKR API to view portfolio breakdown.
        </Text>
      </div>
    );
  }

  const reconciliationWarnings = portfolioData?.reconciliationWarnings || [];

  // Show loading state if we're actively fetching
  if (isLoading && (!holdings || holdings.length === 0)) {
    return (
      <LoadingIndicator label="Loading portfolio data..." size="lg" centered className="p-8" />
    );
  }

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
    [holding.positionSource && `pos: ${holding.positionSource}`, holding.priceSource && `price: ${holding.priceSource}`, holding.warning]
      .filter(Boolean)
      .join(' · ');

  const renderTargetControl = (holding, isLongs, pctOfAccount) => {
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
          <td colSpan={11} className="pcv2-empty">
            No {isLongs ? 'long' : 'short'} positions
          </td>
        </tr>
      );
    }

    return rows.map((holding, index) => {
      const pctOfAccount = totalValue > 0 ? ((Math.abs(Number(holding.marketValue) || 0) / totalValue) * 100) : 0;
      const sleeve = getSleeveForHolding(holding);
      const assetClass = getAssetClassAbbreviation(holding);
      const gap = getHoldingGap(holding, isLongs);
      const shares = getResizeShares(holding, isLongs);
      const action = getActionForResize(shares, isLongs);
      const dayGainLoss = getDayGainLossValue(holding);
      const positionSizeParameter = getPositionSizeParameter(holding, isLongs);

      return (
        <tr key={`${isLongs ? 'long' : 'short'}-${holding.symbol}-${index}`} className="pcv2-ledger-row">
          <td className="pcv2-ticker">
            <span title={holdingSourceTitle(holding) || undefined}>
              {holding.symbol}
              {holding.warning ? ' ⚠' : ''}
            </span>
          </td>
          <td className="pcv2-num">{assetClass}</td>
          <td className="pcv2-num">{formatPct(isLongs ? pctOfAccount : -pctOfAccount, 2)}</td>
          <td className="pcv2-num">{renderTargetControl(holding, isLongs, pctOfAccount)}</td>
          <td className={`pcv2-num ${gap === null ? '' : gap >= 0 ? 'pcv2-negative' : 'pcv2-under'}`}>{gap === null ? '--' : formatBps(gap)}</td>
          <td>{sleeve}</td>
          <td className="pcv2-num">{positionSizeParameter}</td>
          <td className={`pcv2-num ${isLongs ? 'pcv2-positive' : 'pcv2-negative'}`}>{formatPct(isLongs ? pctOfAccount : -pctOfAccount, 1, { signed: true })}</td>
          <td className="pcv2-num">{shares ? (shares > 0 ? `+${shares}` : shares) : '0'}</td>
          <td className={`pcv2-num ${dayGainLoss > 0 ? 'pcv2-positive' : dayGainLoss < 0 ? 'pcv2-negative' : ''}`}>{dayGainLoss === null ? '--' : formatSignedCurrency(dayGainLoss)}</td>
          <td className={`pcv2-action-cell ${action.tone === 'trim' ? 'pcv2-negative' : action.tone === 'add' ? 'pcv2-positive' : ''}`}>{action.label}</td>
        </tr>
      );
    });
  };

  const renderLedgerTableHead = () => (
    <thead>
      <tr>
        <th>Ticker</th>
        <th className="pcv2-num">AC</th>
        <th className="pcv2-num">Weight %<br />(NAV)</th>
        <th className="pcv2-num">Target %<br />(NAV)</th>
        <th className="pcv2-num">Gap<br />(BPS)</th>
        <th>Sleeve</th>
        <th className="pcv2-num">Pos Size<br />Params</th>
        <th className="pcv2-num">Factor Ctrb</th>
        <th className="pcv2-num">Resize<br />(Shares)</th>
        <th className="pcv2-num">Day G/L<br />(USD)</th>
        <th>Action</th>
      </tr>
    </thead>
  );

  const renderLedgerPane = ({ label, rows, isLongs }) => {
    const visibleWeight = totalValue > 0
      ? (rows.reduce((sum, holding) => sum + Math.abs(Number(holding.marketValue) || 0), 0) / totalValue) * 100
      : 0;

    return (
      <div className={`pcv2-ledger-pane ${isLongs ? 'pcv2-ledger-pane--long' : 'pcv2-ledger-pane--short'}`}>
        <div className="pcv2-ledger-pane-head">
          <span>{label}</span>
          <div className="pcv2-ledger-pane-stats">
            <span>{rows.length} positions</span>
            <span>{formatPct(visibleWeight, 1)} {isLongs ? 'long' : 'short'}</span>
          </div>
        </div>
        <div className="pcv2-ledger-pane-scroll">
          <table className="pcv2-ledger-table">
            {renderLedgerTableHead()}
            <tbody>
              {renderLedgerRows(rows, isLongs)}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  const renderPositionSizingGuide = () => (
    <div className="pcv2-sizing-guide" aria-label="Position sizing guide">
      <div className="pcv2-sizing-card pcv2-sizing-card--bps">
        <div className="pcv2-sizing-title">Position Sizes</div>
        <div className="pcv2-sizing-bps">
          {POSITION_SIZE_BPS_STEPS.map((bps) => (
            <div key={bps} className="pcv2-sizing-bps-item">
              <span>{bps}:</span>
              <span className="pcv2-sizing-value">
                {totalValue > 0
                  ? `$${Math.round((totalValue * bps) / 10000).toLocaleString()}`
                  : '--'}
              </span>
            </div>
          ))}
        </div>
      </div>

      {[
        { side: 'long', title: 'Longs', valueKey: 'long' },
        { side: 'short', title: 'Shorts', valueKey: 'short' },
      ].map((book) => (
        <div key={book.side} className={`pcv2-sizing-card pcv2-sizing-card--${book.side}`}>
          <div className="pcv2-sizing-title">{book.title}</div>
          <div className="pcv2-sizing-ranges">
            {POSITION_SIZE_GUIDE_ROWS.map((row) => (
              <div key={`${book.side}-${row.label}`} className="pcv2-sizing-range-row">
                <span>{row.label}</span>
                <span className="pcv2-sizing-value">{row[book.valueKey]}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );

  const renderUnifiedLedger = () => (
    <section className="pcv2-card pcv2-ledger-card">
      <div className="pcv2-ledger-toolbar">
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
            <option value="gap">Gap</option>
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
        <button type="button" className="pcv2-columns-button">
          Columns
          <ChevronDown size={13} />
        </button>
      </div>
      <div className="pcv2-ledger-split">
        {renderLedgerPane({ label: 'Longs', rows: ledgerLongs, isLongs: true })}
        {renderLedgerPane({ label: 'Shorts', rows: ledgerShorts, isLongs: false })}
      </div>
      <div className="pcv2-ledger-note">
        Weights and targets are % of Net Liquidation Value (NAV). Gap in basis points (bps). Factor Contribution shows estimated impact on factor exposure.
      </div>
    </section>
  );

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {reconciliationWarnings.length > 0 && (
        <div
          className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded p-2 mb-2"
          role="status"
        >
          {reconciliationWarnings.slice(0, 3).join(' · ')}
        </div>
      )}
      {/* Scrollable Content */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 8px 16px 2px', display: 'flex', flexDirection: 'column' }}>

        <section className="pcv2-shell">
          <header className="pcv2-header">
            <div className="pcv2-header-main">
              <h2>Portfolio Construction</h2>
              <div className="pcv2-header-meta">
                <StatusDot
                  updatedAt={statusDot.updatedAt || portfolioUpdatedAt}
                  status={statusDot.status}
                  emoji={statusDot.emoji}
                  size={9}
                  className="pcv2-header-status"
                  label="Portfolio data"
                  align="after"
                  placement="bottom"
                />
                <span>{asOfLabel}</span>
              </div>
            </div>
            <div className="pcv2-header-right">
              {renderPositionSizingGuide()}
              <div className="pcv2-header-actions">
                <button type="button" className="pcv2-export" onClick={handleExportCsv}>
                  <Download size={16} />
                  Export CSV
                </button>
              </div>
            </div>
          </header>

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
                backgroundColor: '#10B981',
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
                                  {holding.warning ? ' ⚠' : ''}
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
                backgroundColor: '#EF4444',
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
                                  {holding.warning ? ' ⚠' : ''}
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
    </div>

  );
};

export default PortfolioBreakdown;
