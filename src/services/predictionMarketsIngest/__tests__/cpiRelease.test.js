const {
  buildCurrentCpiRelease,
  deriveTargetStrikes,
  getCurrentCpiRelease,
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
    const release = buildCurrentCpiRelease(JULY_NOWCAST, {
      now: new Date('2026-08-01T12:00:00Z'),
    });

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

  test('keeps the server target range aligned with the CPI ladder rule', () => {
    expect(deriveTargetStrikes([
      { value: 3.37 },
      { value: 3.48 },
      { value: 3.59 },
    ])).toEqual([3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8]);
    expect(deriveTargetStrikes([
      { value: 3.3 },
      { value: 3.5 },
      { value: 3.7 },
    ])).toEqual([3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9]);
  });

  test('selects the next report from a merged snapshot immediately at the release cutoff', async () => {
    const merged = {
      date: '2026-08-11',
      data: {
        metric: 'Headline CPI YoY',
        forecasts: [
          {
            reportMonth: '2026-07',
            forecastMonth: 'July 2026',
            releaseAt: '2026-08-12T12:30:00.000Z',
            publishedAt: '2026-08-11T15:00:00.000Z',
            scenarios: { upper: 3.58, base: 3.47, lower: 3.36 },
          },
          {
            reportMonth: '2026-08',
            forecastMonth: 'August 2026',
            releaseAt: '2026-09-11T12:30:00.000Z',
            publishedAt: '2026-08-11T15:00:00.000Z',
            scenarios: { upper: 3.70, base: 3.57, lower: 3.44 },
          },
        ],
      },
    };
    const release = await getCurrentCpiRelease({
      now: new Date('2026-08-12T12:30:00.000Z'),
      loadSnapshots: async () => [merged],
    });

    expect(release).toMatchObject({
      releaseKey: 'KXCPIYOY#2026-08',
      reportMonth: '2026-08',
      releaseAt: '2026-09-11T12:30:00.000Z',
      scenarios: expect.arrayContaining([
        expect.objectContaining({ key: 'base', value: 3.57 }),
      ]),
    });
  });
});
