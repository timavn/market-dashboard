const { DynamoDB } = require('../aws/clients.cjs');
const axios = require('axios/dist/node/axios.cjs');
const { expectedRiskRangePublication } = require('../../utils/riskRangePublication.cjs');
const {
  cpiSignalDetailsFromForecast,
  selectCpiForecast,
} = require('./cpiNowcastSelector.cjs');

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const CLEVELAND_FED_NOWCAST_TTL_MS = 10 * 60 * 1000;
const RISK_RANGE_HISTORY_TABLE = process.env.HEDGEYE_RISK_RANGE_HISTORY_TABLE ||
  process.env.RISK_RANGE_HISTORY_TABLE ||
  'RiskRangeData';
const CLEVELAND_FED_NOWCAST_URL = 'https://www.clevelandfed.org/-/media/files/webcharts/inflationnowcasting/nowcast_year.json?sc_lang=en';
const CLEVELAND_FED_TRANSIENT_ERROR = /abort|timeout|timed out|econn|socket|network|premature/i;
const MONTHS = Object.freeze({
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
});
const MONTH_NAMES = Object.freeze({
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
});

const defaultDynamodb = new DynamoDB.DocumentClient();
const cache = new Map();

function dateKeyInNewYork(value) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return values.year && values.month && values.day
    ? `${values.year}-${values.month}-${values.day}`
    : null;
}

