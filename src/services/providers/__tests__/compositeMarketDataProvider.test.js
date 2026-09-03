jest.mock('../ibkr/ibkrMarketDataProvider', () => ({
  getQuote: jest.fn(),
  getHistoricalBars: jest.fn(),
  getProviderStatus: jest.fn(),
  ENABLED: true,
}));

jest.mock('../yahoo/yahooMarketDataProvider', () => ({
  getQuote: jest.fn(),
  getHistoricalBars: jest.fn(),
  getProviderStatus: jest.fn(() => ({ name: 'yahoo', connected: true })),
  setTickerMappingResolver: jest.fn(),
}));

const ibkr = require('../ibkr/ibkrMarketDataProvider');
const yahoo = require('../yahoo/yahooMarketDataProvider');
const composite = require('../compositeMarketDataProvider');
const { getProviderStatusSnapshot } = require('../providerStatus');
const { normalizeIbkrRaw } = require('../normalize/normalizeQuote');

const AUTO_DOW_DESCRIPTOR = Object.freeze({
  symbol: 'DJI',
  ibkrSymbol: 'INDU',
  yahooSymbol: '^DJI',
  conId: 1935181,
  secType: 'IND',
  exchange: 'CME',
  currency: 'USD',
  provider: 'auto',
});

function yahooDowCanonical() {
  return {
    symbol: 'DJI',
    source: 'yahoo',
    mark: 54000,
    mid: null,
    last: 54000,
    close: 53885,
    timestamp: new Date().toISOString(),
    dataType: 'delayed',
    valid: true,
    warning: 'delayed_data',
  };
}

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
    expect(getProviderStatusSnapshot().market).toMatchObject({
      lastSource: 'yahoo',
      lastWarning: expect.stringMatching(/ibkr/),
    });
    expect(Number.isFinite(Date.parse(getProviderStatusSnapshot().market.lastQuoteAt))).toBe(true);
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

  it('does not let historical reference quotes overwrite market-provider health', async () => {
    ibkr.getQuote.mockResolvedValue({
      canonical: normalizeIbkrRaw({
        symbol: 'AAPL',
        bid: 100,
        ask: 101,
        last: 100.5,
        close: 99,
        timestamp: new Date().toISOString(),
        dataType: 'live',
      }),
      error: null,
    });
    await composite.getQuote('AAPL');

    composite.setSpecialQuoteFetcher(async () => ({
      legacy: {
        symbol: 'US10Y',
        price: '4.25',
        source: 'fred',
        dataType: 'historical',
        timestamp: new Date().toISOString(),
      },
    }));
    await composite.getQuote('US10Y');

    expect(getProviderStatusSnapshot().market.lastSource).toBe('ibkr');
  });

  it('records a failed refresh without erasing the last verified provider', async () => {
    ibkr.getQuote.mockResolvedValue({
      canonical: normalizeIbkrRaw({
        symbol: 'AAPL',
        bid: 100,
        ask: 101,
        last: 100.5,
        close: 99,
        timestamp: new Date().toISOString(),
        dataType: 'live',
      }),
      error: null,
    });
    await composite.getQuote('AAPL');

    ibkr.getQuote.mockResolvedValue({ canonical: null, error: 'invalid_quote' });
    yahoo.getQuote.mockResolvedValue({ canonical: null, error: 'invalid_yahoo' });
    await composite.getQuote('AAPL');

    expect(getProviderStatusSnapshot().market).toMatchObject({
      lastSource: 'ibkr',
      lastError: 'no_quote_available',
    });
  });

  it('routes an explicit SPX cash-index descriptor directly to IBKR', async () => {
    const descriptor = {
      symbol: 'SPX',
      secType: 'IND',
      provider: 'ibkr',
      providerSymbol: 'SPX',
      conId: 416904,
      exchange: 'CBOE',
    };
    ibkr.getQuote.mockResolvedValue({
      canonical: {
        symbol: 'SPX',
        source: 'ibkr',
        mark: 7500,
        last: 7500,
        close: 7490,
        timestamp: new Date().toISOString(),
        dataType: 'live',
        valid: true,
        warning: null,
      },
      error: null,
    });

    const legacy = await composite.getQuote(descriptor);

    expect(legacy.symbol).toBe('SPX');
    expect(legacy.source).toBe('ibkr');
    expect(ibkr.getQuote).toHaveBeenCalledWith(descriptor);
    expect(yahoo.getQuote).not.toHaveBeenCalled();
  });

  it('does not fall back to Yahoo for an explicit IBKR-only descriptor', async () => {
    const descriptor = {
      symbol: 'SPX',
      secType: 'IND',
      provider: 'ibkr',
      providerSymbol: 'SPX',
      conId: 416904,
      exchange: 'CBOE',
    };
    ibkr.getQuote.mockResolvedValue({ canonical: null, error: 'not_entitled' });
    yahoo.getQuote.mockResolvedValue({
      canonical: {
        symbol: 'SPX',
        source: 'yahoo',
        mark: 7500,
        timestamp: new Date().toISOString(),
        valid: true,
      },
      error: null,
    });

    expect(await composite.getQuote(descriptor)).toBeNull();
    expect(yahoo.getQuote).not.toHaveBeenCalled();
  });

  it('does not fall back to Yahoo history for an explicit IBKR-only descriptor', async () => {
    const descriptor = {
      symbol: 'SPX',
      secType: 'IND',
      provider: 'ibkr',
      providerSymbol: 'SPX',
      conId: 416904,
      exchange: 'CBOE',
    };
    ibkr.getHistoricalBars.mockResolvedValue({ bars: [], error: 'not_entitled' });
    yahoo.getHistoricalBars.mockResolvedValue({
      bars: [{ date: '2026-08-03', close: 7500 }],
      source: 'yahoo',
    });

    await expect(composite.getHistoricalBars(descriptor, '1y', '1d'))
      .resolves.toEqual({ bars: [], error: 'not_entitled' });
    expect(yahoo.getHistoricalBars).not.toHaveBeenCalled();
  });

  it('uses a valid IBKR quote first for an automatic cash-index descriptor', async () => {
    ibkr.getQuote.mockResolvedValue({
      canonical: {
        symbol: 'DJI',
        providerSymbol: 'INDU',
        source: 'ibkr',
        mark: 54001,
        last: 54001,
        close: 53885,
        timestamp: new Date().toISOString(),
        dataType: 'live',
        valid: true,
        warning: null,
      },
      error: null,
    });

    const legacy = await composite.getQuote(AUTO_DOW_DESCRIPTOR);

    expect(legacy).toMatchObject({ symbol: 'DJI', source: 'ibkr', price: '54001.00' });
    expect(ibkr.getQuote).toHaveBeenCalledWith(AUTO_DOW_DESCRIPTOR);
    expect(yahoo.getQuote).not.toHaveBeenCalled();
  });

  it.each([
    'not_connected',
    'not_entitled',
    'invalid_mark',
    'close_only_reference',
    'frozen_quote',
    'stale_quote',
  ])('falls back to the Yahoo identity when IBKR reports %s', async (ibkrError) => {
    ibkr.getQuote.mockResolvedValue({ canonical: null, error: ibkrError });
    yahoo.getQuote.mockResolvedValue({ canonical: yahooDowCanonical(), error: null });

    const legacy = await composite.getQuote(AUTO_DOW_DESCRIPTOR);

    expect(legacy).toMatchObject({ symbol: 'DJI', source: 'yahoo', price: '54000.00' });
    expect(legacy.warning).toContain(`ibkr: ${ibkrError}`);
    expect(legacy.warning).toContain('delayed_data');
    expect(yahoo.getQuote).toHaveBeenCalledWith(AUTO_DOW_DESCRIPTOR);
  });

  it('returns no quote when both providers fail an automatic cash-index request', async () => {
    ibkr.getQuote.mockResolvedValue({ canonical: null, error: 'not_connected' });
    yahoo.getQuote.mockResolvedValue({ canonical: null, error: 'invalid_yahoo' });

    await expect(composite.getQuote(AUTO_DOW_DESCRIPTOR)).resolves.toBeNull();
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
