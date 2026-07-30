'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const manifest = require('../../ops/services.json');
const {
  ACTIVE_MODE,
  CONTROLLER_BUILD_FINGERPRINT,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_READINESS_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_STATE_FILE,
  DEFAULT_TELEMETRY_MAX_AGE_MS,
  SHADOW_MODE,
  compilePolicies,
  controllerHeartbeat,
  createController,
  createDefaultIo,
  eligibleActions,
  evaluatePrerequisites,
  newState,
  normalizeEnabledActionIds,
  normalizeMode,
  observeReport,
  policyValidationErrors,
  pruneDashboardLogs,
  readState,
  readinessUrls,
  reportFreshness,
  restoreState,
  sendMacNotification,
  writeStateAtomically,
} = require('./hermes_reliability_controller');

const BASE_TIME = Date.parse('2026-07-27T16:00:00.000Z');
const ALL_ACTION_IDS = compilePolicies(manifest).map((policy) => policy.id);

function check(id, status = 'pass', now = BASE_TIME, overrides = {}) {
  return {
    id,
    label: id,
    status,
    blocking: false,
    summary: status === 'pass' ? 'Verified.' : 'Unavailable.',
    errorCode: status === 'pass' ? null : 'FAILED',
    observedAt: new Date(now).toISOString(),
    dependsOn: [],
    capabilityIds: [],
    provenance: null,
    recovery: null,
    ...overrides,
  };
}

function report({
  now = BASE_TIME,
  checks = [],
  rootCauses = [],
} = {}) {
  const failed = checks.filter((item) => item.status === 'fail').length;
  const warnings = checks.filter((item) => item.status === 'warn').length;
  return {
    version: 1,
    status: failed ? 'degraded' : 'ready',
    ready: failed === 0,
    operational: true,
    fullyOperational: failed === 0 && warnings === 0,
    checkedAt: new Date(now).toISOString(),
    summary: {
      passed: checks.length - failed - warnings,
      warnings,
      failed,
      total: checks.length,
      blockingFailures: 0,
    },
    groups: [{ id: 'test', label: 'Test', checks }],
    capabilities: [],
    rootCauses,
  };
}

function cause(errorCode, checkId, affectedCheckIds = [checkId]) {
  return {
    id: errorCode,
    errorCode,
    checkId,
    label: checkId,
    status: 'fail',
    summary: `${checkId} failed.`,
    owner: 'local-operations',
    capabilityIds: [],
    affectedCheckIds,
    recovery: {
      kind: 'command',
      automatic: true,
      actionId: 'start-local-stack',
      label: 'Repair.',
      command: 'fixed',
    },
  };
}

function controllerHarness({
  mode = ACTIVE_MODE,
  reports,
  nowRef,
  dispatch = async () => ({ accepted: true }),
  initialState = null,
  enabledActionIds = mode === ACTIVE_MODE ? ALL_ACTION_IDS : [],
} = {}) {
  const saved = [];
  const emitted = [];
  const notifications = [];
  const queue = [...reports];
  const controller = createController({
    mode,
    enabledActionIds,
    state: initialState || newState({
      mode,
      now: nowRef.value,
      enabledActionIds,
    }),
    now: () => nowRef.value,
    sleep: async () => {},
    io: {
      fetchReadiness: async () => {
        assert.ok(queue.length > 0, 'test readiness queue exhausted');
        return queue.shift();
      },
      dispatch,
    },
    persist: (state) => saved.push(JSON.parse(JSON.stringify(state))),
    emit: (payload) => emitted.push(payload),
    notifier: (event) => {
      notifications.push(event);
      return { delivered: true };
    },
  });
  return { controller, saved, emitted, notifications, queue };
}

