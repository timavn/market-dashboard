import {
  MATRIX_REGIMES, MATRIX_USD_STATES, bitcoinMatrixAxes, bitcoinUsdRules, calculateBitcoinMatrixCell,
  loadBitcoinMatrixObservations, selectBitcoinMatrixRows, summarizeBitcoinMatrixRows, validateBitcoinMatrixObservations,
} from './bitcoinResearchMatrix';

const study = require('../../public/research/bitcoin/study.json');
const payloads = {
  hourly: require('../../public/research/bitcoin/hourly-matrix-observations.json'),
  calendar_day: require('../../public/research/bitcoin/calendar_day-matrix-observations.json'),
  daily: require('../../public/research/bitcoin/daily-matrix-observations.json'),
};
const interval = id => study.intervals.find(item => item.id === id);
const datasets = {};
beforeAll(() => {
  Object.keys(payloads).forEach(id => { datasets[id] = validateBitcoinMatrixObservations(payloads[id], interval(id)); });
});
const alteredRow = (updates, index = 0) => {
  const payload = payloads.hourly;
  const rows = [...payload.rows];
  rows[index] = [...rows[index]];
  Object.entries(updates).forEach(([field, value]) => { rows[index][payload.fields.indexOf(field)] = value; });
  return { ...payload, rows };
};

test('keeps the requested regime and dollar ordering and all existing USD rule choices', () => {
  expect(MATRIX_REGIMES).toEqual(['bullish', 'neutral', 'bearish']);
  expect(MATRIX_USD_STATES).toEqual(['up', 'off', 'down']);
  expect(bitcoinUsdRules(interval('hourly')).map(rule => rule.id)).toEqual([
    'main', 'short_window', 'stronger_corr', 'smaller_move', 'larger_move', 'return_corr', 'hour_move',
  ]);
});

test.each(['hourly', 'calendar_day', 'daily'])('validates and reproduces %s source counts, percentages, means, medians and date grouping', id => {
  const source = interval(id);
  const data = datasets[id];
  const checks = [
    { cohort: 'bullish', zone: 'bottom', usdState: 'off', volume: 'all', quads: [] },
    { cohort: 'bearish', zone: 'top', usdState: 'up', volume: 'below_15d', quads: [] },
    { cohort: 'neutral', zone: 'middle', usdState: 'down', volume: 'at_or_above_15d', quads: [] },
    { cohort: 'bullish', zone: 'bottom', usdState: 'off', volume: 'below_15d', quads: [3] },
    { cohort: 'bearish', zone: 'above', usdState: 'off', volume: 'all', quads: [4] },
  ];
  for (const entryMode of data.entryModes) {
    for (const constraints of checks) {
      const result = calculateBitcoinMatrixCell(data, { ...constraints, entryMode });
      const sourceRows = constraints.quads.length ? source.quadOverlays.find(item => item.quad === constraints.quads[0]).rows : source.rows;
      const existing = sourceRows.find(row => row.cohort === constraints.cohort && row.zone === constraints.zone
        && row.filter === (constraints.usdState === 'off' ? 'none' : `main_${constraints.usdState}`)
        && row.volumeFilter === constraints.volume && row.entryMode === entryMode);
      for (const key of ['observations', 'days', 'up', 'down', 'unchanged']) expect(result[key]).toBe(existing[key]);
      for (const key of ['upPct', 'downPct', 'meanReturnPct', 'medianReturnPct']) {
        const matcher = expect.closeTo(Number(existing[key]), 7);
        expect(result[key]).toEqual(existing[key] === null ? null : matcher);
      }
    }
  }
});

test('fetches only the selected interval export and rejects failed responses without a fallback', async () => {
  const fetchImpl = jest.fn().mockResolvedValue({ ok: true, json: async () => payloads.daily });
  const result = await loadBitcoinMatrixObservations(interval('daily'), { fetchImpl });
  expect(result.rows).toHaveLength(649);
  expect(fetchImpl).toHaveBeenCalledWith('/research/bitcoin/daily-matrix-observations.json', expect.objectContaining({ cache: 'no-cache' }));
  await expect(loadBitcoinMatrixObservations(interval('daily'), { fetchImpl: async () => ({ ok: false }) })).rejects.toThrow('unavailable');
});

