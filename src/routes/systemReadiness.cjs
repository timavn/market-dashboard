const express = require('express');

function createSystemReadinessRoutes({
  readinessService,
  repairService,
  invalidateResearchProjections = () => {},
  logger = console,
  now = Date.now,
}) {
  const router = express.Router();
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

  // Public requests share the collector's hard budget, including refresh=1.
  router.get('/', async (_req, res) => {
    const startedAt = now();
    try {
      const report = await readinessService.collect();
      return res.json({ ...report, durationMs: now() - startedAt });
    } catch (error) {
      logger.error('[API] System readiness failed:', error);
      return res.status(500).json({
        version: 1,
        status: 'blocked',
        ready: false,
        checkedAt: new Date(now()).toISOString(),
        error: 'System readiness check failed',
        detail: error.message,
      });
    }
  });

  // A live check is read on demand for one controller dispatch decision. It
  // never enters, refreshes, or waits on the cached readiness collection.
  router.get('/checks/:checkId', async (req, res) => {
    try {
      const check = typeof readinessService.collectLiveCheck === 'function'
        ? await readinessService.collectLiveCheck(req.params.checkId)
        : null;
      if (!check) {
        return res.status(404).json({
          code: 'READINESS_LIVE_CHECK_UNKNOWN',
          error: 'That readiness check is not available as a live check.',
        });
      }
      return res.json(check);
    } catch (error) {
      logger.error('[API] Live readiness check failed:', error);
      return res.status(500).json({
        code: 'READINESS_LIVE_CHECK_FAILED',
        error: 'The live readiness check failed.',
      });
    }
  });

  // The service owns the fixed action allowlist and authorization. Neither
  // request body nor forwarded headers become executor arguments.
  router.post('/actions/:actionId', async (req, res) => {
    if (req.get('X-Readiness-Repair') !== '1') {
      return res.status(400).json({
        accepted: false,
        code: 'READINESS_REPAIR_CONFIRMATION_REQUIRED',
        error: 'The readiness repair confirmation header is required.',
      });
    }
    try {
      const result = await repairService.run(req.params.actionId, { remoteAddress: req.socket?.remoteAddress });
      if (req.params.actionId === 'rebuild-research-projections') invalidateResearchProjections();
      return res.status(202).json(result);
    } catch (error) {
      const statusCode = Number(error.statusCode) || 500;
      if (statusCode >= 500) logger.error('[API] System readiness repair failed:', error);
      return res.status(statusCode).json({
        accepted: false,
        code: error.code || 'READINESS_REPAIR_FAILED',
        error: error.message,
      });
    }
  });
  return router;
}

module.exports = { createSystemReadinessRoutes };
