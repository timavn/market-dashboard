const {
  getOverviewSignalAvailability,
} = require('../signalAvailabilityProvider');

function dynamodbMock({ item = null, snapshots = [] } = {}) {
  return {
    get: jest.fn(() => ({ promise: async () => ({ Item: item }) })),
    batchGet: jest.fn(() => ({ promise: async () => ({ Responses: { HedgeyeDailySnapshot: snapshots } }) })),
  };
}

describe('prediction-market Overview signal availability', () => {
  test('requires an exact event-date finite Risk Range', async () => {
    const available = await getOverviewSignalAvailability({
      market: 'wti',
      event: { closeTime: '2026-07-22T18:30:00.000Z' },
    }, {
      dynamodb: dynamodbMock({ item: { ticker: 'WTIC', date: '2026-07-22', lrr: 80, hrr: 86 } }),
      useCache: false,
    });
    const invalid = await getOverviewSignalAvailability({
      market: 'spx',
      event: { closeTime: '2026-07-21T20:00:00.000Z' },
    }, {
      dynamodb: dynamodbMock({ item: { ticker: 'SPX', date: '2026-07-21', lrr: 7600, hrr: 7500 } }),
      useCache: false,
    });

    expect(available).toEqual(expect.objectContaining({ status: 'available', requiredDate: '2026-07-22' }));
    expect(invalid).toEqual(expect.objectContaining({ status: 'unavailable', requiredDate: '2026-07-21' }));
  });

  test('marks CPI available only when the source forecast month matches the event', async () => {
    const snapshot = {
      date: '2026-07-14',
      publishedAt: '2026-07-14T15:51:00.000Z',
      data: { forecastMonth: 'July 2026' },
    };
    const available = await getOverviewSignalAvailability({
      market: 'cpi',
      event: { ticker: 'KXCPIYOY-26JUL' },
    }, { dynamodb: dynamodbMock({ snapshots: [snapshot] }), now: Date.parse('2026-07-21T18:00:00Z'), useCache: false });
    const mismatch = await getOverviewSignalAvailability({
      market: 'cpi',
      event: { ticker: 'KXCPIYOY-26AUG' },
    }, { dynamodb: dynamodbMock({ snapshots: [snapshot] }), now: Date.parse('2026-07-21T18:00:00Z'), useCache: false });

    expect(available).toEqual(expect.objectContaining({ status: 'available', requiredMonth: '2026-07' }));
    expect(mismatch).toEqual(expect.objectContaining({ status: 'unavailable', sourceMonth: '2026-07' }));
  });
});
