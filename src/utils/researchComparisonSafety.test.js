const {
  ETF_PRO_CANONICAL_BOOK_INVALID,
  ETF_PRO_CANONICAL_COVERAGE_INCOMPLETE,
  ETF_PRO_CANONICAL_FULL_BOOK_MISSING,
  ETF_PRO_CANONICAL_LEDGER_UNAVAILABLE,
  ETF_PRO_CANONICAL_REPLAY_INVALID,
  RTA_CANONICAL_COVERAGE_INCOMPLETE,
  RTA_CANONICAL_LEDGER_UNAVAILABLE,
  applyRtaCanonicalComparisonGate,
  resolveEtfProCanonicalComparison,
} = require('./researchComparisonSafety.cjs');

const HEALTHY_INGESTION = {
  status: 'healthy',
  healthy: true,
  checkedAt: '2026-07-26T18:00:00.000Z',
  lastSuccessAt: '2026-07-26T17:45:00.000Z',
};

function rows(longs = [], shorts = []) {
  return [
    ...longs.map((ticker) => ({ ticker, call: 'Long' })),
    ...shorts.map((ticker) => ({ ticker, call: 'Short' })),
  ];
}

function fullBook(date, longs = ['SPY'], shorts = ['TLT'], meta = {}) {
  return {
    meta: {
      snapshotDate: date,
      parsedAt: `${date}T13:00:00.000Z`,
      source: 'research-event-ledger-v2-full-book',
      sourceKind: 'gmail-html-full-book',
      ...meta,
    },
    rows: rows(longs, shorts),
  };
}

function localBook(date, longs = ['LOCAL'], shorts = []) {
  return {
    meta: {
      snapshotDate: date,
      parsedAt: `${date}T20:00:00.000Z`,
      source: 'manual-current-open-positions',
      sourceKind: 'active-open-positions',
    },
    rows: rows(longs, shorts),
  };
}

function action(date, ticker = 'QQQ') {
  return {
    meta: {
      snapshotDate: date,
      parsedAt: `${date}T15:00:00.000Z`,
      source: 'research-event-ledger-v2-action',
      sourceKind: 'gmail-html-action',
      sourceMessageId: `action-${date}`,
    },
    rows: [{ ticker, call: 'Long', action: 'ADD' }],
    changes: {
      addedLongs: [ticker],
      removedLongs: [],
      addedShorts: [],
      removedShorts: [],
      added: [ticker],
      removed: [],
    },
  };
}

function manualCheckpoint(overrides = {}) {
  return {
    capturedAt: '2026-07-26T18:30:00.000Z',
    asOf: '2026-07-26T18:30:00.000Z',
    capturePrecision: 'exact',
    source: 'manual-official-user-board',
    sourceArtifact: 'repository-artifact:data/hedgeye/manual-board.json',
    contentHash: 'a'.repeat(64),
    checkpointValidation: { valid: true, reasons: [] },
    ...overrides,
  };
}

