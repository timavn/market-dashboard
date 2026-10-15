'use strict';

const VOL_YAHOO_SYMBOLS = { vix: '^VIX', vvix: '^VVIX', rvx: '^RVX' };

function createVixHandler({ fetchVIXData }) {
  return async (req, res) => {
    try {
      const vixData = await fetchVIXData();
      res.json(vixData);
    } catch (error) {
      console.error('Error in VIX endpoint:', error);
      res.status(500).json({ error: 'Failed to fetch VIX data' });
    }
  };
}

function createVolatilityHandler({ fetchVolatilityData }) {
  return async (req, res) => {
    const ticker = (req.params.ticker || '').toLowerCase();
    const yahooSymbol = VOL_YAHOO_SYMBOLS[ticker];
    if (!yahooSymbol) {
      return res.status(400).json({ error: `Unknown volatility ticker: ${req.params.ticker}. Use vix, vvix, or rvx.` });
    }
    try {
      const data = await fetchVolatilityData(yahooSymbol);
      res.json(data);
    } catch (error) {
      console.error(`Error in volatility endpoint (${ticker}):`, error);
      res.status(500).json({ error: `Failed to fetch ${ticker.toUpperCase()} data` });
    }
  };
}

function createVolatilitySnapshotHandler({ volatilitySnapshotService }) {
  return async (req, res) => {
    try {
      const snapshot = await volatilitySnapshotService.fetchSnapshot();
      return res.status(snapshot.status === 'unavailable' ? 503 : 200).json(snapshot);
    } catch (error) {
      console.error('[volatility-snapshot] unexpected snapshot failure:', error);
      return res.status(503).json({
        status: 'unavailable',
        generatedAt: new Date().toISOString(),
        lastUpdated: null,
        error: 'Volatility providers are unavailable',
      });
    }
  };
}

module.exports = { createVixHandler, createVolatilityHandler, createVolatilitySnapshotHandler };
