/**
 * Client-side filter for realized G/L lots (aligns with list search: ticker + name).
 * @param {Array<{ symbol?: string, name?: string }>} lots
 * @param {string} query
 * @returns {typeof lots}
 */
export function filterLotsBySearch(lots, query) {
  if (!lots || !lots.length) return lots || [];
  if (!query || !String(query).trim()) return lots;
  const q = String(query).toLowerCase().trim();
  return lots.filter((lot) => {
    const sym = (lot.symbol || '').toLowerCase();
    const name = (lot.name || '').toLowerCase();
    return sym.includes(q) || name.includes(q);
  });
}
