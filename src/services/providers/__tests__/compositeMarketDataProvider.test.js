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
const { getProviderStatusSnapshot, setIbkrConnected } = require('../providerStatus');
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
    composite.resetIbkrMisses();
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
      entitlementStatus: 'live',
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
      entitlementStatus: 'live',
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
      entitlementStatus: 'live',
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
      entitlementStatus: 'live',
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
      entitlementStatus: 'live',
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

describe('an instrument IBKR could not quote', () => {
  const START = Date.parse('2026-11-17T02:00:00Z');
  const flush = async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); };
  const yahooQuote = () => ({
    canonical: {
      symbol: 'XLK', source: 'yahoo', mark: 164, mid: null, last: 164, close: 163,
      timestamp: new Date().toISOString(), dataType: 'delayed', valid: true, warning: 'delayed_data',
    },
    error: null,
  });
  const ibkrQuote = () => ({
    canonical: normalizeIbkrRaw({
      symbol: 'XLK', bid: 164.6, ask: 164.7, last: 164.65, close: 163,
      timestamp: new Date().toISOString(), dataType: 'live', entitlementStatus: 'live',
    }),
    error: null,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers({ now: START, doNotFake: ['nextTick', 'setImmediate'] });
    composite.setSpecialQuoteFetcher(async () => null);
    composite.resetIbkrMisses();
    yahoo.getQuote.mockImplementation(async () => yahooQuote());
  });
  afterEach(() => { jest.useRealTimers(); });

  it('is answered from Yahoo at once on later requests while IBKR is retried in the background', async () => {
    ibkr.getQuote.mockResolvedValue({ canonical: null, error: 'no_quote' });

    // The first request waits for IBKR, as before.
    const first = await composite.getQuote('XLK');
    expect(first.source).toBe('yahoo');
    expect(first.warning).toMatch(/ibkr: no_quote/);
    expect(ibkr.getQuote).toHaveBeenCalledTimes(1);

    // Until the retry is due, IBKR is not asked at all.
    jest.setSystemTime(START + 29_000);
    const second = await composite.getQuote('XLK');
    expect(second.source).toBe('yahoo');
    expect(second.warning).toMatch(/ibkr: no_quote/);
    expect(ibkr.getQuote).toHaveBeenCalledTimes(1);

    // When it is due the request still does not wait: this retry never settles.
    let settleRetry;
    ibkr.getQuote.mockImplementation(() => new Promise((resolve) => { settleRetry = resolve; }));
    jest.setSystemTime(START + 31_000);
    const third = await composite.getQuote('XLK');
    await flush();
    expect(third.source).toBe('yahoo');
    expect(ibkr.getQuote).toHaveBeenCalledTimes(2);
    // One retry at a time.
    await composite.getQuote('XLK');
    await flush();
    expect(ibkr.getQuote).toHaveBeenCalledTimes(2);

    // The retry succeeds: the next request is served by IBKR again.
    settleRetry(ibkrQuote());
    await flush();
    ibkr.getQuote.mockImplementation(async () => ibkrQuote());
    const recovered = await composite.getQuote('XLK');
    expect(recovered.source).toBe('ibkr');
    expect(ibkr.getQuote).toHaveBeenCalledTimes(3);
  });

  it('is retried less often while it keeps failing, up to every two minutes', async () => {
    ibkr.getQuote.mockResolvedValue({ canonical: null, error: 'quote_timeout' });
    const attemptsAt = async (elapsedMs) => {
      jest.setSystemTime(START + elapsedMs);
      await composite.getQuote('XLK');
      await flush();
      return ibkr.getQuote.mock.calls.length;
    };
    expect(await attemptsAt(0)).toBe(1);          // first miss: next retry at 30 s
    expect(await attemptsAt(30_000)).toBe(2);     // second miss: next retry 60 s later
    expect(await attemptsAt(89_000)).toBe(2);
    expect(await attemptsAt(90_000)).toBe(3);     // third miss: every 120 s from here
    expect(await attemptsAt(209_000)).toBe(3);
    expect(await attemptsAt(210_000)).toBe(4);
    expect(await attemptsAt(329_000)).toBe(4);
    expect(await attemptsAt(330_000)).toBe(5);
  });

  it('reports how persistent the miss is', async () => {
    ibkr.getQuote.mockResolvedValue({ canonical: null, error: 'no_quote' });
    expect(composite.hasIbkrMiss('XLK')).toBe(false);
    await composite.getQuote('XLK');
    expect(composite.hasIbkrMiss('XLK')).toBe(true);
    expect(composite.hasIbkrMiss('XLK', 3)).toBe(false);
    for (const elapsed of [30_000, 90_000]) {
      jest.setSystemTime(START + elapsed);
      await composite.getQuote('XLK');
      await flush();
    }
    expect(composite.hasIbkrMiss('XLK', 3)).toBe(true);
    expect(composite.hasIbkrMiss('XLV', 1)).toBe(false);
  });

  it('is forgotten when the Gateway session changes', async () => {
    setIbkrConnected(true, null, 'sidecar-a:1');
    ibkr.getQuote.mockResolvedValue({ canonical: null, error: 'no_quote' });
    await composite.getQuote('XLK');
    await composite.getQuote('XLK');
    expect(ibkr.getQuote).toHaveBeenCalledTimes(1);

    setIbkrConnected(true, null, 'sidecar-a:2');
    await composite.getQuote('XLK');
    expect(ibkr.getQuote).toHaveBeenCalledTimes(2);
  });

  it('does not treat "not connected" as a miss', async () => {
    ibkr.getQuote.mockResolvedValue({ canonical: null, error: 'not_connected' });
    await composite.getQuote('XLK');
    await composite.getQuote('XLK');
    expect(ibkr.getQuote).toHaveBeenCalledTimes(2);
  });

  it('keeps asking IBKR for an instrument that has no Yahoo route', async () => {
    const descriptor = { symbol: 'SPX', secType: 'IND', exchange: 'CBOE', currency: 'USD', provider: 'ibkr' };
    ibkr.getQuote.mockResolvedValue({ canonical: null, error: 'no_quote' });
    expect(await composite.getQuote(descriptor)).toBeNull();
    expect(await composite.getQuote(descriptor)).toBeNull();
    expect(ibkr.getQuote).toHaveBeenCalledTimes(2);
    expect(yahoo.getQuote).not.toHaveBeenCalled();
  });

  it('remembers each instrument separately', async () => {
    ibkr.getQuote.mockImplementation(async (input) => (
      input === 'XLK' ? { canonical: null, error: 'no_quote' } : ibkrQuote()
    ));
    await composite.getQuote('XLK');
    expect((await composite.getQuote('XLV')).source).toBe('ibkr');
    expect((await composite.getQuote('XLV')).source).toBe('ibkr');
    expect(ibkr.getQuote.mock.calls.map(([input]) => input)).toEqual(['XLK', 'XLV', 'XLV']);
  });
});
