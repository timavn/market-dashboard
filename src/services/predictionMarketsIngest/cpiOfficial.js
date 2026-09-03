const axios = require('axios/dist/node/axios.cjs');

const BLS_CPI_SERIES_ID = 'CUUR0000SA0';
const BLS_CPI_API_URL = 'https://api.bls.gov/publicAPI/v2/timeseries/data/';
const BLS_CPI_DATA_URL = 'https://downloadt.bls.gov/pub/time.series/cu/cu.data.1.AllItems';
const BLS_RELEASE_CHECKPOINTS = Object.freeze([
  {
    id: '2026-06',
    // BLS officially reports June 2026 headline CPI YoY as 3.5%.
    value: 3.5,
    source: 'bls_release',
    sourceUrl: 'https://www.bls.gov/news.release/cpi.t01.htm',
  },
]);
const BLS_CACHE_TTL_MS = 15 * 60 * 1000;
const cache = new Map();
const refreshInFlight = new Map();

function observationMonthId(observation = {}) {
  const year = Number(observation.year);
  const period = String(observation.period || '').trim().toUpperCase();
  const month = period.match(/^M(0[1-9]|1[0-2])$/)?.[1];
  return Number.isInteger(year) && year >= 1900 && month ? `${year}-${month}` : null;
}

function observationValue(observation = {}) {
  const value = Number(String(observation.value ?? '').replace(/,/g, ''));
  return Number.isFinite(value) && value > 0 ? value : null;
}

function calculateOfficialCpiFinals(observations = [], { source = 'bls_api' } = {}) {
  const indexByMonth = new Map();
  observations.forEach((observation) => {
    const monthId = observationMonthId(observation);
    const value = observationValue(observation);
    if (monthId && value != null) indexByMonth.set(monthId, value);
  });

  return [...indexByMonth.keys()]
    .sort()
    .map((monthId) => {
      const [yearText, monthText] = monthId.split('-');
      const priorYearId = `${Number(yearText) - 1}-${monthText}`;
      const currentIndex = indexByMonth.get(monthId);
      const priorIndex = indexByMonth.get(priorYearId);
      if (!Number.isFinite(currentIndex) || !Number.isFinite(priorIndex) || priorIndex <= 0) return null;
      return {
        id: monthId,
        // BLS publishes the year-over-year CPI release rounded to one decimal.
        value: Number((((currentIndex / priorIndex) - 1) * 100).toFixed(1)),
        source,
        seriesId: BLS_CPI_SERIES_ID,
      };
    })
    .filter(Boolean);
}

function normalizeBlsCpiResponse(payload = {}, options = {}) {
  const series = Array.isArray(payload?.Results?.series) ? payload.Results.series : [];
  const observations = series.find((item) => item?.seriesID === BLS_CPI_SERIES_ID)?.data || [];
  return calculateOfficialCpiFinals(observations, options);
}

function filterOfficialCpiFinalsByYear(finals = [], startYear = null, endYear = null) {
  return finals.filter((entry) => {
    const year = Number(String(entry?.id || '').slice(0, 4));
    return Number.isInteger(year)
      && (!Number.isInteger(startYear) || year >= startYear)
      && (!Number.isInteger(endYear) || year <= endYear);
  });
}

function normalizeBlsCpiDataFile(payload = '', { startYear = null, endYear = null, source = 'bls_flat_file' } = {}) {
  const observations = String(payload || '')
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter((fields) => fields.length >= 4 && fields[0] === BLS_CPI_SERIES_ID)
    .map(([seriesId, year, period, value]) => ({ seriesId, year, period, value }))
    .filter((observation) => {
      const year = Number(observation.year);
      return (!Number.isInteger(startYear) || year >= startYear)
        && (!Number.isInteger(endYear) || year <= endYear);
    });
  return calculateOfficialCpiFinals(observations, { source });
}

