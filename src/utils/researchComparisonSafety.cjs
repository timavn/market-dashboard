const {
  normalizeIngestionHealth,
  resolveEtfProPayloadFromSources,
} = require('./etfProResolver.cjs');

const RTA_CANONICAL_LEDGER_UNAVAILABLE = 'RTA_CANONICAL_LEDGER_UNAVAILABLE';
const ETF_PRO_CANONICAL_LEDGER_UNAVAILABLE = 'ETF_PRO_CANONICAL_LEDGER_UNAVAILABLE';
const ETF_PRO_CANONICAL_FULL_BOOK_MISSING = 'ETF_PRO_CANONICAL_FULL_BOOK_MISSING';
const ETF_PRO_CANONICAL_COVERAGE_INCOMPLETE = 'ETF_PRO_CANONICAL_COVERAGE_INCOMPLETE';
const ETF_PRO_CANONICAL_REPLAY_INVALID = 'ETF_PRO_CANONICAL_REPLAY_INVALID';
const ETF_PRO_CANONICAL_BOOK_INVALID = 'ETF_PRO_CANONICAL_BOOK_INVALID';
const RTA_CANONICAL_COVERAGE_INCOMPLETE = 'RTA_CANONICAL_COVERAGE_INCOMPLETE';
const DEFAULT_MANUAL_CHECKPOINT_MAX_AGE_MINUTES = 24 * 60;
const MANUAL_CHECKPOINT_FUTURE_SKEW_MS = 5 * 60 * 1000;

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueValues(values = []) {
  return [...new Set(asArray(values).filter(Boolean))];
}

function hasSourceError(value) {
  return Boolean(String(value || '').trim());
}

function resolveAuthoritativeCheckpointTrust(checkpoint, {
  now = new Date(),
  maxAgeMinutes = DEFAULT_MANUAL_CHECKPOINT_MAX_AGE_MINUTES,
} = {}) {
  const candidate = checkpoint && typeof checkpoint === 'object' ? checkpoint : {};
  const validation = candidate.checkpointValidation || candidate.validation || {};
  const capturedAt = candidate.capturedAt || candidate.asOf || null;
  const capturedAtMs = new Date(capturedAt || '').getTime();
  const nowMs = new Date(now).getTime();
  const maxAgeMs = Math.max(1, Number(maxAgeMinutes) || DEFAULT_MANUAL_CHECKPOINT_MAX_AGE_MINUTES)
    * 60 * 1000;
  const source = String(candidate.source || '').trim();
  const exact = candidate.capturePrecision === 'exact';
  const authoritative = /^(?:official|manual-official)-[a-z0-9][a-z0-9-]*$/.test(source);
  const valid = validation.valid === true
    && exact
    && authoritative
    && Number.isFinite(capturedAtMs)
    && Number.isFinite(nowMs);
  const ageMs = valid ? nowMs - capturedAtMs : null;
  const fresh = valid
    && ageMs >= -MANUAL_CHECKPOINT_FUTURE_SKEW_MS
    && ageMs <= maxAgeMs;

  return {
    valid,
    fresh,
    current: fresh,
    capturedAt: Number.isFinite(capturedAtMs) ? new Date(capturedAtMs).toISOString() : null,
    ageMinutes: Number.isFinite(ageMs) ? Math.max(0, ageMs / 60_000) : null,
    maxAgeMinutes: Math.max(
      1,
      Number(maxAgeMinutes) || DEFAULT_MANUAL_CHECKPOINT_MAX_AGE_MINUTES,
    ),
    source: source || null,
    sourceArtifact: candidate.sourceArtifact || null,
    contentHash: candidate.contentHash || null,
    reasons: asArray(validation.reasons),
  };
}

