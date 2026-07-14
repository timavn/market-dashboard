const {
  summarizeRealTimeAlertPositions,
} = require('./rtaPositionReconstruction.cjs');

describe('summarizeRealTimeAlertPositions', () => {
  test('flips a long to short when BUY is followed by a plain SELL', () => {
    const summary = summarizeRealTimeAlertPositions([
      { date: '2026-06-01', data: { alerts: [{ ticker: 'TBIL', action: 'BUY', name: 'TBIL' }] } },
      { date: '2026-06-02', data: { alerts: [{ ticker: 'TBIL', action: 'SELL', name: 'TBIL' }] } },
    ]);

    expect(summary.longCount).toBe(0);
    expect(summary.shortCount).toBe(1);
    expect(summary.available).toBe(true);
    expect(summary.holdings[0]).toMatchObject({ ticker: 'TBIL', side: 'short' });
    expect(summary.reconstructionWarnings).toEqual([]);
  });

  test('opens a short when SELL is explicitly shorting', () => {
    const summary = summarizeRealTimeAlertPositions([
      { date: '2026-06-01', data: { alerts: [{ ticker: 'WMT', action: 'SELL', intent: 'open-short', name: 'WMT' }] } },
    ]);

    expect(summary.longCount).toBe(0);
    expect(summary.shortCount).toBe(1);
    expect(summary.holdings[0]).toMatchObject({ ticker: 'WMT', side: 'short' });
  });

  test('removes a short when SELL is followed by COVER', () => {
    const summary = summarizeRealTimeAlertPositions([
      { date: '2026-06-01', data: { alerts: [{ ticker: 'NCLH', action: 'SELL', intent: 'open-short', name: 'NCLH' }] } },
      { date: '2026-06-02', data: { alerts: [{ ticker: 'NCLH', action: 'COVER', name: 'NCLH' }] } },
    ]);

    expect(summary.longCount).toBe(0);
    expect(summary.shortCount).toBe(0);
    expect(summary.available).toBe(false);
  });

  test('removes a short from the active RTA board when COVER-SOME fires', () => {
    const summary = summarizeRealTimeAlertPositions([
      { date: '2026-06-01', data: { alerts: [{ ticker: 'TAP', action: 'SELL', intent: 'open-short', name: 'TAP' }] } },
      { date: '2026-06-02', data: { alerts: [{ ticker: 'TAP', action: 'COVER-SOME', intent: 'close-short', name: 'TAP' }] } },
    ]);

    expect(summary.longCount).toBe(0);
    expect(summary.shortCount).toBe(0);
    expect(summary.holdings).toEqual([]);
  });

  test('keeps repeated same-direction alerts idempotent', () => {
    const summary = summarizeRealTimeAlertPositions([
      { date: '2026-06-01', data: { alerts: [{ ticker: 'HYG', action: 'BUY', name: 'HYG' }] } },
      { date: '2026-06-02', data: { alerts: [{ ticker: 'HYG', action: 'BUY', name: 'HYG' }] } },
      { date: '2026-06-03', data: { alerts: [{ ticker: 'UVXY', action: 'SELL', intent: 'open-short', name: 'UVXY' }] } },
      { date: '2026-06-04', data: { alerts: [{ ticker: 'UVXY', action: 'SELL', intent: 'open-short', name: 'UVXY' }] } },
    ]);

    expect(summary.longCount).toBe(1);
    expect(summary.shortCount).toBe(1);
    expect(summary.ratioText).toBe('1.0:1');
  });

  test('applies add/remove position changes by side', () => {
    const summary = summarizeRealTimeAlertPositions([
      { date: '2026-06-01', data: { alerts: [{ ticker: 'AMZN', action: 'ADD', side: 'long', name: 'AMZN' }] } },
      { date: '2026-06-02', data: { alerts: [{ ticker: 'AMZN', action: 'REMOVE', side: 'long', name: 'AMZN' }] } },
      { date: '2026-06-02', data: { alerts: [{ ticker: 'DDOG', action: 'ADD', side: 'long', name: 'DDOG' }] } },
    ]);

    expect(summary.longCount).toBe(1);
    expect(summary.shortCount).toBe(0);
    expect(summary.holdings[0]).toMatchObject({ ticker: 'DDOG', side: 'long' });
  });

  test('applies side-less removals and short position-change adds', () => {
    const summary = summarizeRealTimeAlertPositions([
      { date: '2026-06-01', data: { alerts: [{ ticker: 'SWBI', action: 'SELL', name: 'SWBI' }] } },
      { date: '2026-06-02', data: { alerts: [{ ticker: 'SWBI', action: 'REMOVE', name: 'SWBI' }] } },
      { date: '2026-06-02', data: { alerts: [{ ticker: 'AEO', action: 'ADD', side: 'short', name: 'AEO' }] } },
    ]);

    expect(summary.longCount).toBe(0);
    expect(summary.shortCount).toBe(1);
    expect(summary.holdings[0]).toMatchObject({ ticker: 'AEO', side: 'short' });
  });

  test('closes a long on SELL-SOME after BUY', () => {
    const summary = summarizeRealTimeAlertPositions([
      { date: '2026-06-01', data: { alerts: [{ ticker: 'SPY', action: 'BUY', name: 'SPY' }] } },
      { date: '2026-06-02', data: { alerts: [{ ticker: 'SPY', action: 'SELL-SOME', name: 'SPY' }] } },
    ]);

    expect(summary.longCount).toBe(0);
    expect(summary.shortCount).toBe(0);
    expect(summary.available).toBe(false);
  });

  test('ignores missing ticker alerts for counts', () => {
    const summary = summarizeRealTimeAlertPositions([
      { date: '2026-06-01', data: { alerts: [{ action: 'BUY', name: 'Mystery Alert' }] } },
      { date: '2026-06-02', data: { alerts: [{ ticker: 'IWM', action: 'BUY', name: 'IWM' }] } },
    ]);

    expect(summary.longCount).toBe(1);
    expect(summary.shortCount).toBe(0);
    expect(summary.holdings).toHaveLength(1);
  });

  test('opens a short from a plain unmatched SELL signal', () => {
    const summary = summarizeRealTimeAlertPositions([
      { date: '2026-06-01', data: { alerts: [{ ticker: 'SWBI', action: 'SELL', name: 'SWBI' }] } },
      { date: '2026-06-02', data: { alerts: [{ ticker: 'TAP', action: 'SELL', intent: 'open-short', name: 'TAP' }] } },
    ]);

    expect(summary.longCount).toBe(0);
    expect(summary.shortCount).toBe(2);
    expect(summary.holdings.map((holding) => holding.ticker)).toEqual(['SWBI', 'TAP']);
    expect(summary.holdings.every((holding) => holding.side === 'short')).toBe(true);
    expect(summary.reconstructionWarnings).toEqual([]);
  });

  test('matches Hedgeye screenshot state with zero longs and five shorts', () => {
    const summary = summarizeRealTimeAlertPositions([
      { date: '2026-06-05', data: { alerts: [{ ticker: 'IWM', action: 'BUY', name: 'iShares Russell 2000 ETF' }] } },
      { date: '2026-06-08', data: { alerts: [{ ticker: 'IWM', action: 'SELL-SOME', name: 'iShares Russell 2000 ETF' }] } },
      { date: '2026-06-08', data: { alerts: [{ ticker: 'DPZ', action: 'SELL', name: "Domino's Pizza" }] } },
      { date: '2026-06-09', data: { alerts: [{ ticker: 'TAP', action: 'SELL', name: 'Molson Coors' }] } },
      { date: '2026-06-09', data: { alerts: [{ ticker: 'PAWZ', action: 'SELL', name: 'ProShares Pet Care ETF' }] } },
      { date: '2026-06-10', data: { alerts: [{ ticker: 'BALL', action: 'SELL', name: 'Ball Corporation' }] } },
      { date: '2026-06-10', data: { alerts: [{ ticker: 'AEO', action: 'SELL', name: 'American Eagle Outfitters' }] } },
    ]);

    expect(summary.longCount).toBe(0);
    expect(summary.shortCount).toBe(5);
    expect(summary.netBias).toBe('short');
    expect(summary.ratioText).toBe('0:5');
    expect(summary.holdings).toEqual([
      expect.objectContaining({ ticker: 'AEO', side: 'short' }),
      expect.objectContaining({ ticker: 'BALL', side: 'short' }),
      expect.objectContaining({ ticker: 'DPZ', side: 'short' }),
      expect.objectContaining({ ticker: 'PAWZ', side: 'short' }),
      expect.objectContaining({ ticker: 'TAP', side: 'short' }),
    ]);
  });

  test('reconstructs current email sequence with PAWZ and DPZ covers', () => {
    const summary = summarizeRealTimeAlertPositions([
      { date: '2026-06-08', scrapedAt: '2026-06-08T19:05:02+00:00', data: { alerts: [{ ticker: 'DPZ', action: 'SELL', name: "Domino's Pizza" }] } },
      { date: '2026-06-09', scrapedAt: '2026-06-09T19:23:05+00:00', data: { alerts: [{ ticker: 'PAWZ', action: 'SELL', name: 'ProShares Pet Care ETF' }] } },
      { date: '2026-06-09', scrapedAt: '2026-06-09T19:46:04+00:00', data: { alerts: [{ ticker: 'TAP', action: 'SELL', name: 'Molson Coors' }] } },
      { date: '2026-06-10', scrapedAt: '2026-06-10T18:56:04+00:00', data: { alerts: [{ ticker: 'AEO', action: 'SELL', name: 'American Eagle Outfitters' }] } },
      { date: '2026-06-10', scrapedAt: '2026-06-10T19:01:21+00:00', data: { alerts: [
        { ticker: 'NCLH', action: 'REMOVE', side: 'short', name: 'NCLH' },
        { ticker: 'AEO', action: 'ADD', side: 'short', name: 'AEO' },
      ] } },
      { date: '2026-06-10', scrapedAt: '2026-06-10T19:03:05+00:00', data: { alerts: [{ ticker: 'BALL', action: 'SELL', name: 'Ball Corp' }] } },
      { date: '2026-06-11', scrapedAt: '2026-06-11T14:36:05+00:00', data: { alerts: [{ ticker: 'DPZ', action: 'COVER', name: "Domino's Pizza" }] } },
      { date: '2026-06-11', scrapedAt: '2026-06-11T15:08:05+00:00', data: { alerts: [{ ticker: 'CMG', action: 'SELL', name: 'Chipotle' }] } },
      { date: '2026-06-11', scrapedAt: '2026-06-11T15:13:02+00:00', data: { alerts: [{ ticker: 'PAWZ', action: 'COVER', name: 'PAWZ' }] } },
    ]);

    expect(summary.longCount).toBe(0);
    expect(summary.shortCount).toBe(4);
    expect(summary.ratioText).toBe('0:4');
    expect(summary.holdings.map((holding) => holding.ticker)).toEqual(['AEO', 'BALL', 'CMG', 'TAP']);
  });

  test('matches current RTA board with one long and five shorts after partial exits', () => {
    const summary = summarizeRealTimeAlertPositions([
      { date: '2026-06-08', data: { alerts: [{ ticker: 'TAP', action: 'SELL', name: 'Molson Coors' }] } },
      { date: '2026-06-09', data: { alerts: [{ ticker: 'TAP', action: 'COVER-SOME', intent: 'close-short', name: 'Molson Coors' }] } },
      { date: '2026-06-10', data: { alerts: [{ ticker: 'AEO', action: 'SELL', name: 'American Eagle Outfitters' }] } },
      { date: '2026-06-10', data: { alerts: [{ ticker: 'BALL', action: 'SELL', name: 'Ball Corporation' }] } },
      { date: '2026-06-11', data: { alerts: [{ ticker: 'CMG', action: 'SELL', name: 'Chipotle Mexican Grill' }] } },
      { date: '2026-06-11', data: { alerts: [{ ticker: 'VFC', action: 'SELL', name: 'V.F. Corporation' }] } },
      { date: '2026-06-12', data: { alerts: [{ ticker: 'EPHE', action: 'SELL', name: 'iShares MSCI Philippines ETF' }] } },
      { date: '2026-06-12', data: { alerts: [{ ticker: 'BRKR', action: 'BUY', name: 'Bruker Corporation' }] } },
    ]);

    expect(summary.longCount).toBe(1);
    expect(summary.shortCount).toBe(5);
    expect(summary.ratioText).toBe('0.2:1');
    expect(summary.holdings.map((holding) => holding.ticker)).toEqual([
      'BRKR',
      'AEO',
      'BALL',
      'CMG',
      'EPHE',
      'VFC',
    ]);
  });

  test('uses a current website benchmark as the starting board going forward', () => {
    const summary = summarizeRealTimeAlertPositions([
      { date: '2026-06-22', scrapedAt: '2026-06-22T14:32:02+00:00', data: { alerts: [{ ticker: 'CP', action: 'SELL', name: 'Canadian Pacific' }] } },
      { date: '2026-06-23', scrapedAt: '2026-06-23T19:48:03+00:00', data: { alerts: [{ ticker: 'UHS', action: 'ADD', side: 'short', name: 'Universal Health' }] } },
      { date: '2026-06-24', scrapedAt: '2026-06-24T14:00:00+00:00', data: { alerts: [{ ticker: 'NEWL', action: 'ADD', side: 'long', name: 'NEWL' }] } },
    ], {
      baseline: {
        id: 'rta-website-2026-06-23',
        asOf: '2026-06-23T19:48:03+00:00',
        source: 'manual-website-snapshot',
        longs: ['ATZAF', 'MDB', 'HQY'],
        shorts: ['UHS'],
      },
    });

    expect(summary.longCount).toBe(4);
    expect(summary.shortCount).toBe(1);
    expect(summary.baseline).toMatchObject({
      id: 'rta-website-2026-06-23',
      asOf: '2026-06-23T19:48:03+00:00',
      source: 'manual-website-snapshot',
    });
    expect(summary.holdings.map((holding) => holding.ticker)).toEqual(['ATZAF', 'HQY', 'MDB', 'NEWL', 'UHS']);
    expect(summary.holdings.find((holding) => holding.ticker === 'CP')).toBeUndefined();
  });

  test('uses the June 28 RTA screenshot benchmark as the starting board', () => {
    const summary = summarizeRealTimeAlertPositions([], {
      baseline: {
        id: 'rta-website-2026-06-28',
        asOf: '2026-06-28T00:00:00-07:00',
        source: 'manual-website-snapshot',
        longs: ['HLT'],
        shorts: ['KVYO', 'ROP', 'THC', 'RMD'],
      },
    });

    expect(summary.longCount).toBe(1);
    expect(summary.shortCount).toBe(4);
    expect(summary.baseline).toMatchObject({
      id: 'rta-website-2026-06-28',
      asOf: '2026-06-28T00:00:00-07:00',
      source: 'manual-website-snapshot',
    });
    expect(summary.holdings.map((holding) => holding.ticker)).toEqual(['HLT', 'KVYO', 'RMD', 'ROP', 'THC']);
  });

  test('ignores RTA alerts at or before the June 28 baseline and applies newer alerts', () => {
    const summary = summarizeRealTimeAlertPositions([
      {
        date: '2026-06-27',
        scrapedAt: '2026-06-27T20:00:00-07:00',
        data: { alerts: [{ ticker: 'OLD', action: 'ADD', side: 'long', name: 'Old Long' }] },
      },
      {
        date: '2026-06-28',
        scrapedAt: '2026-06-28T00:00:00-07:00',
        data: { alerts: [{ ticker: 'KVYO', action: 'REMOVE', side: 'short', name: 'Klaviyo' }] },
      },
      {
        date: '2026-06-28',
        scrapedAt: '2026-06-28T09:30:00-07:00',
        data: { alerts: [{ ticker: 'NEWW', action: 'BUY', name: 'New Winner' }] },
      },
      {
        date: '2026-06-28',
        scrapedAt: '2026-06-28T10:15:00-07:00',
        data: { alerts: [{ ticker: 'ROP', action: 'COVER', name: 'Roper Technologies' }] },
      },
      {
        date: '2026-06-28',
        scrapedAt: '2026-06-28T11:00:00-07:00',
        data: { alerts: [{ ticker: 'NEWS', action: 'SELL', name: 'New Short' }] },
      },
    ], {
      baseline: {
        id: 'rta-website-2026-06-28',
        asOf: '2026-06-28T00:00:00-07:00',
        source: 'manual-website-snapshot',
        longs: ['HLT'],
        shorts: ['KVYO', 'ROP', 'THC', 'RMD'],
      },
    });

    expect(summary.longCount).toBe(2);
    expect(summary.shortCount).toBe(4);
    expect(summary.holdings.map((holding) => holding.ticker)).toEqual(['HLT', 'NEWW', 'KVYO', 'NEWS', 'RMD', 'THC']);
    expect(summary.holdings.find((holding) => holding.ticker === 'OLD')).toBeUndefined();
    expect(summary.holdings.find((holding) => holding.ticker === 'ROP')).toBeUndefined();
  });
});
