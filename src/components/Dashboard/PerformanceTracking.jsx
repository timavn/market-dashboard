import React, { useState, useEffect, useMemo } from 'react';
import { Card, Title, Text, Metric, Grid, Select, SelectItem, Badge } from '@tremor/react';
import {
  LineChart,
  Line,
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  ComposedChart
} from 'recharts';
import PerformanceService from '../../services/api/performanceService';
import { useTheme } from '../../context/ThemeContext';
import SecurityDetailModal from './SecurityDetailModal';

const PerformanceTracking = () => {
  const { theme } = useTheme();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedPeriod, setSelectedPeriod] = useState('all');
  const [equityCurve, setEquityCurve] = useState(null);
  const [metrics, setMetrics] = useState(null);
  const [benchmarkData, setBenchmarkData] = useState(null);
  const [performanceHistory, setPerformanceHistory] = useState(null);
  const [statements, setStatements] = useState([]);
  const [selectedStatementDate, setSelectedStatementDate] = useState(null);
  const [selectedStatement, setSelectedStatement] = useState(null);
  const [loadingStatement, setLoadingStatement] = useState(false);
  const [selectedSecurity, setSelectedSecurity] = useState(null);
  const [isModalOpen, setIsModalOpen] = useState(false);

  const isDark = theme === 'dark';

  const handleSecurityClick = (symbol) => {
    if (symbol) {
      setSelectedSecurity(symbol);
      setIsModalOpen(true);
    }
  };

  // Fetch all performance data
  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoading(true);
        setError(null);

        const [equityData, metricsData, historyData, benchmarkData, statementsData] = await Promise.all([
          PerformanceService.getEquityCurve(),
          PerformanceService.getPerformanceMetrics(selectedPeriod),
          PerformanceService.getPerformanceHistory(),
          PerformanceService.getBenchmarkComparison(),
          PerformanceService.getStatements().catch(() => ({ statements: [], count: 0 })) // Don't fail if no statements
        ]);

        setEquityCurve(equityData);
        setMetrics(metricsData);
        setPerformanceHistory(historyData);
        setBenchmarkData(benchmarkData);
        setStatements(statementsData.statements || []);
      } catch (err) {
        console.error('Error fetching performance data:', err);
        // Provide more helpful error messages
        if (err.response?.status === 404) {
          setError('Performance tracking endpoints not found. Make sure the backend server is running on port 3001.');
        } else if (err.code === 'ECONNREFUSED' || err.message?.includes('Failed to fetch')) {
          setError('Cannot connect to backend server. Make sure the server is running on port 3001.');
        } else {
          setError(err.response?.data?.error || err.message || 'Failed to load performance data');
        }
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [selectedPeriod]);

  // Fetch statement when date is selected
  useEffect(() => {
    const fetchStatement = async () => {
      if (!selectedStatementDate) {
        setSelectedStatement(null);
        return;
      }

      try {
        setLoadingStatement(true);
        const statementData = await PerformanceService.getStatementByDate(selectedStatementDate);
        setSelectedStatement(statementData);
      } catch (err) {
        console.error('Error fetching statement:', err);
        setSelectedStatement(null);
      } finally {
        setLoadingStatement(false);
      }
    };

    fetchStatement();
  }, [selectedStatementDate]);

  // Format date for display
  const formatDate = (dateStr) => {
    const date = new Date(dateStr);
    return `${date.getMonth() + 1}/${date.getDate()}`;
  };

  // Format currency
  const formatCurrency = (value) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0
    }).format(value);
  };

  // Format percentage
  const formatPercent = (value) => {
    return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
  };

  // Get color class based on value
  // Light blue: -0.99 to 0.99
  // Light green/red: 1.00 to 1.99 (or -1.00 to -1.99)
  // Dark green/red: >= 2.00 (or <= -2.00)
  const getValueColor = (value) => {
    if (value === null || value === undefined || isNaN(value)) {
      return '';
    }

    const absValue = Math.abs(value);

    if (absValue < 1.0) {
      // Light blue for -0.99 to 0.99
      return 'text-blue-400';
    } else if (absValue < 2.0) {
      // Light green/red for 1.00 to 1.99
      return value >= 0 ? 'text-green-400' : 'text-red-400';
    } else {
      // Dark green/red for >= 2.00
      return value >= 0 ? 'text-green-600' : 'text-red-600';
    }
  };

  // Prepare equity curve chart data
  const equityChartData = equityCurve?.dates.map((date, idx) => ({
    date: formatDate(date),
    value: equityCurve.values[idx],
    drawdown: equityCurve.drawdowns[idx],
    return: equityCurve.returns[idx]
  })) || [];

  // Prepare benchmark comparison chart data
  const benchmarkChartData = useMemo(() => {
    if (!benchmarkData || !benchmarkData.portfolio || !benchmarkData.benchmarks) {
      return [];
    }

    const portfolio = benchmarkData.portfolio;
    const benchmarks = benchmarkData.benchmarks;
    const dates = portfolio.map(p => p.date);

    return dates.map((date, idx) => {
      const data = {
        date: formatDate(date),
        Portfolio: portfolio[idx]?.return || 0
      };

      // Add benchmark returns
      Object.keys(benchmarks).forEach(benchmark => {
        const benchData = benchmarks[benchmark].find(b => b.date === date);
        data[benchmark] = benchData?.return || 0;
      });

      return data;
    });
  }, [benchmarkData]);

  // Prepare daily returns histogram data
  const returnsData = performanceHistory?.returns || [];
  const returnsHistogram = useMemo(() => {
    if (returnsData.length === 0) return [];

    const bins = [];
    const min = Math.min(...returnsData);
    const max = Math.max(...returnsData);
    const binSize = (max - min) / 20;

    for (let i = 0; i < 20; i++) {
      const binStart = min + i * binSize;
      const binEnd = binStart + binSize;
      const count = returnsData.filter(r => r >= binStart && r < binEnd).length;
      bins.push({
        range: `${binStart.toFixed(1)}%`,
        count: count
      });
    }

    return bins;
  }, [returnsData]);

  if (loading) {
    return (
      <div className="p-6">
        <Card className="rounded-lg">
          <Text>Loading performance data...</Text>
        </Card>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <Card className="rounded-lg">
          <Title>Performance Tracking</Title>
          <Text className="text-red-500 mt-4">Error: {error}</Text>
          <Text className="text-sm text-gray-600 dark:text-gray-400 mt-4">
            To get started with performance tracking:
          </Text>
          <ul className="list-disc list-inside text-sm text-gray-600 dark:text-gray-400 mt-2 space-y-1">
            <li>Make sure your backend server is running on port 3001</li>
            <li>Upload a Schwab CSV file with positions (filename should include date, e.g., portfolio_2025-01-15.csv)</li>
            <li>The CSV will be processed and performance metrics will be calculated automatically</li>
          </ul>
        </Card>
      </div>
    );
  }

  if (!equityCurve || equityCurve.dates.length === 0) {
    return (
      <div className="p-6">
        <Card className="rounded-lg">
          <Title>Performance Tracking</Title>
          <Text className="mt-4">
            No performance data available yet.
          </Text>
          <Text className="text-sm text-gray-600 dark:text-gray-400 mt-4">
            To get started:
          </Text>
          <ol className="list-decimal list-inside text-sm text-gray-600 dark:text-gray-400 mt-2 space-y-2">
            <li>Go to the Portfolio Metrics section (main dashboard)</li>
            <li>Upload a Schwab CSV file with your positions</li>
            <li>Make sure the filename includes a date (e.g., <code className="bg-gray-100 dark:bg-gray-700 px-1 rounded">portfolio_2025-01-15.csv</code>)</li>
            <li>The system will automatically process your positions and calculate performance metrics</li>
            <li>After processing, return here to view your performance tracking data</li>
          </ol>
          <Text className="text-xs text-gray-500 dark:text-gray-500 mt-4">
            Note: The CSV file should be exported from Schwab and contain your current positions with symbols, quantities, and market values.
          </Text>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-2 space-y-3" style={{ backgroundColor: isDark ? '#111827' : '#f9fafb', minHeight: '100vh' }}>
      {/* Header */}
      <div className="flex justify-between items-center">
        <Title className="text-base">Performance Tracking</Title>
        <Select
          value={selectedPeriod}
          onValueChange={setSelectedPeriod}
          className="w-32 scale-90 origin-right"
        >
          <SelectItem value="all">All Time</SelectItem>
          <SelectItem value="1y">1 Year</SelectItem>
          <SelectItem value="90d">90 Days</SelectItem>
          <SelectItem value="30d">30 Days</SelectItem>
        </Select>
      </div>

      {/* Key Metrics */}
      <Grid numItems={2} numItemsSm={4} numItemsLg={4} className="gap-2">
        <Card className="rounded-lg p-2">
          <Text className="text-xs">Sharpe Ratio</Text>
          <Metric className="text-lg">{metrics?.sharpeRatio?.toFixed(2) || 'N/A'}</Metric>
        </Card>
        <Card className="rounded-lg p-2">
          <Text className="text-xs">Max Drawdown</Text>
          <Metric className={`text-lg ${getValueColor(metrics?.maxDrawdown)}`}>
            {metrics?.maxDrawdown ? formatPercent(metrics.maxDrawdown) : 'N/A'}
          </Metric>
        </Card>
        <Card className="rounded-lg p-2">
          <Text className="text-xs">Volatility</Text>
          <Metric className="text-lg">{metrics?.volatility ? `${metrics.volatility.toFixed(2)}%` : 'N/A'}</Metric>
        </Card>
        <Card className="rounded-lg p-2">
          <Text className="text-xs">Win Rate</Text>
          <Metric className="text-lg">{metrics?.winRate ? `${metrics.winRate.toFixed(1)}%` : 'N/A'}</Metric>
        </Card>
      </Grid>

      {/* Additional Metrics */}
      <Grid numItems={2} numItemsSm={4} numItemsLg={4} className="gap-2">
        <Card className="rounded-lg p-2">
          <Text className="text-xs">Avg Daily Return</Text>
          <Metric className={`text-lg ${getValueColor(metrics?.avgDailyReturn)}`}>
            {metrics?.avgDailyReturn ? formatPercent(metrics.avgDailyReturn) : 'N/A'}
          </Metric>
        </Card>
        <Card className="rounded-lg p-2">
          <Text className="text-xs">Best Day</Text>
          <Metric className={`text-lg ${getValueColor(metrics?.bestDay)}`}>
            {metrics?.bestDay ? formatPercent(metrics.bestDay) : 'N/A'}
          </Metric>
        </Card>
        <Card className="rounded-lg p-2">
          <Text className="text-xs">Worst Day</Text>
          <Metric className={`text-lg ${getValueColor(metrics?.worstDay)}`}>
            {metrics?.worstDay ? formatPercent(metrics.worstDay) : 'N/A'}
          </Metric>
        </Card>
        <Card className="rounded-lg p-2">
          <Text className="text-xs">Current Value</Text>
          <Metric className="text-lg">
            {equityCurve?.values?.length > 0
              ? formatCurrency(equityCurve.values[equityCurve.values.length - 1])
              : 'N/A'}
          </Metric>
        </Card>
      </Grid>

      {/* Rolling Returns */}
      {metrics?.rollingReturns && Object.keys(metrics.rollingReturns).length > 0 && (
        <Card className="rounded-lg p-3">
          <Title className="text-sm">Rolling Returns</Title>
          <ResponsiveContainer width="100%" height={150}>
            <BarChart data={Object.entries(metrics.rollingReturns).map(([period, value]) => ({
              period: period.toUpperCase(),
              return: value
            }))}>
              <CartesianGrid strokeDasharray="3 3" stroke={isDark ? '#374151' : '#e5e7eb'} />
              <XAxis dataKey="period" stroke={isDark ? '#9ca3af' : '#6b7280'} tick={{ fontSize: 10 }} />
              <YAxis stroke={isDark ? '#9ca3af' : '#6b7280'} tick={{ fontSize: 10 }} />
              <Tooltip
                contentStyle={{
                  backgroundColor: isDark ? '#1f2937' : '#fff',
                  border: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`,
                  borderRadius: '6px',
                  fontSize: '10px'
                }}
                formatter={(value) => formatPercent(value)}
              />
              <Bar dataKey="return" fill="#3b82f6" />
            </BarChart>
          </ResponsiveContainer>
        </Card>
      )}

      {/* Equity Curve with Drawdown */}
      <Card className="p-3">
        <Title className="text-sm">Equity Curve</Title>
        <ResponsiveContainer width="100%" height={240}>
          <ComposedChart data={equityChartData}>
            <CartesianGrid strokeDasharray="3 3" stroke={isDark ? '#374151' : '#e5e7eb'} />
            <XAxis
              dataKey="date"
              stroke={isDark ? '#9ca3af' : '#6b7280'}
              tick={{ fontSize: 12 }}
              angle={-45}
              textAnchor="end"
              height={80}
            />
            <YAxis
              yAxisId="left"
              stroke={isDark ? '#9ca3af' : '#6b7280'}
              tick={{ fontSize: 12 }}
              tickFormatter={(value) => formatCurrency(value)}
            />
            <YAxis
              yAxisId="right"
              orientation="right"
              stroke={isDark ? '#9ca3af' : '#6b7280'}
              tick={{ fontSize: 12 }}
              tickFormatter={(value) => `${value.toFixed(1)}%`}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: isDark ? '#1f2937' : '#fff',
                border: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`,
                borderRadius: '6px'
              }}
              formatter={(value, name) => {
                if (name === 'value') return formatCurrency(value);
                if (name === 'drawdown') return `${value.toFixed(2)}%`;
                return value;
              }}
            />
            <Area
              yAxisId="right"
              type="monotone"
              dataKey="drawdown"
              fill="#ef4444"
              fillOpacity={0.2}
              stroke="#ef4444"
              strokeWidth={1}
            />
            <Line
              yAxisId="left"
              type="monotone"
              dataKey="value"
              stroke="#3b82f6"
              strokeWidth={2}
              dot={false}
            />
            <Legend />
          </ComposedChart>
        </ResponsiveContainer>
      </Card>

      {/* Performance vs Benchmarks */}
      {benchmarkChartData.length > 0 && (
        <Card className="rounded-lg p-3">
          <Title className="text-sm">Performance vs Benchmarks</Title>
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={benchmarkChartData}>
              <CartesianGrid strokeDasharray="3 3" stroke={isDark ? '#374151' : '#e5e7eb'} />
              <XAxis
                dataKey="date"
                stroke={isDark ? '#9ca3af' : '#6b7280'}
                tick={{ fontSize: 12 }}
                angle={-45}
                textAnchor="end"
                height={80}
              />
              <YAxis
                stroke={isDark ? '#9ca3af' : '#6b7280'}
                tick={{ fontSize: 12 }}
                tickFormatter={(value) => formatPercent(value)}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: isDark ? '#1f2937' : '#fff',
                  border: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`,
                  borderRadius: '6px'
                }}
                formatter={(value) => formatPercent(value)}
              />
              <Line
                type="monotone"
                dataKey="Portfolio"
                stroke="#3b82f6"
                strokeWidth={2}
                dot={false}
              />
              {benchmarkData?.benchmarks && Object.keys(benchmarkData.benchmarks).map((benchmark, idx) => {
                const colors = ['#10b981', '#f59e0b', '#8b5cf6', '#ef4444'];
                return (
                  <Line
                    key={benchmark}
                    type="monotone"
                    dataKey={benchmark}
                    stroke={colors[idx % colors.length]}
                    strokeWidth={2}
                    strokeDasharray="5 5"
                    dot={false}
                  />
                );
              })}
              <Legend />
            </LineChart>
          </ResponsiveContainer>
        </Card>
      )}

      {/* Daily Returns Distribution */}
      {returnsHistogram.length > 0 && (
        <Card className="rounded-lg p-3">
          <Title className="text-sm">Daily Returns Distribution</Title>
          <ResponsiveContainer width="100%" height={150}>
            <BarChart data={returnsHistogram}>
              <CartesianGrid strokeDasharray="3 3" stroke={isDark ? '#374151' : '#e5e7eb'} />
              <XAxis
                dataKey="range"
                stroke={isDark ? '#9ca3af' : '#6b7280'}
                tick={{ fontSize: 10 }}
                angle={-45}
                textAnchor="end"
                height={80}
              />
              <YAxis stroke={isDark ? '#9ca3af' : '#6b7280'} />
              <Tooltip
                contentStyle={{
                  backgroundColor: isDark ? '#1f2937' : '#fff',
                  border: `1px solid ${isDark ? '#374151' : '#e5e7eb'}`,
                  borderRadius: '6px'
                }}
              />
              <Bar dataKey="count" fill="#3b82f6" />
            </BarChart>
          </ResponsiveContainer>
        </Card>
      )}

      {/* Benchmark Comparison Table */}
      {metrics?.vsBenchmark && Object.keys(metrics.vsBenchmark).length > 0 && (
        <Card className="rounded-lg p-3">
          <Title className="text-sm">Benchmark Comparison</Title>
          <div className="overflow-x-auto mt-2">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b">
                  <th className="text-left p-1">Benchmark</th>
                  <th className="text-right p-1">Return</th>
                  <th className="text-right p-1">Alpha</th>
                  <th className="text-right p-1">Beta</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(metrics.vsBenchmark).map(([benchmark, data]) => (
                  <tr key={benchmark} className="border-b">
                    <td className="p-1">{benchmark}</td>
                    <td className={`text-right p-1 ${getValueColor(data.return || 0)}`}>
                      {formatPercent(data.return || 0)}
                    </td>
                    <td className={`text-right p-1 ${getValueColor(data.alpha || 0)}`}>
                      {formatPercent(data.alpha || 0)}
                    </td>
                    <td className="text-right p-1">{data.beta?.toFixed(2) || 'N/A'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Statement Archive */}
      {statements.length > 0 && (
        <Card className="rounded-lg p-3">
          <div className="flex justify-between items-center mb-2">
            <Title className="text-sm">Statement Archive</Title>
            <Select
              value={selectedStatementDate || ''}
              onValueChange={setSelectedStatementDate}
              className="w-40 scale-90 origin-right"
              placeholder="Select a date..."
            >
              {statements.map((stmt) => (
                <SelectItem key={stmt.date} value={stmt.date}>
                  {new Date(stmt.date).toLocaleDateString('en-US', {
                    year: 'numeric',
                    month: 'short',
                    day: 'numeric'
                  })} - {formatCurrency(stmt.totalValue)}
                </SelectItem>
              ))}
            </Select>
          </div>

          {loadingStatement && (
            <div className="text-center py-4">
              <Text>Loading statement...</Text>
            </div>
          )}

          {selectedStatement && !loadingStatement && (
            <div className="space-y-4">
              {/* Statement Summary */}
              <div>
                <Text className="text-sm font-semibold mb-2">
                  Statement for {new Date(selectedStatement.date).toLocaleDateString('en-US', {
                    year: 'numeric',
                    month: 'short',
                    day: 'numeric'
                  })}
                </Text>
                <Grid numItems={2} numItemsSm={4} numItemsLg={4} className="gap-2">
                  <Card className="rounded-lg p-2">
                    <Text className="text-xs">Total Value</Text>
                    <Metric className="text-lg">{formatCurrency(selectedStatement.summary?.totalValue || 0)}</Metric>
                  </Card>
                  <Card className="rounded-lg p-2">
                    <Text className="text-xs">Day Change</Text>
                    <Metric className={`text-lg ${getValueColor(parseFloat(selectedStatement.summary?.totalDayChangePercent || 0))}`}>
                      {formatCurrency(selectedStatement.summary?.totalDayChange || 0)} ({selectedStatement.summary?.totalDayChangePercent || '0.00'}%)
                    </Metric>
                  </Card>
                  <Card className="rounded-lg p-2">
                    <Text className="text-xs">Gain/Loss</Text>
                    <Metric className={`text-lg ${getValueColor(parseFloat(selectedStatement.summary?.totalGainLossPercent || 0))}`}>
                      {formatCurrency(selectedStatement.summary?.totalGainLoss || 0)} ({selectedStatement.summary?.totalGainLossPercent || '0.00'}%)
                    </Metric>
                  </Card>
                  <Card className="rounded-lg p-2">
                    <Text className="text-xs">Positions</Text>
                    <Metric className="text-lg">{selectedStatement.summary?.positionCount || 0}</Metric>
                  </Card>
                </Grid>
              </div>

              {/* Performance Metrics */}
              {selectedStatement.performance && (
                <Card className="rounded-lg p-2">
                  <Title className="mb-2 text-xs">Performance Metrics</Title>
                  <Grid numItems={3} className="gap-2">
                    <div>
                      <Text className="text-xs">Daily Return</Text>
                      <Metric className={`text-base ${getValueColor(selectedStatement.performance.dailyReturn)}`}>
                        {formatPercent(selectedStatement.performance.dailyReturn)}
                      </Metric>
                    </div>
                    <div>
                      <Text className="text-xs">Cumulative Return</Text>
                      <Metric className={`text-base ${getValueColor(selectedStatement.performance.cumulativeReturn)}`}>
                        {formatPercent(selectedStatement.performance.cumulativeReturn)}
                      </Metric>
                    </div>
                    <div>
                      <Text className="text-xs">Portfolio Value</Text>
                      <Metric className="text-base">{formatCurrency(selectedStatement.performance.totalValue)}</Metric>
                    </div>
                  </Grid>
                </Card>
              )}

              {/* Asset Allocation */}
              {selectedStatement.assetAllocation && Object.keys(selectedStatement.assetAllocation).length > 0 && (
                <Card className="rounded-lg p-2">
                  <Title className="mb-2 text-xs">Asset Allocation</Title>
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
                    {Object.entries(selectedStatement.assetAllocation).map(([asset, percent]) => (
                      <div key={asset}>
                        <Text className="text-xs">{asset}</Text>
                        <Metric className="text-base">{parseFloat(percent).toFixed(1)}%</Metric>
                      </div>
                    ))}
                  </div>
                </Card>
              )}

              {/* Holdings Table */}
              {selectedStatement.holdings && selectedStatement.holdings.length > 0 && (
                <Card className="rounded-lg p-2">
                  <Title className="mb-2 text-xs">Holdings</Title>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b">
                          <th className="text-left p-1">Symbol</th>
                          <th className="text-left p-1">Description</th>
                          <th className="text-right p-1">Quantity</th>
                          <th className="text-right p-1">Price</th>
                          <th className="text-right p-1">Market Value</th>
                          <th className="text-right p-1">Cost Basis</th>
                          <th className="text-right p-1">Gain/Loss</th>
                          <th className="text-right p-1">Gain/Loss %</th>
                        </tr>
                      </thead>
                      <tbody>
                        {selectedStatement.holdings.map((holding, idx) => (
                          <tr
                            key={`${holding.symbol}-${idx}`}
                            className="border-b hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer transition-colors"
                            onClick={() => handleSecurityClick(holding.symbol)}
                          >
                            <td className="p-1 font-medium text-blue-500 hover:text-blue-700">{holding.symbol}</td>
                            <td className="p-1 text-xs text-gray-600 dark:text-gray-400 truncate max-w-[150px]">{holding.description}</td>
                            <td className="text-right p-1">{holding.quantity?.toLocaleString() || '0'}</td>
                            <td className="text-right p-1">{formatCurrency(holding.price || 0)}</td>
                            <td className="text-right p-1">{formatCurrency(holding.marketValue || 0)}</td>
                            <td className="text-right p-1">{formatCurrency(holding.costBasis || 0)}</td>
                            <td className={`text-right p-1 ${getValueColor(holding.gainLossPercent || 0)}`}>
                              {formatCurrency(holding.gainLoss || 0)}
                            </td>
                            <td className={`text-right p-1 ${getValueColor(holding.gainLossPercent || 0)}`}>
                              {formatPercent(holding.gainLossPercent || 0)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>
              )}
            </div>
          )}

          {!selectedStatementDate && !loadingStatement && (
            <div className="text-center py-4 text-gray-500 dark:text-gray-400">
              <Text className="text-xs">Select a date from the dropdown above</Text>
            </div>
          )}
        </Card>
      )}

      {/* Security Detail Modal */}
      <SecurityDetailModal
        ticker={selectedSecurity}
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
      />
    </div >
  );
};

export default PerformanceTracking;
