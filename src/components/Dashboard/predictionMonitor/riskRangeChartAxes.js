import { finite } from './monitorNumbers';

const INTRADAY_TIME_STEPS_MS = Object.freeze([
  30 * 60_000,
  60 * 60_000,
  2 * 60 * 60_000,
  3 * 60 * 60_000,
  4 * 60 * 60_000,
  6 * 60 * 60_000,
  12 * 60 * 60_000,
]);

const buildIntradayTimeAxis = (timestamps, targetTickCount = 8, options = {}) => {
  const numeric = [...new Set((timestamps || []).map(Number).filter(Number.isFinite))]
    .sort((left, right) => left - right);
  if (!numeric.length) return { domain: [0, 1], ticks: [], step: null };
  const requestedDomain = Array.isArray(options?.domain)
    ? options.domain.map(Number)
    : [];
  const hasSessionDomain = requestedDomain.length === 2
    && requestedDomain.every(Number.isFinite)
    && requestedDomain[0] < requestedDomain[1]
    && requestedDomain[0] <= numeric[0]
    && requestedDomain[1] >= numeric[numeric.length - 1];
  const domain = hasSessionDomain
    ? requestedDomain
    : [numeric[0], numeric[numeric.length - 1]];
  if (domain[0] === domain[1]) {
    return { domain, ticks: domain, step: null, hasSessionEndpoints: false };
  }
  const span = domain[1] - domain[0];
  const rawStep = span / Math.max(1, Number(targetTickCount) - 1);
  const step = INTRADAY_TIME_STEPS_MS.find((candidate) => candidate >= rawStep)
    || Math.ceil(rawStep / INTRADAY_TIME_STEPS_MS[INTRADAY_TIME_STEPS_MS.length - 1])
      * INTRADAY_TIME_STEPS_MS[INTRADAY_TIME_STEPS_MS.length - 1];
  const firstTick = Math.ceil(domain[0] / step) * step;
  let ticks = [];
  for (let tick = firstTick; tick <= domain[1]; tick += step) ticks.push(tick);
  if (hasSessionDomain && options?.includeEndpoints) {
    ticks = [
      domain[0],
      ...ticks.filter((tick) => tick > domain[0] && tick < domain[1]),
      domain[1],
    ];
  }
  const minimumTickGap = Math.max(0, Number(options?.minimumTickGapMs) || 0);
  if (minimumTickGap > 0 && ticks.length > 2) {
    const finalTick = ticks[ticks.length - 1];
    ticks = ticks.reduce((spaced, tick, index) => {
      if (index === 0 || index === ticks.length - 1
        || (tick - spaced[spaced.length - 1] >= minimumTickGap && finalTick - tick >= minimumTickGap)) {
        spaced.push(tick);
      }
      return spaced;
    }, []);
  }
  return {
    domain,
    ticks: ticks.length >= 2 ? ticks : domain,
    step,
    hasSessionEndpoints: hasSessionDomain && Boolean(options?.includeEndpoints),
  };
};

const formatIntradayTimeTick = (timestamp, step, options = {}) => {
  const date = new Date(Number(timestamp));
  if (!Number.isFinite(date.getTime())) return '—';
  const includeMinutes = Number(step) < 60 * 60_000 || date.getMinutes() !== 0;
  const time = date.toLocaleTimeString('en-US', {
    hour: options.clock24 ? '2-digit' : 'numeric',
    ...(includeMinutes || options.clock24 ? { minute: '2-digit' } : {}),
    ...(options.clock24 ? { hourCycle: 'h23' } : {}),
    ...(options.timeZone ? { timeZone: options.timeZone } : {}),
  });
  return options.includeDate
    ? `${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(options.timeZone ? { timeZone: options.timeZone } : {}) })} ${time}`
    : time;
};

const nicePriceStep = (rawStep) => {
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(rawStep, 1)));
  const normalized = rawStep / magnitude;
  const factor = normalized <= 1 ? 1
    : normalized <= 2 ? 2
      : normalized <= 2.5 ? 2.5
        : normalized <= 5 ? 5 : 10;
  return factor * magnitude;
};

const buildSpxPriceAxis = (values, targetIntervals = 6) => {
  const numeric = (values || []).map(Number).filter(Number.isFinite);
  if (!numeric.length) return { domain: [0, 1], ticks: [0, 1], step: 1 };
  const minimum = Math.min(...numeric);
  const maximum = Math.max(...numeric);
  const span = Math.max(maximum - minimum, 1);
  const padding = Math.max(span * 0.08, 8);
  const step = nicePriceStep((span + (padding * 2)) / Math.max(targetIntervals, 1));
  const domainMinimum = Math.floor((minimum - padding) / step) * step;
  const domainMaximum = Math.ceil((maximum + padding) / step) * step;
  const tickCount = Math.round((domainMaximum - domainMinimum) / step);
  const ticks = Array.from({ length: tickCount + 1 }, (_, index) => (
    Number((domainMinimum + (index * step)).toFixed(6))
  ));
  return { domain: [domainMinimum, domainMaximum], ticks, step };
};