test('controller policy manifest is complete, low risk, and exact-code allowlisted', () => {
  assert.deepEqual(policyValidationErrors(manifest), []);
  const policies = compilePolicies(manifest);
  assert.equal(policies.length, 7);
  assert.ok(policies.every((policy) => policy.maxAttempts === 2));
  assert.ok(policies.every((policy) => policy.attemptWindowMs === 3_600_000));
  assert.ok(policies.every((policy) => policy.circuitDurationMs === 3_600_000));

  const gmail = policies.find((policy) => policy.id === 'retry-gmail-poll');
  assert.deepEqual(gmail.triggeringErrorCodes.sort(), [
    'GMAIL_PROVIDER_UNAVAILABLE',
    'GMAIL_RATE_LIMITED',
    'GMAIL_TRANSIENT_ERROR',
  ]);
  for (const forbidden of [
    'GMAIL_AUTH_REQUIRED',
    'GMAIL_HEARTBEAT_WRITE_FAILED',
    'GMAIL_INVOCATION_TIMEOUT',
    'GMAIL_OAUTH_CLIENT_DISABLED',
    'GMAIL_SCHEDULE_MISSING',
    'GMAIL_SCHEDULER_PROVENANCE_INVALID',
  ]) {
    assert.equal(gmail.triggeringErrorCodes.includes(forbidden), false);
  }

  const everyTrigger = policies.flatMap((policy) => policy.triggeringErrorCodes);
  assert.equal(everyTrigger.some((code) => /IAM|OAUTH|DEPLOY|LOGIN|ORDER|TRADING/.test(code)), false);

  const catalog = policies.find(
    (policy) => policy.id === 'reconcile-prediction-catalog',
  );
  assert.deepEqual(catalog.triggeringCheckIds, ['prediction.ibkrExecution']);
  assert.deepEqual(catalog.triggeringErrorCodes.sort(), [
    'CATALOG_NOT_PROMOTED',
    'NO_CURRENT_EXECUTABLE_IBKR_CONTRACT',
  ]);
  assert.deepEqual(
    catalog.prerequisites.find(
      (item) => item.checkId === 'prediction.display',
    ).allowedErrorCodes,
    [null, 'CATALOG_NOT_PROMOTED', 'NO_CURRENT_NATIVE_LIVE_QUOTE'],
  );
});

test('mode is fail-closed to shadow unless active is explicit', () => {
  assert.equal(normalizeMode(), SHADOW_MODE);
  assert.equal(normalizeMode('unexpected'), SHADOW_MODE);
  assert.equal(normalizeMode('ACTIVE'), ACTIVE_MODE);
  assert.match(DEFAULT_STATE_FILE, /Library\/Application Support\/market-dashboard\/readiness-controller\.json$/);
  assert.match(CONTROLLER_BUILD_FINGERPRINT, /^[a-f0-9]{64}$/);
  assert.equal(DEFAULT_READINESS_TIMEOUT_MS, 120_000);
  assert.equal(DEFAULT_TELEMETRY_MAX_AGE_MS, 8 * 60_000);
  assert.ok(DEFAULT_REQUEST_TIMEOUT_MS > 5 * 60 * 1_000);
  assert.ok(DEFAULT_POLL_INTERVAL_MS <= 2 * 60 * 1_000);
  assert.equal(
    readinessUrls({ MARKET_DASHBOARD_API_URL: 'http://127.0.0.1:3001' }).readinessUrl,
    'http://127.0.0.1:3001/api/system-readiness',
  );
  assert.throws(
    () => readinessUrls({ MARKET_DASHBOARD_API_URL: 'https://dashboard.example.com' }),
    /loopback HTTP origin/,
  );
  assert.deepEqual(normalizeEnabledActionIds('restart-local-stack,start-local-stack'), [
    'restart-local-stack',
    'start-local-stack',
  ]);
  assert.throws(
    () => normalizeEnabledActionIds('unknown-action'),
    /Unknown Hermes controller action ID/,
  );
});

test('controller polls cached readiness without a forced-refresh query', async () => {
  const requests = [];
  const expected = report({ checks: [check('dashboard.api')] });
  const io = createDefaultIo({
    env: { MARKET_DASHBOARD_API_URL: 'http://127.0.0.1:3001' },
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(expected),
      };
    },
  });

  assert.deepEqual(await io.fetchReadiness(), expected);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'http://127.0.0.1:3001/api/system-readiness');
  assert.equal(new URL(requests[0].url).search, '');
});

test('a changed controller build restarts the shadow soak window', () => {
  const state = newState({ mode: SHADOW_MODE, now: BASE_TIME });
  state.buildFingerprint = '0'.repeat(64);
  state.shadowSoakStartedAt = new Date(BASE_TIME - 86_400_000).toISOString();

  const restored = restoreState(state, {
    mode: SHADOW_MODE,
    now: BASE_TIME + 5_000,
  });

  assert.equal(restored.buildFingerprint, CONTROLLER_BUILD_FINGERPRINT);
  assert.equal(
    restored.shadowSoakStartedAt,
    new Date(BASE_TIME + 5_000).toISOString(),
  );
});

