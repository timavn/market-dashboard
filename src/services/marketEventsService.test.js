jest.mock('./tradingEconomicsCalendarProvider.cjs', () => ({
  PROVIDER: 'Trading Economics',
  SOURCE_URL: 'https://tradingeconomics.com/calendar',
  loadCurrentWeekActuals: jest.fn(),
  loadNextWeekCalendar: jest.fn(),
}));

const { loadCurrentWeekActuals, loadNextWeekCalendar } = require('./tradingEconomicsCalendarProvider.cjs');
const {
  ACTUALS_PENDING_TTL_MS,
  FAILURE_COOLDOWN_MS,
  PROVIDER_EXPORT_URL,
  SUCCESS_CACHE_TTL_MS,
  createMarketEventsService,
  currentEtWeek,
  normalizeEvents,
  releaseSignature,
} = require('./marketEventsService.cjs');

const NOW = Date.parse('2026-08-10T16:00:00.000Z');
const FRESH_LAST_MODIFIED = 'Mon, 10 Aug 2026 15:30:00 GMT';

function calendarRow(overrides = {}) {
  return {
    title: 'CPI y/y',
    country: 'USD',
    date: '2026-08-12T08:30:00-04:00',
    impact: 'High',
    forecast: '2.8%',
    previous: '2.7%',
    ...overrides,
  };
}

