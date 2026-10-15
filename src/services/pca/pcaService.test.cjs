const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createPcaService, validateConfig, easternClock } = require('./pcaService.cjs');

async function setup(t, options = {}) {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pca-service-'));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  let clock = new Date('2026-09-14T21:45:00Z');
  const calls = { captures: [], candidates: [], comparisons: [] };
  let failure = false;
  const dataSource = {
    async capture(input) {
      calls.captures.push(input);
      if (failure) throw Object.assign(new Error('PRIVATE PROVIDER ERROR'), { code: 'broker_offline' });
      return { accountId: input.account || 'TEST_ACCOUNT', assets: [{ id: 'AAA', symbol: 'AAA', weight: -0.2, returns: [0.01, -0.01] }],
        dates: ['2026-09-11', '2026-09-14'], references: [],
        coverage: { complete: true, holdingCount: 1, modeledCount: 1, excluded: [] },
        provenance: { holdingsObservedAt: clock.toISOString() }, evidence: { secretRaw: 'private' } };
    },
    async candidates(input) { calls.candidates.push(input); return input.symbols.map(symbol => ({ id: symbol, symbol, returns: [0.02, -0.02] })); },
  };
  const modelBuilder = input => ({ modelVersion: 'test-only', dates: input.dates, holdings: input.assets,
    components: [], summary: { dailyVariance: 0.0001 }, fit: { privateReturns: [1, 2] } });
  const scenarioBuilder = input => { calls.comparisons.push(input); return { before: input.model.summary, after: { dailyVariance: 0.0002 } }; };
  const service = createPcaService({ stateDir, dataSource, modelBuilder, scenarioBuilder, defaultAccount: 'TEST_ACCOUNT', now: () => clock, ...options });
  return { service, stateDir, dataSource, modelBuilder, scenarioBuilder, calls,
    setClock: value => { clock = new Date(value); }, fail: () => { failure = true; } };
}

test('configuration validates windows and ordered concentration thresholds', () => {
  assert.equal(validateConfig({ window: '252' }).window, 252);
  for (const window of [0, 62, 505, NaN, 126.5]) assert.throws(() => validateConfig({ window }));
  assert.equal(validateConfig({ highThreshold: 1 }).highThreshold, 1);
  for (const thresholds of [{ warnThreshold: 0 }, { highThreshold: 1.01 }, { warnThreshold: 0.6 }, { highThreshold: 0.3 }]) {
    assert.throws(() => validateConfig(thresholds));
  }
});

test('snapshot starts unavailable; refresh persists only a dated non-executable public model', async t => {
  const { service, stateDir } = await setup(t);
  assert.equal((await service.snapshot()).status, 'unavailable');
  await service.refresh();
  const current = await service.waitForRefresh();
  assert.equal(current.status, 'available');
  assert.equal(current.pending, false);
  assert.equal(current.snapshot.sessionDate, '2026-09-14');
  assert.equal(current.snapshot.executable, false);
  assert.equal(current.snapshot.model.fit, undefined);
  assert.equal(current.snapshot.evidence, undefined);
  assert.equal(current.latestAttempt.status, 'complete');
  const accountFolder = (await fs.readdir(stateDir))[0];
  const mode = (await fs.stat(path.join(stateDir, accountFolder, 'snapshots', `${current.snapshot.id}.json`))).mode;
  assert.equal(mode & 0o777, 0o600);
});

test('unchanged inputs deduplicate; refresh failure preserves original report and dates', async t => {
  const { service, setClock, fail } = await setup(t);
  await service.refresh();
  const original = (await service.waitForRefresh()).snapshot;
  setClock('2026-09-14T22:00:00Z');
  await service.refresh();
  await service.waitForRefresh();
  assert.equal((await service.history()).length, 1);
  fail();
  setClock('2026-09-15T22:00:00Z');
  await service.refresh();
  const failed = await service.waitForRefresh();
  assert.deepEqual(failed.snapshot, original);
  assert.equal(failed.latestAttempt.status, 'failed');
  assert.equal(failed.latestCompletedSession, '2026-09-15');
  assert.equal(JSON.stringify(failed).includes('PRIVATE PROVIDER ERROR'), false);
});

