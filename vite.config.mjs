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

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, root, 'REACT_APP_');
  const define = Object.fromEntries(PUBLIC_SETTINGS.map((name) => [
    `process.env.${name}`, JSON.stringify(env[name]) ?? 'undefined',
  ]));
  // Legacy optional providers cannot receive server credentials in a bundle.
  for (const name of ['ALPHA_VANTAGE', 'FINNHUB', 'POLYGON']) define[`process.env.REACT_APP_${name}_KEY`] = 'undefined';
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
      allowedHosts: ['localhost', '127.0.0.1'], proxy,
      fs: { strict: true, allow: [root], deny: ['.env', '.env.*', '*.{crt,pem,key}', '**/.git/**', '**/data/**', '**/config/analyst/**'] } },
    preview: { host: '127.0.0.1', port: 3000, strictPort: true, cors: false, proxy },
    build: { outDir: 'build', sourcemap: false },
  };
});
