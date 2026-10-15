const {
  PROFILES,
  buildResolverChartSession,
  createSessionDateReader,
  dateForPoint,
  sessionDateForTimestamp,
  sessionWindowForDate,
} = require('./resolverChartSessions.cjs');

function selection(venueId, event, settlementBasis = null) {
  return {
    id: venueId,
    catalog: { event: { venueId, ...event } },
    ...(settlementBasis ? { settlementBasis } : {}),
  };
}

describe('resolver chart sessions', () => {
  test.each([
    ['2026-03-06T14:29:59Z', null],
    ['2026-03-06T14:30:00Z', '2026-03-06'],
    ['2026-03-09T13:29:59Z', null],
    ['2026-03-09T13:30:00Z', '2026-03-09'],
    ['2026-03-09T20:00:59Z', '2026-03-09'],
    ['2026-03-09T20:01:00Z', null],
    ['2026-10-30T13:30:00Z', '2026-10-30'],
    ['2026-11-02T14:29:59Z', null],
    ['2026-11-02T14:30:00Z', '2026-11-02'],
    ['2026-11-02T21:01:00Z', null],
  ])('keeps US cash session boundaries across daylight-saving changes at %s', (timestamp, expected) => {
    expect(sessionDateForTimestamp(PROFILES.us_cash, Date.parse(timestamp))).toBe(expected);
  });

  test.each([
    ['2026-03-08T21:59:59Z', null],
    ['2026-03-08T22:00:00Z', '2026-03-09'],
    ['2026-03-10T00:00:00Z', '2026-03-10'],
    ['2026-11-01T22:59:59Z', null],
    ['2026-11-01T23:00:00Z', '2026-11-02'],
    ['2026-11-03T01:00:00Z', '2026-11-03'],
  ])('keeps the ICE Sunday and weekday overnight opens at %s', (timestamp, expected) => {
    expect(sessionDateForTimestamp(PROFILES.ice_wti, Date.parse(timestamp))).toBe(expected);
  });

  test.each([
    ['2026-03-09T03:59:59Z', '2026-03-08'],
    ['2026-03-09T04:00:00Z', '2026-03-09'],
    ['2026-11-02T04:59:59Z', '2026-11-01'],
    ['2026-11-02T05:00:00Z', '2026-11-02'],
  ])('keeps calendar midnight in New York at %s', (timestamp, expected) => {
    expect(sessionDateForTimestamp(PROFILES.continuous_calendar, Date.parse(timestamp))).toBe(expected);
  });

  test('uses both repeated fall-back hours and skips the nonexistent spring-forward hour', () => {
    const repeatedHour = { ...PROFILES.us_cash, openMinutes: 60, defaultCutoffMinutes: 119 };
    expect(sessionDateForTimestamp(repeatedHour, Date.parse('2026-11-01T05:30:00Z'))).toBe('2026-11-01');
    expect(sessionDateForTimestamp(repeatedHour, Date.parse('2026-11-01T06:30:00Z'))).toBe('2026-11-01');
    const skippedHour = { ...PROFILES.us_cash, openMinutes: 120, defaultCutoffMinutes: 179 };
    expect(sessionDateForTimestamp(skippedHour, Date.parse('2026-03-08T06:59:59Z'))).toBeNull();
    expect(sessionDateForTimestamp(skippedHour, Date.parse('2026-03-08T07:00:00Z'))).toBeNull();
  });

  test.each([
    ['Asia/Kolkata', '2026-09-14T23:30:00Z', '2026-09-15'],
    ['+05:30', '2026-09-14T23:30:00Z', '2026-09-15'],
    ['-0500', '2026-09-14T00:30:00Z', '2026-09-13'],
    ['UTC', '2026-09-14T00:30:00Z', '2026-09-14'],
    ['Z', '2026-09-14T00:30:00Z', '2026-09-14'],
    [undefined, '2026-09-14T00:30:00Z', '2026-09-14'],
    ['', '2026-09-14T00:30:00Z', '2026-09-14'],
  ])('preserves custom calendar timezone %s without using the host timezone', (timeZone, timestamp, expected) => {
    const profile = { ...PROFILES.continuous_calendar, timeZone };
    expect(sessionDateForTimestamp(profile, Date.parse(timestamp))).toBe(expected);
  });

  test('rejects invalid zones and timestamps without inventing a session date', () => {
    expect(sessionDateForTimestamp({ ...PROFILES.us_cash, timeZone: 'Invalid/Zone' }, 0)).toBeNull();
    expect(sessionDateForTimestamp(PROFILES.us_cash, Number.NaN)).toBeNull();
    expect(sessionDateForTimestamp(PROFILES.us_cash, Infinity)).toBeNull();
    expect(sessionDateForTimestamp(PROFILES.us_cash, 'invalid')).toBeNull();
    expect(sessionDateForTimestamp(PROFILES.us_cash, 8.64e15 + 1)).toBeNull();
    expect(sessionDateForTimestamp(PROFILES.continuous_calendar, null)).toBe('1969-12-31');
  });

  test('reuses timestamp decoding within one chart while keeping profiles and selected windows independent', () => {
    const format = jest.spyOn(Intl.DateTimeFormat.prototype, 'format', 'get');
    const read = createSessionDateReader();
    const timestamp = Date.parse('2026-09-01T22:30:00Z');
    const cash = { profile: PROFILES.us_cash };
    const futures = { profile: PROFILES.cme_futures };
    const calendar = { profile: PROFILES.continuous_calendar };
    const tokyo = { profile: { ...PROFILES.continuous_calendar, timeZone: 'Asia/Tokyo' } };
    for (let pass = 0; pass < 5; pass += 1) {
      expect(read(cash, timestamp)).toBeNull();
      expect(read(futures, timestamp)).toBe('2026-09-02');
      expect(read(calendar, timestamp)).toBe('2026-09-01');
      expect(read(tokyo, timestamp)).toBe('2026-09-02');
    }
    expect(format).toHaveBeenCalledTimes(2);

    const window = {
      sessionDate: '2026-09-01', startAt: '2026-09-01T22:00:00Z', endAt: '2026-09-01T23:00:00Z',
    };
    expect(read({ ...cash, currentWindow: window }, timestamp, { currentOnly: true })).toBe('2026-09-01');
    expect(read({ ...cash, currentWindow: { ...window, endAt: '2026-09-01T22:00:00Z' } }, timestamp, { currentOnly: true })).toBeNull();
    // A profile with the same id can still publish a different cutoff.
    expect(read({ profile: { ...PROFILES.us_cash, defaultCutoffMinutes: 19 * 60 } }, timestamp)).toBe('2026-09-01');
    expect(format).toHaveBeenCalledTimes(2);
    expect(createSessionDateReader()(calendar, timestamp)).toBe('2026-09-01');
    expect(format).toHaveBeenCalledTimes(3);
    format.mockRestore();
  });

  test('decodes chart bars without per-bar Intl parts arrays and retains extreme date keys', () => {
    const formatParts = jest.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts');
    try {
      const calendar = { profile: { ...PROFILES.continuous_calendar, timeZone: 'UTC' } };
      const read = createSessionDateReader();
      for (const [timestamp, expected] of [
        [Date.parse('0001-01-01T00:00:00Z'), '0001-01-01'],
        [Date.parse('2026-03-08T07:00:00Z'), '2026-03-08'],
        [Date.parse('+010000-01-01T00:00:00Z'), '10000-01-01'],
        [8.64e15, '275760-09-13'],
      ]) expect(read(calendar, timestamp)).toBe(expected);
      expect(formatParts).not.toHaveBeenCalled();
    } finally {
      formatParts.mockRestore();
    }
  });

  test('preserves the established parts decoder when Intl uses a different literal layout', () => {
    const format = jest.spyOn(Intl.DateTimeFormat.prototype, 'format', 'get').mockReturnValue(() => 'Different Intl layout');
    const formatParts = jest.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts');
    try {
      expect(sessionDateForTimestamp(PROFILES.us_cash, Date.parse('2026-03-09T13:30:00Z'))).toBe('2026-03-09');
      expect(sessionDateForTimestamp(PROFILES.ice_wti, Date.parse('2026-11-01T23:00:00Z'))).toBe('2026-11-02');
      expect(formatParts).toHaveBeenCalledTimes(2);
    } finally {
      format.mockRestore();
      formatParts.mockRestore();
    }
  });

  test('memoized decoding exactly matches standalone dates across DST, invalid inputs and custom zones', () => {
    const timestamps = [
      '2026-03-08T06:59:59Z', '2026-03-08T07:00:00Z',
      '2026-03-09T13:29:59Z', '2026-03-09T13:30:00Z',
      '2026-11-01T05:30:00Z', '2026-11-01T06:30:00Z',
      '2026-11-02T14:30:00Z',
    ].map(Date.parse).concat([null, undefined, Number.NaN, Infinity, 8.64e15 + 1, 'invalid']);
    const profiles = [
      PROFILES.us_cash, PROFILES.ice_wti, PROFILES.pyth_daily,
      PROFILES.continuous_calendar, PROFILES.event_window,
      ...['Asia/Kolkata', '+05:30', '-0500', 'UTC', 'Z', undefined, '', 'Invalid/Zone']
        .map(timeZone => ({ ...PROFILES.continuous_calendar, timeZone })),
    ];
    const read = createSessionDateReader();
    for (const profile of profiles) {
      const session = { profile };
      for (const timestamp of timestamps) {
        expect(read(session, timestamp)).toBe(dateForPoint(session, timestamp));
        expect(read(session, timestamp)).toBe(dateForPoint(session, timestamp));
      }
    }
  });

  test('uses the COMEX Gold session through the exact ForecastEx observation', () => {
    const session = buildResolverChartSession({
      marketId: 'gold',
      selected: selection('forecastex', {
        productCode: 'METLG',
        observationTime: '2026-09-01T17:30:00.000Z',
      }),
      nowMs: Date.parse('2026-08-31T22:30:00.000Z'),
    });

    expect(session.currentWindow).toMatchObject({
      profileId: 'cme_futures',
      sessionDate: '2026-09-01',
      startAt: '2026-08-31T22:00:00.000Z',
      endAt: '2026-09-01T17:30:00.000Z',
      state: 'resolver_open',
    });
    expect(dateForPoint(session, Date.parse('2026-08-31T21:59:59.000Z'), { currentOnly: true })).toBeNull();
    expect(dateForPoint(session, Date.parse('2026-08-31T22:00:00.000Z'), { currentOnly: true })).toBe('2026-09-01');
    expect(dateForPoint(session, Date.parse('2026-09-01T17:30:00.000Z'), { currentOnly: true })).toBe('2026-09-01');
    expect(dateForPoint(session, Date.parse('2026-09-01T17:30:01.000Z'), { currentOnly: true })).toBeNull();
  });

  test('uses the distinct COMEX Silver cutoff', () => {
    const session = buildResolverChartSession({
      marketId: 'silver',
      selected: selection('forecastex', {
        productCode: 'METLS',
        observationTime: '2026-09-01T17:25:00.000Z',
      }),
      nowMs: Date.parse('2026-08-31T23:00:00.000Z'),
    });

    expect(session.currentWindow).toMatchObject({
      startAt: '2026-08-31T22:00:00.000Z',
      endAt: '2026-09-01T17:25:00.000Z',
    });
    expect(sessionWindowForDate(session.profile, '2026-08-28')).toMatchObject({
      startAt: '2026-08-27T22:00:00.000Z',
      endAt: '2026-08-28T17:25:00.000Z',
    });
  });

  test('uses the later ICE WTI weekday open and the special Sunday open for Monday', () => {
    const tuesday = buildResolverChartSession({
      marketId: 'wti',
      selected: selection('kalshi', {
        observationTime: '2026-09-01T18:30:00.000Z',
      }),
      nowMs: Date.parse('2026-09-01T01:00:00.000Z'),
    });
    const monday = buildResolverChartSession({
      marketId: 'wti',
      selected: selection('kalshi', {
        observationTime: '2026-08-31T18:30:00.000Z',
      }),
      nowMs: Date.parse('2026-08-30T23:00:00.000Z'),
    });

    expect(tuesday.currentWindow).toMatchObject({
      startAt: '2026-09-01T00:00:00.000Z',
      endAt: '2026-09-01T18:30:00.000Z',
    });
    expect(monday.currentWindow).toMatchObject({
      startAt: '2026-08-30T22:00:00.000Z',
      endAt: '2026-08-31T18:30:00.000Z',
    });
  });

  test('uses the dated ES futures session for ForecastEx FES', () => {
    const session = buildResolverChartSession({
      marketId: 'sp500',
      selected: selection('forecastex', {
        productCode: 'FES',
        observationTime: '2026-09-01T20:00:00.000Z',
      }),
      nowMs: Date.parse('2026-08-31T23:00:00.000Z'),
    });

    expect(session.currentWindow).toMatchObject({
      startAt: '2026-08-31T22:00:00.000Z',
      endAt: '2026-09-01T20:00:00.000Z',
    });
  });

  test.each(['bitcoin', 'ethereum'])('uses only the selected hourly %s event window', (marketId) => {
    const session = buildResolverChartSession({
      marketId,
      selected: selection('kalshi', {
        openTime: '2026-08-31T22:00:00.000Z',
        observationTime: '2026-08-31T23:00:00.000Z',
      }),
      nowMs: Date.parse('2026-08-31T22:30:00.000Z'),
    });

    expect(session.currentWindow).toMatchObject({
      profileId: 'event_window',
      startAt: '2026-08-31T22:00:00.000Z',
      endAt: '2026-08-31T23:00:00.000Z',
    });
    expect(dateForPoint(session, Date.parse('2026-08-31T21:59:59.000Z'), { currentOnly: true })).toBeNull();
    expect(dateForPoint(session, Date.parse('2026-08-31T22:15:00.000Z'), { currentOnly: true })).toBe('2026-08-31');
  });

  test('uses the normalized candidate close when the raw Kalshi event omits strike_date', () => {
    const session = buildResolverChartSession({
      marketId: 'bitcoin',
      selected: {
        event: { event_ticker: 'KXBTCD-26AUG3120' },
        markets: [{ open_time: '2026-08-31T23:00:00.000Z' }],
        closeTime: '2026-09-01T00:00:00.000Z',
      },
      nowMs: Date.parse('2026-08-31T23:30:00.000Z'),
    });

    expect(session.currentWindow).toMatchObject({
      startAt: '2026-08-31T23:00:00.000Z',
      endAt: '2026-09-01T00:00:00.000Z',
      sessionDate: '2026-08-31',
    });
  });

  test('honors a published shortened holiday observation instead of a normal cutoff', () => {
    const session = buildResolverChartSession({
      marketId: 'sp500',
      selected: selection('forecastex', {
        productCode: 'FES',
        observationTime: '2026-11-27T18:00:00.000Z',
      }),
      nowMs: Date.parse('2026-11-27T17:00:00.000Z'),
    });

    expect(session.currentWindow).toMatchObject({
      sessionDate: '2026-11-27',
      startAt: '2026-11-26T23:00:00.000Z',
      endAt: '2026-11-27T18:00:00.000Z',
      state: 'resolver_open',
    });
  });

  test('exposes a closed interval without inventing prices when a contract opens first', () => {
    const session = buildResolverChartSession({
      marketId: 'gold',
      selected: selection('forecastex', {
        openTime: '2026-08-31T21:16:00.000Z',
        observationTime: '2026-09-01T17:30:00.000Z',
      }),
      nowMs: Date.parse('2026-08-31T21:30:00.000Z'),
    });

    expect(session.currentWindow).toMatchObject({
      state: 'resolver_closed',
      closedIntervals: [{
        startAt: '2026-08-31T21:16:00.000Z',
        endAt: '2026-08-31T22:00:00.000Z',
        state: 'resolver_closed',
      }],
    });
  });
});
