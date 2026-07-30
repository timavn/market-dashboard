const { createAsyncTtlCache } = require('./serverResponseCache.cjs');
const {
  checkpointIdentity,
  createCheckpointFirstResearchResponse,
  failClosedResearchRefresh,
  isCurrentManualCheckpointResponse,
  preserveCurrentCheckpointAfterRefreshFailure,
  setCheckpointFirstNoStoreHeader,
} = require('./checkpointFirstResearchResponse.cjs');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function checkpointResponse(hash = 'hash-a', capturedAt = '2026-07-27T02:20:06.000Z') {
  return {
    available: true,
    current: true,
    comparisonSafe: true,
    referenceOnly: false,
    longCount: 4,
    shortCount: 3,
    dataAvailability: {
      verificationMode: 'manual-official-checkpoint',
      canonicalSourceVerified: true,
      checkpointVerified: true,
      checkpointCurrent: true,
      checkpointCapturedAt: capturedAt,
      checkpointContentHash: hash,
    },
  };
}

function createHarness({ currentTime = 0, refreshTimeoutMs = 10_000 } = {}) {
  let time = currentTime;
  const now = () => time;
  const cache = createAsyncTtlCache({ ttlMs: 100, now });
  const coordinator = createCheckpointFirstResearchResponse({
    cache,
    ttlMs: 100,
    refreshAheadMs: 80,
    refreshTimeoutMs,
    now,
    schedule: (callback) => callback(),
  });
  return {
    cache,
    coordinator,
    setTime(value) {
      time = value;
    },
  };
}

