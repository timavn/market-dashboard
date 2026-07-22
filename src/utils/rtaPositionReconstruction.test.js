const {
  summarizeRealTimeAlertPositions,
} = require('./rtaPositionReconstruction.cjs');

const JUNE_28_BASELINE = {
  id: 'rta-website-2026-06-28',
  asOf: '2026-06-28T00:00:00-07:00',
  source: 'manual-website-snapshot',
  longs: ['HLT'],
  shorts: ['KVYO', 'ROP', 'THC', 'RMD'],
};

function snapshot(date, alert, scrapedAt = null) {
  return {
    date,
    ...(scrapedAt ? { scrapedAt } : {}),
    data: { alerts: Array.isArray(alert) ? alert : [alert] },
  };
}

describe('summarizeRealTimeAlertPositions', () => {
  test('closes an existing long on a plain SELL instead of manufacturing a short', () => {
    const summary = summarizeRealTimeAlertPositions([
      snapshot('2026-06-01', { ticker: 'TBIL', action: 'BUY' }),
      snapshot('2026-06-02', { ticker: 'TBIL', action: 'SELL' }),
    ]);

    expect(summary).toMatchObject({
      available: true,
      longCount: 0,
      shortCount: 0,
      ratioText: 'No holdings',
      holdings: [],
      dataQuality: { status: 'ok', warnings: [] },
    });
  });

  test('lets a stored plain SELL phrase override stale open-short metadata', () => {
    const summary = summarizeRealTimeAlertPositions([
      snapshot('2026-07-01', {
        ticker: 'HLT',
        action: 'SELL',
        intent: 'open-short',
        side: 'short',
        signalPhrase: 'SELL SIGNAL HLT',
      }),
    ], { baseline: JUNE_28_BASELINE });

    expect(summary.available).toBe(true);
    expect(summary.longCount).toBe(0);
    expect(summary.shortCount).toBe(4);
    expect(summary.holdings.find((holding) => holding.ticker === 'HLT')).toBeUndefined();
  });

  test('flips an existing long only when SELL explicitly opens a short', () => {
    const summary = summarizeRealTimeAlertPositions([
      snapshot('2026-06-01', { ticker: 'WMT', action: 'BUY' }),
      snapshot('2026-06-02', {
        ticker: 'WMT',
        action: 'SELL',
        signalPhrase: 'SELL SIGNAL - SHORTING WMT',
      }),
    ]);

    expect(summary.longCount).toBe(0);
    expect(summary.shortCount).toBe(1);
    expect(summary.holdings).toEqual([expect.objectContaining({ ticker: 'WMT', side: 'short' })]);
  });

  test('closes an existing short on a plain BUY', () => {
    const summary = summarizeRealTimeAlertPositions([
      snapshot('2026-06-01', { ticker: 'WMT', action: 'SELL', intent: 'open-short' }),
      snapshot('2026-06-02', { ticker: 'WMT', action: 'BUY' }),
    ]);

    expect(summary.available).toBe(true);
    expect(summary.longCount).toBe(0);
    expect(summary.shortCount).toBe(0);
  });

  test('flips an existing short only when BUY explicitly opens a long', () => {
    const summary = summarizeRealTimeAlertPositions([
      snapshot('2026-06-01', { ticker: 'WMT', action: 'SELL', intent: 'open-short' }),
      snapshot('2026-06-02', {
        ticker: 'WMT',
        action: 'BUY',
        signalPhrase: 'BUY SIGNAL - BUYING WMT',
      }),
    ]);

    expect(summary.longCount).toBe(1);
    expect(summary.shortCount).toBe(0);
    expect(summary.holdings).toEqual([expect.objectContaining({ ticker: 'WMT', side: 'long' })]);
  });

  test('opens unheld plain BUY and SELL signals on their natural sides', () => {
    const summary = summarizeRealTimeAlertPositions([
      snapshot('2026-06-01', { ticker: 'BRKR', action: 'BUY' }),
      snapshot('2026-06-02', { ticker: 'SWBI', action: 'SELL' }),
    ]);

    expect(summary.longCount).toBe(1);
    expect(summary.shortCount).toBe(1);
    expect(summary.holdings).toEqual([
      expect.objectContaining({ ticker: 'BRKR', side: 'long' }),
      expect.objectContaining({ ticker: 'SWBI', side: 'short' }),
    ]);
  });

  test('repairs a malformed COVERING SHORT alert from its complete signal phrase', () => {
    const summary = summarizeRealTimeAlertPositions([
      snapshot('2026-07-01', {
        ticker: 'SHORT',
        action: 'BUY',
        signalPhrase: 'BUY SIGNAL - COVERING SHORT KVYO',
        headline: 'Real-Time Alert: BUY SIGNAL - COVERING SHORT KVYO',
      }, '2026-07-01T10:00:00-07:00'),
    ], { baseline: JUNE_28_BASELINE });

    expect(summary.available).toBe(true);
    expect(summary.dataQuality.status).toBe('ok');
    expect(summary.longCount).toBe(1);
    expect(summary.shortCount).toBe(3);
    expect(summary.holdings.map((holding) => holding.ticker)).toEqual(['HLT', 'RMD', 'ROP', 'THC']);
    expect(summary.holdings.find((holding) => holding.ticker === 'SHORT')).toBeUndefined();
  });

  test('rejects reserved ticker tokens when the complete alert cannot repair them', () => {
    const summary = summarizeRealTimeAlertPositions([
      snapshot('2026-07-01', {
        ticker: 'SHORT',
        action: 'BUY',
        signalPhrase: 'BUY SIGNAL - COVERING SHORT',
      }),
    ], { baseline: JUNE_28_BASELINE });

    expect(summary.available).toBe(false);
    expect(summary.longCount).toBeNull();
    expect(summary.shortCount).toBeNull();
    expect(summary.holdings).toEqual([]);
    expect(summary.dataQuality.status).toBe('error');
    expect(summary.dataQuality.invalidEvents).toEqual([
      expect.objectContaining({ code: 'malformed-ticker', ticker: 'SHORT' }),
    ]);
  });

  test('fails closed for an unmatched explicit cover', () => {
    const summary = summarizeRealTimeAlertPositions([
      snapshot('2026-06-01', { ticker: 'DPZ', action: 'COVER' }),
    ]);

    expect(summary).toMatchObject({
      available: false,
      longCount: null,
      shortCount: null,
      ratioText: null,
      netBias: null,
      holdings: [],
      dataQuality: { status: 'error' },
    });
    expect(summary.dataQuality.invalidEvents[0]).toMatchObject({ code: 'unmatched-cover', ticker: 'DPZ' });
  });

  test('fails closed for an unmatched explicit remove', () => {
    const summary = summarizeRealTimeAlertPositions([
      snapshot('2026-06-01', { ticker: 'NCLH', action: 'REMOVE', side: 'short' }),
    ]);

    expect(summary.available).toBe(false);
    expect(summary.dataQuality.invalidEvents[0]).toMatchObject({ code: 'unmatched-remove', ticker: 'NCLH' });
  });

  test('fails closed when an explicit close conflicts with the active side', () => {
    const summary = summarizeRealTimeAlertPositions([
      snapshot('2026-06-01', { ticker: 'SPY', action: 'BUY' }),
      snapshot('2026-06-02', { ticker: 'SPY', action: 'COVER' }),
    ]);

    expect(summary.available).toBe(false);
    expect(summary.dataQuality.invalidEvents).toEqual([
      expect.objectContaining({ code: 'side-mismatch', ticker: 'SPY' }),
    ]);
  });

  test('uses eventTime, then snapshot scrapedAt, then date around a same-day baseline', () => {
    const summary = summarizeRealTimeAlertPositions([
      snapshot(
        '2026-06-28',
        { ticker: 'IGNORED', action: 'BUY', eventTime: '2026-06-28T00:00:00-07:00' },
        '2026-06-28T12:00:00-07:00',
      ),
      snapshot(
        '2026-06-28',
        { ticker: 'NEWW', action: 'BUY' },
        '2026-06-28T09:30:00-07:00',
      ),
      snapshot(
        '2026-06-28',
        { ticker: 'ROP', action: 'COVER' },
        '2026-06-28T10:15:00-07:00',
      ),
    ], { baseline: JUNE_28_BASELINE });

    expect(summary.available).toBe(true);
    expect(summary.longCount).toBe(2);
    expect(summary.shortCount).toBe(3);
    expect(summary.holdings.map((holding) => holding.ticker)).toEqual(['HLT', 'NEWW', 'KVYO', 'RMD', 'THC']);
    expect(summary.holdings.find((holding) => holding.ticker === 'IGNORED')).toBeUndefined();
  });

  test('replays all events globally in timestamp order rather than snapshot input order', () => {
    const summary = summarizeRealTimeAlertPositions([
      snapshot('2026-06-02', { ticker: 'DPZ', action: 'COVER', eventTime: '2026-06-02T15:00:00Z' }),
      snapshot('2026-06-01', { ticker: 'DPZ', action: 'SELL', eventTime: '2026-06-01T15:00:00Z' }),
    ]);

    expect(summary.available).toBe(true);
    expect(summary.longCount).toBe(0);
    expect(summary.shortCount).toBe(0);
    expect(summary.dataQuality.status).toBe('ok');
  });

  test('deduplicates a repeated source message before applying its close twice', () => {
    const summary = summarizeRealTimeAlertPositions([
      snapshot('2026-07-01', {
        ticker: 'KVYO',
        action: 'COVER',
        sourceMessageId: 'message-123',
        eventTime: '2026-07-01T10:00:00-07:00',
      }),
      snapshot('2026-07-02', {
        ticker: 'KVYO',
        action: 'COVER',
        sourceMessageId: 'message-123',
        eventTime: '2026-07-02T10:00:00-07:00',
      }),
    ], { baseline: JUNE_28_BASELINE });

    expect(summary.available).toBe(true);
    expect(summary.shortCount).toBe(3);
    expect(summary.dataQuality).toMatchObject({
      status: 'ok',
      processedEventCount: 1,
      deduplicatedEventCount: 1,
    });
  });

  test('deduplicates an exact repeated event without a source message id', () => {
    const repeated = {
      ticker: 'KVYO',
      action: 'COVER',
      eventTime: '2026-07-01T10:00:00-07:00',
      signalPhrase: 'BUY SIGNAL - COVERING SHORT KVYO',
    };
    const summary = summarizeRealTimeAlertPositions([
      snapshot('2026-07-01', repeated),
      snapshot('2026-07-01', { ...repeated }),
    ], { baseline: JUNE_28_BASELINE });

    expect(summary.available).toBe(true);
    expect(summary.shortCount).toBe(3);
    expect(summary.dataQuality.deduplicatedEventCount).toBe(1);
  });

  test('keeps the official baseline as the authoritative starting board', () => {
    const summary = summarizeRealTimeAlertPositions([
      snapshot('2026-06-27', { ticker: 'OLD', action: 'BUY' }, '2026-06-27T20:00:00-07:00'),
      snapshot('2026-06-28', { ticker: 'KVYO', action: 'REMOVE', side: 'short' }, '2026-06-28T00:00:00-07:00'),
      snapshot('2026-06-29', { ticker: 'NEWS', action: 'SELL' }, '2026-06-29T11:00:00-07:00'),
    ], { baseline: JUNE_28_BASELINE });

    expect(summary.available).toBe(true);
    expect(summary.baseline).toMatchObject({
      id: JUNE_28_BASELINE.id,
      asOf: JUNE_28_BASELINE.asOf,
      source: JUNE_28_BASELINE.source,
    });
    expect(summary.longCount).toBe(1);
    expect(summary.shortCount).toBe(5);
    expect(summary.holdings.find((holding) => holding.ticker === 'OLD')).toBeUndefined();
    expect(summary.holdings.find((holding) => holding.ticker === 'KVYO')).toBeDefined();
  });

  test('marks a stored-style sequence unavailable when history contains an unmatched close', () => {
    const summary = summarizeRealTimeAlertPositions([
      snapshot('2026-07-01', {
        ticker: 'SHORT',
        action: 'BUY',
        signalPhrase: 'BUY SIGNAL - COVERING SHORT KVYO',
      }),
      snapshot('2026-07-02', { ticker: 'HLT', action: 'SELL' }),
      snapshot('2026-07-03', { ticker: 'NCLH', action: 'REMOVE', side: 'short' }),
      snapshot('2026-07-04', { ticker: 'NEWS', action: 'SELL' }),
    ], { baseline: JUNE_28_BASELINE });

    expect(summary.available).toBe(false);
    expect(summary.longCount).toBeNull();
    expect(summary.shortCount).toBeNull();
    expect(summary.holdings).toEqual([]);
    expect(summary.dataQuality.invalidEvents).toEqual([
      expect.objectContaining({ code: 'unmatched-remove', ticker: 'NCLH' }),
    ]);
  });

  test('treats a missing ticker as malformed rather than silently ignoring it', () => {
    const summary = summarizeRealTimeAlertPositions([
      snapshot('2026-06-01', { action: 'BUY', name: 'Mystery Alert' }),
      snapshot('2026-06-02', { ticker: 'IWM', action: 'BUY' }),
    ]);

    expect(summary.available).toBe(false);
    expect(summary.longCount).toBeNull();
    expect(summary.dataQuality.invalidEvents[0]).toMatchObject({ code: 'malformed-ticker' });
  });

  test('applies clean position-change adds and removals by side', () => {
    const summary = summarizeRealTimeAlertPositions([
      snapshot('2026-06-01', { ticker: 'AMZN', action: 'ADD', side: 'long' }),
      snapshot('2026-06-02', { ticker: 'AMZN', action: 'REMOVE', side: 'long' }),
      snapshot('2026-06-03', { ticker: 'AEO', action: 'ADD', side: 'short' }),
    ]);

    expect(summary.available).toBe(true);
    expect(summary.longCount).toBe(0);
    expect(summary.shortCount).toBe(1);
    expect(summary.holdings).toEqual([expect.objectContaining({ ticker: 'AEO', side: 'short' })]);
  });

  test('returns a standardized unavailable response when there is no source data', () => {
    const summary = summarizeRealTimeAlertPositions([]);

    expect(summary).toMatchObject({
      available: false,
      longCount: null,
      shortCount: null,
      ratioText: null,
      netBias: null,
      holdings: [],
      dataQuality: {
        status: 'unavailable',
        warnings: [],
        invalidEvents: [],
        processedEventCount: 0,
        deduplicatedEventCount: 0,
      },
    });
  });
});