function cpiMonthFromEvent(event = {}) {
  const ticker = String(event.ticker || event.eventTicker || '').toUpperCase();
  const match = ticker.match(/-(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(?:-|$)/);
  if (!match) return null;
  return `20${match[1]}-${String(MONTHS[match[2]]).padStart(2, '0')}`;
}

function cpiMonthFromSnapshot(snapshot = {}) {
  const label = String(snapshot?.data?.forecastMonth || snapshot?.forecastMonth || '').trim().toLowerCase();
  const match = label.match(/^(january|february|march|april|may|june|july|august|september|october|november|december)\s+(20\d{2})$/);
  if (!match) return null;
  return `${match[2]}-${String(MONTH_NAMES[match[1]]).padStart(2, '0')}`;
}

function finiteRange(item) {
  const lrr = Number(item?.lrr);
  const hrr = Number(item?.hrr);
  return Number.isFinite(lrr) && Number.isFinite(hrr) && lrr < hrr;
}

function optionalFiniteNumber(value) {
  if (value == null || value === '') return null;
  const parsed = Number(String(value).replace(/[$,%\s,]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function toPercent(value) {
  if (value == null || value === '') return null;
  const numeric = Number(String(value).replace(/[$,%\s,]/g, ''));
  if (!Number.isFinite(numeric)) return null;
  return Math.abs(numeric) > 0 && Math.abs(numeric) <= 0.05 ? numeric * 100 : numeric;
}

function cpiSignalDetails(snapshot = {}) {
  const data = snapshot?.data || snapshot || {};
  const rawScenarios = Array.isArray(data.scenarios)
    ? data.scenarios
    : [
        { key: 'upside', label: 'Upside', value: data.upside ?? data.upsideMom ?? data.upsideM_m },
        { key: 'base', label: 'Base Case', value: data.base ?? data.baseCase ?? data.baseMom ?? data.baseM_m },
        { key: 'downside', label: 'Downside', value: data.downside ?? data.downsideMom ?? data.downsideM_m },
      ];
  const scenarios = rawScenarios.slice(0, 3).map((scenario, index) => ({
    key: scenario?.key || ['upside', 'base', 'downside'][index],
    label: scenario?.label || scenario?.name || ['Upside', 'Base Case', 'Downside'][index],
    value: toPercent(
      scenario?.percent ??
      scenario?.m_m ??
      scenario?.mom ??
      scenario?.forecast ??
      scenario?.raw ??
      scenario?.value,
    ),
  })).filter((scenario) => Number.isFinite(scenario.value));
  return {
    forecastMonth: data.forecastMonth || data.reportMonth || snapshot.forecastMonth || null,
    metric: data.metric || data.measure || data.title || data.heading || null,
    outlook: data.outlook || null,
    releaseDate: data.releaseDate?.date || data.releaseDate || data.release_date || snapshot.releaseDate || null,
    scenarios,
  };
}

async function cachedLoad(key, loader, {
  now = Date.now(),
  ttlMs = DEFAULT_TTL_MS,
  useCache = true,
  shouldCache = () => true,
} = {}) {
  const current = cache.get(key);
  if (useCache && current && current.expiresAt > now) return current.value;
  const value = await loader();
  if (useCache && shouldCache(value)) cache.set(key, { value, expiresAt: now + ttlMs });
  return value;
}

async function loadExactRiskRange(dynamodb, ticker, date, options) {
  if (!ticker || !date) return null;
  return cachedLoad(`risk:${ticker}:${date}`, async () => {
    const result = await dynamodb.get({
      TableName: RISK_RANGE_HISTORY_TABLE,
      Key: { ticker, date },
    }).promise();
    return result.Item || null;
  }, options);
}

async function loadExactRiskRanges(dynamodb, ticker, dates, options) {
  const dateKeys = Array.isArray(dates) ? dates : [];
  if (!ticker || dateKeys.length === 0) return [];
  if (typeof dynamodb?.batchGet !== 'function') {
    return Promise.all(dateKeys.map((date) => loadExactRiskRange(dynamodb, ticker, date, options)));
  }

  const chunks = [];
  for (let index = 0; index < dateKeys.length; index += 100) {
    chunks.push(dateKeys.slice(index, index + 100));
  }
  const results = await Promise.all(chunks.map((chunk) => dynamodb.batchGet({
    RequestItems: {
      [RISK_RANGE_HISTORY_TABLE]: {
        Keys: chunk.map((date) => ({ ticker, date })),
      },
    },
  }).promise()));
  const rowsByDate = new Map(
    results.flatMap((result) => result?.Responses?.[RISK_RANGE_HISTORY_TABLE] || [])
      .filter((row) => row?.ticker === ticker && dateKeys.includes(row?.date))
      .map((row) => [row.date, row]),
  );
  const unprocessed = results.flatMap((result) => (
    result?.UnprocessedKeys?.[RISK_RANGE_HISTORY_TABLE]?.Keys || []
  ));
  const retryDates = [...new Set(unprocessed
    .filter((key) => key?.ticker === ticker && dateKeys.includes(key?.date))
    .map((key) => key.date))];
  if (retryDates.length > 0) {
    const retried = await Promise.all(retryDates.map((date) => (
      loadExactRiskRange(dynamodb, ticker, date, options)
    )));
    retryDates.forEach((date, index) => {
      if (retried[index]) rowsByDate.set(date, retried[index]);
    });
  }
  return dateKeys.map((date) => rowsByDate.get(date) || null);
}

async function loadCurrentRiskRange(dynamodb, ticker, now, options) {
  if (!ticker || typeof dynamodb?.query !== 'function') return null;
  const publicationDate = expectedRiskRangePublication(new Date(now), {
    deadlineHour: Number(process.env.RISK_RANGE_DEADLINE_HOUR_ET || 8),
    deadlineMinute: Number(process.env.RISK_RANGE_DEADLINE_MINUTE_ET || 15),
  }).expectedDate;
  if (!publicationDate) return null;

  return cachedLoad(`risk:current:${ticker}:${publicationDate}`, async () => {
    const result = await dynamodb.query({
      TableName: RISK_RANGE_HISTORY_TABLE,
      KeyConditionExpression: 'ticker = :ticker AND #date = :date',
      ExpressionAttributeNames: { '#date': 'date' },
      ExpressionAttributeValues: { ':ticker': ticker, ':date': publicationDate },
      Limit: 1,
    }).promise();
    return (result.Items || []).find(finiteRange) || null;
  }, options);
}

async function getRiskRangeHistoryAvailability({ ticker, dates = [] } = {}, options = {}) {
  const normalizedTicker = String(ticker || '').trim().toUpperCase();
  const dateKeys = [...new Set((Array.isArray(dates) ? dates : [])
    .map((date) => String(date || '').trim())
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)))].sort();
  if (!normalizedTicker || dateKeys.length === 0) {
    return {
      status: 'unavailable',
      source: 'RiskRangeData',
      ticker: normalizedTicker || null,
      ranges: {},
      missingDates: dateKeys,
      reason: 'No exact-date Risk Range dates were requested.',
    };
  }

  const dynamodb = options.dynamodb || defaultDynamodb;
  const rows = await loadExactRiskRanges(dynamodb, normalizedTicker, dateKeys, {
    ...options,
    useCache: options.useCache !== false && !options.dynamodb,
  });
  const ranges = Object.fromEntries(dateKeys.map((date, index) => {
    const row = rows[index];
    return finiteRange(row)
      ? [date, {
        ticker: normalizedTicker,
        date,
        lrr: Number(row.lrr),
        hrr: Number(row.hrr),
        trend: row.trend || null,
        ...(optionalFiniteNumber(row.prevClose ?? row.previousClose) != null
          ? { previousClose: optionalFiniteNumber(row.prevClose ?? row.previousClose) }
          : {}),
        source: row.source || 'RiskRangeData',
        asOf: row.date || date,
      }]
      : null;
  }).filter(Boolean));
  const missingDates = dateKeys.filter((date) => !ranges[date]);
  return {
    status: missingDates.length === 0 ? 'available' : 'unavailable',
    source: 'RiskRangeData',
    ticker: normalizedTicker,
    ranges,
    missingDates,
    reason: missingDates.length === 0
      ? null
      : `Exact-date Risk Range data is unavailable for ${missingDates.join(', ')}.`,
  };
}

// Monthly Inflation Nowcast emails commonly arrive just after the prior CPI
// release, which can put the still-current forecast more than 21 days behind
// the next release. Keep this under DynamoDB BatchGetItem's 100-key ceiling;
// selectCpiForecast still requires an exact future release before using a row.
const CPI_NOWCAST_LOOKBACK_DAYS = 75;

function recentDateKeys(now, count = 21) {
  return Array.from({ length: count }, (_, index) => (
    dateKeyInNewYork(new Date(now - index * 24 * 60 * 60 * 1000))
  )).filter(Boolean);
}

async function loadLatestCpiSnapshot(dynamodb = defaultDynamodb, options = {}) {
  const snapshots = await loadCpiNowcastSnapshots(dynamodb, options);
  return snapshots[0] || null;
}

async function loadCpiNowcastSnapshots(dynamodb = defaultDynamodb, options = {}) {
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  return cachedLoad('cpi:inflation-nowcast:recent', async () => {
    const keys = recentDateKeys(now, CPI_NOWCAST_LOOKBACK_DAYS)
      .map((date) => ({ date, snapshotType: 'inflation-nowcast' }));
    const result = await dynamodb.batchGet({
      RequestItems: {
        HedgeyeDailySnapshot: { Keys: keys },
      },
    }).promise();
    return (result.Responses?.HedgeyeDailySnapshot || [])
      .sort((left, right) => String(right.date || '').localeCompare(String(left.date || '')));
  }, {
    ...options,
    // The release boundary is a hard source-of-truth transition. Keep the
    // read-through short so a newly materialized next-month chart is visible
    // without waiting for the generic signal cache to age out.
    ttlMs: Math.min(Number(options.ttlMs || DEFAULT_TTL_MS), 30 * 1000),
  });
}

function clevelandFedMonthKey(value) {
  const match = String(value || '').trim().match(/^(20\d{2})-(\d{1,2})$/);
  return match ? `${match[1]}-${String(match[2]).padStart(2, '0')}` : null;
}

function clevelandFedCategories(group = {}) {
  const categories = group?.categories?.[0]?.category || group?.categories || [];
  return Array.isArray(categories) ? categories : [];
}

function clevelandFedAsOf(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const parsed = Date.parse(raw.replace(' ', 'T') + (raw.endsWith('Z') ? '' : 'Z'));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : raw;
}

function clevelandFedPointTimestamp(monthKey, label) {
  const monthMatch = String(monthKey || '').match(/^(20\d{2})-(\d{2})$/);
  const labelMatch = String(label || '').match(/^(\d{2})\/(\d{2})$/);
  if (!monthMatch || !labelMatch) return null;
  const reportYear = Number(monthMatch[1]);
  const reportMonth = Number(monthMatch[2]);
  const month = Number(labelMatch[1]);
  const day = Number(labelMatch[2]);
  if (!Number.isInteger(reportYear) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  let year = reportYear;
  if (reportMonth >= 10 && month <= 3) year += 1;
  if (reportMonth <= 3 && month >= 10) year -= 1;
  const timestamp = Date.UTC(year, month - 1, day, 12, 0, 0);
  const date = new Date(timestamp);
  return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day
    ? timestamp
    : null;
}

function normalizeClevelandFedNowcast(payload, requiredMonth = null) {
  const groups = Array.isArray(payload) ? payload : [];
  const requestedMonth = clevelandFedMonthKey(requiredMonth);
  const candidates = groups
    .map((group) => ({ group, month: clevelandFedMonthKey(group?.chart?.subcaption) }))
    .filter((candidate) => candidate.month && (!requestedMonth || candidate.month === requestedMonth));
  const selected = candidates
    .sort((left, right) => left.month.localeCompare(right.month))
    .at(-1);
  const sourceMonth = selected?.month || null;
  const dataset = selected?.group?.dataset?.find((series) => series?.seriesname === 'CPI Inflation');
  const datasetPoints = Array.isArray(dataset?.data) ? dataset.data : [];
  const categories = clevelandFedCategories(selected?.group);
  const points = categories.map((category, index) => {
    const timestamp = clevelandFedPointTimestamp(sourceMonth, category?.label);
    const rawValue = datasetPoints[index]?.value;
    const value = rawValue == null || String(rawValue).trim() === ''
      ? null
      : Number(rawValue);
    return timestamp != null && Number.isFinite(value) && value >= 0 && value <= 100
      ? { timestamp, value }
      : null;
  }).filter(Boolean);
  const latest = points.at(-1);
  if (!selected || !dataset || !latest) {
    return {
      status: 'unavailable',
      source: 'cleveland_fed_inflation_nowcasting',
      sourceUrl: CLEVELAND_FED_NOWCAST_URL,
      requiredMonth: requestedMonth,
      sourceMonth,
      reason: requestedMonth && sourceMonth !== requestedMonth
        ? 'The Cleveland Fed nowcast is not available for the requested CPI month.'
        : 'The Cleveland Fed CPI nowcast series is unavailable.',
    };
  }

  return {
    status: 'available',
    source: 'cleveland_fed_inflation_nowcasting',
    sourceUrl: CLEVELAND_FED_NOWCAST_URL,
    provider: 'Cleveland Fed',
    metric: 'Headline CPI YoY',
    requiredMonth: requestedMonth || sourceMonth,
    sourceMonth,
    period: sourceMonth,
    asOf: new Date(latest.timestamp).toISOString(),
    datasetAsOf: clevelandFedAsOf(selected.group?.chart?._comment),
    value: latest.value,
    points,
  };
}

async function loadClevelandFedCpiNowcast(options = {}) {
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const requiredMonth = clevelandFedMonthKey(options.requiredMonth);
  const releaseAt = Date.parse(options.releaseAt || '');
  const releaseKey = Number.isFinite(releaseAt) ? new Date(releaseAt).toISOString() : 'open';
  const cacheKey = `cleveland-fed:cpi-yoy:${requiredMonth || 'latest'}:${releaseKey}`;
  return cachedLoad(cacheKey, async () => {
    try {
      const client = options.httpClient || axios;
      const requestOptions = {
        timeout: 10000,
        headers: { Accept: 'application/json' },
      };
      let response;
      try {
        response = await client.get(CLEVELAND_FED_NOWCAST_URL, requestOptions);
      } catch (error) {
        const transient = CLEVELAND_FED_TRANSIENT_ERROR.test(
          [error?.code, error?.message].filter(Boolean).join(' '),
        );
        if (!transient) throw error;
        response = await client.get(CLEVELAND_FED_NOWCAST_URL, requestOptions);
      }
      const parsed = normalizeClevelandFedNowcast(response?.data, requiredMonth);
      const observationCutoff = Number.isFinite(releaseAt)
        ? Math.min(now + 24 * 60 * 60 * 1000, releaseAt - 1)
        : now + 24 * 60 * 60 * 1000;
      const points = (parsed.points || []).filter((point) => point.timestamp <= observationCutoff);
      if (parsed.status !== 'available' || points.length === 0) {
        return {
          ...parsed,
          points: [],
          status: 'unavailable',
          reason: parsed.reason || 'The Cleveland Fed CPI nowcast is not current yet.',
        };
      }
      return {
        ...parsed,
        points,
        asOf: new Date(points[points.length - 1].timestamp).toISOString(),
        releaseAt: Number.isFinite(releaseAt) ? new Date(releaseAt).toISOString() : null,
        value: points[points.length - 1].value,
      };
    } catch (error) {
      return {
        status: 'unavailable',
        source: 'cleveland_fed_inflation_nowcasting',
        sourceUrl: CLEVELAND_FED_NOWCAST_URL,
        requiredMonth,
        reason: error?.message || 'The Cleveland Fed CPI nowcast could not be fetched.',
      };
    }
  }, {
    now,
    ttlMs: CLEVELAND_FED_NOWCAST_TTL_MS,
    useCache: options.useCache !== false,
    // A network abort or exact-month miss must remain retryable. Only a
    // verified provider dataset is safe to retain as dated research context.
    shouldCache: (value) => value?.status === 'available',
  });
}

function unavailable(name, reason, details = {}) {
  return { name, status: 'unavailable', reason, ...details };
}

async function getOverviewSignalAvailability(context = {}, options = {}) {
  const dynamodb = options.dynamodb || defaultDynamodb;
  const market = String(context.market || '').toLowerCase();
  try {
    if (market === 'cpi') {
      const requiredMonth = cpiMonthFromEvent(context.event);
      const snapshots = await loadCpiNowcastSnapshots(dynamodb, {
        ...options,
        useCache: options.useCache !== false && !options.dynamodb,
      });
      const forecast = selectCpiForecast(snapshots, {
        now: options.now,
        requiredMonth,
      });
      const snapshot = forecast?.snapshot || snapshots[0] || null;
      const sourceMonth = forecast?.monthId || cpiMonthFromSnapshot(snapshot);
      if (!forecast || !requiredMonth || sourceMonth !== requiredMonth) {
        return unavailable('Hedgeye Inflation Nowcast', 'No source-matched CPI nowcast is available.', {
          requiredMonth,
          sourceMonth,
          asOf: snapshot?.publishedAt || snapshot?.scrapedAt || snapshot?.date || null,
          source: snapshot?.sourceProduct || 'HedgeyeDailySnapshot',
        });
      }
      return {
        name: 'Hedgeye Inflation Nowcast',
        status: 'available',
        requiredMonth,
        sourceMonth,
        asOf: snapshot.publishedAt || snapshot.scrapedAt || snapshot.date || null,
        source: snapshot.sourceProduct || 'HedgeyeDailySnapshot',
        details: cpiSignalDetailsFromForecast(forecast),
      };
    }

    const ticker = market === 'spx' ? 'SPX' : market === 'wti' ? 'WTIC' : null;
    const name = ticker === 'SPX' ? 'SPX Risk Range' : 'WTIC Risk Range';
    const requiredDate = dateKeyInNewYork(
      context.event?.observationTime || context.event?.strikeDate || context.event?.closeTime,
    );
    const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
    let range = await loadExactRiskRange(dynamodb, ticker, requiredDate, {
      ...options,
      useCache: options.useCache !== false && !options.dynamodb,
    });
    let match = 'exact_event_date';
    const expectedPublicationDate = expectedRiskRangePublication(new Date(now), {
      deadlineHour: Number(process.env.RISK_RANGE_DEADLINE_HOUR_ET || 8),
      deadlineMinute: Number(process.env.RISK_RANGE_DEADLINE_MINUTE_ET || 15),
    }).expectedDate;
    const currentOrFutureEvent = !requiredDate || (
      expectedPublicationDate && requiredDate >= expectedPublicationDate
    );
    if (!finiteRange(range) && currentOrFutureEvent) {
      const currentRange = await loadCurrentRiskRange(dynamodb, ticker, now, {
        ...options,
        useCache: options.useCache !== false && !options.dynamodb,
      });
      if (finiteRange(currentRange)) {
        range = currentRange;
        match = 'current_publication';
      }
    }
    if (!finiteRange(range)) {
      return unavailable(name, `No exact-date ${ticker || 'Risk Range'} data is available.`, {
        requiredDate,
        asOf: range?.date || null,
        source: 'RiskRangeData',
      });
    }
    return {
      name,
      status: 'available',
      requiredDate,
      asOf: range.date,
      source: 'RiskRangeData',
      details: {
        ticker,
        date: range.date,
        lrr: Number(range.lrr),
        hrr: Number(range.hrr),
        trend: range.trend || null,
        ...(optionalFiniteNumber(range.prevClose ?? range.previousClose) != null
          ? { previousClose: optionalFiniteNumber(range.prevClose ?? range.previousClose) }
          : {}),
        match,
      },
    };
  } catch (error) {
    const name = market === 'cpi'
      ? 'Hedgeye Inflation Nowcast'
      : market === 'spx' ? 'SPX Risk Range' : 'WTIC Risk Range';
    return unavailable(name, error.message || 'Signal availability could not be verified.');
  }
}

module.exports = {
  cpiMonthFromEvent,
  cpiMonthFromSnapshot,
  cpiSignalDetails,
  dateKeyInNewYork,
  finiteRange,
  getOverviewSignalAvailability,
  getRiskRangeHistoryAvailability,
  loadClevelandFedCpiNowcast,
  loadCpiNowcastSnapshots,
  loadLatestCpiSnapshot,
  normalizeClevelandFedNowcast,
};
