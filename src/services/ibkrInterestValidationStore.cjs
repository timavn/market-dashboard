const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RECORD_KINDS = new Set([
  'observations',
  'predictions',
  'actuals',
  'misses',
]);

const DEFAULT_DATA_DIR = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'market-dashboard',
  'ibkr-interest-validation-v1',
);

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value)
    .sort()
    .reduce((result, key) => {
      result[key] = stableValue(value[key]);
      return result;
    }, {});
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function contentHash(value) {
  return crypto.createHash('sha256').update(stableJson(value)).digest('hex');
}

function validateStoredRecord(
  record,
  filePath,
  index,
  { previousRecordHash = null } = {},
) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    const error = new Error(
      `Interest validation journal record is invalid at ${path.basename(filePath)}:${index + 1}`,
    );
    error.code = 'interest_store_integrity_error';
    throw error;
  }
  const {
    recordHash,
    ...hashable
  } = record;
  if (
    !/^[a-f0-9]{64}$/.test(String(recordHash || ''))
    || contentHash(hashable) !== recordHash
  ) {
    const error = new Error(
      `Interest validation journal hash did not verify at ${path.basename(filePath)}:${index + 1}`,
    );
    error.code = 'interest_store_integrity_error';
    throw error;
  }
  const hasSequence = Object.prototype.hasOwnProperty.call(record, 'sequence');
  const hasPreviousHash = Object.prototype.hasOwnProperty.call(
    record,
    'previousRecordHash',
  );
  if (
    hasSequence !== hasPreviousHash
    || (
      hasSequence
      && (
        !Number.isInteger(record.sequence)
        || record.sequence !== index + 1
        || record.previousRecordHash !== previousRecordHash
      )
    )
  ) {
    const error = new Error(
      `Interest validation journal chain did not verify at ${path.basename(filePath)}:${index + 1}`,
    );
    error.code = 'interest_store_integrity_error';
    throw error;
  }
  return record;
}

function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}

function privateParent(filePath) {
  privateDirectory(path.dirname(filePath));
}

function parseJsonLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const text = fs.readFileSync(filePath, 'utf8');
  if (!text.trim()) return [];
  return text
    .split('\n')
    .filter((line) => line.trim())
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        const next = new Error(
          `Interest validation journal is corrupt at ${path.basename(filePath)}:${index + 1}`,
        );
        next.code = 'interest_store_corrupt';
        next.cause = error;
        throw next;
      }
    });
}

function atomicWriteJson(filePath, value) {
  privateParent(filePath);
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  const descriptor = fs.openSync(
    temporary,
    fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
    0o600,
  );
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, filePath);
  const directoryDescriptor = fs.openSync(path.dirname(filePath), 'r');
  try {
    fs.fsyncSync(directoryDescriptor);
  } finally {
    fs.closeSync(directoryDescriptor);
  }
}

function createInterestValidationStore({
  dataDir = DEFAULT_DATA_DIR,
} = {}) {
  const resolvedDataDir = path.resolve(dataDir);
  const recordsDir = path.join(resolvedDataDir, 'records');
  const summaryPath = path.join(resolvedDataDir, 'summary.json');

  function initialize() {
    privateDirectory(resolvedDataDir);
    privateDirectory(recordsDir);
  }

  function recordPath(kind) {
    if (!RECORD_KINDS.has(kind)) {
      const error = new Error(`Unsupported interest validation record kind: ${kind}`);
      error.code = 'interest_store_invalid_kind';
      throw error;
    }
    return path.join(recordsDir, `${kind}.jsonl`);
  }

  function readRecords(kind, { limit = null } = {}) {
    initialize();
    const filePath = recordPath(kind);
    let previousRecordHash = null;
    const rows = parseJsonLines(filePath).map((row, index) => {
      const verified = validateStoredRecord(row, filePath, index, {
        previousRecordHash,
      });
      previousRecordHash = verified.recordHash;
      return verified;
    });
    if (!Number.isInteger(limit) || limit <= 0 || rows.length <= limit) {
      return rows;
    }
    return rows.slice(-limit);
  }

  function appendRecord(kind, value, {
    identity = null,
  } = {}) {
    initialize();
    const filePath = recordPath(kind);
    const base = {
      ...value,
      schemaVersion: value?.schemaVersion || '1',
    };
    const identityValue = identity || value?.identity || contentHash(base);
    let previousRecordHash = null;
    const rows = parseJsonLines(filePath).map((row, index) => {
      const verified = validateStoredRecord(row, filePath, index, {
        previousRecordHash,
      });
      previousRecordHash = verified.recordHash;
      return verified;
    });
    const existing = rows.find(
      (row) => (row.identity || row.recordHash) === identityValue,
    );
    if (existing) {
      return {
        appended: false,
        record: existing,
      };
    }
    const hashable = {
      ...base,
      identity: identityValue,
      sequence: rows.length + 1,
      previousRecordHash,
    };
    const recordHash = contentHash(hashable);
    const record = {
      ...hashable,
      recordHash,
    };
    const descriptor = fs.openSync(
      filePath,
      fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_WRONLY,
      0o600,
    );
    try {
      fs.writeFileSync(descriptor, `${JSON.stringify(record)}\n`, 'utf8');
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.chmodSync(filePath, 0o600);
    return {
      appended: true,
      record,
    };
  }

  function readSummary() {
    initialize();
    if (!fs.existsSync(summaryPath)) return null;
    try {
      const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
      const {
        summaryHash,
        ...hashable
      } = summary;
      if (
        !/^[a-f0-9]{64}$/.test(String(summaryHash || ''))
        || contentHash(hashable) !== summaryHash
      ) {
        const error = new Error(
          'Interest validation summary hash did not verify.',
        );
        error.code = 'interest_store_integrity_error';
        throw error;
      }
      return summary;
    } catch (error) {
      if (error?.code === 'interest_store_integrity_error') throw error;
      const next = new Error('Interest validation summary is corrupt.');
      next.code = 'interest_store_corrupt';
      next.cause = error;
      throw next;
    }
  }

  function writeSummary(value) {
    initialize();
    const summary = {
      ...value,
      schemaVersion: value?.schemaVersion || '1',
    };
    const storedSummary = {
      ...summary,
      summaryHash: contentHash(summary),
    };
    atomicWriteJson(summaryPath, storedSummary);
    return storedSummary;
  }

  function history({ limit = 90 } = {}) {
    const normalizedLimit = Math.max(1, Math.min(366, Number(limit) || 90));
    return {
      predictions: readRecords('predictions', { limit: normalizedLimit }),
      actuals: readRecords('actuals', { limit: normalizedLimit * 4 }),
      misses: readRecords('misses', { limit: normalizedLimit }),
    };
  }

  return {
    appendRecord,
    dataDir: resolvedDataDir,
    history,
    initialize,
    readRecords,
    readSummary,
    writeSummary,
  };
}

module.exports = {
  DEFAULT_DATA_DIR,
  atomicWriteJson,
  contentHash,
  createInterestValidationStore,
  stableJson,
};
