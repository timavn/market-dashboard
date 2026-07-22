const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  formatMorningReport,
  hasExpectedDashboardSignature,
  hasStartupReadinessMismatch,
  mergedMorningReport,
  morningExitCode,
  pathIsInRoot,
  recoveryActions,
  restartPolicyFor,
  services,
  systemSourceIsStale,
  validateSystemReadinessReport,
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
