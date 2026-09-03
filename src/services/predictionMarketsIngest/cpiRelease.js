const { loadCpiNowcastSnapshots } = require('./signalAvailabilityProvider');
const { selectCpiForecast } = require('./cpiNowcastSelector.cjs');
const { CPI_RELEASES } = require('../../utils/cpiNowcastHistory.cjs');

const CPI_SERIES = 'KXCPIYOY';
const MONTH_CODES = Object.freeze(['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']);
const MONTH_NAMES = Object.freeze([
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]);

function normalizeCpiMonthId(value) {
  const text = String(value?.id || value || '').trim().toUpperCase();
  if (!text) return null;

  const iso = text.match(/^(20\d{2})-(0[1-9]|1[0-2])$/);
  if (iso) return `${iso[1]}-${iso[2]}`;

  const toMonthId = (yearValue, monthValue) => {
    let year = Number(yearValue);
    if (Number.isInteger(year) && year >= 0 && year <= 99) year += 2000;
    const month = MONTH_CODES.indexOf(String(monthValue || '').slice(0, 3).toUpperCase());
    if (!Number.isInteger(year) || year < 2000 || year > 2099 || month < 0) return null;
    return `${year}-${String(month + 1).padStart(2, '0')}`;
  };

  const ticker = text.match(/(?:^|[-_\s])(\d{2}|20\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(?:[-_\s]|$)/);
  if (ticker) return toMonthId(ticker[1], ticker[2]);

  const monthThenYear = text.match(/\b(JAN(?:UARY)?|FEB(?:RUARY)?|MAR(?:CH)?|APR(?:IL)?|MAY|JUN(?:E)?|JUL(?:Y)?|AUG(?:UST)?|SEP(?:TEMBER)?|OCT(?:OBER)?|NOV(?:EMBER)?|DEC(?:EMBER)?)\b\D{0,6}(\d{2}|20\d{2})\b/);
  if (monthThenYear) return toMonthId(monthThenYear[2], monthThenYear[1]);

  const yearThenMonth = text.match(/\b(\d{2}|20\d{2})\b\D{0,6}(JAN(?:UARY)?|FEB(?:RUARY)?|MAR(?:CH)?|APR(?:IL)?|MAY|JUN(?:E)?|JUL(?:Y)?|AUG(?:UST)?|SEP(?:TEMBER)?|OCT(?:OBER)?|NOV(?:EMBER)?|DEC(?:EMBER)?)\b/);
  return yearThenMonth ? toMonthId(yearThenMonth[1], yearThenMonth[2]) : null;
}

function monthIdentity(monthId) {
  const normalized = normalizeCpiMonthId(monthId);
  if (!normalized) return null;
  const [yearText, monthText] = normalized.split('-');
  const year = Number(yearText);
  const monthIndex = Number(monthText) - 1;
  const monthCode = MONTH_CODES[monthIndex];
  const monthName = MONTH_NAMES[monthIndex];
  if (!monthCode || !monthName) return null;
  return {
    id: normalized,
    year,
    month: monthIndex,
    monthCode,
    forecastMonth: `${monthName} ${year}`,
    releaseCode: `${monthCode[0]}${monthCode.slice(1).toLowerCase()} ${String(year).slice(-2)}`,
    eventTicker: `${CPI_SERIES}-${String(year).slice(-2)}${monthCode}`,
  };
}

function toPercent(value) {
  if (value == null || value === '') return null;
  const numeric = Number(String(value).replace(/[$,%\s,]/g, ''));
  if (!Number.isFinite(numeric)) return null;
  return Math.abs(numeric) > 0 && Math.abs(numeric) <= 0.05 ? numeric * 100 : numeric;
}

function snapshotData(snapshot = {}) {
  return snapshot?.data || snapshot || {};
}

function extractScenarios(snapshot = {}) {
  const data = snapshotData(snapshot);
  const raw = Array.isArray(data.scenarios)
    ? data.scenarios
    : data.scenarios && typeof data.scenarios === 'object'
      ? [
          { key: 'upside', label: 'Upside', value: data.scenarios.upper ?? data.scenarios.upside ?? data.scenarios.high },
          { key: 'base', label: 'Base Case', value: data.scenarios.base ?? data.scenarios.baseCase ?? data.scenarios.central },
          { key: 'downside', label: 'Downside', value: data.scenarios.lower ?? data.scenarios.downside ?? data.scenarios.low },
        ]
      : [
          { key: 'upside', label: 'Upside', value: data.upside ?? data.upsideMom ?? data.upsideM_m },
          { key: 'base', label: 'Base Case', value: data.base ?? data.baseCase ?? data.baseMom ?? data.baseM_m },
          { key: 'downside', label: 'Downside', value: data.downside ?? data.downsideMom ?? data.downsideM_m },
        ];
  return raw.slice(0, 3).map((scenario, index) => ({
    key: scenario?.key || ['upside', 'base', 'downside'][index],
    label: scenario?.label || scenario?.name || ['Upside', 'Base Case', 'Downside'][index],
    value: toPercent(scenario?.percent ?? scenario?.m_m ?? scenario?.mom ?? scenario?.forecast ?? scenario?.raw ?? scenario?.value),
  })).filter((scenario) => Number.isFinite(scenario.value));
}

function deriveTargetStrikes(scenarios = [], { increment = 0.1, padding = 2 } = {}) {
  const scale = Math.round(1 / increment);
  const ticks = scenarios
    .map((scenario) => toPercent(scenario?.value ?? scenario))
    .filter(Number.isFinite)
    .map((value) => Math.round(value * scale));
  if (!ticks.length) return [];
  const first = Math.min(...ticks) - Math.max(0, Math.floor(padding));
  const last = Math.max(...ticks) + Math.max(0, Math.floor(padding));
  const strikes = [];
  for (let tick = first; tick <= last; tick += 1) {
    strikes.push(Number((tick / scale).toFixed(4)));
  }
  return strikes;
}

function normalizeReleaseAt(monthId, value) {
  const supplied = String(value || '').trim();
  if (supplied) {
    const parsed = Date.parse(supplied);
    if (Number.isFinite(parsed)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(supplied)) {
        return CPI_RELEASES[monthId] || `${supplied}T12:30:00.000Z`;
      }
      return new Date(parsed).toISOString();
    }
  }
  return CPI_RELEASES[monthId] || null;
}