test('candidate comparison loads only new tickers and keeps snapshot and signed deltas fixed', async t => {
  const { service, calls } = await setup(t);
  await service.refresh();
  const { snapshot } = await service.waitForRefresh();
  const result = await service.compare({ snapshotId: snapshot.id, name: 'Pair', changes: [
    { symbol: 'AAA', deltaWeight: 0.03 }, { symbol: 'BBB', deltaWeight: -0.02 }, { symbol: 'BBB', deltaWeight: 0.01 },
  ] });
  assert.equal(result.snapshotId, snapshot.id);
  assert.equal(result.executable, false);
  assert.deepEqual(calls.candidates[0].symbols, ['BBB']);
  assert.deepEqual(calls.candidates[0].dates, snapshot.model.dates);
  assert.deepEqual(calls.comparisons[0].changes, [{ id: 'AAA', deltaWeight: 0.03 }, { id: 'BBB', deltaWeight: -0.01 }]);
  assert.equal(calls.captures.length, 1);
  await assert.rejects(service.compare({ account: 'OTHER', snapshotId: snapshot.id, changes: [{ symbol: 'AAA', deltaWeight: 1 }] }), /selected account/);
});

test('snapshot IDs, accounts and invalid scenario inputs cannot access another account or filesystem', async t => {
  const { service } = await setup(t);
  await assert.rejects(service.snapshot({ id: '../private' }), /valid PCA snapshot/);
  await assert.rejects(service.snapshot({ account: '../../other' }), /valid account/);
  await service.refresh();
  const { snapshot } = await service.waitForRefresh();
  for (const changes of [[], [{ symbol: 'AAA', deltaWeight: '1' }], [{ symbol: 'AAA', deltaWeight: Infinity }], [{ symbol: '$(touch)', deltaWeight: 0.01 }]]) {
    await assert.rejects(service.compare({ snapshotId: snapshot.id, changes }));
  }
});

test('window configuration persists across restarts and histories remain account scoped', async t => {
  const x = await setup(t);
  await x.service.saveConfig('SECOND', { window: 252, warnThreshold: 0.25, highThreshold: 0.4 });
  await x.service.refresh({ account: 'SECOND' });
  await x.service.waitForRefresh({ account: 'SECOND' });
  const restarted = createPcaService({ stateDir: x.stateDir, dataSource: x.dataSource, modelBuilder: x.modelBuilder, defaultAccount: 'SECOND' });
  assert.deepEqual(await restarted.config(), { window: 252, warnThreshold: 0.25, highThreshold: 0.4 });
  assert.equal((await restarted.snapshot()).snapshot.accountId, 'SECOND');
  assert.equal((await x.service.snapshot()).snapshot, null);
});

test('worker waits until 17:30 New York, retries failures after 15 minutes, and skips holidays', async t => {
  const { service, calls, setClock, fail } = await setup(t);
  setClock('2026-09-14T21:29:00Z');
  await service.tick();
  assert.equal(calls.captures.length, 0);
  fail();
  setClock('2026-09-14T21:30:00Z');
  await service.tick();
  await service.waitForRefresh();
  assert.equal(calls.captures.length, 1);
  setClock('2026-09-14T21:40:00Z');
  await service.tick();
  assert.equal(calls.captures.length, 1);
  setClock('2026-09-14T21:46:00Z');
  await service.tick();
  await service.waitForRefresh();
  assert.equal(calls.captures.length, 2);
  setClock('2026-09-07T21:45:00Z');
  await service.tick();
  assert.equal(calls.captures.length, 2);
  assert.deepEqual(easternClock(new Date('2026-11-10T22:30:00Z')), { date: '2026-11-10', minute: 1050 });
});

test('concurrent refresh requests share one capture and startup does not rebuild a completed report', async t => {
  const { service, calls } = await setup(t);
  await Promise.all([service.refresh(), service.refresh(), service.refresh()]);
  await service.waitForRefresh();
  assert.equal(calls.captures.length, 1);
  await service.tick({ startup: true });
  assert.equal(calls.captures.length, 1);
});

