import { bitcoinResearchDownloadHref, loadBitcoinResearchStudy, preferredBitcoinEntryDirection, validateBitcoinResearchStudy } from './bitcoinResearchService';

const sample = () => ({
  schemaVersion: 3, status: 'historical', startAt: '2025-07-28T00:00:00Z', endAt: '2026-09-15T18:00:00Z',
  intervals: ['hourly', 'daily', 'calendar_day'].map((id) => {
    const entryModes = (id === 'hourly' ? ['all_hours', 'first_per_day'] : ['all_days']).map((mode) => ({ id: mode }));
    const interval = {
      id, status: 'historical', source: 'Coinbase BTC-USD', priceBasis: 'open_to_close',
      session: id === 'hourly' ? '24h' : id === 'daily' ? 'nyse' : 'calendar_day', timeZone: 'America/New_York',
      startAt: '2025-07-28T13:30:00Z', endAt: '2026-09-14T20:00:00Z',
      coverage: { observedIntervals: 10, eligibleEntryIntervals: 10, unknownSignalIntervals: 0, missingIntervalCount: 0 },
      entryModes, cohorts: [{ id: 'bullish' }], zones: [{ id: 'bottom' }], filters: [{ id: 'none' }],
      volumeFilters: ['all', 'below_15d', 'at_or_above_15d'].map((volumeFilter) => ({ id: volumeFilter })),
      volume: { source: 'Coin Metrics', metric: 'volume_reported_spot_usd_1d', unit: 'USD', dayTimeZone: 'UTC', lookbackDays: 15,
        availabilityLagHours: 1, vintage: 'latest_retrieved', coveredIntervals: 10, unavailableIntervals: 0, coveredEligibleEntries: 10,
        methodology: ['Use the latest completed UTC volume day available before entry and the preceding 15 complete volume days.'] },
      rows: entryModes.flatMap(({ id: entryMode }) => ['all', 'below_15d', 'at_or_above_15d'].map((volumeFilter) => ({ cohort: 'bullish', zone: 'bottom', filter: 'none', entryMode, volumeFilter,
        observations: 10, days: entryMode === 'all_hours' ? 2 : 10,
        up: 5, down: 4, unchanged: 1, upPct: 50, downPct: 40, unchangedPct: 10, preferredDirection: 'UP',
        meanReturnPct: .1, medianReturnPct: .05, stability: null,
        volumeComparison: volumeFilter === 'all' ? null : {
          baseline: { observations: 10, days: entryMode === 'all_hours' ? 2 : 10, upPct: 50, downPct: 40, meanReturnPct: .1, medianReturnPct: .05 },
          targetDirection: 'UP', directionDifferencePp: 0, directionDifference95: [-10, 10], weeklyDifference95: [-15, 15],
          meanReturnDifferencePct: 0, medianReturnDifferencePct: 0,
        } }))),
    };
    interval.quadOverlay = {
      basis: 'retrospective_actual', country: 'United States', source: 'hedgeye-published-global-quads',
      sourceAsOf: '2026-08-12', publishedAt: null, availableAt: '2026-09-09T18:02:55Z',
      quarterAssignments: [{ quarter: '2026-Q1', quad: 1, kind: 'actual', periodStart: '2026-01-01T00:00:00-05:00', periodEnd: '2026-04-01T00:00:00-04:00' }],
      excludedQuarters: [{ quarter: '2026-Q3', quad: 4, kind: 'estimate', periodStart: '2026-07-01T00:00:00-04:00', periodEnd: '2026-10-01T00:00:00-04:00' }],
    };
    interval.quadOverlays = [1, 2, 3, 4].map((quad) => ({
      id: `q${quad}`, quad, label: `Quad ${quad}`, basis: 'retrospective_actual',
      methodology: ['Published historical actual quarter classifications; forecasts excluded.'],
      coverage: { observedIntervals: 0, eligibleEntryIntervals: 0, unknownSignalIntervals: 0, missingIntervalCount: 0 },
      volume: { ...interval.volume, coveredIntervals: 0, unavailableIntervals: 0, coveredEligibleEntries: 0 },
      rows: interval.rows.map((row) => ({ ...row, observations: 0, days: 0, up: 0, down: 0, unchanged: 0,
        upPct: null, downPct: null, unchangedPct: null, meanReturnPct: null, medianReturnPct: null,
        volumeComparison: row.volumeFilter === 'all' ? null : { baseline: { observations: 0, days: 0, upPct: null, downPct: null, meanReturnPct: null, medianReturnPct: null },
          targetDirection: 'UP', directionDifferencePp: null, directionDifference95: null, weeklyDifference95: null,
          meanReturnDifferencePct: null, medianReturnDifferencePct: null } })),
    }));
    return interval;
  }),
});

