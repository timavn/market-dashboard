const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  applyBridgeStatusPayload,
  bridgeRecoveryLabel,
  childEnvironment,
  configuredBridgeAwsProfile,
  formatMorningReport,
  hasExpectedDashboardSignature,
  hasStartupReadinessMismatch,
  mergedMorningReport,
  morningExitCode,
  localNotificationsEnabled,
  pathIsInRoot,
  planServiceNotificationTransition,
  planStateWriteNotification,
  recoveryActions,
  restartPolicyFor,
  services,
  sendMacNotification,
  systemSourceIsStale,
  validateSystemReadinessReport,
  writeJsonAtomically,
} = require('./cli');

const capabilityIds = [
  'automation.hermes',
  'dashboard.core',
  'portfolio.live',
  'prediction.display',
  'prediction.ibkrExecution',
  'research.current',
];

function check(overrides = {}) {
  return {
    id: 'gateway',
    label: 'IB Gateway',
    status: 'pass',
    blocking: true,
    summary: 'Connected.',
    detail: 'Authenticated.',
    observedAt: '2026-07-21T17:00:00.000Z',
    ageSeconds: 0,
    impact: 'Portfolio trading requires Gateway.',
    recovery: null,
    ...overrides,
  };
}

function systemReport(overrides = {}) {
  const checks = overrides.checks || [check()];
  return {
    version: 1,
    status: 'ready',
    ready: true,
    checkedAt: '2026-07-21T17:00:00.000Z',
    summary: {
      passed: 1,
      warnings: 0,
      failed: 0,
      total: 1,
      blockingFailures: 0,
    },
    groups: [{ id: 'brokerage', label: 'Brokerage', checks }],
    capabilities: capabilityIds.map((id) => ({ id, label: id, status: 'ready' })),
    ...overrides,
  };
}

function localGroup(status = 'pass') {
  return {
    id: 'local-stack',
    label: 'Local stack',
    checks: [check({
      id: 'local-api',
      label: 'Express API',
      status,
      summary: status === 'pass' ? 'Healthy.' : 'Down.',
    })],
  };
}

test('validates the canonical version 1 readiness contract', () => {
  const report = systemReport();
  assert.equal(validateSystemReadinessReport(report), report);
  assert.throws(
    () => validateSystemReadinessReport({ ...report, version: 2 }),
    /Unsupported readiness report version/,
  );
  assert.throws(
    () => validateSystemReadinessReport({ ...report, groups: [{ id: 'bad', label: 'Bad', checks: [{ status: 'maybe' }] }] }),
    /invalid check/,
  );
  assert.throws(
    () => validateSystemReadinessReport({ ...report, ready: false }),
    /inconsistent ready and status/,
  );
  assert.throws(
    () => validateSystemReadinessReport({ ...report, summary: { ...report.summary, total: 99 } }),
    /summary counts are inconsistent/,
  );
  assert.throws(
    () => validateSystemReadinessReport({ ...report, capabilities: [] }),
    /required capability contract/,
  );
});

test('merges local checks and preserves the most severe status', () => {
  const ready = mergedMorningReport(localGroup(), systemReport());
  assert.equal(ready.status, 'ready');
  assert.deepEqual(ready.summary, {
    passed: 2,
    warnings: 0,
    failed: 0,
    total: 2,
    blockingFailures: 0,
  });

  const degradedRemote = systemReport({
    status: 'degraded',
    ready: false,
    checks: [check({ status: 'warn', blocking: false })],
  });
  assert.equal(mergedMorningReport(localGroup(), degradedRemote).status, 'degraded');
  assert.equal(mergedMorningReport(localGroup('fail'), systemReport()).status, 'blocked');
});

test('keeps ancillary failures degraded while exposing capabilities and unique root causes', () => {
  const report = mergedMorningReport(localGroup(), systemReport({
    status: 'degraded',
    ready: false,
    checks: [
      check({
        id: 'hermes.quant-analyst',
        label: 'Hermes analyst',
        status: 'fail',
        summary: 'Schedule is stale.',
        errorCode: 'HERMES_SCHEDULE_STALE',
      }),
      check({
        id: 'hermes.quant-developer',
        label: 'Hermes developer',
        status: 'fail',
        summary: 'Schedule is stale.',
        errorCode: 'HERMES_SCHEDULE_STALE',
      }),
    ],
  }));

  assert.equal(report.status, 'degraded');
  assert.equal(report.operational, true);
  assert.equal(report.fullyOperational, false);
  assert.equal(report.rootCauses.length, 1);
  assert.deepEqual(report.rootCauses[0].affectedCheckIds.sort(), [
    'hermes.quant-analyst',
    'hermes.quant-developer',
  ]);
  assert.equal(report.capabilities.find(capability => capability.id === 'automation.hermes').status, 'degraded');

  const output = formatMorningReport(report);
  assert.match(output, /CAPABILITIES/);
  assert.match(output, /ROOT CAUSES \(1\)/);
  assert.match(output, /HERMES_SCHEDULE_STALE/);
});

