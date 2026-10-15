const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DEFAULT_RUNTIME_SOURCE_FILES, computeRuntimeFingerprint } = require('./runtimeFingerprint.cjs');

test('Vite UI edits preserve process provenance while backend and launch edits require fresh processes', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-runtime-fingerprint-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (filename, text) => {
    const absolute = path.join(root, filename);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, text);
  };
  for (const filename of DEFAULT_RUNTIME_SOURCE_FILES) write(filename, `original:${filename}`);
  const initial = computeRuntimeFingerprint(root);
  assert.deepEqual(initial.errors, []);
  for (const filename of ['src/components/Dashboard/PortfolioBreakdown.jsx', 'src/App.css', 'vite.config.mjs', 'scripts/build/local-commonjs.mjs']) {
    write(filename, 'updated browser source');
    assert.equal(computeRuntimeFingerprint(root).digest, initial.digest, filename);
  }
  for (const filename of ['server.js', 'scripts/dev-stack/cli.js', 'ops/services.json', 'package.json']) {
    write(filename, 'updated process source');
    assert.notEqual(computeRuntimeFingerprint(root).digest, initial.digest, filename);
    write(filename, `original:${filename}`);
  }
});
