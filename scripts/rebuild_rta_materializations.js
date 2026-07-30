#!/usr/bin/env node

require('dotenv').config({ quiet: true });
if (process.env.MARKET_DASHBOARD_AWS_PROFILE_LOCKED === 'true') {
  for (const key of [
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'AWS_SECURITY_TOKEN',
    'AWS_ROLE_ARN',
    'AWS_ROLE_SESSION_NAME',
    'AWS_WEB_IDENTITY_TOKEN_FILE',
    'AWS_CONTAINER_CREDENTIALS_FULL_URI',
    'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
    'AWS_CONTAINER_AUTHORIZATION_TOKEN',
    'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
    'AWS_SHARED_CREDENTIALS_FILE',
    'AWS_CONFIG_FILE',
  ]) {
    delete process.env[key];
  }
}
const fs = require('fs');
const path = require('path');
const AWS = require('aws-sdk/global');
const S3 = require('aws-sdk/clients/s3');
const DynamoDB = require('aws-sdk/clients/dynamodb');
const STS = require('aws-sdk/clients/sts');
const SERVICE_MANIFEST = require('../ops/services.json');
const { scanAllPages } = require('../src/utils/dynamoScanAllPages.cjs');
const { materializeRtaLedgerItems } = require('../src/utils/rtaLedgerMaterialization.cjs');
const {
  materializeRtaResearchEvents,
  mergeRtaMaterializations,
} = require('../src/utils/researchEventLedger.cjs');
const { summarizeRealTimeAlertPositions } = require('../src/utils/rtaPositionReconstruction.cjs');
const { validateRtaCheckpoint } = require('../src/utils/rtaCheckpoint.cjs');

const AWS_RESOURCE_DEFAULTS = SERVICE_MANIFEST.aws?.resources || {};
const DEFAULT_LEDGER_TABLE = process.env.HERMES_LEDGER_TABLE
  || AWS_RESOURCE_DEFAULTS.gmailLedgerTable
  || 'HermesEmailIngestLedger';
const DEFAULT_EVENT_LEDGER_TABLE = process.env.RESEARCH_EVENT_LEDGER_TABLE
  || AWS_RESOURCE_DEFAULTS.researchEventLedgerTable
  || 'ResearchEventLedgerV2';
const DEFAULT_SNAPSHOT_TABLE = process.env.HEDGEYE_SNAPSHOT_TABLE
  || AWS_RESOURCE_DEFAULTS.hedgeyeDailySnapshotTable
  || 'HedgeyeDailySnapshot';
const DEFAULT_BUCKET = process.env.HEDGEYE_BUCKET
  || AWS_RESOURCE_DEFAULTS.rawArtifactBucket
  || 'market-dashboard-csv-data';
const EXPECTED_ACCOUNT_ID = '915328198276';
const EXPECTED_REGION = 'us-west-1';
const EXPECTED_PROFILE = 'market-dashboard-local';
const EXPECTED_PRINCIPAL_ARN = `arn:aws:iam::${EXPECTED_ACCOUNT_ID}:user/${EXPECTED_PROFILE}`;
const EXPECTED_RESOURCES = Object.freeze({
  HERMES_LEDGER_TABLE: 'HermesEmailIngestLedger',
  RESEARCH_EVENT_LEDGER_TABLE: 'ResearchEventLedgerV2',
  HEDGEYE_SNAPSHOT_TABLE: 'HedgeyeDailySnapshot',
  HEDGEYE_BUCKET: 'market-dashboard-csv-data',
});
const RESOLVED_RESOURCES = Object.freeze({
  HERMES_LEDGER_TABLE: DEFAULT_LEDGER_TABLE,
  RESEARCH_EVENT_LEDGER_TABLE: DEFAULT_EVENT_LEDGER_TABLE,
  HEDGEYE_SNAPSHOT_TABLE: DEFAULT_SNAPSHOT_TABLE,
  HEDGEYE_BUCKET: DEFAULT_BUCKET,
});

