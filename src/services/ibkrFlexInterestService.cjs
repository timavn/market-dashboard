const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  parseFlexInterestResponse,
  parseFlexInterestStatement,
} = require('../utils/ibkrFlexInterest.cjs');

const DEFAULT_BASE_URL = 'https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService';
const DEFAULT_DATA_DIR = path.join(process.cwd(), 'data', 'ibkr-flex', 'interest');
const DEFAULT_MAX_POLLS = 8;
const DEFAULT_MAX_RESPONSE_BYTES = 25 * 1024 * 1024;
const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_RANGE_DAYS = 365;
const RETRYABLE_FLEX_CODES = new Set([
  '1001',
  '1003',
  '1004',
  '1005',
  '1006',
  '1007',
  '1008',
  '1009',
  '1018',
  '1019',
  '1021',
]);

function createServiceError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function positiveInteger(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min) return fallback;
  return Math.min(parsed, max);
}

function normalizeConfiguredBaseUrl(value) {
  const parsed = new URL(String(value || DEFAULT_BASE_URL));
  if (parsed.protocol !== 'https:') {
    throw createServiceError(
      'IBKR Flex base URL must use HTTPS',
      'flex_interest_invalid_base_url',
    );
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw createServiceError(
      'IBKR Flex base URL cannot include credentials, query parameters, or a fragment',
      'flex_interest_invalid_base_url',
    );
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  return parsed.toString().replace(/\/$/, '');
}

function getConfig({
  env = process.env,
  dataDir,
} = {}) {
  let baseUrl = null;
  let baseUrlError = null;
  try {
    baseUrl = normalizeConfiguredBaseUrl(
      env.IBKR_FLEX_INTEREST_BASE_URL
      || env.IBKR_FLEX_BASE_URL
      || DEFAULT_BASE_URL,
    );
  } catch (error) {
    baseUrlError = error;
  }

  const token = String(env.IBKR_FLEX_INTEREST_TOKEN || env.IBKR_FLEX_TOKEN || '').trim();
  const queryId = String(env.IBKR_FLEX_INTEREST_QUERY_ID || '').trim();
  const expectedAccountId = String(
    env.IBKR_FLEX_INTEREST_EXPECTED_ACCOUNT_ID
    || env.IBKR_FLEX_EXPECTED_ACCOUNT_ID
    || '',
  ).trim();
  const configuredDataDir = dataDir
    || env.IBKR_FLEX_INTEREST_DATA_DIR
    || (env.IBKR_FLEX_DATA_DIR
      ? path.join(env.IBKR_FLEX_DATA_DIR, 'interest')
      : DEFAULT_DATA_DIR);

  return {
    enabled: String(
      env.IBKR_FLEX_INTEREST_ENABLED ?? env.IBKR_FLEX_ENABLED ?? '',
    ).toLowerCase() === 'true',
    configured: Boolean(token && queryId && expectedAccountId && baseUrl && configuredDataDir),
    token,
    queryId,
    expectedAccountId,
    expectedAccountFingerprint: expectedAccountId
      ? sha256(expectedAccountId)
      : null,
    baseUrl,
    baseUrlError,
    dataDir: path.resolve(configuredDataDir),
    maxPolls: positiveInteger(
      env.IBKR_FLEX_INTEREST_MAX_POLLS,
      DEFAULT_MAX_POLLS,
      { min: 1, max: 30 },
    ),
    maxResponseBytes: positiveInteger(
      env.IBKR_FLEX_INTEREST_MAX_RESPONSE_BYTES,
      DEFAULT_MAX_RESPONSE_BYTES,
      { min: 1024, max: 100 * 1024 * 1024 },
    ),
    pollIntervalMs: Math.max(
      DEFAULT_POLL_INTERVAL_MS,
      positiveInteger(
        env.IBKR_FLEX_INTEREST_POLL_INTERVAL_MS,
        DEFAULT_POLL_INTERVAL_MS,
        { min: 1, max: 60000 },
      ),
    ),
    timeoutMs: positiveInteger(
      env.IBKR_FLEX_INTEREST_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS,
      { min: 1000, max: 120000 },
    ),
  };
}

function maskAccountId(accountId) {
  const value = String(accountId || '').trim();
  if (!value) return null;
  if (value.length <= 4) return '*'.repeat(value.length);
  return `${value.slice(0, 1)}${'*'.repeat(value.length - 3)}${value.slice(-2)}`;
}

function redactText(value, secrets = []) {
  let message = String(value || 'IBKR Flex interest request failed');
  message = message
    .replace(/([?&](?:t|q|token)=)[^&\s"'<>]+/gi, '$1[redacted]')
    .replace(/\b[UDF]\d{5,}\b/gi, '[account-redacted]');
  for (const secret of secrets) {
    if (!secret) continue;
    for (const candidate of [String(secret), encodeURIComponent(String(secret))]) {
      message = message.split(candidate).join('[redacted]');
    }
  }
  return message;
}

function redactError(error, config) {
  const redacted = createServiceError(
    redactText(error?.message || error, [
      config?.token,
      config?.queryId,
      config?.expectedAccountId,
    ]),
    error?.code || 'flex_interest_error',
  );
  return redacted;
}

function parseStrictIsoDate(value, fieldName) {
  const text = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw createServiceError(
      `${fieldName} must be an ISO date in YYYY-MM-DD format`,
      'flex_interest_invalid_date_range',
    );
  }
  const [year, month, day] = text.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    throw createServiceError(
      `${fieldName} must be a real calendar date`,
      'flex_interest_invalid_date_range',
    );
  }
  return date;
}

function validateIsoDateRange({ fromDate, toDate } = {}) {
  const from = parseStrictIsoDate(fromDate, 'fromDate');
  const to = parseStrictIsoDate(toDate, 'toDate');
  if (from.getTime() > to.getTime()) {
    throw createServiceError(
      'fromDate cannot be later than toDate',
      'flex_interest_invalid_date_range',
    );
  }
  const inclusiveDays = Math.floor((to.getTime() - from.getTime()) / 86400000) + 1;
  if (inclusiveDays > MAX_RANGE_DAYS) {
    throw createServiceError(
      `IBKR Flex date ranges cannot exceed ${MAX_RANGE_DAYS} days`,
      'flex_interest_invalid_date_range',
    );
  }
  return { fromDate, toDate, inclusiveDays };
}

function compactIsoDate(value) {
  return value.replace(/-/g, '');
}

function buildEndpointUrl(config, endpoint) {
  const base = new URL(`${config.baseUrl}/`);
  return new URL(endpoint, base);
}

function buildSendRequestUrl(config, { fromDate, toDate }) {
  const url = buildEndpointUrl(config, 'SendRequest');
  url.searchParams.set('t', config.token);
  url.searchParams.set('q', config.queryId);
  url.searchParams.set('fd', compactIsoDate(fromDate));
  url.searchParams.set('td', compactIsoDate(toDate));
  url.searchParams.set('v', '3');
  return url;
}

function buildGetStatementUrl(config, referenceCode) {
  const url = buildEndpointUrl(config, 'GetStatement');
  url.searchParams.set('t', config.token);
  url.searchParams.set('q', referenceCode);
  url.searchParams.set('v', '3');
  return url;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function snapshotRevisionHash(snapshot) {
  const { revisionHash, ...hashable } = snapshot;
  return sha256(stableJson(hashable));
}

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw createServiceError(
      'IBKR Flex interest storage path is not a private directory',
      'flex_interest_storage_error',
    );
  }
  fs.chmodSync(directory, 0o700);
}

