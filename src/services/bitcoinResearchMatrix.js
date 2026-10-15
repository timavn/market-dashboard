// Historical conditional frequencies from the audited, entry-timed observation
// exports. These inputs are never quotes, forecasts, or executable probabilities.
export const MATRIX_REGIMES = Object.freeze(['bullish', 'neutral', 'bearish']);
export const MATRIX_USD_STATES = Object.freeze(['up', 'off', 'down']);
export const MATRIX_VOLATILITY = Object.freeze(['all', 'investable', 'chop', 'uninvestable']);
const ZONES = ['below', 'bottom', 'middle', 'top', 'above'];
const VOLUMES = ['all', 'below_15d', 'at_or_above_15d'];
const FIELDS = ['startAt', 'endAt', 'day', 'hour', 'cohort', 'zone', 'direction', 'returnPct',
  'filters', 'volume', 'volumeAvailableAt', 'quad', 'quadQuarter', 'signalAvailableAt',
  'indicatorReferenceAt', 'usdObservedAt', 'usdAvailableAt', 'corrAvailableAt',
  'corr120ReturnAvailableAt', 'usdReferenceAvailableAt', 'corr15Level', 'corr30Level',
  'corr120Return', 'usdSessionMoveBp', 'usdHourMoveBp', 'open', 'close', 'lowerRange',
  'upperRange', 'volumeDate', 'volumeUsd', 'volumeAverage15'];
const FLAGS = ['mock', 'isMock', 'seed', 'seeded', 'synthetic', 'inferred', 'portfolioDerived',
  'stale', 'cacheOnly', 'offline', 'disconnected', 'fallback'];
const fail = () => { throw new Error('Bitcoin matrix research unavailable'); };
const validTime = value => typeof value === 'string' && /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  && Number.isFinite(Date.parse(value));
const finite = value => typeof value === 'number' && Number.isFinite(value);
const before = (value, timestamp) => validTime(value) && Date.parse(value) <= timestamp;
const nyTime = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', hourCycle: 'h23',
});

function rejectFlags(value) {
  if (!value || typeof value !== 'object') return;
  if (FLAGS.some(key => value[key] === true) || value.connected === false
      || ['offline', 'disconnected', 'error', 'unavailable'].includes(value.providerStatus)
      || /mock|seed|fixture|synthetic|inferred|portfolio|fallback/i.test(value.source || '')) fail();
  Object.values(value).forEach(child => {
    if (child && typeof child === 'object') rejectFlags(child);
  });
}

export function bitcoinUsdRules(interval) {
  const result = [];
  for (const filter of interval?.filters || []) {
    if (filter.usdDirection !== 'UP' || !filter.id.endsWith('_up')) continue;
    const id = filter.id.slice(0, -3);
    if (!interval.filters.some(item => item.id === `${id}_down`)) continue;
    const window = { corr30Level: '30-session levels', corr15Level: '15-session levels', corr120Return: '120-hour returns' }[filter.correlationField];
    result.push({ id, label: `${window} · ≤${filter.correlationMax.toFixed(2)} · ≥${filter.minimumMoveBp} bp · ${filter.moveField === 'usdHourMoveBp' ? 'prior hour' : 'prior day'}` });
  }
  return result;
}

function validateDollar(row, interval) {
  if (!Array.isArray(row.filters) || row.filters[0] !== 'none'
      || new Set(row.filters).size !== row.filters.length
      || row.filters.some(id => !interval.filters.some(filter => filter.id === id))) fail();
  for (const id of row.filters.filter(value => value !== 'none')) {
    const spec = interval.filters.find(filter => filter.id === id);
    const reference = Date.parse(row.indicatorReferenceAt);
    const correlationTime = spec.correlationField === 'corr120Return' ? row.corr120ReturnAvailableAt : row.corrAvailableAt;
    const move = row[spec.moveField];
    if (!before(row.indicatorReferenceAt, row.timestamp) || row.timestamp - reference > 30 * 60 * 1000
        || !before(row.usdAvailableAt, reference) || !validTime(row.usdObservedAt)
        || Date.parse(row.usdObservedAt) !== reference - 3600000
        || Date.parse(row.usdAvailableAt) !== reference
        || !before(correlationTime, reference)
        || (spec.moveField === 'usdSessionMoveBp' && !before(row.usdReferenceAvailableAt, reference))
        || !finite(row[spec.correlationField]) || row[spec.correlationField] > spec.correlationMax + 1e-12
        || !finite(move) || (spec.usdDirection === 'UP' ? move < spec.minimumMoveBp - 1e-9 : move > -spec.minimumMoveBp + 1e-9)) fail();
  }
}

