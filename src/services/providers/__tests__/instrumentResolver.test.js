const {
  resolveInstrument,
  instrumentCacheKey,
  canUseSymbolStream,
} = require('../instruments/instrumentResolver');

describe('instrumentResolver provider identity', () => {
  it('qualifies bare SPX as the exact IBKR cash index and keeps it off the stock stream', () => {
    expect(resolveInstrument('SPX')).toMatchObject({
      symbol: 'SPX',
      secType: 'IND',
      exchange: 'CBOE',
      currency: 'USD',
      provider: 'auto',
      supported: true,
    });
    expect(canUseSymbolStream('SPX')).toBe(false);
  });

  it('allows an explicit IBKR index descriptor without enabling a Yahoo fallback identity', () => {
    expect(resolveInstrument({
      symbol: 'SPX',
      secType: 'IND',
      exchange: 'CBOE',
      currency: 'USD',
      provider: 'ibkr',
    })).toMatchObject({
      symbol: 'SPX',
      secType: 'IND',
      exchange: 'CBOE',
      provider: 'ibkr',
      supported: true,
    });
  });

  it('keeps a Yahoo cash index out of the IBKR stock route', () => {
    const descriptor = {
      symbol: 'SPX',
      secType: 'IND',
      provider: 'yahoo',
      providerSymbol: '^GSPC',
    };

    expect(resolveInstrument(descriptor)).toMatchObject({
      symbol: 'SPX',
      secType: 'IND',
      provider: 'yahoo',
      providerSymbol: '^GSPC',
      supported: false,
      reason: 'yahoo_only',
    });
    expect(canUseSymbolStream(descriptor)).toBe(false);
  });

  it.each([
    ['BZ', 'FUT', 'BZ=F'],
    ['BTC', 'CRYPTO', 'BTC-USD'],
    ['USDCAD', 'CASH', 'USDCAD=X'],
  ])('prevents %s %s descriptors from consuming the symbol-keyed stock stream', (symbol, secType, providerSymbol) => {
    const descriptor = { symbol, secType, provider: 'yahoo', providerSymbol };
    expect(resolveInstrument(descriptor).supported).toBe(false);
    expect(canUseSymbolStream(descriptor)).toBe(false);
  });

  it('uses descriptor and provider identity in quote cache keys', () => {
    const stockKey = instrumentCacheKey({ symbol: 'BZ', secType: 'STK', provider: 'ibkr' });
    const futureKey = instrumentCacheKey({
      symbol: 'BZ',
      secType: 'FUT',
      provider: 'yahoo',
      providerSymbol: 'BZ=F',
    });
    const alternateFutureKey = instrumentCacheKey({
      symbol: 'BZ',
      secType: 'FUT',
      provider: 'yahoo',
      providerSymbol: 'BZQ=F',
    });

    expect(new Set([stockKey, futureKey, alternateFutureKey]).size).toBe(3);
  });

  it('allows only the default SMART USD equity identity onto the symbol stream', () => {
    expect(canUseSymbolStream('AAPL')).toBe(true);
    expect(canUseSymbolStream({ symbol: 'AAPL', secType: 'STK', exchange: 'ARCA' })).toBe(false);
    expect(canUseSymbolStream({ symbol: 'AAPL', secType: 'STK', currency: 'CAD' })).toBe(false);
    expect(canUseSymbolStream({ symbol: 'AAPL', secType: 'STK', conId: 123 })).toBe(false);
  });
});
