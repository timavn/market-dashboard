'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// The override supports the scratch-only audit. Normal discovery resolves from
// scripts/testing. These tests read declarations; they never run their commands.
const repositoryRoot = process.env.VERIFICATION_REFERENCES_ROOT
  || path.resolve(__dirname, '../..');

function commandTokens(command) {
  return Array.from(command.matchAll(/"([^"]*)"|'([^']*)'|([^\s;&|]+)/g),
    (match) => match[1] ?? match[2] ?? match[3]);
}

function declaredFileArguments(command) {
  // Deliberately bounded to this repository's literal source/script arguments.
  // This is not a shell parser or a promise to validate arbitrary shell programs.
  return commandTokens(command).filter((token) =>
    /^(?:\.\/)?(?:scripts\/|src\/|infra\/|server\.|vite\.config\.)/.test(token)
    && /\.(?:js|jsx|cjs|mjs|py|sh)$/.test(token));
}

function declaredNpmAliases(command) {
  return Array.from(command.matchAll(/(?:^|&&|\|\||;)\s*npm\s+run\s+([\w:-]+)/g),
    (match) => match[1]);
}

function existingFileArgument(root, argument) {
  const absolute = path.resolve(root, argument);
  const basename = path.basename(absolute);
  const directory = path.dirname(absolute);
  if (!basename.includes('*')) {
    return fs.existsSync(absolute) && fs.statSync(absolute).isFile();
  }
  // The current package uses one basename wildcard: scripts/ops/*.test.js.
  // A newly introduced directory glob must receive an explicit validation rule.
  if (directory.includes('*') || !fs.existsSync(directory)) return false;
  const expression = new RegExp(`^${basename.split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return fs.readdirSync(directory, { withFileTypes: true })
    .some((entry) => entry.isFile() && expression.test(entry.name));
}

function packageReferenceErrors(scripts, fileExists) {
  const errors = [];
  for (const [name, command] of Object.entries(scripts)) {
    if (typeof command !== 'string' || !command.trim()) {
      errors.push(`${name}: script command is empty or not text`);
      continue;
    }
    for (const argument of declaredFileArguments(command)) {
      if (!fileExists(argument)) errors.push(`${name}: missing file ${argument}`);
    }
    for (const alias of declaredNpmAliases(command)) {
      if (!Object.hasOwn(scripts, alias)) errors.push(`${name}: missing npm script ${alias}`);
    }
  }
  return errors;
}

function manifestReferenceErrors(manifest, scripts, fileExists, directoryExists) {
  const errors = [];
  for (const check of manifest.checks) {
    const [executable, ...args] = check.command;
    const alias = executable === 'npm'
      ? args[0] === 'run' ? args[1] : args[0] === 'test' ? 'test' : null
      : null;
    if (alias && !Object.hasOwn(scripts, alias)) {
      errors.push(`${check.id}: missing npm script ${alias}`);
    }
    if (['node', 'python', 'python3'].includes(executable) && args[0] && !args[0].startsWith('-')) {
      if (!fileExists(args[0])) errors.push(`${check.id}: missing file ${args[0]}`);
    }
    const templateIndex = args.indexOf('--template-file');
    if (templateIndex !== -1 && !fileExists(args[templateIndex + 1])) {
      errors.push(`${check.id}: missing template ${args[templateIndex + 1]}`);
    }
    if (args.includes('unittest') && args.includes('discover')) {
      const directoryIndex = args.indexOf('-s');
      if (directoryIndex !== -1 && !directoryExists(args[directoryIndex + 1])) {
        errors.push(`${check.id}: missing test directory ${args[directoryIndex + 1]}`);
      }
    }
  }
  return errors;
}

test('reference audit recognizes current quoted, prefixed and wildcard script arguments without execution', () => {
  assert.deepEqual(declaredFileArguments('cross-env CI=true node --test "scripts/with space.test.cjs" scripts/ops/*.test.js'),
    ['scripts/with space.test.cjs', 'scripts/ops/*.test.js']);
  assert.deepEqual(declaredFileArguments('curl -sf http://localhost:3001/api/discover | python3 -m json.tool'), []);
  assert.deepEqual(declaredNpmAliases('npm run first && npm run second; npm run third'), ['first', 'second', 'third']);
  const seen = [];
  assert.deepEqual(packageReferenceErrors({
    okay: 'node scripts/present.cjs',
    missing: 'node scripts/missing.cjs',
    aggregate: 'npm run okay && npm run absent',
  }, (argument) => { seen.push(argument); return argument === 'scripts/present.cjs'; }), [
    'missing: missing file scripts/missing.cjs',
    'aggregate: missing npm script absent',
  ]);
  assert.deepEqual(seen, ['scripts/present.cjs', 'scripts/missing.cjs']);
});

test('reference audit distinguishes manifest aliases, direct files, test directories and templates', () => {
  const checks = [
    { id: 'install', command: ['npm', 'ci'] },
    { id: 'alias', command: ['npm', 'run', 'absent'] },
    { id: 'test', command: ['npm', 'test', '--', '--runInBand'] },
    { id: 'node', command: ['node', 'scripts/missing.cjs'] },
    { id: 'python', command: ['python3', 'infra/missing.py', '--check'] },
    { id: 'discovery', command: ['python3', '-m', 'unittest', 'discover', '-s', 'infra/tests'] },
    { id: 'sam', command: ['sam', 'validate', '--template-file', 'infra/template.yaml'] },
  ];
  assert.deepEqual(manifestReferenceErrors({ checks }, { test: 'jest' }, () => false, () => false), [
    'alias: missing npm script absent',
    'node: missing file scripts/missing.cjs',
    'python: missing file infra/missing.py',
    'discovery: missing test directory infra/tests',
    'sam: missing template infra/template.yaml',
  ]);
});

test('declared package commands refer to existing repository files and npm scripts', () => {
  const { scripts } = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));
  assert.deepEqual(packageReferenceErrors(scripts,
    (argument) => existingFileArgument(repositoryRoot, argument)), []);
});

test('declared verification checks resolve their script, file, directory and template references', () => {
  const { scripts } = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'ops/verification.json'), 'utf8'));
  assert.deepEqual(manifestReferenceErrors(manifest, scripts,
    (argument) => typeof argument === 'string' && existingFileArgument(repositoryRoot, argument),
    (argument) => typeof argument === 'string'
      && fs.existsSync(path.resolve(repositoryRoot, argument))
      && fs.statSync(path.resolve(repositoryRoot, argument)).isDirectory()), []);
});
