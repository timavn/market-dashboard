jest.mock('../ibkrSidecarClient', () => ({
  sidecarRequest: jest.fn(),
  getSidecarProviderStatus: jest.fn(),
}));

jest.mock('../../ibkr/ibkrStreamBridge', () => ({
  getCachedCanonical: jest.fn(),
  STREAM_ENABLED: false,
}));

const {
  sidecarRequest,
  getSidecarProviderStatus,
} = require('../ibkrSidecarClient');
const { setIbkrConnected } = require('../providerStatus');
const ibkr = require('../ibkr/ibkrMarketDataProvider');

function rawQuote(symbol, last, exchange = 'SMART') {
  return {
    symbol,
    bid: last - 0.01,
    ask: last + 0.01,
    last,
    close: last - 1,
    exchange,
    currency: 'USD',
    dataType: 'live',
    timestamp: new Date().toISOString(),
  };
}

describe('ibkrMarketDataProvider cache integrity', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setIbkrConnected(false);
  });

  it('does not return an internal cached quote after a known disconnect', async () => {
    getSidecarProviderStatus.mockResolvedValueOnce({ connected: true });
    sidecarRequest.mockResolvedValueOnce({ ok: true, quotes: [rawQuote('CACHE1', 100)] });

    const first = await ibkr.getQuote('CACHE1');
    expect(first.canonical?.source).toBe('ibkr');

    setIbkrConnected(false, 'gateway_offline');
    getSidecarProviderStatus.mockResolvedValueOnce({ connected: false, message: 'gateway_offline' });

    const second = await ibkr.getQuote('CACHE1');
    expect(second).toMatchObject({ canonical: null, error: 'not_connected' });
    expect(sidecarRequest).toHaveBeenCalledTimes(1);
  });

  it('requests bare SPX as the exact CBOE cash-index contract', async () => {
    getSidecarProviderStatus.mockResolvedValueOnce({ connected: true });
    sidecarRequest.mockResolvedValueOnce({ ok: true, quotes: [rawQuote('SPX', 7406, 'CBOE')] });

    const result = await ibkr.getQuote('SPX');

    expect(result.canonical).toMatchObject({ symbol: 'SPX', source: 'ibkr', last: 7406 });
    expect(sidecarRequest).toHaveBeenCalledWith('/quotes', expect.objectContaining({
      method: 'POST',
      timeoutMs: 10000,
      body: {
        instruments: [expect.objectContaining({
          symbol: 'SPX',
          secType: 'IND',
          exchange: 'CBOE',
          currency: 'USD',
        })],
      },
    }));
  });

  it('requests the IBKR identity while preserving the display symbol', async () => {
    getSidecarProviderStatus.mockResolvedValueOnce({ connected: true });
    sidecarRequest.mockResolvedValueOnce({
      ok: true,
      quotes: [rawQuote('INDU', 54000, 'CME')],
    });

    const result = await ibkr.getQuote({
      symbol: 'DJI',
      ibkrSymbol: 'INDU',
      yahooSymbol: '^DJI',
      conId: 1935181,
      secType: 'IND',
      exchange: 'CME',
      currency: 'USD',
      provider: 'auto',
    });

    expect(result.canonical).toMatchObject({
      symbol: 'DJI',
      providerSymbol: 'INDU',
      source: 'ibkr',
      valid: true,
    });
    expect(sidecarRequest).toHaveBeenCalledWith('/quotes', expect.objectContaining({
      body: {
        instruments: [expect.objectContaining({
          symbol: 'INDU',
          conId: 1935181,
          secType: 'IND',
          exchange: 'CME',
        })],
      },
    }));
  });

  it('returns a diagnostic failure for a close-only IBKR reference', async () => {
    getSidecarProviderStatus.mockResolvedValueOnce({ connected: true });
    sidecarRequest.mockResolvedValueOnce({
      ok: true,
      quotes: [{
        symbol: 'RUT',
        bid: null,
        ask: null,
        last: null,
        close: 3001.55,
        exchange: 'RUSSELL',
        currency: 'USD',
        dataType: 'live',
        timestamp: new Date().toISOString(),
      }],
    });

    const result = await ibkr.getQuote({
      symbol: 'RUT-CLOSE-ONLY',
      ibkrSymbol: 'RUT',
      yahooSymbol: '^RUT',
      conId: 416888,
      secType: 'IND',
      exchange: 'RUSSELL',
      provider: 'auto',
    });

    expect(result.canonical.valid).toBe(false);
    expect(result.error).toMatch(/close_only_reference/);
  });

  it('does not share cache entries across descriptor identities', async () => {
    getSidecarProviderStatus.mockResolvedValue({ connected: true });
    sidecarRequest
      .mockResolvedValueOnce({ ok: true, quotes: [rawQuote('DUAL1', 100, 'SMART')] })
      .mockResolvedValueOnce({ ok: true, quotes: [rawQuote('DUAL1', 200, 'ARCA')] });

    const smart = await ibkr.getQuote({
      symbol: 'DUAL1',
      secType: 'STK',
      provider: 'ibkr',
      exchange: 'SMART',
      currency: 'USD',
    });
    const arca = await ibkr.getQuote({
      symbol: 'DUAL1',
      secType: 'STK',
      provider: 'ibkr',
      exchange: 'ARCA',
      currency: 'USD',
    });

    expect(smart.canonical.mark).toBe(100);
    expect(arca.canonical.mark).toBe(200);
    expect(sidecarRequest).toHaveBeenCalledTimes(2);
  });

  it('rejects a futures descriptor before calling the IBKR sidecar', async () => {
    const result = await ibkr.getQuote({
      symbol: 'BZ',
      secType: 'FUT',
      provider: 'yahoo',
      providerSymbol: 'BZ=F',
    });

    expect(result.canonical).toBeNull();
    expect(result.error).toMatch(/yahoo_only/);
    expect(getSidecarProviderStatus).not.toHaveBeenCalled();
    expect(sidecarRequest).not.toHaveBeenCalled();
  });

  it('requests an exact dated WTI futures contract from IBKR', async () => {
    getSidecarProviderStatus.mockResolvedValueOnce({ connected: true });
    sidecarRequest.mockResolvedValueOnce({ ok: true, quotes: [rawQuote('WTI', 84.08, 'IPE')] });

    const result = await ibkr.getQuote({
      symbol: 'WTI',
      secType: 'FUT',
      exchange: 'IPE',
      currency: 'USD',
      provider: 'ibkr',
      lastTradeDateOrContractMonth: '202609',
      tradingClass: 'WTI',
    });

    expect(result.canonical).toMatchObject({ symbol: 'WTI', source: 'ibkr', last: 84.08 });
    expect(sidecarRequest).toHaveBeenCalledWith('/quotes', expect.objectContaining({
      method: 'POST',
      body: {
        instruments: [expect.objectContaining({
          symbol: 'WTI',
          secType: 'FUT',
          exchange: 'IPE',
          currency: 'USD',
          lastTradeDateOrContractMonth: '202609',
          tradingClass: 'WTI',
        })],
      },
    }));
  });

  it('loads only explicitly sourced IBKR historical bars', async () => {
    sidecarRequest.mockResolvedValueOnce({
      ok: true,
      source: 'ibkr',
      bars: [{ date: '2026-08-20 09:30:00', high: 7701, close: 7700 }],
      fetched_at: '2026-08-20T13:35:00.000Z',
    });

    await expect(ibkr.getHistoricalBars('SPX', '1d', '5m')).resolves.toMatchObject({
      source: 'ibkr',
      asOf: '2026-08-20T13:35:00.000Z',
      bars: [expect.objectContaining({ high: 7701, close: 7700 })],
    });
  });

  it('serializes the exact XAUUSD commodity contract id for historical bars', async () => {
    sidecarRequest.mockResolvedValueOnce({
      ok: true,
      source: 'ibkr',
      contract: { conId: 69067924, symbol: 'XAUUSD', secType: 'CMDTY' },
      bars: [{ date: '2026-08-31 10:45:00-04:00', close: 4432.78 }],
      fetched_at: '2026-08-31T14:45:00.000Z',
      use_rth: false,
    });

    await expect(ibkr.getHistoricalBars({
      symbol: 'XAUUSD',
      displaySymbol: 'XAUUSD',
      conId: 69067924,
      secType: 'CMDTY',
      exchange: 'SMART',
      currency: 'USD',
      tradingClass: 'XAUUSD',
      provider: 'ibkr',
    }, '1d', '5m', { useRth: false })).resolves.toMatchObject({
      source: 'ibkr',
      contract: expect.objectContaining({ conId: 69067924 }),
      bars: [expect.objectContaining({ close: 4432.78 })],
    });
    expect(sidecarRequest).toHaveBeenCalledWith('/historical', expect.objectContaining({
      body: expect.objectContaining({
        instrument: expect.objectContaining({
          symbol: 'XAUUSD',
          conId: 69067924,
          secType: 'CMDTY',
        }),
        useRth: false,
      }),
    }));
  });

  test.each([
    ['non-IBKR', { source: 'yahoo' }],
    ['mock', { source: 'ibkr', mock: true }],
    ['cached', { source: 'ibkr', fromCache: true }],
    ['seeded', { source: 'ibkr', seeded: true }],
    ['fallback', { source: 'ibkr', fallback: true }],
  ])('fails closed for %s historical-bar provenance', async (_label, metadata) => {
    sidecarRequest.mockResolvedValueOnce({
      ok: true,
      bars: [{ date: '2026-08-20 09:30:00', high: 7701, close: 7700 }],
      ...metadata,
    });

    await expect(ibkr.getHistoricalBars('SPX', '1d', '5m')).resolves.toMatchObject({
      source: null,
      bars: [],
      error: 'invalid_ibkr_historical_response',
    });
  });

  it('loads a complete exact-cutoff IBKR historical high record', async () => {
    sidecarRequest.mockResolvedValueOnce({
      ok: true,
      status: 'available',
      source: 'ibkr',
      through_date: '2026-08-10',
      record: { high: 7820.5, date: '2026-08-10' },
      coverage: {
        complete: true,
        start_date: '1957-03-04',
        end_date: '2026-08-10',
        head_date: '1957-03-04',
        chunks: 7,
        observations: 17480,
      },
      fetched_at: '2026-08-17T15:00:00.000Z',
    });

    const result = await ibkr.getHistoricalRecord('SPX', '2026-08-10');

    expect(result).toMatchObject({
      status: 'available',
      source: 'ibkr',
      throughDate: '2026-08-10',
      recordHigh: 7820.5,
      recordDate: '2026-08-10',
      coverage: { complete: true, startDate: '1957-03-04', endDate: '2026-08-10' },
    });
    expect(sidecarRequest).toHaveBeenCalledWith('/historical-record', expect.objectContaining({
      method: 'POST',
      timeoutMs: 120000,
      body: {
        instrument: expect.objectContaining({ symbol: 'SPX', secType: 'IND', exchange: 'CBOE' }),
        throughDate: '2026-08-10',
      },
    }));
  });

  it('serializes the exact XAUUSD commodity contract id for its historical record', async () => {
    sidecarRequest.mockResolvedValueOnce({
      ok: true,
      status: 'available',
      source: 'ibkr',
      through_date: '2026-08-31',
      record: { high: 5608.35, date: '2026-01-29' },
      coverage: {
        complete: true,
        start_date: '2010-06-09',
        end_date: '2026-08-31',
        head_date: '2010-06-09',
        chunks: 3,
        observations: 4191,
      },
      fetched_at: '2026-09-01T16:02:36.579Z',
    });

    await expect(ibkr.getHistoricalRecord({
      symbol: 'XAUUSD',
      displaySymbol: 'XAUUSD',
      conId: 69067924,
      secType: 'CMDTY',
      exchange: 'SMART',
      currency: 'USD',
      tradingClass: 'XAUUSD',
      provider: 'ibkr',
    }, '2026-08-31')).resolves.toMatchObject({
      status: 'available',
      source: 'ibkr',
      recordHigh: 5608.35,
      recordDate: '2026-01-29',
      coverage: { complete: true, startDate: '2010-06-09', endDate: '2026-08-31' },
    });
    expect(sidecarRequest).toHaveBeenCalledWith('/historical-record', expect.objectContaining({
      body: expect.objectContaining({
        instrument: expect.objectContaining({
          symbol: 'XAUUSD',
          conId: 69067924,
          secType: 'CMDTY',
        }),
        throughDate: '2026-08-31',
      }),
    }));
  });

  it('fails closed when the IBKR record coverage is incomplete', async () => {
    sidecarRequest.mockResolvedValueOnce({
      ok: true,
      status: 'available',
      source: 'ibkr',
      record: { high: 7820.5, date: '2026-08-10' },
      coverage: { complete: false, start_date: '2025-01-01', end_date: '2026-08-10' },
    });

    await expect(ibkr.getHistoricalRecord('SPX', '2026-08-10')).resolves.toMatchObject({
      status: 'unavailable',
      source: null,
      recordHigh: null,
    });
  });

  it('fails closed when the IBKR record response carries forbidden provenance', async () => {
    sidecarRequest.mockResolvedValueOnce({
      ok: true,
      status: 'available',
      source: 'ibkr',
      cachedOnly: true,
      through_date: '2026-08-10',
      record: { high: 7820.5, date: '2026-08-10' },
      coverage: {
        complete: true,
        start_date: '1957-03-04',
        end_date: '2026-08-10',
        head_date: '1957-03-04',
        chunks: 7,
        observations: 17480,
      },
    });

    await expect(ibkr.getHistoricalRecord('SPX', '2026-08-10')).resolves.toMatchObject({
      status: 'unavailable',
      source: null,
      recordHigh: null,
    });
  });
});
