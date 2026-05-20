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
});
