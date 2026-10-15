jest.mock('../../services/predictionMarketsIngest', () => ({
  getAggregatedFinancialPredictionEvents: jest.fn(),
  fetchIBKREvents: jest.fn(),
}));

jest.mock('../../services/predictionMarketsIngest/cache', () => ({
  getProviderStatus: jest.fn(),
  loadOperationalCatalogByRelease: jest.fn(),
  persistCatalogEvents: jest.fn(),
  setProviderStatus: jest.fn(),
}));

jest.mock('../../services/predictionMarketsIngest/providers/kalshiProvider', () => ({
  fetchKalshiCpiEvents: jest.fn(),
}));

jest.mock('../../services/predictionMarketsIngest/cpiRelease', () => ({
  getCurrentCpiRelease: jest.fn(),
  releaseKeyForEvent: jest.fn((event) => event?.releaseKey || null),
}));

jest.mock('../../services/predictionMarketsIngest/cpiOfficial', () => ({
  loadOfficialCpiFinals: jest.fn(),
}));

jest.mock('../../services/predictionMarketsIngest/cpiBenchmarkProvider', () => ({
  loadCpiBenchmarks: jest.fn(),
}));

jest.mock('../../services/predictionMarketsIngest/watchlistProvider', () => ({
  getLastSettledSpxCloseSession: jest.fn(),
  getLastSettledWtiSession: jest.fn(),
  getPredictionMarketsOverview: jest.fn(),
  getPredictionMarketWatchlist: jest.fn(),
  getRecentSettledSpxCloseSessions: jest.fn(),
  getRecentSettledWtiSessions: jest.fn(),
  getSpxCoverSnapshot: jest.fn(),
  getSpxCloseWorkbench: jest.fn(),
  getWtiWorkbench: jest.fn(),
}));

const {
  fetchIBKREvents,
} = require('../../services/predictionMarketsIngest');
const {
  getProviderStatus,
  loadOperationalCatalogByRelease,
  persistCatalogEvents,
  setProviderStatus,
} = require('../../services/predictionMarketsIngest/cache');
const {
  fetchKalshiCpiEvents,
} = require('../../services/predictionMarketsIngest/providers/kalshiProvider');
const {
  getCurrentCpiRelease,
  releaseKeyForEvent,
} = require('../../services/predictionMarketsIngest/cpiRelease');
const { loadOfficialCpiFinals } = require('../../services/predictionMarketsIngest/cpiOfficial');
const { loadCpiBenchmarks } = require('../../services/predictionMarketsIngest/cpiBenchmarkProvider');
const {
  getPredictionMarketWatchlist,
  getSpxCoverSnapshot,
} = require('../../services/predictionMarketsIngest/watchlistProvider');
const router = require('../predictionMarketsIngest');

const CURRENT_RELEASE = {
  releaseKey: 'KXCPIYOY#2026-07',
  reportMonth: '2026-07',
  cpi: {
    releaseKey: 'KXCPIYOY#2026-07',
    reportMonthId: '2026-07',
    forecastMonth: 'July 2026',
    reportMonth: 'July 2026',
    releaseCode: 'Jul 26',
    targetStrikes: [3.3],
  },
  request: {
    cpi: {
      releaseKey: 'KXCPIYOY#2026-07',
      reportMonthId: '2026-07',
      targetStrikes: [3.3],
    },
  },
};

function currentCpiHandler() {
  const layer = router.stack.find((entry) => entry.route?.path === '/cpi/current');
  return layer.route.stack[0].handle;
}

function spxCoverHandler() {
  const layer = router.stack.find((entry) => entry.route?.path === '/spx-close/cover');
  return layer.route.stack[0].handle;
}

function watchlistHandler() {
  const layer = router.stack.find((entry) => entry.route?.path === '/watchlist');
  return layer.route.stack[0].handle;
}

function cpiFinalsHandler() {
  const layer = router.stack.find((entry) => entry.route?.path === '/cpi/finals');
  return layer.route.stack[0].handle;
}

function cpiBenchmarksHandler() {
  const layer = router.stack.find((entry) => entry.route?.path === '/cpi/benchmarks');
  return layer.route.stack[0].handle;
}

function responseMock() {
  return {
    json: jest.fn(),
    set: jest.fn(),
    status: jest.fn().mockReturnThis(),
  };
}

