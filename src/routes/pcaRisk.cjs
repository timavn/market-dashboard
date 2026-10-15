const express = require('express');

function createPcaRiskRouter({ service } = {}) {
  const router = express.Router();
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Data-Use', 'historical-research-only');
    next();
  });
  const handle = action => async (req, res) => {
    try { await action(req, res); }
    catch (error) {
      const status = [400, 404, 422].includes(error.status) ? error.status : 503;
      res.status(status).json({ status: 'unavailable', historicalOnly: true, executable: false,
        ...(status === 422 && error.code === 'post_close_required' ? { code: error.code } : {}),
        error: status === 503 ? 'PCA data is unavailable.' : error.message });
    }
  };
  router.get('/snapshot', handle(async (req, res) => res.json(await service.snapshot({
    account: req.query.account, window: req.query.window, id: req.query.id,
  }))));
  router.get('/history', handle(async (req, res) => res.json({ snapshots: await service.history(req.query) })));
  router.get('/config', handle(async (req, res) => res.json({ config: await service.config(req.query.account) })));
  router.put('/config', handle(async (req, res) => res.json({ config: await service.saveConfig(req.body?.account, req.body || {}) })));
  router.post('/refresh', handle(async (req, res) => res.status(202).json(await service.refresh({ account: req.body?.account, window: req.body?.window }))));
  router.post('/compare', handle(async (req, res) => res.json(await service.compare(req.body || {}))));
  return router;
}

module.exports = { createPcaRiskRouter };
