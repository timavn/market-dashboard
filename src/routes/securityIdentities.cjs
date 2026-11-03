'use strict';

const { requestedSecuritySymbols } = require('../utils/securitySymbols.cjs');
const { createIdentityPiece } = require('../services/securityUniverse/pieces/identity.cjs');

// A view of the security record's identity: the exact listed security for each
// requested ticker, provider-verified, with the name as people read it.
function createSecurityIdentitiesHandler({ resolver, loadIdentities = resolver && createIdentityPiece({ resolver }).loadMany } = {}) {
  return async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Data-Use', 'descriptive-security-identity');
    const envelope = { historicalOnly: true, executable: false };
    const symbols = requestedSecuritySymbols(req.query?.symbols);
    if (!symbols) return res.status(400).json({ ...envelope, status: 'unavailable', rows: [], reason: 'invalid_symbols' });
    try {
      const identities = await loadIdentities(symbols);
      const rows = symbols.map(ticker => {
        const identity = identities?.get?.(ticker);
        if (identity?.name?.status !== 'available') return null;
        const shown = identity.displayName?.status === 'available' ? identity.displayName : identity.name;
        return { ticker, name: identity.name.value, nameVerified: true, nameSource: identity.name.source,
          displayName: shown.value, displayNameSource: shown.source };
      }).filter(Boolean);
      const status = rows.length === symbols.length ? 'available' : rows.length ? 'partial' : 'unavailable';
      return res.status(rows.length ? 200 : 503).json({ ...envelope, status, rows });
    } catch {
      return res.status(503).json({ ...envelope, status: 'unavailable', rows: [] });
    }
  };
}

module.exports = { createSecurityIdentitiesHandler };