function validateRow(row, interval) {
  if (!validTime(row.startAt) || !validTime(row.endAt)) fail();
  row.timestamp = Date.parse(row.startAt);
  const end = Date.parse(row.endAt);
  const local = nyTime.format(new Date(row.timestamp));
  if (row.timestamp < Date.parse(interval.startAt) || end > Date.parse(interval.endAt) || end <= row.timestamp
      || row.day !== local.slice(0, 10) || row.hour !== Number(local.slice(11, 13))
      || !MATRIX_REGIMES.includes(row.cohort) || !ZONES.includes(row.zone)
      || !before(row.signalAvailableAt, row.timestamp)
      || !['UP', 'DOWN', 'UNCHANGED'].includes(row.direction)
      || !['open', 'close', 'lowerRange', 'upperRange'].every(field => finite(row[field]) && row[field] > 0)
      || row.lowerRange >= row.upperRange
      || !finite(row.returnPct) || Math.abs(row.returnPct - (row.close / row.open - 1) * 100) > 1e-7
      || row.direction !== (row.close > row.open ? 'UP' : row.close < row.open ? 'DOWN' : 'UNCHANGED')) fail();
  const position = (row.open - row.lowerRange) / (row.upperRange - row.lowerRange);
  const zone = row.open < row.lowerRange ? 'below' : row.open > row.upperRange ? 'above'
    : row.open < row.lowerRange + (row.upperRange - row.lowerRange) / 3 ? 'bottom'
      : row.open < row.lowerRange + 2 * (row.upperRange - row.lowerRange) / 3 ? 'middle' : 'top';
  if (!finite(position) || row.zone !== zone) fail();
  if (interval.id === 'hourly' && end - row.timestamp !== 3600000) fail();
  validateDollar(row, interval);
  if (row.volume !== null) {
    const lastVolumeDate = new Date(row.timestamp - 3600000 - 86400000).toISOString().slice(0, 10);
    if (!VOLUMES.slice(1).includes(row.volume) || !before(row.volumeAvailableAt, row.timestamp)
        || row.volumeDate !== lastVolumeDate
        || Date.parse(row.volumeAvailableAt) !== Date.parse(`${row.volumeDate}T00:00:00Z`) + 25 * 3600000
        || !finite(row.volumeUsd) || row.volumeUsd < 0 || !finite(row.volumeAverage15) || row.volumeAverage15 <= 0
        || row.volume !== (row.volumeUsd < row.volumeAverage15 ? 'below_15d' : 'at_or_above_15d')) fail();
  }
  const assignment = interval.quadOverlay.quarterAssignments.find(item => row.timestamp >= Date.parse(item.periodStart)
    && row.timestamp < Date.parse(item.periodEnd));
  if (row.quad !== (assignment?.quad ?? null)
      || (assignment && (assignment.kind !== 'actual' || row.quadQuarter !== assignment.quarter))) fail();
  row.year = Number(row.day.slice(0, 4));
  row.weekday = new Date(`${row.day}T12:00:00Z`).getUTCDay();
  row.volatility = null;
  return row;
}

