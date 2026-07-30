const {
  classifyEtfProRows,
  isAuthoritativeEtfProCheckpoint,
  resolveEtfProPayloadFromSources,
} = require('./etfProResolver.cjs');

function rowsFromTickers(longs = [], shorts = []) {
  return [
    ...longs.map((ticker, index) => ({
      id: `${ticker}_L_${index}`,
      ticker,
      etf: ticker,
      call: 'Long',
      assetClass: 'ETF Pro',
    })),
    ...shorts.map((ticker, index) => ({
      id: `${ticker}_S_${index}`,
      ticker,
      etf: ticker,
      call: 'Short',
      assetClass: 'ETF Pro',
    })),
  ];
}

function activeBook(date, longs, shorts) {
  return {
    meta: {
      snapshotDate: date,
      parsedAt: `${date}T12:00:00.000Z`,
      source: 'manual-current-open-positions',
      sourceKind: 'active-open-positions',
      rowCount: longs.length + shorts.length,
    },
    rows: rowsFromTickers(longs, shorts),
  };
}

function actionBook(date, {
  addedLongs = [],
  removedLongs = [],
  addedShorts = [],
  removedShorts = [],
} = {}) {
  return {
    meta: {
      snapshotDate: date,
      parsedAt: `${date}T15:00:00.000Z`,
      source: 'gmail-html-action',
      headline: 'UPDATE: New ETF Pro Changes',
      rowCount: addedLongs.length + removedLongs.length + addedShorts.length + removedShorts.length,
      actionCount: addedLongs.length + removedLongs.length + addedShorts.length + removedShorts.length,
    },
    rows: [
      ...addedLongs.map((ticker) => ({ ticker, etf: ticker, call: 'Long', action: 'ADD' })),
      ...removedLongs.map((ticker) => ({ ticker, etf: ticker, call: 'Long', action: 'REMOVE' })),
      ...addedShorts.map((ticker) => ({ ticker, etf: ticker, call: 'Short', action: 'ADD' })),
      ...removedShorts.map((ticker) => ({ ticker, etf: ticker, call: 'Short', action: 'REMOVE' })),
    ],
    changes: {
      addedLongs,
      removedLongs,
      addedShorts,
      removedShorts,
      added: [...addedLongs, ...addedShorts],
      removed: [...removedLongs, ...removedShorts],
    },
  };
}

const june9Longs = [
  'TINY', 'XAR', 'BUG', 'DBMF', 'UUP', 'DRAM', 'VXF', 'QTUM', 'VYM', 'CPER',
  'CLOZ', 'CLOX', 'AAAU', 'BUXX', 'FWD', 'TAN', 'ROBO', 'SLX', 'IWM', 'HYG',
  'EQRR', 'XTL', 'NORW', 'OIH',
];

const june9Shorts = [
  'EWA', 'XLY', 'TUR', 'AGNG', 'FXE', 'PAWZ', 'WOOD', 'INQQ', 'EWZ', 'BTAL',
  'IHI', 'XLP', 'XLU', 'IDX', 'EPHE', 'PALL', 'INDA', 'TLT', 'ZROZ',
];

const june10Action = actionBook('2026-06-10', {
  removedLongs: ['FWD', 'TAN', 'ROBO', 'SLX', 'IWM', 'HYG', 'EQRR', 'XTL', 'NORW', 'OIH'],
  addedShorts: ['USO', 'EWG'],
  removedShorts: ['XLP'],
});

const june11Action = actionBook('2026-06-11', {
  addedLongs: ['BNDD', 'PINK'],
  addedShorts: ['IBIT', 'HARD'],
  removedShorts: ['ZROZ'],
});

const june12Action = actionBook('2026-06-12', {
  addedLongs: ['LQD', 'FXH'],
  addedShorts: ['EZA', 'MSTY'],
  removedShorts: ['XLU', 'TLT'],
});

const june28Longs = [
  'VYMI', 'DBJP', 'XHB', 'TLT', 'IAK', 'XLV', 'XLRE', 'LQD', 'FXH',
  'BNDD', 'TINY', 'XAR', 'UUP', 'DRAM', 'VXF', 'VYM', 'CLOZ', 'CLOX',
  'AAAU', 'BUXX',
];

const june28Shorts = [
  'UGA', 'EIS', 'IVES', 'XLY', 'MAGS', 'EWM', 'URA', 'SOLZ', 'MSTY',
  'HARD', 'IBIT', 'EWG', 'USO', 'FXE', 'EWZ', 'BTAL', 'IHI', 'IDX',
  'PALL',
];

