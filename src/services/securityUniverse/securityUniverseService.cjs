'use strict';

const { SECURITY_SYMBOL } = require('../../utils/securitySymbols.cjs');
const { createPieceCache } = require('./pieceCache.cjs');
const { emptyIdentity } = require('./pieces/identity.cjs');
const { emptyResearch } = require('./pieces/research.cjs');
const { emptyStance } = require('./pieces/stance.cjs');
const { emptyActivity, emptyRisk } = require('./pieces/marketHistory.cjs');

const PIECES = Object.freeze(['identity', 'research', 'stance', 'risk', 'activity']);
const MAX_SYMBOLS = 50;
const HOUR_MS = 60 * 60_000;
// Each piece refreshes on its own cadence: names change rarely, research on
// publication, the stance book every scan, and daily bars ride the shared
// one-hour history cache (no second cache here).
const TTL = Object.freeze({
  identity: { ttlMs: 24 * HOUR_MS, failureTtlMs: 5 * 60_000 },
  research: { ttlMs: 60_000, failureTtlMs: 30_000 },
});
const usable = piece => piece?.status === 'available' || piece?.status === 'partial';
// A partial identity usually means a Yahoo lookup failed; retry it on the failure
// cadence instead of pinning a SEC registrant name for a day.
const identityUsable = piece => piece?.status === 'available';

// The one per-ticker record every dashboard surface reads: identity, research
// decisions, product calls, risk and sizing, and recent activity, each fact with
// its own source and as-of date. A piece that fails is unavailable with a reason
// and never holds back the others; nothing falls back to mock, seeded or stale data.
function createSecurityUniverseService({ resolveInstrument = () => null, identity, research, stance, marketHistory, now = Date.now, ttl = TTL } = {}) {
  const identityCache = createPieceCache({ ...ttl.identity, now });
  const researchCache = createPieceCache({ ...ttl.research, now });

  const cached = (cache, piece, empty, symbols, isUsable = usable) => cache.getMany(symbols, {
    load: batch => piece.loadMany(batch), usable: isUsable, failed: () => empty('piece-unavailable'),
  });
  const guarded = async (load, empty, symbols) => {
    try { return await load(); } catch { return new Map(symbols.map(symbol => [symbol, empty('piece-unavailable')])); }
  };

  const identities = symbols => cached(identityCache, identity, emptyIdentity, symbols, identityUsable);

  async function load(requested, { fields = PIECES } = {}) {
    const symbols = [...new Set((requested || []).map(symbol => String(symbol || '').trim().toUpperCase()))]
      .filter(symbol => SECURITY_SYMBOL.test(symbol)).slice(0, MAX_SYMBOLS);
    const wanted = PIECES.filter(piece => fields.includes(piece));
    const run = (piece, loader, empty) => (wanted.includes(piece) && symbols.length ? guarded(loader, empty, symbols) : Promise.resolve(null));
    const [identityRows, researchRows, stanceRows, riskRows, activityRows] = await Promise.all([
      run('identity', () => identities(symbols), emptyIdentity),
      run('research', () => cached(researchCache, research, emptyResearch, symbols), emptyResearch),
      run('stance', () => stance.loadMany(symbols), emptyStance),
      run('risk', () => marketHistory.risk(symbols), emptyRisk),
      run('activity', () => marketHistory.activity(symbols), emptyActivity),
    ]);
    const byPiece = { identity: identityRows, research: researchRows, stance: stanceRows, risk: riskRows, activity: activityRows };
    const empties = { identity: emptyIdentity, research: emptyResearch, stance: emptyStance, risk: emptyRisk, activity: emptyActivity };
    const rows = {};
    const statuses = [];
    for (const symbol of symbols) {
      let instrument = null;
      try { instrument = resolveInstrument(symbol) || null; } catch { instrument = null; }
      const row = { symbol, instrument };
      for (const piece of wanted) {
        row[piece] = byPiece[piece]?.get(symbol) || empties[piece]('piece-unavailable');
        statuses.push(row[piece].status);
      }
      rows[symbol] = row;
    }
    const status = !statuses.length || statuses.every(value => value === 'unavailable') ? 'unavailable'
      : statuses.every(value => value === 'available') ? 'available' : 'partial';
    return {
      schemaVersion: 1,
      generatedAt: new Date(now()).toISOString(),
      status,
      fields: wanted,
      rows,
      pieces: Object.fromEntries(wanted.map(piece => [piece, {
        ttlSeconds: { identity: ttl.identity.ttlMs / 1000, research: ttl.research.ttlMs / 1000, stance: null, risk: 3600, activity: 3600 }[piece],
      }])),
      historicalOnly: true,
      executable: false,
    };
  }

  return { load, identities, PIECES, MAX_SYMBOLS };
}

module.exports = { MAX_SYMBOLS, PIECES, createSecurityUniverseService };
