'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  LEGACY_HERMES_MODES,
  legacyHermesIsReadOnly,
  legacyHermesRetiredResponse,
  normalizeLegacyHermesMode,
  rejectLegacyHermesMutation,
  stripLegacyHermesWorkflowFields,
} = require('./legacyHermesMode.cjs');

test('legacy Hermes defaults to retired read-only mode', () => {
  assert.equal(normalizeLegacyHermesMode(''), LEGACY_HERMES_MODES.READ_ONLY);
  assert.equal(legacyHermesIsReadOnly(normalizeLegacyHermesMode('')), true);
});

test('explicit shadow mode remains available for legacy compatibility', () => {
  assert.equal(normalizeLegacyHermesMode('shadow'), LEGACY_HERMES_MODES.SHADOW);
  assert.equal(legacyHermesIsReadOnly(LEGACY_HERMES_MODES.SHADOW), false);
});

test('retired mutation routes return HTTP 410 with the stable error code', () => {
  const calls = [];
  const res = {
    status(code) {
      calls.push(['status', code]);
      return this;
    },
    json(payload) {
      calls.push(['json', payload]);
      return payload;
    },
  };

  rejectLegacyHermesMutation(res, LEGACY_HERMES_MODES.READ_ONLY);

  assert.equal(calls[0][1], 410);
  assert.equal(calls[1][1].errorCode, 'LEGACY_HERMES_RETIRED');
});

test('read-only mode exposes a stable retired mutation contract', () => {
  const response = legacyHermesRetiredResponse(LEGACY_HERMES_MODES.READ_ONLY);
  assert.equal(legacyHermesIsReadOnly(LEGACY_HERMES_MODES.READ_ONLY), true);
  assert.deepEqual(response, {
    error: 'Legacy Hermes workers are retired and read-only.',
    errorCode: 'LEGACY_HERMES_RETIRED',
    legacyMode: 'read-only',
    readOnly: true,
    retired: true,
  });
});

test('unknown legacy Hermes modes fail closed during startup', () => {
  assert.throws(
    () => normalizeLegacyHermesMode('enabled'),
    (error) => error.code === 'LEGACY_HERMES_MODE_INVALID',
  );
});

test('workflow status strips only retired worker fields', () => {
  assert.deepEqual(
    stripLegacyHermesWorkflowFields({
      hedgeye: { status: 'ready' },
      hermesDirector: {},
      hermesWorkers: [],
      hermesAlerts: [],
      hermesTables: {},
    }),
    { hedgeye: { status: 'ready' } },
  );
});