test.each(['mock', 'isMock', 'seeded', 'synthetic', 'inferred', 'portfolioDerived', 'stale', 'cacheOnly'])('rejects %s at top level and in nested provenance', flag => {
  expect(() => validateBitcoinMatrixObservations({ ...payloads.hourly, [flag]: true }, interval('hourly'))).toThrow('unavailable');
  expect(() => validateBitcoinMatrixObservations({ ...payloads.hourly, volume: { ...payloads.hourly.volume, [flag]: true } }, interval('hourly'))).toThrow('unavailable');
});

test.each(['offline', 'disconnected', 'error', 'unavailable'])('rejects provider %s state', providerStatus => {
  expect(() => validateBitcoinMatrixObservations({ ...payloads.hourly, providerStatus }, interval('hourly'))).toThrow('unavailable');
});

test('rejects future signals, inconsistent outcomes, missing rows and malformed or duplicate rows', () => {
  expect(() => validateBitcoinMatrixObservations(alteredRow({ signalAvailableAt: '2030-01-01T00:00:00Z' }), interval('hourly'))).toThrow('unavailable');
  expect(() => validateBitcoinMatrixObservations(alteredRow({ direction: 'UNCHANGED' }), interval('hourly'))).toThrow('unavailable');
  expect(() => validateBitcoinMatrixObservations({ ...payloads.hourly, rows: payloads.hourly.rows.slice(1) }, interval('hourly'))).toThrow('unavailable');
  expect(() => validateBitcoinMatrixObservations({ ...payloads.hourly, rows: [payloads.hourly.rows[0], ...payloads.hourly.rows.slice(0, -1)] }, interval('hourly'))).toThrow('unavailable');
});

test('rejects dollar conditions with future evidence or an incorrect lag', () => {
  const index = payloads.hourly.rows.findIndex(row => row[payloads.hourly.fields.indexOf('filters')].length > 1);
  expect(() => validateBitcoinMatrixObservations(alteredRow({ usdAvailableAt: '2030-01-01T00:00:00Z' }, index), interval('hourly'))).toThrow('unavailable');
  const startAt = payloads.hourly.rows[index][0];
  expect(() => validateBitcoinMatrixObservations(alteredRow({ usdObservedAt: startAt }, index), interval('hourly'))).toThrow('unavailable');
});

test('rejects future or wrongly classified volume and unsourced actual Quads', () => {
  expect(() => validateBitcoinMatrixObservations(alteredRow({ volumeAvailableAt: '2030-01-01T00:00:00Z' }), interval('hourly'))).toThrow('unavailable');
  expect(() => validateBitcoinMatrixObservations(alteredRow({ volume: 'at_or_above_15d', volumeUsd: 0 }), interval('hourly'))).toThrow('unavailable');
  expect(() => validateBitcoinMatrixObservations(alteredRow({ quad: 2, quadQuarter: '2021-Q3' }), interval('hourly'))).toThrow('unavailable');
});

test('applies every restriction before first-per-day sampling', () => {
  const source = datasets.hourly;
  const first = source.rows[0];
  const rows = [
    { ...first, volume: 'at_or_above_15d', hour: 11 },
    { ...source.rows[1], day: first.day, volume: 'below_15d', hour: 12 },
    { ...source.rows[2], day: first.day, volume: 'below_15d', hour: 13 },
  ];
  const result = selectBitcoinMatrixRows({ ...source, rows }, { volume: 'below_15d', entryMode: 'first_per_day' });
  expect(result).toEqual([rows[1]]);
  expect(selectBitcoinMatrixRows({ ...source, rows }, { hours: [13], entryMode: 'first_per_day' })).toEqual([rows[2]]);
});

test('supports weighted Quad unions, restricted study dates, additional axes and complete-factor baselines', () => {
  const data = datasets.hourly;
  const combined = calculateBitcoinMatrixCell(data, { quads: [2, 3] });
  const q2 = calculateBitcoinMatrixCell(data, { quads: [2] });
  const q3 = calculateBitcoinMatrixCell(data, { quads: [3] });
  expect(combined.observations).toBe(q2.observations + q3.observations);
  expect(combined.up).toBe(q2.up + q3.up);
  expect(combined.upPct).toBe(100 * combined.up / combined.observations);
  const rows = selectBitcoinMatrixRows(data, { startAt: '2025-09-15T18:00:00Z', endAt: data.endAt,
    years: [2026], hours: [9, 10], weekdays: [1, 2, 3, 4, 5], completeFields: ['quad', 'volume'] });
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.every(row => row.quad && row.volume && row.year === 2026 && [9, 10].includes(row.hour) && row.weekday >= 1 && row.weekday <= 5)).toBe(true);
  const covered = selectBitcoinMatrixRows(data, { completeFields: ['quad', 'volume'] });
  expect(covered.length).toBeLessThan(data.rows.length);
  expect(covered.every(row => row.quad !== null && row.volume !== null)).toBe(true);
});

