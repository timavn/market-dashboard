import { buildGdpReleaseHistory, buildGdpComponentComparison, selectGdpPreReleaseForecasts, selectGdpNearbyContracts, selectGdpQuarterEstimates } from './gdpPredictionMarket';
const now = Date.parse('2026-09-10T15:00:00Z');
const reading = (fields = {}) => ({ quarter: '2026-Q2', unit: 'percent_qoq_saar', stage: 'advance', value: 1.5, releasedAt: '2026-07-30T12:30:00Z', sourceUrl: 'https://www.bea.gov/news/gdp', ...fields });
const forecast = (fields = {}) => ({ quarter: '2026-Q2', unit: 'percent_qoq_saar', sourceId: 'gdpnow', targetStage: 'advance', modelType: 'GDPNow', value: 1.8, publishedAt: '2026-07-29', sourceUrl: 'https://www.atlantafed.org/research-and-data/data/gdpnow', ...fields });

describe('Hedgeye quarterly chart estimates', () => {
  const hedgeye = (fields = {}) => forecast({ sourceId: 'hedgeye', quarter: '2026-Q3', value: 4.02,
    sourceUrl: 'https://app.hedgeye.com/feed_items/186614', modelType: 'Nowcast', targetStage: null,
    publishedAt: '2026-08-31', reviewedAt: '2026-09-09', verifiedAt: '2026-09-09', ...fields });

  test('selects the latest reviewed publication per quarter and preserves unknown targets', () => {
    const rows = [hedgeye({ value: 3.95, publishedAt: '2026-08-28' }), hedgeye(),
      hedgeye({ quarter: '2026-Q4', value: 1.46, modelType: 'Enhanced Comparative Base Effects Model' }),
      hedgeye({ quarter: '2027-Q1', value: 1.64 }), forecast({ quarter: '2026-Q3', value: 9 })];
    expect(selectGdpQuarterEstimates(rows, '2026-Q3', now)).toEqual([
      { quarter: '2026-Q3', forecast: expect.objectContaining({ value: 4.02, targetStage: null }) },
      { quarter: '2026-Q4', forecast: expect.objectContaining({ value: 1.46, modelType: 'Enhanced Comparative Base Effects Model' }) },
    ]);
    expect(selectGdpQuarterEstimates([], '2026-Q4', now)).toEqual([
      { quarter: '2026-Q4', forecast: null }, { quarter: '2027-Q1', forecast: null },
    ]);
    expect(selectGdpQuarterEstimates(rows, 'invalid', now)).toEqual([]);
  });

  test.each([
    { publishedAt: null }, { publishedAt: '2026-09-11' }, { reviewedAt: null }, { verifiedAt: null },
    { reviewedAt: '2026-08-01' }, { verifiedAt: '2026-08-01' }, { verifiedAt: '2026-09-11' },
    { unit: 'percent_yoy' }, { metric: 'nominal_gdp' }, { quarter: '2025-Q3' },
    { sourceId: 'consensus' }, { sourceUrl: 'https://example.com/hedgeye' }, { kind: 'reading' },
    { modelType: '' }, { value: null }, { mock: true }, { isMock: true }, { seed: true },
    { seeded: true }, { synthetic: true }, { provenance: 'inferred' },
  ])('omits unverified or incomparable input %j without substituting another source', (bad) => {
    expect(selectGdpQuarterEstimates([hedgeye(bad), forecast({ quarter: '2026-Q3' })], '2026-Q3', now)[0].forecast).toBeNull();
  });
});

test('preserves corrections, release stages, negative growth, and months without releases', () => {
  const first = reading({ value: -0.4 });
  const second = reading({ stage: 'second', value: -0.2, releasedAt: '2026-08-26' });
  const history = buildGdpReleaseHistory({ readingHistory: [first, second, { ...second, value: -0.1, verifiedAt: '2026-08-27' }, reading({ releasedAt: '2026-10-29', quarter: '2026-Q3' })] }, now);
  expect(history.months).toHaveLength(12);
  expect(history.months[0]).toBe('2025-09');
  expect(history.visible.map((r) => r.value)).toEqual([-0.4, -0.1]);
  expect(history.visible[0].latest).toBe(false);
  expect(history.visible[1].latest).toBe(true);
  expect(history.latest.get('2026-Q2').value).toBe(-0.1);
  expect(history.first.get('2026-Q2').value).toBe(-0.4);
});

test('two actual April releases keep their own quarter identities and complete release slots', () => {
  const history = buildGdpReleaseHistory({ readingHistory: [
    reading({ quarter: '2025-Q4', stage: 'third', value: 0.5, releasedAt: '2026-04-09' }),
    reading({ quarter: '2026-Q1', value: 2.0, releasedAt: '2026-04-30' }),
  ] }, now);
  expect(history.groups.map((g) => g.quarter)).toEqual(['2025-Q4', '2026-Q1']);
  expect(history.groups[0].slots.map((s) => s.reading?.releasedAt || null)).toEqual([null, null, '2026-04-09']);
  expect(history.groups[1].slots.map((s) => s.reading?.releasedAt || null)).toEqual(['2026-04-30', null, null]);
});

