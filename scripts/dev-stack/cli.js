#!/usr/bin/env node
/*
 * Local dashboard supervisor.  It intentionally owns only processes started
 * from this repository and never kills an arbitrary listener on a dashboard
 * port.  `start --detach` leaves a small monitor running after the caller
 * exits; the monitor restarts the UI/API with bounded backoff.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const root = path.resolve(__dirname, '../..');
const appSupport = path.join(os.homedir(), 'Library/Application Support/market-dashboard');
const logDir = path.join(os.homedir(), 'Library/Logs/market-dashboard');
const stateFile = path.join(appSupport, 'dev-stack.json');
const isDetach = process.argv.includes('--detach');
const asJson = process.argv.includes('--json');
const command = process.argv[2] || 'start';
const maxLogBytes = 10 * 1024 * 1024;
const services = {
  api: { port: 3001, health: 'http://127.0.0.1:3001/api/health', args: ['server.js'], env: { NODE_ENV: 'development' } },
  ui: { port: 3000, health: 'http://127.0.0.1:3000/', args: [path.join(root, 'node_modules/@craco/craco/dist/bin/craco.js'), 'start'], env: { PORT: '3000', CI: 'true', BROWSER: 'none', GENERATE_SOURCEMAP: 'false', TSC_COMPILE_ON_ERROR: 'true', BROWSERSLIST_IGNORE_OLD_DATA: 'true', NODE_OPTIONS: '--max-old-space-size=3072 --require ./scripts/cra-dev-require-hook.js' } },
  sidecar: { port: 8765, health: 'http://127.0.0.1:8765/livez', shell: true, args: ['scripts/ibkr_sidecar/start.sh'], env: {} },
};

function ensureDirs() { fs.mkdirSync(appSupport, { recursive: true }); fs.mkdirSync(logDir, { recursive: true }); }
function readState() { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return null; } }
function writeState(state) { ensureDirs(); fs.writeFileSync(stateFile, JSON.stringify(state, null, 2)); }
function removeState() { try { fs.unlinkSync(stateFile); } catch {} }
function listenerPid(port) {
  try { return Number(execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }).trim().split(/\s+/)[0]); } catch { return null; }
}
function processCommand(pid) { try { return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim(); } catch { return ''; } }
function isOwned(pid) { const cmd = processCommand(pid); return cmd.includes(root) || cmd.includes('node server.js') || cmd.includes('uvicorn app:app'); }
function isAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function httpOk(url) { try { const response = await fetch(url, { signal: AbortSignal.timeout(1500) }); return response.ok; } catch { return false; } }
function rotate(file) {
  try {
    if (fs.statSync(file).size < maxLogBytes) return;
    for (let n = 4; n >= 1; n--) { const from = `${file}.${n}`; const to = `${file}.${n + 1}`; if (fs.existsSync(from)) fs.renameSync(from, to); }
    fs.renameSync(file, `${file}.1`);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
function streamToLog(stream, file) { stream.on('data', chunk => { rotate(file); fs.appendFileSync(file, chunk); }); }
function childFor(name) {
  const service = services[name];
  const file = path.join(logDir, `${name}.log`);
  const options = { cwd: root, env: { ...process.env, ...service.env }, stdio: ['ignore', 'pipe', 'pipe'] };
  const child = service.shell ? spawn('bash', service.args, options) : spawn(process.execPath, service.args, options);
  streamToLog(child.stdout, file); streamToLog(child.stderr, file);
  return child;
}
function assertPorts() {
  const state = readState();
  for (const [name, service] of Object.entries(services)) {
    const pid = listenerPid(service.port);
    if (!pid) continue;
    if (state?.children?.[name]?.pid === pid || isOwned(pid)) continue;
    throw new Error(`Port ${service.port} is occupied by unknown PID ${pid}: ${processCommand(pid)}`);
  }
}
async function terminate(pid) {
  if (!pid || !isAlive(pid)) return;
  try { process.kill(pid, 'SIGTERM'); } catch { return; }
  for (let n = 0; n < 10 && isAlive(pid); n++) await sleep(1000);
  if (isAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
}
async function stop() {
  const state = readState();
  if (state?.supervisor?.pid && state.supervisor.pid !== process.pid) await terminate(state.supervisor.pid);
  for (const item of Object.values(state?.children || {})) await terminate(item.pid);
  removeState();
  console.log('Dashboard stack stopped.');
}
async function waitFor(name, timeout = 30000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await httpOk(services[name].health)) return true; await sleep(500); }
  return false;
}
async function runMonitor() {
  ensureDirs();
  assertPorts();
  const state = { version: 1, root, startedAt: new Date().toISOString(), supervisor: { pid: process.pid }, children: {} };
  const children = {};
  const histories = {};
  async function startOne(name) {
    const existing = listenerPid(services[name].port);
    if (existing && (isOwned(existing) || readState()?.children?.[name]?.pid === existing)) {
      state.children[name] = { pid: existing, external: true, status: await httpOk(services[name].health) ? 'ready' : 'starting' };
      writeState(state); return;
    }
    const child = childFor(name); children[name] = child;
    state.children[name] = { pid: child.pid, external: false, status: 'starting', restarts: (histories[name] || []).length };
    writeState(state);
    child.on('exit', async (code, signal) => {
      if (state.stopping) return;
      const now = Date.now(); histories[name] = (histories[name] || []).filter(time => now - time < 5 * 60 * 1000);
      histories[name].push(now);
      if (name === 'sidecar' && histories[name].length >= 5) {
        state.children[name] = { ...state.children[name], status: 'degraded', circuitOpenUntil: new Date(now + 5 * 60 * 1000).toISOString() }; writeState(state); return;
      }
      if (name !== 'sidecar' && histories[name].length > 3) { state.stopping = true; writeState(state); await stop(); process.exitCode = 1; return; }
      const delay = Math.min(4000, 1000 * 2 ** (histories[name].length - 1));
      state.children[name] = { ...state.children[name], status: 'restarting', code, signal, retryInMs: delay }; writeState(state);
      await sleep(delay); if (!state.stopping) startOne(name);
    });
  }
  for (const name of ['sidecar', 'api', 'ui']) await startOne(name);
  for (const name of ['api', 'ui']) state.children[name].status = await waitFor(name) ? 'ready' : 'starting';
  if (state.children.sidecar) state.children.sidecar.status = await waitFor('sidecar', 5000) ? 'ready' : 'degraded';
  writeState(state);
  console.log(`Dashboard ${state.children.sidecar.status === 'ready' ? 'READY' : 'DEGRADED: IBKR unavailable'} (UI :3000, API :3001)`);
  const timer = setInterval(async () => {
    for (const [name, child] of Object.entries(children)) {
      if (child.exitCode !== null) continue;
      state.children[name].status = await httpOk(services[name].health) ? 'ready' : 'starting';
    }
    writeState(state);
  }, 5000);
  async function shutdown() { state.stopping = true; clearInterval(timer); for (const child of Object.values(children)) await terminate(child.pid); removeState(); process.exit(0); }
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}
async function start() {
  const current = readState();
  if (current?.supervisor?.pid && isAlive(current.supervisor.pid)) { if (asJson) return doctor(); console.log(`Dashboard supervisor already running (PID ${current.supervisor.pid}).`); return; }
  if (isDetach) {
    ensureDirs();
    const log = path.join(logDir, 'supervisor.log');
    const daemon = spawn(process.execPath, [__filename, 'monitor'], { cwd: root, detached: true, stdio: ['ignore', fs.openSync(log, 'a'), fs.openSync(log, 'a')], env: process.env });
    daemon.unref();
    for (let n = 0; n < 60; n++) { await sleep(500); if ((await httpOk(services.ui.health)) && (await httpOk(services.api.health))) break; }
    if (asJson) return doctor();
    console.log('Dashboard supervisor started in detached mode.');
    return;
  }
  await runMonitor();
}
async function status() {
  const report = await doctorReport();
  if (asJson) { console.log(JSON.stringify(report, null, 2)); process.exitCode = report.ok ? 0 : 1; return; }
  const state = readState();
  const legacy = { state, services: {} };
  for (const [name, value] of Object.entries(report.services)) legacy.services[name] = { pid: value.pid, healthy: value.healthy };
  console.log(JSON.stringify(legacy, null, 2));
  process.exitCode = report.ok ? 0 : 1;
}
async function doctorReport() {
  const state = readState();
  const report = { ok: false, status: 'down', instanceId: state?.startedAt || null, logDir, services: {} };
  for (const [name, service] of Object.entries(services)) {
    const pid = listenerPid(service.port);
    const healthy = await httpOk(service.health);
    const tradingReady = name === 'sidecar' ? await httpOk('http://127.0.0.1:8765/readyz') : healthy;
    report.services[name] = { pid, running: Boolean(pid), healthy, ready: tradingReady, status: tradingReady ? 'ready' : (healthy ? 'degraded' : (pid ? 'starting' : 'down')) };
  }
  report.ok = report.services.ui.healthy && report.services.api.healthy;
  report.status = !report.ok ? 'down' : (report.services.sidecar.ready ? 'ready' : 'degraded');
  return report;
}
async function doctor() {
  const report = await doctorReport();
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.ok ? 0 : 1;
}
async function main() {
  if (command === 'monitor') return runMonitor();
  if (command === 'stop') return stop();
  if (command === 'restart') { await stop(); return start(); }
  if (command === 'status') return status();
  if (command === 'doctor') return doctor();
  if (command === 'start') return start();
  throw new Error(`Unknown command: ${command}`);
}
main().catch(error => { console.error(`Dashboard supervisor: ${error.message}`); process.exit(1); });
