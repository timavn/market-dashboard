'use strict';

const { createSnapshotReader } = require('../services/quadResearch/reader.cjs');

function createQuadResearchHandler({ store = createSnapshotReader() } = {}) {
  return async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const edition = await store.latest();
      // Large internal comparison arrays remain in the immutable audit artifact.
      const { groupResults: _groupResults, ...response } = edition;
      return res.status(200).json(response);
    } catch {
      return res.status(503).json({ schemaVersion: 1, source: 'independent-quad-research',
        historicalOnly: true, available: false, cells: [], reason: 'Historical research unavailable.' });
    }
  };
}

module.exports = { createQuadResearchHandler };