/**
 * Returns { intervalId, rows, volatility, ...metadata }. Each normalized row has
 * startAt/endAt, timestamp, day, hour (New York 0–23), year, weekday (Sun=0),
 * cohort, zone, direction, returnPct, filters (USD rule IDs), volume, quad,
 * volatility:null, plus the source availability fields listed in FIELDS.
 * The interval must already pass validateBitcoinResearchStudy.
 */
export function validateBitcoinMatrixObservations(payload, interval) {
  rejectFlags(payload);
  if (!interval || payload?.schemaVersion !== 1 || payload.status !== 'historical'
      || payload.historicalOnly !== true || payload.executable !== false
      || payload.source !== 'Coinbase BTC-USD' || payload.priceBasis !== 'open_to_close'
      || payload.timeZone !== 'America/New_York' || payload.intervalId !== interval.id
      || payload.studyAsOf !== interval.asOf || payload.startAt !== interval.startAt || payload.endAt !== interval.endAt
      || payload.sourceExport !== `${interval.id}-observations.csv` || !/^[a-f0-9]{64}$/.test(payload.sourceSha256 || '')
      || payload.volume?.source !== 'Coin Metrics' || payload.volume.metric !== 'volume_reported_spot_usd_1d'
      || payload.volume.vintage !== 'latest_retrieved' || payload.volume.availabilityLagHours !== 1 || payload.volume.lookbackDays !== 15
      || payload.quad?.basis !== 'retrospective_actual' || payload.quad.source !== 'hedgeye-published-global-quads'
      || payload.volatility?.status !== 'unavailable' || !Array.isArray(payload.fields)
      || payload.fields.join('|') !== FIELDS.join('|') || !Array.isArray(payload.rows)
      || payload.rows.length !== interval.coverage.eligibleEntryIntervals) fail();
  let previous = -Infinity;
  const rows = payload.rows.map(values => {
    if (!Array.isArray(values) || values.length !== FIELDS.length) fail();
    const row = validateRow(Object.fromEntries(FIELDS.map((field, index) => [field, values[index]])), interval);
    if (row.timestamp <= previous) fail();
    previous = row.timestamp;
    return row;
  });
  // Reconcile the new representation against the existing audited counts. This
  // catches omitted/duplicated entries rather than silently changing the study.
  const mode = interval.id === 'hourly' ? 'all_hours' : 'all_days';
  for (const cohort of MATRIX_REGIMES) {
    for (const zone of ZONES) {
      const existing = interval.rows.find(row => row.cohort === cohort && row.zone === zone
        && row.filter === 'none' && row.volumeFilter === 'all' && row.entryMode === mode);
      const selected = rows.filter(row => row.cohort === cohort && row.zone === zone);
      if (!existing || selected.length !== existing.observations
          || new Set(selected.map(row => row.day)).size !== existing.days
          || ['UP', 'DOWN', 'UNCHANGED'].some(direction => selected.filter(row => row.direction === direction).length !== existing[direction.toLowerCase()])) fail();
    }
  }
  return { ...payload, rows, usdRules: bitcoinUsdRules(interval), entryModes: interval.entryModes.map(item => item.id), validated: true };
}

export async function loadBitcoinMatrixObservations(interval, { signal, fetchImpl = fetch } = {}) {
  if (!['hourly', 'calendar_day', 'daily'].includes(interval?.id)) fail();
  const response = await fetchImpl(`/research/bitcoin/${interval.id}-matrix-observations.json`, { signal, cache: 'no-cache' });
  if (!response.ok) fail();
  return validateBitcoinMatrixObservations(await response.json(), interval);
}

const CONSTRAINTS = new Set(['cohort', 'zone', 'usdState', 'usdRule', 'volatility', 'quads', 'volume',
  'years', 'hours', 'weekdays', 'entryMode', 'startAt', 'endAt', 'completeFields']);
const COMPLETE_FIELDS = ['quad', 'volume', 'year', 'hour', 'weekday', 'volatility'];