test('requires two matching observations at least sixty seconds apart', () => {
  const policies = compilePolicies(manifest);
  const state = newState({
    mode: ACTIVE_MODE,
    now: BASE_TIME,
    enabledActionIds: ['start-local-stack'],
  });
  const failed = report({
    now: BASE_TIME,
    checks: [
      check('dashboard.ui', 'fail', BASE_TIME, { errorCode: 'DASHBOARD_UI_UNREACHABLE' }),
      check('dashboard.supervisor', 'pass', BASE_TIME),
    ],
    rootCauses: [cause('DASHBOARD_UI_UNREACHABLE', 'dashboard.ui')],
  });
  let observation = observeReport(state, failed, {
    policies,
    now: BASE_TIME,
  });
  assert.equal(state.incidents[0].observationCount, 1);
  assert.equal(eligibleActions(state, observation.checksById, {
    policies,
    now: BASE_TIME,
    mode: ACTIVE_MODE,
  }).length, 0);

  observation = observeReport(state, failed, {
    policies,
    now: BASE_TIME + 59_999,
  });
  assert.equal(state.incidents[0].observationCount, 1);
  assert.equal(eligibleActions(state, observation.checksById, {
    policies,
    now: BASE_TIME + 59_999,
    mode: ACTIVE_MODE,
  }).length, 0);

  observation = observeReport(state, failed, {
    policies,
    now: BASE_TIME + 60_000,
  });
  assert.equal(state.incidents[0].observationCount, 2);
  assert.equal(eligibleActions(state, observation.checksById, {
    policies,
    now: BASE_TIME + 60_000,
    mode: ACTIVE_MODE,
  })[0].policy.id, 'start-local-stack');
});

test('active mode dispatch is fail-closed to explicitly enabled action classes', () => {
  const policies = compilePolicies(manifest);
  const state = newState({ mode: ACTIVE_MODE, now: BASE_TIME });
  const failed = report({
    now: BASE_TIME,
    checks: [
      check('dashboard.ui', 'fail', BASE_TIME, {
        errorCode: 'DASHBOARD_UI_UNREACHABLE',
      }),
      check('dashboard.supervisor', 'pass', BASE_TIME),
    ],
    rootCauses: [cause('DASHBOARD_UI_UNREACHABLE', 'dashboard.ui')],
  });
  observeReport(state, failed, { policies, now: BASE_TIME });
  const observation = observeReport(state, failed, {
    policies,
    now: BASE_TIME + 60_000,
  });

  assert.deepEqual(eligibleActions(state, observation.checksById, {
    policies,
    now: BASE_TIME + 60_000,
    mode: ACTIVE_MODE,
  }), []);
  assert.equal(state.incidents[0].status, 'suppressed');
  assert.equal(state.incidents[0].suppressionReason, 'ACTION_CLASS_DISABLED');

  assert.equal(eligibleActions(state, observation.checksById, {
    policies,
    now: BASE_TIME + 60_000,
    mode: ACTIVE_MODE,
    enabledActionIds: ['start-local-stack'],
  })[0].policy.id, 'start-local-stack');
});

test('active controller dispatches one action and resolves only after two clean observations', async () => {
  const nowRef = { value: BASE_TIME };
  const failedAt = (now) => report({
    now,
    checks: [
      check('dashboard.ui', 'fail', now, { errorCode: 'DASHBOARD_UI_UNREACHABLE' }),
      check('dashboard.supervisor', 'pass', now),
    ],
    rootCauses: [cause('DASHBOARD_UI_UNREACHABLE', 'dashboard.ui')],
  });
  const cleanAt = (now) => report({
    now,
    checks: [
      check('dashboard.ui', 'pass', now),
      check('dashboard.supervisor', 'pass', now),
    ],
  });
  const dispatched = [];
  const harness = controllerHarness({
    nowRef,
    reports: [
      failedAt(BASE_TIME),
      failedAt(BASE_TIME + 60_000),
      cleanAt(BASE_TIME + 60_000),
      cleanAt(BASE_TIME + 120_000),
    ],
    dispatch: async (policy) => {
      dispatched.push(policy.id);
      return { accepted: true, acceptedAt: new Date(nowRef.value).toISOString() };
    },
  });

  await harness.controller.tick();
  assert.deepEqual(dispatched, []);
  nowRef.value += 60_000;
  await harness.controller.tick();
  assert.deepEqual(dispatched, ['start-local-stack']);
  assert.equal(harness.controller.state.incidents[0].status, 'verifying');
  assert.equal(harness.controller.state.incidents[0].cleanObservationCount, 1);
  nowRef.value += 60_000;
  await harness.controller.tick();
  assert.equal(harness.controller.state.incidents[0].status, 'resolved');
  assert.equal(harness.controller.state.incidents[0].verificationOutcome, 'verified-clean');
  assert.deepEqual(
    harness.notifications.map((event) => event.kind),
    ['opening', 'recovery'],
  );
});

