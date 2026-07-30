const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  applyBridgeStatusPayload,
  applyControllerStatusPayload,
  bridgeRecoveryLabel,
  childEnvironment,
  configuredBridgeAwsProfile,
  credentialPreflightFailureState,
  discoverOwnedBridgeProcessIds,
  formatMorningReport,
  hasExactBridgeCommandSignature,
  hasExactControllerCommandSignature,
  hasExpectedDashboardSignature,
  heartbeatAgeMs,
  hasStartupReadinessMismatch,
  hermesBridgeEnabled,
  mergedMorningReport,
  morningExitCode,
  localNotificationsEnabled,
  pathIsInRoot,
  planServiceNotificationTransition,
  planStateWriteNotification,
  preflightAwsService,
  processServiceStatus,
  reconcileDisabledBridgeProcesses,
  recoveryActions,
  readinessUrl,
  restartPolicyFor,
  services,
  supervisedServiceNames,
  sendMacNotification,
  systemSourceIsStale,
  validateSystemReadinessReport,
  validProcessId,
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

test('supervisor preflight reads cached readiness without a forced-refresh query', () => {
  assert.equal(readinessUrl, 'http://127.0.0.1:3001/api/system-readiness');
  assert.equal(new URL(readinessUrl).search, '');
});

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
  assert.equal(report.rootCauses.length, 2);
  assert.deepEqual(
    report.rootCauses.map((cause) => cause.checkId).sort(),
    ['hermes.quant-analyst', 'hermes.quant-developer'],
  );
  assert.ok(report.rootCauses.every(
    (cause) => cause.affectedCheckIds.length === 1
      && cause.affectedCheckIds[0] === cause.checkId,
  ));
  assert.equal(report.capabilities.find(capability => capability.id === 'automation.hermes').status, 'degraded');

  const output = formatMorningReport(report);
  assert.match(output, /CAPABILITIES/);
  assert.match(output, /ROOT CAUSES \(2\)/);
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

test('process inspection rejects missing and invalid PIDs before invoking OS tools', () => {
  for (const value of [null, undefined, '', 'null', 0, -1, 1.5, Number.NaN]) {
    assert.equal(validProcessId(value), false);
  }
  assert.equal(validProcessId(123), true);
  assert.equal(validProcessId('123'), true);
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
  assert.equal(
    hasExpectedDashboardSignature(
      `node ${path.join(repo, 'scripts/ops/hermes_reliability_controller.js')}`,
      repo,
    ),
    true,
  );
  assert.equal(
    hasExpectedDashboardSignature('node /tmp/hermes_reliability_controller.js', repo),
    false,
  );
  assert.equal(
    hasExactControllerCommandSignature(
      'node scripts/ops/hermes_reliability_controller.js',
      repo,
    ),
    true,
  );
});

test('disabled-mode process discovery matches only the exact repo bridge command', () => {
  const repo = path.resolve(__dirname, '../..');
  const bridge = path.join(repo, 'scripts/ops/hermes_snapshot_bridge.js');
  const commands = new Map([
    [101, `node ${bridge}`],
    [102, `node ${path.join(repo, 'server.js')} ${bridge}`],
    [103, `node ${bridge}`],
    [104, `python3 ${bridge}`],
    [105, 'node scripts/ops/hermes_snapshot_bridge.js'],
    [106, 'node scripts/ops/hermes_snapshot_bridge.js'],
    [107, `node ${bridge}`],
  ]);
  const workingDirectories = new Map([
    [101, repo],
    [102, repo],
    [103, '/tmp'],
    [104, repo],
    [105, repo],
    [106, ''],
    [107, ''],
  ]);

  assert.equal(hasExactBridgeCommandSignature(commands.get(101), repo), true);
  assert.equal(hasExactBridgeCommandSignature(commands.get(102), repo), false);
  assert.equal(hasExactBridgeCommandSignature(commands.get(103), '/tmp'), true);
  assert.equal(hasExactBridgeCommandSignature(commands.get(104), repo), false);
  assert.equal(hasExactBridgeCommandSignature(commands.get(105), repo), true);
  assert.equal(hasExactBridgeCommandSignature(commands.get(106), ''), false);
  assert.equal(hasExactBridgeCommandSignature(commands.get(107), ''), true);
  assert.deepEqual(discoverOwnedBridgeProcessIds({
    pids: [...commands.keys()],
    commandFor: pid => commands.get(pid),
    cwdFor: pid => workingDirectories.get(pid),
    alive: () => true,
  }), [101, 103, 105, 107]);
});

