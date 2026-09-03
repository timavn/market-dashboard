const { createHistoricalRequestQueue } = require('./historicalRequestQueue.cjs');

function deferred() {
  let resolve;
  const promise = new Promise((onResolve) => { resolve = onResolve; });
  return { promise, resolve };
}

describe('serialized IBKR historical request queue', () => {
  test('deduplicates equal requests and permits only one provider call in flight', async () => {
    const first = deferred();
    const order = [];
    const queue = createHistoricalRequestQueue({ timeoutMs: 1_000 });
    const a = queue.enqueue('GC:1h', async () => {
      order.push('a:start');
      await first.promise;
      order.push('a:end');
      return 'a';
    });
    const duplicate = queue.enqueue('GC:1h', () => Promise.resolve('duplicate'));
    const b = queue.enqueue('SI:1h', async () => {
      order.push('b:start');
      return 'b';
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(duplicate).toBe(a);
    expect(order).toEqual(['a:start']);
    first.resolve();
    await expect(Promise.all([a, duplicate, b])).resolves.toEqual(['a', 'a', 'b']);
    expect(order).toEqual(['a:start', 'a:end', 'b:start']);
  });

  test('an eight-second-class timeout releases the queue for the next request', async () => {
    const queue = createHistoricalRequestQueue({ timeoutMs: 20 });
    const blocked = queue.enqueue('blocked', () => new Promise(() => {}));
    const next = queue.enqueue('next', async () => 'released');
    await expect(blocked).rejects.toMatchObject({ code: 'PM_IBKR_HISTORY_TIMEOUT' });
    await expect(next).resolves.toBe('released');
    expect(queue.getHealth()).toMatchObject({ status: 'idle', timedOut: 1, completed: 1 });
  });

  test('permits a bounded longer deadline for a complete historical-record request', async () => {
    const queue = createHistoricalRequestQueue({ timeoutMs: 20 });
    const record = queue.enqueue('historical-record:XAUUSD', async () => {
      await new Promise((resolve) => setTimeout(resolve, 35));
      return 'verified-record';
    }, { timeoutMs: 100 });

    await expect(record).resolves.toBe('verified-record');
    expect(queue.getHealth()).toMatchObject({ status: 'idle', timedOut: 0, completed: 1 });
  });
});
