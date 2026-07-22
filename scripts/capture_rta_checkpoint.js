#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { createRtaCheckpoint } = require('../src/utils/rtaCheckpoint.cjs');

function usage() {
  return [
    'Usage: node scripts/capture_rta_checkpoint.js /absolute/path/to/official-board.json',
    '',
    'Input requires capturedAt, capturePrecision, source, sourceArtifact, longs[], and shorts[].',
    'capturePrecision must be exact or date-only; date-only requires a note explaining the approximate as-of stamp.',
    'source must begin with official- or manual-official-.',
    'sourceArtifact must use conversation-attachment:, repository-artifact:, s3-version:, or file-sha256: provenance.',
  ].join('\n');
}

function main() {
  const inputPath = process.argv[2];
  if (!inputPath || !path.isAbsolute(inputPath)) throw new Error(usage());
  const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const checkpoint = createRtaCheckpoint(input);
  const destination = path.join(__dirname, '..', 'data', 'hedgeye', 'rta', 'latest-benchmark.json');
  const staged = `${destination}.staged-${process.pid}`;
  fs.writeFileSync(staged, `${JSON.stringify(checkpoint, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(staged, destination);
  process.stdout.write(`Installed verified RTA checkpoint ${checkpoint.id} (${checkpoint.contentHash}).\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
