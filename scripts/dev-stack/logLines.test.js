'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLineTimer, rotateLog } = require('./logLines');

const AT = '2026-11-17T00:47:56.092Z';
const timer = () => createLineTimer({ now: () => new Date(AT) });

test('each complete line gets the time it was received', () => {
  const lines = timer();
  assert.equal(
    lines.push('[API] /api/portfolio completed in 12ms\nINFO:     127.0.0.1:1 - "GET /livez HTTP/1.1" 200 OK\n'),
    `${AT} [API] /api/portfolio completed in 12ms\n${AT} INFO:     127.0.0.1:1 - "GET /livez HTTP/1.1" 200 OK\n`,
  );
  assert.equal(lines.flush(), '');
});

test('a line split across chunks is written once, when it is complete', () => {
  const lines = timer();
  assert.equal(lines.push('[API] /api/multi-region-quotes comp'), '');
  assert.equal(lines.push('leted in 3755ms\n[FRED] Fetch'), `${AT} [API] /api/multi-region-quotes completed in 3755ms\n`);
  assert.equal(lines.push('ing quote for: DGS10\n'), `${AT} [FRED] Fetching quote for: DGS10\n`);
});

test('the unfinished last line is written when the stream ends', () => {
  const lines = timer();
  assert.equal(lines.push('Traceback (most recent call last):\n  File "app.py"'), `${AT} Traceback (most recent call last):\n`);
  assert.equal(lines.flush(), `${AT}   File "app.py"\n`);
  assert.equal(lines.flush(), '');
});

test('lines that already carry a time, and blank lines, are left alone', () => {
  const lines = timer();
  const own = [
    '2026-11-17T00:47:56.092Z INFO:     127.0.0.1:49206 - "POST /internal/workspace/events HTTP/1.1" 200 OK',
    '2026-11-16 12:10:01,123 INFO started',
    '[2026-11-16T20:10:01.000Z] ready',
    '',
  ];
  assert.equal(lines.push(`${own.join('\n')}\n`), `${own.join('\n')}\n`);
  // A date that is not at the start of the line is not a timestamp for the line.
  assert.equal(lines.push('as of 2026-11-16 12:10 the book is flat\n'), `${AT} as of 2026-11-16 12:10 the book is flat\n`);
});

test('a multi-byte character split between two chunks is not corrupted', () => {
  const lines = timer();
  const bytes = Buffer.from('Still down after 10 min → restart\n', 'utf8');
  const arrow = bytes.indexOf(Buffer.from('→', 'utf8'));
  assert.equal(lines.push(bytes.subarray(0, arrow + 1)), '');
  assert.equal(lines.push(bytes.subarray(arrow + 1)), `${AT} Still down after 10 min → restart\n`);
});

test('a line that never ends is written in pieces instead of being held', () => {
  const lines = timer();
  const written = lines.push('x'.repeat(70 * 1024));
  assert.equal(written, `${AT} ${'x'.repeat(70 * 1024)}\n`);
  assert.equal(lines.flush(), '');
});

test('a full log is rotated and only the configured number of old files is kept', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-log-rotate-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'sidecar.log');
  const names = () => fs.readdirSync(directory).sort();
  const read = (suffix = '') => fs.readFileSync(`${file}${suffix}`, 'utf8');

  // Below the limit, and a log that does not exist yet: nothing moves.
  fs.writeFileSync(file, 'abc');
  assert.equal(rotateLog(file, { maxBytes: 4, keep: 3 }), false);
  assert.equal(rotateLog(path.join(directory, 'missing.log'), { maxBytes: 4, keep: 3 }), false);
  assert.deepEqual(names(), ['sidecar.log']);

  for (const generation of ['one!', 'two!', 'three', 'four!']) {
    fs.writeFileSync(file, generation);
    assert.equal(rotateLog(file, { maxBytes: 4, keep: 3 }), true);
  }
  assert.deepEqual(names(), ['sidecar.log.1', 'sidecar.log.2', 'sidecar.log.3']);
  assert.equal(read('.1'), 'four!');
  assert.equal(read('.2'), 'three');
  assert.equal(read('.3'), 'two!');

  // Keeping more files later extends the series instead of replacing it.
  fs.writeFileSync(file, 'five!');
  assert.equal(rotateLog(file, { maxBytes: 4, keep: 5 }), true);
  assert.deepEqual(names(), ['sidecar.log.1', 'sidecar.log.2', 'sidecar.log.3', 'sidecar.log.4']);
  assert.equal(read('.4'), 'two!');
});
