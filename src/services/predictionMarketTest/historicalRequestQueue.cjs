const DEFAULT_TIMEOUT_MS = 8_000;

function timeoutError(key, timeoutMs) {
  return Object.assign(
    new Error(`IBKR historical request timed out after ${timeoutMs}ms (${key}).`),
    { code: 'PM_IBKR_HISTORY_TIMEOUT', key, timeoutMs },
  );
}

function createHistoricalRequestQueue({ timeoutMs = DEFAULT_TIMEOUT_MS, now = Date.now } = {}) {
  const deduplicated = new Map();
  let tail = Promise.resolve();
  let activeKey = null;
  let completed = 0;
  let timedOut = 0;

  function runWithTimeout(key, factory, requestTimeoutMs = timeoutMs) {
    let timer = null;
    const providerWork = Promise.resolve().then(factory);
    // A provider promise may settle after the queue-level deadline. Observe it
    // so a late rejection is never unhandled, but do not let it retain the
    // serialized queue slot.
    providerWork.catch(() => undefined);
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(timeoutError(key, requestTimeoutMs)), requestTimeoutMs);
      timer.unref?.();
    });
    return Promise.race([providerWork, deadline]).finally(() => clearTimeout(timer));
  }

  function enqueue(key, factory, options = {}) {
    const normalizedKey = String(key || '').trim();
    if (!normalizedKey) throw new TypeError('Historical request key is required.');
    if (typeof factory !== 'function') throw new TypeError('Historical request factory is required.');
    if (deduplicated.has(normalizedKey)) return deduplicated.get(normalizedKey);
    const requestTimeoutMs = Math.max(1, Number(options.timeoutMs) || timeoutMs);

    const queued = tail.catch(() => undefined).then(async () => {
      activeKey = normalizedKey;
      try {
        const result = await runWithTimeout(normalizedKey, factory, requestTimeoutMs);
        completed += 1;
        return result;
      } catch (error) {
        if (error?.code === 'PM_IBKR_HISTORY_TIMEOUT') timedOut += 1;
        throw error;
      } finally {
        activeKey = null;
      }
    });
    tail = queued.catch(() => undefined);
    deduplicated.set(normalizedKey, queued);
    queued.finally(() => {
      if (deduplicated.get(normalizedKey) === queued) deduplicated.delete(normalizedKey);
    }).catch(() => undefined);
    return queued;
  }

  function getHealth() {
    return {
      status: activeKey ? 'busy' : 'idle',
      activeKey,
      pending: deduplicated.size,
      completed,
      timedOut,
      timeoutMs,
      asOf: new Date(Number(now())).toISOString(),
    };
  }

  return { enqueue, getHealth };
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  createHistoricalRequestQueue,
};
