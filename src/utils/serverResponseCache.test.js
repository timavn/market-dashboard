const { createAsyncTtlCache } = require('./serverResponseCache.cjs');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('server response cache', () => {
  test('returns hits until expiry and reloads afterward', async () => {
    let currentTime = 1_000;
    let loads = 0;
    const cache = createAsyncTtlCache({ ttlMs: 300_000, now: () => currentTime });
    const loader = async () => ({ load: ++loads });

    await expect(cache.get('rta', loader)).resolves.toMatchObject({ status: 'miss', value: { load: 1 } });
    currentTime += 120_000;
    await expect(cache.get('rta', loader)).resolves.toMatchObject({
      status: 'hit',
      ageMs: 120_000,
      value: { load: 1 },
    });
    currentTime += 180_001;
    await expect(cache.get('rta', loader)).resolves.toMatchObject({ status: 'miss', value: { load: 2 } });
  });

  test('deduplicates concurrent loads for the same key', async () => {
    let release;
    let loads = 0;
    const cache = createAsyncTtlCache({ ttlMs: 300_000 });
    const loader = jest.fn(() => {
      loads += 1;
      return new Promise((resolve) => {
        release = () => resolve({ load: loads });
      });
    });

    const first = cache.get('workflow', loader);
    const second = cache.get('workflow', loader);
    await Promise.resolve();
    expect(loader).toHaveBeenCalledTimes(1);
    release();

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ status: 'miss', value: { load: 1 } }),
      expect.objectContaining({ status: 'miss', value: { load: 1 } }),
    ]);
  });

  test('serves the last good value as stale when refresh fails', async () => {
    let currentTime = 0;
    const cache = createAsyncTtlCache({ ttlMs: 100, now: () => currentTime });
    await cache.get('changelog', async () => ({ version: 1 }));
    currentTime = 101;

    await expect(cache.get('changelog', async () => {
      throw new Error('DynamoDB unavailable');
    })).resolves.toMatchObject({
      status: 'stale',
      ageMs: 101,
      value: { version: 1 },
      error: expect.any(Error),
    });
  });

  test('different version keys invalidate an artifact without evicting unrelated entries', async () => {
    const cache = createAsyncTtlCache({ ttlMs: 86_400_000, maxEntries: 1_000 });
    await cache.get('bucket/key/version-1', async () => 'old');
    await expect(cache.get('bucket/key/version-2', async () => 'new')).resolves.toMatchObject({
      status: 'miss',
      value: 'new',
    });
    expect(cache.size).toBe(2);
  });

  test('caps entries with least-recently-used eviction', async () => {
    const cache = createAsyncTtlCache({ ttlMs: 86_400_000, maxEntries: 2 });
    await cache.get('a', async () => 'a');
    await cache.get('b', async () => 'b');
    await cache.get('a', async () => 'unused');
    await cache.get('c', async () => 'c');

    expect(cache.peek('a')).not.toBeNull();
    expect(cache.peek('b')).toBeNull();
    expect(cache.peek('c')).not.toBeNull();
  });

  test('allows a verified local response to prime the cache without invoking a loader', () => {
    let currentTime = 42_000;
    const cache = createAsyncTtlCache({
      ttlMs: 300_000,
      now: () => currentTime,
    });

    cache.set('rta', { source: 'manual-official-checkpoint' });
    expect(cache.peek('rta')).toEqual({
      value: { source: 'manual-official-checkpoint' },
      storedAt: 42_000,
    });

    currentTime += 1_000;
    expect(cache.peek('rta')).toEqual({
      value: { source: 'manual-official-checkpoint' },
      storedAt: 42_000,
    });
  });

  test('delete prevents an old load from overwriting or deleting a newer in-flight request', async () => {
    const cache = createAsyncTtlCache({ ttlMs: 300_000 });
    const oldLoad = deferred();
    const newLoad = deferred();
    const oldRequest = cache.get('rta', () => oldLoad.promise);
    await Promise.resolve();

    cache.delete('rta');
    const newLoader = jest.fn(() => newLoad.promise);
    const newRequest = cache.get('rta', newLoader);
    const dedupedNewRequest = cache.get('rta', newLoader);
    await Promise.resolve();
    expect(newLoader).toHaveBeenCalledTimes(1);

    oldLoad.resolve({ version: 'old' });
    await expect(oldRequest).resolves.toMatchObject({
      status: 'superseded',
      value: { version: 'old' },
    });
    expect(cache.peek('rta')).toBeNull();

    // The old request's finally handler must not remove the newer request.
    const stillDeduped = cache.get('rta', newLoader);
    expect(newLoader).toHaveBeenCalledTimes(1);
    newLoad.resolve({ version: 'new' });
    await expect(Promise.all([
      newRequest,
      dedupedNewRequest,
      stillDeduped,
    ])).resolves.toEqual([
      expect.objectContaining({ status: 'miss', value: { version: 'new' } }),
      expect.objectContaining({ status: 'miss', value: { version: 'new' } }),
      expect.objectContaining({ status: 'miss', value: { version: 'new' } }),
    ]);
    expect(cache.peek('rta')?.value).toEqual({ version: 'new' });
  });

  test('set and clear invalidate older loader write tokens', async () => {
    const cache = createAsyncTtlCache({ ttlMs: 300_000 });
    const setRace = deferred();
    const oldSetRequest = cache.get('etf', () => setRace.promise);
    await Promise.resolve();
    cache.set('etf', { version: 'manual' });
    setRace.resolve({ version: 'old-remote' });
    await expect(oldSetRequest).resolves.toMatchObject({ status: 'superseded' });
    expect(cache.peek('etf')?.value).toEqual({ version: 'manual' });

    const clearRace = deferred();
    const oldClearRequest = cache.get('readiness', () => clearRace.promise);
    await Promise.resolve();
    cache.clear();
    const replacement = cache.get('readiness', async () => ({ version: 'replacement' }));
    clearRace.resolve({ version: 'old-before-clear' });
    await expect(oldClearRequest).resolves.toMatchObject({ status: 'superseded' });
    await expect(replacement).resolves.toMatchObject({
      status: 'miss',
      value: { version: 'replacement' },
    });
    expect(cache.peek('readiness')?.value).toEqual({ version: 'replacement' });
  });
});
