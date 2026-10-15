const fs = require('fs');
const path = require('path');
const crypto = require('node:crypto');
const { parseFlexResponse, parseFlexStatementDocument } = require('../utils/ibkrFlexExposure.cjs');

const DEFAULT_BASE_URL = 'https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService';
const DEFAULT_DATA_DIR = path.join(process.cwd(), 'data', 'ibkr-flex');

function isEnabled() {
  return process.env.IBKR_FLEX_ACTIVITY_ENABLED === 'true'
    || process.env.IBKR_FLEX_ENABLED === 'true';
}

function getConfig() {
  const token = process.env.IBKR_FLEX_TOKEN || '';
  const queryId = process.env.IBKR_FLEX_ACTIVITY_QUERY_ID || '';
  const expectedAccountIds = String(process.env.IBKR_FLEX_ACTIVITY_EXPECTED_ACCOUNTS || '')
    .split(',').map((value) => value.trim()).filter(Boolean);
  return {
    enabled: isEnabled(),
    configured: Boolean(token && queryId),
    token,
    queryId,
    expectedAccountIds,
    useQueryPeriod: process.env.IBKR_FLEX_ACTIVITY_USE_QUERY_PERIOD === 'true',
    baseUrl: (process.env.IBKR_FLEX_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, ''),
    dataDir: process.env.IBKR_FLEX_DATA_DIR || DEFAULT_DATA_DIR,
    targetCashBufferPct: Number(process.env.IBKR_FLEX_TARGET_CASH_BUFFER_PCT || 0),
  };
}

function todayLocal() {
  return new Date().toLocaleDateString('en-CA');
}

function compactDate(date = todayLocal()) {
  return String(date).replace(/-/g, '');
}

