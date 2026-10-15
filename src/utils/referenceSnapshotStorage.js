export const REFERENCE_SNAPSHOT_SCHEMA_VERSION = 1;

const getSessionStorage = () => {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage || null;
  } catch {
    return null;
  }
};

const parseTimestamp = (value) => {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
};

const removeStoredSnapshot = (storage, storageKey) => {
  try {
    storage?.removeItem(storageKey);
  } catch {
    // Storage can be unavailable or read-only in private browsing contexts.
  }
};

export const normalizeReferenceSnapshotConfig = (config) => {
  if (!config) return null;
  const storageKey = String(config.key || '').trim();
  const ttlMs = Number(config.ttlMs);
  if (!storageKey || !Number.isFinite(ttlMs) || ttlMs <= 0) return null;
  return {
    key: storageKey,
    ttlMs,
    projectionVersion: Number.isInteger(Number(config.projectionVersion))
      && Number(config.projectionVersion) > 0
      ? Number(config.projectionVersion)
      : 1,
  };
};

export const readReferenceSnapshot = ({
  config,
  resourceKey,
  scopeKey,
  resourceClass = null,
  now = Date.now(),
} = {}) => {
  const normalized = normalizeReferenceSnapshotConfig(config);
  const storage = getSessionStorage();
  if (!normalized || !storage) return null;

  let raw;
  try {
    raw = storage.getItem(normalized.key);
  } catch {
    return null;
  }
  if (!raw) return null;

  let record;
  try {
    record = JSON.parse(raw);
  } catch {
    removeStoredSnapshot(storage, normalized.key);
    return null;
  }

  const persistedAt = parseTimestamp(record?.persistedAt);
  const age = persistedAt == null ? Infinity : now - persistedAt;
  const valid = Boolean(
    record
      && typeof record === 'object'
      && record.schemaVersion === REFERENCE_SNAPSHOT_SCHEMA_VERSION
      && record.resourceKey === resourceKey
      && record.scopeKey === scopeKey
      && (
        !resourceClass
        || record.resourceClass === resourceClass
        || (
          !record.resourceClass
          && resourceClass !== 'mixed'
        )
      )
      && (
        record.projectionVersion == null
        || record.projectionVersion === normalized.projectionVersion
      )
      && persistedAt != null
      && age >= -5000
      && age <= normalized.ttlMs
      && Object.prototype.hasOwnProperty.call(record, 'data')
      && record.data != null,
  );

  if (!valid) {
    removeStoredSnapshot(storage, normalized.key);
    return null;
  }

  return {
    ...record,
    persistedAt: new Date(persistedAt).toISOString(),
  };
};

export const writeReferenceSnapshot = ({
  config,
  resourceKey,
  scopeKey,
  observedAt,
  data,
  resourceClass = null,
  persistedAt = new Date(Date.now()).toISOString(),
} = {}) => {
  const normalized = normalizeReferenceSnapshotConfig(config);
  const storage = getSessionStorage();
  const observedAtMs = parseTimestamp(observedAt);
  if (!normalized || !storage || data == null || observedAtMs == null) return null;

  const record = {
    schemaVersion: REFERENCE_SNAPSHOT_SCHEMA_VERSION,
    resourceKey,
    scopeKey,
    observedAt: new Date(observedAtMs).toISOString(),
    persistedAt: new Date(parseTimestamp(persistedAt) || Date.now()).toISOString(),
    resourceClass,
    projectionVersion: normalized.projectionVersion,
    data,
  };

  try {
    storage.setItem(normalized.key, JSON.stringify(record));
    return {
      ...record,
      persistedAt: record.persistedAt,
    };
  } catch {
    // Persistence is an enhancement only. Never discard the in-memory
    // verified snapshot because storage is unavailable or over quota.
    return null;
  }
};

export const clearReferenceSnapshot = (config) => {
  const normalized = normalizeReferenceSnapshotConfig(config);
  const storage = getSessionStorage();
  if (!normalized || !storage) return;
  removeStoredSnapshot(storage, normalized.key);
};