test('shadow mode records eligibility once and never dispatches', async () => {
  const nowRef = { value: BASE_TIME };
  const failedAt = (now) => report({
    now,
    checks: [
      check('dashboard.ui', 'fail', now, { errorCode: 'DASHBOARD_UI_UNREACHABLE' }),
      check('dashboard.supervisor', 'pass', now),
    ],
    rootCauses: [cause('DASHBOARD_UI_UNREACHABLE', 'dashboard.ui')],
  });
  let dispatches = 0;
  const harness = controllerHarness({
    mode: SHADOW_MODE,
    nowRef,
    reports: [failedAt(BASE_TIME), failedAt(BASE_TIME + 60_000), failedAt(BASE_TIME + 120_000)],
    dispatch: async () => {
      dispatches += 1;
      return { accepted: true };
    },
  });
  await harness.controller.tick();
  nowRef.value += 60_000;
  await harness.controller.tick();
  nowRef.value += 60_000;
  await harness.controller.tick();
  assert.equal(dispatches, 0);
  assert.equal(harness.controller.state.actions.filter((item) => item.outcome === 'shadowed').length, 1);
  assert.equal(harness.controller.state.incidents[0].status, 'shadow');
});

test('only root causes become incidents and dependent failures are explicitly suppressed', () => {
  const policies = compilePolicies(manifest);
  const state = newState({ now: BASE_TIME });
  const failed = report({
    now: BASE_TIME,
    checks: [
      check('gmail.ingestion', 'fail', BASE_TIME, { errorCode: 'GMAIL_SCHEDULE_MISSING' }),
      check('research.rta', 'fail', BASE_TIME, {
        errorCode: 'RTA_PROJECTION_UNAVAILABLE',
        dependsOn: ['gmail.ingestion'],
      }),
    ],
    rootCauses: [
      cause('GMAIL_SCHEDULE_MISSING', 'gmail.ingestion', [
        'gmail.ingestion',
        'research.rta',
      ]),
    ],
  });
  observeReport(state, failed, { policies, now: BASE_TIME });
  assert.deepEqual(state.incidents.map((item) => item.checkId), ['gmail.ingestion']);
  assert.deepEqual(state.suppressions, [{
    checkId: 'research.rta',
    errorCode: 'RTA_PROJECTION_UNAVAILABLE',
    reason: 'DEPENDENT_SYMPTOM',
    rootCauseIds: ['gmail.ingestion:GMAIL_SCHEDULE_MISSING'],
  }]);
  assert.equal(state.incidents[0].status, 'manual');
});

test('Gmail retry requires fresh genuine Scheduler provenance', () => {
  const policy = compilePolicies(manifest)
    .find((item) => item.id === 'retry-gmail-poll');
  const observedAt = new Date(BASE_TIME).toISOString();
  const good = check('gmail.ingestion', 'fail', BASE_TIME, {
    errorCode: 'GMAIL_TRANSIENT_ERROR',
    observedAt,
    provenance: {
      heartbeatSource: 'aws-lambda',
      triggerSource: 'aws-scheduler',
      scheduleId: 'market-dashboard-gmail-v2-every-15m',
    },
  });
  assert.equal(
    evaluatePrerequisites(policy, new Map([[good.id, good]]), BASE_TIME).ok,
    true,
  );
  const manual = {
    ...good,
    provenance: { ...good.provenance, triggerSource: 'readiness-repair' },
  };
  assert.deepEqual(
    evaluatePrerequisites(policy, new Map([[manual.id, manual]]), BASE_TIME),
    {
      ok: false,
      reason: 'PREREQUISITE_PROVENANCE_UNVERIFIED',
      detail: 'gmail.ingestion:triggerSource',
    },
  );
});

