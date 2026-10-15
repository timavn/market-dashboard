'use strict';

const {
  SEC_NAME_SOURCE,
  YAHOO_NAME_SOURCE,
  normalizeSecurityName,
} = require('../services/exposureLabSecurityIdentity.cjs');

const MAX_SYMBOLS = 50;
const VERIFIED_NAME_SOURCES = new Set([SEC_NAME_SOURCE, YAHOO_NAME_SOURCE]);

function requestedSymbols(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_SYMBOLS * 33) return null;
  const symbols = value.split(',').map(symbol => symbol.trim().toUpperCase());
  if (symbols.length > MAX_SYMBOLS || symbols.some(symbol => !/^[A-Z0-9][A-Z0-9.^=/_-]{0,31}$/.test(symbol))) return null;
  return [...new Set(symbols)];
}

function invalidIdentity(value) {
  return value && (
    ['mock', 'isMock', 'seed', 'seeded', 'isSeeded', 'synthetic', 'inferred', 'offline', 'disconnected'].some(flag => value[flag] === true)
    || value.connected === false
    || ['unavailable', 'failed', 'error', 'offline', 'disconnected', 'mock', 'seeded'].includes(value.status)
  );
}

async function preferFundIdentity(row, resolver) {
  if (row.nameSource !== SEC_NAME_SOURCE || !/\b(?:trust|funds?)\b/i.test(row.name)
    || typeof resolver.loadYahooIdentity !== 'function') return row;
  try {
    const result = await resolver.loadYahooIdentity(row.ticker, { exactTicker: true });
    const identity = result?.identity;
    if (result?.status !== 'available' || invalidIdentity(result) || invalidIdentity(identity)
      || identity?.ticker !== row.ticker || identity?.nameSource !== YAHOO_NAME_SOURCE
      || !['ETF', 'MUTUALFUND'].includes(identity?.instrumentType)) return row;
    const name = normalizeSecurityName(identity.name, row.ticker);
    return name ? { ticker: row.ticker, name, nameVerified: true, nameSource: YAHOO_NAME_SOURCE } : row;
  } catch {
    return row;
  }
}

function createSecurityIdentitiesHandler({ resolver } = {}) {
  return async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Data-Use', 'descriptive-security-identity');
    const envelope = { historicalOnly: true, executable: false };
    const symbols = requestedSymbols(req.query?.symbols);
    if (!symbols) return res.status(400).json({ ...envelope, status: 'unavailable', rows: [], reason: 'invalid_symbols' });
    try {
      // These are exact requested tickers, independent of the research archive's
      // discovery roster. Only provider-verified descriptive identity is returned.
      const identified = await resolver.resolve({ rows: symbols.map(ticker => ({
        ticker, discoveryState: 'structured', confidenceKinds: ['structured_list'], existingUniverse: false,
      })) });
      if (invalidIdentity(identified) || invalidIdentity(identified?.identityDirectory)) {
        return res.status(503).json({ ...envelope, status: 'unavailable', rows: [] });
      }
      const byTicker = new Map();
      for (const row of Array.isArray(identified?.rows) ? identified.rows : []) {
        if (!symbols.includes(row?.ticker) || byTicker.has(row.ticker) || invalidIdentity(row)
          || row.nameVerified !== true || !VERIFIED_NAME_SOURCES.has(row.nameSource)) continue;
        const name = normalizeSecurityName(row.name, row.ticker, { allowTickerName: row.nameSource === SEC_NAME_SOURCE });
        if (name) byTicker.set(row.ticker, { ticker: row.ticker, name, nameVerified: true, nameSource: row.nameSource });
      }
      const verifiedRows = symbols.map(ticker => byTicker.get(ticker)).filter(Boolean);
      const rows = [];
      // SEC may identify the trust registrant rather than the specific fund.
      // Prefer exact ETF/fund identity with bounded reads; retain verified SEC
      // names when that more specific evidence is unavailable.
      for (let offset = 0; offset < verifiedRows.length; offset += 8) {
        rows.push(...await Promise.all(verifiedRows.slice(offset, offset + 8).map(row => preferFundIdentity(row, resolver))));
      }
      const status = rows.length === symbols.length ? 'available' : rows.length ? 'partial' : 'unavailable';
      return res.status(rows.length ? 200 : 503).json({ ...envelope, status, rows });
    } catch {
      return res.status(503).json({ ...envelope, status: 'unavailable', rows: [] });
    }
  };
}

module.exports = { createSecurityIdentitiesHandler };
