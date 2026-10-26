'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const manifest = require('../../ops/services.json');
const {
  ACTIVE_MODE,
  CONTROLLER_SERVICE_ID,
  CONTROLLER_BUILD_FINGERPRINT,
  DEFAULT_LIVE_CHECK_TIMEOUT_MS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_READINESS_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_STATE_FILE,
  DEFAULT_TELEMETRY_MAX_AGE_MS,
  SHADOW_MODE,
  compilePolicies,
  compatibilityEnvValue,
  controllerHeartbeat,
  createController,
  createDefaultIo,
  deferralEpisodeGapMs,
  eligibleActions,
  evaluateDeferrals,
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

test('generic readiness environment names take precedence during compatibility', () => {
  const env = {
    READINESS_CONTROLLER_MODE: 'active',
    HERMES_RELIABILITY_CONTROLLER_MODE: 'shadow',
    READINESS_CONTROLLER_ENABLED_ACTIONS: '',
    HERMES_RELIABILITY_ENABLED_ACTIONS: 'prune-dashboard-logs',
  };
  assert.equal(
    compatibilityEnvValue(
      env,
      'READINESS_CONTROLLER_MODE',
      'HERMES_RELIABILITY_CONTROLLER_MODE',
    ),
    'active',
  );
  const controller = createController({
    env,
    state: null,
    persist: () => {},
    emit: () => {},
    io: {},
  });
  assert.equal(controller.mode, 'active');
  assert.deepEqual(controller.state.enabledActionIds, []);
  assert.equal(controller.state.serviceId, CONTROLLER_SERVICE_ID);
  assert.equal(CONTROLLER_SERVICE_ID, 'dashboard-readiness-controller');
});

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
  fetchLiveCheck,
  initialState = null,
  enabledActionIds = mode === ACTIVE_MODE ? ALL_ACTION_IDS : [],
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
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
    pollIntervalMs,
    io: {
      fetchReadiness: async () => {
        assert.ok(queue.length > 0, 'test readiness queue exhausted');
        return queue.shift();
      },
      fetchLiveCheck,
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

  const restart = policies.find((policy) => policy.id === 'restart-local-stack');
  assert.equal(
    restart.triggeringErrorCodes.includes('DASHBOARD_SUPERVISOR_CODE_DRIFT'),
    true,
  );
  assert.deepEqual(restart.prerequisites[0], {
    checkId: 'dashboard.supervisor',
    statuses: ['pass', 'warn'],
    allowedErrorCodes: [null, 'DASHBOARD_SUPERVISOR_CODE_DRIFT'],
    maxAgeMs: 180000,
  });
  // Only the full-stack restart waits for in-progress Analyst work, judged
  // from a live check no older than a minute at the dispatch decision, and
  // only when code drift triggered it.
  assert.deepEqual(restart.deferrals, [{
    checkId: 'analyst.activity',
    maxAgeMs: 60000,
    unverifiedMaxDeferralMs: 1800000,
    errorCodes: ['DASHBOARD_CODE_VERSION_DRIFT', 'DASHBOARD_SUPERVISOR_CODE_DRIFT'],
  }]);
  assert.deepEqual(
    policies.filter((policy) => policy.deferrals.length > 0).map((policy) => policy.id),
    ['restart-local-stack'],
  );

  const sidecarRestart = policies.find(
    (policy) => policy.id === 'restart-ibkr-sidecar',
  );
  assert.deepEqual(sidecarRestart.triggeringCheckIds, [
    'local-sidecar',
    'ibkr.sidecar',
    'ibkr.gateway',
    'ibkr.portfolio',
  ]);
  assert.deepEqual(sidecarRestart.triggeringErrorCodes.sort(), [
    'IBKR_BALANCE_REQUEST_TIMEOUT',
    'IBKR_GATEWAY_API_UNRESPONSIVE',
    'IBKR_LIVE_SESSION_STALE',
    'IBKR_LIVE_SESSION_UNAVAILABLE',
    'IBKR_LIVE_SESSION_UNVERIFIED',
    'IBKR_POSITIONS_CLIENT_UNAVAILABLE',
    'IBKR_POSITIONS_REQUEST_TIMEOUT',
    'IBKR_SIDECAR_DUPLICATES',
    'IBKR_SIDECAR_UNREACHABLE',
    'IBKR_SOCKET_VERIFICATION_TIMEOUT',
  ]);
  for (const serviceId of ['local-sidecar', 'ibkr.sidecar']) {
    assert.equal(
      manifest.services.find((service) => service.id === serviceId)?.recoveryActionId,
      'restart-ibkr-sidecar',
    );
  }
  assert.equal(sidecarRestart.cooldownMs, 120_000);
  assert.deepEqual(sidecarRestart.verificationChecks, [
    'ibkr.sidecar',
    'ibkr.gateway',
    'ibkr.accounts',
    'ibkr.portfolio',
  ]);

  const everyTrigger = policies.flatMap((policy) => policy.triggeringErrorCodes);
  assert.equal(everyTrigger.some((code) => /IAM|OAUTH|DEPLOY|LOGIN|ORDER|TRADING/.test(code)), false);
});

