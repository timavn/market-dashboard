import { formatAnalystReportDate, presentAnalystReportDates } from './analystReportDates';

test.each([
  ['2026-10-05T18:29:47Z', 'Oct 5, 2026 11:29 PDT'],
  ['2026-01-05T18:29:47Z', 'Jan 5, 2026 10:29 PST'],
  ['2026-10-05T02:15:00Z', 'Oct 4, 2026 19:15 PDT'],
  ['2026-01-05T07:15:00Z', 'Jan 4, 2026 23:15 PST'],
  ['2026-10-05T07:00:00Z', 'Oct 5, 2026 00:00 PDT'],
  ['2026-10-05T08:12:00-04:00', 'Oct 5, 2026 05:12 PDT'],
  ['2026-10-05 18:29:47+00:00', 'Oct 5, 2026 11:29 PDT'],
])('metadata uses the actual California date and daylight offset: %s', (value, expected) => {
  expect(formatAnalystReportDate(value)).toBe(expected);
  expect(presentAnalystReportDates(`Captured ${value}.`)).toBe(`Captured ${expected}.`);
});

test('compact metadata uses the same Pacific time and keeps date-only publication days', () => {
  expect(formatAnalystReportDate('2026-10-05T07:00:00Z', { year: false })).toBe('Oct 5 00:00 PDT');
  expect(formatAnalystReportDate('2026-10-05', { year: false })).toBe('Oct 5');
  expect(formatAnalystReportDate('2026-10-05')).toBe('Oct 5, 2026');
  expect(formatAnalystReportDate('2026-10-05T00:00:00')).toBe('Oct 5, 2026');
  expect(presentAnalystReportDates('Published 2026-10-05 · Sep 21, 2026')).toBe('Published 2026-10-05 · Sep 21, 2026');
});

test.each([
  ['Oct 5, 2026 18:29 UTC', 'Oct 5, 2026 11:29 PDT'],
  ['2026-01-05 07:15 UTC', 'Jan 4, 2026 23:15 PST'],
  ['Sep 28, 2026, 08:43 ET', 'Sep 28, 2026 05:43 PDT'],
  ['Jan 5, 2026 08:43 ET', 'Jan 5, 2026 05:43 PST'],
  ['October 5, 2026 at 8:43 AM EDT', 'Oct 5, 2026 05:43 PDT'],
  ['January 5, 2026 8:43 PM EST', 'Jan 5, 2026 17:43 PST'],
  ['24 Sep 2026 15:37 EDT', 'Sep 24, 2026 12:37 PDT'],
  ['24 September 2026 at 15:37 ET', 'Sep 24, 2026 12:37 PDT'],
  ['Jan 5, 2026 00:15 GMT', 'Jan 4, 2026 16:15 PST'],
])('dated authored timestamps convert instead of merely changing the zone label: %s', (value, expected) => {
  expect(presentAnalystReportDates(`As of ${value}; verified.`)).toBe(`As of ${expected}; verified.`);
});

test('eastern ET follows the dated DST boundary and does not guess an ambiguous hour', () => {
  expect(presentAnalystReportDates('Mar 8, 2026 01:30 ET')).toBe('Mar 7, 2026 22:30 PST');
  expect(presentAnalystReportDates('Mar 8, 2026 03:30 ET')).toBe('Mar 7, 2026 23:30 PST');
  expect(presentAnalystReportDates('Mar 8, 2026 02:30 ET')).toBe('Mar 8, 2026 02:30 ET');
  expect(presentAnalystReportDates('Nov 1, 2026 01:30 ET')).toBe('Nov 1, 2026 01:30 ET');
  expect(presentAnalystReportDates('Nov 1, 2026 01:30 EDT')).toBe('Oct 31, 2026 22:30 PDT');
  expect(presentAnalystReportDates('Nov 1, 2026 01:30 EST')).toBe('Oct 31, 2026 23:30 PDT');
});

test('a timestamp without its day or verified timezone cannot be reinterpreted', () => {
  const value = 'At 18:29 UTC and 08:43 ET; captured 2026-10-05T08:43:00.';
  expect(presentAnalystReportDates(value)).toBe(value);
});

test.each([undefined, null, '', 'invalid', '2026-02-30', '2026-13-01', '2026-09-31T13:00:00Z'])('invalid metadata remains unavailable: %s', value => {
  expect(formatAnalystReportDate(value)).toBe('—');
});

test('literal code and source URLs retain their exact evidence while prose is converted', () => {
  const value = 'Captured 2026-10-05T18:29:00Z. [Source](https://example.com/2026-10-05T18:29:00Z) '
    + 'and https://example.com/?at=2026-10-05T18:29:00Z ibkr://account/2026-10-05T18:29:00Z '
    + '`2026-10-05T18:29:00Z`\n```json\n{"captured":"2026-10-05T18:29:00Z"}\n```';
  expect(presentAnalystReportDates(value)).toBe(value.replace('Captured 2026-10-05T18:29:00Z.', 'Captured Oct 5, 2026 11:29 PDT.'));
});

test('new presentation can be applied repeatedly without changing saved evidence', () => {
  const saved = Object.freeze({ text: 'Book captured 2026-10-05T18:29:00Z. Published Sep 28, 2026 08:43 ET.' });
  const before = saved.text;
  const presented = presentAnalystReportDates(saved.text);
  expect(presentAnalystReportDates(presented)).toBe(presented);
  expect(saved.text).toBe(before);
});

test('new Pacific report clocks are final while saved dated Eastern clocks read the same', () => {
  const pacific = 'Positioning: Sep 28, 2026 05:43 PDT · Through 12:30 PDT, SPY ETF volume · Expiration: Dec 25, 2026 13:00 PST';
  expect(presentAnalystReportDates(pacific)).toBe(pacific);
  expect(presentAnalystReportDates('Positioning: Sep 28, 2026 08:43 ET')).toBe('Positioning: Sep 28, 2026 05:43 PDT');
  expect(presentAnalystReportDates('Trading closes: Sep 25, 2026 17:00 ET')).toBe('Trading closes: Sep 25, 2026 14:00 PDT');
  expect(presentAnalystReportDates('Expiration: Dec 25, 2026 16:00 ET')).toBe('Expiration: Dec 25, 2026 13:00 PST');
  expect(presentAnalystReportDates('Sep 29, 2026 00:30 ET')).toBe('Sep 28, 2026 21:30 PDT');
});
