import {
  cftcDirectionClass,
  cftcValueClass,
  formatCftcDate,
  formatCftcNumber,
  formatCftcRetrieval,
  getCftcMethodologyNote,
  getCftcSourceUrl,
  isCftcResearchRow,
} from './cftcPositioningPresentation';

describe('CFTC positioning presentation', () => {
  test.each([null, undefined, '', '100', NaN, Infinity, -Infinity, {}, false])(
    'omits a non-numeric or non-finite provider value: %p', value => {
      expect(formatCftcNumber(value)).toBe('—');
      expect(formatCftcNumber(value, { score: true })).toBe('—');
      expect(cftcDirectionClass(value)).toBe('');
      expect(cftcValueClass(value)).toBe('is-unavailable');
      expect(cftcValueClass(value, { score: true })).toBe('is-unavailable');
    },
  );

  test('preserves zero and only applies the established score threshold', () => {
    expect(formatCftcNumber(0, { signed: true })).toBe('0');
    expect(formatCftcNumber(0, { score: true })).toBe('0.00');
    expect(cftcDirectionClass(1, 1)).toBe('');
    expect(cftcDirectionClass(-1, 1)).toBe('');
    expect(cftcDirectionClass(1.001, 1)).toBe('is-positive');
    expect(cftcDirectionClass(-1.001, 1)).toBe('is-negative');
  });

  test('colors ordinary negative values without treating positive values or magnitude as a signal', () => {
    expect(cftcValueClass(-45000)).toBe('is-negative');
    expect(cftcValueClass(45000)).toBe('');
    expect(cftcValueClass(0)).toBe('');
  });

  test.each([
    [2, 'is-positive', false],
    [-2, 'is-negative', false],
    [2.00001, 'is-positive', true],
    [-2.00001, 'is-negative', true],
    [1.99999, 'is-positive', false],
    [-1.99999, 'is-negative', false],
    [0.01, 'is-positive', false],
    [-0.01, 'is-negative', false],
  ])('classifies z-score %p using its raw sign and strict absolute two boundary', (score, direction, extreme) => {
    const classes = cftcValueClass(score, { score: true }).split(' ');
    expect(classes).toContain(direction);
    expect(classes.includes('is-extreme')).toBe(extreme);
    expect(classes).not.toContain('is-unavailable');
  });

  test('does not assign zero z-scores a direction or extreme outline', () => {
    expect(cftcValueClass(0, { score: true })).toBe('');
    expect(cftcValueClass(-0, { score: true })).toBe('');
  });

  test('separates position dates from exact 24-hour retrieval times', () => {
    expect(formatCftcDate('2026-09-08')).toBe('Sep 8, 2026');
    expect(formatCftcDate('2026-09-08', { compact: true })).toBe('9/8/26');
    expect(formatCftcDate('2026-12-31', { compact: true })).toBe('12/31/26');
    expect(formatCftcDate('2026-02-30')).toBe('UNAVAILABLE');
    expect(formatCftcDate('2026-02-30', { compact: true })).toBe('UNAVAILABLE');
    expect(formatCftcDate(null, { compact: true })).toBe('UNAVAILABLE');
    expect(formatCftcRetrieval('2026-09-17T07:00:00Z')).toBe('Sep 17, 2026 00:00 PT');
    expect(formatCftcRetrieval('2026-09-17')).toBe('Sep 17, 2026');
    expect(formatCftcRetrieval('2026-09-17T07:00:00')).toBe('UNAVAILABLE');
    expect(formatCftcRetrieval('invalid')).toBe('UNAVAILABLE');
  });

  test('accepts only HTTPS CFTC source links and the matching series family', () => {
    expect(getCftcSourceUrl({ sourceUrl: 'javascript:alert(1)' }, {})).toBeNull();
    expect(getCftcSourceUrl({ sourceUrl: 'https://example.com/' }, {})).toBeNull();
    const url = 'https://publicreporting.cftc.gov/Commitments-of-Traders/Disaggregated_All/rxbv-e226';
    expect(getCftcSourceUrl({ seriesType: 'disaggregated-managed-money-combined' }, {
      sourceUrl: 'https://publicreporting.cftc.gov/Commitments-of-Traders/Legacy_All/srt6-5q2f',
      sourceUrls: { disaggregated: url },
    })).toBe(url);
  });

  test('generates cohort disclosure from row metadata without a Gold-specific branch', () => {
    const row = {
      metric: 'SILVER', asOf: '2026-09-08', status: 'current',
      cftcContractMarketCode: '084691',
      seriesType: 'disaggregated-managed-money-combined',
    };
    expect(isCftcResearchRow(row)).toBe(true);
    expect(getCftcMethodologyNote([
      row,
      { ...row, metric: 'Corn', seriesType: 'legacy-noncommercial-combined' },
    ])).toBe('Official Combined futures + options: Disaggregated managed money (SILVER); Legacy non-commercial (Corn). Weekly, informational only.');
    expect(getCftcMethodologyNote([{ ...row, mock: true }])).toBe('Weekly CFTC positioning. Informational only.');
  });
});