test('catalog IAM denial is suppressed without making display health circular', () => {
  const policy = compilePolicies(manifest)
    .find((item) => item.id === 'reconcile-prediction-catalog');
  const baseChecks = [
    check('ibkr.sidecar', 'pass', BASE_TIME),
    check('ibkr.gateway', 'pass', BASE_TIME),
  ];
  const unpromotedDisplay = check('prediction.display', 'fail', BASE_TIME, {
    errorCode: 'NO_CURRENT_NATIVE_LIVE_QUOTE',
  });
  assert.equal(
    evaluatePrerequisites(
      policy,
      new Map([...baseChecks, unpromotedDisplay].map((item) => [item.id, item])),
      BASE_TIME,
    ).ok,
    true,
  );

  const deniedDisplay = {
    ...unpromotedDisplay,
    errorCode: 'PREDICTION_CATALOG_ACCESS_DENIED',
  };
  assert.deepEqual(
    evaluatePrerequisites(
      policy,
      new Map([...baseChecks, deniedDisplay].map((item) => [item.id, item])),
      BASE_TIME,
    ),
    {
      ok: false,
      reason: 'PREREQUISITE_ERROR_CODE_NOT_ALLOWED',
      detail: 'prediction.display:PREDICTION_CATALOG_ACCESS_DENIED',
    },
  );
});

test('fresh report is required even when a cause is otherwise actionable', async () => {
  const nowRef = { value: BASE_TIME + 10 * 60_000 };
  const stale = report({
    now: BASE_TIME,
    checks: [
      check('dashboard.ui', 'fail', BASE_TIME, { errorCode: 'DASHBOARD_UI_UNREACHABLE' }),
      check('dashboard.supervisor', 'pass', BASE_TIME),
    ],
    rootCauses: [cause('DASHBOARD_UI_UNREACHABLE', 'dashboard.ui')],
  });
  assert.equal(reportFreshness(stale, { now: nowRef.value }).fresh, false);
  let dispatches = 0;
  const harness = controllerHarness({
    nowRef,
    reports: [stale],
    dispatch: async () => {
      dispatches += 1;
      return { accepted: true };
    },
  });
  await harness.controller.tick();
  assert.equal(dispatches, 0);
  assert.equal(harness.controller.state.status, 'degraded');
  assert.equal(
    harness.controller.state.lastError.errorCode,
    'READINESS_TELEMETRY_STALE',
  );
});

test('evaluates a delayed readiness response when the completed report is observed', async () => {
  const nowRef = { value: BASE_TIME };
  const controller = createController({
    mode: SHADOW_MODE,
    enabledActionIds: [],
    state: newState({ mode: SHADOW_MODE, now: nowRef.value }),
    now: () => nowRef.value,
    sleep: async () => {},
    io: {
      fetchReadiness: async () => {
        nowRef.value += 45_000;
        return report({
          now: nowRef.value,
          checks: [check('dashboard.ui', 'pass', nowRef.value)],
        });
      },
      dispatch: async () => ({ accepted: true }),
    },
    persist: () => {},
    emit: () => {},
    notifier: () => ({ delivered: true }),
  });

  await controller.tick();

  assert.equal(controller.state.lastError, null);
  assert.equal(controller.state.status, 'shadow');
  assert.equal(
    controller.state.lastSuccessfulPollAt,
    new Date(BASE_TIME + 45_000).toISOString(),
  );
  assert.equal(
    controller.state.lastReadinessAt,
    new Date(BASE_TIME + 45_000).toISOString(),
  );
});

