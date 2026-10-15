const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  GDP_UNIT, GDP_METRIC, normalizeGdpRecord, createGdpRecordStore, validDate,
} = require('./gdpResearchRecords.cjs');
const {
  parseBeaSchedule, parseBeaReading, parseGdpNow, snapshotFromRecords, createGdpResearchService,
  BEA_SCHEDULE_URL, BEA_GDP_URL, GDPNOW_URL,
} = require('./gdpResearchService.cjs');
const { importReviewedGdpSnapshot } = require('../../../scripts/import_gdp_snapshot.cjs');

const NOW = Date.parse('2026-09-09T19:00:00.000Z');
const VERIFIED = new Date(NOW).toISOString();
const READING_URL = 'https://www.bea.gov/news/2026/gdp-second-estimate-and-corporate-profits-2nd-quarter-2026';
const SCHEDULE = `<table>
  <tr><td>September 30 <small>8:30 AM</small></td><td>GDP (Third Estimate), Industries, Corporate Profits, State GDP, and State Personal Income, 2nd Quarter 2026; State PCE, 2025</td></tr>
  <tr><td>October 29 <small>8:30 AM</small></td><td>GDP (Advance Estimate), 3rd Quarter 2026</td></tr>
  <tr><td>November 25 <small>8:30 AM</small></td><td>GDP (Second Estimate) and Corporate Profits, 3rd Quarter 2026</td></tr>
  <tr><td>December 23 <small>8:30 AM</small></td><td>GDP (Third Estimate), Industries, 3rd Quarter 2026</td></tr>
</table>`;
const READING = `<h1>GDP (Second Estimate) and Corporate Profits, 2nd Quarter 2026</h1>
<p>EMBARGOED UNTIL RELEASE AT 8:30 a.m. EDT, Wednesday, August 26, 2026</p>
<p>Real gross domestic product (GDP) increased at an annual rate of 1.5 percent in the second quarter of 2026 (April, May, and June), according to the second estimate released today.</p>
<p>Current-dollar GDP increased 8.0 percent. GDP price index 5.8 percent.</p>`;
const GDPNOW = `<script>const historical = [3.2,9.5];</script><p>real GDP</p>
<p class="data-value">4.7%%</p><p>Third-Quarter GDPNow Estimate for 2026:Q3</p>
<p><strong>Updated:</strong> September 03, 2026</p><p>Quarterly percent change (SAAR)</p>`;

function forecast(overrides = {}) {
  return {
    kind: 'forecast', sourceId: 'hedgeye', quarter: '2026-Q3', metric: GDP_METRIC, unit: GDP_UNIT,
    value: 4.02, modelType: 'Hedgeye US GDP Growth Nowcast', publishedAt: '2026-08-31T14:21:00.000Z',
    targetStage: null, sourceUrl: 'https://app.hedgeye.com/feed_items/186614', verifiedAt: VERIFIED, reviewedAt: VERIFIED,
    evidence: 'Reviewed Aug 31 publication gives Q3 real GDP QoQ SAAR 4.02%.', ...overrides,
  };
}

function reading(overrides = {}) {
  return {
    kind: 'reading', sourceId: 'bea', quarter: '2026-Q3', metric: GDP_METRIC, unit: GDP_UNIT,
    stage: 'advance', value: 4.1, releasedAt: '2026-10-29T12:30:00.000Z',
    sourceUrl: 'https://www.bea.gov/news/2026/gdp-advance-estimate-3rd-quarter-2026',
    verifiedAt: '2026-12-24T12:00:00.000Z', ...overrides,
  };
}

