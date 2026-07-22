#!/usr/bin/env node

const path = require('path');
const { spawn, spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '../..');
const CLI_PATH = path.join(REPO_ROOT, 'scripts/dev-stack/cli.js');
const REBUILD_PATH = path.join(REPO_ROOT, 'scripts/ibkr_sidecar/rebuild_venv.sh');
const DELAY_MS = 750;

function run(file, args) {
  const result = spawnSync(file, args, {
    cwd: REPO_ROOT,
    env: process.env,
    shell: false,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${path.basename(file)} exited with status ${result.status}`);
  }
}

// Delay until the repair endpoint has returned. The repository supervisor's
// stop command refuses unknown port owners, so this cannot kill an unrelated
// process before rebuilding the workspace-owned virtual environment.
setTimeout(() => {
  try {
    run(process.execPath, [CLI_PATH, 'stop']);
    run('/bin/bash', [REBUILD_PATH]);
    const child = spawn(process.execPath, [CLI_PATH, 'start', '--detach'], {
      cwd: REPO_ROOT,
      detached: true,
      env: process.env,
      shell: false,
      stdio: 'ignore',
    });
    child.once('spawn', () => child.unref());
    child.once('error', (error) => {
      console.error(`[readiness-repair] sidecar stack restart failed: ${error.message}`);
      process.exitCode = 1;
    });
  } catch (error) {
    console.error(`[readiness-repair] sidecar runtime rebuild failed: ${error.message}`);
    process.exitCode = 1;
  }
}, DELAY_MS);
