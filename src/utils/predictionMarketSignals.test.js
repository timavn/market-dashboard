import {
  inferPredictionSignalCategory,
  normalizePredictionMarketSignals,
} from './predictionMarketSignals';

describe('inferPredictionSignalCategory', () => {
  test('uses the active filter when set', () => {
    expect(inferPredictionSignalCategory('Rates', { question: 'Bitcoin above 100k?' })).toBe('Rates');
  });

  test('infers crypto from the selected event text', () => {
    expect(inferPredictionSignalCategory('all', { question: 'Will Bitcoin close above $100,000?' })).toBe('Crypto');
  });
});

describe('normalizePredictionMarketSignals', () => {
  test('merges Bitcoin tracker and risk ranges for crypto rows', () => {
    const result = normalizePredictionMarketSignals({
      activeCategory: 'Crypto',
      riskRanges: {
        BTC: { lrr: 100000, hrr: 110000, trend: 'BULLISH', date: '2026-05-16' },
      },
      bitcoinSnapshot: {
        date: '2026-05-16',
        data: {
          cryptos: {
            BTC: { price: 105000, buyTrade: 101000, sellTrade: 112000, trend: 'BULLISH' },
          },
        },
      },
    });

    expect(result.category).toBe('Crypto');
    expect(result.rows).toHaveLength(4);
    expect(result.rows[0]).toMatchObject({
      symbol: 'BTC',
      trend: 'BULLISH',
      lrr: 100000,
      hrr: 110000,
      buyTrade: 101000,
      sellTrade: 112000,
    });
  });

  test('uses a broad macro universe for inflation events', () => {
    const result = normalizePredictionMarketSignals({
      activeCategory: 'Inflation',
      riskRanges: {
        GOLD: { lrr: 3000, hrr: 3300, trend: 'BULLISH' },
        UST10Y: { lrr: 4.2, hrr: 4.7, trend: 'BEARISH' },
      },
    });

    const symbols = result.rows.map(row => row.symbol);
    expect(symbols).toContain('GOLD');
    expect(symbols).toContain('UST10Y');
    expect(symbols).toContain('SPX');
    expect(symbols).not.toContain('BTC');
  });
});
