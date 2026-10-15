'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { GROUPS, GAPS } = require('./catalog.cjs');
const { quarterIndex } = require('./calculation.cjs');
const { createSnapshotStore, canonical, contentHash, editionIdentity, validateSnapshot } = require('./snapshot.cjs');
const { buildSnapshot, rebuild, auditMarkdown } = require('./builder.cjs');
const { createSnapshotReader } = require('./reader.cjs');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'quad-research-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = createSnapshotStore({ directory });
  const hash = await store.archiveRaw({ source: 'test-only', url: 'https://example.test/history?api_key=private',
    payload: { testOnly: true }, retrievedAt: '2026-09-08T00:00:00Z' });
  const evidenceHashes = [hash];
  for (let index = 1; index <= 6; index++) evidenceHashes.push(await store.archiveRaw({
    source: 'test-only', url: `https://example.test/source/${index}`, payload: { testOnly: true, index } }));
  // These test-only series never enter the application's production directory.
  const inputs = { cutoff: '2026-Q2', generatedAt: '2026-09-08T00:00:00Z', sourceHashes: evidenceHashes,
    validation: { independentSourceValidation: { status: 'verified', sourceHashes: evidenceHashes,
      issuer: { status: 'verified' }, macro: { status: 'verified', examples: [1, 2, 3, 4].map(quad => ({ quad, status: 'verified' })) } } },
    groups: GROUPS.map(group => ({ groupId: group.id, issues: [],
      rows: Array.from({ length: quarterIndex('2026-Q2') - quarterIndex(group.startQuarter) + 1 }, (_, index) => {
        const ordinal = quarterIndex(group.startQuarter) + index;
        const quad = Math.floor(index / 3) % 4 + 1;
        return { quarter: `${Math.floor(ordinal / 4)}-Q${ordinal % 4 + 1}`, quad, latestQuad: quad,
          growthAcceleration: quad < 3 ? 1 : -1, inflationAcceleration: [2, 3].includes(quad) ? 1 : -1,
          returns: Object.fromEntries(group.benchmarks.map((benchmark, peer) => [benchmark.symbol, 0.001 * (peer + 1)])) };
      }) })) };
  await store.saveInputs(inputs);
  return { store, inputs, hash, directory };
}

test('canonical hashes ignore key ordering and reject non-finite inputs', () => {
  assert.equal(contentHash({ z: 1, a: [2, 3] }), contentHash({ a: [2, 3], z: 1 }));
  assert.throws(() => canonical({ value: Number.NaN }), /finite/);
});

test('replay and store reject an incomplete quarter even when the snapshot hash is recomputed', async t => {
  const { inputs } = await fixture(t);
  const incomplete = structuredClone(inputs);
  incomplete.cutoff = '2026-Q3';
  assert.throws(() => buildSnapshot(incomplete), /incomplete/);
  const edition = buildSnapshot(inputs);
  edition.cutoff = '2026-Q3';
  edition.version = editionIdentity(edition);
  assert.throws(() => validateSnapshot(edition), /integrity/);
});

test('independent evidence needs issuer, all four original Quad examples and archived sources', async t => {
  const { inputs } = await fixture(t);
  for (const change of [
    input => { delete input.validation.independentSourceValidation.issuer; },
    input => { input.validation.independentSourceValidation.macro.examples.pop(); },
    input => { input.sourceHashes.pop(); },
  ]) {
    const invalid = structuredClone(inputs);
    change(invalid);
    assert.equal(buildSnapshot(invalid).cells.some(cell => cell.status === 'supported'), false);
  }
});

test('source archives strip credentials, verify hashes and retain retrieval metadata', async t => {
  const { store, directory, hash } = await fixture(t);
  const cached = await store.loadCachedRaw({ source: 'test-only', url: 'https://example.test/history?api_key=different' });
  assert.equal(cached.hash, hash);
  assert.equal(cached.retrievedAt, '2026-09-08T00:00:00Z');
  assert.equal(cached.url.includes('private'), false);
  await fs.writeFile(path.join(directory, 'raw', `${hash}.json`), '{}');
  assert.equal(await store.loadCachedRaw({ source: 'test-only', url: 'https://example.test/history' }), null);
});

test('immutable editions reproduce ranks, intervals and hash, and audit every original gap', async t => {
  const { store, inputs } = await fixture(t);
  const first = buildSnapshot(inputs);
  const second = buildSnapshot(structuredClone(inputs));
  assert.deepEqual(first, second);
  assert.equal(first.cells.length, 39);
  assert.equal(first.cells.filter(cell => cell.classification === 'undefined').length, 7);
  assert.ok(first.cells.some(cell => cell.status === 'supported'));
  assert.equal(validateSnapshot(first), first);
  const published = await store.publish(first);
  assert.deepEqual(await store.latest(), published);
  assert.equal(auditMarkdown(first).split('\n').filter(line => /^\| .* \| Q[1-4] \|/.test(line)).length, GAPS.length);
  assert.equal((await rebuild({ store, replayInputHash: first.inputHash })).edition.version, first.version);
});

