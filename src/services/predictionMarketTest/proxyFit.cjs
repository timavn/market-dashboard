const PROXY_FIT_WINDOWS = Object.freeze([5, 20, 60, 120]);
const PROXY_FIT_REQUEST_OBSERVATIONS = 150;
const ALLOWED_PROXY_SOURCES = new Set([
  'ibkr_historical_bars',
  'coinbase_exchange_public_candles',
]);
const FORBIDDEN_PROVENANCE = /delayed|frozen|stale|cache(?:d|[_ -]?only)?|mock|seed|fallback|offline|disconnected|synthetic|inferred|derived|portfolio/i;

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function dateKey(value) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const parsed = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString().slice(0, 10);
}

function weekday(date) {
  const parsed = Date.parse(`${date}T12:00:00.000Z`);
  if (!Number.isFinite(parsed)) return false;
  const day = new Date(parsed).getUTCDay();
  return day > 0 && day < 6;
}

function round(value, precision = 6) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** precision;
  return Math.round(value * scale) / scale;
}

function normalizedProxyCloses(points = []) {
  const byDate = new Map();
  (Array.isArray(points) ? points : []).forEach((point) => {
    const timestamp = Number(point?.timestamp);
    const value = finiteNumber(point?.value);
    const date = dateKey(timestamp);
    if (!date || !Number.isFinite(timestamp) || value == null || value <= 0) return;
    const current = byDate.get(date);
    if (!current || timestamp > current.timestamp) byDate.set(date, { date, timestamp, value });
  });
  return [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date));
}

function proxyFitCandidateDates(points = [], {
  limit = PROXY_FIT_REQUEST_OBSERVATIONS,
} = {}) {
  const dates = normalizedProxyCloses(points)
    .map((point) => point.date)
    // Hedgeye Risk Ranges publish on market sessions, including for BTC.
    .filter(weekday);
  return dates.slice(-Math.max(1, Number(limit) || PROXY_FIT_REQUEST_OBSERVATIONS));
}

function mean(values) {
  return values.length
    ? values.reduce((total, value) => total + value, 0) / values.length
    : null;
}

function sampleStandardDeviation(values) {
  if (values.length < 2) return null;
  const average = mean(values);
  const variance = values.reduce((total, value) => total + ((value - average) ** 2), 0)
    / (values.length - 1);
  return Math.sqrt(variance);
}

function returns(values) {
  const output = [];
  for (let index = 1; index < values.length; index += 1) {
    const previous = finiteNumber(values[index - 1]);
    const current = finiteNumber(values[index]);
    if (previous == null || previous <= 0 || current == null) return [];
    output.push((current / previous) - 1);
  }
  return output;
}

function correlation(left, right) {
  if (left.length !== right.length || left.length < 2) return null;
  const leftMean = mean(left);
  const rightMean = mean(right);
  let covariance = 0;
  let leftVariance = 0;
  let rightVariance = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftDelta = left[index] - leftMean;
    const rightDelta = right[index] - rightMean;
    covariance += leftDelta * rightDelta;
    leftVariance += leftDelta ** 2;
    rightVariance += rightDelta ** 2;
  }
  const denominator = Math.sqrt(leftVariance * rightVariance);
  return denominator > 0 ? covariance / denominator : null;
}

function unavailableProxyFit(reason, {
  proxyLabel = null,
  underlyingLabel = null,
  status = 'unavailable',
} = {}) {
  return {
    status,
    proxyLabel,
    underlyingLabel,
    currentBasisPct: null,
    alignedThroughDate: null,
    alignedObservations: 0,
    rows: PROXY_FIT_WINDOWS.map((window) => ({
      window,
      status: 'unavailable',
      averageBasisPct: null,
      deviationZ: null,
      returnCorrelation: null,
      observations: 0,
    })),
    reason,
  };
}

