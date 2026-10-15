const {
  supportsCftcSnapshotVersion, hasInvalidCftcProvenance,
  isVerifiedCftcSnapshot, selectCftcSeriesRow,
} = require('./cftcSnapshot.cjs');

const LEGACY = 'legacy-noncommercial-combined';
const MANAGED = 'disaggregated-managed-money-combined';
const series = { code: '084691', seriesType: MANAGED };
const row = (overrides = {}) => ({
  metric: 'SILVER', cftcContractMarketCode: '084691', seriesType: LEGACY,
  asOf: '2026-09-08', status: 'current', decisionEligible: true,
  latest: 24736, wwChg: -500, zScore1Y: -0.41, zScore3Y: -0.89,
  ...overrides,
});
const alternate = (overrides = {}) => row({
  seriesType: MANAGED, latest: 14176, wwChg: 2006, zScore1Y: -0.13, zScore3Y: -0.68,
  ...overrides,
});
const snapshot = (overrides = {}) => ({
  snapshotType: 'cftc-positioning', schemaVersion: 'cftc-positioning-v3',
  calculationVersion: 'cftc-combined-net-sample-z-v2',
  source: 'cftc-public-reporting-environment', sourceContentHash: 'a'.repeat(64),
  datasetIds: { legacy: 'srt6-5q2f', disaggregated: 'rxbv-e226' },
  date: '2026-09-08', reportDate: '2026-09-08', decisionEligible: true,
  data: [row({ alternateSeries: [alternate()] })], ...overrides,
});

describe('CFTC snapshot version and cohort contract', () => {
  test.each([
    ['cftc-positioning-v2', 'cftc-combined-net-sample-z-v1', true],
    ['cftc-positioning-v3', 'cftc-combined-net-sample-z-v2', true],
    ['cftc-positioning-v2', 'cftc-combined-net-sample-z-v2', false],
    ['cftc-positioning-v3', 'cftc-combined-net-sample-z-v1', false],
    ['cftc-positioning-v4', 'cftc-combined-net-sample-z-v2', false],
    [null, null, false],
  ])('checks exact version pair %s / %s', (schemaVersion, calculationVersion, expected) => {
    expect(supportsCftcSnapshotVersion({ schemaVersion, calculationVersion })).toBe(expected);
  });

  test('selects the exact cohort from primary or alternate rows', () => {
    expect(selectCftcSeriesRow(snapshot(), series)).toEqual(alternate());
    expect(selectCftcSeriesRow(snapshot(), { ...series, seriesType: LEGACY })).toMatchObject({ latest: 24736 });
    expect(selectCftcSeriesRow(snapshot({
      schemaVersion: 'cftc-positioning-v2', calculationVersion: 'cftc-combined-net-sample-z-v1',
      data: [alternate()],
    }), series)).toEqual(alternate());
  });

  test('does not borrow another cohort or accept a duplicate exact cohort', () => {
    expect(selectCftcSeriesRow(snapshot({ data: [row()] }), series)).toBeNull();
    expect(selectCftcSeriesRow(snapshot({ data: [row({ alternateSeries: [alternate(), alternate()] })] }), series)).toBeNull();
    expect(selectCftcSeriesRow(snapshot({ data: [row({ alternateSeries: [alternate()] }), alternate()] }), series)).toBeNull();
    expect(selectCftcSeriesRow(snapshot({ data: [alternate({ alternateSeries: [alternate({ cacheOnly: true })] })] }), series)).toBeNull();
    expect(selectCftcSeriesRow(snapshot({
      schemaVersion: 'cftc-positioning-v2', calculationVersion: 'cftc-combined-net-sample-z-v1',
    }), series)).toBeNull();
  });

  test('validates explicit series identity against contract code and cohort', () => {
    const valid = alternate({ seriesId: `084691:${MANAGED}` });
    expect(selectCftcSeriesRow(snapshot({ data: [row({ alternateSeries: [valid] })] }), series)).toEqual(valid);
    [null, `084691:${LEGACY}`, `088691:${MANAGED}`].forEach((seriesId) => {
      expect(selectCftcSeriesRow(snapshot({ data: [row({ alternateSeries: [alternate({ seriesId })] })] }), series)).toBeNull();
      expect(selectCftcSeriesRow(snapshot({ data: [alternate({ seriesId })] }), series)).toBeNull();
    });
    expect(selectCftcSeriesRow(snapshot({ data: [row({ seriesId: `088691:${LEGACY}`, alternateSeries: [valid] })] }), series)).toBeNull();
  });

  test.each([
    { source: 'manual' }, { mock: true }, { seeded: true }, { isSeed: true }, { cacheOnly: true },
    { sourceVerified: false }, { status: 'unverified' },
    { cachedOnly: true }, { fromCache: true }, { status: 'offline' },
    { sourceStatus: 'disconnected' }, { cacheState: 'stale' }, { error: 'refresh failed' },
    { reportDate: '2026-09-01' }, { date: '2026-02-30', reportDate: '2026-02-30' },
    { datasetIds: { legacy: 'wrong' } }, { sourceContentHash: null },
    { calculationVersion: 'cftc-combined-net-sample-z-v1' },
  ])('rejects invalid parent provenance: %j', (overrides) => {
    expect(isVerifiedCftcSnapshot(snapshot(overrides))).toBe(false);
    expect(selectCftcSeriesRow(snapshot(overrides), series)).toBeNull();
  });

  test.each([
    { source: 'hedgeye' }, { mock: true }, { seeded: true }, { cachedOnly: true },
    { sourceStatus: 'disconnected' }, { cacheState: 'stale' }, { status: 'offline' },
    { asOf: '2026-09-01' }, { datasetId: 'srt6-5q2f' },
    { decisionEligible: false }, { status: 'partial' },
  ])('rejects invalid alternate provenance: %j', (overrides) => {
    expect(selectCftcSeriesRow(snapshot({ data: [row({ alternateSeries: [alternate(overrides)] })] }), series)).toBeNull();
  });

  test('validates wrapper identity and relevant dataset before using an alternate', () => {
    const invalidWrappers = [
      { cftcContractMarketCode: '088691' }, { asOf: '2026-09-01' }, { source: 'manual' },
      { mock: true }, { sourceStatus: 'disconnected' },
    ];
    invalidWrappers.forEach((overrides) => {
      expect(selectCftcSeriesRow(snapshot({ data: [row({ ...overrides, alternateSeries: [alternate()] })] }), series)).toBeNull();
    });
    expect(selectCftcSeriesRow(snapshot({ datasetIds: { legacy: 'srt6-5q2f' } }), series)).toBeNull();
  });

  test('historical reference mode permits aging but never fabricated or failed source metadata', () => {
    expect(hasInvalidCftcProvenance({ cacheState: 'stale' })).toBe(true);
    expect(hasInvalidCftcProvenance({ cacheState: 'stale' }, { allowHistorical: true })).toBe(false);
    [{ mock: true }, { seed: true }, { cacheOnly: true }, { sourceStatus: 'disconnected' }].forEach((value) => {
      expect(hasInvalidCftcProvenance(value, { allowHistorical: true })).toBe(true);
    });
  });
});