describe('canonical research comparison safety', () => {
  test('keeps RTA legacy reconstruction reference-only when the canonical ledger read fails', () => {
    const response = applyRtaCanonicalComparisonGate({
      available: true,
      longCount: 12,
      shortCount: 8,
      lastUpdated: '2026-07-25T20:00:00.000Z',
      dataQuality: { status: 'ok', warnings: [] },
    }, {
      ingestionHealth: HEALTHY_INGESTION,
      canonicalLedgerError: 'AccessDeniedException',
    });

    expect(response).toMatchObject({
      available: true,
      longCount: 12,
      shortCount: 8,
      current: false,
      comparisonSafe: false,
      referenceOnly: true,
      dataAvailability: {
        structuralStatus: 'unverified',
        canonicalSourceVerified: false,
        current: false,
        comparisonSafe: false,
        referenceOnly: true,
        errorCode: RTA_CANONICAL_LEDGER_UNAVAILABLE,
      },
    });
  });

  test('allows a structurally valid RTA comparison only with both canonical and ingestion health', () => {
    const response = applyRtaCanonicalComparisonGate({
      available: true,
      longCount: 12,
      shortCount: 8,
      lastUpdated: '2026-07-25T20:00:00.000Z',
      dataQuality: { status: 'ok', warnings: [] },
    }, {
      ingestionHealth: HEALTHY_INGESTION,
      canonicalLedgerError: null,
    });

    expect(response).toMatchObject({
      available: true,
      current: true,
      comparisonSafe: true,
      referenceOnly: false,
      dataAvailability: {
        structuralStatus: 'verified',
        canonicalSourceVerified: true,
        errorCode: null,
      },
    });
  });

  test('keeps RTA reference-only when a source message has partial canonical action coverage', () => {
    const response = applyRtaCanonicalComparisonGate({
      available: true,
      longCount: 12,
      shortCount: 8,
      lastUpdated: '2026-07-25T20:00:00.000Z',
      dataQuality: { status: 'ok', warnings: [] },
    }, {
      ingestionHealth: HEALTHY_INGESTION,
      canonicalCoverageGaps: [{
        sourceMessageId: 'partial-message',
        legacyEventCount: 2,
        canonicalEventCount: 1,
      }],
    });

    expect(response).toMatchObject({
      available: true,
      current: false,
      comparisonSafe: false,
      referenceOnly: true,
      dataAvailability: {
        canonicalSourceVerified: false,
        canonicalCoverageGapCount: 1,
        errorCode: RTA_CANONICAL_COVERAGE_INCOMPLETE,
      },
    });
  });

  test('allows a fresh exact official RTA checkpoint while preserving unhealthy Gmail diagnostics', () => {
    const response = applyRtaCanonicalComparisonGate({
      available: true,
      longCount: 4,
      shortCount: 3,
      lastUpdated: '2026-07-26T18:30:00.000Z',
      dataQuality: { status: 'ok', warnings: [] },
    }, {
      ingestionHealth: {
        status: 'unhealthy',
        healthy: false,
        errorCode: 'GMAIL_HEARTBEAT_MISSING',
        reason: 'No scheduled heartbeat yet.',
      },
      canonicalLedgerError: 'AccessDeniedException',
      authoritativeCheckpoint: manualCheckpoint(),
      now: new Date('2026-07-26T19:00:00.000Z'),
    });

    expect(response).toMatchObject({
      available: true,
      current: true,
      comparisonSafe: true,
      referenceOnly: false,
      dataAvailability: {
        canonicalSourceVerified: true,
        ingestionStatus: 'unhealthy',
        pipelineHealthy: false,
        verificationMode: 'manual-official-checkpoint',
        checkpointVerified: true,
        checkpointCurrent: true,
        pipelineErrorCode: 'GMAIL_HEARTBEAT_MISSING',
        errorCode: null,
      },
    });
  });

  test('does not let an expired official RTA checkpoint bypass unhealthy Gmail', () => {
    const response = applyRtaCanonicalComparisonGate({
      available: true,
      longCount: 4,
      shortCount: 3,
      lastUpdated: '2026-07-24T18:30:00.000Z',
      dataQuality: { status: 'ok', warnings: [] },
    }, {
      ingestionHealth: {
        status: 'unhealthy',
        healthy: false,
        errorCode: 'GMAIL_HEARTBEAT_MISSING',
      },
      authoritativeCheckpoint: manualCheckpoint({
        capturedAt: '2026-07-24T18:30:00.000Z',
        asOf: '2026-07-24T18:30:00.000Z',
      }),
      now: new Date('2026-07-26T19:00:00.000Z'),
    });

    expect(response).toMatchObject({
      current: false,
      comparisonSafe: false,
      referenceOnly: true,
      dataAvailability: {
        checkpointVerified: true,
        checkpointCurrent: false,
        errorCode: 'GMAIL_HEARTBEAT_MISSING',
      },
    });
  });

  test('empties ETF Pro active data on a canonical ledger read failure and retains local data only as a reference', () => {
    const localPayload = localBook('2026-07-26', ['LOCALL'], ['LOCALS']);
    const canonicalPayloads = {
      fullBooks: [fullBook('2026-07-25')],
      actions: [],
    };
    const response = resolveEtfProCanonicalComparison({
      canonicalPayloads,
      referencePayloads: canonicalPayloads,
      localPayload,
      ingestionHealth: HEALTHY_INGESTION,
      canonicalLedgerError: 'NetworkingError',
    });

    expect(response).toMatchObject({
      available: false,
      current: false,
      comparisonSafe: false,
      referenceOnly: true,
      rows: [],
      longCount: null,
      shortCount: null,
      dataAvailability: {
        structuralStatus: 'unverified',
        canonicalSourceVerified: false,
        errorCode: ETF_PRO_CANONICAL_LEDGER_UNAVAILABLE,
      },
      meta: {
        blockedByCanonicalSource: true,
        rowCount: 0,
        archivedRowCount: 2,
      },
      lastKnownGood: {
        available: true,
        current: false,
        comparisonSafe: false,
        referenceOnly: true,
        longCount: 1,
        shortCount: 1,
      },
    });
    expect(response.lastKnownGood.rows).toEqual(rows(['LOCALL'], ['LOCALS']));
  });

  test('does not promote action-only canonical evidence by applying it to a local book', () => {
    const canonicalPayloads = {
      fullBooks: [],
      actions: [action('2026-07-26')],
    };
    const response = resolveEtfProCanonicalComparison({
      canonicalPayloads,
      referencePayloads: canonicalPayloads,
      localPayload: localBook('2026-07-25'),
      ingestionHealth: HEALTHY_INGESTION,
    });

    expect(response).toMatchObject({
      available: false,
      comparisonSafe: false,
      rows: [],
      dataAvailability: {
        structuralStatus: 'unverified',
        errorCode: ETF_PRO_CANONICAL_FULL_BOOK_MISSING,
      },
      meta: {
        blockedByCanonicalSource: true,
        canonicalFullBookCount: 0,
        canonicalActionPayloadCount: 1,
      },
      lastKnownGood: {
        available: true,
        referenceOnly: true,
        longCount: 2,
        shortCount: 0,
      },
    });
    expect(response.lastKnownGood.rows.map((row) => row.ticker).sort()).toEqual(['LOCAL', 'QQQ']);
  });

  test('does not silently omit legacy events that have not been backfilled into the canonical ledger', () => {
    const canonicalPayloads = {
      fullBooks: [fullBook('2026-07-25')],
      actions: [],
    };
    const legacyAction = action('2026-07-26', 'QQQ');
    const response = resolveEtfProCanonicalComparison({
      canonicalPayloads,
      referencePayloads: {
        fullBooks: canonicalPayloads.fullBooks,
        actions: [legacyAction],
      },
      ingestionHealth: HEALTHY_INGESTION,
      canonicalCoverageGaps: [{
        sourceMessageId: legacyAction.meta.sourceMessageId,
        eventKind: 'action',
      }],
    });

    expect(response).toMatchObject({
      available: false,
      comparisonSafe: false,
      rows: [],
      dataAvailability: {
        structuralStatus: 'unverified',
        errorCode: ETF_PRO_CANONICAL_COVERAGE_INCOMPLETE,
      },
      meta: {
        blockedByCanonicalSource: true,
        canonicalCoverageGapCount: 1,
      },
      lastKnownGood: {
        available: true,
        referenceOnly: true,
        longCount: 2,
        shortCount: 1,
      },
    });
    expect(response.lastKnownGood.rows.map((row) => row.ticker).sort()).toEqual([
      'QQQ',
      'SPY',
      'TLT',
    ]);
  });

  test('uses a canonical full book even when a newer local book exists', () => {
    const response = resolveEtfProCanonicalComparison({
      canonicalPayloads: {
        fullBooks: [fullBook('2026-07-25', ['CANONL'], ['CANONS'])],
        actions: [],
      },
      localPayload: localBook('2026-07-26', ['NEWLOCAL']),
      ingestionHealth: HEALTHY_INGESTION,
    });

    expect(response).toMatchObject({
      available: true,
      current: true,
      comparisonSafe: true,
      referenceOnly: false,
      longCount: 1,
      shortCount: 1,
      dataAvailability: {
        canonicalSourceVerified: true,
      },
      meta: {
        canonicalSourceVerified: true,
        canonicalFullBookCount: 1,
      },
    });
    expect(response.rows.map((row) => row.ticker).sort()).toEqual([
      'CANONL',
      'CANONS',
    ]);
  });

  test('preserves the existing ingestion-health gate after canonical verification succeeds', () => {
    const response = resolveEtfProCanonicalComparison({
      canonicalPayloads: {
        fullBooks: [fullBook('2026-07-25')],
        actions: [],
      },
      ingestionHealth: {
        status: 'auth_required',
        healthy: false,
        checkedAt: '2026-07-26T18:00:00.000Z',
      },
    });

    expect(response).toMatchObject({
      available: false,
      current: false,
      comparisonSafe: false,
      rows: [],
      dataAvailability: {
        canonicalSourceVerified: true,
        ingestionStatus: 'unhealthy',
        errorCode: 'GMAIL_AUTH_REQUIRED',
      },
      meta: {
        canonicalSourceVerified: true,
        blockedByIngestion: true,
      },
      lastKnownGood: {
        available: true,
        referenceOnly: true,
        longCount: 1,
        shortCount: 1,
      },
    });
  });

  test('allows a fresh exact official ETF Pro checkpoint without exposing pasted market prices', () => {
    const response = resolveEtfProCanonicalComparison({
      canonicalPayloads: {
        fullBooks: [fullBook('2026-07-26', ['ETHA'], ['CARZ'], {
          parsedAt: '2026-07-26T18:30:00.000Z',
          source: 'manual-official-etf-pro-board',
          sourceKind: 'manual-official-full-book',
        })],
        actions: [],
      },
      ingestionHealth: {
        status: 'unhealthy',
        healthy: false,
        errorCode: 'GMAIL_HEARTBEAT_MISSING',
      },
      canonicalLedgerError: 'NetworkingError',
      authoritativeCheckpoint: manualCheckpoint({
        source: 'manual-official-etf-pro-board',
      }),
      now: new Date('2026-07-26T19:00:00.000Z'),
    });

    expect(response).toMatchObject({
      available: true,
      current: true,
      comparisonSafe: true,
      referenceOnly: false,
      longCount: 1,
      shortCount: 1,
      dataAvailability: {
        canonicalSourceVerified: true,
        ingestionStatus: 'unhealthy',
        pipelineHealthy: false,
        verificationMode: 'manual-official-checkpoint',
        checkpointCurrent: true,
        errorCode: null,
      },
      meta: {
        sourceKind: 'manual-official-full-book',
        canonicalSourceVerified: true,
      },
    });
    expect(response.rows).toEqual([
      expect.objectContaining({ ticker: 'ETHA', call: 'Long' }),
      expect.objectContaining({ ticker: 'CARZ', call: 'Short' }),
    ]);
    response.rows.forEach((row) => {
      expect(row).not.toHaveProperty('lastPrice');
      expect(row).not.toHaveProperty('recentPrice');
      expect(row).not.toHaveProperty('absolutePerformance');
      expect(row).not.toHaveProperty('relativePerformance');
    });
  });

  test('fails closed and exposes no active rows when canonical replay is rejected', () => {
    const rejection = {
      eventKey: 'bad-event',
      sourceMessageId: 'bad-message',
      code: 'invalid-research-event',
    };
    const response = resolveEtfProCanonicalComparison({
      canonicalPayloads: {
        fullBooks: [fullBook('2026-07-25')],
        actions: [],
      },
      referencePayloads: {
        fullBooks: [fullBook('2026-07-25')],
        actions: [],
      },
      ingestionHealth: HEALTHY_INGESTION,
      canonicalRejections: [rejection],
    });

    expect(response).toMatchObject({
      available: false,
      rows: [],
      longCount: null,
      shortCount: null,
      dataQuality: {
        status: 'error',
        researchEventFailures: [rejection],
      },
      dataAvailability: {
        structuralStatus: 'invalid',
        errorCode: ETF_PRO_CANONICAL_REPLAY_INVALID,
      },
      meta: {
        blockedByCanonicalSource: true,
        blockedByResearchEventReplay: true,
      },
    });
  });

  test('fails closed when canonical rows resolve to a structurally invalid book', () => {
    const response = resolveEtfProCanonicalComparison({
      canonicalPayloads: {
        fullBooks: [fullBook('2026-07-25', ['SPY', 'SPY'], [])],
        actions: [],
      },
      ingestionHealth: HEALTHY_INGESTION,
    });

    expect(response).toMatchObject({
      available: false,
      rows: [],
      longCount: null,
      shortCount: null,
      dataQuality: { status: 'error' },
      dataAvailability: {
        structuralStatus: 'invalid',
        errorCode: ETF_PRO_CANONICAL_BOOK_INVALID,
      },
      meta: {
        blockedByCanonicalSource: true,
        archivedRowCount: 2,
      },
      lastKnownGood: null,
    });
  });
});
