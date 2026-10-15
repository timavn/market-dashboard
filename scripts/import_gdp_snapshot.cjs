#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { createGdpRecordStore, normalizeGdpRecord } = require('../src/services/predictionMarketTest/gdpResearchRecords.cjs');

function importReviewedGdpSnapshot(input, { store = createGdpRecordStore(), dryRun = false } = {}) {
  const inputs = Array.isArray(input) ? input : Array.isArray(input?.records) ? input.records : [input];
  if (!inputs.length) throw new Error('At least one reviewed GDP snapshot is required.');
  const records = inputs.map((record) => {
    if (record?.kind !== 'forecast' || !['hedgeye', 'consensus'].includes(record?.sourceId)) throw new Error('Import accepts reviewed Hedgeye or consensus forecasts only.');
    return normalizeGdpRecord(record);
  });
  return dryRun ? { valid: records.length, added: 0 } : store.append(records);
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    const files = args.filter((arg) => !arg.startsWith('--'));
    if (files.length !== 1 || args.some((arg) => arg.startsWith('--') && arg !== '--dry-run')) throw new Error('Usage: node scripts/import_gdp_snapshot.cjs snapshot.json [--dry-run]');
    const input = JSON.parse(fs.readFileSync(path.resolve(files[0]), 'utf8'));
    const result = importReviewedGdpSnapshot(input, { dryRun: args.includes('--dry-run') });
    process.stdout.write(`${JSON.stringify({ valid: result.valid, added: result.added })}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { importReviewedGdpSnapshot };
