const {
  summarizeRealTimeAlertPositions,
} = require('./rtaPositionReconstruction.cjs');
const {
  applyRtaCanonicalComparisonGate,
  resolveEtfProCanonicalComparison,
} = require('./researchComparisonSafety.cjs');
const {
  validateRtaCheckpoint,
} = require('./rtaCheckpoint.cjs');
const {
  checkpointToEtfProFullBookPayload,
  validateEtfProCheckpoint,
} = require('./etfProCheckpoint.cjs');

const AUTHORITATIVE_REVALIDATION_PENDING = 'AUTHORITATIVE_REVALIDATION_PENDING';

function pendingResearchIngestionHealth() {
  return {
    status: 'pending',
    healthy: null,
    verified: false,
    errorCode: AUTHORITATIVE_REVALIDATION_PENDING,
    reason: 'AWS research-event and scheduled-ingestion verification is running in the background.',
    observedAt: null,
    lastSuccessAt: null,
    source: 'background-authoritative-revalidation',
  };
}

function buildRtaCheckpointFirstResponse(checkpoint, {
  now = new Date(),
  windowDays = 90,
} = {}) {
  if (!checkpoint || typeof checkpoint !== 'object') return null;
  const checkpointValidation = validateRtaCheckpoint(checkpoint);
  if (!checkpointValidation.valid) return null;
  const trustedCheckpoint = {
    ...checkpoint,
    checkpointValidation,
  };
  const ingestionHealth = pendingResearchIngestionHealth();
  const summary = summarizeRealTimeAlertPositions([], {
    windowDays,
    baseline: trustedCheckpoint,
  });
  summary.sourceDiagnostics = {
    dailySnapshotCount: 0,
    hermesEventSnapshotCount: 0,
    selectedMessageCount: 0,
    materializedEventCount: 0,
    v2EventCount: 0,
    legacyMigrationEventCount: 0,
    researchEventLedgerError: AUTHORITATIVE_REVALIDATION_PENDING,
    canonicalCoverageGapCount: 0,
    canonicalCoverageGaps: [],
    supersededCanonicalCoverageGapCount: 0,
    supersededRejectedMessageCount: 0,
    rejectedMessageCount: 0,
    reconstructionInput: 'manual-official-checkpoint-pending-revalidation',
    positionSource: summary.positionSource,
    positionSourceConfidence: summary.positionSourceConfidence,
    benchmark: summary.baseline,
    checkpointValidation,
    reconstructionWarnings: summary.reconstructionWarnings || [],
    authoritativeRevalidationStatus: 'pending',
    gmailIngestion: {
      status: ingestionHealth.status,
      healthy: false,
      verified: false,
      observedAt: null,
      lastSuccessAt: null,
      errorCode: ingestionHealth.errorCode,
      reason: ingestionHealth.reason,
      source: ingestionHealth.source,
    },
  };
  const response = applyRtaCanonicalComparisonGate(summary, {
    ingestionHealth,
    canonicalLedgerError: AUTHORITATIVE_REVALIDATION_PENDING,
    canonicalCoverageGaps: [],
    authoritativeCheckpoint: trustedCheckpoint,
    now,
  });
  return {
    ...response,
    dataAvailability: {
      ...(response.dataAvailability || {}),
      authoritativeRevalidationStatus: 'pending',
    },
  };
}

function buildEtfProCheckpointFirstResponse(checkpoint, {
  now = new Date(),
} = {}) {
  if (!checkpoint || typeof checkpoint !== 'object') return null;
  const checkpointValidation = validateEtfProCheckpoint(checkpoint);
  if (!checkpointValidation.valid) return null;
  const checkpointTrust = {
    ...checkpoint,
    checkpointValidation,
  };
  const fullBook = checkpointToEtfProFullBookPayload(checkpoint);
  const response = resolveEtfProCanonicalComparison({
    canonicalPayloads: {
      fullBooks: [fullBook],
      actions: [],
    },
    referencePayloads: {
      fullBooks: [fullBook],
      actions: [],
    },
    ingestionHealth: pendingResearchIngestionHealth(),
    canonicalLedgerError: AUTHORITATIVE_REVALIDATION_PENDING,
    canonicalRejections: [],
    canonicalCoverageGaps: [],
    authoritativeCheckpoint: checkpointTrust,
    now,
  });
  return {
    ...response,
    dataAvailability: {
      ...(response.dataAvailability || {}),
      authoritativeRevalidationStatus: 'pending',
    },
    meta: {
      ...(response.meta || {}),
      researchEventSource: 'manual-official-checkpoint-pending-revalidation',
      researchEventCount: 0,
      authoritativeRevalidationStatus: 'pending',
      manualCheckpointId: checkpoint.id,
      manualCheckpointValidation: checkpointValidation,
    },
  };
}

module.exports = {
  AUTHORITATIVE_REVALIDATION_PENDING,
  buildEtfProCheckpointFirstResponse,
  buildRtaCheckpointFirstResponse,
  pendingResearchIngestionHealth,
};
