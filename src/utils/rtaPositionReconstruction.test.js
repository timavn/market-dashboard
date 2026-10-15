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

  test('flags an unmatched explicit cover without discarding the rest of the book', () => {
    const summary = summarizeRealTimeAlertPositions([
      snapshot('2026-06-01', { ticker: 'IWM', action: 'BUY' }),
      snapshot('2026-06-02', { ticker: 'DPZ', action: 'COVER' }),
    ]);

    expect(summary).toMatchObject({
      available: true,
      longCount: 1,
      shortCount: 0,
      positionSourceConfidence: 'medium',
      dataQuality: { status: 'warn', invalidEvents: [] },
    });
    expect(summary.holdings.map((holding) => holding.ticker)).toEqual(['IWM']);
    expect(summary.dataQuality.unresolvedEvents[0]).toMatchObject({ code: 'unmatched-cover', ticker: 'DPZ' });
    expect(summary.dataQuality.warnings).toContain('RTA cover for DPZ does not match an active short.');
  });

  test('flags an unmatched explicit remove', () => {
    const summary = summarizeRealTimeAlertPositions([
      snapshot('2026-06-01', { ticker: 'NCLH', action: 'REMOVE', side: 'short' }),
    ]);

    expect(summary.available).toBe(true);
    expect(summary.dataQuality.status).toBe('warn');
    expect(summary.dataQuality.unresolvedEvents[0]).toMatchObject({ code: 'unmatched-remove', ticker: 'NCLH' });
  });

  test('withholds only the ticker whose explicit close conflicts with its active side', () => {
    const summary = summarizeRealTimeAlertPositions([
      snapshot('2026-06-01', { ticker: 'SPY', action: 'BUY' }),
      snapshot('2026-06-01', { ticker: 'QQQ', action: 'BUY' }),
      snapshot('2026-06-02', { ticker: 'SPY', action: 'COVER' }),
    ]);

    expect(summary.available).toBe(true);
    expect(summary.holdings.map((holding) => holding.ticker)).toEqual(['QQQ']);
    expect(summary.dataQuality.status).toBe('warn');
    expect(summary.dataQuality.invalidEvents).toEqual([]);
    expect(summary.dataQuality.unresolvedEvents).toEqual([
      expect.objectContaining({ code: 'side-mismatch', ticker: 'SPY' }),
    ]);
  });

  test('a user-confirmed flat resolution settles that exact conflicting alert without a warning', () => {
    const alerts = [
      snapshot('2026-06-01', { ticker: 'SPY', action: 'BUY' }),
      snapshot('2026-06-01', { ticker: 'QQQ', action: 'BUY' }),
      snapshot('2026-06-02', { ticker: 'SPY', action: 'COVER', sourceMessageId: 'cover-message' }),
    ];
    const resolutions = [{ ticker: 'SPY', position: 'flat', sourceMessageId: 'cover-message',
      resolvedAt: '2026-06-03T00:00:00Z', resolvedBy: 'user' }];
    const summary = summarizeRealTimeAlertPositions(alerts, { resolutions });

    expect(summary.dataQuality.status).toBe('ok');
    expect(summary.dataQuality.warnings).toEqual([]);
    expect(summary.holdings.map((holding) => holding.ticker)).toEqual(['QQQ']);
    expect(summary.dataQuality.resolvedEvents).toEqual([
      expect.objectContaining({ ticker: 'SPY', code: 'side-mismatch', resolution: expect.objectContaining({ resolvedBy: 'user' }) }),
    ]);
    const other = summarizeRealTimeAlertPositions(alerts, { resolutions: [{ ...resolutions[0], sourceMessageId: 'another-alert' }] });
    expect(other.dataQuality.status).toBe('warn');
  });

  test('reads current quipped headlines by their signal verb, never by words in the quip', () => {
    const summary = summarizeRealTimeAlertPositions([
      snapshot('2026-09-01', { ticker: 'WMT', action: 'SELL',
        headline: "Real-Time Alert: Biolsi Sell Signal (WHEN I'm NOT buying): Walmart (WMT) -KM" }),
      snapshot('2026-09-02', { ticker: 'PBR', action: 'BUY',
        headline: 'Real-Time Alert: Jonesy Buy Signal (For The Fam!): Petrobras (PBR) -KM' }),
      snapshot('2026-09-03', { ticker: 'PBR', action: null,
        headline: 'Real-Time Alert: Book-SOME Signal (Energy Alpha vs. Consumer): PBR -KM' }),
      snapshot('2026-09-04', { ticker: 'EWL', action: 'SELL',
        headline: 'Real-Time Alert: Macro Sell Signal (Macro Hedging): Switzerland (EWL) -KM' }),
    ]);

    expect(summary.dataQuality.status).toBe('ok');
    expect(summary.holdings.map(({ ticker, side }) => `${ticker}:${side}`)).toEqual(['EWL:short', 'WMT:short']);
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

  test('flags a stored-style sequence whose history contains an unmatched close', () => {
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

    expect(summary.available).toBe(true);
    expect(summary.dataQuality.status).toBe('warn');
    expect(summary.dataQuality.invalidEvents).toEqual([]);
    expect(summary.dataQuality.unresolvedEvents).toEqual([
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
