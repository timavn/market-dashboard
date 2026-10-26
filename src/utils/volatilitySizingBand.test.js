const { expectedSizingSession } = require('./volatilitySizingBand.cjs');

const NOW = Date.parse('2026-09-07T22:00:00Z'); // Labor Day: Friday is still the completed session.

test('expires locally after the next completed session, including holidays and weekends', () => {
  expect(expectedSizingSession(NOW)).toBe('2026-09-04');
  expect(expectedSizingSession(Date.parse('2026-09-08T19:00:00Z'))).toBe('2026-09-04');
  expect(expectedSizingSession(Date.parse('2026-09-08T20:16:00Z'))).toBe('2026-09-08');
  expect(expectedSizingSession(Date.parse('2026-09-12T20:16:00Z'))).toBe('2026-09-11');
  expect(expectedSizingSession(NOW, 365)).toBe('2026-09-06');
});
