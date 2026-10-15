'use strict';

// Daily-strip readings are informational observations. Retention preserves a
// completed calculation and its denominator; it never recomputes from a mix
// of old and new constituent prices.
const GROUPS = Object.freeze({
  breadth: ['breadth.advancing', 'breadth.declining', 'breadth.unchanged', 'breadth.medianReturn', 'breadth.upOnePercent', 'breadth.downOnePercent', 'breadth.lowerQuartileReturn', 'breadth.upperQuartileReturn'],
  above50: ['breadth.above50Pct'],
  above200: ['breadth.above200Pct'],
  highLow: ['breadth.newHighs', 'breadth.newLows'],
  movers: ['winners', 'losers', 'moverDetails.winners', 'moverDetails.losers'],
  sectors: ['leadership.leadingSector', 'leadership.laggingSector', 'leadershipDetails.leadingSectors', 'leadershipDetails.laggingSectors', 'leadershipDetails.sectorParticipation'],
  contributions: ['leadership.lift', 'leadership.drag', 'leadershipDetails.lifts', 'leadershipDetails.drags'],
  relativeVolume: ['outliers.relativeVolume', 'outlierDetails.relativeVolume'],
  unusualGain: ['outliers.unusualGain', 'outlierDetails.unusualGain'],
  reversal: ['outliers.reversal', 'outlierDetails.reversal'],
  againstSector: ['outliers.againstSector', 'outlierDetails.againstSector'],
});
const read = (value, path) => path.split('.').reduce((item, key) => item?.[key], value);
const clone = value => JSON.parse(JSON.stringify(value));
const finite = value => typeof value === 'number' && Number.isFinite(value);
const groupRows = (value, group) => GROUPS[group].flatMap(path => {
  const item = read(value, path);
  return (Array.isArray(item) ? item : [item]).filter(row => row && typeof row === 'object' && row.ticker);
});
const METRIC_ROOTS = new Set(['breadth', 'winners', 'losers', 'leadership', 'outliers', 'moverDetails', 'leadershipDetails', 'outlierDetails', 'referenceObservations']);

function validRow(row, now) {
  return row && !rejected(row) && /^[A-Z][A-Z0-9.-]{0,9}$/.test(row.ticker || '') && typeof row.name === 'string' && finite(row.changePercent)
    && Number.isFinite(Date.parse(row.asOf)) && Date.parse(row.asOf) <= now + 5_000
    && row.source && /^https:\/\//.test(row.sourceUrl || '') && ['live', 'delayed', 'last-close'].includes(row.status)
    && /^\d{4}-\d{2}-\d{2}$/.test(row.marketDate || '')
    && (row.expiresAt === undefined || (Number.isFinite(Date.parse(row.expiresAt)) && Date.parse(row.expiresAt) > Date.parse(row.asOf)));
}

function sanitize(value, now) {
  if (!value || typeof value !== 'object'
    || rejected(Object.fromEntries(Object.entries(value).filter(([key]) => !METRIC_ROOTS.has(key))))) return null;
  const result = clone(value);
  const incomplete = new Set(Array.isArray(value.incompleteReferenceGroups) ? value.incompleteReferenceGroups : []);
  for (const [group, paths] of Object.entries(GROUPS)) {
    for (const field of paths) {
      const item = read(result, field);
      if (Array.isArray(item)) {
        put(result, field, item.map(row => {
          if (validRow(row, now)) return row;
          incomplete.add(group);
          return null; // Keep rank positions; never promote another security.
        }));
      } else if (item && typeof item === 'object' && (item.ticker || rejected(item))) {
        if (!validRow(item, now)) { put(result, field, null); incomplete.add(group); }
      }
    }
  }
  // Contaminated aggregate metric objects have no independently verified
  // scalar evidence. Withhold only their groups, preserving unrelated panels.
  for (const root of ['breadth', 'leadership', 'outliers', 'moverDetails', 'leadershipDetails', 'outlierDetails']) {
    const own = result[root] && Object.fromEntries(Object.entries(result[root]).filter(([, item]) => !item || typeof item !== 'object'));
    if (rejected(own)) {
      result[root] = {};
      for (const [group, paths] of Object.entries(GROUPS)) if (paths.some(field => field.startsWith(`${root}.`))) incomplete.add(group);
    }
  }
  if (incomplete.size) result.incompleteReferenceGroups = [...incomplete];
  return result;
}

