const {
  isExplicitRealTimeAlertItem,
  materializeRtaLedgerItems,
} = require('./rtaLedgerMaterialization.cjs');
const { summarizeRealTimeAlertPositions } = require('./rtaPositionReconstruction.cjs');

const BASELINE = {
  id: 'rta-website-2026-06-28',
  asOf: '2026-06-28T00:00:00-07:00',
  source: 'manual-website-snapshot',
  longs: ['HLT'],
  shorts: ['KVYO', 'ROP', 'THC', 'RMD'],
};

function storedMessage({ messageId, subject, receivedAt, snapshotDate, reportType = 'real-time-alert' }) {
  return {
    messageId,
    attachmentId: 'message-body-html-1',
    status: 'STORED',
    subject,
    receivedAt,
    snapshotDate,
    reportType,
    snapshotType: 'real-time-alert',
    s3Key: `${messageId}.html`,
  };
}

describe('RTA Gmail ledger materialization', () => {
  test('restores the Jul 2 PALL short before its Jul 8 cover', async () => {
    const items = [
      storedMessage({
        messageId: 'pall-cover',
        subject: '**Real-Time Alert: Macro Cover-SOME Signal (longest standing Macro Short): PALL -KM',
        receivedAt: '2026-07-08T14:05:02Z',
        snapshotDate: '2026-07-08',
      }),
      storedMessage({
        messageId: 'pall-open',
        subject: "**Real-Time Alert: Macro Sell Signal (Commodites getting #Quad4'd): Palladium (PALL) -KM",
        receivedAt: '2026-07-02T18:50:02Z',
        snapshotDate: '2026-07-02',
      }),
    ];

    const materialized = await materializeRtaLedgerItems(items, {
      getArtifactText: async (item) => item.messageId === 'pall-open'
        ? '<div class="headline">SELL SIGNAL - SHORTING PALL</div>'
        : '<div class="headline">BUY SIGNAL - COVERING SHORT PALL</div>',
    });
    const summary = summarizeRealTimeAlertPositions(materialized.snapshots, { baseline: BASELINE });

    expect(materialized.snapshots.map((snapshot) => snapshot.date)).toEqual(['2026-07-02', '2026-07-08']);
    expect(summary.available).toBe(true);
    expect(summary.dataQuality.invalidEvents).toEqual([]);
    expect(summary.holdings.find((holding) => holding.ticker === 'PALL')).toBeUndefined();
  });

  test('excludes generic Investing Ideas position changes even when legacy metadata calls them RTA', async () => {
    const sxt = storedMessage({
      messageId: 'sxt-remove',
      subject: '3 Changes: Remove SXT, SJM, Add GTLB',
      receivedAt: '2026-07-16T19:21:55Z',
      snapshotDate: '2026-07-16',
      reportType: 'unknown',
    });

    expect(isExplicitRealTimeAlertItem(sxt)).toBe(false);
    const materialized = await materializeRtaLedgerItems([sxt]);
    expect(materialized).toMatchObject({ snapshots: [], selectedMessageCount: 0, materializedEventCount: 0 });
  });

  test('aggregates every same-day message in deterministic chronological order', async () => {
    const later = storedMessage({
      messageId: 'later',
      subject: '**Real-Time Alert: Buy Signal: Apple (AAPL)',
      receivedAt: '2026-07-02T18:58:09Z',
      snapshotDate: '2026-07-02',
    });
    const earlier = storedMessage({
      messageId: 'earlier',
      subject: '**Real-Time Alert: Sell Signal: Microsoft (MSFT)',
      receivedAt: '2026-07-02T18:50:02Z',
      snapshotDate: '2026-07-02',
    });

    const first = await materializeRtaLedgerItems([later, earlier]);
    const second = await materializeRtaLedgerItems([earlier, later]);

    expect(first).toEqual(second);
    expect(first.snapshots[0].itemCount).toBe(2);
    expect(first.snapshots[0].sourceMessageIds).toEqual(['earlier', 'later']);
    expect(first.snapshots[0].data.alerts.map((alert) => alert.ticker)).toEqual(['MSFT', 'AAPL']);
    expect(first.snapshots[0].dataVersion).toMatch(/^gmail-ledger-v2:/);
  });

  test('fails closed when an explicit source message cannot be parsed', async () => {
    const malformed = storedMessage({
      messageId: 'bad-message',
      subject: '**Real-Time Alert: malformed',
      receivedAt: '2026-07-02T18:50:02Z',
      snapshotDate: '2026-07-02',
    });
    const result = await materializeRtaLedgerItems([malformed]);

    expect(result.snapshots).toEqual([]);
    expect(result.rejected).toEqual([
      expect.objectContaining({ messageId: 'bad-message', code: 'unparsed-rta-message' }),
    ]);
  });
});