function syncDirectory(directory) {
  let fd;
  try {
    fd = fs.openSync(directory, fs.constants.O_RDONLY);
    fs.fsyncSync(fd);
  } catch {
    // Some filesystems do not support directory fsync. File fsync and atomic
    // link/rename still protect readers from partial revisions.
  } finally {
    if (fd != null) fs.closeSync(fd);
  }
}

function writePrivateTempFile(directory, basename, content) {
  const tempPath = path.join(
    directory,
    `.${basename}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`,
  );
  const flags = fs.constants.O_WRONLY
    | fs.constants.O_CREAT
    | fs.constants.O_EXCL
    | (fs.constants.O_NOFOLLOW || 0);
  const fd = fs.openSync(tempPath, flags, 0o600);
  try {
    fs.writeFileSync(fd, content, { encoding: 'utf8' });
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(tempPath, 0o600);
  return tempPath;
}

function atomicReplacePrivate(filePath, content) {
  const directory = path.dirname(filePath);
  ensurePrivateDirectory(directory);
  const tempPath = writePrivateTempFile(directory, path.basename(filePath), content);
  try {
    fs.renameSync(tempPath, filePath);
    fs.chmodSync(filePath, 0o600);
    syncDirectory(directory);
  } finally {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }
}

function atomicCreateImmutable(filePath, content) {
  const directory = path.dirname(filePath);
  ensurePrivateDirectory(directory);
  const tempPath = writePrivateTempFile(directory, path.basename(filePath), content);
  try {
    fs.linkSync(tempPath, filePath);
    fs.chmodSync(filePath, 0o400);
    syncDirectory(directory);
    return true;
  } catch (error) {
    if (error?.code === 'EEXIST') return false;
    throw error;
  } finally {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }
}

function readPrivateJson(filePath) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw createServiceError(
      'IBKR Flex interest revision is not a regular file',
      'flex_interest_integrity_error',
    );
  }
  if (stat.size > DEFAULT_MAX_RESPONSE_BYTES) {
    throw createServiceError(
      'IBKR Flex interest revision is unexpectedly large',
      'flex_interest_integrity_error',
    );
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    throw createServiceError(
      'IBKR Flex interest revision is not valid JSON',
      'flex_interest_integrity_error',
    );
  }
}

