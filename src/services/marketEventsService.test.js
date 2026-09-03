const {
  FAILURE_COOLDOWN_MS,
  PROVIDER_EXPORT_URL,
  SUCCESS_CACHE_TTL_MS,
  createMarketEventsService,
  currentEtWeek,
  normalizeEvents,
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

describe('marketEventsService', () => {
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
