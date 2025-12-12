import React, { useMemo } from 'react';
import { Card, Title, Text } from '@tremor/react';
import { PieChart, Pie, Cell, ResponsiveContainer, Legend, Tooltip } from 'recharts';
import {
  separateLongsAndShorts,
  calculateAssetClassAllocation,
  prepareDoublePieData,
  formatPerformance,
  getPerformanceColor,
  formatDate
} from '../../utils/portfolioBreakdownUtils';

const COLORS = {
  // Asset class colors
  'US Stock': '#3B82F6',
  'International Stock': '#10B981',
  'Bond': '#6366F1',
  'Currency': '#8B5CF6',
  'Commodity': '#F97316',
  'Other': '#6B7280',
  // Factor colors
  'Growth': '#10B981',
  'Value': '#3B82F6',
  'Quality': '#8B5CF6',
  'Momentum': '#F59E0B',
  'Low Volatility': '#6366F1'
};

const PortfolioBreakdown = ({ portfolioData }) => {
  const holdings = portfolioData?.holdings || [];
  const totalValue = portfolioData?.summary?.totalValue || 0;
  const factorExposures = portfolioData?.factorExposures || {};

  // Separate longs and shorts
  const { longs, shorts } = useMemo(() => {
    return separateLongsAndShorts(holdings);
  }, [holdings]);

  // Calculate asset class allocation for longs
  const longsAssetAllocation = useMemo(() => {
    const longsTotal = longs.reduce((sum, h) => sum + Math.abs(parseFloat(h.marketValue) || 0), 0);
    return calculateAssetClassAllocation(longs, longsTotal || totalValue);
  }, [longs, totalValue]);

  // Calculate asset class allocation for shorts
  const shortsAssetAllocation = useMemo(() => {
    const shortsTotal = shorts.reduce((sum, h) => sum + Math.abs(parseFloat(h.marketValue) || 0), 0);
    return calculateAssetClassAllocation(shorts, shortsTotal || totalValue);
  }, [shorts, totalValue]);

  // Prepare double pie chart data
  const { innerData, outerData } = useMemo(() => {
    return prepareDoublePieData(holdings, totalValue, factorExposures);
  }, [holdings, totalValue, factorExposures]);

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

  // Custom label for pie charts
  const renderCustomLabel = ({ cx, cy, midAngle, innerRadius, outerRadius, percent }) => {
    const RADIAN = Math.PI / 180;
    const radius = innerRadius + (outerRadius - innerRadius) * 0.5;
    const x = cx + radius * Math.cos(-midAngle * RADIAN);
    const y = cy + radius * Math.sin(-midAngle * RADIAN);

    if (percent < 0.05) return null; // Don't show labels for slices < 5%

    return (
      <text
        x={x}
        y={y}
        fill="white"
        textAnchor={x > cx ? 'start' : 'end'}
        dominantBaseline="central"
        fontSize={12}
        fontWeight="bold"
      >
        {`${(percent * 100).toFixed(0)}%`}
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
    <div style={{ padding: '16px', overflowY: 'auto', height: '100%' }}>
      {/* Longs/Shorts Breakdown Section */}
      <div style={{ marginBottom: '32px' }}>
        <Title className="text-lg mb-4 dark:text-white">What Is In Your Portfolio?</Title>
        
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px', marginBottom: '24px' }}>
          {/* Longs Section */}
          <Card className="dark:bg-gray-800">
            <Title className="text-xl mb-4 dark:text-white" style={{ color: '#3B82F6', fontWeight: 700 }}>
              Longs
            </Title>
            
            {/* Longs Pie Chart */}
            {longsAssetAllocation.length > 0 ? (
              <div style={{ marginBottom: '24px' }}>
                <Text className="text-sm mb-2 dark:text-gray-300">Longs By Asset Class</Text>
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
                        <Cell key={`cell-${index}`} fill={COLORS[entry.name] || COLORS['Other']} />
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
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                  <thead>
                    <tr style={{ borderBottom: '2px solid #e5e7eb' }} className="dark:border-gray-700">
                      <th style={{ padding: '8px', textAlign: 'left', fontWeight: 600 }} className="dark:text-white">Ticker</th>
                      <th style={{ padding: '8px', textAlign: 'left', fontWeight: 600 }} className="dark:text-white">Date Added</th>
                      <th style={{ padding: '8px', textAlign: 'left', fontWeight: 600 }} className="dark:text-white">Asset Class</th>
                      <th style={{ padding: '8px', textAlign: 'right', fontWeight: 600 }} className="dark:text-white">1D</th>
                      <th style={{ padding: '8px', textAlign: 'right', fontWeight: 600 }} className="dark:text-white">1 Week</th>
                      <th style={{ padding: '8px', textAlign: 'right', fontWeight: 600 }} className="dark:text-white">1 Month</th>
                      <th style={{ padding: '8px', textAlign: 'right', fontWeight: 600 }} className="dark:text-white">3 Month</th>
                      <th style={{ padding: '8px', textAlign: 'right', fontWeight: 600 }} className="dark:text-white">Inception</th>
                    </tr>
                  </thead>
                  <tbody>
                    {longs.map((holding, index) => {
                      const assetClass = holding.assetClass || holding.assetType || 'Other';
                      const mappedAssetClass = assetClass.includes('Equity') || assetClass.includes('Stock') 
                        ? (assetClass.includes('International') ? 'International Stock' : 'US Stock')
                        : assetClass.includes('Bond') || assetClass.includes('Fixed Income') ? 'Bond'
                        : assetClass.includes('Currency') || assetClass.includes('FX') ? 'Currency'
                        : assetClass.includes('Commodity') ? 'Commodity'
                        : 'Other';
                      
                      return (
                        <tr
                          key={index}
                          style={{
                            borderBottom: '1px solid #e5e7eb',
                            backgroundColor: index % 2 === 0 ? 'transparent' : '#f9fafb'
                          }}
                          className="dark:border-gray-700 dark:bg-gray-800"
                        >
                          <td style={{ padding: '8px', fontWeight: '600' }} className="dark:text-white">{holding.symbol}</td>
                          <td style={{ padding: '8px' }} className="dark:text-gray-300">{formatDate(portfolioData?.lastUpdated)}</td>
                          <td style={{ padding: '8px' }} className="dark:text-gray-300">{mappedAssetClass}</td>
                          {renderPerformanceCell(holding.gainLossPercent)}
                          {renderPerformanceCell(holding.gainLossPercent)}
                          {renderPerformanceCell(holding.gainLossPercent)}
                          {renderPerformanceCell(holding.gainLossPercent)}
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
            <Title className="text-xl mb-4 dark:text-white" style={{ color: '#3B82F6', fontWeight: 700 }}>
              Shorts
            </Title>
            
            {/* Shorts Pie Chart */}
            {shortsAssetAllocation.length > 0 ? (
              <div style={{ marginBottom: '24px' }}>
                <Text className="text-sm mb-2 dark:text-gray-300">Shorts By Asset Class</Text>
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
                        <Cell key={`cell-${index}`} fill={COLORS[entry.name] || COLORS['Other']} />
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
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                  <thead>
                    <tr style={{ borderBottom: '2px solid #e5e7eb' }} className="dark:border-gray-700">
                      <th style={{ padding: '8px', textAlign: 'left', fontWeight: 600 }} className="dark:text-white">Ticker</th>
                      <th style={{ padding: '8px', textAlign: 'left', fontWeight: 600 }} className="dark:text-white">Date Added</th>
                      <th style={{ padding: '8px', textAlign: 'left', fontWeight: 600 }} className="dark:text-white">Asset Class</th>
                      <th style={{ padding: '8px', textAlign: 'right', fontWeight: 600 }} className="dark:text-white">1D</th>
                      <th style={{ padding: '8px', textAlign: 'right', fontWeight: 600 }} className="dark:text-white">1 Week</th>
                      <th style={{ padding: '8px', textAlign: 'right', fontWeight: 600 }} className="dark:text-white">1 Month</th>
                      <th style={{ padding: '8px', textAlign: 'right', fontWeight: 600 }} className="dark:text-white">3 Month</th>
                      <th style={{ padding: '8px', textAlign: 'right', fontWeight: 600 }} className="dark:text-white">Inception</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shorts.map((holding, index) => {
                      const assetClass = holding.assetClass || holding.assetType || 'Other';
                      const mappedAssetClass = assetClass.includes('Equity') || assetClass.includes('Stock') 
                        ? (assetClass.includes('International') ? 'International Stock' : 'US Stock')
                        : assetClass.includes('Bond') || assetClass.includes('Fixed Income') ? 'Bond'
                        : assetClass.includes('Currency') || assetClass.includes('FX') ? 'Currency'
                        : assetClass.includes('Commodity') ? 'Commodity'
                        : 'Other';
                      
                      return (
                        <tr
                          key={index}
                          style={{
                            borderBottom: '1px solid #e5e7eb',
                            backgroundColor: index % 2 === 0 ? 'transparent' : '#f9fafb'
                          }}
                          className="dark:border-gray-700 dark:bg-gray-800"
                        >
                          <td style={{ padding: '8px', fontWeight: '600' }} className="dark:text-white">{holding.symbol}</td>
                          <td style={{ padding: '8px' }} className="dark:text-gray-300">{formatDate(portfolioData?.lastUpdated)}</td>
                          <td style={{ padding: '8px' }} className="dark:text-gray-300">{mappedAssetClass}</td>
                          {renderPerformanceCell(holding.gainLossPercent)}
                          {renderPerformanceCell(holding.gainLossPercent)}
                          {renderPerformanceCell(holding.gainLossPercent)}
                          {renderPerformanceCell(holding.gainLossPercent)}
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

      {/* Double Pie Chart Section */}
      <div style={{ marginTop: '32px' }}>
        <Title className="text-lg mb-4 dark:text-white">Portfolio Factor Exposure</Title>
        <Card className="dark:bg-gray-800">
          {innerData.length > 0 && outerData.length > 0 ? (
            <ResponsiveContainer width="100%" height={400}>
              <PieChart>
                {/* Outer ring - Factor Exposure */}
                <Pie
                  data={outerData}
                  dataKey="value"
                  cx="50%"
                  cy="50%"
                  outerRadius={120}
                  fill="#8884d8"
                  label={renderCustomLabel}
                >
                  {outerData.map((entry, index) => (
                    <Cell key={`outer-${index}`} fill={COLORS[entry.name] || COLORS['Growth']} />
                  ))}
                </Pie>
                {/* Inner ring - Asset Classes */}
                <Pie
                  data={innerData}
                  dataKey="value"
                  cx="50%"
                  cy="50%"
                  innerRadius={60}
                  outerRadius={100}
                  fill="#82ca9d"
                  label={renderCustomLabel}
                >
                  {innerData.map((entry, index) => (
                    <Cell key={`inner-${index}`} fill={COLORS[entry.name] || COLORS['Other']} />
                  ))}
                </Pie>
                <Tooltip
                  formatter={(value, name) => [`$${value.toFixed(2)}`, name]}
                  contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', borderRadius: '4px' }}
                />
                <Legend
                  wrapperStyle={{ paddingTop: '20px' }}
                  payload={[
                    ...innerData.map((entry, index) => ({
                      value: `Asset: ${entry.name}`,
                      type: 'square',
                      color: COLORS[entry.name] || COLORS['Other']
                    })),
                    ...outerData.map((entry, index) => ({
                      value: `Factor: ${entry.name}`,
                      type: 'square',
                      color: COLORS[entry.name] || COLORS['Growth']
                    }))
                  ]}
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
  );
};

export default PortfolioBreakdown;

