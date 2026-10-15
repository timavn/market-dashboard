'use strict';

const { createMarketDailyWorkerService } = require('../services/marketDailyWorkerService.cjs');

function createMarketDailyHandler({ service = createMarketDailyWorkerService() } = {}) {
  return async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      return res.status(200).json(await service.getSnapshot());
    } catch {
      return res.status(200).json({ status: 'unavailable', loading: false });
    }
  };
}

module.exports = { createMarketDailyHandler };