function validateStoredSnapshot(
  snapshot,
  fileName = null,
  expectedAccountFingerprint = null,
) {
  if (!snapshot || typeof snapshot !== 'object') {
    throw createServiceError(
      'IBKR Flex interest revision is invalid',
      'flex_interest_integrity_error',
    );
  }
  if (!/^[a-f0-9]{64}$/.test(String(snapshot.reportHash || ''))) {
    throw createServiceError(
      'IBKR Flex interest report hash is invalid',
      'flex_interest_integrity_error',
    );
  }
  if (
    expectedAccountFingerprint
    && snapshot.expectedAccountFingerprint !== expectedAccountFingerprint
  ) {
    throw createServiceError(
      'IBKR Flex interest revision account identity did not verify',
      'flex_interest_integrity_error',
    );
  }
  if (!/^[a-f0-9]{64}$/.test(String(snapshot.revisionHash || ''))
    || snapshotRevisionHash(snapshot) !== snapshot.revisionHash) {
    throw createServiceError(
      'IBKR Flex interest revision hash did not verify',
      'flex_interest_integrity_error',
    );
  }
  const expectedRevisionId = `${snapshot.fromDate}_${snapshot.toDate}_${snapshot.reportHash}`;
  if (snapshot.revisionId !== expectedRevisionId) {
    throw createServiceError(
      'IBKR Flex interest revision identity did not verify',
      'flex_interest_integrity_error',
    );
  }
  if (fileName && fileName !== `${expectedRevisionId}.json`) {
    throw createServiceError(
      'IBKR Flex interest revision filename did not verify',
      'flex_interest_integrity_error',
    );
  }
  return snapshot;
}

function revisionPath(config, revisionId) {
  return path.join(config.dataDir, 'revisions', `${revisionId}.json`);
}

function latestPath(config) {
  return path.join(config.dataDir, 'latest.json');
}

function persistSnapshot(config, snapshot) {
  ensurePrivateDirectory(config.dataDir);
  const filePath = revisionPath(config, snapshot.revisionId);
  const content = `${JSON.stringify(snapshot, null, 2)}\n`;
  const created = atomicCreateImmutable(filePath, content);
  const stored = created
    ? snapshot
    : validateStoredSnapshot(
      readPrivateJson(filePath),
      path.basename(filePath),
      config.expectedAccountFingerprint,
    );
  if (stored.reportHash !== snapshot.reportHash
    || stored.fromDate !== snapshot.fromDate
    || stored.toDate !== snapshot.toDate) {
    throw createServiceError(
      'IBKR Flex interest revision conflicted with existing content',
      'flex_interest_integrity_error',
    );
  }
  atomicReplacePrivate(latestPath(config), `${JSON.stringify(stored, null, 2)}\n`);
  return stored;
}

