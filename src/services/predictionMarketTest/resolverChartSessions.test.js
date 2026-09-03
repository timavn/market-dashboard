const {
  buildResolverChartSession,
  dateForPoint,
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

  test('uses only the selected hourly Bitcoin event window', () => {
    const session = buildResolverChartSession({
      marketId: 'bitcoin',
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
