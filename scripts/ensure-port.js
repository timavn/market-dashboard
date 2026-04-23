#!/usr/bin/env node
/*
 * Ensures the target TCP port is free before the dev server starts.
 *
 * Why this exists: `concurrently -k` sometimes fails to propagate SIGTERM
 * to grandchild `node server.js` processes, leaving zombies that hold
 * port 3001. The next `npm run dev` then hits EADDRINUSE.
 *
 * This script:
 *   1. Tries to briefly bind the port.
 *   2. If it's busy, finds the listening PID(s) via `lsof -ti` and SIGKILLs them.
 *   3. Always exits 0 so `npm run server` can proceed (server.js will re-check
 *      via its own `listen` error handler if the kill failed).
 *
 * Override the port with: PORT=3005 node scripts/ensure-port.js
 */

const net = require('net');
const { execSync } = require('child_process');

const PORT = parseInt(process.env.PORT || '3001', 10);

const probe = net.createServer();

probe.once('error', (err) => {
  if (err.code !== 'EADDRINUSE') {
    console.error(`[prestart] Unexpected probe error on port ${PORT}:`, err.message);
    process.exit(0);
  }
  console.error(`[prestart] Port ${PORT} busy; attempting to free it...`);
  try {
    const pids = execSync(`lsof -tiTCP:${PORT} -sTCP:LISTEN`, { encoding: 'utf8' }).trim();
    if (!pids) {
      console.error(`[prestart] No listening PIDs reported for :${PORT}; continuing.`);
      process.exit(0);
    }
    for (const pid of pids.split(/\s+/)) {
      const n = parseInt(pid, 10);
      if (!Number.isFinite(n)) continue;
      try {
        process.kill(n, 'SIGKILL');
        console.error(`[prestart] Killed PID ${n} holding :${PORT}`);
      } catch (e) {
        console.error(`[prestart] Could not kill PID ${n}: ${e.message}`);
      }
    }
  } catch (e) {
    console.error(`[prestart] lsof lookup failed: ${e.message}`);
  }
  process.exit(0);
});

probe.once('listening', () => {
  probe.close(() => process.exit(0));
});

probe.listen(PORT);
