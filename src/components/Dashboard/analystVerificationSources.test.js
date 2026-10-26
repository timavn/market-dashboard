import { verificationSourceDate } from './analystVerificationSources';

test.each([
  ['Archive: Jan 30, 2026; coverage monitor: Oct 5, 2026. Partial provenance.', { value: '2026-01-30', label: 'Jan 30' }],
  ['5 Oct 2026 in archive; current view dated 26 Aug 2026.', { value: '2026-10-05', label: 'Oct 5' }],
  ['2026-10-05T14:17:00Z; prior report Oct 2, 2026', { value: '2026-10-05T07:17:00-07:00', label: 'Oct 5 07:17 PDT' }],
  ['Jan 5, 2026, 07:15 UTC — partial provenance', { value: '2026-01-04T23:15:00-08:00', label: 'Jan 4 23:15 PST' }],
  ['30 September', { label: 'Sep 30' }],
  ['Sep 4 08:00 PT', { label: 'Sep 4 08:00 PT' }],
  ['Feb 30, 2026; monitor Oct 5, 2026', null],
  ['—', null],
])('the source date uses the Portfolio format and preserves the first publication: %s', (capture, expected) => {
  expect(verificationSourceDate(capture)).toEqual(expected);
});
