'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function runPythonTests(group, {
  root = path.resolve(__dirname, '../..'), env = process.env,
  exists = fs.existsSync, run = spawnSync,
  makeDataDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'analyst-test-data-')),
  removeDataDir = directory => fs.rmSync(directory, { recursive: true, force: true }),
} = {}) {
  if (!['ibkr', 'analyst'].includes(group)) throw new Error('Expected ibkr or analyst');
  const directory = `scripts/${group}_sidecar`;
  const python = path.join(root, directory, '.venv/bin/python');
  if (!exists(python)) throw new Error(`Create the isolated ${group} test environment first (${directory}/.venv).`);
  const commands = group === 'analyst'
    ? [['-m', 'ruff', 'check', '--select', 'F821', directory]] : [];
  commands.push(['-m', 'unittest', 'discover', '-s', directory, '-p', 'test_*.py']);
  // Importing app opens its stores and fails in-flight reviews, so tests never inherit the live data directory.
  const dataDir = group === 'analyst' ? makeDataDir() : null;
  const isolation = dataDir ? { ANALYST_DATA_DIR: dataDir } : {};
  try {
    for (const args of commands) {
      const result = run(python, args, { cwd: root, stdio: 'inherit',
        env: { ...env, AWS_EC2_METADATA_DISABLED: 'true', ...isolation } });
      if (result.error) throw result.error;
      if (result.status !== 0) return result.status ?? 1;
    }
    return 0;
  } finally {
    // The run's temporary stores leave with it, whether it passed or failed.
    if (dataDir) removeDataDir(dataDir);
  }
}

if (require.main === module) {
  try { process.exitCode = runPythonTests(process.argv[2]); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { runPythonTests };
