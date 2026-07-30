const {
  checkpointContentHash,
  checkpointToEtfProFullBookPayload,
  createEtfProCheckpoint,
  validateEtfProCheckpoint,
} = require('./etfProCheckpoint.cjs');

function validInput(overrides = {}) {
  return {
    capturedAt: '2026-07-26T19:30:00-07:00',
    asOf: '2026-07-26T19:25:00-07:00',
    capturePrecision: 'exact',
    source: 'manual-official-etf-pro-board',
    sourceArtifact: 'conversation-attachment:etf-pro-board-2026-07-26.png',
    expectedLongCount: 1,
    expectedShortCount: 1,
    rows: [
      {
        ticker: 'spy',
        name: 'S&P 500',
        call: 'long',
        dateAdded: '2026-07-24',
        entryPrice: 100,
        lastPrice: 101,
        recentPrice: 101,
        absolutePerformance: 1,
        trendLowEnd: 98,
        daysHeld: 2,
      },
      {
        ticker: 'qqq',
        etf: 'Technology',
        call: 'SHORT',
        dateAdded: '2026-07-23',
      },
    ],
    notes: ['Transcribed from the attached official current-open-positions board.'],
    ...overrides,
  };
}

describe('ETF Pro authoritative checkpoints', () => {
  test('creates a content-addressed exact checkpoint and strips live-looking fields', () => {
    const checkpoint = createEtfProCheckpoint(validInput());

    expect(validateEtfProCheckpoint(checkpoint)).toMatchObject({ valid: true, reasons: [] });
    expect(checkpoint).toMatchObject({
      id: 'etf-pro-official-2026-07-26',
      capturedAt: '2026-07-26T19:30:00-07:00',
      asOf: '2026-07-26T19:25:00-07:00',
      capturePrecision: 'exact',
      rowCount: 2,
      longCount: 1,
      shortCount: 1,
      rows: [
        {
          ticker: 'QQQ',
          etf: 'Technology',
          call: 'Short',
          dateAdded: '2026-07-23',
        },
        {
          ticker: 'SPY',
          etf: 'S&P 500',
          call: 'Long',
          dateAdded: '2026-07-24',
          entryPrice: 100,
        },
      ],
    });
    expect(checkpoint.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(checkpoint.rows.some((row) => Object.hasOwn(row, 'lastPrice'))).toBe(false);
    expect(checkpoint.rows.some((row) => Object.hasOwn(row, 'absolutePerformance'))).toBe(false);
    expect(checkpoint.rows.some((row) => Object.hasOwn(row, 'daysHeld'))).toBe(false);
  });

  test('accepts the evidence-oriented positions alias used by checkpoint input files', () => {
    const input = validInput();
    const checkpoint = createEtfProCheckpoint({
      ...input,
      rows: undefined,
      positions: input.rows,
    });

    expect(checkpoint).toMatchObject({
      rowCount: 2,
      longCount: 1,
      shortCount: 1,
    });
    expect(validateEtfProCheckpoint(checkpoint)).toMatchObject({ valid: true, reasons: [] });
  });

  test('converts only a validated checkpoint to an explicitly manual full-book payload', () => {
    const checkpoint = createEtfProCheckpoint(validInput());
    const payload = checkpointToEtfProFullBookPayload(checkpoint);

    expect(payload.meta).toMatchObject({
      snapshotDate: '2026-07-26',
      parsedAt: '2026-07-26T19:30:00-07:00',
      asOf: '2026-07-26T19:25:00-07:00',
      capturedAt: '2026-07-26T19:30:00-07:00',
      source: 'manual-official-etf-pro-board',
      sourceKind: 'manual-official-full-book-checkpoint',
      sourceArtifact: 'conversation-attachment:etf-pro-board-2026-07-26.png',
      rowCount: 2,
      longCount: 1,
      shortCount: 1,
      checkpointValidation: { valid: true, reasons: [] },
    });
    expect(payload.data).toEqual({
      fullBookLongs: ['SPY'],
      fullBookShorts: ['QQQ'],
    });
    expect(payload.rows).toEqual(checkpoint.rows);
    expect(Object.keys(payload.rows[1])).toEqual([
      'ticker',
      'etf',
      'call',
      'dateAdded',
      'entryPrice',
    ]);
  });

  test('requires exact timing, manual-official provenance, and a durable artifact', () => {
    expect(() => createEtfProCheckpoint(validInput({
      capturePrecision: 'date-only',
    }))).toThrow('capture-precision-invalid');
    expect(() => createEtfProCheckpoint(validInput({
      source: 'official-etf-pro-board',
    }))).toThrow('source-not-authoritative');
    expect(() => createEtfProCheckpoint(validInput({
      sourceArtifact: '/tmp/screenshot.png',
    }))).toThrow('source-artifact-not-durable');
    expect(() => createEtfProCheckpoint(validInput({
      asOf: '2026-07-26T19:35:00-07:00',
    }))).toThrow('as-of-after-capture');
  });

  test('rejects malformed membership, count mismatches, and nonhistorical entry prices', () => {
    expect(() => createEtfProCheckpoint(validInput({
      expectedLongCount: 2,
    }))).toThrow('expected-long-count-mismatch');
    expect(() => createEtfProCheckpoint(validInput({
      rows: [
        {
          ticker: 'SPY',
          etf: 'S&P 500',
          call: 'Long',
          dateAdded: '2026-07-24',
        },
        {
          ticker: 'spy',
          etf: 'S&P 500',
          call: 'Short',
          dateAdded: '2026-07-24',
        },
      ],
    }))).toThrow(/side-conflict|duplicate-position/);
    expect(() => createEtfProCheckpoint(validInput({
      rows: [
        {
          ticker: 'SPY',
          etf: 'S&P 500',
          call: 'Long',
          dateAdded: '2026-07-27',
        },
        {
          ticker: 'QQQ',
          etf: 'Technology',
          call: 'Short',
          dateAdded: '2026-07-23',
        },
      ],
    }))).toThrow('date-added-after-as-of');
    expect(() => createEtfProCheckpoint(validInput({
      rows: [
        {
          ticker: 'SPY',
          etf: 'S&P 500',
          call: 'Long',
          dateAdded: '2026-07-24',
          entryPrice: '100.00',
        },
        {
          ticker: 'QQQ',
          etf: 'Technology',
          call: 'Short',
          dateAdded: '2026-07-23',
        },
      ],
    }))).toThrow('invalid-entry-price');
  });

  test('detects membership, provenance, and unsafe stored-row tampering', () => {
    const checkpoint = createEtfProCheckpoint(validInput());
    const membershipTamper = {
      ...checkpoint,
      rows: checkpoint.rows.filter((row) => row.ticker !== 'SPY'),
    };
    const provenanceTamper = {
      ...checkpoint,
      sourceArtifact: 'repository-artifact:data/other-board.json',
    };
    const unsafeMarketTamper = {
      ...checkpoint,
      rows: checkpoint.rows.map((row, index) => (
        index === 0 ? { ...row, lastPrice: 123.45 } : row
      )),
    };
    unsafeMarketTamper.contentHash = checkpointContentHash(unsafeMarketTamper);

    expect(validateEtfProCheckpoint(membershipTamper).reasons).toContain('content-hash-mismatch');
    expect(validateEtfProCheckpoint(provenanceTamper).reasons).toContain('content-hash-mismatch');
    expect(validateEtfProCheckpoint(unsafeMarketTamper).reasons).toEqual(
      expect.arrayContaining([
        'rows-not-canonical',
        'row-fields-not-canonical',
        'unsafe-market-fields-present',
      ]),
    );
    expect(() => checkpointToEtfProFullBookPayload(unsafeMarketTamper)).toThrow(
      'unsafe-market-fields-present',
    );
  });
});
