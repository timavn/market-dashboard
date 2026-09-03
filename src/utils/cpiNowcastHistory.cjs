const CPI_RELEASES = Object.freeze({
  '2025-07': '2025-08-12T12:30:00.000Z',
  '2025-08': '2025-09-11T12:30:00.000Z',
  '2025-09': '2025-10-24T12:30:00.000Z',
  '2025-10': '2025-11-13T13:30:00.000Z',
  '2025-11': '2025-12-18T13:30:00.000Z',
  '2025-12': '2026-01-13T13:30:00.000Z',
  '2026-01': '2026-02-13T13:30:00.000Z',
  '2026-02': '2026-03-11T12:30:00.000Z',
  '2026-03': '2026-04-10T12:30:00.000Z',
  '2026-04': '2026-05-12T12:30:00.000Z',
  '2026-05': '2026-06-10T12:30:00.000Z',
  '2026-06': '2026-07-14T12:30:00.000Z',
  '2026-07': '2026-08-12T12:30:00.000Z',
  '2026-08': '2026-09-11T12:30:00.000Z',
});

const MONTH_NAMES = Object.freeze([
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]);

function toNumber(value) {
  if (value == null || value === '') return null;
  const numeric = Number(String(value).replace(/[$,%\s,]/g, ''));
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeCpiMonthId(value) {
  const text = String(value?.id || value || '').trim().toUpperCase();
  if (!text) return null;
  const iso = text.match(/^(20\d{2})-(0[1-9]|1[0-2])$/);
  if (iso) return `${iso[1]}-${iso[2]}`;

  const monthPattern = MONTH_NAMES.map((name) => `${name}|${name.slice(0, 3)}`).join('|');
  const monthFirst = text.match(new RegExp(`\\b(${monthPattern})\\b\\D{0,6}(\\d{2}|20\\d{2})\\b`, 'i'));
  const yearFirst = text.match(new RegExp(`\\b(\\d{2}|20\\d{2})\\b\\D{0,6}(${monthPattern})\\b`, 'i'));
  const match = monthFirst || yearFirst;
  if (!match) return null;
  let year = Number(monthFirst ? match[2] : match[1]);
  if (year >= 0 && year <= 99) year += 2000;
  const monthToken = String(monthFirst ? match[1] : match[2]).slice(0, 3).toUpperCase();
  const monthIndex = MONTH_NAMES.findIndex((name) => name.slice(0, 3).toUpperCase() === monthToken);
  if (year < 2000 || year > 2099 || monthIndex < 0) return null;
  return `${year}-${String(monthIndex + 1).padStart(2, '0')}`;
}

function cpiMonthLabel(monthId) {
  const normalized = normalizeCpiMonthId(monthId);
  if (!normalized) return null;
  const [year, month] = normalized.split('-').map(Number);
  return `${MONTH_NAMES[month - 1]} ${year}`;
}

function roundCpiForDisplay(value) {
  const numeric = toNumber(value);
  if (numeric == null) return null;
  return Math.round((numeric + Number.EPSILON) * 10) / 10;
}

function normalizeScenarioValues(value = {}) {
  const raw = Array.isArray(value)
    ? value.reduce((result, scenario, index) => {
        const token = String(scenario?.key || scenario?.label || scenario?.name || '').toLowerCase();
        const key = /up|upper|bull|high/.test(token)
          ? 'upper'
          : /down|lower|bear|low/.test(token)
            ? 'lower'
            : /base|central/.test(token)
              ? 'base'
              : ['upper', 'base', 'lower'][index];
        if (key) result[key] = scenario?.raw ?? scenario?.value ?? scenario?.percent ?? scenario?.forecast;
        return result;
      }, {})
    : value;
  const scenarios = {
    upper: toNumber(raw.upper ?? raw.upside ?? raw.high),
    base: toNumber(raw.base ?? raw.baseCase ?? raw.central),
    lower: toNumber(raw.lower ?? raw.downside ?? raw.low),
  };
  return [scenarios.upper, scenarios.base, scenarios.lower].every(Number.isFinite)
    && scenarios.lower < scenarios.base
    && scenarios.base < scenarios.upper
    ? scenarios
    : null;
}

function normalizeIso(value) {
  if (!value) return null;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
}

function normalizeReleaseAt(monthId, value) {
  const text = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return CPI_RELEASES[monthId] || `${text}T12:30:00.000Z`;
  }
  const supplied = normalizeIso(value);
  return supplied || CPI_RELEASES[monthId] || null;
}

