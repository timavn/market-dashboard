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
});
