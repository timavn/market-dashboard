import { normalizeMomoTrackerSnapshot, newYorkDateKey } from '../../../services/momoTrackerSnapshot.cjs';

// MOMO publication and direct-live spot acceptance, with no requests or timers.
// Keep these private primitive conversions identical to the monitor contract.
const finite = (value) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
const normalizedStatus = (value) => String(value || '').trim().toLowerCase();

const MOMO_SPOT_MAX_AGE_MS = 60_000;
const unavailableMomoSpot = (ticker) => ({
  ticker,
  status: 'unavailable',
  price: null,
  asOf: null,
  source: null,
});

export function normalizeVerifiedMomoTrackerSpots(
  tickers = [],
  quotes = {},
  providerStatus = null,
  nowMs = Date.now(),
) {
  const providerConnected = providerStatus?.ibkr?.connected === true;
  const quoteValues = quotes && typeof quotes === 'object' && !Array.isArray(quotes)
    ? Object.values(quotes)
    : [];
  const quoteBySymbol = new Map(quoteValues.map((quote) => [
    String(quote?.symbol || '').trim().toUpperCase(),
    quote,
  ]));
  const forbiddenProvenance = /delayed|frozen|stale|cache(?:d|[_ -]?only)?|mock|seed|fixture|fallback|offline|disconnected|historical|synthetic|inferred|derived|refresh[_ -]?failed/i;
  const deniedEntitlement = /denied|unavailable|not[_ -]?subscribed|not[_ -]?entitled|no[_ -]?permission|disabled/i;

  return Object.fromEntries([...new Set(tickers.map((ticker) => String(ticker || '').trim().toUpperCase()))]
    .filter(Boolean)
    .map((ticker) => {
      const quote = quoteBySymbol.get(ticker) || quotes?.[ticker];
      const symbol = String(quote?.symbol || '').trim().toUpperCase();
      const source = normalizedStatus(quote?.source);
      const dataType = normalizedStatus(quote?.dataType);
      const price = finite(quote?.last) ? Number(quote.last) : null;
      const asOfMs = Date.parse(quote?.timestamp || '');
      const ageMs = Number(nowMs) - asOfMs;
      const provenance = [
        quote?.warning,
        quote?.error,
        quote?.freshness,
        quote?.sourceStatus,
        quote?.fromCache ? 'cache' : null,
        quote?.cacheOnly ? 'cache-only' : null,
        quote?.stale ? 'stale' : null,
        quote?.mock ? 'mock' : null,
        quote?.seeded ? 'seed' : null,
        quote?.fallback ? 'fallback' : null,
        quote?.offline ? 'offline' : null,
        quote?.disconnected ? 'disconnected' : null,
        quote?.refreshFailed ? 'refresh-failed' : null,
      ].filter(Boolean).join(' ');
      const verified = providerConnected
        && symbol === ticker
        && source === 'ibkr'
        && dataType === 'live'
        && price != null
        && price > 0
        && Number.isFinite(asOfMs)
        && ageMs >= -5_000
        && ageMs <= MOMO_SPOT_MAX_AGE_MS
        && !forbiddenProvenance.test(provenance)
        && !deniedEntitlement.test(String(quote?.entitlementStatus || ''));

      return [ticker, verified ? {
        ticker,
        status: 'live',
        price,
        changePercent: finite(quote.changePercent) ? Number(quote.changePercent) : null,
        asOf: new Date(asOfMs).toISOString(),
        source: 'ibkr',
      } : unavailableMomoSpot(ticker)];
    }));
}

const currentMomoSpot = (spot, nowMs = Date.now()) => {
  const asOfMs = Date.parse(spot?.asOf || '');
  const ageMs = Number(nowMs) - asOfMs;
  return spot?.status === 'live'
    && spot?.source === 'ibkr'
    && finite(spot?.price)
    && Number(spot.price) > 0
    && Number.isFinite(asOfMs)
    && ageMs >= -5_000
    && ageMs <= MOMO_SPOT_MAX_AGE_MS
    ? spot
    : null;
};

export { finite as isFiniteMomoTrackerValue, newYorkDateKey, currentMomoSpot, normalizeMomoTrackerSnapshot };