test('loads separately calculated hourly, calendar-day and NYSE historical observations', async () => {
  const study = sample();
  const fetchImpl = jest.fn().mockResolvedValue({ ok: true, json: async () => study });
  await expect(loadBitcoinResearchStudy({ fetchImpl })).resolves.toBe(study);
  expect(fetchImpl).toHaveBeenCalledWith('/research/bitcoin/study.json', expect.objectContaining({ cache: 'no-cache' }));
});

test.each(['mock', 'isMock', 'seeded', 'synthetic', 'inferred', 'portfolioDerived', 'stale', 'cacheOnly'])('rejects %s evidence at every level', (flag) => {
  const study = sample();
  expect(() => validateBitcoinResearchStudy({ ...study, [flag]: true })).toThrow('unavailable');
  study.intervals[1][flag] = true;
  expect(() => validateBitcoinResearchStudy(study)).toThrow('unavailable');
  delete study.intervals[1][flag];
  study.intervals[0].rows[0][flag] = true;
  expect(() => validateBitcoinResearchStudy(study)).toThrow('unavailable');
});

test.each(['offline', 'disconnected', 'error', 'unavailable'])('rejects provider %s evidence', (providerStatus) => {
  const study = sample();
  study.intervals[1].providerStatus = providerStatus;
  expect(() => validateBitcoinResearchStudy(study)).toThrow('unavailable');
});

test('rejects a row labeled as a fixture even inside an otherwise valid study', () => {
  const study = sample();
  study.intervals[0].rows[0].source = 'fixture';
  expect(() => validateBitcoinResearchStudy(study)).toThrow('unavailable');
});

test('rejects live labels, inconsistent percentages and a preferred outside-range row', () => {
  expect(() => validateBitcoinResearchStudy({ ...sample(), status: 'live' })).toThrow('unavailable');
  const wrongPercentage = sample();
  wrongPercentage.intervals[0].rows[0].upPct = 60;
  expect(() => validateBitcoinResearchStudy(wrongPercentage)).toThrow('unavailable');
  const outside = sample();
  outside.intervals[0].zones[0].id = 'below';
  outside.intervals[0].rows.forEach((row) => { row.zone = 'below'; });
  expect(() => validateBitcoinResearchStudy(outside)).toThrow('unavailable');
});

test('keeps empty historical groups distinct from zero-percent results', () => {
  const empty = sample();
  Object.assign(empty.intervals[0].rows[0], { observations: 0, days: 0, up: 0, down: 0, unchanged: 0, upPct: null, downPct: null, unchangedPct: null, meanReturnPct: null, medianReturnPct: null });
  expect(validateBitcoinResearchStudy(empty)).toBe(empty);
});

test('requires separate daily samples with one observation per session and correct units', () => {
  const study = sample();
  study.intervals[1].rows[0].days = 2;
  expect(() => validateBitcoinResearchStudy(study)).toThrow('unavailable');
  study.intervals[1].rows[0].days = 10;
  study.intervals[1].rows[0].hours = 10;
  expect(() => validateBitcoinResearchStudy(study)).toThrow('unavailable');
});

test('requires the NYSE convention, verified price source and completed interval cutoff', () => {
  for (const update of [
    { timeZone: 'America/Los_Angeles' }, { session: '24h' }, { source: 'mock BTC' },
    { priceBasis: 'daily_average' }, { endAt: '2026-09-15T20:00:00Z' },
    { startAt: '2025-07-27T20:00:00Z' }, { startAt: '2025-07-28T09:30:00' },
  ]) {
    const study = sample();
    Object.assign(study.intervals[1], update);
    expect(() => validateBitcoinResearchStudy(study)).toThrow('unavailable');
  }
});

test('rejects missing, duplicated or incorrectly sampled interval groups', () => {
  const missing = sample();
  missing.intervals[0].rows.pop();
  expect(() => validateBitcoinResearchStudy(missing)).toThrow('unavailable');
  const duplicate = sample();
  duplicate.intervals[1] = duplicate.intervals[0];
  expect(() => validateBitcoinResearchStudy(duplicate)).toThrow('unavailable');
  const sampling = sample();
  sampling.intervals[0].rows.find((row) => row.entryMode === 'first_per_day').days = 2;
  expect(() => validateBitcoinResearchStudy(sampling)).toThrow('unavailable');
});

test('does not mistake an old export for the complete three-interval volume study', () => {
  expect(() => validateBitcoinResearchStudy({ ...sample(), schemaVersion: 1 })).toThrow('unavailable');
  expect(() => validateBitcoinResearchStudy({ ...sample(), schemaVersion: 2 })).toThrow('unavailable');
});

