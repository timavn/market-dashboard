'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
function discover(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '__pycache__') return [];
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) return discover(filename);
    return /\.test\.(?:js|cjs|mjs)$/.test(filename)
      && /(?:require\(['"]node:test['"]\)|from ['"]node:test['"])/.test(fs.readFileSync(filename, 'utf8')) ? [filename] : [];
  });
}
const files = ['src', 'scripts'].flatMap((folder) => discover(path.join(root, folder))).sort();
if (process.argv.includes('--list')) { process.stdout.write(`${files.join('\n')}\n`); }
else {
  const result = spawnSync(process.execPath, ['--test', '--test-concurrency=2', ...files], { cwd: root, stdio: 'inherit', env: { ...process.env, AWS_EC2_METADATA_DISABLED: 'true' } });
  if (result.error) { console.error(result.error.message); process.exitCode = 1; }
  else process.exitCode = result.status ?? 1;
}
