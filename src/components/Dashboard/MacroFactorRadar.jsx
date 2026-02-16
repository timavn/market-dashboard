import React from 'react';
import { Card, Title, Text, Metric } from '@tremor/react';
import { ResponsiveContainer, RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, Radar, Tooltip, Legend } from 'recharts';
import { calculateMacroFactorExposures } from '../../utils/macroAnalysisUtils';

const CustomTooltip = ({ active, payload, label }) => {
    if (active && payload && payload.length) {
        const data = payload[0].payload;
        return (
            <div className="bg-white dark:bg-gray-800 p-3 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700">
                <p className="font-bold text-gray-900 dark:text-gray-100">{data.subject}</p>
                <p className="text-sm font-medium" style={{ color: data.color }}>
                    Exposure: {data.score}%
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 max-w-[200px]">
                    {data.description}
                </p>
            </div>
        );
    }
    return null;
};

const MacroFactorRadar = ({ portfolioData }) => {
    if (!portfolioData || !portfolioData.holdings) return null;

    const totalValue = portfolioData.summary?.totalValue || 1;
    const data = calculateMacroFactorExposures(portfolioData.holdings, totalValue);

    // Find max value to scale chart
    const scores = data.map(d => Math.abs(d.score));
    const maxScore = Math.max(...scores, 100); // At least 100
    const chartDomain = [0, maxScore];

    return (
        <Card className="dark:bg-gray-800 border-none ring-0 shadow-none h-full flex flex-col">
            <div className="mb-4">
                <Title className="dark:text-white">Macro Factor Exposure</Title>
                <Text className="text-sm text-gray-400 italic">
                    "Beta-adjusted exposure to key macro drivers. 100% = Full Long Exposure."
                </Text>
            </div>

            <div className="flex-1 w-full min-h-[400px]">
                <ResponsiveContainer width="100%" height="100%">
                    <RadarChart cx="50%" cy="50%" outerRadius="80%" data={data}>
                        <PolarGrid stroke="#374151" strokeOpacity={0.5} />
                        <PolarAngleAxis
                            dataKey="subject"
                            tick={{ fill: '#9CA3AF', fontSize: 12, fontWeight: 500 }}
                        />
                        <PolarRadiusAxis
                            angle={90}
                            domain={[0, maxScore]}
                            tick={false}
                            axisLine={false}
                        />

                        <Radar
                            name="Portfolio"
                            dataKey="score"
                            stroke="#3B82F6"
                            strokeWidth={3}
                            fill="#3B82F6"
                            fillOpacity={0.4}
                        />

                        <Tooltip content={<CustomTooltip />} />
                    </RadarChart>
                </ResponsiveContainer>
            </div>

            {/* Legend / Breakdown Grid */}
            <div className="grid grid-cols-5 gap-2 mt-4 pt-4 border-t border-gray-800">
                {data.map((item) => (
                    <div key={item.factorId} className="flex flex-col items-center text-center p-2 rounded hover:bg-gray-700/30 transition-colors">
                        <span className="text-[10px] uppercase font-bold tracking-wider mb-1" style={{ color: item.color }}>
                            {item.subject}
                        </span>
                        <Metric className="text-lg dark:text-white">
                            {item.score > 0 ? '+' : ''}{item.score}%
                        </Metric>
                    </div>
                ))}
            </div>
        </Card>
    );
};

export default MacroFactorRadar;
