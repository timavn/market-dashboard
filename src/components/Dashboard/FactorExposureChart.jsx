import React, { useMemo } from 'react';
import { Card, Title, Text, Metric } from '@tremor/react';

const FactorExposureChart = ({ data, onFactorSelect }) => {
    // Process and sort data
    const processedData = useMemo(() => {
        if (!data || Object.keys(data).length === 0) return [];

        const factors = Object.keys(data);
        const result = factors.map(factor => {
            const factorData = data[factor] || {};

            // Handle parsing of percentage strings ("12.5%") or numbers
            const parseVal = (val) => {
                if (typeof val === 'string') {
                    return parseFloat(val.replace('%', '')) || 0;
                }
                return parseFloat(val) || 0;
            };

            const long = Math.abs(parseVal(factorData.long));
            const short = Math.abs(parseVal(factorData.short));
            const net = long - short;
            const gross = long + short;

            return {
                name: factor,
                long,
                short,
                net,
                gross,
                absNet: Math.abs(net)
            };
        });

        // Sort by absolute net exposure (highest conviction at the top)
        return result.sort((a, b) => b.absNet - a.absNet);
    }, [data]);

    if (processedData.length === 0) {
        return (
            <div className="flex items-center justify-center p-8 text-gray-500 text-sm">
                No factor exposure data available
            </div>
        );
    }

    // Determine scale: Find the max single-side extent needed
    // We need to accommodate the largest Long or largest Short bar
    // Multiplier for breathing room
    const globalMax = Math.max(
        ...processedData.map(d => Math.max(d.long, d.short))
        , 1) * 1.1;

    return (
        <div className="flex flex-col w-full h-full select-none">
            {/* Header Row - Minimalist */}
            <div className="grid grid-cols-12 gap-4 text-[10px] uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-3 px-2 font-semibold border-b border-gray-100 dark:border-gray-800 pb-2">
                <div className="col-span-3 text-left">Factor / Gross</div>
                <div className="col-span-8 text-center">Exposure Structure</div>
                <div className="col-span-1 text-right">Net</div>
            </div>

            <div className="flex flex-col space-y-1">
                {processedData.map((item) => (
                    <div
                        key={item.name}
                        onClick={() => onFactorSelect && onFactorSelect(item)}
                        className="group relative grid grid-cols-12 gap-4 items-center h-10 hover:bg-gray-50 dark:hover:bg-gray-800/50 rounded-sm transition-colors duration-200 px-2 cursor-pointer"
                    >
                        {/* LEFT SECTION: Name & Gross */}
                        <div className="col-span-3 flex flex-col justify-center">
                            <span className="text-xs font-bold text-gray-800 dark:text-gray-100 truncate" title={item.name}>
                                {item.name}
                            </span>
                            <span className="text-[10px] font-medium text-gray-400">
                                Gross: {item.gross.toFixed(1)}%
                            </span>
                        </div>

                        {/* CENTER SECTION: Butterfly Chart */}
                        {/* Expanded to col-span-8 to absorb the removed numeric columns */}
                        <div className="col-span-8 relative h-full flex items-center">
                            {/* Center Axis */}
                            <div className="absolute left-1/2 top-0 bottom-0 w-px bg-gray-300 dark:bg-gray-600 z-0"></div>

                            {/* Container for bars */}
                            <div className="w-full flex items-center h-4 relative">

                                {/* Left Side (Shorts) - Red */}
                                <div className="flex-1 flex justify-end items-center pr-0.5 relative h-full gap-2">
                                    {/* Value Label at End of Bar */}
                                    {item.short > 0 && (
                                        <span className="text-[10px] font-mono text-red-500/80">
                                            {item.short.toFixed(1)}
                                        </span>
                                    )}
                                    {item.short > 0 && (
                                        <div
                                            className="h-full bg-red-500/60 dark:bg-red-500/40 border-r border-red-500 rounded-l-sm transition-all duration-500"
                                            style={{ width: `${(item.short / globalMax) * 100}%` }}
                                        />
                                    )}
                                </div>

                                {/* Right Side (Longs) - Green */}
                                <div className="flex-1 flex justify-start items-center pl-0.5 relative h-full gap-2">
                                    {item.long > 0 && (
                                        <div
                                            className="h-full bg-green-500/60 dark:bg-green-500/40 border-l border-green-500 rounded-r-sm transition-all duration-500"
                                            style={{ width: `${(item.long / globalMax) * 100}%` }}
                                        />
                                    )}
                                    {/* Value Label at End of Bar */}
                                    {item.long > 0 && (
                                        <span className="text-[10px] font-mono text-green-500/80">
                                            {item.long.toFixed(1)}
                                        </span>
                                    )}
                                </div>

                                {/* Net Marker (Circle) Overlay */}
                                <div
                                    className="absolute top-1/2 -translate-y-1/2 transition-all duration-500 z-10 drop-shadow-md"
                                    style={{
                                        left: `calc(50% + ${(item.net / globalMax) * 50}%)`
                                    }}
                                >
                                    {/* Circle Shape */}
                                    <div className={`w-4 h-4 rounded-full border-2 transform -translate-x-1/2 cursor-crosshair
                                        ${item.net >= 0
                                            ? 'bg-white border-green-600 dark:bg-gray-900 dark:border-green-400'
                                            : 'bg-white border-red-600 dark:bg-gray-900 dark:border-red-400'
                                        }
                                    `}
                                        title={`Net Exposure: ${item.net > 0 ? '+' : ''}${item.net.toFixed(1)}%`}
                                    ></div>
                                </div>
                            </div>
                        </div>

                        {/* RIGHT SECTION: Net Exposure Label */}
                        <div className="col-span-1 flex justify-end items-center">
                            <span className={`text-xs font-medium font-mono px-1.5 py-0.5 rounded
                                ${item.net > 0
                                    ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                                    : item.net < 0
                                        ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                                        : 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400'
                                }
                            `}>
                                {item.net > 0 ? '+' : ''}{item.net.toFixed(1)}%
                            </span>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
};

export default FactorExposureChart;
