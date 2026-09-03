const {
  buildRegistryFutureSpecs,
  createIbkrDatedFuturesFeed,
  instrumentForSpec,
  validateLiveQuote,
} = require('./ibkrDatedFuturesFeed.cjs');
const {
  CONTRACT_REGISTRY,
} = require('./registry.cjs');

const OBSERVED_AT = '2026-08-14T18:29:54.000Z';
const NOW = '2026-08-14T18:29:55.000Z';

function rawQuote(spec, overrides = {}) {
  return {
    symbol: spec.root,
    localSymbol: spec.localSymbol,
    conId: 100_000 + spec.localSymbol.charCodeAt(0),
    secType: 'FUT',
    exchange: spec.exchange,
    currency: 'USD',
    bid: 100,
    ask: 100.25,
    last: 100.125,
    bidSize: 5,
    askSize: 6,
    lastSize: 2,
    dataType: 'live',
    priceState: 'market_mark',
    entitlementStatus: 'live',
    timestamp: OBSERVED_AT,
    fetched_at: NOW,
    ...overrides,
  };
}

function createHarness({ registry = CONTRACT_REGISTRY, quoteTransform, responseOverrides } = {}) {
  let clock = new Date(NOW);
  let connected = true;
  const specs = buildRegistryFutureSpecs(registry);
  const request = jest.fn(async (path) => {
    if (path === '/status') {
      return connected
        ? { connected: true, status: 'connected' }
        : { connected: false, status: 'gateway_unavailable', message: 'Gateway disconnected.' };
    }
    if (path === '/quotes') {
      return {
        ok: true,
        quotes: specs.map((spec) => (
          quoteTransform ? quoteTransform(rawQuote(spec), spec) : rawQuote(spec)
        )),
        ...responseOverrides,
      };
    }
    throw new Error(`Unexpected sidecar path: ${path}`);
  });
  const feed = createIbkrDatedFuturesFeed({
    env: {},
    registry,
    sidecarRequestImpl: request,
    now: () => new Date(clock),
  });
  return {
    feed,
    request,
    specs,
    disconnect: () => { connected = false; },
    setClock: (value) => { clock = new Date(value); },
  };
}

