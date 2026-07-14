import React, { useState, useEffect, useMemo } from 'react';
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

const SecurityDetailModal = ({ ticker, isOpen, onClose }) => {
    const { theme } = useTheme();
    const isDark = theme === 'dark';
    const [loading, setLoading] = useState(true);
    const [data, setData] = useState(null);
    const [error, setError] = useState(null);

    useEffect(() => {
        if (isOpen && ticker) {
            fetchSecurityDetails();
        }
    }, [isOpen, ticker]);

    const fetchSecurityDetails = async () => {
        try {
            setLoading(true);
            setError(null);
            // HARDCODED URL for now to ensure it hits the right port if proxy isn't working
            // Ideally use a service configuration
            const response = await axios.get(`http://localhost:3001/api/performance/security/${ticker}`);
            setData(response.data);
        } catch (err) {
            console.error('Error fetching security details:', err);
            setError('Failed to load security details');
        } finally {
            setLoading(false);
        }
    };

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

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50 p-4 backdrop-blur-sm">
            <div
                className="relative w-full max-w-5xl max-h-[90vh] overflow-y-auto rounded-xl shadow-2xl"
                style={{ backgroundColor: isDark ? '#111827' : '#ffffff' }}
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
                                                <stop offset="5%" stopColor="#ef4444" stopOpacity={0.1} />
                                                <stop offset="95%" stopColor="#ef4444" stopOpacity={0.1} />
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
                                        <Line type="monotone" dataKey="hrr" stroke="#ef4444" strokeDasharray="3 3" dot={false} strokeWidth={1} name="Top of Risk" />
                                        <Line type="monotone" dataKey="lrr" stroke="#22c55e" strokeDasharray="3 3" dot={false} strokeWidth={1} name="Bottom of Risk" />

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
                                                    fill={t.action.toLowerCase().includes('buy') ? '#22c55e' : '#ef4444'}
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
        </div>
    );
};

export default SecurityDetailModal;
