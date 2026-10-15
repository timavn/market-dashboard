'use strict';

// Service construction, provider validation/caches and server middleware stay
// with their existing owners. These factories only isolate the HTTP callbacks.

function createLeveragedProductOverlapHandler({ leveragedProductOverlapService }) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    const baseSymbol = String(req.query.base || '').trim().toUpperCase();
    const referenceSymbol = String(req.query.reference || '').trim().toUpperCase();
    if (!baseSymbol || !referenceSymbol) {
      return res.status(400).json({
        available: false,
        status: 'unavailable',
        weightedOverlapPct: null,
        fromCache: false,
        reason: 'Both base and reference symbols are required.',
      });
    }

    const overlap = await leveragedProductOverlapService.getOverlap({
      baseSymbol,
      referenceSymbol,
    });
    return res.json(overlap);
  };
}

function createExchangeVolumeHandler({ exchangeVolumeService }) {
  return async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const snapshot = await exchangeVolumeService.fetchSnapshot({ days: req.query.days });
    const available = snapshot.meta.status === 'current' || snapshot.exUs?.meta?.status === 'current';
    return res.status(available ? 200 : 503).json(snapshot);
  };
}

function createMarketEventsHandler({ marketEventsService }) {
  return async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const week = req.query?.week;
    if (week !== undefined && week !== 'this' && week !== 'next') {
      return res.status(400).json({
        status: 'unavailable',
        code: 'INVALID_WEEK',
        reason: 'Choose this week or next week.',
        events: [],
      });
    }
    const snapshot = week === 'next'
      ? await marketEventsService.getEvents({ week: 'next' })
      : await marketEventsService.getEvents();
    if (snapshot.status !== 'verified') return res.status(503).json(snapshot);
    return res.json(snapshot);
  };
}

module.exports = {
  createLeveragedProductOverlapHandler,
  createExchangeVolumeHandler,
  createMarketEventsHandler,
};
