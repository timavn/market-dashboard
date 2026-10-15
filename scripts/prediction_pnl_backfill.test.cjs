'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { main } = require('./prediction_pnl_backfill.cjs');

const range = ['--from', '2026-01-01', '--through', '2026-09-10'];
const accountId = 'U123456';
function setup() {
  const calls = [];
  const output = [];
  const source = {
    complete: true, accountIds: [accountId], coverage: [{ accountId }],
    controls: { zeroToCent: true, consolidatedDifference: 0, accounts: [{ accountId, difference: 0 }] },
    juneCpiAudit: { rows: [] }, previewHash: 'a'.repeat(64),
  };
  const record = {
    status: 'ready_for_review', mode: 'preview_only', published: false, previewHash: 'b'.repeat(64),
    accounts: [{ accountId, status: 'ready_for_review', idempotent: true,
      proposedWrites: [{ item: { accountId, privateEvidence: 'PRIVATE-EVIDENCE' } }] }],
  };
  const flex = {
    previewStoredPredictionPnlBackfill: (options) => { calls.push(['stored', options]); return source; },
    previewPredictionPnlBackfill: async (options) => { calls.push(['fetch', options]); return source; },
    commitPredictionPnlBackfill: (hash) => { calls.push(['commit', hash]); return { status: 'committed' }; },
    readFlexActivityTrades: (options) => { calls.push(['history', options]); return {}; },
  };
  const dependencies = {
    flex,
    createStore: () => { calls.push(['createStore']); return { readonly: true }; },
    previewReplay: async (options) => {
      calls.push(['replay', options.accountIds, options.store]);
      options.readHistory({ accountId, force: true });
      return record;
    },
  };
  const run = (argv) => main({ argv, env: { PREDICTION_MARKET_PERFORMANCE_ACCOUNT_ID: accountId }, dependencies, write: (text) => output.push(text) });
  return { calls, output, source, record, run };
}

test('stored dry-run never fetches, commits, queries the ledger or persists a preview by default', async () => {
  const fixture = setup();
  assert.equal(await fixture.run(['--dry-run', '--stored', ...range]), 0);
  assert.deepEqual(fixture.calls, [['stored', { fromDate: '2026-01-01', throughDate: '2026-09-10', persist: false }]]);
  assert.ok(!fixture.output.join('').includes(accountId));
});

test('existing fetching dry-run and separate source-approval commit stay explicit', async () => {
  const fixture = setup();
  assert.equal(await fixture.run(['--dry-run', ...range]), 0);
  assert.equal(await fixture.run(['--commit', 'a'.repeat(64)]), 0);
  assert.deepEqual(fixture.calls.map(([name]) => name), ['fetch', 'commit']);
});

test('saving a stored preview is explicit and does not enable automatic sync', async () => {
  const fixture = setup();
  assert.equal(await fixture.run(['--dry-run', '--stored', '--save-preview', ...range]), 0);
  assert.deepEqual(fixture.calls, [['stored', { fromDate: '2026-01-01', throughDate: '2026-09-10', persist: true }]]);
});

test('replay uses the configured account and force-read scope while suppressing private proposed entries in stdout', async () => {
  const fixture = setup();
  assert.equal(await fixture.run(['--dry-run', '--stored', '--replay-ledger', ...range]), 0);
  assert.deepEqual(fixture.calls.map(([name]) => name), ['stored', 'createStore', 'replay', 'history']);
  assert.deepEqual(fixture.calls[2], ['replay', [accountId], { readonly: true }]);
  assert.deepEqual(fixture.calls[3][1], { accountId, force: true, expectedFromDate: '2026-01-01', expectedToDate: '2026-09-10', allowUnconfigured: true });
  assert.ok(!fixture.output.join('').includes(accountId));
  assert.ok(!fixture.output.join('').includes('PRIVATE-EVIDENCE'));
});

test('incomplete stored evidence blocks the ledger connection entirely', async () => {
  const fixture = setup();
  fixture.source.complete = false;
  assert.equal(await fixture.run(['--dry-run', '--stored', '--replay-ledger', ...range]), 2);
  assert.deepEqual(fixture.calls.map(([name]) => name), ['stored']);
});

test('explicit replay audit is private and cannot overwrite an existing audit', async () => {
  const fixture = setup();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pnl-replay-cli-'));
  const audit = path.join(directory, 'audit.json');
  try {
    const argv = ['--dry-run', '--stored', '--replay-ledger', ...range, '--audit', audit];
    assert.equal(await fixture.run(argv), 0);
    assert.equal(fs.statSync(audit).mode & 0o777, 0o600);
    assert.equal(JSON.parse(fs.readFileSync(audit, 'utf8')).accounts[0].accountId, accountId);
    await assert.rejects(fixture.run(argv), { code: 'EEXIST' });
    assert.deepEqual(JSON.parse(fs.readFileSync(audit, 'utf8')), fixture.record);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

for (const argv of [
  ['--commit', 'a'.repeat(64), '--dry-run'],
  ['--dry-run', '--replay-ledger', ...range],
  ['--dry-run', '--stored', '--replay-ledger', '--save-preview', ...range],
  ['--dry-run', '--stored', ...range, '--unknown'],
  ['--dry-run', '--stored', '--from', '--through', '2026-09-10'],
]) {
  test(`rejects ambiguous arguments before any operation: ${argv.join(' ')}`, async () => {
    const fixture = setup();
    await assert.rejects(fixture.run(argv), { code: 'prediction_pnl_usage' });
    assert.deepEqual(fixture.calls, []);
  });
}
