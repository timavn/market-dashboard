'use strict';

const { createMarketRotationService, buildMarketRotationSnapshot } = require('../services/marketRotationService.cjs');

function createMarketRotationHandler({ service = createMarketRotationService() } = {}) {
  return async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      return res.status(200).json(await service.getSnapshot());
    } catch {
      return res.status(200).json(buildMarketRotationSnapshot());
    }
  };
}

module.exports = { createMarketRotationHandler };