test('two attempts in one hour open a one-hour circuit without a third dispatch', () => {
  const policies = compilePolicies(manifest);
  const policy = policies.find((item) => item.id === 'start-local-stack');
  const state = newState({ mode: ACTIVE_MODE, now: BASE_TIME });
  state.incidents = [{
    id: 'dashboard.ui:DASHBOARD_UI_UNREACHABLE',
    checkId: 'dashboard.ui',
    errorCode: 'DASHBOARD_UI_UNREACHABLE',
    label: 'Dashboard UI',
    summary: 'Unavailable.',
    owner: 'local-operations',
    actionId: policy.id,
    status: 'open',
    openedAt: new Date(BASE_TIME - 120_000).toISOString(),
    lastSeenAt: new Date(BASE_TIME).toISOString(),
    lastMatchingObservationAt: new Date(BASE_TIME).toISOString(),
    observationCount: 3,
    cleanObservationCount: 0,
    notifications: {},
  }];
  state.actions = [1, 2].map((number) => ({
    id: `attempt-${number}`,
    incidentId: state.incidents[0].id,
    actionId: policy.id,
    startedAt: new Date(BASE_TIME - number * 60_000).toISOString(),
    completedAt: new Date(BASE_TIME - number * 60_000 + 1_000).toISOString(),
    outcome: 'failed',
  }));
  const checks = new Map([
    ['dashboard.ui', check('dashboard.ui', 'fail', BASE_TIME)],
    ['dashboard.supervisor', check('dashboard.supervisor', 'pass', BASE_TIME)],
  ]);
  const events = [];
  assert.equal(eligibleActions(state, checks, {
    policies,
    now: BASE_TIME,
    mode: ACTIVE_MODE,
    notifier: (event) => {
      events.push(event);
      return { delivered: true };
    },
  }).length, 0);
  assert.equal(state.incidents[0].status, 'circuit_open');
  assert.equal(
    state.incidents[0].circuitOpenUntil,
    new Date(BASE_TIME + 3_600_000).toISOString(),
  );
  assert.deepEqual(events.map((event) => event.kind), ['circuit']);
});

test('persisted in-flight work keeps a global recovery hold after restart', () => {
  const state = newState({ mode: ACTIVE_MODE, now: BASE_TIME });
  state.incidents = [{
    id: 'dashboard.runtime:DASHBOARD_CODE_VERSION_DRIFT',
    checkId: 'dashboard.runtime',
    errorCode: 'DASHBOARD_CODE_VERSION_DRIFT',
    actionId: 'restart-local-stack',
    status: 'verifying',
  }];
  state.actions = [{
    id: 'restart-local-stack:1',
    incidentId: state.incidents[0].id,
    actionId: 'restart-local-stack',
    startedAt: new Date(BASE_TIME).toISOString(),
    completedAt: null,
    outcome: 'running',
  }];
  state.inFlight = {
    actionRecordId: state.actions[0].id,
    incidentId: state.incidents[0].id,
    actionId: 'restart-local-stack',
    startedAt: new Date(BASE_TIME).toISOString(),
    settleTimeoutMs: 30_000,
    cooldownMs: 600_000,
  };
  const restored = restoreState(state, {
    mode: ACTIVE_MODE,
    now: BASE_TIME + 5_000,
  });
  assert.equal(restored.inFlight.recoveryHold, true);
  assert.equal(restored.inFlight.phase, 'controller-restart-recovery');
  assert.equal(
    restored.inFlight.releaseAfter,
    new Date(BASE_TIME + 630_000).toISOString(),
  );
  assert.equal(restored.actions[0].outcome, 'uncertain');
  assert.equal(restored.actions[0].completedAt, null);
  assert.equal(restored.incidents[0].status, 'verifying');
  assert.equal(
    restored.incidents[0].nextRetryAt,
    new Date(BASE_TIME + 630_000).toISOString(),
  );
});

