const { getFreshCachedQuote } = require('../quoteCachePolicy.cjs');

describe('quote cache live-data policy', () => {
  test('returns a TTL-valid quote', () => {
    const cache = new Map([['SPY', { timestamp: 1000, data: { price: '500.00' } }]]);
    expect(getFreshCachedQuote(cache, 'SPY', 1500, 1000)).toEqual({ price: '500.00' });
  });

  test('drops an expired quote instead of returning it as provider fallback', () => {
    const cache = new Map([['SPY', { timestamp: 1000, data: { price: '500.00' } }]]);
    expect(getFreshCachedQuote(cache, 'SPY', 2000, 1000)).toBeNull();
    expect(cache.has('SPY')).toBe(false);
  });

  test('rejects malformed or non-priced cache entries', () => {
    const cache = new Map([
      ['BAD_TIME', { timestamp: null, data: { price: '500.00' } }],
      ['NO_PRICE', { timestamp: 1000, data: {} }],
    ]);
    expect(getFreshCachedQuote(cache, 'BAD_TIME', 1200, 1000)).toBeNull();
    expect(getFreshCachedQuote(cache, 'NO_PRICE', 1200, 1000)).toBeNull();
  });
});