function applyRtaCanonicalComparisonGate(summary, {
  ingestionHealth = null,
  canonicalLedgerError = null,
  canonicalCoverageGaps = [],
  authoritativeCheckpoint = null,
  now = new Date(),
  manualCheckpointMaxAgeMinutes = DEFAULT_MANUAL_CHECKPOINT_MAX_AGE_MINUTES,
} = {}) {
  const response = summary && typeof summary === 'object' ? summary : {};
  const health = normalizeIngestionHealth(ingestionHealth);
  const checkpoint = resolveAuthoritativeCheckpointTrust(authoritativeCheckpoint, {
    now,
    maxAgeMinutes: manualCheckpointMaxAgeMinutes,
  });
  const structurallyAvailable = response.available === true
    && response.dataQuality?.status !== 'error';
  const coverageGaps = asArray(canonicalCoverageGaps);
  const canonicalLedgerVerified = !hasSourceError(canonicalLedgerError);
  const checkpointCurrent = checkpoint.current === true;
  const canonicalSourceVerified = coverageGaps.length === 0
    && (canonicalLedgerVerified || checkpointCurrent);
  const pipelineHealthy = health.healthy === true || checkpointCurrent;
  const comparisonSafe = structurallyAvailable
    && canonicalSourceVerified
    && pipelineHealthy;
  const contentDate = response.lastUpdated
    ? String(response.lastUpdated).slice(0, 10)
    : null;
  const structuralErrorCode = response.dataQuality?.invalidEvents?.[0]?.code || null;

  let errorCode = null;
  let reason = null;
  if (!structurallyAvailable) {
    errorCode = structuralErrorCode || 'RTA_PROJECTION_UNAVAILABLE';
    reason = 'RTA position reconstruction failed structural validation.';
  } else if (!canonicalLedgerVerified && !checkpointCurrent) {
    errorCode = RTA_CANONICAL_LEDGER_UNAVAILABLE;
    reason = 'The canonical RTA research-event ledger could not be verified.';
  } else if (coverageGaps.length > 0) {
    errorCode = RTA_CANONICAL_COVERAGE_INCOMPLETE;
    reason = 'One or more RTA source messages have incomplete canonical action coverage.';
  } else if (!pipelineHealthy) {
    errorCode = health.errorCode || 'GMAIL_HEARTBEAT_UNVERIFIED';
    reason = health.reason || 'Gmail ingestion health could not be verified.';
  }

  return {
    ...response,
    current: comparisonSafe,
    comparisonSafe,
    referenceOnly: structurallyAvailable && !comparisonSafe,
    dataAvailability: {
      structuralStatus: structurallyAvailable
        ? (canonicalSourceVerified ? 'verified' : 'unverified')
        : 'invalid',
      canonicalSourceVerified,
      canonicalCoverageGapCount: coverageGaps.length,
      ingestionStatus: health.status,
      ingestionState: health.rawStatus,
      ingestionVerified: health.verified,
      pipelineHealthy: health.healthy === true,
      current: comparisonSafe,
      comparisonSafe,
      referenceOnly: structurallyAvailable && !comparisonSafe,
      verificationMode: checkpointCurrent
        ? 'manual-official-checkpoint'
        : health.healthy === true
          ? 'scheduled-gmail'
          : 'unverified',
      checkpointVerified: checkpoint.valid,
      checkpointCurrent,
      checkpointCapturedAt: checkpoint.capturedAt,
      checkpointMaxAgeMinutes: checkpoint.maxAgeMinutes,
      checkpointSource: checkpoint.source,
      checkpointSourceArtifact: checkpoint.sourceArtifact,
      checkpointContentHash: checkpoint.contentHash,
      latestContentAt: response.lastUpdated || null,
      contentDate,
      pipelineObservedAt: health.observedAt || null,
      pipelineLastSuccessAt: health.lastSuccessAt || null,
      pipelineErrorCode: health.healthy === true ? null : health.errorCode,
      pipelineReason: health.healthy === true ? null : health.reason,
      errorCode,
      reason,
    },
  };
}

function asReferenceSnapshot(payload) {
  if (!payload || payload.available !== true || payload.dataQuality?.status !== 'ok') {
    return null;
  }
  return {
    ...payload,
    current: false,
    comparisonSafe: false,
    referenceOnly: true,
    dataAvailability: {
      ...(payload.dataAvailability || {}),
      canonicalSourceVerified: false,
      current: false,
      comparisonSafe: false,
      referenceOnly: true,
    },
    meta: {
      ...(payload.meta || {}),
      canonicalSourceVerified: false,
      current: false,
      comparisonSafe: false,
      referenceOnly: true,
    },
  };
}

