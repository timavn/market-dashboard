import { finite } from './monitorNumbers';
import { normalizeCpiChartValue } from './cpiForecastValues';

const UTC_DAY_MS = 24 * 60 * 60 * 1000;

export const formatCpiReleaseAt = (value) => {
  const timestamp = Date.parse(value || '');
  if (!Number.isFinite(timestamp)) return 'RELEASE TIME UNAVAILABLE';
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/New_York',
    timeZoneName: 'short',
  }).format(new Date(timestamp));
};

export const CPI_RELEASE_SETUP_DEFINITIONS = Object.freeze([
  Object.freeze({ id: 'headline-mom', label: 'Headline MoM' }),
  Object.freeze({ id: 'headline-yoy', label: 'Headline YoY' }),
  Object.freeze({ id: 'core-mom', label: 'Core MoM' }),
  Object.freeze({ id: 'core-yoy', label: 'Core YoY' }),
]);

export const CPI_BENCHMARK_MAX_AGE_MS = 30 * 60_000;

const FORBIDDEN_CPI_BENCHMARK_PROVENANCE = /(?:mock|seed|fixture|fallback|stale|offline|cache(?:d|[_ -]?only)?|synthetic|inferred|derived)/i;

const cpiSourceUrl = (value) => {
  const text = String(value || '').trim();
  return /^https:\/\//i.test(text) ? text : null;
};

export const cpiBenchmarkNumber = (value) => {
  if (!finite(value)) return null;
  const number = Number(value);
  return number >= -20 && number <= 100 ? number : null;
};

const cpiTimestampsMatch = (left, right) => {
  const leftMs = Date.parse(left || '');
  const rightMs = Date.parse(right || '');
  return Number.isFinite(leftMs) && Number.isFinite(rightMs) && leftMs === rightMs;
};

export const normalizeCpiBenchmarkPanelData = (
  payload,
  reportMonth,
  releaseAt,
  nowMs = Date.now(),
) => {
  const exactEnvelope = payload?.period === reportMonth
    && payload?.metric === 'headline-cpi-yoy'
    && payload?.unit === 'percent';
  const fetchedAtMs = Date.parse(payload?.fetchedAt || '');
  const freshEnvelope = exactEnvelope
    && Number.isFinite(fetchedAtMs)
    && fetchedAtMs <= Number(nowMs) + 5_000
    && Number(nowMs) - fetchedAtMs <= CPI_BENCHMARK_MAX_AGE_MS;
  if (!freshEnvelope) return null;

  const sources = (Array.isArray(payload?.sources) ? payload.sources : []).map((source) => {
    const provenance = [source?.source, source?.warning, source?.cacheState]
      .filter(Boolean).join(' ');
    const point = cpiBenchmarkNumber(source?.point);
    const exact = source?.period === reportMonth
      && cpiTimestampsMatch(source?.releaseAt || releaseAt, releaseAt);
    const available = source?.status === 'available'
      && exact
      && point != null
      && !FORBIDDEN_CPI_BENCHMARK_PROVENANCE.test(provenance);
    return {
      id: String(source?.id || '').trim(),
      kind: String(source?.kind || '').trim(),
      status: available ? 'available' : 'pending',
      point: available ? point : null,
      period: reportMonth,
      releaseAt,
      source: available ? source.source || null : null,
      provider: source?.provider || null,
      sourceUrl: cpiSourceUrl(source?.sourceUrl),
      asOf: available ? source?.asOf || payload.fetchedAt : null,
      reason: available ? null : source?.reason || 'This source has not published an exact-month value.',
    };
  });

  const setupPayload = payload?.releaseSetup;
  const setupCheckedAtMs = Date.parse(setupPayload?.checkedAt || '');
  const setupFresh = ['available', 'partial'].includes(setupPayload?.status)
    && setupPayload?.period === reportMonth
    && cpiTimestampsMatch(setupPayload?.releaseAt, releaseAt)
    && Number.isFinite(setupCheckedAtMs)
    && setupCheckedAtMs <= Number(nowMs) + 5_000
    && Number(nowMs) - setupCheckedAtMs <= CPI_BENCHMARK_MAX_AGE_MS
    && !FORBIDDEN_CPI_BENCHMARK_PROVENANCE.test(String(setupPayload?.source || ''));
  const setupById = new Map((setupFresh && Array.isArray(setupPayload?.rows)
    ? setupPayload.rows
    : []).map((row) => [String(row?.id || ''), row]));
  const releaseRows = CPI_RELEASE_SETUP_DEFINITIONS.map((definition) => {
    const row = setupById.get(definition.id) || null;
    const exact = row?.period === reportMonth && cpiTimestampsMatch(row?.releaseAt, releaseAt);
    const provenance = [row?.source, row?.warning, row?.cacheState].filter(Boolean).join(' ');
    const available = row?.status === 'available'
      && exact
      && !FORBIDDEN_CPI_BENCHMARK_PROVENANCE.test(provenance);
    return {
      ...definition,
      status: available ? 'available' : 'pending',
      previous: available ? cpiBenchmarkNumber(row.previous) : null,
      consensus: available ? cpiBenchmarkNumber(row.consensus) : null,
      providerForecast: available ? cpiBenchmarkNumber(row.providerForecast) : null,
      actual: available ? cpiBenchmarkNumber(row.actual) : null,
      source: available ? row.source || null : null,
      provider: row?.provider || setupPayload?.provider || null,
      sourceUrl: cpiSourceUrl(row?.sourceUrl || setupPayload?.sourceUrl),
      checkedAt: available ? row?.checkedAt || setupPayload.checkedAt : null,
      reason: available ? row.reason || null : row?.reason || setupPayload?.reason || 'Release estimate pending.',
    };
  });

  return {
    status: 'available',
    period: reportMonth,
    releaseAt,
    fetchedAt: payload.fetchedAt,
    sources,
    releaseSetup: {
      status: setupFresh ? setupPayload.status : 'pending',
      checkedAt: setupFresh ? setupPayload.checkedAt : null,
      sourceUrl: cpiSourceUrl(setupPayload?.sourceUrl),
      rows: releaseRows,
    },
  };
};

