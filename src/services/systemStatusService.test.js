const {
  collectAutomationHeartbeatEvidence,
  createSystemStatusService,
  createUnavailableSystemStatus,
  evaluateAutomationEvidence,
  evaluateDashboardEvidence,
  evaluateLivePortfolioEvidence,
  evaluateMarketDataEvidence,
} = require('./systemStatusService.cjs');

const NOW = new Date('2026-07-29T15:00:00.000Z');

function freshHeartbeatRecord({
  serviceId,
  label,
  scheduleId,
  maxAgeMinutes = 45,
} = {}) {
  return {
    serviceId,
    label,
    scheduleId,
    maxAgeMinutes,
    store: {
      available: true,
      found: true,
      heartbeat: {
        serviceId,
        status: 'success',
        source: 'aws-lambda',
        triggerSource: 'aws-scheduler',
        scheduled: true,
        scheduleId,
        finishedAt: new Date(NOW.getTime() - 60_000).toISOString(),
      },
    },
  };
}

function freshAutomationEvidence() {
  return {
    records: [
      freshHeartbeatRecord({
        serviceId: 'hermes:quant-analyst',
        label: 'Hermes Quant Analyst',
        scheduleId: 'hermes-analyst-schedule',
      }),
      freshHeartbeatRecord({
        serviceId: 'hermes:quant-developer',
        label: 'Hermes Quant Developer',
        scheduleId: 'hermes-developer-schedule',
      }),
      freshHeartbeatRecord({
        serviceId: 'hermes:security',
        label: 'Hermes Security',
        scheduleId: 'hermes-security-schedule',
        maxAgeMinutes: 120,
      }),
      freshHeartbeatRecord({
        serviceId: 'gmail:dashboard@example.com',
        label: 'Gmail ingestion',
        scheduleId: 'gmail-schedule',
      }),
    ],
  };
}

function createOnlineService(overrides = {}) {
  return createSystemStatusService({
    readDashboardEvidence: async () => ({
      apiAvailable: true,
      uiAvailable: true,
      uiVerified: true,
    }),
    readMarketDataEvidence: async () => ({
      verified: true,
      available: true,
      observedAt: new Date(NOW.getTime() - 5_000).toISOString(),
    }),
    readLivePortfolioEvidence: async () => ({
      connected: true,
      status: 'connected',
      account_discovery_ok: true,
      accounts: ['U123'],
      time: new Date(NOW.getTime() - 1_000).toISOString(),
    }),
    readAutomationEvidence: async () => freshAutomationEvidence(),
    now: () => NOW,
    ...overrides,
  });
}

