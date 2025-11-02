import React from 'react';
import { Card, Table, TableHead, TableRow, TableHeaderCell, TableBody, TableCell, Badge, Text, Title } from '@tremor/react';
import { getSecuritiesWithPlaceholders } from '../../constants/securitiesList';

const SecuritiesList = () => {
  const securities = getSecuritiesWithPlaceholders();

  // Asset class color mapping - using standard readable colors
  const getAssetClassColor = (assetClass) => {
    const colors = {
      fixedIncome: 'blue',
      equity: 'emerald',
      currency: 'purple',
      commodity: 'amber',
      crypto: 'yellow'
    };
    return colors[assetClass] || 'gray';
  };

  const getAssetClassName = (assetClass) => {
    const names = {
      fixedIncome: 'Fixed Income',
      equity: 'Equity',
      currency: 'Currency',
      commodity: 'Commodity',
      crypto: 'Crypto'
    };
    return names[assetClass] || assetClass;
  };

  return (
    <Card className="max-h-[calc(100vh-120px)] overflow-y-auto">
      <Title className="mb-3">Securities</Title>
      
      {/* Asset Class Legend */}
      <div className="mb-4 pb-3 border-b">
        <Text className="text-xs font-semibold mb-2">Asset Classes</Text>
        <div className="flex flex-wrap gap-2">
          {['fixedIncome', 'equity', 'currency', 'commodity', 'crypto'].map((assetClass) => (
            <div key={assetClass} className="flex items-center gap-1">
              <Badge color={getAssetClassColor(assetClass)} size="xs" />
              <Text className="text-xs">{getAssetClassName(assetClass)}</Text>
            </div>
          ))}
        </div>
      </div>
      
      <Table>
        <TableHead>
          <TableRow>
            <TableHeaderCell>Ticker</TableHeaderCell>
            <TableHeaderCell>W/W</TableHeaderCell>
            <TableHeaderCell>M/M</TableHeaderCell>
            <TableHeaderCell>Risk</TableHeaderCell>
            <TableHeaderCell>Trade</TableHeaderCell>
            <TableHeaderCell>Trend</TableHeaderCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {securities.map((security) => (
            <TableRow 
              key={security.ticker}
              className="hover:bg-gray-50 cursor-pointer"
            >
              <TableCell>
                <div className="flex items-center gap-2">
                  <Badge color={getAssetClassColor(security.assetClass)} size="xs" />
                  <Text className="font-semibold text-xs">{security.ticker}</Text>
                </div>
              </TableCell>
              <TableCell>
                <Text className="text-xs">{security.weekChange || '-'}</Text>
              </TableCell>
              <TableCell>
                <Text className="text-xs">{security.monthChange || '-'}</Text>
              </TableCell>
              <TableCell>
                <Text className="text-xs text-gray-500">{security.riskRange || '-'}</Text>
              </TableCell>
              <TableCell>
                <Text className="text-xs text-gray-500">{security.trade || '-'}</Text>
              </TableCell>
              <TableCell>
                <Text className="text-xs text-gray-500">{security.trend || '-'}</Text>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
};

export default SecuritiesList;
