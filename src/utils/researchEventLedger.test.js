const {
  RESEARCH_EVENT_VERIFICATION_HASH_VERSION,
  buildEtfProPayloadsFromResearchEvents,
  computeResearchEventVerificationHash,
  filterIssuesAfterAuthoritativeCheckpoint,
  filterLegacyRejectionsByCompleteCanonicalSources,
  materializeRtaResearchEvents,
  mergeRtaMaterializations,
  partitionEtfProLegacyCoverage,
  sortResearchEvents,
} = require('./researchEventLedger.cjs');
const { classifyEtfProRows, resolveEtfProPayloadFromSources } = require('./etfProResolver.cjs');

function event(overrides = {}) {
  const item = {
    productKey: 'etf-pro',
    eventKey: '2026-07-21T13:00:00Z#message-a#0000',
    eventTime: '2026-07-21T13:00:00Z',
    sourceMessageId: 'message-a',
    sequence: 0,
    sourceEventCount: 1,
    eventType: 'FULL_BOOK_CHECKPOINT',
    payload: { rows: [{ ticker: 'SPY', call: 'Long' }] },
    eventHash: 'a'.repeat(64),
    parserVersion: 'research-event-ledger-v2',
    sourceArtifact: 'gmail/message-a.html',
    ...overrides,
  };
  return {
    ...item,
    verificationHashVersion: RESEARCH_EVENT_VERIFICATION_HASH_VERSION,
    verificationHash: computeResearchEventVerificationHash(item),
  };
}

