import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';
import { WebSocket, WebSocketServer } from 'ws';
import dashboardConfig from '../../vite.config.mjs';
import localTrust from '../../src/services/security/localTrust.cjs';

function get(port, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port, path: pathname, headers }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() }));
    });
    request.on('error', reject);
    request.setTimeout(5000, () => request.destroy(new Error('HTTP probe timed out')));
  });
}

function upgrade(port, headers, { pathname = '/ws/market-data', protocol } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${pathname}`, protocol || [], { headers, handshakeTimeout: 5000 });
    ws.on('open', () => { ws.close(); resolve(101); });
    ws.on('unexpected-response', (_req, response) => { response.resume(); ws.terminate(); resolve(response.statusCode); });
    // terminate after a rejected handshake also emits an error.
    ws.on('error', reject);
  });
}

test('real Vite HTTP and WS proxy preserve Origin and deny hostile authorities before reaching API handlers', { timeout: 30_000 }, async t => {
  const received = [];
  const api = http.createServer((req, res) => {
    const verdict = localTrust.validateLocalRequest(req);
    if (!verdict.ok) { res.writeHead(403).end(); return; }
    received.push({ origin: req.headers.origin, host: req.headers.host, kind: 'http' });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
  });
  const sockets = new WebSocketServer({ noServer: true });
  api.on('upgrade', (req, socket, head) => {
    if (!localTrust.validateLocalRequest(req).ok) return localTrust.rejectWebSocketUpgrade(socket);
    received.push({ origin: req.headers.origin, host: req.headers.host, kind: 'ws' });
    sockets.handleUpgrade(req, socket, head, client => client.on('error', () => {}));
  });
  api.listen(0, '127.0.0.1');
  await once(api, 'listening');
  const apiPort = api.address().port;
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'dashboard-vite-test-'));
  const config = dashboardConfig({ mode: 'test', command: 'serve' });
  const proxy = Object.fromEntries(Object.entries(config.server.proxy).map(([prefix, options]) => [prefix, { ...options, target: `http://127.0.0.1:${apiPort}` }]));
  const vite = await createServer({ ...config, configFile: false, cacheDir, logLevel: 'silent',
    optimizeDeps: { noDiscovery: true, include: [] }, server: { ...config.server, port: 0, proxy } });
  t.after(async () => {
    await vite.close();
    for (const client of sockets.clients) client.terminate();
    sockets.close();
    api.closeAllConnections();
    await new Promise(resolve => api.close(resolve));
    await rm(cacheDir, { recursive: true, force: true });
  });
  await vite.listen();
  const uiPort = vite.httpServer.address().port;
  const allowedOrigin = 'http://localhost:3000';
  let hmrConnections = 0;
  vite.ws.on('connection', () => { hmrConnections += 1; });

  for (const port of [apiPort, uiPort]) {
    const result = await get(port, '/api/health', { Origin: allowedOrigin });
    assert.equal(result.status, 200);
    assert.notEqual(result.headers['access-control-allow-origin'], '*');
    assert.equal((await get(port, '/api/health')).status, 200, 'local CLI remains supported');
    for (const headers of [
      { Origin: 'https://attacker.example' }, { Origin: 'null' },
      { Host: `attacker.example:${port}`, 'X-Forwarded-Host': `localhost:${port}`, 'X-Forwarded-For': '127.0.0.1' },
      { Host: `127.1:${port}` }, { 'Sec-Fetch-Site': 'cross-site' },
      { Origin: allowedOrigin, 'Sec-Fetch-Site': 'cross-site' },
    ]) {
      const before = received.length;
      assert.equal((await get(port, '/api/health', headers)).status, 403);
      assert.equal(received.length, before, 'rejected requests cannot reach a route handler');
      assert.equal(await upgrade(port, headers), 403);
      assert.equal(received.length, before, 'rejected upgrades cannot reach an upstream listener');
      if (port === uiPort) {
        for (const protocol of ['vite-ping', 'vite-hmr']) {
          assert.equal(await upgrade(port, headers, {
            pathname: `/?token=${vite.config.webSocketToken}`, protocol,
          }), 403);
          assert.equal(hmrConnections, 0, 'rejected upgrades cannot reach HMR even with a valid token');
        }
      }
    }
    assert.equal(await upgrade(port, { Origin: allowedOrigin }), 101);
  }
  assert.equal(received.filter(item => item.origin === allowedOrigin).length, 4);
  assert.ok(received.every(item => item.host === `127.0.0.1:${apiPort}`));
  assert.equal(await upgrade(uiPort, { Origin: allowedOrigin }, {
    pathname: `/?token=${vite.config.webSocketToken}`, protocol: 'vite-hmr',
  }), 101, 'the trusted dashboard retains live reload');
  assert.equal(hmrConnections, 1);
  assert.equal((await get(uiPort, '/.env')).status, 403);
  assert.equal((await get(uiPort, '/api/health', { Origin: 'http://localhost:3000.evil.example' })).status, 403);
});