function rejected(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  const flags = ['mock', 'isMock', 'fixture', 'isFixture', 'seed', 'seeded', 'isSeed', 'stale', 'isStale', 'cacheOnly', 'isCacheOnly', 'cache_only', 'cached', 'fromCache', 'refreshFailed', 'offline', 'disconnected', 'synthetic', 'fallback', 'isFallback', 'modelOnly', 'portfolioDerived', 'costBasisDerived', 'inferred'];
  if (flags.some(key => value[key] === true) || value.connected === false || value.available === false) return true;
  if (['status', 'source', 'provider', 'freshness', 'provenance', 'warning'].some(key => typeof value[key] === 'string'
    && /(?:^|[\s_-])(?:unavailable|error|mock|fixture|seed|seeded|stale|cache.only|offline|disconnected|synthetic|fallback|model.only|inferred)(?:$|[\s_-])/i.test(value[key]))) return true;
  return Object.values(value).some(child => child && typeof child === 'object' && rejected(child, seen));
}

function valid(value, now) {
  if (!value || !['available', 'partial'].includes(value.status) || rejected(value)) return false;
  const observed = Date.parse(value.asOf);
  const expiry = Date.parse(value.expiresAt);
  if (!Number.isFinite(observed) || observed > now + 5_000 || !Number.isFinite(expiry) || expiry <= observed
    || typeof value.source !== 'string' || !value.source || !/^https:\/\//.test(value.sourceUrl || '')
    || !Number.isInteger(value.universe?.count) || value.universe.count < 1
    || !Number.isInteger(value.coverage?.quotes) || value.coverage.quotes < 0 || value.coverage.quotes > value.universe.count
    || value.coverage.total !== value.universe.count) return false;
  for (const key of ['breadth', 'leadership', 'outliers']) if (!value[key] || typeof value[key] !== 'object' || Array.isArray(value[key])) return false;
  for (const key of ['winners', 'losers']) if (!Array.isArray(value[key]) || value[key].length > 3
    || value[key].some(row => row && (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(row.ticker || '') || typeof row.name !== 'string'
      || !finite(row.changePercent) || !Number.isFinite(Date.parse(row.asOf)) || Date.parse(row.asOf) > now + 5_000))) return false;
  for (const group of Object.keys(GROUPS)) for (const row of groupRows(value, group)) {
    if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(row.ticker) || typeof row.name !== 'string' || !finite(row.changePercent)
      || !Number.isFinite(Date.parse(row.asOf)) || Date.parse(row.asOf) > now + 5_000
      || !row.source || !/^https:\/\//.test(row.sourceUrl || '') || !['live', 'delayed', 'last-close'].includes(row.status)
      || !/^\d{4}-\d{2}-\d{2}$/.test(row.marketDate || '')
      || (row.expiresAt !== undefined && (!Number.isFinite(Date.parse(row.expiresAt)) || Date.parse(row.expiresAt) <= Date.parse(row.asOf)))) return false;
  }
  for (const evidence of Object.values(value.referenceObservations || {})) {
    if (!evidence || !Number.isFinite(Date.parse(evidence.asOf)) || Date.parse(evidence.asOf) > now + 5_000
      || !Number.isFinite(Date.parse(evidence.expiresAt)) || !evidence.source || !/^https:\/\//.test(evidence.sourceUrl || '')
      || !Number.isInteger(evidence.universe?.count) || evidence.universe.count < 1 || !evidence.coverage) return false;
  }
  return true;
}

function evidenceFor(value, group) {
  if (value.referenceObservations?.[group]) return value.referenceObservations[group];
  const rows = groupRows(value, group);
  const oldest = rows.reduce((found, row) => !found || Date.parse(row.asOf) < Date.parse(found.asOf) ? row : found, null);
  const expiring = rows.filter(row => row.expiresAt).reduce((found, row) => !found || Date.parse(row.expiresAt) < Date.parse(found.expiresAt) ? row : found, null);
  return {
    asOf: oldest?.asOf || value.asOf, expiresAt: expiring?.expiresAt || value.expiresAt,
    source: oldest?.source || value.source, sourceUrl: oldest?.sourceUrl || value.sourceUrl,
    marketDate: oldest?.marketDate || value.marketDate || value.asOf.slice(0, 10),
    quoteStatus: oldest?.status || value.quoteStatus || 'delayed',
    universe: value.universe, coverage: value.coverage,
    retained: value.retained === true,
  };
}