function normalizeSource(source = {}, snapshot = {}) {
  const normalized = typeof source === 'string' ? { kind: source } : { ...(source || {}) };
  return {
    kind: normalized.kind || snapshot.sourceKind || snapshot.source || 'gmail',
    ...(normalized.messageId || snapshot.gmailMessageId
      ? { messageId: normalized.messageId || snapshot.gmailMessageId }
      : {}),
    ...(normalized.product || snapshot.sourceProduct
      ? { product: normalized.product || snapshot.sourceProduct }
      : {}),
    ...(normalized.chartUrl ? { chartUrl: normalized.chartUrl } : {}),
    ...(normalized.chartSha256 ? { chartSha256: normalized.chartSha256 } : {}),
    ...(normalized.artifact ? { artifact: normalized.artifact } : {}),
    priority: Number(normalized.priority ?? snapshot.sourcePriority ?? 0) || 0,
  };
}

function normalizeForecastCandidate(forecast = {}, snapshot = {}) {
  const data = snapshot.data || {};
  const monthId = normalizeCpiMonthId(
    forecast.reportMonth
      || forecast.reportMonthId
      || forecast.forecastMonth
      || forecast.month
      || data.reportMonth
      || data.forecastMonth,
  );
  if (!monthId) return null;
  const scenarios = normalizeScenarioValues(
    forecast.scenarios
      || {
        upper: forecast.upper ?? forecast.upside,
        base: forecast.base ?? forecast.baseCase,
        lower: forecast.lower ?? forecast.downside,
      }
      || data.scenarios,
  ) || normalizeScenarioValues(data.scenarios || data);
  if (!scenarios) return null;
  const releaseAt = normalizeReleaseAt(
    monthId,
    forecast.releaseAt || forecast.releaseDate || data.releaseAt || data.releaseDate || snapshot.releaseAt || snapshot.releaseDate,
  );
  if (!releaseAt) return null;
  const source = normalizeSource(forecast.source, snapshot);
  return {
    monthId,
    forecastMonth: forecast.forecastMonth || cpiMonthLabel(monthId),
    metric: forecast.metric || data.metric || 'Headline CPI YoY',
    releaseAt,
    publishedAt: normalizeIso(forecast.publishedAt || snapshot.publishedAt || data.publishedAt),
    scrapedAt: normalizeIso(forecast.scrapedAt || snapshot.scrapedAt),
    scenarios,
    source,
    selectionBasis: forecast.selectionBasis || null,
    selected: forecast.selected === true,
  };
}

function flattenSnapshotForecasts(snapshot = {}) {
  const data = snapshot?.data || {};
  const forecasts = Array.isArray(data.forecasts) ? data.forecasts : [];
  const normalized = forecasts
    .map((forecast) => normalizeForecastCandidate(forecast, snapshot))
    .filter(Boolean);
  if (!forecasts.length) {
    const legacy = normalizeForecastCandidate(data, snapshot);
    if (legacy) normalized.push(legacy);
  }
  return normalized;
}

function equivalentDeliveryKey(candidate) {
  const values = candidate.scenarios;
  const chartIdentity = candidate.source.chartSha256 || candidate.source.chartUrl || '';
  const publicationMinute = candidate.publishedAt ? candidate.publishedAt.slice(0, 16) : 'manual';
  return [
    candidate.monthId,
    candidate.releaseAt,
    values.upper,
    values.base,
    values.lower,
    chartIdentity || publicationMinute,
  ].join('|');
}

function preferCandidate(left, right) {
  const leftPriority = Number(left?.source?.priority || 0);
  const rightPriority = Number(right?.source?.priority || 0);
  if (leftPriority !== rightPriority) return rightPriority > leftPriority ? right : left;
  const leftTime = Date.parse(left?.publishedAt || left?.scrapedAt || 0) || 0;
  const rightTime = Date.parse(right?.publishedAt || right?.scrapedAt || 0) || 0;
  return rightTime >= leftTime ? right : left;
}

function dedupeEquivalentDeliveries(candidates = []) {
  const deduped = new Map();
  candidates.forEach((candidate) => {
    const key = equivalentDeliveryKey(candidate);
    deduped.set(key, preferCandidate(deduped.get(key), candidate));
  });
  return [...deduped.values()];
}

function isUserConfirmedSelection(candidate) {
  return candidate.selected === true
    || /^user[_-]confirmed/i.test(String(candidate.selectionBasis || ''))
    || /^user[_-]confirmed/i.test(String(candidate.source?.kind || ''));
}

