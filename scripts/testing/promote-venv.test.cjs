const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('stable runtime promotion preserves entrypoints, activation and the archived environment', { timeout: 30_000 }, t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-venv-promotion-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = path.join(root, '.venv.runtimes', 'runtime-1');
  const active = path.join(root, '.venv');
  const helper = path.join(__dirname, 'promote_venv.py');
  fs.mkdirSync(active);
  fs.writeFileSync(path.join(active, 'previous-environment'), 'preserved');
  execFileSync('python3', ['-m', 'venv', '--without-pip', runtime]);
  const entrypoint = path.join(runtime, 'bin', 'runtime-entrypoint');
  fs.writeFileSync(entrypoint, `#!${runtime}/bin/python\nimport os,sys\nprint(os.path.realpath(sys.prefix))\n`, { mode: 0o755 });
  execFileSync('python3', [helper, runtime, active]);
  assert.equal(fs.realpathSync(active), runtime);
  assert.equal(execFileSync(path.join(active, 'bin/runtime-entrypoint'), { encoding: 'utf8' }).trim(), runtime);
  assert.equal(execFileSync('/bin/bash', ['-c', 'source "$1/bin/activate"; printf "%s" "$VIRTUAL_ENV"', 'activation-check', active], { encoding: 'utf8' }), runtime);
  const archived = fs.readdirSync(root).find(name => name.startsWith('.venv.archived-'));
  assert.equal(fs.readFileSync(path.join(root, archived, 'previous-environment'), 'utf8'), 'preserved');

  // A failed pointer replacement restores the old directory, without deleting
  // either validated runtime or its previous archive.
  const rollbackRoot = path.join(root, 'rollback');
  const rollbackActive = path.join(rollbackRoot, '.venv');
  const rollbackRuntime = path.join(rollbackRoot, '.venv.runtimes', 'runtime-2');
  fs.mkdirSync(rollbackActive, { recursive: true });
  fs.writeFileSync(path.join(rollbackActive, 'previous'), 'restored');
  execFileSync('python3', ['-m', 'venv', '--without-pip', rollbackRuntime]);
  execFileSync('python3', ['-c', [
    'import importlib.util,sys',
    'from unittest.mock import patch',
    'spec=importlib.util.spec_from_file_location("promotion",sys.argv[1])',
    'module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)',
    'with patch.object(module.os,"replace",side_effect=OSError("failed replacement")):',
    '    try: module.promote_venv(sys.argv[2],sys.argv[3])',
    '    except OSError: pass',
    '    else: raise AssertionError("replacement should fail")',
  ].join('\n'), helper, rollbackRuntime, rollbackActive]);
  assert.equal(fs.readFileSync(path.join(rollbackActive, 'previous'), 'utf8'), 'restored');
  assert.ok(fs.existsSync(path.join(rollbackRuntime, 'bin/python')));
  assert.ok(!fs.readdirSync(rollbackRoot).some(name => name.startsWith('.venv.next-')));
});