test('supervisor source drift becomes eligible for the bounded local restart', () => {
  const policies = compilePolicies(manifest);
  const state = newState({
    mode: ACTIVE_MODE,
    now: BASE_TIME,
    enabledActionIds: ['restart-local-stack'],
  });
  const driftReport = (now) => report({
    now,
    checks: [
      check('dashboard.supervisor', 'warn', now, {
        errorCode: 'DASHBOARD_SUPERVISOR_CODE_DRIFT',
      }),
    ],
    rootCauses: [cause('DASHBOARD_SUPERVISOR_CODE_DRIFT', 'dashboard.supervisor')],
  });

  const first = observeReport(state, driftReport(BASE_TIME), {
    policies,
    now: BASE_TIME,
  });
  assert.deepEqual(
    eligibleActions(state, first.checksById, {
      policies,
      now: BASE_TIME,
      mode: ACTIVE_MODE,
      enabledActionIds: ['restart-local-stack'],
    }),
    [],
  );

  const secondNow = BASE_TIME + 60_000;
  const second = observeReport(state, driftReport(secondNow), {
    policies,
    now: secondNow,
  });
  const eligible = eligibleActions(state, second.checksById, {
    policies,
    now: secondNow,
    mode: ACTIVE_MODE,
    enabledActionIds: ['restart-local-stack'],
  });

  assert.deepEqual(eligible.map(({ policy }) => policy.id), ['restart-local-stack']);
});

function activityCheck(status, observedAtMs, overrides = {}) {
  return check('analyst.activity', status, observedAtMs, {
    errorCode: {
      pass: null,
      warn: 'ANALYST_WORK_ACTIVE',
      fail: 'ANALYST_ACTIVITY_UNVERIFIED',
    }[status],
    summary: {
      pass: 'No Analyst work is in progress.',
      warn: '1 review in progress.',
      fail: 'Analyst activity could not be read.',
    }[status],
    ...overrides,
  });
}

function stackDriftReport(now, { checks = [], rootCauses = [] } = {}) {
  return report({
    now,
    checks: [
      check('dashboard.runtime', 'fail', now, {
        errorCode: 'DASHBOARD_CODE_VERSION_DRIFT',
      }),
      check('dashboard.supervisor', 'pass', now),
      ...checks,
    ],
    rootCauses: [cause('DASHBOARD_CODE_VERSION_DRIFT', 'dashboard.runtime'), ...rootCauses],
  });
}

function cleanStackReport(now) {
  return report({
    now,
    checks: [
      check('dashboard.runtime', 'pass', now),
      check('dashboard.supervisor', 'pass', now),
      check('ibkr.sidecar', 'pass', now),
      check('ibkr.gateway', 'pass', now),
      check('ibkr.accounts', 'pass', now),
      check('ibkr.portfolio', 'pass', now),
    ],
  });
}

test('deferral policies require fresh live checks and a bounded unverified hold', () => {
  for (const [deferrals, message] of [
    [{}, 'deferrals must be an array'],
    [[{ checkId: 'Analyst activity', maxAgeMs: 60000, unverifiedMaxDeferralMs: 0 }],
      'deferral checkId must be an exact check id'],
    [[{ checkId: 'analyst.activity', maxAgeMs: 0, unverifiedMaxDeferralMs: 0 }],
      'deferral maxAgeMs must be positive and at most 60000'],
    [[{ checkId: 'analyst.activity', maxAgeMs: 60001, unverifiedMaxDeferralMs: 0 }],
      'deferral maxAgeMs must be positive and at most 60000'],
    [[{ checkId: 'analyst.activity', maxAgeMs: 60000 }],
      'deferral unverifiedMaxDeferralMs must be from 0 to 1800000'],
    [[{ checkId: 'analyst.activity', maxAgeMs: 60000, unverifiedMaxDeferralMs: 1800001 }],
      'deferral unverifiedMaxDeferralMs must be from 0 to 1800000'],
    [[{ checkId: 'analyst.activity', maxAgeMs: 60000, unverifiedMaxDeferralMs: 0, errorCodes: [] }],
      'deferral errorCodes must be a non-empty subset of triggeringErrorCodes'],
    [[{ checkId: 'analyst.activity', maxAgeMs: 60000, unverifiedMaxDeferralMs: 0, errorCodes: ['GMAIL_RATE_LIMITED'] }],
      'deferral errorCodes must be a non-empty subset of triggeringErrorCodes'],
  ]) {
    const changed = {
      ...manifest,
      repairActions: manifest.repairActions.map((action) => (
        action.id === 'restart-local-stack' ? { ...action, deferrals } : action
      )),
    };
    assert.deepEqual(policyValidationErrors(changed), [`restart-local-stack: ${message}`]);
  }
});

