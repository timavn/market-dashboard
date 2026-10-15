const { DIRECTIONAL_FEEDS } = require('./directionalFeedRegistry.cjs');

const BENCHMARK_MARKET_IDS = Object.freeze(['bitcoin', 'ethereum', 'gold', 'silver']);
const INVALID = /delayed|frozen|stale|cache|mock|seed|fixture|portfolio|fallback|offline|disconnected|synthetic|inferred|derived|unavailable|error/i;
const BAD_FLAGS = ['stale', 'isStale', 'fromCache', 'cached', 'cachedOnly', 'cacheOnly', 'seeded', 'mock',
  'isMock', 'synthetic', 'refreshFailed', 'offline', 'disconnected', 'referenceOnly'];

function verifiedMetadata(section) {
  if (!section || typeof section !== 'object') return false;
  if (BAD_FLAGS.some((key) => section[key] === true)
    || section.connected === false || section.isConnected === false || section.live === false) return false;
  if (INVALID.test(['source', 'provider', 'provenance', 'cacheState', 'status', 'availability', 'connectionStatus']
    .map((key) => section[key]).filter((value) => typeof value === 'string').join(' '))) return false;
  return ['metadata', 'freshness', 'providerStatus'].every((key) => section[key] == null || verifiedMetadata(section[key]));
}

// The benchmark identity comes from the selected event's validated rules, never
// from the chart's symbol or a similarly named spot/futures product.
function withSettlementBenchmark(reference, venue, config) {
  if (!BENCHMARK_MARKET_IDS.includes(config?.id)) return reference;
  const basis = venue?.settlementBasis;
  const event = venue?.catalog?.event || venue?.book?.event;
  const displaySymbol = basis?.instrument || null;
  const crypto = DIRECTIONAL_FEEDS[config.id];
  const symbol = crypto?.provider === 'coinbase' && displaySymbol === crypto.resolverIndex
    ? crypto.resolverSourcePath : displaySymbol;
  return {
    ...reference,
    settlementBenchmark: {
      symbol,
      displaySymbol,
      sourceName: basis?.sourceName || null,
      sourceUrl: basis?.sourceUrl || null,
      method: basis?.method || null,
      observationAt: basis?.observationAt || null,
      eventTicker: event?.ticker || null,
      expiresAt: venue?.catalog?.expiresAt || event?.closeTime || null,
      identityVerified: basis?.status === 'verified' && basis.instrumentScope === 'exact'
        && venue?.catalog?.status === 'available' && Boolean(event?.ticker && symbol),
    },
  };
}

function verifiedSettlementBenchmarkSpot(reference, nowMs = Date.now()) {
  const identity = reference?.settlementBenchmark;
  const exact = reference?.exactReference || reference;
  const spot = exact?.spot;
  const observed = Date.parse(spot?.asOf || '');
  const expiry = Date.parse(spot?.expiresAt || '');
  const identityExpiry = Date.parse(identity?.expiresAt || '');
  if (!Number.isFinite(nowMs) || !identity?.identityVerified || !identity.eventTicker || !identity.symbol
    || !Number.isFinite(identityExpiry) || identityExpiry <= nowMs
    || !verifiedMetadata(exact) || !verifiedMetadata(spot)
    || spot.fit !== 'exact' || spot.status !== 'available' || spot.availability !== 'live'
    || !spot.source || spot.value == null || typeof spot.value === 'boolean'
    || !Number.isFinite(Number(spot.value)) || Number(spot.value) <= 0
    || !Number.isFinite(observed) || observed > nowMs + 5_000 || nowMs - observed > 60_000
    || !Number.isFinite(expiry) || expiry <= nowMs) return null;
  const actualSymbol = spot.indexId || spot.feed?.symbol || exact.feed?.symbol
    || exact.instrument?.displaySymbol || exact.instrument?.localSymbol;
  if (String(actualSymbol || '').toUpperCase() !== String(identity.symbol).toUpperCase()) return null;
  return { ...spot, label: identity.displaySymbol || identity.symbol, executable: false };
}

module.exports = { BENCHMARK_MARKET_IDS, withSettlementBenchmark, verifiedSettlementBenchmarkSpot };
