const axios = require('axios/dist/node/axios.cjs');
const {
  loadClevelandFedCpiNowcast,
} = require('./signalAvailabilityProvider');
const { CPI_RELEASES } = require('../../utils/cpiNowcastHistory.cjs');

const TRADING_ECONOMICS_CALENDAR_URL =
  'https://api.tradingeconomics.com/calendar/country/united%20states/indicator/inflation%20rate';
const TRADING_ECONOMICS_SOURCE_URL =
  'https://tradingeconomics.com/united-states/inflation-cpi';
const CLEVELAND_FED_SOURCE_URL =
  'https://www.clevelandfed.org/indicators-and-data/inflation-nowcasting';
const REGULAR_CACHE_TTL_MS = 2 * 60 * 60 * 1000;
const RELEASE_DAY_CACHE_TTL_MS = 30 * 60 * 1000;
const UNAVAILABLE_CACHE_TTL_MS = 5 * 60 * 1000;
const RELEASE_DAY_WINDOW_MS = 24 * 60 * 60 * 1000;
const CONTEXT_RELEASES = Object.freeze({
  '2025-06': '2025-07-15T12:30:00.000Z',
});

const consensusCache = new Map();

function normalizeCpiBenchmarkMonth(value) {
  const match = String(value || '').trim().match(/^(20\d{2})-(0[1-9]|1[0-2])$/);
  return match ? `${match[1]}-${match[2]}` : null;
}

