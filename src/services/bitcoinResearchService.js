const STUDY_URL = '/research/bitcoin/study.json';
const FLAGS = ['mock', 'isMock', 'seeded', 'synthetic', 'inferred', 'portfolioDerived', 'stale', 'cacheOnly'];
const unavailable = () => { throw new Error('Bitcoin research unavailable'); };
const validTime = (value) => typeof value === 'string' && /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  && Number.isFinite(Date.parse(value));
const invalidEvidence = (value) => !value || FLAGS.some((key) => value[key] === true)
  || ['offline', 'disconnected', 'error', 'unavailable'].includes(value.providerStatus)
  || /mock|seed|fixture|synthetic|inferred|portfolio|fallback/i.test(value.source || '');

export function preferredBitcoinEntryDirection(row) {
  if (['bullish', 'current_bullish'].includes(row?.cohort) && row?.zone === 'bottom') return 'UP';
  if (row?.cohort === 'bearish' && row?.zone === 'top') return 'DOWN';
  return null;
}

const ROW_CATALOGS = { cohort: 'cohorts', zone: 'zones', filter: 'filters', entryMode: 'entryModes', volumeFilter: 'volumeFilters' };
const rowKey = (row) => Object.keys(ROW_CATALOGS).map((key) => row[key]).join('|');
const nyDateTime = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
const quarterBoundary = (year, quarter) => `${year + Math.floor((quarter - 1) / 4)}-${String(((quarter - 1) % 4) * 3 + 1).padStart(2, '0')}-01 00:00:00`;

function validateInterval(study, container) {
  const catalogs = Object.values(ROW_CATALOGS);
  const daily = study?.id !== 'hourly';
  if (invalidEvidence(study) || study.status !== 'historical'
      || !['hourly', 'calendar_day', 'daily'].includes(study.id)
      || study.timeZone !== 'America/New_York'
      || study.source !== 'Coinbase BTC-USD' || study.priceBasis !== 'open_to_close'
      || study.session !== ({ hourly: '24h', calendar_day: 'calendar_day', daily: 'nyse' })[study.id]
      || !validTime(study.startAt) || !validTime(study.endAt)
      || Date.parse(study.startAt) >= Date.parse(study.endAt)
      || Date.parse(study.startAt) < Date.parse(container.startAt)
      || Date.parse(study.endAt) > Date.parse(container.endAt)
      || !Array.isArray(study.rows) || !study.rows.length
      || catalogs.some((key) => !Array.isArray(study[key]) || !study[key].length
        || study[key].some((item) => !item || typeof item.id !== 'string' || !item.id)
        || new Set(study[key].map((item) => item.id)).size !== study[key].length)) {
    unavailable();
  }
  const modes = daily ? ['all_days'] : ['all_hours', 'first_per_day'];
  if (study.entryModes.length !== modes.length || study.entryModes.some(({ id }) => !modes.includes(id))) unavailable();
  const volumes = ['all', 'below_15d', 'at_or_above_15d'];
  if (study.volumeFilters.length !== volumes.length || study.volumeFilters.some(({ id }) => !volumes.includes(id))) unavailable();
  validateVolume(study);
  validateRows(study.rows, study);
  validateQuadOverlays(study, container);
}

function validateRows(rows, study) {
  const daily = study.id !== 'hourly';
  if (!Array.isArray(rows) || !rows.length) unavailable();
  const keys = new Set();
  for (const row of rows) {
    if (invalidEvidence(row)) unavailable();
    const key = rowKey(row);
    const counts = ['observations', 'days', 'up', 'down', 'unchanged'];
    if (keys.has(key)
        || Object.entries(ROW_CATALOGS).some(([field, catalog]) => !study[catalog].some((item) => item.id === row[field]))
        || counts.some((field) => !Number.isInteger(row[field]) || row[field] < 0)
        || row.up + row.down + row.unchanged !== row.observations || row.days > row.observations
        || (row.observations > 0 && row.days === 0)
        || ((daily || row.entryMode === 'first_per_day') && row.days !== row.observations)
        || (row.hours !== undefined && (daily || row.hours !== row.observations))
        || (row.preferredDirection ?? null) !== preferredBitcoinEntryDirection(row)
        || ['meanReturnPct', 'medianReturnPct'].some((field) => row.observations ? !Number.isFinite(row[field]) : row[field] !== null)
        || [['upPct', 'up'], ['downPct', 'down'], ['unchangedPct', 'unchanged']].some(([field, count]) => (
          row.observations ? !Number.isFinite(row[field]) || Math.abs(row[field] - 100 * row[count] / row.observations) > 0.0001 : row[field] !== null
        ))
        || ['upPct95', 'downPct95'].some((field) => row[field] != null && (
          !Array.isArray(row[field]) || row[field].length !== 2
          || row[field].some((value) => !Number.isFinite(value) || value < 0 || value > 100)
          || row[field][0] > row[field][1]
        ))) unavailable();
    keys.add(key);
    validateVolumeComparison(row, study);
    validateStability(row, study);
  }
  if (keys.size !== Object.values(ROW_CATALOGS).reduce((total, key) => total * study[key].length, 1)) unavailable();
}

