const DEFAULT_REFRESH_TIMEOUT_MS = 60_000;

function asObject(value) {
  return value && typeof value === 'object' ? value : {};
}

function checkpointIdentity(value) {
  const candidate = asObject(value);
  const availability = asObject(candidate.dataAvailability);
  const meta = asObject(candidate.meta);
  const contentHash = availability.checkpointContentHash
    || meta.checkpointContentHash
    || candidate.checkpointContentHash
    || null;
  const capturedAt = availability.checkpointCapturedAt
    || meta.checkpointCapturedAt
    || candidate.checkpointCapturedAt
    || null;
  if (!contentHash || !capturedAt) return null;
  return `${contentHash}:${capturedAt}`;
}

function isCurrentManualCheckpointResponse(value) {
  const candidate = asObject(value);
  const availability = asObject(candidate.dataAvailability);
  const meta = asObject(candidate.meta);
  const verificationMode = availability.verificationMode || meta.verificationMode || null;
  return candidate.available === true
    && candidate.current === true
    && candidate.comparisonSafe === true
    && candidate.referenceOnly === false
    && verificationMode === 'manual-official-checkpoint'
    && availability.canonicalSourceVerified === true
    && availability.checkpointVerified === true
    && availability.checkpointCurrent === true
    && Boolean(checkpointIdentity(candidate));
}

function setCheckpointFirstNoStoreHeader(response) {
  if (!response || typeof response.setHeader !== 'function') {
    throw new TypeError('response must support setHeader()');
  }
  response.setHeader('Cache-Control', 'no-store');
}

function attachCheckpointIdentity(value, checkpointValue) {
  const candidate = asObject(value);
  const checkpoint = asObject(checkpointValue);
  const checkpointAvailability = asObject(checkpoint.dataAvailability);
  const checkpointMeta = asObject(checkpoint.meta);
  const checkpointFields = {
    checkpointVerified: checkpointAvailability.checkpointVerified
      ?? checkpointMeta.checkpointVerified
      ?? true,
    checkpointCurrent: checkpointAvailability.checkpointCurrent
      ?? checkpointMeta.checkpointCurrent
      ?? true,
    checkpointCapturedAt: checkpointAvailability.checkpointCapturedAt
      || checkpointMeta.checkpointCapturedAt
      || null,
    checkpointContentHash: checkpointAvailability.checkpointContentHash
      || checkpointMeta.checkpointContentHash
      || null,
    checkpointSource: checkpointAvailability.checkpointSource
      || checkpointMeta.checkpointSource
      || null,
  };
  return {
    ...candidate,
    dataAvailability: {
      ...checkpointFields,
      ...asObject(candidate.dataAvailability),
    },
    meta: {
      ...checkpointFields,
      ...asObject(candidate.meta),
    },
  };
}

function failClosedResearchRefresh(value, error) {
  const candidate = asObject(value);
  const errorCode = error?.code || 'AUTHORITATIVE_RESEARCH_REFRESH_FAILED';
  const reason = error?.message
    ? `Authoritative research revalidation failed: ${error.message}`
    : 'Authoritative research revalidation failed.';
  return {
    ...candidate,
    ...(Array.isArray(candidate.rows) ? { rows: [] } : {}),
    ...(Array.isArray(candidate.rows) || Array.isArray(candidate.actionRows)
      ? { actionRows: [], changes: null }
      : {}),
    ...(Array.isArray(candidate.holdings) ? { holdings: [] } : {}),
    ...(Array.isArray(candidate.rows) || (candidate.data && typeof candidate.data === 'object')
      ? {
        data: {
          ...asObject(candidate.data),
          fullBookLongs: [],
          fullBookShorts: [],
        },
      }
      : {}),
    available: false,
    current: false,
    comparisonSafe: false,
    referenceOnly: true,
    longCount: null,
    shortCount: null,
    ratioText: null,
    netBias: null,
    dataQuality: {
      ...asObject(candidate.dataQuality),
      status: 'error',
      warnings: [
        ...new Set([
          ...(Array.isArray(candidate.dataQuality?.warnings)
            ? candidate.dataQuality.warnings
            : []),
          reason,
        ]),
      ],
    },
    dataAvailability: {
      ...asObject(candidate.dataAvailability),
      canonicalSourceVerified: false,
      current: false,
      comparisonSafe: false,
      referenceOnly: true,
      errorCode,
      reason,
      authoritativeRevalidationStatus: 'failed',
    },
    meta: {
      ...asObject(candidate.meta),
      available: false,
      canonicalSourceVerified: false,
      current: false,
      comparisonSafe: false,
      referenceOnly: true,
      errorCode,
      reason,
      authoritativeRevalidationStatus: 'failed',
      ...(Array.isArray(candidate.rows) ? { rowCount: 0 } : {}),
      longCount: null,
      shortCount: null,
    },
  };
}

