import React from 'react';
import { Card, Title, Text, Table, TableHead, TableRow, TableHeaderCell, TableBody, TableCell, Badge } from '@tremor/react';
import { USD_METRICS, CORRELATION_PERIODS } from '../../constants/usdMarket';
import { CorrelationHelpers } from '../../services/api/usdMarketService';

const USDCorrelationMatrix = ({ correlations, rollingStats, loading, error }) => {
  if (loading) {
    return (
      <Card>
        <Title className="mb-2">Key $USD Correlations</Title>
        <Text className="text-xs text-gray-500 mb-4">*Days = Trading Days*</Text>
        <div className="text-center py-8">
          <div className="animate-spin rounded-full h-8 w-8 border-2 border-blue-500 border-t-transparent mx-auto mb-2"></div>
          <Text>Loading correlation data...</Text>
        </div>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className="bg-red-50 border-red-200">
        <Title className="mb-2">Key $USD Correlations</Title>
        <Text className="text-red-600">Error loading correlation data: {error}</Text>
      </Card>
    );
  }

  if (!correlations || !rollingStats) {
    return (
      <Card>
        <Title className="mb-2">Key $USD Correlations</Title>
        <Text className="text-center py-8">No correlation data available</Text>
      </Card>
    );
  }

  const getCorrelationBadgeColor = (correlation) => {
    if (correlation === null || correlation === undefined) return 'gray';
    if (correlation >= 0.5) return 'emerald';
    if (correlation >= 0.2) return 'blue';
    if (correlation >= -0.2) return 'amber';
    if (correlation >= -0.5) return 'orange';
    return 'red';
  };

  return (
    <Card>
      <Title className="mb-2">Key $USD Correlations</Title>
      <Text className="text-xs text-gray-500 mb-4">*Days = Trading Days*</Text>
      
      <div className="overflow-x-auto">
        <Table>
          <TableHead>
            <TableRow>
              <TableHeaderCell>Metric</TableHeaderCell>
              {CORRELATION_PERIODS.map(period => (
                <TableHeaderCell key={period}>{period}D</TableHeaderCell>
              ))}
              <TableHeaderCell colSpan={4}>52-Wk Rolling 30D Correlation</TableHeaderCell>
            </TableRow>
            <TableRow>
              <TableHeaderCell></TableHeaderCell>
              {CORRELATION_PERIODS.map(period => (
                <TableHeaderCell key={period}></TableHeaderCell>
              ))}
              <TableHeaderCell>High</TableHeaderCell>
              <TableHeaderCell>Low</TableHeaderCell>
              <TableHeaderCell>% Time Pos</TableHeaderCell>
              <TableHeaderCell>% Time Neg</TableHeaderCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {USD_METRICS.map(metric => {
              const metricCorrelations = correlations[metric.symbol] || {};
              const metricRollingStats = rollingStats[metric.symbol] || {};
              
              return (
                <TableRow key={metric.symbol}>
                  <TableCell>
                    <Text className="font-semibold text-xs">{metric.name}</Text>
                  </TableCell>
                  
                  {/* Correlation periods */}
                  {CORRELATION_PERIODS.map(period => {
                    const correlation = metricCorrelations[`${period}D`];
                    const displayValue = CorrelationHelpers.formatCorrelation(correlation);
                    
                    return (
                      <TableCell key={period}>
                        <Badge color={getCorrelationBadgeColor(correlation)} size="xs">
                          {displayValue}
                        </Badge>
                      </TableCell>
                    );
                  })}
                  
                  {/* Rolling statistics */}
                  <TableCell>
                    <Text className="text-xs">{metricRollingStats.high?.toFixed(3) || '--'}</Text>
                  </TableCell>
                  <TableCell>
                    <Text className="text-xs">{metricRollingStats.low?.toFixed(3) || '--'}</Text>
                  </TableCell>
                  <TableCell>
                    <Badge color="emerald" size="xs">
                      {metricRollingStats.percentPositive?.toFixed(1) || '--'}%
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge color="red" size="xs">
                      {metricRollingStats.percentNegative?.toFixed(1) || '--'}%
                    </Badge>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </Card>
  );
};

export default USDCorrelationMatrix;
