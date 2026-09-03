const {
  brokerContractIdentity,
  createForecastExMonitorProvider,
  exactQualificationRequests,
  isCurrentMonitorContext,
  normalizeLiveSnapshot,
  selectDiscoveryStrikes,
} = require('./forecastExMonitorProvider.cjs');

const NOW = Date.parse('2026-08-19T16:00:00.000Z');
const AS_OF = '2026-08-19T16:00:00.000Z';
const CLOSE = '2026-08-19T20:00:00.000Z';
const CONTEXT = {
  marketId: 'nasdaq100',
  productCode: 'FNQ',
  generationKey: 'FNQ_081926',
  closeTime: CLOSE,
  contracts: [{ contractId: 'FNQ_081926_100', strike: 100, openInterest: 500 }],
};
const FES_CONTEXT = {
  marketId: 'sp500',
  productCode: 'FES',
  generationKey: 'FES_081926',
  closeTime: CLOSE,
  contracts: [{ contractId: 'FES_081926_100', strike: 100, openInterest: 500 }],
};

function quoteEvent(side, overrides = {}) {
  return {
    api_raw_symbol: `FNQ_081926_100_${side}`,
    quote_side: side,
    releaseKey: 'FNQ_081926',
    productCode: 'FNQ',
    underlying: 'FNQ',
    secType: 'OPT',
    exchange: 'FORECASTX',
    tradingClass: 'FNQ',
    exchange_timestamp: AS_OF,
    dataType: 1,
    data_quality_flags: [],
    native_bid: side === 'YES' ? 0.40 : 0.58,
    native_ask: side === 'YES' ? 0.42 : 0.60,
    native_bid_size: 20,
    native_ask_size: 25,
    ...overrides,
  };
}

function refreshResult(events = [quoteEvent('YES'), quoteEvent('NO')], overrides = {}) {
  return {
    fetched_at: AS_OF,
    providers: { ibkr: { status: 'connected' } },
    events,
    ...overrides,
  };
}

function qualifiedCatalog() {
  return ['C', 'P'].map((right, index) => ({
    releaseKey: 'FNQ_081926',
    publicContractId: 'FNQ_081926_100',
    contractId: 'FNQ_081926_100',
    productCode: 'FNQ',
    exchange: 'FORECASTX',
    symbol: 'FNQ',
    underlying: 'FNQ',
    secType: 'OPT',
    tradingClass: 'FNQ',
    right,
    strike: 100,
    conId: 123 + index,
  }));
}

