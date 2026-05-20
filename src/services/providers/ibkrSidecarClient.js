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
      const err = new Error(`IBKR sidecar HTTP ${res.status}: ${text.slice(0, 150)}`);
      err.status = res.status;
      throw err;
    }
    return text ? JSON.parse(text) : {};
  } catch (err) {
    if (err.name === 'AbortError') {
      const timeoutErr = new Error(
        `IBKR sidecar timed out after ${options.timeoutMs || SIDECAR_TIMEOUT_MS}ms`,
      );
      timeoutErr.reason = 'sidecar_offline';
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

module.exports = { sidecarRequest, SIDECAR_BASE, SIDECAR_TIMEOUT_MS };
