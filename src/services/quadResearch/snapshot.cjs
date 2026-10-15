'use strict';

const fs = require('node:fs/promises');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { GROUPS, GAPS, EXCLUSIONS } = require('./catalog.cjs');
const { METHODOLOGY, quarterIndex, bootstrapGate, sensitivityGate, leaveEpisodeGate } = require('./calculation.cjs');

const DEFAULT_DIRECTORY = path.resolve(__dirname, '../../../data/quad-research');
const HASH = /^[a-f0-9]{64}$/;
const CATEGORIES = new Set(['filled', 'insufficient history', 'unstable', 'undefined']);
const integerAtLeast = (value, minimum) => Number.isInteger(value) && value >= minimum;
function completedCutoff(cutoff, generatedAt) {
  const date = new Date(generatedAt);
  const index = quarterIndex(cutoff);
  return index !== null && Number.isFinite(date.getTime())
    && index < date.getUTCFullYear() * 4 + Math.floor(date.getUTCMonth() / 3);
}
function independentEvidenceVerified(validation, sourceHashes) {
  const evidence = validation?.independentSourceValidation;
  return evidence?.status === 'verified' && evidence.issuer?.status === 'verified'
    && evidence.macro?.status === 'verified' && Array.isArray(evidence.macro.examples)
    && evidence.macro.examples.length === 4
    && [1, 2, 3, 4].every(quad => evidence.macro.examples.filter(item => item.quad === quad && item.status === 'verified').length === 1)
    && Array.isArray(evidence.sourceHashes) && new Set(evidence.sourceHashes).size >= 7
    && evidence.sourceHashes.every(hash => HASH.test(hash) && sourceHashes.includes(hash));
}
function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter(key => value[key] !== undefined)
      .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  throw new Error('Research artifacts require finite JSON values.');
}
function contentHash(value) { return createHash('sha256').update(canonical(value)).digest('hex'); }
function editionIdentity(snapshot) {
  const { version: _version, generatedAt: _generatedAt, ...content } = snapshot;
  return contentHash(content);
}
function sanitizedUrl(value) {
  const url = new URL(value);
  for (const key of [...url.searchParams.keys()]) {
    if (/key|token|secret|authorization/i.test(key)) url.searchParams.delete(key);
  }
  url.username = '';
  url.password = '';
  return url.toString();
}
async function atomicWrite(filename, value) {
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(canonical(value)); await handle.sync(); }
    finally { await handle.close(); }
    await fs.rename(temporary, filename);
    const directory = await fs.open(path.dirname(filename), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await fs.rm(temporary, { force: true }); }
}
async function immutableWrite(filename, value) {
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(canonical(value)); await handle.sync(); }
    finally { await handle.close(); }
    try {
      // Atomic no-overwrite publication: a crash cannot expose a partly written
      // final hash filename, and concurrent builders cannot replace one another.
      await fs.link(temporary, filename);
      const directory = await fs.open(path.dirname(filename), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = JSON.parse(await fs.readFile(filename, 'utf8'));
      if (canonical(existing) !== canonical(value)) throw new Error('Immutable research artifact mismatch.');
    }
  } finally { await fs.rm(temporary, { force: true }); }
}
function validateSnapshot(snapshot) {
  if (snapshot?.schemaVersion !== 1 || snapshot.source !== 'independent-quad-research'
    || snapshot.historicalOnly !== true || snapshot.available !== true
    || snapshot.verified !== true || snapshot.revoked || snapshot.mock || snapshot.seeded
    || !HASH.test(snapshot.version || '') || editionIdentity(snapshot) !== snapshot.version
    || canonical(snapshot.methodology) !== canonical(METHODOLOGY)
    || canonical(snapshot.groups) !== canonical(GROUPS)
    || !/^\d{4}-Q[1-4]$/.test(snapshot.cutoff || '')
    || !Number.isFinite(Date.parse(snapshot.generatedAt))
    || !completedCutoff(snapshot.cutoff, snapshot.generatedAt)
    || !HASH.test(snapshot.inputHash || '')
    || !Array.isArray(snapshot.sourceHashes) || !snapshot.sourceHashes.every(hash => HASH.test(hash))
    || !Array.isArray(snapshot.cells) || snapshot.cells.length !== GAPS.length) {
    throw new Error('Research edition failed integrity validation.');
  }
  const cells = new Map();
  snapshot.cells.forEach(cell => {
    const key = `${cell.exposureId}:${cell.quad}`;
    if (cells.has(key) || !CATEGORIES.has(cell.classification)) throw new Error('Invalid research cell.');
    cells.set(key, cell);
  });
  for (const gap of GAPS) {
    const cell = cells.get(`${gap.exposureId}:${gap.quad}`);
    if (!cell) throw new Error('Missing research decision.');
    const group = GROUPS.find(item => item.id === gap.groupId);
    const benchmark = group?.benchmarks.find(item => item.exposureId === gap.exposureId);
    if (cell.status === 'supported') {
      if (!benchmark || EXCLUSIONS[gap.exposureId] || cell.classification !== 'filled'
        || !independentEvidenceVerified(snapshot.validation, snapshot.sourceHashes)
        || !Number.isInteger(cell.rank) || cell.rank < 1 || cell.rank > group.benchmarks.length
        || cell.peerCount !== group.benchmarks.length || !Number.isFinite(cell.meanReturn)
        || !integerAtLeast(cell.observations, METHODOLOGY.minimumQuadQuarters)
        || !integerAtLeast(cell.episodes, METHODOLOGY.minimumEpisodes) || cell.episodes > cell.observations
        || !integerAtLeast(cell.overallObservations, METHODOLOGY.minimumOverallQuarters)
        || cell.observations > cell.overallObservations
        || cell.sampleStart !== group.startQuarter || cell.sampleEnd !== snapshot.cutoff
        || snapshot.sourceHashes.length === 0 || canonical(cell.benchmark) !== canonical(benchmark)) {
        throw new Error('Unsupported rank in research edition.');
      }
      for (const length of METHODOLOGY.bootstrap.blockLengths) {
        const detail = cell.diagnostics?.bootstrap?.[length];
        if (!detail || detail.blockLength !== length || detail.draws !== METHODOLOGY.bootstrap.draws
          || !Number.isInteger(detail.invalidDraws) || detail.invalidDraws < 0
          || !integerAtLeast(detail.validDraws, 1)
          || detail.validDraws + detail.invalidDraws !== detail.draws
          || !integerAtLeast(detail.interval?.lower, 1) || !integerAtLeast(detail.interval?.upper, 1)
          || detail.interval.upper > cell.peerCount || detail.interval.lower > detail.interval.upper
          || !Number.isInteger(detail.seed) || detail.reason || bootstrapGate(detail, cell.rank)) {
          throw new Error('Research bootstrap evidence is incomplete.');
        }
      }
      const intervals = Object.values(cell.diagnostics.bootstrap).map(detail => detail.interval);
      if (!Array.isArray(cell.rankInterval) || cell.rankInterval.length !== 2
        || cell.rankInterval[0] !== Math.min(...intervals.map(interval => interval.lower))
        || cell.rankInterval[1] !== Math.max(...intervals.map(interval => interval.upper))) {
        throw new Error('Research display interval does not match the evidence.');
      }
      for (const name of ['latestVintage', 'nearBoundaryExcluded']) {
        const detail = cell.diagnostics?.sensitivities?.[name];
        if (!detail || detail.reason || !integerAtLeast(detail.observations, 6)
          || detail.observations > cell.overallObservations || !integerAtLeast(detail.episodes, 2)
          || detail.episodes > detail.observations || !integerAtLeast(detail.rank, 1)
          || detail.rank > cell.peerCount || sensitivityGate({ ...detail, ranks: [detail.rank] }, 0, cell.rank)) {
          throw new Error('Research macro sensitivity evidence is incomplete.');
        }
      }
      const episodes = cell.diagnostics?.leaveEpisodes;
      if (!Array.isArray(episodes) || episodes.length !== cell.episodes
        || episodes.some(detail => !Array.isArray(detail.excludedQuarters) || !detail.excludedQuarters.length || detail.reason
          || !integerAtLeast(detail.observations, 4) || detail.observations >= cell.observations
          || detail.observations + detail.excludedQuarters.length !== cell.observations
          || !integerAtLeast(detail.rank, 1) || detail.rank > cell.peerCount
          || leaveEpisodeGate({ ...detail, ranks: [detail.rank] }, 0, cell.rank))) {
        throw new Error('Research episode evidence is incomplete.');
      }
    } else if (cell.status !== 'unavailable' || cell.rank !== null || !cell.reason
      || cell.classification === 'filled' || (EXCLUSIONS[gap.exposureId] && cell.classification !== 'undefined')) {
      throw new Error('Unavailable research decision lacks a reason.');
    }
  }
  return snapshot;
}
function createSnapshotStore({ directory = process.env.QUAD_RESEARCH_DIRECTORY || DEFAULT_DIRECTORY, synchronousReads = false } = {}) {
  const artifactPath = (type, hash) => {
    if (!HASH.test(hash || '')) throw new Error('Invalid artifact hash.');
    return path.join(directory, type, `${hash}.json`);
  };
  // Synchronous reads are used only by the isolated read worker, never by the
  // HTTP event loop. Its filesystem work cannot queue behind quote-provider DNS.
  const readJson = async filename => JSON.parse(synchronousReads
    ? readFileSync(filename, 'utf8') : await fs.readFile(filename, 'utf8'));
  async function readArtifact(type, hash) {
    const content = await readJson(artifactPath(type, hash));
    if (contentHash(content) !== hash) throw new Error('Research source artifact is corrupt.');
    return content;
  }
  async function revocations() {
    try {
      const record = await readJson(path.join(directory, 'revocations.json'));
      if (!Array.isArray(record.hashes) || !record.hashes.every(hash => HASH.test(hash))) throw new Error('Invalid revocation registry.');
      return new Set(record.hashes);
    } catch (error) { if (error.code === 'ENOENT') return new Set(); throw error; }
  }
  async function verifySources(snapshot) {
    const revoked = await revocations();
    for (const hash of [snapshot.version, snapshot.inputHash, ...snapshot.sourceHashes]) {
      if (revoked.has(hash)) throw new Error('Research edition or input was revoked.');
    }
    const input = await readArtifact('inputs', snapshot.inputHash);
    if (canonical(input.validation || {}) !== canonical(snapshot.validation || {})) throw new Error('Research validation manifest mismatch.');
    if (canonical([...new Set(input.sourceHashes)].sort()) !== canonical(snapshot.sourceHashes)) throw new Error('Research input manifest mismatch.');
    // Independent immutable sources can be verified together. Serial disk
    // awaits let a busy quote server delay every one of dozens of reads.
    // Still recheck every byte on each request; no trusted-result cache.
    await Promise.all(snapshot.sourceHashes.map(async hash => { await readArtifact('raw', hash); }));
    return input;
  }
  return {
    directory,
    async archiveRaw({ source, url, payload, retrievedAt = new Date().toISOString() }) {
      const safeUrl = sanitizedUrl(url);
      const hash = contentHash(payload);
      await immutableWrite(artifactPath('raw', hash), payload);
      const requestHash = contentHash({ source, url: safeUrl });
      // Retrieval metadata is archived independently of stable payload hashes.
      const metadata = { source, url: safeUrl, retrievedAt, hash };
      await immutableWrite(artifactPath('retrievals', contentHash(metadata)), metadata);
      await atomicWrite(artifactPath('requests', requestHash), metadata);
      return hash;
    },
    async loadCachedRaw({ source, url }) {
      try {
        const metadata = await readJson(artifactPath('requests', contentHash({ source, url: sanitizedUrl(url) })));
        if ((await revocations()).has(metadata.hash)) return null;
        return { ...metadata, payload: await readArtifact('raw', metadata.hash) };
      } catch { return null; }
    },
    async saveInputs(inputs) {
      const hash = contentHash(inputs);
      await immutableWrite(artifactPath('inputs', hash), inputs);
      return hash;
    },
    readInputs: hash => readArtifact('inputs', hash),
    async publish(snapshot) {
      validateSnapshot(snapshot);
      await verifySources(snapshot);
      const filename = artifactPath('editions', snapshot.version);
      let edition = snapshot;
      try {
        const existing = validateSnapshot(await readJson(filename));
        if (editionIdentity(existing) !== editionIdentity(snapshot)) throw new Error('Research edition collision.');
        edition = existing; // Keep the original calculation date on an identical rebuild.
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await immutableWrite(filename, edition);
      await atomicWrite(path.join(directory, 'latest.json'), { schemaVersion: 1, version: edition.version, artifactHash: contentHash(edition) });
      return edition;
    },
    async latest() {
      try {
        const pointer = await readJson(path.join(directory, 'latest.json'));
        const edition = validateSnapshot(await readJson(artifactPath('editions', pointer.version)));
        if (pointer.schemaVersion !== 1 || contentHash(edition) !== pointer.artifactHash) throw new Error('Research pointer mismatch.');
        await verifySources(edition);
        return edition;
      } catch {
        return { schemaVersion: 1, source: 'independent-quad-research', historicalOnly: true,
          available: false, cells: [], reason: 'Verified historical research edition unavailable.' };
      }
    },
  };
}

module.exports = { DEFAULT_DIRECTORY, canonical, contentHash, editionIdentity, atomicWrite, completedCutoff,
  independentEvidenceVerified, validateSnapshot, createSnapshotStore };
