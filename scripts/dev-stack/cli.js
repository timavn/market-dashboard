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
const { buildSystemReadiness } = require('../../src/utils/systemReadiness.cjs');
const { computeRuntimeFingerprint } = require('../../src/utils/runtimeFingerprint.cjs');

const root = path.resolve(__dirname, '../..');
const appSupport = path.join(os.homedir(), 'Library/Application Support/market-dashboard');
const logDir = path.join(os.homedir(), 'Library/Logs/market-dashboard');
const stateFile = path.join(appSupport, 'dev-stack.json');
const launchAgentLabel = 'com.market-dashboard.stack';
const launchAgentPlist = path.join(os.homedir(), 'Library/LaunchAgents', `${launchAgentLabel}.plist`);
const isDetach = process.argv.includes('--detach');
const asJson = process.argv.includes('--json');
const checkOnly = process.argv.includes('--check-only');
const command = process.argv[2] || 'start';
const maxLogBytes = 10 * 1024 * 1024;
const readinessBaseUrl = String(
  process.env.MARKET_DASHBOARD_API_URL || process.env.REACT_APP_BACKEND_URL || 'http://127.0.0.1:3001',
).replace(/\/$/, '');
const readinessUrl = `${readinessBaseUrl}/api/system-readiness?refresh=1`;
const readinessTimeoutMs = Math.max(1_000, Number(process.env.MARKET_DASHBOARD_READINESS_TIMEOUT_MS) || 35_000);
const morningStartTimeoutMs = Math.max(5_000, Number(process.env.MARKET_DASHBOARD_START_TIMEOUT_MS) || 60_000);
const bridgeHeartbeatMaxAgeMs = Math.max(
  90_000,
  Number(process.env.HERMES_BRIDGE_HEARTBEAT_MAX_AGE_MS) || 180_000,
);
const monitorIntervalMs = Math.max(1_000, Number(process.env.MARKET_DASHBOARD_MONITOR_INTERVAL_MS) || 5_000);
const healthFailureThreshold = Math.max(2, Number(process.env.MARKET_DASHBOARD_HEALTH_FAILURE_THRESHOLD) || 3);
const restartWindowMs = 5 * 60 * 1000;
const circuitOpenMs = 5 * 60 * 1000;
const expectedCapabilityIds = Object.freeze([
  'automation.hermes',
  'dashboard.core',
  'portfolio.live',
  'prediction.display',
  'prediction.ibkrExecution',
  'research.current',
]);
const services = {
  api: { port: 3001, health: 'http://127.0.0.1:3001/api/health', args: ['server.js'], env: { NODE_ENV: 'development' }, critical: true },
  ui: { port: 3000, health: 'http://127.0.0.1:3000/', args: [path.join(root, 'node_modules/@craco/craco/dist/bin/craco.js'), 'start'], env: { PORT: '3000', CI: 'true', BROWSER: 'none', GENERATE_SOURCEMAP: 'false', TSC_COMPILE_ON_ERROR: 'true', BROWSERSLIST_IGNORE_OLD_DATA: 'true', NODE_OPTIONS: '--max-old-space-size=3072 --require ./scripts/cra-dev-require-hook.js' }, critical: true },
  sidecar: { port: 8765, health: 'http://127.0.0.1:8765/livez', shell: true, args: ['scripts/ibkr_sidecar/start.sh'], env: {}, critical: false },
  bridge: {
    processOnly: true,
    args: [path.join(root, 'scripts/ops/hermes_snapshot_bridge.js')],
    env: {},
    critical: false,
    heartbeatMaxAgeMs: bridgeHeartbeatMaxAgeMs,
  },
};

