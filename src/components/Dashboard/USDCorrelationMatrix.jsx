import React from 'react';
import { Card, Title, Text, Table, TableHead, TableRow, TableHeaderCell, TableBody, TableCell, Badge } from '@tremor/react';
import { USD_METRICS, CORRELATION_PERIODS } from '../../constants/usdMarket';
import { CorrelationHelpers } from '../../services/api/usdMarketService';

const USDCorrelationMatrix = ({ correlations, rollingStats, loading, error }) => {
  if (loading) {
    return (
      <Card className="rounded-lg">
        <Title className="mb-2">$USD Correlations</Title>
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
      <Card className="bg-red-50 border-red-200 dark:bg-red-900/20 dark:border-red-800 rounded-lg">
        <Title className="mb-2 dark:text-red-400">$USD Correlations</Title>
        <Text className="text-red-600 dark:text-red-400">Error loading correlation data: {error}</Text>
      </Card>
    );
  }

  if (!correlations || !rollingStats) {
    return (
      <Card className="rounded-lg">
        <Title className="mb-2">$USD Correlations</Title>
        <Text className="text-center py-8">No correlation data available</Text>
      </Card>
    );
  }

  const getCorrelationStyle = (correlation) => {
    if (correlation === null || correlation === undefined) {
      return { text: 'text-black', border: 'border-black' };
    }
    if (correlation >= 0.5) {
      return { text: 'text-green-500', border: 'border-green-500' };
    }
    if (correlation <= -0.5) {
      return { text: 'text-red-500', border: 'border-red-500' };
    }
    return { text: 'text-black', border: 'border-black' };
  };

  return (
    <Card>
      <Title className="mb-2">$USD Correlations</Title>
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
              const highStyle = getCorrelationStyle(metricRollingStats.high);
              const lowStyle = getCorrelationStyle(metricRollingStats.low);
              
              return (
                <TableRow key={metric.symbol}>
                  <TableCell>
                    <Text className="font-semibold text-xs">{metric.name}</Text>
                  </TableCell>
                  
                  {/* Correlation periods */}
                  {CORRELATION_PERIODS.map(period => {
                    const correlation = metricCorrelations[`${period}D`];
                    const displayValue = CorrelationHelpers.formatCorrelation(correlation);
                    const style = getCorrelationStyle(correlation);
                    
                    return (
                      <TableCell key={period}>
                        <div className={`inline-block px-1 py-0.5 border rounded ${style.border} ${style.text} text-xs`}>
                          {displayValue}
                        </div>
                      </TableCell>
                    );
                  })}
                  
                  {/* Rolling statistics */}
                  <TableCell>
                    <div className={`inline-block px-1 py-0.5 border rounded ${highStyle.border} ${highStyle.text} text-xs`}>
                      {metricRollingStats.high?.toFixed(3) || '--'}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className={`inline-block px-1 py-0.5 border rounded ${lowStyle.border} ${lowStyle.text} text-xs`}>
                      {metricRollingStats.low?.toFixed(3) || '--'}
                    </div>
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
