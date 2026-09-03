const {
  clearCpiBenchmarkCache,
  loadCpiBenchmarks,
  loadTradingEconomicsCpiConsensus,
  normalizeTradingEconomicsCpiConsensus,
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

  test('builds the following-month release window across year end', () => {
    expect(releaseWindowForMonth('2026-07')).toEqual({ from: '2026-08-01', to: '2026-08-31' });
    expect(releaseWindowForMonth('2026-12')).toEqual({ from: '2027-01-01', to: '2027-01-31' });
  });
});
