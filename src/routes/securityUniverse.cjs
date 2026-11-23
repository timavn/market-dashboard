'use strict';

const { requestedSecuritySymbols } = require('../utils/securitySymbols.cjs');

const PIECES = ['identity', 'classification', 'research', 'stance', 'risk', 'activity'];

function requestedFields(value) {
  if (value === undefined || value === '') return PIECES;
  if (typeof value !== 'string') return null;
  const fields = [...new Set(value.split(',').map(field => field.trim()).filter(Boolean))];
  return fields.length && fields.every(field => PIECES.includes(field)) ? fields : null;
}

// GET /api/security-universe?symbols=…&fields=identity,classification,research,stance,risk,activity
// The central per-ticker record. Descriptive research only: never a quote,
// order size or signal of its own.
function createSecurityUniverseHandler({ service } = {}) {
  return async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Data-Use', 'historical-research-only');
    const envelope = { schemaVersion: 1, historicalOnly: true, executable: false };
    const symbols = requestedSecuritySymbols(req.query?.symbols);
    const fields = requestedFields(req.query?.fields);
    if (!symbols || !fields) {
      return res.status(400).json({ ...envelope, status: 'unavailable', rows: {}, reason: !symbols ? 'invalid_symbols' : 'invalid_fields' });
    }
    try {
      const record = await service.load(symbols, { fields });
      return res.status(record.status === 'unavailable' ? 503 : 200).json(record);
    } catch {
      return res.status(503).json({ ...envelope, status: 'unavailable', rows: {} });
    }
  };
}

module.exports = { createSecurityUniverseHandler };