const postJune28Actions = [
  actionBook('2026-06-29', { addedShorts: ['EPOL', 'XOP', 'FXB'], removedShorts: ['IHI'] }),
  actionBook('2026-06-30', { addedLongs: ['XLU', 'PAVE'], removedLongs: ['VYMI'], removedShorts: ['UGA'] }),
  actionBook('2026-07-01', { addedLongs: ['VCLT', 'ZROZ'], addedShorts: ['XLC'] }),
  actionBook('2026-07-02', { addedLongs: ['YCS'], removedLongs: ['DRAM'], addedShorts: ['SIL'], removedShorts: ['EWG', 'EPOL'] }),
  actionBook('2026-07-08', { addedLongs: ['JETS'], removedLongs: ['DBJP', 'VCLT'], addedShorts: ['NORW', 'EWT'], removedShorts: ['BTAL', 'SOLZ', 'MAGS', 'FXB'] }),
  actionBook('2026-07-09', { addedLongs: ['FAB'], removedLongs: ['YCS'], removedShorts: ['XLY', 'IVES', 'EWT'] }),
  actionBook('2026-07-10', { addedLongs: ['ARKG', 'DESK'], removedLongs: ['XAR', 'TINY', 'LQD'], addedShorts: ['EWH'], removedShorts: ['EWZ'] }),
  actionBook('2026-07-13', { addedLongs: ['BUG'], removedLongs: ['PAVE'], addedShorts: ['COAL'], removedShorts: ['XOP', 'XLC'] }),
  actionBook('2026-07-14', { addedLongs: ['VOOG', 'NOBL'], removedLongs: ['ZROZ'], addedShorts: ['INDA'], removedShorts: ['PALL', 'EWM'] }),
  actionBook('2026-07-15', { addedShorts: ['EWK', 'FXC'], removedShorts: ['EWH'] }),
  actionBook('2026-07-16', { addedLongs: ['EWZ'], removedLongs: ['UUP', 'TLT', 'JETS'], addedShorts: ['EWG', 'QAT'] }),
  actionBook('2026-07-17', { addedLongs: ['COLO', 'ENZL'], removedLongs: ['VXF'], addedShorts: ['EWQ'], removedShorts: ['FXE', 'USO', 'HARD', 'NORW'] }),
];

