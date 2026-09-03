const mockGet = jest.fn();

jest.mock('axios', () => ({
  create: jest.fn(() => ({ get: mockGet })),
}));

const { fetchMarketEvents } = require('./marketEventsService');

describe('marketEvents API client', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  test('requests the one current-week endpoint without range parameters', async () => {
    const payload = { status: 'verified', provider: 'Forex Factory', events: [] };
    const controller = new AbortController();
    mockGet.mockResolvedValue({ data: payload });

    await expect(fetchMarketEvents({ signal: controller.signal })).resolves.toBe(payload);
    expect(mockGet).toHaveBeenCalledWith('/api/market-events', {
      signal: controller.signal,
    });
  });

  test('turns a 503 snapshot into an explicit live invalidation', async () => {
    mockGet.mockRejectedValue({
      response: {
        data: {
          code: 'PROVIDER_SOURCE_STALE',
          reason: 'The Forex Factory calendar feed has not been updated recently enough.',
          retryAt: '2026-08-10T16:05:00.000Z',
          events: [],
        },
      },
    });

    await expect(fetchMarketEvents()).rejects.toMatchObject({
      message: 'The Forex Factory calendar feed has not been updated recently enough.',
      code: 'PROVIDER_SOURCE_STALE',
      retryAt: '2026-08-10T16:05:00.000Z',
      liveInvalidation: true,
    });
  });

  test('never converts a network failure into event rows', async () => {
    mockGet.mockRejectedValue(new Error('connection refused'));

    await expect(fetchMarketEvents()).rejects.toMatchObject({
      code: 'CALENDAR_API_UNAVAILABLE',
      liveInvalidation: true,
    });
  });
});
