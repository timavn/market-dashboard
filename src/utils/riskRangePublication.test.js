const {
  applyPersistedManifestGate,
  buildRiskRangeEnvelope,
  expectedRiskRangePublication,
  normalizeRiskRangeItem,
  riskRangeManifestChecksum,
} = require('./riskRangePublication.cjs');

function primary(ticker, date = '2026-07-17', overrides = {}) {
  return {
    ticker,
    date,
    lrr: 100,
    hrr: 110,
    trend: 'BULLISH',
    source: 'hedgeye-risk-ranges-email',
    updatedAt: `${date}T11:13:53Z`,
    ...overrides,
  };
}

function supplement(ticker, date = '2026-07-17', overrides = {}) {
  return primary(ticker, date, {
    source: 'hedgeye-early-look-email',
    ...overrides,
  });
}

describe('risk range publication envelope', () => {
  test('preserves the published instrument name independently of its catalog ticker', () => {
    const rows = [primary('GLD', '2026-07-21', {
      name: 'Gold Spot Price', lrr: 4250, hrr: 4424, prevClose: 4421, trend: 'NEUTRAL',
    })];
    const envelope = buildRiskRangeEnvelope(rows, {
      now: new Date('2026-07-21T17:00:00Z'), minPrimaryCount: 1,
    });
    expect(envelope.ranges.GLD).toMatchObject({
      originalName: 'Gold Spot Price', lrr: 4250, hrr: 4424, trend: 'NEUTRAL',
    });
    expect(normalizeRiskRangeItem(primary('GLD', '2026-07-21', {
      originalName: ' Gold Spot Price ', name: 'An unrelated alias',
    })).value.originalName).toBe('Gold Spot Price');
    expect(normalizeRiskRangeItem(primary('GLD')).value).not.toHaveProperty('originalName');
    expect(riskRangeManifestChecksum(rows, '2026-07-21')).toBe(
      riskRangeManifestChecksum(rows.map(({ name, ...row }) => row), '2026-07-21'),
    );
  });

  test('keeps Early Look-only tickers out of decision ranges', () => {
    const rows = [
      supplement('SPX', '2026-07-21', { lrr: 1, hrr: 2 }),
      primary('SPX', '2026-07-21', { lrr: 6000, hrr: 6100, prevClose: 6042 }),
      supplement('UST10Y', '2026-07-21', { lrr: 4.1, hrr: 4.3 }),
    ];
    const envelope = buildRiskRangeEnvelope(rows, {
      now: new Date('2026-07-21T17:00:00Z'),
      minPrimaryCount: 1,
    });

    expect(envelope.status).toBe('current');
    expect(envelope.available).toBe(true);
    expect(envelope.ranges.SPX).toMatchObject({
      lrr: 6000, hrr: 6100, previousClose: 6042, provenance: 'primary',
    });
    expect(envelope.ranges.UST10Y).toBeUndefined();
    expect(envelope.supplementalRanges.UST10Y).toMatchObject({
      lrr: 4.1,
      hrr: 4.3,
      provenance: 'supplemental',
      decisionEligible: false,
    });
    expect(envelope.supplementalRanges.SPX).toBeUndefined();
    expect(envelope.manifest).toMatchObject({
      primaryCount: 1,
      supplementalCount: 2,
      mergedCount: 2,
      decisionRangeCount: 1,
      supplementalOnlyCount: 1,
      parserVersion: 'risk-range-envelope-v2',
    });
  });

  test('never coerces invalid or missing values to zero', () => {
    expect(normalizeRiskRangeItem(primary('SPX', '2026-07-21', { lrr: 'not-a-number' }))).toMatchObject({
      valid: false,
      reasons: expect.arrayContaining(['invalid-lrr']),
    });
    expect(normalizeRiskRangeItem(primary('SPX', '2026-07-21', { lrr: '   ' }))).toMatchObject({
      valid: false,
      reasons: expect.arrayContaining(['invalid-lrr']),
    });
    expect(normalizeRiskRangeItem(primary('SPX', '2026-07-21', { lrr: false }))).toMatchObject({
      valid: false,
      reasons: expect.arrayContaining(['invalid-lrr']),
    });
    expect(normalizeRiskRangeItem(primary('SPX', '2026-07-21', { hrr: null }))).toMatchObject({
      valid: false,
      reasons: expect.arrayContaining(['invalid-hrr']),
    });
    expect(normalizeRiskRangeItem(primary('SPX', '2026-07-21', { lrr: 120, hrr: 110 }))).toMatchObject({
      valid: false,
      reasons: expect.arrayContaining(['inverted-range']),
    });
  });

  test('reports pending before the market-day deadline and does not expose yesterday as current', () => {
    const envelope = buildRiskRangeEnvelope([primary('SPX', '2026-07-20')], {
      now: new Date('2026-07-21T11:00:00Z'),
      minPrimaryCount: 1,
    });

    expect(envelope).toMatchObject({
      available: false,
      status: 'pending',
      ranges: {},
      manifest: { publicationDate: '2026-07-20', expectedDate: '2026-07-20', pendingDate: '2026-07-21' },
    });
  });

  test('fails stale after the deadline when today publication is missing', () => {
    const envelope = buildRiskRangeEnvelope([primary('SPX', '2026-07-20')], {
      now: new Date('2026-07-21T17:00:00Z'),
      minPrimaryCount: 1,
    });

    expect(envelope).toMatchObject({
      available: false,
      status: 'stale',
      ranges: {},
      manifest: { expectedDate: '2026-07-21', pendingDate: null },
    });
  });

  test('accepts Friday publication as current through a weekend', () => {
    const envelope = buildRiskRangeEnvelope([primary('SPX', '2026-07-17')], {
      now: new Date('2026-07-19T17:00:00Z'),
      minPrimaryCount: 1,
    });

    expect(envelope.status).toBe('current');
    expect(envelope.available).toBe(true);
    expect(envelope.manifest.expectedDate).toBe('2026-07-17');
  });

  test('uses the US market holiday calendar for expected publication dates', () => {
    expect(expectedRiskRangePublication(new Date('2026-07-03T17:00:00Z'))).toMatchObject({
      expectedDate: '2026-07-02',
      marketDay: false,
    });
  });

  test('fails closed when primary coverage is below its configured floor', () => {
    const envelope = buildRiskRangeEnvelope([primary('SPX', '2026-07-21')], {
      now: new Date('2026-07-21T17:00:00Z'),
      minPrimaryCount: 30,
    });

    expect(envelope).toMatchObject({ available: false, status: 'invalid', ranges: {} });
    expect(envelope.manifest).toMatchObject({ primaryCount: 1, minimumPrimaryCount: 30 });
  });

  test('supports explicitly requested historical publications without labeling them current', () => {
    const envelope = buildRiskRangeEnvelope([primary('SPX', '2026-07-17')], {
      now: new Date('2026-07-21T17:00:00Z'),
      requestedDate: '2026-07-17',
      minPrimaryCount: 1,
    });

    expect(envelope).toMatchObject({ available: true, status: 'historical' });
    expect(envelope.ranges.SPX).toBeDefined();
  });

  test('requires a complete matching persisted manifest for the active surface', () => {
    const rows = [
      primary('SPX', '2026-07-21'),
      supplement('UST10Y', '2026-07-21'),
    ];
    const envelope = buildRiskRangeEnvelope(rows, {
      now: new Date('2026-07-21T17:00:00Z'),
      minPrimaryCount: 1,
    });
    const manifest = {
      publicationDate: '2026-07-21',
      manifestType: 'primary',
      completionState: 'complete',
      count: 1,
      checksum: riskRangeManifestChecksum(rows, '2026-07-21'),
      parserVersion: 'risk-range-email-v2',
    };

    const gated = applyPersistedManifestGate(envelope, rows, manifest, {
      expectedDate: '2026-07-21',
      pendingDate: null,
      afterDeadline: true,
    });

    expect(gated).toMatchObject({
      available: true,
      status: 'current',
      manifest: { persistedManifestVerified: true },
    });
    expect(gated.ranges.SPX).toBeDefined();
    expect(gated.ranges.UST10Y).toBeUndefined();
    expect(gated.supplementalRanges.UST10Y).toMatchObject({ decisionEligible: false });
  });

  test('accepts the equivalent parser-v3 checksum after DynamoDB normalizes integral decimals', () => {
    const rows = [
      primary('SPX', '2026-07-21', { lrr: 6000, hrr: 6100 }),
      primary('VIX', '2026-07-21', { lrr: 18.5, hrr: 21.5 }),
    ];
    const envelope = buildRiskRangeEnvelope(rows, {
      now: new Date('2026-07-21T17:00:00Z'),
      minPrimaryCount: 1,
    });
    const manifest = {
      publicationDate: '2026-07-21',
      manifestType: 'primary',
      completionState: 'complete',
      count: 2,
      checksum: riskRangeManifestChecksum(rows, '2026-07-21', {
        numericFormat: 'python-float-v3',
      }),
      parserVersion: 'risk-range-email-v3',
    };

    const gated = applyPersistedManifestGate(envelope, rows, manifest, {
      expectedDate: '2026-07-21',
      pendingDate: null,
      afterDeadline: true,
    });

    expect(gated).toMatchObject({
      available: true,
      status: 'current',
      manifest: { persistedManifestVerified: true },
    });
  });

  test('reports failed after deadline when the persisted manifest is missing or corrupt', () => {
    const rows = [
      primary('SPX', '2026-07-21'),
      supplement('UST10Y', '2026-07-21'),
    ];
    const envelope = buildRiskRangeEnvelope(rows, {
      now: new Date('2026-07-21T17:00:00Z'),
      minPrimaryCount: 1,
    });
    const gated = applyPersistedManifestGate(envelope, rows, null, {
      expectedDate: '2026-07-21',
      pendingDate: null,
      afterDeadline: true,
      manifestError: 'AccessDeniedException',
    });

    expect(gated).toMatchObject({
      available: false,
      status: 'failed',
      ranges: {},
      supplementalRanges: {},
    });
    expect(gated.diagnostics.manifestReasons).toEqual(expect.arrayContaining([
      'manifest-unavailable',
      'manifest-missing',
    ]));
  });

  test('serves the verified valid subset while preserving the disputed source values', () => {
    const now = new Date('2026-07-21T17:00:00Z');
    const valid = primary('SPX', '2026-07-21');
    const rows = [valid, primary('RUT', '2026-07-21', { lrr: 2834, hrr: 2825 })];
    const sourceQuality = { status: 'discrepancy', issues: [{ ticker: 'RUT', field: 'riskRange',
      observed: { lrr: 2834, hrr: 2825 } }] };
    const manifest = { publicationDate: '2026-07-21', manifestType: 'primary', completionState: 'complete',
      count: 1, checksum: riskRangeManifestChecksum([valid], '2026-07-21'), sourceQuality };
    const envelope = buildRiskRangeEnvelope(rows, { now });
    expect(envelope.available).toBe(false);
    const result = applyPersistedManifestGate(envelope, rows, manifest, { now, expectedDate: '2026-07-21', afterDeadline: true });
    expect(result.available).toBe(true);
    expect(Object.keys(result.ranges)).toEqual(['SPX']);
    expect(result.sourceQuality).toEqual(sourceQuality);
    expect(applyPersistedManifestGate(envelope, rows, { ...manifest, checksum: 'wrong' }, {
      now, expectedDate: '2026-07-21', afterDeadline: true,
    }).available).toBe(false);
  });

  test('does not substitute a prior same-day range for a newly disputed range', () => {
    const now = new Date('2026-07-21T17:00:00Z');
    const rows = [primary('SPX', '2026-07-21'), primary('RUT', '2026-07-21')];
    const manifest = { publicationDate: '2026-07-21', manifestType: 'primary', completionState: 'complete', count: 1,
      checksum: riskRangeManifestChecksum(rows.slice(0, 1), '2026-07-21'),
      sourceQuality: { status: 'discrepancy', issues: [{ ticker: 'RUT', field: 'riskRange' }] } };
    const result = applyPersistedManifestGate(buildRiskRangeEnvelope(rows, { now }), rows, manifest, {
      now, expectedDate: '2026-07-21', afterDeadline: true,
    });
    expect(Object.keys(result.ranges)).toEqual(['SPX']);
  });

  test('one invalid historical reading does not hide independent verified historical ranges', () => {
    const result = buildRiskRangeEnvelope([
      primary('SPX', '2026-07-21'), primary('RUT', '2026-07-21', { lrr: 2834, hrr: 2825 }),
    ], { requestedDate: '2026-07-21' });
    expect(result.status).toBe('historical');
    expect(Object.keys(result.ranges)).toEqual(['SPX']);
    expect(result.diagnostics.invalid).toEqual([expect.objectContaining({ ticker: 'RUT' })]);
  });
});