test('keeps unavailable volatility distinct from empty historical groups and does not silently widen invalid filters', () => {
  const data = datasets.hourly;
  expect(calculateBitcoinMatrixCell(data, { volatility: 'investable' })).toEqual(expect.objectContaining({ status: 'unavailable', observations: 0, pct: null }));
  expect(calculateBitcoinMatrixCell(data, { years: [1999] })).toEqual(expect.objectContaining({ status: 'empty', observations: 0, pct: null }));
  for (const constraints of [{ usdRule: 'invented' }, { quad: 3 }, { quads: [5] }, { hours: [24] }, { volume: 'low' }, { completeFields: ['madeUp'] }]) {
    expect(() => selectBitcoinMatrixRows(data, constraints)).toThrow('unavailable');
  }
});

test('resamples date blocks, keeps unchanged outcomes in the denominator, and marks thin samples', () => {
  const rows = Array.from({ length: 48 }, (_, index) => ({
    startAt: `2025-01-${index < 24 ? '01' : '02'}T${String(index % 24).padStart(2, '0')}:00:00Z`,
    day: index < 24 ? '2025-01-01' : '2025-01-02', direction: index < 24 ? 'UP' : 'DOWN', returnPct: index < 24 ? 1 : -1,
  }));
  const stats = summarizeBitcoinMatrixRows(rows, { interval: true });
  expect(stats.pct95).toEqual([0, 100]);
  expect(stats.limitedSample).toBe(true);
  expect(summarizeBitcoinMatrixRows(rows, { interval: true }).pct95).toEqual(stats.pct95);
  expect(summarizeBitcoinMatrixRows(rows.slice(0, 24), { interval: true }).pct95).toBeNull();
  const unchanged = summarizeBitcoinMatrixRows([...rows, { ...rows[0], direction: 'UNCHANGED', returnPct: 0 }]);
  expect(unchanged.upPct).toBeCloseTo(100 * 24 / 49);
});

test('axis values expose the same filter constraints and label hours in New York time', () => {
  const axes = bitcoinMatrixAxes(datasets.hourly);
  expect(axes.find(axis => axis.id === 'quad').values[2]).toEqual({ id: 'q3', label: 'Quad 3', constraints: { quads: [3] } });
  expect(axes.find(axis => axis.id === 'hour').values[13]).toEqual({ id: '13', label: '13:00', constraints: { hours: [13] } });
  expect(axes.find(axis => axis.id === 'weekday').values[1]).toEqual({ id: '1', label: 'Mon', constraints: { weekdays: [1] } });
  expect(bitcoinMatrixAxes(datasets.daily).some(axis => axis.id === 'hour')).toBe(false);
  expect(bitcoinMatrixAxes(datasets.calendar_day).some(axis => axis.id === 'hour')).toBe(false);
});

test('the year axis preserves years with no signal coverage within the archived New York study window', () => {
  const years = bitcoinMatrixAxes(datasets.hourly).find(axis => axis.id === 'year').values;
  expect(years.map(value => value.id)).toEqual(['2021', '2022', '2023', '2024', '2025', '2026']);
  const uncovered = years.find(value => value.id === '2023');
  expect(calculateBitcoinMatrixCell(datasets.hourly, uncovered.constraints)).toEqual(expect.objectContaining({
    observations: 0, days: 0, pct: null, status: 'empty',
  }));
  const nearUtcBoundary = { ...datasets.hourly, startAt: '2022-01-01T02:00:00Z', endAt: '2023-01-01T02:00:00Z' };
  expect(bitcoinMatrixAxes(nearUtcBoundary).find(axis => axis.id === 'year').values.map(value => value.id)).toEqual(['2021', '2022']);
});