function assertRuntimeConfiguration(environment = process.env) {
  const region = environment.AWS_REGION || environment.AWS_DEFAULT_REGION || EXPECTED_REGION;
  if (region !== EXPECTED_REGION) {
    throw new Error(`Refusing AWS region ${region}; expected ${EXPECTED_REGION}.`);
  }
  const profile = environment.AWS_PROFILE || environment.AWS_DEFAULT_PROFILE;
  if (profile !== EXPECTED_PROFILE) {
    throw new Error(`RTA rebuild requires AWS_PROFILE=${EXPECTED_PROFILE}.`);
  }
  for (const [name, expected] of Object.entries(EXPECTED_RESOURCES)) {
    const actual = environment[name] || RESOLVED_RESOURCES[name];
    if (actual !== expected) {
      throw new Error(`Refusing ${name}=${actual}; expected ${expected}.`);
    }
  }
}

function validateCallerIdentity(identity) {
  if (String(identity?.Account || '') !== EXPECTED_ACCOUNT_ID) {
    throw new Error(
      `Refusing AWS account ${identity?.Account || 'unknown'}; expected ${EXPECTED_ACCOUNT_ID}.`,
    );
  }
  if (String(identity?.Arn || '') !== EXPECTED_PRINCIPAL_ARN) {
    throw new Error(
      `RTA rebuild requires the least-privilege ${EXPECTED_PROFILE} IAM principal.`,
    );
  }
  return identity;
}

function parseArgs(argv) {
  const options = {
    apply: false,
    json: false,
    windowDays: 90,
  };
  for (const arg of argv) {
    if (arg === '--apply') options.apply = true;
    else if (arg === '--json') options.json = true;
    else if (arg.startsWith('--window-days=')) options.windowDays = Number(arg.split('=')[1]);
    else if (arg.startsWith('--since=')) options.since = arg.split('=')[1];
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isFinite(options.windowDays) || options.windowDays < 1 || options.windowDays > 730) {
    throw new Error('--window-days must be between 1 and 730.');
  }
  if (options.since && !/^\d{4}-\d{2}-\d{2}$/.test(options.since)) {
    throw new Error('--since must use YYYY-MM-DD.');
  }
  return options;
}

function usage() {
  return [
    'Rebuild deterministic RTA projections from ResearchEventLedgerV2 plus immutable Gmail/S3 migration gaps.',
    '',
    'Usage:',
    '  node scripts/rebuild_rta_materializations.js [--window-days=90] [--since=YYYY-MM-DD] [--json]',
    '  node scripts/rebuild_rta_materializations.js --apply [--window-days=90]',
    '',
    'The default is read-only dry-run. --apply writes only changed date projections.',
  ].join('\n');
}

function cutoffFor(options, now = new Date()) {
  if (options.since) return new Date(`${options.since}T00:00:00Z`);
  const cutoff = new Date(now);
  cutoff.setUTCDate(cutoff.getUTCDate() - options.windowDays);
  return cutoff;
}

function compareProjections(existingItems, desiredSnapshots) {
  const existingByDate = new Map((existingItems || []).map((item) => [item.date, item]));
  return desiredSnapshots.map((desired) => {
    const existing = existingByDate.get(desired.date);
    const status = !existing
      ? 'create'
      : existing.dataVersion === desired.dataVersion
        ? 'unchanged'
        : 'update';
    return {
      date: desired.date,
      status,
      existingVersion: existing?.dataVersion || null,
      desiredVersion: desired.dataVersion,
      existingEventCount: Number(existing?.itemCount || existing?.data?.alerts?.length || 0),
      desiredEventCount: desired.itemCount,
      desired,
      existing,
    };
  });
}

async function queryResearchEvents(dynamodb, productKey) {
  const items = [];
  let exclusiveStartKey;
  try {
    do {
      const result = await dynamodb.query({
        TableName: DEFAULT_EVENT_LEDGER_TABLE,
        KeyConditionExpression: '#productKey = :productKey',
        ExpressionAttributeNames: { '#productKey': 'productKey' },
        ExpressionAttributeValues: { ':productKey': productKey },
        ScanIndexForward: true,
        ConsistentRead: true,
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }).promise();
      items.push(...(result.Items || []));
      exclusiveStartKey = result.LastEvaluatedKey;
    } while (exclusiveStartKey);
    return { items, error: null };
  } catch (error) {
    return { items: [], error: error.code || error.message || 'research-event-ledger-unavailable' };
  }
}