describe('checkpoint-first research responses', () => {
  test('recognizes only a current hash-identified manual checkpoint', () => {
    const checkpoint = checkpointResponse();
    expect(isCurrentManualCheckpointResponse(checkpoint)).toBe(true);
    expect(checkpointIdentity(checkpoint)).toBe(
      'hash-a:2026-07-27T02:20:06.000Z',
    );
    expect(isCurrentManualCheckpointResponse({
      ...checkpoint,
      dataAvailability: {
        ...checkpoint.dataAvailability,
        checkpointCurrent: false,
      },
    })).toBe(false);
    expect(isCurrentManualCheckpointResponse({
      ...checkpoint,
      dataAvailability: {
        ...checkpoint.dataAvailability,
        checkpointContentHash: null,
      },
    })).toBe(false);
  });

  test('forces browsers to recontact the server for current fail-closed state', () => {
    const response = { setHeader: jest.fn() };
    setCheckpointFirstNoStoreHeader(response);
    expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
  });

  test('refresh failures clear every active ETF and RTA comparison field', () => {
    const etf = failClosedResearchRefresh({
      available: true,
      current: true,
      comparisonSafe: true,
      referenceOnly: false,
      longCount: 24,
      shortCount: 13,
      rows: [{ ticker: 'SPY' }],
      actionRows: [{ ticker: 'QQQ' }],
      changes: { addedLongs: ['SPY'] },
      data: {
        fullBookLongs: ['SPY'],
        fullBookShorts: ['QQQ'],
      },
      meta: { rowCount: 37, longCount: 24, shortCount: 13 },
    }, new Error('refresh failed'));
    expect(etf).toMatchObject({
      available: false,
      current: false,
      comparisonSafe: false,
      referenceOnly: true,
      longCount: null,
      shortCount: null,
      rows: [],
      actionRows: [],
      changes: null,
      data: {
        fullBookLongs: [],
        fullBookShorts: [],
      },
      meta: {
        rowCount: 0,
        longCount: null,
        shortCount: null,
      },
    });

    expect(failClosedResearchRefresh({
      available: true,
      current: true,
      comparisonSafe: true,
      referenceOnly: false,
      longCount: 4,
      shortCount: 3,
      ratioText: '1.3:1',
      netBias: 'long',
      holdings: [{ ticker: 'RSI', side: 'long' }],
    }, new Error('refresh failed'))).toMatchObject({
      available: false,
      current: false,
      comparisonSafe: false,
      longCount: null,
      shortCount: null,
      ratioText: null,
      netBias: null,
      holdings: [],
    });
  });

  test('preserves only a current verified checkpoint after a refresh exception', () => {
    const checkpoint = checkpointResponse();
    const error = new Error('DynamoDB unavailable');
    error.code = 'RESEARCH_REFRESH_UNAVAILABLE';

    expect(preserveCurrentCheckpointAfterRefreshFailure(checkpoint, error)).toMatchObject({
      available: true,
      current: true,
      comparisonSafe: true,
      referenceOnly: false,
      longCount: 4,
      shortCount: 3,
      authoritativeRevalidationStatus: 'failed',
      dataAvailability: {
        canonicalSourceVerified: true,
        checkpointVerified: true,
        checkpointCurrent: true,
        authoritativeRevalidationStatus: 'failed',
        authoritativeRevalidationErrorCode: 'RESEARCH_REFRESH_UNAVAILABLE',
        pipelineHealthy: false,
      },
      meta: {
        authoritativeRevalidationStatus: 'failed',
        authoritativeRevalidationErrorCode: 'RESEARCH_REFRESH_UNAVAILABLE',
      },
    });

    const expired = {
      ...checkpoint,
      current: false,
      comparisonSafe: false,
      referenceOnly: true,
      dataAvailability: {
        ...checkpoint.dataAvailability,
        checkpointCurrent: false,
      },
    };
    expect(preserveCurrentCheckpointAfterRefreshFailure(expired, error)).toMatchObject({
      available: false,
      current: false,
      comparisonSafe: false,
      referenceOnly: true,
      longCount: null,
      shortCount: null,
    });
  });

  test('returns the local checkpoint before the authoritative loader finishes', async () => {
    const { coordinator } = createHarness();
    const remote = deferred();
    const checkpoint = checkpointResponse();

    await expect(coordinator.get({
      key: 'rta',
      checkpointValue: checkpoint,
      loadAuthoritative: () => remote.promise,
    })).resolves.toMatchObject({
      status: 'checkpoint',
      value: checkpoint,
    });
    expect(coordinator.getPhase('rta')).toBe('checkpoint');

    remote.resolve({
      ...checkpoint,
      longCount: 5,
      authoritativeRevalidationStatus: 'verified',
    });
    await coordinator.getPendingRefresh('rta');

    await expect(coordinator.get({
      key: 'rta',
      checkpointValue: checkpoint,
      loadAuthoritative: jest.fn(),
    })).resolves.toMatchObject({
      status: 'hit',
      value: expect.objectContaining({
        longCount: 5,
        authoritativeRevalidationStatus: 'verified',
      }),
    });
    expect(coordinator.getPhase('rta')).toBe('authoritative');
  });

  test('keeps a post-checkpoint canonical failure closed instead of restoring the baseline', async () => {
    const { coordinator } = createHarness();
    const checkpoint = checkpointResponse();
    const remote = deferred();
    const blocked = {
      ...checkpoint,
      available: false,
      current: false,
      comparisonSafe: false,
      referenceOnly: true,
      longCount: null,
      shortCount: null,
      dataAvailability: {
        ...checkpoint.dataAvailability,
        canonicalSourceVerified: false,
        errorCode: 'ETF_PRO_CANONICAL_REPLAY_INVALID',
      },
    };

    await coordinator.get({
      key: 'rta',
      checkpointValue: checkpoint,
      loadAuthoritative: () => remote.promise,
    });
    expect(coordinator.getPhase('rta')).toBe('checkpoint');
    remote.resolve(blocked);
    await coordinator.getPendingRefresh('rta');

    await expect(coordinator.get({
      key: 'rta',
      checkpointValue: checkpoint,
      loadAuthoritative: jest.fn(),
    })).resolves.toMatchObject({
      value: expect.objectContaining({
        available: false,
        current: false,
        comparisonSafe: false,
        referenceOnly: true,
        longCount: null,
        shortCount: null,
        dataAvailability: expect.objectContaining({
          errorCode: 'ETF_PRO_CANONICAL_REPLAY_INVALID',
        }),
      }),
    });
    expect(coordinator.getPhase('rta')).toBe('blocked');
  });

  test('keeps a verified checkpoint visible after a background refresh exception', async () => {
    const { coordinator } = createHarness();
    const checkpoint = checkpointResponse();
    const refreshError = new Error('DynamoDB unavailable');
    refreshError.code = 'RESEARCH_REFRESH_UNAVAILABLE';

    await coordinator.get({
      key: 'etf',
      checkpointValue: checkpoint,
      loadAuthoritative: async () => {
        throw refreshError;
      },
      onRefreshError: (error, current) => ({
        ...current,
        available: false,
        current: false,
        comparisonSafe: false,
        referenceOnly: true,
        longCount: null,
        shortCount: null,
        dataAvailability: {
          ...current.dataAvailability,
          canonicalSourceVerified: false,
          errorCode: error.code,
        },
      }),
    });
    await coordinator.getPendingRefresh('etf');

    await expect(coordinator.get({
      key: 'etf',
      checkpointValue: checkpoint,
      loadAuthoritative: jest.fn(),
    })).resolves.toMatchObject({
      status: 'checkpoint',
      value: expect.objectContaining({
        available: true,
        current: true,
        comparisonSafe: true,
        referenceOnly: false,
        longCount: 4,
        shortCount: 3,
        dataAvailability: expect.objectContaining({
          authoritativeRevalidationStatus: 'failed',
          authoritativeRevalidationErrorCode: 'RESEARCH_REFRESH_UNAVAILABLE',
        }),
      }),
    });
    expect(coordinator.getPhase('etf')).toBe('checkpoint');
  });

  test('contains an error-adapter exception without blanking a verified checkpoint', async () => {
    const { cache, coordinator } = createHarness();
    const checkpoint = checkpointResponse();
    await coordinator.get({
      key: 'rta',
      checkpointValue: checkpoint,
      loadAuthoritative: async () => {
        throw new Error('refresh failed');
      },
      onRefreshError: () => {
        throw new Error('adapter failed');
      },
    });

    await expect(coordinator.getPendingRefresh('rta')).resolves.toBeUndefined();
    expect(cache.peek('rta')?.value).toMatchObject({
      available: true,
      current: true,
      comparisonSafe: true,
      referenceOnly: false,
      longCount: 4,
      shortCount: 3,
      dataAvailability: {
        authoritativeRevalidationStatus: 'failed',
        authoritativeRevalidationErrorCode: 'AUTHORITATIVE_RESEARCH_REFRESH_FAILED',
      },
    });
    expect(coordinator.getPhase('rta')).toBe('checkpoint');
  });

  test('keeps the checkpoint after the bounded authoritative refresh times out', async () => {
    const { coordinator } = createHarness({ refreshTimeoutMs: 5 });
    const checkpoint = checkpointResponse();

    await expect(coordinator.get({
      key: 'rta',
      checkpointValue: checkpoint,
      loadAuthoritative: () => new Promise(() => {}),
    })).resolves.toMatchObject({
      status: 'checkpoint',
      value: checkpoint,
    });
    await coordinator.getPendingRefresh('rta');

    await expect(coordinator.get({
      key: 'rta',
      checkpointValue: checkpoint,
      loadAuthoritative: jest.fn(),
    })).resolves.toMatchObject({
      status: 'checkpoint',
      value: expect.objectContaining({
        available: true,
        current: true,
        comparisonSafe: true,
        referenceOnly: false,
        longCount: 4,
        shortCount: 3,
        dataAvailability: expect.objectContaining({
          authoritativeRevalidationStatus: 'failed',
          authoritativeRevalidationErrorCode: 'AUTHORITATIVE_RESEARCH_REFRESH_TIMEOUT',
        }),
      }),
    });
  });

  test('rebuilds the current checkpoint instead of serving an expired authoritative entry', async () => {
    const { coordinator, setTime } = createHarness();
    const checkpoint = checkpointResponse();
    const firstRemote = {
      ...checkpoint,
      longCount: 6,
    };

    await coordinator.get({
      key: 'rta',
      checkpointValue: checkpoint,
      loadAuthoritative: async () => firstRemote,
    });
    await coordinator.getPendingRefresh('rta');
    setTime(101);
    const nextRemote = deferred();

    await expect(coordinator.get({
      key: 'rta',
      checkpointValue: checkpoint,
      loadAuthoritative: () => nextRemote.promise,
    })).resolves.toMatchObject({
      status: 'checkpoint',
      ageMs: 0,
      value: expect.objectContaining({
        longCount: 4,
        shortCount: 3,
      }),
    });

    nextRemote.resolve({ ...checkpoint, longCount: 7 });
    await coordinator.getPendingRefresh('rta');
  });

  test('keeps an expired fail-closed result blocked while retrying in the background', async () => {
    const { coordinator, setTime } = createHarness();
    const checkpoint = checkpointResponse();
    await coordinator.get({
      key: 'etf',
      checkpointValue: checkpoint,
      loadAuthoritative: async () => ({
        ...checkpoint,
        available: false,
        current: false,
        comparisonSafe: false,
        referenceOnly: true,
        longCount: null,
        shortCount: null,
      }),
    });
    await coordinator.getPendingRefresh('etf');
    setTime(101);
    const retry = deferred();

    await expect(coordinator.get({
      key: 'etf',
      checkpointValue: checkpoint,
      loadAuthoritative: () => retry.promise,
    })).resolves.toMatchObject({
      status: 'blocked',
      ageMs: 101,
      value: expect.objectContaining({
        current: false,
        comparisonSafe: false,
        longCount: null,
        shortCount: null,
      }),
    });
    retry.resolve(checkpoint);
    await coordinator.getPendingRefresh('etf');
  });

  test('does not let an older checkpoint refresh overwrite a newly captured checkpoint', async () => {
    const { coordinator } = createHarness();
    const oldCheckpoint = checkpointResponse('old-hash');
    const newCheckpoint = checkpointResponse(
      'new-hash',
      '2026-07-27T03:20:06.000Z',
    );
    const oldRemote = deferred();
    const newRemote = deferred();

    await coordinator.get({
      key: 'rta',
      checkpointValue: oldCheckpoint,
      loadAuthoritative: () => oldRemote.promise,
    });
    await coordinator.get({
      key: 'rta',
      checkpointValue: newCheckpoint,
      loadAuthoritative: () => newRemote.promise,
    });

    newRemote.resolve({ ...newCheckpoint, longCount: 8 });
    await coordinator.getPendingRefresh('rta');
    oldRemote.resolve({ ...oldCheckpoint, longCount: 99 });
    await Promise.resolve();
    await Promise.resolve();

    await expect(coordinator.get({
      key: 'rta',
      checkpointValue: newCheckpoint,
      loadAuthoritative: jest.fn(),
    })).resolves.toMatchObject({
      value: expect.objectContaining({
        longCount: 8,
        dataAvailability: expect.objectContaining({
          checkpointContentHash: 'new-hash',
        }),
      }),
    });
  });

  test('invalidation generation prevents an old in-flight refresh from overwriting new state', async () => {
    const { coordinator } = createHarness();
    const checkpoint = checkpointResponse();
    const oldRemote = deferred();
    const newRemote = deferred();

    await coordinator.get({
      key: 'etf',
      checkpointValue: checkpoint,
      loadAuthoritative: () => oldRemote.promise,
    });
    const oldPending = coordinator.getPendingRefresh('etf');
    coordinator.invalidate('etf');

    await coordinator.get({
      key: 'etf',
      checkpointValue: checkpoint,
      loadAuthoritative: () => newRemote.promise,
    });
    const newPending = coordinator.getPendingRefresh('etf');
    newRemote.resolve({ ...checkpoint, longCount: 8 });
    await newPending;
    oldRemote.resolve({ ...checkpoint, longCount: 99 });
    await oldPending;

    await expect(coordinator.get({
      key: 'etf',
      checkpointValue: checkpoint,
      loadAuthoritative: jest.fn(),
    })).resolves.toMatchObject({
      value: expect.objectContaining({ longCount: 8 }),
    });
  });

  test('never serves an unbound cache entry in place of the current checkpoint hash', async () => {
    const { cache, coordinator } = createHarness();
    const checkpoint = checkpointResponse();
    cache.set('rta', {
      available: true,
      current: true,
      comparisonSafe: true,
      longCount: 99,
      shortCount: 99,
    });

    const remote = deferred();
    await expect(coordinator.get({
      key: 'rta',
      checkpointValue: checkpoint,
      loadAuthoritative: () => remote.promise,
    })).resolves.toMatchObject({
      status: 'checkpoint',
      value: expect.objectContaining({
        longCount: 4,
        shortCount: 3,
      }),
    });
    remote.resolve(checkpoint);
    await coordinator.getPendingRefresh('rta');
  });

  test('awaits the authoritative source when no current checkpoint exists', async () => {
    const { coordinator } = createHarness();
    const loader = jest.fn(async () => ({
      available: false,
      current: false,
      comparisonSafe: false,
    }));
    await expect(coordinator.get({
      key: 'rta',
      checkpointValue: null,
      loadAuthoritative: loader,
    })).resolves.toMatchObject({
      status: 'miss',
      value: {
        available: false,
        current: false,
        comparisonSafe: false,
      },
    });
    expect(loader).toHaveBeenCalledTimes(1);
  });

  test('does not fast-path a structurally valid but expired checkpoint response', async () => {
    const { coordinator } = createHarness();
    const expiredCheckpoint = {
      ...checkpointResponse(),
      current: false,
      comparisonSafe: false,
      referenceOnly: true,
      dataAvailability: {
        ...checkpointResponse().dataAvailability,
        checkpointCurrent: false,
      },
    };
    const loader = jest.fn(async () => ({
      available: false,
      current: false,
      comparisonSafe: false,
    }));

    await expect(coordinator.get({
      key: 'rta',
      checkpointValue: expiredCheckpoint,
      loadAuthoritative: loader,
    })).resolves.toMatchObject({ status: 'miss' });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(coordinator.getPendingRefresh('rta')).toBeNull();
  });
});
