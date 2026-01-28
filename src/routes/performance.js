
const express = require('express');
const router = express.Router();
const AWS = require('aws-sdk');
const dynamodb = new AWS.DynamoDB.DocumentClient();

const PERFORMANCE_TABLE = 'PerformanceHistory';
const POSITION_PERFORMANCE_TABLE = 'PositionPerformance';

// Helper: Scan table with simple sort
async function getPerformanceHistory(startDateStr) {
    const scanParams = {
        TableName: PERFORMANCE_TABLE,
        FilterExpression: '#date >= :startDate',
        ExpressionAttributeNames: { '#date': 'date' },
        ExpressionAttributeValues: { ':startDate': startDateStr }
    };
    const data = await dynamodb.scan(scanParams).promise();
    return data.Items.sort((a, b) => a.date.localeCompare(b.date));
}

// GET /api/performance/history
router.get('/history', async (req, res) => {
    try {
        const range = req.query.range || 'all';
        const now = new Date();
        let startDate = new Date('2020-01-01'); // Default all time

        if (range === 'ytd' || range === 'all') { // Treat all as YTD for now or specific start
            startDate = new Date(now.getFullYear(), 0, 1);
        } else if (range === '1y') {
            startDate.setFullYear(now.getFullYear() - 1);
        } else if (range === '90d') {
            startDate.setDate(now.getDate() - 90);
        } else if (range === '30d') {
            startDate.setDate(now.getDate() - 30);
        }

        const items = await getPerformanceHistory(startDate.toISOString().split('T')[0]);

        // Transform for frontend if needed? 
        // Frontend `PerformanceTracking` uses `returns` histogram from this endpoint.
        // So we should calculate daily returns if not present.

        const withReturns = items.map((item, idx) => {
            let dailyReturn = 0;
            if (idx > 0) {
                const prev = items[idx - 1];
                const prevVal = parseFloat(prev.summary?.totalValue || 0);
                const currVal = parseFloat(item.summary?.totalValue || 0);
                if (prevVal > 0) {
                    dailyReturn = ((currVal - prevVal) / prevVal) * 100;
                }
            }
            return { ...item, dailyReturn };
        });

        // Extract just returns for histogram
        const returns = withReturns.map(x => x.dailyReturn);

        res.json({
            history: withReturns,
            returns: returns
        });
    } catch (err) {
        console.error("Error fetching performance history:", err);
        res.status(500).json({ error: "Failed to fetch performance history" });
    }
});

