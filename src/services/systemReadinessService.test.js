const {
  DEFAULT_SYSTEM_READINESS_CACHE_MS,
  MIN_SYSTEM_READINESS_CACHE_MS,
  createSystemReadinessService,
} = require('./systemReadinessService.cjs');

const START_MS = Date.parse('2026-07-27T18:00:00.000Z');

function createHarness() {
  let currentMs = START_MS;
  const sidecarRequest = jest.fn().mockResolvedValue({});
  const probeLocalUrl = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    observedAt: new Date(START_MS).toISOString(),
  });
  const dynamodb = {
    query: jest.fn(() => ({
      promise: async () => ({ Items: [] }),
    })),
  };
  const readSupervisorProvenance = jest.fn(() => ({
    stateFound: true,
    running: true,
    rootMatches: true,
    commandMatches: true,
    sourceMatches: true,
    bridgeEnabled: false,
    children: {
      bridge: {
        intentionallyDisabled: true,
        discoveryVerified: true,
        status: 'disabled',
        running: false,
      },
    },
  }));
  const service = createSystemReadinessService({
    sidecarRequest,
    getCurrentPredictionMarkets: jest.fn().mockResolvedValue({ events: [] }),
    getDirectorSnapshot: jest.fn().mockResolvedValue({ workers: [], recentRuns: [] }),
    buildWorkflowStatusSnapshot: jest.fn().mockResolvedValue({}),
    getHermesInboxStatus: jest.fn().mockResolvedValue({}),
    buildRtaResponse: jest.fn().mockResolvedValue({}),
    buildEtfResponse: jest.fn().mockResolvedValue({}),
    dynamodb,
    cloudwatch: {},
    listWorkerDefinitions: () => [],
    readServiceHeartbeat: jest.fn().mockResolvedValue({
      available: true,
      found: false,
      heartbeat: null,
    }),
    readLambdaActivity: jest.fn().mockResolvedValue({
      invocations: 0,
      errors: 0,
      maxDurationMs: null,
      timedOut: false,
    }),
    probeLocalUrl,
    readSupervisorProvenance,
    readRuntimeProvenance: () => ({
      rootMatches: true,
      entrypointMatches: true,
      sourceMatches: true,
    }),
    readLaunchAgentProvenance: () => undefined,
    readHostCapacity: () => ({
      available: true,
      freeGiB: 100,
      usedPercent: 70,
      observedAt: new Date(currentMs).toISOString(),
    }),
    readControllerState: () => ({
      available: true,
      mode: 'shadow',
      status: 'running',
      observedAt: new Date(currentMs).toISOString(),
      incidents: [],
      actions: [],
      circuits: [],
      suppressions: [],
    }),
    now: () => new Date(currentMs),
    cacheNow: () => currentMs,
  });

  return {
    service,
    sidecarRequest,
    probeLocalUrl,
    readSupervisorProvenance,
    advance(ms) {
      currentMs += ms;
    },
  };
}

describe('system readiness expensive-collection budget', () => {
  const originalCacheMs = process.env.SYSTEM_READINESS_CACHE_MS;

  beforeEach(() => {
    delete process.env.SYSTEM_READINESS_CACHE_MS;
  });

  afterAll(() => {
    if (originalCacheMs === undefined) {
      delete process.env.SYSTEM_READINESS_CACHE_MS;
    } else {
      process.env.SYSTEM_READINESS_CACHE_MS = originalCacheMs;
    }
  });

  test('reuses one expensive collection for the default five-minute cadence', async () => {
    expect(DEFAULT_SYSTEM_READINESS_CACHE_MS).toBe(5 * 60 * 1000);
    const harness = createHarness();

    const first = await harness.service.collect();
    harness.advance(DEFAULT_SYSTEM_READINESS_CACHE_MS - 1);
    const second = await harness.service.collect();

    expect(second).toBe(first);
    expect(harness.probeLocalUrl).toHaveBeenCalledTimes(1);
  });

  test('throttles public refresh requests and enforces the hard minimum', async () => {
    process.env.SYSTEM_READINESS_CACHE_MS = '1000';
    expect(MIN_SYSTEM_READINESS_CACHE_MS).toBe(5 * 60 * 1000);
    const harness = createHarness();

    const first = await harness.service.collect();
    harness.advance(60_000);
    const requestedRefresh = await harness.service.collect({ refresh: true });

    expect(requestedRefresh).toBe(first);
    expect(harness.probeLocalUrl).toHaveBeenCalledTimes(1);

    harness.advance(MIN_SYSTEM_READINESS_CACHE_MS - 60_000);
    await harness.service.collect({ refresh: true });

    expect(harness.probeLocalUrl).toHaveBeenCalledTimes(2);
  });

  test('allows one explicitly trusted internal verification refresh', async () => {
    const harness = createHarness();

    const initial = await harness.service.collect();
    harness.advance(60_000);
    const verified = await harness.service.collectForVerification();

    expect(verified).not.toBe(initial);
    expect(harness.probeLocalUrl).toHaveBeenCalledTimes(2);

    const publicFollowUp = await harness.service.collect({ refresh: true });
    expect(publicFollowUp).toBe(verified);
    expect(harness.probeLocalUrl).toHaveBeenCalledTimes(2);
  });

  test('charges failed expensive collections against the same request budget', async () => {
    const harness = createHarness();
    const failure = new Error('readiness dependency unavailable');
    harness.readSupervisorProvenance.mockImplementation(() => {
      throw failure;
    });

    await expect(harness.service.collect()).rejects.toBe(failure);
    harness.advance(60_000);
    await expect(harness.service.collect({ refresh: true })).rejects.toBe(failure);

    expect(harness.readSupervisorProvenance).toHaveBeenCalledTimes(1);
  });

  test('evaluates delayed live portfolio evidence at collection completion', async () => {
    const harness = createHarness();
    harness.sidecarRequest.mockImplementation(async (requestPath) => {
      const observedAt = new Date(START_MS).toISOString();
      if (requestPath === '/livez') {
        return {
          ok: true,
          time: observedAt,
          runtime: {
            errorCode: null,
            interpreterInsideWorkspace: true,
            prefixInsideWorkspace: true,
            appInsideWorkspace: true,
            dependenciesInsideWorkspace: true,
          },
        };
      }
      if (requestPath === '/readyz') {
        return {
          ok: true,
          connected: true,
          status: 'ready',
          accounts: ['U1'],
          time: observedAt,
        };
      }
      if (requestPath === '/status') {
        return {
          connected: true,
          status: 'connected',
          accounts: ['U1'],
          time: observedAt,
        };
      }
      if (requestPath === '/portfolio/live-positions') {
        harness.advance(61_000);
        const portfolioObservedAt = new Date(START_MS + 61_000).toISOString();
        return {
          ok: true,
          connected: true,
          status: 'live',
          source: 'ibkr_live_session',
          accounts: ['U1'],
          positions: [],
          socket_verified_at: portfolioObservedAt,
          positions_observed_at: portfolioObservedAt,
          position_source: 'ibkr_req_positions',
          from_cache: false,
          observed_at: portfolioObservedAt,
        };
      }
      return {};
    });

    const report = await harness.service.collect();
    const portfolio = report.groups
      .flatMap((group) => group.checks)
      .find((check) => check.id === 'ibkr.portfolio');

    expect(report.checkedAt).toBe(new Date(START_MS + 61_000).toISOString());
    expect(portfolio).toMatchObject({
      status: 'pass',
      errorCode: null,
      provenance: {
        source: 'ibkr_live_session',
        positionSource: 'ibkr_req_positions',
        fromCache: false,
      },
    });
  });
});