function publicSource(source = {}) {
  const { priority, ...rest } = source;
  return rest;
}

function buildScenarioResponse(scenarios) {
  return Object.fromEntries(['upper', 'base', 'lower'].map((key) => [key, {
    raw: scenarios[key],
    rounded: roundCpiForDisplay(scenarios[key]),
  }]));
}

function resolveCpiMonth(candidates, monthId, now = new Date()) {
  const monthCandidates = dedupeEquivalentDeliveries(
    candidates.filter((candidate) => candidate.monthId === monthId),
  );
  const releaseAt = monthCandidates[0]?.releaseAt || CPI_RELEASES[monthId] || null;
  const releaseMillis = Date.parse(releaseAt || '');
  const nowMillis = now instanceof Date ? now.getTime() : Number(now);
  if (!releaseAt || !Number.isFinite(releaseMillis) || !Number.isFinite(nowMillis)) {
    return { monthId, releaseAt, status: 'unavailable', publishedAt: null, source: null, scenarios: null };
  }

  const manual = monthCandidates.filter(isUserConfirmedSelection).reduce(preferCandidate, null);
  const eligible = monthCandidates.filter((candidate) => {
    const publishedMillis = Date.parse(candidate.publishedAt || '');
    return Number.isFinite(publishedMillis)
      && publishedMillis < releaseMillis
      && publishedMillis <= nowMillis;
  });
  const selected = manual || eligible.reduce((latest, candidate) => {
    if (!latest) return candidate;
    const candidateMillis = Date.parse(candidate.publishedAt);
    const latestMillis = Date.parse(latest.publishedAt);
    if (candidateMillis !== latestMillis) return candidateMillis > latestMillis ? candidate : latest;
    return preferCandidate(latest, candidate);
  }, null);
  if (!selected) {
    return { monthId, releaseAt, status: 'unavailable', publishedAt: null, source: null, scenarios: null };
  }
  return {
    monthId,
    forecastMonth: selected.forecastMonth || cpiMonthLabel(monthId),
    releaseAt,
    status: nowMillis < releaseMillis ? 'provisional' : 'final-pre-release',
    publishedAt: selected.publishedAt,
    source: publicSource(selected.source),
    selectionBasis: selected.selectionBasis || (manual ? 'user_confirmed_closest_pre_release' : 'latest_pre_release'),
    scenarios: buildScenarioResponse(selected.scenarios),
  };
}

function monthIndex(monthId) {
  const normalized = normalizeCpiMonthId(monthId);
  if (!normalized) return null;
  const [year, month] = normalized.split('-').map(Number);
  return year * 12 + month - 1;
}

function monthIdFromIndex(index) {
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return `${year}-${String(month).padStart(2, '0')}`;
}

function listMonthIds(from, to) {
  const first = monthIndex(from);
  const last = monthIndex(to);
  if (first == null || last == null || last < first || last - first > 35) return null;
  return Array.from({ length: last - first + 1 }, (_, offset) => monthIdFromIndex(first + offset));
}

function buildCpiNowcastHistory(snapshots = [], options = {}) {
  const candidates = snapshots.flatMap(flattenSnapshotForecasts);
  const candidateMonthIds = candidates.map((candidate) => candidate.monthId).sort();
  const from = normalizeCpiMonthId(options.from) || candidateMonthIds[0] || Object.keys(CPI_RELEASES)[0];
  const to = normalizeCpiMonthId(options.to) || candidateMonthIds.at(-1) || Object.keys(CPI_RELEASES).at(-1);
  const monthIds = listMonthIds(from, to);
  if (!monthIds) {
    const error = new Error('CPI nowcast history range must be an ordered span of at most 36 months.');
    error.code = 'CPI_HISTORY_RANGE_INVALID';
    throw error;
  }
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  return {
    metric: 'Headline CPI YoY',
    from,
    to,
    generatedAt: now.toISOString(),
    entries: monthIds.map((monthId) => resolveCpiMonth(candidates, monthId, now)),
  };
}

module.exports = {
  CPI_RELEASES,
  buildCpiNowcastHistory,
  cpiMonthLabel,
  dedupeEquivalentDeliveries,
  flattenSnapshotForecasts,
  listMonthIds,
  normalizeCpiMonthId,
  normalizeScenarioValues,
  resolveCpiMonth,
  roundCpiForDisplay,
};