test('orders blocking failures before warnings and deduplicates actions', () => {
  const sharedRecovery = { kind: 'command', label: 'Restart it.', command: 'npm run morning' };
  const actions = recoveryActions([{ id: 'ops', label: 'Ops', checks: [
    check({ id: 'warn', status: 'warn', blocking: false, recovery: { kind: 'manual', label: 'Review warning.' } }),
    check({ id: 'fail-a', status: 'fail', recovery: sharedRecovery }),
    check({ id: 'fail-b', status: 'fail', recovery: sharedRecovery }),
  ] }]);
  assert.deepEqual(actions.map(action => action.label), ['Restart it.', 'Review warning.']);
});

test('renders a concise checklist and documented exit codes', () => {
  const report = mergedMorningReport(localGroup(), systemReport());
  const output = formatMorningReport(report);
  assert.match(output, /Market Dashboard Morning Checklist/);
  assert.match(output, /\[PASS\] Express API/);
  assert.match(output, /Overall: READY/);
  assert.equal(morningExitCode('ready'), 0);
  assert.equal(morningExitCode('degraded'), 1);
  assert.equal(morningExitCode('blocked'), 2);
  assert.equal(morningExitCode('invalid'), 3);
});

test('repo ownership only accepts this repo or its descendants', () => {
  const repo = path.resolve(__dirname, '../..');
  assert.equal(pathIsInRoot(repo), true);
  assert.equal(pathIsInRoot(path.join(repo, 'scripts/ibkr_sidecar')), true);
  assert.equal(pathIsInRoot(path.dirname(repo)), false);
  assert.equal(pathIsInRoot('/tmp/unrelated-market-dashboard'), false);
});

test('ownership additionally requires a known dashboard command signature', () => {
  const repo = path.resolve(__dirname, '../..');
  assert.equal(hasExpectedDashboardSignature('python3 -m http.server 3001', repo), false);
  assert.equal(hasExpectedDashboardSignature(`node ${path.join(repo, 'scripts/dev-stack/cli.js')} start`, repo), true);
  assert.equal(hasExpectedDashboardSignature(`node ${path.join(repo, 'scripts/dev-stack/cli.js')} restart`, repo), true);
  assert.equal(hasExpectedDashboardSignature('node server.js', repo), true);
  assert.equal(
    hasExpectedDashboardSignature(
      `node ${path.join(repo, 'node_modules/@craco/craco/dist/scripts/start.js')}`,
      repo,
    ),
    true,
  );
  assert.equal(
    hasExpectedDashboardSignature('uvicorn app:app --port 8765', path.join(repo, 'scripts/ibkr_sidecar')),
    true,
  );
  assert.equal(hasExpectedDashboardSignature('uvicorn other:app --port 8765', repo), false);
  assert.equal(
    hasExpectedDashboardSignature(
      `node ${path.join(repo, 'scripts/ops/hermes_snapshot_bridge.js')}`,
      repo,
    ),
    true,
  );
  assert.equal(
    hasExpectedDashboardSignature('node /tmp/hermes_snapshot_bridge.js', repo),
    false,
  );
});

test('supervisor defines the Hermes bridge as a portless owned heartbeat service', () => {
  assert.equal(services.bridge.processOnly, true);
  assert.equal(services.bridge.port, undefined);
  assert.equal(services.bridge.health, undefined);
  assert.equal(services.bridge.critical, false);
  assert.match(services.bridge.args[0], /scripts\/ops\/hermes_snapshot_bridge\.js$/);
  assert.ok(services.bridge.heartbeatMaxAgeMs >= 90_000);
});

