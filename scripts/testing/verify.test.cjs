const test = require('node:test');
const assert = require('node:assert/strict');
const { runVerification } = require('./verify.cjs');

function harness(results = [{ status: 0 }, { status: 0 }]) {
  const calls = [];
  const logs = [];
  const errors = [];
  const manifest = {
    checks: [
      { id: 'first', groups: ['local', 'node'], command: ['npm', 'run', 'first'] },
      { id: 'release-only', groups: ['release'], command: ['npm', 'ci'] },
      { id: 'second', groups: ['local'], command: ['node', 'second.cjs', 'argument with spaces'] },
    ],
  };
  const env = Object.freeze({ TASK_TEST: 'preserved', CI: 'false', AWS_EC2_METADATA_DISABLED: 'false' });
  const options = {
    manifest, root: '/verification-fixture', env,
    run: (command, args, config) => {
      calls.push({ command, args, config });
      return results[calls.length - 1];
    },
    log: (message) => logs.push(message),
    error: (message) => errors.push(message),
  };
  return { options, calls, logs, errors };
}

test('defaults to local, preserves manifest order and commands, and inherits output', () => {
  const h = harness();
  const before = JSON.stringify(h.options.manifest);
  assert.equal(runVerification(undefined, h.options), 0);
  assert.deepEqual(h.calls.map(({ command, args }) => [command, ...args]), [
    ['npm', 'run', 'first'], ['node', 'second.cjs', 'argument with spaces'],
  ]);
  assert.ok(h.calls.every(({ config }) => config.cwd === '/verification-fixture' && config.stdio === 'inherit'));
  assert.deepEqual(h.logs, ['Verifying first', 'Verifying second']);
  assert.deepEqual(h.errors, []);
  assert.equal(JSON.stringify(h.options.manifest), before);
});

test('selects exact group membership without running other groups', () => {
  const h = harness();
  assert.equal(runVerification('node', h.options), 0);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.logs, ['Verifying first']);
});

test('unknown groups throw before commands or output', () => {
  const h = harness();
  assert.throws(() => runVerification('missing', h.options), /Unknown verification group: missing/);
  assert.deepEqual([h.calls, h.logs, h.errors], [[], [], []]);
});

test('forces the existing test environment while preserving unrelated variables without mutation', () => {
  const h = harness();
  assert.equal(runVerification('local', h.options), 0);
  assert.deepEqual(h.calls[0].config.env, {
    TASK_TEST: 'preserved', CI: 'true', AWS_EC2_METADATA_DISABLED: 'true',
  });
  assert.equal(h.options.env.CI, 'false');
  assert.notEqual(h.calls[0].config.env, h.calls[1].config.env);
});

for (const [label, result, expected, suffix] of [
  ['nonzero status', { status: 7 }, 7, ''],
  ['spawn error', { status: null, error: new Error('not found') }, 1, ': not found'],
  ['signal termination', { status: null, signal: 'SIGTERM' }, 1, ''],
  ['error with zero status', { status: 0, error: new Error('failed') }, 1, ': failed'],
]) {
  test(`stops at first ${label} and preserves the exit code`, () => {
    const h = harness([result]);
    assert.equal(runVerification('local', h.options), expected);
    assert.equal(h.calls.length, 1);
    assert.deepEqual(h.logs, ['Verifying first']);
    assert.deepEqual(h.errors, [`first failed${suffix}`]);
  });
}

test('reports a later failure without rerunning earlier checks', () => {
  const h = harness([{ status: 0 }, { status: 3 }]);
  assert.equal(runVerification('local', h.options), 3);
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.errors, ['second failed']);
});