test('BEA schedule isolates the measured quarter and preserves Eastern daylight/standard times', () => {
  const records = parseBeaSchedule(SCHEDULE, { verifiedAt: VERIFIED });
  expect(records).toHaveLength(4);
  const snapshot = snapshotFromRecords(records, '2026-Q3', { now: NOW });
  expect(snapshot.schedule.map(({ stage, releaseAt }) => ({ stage, releaseAt }))).toEqual([
    { stage: 'advance', releaseAt: '2026-10-29T12:30:00.000Z' },
    { stage: 'second', releaseAt: '2026-11-25T13:30:00.000Z' },
    { stage: 'third', releaseAt: '2026-12-23T13:30:00.000Z' },
  ]);
  expect(snapshot.priorQuarter.schedule[0]).toMatchObject({ quarter: '2026-Q2', stage: 'third', releaseAt: '2026-09-30T12:30:00.000Z' });
  expect(snapshot.readings).toEqual([]);
});

test('GDPNow reads the dated real quarterly SAAR headline and retains its advance target', () => {
  expect(parseGdpNow(GDPNOW, { verifiedAt: VERIFIED })).toMatchObject({
    sourceId: 'gdpnow', value: 4.7, quarter: '2026-Q3', publishedAt: '2026-09-03', targetStage: 'advance', unit: GDP_UNIT,
  });
  expect(parseGdpNow(GDPNOW.replace('September 03, 2026', ''), { verifiedAt: VERIFIED })).toBeNull();
  expect(parseGdpNow(GDPNOW.replace('Quarterly percent change (SAAR)', 'YoY'), { verifiedAt: VERIFIED })).toBeNull();
  expect(parseGdpNow(GDPNOW.replace('Third-Quarter', 'Fourth-Quarter'), { verifiedAt: VERIFIED })).toBeNull();
});

test('BEA schedule separates Q4 measured year from the following calendar release year', () => {
  const previousQ4 = '<table><tr><td>Year 2026</td></tr><tr><td>January 29 8:30 AM</td><td>GDP (Advance Estimate), 4th Quarter 2025</td></tr></table>';
  const nextQ4 = '<table><tr><td>January 28 8:30 AM</td><td>GDP (Advance Estimate), 4th Quarter 2026</td></tr></table>';
  expect(parseBeaSchedule(previousQ4, { verifiedAt: VERIFIED })[0]).toMatchObject({ quarter: '2025-Q4', releaseAt: '2026-01-29T13:30:00.000Z' });
  expect(parseBeaSchedule(nextQ4, { verifiedAt: VERIFIED })[0]).toMatchObject({ quarter: '2026-Q4', releaseAt: '2027-01-28T13:30:00.000Z' });
  expect(parseBeaSchedule(previousQ4.replace('Year 2026', 'Year 2025'), { verifiedAt: VERIFIED })).toEqual([]);
});

test('official reading identifies the BEA release stage and real annualized growth, not nominal GDP or its price index', () => {
  expect(parseBeaReading(READING, { verifiedAt: VERIFIED, sourceUrl: READING_URL })).toMatchObject({
    quarter: '2026-Q2', stage: 'second', value: 1.5, unit: GDP_UNIT, releasedAt: '2026-08-26T12:30:00.000Z',
  });
  expect(parseBeaReading(READING.replace('in the second quarter', 'in the third quarter'), { verifiedAt: VERIFIED, sourceUrl: READING_URL })).toBeNull();
  expect(parseBeaReading(READING, { verifiedAt: '2026-08-26T12:29:00Z', sourceUrl: READING_URL })).toBeNull();
  expect(parseBeaReading(READING.replace('8:30 a.m. EDT', ''), { verifiedAt: VERIFIED, sourceUrl: READING_URL })).toBeNull();
});

test('BEA parsing supports zero and contraction without deriving numbers from other metrics', () => {
  expect(parseBeaReading(READING.replace('increased at an annual rate of 1.5 percent', 'decreased at an annual rate of 0.5 percent'), { verifiedAt: VERIFIED, sourceUrl: READING_URL }).value).toBe(-0.5);
  expect(parseBeaReading(READING.replace('increased at an annual rate of 1.5 percent', 'was unchanged'), { verifiedAt: VERIFIED, sourceUrl: READING_URL }).value).toBe(0);
});