function preserveCurrentCheckpointAfterRefreshFailure(checkpointValue, error) {
  if (!isCurrentManualCheckpointResponse(checkpointValue)) {
    return failClosedResearchRefresh(checkpointValue, error);
  }

  const checkpoint = asObject(checkpointValue);
  const errorCode = error?.code || 'AUTHORITATIVE_RESEARCH_REFRESH_FAILED';
  const reason = error?.message
    ? `Authoritative research revalidation failed: ${error.message}`
    : 'Authoritative research revalidation failed.';
  const warnings = [
    ...new Set([
      ...(Array.isArray(checkpoint.dataQuality?.warnings)
        ? checkpoint.dataQuality.warnings
        : []),
      reason,
    ]),
  ];
  const diagnostics = {
    authoritativeRevalidationStatus: 'failed',
    authoritativeRevalidationErrorCode: errorCode,
    authoritativeRevalidationReason: reason,
  };

  return {
    ...checkpoint,
    authoritativeRevalidationStatus: 'failed',
    dataQuality: {
      ...asObject(checkpoint.dataQuality),
      warnings,
    },
    sourceDiagnostics: {
      ...asObject(checkpoint.sourceDiagnostics),
      ...diagnostics,
    },
    dataAvailability: {
      ...asObject(checkpoint.dataAvailability),
      ...diagnostics,
      ingestionVerified: false,
      pipelineHealthy: false,
      pipelineErrorCode: errorCode,
      pipelineReason: reason,
    },
    meta: {
      ...asObject(checkpoint.meta),
      ...diagnostics,
    },
  };
}

