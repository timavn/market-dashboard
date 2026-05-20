import {
  enrichSecurity,
  resolveSecuritiesListEntry,
  buildTradingDays,
  getTradingDayKeys,
  toDateKey,
} from './enrichSecurity';

describe('resolveSecuritiesListEntry', () => {
  it('finds ticker case-insensitively', () => {
    expect(resolveSecuritiesListEntry('spx')?.ticker).toBe('SPX');
    expect(resolveSecuritiesListEntry('BKLN')?.ticker).toBe('BKLN');
  });

  it('returns null for unknown symbols', () => {
    expect(resolveSecuritiesListEntry('NOT_A_TICKER')).toBeNull();
    expect(resolveSecuritiesListEntry(null)).toBeNull();
  });
});

describe('trading day helpers', () => {
  it('builds 10 weekday keys', () => {
    const days = buildTradingDays(10);
    const keys = getTradingDayKeys(days);
    expect(days).toHaveLength(10);
    expect(keys).toHaveLength(10);
    keys.forEach(k => expect(k).toMatch(/^\d{4}-\d{2}-\d{2}$/));
  });

  it('formats date keys in local time', () => {
    const d = new Date(2026, 4, 18);
    expect(toDateKey(d)).toBe('2026-05-18');
  });
});

describe('enrichSecurity', () => {
  const base = {
    ticker: 'SPY',
    name: 'S&P 500 (SPY)',
    assetClass: 'equity',
    bias: 'NEUTRAL',
  };

  const tradingDayKeys = ['2026-05-05', '2026-05-06', '2026-05-07'];

  it('aligns risk range history to trading day columns', () => {
    const enriched = enrichSecurity(base, {
      quote: { price: 500 },
      history: [
        { date: '2026-05-01', close: 490, high: 492, low: 488 },
        { date: '2026-05-02', close: 495, high: 497, low: 493 },
      ],
      riskHistoryItems: [
        { date: '2026-05-05', lrr: 480, hrr: 510, trend: 'BULLISH' },
        { date: '2026-05-07', lrr: 485, hrr: 515, trend: 'BULLISH', close: 502 },
      ],
      tradingDayKeys,
    });

    expect(enriched.price).toBe(500);
    expect(enriched.riskRangeHistory.hrr).toEqual([510, null, 515]);
    expect(enriched.riskRangeHistory.lrr).toEqual([480, null, 485]);
    expect(enriched.riskRangeHistory.prices[2]).toBe(502);
    expect(enriched.signal).toBe('BULLISH');
    expect(enriched.zScore).toBeNull();
  });

  it('uses live quote for last column price when risk row has no close', () => {
    const enriched = enrichSecurity(base, {
      quote: { price: 501 },
      history: [],
      riskHistoryItems: [{ date: '2026-05-07', lrr: 1, hrr: 2 }],
      tradingDayKeys: ['2026-05-07'],
    });

    expect(enriched.riskRangeHistory.prices[0]).toBe(501);
  });
});