function ensureDirs() { fs.mkdirSync(appSupport, { recursive: true }); fs.mkdirSync(logDir, { recursive: true }); }
function readState() { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return null; } }
function writeState(state) { ensureDirs(); fs.writeFileSync(stateFile, JSON.stringify(state, null, 2)); }
function removeState() { try { fs.unlinkSync(stateFile); } catch {} }
function launchAgentDomain() {
  return typeof process.getuid === 'function' ? `gui/${process.getuid()}/${launchAgentLabel}` : null;
}
function launchAgentIsLoaded() {
  const domain = launchAgentDomain();
  if (!domain || !fs.existsSync(launchAgentPlist)) return false;
  try {
    execFileSync('launchctl', ['print', domain], { stdio: 'ignore', timeout: 2_000 });
    return true;
  } catch {
    return false;
  }
}
function listenerPid(port) {
  try { return Number(execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }).trim().split(/\s+/)[0]); } catch { return null; }
}
function processCommand(pid) { try { return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim(); } catch { return ''; } }
function processCwd(pid) {
  try { return fs.readlinkSync(`/proc/${pid}/cwd`); } catch {}
  try {
    return execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' })
      .split(/\r?\n/)
      .find(line => line.startsWith('n'))
      ?.slice(1) || '';
  } catch { return ''; }
}
function pathIsInRoot(candidate) {
  if (!candidate) return false;
  const relative = path.relative(root, path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
function hasExpectedDashboardSignature(commandText, cwd) {
  const cmd = String(commandText || '');
  const tokens = cmd.split(/\s+/).filter(Boolean);
  const resolvedCwd = cwd ? path.resolve(cwd) : '';
  const cliPath = path.join(root, 'scripts/dev-stack/cli.js');
  const sidecarDir = path.join(root, 'scripts/ibkr_sidecar');
  const sidecarStart = path.join(root, 'scripts/ibkr_sidecar/start.sh');
  const hermesBridge = path.join(root, 'scripts/ops/hermes_snapshot_bridge.js');
  const cracoRoot = `${path.join(root, 'node_modules/@craco/craco')}${path.sep}`;

  const supervisorCommand = tokens.includes(cliPath)
    || (resolvedCwd === root && tokens.includes('scripts/dev-stack/cli.js'));
  if (supervisorCommand && ['start', 'restart', 'monitor'].some(token => tokens.includes(token))) return true;
  if (resolvedCwd === root && (tokens.includes('server.js') || tokens.includes(path.join(root, 'server.js')))) return true;
  if (resolvedCwd === root && tokens.includes(hermesBridge)) return true;
  if (tokens.some(token => token.startsWith(cracoRoot))
      && (tokens.includes('start') || tokens.some(token => token.endsWith('/start.js')))) return true;
  if (resolvedCwd === sidecarDir && cmd.includes('uvicorn') && tokens.includes('app:app')) return true;
  if ((resolvedCwd === root || resolvedCwd === sidecarDir)
      && (tokens.includes('scripts/ibkr_sidecar/start.sh') || tokens.includes(sidecarStart))) return true;
  return false;
}
function isOwned(pid) {
  const cwd = processCwd(pid);
  const cmd = processCommand(pid);
  return pathIsInRoot(cwd) && hasExpectedDashboardSignature(cmd, cwd);
}
function isAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function restartPolicyFor({ history = [], now = Date.now(), critical = false, countFailure = true } = {}) {
  const recent = history.filter((time) => Number.isFinite(time) && now - time < restartWindowMs);
  if (countFailure) recent.push(now);
  if (critical && recent.length > 3) {
    return { history: recent, fatal: true, circuitOpenUntil: null, delayMs: null };
  }
  if (!critical && recent.length >= 5) {
    return {
      history: recent,
      fatal: false,
      circuitOpenUntil: new Date(now + circuitOpenMs).toISOString(),
      delayMs: null,
    };
  }
  return {
    history: recent,
    fatal: false,
    circuitOpenUntil: null,
    delayMs: Math.min(4_000, 1_000 * 2 ** Math.max(0, recent.length - 1)),
  };
}
async function httpOk(url) { try { const response = await fetch(url, { signal: AbortSignal.timeout(1500) }); return response.ok; } catch { return false; } }
function heartbeatAgeMs(value, now = Date.now()) {
  const observedAt = Date.parse(String(value || ''));
  return Number.isFinite(observedAt) ? Math.max(0, now - observedAt) : null;
}
function processServiceStatus(name, item, now = Date.now()) {
  const service = services[name];
  const pid = Number(item?.pid) || null;
  const running = Boolean(pid && isAlive(pid));
  const owned = Boolean(running && isOwned(pid));
  const age = heartbeatAgeMs(item?.lastHeartbeatAt, now);
  const fresh = age != null && age <= service.heartbeatMaxAgeMs;
  let status = 'down';
  if (running && !owned) status = 'blocked';
  else if (running && !item?.lastHeartbeatAt) status = 'starting';
  else if (running && (!fresh || item?.lastResultStatus !== 'ready')) status = 'degraded';
  else if (running) status = 'ready';
  return {
    pid,
    running,
    owned,
    healthy: status === 'ready',
    ready: status === 'ready',
    status,
    lastHeartbeatAt: item?.lastHeartbeatAt || null,
    heartbeatAgeMs: age,
    lastResultStatus: item?.lastResultStatus || null,
    lastErrorCode: item?.lastErrorCode || null,
    lastSuccessAt: item?.lastSuccessAt || null,
  };
}
function rotate(file) {
  try {
    if (fs.statSync(file).size < maxLogBytes) return;
    for (let n = 4; n >= 1; n--) { const from = `${file}.${n}`; const to = `${file}.${n + 1}`; if (fs.existsSync(from)) fs.renameSync(from, to); }
    fs.renameSync(file, `${file}.1`);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
function streamToLog(stream, file, onActivity) {
  stream.on('data', chunk => {
    rotate(file);
    fs.appendFileSync(file, chunk);
    onActivity?.(chunk);
  });
}
function childFor(name, onActivity) {
  const service = services[name];
  const file = path.join(logDir, `${name}.log`);
  const options = { cwd: root, env: { ...process.env, ...service.env }, stdio: ['ignore', 'pipe', 'pipe'] };
  const child = service.shell ? spawn('bash', service.args, options) : spawn(process.execPath, service.args, options);
  streamToLog(child.stdout, file, chunk => onActivity?.('stdout', chunk));
  streamToLog(child.stderr, file, chunk => onActivity?.('stderr', chunk));
  return child;
}
function assertPorts() {
  for (const [name, service] of Object.entries(services)) {
    if (!service.port) continue;
    const pid = listenerPid(service.port);
    if (!pid) continue;
    if (isOwned(pid)) continue;
    throw new Error(`Port ${service.port} is occupied by unknown PID ${pid}: ${processCommand(pid)}`);
  }
}
async function terminate(pid) {
  if (!pid || !isAlive(pid)) return;
  try { process.kill(pid, 'SIGTERM'); } catch { return; }
  for (let n = 0; n < 10 && isAlive(pid); n++) await sleep(1000);
  if (isAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
}
async function stop(options = {}) {
  const quiet = options.quiet === true;
  const state = readState();
  if (state?.supervisor?.pid && state.supervisor.pid !== process.pid) {
    if (isOwned(state.supervisor.pid)) await terminate(state.supervisor.pid);
    else if (isAlive(state.supervisor.pid)) console.warn(`Refusing to stop unknown supervisor PID ${state.supervisor.pid}.`);
  }
  for (const item of Object.values(state?.children || {})) {
    if (isOwned(item.pid)) await terminate(item.pid);
    else if (isAlive(item.pid)) console.warn(`Refusing to stop unknown child PID ${item.pid}.`);
  }
  for (const service of Object.values(services)) {
    if (!service.port) continue;
    const pid = listenerPid(service.port);
    if (!pid) continue;
    if (isOwned(pid)) await terminate(pid);
    else console.warn(`Refusing to stop unknown listener PID ${pid} on port ${service.port}.`);
  }
  removeState();
  if (!quiet) console.log('Dashboard stack stopped.');
}
async function waitFor(name, timeout = 30000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (services[name].processOnly) {
      if (processServiceStatus(name, readState()?.children?.[name]).ready) return true;
    } else if (await httpOk(services[name].health)) return true;
    await sleep(500);
  }
  return false;
}
async function runMonitor() {
  ensureDirs();
  assertPorts();
  const previousState = readState();
  const state = {
    version: 2,
    root,
    startedAt: new Date().toISOString(),
    sourceFingerprint: computeRuntimeFingerprint(root),
    supervisor: { pid: process.pid },
    children: {},
  };
  const children = {};
  const histories = {};
  const restartPending = new Set();
  let timer = null;
  let reconciling = false;

  function recordActivity(name, pid, streamName, chunk) {
    if (!state.children[name] || state.children[name].pid !== pid) return;
    const item = state.children[name];
    if (name === 'bridge') {
      item.lastHeartbeatAt = new Date().toISOString();
      let parsedStatus = false;
      for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) {
        try {
          const payload = JSON.parse(line);
          if (payload?.status) {
            parsedStatus = true;
            item.lastResultStatus = payload.status === 'ready' ? 'ready' : 'error';
            item.lastErrorCode = payload.errorCode || null;
            if (item.lastResultStatus === 'ready') item.lastSuccessAt = item.lastHeartbeatAt;
          }
        } catch {}
      }
      if (streamName === 'stderr' && !parsedStatus && item.lastResultStatus !== 'error') {
        item.lastResultStatus = 'error';
        item.lastErrorCode = 'HERMES_BRIDGE_PROCESS_ERROR';
      }
      item.status = processServiceStatus(name, item).status;
    }
    writeState(state);
  }

  async function startOne(name, { initial = false } = {}) {
    const service = services[name];
    let existing = service.processOnly
      ? Number((initial ? previousState : state)?.children?.[name]?.pid) || null
      : listenerPid(service.port);
    if (existing && !isAlive(existing)) existing = null;
    if (service.processOnly && existing && isOwned(existing)) {
      await terminate(existing);
      existing = null;
    }
    if (existing && isOwned(existing)) {
      state.children[name] = {
        pid: existing,
        external: true,
        status: await httpOk(service.health) ? 'ready' : 'starting',
        startedAt: new Date().toISOString(),
        healthFailures: 0,
        restarts: (histories[name] || []).length,
      };
      writeState(state);
      return;
    }
    if (existing && !isOwned(existing)) {
      state.children[name] = {
        pid: existing,
        external: true,
        status: 'blocked',
        errorCode: 'LOCAL_PORT_OWNERSHIP_CONFLICT',
        healthFailures: 0,
      };
      writeState(state);
      return;
    }
    const child = childFor(name, (streamName, chunk) => recordActivity(name, child.pid, streamName, chunk));
    children[name] = child;
    state.children[name] = {
      pid: child.pid,
      external: false,
      status: 'starting',
      startedAt: new Date().toISOString(),
      healthFailures: 0,
      restarts: (histories[name] || []).length,
      ...(service.processOnly ? { lastHeartbeatAt: null, lastResultStatus: 'starting', lastErrorCode: null } : {}),
    };
    writeState(state);
    child.on('error', (error) => {
      if (state.children[name]?.pid !== child.pid) return;
      state.children[name] = {
        ...state.children[name],
        status: 'degraded',
        errorCode: error.code || 'LOCAL_PROCESS_SPAWN_ERROR',
        error: error.message,
      };
      writeState(state);
    });
    child.on('exit', (code, signal) => {
      if (children[name] === child) delete children[name];
      if (state.stopping || state.children[name]?.pid !== child.pid) return;
      void scheduleRestart(name, { code, signal, reason: 'process-exit' });
    });
  }

  async function terminateOwnedService(name) {
    const service = services[name];
    const pid = service.processOnly
      ? Number(state.children[name]?.pid) || null
      : listenerPid(service.port);
    if (!pid || !isAlive(pid)) return true;
    if (!isOwned(pid)) {
      state.children[name] = {
        ...state.children[name],
        pid,
        status: 'blocked',
        errorCode: 'LOCAL_PORT_OWNERSHIP_CONFLICT',
      };
      writeState(state);
      return false;
    }
    await terminate(pid);
    if (children[name]?.pid === pid) delete children[name];
    return true;
  }

  async function scheduleRestart(name, context = {}) {
    if (state.stopping || restartPending.has(name)) return;
    const service = services[name];
    const circuitUntil = Date.parse(String(state.children[name]?.circuitOpenUntil || ''));
    if (Number.isFinite(circuitUntil) && circuitUntil > Date.now()) return;
    restartPending.add(name);
    try {
      const policy = restartPolicyFor({
        history: histories[name] || [],
        critical: service.critical === true,
        countFailure: context.countFailure !== false,
      });
      histories[name] = policy.history;
      if (policy.fatal) {
        state.children[name] = {
          ...state.children[name],
          status: 'failed',
          errorCode: 'LOCAL_CRITICAL_RESTART_LIMIT',
          code: context.code ?? null,
          signal: context.signal ?? null,
          restartReason: context.reason || null,
        };
        state.stopping = true;
        writeState(state);
        await stop({ quiet: true });
        process.exit(1);
      }
      if (policy.circuitOpenUntil) {
        await terminateOwnedService(name);
        state.children[name] = {
          ...state.children[name],
          status: 'degraded',
          errorCode: 'LOCAL_RESTART_CIRCUIT_OPEN',
          circuitOpenUntil: policy.circuitOpenUntil,
          retryInMs: null,
          restartReason: context.reason || null,
          restarts: policy.history.length,
        };
        writeState(state);
        return;
      }

      state.children[name] = {
        ...state.children[name],
        status: 'restarting',
        errorCode: null,
        circuitOpenUntil: null,
        code: context.code ?? null,
        signal: context.signal ?? null,
        retryInMs: policy.delayMs,
        restartReason: context.reason || null,
        restarts: policy.history.length,
      };
      writeState(state);
      await sleep(policy.delayMs);
      if (state.stopping) return;
      if (!(await terminateOwnedService(name))) return;
      await startOne(name);
    } finally {
      restartPending.delete(name);
    }
  }

  for (const name of ['sidecar', 'api', 'ui', 'bridge']) await startOne(name, { initial: true });
  for (const name of ['api', 'ui']) state.children[name].status = await waitFor(name) ? 'ready' : 'starting';
  if (state.children.sidecar) state.children.sidecar.status = await waitFor('sidecar', 5000) ? 'ready' : 'degraded';
  if (state.children.bridge) state.children.bridge.status = await waitFor('bridge', 5000) ? 'ready' : 'degraded';
  writeState(state);
  const degradedServices = ['sidecar', 'bridge'].filter(name => state.children[name]?.status !== 'ready');
  console.log(`Dashboard ${degradedServices.length === 0 ? 'READY' : `DEGRADED: ${degradedServices.join(', ')} unavailable`} (UI :3000, API :3001)`);
  timer = setInterval(async () => {
    if (reconciling || state.stopping) return;
    reconciling = true;
    try {
      for (const [name, service] of Object.entries(services)) {
        const item = state.children[name];
        if (!item || restartPending.has(name)) continue;
        const circuitUntil = Date.parse(String(item.circuitOpenUntil || ''));
        if (Number.isFinite(circuitUntil) && circuitUntil > Date.now()) {
          item.status = 'degraded';
          continue;
        }
        if (Number.isFinite(circuitUntil) && circuitUntil <= Date.now()) {
          item.circuitOpenUntil = null;
          item.errorCode = null;
          void scheduleRestart(name, { reason: 'circuit-reset', countFailure: false });
          continue;
        }

        if (service.processOnly) {
          const snapshot = processServiceStatus(name, item);
          Object.assign(item, snapshot);
          const startupAge = heartbeatAgeMs(item.startedAt);
          const staleOrDead = !snapshot.running
            || (snapshot.heartbeatAgeMs != null && snapshot.heartbeatAgeMs > service.heartbeatMaxAgeMs)
            || (snapshot.heartbeatAgeMs == null && startupAge != null && startupAge > service.heartbeatMaxAgeMs);
          if (!snapshot.owned && snapshot.running) {
            item.status = 'blocked';
            item.errorCode = 'LOCAL_PORT_OWNERSHIP_CONFLICT';
            continue;
          }
          item.healthFailures = staleOrDead ? Number(item.healthFailures || 0) + 1 : 0;
          if (!staleOrDead) item.lastHealthyAt = new Date().toISOString();
        } else {
          const pid = listenerPid(service.port);
          const owned = Boolean(pid && isOwned(pid));
          const healthy = Boolean(owned && await httpOk(service.health));
          item.pid = pid;
          item.external = children[name]?.pid !== pid;
          if (pid && !owned) {
            item.status = 'blocked';
            item.errorCode = 'LOCAL_PORT_OWNERSHIP_CONFLICT';
            item.healthFailures = 0;
            continue;
          }
          item.status = healthy ? 'ready' : (pid ? 'starting' : 'down');
          item.errorCode = healthy ? null : item.errorCode;
          item.healthFailures = healthy ? 0 : Number(item.healthFailures || 0) + 1;
          if (healthy) item.lastHealthyAt = new Date().toISOString();
        }

        if (item.healthFailures >= healthFailureThreshold) {
          void scheduleRestart(name, { reason: 'health-check-failed' });
        }
      }
      writeState(state);
    } finally {
      reconciling = false;
    }
  }, monitorIntervalMs);
  async function shutdown() {
    if (state.stopping) return;
    state.stopping = true;
    clearInterval(timer);
    for (const [name] of Object.entries(services)) await terminateOwnedService(name);
    removeState();
    process.exit(0);
  }
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}
async function start(options = {}) {
  const detach = options.detach ?? isDetach;
  const json = options.json ?? asJson;
  const quiet = options.quiet ?? false;
  const current = readState();
  if (current?.supervisor?.pid && isAlive(current.supervisor.pid) && isOwned(current.supervisor.pid)) {
    if (json) return doctor();
    if (!quiet) console.log(`Dashboard supervisor already running (PID ${current.supervisor.pid}).`);
    return;
  }
  if (detach) {
    ensureDirs();
    const log = path.join(logDir, 'supervisor.log');
    const daemon = spawn(process.execPath, [__filename, 'monitor'], { cwd: root, detached: true, stdio: ['ignore', fs.openSync(log, 'a'), fs.openSync(log, 'a')], env: process.env });
    daemon.unref();
    for (let n = 0; n < 60; n++) { await sleep(500); if ((await httpOk(services.ui.health)) && (await httpOk(services.api.health))) break; }
    if (json) return doctor();
    if (!quiet) console.log('Dashboard supervisor started in detached mode.');
    return;
  }
  await runMonitor();
}
async function restart(options = {}) {
  const quiet = options.quiet === true;
  if (launchAgentIsLoaded()) {
    execFileSync('launchctl', ['kickstart', '-k', launchAgentDomain()], {
      stdio: quiet ? 'ignore' : 'inherit',
      timeout: 10_000,
    });
    const [apiReady, uiReady] = await Promise.all([
      waitFor('api', morningStartTimeoutMs),
      waitFor('ui', morningStartTimeoutMs),
    ]);
    if (!apiReady || !uiReady) throw new Error('The loaded dashboard LaunchAgent did not restore API/UI health.');
    if (!quiet) console.log('Dashboard stack restarted through the loaded LaunchAgent.');
    return;
  }
  await stop({ quiet });
  return start({ detach: options.detach ?? isDetach, json: options.json ?? asJson, quiet });
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
    if (service.processOnly) {
      report.services[name] = processServiceStatus(name, state?.children?.[name]);
      continue;
    }
    const pid = listenerPid(service.port);
    const owned = Boolean(pid && isOwned(pid));
    const healthy = await httpOk(service.health);
    const tradingReady = name === 'sidecar' ? await httpOk('http://127.0.0.1:8765/readyz') : healthy;
    const status = pid && !owned
      ? 'blocked'
      : (tradingReady ? 'ready' : (healthy ? 'degraded' : (pid ? 'starting' : 'down')));
    report.services[name] = { pid, running: Boolean(pid), owned, healthy, ready: owned && tradingReady, status };
  }
  const ownershipBlocked = Object.entries(report.services)
    .some(([name, service]) => services[name].port && service.running && !service.owned);
  report.ok = report.services.ui.healthy && report.services.ui.owned
    && report.services.api.healthy && report.services.api.owned
    && !ownershipBlocked;
  report.status = !report.ok
    ? 'down'
    : (report.services.sidecar.ready && report.services.bridge.ready ? 'ready' : 'degraded');
  return report;
}

const localServiceLabels = {
  ui: 'Dashboard UI',
  api: 'Express API',
  sidecar: 'IBKR sidecar',
  bridge: 'Hermes snapshot bridge',
};

async function localStackGroup() {
  const state = readState();
  const snapshots = await Promise.all(Object.entries(services).map(async ([name, service]) => {
    const processSnapshot = service.processOnly
      ? processServiceStatus(name, state?.children?.[name])
      : null;
    const pid = service.processOnly ? processSnapshot.pid : listenerPid(service.port);
    const owned = service.processOnly ? processSnapshot.owned : Boolean(pid && isOwned(pid));
    const healthy = service.processOnly ? processSnapshot.healthy : await httpOk(service.health);
    let summary;
    let recovery;

    if (pid && !owned) {
      summary = service.processOnly
        ? `Supervisor state points to unknown bridge PID ${pid}; it will not be adopted or stopped.`
        : `Port ${service.port} is occupied by unknown PID ${pid}; it will not be adopted or stopped.`;
      recovery = {
        kind: 'manual',
        label: service.processOnly
          ? 'Inspect the recorded bridge PID, then restart the repo-owned supervisor if appropriate.'
          : `Inspect the unknown listener on port ${service.port}; stop or reconfigure it manually if appropriate.`,
        ...(service.processOnly ? {} : { command: `lsof -nP -iTCP:${service.port} -sTCP:LISTEN` }),
      };
    } else if (!pid) {
      summary = service.processOnly
        ? 'No repo-owned Hermes snapshot bridge process is recorded.'
        : `Nothing is listening on port ${service.port}.`;
      recovery = {
        kind: 'command',
        label: 'Start the missing repo-owned dashboard services and rerun all checks.',
        command: 'npm run morning',
      };
    } else if (!healthy) {
      summary = service.processOnly
        ? `Repo-owned bridge PID ${pid} is not publishing a fresh successful heartbeat.`
        : `Repo-owned PID ${pid} is listening on port ${service.port}, but its health check failed.`;
      recovery = {
        kind: service.processOnly ? 'manual' : 'command',
        label: 'Restart the repo-owned local stack, then rerun the morning checklist.',
        command: 'npm run dev:restart',
      };
    } else {
      summary = service.processOnly
        ? `Publishing outbound snapshots from repo-owned PID ${pid}.`
        : `Healthy on port ${service.port} (PID ${pid}).`;
      recovery = null;
    }

    return {
      id: `local-${name}`,
      label: localServiceLabels[name],
      status: pid && owned && healthy ? 'pass' : 'fail',
      blocking: true,
      summary,
      errorCode: pid && owned && healthy
        ? null
        : (pid && !owned
          ? 'LOCAL_PORT_OWNERSHIP_CONFLICT'
          : (!pid ? `LOCAL_${name.toUpperCase()}_NOT_RUNNING` : `LOCAL_${name.toUpperCase()}_UNHEALTHY`)),
      detail: service.processOnly
        ? `Heartbeat ${processSnapshot.lastHeartbeatAt || 'unavailable'}; latest result ${processSnapshot.lastResultStatus || 'unknown'}${processSnapshot.lastErrorCode ? ` (${processSnapshot.lastErrorCode})` : ''}.`
        : service.health,
      observedAt: new Date().toISOString(),
      ageSeconds: 0,
      impact: service.processOnly
        ? 'Hermes cannot receive a current outbound portfolio snapshot while the bridge is unhealthy.'
        : `${localServiceLabels[name]} is required for the local dashboard stack.`,
      recovery,
      provenance: {
        source: 'morning-cli',
        repositoryRoot: root,
        healthUrl: service.health || null,
        healthMode: service.processOnly ? 'process-heartbeat' : 'http',
      },
      local: {
        name,
        port: service.port || null,
        pid,
        owned,
        healthy,
        ...(processSnapshot || {}),
      },
    };
  }));

  return { id: 'local-stack', label: 'Local stack', checks: snapshots };
}

function validateSystemReadinessReport(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    throw new Error('Readiness response is not a JSON object.');
  }
  if (report.version !== 1) throw new Error(`Unsupported readiness report version: ${report.version ?? 'missing'}.`);
  if (!['ready', 'degraded', 'blocked'].includes(report.status)) {
    throw new Error(`Invalid readiness status: ${report.status ?? 'missing'}.`);
  }
  if (typeof report.ready !== 'boolean') throw new Error('Readiness response is missing the ready boolean.');
  if (report.ready !== (report.status === 'ready')) {
    throw new Error('Readiness response has inconsistent ready and status values.');
  }
  if (report.operational != null && report.operational !== (report.status !== 'blocked')) {
    throw new Error('Readiness response has an inconsistent operational flag.');
  }
  if (report.fullyOperational != null && typeof report.fullyOperational !== 'boolean') {
    throw new Error('Readiness response has an invalid fullyOperational flag.');
  }
  if (typeof report.checkedAt !== 'string' || Number.isNaN(new Date(report.checkedAt).getTime())) {
    throw new Error('Readiness response has an invalid checkedAt timestamp.');
  }
  if (!report.summary || typeof report.summary !== 'object') {
    throw new Error('Readiness response is missing its summary.');
  }
  for (const key of ['passed', 'warnings', 'failed', 'total', 'blockingFailures']) {
    if (typeof report.summary[key] !== 'number' || !Number.isFinite(report.summary[key])) {
      throw new Error(`Readiness summary is missing numeric ${key}.`);
    }
  }
  if (report.summary.passed + report.summary.warnings + report.summary.failed !== report.summary.total
      || report.summary.blockingFailures > report.summary.failed) {
    throw new Error('Readiness summary counts are inconsistent.');
  }
  if (!Array.isArray(report.groups)) throw new Error('Readiness response is missing its groups array.');

  for (const group of report.groups) {
    if (!group || typeof group.id !== 'string' || typeof group.label !== 'string' || !Array.isArray(group.checks)) {
      throw new Error('Readiness response contains an invalid group.');
    }
    for (const check of group.checks) {
      if (!check || typeof check.id !== 'string' || typeof check.label !== 'string') {
        throw new Error(`Readiness group ${group.id} contains an invalid check.`);
      }
      if (!['pass', 'warn', 'fail'].includes(check.status) || typeof check.blocking !== 'boolean') {
        throw new Error(`Readiness check ${check.id} has an invalid status or blocking flag.`);
      }
      if (typeof check.summary !== 'string') {
        throw new Error(`Readiness check ${check.id} is missing its summary.`);
      }
      if (check.dependsOn != null && !Array.isArray(check.dependsOn)) {
        throw new Error(`Readiness check ${check.id} has invalid dependencies.`);
      }
      if (check.capabilityIds != null && !Array.isArray(check.capabilityIds)) {
        throw new Error(`Readiness check ${check.id} has invalid capabilities.`);
      }
      if (check.errorCode != null && typeof check.errorCode !== 'string') {
        throw new Error(`Readiness check ${check.id} has an invalid error code.`);
      }
      if (check.recovery != null) {
        const recovery = check.recovery;
        if (!recovery || !['command', 'manual'].includes(recovery.kind) || typeof recovery.label !== 'string') {
          throw new Error(`Readiness check ${check.id} has an invalid recovery action.`);
        }
        if (recovery.kind === 'command' && typeof recovery.command !== 'string') {
          throw new Error(`Readiness check ${check.id} is missing its recovery command.`);
        }
        if (recovery.automatic != null && typeof recovery.automatic !== 'boolean') {
          throw new Error(`Readiness check ${check.id} has an invalid automatic recovery flag.`);
        }
        if (recovery.automatic === true && typeof recovery.actionId !== 'string') {
          throw new Error(`Readiness check ${check.id} is missing its allowlisted repair action ID.`);
        }
      }
    }
  }
  if (!Array.isArray(report.capabilities)) throw new Error('Readiness response is missing its capabilities array.');
  for (const capability of report.capabilities) {
    if (!capability || typeof capability.id !== 'string' || typeof capability.label !== 'string'
        || !['ready', 'degraded', 'blocked'].includes(capability.status)) {
      throw new Error('Readiness response contains an invalid capability.');
    }
  }
  const receivedCapabilityIds = report.capabilities.map((capability) => capability.id).sort();
  if (new Set(receivedCapabilityIds).size !== receivedCapabilityIds.length
      || receivedCapabilityIds.length !== expectedCapabilityIds.length
      || receivedCapabilityIds.some((id, index) => id !== expectedCapabilityIds[index])) {
    throw new Error(`Readiness response does not implement the required capability contract: ${expectedCapabilityIds.join(', ')}.`);
  }
  if (report.rootCauses != null) {
    if (!Array.isArray(report.rootCauses)) throw new Error('Readiness response has invalid root causes.');
    for (const cause of report.rootCauses) {
      if (!cause || typeof cause.id !== 'string' || typeof cause.summary !== 'string'
          || !Array.isArray(cause.affectedCheckIds)) {
        throw new Error('Readiness response contains an invalid root cause.');
      }
    }
  }
  return report;
}

async function fetchSystemReadiness() {
  let response;
  try {
    response = await fetch(readinessUrl, { signal: AbortSignal.timeout(readinessTimeoutMs) });
  } catch (error) {
    throw new Error(`Could not reach ${readinessUrl}: ${error.message}`);
  }

  const body = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(`Readiness endpoint returned HTTP ${response.status} with a non-JSON body.`);
  }
  if (!response.ok) {
    const detail = parsed?.details || parsed?.error || response.statusText;
    throw new Error(`Readiness endpoint returned HTTP ${response.status}: ${detail}`);
  }
  return validateSystemReadinessReport(parsed);
}