test('a deferral dispatches only on a fresh idle check and bounds unverified holds', () => {
  const policy = {
    deferrals: [{ checkId: 'analyst.activity', maxAgeMs: 60_000, unverifiedMaxDeferralMs: 1_800_000 }],
  };
  const now = BASE_TIME;
  const evaluate = (liveCheck, deferral = null) => evaluateDeferrals(
    policy,
    new Map(liveCheck ? [[liveCheck.id, liveCheck]] : []),
    { deferral },
    now,
  );

  assert.equal(evaluate(activityCheck('pass', now - 60_000)).defer, false);
  assert.deepEqual(evaluate(activityCheck('warn', now - 1_000)), {
    defer: true,
    reason: 'DEFERRED_FOR_ACTIVE_WORK',
    detail: 'analyst.activity: 1 review in progress.',
    workActive: true,
  });
  // Verified in-progress work keeps deferring however long the episode is;
  // each source stops reporting rows it has not updated for thirty minutes.
  assert.equal(evaluate(
    activityCheck('warn', now),
    { startedAt: new Date(now - 7_200_000).toISOString(), lastActiveAt: null },
  ).defer, true);

  for (const [liveCheck, detail] of [
    [activityCheck('pass', now - 60_001), 'analyst.activity: stale'],
    [activityCheck('pass', now + 31_000), 'analyst.activity: stale'],
    [activityCheck('fail', now), 'analyst.activity: ANALYST_ACTIVITY_UNVERIFIED'],
    [null, 'analyst.activity: unavailable'],
  ]) {
    assert.deepEqual(evaluate(liveCheck), {
      defer: true,
      reason: 'DEFERRED_ACTIVITY_UNVERIFIED',
      detail,
      workActive: false,
    });
  }
  const startedAt = new Date(now - 1_800_000).toISOString();
  const lastEvaluatedAt = new Date(now - 60_000).toISOString();
  assert.equal(evaluate(null, { startedAt, lastActiveAt: null, lastEvaluatedAt }).defer, false);
  assert.equal(evaluate(null, {
    startedAt,
    lastActiveAt: new Date(now - 1_799_999).toISOString(),
    lastEvaluatedAt,
  }).defer, true);
  // A deferral not re-evaluated for over five minutes ended; an unverified
  // read starts a new thirty-minute hold rather than dispatching at once.
  assert.equal(evaluate(null, {
    startedAt,
    lastActiveAt: null,
    lastEvaluatedAt: new Date(now - 300_001).toISOString(),
  }).defer, true);
});

test('a deferral applies only to the causes it names', () => {
  const policy = { deferrals: [{ checkId: 'analyst.activity', maxAgeMs: 60_000, unverifiedMaxDeferralMs: 1_800_000,
    errorCodes: ['DASHBOARD_CODE_VERSION_DRIFT'] }] };
  const active = new Map([['analyst.activity', activityCheck('warn', BASE_TIME)]]);
  assert.equal(evaluateDeferrals(policy, active, { errorCode: 'DASHBOARD_CODE_VERSION_DRIFT' }, BASE_TIME).defer, true);
  assert.equal(evaluateDeferrals(policy, active, { errorCode: 'HERMES_BRIDGE_DISABLED_PROCESS_PRESENT' }, BASE_TIME).defer, false);
  assert.equal(evaluateDeferrals(policy, new Map(), { errorCode: 'HERMES_BRIDGE_DISABLED_PROCESS_PRESENT' }, BASE_TIME).defer, false);
});

