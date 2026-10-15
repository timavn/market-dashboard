'use strict';

require('dotenv').config({ quiet: true });
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { rebuild, auditMarkdown } = require('../src/services/quadResearch/builder.cjs');
const { createSnapshotStore, atomicWrite } = require('../src/services/quadResearch/snapshot.cjs');

async function main() {
  const args = process.argv.slice(2);
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (!['--cutoff', '--replay', '--audit'].includes(key) || !args[index + 1]) {
      throw new Error('Usage: npm run research:quad-ranks -- [--cutoff YYYY-Qn] [--replay INPUT_SHA256] [--audit PATH]');
    }
    options[key.slice(2)] = args[++index];
  }
  if (options.replay && options.cutoff) throw new Error('Replay uses the archived cutoff; do not combine --replay with --cutoff.');
  const store = createSnapshotStore();
  const auditPath = path.resolve(options.audit || 'docs/QUAD_RESEARCH_AUDIT.md');
  const temporaryAudit = `${auditPath}.${randomUUID()}.tmp`;
  let publishedEdition = null;
  console.log('Building historical Quad research with fixed validation and publication thresholds…');
  try {
    const { edition } = await rebuild({ store, cutoff: options.cutoff, replayInputHash: options.replay,
      beforePublish: async (_snapshot, audit) => {
        await fs.mkdir(path.dirname(auditPath), { recursive: true });
        const handle = await fs.open(temporaryAudit, 'wx', 0o600);
        try { await handle.writeFile(audit, 'utf8'); await handle.sync(); }
        finally { await handle.close(); }
      } });
    publishedEdition = edition;
    await fs.rename(temporaryAudit, auditPath);
    const counts = edition.cells.reduce((result, cell) => ({ ...result, [cell.classification]: (result[cell.classification] || 0) + 1 }), {});
    console.log(JSON.stringify({ version: edition.version, inputHash: edition.inputHash, cutoff: edition.cutoff, decisions: counts, auditPath }, null, 2));
  } catch (error) {
    if (publishedEdition) {
      console.error(`Research edition ${publishedEdition.version} was published, but the audit report could not be finalized at ${auditPath}. The verified edition remains available.`);
      process.exitCode = 1;
      return;
    }
    if (error.candidate) {
      await atomicWrite(path.join(store.directory, 'failed-builds', `${error.candidate.version}.json`), error.candidate);
      await fs.mkdir(path.dirname(auditPath), { recursive: true });
      await fs.writeFile(auditPath, `> BUILD FAILED: this candidate was not published. The previous verified edition remains selected.\n\n${auditMarkdown(error.candidate)}`, 'utf8');
    }
    throw error;
  } finally { await fs.rm(temporaryAudit, { force: true }); }
}
main().catch(error => {
  // Provider errors can contain credential-bearing request objects. Print only
  // an explicitly constructed message, never an Axios error or request config.
  console.error(error.candidate ? error.message : 'Quad research build failed; previous edition preserved. Check source availability and the input archive.');
  process.exitCode = 1;
});
