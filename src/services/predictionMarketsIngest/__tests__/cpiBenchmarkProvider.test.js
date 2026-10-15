const {
  clearCpiBenchmarkCache,
  loadCpiBenchmarks,
  loadTradingEconomicsCpiConsensus,
  loadTradingEconomicsPublicReleaseSetup,
  normalizeTradingEconomicsCpiConsensus,
  normalizeTradingEconomicsPublicReleaseSetup,
  releaseWindowForMonth,
} = require('../cpiBenchmarkProvider');

function consensusRow(overrides = {}) {
  return {
    CalendarId: 'cpi-jul-2026',
    Date: '2026-08-12T12:30:00',
    Country: 'United States',
    Category: 'Inflation Rate',
    Event: 'Inflation Rate YoY',
    Reference: 'Jul',
    ReferenceDate: '2026-07-31T00:00:00.000Z',
    Forecast: '3.4%',
    ForecastValue: 3.4,
    TEForecast: '9.9%',
    TEForecastValue: 9.9,
    LastUpdate: '2026-08-09T16:05:00',
    Unit: '%',
    URL: '/united-states/inflation-cpi',
    ...overrides,
  };
}

function publicCalendarRow({
  event,
  date = '2026-09-11',
  reference = 'AUG',
  previous = '',
  consensus = '',
  forecast = '',
  actual = '',
} = {}) {
  return `
    <tr data-event="${event}">
      <td class=" ${date}"></td>
      <td><table><tr><td>US</td></tr></table></td>
      <td><span class="calendar-reference">${reference}</span></td>
      <td><span id="actual">${actual}</span></td>
      <td><span id="previous">${previous}</span></td>
      <td><a id="consensus">${consensus}</a></td>
      <td><a id="forecast">${forecast}</a></td>
    </tr>`;
}

function publicCalendarHtml(overrides = {}) {
  return [
    publicCalendarRow({
      event: 'inflation rate mom', previous: '0.1%', consensus: '0.4%', forecast: '0.4%',
      ...overrides['headline-mom'],
    }),
    publicCalendarRow({
      event: 'inflation rate yoy', previous: '3.4%', consensus: '', forecast: '3.4%',
      ...overrides['headline-yoy'],
    }),
    publicCalendarRow({
      event: 'core inflation rate mom', previous: '0.2%', consensus: '0.2%', forecast: '0.2%',
      ...overrides['core-mom'],
    }),
    publicCalendarRow({
      event: 'core inflation rate yoy', previous: '2.5%', consensus: '', forecast: '2.4%',
      ...overrides['core-yoy'],
    }),
  ].join('\n');
}