test('a disabled Hermes bridge process is stopped even while Analyst work is active', async () => {
  const nowRef = { value: BASE_TIME };
  const bridgeReport = (now) => report({
    now,
    checks: [
      check('dashboard.hermes-bridge', 'fail', now, { errorCode: 'HERMES_BRIDGE_DISABLED_PROCESS_PRESENT' }),
      check('dashboard.supervisor', 'pass', now),
    ],
    rootCauses: [cause('HERMES_BRIDGE_DISABLED_PROCESS_PRESENT', 'dashboard.hermes-bridge')],
  });
  const liveCheckReads = [];
  const dispatches = [];
  const harness = controllerHarness({
    nowRef,
    enabledActionIds: ['restart-local-stack'],
    reports: [bridgeReport(BASE_TIME), bridgeReport(BASE_TIME + 60_000), report({
      now: BASE_TIME + 60_000,
      checks: [check('dashboard.hermes-bridge', 'pass', BASE_TIME + 60_000), check('dashboard.supervisor', 'pass', BASE_TIME + 60_000)],
    })],
    fetchLiveCheck: async (checkId) => {
      liveCheckReads.push(checkId);
      return activityCheck('warn', nowRef.value);
    },
    dispatch: async (policy) => {
      dispatches.push(policy.id);
      return { accepted: true };
    },
  });
  await harness.controller.tick();
  nowRef.value = BASE_TIME + 60_000;
  await harness.controller.tick();
  assert.deepEqual(dispatches, ['restart-local-stack']);
  assert.deepEqual(liveCheckReads, [], 'only a code-drift restart reads Analyst activity');
});

test('the deferral episode gap follows a slower configured poll', () => {
  assert.equal(deferralEpisodeGapMs(DEFAULT_POLL_INTERVAL_MS), 300_000);
  assert.equal(deferralEpisodeGapMs(360_000),
    2 * 360_000 + DEFAULT_READINESS_TIMEOUT_MS + DEFAULT_LIVE_CHECK_TIMEOUT_MS);
});

test('six-minute polls still end an unverified hold thirty minutes after it began', async () => {
  const nowRef = { value: BASE_TIME };
  const first = BASE_TIME + 360_000;
  const times = [BASE_TIME, ...Array.from({ length: 6 }, (_, index) => first + index * 360_000)];
  const dispatches = [];
  const harness = controllerHarness({
    nowRef,
    pollIntervalMs: 360_000,
    enabledActionIds: ['restart-local-stack'],
    reports: [...times.map((time) => stackDriftReport(time)), cleanStackReport(times.at(-1))],
    fetchLiveCheck: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:3001'); },
    dispatch: async (policy) => {
      dispatches.push(policy.id);
      return { accepted: true };
    },
  });
  for (const time of times.slice(0, -1)) {
    nowRef.value = time;
    await harness.controller.tick();
  }
  const incident = harness.controller.state.incidents[0];
  assert.equal(incident.status, 'deferred');
  assert.equal(incident.deferral.startedAt, new Date(first).toISOString());
  assert.deepEqual(dispatches, []);
  nowRef.value = times.at(-1);
  await harness.controller.tick();
  assert.deepEqual(dispatches, ['restart-local-stack']);
});

test('a poll held by another long repair keeps a deferred restart on its original hold', async () => {
  const nowRef = { value: BASE_TIME };
  const deferredAt = BASE_TIME + 60_000;
  const sidecarDown = (now) => stackDriftReport(now, {
    checks: [check('ibkr.sidecar', 'fail', now, { errorCode: 'IBKR_SIDECAR_UNREACHABLE' })],
    rootCauses: [cause('IBKR_SIDECAR_UNREACHABLE', 'ibkr.sidecar')],
  });
  const sidecarUp = (now) => stackDriftReport(now, {
    checks: ['ibkr.sidecar', 'ibkr.gateway', 'ibkr.accounts', 'ibkr.portfolio'].map((id) => check(id, 'pass', now)),
  });
  const dispatches = [];
  const harness = controllerHarness({
    nowRef,
    enabledActionIds: ['restart-local-stack', 'restart-ibkr-sidecar'],
    reports: [sidecarDown(BASE_TIME), sidecarDown(deferredAt), sidecarUp(deferredAt + 360_000),
      sidecarUp(deferredAt + 420_000)],
    fetchLiveCheck: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:3001'); },
    dispatch: async (policy) => {
      dispatches.push(policy.id);
      nowRef.value += 360_000; // a six-minute repair holds this poll
      return { accepted: true };
    },
  });
  await harness.controller.tick();
  nowRef.value = deferredAt;
  await harness.controller.tick();
  assert.deepEqual(dispatches, ['restart-ibkr-sidecar']);
  nowRef.value = deferredAt + 420_000;
  await harness.controller.tick();
  const incident = harness.controller.state.incidents.find((item) => item.actionId === 'restart-local-stack');
  assert.equal(incident.status, 'deferred');
  // The busy poll did not end the episode, so its thirty-minute hold did not restart.
  assert.equal(incident.deferral.startedAt, new Date(deferredAt).toISOString());
  assert.deepEqual(dispatches, ['restart-ibkr-sidecar']);
});

