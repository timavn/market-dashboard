const { parseUrl } = require('./kalshiClient');

describe('Kalshi client query serialization', () => {
  test('serializes orderbook ticker arrays as repeated query parameters', () => {
    const { url } = parseUrl('https://example.test/trade-api/v2', '/markets/orderbooks', {
      tickers: ['ONE', 'TWO', 'THREE'],
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.getAll('tickers')).toEqual(['ONE', 'TWO', 'THREE']);
    expect(parsed.searchParams.get('tickers')).not.toContain(',');
  });
});
