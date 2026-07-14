function getFreshCachedQuote(cache, key, now, ttlMs) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (!Number.isFinite(entry.timestamp) || now - entry.timestamp < 0 || now - entry.timestamp >= ttlMs) {
    cache.delete(key);
    return null;
  }
  return entry.data?.price ? entry.data : null;
}

module.exports = { getFreshCachedQuote };
