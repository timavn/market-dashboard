import React from 'react';
import { Card, Title, Text, Grid, Badge, Flex } from '@tremor/react';
import MacroFactorRadar from './MacroFactorRadar';
import { calculateMacroFactorExposures } from '../../utils/macroAnalysisUtils';

const PortfolioAnalytics = ({ portfolioData }) => {
  // Calculate factor exposures with detailed contributors - ALWAYS call hooks at top level
  const factorData = React.useMemo(() => {
    if (!portfolioData?.holdings) return [];
    return calculateMacroFactorExposures(portfolioData.holdings, portfolioData.summary?.totalValue);
  }, [portfolioData]);

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

  // Use pre-calculated metrics or fallbacks
  const analytics = portfolioData.riskMetrics || {};

  return (
    <div className="space-y-6 animate-fade-in-up">
      {/* Remove Header "Macro Risk Audit" - streamlined layout as requested */}

      <Grid numItems={12} className="gap-6">
        {/* Main Radar Chart - Centerpiece */}
        <div className="col-span-12 md:col-span-6 lg:col-span-5">
          <MacroFactorRadar portfolioData={portfolioData} />
        </div>

        {/* Detailed Factor Breakdown - Right Column */}
        <div className="col-span-12 md:col-span-6 lg:col-span-7 space-y-4">
          <div className="h-[600px] overflow-y-auto pr-2 custom-scrollbar">
            {factorData.map((factor) => (
              <Card key={factor.factorId} className="mb-2 dark:bg-gray-800 p-2 border-l-2" style={{ borderLeftColor: factor.color }}>
                <div className="flex justify-between items-center mb-1">
                  <div className="flex items-center gap-2 overflow-hidden">
                    <Text className="text-sm font-bold whitespace-nowrap flex-shrink-0" style={{ color: factor.color }}>{factor.subject}</Text>
                    <Text className="text-[10px] text-gray-500 italic truncate min-w-0">{factor.calculationMethod}</Text>
                  </div>
                  <Badge size="xs" className="px-1.5 py-0 flex-shrink-0 ml-2" style={{ backgroundColor: `${factor.color}20`, color: factor.color }}>
                    {factor.score > 0 ? '+' : ''}{factor.score}%
                  </Badge>
                </div>

                {/* Compact Contributors Table */}
                <div className="mt-1">
                  <div className="overflow-hidden rounded border border-gray-700/50">
                    <table className="w-full text-[10px]">
                      <thead className="bg-gray-700/30">
                        <tr>
                          <th className="px-2 py-0.5 text-left text-gray-400 font-medium">Ticker</th>
                          <th className="px-2 py-0.5 text-right text-gray-400 font-medium">Wgt</th>
                          <th className="px-2 py-0.5 text-right text-gray-400 font-medium">Ctrb</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-700/30">
                        {factor.topContributors.map((c, idx) => (
                          <tr key={idx} className="hover:bg-gray-700/20">
                            <td className="px-2 py-0.5 font-medium dark:text-gray-300">{c.symbol}</td>
                            <td className="px-2 py-0.5 text-right text-gray-500">{c.weightPercent}%</td>
                            <td className={`px-2 py-0.5 text-right font-medium ${parseFloat(c.contributionPercent) > 0 ? 'text-green-400' : 'text-red-400'}`}>
                              {parseFloat(c.contributionPercent) > 0 ? '+' : ''}{c.contributionPercent}%
                            </td>
                          </tr>
                        ))}
                        {factor.topContributors.length === 0 && (
                          <tr>
                            <td colSpan="3" className="px-2 py-1 text-center text-gray-500 italic">No contributors</td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        </div>
      </Grid>
    </div>
  );
};

export default PortfolioAnalytics;


