const mockGet = jest.fn();

jest.mock('axios', () => ({
  create: jest.fn(() => ({
    get: mockGet,
    post: jest.fn(),
    interceptors: { response: { use: jest.fn() } },
  })),
}));

const { MarketDataService } = require('../marketDataService');

describe('MarketDataService Gold correlations', () => {
  beforeEach(() => mockGet.mockReset());

  test('requests the dedicated endpoint with caller cancellation', async () => {
    const payload = { status: 'available', basis: { symbol: 'XAUUSD' }, rows: [] };
    const controller = new AbortController();
    mockGet.mockResolvedValue({ data: payload });

    await expect(MarketDataService.getGoldCorrelations({ signal: controller.signal }))
      .resolves.toBe(payload);
    expect(mockGet).toHaveBeenCalledWith('/api/gold/correlations', {
      signal: controller.signal,
      timeout: 20_000,
    });
  });

  test('surfaces provider failure instead of returning a prior result', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockGet.mockRejectedValue(new Error('XAUUSD unavailable'));
    try {
      await expect(MarketDataService.getGoldCorrelations()).rejects.toThrow('XAUUSD unavailable');
    } finally {
      consoleError.mockRestore();
    }
  });
});
