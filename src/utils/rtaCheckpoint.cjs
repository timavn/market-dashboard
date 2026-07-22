const crypto = require('crypto');

const CHECKPOINT_PARSER_VERSION = 'rta-checkpoint-v1';
const CAPTURE_PRECISIONS = new Set(['exact', 'date-only']);
const AUTHORITATIVE_SOURCE_PATTERN = /^(?:official|manual-official)-[a-z0-9][a-z0-9-]*$/;
const DURABLE_ARTIFACT_PATTERN = /^(?:conversation-attachment|repository-artifact|s3-version|file-sha256):\S+$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/;
const VALID_TICKER_PATTERN = /^[A-Z][A-Z0-9./-]{0,9}$/;

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => normalizeString(item))
    .filter(Boolean);
}

function normalizeTickers(value) {
  return [...new Set(normalizeStringArray(value).map(ticker => ticker.toUpperCase()))].sort();
}

function canonicalCheckpointPayload(checkpoint = {}) {
  const value = checkpoint && typeof checkpoint === 'object' && !Array.isArray(checkpoint)
    ? checkpoint
    : {};
  return {
    id: normalizeString(value.id) || null,
    capturedAt: normalizeString(value.capturedAt) || null,
    asOf: normalizeString(value.asOf) || null,
    capturePrecision: normalizeString(value.capturePrecision) || null,
    source: normalizeString(value.source) || null,
    sourceArtifact: normalizeString(value.sourceArtifact) || null,
    parserVersion: normalizeString(value.parserVersion) || null,
    longs: normalizeTickers(value.longs),
    shorts: normalizeTickers(value.shorts),
    notes: normalizeStringArray(value.notes),
  };
}

function checkpointContentHash(checkpoint) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(canonicalCheckpointPayload(checkpoint)))
    .digest('hex');
}

function isValidTimestamp(value) {
  return ISO_TIMESTAMP_PATTERN.test(value || '') && !Number.isNaN(Date.parse(value));
}

function arraysEqual(left, right) {
  return Array.isArray(left)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function validateRtaCheckpoint(checkpoint) {
  const reasons = [];
  const isObject = Boolean(checkpoint)
    && typeof checkpoint === 'object'
    && !Array.isArray(checkpoint);
  const canonical = canonicalCheckpointPayload(checkpoint);

  if (!isObject) reasons.push('checkpoint-missing');
  if (!canonical.id || canonical.id !== `rta-official-${String(canonical.capturedAt || '').slice(0, 10)}`) {
    reasons.push('checkpoint-id-mismatch');
  }
  if (!isValidTimestamp(canonical.capturedAt)) reasons.push('capture-time-missing');
  if (!isValidTimestamp(canonical.asOf)) reasons.push('as-of-time-missing');
  if (!CAPTURE_PRECISIONS.has(canonical.capturePrecision)) reasons.push('capture-precision-invalid');
  if (!canonical.source || !AUTHORITATIVE_SOURCE_PATTERN.test(canonical.source)) {
    reasons.push('source-not-authoritative');
  }
  if (!canonical.sourceArtifact || !DURABLE_ARTIFACT_PATTERN.test(canonical.sourceArtifact)) {
    reasons.push('source-artifact-not-durable');
  }
  if (canonical.parserVersion !== CHECKPOINT_PARSER_VERSION) reasons.push('parser-version-mismatch');

  if (!Array.isArray(checkpoint?.longs) || !arraysEqual(checkpoint.longs, canonical.longs)) {
    reasons.push('longs-not-canonical');
  }
  if (!Array.isArray(checkpoint?.shorts) || !arraysEqual(checkpoint.shorts, canonical.shorts)) {
    reasons.push('shorts-not-canonical');
  }
  if ([...canonical.longs, ...canonical.shorts].some(ticker => !VALID_TICKER_PATTERN.test(ticker))) {
    reasons.push('invalid-ticker');
  }
  const overlap = canonical.longs.filter(ticker => canonical.shorts.includes(ticker));
  if (overlap.length > 0) reasons.push('side-conflict');
  if (canonical.longs.length + canonical.shorts.length === 0) reasons.push('empty-board');

  if (!Array.isArray(checkpoint?.notes) || !arraysEqual(checkpoint.notes, canonical.notes)) {
    reasons.push('notes-not-canonical');
  }
  if (
    canonical.capturePrecision === 'date-only'
    && !canonical.notes.some(note => /exact capture time.*not visible|approximate as-of/i.test(note))
  ) {
    reasons.push('capture-precision-note-missing');
  }

  const expectedContentHash = checkpointContentHash(checkpoint || {});
  if (
    typeof checkpoint?.contentHash !== 'string'
    || !/^[a-f0-9]{64}$/.test(checkpoint.contentHash)
    || checkpoint.contentHash !== expectedContentHash
  ) {
    reasons.push('content-hash-mismatch');
  }

  return {
    valid: reasons.length === 0,
    reasons,
    canonical,
    expectedContentHash,
  };
}

function createRtaCheckpoint(input = {}) {
  const capturedAt = normalizeString(input.capturedAt);
  const checkpoint = {
    id: `rta-official-${capturedAt.slice(0, 10)}`,
    capturedAt,
    asOf: normalizeString(input.asOf) || capturedAt,
    capturePrecision: normalizeString(input.capturePrecision),
    source: normalizeString(input.source),
    sourceArtifact: normalizeString(input.sourceArtifact),
    parserVersion: CHECKPOINT_PARSER_VERSION,
    longs: normalizeTickers(input.longs),
    shorts: normalizeTickers(input.shorts),
    notes: normalizeStringArray(input.notes),
  };
  checkpoint.contentHash = checkpointContentHash(checkpoint);
  const validation = validateRtaCheckpoint(checkpoint);
  if (!validation.valid) {
    throw new Error(`Invalid RTA checkpoint: ${validation.reasons.join(', ')}`);
  }
  return checkpoint;
}

module.exports = {
  CHECKPOINT_PARSER_VERSION,
  canonicalCheckpointPayload,
  checkpointContentHash,
  createRtaCheckpoint,
  validateRtaCheckpoint,
};
