const crypto = require('crypto');

const ETF_PRO_CHECKPOINT_PARSER_VERSION = 'etf-pro-checkpoint-v1';
const ETF_PRO_MANUAL_SOURCE_KIND = 'manual-official-full-book-checkpoint';
const AUTHORITATIVE_SOURCE_PATTERN = /^manual-official-[a-z0-9][a-z0-9-]*$/;
const DURABLE_ARTIFACT_PATTERN = /^(?:conversation-attachment|repository-artifact|s3-version|file-sha256):\S+$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const VALID_TICKER_PATTERN = /^[A-Z][A-Z0-9./-]{0,9}$/;
const CHECKPOINT_FIELDS = new Set([
  'id',
  'capturedAt',
  'asOf',
  'capturePrecision',
  'source',
  'sourceArtifact',
  'parserVersion',
  'rowCount',
  'longCount',
  'shortCount',
  'rows',
  'notes',
  'contentHash',
]);
const ROW_FIELDS = new Set(['ticker', 'etf', 'call', 'dateAdded', 'entryPrice']);
const UNSAFE_MARKET_FIELD_PATTERN = /(?:price|quote|bid|ask|mark|performance|trend|riskRange|percentFrom|daysHeld|asOf|lastPublished)/i;

function normalizeString(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => normalizeString(item)).filter(Boolean);
}

function normalizeTicker(value) {
  return normalizeString(value).toUpperCase();
}

function normalizeCall(value) {
  const call = normalizeString(value).toLowerCase();
  if (call === 'long') return 'Long';
  if (call === 'short') return 'Short';
  return '';
}

function isValidTimestamp(value) {
  const match = String(value || '').match(
    /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{3})?(?:Z|([+-])(\d{2}):(\d{2}))$/,
  );
  if (!match || !ISO_TIMESTAMP_PATTERN.test(value)) return false;
  const [, date, hour, minute, second, , offsetHour = '00', offsetMinute = '00'] = match;
  return isValidIsoDate(date)
    && Number(hour) <= 23
    && Number(minute) <= 59
    && Number(second) <= 59
    && Number(offsetHour) <= 23
    && Number(offsetMinute) <= 59
    && !Number.isNaN(Date.parse(value));
}

function isValidIsoDate(value) {
  if (!ISO_DATE_PATTERN.test(value || '')) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function canonicalizeEntryPrice(value) {
  if (value === null || value === undefined || value === '') return null;
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function canonicalCheckpointRow(row = {}) {
  const value = row && typeof row === 'object' && !Array.isArray(row) ? row : {};
  const entryPrice = canonicalizeEntryPrice(value.entryPrice);
  const canonical = {
    ticker: normalizeTicker(value.ticker),
    etf: normalizeString(value.etf) || normalizeString(value.name),
    call: normalizeCall(value.call) || normalizeCall(value.side),
    dateAdded: normalizeString(value.dateAdded),
  };
  if (entryPrice !== null) canonical.entryPrice = entryPrice;
  return canonical;
}

function compareCheckpointRows(left, right) {
  return left.ticker.localeCompare(right.ticker)
    || left.call.localeCompare(right.call)
    || left.dateAdded.localeCompare(right.dateAdded)
    || left.etf.localeCompare(right.etf);
}

function canonicalCheckpointRows(value) {
  if (!Array.isArray(value)) return [];
  return value.map(canonicalCheckpointRow).sort(compareCheckpointRows);
}

function summarizeRows(rows = []) {
  const longCount = rows.filter((row) => row.call === 'Long').length;
  const shortCount = rows.filter((row) => row.call === 'Short').length;
  return {
    rowCount: rows.length,
    longCount,
    shortCount,
  };
}

function canonicalCheckpointPayload(checkpoint = {}) {
  const value = checkpoint && typeof checkpoint === 'object' && !Array.isArray(checkpoint)
    ? checkpoint
    : {};
  const rows = canonicalCheckpointRows(value.rows);
  const counts = summarizeRows(rows);
  return {
    id: normalizeString(value.id) || null,
    capturedAt: normalizeString(value.capturedAt) || null,
    asOf: normalizeString(value.asOf) || null,
    capturePrecision: normalizeString(value.capturePrecision) || null,
    source: normalizeString(value.source) || null,
    sourceArtifact: normalizeString(value.sourceArtifact) || null,
    parserVersion: normalizeString(value.parserVersion) || null,
    rowCount: counts.rowCount,
    longCount: counts.longCount,
    shortCount: counts.shortCount,
    rows,
    notes: normalizeStringArray(value.notes),
  };
}

function checkpointContentHash(checkpoint) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(canonicalCheckpointPayload(checkpoint)))
    .digest('hex');
}

function jsonEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function unexpectedKeys(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.keys(value).filter((key) => !allowed.has(key));
}

function validateEtfProCheckpoint(checkpoint) {
  const reasons = [];
  const isObject = Boolean(checkpoint)
    && typeof checkpoint === 'object'
    && !Array.isArray(checkpoint);
  const canonical = canonicalCheckpointPayload(checkpoint);

  if (!isObject) reasons.push('checkpoint-missing');
  if (unexpectedKeys(checkpoint, CHECKPOINT_FIELDS).length > 0) {
    reasons.push('checkpoint-fields-not-canonical');
  }
  if (
    !canonical.id
    || canonical.id !== `etf-pro-official-${String(canonical.capturedAt || '').slice(0, 10)}`
  ) {
    reasons.push('checkpoint-id-mismatch');
  }
  if (!isValidTimestamp(canonical.capturedAt)) reasons.push('capture-time-missing');
  if (!isValidTimestamp(canonical.asOf)) reasons.push('as-of-time-missing');
  if (
    isValidTimestamp(canonical.capturedAt)
    && isValidTimestamp(canonical.asOf)
    && Date.parse(canonical.asOf) > Date.parse(canonical.capturedAt)
  ) {
    reasons.push('as-of-after-capture');
  }
  if (canonical.capturePrecision !== 'exact') reasons.push('capture-precision-invalid');
  if (!canonical.source || !AUTHORITATIVE_SOURCE_PATTERN.test(canonical.source)) {
    reasons.push('source-not-authoritative');
  }
  if (!canonical.sourceArtifact || !DURABLE_ARTIFACT_PATTERN.test(canonical.sourceArtifact)) {
    reasons.push('source-artifact-not-durable');
  }
  if (canonical.parserVersion !== ETF_PRO_CHECKPOINT_PARSER_VERSION) {
    reasons.push('parser-version-mismatch');
  }

  if (!Array.isArray(checkpoint?.rows) || !jsonEqual(checkpoint.rows, canonical.rows)) {
    reasons.push('rows-not-canonical');
  }
  const sourceRows = Array.isArray(checkpoint?.rows) ? checkpoint.rows : [];
  if (sourceRows.some((row) => unexpectedKeys(row, ROW_FIELDS).length > 0)) {
    reasons.push('row-fields-not-canonical');
  }
  if (
    sourceRows.some((row) =>
      unexpectedKeys(row, ROW_FIELDS).some((field) => UNSAFE_MARKET_FIELD_PATTERN.test(field)))
  ) {
    reasons.push('unsafe-market-fields-present');
  }

  if (canonical.rows.length === 0) reasons.push('empty-book');
  if (canonical.rows.some((row) => !VALID_TICKER_PATTERN.test(row.ticker))) {
    reasons.push('invalid-ticker');
  }
  if (canonical.rows.some((row) => !row.etf || row.etf.length > 160)) {
    reasons.push('invalid-name');
  }
  if (canonical.rows.some((row) => !['Long', 'Short'].includes(row.call))) {
    reasons.push('invalid-call');
  }
  if (canonical.rows.some((row) => !isValidIsoDate(row.dateAdded))) {
    reasons.push('invalid-date-added');
  }
  const asOfDate = isValidTimestamp(canonical.asOf) ? canonical.asOf.slice(0, 10) : null;
  if (asOfDate && canonical.rows.some((row) => isValidIsoDate(row.dateAdded) && row.dateAdded > asOfDate)) {
    reasons.push('date-added-after-as-of');
  }
  if (
    sourceRows.some((row) =>
      row?.entryPrice !== null
      && row?.entryPrice !== undefined
      && row?.entryPrice !== ''
      && canonicalizeEntryPrice(row.entryPrice) === null)
  ) {
    reasons.push('invalid-entry-price');
  }

  const tickerSides = new Map();
  canonical.rows.forEach((row) => {
    const sides = tickerSides.get(row.ticker) || [];
    sides.push(row.call);
    tickerSides.set(row.ticker, sides);
  });
  if ([...tickerSides.values()].some((sides) => new Set(sides).size > 1)) {
    reasons.push('side-conflict');
  }
  if ([...tickerSides.values()].some((sides) => sides.length > 1)) {
    reasons.push('duplicate-position');
  }

  const counts = summarizeRows(canonical.rows);
  if (checkpoint?.rowCount !== counts.rowCount) reasons.push('row-count-mismatch');
  if (checkpoint?.longCount !== counts.longCount) reasons.push('long-count-mismatch');
  if (checkpoint?.shortCount !== counts.shortCount) reasons.push('short-count-mismatch');
  if (!Array.isArray(checkpoint?.notes) || !jsonEqual(checkpoint.notes, canonical.notes)) {
    reasons.push('notes-not-canonical');
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
    reasons: [...new Set(reasons)],
    canonical,
    expectedContentHash,
  };
}