function summarizeGroups(groups, minimumStatus = 'ready') {
  const readiness = buildSystemReadiness(groups);
  const rank = { ready: 0, degraded: 1, blocked: 2 };
  let derived = readiness.status;
  if (rank[minimumStatus] > rank[derived]) derived = minimumStatus;
  return { status: derived, summary: readiness.summary };
}

function mergedMorningReport(localGroup, systemReport, metadata = {}) {
  const groups = [localGroup, ...(systemReport?.groups || [])];
  const aggregate = buildSystemReadiness(groups, {
    now: systemReport?.checkedAt || new Date(),
  });
  return {
    ...aggregate,
    logDir,
    systemReadinessAvailable: Boolean(systemReport),
    ...metadata,
  };
}

function unavailableSystemGroup(message, recoveryCommand = 'npm run morning') {
  return {
    id: 'system-readiness',
    label: 'System readiness',
    checks: [{
      id: 'system-readiness-report',
      label: 'System readiness report',
      status: 'fail',
      blocking: true,
      summary: message,
      errorCode: 'SYSTEM_READINESS_UNAVAILABLE',
      detail: readinessUrl,
      observedAt: new Date().toISOString(),
      ageSeconds: null,
      impact: 'Gateway, portfolio, Hermes, Gmail, research, and prediction-market readiness could not be verified.',
      recovery: {
        kind: 'command',
        label: 'Restore the local API and rerun the full morning checklist.',
        command: recoveryCommand,
      },
    }],
  };
}