describe('ETF Pro resolver', () => {
  test('applies June 10 and June 11 action emails to the active June 9 base', () => {
    const payload = resolveEtfProPayloadFromSources({
      localPayload: activeBook('2026-06-09', june9Longs, june9Shorts),
      hermesPayloads: { actions: [june11Action, june10Action], fullBooks: [] },
      now: new Date('2026-06-11T18:00:00.000Z'),
    });
    const summary = classifyEtfProRows(payload.rows);

    expect(summary.longs.size).toBe(16);
    expect(summary.shorts.size).toBe(21);
    expect([...summary.longs].sort()).toEqual([
      'AAAU', 'BNDD', 'BUG', 'BUXX', 'CLOX', 'CLOZ', 'CPER', 'DBMF',
      'DRAM', 'PINK', 'QTUM', 'TINY', 'UUP', 'VXF', 'VYM', 'XAR',
    ].sort());
    expect(summary.shorts.has('XLU')).toBe(true);
    expect(summary.shorts.has('TLT')).toBe(true);
  });

  test('applies June 12 delta to reach the pasted 18 long / 21 short book', () => {
    const payload = resolveEtfProPayloadFromSources({
      localPayload: activeBook('2026-06-09', june9Longs, june9Shorts),
      hermesPayloads: { actions: [june12Action, june11Action, june10Action], fullBooks: [] },
      now: new Date('2026-06-12T18:00:00.000Z'),
    });
    const summary = classifyEtfProRows(payload.rows);

    expect(summary.longs.size).toBe(18);
    expect(summary.shorts.size).toBe(21);
    expect([...summary.longs].sort()).toEqual([
      'LQD', 'FXH', 'PINK', 'BNDD', 'TINY', 'XAR', 'BUG', 'DBMF', 'UUP',
      'DRAM', 'VXF', 'QTUM', 'VYM', 'CPER', 'CLOZ', 'CLOX', 'AAAU', 'BUXX',
    ].sort());
    expect([...summary.shorts].sort()).toEqual([
      'EZA', 'MSTY', 'HARD', 'IBIT', 'EWG', 'USO', 'EWA', 'XLY', 'TUR',
      'AGNG', 'FXE', 'PAWZ', 'WOOD', 'INQQ', 'EWZ', 'BTAL', 'IHI', 'IDX',
      'EPHE', 'PALL', 'INDA',
    ].sort());
  });

  test('does not let an older full-book lineup email override an active open-position base', () => {
    const payload = resolveEtfProPayloadFromSources({
      localPayload: activeBook('2026-06-09', june9Longs, june9Shorts),
      hermesPayloads: {
        actions: [],
        fullBooks: [{
          meta: {
            snapshotDate: '2026-06-08',
            parsedAt: '2026-06-08T12:00:00.000Z',
            source: 'gmail-html-full-book',
            headline: 'ETF Pro Plus: June Update (Q2 2026)',
          },
          rows: rowsFromTickers(['BUXX', 'FWD'], ['TLT']),
        }],
      },
      now: new Date('2026-06-10T11:00:00.000Z'),
    });

    expect(payload.meta.source).toBe('manual-current-open-positions');
    expect(payload.rows).toHaveLength(43);
    expect(payload.dataQuality.warnings || []).not.toContain(
      'Ignored ETF Pro lineup email because an active open-position base exists.'
    );
    expect(payload.dataQuality.status).toBe('ok');
  });

  test('uses a newer weekly full-book email over an older active open-position base', () => {
    const payload = resolveEtfProPayloadFromSources({
      localPayload: activeBook('2026-06-18', ['IAK', 'XAR'], ['INDA', 'INQQ']),
      hermesPayloads: {
        actions: [],
        fullBooks: [{
          meta: {
            snapshotDate: '2026-06-21',
            parsedAt: '2026-06-21T17:58:02.000Z',
            source: 'gmail-html-full-book',
            headline: 'ETF Pro Plus - New Weekly Report',
          },
          rows: rowsFromTickers(['BUXX', 'AAAU', 'CLOX'], ['PALL', 'IDX']),
        }],
      },
      now: new Date('2026-06-21T18:00:00.000Z'),
    });
    const summary = classifyEtfProRows(payload.rows);

    expect(payload.meta.source).toBe('gmail-html-full-book');
    expect(payload.meta.sourceKind).toBe('gmail-html-full-book');
    expect(payload.meta.snapshotDate).toBe('2026-06-21');
    expect([...summary.longs].sort()).toEqual(['AAAU', 'BUXX', 'CLOX']);
    expect([...summary.shorts].sort()).toEqual(['IDX', 'PALL']);
    expect(payload.dataQuality?.warnings || []).not.toContain(
      'Ignored ETF Pro lineup email because an active open-position base exists.'
    );
  });

  test('flags missing removes and duplicate adds as data-quality warnings', () => {
    const payload = resolveEtfProPayloadFromSources({
      localPayload: activeBook('2026-06-09', ['AAPL'], ['TLT']),
      hermesPayloads: {
        actions: [actionBook('2026-06-10', {
          addedLongs: ['AAPL'],
          removedShorts: ['XLU'],
        })],
        fullBooks: [],
      },
      now: new Date('2026-06-10T18:00:00.000Z'),
    });

    expect(payload.dataQuality.duplicateAdds).toEqual(['AAPL']);
    expect(payload.dataQuality.removedButMissing).toEqual(['XLU']);
    expect(payload.dataQuality.status).toBe('warning');
    expect(payload.available).toBe(false);
    expect(payload.longCount).toBeNull();
    expect(payload.shortCount).toBeNull();
    expect(payload.meta.longCount).toBeNull();
    expect(payload.meta.shortCount).toBeNull();
  });

  test('recomputes metadata counts from final rows after Gmail actions', () => {
    const payload = resolveEtfProPayloadFromSources({
      localPayload: activeBook('2026-06-18', ['IAK', 'XAR'], ['INDA', 'INQQ']),
      hermesPayloads: {
        actions: [actionBook('2026-06-22', {
          addedLongs: ['SJM'],
          removedShorts: ['INDA'],
        })],
        fullBooks: [],
      },
      now: new Date('2026-06-22T18:00:00.000Z'),
    });
    const summary = classifyEtfProRows(payload.rows);

    expect([...summary.longs].sort()).toEqual(['IAK', 'SJM', 'XAR']);
    expect([...summary.shorts]).toEqual(['INQQ']);
    expect(payload.meta).toMatchObject({
      snapshotDate: '2026-06-22',
      rowCount: 4,
      longCount: 3,
      shortCount: 1,
    });
  });

  test('keeps the June 28 active baseline over older Gmail actions and applies only newer actions', () => {
    const payload = resolveEtfProPayloadFromSources({
      localPayload: activeBook('2026-06-28', june28Longs, june28Shorts),
      hermesPayloads: {
        actions: [
          actionBook('2026-06-27', {
            addedLongs: ['OLDL'],
            removedShorts: ['UGA'],
          }),
          actionBook('2026-06-29', {
            addedLongs: ['NEWL'],
            removedShorts: ['PALL'],
          }),
        ],
        fullBooks: [],
      },
      now: new Date('2026-06-29T18:00:00.000Z'),
    });
    const summary = classifyEtfProRows(payload.rows);

    expect(payload.meta).toMatchObject({
      snapshotDate: '2026-06-29',
      baseSnapshotDate: '2026-06-28',
      rowCount: 39,
      longCount: 21,
      shortCount: 18,
    });
    expect(summary.longs.has('OLDL')).toBe(false);
    expect(summary.shorts.has('UGA')).toBe(true);
    expect(summary.longs.has('NEWL')).toBe(true);
    expect(summary.shorts.has('PALL')).toBe(false);
  });

  test('replays every materialized action after the June 28 baseline to the current 21 / 13 book', () => {
    const payload = resolveEtfProPayloadFromSources({
      localPayload: activeBook('2026-06-28', june28Longs, june28Shorts),
      hermesPayloads: {
        actions: [...postJune28Actions].reverse().concat(postJune28Actions[5]),
        fullBooks: [],
      },
      now: new Date('2026-07-17T16:00:00.000Z'),
    });

    expect(payload).toMatchObject({
      available: true,
      longCount: 21,
      shortCount: 13,
      dataQuality: { status: 'ok', warnings: [] },
      meta: {
        snapshotDate: '2026-07-17',
        baseSnapshotDate: '2026-06-28',
        rowCount: 34,
        longCount: 21,
        shortCount: 13,
      },
    });
    expect(payload.meta.appliedActionDates).toEqual(postJune28Actions.map((action) => action.meta.snapshotDate));
  });

  test('uses a newer full book as the reset point and ignores actions at or before it', () => {
    const payload = resolveEtfProPayloadFromSources({
      localPayload: activeBook('2026-06-28', june28Longs, june28Shorts),
      hermesPayloads: {
        fullBooks: [{
          ...activeBook('2026-07-10', ['RESETL'], ['RESETS']),
          meta: {
            snapshotDate: '2026-07-10',
            parsedAt: '2026-07-10T16:00:00.000Z',
            source: 'gmail-html-full-book',
          },
        }],
        actions: [
          actionBook('2026-07-09', { addedLongs: ['OLDL'] }),
          actionBook('2026-07-11', { addedLongs: ['NEWL'], removedShorts: ['RESETS'] }),
        ],
      },
      now: new Date('2026-07-11T18:00:00.000Z'),
    });

    expect(payload.available).toBe(true);
    expect(payload.meta.baseSnapshotDate).toBe('2026-07-10');
    expect(payload.meta.appliedActionDates).toEqual(['2026-07-11']);
    expect([...classifyEtfProRows(payload.rows).longs].sort()).toEqual(['NEWL', 'RESETL']);
    expect([...classifyEtfProRows(payload.rows).shorts]).toEqual([]);
  });

  test('preserves manual checkpoint source kind and baseline provenance while applying later actions', () => {
    const manualCheckpoint = {
      ...activeBook('2026-07-20', ['SPY'], ['TLT']),
      meta: {
        snapshotDate: '2026-07-20',
        parsedAt: '2026-07-20T16:00:00.000Z',
        asOf: '2026-07-20T16:00:00.000Z',
        capturedAt: '2026-07-20T16:00:00.000Z',
        source: 'manual-official-etf-pro-board',
        sourceKind: 'manual-official-full-book-checkpoint',
        sourceArtifact: 'repository-artifact:data/hedgeye/etfpro/checkpoint.json',
        sourceFile: 'repository-artifact:data/hedgeye/etfpro/checkpoint.json',
        checkpointId: 'etf-pro-checkpoint-v1:abc123',
        contentHash: 'a'.repeat(64),
        provenance: { capturePrecision: 'exact', verifiedBy: 'user' },
      },
    };
    const payload = resolveEtfProPayloadFromSources({
      hermesPayloads: {
        fullBooks: [manualCheckpoint],
        actions: [actionBook('2026-07-21', {
          addedLongs: ['QQQ'],
          removedShorts: ['TLT'],
        })],
      },
    });

    expect(payload.meta).toMatchObject({
      source: 'gmail-html-actions-applied-to-authoritative-checkpoint',
      sourceKind: 'manual-official-full-book-checkpoint',
      sourceArtifact: 'repository-artifact:data/hedgeye/etfpro/checkpoint.json',
      checkpointId: 'etf-pro-checkpoint-v1:abc123',
      contentHash: 'a'.repeat(64),
      authoritativeCheckpoint: true,
      baseSource: 'manual-official-etf-pro-board',
      baseSourceKind: 'manual-official-full-book-checkpoint',
      baseSourceArtifact: 'repository-artifact:data/hedgeye/etfpro/checkpoint.json',
      baseCapturedAt: '2026-07-20T16:00:00.000Z',
      baseContentHash: 'a'.repeat(64),
      baseProvenance: { capturePrecision: 'exact', verifiedBy: 'user' },
    });
    expect([...classifyEtfProRows(payload.rows).longs].sort()).toEqual(['QQQ', 'SPY']);
    expect([...classifyEtfProRows(payload.rows).shorts]).toEqual([]);
  });

  test('does not trust diagnostic source-provider declarations as checkpoint authority', () => {
    expect(isAuthoritativeEtfProCheckpoint({
      meta: {
        source: 'research-event-ledger-v2-full-book',
        sourceKind: 'gmail-html-full-book',
        sourceProvider: 'manual-official-etf-pro-board',
        sourceProviderKind: 'manual-official-full-book-checkpoint',
        authoritativeCheckpoint: false,
      },
    })).toBe(false);
  });

  test('keeps a structurally valid book available through quiet days and weekends when polling is healthy', () => {
    const payload = resolveEtfProPayloadFromSources({
      localPayload: activeBook('2026-07-17', ['SPY'], ['TLT']),
      hermesPayloads: { actions: [], fullBooks: [] },
      ingestionHealth: {
        status: 'healthy',
        checkedAt: '2026-07-21T17:00:00.000Z',
        invocations: 12,
        errors: 0,
      },
    });

    expect(payload).toMatchObject({
      available: true,
      longCount: 1,
      shortCount: 1,
      dataQuality: { status: 'ok', warnings: [] },
      dataAvailability: {
        structuralStatus: 'verified',
        ingestionStatus: 'healthy',
      },
      meta: { snapshotDate: '2026-07-17', structurallyAvailable: true },
    });
    expect(payload.rows).toHaveLength(2);
  });

  test('blocks and empties the active book when Gmail polling is unhealthy without corrupting structural quality', () => {
    const payload = resolveEtfProPayloadFromSources({
      localPayload: activeBook('2026-07-17', ['SPY'], ['TLT']),
      hermesPayloads: { actions: [], fullBooks: [] },
      ingestionHealth: {
        status: 'auth_required',
        checkedAt: '2026-07-21T17:00:00.000Z',
        reason: 'All recent Gmail polls failed.',
      },
    });

    expect(payload.available).toBe(false);
    expect(payload.rows).toEqual([]);
    expect(payload.actionRows).toEqual([]);
    expect(payload.changes).toBeNull();
    expect(payload.longCount).toBeNull();
    expect(payload.shortCount).toBeNull();
    expect(payload.dataQuality.status).toBe('ok');
    expect(payload.dataAvailability).toMatchObject({
      structuralStatus: 'verified',
      ingestionStatus: 'unhealthy',
      current: false,
      comparisonSafe: false,
      referenceOnly: true,
      contentDate: '2026-07-17',
      errorCode: 'GMAIL_AUTH_REQUIRED',
      reason: 'All recent Gmail polls failed.',
    });
    expect(payload.lastKnownGood).toMatchObject({
      available: true,
      current: false,
      comparisonSafe: false,
      referenceOnly: true,
      longCount: 1,
      shortCount: 1,
      meta: {
        snapshotDate: '2026-07-17',
        rowCount: 2,
      },
    });
    expect(payload.lastKnownGood.rows).toHaveLength(2);
    expect(payload.meta).toMatchObject({
      available: false,
      structurallyAvailable: true,
      blockedByIngestion: true,
      archivedRowCount: 2,
      rowCount: 0,
    });
  });
});