function candidateSnapshot(candidate, fallbackSnapshot) {
  if (!candidate) return fallbackSnapshot;
  const source = candidate.snapshot || fallbackSnapshot || {};
  const sourceData = snapshotData(source);
  const scenarioValues = candidate.scenarios || {};
  return {
    ...source,
    publishedAt: candidate.publishedAt || source.publishedAt,
    data: {
      ...sourceData,
      metric: candidate.metric || sourceData.metric || 'Headline CPI YoY',
      forecastMonth: candidate.forecastMonth || sourceData.forecastMonth,
      reportMonth: candidate.monthId || sourceData.reportMonth,
      releaseAt: candidate.releaseAt || sourceData.releaseAt,
      releaseDate: candidate.releaseAt
        ? String(candidate.releaseAt).slice(0, 10)
        : sourceData.releaseDate,
      scenarios: [
        { key: 'upside', label: 'Upside', value: scenarioValues.upper },
        { key: 'base', label: 'Base Case', value: scenarioValues.base },
        { key: 'downside', label: 'Downside', value: scenarioValues.lower },
      ],
    },
  };
}

function buildCurrentCpiRelease(snapshot, options = {}) {
  if (!snapshot) {
    const error = new Error('No inflation nowcast snapshot is available for the current CPI release.');
    error.code = 'CPI_RELEASE_UNAVAILABLE';
    throw error;
  }
  const selectedForecast = options.forecast || null;
  const sourceSnapshot = candidateSnapshot(selectedForecast, snapshot);
  const data = snapshotData(sourceSnapshot);
  const metric = String(data.metric || data.measure || data.title || data.heading || '');
  if (!/\bYOY\b|\bY\/Y\b|YEAR[\s-]*OVER[\s-]*YEAR/i.test(metric)) {
    const error = new Error('The latest inflation nowcast is not a Headline CPI YoY release.');
    error.code = 'CPI_RELEASE_METRIC_MISMATCH';
    throw error;
  }
  const identity = monthIdentity(
    selectedForecast?.monthId
      || data.forecastMonth
      || data.reportMonth
      || data.month
      || data.period
      || sourceSnapshot.forecastMonth,
  );
  if (!identity) {
    const error = new Error('The latest inflation nowcast does not identify its CPI report month.');
    error.code = 'CPI_RELEASE_MONTH_MISSING';
    throw error;
  }
  const scenarios = extractScenarios(sourceSnapshot);
  if (scenarios.length !== 3) {
    const error = new Error('The current CPI release requires Upside, Base Case, and Downside scenarios.');
    error.code = 'CPI_RELEASE_SCENARIOS_MISSING';
    throw error;
  }
  const releaseDateValue = data.releaseDate?.date
    || data.releaseDate
    || data.release_date
    || sourceSnapshot.releaseDate
    || null;
  const releaseAt = normalizeReleaseAt(
    identity.id,
    selectedForecast?.releaseAt
      || data.releaseAt
      || sourceSnapshot.releaseAt
      || releaseDateValue,
  );
  const releaseDate = releaseDateValue && /^\d{4}-\d{2}-\d{2}$/.test(String(releaseDateValue))
    ? String(releaseDateValue)
    : releaseAt?.slice(0, 10) || null;
  if (!releaseDate || !releaseAt || Number.isNaN(Date.parse(releaseAt))) {
    const error = new Error('The current CPI release does not have a valid release date.');
    error.code = 'CPI_RELEASE_DATE_MISSING';
    throw error;
  }
  const releaseDeadline = Date.parse(releaseAt);
  const now = options.now instanceof Date
    ? options.now.getTime()
    : Number(options.now ?? Date.now());
  const enforceFresh = options.enforceFresh !== false;
  if (enforceFresh && Number.isFinite(now) && releaseDeadline <= now) {
    const error = new Error(`The latest inflation nowcast release expired on ${releaseDate}.`);
    error.code = 'CPI_RELEASE_EXPIRED';
    throw error;
  }
  const targetStrikes = deriveTargetStrikes(scenarios);
  const releaseKey = `${CPI_SERIES}#${identity.id}`;
  const cpi = {
    series: CPI_SERIES,
    releaseKey,
    metric: 'Headline CPI YoY',
    forecastMonth: identity.forecastMonth,
    reportMonth: identity.forecastMonth,
    reportMonthId: identity.id,
    releaseCode: identity.releaseCode,
    releaseDate,
    eventTicker: identity.eventTicker,
    releaseAt,
    targetStrikes,
  };
  return {
    ok: true,
    series: CPI_SERIES,
    releaseKey,
    reportMonth: identity.id,
    forecastMonth: identity.forecastMonth,
    releaseDate,
    releaseAt,
    eventTicker: identity.eventTicker,
    targetStrikes,
    scenarios,
    source: {
      type: 'hedgeye-inflation-nowcast',
      asOf: sourceSnapshot.publishedAt || sourceSnapshot.scrapedAt || data.publishedAt || sourceSnapshot.date || null,
      snapshotDate: sourceSnapshot.date || null,
      reportMonth: identity.id,
    },
    cpi,
    request: { cpi },
  };
}