function localApiIsHealthy(localGroup) {
  return localGroup.checks.find(check => check.id === 'local-api')?.status === 'pass';
}

function localCoreIsHealthy(localGroup) {
  return ['local-api', 'local-ui'].every((id) => (
    localGroup.checks.find((check) => check.id === id)?.status === 'pass'
  ));
}

function hasUnknownListener(localGroup) {
  return localGroup.checks.some(check => check.local?.pid && !check.local?.owned);
}

function hasMissingListener(localGroup) {
  return localGroup.checks.some(check => !check.local?.pid);
}

async function waitForLocalStack(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let snapshot = await localStackGroup();
  // Startup completion is gated only by dashboard.core. Ancillary services such
  // as the outbound AWS bridge may remain degraded for a real external reason;
  // waiting for them here would turn every morning check into a minute-long
  // timeout and blur a usable dashboard into a global startup failure.
  while (Date.now() < deadline && !localCoreIsHealthy(snapshot)) {
    await sleep(750);
    snapshot = await localStackGroup();
  }
  return snapshot;
}

async function recoverMissingLocalStack(initialGroup) {
  const recovery = { attempted: false, mode: 'local-only', startedServices: [] };
  if (!hasMissingListener(initialGroup) || hasUnknownListener(initialGroup)) return { localGroup: initialGroup, recovery };

  recovery.attempted = true;
  recovery.startedServices = initialGroup.checks
    .filter(check => !check.local?.pid)
    .map(check => check.local.name);
  const startedAt = Date.now();
  try {
    await start({ detach: true, json: false, quiet: true });
  } catch (error) {
    recovery.error = error.message;
  }
  const remaining = Math.max(1_000, morningStartTimeoutMs - (Date.now() - startedAt));
  const localGroup = await waitForLocalStack(remaining);
  recovery.completed = localGroup.checks.every(check => check.status === 'pass');
  return { localGroup, recovery };
}