export function selectBitcoinMatrixRows(dataset, constraints = {}) {
  if (dataset?.validated !== true || !Array.isArray(dataset.rows)) fail();
  const { cohort, zone, usdState = 'off', usdRule = 'main', volatility = 'all', quads = [], volume = 'all',
    years = [], hours = [], weekdays = [], entryMode = dataset.intervalId === 'hourly' ? 'all_hours' : 'all_days',
    startAt, endAt, completeFields = [] } = constraints;
  const arrays = [[quads, value => [1, 2, 3, 4].includes(value)],
    [years, value => Number.isInteger(value) && value >= 1900 && value <= 2200],
    [hours, value => Number.isInteger(value) && value >= 0 && value <= 23],
    [weekdays, value => Number.isInteger(value) && value >= 0 && value <= 6],
    [completeFields, value => COMPLETE_FIELDS.includes(value)]];
  if (Object.keys(constraints).some(key => !CONSTRAINTS.has(key))
      || (cohort !== undefined && !MATRIX_REGIMES.includes(cohort)) || (zone !== undefined && !ZONES.includes(zone))
      || !MATRIX_USD_STATES.includes(usdState) || !dataset.usdRules.some(rule => rule.id === usdRule)
      || !MATRIX_VOLATILITY.includes(volatility) || !VOLUMES.includes(volume) || !dataset.entryModes.includes(entryMode)
      || arrays.some(([values, test]) => !Array.isArray(values) || values.some(value => !test(value)))
      || (startAt !== undefined && !validTime(startAt)) || (endAt !== undefined && !validTime(endAt))
      || (startAt !== undefined && endAt !== undefined && Date.parse(startAt) >= Date.parse(endAt))) fail();
  const start = startAt === undefined ? -Infinity : Date.parse(startAt);
  const end = endAt === undefined ? Infinity : Date.parse(endAt);
  const dollar = usdState === 'off' ? 'none' : `${usdRule}_${usdState}`;
  const seen = new Set();
  return dataset.rows.filter(row => {
    if ((cohort && row.cohort !== cohort) || (zone && row.zone !== zone)
        || row.timestamp < start || Date.parse(row.endAt) > end || !row.filters.includes(dollar)
        || (volatility !== 'all' && row.volatility !== volatility)
        || (quads.length && !quads.includes(row.quad)) || (volume !== 'all' && row.volume !== volume)
        || (years.length && !years.includes(row.year)) || (hours.length && !hours.includes(row.hour))
        || (weekdays.length && !weekdays.includes(row.weekday))
        || completeFields.some(field => row[field] === null || row[field] === undefined)) return false;
    if (entryMode === 'first_per_day') {
      if (seen.has(row.day)) return false;
      seen.add(row.day);
    }
    return true;
  });
}

const percent = (n, total) => total ? 100 * n / total : null;
const percentile = (sorted, p) => {
  const position = (sorted.length - 1) * p;
  const left = Math.floor(position);
  return sorted[left] + (sorted[Math.ceil(position)] - sorted[left]) * (position - left);
};

