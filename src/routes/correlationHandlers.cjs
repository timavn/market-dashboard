'use strict';

const { unavailableGoldCorrelationSnapshot } = require('../utils/goldCorrelations.cjs');

function createUsdCorrelationHandler({ usdCorrelationService }) {
  return async (req, res) => {
    const startTime = Date.now();
    try {
      const snapshot = await usdCorrelationService.getSnapshot();
      const totalTime = Date.now() - startTime;
      console.log(`[API] /api/usd/correlations completed in ${totalTime}ms (${snapshot.calculationDate})`);
      res.json(snapshot);

    } catch (error) {
      const totalTime = Date.now() - startTime;
      console.error(`[API] Error in /api/usd/correlations after ${totalTime}ms:`, error);
      res.status(503).json({
        correlations: null,
        rollingStats: null,
        timestamp: null,
        calculationDate: null,
        source: 'Yahoo Finance daily bars',
        sourceStatus: 'unavailable',
        error: error.message || 'Current USD correlation data is unavailable',
        code: error.code || 'USD_CORRELATION_DATA_UNAVAILABLE',
      });
    }
  };
}

function createGoldCorrelationHandler({ goldCorrelationService }) {
  return async (req, res) => {
    const startTime = Date.now();
    res.set('Cache-Control', 'no-store');
    try {
      const snapshot = await goldCorrelationService.getSnapshot();
      const totalTime = Date.now() - startTime;
      console.log(`[API] /api/gold/correlations completed in ${totalTime}ms (${snapshot.calculationDate})`);
      res.json(snapshot);
    } catch (error) {
      const totalTime = Date.now() - startTime;
      console.error(`[API] Error in /api/gold/correlations after ${totalTime}ms:`, error);
      res.status(503).json(unavailableGoldCorrelationSnapshot(error));
    }
  };
}

module.exports = { createUsdCorrelationHandler, createGoldCorrelationHandler };
