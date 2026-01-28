import React from 'react';
import ReactDOM from 'react-dom';
import { Card, Title, Text, Metric, Badge, Flex, ProgressBar } from '@tremor/react';
import { X, TrendingUp, TrendingDown, Activity, DollarSign, Percent } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, ReferenceLine } from 'recharts';

// Mock data generator based on factor name
const getMockData = (factorName, netExposure) => {
    const baseContributors = {
        'Growth': {
            long: [
                { ticker: 'NVDA', name: 'NVIDIA Corp', weight: '4.2%', contribution: '+1.8%' },
                { ticker: 'MSFT', name: 'Microsoft', weight: '3.8%', contribution: '+1.2%' },
                { ticker: 'AMZN', name: 'Amazon.com', weight: '2.9%', contribution: '+0.7%' },
                { ticker: 'META', name: 'Meta Platforms', weight: '2.1%', contribution: '+0.5%' },
                { ticker: 'LLY', name: 'Eli Lilly', weight: '1.8%', contribution: '+0.4%' }
            ],
            short: [
                { ticker: 'XOM', name: 'Exxon Mobil', weight: '-2.1%', contribution: '-0.5%' },
                { ticker: 'CVX', name: 'Chevron Corp', weight: '-1.8%', contribution: '-0.3%' },
                { ticker: 'KO', name: 'Coca-Cola', weight: '-1.5%', contribution: '-0.2%' },
                { ticker: 'PEP', name: 'PepsiCo', weight: '-1.2%', contribution: '-0.2%' },
                { ticker: 'VZ', name: 'Verizon', weight: '-1.0%', contribution: '-0.1%' }
            ]
        },
        'Value': {
            long: [
                { ticker: 'JPM', name: 'JPMorgan Chase', weight: '3.5%', contribution: '+0.9%' },
                { ticker: 'XOM', name: 'Exxon Mobil', weight: '3.1%', contribution: '+0.6%' },
                { ticker: 'BRK.B', name: 'Berkshire Hath', weight: '2.8%', contribution: '+0.4%' },
                { ticker: 'CVX', name: 'Chevron Corp', weight: '1.9%', contribution: '+0.3%' },
                { ticker: 'CSCO', name: 'Cisco Systems', weight: '1.5%', contribution: '+0.2%' }
            ],
            short: [
                { ticker: 'NVDA', name: 'NVIDIA Corp', weight: '-2.5%', contribution: '-0.8%' },
                { ticker: 'AMD', name: 'Adv Micro Dev', weight: '-2.0%', contribution: '-0.6%' },
                { ticker: 'TSLA', name: 'Tesla Inc', weight: '-1.8%', contribution: '-0.5%' },
                { ticker: 'NFLX', name: 'Netflix', weight: '-1.5%', contribution: '-0.4%' },
                { ticker: 'CMG', name: 'Chipotle', weight: '-1.2%', contribution: '-0.3%' }
            ]
        },
        'Momentum': {
            long: [
                { ticker: 'NVO', name: 'Novo Nordisk', weight: '2.8%', contribution: '+1.1%' },
                { ticker: 'AVGO', name: 'Broadcom Inc', weight: '2.5%', contribution: '+0.9%' },
                { ticker: 'ANET', name: 'Arista Networks', weight: '1.7%', contribution: '+0.6%' },
                { ticker: 'PHM', name: 'PulteGroup', weight: '1.2%', contribution: '+0.4%' },
                { ticker: 'GE', name: 'GE Aerospace', weight: '1.1%', contribution: '+0.3%' }
            ],
            short: [
                { ticker: 'TSLA', name: 'Tesla Inc', weight: '-2.2%', contribution: '-0.7%' },
                { ticker: 'BA', name: 'Boeing Co', weight: '-1.8%', contribution: '-0.5%' },
                { ticker: 'MMM', name: '3M Company', weight: '-1.5%', contribution: '-0.3%' },
                { ticker: 'WBA', name: 'Walgreens', weight: '-1.2%', contribution: '-0.2%' },
                { ticker: 'DIS', name: 'Disney', weight: '-1.0%', contribution: '-0.2%' }
            ]
        },
        'Quality': {
            long: [
                { ticker: 'AAPL', name: 'Apple Inc', weight: '5.1%', contribution: '+1.5%' },
                { ticker: 'V', name: 'Visa Inc', weight: '2.6%', contribution: '+0.6%' },
                { ticker: 'MA', name: 'Mastercard', weight: '2.4%', contribution: '+0.5%' },
                { ticker: 'ACN', name: 'Accenture', weight: '1.8%', contribution: '+0.3%' },
                { ticker: 'COST', name: 'Costco', weight: '1.6%', contribution: '+0.3%' }
            ],
            short: [
                { ticker: 'AMC', name: 'AMC Entertain', weight: '-1.5%', contribution: '-0.4%' },
                { ticker: 'GME', name: 'GameStop', weight: '-1.2%', contribution: '-0.3%' },
                { ticker: 'PTON', name: 'Peloton', weight: '-1.0%', contribution: '-0.2%' },
                { ticker: 'BYND', name: 'Beyond Meat', weight: '-0.8%', contribution: '-0.2%' },
                { ticker: 'DKNG', name: 'DraftKings', weight: '-0.7%', contribution: '-0.1%' }
            ]
        },
        'Volatility': {
            long: [
                { ticker: 'VIX', name: 'CBOE Volatility', weight: '5.0%', contribution: '-1.2%' },
                { ticker: 'UVXY', name: 'Ultra VIX Short', weight: '1.5%', contribution: '-0.4%' },
                { ticker: 'VXX', name: 'iPath Series B', weight: '1.2%', contribution: '-0.3%' },
                { ticker: 'SVXY', name: 'ProShares Short', weight: '0.9%', contribution: '+0.2%' },
                { ticker: 'VIXY', name: 'ProShares VIX', weight: '0.8%', contribution: '+0.1%' }
            ],
            short: [
                { ticker: 'SPY', name: 'SPDR S&P 500', weight: '-2.5%', contribution: '+0.5%' },
                { ticker: 'QQQ', name: 'Invesco QQQ', weight: '-2.0%', contribution: '+0.4%' },
                { ticker: 'DIA', name: 'SPDR Dow', weight: '-1.5%', contribution: '+0.3%' },
                { ticker: 'IWM', name: 'Russell 2000', weight: '-1.2%', contribution: '+0.2%' },
                { ticker: 'EFA', name: 'MSCI EAFE', weight: '-1.0%', contribution: '+0.2%' }
            ]
        },
        'Carry': {
            long: [
                { ticker: 'JNK', name: 'High Yield Bond', weight: '4.5%', contribution: '+0.8%' },
                { ticker: 'PFF', name: 'Preferred ETF', weight: '3.2%', contribution: '+0.5%' },
                { ticker: 'EMB', name: 'EM Bond ETF', weight: '2.8%', contribution: '+0.4%' },
                { ticker: 'HYG', name: 'iBoxx High Yld', weight: '2.5%', contribution: '+0.3%' },
                { ticker: 'LQD', name: 'Inv Grade Corp', weight: '1.9%', contribution: '+0.2%' }
            ],
            short: [
                { ticker: 'SHY', name: '1-3 Year Treas', weight: '-2.0%', contribution: '-0.1%' },
                { ticker: 'IEI', name: '3-7 Year Treas', weight: '-1.5%', contribution: '-0.1%' },
                { ticker: 'TLT', name: '20+ Year Treas', weight: '-1.2%', contribution: '-0.2%' },
                { ticker: 'GOVT', name: 'iShares US Tr', weight: '-1.0%', contribution: '-0.1%' },
                { ticker: 'BIL', name: '1-3 Mo T-Bill', weight: '-0.8%', contribution: '0.0%' }
            ]
        },
        'Size': {
            long: [
                { ticker: 'IWM', name: 'Russell 2000', weight: '3.8%', contribution: '-0.5%' },
                { ticker: 'VB', name: 'Vanguard Small', weight: '2.5%', contribution: '-0.3%' },
                { ticker: 'IJR', name: 'S&P SmallCap', weight: '2.1%', contribution: '-0.2%' },
                { ticker: 'SCHA', name: 'Schwab US Small', weight: '1.8%', contribution: '-0.1%' },
                { ticker: 'FNDA', name: 'Schwab Fund.', weight: '1.5%', contribution: '0.0%' }
            ],
            short: [
                { ticker: 'SPY', name: 'SPDR S&P 500', weight: '-3.0%', contribution: '+0.3%' },
                { ticker: 'IVV', name: 'iShares Core', weight: '-2.5%', contribution: '+0.2%' },
                { ticker: 'VOO', name: 'Vanguard 500', weight: '-2.0%', contribution: '+0.2%' },
                { ticker: 'SPLG', name: 'SPDR Port', weight: '-1.5%', contribution: '+0.1%' },
                { ticker: 'DIA', name: 'SPDR Dow', weight: '-1.0%', contribution: '+0.1%' }
            ]
        },
        'Liquidity': {
            long: [
                { ticker: 'SPY', name: 'SPDR S&P 500', weight: '10.5%', contribution: '+0.2%' },
                { ticker: 'QQQ', name: 'Invesco QQQ', weight: '8.2%', contribution: '+0.3%' },
                { ticker: 'GLD', name: 'SPDR Gold', weight: '4.1%', contribution: '+0.1%' },
                { ticker: 'TLT', name: '20+ Year Treas', weight: '3.5%', contribution: '-0.1%' },
                { ticker: 'IEFA', name: 'Core MSCI EAFE', weight: '2.9%', contribution: '+0.1%' }
            ],
            short: [
                { ticker: 'IWC', name: 'MicroCap ETF', weight: '-1.5%', contribution: '-0.2%' },
                { ticker: 'FDM', name: 'Select Med', weight: '-1.2%', contribution: '-0.1%' },
                { ticker: 'PJP', name: 'Pharmaceut', weight: '-1.0%', contribution: '-0.1%' },
                { ticker: 'XBI', name: 'Biotech ETF', weight: '-0.8%', contribution: '-0.1%' },
                { ticker: 'KRE', name: 'Regional Bank', weight: '-0.7%', contribution: '-0.1%' }
            ]
        },
        'Crowding': {
            long: [
                { ticker: 'NVDA', name: 'NVIDIA Corp', weight: '4.2%', contribution: '+0.8%' },
                { ticker: 'TSLA', name: 'Tesla Inc', weight: '3.1%', contribution: '-1.2%' },
                { ticker: 'PLTR', name: 'Palantir Tech', weight: '2.5%', contribution: '-0.5%' },
                { ticker: 'AMD', name: 'Adv Micro Dev', weight: '2.1%', contribution: '-0.3%' },
                { ticker: 'MARA', name: 'Marathon Dig', weight: '1.8%', contribution: '-0.4%' }
            ],
            short: [
                { ticker: 'AAPL', name: 'Apple Inc', weight: '-2.5%', contribution: '+0.3%' },
                { ticker: 'MSFT', name: 'Microsoft', weight: '-2.2%', contribution: '+0.2%' },
                { ticker: 'GOOGL', name: 'Alphabet Inc', weight: '-1.8%', contribution: '+0.2%' },
                { ticker: 'AMZN', name: 'Amazon.com', weight: '-1.5%', contribution: '+0.1%' },
                { ticker: 'META', name: 'Meta Platforms', weight: '-1.2%', contribution: '+0.1%' }
            ]
        }
    };

    // Default if not found
    const contributors = baseContributors[factorName] || {
        long: [{ ticker: 'UNK', name: 'Unknown', weight: '0.0%', contribution: '0.0%' }],
        short: [{ ticker: 'UNK', name: 'Unknown', weight: '0.0%', contribution: '0.0%' }]
    };

    // Generate pseudo-random macro data based on factor name to ensure consistency
    const hash = (factorName || '').split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    // const getVal = (offset) => ((hash + offset) % 100) / 50 - 1; // Range -1 to 1

    return {
        confidenceScore: 70 + (hash % 30), // 70-100
        historicalRange: {
            min: -15 - (hash % 10),
            max: 20 + (hash % 15),
            median: 2 + (hash % 5),
            current: netExposure || 0
        },
        contributors,
        macroSensitivity: {
            interestRates: { value: 'X%', label: 'Rates (10Y)' },
            volatility: { value: 'X%', label: 'Vol (VIX)' },
            dollar: { value: 'X%', label: 'USD (DXY)' }
        },
        risk: {
            mctr: `${(5 + (hash % 15)).toFixed(1)}%`,
            varContribution: `$${(20000 + (hash * 100)).toLocaleString()}`
        }
    };
};

