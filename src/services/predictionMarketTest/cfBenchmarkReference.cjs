'use strict';

const CF_BENCHMARK_MAX_AGE_MS = 60_000;
const REQUEST_TIMEOUT_MS = 4_000;
const FUTURE_TOLERANCE_MS = 5_000;
const SOURCE = 'cf_benchmarks_kalshi_rest';
const RANGES = ['1d', '5d', '10d'];
const INVALID_PROVENANCE = /delayed|frozen|stale|cache|mock|seed|fixture|portfolio|fallback|offline|disconnected|synthetic|inferred|derived|unavailable|error/i;
const CF_BENCHMARK_MARKETS = Object.freeze({
  bitcoin: Object.freeze({
    indexId: 'BRTI', symbol: 'BTC', label: 'BRTI', name: 'CME CF Bitcoin Real Time Index',
    benchmarkUrl: 'https://www.cfbenchmarks.com/data/indices/BRTI',
  }),
  ethereum: Object.freeze({
    indexId: 'ETHUSD_RTI', symbol: 'ETH', label: 'ETHUSD_RTI', name: 'CME CF Ether-Dollar Real Time Index',
    benchmarkUrl: 'https://www.cfbenchmarks.com/data/indices/ETHUSD_RTI',
  }),
});

function numeric(value) {
  if (!['number', 'string'].includes(typeof value) || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function verifiedMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (['stale', 'isStale', 'fromCache', 'cached', 'cachedOnly', 'cacheOnly', 'seeded',
    'mock', 'isMock', 'synthetic', 'refreshFailed', 'offline', 'disconnected', 'repeatOfPreviousValue']
    .some((key) => value[key] === true)) return false;
  if (value.connected === false || value.isConnected === false || value.live === false
    || value.error || value.errors?.length) return false;
  if (typeof value.status === 'number' && (value.status < 200 || value.status >= 300)) return false;
  if (INVALID_PROVENANCE.test([
    value.source, value.provider, value.provenance, value.warning, value.cacheState,
    value.status, value.availability, value.connectionStatus,
  ].filter((item) => typeof item === 'string').join(' '))) return false;
  return ['metadata', 'freshness', 'providerStatus'].every((key) => value[key] == null || verifiedMetadata(value[key]));
}

function matchesIndex(value, indexId) {
  return ['id', 'indexId', 'index_id'].every((key) => value[key] == null || value[key] === indexId)
    && (value.feedId == null || value.feedId === `values/${indexId}`);
}

function currentTime(timestamp, nowMs) {
  return Number.isInteger(timestamp) && timestamp > 0
    && nowMs - timestamp >= -FUTURE_TOLERANCE_MS
    && nowMs - timestamp <= CF_BENCHMARK_MAX_AGE_MS;
}

function unavailableSection(definition, reason) {
  return {
    status: 'unavailable', availability: 'unavailable', value: null,
    label: definition.label, indexId: definition.indexId, source: null,
    provider: 'cf_benchmarks', asOf: null, expiresAt: null, marketSessionDate: null,
    fit: 'exact', referenceKind: 'settlement_benchmark', executable: false,
    refreshFailed: true, reason,
  };
}

function referenceResult(definition, spot) {
  const reason = 'Benchmark history is unavailable.';
  const variants = Object.fromEntries(RANGES.map((range) => [range, {
    ...unavailableSection(definition, reason), range, points: [], references: [],
    dailyRanges: [], rangeDates: [], latestAt: null, latestValue: null, refreshFailed: false,
  }]));
  return {
    spot, chart: { ...variants['1d'], variants },
    fit: 'exact', referenceKind: 'settlement_benchmark',
    instrument: {
      symbol: definition.indexId, displaySymbol: definition.label, underlyingSymbol: definition.symbol,
      secType: 'IND', exchange: 'CFBENCHMARKS', currency: 'USD', provider: 'cf_benchmarks',
    },
    resolver: `CF Benchmarks ${definition.indexId}`, benchmarkUrl: definition.benchmarkUrl,
    disclosure: 'Current index tick. Prediction contracts settle using the final 60-second average.',
    settlement: {
      benchmarkId: definition.indexId, publisher: 'CF Benchmarks', observationKind: 'current_index',
      averagingWindowSeconds: 60, finalSettlementValue: null,
      rulesUrl: 'https://help.kalshi.com/en/articles/13823838-crypto-markets',
    },
    proxyFit: null, backgroundRefresh: false,
  };
}

// The official /values schema returns a single requested index's values, not
// an id on each tick. Its identity comes from the fixed, signed id query. The
// provider's time is epoch milliseconds; serverTime is never a price timestamp.
// https://docs.kalshi.com/cfbenchmarks/rest-passthrough
// https://docs.cfbenchmarks.com/api/rest/values/
function latestObservation(response, definition, nowMs) {
  if (!verifiedMetadata(response) || !matchesIndex(response, definition.indexId)) return null;
  const data = response.data;
  if (!verifiedMetadata(data) || !matchesIndex(data, definition.indexId)
    || !currentTime(Date.parse(data.serverTime || ''), nowMs) || !Array.isArray(data.payload)
    || data.payload.length === 0) return null;
  // Reject ambiguous identity or unparseable observation times instead of
  // falling back to a preceding apparently valid value in the same response.
  if (data.payload.some((tick) => !tick || typeof tick !== 'object'
    || !matchesIndex(tick, definition.indexId) || numeric(tick.time) == null)) return null;
  const latest = [...data.payload].sort((left, right) => numeric(right.time) - numeric(left.time))[0];
  const time = numeric(latest.time);
  const value = numeric(latest.value);
  if (!verifiedMetadata(latest) || !currentTime(time, nowMs) || !(value > 0)) return null;
  // Amendments retain the original observation time and do not renew freshness.
  if (latest.amendTime != null && !currentTime(numeric(latest.amendTime), nowMs)) return null;
  return { time, value, amendedAt: latest.amendTime == null ? null : new Date(numeric(latest.amendTime)).toISOString() };
}

async function loadCfBenchmarkReference({ marketId, kalshiFetch, nowMs = Date.now(), requestTimeoutMs = REQUEST_TIMEOUT_MS }) {
  const definition = CF_BENCHMARK_MARKETS[marketId];
  if (!definition) throw new Error('Unsupported CF Benchmarks reference market.');
  const unavailable = () => referenceResult(definition,
    unavailableSection(definition, `Verified CF Benchmarks ${definition.indexId} is unavailable.`));
  if (typeof kalshiFetch !== 'function' || !Number.isFinite(nowMs)) return unavailable();
  let timer;
  try {
    const response = await Promise.race([
      Promise.resolve().then(() => kalshiFetch('/cfbenchmarks/values', {
        id: definition.indexId, maxResolution: 'PER_SECOND',
      })),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), Math.max(1, Math.min(REQUEST_TIMEOUT_MS,
          numeric(requestTimeoutMs) || REQUEST_TIMEOUT_MS)));
      }),
    ]);
    const latest = latestObservation(response, definition, nowMs);
    if (!latest) return unavailable();
    const asOf = new Date(latest.time).toISOString();
    return referenceResult(definition, {
      status: 'available', availability: 'live', value: latest.value,
      label: definition.label, indexId: definition.indexId, provider: 'cf_benchmarks',
      source: SOURCE, provenance: 'official_index', asOf,
      expiresAt: new Date(latest.time + CF_BENCHMARK_MAX_AGE_MS).toISOString(),
      marketSessionDate: asOf.slice(0, 10), marketSessionTimeZone: 'UTC',
      fit: 'exact', referenceKind: 'settlement_benchmark', observationKind: 'current_index',
      executable: false, amendedAt: latest.amendedAt, reason: null,
    });
  } catch (_error) {
    return unavailable();
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { CF_BENCHMARK_MARKETS, CF_BENCHMARK_MAX_AGE_MS, loadCfBenchmarkReference };