describe('ForecastEx live monitor provider', () => {
  test('maps public FES identity to the exact ES ForecastEx futures-option identity', () => {
    expect(brokerContractIdentity(FES_CONTEXT)).toEqual({
      productCode: 'FES',
      symbol: 'ES',
      secType: 'FOP',
      exchange: 'FORECASTX',
      currency: 'USD',
      tradingClass: 'FES',
    });
    expect(exactQualificationRequests(FES_CONTEXT)).toEqual([
      expect.objectContaining({
        productCode: 'FES',
        symbol: 'ES',
        underlying: 'ES',
        secType: 'FOP',
        exchange: 'FORECASTX',
        tradingClass: 'FES',
        right: 'C',
        quote_side: 'YES',
      }),
      expect.objectContaining({
        productCode: 'FES',
        symbol: 'ES',
        underlying: 'ES',
        secType: 'FOP',
        exchange: 'FORECASTX',
        tradingClass: 'FES',
        right: 'P',
        quote_side: 'NO',
      }),
    ]);
  });

  test('accepts exact ES/FOP FES events and rejects the former FES/OPT broker shape', () => {
    const fesEvent = (side, overrides = {}) => quoteEvent(side, {
      api_raw_symbol: `FES_081926_100_${side}`,
      releaseKey: 'FES_081926',
      productCode: 'FES',
      underlying: 'ES',
      secType: 'FOP',
      tradingClass: 'FES',
      ...overrides,
    });
    expect(normalizeLiveSnapshot(
      refreshResult([fesEvent('YES'), fesEvent('NO')]),
      FES_CONTEXT,
      NOW,
    )).toMatchObject({ status: 'available', lines: [{ contractId: 'FES_081926_100' }] });
    expect(normalizeLiveSnapshot(
      refreshResult([
        fesEvent('YES', { underlying: 'FES', secType: 'OPT' }),
        fesEvent('NO', { underlying: 'FES', secType: 'OPT' }),
      ]),
      FES_CONTEXT,
      NOW,
    )).toMatchObject({ status: 'unavailable', lines: [] });
  });

  test('accepts the IBKR-listed Silver ForecastEx product mapping', () => {
    expect(isCurrentMonitorContext({
      marketId: 'silver',
      productCode: 'METLS',
      generationKey: 'METLS_081926',
      closeTime: '2026-08-19T20:00:00.000Z',
    }, NOW)).toBe(true);
  });

  test('accepts only a current event/product/market identity', () => {
    expect(isCurrentMonitorContext(CONTEXT, NOW)).toBe(true);
    expect(isCurrentMonitorContext({ ...CONTEXT, generationKey: 'FES_081926' }, NOW)).toBe(false);
    expect(isCurrentMonitorContext({ ...CONTEXT, productCode: 'FES', generationKey: 'FES_081926' }, NOW)).toBe(false);
    expect(isCurrentMonitorContext({ ...CONTEXT, generationKey: 'FNQ_081826' }, NOW)).toBe(false);
    expect(isCurrentMonitorContext({ ...CONTEXT, closeTime: '2026-08-19T15:59:59.000Z' }, NOW)).toBe(false);
    expect(isCurrentMonitorContext({ ...CONTEXT, marketId: '' }, NOW)).toBe(false);
  });

  test('keeps discovery bounded while preserving a deterministic strike set', () => {
    const contracts = Array.from({ length: 40 }, (_, index) => ({
      strike: index,
      openInterest: index === 39 ? 10_000 : index,
    }));
    const selected = selectDiscoveryStrikes(contracts, 5);
    expect(selected).toHaveLength(5);
    expect(selected).toContain(39);
    expect(selected).toEqual([...selected].sort((left, right) => left - right));
  });

  test('normalizes fresh native live YES and NO books for the exact current generation', () => {
    expect(normalizeLiveSnapshot(refreshResult(), CONTEXT, NOW)).toEqual({
      status: 'available',
      fetchedAt: AS_OF,
      errorCode: null,
      reason: null,
      lines: [{
        contractId: 'FNQ_081926_100',
        yesBid: 0.40,
        yesAsk: 0.42,
        yesBidSize: 20,
        yesAskSize: 25,
        noBid: 0.58,
        noAsk: 0.60,
        noBidSize: 20,
        noAskSize: 25,
        updatedAt: AS_OF,
        dataType: 'live',
        directNative: true,
        provenance: 'ibkr_tws_native_forecastex',
      }],
    });
  });

  test.each([
    ['disconnected provider', refreshResult([], { providers: { ibkr: { status: 'disconnected' } } })],
    ['delayed market data', refreshResult([quoteEvent('YES', { dataType: 3 }), quoteEvent('NO', { dataType: 3 })])],
    ['stale quote', refreshResult([
      quoteEvent('YES', { exchange_timestamp: '2026-08-19T15:58:00.000Z' }),
      quoteEvent('NO', { exchange_timestamp: '2026-08-19T15:58:00.000Z' }),
    ])],
    ['cached flag', refreshResult([
      quoteEvent('YES', { data_quality_flags: ['cached_only'] }),
      quoteEvent('NO', { data_quality_flags: ['cached_only'] }),
    ])],
    ['derived flag', refreshResult([
      quoteEvent('YES', { data_quality_flags: ['derived'] }),
      quoteEvent('NO', { data_quality_flags: ['derived'] }),
    ])],
    ['wrong generation', refreshResult([
      quoteEvent('YES', { releaseKey: 'FNQ_081826' }),
      quoteEvent('NO', { releaseKey: 'FNQ_081826' }),
    ])],
    ['wrong exchange', refreshResult([
      quoteEvent('YES', { exchange: 'CME' }),
      quoteEvent('NO', { exchange: 'CME' }),
    ])],
  ])('fails closed for %s', (_label, result) => {
    expect(normalizeLiveSnapshot(result, CONTEXT, NOW)).toMatchObject({
      status: 'unavailable',
      lines: [],
    });
  });

  test('rejects prior-generation catalogs and never asks IBKR to quote them', async () => {
    const request = jest.fn(async (path) => {
      if (path === '/discover') {
        return {
          catalog_contracts: [{
            releaseKey: 'FNQ_081826',
            exchange: 'FORECASTX',
            localSymbol: 'FNQ_081826_100_YES',
            conId: 123,
          }],
        };
      }
      throw new Error('Refresh must not run');
    });
    const provider = createForecastExMonitorProvider({ request, now: () => NOW });

    await expect(provider.getSnapshot(CONTEXT)).resolves.toMatchObject({
      status: 'unavailable',
      lines: [],
      refreshing: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith('/discover', expect.objectContaining({
      body: expect.objectContaining({
        monitor: expect.objectContaining({
          marketId: 'nasdaq100',
          productCode: 'FNQ',
          generationKey: 'FNQ_081926',
        }),
        catalogContracts: expect.arrayContaining([
          expect.objectContaining({ exchange: 'FORECASTX', secType: 'OPT', right: 'C' }),
          expect.objectContaining({ exchange: 'FORECASTX', secType: 'OPT', right: 'P' }),
        ]),
      }),
    }));
  });

  test('refreshes a newly qualified exact-generation catalog in the background and expires quote evidence by age', async () => {
    const request = jest.fn(async (path) => {
      if (path === '/discover') {
        return {
          catalog_contracts: qualifiedCatalog(),
        };
      }
      if (path === '/refresh') return refreshResult();
      throw new Error(`Unexpected ${path}`);
    });
    const provider = createForecastExMonitorProvider({ request, now: () => NOW });

    expect(await provider.getSnapshot(CONTEXT)).toMatchObject({ status: 'unavailable', refreshing: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await provider.getSnapshot(CONTEXT)).toMatchObject({ status: 'available', refreshing: false, brokerRoutable: true });
    expect(request.mock.calls.filter(([path]) => path === '/discover')).toHaveLength(1);
    expect(request.mock.calls.filter(([path]) => path === '/refresh')).toHaveLength(1);
    const refreshBody = request.mock.calls.find(([path]) => path === '/refresh')[1].body;
    expect(refreshBody).toMatchObject({
      monitor: expect.objectContaining({ generationKey: 'FNQ_081926' }),
      retryMissing: true,
      catalogContracts: expect.arrayContaining([
        expect.objectContaining({ releaseKey: 'FNQ_081926', conId: 123, right: 'C' }),
        expect.objectContaining({ releaseKey: 'FNQ_081926', conId: 124, right: 'P' }),
      ]),
    });
  });

  test('retains a verified fresh native book while its next refresh is in flight', async () => {
    let currentNow = NOW;
    let refreshCount = 0;
    let releaseRefresh;
    const request = jest.fn(async (path) => {
      if (path === '/discover') return { catalog_contracts: qualifiedCatalog() };
      if (path === '/refresh') {
        refreshCount += 1;
        if (refreshCount === 1) return refreshResult();
        return new Promise((resolve) => { releaseRefresh = resolve; });
      }
      throw new Error(`Unexpected ${path}`);
    });
    const provider = createForecastExMonitorProvider({ request, now: () => currentNow });

    expect(await provider.getSnapshot(CONTEXT)).toMatchObject({ status: 'unavailable', refreshing: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await provider.getSnapshot(CONTEXT)).toMatchObject({ status: 'available', refreshing: false });

    currentNow += 30_000;
    expect(await provider.getSnapshot(CONTEXT)).toMatchObject({
      status: 'available',
      refreshing: true,
      refreshRetained: true,
      lines: [expect.objectContaining({ directNative: true })],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseRefresh(refreshResult());
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  test('preserves a fresh native one-sided top-of-book field without inventing its missing side', () => {
    const snapshot = normalizeLiveSnapshot(refreshResult([
      quoteEvent('YES', { native_ask: null, native_ask_size: null }),
    ]), CONTEXT, NOW);
    expect(snapshot).toMatchObject({
      status: 'available',
      lines: [{ yesBid: 0.40, yesAsk: null, noBid: null, noAsk: null, directNative: true }],
    });
  });

  test('does not call discovery for an expired monitor generation', async () => {
    const request = jest.fn();
    const provider = createForecastExMonitorProvider({ request, now: () => NOW });
    await expect(provider.getSnapshot({
      ...CONTEXT,
      closeTime: '2026-08-19T15:59:00.000Z',
    })).resolves.toMatchObject({ status: 'unavailable', lines: [] });
    expect(request).not.toHaveBeenCalled();
  });
});