test('only the two user-specified entry rules receive a preferred direction', () => {
  expect(preferredBitcoinEntryDirection({ cohort: 'bullish', zone: 'bottom' })).toBe('UP');
  expect(preferredBitcoinEntryDirection({ cohort: 'bearish', zone: 'top' })).toBe('DOWN');
  expect(preferredBitcoinEntryDirection({ cohort: 'bullish', zone: 'top' })).toBeNull();
  expect(preferredBitcoinEntryDirection({ cohort: 'bearish', zone: 'above' })).toBeNull();
});

test('download links remain inside the derived Bitcoin research directory', () => {
  expect(bitcoinResearchDownloadHref('/research/bitcoin/statistics.csv')).toBe('/research/bitcoin/statistics.csv');
  expect(bitcoinResearchDownloadHref('/research/bitcoin/../private.json')).toBeNull();
  expect(bitcoinResearchDownloadHref('https://other.test/study')).toBeNull();
});

test('failed source responses surface unavailable rather than a fallback study', async () => {
  await expect(loadBitcoinResearchStudy({ fetchImpl: async () => ({ ok: false }) })).rejects.toThrow('unavailable');
});


test('requires all four separately calculated Quad groups with actual-quarter provenance', () => {
  const study = sample();
  expect(validateBitcoinResearchStudy(study)).toBe(study);
  study.intervals[0].quadOverlays.pop();
  expect(() => validateBitcoinResearchStudy(study)).toThrow('unavailable');
});

test.each(['mock', 'seeded', 'stale', 'cacheOnly'])('rejects %s evidence in Quad metadata, groups and result rows', (flag) => {
  for (const target of ['quadOverlay', 'group', 'row']) {
    const study = sample();
    const interval = study.intervals[0];
    const evidence = target === 'quadOverlay' ? interval.quadOverlay
      : target === 'group' ? interval.quadOverlays[0] : interval.quadOverlays[0].rows[0];
    evidence[flag] = true;
    expect(() => validateBitcoinResearchStudy(study)).toThrow('unavailable');
  }
});

test('rejects forecasts passed as historical actuals or retroactive point-in-time labels', () => {
  for (const change of [
    (meta) => { meta.basis = 'point_in_time'; },
    (meta) => { meta.quarterAssignments[0].kind = 'estimate'; },
    (meta) => { meta.quarterAssignments.push(meta.excludedQuarters.pop()); },
    (meta) => { meta.source = 'inferred macro model'; },
    (meta) => { meta.availableAt = '2027-01-01T00:00:00Z'; },
    (meta) => { meta.publishedAt = '2026-09-10T00:00:00Z'; },
    (meta) => { meta.quarterAssignments[0].periodEnd = '2026-03-01T00:00:00-05:00'; },
    (meta) => { meta.sourceAsOf = '2026-09-10'; },
  ]) {
    const study = sample();
    change(study.intervals[0].quadOverlay);
    expect(() => validateBitcoinResearchStudy(study)).toThrow('unavailable');
  }
});

test('rejects malformed, inconsistent or double-counted Quad statistics', () => {
  const malformed = sample();
  malformed.intervals[0].quadOverlays[0].rows[0].upPct = 50;
  expect(() => validateBitcoinResearchStudy(malformed)).toThrow('unavailable');
  const missing = sample();
  missing.intervals[0].quadOverlays[0].rows.pop();
  expect(() => validateBitcoinResearchStudy(missing)).toThrow('unavailable');
  const duplicate = sample();
  duplicate.intervals[0].quadOverlays[0].rows = duplicate.intervals[0].rows.map((row) => ({ ...row }));
  duplicate.intervals[0].quadOverlays[1].rows = duplicate.intervals[0].rows.map((row) => ({ ...row }));
  expect(() => validateBitcoinResearchStudy(duplicate)).toThrow('unavailable');
});

const addStability = (study) => {
  const row = study.intervals[0].rows.find((item) => item.volumeFilter === 'below_15d');
  const metrics = { observations: row.observations, days: row.days, targetPct: 50, baselineTargetPct: 50, directionDifferencePp: 0 };
  row.stability = { byYear: [{ year: 2025, ...metrics, meanReturnPct: .1, medianReturnPct: .05 }], weeklyPct95: [40, 60],
    additionalDayLag: { ...metrics }, coinbaseVolume: { ...metrics } };
  return row;
};

