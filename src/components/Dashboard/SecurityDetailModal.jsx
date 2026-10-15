import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Card, Title, Text, Metric, Grid, Badge } from '@tremor/react';
import {
    ComposedChart,
    Line,
    Area,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    ResponsiveContainer,
    ReferenceDot,
    Legend
} from 'recharts';
import XMarkIcon from '@heroicons/react/24/solid/XMarkIcon';
import LoadingIndicator from '../common/LoadingIndicator';
import axios from 'axios';
import { useTheme } from '../../context/ThemeContext';
import { MarketDataService } from '../../services/api/marketDataService';
import { SECURITY_INTELLIGENCE_V2_ENABLED } from '../../hooks/useSecurityIntelligence';
import { canonicalProductState, getCanonicalRiskRange } from '../../utils/securityIntelligenceV2';
import { canonicalTradeResearch } from '../../utils/canonicalTradeResearch.cjs';
import { formatResearchSourceDate, formatResearchTime } from '../../utils/researchDateFormat';
import useHedgaiTickResearch from '../../hooks/useHedgaiTickResearch';
import DashboardResearchLabel from './DashboardResearchLabel';

const SecurityDetailModal = ({ ticker, isOpen, onClose }) => {
    const { theme } = useTheme();
    const isDark = theme === 'dark';
    const [loading, setLoading] = useState(true);
    const [data, setData] = useState(null);
    const [error, setError] = useState(null);
    const [researchError, setResearchError] = useState(null);
    const [canonicalResearch, setCanonicalResearch] = useState(null);
    const [tradeResearch, setTradeResearch] = useState(null);
    const { readings: tickReadings } = useHedgaiTickResearch({ active: isOpen });
    const tickReading = tickReadings[String(ticker || '').toUpperCase()];
    const tickEvidence = tickReading?.verified === true ? tickReading.tickEvidence : null;

    const fetchSecurityDetails = useCallback(async () => {
        try {
            setLoading(true);
            setError(null);
            setResearchError(null);
            setTradeResearch(null);
            if (SECURITY_INTELLIGENCE_V2_ENABLED) setCanonicalResearch(null);
            // HARDCODED URL for now to ensure it hits the right port if proxy isn't working
            // Ideally use a service configuration
            const [performanceResult, canonicalResult] = await Promise.allSettled([
                axios.get(`http://localhost:3001/api/performance/security/${ticker}`),
                MarketDataService.getSecurityIntelligenceV2({ symbols: [ticker], historyDays: 0 }),
            ]);
            if (canonicalResult.status === 'fulfilled') {
                const publishedTrade = canonicalTradeResearch(canonicalResult.value, ticker);
                setTradeResearch(publishedTrade.status === 'available' ? publishedTrade : null);
            }
            if (performanceResult.status === 'rejected') throw performanceResult.reason;

            let nextData = performanceResult.value.data;
            let nextCanonicalResearch = null;
            if (SECURITY_INTELLIGENCE_V2_ENABLED) {
                if (canonicalResult.status === 'fulfilled' && canonicalResult.value?.schemaVersion === 2) {
                    nextCanonicalResearch = canonicalResult.value.bySymbol?.[ticker.toUpperCase()] || null;
                    const canonicalRange = getCanonicalRiskRange(nextCanonicalResearch, { primaryOnly: true });
                    const canonicalDate = canonicalResult.value.marketDate || canonicalRange?.date || null;
                    const historicalRanges = Array.isArray(nextData?.riskRanges)
                        ? nextData.riskRanges.filter((range) => range?.date !== canonicalDate)
                        : [];
                    nextData = {
                        ...nextData,
                        riskRanges: canonicalRange
                            ? [...historicalRanges, {
                                date: canonicalRange.date,
                                lrr: canonicalRange.lrr,
                                hrr: canonicalRange.hrr,
                                trend: canonicalRange.trend,
                                timestamp: canonicalRange.timestamp,
                                status: canonicalProductState(nextCanonicalResearch?.products?.['risk-ranges']),
                            }]
                            : historicalRanges,
                    };
                } else {
                    setResearchError(
                        canonicalResult.reason?.message || 'Canonical current security research is unavailable.',
                    );
                }
            }
            setCanonicalResearch(nextCanonicalResearch);
            setData(nextData);
        } catch (err) {
            console.error('Error fetching security details:', err);
            setError('Failed to load security details');
        } finally {
            setLoading(false);
        }
    }, [ticker]);

    useEffect(() => {
        if (isOpen && ticker) {
            fetchSecurityDetails();
        }
    }, [fetchSecurityDetails, isOpen, ticker]);

    const chartData = useMemo(() => {
        if (!data?.prices) return [];

        // Merge prices with risk ranges and transactions
        // Create a map by date
        const merged = {};

        // 1. Add Prices
        data.prices.forEach(p => {
            merged[p.date] = {
                date: p.date,
                price: parseFloat(p.close || p.price),
                lrr: null,
                hrr: null,
                transactions: []
            };
        });

        // 2. Add Risk Ranges
        if (data.riskRanges) {
            data.riskRanges.forEach(r => {
                if (merged[r.date]) {
                    merged[r.date].lrr = parseFloat(r.lrr);
                    merged[r.date].hrr = parseFloat(r.hrr);
                }
            });
        }

        // 3. Add Transactions (for logging/markers)
        if (data.transactions) {
            data.transactions.forEach(t => {
                if (merged[t.date]) {
                    merged[t.date].transactions.push(t);
                }
            });
        }

        return Object.values(merged).sort((a, b) => a.date.localeCompare(b.date));
    }, [data]);

    const stats = useMemo(() => {
        if (!data?.dailyPerformance) return {};

        // Calculate basic stats
        const perf = data.dailyPerformance;
        const totalDays = perf.length;
        let winningDays = 0;
        let totalGain = 0;

        perf.forEach(p => {
            const pl = parseFloat(p.dailyPnL || 0);
            if (pl > 0) winningDays++;
            totalGain += pl;
        });

        return {
            winRate: totalDays > 0 ? (winningDays / totalDays) * 100 : 0,
            totalPnL: totalGain,
            daysHeld: totalDays
        };
    }, [data]);

    if (!isOpen) return null;
    const researchNeedsAttention = SECURITY_INTELLIGENCE_V2_ENABLED
        && !loading
        && (researchError || !canonicalResearch || canonicalResearch.health?.status !== 'ready');

    return createPortal(
        <div
            className="dashboard-security-detail-host fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50 p-4 backdrop-blur-sm"
            onClick={(event) => {
                if (event.target === event.currentTarget) onClose();
            }}
        >
            <div
                className="dashboard-security-detail-dialog relative w-full max-w-5xl max-h-[90vh] overflow-y-auto rounded-xl shadow-2xl"
                style={{
                    backgroundColor: researchNeedsAttention ? '#fef2f2' : isDark ? '#111827' : '#ffffff',
                }}
            >
                {/* Close Button */}
                <button
                    onClick={onClose}
                    className="absolute top-4 right-4 p-2 rounded-full hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
                >
                    <XMarkIcon className="w-6 h-6 text-gray-500" />
                </button>

                <div className="p-6 space-y-6">
                    {/* Header */}
                    <div>
                        <Title className="text-2xl font-bold flex items-center gap-3">
                            {ticker} Details
                            {loading && (
                              <LoadingIndicator label="Loading..." size="sm" className="inline-flex ml-2" />
                            )}
                        </Title>
                        <div className="flex flex-wrap items-center gap-4 text-sm font-normal">
                        <div className="flex items-center gap-2" aria-label={`${ticker} published Tick`}>
                            <DashboardResearchLabel label={ticker} reading={tickReading} showName={false} showUnavailable tickFormat="full" />
                            {tickEvidence && <>
                                <span aria-hidden="true">·</span>
                                <a href={tickEvidence.sourceUrl} target="_blank" rel="noreferrer"
                                    style={{ color: 'inherit', textDecoration: 'none' }} title={tickEvidence.evidenceText}>
                                    {tickEvidence.source}
                                </a>
                                <span>· {formatResearchSourceDate(tickEvidence.date)}</span>
                            </>}
                        </div>
                        <div className="flex items-center gap-2" aria-label={`${ticker} published Trade`}>
                            <span>Trade</span>
                            <span className={tradeResearch?.direction === 'BULLISH' ? 'text-green-700' : tradeResearch?.direction === 'BEARISH' ? 'text-red-700' : 'text-gray-500'}>
                                {tradeResearch ? tradeResearch.direction[0] + tradeResearch.direction.slice(1).toLowerCase() : '—'}
                            </span>
                            {tradeResearch && <>
                                <span aria-hidden="true">·</span>
                                <a href={tradeResearch.sourceUrl} target="_blank" rel="noreferrer"
                                    style={{ color: 'inherit', textDecoration: 'none' }}
                                    title={tradeResearch.signalProvenance.sourceText}>
                                    {tradeResearch.sourceLabel || tradeResearch.source}
                                </a>
                                <span>· {formatResearchSourceDate(tradeResearch.sourceDate)}{formatResearchTime(tradeResearch.sourcePublishedAt) !== '—' ? ` ${formatResearchTime(tradeResearch.sourcePublishedAt)} ET` : ''}</span>
                            </>}
                        </div>
                        </div>
                        {data?.transactions?.length > 0 && (
                            <Text className="text-sm text-gray-500">
                                {data.transactions.length} Transactions found
                            </Text>
                        )}
                    </div>

                    {error && (
                        <div className="p-4 bg-red-100 text-red-700 rounded-lg">
                            {error}
                        </div>
                    )}
                    {researchError && (
                        <div className="p-4 bg-red-100 text-red-700 rounded-lg">
                            {researchError}
                        </div>
                    )}

                    {!loading && data && (
                        <>
                            {/* Key Stats */}
                            <Grid numItems={2} numItemsSm={4} className="gap-4">
                                <Card decoration="top" decorationColor="blue" className="p-4">
                                    <Text>Total P&L</Text>
                                    <Metric className={stats.totalPnL >= 0 ? 'text-green-500' : 'text-red-500'}>
                                        {new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(stats.totalPnL)}
                                    </Metric>
                                </Card>
                                <Card decoration="top" decorationColor="indigo" className="p-4">
                                    <Text>Win Rate (Days)</Text>
                                    <Metric>{stats.winRate.toFixed(1)}%</Metric>
                                </Card>
                                <Card decoration="top" decorationColor="fuchsia" className="p-4">
                                    <Text>Days Held</Text>
                                    <Metric>{stats.daysHeld}</Metric>
                                </Card>
                                <Card decoration="top" decorationColor="amber" className="p-4">
                                    <Text>Latest Price</Text>
                                    <Metric>
                                        {chartData.length > 0 ?
                                            new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(chartData[chartData.length - 1].price)
                                            : 'N/A'}
                                    </Metric>
                                </Card>
                            </Grid>

                            {/* Main Chart */}
                            <Card>
                                <Title>Price & Risk Ranges</Title>
                                <ResponsiveContainer width="100%" height={400}>
                                    <ComposedChart data={chartData} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
                                        <defs>
                                            <linearGradient id="riskRangeGradient" x1="0" y1="0" x2="0" y2="1">
                                                <stop offset="5%" stopColor="#dc2626" stopOpacity={0.1} />
                                                <stop offset="95%" stopColor="#dc2626" stopOpacity={0.1} />
                                            </linearGradient>
                                        </defs>
                                        <CartesianGrid strokeDasharray="3 3" stroke={isDark ? '#374151' : '#e5e7eb'} vertical={false} />
                                        <XAxis
                                            dataKey="date"
                                            stroke={isDark ? '#9ca3af' : '#6b7280'}
                                            tickFormatter={(d) => new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                                            minTickGap={30}
                                        />
                                        <YAxis
                                            domain={['auto', 'auto']}
                                            stroke={isDark ? '#9ca3af' : '#6b7280'}
                                            tickFormatter={(val) => `$${val}`}
                                        />
                                        <Tooltip
                                            contentStyle={{
                                                backgroundColor: isDark ? '#1f2937' : '#fff',
                                                borderColor: isDark ? '#374151' : '#e5e7eb',
                                                color: isDark ? '#fff' : '#000'
                                            }}
                                            labelFormatter={(d) => new Date(d).toLocaleDateString()}
                                        />
                                        <Legend />

                                        {/* Risk Ranges (Area) */}
                                        <Area
                                            type="monotone"
                                            dataKey="hrr"
                                            stroke="transparent"
                                            fill="transparent"
                                            connectNulls
                                        />
                                        <Area
                                            type="monotone"
                                            dataKey="lrr"
                                            stroke="transparent"
                                            fill="transparent"
                                            connectNulls
                                        />
                                        {/* We ideally want a range area, but Recharts Area uses 0 as base. 
                                    To do a range area, we generally need custom shape or stacked areas.
                                    Simplified: Just plot lines for now or use range chart if supported.
                                    Actually, let's just plot Line for LRR/HRR for clarity first.
                                */}
                                        <Line type="monotone" dataKey="hrr" stroke="#dc2626" strokeDasharray="3 3" dot={false} strokeWidth={1} name="Top of Risk" />
                                        <Line type="monotone" dataKey="lrr" stroke="#059669" strokeDasharray="3 3" dot={false} strokeWidth={1} name="Bottom of Risk" />

                                        <Line
                                            type="monotone"
                                            dataKey="price"
                                            stroke="#3b82f6"
                                            strokeWidth={2}
                                            dot={false}
                                            name="Close Price"
                                        />

                                        {/* Transaction Markers */}
                                        {chartData.map((d, i) => (
                                            d.transactions.map((t, idx) => (
                                                <ReferenceDot
                                                    key={`${d.date}-${idx}`}
                                                    x={d.date}
                                                    y={d.price}
                                                    r={5}
                                                    fill={t.action.toLowerCase().includes('buy') ? '#059669' : '#dc2626'}
                                                    stroke="white"
                                                    strokeWidth={1}
                                                />
                                            ))
                                        ))}
                                    </ComposedChart>
                                </ResponsiveContainer>
                            </Card>

                            {/* Transaction History Table */}
                            <Card className="overflow-hidden">
                                <Title>Trade History</Title>
                                <div className="mt-4 overflow-x-auto">
                                    <table className="w-full text-sm text-left">
                                        <thead className="text-xs uppercase bg-gray-50 dark:bg-gray-800 text-gray-500 dark:text-gray-400">
                                            <tr>
                                                <th className="px-4 py-2">Date</th>
                                                <th className="px-4 py-2">Action</th>
                                                <th className="px-4 py-2 text-right">Qty</th>
                                                <th className="px-4 py-2 text-right">Price</th>
                                                <th className="px-4 py-2 text-right">Amount</th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                                            {data.transactions.map((t, i) => (
                                                <tr key={i} className="hover:bg-gray-50 dark:hover:bg-gray-800">
                                                    <td className="px-4 py-2 font-medium">{t.date}</td>
                                                    <td className="px-4 py-2">
                                                        <Badge color={t.action.toLowerCase().includes('buy') ? 'green' : 'red'} size="xs">
                                                            {t.action}
                                                        </Badge>
                                                    </td>
                                                    <td className="px-4 py-2 text-right">{t.quantity}</td>
                                                    <td className="px-4 py-2 text-right">${parseFloat(t.price).toFixed(2)}</td>
                                                    <td className="px-4 py-2 text-right text-gray-500">${parseFloat(t.amount).toLocaleString()}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            </Card>
                        </>
                    )}
                </div>
            </div>
        </div>,
        document.body,
    );
};

export default SecurityDetailModal;
