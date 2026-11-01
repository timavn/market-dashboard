'use strict';

// Per-symbol cache for one piece of the security record. A usable result lives
// `ttlMs`, an unusable one `failureTtlMs`; requests for the same symbol share one
// load, and an expired entry is never served, so a failed refresh reads as
// unavailable rather than as the previous value.
function createPieceCache({ ttlMs, failureTtlMs, now = Date.now, maxEntries = 2000 } = {}) {
  const entries = new Map();
  const inFlight = new Map();

  function remember(symbol, value, usable) {
    entries.delete(symbol);
    entries.set(symbol, { value, expiresAt: now() + (usable ? ttlMs : failureTtlMs) });
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
  }

  // `load(symbols)` resolves a Map of symbol → value for one batch; `usable(value)`
  // picks the TTL; `failed(error)` is the value every symbol of a rejected batch gets.
  async function getMany(symbols, { load, usable, failed }) {
    const at = now();
    const pending = new Map();
    const missing = [];
    for (const symbol of symbols) {
      const entry = entries.get(symbol);
      if (entry && entry.expiresAt > at) pending.set(symbol, Promise.resolve(entry.value));
      else if (inFlight.has(symbol)) pending.set(symbol, inFlight.get(symbol));
      else missing.push(symbol);
      if (entry && entry.expiresAt <= at) entries.delete(symbol);
    }
    if (missing.length) {
      const batch = Promise.resolve().then(() => load(missing)).then(
        values => new Map(missing.map(symbol => [symbol, values?.get?.(symbol) ?? failed(new Error('piece-returned-no-value'))])),
        error => new Map(missing.map(symbol => [symbol, failed(error)])),
      );
      for (const symbol of missing) {
        const promise = batch.then(values => {
          const value = values.get(symbol);
          remember(symbol, value, usable(value));
          return value;
        }).finally(() => { if (inFlight.get(symbol) === promise) inFlight.delete(symbol); });
        inFlight.set(symbol, promise);
        pending.set(symbol, promise);
      }
    }
    const values = await Promise.all(symbols.map(symbol => pending.get(symbol)));
    return new Map(symbols.map((symbol, index) => [symbol, values[index]]));
  }

  return { getMany, clear: () => entries.clear(), size: () => entries.size };
}

module.exports = { createPieceCache };
