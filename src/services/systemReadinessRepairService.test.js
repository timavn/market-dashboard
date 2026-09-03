const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const {
  createSystemReadinessRepairService,
  isLoopbackAddress,
  researchRebuildEnvironment,
  validateResearchRebuildReport,
} = require('./systemReadinessRepairService.cjs');

function spawnedChild() {
  const child = new EventEmitter();
  child.unref = jest.fn();
  process.nextTick(() => child.emit('spawn'));
  return child;
}

function completedChild({
  code = 0,
  stdout = '',
  stderr = '',
} = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = jest.fn();
  process.nextTick(() => {
    child.emit('spawn');
    if (stdout) child.stdout.write(stdout);
    if (stderr) child.stderr.write(stderr);
    child.stdout.end();
    child.stderr.end();
    child.emit('close', code, null);
  });
  return child;
}

function successfulRebuildReport(overrides = {}) {
  return {
    mode: 'apply',
    eventLedgerError: null,
    v2EventCount: 54,
    legacyMigrationEventCount: 12,
    materializedEventCount: 66,
    rejected: [],
    canonicalCoverageGaps: [],
    currentBoard: {
      available: true,
      lastUpdated: '2026-07-25T20:00:00.000Z',
      longCount: 2,
      shortCount: 3,
      holdings: [
        { ticker: 'SPY', side: 'long' },
        { ticker: 'QQQ', side: 'long' },
        { ticker: 'TLT', side: 'short' },
        { ticker: 'GLD', side: 'short' },
        { ticker: 'UUP', side: 'short' },
      ],
      dataQuality: { status: 'ok', invalidEvents: [] },
      checkpointValidation: { valid: true, reasons: [] },
    },
    summary: { dates: 30, written: 7 },
    ...overrides,
  };
}

function eligibleGmailReadiness() {
  return {
    groups: [{
      id: 'automation',
      checks: [{
        id: 'gmail.ingestion',
        status: 'fail',
        errorCode: 'GMAIL_RATE_LIMITED',
        recovery: {
          kind: 'command',
          automatic: true,
          actionId: 'retry-gmail-poll',
        },
        provenance: {
          heartbeatSource: 'aws-lambda',
          triggerSource: 'aws-scheduler',
          scheduleId: 'market-dashboard-gmail-v2-every-15m',
        },
      }],
    }],
  };
}

