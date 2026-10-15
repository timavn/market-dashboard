const test = require('node:test');
const assert = require('node:assert/strict');
const { runPythonTests } = require('./run-python.cjs');

const isolated = { makeDataDir: () => '/tmp/analyst-test-data-1', removeDataDir: () => {} };

test('Analyst lint and tests use the same interpreter via modules', () => {
  const calls = [];
  assert.equal(runPythonTests('analyst', {
    root: '/repo', env: {}, exists: () => true, ...isolated,
    run: (command, args, options) => { calls.push({ command, args, options }); return { status: 0 }; },
  }), 0);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(call => call.args.slice(0, 2)), [['-m', 'ruff'], ['-m', 'unittest']]);
  assert.ok(calls.every(call => call.command === '/repo/scripts/analyst_sidecar/.venv/bin/python'));
  assert.ok(calls.every(call => call.options.env.AWS_EC2_METADATA_DISABLED === 'true'));
});

test('Analyst tests always replace the inherited data directory with a temporary one', () => {
  const calls = [];
  assert.equal(runPythonTests('analyst', {
    root: '/repo', env: { ANALYST_DATA_DIR: '/live/analyst' }, exists: () => true, ...isolated,
    run: (command, args, options) => { calls.push(options.env.ANALYST_DATA_DIR); return { status: 0 }; },
  }), 0);
  assert.deepEqual(calls, ['/tmp/analyst-test-data-1', '/tmp/analyst-test-data-1']);
});

test('failed Analyst lint cannot produce a successful test receipt', () => {
  let calls = 0;
  assert.equal(runPythonTests('analyst', { root: '/repo', exists: () => true, ...isolated,
    run: () => { calls += 1; return { status: 2 }; },
  }), 2);
  assert.equal(calls, 1);
});

test('IBKR runs its isolated unittest suite without requiring Analyst dependencies', () => {
  const calls = [];
  assert.equal(runPythonTests('ibkr', { root: '/repo', exists: () => true,
    run: (command, args) => { calls.push({ command, args }); return { status: 0 }; },
  }), 0);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args.slice(0, 2), ['-m', 'unittest']);
});

test('each Analyst run removes its temporary data directory after passing, failing or crashing', () => {
  const removed = [];
  const options = status => ({ root: '/repo', exists: () => true, makeDataDir: () => `/tmp/analyst-test-data-${status}`,
    removeDataDir: directory => removed.push(directory),
    run: () => (status === 'crash' ? { error: new Error('spawn failed') } : { status }) });
  assert.equal(runPythonTests('analyst', options(0)), 0);
  assert.equal(runPythonTests('analyst', options(1)), 1);
  assert.throws(() => runPythonTests('analyst', options('crash')), /spawn failed/);
  assert.deepEqual(removed, ['/tmp/analyst-test-data-0', '/tmp/analyst-test-data-1', '/tmp/analyst-test-data-crash']);
  // The default directory is real; it is gone once the run returns.
  let created;
  runPythonTests('analyst', { root: '/repo', exists: () => true, run: (_command, _args, { env }) => {
    created = env.ANALYST_DATA_DIR;
    assert.ok(require('node:fs').existsSync(created));
    return { status: 0 };
  } });
  assert.match(created, /analyst-test-data-/);
  assert.equal(require('node:fs').existsSync(created), false);
});