const validBounds = (value, minimum, maximum) => value === null || (Array.isArray(value) && value.length === 2
  && value.every((item) => Number.isFinite(item) && item >= minimum && item <= maximum) && value[0] <= value[1]);
const validMetric = (value, empty, minimum = -Infinity, maximum = Infinity) => empty ? value === null
  : Number.isFinite(value) && value >= minimum && value <= maximum;
const validCounts = (sample, study) => Number.isInteger(sample?.observations) && sample.observations >= 0
  && Number.isInteger(sample.days) && sample.days >= 0 && sample.days <= sample.observations
  && (sample.observations === 0 ? sample.days === 0 : sample.days > 0)
  && (study.id === 'hourly' || sample.observations === sample.days);

function validateVolume(study) {
  const volume = study.volume;
  if (invalidEvidence(volume) || volume.source !== 'Coin Metrics' || volume.metric !== 'volume_reported_spot_usd_1d'
      || volume.unit !== 'USD' || volume.dayTimeZone !== 'UTC' || volume.lookbackDays !== 15
      || volume.availabilityLagHours !== 1 || volume.vintage !== 'latest_retrieved'
      || !Array.isArray(volume.methodology) || !volume.methodology.length
      || volume.methodology.some((line) => typeof line !== 'string' || !line)
      || ['coveredIntervals', 'unavailableIntervals', 'coveredEligibleEntries'].some((key) => !Number.isInteger(volume[key]) || volume[key] < 0)
      || volume.coveredIntervals + volume.unavailableIntervals !== study.coverage?.observedIntervals
      || volume.coveredEligibleEntries > volume.coveredIntervals
      || volume.coveredEligibleEntries > study.coverage?.eligibleEntryIntervals) unavailable();
}

function validateVolumeComparison(row, study) {
  const comparison = row.volumeComparison;
  if (row.volumeFilter === 'all') {
    if (comparison !== null) unavailable();
    return;
  }
  const baseline = comparison?.baseline;
  const target = preferredBitcoinEntryDirection(row) || 'UP';
  const targetField = target === 'UP' ? 'upPct' : 'downPct';
  if (invalidEvidence(comparison) || invalidEvidence(baseline) || !validCounts(baseline, study)
      || baseline.observations < row.observations || baseline.days < row.days
      || baseline.observations > study.volume.coveredEligibleEntries
      || (row.entryMode === 'first_per_day' && baseline.observations !== baseline.days)
      || comparison.targetDirection !== target
      || ['upPct', 'downPct'].some((key) => !validMetric(baseline[key], baseline.observations === 0, 0, 100))
      || (baseline.observations > 0 && baseline.upPct + baseline.downPct > 100.0001)
      || ['meanReturnPct', 'medianReturnPct'].some((key) => !validMetric(baseline[key], baseline.observations === 0))
      || !validBounds(comparison.directionDifference95, -100, 100)
      || !validBounds(comparison.weeklyDifference95, -100, 100)) unavailable();
  for (const [delta, metric] of [['directionDifferencePp', targetField], ['meanReturnDifferencePct', 'meanReturnPct'], ['medianReturnDifferencePct', 'medianReturnPct']]) {
    const empty = row.observations === 0 || baseline.observations === 0;
    if (!validMetric(comparison[delta], empty)
        || (!empty && Math.abs(comparison[delta] - (row[metric] - baseline[metric])) > 0.0001)) unavailable();
  }
  if (!row.observations && (comparison.directionDifference95 !== null || comparison.weeklyDifference95 !== null)) unavailable();
}

function validateStability(row, study) {
  const stability = row.stability;
  if (stability === null) return;
  if (!preferredBitcoinEntryDirection(row) || invalidEvidence(stability)
      || !Array.isArray(stability.byYear) || !validBounds(stability.weeklyPct95, 0, 100)) unavailable();
  const years = new Set();
  let observations = 0;
  let days = 0;
  const validateSample = (sample) => {
    if (invalidEvidence(sample) || !validCounts(sample, study)
        || (row.entryMode === 'first_per_day' && sample.days !== sample.observations)
        || !validMetric(sample.targetPct, sample.observations === 0, 0, 100)
        || !(sample.baselineTargetPct === null || validMetric(sample.baselineTargetPct, false, 0, 100))) unavailable();
    const empty = !sample.observations || sample.baselineTargetPct === null;
    if (!validMetric(sample.directionDifferencePp, empty, -100, 100)
        || (!empty && Math.abs(sample.directionDifferencePp - sample.targetPct + sample.baselineTargetPct) > 0.0001)) unavailable();
  };
  for (const sample of stability.byYear) {
    validateSample(sample);
    if (!/^\d{4}$/.test(String(sample.year)) || years.has(String(sample.year))
        || ['meanReturnPct', 'medianReturnPct'].some((key) => !validMetric(sample[key], sample.observations === 0))) unavailable();
    years.add(String(sample.year));
    observations += sample.observations;
    days += sample.days;
  }
  if (observations !== row.observations || days !== row.days || (!row.observations && stability.weeklyPct95 !== null)) unavailable();
  validateSample(stability.additionalDayLag);
  validateSample(stability.coinbaseVolume);
}