function mergeOfficialCpiFinals(finals = []) {
  const byMonth = new Map(finals.filter((entry) => entry?.id).map((entry) => [entry.id, entry]));
  BLS_RELEASE_CHECKPOINTS.forEach((entry) => byMonth.set(entry.id, entry));
  return [...byMonth.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function createOfficialCpiSnapshot({
  finals = [],
  source = 'bls_release',
  refreshing = false,
  remoteStatus = 'refreshing',
  lastRemoteSuccessAt = null,
  remoteError = null,
} = {}) {
  const snapshot = {
    ok: true,
    source,
    seriesId: BLS_CPI_SERIES_ID,
    fetchedAt: new Date().toISOString(),
    finals: mergeOfficialCpiFinals(finals),
    refreshing: Boolean(refreshing),
    remoteStatus,
  };
  if (lastRemoteSuccessAt) snapshot.lastRemoteSuccessAt = lastRemoteSuccessAt;
  if (remoteError) snapshot.remoteError = remoteError;
  return snapshot;
}

function cacheOfficialCpiSnapshot(cacheKey, value) {
  cache.set(cacheKey, {
    value,
    expiresAt: Date.now() + BLS_CACHE_TTL_MS,
  });
  return value;
}

async function fetchOfficialCpiFinals({ httpClient = axios, startYear, endYear } = {}) {
  // A YoY release in startYear needs the matching monthly index from the
  // preceding calendar year. Fetch that extra year, then return only the
  // caller's requested final-release window.
  const observationStartYear = Number.isInteger(startYear) ? startYear - 1 : startYear;
  let source = 'bls_api';
  let finals;
  let apiError;
  try {
    const response = await httpClient.get(BLS_CPI_API_URL, {
      params: {
        seriesid: BLS_CPI_SERIES_ID,
        startyear: observationStartYear,
        endyear: endYear,
      },
      timeout: 10000,
      headers: { Accept: 'application/json' },
    });
    const status = String(response?.data?.status || '').toUpperCase();
    if (status && status !== 'REQUEST_SUCCEEDED') {
      throw new Error(`BLS CPI request failed with status ${status}.`);
    }
    finals = filterOfficialCpiFinalsByYear(
      normalizeBlsCpiResponse(response?.data),
      startYear,
      endYear,
    );
  } catch (error) {
    apiError = error;
    const response = await httpClient.get(BLS_CPI_DATA_URL, {
      responseType: 'text',
      timeout: 15000,
      headers: {
        // downloadt.bls.gov rejects a narrow text/plain Accept header.
        Accept: '*/*',
        'User-Agent': 'market-dashboard-cpi-official/1.0',
      },
    });
    source = 'bls_flat_file';
    finals = filterOfficialCpiFinalsByYear(
      normalizeBlsCpiDataFile(response?.data, {
        startYear: observationStartYear,
        endYear,
        source,
      }),
      startYear,
      endYear,
    );
    if (!finals.length) {
      throw new Error(`BLS CPI sources returned no official ${startYear}-${endYear} observations after API failure: ${apiError.message}`);
    }
  }
  return { source, finals };
}

function refreshOfficialCpiFinals({ cacheKey, startYear, endYear, httpClient = axios } = {}) {
  const existing = refreshInFlight.get(cacheKey);
  if (existing) return existing;

  const refreshPromise = fetchOfficialCpiFinals({ httpClient, startYear, endYear })
    .then(({ source, finals }) => {
      return cacheOfficialCpiSnapshot(cacheKey, createOfficialCpiSnapshot({
        finals,
        source,
        refreshing: false,
        remoteStatus: 'ready',
        lastRemoteSuccessAt: new Date().toISOString(),
      }));
    })
    .catch((error) => {
      const previous = cache.get(cacheKey)?.value;
      return cacheOfficialCpiSnapshot(cacheKey, createOfficialCpiSnapshot({
        finals: previous?.finals || [],
        source: previous?.source || 'bls_release',
        refreshing: false,
        remoteStatus: 'unavailable',
        lastRemoteSuccessAt: previous?.lastRemoteSuccessAt || null,
        remoteError: error.message || 'Official BLS CPI refresh failed.',
      }));
    })
    .finally(() => {
      refreshInFlight.delete(cacheKey);
    });

  refreshInFlight.set(cacheKey, refreshPromise);
  return refreshPromise;
}

async function loadOfficialCpiFinals({
  httpClient = axios,
  now = Date.now(),
  useCache = true,
  awaitRemote = false,
} = {}) {
  const timestamp = Number(now);
  const currentYear = new Date(Number.isFinite(timestamp) ? timestamp : Date.now()).getUTCFullYear();
  const startYear = currentYear - 1;
  const endYear = currentYear;
  const cacheKey = `${startYear}-${endYear}`;
  const cached = cache.get(cacheKey);
  const cacheIsFresh = useCache && cached && cached.expiresAt > Date.now();

  if (cacheIsFresh && cached.value.remoteStatus === 'ready') return cached.value;

  const base = cached?.value || createOfficialCpiSnapshot({
    finals: [],
    source: 'bls_release',
    refreshing: true,
    remoteStatus: 'refreshing',
  });
  const immediate = {
    ...base,
    finals: mergeOfficialCpiFinals(base.finals || []),
    refreshing: true,
    remoteStatus: 'refreshing',
  };
  if (useCache) cacheOfficialCpiSnapshot(cacheKey, immediate);

  // The verified release checkpoint is returned immediately. The slow BLS
  // API/flat-file refresh updates the in-memory snapshot for the next request.
  const refreshPromise = refreshOfficialCpiFinals({ cacheKey, startYear, endYear, httpClient });
  if (awaitRemote) return refreshPromise;
  return immediate;
}

function clearOfficialCpiFinalsCache() {
  cache.clear();
  refreshInFlight.clear();
}

module.exports = {
  BLS_CPI_DATA_URL,
  BLS_CPI_API_URL,
  BLS_RELEASE_CHECKPOINTS,
  BLS_CPI_SERIES_ID,
  calculateOfficialCpiFinals,
  clearOfficialCpiFinalsCache,
  fetchOfficialCpiFinals,
  filterOfficialCpiFinalsByYear,
  loadOfficialCpiFinals,
  mergeOfficialCpiFinals,
  normalizeBlsCpiDataFile,
  normalizeBlsCpiResponse,
  observationMonthId,
  refreshOfficialCpiFinals,
};