function providerResponse(rows = [calendarRow()], overrides = {}) {
  const { headers = {}, ...responseOverrides } = overrides;
  return {
    data: rows,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'last-modified': FRESH_LAST_MODIFIED,
      ...headers,
    },
    ...responseOverrides,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function nextWeekSnapshot({ requestedAt, coverage }) {
  const observedAt = new Date(requestedAt).toISOString();
  return {
    status: 'verified',
    provider: 'Trading Economics',
    providerMode: 'calendar-page',
    timezone: 'America/New_York',
    coverage,
    sourceUpdatedAt: null,
    sourceObservedAt: observedAt,
    sourceUrl: 'https://tradingeconomics.com/calendar',
    code: null,
    reason: null,
    events: [{ id: 'te-401030', startAt: `${coverage.from}T12:30:00.000Z`, observedAt }],
  };
}

describe('marketEventsService', () => {
  beforeEach(() => {
    loadNextWeekCalendar.mockReset().mockImplementation(async args => nextWeekSnapshot(args));
    loadCurrentWeekActuals.mockReset().mockResolvedValue({
      provider: 'Trading Economics', sourceUrl: 'https://tradingeconomics.com/calendar',
      observedAt: '2026-08-12T12:31:00.000Z', releases: [],
    });
  });

  describe('Trading Economics actuals', () => {
    const RELEASED = Date.parse('2026-08-12T12:45:00.000Z');
    const rows = [
      calendarRow({ title: 'CPI y/y' }),
      calendarRow({ title: 'Core CPI m/m', forecast: '0.3%', previous: '0.2%' }),
      calendarRow({ title: 'Retail Sales m/m', forecast: '0.4%', previous: '0.1%' }),
      calendarRow({ title: 'FOMC Statement', forecast: '', previous: '' }),
      calendarRow({ title: 'PPI m/m', date: '2026-08-13T08:30:00-04:00' }),
    ];
    const release = (overrides) => ({
      countryCode: 'US', startAt: '2026-08-12T12:30:00.000Z', previous: null,
      sourceUrl: 'https://tradingeconomics.com/united-states/inflation-cpi', ...overrides,
    });
    const releases = [
      release({ id: 'te-1', name: 'Inflation Rate YoY', actual: '2.9%' }),
      release({ id: 'te-2', name: 'Core Inflation Rate MoM', actual: '0.4%', sourceUrl: 'https://tradingeconomics.com/united-states/core-inflation-rate-mom' }),
      release({ id: 'te-3', name: 'CPI', actual: '321.5' }),
      // Two rows reduce to the same signature, so neither is trusted.
      release({ id: 'te-4', name: 'Retail Sales MoM', actual: '0.5%' }),
      release({ id: 'te-5', name: 'Retail Sales MoM Final', actual: '0.6%' }),
      release({ id: 'te-6', name: 'PPI MoM', actual: '9.9%', startAt: '2026-08-13T12:30:00.000Z' }),
    ];
    const lastModified = (time) => new Date(time - 10 * 60 * 1000).toUTCString();
    const service = (getTime) => createMarketEventsService({
      httpClient: { get: jest.fn(async () => providerResponse(rows, { headers: { 'last-modified': lastModified(getTime()) } })) },
      now: getTime,
    });

    test('maps provider names to one signature', () => {
      expect(releaseSignature('Core CPI m/m')).toBe(releaseSignature('Core Inflation Rate MoM'));
      expect(releaseSignature('Core Retail Sales m/m')).toBe(releaseSignature('Retail Sales Ex Autos MoM'));
      expect(releaseSignature('Non-Farm Employment Change')).toBe(releaseSignature('Non Farm Payrolls'));
      expect(releaseSignature('German Prelim CPI m/m')).toBe(releaseSignature('Inflation Rate MoM Prel'));
      expect(releaseSignature('Retail Sales m/m')).not.toBe(releaseSignature('Retail Sales Control Group MoM'));
      expect(releaseSignature('CPI m/m')).not.toBe(releaseSignature('CPI'));
    });

    test('attaches a unique matching actual only to released events with figures', async () => {
      loadCurrentWeekActuals.mockResolvedValue({
        provider: 'Trading Economics', sourceUrl: 'https://tradingeconomics.com/calendar',
        observedAt: '2026-08-12T12:31:00.000Z', releases,
      });
      const result = await service(() => RELEASED).getEvents();
      const byName = Object.fromEntries(result.events.map(event => [event.name, event]));

      expect(result.status).toBe('verified');
      expect(result.actuals).toEqual({
        status: 'verified', provider: 'Trading Economics',
        sourceUrl: 'https://tradingeconomics.com/calendar', observedAt: '2026-08-12T12:31:00.000Z',
      });
      expect(byName['CPI y/y']).toMatchObject({
        actual: '2.9%', actualSource: 'Trading Economics',
        actualSourceUrl: 'https://tradingeconomics.com/united-states/inflation-cpi',
        actualObservedAt: '2026-08-12T12:31:00.000Z',
      });
      expect(byName['Core CPI m/m'].actual).toBe('0.4%');
      expect(byName['Retail Sales m/m'].actual).toBeNull();
      expect(byName['FOMC Statement'].actual).toBeNull();
      expect(byName['PPI m/m'].actual).toBeNull();
      expect(loadCurrentWeekActuals).toHaveBeenCalledWith(expect.objectContaining({
        requestedAt: RELEASED, coverage: { from: '2026-08-09', to: '2026-08-15' },
      }));
    });

    test('does not load actuals before anything with figures has released', async () => {
      const result = await service(() => NOW).getEvents();
      expect(loadCurrentWeekActuals).not.toHaveBeenCalled();
      expect(result.actuals).toBeUndefined();
    });

    test('keeps the calendar verified when actuals are unavailable', async () => {
      loadCurrentWeekActuals.mockRejectedValue(Object.assign(new Error('blocked'), { code: 'CALENDAR_INVALID_RESPONSE' }));
      const result = await service(() => RELEASED).getEvents();
      expect(result.status).toBe('verified');
      expect(result.actuals).toMatchObject({ status: 'unavailable', observedAt: null });
      expect(result.events.every(event => event.actual === null)).toBe(true);
    });

    test('re-checks quickly while a recent release is missing its figure, then settles', async () => {
      let currentTime = RELEASED;
      const calendar = service(() => currentTime);
      const first = await calendar.getEvents();
      expect(await calendar.getEvents()).toBe(first);
      expect(loadCurrentWeekActuals).toHaveBeenCalledTimes(1);

      loadCurrentWeekActuals.mockResolvedValue({
        provider: 'Trading Economics', sourceUrl: 'https://tradingeconomics.com/calendar',
        observedAt: '2026-08-12T12:47:00.000Z',
        releases: releases.filter(({ id }) => !['te-5'].includes(id)),
      });
      currentTime += ACTUALS_PENDING_TTL_MS;
      const second = await calendar.getEvents();
      expect(loadCurrentWeekActuals).toHaveBeenCalledTimes(2);
      expect(second.events.find(event => event.name === 'Retail Sales m/m').actual).toBe('0.5%');

      currentTime += ACTUALS_PENDING_TTL_MS;
      await calendar.getEvents();
      expect(loadCurrentWeekActuals).toHaveBeenCalledTimes(2);
    });
  });

  test('normalizes only high-impact allowlisted currencies and titles', async () => {
    const rows = [
      calendarRow(),
      calendarRow({ title: 'German Flash Manufacturing PMI', country: 'EUR', date: '2026-08-13T03:30:00-04:00' }),
      calendarRow({ title: 'French Consumer Confidence', country: 'EUR', date: '2026-08-13T04:00:00-04:00' }),
      calendarRow({ title: 'Italian Retail Sales m/m', country: 'EUR', date: '2026-08-13T05:00:00-04:00' }),
      calendarRow({ title: 'ECB Interest Rate Decision', country: 'EUR', date: '2026-08-13T08:15:00-04:00' }),
      calendarRow({ title: 'BoE Monetary Policy Report', country: 'GBP', date: '2026-08-13T07:00:00-04:00' }),
      calendarRow({ title: 'Spanish CPI y/y', country: 'EUR', date: '2026-08-14T03:00:00-04:00' }),
      calendarRow({ title: 'CPI y/y', country: 'AUD', date: '2026-08-14T04:00:00-04:00' }),
      calendarRow({ impact: 'Medium', date: '2026-08-14T08:30:00-04:00' }),
      calendarRow({ title: 'Wholesale Inventories m/m', date: '2026-08-14T10:00:00-04:00' }),
    ];
    const httpClient = { get: jest.fn().mockResolvedValue(providerResponse(rows)) };
    const service = createMarketEventsService({ httpClient, now: () => NOW });

    const result = await service.getEvents();

    expect(result).toMatchObject({
      status: 'verified',
      provider: 'Forex Factory',
      providerMode: 'weekly-export',
      coverage: { from: '2026-08-09', to: '2026-08-15' },
      fetchedAt: '2026-08-10T16:00:00.000Z',
      sourceUpdatedAt: '2026-08-10T15:30:00.000Z',
      sourceUrl: 'https://www.forexfactory.com/calendar/rss',
    });
    expect(result.events).toHaveLength(6);
    expect(result.events.map(({ countryCode }) => countryCode).sort()).toEqual(['DE', 'EU', 'FR', 'IT', 'UK', 'US']);
    expect(result.events.find(({ countryCode }) => countryCode === 'US')).toMatchObject({
      name: 'CPI y/y',
      category: 'inflation',
      startAt: '2026-08-12T12:30:00.000Z',
      forecast: '2.8%',
      previous: '2.7%',
      actual: null,
      unit: null,
      provider: 'Forex Factory',
      verification: 'provider-export',
    });
    expect(httpClient.get).toHaveBeenCalledWith(PROVIDER_EXPORT_URL, {
      timeout: 10000,
      headers: { Accept: 'application/json' },
    });
  });

  test('generates deterministic IDs from timestamp, currency, and title', () => {
    const context = { sourceUpdatedAt: '2026-08-10T15:30:00.000Z' };
    const first = normalizeEvents([calendarRow()], context)[0];
    const repeated = normalizeEvents([calendarRow(), calendarRow()], context);
    const changed = normalizeEvents([calendarRow({ title: 'Core CPI y/y' })], context)[0];

    expect(first.id).toMatch(/^ff-[a-f0-9]{24}$/);
    expect(repeated).toHaveLength(1);
    expect(repeated[0].id).toBe(first.id);
    expect(changed.id).not.toBe(first.id);
  });

  test('loads and caches next week independently from the current-week export', async () => {
    const httpClient = { get: jest.fn().mockResolvedValue(providerResponse()) };
    const service = createMarketEventsService({ httpClient, now: () => NOW });

    const nextWeek = await service.getEvents({ week: 'next' });

    expect(nextWeek).toMatchObject({
      status: 'verified',
      provider: 'Trading Economics',
      providerMode: 'calendar-page',
      coverage: { from: '2026-08-16', to: '2026-08-22' },
      fetchedAt: '2026-08-10T16:00:00.000Z',
      sourceUpdatedAt: null,
      sourceObservedAt: '2026-08-10T16:00:00.000Z',
    });
    expect(loadNextWeekCalendar).toHaveBeenCalledWith({
      httpClient,
      requestedAt: NOW,
      coverage: { from: '2026-08-16', to: '2026-08-22' },
      categorizeEvent: expect.any(Function),
    });
    expect(httpClient.get).not.toHaveBeenCalled();

    const thisWeek = await service.getEvents();
    expect(thisWeek.status).toBe('verified');
    expect(thisWeek.events).toHaveLength(1);
    expect(await service.getEvents({ week: 'next' })).toBe(nextWeek);
    expect(await service.getEvents({ week: 'this' })).toBe(thisWeek);
    expect(loadNextWeekCalendar).toHaveBeenCalledTimes(1);
    expect(httpClient.get).toHaveBeenCalledTimes(1);
  });

  test('coalesces next-week requests without blocking the current week', async () => {
    const pending = deferred();
    loadNextWeekCalendar.mockReturnValue(pending.promise);
    const httpClient = { get: jest.fn().mockResolvedValue(providerResponse()) };
    const service = createMarketEventsService({ httpClient, now: () => NOW });
    const first = service.getEvents({ week: 'next' });
    const second = service.getEvents({ week: 'next' });

    expect((await service.getEvents()).provider).toBe('Forex Factory');
    pending.resolve(nextWeekSnapshot({ requestedAt: NOW, coverage: currentEtWeek(NOW, 'next') }));
    const results = await Promise.all([first, second]);
    expect(results[0]).toBe(results[1]);
    expect(loadNextWeekCalendar).toHaveBeenCalledTimes(1);
  });

  test('clears failed next-week rows and isolates its cooldown from current week', async () => {
    let currentTime = NOW;
    loadNextWeekCalendar
      .mockImplementationOnce(async args => nextWeekSnapshot(args))
      .mockRejectedValue(new Error('private provider details'));
    const httpClient = { get: jest.fn().mockResolvedValue(providerResponse()) };
    const service = createMarketEventsService({ httpClient, now: () => currentTime });
    expect((await service.getEvents({ week: 'next' })).events).toHaveLength(1);
    currentTime += SUCCESS_CACHE_TTL_MS;
    const failed = await service.getEvents({ week: 'next' });
    expect(failed).toMatchObject({
      status: 'unavailable', provider: 'Trading Economics', events: [],
      reason: 'The Trading Economics calendar is temporarily unavailable.',
      sourceUpdatedAt: null, sourceObservedAt: null,
    });
    expect((await service.getEvents()).status).toBe('verified');
    await service.getEvents({ week: 'next' });
    expect(loadNextWeekCalendar).toHaveBeenCalledTimes(2);
    currentTime += FAILURE_COOLDOWN_MS;
    await service.getEvents({ week: 'next' });
    expect(loadNextWeekCalendar).toHaveBeenCalledTimes(3);
  });

  test('preserves only safe provider validation failures for next week', async () => {
    loadNextWeekCalendar.mockRejectedValue(Object.assign(new Error('raw HTML'), {
      code: 'CALENDAR_WEEK_MISMATCH', safeReason: 'The calendar does not match next week.',
    }));
    const result = await createMarketEventsService({ httpClient: { get: jest.fn() }, now: () => NOW })
      .getEvents({ week: 'next' });
    expect(result).toMatchObject({
      status: 'unavailable', code: 'CALENDAR_WEEK_MISMATCH',
      reason: 'The calendar does not match next week.', events: [],
    });
  });

  test('refreshes next-week coverage on ET rollover even while its cache is fresh', async () => {
    let currentTime = Date.parse('2026-08-16T03:59:00.000Z');
    const service = createMarketEventsService({ httpClient: { get: jest.fn() }, now: () => currentTime });
    const saturday = await service.getEvents({ week: 'next' });
    currentTime += 2 * 60 * 1000;
    const sunday = await service.getEvents({ week: 'next' });
    expect(saturday.coverage).toEqual({ from: '2026-08-16', to: '2026-08-22' });
    expect(sunday.coverage).toEqual({ from: '2026-08-23', to: '2026-08-29' });
    expect(loadNextWeekCalendar).toHaveBeenCalledTimes(2);
  });

  test('rejects a response completing after the requested week rolled over', async () => {
    let currentTime = Date.parse('2026-08-16T03:59:59.000Z');
    const pending = deferred();
    loadNextWeekCalendar.mockReturnValue(pending.promise);
    const service = createMarketEventsService({ httpClient: { get: jest.fn() }, now: () => currentTime });
    const result = service.getEvents({ week: 'next' });
    const oldCoverage = currentEtWeek(currentTime, 'next');
    currentTime += 2000;
    pending.resolve(nextWeekSnapshot({ requestedAt: currentTime, coverage: oldCoverage }));
    expect(await result).toMatchObject({
      status: 'unavailable', events: [], coverage: { from: '2026-08-23', to: '2026-08-29' },
    });
  });

  test.each([
    ['2026-03-07T23:00:00.000Z', { from: '2026-03-08', to: '2026-03-14' }],
    ['2026-03-08T05:00:00.000Z', { from: '2026-03-15', to: '2026-03-21' }],
    ['2026-12-30T16:00:00.000Z', { from: '2027-01-03', to: '2027-01-09' }],
  ])('calculates next-week provider coverage at %s', (time, expected) => {
    expect(currentEtWeek(Date.parse(time), 'next')).toEqual(expected);
  });

  test('uses Sunday through Saturday ET coverage across the DST transition', async () => {
    const dstNow = Date.parse('2026-03-09T16:00:00.000Z');
    const rows = [
      calendarRow({ title: 'GDP q/q', date: '2026-03-08T01:30:00-05:00' }),
      calendarRow({ title: 'Unemployment Rate', date: '2026-03-08T03:30:00-04:00' }),
      calendarRow({ title: 'Retail Sales m/m', date: '2026-03-14T23:30:00-04:00' }),
    ];
    const httpClient = {
      get: jest.fn().mockResolvedValue(providerResponse(rows, {
        headers: { 'last-modified': 'Mon, 09 Mar 2026 15:30:00 GMT' },
      })),
    };

    const result = await createMarketEventsService({ httpClient, now: () => dstNow }).getEvents();

    expect(currentEtWeek(dstNow)).toEqual({ from: '2026-03-08', to: '2026-03-14' });
    expect(result.status).toBe('verified');
    expect(result.events).toHaveLength(3);
  });

  test.each([
    [
      'HTML rate-limit response',
      { data: '<html>Too many requests</html>', headers: { 'content-type': 'text/html' } },
      'PROVIDER_RATE_LIMITED',
    ],
    [
      'malformed JSON response',
      providerResponse('{not-json'),
      'PROVIDER_INVALID_RESPONSE',
    ],
    [
      'missing Last-Modified header',
      providerResponse([calendarRow()], { headers: { 'last-modified': null } }),
      'PROVIDER_SOURCE_TIMESTAMP_MISSING',
    ],
    [
      'stale Last-Modified header',
      providerResponse([calendarRow()], { headers: { 'last-modified': 'Mon, 10 Aug 2026 13:59:59 GMT' } }),
      'PROVIDER_SOURCE_STALE',
    ],
    [
      'event outside the current ET week',
      providerResponse([calendarRow({ date: '2026-08-16T00:01:00-04:00' })]),
      'PROVIDER_WEEK_MISMATCH',
    ],
  ])('fails closed for a %s', async (_label, response, expectedCode) => {
    const httpClient = { get: jest.fn().mockResolvedValue(response) };

    const result = await createMarketEventsService({ httpClient, now: () => NOW }).getEvents();

    expect(result).toMatchObject({
      status: 'unavailable',
      provider: 'Forex Factory',
      providerMode: 'weekly-export',
      code: expectedCode,
      events: [],
      retryAt: '2026-08-10T16:05:00.000Z',
    });
    expect(result.reason).not.toContain('<html>');
  });

  test('coalesces concurrent refreshes into one upstream request', async () => {
    const pending = deferred();
    const httpClient = { get: jest.fn().mockReturnValue(pending.promise) };
    const service = createMarketEventsService({ httpClient, now: () => NOW });

    const first = service.getEvents();
    const second = service.getEvents();
    expect(httpClient.get).toHaveBeenCalledTimes(1);

    pending.resolve(providerResponse());
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toBe(secondResult);
  });

  test('caches successful downloads for one hour', async () => {
    let currentTime = NOW;
    const httpClient = { get: jest.fn().mockResolvedValue(providerResponse()) };
    const service = createMarketEventsService({ httpClient, now: () => currentTime });

    await service.getEvents();
    currentTime += SUCCESS_CACHE_TTL_MS - 1;
    await service.getEvents();
    expect(httpClient.get).toHaveBeenCalledTimes(1);

    currentTime += 1;
    await service.getEvents();
    expect(httpClient.get).toHaveBeenCalledTimes(2);
  });

  test('refreshes immediately when ET rolls into a new provider week', async () => {
    let currentTime = Date.parse('2026-08-16T03:59:00.000Z');
    const httpClient = {
      get: jest.fn()
        .mockResolvedValueOnce(providerResponse([
          calendarRow({ date: '2026-08-15T20:00:00-04:00' }),
        ], {
          headers: { 'last-modified': 'Sun, 16 Aug 2026 03:30:00 GMT' },
        }))
        .mockResolvedValueOnce(providerResponse([
          calendarRow({ date: '2026-08-16T00:30:00-04:00' }),
        ], {
          headers: { 'last-modified': 'Sun, 16 Aug 2026 04:00:00 GMT' },
        })),
    };
    const service = createMarketEventsService({ httpClient, now: () => currentTime });

    const saturday = await service.getEvents();
    currentTime += 2 * 60 * 1000;
    const sunday = await service.getEvents();

    expect(saturday.coverage).toEqual({ from: '2026-08-09', to: '2026-08-15' });
    expect(sunday.coverage).toEqual({ from: '2026-08-16', to: '2026-08-22' });
    expect(httpClient.get).toHaveBeenCalledTimes(2);
  });

  test('holds failures behind a five-minute cooldown', async () => {
    let currentTime = NOW;
    const httpClient = { get: jest.fn().mockRejectedValue(new Error('socket details must not leak')) };
    const service = createMarketEventsService({ httpClient, now: () => currentTime });

    const first = await service.getEvents();
    currentTime += FAILURE_COOLDOWN_MS - 1;
    const duringCooldown = await service.getEvents();
    expect(httpClient.get).toHaveBeenCalledTimes(1);
    expect(duringCooldown).toMatchObject({ code: 'PROVIDER_UNAVAILABLE', events: [] });
    expect(first.reason).toBe('The Forex Factory calendar feed is temporarily unavailable.');

    currentTime += 1;
    await service.getEvents();
    expect(httpClient.get).toHaveBeenCalledTimes(2);
  });

  test('discards the prior rows when an hourly refresh fails', async () => {
    let currentTime = NOW;
    const httpClient = {
      get: jest.fn()
        .mockResolvedValueOnce(providerResponse())
        .mockRejectedValueOnce(new Error('offline')),
    };
    const service = createMarketEventsService({ httpClient, now: () => currentTime });

    const verified = await service.getEvents();
    expect(verified.events).toHaveLength(1);

    currentTime += SUCCESS_CACHE_TTL_MS;
    const unavailable = await service.getEvents();
    expect(unavailable).toMatchObject({
      status: 'unavailable',
      code: 'PROVIDER_UNAVAILABLE',
      events: [],
    });

    currentTime += 1000;
    const cooldownResult = await service.getEvents();
    expect(cooldownResult.events).toEqual([]);
    expect(httpClient.get).toHaveBeenCalledTimes(2);
  });
});