function failClosedEtfProPayload(referencePayload, {
  ingestionHealth = null,
  errorCode,
  reason,
  structuralStatus = 'unverified',
  warnings = [],
  failures = [],
  dataQualityStatus = 'error',
  failureMeta = {},
} = {}) {
  const candidate = referencePayload && typeof referencePayload === 'object'
    ? referencePayload
    : {};
  const health = normalizeIngestionHealth(ingestionHealth);
  const archivedRowCount = Array.isArray(candidate.rows) ? candidate.rows.length : 0;
  const lastKnownGood = asReferenceSnapshot(candidate);
  const candidateQuality = candidate.dataQuality || {};
  const combinedWarnings = uniqueValues([
    ...asArray(candidateQuality.warnings),
    ...warnings,
  ]);

  return {
    ...candidate,
    available: false,
    current: false,
    comparisonSafe: false,
    referenceOnly: true,
    rows: [],
    actionRows: [],
    changes: null,
    longCount: null,
    shortCount: null,
    lastKnownGood,
    dataQuality: {
      ...candidateQuality,
      status: dataQualityStatus,
      warnings: combinedWarnings,
      ...(failures.length > 0 ? { researchEventFailures: failures } : {}),
    },
    dataAvailability: {
      ...(candidate.dataAvailability || {}),
      ...failureMeta,
      structuralStatus,
      canonicalSourceVerified: false,
      ingestionStatus: health.status,
      ingestionState: health.rawStatus,
      ingestionVerified: health.verified,
      current: false,
      comparisonSafe: false,
      referenceOnly: true,
      latestContentAt: candidate.meta?.parsedAt || candidate.meta?.snapshotDate || null,
      contentDate: candidate.meta?.snapshotDate || null,
      pipelineObservedAt: health.observedAt || null,
      pipelineLastSuccessAt: health.lastSuccessAt || null,
      errorCode,
      reason,
    },
    meta: {
      ...(candidate.meta || {}),
      ...failureMeta,
      available: false,
      canonicalSourceVerified: false,
      current: false,
      comparisonSafe: false,
      referenceOnly: true,
      structurallyAvailable: false,
      ingestionStatus: health.status,
      ingestionState: health.rawStatus,
      blockedByCanonicalSource: true,
      errorCode,
      reason,
      archivedRowCount,
      rowCount: 0,
      longCount: null,
      shortCount: null,
    },
  };
}

