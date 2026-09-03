const FIXED_MARKET_VENUES = Object.freeze({
  cpi: 'kalshi',
  gold: 'kalshi',
  sp500: 'forecastex',
});

const normalizeToken = (value, fallback = '') => {
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized || fallback;
};

/**
 * Fixed prediction cards have only one valid venue. Treating their historical
 * `auto` requests as a different resource creates duplicate warmups, ETags and
 * session snapshots for the same card.
 */
export function canonicalPredictionMonitorVenue(marketId, venue = 'auto') {
  const market = normalizeToken(marketId, 'sp500');
  const requestedVenue = normalizeToken(venue, 'auto');
  const fixedVenue = FIXED_MARKET_VENUES[market];
  if (fixedVenue && ['auto', fixedVenue].includes(requestedVenue)) return fixedVenue;
  return requestedVenue;
}

export function canonicalPredictionMonitorContext(context = {}) {
  const marketId = normalizeToken(context.marketId, 'sp500');
  return {
    ...context,
    marketId,
    venue: canonicalPredictionMonitorVenue(marketId, context.venue),
    generationId: String(context.generationId ?? '').trim() || null,
  };
}

export function predictionMonitorIdentityKey(context = {}, { includeView = false } = {}) {
  const canonical = canonicalPredictionMonitorContext(context);
  const identity = [
    canonical.marketId,
    canonical.venue,
    canonical.generationId || 'default',
  ];
  if (includeView) identity.push(normalizeToken(context.view, 'card'));
  return identity.join('|');
}

export default canonicalPredictionMonitorContext;
