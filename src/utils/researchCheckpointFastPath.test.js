const {
  createEtfProCheckpoint,
} = require('./etfProCheckpoint.cjs');
const {
  createRtaCheckpoint,
} = require('./rtaCheckpoint.cjs');
const {
  buildEtfProCheckpointFirstResponse,
  buildRtaCheckpointFirstResponse,
} = require('./researchCheckpointFastPath.cjs');

const CAPTURED_AT = '2026-07-27T02:20:06.000Z';
const FRESH_NOW = new Date('2026-07-27T03:20:06.000Z');
const EXPIRED_NOW = new Date('2026-07-29T03:20:06.000Z');

function createRtaFixture() {
  return createRtaCheckpoint({
    capturedAt: CAPTURED_AT,
    asOf: CAPTURED_AT,
    capturePrecision: 'exact',
    source: 'manual-official-rta-board',
    sourceArtifact: 'repository-artifact:test-rta-checkpoint.json',
    longs: ['RSI', 'DDOG', 'BUG', 'CRWD'],
    shorts: ['HSY', 'HCA', 'SUJA'],
    notes: ['User-verified official board.'],
  });
}

function createEtfFixture() {
  const rows = [
    ...Array.from({ length: 24 }, (_, index) => ({
      ticker: `L${String(index + 1).padStart(2, '0')}`,
      etf: `Long fund ${index + 1}`,
      call: 'Long',
      dateAdded: '2026-07-26',
    })),
    ...Array.from({ length: 13 }, (_, index) => ({
      ticker: `S${String(index + 1).padStart(2, '0')}`,
      etf: `Short fund ${index + 1}`,
      call: 'Short',
      dateAdded: '2026-07-26',
    })),
  ];
  return createEtfProCheckpoint({
    capturedAt: CAPTURED_AT,
    asOf: CAPTURED_AT,
    capturePrecision: 'exact',
    source: 'manual-official-etf-pro-board',
    sourceArtifact: 'repository-artifact:test-etf-pro-checkpoint.json',
    rows,
    expectedLongCount: 24,
    expectedShortCount: 13,
    notes: ['User-verified official board.'],
  });
}

describe('research checkpoint fast path', () => {
  test('returns the exact verified RTA 4/3 baseline without remote evidence', () => {
    const response = buildRtaCheckpointFirstResponse(createRtaFixture(), {
      now: FRESH_NOW,
    });
    expect(response).toMatchObject({
      available: true,
      current: true,
      comparisonSafe: true,
      referenceOnly: false,
      longCount: 4,
      shortCount: 3,
      dataAvailability: {
        verificationMode: 'manual-official-checkpoint',
        ingestionVerified: false,
        checkpointVerified: true,
        checkpointCurrent: true,
        authoritativeRevalidationStatus: 'pending',
      },
    });
    expect(response.holdings).toHaveLength(7);
  });

  test('returns the exact verified ETF Pro 24/13 baseline without remote evidence', () => {
    const response = buildEtfProCheckpointFirstResponse(createEtfFixture(), {
      now: FRESH_NOW,
    });
    expect(response).toMatchObject({
      available: true,
      current: true,
      comparisonSafe: true,
      referenceOnly: false,
      longCount: 24,
      shortCount: 13,
      dataAvailability: {
        verificationMode: 'manual-official-checkpoint',
        ingestionVerified: false,
        checkpointVerified: true,
        checkpointCurrent: true,
        authoritativeRevalidationStatus: 'pending',
      },
      meta: {
        longCount: 24,
        shortCount: 13,
        authoritativeRevalidationStatus: 'pending',
      },
    });
    expect(response.rows).toHaveLength(37);
  });

  test('rejects tampered checkpoints before they can enter the fast path', () => {
    const tamperedRta = {
      ...createRtaFixture(),
      longs: ['RSI', 'DDOG', 'BUG', 'CRWD', 'TAMP'],
    };
    const tamperedEtf = {
      ...createEtfFixture(),
      rows: createEtfFixture().rows.slice(1),
    };
    expect(buildRtaCheckpointFirstResponse(tamperedRta, {
      now: FRESH_NOW,
    })).toBeNull();
    expect(buildEtfProCheckpointFirstResponse(tamperedEtf, {
      now: FRESH_NOW,
    })).toBeNull();
  });

  test('never marks an expired checkpoint current or comparison-safe', () => {
    expect(buildRtaCheckpointFirstResponse(createRtaFixture(), {
      now: EXPIRED_NOW,
    })).toMatchObject({
      current: false,
      comparisonSafe: false,
      referenceOnly: true,
      dataAvailability: {
        checkpointCurrent: false,
      },
    });
    expect(buildEtfProCheckpointFirstResponse(createEtfFixture(), {
      now: EXPIRED_NOW,
    })).toMatchObject({
      current: false,
      comparisonSafe: false,
      referenceOnly: true,
      dataAvailability: {
        checkpointCurrent: false,
      },
    });
  });
});