test('a code-drift restart defers quietly while Analyst work is active, then dispatches once idle', async () => {
  const nowRef = { value: BASE_TIME };
  const times = [BASE_TIME, BASE_TIME + 60_000, BASE_TIME + 300_000, BASE_TIME + 360_000];
  const activity = ['warn', 'warn', 'pass'];
  const liveCheckReads = [];
  const dispatches = [];
  const harness = controllerHarness({
    nowRef,
    enabledActionIds: ['restart-local-stack'],
    reports: [...times.map((time) => stackDriftReport(time)), cleanStackReport(times[3])],
    fetchLiveCheck: async (checkId) => {
      liveCheckReads.push({ checkId, at: nowRef.value });
      return activityCheck(activity.shift(), nowRef.value);
    },
    dispatch: async (policy) => {
      dispatches.push(policy.id);
      return { accepted: true };
    },
  });

  for (const time of times.slice(0, 3)) {
    nowRef.value = time;
    await harness.controller.tick();
  }
  const incident = harness.controller.state.incidents[0];
  assert.equal(incident.id, 'dashboard.runtime:DASHBOARD_CODE_VERSION_DRIFT');
  assert.equal(incident.status, 'deferred');
  assert.equal(incident.suppressionReason, 'DEFERRED_FOR_ACTIVE_WORK');
  assert.equal(incident.suppressionDetail, 'analyst.activity: 1 review in progress.');
  assert.deepEqual(incident.deferral, {
    startedAt: new Date(times[1]).toISOString(),
    lastActiveAt: new Date(times[2]).toISOString(),
    lastEvaluatedAt: new Date(times[2]).toISOString(),
  });
  // No attempt, cooldown, circuit, or escalation: only the opening notice.
  assert.deepEqual(dispatches, []);
  assert.deepEqual(harness.controller.state.actions, []);
  assert.deepEqual(harness.controller.state.circuits, []);
  assert.deepEqual(harness.notifications.map((event) => event.kind), ['opening']);
  assert.equal(harness.controller.state.status, 'monitoring');
  // Activity is read live at each dispatch decision, never at first sighting.
  assert.deepEqual(liveCheckReads, [
    { checkId: 'analyst.activity', at: times[1] },
    { checkId: 'analyst.activity', at: times[2] },
  ]);

  nowRef.value = times[3];
  await harness.controller.tick();
  assert.deepEqual(dispatches, ['restart-local-stack']);
  assert.equal(harness.controller.state.actions.length, 1);
  assert.equal(harness.controller.state.actions[0].actionId, 'restart-local-stack');
  assert.equal(incident.deferral, undefined);
  assert.deepEqual(harness.notifications.map((event) => event.kind), ['opening']);
});

test('an unreadable activity check holds the restart for at most thirty minutes after work was last seen', async () => {
  const nowRef = { value: BASE_TIME };
  const first = BASE_TIME + 60_000;
  // Polls stay within the five-minute episode gap; work is seen at +20 min.
  const steps = [
    [BASE_TIME, null],
    ...Array.from({ length: 10 }, (_, index) => [
      first + index * 300_000,
      index === 4 ? 'warn' : 'throw',
    ]),
    [first + 2_999_000, 'throw'],
    [first + 3_000_000, 'fail'],
  ];
  const activity = steps.slice(1).map(([, result]) => result);
  const dispatches = [];
  const harness = controllerHarness({
    nowRef,
    enabledActionIds: ['restart-local-stack'],
    reports: [
      ...steps.map(([time]) => stackDriftReport(time)),
      cleanStackReport(first + 3_000_000),
    ],
    fetchLiveCheck: async () => {
      const result = activity.shift();
      if (result === 'throw') throw new Error('connect ECONNREFUSED 127.0.0.1:3001');
      return activityCheck(result, nowRef.value);
    },
    dispatch: async (policy) => {
      dispatches.push(policy.id);
      return { accepted: true };
    },
  });

  for (const [time] of steps.slice(0, -1)) {
    nowRef.value = time;
    await harness.controller.tick();
  }
  const incident = harness.controller.state.incidents[0];
  assert.equal(incident.status, 'deferred');
  assert.equal(incident.suppressionReason, 'DEFERRED_ACTIVITY_UNVERIFIED');
  assert.equal(incident.suppressionDetail, 'analyst.activity: unavailable');
  assert.deepEqual(incident.deferral, {
    startedAt: new Date(first).toISOString(),
    lastActiveAt: new Date(first + 1_200_000).toISOString(),
    lastEvaluatedAt: new Date(first + 2_999_000).toISOString(),
  });
  assert.deepEqual(dispatches, []);
  assert.deepEqual(harness.controller.state.actions, []);

  nowRef.value = steps.at(-1)[0];
  await harness.controller.tick();
  assert.deepEqual(dispatches, ['restart-local-stack']);
  assert.deepEqual(harness.notifications.map((event) => event.kind), ['opening']);
});

