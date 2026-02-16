import React, { useState, useEffect } from 'react';
import { MarketDataService } from '../../services/api/marketDataService';

const MarketVolumeTable = () => {
    const [loading, setLoading] = useState(true);
    const [metrics, setMetrics] = useState({
        date: '',
        totalMarket: {
            priorDay: null,
            avg1M: null,
            avg3M: null,
            avg1Y: null,
            pct1M: null,
            pct3M: null,
            pct1Y: null
        },
        exchange: {
            priorDay: null,
            avg1M: null,
            avg3M: null,
            avg1Y: null,
            pct1M: null,
            pct3M: null,
            pct1Y: null
        }
    });

    useEffect(() => {
        const fetchData = async () => {
            try {
                const daysToFetch = 365; // Need 1 year of data
                const tickers = ['VTI', 'SPY', 'QQQ', 'IWM'];

                // Parallel data fetch
                const promises = tickers.map(ticker =>
                    MarketDataService.getHistoricalData(ticker, daysToFetch)
                );

                const results = await Promise.all(promises);
                const dataMap = {};
                tickers.forEach((ticker, index) => {
                    dataMap[ticker] = results[index].data || [];
                });

                // Helper to get formatted date string YYYY-MM-DD
                const getDateStr = (dateObj) => {
                    return dateObj.toISOString().split('T')[0];
                };

                // Align data by date
                // Find common dates across all tickers to ensure accuracy
                // For simplicity, we'll drive off VTI dates
                const totalMarketData = dataMap['VTI'].sort((a, b) => new Date(b.date) - new Date(a.date)); // Descending

                if (totalMarketData.length < 2) {
                    setLoading(false);
                    return;
                }

                // Most recent completed day (Prior Day)
                const priorDayData = totalMarketData[0];
                const priorDayDate = new Date(priorDayData.date);

                // Format date 1/9 vs.
                const dateMonth = priorDayDate.getMonth() + 1;
                const dateDay = priorDayDate.getDate();
                const formattedDate = `${dateMonth}/${dateDay}`;

                // Calculations helper
                const calculateMetrics = (volumeHistory) => {
                    // volumeHistory is array of volumes, sorted descending (newest first)
                    // exclude index 0 if it's "today" and incomplete, but here we assume API returns closed days.
                    // If the latest data point is 'today' and market is open, it might be partial.
                    // For safety, let's assume index 0 is the "Prior Day" we are reporting on.

                    const priorDayVol = volumeHistory[0];

                    // 1M Average (approx 21 trading days) - exclude current day? 
                    // The screenshot implies "2/12 vs 1M Ave". Usually means vs the average of the last month.
                    // We'll calculate average of the *preceding* window to compare against.
                    // Or average of the window *including* today? "vs 1M Ave" usually implies a moving average.
                    // Let's use 21 days trailing average includes today? Or previous 21 days?
                    // Standard is usually trailing average. Let's use previous 21 days for "1M Ave".
                    // Actually, "Volume vs 1M Avg" is typically: Today's Vol / Avg(Last 20 Days).

                    const slice1M = volumeHistory.slice(1, 22);
                    const slice3M = volumeHistory.slice(1, 64);
                    const slice1Y = volumeHistory.slice(1, 253);

                    const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;

                    const avg1M = slice1M.length > 0 ? avg(slice1M) : 0;
                    const avg3M = slice3M.length > 0 ? avg(slice3M) : 0;
                    const avg1Y = slice1Y.length > 0 ? avg(slice1Y) : 0;

                    const calcPctDiff = (current, baseline) => {
                        if (!baseline || baseline === 0) return 0;
                        return ((current - baseline) / baseline) * 100;
                    };

                    const yesterday = volumeHistory[1];

                    return {
                        priorDay: priorDayVol,
                        avg1M: avg1M,
                        avg3M: avg3M,
                        avg1Y: avg1Y,
                        pctPriorDay: yesterday ? calcPctDiff(priorDayVol, yesterday) : null,
                        pct1M: calcPctDiff(priorDayVol, avg1M),
                        pct3M: calcPctDiff(priorDayVol, avg3M),
                        pct1Y: calcPctDiff(priorDayVol, avg1Y),
                    };
                };

                // 1. Total Market (VTI)
                const vtiVolumes = totalMarketData.map(d => d.volume);
                const totalMarketMetrics = calculateMetrics(vtiVolumes);

                // 2. Total Exchange (SPY + QQQ + IWM)
                // We need to sum volumes for each day
                const combinedVolumes = [];
                // Iterate through VTI dates to sync
                totalMarketData.forEach(vtiItem => {
                    const dateStr = vtiItem.date; // YYYY-MM-DD

                    // Find corresponding records in others
                    const spyItem = dataMap['SPY'].find(d => d.date === dateStr);
                    const qqqItem = dataMap['QQQ'].find(d => d.date === dateStr);
                    const iwmItem = dataMap['IWM'].find(d => d.date === dateStr);

                    if (spyItem && qqqItem && iwmItem) {
                        const totalVol = (spyItem.volume || 0) + (qqqItem.volume || 0) + (iwmItem.volume || 0);
                        combinedVolumes.push(totalVol);
                    }
                });

                const exchangeMetrics = calculateMetrics(combinedVolumes);

                setMetrics({
                    date: formattedDate,
                    totalMarket: totalMarketMetrics,
                    exchange: exchangeMetrics
                });
                setLoading(false);

            } catch (error) {
                console.error("Failed to fetch volume data", error);
                setLoading(false);
            }
        };

        fetchData();
    }, []);

    const formatPct = (val) => {
        if (val === null || isNaN(val)) return '--';
        const num = Math.round(val);
        return `${num}%`;
    };

    const getColor = (val) => {
        if (val === null || isNaN(val)) return 'dark:text-gray-300';
        // Logic: Higher volume is generally "neutral/context dependent", but in the screenshot:
        // Red seems to be negative? Screenshot has "5%" in black/default, but arrow is red?
        // Actually screenshot: "Total Exchange Volume ... 7% ... 9%"
        // The red arrow points to 9%.
        // Let's stick to standard color coding: Green > 0, Red < 0 ??
        // In screenshot: 7% is black. -4% in previous "LiquidityCard" was red.
        // Let's use simple text color: Black/White for values.
        // Wait, the screenshot "2/12 vs." table has percentages.
        // "5%" is Black. "9%" is Black.
        // Let's just use standard text color for now unless strict coloring is requested.
        return 'dark:text-gray-200';
    };

    // Helper for Variance Cells (1M, 3M, 1Y)
    // Screenshot shows these are just percentages: "5%", "16%", "16%"
    // Wait, the screenshot column headers are "1M Ave", "3M Ave".
    // The VALUES under them are percentages.
    // This implies the table shows the VARIANCE vs that average.
    // "Prior Day: 7%" (Variance vs ?? Or just volume?)
    // Actually, look closely at screenshot:
    // "Prior Day" column has "7%".
    // "1M Ave" column has "5%".
    // This likely means: "Volume was 7% above prior day??" No.
    // "2/12 vs." is the header context.
    // Row 1: "Total Market Volume"
    // Col "Prior Day": 7% -> Volume on 2/12 was 7% higher than 2/11?
    // Col "1M Ave": 5% -> Volume on 2/12 was 5% higher than 1M Ave?
    // Col "3M Ave": 16% -> Volume on 2/12 was 16% higher than 3M Ave?
    // Yes, "2/12 vs." implies the comparison of CURRENT vs historical baselines.
    // So all displayed values are % diff of [Current Day] vs [Baseline].
    // Including "Prior Day". (Current vs Yesterday).

    // Wait, if that's the case:
    // "Prior Day" column = % change from previous day.
    // "1M Ave" column = % diff from 1M Average.

    // Implemented logic above `calcPctDiff` does exactly this for Averages.
    // Need to add `vsPriorDay` calculation.

    if (loading) {
        return (
            <div className="text-xs text-center p-4 dark:text-gray-400">Loading Volume...</div>
        );
    }

    // Calculate Prior Day comparison (Day over Day)
    // We need the previous day's volume.
    // Inside calculateMetrics, `volumeHistory[1]` is the previous day.
    // Use that.

    // Re-render with DoD logic will be tricky inside the return.
    // Better to update state with DoD.
    // NOTE: Logic update done in-flight here.

    return (
        <div className="mt-2 text-[10px]" style={{ fontFamily: 'Inter, sans-serif' }}>
            {/* Header Strip mimicking screenshot - Black bar with white text */}
            <div className="flex bg-black text-white px-2 py-1 items-center justify-between">
                <div className="font-bold uppercase tracking-wider">Index/Security</div>
                <div className="flex gap-4">
                    <div className="font-bold">VOLUME:</div>
                    <div className="font-bold">{metrics.date} vs.</div>
                </div>
            </div>



            <div className="grid grid-cols-6 gap-2 px-2 py-1 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-500 dark:text-gray-400 font-bold text-right text-[9px] uppercase">
                <div className="col-span-2 text-left underline decoration-dotted decoration-gray-400"></div>
                <div>Prior Day</div>
                <div>1M Ave</div>
                <div>3M ave</div>
                <div>1Y Ave</div>
            </div>

            {/* Total Market Volume Row */}
            <div className="grid grid-cols-6 gap-2 px-2 py-2 border-b border-dotted border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 items-center">
                <div className="col-span-2 text-left font-bold text-black dark:text-white">
                    Total Market Volume*
                </div>

                <div className="text-right font-medium dark:text-gray-200">
                    {/* Need DoD change here. 
                    If `pct1M` is Current vs 1M, we need Current vs Yesterday.
                */}
                    {/* Placeholder logic for calculation display */}
                    {formatPct(metrics.totalMarket.pctPriorDay)}
                </div>
                <div className="text-right font-medium dark:text-gray-200">{formatPct(metrics.totalMarket.pct1M)}</div>
                <div className="text-right font-medium dark:text-gray-200">{formatPct(metrics.totalMarket.pct3M)}</div>
                <div className="text-right font-medium dark:text-gray-200">{formatPct(metrics.totalMarket.pct1Y)}</div>
            </div>

            {/* Total Exchange Volume Row */}
            <div className="grid grid-cols-6 gap-2 px-2 py-2 bg-white dark:bg-gray-800 items-center">
                <div className="col-span-2 text-left font-bold text-black dark:text-white">
                    Total Exchange Volume**
                </div>

                <div className="text-right font-medium dark:text-gray-200">{formatPct(metrics.exchange.pctPriorDay)}</div>
                <div className="text-right font-medium dark:text-gray-200">{formatPct(metrics.exchange.pct1M)}</div>
                <div className="text-right font-medium dark:text-gray-200">{formatPct(metrics.exchange.pct3M)}</div>
                <div className="text-right font-medium dark:text-gray-200">{formatPct(metrics.exchange.pct1Y)}</div>
            </div>

            {/* Footnotes */}
            <div className="mt-4 space-y-1 text-[8px] text-gray-500 dark:text-gray-400 italic">
                <p>*Total Market Volume = VTI Proxy (Vanguard Total Stock Market ETF)</p>
                <p>**Total Exchange Volume = Aggregated Volume (SPY + QQQ + IWM)</p>
            </div>
        </div>
    );
};

export default MarketVolumeTable;
