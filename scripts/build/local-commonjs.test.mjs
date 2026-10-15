import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { localCommonjs } from './local-commonjs.mjs';
import { createServer } from 'vite';
import { WebSocket } from 'ws';
import { once } from 'node:events';

const root = path.resolve(import.meta.dirname, '../..');
test('browser transform preserves shared calculations and named/default export identity', async () => {
  const plugin = localCommonjs(root);
  const id = path.join(root, 'src/constants/expectedValuesData.js');
  const result = plugin.transform(fs.readFileSync(id, 'utf8'), id);
  const module = await import(`data:text/javascript;base64,${Buffer.from(result.code).toString('base64')}`);
  assert.equal(module.default.quadData, module.quadData);
  assert.equal(module.getExpectedValueForTicker('SPY'), module.default.getExpectedValueForTicker('SPY'));
});
test('shared CommonJS transforms are ESM in production and dev without changing Node sources', () => {
  const plugin = localCommonjs(root);
  const source = path.join(root, 'src/utils/researchBias.cjs');
  const virtual = plugin.resolveId('../utils/researchBias.cjs', path.join(root, 'src/components/example.jsx'));
  assert.equal(virtual, `${source}.browser.mjs`);
  const watched = [];
  const original = plugin.load.call({ addWatchFile: (value) => watched.push(value) }, virtual);
  const result = plugin.transform(original, virtual);
  assert.match(result.code, /export default/);
  assert.doesNotMatch(result.code, /module\.exports\s*=/);
  assert.deepEqual(watched, [source]);
  const module = {};
  assert.deepEqual(plugin.handleHotUpdate({ file: source, modules: [], server: { moduleGraph: { getModuleById: () => module } } }), [module]);
  assert.equal(fs.readFileSync(source, 'utf8'), original);
});
test('browser bridge rejects dynamic requires and skips dependencies outside source', () => {
  const plugin = localCommonjs(root);
  assert.throws(() => plugin.transform('const a = require(target);', path.join(root, 'src/dynamic.js')), /static relative requires/);
  assert.equal(plugin.transform('module.exports = {}', path.join(os.tmpdir(), 'node_modules/test.cjs')), null);
});

test('unsupported CommonJS aliases and export forms fail before reaching the browser', () => {
  const plugin = localCommonjs(root);
  const filename = path.join(root, 'src/unsupported.cjs');
  for (const code of [
    'exports.value = 1;', 'module["exports"] = { value: 1 };',
    'const loader = require; loader("./module.cjs");', 'require.resolve("./module.cjs");',
  ]) assert.throws(() => plugin.transform(code, filename), /Unsupported CommonJS reference/);
  assert.doesNotThrow(() => plugin.transform('function example(module) { return module.value; }', filename));
});

test('editing an actual watched CommonJS dependency sends HMR and serves the new calculation', { timeout: 30_000 }, async t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-shared-hmr-'));
  fs.mkdirSync(path.join(fixture, 'src'));
  const shared = path.join(fixture, 'src/calculation.cjs');
  fs.writeFileSync(shared, 'module.exports = { value: 1 };');
  fs.writeFileSync(path.join(fixture, 'src/main.js'), 'import { value } from "./calculation.cjs"; export { value }; if (import.meta.hot) import.meta.hot.accept("./calculation.cjs", () => {});');
  const server = await createServer({ root: fixture, configFile: false, logLevel: 'silent',
    plugins: [localCommonjs(fixture)], optimizeDeps: { noDiscovery: true, include: [] },
    // Poll so the test exercises the CommonJS HMR wiring, not the host's file-event
    // service (directory fs.watch events are not delivered on this macOS host).
    server: { host: '127.0.0.1', port: 0, strictPort: true, cors: false, watch: { usePolling: true, interval: 50 } },
  });
  let socket;
  t.after(async () => { socket?.terminate(); await server.close(); fs.rmSync(fixture, { recursive: true, force: true }); });
  await server.listen();
  const entry = await server.transformRequest('/src/main.js');
  const sharedUrl = entry.code.match(/from "([^"]*calculation[^"]*)"/)[1];
  const before = await server.transformRequest(sharedUrl);
  assert.match(before.code, /value: 1/);
  socket = new WebSocket(`ws://127.0.0.1:${server.httpServer.address().port}/`, 'vite-hmr');
  await once(socket, 'open');
  const updated = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CommonJS HMR update timed out')), 10_000);
    socket.on('message', raw => {
      const message = JSON.parse(String(raw));
      if (message.type === 'update') { clearTimeout(timer); resolve(message); }
    });
  });
  fs.writeFileSync(shared, 'module.exports = { value: 2 };');
  const message = await updated;
  assert.ok(message.updates.some(update => update.acceptedPath.includes('calculation.cjs.browser.mjs')));
  const after = await server.transformRequest(sharedUrl);
  assert.match(after.code, /value: 2/);
});
