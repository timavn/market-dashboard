function createQuoteSubscriptionRegistry({ maxSymbols = 100 } = {}) {
  const clients = new Map();
  const refCounts = new Map();
  function replace(client, symbols) {
    if (!Array.isArray(symbols) || symbols.some(symbol => typeof symbol !== 'string')) throw new Error('Invalid symbol subscription');
    const desired = new Set(symbols.map(symbol => symbol.trim().toUpperCase()).filter(Boolean));
    if (desired.size > maxSymbols || [...desired].some(symbol => symbol.length > 80)) throw new Error('Subscription capacity exceeded');
    const previous = clients.get(client) || new Set();
    const otherSymbols = [...refCounts].filter(([symbol, count]) => count > (previous.has(symbol) ? 1 : 0)).map(([symbol]) => symbol);
    if (new Set([...otherSymbols, ...desired]).size > maxSymbols) throw new Error('Subscription capacity exceeded');
    for (const symbol of previous) {
      if (desired.has(symbol)) continue;
      const remaining = refCounts.get(symbol) - 1;
      if (remaining > 0) refCounts.set(symbol, remaining);
      else refCounts.delete(symbol);
    }
    for (const symbol of desired) {
      if (!previous.has(symbol)) refCounts.set(symbol, (refCounts.get(symbol) || 0) + 1);
    }
    clients.set(client, desired);
    return [...desired];
  }
  function release(client) { replace(client, []); clients.delete(client); }
  return { clients, refCounts, replace, release, desiredSymbols: () => [...refCounts.keys()] };
}
module.exports = { createQuoteSubscriptionRegistry };