function liveKalshiEvent(overrides = {}) {
  return {
    id: 'kalshi:KXCPIYOY-26JUL-T3.3',
    api_raw_id: 'KXCPIYOY-26JUL-T3.3',
    venue: 'Kalshi',
    source_api: 'kalshi_trade_api_v2',
    releaseKey: CURRENT_RELEASE.releaseKey,
    reportMonthId: '2026-07',
    contract_title: 'Above 3.3%',
    status: 'open',
    yes_bid: 0.31,
    yes_ask: 0.32,
    no_bid: 0.68,
    no_ask: 0.69,
    updated_at: new Date().toISOString(),
    close_time: '2099-08-12T12:29:00Z',
    data_quality_flags: [],
    ...overrides,
  };
}

describe('GET /prediction-markets/watchlist on-demand refresh', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getPredictionMarketWatchlist.mockResolvedValue({
      ok: true,
      rows: [],
      refreshEvidence: { mode: 'on_demand_prediction_fanout' },
    });
  });

  test('forces direct venue and missing-only IBKR retries only when requested', async () => {
    const forcedResponse = responseMock();
    await watchlistHandler()({ query: { forceRefresh: 'true' } }, forcedResponse);

    expect(getPredictionMarketWatchlist).toHaveBeenLastCalledWith({
      forceRefresh: true,
      retryMissing: true,
    });
    expect(forcedResponse.set).toHaveBeenCalledWith('Cache-Control', 'no-store');

    const regularResponse = responseMock();
    await watchlistHandler()({ query: {} }, regularResponse);
    expect(getPredictionMarketWatchlist).toHaveBeenLastCalledWith({
      forceRefresh: false,
      retryMissing: false,
    });
  });
});

function providerStatus(overrides = {}) {
  return {
    ibkr: {
      status: 'connected_no_contracts',
      gateway: { ok: true },
    },
    forecastex: { status: 'connected_no_contracts' },
    cme: { status: 'connected_no_contracts' },
    kalshi: { status: 'connected_live' },
    ...overrides,
  };
}

describe('GET /prediction-markets/cpi/current read-only live-data contract', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getCurrentCpiRelease.mockResolvedValue(CURRENT_RELEASE);
    releaseKeyForEvent.mockImplementation((event) => event?.releaseKey || null);
    loadOperationalCatalogByRelease.mockResolvedValue([]);
    fetchIBKREvents.mockResolvedValue([]);
    fetchKalshiCpiEvents.mockResolvedValue([]);
    getProviderStatus.mockImplementation(() => providerStatus());
  });

  test('returns a verified-live Kalshi event without persisting the catalog', async () => {
    const liveEvent = liveKalshiEvent();
    fetchKalshiCpiEvents.mockResolvedValue([liveEvent]);
    const res = responseMock();

    await currentCpiHandler()({}, res);

    expect(fetchKalshiCpiEvents).toHaveBeenCalledWith(CURRENT_RELEASE.cpi);
    expect(router._private.eventMatchesRelease(liveEvent, CURRENT_RELEASE)).toBe(true);
    expect(router._private.isLiveTradingEvent(liveEvent)).toBe(true);
    expect(router._private.buildCpiReadiness({
      release: CURRENT_RELEASE,
      events: [liveEvent],
    }).display.ready).toBe(true);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      events: [liveEvent],
      providerEvents: [liveEvent],
      readiness: expect.objectContaining({
        display: expect.objectContaining({
          ready: true,
          venues: ['Kalshi'],
        }),
      }),
    }));
    expect(persistCatalogEvents).not.toHaveBeenCalled();
  });

  test('drops stale and mock provider rows and performs no persistence writes', async () => {
    fetchKalshiCpiEvents.mockResolvedValue([
      liveKalshiEvent({
        updated_at: new Date(Date.now() - (10 * 60 * 1000)).toISOString(),
      }),
      liveKalshiEvent({
        id: 'kalshi:mock',
        api_raw_id: 'mock',
        data_quality_flags: ['mock'],
      }),
    ]);
    const res = responseMock();

    await currentCpiHandler()({}, res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      events: [],
      providerEvents: [],
      dashboardEvents: [],
      readiness: expect.objectContaining({
        display: expect.objectContaining({
          ready: false,
          liveContracts: 0,
        }),
      }),
    }));
    expect(persistCatalogEvents).not.toHaveBeenCalled();
  });

  test('fails closed when providers are offline and performs no persistence writes', async () => {
    const catalogError = Object.assign(new Error('catalog connection unavailable'), {
      code: 'CATALOG_UNAVAILABLE',
    });
    loadOperationalCatalogByRelease.mockRejectedValue(catalogError);
    getProviderStatus.mockImplementation(() => providerStatus({
      ibkr: {
        status: 'catalog_unavailable',
        errorCode: 'CATALOG_UNAVAILABLE',
        gateway: { ok: false },
      },
      kalshi: {
        status: 'error',
        errorCode: 'KALSHI_OFFLINE',
      },
    }));
    const res = responseMock();

    await currentCpiHandler()({}, res);

    expect(fetchIBKREvents).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      events: [],
      providerEvents: [],
      dashboardEvents: [],
      readiness: expect.objectContaining({
        display: expect.objectContaining({
          ready: false,
          liveContracts: 0,
        }),
        ibkrExecution: expect.objectContaining({
          ready: false,
          liveContracts: 0,
          errorCode: 'CATALOG_UNAVAILABLE',
        }),
      }),
    }));
    expect(persistCatalogEvents).not.toHaveBeenCalled();
    expect(setProviderStatus).toHaveBeenCalledWith('ibkr', expect.objectContaining({
      status: 'catalog_unavailable',
      errorCode: 'CATALOG_UNAVAILABLE',
    }));
  });
});