test.each([
  { publishedAt: null }, { publishedAt: 'September 3' }, { publishedAt: '2026-02-30' },
  { publishedAt: '2026-10-01' }, { reviewedAt: null }, { evidence: '' }, { modelType: '' },
  { quarter: '2026-09' }, { unit: 'percent_yoy' }, { metric: 'Nominal GDP' },
  { sourceUrl: 'https://example.com/hedgeye' }, { targetStage: 'final' },
  { value: null }, { value: '' }, { value: true }, { value: 'NaN' }, { mock: true }, { seed: true },
])('rejects undated, incomparable, or unreviewed forecast input: %o', (patch) => {
  expect(() => normalizeGdpRecord(forecast(patch))).toThrow();
});

test('reviewed forecasts preserve unknown release targets and consensus survey identity', () => {
  expect(normalizeGdpRecord(forecast({ value: 0 }))).toMatchObject({ value: 0, targetStage: null, surveyIdentity: null });
  expect(normalizeGdpRecord(forecast({ value: -0.7 }))).toMatchObject({ value: -0.7 });
  const consensus = normalizeGdpRecord(forecast({ sourceId: 'consensus', sourceUrl: 'https://example.com/dated-survey', modelType: 'Published survey' }));
  expect(consensus).toMatchObject({ surveyIdentity: null, targetStage: null, referenceStatus: 'dated_reference' });
  expect(validDate('2026-08-31T23:21:00-04:00')).toBe('2026-09-01T03:21:00.000Z');
});