describe('Resolver Test IBKR dated-futures feed', () => {
  test('derives exact IBKR futures requests from the registry and preserves qualification provenance', async () => {
    const harness = createHarness();

    await expect(harness.feed.refresh()).resolves.toBe(true);

    const quoteCall = harness.request.mock.calls.find(([path]) => path === '/quotes');
    expect(quoteCall[1]).toMatchObject({
      method: 'POST',
      body: {
        instruments: harness.specs.map(instrumentForSpec),
      },
    });
    expect(quoteCall[1].body.instruments).toEqual([
      expect.objectContaining({
        symbol: 'CL',
        secType: 'FUT',
        exchange: 'NYMEX',
        lastTradeDateOrContractMonth: '202609',
        tradingClass: 'CL',
      }),
      expect.objectContaining({
        symbol: 'GC',
        exchange: 'COMEX',
        lastTradeDateOrContractMonth: '202608',
      }),
      expect.objectContaining({
        symbol: 'ES',
        exchange: 'CME',
        lastTradeDateOrContractMonth: '202609',
      }),
      expect.objectContaining({
        symbol: 'NQ',
        exchange: 'CME',
        lastTradeDateOrContractMonth: '202609',
      }),
    ]);

    const snapshot = harness.feed.getSnapshot();
    expect(snapshot.provider).toMatchObject({
      provider: 'ibkr',
      configured: true,
      connected: true,
      status: 'live',
      requestedSymbolCount: 3,
      verifiedSymbolCount: 3,
      rejectedSymbolCount: 0,
      coverageStatus: 'complete',
      optionalSymbolCount: 1,
      verifiedOptionalSymbolCount: 1,
      rejectedOptionalSymbolCount: 0,
      optionalCoverageStatus: 'complete',
      dataType: 'live_only',
      cachePolicy: 'no_fallback',
    });
    expect(snapshot.symbols.GCQ6).toMatchObject({
      status: 'live',
      definition: {
        rawSymbol: 'GCQ6',
        contractMonth: '202608',
        validation: { valid: true, code: 'VERIFIED_IBKR_LIVE_DATED_FUTURE' },
        provenance: {
          provider: 'ibkr',
          requested: {
            symbol: 'GC',
            lastTradeDateOrContractMonth: '202608',
          },
          qualified: {
            symbol: 'GC',
            localSymbol: 'GCQ6',
            secType: 'FUT',
            exchange: 'COMEX',
          },
          maturity: {
            displaySymbol: 'GCQ26',
            localSymbol: 'GCQ6',
            year: 2026,
            month: 8,
            contractMonth: '202608',
          },
        },
      },
      quote: {
        bid: 100,
        ask: 100.25,
        bidSize: 5,
        askSize: 6,
        asOf: OBSERVED_AT,
        source: 'ibkr_live_market_data',
      },
      trade: {
        price: 100.125,
        size: 2,
        asOf: OBSERVED_AT,
        source: 'ibkr_live_market_data',
      },
      settlements: {},
      marketStatus: null,
    });
  });

  test('keeps aggregate health degraded on partial coverage while identifying live symbols individually', async () => {
    const harness = createHarness({
      quoteTransform: (quote, spec) => (spec.localSymbol === 'NQU6' ? null : quote),
    });

    await expect(harness.feed.refresh()).resolves.toBe(false);

    const health = harness.feed.getHealth();
    expect(health).toMatchObject({
      connected: true,
      status: 'degraded',
      coverageStatus: 'partial',
      requestedSymbolCount: 3,
      verifiedSymbolCount: 2,
      rejectedSymbolCount: 1,
      optionalSymbolCount: 1,
      verifiedOptionalSymbolCount: 1,
      symbols: {
        CLU6: { status: 'live' },
        GCQ6: { status: 'live' },
        ESU6: { status: 'live' },
        NQU6: { status: 'unavailable', error: { code: 'QUOTE_MISSING' } },
      },
    });
  });

  test('keeps required exact coverage live when the optional WTI proxy has no live mark', async () => {
    const harness = createHarness({
      quoteTransform: (quote, spec) => (spec.localSymbol === 'CLU6' ? {
        ...quote,
        bid: null,
        ask: null,
        last: null,
        timestamp: null,
        priceState: 'unavailable',
      } : quote),
    });

    await expect(harness.feed.refresh()).resolves.toBe(true);

    expect(harness.feed.getHealth()).toMatchObject({
      connected: true,
      status: 'live',
      coverageStatus: 'complete',
      requestedSymbolCount: 3,
      verifiedSymbolCount: 3,
      rejectedSymbolCount: 0,
      optionalSymbolCount: 1,
      verifiedOptionalSymbolCount: 0,
      rejectedOptionalSymbolCount: 1,
      optionalCoverageStatus: 'none',
      symbols: {
        CLU6: {
          role: 'proxy',
          exact: false,
          required: false,
          status: 'unavailable',
          error: { code: 'LIVE_MARKET_MARK_REQUIRED' },
        },
        GCQ6: { required: true, status: 'live' },
        ESU6: { required: true, status: 'live' },
        NQU6: { required: true, status: 'live' },
      },
    });
  });

  test.each([
    ['delayed', (quote) => ({ ...quote, dataType: 'delayed' }), 'LIVE_MARKET_DATA_REQUIRED'],
    ['frozen', (quote) => ({ ...quote, dataType: 'frozen' }), 'LIVE_MARKET_DATA_REQUIRED'],
    ['cache', (quote) => ({ ...quote, fromCache: true }), 'NON_LIVE_SOURCE_REJECTED'],
    ['unlabeled sidecar cache', (quote) => ({
      ...quote,
      fetched_at: '2026-08-14T18:29:53.000Z',
    }), 'SIDECAR_CACHE_REJECTED'],
    ['portfolio', (quote) => ({ ...quote, source: 'ibkr_portfolio_position' }), 'NON_LIVE_SOURCE_REJECTED'],
    ['mock', (quote) => ({ ...quote, mock: true }), 'NON_LIVE_SOURCE_REJECTED'],
    ['stale', (quote) => ({ ...quote, timestamp: '2026-08-14T18:20:00.000Z' }), 'QUOTE_STALE_OR_UNTIMESTAMPED'],
    ['close-only', (quote) => ({
      ...quote,
      bid: null,
      ask: null,
      last: null,
      close: 99,
      priceState: 'reference_close',
      timestamp: null,
    }), 'LIVE_MARKET_MARK_REQUIRED'],
  ])('rejects %s observations and exposes no price values', async (_label, transform, errorCode) => {
    const registry = CONTRACT_REGISTRY.filter((product) => product.id === 'wti');
    const harness = createHarness({ registry, quoteTransform: transform });

    await expect(harness.feed.refresh()).resolves.toBe(false);

    const snapshot = harness.feed.getSnapshot();
    expect(snapshot.provider).toMatchObject({ status: 'unavailable', verifiedSymbolCount: 0 });
    expect(snapshot.symbols.CLU6).toMatchObject({
      definition: null,
      quote: null,
      trade: null,
      error: { code: errorCode },
    });
  });

  test.each([
    ['wrong root', { symbol: 'BZ' }, 'ROOT_SYMBOL_MISMATCH'],
    ['wrong security type', { secType: 'STK' }, 'SECURITY_TYPE_MISMATCH'],
    ['wrong exchange', { exchange: 'ICE' }, 'EXCHANGE_MISMATCH'],
    ['missing contract id', { conId: null }, 'CONTRACT_ID_MISSING'],
  ])('rejects an otherwise-live quote with %s', (_label, overrides, code) => {
    const spec = buildRegistryFutureSpecs(CONTRACT_REGISTRY)[0];
    expect(validateLiveQuote(rawQuote(spec, overrides), spec, { nowDate: new Date(NOW) }))
      .toEqual({ valid: false, code });
  });

  test('rejects a wrong local symbol instead of matching quotes by array order', async () => {
    const registry = CONTRACT_REGISTRY.filter((product) => product.id === 'wti');
    const harness = createHarness({
      registry,
      quoteTransform: (quote) => ({ ...quote, localSymbol: 'CLV6' }),
    });

    await expect(harness.feed.refresh()).resolves.toBe(false);
    expect(harness.feed.getSnapshot().symbols.CLU6).toMatchObject({
      definition: null,
      quote: null,
      trade: null,
      error: { code: 'QUOTE_MISSING' },
    });
  });

  test('clears every prior quote immediately after the Gateway disconnects', async () => {
    const harness = createHarness();
    await expect(harness.feed.refresh()).resolves.toBe(true);
    expect(harness.feed.getSnapshot().symbols.ESU6.quote).not.toBeNull();

    harness.disconnect();
    await expect(harness.feed.refresh()).resolves.toBe(false);

    const snapshot = harness.feed.getSnapshot();
    expect(snapshot.provider).toMatchObject({ connected: false, status: 'unavailable' });
    Object.values(snapshot.symbols).forEach((state) => {
      expect(state.definition).toBeNull();
      expect(state.quote).toBeNull();
      expect(state.trade).toBeNull();
    });
  });

  test('expires stored values from getSnapshot when polling stops and provider timestamps age out', async () => {
    const registry = CONTRACT_REGISTRY.filter((product) => product.id === 'wti');
    const harness = createHarness({ registry });
    await harness.feed.refresh();
    expect(harness.feed.getSnapshot().symbols.CLU6.quote).not.toBeNull();

    harness.setClock('2026-08-14T18:30:20.000Z');
    const snapshot = harness.feed.getSnapshot();

    expect(snapshot.provider).toMatchObject({ status: 'unavailable', verifiedSymbolCount: 0 });
    expect(snapshot.symbols.CLU6).toMatchObject({
      definition: null,
      quote: null,
      trade: null,
      error: { code: 'QUOTE_STALE_OR_UNTIMESTAMPED' },
    });
  });

  test('recomputes live to degraded to unavailable as individual provider timestamps expire', async () => {
    const harness = createHarness({
      quoteTransform: (quote, spec) => ({
        ...quote,
        timestamp: spec.localSymbol === 'NQU6'
          ? '2026-08-14T18:29:45.500Z'
          : OBSERVED_AT,
      }),
    });
    await expect(harness.feed.refresh()).resolves.toBe(true);
    expect(harness.feed.getHealth()).toMatchObject({
      status: 'live',
      coverageStatus: 'complete',
      verifiedSymbolCount: 3,
    });

    harness.setClock('2026-08-14T18:29:56.000Z');
    const degraded = harness.feed.getHealth();
    expect(degraded).toMatchObject({
      status: 'degraded',
      coverageStatus: 'partial',
      verifiedSymbolCount: 2,
      rejectedSymbolCount: 1,
      symbols: {
        CLU6: { status: 'live' },
        GCQ6: { status: 'live' },
        ESU6: { status: 'live' },
        NQU6: { status: 'unavailable', error: { code: 'QUOTE_STALE_OR_UNTIMESTAMPED' } },
      },
    });

    harness.setClock('2026-08-14T18:30:05.000Z');
    const unavailable = harness.feed.getHealth();
    expect(unavailable).toMatchObject({
      status: 'unavailable',
      coverageStatus: 'none',
      verifiedSymbolCount: 0,
      rejectedSymbolCount: 3,
      rejectedOptionalSymbolCount: 1,
    });
    Object.values(unavailable.symbols).forEach((symbol) => {
      expect(symbol.status).toBe('unavailable');
      expect(symbol.lastQuoteAt).toBeNull();
      expect(symbol.lastTradeAt).toBeNull();
    });
  });

  test('uses an explicit disabled state and never contacts the sidecar when IBKR market data is disabled', async () => {
    const request = jest.fn();
    const feed = createIbkrDatedFuturesFeed({
      env: { IBKR_MARKET_DATA_ENABLED: 'false' },
      sidecarRequestImpl: request,
    });

    expect(feed.start()).toBe(false);
    await expect(feed.refresh()).resolves.toBe(false);
    expect(request).not.toHaveBeenCalled();
    expect(feed.getHealth()).toMatchObject({
      provider: 'ibkr',
      configured: false,
      connected: false,
      status: 'disabled',
    });
  });
});