test('a deferred stack restart leaves another eligible action free to run', async () => {
  const nowRef = { value: BASE_TIME };
  const sidecarDown = (now) => stackDriftReport(now, {
    checks: [check('ibkr.sidecar', 'fail', now, { errorCode: 'IBKR_SIDECAR_UNREACHABLE' })],
    rootCauses: [cause('IBKR_SIDECAR_UNREACHABLE', 'ibkr.sidecar')],
  });
  const dispatches = [];
  const harness = controllerHarness({
    nowRef,
    enabledActionIds: ['restart-local-stack', 'restart-ibkr-sidecar'],
    reports: [
      sidecarDown(BASE_TIME),
      sidecarDown(BASE_TIME + 60_000),
      stackDriftReport(BASE_TIME + 60_000, {
        checks: ['ibkr.sidecar', 'ibkr.gateway', 'ibkr.accounts', 'ibkr.portfolio']
          .map((id) => check(id, 'pass', BASE_TIME + 60_000)),
      }),
    ],
    fetchLiveCheck: async () => activityCheck('warn', nowRef.value),
    dispatch: async (policy) => {
      dispatches.push(policy.id);
      return { accepted: true };
    },
  });

  await harness.controller.tick();
  nowRef.value = BASE_TIME + 60_000;
  await harness.controller.tick();

  assert.deepEqual(dispatches, ['restart-ibkr-sidecar']);
  assert.equal(
    harness.controller.state.incidents.find(
      (item) => item.actionId === 'restart-local-stack',
    ).status,
    'deferred',
  );
});

test('existing manual incidents adopt a newly added automatic policy', () => {
  const policies = compilePolicies(manifest);
  const state = newState({
    mode: ACTIVE_MODE,
    now: BASE_TIME,
    enabledActionIds: ['restart-local-stack'],
  });
  state.incidents = [{
    id: 'dashboard.supervisor:DASHBOARD_SUPERVISOR_CODE_DRIFT',
    checkId: 'dashboard.supervisor',
    errorCode: 'DASHBOARD_SUPERVISOR_CODE_DRIFT',
    label: 'Dashboard supervisor',
    status: 'manual',
    actionId: null,
    suppressionReason: 'NO_AUTOMATIC_POLICY',
    openedAt: new Date(BASE_TIME - 120_000).toISOString(),
    lastSeenAt: new Date(BASE_TIME - 60_000).toISOString(),
    lastMatchingObservationAt: new Date(BASE_TIME - 60_000).toISOString(),
    observationCount: 2,
    cleanObservationCount: 0,
    affectedCheckIds: ['dashboard.supervisor'],
    capabilityIds: [],
    notifications: {},
  }];

  const observation = observeReport(state, report({
    now: BASE_TIME,
    checks: [check('dashboard.supervisor', 'warn', BASE_TIME, {
      errorCode: 'DASHBOARD_SUPERVISOR_CODE_DRIFT',
    })],
    rootCauses: [cause('DASHBOARD_SUPERVISOR_CODE_DRIFT', 'dashboard.supervisor')],
  }), { policies, now: BASE_TIME });

  assert.equal(state.incidents[0].actionId, 'restart-local-stack');
  assert.equal(state.incidents[0].status, 'open');
  assert.deepEqual(
    eligibleActions(state, observation.checksById, {
      policies,
      now: BASE_TIME,
      mode: ACTIVE_MODE,
      enabledActionIds: ['restart-local-stack'],
    }).map(({ policy }) => policy.id),
    ['restart-local-stack'],
  );
});

test('unresolved incidents rebind when their configured recovery action changes', () => {
  const policies = compilePolicies(manifest);
  const state = newState({ mode: ACTIVE_MODE, now: BASE_TIME });
  state.incidents = [{
    id: 'ibkr.sidecar:IBKR_SIDECAR_UNREACHABLE',
    checkId: 'ibkr.sidecar',
    errorCode: 'IBKR_SIDECAR_UNREACHABLE',
    label: 'IBKR sidecar',
    status: 'circuit_open',
    actionId: 'restart-local-stack',
    suppressionReason: 'CIRCUIT_OPEN',
    openedAt: new Date(BASE_TIME - 120_000).toISOString(),
    lastSeenAt: new Date(BASE_TIME - 60_000).toISOString(),
    lastMatchingObservationAt: new Date(BASE_TIME - 60_000).toISOString(),
    observationCount: 2,
    cleanObservationCount: 0,
    affectedCheckIds: ['ibkr.sidecar'],
    capabilityIds: ['portfolio.live'],
    circuitOpenedAt: new Date(BASE_TIME - 30_000).toISOString(),
    circuitOpenUntil: new Date(BASE_TIME + 300_000).toISOString(),
    notifications: {},
  }];

  observeReport(state, report({
    now: BASE_TIME,
    checks: [check('ibkr.sidecar', 'fail', BASE_TIME, {
      errorCode: 'IBKR_SIDECAR_UNREACHABLE',
    })],
    rootCauses: [cause('IBKR_SIDECAR_UNREACHABLE', 'ibkr.sidecar')],
  }), { policies, now: BASE_TIME });

  assert.equal(state.incidents[0].actionId, 'restart-ibkr-sidecar');
  assert.equal(state.incidents[0].status, 'open');
  assert.equal(state.incidents[0].circuitOpenUntil, null);
  assert.equal(state.incidents[0].verificationOutcome, 'policy-rebound');
});

