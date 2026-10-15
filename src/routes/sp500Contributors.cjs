'use strict';

const { createSp500ContributorsWorkerService } = require('../services/sp500ContributorsWorkerService.cjs');
const { projectMomoRosterContext } = require('../services/analyst/momoRosterContext.cjs');

function createSp500ContributorsHandler({
  service = createSp500ContributorsWorkerService(),
  loadMomoSnapshot = async () => null,
  publicationTimeoutMs = 5_000,
  now = Date.now,
} = {}) {
  return async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      let timer;
      let publicationFailed = false;
      // A missing or failed research publication must not suppress independently
      // verified company data, nor carry forward yesterday's MOMO additions.
      const momoSnapshot = await Promise.race([
        Promise.resolve().then(loadMomoSnapshot).catch(() => { publicationFailed = true; return null; }),
        new Promise(resolve => {
          timer = setTimeout(() => { publicationFailed = true; resolve(null); }, publicationTimeoutMs);
        }),
      ]).finally(() => clearTimeout(timer));
      const snapshot = await service.getSnapshot({ momoSnapshot });
      const current = publicationFailed ? { ...snapshot, momoStatus: 'unavailable' } : snapshot;
      if (req.query?.context === 'analyst') return res.status(snapshot.status === 'available' ? 200 : 503)
        .json(projectMomoRosterContext(current, { nowMs: now() }));
      return res.status(snapshot.status === 'available' ? 200 : 503)
        .json(current);
    } catch {
      return res.status(503).json({ status: 'unavailable', rows: [] });
    }
  };
}

module.exports = { createSp500ContributorsHandler };
