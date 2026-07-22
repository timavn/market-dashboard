const {
  buildEtfProPayloadsFromResearchEvents,
  materializeRtaResearchEvents,
  mergeRtaMaterializations,
  sortResearchEvents,
} = require('./researchEventLedger.cjs');
const { classifyEtfProRows, resolveEtfProPayloadFromSources } = require('./etfProResolver.cjs');

function event(overrides = {}) {
  return {
    productKey: 'etf-pro',
    eventKey: '2026-07-21T13:00:00Z#message-a#0000',
    eventTime: '2026-07-21T13:00:00Z',
    sourceMessageId: 'message-a',
    sequence: 0,
    eventType: 'FULL_BOOK_CHECKPOINT',
    payload: { rows: [{ ticker: 'SPY', call: 'Long' }] },
    eventHash: 'a'.repeat(64),
    parserVersion: 'research-event-ledger-v2',
    sourceArtifact: 'gmail/message-a.html',
    ...overrides,
  };
}

describe('ResearchEventLedgerV2 consumers', () => {
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
      eventType: 'POSITION_ACTION',
      payload: { ticker: 'TLT', action: 'REMOVE', side: 'Short' },
    });
    const add = event({
      eventTime: '2026-07-21T15:00:00Z',
      eventKey: '2026-07-21T15:00:00Z#action#0001',
      sourceMessageId: 'action',
      sequence: 1,
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
          { ticker: 'WRONG', action: 'BUY', eventTime: '2026-07-21T13:00:00Z', sourceMessageId: 'message-a' },
          { ticker: 'SPY', action: 'BUY', eventTime: '2026-07-21T14:00:00Z', sourceMessageId: 'legacy-only' },
        ] },
      }],
      rejected: [],
    };
    const merged = mergeRtaMaterializations(v2, legacy);
    const tickers = merged.snapshots.flatMap((snapshot) => snapshot.data.alerts.map((alert) => alert.ticker));

    expect(tickers).toEqual(['PALL', 'SPY']);
    expect(merged).toMatchObject({ v2EventCount: 1, legacyEventCount: 1, materializedEventCount: 2 });
    expect(merged.snapshots[0].dataVersion).toMatch(/^research-replay-v3:/);
  });
});
