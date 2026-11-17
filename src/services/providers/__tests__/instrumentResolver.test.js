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

  it('resolves an automatic cash-index descriptor to IBKR while retaining its Yahoo identity', () => {
    const descriptor = {
      symbol: 'DJI',
      ibkrSymbol: 'INDU',
      yahooSymbol: '^DJI',
      conId: 1935181,
      secType: 'IND',
      exchange: 'CME',
      currency: 'USD',
      provider: 'auto',
    };

    expect(resolveInstrument(descriptor)).toMatchObject({
      symbol: 'INDU',
      displaySymbol: 'DJI',
      ibkrSymbol: 'INDU',
      yahooSymbol: '^DJI',
      conid: 1935181,
      secType: 'IND',
      exchange: 'CME',
      provider: 'auto',
      supported: true,
    });
    expect(canUseSymbolStream(descriptor)).toBe(false);
  });

  it('sends a bare symbol in Yahoo notation straight to Yahoo', () => {
    for (const symbol of ['^GSPC', '^VIX', 'CL=F', 'GC=F', 'EURUSD=X', 'BTC-USD', 'ETH-USD', 'DX-Y.NYB', 'cl=f']) {
      expect(resolveInstrument(symbol)).toMatchObject({
        symbol: symbol.toUpperCase(),
        provider: 'yahoo',
        yahooSymbol: symbol.toUpperCase(),
        supported: false,
        reason: 'yahoo_only',
      });
      expect(canUseSymbolStream(symbol)).toBe(false);
    }
    expect(instrumentCacheKey('^GSPC')).not.toBe(instrumentCacheKey('GSPC'));
  });

  it('keeps ordinary tickers, class shares and plain names on the IBKR-first route', () => {
    for (const symbol of ['AAPL', 'BRK.B', 'BRK B', 'BF-B', 'RDS-A', 'XLK', 'USD', 'SILVER', 'IXIC']) {
      expect(resolveInstrument(symbol)).toMatchObject({ symbol, secType: 'STK', provider: 'auto', supported: true });
    }
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

  it('allows only contract-specific IBKR futures descriptors', () => {
    const exactFuture = {
      symbol: 'WTI',
      secType: 'FUT',
      exchange: 'IPE',
      currency: 'USD',
      provider: 'ibkr',
      lastTradeDateOrContractMonth: '202609',
      tradingClass: 'WTI',
    };

    expect(resolveInstrument(exactFuture)).toMatchObject({
      ...exactFuture,
      supported: true,
    });
    expect(resolveInstrument({
      symbol: 'WTI',
      secType: 'FUT',
      exchange: 'IPE',
      provider: 'ibkr',
    })).toMatchObject({
      supported: false,
      reason: 'futures_contract_identity_required',
    });
    expect(canUseSymbolStream(exactFuture)).toBe(false);
  });

  it('routes the exact IBKR spot-gold commodity identity off the stock stream', () => {
    const spotGold = {
      symbol: 'XAUUSD',
      conId: 69067924,
      secType: 'CMDTY',
      exchange: 'SMART',
      currency: 'USD',
      provider: 'ibkr',
    };

    expect(resolveInstrument(spotGold)).toMatchObject({
      symbol: 'XAUUSD',
      conid: 69067924,
      secType: 'CMDTY',
      exchange: 'SMART',
      currency: 'USD',
      provider: 'ibkr',
      supported: true,
    });
    expect(canUseSymbolStream(spotGold)).toBe(false);
  });
});