function promiseWithTimeout(promise, timeoutMs, timeoutFactory) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.resolve(promise);
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(timeoutFactory()), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function createCheckpointFirstResearchResponse({
  cache,
  ttlMs,
  refreshAheadMs = Math.max(1, Math.floor(ttlMs * 0.8)),
  refreshTimeoutMs = DEFAULT_REFRESH_TIMEOUT_MS,
  now = Date.now,
  schedule = setImmediate,
} = {}) {
  if (
    !cache
    || typeof cache.peek !== 'function'
    || typeof cache.set !== 'function'
    || typeof cache.delete !== 'function'
  ) {
    throw new TypeError('cache must support peek(), set(), and delete()');
  }
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new TypeError('ttlMs must be a positive number');
  }

  const jobs = new Map();
  const phases = new Map();
  const activeCheckpointIdentities = new Map();
  const generations = new Map();
  const generationFor = (key) => generations.get(key) || 0;
  const invalidate = (key) => {
    generations.set(key, generationFor(key) + 1);
    jobs.delete(key);
    phases.delete(key);
    activeCheckpointIdentities.delete(key);
    return cache.delete(key);
  };

  const scheduleRefresh = ({
    key,
    checkpointValue,
    checkpointId,
    loadAuthoritative,
    onRefreshError,
  }) => {
    const generation = generationFor(key);
    const existingJob = jobs.get(key);
    if (
      existingJob?.checkpointId === checkpointId
      && existingJob?.generation === generation
    ) {
      return existingJob.promise;
    }

    let resolveScheduled;
    const scheduled = new Promise((resolve) => {
      resolveScheduled = resolve;
    });
    const job = { checkpointId, generation, promise: scheduled };
    jobs.set(key, job);

    schedule(() => {
      const timeoutError = () => {
        const error = new Error(
          `Authoritative research refresh exceeded ${refreshTimeoutMs}ms.`,
        );
        error.code = 'AUTHORITATIVE_RESEARCH_REFRESH_TIMEOUT';
        return error;
      };
      const loaderPromise = Promise.resolve().then(loadAuthoritative);
      promiseWithTimeout(loaderPromise, refreshTimeoutMs, timeoutError)
        .then((value) => {
          if (
            generationFor(key) !== generation
            || activeCheckpointIdentities.get(key) !== checkpointId
          ) return;
          const attached = attachCheckpointIdentity(value, checkpointValue);
          cache.set(key, attached);
          phases.set(
            key,
            attached.current === true && attached.comparisonSafe === true
              ? 'authoritative'
              : 'blocked',
          );
        })
        .catch((error) => {
          if (
            generationFor(key) !== generation
            || activeCheckpointIdentities.get(key) !== checkpointId
          ) return;
          if (isCurrentManualCheckpointResponse(checkpointValue)) {
            // A transport/auth/timeout failure says nothing about the integrity
            // of the separately hash-verified, still-current official
            // checkpoint. Keep that checkpoint visible for UI reads, while
            // recording the failed authoritative verification so readiness
            // cannot treat it as an authoritative success.
            cache.set(
              key,
              preserveCurrentCheckpointAfterRefreshFailure(checkpointValue, error),
            );
            phases.set(key, 'checkpoint');
            return;
          }
          const currentValue = cache.peek(key)?.value || checkpointValue;
          let blocked;
          try {
            blocked = typeof onRefreshError === 'function'
              ? onRefreshError(error, currentValue)
              : failClosedResearchRefresh(currentValue, error);
          } catch (_) {
            // A broken error adapter must never leave optimistic data active
            // or create an unhandled rejection.
            blocked = failClosedResearchRefresh(currentValue, error);
          }
          cache.set(key, attachCheckpointIdentity(blocked, checkpointValue));
          phases.set(key, 'blocked');
        })
        .finally(() => {
          if (jobs.get(key) === job) jobs.delete(key);
          resolveScheduled();
        });
    });
    return scheduled;
  };

  const get = async ({
    key,
    checkpointValue,
    loadAuthoritative,
    onRefreshError,
  } = {}) => {
    if (!key) throw new TypeError('key is required');
    if (typeof loadAuthoritative !== 'function') {
      throw new TypeError('loadAuthoritative must be a function');
    }

    const checkpointCurrent = isCurrentManualCheckpointResponse(checkpointValue);
    const checkpointId = checkpointCurrent ? checkpointIdentity(checkpointValue) : null;
    const previousCheckpointId = activeCheckpointIdentities.get(key);
    if (checkpointId !== previousCheckpointId) {
      invalidate(key);
      activeCheckpointIdentities.set(key, checkpointId);
    }

    const entry = cache.peek(key);
    const entryCheckpointId = checkpointIdentity(entry?.value);
    const matchingEntry = entry
      && (!checkpointId || entryCheckpointId === checkpointId)
      ? entry
      : null;
    const ageMs = matchingEntry ? Math.max(0, now() - matchingEntry.storedAt) : 0;

    if (matchingEntry && ageMs < ttlMs) {
      if (checkpointCurrent && ageMs >= refreshAheadMs) {
        scheduleRefresh({
          key,
          checkpointValue,
          checkpointId,
          loadAuthoritative,
          onRefreshError,
        });
      }
      return {
        value: matchingEntry.value,
        status: phases.get(key) === 'checkpoint' ? 'checkpoint' : 'hit',
        ageMs,
        storedAt: matchingEntry.storedAt,
      };
    }

    if (checkpointCurrent) {
      const phase = phases.get(key);
      const entryIsFailClosed = matchingEntry
        && (
          phase === 'blocked'
          || matchingEntry.value?.current !== true
          || matchingEntry.value?.comparisonSafe !== true
        );
      if (entryIsFailClosed) {
        scheduleRefresh({
          key,
          checkpointValue,
          checkpointId,
          loadAuthoritative,
          onRefreshError,
        });
        return {
          value: matchingEntry.value,
          status: 'blocked',
          ageMs,
          storedAt: matchingEntry.storedAt,
        };
      }

      // The authoritative response TTL has expired. Rebuild the still-current,
      // hash-verified checkpoint rather than relabeling expired remote state as
      // safe while its background refresh is pending.
      cache.set(key, checkpointValue);
      phases.set(key, 'checkpoint');
      scheduleRefresh({
        key,
        checkpointValue,
        checkpointId,
        loadAuthoritative,
        onRefreshError,
      });
      const selected = cache.peek(key);
      return {
        value: selected.value,
        status: 'checkpoint',
        ageMs: 0,
        storedAt: selected.storedAt,
      };
    }

    const value = await loadAuthoritative();
    cache.set(key, value);
    phases.set(
      key,
      value?.current === true && value?.comparisonSafe === true
        ? 'authoritative'
        : 'blocked',
    );
    const stored = cache.peek(key);
    return {
      value,
      status: 'miss',
      ageMs: 0,
      storedAt: stored?.storedAt || now(),
    };
  };

  return {
    get,
    invalidate,
    checkpointIdentity,
    isCurrentManualCheckpointResponse,
    getPhase(key) {
      return phases.get(key) || null;
    },
    getPendingRefresh(key) {
      return jobs.get(key)?.promise || null;
    },
  };
}

module.exports = {
  DEFAULT_REFRESH_TIMEOUT_MS,
  attachCheckpointIdentity,
  checkpointIdentity,
  createCheckpointFirstResearchResponse,
  failClosedResearchRefresh,
  isCurrentManualCheckpointResponse,
  preserveCurrentCheckpointAfterRefreshFailure,
  setCheckpointFirstNoStoreHeader,
};
