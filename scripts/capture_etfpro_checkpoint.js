#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { createEtfProCheckpoint } = require('../src/utils/etfProCheckpoint.cjs');

function usage() {
  return [
    'Usage: node scripts/capture_etfpro_checkpoint.js /absolute/path/to/official-book.json',
    '',
    'Input requires exact capturedAt/asOf timestamps, capturePrecision="exact", a manual-official-*',
    'source, a durable sourceArtifact, and nonempty rows[]. Rows require ticker, etf (or name),',
    'call, and dateAdded; historical entryPrice is optional.',
    'expectedLongCount and expectedShortCount may be supplied to verify the source headline counts.',
    '',
    'Only position membership and optional historical entry price are installed. Current prices,',
    'performance, range, quote, and holding-period fields are deliberately excluded.',
  ].join('\n');
}

function installCheckpoint(inputPath) {
  if (!inputPath || !path.isAbsolute(inputPath)) throw new Error(usage());
  const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const checkpoint = createEtfProCheckpoint(input);
  const destination = path.join(
    __dirname,
    '..',
    'data',
    'hedgeye',
    'etfpro',
    'latest-checkpoint.json',
  );
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const staged = `${destination}.staged-${process.pid}`;
  try {
    fs.writeFileSync(staged, `${JSON.stringify(checkpoint, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    fs.renameSync(staged, destination);
  } finally {
    try {
      fs.unlinkSync(staged);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  process.stdout.write(
    `Installed verified ETF Pro checkpoint ${checkpoint.id} `
    + `(${checkpoint.longCount} long, ${checkpoint.shortCount} short; ${checkpoint.contentHash}).\n`,
  );
}

try {
  installCheckpoint(process.argv[2]);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
