function createAsyncTtlCache({ ttlMs, maxEntries = Number.POSITIVE_INFINITY, now = Date.now } = {}) {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new TypeError('ttlMs must be a positive number');
  }
  if (!(maxEntries === Number.POSITIVE_INFINITY || (Number.isInteger(maxEntries) && maxEntries > 0))) {
    throw new TypeError('maxEntries must be a positive integer or Infinity');
  }

  const entries = new Map();
  const inFlight = new Map();
  const generations = new Map();
  let clearGeneration = 0;
  const generationFor = (key) => generations.get(key) || 0;
  const invalidateKey = (key) => {
    generations.set(key, generationFor(key) + 1);
    inFlight.delete(key);
  };

  const touch = (key, entry) => {
    entries.delete(key);
    entries.set(key, entry);
  };

  const enforceCapacity = () => {
    while (entries.size > maxEntries) {
      const oldestKey = entries.keys().next().value;
      entries.delete(oldestKey);
    }
  };

  const get = async (key, loader) => {
    if (typeof loader !== 'function') {
      throw new TypeError('loader must be a function');
    }

    const startedAt = now();
    const existing = entries.get(key);
    if (existing && startedAt - existing.storedAt < ttlMs) {
      touch(key, existing);
      return {
        value: existing.value,
        status: 'hit',
        ageMs: Math.max(0, startedAt - existing.storedAt),
        storedAt: existing.storedAt,
      };
    }

    const pending = inFlight.get(key);
    if (pending) {
      return pending.promise;
    }

    const generation = generationFor(key);
    const capturedClearGeneration = clearGeneration;
    let requestRecord;
    const request = Promise.resolve()
      .then(loader)
      .then((value) => {
        const tokenCurrent = generationFor(key) === generation
          && clearGeneration === capturedClearGeneration;
        if (!tokenCurrent) {
          return {
            value,
            status: 'superseded',
            ageMs: 0,
            storedAt: null,
          };
        }
        const storedAt = now();
        const entry = { value, storedAt };
        touch(key, entry);
        enforceCapacity();
        return { value, status: 'miss', ageMs: 0, storedAt };
      })
      .catch((error) => {
        const tokenCurrent = generationFor(key) === generation
          && clearGeneration === capturedClearGeneration;
        if (!tokenCurrent) throw error;
        if (!existing) throw error;
        touch(key, existing);
        return {
          value: existing.value,
          status: 'stale',
          ageMs: Math.max(0, now() - existing.storedAt),
          storedAt: existing.storedAt,
          error,
        };
      })
      .finally(() => {
        if (inFlight.get(key) === requestRecord) {
          inFlight.delete(key);
        }
      });

    requestRecord = {
      promise: request,
      generation,
      clearGeneration: capturedClearGeneration,
    };
    inFlight.set(key, requestRecord);
    return request;
  };

  return {
    get,
    set(key, value) {
      invalidateKey(key);
      const storedAt = now();
      const entry = { value, storedAt };
      touch(key, entry);
      enforceCapacity();
      return entry;
    },
    delete(key) {
      invalidateKey(key);
      return entries.delete(key);
    },
    clear() {
      clearGeneration += 1;
      entries.clear();
      inFlight.clear();
      generations.clear();
    },
    peek(key) {
      return entries.get(key) || null;
    },
    get size() {
      return entries.size;
    },
  };
}

module.exports = { createAsyncTtlCache };
