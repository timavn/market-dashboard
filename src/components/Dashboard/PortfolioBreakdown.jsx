import React, { useMemo, useState } from 'react';
import { Card, Title, Text } from '@tremor/react';
import { PieChart, Pie, Cell, ResponsiveContainer, Legend, Tooltip } from 'recharts';
import {
  separateLongsAndShorts,
  formatPerformance,
  getPerformanceColor,
  formatDate
} from '../../utils/portfolioBreakdownUtils';
import { SECURITY_CATEGORY_MAPPING } from '../../constants/securityCategoryMapping';

// Asset class colors - 5 core asset classes
const ASSET_CLASS_COLORS = {
  'Equities': '#10B981',      // Emerald green
  'Fixed Income': '#3B82F6',  // Blue
  'Commodities': '#F97316',   // Orange
  'FX': '#8B5CF6',            // Violet (includes Gold, USD, and other currencies)
  'Currencies': '#8B5CF6',    // Violet (alias for FX)
  'Cryptocurrency': '#F59E0B', // Amber
  'Other': '#9CA3AF',         // Gray
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
 */
const getAssetClassForTicker = (ticker) => {
  const mapping = SECURITY_CATEGORY_MAPPING[ticker?.toUpperCase()];
  if (mapping) {
    const category = mapping.category;
    return CATEGORY_DISPLAY_NAMES[category] || category;
  }
  return 'Other';
};

/**
 * Calculate asset class allocation using securities universe mapping
 */
const calculateAssetClassAllocationFromUniverse = (holdings) => {
  if (!holdings || holdings.length === 0) return [];

  const allocation = {};
  let totalValue = 0;

  holdings.forEach(holding => {
    const marketValue = Math.abs(parseFloat(holding.marketValue) || 0);
    const assetClass = getAssetClassForTicker(holding.symbol);
    
    if (!allocation[assetClass]) {
      allocation[assetClass] = 0;
    }
    allocation[assetClass] += marketValue;
    totalValue += marketValue;
  });

  // Convert to percentage
  return Object.entries(allocation)
    .map(([name, value]) => ({
      name,
      value: totalValue > 0 ? parseFloat(((value / totalValue) * 100).toFixed(2)) : 0,
      rawValue: value
    }))
    .filter(item => item.value > 0)
    .sort((a, b) => b.value - a.value);
};

const PortfolioBreakdown = ({ portfolioData }) => {
  const holdings = portfolioData?.holdings || [];
  const totalValue = portfolioData?.summary?.totalValue || 0;
  const factorExposures = portfolioData?.factorExposures || {};

  // Sorting state for longs and shorts tables
  const [longsSortConfig, setLongsSortConfig] = useState({ field: null, direction: 'desc' });
  const [shortsSortConfig, setShortsSortConfig] = useState({ field: null, direction: 'desc' });

  // Search filters for tickers
  const [longsSearchFilter, setLongsSearchFilter] = useState('');
  const [shortsSearchFilter, setShortsSearchFilter] = useState('');

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
      return <span style={{ marginLeft: '4px', opacity: 0.3 }}>⇅</span>;
    }
    return (
      <span style={{ marginLeft: '4px' }}>
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

  // Early return after all hooks
  if (!portfolioData) {
    return (
      <div style={{ padding: '32px', textAlign: 'center' }}>
        <Text className="text-gray-500 dark:text-gray-400">
          No portfolio data available. Please upload a Schwab CSV to view portfolio breakdown.
        </Text>
      </div>
    );
  }

  // Custom label for pie charts - positioned outside the pie with better alignment
  const renderCustomLabel = ({ cx, cy, midAngle, innerRadius, outerRadius, percent, name }) => {
    const RADIAN = Math.PI / 180;

    if (percent < 0.05) return null; // Don't show labels for slices < 5%

    // Position label outside the pie chart
    const radius = outerRadius + 25;
    const x = cx + radius * Math.cos(-midAngle * RADIAN);
    const y = cy + radius * Math.sin(-midAngle * RADIAN);

    // Determine text anchor based on position
    const textAnchor = x > cx ? 'start' : 'end';

    return (
      <text
        x={x}
        y={y}
        fill="#000080"
        textAnchor={textAnchor}
        dominantBaseline="central"
        fontSize={11}
        fontWeight="600"
      >
        {`${(percent * 100).toFixed(1)}%`}
      </text>
    );
  };

  // Render performance cell with color coding
  const renderPerformanceCell = (value) => {
    const formatted = formatPerformance(value);
    const color = getPerformanceColor(value);
    const bgColor = color === 'emerald' ? '#D1FAE5' : color === 'red' ? '#FEE2E2' : '#F3F4F6';
    const textColor = color === 'emerald' ? '#065F46' : color === 'red' ? '#991B1B' : '#374151';

    return (
      <td
        style={{
          padding: '8px',
          textAlign: 'right',
          backgroundColor: bgColor,
          color: textColor,
          fontWeight: '500'
        }}
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
          <div className="text-gray-600 dark:text-gray-400 p-1.5 bg-blue-50 dark:bg-blue-900/10 rounded border border-blue-200 dark:border-blue-700">
            <div className="font-medium text-blue-700 dark:text-blue-400" style={{ marginBottom: '2px' }}>Top 5 Factors:</div>
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
      <div style={{ flex: 1, overflowY: 'auto', padding: '0 16px 16px 16px' }}>
        {/* Longs/Shorts Breakdown Section */}
        <div style={{ marginBottom: '32px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px', marginBottom: '24px' }}>
            {/* Longs Section */}
            <Card className="dark:bg-gray-800">
              <Title className="text-xl mb-2 dark:text-white" style={{ color: '#10B981', fontWeight: 700 }}>
                Long : {longs.length}
              </Title>
            
            {/* Longs Pie Chart */}
            {longsAssetAllocation.length > 0 ? (
              <div style={{ marginBottom: '24px' }}>
                <ResponsiveContainer width="100%" height={250}>
                  <PieChart>
                    <Pie
                      data={longsAssetAllocation}
                      cx="50%"
                      cy="50%"
                      labelLine={false}
                      label={renderCustomLabel}
                      outerRadius={80}
                      fill="#8884d8"
                      dataKey="value"
                    >
                      {longsAssetAllocation.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={ASSET_CLASS_COLORS[entry.name] || ASSET_CLASS_COLORS['Other']} />
                      ))}
                    </Pie>
                    <Tooltip
                      formatter={(value, name) => [`${value.toFixed(2)}%`, name]}
                      contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', borderRadius: '4px' }}
                    />
                    <Legend />
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
                      outline: 'none'
                    }}
                    className="dark:bg-gray-700 dark:border-gray-600 dark:text-white"
                  />
                </div>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px' }}>
                  <thead>
                    <tr style={{ borderBottom: '2px solid #e5e7eb' }} className="dark:border-gray-700">
                      <th
                        style={{ padding: '6px', textAlign: 'left', fontWeight: 600, cursor: 'pointer', userSelect: 'none' }}
                        className="dark:text-white"
                        onClick={() => handleSort('ticker', true)}
                      >
                        Ticker{renderSortIndicator('ticker', longsSortConfig)}
                      </th>
                      <th style={{ padding: '6px', textAlign: 'right', fontWeight: 600 }} className="dark:text-white">Qty</th>
                      <th style={{ padding: '6px', textAlign: 'right', fontWeight: 600 }} className="dark:text-white">Price</th>
                      <th
                        style={{ padding: '6px', textAlign: 'right', fontWeight: 600, cursor: 'pointer', userSelect: 'none' }}
                        className="dark:text-white"
                        onClick={() => handleSort('marketValue', true)}
                      >
                        Mkt Value{renderSortIndicator('marketValue', longsSortConfig)}
                      </th>
                      <th
                        style={{ padding: '6px', textAlign: 'right', fontWeight: 600, cursor: 'pointer', userSelect: 'none' }}
                        className="dark:text-white"
                        onClick={() => handleSort('pctAccount', true)}
                      >
                        % Acct{renderSortIndicator('pctAccount', longsSortConfig)}
                      </th>
                      <th
                        style={{ padding: '6px', textAlign: 'right', fontWeight: 600, cursor: 'pointer', userSelect: 'none' }}
                        className="dark:text-white"
                        onClick={() => handleSort('intradayGainLoss', true)}
                      >
                        Intraday G/L{renderSortIndicator('intradayGainLoss', longsSortConfig)}
                      </th>
                      <th
                        style={{ padding: '6px', textAlign: 'right', fontWeight: 600, cursor: 'pointer', userSelect: 'none' }}
                        className="dark:text-white"
                        onClick={() => handleSort('gainLoss', true)}
                      >
                        Total G/L{renderSortIndicator('gainLoss', longsSortConfig)}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedLongs.map((holding, index) => {
                      const assetClass = getAssetClassForTicker(holding.symbol);
                      const bgColor = ASSET_CLASS_COLORS[assetClass] || ASSET_CLASS_COLORS['Other'];
                      const pctOfAccount = totalValue > 0 ? ((Math.abs(holding.marketValue) / totalValue) * 100).toFixed(2) : '0.00';

                      return (
                        <tr
                          key={index}
                          style={{
                            borderBottom: '1px solid #e5e7eb',
                            backgroundColor: `${bgColor}15`
                          }}
                          className="dark:border-gray-700"
                        >
                          <td style={{ padding: '6px', fontWeight: '600' }} className="dark:text-white">{holding.symbol}</td>
                          <td style={{ padding: '6px', textAlign: 'right' }} className="dark:text-gray-300">{Math.abs(holding.quantity || 0)}</td>
                          <td style={{ padding: '6px', textAlign: 'right' }} className="dark:text-gray-300">${parseFloat(holding.price || 0).toFixed(2)}</td>
                          <td style={{ padding: '6px', textAlign: 'right' }} className="dark:text-gray-300">${Math.abs(holding.marketValue || 0).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}</td>
                          <td style={{ padding: '6px', textAlign: 'right' }} className="dark:text-gray-300">{pctOfAccount}%</td>
                          {renderPerformanceCell(holding.dayChangePercent)}
                          {renderPerformanceCell(holding.gainLossPercent)}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {/* Shorts Section */}
          <Card className="dark:bg-gray-800">
            <Title className="text-xl mb-2 dark:text-white" style={{ color: '#EF4444', fontWeight: 700 }}>
              Short : {shorts.length}
            </Title>

            {/* Shorts Pie Chart */}
            {shortsAssetAllocation.length > 0 ? (
              <div style={{ marginBottom: '24px' }}>
                <ResponsiveContainer width="100%" height={250}>
                  <PieChart>
                    <Pie
                      data={shortsAssetAllocation}
                      cx="50%"
                      cy="50%"
                      labelLine={false}
                      label={renderCustomLabel}
                      outerRadius={80}
                      fill="#8884d8"
                      dataKey="value"
                    >
                      {shortsAssetAllocation.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={ASSET_CLASS_COLORS[entry.name] || ASSET_CLASS_COLORS['Other']} />
                      ))}
                    </Pie>
                    <Tooltip
                      formatter={(value, name) => [`${value.toFixed(2)}%`, name]}
                      contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', borderRadius: '4px' }}
                    />
                    <Legend />
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
                      outline: 'none'
                    }}
                    className="dark:bg-gray-700 dark:border-gray-600 dark:text-white"
                  />
                </div>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px' }}>
                  <thead>
                    <tr style={{ borderBottom: '2px solid #e5e7eb' }} className="dark:border-gray-700">
                      <th
                        style={{ padding: '6px', textAlign: 'left', fontWeight: 600, cursor: 'pointer', userSelect: 'none' }}
                        className="dark:text-white"
                        onClick={() => handleSort('ticker', false)}
                      >
                        Ticker{renderSortIndicator('ticker', shortsSortConfig)}
                      </th>
                      <th style={{ padding: '6px', textAlign: 'right', fontWeight: 600 }} className="dark:text-white">Qty</th>
                      <th style={{ padding: '6px', textAlign: 'right', fontWeight: 600 }} className="dark:text-white">Price</th>
                      <th
                        style={{ padding: '6px', textAlign: 'right', fontWeight: 600, cursor: 'pointer', userSelect: 'none' }}
                        className="dark:text-white"
                        onClick={() => handleSort('marketValue', false)}
                      >
                        Mkt Value{renderSortIndicator('marketValue', shortsSortConfig)}
                      </th>
                      <th
                        style={{ padding: '6px', textAlign: 'right', fontWeight: 600, cursor: 'pointer', userSelect: 'none' }}
                        className="dark:text-white"
                        onClick={() => handleSort('pctAccount', false)}
                      >
                        % Acct{renderSortIndicator('pctAccount', shortsSortConfig)}
                      </th>
                      <th
                        style={{ padding: '6px', textAlign: 'right', fontWeight: 600, cursor: 'pointer', userSelect: 'none' }}
                        className="dark:text-white"
                        onClick={() => handleSort('intradayGainLoss', false)}
                      >
                        Intraday G/L{renderSortIndicator('intradayGainLoss', shortsSortConfig)}
                      </th>
                      <th
                        style={{ padding: '6px', textAlign: 'right', fontWeight: 600, cursor: 'pointer', userSelect: 'none' }}
                        className="dark:text-white"
                        onClick={() => handleSort('gainLoss', false)}
                      >
                        Total G/L{renderSortIndicator('gainLoss', shortsSortConfig)}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedShorts.map((holding, index) => {
                      const assetClass = getAssetClassForTicker(holding.symbol);
                      const bgColor = ASSET_CLASS_COLORS[assetClass] || ASSET_CLASS_COLORS['Other'];
                      const pctOfAccount = totalValue > 0 ? ((Math.abs(holding.marketValue) / totalValue) * 100).toFixed(2) : '0.00';

                      return (
                        <tr
                          key={index}
                          style={{
                            borderBottom: '1px solid #e5e7eb',
                            backgroundColor: `${bgColor}15`
                          }}
                          className="dark:border-gray-700"
                        >
                          <td style={{ padding: '6px', fontWeight: '600' }} className="dark:text-white">{holding.symbol}</td>
                          <td style={{ padding: '6px', textAlign: 'right' }} className="dark:text-gray-300">{Math.abs(holding.quantity || 0)}</td>
                          <td style={{ padding: '6px', textAlign: 'right' }} className="dark:text-gray-300">${parseFloat(holding.price || 0).toFixed(2)}</td>
                          <td style={{ padding: '6px', textAlign: 'right' }} className="dark:text-gray-300">${Math.abs(holding.marketValue || 0).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}</td>
                          <td style={{ padding: '6px', textAlign: 'right' }} className="dark:text-gray-300">{pctOfAccount}%</td>
                          {renderPerformanceCell(holding.dayChangePercent)}
                          {renderPerformanceCell(holding.gainLossPercent)}
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
          <Card className="dark:bg-gray-800">
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
                      <Cell key={`cell-${index}`} fill={ASSET_CLASS_COLORS[entry.name] || ASSET_CLASS_COLORS['Other']} />
                    ))}
                  </Pie>
                  <Tooltip
                    formatter={(value, name) => [`${value.toFixed(1)}%`, name]}
                    contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', borderRadius: '4px' }}
                  />
                  <Legend
                    wrapperStyle={{ paddingTop: '20px' }}
                    payload={innerData.map((entry) => ({
                      value: entry.name,
                      type: 'square',
                      color: ASSET_CLASS_COLORS[entry.name] || ASSET_CLASS_COLORS['Other']
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





