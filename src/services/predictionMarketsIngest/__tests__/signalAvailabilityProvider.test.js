const {
  getOverviewSignalAvailability,
  getRiskRangeHistoryAvailability,
  loadClevelandFedCpiNowcast,
  loadCpiNowcastSnapshots,
  normalizeClevelandFedNowcast,
} = require('../signalAvailabilityProvider');

function dynamodbMock({ item = null, snapshots = [], queryItems = [], itemsByDate = {} } = {}) {
  return {
    get: jest.fn((params) => ({ promise: async () => ({ Item: itemsByDate[params?.Key?.date] || item }) })),
    batchGet: jest.fn((params) => ({
      promise: async () => {
        const tableName = Object.keys(params?.RequestItems || {})[0];
        const rows = tableName === 'RiskRangeData'
          ? (params?.RequestItems?.[tableName]?.Keys || []).flatMap((key) => (
              itemsByDate[key?.date] ? [itemsByDate[key.date]] : []
            ))
          : snapshots;
        return { Responses: { [tableName]: rows } };
      },
    })),
    query: jest.fn(() => ({ promise: async () => ({ Items: queryItems }) })),
  };
}

describe('prediction-market Overview signal availability', () => {
  test('keeps the current monthly CPI forecast in scope across a long release cycle', async () => {
    const currentForecast = {
      date: '2026-08-13',
      publishedAt: '2026-08-13T12:59:50.000Z',
      data: {
        metric: 'Headline CPI YoY',
        forecastMonth: 'August 2026',
        releaseAt: '2026-09-11T12:30:00.000Z',
        scenarios: { upper: 3.58, base: 3.47, lower: 3.36 },
      },
    };
    const dynamodb = dynamodbMock({ snapshots: [currentForecast] });

    const snapshots = await loadCpiNowcastSnapshots(dynamodb, {
      now: Date.parse('2026-09-03T12:00:00.000Z'),
      useCache: false,
    });

    expect(snapshots).toEqual([currentForecast]);
    const keys = dynamodb.batchGet.mock.calls[0][0]
      .RequestItems.HedgeyeDailySnapshot.Keys;
    expect(keys).toHaveLength(75);
    expect(keys).toContainEqual({
      date: '2026-08-13',
      snapshotType: 'inflation-nowcast',
    });
  });

  test('normalizes the official Cleveland Fed daily CPI nowcast history', () => {
    const normalized = normalizeClevelandFedNowcast([
      {
        chart: { _comment: '2026-07-31 00:00', subcaption: '2026-7' },
        categories: [{ category: [{ label: '07/30' }, { label: 'PCE Jun' }, { label: '07/31' }] }],
        dataset: [{
          seriesname: 'CPI Inflation',
          data: [{ value: '3.41' }, { value: '' }, { value: '3.42' }],
        }],
      },
    ], '2026-07');

    expect(normalized).toEqual(expect.objectContaining({
      status: 'available',
      source: 'cleveland_fed_inflation_nowcasting',
      metric: 'Headline CPI YoY',
      value: 3.42,
      period: '2026-07',
      points: [
        { timestamp: Date.parse('2026-07-30T12:00:00.000Z'), value: 3.41 },
        { timestamp: Date.parse('2026-07-31T12:00:00.000Z'), value: 3.42 },
      ],
    }));
  });

  test('does not convert blank Cleveland Fed observations into zero forecasts', () => {
    const normalized = normalizeClevelandFedNowcast([
      {
        chart: { _comment: '2026-08-07 00:00', subcaption: '2026-6' },
        categories: [{ category: [{ label: '07/09' }, { label: '07/10' }] }],
        dataset: [{
          seriesname: 'CPI Inflation',
          data: [{ value: '3.92' }, { value: '' }],
        }],
      },
    ], '2026-06');

    expect(normalized).toMatchObject({ status: 'available', value: 3.92 });
    expect(normalized.points).toEqual([
      { timestamp: Date.parse('2026-07-09T12:00:00.000Z'), value: 3.92 },
    ]);
  });

  test('maps Cleveland Fed observation dates across a report-year boundary', () => {
    const normalized = normalizeClevelandFedNowcast([
      {
        chart: { _comment: '2027-01-08 00:00', subcaption: '2026-12' },
        categories: [{ category: [{ label: '12/30' }, { label: '01/07' }] }],
        dataset: [{
          seriesname: 'CPI Inflation',
          data: [{ value: '3.11' }, { value: '3.12' }],
        }],
      },
    ], '2026-12');

    expect(normalized.points).toEqual([
      { timestamp: Date.parse('2026-12-30T12:00:00.000Z'), value: 3.11 },
      { timestamp: Date.parse('2027-01-07T12:00:00.000Z'), value: 3.12 },
    ]);
    expect(normalized).toMatchObject({ value: 3.12, asOf: '2027-01-07T12:00:00.000Z' });
  });

  test('uses the last valid Cleveland Fed observation before a historical release', async () => {
    const httpClient = {
      get: jest.fn().mockResolvedValue({
        data: [{
          chart: { _comment: '2026-08-07 00:00', subcaption: '2026-6' },
          categories: [{ category: [
            { label: '07/09' },
            { label: '07/13' },
            { label: '07/15' },
          ] }],
          dataset: [{
            seriesname: 'CPI Inflation',
            data: [{ value: '3.92' }, { value: '3.90' }, { value: '3.50' }],
          }],
        }],
      }),
    };

    const result = await loadClevelandFedCpiNowcast({
      requiredMonth: '2026-06',
      releaseAt: '2026-07-14T12:30:00.000Z',
      now: Date.parse('2026-08-09T12:00:00.000Z'),
      httpClient,
      useCache: false,
    });

    expect(result).toMatchObject({
      status: 'available',
      value: 3.9,
      asOf: '2026-07-13T12:00:00.000Z',
      releaseAt: '2026-07-14T12:30:00.000Z',
    });
    expect(result.points).toHaveLength(2);
  });

  test('does not cache a transient Cleveland Fed failure over the next verified response', async () => {
    const httpClient = {
      get: jest.fn()
        .mockRejectedValueOnce(new Error('aborted'))
        .mockRejectedValueOnce(new Error('aborted'))
        .mockResolvedValue({
          data: [{
            chart: { _comment: '2031-05-01 00:00', subcaption: '2031-4' },
            categories: [{ category: [{ label: '04/30' }] }],
            dataset: [{
              seriesname: 'CPI Inflation',
              data: [{ value: '2.45' }],
            }],
          }],
        }),
    };
    const request = {
      requiredMonth: '2031-04',
      releaseAt: '2031-05-12T12:30:00.000Z',
      now: Date.parse('2031-05-01T12:00:00.000Z'),
      httpClient,
      useCache: true,
    };

    await expect(loadClevelandFedCpiNowcast(request)).resolves.toMatchObject({
      status: 'unavailable',
      reason: 'aborted',
    });
    await expect(loadClevelandFedCpiNowcast(request)).resolves.toMatchObject({
      status: 'available',
      value: 2.45,
    });
    await expect(loadClevelandFedCpiNowcast(request)).resolves.toMatchObject({
      status: 'available',
      value: 2.45,
    });
    expect(httpClient.get).toHaveBeenCalledTimes(3);
  });

  test('prefers an exact event-date Risk Range and uses the current publication for future events', async () => {
    const available = await getOverviewSignalAvailability({
      market: 'wti',
      event: { closeTime: '2026-07-22T18:30:00.000Z' },
    }, {
      dynamodb: dynamodbMock({ item: {
        ticker: 'WTIC', date: '2026-07-22', lrr: 80, hrr: 86, prevClose: 82.5,
      } }),
      useCache: false,
    });
    const invalid = await getOverviewSignalAvailability({
      market: 'spx',
      event: { closeTime: '2026-07-21T20:00:00.000Z' },
    }, {
      dynamodb: dynamodbMock({ item: { ticker: 'SPX', date: '2026-07-21', lrr: 7600, hrr: 7500 } }),
      useCache: false,
    });

    expect(available).toEqual(expect.objectContaining({
      status: 'available',
      requiredDate: '2026-07-22',
      details: {
        ticker: 'WTIC',
        date: '2026-07-22',
        lrr: 80,
        hrr: 86,
        previousClose: 82.5,
        trend: null,
        match: 'exact_event_date',
      },
    }));
    expect(invalid).toEqual(expect.objectContaining({ status: 'unavailable', requiredDate: '2026-07-21' }));
  });

  test('uses the verified current publication for a current or future event', async () => {
    const available = await getOverviewSignalAvailability({
      market: 'spx',
      event: { closeTime: '2026-08-03T20:00:00.000Z' },
    }, {
      dynamodb: dynamodbMock({
        item: null,
        queryItems: [{ ticker: 'SPX', date: '2026-07-31', lrr: 7316, hrr: 7538, trend: 'BULLISH' }],
      }),
      now: Date.parse('2026-08-02T18:00:00.000Z'),
      useCache: false,
    });

    expect(available).toEqual(expect.objectContaining({
      status: 'available',
      requiredDate: '2026-08-03',
      asOf: '2026-07-31',
      details: {
        ticker: 'SPX',
        date: '2026-07-31',
        lrr: 7316,
        hrr: 7538,
        trend: 'BULLISH',
        match: 'current_publication',
      },
    }));
  });

  test('loads exact-date Risk Range history for each requested session', async () => {
    const dates = ['2026-07-17', '2026-07-20', '2026-07-21'];
    const dynamodb = dynamodbMock({
      itemsByDate: {
        '2026-07-17': { ticker: 'SPX', date: '2026-07-17', lrr: 7200, hrr: 7350 },
        '2026-07-20': { ticker: 'SPX', date: '2026-07-20', lrr: 7220, hrr: 7380 },
        '2026-07-21': { ticker: 'SPX', date: '2026-07-21', lrr: 7240, hrr: 7400 },
      },
    });
    const result = await getRiskRangeHistoryAvailability({ ticker: 'spx', dates }, {
      dynamodb,
      useCache: false,
    });

    expect(result).toEqual(expect.objectContaining({
      status: 'available',
      source: 'RiskRangeData',
      ticker: 'SPX',
      missingDates: [],
    }));
    expect(result.ranges).toEqual(expect.objectContaining({
      '2026-07-17': expect.objectContaining({ lrr: 7200, hrr: 7350, asOf: '2026-07-17' }),
      '2026-07-21': expect.objectContaining({ lrr: 7240, hrr: 7400, asOf: '2026-07-21' }),
    }));
    expect(dynamodb.batchGet).toHaveBeenCalledTimes(1);
    expect(dynamodb.get).not.toHaveBeenCalled();
  });

  test('chunks long proxy-fit Risk Range history reads within DynamoDB batch limits', async () => {
    const start = Date.parse('2026-01-02T12:00:00.000Z');
    const dates = Array.from({ length: 150 }, (_, index) => (
      new Date(start + index * 24 * 60 * 60_000).toISOString().slice(0, 10)
    ));
    const itemsByDate = Object.fromEntries(dates.map((date, index) => [date, {
      ticker: 'SILVER',
      date,
      lrr: 60 + index / 100,
      hrr: 70 + index / 100,
      previousClose: 65 + index / 100,
      source: 'hedgeye-risk-ranges-email',
    }]));
    const dynamodb = dynamodbMock({ itemsByDate });

    const result = await getRiskRangeHistoryAvailability({ ticker: 'silver', dates }, {
      dynamodb,
      useCache: false,
    });

    expect(result).toMatchObject({ status: 'available', missingDates: [] });
    expect(Object.keys(result.ranges)).toHaveLength(150);
    expect(result.ranges[dates[149]]).toMatchObject({ previousClose: 66.49 });
    expect(dynamodb.batchGet).toHaveBeenCalledTimes(2);
    expect(dynamodb.batchGet.mock.calls.every(([params]) => (
      params.RequestItems.RiskRangeData.Keys.length <= 100
    ))).toBe(true);
    expect(dynamodb.get).not.toHaveBeenCalled();
  });

  test('marks CPI available only when the source forecast month matches the event', async () => {
    const snapshot = {
      date: '2026-07-14',
      publishedAt: '2026-07-14T15:51:00.000Z',
      data: {
        forecastMonth: 'July 2026',
        metric: 'Headline CPI YoY',
        scenarios: [
          { key: 'downside', label: 'Downside', value: 2.7 },
          { key: 'base', label: 'Base Case', value: 2.8 },
          { key: 'upside', label: 'Upside', value: 2.9 },
        ],
      },
    };
    const available = await getOverviewSignalAvailability({
      market: 'cpi',
      event: { ticker: 'KXCPIYOY-26JUL' },
    }, { dynamodb: dynamodbMock({ snapshots: [snapshot] }), now: Date.parse('2026-07-21T18:00:00Z'), useCache: false });
    const mismatch = await getOverviewSignalAvailability({
      market: 'cpi',
      event: { ticker: 'KXCPIYOY-26AUG' },
    }, { dynamodb: dynamodbMock({ snapshots: [snapshot] }), now: Date.parse('2026-07-21T18:00:00Z'), useCache: false });

    expect(available).toEqual(expect.objectContaining({
      status: 'available',
      requiredMonth: '2026-07',
      details: expect.objectContaining({
        forecastMonth: 'July 2026',
        metric: 'Headline CPI YoY',
        scenarios: expect.arrayContaining([
          expect.objectContaining({ key: 'base', value: 2.8 }),
        ]),
      }),
    }));
    expect(mismatch).toEqual(expect.objectContaining({ status: 'unavailable', sourceMonth: '2026-07' }));
  });
});
