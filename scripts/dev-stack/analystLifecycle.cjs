'use strict';

function analystHealthFailureRequiresInvalidation({
  healthy,
  transientFailure = false,
  sameOwner = false,
  verified = false,
  checking = false,
  healthFailures = 0,
  failureThreshold = 3,
}) {
  if (healthy || (!verified && !checking)) return false;
  // An established contract survives a bounded liveness hiccup from its same
  // owned process. HTTP rejections, changed ownership and initial verification
  // failures still close the gate on the first observation.
  return !verified || !sameOwner || !transientFailure
    || healthFailures >= failureThreshold;
}

// Verification belongs to the optional Analyst generation, never to the API
// process lifecycle. An invalidated or superseded result cannot reopen it.
function createAnalystVerificationController({ verify, publish, now = Date.now, retryMs = 60_000 }) {
  let epoch = 0;
  let current = null;
  let retryAt = 0;
  function invalidate(error = 'The Analyst runtime is restarting.') {
    epoch += 1;
    current?.controller.abort();
    current = null;
    retryAt = 0;
    publish({ verified: false, checkedAt: new Date(now()).toISOString(), error });
  }
  async function check() {
    if (current) return current.promise;
    if (now() < retryAt) return false;
    const task = { epoch, controller: new AbortController(), promise: null };
    current = task;
    task.promise = (async () => {
      let result;
      try { result = await verify(task.controller.signal); }
      catch (_) { result = { verified: false, checkedAt: new Date(now()).toISOString(), error: 'The Analyst contract verification failed.' }; }
      if (task.epoch !== epoch || task.controller.signal.aborted) return false;
      retryAt = now() + retryMs;
      publish(result);
      return result.verified === true;
    })().finally(() => { if (current === task) current = null; });
    return task.promise;
  }
  return { invalidate, check, isChecking: () => current !== null };
}

module.exports = { analystHealthFailureRequiresInvalidation, createAnalystVerificationController };
