import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { localCommonjs } from './scripts/build/local-commonjs.mjs';
import localTrust from './src/services/security/localTrust.cjs';

const root = path.dirname(fileURLToPath(import.meta.url));
export const PUBLIC_SETTINGS = Object.freeze([
  'REACT_APP_ANALYST_SHADOW_MODE', 'REACT_APP_API_BASE_URL', 'REACT_APP_BACKEND_URL',
  'REACT_APP_DASHBOARD_SESSION_RETENTION', 'REACT_APP_IBKR_DISCOVER_TIMEOUT_MS',
  'REACT_APP_IBKR_REFRESH_TIMEOUT_MS', 'REACT_APP_IBKR_STREAM_ENABLED',
  'REACT_APP_SECURITY_INTELLIGENCE_V2_ENABLED',
]);

const SECRET_PATH_PATTERN = /(?:^|\/)\.env(?:\..*)?$|\.(?:crt|pem|key)$|(?:^|\/)\.git(?:\/|$)/i;

// Vite watches the whole repository. Sidecar virtualenvs (live and archived),
// tool caches, worktrees and generated output hold tens of thousands of files
// the UI never imports; the venv symlinks also lead the watcher into the
// system Python trees.
const UNWATCHED_DIRS = ['.cache', '.claude', 'artifacts', 'build', 'data'];
const UNWATCHED_SEGMENT = /(?:^|[\\/])(?:\.venv[^\\/]*|__pycache__|\.[\w-]+_cache|\.aws-sam)(?:[\\/]|$)/;
function unwatched(file) {
  const rel = path.relative(root, file);
  return UNWATCHED_DIRS.some((dir) => rel === dir || rel.startsWith(`${dir}${path.sep}`)) || UNWATCHED_SEGMENT.test(rel);
}

// fseventsd can wedge system-wide (seen pinned at 100% CPU after weeks of
// uptime) and stop delivering events. Chokidar then never reports an edit and
// the server keeps serving the module it transformed first. Probe native
// events once per start and poll only when none arrive, so native watching
// comes back on its own after `sudo killall fseventsd` or a reboot.
async function nativeWatchDelivers(timeoutMs = 2000) {
  if (process.platform !== 'darwin') return true;
  let probe;
  try {
    // The cache dir is excluded from Vite's own watcher.
    fs.mkdirSync(path.join(root, 'node_modules/.vite'), { recursive: true });
    probe = fs.mkdtempSync(path.join(root, 'node_modules/.vite/watch-probe-'));
  } catch { return true; }
  try {
    return await new Promise((resolve) => {
      let watcher;
      let writer;
      const timer = setTimeout(() => done(false), timeoutMs);
      function done(ok) { clearTimeout(timer); clearInterval(writer); watcher?.close(); resolve(ok); }
      try { watcher = fs.watch(probe, () => done(true)); } catch { return done(true); }
      // The event stream starts asynchronously; keep writing until it reports.
      const touch = () => fs.writeFileSync(path.join(probe, 'touch'), String(Date.now()));
      touch();
      writer = setInterval(touch, 200);
    });
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
}

async function watchOptions(command) {
  const watch = { ignored: [unwatched] };
  // CHOKIDAR_USEPOLLING, when set, already decides inside chokidar.
  if (command !== 'serve' || process.env.CHOKIDAR_USEPOLLING !== undefined) return watch;
  if (await nativeWatchDelivers()) return watch;
  console.warn('[vite.config] Native file events are not arriving (fseventsd wedged?); polling for edits every 1s. '
    + '`sudo killall fseventsd` restores native watching on the next UI restart.');
  return { ...watch, usePolling: true, interval: 1000, binaryInterval: 3000 };
}

function localBoundary() {
  const install = (server) => {
    // Install before the proxy/static middleware. Connect has a plain Node
    // response, so do not use Express response helpers here.
    server.middlewares.use((req, res, next) => {
      const verdict = localTrust.validateLocalRequest(req);
      if (verdict.ok) return next();
      res.statusCode = verdict.statusCode;
      res.setHeader('Cache-Control', 'no-store');
      res.end('Local dashboard access required');
    });
    // Secret and key paths are refused outright. fs.deny only applies when the
    // file exists; without this, a missing /.env fell through to the SPA page.
    server.middlewares.use((req, res, next) => {
      let pathname = '/';
      try { pathname = decodeURIComponent(new URL(req.url || '/', 'http://localhost').pathname); } catch { /* malformed: refuse below */ pathname = '/.env'; }
      if (!SECRET_PATH_PATTERN.test(pathname)) return next();
      res.statusCode = 403;
      res.setHeader('Cache-Control', 'no-store');
      res.end('Forbidden');
    });
    server.httpServer?.prependListener('upgrade', (req, socket) => {
      if (!localTrust.validateLocalRequest(req).ok) {
        // EventEmitter continues through every upgrade listener after this
        // one. Remove the route before Vite's HMR/proxy listeners inspect it;
        // even vite-ping must never upgrade a rejected request.
        req.url = '/__dashboard_rejected_upgrade__';
        localTrust.rejectWebSocketUpgrade(socket);
      }
    });
  };
  return { name: 'dashboard-local-boundary', configureServer: install, configurePreviewServer: install };
}

export default defineConfig(async ({ command, mode }) => {
  const env = loadEnv(mode, root, 'REACT_APP_');
  const define = Object.fromEntries(PUBLIC_SETTINGS.map((name) => [
    `process.env.${name}`, JSON.stringify(env[name]) ?? 'undefined',
  ]));
  const proxy = {
    '/api': { target: 'http://127.0.0.1:3001', changeOrigin: true },
    '/ws': { target: 'http://127.0.0.1:3001', changeOrigin: true, ws: true,
      // Upgrade listeners all run even when the boundary closes a socket.
      // Stop the proxy itself before it rewrites an untrusted Host upstream.
      // Vite's string bypass skips proxying without writing a second response
      // to the socket already rejected by localBoundary.
      bypass: (req) => localTrust.validateLocalRequest(req).ok ? undefined : (req.url || '/') },
  };
  return {
    plugins: [localBoundary(), localCommonjs(root), react()],
    envPrefix: [],
    define,
    resolve: { alias: [
      { find: /^@tremor\/react$/, replacement: path.join(root, 'src/vendor/tremor-react.jsx') },
      { find: /^lucide-react$/, replacement: path.join(root, 'src/vendor/lucide-react.js') },
    ] },
    server: { host: '127.0.0.1', port: 3000, strictPort: true, cors: false,
      allowedHosts: ['localhost', '127.0.0.1'], proxy, watch: await watchOptions(command),
      fs: { strict: true, allow: [root], deny: ['.env', '.env.*', '*.{crt,pem,key}', '**/.git/**', '**/data/**', '**/config/analyst/**'] } },
    preview: { host: '127.0.0.1', port: 3000, strictPort: true, cors: false, proxy },
    build: { outDir: 'build', sourcemap: false },
  };
});