test('restart recovery hold blocks every incident until deadline and a fresh verification', async () => {
  const nowRef = { value: BASE_TIME + 5_000 };
  const raw = newState({ mode: ACTIVE_MODE, now: BASE_TIME });
  raw.incidents = [{
    id: 'dashboard.runtime:DASHBOARD_CODE_VERSION_DRIFT',
    checkId: 'dashboard.runtime',
    errorCode: 'DASHBOARD_CODE_VERSION_DRIFT',
    actionId: 'restart-local-stack',
    status: 'verifying',
    openedAt: new Date(BASE_TIME - 60_000).toISOString(),
    lastSeenAt: new Date(BASE_TIME).toISOString(),
    lastMatchingObservationAt: new Date(BASE_TIME).toISOString(),
    observationCount: 2,
    cleanObservationCount: 0,
    notifications: {},
  }];
  raw.actions = [{
    id: 'restart-local-stack:1',
    incidentId: raw.incidents[0].id,
    actionId: 'restart-local-stack',
    startedAt: new Date(BASE_TIME).toISOString(),
    completedAt: null,
    outcome: 'running',
  }];
  raw.inFlight = {
    actionRecordId: raw.actions[0].id,
    incidentId: raw.incidents[0].id,
    actionId: 'restart-local-stack',
    startedAt: new Date(BASE_TIME).toISOString(),
    settleTimeoutMs: 30_000,
    cooldownMs: 600_000,
  };
  const failedAt = (now) => report({
    now,
    checks: [
      check('dashboard.runtime', 'fail', now, {
        errorCode: 'DASHBOARD_CODE_VERSION_DRIFT',
      }),
      check('dashboard.supervisor', 'pass', now),
      check('dashboard.ui', 'fail', now, {
        errorCode: 'DASHBOARD_UI_UNREACHABLE',
      }),
    ],
    rootCauses: [
      cause('DASHBOARD_CODE_VERSION_DRIFT', 'dashboard.runtime'),
      cause('DASHBOARD_UI_UNREACHABLE', 'dashboard.ui'),
    ],
  });
  const dispatches = [];
  const harness = controllerHarness({
    nowRef,
    initialState: raw,
    reports: [
      failedAt(nowRef.value),
      failedAt(BASE_TIME + 630_000),
      failedAt(BASE_TIME + 690_000),
    ],
    dispatch: async (policy) => {
      dispatches.push(policy.id);
      return { accepted: true };
    },
  });

  await harness.controller.tick();
  assert.equal(harness.controller.state.inFlight.recoveryHold, true);
  assert.deepEqual(dispatches, []);

  nowRef.value = BASE_TIME + 630_000;
  await harness.controller.tick();
  assert.equal(harness.controller.state.inFlight, null);
  assert.deepEqual(dispatches, []);

  nowRef.value = BASE_TIME + 690_000;
  await harness.controller.tick();
  assert.equal(dispatches.length, 1);
});

test('state-write failure blocks dispatch and does not terminate the controller', async () => {
  const nowRef = { value: BASE_TIME };
  const failedAt = (now) => report({
    now,
    checks: [
      check('dashboard.ui', 'fail', now, {
        errorCode: 'DASHBOARD_UI_UNREACHABLE',
      }),
      check('dashboard.supervisor', 'pass', now),
    ],
    rootCauses: [cause('DASHBOARD_UI_UNREACHABLE', 'dashboard.ui')],
  });
  let writes = 0;
  let dispatches = 0;
  const controller = createController({
    mode: ACTIVE_MODE,
    enabledActionIds: ['start-local-stack'],
    state: newState({ mode: ACTIVE_MODE, now: BASE_TIME }),
    now: () => nowRef.value,
    sleep: async () => {},
    io: {
      fetchReadiness: async () => failedAt(nowRef.value),
      dispatch: async () => {
        dispatches += 1;
        return { accepted: true };
      },
    },
    persist: () => {
      writes += 1;
      if (writes >= 2) {
        const error = new Error('No space left on device');
        error.code = 'ENOSPC';
        throw error;
      }
    },
    emit: () => {},
    notifier: () => ({ delivered: true }),
  });

  await controller.tick();
  nowRef.value += 60_000;
  await controller.tick();

  assert.equal(dispatches, 0);
  assert.equal(controller.state.persistenceBlocked, true);
  assert.equal(
    controller.state.lastError.errorCode,
    'CONTROLLER_STATE_WRITE_FAILED',
  );
  assert.equal(
    controller.state.actions[0].outcome,
    'not_dispatched',
  );
  await assert.doesNotReject(controller.tick());
  assert.equal(dispatches, 0);
});

test('post-dispatch persistence failure retains a global recovery hold', async () => {
  const nowRef = { value: BASE_TIME };
  const failedAt = (now) => report({
    now,
    checks: [
      check('dashboard.ui', 'fail', now, {
        errorCode: 'DASHBOARD_UI_UNREACHABLE',
      }),
      check('dashboard.supervisor', 'pass', now),
    ],
    rootCauses: [cause('DASHBOARD_UI_UNREACHABLE', 'dashboard.ui')],
  });
  let writes = 0;
  let dispatches = 0;
  const controller = createController({
    mode: ACTIVE_MODE,
    enabledActionIds: ['start-local-stack'],
    state: newState({ mode: ACTIVE_MODE, now: BASE_TIME }),
    now: () => nowRef.value,
    sleep: async () => {},
    io: {
      fetchReadiness: async () => failedAt(nowRef.value),
      dispatch: async () => {
        dispatches += 1;
        return { accepted: true };
      },
    },
    persist: () => {
      writes += 1;
      if (writes >= 3 && writes <= 4) {
        const error = new Error('No space left on device');
        error.code = 'ENOSPC';
        throw error;
      }
    },
    emit: () => {},
    notifier: () => ({ delivered: true }),
  });

  await controller.tick();
  nowRef.value += 60_000;
  await controller.tick();

  assert.equal(dispatches, 1);
  assert.equal(controller.state.inFlight.recoveryHold, true);
  assert.equal(controller.state.persistenceBlocked, true);

  nowRef.value += 60_000;
  await controller.tick();
  assert.equal(dispatches, 1);
  assert.equal(controller.state.inFlight.recoveryHold, true);
});