function assertExpectedCount(input, field, actual) {
  if (input[field] === undefined) return;
  if (!Number.isInteger(input[field]) || input[field] < 0 || input[field] !== actual) {
    throw new Error(`${field.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}-mismatch`);
  }
}

function createEtfProCheckpoint(input = {}) {
  const capturedAt = normalizeString(input.capturedAt);
  const inputRows = Array.isArray(input.rows)
    ? input.rows
    : Array.isArray(input.positions)
      ? input.positions
      : [];
  if (
    inputRows.some((row) =>
      row?.entryPrice !== null
      && row?.entryPrice !== undefined
      && row?.entryPrice !== ''
      && canonicalizeEntryPrice(row.entryPrice) === null)
  ) {
    throw new Error('Invalid ETF Pro checkpoint: invalid-entry-price');
  }
  const rows = canonicalCheckpointRows(inputRows);
  const counts = summarizeRows(rows);
  assertExpectedCount(input, 'expectedLongCount', counts.longCount);
  assertExpectedCount(input, 'expectedShortCount', counts.shortCount);
  const checkpoint = {
    id: `etf-pro-official-${capturedAt.slice(0, 10)}`,
    capturedAt,
    asOf: normalizeString(input.asOf) || capturedAt,
    capturePrecision: normalizeString(input.capturePrecision),
    source: normalizeString(input.source),
    sourceArtifact: normalizeString(input.sourceArtifact),
    parserVersion: ETF_PRO_CHECKPOINT_PARSER_VERSION,
    ...counts,
    rows,
    notes: normalizeStringArray(input.notes),
  };
  checkpoint.contentHash = checkpointContentHash(checkpoint);
  const validation = validateEtfProCheckpoint(checkpoint);
  if (!validation.valid) {
    throw new Error(`Invalid ETF Pro checkpoint: ${validation.reasons.join(', ')}`);
  }
  return checkpoint;
}

function checkpointToEtfProFullBookPayload(checkpoint) {
  const validation = validateEtfProCheckpoint(checkpoint);
  if (!validation.valid) {
    throw new Error(`Invalid ETF Pro checkpoint: ${validation.reasons.join(', ')}`);
  }
  const { canonical } = validation;
  const longs = canonical.rows
    .filter((row) => row.call === 'Long')
    .map((row) => row.ticker);
  const shorts = canonical.rows
    .filter((row) => row.call === 'Short')
    .map((row) => row.ticker);
  const checkpointValidation = {
    valid: true,
    reasons: [],
    expectedContentHash: validation.expectedContentHash,
  };

  return {
    meta: {
      snapshotDate: canonical.asOf.slice(0, 10),
      parsedAt: canonical.capturedAt,
      asOf: canonical.asOf,
      capturedAt: canonical.capturedAt,
      capturePrecision: canonical.capturePrecision,
      source: canonical.source,
      sourceKind: ETF_PRO_MANUAL_SOURCE_KIND,
      sourceArtifact: canonical.sourceArtifact,
      sourceFile: canonical.sourceArtifact,
      parserVersion: canonical.parserVersion,
      checkpointId: canonical.id,
      contentHash: checkpoint.contentHash,
      checkpointValidation,
      rowCount: canonical.rowCount,
      longCount: canonical.longCount,
      shortCount: canonical.shortCount,
    },
    rows: canonical.rows,
    changes: null,
    data: {
      fullBookLongs: longs,
      fullBookShorts: shorts,
    },
    dataQuality: {
      status: 'ok',
      warnings: [],
      removedButMissing: [],
      duplicateAdds: [],
    },
    contentHash: checkpoint.contentHash,
    checkpointValidation,
  };
}

module.exports = {
  ETF_PRO_CHECKPOINT_PARSER_VERSION,
  ETF_PRO_MANUAL_SOURCE_KIND,
  canonicalCheckpointPayload,
  canonicalCheckpointRow,
  checkpointContentHash,
  checkpointToEtfProFullBookPayload,
  createEtfProCheckpoint,
  validateEtfProCheckpoint,
};
