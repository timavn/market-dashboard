const { createPredictionMarketTestRouter, parsePipelineMarketIds } = require('./predictionMarketTest.cjs');
const { CONTRACT_REGISTRY } = require('../services/predictionMarketTest/registry.cjs');

const NOW = new Date('2026-08-14T12:00:00.000Z');

function routeHandler(router, path) {
  const layer = router.stack.find((entry) => entry.route?.path === path);
  if (!layer) throw new Error(`Missing route handler for ${path}`);
  return layer.route.stack[0].handle;
}

function responseMock() {
  return {
    json: jest.fn((body) => body),
    end: jest.fn(),
    setHeader: jest.fn(),
    status: jest.fn().mockReturnThis(),
  };
}

function liveIbkrFeed({ snapshotError = null } = {}) {
  const products = CONTRACT_REGISTRY.filter((product) => product.feed?.provider === 'ibkr');
  const symbols = Object.fromEntries(products.map((product, index) => [product.feed.symbol, {
    symbol: product.feed.symbol,
    status: 'live',
    definition: {
      validation: { valid: true, code: 'VERIFIED_IBKR_LIVE_DATED_FUTURE' },
    },
    quote: {
      bid: 100 + index,
      ask: 100.5 + index,
      asOf: NOW.toISOString(),
    },
    trade: null,
    settlements: {},
    marketStatus: null,
    error: null,
  }]));
  const health = {
    provider: 'ibkr',
    status: 'live',
    configured: true,
    symbols: Object.fromEntries(products.map((product) => [product.feed.symbol, {
      status: 'live',
      definition: { valid: true, code: 'VERIFIED_IBKR_LIVE_DATED_FUTURE' },
    }])),
  };
  return {
    start: jest.fn(() => true),
    stop: jest.fn(),
    refresh: jest.fn(() => Promise.resolve(true)),
    getSnapshot: jest.fn(() => {
      if (snapshotError) throw snapshotError;
      return { provider: { ...health }, symbols };
    }),
    getHealth: jest.fn(() => health),
  };
}

function publicSources() {
  const available = { status: 'available', lastSuccessAt: NOW.toISOString(), error: null };
  return {
    getKalshiEvent: jest.fn(async (eventTicker) => ({
      provider: 'kalshi_public_api',
      eventTicker,
      fetchedAt: NOW.toISOString(),
      lines: [],
      settlementValue: null,
      settlementConflict: false,
    })),
    getForecastExContracts: jest.fn(async (productId) => ({
      provider: 'forecastex_public_contracts',
      productId,
      fetchedAt: NOW.toISOString(),
      lines: [],
    })),
    getForecastExPairs: jest.fn(async (dataDate) => ({
      provider: 'forecastex_public_execution_tape',
      dataDate,
      fetchedAt: NOW.toISOString(),
      trades: [],
    })),
    getCoinbaseSpot: jest.fn(async () => null),
    getBlsCpi: jest.fn(async (product) => ({
      provider: 'bls',
      availability: 'pending_release',
      value: null,
      reportMonth: product.bls.reportMonth,
      releaseAt: product.releaseAt,
    })),
    getHealth: jest.fn(() => ({
      kalshi: available,
      forecastex: available,
      blsRelease: available,
      blsRss: available,
      blsApi: available,
      coinbase: available,
    })),
  };
}

function createRouter(feed = liveIbkrFeed(), { monitorHealth = {}, directionalHealth = null } = {}) {
  const sources = publicSources();
  const loadRiskRanges = jest.fn(async () => null);
  const loadInflationNowcasts = jest.fn(async () => []);
  const loadCryptoTracker = jest.fn(async () => []);
  const marketMonitorCoordinator = {
    getSnapshot: jest.fn((marketId) => ({ schemaVersion: 2, marketId, status: 'refreshing', venues: {}, contracts: { status: 'unavailable', lines: [] } })),
    getHealth: jest.fn(() => monitorHealth),
    start: jest.fn(),
    stop: jest.fn(),
  };
  const result = createPredictionMarketTestRouter({
    feed,
    publicSources: sources,
    loadRiskRanges,
    loadInflationNowcasts,
    loadCryptoTracker,
    marketMonitorCoordinator,
    ...(directionalHealth ? { loadMarketReferenceHealth: jest.fn(() => directionalHealth) } : {}),
    now: () => new Date(NOW),
  });
  return {
    ...result,
    feed,
    sources,
    loaders: { loadRiskRanges, loadInflationNowcasts, loadCryptoTracker },
    marketMonitorCoordinator,
  };
}

