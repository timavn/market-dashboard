import axios from 'axios';
import predictionMarketTestService from './predictionMarketTestService';

jest.mock('axios', () => ({ get: jest.fn() }));

describe('predictionMarketTestService monitor API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    axios.get.mockResolvedValue({ data: { schemaVersion: 2, marketId: 'sp500' } });
  });

  test.each(['sp500', 'wti', 'nasdaq100', 'gold', 'silver', 'brent', 'bitcoin', 'ethereum', 'cpi', 'gdp'])(
    'loads %s through the normalized v2 monitor route with cancellation support',
    async (marketId) => {
      const controller = new AbortController();
      const expected = { schemaVersion: 2, marketId };
      axios.get.mockResolvedValueOnce({ data: expected });

      await expect(predictionMarketTestService.getMonitor(marketId, {
        signal: controller.signal,
      })).resolves.toBe(expected);

      expect(axios.get).toHaveBeenCalledWith(
        expect.stringMatching(new RegExp(`/api/prediction-market-test/monitor/${marketId}$`)),
        {
          signal: controller.signal,
          timeout: 20_000,
          headers: { 'Cache-Control': 'no-cache' },
          params: {
            view: 'card',
            ...({ sp500: { venue: 'forecastex' }, gdp: { venue: 'forecastex' }, gold: { venue: 'kalshi' }, cpi: { venue: 'kalshi' } }[marketId] || {}),
          },
          validateStatus: expect.any(Function),
        },
      );
    },
  );

  test('rejects unsupported markets before making a request', async () => {
    await expect(predictionMarketTestService.getMonitor('eurusd')).rejects.toThrow(TypeError);
    expect(axios.get).not.toHaveBeenCalled();
  });

  test('keeps Ethereum and Bitcoin monitor revisions separate', async () => {
    const ethereum = { schemaVersion: 2, marketId: 'ethereum', revision: 9 };
    const bitcoin = { schemaVersion: 2, marketId: 'bitcoin', revision: 12 };
    const options = { generationId: 'crypto-isolation' };
    axios.get
      .mockResolvedValueOnce({ status: 200, data: ethereum, headers: { etag: '"ethereum-9"' } })
      .mockResolvedValueOnce({ status: 200, data: bitcoin, headers: { etag: '"bitcoin-12"' } })
      .mockResolvedValueOnce({ status: 304, headers: {} });

    await expect(predictionMarketTestService.getMonitor(' Ethereum ', options)).resolves.toBe(ethereum);
    await expect(predictionMarketTestService.getMonitor('bitcoin', options)).resolves.toBe(bitcoin);
    await expect(predictionMarketTestService.getMonitor('ethereum', options)).resolves.toBe(ethereum);

    expect(axios.get).toHaveBeenLastCalledWith(
      expect.stringMatching(/\/api\/prediction-market-test\/monitor\/ethereum$/),
      expect.objectContaining({
        headers: { 'Cache-Control': 'no-cache', 'If-None-Match': '"ethereum-9"' },
        params: { view: 'card', generationId: 'crypto-isolation' },
      }),
    );
    expect(axios.get.mock.calls[1][1].headers).toEqual({ 'Cache-Control': 'no-cache' });
  });

  test('requests the fixed SP500 ForecastEx venue without a generation override', async () => {
    const controller = new AbortController();
    await predictionMarketTestService.getMonitor('sp500', {
      signal: controller.signal,
      venue: 'forecastex',
      generationId: null,
    });

    expect(axios.get).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/prediction-market-test\/monitor\/sp500$/),
      expect.objectContaining({
        signal: controller.signal,
        params: expect.objectContaining({ venue: 'forecastex', view: 'card' }),
      }),
    );
  });

  test('requests the Gold card from the fixed Kalshi venue', async () => {
    await predictionMarketTestService.getMonitor('gold', { venue: 'kalshi' });

    expect(axios.get).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/prediction-market-test\/monitor\/gold$/),
      expect.objectContaining({
        params: expect.objectContaining({ venue: 'kalshi', view: 'card' }),
      }),
    );
  });

  test('requests the CPI card from the fixed Kalshi venue', async () => {
    await predictionMarketTestService.getMonitor('cpi', { venue: 'auto' });

    expect(axios.get).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/prediction-market-test\/monitor\/cpi$/),
      expect.objectContaining({
        params: { view: 'card', venue: 'kalshi' },
      }),
    );
  });

  test('shares the retained response and ETag across Gold auto and Kalshi aliases', async () => {
    const retained = { schemaVersion: 2, marketId: 'gold', revision: 12 };
    axios.get
      .mockResolvedValueOnce({ status: 200, data: retained, headers: { etag: '"gold-12"' } })
      .mockResolvedValueOnce({ status: 304, data: null, headers: {} });

    await expect(predictionMarketTestService.getMonitor('gold', { venue: 'auto' }))
      .resolves.toBe(retained);
    await expect(predictionMarketTestService.getMonitor('gold', { venue: 'kalshi' }))
      .resolves.toBe(retained);

    expect(axios.get).toHaveBeenLastCalledWith(
      expect.stringMatching(/\/api\/prediction-market-test\/monitor\/gold$/),
      expect.objectContaining({
        headers: expect.objectContaining({ 'If-None-Match': '"gold-12"' }),
        params: { view: 'card', venue: 'kalshi' },
      }),
    );
  });

  test('retains the SPX compatibility alias', async () => {
    const controller = new AbortController();
    await predictionMarketTestService.getSpxMonitor({ signal: controller.signal });
    expect(axios.get).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/prediction-market-test\/spx-monitor$/),
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  test('loads the morning report and accepts its structured catalog-level 503', async () => {
    const controller = new AbortController();
    const expected = { schemaVersion: 1, reportType: 'four_market_morning' };
    axios.get.mockResolvedValueOnce({ data: expected });

    await expect(predictionMarketTestService.getMorningReport({
      signal: controller.signal,
    })).resolves.toBe(expected);

    expect(axios.get).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/prediction-market-test\/morning-report$/),
      expect.objectContaining({
        signal: controller.signal,
        timeout: 20_000,
        headers: { 'Cache-Control': 'no-cache' },
        validateStatus: expect.any(Function),
      }),
    );
    const { validateStatus } = axios.get.mock.calls[0][1];
    expect(validateStatus(200)).toBe(true);
    expect(validateStatus(503)).toBe(true);
    expect(validateStatus(500)).toBe(false);
  });
});