export const formatCpiBoardPercent = (value) => (
  cpiBenchmarkNumber(value) == null ? '—' : `${Number(value).toFixed(2)}%`
);

export const formatCpiReleasePercent = (value) => (
  cpiBenchmarkNumber(value) == null ? '—' : `${Number(value).toFixed(1)}%`
);

export const formatCpiSourceDate = (value) => {
  const timestamp = Date.parse(value || '');
  if (!Number.isFinite(timestamp)) return null;
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(timestamp)).toUpperCase();
};

const cpiUtcDayStart = (value) => {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
};

const cpiUtcDateKey = (value) => {
  const dayStart = cpiUtcDayStart(value);
  return Number.isFinite(dayStart) ? new Date(dayStart).toISOString().slice(0, 10) : null;
};

export const buildCpiCalendarAxis = (reportMonth, points = [], { endAt = null } = {}) => {
  const monthMatch = /^(20\d{2})-(0[1-9]|1[0-2])$/.exec(String(reportMonth || ''));
  const sourceTimestamps = (Array.isArray(points) ? points : [])
    .map((point) => Number(point?.timestamp ?? point))
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  const firstSourceDay = sourceTimestamps.length ? cpiUtcDayStart(sourceTimestamps[0]) : null;
  const lastSourceDay = sourceTimestamps.length ? cpiUtcDayStart(sourceTimestamps.at(-1)) : null;
  const reportStart = monthMatch
    ? Date.UTC(Number(monthMatch[1]), Number(monthMatch[2]) - 1, 1)
    : null;
  const reportEndExclusive = monthMatch
    ? Date.UTC(Number(monthMatch[1]), Number(monthMatch[2]), 1)
    : null;
  const parsedEndAt = Number.isFinite(Number(endAt)) ? Number(endAt) : Date.parse(endAt || '');
  const startMs = reportStart ?? firstSourceDay;
  const fallbackEndDay = [
    Number.isFinite(reportEndExclusive) ? reportEndExclusive - UTC_DAY_MS : null,
    lastSourceDay,
  ].filter(Number.isFinite).reduce((latest, value) => Math.max(latest, value), -Infinity);
  const hasSettlementEnd = Number.isFinite(parsedEndAt) && parsedEndAt >= startMs;
  const endMs = hasSettlementEnd
    ? parsedEndAt
    : Number.isFinite(fallbackEndDay) ? fallbackEndDay + UTC_DAY_MS - 1 : null;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return null;
  }
  const lastCalendarDay = cpiUtcDayStart(endMs);

  const weekendDays = [];
  for (let cursor = startMs; cursor <= lastCalendarDay; cursor += UTC_DAY_MS) {
    const day = new Date(cursor).getUTCDay();
    if (day !== 0 && day !== 6) continue;
    weekendDays.push({
      date: cpiUtcDateKey(cursor),
      startMs: cursor,
      endMs: Math.min(cursor + UTC_DAY_MS, endMs),
    });
  }

  const ticks = [];
  for (let cursor = startMs; cursor <= lastCalendarDay; cursor += 7 * UTC_DAY_MS) {
    ticks.push(Math.min(cursor + (UTC_DAY_MS / 2), endMs));
  }
  const lastTickDay = ticks.length ? cpiUtcDayStart(ticks.at(-1)) : null;
  if (!Number.isFinite(lastTickDay) || lastCalendarDay - lastTickDay >= 2 * UTC_DAY_MS) {
    ticks.push(Math.min(lastCalendarDay + (UTC_DAY_MS / 2), endMs));
  }

  return {
    domain: [startMs, endMs],
    ticks,
    weekendDays,
    dayCount: Math.round((lastCalendarDay - startMs) / UTC_DAY_MS) + 1,
    startDate: cpiUtcDateKey(startMs),
    endDate: cpiUtcDateKey(lastCalendarDay),
    settlementDate: hasSettlementEnd ? cpiUtcDateKey(endMs) : null,
    sourceStartDate: sourceTimestamps.length ? cpiUtcDateKey(sourceTimestamps[0]) : null,
    sourceEndDate: sourceTimestamps.length ? cpiUtcDateKey(sourceTimestamps.at(-1)) : null,
  };
};

