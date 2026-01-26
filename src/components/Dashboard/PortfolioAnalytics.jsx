import React from 'react';
import { Card, Title, Text, Metric, Grid, BarList, Table, TableHead, TableHeaderCell, TableBody, TableRow, TableCell, Badge, Flex, ProgressBar } from '@tremor/react';

const PortfolioAnalytics = ({ portfolioData }) => {
  if (!portfolioData || !portfolioData.summary) {
    return (
      <Card className="dark:bg-gray-800">
        <Title className="mb-2 dark:text-white">Portfolio Analysis</Title>
        <Text className="text-sm font-medium text-gray-400 italic mb-6">
          "Every metric on this page should help me decide whether to size a position up or down."
        </Text>
        <Text className="text-xs text-gray-500 dark:text-gray-400">
          No portfolio data available
        </Text>
      </Card>
    );
  }

  // Use pre-calculated metrics from portfolioData if available, otherwise calculate
  const analytics = portfolioData.riskMetrics ? {
    ...portfolioData.riskMetrics,
    ...portfolioData.exposureMetrics,
    ...portfolioData.concentrationMetrics,
    longShortFactors: portfolioData.longShortFactors || {},
    sensitivities: portfolioData.sensitivities || {},
    liquidity: portfolioData.liquidity || { buckets: {}, topRiskContributors: [] },
    scenarios: portfolioData.scenarios || []
  } : {};

  // Formatted data for charts
  const macroFactorData = Object.entries(analytics.longShortFactors || {}).map(([name, data]) => ({
    name: name,
    value: Math.abs(data.long) + Math.abs(data.short), // Total exposure magnitude
    long: data.long,
    short: data.short
  }));

  return (
    <div className="space-y-6">
      <div className="mb-2">
        <Title className="dark:text-white text-xl">Portfolio Analysis</Title>
        <Text className="text-sm font-medium text-gray-400 italic">
          "Every metric on this page should help me decide whether to size a position up or down."
        </Text>
      </div>

      {/* Top Section: Net/Gross & Macro Factors */}
      <Grid numItems={12} className="gap-6 h-full">
        {/* Exposure Summary */}
        <div className="col-span-12 md:col-span-4 flex flex-col gap-4">
          <Card className="dark:bg-gray-800 p-4">
            <Text className="text-sm text-gray-500 uppercase tracking-wide">Exposure</Text>
            <Flex className="mt-4 gap-4 items-baseline">
              <div className='flex flex-col'>
                <Metric className="dark:text-white">{analytics.netExposure || '0.0'}%</Metric>
                <Text className="text-xs text-gray-400">Net Exposure</Text>
              </div>
              <div className='h-8 w-px bg-gray-700 mx-2'></div>
              <div className='flex flex-col'>
                <Metric className="dark:text-gray-300 text-xl">{analytics.grossExposure || '0.0'}%</Metric>
                <Text className="text-xs text-gray-400">Gross Exposure</Text>
              </div>
            </Flex>
            <div className="mt-4 pt-4 border-t border-gray-700 flex justify-between">
              <div className="flex flex-col">
                <Text className="text-sm font-semibold text-emerald-500">{analytics.longCount || 0}</Text>
                <Text className="text-[10px] text-gray-500 uppercase">Long Positions</Text>
              </div>
              <div className="flex flex-col text-right">
                <Text className="text-sm font-semibold text-red-500">{analytics.shortCount || 0}</Text>
                <Text className="text-[10px] text-gray-500 uppercase">Short Positions</Text>
              </div>
            </div>
          </Card>

          {/* Drawdown Awareness */}
          <Card className="dark:bg-gray-800 p-4 flex-grow">
            <Text className="text-sm text-gray-500 uppercase tracking-wide mb-2">Drawdown Risk</Text>
            <div className="space-y-4">
              <div className="flex justify-between items-center">
                <Text className="text-sm dark:text-gray-300">Max Drawdown</Text>
                <Badge size="xs" color="amber">{analytics.maxDrawdown || '0.00'}%</Badge>
              </div>
              <div className="flex justify-between items-center">
                <Text className="text-sm dark:text-gray-300">VaR (95% 1d)</Text>
                <Text className="text-sm font-mono text-gray-400">${Number(analytics.var95 || 0).toLocaleString()}</Text>
              </div>
              <div className="flex justify-between items-center">
                <Text className="text-sm dark:text-gray-300">Volatility (Ann.)</Text>
                <Text className="text-sm font-mono text-gray-400">{analytics.volatility || '0.00'}%</Text>
              </div>
            </div>
          </Card>
        </div>

        {/* Macro Factor Exposure (Long vs Short) */}
        <Card className="col-span-12 md:col-span-8 dark:bg-gray-800">
          <Title className="dark:text-white text-sm uppercase text-gray-500 mb-4">Macro Driver Exposure</Title>
          <div className="space-y-4">
            {macroFactorData.map((factor) => (
              <div key={factor.name} className="flex items-center text-xs">
                <div className="w-20 text-right pr-3 text-gray-400 font-medium">{factor.name}</div>
                <div className="flex-1 flex items-center h-5 bg-gray-900 rounded-sm relative overflow-hidden">
                  {/* Center Line */}
                  <div className="absolute left-1/2 top-0 bottom-0 w-px bg-gray-600 z-10"></div>

                  {/* Short Bar (Left) - Using width % based on max possible 100% just for scaling viz */}
                  {factor.short > 0 && (
                    <div
                      style={{ width: `${Math.min(factor.short, 50)}%`, right: '50%' }}
                      className="absolute h-full bg-red-900/60 border-r border-red-700"
                    ></div>
                  )}

                  {/* Long Bar (Right) */}
                  {factor.long > 0 && (
                    <div
                      style={{ width: `${Math.min(factor.long, 50)}%`, left: '50%' }}
                      className="absolute h-full bg-emerald-900/60 border-l border-emerald-700"
                    ></div>
                  )}
                </div>

                <div className="w-24 pl-3 flex justify-between text-[10px] text-gray-500">
                  <span className={factor.short > 0 ? "text-red-400" : "text-gray-700"}>
                    {factor.short > 0 ? `-${factor.short}%` : '-'}
                  </span>
                  <span className={factor.long > 0 ? "text-emerald-400" : "text-gray-700"}>
                    {factor.long > 0 ? `+${factor.long}%` : '-'}
                  </span>
                </div>
              </div>
            ))}
          </div>
          <Text className="text-[10px] text-gray-500 mt-4 text-center">*Bars represent % of Total Portfolio Value. Scale capped at 50% from center for visibility.</Text>
        </Card>
      </Grid>

      {/* Sensitivities & Scenarios */}
      <Grid numItems={12} className="gap-6">
        <Card className="col-span-12 md:col-span-6 dark:bg-gray-800">
          <Title className="dark:text-white text-sm uppercase text-gray-500 mb-4">Primary Sensitivities</Title>
          <Table className="mt-2">
            <TableHead>
              <TableRow>
                <TableHeaderCell className="text-xs">Driver</TableHeaderCell>
                <TableHeaderCell className="text-xs text-right">Sensitivity</TableHeaderCell>
                <TableHeaderCell className="text-xs text-right">Unit</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              <TableRow>
                <TableCell className="text-sm dark:text-gray-300">Rates (10y)</TableCell>
                <TableCell className="text-sm font-mono text-right dark:text-white">{analytics.sensitivities?.ratesBPV || 0}</TableCell>
                <TableCell className="text-xs text-gray-500 text-right">Basis Point Value ($)</TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="text-sm dark:text-gray-300">Global Equities</TableCell>
                <TableCell className="text-sm font-mono text-right dark:text-white">{analytics.sensitivities?.equityBeta || '0.00'}</TableCell>
                <TableCell className="text-xs text-gray-500 text-right">Beta</TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="text-sm dark:text-gray-300">USD FX</TableCell>
                <TableCell className="text-sm font-mono text-right dark:text-white">{analytics.sensitivities?.fxBeta || '0.00'}</TableCell>
                <TableCell className="text-xs text-gray-500 text-right">Beta</TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="text-sm dark:text-gray-300">Commodities</TableCell>
                <TableCell className="text-sm font-mono text-right dark:text-white">{analytics.sensitivities?.commodityBeta || '0.00'}</TableCell>
                <TableCell className="text-xs text-gray-500 text-right">Beta</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </Card>

        <Card className="col-span-12 md:col-span-6 dark:bg-gray-800">
          <Title className="dark:text-white text-sm uppercase text-gray-500 mb-4">Scenario Analysis (P&L Estimate)</Title>
          <div className="space-y-3 mt-4">
            {analytics.scenarios && analytics.scenarios.map((scenario) => (
              <div key={scenario.name} className="flex justify-between items-center p-2 rounded bg-gray-50 dark:bg-gray-700/30">
                <Text className="text-sm dark:text-gray-300">{scenario.name}</Text>
                <Text className={`text-sm font-bold font-mono ${scenario.impact.startsWith('-') ? 'text-red-400' : 'text-emerald-400'}`}>
                  {scenario.impact}
                </Text>
              </div>
            ))}
          </div>
        </Card>
      </Grid>

      {/* Liquidity & Concentration */}
      <Grid numItems={12} className="gap-6">
        <Card className="col-span-12 dark:bg-gray-800">
          <Title className="dark:text-white text-sm uppercase text-gray-500 mb-4">Liquidity & Concentration</Title>
          <div className="md:flex gap-8">
            <div className="md:w-1/3">
              <Text className="text-xs font-semibold mb-2">Liquidity Profile (% Portfolio)</Text>
              <BarList
                data={Object.entries(analytics.liquidity?.buckets || {}).map(([name, value]) => ({ name, value }))}
                className="mt-2"
                color="blue"
              />
            </div>
            <div className="md:w-2/3 mt-6 md:mt-0">
              <Text className="text-xs font-semibold mb-2">Largest Risk Contributors</Text>
              <Table>
                <TableHead>
                  <TableRow>
                    <TableHeaderCell className="py-2 text-xs">Ticker</TableHeaderCell>
                    <TableHeaderCell className="py-2 text-xs text-right">% Risk Contrib.</TableHeaderCell>
                    <TableHeaderCell className="py-2 text-xs text-right">Est. Days to Exit</TableHeaderCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {analytics.liquidity?.topRiskContributors?.map((item) => (
                    <TableRow key={item.ticker}>
                      <TableCell className="py-2 text-sm dark:text-gray-300">{item.ticker}</TableCell>
                      <TableCell className="py-2 text-sm text-right dark:text-white">{item.contribution.toFixed(1)}%</TableCell>
                      <TableCell className="py-2 text-sm text-right dark:text-gray-400">{item.daysToExit.toFixed(1)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        </Card>
      </Grid>

    </div>
  );
};

export default PortfolioAnalytics;