function systemSourceIsStale(report) {
  return (report?.groups || []).flatMap((group) => group.checks || []).some((check) => (
    ['DASHBOARD_CODE_VERSION_DRIFT', 'DASHBOARD_SUPERVISOR_CODE_DRIFT'].includes(check.errorCode)
  ));
}

function hasStartupReadinessMismatch(localGroup, systemReport, { sidecarReady = false } = {}) {
  const localChecks = new Map((localGroup?.checks || []).map((check) => [check.id, check]));
  const systemChecks = new Map(
    (systemReport?.groups || [])
      .flatMap((group) => group.checks || [])
      .map((check) => [check.id, check]),
  );
  const localUiReady = localChecks.get('local-ui')?.status === 'pass';
  const uiCheck = systemChecks.get('dashboard.ui');
  if (localUiReady && uiCheck?.status === 'fail' && uiCheck.errorCode === 'DASHBOARD_UI_UNREACHABLE') {
    return true;
  }

  const localSidecarReady = localChecks.get('local-sidecar')?.status === 'pass' && sidecarReady;
  if (!localSidecarReady) return false;
  const sidecarStartupCodes = new Set([
    'IBKR_SIDECAR_UNREACHABLE',
    'RUNTIME_PROVENANCE_UNAVAILABLE',
    'IBKR_GATEWAY_DISCONNECTED',
    'IBKR_ACCOUNTS_UNAVAILABLE',
    'IBKR_PORTFOLIO_UNAVAILABLE',
  ]);
  return ['ibkr.sidecar', 'ibkr.runtime', 'ibkr.gateway', 'ibkr.accounts', 'ibkr.portfolio']
    .some((id) => {
      const check = systemChecks.get(id);
      return check?.status === 'fail' && sidecarStartupCodes.has(check.errorCode);
    });
}