test('an error code on an unrelated check cannot select a check-scoped action', () => {
  const policies = compilePolicies(manifest);
  const state = newState({ mode: ACTIVE_MODE, now: BASE_TIME });
  observeReport(state, report({
    now: BASE_TIME,
    checks: [
      check('prediction.display', 'fail', BASE_TIME, {
        errorCode: 'CATALOG_NOT_PROMOTED',
      }),
    ],
    rootCauses: [
      cause('CATALOG_NOT_PROMOTED', 'prediction.display'),
    ],
  }), { policies, now: BASE_TIME });

  assert.equal(state.incidents[0].actionId, null);
  assert.equal(state.incidents[0].status, 'manual');
});

test('state is atomically persisted with mode 0600', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-controller-state-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'readiness-controller.json');
  const state = newState({ now: BASE_TIME });
  const result = writeStateAtomically(target, state, {
    processId: 42,
    random: () => 0.123,
  });
  assert.equal(result.ok, true);
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  assert.deepEqual(readState(target), state);
  assert.deepEqual(
    fs.readdirSync(directory).filter((name) => name.includes('.tmp-')),
    [],
  );
});

test('log pruning removes only old rotations of declared dashboard logs', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-controller-logs-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'api.log'), 'active');
  fs.writeFileSync(path.join(directory, 'api.log.1'), 'one');
  fs.writeFileSync(path.join(directory, 'api.log.3'), 'three');
  fs.writeFileSync(path.join(directory, 'controller.log.5'), 'five');
  fs.writeFileSync(path.join(directory, 'unrelated.log.9'), 'keep');
  fs.mkdirSync(path.join(directory, 'api.log.9'));
  fs.symlinkSync(path.join(directory, 'unrelated.log.9'), path.join(directory, 'ui.log.9'));

  const result = pruneDashboardLogs({ logDir: directory });
  assert.deepEqual(result.removed, ['api.log.3', 'controller.log.5']);
  assert.equal(fs.existsSync(path.join(directory, 'api.log')), true);
  assert.equal(fs.existsSync(path.join(directory, 'api.log.1')), true);
  assert.equal(fs.existsSync(path.join(directory, 'unrelated.log.9')), true);
  assert.equal(fs.existsSync(path.join(directory, 'api.log.9')), true);
  assert.equal(fs.lstatSync(path.join(directory, 'ui.log.9')).isSymbolicLink(), true);
});

test('macOS notifications use argv and incident notification state deduplicates transitions', () => {
  let invocation;
  const delivered = sendMacNotification({
    title: 'Quoted "title"',
    body: 'Literal $(touch /tmp/not-run)',
  }, {
    platform: 'darwin',
    execute(file, args, options) {
      invocation = { file, args, options };
    },
  });
  assert.equal(delivered.delivered, true);
  assert.equal(invocation.file, '/usr/bin/osascript');
  assert.equal(invocation.args.at(-2), 'Quoted "title"');
  assert.equal(invocation.args.at(-1), 'Literal $(touch /tmp/not-run)');
});

test('heartbeat reports controller health separately from the incidents it monitors', () => {
  const state = newState({ mode: SHADOW_MODE, now: BASE_TIME });
  state.incidents.push({ status: 'shadow' });
  const heartbeat = controllerHeartbeat(state);
  assert.equal(heartbeat.status, 'ready');
  assert.equal(heartbeat.mode, 'shadow');
  assert.equal(heartbeat.incidentCount, 1);

  state.lastError = {
    errorCode: 'READINESS_TELEMETRY_STALE',
    detail: 'Stale.',
  };
  assert.deepEqual(controllerHeartbeat(state), {
    ...heartbeat,
    status: 'degraded',
    errorCode: 'READINESS_TELEMETRY_STALE',
    detail: 'Stale.',
  });
});
