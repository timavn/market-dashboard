'use strict';
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const defaultManifest = require('../../ops/verification.json');
const defaultRoot = path.resolve(__dirname, '../..');

function runVerification(group = 'local', {
  manifest = defaultManifest,
  root = defaultRoot,
  env = process.env,
  run = spawnSync,
  log = console.log,
  error = console.error,
} = {}) {
  const checks = manifest.checks.filter((check) => check.groups.includes(group));
  if (!checks.length) throw new Error(`Unknown verification group: ${group}`);
  for (const check of checks) {
    log(`Verifying ${check.id}`);
    const [command, ...args] = check.command;
    const result = run(command, args, {
      cwd: root,
      stdio: 'inherit',
      env: { ...env, CI: 'true', AWS_EC2_METADATA_DISABLED: 'true' },
    });
    if (result.error || result.status !== 0) {
      error(`${check.id} failed${result.error ? `: ${result.error.message}` : ''}`);
      return result.status || 1;
    }
  }
  return 0;
}

module.exports = { runVerification };

if (require.main === module) {
  process.exitCode = runVerification(process.argv[2] || 'local');
}