function isoTimestamp(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const normalized = raw.replace(' ', 'T');
  const utcValue = /^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(normalized)
    ? `${normalized}Z`
    : normalized;
  const parsed = Date.parse(utcValue);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function timestampMillis(value) {
  const normalized = isoTimestamp(value);
  return normalized ? Date.parse(normalized) : 0;
}

function numericPercent(value) {
  if (value == null || String(value).trim() === '') return null;
  const parsed = Number(String(value).replace(/[,%\s]/g, ''));
  return Number.isFinite(parsed) && parsed >= -100 && parsed <= 100 ? parsed : null;
}

function releaseWindowForMonth(month) {
  const normalized = normalizeCpiBenchmarkMonth(month);
  if (!normalized) return null;
  const [yearText, monthText] = normalized.split('-');
  const year = Number(yearText);
  const reportMonth = Number(monthText);
  const first = new Date(Date.UTC(year, reportMonth, 1));
  const last = new Date(Date.UTC(year, reportMonth + 1, 0));
  return {
    from: first.toISOString().slice(0, 10),
    to: last.toISOString().slice(0, 10),
  };
}

function tradingEconomicsSourceUrl(row = {}) {
  const relative = String(row.URL || row.Url || row.url || '').trim();
  return relative.startsWith('/')
    ? `https://tradingeconomics.com${relative}`
    : TRADING_ECONOMICS_SOURCE_URL;
}

function tradingEconomicsReferenceMonth(row = {}) {
  const raw = String(row.ReferenceDate || row.referenceDate || '').trim();
  const match = raw.match(/^(20\d{2})-(0[1-9]|1[0-2])-/);
  return match ? `${match[1]}-${match[2]}` : null;
}

function normalizeTradingEconomicsCpiConsensus(payload, requiredMonth) {
  const period = normalizeCpiBenchmarkMonth(requiredMonth);
  const rows = Array.isArray(payload) ? payload : [];
  const candidates = rows.filter((row) => {
    const country = String(row.Country || row.country || '').trim().toLowerCase();
    const event = String(row.Event || row.event || '').trim().toLowerCase();
    const unit = String(row.Unit || row.unit || '').trim().toLowerCase();
    return country === 'united states'
      && event === 'inflation rate yoy'
      && ['%', 'percent'].includes(unit)
      && tradingEconomicsReferenceMonth(row) === period;
  }).sort((left, right) => (
    timestampMillis(right.LastUpdate || right.lastUpdate)
      - timestampMillis(left.LastUpdate || left.lastUpdate)
  ));
  const selected = candidates[0] || null;
  const releaseAt = isoTimestamp(selected?.Date || selected?.date);
  const common = {
    id: 'wall-street-consensus',
    kind: 'consensus',
    period,
    source: 'trading_economics_consensus',
    provider: 'Trading Economics',
    sourceUrl: tradingEconomicsSourceUrl(selected || {}),
    releaseAt,
    asOf: isoTimestamp(selected?.LastUpdate || selected?.lastUpdate),
  };

  if (!selected) {
    return {
      ...common,
      status: 'unavailable',
      point: null,
      reason: `No exact United States Headline CPI YoY consensus event is available for ${period}.`,
    };
  }

  const point = numericPercent(selected.ForecastValue ?? selected.forecastValue)
    ?? numericPercent(selected.Forecast ?? selected.forecast);
  if (point == null) {
    return {
      ...common,
      status: 'unavailable',
      point: null,
      reason: `Wall Street consensus has not been published for ${period}.`,
    };
  }

  return {
    ...common,
    status: 'available',
    point,
    reason: null,
  };
}

function tradingEconomicsCacheTtl(result, now) {
  if (result?.errorCode === 'UPSTREAM_UNAVAILABLE') return UNAVAILABLE_CACHE_TTL_MS;
  const releaseAt = Date.parse(result?.releaseAt || '');
  const timeToRelease = releaseAt - now;
  return Number.isFinite(timeToRelease)
    && timeToRelease >= 0
    && timeToRelease <= RELEASE_DAY_WINDOW_MS
    ? RELEASE_DAY_CACHE_TTL_MS
    : REGULAR_CACHE_TTL_MS;
}

async function loadTradingEconomicsCpiConsensus(options = {}) {
  const period = normalizeCpiBenchmarkMonth(options.requiredMonth);
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const apiKey = String(options.apiKey ?? process.env.TRADING_ECONOMICS_API_KEY ?? '').trim();
  const common = {
    id: 'wall-street-consensus',
    kind: 'consensus',
    period,
    source: 'trading_economics_consensus',
    provider: 'Trading Economics',
    sourceUrl: TRADING_ECONOMICS_SOURCE_URL,
    releaseAt: null,
    asOf: null,
  };
  if (!period) {
    return {
      ...common,
      status: 'unavailable',
      point: null,
      reason: 'A valid CPI report month is required.',
    };
  }
  if (!apiKey) {
    return {
      ...common,
      status: 'unavailable',
      point: null,
      reason: 'Wall Street consensus feed is not configured.',
      errorCode: 'PROVIDER_NOT_CONFIGURED',
    };
  }

  const cacheKey = `trading-economics:cpi-yoy:${period}`;
  const cached = consensusCache.get(cacheKey);
  if (options.useCache !== false && cached && cached.expiresAt > now) {
    return cached.value;
  }

  let value;
  try {
    const window = releaseWindowForMonth(period);
    const client = options.httpClient || axios;
    const response = await client.get(
      `${TRADING_ECONOMICS_CALENDAR_URL}/${window.from}/${window.to}`,
      {
        params: {
          c: apiKey,
          values: 'true',
          f: 'json',
        },
        timeout: 10000,
        headers: { Accept: 'application/json' },
      },
    );
    value = normalizeTradingEconomicsCpiConsensus(response?.data, period);
  } catch (error) {
    value = {
      ...common,
      status: 'unavailable',
      point: null,
      reason: error?.message || 'Wall Street consensus could not be fetched.',
      errorCode: 'UPSTREAM_UNAVAILABLE',
    };
  }

  if (options.useCache !== false) {
    consensusCache.set(cacheKey, {
      value,
      expiresAt: now + tradingEconomicsCacheTtl(value, now),
    });
  }
  return value;
}

function normalizeClevelandFedBenchmark(result, period, releaseAt = null) {
  const point = numericPercent(result?.value);
  const exactPeriod = normalizeCpiBenchmarkMonth(result?.period || result?.sourceMonth);
  const common = {
    id: 'cleveland-fed',
    kind: 'nowcast',
    period,
    source: 'cleveland_fed_inflation_nowcasting',
    provider: 'Cleveland Fed',
    sourceUrl: CLEVELAND_FED_SOURCE_URL,
    releaseAt: releaseAt || result?.releaseAt || null,
    asOf: result?.asOf || null,
  };
  if (
    result?.status !== 'available'
    || exactPeriod !== period
    || String(result?.metric || '').trim().toLowerCase() !== 'headline cpi yoy'
    || point == null
  ) {
    return {
      ...common,
      status: 'unavailable',
      point: null,
      reason: result?.reason || `No exact Cleveland Fed Headline CPI YoY nowcast is available for ${period}.`,
    };
  }
  return {
    ...common,
    status: 'available',
    point,
    reason: null,
  };
}

async function loadCpiBenchmarks(options = {}) {
  const period = normalizeCpiBenchmarkMonth(options.month);
  if (!period) {
    const error = new Error('CPI benchmark month must use YYYY-MM.');
    error.code = 'CPI_BENCHMARK_MONTH_INVALID';
    throw error;
  }
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const loadedConsensus = await loadTradingEconomicsCpiConsensus({
    requiredMonth: period,
    now,
    apiKey: options.apiKey,
    httpClient: options.httpClient,
    useCache: options.useCache,
  });
  const releaseAt = loadedConsensus.releaseAt || CPI_RELEASES[period] || CONTEXT_RELEASES[period] || null;
  const consensus = {
    ...loadedConsensus,
    releaseAt,
  };
  const clevelandLoader = options.loadClevelandFed || loadClevelandFedCpiNowcast;
  let clevelandResult;
  try {
    clevelandResult = await clevelandLoader({
      requiredMonth: period,
      releaseAt: consensus.releaseAt,
      now,
      useCache: options.useCache,
    });
  } catch (error) {
    clevelandResult = {
      status: 'unavailable',
      reason: error?.message || 'The Cleveland Fed CPI nowcast could not be fetched.',
    };
  }
  const cleveland = normalizeClevelandFedBenchmark(
    clevelandResult,
    period,
    releaseAt,
  );
  const sources = [consensus, cleveland];
  return {
    ok: sources.some((source) => source.status === 'available'),
    period,
    metric: 'headline-cpi-yoy',
    unit: 'percent',
    fetchedAt: new Date(now).toISOString(),
    sources,
  };
}

function clearCpiBenchmarkCache() {
  consensusCache.clear();
}

module.exports = {
  CLEVELAND_FED_SOURCE_URL,
  TRADING_ECONOMICS_CALENDAR_URL,
  TRADING_ECONOMICS_SOURCE_URL,
  clearCpiBenchmarkCache,
  loadCpiBenchmarks,
  loadTradingEconomicsCpiConsensus,
  normalizeClevelandFedBenchmark,
  normalizeCpiBenchmarkMonth,
  normalizeTradingEconomicsCpiConsensus,
  releaseWindowForMonth,
};
