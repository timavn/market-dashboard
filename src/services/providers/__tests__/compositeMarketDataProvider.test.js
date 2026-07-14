jest.mock('../ibkr/ibkrMarketDataProvider', () => ({
  getQuote: jest.fn(),
  getProviderStatus: jest.fn(),
  ENABLED: true,
}));

jest.mock('../yahoo/yahooMarketDataProvider', () => ({
  getQuote: jest.fn(),
  getProviderStatus: jest.fn(() => ({ name: 'yahoo', connected: true })),
  setTickerMappingResolver: jest.fn(),
}));

const ibkr = require('../ibkr/ibkrMarketDataProvider');
const yahoo = require('../yahoo/yahooMarketDataProvider');
const composite = require('../compositeMarketDataProvider');
const { normalizeIbkrRaw } = require('../normalize/normalizeQuote');

describe('compositeMarketDataProvider fallback', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    composite.setSpecialQuoteFetcher(async () => null);
  });

  it('returns IBKR quote when valid', async () => {
    const canonical = normalizeIbkrRaw({
      symbol: 'AAPL',
      bid: 100,
      ask: 101,
      last: 100.5,
      close: 99,
      timestamp: new Date().toISOString(),
      dataType: 'live',
    });
    ibkr.getQuote.mockResolvedValue({ canonical, error: null });

    const legacy = await composite.getQuote('AAPL');
    expect(legacy.source).toBe('ibkr');
    expect(yahoo.getQuote).not.toHaveBeenCalled();
  });

  it('falls back to Yahoo with warning when IBKR fails', async () => {
    ibkr.getQuote.mockResolvedValue({ canonical: null, error: 'not_connected' });
    const yahooCanonical = {
      symbol: 'AAPL',
      source: 'yahoo',
      mark: 100,
      mid: null,
      last: 100,
      close: 99,
      timestamp: new Date().toISOString(),
      valid: true,
      warning: 'yahoo_fallback',
    };
    yahoo.getQuote.mockResolvedValue({ canonical: yahooCanonical, error: null });

    const legacy = await composite.getQuote('AAPL');
    expect(legacy.source).toBe('yahoo');
    expect(legacy.warning).toMatch(/ibkr/);
    expect(legacy.warning).toMatch(/yahoo/);
  });

  it('does not mix IBKR and Yahoo fields in one quote', async () => {
    ibkr.getQuote.mockResolvedValue({ canonical: null, error: 'invalid_quote' });
    yahoo.getQuote.mockResolvedValue({
      canonical: {
        symbol: 'AAPL',
        source: 'yahoo',
        mark: 50,
        last: 50,
        close: 49,
        timestamp: new Date().toISOString(),
        valid: true,
        warning: null,
      },
      error: null,
    });

    const legacy = await composite.getQuote('AAPL');
    expect(legacy.source).toBe('yahoo');
    expect(legacy.price).toBe('50.00');
  });

  it('routes an explicit SPX cash-index descriptor directly to Yahoo', async () => {
    const descriptor = {
      symbol: 'SPX',
      secType: 'IND',
      provider: 'yahoo',
      providerSymbol: '^GSPC',
    };
    yahoo.getQuote.mockResolvedValue({
      canonical: {
        symbol: 'SPX',
        source: 'yahoo',
        mark: 7500,
        last: 7500,
        close: 7490,
        timestamp: new Date().toISOString(),
        dataType: 'delayed',
        valid: true,
        warning: 'yahoo_fallback',
      },
      error: null,
    });

    const legacy = await composite.getQuote(descriptor);

    expect(legacy.symbol).toBe('SPX');
    expect(legacy.source).toBe('yahoo');
    expect(ibkr.getQuote).not.toHaveBeenCalled();
    expect(yahoo.getQuote).toHaveBeenCalledWith(descriptor);
  });

  it.each([
    { symbol: 'BZ', secType: 'FUT', provider: 'yahoo', providerSymbol: 'BZ=F' },
    { symbol: 'BTC', secType: 'CRYPTO', provider: 'yahoo', providerSymbol: 'BTC-USD' },
    { symbol: 'USDCAD', secType: 'CASH', provider: 'yahoo', providerSymbol: 'USDCAD=X' },
  ])('does not ask IBKR for non-equity descriptor $symbol', async (descriptor) => {
    yahoo.getQuote.mockResolvedValue({ canonical: null, error: 'invalid_yahoo' });
    await composite.getQuote(descriptor);
    expect(ibkr.getQuote).not.toHaveBeenCalled();
    expect(yahoo.getQuote).toHaveBeenCalledWith(descriptor);
  });
});
