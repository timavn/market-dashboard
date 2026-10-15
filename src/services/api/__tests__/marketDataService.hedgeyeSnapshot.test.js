const mockGet = jest.fn();
jest.mock('axios', () => ({
  create: jest.fn(() => ({
    get: mockGet,
    post: jest.fn(),
    interceptors: { response: { use: jest.fn() } },
  })),
}));

const { MarketDataService } = require('../marketDataService');

beforeEach(() => {
  mockGet.mockReset();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

test('allows callers to distinguish transport failures from a missing publication', async () => {
  const error = new Error('Network unavailable');
  mockGet.mockRejectedValueOnce(error);
  await expect(MarketDataService.getHedgeyeSnapshot('early-look', '2026-09-25', { throwOnError: true })).rejects.toBe(error);

  mockGet.mockRejectedValueOnce({ response: { status: 404 } });
  await expect(MarketDataService.getHedgeyeSnapshot('early-look', '2026-09-25', { throwOnError: true })).resolves.toBeNull();
});

test('preserves existing callers default null-on-error behavior and successful payloads', async () => {
  mockGet.mockRejectedValueOnce(new Error('Network unavailable'));
  await expect(MarketDataService.getHedgeyeSnapshot('early-look', '2026-09-25')).resolves.toBeNull();

  const payload = { source: 'gmail-html', date: '2026-09-25' };
  mockGet.mockResolvedValueOnce({ data: payload });
  await expect(MarketDataService.getHedgeyeSnapshot('early-look', '2026-09-25', { throwOnError: true })).resolves.toEqual(payload);
  expect(mockGet).toHaveBeenLastCalledWith('/api/hedgeye/snapshot/early-look', { params: { date: '2026-09-25' } });
});
