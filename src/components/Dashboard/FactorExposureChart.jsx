import React, { useMemo } from 'react';
import { Card, Title, Text, Metric } from '@tremor/react';

const FactorExposureChart = ({ data }) => {
    // Process and sort data
    const processedData = useMemo(() => {
        if (!data || Object.keys(data).length === 0) return [];

        const factors = Object.keys(data);
        const result = factors.map(factor => {
            // Handle potential data formats (number or object with long/short)
            // Assuming structure based on requirements:
            // data[factor] might be just a net number, OR we need to derive it.
            // The requirement says: "Right side = net long exposure, left side = net short exposure"
            // "Net exposure = long exposure - short exposure"
            // "Visualization only; assume factor exposure data is already available"

            // If data comes in as { factor: { long: 10, short: 5 } }
            const factorData = data[factor] || {};
            const long = Math.abs(parseFloat(factorData.long) || 0);
            const short = Math.abs(parseFloat(factorData.short) || 0);
            const net = long - short;

            return {
                name: factor,
                long,
                short,
                net,
                absNet: Math.abs(net)
            };
        });

        // Default sort by absolute net exposure (descending)
        return result.sort((a, b) => b.absNet - a.absNet);
    }, [data]);

    if (processedData.length === 0) {
        return (
            <div className="flex items-center justify-center p-8 text-gray-500">
                No factor exposure data available
            </div>
        );
    }

    // Find max value to normalize bar widths
    // We need the max absolute net value to scale the bars properly from the center
    const maxExposure = Math.max(...processedData.map(d => d.absNet), 1); // Avoid div by 0

    return (
        <div className="flex flex-col w-full h-full">
            <div className="grid grid-cols-12 gap-2 text-xs text-gray-500 mb-2 px-2 font-medium">
                <div className="col-span-3 text-right">Short Exposure</div>
                <div className="col-span-6 text-center">Net Exposure</div>
                <div className="col-span-3 text-left">Long Exposure</div>
            </div>

            <div className="flex flex-col space-y-3">
                {processedData.map((item) => (
                    <div key={item.name} className="group relative flex items-center h-8 hover:bg-gray-50 dark:hover:bg-gray-800 rounded transition-colors duration-150">
                        {/* Tooltip */}
                        <div className="absolute z-50 left-1/2 -top-12 -translate-x-1/2 hidden group-hover:block bg-gray-900 text-white text-xs rounded py-1 px-2 shadow-lg whitespace-nowrap pointer-events-none">
                            <div className="font-semibold mb-1">{item.name}</div>
                            <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-right">
                                <span className="text-gray-400 text-left">Long:</span>
                                <span className="text-green-400">{item.long.toFixed(1)}%</span>
                                <span className="text-gray-400 text-left">Short:</span>
                                <span className="text-red-400">{item.short.toFixed(1)}%</span>
                                <span className="text-gray-400 text-left border-t border-gray-700 pt-0.5 mt-0.5">Net:</span>
                                <span className={`border-t border-gray-700 pt-0.5 mt-0.5 ${item.net >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                                    {item.net > 0 ? '+' : ''}{item.net.toFixed(1)}%
                                </span>
                            </div>
                            {/* Arrow */}
                            <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 w-2 h-2 bg-gray-900 rotate-45 transform"></div>
                        </div>

                        {/* Factor Name - Mobile/Compact Layout might need this elsewhere, but placing absolute left or integrated */}
                        <div className="absolute left-2 text-xs font-semibold text-gray-700 dark:text-gray-300 w-20 truncate z-10">
                            {item.name}
                        </div>

                        {/* Chart Area */}
                        <div className="flex-1 grid grid-cols-2 gap-0 relative h-full mx-24 sm:mx-32">
                            {/* Vertical Center Line */}
                            <div className="absolute left-1/2 top-0 bottom-0 w-px bg-gray-300 dark:bg-gray-600 transform -translate-x-1/2 z-0"></div>

                            {/* Left Side (Negative/Short) */}
                            <div className="flex items-center justify-end pr-0.5 h-full relative">
                                {item.net < 0 && (
                                    <div
                                        className="h-5 bg-red-500/80 rounded-l-sm"
                                        style={{ width: `${(Math.abs(item.net) / maxExposure) * 100}%`, minWidth: '2px' }}
                                    />
                                )}
                            </div>

                            {/* Right Side (Positive/Long) */}
                            <div className="flex items-center justify-start pl-0.5 h-full relative">
                                {item.net >= 0 && (
                                    <div
                                        className="h-5 bg-green-500/80 rounded-r-sm"
                                        style={{ width: `${(Math.abs(item.net) / maxExposure) * 100}%`, minWidth: '1px' }} // show at least a line for 0
                                    />
                                )}
                            </div>
                        </div>

                        {/* Value Label (Right Side) */}
                        <div className={`absolute right-2 text-xs font-bold w-12 text-right ${item.net >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                            {item.net > 0 ? '+' : ''}{item.net.toFixed(1)}%
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
};

export default FactorExposureChart;
