const axios = require('axios/dist/node/axios.cjs');
const {
  loadClevelandFedCpiNowcast,
} = require('./signalAvailabilityProvider');
const { CPI_RELEASES } = require('../../utils/cpiNowcastHistory.cjs');

const TRADING_ECONOMICS_CALENDAR_URL =
  'https://api.tradingeconomics.com/calendar/country/united%20states/indicator/inflation%20rate';
const TRADING_ECONOMICS_SOURCE_URL =
  'https://tradingeconomics.com/united-states/inflation-cpi';
const TRADING_ECONOMICS_PUBLIC_CALENDAR_URL =
  'https://tradingeconomics.com/united-states/calendar';
const CLEVELAND_FED_SOURCE_URL =
  'https://www.clevelandfed.org/indicators-and-data/inflation-nowcasting';
const REGULAR_CACHE_TTL_MS = 2 * 60 * 60 * 1000;
const RELEASE_DAY_CACHE_TTL_MS = 30 * 60 * 1000;
const UNAVAILABLE_CACHE_TTL_MS = 5 * 60 * 1000;
const PUBLIC_CALENDAR_CACHE_TTL_MS = 15 * 60 * 1000;
const RELEASE_DAY_WINDOW_MS = 24 * 60 * 60 * 1000;
const CONTEXT_RELEASES = Object.freeze({
  '2025-06': '2025-07-15T12:30:00.000Z',
});

const consensusCache = new Map();

const CPI_RELEASE_METRICS = Object.freeze([
  Object.freeze({
    id: 'headline-mom',
    label: 'Headline MoM',
    event: 'inflation rate mom',
    sourceUrl: 'https://tradingeconomics.com/united-states/inflation-rate-mom',
  }),
  Object.freeze({
    id: 'headline-yoy',
    label: 'Headline YoY',
    event: 'inflation rate yoy',
    sourceUrl: TRADING_ECONOMICS_SOURCE_URL,
  }),
  Object.freeze({
    id: 'core-mom',
    label: 'Core MoM',
    event: 'core inflation rate mom',
    sourceUrl: 'https://tradingeconomics.com/united-states/core-inflation-rate-mom',
  }),
  Object.freeze({
    id: 'core-yoy',
    label: 'Core YoY',
    event: 'core inflation rate yoy',
    sourceUrl: 'https://tradingeconomics.com/united-states/core-inflation-rate',
  }),
]);

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