test('a partial report is retried after provider delays instead of marked done for the session', async t => {
  const x = await setup(t);
  const originalCapture = x.dataSource.capture;
  let recover = false;
  x.dataSource.capture = async input => {
    const result = await originalCapture(input);
    if (!recover) result.coverage = { ...result.coverage, complete: false, holdingCount: 2, excluded: [{ symbol: 'BBB', reason: 'history_unavailable' }] };
    return result;
  };
  await x.service.tick();
  assert.equal((await x.service.waitForRefresh()).status, 'partial');
  recover = true;
  x.setClock('2026-09-14T22:01:00Z');
  await x.service.tick();
  assert.equal((await x.service.waitForRefresh()).status, 'available');
  assert.equal(x.calls.captures.length, 2);
});

test('concurrent configuration updates merge without losing a window or threshold change', async t => {
  const { service } = await setup(t);
  await Promise.all([service.saveConfig(undefined, { window: 252 }), service.saveConfig(undefined, { warnThreshold: 0.25, highThreshold: 0.4 })]);
  assert.deepEqual(await service.config(), { window: 252, warnThreshold: 0.25, highThreshold: 0.4 });
});

test('provider ordering alone cannot create duplicate snapshot revisions', async t => {
  const x = await setup(t);
  const capture = x.dataSource.capture;
  let reverse = false;
  x.dataSource.capture = async input => {
    const value = await capture(input);
    value.assets.push({ id: 'BBB', symbol: 'BBB', weight: 0.1, returns: [-0.01, 0.01] });
    value.coverage.excluded = [{ id: 'CCC', reason: 'unavailable' }, { id: 'DDD', reason: 'unavailable' }];
    value.coverage.complete = false;
    if (reverse) { value.assets.reverse(); value.coverage.excluded.reverse(); }
    return value;
  };
  await x.service.refresh();
  const first = await x.service.waitForRefresh();
  reverse = true;
  await x.service.refresh();
  const second = await x.service.waitForRefresh();
  assert.equal(first.snapshot.id, second.snapshot.id);
  assert.equal((await x.service.history()).length, 1);
});

test('default scheduler binds its verified account and publishes the same report for explicit and restarted reads', async t => {
  const x = await setup(t, { defaultAccount: null });
  await x.service.tick();
  const first = await x.service.waitForRefresh();
  assert.equal(x.calls.captures.length, 1);
  assert.equal(x.calls.captures[0].account, undefined);
  assert.equal(first.snapshot.accountId, 'TEST_ACCOUNT');
  const explicit = await x.service.snapshot({ account: 'TEST_ACCOUNT' });
  assert.equal(explicit.snapshot.id, first.snapshot.id);
  assert.equal(explicit.latestAttempt.status, 'complete');
  assert.equal((await x.service.history({ account: 'TEST_ACCOUNT' })).length, 1);
  const aliasFile = path.join(x.stateDir, 'default-account.json');
  assert.equal((await fs.stat(aliasFile)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await fs.readFile(aliasFile, 'utf8')).accountId, 'TEST_ACCOUNT');
  const restarted = createPcaService({ stateDir: x.stateDir, dataSource: x.dataSource, modelBuilder: x.modelBuilder,
    scenarioBuilder: x.scenarioBuilder, defaultAccount: null, now: () => new Date('2026-09-14T22:00:00Z') });
  assert.equal((await restarted.snapshot()).snapshot.id, first.snapshot.id);
  assert.equal((await restarted.snapshot({ account: 'default' })).snapshot.id, first.snapshot.id);
  assert.equal((await restarted.snapshot({ account: 'TEST_ACCOUNT' })).snapshot.id, first.snapshot.id);
  assert.equal((await restarted.snapshot({ account: 'ACCOUNT_B' })).snapshot, null);
  await assert.rejects(restarted.compare({ account: 'ACCOUNT_B', snapshotId: first.snapshot.id,
    changes: [{ symbol: 'AAA', deltaWeight: 0.01 }] }), /selected account/);
  await restarted.tick({ startup: true });
  await restarted.waitForRefresh();
  await restarted.waitForRefresh({ account: 'ACCOUNT_B' });
  // ACCOUNT_B was explicitly requested above, so the worker may capture it, but
  // must not capture TEST_ACCOUNT again solely because the default alias changed.
  assert.equal(x.calls.captures.filter(call => !call.account || call.account === 'TEST_ACCOUNT').length, 1);
});