function resolveEtfProCanonicalComparison({
  canonicalPayloads = {},
  referencePayloads = canonicalPayloads,
  localPayload = null,
  emailPayload = null,
  ingestionHealth = null,
  canonicalLedgerError = null,
  canonicalRejections = [],
  canonicalCoverageGaps = [],
  authoritativeCheckpoint = null,
  now = new Date(),
  manualCheckpointMaxAgeMinutes = DEFAULT_MANUAL_CHECKPOINT_MAX_AGE_MINUTES,
} = {}) {
  const fullBooks = asArray(canonicalPayloads.fullBooks);
  const actions = asArray(canonicalPayloads.actions);
  const rejections = asArray(canonicalRejections);
  const coverageGaps = asArray(canonicalCoverageGaps);
  const checkpoint = resolveAuthoritativeCheckpointTrust(authoritativeCheckpoint, {
    now,
    maxAgeMinutes: manualCheckpointMaxAgeMinutes,
  });
  const checkpointCurrent = checkpoint.current === true;
  const canonicalDiagnostics = {
    canonicalFullBookCount: fullBooks.length,
    canonicalActionPayloadCount: actions.length,
    canonicalCoverageGapCount: coverageGaps.length,
    checkpointVerified: checkpoint.valid,
    checkpointCurrent,
    checkpointCapturedAt: checkpoint.capturedAt,
    checkpointMaxAgeMinutes: checkpoint.maxAgeMinutes,
    checkpointSource: checkpoint.source,
    checkpointSourceArtifact: checkpoint.sourceArtifact,
    checkpointContentHash: checkpoint.contentHash,
  };
  const resolveReference = () => resolveEtfProPayloadFromSources({
    localPayload,
    emailPayload,
    hermesPayloads: referencePayloads,
    ingestionHealth: null,
  });

  if (hasSourceError(canonicalLedgerError) && !checkpointCurrent) {
    return failClosedEtfProPayload(resolveReference(), {
      ingestionHealth,
      errorCode: ETF_PRO_CANONICAL_LEDGER_UNAVAILABLE,
      reason: 'The canonical ETF Pro research-event ledger could not be verified.',
      warnings: ['ETF Pro active comparison is disabled because the canonical research-event ledger read failed.'],
      failureMeta: canonicalDiagnostics,
    });
  }

  if (rejections.length > 0) {
    const warnings = rejections.map((item) =>
      `ETF Pro source ${item.sourceMessageId || item.eventKey || 'unknown'} failed canonical replay (${item.code || 'invalid-research-event'}).`);
    return failClosedEtfProPayload(resolveReference(), {
      ingestionHealth,
      errorCode: ETF_PRO_CANONICAL_REPLAY_INVALID,
      reason: 'One or more canonical ETF Pro research events could not be replayed.',
      structuralStatus: 'invalid',
      warnings,
      failures: rejections,
      failureMeta: {
        ...canonicalDiagnostics,
        blockedByResearchEventReplay: true,
      },
    });
  }

  if (coverageGaps.length > 0) {
    const failures = coverageGaps.map((item) => ({
      code: 'canonical-event-missing',
      sourceMessageId: item?.sourceMessageId || item?.meta?.sourceMessageId || null,
      eventKind: item?.eventKind || null,
    }));
    return failClosedEtfProPayload(resolveReference(), {
      ingestionHealth,
      errorCode: ETF_PRO_CANONICAL_COVERAGE_INCOMPLETE,
      reason: 'One or more ETF Pro source messages are missing from the canonical research-event ledger.',
      warnings: failures.map((item) =>
        `ETF Pro source ${item.sourceMessageId || 'unknown'} is available only in the legacy archive.`),
      failures,
      failureMeta: canonicalDiagnostics,
    });
  }

  if (fullBooks.length === 0) {
    return failClosedEtfProPayload(resolveReference(), {
      ingestionHealth,
      errorCode: ETF_PRO_CANONICAL_FULL_BOOK_MISSING,
      reason: 'A valid canonical ETF Pro full-book checkpoint is required before actions can be compared.',
      warnings: ['ETF Pro active comparison is disabled because no canonical full-book checkpoint is available.'],
      failureMeta: canonicalDiagnostics,
    });
  }

  const resolved = resolveEtfProPayloadFromSources({
    localPayload: null,
    emailPayload: null,
    hermesPayloads: { fullBooks, actions },
    ingestionHealth: checkpointCurrent ? null : ingestionHealth,
  });

  if (!resolved || (resolved.available !== true && resolved.meta?.blockedByIngestion !== true)) {
    return failClosedEtfProPayload(resolved, {
      ingestionHealth,
      errorCode: ETF_PRO_CANONICAL_BOOK_INVALID,
      reason: 'The canonical ETF Pro full book failed structural validation.',
      structuralStatus: 'invalid',
      warnings: ['ETF Pro active comparison is disabled because the canonical book is structurally invalid.'],
      failureMeta: canonicalDiagnostics,
    });
  }

  const health = normalizeIngestionHealth(ingestionHealth);
  const structurallyAvailable = resolved.available === true
    && resolved.dataQuality?.status === 'ok';
  const comparisonSafe = structurallyAvailable
    && (health.healthy === true || checkpointCurrent);

  return {
    ...resolved,
    current: comparisonSafe,
    comparisonSafe,
    referenceOnly: structurallyAvailable && !comparisonSafe,
    dataAvailability: {
      ...(resolved.dataAvailability || {}),
      canonicalSourceVerified: true,
      ingestionStatus: health.status,
      ingestionState: health.rawStatus,
      ingestionVerified: health.verified,
      pipelineHealthy: health.healthy === true,
      current: comparisonSafe,
      comparisonSafe,
      referenceOnly: structurallyAvailable && !comparisonSafe,
      verificationMode: checkpointCurrent
        ? 'manual-official-checkpoint'
        : health.healthy === true
          ? 'scheduled-gmail'
          : 'unverified',
      checkpointVerified: checkpoint.valid,
      checkpointCurrent,
      checkpointCapturedAt: checkpoint.capturedAt,
      checkpointMaxAgeMinutes: checkpoint.maxAgeMinutes,
      checkpointSource: checkpoint.source,
      checkpointSourceArtifact: checkpoint.sourceArtifact,
      checkpointContentHash: checkpoint.contentHash,
      pipelineObservedAt: health.observedAt || null,
      pipelineLastSuccessAt: health.lastSuccessAt || null,
      pipelineErrorCode: health.healthy === true ? null : health.errorCode,
      pipelineReason: health.healthy === true ? null : health.reason,
      errorCode: comparisonSafe ? null : (health.errorCode || 'GMAIL_HEARTBEAT_UNVERIFIED'),
      reason: comparisonSafe
        ? null
        : (health.reason || 'Gmail ingestion health could not be verified.'),
    },
    meta: {
      ...(resolved.meta || {}),
      ...canonicalDiagnostics,
      canonicalSourceVerified: true,
      current: comparisonSafe,
      comparisonSafe,
      referenceOnly: structurallyAvailable && !comparisonSafe,
      verificationMode: checkpointCurrent
        ? 'manual-official-checkpoint'
        : health.healthy === true
          ? 'scheduled-gmail'
          : 'unverified',
    },
  };
}

module.exports = {
  ETF_PRO_CANONICAL_BOOK_INVALID,
  ETF_PRO_CANONICAL_COVERAGE_INCOMPLETE,
  ETF_PRO_CANONICAL_FULL_BOOK_MISSING,
  ETF_PRO_CANONICAL_LEDGER_UNAVAILABLE,
  ETF_PRO_CANONICAL_REPLAY_INVALID,
  RTA_CANONICAL_LEDGER_UNAVAILABLE,
  RTA_CANONICAL_COVERAGE_INCOMPLETE,
  DEFAULT_MANUAL_CHECKPOINT_MAX_AGE_MINUTES,
  applyRtaCanonicalComparisonGate,
  failClosedEtfProPayload,
  resolveAuthoritativeCheckpointTrust,
  resolveEtfProCanonicalComparison,
};
