const mockGet = jest.fn();

jest.mock('axios', () => ({
  create: jest.fn(() => ({
    get: mockGet,
    post: jest.fn(),
    interceptors: {
      response: {
        use: jest.fn(),
      },
    },
  })),
}));

const { MarketDataService } = require('../marketDataService');

describe('MarketDataService Hedgeye CPI history', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  test('requests the bounded historical model endpoint without quote fallbacks', async () => {
    const payload = {
      entries: [{
        monthId: '2026-07',
        status: 'provisional',
        scenarios: {
          upper: { raw: 3.58, rounded: 3.6 },
          base: { raw: 3.47, rounded: 3.5 },
          lower: { raw: 3.36, rounded: 3.4 },
        },
      }],
    };
    mockGet.mockResolvedValue({ data: payload });

    await expect(MarketDataService.getHedgeyeInflationNowcastHistory({
      from: '2025-07',
      to: '2026-07',
    })).resolves.toEqual(payload);
    expect(mockGet).toHaveBeenCalledWith(
      '/api/hedgeye/inflation-nowcast/history',
      { params: { from: '2025-07', to: '2026-07' } },
    );
  });

  test('surfaces history errors instead of inventing model values', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockGet.mockRejectedValue(new Error('history unavailable'));
    try {
      await expect(
        MarketDataService.getHedgeyeInflationNowcastHistory({ from: '2025-07' }),
      ).rejects.toThrow('history unavailable');
    } finally {
      consoleError.mockRestore();
    }
  });
});
