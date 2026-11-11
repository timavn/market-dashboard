const crypto = require('crypto');
const fs = require('fs');

const DEFAULT_BASE = 'https://external-api.kalshi.com/trade-api/v2';
// Without a limit a request that Kalshi never answers holds its caller open
// for good, and a paginated read stops at that page.
const DEFAULT_TIMEOUT_MS = 15_000;

function requestTimeoutMs(options) {
  const configured = Number(options?.timeoutMs ?? process.env.KALSHI_REQUEST_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_TIMEOUT_MS;
}

function loadPrivateKey() {
  if (process.env.KALSHI_PRIVATE_KEY_PEM) {
    return process.env.KALSHI_PRIVATE_KEY_PEM.replace(/\\n/g, '\n');
  }
  const keyPath = process.env.KALSHI_PRIVATE_KEY_PATH;
  if (keyPath && fs.existsSync(keyPath)) {
    return fs.readFileSync(keyPath, 'utf8');
  }
  return null;
}

function signRequest(privateKeyPem, timestamp, method, pathForSign) {
  const message = `${timestamp}${method}${pathForSign}`;
  const sign = crypto.sign('sha256', Buffer.from(message), {
    key: privateKeyPem,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  });
  return sign.toString('base64');
}

function parseUrl(baseUrl, endpointPath, query = {}) {
  const base = baseUrl.replace(/\/$/, '');
  const ep = endpointPath.startsWith('/') ? endpointPath : `/${endpointPath}`;
  const apiPrefix = '/trade-api/v2';

  // Base URL often already includes /trade-api/v2 (see .env KALSHI_API_BASE_URL)
  let urlPath;
  let signPath;
  if (base.endsWith(apiPrefix)) {
    urlPath = ep;
    signPath = `${apiPrefix}${ep}`;
  } else if (ep.startsWith(apiPrefix)) {
    urlPath = ep;
    signPath = ep.split('?')[0];
  } else {
    urlPath = `${apiPrefix}${ep}`;
    signPath = urlPath;
  }

  const searchParams = new URLSearchParams();
  Object.entries(query).forEach(([key, value]) => {
    if (value == null || value === '') return;
    if (Array.isArray(value)) {
      value.filter((item) => item != null && item !== '').forEach((item) => searchParams.append(key, String(item)));
      return;
    }
    searchParams.append(key, String(value));
  });
  const qs = searchParams.toString();
  const url = `${base}${urlPath}${qs ? `?${qs}` : ''}`;
  return { url, signPath };
}

async function kalshiFetch(endpointPath, query = {}, options = {}) {
  const baseUrl = process.env.KALSHI_API_BASE_URL || DEFAULT_BASE;
  const apiKeyId = process.env.KALSHI_API_KEY_ID;
  const privateKeyPem = loadPrivateKey();
  const method = options.method || 'GET';
  const { url, signPath } = parseUrl(baseUrl, endpointPath, query);

  const headers = { Accept: 'application/json' };
  if (apiKeyId && privateKeyPem) {
    const timestamp = String(Date.now());
    headers['KALSHI-ACCESS-KEY'] = apiKeyId;
    headers['KALSHI-ACCESS-TIMESTAMP'] = timestamp;
    headers['KALSHI-ACCESS-SIGNATURE'] = signRequest(privateKeyPem, timestamp, method, signPath);
  }

  const timeoutMs = requestTimeoutMs(options);
  try {
    // The limit covers the whole exchange, body included.
    const res = await fetch(url, { method, headers, signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 429) {
      const err = new Error('Kalshi rate limit (429)');
      err.code = 'RATE_LIMIT';
      throw err;
    }
    if (!res.ok) {
      const body = await res.text();
      const err = new Error(`Kalshi HTTP ${res.status}: ${body.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    return await res.json();
  } catch (error) {
    if (error?.name !== 'TimeoutError') throw error;
    const err = new Error(`Kalshi did not respond within ${timeoutMs / 1000} seconds`);
    err.code = 'KALSHI_TIMEOUT';
    throw err;
  }
}

async function paginateKalshi(endpointPath, query = {}, itemsKey = 'markets', maxPages = 20) {
  const all = [];
  let cursor = null;
  let pages = 0;

  while (pages < maxPages) {
    const q = { ...query, limit: query.limit || 200 };
    if (cursor) q.cursor = cursor;
    const data = await kalshiFetch(endpointPath, q);
    const items = data[itemsKey] || data.events || data.series || [];
    all.push(...items);
    cursor = data.cursor;
    pages += 1;
    if (!cursor || items.length === 0) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  return all;
}

module.exports = { kalshiFetch, paginateKalshi, loadPrivateKey, parseUrl, signRequest };