describe('CPI forecast benchmark providers', () => {
  beforeEach(() => {
    clearCpiBenchmarkCache();
  });

  afterEach(() => {
    clearCpiBenchmarkCache();
  });

  test('selects only the exact US Headline CPI YoY month and uses survey consensus', () => {
    const result = normalizeTradingEconomicsCpiConsensus([
      consensusRow({ Event: 'Core Inflation Rate YoY', ForecastValue: 2.6 }),
      consensusRow({ Country: 'Canada', ForecastValue: 8.8 }),
      consensusRow({ Unit: 'Index Points', ForecastValue: 7.7 }),
      consensusRow({ ReferenceDate: '2026-06-30T00:00:00.000Z', ForecastValue: 3.8 }),
      consensusRow({ Forecast: '3.6%', ForecastValue: 3.4 }),
    ], '2026-07');

    expect(result).toMatchObject({
      id: 'wall-street-consensus',
      kind: 'consensus',
      period: '2026-07',
      status: 'available',
      point: 3.4,
      source: 'trading_economics_consensus',
      releaseAt: '2026-08-12T12:30:00.000Z',
      asOf: '2026-08-09T16:05:00.000Z',
    });
    expect(result.point).not.toBe(9.9);
  });

  test('never substitutes Trading Economics proprietary forecast for blank consensus', () => {
    const result = normalizeTradingEconomicsCpiConsensus([
      consensusRow({ Forecast: '', ForecastValue: '', TEForecast: '3.9%', TEForecastValue: 3.9 }),
    ], '2026-07');

    expect(result).toMatchObject({
      status: 'unavailable',
      point: null,
      reason: expect.stringContaining('has not been published'),
    });
  });

  test('parses the exact public release rows without substituting house forecasts for consensus', () => {
    const rows = normalizeTradingEconomicsPublicReleaseSetup(
      `${publicCalendarRow({
        event: 'inflation rate yoy', date: '2026-08-12', reference: 'JUL',
        previous: '3.5%', consensus: '3.4%', forecast: '3.4%',
      })}${publicCalendarHtml()}`,
      '2026-08',
      {
        releaseAt: '2026-09-11T12:30:00.000Z',
        checkedAt: '2026-09-03T20:00:00.000Z',
      },
    );

    expect(rows).toEqual([
      expect.objectContaining({ id: 'headline-mom', status: 'available', previous: 0.1, consensus: 0.4, providerForecast: 0.4 }),
      expect.objectContaining({ id: 'headline-yoy', status: 'available', previous: 3.4, consensus: null, providerForecast: 3.4 }),
      expect.objectContaining({ id: 'core-mom', status: 'available', previous: 0.2, consensus: 0.2, providerForecast: 0.2 }),
      expect.objectContaining({ id: 'core-yoy', status: 'available', previous: 2.5, consensus: null, providerForecast: 2.4 }),
    ]);
    expect(rows[1].reason).toMatch(/has not been published/i);
  });

  test('loads a source-dated public release setup with an exact release-day request', async () => {
    const httpClient = { get: jest.fn().mockResolvedValue({ data: publicCalendarHtml() }) };
    const result = await loadTradingEconomicsPublicReleaseSetup({
      requiredMonth: '2026-08',
      releaseAt: '2026-09-11T12:30:00.000Z',
      now: Date.parse('2026-09-03T20:00:00.000Z'),
      httpClient,
      useCache: false,
    });

    expect(result).toMatchObject({
      status: 'available',
      period: '2026-08',
      releaseAt: '2026-09-11T12:30:00.000Z',
      checkedAt: '2026-09-03T20:00:00.000Z',
    });
    expect(result.rows).toHaveLength(4);
    expect(httpClient.get).toHaveBeenCalledWith(
      'https://tradingeconomics.com/united-states/calendar',
      expect.objectContaining({
        params: { importance: 3, start: '2026-09-11', end: '2026-09-11' },
      }),
    );
  });

  test('uses the surveyed Forecast string when ForecastValue is blank', () => {
    const result = normalizeTradingEconomicsCpiConsensus([
      consensusRow({ Forecast: '3.45%', ForecastValue: '', TEForecastValue: 8.8 }),
    ], '2026-07');

    expect(result).toMatchObject({ status: 'available', point: 3.45 });
  });

  test('does not call the upstream provider when credentials are missing', async () => {
    const httpClient = { get: jest.fn() };
    const result = await loadTradingEconomicsCpiConsensus({
      requiredMonth: '2026-07',
      apiKey: '',
      httpClient,
      useCache: false,
    });

    expect(httpClient.get).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: 'unavailable',
      point: null,
      errorCode: 'PROVIDER_NOT_CONFIGURED',
    });
  });

  test('replaces an expired cached consensus with unavailable after refresh failure', async () => {
    const firstNow = Date.parse('2026-06-01T12:00:00.000Z');
    const httpClient = {
      get: jest.fn()
        .mockResolvedValueOnce({ data: [consensusRow()] })
        .mockRejectedValueOnce(new Error('provider offline')),
    };
    const available = await loadTradingEconomicsCpiConsensus({
      requiredMonth: '2026-07',
      apiKey: 'licensed-key',
      httpClient,
      now: firstNow,
    });
    const unavailable = await loadTradingEconomicsCpiConsensus({
      requiredMonth: '2026-07',
      apiKey: 'licensed-key',
      httpClient,
      now: firstNow + (2 * 60 * 60 * 1000) + 1,
    });

    expect(available).toMatchObject({ status: 'available', point: 3.4 });
    expect(unavailable).toMatchObject({
      status: 'unavailable',
      point: null,
      errorCode: 'UPSTREAM_UNAVAILABLE',
    });
    expect(httpClient.get).toHaveBeenCalledTimes(2);
  });

  test('uses a thirty-minute cache during the final twenty-four hours', async () => {
    const firstNow = Date.parse('2026-08-11T13:00:00.000Z');
    const httpClient = {
      get: jest.fn().mockResolvedValue({ data: [consensusRow()] }),
    };
    await loadTradingEconomicsCpiConsensus({
      requiredMonth: '2026-07',
      apiKey: 'licensed-key',
      httpClient,
      now: firstNow,
    });
    await loadTradingEconomicsCpiConsensus({
      requiredMonth: '2026-07',
      apiKey: 'licensed-key',
      httpClient,
      now: firstNow + (29 * 60 * 1000),
    });
    await loadTradingEconomicsCpiConsensus({
      requiredMonth: '2026-07',
      apiKey: 'licensed-key',
      httpClient,
      now: firstNow + (30 * 60 * 1000) + 1,
    });

    expect(httpClient.get).toHaveBeenCalledTimes(2);
  });

  test('returns independent source states when consensus is unavailable', async () => {
    const loadClevelandFed = jest.fn().mockResolvedValue({
      status: 'available',
      metric: 'Headline CPI YoY',
      period: '2026-07',
      sourceMonth: '2026-07',
      value: 3.42,
      asOf: '2026-08-07T12:00:00.000Z',
    });
    const result = await loadCpiBenchmarks({
      month: '2026-07',
      apiKey: '',
      useCache: false,
      now: Date.parse('2026-08-09T12:00:00.000Z'),
      loadClevelandFed,
    });

    expect(result).toMatchObject({
      ok: true,
      period: '2026-07',
      metric: 'headline-cpi-yoy',
      unit: 'percent',
    });
    expect(result.sources).toEqual([
      expect.objectContaining({
        id: 'wall-street-consensus',
        status: 'unavailable',
        point: null,
        releaseAt: '2026-08-12T12:30:00.000Z',
      }),
      expect.objectContaining({
        id: 'cleveland-fed',
        status: 'available',
        point: 3.42,
        releaseAt: '2026-08-12T12:30:00.000Z',
      }),
    ]);
    expect(loadClevelandFed).toHaveBeenCalledWith(expect.objectContaining({
      requiredMonth: '2026-07',
      releaseAt: '2026-08-12T12:30:00.000Z',
    }));
  });

  test('adds the public release table while leaving an unpublished headline consensus pending', async () => {
    const publicHttpClient = {
      get: jest.fn().mockResolvedValue({ data: publicCalendarHtml() }),
    };
    const result = await loadCpiBenchmarks({
      month: '2026-08',
      apiKey: '',
      includePublicReleaseSetup: true,
      publicHttpClient,
      useCache: false,
      now: Date.parse('2026-09-03T20:00:00.000Z'),
      loadClevelandFed: jest.fn().mockResolvedValue({
        status: 'available',
        metric: 'Headline CPI YoY',
        period: '2026-08',
        sourceMonth: '2026-08',
        value: 3.38,
        asOf: '2026-09-01T12:00:00.000Z',
      }),
    });

    expect(result.sources[0]).toMatchObject({
      id: 'wall-street-consensus',
      status: 'unavailable',
      point: null,
      reason: expect.stringContaining('has not been published'),
    });
    expect(result.releaseSetup).toMatchObject({
      status: 'available',
      period: '2026-08',
      releaseAt: '2026-09-11T12:30:00.000Z',
    });
    expect(result.releaseSetup.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'headline-mom', consensus: 0.4, providerForecast: 0.4 }),
      expect.objectContaining({ id: 'headline-yoy', consensus: null, providerForecast: 3.4 }),
    ]));
  });

  test('builds the following-month release window across year end', () => {
    expect(releaseWindowForMonth('2026-07')).toEqual({ from: '2026-08-01', to: '2026-08-31' });
    expect(releaseWindowForMonth('2026-12')).toEqual({ from: '2027-01-01', to: '2027-01-31' });
  });
});
