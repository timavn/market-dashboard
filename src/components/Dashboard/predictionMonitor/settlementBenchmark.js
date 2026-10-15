import { finite } from './monitorNumbers';

export const SETTLEMENT_BENCHMARK_MARKETS = Object.freeze(['gold', 'silver', 'bitcoin', 'ethereum']);

const INVALID_FLAGS = ['stale', 'isStale', 'offline', 'disconnected', 'fromCache', 'cacheOnly', 'cachedOnly', 'cached',
  'mock', 'isMock', 'seeded', 'synthetic', 'refreshFailed', 'referenceOnly', 'displayDelayed'];
const INVALID_SOURCE = /mock|seed|fixture|fallback|cache|portfolio|delayed|frozen|stale|offline|disconnected|synthetic|inferred|derived/i;
const INVALID_STATUS = ['offline', 'disconnected', 'error', 'failed', 'unavailable', 'stale', 'delayed'];
const rejected = (section) => {
  if (!section || typeof section !== 'object') return false;
  return INVALID_FLAGS.some((flag) => section[flag] === true)
    || ['connected', 'isConnected', 'live'].some((flag) => section[flag] === false)
    || ['status', 'availability', 'providerStatus'].some((key) => INVALID_STATUS.includes(section[key]))
    || INVALID_SOURCE.test([section.source, section.provenance, section.freshness?.status].filter(Boolean).join(' '))
    || ['providerStatus', 'freshness', 'metadata', 'meta'].some((key) => rejected(section[key]));
};

export const formatBenchmarkObservation = (value) => {
  const parsed = Date.parse(value || '');
  if (!Number.isFinite(parsed)) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    hourCycle: 'h23', timeZone: 'America/Los_Angeles', timeZoneName: 'short',
  }).formatToParts(new Date(parsed));
  const part = (name) => parts.find(({ type }) => type === name)?.value;
  return `${part('month')} ${part('day')} ${part('hour')}:${part('minute')} ${part('timeZoneName')}`;
};

// The chart's traded price and its proxy history are never settlement inputs.
// Metadata binds the independently verified input to the selected contract rules.
export function buildSettlementBenchmarkView(snapshot, { nowMs = Date.now(), refreshFailed = false } = {}) {
  const reference = snapshot?.resolverReference;
  const benchmark = reference?.settlementBenchmark;
  const exact = reference?.exactReference || reference;
  const spot = exact?.spot;
  const eventTicker = snapshot?.contracts?.event?.ticker || snapshot?.contracts?.event?.generationId;
  const identityExpiresMs = Date.parse(benchmark?.expiresAt || '');
  const identityVerified = benchmark?.identityVerified === true
    && Boolean(benchmark.symbol && benchmark.sourceName && benchmark.sourceUrl && benchmark.method)
    && Boolean(eventTicker) && benchmark.eventTicker === eventTicker
    && Number.isFinite(identityExpiresMs) && identityExpiresMs > nowMs;
  const sourceSymbol = String(spot?.indexId || spot?.feed?.symbol || exact?.feed?.symbol
    || exact?.instrument?.displaySymbol || exact?.instrument?.localSymbol || '').trim().toUpperCase();
  const expectedSymbol = String(benchmark?.symbol || '').trim().toUpperCase();
  const asOfMs = Date.parse(spot?.asOf || '');
  const expiresMs = Date.parse(spot?.expiresAt || '');
  const available = identityVerified && !refreshFailed
    && ![snapshot, exact, spot, benchmark].some(rejected)
    && spot?.status === 'available' && ['live', 'current'].includes(spot?.availability)
    && spot?.fit === 'exact' && Boolean(sourceSymbol) && sourceSymbol === expectedSymbol
    && Boolean(String(spot?.source || '').trim())
    && finite(spot?.value) && Number(spot.value) > 0
    && /T\d{2}:\d{2}/.test(String(spot?.asOf || ''))
    && Number.isFinite(asOfMs) && asOfMs <= nowMs + 5_000 && nowMs - asOfMs <= 60_000
    && Number.isFinite(expiresMs) && expiresMs > nowMs;
  return {
    status: available ? 'live' : 'unavailable',
    symbol: identityVerified ? benchmark.displaySymbol || benchmark.symbol : null,
    sourceName: identityVerified ? benchmark.sourceName : null,
    sourceUrl: identityVerified ? benchmark.sourceUrl : null,
    method: identityVerified ? benchmark.method : null,
    spot: available ? { ...spot, label: benchmark.displaySymbol || benchmark.symbol, executable: false } : null,
    value: available ? Number(spot.value) : null,
    asOf: available ? spot.asOf : null,
  };
}
