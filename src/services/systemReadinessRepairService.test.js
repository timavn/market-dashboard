const { EventEmitter } = require('events');
const {
  createSystemReadinessRepairService,
  isLoopbackAddress,
} = require('./systemReadinessRepairService.cjs');

function spawnedChild() {
  const child = new EventEmitter();
  child.unref = jest.fn();
  process.nextTick(() => child.emit('spawn'));
  return child;
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
    const service = createSystemReadinessRepairService({ lambdaClient, spawnProcess });

    await service.run('retry-gmail-poll', { remoteAddress: '::1' });

    expect(spawnProcess).not.toHaveBeenCalled();
    expect(lambdaClient.invoke).toHaveBeenCalledWith({
      FunctionName: process.env.HERMES_GMAIL_INGESTOR_FUNCTION || 'market-dashboard-gmail-ingestor-v2',
      InvocationType: 'Event',
      Payload: JSON.stringify({ source: 'readiness-repair', poll: 'incremental' }),
    });
    expect(promise).toHaveBeenCalledTimes(1);
  });

  test('rebuilds only the deterministic 90-day RTA projections with fixed arguments', async () => {
    const spawnProcess = jest.fn(() => spawnedChild());
    const service = createSystemReadinessRepairService({ spawnProcess });

    await service.run('rebuild-research-projections', { remoteAddress: '127.0.0.1' });

    expect(spawnProcess).toHaveBeenCalledTimes(1);
    expect(spawnProcess.mock.calls[0][0]).toBe(process.execPath);
    expect(spawnProcess.mock.calls[0][1]).toEqual([
      expect.stringMatching(/scripts\/rebuild_rta_materializations\.js$/),
      '--apply',
      '--window-days=90',
      '--json',
    ]);
    expect(spawnProcess.mock.calls[0][2]).toMatchObject({ shell: false, detached: true });
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
    const service = createSystemReadinessRepairService();

    await expect(service.run('retry-gmail-poll', { remoteAddress: '127.0.0.1' }))
      .rejects.toMatchObject({
        statusCode: 503,
        code: 'READINESS_REPAIR_EXECUTOR_UNAVAILABLE',
      });
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
});