const expandSpxPriceAxis = (axis, padding = 100) => {
  const minimum = Number(axis?.domain?.[0]);
  const maximum = Number(axis?.domain?.[1]);
  const step = Number(axis?.step);
  const extra = Math.max(0, Number(padding) || 0);
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || maximum <= minimum || !(step > 0)) return axis;
  const domain = [minimum - extra, maximum + extra];
  const firstTick = Math.ceil(domain[0] / step) * step;
  const tickCount = Math.floor((domain[1] - firstTick) / step);
  const ticks = Array.from({ length: tickCount + 1 }, (_, index) => (
    Number((firstTick + (index * step)).toFixed(6))
  ));
  return { ...axis, domain, ticks };
};

const resolveVerifiedVixCloses = (section, rangeDates = []) => {
  const provenance = [
    section?.source,
    section?.provenance,
    section?.cacheStatus,
    section?.cacheState,
    section?.sourceStatus,
    section?.warning,
    section?.error,
    section?.fromCache ? 'cached' : '',
    section?.cachedOnly ? 'cached-only' : '',
    section?.cacheOnly ? 'cache-only' : '',
    section?.mock ? 'mock' : '',
    section?.seeded ? 'seeded' : '',
    section?.fallback ? 'fallback' : '',
  ].filter(Boolean).join(' ');
  const trusted = ['available', 'partial'].includes(section?.status)
    && section?.availability === 'historical'
    && section?.source === 'ibkr_historical_daily_close'
    && section?.refreshFailed !== true
    && !/(?:mock|seed|fixture|fallback|cache|portfolio|delayed|frozen|stale|offline|disconnected|synthetic|inferred|derived)/i.test(provenance);
  if (!trusted) return new Map();

  const dates = new Set(rangeDates);
  const grouped = new Map();
  (Array.isArray(section?.values) ? section.values : []).forEach((row) => {
    const date = String(row?.date || '');
    const value = Number(row?.value);
    if (!dates.has(date) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !(value > 0)) return;
    grouped.set(date, [...(grouped.get(date) || []), value]);
  });
  return new Map([...grouped.entries()].flatMap(([date, values]) => (
    values.length === 1 ? [[date, values[0]]] : []
  )));
};

const resolveAthReferenceValue = (ath) => {
  if (ath?.status !== 'available') return null;
  const candidates = [
    ath.value,
    ath.baseline?.value,
    ...(Array.isArray(ath.markers) ? ath.markers.map((marker) => marker?.value) : []),
  ].map(Number).filter((value) => Number.isFinite(value) && value > 0);
  return candidates.length ? Math.max(...candidates) : null;
};

const resolveAthReferenceDate = (ath, value = resolveAthReferenceValue(ath)) => {
  if (ath?.status !== 'available' || !finite(value)) return null;
  const matchingMarkers = (Array.isArray(ath.markers) ? ath.markers : [])
    .filter((marker) => Number(marker?.value) === Number(value))
    .reverse();
  const datedCandidate = [
    ...(Number(ath.value) === Number(value) ? [ath] : []),
    ...matchingMarkers,
    ...(Number(ath.baseline?.value) === Number(value) ? [ath.baseline] : []),
  ].find((candidate) => /^\d{4}-\d{2}-\d{2}$/.test(String(candidate?.date || '')));
  return datedCandidate?.date || null;
};

const clampChartReferenceValue = (value, domain) => {
  if (!finite(value) || !finite(domain?.[0]) || !finite(domain?.[1])) {
    return { value: null, edge: null };
  }
  const numericValue = Number(value);
  const minimum = Number(domain?.[0]);
  const maximum = Number(domain?.[1]);
  if (minimum > maximum) {
    return { value: null, edge: null };
  }
  if (numericValue > maximum) return { value: maximum, edge: 'top' };
  if (numericValue < minimum) return { value: minimum, edge: 'bottom' };
  return { value: numericValue, edge: null };
};

export { buildIntradayTimeAxis, buildSpxPriceAxis, clampChartReferenceValue, expandSpxPriceAxis, formatIntradayTimeTick, resolveAthReferenceDate, resolveAthReferenceValue, resolveVerifiedVixCloses };