test('validates calendar-day units separately from hourly and NYSE samples', () => {
  const study = sample();
  const calendar = study.intervals.find(({ id }) => id === 'calendar_day');
  expect(validateBitcoinResearchStudy(study)).toBe(study);
  calendar.session = 'nyse';
  expect(() => validateBitcoinResearchStudy(study)).toThrow('unavailable');
  calendar.session = 'calendar_day';
  calendar.rows[0].days = 2;
  expect(() => validateBitcoinResearchStudy(study)).toThrow('unavailable');
});

test('requires the verified volume series, full trailing window and completed-day availability', () => {
  for (const update of [{ source: 'Coinbase' }, { metric: 'estimated_volume' }, { unit: 'BTC' }, { lookbackDays: 14 },
    { availabilityLagHours: 0 }, { dayTimeZone: 'America/New_York' }, { vintage: 'point_in_time' },
    { coveredIntervals: 0 }, { unavailableIntervals: 1 }, { coveredEligibleEntries: 0 }]) {
    const study = sample();
    Object.assign(study.intervals[0].volume, update);
    expect(() => validateBitcoinResearchStudy(study)).toThrow('unavailable');
  }
});

test('rejects missing volume groups, mixed baselines and invalid confidence bounds', () => {
  for (const mutate of [
    (study) => { study.intervals[0].rows[1].volumeFilter = 'all'; },
    (study) => { study.intervals[0].rows[1].volumeComparison = null; },
    (study) => { study.intervals[0].rows[0].volumeComparison = study.intervals[0].rows[1].volumeComparison; },
    (study) => { study.intervals[0].rows[1].volumeComparison.baseline.observations = 9; },
    (study) => { study.intervals[0].rows[1].volumeComparison.directionDifferencePp = 10; },
    (study) => { study.intervals[0].rows[1].volumeComparison.meanReturnDifferencePct = 1; },
    (study) => { study.intervals[0].rows[1].volumeComparison.targetDirection = 'DOWN'; },
    (study) => { study.intervals[0].rows[1].volumeComparison.weeklyDifference95 = [20, -20]; },
    (study) => { study.intervals[0].rows[1].volumeComparison.directionDifference95 = [-101, 20]; },
  ]) {
    const study = sample();
    mutate(study);
    expect(() => validateBitcoinResearchStudy(study)).toThrow('unavailable');
  }
});

test.each(['mock', 'seeded', 'stale', 'cacheOnly'])('rejects %s evidence in volume sources, baselines and stability', (flag) => {
  for (const target of ['volume', 'comparison', 'baseline', 'stability', 'year', 'lag', 'venue', 'quadVolume']) {
    const study = sample();
    const row = addStability(study);
    const evidence = { volume: study.intervals[0].volume, comparison: row.volumeComparison, baseline: row.volumeComparison.baseline,
      stability: row.stability, year: row.stability.byYear[0], lag: row.stability.additionalDayLag,
      venue: row.stability.coinbaseVolume, quadVolume: study.intervals[0].quadOverlays[0].volume }[target];
    evidence[flag] = true;
    expect(() => validateBitcoinResearchStudy(study)).toThrow('unavailable');
  }
});

test('accepts reconciled yearly and sensitivity results and rejects inconsistent samples', () => {
  const good = sample();
  addStability(good);
  expect(validateBitcoinResearchStudy(good)).toBe(good);
  for (const mutate of [
    (stability) => { stability.byYear[0].observations = 9; },
    (stability) => { stability.byYear.push(stability.byYear[0]); },
    (stability) => { stability.byYear[0].directionDifferencePp = 5; },
    (stability) => { stability.weeklyPct95 = [-1, 60]; },
    (stability) => { stability.additionalDayLag.targetPct = 110; },
    (stability) => { stability.coinbaseVolume.days = 11; },
  ]) {
    const study = sample();
    mutate(addStability(study).stability);
    expect(() => validateBitcoinResearchStudy(study)).toThrow('unavailable');
  }
});

test('empty volume selections retain an evidenced baseline without fabricating a difference', () => {
  const study = sample();
  const row = study.intervals[0].rows[1];
  Object.assign(row, { observations: 0, days: 0, up: 0, down: 0, unchanged: 0, upPct: null, downPct: null, unchangedPct: null,
    meanReturnPct: null, medianReturnPct: null });
  Object.assign(row.volumeComparison, { directionDifferencePp: null, directionDifference95: null, weeklyDifference95: null,
    meanReturnDifferencePct: null, medianReturnDifferencePct: null });
  expect(validateBitcoinResearchStudy(study)).toBe(study);
  row.volumeComparison.directionDifferencePp = 0;
  expect(() => validateBitcoinResearchStudy(study)).toThrow('unavailable');
});
