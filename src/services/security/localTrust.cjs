'use strict';

// This app trusts processes on this computer, not arbitrary websites or LAN
// clients. CORS alone is not an authorization boundary (including for WS).
const LOCAL_BROWSER_ORIGINS = Object.freeze([
  'http://localhost:3000', 'http://127.0.0.1:3000',
  'http://localhost:3001', 'http://127.0.0.1:3001',
]);
const LOCAL_HOST_PATTERN = /^(localhost|127\.0\.0\.1|\[::1\])(?::([0-9]{1,5}))?$/i;

function isLoopbackAddress(address) {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(String(address || '').toLowerCase());
}

function denied(errorCode) { return { ok: false, statusCode: 403, errorCode }; }

function validateLocalRequest(request, { allowedOrigins = LOCAL_BROWSER_ORIGINS, port } = {}) {
  if (!isLoopbackAddress(request.socket?.remoteAddress)) return denied('LOCAL_CLIENT_REQUIRED');
  const headers = request.headers || {};
  const host = headers.host;
  if (typeof host !== 'string' || /[\s,@/\\?#]/.test(host)) return denied('LOCAL_HOST_REQUIRED');
  if (Array.isArray(request.rawHeaders)) {
    const names = request.rawHeaders.filter((_, index) => index % 2 === 0).map(value => String(value).toLowerCase());
    if (names.filter(name => name === 'host').length !== 1) return denied('LOCAL_HOST_REQUIRED');
    if (names.filter(name => name === 'origin').length > 1) return denied('LOCAL_ORIGIN_REQUIRED');
  }
  // Match the supplied authority itself. URL parsing canonicalizes alternate
  // numeric forms such as 127.1 and 0x7f000001 into an allowed address.
  const authority = LOCAL_HOST_PATTERN.exec(host);
  const expectedPort = Number(port || request.socket?.localPort);
  if (!authority || !Number.isInteger(expectedPort)
      || Number(authority[2] || 80) !== expectedPort) return denied('LOCAL_HOST_REQUIRED');

  const origin = headers.origin;
  if (origin !== undefined) {
    if (typeof origin !== 'string' || !allowedOrigins.includes(origin)) return denied('LOCAL_ORIGIN_REQUIRED');
  }
  if (String(headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') {
    // Browsers classify localhost and 127.0.0.1 as different sites even though
    // both reach this loopback listener. Only that exact alias pair can use an
    // Origin already admitted above; missing, foreign and same-host cross-site
    // metadata still fails the local boundary.
    const source = typeof origin === 'string' && /^https?:\/\/(localhost|127\.0\.0\.1)(?::[0-9]{1,5})?$/i.exec(origin);
    const sourceHost = source && source[1].toLowerCase();
    const targetHost = authority[1].toLowerCase();
    const trustedAlias = sourceHost === 'localhost' && targetHost === '127.0.0.1'
      || sourceHost === '127.0.0.1' && targetHost === 'localhost';
    if (!trustedAlias) return denied('LOCAL_ORIGIN_REQUIRED');
  }
  return { ok: true };
}

function createLocalTrustMiddleware(options = {}) {
  return (req, res, next) => {
    const result = validateLocalRequest(req, options);
    if (!result.ok) {
      res.removeHeader('Access-Control-Allow-Origin');
      res.setHeader('Cache-Control', 'no-store');
      return res.status(result.statusCode).json({ error: 'This endpoint is available only to the local dashboard.', errorCode: result.errorCode });
    }
    return next();
  };
}

function rejectWebSocketUpgrade(socket, statusCode = 403) {
  socket.end(`HTTP/1.1 ${statusCode} ${statusCode === 429 ? 'Too Many Requests' : 'Forbidden'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function createMessageBudget({ limit = 60, windowMs = 10_000, now = Date.now } = {}) {
  let startedAt = now();
  let count = 0;
  return () => {
    const current = now();
    if (current - startedAt >= windowMs) { startedAt = current; count = 0; }
    count += 1;
    return count <= limit;
  };
}

module.exports = { LOCAL_BROWSER_ORIGINS, isLoopbackAddress, validateLocalRequest, createLocalTrustMiddleware, rejectWebSocketUpgrade, createMessageBudget };
