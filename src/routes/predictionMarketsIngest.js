const express = require('express');
const router = express.Router();
const { getAggregatedFinancialPredictionEvents } = require('../services/predictionMarketsIngest');
const { getProviderStatus } = require('../services/predictionMarketsIngest/cache');
const { normalizedToDashboardEvent } = require('../services/predictionMarketsIngest/toDashboardEvent');

// GET /api/prediction-markets/aggregated-events
router.get('/aggregated-events', async (req, res) => {
  try {
    const refreshKalshi = req.query.refresh === 'kalshi' || req.query.refresh === 'all';
    let useMock = req.query.mock === 'true' || process.env.PM_USE_MOCK === 'true';
    const fairProbability = req.query.fair_probability
      ? parseFloat(req.query.fair_probability)
      : null;

    let result = await getAggregatedFinancialPredictionEvents({
      refreshKalshi,
      refreshIbkr: false,
      useMock,
      fairProbability,
    });

    if (!result.events.length && !refreshKalshi && process.env.NODE_ENV !== 'production') {
      useMock = true;
      result = await getAggregatedFinancialPredictionEvents({
        refreshKalshi: false,
        refreshIbkr: false,
        useMock: true,
        fairProbability,
      });
    }

    const dashboardEvents = result.events.map((e) => normalizedToDashboardEvent(e));

    res.json({
      ...result,
      events: result.events,
      dashboardEvents,
    });
  } catch (err) {
    console.error('[PM Ingest] aggregated-events error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/prediction-markets/refresh/ibkr
router.post('/refresh/ibkr', async (req, res) => {
  try {
    const result = await getAggregatedFinancialPredictionEvents({
      refreshKalshi: false,
      refreshIbkr: true,
      fairProbability: req.body?.fair_probability ?? null,
    });
    const dashboardEvents = result.events.map((e) => normalizedToDashboardEvent(e));
    res.json({
      ok: true,
      ...result,
      dashboardEvents,
      providers: getProviderStatus(),
    });
  } catch (err) {
    console.error('[PM Ingest] refresh/ibkr error:', err.message);
    res.status(500).json({
      error: err.message,
      providers: getProviderStatus(),
    });
  }
});

// GET /api/prediction-markets/providers/status
router.get('/providers/status', async (req, res) => {
  try {
    const { checkGatewayHealth } = require('../services/predictionMarketsIngest/providers/ibkrProvider');
    const health = await checkGatewayHealth();
    const providers = getProviderStatus();
    providers.ibkr = {
      ...providers.ibkr,
      gateway: health,
    };
    res.json({ providers });
  } catch (err) {
    console.error('[PM Ingest] providers/status error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