test('disabled-mode reconciliation terminates discovered writers and stays degraded if one remains', async () => {
  let discoveryPass = 0;
  const terminated = [];
  const result = await reconcileDisabledBridgeProcesses({
    discover: () => {
      discoveryPass += 1;
      return discoveryPass === 1 ? [301, 302] : [302];
    },
    terminateProcess: async pid => terminated.push(pid),
  });

  assert.deepEqual(terminated, [301, 302]);
  assert.deepEqual(result, {
    verified: true,
    clean: false,
    discoveredPids: [301, 302],
    terminatedPids: [301, 302],
    remainingPids: [302],
    errorCode: 'LOCAL_DISABLED_BRIDGE_PROCESS_PRESENT',
    detail: 'Exact repo-owned bridge process still running: 302.',
  });
  assert.match(processServiceStatus('bridge', {
    pid: null,
    enabled: false,
    status: 'degraded',
    lastErrorCode: result.errorCode,
    lastDetail: result.detail,
  }).status, /degraded/);
});

test('disabled-mode reconciliation fails closed when exact-process discovery cannot be verified', async () => {
  const result = await reconcileDisabledBridgeProcesses({
    discover: () => {
      throw new Error('ps unavailable');
    },
  });
  const status = processServiceStatus('bridge', {
    pid: null,
    enabled: false,
    status: 'degraded',
    lastErrorCode: result.errorCode,
    lastDetail: result.detail,
  });

  assert.equal(result.verified, false);
  assert.equal(result.clean, false);
  assert.equal(result.errorCode, 'LOCAL_BRIDGE_PROCESS_DISCOVERY_FAILED');
  assert.equal(status.status, 'degraded');
  assert.equal(status.ready, false);
});

test('supervisor defines the Hermes bridge as a portless owned heartbeat service', () => {
  assert.equal(services.bridge.processOnly, true);
  assert.equal(services.bridge.port, undefined);
  assert.equal(services.bridge.health, undefined);
  assert.equal(services.bridge.critical, false);
  assert.match(services.bridge.args[0], /scripts\/ops\/hermes_snapshot_bridge\.js$/);
  assert.ok(services.bridge.heartbeatMaxAgeMs >= 90_000);
});

test('bridge status preserves a credential-preflight block without a running process', () => {
  const status = processServiceStatus('bridge', {
    enabled: true,
    credentialPreflightBlocked: true,
    credentialPreflightCheckedAt: '2026-07-29T18:00:00.000Z',
    nextCredentialPreflightAt: '2026-07-29T18:01:00.000Z',
    errorCode: 'AWS_PROFILE_WRONG_PRINCIPAL',
    lastDetail: 'market-dashboard-bridge resolves to the wrong AWS principal.',
    awsProfile: 'market-dashboard-bridge',
  });
  assert.equal(status.status, 'blocked');
  assert.equal(status.ready, false);
  assert.equal(status.owned, true);
  assert.equal(status.lastErrorCode, 'AWS_PROFILE_WRONG_PRINCIPAL');
  assert.equal(status.credentialPreflightBlocked, true);
  assert.equal(status.nextCredentialPreflightAt, '2026-07-29T18:01:00.000Z');
});

