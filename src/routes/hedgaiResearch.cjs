const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { withHedgaiMarketReadings } = require('../services/hedgaiMarketResearch.cjs');

function createHedgaiResearchLoader({ loadEvents, loadBaseline, buildProjection, now = () => new Date() }) {
  let lastVerifiedEvents = [];
  return async ({ asOf = now().toISOString(), forceRefresh = false, refreshAfter } = {}) => {
    const baseline = loadBaseline();
    let availability = 'available';
    try {
      const result = await loadEvents({ forceRefresh, refreshAfter });
      if (result?.error || !Array.isArray(result?.items)) throw new Error('Research history unavailable');
      lastVerifiedEvents = result.items;
    } catch (_error) {
      availability = 'unavailable';
    }
    return withHedgaiMarketReadings(buildProjection({
      baseline, events: lastVerifiedEvents, asOf, availability,
    }));
  };
}

function createHedgaiResearchHandlers({ loadResearch, loadBaseline, root, now = () => new Date() }) {
  return {
    async research(req, res) {
      const asOf = req.query?.asOf || now().toISOString();
      if (typeof asOf !== 'string' || !/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(asOf)
          || !Number.isFinite(Date.parse(asOf)) || Date.parse(asOf) > now().getTime() + 60_000) {
        return res.status(400).json({ error: 'A valid past research capture time is required.' });
      }
      res.set('Cache-Control', 'no-store');
      try { return res.json(await loadResearch({ asOf, forceRefresh: true, refreshAfter: now().getTime() })); }
      catch (_error) { return res.status(503).json({ error: 'HedgAI research unavailable' }); }
    },
    async source(req, res) {
      const id = req.params?.sourceId;
      if (!/^hedgai-image-[a-f0-9]{64}$/.test(id || '')) return res.sendStatus(404);
      try {
        let source = loadBaseline().sources?.find(item => item.id === id);
        if (!source && loadResearch) source = (await loadResearch()).sources?.find(item => item.id === id);
        if (!source?.artifactPath) return res.sendStatus(404);
        const filename = path.resolve(root, source.artifactPath);
        const allowed = path.resolve(root, 'data/research/hedgai') + path.sep;
        if (!filename.startsWith(allowed)) return res.sendStatus(404);
        const bytes = fs.readFileSync(filename);
        if (crypto.createHash('sha256').update(bytes).digest('hex') !== source.imageSha256) return res.sendStatus(404);
        res.set('Content-Type', 'image/png');
        res.set('Cache-Control', 'private, max-age=86400, immutable');
        return res.send(bytes);
      } catch (_error) { return res.sendStatus(404); }
    },
  };
}

module.exports = { createHedgaiResearchLoader, createHedgaiResearchHandlers };
