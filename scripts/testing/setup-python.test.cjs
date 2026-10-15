const test = require('node:test');
const assert = require('node:assert/strict');
const { setupPython } = require('./setup-python.cjs');
const manifest = require('../../ops/verification.json');

test('a fresh release creates each isolated environment before installing constrained dependencies', () => {
  for (const group of ['ibkr', 'analyst']) {
    const calls = [];
    const python = setupPython(group, {
      root: '/release/source', env: { MARKET_DASHBOARD_TEST_PYTHON: '/runtime/python3.12' },
      exists: () => false, run: (command, args, options) => {
        calls.push({ command, args, options }); return { status: 0 };
      },
    });
    assert.equal(python, `/release/source/scripts/${group}_sidecar/.venv/bin/python`);
    assert.deepEqual(calls[1].args, ['-m', 'venv', `/release/source/scripts/${group}_sidecar/.venv`]);
    assert.equal(calls[2].command, python);
    assert.ok(calls[2].args.includes('/release/source/scripts/testing/python-bootstrap.txt'));
    assert.deepEqual(calls[2].args.slice(-4), ['-r', `/release/source/scripts/${group}_sidecar/requirements.txt`, '-c', `/release/source/scripts/${group}_sidecar/constraints.txt`]);
    assert.ok(calls.every(call => call.options.cwd === '/release/source'));
  }
});

test('an unsupported interpreter cannot produce a false successful setup', () => {
  const calls = [];
  assert.throws(() => setupPython('analyst', { root: '/release/source', env: {}, exists: () => false,
    run: (command, args) => { calls.push({ command, args }); return { status: 1 }; },
  }), /Python 3.11 or 3.12/);
  assert.ok(calls.every(call => call.args[0] === '-c'));
});

test('CI setup groups and release receipts require the same installations before Python tests', () => {
  const release = manifest.checks.filter(check => check.groups.includes('release'));
  for (const group of ['ibkr', 'analyst']) {
    const setup = manifest.checks.filter(check => check.groups.includes(`setup-${group}`));
    assert.equal(setup.length, 1);
    assert.deepEqual(setup[0].command, ['node', 'scripts/testing/setup-python.cjs', group]);
    assert.ok(release.indexOf(setup[0]) >= 0);
    assert.ok(release.indexOf(setup[0]) < release.findIndex(check => check.id === `python-${group}`));
  }
});
