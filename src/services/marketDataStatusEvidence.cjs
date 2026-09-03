const {
  buildQuoteMetadata,
  classifyQuoteAvailability,
} = require('./providers/multiRegionQuoteIntegrity.cjs');

const DEFAULT_MAX_AGE_MS = 60_000;
const LIVE_IBKR_MIXED_REASON = 'Live IBKR quotes are available; some requested instruments are using delayed Yahoo data.';
const DELAYED_ONLY_REASON = 'Only delayed provider data is available; current live quotes are unavailable.';

function asTimestamp(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function isFresh(value, nowMs, maxAgeMs) {
  const timestamp = asTimestamp(value);
  if (timestamp == null) return false;
  const ageMs = nowMs - timestamp;
  return ageMs >= 0 && ageMs <= maxAgeMs;
}

function observationFromCacheEntry(entry, { nowMs, maxAgeMs, connected }) {
  if (!entry || !Number.isFinite(Number(entry.timestamp))) return null;
  const insertedAt = new Date(Number(entry.timestamp)).toISOString();
  if (!isFresh(insertedAt, nowMs, maxAgeMs)) return null;

  const metadata = buildQuoteMetadata(entry.data);
  const availability = classifyQuoteAvailability(entry.data, { now: nowMs });
  const source = String(metadata.source || '').trim().toLowerCase();
  const dataType = String(entry.data?.dataType || '').trim().toLowerCase();
  if (
    availability === 'unavailable'
    || !['ibkr', 'yahoo'].includes(source)
    || (source === 'ibkr' && connected !== true)
    || (source === 'ibkr' && !['live', 'delayed'].includes(dataType))
    || !['current', 'delayed'].includes(availability)
  ) {
    return null;
  }

  return {
    observedAt: insertedAt,
    source,
    availability,
    warning: metadata.warning || null,
  };
}

function observationFromIbkrHeartbeat(ibkr, { nowMs, maxAgeMs }) {
  if (ibkr?.connected !== true) return null;
  const availability = String(ibkr.lastQuoteAvailability || '').trim().toLowerCase();
  if (!['current', 'delayed'].includes(availability)) return null;
  if (!isFresh(ibkr.lastQuoteAt, nowMs, maxAgeMs)) return null;
  return {
    observedAt: new Date(asTimestamp(ibkr.lastQuoteAt)).toISOString(),
    source: 'ibkr',
    availability,
    warning: null,
  };
}

function observationFromMarketState(market, { nowMs, maxAgeMs, connected }) {
  const source = String(market?.lastSource || '').trim().toLowerCase();
  if (!['ibkr', 'yahoo'].includes(source)) return null;
  if (source === 'ibkr' && connected !== true) return null;
  if (!isFresh(market.lastQuoteAt, nowMs, maxAgeMs)) return null;
  const warning = String(market.lastWarning || '');
  return {
    observedAt: new Date(asTimestamp(market.lastQuoteAt)).toISOString(),
    source,
    availability: source === 'yahoo' || /delayed/i.test(warning) ? 'delayed' : 'current',
    warning: warning || null,
  };
}

function summarizeMarketDataStatusEvidence({
  quoteEntries = [],
  providerStatus = {},
  nowMs = Date.now(),
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  cacheTtlMs = DEFAULT_MAX_AGE_MS,
} = {}) {
  const boundedAgeMs = Math.max(1, Number(maxAgeMs) || DEFAULT_MAX_AGE_MS);
  const boundedCacheAgeMs = Math.min(
    boundedAgeMs,
    Math.max(1, Number(cacheTtlMs) || DEFAULT_MAX_AGE_MS),
  );
  const ibkr = providerStatus?.ibkr || {};
  const observations = quoteEntries
    .map((entry) => observationFromCacheEntry(entry, {
      nowMs,
      maxAgeMs: boundedCacheAgeMs,
      connected: ibkr.connected,
    }))
    .filter(Boolean);

  const ibkrHeartbeat = observationFromIbkrHeartbeat(ibkr, {
    nowMs,
    maxAgeMs: boundedAgeMs,
  });
  if (ibkrHeartbeat) observations.push(ibkrHeartbeat);

  if (observations.length === 0) {
    const marketObservation = observationFromMarketState(providerStatus?.market, {
      nowMs,
      maxAgeMs: boundedAgeMs,
      connected: ibkr.connected,
    });
    if (marketObservation) observations.push(marketObservation);
  }

  const current = observations.filter(({ availability }) => availability === 'current');
  const delayed = observations.filter(({ availability }) => availability === 'delayed');
  const latest = [...observations].sort(
    (left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt),
  )[0];
  const latestCurrent = current
    .slice()
    .sort((left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt))[0];
  const latestDelayed = delayed
    .slice()
    .sort((left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt))[0];

  if (latest) {
    const availability = current.length > 0 && delayed.length > 0
      ? 'mixed'
      : current.length > 0
        ? 'current'
        : 'delayed';
    return {
      verified: true,
      available: true,
      observedAt: latest.observedAt,
      currentObservedAt: latestCurrent?.observedAt || null,
      delayedObservedAt: latestDelayed?.observedAt || null,
      source: availability === 'mixed' ? 'ibkr+yahoo' : latest.source,
      availability,
      warning: availability === 'mixed'
        ? LIVE_IBKR_MIXED_REASON
        : latest.warning,
      reason: availability === 'mixed'
        ? LIVE_IBKR_MIXED_REASON
        : availability === 'delayed'
          ? DELAYED_ONLY_REASON
          : null,
    };
  }

  const lastMarketQuoteAt = providerStatus?.market?.lastQuoteAt;
  const lastIbkrQuoteAt = providerStatus?.ibkr?.lastQuoteAt;
  const staleMarket = asTimestamp(lastMarketQuoteAt) != null
    && nowMs - asTimestamp(lastMarketQuoteAt) > boundedAgeMs;
  const staleIbkr = asTimestamp(lastIbkrQuoteAt) != null
    && nowMs - asTimestamp(lastIbkrQuoteAt) > boundedAgeMs;
  if (staleMarket || staleIbkr) {
    const observedAt = staleIbkr && (!staleMarket || asTimestamp(lastIbkrQuoteAt) > asTimestamp(lastMarketQuoteAt))
      ? lastIbkrQuoteAt
      : lastMarketQuoteAt;
    return {
      verified: true,
      available: false,
      observedAt,
      source: staleIbkr ? 'ibkr' : String(providerStatus?.market?.lastSource || '').toLowerCase() || null,
      reason: 'The last market-provider quote is stale; no fresh quote is available.',
    };
  }

  if (
    providerStatus?.market?.lastError === 'no_quote_available'
    || providerStatus?.market?.lastWarning === 'no_quote_available'
  ) {
    return {
      verified: true,
      available: false,
      reason: 'Market-data providers are unavailable.',
    };
  }

  return {
    verified: false,
    available: null,
  };
}

module.exports = {
  DEFAULT_MAX_AGE_MS,
  DELAYED_ONLY_REASON,
  LIVE_IBKR_MIXED_REASON,
  summarizeMarketDataStatusEvidence,
};
