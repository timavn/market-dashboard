const fs = require('fs');
const path = require('path');
const { parseFlexResponse, parseFlexStatement } = require('../utils/ibkrFlexExposure.cjs');

const DEFAULT_BASE_URL = 'https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService';
const DEFAULT_DATA_DIR = path.join(process.cwd(), 'data', 'ibkr-flex');

function isEnabled() {
  return process.env.IBKR_FLEX_ENABLED === 'true';
}

function getConfig() {
  const token = process.env.IBKR_FLEX_TOKEN || '';
  const queryId = process.env.IBKR_FLEX_ACTIVITY_QUERY_ID || '';
  return {
    enabled: isEnabled(),
    configured: Boolean(token && queryId),
    token,
    queryId,
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
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

function rawPath(config, date) {
  return path.join(config.dataDir, 'raw', `${date}.xml`);
}

function latestSnapshot(config) {
  const dir = path.join(config.dataDir, 'snapshots');
  try {
    const files = fs.readdirSync(dir)
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
      .sort();
    if (files.length === 0) return null;
    return readJsonIfExists(path.join(dir, files[files.length - 1]));
  } catch {
    return null;
  }
}

function publicConfigStatus(config = getConfig()) {
  const latest = latestSnapshot(config);
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
    latestSnapshot: latest
      ? {
          date: latest.date,
          fetchedAt: latest.fetchedAt,
          accountId: latest.accountId,
          source: latest.source,
          exposure: latest.exposure,
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

function buildSendRequestUrl(config, date) {
  const url = new URL(`${config.baseUrl}/SendRequest`);
  url.searchParams.set('t', config.token);
  url.searchParams.set('q', config.queryId);
  url.searchParams.set('v', '3');
  if (date) {
    const compact = compactDate(date);
    url.searchParams.set('fd', compact);
    url.searchParams.set('td', compact);
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

async function fetchFlexStatement({ date = todayLocal(), requestTextImpl = requestText, maxPolls = 5 } = {}) {
  const config = getConfig();
  requireSyncConfig(config);

  try {
    const requestXml = await requestTextImpl(buildSendRequestUrl(config, date));
    const response = parseFlexResponse(requestXml);
    if (String(response.status || '').toLowerCase() !== 'success' || !response.referenceCode) {
      const error = new Error(response.errorMessage || 'IBKR Flex SendRequest failed');
      error.code = response.errorCode || 'flex_send_failed';
      throw error;
    }

    let statementXml = null;
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
      break;
    }
    if (!statementXml) {
      const error = new Error(lastResponse?.errorMessage || 'IBKR Flex statement was not ready');
      error.code = lastResponse?.errorCode || 'flex_statement_not_ready';
      throw error;
    }

    const parsed = parseFlexStatement(statementXml, {
      targetCashBufferPct: config.targetCashBufferPct,
    });
    const snapshot = {
      date,
      fetchedAt: new Date().toISOString(),
      source: 'ibkr_flex_web_service',
      accountId: parsed.accountId,
      currency: parsed.currency,
      reportDate: parsed.reportDate,
      positionCount: parsed.positionCount,
      exposure: parsed.exposure,
      positions: parsed.positions,
    };

    ensureDir(path.dirname(rawPath(config, date)));
    ensureDir(path.dirname(snapshotPath(config, date)));
    fs.writeFileSync(rawPath(config, date), statementXml);
    fs.writeFileSync(snapshotPath(config, date), `${JSON.stringify(snapshot, null, 2)}\n`);

    return snapshot;
  } catch (error) {
    throw scrubFlexError(error);
  }
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
      accountId: snapshot.accountId,
      currency: snapshot.currency,
      positionCount: snapshot.positionCount,
      exposure: snapshot.exposure,
    },
  };
}

module.exports = {
  fetchFlexStatement,
  getConfig,
  getReconciliation,
  publicConfigStatus,
};
