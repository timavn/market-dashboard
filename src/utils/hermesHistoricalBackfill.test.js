const {
  buildHistoricalBackfillStatus,
} = require('./hermesHistoricalBackfill.cjs');

describe('Hermes historical Gmail backfill status', () => {
  test('exposes retained historical work without changing current-ingestion health', () => {
    const historicalBackfill = buildHistoricalBackfillStatus([
      {
        messageId: 'runtime#gmail#sanitized@example.com',
        attachmentId: 'historical-backfill-archive#sanitized',
        recordType: 'GMAIL_HISTORICAL_BACKFILL_ARCHIVE',
        status: 'ARCHIVED',
        immutable: true,
        reasonCode: 'GMAIL_HISTORICAL_BACKFILL_ARCHIVED',
        receiptId: 'receipt-a',
        archivedAt: '2026-08-07T17:00:00.000Z',
        queueTotalCount: 3725,
        queueCounts: {
          COMPLETED: 174,
          PENDING: 3539,
          RETRYABLE: 6,
          QUARANTINED: 6,
        },
      },
    ]);
    const currentIngestion = { status: 'success', errorCount: 0 };

    expect(historicalBackfill).toEqual({
      status: 'archived',
      archivedAt: '2026-08-07T17:00:00.000Z',
      reasonCode: 'GMAIL_HISTORICAL_BACKFILL_ARCHIVED',
      pendingCount: 3539,
      retryableCount: 6,
      quarantinedCount: 6,
      completedCount: 174,
      totalCount: 3725,
    });
    expect(currentIngestion.status).toBe('success');
  });

  test('returns null without a valid immutable archive audit row', () => {
    expect(buildHistoricalBackfillStatus([])).toBeNull();
    expect(buildHistoricalBackfillStatus([{ status: 'ARCHIVED' }])).toBeNull();
  });
});
