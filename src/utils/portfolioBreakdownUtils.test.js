import {
  getLongShortPositionSnapshot,
  separateLongsAndShorts,
} from './portfolioBreakdownUtils';

describe('getLongShortPositionSnapshot', () => {
  test('uses market value before quantity when classifying positions', () => {
    const holdings = [
      { symbol: 'LONG_BY_VALUE', quantity: -100, marketValue: 5000 },
      { symbol: 'SHORT_BY_VALUE', quantity: 100, marketValue: -2500 },
      { symbol: 'LONG_BY_QTY', quantity: 10, marketValue: 0 },
      { symbol: 'SHORT_BY_QTY', quantity: -20, marketValue: 0 },
      { symbol: 'ZERO_ROW', quantity: 0, marketValue: 0 },
    ];

    const snapshot = getLongShortPositionSnapshot(holdings);

    expect(snapshot.longCount).toBe(2);
    expect(snapshot.shortCount).toBe(2);
    expect(snapshot.longs.map((holding) => holding.symbol)).toEqual([
      'LONG_BY_VALUE',
      'LONG_BY_QTY',
    ]);
    expect(snapshot.shorts.map((holding) => holding.symbol)).toEqual([
      'SHORT_BY_VALUE',
      'SHORT_BY_QTY',
    ]);
  });

  test('keeps legacy separateLongsAndShorts behavior backed by the shared helper', () => {
    const result = separateLongsAndShorts([
      { symbol: 'A', quantity: 1, marketValue: 0 },
      { symbol: 'B', quantity: -1, marketValue: 0 },
    ]);

    expect(result).toEqual({
      longs: [{ symbol: 'A', quantity: 1, marketValue: 0 }],
      shorts: [{ symbol: 'B', quantity: -1, marketValue: 0 }],
    });
  });
});