function validateQuadOverlays(study, container) {
  const meta = study.quadOverlay;
  const overlays = study.quadOverlays;
  const quads = [1, 2, 3, 4];
  if (invalidEvidence(meta) || meta.basis !== 'retrospective_actual'
      || meta.country !== 'United States' || meta.source !== 'hedgeye-published-global-quads'
      || !/^\d{4}-\d{2}-\d{2}$/.test(meta.sourceAsOf || '') || !Number.isFinite(Date.parse(meta.sourceAsOf))
      || !validTime(meta.availableAt) || Date.parse(meta.availableAt) > Date.parse(container.endAt)
      || Date.parse(meta.sourceAsOf) > Date.parse(meta.availableAt)
      || (meta.publishedAt !== null && (!validTime(meta.publishedAt) || Date.parse(meta.publishedAt) > Date.parse(meta.availableAt)))
      || !Array.isArray(meta.quarterAssignments) || !meta.quarterAssignments.length
      || !Array.isArray(meta.excludedQuarters)
      || !Array.isArray(overlays) || overlays.length !== 4
      || new Set(overlays.map((item) => item?.id)).size !== 4) unavailable();
  const seen = new Set();
  const periods = [...meta.quarterAssignments, ...meta.excludedQuarters];
  for (const period of periods) {
    if (invalidEvidence(period) || !/^\d{4}-Q[1-4]$/.test(period.quarter || '')
        || seen.has(period.quarter) || !quads.includes(period.quad)
        || !validTime(period.periodStart) || !validTime(period.periodEnd)
        || Date.parse(period.periodStart) >= Date.parse(period.periodEnd)) unavailable();
    const [year, quarter] = period.quarter.split('-Q').map(Number);
    if (nyDateTime.format(new Date(period.periodStart)) !== quarterBoundary(year, quarter)
        || nyDateTime.format(new Date(period.periodEnd)) !== quarterBoundary(year, quarter + 1)) unavailable();
    seen.add(period.quarter);
  }
  if (meta.quarterAssignments.some((item) => item.kind !== 'actual'
      || Date.parse(item.periodEnd) > Date.parse(meta.sourceAsOf))
      || meta.excludedQuarters.some((item) => item.kind !== 'estimate')) unavailable();
  const countFields = ['observations', 'days', 'up', 'down', 'unchanged'];
  const totals = new Map(study.rows.map((row) => [rowKey(row), Object.fromEntries(countFields.map((field) => [field, 0]))]));
  for (const overlay of overlays) {
    if (invalidEvidence(overlay) || !quads.includes(overlay.quad) || overlay.id !== `q${overlay.quad}`
        || overlay.label !== `Quad ${overlay.quad}` || overlay.basis !== meta.basis
        || !Array.isArray(overlay.methodology) || !overlay.methodology.length
        || overlay.methodology.some((line) => typeof line !== 'string' || !line)
        || invalidEvidence(overlay.coverage)
        || ['observedIntervals', 'eligibleEntryIntervals', 'unknownSignalIntervals', 'missingIntervalCount'].some((key) => (
          !Number.isInteger(overlay.coverage[key]) || overlay.coverage[key] < 0
          || !Number.isInteger(study.coverage?.[key])
          || overlay.coverage[key] > study.coverage?.[key]
        )) || overlay.coverage.eligibleEntryIntervals + overlay.coverage.unknownSignalIntervals > overlay.coverage.observedIntervals) unavailable();
    const overlayStudy = { ...study, coverage: overlay.coverage, volume: overlay.volume };
    validateVolume(overlayStudy);
    validateRows(overlay.rows, overlayStudy);
    for (const row of overlay.rows) {
      if (row.observations > overlay.coverage.eligibleEntryIntervals) unavailable();
      const total = totals.get(rowKey(row));
      countFields.forEach((field) => { total[field] += row[field]; });
    }
  }
  for (const row of study.rows) {
    if (countFields.some((field) => totals.get(rowKey(row))[field] > row[field])) unavailable();
  }
}

export function validateBitcoinResearchStudy(study) {
  if (invalidEvidence(study) || study.schemaVersion !== 3 || study.status !== 'historical'
      || !validTime(study.startAt) || !validTime(study.endAt)
      || Date.parse(study.startAt) >= Date.parse(study.endAt)
      || !Array.isArray(study.intervals) || study.intervals.length !== 3
      || new Set(study.intervals.map((item) => item?.id)).size !== 3) unavailable();
  study.intervals.forEach((interval) => validateInterval(interval, study));
  return study;
}

export async function loadBitcoinResearchStudy({ signal, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(STUDY_URL, { signal, cache: 'no-cache' });
  if (!response.ok) throw new Error('Bitcoin research unavailable');
  return validateBitcoinResearchStudy(await response.json());
}

export function bitcoinResearchDownloadHref(value) {
  return typeof value === 'string' && /^\/research\/bitcoin\/[a-zA-Z0-9._-]+$/.test(value) ? value : null;
}