const FactorDeepDiveSidebar = ({ factor, onClose, isOpen }) => {
    // 1. Hooks first (unconditional)
    const deepDiveData = React.useMemo(() => {
        if (!factor) return null;
        return getMockData(factor.name, factor.net);
    }, [factor]);

    // 2. Early return after hooks
    if (!factor || !deepDiveData) return null;

    // Helper for Macro Dials
    const MacroGauge = ({ value, label }) => {
        const isPlaceholder = value === 'X%';
        const numValue = isPlaceholder ? 0 : value;

        return (
            <div className="flex flex-col items-center">
                <div className="relative w-16 h-8 overflow-hidden mb-1">
                    {/* Gauge Background */}
                    <div className="absolute top-0 left-0 w-full h-16 rounded-full border-4 border-gray-200 dark:border-gray-700 box-border"></div>
                    {/* Needle */}
                    <div
                        className={`absolute bottom-0 left-1/2 w-0.5 h-full origin-bottom transition-transform duration-500 ${isPlaceholder ? 'bg-gray-300 dark:bg-gray-600' : 'bg-gray-800 dark:bg-white'}`}
                        style={{ transform: `translateX(-50%) rotate(${isPlaceholder ? 0 : (numValue * 90)}deg)` }}
                    ></div>
                </div>
                <div className={`text-xs font-mono font-bold ${isPlaceholder ? 'text-gray-400' : (numValue > 0 ? 'text-green-500' : 'text-red-500')}`}>
                    {isPlaceholder ? 'X%' : (numValue > 0 ? '+' : '') + numValue.toFixed(2)}
                </div>
                <div className="text-[10px] text-gray-500 text-center mt-0.5">{label}</div>
            </div>
        );
    };

    return (
        <div className="h-full w-[350px] flex-shrink-0 border-l border-gray-200 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-800/20 overflow-y-auto transition-all duration-300">
            {/* Header */}
            <div className="p-4 border-b border-gray-200 dark:border-gray-800 relative">
                <button
                    onClick={onClose}
                    className="absolute top-2 right-2 p-1 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-full transition-colors text-gray-400"
                >
                    <X size={16} />
                </button>

                <div className="mb-1">
                    <span className="text-[10px] font-mono text-gray-500 uppercase tracking-wider">Factor Deep Dive</span>
                </div>
                <Title className="text-xl font-bold dark:text-white mb-2">{factor.name}</Title>

                <div className="flex items-center justify-between w-full">
                    <span className={`font-mono text-xs ${factor.net >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                        Net: {factor.net > 0 ? '+' : ''}{factor.net.toFixed(1)}%
                    </span>
                    <span className="font-mono text-xs text-gray-400 font-bold tracking-wider">
                        QUADS
                    </span>
                </div>
            </div>

            <div className="p-4 space-y-6">
                {/* Section 1: Historical Range */}
                <div className="space-y-2">
                    <Text className="text-[10px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">52-Week Range</Text>
                    <div className="relative h-8 pt-3">
                        {/* Range Bar */}
                        <div className="absolute top-1/2 left-0 w-full h-1 bg-gray-200 dark:bg-gray-700 rounded-full -translate-y-1/2"></div>
                        {/* Min/Max Ticks */}
                        <div className="absolute top-[20%] left-0 w-px h-3 bg-gray-400"></div>
                        <div className="absolute top-[20%] right-0 w-px h-3 bg-gray-400"></div>

                        {/* Current Value Marker */}
                        <div
                            className="absolute top-1/2 w-2.5 h-2.5 bg-blue-500 border-2 border-white dark:border-gray-900 rounded-full -translate-y-1/2 shadow-sm z-10"
                            style={{ left: `${((deepDiveData.historicalRange.current - deepDiveData.historicalRange.min) / (deepDiveData.historicalRange.max - deepDiveData.historicalRange.min)) * 100}%` }}
                        />

                        {/* Labels */}
                        <div className="absolute bottom-[-6px] text-[8px] text-gray-400 w-full flex justify-between font-mono">
                            <span>L:{deepDiveData.historicalRange.min}</span>
                            <span>H:{deepDiveData.historicalRange.max}</span>
                        </div>
                    </div>
                </div>

                {/* Section 2: Macro Sensitivity */}
                <div className="space-y-2">
                    <Text className="text-[10px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Macro Sensitivity</Text>
                    <div className="grid grid-cols-3 gap-1">
                        <MacroGauge {...deepDiveData.macroSensitivity.interestRates} />
                        <MacroGauge {...deepDiveData.macroSensitivity.volatility} />
                        <MacroGauge {...deepDiveData.macroSensitivity.dollar} />
                    </div>
                </div>

                {/* Section 3: contributors */}
                <div className="space-y-2">
                    <Text className="text-[10px] font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">Top 5 Securities</Text>
                    <div className="grid grid-cols-2 gap-3">
                        {/* Longs */}
                        <div className="space-y-1">
                            <div className="text-[9px] font-semibold text-green-600 dark:text-green-400 uppercase">Long</div>
                            <div className="overflow-hidden rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900/50">
                                <table className="w-full text-left text-[9px]">
                                    <thead className="bg-gray-50 dark:bg-gray-800 font-medium text-gray-500">
                                        <tr>
                                            <th className="p-1 pl-2">Tkr</th>
                                            <th className="p-1 text-right">Wgt</th>
                                            <th className="p-1 pr-2 text-right">Ctrb</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                                        {deepDiveData.contributors.long.map((item, idx) => (
                                            <tr key={idx} className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
                                                <td className="p-1 pl-2 font-medium truncate max-w-[40px]" title={item.name}>{item.ticker}</td>
                                                <td className="p-1 text-right font-mono text-black dark:text-white">{item.weight}</td>
                                                <td className="p-1 pr-2 text-right font-mono text-green-600">{item.contribution}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </div>

                        {/* Shorts */}
                        <div className="space-y-1">
                            <div className="text-[9px] font-semibold text-red-600 dark:text-red-400 uppercase">Short</div>
                            <div className="overflow-hidden rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900/50">
                                <table className="w-full text-left text-[9px]">
                                    <thead className="bg-gray-50 dark:bg-gray-800 font-medium text-gray-500">
                                        <tr>
                                            <th className="p-1 pl-2">Tkr</th>
                                            <th className="p-1 text-right">Wgt</th>
                                            <th className="p-1 pr-2 text-right">Ctrb</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                                        {deepDiveData.contributors.short.map((item, idx) => (
                                            <tr key={idx} className="hover:bg-gray-50 dark:hover:bg-gray-800/50">
                                                <td className="p-1 pl-2 font-medium truncate max-w-[40px]" title={item.name}>{item.ticker}</td>
                                                <td className="p-1 text-right font-mono text-black dark:text-white">{item.weight}</td>
                                                <td className="p-1 pr-2 text-right font-mono text-red-500">{item.contribution}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default FactorDeepDiveSidebar;
