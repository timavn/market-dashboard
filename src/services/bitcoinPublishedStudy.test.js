import { validateBitcoinResearchStudy } from './bitcoinResearchService';

// Validates the generated study in public/research/bitcoin; jest.config.cjs skips
// this file where that unversioned output is absent (for example a release export).
test('the published research artifact satisfies the interval contract', () => {
  const published = require('../../public/research/bitcoin/study.json');
  expect(validateBitcoinResearchStudy(published)).toBe(published);
  const daily = published.intervals.find(({ id }) => id === 'daily');
  expect(published.intervals.map(({ id }) => id)).toEqual(['hourly', 'calendar_day', 'daily']);
  expect(daily.rows.some((row) => row.observations > 0)).toBe(true);
  expect(daily.downloads.some(({ href }) => href === '/research/bitcoin/daily-observations.csv')).toBe(true);
});
