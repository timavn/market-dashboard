import { portfolioReviewGreeting } from './portfolioReviewGreeting';

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
])('counts market sessions through %s, including early closes and excluding holidays/weekends', (reviewedAt, game) => {
  expect(portfolioReviewGreeting({ portfolioBrief: { reviewedAt } })).toBe(`Good morning, this is game ${game}/251 of the 2026 season.`);
});

test('resets the count on the first session of the new year without inventing a game zero on New Year’s Day', () => {
  expect(portfolioReviewGreeting({ portfolioBrief: { reviewedAt: '2027-01-01' } })).toBe('Good morning, this is game 251/251 of the 2026 season.');
  expect(portfolioReviewGreeting({ portfolioBrief: { reviewedAt: '2027-01-04' } })).toBe('Good morning, this is game 1/251 of the 2027 season.');
  expect(portfolioReviewGreeting({ portfolioBrief: { reviewedAt: '2025-12-31' } })).toBe('Good morning, this is game 250/250 of the 2025 season.');
});

test('uses the saved review timestamp in New York, ahead of message creation and older holdings/research', () => {
  const message = {
    created_at: '2026-09-21T12:00:00Z',
    portfolioBrief: { reviewedAt: '2026-09-23T00:30:00Z', asOf: '2026-09-18T20:00:00Z', researchDate: '2026-09-18' },
  };
  expect(portfolioReviewGreeting(message)).toBe('Good morning, this is game 181/251 of the 2026 season.');
  expect(portfolioReviewGreeting({ portfolioBrief: { reviewedAt: '2026-09-23T04:30:00Z' } })).toBe('Good morning, this is game 182/251 of the 2026 season.');
});

test('falls back to the saved message date, then legacy holdings date', () => {
  const message = { created_at: '2026-09-22T12:00:00Z', portfolioBrief: { reviewedAt: 'invalid', asOf: '2026-09-04' } };
  expect(portfolioReviewGreeting(message)).toBe('Good morning, this is game 181/251 of the 2026 season.');
  expect(portfolioReviewGreeting({ portfolioBrief: message.portfolioBrief })).toBe('Good morning, this is game 170/251 of the 2026 season.');
});

test.each([undefined, '', 'invalid', '2026-02-30', '2026-02-30T12:00:00Z', '2026-09-22T12:00:00'])('does not invent a session from a missing or invalid saved date: %s', reviewedAt => {
  expect(portfolioReviewGreeting({ portfolioBrief: { reviewedAt } })).toBe('Good morning.');
});
