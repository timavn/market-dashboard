import { createDashboardWarmupQueue } from './dashboardWarmupQueue';

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

describe('dashboardWarmupQueue', () => {
  let idleCallbacks;
  let requestIdle;
  let cancelIdle;

  beforeEach(() => {
    idleCallbacks = [];
    requestIdle = jest.fn((callback) => {
      idleCallbacks.push(callback);
      return idleCallbacks.length;
    });
    cancelIdle = jest.fn();
  });

  const runIdle = () => {
    const callback = idleCallbacks.shift();
    callback?.({ didTimeout: false, timeRemaining: () => 50 });
  };

  test('limits work to two concurrent tasks and continues as slots settle', async () => {
    const queue = createDashboardWarmupQueue({ requestIdle, cancelIdle, isPaused: () => false });
    const first = deferred();
    const second = deferred();
    const third = deferred();
    const runs = [];
    queue.enqueue({ key: 'one', run: () => { runs.push('one'); return first.promise; } });
    queue.enqueue({ key: 'two', run: () => { runs.push('two'); return second.promise; } });
    queue.enqueue({ key: 'three', run: () => { runs.push('three'); return third.promise; } });

    runIdle();
    expect(runs).toEqual(['one', 'two']);
    expect(queue.getState().activeCount).toBe(2);

    first.resolve('one');
    await first.promise;
    await Promise.resolve();
    runIdle();
    expect(runs).toEqual(['one', 'two', 'three']);

    second.resolve('two');
    third.resolve('three');
    await Promise.all([second.promise, third.promise]);
    queue.dispose();
  });

  test('deduplicates a key and promotion starts the selected queued task immediately', async () => {
    const queue = createDashboardWarmupQueue({ requestIdle, cancelIdle, isPaused: () => false });
    const run = jest.fn().mockResolvedValue('ready');
    const firstPromise = queue.enqueue({ key: 'resource:etf', run, priority: -10 });
    const duplicatePromise = queue.enqueue({ key: 'resource:etf', run });
    expect(duplicatePromise).toBe(firstPromise);

    queue.promote('resource:etf');
    await firstPromise;
    expect(run).toHaveBeenCalledTimes(1);
    expect(cancelIdle).toHaveBeenCalled();
    queue.dispose();
  });

  test('pauses while hidden or offline and resumes when the environment changes', async () => {
    let paused = true;
    const queue = createDashboardWarmupQueue({
      requestIdle,
      cancelIdle,
      isPaused: () => paused,
    });
    const run = jest.fn().mockResolvedValue('ready');
    const promise = queue.enqueue({ key: 'paused', run });
    expect(requestIdle).not.toHaveBeenCalled();

    paused = false;
    queue.notifyEnvironmentChanged();
    runIdle();
    await promise;
    expect(run).toHaveBeenCalledTimes(1);
    queue.dispose();
  });

  test('cancels queued and running work without starting the waiting task', async () => {
    const queue = createDashboardWarmupQueue({
      concurrency: 1,
      requestIdle,
      cancelIdle,
      isPaused: () => false,
    });
    const running = deferred();
    let receivedSignal;
    const runningPromise = queue.enqueue({
      key: 'running',
      run: ({ signal }) => {
        receivedSignal = signal;
        return running.promise;
      },
    });
    const queuedRun = jest.fn();
    const queuedPromise = queue.enqueue({ key: 'queued', run: queuedRun });
    runIdle();

    expect(queue.cancel('running')).toBe(true);
    expect(receivedSignal?.aborted).toBe(true);
    expect(await runningPromise).toEqual({ status: 'cancelled', key: 'running' });
    expect(queue.cancel('queued')).toBe(true);
    expect(await queuedPromise).toEqual({ status: 'cancelled', key: 'queued' });
    expect(queuedRun).not.toHaveBeenCalled();
    running.resolve();
    await Promise.resolve();
    queue.dispose();
  });
});
