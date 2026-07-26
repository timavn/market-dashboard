const { URL } = require('url');

const SIDECAR_BASE = process.env.IBKR_SIDECAR_URL || 'http://localhost:8765';
const SIDECAR_TIMEOUT_MS = Number(process.env.IBKR_SIDECAR_TIMEOUT_MS || 5000);

async function sidecarRequest(path, options = {}) {
  const base = SIDECAR_BASE.replace(/\/$/, '');
  const fullUrl = `${base}${path.startsWith('/') ? path : `/${path}`}`;
  const url = new URL(fullUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || SIDECAR_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: options.method || 'GET',
      headers: {
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });

    const text = await res.text();
    if (!res.ok) {
      let errorCode = null;
      try {
        const payload = text ? JSON.parse(text) : null;
        errorCode =
          typeof payload?.errorCode === 'string'
            ? payload.errorCode
            : null;
      } catch (_error) {
        errorCode = null;
      }
      const err = new Error(`IBKR sidecar HTTP ${res.status}`);
      err.status = res.status;
      err.sidecarCode = errorCode;
      throw err;
    }
    return text ? JSON.parse(text) : {};
  } catch (err) {
    if (err.name === 'AbortError') {
      const timeoutErr = new Error(
        `IBKR sidecar timed out after ${options.timeoutMs || SIDECAR_TIMEOUT_MS}ms`,
      );
      timeoutErr.reason = 'sidecar_timeout';
      throw timeoutErr;
    }
    if (/ECONNREFUSED|fetch failed|ENOTFOUND|connect/i.test(err.message)) {
      err.reason = 'sidecar_offline';
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

function isSidecarOfflineError(err) {
  return err?.reason === 'sidecar_offline';
}

function isSidecarTimeoutError(err) {
  return err?.reason === 'sidecar_timeout' || /timed out/i.test(err?.message || '');
}

async function getSidecarProviderStatus(name = 'ibkr') {
  let livez = null;
  try {
    livez = await sidecarRequest('/livez', { timeoutMs: 1500 });
  } catch (err) {
    const status = isSidecarTimeoutError(err) ? 'sidecar_unresponsive' : 'sidecar_offline';
    return {
      name,
      connected: false,
      status,
      message: status === 'sidecar_unresponsive'
        ? 'IBKR sidecar is listening but not responding; restart the existing sidecar process'
        : err.message,
      accounts: [],
      sidecar: null,
    };
  }

  try {
    const status = await sidecarRequest('/status', { timeoutMs: 5000 });
    return {
      name,
      connected: Boolean(status.connected),
      status: status.status,
      accounts: status.accounts || [],
      message: status.message,
      sidecar: livez,
      gateway: {
        host: status.host,
        port: status.port,
        clientId: status.client_id,
      },
    };
  } catch (err) {
    return {
      name,
      connected: false,
      status: isSidecarOfflineError(err) ? 'sidecar_offline' : 'sidecar_unresponsive',
      message: isSidecarOfflineError(err)
        ? err.message
        : 'IBKR sidecar is alive but Gateway status did not respond; restart the existing sidecar process',
      accounts: [],
      sidecar: livez,
    };
  }
}

module.exports = {
  sidecarRequest,
  getSidecarProviderStatus,
  SIDECAR_BASE,
  SIDECAR_TIMEOUT_MS,
};