describe('lightweight system status service', () => {
  test('returns only the compact allowlisted response shape', async () => {
    const report = await createOnlineService().collect();

    expect(Object.keys(report)).toEqual(['checkedAt', 'overall', 'services']);
    expect(report.checkedAt).toBe(NOW.toISOString());
    expect(report.overall).toBe('online');
    expect(report.services.map(({ id, label, status }) => ({ id, label, status }))).toEqual([
      { id: 'dashboard', label: 'Dashboard', status: 'online' },
      { id: 'market-data', label: 'Market data', status: 'online' },
      { id: 'live-portfolio', label: 'Live portfolio', status: 'online' },
      { id: 'hermes-gmail', label: 'Hermes / Gmail', status: 'online' },
    ]);
    expect(report.services.map((service) => ({
      id: service.id,
      details: service.details.map((detail) => detail.id),
    }))).toEqual([
      { id: 'dashboard', details: ['api-server', 'react-ui'] },
      { id: 'market-data', details: ['primary-provider', 'fresh-quote'] },
      {
        id: 'live-portfolio',
        details: ['ibkr-sidecar', 'gateway-session', 'managed-account', 'fresh-session'],
      },
      {
        id: 'hermes-gmail',
        details: [
          'hermes-analyst',
          'hermes-developer',
          'hermes-security',
          'gmail-ingestion',
        ],
      },
    ]);
    expect(report.services.every((service) => (
      service.details.every((detail) => (
        detail.status === 'online' && !Object.hasOwn(detail, 'details')
      ))
    ))).toBe(true);
    expect(JSON.stringify(report)).not.toMatch(
      /checks|groups|history|repair|credential|matrix|rootCause/i,
    );
  });

  test('isolates a timed-out check without delaying or erasing other results', async () => {
    const never = new Promise(() => {});
    const service = createOnlineService({
      readMarketDataEvidence: () => never,
      probeTimeoutMs: 20,
    });
    const startedAt = Date.now();

    const report = await service.collect();

    expect(Date.now() - startedAt).toBeLessThan(250);
    expect(report.services.map(({ id, label, status, reason }) => ({
      id,
      label,
      status,
      ...(reason ? { reason } : {}),
    }))).toEqual([
      { id: 'dashboard', label: 'Dashboard', status: 'online' },
      {
        id: 'market-data',
        label: 'Market data',
        status: 'unknown',
        reason: 'Market-data check timed out.',
      },
      { id: 'live-portfolio', label: 'Live portfolio', status: 'online' },
      { id: 'hermes-gmail', label: 'Hermes / Gmail', status: 'online' },
    ]);
    expect(report.services[1].details.every((detail) => detail.status === 'unknown')).toBe(true);
    expect(report.overall).toBe('unknown');
  });

  test('checks API and UI independently and reserves overall offline for dashboard failure', async () => {
    expect(evaluateDashboardEvidence({
      apiAvailable: true,
      uiAvailable: false,
      uiVerified: true,
    })).toMatchObject({
      status: 'offline',
      reason: 'Dashboard UI is unavailable.',
    });
    expect(evaluateDashboardEvidence({
      apiAvailable: true,
      uiAvailable: null,
      uiVerified: false,
    })).toMatchObject({
      status: 'unknown',
      reason: 'Dashboard UI availability is unverified.',
    });

    const offline = await createOnlineService({
      readDashboardEvidence: async () => ({
        apiAvailable: true,
        uiAvailable: false,
        uiVerified: true,
      }),
    }).collect();
    expect(offline.overall).toBe('offline');

    const unknown = await createOnlineService({
      readDashboardEvidence: async () => {
        throw new Error('UI check unavailable');
      },
    }).collect();
    expect(unknown.overall).toBe('unknown');
  });

  test('bounds a slow dashboard check without delaying the other services', async () => {
    const never = new Promise(() => {});
    const report = await createOnlineService({
      readDashboardEvidence: () => never,
      probeTimeoutMs: 20,
    }).collect();

    expect(report.overall).toBe('unknown');
    expect(report.services.map(({ id, label, status, reason }) => ({
      id,
      label,
      status,
      ...(reason ? { reason } : {}),
    }))).toEqual([
      {
        id: 'dashboard',
        label: 'Dashboard',
        status: 'unknown',
        reason: 'Dashboard check timed out.',
      },
      { id: 'market-data', label: 'Market data', status: 'online' },
      { id: 'live-portfolio', label: 'Live portfolio', status: 'online' },
      { id: 'hermes-gmail', label: 'Hermes / Gmail', status: 'online' },
    ]);
    expect(report.services[0].details.every((detail) => detail.status === 'unknown')).toBe(true);
  });

  test('uses an all-unknown response when collection itself is unavailable', () => {
    const report = createUnavailableSystemStatus({ now: NOW });

    expect(report.overall).toBe('unknown');
    expect(report.services).toHaveLength(4);
    expect(report.services.every((service) => service.status === 'unknown')).toBe(true);
    expect(report.services.every((service) => (
      service.details.length > 0
      && service.details.every((detail) => detail.status === 'unknown')
    ))).toBe(true);
  });

  test('maps AWS heartbeat access failures to precise unknown reasons', async () => {
    const accessDenied = freshAutomationEvidence();
    accessDenied.records[0].store = {
      available: false,
      found: false,
      errorCode: 'SERVICE_HEARTBEAT_ACCESS_DENIED',
      error: 'not authorized',
    };

    expect(evaluateAutomationEvidence(accessDenied, { now: NOW })).toMatchObject({
      status: 'unknown',
      reason: 'AWS heartbeat access is denied.',
    });

    const expiredSession = freshAutomationEvidence();
    expiredSession.records[1].store = {
      available: false,
      found: false,
      errorCode: 'ExpiredTokenException',
      error: 'The security token included in the request is expired',
    };
    expect(evaluateAutomationEvidence(expiredSession, { now: NOW })).toMatchObject({
      status: 'unknown',
      reason: 'AWS session expired.',
      details: expect.arrayContaining([
        expect.objectContaining({
          id: 'hermes-developer',
          status: 'unknown',
          reason: 'AWS session expired.',
        }),
      ]),
    });

    const missingCredentials = freshAutomationEvidence();
    missingCredentials.records[2].store = {
      available: false,
      found: false,
      errorCode: 'CredentialsError',
      error: 'Missing credentials in config',
    };
    expect(evaluateAutomationEvidence(missingCredentials, { now: NOW })).toMatchObject({
      status: 'unknown',
      reason: 'AWS credentials are unavailable.',
    });

    await expect(createOnlineService({
      readAutomationEvidence: async () => {
        throw new Error('AWS credentials unavailable');
      },
    }).collect()).resolves.toMatchObject({
      overall: 'unknown',
      services: expect.arrayContaining([
        expect.objectContaining({ id: 'hermes-gmail', status: 'unknown' }),
      ]),
    });
  });

  test('collects all automation heartbeats independently without an S3 validation prerequisite', async () => {
    const source = freshAutomationEvidence();
    const stores = new Map(source.records.map((record) => [record.serviceId, record.store]));
    const readHeartbeat = jest.fn(async (serviceId) => {
      if (serviceId === 'hermes:quant-developer') {
        const error = new Error('The security token included in the request is expired');
        error.code = 'ExpiredTokenException';
        throw error;
      }
      return stores.get(serviceId);
    });

    const evidence = await collectAutomationHeartbeatEvidence({
      records: source.records.map(({ store: _store, ...record }) => record),
      readHeartbeat,
    });

    expect(readHeartbeat).toHaveBeenCalledTimes(4);
    expect(readHeartbeat.mock.calls.map(([serviceId]) => serviceId)).toEqual(
      source.records.map((record) => record.serviceId),
    );
    expect(evidence.records[0].store.available).toBe(true);
    expect(evidence.records[1].store).toMatchObject({
      available: false,
      found: false,
      errorCode: 'ExpiredTokenException',
    });
    expect(evidence.records[2].store.available).toBe(true);
    expect(evidence.records[3].store.available).toBe(true);
    expect(evaluateAutomationEvidence(evidence, { now: NOW })).toMatchObject({
      status: 'unknown',
      reason: 'AWS session expired.',
    });
  });

  test('isolates a timed-out heartbeat without erasing completed heartbeat results', async () => {
    const source = freshAutomationEvidence();
    const stores = new Map(source.records.map((record) => [record.serviceId, record.store]));
    const never = new Promise(() => {});
    const startedAt = Date.now();

    const evidence = await collectAutomationHeartbeatEvidence({
      records: source.records.map(({ store: _store, ...record }) => record),
      readHeartbeat: (serviceId) => (
        serviceId === 'hermes:security' ? never : stores.get(serviceId)
      ),
      timeoutMs: 20,
    });
    const result = evaluateAutomationEvidence(evidence, { now: NOW });

    expect(Date.now() - startedAt).toBeLessThan(250);
    expect(result).toMatchObject({
      status: 'unknown',
      reason: 'AWS heartbeat query timed out.',
      details: [
        { id: 'hermes-analyst', status: 'online' },
        { id: 'hermes-developer', status: 'online' },
        {
          id: 'hermes-security',
          status: 'unknown',
          reason: 'AWS heartbeat query timed out.',
        },
        { id: 'gmail-ingestion', status: 'online' },
      ],
    });
  });

  test('requires fresh, verified provider evidence for market data', () => {
    expect(evaluateMarketDataEvidence({
      verified: false,
      available: true,
      observedAt: NOW.toISOString(),
      source: 'cache',
    }, { now: NOW })).toMatchObject({
      status: 'unknown',
      reason: 'Fresh market-data evidence is unavailable.',
    });
    expect(evaluateMarketDataEvidence({
      verified: true,
      available: true,
      observedAt: new Date(NOW.getTime() - 120_000).toISOString(),
    }, { now: NOW })).toMatchObject({
      status: 'unknown',
      reason: 'Fresh market-data evidence is unavailable.',
    });
  });

  test('never treats stale positions as proof of a live portfolio session', () => {
    expect(evaluateLivePortfolioEvidence({
      connected: false,
      status: 'disconnected',
      accounts: [],
      positions: [{ symbol: 'SPY' }],
      observedAt: NOW.toISOString(),
    }, { now: NOW })).toMatchObject({
      status: 'offline',
      reason: 'IB Gateway is disconnected.',
    });
    expect(evaluateLivePortfolioEvidence({
      connected: true,
      status: 'connected',
      accounts: ['U123'],
      time: new Date(NOW.getTime() - 60_000).toISOString(),
      positions: [{ symbol: 'SPY' }],
    }, { now: NOW })).toMatchObject({
      status: 'unknown',
      reason: 'Fresh portfolio connectivity evidence is unavailable.',
    });
  });

  test('marks a fresh, schedule-proven failed heartbeat offline', () => {
    const evidence = freshAutomationEvidence();
    evidence.records[1].store.heartbeat.status = 'error';
    evidence.records[1].store.heartbeat.errorCode = 'WORKER_FAILED';

    expect(evaluateAutomationEvidence(evidence, { now: NOW })).toMatchObject({
      status: 'offline',
      reason: 'Hermes Quant Developer reported WORKER_FAILED.',
      details: expect.arrayContaining([
        expect.objectContaining({
          id: 'hermes-developer',
          status: 'offline',
          reason: 'Hermes Quant Developer reported WORKER_FAILED.',
        }),
      ]),
    });
  });

  test('shows a fresh completed Hermes warning run as attention', () => {
    const evidence = freshAutomationEvidence();
    evidence.records[1].store.heartbeat.status = 'warning';
    evidence.records[1].store.heartbeat.errorCode = 'SYSTEM_CAPABILITIES_DEGRADED';

    expect(evaluateAutomationEvidence(evidence, { now: NOW })).toMatchObject({
      status: 'attention',
      details: expect.arrayContaining([
        expect.objectContaining({
          id: 'hermes-developer',
          status: 'attention',
        }),
      ]),
    });
  });

  test('shows a dependency-blocked Hermes analyst as attention instead of offline', () => {
    const evidence = freshAutomationEvidence();
    evidence.records[0].store.heartbeat.status = 'blocked';
    evidence.records[0].store.heartbeat.errorCode = 'IBKR_GATEWAY_NOT_AUTHENTICATED';
    evidence.records[0].store.heartbeat.blockedBy = 'portfolio.live';

    expect(evaluateAutomationEvidence(evidence, { now: NOW })).toMatchObject({
      status: 'attention',
      reason: 'Hermes Quant Analyst reported IBKR_GATEWAY_NOT_AUTHENTICATED.',
      details: expect.arrayContaining([
        expect.objectContaining({
          id: 'hermes-analyst',
          status: 'attention',
        }),
      ]),
    });
  });

  test('keeps a fresh typed Gmail authentication heartbeat offline', () => {
    const evidence = freshAutomationEvidence();
    evidence.records[3].store.heartbeat.status = 'auth_required';
    evidence.records[3].store.heartbeat.errorCode = 'GMAIL_AUTH_REQUIRED';

    expect(evaluateAutomationEvidence(evidence, { now: NOW })).toMatchObject({
      status: 'offline',
      reason: 'Gmail ingestion reported GMAIL_AUTH_REQUIRED.',
      details: expect.arrayContaining([
        expect.objectContaining({
          id: 'gmail-ingestion',
          status: 'offline',
          reason: 'Gmail ingestion reported GMAIL_AUTH_REQUIRED.',
        }),
      ]),
    });
  });
});
