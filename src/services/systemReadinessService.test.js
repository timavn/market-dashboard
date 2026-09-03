const {
  DEFAULT_SYSTEM_READINESS_CACHE_MS,
  MIN_SYSTEM_READINESS_CACHE_MS,
  SYSTEM_READINESS_REVALIDATE_GRACE_MS,
  buildSidecarChecks,
  createSystemReadinessService,
} = require('./systemReadinessService.cjs');

const START_MS = Date.parse('2026-07-27T18:00:00.000Z');

function createHarness({ legacyMode = 'shadow' } = {}) {
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
      analystSidecar: { pid: 101, running: true, status: 'ready' },
      analystHermes: { pid: 102, running: true, status: 'ready' },
    },
    analystContract: {
      verified: true,
      checkedAt: new Date(START_MS).toISOString(),
      error: null,
    },
  }));
  const getDirectorSnapshot = jest.fn().mockResolvedValue({ workers: [], recentRuns: [] });
  const listWorkerDefinitions = jest.fn(() => []);
  const service = createSystemReadinessService({
    sidecarRequest,
    getCurrentPredictionMarkets: jest.fn().mockResolvedValue({ events: [] }),
    getDirectorSnapshot,
    buildWorkflowStatusSnapshot: jest.fn().mockResolvedValue({}),
    getHermesInboxStatus: jest.fn().mockResolvedValue({}),
    buildRtaResponse: jest.fn().mockResolvedValue({}),
    buildEtfResponse: jest.fn().mockResolvedValue({}),
    dynamodb,
    cloudwatch: {},
    listWorkerDefinitions,
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
    legacyMode,
  });

  return {
    service,
    sidecarRequest,
    probeLocalUrl,
    readSupervisorProvenance,
    getDirectorSnapshot,
    listWorkerDefinitions,
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

  test('read-only consolidation omits every retired worker and bridge check', async () => {
    const harness = createHarness({ legacyMode: 'read-only' });

    const report = await harness.service.collect();
    const checkIds = report.groups.flatMap((group) => group.checks.map((check) => check.id));

    expect(harness.getDirectorSnapshot).not.toHaveBeenCalled();
    expect(harness.listWorkerDefinitions).not.toHaveBeenCalled();
    expect(checkIds).toContain('analyst.runtime');
    expect(checkIds).toContain('readiness.controller');
    expect(checkIds).not.toContain('dashboard.hermes-bridge');
    expect(checkIds).not.toContain('hermes.status');
    expect(checkIds.some((id) => id.startsWith('hermes.quant-'))).toBe(false);
    expect(report.capabilities.map((capability) => capability.id)).toContain(
      'automation.readiness',
    );
    expect(report.capabilities.map((capability) => capability.id)).not.toContain(
      'automation.hermes',
    );
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

  test('returns still-valid cached evidence while one background refresh runs', async () => {
    const harness = createHarness();
    const first = await harness.service.collect();
    let finishRefresh;
    harness.probeLocalUrl.mockImplementationOnce(() => new Promise((resolve) => {
      finishRefresh = resolve;
    }));

    harness.advance(DEFAULT_SYSTEM_READINESS_CACHE_MS + 1);
    const duringRefresh = await harness.service.collect();

    expect(duringRefresh).toBe(first);
    expect(harness.probeLocalUrl).toHaveBeenCalledTimes(2);
    expect(SYSTEM_READINESS_REVALIDATE_GRACE_MS).toBeLessThan(60_000);

    finishRefresh({
      ok: true,
      status: 200,
      observedAt: new Date(START_MS).toISOString(),
    });
    await new Promise(resolve => setTimeout(resolve, 0));
  });

  test('fails closed as soon as a background refresh failure is known', async () => {
    const harness = createHarness();
    const first = await harness.service.collect();
    const failure = new Error('readiness dependency unavailable');
    harness.readSupervisorProvenance.mockImplementationOnce(() => {
      throw failure;
    });

    harness.advance(DEFAULT_SYSTEM_READINESS_CACHE_MS + 1);
    await expect(harness.service.collect()).resolves.toBe(first);
    await new Promise(resolve => setTimeout(resolve, 0));

    await expect(harness.service.collect()).rejects.toBe(failure);
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

describe('IBKR sidecar process readiness', () => {
  test('reports partial account coverage when Gateway omits an expected Roth account', () => {
    const now = new Date('2026-09-02T22:20:00.000Z');
    const fulfilled = (value) => ({ status: 'fulfilled', value });
    const checks = buildSidecarChecks({
      livezResult: fulfilled({
        ok: true,
        time: now.toISOString(),
        runtime: {
          errorCode: null,
          interpreterInsideWorkspace: true,
          prefixInsideWorkspace: true,
          appInsideWorkspace: true,
          dependenciesInsideWorkspace: true,
        },
      }),
      readyzResult: fulfilled({ ok: true, connected: true, status: 'ready', accounts: ['U25779973'] }),
      statusResult: fulfilled({
        connected: true,
        status: 'connected',
        accounts: ['U25779973'],
        time: now.toISOString(),
      }),
      portfolioResult: fulfilled({}),
      expectedAccounts: ['U25779973', 'U25465536'],
      now,
    });

    expect(checks.find((check) => check.id === 'ibkr.accounts')).toMatchObject({
      status: 'warn',
      blocking: true,
      errorCode: 'IBKR_PARTIAL_ACCOUNT_COVERAGE',
      accountCoverageStatus: 'partial_account_coverage',
      summary: 'Gateway has partial account coverage (1 of 2 expected).',
      detail: 'Connected: U25779973. Missing live: U25465536.',
    });
  });

  test('reports partial account coverage when a connected Gateway omits every expected account', () => {
    const now = new Date('2026-09-02T22:20:00.000Z');
    const fulfilled = (value) => ({ status: 'fulfilled', value });
    const checks = buildSidecarChecks({
      livezResult: fulfilled({
        ok: true,
        time: now.toISOString(),
        runtime: {
          errorCode: null,
          interpreterInsideWorkspace: true,
          prefixInsideWorkspace: true,
          appInsideWorkspace: true,
          dependenciesInsideWorkspace: true,
        },
      }),
      readyzResult: fulfilled({ ok: true, connected: true, status: 'ready', accounts: [] }),
      statusResult: fulfilled({
        connected: true,
        status: 'connected',
        accounts: [],
        time: now.toISOString(),
      }),
      portfolioResult: fulfilled({}),
      expectedAccounts: ['U25779973', 'U25465536'],
      now,
    });

    expect(checks.find((check) => check.id === 'ibkr.accounts')).toMatchObject({
      status: 'warn',
      errorCode: 'IBKR_PARTIAL_ACCOUNT_COVERAGE',
      accountCoverageStatus: 'partial_account_coverage',
      summary: 'Gateway has partial account coverage (0 of 2 expected).',
      detail: 'Connected: none. Missing live: U25779973, U25465536.',
    });
  });

  test('preserves the typed live-portfolio failure from the sidecar', () => {
    const now = new Date('2026-08-03T22:00:00.000Z');
    const fulfilled = (value) => ({ status: 'fulfilled', value });
    const checks = buildSidecarChecks({
      livezResult: fulfilled({
        ok: true,
        time: now.toISOString(),
        runtime: {
          errorCode: null,
          interpreterInsideWorkspace: true,
          prefixInsideWorkspace: true,
          appInsideWorkspace: true,
          dependenciesInsideWorkspace: true,
        },
      }),
      readyzResult: fulfilled({ ok: true, connected: true, status: 'ready' }),
      statusResult: fulfilled({ connected: true, status: 'connected' }),
      portfolioResult: {
        status: 'rejected',
        reason: {
          sidecarCode: 'IBKR_POSITIONS_REQUEST_TIMEOUT',
          message: 'IBKR sidecar HTTP 503',
        },
      },
      now,
    });

    const portfolio = checks.find((check) => check.id === 'ibkr.portfolio');
    expect(portfolio).toMatchObject({
      status: 'fail',
      errorCode: 'IBKR_POSITIONS_REQUEST_TIMEOUT',
      recovery: {
        automatic: true,
        actionId: 'restart-ibkr-sidecar',
      },
    });
  });

  test('treats a failed API heartbeat as the canonical Gateway root cause', () => {
    const now = new Date('2026-08-03T22:00:00.000Z');
    const fulfilled = (value) => ({ status: 'fulfilled', value });
    const checks = buildSidecarChecks({
      livezResult: fulfilled({
        ok: true,
        time: now.toISOString(),
        runtime: {
          errorCode: null,
          interpreterInsideWorkspace: true,
          prefixInsideWorkspace: true,
          appInsideWorkspace: true,
          dependenciesInsideWorkspace: true,
        },
      }),
      readyzResult: {
        status: 'rejected',
        reason: { sidecarCode: 'IBKR_GATEWAY_API_UNRESPONSIVE' },
      },
      statusResult: fulfilled({
        connected: false,
        status: 'gateway_api_unresponsive',
        error_code: 'IBKR_GATEWAY_API_UNRESPONSIVE',
        message: 'Heartbeat timed out.',
      }),
      portfolioResult: fulfilled({}),
      now,
    });

    const gateway = checks.find((check) => check.id === 'ibkr.gateway');
    expect(gateway).toMatchObject({
      status: 'fail',
      errorCode: 'IBKR_GATEWAY_API_UNRESPONSIVE',
      recovery: {
        automatic: true,
        actionId: 'restart-ibkr-sidecar',
        command: 'npm run dev:sidecar:restart',
      },
    });
  });

  test('fails closed with an exact duplicate-process error', () => {
    const now = new Date('2026-08-03T22:00:00.000Z');
    const fulfilled = (value) => ({ status: 'fulfilled', value });
    const checks = buildSidecarChecks({
      livezResult: fulfilled({
        ok: true,
        time: now.toISOString(),
        runtime: {
          errorCode: null,
          interpreterInsideWorkspace: true,
          prefixInsideWorkspace: true,
          appInsideWorkspace: true,
          dependenciesInsideWorkspace: true,
        },
      }),
      readyzResult: fulfilled({ ok: true, connected: true, status: 'ready' }),
      statusResult: fulfilled({ connected: true, status: 'connected' }),
      portfolioResult: fulfilled({}),
      supervisor: {
        children: {
          sidecar: {
            sidecarProcessPids: [101, 102],
            managedSidecarProcessPids: [101, 102],
            duplicatePids: [102],
            duplicateCount: 1,
            sidecarProcessCleanup: {
              verified: true,
              clean: false,
              errorCode: 'IBKR_SIDECAR_DUPLICATES',
              detail: 'Repo-owned sidecar processes remain after cleanup: 102.',
            },
          },
        },
      },
      now,
    });

    expect(checks[0]).toMatchObject({
      id: 'ibkr.sidecar',
      status: 'fail',
      errorCode: 'IBKR_SIDECAR_DUPLICATES',
      recovery: { command: 'npm run dev:sidecar:restart' },
    });
    expect(checks[0].summary).toMatch(/102/);
  });
});