describe('system readiness repair service', () => {
  test('recognizes socket loopback addresses without trusting forwarded headers', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('192.168.1.20')).toBe(false);
    expect(isLoopbackAddress('')).toBe(false);
  });

  test('runs the fixed local-stack start executor for an allowlisted loopback request', async () => {
    const spawnProcess = jest.fn(() => spawnedChild());
    const service = createSystemReadinessRepairService({
      spawnProcess,
      now: () => Date.parse('2026-07-21T18:00:00.000Z'),
    });

    const result = await service.run('start-local-stack', { remoteAddress: '::ffff:127.0.0.1' });

    expect(result).toMatchObject({ accepted: true, action: { id: 'start-local-stack' } });
    expect(spawnProcess).toHaveBeenCalledTimes(1);
    expect(spawnProcess.mock.calls[0][0]).toBe(process.execPath);
    expect(spawnProcess.mock.calls[0][1]).toEqual(expect.arrayContaining(['start', '--detach']));
    expect(spawnProcess.mock.calls[0][2]).toMatchObject({ shell: false, detached: true });
  });

  test('uses a fixed delayed helper for restart so the API response can finish first', async () => {
    const spawnProcess = jest.fn(() => spawnedChild());
    const service = createSystemReadinessRepairService({ spawnProcess });

    await service.run('restart-local-stack', { remoteAddress: '127.0.0.1' });

    expect(spawnProcess).toHaveBeenCalledTimes(1);
    expect(spawnProcess.mock.calls[0][0]).toBe(process.execPath);
    expect(spawnProcess.mock.calls[0][1]).toHaveLength(1);
    expect(spawnProcess.mock.calls[0][1][0]).toMatch(/scripts\/dev-stack\/delayed_restart\.js$/);
    expect(spawnProcess.mock.calls[0][2]).toMatchObject({ shell: false, detached: true });
  });

  test('uses the fixed ownership-checked sidecar-only restart command', async () => {
    const spawnProcess = jest.fn(() => spawnedChild());
    const service = createSystemReadinessRepairService({ spawnProcess });

    await service.run('restart-ibkr-sidecar', { remoteAddress: '127.0.0.1' });

    expect(spawnProcess).toHaveBeenCalledTimes(1);
    expect(spawnProcess.mock.calls[0][0]).toBe(process.execPath);
    expect(spawnProcess.mock.calls[0][1]).toEqual([
      expect.stringMatching(/scripts\/dev-stack\/cli\.js$/),
      'restart-sidecar',
    ]);
    expect(spawnProcess.mock.calls[0][2]).toMatchObject({
      shell: false,
      detached: true,
    });
  });

  test('uses a fixed delayed helper for the workspace sidecar runtime rebuild', async () => {
    const spawnProcess = jest.fn(() => spawnedChild());
    const service = createSystemReadinessRepairService({ spawnProcess });

    await service.run('rebuild-sidecar-runtime', { remoteAddress: '127.0.0.1' });

    expect(spawnProcess).toHaveBeenCalledTimes(1);
    expect(spawnProcess.mock.calls[0][0]).toBe(process.execPath);
    expect(spawnProcess.mock.calls[0][1]).toEqual([
      expect.stringMatching(/scripts\/dev-stack\/delayed_rebuild_sidecar_runtime\.js$/),
    ]);
    expect(spawnProcess.mock.calls[0][2]).toMatchObject({ shell: false, detached: true });
  });

  test('invokes only the configured Gmail Lambda with the fixed incremental event', async () => {
    const promise = jest.fn().mockResolvedValue({ StatusCode: 202 });
    const lambdaClient = { invoke: jest.fn(() => ({ promise })) };
    const spawnProcess = jest.fn();
    const service = createSystemReadinessRepairService({
      lambdaClient,
      spawnProcess,
      collectReadiness: jest.fn().mockResolvedValue(eligibleGmailReadiness()),
    });

    await service.run('retry-gmail-poll', { remoteAddress: '::1' });

    expect(spawnProcess).not.toHaveBeenCalled();
    expect(lambdaClient.invoke).toHaveBeenCalledWith({
      FunctionName: process.env.HERMES_GMAIL_INGESTOR_FUNCTION || 'market-dashboard-gmail-ingestor-v2',
      InvocationType: 'Event',
      Payload: JSON.stringify({ source: 'readiness-repair', poll: 'incremental' }),
    });
    expect(promise).toHaveBeenCalledTimes(1);
  });

  test('completes and verifies only the deterministic 90-day canonical RTA rebuild', async () => {
    const spawnProcess = jest.fn(() => completedChild({
      stdout: JSON.stringify(successfulRebuildReport()),
    }));
    const service = createSystemReadinessRepairService({
      spawnProcess,
      inheritedEnvironment: {
        AWS_ACCESS_KEY_ID: 'must-not-leak',
        AWS_SECRET_ACCESS_KEY: 'must-not-leak',
        AWS_SESSION_TOKEN: 'must-not-leak',
        AWS_PROFILE: 'wrong-profile',
        HEDGEYE_BUCKET: 'wrong-bucket',
      },
    });

    const result = await service.run(
      'rebuild-research-projections',
      { remoteAddress: '127.0.0.1' },
    );

    expect(result).toMatchObject({
      accepted: true,
      completed: true,
      execution: {
        status: 'succeeded',
        canonicalEventCount: 54,
        rejectedCount: 0,
        written: 7,
      },
    });
    expect(spawnProcess).toHaveBeenCalledTimes(1);
    expect(spawnProcess.mock.calls[0][0]).toBe(process.execPath);
    expect(spawnProcess.mock.calls[0][1]).toEqual([
      expect.stringMatching(/scripts\/rebuild_rta_materializations\.js$/),
      '--apply',
      '--window-days=90',
      '--json',
    ]);
    expect(spawnProcess.mock.calls[0][2]).toMatchObject({
      shell: false,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        AWS_PROFILE: 'market-dashboard-local',
        AWS_REGION: 'us-west-1',
        HERMES_LEDGER_TABLE: 'HermesEmailIngestLedger',
        RESEARCH_EVENT_LEDGER_TABLE: 'ResearchEventLedgerV2',
        HEDGEYE_SNAPSHOT_TABLE: 'HedgeyeDailySnapshot',
        HEDGEYE_BUCKET: 'market-dashboard-csv-data',
      },
    });
    const childEnvironment = spawnProcess.mock.calls[0][2].env;
    expect(childEnvironment.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(childEnvironment.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(childEnvironment.AWS_SESSION_TOKEN).toBeUndefined();
  });

  test('does not accept a rebuild with canonical ledger errors or materialization rejections', async () => {
    for (const report of [
      successfulRebuildReport({ eventLedgerError: 'AccessDeniedException' }),
      successfulRebuildReport({ rejected: [{ messageId: 'bad' }] }),
      successfulRebuildReport({ v2EventCount: 0 }),
    ]) {
      const service = createSystemReadinessRepairService({
        spawnProcess: jest.fn(() => completedChild({
          stdout: JSON.stringify(report),
        })),
      });
      await expect(
        service.run('rebuild-research-projections', { remoteAddress: '127.0.0.1' }),
      ).rejects.toMatchObject({ statusCode: 503 });
    }
  });

  test('does not allow a second verified rebuild while the first is still running', async () => {
    let current = Date.parse('2026-07-21T18:00:00.000Z');
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = jest.fn();
    const spawnProcess = jest.fn()
      .mockImplementationOnce(() => child)
      .mockImplementation(() => spawnedChild());
    const service = createSystemReadinessRepairService({
      spawnProcess,
      now: () => current,
    });

    const firstRun = service.run(
      'rebuild-research-projections',
      { remoteAddress: '127.0.0.1' },
    );
    current += 60_000;

    await expect(service.run(
      'rebuild-research-projections',
      { remoteAddress: '127.0.0.1' },
    )).rejects.toMatchObject({
      statusCode: 429,
      code: 'READINESS_REPAIR_IN_PROGRESS',
    });
    expect(spawnProcess).toHaveBeenCalledTimes(1);

    child.stdout.end(JSON.stringify(successfulRebuildReport()));
    child.stderr.end();
    child.emit('close', 0, null);
    await expect(firstRun).resolves.toMatchObject({ completed: true });
  });

  test('holds the server-wide repair flight until a verified child terminates', async () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = jest.fn();
    const spawnProcess = jest.fn()
      .mockImplementationOnce(() => child)
      .mockImplementation(() => spawnedChild());
    const service = createSystemReadinessRepairService({ spawnProcess });

    const firstRun = service.run(
      'rebuild-research-projections',
      { remoteAddress: '127.0.0.1' },
    );

    await expect(service.run(
      'start-local-stack',
      { remoteAddress: '127.0.0.1' },
    )).rejects.toMatchObject({
      statusCode: 429,
      code: 'READINESS_REPAIR_GLOBAL_IN_PROGRESS',
    });
    expect(spawnProcess).toHaveBeenCalledTimes(1);

    child.stdout.end(JSON.stringify(successfulRebuildReport()));
    child.stderr.end();
    child.emit('close', 0, null);
    await expect(firstRun).resolves.toMatchObject({ completed: true });

    await expect(service.run(
      'start-local-stack',
      { remoteAddress: '127.0.0.1' },
    )).resolves.toMatchObject({ accepted: true });
    expect(spawnProcess).toHaveBeenCalledTimes(2);
  });

  test('does not report a nonzero or malformed rebuild process as successful', async () => {
    const failed = createSystemReadinessRepairService({
      spawnProcess: jest.fn(() => completedChild({
        code: 1,
        stderr: 'Refusing to apply: canonical ledger unavailable',
      })),
    });
    await expect(
      failed.run('rebuild-research-projections', { remoteAddress: '127.0.0.1' }),
    ).rejects.toMatchObject({
      statusCode: 503,
      code: 'RTA_REBUILD_PROCESS_FAILED',
    });

    const malformed = createSystemReadinessRepairService({
      spawnProcess: jest.fn(() => completedChild({ stdout: 'not-json' })),
    });
    await expect(
      malformed.run('rebuild-research-projections', { remoteAddress: '127.0.0.1' }),
    ).rejects.toMatchObject({
      statusCode: 503,
      code: 'RTA_REBUILD_REPORT_INVALID',
    });
  });

  test('waits for timeout termination and escalates a rebuild that ignores SIGTERM', async () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = jest.fn((signal) => {
      if (signal === 'SIGKILL') {
        process.nextTick(() => child.emit('close', null, 'SIGKILL'));
      }
      return true;
    });
    const service = createSystemReadinessRepairService({
      spawnProcess: jest.fn(() => child),
      processTimeoutMs: 5,
      processTerminationGraceMs: 5,
    });

    await expect(service.run(
      'rebuild-research-projections',
      { remoteAddress: '127.0.0.1' },
    )).rejects.toMatchObject({
      statusCode: 504,
      code: 'RTA_REBUILD_TIMEOUT',
    });
    expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
  });

  test('reconciles only the server-owned current CPI release', async () => {
    const reconcilePredictionCatalog = jest.fn().mockResolvedValue({
      outcome: { status: 'succeeded', code: 'CATALOG_RECONCILED' },
    });
    const service = createSystemReadinessRepairService({ reconcilePredictionCatalog });

    await service.run('reconcile-prediction-catalog', { remoteAddress: '127.0.0.1' });

    expect(reconcilePredictionCatalog).toHaveBeenCalledWith();
  });

  test('does not report a failed prediction reconciliation as accepted', async () => {
    const service = createSystemReadinessRepairService({
      reconcilePredictionCatalog: jest.fn().mockResolvedValue({
        outcome: {
          status: 'failed',
          code: 'UNSUPPORTED_OR_NOT_ENTITLED',
          message: 'No qualified current-release contract is available.',
        },
      }),
    });

    await expect(service.run('reconcile-prediction-catalog', { remoteAddress: '127.0.0.1' }))
      .rejects.toMatchObject({ statusCode: 503, code: 'UNSUPPORTED_OR_NOT_ENTITLED' });
  });

  test('rejects remote, unknown, and non-automatic actions without spawning', async () => {
    const spawnProcess = jest.fn(() => spawnedChild());
    const service = createSystemReadinessRepairService({ spawnProcess });

    await expect(service.run('start-local-stack', { remoteAddress: '10.0.0.9' }))
      .rejects.toMatchObject({ statusCode: 403, code: 'READINESS_REPAIR_LOOPBACK_REQUIRED' });
    await expect(service.run('credential-refresh', { remoteAddress: '127.0.0.1' }))
      .rejects.toMatchObject({ statusCode: 404, code: 'READINESS_REPAIR_NOT_ALLOWLISTED' });
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  test('does not accept a Gmail repair when the fixed Lambda executor is unavailable', async () => {
    const service = createSystemReadinessRepairService({
      collectReadiness: jest.fn().mockResolvedValue(eligibleGmailReadiness()),
    });

    await expect(service.run('retry-gmail-poll', { remoteAddress: '127.0.0.1' }))
      .rejects.toMatchObject({
        statusCode: 503,
        code: 'READINESS_REPAIR_EXECUTOR_UNAVAILABLE',
      });
  });

  test('rejects Gmail retry for missing, timeout, OAuth, or unverified schedule states', async () => {
    const lambdaClient = { invoke: jest.fn() };
    for (const errorCode of [
      'GMAIL_HEARTBEAT_MISSING',
      'GMAIL_INVOCATION_TIMEOUT',
      'GMAIL_AUTH_REQUIRED',
      'GMAIL_SCHEDULE_MISSING',
    ]) {
      const report = eligibleGmailReadiness();
      report.groups[0].checks[0].errorCode = errorCode;
      report.groups[0].checks[0].recovery = { kind: 'manual', automatic: false };
      const service = createSystemReadinessRepairService({
        lambdaClient,
        collectReadiness: jest.fn().mockResolvedValue(report),
      });
      await expect(service.run('retry-gmail-poll', { remoteAddress: '127.0.0.1' }))
        .rejects.toMatchObject({ statusCode: 409, code: 'GMAIL_RETRY_NOT_ELIGIBLE' });
    }
    expect(lambdaClient.invoke).not.toHaveBeenCalled();
  });

  test('rate limits repeated repairs', async () => {
    let current = Date.parse('2026-07-21T18:00:00.000Z');
    const service = createSystemReadinessRepairService({
      spawnProcess: jest.fn(() => spawnedChild()),
      now: () => current,
    });

    await service.run('start-local-stack', { remoteAddress: '127.0.0.1' });
    current += 1_000;
    await expect(service.run('start-local-stack', { remoteAddress: '127.0.0.1' }))
      .rejects.toMatchObject({ statusCode: 429, code: 'READINESS_REPAIR_COOLDOWN' });
  });

  test('pins the rebuild to the API profile, account region, and exact resources', () => {
    const environment = researchRebuildEnvironment({
      AWS_ACCESS_KEY_ID: 'must-not-leak',
      AWS_ROLE_ARN: 'must-not-leak',
      AWS_WEB_IDENTITY_TOKEN_FILE: '/tmp/must-not-leak',
      AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://example.test',
      AWS_SHARED_CREDENTIALS_FILE: '/tmp/must-not-leak',
      AWS_CONFIG_FILE: '/tmp/must-not-leak',
      AWS_PROFILE: 'wrong-profile',
      AWS_REGION: 'us-east-1',
      HEDGEYE_BUCKET: 'wrong-bucket',
    });

    expect(environment).toMatchObject({
      AWS_PROFILE: 'market-dashboard-local',
      AWS_DEFAULT_PROFILE: 'market-dashboard-local',
      AWS_REGION: 'us-west-1',
      AWS_DEFAULT_REGION: 'us-west-1',
      AWS_SDK_LOAD_CONFIG: '1',
      AWS_EC2_METADATA_DISABLED: 'true',
      MARKET_DASHBOARD_AWS_PROFILE_LOCKED: 'true',
      HERMES_LEDGER_TABLE: 'HermesEmailIngestLedger',
      RESEARCH_EVENT_LEDGER_TABLE: 'ResearchEventLedgerV2',
      HEDGEYE_SNAPSHOT_TABLE: 'HedgeyeDailySnapshot',
      HEDGEYE_BUCKET: 'market-dashboard-csv-data',
    });
    for (const key of [
      'AWS_ACCESS_KEY_ID',
      'AWS_ROLE_ARN',
      'AWS_WEB_IDENTITY_TOKEN_FILE',
      'AWS_CONTAINER_CREDENTIALS_FULL_URI',
      'AWS_SHARED_CREDENTIALS_FILE',
      'AWS_CONFIG_FILE',
    ]) {
      expect(environment[key]).toBeUndefined();
    }
  });

  test('requires a canonical nonempty, rejection-free rebuild report', () => {
    expect(validateResearchRebuildReport(successfulRebuildReport())).toMatchObject({
      status: 'succeeded',
      canonicalEventCount: 54,
      materializedEventCount: 66,
      rejectedCount: 0,
      canonicalCoverageGapCount: 0,
    });
    expect(() => validateResearchRebuildReport(
      successfulRebuildReport({ currentBoard: { available: false } }),
    )).toThrow(/canonical 90-day RTA rebuild/);
    expect(() => validateResearchRebuildReport(
      successfulRebuildReport({ rejected: 'not-an-array' }),
    )).toThrow(/canonical 90-day RTA rebuild/);
    expect(() => validateResearchRebuildReport(
      successfulRebuildReport({ canonicalCoverageGaps: undefined }),
    )).toThrow(/canonical 90-day RTA rebuild/);
    expect(() => validateResearchRebuildReport(successfulRebuildReport({
      canonicalCoverageGaps: [{
        sourceMessageId: 'partial-message',
        canonicalEventCount: 1,
        legacyEventCount: 2,
      }],
    }))).toThrow(/canonical 90-day RTA rebuild/);
    expect(() => validateResearchRebuildReport(successfulRebuildReport({
      currentBoard: {
        ...successfulRebuildReport().currentBoard,
        longCount: 'not-a-count',
      },
    }))).toThrow(/canonical 90-day RTA rebuild/);
    expect(() => validateResearchRebuildReport(successfulRebuildReport({
      currentBoard: {
        ...successfulRebuildReport().currentBoard,
        dataQuality: {
          status: 'error',
          invalidEvents: [{ code: 'unmatched-remove' }],
        },
      },
    }))).toThrow(/canonical 90-day RTA rebuild/);
  });
});
