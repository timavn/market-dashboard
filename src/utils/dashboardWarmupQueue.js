const DEFAULT_IDLE_TIMEOUT_MS = 1500;
const PROMOTED_PRIORITY = 1_000_000;

const defaultIsPaused = () => (
  (typeof document !== 'undefined' && document.hidden)
  || (typeof navigator !== 'undefined' && navigator.onLine === false)
);

const defaultRequestIdle = (callback, timeoutMs) => {
  if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
    return window.requestIdleCallback(callback, { timeout: timeoutMs });
  }
  const setTimer = typeof window !== 'undefined' ? window.setTimeout : setTimeout;
  return setTimer(
    () => callback({ didTimeout: true, timeRemaining: () => 0 }),
    Math.max(1, Number(timeoutMs) || DEFAULT_IDLE_TIMEOUT_MS),
  );
};

const defaultCancelIdle = (handle) => {
  if (typeof window !== 'undefined' && typeof window.cancelIdleCallback === 'function') {
    window.cancelIdleCallback(handle);
    return;
  }
  const clearTimer = typeof window !== 'undefined' ? window.clearTimeout : clearTimeout;
  clearTimer(handle);
};

/**
 * One page-load warmup queue. Tasks are keyed and therefore run at most once,
 * including when a component and the idle queue ask for the same work.
 */
export function createDashboardWarmupQueue({
  concurrency = 2,
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
  requestIdle = defaultRequestIdle,
  cancelIdle = defaultCancelIdle,
  isPaused = defaultIsPaused,
} = {}) {
  const maxConcurrent = Math.max(1, Math.min(2, Number(concurrency) || 2));
  const tasks = new Map();
  let activeCount = 0;
  let nextOrder = 0;
  let idleHandle = null;
  let disposed = false;

  const queuedTasks = () => [...tasks.values()]
    .filter((task) => task.status === 'queued')
    .sort((left, right) => (
      right.priority - left.priority || left.order - right.order
    ));

  const clearScheduledDrain = () => {
    if (idleHandle == null) return;
    cancelIdle(idleHandle);
    idleHandle = null;
  };

  let scheduleDrain;

  const finishTask = (task, { value, error } = {}) => {
    if (task.status !== 'running') return;
    activeCount = Math.max(0, activeCount - 1);
    if (task.cancelled) {
      task.status = 'cancelled';
      if (!task.settled) {
        task.settled = true;
        task.resolve({ status: 'cancelled', key: task.key });
      }
    } else if (error) {
      task.status = 'failed';
      if (!task.settled) {
        task.settled = true;
        task.reject(error);
      }
    } else {
      task.status = 'complete';
      task.value = value;
      if (!task.settled) {
        task.settled = true;
        task.resolve(value);
      }
    }
    scheduleDrain();
  };

  const startTask = (task) => {
    if (disposed || task.status !== 'queued') return;
    task.status = 'running';
    task.controller = typeof AbortController === 'function' ? new AbortController() : null;
    activeCount += 1;
    let result;
    try {
      result = task.run({
        key: task.key,
        signal: task.controller?.signal || null,
      });
    } catch (error) {
      finishTask(task, { error });
      return;
    }
    Promise.resolve(result).then(
      (value) => finishTask(task, { value }),
      (error) => finishTask(task, { error }),
    );
  };

  const drain = () => {
    idleHandle = null;
    if (disposed || isPaused()) return;
    const queued = queuedTasks();
    while (activeCount < maxConcurrent && queued.length > 0) {
      startTask(queued.shift());
    }
    if (queuedTasks().length > 0 && activeCount < maxConcurrent) scheduleDrain();
  };

  scheduleDrain = () => {
    if (
      disposed
      || idleHandle != null
      || isPaused()
      || activeCount >= maxConcurrent
      || queuedTasks().length === 0
    ) return;
    idleHandle = requestIdle(drain, Math.max(1, Number(idleTimeoutMs) || DEFAULT_IDLE_TIMEOUT_MS));
  };

  const notifyEnvironmentChanged = () => {
    if (disposed) return;
    if (isPaused()) {
      clearScheduledDrain();
      return;
    }
    scheduleDrain();
  };

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', notifyEnvironmentChanged);
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('online', notifyEnvironmentChanged);
    window.addEventListener('offline', notifyEnvironmentChanged);
  }

  return {
    enqueue({ key, run, priority = 0 }) {
      const normalizedKey = String(key || '').trim();
      if (!normalizedKey) throw new TypeError('Warmup task key is required.');
      if (typeof run !== 'function') throw new TypeError(`Warmup task ${normalizedKey} requires a run function.`);
      if (disposed) return Promise.reject(new Error('Dashboard warmup queue is disposed.'));
      const existing = tasks.get(normalizedKey);
      if (existing) return existing.promise;

      let resolve;
      let reject;
      const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
      });
      const task = {
        key: normalizedKey,
        run,
        priority: Number(priority) || 0,
        order: nextOrder,
        status: 'queued',
        controller: null,
        cancelled: false,
        settled: false,
        value: undefined,
        promise,
        resolve,
        reject,
      };
      nextOrder += 1;
      tasks.set(normalizedKey, task);
      scheduleDrain();
      return promise;
    },

    promote(key) {
      const task = tasks.get(String(key || '').trim());
      if (!task) return null;
      if (task.status === 'queued') {
        task.priority = Math.max(task.priority, PROMOTED_PRIORITY);
        clearScheduledDrain();
        if (!isPaused()) drain();
      }
      return task.promise;
    },

    cancel(key) {
      const task = tasks.get(String(key || '').trim());
      if (!task || ['cancelled', 'complete', 'failed'].includes(task.status)) return false;
      task.cancelled = true;
      task.controller?.abort();
      if (task.status === 'queued') {
        task.status = 'cancelled';
        task.settled = true;
        task.resolve({ status: 'cancelled', key: task.key });
      } else if (!task.settled) {
        task.settled = true;
        task.resolve({ status: 'cancelled', key: task.key });
      }
      scheduleDrain();
      return true;
    },

    notifyEnvironmentChanged,

    getState() {
      return {
        activeCount,
        disposed,
        tasks: Object.fromEntries([...tasks.entries()].map(([key, task]) => [key, task.status])),
      };
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      clearScheduledDrain();
      tasks.forEach((task) => {
        if (['queued', 'running'].includes(task.status)) {
          task.cancelled = true;
          task.controller?.abort();
          task.status = 'cancelled';
          if (!task.settled) {
            task.settled = true;
            task.resolve({ status: 'cancelled', key: task.key });
          }
        }
      });
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', notifyEnvironmentChanged);
      }
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', notifyEnvironmentChanged);
        window.removeEventListener('offline', notifyEnvironmentChanged);
      }
    },
  };
}

export default createDashboardWarmupQueue;