test('state snapshots are atomically replaced and a disk-full write preserves the last valid state', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'market-dashboard-state-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'dev-stack.json');
  fs.writeFileSync(target, JSON.stringify({ generation: 1 }));

  const successful = writeJsonAtomically(target, { generation: 2 }, { processId: 42 });
  assert.equal(successful.ok, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { generation: 2 });
  assert.equal(fs.existsSync(`${target}.tmp-42`), false);

  const diskFull = Object.assign({}, fs, {
    writeFileSync(file, ...args) {
      if (String(file).endsWith('.tmp-43')) {
        const error = new Error('no space left on device');
        error.code = 'ENOSPC';
        throw error;
      }
      return fs.writeFileSync(file, ...args);
    },
  });
  const failed = writeJsonAtomically(
    target,
    { generation: 3 },
    { fileSystem: diskFull, processId: 43 },
  );
  assert.equal(failed.ok, false);
  assert.equal(failed.errorCode, 'ENOSPC');
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { generation: 2 });
  assert.equal(fs.existsSync(`${target}.tmp-43`), false);
});

test('state persistence notifies once on ENOSPC and once when writes recover', () => {
  const failed = planStateWriteNotification(null, {
    ok: false,
    errorCode: 'ENOSPC',
  }, '2026-07-25T15:00:00.000Z');
  assert.equal(failed.nextErrorCode, 'ENOSPC');
  assert.equal(failed.event.kind, 'failure');
  assert.match(failed.event.body, /still running with in-memory state/);
  assert.match(failed.event.body, /free disk space/);

  const repeated = planStateWriteNotification(failed.nextErrorCode, {
    ok: false,
    errorCode: 'ENOSPC',
  }, '2026-07-25T15:01:00.000Z');
  assert.equal(repeated.event, null);

  const recovered = planStateWriteNotification(repeated.nextErrorCode, {
    ok: true,
  }, '2026-07-25T15:02:00.000Z');
  assert.equal(recovered.nextErrorCode, null);
  assert.equal(recovered.event.kind, 'recovery');
  assert.match(recovered.event.body, /healthy again after ENOSPC/);

  const stillHealthy = planStateWriteNotification(recovered.nextErrorCode, {
    ok: true,
  }, '2026-07-25T15:03:00.000Z');
  assert.equal(stillHealthy.event, null);
});

