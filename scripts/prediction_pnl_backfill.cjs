#!/usr/bin/env node

function argument(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
}

function maskAccount(value) {
  const raw = String(value || '');
  if (!raw) return null;
  return `${raw.slice(0, 1)}${'*'.repeat(Math.max(3, raw.length - 3))}${raw.slice(-2)}`;
}

function publicPreview(preview) {
  return {
    status: preview.complete ? 'ready_to_commit' : 'incomplete',
    mode: 'source_validation_preview',
    previewHash: preview.previewHash,
    fromDate: preview.fromDate,
    throughDate: preview.throughDate,
    accounts: preview.accountIds.map(maskAccount),
    coverage: preview.coverage.map((row) => ({ ...row, accountId: maskAccount(row.accountId) })),
    sections: preview.sections,
    reportedSections: preview.reportedSections,
    sectionAlternatives: preview.sectionAlternatives,
    sourceFingerprint: preview.sourceFingerprint,
    sourceFileCount: preview.sourceManifest?.length || 0,
    sideEnrichmentCount: preview.sideEnrichmentCount || 0,
    conflictingExecutions: preview.conflictScope?.executionCount || 0,
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

function publicReplay(preview) {
  return {
    status: preview.status, mode: preview.mode, published: false, previewHash: preview.previewHash,
    accounts: preview.accounts.map((row) => ({
      account: maskAccount(row.accountId), status: row.status, reason: row.reason,
      idempotent: row.idempotent, executionCount: row.executionCount,
      existingRecordCount: row.existingRecordCount, proposedWriteCount: row.proposedWriteCount,
      lifecycleCounts: row.lifecycleCounts, beforeHash: row.beforeHash,
      sourceFingerprint: row.sourceFingerprint, proposedHash: row.proposedHash,
    })),
  };
}

function readOnlyLedgerStore(env) {
  // Use only the same profile as the local API. Explicit credentials prevent
  // an ambient/default SDK credential chain from choosing another principal.
  const { fromIni } = require('@aws-sdk/credential-providers');
  const { AWS } = require('../src/services/aws/clients.cjs');
  const { createLedgerStore } = require('../src/services/predictionMarketPerformanceLedger.cjs');
  const store = createLedgerStore({
    dynamodb: new AWS.DynamoDB.DocumentClient({
      region: 'us-west-1', credentials: fromIni({ profile: 'market-dashboard-local' }),
    }),
    tableName: env.PREDICTION_MARKET_PERFORMANCE_LEDGER_TABLE,
  });
  return { queryAccountPrefix: store.queryAccountPrefix };
}

async function main({ argv = process.argv.slice(2), env = process.env, write = (value) => process.stdout.write(value), dependencies = {} } = {}) {
  const flags = new Set(['--dry-run', '--stored', '--replay-ledger', '--save-preview']);
  const values = new Set(['--from', '--through', '--commit', '--audit']);
  const usage = () => Object.assign(new Error('Use --dry-run [--stored] --from YYYY-MM-DD --through YYYY-MM-DD; add --replay-ledger for a read-only ledger audit, or use --commit <preview-hash> separately.'), {
    code: 'prediction_pnl_usage',
  });
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (seen.has(name) || (!flags.has(name) && !values.has(name))) throw usage();
    seen.add(name);
    if (values.has(name) && (!argv[++index] || argv[index].startsWith('--'))) throw usage();
  }
  const commitHash = argument(argv, '--commit');
  if (commitHash && argv.length !== 2) throw usage();
  if (!commitHash && (!seen.has('--dry-run') || !seen.has('--from') || !seen.has('--through'))) throw usage();
  if ((seen.has('--replay-ledger') || seen.has('--save-preview')) && !seen.has('--stored')) throw usage();
  if (seen.has('--audit') && !seen.has('--replay-ledger')) throw usage();
  if (seen.has('--replay-ledger') && seen.has('--save-preview')) throw usage();
  const flex = dependencies.flex || require('../src/services/ibkrFlexService.cjs');
  if (commitHash) {
    const result = flex.commitPredictionPnlBackfill(commitHash);
    write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  const fromDate = argument(argv, '--from');
  const throughDate = argument(argv, '--through');
  if (seen.has('--replay-ledger')) {
    // Validate configured expected accounts and the requested range using the
    // identical stored-only source preview before touching DynamoDB.
    const source = flex.previewStoredPredictionPnlBackfill({ fromDate, throughDate });
    if (!source.complete) {
      write(`${JSON.stringify(publicPreview(source), null, 2)}\n`);
      return 2;
    }
    const { expectedIbkrAccountIds } = require('../src/utils/ibkrAccountCoverage.cjs');
    const accountIds = expectedIbkrAccountIds(env);
    if (!accountIds.length || accountIds.some((id) => !source.accountIds.includes(id))) throw usage();
    const previewReplay = dependencies.previewReplay || require('../src/services/predictionMarketLedgerReplay.cjs').previewPredictionMarketLedgerReplay;
    const preview = await previewReplay({
      store: (dependencies.createStore || readOnlyLedgerStore)(env), accountIds,
      includeEvidence: seen.has('--audit'),
      readHistory: (options) => flex.readFlexActivityTrades({
        ...options, expectedFromDate: fromDate, expectedToDate: throughDate, allowUnconfigured: true,
      }),
    });
    const auditPath = argument(argv, '--audit');
    if (auditPath) {
      // Explicit private audit output only. Never overwrite an existing audit,
      // and never persist or publish any proposed ledger entry here.
      const fs = require('node:fs');
      const path = require('node:path');
      if (!path.isAbsolute(auditPath)) throw usage();
      fs.writeFileSync(auditPath, `${JSON.stringify(preview, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    }
    write(`${JSON.stringify(publicReplay(preview), null, 2)}\n`);
    return preview.status === 'ready_for_review' ? 0 : 2;
  }
  const preview = seen.has('--stored')
    ? flex.previewStoredPredictionPnlBackfill({ fromDate, throughDate, persist: seen.has('--save-preview') })
    : await flex.previewPredictionPnlBackfill({ fromDate, throughDate });
  write(`${JSON.stringify(publicPreview(preview), null, 2)}\n`);
  return preview.complete ? 0 : 2;
}

if (require.main === module) {
  require('dotenv').config({ quiet: true });
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`${JSON.stringify({
      status: 'failed', code: error.code || 'prediction_pnl_backfill_failed', error: error.message,
    }, null, 2)}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main, publicPreview, publicReplay };