// Resample entire New York date blocks, preserving within-day dependence and
// unchanged outcomes in every denominator. Deterministic 10,000-replicate CIs.
function dayBlockIntervals(rows) {
  const days = new Map();
  let seed = 20260915;
  for (const row of rows) {
    const block = days.get(row.day) || { n: 0, up: 0, down: 0 };
    block.n += 1;
    block.up += row.direction === 'UP' ? 1 : 0;
    block.down += row.direction === 'DOWN' ? 1 : 0;
    days.set(row.day, block);
    for (const char of `${row.startAt}${row.direction}`) seed = Math.imul(seed ^ char.charCodeAt(0), 16777619) >>> 0;
  }
  if (days.size < 2) return { upPct95: null, downPct95: null };
  const blocks = [...days.values()];
  const upSamples = [];
  const downSamples = [];
  const random = () => {
    seed += 0x6D2B79F5;
    let value = seed;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
  for (let iteration = 0; iteration < 10000; iteration += 1) {
    let n = 0;
    let up = 0;
    let down = 0;
    for (let index = 0; index < blocks.length; index += 1) {
      const block = blocks[Math.floor(random() * blocks.length)];
      n += block.n;
      up += block.up;
      down += block.down;
    }
    upSamples.push(100 * up / n);
    downSamples.push(100 * down / n);
  }
  upSamples.sort((a, b) => a - b);
  downSamples.sort((a, b) => a - b);
  return { upPct95: [percentile(upSamples, .025), percentile(upSamples, .975)],
    downPct95: [percentile(downSamples, .025), percentile(downSamples, .975)] };
}

export function summarizeBitcoinMatrixRows(rows, { outcome = 'up', minimumObservations = 30, minimumDays = 10, interval = false } = {}) {
  if (!Array.isArray(rows) || !['up', 'down'].includes(outcome)
      || !Number.isInteger(minimumObservations) || minimumObservations < 1 || !Number.isInteger(minimumDays) || minimumDays < 1) fail();
  const observations = rows.length;
  const days = new Set(rows.map(row => row.day)).size;
  const up = rows.filter(row => row.direction === 'UP').length;
  const down = rows.filter(row => row.direction === 'DOWN').length;
  const unchanged = observations - up - down;
  const returns = rows.map(row => row.returnPct).sort((a, b) => a - b);
  const bounds = interval && observations ? dayBlockIntervals(rows) : { upPct95: null, downPct95: null };
  return { observations, days, up, down, unchanged, upPct: percent(up, observations), downPct: percent(down, observations),
    unchangedPct: percent(unchanged, observations), pct: percent(outcome === 'up' ? up : down, observations),
    meanReturnPct: observations ? returns.reduce((a, b) => a + b, 0) / observations : null,
    medianReturnPct: observations ? percentile(returns, .5) : null,
    limitedSample: observations < minimumObservations || days < minimumDays,
    ...bounds, pct95: bounds[`${outcome}Pct95`], intervalMethod: interval ? 'New York day-block bootstrap · 10,000 replicates' : null };
}

export function calculateBitcoinMatrixCell(dataset, constraints = {}, options = {}) {
  const summary = summarizeBitcoinMatrixRows(selectBitcoinMatrixRows(dataset, constraints), options);
  return { ...summary, status: constraints.volatility && constraints.volatility !== 'all'
    && dataset.volatility.status !== 'available' ? 'unavailable' : summary.observations ? 'available' : 'empty' };
}

export function bitcoinMatrixAxes(dataset) {
  const firstYear = Number(nyTime.format(new Date(dataset.startAt)).slice(0, 4));
  const lastYear = Number(nyTime.format(new Date(dataset.endAt)).slice(0, 4));
  const years = Array.from({ length: lastYear - firstYear + 1 }, (_, index) => firstYear + index);
  return [
    { id: 'quad', label: 'Historical US Quad', values: [1, 2, 3, 4].map(id => ({ id: `q${id}`, label: `Quad ${id}`, constraints: { quads: [id] } })) },
    { id: 'volume', label: 'Volume', values: [
      { id: 'all', label: 'All', constraints: { volume: 'all' } },
      { id: 'below_15d', label: 'Below 15-day avg', constraints: { volume: 'below_15d' } },
      { id: 'at_or_above_15d', label: 'At / above 15-day avg', constraints: { volume: 'at_or_above_15d' } },
    ] },
    { id: 'year', label: 'Year', values: years.map(id => ({ id: String(id), label: String(id), constraints: { years: [id] } })) },
    ...(dataset.intervalId === 'hourly' ? [{ id: 'hour', label: 'Entry hour · New York', values: Array.from({ length: 24 }, (_, id) => ({ id: String(id), label: `${String(id).padStart(2, '0')}:00`, constraints: { hours: [id] } })) }] : []),
    { id: 'weekday', label: 'Day of week · New York', values: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((label, id) => ({ id: String(id), label, constraints: { weekdays: [id] } })) },
  ];
}
