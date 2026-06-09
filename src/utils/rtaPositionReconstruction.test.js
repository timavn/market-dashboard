const {
  summarizeRealTimeAlertPositions,
} = require('./rtaPositionReconstruction.cjs');

describe('summarizeRealTimeAlertPositions', () => {
  test('removes a long when BUY is followed by a plain SELL', () => {
    const summary = summarizeRealTimeAlertPositions([
      { date: '2026-06-01', data: { alerts: [{ ticker: 'TBIL', action: 'BUY', name: 'TBIL' }] } },
      { date: '2026-06-02', data: { alerts: [{ ticker: 'TBIL', action: 'SELL', name: 'TBIL' }] } },
    ]);

    expect(summary.longCount).toBe(0);
    expect(summary.shortCount).toBe(0);
    expect(summary.available).toBe(false);
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
      { date: '2026-06-01', data: { alerts: [{ ticker: 'NCLH', action: 'SELL', name: 'NCLH' }] } },
      { date: '2026-06-02', data: { alerts: [{ ticker: 'NCLH', action: 'COVER', name: 'NCLH' }] } },
    ]);

    expect(summary.longCount).toBe(0);
    expect(summary.shortCount).toBe(0);
    expect(summary.available).toBe(false);
  });

  test('keeps repeated same-direction alerts idempotent', () => {
    const summary = summarizeRealTimeAlertPositions([
      { date: '2026-06-01', data: { alerts: [{ ticker: 'HYG', action: 'BUY', name: 'HYG' }] } },
      { date: '2026-06-02', data: { alerts: [{ ticker: 'HYG', action: 'BUY', name: 'HYG' }] } },
      { date: '2026-06-03', data: { alerts: [{ ticker: 'UVXY', action: 'SELL', name: 'UVXY' }] } },
      { date: '2026-06-04', data: { alerts: [{ ticker: 'UVXY', action: 'SELL', name: 'UVXY' }] } },
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

  test('keeps a long alive on SELL-SOME after BUY', () => {
    const summary = summarizeRealTimeAlertPositions([
      { date: '2026-06-01', data: { alerts: [{ ticker: 'SPY', action: 'BUY', name: 'SPY' }] } },
      { date: '2026-06-02', data: { alerts: [{ ticker: 'SPY', action: 'SELL-SOME', name: 'SPY' }] } },
    ]);

    expect(summary.longCount).toBe(1);
    expect(summary.shortCount).toBe(0);
    expect(summary.holdings[0]).toMatchObject({ ticker: 'SPY', side: 'long' });
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
});
