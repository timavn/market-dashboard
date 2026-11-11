import { GLOBAL_MARKETS, getMarketStatus } from './globalMarkets';

const market = (id) => GLOBAL_MARKETS.find((entry) => entry.id === id);
// getMarketStatus receives a Date whose local fields are the market's own time.
const at = (year, month, day, hour, minute = 0) => new Date(year, month - 1, day, hour, minute);

describe('market-hours status', () => {
  test('a regular New York session closes at 16:00', () => {
    expect(getMarketStatus(market('nyc'), at(2026, 11, 10, 15, 59))).toBe('open');
    expect(getMarketStatus(market('nyc'), at(2026, 11, 10, 16, 0))).toBe('post-market');
  });

  test('U.S. early closes end the session three hours sooner in every U.S. row', () => {
    // The Friday after Thanksgiving and Christmas Eve close at 13:00 New York time.
    expect(getMarketStatus(market('nyc'), at(2026, 11, 27, 12, 59))).toBe('open');
    expect(getMarketStatus(market('nyc'), at(2026, 11, 27, 13, 0))).toBe('post-market');
    expect(getMarketStatus(market('nyc'), at(2026, 12, 24, 13, 30))).toBe('post-market');
    expect(getMarketStatus(market('chi'), at(2026, 11, 27, 11, 59))).toBe('open');
    expect(getMarketStatus(market('chi'), at(2026, 11, 27, 12, 0))).toBe('post-market');
    expect(getMarketStatus(market('lax'), at(2026, 11, 27, 9, 59))).toBe('open');
    expect(getMarketStatus(market('lax'), at(2026, 11, 27, 10, 0))).toBe('post-market');
  });

  test('U.S. holidays come from the exchange rules, with no yearly table to run out', () => {
    expect(getMarketStatus(market('nyc'), at(2026, 11, 26, 10))).toBe('holiday'); // Thanksgiving
    expect(getMarketStatus(market('nyc'), at(2027, 1, 1, 10))).toBe('holiday');
    expect(getMarketStatus(market('nyc'), at(2027, 1, 18, 10))).toBe('holiday'); // Martin Luther King Jr. Day
    expect(getMarketStatus(market('lax'), at(2028, 7, 4, 8))).toBe('holiday');
    expect(getMarketStatus(market('nyc'), at(2027, 1, 4, 10))).toBe('open');
  });

  test('Tokyo trades until 15:30', () => {
    expect(getMarketStatus(market('tyo'), at(2026, 11, 10, 15, 15))).toBe('open');
    expect(getMarketStatus(market('tyo'), at(2026, 11, 10, 15, 30))).toBe('closed');
  });

  test('London, Tokyo and Hong Kong holidays are listed through 2027', () => {
    expect(getMarketStatus(market('lon'), at(2027, 12, 27, 10))).toBe('holiday');
    expect(getMarketStatus(market('lon'), at(2027, 5, 3, 10))).toBe('holiday');
    expect(getMarketStatus(market('tyo'), at(2027, 3, 22, 10))).toBe('holiday');
    expect(getMarketStatus(market('tyo'), at(2027, 12, 31, 10))).toBe('holiday');
    expect(getMarketStatus(market('hkg'), at(2027, 2, 8, 10))).toBe('holiday');
    expect(getMarketStatus(market('hkg'), at(2027, 10, 8, 10))).toBe('holiday');
    expect(getMarketStatus(market('hkg'), at(2027, 2, 10, 10))).toBe('open');
  });

  test('weekends are closed everywhere', () => {
    for (const entry of GLOBAL_MARKETS) {
      expect(getMarketStatus(entry, at(2026, 11, 14, 10))).toBe('closed');
    }
  });
});
