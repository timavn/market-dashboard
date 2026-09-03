#!/usr/bin/env node

require('dotenv').config();

const {
  commitPredictionPnlBackfill,
  previewPredictionPnlBackfill,
} = require('../src/services/ibkrFlexService.cjs');

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function maskAccount(value) {
  const raw = String(value || '');
  if (!raw) return null;
  return `${raw.slice(0, 1)}${'*'.repeat(Math.max(3, raw.length - 3))}${raw.slice(-2)}`;
}

function publicPreview(preview) {
  return {
    status: preview.complete ? 'ready_to_commit' : 'incomplete',
    previewHash: preview.previewHash,
    fromDate: preview.fromDate,
    throughDate: preview.throughDate,
    accounts: preview.accountIds.map(maskAccount),
    coverage: preview.coverage.map((row) => ({ ...row, accountId: maskAccount(row.accountId) })),
    sections: preview.sections,
    reportedSections: preview.reportedSections,
    sectionAlternatives: preview.sectionAlternatives,
    missingSections: preview.missingSections,
    reconciliation: {
      zeroToCent: preview.controls.zeroToCent,
      consolidatedDifference: preview.controls.consolidatedDifference,
      accounts: preview.controls.accounts.map((row) => ({
        account: maskAccount(row.accountId),
        difference: row.difference,
      })),
    },
    juneCpiAudit: {
      ...preview.juneCpiAudit,
      rows: preview.juneCpiAudit.rows.map((row) => ({
        ...row,
        accountId: maskAccount(row.accountId),
      })),
    },
  };
}

async function main() {
  const commitHash = argument('--commit');
  if (commitHash) {
    const result = commitPredictionPnlBackfill(commitHash);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (!process.argv.includes('--dry-run')) {
    throw Object.assign(new Error('Use --dry-run with --from/--through, or --commit <preview-hash>.'), {
      code: 'prediction_pnl_usage',
    });
  }
  const preview = await previewPredictionPnlBackfill({
    fromDate: argument('--from'),
    throughDate: argument('--through'),
  });
  process.stdout.write(`${JSON.stringify(publicPreview(preview), null, 2)}\n`);
  if (!preview.complete) process.exitCode = 2;
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({
    status: 'failed',
    code: error.code || 'prediction_pnl_backfill_failed',
    error: error.message,
  }, null, 2)}\n`);
  process.exitCode = 1;
});