test('bridge children use a dedicated profile and cannot inherit higher-priority AWS credentials', () => {
  const environment = childEnvironment('bridge', {
    HERMES_BRIDGE_AWS_PROFILE: 'dashboard-bridge-test',
    AWS_PROFILE: 'wrong-profile',
    AWS_ACCESS_KEY_ID: 'should-not-be-inherited',
    AWS_SECRET_ACCESS_KEY: 'should-not-be-inherited',
    AWS_SESSION_TOKEN: 'should-not-be-inherited',
    PATH: '/usr/bin',
  });

  assert.equal(environment.AWS_PROFILE, 'dashboard-bridge-test');
  assert.equal(environment.HERMES_BRIDGE_AWS_PROFILE, 'dashboard-bridge-test');
  assert.equal(environment.AWS_SDK_LOAD_CONFIG, '1');
  assert.equal(environment.AWS_ACCESS_KEY_ID, undefined);
  assert.equal(environment.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(environment.AWS_SESSION_TOKEN, undefined);
  assert.equal(environment.PATH, '/usr/bin');
  assert.equal(configuredBridgeAwsProfile({}), 'market-dashboard-bridge');

  const apiEnvironment = childEnvironment('api', {
    AWS_ACCESS_KEY_ID: 'api-key',
  });
  assert.equal(apiEnvironment.AWS_ACCESS_KEY_ID, 'api-key');
  assert.equal(apiEnvironment.NODE_ENV, 'development');
});

test('local notifications emit once per failure and once on recovery', () => {
  const initial = planServiceNotificationTransition({
    name: 'api',
    serviceState: { status: 'ready' },
    observedAt: '2026-07-25T15:00:00.000Z',
  });
  assert.equal(initial.event, null);
  assert.equal(initial.next.phase, 'ready');

  const failed = planServiceNotificationTransition({
    name: 'api',
    serviceState: {
      status: 'down',
      healthFailures: 3,
      errorCode: 'LOCAL_API_UNHEALTHY',
    },
    previous: initial.next,
    observedAt: '2026-07-25T15:01:00.000Z',
  });
  assert.equal(failed.event.kind, 'failure');
  assert.match(failed.event.body, /LOCAL_API_UNHEALTHY/);

  const repeated = planServiceNotificationTransition({
    name: 'api',
    serviceState: {
      status: 'down',
      healthFailures: 20,
      errorCode: 'A_DIFFERENT_DETAIL_DURING_THE_SAME_OUTAGE',
    },
    previous: {
      ...failed.next,
      lastNotificationAt: '2026-07-25T15:01:00.000Z',
    },
    observedAt: '2026-07-25T15:05:00.000Z',
  });
  assert.equal(repeated.event, null);
  assert.equal(repeated.next.transitionedAt, failed.next.transitionedAt);
  assert.equal(repeated.next.lastNotificationAt, '2026-07-25T15:01:00.000Z');

  const restarting = planServiceNotificationTransition({
    name: 'api',
    serviceState: { status: 'restarting' },
    previous: repeated.next,
    observedAt: '2026-07-25T15:06:00.000Z',
  });
  assert.equal(restarting.event, null);
  assert.equal(restarting.next.phase, 'failed');

  const recovered = planServiceNotificationTransition({
    name: 'api',
    serviceState: { status: 'ready' },
    previous: restarting.next,
    observedAt: '2026-07-25T15:08:00.000Z',
  });
  assert.equal(recovered.event.kind, 'recovery');
  assert.match(recovered.event.body, /7 minutes/);
});

test('macOS notification delivery is configurable and passes content without shell interpolation', () => {
  assert.equal(localNotificationsEnabled({ MARKET_DASHBOARD_LOCAL_NOTIFICATIONS: 'off' }, 'darwin'), false);
  assert.equal(localNotificationsEnabled({}, 'linux'), false);
  assert.equal(localNotificationsEnabled({}, 'darwin'), true);

  let invocation = null;
  const delivered = sendMacNotification({
    title: 'Failure "quoted"',
    body: 'Literal $(touch /tmp/never-run)',
  }, {
    platform: 'darwin',
    execute(commandName, args, options) {
      invocation = { commandName, args, options };
    },
  });
  assert.equal(delivered.delivered, true);
  assert.equal(invocation.commandName, '/usr/bin/osascript');
  assert.equal(invocation.args.at(-2), 'Failure "quoted"');
  assert.equal(invocation.args.at(-1), 'Literal $(touch /tmp/never-run)');
});

test('bridge activity retains separate input and publish failure diagnostics', () => {
  const item = {};
  assert.equal(applyBridgeStatusPayload(item, {
    observedAt: '2026-07-25T15:00:00.000Z',
    status: 'error',
    errorCode: 'HERMES_BRIDGE_AWS_ACCESS_DENIED',
    inputErrorCode: 'PORTFOLIO_SNAPSHOT_STALE',
    input: {
      errorCode: 'PORTFOLIO_SNAPSHOT_STALE',
      detail: 'Portfolio input is stale.',
    },
    publishErrorCode: 'HERMES_BRIDGE_AWS_ACCESS_DENIED',
    publishStage: 'snapshot,heartbeat',
    publish: {
      errorCode: 'HERMES_BRIDGE_AWS_ACCESS_DENIED',
      stage: 'snapshot,heartbeat',
      detail: 'Denied while publishing.',
      failures: [
        {
          stage: 'snapshot',
          errorCode: 'HERMES_BRIDGE_AWS_ACCESS_DENIED',
          detail: 'Snapshot denied.',
        },
        {
          stage: 'heartbeat',
          errorCode: 'HERMES_BRIDGE_AWS_ACCESS_DENIED',
          detail: 'Heartbeat denied.',
        },
      ],
    },
    detail: 'Denied while publishing.',
  }), true);
  assert.equal(item.lastResultStatus, 'error');
  assert.equal(item.lastInputErrorCode, 'PORTFOLIO_SNAPSHOT_STALE');
  assert.equal(item.lastPublishErrorCode, 'HERMES_BRIDGE_AWS_ACCESS_DENIED');
  assert.equal(item.lastPublishStage, 'snapshot,heartbeat');
  assert.equal(item.lastInputDetail, 'Portfolio input is stale.');
  assert.equal(item.lastPublishDetail, 'Denied while publishing.');
  assert.equal(item.lastPublishFailures.length, 2);
  assert.equal(item.lastErrorCode, 'HERMES_BRIDGE_AWS_ACCESS_DENIED');
  assert.equal(item.lastSuccessAt, undefined);

  applyBridgeStatusPayload(item, {
    observedAt: '2026-07-25T15:10:00.000Z',
    status: 'ready',
    inputErrorCode: null,
    publishErrorCode: null,
  });
  assert.equal(item.lastResultStatus, 'ready');
  assert.equal(item.lastSuccessAt, '2026-07-25T15:10:00.000Z');
  assert.equal(item.lastErrorCode, null);
});

test('bridge recovery guidance names the exact failing layer', () => {
  assert.match(bridgeRecoveryLabel({
    awsProfile: 'bridge-prod',
    lastPublishErrorCode: 'HERMES_BRIDGE_AWS_PROFILE_UNAVAILABLE',
  }), /Provision credentials.*bridge-prod/);
  assert.match(bridgeRecoveryLabel({
    awsProfile: 'bridge-prod',
    lastPublishErrorCode: 'HERMES_BRIDGE_AWS_ACCESS_DENIED',
  }), /write-only local bridge policy.*bridge-prod/);
  assert.match(bridgeRecoveryLabel({
    lastInputErrorCode: 'PORTFOLIO_SNAPSHOT_STALE',
  }), /bridge input failure PORTFOLIO_SNAPSHOT_STALE/);
});

test('bounded restart policy opens and later permits recovery from a noncritical circuit', () => {
  const now = Date.parse('2026-07-21T17:00:00.000Z');
  let history = [];
  for (let index = 0; index < 4; index += 1) {
    const policy = restartPolicyFor({ history, now: now + index * 1_000, critical: false });
    history = policy.history;
    assert.equal(policy.circuitOpenUntil, null);
    assert.ok(policy.delayMs >= 1_000 && policy.delayMs <= 4_000);
  }
  const opened = restartPolicyFor({ history, now: now + 4_000, critical: false });
  assert.equal(opened.delayMs, null);
  assert.equal(opened.circuitOpenUntil, '2026-07-21T17:05:04.000Z');

  const reset = restartPolicyFor({
    history: opened.history,
    now: now + 5 * 60 * 1_000 + 5_000,
    critical: false,
    countFailure: false,
  });
  assert.equal(reset.circuitOpenUntil, null);
  assert.ok(reset.delayMs >= 1_000);
});

test('critical processes hand control back to launchd after the bounded restart limit', () => {
  const now = Date.parse('2026-07-21T17:00:00.000Z');
  const policy = restartPolicyFor({
    history: [now - 3_000, now - 2_000, now - 1_000],
    now,
    critical: true,
  });
  assert.equal(policy.fatal, true);
});

test('detects booted API or supervisor source drift in a readiness report', () => {
  assert.equal(systemSourceIsStale(systemReport()), false);
  assert.equal(systemSourceIsStale(systemReport({
    checks: [check({ errorCode: 'DASHBOARD_CODE_VERSION_DRIFT', status: 'fail' })],
  })), true);
});

test('retries only when a completed startup report contradicts healthy local probes', () => {
  const startupLocal = {
    id: 'local-stack',
    label: 'Local stack',
    checks: [
      check({ id: 'local-ui', status: 'pass' }),
      check({ id: 'local-sidecar', status: 'pass' }),
    ],
  };
  const staleStartup = systemReport({
    checks: [
      check({ id: 'dashboard.ui', status: 'fail', errorCode: 'DASHBOARD_UI_UNREACHABLE' }),
      check({ id: 'ibkr.gateway', status: 'fail', errorCode: 'IBKR_GATEWAY_DISCONNECTED' }),
    ],
  });

  assert.equal(hasStartupReadinessMismatch(startupLocal, staleStartup, { sidecarReady: true }), true);
  assert.equal(hasStartupReadinessMismatch(startupLocal, staleStartup, { sidecarReady: false }), true);
  assert.equal(hasStartupReadinessMismatch(startupLocal, systemReport(), { sidecarReady: true }), false);

  const gatewayOnly = systemReport({
    checks: [check({ id: 'ibkr.gateway', status: 'fail', errorCode: 'IBKR_GATEWAY_DISCONNECTED' })],
  });
  assert.equal(hasStartupReadinessMismatch(startupLocal, gatewayOnly, { sidecarReady: true }), true);
  assert.equal(hasStartupReadinessMismatch(startupLocal, gatewayOnly, { sidecarReady: false }), false);
});
