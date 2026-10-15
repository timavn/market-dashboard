const {
  CONTRACT_BY_ID,
  CONTRACT_REGISTRY,
  isContinuousSymbol,
  validateContractRegistry,
} = require('./registry.cjs');

describe('Resolver Test contract registry', () => {
  test('pins the literal dated resolver instruments and the one explicit proxy', () => {
    expect(CONTRACT_BY_ID.wti).toMatchObject({
      resolver: { contractSymbol: 'WBS 26U-ICE', mic: 'IFEU' },
      feed: {
        provider: 'ibkr', symbol: 'CLU6', role: 'proxy', exact: false,
        instrument: { ibkrSymbol: 'CL', lastTradeDateOrContractMonth: '202609', exchange: 'NYMEX' },
      },
    });
    expect(CONTRACT_BY_ID.gold.feed).toMatchObject({
      provider: 'ibkr', symbol: 'GCQ6', displaySymbol: 'GCQ26', exact: true,
      instrument: { ibkrSymbol: 'GC', lastTradeDateOrContractMonth: '202608', exchange: 'COMEX' },
    });
    expect(CONTRACT_BY_ID.sp500.feed).toMatchObject({
      provider: 'ibkr', symbol: 'ESU6', displaySymbol: 'ESU26', exact: true,
      instrument: { ibkrSymbol: 'ES', lastTradeDateOrContractMonth: '202609', exchange: 'CME' },
    });
    expect(CONTRACT_BY_ID.nasdaq100.feed).toMatchObject({
      provider: 'ibkr', symbol: 'NQU6', displaySymbol: 'NQU26', exact: true,
      instrument: { ibkrSymbol: 'NQ', lastTradeDateOrContractMonth: '202609', exchange: 'CME' },
    });
    expect(CONTRACT_BY_ID.bitcoin).toMatchObject({
      contractShape: 'range',
      comparator: 'inclusive_range',
      proxyFeed: { provider: 'coinbase_exchange', symbol: 'BTC-USD', role: 'proxy', exact: false },
      hedgeye: { sourceType: 'bitcoin-trend-tracker', ticker: 'BTC' },
    });
    expect(CONTRACT_BY_ID.bitcoin.feed).toBeUndefined();
    expect(CONTRACT_BY_ID.ethereum).toMatchObject({
      resolver: { contractSymbol: 'ETHUSD_RTI · 300s trimmed average' },
      proxyFeed: { symbol: 'ETH-USD', exact: false },
      hedgeye: { ticker: 'ETH' },
    });
    expect(CONTRACT_BY_ID.ethereum.feed).toBeUndefined();
    expect(CONTRACT_BY_ID.cpi).toMatchObject({
      comparator: '>',
      precision: 1,
      bls: { seriesId: 'CUUR0000SA0', reportMonth: '2026-08' },
    });
    expect(validateContractRegistry(CONTRACT_REGISTRY)).toBe(true);
    expect(CONTRACT_REGISTRY).toHaveLength(7);
  });

  test.each(['GC=F', 'ES=F', 'NQ=F', 'CL=F', 'ES1!', 'NQ_CONT', 'continuous'])('rejects continuous symbol %s', (symbol) => {
    expect(isContinuousSymbol(symbol)).toBe(true);
    const registry = CONTRACT_REGISTRY.map((product) => (
      product.id === 'gold' ? { ...product, feed: { ...product.feed, symbol } } : product
    ));
    expect(() => validateContractRegistry(registry)).toThrow(/continuous or missing feed symbol/i);
  });

  test('rejects an IBKR future without an exact contract month identity', () => {
    const registry = CONTRACT_REGISTRY.map((product) => (
      product.id === 'sp500'
        ? {
          ...product,
          feed: {
            ...product.feed,
            instrument: { ...product.feed.instrument, lastTradeDateOrContractMonth: '' },
          },
        }
        : product
    ));
    expect(() => validateContractRegistry(registry)).toThrow(/exact IBKR futures identity/i);
  });
});
