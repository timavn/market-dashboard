/**
 * CBOE Treasury yield index observations (currently ^TNX and ^TYX).
 * Historically Yahoo quoted yield×10 (e.g. 45.7 → 4.57%); modern feeds often use percent directly.
 */

export function normalizeCboeTreasuryYield(raw) {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return n > 20 ? n * 0.1 : n;
}

export function isTreasuryYieldSymbol(symbol) {
  return /^UST\d+Y$/.test(String(symbol || '').toUpperCase());
}
