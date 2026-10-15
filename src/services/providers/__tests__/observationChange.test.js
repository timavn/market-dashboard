const { latestObservationChange, percentageChange } = require('../observationChange.cjs');
const close = (date, value) => ({ t: Date.parse(`${date}T00:00:00Z`), close: value });

test('uses the last actual daily observations across a weekend with their original dates', () => {
  expect(latestObservationChange([close('2026-08-28', 100), close('2026-08-31', 102)])).toEqual({
    value: 2, from: '2026-08-28T00:00:00.000Z', asOf: '2026-08-31T00:00:00.000Z',
    interval: 'daily', status: 'historical', executable: false,
  });
});

test('labels monthly observations separately from daily returns', () => {
  expect(latestObservationChange([close('2026-05-01', 3), close('2026-06-01', 2.97)]))
    .toMatchObject({ value: -1, interval: 'monthly', asOf: '2026-06-01T00:00:00.000Z' });
});

test('does not invent a change from missing, duplicate, future, or zero-base observations', () => {
  expect(latestObservationChange([close('2026-05-01', null), close('2026-06-01', 3)])).toBeNull();
  expect(latestObservationChange([close('2026-06-01', 3), close('2026-06-01', 3)])).toBeNull();
  expect(latestObservationChange([close('2026-06-01', 0), close('2026-07-01', 3)])).toBeNull();
  expect(latestObservationChange([close('2026-06-01', 3), close('2026-07-01', 4)], Date.parse('2026-06-15'))).toBeNull();
});

test('converts the actual level change to percent, including negative and crossing spreads', () => {
  expect(percentageChange(4.34, 4.29)).toBe(1.17);
  expect(percentageChange(-42.5, -43.7)).toBe(2.75);
  expect(percentageChange(10, -10)).toBe(200);
  expect(percentageChange(0, 10)).toBe(-100);
  expect(percentageChange(1, 0)).toBeNull();
});
