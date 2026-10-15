const {
  buildMomoTrackerCsvRows,
  formatPublishedNumber,
} = require('./momoTrackerCsv.cjs');

describe('MOMO Tracker CSV rows', () => {
  test('keeps outbucket levels blank while retaining published status and trend', () => {
    const rows = buildMomoTrackerCsvRows({
      NVDA: {
        buyTrade: 203,
        sellTrade: 225,
        upside: 2.74,
        downside: -7.3,
        trend: 'BULLISH',
        rangeStatus: 'available',
        index: 0,
      },
      ORCL: {
        buyTrade: null,
        sellTrade: null,
        upside: null,
        downside: null,
        trend: 'BULLISH',
        rangeStatus: 'outbucket',
        rangeStatusDate: '08/13',
        index: 1,
      },
    });

    expect(rows).toEqual([
      expect.objectContaining({
        ticker: 'NVDA',
        buyTrade: '203.00',
        sellTrade: '225.00',
        upside: '2.74%',
        downside: '-7.30%',
        rangeStatus: 'available',
      }),
      expect.objectContaining({
        ticker: 'ORCL',
        buyTrade: '',
        sellTrade: '',
        upside: '',
        downside: '',
        trend: 'BULLISH',
        rangeStatus: 'outbucket',
        rangeStatusDate: '08/13',
      }),
    ]);
  });

  test('never zero-fills a missing or invalid published value', () => {
    expect(formatPublishedNumber(null)).toBe('');
    expect(formatPublishedNumber(undefined)).toBe('');
    expect(formatPublishedNumber('')).toBe('');
    expect(formatPublishedNumber('not-published')).toBe('');
    expect(formatPublishedNumber(0)).toBe('0.00');
  });
});