function listStoredSnapshots(config, limit) {
  const directory = path.join(config.dataDir, 'revisions');
  if (!fs.existsSync(directory)) return [];
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw createServiceError(
      'IBKR Flex interest revisions path is invalid',
      'flex_interest_integrity_error',
    );
  }
  const compare = (a, b) => String(b.fetchedAt).localeCompare(String(a.fetchedAt))
    || b.revisionId.localeCompare(a.revisionId);
  const snapshots = [];
  for (const name of fs.readdirSync(directory)) {
    if (!/^\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}_[a-f0-9]{64}\.json$/.test(name)) continue;
    // Every stored revision still verifies against its fresh bytes and exact
    // account. Keep only the requested newest objects while scanning, rather
    // than retaining all parsed accounting reports until the final slice.
    const snapshot = validateStoredSnapshot(
      readPrivateJson(path.join(directory, name)),
      name,
      config.expectedAccountFingerprint,
    );
    let low = 0;
    let high = snapshots.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (compare(snapshot, snapshots[middle]) < 0) high = middle;
      else low = middle + 1;
    }
    if (low < limit) {
      snapshots.splice(low, 0, snapshot);
      if (snapshots.length > limit) snapshots.pop();
    }
  }
  return snapshots;
}

function latestStoredSnapshot(config) {
  const filePath = latestPath(config);
  if (!fs.existsSync(filePath)) {
    return listStoredSnapshots(config, 1)[0] || null;
  }
  const latest = validateStoredSnapshot(
    readPrivateJson(filePath),
    null,
    config.expectedAccountFingerprint,
  );
  const immutablePath = revisionPath(config, latest.revisionId);
  if (!fs.existsSync(immutablePath)) {
    throw createServiceError(
      'IBKR Flex interest latest pointer has no immutable revision',
      'flex_interest_integrity_error',
    );
  }
  const revision = validateStoredSnapshot(
    readPrivateJson(immutablePath),
    path.basename(immutablePath),
    config.expectedAccountFingerprint,
  );
  if (revision.revisionHash !== latest.revisionHash) {
    throw createServiceError(
      'IBKR Flex interest latest pointer did not match its immutable revision',
      'flex_interest_integrity_error',
    );
  }
  return revision;
}

function publicSnapshotSummary(snapshot) {
  if (!snapshot) return null;
  const sectionPresence = {
    tierInterestDetails: snapshot.tierDetailSectionPresent === true
      || (snapshot.tierDetails?.length || 0) > 0,
    interestAccruals: snapshot.accrualSectionPresent === true
      || (snapshot.accruals?.length || 0) > 0,
    cashTransactions: snapshot.cashTransactionSectionPresent === true
      || (snapshot.cashTransactions?.length || 0) > 0,
    cashReport: snapshot.cashReportSectionPresent === true
      || (snapshot.cashReports?.length || 0) > 0,
    stockBorrowFeeDetails: snapshot.borrowFeeDetailsSectionPresent === true
      || (snapshot.borrowFeeDetails?.length || 0) > 0,
  };
  return {
    fromDate: snapshot.fromDate,
    toDate: snapshot.toDate,
    fetchedAt: snapshot.fetchedAt,
    expectedAccountMasked: snapshot.expectedAccountMasked,
    reportHash: snapshot.reportHash,
    revisionHash: snapshot.revisionHash,
    revisionId: snapshot.revisionId,
    rowCounts: {
      tierDetails: snapshot.tierDetails?.length || 0,
      accruals: snapshot.accruals?.length || 0,
      cashTransactions: snapshot.cashTransactions?.length || 0,
      cashReports: snapshot.cashReports?.length || 0,
      borrowFeeDetails: snapshot.borrowFeeDetails?.length || 0,
    },
    sectionPresence,
  };
}

function nowIso(now) {
  const value = typeof now === 'function' ? now() : now;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw createServiceError(
      'IBKR Flex interest clock returned an invalid value',
      'flex_interest_invalid_clock',
    );
  }
  return date.toISOString();
}

