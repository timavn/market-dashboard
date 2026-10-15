'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const VERSION_PROBE = 'import sys; sys.exit(0 if (3, 11) <= sys.version_info[:2] < (3, 13) else 1)';

function setupPython(group, {
  root = path.resolve(__dirname, '../..'),
  env = process.env,
  exists = fs.existsSync,
  run = spawnSync,
} = {}) {
  if (!['ibkr', 'analyst'].includes(group)) throw new Error('Expected ibkr or analyst');
  const directory = path.join(root, `scripts/${group}_sidecar`);
  const virtualEnvironment = path.join(directory, '.venv');
  const python = path.join(virtualEnvironment, 'bin/python');
  const options = { cwd: root, env: { ...env, AWS_EC2_METADATA_DISABLED: 'true' } };
  function succeeds(command, args) {
    const result = run(command, args, { ...options, stdio: 'ignore' });
    return !result.error && result.status === 0;
  }
  function checked(command, args) {
    const result = run(command, args, { ...options, stdio: 'inherit' });
    if (result.error || result.status !== 0) throw new Error(`Isolated ${group} dependency setup failed (${result.error?.code || result.status}).`);
  }
  if (!exists(python)) {
    const candidates = env.MARKET_DASHBOARD_TEST_PYTHON
      ? [env.MARKET_DASHBOARD_TEST_PYTHON] : ['python3.12', 'python3.11', 'python3'];
    const bootstrap = candidates.find(candidate => succeeds(candidate, ['-c', VERSION_PROBE]));
    if (!bootstrap) throw new Error('Python 3.11 or 3.12 is required; set MARKET_DASHBOARD_TEST_PYTHON to its executable.');
    checked(bootstrap, ['-m', 'venv', virtualEnvironment]);
  } else if (!succeeds(python, ['-c', VERSION_PROBE])) {
    throw new Error(`The existing isolated ${group} environment must use Python 3.11 or 3.12.`);
  }
  checked(python, ['-m', 'pip', 'install', '--disable-pip-version-check',
    '-r', path.join(root, 'scripts/testing/python-bootstrap.txt'),
    '-r', path.join(directory, 'requirements.txt'), '-c', path.join(directory, 'constraints.txt')]);
  return python;
}

if (require.main === module) {
  try { setupPython(process.argv[2]); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { setupPython };