test('missing, corrupt and revoked editions or inputs never return estimates', async t => {
  const { store, inputs, directory, hash } = await fixture(t);
  assert.equal((await store.latest()).available, false);
  const edition = await store.publish(buildSnapshot(inputs));
  await fs.writeFile(path.join(directory, 'revocations.json'), JSON.stringify({ hashes: [hash] }));
  assert.equal((await store.latest()).available, false);
  await fs.rm(path.join(directory, 'revocations.json'));
  await fs.writeFile(path.join(directory, 'editions', `${edition.version}.json`), '{}');
  assert.equal((await store.latest()).available, false);
});

test('isolated API reads share only in-flight validation and observe later source revocation', async t => {
  const { store, inputs, directory, hash } = await fixture(t);
  const edition = await store.publish(buildSnapshot(inputs));
  const reader = createSnapshotReader({ directory });
  const first = reader.latest();
  const concurrent = reader.latest();
  assert.equal(first, concurrent);
  assert.equal((await first).version, edition.version);
  await fs.writeFile(path.join(directory, 'revocations.json'), JSON.stringify({ hashes: [hash] }));
  assert.equal((await reader.latest()).available, false);
});

test('failed rebuild and invalid candidate leave the previous atomic pointer unchanged', async t => {
  const { store, inputs, directory } = await fixture(t);
  const edition = await store.publish(buildSnapshot(inputs));
  const before = await fs.readFile(path.join(directory, 'latest.json'), 'utf8');
  await assert.rejects(rebuild({ store, loadInputs: async () => { throw new Error('transport failed'); } }));
  await assert.rejects(rebuild({ store, loadInputs: async () => inputs,
    beforePublish: async () => { throw new Error('audit preparation failed'); } }), /audit preparation/);
  const failed = structuredClone(inputs);
  failed.validation.globalIngestionFailure = true;
  await assert.rejects(rebuild({ store, loadInputs: async () => failed }), /previous verified edition/);
  const unverified = structuredClone(inputs);
  unverified.validation.independentSourceValidation.status = 'failed';
  await assert.rejects(rebuild({ store, loadInputs: async () => unverified }), /previous verified edition/);
  const invalid = structuredClone(edition);
  invalid.cells.find(cell => cell.status === 'supported').rank = 999;
  invalid.version = editionIdentity(invalid);
  await assert.rejects(store.publish(invalid), /Unsupported rank/);
  assert.equal(await fs.readFile(path.join(directory, 'latest.json'), 'utf8'), before);
  assert.equal((await store.latest()).version, edition.version);
});

test('all statistical evidence is required even when a candidate hash is recomputed', async t => {
  const { inputs } = await fixture(t);
  const edition = buildSnapshot(inputs);
  for (const change of [
    cell => { delete cell.diagnostics.bootstrap[8]; },
    cell => { cell.diagnostics.bootstrap[2].invalidDraws = 501; cell.diagnostics.bootstrap[2].validDraws = 4499; },
    cell => { cell.diagnostics.sensitivities.latestVintage.observations = 5; },
    cell => { cell.diagnostics.leaveEpisodes = []; },
    cell => { cell.overallObservations = 31; },
    cell => { delete cell.overallObservations; },
    cell => { delete cell.observations; },
    cell => { delete cell.episodes; },
    cell => { cell.diagnostics.bootstrap[2].interval = {}; },
    cell => { delete cell.diagnostics.sensitivities.latestVintage.observations; },
    cell => { delete cell.diagnostics.sensitivities.latestVintage.episodes; },
    cell => { delete cell.diagnostics.leaveEpisodes[0].observations; },
    cell => { cell.rankInterval = [1, 1]; },
  ]) {
    const invalid = structuredClone(edition);
    change(invalid.cells.find(cell => cell.status === 'supported'));
    invalid.version = editionIdentity(invalid);
    assert.throws(() => validateSnapshot(invalid));
  }
});

test('undefined factors and published cells cannot be inserted as calculated ranks', async t => {
  const { inputs } = await fixture(t);
  const edition = buildSnapshot(inputs);
  const forbidden = structuredClone(edition);
  Object.assign(forbidden.cells.find(cell => cell.classification === 'undefined'), { status: 'supported', classification: 'filled', rank: 1 });
  forbidden.version = editionIdentity(forbidden);
  assert.throws(() => validateSnapshot(forbidden), /Unsupported/);
  const extra = structuredClone(edition);
  extra.cells.push({ exposureId: 'asset-class-gold', quad: 1, status: 'supported', rank: 1 });
  extra.version = editionIdentity(extra);
  assert.throws(() => validateSnapshot(extra), /integrity/);
});
