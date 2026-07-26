const {
  SERVICE_MANIFEST,
  buildSystemReadiness,
  evaluateGmailIngestion,
  evaluateHermesWorker,
  evaluatePredictionMarketDisplay,
  evaluatePredictionMarketExecution,
  evaluatePredictionMarkets,
  makeCheck,
} = require('./systemReadiness.cjs');
const {
  buildDashboardChecks,
  buildHermesBridgeCheck,
  buildResearchPipelineCheck,
  buildResearchChecks,
  buildSidecarChecks,
  collectHermesWorkerSignals,
  getLaunchAgentProvenance,
  getServiceHeartbeat,
  isHermesDueNow,
  serviceHeartbeatErrorCode,
} = require('../services/systemReadinessService.cjs');

const NOW = new Date('2026-07-21T17:00:00.000Z');

describe('system readiness evaluation', () => {
  test('canonical manifest has unique, closed references and only core capabilities block', () => {
    const serviceIds = SERVICE_MANIFEST.services.map((service) => service.id);
    const capabilityIds = new Set(SERVICE_MANIFEST.capabilities.map((capability) => capability.id));
    const actionIds = new Set(SERVICE_MANIFEST.repairActions.map((action) => action.id));
    const runbookIds = new Set(SERVICE_MANIFEST.runbooks.map((runbook) => runbook.id));

    expect(new Set(serviceIds).size).toBe(serviceIds.length);
    expect(actionIds.size).toBe(SERVICE_MANIFEST.repairActions.length);
    expect(SERVICE_MANIFEST.capabilities
      .filter((capability) => capability.blocking)
      .map((capability) => capability.id)).toEqual(['dashboard.core', 'portfolio.live']);
    SERVICE_MANIFEST.services.forEach((service) => {
      service.capabilityIds.forEach((id) => expect(capabilityIds.has(id)).toBe(true));
      service.dependsOn.forEach((id) => expect(serviceIds).toContain(id));
      expect(runbookIds.has(service.runbookId)).toBe(true);
    });
    SERVICE_MANIFEST.services
      .map((service) => service.recoveryActionId)
      .filter(Boolean)
      .forEach((actionId) => expect(actionIds.has(actionId)).toBe(true));

    for (const id of ['hermes.quant-analyst', 'hermes.quant-developer', 'hermes.security', 'gmail.ingestion']) {
      const service = SERVICE_MANIFEST.services.find((candidate) => candidate.id === id);
      expect(service).toMatchObject({
        cadenceMinutes: expect.any(Number),
        readinessMaxAgeMinutes: expect.any(Number),
        aws: {
          functionName: expect.any(String),
          scheduleId: expect.any(String),
          heartbeatServiceId: expect.any(String),
        },
      });
    }
  });

  test('reports ready only when every check passes', () => {
    const report = buildSystemReadiness([
      {
        id: 'dashboard.core',
        label: 'Core',
        checks: [makeCheck({ id: 'api', label: 'API', status: 'pass', blocking: true })],
      },
    ], { now: NOW });

    expect(report).toMatchObject({
      status: 'ready',
      ready: true,
      summary: { passed: 1, warnings: 0, failed: 0, total: 1, blockingFailures: 0 },
    });
  });

  test('blocks on a blocking failure and degrades on a nonblocking failure', () => {
    const blocked = buildSystemReadiness([
      { id: 'portfolio.live', checks: [{ id: 'gateway', status: 'fail', blocking: true }] },
    ], { now: NOW });
    const degraded = buildSystemReadiness([
      { id: 'research.current', checks: [{ id: 'etf', status: 'fail', blocking: false }] },
    ], { now: NOW });

    expect(blocked.status).toBe('blocked');
    expect(blocked.summary.blockingFailures).toBe(1);
    expect(degraded.status).toBe('degraded');
    expect(degraded.ready).toBe(false);
  });

  test('blocks only core or portfolio capabilities and keeps ancillary failures degraded', () => {
    const report = buildSystemReadiness([
      {
        id: 'automation.hermes',
        checks: [{
          id: 'gmail.ingestion',
          status: 'fail',
          blocking: true,
          summary: 'Every recent poll failed.',
          errorCode: 'GMAIL_INGESTION_FAILED',
        }],
      },
    ], { now: NOW });

    expect(report).toMatchObject({
      status: 'degraded',
      ready: false,
      operational: true,
      fullyOperational: false,
      summary: { failed: 1, blockingFailures: 0 },
    });
    expect(report.capabilities).toEqual([
      expect.objectContaining({ id: 'automation.hermes', status: 'degraded', blocking: false }),
    ]);
    expect(report.groups[0].checks[0]).toMatchObject({
      blocking: false,
      owner: 'automation-operations',
      capabilityIds: ['automation.hermes'],
    });
  });

  test('collapses dependent portfolio failures into one upstream root cause', () => {
    const report = buildSystemReadiness([{ id: 'brokerage', checks: [
      { id: 'ibkr.sidecar', status: 'fail', summary: 'Sidecar down.', errorCode: 'IBKR_SIDECAR_UNREACHABLE' },
      { id: 'ibkr.gateway', status: 'fail', summary: 'Gateway unavailable.', errorCode: 'IBKR_GATEWAY_UNAVAILABLE' },
      { id: 'ibkr.accounts', status: 'fail', summary: 'Accounts unavailable.', errorCode: 'IBKR_ACCOUNTS_UNAVAILABLE' },
      { id: 'ibkr.portfolio', status: 'fail', summary: 'Portfolio unavailable.', errorCode: 'IBKR_PORTFOLIO_UNAVAILABLE' },
    ] }], { now: NOW });

    expect(report.status).toBe('blocked');
    expect(report.rootCauses).toHaveLength(1);
    expect(report.rootCauses[0]).toMatchObject({
      id: 'IBKR_SIDECAR_UNREACHABLE',
      affectedCheckIds: expect.arrayContaining([
        'ibkr.sidecar',
        'ibkr.gateway',
        'ibkr.accounts',
        'ibkr.portfolio',
      ]),
    });
  });

  test('adds owner, dependency, schedule, and allowlisted recovery metadata without replacing legacy fields', () => {
    const check = makeCheck({
      id: 'dashboard.ui',
      status: 'fail',
      summary: 'UI down.',
      observedAt: '2026-07-21T16:55:00.000Z',
      lastSuccessAt: '2026-07-21T16:50:00.000Z',
      nextDueAt: '2026-07-21T17:01:00.000Z',
      recovery: { kind: 'command', label: 'Start it.', command: 'npm start' },
      customEvidence: { port: 3000 },
    });

    expect(check).toMatchObject({
      blocking: true,
      owner: 'local-operations',
      capabilityIds: ['dashboard.core'],
      dependsOn: ['local-ui'],
      errorCode: 'DASHBOARD_UI_FAILED',
      lastSuccessAt: '2026-07-21T16:50:00.000Z',
      nextDueAt: '2026-07-21T17:01:00.000Z',
      automatic: true,
      recovery: { automatic: true, actionId: 'start-local-stack' },
      customEvidence: { port: 3000 },
    });
  });

  test('fails closed when a collector supplies an unknown state', () => {
    const check = makeCheck({ id: 'unknown', status: 'maybe', blocking: true });
    expect(check.status).toBe('fail');
    expect(check.summary).toMatch(/could not be verified/i);
  });

  test('does not treat an old successful Hermes run as awake', () => {
    const check = evaluateHermesWorker({
      worker: {
        key: 'quant-developer',
        name: 'Quant Developer',
        status: 'succeeded',
        lastRun: '2026-07-15T21:39:06.000Z',
      },
      invocation: { invocations: 0, errors: 0 },
      maxAgeMinutes: 45,
      due: true,
      now: NOW,
    });

    expect(check.status).toBe('fail');
    expect(check.summary).toMatch(/expected within 45 minutes/i);
  });

  test('treats manifest-owned Hermes monitors as due continuously after the first cadence', () => {
    expect(isHermesDueNow(new Date('2026-07-21T04:10:00.000Z'), 'quant-analyst')).toBe(false);
    expect(isHermesDueNow(new Date('2026-07-21T04:20:00.000Z'), 'quant-developer')).toBe(true);
    expect(isHermesDueNow(new Date('2026-07-21T12:10:00.000Z'), 'quant-analyst')).toBe(true);
    expect(isHermesDueNow(new Date('2026-07-21T13:20:00.000Z'), 'quant-analyst')).toBe(true);
    expect(isHermesDueNow(new Date('2026-07-21T23:30:00.000Z'), 'quant-developer')).toBe(true);
    expect(isHermesDueNow(new Date('2026-07-25T16:00:00.000Z'), 'security')).toBe(true);
  });

  test('queries the newest per-service heartbeat without scanning the shared table', async () => {
    const promise = jest.fn().mockResolvedValue({
      Items: [{
        serviceId: 'hermes:quant-analyst',
        observedAt: '2026-07-21T16:59:00.000Z',
        status: 'success',
      }],
    });
    const dynamodb = { query: jest.fn(() => ({ promise })) };

    const result = await getServiceHeartbeat(dynamodb, 'hermes:quant-analyst');

    expect(result).toMatchObject({ available: true, found: true });
    expect(dynamodb.query).toHaveBeenCalledWith(expect.objectContaining({
      TableName: 'MarketDashboardServiceHeartbeats',
      ExpressionAttributeValues: { ':serviceId': 'hermes:quant-analyst' },
      ScanIndexForward: false,
      Limit: 1,
    }));
    expect(dynamodb.scan).toBeUndefined();
  });

  test('normalizes heartbeat IAM denial into one stable root-cause code', () => {
    expect(serviceHeartbeatErrorCode({
      code: 'AccessDeniedException',
      message: 'not authorized to perform dynamodb:Query',
    })).toBe('SERVICE_HEARTBEAT_ACCESS_DENIED');
  });

  test('uses distinct heartbeat rows for workers sharing one consolidated Lambda', async () => {
    const definitions = [
      { key: 'quant-analyst', name: 'Quant Analyst', functionName: 'market-dashboard-hermes-worker-v2' },
      { key: 'quant-developer', name: 'Quant Developer', functionName: 'market-dashboard-hermes-worker-v2' },
    ];
    const heartbeatReader = jest.fn(async (_dynamodb, serviceId) => ({
      available: true,
      found: true,
      serviceId,
      heartbeat: serviceId.endsWith('quant-analyst')
        ? {
            serviceId,
            observedAt: '2026-07-21T16:59:00.000Z',
            status: 'success',
            source: 'aws-lambda',
            triggerSource: 'aws-scheduler',
            scheduleId: 'market-dashboard-hermes-quant-analyst-v2',
            scheduled: true,
            buildVersion: '1.0.0',
          }
        : {
            serviceId,
            observedAt: '2026-07-21T16:58:00.000Z',
            status: 'error',
            errorCode: 'PORTFOLIO_SNAPSHOT_STALE',
            source: 'aws-lambda',
            triggerSource: 'aws-scheduler',
            scheduleId: 'market-dashboard-hermes-quant-developer-v2',
            scheduled: true,
          },
    }));
    const metricReader = jest.fn();

    const signals = await collectHermesWorkerSignals({
      dynamodb: {},
      cloudwatch: {},
      workerDefinitions: definitions,
      now: NOW,
      heartbeatReader,
      metricReader,
    });
    const checks = signals.map((signal) => evaluateHermesWorker({
      worker: signal.definition,
      heartbeat: signal.heartbeat,
      invocation: signal.invocation,
      maxAgeMinutes: 45,
      due: true,
      now: NOW,
    }));

    expect(metricReader).not.toHaveBeenCalled();
    expect(checks[0]).toMatchObject({
      id: 'hermes.quant-analyst',
      status: 'pass',
      provenance: { source: 'service-heartbeat-table' },
    });
    expect(checks[1]).toMatchObject({
      id: 'hermes.quant-developer',
      status: 'fail',
      errorCode: 'PORTFOLIO_SNAPSHOT_STALE',
    });
  });

  test('does not let a manual Lambda invocation masquerade as scheduler health', () => {
    const check = evaluateHermesWorker({
      worker: {
        key: 'quant-analyst',
        name: 'Quant Analyst',
        scheduleId: 'market-dashboard-hermes-quant-analyst-v2',
      },
      heartbeat: {
        serviceId: 'hermes:quant-analyst',
        observedAt: '2026-07-21T16:59:00.000Z',
        status: 'success',
        source: 'aws-lambda',
        triggerSource: 'readiness-repair',
        scheduleId: null,
        scheduled: false,
      },
      now: NOW,
      maxAgeMinutes: 45,
      due: true,
    });

    expect(check).toMatchObject({
      status: 'fail',
      errorCode: 'HERMES_SCHEDULER_PROVENANCE_INVALID',
    });
  });

  test('does not accept a successful worker heartbeat from an old build', () => {
    const check = evaluateHermesWorker({
      worker: {
        key: 'quant-analyst',
        name: 'Quant Analyst',
        scheduleId: 'market-dashboard-hermes-quant-analyst-v2',
      },
      heartbeat: {
        serviceId: 'hermes:quant-analyst',
        observedAt: '2026-07-21T16:59:00.000Z',
        status: 'success',
        source: 'aws-lambda',
        triggerSource: 'aws-scheduler',
        scheduleId: 'market-dashboard-hermes-quant-analyst-v2',
        scheduled: true,
        buildVersion: 'old-build',
      },
      now: NOW,
      maxAgeMinutes: 45,
      due: true,
    });

    expect(check).toMatchObject({
      status: 'fail',
      errorCode: 'HERMES_BUILD_VERSION_MISMATCH',
    });
  });

  test('rejects shared Lambda metrics when the per-service heartbeat store is unavailable', async () => {
    const definitions = [
      { key: 'quant-analyst', functionName: 'market-dashboard-hermes-worker-v2' },
      { key: 'security', functionName: 'market-dashboard-hermes-worker-v2' },
    ];
    const metricReader = jest.fn();
    const signals = await collectHermesWorkerSignals({
      dynamodb: {},
      cloudwatch: {},
      workerDefinitions: definitions,
      now: NOW,
      heartbeatReader: jest.fn(async () => ({
        available: false,
        found: false,
        error: 'heartbeat table unavailable',
      })),
      metricReader,
    });

    expect(metricReader).not.toHaveBeenCalled();
    signals.forEach((signal) => expect(signal.invocation).toMatchObject({
      errorCode: 'HERMES_SHARED_LAMBDA_METRICS_NOT_SERVICE_SPECIFIC',
      source: 'shared-lambda-metrics-rejected',
    }));
  });

  test('does not let Lambda metrics substitute for a typed Gmail heartbeat', () => {
    const check = evaluateGmailIngestion({
      account: 'timsmithaviation@gmail.com',
      metrics: {
        invocations: 12,
        errors: 12,
        latestAt: '2026-07-21T16:55:00.000Z',
      },
      now: NOW,
    });

    expect(check).toMatchObject({
      status: 'fail',
      errorCode: 'GMAIL_HEARTBEAT_MISSING',
    });
    expect(check.summary).toMatch(/metrics alone cannot prove/i);
    expect(check.detail).toContain('timsmithaviation@gmail.com');
  });

  test('uses Gmail heartbeat auth state instead of presenting a retry as an automatic fix', () => {
    const check = evaluateGmailIngestion({
      account: 'timsmithaviation@gmail.com',
      heartbeat: {
        serviceId: 'gmail:timsmithaviation@gmail.com',
        observedAt: '2026-07-21T16:59:00.000Z',
        status: 'auth_required',
        errorCode: 'GMAIL_AUTH_REQUIRED',
        source: 'aws-lambda',
        triggerSource: 'aws-scheduler',
        scheduleId: 'market-dashboard-gmail-v2-every-15m',
        scheduled: true,
      },
      metrics: { invocations: 99, errors: 0 },
      now: NOW,
    });

    expect(check).toMatchObject({
      status: 'fail',
      errorCode: 'GMAIL_AUTH_REQUIRED',
      recovery: { kind: 'manual', automatic: false },
      provenance: { source: 'service-heartbeat-table' },
    });
  });

  test('offers only the allowlisted poll retry for a stale Gmail heartbeat', () => {
    const check = evaluateGmailIngestion({
      account: 'timsmithaviation@gmail.com',
      heartbeat: {
        serviceId: 'gmail:timsmithaviation@gmail.com',
        observedAt: '2026-07-21T15:00:00.000Z',
        status: 'success',
        source: 'aws-lambda',
        triggerSource: 'aws-scheduler',
        scheduleId: 'market-dashboard-gmail-v2-every-15m',
        scheduled: true,
      },
      now: NOW,
    });

    expect(check).toMatchObject({
      status: 'fail',
      errorCode: 'GMAIL_POLL_STALE',
      recovery: {
        kind: 'command',
        automatic: true,
        actionId: 'retry-gmail-poll',
      },
    });
  });

  test('does not accept a successful Gmail heartbeat from an old build', () => {
    const check = evaluateGmailIngestion({
      account: 'timsmithaviation@gmail.com',
      heartbeat: {
        serviceId: 'gmail:timsmithaviation@gmail.com',
        observedAt: '2026-07-21T16:59:00.000Z',
        status: 'success',
        source: 'aws-lambda',
        triggerSource: 'aws-scheduler',
        scheduleId: 'market-dashboard-gmail-v2-every-15m',
        scheduled: true,
        buildVersion: 'old-build',
      },
      now: NOW,
    });

    expect(check).toMatchObject({
      status: 'fail',
      errorCode: 'GMAIL_BUILD_VERSION_MISMATCH',
    });
  });

  test('requires the recovered poller to publish a typed heartbeat before becoming healthy', () => {
    const check = evaluateGmailIngestion({
      account: 'timsmithaviation@gmail.com',
      metrics: {
        invocations: 12,
        errors: 1,
        latestAt: '2026-07-21T16:55:00.000Z',
      },
      inbox: { errorCount: 80 },
      now: NOW,
    });

    expect(check).toMatchObject({
      status: 'fail',
      errorCode: 'GMAIL_HEARTBEAT_MISSING',
    });
  });

  test('rejects seed-derived or quote-less prediction contracts', () => {
    const check = evaluatePredictionMarkets({
      payload: {
        releaseKey: 'KXCPIYOY#2026-07',
        fetched_at: '2026-07-21T16:59:30.000Z',
        events: [{
          venue: 'IBKR',
          source_api: 'IBKR_TWS_API',
          tradable_in_ibkr: true,
          yes_bid: null,
          yes_ask: null,
          updated_at: '2026-07-21T16:59:30.000Z',
          expiration_time: '20260730',
          data_quality_flags: ['portfolio_discovered', 'no_live_quote'],
        }],
      },
      now: NOW,
    });

    expect(check.status).toBe('fail');
    expect(check.summary).toMatch(/no current, executable/i);
  });

  test('accepts only a fresh, native, two-sided IBKR prediction quote', () => {
    const check = evaluatePredictionMarkets({
      payload: {
        releaseKey: 'KXCPIYOY#2026-07',
        fetched_at: '2026-07-21T16:59:30.000Z',
        providers: { ibkr: { status: 'success' } },
        cpi_discovery: { missingStrikes: [] },
        events: [{
          conId: 7001,
          releaseKey: 'KXCPIYOY#2026-07',
          venue: 'IBKR',
          source_api: 'IBKR_TWS_API',
          tradable_in_ibkr: true,
          exchange: 'FORECASTX',
          tradingClass: 'KXCPIYOY',
          catalog_source: 'ibkr_contract_details',
          quote_side: 'YES',
          status: 'open',
          yes_bid: 0.42,
          yes_ask: 0.45,
          updated_at: '2026-07-21T16:59:30.000Z',
          expiration_time: '20260730',
          data_quality_flags: [],
        }],
      },
      now: NOW,
    });

    expect(check.status).toBe('pass');
  });

  test('separates native Kalshi display readiness from IBKR execution readiness', () => {
    const payload = {
      releaseKey: 'KXCPIYOY#2026-07',
      fetched_at: '2026-07-21T16:59:30.000Z',
      events: [{
        venue: 'Kalshi',
        source_api: 'kalshi_trade_api_v2',
        releaseKey: 'KXCPIYOY#2026-07',
        status: 'open',
        yes_bid: 0.42,
        yes_ask: 0.45,
        no_bid: 0.55,
        no_ask: 0.58,
        updated_at: '2026-07-21T16:59:30.000Z',
        expiration_time: '20260730',
        data_quality_flags: [],
      }],
    };

    expect(evaluatePredictionMarketDisplay({ payload, now: NOW })).toMatchObject({
      id: 'prediction.display',
      status: 'pass',
      capabilityIds: ['prediction.display'],
    });
    expect(evaluatePredictionMarketExecution({ payload, now: NOW })).toMatchObject({
      id: 'prediction.ibkrExecution',
      status: 'fail',
      capabilityIds: ['prediction.ibkrExecution'],
    });
  });

  test('rejects wrong-release rows from both display and execution readiness', () => {
    const event = {
      conId: 7002,
      venue: 'IBKR',
      source_api: 'IBKR_TWS_API',
      tradable_in_ibkr: true,
      exchange: 'FORECASTX',
      tradingClass: 'KXCPIYOY',
      catalog_source: 'ibkr_contract_details',
      quote_side: 'YES',
      releaseKey: 'KXCPIYOY#2026-06',
      status: 'open',
      yes_bid: 0.42,
      yes_ask: 0.45,
      updated_at: '2026-07-21T16:59:30.000Z',
      expiration_time: '20260730',
      data_quality_flags: [],
    };
    const payload = {
      releaseKey: 'KXCPIYOY#2026-07',
      fetched_at: '2026-07-21T16:59:30.000Z',
      events: [event],
    };

    expect(evaluatePredictionMarketDisplay({ payload, now: NOW }).status).toBe('fail');
    expect(evaluatePredictionMarketExecution({ payload, now: NOW }).status).toBe('fail');
  });

  test('propagates unsupported-or-not-entitled as a typed execution failure', () => {
    const check = evaluatePredictionMarketExecution({
      payload: {
        releaseKey: 'KXCPIYOY#2026-07',
        fetched_at: '2026-07-21T16:59:30.000Z',
        events: [],
        providers: {
          ibkr: {
            status: 'unsupported_or_not_entitled',
            errorCode: 'UNSUPPORTED_OR_NOT_ENTITLED',
          },
        },
        readiness: {
          ibkrExecution: {
            ready: false,
            errorCode: 'UNSUPPORTED_OR_NOT_ENTITLED',
          },
        },
      },
      now: NOW,
    });

    expect(check).toMatchObject({
      id: 'prediction.ibkrExecution',
      status: 'fail',
      errorCode: 'UNSUPPORTED_OR_NOT_ENTITLED',
    });
    expect(check.summary).toMatch(/supported\/entitled/i);
  });

  test('deduplicates prediction catalog access denial across display and execution', () => {
    const payload = {
      releaseKey: 'KXCPIYOY#2026-07',
      fetched_at: '2026-07-21T16:59:30.000Z',
      events: [],
      providers: {
        kalshi: {
          errorCode: 'CATALOG_PERSISTENCE_FAILED',
          message: 'not authorized to perform dynamodb:TransactWriteItems',
        },
        ibkr: {
          errorCode: 'AccessDeniedException',
          message: 'not authorized to perform dynamodb:Query',
        },
      },
    };

    const display = evaluatePredictionMarketDisplay({ payload, now: NOW });
    const execution = evaluatePredictionMarketExecution({ payload, now: NOW });
    expect(display).toMatchObject({
      status: 'fail',
      errorCode: 'PREDICTION_CATALOG_ACCESS_DENIED',
      recovery: { kind: 'manual' },
    });
    expect(execution).toMatchObject({
      status: 'fail',
      errorCode: 'PREDICTION_CATALOG_ACCESS_DENIED',
      recovery: { kind: 'manual' },
    });
  });

  test('never renders stale fallback research responses as healthy', () => {
    const stale = { status: 'stale', ageMs: 360000 };
    const checks = buildResearchChecks({
      rtaResult: {
        status: 'fulfilled',
        value: {
          available: true,
          lastUpdated: '2026-07-21T16:55:00.000Z',
          dataQuality: { status: 'ok', warnings: [] },
          _readinessCache: stale,
        },
      },
      etfResult: {
        status: 'fulfilled',
        value: {
          meta: { available: true, snapshotDate: '2026-07-21', parsedAt: '2026-07-21T16:55:00.000Z' },
          rows: [{ ticker: 'SPY' }],
          _readinessCache: stale,
        },
      },
      workflow: {
        hedgeye: { status: 'success', lastRun: '2026-07-21', count: 20 },
        _readinessCache: stale,
      },
      now: NOW,
    });

    expect(checks).toHaveLength(3);
    checks.forEach((check) => expect(check.status).toBe('fail'));
    expect(checks.map((check) => check.summary).join(' ')).toMatch(/stale cached response/i);
    expect(checks.find((check) => check.id === 'research.rta').recovery).toMatchObject({
      automatic: true,
      actionId: 'rebuild-research-projections',
    });
  });

  test('reports a not-yet-due market-day risk-range publication as pending instead of failed', () => {
    const checks = buildResearchChecks({
      rtaResult: { status: 'fulfilled', value: { available: true, dataQuality: { status: 'ok' } } },
      etfResult: {
        status: 'fulfilled',
        value: { meta: { available: true, snapshotDate: '2026-07-21' }, rows: [{ ticker: 'SPY' }] },
      },
      workflow: {
        hedgeye: {
          status: 'pending',
          lastRun: '2026-07-20',
          expectedDate: '2026-07-20',
          pendingDate: '2026-07-21',
          count: 38,
        },
      },
      now: NOW,
    });

    const risk = checks.find((check) => check.id === 'research.risk-ranges');
    expect(risk.status).toBe('warn');
    expect(risk.summary).toMatch(/pending for 2026-07-21/i);
  });

  test('reports Risk Range manifest IAM denial as a typed manual policy repair', () => {
    const checks = buildResearchChecks({
      rtaResult: { status: 'fulfilled', value: { available: true, dataQuality: { status: 'ok' } } },
      etfResult: {
        status: 'fulfilled',
        value: { meta: { available: true, snapshotDate: '2026-07-21' }, rows: [{ ticker: 'SPY' }] },
      },
      workflow: {
        hedgeye: {
          status: 'failed',
          errorCode: 'RISK_RANGE_MANIFEST_ACCESS_DENIED',
          error: 'not authorized to perform dynamodb:GetItem',
        },
      },
      gmailCheck: { status: 'pass' },
      now: NOW,
    });

    expect(checks.find((check) => check.id === 'research.risk-ranges')).toMatchObject({
      status: 'fail',
      errorCode: 'RISK_RANGE_MANIFEST_ACCESS_DENIED',
      detail: 'not authorized to perform dynamodb:GetItem',
      recovery: { kind: 'manual' },
    });
  });

  test('keeps a structurally valid ETF Pro book current through quiet days when Gmail is healthy', () => {
    const checks = buildResearchChecks({
      rtaResult: { status: 'fulfilled', value: { available: true, dataQuality: { status: 'ok' } } },
      etfResult: {
        status: 'fulfilled',
        value: {
          meta: {
            available: true,
            structurallyAvailable: true,
            ingestionStatus: 'healthy',
            snapshotDate: '2026-07-10',
          },
          rows: [{ ticker: 'SPY' }],
        },
      },
      workflow: { hedgeye: { status: 'pending', lastRun: '2026-07-20' } },
      gmailCheck: { status: 'pass' },
      now: NOW,
    });

    expect(checks.find((check) => check.id === 'research.etf-pro')).toMatchObject({
      status: 'pass',
      dependsOn: [],
    });
  });

  test('does not pass an old clean RTA projection when the Gmail pipeline has failed', () => {
    const checks = buildResearchChecks({
      rtaResult: {
        status: 'fulfilled',
        value: {
          available: true,
          lastUpdated: '2026-07-17T15:04:18.000Z',
          longCount: 2,
          shortCount: 3,
          dataQuality: { status: 'ok', warnings: [] },
          dataAvailability: {
            current: false,
            comparisonSafe: false,
            referenceOnly: true,
            contentDate: '2026-07-17',
            latestContentAt: '2026-07-17T15:04:18.000Z',
            errorCode: 'GMAIL_AUTH_REQUIRED',
            reason: 'Gmail OAuth authorization requires attention.',
          },
        },
      },
      etfResult: {
        status: 'fulfilled',
        value: {
          available: true,
          current: true,
          meta: { available: true, ingestionStatus: 'healthy', snapshotDate: '2026-07-17' },
          dataAvailability: { current: true, ingestionStatus: 'healthy' },
          rows: [{ ticker: 'SPY' }],
        },
      },
      workflow: { hedgeye: { status: 'pending', lastRun: '2026-07-20' } },
      gmailCheck: {
        status: 'fail',
        errorCode: 'GMAIL_AUTH_REQUIRED',
        summary: 'Gmail OAuth authorization requires attention.',
        recovery: { kind: 'manual', label: 'Reauthorize Gmail.' },
      },
      now: NOW,
    });

    expect(checks.find((check) => check.id === 'research.rta')).toMatchObject({
      status: 'warn',
      errorCode: 'GMAIL_AUTH_REQUIRED',
      dependsOn: ['gmail.ingestion'],
      summary: 'RTA is last-known-good from 2026-07-17; Gmail ingestion is not current.',
      recovery: { label: 'Reauthorize Gmail.' },
      provenance: {
        contentDate: '2026-07-17',
      },
    });
  });

  test('treats an old RTA content date as current when the scheduled Gmail heartbeat is healthy', () => {
    const checks = buildResearchChecks({
      rtaResult: {
        status: 'fulfilled',
        value: {
          available: true,
          lastUpdated: '2026-07-10T15:04:18.000Z',
          longCount: 2,
          shortCount: 3,
          dataQuality: { status: 'ok', warnings: [] },
        },
      },
      etfResult: {
        status: 'fulfilled',
        value: {
          meta: { available: true, snapshotDate: '2026-07-10' },
          rows: [{ ticker: 'SPY' }],
        },
      },
      workflow: { hedgeye: { status: 'pending', lastRun: '2026-07-20' } },
      gmailCheck: {
        status: 'pass',
        observedAt: NOW.toISOString(),
      },
      now: NOW,
    });

    expect(checks.find((check) => check.id === 'research.rta')).toMatchObject({
      status: 'pass',
      dependsOn: [],
      provenance: { contentDate: '2026-07-10' },
    });
  });

  test('reports an archival ETF Pro book as a warning with the exact Gmail cause', () => {
    const checks = buildResearchChecks({
      rtaResult: {
        status: 'fulfilled',
        value: {
          available: true,
          current: false,
          lastUpdated: '2026-07-17T15:04:18.000Z',
          dataQuality: { status: 'ok', warnings: [] },
          dataAvailability: {
            current: false,
            contentDate: '2026-07-17',
            errorCode: 'GMAIL_POLL_STALE',
          },
        },
      },
      etfResult: {
        status: 'fulfilled',
        value: {
          available: false,
          current: false,
          rows: [],
          dataAvailability: {
            current: false,
            referenceOnly: true,
            contentDate: '2026-07-17',
            errorCode: 'GMAIL_POLL_STALE',
            reason: 'The last Gmail service heartbeat is older than 45 minutes.',
          },
          lastKnownGood: {
            available: true,
            meta: { snapshotDate: '2026-07-17', parsedAt: '2026-07-17T12:00:00.000Z' },
            rows: [{ ticker: 'SPY' }, { ticker: 'TLT', call: 'Short' }],
            dataQuality: { status: 'ok', warnings: [] },
          },
        },
      },
      workflow: { hedgeye: { status: 'pending', lastRun: '2026-07-20' } },
      gmailCheck: {
        status: 'fail',
        errorCode: 'GMAIL_POLL_STALE',
        summary: 'The scheduled Gmail heartbeat is stale.',
      },
      now: NOW,
    });

    expect(checks.find((check) => check.id === 'research.etf-pro')).toMatchObject({
      status: 'warn',
      errorCode: 'GMAIL_POLL_STALE',
      dependsOn: ['gmail.ingestion'],
      summary: 'ETF Pro is last-known-good from 2026-07-17 (2 positions); Gmail ingestion is not current.',
      detail: expect.stringContaining('older than 45 minutes'),
      provenance: {
        contentDate: '2026-07-17',
        referenceOnly: true,
      },
    });
  });

  test('degrades research for incomplete product coverage without blocking the live portfolio capability', () => {
    const pipelineCheck = buildResearchPipelineCheck({
      coverage: {
        schemaVersion: 1,
        marketDate: '2026-07-21',
        generatedAt: NOW.toISOString(),
        status: 'failed',
        collectionErrors: [],
        summary: {
          failed: 1,
          missing: 1,
          received: 0,
          parsed: 0,
          validated: 0,
          indexed: 2,
          not_due: 10,
        },
        products: [
          {
            id: 'risk-ranges',
            label: 'Risk Ranges',
            status: 'missing',
            errorCode: 'RESEARCH_PRODUCT_DUE_MISSING',
          },
          {
            id: 'unsupported:new-letter',
            label: 'New Letter',
            status: 'failed',
            errorCode: 'RESEARCH_PRODUCT_UNSUPPORTED',
          },
        ],
      },
      gmailCheck: { status: 'pass' },
      now: NOW,
    });
    const report = buildSystemReadiness([
      {
        id: 'portfolio.live',
        label: 'Live portfolio',
        checks: [{
          id: 'ibkr.portfolio',
          status: 'pass',
          blocking: true,
          capabilityIds: ['portfolio.live'],
        }],
      },
      {
        id: 'research.current',
        label: 'Research',
        checks: [pipelineCheck],
      },
    ], { now: NOW });

    expect(pipelineCheck).toMatchObject({
      id: 'research.pipeline-coverage',
      status: 'fail',
      blocking: false,
      capabilityIds: ['research.current'],
      errorCode: 'RESEARCH_PRODUCT_COVERAGE_FAILED',
    });
    expect(report.status).toBe('degraded');
    expect(report.capabilities.find((capability) => capability.id === 'portfolio.live').status)
      .toBe('ready');
    expect(report.capabilities.find((capability) => capability.id === 'research.current').status)
      .toBe('degraded');
  });

  test('verifies UI and runtime provenance while treating a missing supervisor as degraded', () => {
    const checks = buildDashboardChecks({
      uiResult: {
        status: 'fulfilled',
        value: { ok: true, status: 200, observedAt: NOW.toISOString(), contentType: 'text/html' },
      },
      supervisor: {
        stateFound: false,
        running: false,
        rootMatches: false,
        commandMatches: false,
        error: 'Supervisor state file was not found.',
      },
      runtime: {
        pid: 123,
        node: 'v22.0.0',
        cwd: '/repo',
        entrypoint: '/repo/server.js',
        rootMatches: true,
        entrypointMatches: true,
        sourceMatches: true,
        sourceMatches: true,
      },
      now: NOW,
    });
    const report = buildSystemReadiness([{ id: 'dashboard', checks }], { now: NOW });

    expect(checks.map((check) => check.status)).toEqual(['pass', 'warn', 'pass']);
    expect(report.status).toBe('degraded');
    expect(report.operational).toBe(true);
    expect(report.capabilities[0]).toMatchObject({ id: 'dashboard.core', status: 'degraded' });
    expect(report.rootCauses[0]).toMatchObject({
      errorCode: 'DASHBOARD_SUPERVISOR_UNVERIFIED',
      owner: 'local-operations',
    });
  });

  test('verifies the installed LaunchAgent targets this repo and actually launched the API', () => {
    const provenance = getLaunchAgentProvenance({
      plistPath: '/Users/test/Library/LaunchAgents/com.market-dashboard.stack.plist',
      repoRoot: '/repo',
      env: { MARKET_DASHBOARD_LAUNCHD_LABEL: 'com.market-dashboard.stack' },
      uid: 501,
      readFile: () => [
        '<string>com.market-dashboard.stack</string>',
        '<string>/repo</string>',
        '<string>/repo/scripts/dev-stack/cli.js</string>',
      ].join(''),
      runLaunchctl: () => 'com.market-dashboard.stack = { state = running; }',
    });
    const checks = buildDashboardChecks({
      uiResult: { status: 'fulfilled', value: { ok: true, status: 200 } },
      supervisor: { stateFound: true, running: true, rootMatches: true, commandMatches: true },
      runtime: { rootMatches: true, entrypointMatches: true, sourceMatches: true },
      launchAgent: provenance,
      now: NOW,
    });

    expect(provenance.verified).toBe(true);
    expect(checks.find((check) => check.id === 'dashboard.launchagent')).toMatchObject({
      status: 'pass',
      provenance: { loaded: true, inheritedLabel: true },
    });
  });

  test('blocks core when the dashboard UI cannot be reached', () => {
    const checks = buildDashboardChecks({
      uiResult: { status: 'rejected', reason: new Error('connection refused') },
      supervisor: {
        stateFound: true,
        running: true,
        rootMatches: true,
        commandMatches: true,
        sourceMatches: true,
        pid: 321,
      },
      runtime: {
        pid: 123,
        node: 'v22.0.0',
        cwd: '/repo',
        entrypoint: '/repo/server.js',
        rootMatches: true,
        entrypointMatches: true,
        sourceMatches: true,
        sourceMatches: true,
      },
      now: NOW,
    });
    const report = buildSystemReadiness([{ id: 'dashboard', checks }], { now: NOW });

    expect(report.status).toBe('blocked');
    expect(report.rootCauses[0].errorCode).toBe('DASHBOARD_UI_UNREACHABLE');
    expect(checks[0].recovery).toMatchObject({
      automatic: true,
      actionId: 'start-local-stack',
    });
  });

  test('accepts an empty portfolio only when the managed live IB socket is freshly verified', () => {
    const fulfilled = (value) => ({ status: 'fulfilled', value });
    const checks = buildSidecarChecks({
      livezResult: fulfilled({
        ok: true,
        time: '2026-07-21T16:59:55.000Z',
        runtime: {
          errorCode: null,
          interpreterInsideWorkspace: true,
          prefixInsideWorkspace: true,
          appInsideWorkspace: true,
          dependenciesInsideWorkspace: true,
        },
      }),
      readyzResult: fulfilled({
        ok: true,
        connected: true,
        status: 'ready',
        accounts: ['U1'],
        time: '2026-07-21T16:59:55.000Z',
      }),
      statusResult: fulfilled({
        connected: true,
        status: 'connected',
        accounts: ['U1'],
        time: '2026-07-21T16:59:55.000Z',
      }),
      portfolioResult: fulfilled({
        ok: true,
        connected: true,
        status: 'live',
        source: 'ibkr_live_session',
        accounts: ['U1'],
        positions: [],
        position_count: 0,
        socket_verified_at: '2026-07-21T16:59:54.000Z',
        observed_at: '2026-07-21T16:59:55.000Z',
      }),
      now: NOW,
    });

    expect(checks.find((check) => check.id === 'ibkr.portfolio')).toMatchObject({
      status: 'pass',
      errorCode: null,
      provenance: {
        source: 'ibkr_live_session',
        accountCount: 1,
        positionCount: 0,
      },
    });
    expect(checks.find((check) => check.id === 'ibkr.runtime')).toMatchObject({
      status: 'pass',
      errorCode: null,
    });
  });

  test('fails portfolio readiness when the sidecar runtime resolves outside the workspace', () => {
    const fulfilled = (value) => ({ status: 'fulfilled', value });
    const checks = buildSidecarChecks({
      livezResult: fulfilled({
        ok: true,
        time: NOW.toISOString(),
        runtime: {
          errorCode: 'RUNTIME_DRIFT',
          interpreterInsideWorkspace: false,
          prefixInsideWorkspace: false,
          appInsideWorkspace: true,
          dependenciesInsideWorkspace: false,
          interpreter: '/old/runtime/bin/python',
        },
      }),
      readyzResult: fulfilled({ ok: true, connected: true, status: 'ready', accounts: ['U1'] }),
      statusResult: fulfilled({ connected: true, status: 'connected', accounts: ['U1'] }),
      portfolioResult: fulfilled({
        ok: true,
        connected: true,
        status: 'live',
        source: 'ibkr_live_session',
        accounts: ['U1'],
        positions: [],
        socket_verified_at: NOW.toISOString(),
        observed_at: NOW.toISOString(),
      }),
      now: NOW,
    });
    const report = buildSystemReadiness([{ id: 'brokerage', checks }], { now: NOW });

    expect(checks.find((check) => check.id === 'ibkr.runtime')).toMatchObject({
      status: 'fail',
      errorCode: 'RUNTIME_DRIFT',
      recovery: {
        automatic: true,
        actionId: 'rebuild-sidecar-runtime',
      },
    });
    expect(report.capabilities.find((capability) => capability.id === 'portfolio.live').status)
      .toBe('blocked');
  });

  test('fails closed on cached, unverified, or stale portfolio-session evidence', () => {
    const fulfilled = (value) => ({ status: 'fulfilled', value });
    const base = {
      livezResult: fulfilled({
        ok: true,
        time: NOW.toISOString(),
        runtime: {
          errorCode: null,
          interpreterInsideWorkspace: true,
          prefixInsideWorkspace: true,
          appInsideWorkspace: true,
          dependenciesInsideWorkspace: true,
        },
      }),
      readyzResult: fulfilled({ ok: true, connected: true, status: 'ready', accounts: ['U1'] }),
      statusResult: fulfilled({ connected: true, status: 'connected', accounts: ['U1'] }),
      now: NOW,
    };
    const cached = buildSidecarChecks({
      ...base,
      portfolioResult: fulfilled({
        ok: true,
        connected: true,
        status: 'live',
        source: 'cache',
        accounts: ['U1'],
        positions: [{ symbol: 'SPY', position: 1 }],
        socket_verified_at: '2026-07-21T16:59:55.000Z',
        observed_at: '2026-07-21T16:59:55.000Z',
      }),
    }).find((check) => check.id === 'ibkr.portfolio');
    const stale = buildSidecarChecks({
      ...base,
      portfolioResult: fulfilled({
        ok: true,
        connected: true,
        status: 'live',
        source: 'ibkr_live_session',
        accounts: ['U1'],
        positions: [],
        socket_verified_at: '2026-07-21T16:00:00.000Z',
        observed_at: '2026-07-21T16:00:00.000Z',
      }),
    }).find((check) => check.id === 'ibkr.portfolio');

    expect(cached).toMatchObject({ status: 'fail', errorCode: 'IBKR_LIVE_SESSION_UNVERIFIED' });
    expect(stale).toMatchObject({ status: 'fail', errorCode: 'IBKR_LIVE_SESSION_STALE' });
    expect(cached.recovery).toMatchObject({
      automatic: true,
      actionId: 'restart-local-stack',
    });
  });

  test('requires a fresh successful heartbeat from the owned outbound Hermes bridge', () => {
    const supervisor = {
      stateFound: true,
      running: true,
      rootMatches: true,
      commandMatches: true,
      sourceMatches: true,
      children: {
        bridge: {
          pid: 4321,
          running: true,
          commandMatches: true,
          status: 'ready',
          lastResultStatus: 'ready',
          lastHeartbeatAt: '2026-07-21T16:59:30.000Z',
          lastSuccessAt: '2026-07-21T16:59:30.000Z',
        },
      },
    };
    const healthy = buildHermesBridgeCheck({ supervisor, now: NOW });
    const stale = buildHermesBridgeCheck({
      supervisor: {
        ...supervisor,
        children: {
          bridge: {
            ...supervisor.children.bridge,
            status: 'degraded',
            lastHeartbeatAt: '2026-07-21T16:55:00.000Z',
          },
        },
      },
      now: NOW,
    });

    expect(healthy).toMatchObject({
      id: 'dashboard.hermes-bridge',
      status: 'pass',
      owner: 'automation-operations',
      capabilityIds: ['automation.hermes'],
      lastSuccessAt: '2026-07-21T16:59:30.000Z',
    });
    expect(stale).toMatchObject({
      status: 'fail',
      blocking: false,
      errorCode: 'HERMES_BRIDGE_HEARTBEAT_STALE',
      automatic: false,
    });
  });
});
