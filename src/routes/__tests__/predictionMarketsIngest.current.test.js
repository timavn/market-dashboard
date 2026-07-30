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