function plainHtmlText(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function htmlElementTextById(rowHtml, id) {
  const pattern = new RegExp(
    `<(?:a|span)\\b[^>]*\\bid=(?:"${id}"|'${id}')[^>]*>([\\s\\S]*?)<\\/(?:a|span)>`,
    'i',
  );
  return plainHtmlText(String(rowHtml || '').match(pattern)?.[1]);
}

function emptyPublicReleaseRows(period, releaseAt, reason) {
  return CPI_RELEASE_METRICS.map((metric) => ({
    ...metric,
    period,
    releaseAt,
    status: 'unavailable',
    previous: null,
    consensus: null,
    providerForecast: null,
    actual: null,
    source: 'trading_economics_public_calendar',
    provider: 'Trading Economics',
    checkedAt: null,
    reason,
  }));
}

function normalizeTradingEconomicsPublicReleaseSetup(
  payload,
  requiredMonth,
  { releaseAt = null, checkedAt = null } = {},
) {
  const period = normalizeCpiBenchmarkMonth(requiredMonth);
  const normalizedReleaseAt = isoTimestamp(releaseAt);
  const releaseDate = normalizedReleaseAt?.slice(0, 10) || null;
  const monthNumber = Number(String(period || '').slice(5, 7));
  const expectedReference = Number.isInteger(monthNumber) && monthNumber >= 1 && monthNumber <= 12
    ? new Date(Date.UTC(2000, monthNumber - 1, 1))
      .toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' })
      .toUpperCase()
    : null;
  const reason = !period
    ? 'A valid CPI report month is required.'
    : !releaseDate
      ? `No verified CPI release date is available for ${period}.`
      : null;
  if (reason) return emptyPublicReleaseRows(period, normalizedReleaseAt, reason);

  const rowByEvent = new Map();
  // Calendar rows contain a nested country table with its own <tr>. Delimit
  // source rows by the next data-event row instead of the first closing tag.
  const rowPattern = /<tr\b([^>]*\bdata-event=['"]([^'"]+)['"][^>]*)>([\s\S]*?)(?=<tr\b[^>]*\bdata-event=['"]|$)/gi;
  for (const match of String(payload || '').matchAll(rowPattern)) {
    const event = plainHtmlText(match[2]).toLowerCase();
    if (!CPI_RELEASE_METRICS.some((metric) => metric.event === event)) continue;
    const rowHtml = match[3];
    const rowDate = String(rowHtml).match(/class=['"][^'"]*\b(20\d{2}-\d{2}-\d{2})\b[^'"]*['"]/i)?.[1] || null;
    const reference = plainHtmlText(
      String(rowHtml).match(/<span\b[^>]*class=['"]calendar-reference['"][^>]*>([\s\S]*?)<\/span>/i)?.[1],
    ).toUpperCase();
    if (rowDate !== releaseDate || reference !== expectedReference) continue;
    rowByEvent.set(event, rowHtml);
  }

  return CPI_RELEASE_METRICS.map((metric) => {
    const rowHtml = rowByEvent.get(metric.event) || null;
    if (!rowHtml) {
      return {
        ...metric,
        period,
        releaseAt: normalizedReleaseAt,
        status: 'unavailable',
        previous: null,
        consensus: null,
        providerForecast: null,
        actual: null,
        source: 'trading_economics_public_calendar',
        provider: 'Trading Economics',
        checkedAt,
        reason: `No exact ${metric.label} calendar row is available for ${period}.`,
      };
    }
    const consensus = numericPercent(htmlElementTextById(rowHtml, 'consensus'));
    return {
      ...metric,
      period,
      releaseAt: normalizedReleaseAt,
      status: 'available',
      previous: numericPercent(htmlElementTextById(rowHtml, 'previous')),
      consensus,
      providerForecast: numericPercent(htmlElementTextById(rowHtml, 'forecast')),
      actual: numericPercent(htmlElementTextById(rowHtml, 'actual')),
      source: 'trading_economics_public_calendar',
      provider: 'Trading Economics',
      checkedAt,
      reason: consensus == null
        ? `Street consensus has not been published for ${metric.label} in ${period}.`
        : null,
    };
  });
}

async function loadTradingEconomicsPublicReleaseSetup(options = {}) {
  const period = normalizeCpiBenchmarkMonth(options.requiredMonth);
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const releaseAt = isoTimestamp(options.releaseAt || CPI_RELEASES[period] || CONTEXT_RELEASES[period]);
  const common = {
    status: 'unavailable',
    period,
    releaseAt,
    source: 'trading_economics_public_calendar',
    provider: 'Trading Economics',
    sourceUrl: TRADING_ECONOMICS_PUBLIC_CALENDAR_URL,
    checkedAt: null,
    rows: emptyPublicReleaseRows(period, releaseAt, 'Trading Economics public calendar is unavailable.'),
  };
  if (!period || !releaseAt) {
    return {
      ...common,
      reason: !period
        ? 'A valid CPI report month is required.'
        : `No verified CPI release date is available for ${period}.`,
    };
  }

  const cacheKey = `trading-economics:public-calendar:${period}`;
  const cached = consensusCache.get(cacheKey);
  if (options.useCache !== false && cached && cached.expiresAt > now) return cached.value;

  let value;
  try {
    const client = options.httpClient || axios;
    const releaseDate = releaseAt.slice(0, 10);
    const response = await client.get(TRADING_ECONOMICS_PUBLIC_CALENDAR_URL, {
      params: {
        importance: 3,
        start: releaseDate,
        end: releaseDate,
      },
      responseType: 'text',
      timeout: 10000,
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': 'market-dashboard-cpi-research/1.0',
      },
    });
    const checkedAt = new Date(now).toISOString();
    const rows = normalizeTradingEconomicsPublicReleaseSetup(response?.data, period, {
      releaseAt,
      checkedAt,
    });
    const availableCount = rows.filter((row) => row.status === 'available').length;
    value = {
      ...common,
      status: availableCount === rows.length ? 'available' : availableCount ? 'partial' : 'unavailable',
      checkedAt,
      rows,
      reason: availableCount ? null : `No exact CPI release rows are available for ${period}.`,
    };
  } catch (error) {
    value = {
      ...common,
      reason: error?.message || 'Trading Economics public calendar could not be fetched.',
      errorCode: 'UPSTREAM_UNAVAILABLE',
    };
  }

  if (options.useCache !== false) {
    consensusCache.set(cacheKey, {
      value,
      expiresAt: now + (value.status === 'unavailable'
        ? UNAVAILABLE_CACHE_TTL_MS
        : PUBLIC_CALENDAR_CACHE_TTL_MS),
    });
  }
  return value;
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
  const publicReleaseSetup = options.includePublicReleaseSetup === true
    ? await loadTradingEconomicsPublicReleaseSetup({
        requiredMonth: period,
        releaseAt,
        now,
        httpClient: options.publicHttpClient,
        useCache: options.useCache,
      })
    : null;
  const publicHeadlineYoy = publicReleaseSetup?.rows
    ?.find((row) => row.id === 'headline-yoy' && row.period === period) || null;
  const publicConsensusPoint = numericPercent(publicHeadlineYoy?.consensus);
  const consensus = loadedConsensus.status === 'available' || publicConsensusPoint == null ? {
    ...loadedConsensus,
    releaseAt,
    ...(publicHeadlineYoy?.status === 'available' && loadedConsensus.status !== 'available' ? {
      reason: publicHeadlineYoy.reason,
      errorCode: null,
    } : {}),
  } : {
    id: 'wall-street-consensus',
    kind: 'consensus',
    period,
    status: 'available',
    point: publicConsensusPoint,
    source: publicHeadlineYoy.source,
    provider: publicHeadlineYoy.provider,
    sourceUrl: publicHeadlineYoy.sourceUrl,
    releaseAt,
    asOf: publicHeadlineYoy.checkedAt,
    reason: null,
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
    releaseSetup: publicReleaseSetup,
  };
}

function clearCpiBenchmarkCache() {
  consensusCache.clear();
}

module.exports = {
  CLEVELAND_FED_SOURCE_URL,
  TRADING_ECONOMICS_CALENDAR_URL,
  TRADING_ECONOMICS_PUBLIC_CALENDAR_URL,
  TRADING_ECONOMICS_SOURCE_URL,
  clearCpiBenchmarkCache,
  loadCpiBenchmarks,
  loadTradingEconomicsPublicReleaseSetup,
  loadTradingEconomicsCpiConsensus,
  normalizeClevelandFedBenchmark,
  normalizeCpiBenchmarkMonth,
  normalizeTradingEconomicsPublicReleaseSetup,
  normalizeTradingEconomicsCpiConsensus,
  releaseWindowForMonth,
};
