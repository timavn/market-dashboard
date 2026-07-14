jest.mock('axios', () => ({ get: jest.fn() }));

const axios = require('axios');
const yahoo = require('../yahoo/yahooMarketDataProvider');

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
});