async function run(options, dependencies = {}) {
  assertRuntimeConfiguration(process.env);
  AWS.config.update({ region: EXPECTED_REGION });
  const dynamodb = dependencies.dynamodb || new DynamoDB.DocumentClient();
  const s3 = dependencies.s3 || new S3();
  const sts = dependencies.sts || new STS();
  validateCallerIdentity(await sts.getCallerIdentity({}).promise());
  const cutoff = cutoffFor(options);
  const [ledgerItems, existingItems, eventLedgerResult] = await Promise.all([
    scanAllPages(dynamodb, { TableName: DEFAULT_LEDGER_TABLE }),
    scanAllPages(dynamodb, {
      TableName: DEFAULT_SNAPSHOT_TABLE,
      FilterExpression: 'snapshotType = :type',
      ExpressionAttributeValues: { ':type': 'real-time-alert' },
    }),
    queryResearchEvents(dynamodb, 'real-time-alert'),
  ]);
  const legacy = await materializeRtaLedgerItems(ledgerItems, {
    cutoff,
    getArtifactText: async (item) => {
      const object = await s3.getObject({
        Bucket: item.s3Bucket || DEFAULT_BUCKET,
        Key: item.s3Key,
        ...(item.s3VersionId ? { VersionId: item.s3VersionId } : {}),
      }).promise();
      return object.Body?.toString('utf8') || '';
    },
  });
  const v2 = materializeRtaResearchEvents(eventLedgerResult.items.filter((item) => {
    const eventTime = new Date(item?.eventTime || '').getTime();
    return !Number.isFinite(eventTime) || eventTime >= cutoff.getTime();
  }));
  const materialized = mergeRtaMaterializations(v2, legacy);
  const comparisons = compareProjections(existingItems, materialized.snapshots);
  const changed = comparisons.filter((row) => row.status !== 'unchanged');
  const baselinePath = path.join(__dirname, '..', 'data', 'hedgeye', 'rta', 'latest-benchmark.json');
  const baseline = Object.hasOwn(dependencies, 'baseline')
    ? dependencies.baseline
    : (
      fs.existsSync(baselinePath)
        ? JSON.parse(fs.readFileSync(baselinePath, 'utf8'))
        : null
    );
  const checkpointValidation = validateRtaCheckpoint(baseline);
  const currentBoard = summarizeRealTimeAlertPositions(materialized.snapshots, {
    windowDays: options.windowDays,
    baseline,
  });

  if (options.apply && eventLedgerResult.error) {
    throw new Error(
      `Refusing to apply: canonical RTA event ledger is unavailable (${eventLedgerResult.error}).`,
    );
  }
  if (options.apply && materialized.v2EventCount <= 0) {
    throw new Error('Refusing to apply: no canonical RTA events were found in ResearchEventLedgerV2.');
  }
  if (options.apply && materialized.canonicalCoverageGaps.length > 0) {
    throw new Error(
      `Refusing to apply: ${materialized.canonicalCoverageGaps.length} canonical RTA source message(s) have incomplete event coverage.`,
    );
  }
  if (options.apply && materialized.rejected.length > 0) {
    throw new Error(`Refusing to apply: ${materialized.rejected.length} canonical RTA message(s) could not be materialized.`);
  }
  if (options.apply && !checkpointValidation.valid) {
    throw new Error(`Refusing to apply: RTA checkpoint is invalid (${checkpointValidation.reasons.join(', ')}).`);
  }
  if (
    options.apply
    && (
      currentBoard.available !== true
      || currentBoard.dataQuality?.status !== 'ok'
      || !Number.isInteger(currentBoard.longCount)
      || currentBoard.longCount < 0
      || !Number.isInteger(currentBoard.shortCount)
      || currentBoard.shortCount < 0
      || !Array.isArray(currentBoard.holdings)
      || currentBoard.holdings.length !== currentBoard.longCount + currentBoard.shortCount
    )
  ) {
    const invalidCodes = (currentBoard.dataQuality?.invalidEvents || [])
      .map((item) => item?.code)
      .filter(Boolean);
    throw new Error(
      `Refusing to apply: reconstructed RTA board failed structural validation${
        invalidCodes.length > 0 ? ` (${[...new Set(invalidCodes)].join(', ')})` : ''
      }.`,
    );
  }
  if (options.apply) {
    for (const row of changed) {
      const ttl = row.existing?.ttl || Math.floor(Date.now() / 1000) + (730 * 24 * 60 * 60);
      await dynamodb.put({
        TableName: DEFAULT_SNAPSHOT_TABLE,
        Item: {
          ...(row.existing || {}),
          ...row.desired,
          materializedAt: new Date().toISOString(),
          ttl,
        },
      }).promise();
    }
  }

  return {
    mode: options.apply ? 'apply' : 'dry-run',
    canonicalSource: materialized.v2EventCount > 0
      ? 'ResearchEventLedgerV2 + immutable Gmail/S3 migration gaps'
      : 'immutable Gmail/S3 legacy migration fallback',
    eventLedgerError: eventLedgerResult.error,
    v2EventCount: materialized.v2EventCount,
    legacyMigrationEventCount: materialized.legacyEventCount,
    canonicalCoverageGaps: materialized.canonicalCoverageGaps,
    selectedMessageCount: materialized.selectedMessageCount,
    materializedEventCount: materialized.materializedEventCount,
    rejected: materialized.rejected,
    currentBoard: {
      available: (
        !eventLedgerResult.error
        && materialized.v2EventCount > 0
        && checkpointValidation.valid
        && materialized.canonicalCoverageGaps.length === 0
        && materialized.rejected.length === 0
        && currentBoard.available
      ),
      lastUpdated: currentBoard.lastUpdated,
      longCount: checkpointValidation.valid && materialized.rejected.length === 0 ? currentBoard.longCount : null,
      shortCount: checkpointValidation.valid && materialized.rejected.length === 0 ? currentBoard.shortCount : null,
      holdings: checkpointValidation.valid && materialized.rejected.length === 0 ? currentBoard.holdings : [],
      dataQuality: checkpointValidation.valid && materialized.rejected.length === 0
        ? currentBoard.dataQuality
        : {
          status: 'error',
          rejectedMessages: materialized.rejected,
          checkpointReasons: checkpointValidation.reasons,
        },
      checkpointValidation,
    },
    summary: {
      dates: comparisons.length,
      create: comparisons.filter((row) => row.status === 'create').length,
      update: comparisons.filter((row) => row.status === 'update').length,
      unchanged: comparisons.filter((row) => row.status === 'unchanged').length,
      written: options.apply ? changed.length : 0,
    },
    dates: comparisons.map(({ desired, existing, ...row }) => row),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const report = await run(options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  process.stdout.write(`RTA materialization ${report.mode}: ${report.summary.create} create, ${report.summary.update} update, ${report.summary.unchanged} unchanged.\n`);
  process.stdout.write(`Canonical events: ${report.materializedEventCount}; rejected messages: ${report.rejected.length}; writes: ${report.summary.written}.\n`);
  process.stdout.write(
    `Current board: ${report.currentBoard.available ? 'available' : 'unavailable'}; ` +
    `${report.currentBoard.longCount ?? '?'} long / ${report.currentBoard.shortCount ?? '?'} short.\n`,
  );
  report.dates.filter((row) => row.status !== 'unchanged').forEach((row) => {
    process.stdout.write(`  ${row.date}: ${row.status} (${row.existingEventCount} -> ${row.desiredEventCount} events)\n`);
  });
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`RTA rebuild failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  compareProjections,
  assertRuntimeConfiguration,
  cutoffFor,
  parseArgs,
  queryResearchEvents,
  run,
  validateCallerIdentity,
};
