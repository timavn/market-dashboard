const { createAsyncTtlCache } = require('./serverResponseCache.cjs');

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
});