function exactDate(value) {
  const raw = String(value || '').trim();
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(raw)) return null;
  const parsed = Date.parse(`${raw}T12:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === raw ? raw : null;
}

function flexStatementDate(value) {
  const raw = String(value || '').trim();
  if (/^20\d{6}$/.test(raw)) return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  return exactDate(raw);
}

function previousLocalDay() {
  const value = new Date();
  value.setDate(value.getDate() - 1);
  return value.toLocaleDateString('en-CA');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function atomicWriteJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filePath);
  try { fs.chmodSync(filePath, 0o600); } catch (_) { /* best effort on non-POSIX filesystems */ }
}

function readJsonIfExists(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function snapshotPath(config, date) {
  return path.join(config.dataDir, 'snapshots', `${date}.json`);
}

function reportPath(config, date, reportHash) {
  return path.join(config.dataDir, 'reports', `${date}-${reportHash}.json`);
}

function maskAccountId(accountId) {
  const raw = String(accountId || '').trim();
  if (!raw) return null;
  if (raw.length <= 4) return '*'.repeat(raw.length);
  return `${raw.slice(0, 1)}${'*'.repeat(Math.max(3, raw.length - 3))}${raw.slice(-2)}`;
}

function latestSnapshot(config) {
  const dir = path.join(config.dataDir, 'snapshots');
  try {
    const files = fs.readdirSync(dir)
      .filter((name) => /^\d{4}-\d{2}-\d{2}(?:_\d{4}-\d{2}-\d{2})?\.json$/.test(name))
      .sort();
    if (files.length === 0) return null;
    return files.map((name) => readJsonIfExists(path.join(dir, name)))
      .filter(Boolean)
      .sort((left, right) => String(left.toDate || left.date || '').localeCompare(String(right.toDate || right.date || '')))
      .at(-1) || null;
  } catch {
    return null;
  }
}

function publicConfigStatus(config = getConfig()) {
  const latest = latestSnapshot(config);
  const state = readJsonIfExists(activityStatePath(config));
  const accountIds = latest?.accountIds || (latest?.accountId ? [latest.accountId] : []);
  const latestSectionStatus = latest ? activitySectionStatus([latest]) : null;
  return {
    enabled: config.enabled,
    configured: config.configured,
    status: !config.enabled
      ? 'disabled'
      : config.configured
        ? latest
          ? 'ready'
          : 'configured'
        : 'missing_config',
    queryConfigured: Boolean(config.queryId),
    tokenConfigured: Boolean(config.token),
    automaticSyncApproved: state?.authoritativeEnabled === true,
    accountsCovered: accountIds.map(maskAccountId),
    dateCoverage: state?.coverage || (latest ? {
      fromDate: latest.fromDate || latest.date,
      toDate: latest.toDate || latest.date,
      contiguous: latest.coverageComplete === true,
    } : null),
    requiredSectionCoverage: latestSectionStatus?.satisfied || null,
    reportedSectionCoverage: latestSectionStatus?.reported || null,
    sectionAlternatives: latestSectionStatus?.alternatives || {},
    eventCounts: latest ? {
      executions: Number(latest.tradeCount || 0),
      closedLots: Number(latest.closedLotCount || 0),
      optionEvents: Number(latest.optionEventCount || 0),
      cashTransactions: Number(latest.cashTransactionCount || 0),
      statementOfFunds: Number(latest.statementOfFundsCount || 0),
    } : null,
    lastSync: state?.lastSuccessfulSyncAt || latest?.fetchedAt || null,
    reconciliationDifferences: state?.reconciliationDifferences || null,
    latestSnapshot: latest
      ? {
          date: latest.date,
          fetchedAt: latest.fetchedAt,
          accounts: accountIds.map(maskAccountId),
          source: latest.source,
          exposure: latest.exposure,
          fromDate: latest.fromDate || latest.date,
          toDate: latest.toDate || latest.date,
          tradeCount: Number(latest.tradeCount || 0),
          reportHash: latest.reportHash || null,
        }
      : null,
  };
}

function requireSyncConfig(config) {
  if (!config.enabled) {
    const error = new Error('IBKR Flex is disabled');
    error.code = 'flex_disabled';
    throw error;
  }
  if (!config.configured) {
    const error = new Error('IBKR Flex token or activity query ID is missing');
    error.code = 'flex_missing_config';
    throw error;
  }
}

async function requestText(url, { timeoutMs = 30000 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'application/xml,text/xml,*/*',
        'User-Agent': 'Node.js/market-dashboard',
      },
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`IBKR Flex HTTP ${res.status}: ${text.slice(0, 180)}`);
    }
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

function buildSendRequestUrl(config, fromDate, toDate = fromDate) {
  const url = new URL(`${config.baseUrl}/SendRequest`);
  url.searchParams.set('t', config.token);
  url.searchParams.set('q', config.queryId);
  url.searchParams.set('v', '3');
  if (fromDate || toDate) {
    url.searchParams.set('fd', compactDate(fromDate || toDate));
    url.searchParams.set('td', compactDate(toDate || fromDate));
  }
  return url;
}

function buildGetStatementUrl(config, referenceCode, responseUrl = null) {
  const url = new URL(responseUrl || `${config.baseUrl}/GetStatement`);
  url.searchParams.set('t', config.token);
  url.searchParams.set('q', referenceCode);
  url.searchParams.set('v', '3');
  return url;
}

function scrubFlexError(error) {
  const message = String(error?.message || error || 'IBKR Flex request failed')
    .replace(/t=[^&\s]+/g, 't=[redacted]');
  const next = new Error(message);
  next.code = error?.code || 'flex_error';
  return next;
}

async function fetchFlexStatementWithPolicy({
  date = null,
  fromDate = null,
  toDate = null,
  useQueryPeriod = null,
  requestTextImpl = requestText,
  maxPolls = 5,
} = {}, { acceptPublishedThroughDate = false, validateSnapshot = null } = {}) {
  const config = getConfig();
  requireSyncConfig(config);
  const queryPeriodMode = useQueryPeriod == null ? config.useQueryPeriod : useQueryPeriod === true;
  const normalizedFromDate = exactDate(fromDate || date || todayLocal());
  const normalizedToDate = exactDate(toDate || date || normalizedFromDate);
  if (!normalizedFromDate || !normalizedToDate || normalizedFromDate > normalizedToDate) {
    const error = new Error('IBKR Flex date range is invalid');
    error.code = 'flex_invalid_date_range';
    throw error;
  }
  try {
    const requestXml = await requestTextImpl(buildSendRequestUrl(
      config,
      queryPeriodMode ? null : normalizedFromDate,
      queryPeriodMode ? null : normalizedToDate,
    ));
    const response = parseFlexResponse(requestXml);
    if (String(response.status || '').toLowerCase() !== 'success' || !response.referenceCode) {
      const error = new Error(response.errorMessage || 'IBKR Flex SendRequest failed');
      error.code = response.errorCode || 'flex_send_failed';
      throw error;
    }

    let statementXml = null;
    let statementDocument = null;
    let lastResponse = null;
    for (let attempt = 0; attempt < maxPolls; attempt += 1) {
      const xml = await requestTextImpl(buildGetStatementUrl(config, response.referenceCode, response.url));
      const maybeStatus = parseFlexResponse(xml);
      if (maybeStatus.status && String(maybeStatus.status).toLowerCase() === 'fail') {
        lastResponse = maybeStatus;
        await delay(750);
        continue;
      }
      statementXml = xml;
      statementDocument = maybeStatus.raw;
      break;
    }
    if (!statementXml) {
      const error = new Error(lastResponse?.errorMessage || 'IBKR Flex statement was not ready');
      error.code = lastResponse?.errorCode || 'flex_statement_not_ready';
      throw error;
    }

    // The polling status inspection already parsed this exact response. Reuse
    // that document without retaining it across requests or changing scope.
    const parsed = parseFlexStatementDocument(statementDocument, {
      targetCashBufferPct: config.targetCashBufferPct,
    });
    const statementFromDate = flexStatementDate(parsed.fromDate);
    const statementToDate = flexStatementDate(parsed.toDate);
    const accountRanges = (parsed.accounts || []).map((account) => ({
      fromDate: flexStatementDate(account.fromDate),
      toDate: flexStatementDate(account.toDate),
    }));
    // A rolling Activity report may still end on Friday when the scheduler
    // asks for Sunday. Only automatic sync may use that published cutoff;
    // explicit date requests continue to require their entire range.
    const requiredToDate = queryPeriodMode && acceptPublishedThroughDate
      && statementToDate && statementToDate < normalizedToDate
      ? statementToDate
      : normalizedToDate;
    const rangeMatches = queryPeriodMode
      ? statementFromDate <= normalizedFromDate
        && requiredToDate >= normalizedFromDate
        && statementToDate >= requiredToDate
        && accountRanges.every((range) => (
          Boolean(range.fromDate && range.toDate)
          && range.fromDate <= normalizedFromDate
          && range.toDate >= requiredToDate
        ))
      : statementFromDate === normalizedFromDate
        && statementToDate === normalizedToDate
        && accountRanges.every((range) => (
          Boolean(range.fromDate && range.toDate)
          && range.fromDate === normalizedFromDate
          && range.toDate === normalizedToDate
        ));
    if (!statementFromDate || !statementToDate || !rangeMatches) {
      const error = new Error('IBKR Flex statement coverage did not match the requested date range');
      error.code = 'flex_statement_range_mismatch';
      throw error;
    }
    const storageKey = statementFromDate === statementToDate
      ? statementToDate
      : `${statementFromDate}_${statementToDate}`;
    const reportHash = crypto.createHash('sha256').update(statementXml).digest('hex');
    const snapshot = {
      date: statementToDate,
      fromDate: statementFromDate,
      toDate: statementToDate,
      fetchedAt: new Date().toISOString(),
      source: 'ibkr_flex_web_service',
      reportHash,
      accountId: parsed.accountId,
      accountIds: parsed.accountIds,
      accountCount: parsed.accountCount,
      accounts: parsed.accounts,
      currency: parsed.currency,
      reportDate: parsed.reportDate,
      positionCount: parsed.positionCount,
      tradeCount: parsed.tradeCount,
      closedLotCount: parsed.closedLotCount,
      optionEventCount: parsed.optionEventCount,
      cashTransactionCount: parsed.cashTransactionCount,
      statementOfFundsCount: parsed.statementOfFundsCount,
      sections: parsed.sections,
      missingSections: parsed.missingSections,
      sectionCoverageComplete: parsed.complete,
      exposure: parsed.exposure,
      positions: parsed.positions,
      trades: parsed.trades,
      closedLots: parsed.closedLots,
      optionEvents: parsed.optionEvents,
      cashTransactions: parsed.cashTransactions,
      statementOfFunds: parsed.statementOfFunds,
    };
    if (validateSnapshot) validateSnapshot(snapshot);

    // Raw XML may contain sensitive statement data and is deliberately never
    // retained. Store only normalized evidence plus an immutable report hash.
    const immutablePath = reportPath(config, storageKey, reportHash);
    if (!fs.existsSync(immutablePath)) atomicWriteJson(immutablePath, snapshot);
    atomicWriteJson(snapshotPath(config, storageKey), snapshot);

    return snapshot;
  } catch (error) {
    throw scrubFlexError(error);
  }
}

async function fetchFlexStatement(options = {}) {
  return fetchFlexStatementWithPolicy(options);
}

function activityStatePath(config) {
  return path.join(config.dataDir, 'state', 'activity-sync.json');
}

function listSnapshots(config) {
  const dir = path.join(config.dataDir, 'snapshots');
  try {
    return fs.readdirSync(dir)
      .filter((name) => /^\d{4}-\d{2}-\d{2}(?:_\d{4}-\d{2}-\d{2})?\.json$/.test(name))
      .map((name) => readJsonIfExists(path.join(dir, name)))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function addDays(date, days) {
  const parsed = Date.parse(`${date}T12:00:00Z`);
  return Number.isFinite(parsed) ? new Date(parsed + days * 86400000).toISOString().slice(0, 10) : null;
}

function monthChunks(fromDate, toDate) {
  const chunks = [];
  let cursor = fromDate;
  while (cursor && cursor <= toDate) {
    const monthEnd = new Date(Date.UTC(
      Number(cursor.slice(0, 4)),
      Number(cursor.slice(5, 7)),
      0,
      12,
    )).toISOString().slice(0, 10);
    const end = monthEnd < toDate ? monthEnd : toDate;
    chunks.push({ fromDate: cursor, toDate: end });
    cursor = addDays(end, 1);
  }
  return chunks;
}

function coverageForSnapshots(snapshots, { accountId = null, expectedFromDate = null, expectedToDate = null } = {}) {
  const ranges = snapshots
    .filter((snapshot) => !accountId || (snapshot.accountIds || [snapshot.accountId]).includes(accountId))
    .map((snapshot) => ({
      fromDate: exactDate(flexStatementDate(snapshot.fromDate || snapshot.date)),
      toDate: exactDate(flexStatementDate(snapshot.toDate || snapshot.date)),
    }))
    .filter((range) => range.fromDate && range.toDate)
    .sort((left, right) => left.fromDate.localeCompare(right.fromDate) || left.toDate.localeCompare(right.toDate));
  if (!ranges.length) return {
    fromDate: null, toDate: null, contiguous: false, gaps: [], coversExpectedRange: false,
  };
  const merged = [];
  ranges.forEach((range) => {
    const previous = merged.at(-1);
    if (!previous || range.fromDate > addDays(previous.toDate, 1)) merged.push({ ...range });
    else if (range.toDate > previous.toDate) previous.toDate = range.toDate;
  });
  const gaps = merged.slice(1).map((range, index) => ({
    fromDate: addDays(merged[index].toDate, 1),
    toDate: addDays(range.fromDate, -1),
  }));
  const fromDate = merged[0].fromDate;
  const toDate = merged.at(-1).toDate;
  return {
    fromDate,
    toDate,
    contiguous: merged.length === 1,
    gaps,
    coversExpectedRange: merged.length === 1
      && (!expectedFromDate || fromDate <= expectedFromDate)
      && (!expectedToDate || toDate >= expectedToDate),
  };
}

function isPredictionEvidence(row = {}) {
  return /FORECAST|KALSHI|\bKX[A-Z0-9]+[-_]|\b(?:FES|COMCO|METLG|METLS|CPIY|CFBTC|CFETH)(?:\b|[-_])|(?:^|[-_ ])(?:YES|NO)(?:$|[-_ ])/i.test([
    row.exchange,
    row.symbol,
    row.localSymbol,
    row.description,
    row.tradingClass,
  ].filter(Boolean).join(' '));
}

function sumMicros(rows, field) {
  return rows.reduce((sum, row) => sum + Number(row?.[field] || 0), 0);
}

function uniqueEvidenceRows(rows, idFields) {
  const byId = new Map();
  rows.forEach((row) => {
    const identity = idFields.map((field) => row?.[field]).find((value) => value != null && String(value));
    const key = `${row?.accountId || ''}:${identity || row?.rawFingerprint || ''}`;
    byId.set(key, row);
  });
  return [...byId.values()];
}

function centsZero(micros) {
  return Math.round(Number(micros || 0) / 10_000) === 0;
}

function activityControls(snapshots = [], { accountId: requestedAccountId = null } = {}) {
  const orderedSnapshots = [...snapshots]
    .sort((left, right) => String(left.fetchedAt || '').localeCompare(String(right.fetchedAt || '')));
  const accountIds = [...new Set(orderedSnapshots.flatMap(
    (snapshot) => snapshot.accountIds || (snapshot.accountId ? [snapshot.accountId] : []),
  ))].filter((accountId) => accountId && (!requestedAccountId || accountId === requestedAccountId));
  const byAccount = accountIds.map((accountId) => {
    const trades = uniqueEvidenceRows(orderedSnapshots.flatMap((snapshot) => snapshot.trades || [])
      .filter((row) => row.accountId === accountId && isPredictionEvidence(row)), ['brokerExecutionId', 'execId']);
    const closedLots = uniqueEvidenceRows(orderedSnapshots.flatMap((snapshot) => snapshot.closedLots || [])
      .filter((row) => row.accountId === accountId && isPredictionEvidence(row)), ['controlId', 'tradeId']);
    const optionEvents = uniqueEvidenceRows(orderedSnapshots.flatMap((snapshot) => snapshot.optionEvents || [])
      .filter((row) => row.accountId === accountId && isPredictionEvidence(row)), ['eventId', 'tradeId']);
    const tradeByTradeId = new Map(trades
      .filter((row) => row.tradeId)
      .map((row) => [String(row.tradeId), row]));
    const optionEventTrade = (event) => {
      const exactIdMatch = event.tradeId ? tradeByTradeId.get(String(event.tradeId)) : null;
      if (exactIdMatch) return exactIdMatch;
      const financialMatches = trades.filter((trade) => (
        String(trade.transactionType || '').toUpperCase() === 'BOOKTRADE'
        && Number(trade.conId) === Number(event.conId)
        && Math.abs(Number(trade.quantity || 0) - Number(event.quantity || 0)) <= 1e-7
        && centsZero(Number(trade.proceedsMicros || 0) - Number(event.proceedsMicros || 0))
        && centsZero(Number(trade.realizedPnlMicros || 0) - Number(event.realizedPnlMicros || 0))
      ));
      return financialMatches.length === 1 ? financialMatches[0] : null;
    };
    const unmatchedOptionEvents = optionEvents.filter((event) => !optionEventTrade(event));
    const mismatchedOptionEvents = optionEvents.filter((event) => {
      const trade = optionEventTrade(event);
      if (!trade) return false;
      return Number(trade.conId) !== Number(event.conId)
        || Math.abs(Number(trade.quantity || 0) - Number(event.quantity || 0)) > 1e-7
        || !centsZero(Number(trade.proceedsMicros || 0) - Number(event.proceedsMicros || 0))
        || !centsZero(Number(trade.realizedPnlMicros || 0) - Number(event.realizedPnlMicros || 0));
    });
    const missingFinancialEvidence = trades.filter((trade) => (
      !trade.execId
      || trade.brokerIdentifierStatus !== 'reported'
      || !Number.isSafeInteger(trade.netCashMicros)
      || !Number.isSafeInteger(trade.proceedsMicros)
      || !Number.isSafeInteger(trade.realizedPnlMicros)
      || !Number.isSafeInteger(trade.commissionMicros)
      || !Number.isSafeInteger(trade.taxMicros)
    ));
    const cashIdentityDifferenceMicros = trades.reduce((sum, trade) => (
      sum
      + Number(trade.netCashMicros || 0)
      - Number(trade.proceedsMicros || 0)
      + Number(trade.commissionMicros || 0)
      + Number(trade.taxMicros || 0)
    ), 0);
    const contractGroups = new Map();
    trades.forEach((trade) => {
      const key = String(trade.conId);
      const group = contractGroups.get(key) || { netQuantity: 0, netCashMicros: 0, realizedPnlMicros: 0 };
      group.netQuantity += (trade.direction === 'BUY' ? 1 : -1) * Number(trade.quantity || 0);
      group.netCashMicros += Number(trade.netCashMicros || 0);
      group.realizedPnlMicros += Number(trade.realizedPnlMicros || 0);
      contractGroups.set(key, group);
    });
    const closedGroups = [...contractGroups.values()].filter((group) => Math.abs(group.netQuantity) <= 1e-7);
    const closedGroupDifferenceMicros = closedGroups.reduce((sum, group) => (
      sum + group.realizedPnlMicros - group.netCashMicros
    ), 0);
    const executionRealizedPnlMicros = sumMicros(trades, 'realizedPnlMicros');
    const expirationRealizedPnlMicros = sumMicros(optionEvents, 'realizedPnlMicros');
    const closedLotRealizedPnlMicros = sumMicros(closedLots, 'realizedPnlMicros');
    const closedLotSectionCovered = orderedSnapshots.length > 0 && orderedSnapshots.every((snapshot) => {
      const account = (snapshot.accounts || []).find((candidate) => candidate.accountId === accountId);
      return (account?.sections || snapshot.sections)?.closedLots === true;
    });
    // IBKR can emit expiry BookTrade rows inside the execution tape while also
    // repeating them in Option EAE. Only EAE rows absent from the tape are an
    // additive control against native Closed Lots.
    const supplementalExpirationPnlMicros = sumMicros(unmatchedOptionEvents, 'realizedPnlMicros');
    const closedLotDifferenceMicros = executionRealizedPnlMicros
      + supplementalExpirationPnlMicros
      - closedLotRealizedPnlMicros;
    const executionAccountingComplete = missingFinancialEvidence.length === 0
      && centsZero(cashIdentityDifferenceMicros)
      && centsZero(closedGroupDifferenceMicros)
      && unmatchedOptionEvents.length === 0
      && mismatchedOptionEvents.length === 0;
    const differenceMicros = closedLotSectionCovered
      ? closedLotDifferenceMicros
      : closedGroupDifferenceMicros;
    const reconciled = missingFinancialEvidence.length === 0
      && centsZero(cashIdentityDifferenceMicros)
      && mismatchedOptionEvents.length === 0
      && (closedLotSectionCovered
        ? centsZero(closedLotDifferenceMicros)
        : executionAccountingComplete);
    return {
      accountId,
      mode: closedLotSectionCovered ? 'closed_lots' : 'execution_accounting',
      tradeCount: trades.length,
      optionEventCount: optionEvents.length,
      closedContractCount: closedGroups.length,
      executionRealizedPnlMicros,
      expirationRealizedPnlMicros,
      closedLotRealizedPnlMicros,
      supplementalExpirationPnlMicros,
      cashIdentityDifferenceMicros,
      closedGroupDifferenceMicros,
      closedLotDifferenceMicros,
      missingFinancialEvidenceCount: missingFinancialEvidence.length,
      unmatchedOptionEventCount: unmatchedOptionEvents.length,
      mismatchedOptionEventCount: mismatchedOptionEvents.length,
      executionAccountingComplete,
      closedLotControlAvailable: closedLotSectionCovered || executionAccountingComplete,
      reconciled,
      differenceMicros,
      difference: differenceMicros / 1_000_000,
    };
  });
  return {
    accounts: byAccount,
    consolidatedDifferenceMicros: byAccount.reduce((sum, row) => sum + row.differenceMicros, 0),
    consolidatedDifference: byAccount.reduce((sum, row) => sum + row.differenceMicros, 0) / 1_000_000,
    closedLotAlternativeComplete: byAccount.length > 0 && byAccount.every((row) => row.closedLotControlAvailable),
    zeroToCent: byAccount.length > 0 && byAccount.every((row) => row.reconciled),
  };
}

// A broker may revise tax-lot annotations in overlapping activity reports.
// These are not new fills. Every other normalized field, including cash and
// fees, must agree before accepting the newer report as the same execution.
const FLEX_REPORT_REVISION_FIELDS = new Set([
  'costBasis', 'costBasisMicros', 'realizedPnl', 'realizedPnlMicros',
  'openCloseIndicator', 'rawFingerprint', 'reportFingerprints',
]);
function equivalentFlexExecution(left, right) {
  const sameFields = [...new Set([...Object.keys(left), ...Object.keys(right)])]
    .filter((key) => !FLEX_REPORT_REVISION_FIELDS.has(key) && key !== 'contractSide')
    .every((key) => JSON.stringify(left[key]) === JSON.stringify(right[key]));
  if (!sameFields) return false;
  if (left.contractSide === right.contractSide) return true;
  if (left.contractSide == null && right.contractSide == null) return true;
  // Older normalized reports omitted put/call-derived side evidence. Accept
  // only a one-way enrichment corroborated by the exact broker contract text;
  // never treat YES/NO disagreement as a harmless report revision.
  const known = left.contractSide == null ? right : right.contractSide == null ? left : null;
  if (!known || !['YES', 'NO'].includes(known.contractSide)
    || known.source !== 'ibkr_flex_import'
    || known.brokerIdentifierStatus !== 'reported'
    || !/^[a-f0-9]{64}$/i.test(String(known.rawFingerprint || ''))) return false;
  const identity = [known.symbol, known.localSymbol, known.description].filter(Boolean).join(' ').toUpperCase();
  const sides = [...new Set(identity.match(/\b(?:YES|NO)\b/g) || [])];
  // Underscores are word characters, so also inspect explicit ticker suffixes.
  for (const match of identity.matchAll(/[_-](YES|NO)(?=$|[_-]|\s)/g)) sides.push(match[1]);
  const unique = [...new Set(sides)];
  return unique.length === 1 && unique[0] === known.contractSide;
}

function validateFlexActivitySnapshots(sourceSnapshots = [], {
  accountId = null, expectedFromDate = null, expectedToDate = null,
} = {}) {
  const snapshots = sourceSnapshots.filter((snapshot) => Array.isArray(snapshot?.trades));
  if (!snapshots.length) return { status: 'missing', complete: false, trades: [], conflicts: [] };
  const coverage = coverageForSnapshots(snapshots, {
    accountId,
    expectedFromDate,
    expectedToDate,
  });
  const scopedSnapshots = snapshots.filter((snapshot) => (
    !accountId || (snapshot.accountIds || [snapshot.accountId]).includes(accountId)
  ));
  const controls = activityControls(scopedSnapshots, { accountId });
  const sectionStatus = activitySectionStatus(scopedSnapshots, controls);
  const sectionCoverage = sectionStatus.satisfied;
  const missingSections = sectionStatus.missing;
  const byId = new Map();
  const conflicts = [];
  const sideEnrichments = new Set();
  [...snapshots]
    .sort((left, right) => String(left.fetchedAt || '').localeCompare(String(right.fetchedAt || '')))
    .flatMap((snapshot) => snapshot.trades)
    .filter((trade) => !accountId || trade.accountId === accountId)
    .forEach((trade) => {
      const key = `${trade.accountId || ''}:${trade.execId || ''}`;
      const existing = byId.get(key);
      if (!existing) byId.set(key, trade);
      else {
        if (equivalentFlexExecution(existing, trade)) {
          if (existing.contractSide !== trade.contractSide
            && (existing.contractSide == null || trade.contractSide == null)) sideEnrichments.add(key);
          byId.set(key, {
            ...trade,
            contractSide: trade.contractSide ?? existing.contractSide ?? null,
            reportFingerprints: [...new Set([
              ...(existing.reportFingerprints || [existing.rawFingerprint]),
              trade.rawFingerprint,
            ].filter(Boolean))],
          });
        } else conflicts.push({ key, existing, incoming: trade });
      }
    });
  const trades = [...byId.values()]
    .filter(isPredictionEvidence)
    .sort((left, right) => String(left.executionTime || '').localeCompare(String(right.executionTime || '')) || String(left.execId).localeCompare(String(right.execId)));
  const fetchedAt = scopedSnapshots
    .map((snapshot) => snapshot.fetchedAt)
    .filter(Boolean)
    .sort()
    .at(-1) || null;
  const snapshotId = scopedSnapshots.length
    ? `flex-${crypto.createHash('sha256').update(JSON.stringify({
        accountId: accountId || 'all',
        fromDate: coverage.fromDate || null,
        toDate: coverage.toDate || null,
        reports: scopedSnapshots.map((snapshot) => snapshot.reportHash || snapshot.fetchedAt || snapshot.date).sort(),
        executions: trades.map((trade) => `${trade.accountId || ''}:${trade.execId || ''}`),
      })).digest('hex').slice(0, 32)}`
    : null;
  return {
    status: conflicts.length
      ? 'conflict'
      : (!coverage.contiguous || !coverage.coversExpectedRange)
        ? 'coverage_gap'
        : missingSections.length
          ? 'missing_sections'
          : controls.zeroToCent !== true
            ? 'accounting_mismatch'
            : 'ready',
    complete: conflicts.length === 0
      && coverage.contiguous
      && coverage.coversExpectedRange
      && missingSections.length === 0
      && controls.zeroToCent === true,
    trades: conflicts.length ? [] : trades,
    conflicts,
    conflictScope: {
      accountIds: [...new Set(conflicts.map((conflict) => conflict.existing.accountId).filter(Boolean))],
      conIds: [...new Set(conflicts.flatMap((conflict) => [conflict.existing.conId, conflict.incoming.conId]).filter((value) => value != null))],
      executionCount: new Set(conflicts.map((conflict) => conflict.key)).size,
    },
    sideEnrichmentCount: sideEnrichments.size,
    coverage,
    sectionCoverage,
    reportedSectionCoverage: sectionStatus.reported,
    sectionAlternatives: sectionStatus.alternatives,
    controls,
    missingSections,
    snapshotCount: snapshots.length,
    fromDate: coverage.fromDate,
    toDate: coverage.toDate,
    fetchedAt,
    snapshotId,
  };
}

// Only background ingestion/explicit previews read these large source files.
// Stat changes invalidate both parsed snapshots and every scoped validation.
// Publication/commit callers use force=true to rehash bytes independently.
function createFlexActivityReader({ getConfigImpl = getConfig } = {}) {
  let cached = null;
  const validations = new Map();
  function invalidate() { cached = null; validations.clear(); }
  function readSourceSet({ force = false } = {}) {
    const config = getConfigImpl();
    const directory = path.join(config.dataDir, 'snapshots');
    const names = fs.existsSync(directory) ? fs.readdirSync(directory)
      .filter((name) => /^\d{4}-\d{2}-\d{2}(?:_\d{4}-\d{2}-\d{2})?\.json$/.test(name)).sort() : [];
    const stateFile = activityStatePath(config);
    const files = names.map((name) => ({ name, file: path.join(directory, name) }));
    const inspected = [...files, ...(fs.existsSync(stateFile) ? [{ name: 'state/activity-sync.json', file: stateFile }] : [])];
    const signature = JSON.stringify([path.resolve(config.dataDir), inspected.map(({ name, file }) => {
      const stat = fs.statSync(file);
      return [name, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs];
    })]);
    if (!force && cached?.signature === signature) return cached;
    const sourceManifest = [];
    const snapshots = files.map(({ name, file }) => {
      const raw = fs.readFileSync(file, 'utf8');
      const snapshot = JSON.parse(raw);
      sourceManifest.push({ name, sha256: crypto.createHash('sha256').update(raw).digest('hex'), reportHash: snapshot.reportHash || null });
      return snapshot;
    });
    const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : null;
    const sourceFingerprint = crypto.createHash('sha256').update(JSON.stringify(sourceManifest)).digest('hex');
    cached = { signature, snapshots, state, sourceManifest, sourceFingerprint };
    validations.clear();
    return cached;
  }
  function read({ accountId = null, expectedFromDate = null, expectedToDate = null, force = false, allowUnconfigured = false } = {}) {
    const config = getConfigImpl();
    if (!allowUnconfigured && (!config.enabled || !config.configured)) {
      return { status: config.enabled ? 'missing_config' : 'disabled', complete: false, trades: [], conflicts: [] };
    }
    try {
      const sources = readSourceSet({ force });
      const from = expectedFromDate || sources.state?.coverage?.fromDate || null;
      const through = expectedToDate || sources.state?.coverage?.toDate || null;
      const key = JSON.stringify([accountId, from, through]);
      if (!validations.has(key)) {
        validations.set(key, {
          ...validateFlexActivitySnapshots(sources.snapshots, { accountId, expectedFromDate: from, expectedToDate: through }),
          validationVersion: 2,
          sourceManifest: sources.sourceManifest,
          sourceHashes: sources.sourceManifest.map((entry) => entry.sha256),
          sourceFingerprint: sources.sourceFingerprint,
        });
      }
      // Callers cannot mutate the cached evidence or another account's view.
      return JSON.parse(JSON.stringify(validations.get(key)));
    } catch (_error) {
      invalidate();
      return { status: 'source_unavailable', complete: false, trades: [], conflicts: [], reason: 'Stored Flex evidence could not be read or verified.' };
    }
  }
  return { read, readSourceSet, invalidate };
}

const flexActivityReader = createFlexActivityReader();
function readFlexActivityTrades(options = {}) { return flexActivityReader.read(options); }

async function syncFlexActivity({
  throughDate = null,
  fromDate = null,
  requestTextImpl = requestText,
  maxPolls = 5,
} = {}) {
  const config = getConfig();
  requireSyncConfig(config);
  const automaticRollingSync = throughDate == null && fromDate == null && config.useQueryPeriod;
  const requestedToDate = exactDate(throughDate ?? previousLocalDay());
  if (!requestedToDate) throw Object.assign(new Error('IBKR Flex activity end date is invalid'), { code: 'flex_invalid_date_range' });
  let toDate = requestedToDate;
  const priorState = readJsonIfExists(activityStatePath(config));
  const initialFromDate = `${toDate.slice(0, 4)}-01-01`;
  const startDate = exactDate(fromDate)
    || (priorState?.lastThroughDate ? addDays(priorState.lastThroughDate, -6) : initialFromDate);
  if (startDate > toDate) {
    return { status: 'current', fromDate: startDate, toDate, tradeCount: 0, snapshot: null };
  }
  const chunks = config.useQueryPeriod
    ? [{ fromDate: startDate, toDate }]
    : monthChunks(startDate, toDate);
  const snapshots = [];
  const expectedFromDate = exactDate(fromDate) || priorState?.coverage?.fromDate || initialFromDate;
  const priorSnapshots = automaticRollingSync ? listSnapshots(config) : [];
  const validatePublishedSnapshot = (snapshot) => {
    const accountIds = snapshot.accountIds || [];
    const expectedAccountIds = config.expectedAccountIds;
    if (!expectedAccountIds.length
      || expectedAccountIds.some((accountId) => !accountIds.includes(accountId))
      || accountIds.some((accountId) => !expectedAccountIds.includes(accountId))) {
      throw Object.assign(new Error('IBKR Flex statement accounts did not match the configured accounts'), {
        code: 'flex_statement_account_mismatch',
      });
    }
    const publishedToDate = snapshot.toDate < requestedToDate ? snapshot.toDate : requestedToDate;
    if (priorState?.lastThroughDate && publishedToDate < priorState.lastThroughDate) {
      throw Object.assign(new Error('IBKR Flex statement coverage is older than the verified history'), {
        code: 'flex_statement_range_mismatch',
      });
    }
    const candidates = [...priorSnapshots, snapshot];
    const validations = [null, ...expectedAccountIds].map((accountId) => validateFlexActivitySnapshots(candidates, {
      accountId, expectedFromDate, expectedToDate: publishedToDate,
    }));
    if (validations.some((validation) => !validation.complete)) {
      throw Object.assign(new Error('IBKR Flex Activity statement did not pass history validation'), {
        code: 'flex_activity_validation_failed',
      });
    }
    toDate = publishedToDate;
  };
  for (const chunk of chunks) {
    // Sequential requests respect IBKR's Flex generation/poll lifecycle.
    snapshots.push(await fetchFlexStatementWithPolicy({
      ...chunk,
      useQueryPeriod: config.useQueryPeriod,
      requestTextImpl,
      maxPolls,
    }, {
      acceptPublishedThroughDate: automaticRollingSync,
      validateSnapshot: automaticRollingSync ? validatePublishedSnapshot : null,
    }));
  }
  const allSnapshots = listSnapshots(config);
  const accountIds = [...new Set(allSnapshots.flatMap(
    (snapshot) => snapshot.accountIds || (snapshot.accountId ? [snapshot.accountId] : []),
  ))].filter(Boolean);
  const coverageByAccount = accountIds.map((accountId) => ({
    accountId,
    ...coverageForSnapshots(allSnapshots, { accountId, expectedFromDate, expectedToDate: toDate }),
  }));
  const coverage = {
    fromDate: expectedFromDate,
    toDate,
    contiguous: accountIds.length > 0 && coverageByAccount.every((item) => item.coversExpectedRange),
    accounts: coverageByAccount,
  };
  const controls = activityControls(allSnapshots);
  const state = {
    ...priorState,
    source: 'ibkr_flex_web_service',
    lastFromDate: startDate,
    lastThroughDate: toDate,
    lastSuccessfulSyncAt: snapshots.at(-1)?.fetchedAt || new Date().toISOString(),
    accountIds,
    coverage,
    reconciliationDifferences: {
      consolidated: controls.consolidatedDifference,
      accounts: controls.accounts.map((row) => ({
        account: maskAccountId(row.accountId),
        difference: row.difference,
      })),
    },
    tradeCount: snapshots.reduce((sum, snapshot) => sum + Number(snapshot.tradeCount || 0), 0),
  };
  atomicWriteJson(activityStatePath(config), state);
  return {
    status: 'synced',
    fromDate: startDate,
    toDate,
    tradeCount: state.tradeCount,
    snapshots,
    snapshot: snapshots.at(-1) || null,
    coverage,
    controls,
  };
}

function previewPath(config, previewHash) {
  return path.join(config.dataDir, 'previews', `${previewHash}.json`);
}

function sectionCoverageForSnapshots(snapshots) {
  const names = ['executions', 'closedLots', 'optionEvents', 'cashTransactions', 'statementOfFunds', 'openPositions'];
  return Object.fromEntries(names.map((name) => [
    name,
    snapshots.length > 0 && snapshots.every((snapshot) => snapshot.sections?.[name] === true),
  ]));
}

function activitySectionStatus(snapshots, controls = activityControls(snapshots)) {
  const reported = sectionCoverageForSnapshots(snapshots);
  const closedLotAlternative = reported.closedLots !== true
    && controls.closedLotAlternativeComplete === true;
  const satisfied = {
    ...reported,
    closedLots: reported.closedLots === true || closedLotAlternative,
  };
  return {
    reported,
    satisfied,
    alternatives: closedLotAlternative ? { closedLots: 'execution_accounting' } : {},
    missing: Object.entries(satisfied).filter(([, covered]) => !covered).map(([name]) => name),
  };
}

function predictionVenue(row = {}) {
  const identity = [row.exchange, row.symbol, row.localSymbol, row.description].filter(Boolean).join(' ').toUpperCase();
  if (identity.includes('FORECAST')) return 'ForecastEx';
  if (/\bKX[A-Z0-9]+[-_]/.test(identity)) return 'Kalshi';
  return 'Unknown';
}

function juneCpiAudit(snapshots) {
  const trades = uniqueEvidenceRows([...snapshots]
    .sort((left, right) => String(left.fetchedAt || '').localeCompare(String(right.fetchedAt || '')))
      .flatMap((snapshot) => snapshot.trades || [])
      .filter((row) => isPredictionEvidence(row)
        && /CPI/i.test([row.symbol, row.localSymbol, row.description, row.tradingClass].filter(Boolean).join(' '))
        && /(?:26JUN|JUN26|_0626_)/i.test([row.localSymbol, row.description].filter(Boolean).join(' '))),
  ['brokerExecutionId', 'execId']);
  const groups = new Map();
  trades.forEach((trade) => {
    const contract = trade.localSymbol || trade.symbol || String(trade.conId);
    const key = `${trade.accountId}|${trade.conId}|${contract}`;
    if (!groups.has(key)) groups.set(key, {
      accountId: trade.accountId,
      venue: predictionVenue(trade),
      conId: trade.conId,
      contract,
      entryCostMicros: 0,
      cashoutProceedsMicros: 0,
      settlementPayoutMicros: 0,
      feesMicros: 0,
      netQuantity: 0,
      netPnlMicros: 0,
      ibkrRealizedPnlMicros: 0,
    });
    const row = groups.get(key);
    const feeMicros = Number(trade.commissionMicros || 0) + Number(trade.taxMicros || 0);
    row.feesMicros += feeMicros;
    const netCashMicros = Number(trade.netCashMicros || 0);
    row.netQuantity += (trade.direction === 'BUY' ? 1 : -1) * Number(trade.quantity || 0);
    row.netPnlMicros += netCashMicros;
    row.ibkrRealizedPnlMicros += Number(trade.realizedPnlMicros || 0);
    if (trade.direction === 'BUY') row.entryCostMicros += Math.max(0, -netCashMicros);
    else if (String(trade.transactionType || '').toUpperCase() === 'BOOKTRADE') {
      row.settlementPayoutMicros += Math.max(0, netCashMicros);
    } else {
      row.cashoutProceedsMicros += Math.max(0, netCashMicros);
    }
  });
  groups.forEach((row) => {
    row.netQuantity = Math.abs(row.netQuantity) <= 1e-7 ? 0 : row.netQuantity;
    row.controlDifferenceMicros = row.netPnlMicros - row.ibkrRealizedPnlMicros;
    row.entryCost = row.entryCostMicros / 1_000_000;
    row.cashoutProceeds = row.cashoutProceedsMicros / 1_000_000;
    row.settlementPayout = row.settlementPayoutMicros / 1_000_000;
    row.fees = row.feesMicros / 1_000_000;
    row.netPnl = row.netPnlMicros / 1_000_000;
    row.ibkrRealizedPnl = row.ibkrRealizedPnlMicros / 1_000_000;
    row.controlDifference = row.controlDifferenceMicros / 1_000_000;
  });
  const rows = [...groups.values()].sort((left, right) => (
    String(left.accountId).localeCompare(String(right.accountId)) || left.contract.localeCompare(right.contract)
  ));
  const total = (field, predicate = () => true) => rows
    .filter(predicate)
    .reduce((sum, row) => sum + Number(row[field] || 0), 0) / 1_000_000;
  return {
    status: rows.length ? 'broker_evidence' : 'no_matching_activity',
    rows,
    grossPayout: total('cashoutProceedsMicros') + total('settlementPayoutMicros'),
    kalshiOnlyRealizedPnl: total('ibkrRealizedPnlMicros', (row) => row.venue === 'Kalshi'),
    allVenueRealizedPnl: total('ibkrRealizedPnlMicros'),
    controlDifference: total('controlDifferenceMicros'),
    note: 'June 2026 CPI contracts, released July 14. Totals are IBKR-reported realized P&L reconciled to execution cash flows.',
  };
}

function flexPreviewHash(preview) {
  const metadata = new Set(['previewHash', 'generatedAt', 'complete', 'missingSections', 'missingAccounts', 'unexpectedAccounts', 'juneCpiAudit']);
  const identity = Object.fromEntries(Object.entries(preview).filter(([key]) => !metadata.has(key)));
  return crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

function buildFlexActivityPreview({ snapshots, sourceManifest, expectedAccountIds, fromDate, throughDate }) {
  const normalizedFrom = exactDate(fromDate);
  const normalizedThrough = exactDate(throughDate);
  if (!normalizedFrom || !normalizedThrough || normalizedFrom > normalizedThrough) {
    const error = new Error('Prediction P&L backfill date range is invalid');
    error.code = 'flex_invalid_date_range';
    throw error;
  }
  const accountIds = [...new Set(snapshots.flatMap(
    (snapshot) => snapshot.accountIds || (snapshot.accountId ? [snapshot.accountId] : []),
  ))].filter(Boolean);
  const missingAccounts = expectedAccountIds.filter((accountId) => !accountIds.includes(accountId));
  const unexpectedAccounts = accountIds.filter((accountId) => !expectedAccountIds.includes(accountId));
  const coverage = accountIds.map((accountId) => ({
    accountId,
    ...coverageForSnapshots(snapshots, {
      accountId,
      expectedFromDate: normalizedFrom,
      expectedToDate: normalizedThrough,
    }),
  }));
  const controls = activityControls(snapshots);
  const sectionStatus = activitySectionStatus(snapshots, controls);
  const sections = sectionStatus.satisfied;
  const missingSections = sectionStatus.missing;
  const evidence = validateFlexActivitySnapshots(snapshots, {
    expectedFromDate: normalizedFrom, expectedToDate: normalizedThrough,
  });
  const accountEvidence = accountIds.map((accountId) => validateFlexActivitySnapshots(snapshots, {
    accountId, expectedFromDate: normalizedFrom, expectedToDate: normalizedThrough,
  }));
  const complete = expectedAccountIds.length > 0
    && missingAccounts.length === 0
    && unexpectedAccounts.length === 0
    && coverage.every((row) => row.coversExpectedRange)
    && missingSections.length === 0
    && controls.zeroToCent
    && evidence.complete === true
    && accountEvidence.every((history) => history.complete === true);
  const previewIdentity = {
    schemaVersion: 2,
    validationVersion: 2,
    fromDate: normalizedFrom,
    throughDate: normalizedThrough,
    accountIds: [...accountIds].sort(),
    reportHashes: snapshots.map((snapshot) => snapshot.reportHash).filter(Boolean).sort(),
    sourceManifest,
    sourceFingerprint: crypto.createHash('sha256').update(JSON.stringify(sourceManifest)).digest('hex'),
    conflictScope: evidence.conflictScope || { accountIds: [], conIds: [], executionCount: 0 },
    sideEnrichmentCount: evidence.sideEnrichmentCount || 0,
    coverage,
    sections,
    reportedSections: sectionStatus.reported,
    sectionAlternatives: sectionStatus.alternatives,
    controls,
  };
  const previewHash = flexPreviewHash(previewIdentity);
  const preview = {
    ...previewIdentity,
    previewHash,
    generatedAt: new Date().toISOString(),
    complete,
    missingSections,
    missingAccounts,
    unexpectedAccounts,
    juneCpiAudit: juneCpiAudit(snapshots),
  };
  return preview;
}

function previewStoredPredictionPnlBackfill({ fromDate, throughDate, persist = false } = {}) {
  const config = getConfig();
  // No Flex request and no sync-state mutation. Read/hash the actual bytes even
  // if a background reader already has a parsed snapshot in memory.
  const sources = flexActivityReader.readSourceSet({ force: true });
  const preview = buildFlexActivityPreview({
    ...sources, expectedAccountIds: config.expectedAccountIds, fromDate, throughDate,
  });
  if (persist) atomicWriteJson(previewPath(config, preview.previewHash), preview);
  return preview;
}

async function previewPredictionPnlBackfill({ fromDate, throughDate, requestTextImpl = requestText, maxPolls = 5 } = {}) {
  requireSyncConfig(getConfig());
  if (!exactDate(fromDate) || !exactDate(throughDate) || fromDate > throughDate) {
    throw Object.assign(new Error('Prediction P&L backfill date range is invalid'), { code: 'flex_invalid_date_range' });
  }
  await syncFlexActivity({ fromDate, throughDate, requestTextImpl, maxPolls });
  return previewStoredPredictionPnlBackfill({ fromDate, throughDate, persist: true });
}

function commitPredictionPnlBackfill(previewHash) {
  const config = getConfig();
  requireSyncConfig(config);
  if (!/^[a-f0-9]{64}$/i.test(String(previewHash || ''))) {
    const error = new Error('Prediction P&L preview hash is invalid');
    error.code = 'flex_preview_invalid';
    throw error;
  }
  const preview = readJsonIfExists(previewPath(config, previewHash));
  if (!preview || preview.previewHash !== previewHash) {
    const error = new Error('Prediction P&L preview was not found');
    error.code = 'flex_preview_not_found';
    throw error;
  }
  if (preview.complete !== true || preview.controls?.zeroToCent !== true) {
    const error = new Error('Prediction P&L preview is incomplete or does not reconcile to the cent');
    error.code = 'flex_preview_not_reconciled';
    throw error;
  }
  if (flexPreviewHash(preview) !== previewHash) {
    throw Object.assign(new Error('The stored preview was changed; create and review a new preview.'), { code: 'flex_preview_invalid' });
  }
  const current = previewStoredPredictionPnlBackfill({ fromDate: preview.fromDate, throughDate: preview.throughDate });
  if (current.complete !== true || current.previewHash !== previewHash
    || JSON.stringify(current.sourceManifest) !== JSON.stringify(preview.sourceManifest)) {
    throw Object.assign(new Error('Stored Flex evidence changed or no longer validates; create and review a new preview.'), {
      code: 'flex_preview_source_changed',
    });
  }
  const state = readJsonIfExists(activityStatePath(config)) || {};
  const committedAt = new Date().toISOString();
  atomicWriteJson(activityStatePath(config), {
    ...state,
    authoritativeEnabled: true,
    approvedPreviewHash: previewHash,
    approvedAt: committedAt,
    coverage: {
      fromDate: current.fromDate,
      toDate: current.throughDate,
      contiguous: true,
      accounts: current.coverage,
    },
    reconciliationDifferences: {
      consolidated: current.controls.consolidatedDifference,
      accounts: current.controls.accounts.map((row) => ({
        account: maskAccountId(row.accountId),
        difference: row.difference,
      })),
    },
  });
  return {
    status: 'committed',
    previewHash,
    committedAt,
    accounts: current.accountIds.map(maskAccountId),
    fromDate: current.fromDate,
    throughDate: current.throughDate,
    juneCpiAudit: current.juneCpiAudit ? {
      ...current.juneCpiAudit,
      rows: (current.juneCpiAudit.rows || []).map((row) => ({
        ...row,
        accountId: maskAccountId(row.accountId),
      })),
    } : null,
  };
}

let activityTimer = null;
function startFlexActivitySync({ onSnapshot = null, logger = console, intervalMs = 24 * 60 * 60 * 1000 } = {}) {
  if (activityTimer) return;
  const tick = async () => {
    const config = getConfig();
    if (!config.enabled || !config.configured) return;
    const state = readJsonIfExists(activityStatePath(config));
    if (state?.authoritativeEnabled !== true) return;
    try {
      const result = await syncFlexActivity();
      if (result.status === 'synced' && typeof onSnapshot === 'function') await onSnapshot(result);
    } catch (error) {
      logger.warn?.(`[IBKR Flex] automatic activity sync paused: ${scrubFlexError(error).message}`);
    }
  };
  tick();
  activityTimer = setInterval(tick, intervalMs);
  activityTimer.unref?.();
}

function stopFlexActivitySync() {
  if (activityTimer) clearInterval(activityTimer);
  activityTimer = null;
}

function getReconciliation({ date = todayLocal() } = {}) {
  const config = getConfig();
  const snapshot = readJsonIfExists(snapshotPath(config, date));
  if (!snapshot) {
    const latest = latestSnapshot(config);
    return {
      status: config.enabled ? 'missing' : 'disabled',
      date,
      source: 'ibkr_flex_web_service',
      targetCashBufferPct: config.targetCashBufferPct,
      flex: null,
      latestSnapshot: latest
        ? {
            date: latest.date,
            fetchedAt: latest.fetchedAt,
            exposure: latest.exposure,
          }
        : null,
    };
  }
  return {
    status: 'ready',
    date,
    source: 'ibkr_flex_web_service',
    targetCashBufferPct: config.targetCashBufferPct,
    flex: {
      date: snapshot.date,
      fetchedAt: snapshot.fetchedAt,
      reportDate: snapshot.reportDate,
      accounts: (snapshot.accountIds || (snapshot.accountId ? [snapshot.accountId] : [])).map(maskAccountId),
      currency: snapshot.currency,
      positionCount: snapshot.positionCount,
      exposure: snapshot.exposure,
    },
  };
}

module.exports = {
  buildFlexActivityPreview,
  buildSendRequestUrl,
  commitPredictionPnlBackfill,
  createFlexActivityReader,
  fetchFlexStatement,
  getConfig,
  getReconciliation,
  publicConfigStatus,
  previewPredictionPnlBackfill,
  previewStoredPredictionPnlBackfill,
  readFlexActivityTrades,
  startFlexActivitySync,
  stopFlexActivitySync,
  syncFlexActivity,
  validateFlexActivitySnapshots,
};