describe('Prediction Market Resolver Test route', () => {
  test('explicit monitor refresh shares one acquisition and returns only its completed new revision', async () => {
    let finish;
    let revision = 7;
    const coordinator = {
      getSnapshot: jest.fn(() => ({ marketId: 'gold', revision, refresh: { state: 'idle', startedAt: NOW.toISOString(), completedAt: NOW.toISOString() } })),
      refresh: jest.fn(() => new Promise(resolve => { finish = () => { revision = 8; resolve(); }; })),
    };
    const { router } = createPredictionMarketTestRouter({ feed: liveIbkrFeed(), publicSources: publicSources(), marketMonitorCoordinator: coordinator, now: () => new Date(NOW) });
    const first = responseMock(); const second = responseMock();
    const handler = routeHandler(router, '/monitor/:marketId/refresh');
    const a = handler({ params: { marketId: 'gold' }, query: { venue: 'kalshi' } }, first);
    const b = handler({ params: { marketId: 'gold' }, query: { venue: 'kalshi', view: 'review' } }, second);
    expect(coordinator.refresh).toHaveBeenCalledTimes(1);
    finish(); await Promise.all([a, b]);
    expect(coordinator.refresh).toHaveBeenCalledWith('gold', expect.objectContaining({ venue: 'kalshi', forceRefresh: true, refreshAfter: expect.any(Number) }));
    expect(first.json).toHaveBeenCalledWith(expect.objectContaining({ revision: 8, acquisition: expect.objectContaining({ status: 'complete', previousRevision: 7, revision: 8 }) }));
    expect(second.json).toHaveBeenCalledWith({ ...first.json.mock.calls[0][0], responseView: 'review' });
  });

  test.each(['failed', 'unchanged', 'old', 'timeout'])('explicit monitor refresh omits retained data after %s acquisition', async failure => {
    let refreshed = false;
    const coordinator = {
      getSnapshot: jest.fn(() => ({ marketId: 'gold', revision: refreshed && failure !== 'unchanged' ? 8 : 7,
        spot: { value: 123 }, refresh: { state: failure === 'failed' ? 'error' : 'idle',
          startedAt: failure === 'old' ? '2020-01-01T00:00:00Z' : NOW.toISOString(), completedAt: NOW.toISOString() } })),
      refresh: jest.fn(() => { refreshed = true; return failure === 'timeout' ? new Promise(() => {}) : Promise.resolve(); }),
    };
    const { router } = createPredictionMarketTestRouter({ feed: liveIbkrFeed(), publicSources: publicSources(), marketMonitorCoordinator: coordinator, now: () => new Date(NOW), monitorRefreshTimeoutMs: 5 });
    const response = responseMock();
    await routeHandler(router, '/monitor/:marketId/refresh')({ params: { marketId: 'gold' }, query: { venue: 'kalshi' } }, response);
    expect(response.status).toHaveBeenCalledWith(503);
    expect(response.json.mock.calls[0][0]).not.toHaveProperty('spot');
  });

  test('ForecastEx accepts a new acquisition completing after 25 seconds within its 35-second budget', async () => {
    jest.useFakeTimers({ now: NOW });
    try {
      let revision = 7;
      const coordinator = {
        getSnapshot: jest.fn(() => ({ marketId: 'silver', revision,
          refresh: { state: 'idle', startedAt: NOW.toISOString(), completedAt: new Date().toISOString() } })),
        refresh: jest.fn(() => new Promise(resolve => setTimeout(() => { revision = 8; resolve(); }, 30_000))),
      };
      const { router } = createPredictionMarketTestRouter({ feed: liveIbkrFeed(), publicSources: publicSources(), marketMonitorCoordinator: coordinator });
      const response = responseMock();
      const pending = routeHandler(router, '/monitor/:marketId/refresh')({ params: { marketId: 'silver' }, query: { venue: 'forecastex' } }, response);
      await jest.advanceTimersByTimeAsync(25_000);
      expect(response.json).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(5_000);
      await pending;
      expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ revision: 8,
        acquisition: expect.objectContaining({ status: 'complete', requestedAt: NOW.toISOString(), completedAt: new Date(NOW.getTime() + 30_000).toISOString() }) }));
      expect(response.status).not.toHaveBeenCalled();
    } finally { jest.clearAllTimers(); jest.useRealTimers(); }
  });

  test.each([
    ['forecastex', undefined, 35_000],
    ['kalshi', undefined, 25_000],
    ['forecastex', 10_000, 10_000],
    ['forecastex', 90_000, 35_000],
  ])('%s acquisition fails closed at its bounded deadline (override %s)', async (venue, timeout, deadlineMs) => {
    jest.useFakeTimers({ now: NOW });
    try {
      const coordinator = { getSnapshot: jest.fn(() => ({ revision: 7 })), refresh: jest.fn(() => new Promise(() => {})) };
      const { router } = createPredictionMarketTestRouter({ feed: liveIbkrFeed(), publicSources: publicSources(), marketMonitorCoordinator: coordinator,
        ...(timeout === undefined ? {} : { monitorRefreshTimeoutMs: timeout }) });
      const response = responseMock();
      const pending = routeHandler(router, '/monitor/:marketId/refresh')({ params: { marketId: 'silver' }, query: { venue } }, response);
      await jest.advanceTimersByTimeAsync(deadlineMs - 1);
      expect(response.json).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      await pending;
      expect(response.status).toHaveBeenCalledWith(503);
      expect(response.json.mock.calls[0][0]).not.toHaveProperty('acquisition');
      expect(response.json.mock.calls[0][0]).not.toHaveProperty('displayContracts');
    } finally { jest.clearAllTimers(); jest.useRealTimers(); }
  });

  test('explicit monitor refresh keeps its acquisition boundary through progressive continuation', async () => {
    let revision = 7;
    const coordinator = {
      getSnapshot: jest.fn(() => ({ marketId: 'gold', revision, refresh: { state: revision === 8 ? 'refreshing' : 'idle', startedAt: NOW.toISOString(), completedAt: NOW.toISOString() } })),
      refresh: jest.fn(async () => { revision += 1; }),
    };
    const { router } = createPredictionMarketTestRouter({ feed: liveIbkrFeed(), publicSources: publicSources(), marketMonitorCoordinator: coordinator, now: () => new Date(NOW) });
    const response = responseMock();
    await routeHandler(router, '/monitor/:marketId/refresh')({ params: { marketId: 'gold' }, query: { venue: 'kalshi' } }, response);
    expect(coordinator.refresh).toHaveBeenCalledTimes(2);
    expect(coordinator.refresh.mock.calls[1]).toEqual(coordinator.refresh.mock.calls[0]);
    expect(coordinator.refresh.mock.calls[1][1].forceRefresh).toBe(true);
    expect(response.json.mock.calls[0][0].revision).toBe(9);
  });

  const scopedBook = (venue = 'kalshi') => ({
    marketId: 'silver', selectedVenueId: venue, status: 'partial', sourceRefreshPending: true,
    refresh: { state: 'refreshing', startedAt: NOW.toISOString(), completedAt: NOW.toISOString(), lastError: null },
    displaySelection: { status: 'available', venueId: venue },
    displayContracts: {
      status: 'available', bookExpiresAt: new Date(NOW.getTime() + 90_000).toISOString(),
      event: { ticker: 'event-1', venueId: venue, status: 'open', closeTime: new Date(NOW.getTime() + 3_600_000).toISOString() },
      lines: [{ directNative: true, derivedFields: [], yesBid: .4, yesAsk: .45, noBid: .55, noAsk: .6,
        evidence: { quotes: { source: venue === 'kalshi' ? 'kalshi_batch_orderbooks_v2' : 'ibkr_tws_forecastex_live', fit: 'exact', asOf: NOW.toISOString() } } }],
    },
    spot: { status: 'refreshing' }, riskRange: { status: 'unavailable' }, strategy: { status: 'unavailable' },
  });

  test.each(['kalshi', 'forecastex'])('explicit %s refresh returns newly observed native quotes while unrelated sources remain pending', async venue => {
    const snapshot = scopedBook(venue);
    let revision = 7;
    const coordinator = { getSnapshot: jest.fn(() => ({ ...snapshot, revision })), refresh: jest.fn(async () => { revision += 1; }) };
    const { router } = createPredictionMarketTestRouter({ feed: liveIbkrFeed(), publicSources: publicSources(), marketMonitorCoordinator: coordinator, now: () => new Date(NOW) });
    const response = responseMock();
    await routeHandler(router, '/monitor/:marketId/refresh')({ params: { marketId: 'silver' }, query: { venue } }, response);
    expect(coordinator.refresh).toHaveBeenCalledTimes(1);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      revision: 8, sourceRefreshPending: true, refresh: snapshot.refresh, displayContracts: snapshot.displayContracts,
      acquisition: expect.objectContaining({ status: 'complete', scope: 'pinned_native_book', previousRevision: 7, revision: 8 }),
    }));
    expect(response.json.mock.calls[0][0].strategy.status).toBe('unavailable');
  });

  test.each([
    ['stale', snapshot => { snapshot.displayContracts.stale = true; }],
    ['cache only', snapshot => { snapshot.displayContracts.cacheOnly = true; }],
    ['mock', snapshot => { snapshot.displayContracts.lines[0].mock = true; }],
    ['seeded', snapshot => { snapshot.displayContracts.seeded = true; }],
    ['disconnected', snapshot => { snapshot.displayContracts.connected = false; }],
    ['retained book', snapshot => { snapshot.displayContracts.refreshRetained = true; }],
    ['pending book', snapshot => { snapshot.displayContracts.refreshPending = true; }],
    ['expired book', snapshot => { snapshot.displayContracts.bookExpiresAt = NOW.toISOString(); }],
    ['prior observation', snapshot => { snapshot.displayContracts.lines[0].evidence.quotes.asOf = new Date(NOW.getTime() - 1).toISOString(); }],
    ['future observation', snapshot => { snapshot.displayContracts.lines[0].evidence.quotes.asOf = new Date(NOW.getTime() + 6_000).toISOString(); }],
    ['wrong venue', snapshot => { snapshot.displayContracts.event.venueId = 'forecastex'; }],
    ['closed event', snapshot => { snapshot.displayContracts.event.status = 'closed'; }],
    ['derived quote', snapshot => { snapshot.displayContracts.lines[0].derivedFields = ['noAsk']; }],
    ['wrong source', snapshot => { snapshot.displayContracts.lines[0].evidence.quotes.source = 'model'; }],
    ['crossed quote', snapshot => { snapshot.displayContracts.lines[0].yesBid = .9; }],
    ['incomplete book', snapshot => { snapshot.displayContracts.lines[0].noAsk = null; }],
    ['coordinator failure', snapshot => { snapshot.refresh.lastError = { code: 'failure' }; }],
    ['old refresh', snapshot => { snapshot.refresh.startedAt = '2020-01-01T00:00:00Z'; }],
  ])('scoped acquisition rejects %s evidence while other sources are pending', async (_label, change) => {
    const snapshot = scopedBook(); change(snapshot);
    let revision = 7;
    const coordinator = { getSnapshot: jest.fn(() => ({ ...snapshot, revision })), refresh: jest.fn(async () => { revision += 1; }) };
    const { router } = createPredictionMarketTestRouter({ feed: liveIbkrFeed(), publicSources: publicSources(), marketMonitorCoordinator: coordinator, now: () => new Date(NOW), monitorRefreshTimeoutMs: 5 });
    const response = responseMock();
    await routeHandler(router, '/monitor/:marketId/refresh')({ params: { marketId: 'silver' }, query: { venue: 'kalshi' } }, response);
    expect(response.status).toHaveBeenCalledWith(503);
    expect(response.json.mock.calls[0][0]).not.toHaveProperty('displayContracts');
  });

  test('explicit monitor refresh rejects automatic and unsupported venues', async () => {
    const coordinator = { refresh: jest.fn(), getSnapshot: jest.fn() };
    const { router } = createPredictionMarketTestRouter({ feed: liveIbkrFeed(), publicSources: publicSources(), marketMonitorCoordinator: coordinator });
    for (const [marketId, venue] of [['gold', 'auto'], ['sp500', 'kalshi'], ['invalid', 'kalshi']]) {
      const response = responseMock();
      await routeHandler(router, '/monitor/:marketId/refresh')({ params: { marketId }, query: { venue } }, response);
      expect(response.status).toHaveBeenCalledWith(400);
    }
    expect(coordinator.refresh).not.toHaveBeenCalled();
  });

  test('parses the staged pipeline market allowlist and includes the fixed CPI card', () => {
    expect(parsePipelineMarketIds('gold,silver')).toEqual(['gold', 'silver']);
    expect(parsePipelineMarketIds('all')).toEqual(['sp500', 'wti', 'gold', 'silver', 'brent', 'bitcoin', 'ethereum', 'cpi', 'gdp']);
    expect(parsePipelineMarketIds('bitcoin,ethereum')).toEqual(['bitcoin', 'ethereum']);
    expect(parsePipelineMarketIds('off')).toEqual([]);
    expect(() => parsePipelineMarketIds('gold,unknown')).toThrow(/unsupported markets: unknown/i);
    expect(() => parsePipelineMarketIds('nasdaq100')).toThrow(/unsupported markets: nasdaq100/i);
  });
  test('serves one pure-read no-store fail-closed morning packet in the exact four-market order', async () => {
    const marketMonitorCoordinator = {
      refresh: jest.fn(async () => null),
      getSnapshot: jest.fn((marketId) => ({
        schemaVersion: 2,
        marketId,
        generatedAt: NOW.toISOString(),
        status: marketId === 'gold' ? 'unavailable' : 'partial',
        spot: { status: 'unavailable', value: null },
        riskRange: { status: 'unavailable', lrr: null, hrr: null, trend: null },
        factors: {},
        venues: {},
        displayContracts: { status: 'unavailable', event: null, lines: [] },
        autoSelection: { status: 'unavailable', contracts: { status: 'unavailable', lines: [] } },
        strategy: { status: 'unavailable', model: null },
      })),
      getHealth: jest.fn(() => ({})), start: jest.fn(), stop: jest.fn(),
    };
    const result = createPredictionMarketTestRouter({
      feed: liveIbkrFeed(),
      publicSources: publicSources(),
      marketMonitorCoordinator,
      now: () => new Date(NOW),
    });
    const response = responseMock();

    await routeHandler(result.router, '/morning-report')({}, response);

    expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store, max-age=0');
    expect(marketMonitorCoordinator.refresh).not.toHaveBeenCalled();
    expect(marketMonitorCoordinator.getSnapshot.mock.calls.map(([marketId]) => marketId)).toEqual([
      'sp500', 'wti', 'nasdaq100', 'gold',
    ]);
    expect(response.status).toHaveBeenCalledWith(503);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      reportType: 'four_market_morning',
      marketOrder: ['sp500', 'wti', 'nasdaq100', 'gold'],
      markets: expect.arrayContaining([
        expect.objectContaining({ marketId: 'sp500' }),
        expect.objectContaining({ marketId: 'wti' }),
        expect.objectContaining({ marketId: 'nasdaq100' }),
        expect.objectContaining({ marketId: 'gold' }),
      ]),
      policy: expect.objectContaining({
        currentFieldsMayUseArchiveFallback: false,
        recommendationAllowed: false,
      }),
    }));
  });

  test('reuses a current attention snapshot without an unnecessary upstream refresh', async () => {
    const expiresAt = '2026-08-14T13:00:00.000Z';
    const closeTime = '2026-08-14T20:00:00.000Z';
    const marketMonitorCoordinator = {
      refresh: jest.fn(async () => null),
      getSnapshot: jest.fn((marketId) => ({
        schemaVersion: 2,
        marketId,
        generatedAt: NOW.toISOString(),
        status: 'partial',
        spot: { status: 'unavailable', value: null },
        riskRange: {
          status: 'available', lrr: 100, hrr: 120, previousClose: 105,
          trend: 'BULLISH', date: '2026-08-14', fit: 'calibration',
          source: 'risk-ranges', asOf: NOW.toISOString(), expiresAt,
        },
        factors: {},
        venues: {},
        displayContracts: {
          status: 'available', asOf: NOW.toISOString(), expiresAt,
          event: { ticker: `${marketId}-EVENT`, status: 'open', closeTime },
          lines: [{}],
        },
        autoSelection: { status: 'unavailable', contracts: { status: 'unavailable', lines: [] } },
        strategy: { status: 'unavailable', model: null },
      })),
      getHealth: jest.fn(() => ({})), start: jest.fn(), stop: jest.fn(),
    };
    const result = createPredictionMarketTestRouter({
      feed: liveIbkrFeed(),
      publicSources: publicSources(),
      marketMonitorCoordinator,
      now: () => new Date(NOW),
    });
    const response = responseMock();

    await routeHandler(result.router, '/morning-report')({}, response);

    expect(marketMonitorCoordinator.refresh).not.toHaveBeenCalled();
    expect(marketMonitorCoordinator.getSnapshot).toHaveBeenCalledTimes(4);
    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      markets: expect.arrayContaining([
        expect.objectContaining({
          marketId: 'sp500',
          rangePosition: expect.objectContaining({
            status: 'available', referenceLabel: 'RR close', value: 105,
          }),
        }),
      ]),
    }));
  });

  test.each(['sp500', 'wti', 'nasdaq100', 'gold', 'silver', 'brent', 'bitcoin', 'ethereum'])(
    'serves a pure-read no-store normalized v2 %s monitor snapshot',
    async (marketId) => {
      const snapshot = {
        schemaVersion: 2,
        marketId,
        generatedAt: NOW.toISOString(),
        status: 'partial',
        revision: 7,
        refresh: { state: 'idle', revision: 7, suggestedNextPollMs: 5_000 },
        venues: {},
        contracts: { status: 'unavailable', lines: [] },
      };
      const marketMonitorService = { getSnapshot: jest.fn(async () => snapshot) };
      const marketMonitorCoordinator = {
        getSnapshot: jest.fn(() => snapshot),
        getHealth: jest.fn(() => ({})),
        start: jest.fn(),
        stop: jest.fn(),
      };
      const result = createPredictionMarketTestRouter({
        feed: liveIbkrFeed(),
        publicSources: publicSources(),
        marketMonitorService,
        marketMonitorCoordinator,
        now: () => new Date(NOW),
      });
      const response = responseMock();

      await routeHandler(result.router, '/monitor/:marketId')({ params: { marketId } }, response);

      expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store, max-age=0');
      expect(response.status).not.toHaveBeenCalled();
      expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
        schemaVersion: 2,
        marketId,
        status: 'partial',
        revision: 7,
        refresh: expect.objectContaining({ state: 'idle', suggestedNextPollMs: 5_000 }),
      }));
      expect(marketMonitorCoordinator.getSnapshot).toHaveBeenCalledWith(marketId, {
        venue: marketId === 'sp500' ? 'forecastex' : marketId === 'gold' ? 'kalshi' : 'auto',
        generationId: null,
      });
      expect(marketMonitorService.getSnapshot).not.toHaveBeenCalled();
    },
  );

  test('serves the compact card view with a revision ETag and returns 304 when unchanged', async () => {
    const points = Array.from({ length: 2_000 }, (_, index) => ({ timestamp: NOW.getTime() + index * 60_000, value: 100 + index / 100 }));
    const variant = (range) => ({
      status: 'available', availability: 'live', range, points,
      source: 'ibkr_historical_bars', asOf: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 60_000).toISOString(), fit: 'proxy', executable: false,
    });
    const snapshot = {
      schemaVersion: 2, marketId: 'silver', generatedAt: NOW.toISOString(), revision: 11, status: 'partial',
      session: { state: 'open' }, spot: { status: 'available', value: 66, fit: 'proxy' },
      chart: { ...variant('1d'), variants: { '1d': variant('1d'), '5d': variant('5d'), '10d': variant('10d') } },
      chartReferences: {
        basis: {
          role: 'risk_range_basis', symbol: 'SILVER', riskRangeTicker: 'SILVER', exact: false,
          spot: { status: 'available', value: 66 }, chart: variant('1d'),
          freshness: { status: 'verified_live' },
        },
        contract: {
          role: 'contract_reference', symbol: 'SIZ26', riskRangeTicker: 'SILVER', exact: true,
          spot: { status: 'available', value: 66.2 }, chart: variant('1d'),
          freshness: { status: 'verified_live' },
        },
      },
      selectedVenueId: 'forecastex', venues: {}, contracts: { status: 'available', event: null, lines: [] },
      sourceHealth: [], errors: [],
    };
    const marketMonitorCoordinator = {
      getSnapshot: jest.fn(() => snapshot), getHealth: jest.fn(() => ({})), start: jest.fn(), stop: jest.fn(),
    };
    const result = createPredictionMarketTestRouter({
      feed: liveIbkrFeed(), publicSources: publicSources(), marketMonitorCoordinator, now: () => new Date(NOW),
    });
    const first = responseMock();
    await routeHandler(result.router, '/monitor/:marketId')({
      params: { marketId: 'silver' }, query: { view: 'card' }, headers: {},
    }, first);
    expect(first.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-cache, max-age=0');
    const etag = first.setHeader.mock.calls.find(([name]) => name === 'ETag')?.[1];
    expect(etag).toMatch(/^"[a-f0-9]+"$/);
    const payload = first.json.mock.calls[0][0];
    expect(payload).toMatchObject({
      schemaVersion: 2, cardView: true, marketId: 'silver', revision: 11,
      chartReferences: {
        basis: { role: 'risk_range_basis', symbol: 'SILVER', spot: { value: 66 } },
        contract: { role: 'contract_reference', symbol: 'SIZ26', spot: { value: 66.2 } },
      },
    });
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThan(200_000);

    const second = responseMock();
    await routeHandler(result.router, '/monitor/:marketId')({
      params: { marketId: 'silver' }, query: { view: 'card' }, headers: { 'if-none-match': etag },
    }, second);
    expect(second.status).toHaveBeenCalledWith(304);
    expect(second.end).toHaveBeenCalled();
    expect(second.json).not.toHaveBeenCalled();

    // A pure read can fail closed or otherwise sanitize a representation
    // between scheduler revisions. Its content ETag must change even when the
    // background revision and generatedAt identity are unchanged.
    snapshot.spot = { ...snapshot.spot, status: 'unavailable', value: null, reason: 'The live mark expired.' };
    const changed = responseMock();
    await routeHandler(result.router, '/monitor/:marketId')({
      params: { marketId: 'silver' }, query: { view: 'card' }, headers: { 'if-none-match': etag },
    }, changed);
    expect(changed.status).not.toHaveBeenCalledWith(304);
    expect(changed.json).toHaveBeenCalledWith(expect.objectContaining({
      revision: 11,
      spot: expect.objectContaining({ status: 'unavailable', value: null }),
    }));
    const changedEtag = changed.setHeader.mock.calls.find(([name]) => name === 'ETag')?.[1];
    expect(changedEtag).not.toBe(etag);
  });

  test('pins Gold to the current Kalshi KXGOLDD state despite legacy venue or generation query parameters', async () => {
    const marketMonitorService = { getSnapshot: jest.fn(async () => ({
      schemaVersion: 2,
      marketId: 'gold',
      status: 'partial',
      venues: {},
      contracts: { status: 'unavailable', lines: [] },
    })) };
    const marketMonitorCoordinator = {
      getSnapshot: jest.fn(() => ({
        schemaVersion: 2,
        marketId: 'gold',
        generatedAt: NOW.toISOString(),
        status: 'partial',
        revision: 2,
        venues: {},
        contracts: { status: 'unavailable', lines: [] },
      })),
      getHealth: jest.fn(() => ({})),
      start: jest.fn(),
      stop: jest.fn(),
    };
    const result = createPredictionMarketTestRouter({
      feed: liveIbkrFeed(),
      publicSources: publicSources(),
      marketMonitorService,
      marketMonitorCoordinator,
      now: () => new Date(NOW),
    });
    const response = responseMock();

    await routeHandler(result.router, '/monitor/:marketId')({
      params: { marketId: 'gold' },
      query: { venue: 'forecastex', generationId: 'METLG_082026' },
    }, response);
    expect(marketMonitorCoordinator.getSnapshot).toHaveBeenCalledWith('gold', {
      venue: 'kalshi',
      generationId: null,
    });
    expect(marketMonitorService.getSnapshot).not.toHaveBeenCalled();
  });

  test('rejects Kalshi and manual generation overrides on the fixed SP500 FES route', async () => {
    const marketMonitorService = { getSnapshot: jest.fn() };
    const result = createPredictionMarketTestRouter({
      feed: liveIbkrFeed(),
      publicSources: publicSources(),
      marketMonitorService,
      now: () => new Date(NOW),
    });
    const kalshiResponse = responseMock();
    const generationResponse = responseMock();

    await routeHandler(result.router, '/monitor/:marketId')({
      params: { marketId: 'sp500' }, query: { venue: 'kalshi' },
    }, kalshiResponse);
    await routeHandler(result.router, '/monitor/:marketId')({
      params: { marketId: 'sp500' }, query: { venue: 'forecastex', generationId: 'FES_082126' },
    }, generationResponse);

    expect(kalshiResponse.status).toHaveBeenCalledWith(400);
    expect(kalshiResponse.json).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({ code: 'PM_SP500_FORECASTEX_ONLY' }),
    }));
    expect(generationResponse.status).toHaveBeenCalledWith(400);
    expect(generationResponse.json).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.objectContaining({ code: 'PM_SP500_GENERATION_FIXED' }),
    }));
    expect(marketMonitorService.getSnapshot).not.toHaveBeenCalled();
  });

  test.each(['full', 'card'])('keeps CPI auto on Kalshi while honoring explicit venues in %s view and rejecting generation overrides', async (view) => {
    const marketMonitorCoordinator = {
      getSnapshot: jest.fn(() => ({
        schemaVersion: 2,
        marketId: 'cpi',
        status: 'partial',
        revision: 1,
        venues: {},
        contracts: { status: 'unavailable', lines: [] },
      })),
      getHealth: jest.fn(() => ({})),
      start: jest.fn(),
      stop: jest.fn(),
    };
    const result = createPredictionMarketTestRouter({
      feed: liveIbkrFeed(),
      publicSources: publicSources(),
      marketMonitorCoordinator,
      now: () => new Date(NOW),
    });
    const handler = routeHandler(result.router, '/monitor/:marketId');
    for (const venue of ['auto', 'kalshi', 'forecastex']) {
      const response = responseMock();
      await handler({ params: { marketId: 'cpi' }, query: { venue, view }, headers: {} }, response);
      expect(marketMonitorCoordinator.getSnapshot).toHaveBeenLastCalledWith('cpi', {
        venue: venue === 'auto' ? 'kalshi' : venue,
        generationId: null,
      });
      expect(response.status).not.toHaveBeenCalled();
      expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ marketId: 'cpi' }));
    }
    for (const [venue, generationId] of [['kalshi', 'KXCPIYOY-26AUG'], ['forecastex', 'CPI_0826']]) {
      const response = responseMock();
      await handler({ params: { marketId: 'cpi' }, query: { venue, view, generationId }, headers: {} }, response);
      expect(response.status).toHaveBeenCalledWith(400);
      expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
        error: expect.objectContaining({ code: 'PM_CPI_GENERATION_FIXED' }),
      }));
    }
    expect(marketMonitorCoordinator.getSnapshot).toHaveBeenCalledTimes(3);
  });

  test('pins GDP to ForecastEx Q3 and rejects other venue or quarter selections', async () => {
    const marketMonitorCoordinator = {
      getSnapshot: jest.fn(() => ({ schemaVersion: 2, marketId: 'gdp', status: 'partial', venues: {},
        contracts: { status: 'unavailable', lines: [] } })),
      getHealth: jest.fn(() => ({})), start: jest.fn(), stop: jest.fn(),
    };
    const result = createPredictionMarketTestRouter({ feed: liveIbkrFeed(), publicSources: publicSources(),
      marketMonitorCoordinator, now: () => new Date(NOW) });
    const handler = routeHandler(result.router, '/monitor/:marketId');
    await handler({ params: { marketId: 'gdp' }, query: { venue: 'auto' }, headers: {} }, responseMock());
    expect(marketMonitorCoordinator.getSnapshot).toHaveBeenCalledWith('gdp', { venue: 'forecastex', generationId: null });
    for (const query of [{ venue: 'kalshi' }, { generationId: 'RGDP_Q226' }, { quarter: '2026-Q2' }]) {
      const response = responseMock();
      await handler({ params: { marketId: 'gdp' }, query, headers: {} }, response);
      expect(response.status).toHaveBeenCalledWith(400);
    }
    expect(marketMonitorCoordinator.getSnapshot).toHaveBeenCalledTimes(1);
  });

  test('returns 400 for an unknown monitor market without invoking the snapshot service', async () => {
    const marketMonitorService = { getSnapshot: jest.fn() };
    const result = createPredictionMarketTestRouter({
      feed: liveIbkrFeed(),
      publicSources: publicSources(),
      marketMonitorService,
      now: () => new Date(NOW),
    });
    const response = responseMock();

    await routeHandler(result.router, '/monitor/:marketId')({ params: { marketId: 'eurusd' } }, response);

    expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store, max-age=0');
    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      schemaVersion: 2,
      status: 'unavailable',
      marketId: 'eurusd',
      supportedMarkets: ['sp500', 'wti', 'nasdaq100', 'gold', 'silver', 'brent', 'bitcoin', 'ethereum', 'cpi', 'gdp'],
      error: expect.objectContaining({ code: 'PM_MONITOR_UNSUPPORTED_MARKET' }),
    }));
    expect(marketMonitorService.getSnapshot).not.toHaveBeenCalled();
  });

  test.each(['gold', 'bitcoin', 'ethereum'])('returns a structurally valid no-store 503 when the coordinator cannot construct a %s snapshot', async (marketId) => {
    const marketMonitorCoordinator = {
      getSnapshot: jest.fn(() => { throw new Error('construction failed'); }),
      getHealth: jest.fn(() => ({})), start: jest.fn(), stop: jest.fn(),
    };
    const result = createPredictionMarketTestRouter({
      feed: liveIbkrFeed(),
      publicSources: publicSources(),
      marketMonitorCoordinator,
      now: () => new Date(NOW),
    });
    const response = responseMock();
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await routeHandler(result.router, '/monitor/:marketId')({ params: { marketId } }, response);
    } finally {
      consoleError.mockRestore();
    }

    expect(response.status).toHaveBeenCalledWith(503);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      schemaVersion: 2,
      marketId,
      status: 'unavailable',
      venues: {},
      contracts: { status: 'unavailable', event: null, lines: [] },
      strategy: { status: 'unavailable', model: null, eligibleVenueId: null },
    }));
  });

  test('serves the independent no-store SPX monitor snapshot', async () => {
    const spxSnapshot = {
      schemaVersion: 1,
      generatedAt: NOW.toISOString(),
      status: 'partial',
      contracts: { status: 'available', lines: [] },
    };
    const spxMonitorService = { getSnapshot: jest.fn(async () => spxSnapshot) };
    const marketMonitorCoordinator = {
      getSnapshot: jest.fn(() => ({ ...spxSnapshot, schemaVersion: 2, marketId: 'sp500' })),
      getHealth: jest.fn(() => ({})), start: jest.fn(), stop: jest.fn(),
    };
    const result = createPredictionMarketTestRouter({
      feed: liveIbkrFeed(),
      publicSources: publicSources(),
      spxMonitorService,
      marketMonitorCoordinator,
      now: () => new Date(NOW),
    });
    const response = responseMock();

    await routeHandler(result.router, '/spx-monitor')({}, response);

    expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store, max-age=0');
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ schemaVersion: 2, marketId: 'sp500' }));
    expect(marketMonitorCoordinator.getSnapshot).toHaveBeenCalledWith('sp500', {
      venue: 'forecastex',
      generationId: null,
    });
  });

  test('serves no-store snapshot compatibility and unified directional health', async () => {
    const subject = createRouter();
    const snapshotResponse = responseMock();
    const healthResponse = responseMock();

    await routeHandler(subject.router, '/snapshot')({}, snapshotResponse);
    await routeHandler(subject.router, '/health')({}, healthResponse);

    expect(snapshotResponse.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store, max-age=0');
    expect(healthResponse.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store, max-age=0');

    const snapshot = snapshotResponse.json.mock.calls[0][0];
    const health = healthResponse.json.mock.calls[0][0];
    expect(snapshot.providers).toHaveProperty('ibkrFutures');
    expect(health.providers).toHaveProperty('ibkrFutures');
    expect(Object.keys(health.providers.ibkrFutures.symbols)).toEqual(['ES', 'CL', 'GC', 'SI', 'BZ']);
    expect(health.providers.ibkrFutures.symbols).not.toHaveProperty('CLU6');
    expect(health.providers.ibkrFutures).toMatchObject({
      dataset: 'Unified liquid directional futures registry',
      requestedSymbolCount: 5,
      cachePolicy: 'verified_completed_history_only',
    });
    expect(health.schedule).toEqual({
      blsCpi: {
        releaseAt: '2026-09-11T12:30:00.000Z',
        reportMonth: '2026-08',
        windowOpensAt: '2026-09-11T12:15:00.000Z',
        due: false,
        released: false,
      },
    });
    for (const providers of [snapshot.providers, health.providers]) {
      expect(providers).not.toHaveProperty('databento');
      expect(providers).not.toHaveProperty('cfBenchmarks');
    }
    expect(snapshot.products).toHaveLength(CONTRACT_REGISTRY.length);
    expect(subject.feed.refresh).not.toHaveBeenCalled();
  });

  test('starts only the background monitor coordinator and retires the dated feed', () => {
    const subject = createRouter();

    subject.start();
    subject.stop();

    expect(subject.feed.start).not.toHaveBeenCalled();
    expect(subject.feed.stop).toHaveBeenCalledTimes(1);
    expect(subject.feed.refresh).not.toHaveBeenCalled();
    expect(subject.marketMonitorCoordinator.start).toHaveBeenCalledTimes(1);
    expect(subject.marketMonitorCoordinator.stop).toHaveBeenCalledTimes(1);
  });

  test('serves health from process-local observations without probing any upstream', async () => {
    const subject = createRouter();
    const response = responseMock();

    await routeHandler(subject.router, '/health')({}, response);

    expect(response.status).not.toHaveBeenCalled();
    expect(response.json.mock.calls[0][0]).toHaveProperty('schedule.blsCpi');
    expect(subject.feed.refresh).not.toHaveBeenCalled();
    expect(subject.feed.getSnapshot).not.toHaveBeenCalled();
    expect(subject.sources.getKalshiEvent).not.toHaveBeenCalled();
    expect(subject.sources.getForecastExContracts).not.toHaveBeenCalled();
    expect(subject.sources.getForecastExPairs).not.toHaveBeenCalled();
    expect(subject.sources.getCoinbaseSpot).not.toHaveBeenCalled();
    expect(subject.sources.getBlsCpi).not.toHaveBeenCalled();
    expect(Object.values(subject.loaders).every((loader) => loader.mock.calls.length === 0)).toBe(true);
  });

  test('derives IBKR, Coinbase, and Hedgeye health from the unified card pipeline', async () => {
    const subject = createRouter(liveIbkrFeed(), {
      directionalHealth: {
        providerStatus: { connected: true, status: 'connected', asOf: NOW.toISOString() },
        directionalSelections: {
          sp500: { status: 'available', conId: 101, localSymbol: 'ESU26' },
          wti: { status: 'available', conId: 102, localSymbol: 'CLV26' },
        },
      },
      monitorHealth: {
        bitcoin: {
          sourceHealth: [
            { id: 'resolver_spot', status: 'live', source: 'coinbase_exchange_public_ticker', asOf: NOW.toISOString(), applicable: true },
            { id: 'risk_range', status: 'live', source: 'hedgeye-risk-ranges-email', asOf: NOW.toISOString(), applicable: true },
          ],
        },
      },
    });
    const response = responseMock();

    await routeHandler(subject.router, '/health')({}, response);

    const body = response.json.mock.calls[0][0];
    expect(body.providers.ibkrFutures).toMatchObject({
      connected: true,
      status: 'available',
      selectedSymbolCount: 2,
      symbols: {
        ES: { conId: 101, localSymbol: 'ESU26' },
        CL: { conId: 102, localSymbol: 'CLV26' },
      },
    });
    expect(body.providers.coinbase).toMatchObject({ status: 'available', usableObservationCount: 1 });
    expect(body.providers.hedgeyeRiskRanges).toMatchObject({ status: 'available', usableObservationCount: 1 });
  });

  test('fails closed with a no-store 503 and no legacy provider keys', async () => {
    const snapshotError = Object.assign(new Error('IBKR quote snapshot failed'), {
      code: 'IBKR_TEST_SNAPSHOT_FAILED',
    });
    const subject = createRouter(liveIbkrFeed({ snapshotError }));
    const response = responseMock();
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await routeHandler(subject.router, '/snapshot')({}, response);
    } finally {
      consoleError.mockRestore();
    }

    expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store, max-age=0');
    expect(response.status).toHaveBeenCalledWith(503);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      schemaVersion: 1,
      generatedAt: NOW.toISOString(),
      status: 'unavailable',
      products: [],
      error: {
        code: 'IBKR_TEST_SNAPSHOT_FAILED',
        message: 'Resolver Test snapshot is unavailable.',
      },
    }));
    const body = response.json.mock.calls[0][0];
    expect(body.providers).toHaveProperty('ibkrFutures');
    expect(body.providers).not.toHaveProperty('databento');
    expect(body.providers).not.toHaveProperty('cfBenchmarks');
  });
});
