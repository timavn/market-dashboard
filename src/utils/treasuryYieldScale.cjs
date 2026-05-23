/**
 * CommonJS entry for server.js and yahoo provider (keep in sync with treasuryYieldScale.js).
 */

function normalizeCboeTreasuryYield(raw) {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return n > 20 ? n * 0.1 : n;
}

function isTreasuryYieldSymbol(symbol) {
  return /^UST\d+Y$/.test(String(symbol || '').toUpperCase());
}

module.exports = { normalizeCboeTreasuryYield, isTreasuryYieldSymbol };