test('known default aliases and explicit account refreshes share one pending capture', async t => {
  const x = await setup(t, { defaultAccount: null });
  await x.service.refresh();
  await x.service.waitForRefresh();
  const capture = x.dataSource.capture;
  let release;
  let entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  x.dataSource.capture = async input => { const value = await capture(input); entered(); await gate; return value; };
  await Promise.all([x.service.refresh(), x.service.refresh({ account: 'default' }), x.service.refresh({ account: 'TEST_ACCOUNT' })]);
  await started;
  assert.equal(x.calls.captures.length, 2);
  assert.equal(x.calls.captures[1].account, 'TEST_ACCOUNT');
  assert.equal((await x.service.snapshot()).pending, true);
  assert.equal((await x.service.snapshot({ account: 'TEST_ACCOUNT' })).pending, true);
  release();
  await x.service.waitForRefresh();
  assert.equal((await x.service.snapshot({ account: 'TEST_ACCOUNT' })).pending, false);
});

test('failed initial capture cannot invent a default account binding', async t => {
  const x = await setup(t, { defaultAccount: null });
  x.fail();
  await x.service.refresh();
  const failed = await x.service.waitForRefresh();
  assert.equal(failed.latestAttempt.status, 'failed');
  assert.equal(failed.snapshot, null);
  await assert.rejects(fs.stat(path.join(x.stateDir, 'default-account.json')), error => error.code === 'ENOENT');
  assert.equal((await x.service.snapshot({ account: 'TEST_ACCOUNT' })).snapshot, null);
});

test('binding preserves explicit account preferences and the first capture retains its requested window', async t => {
  const x = await setup(t, { defaultAccount: null });
  const preference = { window: 252, warnThreshold: 0.25, highThreshold: 0.4 };
  await x.service.saveConfig('TEST_ACCOUNT', preference);
  await x.service.refresh({ window: 126 });
  const first = await x.service.waitForRefresh({ window: 126 });
  assert.equal(first.snapshot.config.window, 126);
  assert.equal((await x.service.snapshot({ account: 'TEST_ACCOUNT', window: 126 })).snapshot.id, first.snapshot.id);
  assert.deepEqual(await x.service.config('TEST_ACCOUNT'), preference);
  assert.deepEqual(await x.service.config(), preference);
  await x.service.refresh();
  const preferred = await x.service.waitForRefresh();
  assert.equal(preferred.snapshot.config.window, 252);
  assert.equal(x.calls.captures.at(-1).account, 'TEST_ACCOUNT');
  assert.equal(x.calls.captures.at(-1).window, 252);
});

test('a capture for the wrong explicit account is not stored or learned as default', async t => {
  const x = await setup(t, { defaultAccount: null });
  const capture = x.dataSource.capture;
  x.dataSource.capture = async input => ({ ...await capture(input), accountId: 'ACCOUNT_A' });
  await x.service.refresh({ account: 'ACCOUNT_B' });
  const result = await x.service.waitForRefresh({ account: 'ACCOUNT_B' });
  assert.equal(result.snapshot, null);
  assert.equal(result.latestAttempt.code, 'account_mismatch');
  await assert.rejects(fs.stat(path.join(x.stateDir, 'default-account.json')), error => error.code === 'ENOENT');
});