test('persisted in-flight incidents retire an obsolete recovery action', () => {
  const policies = compilePolicies(manifest);
  const state = newState({ mode: ACTIVE_MODE, now: BASE_TIME });
  const incidentId = 'ibkr.sidecar:IBKR_SIDECAR_UNREACHABLE';
  state.incidents = [{
    id: incidentId,
    checkId: 'ibkr.sidecar',
    errorCode: 'IBKR_SIDECAR_UNREACHABLE',
    label: 'IBKR sidecar',
    status: 'verifying',
    actionId: 'restart-local-stack',
    openedAt: new Date(BASE_TIME - 120_000).toISOString(),
    lastSeenAt: new Date(BASE_TIME - 60_000).toISOString(),
    lastMatchingObservationAt: new Date(BASE_TIME - 60_000).toISOString(),
    observationCount: 2,
    cleanObservationCount: 0,
    affectedCheckIds: ['ibkr.sidecar'],
    capabilityIds: ['portfolio.live'],
    notifications: {},
  }];
  state.actions = [{
    id: 'restart-local-stack:1',
    incidentId,
    actionId: 'restart-local-stack',
    startedAt: new Date(BASE_TIME - 30_000).toISOString(),
    completedAt: null,
    outcome: 'uncertain',
  }];
  state.inFlight = {
    actionRecordId: state.actions[0].id,
    incidentId,
    actionId: 'restart-local-stack',
    startedAt: state.actions[0].startedAt,
    recoveryHold: true,
    releaseAfter: new Date(BASE_TIME + 600_000).toISOString(),
  };

  observeReport(state, report({
    now: BASE_TIME,
    checks: [check('ibkr.sidecar', 'fail', BASE_TIME, {
      errorCode: 'IBKR_SIDECAR_UNREACHABLE',
    })],
    rootCauses: [cause('IBKR_SIDECAR_UNREACHABLE', 'ibkr.sidecar')],
  }), { policies, now: BASE_TIME });

  assert.equal(state.inFlight, null);
  assert.equal(state.incidents[0].actionId, 'restart-ibkr-sidecar');
  assert.equal(state.incidents[0].status, 'open');
  assert.equal(state.incidents[0].verificationOutcome, 'policy-rebound');
  assert.equal(state.actions[0].outcome, 'superseded');
  assert.equal(state.actions[0].verificationOutcome, 'policy-rebound');
  assert.equal(
    state.actions[0].errorCode,
    'CONTROLLER_ACTION_POLICY_REBOUND',
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

test('deferral checks are read live from the loopback readiness API with a bounded timeout', async () => {
  const requests = [];
  const live = activityCheck('pass', BASE_TIME);
  const io = createDefaultIo({
    env: { MARKET_DASHBOARD_API_URL: 'http://127.0.0.1:3001' },
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, status: 200, text: async () => JSON.stringify(live) };
    },
  });

  assert.deepEqual(await io.fetchLiveCheck('analyst.activity'), live);
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    'http://127.0.0.1:3001/api/system-readiness/checks/analyst.activity',
  );
  assert.ok(requests[0].options.signal instanceof AbortSignal);
  assert.equal(DEFAULT_LIVE_CHECK_TIMEOUT_MS, 15_000);
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

test('inconclusive sidecar ownership stays degraded without automatic restart, including persisted incidents', () => {
  const policies = compilePolicies(manifest);
  const state = newState({ mode: ACTIVE_MODE, now: BASE_TIME, enabledActionIds: ['restart-ibkr-sidecar'] });
  const errorCode = 'IBKR_SIDECAR_PROCESS_DISCOVERY_FAILED';
  let observation;
  for (const now of [BASE_TIME, BASE_TIME + 60_000]) {
    observation = observeReport(state, report({ now, checks: [
      check('ibkr.sidecar', 'fail', now, { errorCode }),
      check('dashboard.supervisor', 'pass', now),
    ], rootCauses: [cause(errorCode, 'ibkr.sidecar')] }), { policies, now });
  }
  assert.equal(observation.checksById.get('ibkr.sidecar').status, 'fail');
  assert.equal(state.incidents[0].status, 'manual');
  assert.equal(state.incidents[0].suppressionReason, 'NO_AUTOMATIC_POLICY');
  assert.deepEqual(eligibleActions(state, observation.checksById, {
    policies, now: BASE_TIME + 60_000, mode: ACTIVE_MODE,
  }), []);

  // Previous policy versions persisted this exact actionId. Even if another
  // Gateway failure prevents full resolution, the obsolete trigger cannot run.
  Object.assign(state.incidents[0], { actionId: 'restart-ibkr-sidecar', status: 'open', observationCount: 3 });
  const checks = new Map([
    ['ibkr.sidecar', check('ibkr.sidecar', 'pass', BASE_TIME + 120_000)],
    ['ibkr.gateway', check('ibkr.gateway', 'fail', BASE_TIME + 120_000, { errorCode: 'IBKR_GATEWAY_API_UNRESPONSIVE' })],
    ['dashboard.supervisor', check('dashboard.supervisor', 'pass', BASE_TIME + 120_000)],
  ]);
  assert.deepEqual(eligibleActions(state, checks, {
    policies, now: BASE_TIME + 120_000, mode: ACTIVE_MODE,
  }), []);
  assert.equal(state.incidents[0].suppressionReason, 'NO_AUTOMATIC_POLICY');
});

test('confirmed unreachable and duplicate sidecars retain bounded automatic recovery', () => {
  const policies = compilePolicies(manifest);
  for (const errorCode of ['IBKR_SIDECAR_UNREACHABLE', 'IBKR_SIDECAR_DUPLICATES']) {
    const state = newState({ mode: ACTIVE_MODE, now: BASE_TIME, enabledActionIds: ['restart-ibkr-sidecar'] });
    let observation;
    for (const now of [BASE_TIME, BASE_TIME + 60_000]) {
      observation = observeReport(state, report({ now, checks: [
        check('ibkr.sidecar', 'fail', now, { errorCode }),
        check('dashboard.supervisor', 'pass', now),
      ], rootCauses: [cause(errorCode, 'ibkr.sidecar')] }), { policies, now });
    }
    assert.deepEqual(eligibleActions(state, observation.checksById, {
      policies, now: BASE_TIME + 60_000, mode: ACTIVE_MODE,
    }).map(({ policy }) => policy.id), ['restart-ibkr-sidecar']);
  }
});

test('a persisted broker incident cannot restart a recovered process or a differently classified current failure', () => {
  const policies = compilePolicies(manifest);
  for (const current of [
    check('ibkr.portfolio', 'pass', BASE_TIME),
    check('ibkr.portfolio', 'fail', BASE_TIME, { errorCode: 'IBKR_PORTFOLIO_DELIVERY_UNAVAILABLE' }),
    check('ibkr.portfolio', 'fail', BASE_TIME, { errorCode: 'IBKR_POSITIONS_REQUEST_TIMEOUT' }),
    null,
  ]) {
    const state = newState({ mode: ACTIVE_MODE, now: BASE_TIME, enabledActionIds: ['restart-ibkr-sidecar'] });
    state.incidents = [{
      id: 'ibkr.portfolio:IBKR_LIVE_SESSION_UNAVAILABLE', checkId: 'ibkr.portfolio',
      errorCode: 'IBKR_LIVE_SESSION_UNAVAILABLE', actionId: 'restart-ibkr-sidecar',
      status: 'open', observationCount: 3, notifications: {},
    }];
    const checks = new Map([['dashboard.supervisor', check('dashboard.supervisor', 'pass', BASE_TIME)]]);
    if (current) checks.set(current.id, current);

    assert.deepEqual(eligibleActions(state, checks, { policies, now: BASE_TIME, mode: ACTIVE_MODE }), []);
    assert.equal(state.incidents[0].suppressionReason, 'CURRENT_TRIGGER_CHANGED');
    assert.equal(state.incidents[0].nextRetryAt, null);

    // A new observation of the exact original broker failure remains eligible.
    checks.set('ibkr.portfolio', check('ibkr.portfolio', 'fail', BASE_TIME, { errorCode: 'IBKR_LIVE_SESSION_UNAVAILABLE' }));
    assert.deepEqual(eligibleActions(state, checks, { policies, now: BASE_TIME, mode: ACTIVE_MODE })
      .map(({ policy }) => policy.id), ['restart-ibkr-sidecar']);
  }
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
      check('gmail.ingestion', 'fail', BASE_TIME, {
        errorCode: 'IBKR_SIDECAR_UNREACHABLE',
      }),
    ],
    rootCauses: [
      cause('IBKR_SIDECAR_UNREACHABLE', 'gmail.ingestion'),
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