function hasGroup(value, group) {
  if (value.incompleteReferenceGroups?.includes(group)) return false;
  const coverage = evidenceFor(value, group).coverage;
  if (group === 'breadth') return finite(value.breadth?.advancing) && finite(value.breadth?.declining) && coverage.quotes === coverage.total;
  if (group === 'above50') return finite(value.breadth?.above50Pct);
  if (group === 'above200') return finite(value.breadth?.above200Pct);
  if (group === 'highLow') return finite(value.breadth?.newHighs) && finite(value.breadth?.newLows);
  if (group === 'movers') return coverage.quotes > 0 && coverage.quotes === coverage.total;
  if (group === 'sectors') return Boolean(value.leadership?.leadingSector && value.leadership?.laggingSector);
  if (group === 'contributions') return Boolean(value.leadership?.lift || value.leadership?.drag) && coverage.quotes === coverage.total;
  const field = { relativeVolume: 'intradayVolume', unusualGain: 'intradayGain', reversal: 'reversalComparisons', againstSector: 'sectorComparisons' }[group];
  return coverage[field] > 0 && (value.outliers?.[group] != null || Array.isArray(value.outlierDetails?.[group]));
}

function put(value, path, incoming) {
  const parts = path.split('.');
  const last = parts.pop();
  let target = value;
  for (const part of parts) target = target[part] || (target[part] = {});
  target[last] = incoming === undefined ? null : clone(incoming);
}

function mark(value, now, force) {
  const result = clone(value);
  const aggregateExpired = !Object.keys(value.referenceObservations || {}).length && Date.parse(value.expiresAt) <= now;
  result.referenceObservations = {};
  for (const group of Object.keys(GROUPS)) {
    if (!hasGroup(value, group)) continue;
    const evidence = clone(evidenceFor(value, group));
    evidence.retained = force || evidence.retained === true || aggregateExpired || Date.parse(evidence.expiresAt) <= now;
    result.referenceObservations[group] = evidence;
    if (evidence.retained) for (const path of GROUPS[group]) {
      const rows = read(result, path);
      if (Array.isArray(rows)) rows.forEach(row => { if (row && typeof row === 'object') row.retained = true; });
      else if (rows && typeof rows === 'object') rows.retained = true;
    }
  }
  for (const group of Object.keys(GROUPS)) for (const row of groupRows(result, group)) {
    if (force || aggregateExpired || Date.parse(row.expiresAt) <= now) row.retained = true;
  }
  result.retained = force || result.retained === true || Date.parse(result.expiresAt) <= now
    || Object.values(result.referenceObservations).some(item => item.retained);
  result.displayOnly = true;
  result.executable = false;
  result.loading = false;
  return result;
}

function validateMarketDailyReference(value, now = Date.now()) {
  const clean = sanitize(value, now);
  return valid(clean, now) ? mark(clean, now, false) : null;
}

function retainMarketDailyReference(value, now = Date.now()) {
  const clean = sanitize(value, now);
  return valid(clean, now) ? mark(clean, now, true) : null;
}

function mergeMarketDailyReference(previous, incoming, now = Date.now()) {
  const old = validateMarketDailyReference(previous, now);
  const next = validateMarketDailyReference(incoming, now);
  if (!next) return old ? retainMarketDailyReference(old, now) : null;
  if (!old) return next;
  const result = clone(next);
  result.referenceObservations = {};
  for (const [group, paths] of Object.entries(GROUPS)) {
    const prior = hasGroup(old, group) ? evidenceFor(old, group) : null;
    const candidate = hasGroup(next, group) ? evidenceFor(next, group) : null;
    // An identical publication must not make an already-retained value fresh.
    const usePrevious = prior && (!candidate || Date.parse(candidate.asOf) < Date.parse(prior.asOf)
      || (Date.parse(candidate.asOf) === Date.parse(prior.asOf) && prior.retained));
    const selected = usePrevious ? old : next;
    const evidence = usePrevious ? { ...prior, retained: true } : candidate;
    if (!evidence) continue;
    paths.forEach(path => put(result, path, read(selected, path)));
    result.referenceObservations[group] = clone(evidence);
  }
  const observations = Object.values(result.referenceObservations);
  if (result.incompleteReferenceGroups) result.incompleteReferenceGroups = result.incompleteReferenceGroups.filter(group => !result.referenceObservations[group]);
  if (observations.length) {
    result.asOf = observations.reduce((a, b) => Date.parse(a.asOf) <= Date.parse(b.asOf) ? a : b).asOf;
    result.expiresAt = observations.reduce((a, b) => Date.parse(a.expiresAt) <= Date.parse(b.expiresAt) ? a : b).expiresAt;
  }
  result.retained = observations.some(item => item.retained);
  return mark(result, now, false);
}

module.exports = { GROUPS, validateMarketDailyReference, mergeMarketDailyReference, retainMarketDailyReference };