test('completes the boundary quarter and includes verified pending dates without inventing prints', () => {
  const history = buildGdpReleaseHistory({ readingHistory: [
    reading({ quarter: '2025-Q2', value: 3, releasedAt: '2025-07-30' }),
    reading({ quarter: '2025-Q2', stage: 'second', value: 3.3, releasedAt: '2025-08-28' }),
    reading({ quarter: '2025-Q2', stage: 'third', value: 3.8, releasedAt: '2025-09-25' }), reading(),
  ], priorQuarter: { quarter: '2026-Q2', schedule: [{ stage: 'third', releaseAt: '2026-09-30T12:30:00Z', sourceUrl: 'https://www.bea.gov/news/schedule' }] } }, now);
  expect(history.visible.filter((r) => r.quarter === '2025-Q2').map((r) => r.value)).toEqual([3, 3.3, 3.8]);
  expect(history.groups[1].slots[2]).toMatchObject({ stage: 'third', reading: null, pending: true });
  expect(history.rangeStart).toBe('2025-07-30');
  expect(history.rangeEnd).toBe('2026-09-30T12:30:00Z');
  expect(history.latest.get('2026-Q2').stage).toBe('advance');
});

test('does not present another quarter, an undated schedule, or an unofficial date as pending', () => {
  const history = buildGdpReleaseHistory({ readingHistory: [reading()], scheduleHistory: [
    { quarter: '2026-Q3', stage: 'third', releaseAt: '2026-09-30', sourceUrl: 'https://www.bea.gov/news/schedule' },
    { quarter: '2026-Q2', stage: 'third', releaseAt: null, sourceUrl: 'https://www.bea.gov/news/schedule' },
    { quarter: '2026-Q2', stage: 'third', releaseAt: '2026-09-30', sourceUrl: 'https://example.com' },
  ] }, now);
  expect(history.groups[0].slots[2]).toMatchObject({ reading: null, pending: false, scheduled: undefined });
});

test('pre-release estimates cannot look ahead, mix targets or import another quarter', () => {
  const forecasts = [forecast(), forecast({ value: 99, publishedAt: '2026-07-30' }),
    forecast({ value: 98, publishedAt: '2026-07-31' }), forecast({ value: 97, unit: 'percent_yoy' }),
    forecast({ value: 96, quarter: '2026-Q3' }), forecast({ value: 95, publishedAt: null })];
  expect(selectGdpPreReleaseForecasts(forecasts, reading(), now)).toEqual([expect.objectContaining({ value: 1.8, gap: -0.3, matchedTarget: true })]);
  expect(selectGdpPreReleaseForecasts(forecasts, reading({ stage: 'second', releasedAt: '2026-08-26' }), now)[0]).toMatchObject({ gap: null, matchedTarget: false });
  expect(selectGdpPreReleaseForecasts([forecast({ publishedAt: '2026-07-30T12:29:00Z' })], reading(), now)[0].matchedTarget).toBe(true);
  expect(selectGdpPreReleaseForecasts([forecast({ publishedAt: '2026-07-30T12:30:00Z' })], reading(), now)).toEqual([]);
});

test('an unknown reviewed Hedgeye target is visible but has no forecast marker or surprise gap', () => {
  const hedgeye = forecast({ sourceId: 'hedgeye', targetStage: null, sourceUrl: 'https://app.hedgeye.com/feed_items/123', reviewedAt: '2026-07-29', value: 0 });
  expect(selectGdpPreReleaseForecasts([hedgeye], reading({ value: 0 }), now)[0]).toMatchObject({ value: 0, matchedTarget: false, gap: null });
});

test('component comparisons require exact quarter, stage, publication and contribution units', () => {
  const history = buildGdpReleaseHistory({ readingHistory: [reading({ value: 0 }), reading({ stage: 'second', value: -0.1, releasedAt: '2026-08-26' })] }, now);
  const first = history.first.get('2026-Q2'); const latest = history.latest.get('2026-Q2');
  const record = { kind: 'components', metric: 'U.S. real GDP', sourceId: 'bea', sourceUrl: 'https://apps.bea.gov/archive.xlsx', quarter: '2026-Q2', stage: 'advance', releasedAt: '2026-07-30', verifiedAt: '2026-09-09', unit: 'percentage_points', values: { consumption: 0, fixedInvestment: 0, inventories: -0.3, netExports: 0.2, government: 0.1 } };
  const next = { ...record, stage: 'second', releasedAt: '2026-08-26', values: { ...record.values, consumption: -0.1 } };
  expect(buildGdpComponentComparison([record, next], first, latest, now).rows[0]).toMatchObject({ first: 0, latest: -0.1, revision: -0.1 });
  for (const bad of [{ quarter: '2026-Q3' }, { unit: 'percent_qoq_saar' }, { stage: 'third' }, { releasedAt: '2026-08-25' }, { verifiedAt: null }, { sourceUrl: 'https://example.com/values' }, { mock: true }]) {
    expect(buildGdpComponentComparison([record, { ...next, ...bad }], first, latest, now).rows[0].latest).toBeNull();
  }
});

test('compact ladder centers six real thresholds around zero, negative or positive forecasts', () => {
  const rows = Array.from({ length: 18 }, (_, i) => ({ threshold: -4 + i * 0.5 }));
  expect(selectGdpNearbyContracts(rows, 4.02).map((r) => r.threshold)).toEqual([2, 2.5, 3, 3.5, 4, 4.5]);
  expect(selectGdpNearbyContracts(rows, 0)).toContain(rows[8]);
  expect(selectGdpNearbyContracts(rows, -3.8)).toHaveLength(6);
});