test('append-only store preserves revisions and corrected publications, with idempotent imports', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gdp-records-'));
  try {
    const store = createGdpRecordStore({ filePath: path.join(directory, 'records.jsonl') });
    expect(importReviewedGdpSnapshot(forecast(), { store }).added).toBe(1);
    const original = fs.readFileSync(store.filePath, 'utf8');
    expect(importReviewedGdpSnapshot(forecast(), { store }).added).toBe(0);
    store.append([reading(), reading({ stage: 'second', value: 3.8, releasedAt: '2026-11-25T13:30:00.000Z' })]);
    importReviewedGdpSnapshot(forecast({ value: 4.1, verifiedAt: '2026-09-09T20:00:00.000Z' }), { store });
    expect(fs.readFileSync(store.filePath, 'utf8').startsWith(original)).toBe(true);
    expect(createGdpRecordStore({ filePath: store.filePath }).read()).toHaveLength(4);
    expect(snapshotFromRecords(store.read(), '2026-Q3', { now: Date.parse('2026-12-24') }).forecasts[0].value).toBe(4.1);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('October first reading cannot populate third reading or switch the selected quarter', () => {
  const records = [reading(), reading({ stage: 'second', value: 4, releasedAt: '2026-11-25T13:30:00.000Z' }), reading({ stage: 'third', value: 3.9, releasedAt: '2026-12-23T13:30:00.000Z' })].map(normalizeGdpRecord);
  const october = snapshotFromRecords(records, '2026-Q3', { now: Date.parse('2026-10-30') });
  expect(october.readings.map((record) => record.stage)).toEqual(['advance']);
  expect(october.comparison).toMatchObject({ settlementStage: 'third', operator: '>' });
  const december = snapshotFromRecords(records, '2026-Q3', { now: Date.parse('2026-12-24') });
  expect(december.quarter).toBe('2026-Q3');
  expect(december.readings.map((record) => record.value)).toEqual([4.1, 4, 3.9]);
});

test('later-quarter enhanced base-effects forecasts remain separate from the selected-quarter board', () => {
  const records = [forecast(), forecast({ quarter: '2026-Q4', value: 2.5, modelType: 'Enhanced Comparative Base Effects Model' })].map(normalizeGdpRecord);
  const snapshot = snapshotFromRecords(records, '2026-Q3', { now: NOW });
  expect(snapshot.forecasts).toHaveLength(1);
  expect(snapshot.forecasts[0].quarter).toBe('2026-Q3');
  expect(snapshot.futureForecasts).toHaveLength(1);
  expect(snapshot.futureForecasts[0].modelType).toBe('Enhanced Comparative Base Effects Model');
});

test('reviewed CLI dry run is atomic and rejects official-source or mixed invalid imports', () => {
  const store = createGdpRecordStore({ filePath: null });
  expect(importReviewedGdpSnapshot(forecast(), { store, dryRun: true })).toEqual({ valid: 1, added: 0 });
  expect(store.read()).toEqual([]);
  expect(() => importReviewedGdpSnapshot([forecast(), forecast({ publishedAt: null })], { store })).toThrow();
  expect(() => importReviewedGdpSnapshot(reading(), { store })).toThrow();
  expect(store.read()).toEqual([]);
});

test('a fresh checkout includes the reviewed dated Hedgeye reference without a runtime ledger or network', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gdp-new-checkout-'));
  const filePath = path.join(directory, 'records.jsonl');
  try {
    const service = createGdpResearchService({
      filePath, now: () => new Date('2026-09-10T18:00:00.000Z'), fetchText: async () => { throw new Error('offline'); },
    });
    const snapshot = await service.getSnapshot();
    expect(fs.existsSync(filePath)).toBe(false);
    expect(snapshot.forecasts.find((record) => record.sourceId === 'hedgeye')).toMatchObject({
      value: 4.02, publishedAt: '2026-08-31T14:21:00.000Z', targetStage: null, referenceStatus: 'dated_reference', latestPublicationConfirmed: false,
    });
    expect(snapshot.forecasts.some((record) => record.sourceId === 'consensus')).toBe(false);
    expect(snapshot.futureForecasts.find((record) => record.sourceId === 'hedgeye' && record.quarter === '2026-Q4')).toMatchObject({
      value: 1.46, unit: GDP_UNIT, modelType: 'Enhanced Comparative Base Effects Model',
      publishedAt: '2026-08-31T14:21:00.000Z', targetStage: null, latestPublicationConfirmed: false,
      evidenceSha256: '2c1893a2993eb12eb19cb4f261dd6ea6d1f795b6c50b4ced08cc47b8d3d71f1b',
    });
    expect(snapshot.readings).toEqual([]);
    expect(snapshot.sourceStatus.every((source) => source.status === 'unavailable')).toBe(true);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('automatic loaders refresh once per hour and preserve research during source outage independently of quotes', async () => {
  let clock = NOW;
  let offline = false;
  const pages = { [BEA_SCHEDULE_URL]: SCHEDULE, [BEA_GDP_URL]: `<a href="${READING_URL}">GDP (Second Estimate), 2nd Quarter 2026</a>`, [READING_URL]: READING, [GDPNOW_URL]: GDPNOW };
  const fetchText = jest.fn(async (url) => {
    if (offline) throw new Error('offline');
    if (!pages[url]) throw new Error('unknown URL');
    return pages[url];
  });
  const store = createGdpRecordStore({ filePath: null, initialRecords: [forecast()] });
  const service = createGdpResearchService({ store, fetchText, now: () => new Date(clock) });
  const first = await service.getSnapshot();
  expect(first.sourceStatus.every((source) => source.status === 'verified')).toBe(true);
  expect(first.forecasts.map((record) => record.sourceId)).toEqual(['hedgeye', 'gdpnow']);
  expect(first.schedule).toHaveLength(3);
  expect(first.readings).toEqual([]);
  expect(first.priorQuarter.readings[0].value).toBe(1.5);
  await service.getSnapshot();
  expect(fetchText).toHaveBeenCalledTimes(4);
  offline = true;
  clock += 60 * 60_000;
  const failed = await service.getSnapshot();
  expect(failed.sourceStatus.every((source) => source.status === 'unavailable')).toBe(true);
  expect(failed.forecasts).toEqual(first.forecasts);
  expect(failed.status).toBe('research_reference');
  expect(failed).not.toHaveProperty('quotes');
  expect(failed.schedule).toEqual(first.schedule);
  importReviewedGdpSnapshot(forecast({ value: 4.2, publishedAt: '2026-09-09', verifiedAt: new Date(clock).toISOString() }), { store });
  expect((await service.getSnapshot()).forecasts[0].value).toBe(4.2);
});
