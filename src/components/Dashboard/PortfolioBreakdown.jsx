import React, { useMemo, useState, useEffect } from 'react';
import { Card, Title, Text } from '@tremor/react';
import { PieChart, Pie, Cell, ResponsiveContainer, Legend } from 'recharts';
import {
  separateLongsAndShorts,
  formatPerformance,
  getPerformanceColor,
  formatDate
} from '../../utils/portfolioBreakdownUtils';
import { SECURITY_CATEGORY_MAPPING } from '../../constants/securityCategoryMapping';
import { FACTOR_DEFINITIONS } from '../../constants/factorDefinitions';

// Asset class colors - 5 core asset classes
const ASSET_CLASS_COLORS = {
  'Equities': '#10B981',      // Emerald green
  'Fixed Income': '#3B82F6',  // Blue
  'Commodities': '#F97316',   // Orange
  'FX': '#8B5CF6',            // Violet (includes Gold, USD, and other currencies)
  'Currencies': '#8B5CF6',    // Violet (alias for FX)
  'Cryptocurrency': '#F59E0B', // Amber
  // Note: "Other" category has been removed - all holdings are now properly classified
};

// Map category from SECURITY_CATEGORY_MAPPING to display asset class
// 5 core asset classes: Equities, Fixed Income, Commodities, FX (Currencies), Cryptocurrency
const CATEGORY_DISPLAY_NAMES = {
  'Equities': 'Equities',
  'Fixed Income': 'Fixed Income',
  'Commodities': 'Commodities',
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

/**
 * Calculate asset class allocation using securities universe mapping
 * Always includes all 5 core asset classes in the result, even if 0%
 */
const calculateAssetClassAllocationFromUniverse = (holdings) => {
  // Define all 5 core asset classes
  const allAssetClasses = ['Equities', 'Fixed Income', 'Commodities', 'Currencies', 'Cryptocurrency'];
  
  const allocation = {};
  let totalValue = 0;

  // Initialize all asset classes to 0
  allAssetClasses.forEach(assetClass => {
    allocation[assetClass] = 0;
  });

  // Calculate allocation from holdings
  if (holdings && holdings.length > 0) {
    holdings.forEach(holding => {
      const marketValue = Math.abs(parseFloat(holding.marketValue) || 0);
      const assetClass = getAssetClassForTicker(holding.symbol, holding);
      
      // Ensure the asset class is one of the 5 core classes
      const normalizedAssetClass = allAssetClasses.includes(assetClass) ? assetClass : 'Equities';
      
      if (!allocation[normalizedAssetClass]) {
        allocation[normalizedAssetClass] = 0;
      }
      allocation[normalizedAssetClass] += marketValue;
      totalValue += marketValue;
    });
  }

  // Convert to percentage and always include all 5 asset classes
  return allAssetClasses.map(name => ({
    name,
    value: totalValue > 0 ? parseFloat(((allocation[name] / totalValue) * 100).toFixed(2)) : 0,
    rawValue: allocation[name] || 0
  })).sort((a, b) => {
    // Sort by value descending, but keep all items
    if (b.value !== a.value) {
      return b.value - a.value;
    }
    // If values are equal, maintain consistent order
    return allAssetClasses.indexOf(a.name) - allAssetClasses.indexOf(b.name);
  });
};

const PortfolioBreakdown = ({ portfolioData, isLoading = false }) => {
  const [showFactorExposureInfo, setShowFactorExposureInfo] = useState(false);
  const holdings = portfolioData?.holdings || [];
  const totalValue = portfolioData?.summary?.totalValue || 0;
  const factorExposures = portfolioData?.factorExposures || {};

  // Sorting state for longs and shorts tables
  const [longsSortConfig, setLongsSortConfig] = useState({ field: null, direction: 'desc' });
  const [shortsSortConfig, setShortsSortConfig] = useState({ field: null, direction: 'desc' });

  // Search filters for tickers
  const [longsSearchFilter, setLongsSearchFilter] = useState('');
  const [shortsSearchFilter, setShortsSearchFilter] = useState('');

  // Column visibility state (shared for both tables)
  const [columnVisibility, setColumnVisibility] = useState({
    qty: true,
    price: true,
    marketValue: true,
    pctAccount: true,
    basisPts: true,
    percentPortfolio: true,
    qtyNeeded: true,
    intradayGainLoss: true,
    gainLoss: true
  });

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
    { key: 'pctAccount', label: '% Acct' },
    { key: 'basisPts', label: 'Basis Pts' },
    { key: 'percentPortfolio', label: '% Portfolio' },
    { key: 'qtyNeeded', label: 'Qty Needed' },
    { key: 'intradayGainLoss', label: 'Intraday G/L' },
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
        backgroundColor: '#dbeafe',
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
              <div>Intraday</div>
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
              <div>Acct</div>
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
              <div>%</div>
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
              <div>Qty</div>
              <div>Needed</div>
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
            ${Math.abs(holding.marketValue || 0).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}
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
        
        return (
          <td key={columnKey} style={{ padding: '6px', textAlign: 'center' }}>
            <div style={{ position: 'relative', display: 'inline-block' }}>
              <input
                type="number"
                step="0.25"
                placeholder="%"
                value={targetPercent !== undefined ? targetPercent : displayPercent.toFixed(2)}
                onChange={(e) => {
                  const value = e.target.value;
                  if (value === '') {
                    setPercentPortfolioState(prev => {
                      const newState = { ...prev };
                      delete newState[holding.symbol];
                      return newState;
                    });
                    // Clear basis points when setting target %
                    setBasisPointsState(prev => {
                      const newState = { ...prev };
                      delete newState[holding.symbol];
                      return newState;
                    });
                  } else {
                    const numValue = parseFloat(value);
                    if (!isNaN(numValue)) {
                      setPercentPortfolioState(prev => ({
                        ...prev,
                        [holding.symbol]: numValue
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
                  // Prevent arrow keys from incrementing by step
                  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                    e.preventDefault();
                    const current = parseFloat(targetPercent !== undefined ? targetPercent : displayPercent) || 0;
                    let newValue;
                    if (e.key === 'ArrowUp') {
                      // Round up to nearest 0.10
                      newValue = Math.ceil(current * 10) / 10;
                      // If already at a 0.10 increment, add 0.10
                      if (newValue === current) {
                        newValue = current + 0.10;
                      }
                    } else {
                      // Round down to nearest 0.10
                      newValue = Math.floor(current * 10) / 10;
                      // If already at a 0.10 increment, keep it the same
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
                    // Round up to nearest 0.10
                    let newValue = Math.ceil(current * 10) / 10;
                    // If already at a 0.10 increment, add 0.10
                    if (newValue === current) {
                      newValue = current + 0.10;
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
                    // Round down to nearest 0.10
                    const newValue = Math.floor(current * 10) / 10;
                    // If already at a 0.10 increment, keep it the same
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
          <td key={columnKey} style={{ padding: '6px', textAlign: 'center', fontWeight: '600' }} className="dark:text-white">
            {(() => {
              let shares = null;
              
              // Prioritize target % portfolio over basis points
              if (targetPercentForQty !== undefined) {
                shares = calculateSharesFromPercent(holding, targetPercentForQty, totalValue, !isLongs);
              } else if (basisPointsForQty) {
                shares = calculateSharesFromBasisPoints(holding, basisPointsForQty, totalValue, !isLongs);
              }
              
              if (shares === null) return '--';
              if (shares === 0) return '0';
              return shares > 0 ? `+${shares}` : `${shares}`;
            })()}
          </td>
        );
      case 'gainLoss':
        return React.cloneElement(renderPerformanceCell(holding.gainLossPercent), { key: columnKey });
      default:
        return null;
    }
  };

  // State for highlighted asset classes in pie charts
  const [highlightedLongsAssetClasses, setHighlightedLongsAssetClasses] = useState(new Set());
  const [highlightedShortsAssetClasses, setHighlightedShortsAssetClasses] = useState(new Set());

  // State for animated radius (for smooth scale animation)
  const [longsHighlightRadius, setLongsHighlightRadius] = useState(96);
  const [shortsHighlightRadius, setShortsHighlightRadius] = useState(96);

  // Animate radius when highlighted classes change
  useEffect(() => {
    if (highlightedLongsAssetClasses.size > 0) {
      // Smoothly animate from 96 to 106 over 500ms
      const startRadius = 96;
      const endRadius = 106;
      const duration = 500;
      const startTime = Date.now();

      const animate = () => {
        const elapsed = Date.now() - startTime;
        const progress = Math.min(elapsed / duration, 1);
        // Ease-out function for smooth deceleration
        const easeProgress = 1 - Math.pow(1 - progress, 3);
        const currentRadius = startRadius + (endRadius - startRadius) * easeProgress;

        setLongsHighlightRadius(currentRadius);

        if (progress < 1) {
          requestAnimationFrame(animate);
        }
      };

      requestAnimationFrame(animate);
    } else {
      setLongsHighlightRadius(96);
    }
  }, [highlightedLongsAssetClasses.size]);

  useEffect(() => {
    if (highlightedShortsAssetClasses.size > 0) {
      // Smoothly animate from 96 to 106 over 500ms
      const startRadius = 96;
      const endRadius = 106;
      const duration = 500;
      const startTime = Date.now();

      const animate = () => {
        const elapsed = Date.now() - startTime;
        const progress = Math.min(elapsed / duration, 1);
        // Ease-out function for smooth deceleration
        const easeProgress = 1 - Math.pow(1 - progress, 3);
        const currentRadius = startRadius + (endRadius - startRadius) * easeProgress;

        setShortsHighlightRadius(currentRadius);

        if (progress < 1) {
          requestAnimationFrame(animate);
        }
      };

      requestAnimationFrame(animate);
    } else {
      setShortsHighlightRadius(96);
    }
  }, [highlightedShortsAssetClasses.size]);

  // State for basis points and % portfolio inputs for each holding
  const [longsBasisPoints, setLongsBasisPoints] = useState({});
  const [longsPercentPortfolio, setLongsPercentPortfolio] = useState({});
  const [shortsBasisPoints, setShortsBasisPoints] = useState({});
  const [shortsPercentPortfolio, setShortsPercentPortfolio] = useState({});

  // Separate longs and shorts
  const { longs, shorts } = useMemo(() => {
    return separateLongsAndShorts(holdings);
  }, [holdings]);

  // Helper function to sort holdings
  const sortHoldings = (holdings, sortConfig) => {
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
  };

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

  // Calculate asset class allocation for longs using securities universe
  const longsAssetAllocation = useMemo(() => {
    return calculateAssetClassAllocationFromUniverse(longs);
  }, [longs]);

  // Calculate asset class allocation for shorts using securities universe
  const shortsAssetAllocation = useMemo(() => {
    return calculateAssetClassAllocationFromUniverse(shorts);
  }, [shorts]);

  // Calculate net long/short percentage
  const netLongShortPercentage = useMemo(() => {
    if (!totalValue || totalValue === 0) return 0;
    
    // Calculate total long and short values
    const totalLongValue = longs.reduce((sum, holding) => sum + Math.abs(parseFloat(holding.marketValue) || 0), 0);
    const totalShortValue = shorts.reduce((sum, holding) => sum + Math.abs(parseFloat(holding.marketValue) || 0), 0);
    
    // Net long percentage = (total long - total short) / total value * 100
    const netLong = ((totalLongValue - totalShortValue) / totalValue) * 100;
    
    return netLong;
  }, [longs, shorts, totalValue]);

  // Toggle asset class highlight for longs
  const toggleLongsAssetClass = (assetClass) => {
    setHighlightedLongsAssetClasses(prev => {
      const newSet = new Set(prev);
      if (newSet.has(assetClass)) {
        newSet.delete(assetClass);
      } else {
        newSet.add(assetClass);
      }
      return newSet;
    });
  };

  // Toggle asset class highlight for shorts
  const toggleShortsAssetClass = (assetClass) => {
    setHighlightedShortsAssetClasses(prev => {
      const newSet = new Set(prev);
      if (newSet.has(assetClass)) {
        newSet.delete(assetClass);
      } else {
        newSet.add(assetClass);
      }
      return newSet;
    });
  };

  // Calculate start and end angles for a slice in the pie chart
  const calculateSliceAngles = (allocationData, targetName) => {
    const total = allocationData.reduce((sum, entry) => sum + entry.value, 0);
    if (total === 0) return { startAngle: 0, endAngle: 0 };
    
    const targetIndex = allocationData.findIndex(entry => entry.name === targetName);
    if (targetIndex === -1) return { startAngle: 0, endAngle: 0 };
    
    // Safety check: if the target slice has 0% value, return early to prevent rendering
    const targetValue = allocationData[targetIndex].value;
    if (targetValue === 0 || !(typeof targetValue === 'number' && targetValue > 0)) {
      return { startAngle: 0, endAngle: 0 };
    }
    
    // Calculate cumulative percentage before this slice
    const startPercent = allocationData
      .slice(0, targetIndex)
      .reduce((sum, entry) => sum + entry.value, 0) / total;
    
    // Calculate this slice's percentage
    const slicePercent = targetValue / total;
    
    // Safety check: if slicePercent is 0, return early
    if (slicePercent === 0) {
      return { startAngle: 0, endAngle: 0 };
    }
    
    // Convert to angles (start from -90 degrees, going clockwise)
    const startAngle = -90 + startPercent * 360;
    const endAngle = -90 + (startPercent + slicePercent) * 360;
    
    return { startAngle, endAngle };
  };

  // Generate legend payload with all 5 asset classes with interactive styling
  const generateLegendPayload = (allocationData, highlightedSet, onToggle) => {
    const allAssetClasses = ['Equities', 'Fixed Income', 'Commodities', 'Currencies', 'Cryptocurrency'];
    return allAssetClasses.map(name => {
      const dataItem = allocationData.find(item => item.name === name);
      const isHighlighted = highlightedSet.has(name);
      return {
        value: name,
        type: 'square',
        color: ASSET_CLASS_COLORS[name] || ASSET_CLASS_COLORS['Equities'],
        id: name,
        payload: {
          onClick: () => onToggle(name),
          style: {
            cursor: 'pointer',
            fontWeight: isHighlighted ? 'bold' : 'normal',
            opacity: isHighlighted ? 1 : 0.5,
            transition: 'all 0.2s ease'
          }
        }
      };
    });
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
    if (!holding || !targetPercent || !totalValue || !holding.price) return null;
    const price = parseFloat(holding.price);
    if (price === 0) return null;
    
    // Current % of portfolio (use absolute value for calculation)
    const currentPercent = totalValue > 0 ? ((Math.abs(holding.marketValue) / totalValue) * 100) : 0;
    const targetPercentNum = parseFloat(targetPercent);
    
    // Difference in percentage
    const percentDiff = targetPercentNum - currentPercent;
    
    // Dollar amount needed: (percentDiff / 100) * totalValue
    const dollarAmount = (percentDiff / 100) * totalValue;
    let shares = dollarAmount / price;
    
    // For shorts: if target % is higher than current, we need to sell more (negative shares)
    // If target % is lower, we need to buy back (positive shares)
    if (isShort) {
      shares = -shares; // Flip sign for shorts
    }
    
    return Math.round(shares);
  };

  // Calculate top 5 factor exposures from all holdings
  const topFactorExposures = useMemo(() => {
    const factorMap = {};

    holdings.forEach(holding => {
      const marketValue = Math.abs(parseFloat(holding.marketValue) || 0);
      const mapping = SECURITY_CATEGORY_MAPPING[holding.symbol?.toUpperCase()];

      if (mapping && mapping.category) {
        const factor = mapping.category;
        if (!factorMap[factor]) {
          factorMap[factor] = 0;
        }
        factorMap[factor] += marketValue;
      }
    });

    // Convert to array and calculate percentages
    const factorArray = Object.entries(factorMap)
      .map(([factor, value]) => ({
        factor,
        value,
        percentage: totalValue > 0 ? ((value / totalValue) * 100) : 0
      }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 5); // Top 5

    return factorArray;
  }, [holdings, totalValue]);

  // Apply filtering and sorting to longs and shorts
  const sortedLongs = useMemo(() => {
    const filtered = longsSearchFilter
      ? longs.filter(holding =>
          holding.symbol?.toUpperCase().includes(longsSearchFilter.toUpperCase())
        )
      : longs;
    return sortHoldings(filtered, longsSortConfig);
  }, [longs, longsSortConfig, longsSearchFilter, totalValue]);

  const sortedShorts = useMemo(() => {
    const filtered = shortsSearchFilter
      ? shorts.filter(holding =>
          holding.symbol?.toUpperCase().includes(shortsSearchFilter.toUpperCase())
        )
      : shorts;
    return sortHoldings(filtered, shortsSortConfig);
  }, [shorts, shortsSortConfig, shortsSearchFilter, totalValue]);

  // Prepare combined allocation data for the double pie chart
  const { innerData, outerData } = useMemo(() => {
    const allAllocation = calculateAssetClassAllocationFromUniverse(holdings);
    return { innerData: allAllocation, outerData: allAllocation };
  }, [holdings]);

  // Early return after all hooks - check for actual data, not just portfolioData existence
  // The API returns an object with empty values when no data exists, so we need to check for actual holdings
  // Don't show "no data" message if we're actively loading/polling
  if (!isLoading && (!portfolioData || !holdings || holdings.length === 0 || totalValue === 0)) {
    return (
      <div style={{ padding: '32px', textAlign: 'center' }}>
        <Text className="text-gray-500 dark:text-gray-400">
          No portfolio data available. Please upload a Schwab CSV to view portfolio breakdown.
        </Text>
      </div>
    );
  }
  
  // Show loading state if we're actively fetching
  if (isLoading && (!holdings || holdings.length === 0)) {
    return (
      <div style={{ padding: '32px', textAlign: 'center' }}>
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-blue-500 border-t-transparent mx-auto mb-4"></div>
        <Text className="text-gray-500 dark:text-gray-400">
          Loading portfolio data...
        </Text>
      </div>
    );
  }

  // Custom label for pie charts - centered in each slice with black text
  // Label renderer for base pie (non-highlighted slices only) - positioned outside pie
  const renderBasePieLabelLongs = ({ cx, cy, midAngle, innerRadius, outerRadius, percent, name }) => {
    // Don't show label if this slice is highlighted
    if (highlightedLongsAssetClasses.has(name)) return null;

    const RADIAN = Math.PI / 180;
    if (percent < 0.05) return null; // Don't show labels for slices < 5%

    // Position 15px outside the outer edge
    const radius = outerRadius + 15;
    const x = cx + radius * Math.cos(-midAngle * RADIAN);
    const y = cy + radius * Math.sin(-midAngle * RADIAN);

    return (
      <text
        x={x}
        y={y}
        fill="#000000"
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={7.4}
        fontWeight="600"
      >
        {`${(percent * 100).toFixed(1)}%`}
      </text>
    );
  };

  // Label renderer for base pie (non-highlighted slices only) - shorts
  const renderBasePieLabelShorts = ({ cx, cy, midAngle, innerRadius, outerRadius, percent, name }) => {
    // Don't show label if this slice is highlighted
    if (highlightedShortsAssetClasses.has(name)) return null;

    const RADIAN = Math.PI / 180;
    if (percent < 0.05) return null;

    // Position 15px outside the outer edge
    const radius = outerRadius + 15;
    const x = cx + radius * Math.cos(-midAngle * RADIAN);
    const y = cy + radius * Math.sin(-midAngle * RADIAN);

    return (
      <text
        x={x}
        y={y}
        fill="#000000"
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={7.4}
        fontWeight="600"
      >
        {`${(percent * 100).toFixed(1)}%`}
      </text>
    );
  };

  // Label renderer for highlighted pie (highlighted slices only) - longs
  const renderHighlightedPieLabelLongs = ({ cx, cy, midAngle, innerRadius, outerRadius, percent, name }) => {
    // Only show label if this slice is highlighted
    if (!highlightedLongsAssetClasses.has(name)) return null;

    const RADIAN = Math.PI / 180;
    if (percent < 0.05) return null;

    // Position 15px outside the outer edge (grows with animated radius)
    const radius = outerRadius + 15;
    const x = cx + radius * Math.cos(-midAngle * RADIAN);
    const y = cy + radius * Math.sin(-midAngle * RADIAN);

    return (
      <text
        x={x}
        y={y}
        fill="#000000"
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={7.4}
        fontWeight="600"
      >
        {`${(percent * 100).toFixed(1)}%`}
      </text>
    );
  };

  // Label renderer for highlighted pie (highlighted slices only) - shorts
  const renderHighlightedPieLabelShorts = ({ cx, cy, midAngle, innerRadius, outerRadius, percent, name }) => {
    // Only show label if this slice is highlighted
    if (!highlightedShortsAssetClasses.has(name)) return null;

    const RADIAN = Math.PI / 180;
    if (percent < 0.05) return null;

    // Position 15px outside the outer edge (grows with animated radius)
    const radius = outerRadius + 15;
    const x = cx + radius * Math.cos(-midAngle * RADIAN);
    const y = cy + radius * Math.sin(-midAngle * RADIAN);

    return (
      <text
        x={x}
        y={y}
        fill="#000000"
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={7.4}
        fontWeight="600"
      >
        {`${(percent * 100).toFixed(1)}%`}
      </text>
    );
  };

  // Generic label renderer for other pie charts (positioned outside edge)
  const renderCustomLabel = ({ cx, cy, midAngle, innerRadius, outerRadius, percent }) => {
    const RADIAN = Math.PI / 180;
    if (percent < 0.05) return null;

    // Position 15px outside the outer edge
    const radius = outerRadius + 15;
    const x = cx + radius * Math.cos(-midAngle * RADIAN);
    const y = cy + radius * Math.sin(-midAngle * RADIAN);

    return (
      <text
        x={x}
        y={y}
        fill="#000000"
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={7.4}
        fontWeight="600"
      >
        {`${(percent * 100).toFixed(1)}%`}
      </text>
    );
  };

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

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Sticky Header - Portfolio Construction Guide */}
      <div
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 10,
          backgroundColor: 'white',
          padding: '6px 12px',
          borderBottom: '1px solid #E5E7EB',
          marginBottom: '12px'
        }}
        className="dark:bg-gray-900 dark:border-gray-700"
      >
        <div className="font-semibold" style={{ fontSize: '11px', marginBottom: '4px', color: '#374151' }}>
          Portfolio Construction
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px', fontSize: '10px' }}>
          {/* Left Column - Top 5 Factor Exposures */}
          <div className="text-gray-600 dark:text-gray-400 p-1.5 bg-blue-50 dark:bg-blue-900/10 rounded border border-blue-200 dark:border-blue-700 relative">
            <div className="flex items-center gap-1" style={{ marginBottom: '2px' }}>
              <div className="font-medium text-blue-700 dark:text-blue-400">Top 5 Factors:</div>
              <button
                onClick={() => setShowFactorExposureInfo(!showFactorExposureInfo)}
                className="text-blue-400 hover:text-blue-600 dark:hover:text-blue-300"
                title="Factor Exposure Information"
                style={{ 
                  width: '12px', 
                  height: '12px', 
                  borderRadius: '50%', 
                  border: '1px solid currentColor',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '8px',
                  cursor: 'pointer',
                  lineHeight: '1'
                }}
              >
                i
              </button>
            </div>
            {showFactorExposureInfo && (
              <div 
                className="absolute z-50 mt-2 p-3 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg"
                style={{ 
                  maxWidth: '400px', 
                  maxHeight: '500px', 
                  overflowY: 'auto',
                  left: '0',
                  top: '100%',
                  marginTop: '4px'
                }}
              >
                <Text className="text-xs font-semibold mb-2 block dark:text-white">Factor Definitions</Text>
                <div className="space-y-3">
                  {Object.entries(FACTOR_DEFINITIONS.factors).map(([factorName, factorData]) => (
                    <div key={factorName} className="border-b border-gray-200 dark:border-gray-700 pb-2 last:border-b-0">
                      <Text className="text-xs font-semibold dark:text-white">{factorData.title || factorName}</Text>
                      <Text className="text-xs text-gray-600 dark:text-gray-400 mt-1 block">
                        {factorData.description}
                      </Text>
                    </div>
                  ))}
                </div>
                <button
                  onClick={() => setShowFactorExposureInfo(false)}
                  className="mt-2 text-xs text-blue-600 dark:text-blue-400 hover:underline"
                >
                  Close
                </button>
              </div>
            )}
            <div>
              {topFactorExposures.length > 0 ? (
                topFactorExposures.map((item, idx) => (
                  <div key={idx}>
                    {item.factor}: {item.percentage.toFixed(1)}%
                  </div>
                ))
              ) : (
                <div className="text-gray-400">No data</div>
              )}
            </div>
          </div>

          {/* Middle Column - Basis Points */}
          <div className="text-gray-600 dark:text-gray-400 p-1.5 bg-gray-50 dark:bg-gray-800 rounded border border-gray-200 dark:border-gray-700">
            <div className="font-medium text-gray-700 dark:text-gray-300" style={{ marginBottom: '2px' }}>Basis Points:</div>
            <div className="grid grid-cols-2 gap-x-2">
              <div>25: ${Math.floor(totalValue * 0.0025).toLocaleString()}</div>
              <div>50: ${Math.floor(totalValue * 0.005).toLocaleString()}</div>
              <div>75: ${Math.floor(totalValue * 0.0075).toLocaleString()}</div>
              <div>100: ${Math.floor(totalValue * 0.01).toLocaleString()}</div>
              <div>125: ${Math.floor(totalValue * 0.0125).toLocaleString()}</div>
              <div>150: ${Math.floor(totalValue * 0.015).toLocaleString()}</div>
              <div>175: ${Math.floor(totalValue * 0.0175).toLocaleString()}</div>
              <div>200: ${Math.floor(totalValue * 0.02).toLocaleString()}</div>
              <div>225: ${Math.floor(totalValue * 0.0225).toLocaleString()}</div>
              <div>250: ${Math.floor(totalValue * 0.025).toLocaleString()}</div>
            </div>
          </div>

          {/* Right Column - Position Sizing */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px' }}>
            {/* Long Position Sizing */}
            <div className="text-gray-600 dark:text-gray-400 p-1.5 bg-green-50 dark:bg-green-900/10 rounded border border-green-200 dark:border-green-800">
              <div className="font-medium text-green-700 dark:text-green-400" style={{ marginBottom: '2px' }}>Longs:</div>
              <div>
                <div>FX: 4-12%</div>
                <div>FI: 4-10%</div>
                <div>Eq: 2-6%</div>
                <div>Com: 2-4%</div>
                <div>Crypto: 1-3%</div>
              </div>
            </div>

            {/* Short Position Sizing */}
            <div className="text-gray-600 dark:text-gray-400 p-1.5 bg-red-50 dark:bg-red-900/10 rounded border border-red-200 dark:border-red-800">
              <div className="font-medium text-red-700 dark:text-red-400" style={{ marginBottom: '2px' }}>Shorts:</div>
              <div>
                <div>FX: 2-6%</div>
                <div>FI: 2-5%</div>
                <div>Eq: 1-3%</div>
                <div>Com: 1-2%</div>
                <div>Crypto: 0.5-1%</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Scrollable Content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '0 8px 16px 2px' }}>
        {/* Longs/Shorts Breakdown Section */}
        <div style={{ marginBottom: '32px' }}>
          {/* Shared Header with Long/Short counts and net percentage */}
          <div 
            className="mb-4 rounded-lg p-4 bg-white dark:bg-gray-800" 
            style={{ 
              border: `1px solid ${netLongShortPercentage >= 0 ? '#10B981' : '#EF4444'}`,
              boxShadow: '0 1px 3px 0 rgba(0, 0, 0, 0.1), 0 1px 2px 0 rgba(0, 0, 0, 0.06)'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '16px', marginBottom: '8px' }}>
              <div style={{ flex: 1, display: 'flex', justifyContent: 'flex-end' }}>
                <Title className="text-xl dark:text-white" style={{ color: '#10B981', fontWeight: 700, margin: 0 }}>
                  LONG : {longs.length}
                </Title>
              </div>
              <div style={{ width: '1px', height: '40px', backgroundColor: '#3b82f6', margin: '0 8px' }}></div>
              <div style={{ flex: 1, display: 'flex', justifyContent: 'flex-start' }}>
                <Title className="text-xl dark:text-white" style={{ color: '#EF4444', fontWeight: 700, margin: 0 }}>
                  SHORT : {shorts.length}
                </Title>
              </div>
            </div>
            {/* Net Long/Short Percentage */}
            <div style={{ textAlign: 'center', marginTop: '8px' }}>
              {netLongShortPercentage >= 0 ? (
                <Text className="text-sm dark:text-white" style={{ fontWeight: 600 }}>
                  {netLongShortPercentage.toFixed(1)}% NET <span style={{ color: '#10B981' }}>LONG</span>
                </Text>
              ) : (
                <Text className="text-sm dark:text-white" style={{ fontWeight: 600 }}>
                  {Math.abs(netLongShortPercentage).toFixed(1)}% NET <span style={{ color: '#EF4444' }}>SHORT</span>
                </Text>
              )}
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '24px' }}>
            {/* Longs Section */}
            <Card className="dark:bg-gray-800 rounded-lg" style={{ padding: 0 }}>
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
            
            {/* Longs Pie Chart */}
            {longsAssetAllocation.length > 0 ? (
              <div style={{ marginBottom: '24px', padding: '0 16px' }}>
                <ResponsiveContainer width="100%" height={250}>
                  <PieChart>
                    <Legend 
                      payload={generateLegendPayload(longsAssetAllocation, highlightedLongsAssetClasses, toggleLongsAssetClass)}
                      layout="vertical"
                      verticalAlign="middle"
                      align="left"
                      wrapperStyle={{ 
                        fontSize: '16px',
                        paddingLeft: '10px',
                        width: '240px'
                      }}
                      iconSize={16}
                      formatter={(value, entry) => {
                        const isHighlighted = highlightedLongsAssetClasses.has(value);
                        return (
                          <span 
                            onClick={() => toggleLongsAssetClass(value)}
                            style={{ 
                              fontSize: '16px',
                              fontWeight: isHighlighted ? 'bold' : 'normal',
                              opacity: isHighlighted ? 1 : 0.5,
                              cursor: 'pointer',
                              transition: 'all 0.2s ease'
                            }}
                          >
                            {value}
                          </span>
                        );
                      }}
                      content={(props) => {
                        const { payload } = props;
                        return (
                          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                            {payload.map((entry, index) => {
                              const isHighlighted = highlightedLongsAssetClasses.has(entry.value);
                              return (
                                <li
                                  key={`item-${index}`}
                                  onClick={() => toggleLongsAssetClass(entry.value)}
                                  style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    marginBottom: '8px',
                                    cursor: 'pointer',
                                    fontWeight: isHighlighted ? 'bold' : 'normal',
                                    opacity: isHighlighted ? 1 : 0.5,
                                    transition: 'all 0.2s ease'
                                  }}
                                >
                                  <span
                                    style={{
                                      display: 'inline-block',
                                      width: '16px',
                                      height: '16px',
                                      backgroundColor: entry.color,
                                      marginRight: '8px',
                                      borderRadius: '2px'
                                    }}
                                  />
                                  <span style={{ fontSize: '16px' }}>{entry.value}</span>
                                </li>
                              );
                            })}
                          </ul>
                        );
                      }}
                    />
                    {/* Base pie chart - all slices at normal size (filter out 0% slices) */}
                    <Pie
                      data={longsAssetAllocation.filter(entry => entry.value > 0 && typeof entry.value === 'number')}
                      cx="60%"
                      cy="50%"
                      labelLine={false}
                      label={renderBasePieLabelLongs}
                      outerRadius={96}
                      fill="#8884d8"
                      dataKey="value"
                    >
                      {longsAssetAllocation
                        .filter(entry => entry.value > 0 && typeof entry.value === 'number')
                        .map((entry, index) => {
                          const baseColor = ASSET_CLASS_COLORS[entry.name] || ASSET_CLASS_COLORS['Equities'];
                          return (
                            <Cell
                              key={`cell-${index}`}
                              fill={baseColor}
                              style={{
                                opacity: 0.6
                              }}
                            />
                          );
                        })}
                    </Pie>
                    {/* Highlighted slices - rendered on top with larger radius and enhanced styling */}
                    {highlightedLongsAssetClasses.size > 0 && (
                      <Pie
                        data={longsAssetAllocation.filter(entry => entry.value > 0 && typeof entry.value === 'number')}
                        cx="60%"
                        cy="50%"
                        labelLine={false}
                        label={renderHighlightedPieLabelLongs}
                        outerRadius={longsHighlightRadius}
                        fill="#8884d8"
                        dataKey="value"
                        isAnimationActive={false}
                      >
                        {longsAssetAllocation
                          .filter(entry => entry.value > 0 && typeof entry.value === 'number')
                          .map((entry, index) => {
                            const isHighlighted = highlightedLongsAssetClasses.has(entry.name);
                            const baseColor = ASSET_CLASS_COLORS[entry.name] || ASSET_CLASS_COLORS['Equities'];
                            return (
                              <Cell
                                key={`cell-highlight-${index}`}
                                fill={baseColor}
                                style={{
                                  opacity: isHighlighted ? 1 : 0,
                                  filter: isHighlighted ? 'brightness(1.25) drop-shadow(0 0 6px rgba(0,0,0,0.4))' : 'none',
                                  transition: 'opacity 0.5s ease, filter 0.5s ease'
                                }}
                              />
                            );
                          })}
                      </Pie>
                    )}
                  </PieChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <Text className="text-sm text-gray-500 dark:text-gray-400">No long positions</Text>
            )}

            {/* Longs Data Table */}
            {longs.length > 0 && (
              <div style={{ overflowX: 'auto' }}>
                {/* Search Box */}
                <div style={{ marginBottom: '8px' }}>
                  <input
                    type="text"
                    placeholder="Search ticker..."
                    value={longsSearchFilter}
                    onChange={(e) => setLongsSearchFilter(e.target.value)}
                    style={{
                      width: '100%',
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
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
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
                          backgroundColor: columnVisibility[col.key] ? '#3b82f6' : '#f3f4f6',
                          color: columnVisibility[col.key] ? '#ffffff' : '#6b7280',
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
                            e.target.style.backgroundColor = '#f3f4f6';
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
                              <span style={{ marginLeft: '10px' }}>{holding.symbol}</span>
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
          <Card className="dark:bg-gray-800" style={{ padding: 0 }}>
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

            {/* Shorts Pie Chart */}
            {shortsAssetAllocation.length > 0 ? (
              <div style={{ marginBottom: '24px', padding: '0 16px' }}>
                <ResponsiveContainer width="100%" height={250}>
                  <PieChart>
                    <Legend 
                      payload={generateLegendPayload(shortsAssetAllocation, highlightedShortsAssetClasses, toggleShortsAssetClass)}
                      layout="vertical"
                      verticalAlign="middle"
                      align="left"
                      wrapperStyle={{ 
                        fontSize: '16px',
                        paddingLeft: '10px',
                        width: '240px'
                      }}
                      iconSize={16}
                      formatter={(value, entry) => {
                        const isHighlighted = highlightedShortsAssetClasses.has(value);
                        return (
                          <span 
                            onClick={() => toggleShortsAssetClass(value)}
                            style={{ 
                              fontSize: '16px',
                              fontWeight: isHighlighted ? 'bold' : 'normal',
                              opacity: isHighlighted ? 1 : 0.5,
                              cursor: 'pointer',
                              transition: 'all 0.2s ease'
                            }}
                          >
                            {value}
                          </span>
                        );
                      }}
                      content={(props) => {
                        const { payload } = props;
                        return (
                          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                            {payload.map((entry, index) => {
                              const isHighlighted = highlightedShortsAssetClasses.has(entry.value);
                              return (
                                <li
                                  key={`item-${index}`}
                                  onClick={() => toggleShortsAssetClass(entry.value)}
                                  style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    marginBottom: '8px',
                                    cursor: 'pointer',
                                    fontWeight: isHighlighted ? 'bold' : 'normal',
                                    opacity: isHighlighted ? 1 : 0.5,
                                    transition: 'all 0.2s ease'
                                  }}
                                >
                                  <span
                                    style={{
                                      display: 'inline-block',
                                      width: '16px',
                                      height: '16px',
                                      backgroundColor: entry.color,
                                      marginRight: '8px',
                                      borderRadius: '2px'
                                    }}
                                  />
                                  <span style={{ fontSize: '16px' }}>{entry.value}</span>
                                </li>
                              );
                            })}
                          </ul>
                        );
                      }}
                    />
                    {/* Base pie chart - all slices at normal size (filter out 0% slices) */}
                    <Pie
                      data={shortsAssetAllocation.filter(entry => entry.value > 0 && typeof entry.value === 'number')}
                      cx="60%"
                      cy="50%"
                      labelLine={false}
                      label={renderBasePieLabelShorts}
                      outerRadius={96}
                      fill="#8884d8"
                      dataKey="value"
                    >
                      {shortsAssetAllocation
                        .filter(entry => entry.value > 0 && typeof entry.value === 'number')
                        .map((entry, index) => {
                          const baseColor = ASSET_CLASS_COLORS[entry.name] || ASSET_CLASS_COLORS['Equities'];
                          return (
                            <Cell
                              key={`cell-${index}`}
                              fill={baseColor}
                              style={{
                                opacity: 0.6
                              }}
                            />
                          );
                        })}
                    </Pie>
                    {/* Highlighted slices - rendered on top with larger radius and enhanced styling */}
                    {highlightedShortsAssetClasses.size > 0 && (
                      <Pie
                        data={shortsAssetAllocation.filter(entry => entry.value > 0 && typeof entry.value === 'number')}
                        cx="60%"
                        cy="50%"
                        labelLine={false}
                        label={renderHighlightedPieLabelShorts}
                        outerRadius={shortsHighlightRadius}
                        fill="#8884d8"
                        dataKey="value"
                        isAnimationActive={false}
                      >
                        {shortsAssetAllocation
                          .filter(entry => entry.value > 0 && typeof entry.value === 'number')
                          .map((entry, index) => {
                            const isHighlighted = highlightedShortsAssetClasses.has(entry.name);
                            const baseColor = ASSET_CLASS_COLORS[entry.name] || ASSET_CLASS_COLORS['Equities'];
                            return (
                              <Cell
                                key={`cell-highlight-${index}`}
                                fill={baseColor}
                                style={{
                                  opacity: isHighlighted ? 1 : 0,
                                  filter: isHighlighted ? 'brightness(1.25) drop-shadow(0 0 6px rgba(0,0,0,0.4))' : 'none',
                                  transition: 'opacity 0.5s ease, filter 0.5s ease'
                                }}
                              />
                            );
                          })}
                      </Pie>
                    )}
                  </PieChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <Text className="text-sm text-gray-500 dark:text-gray-400">No short positions</Text>
            )}

            {/* Shorts Data Table */}
            {shorts.length > 0 && (
              <div style={{ overflowX: 'auto' }}>
                {/* Search Box */}
                <div style={{ marginBottom: '8px' }}>
                  <input
                    type="text"
                    placeholder="Search ticker..."
                    value={shortsSearchFilter}
                    onChange={(e) => setShortsSearchFilter(e.target.value)}
                    style={{
                      width: '100%',
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
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
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
                          backgroundColor: columnVisibility[col.key] ? '#3b82f6' : '#f3f4f6',
                          color: columnVisibility[col.key] ? '#ffffff' : '#6b7280',
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
                            e.target.style.backgroundColor = '#f3f4f6';
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
                              <span style={{ marginLeft: '10px' }}>{holding.symbol}</span>
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

        {/* Total Asset Allocation Section */}
        <div style={{ marginTop: '32px' }}>
          <Title className="text-lg mb-4 dark:text-white">Total Asset Allocation</Title>
          <Card className="dark:bg-gray-800 rounded-lg">
            {innerData.length > 0 && outerData.length > 0 ? (
              <ResponsiveContainer width="100%" height={400}>
                <PieChart>
                  {/* Asset Class Allocation */}
                  <Pie
                    data={innerData}
                    dataKey="value"
                    cx="50%"
                    cy="50%"
                    outerRadius={120}
                    fill="#8884d8"
                    label={renderCustomLabel}
                  >
                    {innerData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill="#9CA3AF" />
                    ))}
                  </Pie>
                  <Legend
                    wrapperStyle={{ paddingTop: '20px' }}
                    payload={innerData.map((entry) => ({
                      value: entry.name,
                      type: 'square',
                      color: '#9CA3AF',
                      id: entry.name
                    }))}
                  />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <Text className="text-sm text-gray-500 dark:text-gray-400 text-center py-8">
                No portfolio data available for factor exposure analysis
              </Text>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
};

export default PortfolioBreakdown;