test('the outbound bridge is default-off and only joins the supervisor through explicit opt-in', () => {
  assert.equal(hermesBridgeEnabled({}), false);
  assert.equal(hermesBridgeEnabled({ HERMES_BRIDGE_ENABLED: 'false' }), false);
  assert.equal(hermesBridgeEnabled({ HERMES_BRIDGE_ENABLED: 'unexpected' }), false);
  assert.equal(hermesBridgeEnabled({ HERMES_BRIDGE_ENABLED: 'true' }), true);
  assert.equal(hermesBridgeEnabled({ HERMES_BRIDGE_ENABLED: 'ON' }), true);
  assert.equal(hermesBridgeEnabled({
    HERMES_OPERATIONS_BRIDGE_ENABLED: 'true',
    HERMES_PORTFOLIO_BRIDGE_ENABLED: 'false',
  }), true);
  assert.equal(hermesBridgeEnabled({
    HERMES_OPERATIONS_BRIDGE_ENABLED: 'false',
    HERMES_PORTFOLIO_BRIDGE_ENABLED: 'false',
    HERMES_BRIDGE_ENABLED: 'true',
  }), false);

  assert.deepEqual(supervisedServiceNames({}), ['sidecar', 'api', 'ui', 'controller']);
  assert.deepEqual(
    supervisedServiceNames({ HERMES_BRIDGE_ENABLED: 'true' }),
    ['sidecar', 'api', 'ui', 'controller', 'bridge'],
  );
  assert.deepEqual(processServiceStatus('bridge', {
    enabled: false,
    intentionallyDisabled: true,
    status: 'disabled',
  }), {
    pid: null,
    running: false,
    owned: true,
    healthy: true,
    ready: true,
    enabled: false,
    intentionallyDisabled: true,
    status: 'disabled',
    lastHeartbeatAt: null,
    heartbeatAgeMs: null,
    lastResultStatus: 'disabled',
    lastErrorCode: null,
    lastInputErrorCode: null,
    lastInputDetail: null,
    lastPublishErrorCode: null,
    lastPublishStage: null,
    lastPublishDetail: null,
    lastPublishFailures: [],
    lastDetail: 'Both outbound bridge partitions are disabled.',
    lastSuccessAt: null,
    lastFailureAt: null,
    awsProfile: null,
  });
});

test('supervisor heartbeat freshness rejects excessive future clock skew', () => {
  const now = Date.parse('2026-07-27T16:00:00.000Z');
  assert.equal(
    heartbeatAgeMs('2026-07-27T16:00:30.000Z', now),
    0,
  );
  assert.equal(
    heartbeatAgeMs('2026-07-27T16:00:30.001Z', now),
    null,
  );
});

test('supervisor always includes the portless shadow-default reliability controller', () => {
  assert.equal(services.controller.processOnly, true);
  assert.equal(services.controller.port, undefined);
  assert.equal(services.controller.health, undefined);
  assert.equal(services.controller.critical, false);
  assert.match(
    services.controller.args[0],
    /scripts\/ops\/hermes_reliability_controller\.js$/,
  );
  assert.ok(services.controller.heartbeatMaxAgeMs >= 120_000);
});