test('legacy unbound default reports trigger a verified capture instead of hiding the account from the scheduler', async t => {
  const x = await setup(t, { defaultAccount: null });
  await x.service.refresh();
  const first = await x.service.waitForRefresh();
  const folderFor = account => path.join(x.stateDir, createHash('sha256').update(JSON.stringify(account)).digest('hex').slice(0, 24));
  await fs.cp(folderFor('TEST_ACCOUNT'), folderFor('default'), { recursive: true });
  const manifestFile = path.join(folderFor('default'), 'manifest.json');
  const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  await fs.writeFile(manifestFile, JSON.stringify({ ...manifest, accountKey: 'default' }));
  await fs.rm(folderFor('TEST_ACCOUNT'), { recursive: true });
  await fs.unlink(path.join(x.stateDir, 'default-account.json'));
  const restarted = createPcaService({ stateDir: x.stateDir, dataSource: x.dataSource, modelBuilder: x.modelBuilder,
    defaultAccount: null, now: () => new Date('2026-09-14T22:01:00Z') });
  assert.equal((await restarted.snapshot()).snapshot.id, first.snapshot.id);
  await restarted.tick({ startup: true });
  await restarted.waitForRefresh();
  assert.equal(x.calls.captures.length, 2);
  assert.equal((await restarted.snapshot({ account: 'TEST_ACCOUNT' })).snapshot.id, first.snapshot.id);
});

test('intraday and weekend startup or manual refresh never capture or replace saved close reports', async t => {
  const { service, calls, setClock } = await setup(t);
  await service.refresh();
  const original = (await service.waitForRefresh()).snapshot;
  for (const instant of ['2026-09-15T16:00:00Z', '2026-09-15T21:29:00Z', '2026-09-19T22:00:00Z']) {
    setClock(instant);
    await service.tick({ startup: true });
    await service.tick();
    await assert.rejects(service.refresh(), error => error.code === 'post_close_required' && error.status === 422
      && /17:30 New York/.test(error.message) && /Saved snapshots remain available/.test(error.message));
    assert.equal(calls.captures.length, 1);
    assert.deepEqual((await service.snapshot()).snapshot, original);
  }
});

test('startup recovers only inside the automatic post-close window; later manual builds remain allowed', async t => {
  const { service, calls, setClock } = await setup(t);
  setClock('2026-09-14T21:29:00Z');
  await service.tick({ startup: true });
  assert.equal(calls.captures.length, 0);
  setClock('2026-09-14T21:30:00Z');
  await service.tick({ startup: true });
  assert.equal((await service.waitForRefresh()).latestAttempt.reason, 'startup');
  assert.equal(calls.captures.length, 1);
  setClock('2026-09-15T00:01:00Z');
  await service.tick({ startup: true });
  assert.equal(calls.captures.length, 1);
  await assert.rejects(service.refresh({ reason: 'scheduled' }), error => error.code === 'post_close_required');
  setClock('2026-09-15T03:59:00Z');
  await service.refresh();
  assert.equal((await service.waitForRefresh()).snapshot.sessionDate, '2026-09-14');
  assert.equal(calls.captures.length, 2);
});

test('saved prediction exclusions are outside equity coverage without rewriting original evidence or weights', async t => {
  const x = await setup(t);
  const capture = x.dataSource.capture;
  x.dataSource.capture = async input => {
    const value = await capture(input);
    value.coverage = { complete: false, holdingCount: 2, modeledCount: 1,
      excluded: [{ id: 'EVENT', symbol: 'CPIY', reason: 'prediction_contract_unmodeled' }],
      modeledGrossWeight: 0.2, totalGrossWeight: 0.3 };
    return value;
  };
  await x.service.refresh();
  const result = await x.service.waitForRefresh();
  assert.equal(result.status, 'available');
  assert.equal(result.snapshot.coverage.scope, 'equities-etfs');
  assert.equal(result.snapshot.coverage.holdingCount, 1);
  assert.deepEqual(result.snapshot.coverage.excluded, []);
  assert.equal(result.snapshot.coverage.outOfScope[0].reason, 'prediction_contract');
  assert.equal(result.snapshot.coverage.totalGrossWeight, undefined);
  assert.equal(result.snapshot.model.holdings[0].weight, -0.2);
  const directory = (await fs.readdir(x.stateDir, { withFileTypes: true })).find(row => row.isDirectory());
  const saved = JSON.parse(await fs.readFile(path.join(x.stateDir, directory.name, 'snapshots', `${result.snapshot.id}.json`), 'utf8'));
  assert.equal(saved.coverage.holdingCount, 2);
  assert.equal(saved.coverage.excluded[0].reason, 'prediction_contract_unmodeled');
  x.setClock('2026-09-14T22:01:00Z');
  await x.service.tick();
  assert.equal(x.calls.captures.length, 1);
});