export const buildCpiDailyChartRows = ({
  calendarAxis,
  clevelandPoints = [],
  scenarios = [],
  blsActual = null,
  tooltipAnchor = null,
} = {}) => {
  const startMs = Number(calendarAxis?.domain?.[0]);
  const endMs = Number(calendarAxis?.domain?.[1]);
  const startDay = cpiUtcDayStart(startMs);
  const endDay = cpiUtcDayStart(endMs);
  if (!Number.isFinite(startDay) || !Number.isFinite(endDay) || endDay < startDay) return [];

  const normalizedPoints = (Array.isArray(clevelandPoints) ? clevelandPoints : [])
    .map((point) => ({
      timestamp: Number(point?.timestamp),
      cleveland: normalizeCpiChartValue(point?.cleveland ?? point?.value),
    }))
    .filter((point) => Number.isFinite(point.timestamp) && finite(point.cleveland))
    .sort((left, right) => left.timestamp - right.timestamp);
  const scenarioValues = Object.fromEntries((Array.isArray(scenarios) ? scenarios : [])
    .filter((scenario) => ['downside', 'base', 'upside'].includes(scenario?.key) && finite(scenario?.value))
    .map((scenario) => [scenario.key, normalizeCpiChartValue(scenario.value)]));
  let pointIndex = 0;
  let latestCleveland = null;
  const rows = [];

  for (let dayStart = startDay; dayStart <= endDay; dayStart += UTC_DAY_MS) {
    let publishedToday = null;
    const dayEnd = dayStart + UTC_DAY_MS;
    while (pointIndex < normalizedPoints.length && normalizedPoints[pointIndex].timestamp < dayEnd) {
      const point = normalizedPoints[pointIndex];
      latestCleveland = point;
      if (point.timestamp >= dayStart) publishedToday = point;
      pointIndex += 1;
    }
    rows.push({
      timestamp: Math.min(dayStart + (UTC_DAY_MS / 2), endMs),
      date: cpiUtcDateKey(dayStart),
      scenarios: scenarioValues,
      cleveland: publishedToday?.cleveland ?? null,
      clevelandObservationTimestamp: publishedToday?.timestamp ?? null,
      clevelandLatest: latestCleveland?.cleveland ?? null,
      clevelandLatestTimestamp: latestCleveland?.timestamp ?? null,
      blsActual: normalizeCpiChartValue(blsActual),
      tooltipAnchor: finite(tooltipAnchor) ? Number(tooltipAnchor) : null,
    });
  }
  return rows;
};