function createIbkrFlexInterestService({
  env = process.env,
  fetchImpl = global.fetch,
  now = () => new Date(),
  dataDir,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  const config = getConfig({ env, dataDir });
  let syncInProgress = false;

  function requireConfigured() {
    if (!config.enabled) {
      throw createServiceError('IBKR Flex interest sync is disabled', 'flex_interest_disabled');
    }
    if (config.baseUrlError) throw config.baseUrlError;
    if (!config.configured) {
      throw createServiceError(
        'IBKR Flex interest token, query ID, or expected account is missing',
        'flex_interest_missing_config',
      );
    }
    if (typeof fetchImpl !== 'function') {
      throw createServiceError(
        'IBKR Flex interest fetch implementation is unavailable',
        'flex_interest_fetch_unavailable',
      );
    }
    if (typeof sleep !== 'function') {
      throw createServiceError(
        'IBKR Flex interest sleep implementation is unavailable',
        'flex_interest_sleep_unavailable',
      );
    }
  }

  async function requestText(url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const response = await fetchImpl(url.toString(), {
        headers: {
          Accept: 'application/xml,text/xml,*/*',
          'User-Agent': `Node.js/${process.versions.node} market-dashboard`,
        },
        signal: controller.signal,
      });
      if (typeof response === 'string') {
        if (Buffer.byteLength(response, 'utf8') > config.maxResponseBytes) {
          throw createServiceError(
            'IBKR Flex interest response exceeded the size limit',
            'flex_interest_response_too_large',
          );
        }
        return response;
      }
      if (!response || typeof response.text !== 'function') {
        throw createServiceError(
          'IBKR Flex interest fetch returned an invalid response',
          'flex_interest_invalid_response',
        );
      }
      const contentLength = Number(response.headers?.get?.('content-length'));
      if (Number.isFinite(contentLength) && contentLength > config.maxResponseBytes) {
        throw createServiceError(
          'IBKR Flex interest response exceeded the size limit',
          'flex_interest_response_too_large',
        );
      }
      const text = await response.text();
      if (Buffer.byteLength(text, 'utf8') > config.maxResponseBytes) {
        throw createServiceError(
          'IBKR Flex interest response exceeded the size limit',
          'flex_interest_response_too_large',
        );
      }
      if (response.ok === false) {
        throw createServiceError(
          `IBKR Flex interest HTTP ${response.status}`,
          'flex_interest_http_error',
        );
      }
      return text;
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw createServiceError(
          'IBKR Flex interest request timed out',
          'flex_interest_timeout',
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function fetchStatementXml(range) {
    const sendXml = await requestText(buildSendRequestUrl(config, range));
    const sendResponse = parseFlexInterestResponse(sendXml);
    if (
      String(sendResponse.status || '').toLowerCase() !== 'success'
      || !sendResponse.referenceCode
    ) {
      throw createServiceError(
        sendResponse.errorMessage || 'IBKR Flex interest SendRequest failed',
        sendResponse.errorCode || 'flex_interest_send_failed',
      );
    }

    let lastResponse = null;
    for (let attempt = 0; attempt < config.maxPolls; attempt += 1) {
      await sleep(config.pollIntervalMs);
      // The service intentionally ignores sendResponse.responseUrl. Only the
      // configured Flex base URL is allowed to receive the token/reference.
      const xml = await requestText(
        buildGetStatementUrl(config, sendResponse.referenceCode),
      );
      const response = parseFlexInterestResponse(xml);
      if (response.isStatement) return xml;
      lastResponse = response;

      const code = String(response.errorCode || '');
      const retryable = String(response.status || '').toLowerCase() === 'fail'
        && RETRYABLE_FLEX_CODES.has(code);
      if (!retryable) {
        throw createServiceError(
          response.errorMessage || 'IBKR Flex interest GetStatement failed',
          response.errorCode || 'flex_interest_get_failed',
        );
      }
    }

    throw createServiceError(
      lastResponse?.errorMessage || 'IBKR Flex interest statement was not ready',
      'flex_interest_statement_not_ready',
    );
  }

  async function sync({ fromDate, toDate } = {}) {
    try {
      requireConfigured();
      const range = validateIsoDateRange({ fromDate, toDate });
      if (syncInProgress) {
        throw createServiceError(
          'An IBKR Flex interest sync is already in progress',
          'flex_interest_sync_in_progress',
        );
      }
      syncInProgress = true;
      try {
        const statementXml = await fetchStatementXml(range);
        const parsed = parseFlexInterestStatement(statementXml, {
          expectedAccountId: config.expectedAccountId,
        });
        if (parsed.fromDate !== range.fromDate || parsed.toDate !== range.toDate) {
          throw createServiceError(
            'IBKR Flex interest statement range did not match the requested range',
            'flex_interest_report_range_mismatch',
          );
        }

        const reportHash = sha256(statementXml);
        const revisionId = `${range.fromDate}_${range.toDate}_${reportHash}`;
        const snapshotWithoutRevisionHash = {
          schemaVersion: 1,
          source: 'ibkr_flex_interest_web_service',
          revisionId,
          reportHash,
          fetchedAt: nowIso(now),
          fromDate: range.fromDate,
          toDate: range.toDate,
          expectedAccountMasked: maskAccountId(config.expectedAccountId),
          expectedAccountFingerprint: config.expectedAccountFingerprint,
          tierDetails: parsed.tierDetails,
          tierDetailSectionPresent: parsed.tierDetailSectionPresent,
          accruals: parsed.accruals,
          accrualSectionPresent: parsed.accrualSectionPresent,
          cashTransactions: parsed.cashTransactions,
          cashTransactionSectionPresent: parsed.cashTransactionSectionPresent,
          cashReports: parsed.cashReports,
          cashReportSectionPresent: parsed.cashReportSectionPresent,
          borrowFeeDetails: parsed.borrowFeeDetails,
          borrowFeeDetailsSectionPresent: parsed.borrowFeeDetailsSectionPresent,
          derived: parsed.derived,
        };
        const snapshot = {
          ...snapshotWithoutRevisionHash,
          revisionHash: snapshotRevisionHash(snapshotWithoutRevisionHash),
        };
        return persistSnapshot(config, snapshot);
      } finally {
        syncInProgress = false;
      }
    } catch (error) {
      throw redactError(error, config);
    }
  }

  function status({ includeStored = true } = {}) {
    const base = {
      enabled: config.enabled,
      configured: config.configured,
      status: !config.enabled
        ? 'disabled'
        : config.configured
          ? 'configured'
          : 'missing_config',
      tokenConfigured: Boolean(config.token),
      queryConfigured: Boolean(config.queryId),
      expectedAccountConfigured: Boolean(config.expectedAccountId),
      expectedAccountMasked: maskAccountId(config.expectedAccountId),
      syncInProgress,
      latest: null,
    };
    if (!includeStored || !config.enabled || !config.configured) return base;

    try {
      const latest = latestStoredSnapshot(config);
      return {
        ...base,
        status: latest ? 'ready' : 'configured',
        latest: publicSnapshotSummary(latest),
      };
    } catch (error) {
      return {
        ...base,
        status: 'storage_error',
        errorCode: error?.code || 'flex_interest_storage_error',
      };
    }
  }

  function history({ limit = 50 } = {}) {
    try {
      if (!config.enabled || !config.configured) return [];
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
        throw createServiceError(
          'IBKR Flex interest history limit must be an integer from 1 to 1000',
          'flex_interest_invalid_history_limit',
        );
      }
      return listStoredSnapshots(config, limit);
    } catch (error) {
      throw redactError(error, config);
    }
  }

  return Object.freeze({
    history,
    status,
    sync,
  });
}

function publicConfigStatus(options = {}) {
  return createIbkrFlexInterestService(options).status();
}

module.exports = {
  DEFAULT_BASE_URL,
  MAX_RANGE_DAYS,
  buildGetStatementUrl,
  buildSendRequestUrl,
  createIbkrFlexInterestService,
  getConfig,
  maskAccountId,
  publicConfigStatus,
  redactError,
  validateIsoDateRange,
};