async function restartOwnedLocalStack(initialGroup, reason) {
  const recovery = {
    attempted: false,
    mode: 'restart-owned-stack',
    reason,
    startedServices: Object.keys(services),
  };
  if (hasUnknownListener(initialGroup)) {
    recovery.error = 'An unknown listener is present; automatic restart was refused.';
    return { localGroup: initialGroup, recovery };
  }

  recovery.attempted = true;
  const knownPids = [...new Set(initialGroup.checks
    .map((check) => Number(check.local?.pid) || null)
    .filter(Boolean))];
  try {
    if (launchAgentIsLoaded()) {
      await restart({ detach: true, quiet: true });
    } else {
      await stop({ quiet: true });
      for (const pid of knownPids) {
        if (isAlive(pid) && isOwned(pid)) await terminate(pid);
      }
      await start({ detach: true, json: false, quiet: true });
    }
  } catch (error) {
    recovery.error = error.message;
  }
  const localGroup = await waitForLocalStack(morningStartTimeoutMs);
  recovery.completed = localCoreIsHealthy(localGroup);
  return { localGroup, recovery };
}

function recoveryActions(groups) {
  const actions = [];
  const seen = new Set();
  const checks = groups.flatMap((group, groupIndex) => (
    (group.checks || []).map((check, checkIndex) => ({ check, groupIndex, checkIndex }))
  ));
  checks.sort((left, right) => {
    const severity = check => check.status === 'fail' ? 0 : check.status === 'warn' ? 1 : 2;
    return severity(left.check) - severity(right.check)
      || Number(right.check.blocking) - Number(left.check.blocking)
      || left.groupIndex - right.groupIndex
      || left.checkIndex - right.checkIndex;
  });
  for (const { check } of checks) {
    if (check.status === 'pass' || !check.recovery) continue;
    const key = `${check.recovery.kind}|${check.recovery.command || ''}|${check.recovery.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    actions.push({ check: check.label, status: check.status, ...check.recovery });
  }
  return actions;
}

function formatMorningReport(report) {
  const lines = [
    'Market Dashboard Morning Checklist',
    `Overall: ${report.status.toUpperCase()}  (${report.summary.passed} pass, ${report.summary.warnings} warn, ${report.summary.failed} fail)`,
    `Checked: ${report.checkedAt}`,
  ];
  if (report.localRecovery?.attempted) {
    const serviceList = report.localRecovery.startedServices.join(', ') || 'local services';
    lines.push(`Local recovery: ${report.localRecovery.completed ? 'completed' : 'attempted'} (${serviceList})`);
  }

  if (Array.isArray(report.capabilities) && report.capabilities.length > 0) {
    lines.push('', 'CAPABILITIES');
    for (const capability of report.capabilities) {
      const label = capability.status === 'ready' ? 'AVAILABLE' : capability.status.toUpperCase();
      lines.push(`[${label}] ${capability.label}${capability.description ? ` — ${capability.description}` : ''}`);
    }
  }

  if (Array.isArray(report.rootCauses) && report.rootCauses.length > 0) {
    lines.push('', `ROOT CAUSES (${report.rootCauses.length})`);
    report.rootCauses.forEach((cause, index) => {
      lines.push(`${index + 1}. [${cause.status.toUpperCase()}] ${cause.errorCode || cause.id} — ${cause.summary}`);
      lines.push(`   Owner: ${cause.owner || 'unassigned'}${cause.affectedCheckIds?.length > 1 ? `; affects ${cause.affectedCheckIds.length} checks` : ''}`);
    });
  }

  for (const group of report.groups) {
    lines.push('', group.label.toUpperCase());
    for (const check of group.checks || []) {
      lines.push(`[${check.status === 'pass' ? 'PASS' : check.status === 'warn' ? 'WARN' : 'FAIL'}] ${check.label} — ${check.summary}`);
      if (check.status !== 'pass' && check.detail && check.detail !== check.summary) lines.push(`       ${check.detail}`);
      if (check.status !== 'pass' && check.impact) lines.push(`       Impact: ${check.impact}`);
    }
  }

  const actions = recoveryActions(report.groups);
  if (actions.length > 0) {
    lines.push('', 'RECOVERY ACTIONS');
    actions.forEach((action, index) => {
      lines.push(`${index + 1}. ${action.label}`);
      if (action.command) lines.push(`   $ ${action.command}`);
    });
  } else {
    lines.push('', 'No recovery actions required.');
  }
  lines.push('', `Logs: ${report.logDir}`);
  return lines.join('\n');
}

function morningExitCode(status) {
  if (status === 'ready') return 0;
  if (status === 'degraded') return 1;
  if (status === 'blocked') return 2;
  return 3;
}

async function morning() {
  let localGroup = await localStackGroup();
  let localRecovery = { attempted: false, mode: 'read-only', startedServices: [] };
  if (!checkOnly) {
    const recovered = await recoverMissingLocalStack(localGroup);
    localGroup = recovered.localGroup;
    localRecovery = recovered.recovery;
  }

  if (!localApiIsHealthy(localGroup)) {
    const report = mergedMorningReport(localGroup, {
      status: 'blocked',
      checkedAt: new Date().toISOString(),
      groups: [unavailableSystemGroup('The local API is unavailable, so dependency readiness could not be collected.')],
    }, { localRecovery, checkOnly, systemReadinessAvailable: false });
    if (asJson) console.log(JSON.stringify(report, null, 2));
    else console.log(formatMorningReport(report));
    process.exitCode = 2;
    return;
  }

  let systemReport;
  let fetchError = null;
  try {
    systemReport = await fetchSystemReadiness();
  } catch (error) {
    fetchError = error;
  }

  if (!checkOnly && (fetchError || systemSourceIsStale(systemReport))) {
    const reason = fetchError ? `readiness-contract-error: ${fetchError.message}` : 'runtime-source-drift';
    const recovered = await restartOwnedLocalStack(localGroup, reason);
    if (recovered.recovery.attempted) {
      localGroup = recovered.localGroup;
      localRecovery = recovered.recovery;
      try {
        let firstPostRestartError = null;
        try {
          systemReport = await fetchSystemReadiness();
        } catch (error) {
          firstPostRestartError = error;
        }
        // The first comprehensive report can begin in the few seconds between
        // process liveness and UI compilation / IB session readiness. If the
        // completed report contradicts live local probes, discard it and take
        // one new snapshot. A first collection timeout is handled the same way
        // when the local API/UI are still healthy. A genuine outage still fails
        // on the second report.
        const refreshedLocalGroup = await localStackGroup();
        const sidecarReady = await httpOk('http://127.0.0.1:8765/readyz');
        const retryPostRestart = (
          firstPostRestartError && localCoreIsHealthy(refreshedLocalGroup)
        ) || hasStartupReadinessMismatch(refreshedLocalGroup, systemReport, { sidecarReady });
        if (retryPostRestart) {
          await sleep(500);
          localGroup = await localStackGroup();
          systemReport = await fetchSystemReadiness();
          fetchError = null;
        } else if (firstPostRestartError) {
          throw firstPostRestartError;
        } else {
          localGroup = refreshedLocalGroup;
          fetchError = null;
        }
      } catch (error) {
        fetchError = error;
      }
    }
  }

  if (fetchError) {
    const report = mergedMorningReport(localGroup, {
      status: 'blocked',
      checkedAt: new Date().toISOString(),
      groups: [unavailableSystemGroup(fetchError.message, 'npm run morning:check')],
    }, {
      localRecovery,
      checkOnly,
      valid: false,
      systemReadinessAvailable: false,
      preflightError: fetchError.message,
    });
    if (asJson) console.log(JSON.stringify(report, null, 2));
    else console.log(formatMorningReport(report));
    process.exitCode = 3;
    return;
  }

  const report = mergedMorningReport(localGroup, systemReport, { localRecovery, checkOnly, valid: true });
  if (asJson) console.log(JSON.stringify(report, null, 2));
  else console.log(formatMorningReport(report));
  process.exitCode = morningExitCode(report.status);
}

async function doctor() {
  const report = await doctorReport();
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.ok ? 0 : 1;
}
async function main() {
  if (command === 'monitor') return runMonitor();
  if (command === 'stop') return stop();
  if (command === 'restart') return restart();
  if (command === 'status') return status();
  if (command === 'doctor') return doctor();
  if (command === 'morning') return morning();
  if (command === 'start') return start();
  throw new Error(`Unknown command: ${command}`);
}
if (require.main === module) {
  main().catch(error => {
    if (command === 'morning') {
      const message = `Morning preflight failed: ${error.message}`;
      if (asJson) {
        console.log(JSON.stringify({
          version: 1,
          status: 'blocked',
          ready: false,
          operational: false,
          fullyOperational: false,
          valid: false,
          checkedAt: new Date().toISOString(),
          summary: { passed: 0, warnings: 0, failed: 0, total: 0, blockingFailures: 0 },
          groups: [],
          capabilities: [],
          rootCauses: [],
          logDir,
          preflightError: message,
        }, null, 2));
      } else {
        console.error(message);
      }
      process.exitCode = 3;
      return;
    }
    console.error(`Dashboard supervisor: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  formatMorningReport,
  hasExpectedDashboardSignature,
  launchAgentIsLoaded,
  mergedMorningReport,
  morningExitCode,
  pathIsInRoot,
  recoveryActions,
  restartPolicyFor,
  services,
  summarizeGroups,
  systemSourceIsStale,
  hasStartupReadinessMismatch,
  validateSystemReadinessReport,
};
