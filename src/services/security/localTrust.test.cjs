const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const express = require('express');
const cors = require('cors');
const { validateLocalRequest, createMessageBudget, createLocalTrustMiddleware } = require('./localTrust.cjs');
const { createApiCorsOptions } = require('../api/corsConfig.cjs');

const request = (headers = {}, socket = {}) => ({
  headers: { host: 'localhost:3001', ...headers },
  socket: { remoteAddress: '127.0.0.1', localPort: 3001, ...socket },
});
test('allows local browser and existing non-browser service clients', () => {
  assert.equal(validateLocalRequest(request({ origin: 'http://localhost:3000' })).ok, true);
  assert.equal(validateLocalRequest(request({ origin: 'http://localhost:3000', 'sec-fetch-site': 'same-site' })).ok, true);
  assert.equal(validateLocalRequest(request()).ok, true);
  assert.equal(validateLocalRequest(request({ 'sec-fetch-mode': 'cors' })).ok, true);
});
test('allows known browser origins across the exact localhost/127.0.0.1 alias pair for reads and preflight', () => {
  for (const method of ['GET', 'OPTIONS']) {
    for (const [origin, host] of [
      ['http://localhost:3000', '127.0.0.1:3001'],
      ['http://127.0.0.1:3000', 'localhost:3001'],
    ]) {
      const headers = { origin, host, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors',
        ...(method === 'OPTIONS' ? { 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } : {}) };
      assert.equal(validateLocalRequest({ ...request(headers), method }).ok, true, JSON.stringify({ method, headers }));
      assert.equal(validateLocalRequest({ ...request(headers), method }, { allowedOrigins: [] }).ok, false);
    }
  }
});
test('alias requests still reject foreign/absent origins, inconsistent same-host metadata and wrong ports', () => {
  for (const method of ['GET', 'OPTIONS']) {
    for (const headers of [
      { host: '127.0.0.1:3001' },
      { host: '127.0.0.1:3001', origin: 'http://foreign.example' },
      { host: '127.0.0.1:3001', origin: 'http://localhost:3000.evil' },
      { host: 'localhost:3001', origin: 'http://localhost:3000' },
      { host: '127.0.0.1:3001', origin: 'http://127.0.0.1:3000' },
      { host: '127.0.0.1:3000', origin: 'http://localhost:3000' },
      { host: '127.1:3001', origin: 'http://localhost:3000' },
      { host: 'localhost:3001', origin: 'http://127.1:3000' },
    ]) assert.equal(validateLocalRequest({ ...request({ ...headers, 'sec-fetch-site': 'cross-site' }), method }).ok, false, JSON.stringify({ method, headers }));
    assert.equal(validateLocalRequest({ ...request({ host: '127.0.0.1:3001', origin: 'http://localhost:3000', 'sec-fetch-site': 'cross-site' },
      { remoteAddress: '192.168.1.2' }), method }).ok, false);
  }
});
test('trusted alias GET and preflight retain the existing CORS response while foreign and absent origins do not', async t => {
  const app = express();
  app.use(createLocalTrustMiddleware());
  app.use(cors(createApiCorsOptions({ nodeEnv: 'development' })));
  app.get('/api/analyst/probe', (_req, res) => res.json({ ok: true }));
  const server = await new Promise(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const read = (method, hostname, origin) => new Promise((resolve, reject) => {
    const call = http.request({ host: '127.0.0.1', port, path: '/api/analyst/probe', method,
      headers: { Host: `${hostname}:${port}`, 'Sec-Fetch-Site': 'cross-site',
        ...(origin ? { Origin: origin } : {}),
        ...(method === 'OPTIONS' ? { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } : {}) } }, response => {
      response.resume();
      response.on('end', () => resolve(response));
    });
    call.on('error', reject);
    call.end();
  });
  for (const method of ['GET', 'OPTIONS']) {
    for (const [hostname, origin] of [['127.0.0.1', 'http://localhost:3000'], ['localhost', 'http://127.0.0.1:3000']]) {
      const accepted = await read(method, hostname, origin);
      assert.equal(accepted.statusCode, method === 'OPTIONS' ? 204 : 200);
      assert.equal(accepted.headers['access-control-allow-origin'], origin);
      for (const deniedOrigin of [undefined, 'http://foreign.example']) {
        const rejected = await read(method, hostname, deniedOrigin);
        assert.equal(rejected.statusCode, 403);
        assert.equal(rejected.headers['access-control-allow-origin'], undefined);
      }
    }
  }
});
test('rejects foreign origins, DNS rebinding, malformed hosts and LAN clients', () => {
  for (const headers of [
    { origin: 'http://untrusted.example' }, { origin: 'null' },
    { origin: 'http://localhost:3000.evil' }, { origin: 'http://localhost:3000/path' },
    { host: 'untrusted.example:3001' }, { host: 'localhost:3000' },
    { host: 'localhost.:3001' }, { host: 'localhost:3001@untrusted.example' },
    { host: '127.1:3001' }, { host: '0x7f000001:3001' }, { host: '%6cocalhost:3001' },
    { host: '127.0.0.1:3001,localhost:3001' }, { 'sec-fetch-site': 'cross-site' },
    { origin: 'http://localhost:3000', 'sec-fetch-site': 'cross-site' },
  ]) assert.equal(validateLocalRequest(request(headers)).ok, false, JSON.stringify(headers));
  assert.equal(validateLocalRequest(request({ 'x-forwarded-for': '127.0.0.1' }, { remoteAddress: '192.168.1.2' })).ok, false);
  assert.equal(validateLocalRequest({ ...request(), rawHeaders: ['Host', 'localhost:3001', 'Host', 'localhost:3001'] }).ok, false);
  assert.equal(validateLocalRequest({ ...request({ origin: 'http://localhost:3000' }), rawHeaders: ['Host', 'localhost:3001', 'Origin', 'http://localhost:3000', 'Origin', 'http://localhost:3000'] }).ok, false);
});
test('bounds message bursts and resets only after the configured window', () => {
  let now = 0;
  const admit = createMessageBudget({ limit: 2, windowMs: 100, now: () => now });
  assert.equal(admit(), true); assert.equal(admit(), true); assert.equal(admit(), false);
  now = 100; assert.equal(admit(), true);
});
