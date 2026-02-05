import React, { useState, useEffect } from 'react';
import { Card, Title, Text, Grid } from '@tremor/react';
import { MarketDataService } from '../../services/api/marketDataService';
import { GRANULAR_FACTORS } from '../../constants/granularFactors';

const GranularFactorAnalysis = () => {
    const [factorData, setFactorData] = useState({});
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const fetchFactorData = async () => {
            try {
                // Collect all tickers
                const tickers = GRANULAR_FACTORS.map(f => f.ticker);

                // Fetch quotes (batch if possible, or parallel)
                const quotes = await MarketDataService.getQuotes(tickers);

                // Map results back to tickers
                const dataMap = {};
                tickers.forEach(ticker => {
                    if (quotes[ticker]) {
                        dataMap[ticker] = quotes[ticker];
                    }
                });

                setFactorData(dataMap);
            } catch (err) {
                console.error("Error fetching factor data:", err);
            } finally {
                setLoading(false);
            }
        };

        fetchFactorData();
        // Refresh every minute
        const interval = setInterval(fetchFactorData, 60000);
        return () => clearInterval(interval);
    }, []);

    // Helper to calculate % change
    const getChange = (ticker) => {
        const quote = factorData[ticker];
        if (!quote) return null;

        // Handle various data shapes (string, number, null) safely
        const val = parseFloat(quote.changePercent);
        return isFinite(val) ? val : 0;
    };

    const renderFactorRow = (factor) => {
        const change = getChange(factor.ticker);
        const isPositive = change > 0;
        const isNeutral = change === 0;
        const colorClass = isPositive ? 'text-emerald-500' : isNeutral ? 'text-gray-400' : 'text-red-500';
        const sign = isPositive ? '+' : '';

        // Ensure change is a number before calling toFixed
        let formattedChange = '--';
        if (change !== null && typeof change === 'number') {
            formattedChange = `${sign}${change.toFixed(2)}%`;
        }

        return (
            <div key={factor.name} className="flex justify-between items-center py-2 border-b border-gray-800 last:border-0">
                <div className="flex items-center gap-2">
                    <div className={`w-2 h-2 rounded-full ${isPositive ? 'bg-emerald-500' : isNeutral ? 'bg-gray-500' : 'bg-red-500'}`}></div>
                    <Text className="text-sm dark:text-gray-200">{factor.name}</Text>
                    <Text className="text-xs text-gray-500">({factor.ticker})</Text>
                </div>
                <Text className={`text-sm font-mono font-medium ${colorClass}`}>
                    {formattedChange}
                </Text>
            </div>
        );
    };

    const ownFactors = GRANULAR_FACTORS.filter(f => f.category === 'Factors to Own');
    const avoidFactors = GRANULAR_FACTORS.filter(f => f.category === 'Factors to Avoid');

    return (
        <Card className="dark:bg-gray-800">
            <Title className="dark:text-white mb-4">Granular Factor Analysis</Title>

            <Grid numItems={1} numItemsMd={2} className="gap-8">
                {/* Left Column: Factors to Own */}
                <div>
                    <Text className="text-xs font-semibold uppercase text-emerald-500 mb-3 border-b border-emerald-900/30 pb-1">
                        Factors to Own (Bullish Themes)
                    </Text>
                    <div className="flex flex-col">
                        {ownFactors.map(renderFactorRow)}
                    </div>
                </div>

                {/* Right Column: Factors to Avoid */}
                <div>
                    <Text className="text-xs font-semibold uppercase text-red-500 mb-3 border-b border-red-900/30 pb-1">
                        Factors to Avoid (Bearish Themes)
                    </Text>
                    <div className="flex flex-col">
                        {avoidFactors.map(renderFactorRow)}
                    </div>
                </div>
            </Grid>

            <Text className="text-[10px] text-gray-500 mt-4 text-center italic">
                *Performance based on ETF proxies (e.g., ARKK for Unprofitable Tech, IGV for SaaS).
            </Text>
        </Card>
    );
};

export default GranularFactorAnalysis;
