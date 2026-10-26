'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const test = require('node:test');

const SCRIPT = path.join(__dirname, 'nightly_backup.sh');
const BRANCH_REF = 'refs/heads/backup/nightly';

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nightly-backup-test-'));
  const home = path.join(root, 'home');
  const remote = path.join(root, 'remote.git');
  const work = path.join(root, 'work');
  fs.mkdirSync(home);
  const env = {
    ...process.env,
    HOME: home,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid',
    NIGHTLY_BACKUP_LOG: path.join(root, 'backup.log'),
    NIGHTLY_BACKUP_NOTIFY: 'false',
  };
  const git = (...args) => execFileSync('git', args, { cwd: work, env, encoding: 'utf8' }).trim();
  execFileSync('git', ['init', '-q', '--bare', remote], { env });
  execFileSync('git', ['init', '-q', '-b', 'feature', work], { env });
  const write = (rel, content) => {
    fs.mkdirSync(path.dirname(path.join(work, rel)), { recursive: true });
    fs.writeFileSync(path.join(work, rel), content);
  };
  write('.gitignore', 'ignored.log\n');
  write('tracked.txt', 'v1\n');
  write('.claude/settings.local.json', '{"committed": true}\n');
  write('.env.example', 'KEY=placeholder\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  git('remote', 'add', 'origin', remote);
  git('push', '-q', 'origin', 'feature');

  const run = (...args) => spawnSync('bash', [SCRIPT, '--repo', work, ...args], { env, encoding: 'utf8' });
  const remoteTip = () =>
    execFileSync('git', ['--git-dir', remote, 'rev-parse', '--verify', '-q', BRANCH_REF], { env, encoding: 'utf8' })
      .trim();
  const remoteHas = (ref) =>
    spawnSync('git', ['--git-dir', remote, 'rev-parse', '--verify', '-q', ref], { env }).status === 0;
  const indexHash = () =>
    crypto.createHash('sha256').update(fs.readFileSync(path.join(work, '.git', 'index'))).digest('hex');
  const log = () => fs.readFileSync(env.NIGHTLY_BACKUP_LOG, 'utf8');
  return { root, work, git, write, run, remoteTip, remoteHas, indexHash, log };
}

test('backs up the working tree without touching the checkout, and skips when unchanged', (t) => {
  const f = makeFixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  f.write('tracked.txt', 'v2 uncommitted\n');
  f.write('staged.txt', 'staged\n');
  f.git('add', 'staged.txt');
  f.write('untracked/new.txt', 'new\n');
  f.write('ignored.log', 'ignored\n');
  f.write('.claude/settings.local.json', '{"arn": "local only"}\n');
  f.write('artifacts/kalshi-line-backtest/out.csv', 'big\n');
  f.write('output/pdf/report one.pdf', 'pdf\n');
  f.write('.env', 'REAL=1\n');
  f.write('.env.example', 'KEY=changed\n');
  f.write('certs/server.pem', 'pem\n');
  const before = { head: f.git('rev-parse', 'HEAD'), branch: f.git('branch', '--show-current'),
    index: f.indexHash(), status: f.git('status', '--porcelain', '-uall') };

  const dry = f.run('--dry-run');
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(f.remoteHas(BRANCH_REF), false);

  const first = f.run();
  assert.equal(first.status, 0, first.stderr + f.log());
  const tip = f.remoteTip();
  const show = (rel) => f.git('show', `${tip}:${rel}`);
  assert.equal(show('tracked.txt'), 'v2 uncommitted');
  assert.equal(show('staged.txt'), 'staged');
  assert.equal(show('untracked/new.txt'), 'new');
  assert.equal(show('.env.example'), 'KEY=placeholder');
  const files = f.git('ls-tree', '-r', '--name-only', tip).split('\n');
  for (const excluded of ['ignored.log', '.claude/settings.local.json', 'artifacts/kalshi-line-backtest/out.csv',
    'output/pdf/report one.pdf', '.env', 'certs/server.pem']) {
    assert.ok(!files.includes(excluded), `${excluded} must not be backed up`);
  }
  assert.equal(f.git('rev-parse', `${tip}^1`), before.head);
  assert.equal(f.remoteHas('refs/heads/main'), false);

  assert.deepEqual({ head: f.git('rev-parse', 'HEAD'), branch: f.git('branch', '--show-current'),
    index: f.indexHash(), status: f.git('status', '--porcelain', '-uall') }, before);

  const second = f.run();
  assert.equal(second.status, 0, second.stderr);
  assert.equal(f.remoteTip(), tip);
  assert.match(f.log(), /nothing changed since backup/);

  f.write('tracked.txt', 'v3\n');
  const third = f.run();
  assert.equal(third.status, 0, third.stderr);
  assert.equal(f.git('rev-parse', `${f.remoteTip()}^1`), tip);
  assert.equal(f.git('rev-parse', `${f.remoteTip()}^2`), before.head);
});

test('refuses to push when a secret appears and logs the file, not the value', (t) => {
  const f = makeFixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const fakeKey = 'AKIA' + 'QWERTYUIOPASDFGH';
  f.write('notes/keys.txt', `aws key ${fakeKey}\n`);
  const result = f.run();
  assert.equal(result.status, 1);
  assert.equal(f.remoteHas(BRANCH_REF), false);
  assert.match(f.log(), /SECRET: notes\/keys\.txt \(aws-access-key-id\)/);
  assert.match(f.log(), /FAILED: possible secrets found/);
  assert.ok(!f.log().includes(fakeKey));
});
