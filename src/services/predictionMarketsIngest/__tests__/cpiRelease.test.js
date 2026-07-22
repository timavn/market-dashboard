const {
  buildCurrentCpiRelease,
  deriveTargetStrikes,
  normalizeCpiMonthId,
  releaseKeyForEvent,
} = require('../cpiRelease');

const JULY_NOWCAST = {
  date: '2026-07-14',
  publishedAt: '2026-07-14T18:30:00Z',
  data: {
    metric: 'Headline CPI YoY',
    forecastMonth: 'July 2026',
    releaseDate: { date: '2026-08-12' },
    scenarios: [
      { key: 'upside', value: 3.45 },
      { key: 'base', value: 3.34 },
      { key: 'downside', value: 3.23 },
    ],
  },
};

describe('server-owned current CPI release', () => {
  test('builds one canonical release key and venue request from the live nowcast', () => {
    const release = buildCurrentCpiRelease(JULY_NOWCAST);

    expect(release).toMatchObject({
      releaseKey: 'KXCPIYOY#2026-07',
      reportMonth: '2026-07',
      forecastMonth: 'July 2026',
      releaseDate: '2026-08-12',
      eventTicker: 'KXCPIYOY-26JUL',
      targetStrikes: [3, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7],
    });
    expect(release.request.cpi).toEqual(expect.objectContaining({
      releaseKey: release.releaseKey,
      reportMonthId: '2026-07',
      targetStrikes: release.targetStrikes,
    }));
  });

  test('never invents a current release when source month or scenarios are missing', () => {
    expect(() => buildCurrentCpiRelease({ data: { metric: 'Headline CPI YoY' } }))
      .toThrow(/report month/i);
    expect(() => buildCurrentCpiRelease({
      data: { metric: 'Headline CPI YoY', forecastMonth: 'July 2026', releaseDate: '2026-08-12' },
    })).toThrow(/Upside, Base Case, and Downside/i);
  });

  test('rejects a latest snapshot whose release has already expired', () => {
    expect(() => buildCurrentCpiRelease({
      ...JULY_NOWCAST,
      data: {
        ...JULY_NOWCAST.data,
        forecastMonth: 'June 2026',
        releaseDate: { date: '2026-07-14' },
      },
    }, { now: new Date('2026-07-21T17:00:00Z') })).toThrow(/expired/i);
  });

  test('keeps identical strikes isolated by release key', () => {
    expect(releaseKeyForEvent({ api_raw_symbol: 'KXCPIYOY-26JUN-T3.4' }))
      .toBe('KXCPIYOY#2026-06');
    expect(releaseKeyForEvent({ api_raw_symbol: 'KXCPIYOY-26JUL-T3.4' }))
      .toBe('KXCPIYOY#2026-07');
    expect(normalizeCpiMonthId('July 2026')).toBe('2026-07');
  });

  test('derives targets only from actual scenarios and returns no default ladder', () => {
    expect(deriveTargetStrikes([])).toEqual([]);
  });
});
