const mockGet = jest.fn();
jest.mock('axios', () => ({ create: jest.fn(() => ({ get: mockGet, post: jest.fn(), interceptors: { response: { use: jest.fn() } } })) }));
const { MarketDataService } = require('../marketDataService');

describe('split Contract P&L endpoints', () => {
  beforeEach(() => mockGet.mockReset());
  test.each([
    ['getPredictionMarketPerformanceHistory', '/api/prediction-markets/performance/history'],
    ['getPredictionMarketPerformanceCurrent', '/api/prediction-markets/performance/current'],
  ])('%s sends only exact-account scope with caller cancellation', async (method, endpoint) => {
    const payload = { rows: [], projectionRevision: 'v1' }; const controller = new AbortController();
    mockGet.mockResolvedValue({ data: payload });
    await expect(MarketDataService[method]({ account: 'U123', signal: controller.signal })).resolves.toBe(payload);
    expect(mockGet).toHaveBeenCalledWith(endpoint, { params: { account: 'U123' }, signal: controller.signal, timeout: 15000 });
  });
  test.each(['getPredictionMarketPerformanceHistory', 'getPredictionMarketPerformanceCurrent'])('%s propagates failure without legacy fallback', async (method) => {
    const error = { response: { status: 503, data: { code: 'HISTORY_PREPARING' } } }; mockGet.mockRejectedValue(error);
    await expect(MarketDataService[method]({ account: 'U123' })).rejects.toBe(error);
    expect(mockGet).toHaveBeenCalledTimes(1);
  });
  test('detail requests carry the revision and encoded record identity', async () => {
    mockGet.mockResolvedValue({ data: { entryQuantity: 2 } });
    await MarketDataService.getPredictionMarketPerformanceExecutions('record#1', { account: 'U123', revision: 'v2' });
    expect(mockGet).toHaveBeenCalledWith('/api/prediction-markets/performance/record%231/executions', expect.objectContaining({ params: { account: 'U123', revision: 'v2' } }));
  });
});
