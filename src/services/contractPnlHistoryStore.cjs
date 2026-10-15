const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCHEMA_VERSION = 1;
const DEFAULT_DATA_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'market-dashboard', 'contract-pnl-history-v1');

function ledgerSourceScope({ tableName = 'PredictionMarketPerformanceLedger', env = process.env } = {}) {
  const rawEndpoint = env.AWS_ENDPOINT_URL_DYNAMODB || env.AWS_ENDPOINT_URL || '';
  let endpoint = '';
  if (rawEndpoint) {
    try { const url = new URL(rawEndpoint); endpoint = `${url.origin}${url.pathname}`; }
    catch { endpoint = 'invalid-configured-endpoint'; }
  }
  // Connection identity, never credentials. A projection from another configured
  // ledger must not survive a same-table-name profile/region/endpoint switch.
  return JSON.stringify({
    tableName, region: env.AWS_REGION || 'us-west-1', endpoint,
    profile: env.AWS_PROFILE || env.AWS_DEFAULT_PROFILE || 'default',
    credentialIdentity: env.AWS_ACCESS_KEY_ID ? digest({ keyId: env.AWS_ACCESS_KEY_ID }) : '',
    account: env.AWS_ACCOUNT_ID || '', role: env.AWS_ROLE_ARN || '',
    configFile: env.AWS_CONFIG_FILE || '', credentialsFile: env.AWS_SHARED_CREDENTIALS_FILE || '',
  });
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().filter((key) => value[key] !== undefined)
    .map((key) => [key, canonical(value[key])]));
}

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function verifiedHistoricalRow(row = {}) {
  return row.status === 'verified'
    && ['CLOSED', 'SETTLED'].includes(row.displayState)
    && ['verified_settlement', 'ibkr_flex_settlement', 'ibkr_live_execution'].includes(row.verification)
    && row.performanceComplete !== false && !row.reviewReason
    && Number.isFinite(row.risked) && Number.isFinite(row.paid)
    && row.isMock !== true && row.isSeeded !== true;
}

function atomicPrivateJson(filePath, value) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const temporary = path.join(directory, `.${path.basename(filePath)}.${crypto.randomUUID()}.tmp`);
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, JSON.stringify(value), 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, filePath);
  const parent = fs.openSync(directory, 'r');
  try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
}

// This is a derived, non-executable accounting record, not a quote cache.
// There is deliberately no age TTL and no browser persistence. A new ledger
// publication replaces a whole account generation, including revoked rows.
function createContractPnlHistoryStore({ dataDir = DEFAULT_DATA_DIR, sourceScope = 'PredictionMarketPerformanceLedger' } = {}) {
  const memory = new Map();
  const attempted = new Set();
  const fileFor = (accountId) => path.join(dataDir, `${digest({ accountId, sourceScope })}.json`);

  function valid(record, accountId) {
    if (record?.schemaVersion !== SCHEMA_VERSION || record.accountId !== accountId
      || record.sourceScope !== sourceScope || !record.payload
      || record.payload.selectedAccount !== accountId || !Array.isArray(record.payload.rows)
      || !record.payload.rows.every(verifiedHistoricalRow)
      || record.payload.activeRows?.length || record.payload.availability?.current?.status !== 'unavailable') return false;
    const { recordHash, ...hashable } = record;
    return recordHash === digest(hashable);
  }

  function get(accountId) {
    if (!accountId) return null;
    if (!attempted.has(accountId)) {
      attempted.add(accountId);
      if (dataDir) {
        try {
          const record = JSON.parse(fs.readFileSync(fileFor(accountId), 'utf8'));
          if (valid(record, accountId)) memory.set(accountId, record);
        } catch (error) {
          if (error.code !== 'ENOENT') memory.delete(accountId);
        }
      }
    }
    return memory.get(accountId) || null;
  }

  function publish(accountId, { fingerprint, payload, executionDetails = {} }) {
    const previous = get(accountId);
    if (previous?.fingerprint === fingerprint) return previous;
    const projectionRevision = digest({ accountId, sourceScope, fingerprint, payload, executionDetails });
    const record = {
      schemaVersion: SCHEMA_VERSION, accountId, sourceScope, fingerprint,
      projectionRevision,
      payload: { ...payload, schemaVersion: SCHEMA_VERSION, projectionRevision },
      executionDetails,
    };
    const next = { ...record, recordHash: digest(record) };
    if (!valid(next, accountId)) throw new Error('Historical P&L publication is not verified accounting evidence.');
    if (dataDir) atomicPrivateJson(fileFor(accountId), next);
    memory.set(accountId, next);
    attempted.add(accountId);
    return next;
  }

  function details(accountId, id, revision = null) {
    const record = get(accountId);
    if (!record || (revision && record.projectionRevision !== revision)) return null;
    return record.executionDetails[id] || null;
  }

  return { get, publish, details };
}

module.exports = { createContractPnlHistoryStore, verifiedHistoricalRow, ledgerSourceScope, digest };