describe('GET /prediction-markets/spx-close/cover', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns the discriminated live cover snapshot unchanged', async () => {
    const payload = {
      ok: true,
      mode: 'live',
      executable: false,
      markets: [{ ticker: 'SPX-1', yesBid: 0.5, yesAsk: 0.52, noBid: 0.48, noAsk: 0.5 }],
    };
    getSpxCoverSnapshot.mockResolvedValue(payload);
    const res = responseMock();

    await spxCoverHandler()({}, res);

    expect(res.set).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(payload);
  });

  test('fails closed with an unavailable cover payload', async () => {
    getSpxCoverSnapshot.mockRejectedValue(Object.assign(new Error('Kalshi unavailable'), { code: 'KALSHI_OFFLINE' }));
    const res = responseMock();

    await spxCoverHandler()({}, res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ mode: 'unavailable', markets: [] }));
  });
});

describe('GET /prediction-markets/cpi/finals', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns official historical CPI finals without exposing a market-data fallback', async () => {
    const payload = {
      ok: true,
      source: 'bls_flat_file',
      finals: [{ id: '2026-06', value: 3.5, source: 'bls_flat_file' }],
    };
    loadOfficialCpiFinals.mockResolvedValue(payload);
    const res = responseMock();

    await cpiFinalsHandler()({}, res);

    expect(res.set).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(payload);
  });

  test('fails closed when the official source is unavailable', async () => {
    loadOfficialCpiFinals.mockRejectedValue(new Error('BLS unavailable'));
    const res = responseMock();

    await cpiFinalsHandler()({}, res);

    expect(res.status).toHaveBeenCalledWith(502);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ok: false, finals: [] }));
  });
});

describe('GET /prediction-markets/cpi/benchmarks', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns independent benchmark source states without caching in the browser', async () => {
    const payload = {
      ok: true,
      period: '2026-07',
      metric: 'headline-cpi-yoy',
      unit: 'percent',
      sources: [
        { id: 'wall-street-consensus', status: 'unavailable', point: null },
        { id: 'cleveland-fed', status: 'available', point: 3.42 },
      ],
    };
    loadCpiBenchmarks.mockResolvedValue(payload);
    const res = responseMock();

    await cpiBenchmarksHandler()({ query: { month: '2026-07' } }, res);

    expect(res.set).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(loadCpiBenchmarks).toHaveBeenCalledWith({
      month: '2026-07',
      includePublicReleaseSetup: true,
    });
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(payload);
  });

  test('rejects an invalid month before calling either provider', async () => {
    const res = responseMock();

    await cpiBenchmarksHandler()({ query: { month: 'July 2026' } }, res);

    expect(loadCpiBenchmarks).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      ok: false,
      code: 'CPI_BENCHMARK_MONTH_INVALID',
      sources: [],
    }));
  });

  test('fails closed with no source values after an unexpected provider error', async () => {
    loadCpiBenchmarks.mockRejectedValue(new Error('benchmark provider failed'));
    const res = responseMock();

    await cpiBenchmarksHandler()({ query: { month: '2026-07' } }, res);

    expect(res.status).toHaveBeenCalledWith(502);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      ok: false,
      period: '2026-07',
      sources: [],
    }));
  });
});
