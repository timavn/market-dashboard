#!/usr/bin/env node

const path = require('path');
const { spawn } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '../..');
const CLI_PATH = path.join(REPO_ROOT, 'scripts/dev-stack/cli.js');
const DELAY_MS = 750;

// The repair endpoint must finish its HTTP response before the API is replaced.
// This helper owns no input: it always executes the same repo-scoped restart.
setTimeout(() => {
  const child = spawn(process.execPath, [CLI_PATH, 'restart', '--detach'], {
    cwd: REPO_ROOT,
    detached: true,
    env: process.env,
    shell: false,
    stdio: 'ignore',
  });
  child.once('spawn', () => {
    child.unref();
  });
  child.once('error', (error) => {
    console.error(`[readiness-repair] delayed restart failed: ${error.message}`);
    process.exitCode = 1;
  });
}, DELAY_MS);