test('the LaunchAgent persists the default-off bridge flag and validates its profile only when enabled', () => {
  const repo = path.resolve(__dirname, '../..');
  const template = fs.readFileSync(
    path.join(repo, 'ops/launchd/com.market-dashboard.stack.plist.template'),
    'utf8',
  );
  const installer = fs.readFileSync(
    path.join(repo, 'scripts/ops/install_launchagent.sh'),
    'utf8',
  );

  assert.match(template, /<key>HERMES_BRIDGE_ENABLED<\/key>\s*<string>__HERMES_BRIDGE_ENABLED__<\/string>/);
  assert.match(template, /<key>HERMES_OPERATIONS_BRIDGE_ENABLED<\/key>\s*<string>__HERMES_OPERATIONS_BRIDGE_ENABLED__<\/string>/);
  assert.match(template, /<key>HERMES_PORTFOLIO_BRIDGE_ENABLED<\/key>\s*<string>__HERMES_PORTFOLIO_BRIDGE_ENABLED__<\/string>/);
  assert.match(template, /<key>HERMES_RELIABILITY_CONTROLLER_MODE<\/key>\s*<string>__HERMES_CONTROLLER_MODE__<\/string>/);
  assert.match(template, /<key>HERMES_RELIABILITY_ENABLED_ACTIONS<\/key>\s*<string>__HERMES_CONTROLLER_ENABLED_ACTIONS__<\/string>/);
  assert.match(installer, /BRIDGE_ENABLED="\$\{HERMES_BRIDGE_ENABLED:-false\}"/);
  assert.match(installer, /CONTROLLER_MODE="\$\{HERMES_RELIABILITY_CONTROLLER_MODE:-shadow\}"/);
  assert.match(installer, /CONTROLLER_ENABLED_ACTIONS="\$\{HERMES_RELIABILITY_ENABLED_ACTIONS:-\}"/);
  assert.match(installer, /HERMES_RELIABILITY_CONTROLLER_MODE must be shadow or active/);
  assert.match(installer, /Unknown Hermes controller action ID/);
  assert.match(installer, /if \[\[ "\$OPERATIONS_BRIDGE_ENABLED" == "false" && "\$PORTFOLIO_BRIDGE_ENABLED" == "false" \]\]; then\s+[\s\S]*?BRIDGE_AWS_PROFILE=""/);
  assert.match(installer, /s\|__HERMES_BRIDGE_ENABLED__\|\$\{bridge_enabled_xml\}\|g/);
  assert.match(installer, /s\|__HERMES_OPERATIONS_BRIDGE_ENABLED__\|\$\{operations_bridge_enabled_xml\}\|g/);
  assert.match(installer, /s\|__HERMES_PORTFOLIO_BRIDGE_ENABLED__\|\$\{portfolio_bridge_enabled_xml\}\|g/);
  assert.match(installer, /s\|__HERMES_CONTROLLER_MODE__\|\$\{controller_mode_xml\}\|g/);
  assert.match(installer, /s\|__HERMES_CONTROLLER_ENABLED_ACTIONS__\|\$\{controller_enabled_actions_xml\}\|g/);
  assert.match(installer, /\[\[ "\$OPERATIONS_BRIDGE_ENABLED" == "true" \|\| "\$PORTFOLIO_BRIDGE_ENABLED" == "true" \]\][\s\\\n]+&& \[\[ -z/);
  assert.match(installer, /\[\[ "\$OPERATIONS_BRIDGE_ENABLED" == "true" \|\| "\$PORTFOLIO_BRIDGE_ENABLED" == "true" \]\][\s\\\n]+&& \[\[ ! "\$BRIDGE_AWS_PROFILE" =~/);
  assert.match(installer, /BRIDGE_AWS_PROFILE" != "market-dashboard-bridge"/);
  assert.match(installer, /"\$NODE_PATH" "\$AWS_PREFLIGHT_PATH" \\\s+--purpose api \\\s+--profile "\$API_AWS_PROFILE"/);
  assert.match(installer, /--purpose bridge \\\s+--profile "\$BRIDGE_AWS_PROFILE"/);
  const apiPreflightIndex = installer.indexOf('--purpose api');
  const stagedPlistIndex = installer.indexOf('staged_path=');
  const stopIndex = installer.indexOf('scripts/dev-stack/cli.js" stop');
  assert.ok(apiPreflightIndex >= 0);
  assert.ok(apiPreflightIndex < stagedPlistIndex);
  assert.ok(apiPreflightIndex < stopIndex);
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

test('AWS-capable children use their dedicated profiles without ambient credentials', () => {
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
    AWS_ACCESS_KEY_ID: 'should-not-be-inherited',
    AWS_SECRET_ACCESS_KEY: 'should-not-be-inherited',
    AWS_SESSION_TOKEN: 'should-not-be-inherited',
    AWS_SHARED_CREDENTIALS_FILE: '/tmp/untrusted-credentials',
    AWS_CONFIG_FILE: '/tmp/untrusted-config',
    AWS_PROFILE: 'wrong-profile',
    AWS_REGION: 'us-east-1',
  });
  assert.equal(apiEnvironment.AWS_ACCESS_KEY_ID, undefined);
  assert.equal(apiEnvironment.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(apiEnvironment.AWS_SESSION_TOKEN, undefined);
  assert.equal(apiEnvironment.AWS_SHARED_CREDENTIALS_FILE, undefined);
  assert.equal(apiEnvironment.AWS_CONFIG_FILE, undefined);
  assert.equal(apiEnvironment.AWS_PROFILE, 'market-dashboard-local');
  assert.equal(apiEnvironment.AWS_DEFAULT_PROFILE, 'market-dashboard-local');
  assert.equal(apiEnvironment.AWS_REGION, 'us-west-1');
  assert.equal(apiEnvironment.AWS_DEFAULT_REGION, 'us-west-1');
  assert.equal(apiEnvironment.AWS_SDK_LOAD_CONFIG, '1');
  assert.equal(apiEnvironment.MARKET_DASHBOARD_AWS_PROFILE_LOCKED, 'true');
  assert.equal(apiEnvironment.NODE_ENV, 'development');

  const controllerEnvironment = childEnvironment('controller', {
    AWS_ACCESS_KEY_ID: 'must-not-reach-controller',
    AWS_SECRET_ACCESS_KEY: 'must-not-reach-controller',
    AWS_SESSION_TOKEN: 'must-not-reach-controller',
    AWS_PROFILE: 'admin',
    AWS_DEFAULT_PROFILE: 'admin',
    HERMES_RELIABILITY_CONTROLLER_MODE: 'shadow',
    HERMES_RELIABILITY_ENABLED_ACTIONS: 'prune-dashboard-logs',
  });
  assert.equal(controllerEnvironment.AWS_ACCESS_KEY_ID, undefined);
  assert.equal(controllerEnvironment.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(controllerEnvironment.AWS_SESSION_TOKEN, undefined);
  assert.equal(controllerEnvironment.AWS_PROFILE, undefined);
  assert.equal(controllerEnvironment.AWS_DEFAULT_PROFILE, undefined);
  assert.equal(controllerEnvironment.HERMES_RELIABILITY_CONTROLLER_MODE, 'shadow');
  assert.equal(
    controllerEnvironment.HERMES_RELIABILITY_ENABLED_ACTIONS,
    'prune-dashboard-logs',
  );
});

test('supervisor credential preflight pins API and bridge to their exact purposes', () => {
  const calls = [];
  const preflight = (options) => {
    calls.push(options);
    return {
      ok: true,
      purpose: options.purpose,
      profile: options.profile,
      errorCode: null,
      detail: 'approved',
    };
  };
  const inherited = {
    HERMES_BRIDGE_AWS_PROFILE: 'market-dashboard-bridge',
    AWS_ACCESS_KEY_ID: 'must-not-win',
  };

  assert.equal(preflightAwsService('api', { env: inherited, preflight }).ok, true);
  assert.equal(preflightAwsService('bridge', { env: inherited, preflight }).ok, true);
  assert.equal(preflightAwsService('ui', {
    env: inherited,
    preflight() {
      throw new Error('must not run');
    },
  }), null);
  assert.deepEqual(calls.map(({ purpose, profile }) => ({ purpose, profile })), [
    { purpose: 'api', profile: 'market-dashboard-local' },
    { purpose: 'bridge', profile: 'market-dashboard-bridge' },
  ]);
});

test('supervisor converts credential preflight failures into bounded blocked state', () => {
  const thrown = preflightAwsService('api', {
    preflight() {
      throw new Error('sensitive provider detail must not escape');
    },
  });
  assert.deepEqual(thrown, {
    ok: false,
    purpose: 'api',
    profile: 'market-dashboard-local',
    errorCode: 'AWS_PROFILE_UNUSABLE',
    detail: 'market-dashboard-local could not be validated.',
  });

  const blocked = credentialPreflightFailureState('bridge', {
    ok: false,
    purpose: 'bridge',
    profile: 'market-dashboard-bridge',
    errorCode: 'AWS_PROFILE_STATIC_SESSION_REJECTED',
    detail: 'Use the approved durable provider.',
  }, {
    previous: { restarts: 2, pid: 987 },
    now: Date.parse('2026-07-29T18:00:00.000Z'),
    retryMs: 60_000,
  });
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.pid, null);
  assert.equal(blocked.restarts, 2);
  assert.equal(blocked.healthFailures, 0);
  assert.equal(blocked.credentialPreflightBlocked, true);
  assert.equal(blocked.errorCode, 'AWS_PROFILE_STATIC_SESSION_REJECTED');
  assert.equal(blocked.lastPublishErrorCode, 'AWS_PROFILE_STATIC_SESSION_REJECTED');
  assert.equal(blocked.awsProfile, 'market-dashboard-bridge');
  assert.equal(blocked.credentialPreflightCheckedAt, '2026-07-29T18:00:00.000Z');
  assert.equal(blocked.nextCredentialPreflightAt, '2026-07-29T18:01:00.000Z');
  assert.doesNotMatch(JSON.stringify(blocked), /AKIA|must-not-win|sensitive provider detail/i);
});

test('the API profile lock is enforced after dotenv and before the AWS SDK loads', () => {
  const repo = path.resolve(__dirname, '../..');
  const serverSource = fs.readFileSync(path.join(repo, 'server.js'), 'utf8');
  const dotenvIndex = serverSource.indexOf("require('dotenv').config()");
  const lockIndex = serverSource.indexOf("process.env.MARKET_DASHBOARD_AWS_PROFILE_LOCKED === 'true'");
  const awsSdkIndex = serverSource.indexOf("require('aws-sdk/global')");

  assert.ok(dotenvIndex >= 0);
  assert.ok(lockIndex > dotenvIndex);
  assert.ok(awsSdkIndex > lockIndex);
  assert.match(serverSource, /delete process\.env\[key\]/);
});

test('local notifications emit once per failure and once on recovery', () => {
  const disabled = planServiceNotificationTransition({
    name: 'bridge',
    serviceState: { status: 'disabled', intentionallyDisabled: true },
    observedAt: '2026-07-25T14:59:00.000Z',
  });
  assert.equal(disabled.event, null);
  assert.equal(disabled.next.phase, 'ready');

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

test('controller activity reports process health without treating monitored incidents as process failure', () => {
  const item = {};
  assert.equal(applyControllerStatusPayload(item, {
    service: 'hermes-reliability-controller',
    observedAt: '2026-07-27T16:00:00.000Z',
    status: 'ready',
    mode: 'shadow',
    enabledActionIds: [],
    buildFingerprint: 'a'.repeat(64),
    shadowSoakStartedAt: '2026-07-27T15:00:00.000Z',
    controllerStatus: 'shadow',
    errorCode: null,
    incidentCount: 8,
    circuitCount: 1,
    nextRetryAt: '2026-07-27T17:00:00.000Z',
  }), true);
  assert.equal(item.lastResultStatus, 'ready');
  assert.equal(item.mode, 'shadow');
  assert.equal(item.incidentCount, 8);
  assert.equal(item.circuitCount, 1);
  assert.deepEqual(item.enabledActionIds, []);
  assert.equal(item.buildFingerprint, 'a'.repeat(64));
  assert.equal(item.shadowSoakStartedAt, '2026-07-27T15:00:00.000Z');
  assert.equal(item.lastErrorCode, null);

  assert.equal(applyControllerStatusPayload(item, {
    service: 'hermes-reliability-controller',
    observedAt: '2026-07-27T16:01:00.000Z',
    status: 'degraded',
    mode: 'shadow',
    controllerStatus: 'degraded',
    errorCode: 'READINESS_TELEMETRY_STALE',
    detail: 'Readiness is stale.',
  }), true);
  assert.equal(item.lastResultStatus, 'error');
  assert.equal(item.lastErrorCode, 'READINESS_TELEMETRY_STALE');
  assert.equal(item.lastDetail, 'Readiness is stale.');
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
