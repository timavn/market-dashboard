import { seasonGame } from './portfolioReviewGreeting';

test.each([
  ['2026-01-02', 1],
  ['2026-01-05', 2],
  ['2026-09-04', 170],
  ['2026-09-07', 170],
  ['2026-09-08', 171],
  ['2026-09-19', 179],
  ['2026-09-20', 179],
  ['2026-09-21', 180],
  ['2026-09-22', 181],
  ['2026-10-06', 191],
  ['2026-10-07', 192],
  ['2026-11-27', 228],
  ['2026-12-24', 247],
  ['2026-12-31', 251],
])('counts market sessions through %s, including early closes and excluding holidays/weekends', (dateKey, game) => {
  expect(seasonGame(dateKey)).toEqual({ game, totalGames: 251, year: '2026' });
});

test('resets the count on the first session of the new year without inventing a game zero on New Year’s Day', () => {
  expect(seasonGame('2027-01-01')).toEqual({ game: 251, totalGames: 251, year: '2026' });
  expect(seasonGame('2027-01-04')).toEqual({ game: 1, totalGames: 251, year: '2027' });
  expect(seasonGame('2025-12-31')).toEqual({ game: 250, totalGames: 250, year: '2025' });
});