async function getCurrentCpiRelease(options = {}) {
  const loader = options.loadSnapshots || options.loadSnapshot || (async () => loadCpiNowcastSnapshots(
    options.dynamodb,
    { now: options.now, useCache: options.useCache },
  ));
  const now = options.now instanceof Date ? options.now.getTime() : Number(options.now ?? Date.now());
  const loaded = await loader();
  const snapshots = Array.isArray(loaded) ? loaded : [loaded];
  const forecast = selectCpiForecast(snapshots, { now, current: true });
  if (!forecast) {
    const error = new Error('No future Headline CPI YoY nowcast is available after the latest official release.');
    error.code = 'CPI_RELEASE_NO_FUTURE_FORECAST';
    throw error;
  }
  return buildCurrentCpiRelease(forecast.snapshot || snapshots[0], {
    now,
    enforceFresh: true,
    forecast,
  });
}

function releaseKeyForEvent(event = {}) {
  if (event.releaseKey || event.release_key) return event.releaseKey || event.release_key;
  const values = [
    event.reportMonthId,
    event.reportMonth,
    event.report_month,
    event.forecastMonth,
    event.forecast_month,
    event.releaseCode,
    event.release_code,
    event.event_ticker,
    event.eventTicker,
    event.api_raw_symbol,
    event.localSymbol,
    event.contract_title,
    event.question,
  ];
  const monthId = values.map(normalizeCpiMonthId).find(Boolean);
  return monthId ? `${CPI_SERIES}#${monthId}` : null;
}

module.exports = {
  CPI_SERIES,
  buildCurrentCpiRelease,
  deriveTargetStrikes,
  extractScenarios,
  getCurrentCpiRelease,
  monthIdentity,
  normalizeCpiMonthId,
  releaseKeyForEvent,
};
