const assert = require('node:assert/strict');
const test = require('node:test');
const { analystHealthFailureRequiresInvalidation, createAnalystVerificationController } = require('./analystLifecycle.cjs');
test('optional verification is asynchronous, single-flight and rejects old-generation success', async () => {
  const jobs = []; const updates = [];
  const controller = createAnalystVerificationController({ verify: signal => new Promise(resolve => jobs.push({ signal, resolve })), publish: result => updates.push(result) });
  const first = controller.check(); controller.check();
  assert.equal(jobs.length, 1);
  // Core work is free to run while the contract probe is pending.
  let coreRan = false; await new Promise(resolve => setImmediate(() => { coreRan = true; resolve(); }));
  assert.equal(coreRan, true);
  controller.invalidate(); assert.equal(jobs[0].signal.aborted, true);
  const second = controller.check();
  jobs[0].resolve({ verified: true }); await first;
  assert.equal(updates.at(-1).verified, false);
  jobs[1].resolve({ verified: true }); await second;
  assert.equal(updates.at(-1).verified, true);
});
test('failed optional checks cool down rather than creating a retry storm', async () => {
  let now = 0; let calls = 0;
  const controller = createAnalystVerificationController({ now: () => now, retryMs: 100, verify: async () => { calls++; throw new Error('offline'); }, publish() {} });
  assert.equal(await controller.check(), false); await controller.check(); assert.equal(calls, 1);
  now = 100; await controller.check(); assert.equal(calls, 2);
});

test('an established contract survives transient same-process probes until the restart threshold', async () => {
  const updates = [];
  const controller = createAnalystVerificationController({
    verify: async () => ({ verified: true }),
    publish: result => updates.push(result),
  });
  await controller.check();
  let healthFailures = 0;
  const observe = ({ healthy, transientFailure = true }) => {
    healthFailures = healthy ? 0 : healthFailures + 1;
    if (analystHealthFailureRequiresInvalidation({
      healthy, transientFailure, sameOwner: true,
      verified: updates.at(-1).verified,
      healthFailures, failureThreshold: 3,
    })) controller.invalidate();
  };
  observe({ healthy: false });
  observe({ healthy: false });
  assert.equal(updates.length, 1, 'a delayed probe must not close an established stream');
  observe({ healthy: true });
  observe({ healthy: false });
  observe({ healthy: false });
  assert.equal(updates.length, 1, 'a successful probe resets the consecutive failure count');
  observe({ healthy: false });
  assert.equal(updates.at(-1).verified, false);
  assert.equal(updates.length, 2, 'the persistent liveness failure still closes the contract');
});

test('HTTP rejection, ownership changes and unverified startup fail closed on their first probe', () => {
  const established = {
    healthy: false, transientFailure: true, sameOwner: true,
    verified: true, healthFailures: 1, failureThreshold: 3,
  };
  assert.equal(analystHealthFailureRequiresInvalidation({ ...established, transientFailure: false }), true);
  assert.equal(analystHealthFailureRequiresInvalidation({ ...established, sameOwner: false }), true);
  assert.equal(analystHealthFailureRequiresInvalidation({ ...established, verified: false, checking: true }), true);
  assert.equal(analystHealthFailureRequiresInvalidation({ ...established, verified: false }), false);
});

test('rejected contract evidence revokes an established contract without a liveness grace period', async () => {
  let now = 0;
  const updates = [];
  let accepted = true;
  const controller = createAnalystVerificationController({
    now: () => now, retryMs: 1,
    verify: async () => ({ verified: accepted, error: accepted ? null : 'Contract evidence rejected.' }),
    publish: result => updates.push(result),
  });
  assert.equal(await controller.check(), true);
  now = 1;
  accepted = false;
  assert.equal(await controller.check(), false);
  assert.equal(updates.at(-1).verified, false);
});
