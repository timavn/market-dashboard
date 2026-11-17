'use strict';

const fs = require('node:fs');
const { StringDecoder } = require('node:string_decoder');

// A line that already says when it was written (the Analyst sidecar's own
// logging, a Python log record, an ISO time in brackets) is left as it is.
const ALREADY_TIMED = /^\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
// A stream that never ends its line (a progress bar) is written out in pieces
// rather than held in memory.
const MAX_PENDING_CHARS = 64 * 1024;

/**
 * Puts the time in front of each line of a service's output, for services
 * whose own log lines carry none. The time is when the supervisor received the
 * line, in the same form the Analyst sidecar writes: 2026-11-17T00:47:56.092Z.
 *
 * Output arrives in arbitrary chunks, so the last, unfinished line is held
 * until the rest of it arrives; `flush` returns it when the stream ends.
 */
function createLineTimer({ now = () => new Date() } = {}) {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  const timed = (line) => (
    line.trim() === '' || ALREADY_TIMED.test(line)
      ? line
      : `${now().toISOString()} ${line}`
  );
  return {
    push(chunk) {
      pending += typeof chunk === 'string' ? chunk : decoder.write(chunk);
      const lines = pending.split('\n');
      pending = lines.pop();
      let text = lines.map((line) => `${timed(line)}\n`).join('');
      if (pending.length > MAX_PENDING_CHARS) {
        text += `${timed(pending)}\n`;
        pending = '';
      }
      return text;
    },
    flush() {
      const rest = pending + decoder.end();
      pending = '';
      return rest === '' ? '' : `${timed(rest)}\n`;
    },
  };
}

/**
 * Moves a log that has reached `maxBytes` to `<file>.1`, shifting the older
 * files up by one. The file that was `<file>.<keep>` is replaced, so `keep`
 * rotated files remain beside the live one.
 */
function rotateLog(file, { maxBytes, keep = 5 } = {}, fileSystem = fs) {
  try {
    if (fileSystem.statSync(file).size < maxBytes) return false;
    for (let n = keep - 1; n >= 1; n -= 1) {
      const from = `${file}.${n}`;
      if (fileSystem.existsSync(from)) fileSystem.renameSync(from, `${file}.${n + 1}`);
    }
    fileSystem.renameSync(file, `${file}.1`);
    return true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return false;
  }
}

module.exports = { createLineTimer, rotateLog };
