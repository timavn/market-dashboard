'use strict';

const LEGACY_HERMES_MODES = Object.freeze({
  SHADOW: 'shadow',
  READ_ONLY: 'read-only',
});

function normalizeLegacyHermesMode(value = process.env.LEGACY_HERMES_MODE) {
  const normalized = String(value || LEGACY_HERMES_MODES.READ_ONLY).trim().toLowerCase();
  if (!Object.values(LEGACY_HERMES_MODES).includes(normalized)) {
    const error = new Error(
      `LEGACY_HERMES_MODE must be ${Object.values(LEGACY_HERMES_MODES).join(' or ')}; received ${normalized || '<empty>'}.`,
    );
    error.code = 'LEGACY_HERMES_MODE_INVALID';
    throw error;
  }
  return normalized;
}

function legacyHermesIsReadOnly(mode = normalizeLegacyHermesMode()) {
  return mode === LEGACY_HERMES_MODES.READ_ONLY;
}

function legacyHermesRetiredResponse(mode = normalizeLegacyHermesMode()) {
  return {
    error: 'Legacy Hermes workers are retired and read-only.',
    errorCode: 'LEGACY_HERMES_RETIRED',
    legacyMode: mode,
    readOnly: true,
    retired: true,
  };
}

function rejectLegacyHermesMutation(res, mode = normalizeLegacyHermesMode()) {
  return res.status(410).json(legacyHermesRetiredResponse(mode));
}

function stripLegacyHermesWorkflowFields(workflowStatus) {
  const sanitized = { ...(workflowStatus || {}) };
  delete sanitized.hermesDirector;
  delete sanitized.hermesWorkers;
  delete sanitized.hermesAlerts;
  delete sanitized.hermesTables;
  return sanitized;
}

module.exports = {
  LEGACY_HERMES_MODES,
  legacyHermesIsReadOnly,
  legacyHermesRetiredResponse,
  normalizeLegacyHermesMode,
  rejectLegacyHermesMutation,
  stripLegacyHermesWorkflowFields,
};