function buildAlignedPairs(proxyPoints, underlyingHistory) {
  const proxyCloses = normalizedProxyCloses(proxyPoints);
  const proxyDates = proxyCloses.map((point) => point.date);
  const ranges = underlyingHistory?.ranges && typeof underlyingHistory.ranges === 'object'
    ? underlyingHistory.ranges
    : {};
  const pairs = [];
  Object.keys(ranges).sort().forEach((publicationDate) => {
    const underlying = ranges[publicationDate];
    const underlyingClose = finiteNumber(underlying?.previousClose ?? underlying?.prevClose);
    const underlyingSource = String(underlying?.source || underlyingHistory?.source || '').trim();
    const underlyingAsOf = String(underlying?.asOf || underlying?.date || publicationDate);
    const provenance = [
      underlying?.warning,
      underlying?.provenance,
      underlying?.cacheState,
      underlying?.fromCache ? 'cache' : null,
      underlying?.cachedOnly ? 'cache-only' : null,
      underlying?.seeded ? 'seed' : null,
      underlyingHistory?.warning,
      underlyingHistory?.provenance,
      underlyingHistory?.cacheState,
      underlyingHistory?.fromCache ? 'cache' : null,
      underlyingHistory?.cachedOnly ? 'cache-only' : null,
      underlyingHistory?.seeded ? 'seed' : null,
    ].filter(Boolean).join(' ');
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(publicationDate)
      || underlyingClose == null
      || underlyingClose <= 0
      || !underlyingSource
      || FORBIDDEN_PROVENANCE.test(`${underlyingSource} ${provenance}`)
      || (/^\d{4}-\d{2}-\d{2}/.test(underlyingAsOf) && underlyingAsOf.slice(0, 10) !== publicationDate)
    ) return;
    let proxyIndex = proxyDates.length - 1;
    while (proxyIndex >= 0 && proxyDates[proxyIndex] >= publicationDate) proxyIndex -= 1;
    const proxy = proxyIndex >= 0 ? proxyCloses[proxyIndex] : null;
    if (!proxy) return;
    const basisPct = ((proxy.value / underlyingClose) - 1) * 100;
    pairs.push({
      publicationDate,
      proxyCloseDate: proxy.date,
      proxyCloseAt: new Date(proxy.timestamp).toISOString(),
      proxyClose: proxy.value,
      underlyingClose,
      basisPct,
      underlyingSource,
    });
  });
  return pairs;
}

function buildProxyFitComparison({
  proxyPoints = [],
  underlyingHistory = null,
  proxyLabel = null,
  underlyingLabel = null,
  proxySource = null,
} = {}) {
  const source = String(proxySource || '').trim();
  const unavailableOptions = { proxyLabel, underlyingLabel };
  if (!ALLOWED_PROXY_SOURCES.has(source)) {
    return unavailableProxyFit('Verified direct proxy history is unavailable.', unavailableOptions);
  }
  if (
    underlyingHistory?.fromCache === true
    || underlyingHistory?.cachedOnly === true
    || underlyingHistory?.seeded === true
    || underlyingHistory?.mock === true
    || FORBIDDEN_PROVENANCE.test([
      underlyingHistory?.warning,
      underlyingHistory?.provenance,
      underlyingHistory?.cacheState,
    ].filter(Boolean).join(' '))
  ) {
    return unavailableProxyFit('Verified underlying history is unavailable.', unavailableOptions);
  }
  const pairs = buildAlignedPairs(proxyPoints, underlyingHistory);
  if (!pairs.length) {
    return unavailableProxyFit('No verified proxy and underlying closes share an aligned publication basis.', unavailableOptions);
  }
  const current = pairs[pairs.length - 1];
  const rows = PROXY_FIT_WINDOWS.map((window) => {
    const observations = pairs.slice(-window);
    if (observations.length !== window) {
      return {
        window,
        status: 'unavailable',
        averageBasisPct: null,
        deviationZ: null,
        returnCorrelation: null,
        observations: observations.length,
      };
    }
    const basisValues = observations.map((pair) => pair.basisPct);
    const averageBasisPct = mean(basisValues);
    const standardDeviation = sampleStandardDeviation(basisValues);
    const deviationZ = standardDeviation > 1e-12
      ? (current.basisPct - averageBasisPct) / standardDeviation
      : Math.abs(current.basisPct - averageBasisPct) <= 1e-12 ? 0 : null;
    const proxyReturns = returns(observations.map((pair) => pair.proxyClose));
    const underlyingReturns = returns(observations.map((pair) => pair.underlyingClose));
    return {
      window,
      status: 'available',
      averageBasisPct: round(averageBasisPct),
      deviationZ: round(deviationZ),
      returnCorrelation: round(correlation(proxyReturns, underlyingReturns)),
      observations: window,
    };
  });
  const availableRows = rows.filter((row) => row.status === 'available').length;
  return {
    status: availableRows === rows.length ? 'available' : availableRows ? 'partial' : 'unavailable',
    proxyLabel,
    underlyingLabel,
    proxySource: source,
    underlyingSource: current.underlyingSource,
    currentBasisPct: round(current.basisPct),
    alignedThroughDate: current.publicationDate,
    proxyCloseDate: current.proxyCloseDate,
    proxyCloseAt: current.proxyCloseAt,
    alignedObservations: pairs.length,
    rows,
    methodology: 'basis_pct=(proxy_close/underlying_close-1)*100; deviation_z uses sample standard deviation; correlation uses aligned close-to-close returns',
    reason: availableRows ? null : 'At least five verified aligned observations are required.',
  };
}

module.exports = {
  PROXY_FIT_REQUEST_OBSERVATIONS,
  PROXY_FIT_WINDOWS,
  buildProxyFitComparison,
  proxyFitCandidateDates,
  unavailableProxyFit,
};
