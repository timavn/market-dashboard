jest.mock('axios', () => ({ get: jest.fn() }));

const axios = require('axios');
const yahoo = require('../yahoo/yahooMarketDataProvider');
const { toLegacyQuote } = require('../normalize/legacyQuoteAdapter');

function yahooResponse(symbol, price = 1.35) {
  return {
    data: {
      chart: {
        result: [{
          meta: {
            symbol,
            regularMarketPrice: price,
            previousClose: price - 0.01,
            regularMarketTime: Math.floor(Date.now() / 1000),
          },
          indicators: { quote: [{ close: [price - 0.01, price] }] },
        }],
        error: null,
      },
    },
  };
}

describe('yahooMarketDataProvider explicit descriptors', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    yahoo.setTickerMappingResolver(() => ({ source: 'yahoo', ticker: 'WRONG=X' }));
  });

  it('honors the explicit USD/CAD provider symbol', async () => {
    axios.get.mockResolvedValue(yahooResponse('USDCAD=X'));

    const result = await yahoo.getQuote({
      symbol: 'USDCAD',
      secType: 'CASH',
      provider: 'yahoo',
      providerSymbol: 'USDCAD=X',
    });

    expect(axios.get.mock.calls[0][0]).toContain('USDCAD%3DX');
    expect(axios.get.mock.calls[0][0]).not.toContain('WRONG');
    expect(result.canonical.observation).toMatchObject({ source: 'yahoo', classification: 'delayed_reference', valid: true, scope: { kind: 'market', accountId: null }, connectionGeneration: null });
    expect(result.canonical.receivedAt).not.toBeNull();
    expect(result.canonical).toMatchObject({
      symbol: 'USDCAD',
      source: 'yahoo',
      dataType: 'delayed',
      valid: true,
    });
  });

  it('honors the explicit cash-index provider symbol', async () => {
    axios.get.mockResolvedValue(yahooResponse('^GSPC', 7500));

    const result = await yahoo.getQuote({
      symbol: 'SPX',
      secType: 'IND',
      provider: 'yahoo',
      providerSymbol: '^GSPC',
    });

    expect(axios.get.mock.calls[0][0]).toContain('%5EGSPC');
    expect(result.canonical.symbol).toBe('SPX');
  });

  it('uses the Yahoo identity rather than the IBKR identity on an automatic fallback', async () => {
    axios.get.mockResolvedValue(yahooResponse('^DJI', 54000));

    const result = await yahoo.getQuote({
      symbol: 'DJI',
      ibkrSymbol: 'INDU',
      yahooSymbol: '^DJI',
      provider: 'auto',
      conId: 1935181,
      secType: 'IND',
      exchange: 'CME',
    });

    expect(axios.get.mock.calls[0][0]).toContain('%5EDJI');
    expect(axios.get.mock.calls[0][0]).not.toContain('INDU');
    expect(result.canonical).toMatchObject({
      symbol: 'DJI',
      source: 'yahoo',
      dataType: 'delayed',
      valid: true,
    });
  });

  it('rejects a provider response for a different Yahoo instrument', async () => {
    axios.get.mockResolvedValue(yahooResponse('WRONG=X'));
    const result = await yahoo.getQuote({ symbol: 'USDCAD', provider: 'yahoo', providerSymbol: 'USDCAD=X' });
    expect(result.canonical.valid).toBe(false);
  });

  it.each([['DOGE', 0.08477, 0.08412], ['LINK', 11.604, 11.579]])('preserves %s provider precision through overview API serialization', async (symbol, price, previousClose) => {
    const response = yahooResponse(`${symbol}-USD`, price);
    response.data.chart.result[0].meta.previousClose = previousClose;
    axios.get.mockResolvedValue(response);
    const result = await yahoo.getQuote({
      symbol, secType: 'CRYPTO', provider: 'yahoo', yahooSymbol: `${symbol}-USD`,
    });
    const legacy = toLegacyQuote(result.canonical);

    expect(axios.get.mock.calls[0][0]).toContain(`/chart/${symbol}-USD`);
    expect(result.canonical).toMatchObject({ valid: true, last: price, close: previousClose });
    expect(Number(legacy.price)).toBe(price);
    expect(Number(legacy.previousClose)).toBe(previousClose);
    expect(Number(legacy.change)).toBeCloseTo(price - previousClose, 10);
    expect(Number(legacy.change)).not.toBe(0);
    expect(legacy.observation).toMatchObject({ classification: 'delayed_reference', valid: true });
  });

  it('keeps four decimals for a coin under $10 asked for by its explicit symbol, and two for the rest', async () => {
    axios.get.mockResolvedValue(yahooResponse('XRP-USD', 0.9275));
    const xrp = toLegacyQuote((await yahoo.getQuote({ symbol: 'XRP-USD', provider: 'yahoo', yahooSymbol: 'XRP-USD' })).canonical);
    expect(xrp.price).toBe('0.9275');
    expect(xrp.previousClose).toBe('0.9175');
    expect(xrp.change).toBe('0.0100');

    axios.get.mockResolvedValue(yahooResponse('SOL-USD', 69.7234));
    expect(toLegacyQuote((await yahoo.getQuote({ symbol: 'SOL-USD', provider: 'yahoo', yahooSymbol: 'SOL-USD' })).canonical).price).toBe('69.72');
    axios.get.mockResolvedValue(yahooResponse('F', 9.8765));
    expect(toLegacyQuote((await yahoo.getQuote({ symbol: 'F', provider: 'yahoo', yahooSymbol: 'F' })).canonical).price).toBe('9.88');
  });

  it.each(['DOGE', 'LINK'])('rejects a bare-symbol stock response for the %s crypto request', async (symbol) => {
    axios.get.mockResolvedValue(yahooResponse(symbol));
    const result = await yahoo.getQuote({
      symbol, secType: 'CRYPTO', provider: 'yahoo', yahooSymbol: `${symbol}-USD`,
    });
    expect(result.canonical.valid).toBe(false);
    expect(toLegacyQuote(result.canonical)).toBeNull();
  });

  it('does not fabricate an observation time when Yahoo omits market time', async () => {
    const response = yahooResponse('^RUT', 3000);
    delete response.data.chart.result[0].meta.regularMarketTime;
    axios.get.mockResolvedValue(response);

    const result = await yahoo.getQuote({
      symbol: 'RUT',
      yahooSymbol: '^RUT',
      provider: 'auto',
    });

    expect(result.canonical).toMatchObject({
      symbol: 'RUT',
      timestamp: null,
      valid: false,
    });
    expect(result.canonical.warning).toMatch(/missing_timestamp/);
  });
});
