import { delayedMarkerMarketContext, sourceMarketSessionDate } from './delayedMarkerMarketContext';

test.each(['BTC', 'ETH', 'BNB', 'XRP', 'SOL', 'ADA', 'DOGE', 'LINK', 'BTC-USD'])('%s uses the verified instrument catalog continuous-market rule', (symbol) => {
  expect(delayedMarkerMarketContext({ symbol }).continuous).toBe(true);
});

test('preserves the provider session metadata and original observation', () => {
  const quote = Object.freeze({
    symbol: 'SPX', sessionDate: '2026-10-06', quoteAsOf: '2026-10-07T01:00:00Z',
    marketSession: { timeZone: 'America/New_York', openTime: '09:30', calendar: 'US' },
  });
  expect(delayedMarkerMarketContext(quote)).toMatchObject({
    marketSessionDate: '2026-10-06', marketTimeZone: 'America/New_York',
    marketOpenTime: '09:30', marketCalendar: 'US', continuous: false,
  });
  expect(quote.quoteAsOf).toBe('2026-10-07T01:00:00Z');
});

test('classifies prediction-market Bitcoin from its structured market configuration', () => {
  expect(delayedMarkerMarketContext({ value: 83000 }, { symbol: 'BTC', chartCalendar: 'continuous' }))
    .toMatchObject({ continuous: true });
  expect(delayedMarkerMarketContext({ symbol: 'BITVX' }).continuous).toBe(false);
});

test.each([
  ['N225', 'Asia/Tokyo', '09:00'],
  ['HSI', 'Asia/Hong_Kong', '09:30'],
  ['FTSE', 'Europe/London', '08:00'],
  ['KOSPI', 'Asia/Seoul', '09:00'],
  ['AXJO', 'Australia/Sydney', '10:00'],
])('uses %s local market opening for delayed colors', (symbol, marketTimeZone, marketOpenTime) => {
  expect(delayedMarkerMarketContext({ symbol })).toMatchObject({ marketTimeZone, marketOpenTime });
});

test('keeps historical date encodings on their source session rather than the quote session', () => {
  expect(sourceMarketSessionDate('2026-10-06')).toBe('2026-10-06');
  expect(sourceMarketSessionDate('2026-10-06T00:00:00.000Z')).toBe('2026-10-06');
  expect(sourceMarketSessionDate('2026-10-06T19:30:00.000Z')).toBeNull();
});
