const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createContractPnlHistoryStore, ledgerSourceScope } = require('./contractPnlHistoryStore.cjs');

const row = { id: 'gold', status: 'verified', displayState: 'CLOSED', verification: 'ibkr_flex_settlement', risked: 4, paid: 5 };
function draft(rows = [row]) {
  return { fingerprint: JSON.stringify(rows), payload: {
    selectedAccount: 'U123', rows, activeRows: [],
    availability: { history: { observedAt: '2026-09-10T20:00:00Z' }, current: { status: 'unavailable' } },
  }, executionDetails: { gold: { executions: [{ execId: 'one' }] } } };
}

test('private historical generations survive restart without refreshing provenance; corrections replace rows', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-pnl-history-'));
  try {
    const store = createContractPnlHistoryStore({ dataDir });
    const first = store.publish('U123', draft());
    assert.equal(store.publish('U123', draft()), first);
    assert.equal(fs.statSync(path.join(dataDir, fs.readdirSync(dataDir)[0])).mode & 0o777, 0o600);
    const reopened = createContractPnlHistoryStore({ dataDir });
    assert.deepEqual(reopened.get('U123'), first);
    assert.equal(reopened.get('U456'), null);
    assert.equal(reopened.get('U123').payload.availability.history.observedAt, '2026-09-10T20:00:00Z');
    assert.deepEqual(reopened.details('U123', 'gold', first.projectionRevision), { executions: [{ execId: 'one' }] });
    const corrected = reopened.publish('U123', { ...draft([]), executionDetails: {} });
    assert.notEqual(corrected.projectionRevision, first.projectionRevision);
    assert.deepEqual(corrected.payload.rows, []);
    assert.equal(reopened.details('U123', 'gold', first.projectionRevision), null);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('corrupt, wrong-source, open, seeded and account-mismatched publications cannot become history', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-pnl-history-'));
  try {
    const store = createContractPnlHistoryStore({ dataDir });
    store.publish('U123', draft());
    assert.equal(createContractPnlHistoryStore({ dataDir, sourceScope: 'another-ledger' }).get('U123'), null);
    for (const replacement of [{ ...row, status: 'open' }, { ...row, isSeeded: true }, { ...row, risked: null }]) {
      assert.throws(() => store.publish('U123', draft([replacement])));
    }
    assert.throws(() => store.publish('U456', draft()));
    const file = path.join(dataDir, fs.readdirSync(dataDir)[0]);
    fs.writeFileSync(file, '{invalid');
    assert.equal(createContractPnlHistoryStore({ dataDir }).get('U123'), null);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});

test('same table projections are isolated across configured ledger connections without persisting credentials', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contract-pnl-scope-'));
  const env = { AWS_REGION: 'us-west-1', AWS_PROFILE: 'dashboard' };
  const scope = (overrides = {}) => ledgerSourceScope({ tableName: 'same-table', env: { ...env, ...overrides } });
  try {
    const first = createContractPnlHistoryStore({ dataDir, sourceScope: scope() }).publish('U123', draft());
    assert.deepEqual(createContractPnlHistoryStore({ dataDir, sourceScope: scope() }).get('U123'), first);
    for (const overrides of [{ AWS_REGION: 'us-east-1' }, { AWS_PROFILE: 'other' }, { AWS_ENDPOINT_URL_DYNAMODB: 'http://localhost:8000' }, { AWS_ACCESS_KEY_ID: 'another-ledger-principal' }]) {
      assert.equal(createContractPnlHistoryStore({ dataDir, sourceScope: scope(overrides) }).get('U123'), null);
    }
    assert.equal(scope({ AWS_SECRET_ACCESS_KEY: 'secret', AWS_SESSION_TOKEN: 'token' }), scope());
    assert.equal(scope({ AWS_ACCESS_KEY_ID: 'another-ledger-principal' }).includes('another-ledger-principal'), false);
    assert.equal(scope({ AWS_ENDPOINT_URL: 'https://user:secret@example.test/path?token=secret' }).includes('secret'), false);
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
});
