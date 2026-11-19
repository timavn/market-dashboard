const {
  ANALYST_ACTIVITY_WINDOW_SECONDS,
  DEFAULT_SYSTEM_READINESS_CACHE_MS,
  MIN_SYSTEM_READINESS_CACHE_MS,
  SYSTEM_READINESS_REVALIDATE_GRACE_MS,
  buildSidecarChecks,
  createSystemReadinessService,
} = require('./systemReadinessService.cjs');

const START_MS = Date.parse('2026-07-27T18:00:00.000Z');

function createHarness({ legacyMode = '', readAnalystActivity, readPortfolioCloseBaseline } = {}) {
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
    readAnalystActivity,
    readPortfolioCloseBaseline,
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

describe('live Analyst activity check', () => {
  test('reads live counts on demand without starting or entering the cached collection', async () => {
    const readAnalystActivity = jest.fn()
      .mockResolvedValueOnce({ reviews: 0, turns: 0, windowSeconds: 1800 })
      .mockResolvedValueOnce({ reviews: 1, turns: 1, windowSeconds: 1800 });
    const harness = createHarness({ readAnalystActivity });

    expect(ANALYST_ACTIVITY_WINDOW_SECONDS).toBe(30 * 60);
    expect(await harness.service.collectLiveCheck('analyst.activity')).toMatchObject({
      id: 'analyst.activity',
      status: 'pass',
      errorCode: null,
      summary: 'No Analyst work is in progress.',
      observedAt: new Date(START_MS).toISOString(),
      provenance: { windowSeconds: 1800, reviews: 0, turns: 0 },
    });
    harness.advance(30_000);
    expect(await harness.service.collectLiveCheck('analyst.activity')).toMatchObject({
      status: 'warn',
      errorCode: 'ANALYST_WORK_ACTIVE',
      summary: 'Analyst work is in progress: 1 review run, 1 turn.',
      observedAt: new Date(START_MS + 30_000).toISOString(),
    });
    expect(readAnalystActivity).toHaveBeenNthCalledWith(1, { windowSeconds: 1800 });
    expect(await harness.service.collectLiveCheck('dashboard.ui')).toBeNull();
    expect(harness.probeLocalUrl).not.toHaveBeenCalled();

    const report = await harness.service.collect();
    const checkIds = report.groups.flatMap((group) => group.checks.map((check) => check.id));
    expect(checkIds).not.toContain('analyst.activity');
    expect(readAnalystActivity).toHaveBeenCalledTimes(2);
  });

  test('an unreadable or malformed activity read is unverified, never idle', async () => {
    for (const readAnalystActivity of [
      jest.fn().mockRejectedValue(new Error('Analyst sidecar HTTP 409')),
      jest.fn().mockResolvedValue({ reviews: 0 }),
      jest.fn().mockResolvedValue({ reviews: -1, turns: 0 }),
      jest.fn().mockResolvedValue({ reviews: '0', turns: 0 }),
      undefined,
    ]) {
      const harness = createHarness({ readAnalystActivity });
      const check = await harness.service.collectLiveCheck('analyst.activity');
      expect(check).toMatchObject({
        id: 'analyst.activity',
        status: 'fail',
        errorCode: 'ANALYST_ACTIVITY_UNVERIFIED',
        summary: 'Analyst activity could not be read.',
      });
    }
  });
});

describe('portfolio close baseline check', () => {
  const closeCheck = report => report.groups.find(group => group.id === 'analyst')
    .checks.find(check => check.id === 'analyst.portfolio-close');

  test('passes with the previous session close capture time in Eastern time', async () => {
    const harness = createHarness({ readPortfolioCloseBaseline: jest.fn().mockResolvedValue({
      sessionDate: '2026-07-24', status: 'ready', capturedAt: '2026-07-24T20:30:05Z',
    }) });
    const check = closeCheck(await harness.service.collect());
    expect(check.status).toBe('pass');
    expect(check.blocking).toBe(false);
    expect(check.summary).toBe('Verified holdings captured after the 2026-07-24 close (Jul 24 16:30 ET).');
  });

  test('warns when the previous session has no verified capture or the status is unreadable', async () => {
    for (const [reader, summary] of [
      [jest.fn().mockResolvedValue({ sessionDate: '2026-07-24', status: 'pending', reason: 'not_started' }),
        'No verified holdings capture after the 2026-07-24 close; Since previous close is unavailable.'],
      [jest.fn().mockRejectedValue(new Error('Workspace unavailable')), 'The previous-close capture status could not be read.'],
    ]) {
      const check = closeCheck(await createHarness({ readPortfolioCloseBaseline: reader }).service.collect());
      expect(check.status).toBe('warn');
      expect(check.blocking).toBe(false);
      expect(check.errorCode).toBe('PORTFOLIO_CLOSE_BASELINE_MISSING');
      expect(check.summary).toBe(summary);
      expect(check.recovery.label).toMatch(/connected from 4:05 PM ET \(1:05 PM PT\)/);
    }
  });
});

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
    expect(checkIds).not.toContain('hermes.security');
    expect(report.capabilities.map((capability) => capability.id)).toContain(
      'automation.readiness',
    );
    expect(report.capabilities.map((capability) => capability.id)).not.toContain(
      'automation.hermes',
    );
  });

  test('default readiness does not acquire or report retired legacy worker evidence', async () => {
    const harness = createHarness();
    harness.listWorkerDefinitions.mockImplementation(() => {
      throw new Error('Retired workers must not be queried');
    });
    const report = await harness.service.collect();
    const checkIds = report.groups.flatMap(group => group.checks.map(check => check.id));

    expect(harness.getDirectorSnapshot).not.toHaveBeenCalled();
    expect(harness.listWorkerDefinitions).not.toHaveBeenCalled();
    expect(checkIds).toContain('analyst.runtime');
    expect(checkIds).toContain('gmail.ingestion');
    expect(checkIds).not.toContain('hermes.security');
    expect(checkIds.some(id => id.startsWith('hermes.quant-'))).toBe(false);
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
  test.each([
    [{ reason: 'sidecar_offline', message: 'fetch failed' }, 'IBKR_PORTFOLIO_DELIVERY_UNAVAILABLE'],
    [{ reason: 'sidecar_timeout', message: 'Request timed out' }, 'IBKR_PORTFOLIO_DELIVERY_TIMEOUT'],
    [{ status: 503, message: 'IBKR sidecar HTTP 503' }, 'IBKR_PORTFOLIO_DELIVERY_UNAVAILABLE'],
  ])('keeps failed position delivery unavailable without restarting an independently healthy sidecar: %j', (reason, errorCode) => {
    const now = new Date('2026-10-07T04:32:55.550Z');
    const fulfilled = value => ({ status: 'fulfilled', value });
    const checks = buildSidecarChecks({
      livezResult: fulfilled({ ok: true, time: now.toISOString() }),
      readyzResult: fulfilled({ ok: true, connected: true, accounts: ['U1'] }),
      statusResult: fulfilled({ connected: true, status: 'connected', accounts: ['U1'], time: now.toISOString() }),
      portfolioResult: { status: 'rejected', reason },
      now,
    });

    expect(checks.find(check => check.id === 'ibkr.sidecar').status).toBe('pass');
    expect(checks.find(check => check.id === 'ibkr.gateway').status).toBe('pass');
    expect(checks.find(check => check.id === 'ibkr.portfolio')).toMatchObject({
      status: 'fail', blocking: true, errorCode, lastSuccessAt: null,
      recovery: { kind: 'manual', automatic: false },
    });
  });

  test('retains true offline and broker heartbeat recovery when position delivery also fails', () => {
    const now = new Date('2026-10-07T04:32:55.550Z');
    const checks = buildSidecarChecks({
      livezResult: { status: 'rejected', reason: new Error('Connection refused') },
      readyzResult: { status: 'rejected', reason: { sidecarCode: 'IBKR_GATEWAY_API_UNRESPONSIVE' } },
      statusResult: { status: 'fulfilled', value: { connected: false, status: 'gateway_api_unresponsive',
        error_code: 'IBKR_GATEWAY_API_UNRESPONSIVE' } },
      portfolioResult: { status: 'rejected', reason: { reason: 'sidecar_offline', message: 'fetch failed' } },
      now,
    });

    expect(checks.find(check => check.id === 'ibkr.sidecar')).toMatchObject({
      status: 'fail', errorCode: 'IBKR_SIDECAR_UNREACHABLE',
      // The supervisor restarts it; the controller no longer repeats that repair.
      recovery: { kind: 'manual', automatic: false, command: 'npm run dev:restart -- --detach' },
    });
    const sidecarRecovery = checks.find(check => check.id === 'ibkr.sidecar').recovery;
    expect(sidecarRecovery.label).toMatch(/supervisor restarts the IBKR sidecar by itself/);
    expect(sidecarRecovery.label).toMatch(/more than 10 minutes, restart the dashboard/);
    expect(sidecarRecovery).not.toHaveProperty('actionId');
    expect(checks.find(check => check.id === 'ibkr.portfolio')).toMatchObject({
      status: 'fail', errorCode: 'IBKR_PORTFOLIO_UNAVAILABLE',
    });
  });

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
      recovery: { kind: 'manual', automatic: false },
    });
    // A new sidecar process meets the same silent Gateway, so the guidance is
    // to relaunch the Gateway and no sidecar restart is offered.
    expect(gateway.recovery.label).toMatch(/If this lasts, quit IB Gateway, open it again and sign in/);
    expect(gateway.recovery).not.toHaveProperty('actionId');
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
      recovery: { kind: 'manual', automatic: false, command: 'npm run dev:restart -- --detach' },
    });
    expect(checks[0].recovery).not.toHaveProperty('actionId');
    expect(checks[0].summary).toMatch(/102/);
  });
});