describe('ResearchEventLedgerV2 consumers', () => {
  test('suppresses only timestamped issues at or before an authoritative checkpoint', () => {
    const issues = [
      { id: 'before', eventTime: '2026-07-21T11:59:59.999Z' },
      { id: 'equal-meta-fallback', meta: { parsedAt: '2026-07-21T12:00:00.000Z' } },
      { id: 'after', eventTime: '2026-07-21T12:00:00.001Z' },
      { id: 'missing' },
      { id: 'invalid', eventTime: 'not-a-time' },
    ];

    expect(filterIssuesAfterAuthoritativeCheckpoint(
      issues,
      '2026-07-21T12:00:00.000Z',
    ).map((item) => item.id)).toEqual(['after', 'missing', 'invalid']);
  });

  test('sorts equal-time events deterministically by message and sequence', () => {
    const events = [
      event({ sourceMessageId: 'message-b', sequence: 0, eventKey: 't#message-b#0000' }),
      event({ sourceMessageId: 'message-a', sequence: 1, eventKey: 't#message-a#0001' }),
      event({ sourceMessageId: 'message-a', sequence: 0, eventKey: 't#message-a#0000' }),
    ];

    expect(sortResearchEvents(events).map((item) => item.eventKey)).toEqual([
      't#message-a#0000',
      't#message-a#0001',
      't#message-b#0000',
    ]);
  });

  test('applies a same-day action that occurred after the full-book checkpoint', () => {
    const checkpoint = event({
      eventTime: '2026-07-21T13:00:00Z',
      eventKey: '2026-07-21T13:00:00Z#checkpoint#0000',
      sourceMessageId: 'checkpoint',
      payload: { rows: [{ ticker: 'SPY', call: 'Long' }, { ticker: 'TLT', call: 'Short' }] },
    });
    const remove = event({
      eventTime: '2026-07-21T15:00:00Z',
      eventKey: '2026-07-21T15:00:00Z#action#0000',
      sourceMessageId: 'action',
      sourceEventCount: 2,
      eventType: 'POSITION_ACTION',
      payload: { ticker: 'TLT', action: 'REMOVE', side: 'Short' },
    });
    const add = event({
      eventTime: '2026-07-21T15:00:00Z',
      eventKey: '2026-07-21T15:00:00Z#action#0001',
      sourceMessageId: 'action',
      sequence: 1,
      sourceEventCount: 2,
      eventType: 'POSITION_ACTION',
      payload: { ticker: 'QQQ', action: 'ADD', side: 'Long' },
    });
    const payloads = buildEtfProPayloadsFromResearchEvents([add, checkpoint, remove]);
    const resolved = resolveEtfProPayloadFromSources({
      localPayload: null,
      hermesPayloads: payloads,
      ingestionHealth: { status: 'healthy' },
    });

    expect(payloads.rejected).toEqual([]);
    expect(payloads.fullBooks).toHaveLength(1);
    expect(payloads.actions).toHaveLength(1);
    expect([...classifyEtfProRows(resolved.rows).longs].sort()).toEqual(['QQQ', 'SPY']);
    expect([...classifyEtfProRows(resolved.rows).shorts]).toEqual([]);
    expect(resolved.meta.appliedActionDates).toEqual(['2026-07-21']);
    expect(resolved.meta.sourceMessageId).toBe('action');
    expect(resolved.meta.sourceEventKey).toBe('2026-07-21T15:00:00Z#action#0000');
  });

  test('does not promote unbound ledger provenance to an authoritative manual checkpoint', () => {
    const payloads = buildEtfProPayloadsFromResearchEvents([
      event({
        sourceMessageId: 'manual-etf-checkpoint',
        eventKey: '2026-07-21T13:00:00Z#manual-etf-checkpoint#0000',
        source: 'manual-official-etf-pro-board',
        sourceKind: 'manual-official-full-book-checkpoint',
        sourceArtifact: 'repository-artifact:data/hedgeye/etfpro/checkpoint.json',
        capturedAt: '2026-07-21T13:00:00Z',
        contentHash: 'b'.repeat(64),
        provenance: { verifiedBy: 'user', capturePrecision: 'exact' },
      }),
    ]);

    expect(payloads.rejected).toEqual([]);
    expect(payloads.fullBooks[0].meta).toMatchObject({
      source: 'research-event-ledger-v2-full-book',
      sourceKind: 'gmail-html-full-book',
      sourceArtifact: 'repository-artifact:data/hedgeye/etfpro/checkpoint.json',
      sourceFile: 'repository-artifact:data/hedgeye/etfpro/checkpoint.json',
      sourceProvider: 'manual-official-etf-pro-board',
      sourceProviderKind: 'manual-official-full-book-checkpoint',
      declaredCapturedAt: '2026-07-21T13:00:00Z',
      declaredContentHash: 'b'.repeat(64),
      authoritativeCheckpoint: false,
      provenanceVerified: false,
      declaredProvenance: { verifiedBy: 'user', capturePrecision: 'exact' },
    });
  });

  test('uses message and sequence as deterministic ties when event times match', () => {
    const checkpoint = event({
      eventTime: '2026-07-21T13:00:00Z',
      eventKey: '2026-07-21T13:00:00Z#message-a#0000',
      sourceMessageId: 'message-a',
      payload: { rows: [{ ticker: 'SPY', call: 'Long' }] },
    });
    const action = event({
      eventTime: '2026-07-21T13:00:00Z',
      eventKey: '2026-07-21T13:00:00Z#message-z#0000',
      sourceMessageId: 'message-z',
      eventType: 'POSITION_ACTION',
      payload: { ticker: 'QQQ', action: 'ADD', side: 'Long' },
    });
    const payloads = buildEtfProPayloadsFromResearchEvents([action, checkpoint]);
    const resolved = resolveEtfProPayloadFromSources({
      hermesPayloads: payloads,
      ingestionHealth: { status: 'healthy' },
    });

    expect([...classifyEtfProRows(resolved.rows).longs].sort()).toEqual(['QQQ', 'SPY']);
  });

  test('fails closed on malformed V2 actions instead of silently omitting them', () => {
    const payloads = buildEtfProPayloadsFromResearchEvents([
      event({
        eventType: 'POSITION_ACTION',
        payload: { ticker: 'BAD TICKER', action: 'ADD', side: 'Long' },
      }),
    ]);

    expect(payloads.actions).toEqual([]);
    expect(payloads.rejected).toEqual([
      expect.objectContaining({
        code: 'invalid-research-event',
        reasons: expect.arrayContaining(['action-ticker-invalid']),
      }),
    ]);
  });

  test('accepts the deployed v3-tracker-contract ledger label and still rejects unknown parser labels', () => {
    const rta = (parserVersion) => materializeRtaResearchEvents([event({
      productKey: 'real-time-alert',
      eventType: 'POSITION_ACTION',
      parserVersion,
      payload: { ticker: 'PALL', action: 'SELL', intent: 'open-short', side: 'short' },
    })]);
    const current = rta('research-event-ledger-v3-tracker-contract');
    expect(current.rejected).toEqual([]);
    expect(current.snapshots.flatMap((snapshot) => snapshot.data.alerts).map((alert) => alert.ticker)).toEqual(['PALL']);
    expect(rta('research-event-ledger-v2').rejected).toEqual([]);
    expect(rta('research-event-ledger-v9-unknown').rejected).toEqual([
      expect.objectContaining({ reasons: ['parser-version-invalid'] }),
    ]);
    const etf = buildEtfProPayloadsFromResearchEvents([event({ parserVersion: 'research-event-ledger-v3-tracker-contract' })]);
    expect(etf.rejected).toEqual([]);
  });

  test('rejects a canonical event whose verified payload hash no longer matches', () => {
    const valid = event({
      eventType: 'POSITION_ACTION',
      payload: { ticker: 'QQQ', action: 'ADD', side: 'Long' },
    });
    const payloads = buildEtfProPayloadsFromResearchEvents([{
      ...valid,
      payload: { ...valid.payload, ticker: 'SPY' },
    }]);

    expect(payloads.actions).toEqual([]);
    expect(payloads.rejected).toEqual([
      expect.objectContaining({
        reasons: expect.arrayContaining(['verification-hash-mismatch']),
      }),
    ]);
  });

  test('detects partial same-message ETF action coverage by semantic count and signature', () => {
    const canonicalPayloads = buildEtfProPayloadsFromResearchEvents([
      event({
        eventTime: '2026-07-21T15:00:00Z',
        eventKey: '2026-07-21T15:00:00Z#action#0000',
        sourceMessageId: 'action',
        eventType: 'POSITION_ACTION',
        payload: { ticker: 'QQQ', action: 'ADD', side: 'Long' },
      }),
    ]);
    const legacyPayloads = {
      fullBooks: [],
      actions: [{
        meta: { sourceMessageId: 'action' },
        rows: [
          { ticker: 'QQQ', action: 'ADD', call: 'Long' },
          { ticker: 'TLT', action: 'REMOVE', call: 'Short' },
        ],
      }],
    };

    expect(partitionEtfProLegacyCoverage({
      canonicalPayloads,
      legacyPayloads,
    })).toMatchObject({
      uncoveredActions: legacyPayloads.actions,
      coverageGaps: [{
        sourceMessageId: 'action',
        eventKind: 'action',
        legacyEventCount: 2,
        canonicalEventCount: 1,
        reason: 'canonical-event-signature-mismatch',
      }],
    });
  });

  test('an authoritative ETF checkpoint supersedes only known pre-checkpoint coverage gaps', () => {
    const before = {
      meta: {
        sourceMessageId: 'before',
        parsedAt: '2026-07-21T11:00:00Z',
      },
      rows: [{ ticker: 'SPY', action: 'ADD', call: 'Long' }],
    };
    const after = {
      meta: {
        sourceMessageId: 'after',
        parsedAt: '2026-07-21T13:00:00Z',
      },
      rows: [{ ticker: 'QQQ', action: 'ADD', call: 'Long' }],
    };
    const missingTime = {
      meta: { sourceMessageId: 'missing-time' },
      rows: [{ ticker: 'TLT', action: 'ADD', call: 'Short' }],
    };

    const partition = partitionEtfProLegacyCoverage({
      canonicalPayloads: { fullBooks: [], actions: [] },
      legacyPayloads: { fullBooks: [], actions: [before, after, missingTime] },
      authoritativeCheckpointTime: '2026-07-21T12:00:00Z',
    });

    expect(partition.uncoveredActions).toEqual([after, missingTime]);
    expect(partition.supersededActions).toEqual([before]);
    expect(partition.coverageGaps).toEqual([
      expect.objectContaining({
        sourceMessageId: 'after',
        eventTime: '2026-07-21T13:00:00.000Z',
      }),
      expect.objectContaining({
        sourceMessageId: 'missing-time',
        eventTime: null,
      }),
    ]);
    expect(partition.supersededCoverageGaps).toEqual([
      expect.objectContaining({
        sourceMessageId: 'before',
        eventTime: '2026-07-21T11:00:00.000Z',
      }),
    ]);
  });

  test('retains a legacy parse rejection until the canonical source sequence is complete', () => {
    const partialCanonical = buildEtfProPayloadsFromResearchEvents([
      event({
        eventTime: '2026-07-21T15:00:00Z',
        eventKey: '2026-07-21T15:00:00Z#action#0000',
        sourceMessageId: 'action',
        sourceEventCount: 2,
        eventType: 'POSITION_ACTION',
        payload: { ticker: 'QQQ', action: 'ADD', side: 'Long' },
      }),
    ]);
    const legacyRejection = {
      sourceMessageId: 'action',
      code: 'legacy-source-unparsed',
    };

    expect(partialCanonical.actions).toEqual([]);
    expect(partialCanonical.completeSourceMessageIds).toEqual([]);
    expect(partialCanonical.rejected[0].reasons).toEqual(expect.arrayContaining([
      'source-event-count-mismatch',
      'source-event-sequence-incomplete',
    ]));
    expect(filterLegacyRejectionsByCompleteCanonicalSources(
      [legacyRejection],
      partialCanonical.completeSourceMessageIds,
    )).toEqual([legacyRejection]);

    const completeCanonical = buildEtfProPayloadsFromResearchEvents([
      event({
        eventTime: '2026-07-21T15:00:00Z',
        eventKey: '2026-07-21T15:00:00Z#action#0000',
        sourceMessageId: 'action',
        sourceEventCount: 2,
        eventType: 'POSITION_ACTION',
        payload: { ticker: 'QQQ', action: 'ADD', side: 'Long' },
      }),
      event({
        eventTime: '2026-07-21T15:00:00Z',
        eventKey: '2026-07-21T15:00:00Z#action#0001',
        sourceMessageId: 'action',
        sequence: 1,
        sourceEventCount: 2,
        eventType: 'POSITION_ACTION',
        payload: { ticker: 'TLT', action: 'REMOVE', side: 'Short' },
      }),
    ]);

    expect(completeCanonical.completeSourceMessageIds).toEqual(['action']);
    expect(filterLegacyRejectionsByCompleteCanonicalSources(
      [legacyRejection],
      completeCanonical.completeSourceMessageIds,
    )).toEqual([]);
  });

  test('does not infer canonical completeness from an event-key suffix when sequence is absent', () => {
    const payloads = buildEtfProPayloadsFromResearchEvents([
      event({
        eventKey: '2026-07-21T15:00:00Z#action#0000',
        sourceMessageId: 'action',
        sequence: undefined,
        eventType: 'POSITION_ACTION',
        payload: { ticker: 'QQQ', action: 'ADD', side: 'Long' },
      }),
    ]);

    expect(payloads.completeSourceMessageIds).toEqual([]);
    expect(payloads.actions).toEqual([]);
    expect(payloads.rejected[0].reasons).toEqual(expect.arrayContaining([
      'sequence-missing',
      'source-event-sequence-incomplete',
    ]));
  });

  test('prefers V2 RTA events per source message and uses legacy only for migration gaps', () => {
    const v2 = materializeRtaResearchEvents([
      event({
        productKey: 'real-time-alert',
        eventType: 'POSITION_ACTION',
        payload: { ticker: 'PALL', action: 'SELL', intent: 'open-short', side: 'short' },
      }),
    ]);
    const legacy = {
      snapshots: [{
        date: '2026-07-21',
        data: { alerts: [
          {
            ticker: 'PALL',
            action: 'SELL',
            intent: 'open-short',
            side: 'short',
            eventTime: '2026-07-21T13:00:00Z',
            sourceMessageId: 'message-a',
          },
          { ticker: 'SPY', action: 'BUY', eventTime: '2026-07-21T14:00:00Z', sourceMessageId: 'legacy-only' },
        ] },
      }],
      rejected: [],
    };
    const merged = mergeRtaMaterializations(v2, legacy);
    const tickers = merged.snapshots.flatMap((snapshot) => snapshot.data.alerts.map((alert) => alert.ticker));

    expect(tickers).toEqual(['PALL', 'SPY']);
    expect(merged).toMatchObject({ v2EventCount: 1, legacyEventCount: 1, materializedEventCount: 2 });
    expect(merged.canonicalCoverageGaps).toEqual([
      expect.objectContaining({
        sourceMessageId: 'legacy-only',
        canonicalEventCount: 0,
        reason: 'canonical-source-message-missing',
      }),
    ]);
    expect(merged.snapshots[0].dataVersion).toMatch(/^research-replay-v3:/);
  });

  test('keeps legacy-only and unidentifiable RTA sources reference-only coverage gaps', () => {
    const v2 = materializeRtaResearchEvents([
      event({
        productKey: 'real-time-alert',
        eventType: 'POSITION_ACTION',
        payload: { ticker: 'PALL', action: 'SELL', intent: 'open-short', side: 'short' },
      }),
    ]);
    const legacy = {
      snapshots: [{
        date: '2026-07-21',
        data: {
          alerts: [
            {
              ticker: 'SPY',
              action: 'BUY',
              eventTime: '2026-07-21T14:00:00Z',
              sourceMessageId: 'legacy-only',
            },
            {
              ticker: 'QQQ',
              action: 'BUY',
              eventTime: '2026-07-21T15:00:00Z',
            },
          ],
        },
      }],
      rejected: [],
    };

    const merged = mergeRtaMaterializations(v2, legacy);

    expect(merged.canonicalCoverageGaps).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceMessageId: 'legacy-only',
        reason: 'canonical-source-message-missing',
      }),
      expect.objectContaining({
        sourceMessageId: null,
        reason: 'canonical-source-message-id-unavailable',
      }),
    ]));
  });

  test('RTA checkpoint floors retain post-checkpoint and untimestamped gaps and rejections', () => {
    const legacy = {
      snapshots: [{
        date: '2026-07-21',
        data: {
          alerts: [
            {
              ticker: 'SPY',
              action: 'BUY',
              eventTime: '2026-07-21T11:00:00Z',
              sourceMessageId: 'before',
            },
            {
              ticker: 'QQQ',
              action: 'BUY',
              eventTime: '2026-07-21T13:00:00Z',
              sourceMessageId: 'after',
            },
            {
              ticker: 'TLT',
              action: 'SELL',
              sourceMessageId: 'missing-time',
            },
          ],
        },
      }],
      rejected: [
        {
          sourceMessageId: 'rejected-before',
          code: 'legacy-source-unparsed',
          meta: { parsedAt: '2026-07-21T11:30:00Z' },
        },
        {
          sourceMessageId: 'rejected-after',
          code: 'legacy-source-unparsed',
          eventTime: '2026-07-21T13:30:00Z',
        },
        {
          sourceMessageId: 'rejected-missing-time',
          code: 'legacy-source-unparsed',
        },
      ],
    };

    const merged = mergeRtaMaterializations({}, legacy, {
      authoritativeCheckpointTime: '2026-07-21T12:00:00Z',
    });

    expect(merged.canonicalCoverageGaps.map((gap) => gap.sourceMessageId)).toEqual([
      'after',
      'missing-time',
    ]);
    expect(merged.supersededCanonicalCoverageGaps.map((gap) => gap.sourceMessageId)).toEqual([
      'before',
    ]);
    expect(merged.rejected.map((item) => item.sourceMessageId)).toEqual([
      'rejected-after',
      'rejected-missing-time',
    ]);
    expect(merged.supersededRejections.map((item) => item.sourceMessageId)).toEqual([
      'rejected-before',
    ]);
  });

  test('replaces a partially written canonical RTA message with its complete legacy actions and reports the gap', () => {
    const v2 = materializeRtaResearchEvents([
      event({
        productKey: 'real-time-alert',
        eventType: 'POSITION_ACTION',
        payload: { ticker: 'PALL', action: 'SELL', intent: 'open-short', side: 'short' },
      }),
    ]);
    const legacy = {
      snapshots: [{
        date: '2026-07-21',
        data: {
          alerts: [
            {
              ticker: 'PALL',
              action: 'SELL',
              intent: 'open-short',
              side: 'short',
              sourceMessageId: 'message-a',
            },
            {
              ticker: 'QQQ',
              action: 'BUY',
              intent: 'open-long',
              side: 'long',
              sourceMessageId: 'message-a',
            },
          ],
        },
      }],
      rejected: [],
    };

    const merged = mergeRtaMaterializations(v2, legacy);
    expect(merged.snapshots[0].data.alerts.map((alert) => alert.ticker)).toEqual(['PALL', 'QQQ']);
    expect(merged.canonicalCoverageGaps).toEqual([
      expect.objectContaining({
        sourceMessageId: 'message-a',
        legacyEventCount: 2,
        canonicalEventCount: 1,
      }),
    ]);
  });
});