// GET /api/performance/equity-curve
router.get('/equity-curve', async (req, res) => {
    try {
        const items = await getPerformanceHistory('2000-01-01'); // Get all

        const dates = [];
        const values = [];
        const drawdowns = [];
        const returns = [];

        let peak = -Infinity;

        items.forEach((item, idx) => {
            const val = parseFloat(item.totalValue || item.summary?.totalValue || 0);
            const date = item.date;

            dates.push(date);
            values.push(val);

            // Drawdown
            if (val > peak) peak = val;
            const dd = peak > 0 ? ((val - peak) / peak) * 100 : 0;
            drawdowns.push(dd);

            // Return
            let ret = 0;
            if (idx > 0) {
                const prev = values[idx - 1];
                if (prev > 0) ret = ((val - prev) / prev) * 100;
            }
            returns.push(ret);
        });

        res.json({ dates, values, drawdowns, returns });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// GET /api/performance/metrics
router.get('/metrics', async (req, res) => {
    try {
        const period = req.query.period || 'all';
        // Calculate metrics based on history
        const items = await getPerformanceHistory('2000-01-01');

        // Filter by period
        const now = new Date();
        let cutoff = new Date('2000-01-01');
        if (period === '30d') cutoff.setDate(now.getDate() - 30);
        else if (period === '90d') cutoff.setDate(now.getDate() - 90);
        else if (period === '1y') cutoff.setFullYear(now.getFullYear() - 1);
        else if (period === 'ytd') cutoff = new Date(now.getFullYear(), 0, 1);

        const filtered = items.filter(x => new Date(x.date) >= cutoff);
        if (filtered.length < 2) return res.json({});

        // Returns array
        const rets = [];
        for (let i = 1; i < filtered.length; i++) {
            const prev = parseFloat(filtered[i - 1].totalValue || filtered[i - 1].summary?.totalValue || 0);
            const curr = parseFloat(filtered[i].totalValue || filtered[i].summary?.totalValue || 0);
            if (prev > 0) rets.push((curr - prev) / prev);
        }

        // Avg Daily Return
        const avgDailyRet = rets.reduce((a, b) => a + b, 0) / rets.length;

        // Volatility (Std Dev of returns) * sqrt(252)
        const variance = rets.reduce((a, b) => a + Math.pow(b - avgDailyRet, 2), 0) / rets.length;
        const dailyVol = Math.sqrt(variance);
        const annVol = dailyVol * Math.sqrt(252);

        // Sharpe (assuming 0 risk free for simplicity or 4%)
        const rf = 0.04 / 252;
        const sharpe = (avgDailyRet - rf) / dailyVol * Math.sqrt(252);

        // Max Drawdown
        let peak = -Infinity;
        let maxDD = 0;
        filtered.forEach(x => {
            const v = parseFloat(x.totalValue || x.summary?.totalValue || 0);
            if (v > peak) peak = v;
            const dd = (v - peak) / peak;
            if (dd < maxDD) maxDD = dd;
        });

        // Win Rate
        const wins = rets.filter(r => r > 0).length;
        const winRate = (wins / rets.length) * 100;

        // Best/Worst Day
        const best = Math.max(...rets) * 100;
        const worst = Math.min(...rets) * 100;

        res.json({
            sharpeRatio: sharpe,
            maxDrawdown: maxDD * 100,
            volatility: annVol * 100,
            winRate: winRate,
            avgDailyReturn: avgDailyRet * 100,
            bestDay: best,
            worstDay: worst,
            rollingReturns: {
                '1m': rets.slice(-21).reduce((a, b) => a + b, 0) * 100, // approx
                'ytd': ((parseFloat(filtered[filtered.length - 1].totalValue || filtered[filtered.length - 1].summary?.totalValue || 0) - parseFloat(filtered[0].totalValue || filtered[0].summary?.totalValue || 0)) / parseFloat(filtered[0].totalValue || filtered[0].summary?.totalValue || 1)) * 100
            },
            vsBenchmark: {
                'SPY': { return: 10.5, alpha: 2.3, beta: 1.1 }, // Mock for now
                'QQQ': { return: 15.2, alpha: -1.5, beta: 1.3 }
            }
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// GET /api/performance/benchmark
router.get('/benchmark', async (req, res) => {
    // Mock benchmark comparison
    // Real implementation requires fetching SPY/QQQ history match dates
    const items = await getPerformanceHistory('2000-01-01');
    const dates = items.map(x => x.date);

    // Mock SPY/QQQ
    const benchmarks = { 'SPY': [], 'QQQ': [] };
    let spyVal = 100;
    let qqqVal = 100;

    dates.forEach(d => {
        spyVal *= (1 + (Math.random() - 0.45) * 0.02);
        qqqVal *= (1 + (Math.random() - 0.45) * 0.03);
        benchmarks['SPY'].push({ date: d, return: (spyVal - 100) });
        benchmarks['QQQ'].push({ date: d, return: (qqqVal - 100) });
    });

    res.json({
        portfolio: items.map(x => ({ date: x.date, return: 0 })), // Should calc cumulative return
        benchmarks: benchmarks
    });
});

// GET /api/performance/statements
router.get('/statements', async (req, res) => {
    try {
        const items = await getPerformanceHistory('2000-01-01');
        // Treat every daily snapshot as a "statement"
        const stmts = items.map(x => ({
            date: x.date,
            totalValue: parseFloat(x.totalValue || x.summary?.totalValue || 0),
            summary: x.summary || {
                totalValue: x.totalValue,
                positionCount: x.positionCount,
                dailyReturn: x.dailyReturn
            }
        })).reverse(); // Newest first

        res.json({ statements: stmts });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/performance/statement/:date
router.get('/statement/:date', async (req, res) => {
    try {
        const date = req.params.date;
        const scanParams = {
            TableName: PERFORMANCE_TABLE,
            FilterExpression: '#date = :d',
            ExpressionAttributeNames: { '#date': 'date' },
            ExpressionAttributeValues: { ':d': date }
        };
        const data = await dynamodb.scan(scanParams).promise();
        const item = data.Items[0];

        if (!item) return res.status(404).json({ error: "Statement not found" });

        // Also fetch holdings details from PositionPerformance if available logic existed
        // But our `process_transaction_history` stores basic stuff.
        // We can check if we stored holdings map in item?
        // CSV Processor:
        // store_performance_data(..., { summary: ... })
        // It does not store full holdings in PerformanceHistory.
        // It uses PositionPerformance for detailed breakdown.

        // Let's fetch detailed positions
        const posParams = {
            TableName: POSITION_PERFORMANCE_TABLE,
            FilterExpression: '#date = :d',
            ExpressionAttributeNames: { '#date': 'date' },
            ExpressionAttributeValues: { ':d': date }
        };
        const posData = await dynamodb.scan(posParams).promise();

        res.json({
            ...item,
            holdings: posData.Items
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
