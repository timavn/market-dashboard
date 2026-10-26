const {
  collectScheduledHeartbeatEvidence,
  createSystemStatusService,
  createUnavailableSystemStatus,
  evaluateAiEvidence,
  evaluateAnalystRuntimeEvidence,
  evaluateDashboardEvidence,
  evaluateGmailHeartbeatEvidence,
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

function freshGmailEvidence() {
  return {
    records: [
      freshHeartbeatRecord({
        serviceId: 'gmail:dashboard@example.com',
        label: 'Gmail Function',
        scheduleId: 'gmail-schedule',
      }),
    ],
  };
}

function freshAnalystEvidence(overrides = {}) {
  return {
    id: 'analyst.runtime',
    label: 'The Analyst runtime',
    status: 'pass',
    summary: 'The Analyst runtime is verified.',
    observedAt: new Date(NOW.getTime() - 60_000).toISOString(),
    ...overrides,
  };
}

function freshAiEvidence(overrides = {}) {
  return {
    analyst: freshAnalystEvidence(),
    gmail: freshGmailEvidence(),
    ...overrides,
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
    readAiEvidence: async () => freshAiEvidence(),
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
      { id: 'live-portfolio', label: 'Portfolio', status: 'online' },
      { id: 'ai', label: 'AI', status: 'online' },
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
        id: 'ai',
        details: ['analyst-runtime', 'gmail-ingestion'],
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

  test('exposes the same AI surface regardless of the legacy compatibility mode', async () => {
    const report = await createOnlineService({
      legacyMode: 'read-only',
    }).collect();

    const ai = report.services.find((service) => service.id === 'ai');
    expect(ai).toMatchObject({ id: 'ai', label: 'AI', status: 'online' });
    expect(ai.details.map((detail) => detail.id)).toEqual([
      'analyst-runtime',
      'gmail-ingestion',
    ]);
    expect(JSON.stringify(report)).not.toMatch(
      /hermes-gmail|quant-analyst|quant-developer|hermes-security|research-ingestion/i,
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
      { id: 'live-portfolio', label: 'Portfolio', status: 'online' },
      { id: 'ai', label: 'AI', status: 'online' },
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
      { id: 'live-portfolio', label: 'Portfolio', status: 'online' },
      { id: 'ai', label: 'AI', status: 'online' },
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
    const accessDenied = freshAiEvidence();
    accessDenied.gmail.records[0].store = {
      available: false,
      found: false,
      errorCode: 'SERVICE_HEARTBEAT_ACCESS_DENIED',
      error: 'not authorized',
    };

    expect(evaluateAiEvidence(accessDenied, { now: NOW })).toMatchObject({
      status: 'unknown',
      reason: 'AWS heartbeat access is denied.',
    });

    const expiredSession = freshAiEvidence();
    expiredSession.gmail.records[0].store = {
      available: false,
      found: false,
      errorCode: 'ExpiredTokenException',
      error: 'The security token included in the request is expired',
    };
    expect(evaluateAiEvidence(expiredSession, { now: NOW })).toMatchObject({
      status: 'unknown',
      reason: 'AWS session expired.',
      details: expect.arrayContaining([
        expect.objectContaining({
          id: 'gmail-ingestion',
          status: 'unknown',
          reason: 'AWS session expired.',
        }),
      ]),
    });

    const missingCredentials = freshAiEvidence();
    missingCredentials.gmail.records[0].store = {
      available: false,
      found: false,
      errorCode: 'CredentialsError',
      error: 'Missing credentials in config',
    };
    expect(evaluateAiEvidence(missingCredentials, { now: NOW })).toMatchObject({
      status: 'unknown',
      reason: 'AWS credentials are unavailable.',
    });

    await expect(createOnlineService({
      readAiEvidence: async () => {
        throw new Error('AWS credentials unavailable');
      },
    }).collect()).resolves.toMatchObject({
      overall: 'unknown',
      services: expect.arrayContaining([
        expect.objectContaining({ id: 'ai', status: 'unknown' }),
      ]),
    });
  });

  test('collects the Gmail heartbeat without an S3 validation prerequisite', async () => {
    const source = freshGmailEvidence();
    const stores = new Map(source.records.map((record) => [record.serviceId, record.store]));
    const readHeartbeat = jest.fn(async (serviceId) => stores.get(serviceId));

    const evidence = await collectScheduledHeartbeatEvidence({
      records: source.records.map(({ store: _store, ...record }) => record),
      readHeartbeat,
    });

    expect(readHeartbeat).toHaveBeenCalledTimes(1);
    expect(readHeartbeat.mock.calls.map(([serviceId]) => serviceId)).toEqual(
      source.records.map((record) => record.serviceId),
    );
    expect(evidence.records[0].store.available).toBe(true);
    expect(evaluateGmailHeartbeatEvidence(evidence, { now: NOW }))
      .toMatchObject({ id: 'gmail-ingestion', status: 'online' });
  });

  test('fails the Gmail heartbeat closed when its authoritative read times out', async () => {
    const source = freshGmailEvidence();
    const never = new Promise(() => {});
    const startedAt = Date.now();

    const evidence = await collectScheduledHeartbeatEvidence({
      records: source.records.map(({ store: _store, ...record }) => record),
      readHeartbeat: () => never,
      timeoutMs: 20,
    });
    const result = evaluateGmailHeartbeatEvidence(evidence, { now: NOW });

    expect(Date.now() - startedAt).toBeLessThan(250);
    expect(result).toMatchObject({
      id: 'gmail-ingestion',
      status: 'unknown',
      reason: 'AWS heartbeat query timed out.',
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

  test('reports delayed fallback data as attention instead of unknown or live online', () => {
    expect(evaluateMarketDataEvidence({
      verified: true,
      available: true,
      availability: 'delayed',
      source: 'yahoo',
      observedAt: new Date(NOW.getTime() - 5_000).toISOString(),
    }, { now: NOW })).toMatchObject({
      status: 'attention',
      reason: 'Only delayed provider data is available; current live quotes are unavailable.',
      details: [
        { id: 'primary-provider', status: 'attention' },
        { id: 'fresh-quote', status: 'attention' },
      ],
    });
  });

  test('reports mixed live IBKR and delayed Yahoo coverage without claiming live quotes are unavailable', () => {
    const mixedReason = 'Live IBKR quotes are available; some requested instruments are using delayed Yahoo data.';
    expect(evaluateMarketDataEvidence({
      verified: true,
      available: true,
      availability: 'mixed',
      source: 'ibkr+yahoo',
      observedAt: NOW.toISOString(),
      currentObservedAt: NOW.toISOString(),
      delayedObservedAt: new Date(NOW.getTime() - 5_000).toISOString(),
      reason: mixedReason,
    }, { now: NOW })).toMatchObject({
      status: 'attention',
      reason: mixedReason,
      details: [
        { id: 'primary-provider', status: 'online' },
        { id: 'fresh-quote', status: 'attention', reason: mixedReason },
      ],
    });
  });

  test('reports a verified prior close as Closed while the US market is shut', () => {
    const closedNow = new Date('2026-08-02T18:00:00.000Z');
    const priorClose = '2026-07-31T20:00:00.000Z';

    expect(evaluateMarketDataEvidence({
      verified: true,
      available: true,
      availability: 'delayed',
      source: 'yahoo',
      observedAt: closedNow.toISOString(),
    }, { now: closedNow })).toMatchObject({
      status: 'closed',
      reason: 'The market is closed; the most recent completed close is shown.',
      details: [
        { id: 'primary-provider', status: 'closed' },
        { id: 'fresh-quote', status: 'closed' },
      ],
    });

    expect(evaluateMarketDataEvidence({
      verified: true,
      available: false,
      source: 'yahoo',
      observedAt: priorClose,
    }, { now: closedNow })).toMatchObject({ status: 'closed' });
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
      time: new Date(NOW.getTime() - 120_001).toISOString(),
      positions: [{ symbol: 'SPY' }],
    }, { now: NOW })).toMatchObject({
      status: 'unknown',
      reason: 'Fresh portfolio connectivity evidence is unavailable.',
    });
  });

  test('keeps verified portfolio evidence online through the two-minute freshness boundary', () => {
    const evidence = (ageMs) => ({
      connected: true,
      status: 'connected',
      accounts: ['U123'],
      account_discovery_ok: true,
      portfolio_verified: true,
      portfolio_status: 'ready',
      portfolio_observed_at: new Date(NOW.getTime() - ageMs).toISOString(),
    });

    [50_000, 120_000].forEach((ageMs) => {
      expect(evaluateLivePortfolioEvidence(evidence(ageMs), { now: NOW })).toMatchObject({
        status: 'online',
        details: expect.arrayContaining([
          expect.objectContaining({ id: 'fresh-session', status: 'online' }),
        ]),
      });
    });

    const stale = evaluateLivePortfolioEvidence(evidence(120_001), { now: NOW });
    expect(stale).toMatchObject({
      status: 'attention',
      reason: 'The last verified live portfolio snapshot is 121s old; the freshness limit is 120s.',
      details: expect.arrayContaining([
        expect.objectContaining({
          id: 'fresh-session',
          status: 'attention',
          reason: 'The last verified live portfolio snapshot is 121s old; the freshness limit is 120s.',
        }),
      ]),
    });
  });

  test('reports failed portfolio verification immediately even inside the age window', () => {
    expect(evaluateLivePortfolioEvidence({
      connected: true,
      status: 'connected',
      accounts: ['U123'],
      account_discovery_ok: true,
      portfolio_verified: false,
      portfolio_status: 'snapshot_failed',
      portfolio_message: 'The live position snapshot failed verification.',
      portfolio_observed_at: NOW.toISOString(),
    }, { now: NOW })).toMatchObject({
      status: 'attention',
      reason: 'The live position snapshot failed verification.',
      details: expect.arrayContaining([
        expect.objectContaining({
          id: 'fresh-session',
          status: 'attention',
          reason: 'The live position snapshot failed verification.',
        }),
      ]),
    });
  });

  test('maps the verified aggregate Analyst check and fails closed on runtime problems', () => {
    expect(evaluateAnalystRuntimeEvidence(freshAnalystEvidence()))
      .toMatchObject({ id: 'analyst-runtime', status: 'online' });
    expect(evaluateAnalystRuntimeEvidence(freshAnalystEvidence({
      status: 'warn',
    }))).toMatchObject({
      id: 'analyst-runtime',
      status: 'attention',
      reason: 'The Analyst runtime needs attention.',
    });
    expect(evaluateAnalystRuntimeEvidence(freshAnalystEvidence({
      status: 'fail',
      errorCode: 'ANALYST_CONTRACT_UNVERIFIED',
    }))).toMatchObject({
      id: 'analyst-runtime',
      status: 'offline',
      reason: 'The Analyst is running, but its runtime contract is unverified.',
    });
    expect(evaluateAnalystRuntimeEvidence(freshAnalystEvidence({
      status: 'fail',
      errorCode: 'ANALYST_RUNTIME_UNAVAILABLE',
    }))).toMatchObject({
      id: 'analyst-runtime',
      status: 'offline',
      reason: 'The Analyst runtime is unavailable or has unverified process provenance.',
    });
    expect(evaluateAnalystRuntimeEvidence({ id: 'unexpected', status: 'pass' }))
      .toMatchObject({ id: 'analyst-runtime', status: 'unknown' });
  });

  test('marks a fresh, schedule-proven Gmail failure offline', () => {
    const evidence = freshAiEvidence();
    evidence.gmail.records[0].store.heartbeat.status = 'error';
    evidence.gmail.records[0].store.heartbeat.errorCode = 'GMAIL_POLL_FAILED';

    expect(evaluateAiEvidence(evidence, { now: NOW })).toMatchObject({
      status: 'offline',
      reason: 'Gmail Function did not complete successfully; a fresh heartbeat is required.',
      details: expect.arrayContaining([
        expect.objectContaining({
          id: 'gmail-ingestion',
          status: 'offline',
          reason: 'Gmail Function did not complete successfully; a fresh heartbeat is required.',
        }),
      ]),
    });
  });

  test('shows a fresh completed Gmail warning as attention', () => {
    const evidence = freshAiEvidence();
    evidence.gmail.records[0].store.heartbeat.status = 'warning';
    evidence.gmail.records[0].store.heartbeat.errorCode = 'GMAIL_QUARANTINED_ARTIFACTS_PENDING';
    evidence.gmail.records[0].store.heartbeat.detail = '2 Gmail message(s) remain quarantined.';

    expect(evaluateAiEvidence(evidence, { now: NOW })).toMatchObject({
      status: 'attention',
      details: expect.arrayContaining([
        expect.objectContaining({
          id: 'gmail-ingestion',
          status: 'attention',
        }),
      ]),
    });
  });

  test('keeps a fresh typed Gmail authentication heartbeat offline', () => {
    const evidence = freshAiEvidence();
    evidence.gmail.records[0].store.heartbeat.status = 'auth_required';
    evidence.gmail.records[0].store.heartbeat.errorCode = 'GMAIL_AUTH_REQUIRED';

    expect(evaluateAiEvidence(evidence, { now: NOW })).toMatchObject({
      status: 'offline',
      reason: 'Gmail authorization is required before ingestion can continue.',
      details: expect.arrayContaining([
        expect.objectContaining({
          id: 'gmail-ingestion',
          status: 'offline',
          reason: 'Gmail authorization is required before ingestion can continue.',
        }),
      ]),
    });
  });

  test('humanizes Gmail materialization warnings without exposing machine codes', () => {
    const evidence = freshAiEvidence();
    evidence.gmail.records[0].store.heartbeat = {
      ...evidence.gmail.records[0].store.heartbeat,
      status: 'warning',
      errorCode: 'GMAIL_QUARANTINED_ARTIFACTS_PENDING',
      detail: '2 Gmail message(s) remain quarantined.',
    };

    const report = evaluateAiEvidence(evidence, { now: NOW });

    expect(report.details).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'gmail-ingestion',
        reason: 'The Gmail poller is current; 2 quarantined Gmail messages remain after research materialization failed.',
      }),
    ]));
    expect(JSON.stringify(report)).not.toMatch(
      /GMAIL_QUARANTINED_ARTIFACTS_PENDING/,
    );
  });

  test('rejects stale or provenance-mismatched Gmail heartbeats without fallback', () => {
    const stale = freshAiEvidence();
    stale.gmail.records[0].store.heartbeat.finishedAt = new Date(
      NOW.getTime() - 46 * 60 * 1000,
    ).toISOString();
    expect(evaluateAiEvidence(stale, { now: NOW })).toMatchObject({
      status: 'offline',
      reason: 'Gmail Function heartbeat is stale.',
    });

    const mismatched = freshAiEvidence();
    mismatched.gmail.records[0].store.heartbeat.scheduleId = 'unexpected-schedule';
    expect(evaluateAiEvidence(mismatched, { now: NOW })).toMatchObject({
      status: 'unknown',
      reason: 'Gmail Function heartbeat provenance is unverified.',
    });
  });

  test('raises overall attention for an explicit Analyst failure without altering other services', async () => {
    const evidence = freshAiEvidence({
      analyst: freshAnalystEvidence({
        status: 'fail',
        errorCode: 'ANALYST_RUNTIME_UNAVAILABLE',
      }),
    });
    const report = await createOnlineService({
      readAiEvidence: async () => evidence,
    }).collect();

    expect(report.overall).toBe('attention');
    expect(report.services.find((service) => service.id === 'ai')).toMatchObject({
      status: 'offline',
    });
    expect(report.services.filter((service) => service.id !== 'ai'))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'dashboard', status: 'online' }),
        expect.objectContaining({ id: 'market-data', status: 'online' }),
        expect.objectContaining({ id: 'live-portfolio', status: 'online' }),
      ]));
  });
});
