import { getCftcHighlightRows, getCftcReportDate } from './cftcHighlights';

const row = (metric, zScore1Y, overrides = {}) => ({
  metric, zScore1Y, asOf: '2026-09-08', status: 'current', ...overrides,
});
const snapshot = (data, overrides = {}) => ({
  schemaVersion: 'cftc-positioning-v3', calculationVersion: 'cftc-combined-net-sample-z-v2',
  reportDate: '2026-09-08', source: 'cftc-public-reporting-environment', data, ...overrides,
});

describe('CFTC positioning highlights', () => {
  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-13T12:00:00Z'));
  });

  afterEach(() => jest.restoreAllMocks());

  test('selects eleven largest absolute 1Y Z-scores with alphabetical ties without changing the report order', () => {
    const rows = [
      row('Small', 0.2, { zScore3Y: 10 }), row('Positive', 2.1), row('Negative', -3.5),
      row('Zulu', 2.5), row('Alpha', -2.5), row('Six', 1.7), row('Seven', -1.4),
      row('Eight', 1.1), row('Nine', -0.9), row('Zero', 0),
      row('Moderate', 0.6), row('Lower', -0.4),
    ];
    const original = [...rows];

    expect(getCftcHighlightRows(snapshot(rows)).map(({ metric }) => metric))
      .toEqual(['Negative', 'Alpha', 'Zulu', 'Positive', 'Six', 'Seven', 'Eight', 'Nine', 'Moderate', 'Lower', 'Small']);
    expect(rows).toEqual(original);
  });

  test('omits missing/nonfinite scores without padding and accepts zero or a valid numeric string', () => {
    const invalid = [null, undefined, '', '  ', NaN, Infinity, -Infinity, 'NaN', 'Infinity', true, [], {}];
    expect(getCftcHighlightRows(snapshot([
      ...invalid.map((score, index) => row(`Invalid ${index}`, score)),
      row('Zero', 0), row('Numeric string', '-1.20'),
    ])).map(({ metric }) => metric)).toEqual(['Numeric string', 'Zero']);
  });

  test('retains a valid 1Y score when only the longer window is incomplete', () => {
    const partial = row('Partial history', 2.1, { status: 'partial', zScore3Y: null, decisionEligible: false });
    expect(getCftcHighlightRows(snapshot([partial], { contentComplete: false }))).toEqual([partial]);
  });

  test('ranks only primary rows even when an alternate has a more extreme score', () => {
    const silver = row('SILVER', -0.41, { alternateSeries: [row('Silver managed money', -9)] });
    const corn = row('Corn', 2.25);
    expect(getCftcHighlightRows(snapshot([silver, corn]))).toEqual([corn, silver]);
  });

  test('continues to accept dated v2 snapshots with their matching calculation version', () => {
    const silver = row('SILVER', -0.13);
    expect(getCftcHighlightRows(snapshot([silver], {
      schemaVersion: 'cftc-positioning-v2', calculationVersion: 'cftc-combined-net-sample-z-v1',
    }))).toEqual([silver]);
  });

  test.each([
    ['unavailable', { status: 'unavailable' }], ['discontinued', { status: 'discontinued' }],
    ['stale row', { status: 'stale' }], ['offline', { status: 'offline' }],
    ['old report', { asOf: '2026-09-01' }], ['missing date', { asOf: null }],
    ['seed', { seeded: true }], ['mock', { source: 'mock' }],
    ['cache-only', { cacheOnly: true }], ['missing asset', { metric: '' }],
  ])('excludes %s rows from ranking', (_label, overrides) => {
    expect(getCftcHighlightRows(snapshot([row('Invalid', 9, overrides)]))).toEqual([]);
  });

  test.each([
    ['unverified source', { source: 'hedgeye' }], ['missing source', { source: null }],
    ['mock', { mock: true }], ['seed', { seeded: true }],
    ['cache-only', { cacheOnly: true }], ['cache-only state', { cacheState: 'cache-only' }],
    ['offline', { status: 'offline' }], ['disconnected', { sourceStatus: 'disconnected' }],
    ['invalid date', { reportDate: '2026-02-30' }], ['future date', { reportDate: '2026-09-15' }],
    ['missing date', { reportDate: null }],
    ['mismatched schema/calculation', { calculationVersion: 'cftc-combined-net-sample-z-v1' }],
  ])('excludes reports with %s', (_label, overrides) => {
    expect(getCftcHighlightRows(snapshot([row('Invalid', 9)], overrides))).toEqual([]);
  });

  test('keeps a dated official historical report available for explicitly labeled reference display', () => {
    const dated = row('Dated report', -2.4, { asOf: '2026-08-25' });
    expect(getCftcHighlightRows(snapshot([dated], { reportDate: '2026-08-25', cacheState: 'stale' })))
      .toEqual([dated]);
  });

  test('uses the report observation date ahead of the response date', () => {
    expect(getCftcReportDate(snapshot([], { date: '2026-09-13' }))).toBe('2026-09-08');
  });
});
